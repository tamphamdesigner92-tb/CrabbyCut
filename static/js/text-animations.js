/* =============================================================================
 * ANIMATION ENGINE — engine hoạt ảnh In/Out/Combo dùng chung (CrabbyCut)
 *
 * Module THUẦN (không đụng DOM/canvas): nhận item + thời gian cục bộ, trả về
 * trạng thái hoạt ảnh {opacityMul, dx, dy, scaleX, scaleY, rotate, charFrac}.
 * Cùng một hàm được dùng cho cả preview (DOM overlay CSS) lẫn export (render
 * frame lên canvas) nên hai bên không bao giờ lệch nhau. Dùng cho text và (mở
 * rộng) shape/image; hiệu ứng typewriter chỉ có nghĩa với text.
 *
 * Primitive dùng để dựng hiệu ứng (KHÔNG dùng blur): opacity, dịch (dx,dy),
 * thu phóng (scaleX,scaleY — tách trục để làm hiệu ứng lật), xoay (rotate, độ).
 *
 * Ngữ nghĩa thời gian (localTime = giây tính từ timeline_start của item):
 *   - Item ẨN trước inDelay và sau (duration - outDelay).
 *   - Cửa sổ In  = [inDelay, inDelay + inDur]
 *   - Cửa sổ Out = [D - outDelay - outDur, D - outDelay]
 *   - resolveWindows() tự co inDur/outDur khi item quá ngắn (floor 0.1s) —
 *     là NGUỒN CHÂN LÝ duy nhất cho cả preview lẫn export.
 *
 * "Combo" = preset ghi ĐỒNG THỜI animation.in và animation.out (chia thời lượng
 * theo tỉ lệ) — engine lõi (resolveWindows/animationStateAt) không đổi, chỉ thấy
 * in/out; COMBO_OPTIONS/applyCombo là lớp tiện ích cho UI.
 *
 * Tên global giữ `TextAnimations` (tương thích cũ) + alias `Animations`.
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.TextAnimations = factory();
        root.Animations = root.TextAnimations;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const _t = (typeof globalThis !== 'undefined' && globalThis._t)
        || ((k, p) => (p ? String(k).replace(/\{(\w+)\}/g, (m, n) => (n in p ? p[n] : m)) : k));
    const DUR_MIN = 0.2;
    const DUR_MAX = 2.0;
    const DUR_FLOOR = 0.1; // sàn khi phải co cửa sổ cho item quá ngắn

    // Thư viện hiệu ứng (>=10, chưa kể 'none'). Cùng một kiểu phục vụ CẢ In lẫn Out
    // vì Out chạy easing đảo chiều của cùng effect (xem animationStateAt). 'typewriter'
    // chỉ có nghĩa với text (caller lọc theo loại đối tượng nếu cần).
    const EFFECT_OPTIONS = [
        { value: 'none', label: _t('Không có') },
        { value: 'fade', label: _t('Mờ dần') },
        { value: 'slide_up', label: _t('Trượt lên') },
        { value: 'slide_down', label: _t('Trượt xuống') },
        { value: 'slide_left', label: _t('Trượt trái') },
        { value: 'slide_right', label: _t('Trượt phải') },
        { value: 'scale', label: _t('Thu phóng vào') },
        { value: 'zoom_out', label: _t('Thu phóng ra') },
        { value: 'pop', label: _t('Bật lên') },
        { value: 'rotate', label: _t('Xoay nhẹ') },
        { value: 'spin', label: _t('Xoay tròn') },
        { value: 'flip', label: _t('Lật') },
        { value: 'drift', label: _t('Trôi nhẹ') },
        { value: 'typewriter', label: _t('Đánh máy') },
    ];

    const EASING_OPTIONS = [
        { value: 'linear', label: _t('Tuyến tính') },
        { value: 'ease-in', label: _t('Vào chậm') },
        { value: 'ease-out', label: _t('Ra chậm') },
        { value: 'ease-in-out', label: _t('Mượt') },
        { value: 'back', label: _t('Bật lại') },
        { value: 'spring', label: _t('Đàn hồi') },
        { value: 'bounce', label: _t('Nảy') },
    ];

    const EFFECT_VALUES = new Set(EFFECT_OPTIONS.map((o) => o.value));
    const EASING_VALUES = new Set(EASING_OPTIONS.map((o) => o.value));

    function clampNumber(value, min, max, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    /* ---- Easing: hàm của tiến độ p ∈ [0,1], trả về visibility-progress ---- */
    const EASINGS = {
        linear: (p) => p,
        'ease-in': (p) => p * p * p,
        'ease-out': (p) => 1 - Math.pow(1 - p, 3),
        'ease-in-out': (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
        // easeOutBack: overshoot nhẹ 1 lần rồi lắng về 1 (không dao động như spring)
        back: (p) => {
            const c1 = 1.70158;
            const c3 = c1 + 1;
            return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
        },
        // Lò xo TỪ TRẠNG THÁI NGHỉ (vận tốc đầu = 0 -> khởi động chậm dạng chữ S).
        // Công thức cũ 1−e^(−7p)cos(9p) có vận tốc CỰC ĐẠI ngay p=0 (nhảy 0->0.69
        // trong frame đầu) và đạt đỉnh ở p≈0.3 rồi đứng im -> ở fps thấp thành cú
        // "snap/giật". Bản này x(p)=1−e^(−5p)(cos5p+sin5p) có x(0)=0 và x'(0)=0 nên
        // chuyển động TRẢI ĐỀU tới ~80% cửa sổ, overshoot nhẹ ~4% rồi lắng về 1.
        // clamp p>=1 về đúng 1 để frame cuối trùng khít trạng thái tĩnh (đoạn hold).
        spring: (p) => (p >= 1 ? 1 : 1 - Math.exp(-5 * p) * (Math.cos(5 * p) + Math.sin(5 * p))),
        // Penner easeOutBounce
        bounce: (p) => {
            const n1 = 7.5625;
            const d1 = 2.75;
            if (p < 1 / d1) return n1 * p * p;
            if (p < 2 / d1) { p -= 1.5 / d1; return n1 * p * p + 0.75; }
            if (p < 2.5 / d1) { p -= 2.25 / d1; return n1 * p * p + 0.9375; }
            p -= 2.625 / d1;
            return n1 * p * p + 0.984375;
        },
    };

    /* ---- Effect: trạng thái tại visibility v (0 = ẩn hoàn toàn, 1 = tĩnh) ----
     * Slide distance theo boxHeight để box to trượt xa hơn box nhỏ (tự nhiên hơn
     * hằng số px). Pop KHÔNG tự overshoot — overshoot đến từ easing spring
     * (v > 1 tạm thời) để effect và easing kết hợp tự do được. */
    function slideDist(metrics) {
        const h = Number(metrics && metrics.boxHeight) || 80;
        return Math.min(120, Math.max(30, h * 0.6));
    }

    /* Mỗi effect được KHAI BÁO bằng hệ số, không viết tay thành hàm. Mọi hiệu ứng đều
     * AFFINE theo visibility v, nên một bảng hệ số là đủ để sinh ra HAI thứ:
     *   1. hàm (v, metrics) -> state  (preview + bake PNG cho text/shape/ảnh)
     *   2. biểu thức FFmpeg theo t     (export VIDEO — xem videoAnimationExpr)
     * Trước đây (1) viết tay và (2) có bảng `videoAmp` riêng chỉ diễn đạt được dịch
     * chuyển; hai bản lệch nhau nên video phải chặn bớt hiệu ứng. Nay CHUNG một bảng:
     * thêm/sửa hiệu ứng là cả preview lẫn video xuất đổi theo, không có đường nào bị bỏ.
     *
     * Ý nghĩa khoá (khoá vắng = trung tính):
     *   op   — hệ số nhân opacity: opacityMul = min(1, op * v)
     *   dx/dy— biên dịch chuyển theo ĐƠN VỊ slideDist(metrics): d = biên * dist * (1 - v)
     *   s    — [base, gain] cho CẢ hai trục: scale = base + gain * v
     *   sx/sy— [base, gain] cho riêng một trục (ghi đè s) — dùng cho hiệu ứng lật
     *   rot  — biên xoay (độ): rotate = biên * (1 - v)
     * Trục scale tách (scaleX/scaleY) để làm hiệu ứng lật. */
    const EFFECT_SPECS = {
        fade: { op: 1 },
        slide_up: { op: 1, dy: 1 },
        slide_down: { op: 1, dy: -1 },
        slide_left: { op: 1, dx: 1 },
        slide_right: { op: 1, dx: -1 },
        scale: { op: 1, s: [0.3, 0.7] },
        zoom_out: { op: 1, s: [1.6, -0.6] },
        pop: { op: 2, s: [0, 1] },
        rotate: { op: 1, rot: -18, s: [0.85, 0.15] },
        spin: { op: 1.5, rot: -180, s: [0.4, 0.6] },
        flip: { op: 1.5, sx: [0, 1] },
        drift: { op: 1, dx: 0.35, dy: 0.25, s: [0.92, 0.08] },
    };

    // Trục scale hiệu dụng của một spec ([base, gain] hoặc null = không thu phóng)
    function specScaleAxis(spec, axis) {
        return (spec && (spec[axis] || spec.s)) || null;
    }

    // spec -> hàm (v, metrics) trả về phần trạng thái tại visibility v (0 = ẩn, 1 = tĩnh;
    // v > 1 = overshoot tạm thời từ spring/back).
    function makeEffectFn(spec) {
        const sx = specScaleAxis(spec, 'sx');
        const sy = specScaleAxis(spec, 'sy');
        return (v, m) => {
            const state = { opacityMul: Math.min(1, (spec.op || 1) * v) };
            if (spec.dx) state.dx = slideDist(m) * spec.dx * (1 - v);
            if (spec.dy) state.dy = slideDist(m) * spec.dy * (1 - v);
            if (sx) state.scaleX = sx[0] + sx[1] * v;
            if (sy) state.scaleY = sy[0] + sy[1] * v;
            if (spec.rot) state.rotate = spec.rot * (1 - v);
            return state;
        };
    }

    // Registry kiểu Factory: thêm hiệu ứng = thêm 1 khoá vào EFFECT_SPECS. typewriter
    // KHÔNG affine theo cùng khuôn (nó cắt theo số ký tự) nên vẫn khai riêng.
    const EFFECTS = Object.keys(EFFECT_SPECS).reduce((acc, key) => {
        acc[key] = makeEffectFn(EFFECT_SPECS[key]);
        return acc;
    }, {
        typewriter: (v) => ({ charFrac: Math.min(1, Math.max(0, v)) }),
    });

    const IDENTITY = Object.freeze({ opacityMul: 1, dx: 0, dy: 0, scaleX: 1, scaleY: 1, scaleMul: 1, rotate: 0, charFrac: 1 });

    // Hiệu ứng THUẦN opacity/ký tự: overshoot của spring/bounce (v > 1) bị kẹp trần
    // (opacity ≤ 100%, số ký tự ≤ tổng) nên hiệu ứng kết thúc trong ~20% thời lượng
    // rồi đứng im — nhìn như giật, nhất là trong video xuất 30fps. Với các hiệu ứng
    // này, spring/bounce được thay bằng ease-in-out khi tính visibility.
    const OPACITY_ONLY_EFFECTS = new Set(['fade', 'typewriter']);

    function effectiveEasing(effectType, easing) {
        if (OPACITY_ONLY_EFFECTS.has(effectType) && (easing === 'spring' || easing === 'bounce')) {
            return 'ease-in-out';
        }
        return easing;
    }

    /* ---- WIGGLE (kiểu After Effects: Animation Presets › Behaviors › Wiggle) ----
     * Rung lắc LIÊN TỤC suốt block, CHỒNG lên In/Out và keyframe (như wiggle() của AE
     * cộng lên giá trị thuộc tính). Bốn hiệu ứng bật/tắt riêng, mỗi cái một bộ tham số
     * giống AE: Tần số (lần/giây), Biên độ, Octaves, Amp Multiplier, Random Seed.
     *
     * Dữ liệu nằm TRONG item.animation (animation.wiggle = { position|scale|rotation|
     * opacity: {...} }) chứ không phải field riêng của item: nhiều chỗ gọi engine bằng
     * pseudo-item { animation, duration } (clip lane chính, auto-SFX...) — field riêng
     * sẽ rơi mất ở những chỗ đó.
     *
     * NHIỄU = tổng các sóng sin có tần số/pha lấy từ seed (không phải nhiễu Perlin như AE):
     * đó là thứ DUY NHẤT vừa trông ngẫu nhiên vừa viết được thành biểu thức FFmpeg, nên
     * preview, chuỗi khung bake (ảnh/chữ/shape) và bản xuất VIDEO ra cùng một chuyển
     * động — test so khớp (tests/scripts/wiggle.js). Mỗi octave có HAI sóng lệch tần số
     * (tỉ lệ vô tỉ) để không lặp chu kỳ thấy được. Chuẩn hoá tổng trọng số = 1 nên
     * |nhiễu| ≤ 1 -> Biên độ là biên TỐI ĐA, giống AE.
     *
     * Ánh xạ kênh (amp = Biên độ, n = nhiễu ∈ [-1, 1]):
     *   position : dx/dy += amp·n (px sequence; axis 'xy' | 'x' | 'y')
     *   scale    : scale ×= 1 + amp/100·n (đều hai trục, hoặc tách trục khi uniform=false)
     *   rotation : rotate += amp·n (độ)
     *   opacity  : opacity ×= 1 − amp/100·(0.5 + 0.5n) — chỉ mờ đi, chạy trong [1−amp, 1]
     *              (AE cộng ±amp rồi kẹp 100% nên nửa thời gian đứng ở 100%; ở đây mượt). */
    const WIGGLE_TYPES = ['position', 'scale', 'rotation', 'opacity'];
    const WIGGLE_DEFAULTS = {
        position: { freq: 2, amp: 30 },
        scale: { freq: 2, amp: 10 },
        rotation: { freq: 2, amp: 10 },
        opacity: { freq: 3, amp: 50 },
    };
    const WIGGLE_AMP_MAX = { position: 2000, scale: 100, rotation: 360, opacity: 100 };
    const WIGGLE_FREQ_MIN = 0.1;
    const WIGGLE_FREQ_MAX = 20;
    const WIGGLE_OCTAVES_MAX = 4;
    const WIGGLE_SEED_MAX = 9999;
    const WIGGLE_AXES = ['xy', 'x', 'y'];
    // Mỗi KÊNH một "muối" để vị trí X, Y, xoay... không rung cùng nhịp dù chung seed.
    const WIGGLE_SALT = { px: 1, py: 2, sx: 3, sy: 4, rot: 5, op: 6 };
    /* KIỂU CHUYỂN ĐỘNG (2026-10-22):
     *   smooth — tổng sóng sin (mặc định, như trước);
     *   target — như wiggle() của AE: mỗi nhịp (Tần số lần/giây) chạy tới một ĐIỂM ĐÍCH ngẫu
     *            nhiên mới theo Easing chọn được; `hold` = phần nhịp ĐỨNG NGHỈ ở điểm đích;
     *   step   — giật cục: đứng yên ở một điểm, tới nhịp sau NHẢY tức thì sang điểm khác. */
    const WIGGLE_STYLES = ['smooth', 'target', 'step'];
    const WIGGLE_HOLD_MAX = 0.9;

    function normalizeWiggleFx(type, raw) {
        const d = WIGGLE_DEFAULTS[type];
        const r = raw && typeof raw === 'object' ? raw : {};
        const out = {
            enabled: r.enabled === true,
            freq: clampNumber(r.freq, WIGGLE_FREQ_MIN, WIGGLE_FREQ_MAX, d.freq),
            amp: clampNumber(r.amp, 0, WIGGLE_AMP_MAX[type], d.amp),
            octaves: Math.round(clampNumber(r.octaves, 1, WIGGLE_OCTAVES_MAX, 1)),
            amp_mult: clampNumber(r.amp_mult, 0, 1, 0.5),
            seed: Math.round(clampNumber(r.seed, 0, WIGGLE_SEED_MAX, 1)),
            style: WIGGLE_STYLES.includes(r.style) ? r.style : 'smooth',
            easing: EASING_VALUES.has(r.easing) ? r.easing : 'ease-in-out',
            hold: clampNumber(r.hold, 0, WIGGLE_HOLD_MAX, 0),
        };
        if (type === 'position') out.axis = WIGGLE_AXES.includes(r.axis) ? r.axis : 'xy';
        if (type === 'scale') out.uniform = r.uniform !== false;
        return out;
    }

    // null nếu không có gì; ngược lại CHỈ gồm các loại có mặt trong dữ liệu (giữ cả loại
    // đang tắt để bật lại vẫn còn tham số cũ).
    function normalizeWiggle(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const out = {};
        WIGGLE_TYPES.forEach((type) => {
            if (raw[type] && typeof raw[type] === 'object') out[type] = normalizeWiggleFx(type, raw[type]);
        });
        return Object.keys(out).length ? out : null;
    }

    function wiggleFxActive(fx) {
        return !!(fx && fx.enabled && fx.amp > 0);
    }

    function hasActiveWiggle(wiggle) {
        return !!wiggle && WIGGLE_TYPES.some((type) => wiggleFxActive(wiggle[type]));
    }

    // PRNG tất định (mulberry32) — cùng seed + muối luôn ra cùng chuỗi số.
    function wiggleRng(seed, salt) {
        let a = ((Number(seed) || 0) * 7919 + salt * 104729 + 0x9e3779b9) >>> 0;
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let x = a;
            x = Math.imul(x ^ (x >>> 15), x | 1);
            x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
            return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
        };
    }

    /* Các sóng thành phần của MỘT kênh: [{ w, k, ph }] với giá trị = Σ w·sin(k·t + ph).
     * Tần số AE = số "điểm đích ngẫu nhiên" mỗi giây — mắt thấy ~một nửa số chu kỳ, nên
     * sóng chính chạy freq/2 chu kỳ/giây. Octave o: tần số ×2^o, trọng số ×amp_mult^o. */
    function wiggleWaves(fx, salt) {
        const rng = wiggleRng(fx.seed, salt);
        const waves = [];
        let total = 0;
        for (let o = 0; o < fx.octaves; o += 1) {
            const wo = Math.pow(fx.amp_mult, o);
            [[0.5, 0.62], [0.81, 0.38]].forEach(([base, wj]) => {
                const cycles = fx.freq * Math.pow(2, o) * base * (0.85 + 0.3 * rng());
                const w = wo * wj;
                waves.push({ w, k: 2 * Math.PI * cycles, ph: 2 * Math.PI * rng() });
                total += w;
            });
        }
        return total > 0 ? waves.map((v) => ({ ...v, w: v.w / total })) : [];
    }

    function wiggleNoiseAt(waves, t) {
        let n = 0;
        for (let i = 0; i < waves.length; i += 1) n += waves[i].w * Math.sin(waves[i].k * t + waves[i].ph);
        return n;
    }

    // Cùng nhiễu dưới dạng biểu thức FFmpeg theo LOCALT. 6 chữ số thập phân: k·t với
    // t tới vài phút vẫn lệch pha < 1e-3 rad.
    function wiggleNoiseExpr(waves) {
        const g = (n) => (Number(n) || 0).toFixed(6);
        return `(${waves.map((v) => `${g(v.w)}*sin(${g(v.k)}*LOCALT+${g(v.ph)})`).join('+') || '0'})`;
    }

    /* ---- Kiểu ĐIỂM ĐÍCH / GIẬT CỤC ----
     * Mỗi octave o là một lớp: nhịp r = freq·2^o điểm/giây, lệch pha `off` theo seed; điểm đích
     * thứ k = R(k) = 2·fract(sin(k·a + b)·43758.5453) − 1 ∈ [-1, 1) — hàm băm viết được NGUYÊN
     * VẸN bằng biểu thức FFmpeg (sin/floor), nên preview và bản xuất ra cùng một dãy điểm.
     *   target: u = t·r + off, k = floor(u), p = u − k; đi từ R(k) tới R(k+1) theo easing của
     *           q = clip(p / (1 − hold), 0, 1) — phần còn lại của nhịp đứng nghỉ ở R(k+1);
     *   step  : giá trị = R(k), nhảy tức thì ở đầu mỗi nhịp.
     * Lớp cộng theo trọng số amp_mult^o rồi chuẩn hoá (|nhiễu| ≤ 1, trừ easing vọt lố như
     * Bật lại / Đàn hồi). Muối riêng (salt + 50) để không đụng dãy số của kiểu smooth. */
    function wigglePointLayers(fx, salt) {
        const rng = wiggleRng(fx.seed, salt + 50);
        // Làm tròn 6 chữ số NGAY ĐÂY: biểu thức FFmpeg ghi đúng 6 chữ số, mà sin(k·a + b)·43758
        // rất nhạy với a, b — engine phải dùng CÙNG con số đã làm tròn thì hai bên mới trùng.
        const r6 = (v) => Number(v.toFixed(6));
        const layers = [];
        let total = 0;
        for (let o = 0; o < fx.octaves; o += 1) {
            const w = Math.pow(fx.amp_mult, o);
            layers.push({ rate: r6(fx.freq * Math.pow(2, o)), off: r6(rng()), a: r6(7 + 9 * rng()), b: r6(100 * rng()), w });
            total += w;
        }
        return total > 0 ? layers.map((l) => ({ ...l, w: r6(l.w / total) })) : [];
    }

    function wigglePointHash(k, a, b) {
        const s = Math.sin(k * a + b) * 43758.5453;
        return 2 * (s - Math.floor(s)) - 1;
    }

    function wigglePointAt(fx, salt, t) {
        const layers = wigglePointLayers(fx, salt);
        const ease = EASINGS[fx.easing] || EASINGS['ease-in-out'];
        const span = 1 - Math.min(WIGGLE_HOLD_MAX, Math.max(0, Number(fx.hold) || 0));
        let n = 0;
        for (let i = 0; i < layers.length; i += 1) {
            const L = layers[i];
            const u = t * L.rate + L.off;
            const k = Math.floor(u);
            const r0 = wigglePointHash(k, L.a, L.b);
            if (fx.style === 'step') {
                n += L.w * r0;
                continue;
            }
            const q = Math.min(1, Math.max(0, (u - k) / span));
            n += L.w * (r0 + (wigglePointHash(k + 1, L.a, L.b) - r0) * ease(q));
        }
        return n;
    }

    /* Cùng nhiễu dưới dạng biểu thức FFmpeg. Gọn nhờ thanh ghi st/ld 4..8 (0..3 để dành cho
     * sidecar — bước dời dưới pixel, xem SubpixelShiftFilter ở core_process.cpp). Không có `;`
     * (backend lọc mất): tuần tự hoá bằng if(isnan(st(...)),0,phần sau) — `if` tính điều kiện
     * TRƯỚC. Mỗi lớp tính xong trọn rồi mới tới lớp sau nên dùng lại thanh ghi được. */
    function wigglePointExpr(fx, salt) {
        const g = (n) => (Number(n) || 0).toFixed(6);
        const span = 1 - Math.min(WIGGLE_HOLD_MAX, Math.max(0, Number(fx.hold) || 0));
        const seq = (stores, result) => stores.reduceRight((acc, s) => `if(isnan(${s}),0,${acc})`, result);
        const hash = (reg, kExpr, L) => [
            `st(${reg},sin((${kExpr})*${g(L.a)}+${g(L.b)})*43758.5453)`,
            `st(${reg},2*(ld(${reg})-floor(ld(${reg})))-1)`,
        ];
        // ffEase của spring không kẹp p = 1 như EASINGS.spring (1.0045 thay vì 1) -> kẹp ở đây,
        // không thì đoạn nghỉ lệch điểm đích rồi giật nhẹ ở nhịp sau.
        const easeExpr = fx.easing === 'spring'
            ? `if(gte(ld(6),1),1,${ffEase('spring', 'ld(6)')})`
            : ffEase(fx.easing, 'ld(6)');
        const parts = wigglePointLayers(fx, salt).map((L) => {
            const stores = [`st(4,LOCALT*${g(L.rate)}+${g(L.off)})`, 'st(5,floor(ld(4)))', ...hash(7, 'ld(5)', L)];
            if (fx.style === 'step') return `${g(L.w)}*${seq(stores, 'ld(7)')}`;
            stores.push(...hash(8, 'ld(5)+1', L), `st(6,clip((ld(4)-ld(5))/${g(span)},0,1))`);
            return `${g(L.w)}*${seq(stores, `(ld(7)+(ld(8)-ld(7))*(${easeExpr}))`)}`;
        });
        return `(${parts.join('+') || '0'})`;
    }

    // Nhiễu MỘT kênh theo kiểu của fx — preview/bake (At) và biểu thức xuất (Expr).
    function wiggleChannelAt(fx, salt, t) {
        return fx.style === 'target' || fx.style === 'step'
            ? wigglePointAt(fx, salt, t)
            : wiggleNoiseAt(wiggleWaves(fx, salt), t);
    }

    function wiggleChannelExpr(fx, salt) {
        return fx.style === 'target' || fx.style === 'step'
            ? wigglePointExpr(fx, salt)
            : wiggleNoiseExpr(wiggleWaves(fx, salt));
    }

    /* Phần đóng góp của wiggle tại t (giây cục bộ): { dx, dy, sx, sy, rot, op } hoặc null
     * nếu không có wiggle nào đang bật. sx/sy/op là HỆ SỐ NHÂN, dx/dy/rot là SỐ CỘNG. */
    function wiggleStateAt(wiggle, t) {
        if (!hasActiveWiggle(wiggle)) return null;
        const time = Number(t) || 0;
        const ch = (fx, salt) => wiggleChannelAt(fx, salt, time);
        const out = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, op: 1 };
        const pos = wiggle.position;
        if (wiggleFxActive(pos)) {
            if (pos.axis !== 'y') out.dx = pos.amp * ch(pos, WIGGLE_SALT.px);
            if (pos.axis !== 'x') out.dy = pos.amp * ch(pos, WIGGLE_SALT.py);
        }
        const sc = wiggle.scale;
        if (wiggleFxActive(sc)) {
            out.sx = Math.max(0.01, 1 + (sc.amp / 100) * ch(sc, WIGGLE_SALT.sx));
            out.sy = sc.uniform ? out.sx : Math.max(0.01, 1 + (sc.amp / 100) * ch(sc, WIGGLE_SALT.sy));
        }
        const rot = wiggle.rotation;
        if (wiggleFxActive(rot)) out.rot = rot.amp * ch(rot, WIGGLE_SALT.rot);
        const op = wiggle.opacity;
        if (wiggleFxActive(op)) {
            out.op = Math.min(1, Math.max(0, 1 - (op.amp / 100) * (0.5 + 0.5 * ch(op, WIGGLE_SALT.op))));
        }
        return out;
    }

    /* Biểu thức FFmpeg (LOCALT) cho từng kênh, KHỚP wiggleStateAt; kênh không rung -> null.
     * { x, y, sx, sy, rot, op } — op là HỆ SỐ NHÂN 0..1 của độ mờ. */
    function wiggleFfmpegExprs(wiggle) {
        if (!hasActiveWiggle(wiggle)) return null;
        const g = (n) => (Number(n) || 0).toFixed(6);
        const ch = (fx, salt) => wiggleChannelExpr(fx, salt);
        const out = { x: null, y: null, sx: null, sy: null, rot: null, op: null };
        const pos = wiggle.position;
        if (wiggleFxActive(pos)) {
            if (pos.axis !== 'y') out.x = `(${g(pos.amp)}*${ch(pos, WIGGLE_SALT.px)})`;
            if (pos.axis !== 'x') out.y = `(${g(pos.amp)}*${ch(pos, WIGGLE_SALT.py)})`;
        }
        const sc = wiggle.scale;
        if (wiggleFxActive(sc)) {
            out.sx = `max(0.01,1+${g(sc.amp / 100)}*${ch(sc, WIGGLE_SALT.sx)})`;
            out.sy = sc.uniform ? out.sx : `max(0.01,1+${g(sc.amp / 100)}*${ch(sc, WIGGLE_SALT.sy)})`;
        }
        const rot = wiggle.rotation;
        if (wiggleFxActive(rot)) out.rot = `(${g(rot.amp)}*${ch(rot, WIGGLE_SALT.rot)})`;
        const op = wiggle.opacity;
        if (wiggleFxActive(op)) {
            out.op = `clip(1-${g(op.amp / 100)}*(0.5+0.5*${ch(op, WIGGLE_SALT.op)}),0,1)`;
        }
        return out;
    }

    // Biểu thức độ mờ (đơn vị %, như keyframe opacity) = cơ sở × hệ số wiggle; null nếu
    // không rung độ mờ. baseExpr = biểu thức keyframe opacity, hoặc null -> dùng staticPct.
    // Dùng cho VIDEO (block video/GeoCode/clip lane chính): độ mờ của nó xuất bằng
    // keyframe_expr.opacity_expr, còn ảnh/chữ/shape đã bake độ mờ vào chuỗi khung.
    function wiggleOpacityFfmpegExpr(anim, baseExpr, staticPct) {
        const a = normalizeAnimation(anim);
        const ex = a && wiggleFfmpegExprs(a.wiggle);
        if (!ex || !ex.op) return null;
        const base = baseExpr ? `(${baseExpr})` : `(${(Number.isFinite(Number(staticPct)) ? Number(staticPct) : 100).toFixed(4)})`;
        return `(${base}*${ex.op})`;
    }

    // Áp wiggle LÊN TRÊN trạng thái In/Out/hold. Không có wiggle -> trả nguyên state.
    function applyWiggleToState(state, wiggle, t) {
        if (!state || state.hidden) return state;
        const wg = wiggleStateAt(wiggle, t);
        if (!wg) return state;
        const sx = (state.scaleX != null ? state.scaleX : 1) * wg.sx;
        const sy = (state.scaleY != null ? state.scaleY : 1) * wg.sy;
        return {
            ...state,
            hidden: false,
            opacityMul: Math.min(1, Math.max(0, (state.opacityMul != null ? state.opacityMul : 1) * wg.op)),
            dx: (Number(state.dx) || 0) + wg.dx,
            dy: (Number(state.dy) || 0) + wg.dy,
            scaleX: Math.max(0, sx),
            scaleY: Math.max(0, sy),
            scaleMul: Math.max(0, sx),
            rotate: (Number(state.rotate) || 0) + wg.rot,
        };
    }

    function normalizeSide(side) {
        const type = side && EFFECT_VALUES.has(side.type) ? side.type : 'none';
        if (type === 'none') return { type: 'none', duration: 0.4, delay: 0, easing: 'ease-in-out' };
        return {
            type,
            duration: clampNumber(side.duration, DUR_MIN, DUR_MAX, 0.4),
            // Tham số Trễ đã loại bỏ (20260716): delay luôn 0, item cũ có delay tự về 0
            delay: 0,
            easing: side && EASING_VALUES.has(side.easing) ? side.easing : 'ease-in-out',
        };
    }

    // null nếu không có animation nào; ngược lại object đã kẹp giá trị hợp lệ
    function normalizeAnimation(anim) {
        if (!anim || typeof anim !== 'object') return null;
        const inn = normalizeSide(anim.in);
        const out = normalizeSide(anim.out);
        const wiggle = normalizeWiggle(anim.wiggle);
        if (inn.type === 'none' && out.type === 'none' && !hasActiveWiggle(wiggle)) return null;
        // Không có wiggle -> object y hệt trước khi có Wiggle (không thêm khoá rỗng).
        return wiggle ? { in: inn, out, wiggle } : { in: inn, out };
    }

    function hasAnimation(item) {
        return !!normalizeAnimation(item && item.animation);
    }

    // Cửa sổ thời gian cục bộ đã GIẢI QUYẾT va chạm cho item cụ thể.
    // Trả null nếu item không có animation.
    function resolveWindows(item) {
        const anim = normalizeAnimation(item && item.animation);
        if (!anim) return null;
        const D = Math.max(0.05, Number(item && item.duration) || 0);
        let inDelay = anim.in.type === 'none' ? 0 : anim.in.delay;
        let outDelay = anim.out.type === 'none' ? 0 : anim.out.delay;
        let inDur = anim.in.type === 'none' ? 0 : anim.in.duration;
        let outDur = anim.out.type === 'none' ? 0 : anim.out.duration;

        // Delay chiếm hết thời lượng item -> bỏ animation Out (ưu tiên In hiển thị)
        if (inDelay + outDelay >= D - DUR_FLOOR) {
            outDelay = 0;
            outDur = 0;
            inDelay = Math.min(inDelay, Math.max(0, D - DUR_FLOOR));
        }
        const avail = D - inDelay - outDelay;
        const need = inDur + outDur;
        if (need > avail && need > 0) {
            const ratio = avail / need;
            if (inDur > 0) inDur = Math.max(DUR_FLOOR, inDur * ratio);
            if (outDur > 0) outDur = Math.max(DUR_FLOOR, outDur * ratio);
            // 2 sàn cộng lại vẫn vượt avail (item cực ngắn) -> chia đôi
            if (inDur + outDur > avail) {
                if (inDur > 0 && outDur > 0) {
                    inDur = avail / 2;
                    outDur = avail / 2;
                } else if (inDur > 0) {
                    inDur = avail;
                } else {
                    outDur = avail;
                }
            }
        }
        return {
            anim,
            inStart: inDelay,
            inEnd: inDelay + inDur,
            outStart: D - outDelay - outDur,
            outEnd: D - outDelay,
            duration: D,
        };
    }

    /* Trạng thái hoạt ảnh tại localTime.
     * metrics = { boxHeight, fontSize, charCount } (đơn vị px sequence).
     * Trả về:
     *   - null: item KHÔNG có animation -> caller giữ nguyên đường render cũ
     *   - {hidden: true}: đang trong vùng delay (trước In / sau Out) -> ẩn hẳn
     *   - {opacityMul, dx, dy, scaleMul, charFrac}: trạng thái cần áp */
    function animationStateAt(item, localTime, metrics) {
        const w = resolveWindows(item);
        if (!w) return null;
        const t = Number(localTime) || 0;
        if ((w.anim.in.type !== 'none' && t < w.inStart) || (w.anim.out.type !== 'none' && t > w.outEnd)) {
            return { hidden: true, opacityMul: 0, dx: 0, dy: 0, scaleX: 1, scaleY: 1, scaleMul: 1, rotate: 0, charFrac: 0 };
        }

        let state = null;
        if (w.anim.in.type !== 'none' && t >= w.inStart && t < w.inEnd) {
            const p = Math.min(1, Math.max(0, (t - w.inStart) / Math.max(0.001, w.inEnd - w.inStart)));
            const v = EASINGS[effectiveEasing(w.anim.in.type, w.anim.in.easing)](p);
            state = EFFECTS[w.anim.in.type](v, metrics);
        } else if (w.anim.out.type !== 'none' && t > w.outStart && t <= w.outEnd) {
            // Out = In chạy ngược: visibility đi 1 -> 0
            const p = Math.min(1, Math.max(0, (t - w.outStart) / Math.max(0.001, w.outEnd - w.outStart)));
            const v = EASINGS[effectiveEasing(w.anim.out.type, w.anim.out.easing)](1 - p);
            state = EFFECTS[w.anim.out.type](v, metrics);
        }
        // vùng hold: trạng thái tĩnh (+ wiggle nếu có)
        if (!state) return applyWiggleToState({ ...IDENTITY }, w.anim.wiggle, t);

        // scaleX/scaleY: effect có thể trả trục riêng (flip) hoặc scaleMul (đồng đều cũ)
        const sx = state.scaleX != null ? state.scaleX : (state.scaleMul != null ? state.scaleMul : 1);
        const sy = state.scaleY != null ? state.scaleY : (state.scaleMul != null ? state.scaleMul : 1);
        return applyWiggleToState({
            hidden: false,
            opacityMul: Math.min(1, Math.max(0, state.opacityMul != null ? state.opacityMul : 1)),
            dx: Number(state.dx) || 0,
            dy: Number(state.dy) || 0,
            scaleX: Math.max(0, sx),
            scaleY: Math.max(0, sy),
            scaleMul: Math.max(0, sx), // tương thích cũ (đồng đều = scaleX)
            rotate: Number(state.rotate) || 0,
            charFrac: Math.min(1, Math.max(0, state.charFrac != null ? state.charFrac : 1)),
        }, w.anim.wiggle, t);
    }

    // true nếu state khác trạng thái tĩnh (caller có thể bỏ qua ghi DOM khi tĩnh)
    function stateIsIdentity(state) {
        return !state || (!state.hidden
            && state.opacityMul >= 1 && state.scaleX === 1 && state.scaleY === 1
            && state.rotate === 0 && state.dx === 0 && state.dy === 0 && state.charFrac >= 1);
    }

    // Trần thời lượng cho MỘT phía theo ràng buộc kiểu CapCut/Premiere:
    // (thời lượng In) + (thời lượng Out) không được vượt thời lượng của item.
    function maxSideDuration(item, sideKey) {
        const anim = normalizeAnimation(item && item.animation);
        const D = Math.max(0.05, Number(item && item.duration) || 0);
        const other = anim ? anim[sideKey === 'in' ? 'out' : 'in'] : null;
        const otherDur = other && other.type !== 'none' ? other.duration : 0;
        return Math.max(DUR_MIN, Math.min(DUR_MAX, D - otherDur));
    }

    /* ---- VIDEO: sinh biểu thức FFmpeg theo thời gian ----
     * Video (overlay lẫn clip lane chính) không bake PNG per-frame được -> export bằng
     * filter FFmpeg biến thiên theo t:
     *   - opacity     : filter `fade` (alpha)
     *   - dịch chuyển : overlay x/y = 'biểu thức(t)'
     *   - thu phóng   : scale w/h = 'biểu thức(t)' + eval=frame
     *   - xoay        : rotate a = 'biểu thức(t)'
     * Ba kênh sau ĐI CHUNG đường mà keyframe đã dùng trong sidecar
     * (AppendKfTransformFilters), nên toàn bộ thư viện hiệu ứng đều diễn đạt được —
     * video dùng CHUNG hiệu ứng với ảnh, không còn tập con.
     *
     * Biểu thức dùng token LOCALT = thời gian CỤC BỘ (giây tính từ đầu item); sidecar
     * thay LOCALT bằng (t - timeline_start của overlay), hoặc t với clip lane chính. */
    // Tập hiệu ứng đường xuất VIDEO diễn đạt được = tất cả, TRỪ typewriter (nó cắt theo
    // ký tự nên chỉ có nghĩa với text, và text đi đường bake PNG chứ không qua đây).
    const VIDEO_SUPPORTED_EFFECTS = new Set(
        ['none'].concat(Object.keys(EFFECT_SPECS)),
    );

    // Biểu thức FFmpeg cho visibility v theo progress pExpr (đã kẹp 0..1), KHỚP EASINGS.
    function ffEase(easing, pExpr) {
        switch (easing) {
            case 'linear': return `(${pExpr})`;
            case 'ease-in': return `pow(${pExpr},3)`;
            case 'ease-out': return `(1-pow(1-(${pExpr}),3))`;
            case 'back': return `(1+2.70158*pow((${pExpr})-1,3)+1.70158*pow((${pExpr})-1,2))`;
            case 'spring': return `(1-exp(-5*(${pExpr}))*(cos(5*(${pExpr}))+sin(5*(${pExpr}))))`;
            case 'bounce': return `if(lt(${pExpr},0.363636),7.5625*pow(${pExpr},2),if(lt(${pExpr},0.727272),7.5625*pow((${pExpr})-0.545454,2)+0.75,if(lt(${pExpr},0.909090),7.5625*pow((${pExpr})-0.818181,2)+0.9375,7.5625*pow((${pExpr})-0.954545,2)+0.984375)))`;
            case 'ease-in-out':
            default: return `if(lt(${pExpr},0.5),4*pow(${pExpr},3),1-pow(-2*(${pExpr})+2,3)/2)`;
        }
    }

    // Spec hiệu ứng của một phía ('none' -> null = phía đó trung tính)
    function sideSpec(side) {
        return side && side.type !== 'none' ? (EFFECT_SPECS[side.type] || null) : null;
    }

    /* Thời lượng cửa trập opacity của MỘT phía. Filter `fade` chạy alpha TUYẾN TÍNH theo
     * thời gian, còn engine tính opacityMul = min(1, op * v): với op > 1 (pop/spin/flip)
     * alpha đã đầy khi mới đi 1/op cửa sổ rồi giữ nguyên trong khi hình còn đang phóng.
     * Chia thời lượng fade cho op là cách rẻ nhất để hai bên khớp về THỜI ĐIỂM đầy/cạn —
     * nếu để nguyên, pop trên video mờ suốt cả cú phóng, khác hẳn preview và khác ảnh. */
    function fadeSpan(spec, dur) {
        return dur / Math.max(1, (spec && spec.op) || 1);
    }

    // Trả spec biểu thức cho video, hoặc null nếu item không có animation.
    // boxHeight (px sequence) dùng cho khoảng cách trượt (giống preview/engine).
    function videoAnimationExpr(item, boxHeight) {
        const w = resolveWindows(item);
        if (!w) return null;
        const sd = slideDist({ boxHeight });
        const f = (n) => (Number(n) || 0).toFixed(4);
        const inSpec = sideSpec(w.anim.in);
        const outSpec = sideSpec(w.anim.out);
        const inHas = w.anim.in.type !== 'none';
        const outHas = w.anim.out.type !== 'none';
        const inDur = Math.max(0.001, w.inEnd - w.inStart);
        const outDur = Math.max(0.001, w.outEnd - w.outStart);
        // progress: In tăng 0->1; Out = easing(1-p) (v đi 1->0)
        const pIn = `clip((LOCALT-${f(w.inStart)})/${f(inDur)},0,1)`;
        const pOut = `clip(1-(LOCALT-${f(w.outStart)})/${f(outDur)},0,1)`;
        const vIn = ffEase(w.anim.in.easing, pIn);
        const vOut = ffEase(w.anim.out.easing, pOut);

        /* Ghép 3 đoạn In / Hold / Out của MỘT kênh. termOf(spec, vExpr) trả biểu thức của
         * kênh đó theo visibility, hoặc null nếu phía ấy không tác động lên kênh (-> dùng
         * holdVal). Trả null cho CẢ HAI phía = kênh không cần gửi đi (sidecar bỏ hẳn
         * filter tương ứng, giữ đường xuất rẻ như trước cho fade/slide).
         * Trước inEnd: đoạn In; sau outStart: đoạn Out; giữa: giá trị tĩnh holdVal. */
        const channelExpr = (termOf, holdVal) => {
            const inPart = inHas ? termOf(inSpec, vIn) : null;
            const outPart = outHas ? termOf(outSpec, vOut) : null;
            if (inPart == null && outPart == null) return null;
            return `if(lt(LOCALT,${f(w.inEnd)}),${inPart == null ? holdVal : inPart},`
                + `if(gt(LOCALT,${f(w.outStart)}),${outPart == null ? holdVal : outPart},${holdVal}))`;
        };
        // Dịch chuyển: d = biên * slideDist * (1 - v) — KHỚP makeEffectFn
        const axisTerm = (key) => (spec, vExpr) => (spec && spec[key]
            ? `${f(spec[key] * sd)}*(1-(${vExpr}))`
            : null);
        // Thu phóng: HỆ SỐ NHÂN (1 = nguyên cỡ) = base + gain * v — sidecar nhân nó với
        // scale tĩnh/keyframe của block, nên ở đây chỉ mô tả phần của hoạt ảnh.
        const scaleTerm = (axis) => (spec, vExpr) => {
            const s = specScaleAxis(spec, axis);
            return s ? `max(0.001,${f(s[0])}+${f(s[1])}*(${vExpr}))` : null;
        };
        // Xoay: ĐỘ, cộng thêm vào rotation tĩnh/keyframe của block
        const rotTerm = (spec, vExpr) => (spec && spec.rot
            ? `${f(spec.rot)}*(1-(${vExpr}))`
            : null);

        // x/y luôn gửi (kể cả toàn 0): `anim_x_expr` là cờ "overlay này có hoạt ảnh" của
        // cả backend lẫn sidecar — bỏ đi thì mất luôn cửa trập fade.
        // WIGGLE chồng lên: dịch/xoay CỘNG, thu phóng NHÂN — đúng như applyWiggleToState.
        const wg = wiggleFfmpegExprs(w.anim.wiggle) || {};
        const plus = (a, b) => (b ? (a && a !== '0' ? `(${a})+${b}` : b) : a);
        const times = (a, b) => (b ? (a ? `(${a})*${b}` : b) : a);
        const out = {
            x_expr: plus(channelExpr(axisTerm('dx'), '0') || '0', wg.x),
            y_expr: plus(channelExpr(axisTerm('dy'), '0') || '0', wg.y),
            in_start: inHas ? w.inStart : 0,
            in_dur: inHas ? fadeSpan(inSpec, inDur) : 0,
            // Cửa trập Out phải CẠN đúng lúc cửa sổ Out kết thúc -> co về cuối cửa sổ
            out_start: outHas ? w.outEnd - fadeSpan(outSpec, outDur) : 0,
            out_dur: outHas ? fadeSpan(outSpec, outDur) : 0,
        };
        const sxExpr = times(channelExpr(scaleTerm('sx'), '1'), wg.sx);
        const syExpr = times(channelExpr(scaleTerm('sy'), '1'), wg.sy);
        const rotExpr = plus(channelExpr(rotTerm, '0'), wg.rot);
        if (sxExpr) out.scale_x_expr = sxExpr;
        if (syExpr) out.scale_y_expr = syExpr;
        if (rotExpr) out.rot_expr = rotExpr;
        // Wiggle vị trí: rung vài px phải dời dưới pixel khi ghép, không thì giật từng bậc 1 px
        // (sidecar SubpixelShiftFilter). Chỉ block có Wiggle vị trí mang cờ này.
        if (wg.x || wg.y) out.subpixel = true;
        return out;
    }

    /* Hệ số độ mờ CHÍNH XÁC của In/Out (0..1) theo LOCALT, KHỚP animationStateAt
     * (opacityMul = min(1, op·v) trong cửa sổ In/Out, 1 ở đoạn hold) — thay cho cửa trập
     * `fade` tuyến tính của videoAnimationExpr. Dùng cho ẢNH có Wiggle xuất bằng biểu thức
     * (chuỗi bake cũ của ảnh khớp engine từng khung, đường biểu thức phải giữ được điều đó).
     * null nếu không có In/Out. */
    function inOutOpacityFfmpegExpr(item) {
        const w = resolveWindows(item);
        if (!w) return null;
        const inHas = w.anim.in.type !== 'none';
        const outHas = w.anim.out.type !== 'none';
        if (!inHas && !outHas) return null;
        const f = (n) => (Number(n) || 0).toFixed(4);
        const inDur = Math.max(0.001, w.inEnd - w.inStart);
        const outDur = Math.max(0.001, w.outEnd - w.outStart);
        const term = (side, pExpr) => {
            const spec = sideSpec(side);
            // effectiveEasing: fade + spring/bounce chạy ease-in-out — đúng như animationStateAt.
            return `min(1,${f((spec && spec.op) || 1)}*(${ffEase(effectiveEasing(side.type, side.easing), pExpr)}))`;
        };
        const inPart = inHas ? term(w.anim.in, `clip((LOCALT-${f(w.inStart)})/${f(inDur)},0,1)`) : '1';
        const outPart = outHas ? term(w.anim.out, `clip(1-(LOCALT-${f(w.outStart)})/${f(outDur)},0,1)`) : '1';
        return `clip(if(lt(LOCALT,${f(w.inEnd)}),${inPart},if(gt(LOCALT,${f(w.outStart)}),${outPart},1)),0,1)`;
    }

    /* ---- KEYFRAME: nội suy giá trị thuộc tính theo thời gian (lớp NÂNG CAO, song song
     * In/Out/Combo) ---- Mô hình: keyframes = { field: [{ t, v, e }] } với t = giây CỤC BỘ
     * (từ đầu item/clip), v = giá trị, e = easing đoạn RỜI keyframe này. effectiveTransformAt
     * cho ra transform tại thời điểm t; caller áp delta hoạt ảnh (In/Out/Combo) LÊN TRÊN. */
    const KEYFRAME_FIELDS = ['position_x', 'position_y', 'scale', 'rotation', 'opacity'];

    /* ---- KEYFRAME -> biểu thức FFmpeg theo thời gian (dùng cho EXPORT/render) ----
     * Sinh biểu thức piecewise (nội suy có easing, KHỚP evalKeyframeField của preview).
     * Token LOCALT = thời gian cục bộ từ đầu clip/overlay; sidecar thay LOCALT bằng biến
     * thời gian của filter (t cho scale/rotate/overlay, T cho geq). ĐƠN VỊ GIỮ NGUYÊN theo
     * field (px / % / độ) — sidecar tự quy đổi. */
    function kfNum(n) { return (Number(n) || 0).toFixed(4); }

    // Biểu thức FFmpeg nội suy 1 field theo LOCALT; null nếu danh sách rỗng.
    function keyframeFieldFfmpegExpr(list) {
        if (!Array.isArray(list) || list.length === 0) return null;
        const arr = list
            .map((k) => ({ t: Number(k.t) || 0, v: Number(k.v) || 0, e: EASING_VALUES.has(k.e) ? k.e : 'ease-in-out' }))
            .sort((a, b) => a.t - b.t);
        if (arr.length === 1) return `(${kfNum(arr[0].v)})`;
        // Giữ mép: sau kf cuối = v cuối. Dựng if lồng từ đoạn CUỐI về ĐẦU; đoạn đầu tiên
        // (LOCALT < t[1]) đã bao trường hợp trước kf đầu vì progress bị clip(…,0,1)=0 -> v[0].
        let expr = `(${kfNum(arr[arr.length - 1].v)})`;
        for (let i = arr.length - 2; i >= 0; i -= 1) {
            const a = arr[i];
            const b = arr[i + 1];
            const dt = Math.max(1e-6, b.t - a.t);
            const p = `clip((LOCALT-${kfNum(a.t)})/${kfNum(dt)},0,1)`;
            const seg = `(${kfNum(a.v)}+(${kfNum(b.v - a.v)})*(${ffEase(a.e, p)}))`;
            expr = `if(lt(LOCALT,${kfNum(b.t)}),${seg},${expr})`;
        }
        return expr;
    }

    // Trả object {x_expr,y_expr,scale_expr,rot_expr,opacity_expr} cho các field CÓ keyframe,
    // hoặc null nếu không có keyframe nào. Chỉ gồm field thực sự có ≥1 keyframe.
    function keyframeFfmpegExprs(keyframes) {
        if (!hasKeyframes(keyframes)) return null;
        const MAP = { position_x: 'x_expr', position_y: 'y_expr', scale: 'scale_expr', rotation: 'rot_expr', opacity: 'opacity_expr' };
        const out = {};
        let any = false;
        KEYFRAME_FIELDS.forEach((f) => {
            const e = keyframeFieldFfmpegExpr(keyframes[f]);
            if (e) { out[MAP[f]] = e; any = true; }
        });
        return any ? out : null;
    }

    function hasKeyframes(keyframes) {
        if (!keyframes || typeof keyframes !== 'object') return false;
        return KEYFRAME_FIELDS.some((f) => Array.isArray(keyframes[f]) && keyframes[f].length > 0);
    }

    // Nội suy 1 field tại thời điểm t. null nếu rỗng. Giữ MÉP (trước kf đầu = v đầu; sau
    // kf cuối = v cuối). Giữa 2 keyframe: nội suy theo easing của keyframe TRÁI.
    function evalKeyframeField(list, t) {
        if (!Array.isArray(list) || list.length === 0) return null;
        const arr = list.slice().sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
        const time = Number(t) || 0;
        if (arr.length === 1) return Number(arr[0].v);
        if (time <= Number(arr[0].t)) return Number(arr[0].v);
        const last = arr[arr.length - 1];
        if (time >= Number(last.t)) return Number(last.v);
        for (let i = 0; i < arr.length - 1; i += 1) {
            const a = arr[i];
            const b = arr[i + 1];
            const ta = Number(a.t);
            const tb = Number(b.t);
            if (time >= ta && time <= tb) {
                const p = Math.min(1, Math.max(0, (time - ta) / Math.max(1e-6, tb - ta)));
                const easeFn = EASINGS[a.e] || EASINGS['ease-in-out'];
                const k = easeFn(p);
                return Number(a.v) + (Number(b.v) - Number(a.v)) * k;
            }
        }
        return Number(last.v);
    }

    // Bản sao transform với các field CÓ keyframe được ghi đè bằng giá trị nội suy tại t.
    function effectiveTransformAt(baseTransform, keyframes, t) {
        const out = { ...(baseTransform || {}) };
        if (!hasKeyframes(keyframes)) return out;
        KEYFRAME_FIELDS.forEach((f) => {
            const v = evalKeyframeField(keyframes[f], t);
            if (v != null && Number.isFinite(v)) out[f] = v;
        });
        return out;
    }

    /* ---- VỊ TRÍ: MỘT keyframe dùng chung cho CẢ HAI TRỤC (2026-09-16) ----
     * Dữ liệu vẫn là HAI mảng `position_x` / `position_y` — biểu thức xuất, sidecar và
     * file .crab cũ KHÔNG đổi một dòng. Thứ được thêm vào là một BẤT BIẾN: hai mảng luôn
     * có keyframe tại CÙNG bộ mốc thời gian. Nhờ đó tầng UI gộp chúng thành MỘT hình thoi,
     * bấm một lần là đánh dấu xong cả vị trí (giống CapCut/Premiere) thay vì hai lần.
     *
     * `POSITION_KEYFRAME_FIELD` là tên field ẢO, CHỈ sống ở tầng UI (nút ◆ và ◂ ▸). Cố ý
     * KHÔNG thêm vào KEYFRAME_FIELDS: mọi vòng lặp render/nội suy/sinh biểu thức chạy trên
     * hằng đó, thêm một khoá không có dữ liệu thật vào là làm hỏng cả chuỗi. */
    const POSITION_KEYFRAME_FIELD = 'position';
    const POSITION_KEYFRAME_FIELDS = ['position_x', 'position_y'];
    const KF_PAIR_EPS = 0.02; // dung sai gom mốc, khớp KF_EPS của editing-runtime.js

    /* Ghép cặp mốc keyframe của hai trục: trục nào THIẾU keyframe tại một mốc thì chèn
     * thêm bằng giá trị NỘI SUY tại đúng mốc đó -> đường chuyển động giữ nguyên, chỉ là
     * mỗi mốc giờ có đủ hai nửa. Idempotent (chạy lại không sinh thêm gì). Trả về true nếu
     * có sửa đổi.
     *
     * Cần cho dữ liệu KHÔNG theo bất biến: dự án .crab dựng trước thay đổi này, nơi người
     * dùng đánh dấu X và Y riêng nên hai trục lệch mốc (hoặc chỉ một trục có keyframe).
     *
     * Trục RỖNG hoàn toàn thì không nội suy được -> lấy giá trị TĨNH trong transform. */
    function pairPositionKeyframes(obj) {
        const kfs = obj && typeof obj === 'object' ? obj.keyframes : null;
        if (!kfs || typeof kfs !== 'object') return false;
        const lists = POSITION_KEYFRAME_FIELDS.map((f) => (Array.isArray(kfs[f]) ? kfs[f].slice() : []));
        if (!lists.some((l) => l.length)) return false;
        lists.forEach((l) => l.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0)));
        /* Gom mốc của cả hai trục thành CỤM trong dung sai KF_PAIR_EPS: dữ liệu cũ có thể
         * đặt mốc X và Y lệch nhau vài ms, mà UI vốn coi lệch dưới KF_EPS là CÙNG một
         * keyframe — không gom thì sẽ chèn thừa một cặp keyframe sát rạt. */
        const clusters = [];
        lists.flat()
            .map((k) => Number(k.t) || 0)
            .sort((a, b) => a - b)
            .forEach((t) => {
                if (!clusters.length || t - clusters[clusters.length - 1] > KF_PAIR_EPS) clusters.push(t);
            });
        let changed = false;
        POSITION_KEYFRAME_FIELDS.forEach((field, i) => {
            const list = lists[i];
            const missing = clusters.filter((t) => !list.some((k) => Math.abs((Number(k.t) || 0) - t) <= KF_PAIR_EPS));
            if (!missing.length) return;
            missing.forEach((t) => {
                const v = list.length
                    ? evalKeyframeField(list, t)
                    : (Number(obj.transform && obj.transform[field]) || 0);
                /* Kế thừa easing của keyframe BÊN TRÁI: cắt một đoạn có easing làm đôi thì
                 * không đoạn con nào trùng khít đường cong cũ tuyệt đối được, lấy easing
                 * của đoạn đang bị cắt là bám sát nhất. Giá trị TẠI mốc thì luôn đúng. */
                const left = list.filter((k) => (Number(k.t) || 0) <= t).pop();
                list.push({ t, v: Number(v) || 0, e: (left && EASING_VALUES.has(left.e)) ? left.e : 'ease-in-out' });
            });
            list.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
            kfs[field] = list;
            changed = true;
        });
        return changed;
    }

    /* ---- KEYFRAME ÂM LƯỢNG (namespace SONG SONG với keyframe transform) ----
     * Cố tình KHÔNG thêm 'volume' vào KEYFRAME_FIELDS: `hasKeyframes()` đang là cổng bật
     * đường render/bake TRANSFORM ở editing-runtime.js, nên một block audio chỉ có keyframe
     * âm lượng sẽ bị kéo qua đường transform vô nghĩa (và tốn kém). Dữ liệu vẫn nằm chung
     * chỗ `obj.keyframes.volume = [{t, v, e}]` để undo/redo và .crab tự có — đúng cách hệ
     * keyframe MÀU (khoá 'adj.*') đang làm.
     *   t = giây CỤC BỘ từ đầu block; v = PHẦN TRĂM âm lượng (100 = 0 dB), khớp mô hình
     *   item.volume / clip.audio_volume. */
    const VOLUME_KEYFRAME_FIELD = 'volume';

    function hasVolumeKeyframes(keyframes) {
        if (!keyframes || typeof keyframes !== 'object') return false;
        const list = keyframes[VOLUME_KEYFRAME_FIELD];
        return Array.isArray(list) && list.length > 0;
    }

    // Phần trăm âm lượng tại t; null nếu block không có keyframe âm lượng (caller giữ
    // nguyên đường cũ dùng giá trị tĩnh).
    function volumeAt(keyframes, t) {
        if (!hasVolumeKeyframes(keyframes)) return null;
        return evalKeyframeField(keyframes[VOLUME_KEYFRAME_FIELD], t);
    }

    // Biểu thức FFmpeg cho filter `volume` (đơn vị GAIN TUYẾN TÍNH = percent/100), token
    // LOCALT như mọi keyframe khác — sidecar thay bằng biến thời gian của chuỗi tiếng.
    // null nếu không có keyframe.
    function volumeKeyframeFfmpegExpr(keyframes) {
        if (!hasVolumeKeyframes(keyframes)) return null;
        const gainList = keyframes[VOLUME_KEYFRAME_FIELD].map((k) => ({
            t: Number(k.t) || 0,
            v: (Number(k.v) || 0) / 100,
            e: k.e,
        }));
        return keyframeFieldFfmpegExpr(gainList);
    }

    function defaultMagicFillAnimation() {
        return {
            in: { type: 'pop', duration: 0.4, delay: 0, easing: 'spring' },
            out: { type: 'fade', duration: 0.4, delay: 0, easing: 'ease-in-out' },
        };
    }

    /* ---- COMBO: preset ghi ĐỒNG THỜI in + out (một hiệu ứng "vào-ra" trọn gói) ----
     * Mỗi combo khai báo effect+easing cho từng phía. applyCombo() chia thời lượng
     * tổng theo tỉ lệ (ratio = phần dành cho In) rồi kẹp về [DUR_MIN, DUR_MAX]. */
    const COMBO_OPTIONS = [
        { value: 'fade', label: _t('Mờ vào-ra'), in: { type: 'fade', easing: 'ease-in-out' }, out: { type: 'fade', easing: 'ease-in-out' } },
        { value: 'pop_fade', label: _t('Bật lên & mờ'), in: { type: 'pop', easing: 'spring' }, out: { type: 'fade', easing: 'ease-in-out' } },
        { value: 'zoom', label: _t('Phóng vào-ra'), in: { type: 'scale', easing: 'back' }, out: { type: 'zoom_out', easing: 'ease-in-out' } },
        { value: 'rise_fall', label: _t('Lên & xuống'), in: { type: 'slide_up', easing: 'ease-out' }, out: { type: 'slide_down', easing: 'ease-in' } },
        { value: 'slide_lr', label: _t('Trượt trái-phải'), in: { type: 'slide_left', easing: 'ease-out' }, out: { type: 'slide_right', easing: 'ease-in' } },
        { value: 'spin', label: _t('Xoay tròn'), in: { type: 'spin', easing: 'ease-out' }, out: { type: 'spin', easing: 'ease-in' } },
        { value: 'flip', label: _t('Lật'), in: { type: 'flip', easing: 'back' }, out: { type: 'flip', easing: 'ease-in-out' } },
        { value: 'rotate', label: _t('Nghiêng'), in: { type: 'rotate', easing: 'back' }, out: { type: 'rotate', easing: 'ease-in-out' } },
        { value: 'drift', label: _t('Trôi nhẹ'), in: { type: 'drift', easing: 'ease-out' }, out: { type: 'drift', easing: 'ease-in-out' } },
        { value: 'bounce', label: _t('Nảy vào'), in: { type: 'pop', easing: 'bounce' }, out: { type: 'scale', easing: 'ease-in-out' } },
        { value: 'zoom_spin', label: _t('Phóng & xoay'), in: { type: 'scale', easing: 'back' }, out: { type: 'spin', easing: 'ease-in' } },
    ];
    const COMBO_BY_VALUE = new Map(COMBO_OPTIONS.map((c) => [c.value, c]));

    // Trả animation {in, out} từ 1 combo. totalDuration = tổng thời lượng vào+ra;
    // ratio ∈ (0,1) = phần dành cho In (mặc định 0.5 -> chia đôi).
    function applyCombo(comboValue, totalDuration, ratio) {
        const combo = COMBO_BY_VALUE.get(comboValue);
        if (!combo) return null;
        const total = clampNumber(totalDuration, 2 * DUR_MIN, 2 * DUR_MAX, 0.8);
        const r = clampNumber(ratio, 0.15, 0.85, 0.5);
        const inDur = clampNumber(total * r, DUR_MIN, DUR_MAX, 0.4);
        const outDur = clampNumber(total * (1 - r), DUR_MIN, DUR_MAX, 0.4);
        return {
            in: { type: combo.in.type, duration: inDur, delay: 0, easing: combo.in.easing },
            out: { type: combo.out.type, duration: outDur, delay: 0, easing: combo.out.easing },
        };
    }

    // Đoán combo hiện tại từ item.animation (khớp cặp type in/out) -> value hoặc ''.
    function matchCombo(anim) {
        const a = normalizeAnimation(anim);
        if (!a) return '';
        const hit = COMBO_OPTIONS.find((c) => c.in.type === a.in.type && c.out.type === a.out.type);
        return hit ? hit.value : '';
    }

    /* ======================= THUMBNAIL MINH HOẠ HIỆU ỨNG =======================
     * Lưới chọn hiệu ứng (kiểu CapCut) cần MỖI Ô TỰ CHUYỂN ĐỘNG khi rê chuột — đọc
     * tên "Pop"/"Trôi nhẹ" trong một <select> thì không ai hình dung ra hiệu ứng.
     *
     * Nguyên tắc: ô xem trước chạy CHÍNH animationStateAt() của engine (không vẽ lại
     * bằng CSS/keyframes riêng), nên hình trong ô và hình trên video LUÔN khớp — cùng
     * lý do preview và export dùng chung engine này. Thứ tự phép biến hình cũng khớp
     * preview: translate(dx,dy) -> rotate -> scale.
     *
     * Chu kỳ hover: pseudo-item ngắn có sẵn đoạn "giữ" để mắt kịp thấy trạng thái tĩnh
     *   - side 'in'   : [chạy vào][giữ]
     *   - side 'out'  : [giữ][chạy ra]
     *   - side 'combo': [chạy vào][giữ][chạy ra]
     * Khung TĨNH (không hover) lấy ở GIỮA hiệu ứng, không phải ở trạng thái nghỉ: ô
     * đứng yên vẫn phải phân biệt được "Trượt lên" với "Xoay tròn" chỉ bằng mắt.
     * ========================================================================== */
    const THUMB_IN_DUR = 0.55;
    const THUMB_OUT_DUR = 0.55;
    const THUMB_HOLD = 0.45;
    const THUMB_WIGGLE_DUR = 2;

    // spec = { side: 'in'|'out'|'combo', type, easing }. Trả null cho 'none'/không hợp lệ
    // (ô "Không" -> chỉ vẽ tile tĩnh + huy hiệu gạch chéo).
    function thumbPseudoItem(spec) {
        const none = { type: 'none', duration: 0.4, delay: 0, easing: 'ease-in-out' };
        const type = spec && spec.type;
        if (!type || type === 'none') return null;
        // Ô Wiggle: rung liên tục, biên độ đo theo khung ô minh hoạ (128×72).
        if (spec.side === 'wiggle') {
            if (!WIGGLE_DEFAULTS[type]) return null;
            const THUMB_AMP = { position: 9, scale: 22, rotation: 22, opacity: 85 };
            return {
                animation: { in: { ...none }, out: { ...none },
                    wiggle: { [type]: { enabled: true, freq: 3, amp: THUMB_AMP[type], seed: 3 } } },
                duration: THUMB_WIGGLE_DUR,
            };
        }
        if (spec.side === 'combo') {
            const anim = applyCombo(type, THUMB_IN_DUR + THUMB_OUT_DUR, 0.5);
            if (!anim) return null;
            return { animation: anim, duration: THUMB_IN_DUR + THUMB_OUT_DUR + THUMB_HOLD };
        }
        const easing = (spec.easing && EASING_VALUES.has(spec.easing)) ? spec.easing : 'ease-out';
        if (spec.side === 'out') {
            return {
                animation: { in: { ...none }, out: { type, duration: THUMB_OUT_DUR, delay: 0, easing } },
                duration: THUMB_OUT_DUR + THUMB_HOLD,
            };
        }
        return {
            animation: { in: { type, duration: THUMB_IN_DUR, delay: 0, easing }, out: { ...none } },
            duration: THUMB_IN_DUR + THUMB_HOLD,
        };
    }

    /* Thời điểm cục bộ cho khung TĨNH.
     * Chọn theo VISIBILITY chứ không theo % thời gian: easing 'ease-out' chạy xong
     * ~94% quãng đường ngay ở mốc 60% thời gian, nên lấy theo thời gian thì gần hết
     * hiệu ứng nào cũng đóng băng ở trạng thái nghỉ -> mọi ô nhìn y hệt nhau. Quét
     * cửa sổ tìm mốc có visibility gần 0.45 (đang ở lưng chừng, thấy rõ đặc trưng:
     * trượt thì lệch, xoay thì nghiêng, đánh máy thì hụt chữ). */
    const THUMB_STATIC_VIS = 0.45;
    function thumbStaticTime(spec, pseudo) {
        // Wiggle không có "lưng chừng": lấy một mốc đang lệch rõ khỏi trạng thái nghỉ.
        if (spec && spec.side === 'wiggle') return 0.37;
        const w = resolveWindows(pseudo);
        if (!w) return 0;
        const useOut = spec.side === 'out';
        const side = useOut ? w.anim.out : w.anim.in;
        const start = useOut ? w.outStart : w.inStart;
        const end = useOut ? w.outEnd : w.inEnd;
        const ease = EASINGS[effectiveEasing(side.type, side.easing)] || EASINGS.linear;
        let bestT = (start + end) / 2;
        let bestErr = Infinity;
        // Quét (không giải ngược): spring/bounce vọt lố nên không đơn điệu.
        for (let i = 0; i <= 32; i += 1) {
            const p = i / 32;
            const err = Math.abs(ease(useOut ? 1 - p : p) - THUMB_STATIC_VIS);
            if (err < bestErr) {
                bestErr = err;
                bestT = start + p * (end - start);
            }
        }
        return bestT;
    }

    function roundRectPath(g, x, y, w, h, r) {
        const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
        g.beginPath();
        g.moveTo(x + rr, y);
        g.lineTo(x + w - rr, y);
        g.arcTo(x + w, y, x + w, y + rr, rr);
        g.lineTo(x + w, y + h - rr);
        g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
        g.lineTo(x + rr, y + h);
        g.arcTo(x, y + h, x, y + h - rr, rr);
        g.lineTo(x, y + rr);
        g.arcTo(x, y, x + rr, y, rr);
        g.closePath();
    }

    /* Tile đại diện cho BLOCK đang được áp hiệu ứng.
     * glyph 'text' -> "Aa" (block chữ) | 'media' -> biểu tượng khung hình (video/ảnh/shape).
     * Vẽ tại (0,0,w,h) — caller đã đặt sẵn ma trận biến hình. */
    function paintThumbTile(g, w, h, glyph) {
        const grad = g.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#4b7bec');
        grad.addColorStop(1, '#1e3a8a');
        roundRectPath(g, 0, 0, w, h, Math.min(6, h * 0.14));
        g.fillStyle = grad;
        g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.28)';
        g.lineWidth = 1;
        g.stroke();
        if (glyph === 'text') {
            g.fillStyle = 'rgba(255,255,255,0.95)';
            g.font = `700 ${Math.round(h * 0.46)}px system-ui, -apple-system, sans-serif`;
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText('Aa', w / 2, h / 2 + h * 0.02);
            return;
        }
        // Khung hình: mặt trời + 2 ngọn núi (ước lệ ảnh/video)
        g.save();
        roundRectPath(g, 0, 0, w, h, Math.min(6, h * 0.14));
        g.clip();
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath();
        g.arc(w * 0.28, h * 0.3, Math.max(2, h * 0.1), 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.beginPath();
        g.moveTo(w * 0.06, h * 0.92);
        g.lineTo(w * 0.42, h * 0.44);
        g.lineTo(w * 0.72, h * 0.92);
        g.closePath();
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.5)';
        g.beginPath();
        g.moveTo(w * 0.5, h * 0.92);
        g.lineTo(w * 0.75, h * 0.56);
        g.lineTo(w * 0.98, h * 0.92);
        g.closePath();
        g.fill();
        g.restore();
    }

    // Huy hiệu ⊘ cho ô "Không" (không có hiệu ứng).
    function paintNoneBadge(g, W, H) {
        const r = Math.min(W, H) * 0.17;
        g.save();
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.lineWidth = Math.max(1.5, r * 0.18);
        g.beginPath();
        g.arc(W / 2, H / 2, r, 0, Math.PI * 2);
        g.stroke();
        g.beginPath();
        g.moveTo(W / 2 - r * 0.72, H / 2 + r * 0.72);
        g.lineTo(W / 2 + r * 0.72, H / 2 - r * 0.72);
        g.stroke();
        g.restore();
    }

    /* Vẽ 1 ô minh hoạ vào <canvas>.
     *   spec = { side: 'in'|'out'|'combo', type, easing }
     *   p    = tiến độ chu kỳ ∈ [0,1]; bỏ trống -> khung tĩnh (giữa hiệu ứng)
     *   opts = { glyph: 'text'|'media' } */
    function drawThumb(canvas, spec, p, opts) {
        if (!canvas || !canvas.getContext) return;
        const g = canvas.getContext('2d');
        if (!g) return;
        const W = canvas.width;
        const H = canvas.height;
        const glyph = (opts && opts.glyph) || 'media';
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, W, H);
        g.fillStyle = '#0c0d10';
        g.fillRect(0, 0, W, H);

        const tw = Math.round(W * 0.62);
        const th = Math.round(H * 0.62);
        const pseudo = thumbPseudoItem(spec || {});
        const isStatic = !(typeof p === 'number' && Number.isFinite(p));
        let state = null;
        if (pseudo) {
            const t = isStatic
                ? thumbStaticTime(spec, pseudo)
                : Math.min(1, Math.max(0, p)) * pseudo.duration;
            // boxHeight = chiều cao tile -> biên độ trượt tính theo CHÍNH khung ô này
            state = animationStateAt(pseudo, t, { boxHeight: th, fontSize: th * 0.46, charCount: 2 });
        }
        /* Khung TĨNH: gần như hiệu ứng nào cũng kéo opacity theo, nên ở mốc lưng chừng
         * CẢ LƯỚI mờ ~45% -> nhìn như đang bị vô hiệu hoá. Với hiệu ứng đã có dấu hiệu
         * HÌNH HỌC (dịch/xoay/co giãn) thì độ mờ là thông tin thừa -> nâng lên cho ô
         * sắc nét. Hiệu ứng chỉ đổi opacity (Mờ dần) giữ nguyên vì đó là dấu hiệu DUY
         * NHẤT của nó. Lúc hover (p có giá trị) luôn chạy đúng opacity của engine. */
        if (isStatic && state && !state.hidden
            && (state.dx || state.dy || state.rotate || state.scaleX !== 1 || state.scaleY !== 1)) {
            state = { ...state, opacityMul: Math.max(state.opacityMul, 0.85) };
        }
        if (!state) state = { ...IDENTITY, hidden: false };
        if (!state.hidden) {
            g.save();
            // Ô "Không": tile mờ hẳn để đọc ra "tắt hiệu ứng", không lẫn với ô đang bật
            g.globalAlpha = pseudo ? Math.min(1, Math.max(0, state.opacityMul)) : 0.4;
            g.translate(W / 2 + (state.dx || 0), H / 2 + (state.dy || 0));
            if (state.rotate) g.rotate((state.rotate * Math.PI) / 180);
            g.scale(Math.max(0.001, state.scaleX), Math.max(0.001, state.scaleY));
            g.translate(-tw / 2, -th / 2);
            // typewriter: hiện dần theo số ký tự -> cắt bớt bên phải
            if (state.charFrac < 1) {
                g.beginPath();
                g.rect(0, 0, tw * state.charFrac, th);
                g.clip();
            }
            paintThumbTile(g, tw, th, glyph);
            g.restore();
        }
        if (!pseudo) paintNoneBadge(g, W, H);
    }

    return {
        EFFECT_OPTIONS,
        EASING_OPTIONS,
        COMBO_OPTIONS,
        drawThumb,
        VIDEO_SUPPORTED_EFFECTS,
        videoAnimationExpr,
        inOutOpacityFfmpegExpr,
        // Bảng hệ số gốc — test đối chiếu biểu thức FFmpeg với hàm JS đọc từ đây
        EFFECT_SPECS,
        KEYFRAME_FIELDS,
        hasKeyframes,
        keyframeFfmpegExprs,
        // Bộ sinh biểu thức cho MỘT field — panel Điều chỉnh dùng để keyframe thông số
        // màu (khoá 'adj.*'), tái dùng đúng easing của preview nên không lệch.
        keyframeFieldFfmpegExpr,
        evalKeyframeField,
        effectiveTransformAt,
        // Vị trí = MỘT keyframe chung cho X và Y (field ẢO của tầng UI + hàm ghép cặp mốc).
        POSITION_KEYFRAME_FIELD,
        POSITION_KEYFRAME_FIELDS,
        pairPositionKeyframes,
        // Keyframe âm lượng — namespace riêng, KHÔNG nằm trong KEYFRAME_FIELDS (xem chú
        // thích ở chỗ khai báo VOLUME_KEYFRAME_FIELD).
        VOLUME_KEYFRAME_FIELD,
        hasVolumeKeyframes,
        volumeAt,
        volumeKeyframeFfmpegExpr,
        EASINGS,
        normalizeAnimation,
        // Wiggle (kiểu AE) — xem khối chú thích WIGGLE.
        WIGGLE_TYPES,
        WIGGLE_DEFAULTS,
        WIGGLE_AMP_MAX,
        WIGGLE_FREQ_MIN,
        WIGGLE_FREQ_MAX,
        WIGGLE_OCTAVES_MAX,
        WIGGLE_SEED_MAX,
        WIGGLE_STYLES,
        WIGGLE_HOLD_MAX,
        normalizeWiggle,
        normalizeWiggleFx,
        hasActiveWiggle,
        wiggleStateAt,
        wiggleFfmpegExprs,
        wiggleOpacityFfmpegExpr,
        resolveWindows,
        hasAnimation,
        animationStateAt,
        stateIsIdentity,
        maxSideDuration,
        defaultMagicFillAnimation,
        applyCombo,
        matchCombo,
    };
});
