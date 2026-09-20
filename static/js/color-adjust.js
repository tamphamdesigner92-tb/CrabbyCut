/* =============================================================================
 * COLOR ADJUST ENGINE — engine "Điều chỉnh màu" (Color Adjustments) của CrabbyCut
 *
 * File RIÊNG (như transitions.js / text-animations.js) và là NGUỒN SỰ THẬT DUY NHẤT
 * cho cả PREVIEW lẫn EXPORT. Nguyên tắc WYSIWYG của dự án: preview trông sao thì
 * video xuất ra y hệt vậy. Cách bảo đảm ở đây:
 *
 *   - Công thức toán được viết MỘT LẦN trong file này, rồi dùng lại ở 3 nơi:
 *       (a) GLSL shader (preview: PixiJS lane chính + canvas WebGL cho media overlay)
 *       (b) bộ sinh chuỗi filter FFmpeg (export, ffmpegFilters())
 *       (c) bộ "bake" 3D LUT (.cube) cho phần không có filter FFmpeg tương đương
 *   - Mỗi bước toán đều được chọn để KHỚP ĐÚNG một filter FFmpeg có sẵn, và shader
 *     mô phỏng lại ĐÚNG công thức của filter đó (chép theo mã nguồn FFmpeg, xem
 *     chú thích từng hàm) — không tự nghĩ ra công thức "đẹp hơn".
 *
 * CHUỖI XỬ LÝ (thứ tự CỐ ĐỊNH, preview và export giống hệt):
 *
 *   1. CƠ BẢN  : Exposure + Contrast + Saturation      -> FFmpeg `eq`
 *                (eq chạy trên YUV: brightness/contrast lên plane Y, saturation lên
 *                 plane U/V — shader vì thế cũng phải đổi sang YUV rồi mới áp)
 *   2. NHIỆT/TÔNG: Temperature + Tint + 3 Vòng tròn màu -> FFmpeg `colorbalance`
 *                (lift/gamma/gain của color wheel ánh xạ 1-1 sang shadows/midtones/
 *                 highlights của colorbalance)
 *   3. CURVES  : 4 kênh all/r/g/b                       -> FFmpeg `curves`
 *                (natural cubic spline, chép đúng interpolate() của vf_curves.c)
 *   4. HSL + LUT: HSL 8 màu và LUT người dùng           -> FFmpeg `lut3d`
 *                (cả hai đều là hàm thuần RGB->RGB nên GỘP ĐƯỢC vào MỘT .cube;
 *                 frontend bake cube, backend ghi ra file, sidecar gọi lut3d)
 *
 * VÌ SAO HSL PHẢI ĐI QUA LUT3D: FFmpeg KHÔNG có filter HSL theo 8 dải màu
 * (hue/selectivecolor đều không tương đương). Bake ra 3D LUT là cách duy nhất giữ
 * được WYSIWYG mà không phải viết filter C mới.
 *
 * ĐƠN VỊ: mọi thông số người dùng đều là -100..100 (hoặc 0..100 với intensity) để
 * UI slider đồng nhất; việc quy đổi sang đơn vị của FFmpeg nằm gọn trong file này.
 *
 * Module THUẦN (không đụng DOM/state của app) trừ lớp tiện ích WebGL ở cuối, vốn chỉ
 * nhận canvas + nguồn ảnh do caller truyền vào. Chạy được cả trong Node (cho test).
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ColorAdjust = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // ---------------------------------------------------------------------
    // 1. DATA MODEL
    // ---------------------------------------------------------------------

    // 8 dải màu của subtab HSL, theo thứ tự vòng tròn màu (giống Lightroom/CapCut).
    // hue = tâm dải (độ). Trọng số của 1 pixel được nội suy giữa 2 tâm KỀ NHAU nên
    // tổng trọng số luôn = 1 -> không có dải nào bị "hụt" hay cộng dồn quá tay.
    const HSL_BANDS = [
        { key: 'red', label: 'Đỏ', hue: 0, swatch: '#ff3b30' },
        { key: 'orange', label: 'Cam', hue: 30, swatch: '#ff9500' },
        { key: 'yellow', label: 'Vàng', hue: 60, swatch: '#ffcc00' },
        { key: 'green', label: 'Lục', hue: 120, swatch: '#34c759' },
        { key: 'aqua', label: 'Lam ngọc', hue: 180, swatch: '#32ade6' },
        { key: 'blue', label: 'Lam', hue: 240, swatch: '#007aff' },
        { key: 'purple', label: 'Tím', hue: 280, swatch: '#af52de' },
        { key: 'magenta', label: 'Hồng sen', hue: 320, swatch: '#ff2d92' },
    ];

    const WHEEL_KEYS = ['lift', 'gamma', 'gain'];
    const WHEEL_LABELS = { lift: 'Vùng tối (Lift)', gamma: 'Trung tính (Gamma)', gain: 'Vùng sáng (Gain)' };
    // Nhãn nhóm Độ sáng — dùng cho nhãn keyframe (UI dựng nhãn riêng ở ADJUST_TONE_FIELDS,
    // hai bên phải giống nhau về ý nghĩa).
    const TONE_LABELS = {
        highlights: 'Vùng sáng', shadows: 'Bóng', whites: 'Vùng sáng nhất',
        blacks: 'Vùng tối nhất', glow: 'Độ chói',
    };
    const CURVE_CHANNELS = ['all', 'r', 'g', 'b'];
    const CURVE_LABELS = { all: 'RGB', r: 'Đỏ', g: 'Lục', b: 'Lam' };

    // Đường cong mặc định = đường chéo (không đổi gì). LUÔN có điểm ở x=0 và x=1 để
    // không rơi vào nhánh "tự chèn điểm biên" của vf_curves (nhánh đó kẹp phẳng).
    function defaultCurve() { return [[0, 0], [1, 1]]; }

    function defaultTone() { return { highlights: 0, shadows: 0, whites: 0, blacks: 0, glow: 0 }; }

    // Nhóm HIỆU ỨNG — khác hẳn 4 nhóm kia: đây là các phép KHÔNG GIAN (đọc pixel lân
    // cận) chứ không phải hàm màu-sang-màu, nên không gộp được vào lut3d và phải chạy
    // thành các LƯỢT SHADER RIÊNG ở preview. Xem mục "8b. HIỆU ỨNG KHÔNG GIAN".
    // vignette là ±100 (âm = làm sáng viền); 4 cái còn lại 0..100.
    function defaultEffects() { return { sharpen: 0, clarity: 0, grain: 0, blur: 0, vignette: 0 }; }

    // MẶT NẠ — giới hạn PHẠM VI của phần chỉnh màu (đúng như CapCut), KHÔNG cắt clip.
    //
    // Toạ độ khai theo TỈ LỆ KHUNG, không theo pixel: preview và bản xuất khác độ phân
    // giải nhưng mặt nạ phải nằm đúng một chỗ. x/y là độ lệch so với TÂM khung, tính
    // theo nửa-khung (±1 = ra tới mép); width/height là nửa-kích-thước theo nửa-khung.
    /* Danh mục hình mặt nạ — DÙNG CHUNG cho mặt nạ giới hạn chỉnh màu (tab Điều chỉnh)
     * và mặt nạ CẮT BLOCK (tab Video, kiểu CapCut). Hai tính năng khác nhau ở chỗ GHÉP
     * (trộn màu vs nhân alpha) chứ hình học thì y hệt, nên khai một chỗ. */
    const MASK_TYPES = [
        { key: 'split', label: 'Tách' },
        { key: 'filmstrip', label: 'Cuộn phim' },
        { key: 'circle', label: 'Hình tròn' },
        { key: 'rect', label: 'Hình chữ nhật' },
        { key: 'star', label: 'Ngôi sao' },
        { key: 'heart', label: 'Tim' },
    ];
    // Hình KHÔNG có kích thước (nửa mặt phẳng) / chỉ có chiều cao — UI ẩn ô tương ứng.
    const MASK_TYPES_NO_SIZE = new Set(['split']);
    const MASK_TYPES_HEIGHT_ONLY = new Set(['filmstrip']);
    // Bo góc chỉ có nghĩa với chữ nhật.
    const MASK_TYPES_ROUNDNESS = new Set(['rect']);
    /* Mã SỐ gửi vào shader (uMaskType). KHÔNG suy từ thứ tự MASK_TYPES: thứ tự đó là thứ
     * tự HIỂN THỊ trong UI và đã đổi một lần cho khớp CapCut — buộc hai thứ vào nhau thì
     * lần sắp xếp lại UI tiếp theo sẽ âm thầm đổi hình của mọi mặt nạ đã lưu. */
    const MASK_TYPE_CODE = { rect: 0, circle: 1, split: 2, filmstrip: 3, star: 4, heart: 5 };

    function defaultMask() {
        return {
            enabled: false,
            type: 'rect',
            x: 0,
            y: 0,
            rotation: 0,
            width: 0.6,
            height: 0.6,
            feather: 10,
            roundness: 0,
            invert: false,
        };
    }

    function defaultAdjustments() {
        const hsl = {};
        HSL_BANDS.forEach((b) => { hsl[b.key] = { h: 0, s: 0, l: 0 }; });
        return {
            basic: { exposure: 0, contrast: 0, temperature: 0, tint: 0, saturation: 0 },
            tone: defaultTone(),
            effects: defaultEffects(),
            mask: defaultMask(),
            hsl,
            curves: { all: defaultCurve(), r: defaultCurve(), g: defaultCurve(), b: defaultCurve() },
            wheels: { lift: { r: 0, g: 0, b: 0 }, gamma: { r: 0, g: 0, b: 0 }, gain: { r: 0, g: 0, b: 0 } },
            lut: { id: '', name: '', intensity: 100 },
        };
    }

    function num(value, fallback, lo, hi) {
        const v = Number(value);
        if (!Number.isFinite(v)) return fallback;
        return Math.max(lo, Math.min(hi, v));
    }

    function normalizeCurve(raw) {
        if (!Array.isArray(raw)) return defaultCurve();
        const pts = raw
            .map((p) => (Array.isArray(p) ? [num(p[0], NaN, 0, 1), num(p[1], NaN, 0, 1)] : null))
            .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))
            .sort((a, b) => a[0] - b[0]);
        // Bỏ điểm trùng x (spline cần x tăng nghiêm ngặt)
        const out = [];
        pts.forEach((p) => {
            if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < 1e-6) out[out.length - 1] = p;
            else out.push(p);
        });
        if (!out.length || out[0][0] > 1e-6) out.unshift([0, out.length ? out[0][1] : 0]);
        if (out[out.length - 1][0] < 1 - 1e-6) out.push([1, out[out.length - 1][1]]);
        return out.length >= 2 ? out : defaultCurve();
    }

    // Chuẩn hoá TOÀN BỘ (đọc từ .crab / undo / payload cũ đều an toàn).
    /* Kẹp một object mặt nạ về dạng hợp lệ. Tách RIÊNG khỏi normalize() vì nay có HAI
     * nơi dùng cùng hình học: `adjustments.mask` (giới hạn phạm vi chỉnh màu) và
     * `video_mask` của block (cắt hình, kiểu CapCut). Một hàm cho cả hai để thêm hình
     * mới là cả hai chỗ cùng nhận. */
    function normalizeMask(raw) {
        const mk = (raw && typeof raw === 'object') ? raw : {};
        return {
            enabled: mk.enabled === true,
            type: MASK_TYPES.some((t) => t.key === mk.type) ? mk.type : 'rect',
            x: num(mk.x, 0, -2, 2),
            y: num(mk.y, 0, -2, 2),
            rotation: num(mk.rotation, 0, -360, 360),
            width: num(mk.width, 0.6, 0.01, 2),
            height: num(mk.height, 0.6, 0.01, 2),
            feather: num(mk.feather, 10, 0, 100),
            roundness: num(mk.roundness, 0, 0, 100),
            invert: mk.invert === true,
        };
    }

    // Mặt nạ CẮT HÌNH của block có bật và thật sự cắt gì không.
    function videoMaskIsActive(mask) {
        return !!(mask && mask.enabled);
    }

    function normalize(raw) {
        const def = defaultAdjustments();
        if (!raw || typeof raw !== 'object') return def;
        const b = raw.basic || {};
        def.basic = {
            exposure: num(b.exposure, 0, -100, 100),
            contrast: num(b.contrast, 0, -100, 100),
            temperature: num(b.temperature, 0, -100, 100),
            tint: num(b.tint, 0, -100, 100),
            saturation: num(b.saturation, 0, -100, 100),
        };
        const tn = raw.tone || {};
        def.tone = {
            highlights: num(tn.highlights, 0, -100, 100),
            shadows: num(tn.shadows, 0, -100, 100),
            whites: num(tn.whites, 0, -100, 100),
            blacks: num(tn.blacks, 0, -100, 100),
            glow: num(tn.glow, 0, -100, 100),
        };
        const ef = raw.effects || {};
        def.effects = {
            sharpen: num(ef.sharpen, 0, 0, 100),
            clarity: num(ef.clarity, 0, 0, 100),
            grain: num(ef.grain, 0, 0, 100),
            blur: num(ef.blur, 0, 0, 100),
            vignette: num(ef.vignette, 0, -100, 100),
        };
        def.mask = normalizeMask(raw.mask);
        const h = raw.hsl || {};
        HSL_BANDS.forEach((band) => {
            const src = h[band.key] || {};
            def.hsl[band.key] = {
                h: num(src.h, 0, -100, 100),
                s: num(src.s, 0, -100, 100),
                l: num(src.l, 0, -100, 100),
            };
        });
        const c = raw.curves || {};
        CURVE_CHANNELS.forEach((ch) => { def.curves[ch] = normalizeCurve(c[ch]); });
        const w = raw.wheels || {};
        WHEEL_KEYS.forEach((k) => {
            const src = w[k] || {};
            def.wheels[k] = { r: num(src.r, 0, -100, 100), g: num(src.g, 0, -100, 100), b: num(src.b, 0, -100, 100) };
        });
        const l = raw.lut || {};
        def.lut = {
            id: String(l.id || '').slice(0, 200),
            name: String(l.name || '').slice(0, 200),
            intensity: num(l.intensity, 100, 0, 100),
        };
        return def;
    }

    function clone(adj) { return normalize(adj); }

    /* CƯỜNG ĐỘ CỦA CẢ BỘ CHỈNH — "làm mờ dần hiệu ứng" (dùng cho Opacity của lớp Điều
     * chỉnh, kiểu Custom Adjustment của CapCut).
     *
     * VÌ SAO KÉO THÔNG SỐ VỀ TRUNG TÍNH chứ không pha ảnh ĐÃ CHỈNH với ảnh gốc ở cuối:
     * pha ở cuối cần một lượt trộn RIÊNG, mà bên xuất thì lượt đó phải do sidecar C++
     * dựng (split + blend) — tức HAI bản cài đặt của cùng một phép, đúng thứ mà WYSIWYG
     * ở đây đang phải tránh. Kéo thông số thì preview và bản xuất nhận CÙNG một object
     * `adjustments`, nên hai bên khớp bằng CẤU TRÚC, không cần thêm code ở backend.
     *
     * NÓ GIỐNG PHA ALPHA ĐẾN MỨC NÀO — đã đo, xem tests/scripts/adjust_layer_pipeline.js:
     *   Cường độ LUT: khớp TUYỆT ĐỐI (intensity vốn LÀ tỉ lệ pha, xem bakeCube).
     *   Mọi tầng TUYẾN TÍNH — eq (phơi sáng/tương phản/bão hoà) và colorbalance (nhiệt
     *     độ/sắc thái/3 vòng tròn màu): khớp TUYỆT ĐỐI, 0.00/255 trên pixel không bị kẹp
     *     biên (phơi sáng khớp được là nhờ nhánh riêng ở dưới).
     *   curves / tone: <= 0.4/255 — chỉ là sai số lượng tử của bảng tra 256 mức.
     *   HSL: ~6/255. Đây là tầng phi tuyến THẬT (trọng số dải phụ thuộc sắc độ/bão hoà
     *     của chính pixel) nên kéo `s` của dải không bằng pha đầu ra.
     *   Nhiều tầng phi tuyến xếp chồng (tone ∘ curves ∘ HSL): tới ~11/255 — pha
     *     đầu ra của cả chuỗi không bằng pha thông số của từng tầng. Chấp nhận: đây là
     *     một núm CƯỜNG ĐỘ (0 = tắt, 100 = đủ, đơn điệu ở giữa), không phải một phép
     *     compositing phải chính xác từng bit.
     *   Nhóm Hiệu ứng (nét/mờ/hạt/viền): giảm cường độ, và ở đó đó mới là đúng ý người
     *     dùng chứ không phải pha alpha.
     *
     * k = 0 -> trả về bộ mặc định (isIdentity() true) nên mọi cửa nhanh tự bỏ qua lớp.
     * Mặt nạ giữ nguyên: nó là HÌNH HỌC, không phải cường độ.
     */
    function scaleStrength(raw, strength) {
        const a = normalize(raw);
        const k = num(strength, 1, 0, 1);
        if (k >= 1 - 1e-6) return a;
        const lerp0 = (v) => num(v, 0, -100, 100) * k;
        /* PHƠI SÁNG đi đường riêng vì slider của nó KHÔNG tuyến tính: eqParams quy nó
         * thành hệ số NHÂN g = 2^(EV/50). Nhân thẳng slider cho k là kéo về trung tính
         * theo log -> đo được lệch tới 35/255 so với "làm mờ hiệu ứng" đúng nghĩa.
         * Làm trong miền HỆ SỐ: cặp (phơi sáng, tương phản) gộp lại thành phép tuyến tính
         * v' = C*(v-0.5)+0.5 + B với C = c*g, B = 0.5*c*(g-1) (xem eqParams). Pha kết quả
         * theo k tương đương C' = 1 + k*(C-1), B' = k*B, và giải ra:
         *     c' = C' - 2*B' = 1 + k*(c-1)   (đúng bằng "nhân slider tương phản cho k")
         *     g' = C' / c'
         * c' >= 1-k > 0 và C' >= 1-k > 0 nên phép chia và log2 luôn hợp lệ khi k < 1. */
        const gain = Math.pow(2, num(a.basic.exposure, 0, -100, 100) / 50);
        const ctr = 1 + (num(a.basic.contrast, 0, -100, 100) / 100);
        const ctrK = 1 + k * (ctr - 1);
        const gainK = (1 + k * ((ctr * gain) - 1)) / ctrK;
        Object.keys(a.basic).forEach((key) => { a.basic[key] = lerp0(a.basic[key]); });
        a.basic.exposure = num(50 * (Math.log(gainK) / Math.LN2), 0, -100, 100);
        Object.keys(a.tone).forEach((key) => { a.tone[key] = lerp0(a.tone[key]); });
        Object.keys(a.effects).forEach((key) => { a.effects[key] = lerp0(a.effects[key]); });
        HSL_BANDS.forEach((band) => {
            const s = a.hsl[band.key];
            a.hsl[band.key] = { h: lerp0(s.h), s: lerp0(s.s), l: lerp0(s.l) };
        });
        WHEEL_KEYS.forEach((key) => {
            const s = a.wheels[key];
            a.wheels[key] = { r: lerp0(s.r), g: lerp0(s.g), b: lerp0(s.b) };
        });
        /* Đường cong: kéo TUNG ĐỘ về đường chéo y = x (hoành độ không đổi -> vẫn tăng
         * nghiêm ngặt, spline vẫn dựng được).
         * NẰM TRÊN ĐƯỜNG CHÉO THÌ PHẢI THU VỀ defaultCurve() (đúng 2 điểm): curveIsIdentity
         * xét theo SỐ ĐIỂM, nên một đường 4 điểm đã phẳng vẫn bị coi là "có chỉnh" — và
         * isIdentity() của cả bộ không bao giờ true. Hậu quả: cường độ 0% mà lớp vẫn được
         * coi là đang bật, chuỗi filter rỗng vẫn được nối vào bản xuất. */
        CURVE_CHANNELS.forEach((ch) => {
            const pts = a.curves[ch].map(([x, y]) => [x, x + (y - x) * k]);
            a.curves[ch] = pts.every(([x, y]) => Math.abs(y - x) < 1e-6) ? defaultCurve() : pts;
        });
        a.lut = { ...a.lut, intensity: num(a.lut.intensity, 100, 0, 100) * k };
        return a;
    }

    /* Cùng phép trên, nhưng cho DANH SÁCH KEYFRAME của bộ chỉnh. Cần vì bản xuất dựng
     * biểu thức/sendcmd TRỰC TIẾP từ các danh sách này: chỉ kéo giá trị tĩnh thì thông
     * số nào có keyframe sẽ bỏ qua cường độ, và bản xuất lệch preview đúng ở chỗ đó.
     * Mọi thông số keyframe được đều là SỐ và có trung tính = 0 (kể cả lut.intensity),
     * nên nhân theo k là khớp với scaleStrength ở trên. */
    function scaleStrengthKeyframes(keyframes, strength) {
        if (!keyframes || typeof keyframes !== 'object') return keyframes || null;
        const k = num(strength, 1, 0, 1);
        if (k >= 1 - 1e-6) return keyframes;
        const out = { ...keyframes };
        KEYFRAME_PARAMS.forEach((param) => {
            const list = out[keyframeFieldName(param.path)];
            if (!Array.isArray(list) || !list.length) return;
            out[keyframeFieldName(param.path)] = list.map((point) => ({
                ...point,
                v: (Number(point.v) || 0) * k,
            }));
        });
        return out;
    }

    function curveIsIdentity(points) {
        const p = normalizeCurve(points);
        return p.length === 2
            && Math.abs(p[0][0]) < 1e-6 && Math.abs(p[0][1]) < 1e-6
            && Math.abs(p[1][0] - 1) < 1e-6 && Math.abs(p[1][1] - 1) < 1e-6;
    }

    // Không có gì để làm -> bỏ qua HOÀN TOÀN (không gắn filter preview, không thêm
    // filter export). Đây là cửa nhanh quan trọng: đại đa số block không chỉnh màu.
    function isIdentity(raw) {
        const a = normalize(raw);
        const bz = Object.values(a.basic).every((v) => Math.abs(v) < 1e-6);
        const tz = Object.values(a.tone).every((v) => Math.abs(v) < 1e-6);
        const hz = HSL_BANDS.every((band) => {
            const s = a.hsl[band.key];
            return Math.abs(s.h) < 1e-6 && Math.abs(s.s) < 1e-6 && Math.abs(s.l) < 1e-6;
        });
        const cz = CURVE_CHANNELS.every((ch) => curveIsIdentity(a.curves[ch]));
        const wz = WHEEL_KEYS.every((k) => {
            const s = a.wheels[k];
            return Math.abs(s.r) < 1e-6 && Math.abs(s.g) < 1e-6 && Math.abs(s.b) < 1e-6;
        });
        const lz = !a.lut.id || a.lut.intensity <= 0;
        const ez = effectsIsIdentity(a.effects);
        return bz && tz && hz && cz && wz && lz && ez;
    }

    // Chỉ phần HSL + LUT (tức phần phải đi qua lut3d) có tác dụng hay không.
    function needsLut3d(raw) {
        const a = normalize(raw);
        const hActive = HSL_BANDS.some((band) => {
            const s = a.hsl[band.key];
            return Math.abs(s.h) > 1e-6 || Math.abs(s.s) > 1e-6 || Math.abs(s.l) > 1e-6;
        });
        return hActive || (!!a.lut.id && a.lut.intensity > 0);
    }

    // ---------------------------------------------------------------------
    // 2. BƯỚC 1 — `eq` (Exposure / Contrast / Saturation)
    // ---------------------------------------------------------------------
    //
    // vf_eq.c dựng LUT cho plane Y bằng:  v' = contrast*(v - 0.5) + 0.5 + brightness
    // và cho plane U/V bằng chính công thức đó với contrast = saturation, brightness = 0.
    //
    // Người dùng của ta chỉnh EXPOSURE (nhân) chứ eq không có tham số nhân, nên ta
    // GỘP exposure vào cặp (contrast, brightness) — biến đổi tuyến tính nên gộp được
    // chính xác, không xấp xỉ:
    //     sau exposure: v1 = g*v          (g = 2^EV)
    //     sau contrast: v2 = c*(v1-0.5)+0.5
    //                      = (c*g)*v - 0.5*c + 0.5
    //     dạng eq:      v2 = C*(v-0.5)+0.5 + B  với C = c*g, B = 0.5*c*(g-1)
    function eqParams(raw) {
        const a = normalize(raw);
        const gain = Math.pow(2, a.basic.exposure / 50);   // ±100 -> ±2 stop
        const c = 1 + a.basic.contrast / 100;              // 0..2
        return {
            contrast: c * gain,
            brightness: 0.5 * c * (gain - 1),
            saturation: 1 + a.basic.saturation / 100,      // 0..2
        };
    }

    function eqIsIdentity(p) {
        return Math.abs(p.contrast - 1) < 1e-6 && Math.abs(p.brightness) < 1e-6 && Math.abs(p.saturation - 1) < 1e-6;
    }

    // ---------------------------------------------------------------------
    // 1b. NHÓM ĐỘ SÁNG — đường cong tone (highlights/shadows/whites/blacks/glow)
    // ---------------------------------------------------------------------
    //
    // 5 thông số ±100 gộp thành MỘT đường cong tone đi qua filter `curves` của
    // FFmpeg (đặt TRƯỚC 2 curves của người dùng).
    //
    // BA CÁI BẪY ĐÃ MẮC VÀ ĐÃ SỬA (2026-07-28) — đừng dựng lại kiểu cũ:
    //
    // 1. whites/blacks KHÔNG được dịch theo trục Y ở 2 điểm biên. Điểm x=1 đã có y=1
    //    nên "tăng vùng sáng nhất" bị kẹp trần -> slider CHẾT HOÀN TOÀN (đo được
    //    128->128, 32->32, 224->224); y=0 ở x=0 cũng vậy với "giảm vùng tối nhất".
    //    Đúng cách (giống Lightroom): dịch ĐIỂM TRẮNG / ĐIỂM ĐEN theo trục X —
    //    whites>0 nghĩa là mọi giá trị từ (1-travel) trở lên đều thành 1.
    //
    // 2. KHÔNG ghim cứng cả 5 điểm điều khiển. Bản cũ luôn đặt điểm tại x=0.4; khi
    //    nâng Bóng lên 100, x=0.25 lên 0.40 mà x=0.4 vẫn ghim ở 0.40 -> đoạn giữa
    //    phẳng rồi spline võng xuống, kết quả là "nâng vùng tối" lại LÀM TỐI trung
    //    tính (đo được 128->115, ngược hẳn kỳ vọng). Nay CHỈ thêm điểm cho thông số
    //    khác 0, các vùng còn lại để spline tự nội suy mượt.
    //
    // 3. Biên độ cũ (±0.15) quá nhỏ, kéo hết slider chỉ đổi ~4% -> người dùng tưởng
    //    là không có tác dụng. Nay đặt theo mức thấy rõ, ngang CapCut.
    //
    // MÔ HÌNH: y(x) = x + Σ (thông số × NHÂN CỤC BỘ của nó), rồi kẹp về [0,1].
    // Mỗi thông số có một nhân dạng cos² CHỈ khác 0 trong vùng sáng của riêng nó, nên
    // "Bóng" không kéo được vùng sáng và ngược lại — nếu chỉ đặt 1 điểm điều khiển rời
    // rồi để spline tự nối, tác động sẽ lan ra TOÀN DẢI (đo được: shadows=100 đẩy xám
    // 128 lên 196, tức biến "Bóng" thành "độ sáng tổng").
    //
    // Điểm ĐEN/TRẮNG dùng nhân NỬA, đạt cực đại ĐÚNG tại biên: nhờ phép kẹp [0,1],
    // blacks<0 tự thành "nghiến đen" (mọi giá trị dưới ngưỡng về 0) và whites>0 tự
    // thành "cháy sáng" (mọi giá trị trên ngưỡng về 1) — đúng cách Lightroom làm, mà
    // không cần nhánh if riêng cho từng chiều.
    const TONE_MID_GAIN = 0.22;    // Bóng / Vùng sáng
    const TONE_GLOW_GAIN = 0.20;   // Độ chói (ánh sáng bù)
    const TONE_END_GAIN = 0.20;    // Vùng tối nhất / Vùng sáng nhất

    // Số điểm điều khiển xuất ra cho filter `curves`. Preview cũng dựng bảng tra TỪ
    // CHÍNH danh sách điểm này (toneLut -> toneCurvePoints) nên hai bên luôn khớp,
    // kể cả khi spline có vượt biên nhẹ giữa 2 điểm.
    const TONE_CURVE_SAMPLES = 17;

    function toneIsIdentity(tone) {
        return Object.values(tone).every((v) => Math.abs(v) < 1e-6);
    }

    // Nhân cos² tâm c, nửa-bề-rộng w: bằng 1 tại c, giảm mượt về 0 tại c±w.
    function toneBump(x, c, w) {
        const d = Math.abs(x - c) / w;
        if (d >= 1) return 0;
        const k = Math.cos((Math.PI / 2) * d);
        return k * k;
    }

    // Trả về mảng điểm [x, y] cho filter `curves`, hoặc null nếu tone = identity.
    function toneCurvePoints(raw) {
        const a = normalize(raw);
        const t = a.tone;
        if (toneIsIdentity(t)) return null;
        const sh = t.shadows / 100;
        const hi = t.highlights / 100;
        const gl = t.glow / 100;
        const bk = t.blacks / 100;
        const wh = t.whites / 100;

        const pts = [];
        for (let i = 0; i < TONE_CURVE_SAMPLES; i += 1) {
            const x = i / (TONE_CURVE_SAMPLES - 1);
            let y = x;
            // Vùng ảnh hưởng: Bóng [0, 0.5] · Độ chói [0, 0.84] · Vùng sáng [0.5, 1]
            y += sh * TONE_MID_GAIN * toneBump(x, 0.25, 0.25);
            y += gl * TONE_GLOW_GAIN * toneBump(x, 0.42, 0.42);
            y += hi * TONE_MID_GAIN * toneBump(x, 0.75, 0.25);
            // Điểm đen: cực đại tại x=0, tắt ở 0.35. Điểm trắng: cực đại tại x=1.
            y += bk * TONE_END_GAIN * toneBump(x, 0, 0.35);
            y += wh * TONE_END_GAIN * toneBump(x, 1, 0.35);
            pts.push([x, Math.max(0, Math.min(1, y))]);
        }
        // Ép đơn điệu không giảm để đường cong không lật (lật -> banding + đảo sáng).
        for (let i = 1; i < pts.length; i += 1) {
            if (pts[i][1] < pts[i - 1][1]) pts[i][1] = pts[i - 1][1];
        }
        return pts;
    }

    // Bảng tra 256 mức cho đường cong tone (dùng cho shader preview).
    function toneLut(raw, size = 256) {
        const pts = toneCurvePoints(raw);
        const out = new Float32Array(size);
        if (!pts) {
            for (let i = 0; i < size; i++) out[i] = i / (size - 1);
            return out;
        }
        const y2 = curveSecondDerivatives(pts);
        for (let i = 0; i < size; i++) out[i] = evalCurveAt(pts, y2, i / (size - 1));
        return out;
    }

    // ---------------------------------------------------------------------
    // 1c. NHÓM HIỆU ỨNG — các phép KHÔNG GIAN (đọc pixel lân cận)
    // ---------------------------------------------------------------------
    //
    // Khác hẳn 4 nhóm còn lại: đây không phải hàm màu-sang-màu nên KHÔNG gộp được vào
    // lut3d, và preview phải chạy thành các LƯỢT SHADER riêng (xem SpatialPass).
    //
    // ĐỘC LẬP VỚI ĐỘ PHÂN GIẢI (bắt buộc, nếu không thì preview và bản xuất khác hẳn
    // nhau): mọi bán kính đều khai theo TỈ LỆ CHIỀU CAO KHUNG rồi mới quy ra pixel theo
    // từng độ phân giải. Preview 960px cao và bản xuất 1080px cao vì thế cho ra cùng
    // MỘT cảm giác mờ/nét, dù số pixel khác nhau.
    const SHARPEN_FRAC = 0.005;    // bán kính "Làm sắc nét" ≈ 0.5% chiều cao
    const CLARITY_FRAC = 0.013;    // "Độ rõ nét" = mặt nạ mờ bán kính lớn (tương phản cục bộ)
    // "Làm mờ": bán kính HỘP tối đa theo tỉ lệ chiều cao (1.2% -> 13px @1080p).
    // Xếp tầng 3 lần cho ra dáng gần Gauss, sigma tương đương = sqrt((2r+1)²-1)/2.
    const BLUR_FRAC = 0.012;
    const BLUR_CASCADE = 3;
    const SHARPEN_AMOUNT = 1.5;    // slider 100 -> unsharp amount
    const CLARITY_AMOUNT = 1.0;
    const GRAIN_STRENGTH = 30;     // slider 100 -> noise alls
    const VIGNETTE_MAX_ANGLE = Math.PI / 3;

    function effectsIsIdentity(effects) {
        const e = effects || {};
        return ['sharpen', 'clarity', 'grain', 'blur', 'vignette']
            .every((k) => Math.abs(Number(e[k]) || 0) < 1e-6);
    }

    // msize của filter `unsharp` PHẢI là số nguyên LẺ trong [3,23] — quy tỉ lệ ra pixel
    // rồi làm tròn về số lẻ gần nhất.
    function oddMsize(frac, frameHeight) {
        const px = Math.round(frac * Math.max(1, frameHeight));
        const odd = px % 2 === 0 ? px + 1 : px;
        return Math.max(3, Math.min(23, odd));
    }

    // Hạt nhân mờ của `unsharp` là BINOMIAL TÁCH TRỤC bậc (msize-1) — đo thực nghiệm
    // trên FFmpeg 8.1 bằng cách cho amount=-1 (khi đó đầu ra ĐÚNG BẰNG ảnh đã mờ) rồi
    // đọc đáp ứng xung: msize=5 cho [1,4,6,4,1]/16, msize=13 khớp Pascal bậc 12.
    // KHÔNG phải trung bình hộp — dùng hộp thì lệch tới 12/255 ở cạnh tương phản.
    function binomialKernel(msize) {
        const n = Math.max(2, msize - 1);
        const row = [1];
        for (let k = 1; k <= n; k += 1) row.push((row[k - 1] * (n - k + 1)) / k);
        const total = row.reduce((s, v) => s + v, 0);
        return row.map((v) => v / total);
    }

    // Hạt nhân HỘP bán kính r (bề rộng 2r+1) — khớp đúng `avgblur` của FFmpeg.
    function boxKernel(radius) {
        const r = Math.max(1, Math.round(radius));
        const w = 2 * r + 1;
        return new Array(w).fill(1 / w);
    }

    // Hạt nhân Gauss (chỉ còn dùng cho test/so sánh; chuỗi export dùng hộp xếp tầng).
    function gaussianKernel(sigma) {
        const s = Math.max(0.05, sigma);
        const radius = Math.max(1, Math.min(11, Math.ceil(s * 3)));
        const out = [];
        for (let i = -radius; i <= radius; i += 1) out.push(Math.exp(-(i * i) / (2 * s * s)));
        const total = out.reduce((a, b) => a + b, 0);
        return out.map((v) => v / total);
    }

    // Toàn bộ thông số không gian đã quy ra pixel cho MỘT độ phân giải cụ thể.
    function effectsSpec(raw, frameHeight = 1080) {
        const a = normalize(raw);
        const e = a.effects;
        const H = Math.max(1, frameHeight);
        return {
            clarity: e.clarity > 0
                ? { msize: oddMsize(CLARITY_FRAC, H), amount: (e.clarity / 100) * CLARITY_AMOUNT }
                : null,
            sharpen: e.sharpen > 0
                ? { msize: oddMsize(SHARPEN_FRAC, H), amount: (e.sharpen / 100) * SHARPEN_AMOUNT }
                : null,
            // Bán kính HỘP nguyên (không phải sigma): cả FFmpeg và preview đều dùng
            // ĐÚNG con số này nên không có chỗ nào phải xấp xỉ. Xem chú thích ở
            // ffmpegFilters về việc vì sao KHÔNG dùng gblur.
            // Trần 16 = bề rộng hộp 33 tap, đúng giới hạn một lượt shader (MAX_TAPS).
            // KẸP Ở ĐÂY chứ không kẹp riêng bên preview: effectsSpec là nguồn dùng chung
            // cho cả export lẫn shader, kẹp một chỗ thì hai bên vẫn khớp. Hệ quả: từ
            // khoảng 2700px chiều cao trở lên, "Làm mờ" bão hoà (mờ tương đối nhẹ dần).
            blur: e.blur > 0
                ? {
                    radius: Math.max(1, Math.min(16, Math.round((e.blur / 100) * BLUR_FRAC * H))),
                    cascade: BLUR_CASCADE,
                }
                : null,
            grain: e.grain > 0 ? { strength: Math.round((e.grain / 100) * GRAIN_STRENGTH) } : null,
            // vignette: factor = cos^4(angle * dnorm), dnorm = dist / hypot(w/2, h/2).
            // Đã đối chiếu FFmpeg 8.1 trên ảnh phẳng: lệch ≤0.007 (đúng bằng nhiễu
            // lượng tử 8-bit). Âm -> mode=backward (chia thay vì nhân) = làm SÁNG viền.
            vignette: Math.abs(e.vignette) > 0
                ? {
                    angle: (Math.abs(e.vignette) / 100) * VIGNETTE_MAX_ANGLE,
                    backward: e.vignette < 0,
                }
                : null,
        };
    }

    // ---------------------------------------------------------------------
    // 3. BƯỚC 2 — `colorbalance` (Temperature / Tint / Vòng tròn màu)
    // ---------------------------------------------------------------------
    //
    // colorbalance có đúng 3 nhóm shadows/midtones/highlights × 3 kênh RGB, tức là
    // TRÙNG KHỚP mô hình lift/gamma/gain của color wheel -> ánh xạ 1-1, không mất mát.
    // Temperature/Tint cũng là dịch màu nên gộp vào nhóm midtones.
    //
    //   Temperature > 0 = ẤM  : +đỏ, -lam
    //   Tint        > 0 = LỤC : +lục, -(đỏ+lam)/2 (bù để không lệch sáng)
    //
    // TEMP/TINT ĐƯỢC CỘNG VÀO CẢ 3 NHÓM (shadows + midtones + highlights), không chỉ
    // midtones: bên trong colorbalance, trọng số của nhóm midtones về 0 ở vùng rất
    // tối/rất sáng (xem cbComponent), nên nếu chỉ đặt ở midtones thì kéo "Nhiệt độ"
    // sẽ KHÔNG đổi gì trên ảnh sáng — trái với kỳ vọng của người dùng. Cộng đều cả 3
    // nhóm cho ra phép dịch màu TOÀN CỤC đúng nghĩa cân bằng trắng.
    const CB_WHEEL_GAIN = 0.5;   // slider ±100 -> ±0.5 trong thang colorbalance (-1..1)
    const CB_TEMP_GAIN = 0.30;
    const CB_TINT_GAIN = 0.30;

    function colorbalanceParams(raw) {
        const a = normalize(raw);
        const t = (a.basic.temperature / 100) * CB_TEMP_GAIN;
        const ti = (a.basic.tint / 100) * CB_TINT_GAIN;
        const w = (k, ch) => (a.wheels[k][ch] / 100) * CB_WHEEL_GAIN;
        const clamp1 = (v) => Math.max(-1, Math.min(1, v));
        const dr = t - ti * 0.5;
        const dg = ti;
        const db = -t - ti * 0.5;
        return {
            rs: clamp1(w('lift', 'r') + dr), gs: clamp1(w('lift', 'g') + dg), bs: clamp1(w('lift', 'b') + db),
            rm: clamp1(w('gamma', 'r') + dr), gm: clamp1(w('gamma', 'g') + dg), bm: clamp1(w('gamma', 'b') + db),
            rh: clamp1(w('gain', 'r') + dr), gh: clamp1(w('gain', 'g') + dg), bh: clamp1(w('gain', 'b') + db),
        };
    }

    function colorbalanceIsIdentity(p) {
        return Object.values(p).every((v) => Math.abs(v) < 1e-6);
    }

    // Chép ĐÚNG get_component() của libavfilter/vf_colorbalance.c (bản float).
    //
    // CHÚ Ý (đã đo thực nghiệm trên FFmpeg 8.1, đừng "sửa lại cho đẹp"): tham số l mà
    // filter truyền vào là max(r,g,b) + min(r,g,b) — tức thang 0..2, KHÔNG phải
    // lightness chuẩn (max+min)/2. Nếu dùng /2 thì 3 dải shadows/midtones/highlights
    // của preview sẽ rộng gấp đôi và lệch tâm so với video xuất ra (đo được tới
    // 36/255 khi kéo vòng tròn màu). Xem cbLightness().
    function cbComponent(v, l, s, m, h) {
        const a = 4.0, b = 0.333, scale = 0.7;
        const cl = (x) => Math.max(0, Math.min(1, x));
        const S = s * cl((b - l) * a + 0.5) * scale;
        const M = m * cl((l - b) * a + 0.5) * cl((1 - l - b) * a + 0.5) * scale;
        const H = h * cl((l + b - 1) * a + 0.5) * scale;
        return cl(v + S + M + H);
    }

    function cbLightness(r, g, b) {
        return Math.max(r, g, b) + Math.min(r, g, b);
    }

    // Tổng trọng số của 3 nhóm shadows+midtones+highlights tại độ sáng l.
    // Temp/Tint được cộng ĐỀU vào cả 3 nhóm (xem colorbalanceParams) nên tác động của
    // chúng lên một pixel là (độ dịch) × (tổng này) — đây chính là hệ số K trong nghiệm
    // cân bằng trắng bên dưới.
    function cbWeightSum(l) {
        const a = 4.0, b = 0.333, scale = 0.7;
        const cl = (x) => Math.max(0, Math.min(1, x));
        const S = cl((b - l) * a + 0.5) * scale;
        const M = cl((l - b) * a + 0.5) * cl((1 - l - b) * a + 0.5) * scale;
        const H = cl((l + b - 1) * a + 0.5) * scale;
        return S + M + H;
    }

    // ---------------------------------------------------------------------
    // 1e. KEYFRAME cho thông số màu — thông số nào keyframe được, và vì sao
    // ---------------------------------------------------------------------
    //
    // Keyframe được lưu ngay trong `obj.keyframes` sẵn có, khoá tiền tố 'adj.' (ví dụ
    // 'adj.basic.exposure'). Kho đó là map {field: [{t,v,e}]} với khoá là chuỗi TUỲ Ý,
    // và `hasKeyframes()` của text-animations chỉ xét KEYFRAME_FIELDS (transform) nên
    // khoá màu không gây nhiễu. Undo/redo và .crab vì thế tự có, không cần code riêng.
    //
    // VÌ SAO CHỈ 3 THÔNG SỐ NÀY: bên FFmpeg, `eq` là filter màu DUY NHẤT nhận biểu thức
    // theo thời gian (`eval=frame`) — đã kiểm: brightness='t*0.2' cho Y ramp 147->246.
    // Các filter còn lại phải điều khiển bằng `sendcmd` (đã spike xong, xem tài liệu) hoặc
    // không đổi được lúc chạy:
    //     colorbalance / curves / gblur : có cờ T -> sendcmd (giai đoạn sau)
    //     lut3d(file) / unsharp / noise / vignette : KHÔNG đổi được -> không keyframe
    // Vì vậy Nhiệt độ/Tông màu/Vòng tròn màu/Đường cong/nhóm Độ sáng/Hiệu ứng/HSL/LUT
    // hiện KHOÁ nút hình thoi kèm tooltip, chứ không cho bấm rồi âm thầm không xuất ra.
    // `via` = cơ chế xuất:
    //   'eq'      -> biểu thức trong filter `eq` (mượt, rẻ, không sinh file)
    //   'sendcmd' -> file lệnh gửi vào `colorbalance` theo mốc thời gian
    const KEYFRAME_PARAMS = [
        { path: 'basic.exposure', label: 'Phơi sáng', via: 'eq' },
        { path: 'basic.contrast', label: 'Tương phản', via: 'eq' },
        { path: 'basic.saturation', label: 'Bão hoà', via: 'eq' },
        { path: 'basic.temperature', label: 'Nhiệt độ màu', via: 'sendcmd' },
        { path: 'basic.tint', label: 'Tông màu', via: 'sendcmd' },
        ...['lift', 'gamma', 'gain'].flatMap((wheel) => ['r', 'g', 'b'].map((ch) => ({
            path: `wheels.${wheel}.${ch}`,
            label: `${WHEEL_LABELS[wheel]} ${ch.toUpperCase()}`,
            via: 'sendcmd',
        }))),
        // NHÓM ĐỘ SÁNG đi qua filter `curves`, cũng bằng `sendcmd` nhưng giá trị lệnh là
        // CHUỖI ĐIỂM ĐIỀU KHIỂN chứ không phải một số -> cơ chế riêng ('curves'), xem
        // sendcmdText. ĐÃ ĐO (đừng lo lại): 600 mốc × 17 điểm = 157KB, ffmpeg chạy 0.25s
        // so với 0.22s khi đặt tĩnh, và Y đi 192→206→220→234→247 mượt.
        ...['highlights', 'shadows', 'whites', 'blacks', 'glow'].map((key) => ({
            path: `tone.${key}`,
            label: TONE_LABELS[key],
            via: 'curves',
        })),
        // CƯỜNG ĐỘ LUT: `lut3d` không có tham số trộn và không đổi được file lúc chạy, nên
        // đường duy nhất là tách dòng thành 2 nhánh rồi `blend=all_expr` pha theo T —
        // sidecar dựng đoạn graph đó (xem ColorAdjustLutBlend trong core_process.cpp).
        { path: 'lut.intensity', label: 'Cường độ LUT', via: 'lutmix' },
        // NHÓM HIỆU ỨNG — chỉ 2/5 thông số keyframe được, và đây là RÀNG BUỘC CỦA FFMPEG.
        // Đã đo cờ runtime của từng filter (`ffmpeg -h filter=...`, cột cờ có chữ `T`):
        //   avgblur  sizeX/sizeY/planes  CÓ `T`  -> "Làm mờ" đổi được bằng sendcmd
        //   vignette angle là BIỂU THỨC + có `eval=frame` -> "Viền mờ dần" đổi được theo `t`
        //   unsharp  KHÔNG có `T`, KHÔNG nhận biểu thức -> Làm sắc nét / Độ rõ nét: KHÔNG
        //   noise    KHÔNG có `T`, KHÔNG nhận biểu thức -> Hạt nhỏ: KHÔNG
        { path: 'effects.blur', label: 'Làm mờ', via: 'blur' },
        { path: 'effects.vignette', label: 'Viền mờ dần', via: 'vignette' },
    ];
    const KEYFRAME_PATHS = new Set(KEYFRAME_PARAMS.map((p) => p.path));
    const KEYFRAME_PREFIX = 'adj.';

    function canKeyframe(path) { return KEYFRAME_PATHS.has(String(path)); }
    function keyframeFieldName(path) { return KEYFRAME_PREFIX + path; }

    function getAdjustParam(adj, path) {
        const parts = String(path).split('.');
        let node = adj;
        for (const key of parts) {
            if (!node || typeof node !== 'object') return undefined;
            node = node[key];
        }
        return node;
    }

    function setAdjustParam(adj, path, value) {
        const parts = String(path).split('.');
        let node = adj;
        for (let i = 0; i < parts.length - 1; i += 1) {
            if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
            node = node[parts[i]];
        }
        node[parts[parts.length - 1]] = value;
    }

    // Bản adjustments với các thông số CÓ keyframe được thay bằng giá trị nội suy tại t.
    // evalFn = TextAnimations.evalKeyframeField (truyền vào để module này không phụ thuộc
    // text-animations, và để test Node gọi được).
    function effectiveAdjustments(raw, keyframes, t, evalFn) {
        const adj = normalize(raw);
        if (!keyframes || typeof keyframes !== 'object' || typeof evalFn !== 'function') return adj;
        KEYFRAME_PARAMS.forEach((param) => {
            const list = keyframes[keyframeFieldName(param.path)];
            if (!Array.isArray(list) || !list.length) return;
            const v = evalFn(list, t);
            if (v != null && Number.isFinite(v)) setAdjustParam(adj, param.path, v);
        });
        return adj;
    }

    function hasAdjustKeyframes(keyframes, via) {
        if (!keyframes || typeof keyframes !== 'object') return false;
        return KEYFRAME_PARAMS.some((p) => {
            if (via && p.via !== via) return false;
            const list = keyframes[keyframeFieldName(p.path)];
            return Array.isArray(list) && list.length > 0;
        });
    }

    // ---- KEYFRAME qua `sendcmd` (Nhiệt độ / Tông màu / 3 Vòng tròn màu) ----
    //
    // `colorbalance` KHÔNG nhận biểu thức, nhưng 9 tham số của nó có cờ `T` nên đổi được
    // lúc chạy bằng `sendcmd`. Đã spike: lệnh chạy đúng, và trục thời gian là 0-BASED sau
    // `setpts=PTS-STARTPTS` — trùng luôn thời gian cục bộ của keyframe nên không phải quy đổi.
    //
    // VÌ SAO PHẢI SINH CẢ 9 THAM SỐ: colorbalanceParams() TRỘN temperature/tint với 3 vòng
    // tròn màu rồi mới ra rs..bh. Chỉ cần MỘT trong 11 đầu vào có keyframe là cả 9 đầu ra
    // biến thiên, nên mỗi mốc thời gian phải gửi đủ 9 lệnh.
    const CB_KEYS = ['rs', 'gs', 'bs', 'rm', 'gm', 'bm', 'rh', 'gh', 'bh'];

    // Nhãn của instance colorbalance — lệnh sendcmd trỏ tới nó. Phải DUY NHẤT trong cả
    // filtergraph, nên caller truyền vào theo block (chỉ số clip / id item).
    function sanitizeFilterLabel(value) {
        return String(value || 'cb').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40) || 'cb';
    }

    // Sinh nội dung file lệnh `sendcmd`. Trả '' nếu không có keyframe loại sendcmd.
    //
    // BỎ MỐC TRÙNG: chỉ ghi lệnh khi giá trị THỰC SỰ đổi so với mốc trước (làm tròn 4 chữ
    // số). Keyframe thường chỉ chiếm một đoạn ngắn của clip; không lọc thì clip 60s ở 30fps
    // sinh 16 nghìn dòng vô ích.
    // NHÓM ĐỘ SÁNG đi cùng file lệnh này nhưng KHÁC cơ chế: giá trị gửi cho `curves` là cả
    // CHUỖI ĐIỂM ĐIỀU KHIỂN (17 điểm), phải bọc trong nháy đơn. Đã spike bằng ffmpeg thật:
    // `0.8 curves@tc all '0/0 0.5/0.8 1/1';` làm xám 128 -> 204 đúng lúc, và 600 mốc chỉ
    // tốn 157KB + 0.03s. Vì thế KHÔNG giảm mật độ mốc: cứ mỗi frame một mốc như
    // colorbalance, để preview và bản xuất khớp từng frame.
    function sendcmdText(raw, keyframes, evalFn, options = {}) {
        const wantCb = hasAdjustKeyframes(keyframes, 'sendcmd');
        const wantTone = hasAdjustKeyframes(keyframes, 'curves');
        const wantBlur = hasAdjustKeyframes(keyframes, 'blur');
        if ((!wantCb && !wantTone && !wantBlur) || typeof evalFn !== 'function') return '';
        const label = sanitizeFilterLabel(options.label);
        const toneLabel = sanitizeFilterLabel(options.toneLabel || `tone_${label}`);
        const blurLabel = sanitizeFilterLabel(options.blurLabel || `blur_${label}`);
        // Bán kính mờ phụ thuộc CHIỀU CAO KHUNG (mọi bán kính khai theo tỉ lệ), nên file lệnh
        // phải biết chiều cao stream mà filter chạy trên đó — truyền sai là bản xuất mờ khác preview.
        const frameHeight = Math.max(1, Number(options.frameHeight) || 1080);
        const fps = Math.max(1, Math.min(120, Number(options.fps) || 30));
        const duration = Math.max(0.05, Number(options.duration) || 1);
        const frames = Math.max(1, Math.round(duration * fps));
        const lines = [];
        let prevCb = null;
        let prevTone = null;
        let prevBlur = null;
        for (let i = 0; i <= frames; i += 1) {
            const t = Math.min(duration, i / fps);
            const eff = effectiveAdjustments(raw, keyframes, t, evalFn);
            const stamp = t.toFixed(4);
            if (wantCb) {
                const cb = colorbalanceParams(eff);
                const values = CB_KEYS.map((k) => cb[k].toFixed(4));
                const sig = values.join(',');
                if (sig !== prevCb) {
                    prevCb = sig;
                    CB_KEYS.forEach((k, idx) => lines.push(`${stamp} colorbalance@${label} ${k} ${values[idx]};`));
                }
            }
            if (wantTone) {
                // toneCurvePoints trả null khi tone = identity -> gửi đường chéo để filter
                // (đang bị force phát) trở về không tác dụng, chứ không bỏ lệnh: bỏ thì nó
                // giữ nguyên đường cong của mốc trước.
                const pts = toneCurvePoints(eff) || defaultCurve();
                const sig = curvePointsString(pts);
                if (sig !== prevTone) {
                    prevTone = sig;
                    lines.push(`${stamp} curves@${toneLabel} all '${sig}';`);
                }
            }
            if (wantBlur) {
                // radius = 0 -> planes=0 (identity tuyệt đối, đã đo) chứ KHÔNG hạ sizeX về 1.
                const fx = effectsSpec(eff, frameHeight);
                const radius = fx.blur ? fx.blur.radius : 1;
                const planes = fx.blur ? 15 : 0;
                const cascade = fx.blur ? fx.blur.cascade : BLUR_CASCADE;
                const sig = `${radius}/${planes}/${cascade}`;
                if (sig !== prevBlur) {
                    prevBlur = sig;
                    for (let c = 0; c < cascade; c += 1) {
                        lines.push(`${stamp} avgblur@${blurLabel}${c} sizeX ${radius};`);
                        lines.push(`${stamp} avgblur@${blurLabel}${c} sizeY ${radius};`);
                        lines.push(`${stamp} avgblur@${blurLabel}${c} planes ${planes};`);
                    }
                }
            }
        }
        return lines.length ? `${lines.join('\n')}\n` : '';
    }

    // Biểu thức góc cho HAI instance `vignette` khi "Viền mờ dần" có keyframe.
    // `angle` nhận biểu thức và có `eval=frame` nên animate trực tiếp được; `mode` thì không
    // đổi được lúc chạy, nên tách phần DƯƠNG (mode=forward, tối viền) và phần ÂM
    // (mode=backward, sáng viền) thành hai instance — chiều không dùng có angle = 0 và đã đo
    // là identity tuyệt đối. Quy đổi giữ ĐÚNG effectsSpec: angle = |v|/100 × VIGNETTE_MAX_ANGLE.
    function vignetteKeyframeExprs(raw, keyframes, exprFn) {
        if (!hasAdjustKeyframes(keyframes, 'vignette') || typeof exprFn !== 'function') return null;
        const list = keyframes[keyframeFieldName('effects.vignette')];
        const e = Array.isArray(list) && list.length ? exprFn(list) : '';
        if (!e) return null;
        const k = (VIGNETTE_MAX_ANGLE / 100).toFixed(8);
        return {
            forward: `max(0,(${e}))*${k}`,
            backward: `max(0,-(${e}))*${k}`,
        };
    }

    // Biểu thức FFmpeg cho filter `eq` khi 3 thông số đó có keyframe.
    // exprFn = TextAnimations.keyframeFieldFfmpegExpr (sinh biểu thức chứa token LOCALT,
    // easing khớp preview). Trả null nếu không có keyframe nào trong 3 thông số.
    //
    // Quy đổi GIỮ ĐÚNG công thức của eqParams(), chỉ thay số bằng biểu thức:
    //     gain = pow(2, E/50) ; c = 1 + C/100
    //     contrast = c*gain ; brightness = 0.5*c*(gain-1) ; saturation = 1 + S/100
    function eqKeyframeExprs(raw, keyframes, exprFn) {
        // Chỉ xét keyframe của 3 thông số đi đường 'eq'. Xét chung mọi keyframe thì khi chỉ
        // có Nhiệt độ (đường sendcmd) được keyframe, hàm này vẫn phát ra một filter `eq` với
        // biểu thức HẰNG SỐ + eval=frame — vô ích và gây nhiễu khi đọc filtergraph.
        if (!hasAdjustKeyframes(keyframes, 'eq') || typeof exprFn !== 'function') return null;
        const adj = normalize(raw);
        const term = (path) => {
            const list = keyframes[keyframeFieldName(path)];
            if (Array.isArray(list) && list.length) {
                const e = exprFn(list);
                if (e) return `(${e})`;
            }
            return `(${Number(getAdjustParam(adj, path) || 0).toFixed(4)})`;
        };
        const E = term('basic.exposure');
        const C = term('basic.contrast');
        const S = term('basic.saturation');
        const gain = `pow(2,${E}/50)`;
        const c = `(1+${C}/100)`;
        return {
            contrast: `${c}*${gain}`,
            brightness: `0.5*${c}*(${gain}-1)`,
            saturation: `(1+${S}/100)`,
        };
    }

    // ---------------------------------------------------------------------
    // 1d. MẶT NẠ — hàm khoảng cách có dấu (SDF) dùng chung cho cả 4 hình
    // ---------------------------------------------------------------------
    //
    // MỘT công thức phục vụ tất cả: mỗi hình chỉ khác cách tính KHOẢNG CÁCH CÓ DẤU d
    // (âm = trong, dương = ngoài), rồi feather áp chung bằng smoothstep quanh d=0.
    // Nhờ vậy JS (bake PNG cho export) và GLSL (preview) chỉ là một công thức chép sang
    // hai ngôn ngữ, không phải hai cách dựng khác nhau.
    //
    // ĐƠN VỊ: làm việc trong hệ toạ độ lấy NỬA CHIỀU CAO khung làm 1 đơn vị, trục x nhân
    // thêm tỉ lệ khung. Nhờ vậy "Hình tròn" tròn thật trên khung 16:9, và mọi con số
    // không phụ thuộc độ phân giải.
    function maskIsActive(raw) {
        const m = (raw && raw.mask) || null;
        return !!(m && m.enabled);
    }

    function smoothstep01(edge0, edge1, x) {
        if (edge1 <= edge0) return x < edge0 ? 0 : 1;
        const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
        return t * t * (3 - 2 * t);
    }

    /* ---- SDF của NGÔI SAO và TIM (đơn vị: hình nội tiếp hộp [-1,1]²) ----
     *
     * Hai hình này không có công thức khoảng cách "gọn" như chữ nhật/ê-líp nên dùng bản
     * dựng sẵn của Inigo Quilez. Cả hai được viết ở hệ y HƯỚNG LÊN (đúng gốc của công
     * thức); caller truyền -py vào vì hệ của mặt nạ có v hướng XUỐNG — làm ngược thì sao
     * chúc mũi xuống và tim lộn ngược.
     *
     * Trả về khoảng cách trong hệ ĐƠN VỊ; caller nhân lại min(hw,hh) để ra khoảng cách
     * thế giới, đúng cách 'circle' đang xấp xỉ ê-líp. Feather vì thế cư xử như nhau ở
     * mọi hình. Bản GLSL trong MASK_MIX_SRC là BẢN CHÉP của hai hàm này — sửa một bên
     * PHẢI sửa bên kia (cùng giao kèo với phần còn lại của maskValueAt).
     */
    const STAR_INNER_RATIO = 0.45;   // độ "gầy" của sao 5 cánh, nhìn khớp CapCut nhất

    /* Sao 5 cánh của iq có đỉnh ở y=+1 nhưng 2 chân chỉ tới y=-cos36°=-0.809 -> hình
     * CAO 1.809 và tâm lệch lên +0.0955 so với gốc. Để nguyên thì sao nằm lệch hẳn lên
     * và chừa một dải trống dưới đáy vùng chọn (đã dựng thử thấy rõ). Dịch + co cho hình
     * lấp đúng hộp [-1,1]², giống cách CapCut đặt sao giữa khung chọn. */
    const STAR_Y_MID = (1 - 0.809016994375) / 2;      // tâm dọc thật của hình
    const STAR_FIT = 2 / (1 + 0.809016994375);        // hệ số co cho vừa hộp

    function sdStar5(x, y) {
        const k1x = 0.809016994375, k1y = -0.587785252292;
        const k2x = -k1x, k2y = k1y;
        let px = Math.abs(x) / STAR_FIT;
        let py = (y / STAR_FIT) + STAR_Y_MID;
        const d1 = 2 * Math.max(k1x * px + k1y * py, 0);
        px -= d1 * k1x; py -= d1 * k1y;
        const d2 = 2 * Math.max(k2x * px + k2y * py, 0);
        px -= d2 * k2x; py -= d2 * k2y;
        px = Math.abs(px);
        py -= 1;
        const bax = STAR_INNER_RATIO * (-k1y);
        const bay = STAR_INNER_RATIO * k1x - 1;
        const h = Math.min(1, Math.max(0, (px * bax + py * bay) / (bax * bax + bay * bay)));
        const ex = px - bax * h;
        const ey = py - bay * h;
        const s = (py * bax - px * bay) < 0 ? -1 : 1;
        return Math.hypot(ex, ey) * s * STAR_FIT;   // trả về hệ đơn vị đã co
    }

    // Tim của iq nằm gọn trong x∈[-1,1], y∈[0,1] (mũi ở dưới). Dịch/co để tâm hình về
    // gốc và vừa hộp [-1,1]² — nếu không, tim lệch hẳn xuống nửa dưới của vùng chọn.
    function sdHeart(x, y) {
        const px = Math.abs(x) * 0.75;
        const py = (y + 1) * 0.5 * 1.15;
        let d;
        if (py + px > 1) {
            d = Math.hypot(px - 0.25, py - 0.75) - Math.SQRT2 / 4;
        } else {
            const a = (px * px) + ((py - 1) * (py - 1));
            const t = 0.5 * Math.max(px + py, 0);
            const b = ((px - t) * (px - t)) + ((py - t) * (py - t));
            d = Math.sqrt(Math.min(a, b)) * ((px - py) < 0 ? -1 : 1);
        }
        return d / 0.575;   // bù lại phép co ở trên để d ~ khoảng cách trong hệ đơn vị
    }

    // Giá trị mặt nạ tại điểm (nx, ny) — toạ độ CHUẨN HOÁ 0..1 trên khung.
    // aspect = chiều rộng / chiều cao khung.
    function maskValueAt(mask, nx, ny, aspect) {
        return maskValueAtNorm(normalizeMask(mask), nx, ny, aspect);
    }

    /* Bản KHÔNG chuẩn hoá — dành cho VÒNG LẶP MỖI PIXEL.
     *
     * `maskValueAt` cũ chuẩn hoá ngay trong thân hàm, mà nó lại chuẩn hoá bằng
     * `normalize({mask})` = dựng CẢ bộ adjustments mặc định (basic/tone/effects/hsl/
     * wheels/curves/lut) rồi kẹp ~50 trường — cho TỪNG PIXEL. Bake mặt nạ 576×1024 vì
     * thế mất 428ms, và mặt nạ Video bake lại mỗi lần người dùng nhích thanh trượt nên
     * preview đứng hình. Chuẩn hoá MỘT LẦN ở caller rồi gọi hàm này: cùng kết quả, còn
     * lại đúng phần toán.
     * Caller PHẢI truyền `m` đã qua normalizeMask (không kiểm lại ở đây, đó là điểm mấu
     * chốt của tối ưu này). */
    /* MẶT NẠ ĐÃ "BIÊN DỊCH" — mọi thứ KHÔNG đổi theo pixel được tính TRƯỚC vòng lặp.
     *
     * `maskValueAtNorm` tính lại cos/sin của góc xoay, hw/hh, ngưỡng feather, bán kính bo
     * góc... cho TỪNG pixel. Với ảnh 1728×3072 (5,3 triệu pixel) đó là 5,3 triệu lần gọi
     * Math.cos/Math.sin cho một giá trị duy nhất — bake mất 392ms. Tách phần bất biến ra
     * đây rồi để `maskValueCompiled` chỉ còn đúng phần phụ thuộc toạ độ.
     *
     * Công thức GIỮ NGUYÊN từng bước của maskValueAtNorm (nó vẫn là bản tham chiếu, và
     * test đối chiếu hai bên) — đây thuần tuý là dời phép tính ra khỏi vòng lặp.
     */
    function compileMask(mask, aspect) {
        const m = normalizeMask(mask);
        const asp = Number(aspect) > 0 ? Number(aspect) : 1;
        const rad = (-m.rotation * Math.PI) / 180;
        const hw = Math.max(1e-4, m.width * asp);
        const hh = Math.max(1e-4, m.height);
        return {
            type: m.type,
            asp,
            cos: Math.cos(rad),
            sin: Math.sin(rad),
            cx: m.x * asp,
            cy: m.y,
            hw,
            hh,
            minHw: Math.min(hw, hh),
            round: (m.roundness / 100) * Math.min(hw, hh),
            feather: (m.feather / 100) * 0.5,
            invert: m.invert,
        };
    }

    function maskValueCompiled(c, nx, ny) {
        const u = (nx - 0.5) * 2 * c.asp - c.cx;
        const v = (ny - 0.5) * 2 - c.cy;
        const px = u * c.cos - v * c.sin;
        const py = u * c.sin + v * c.cos;
        let d;
        if (c.type === 'circle') {
            const qx = px / c.hw;
            const qy = py / c.hh;
            d = (Math.sqrt(qx * qx + qy * qy) - 1) * c.minHw;
        } else if (c.type === 'split') {
            d = py;
        } else if (c.type === 'filmstrip') {
            d = Math.abs(py) - c.hh;
        } else if (c.type === 'star') {
            d = sdStar5(px / c.hw, -py / c.hh) * c.minHw;
        } else if (c.type === 'heart') {
            d = sdHeart(px / c.hw, -py / c.hh) * c.minHw;
        } else {
            const qx = Math.abs(px) - (c.hw - c.round);
            const qy = Math.abs(py) - (c.hh - c.round);
            const ox = Math.max(qx, 0);
            const oy = Math.max(qy, 0);
            d = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - c.round;
        }
        let value = c.feather > 1e-5 ? 1 - smoothstep01(-c.feather, c.feather, d) : (d <= 0 ? 1 : 0);
        if (c.invert) value = 1 - value;
        return value;
    }

    function maskValueAtNorm(m, nx, ny, aspect) {
        const asp = Number(aspect) > 0 ? Number(aspect) : 1;
        // sang hệ tâm-khung, đơn vị = nửa chiều cao
        const u = (nx - 0.5) * 2 * asp - m.x * asp;
        const v = (ny - 0.5) * 2 - m.y;
        const rad = (-m.rotation * Math.PI) / 180;
        const px = u * Math.cos(rad) - v * Math.sin(rad);
        const py = u * Math.sin(rad) + v * Math.cos(rad);
        const hw = Math.max(1e-4, m.width * asp);
        const hh = Math.max(1e-4, m.height);

        let d;
        if (m.type === 'circle') {
            // SDF ellipse xấp xỉ: chuẩn hoá về hình cầu rồi nhân lại bán trục nhỏ.
            // Đủ chính xác cho việc feather và rẻ hơn nhiều so với SDF ellipse chính xác.
            const q = Math.hypot(px / hw, py / hh);
            d = (q - 1) * Math.min(hw, hh);
        } else if (m.type === 'split') {
            // Nửa mặt phẳng: chỉ dùng y và góc xoay; width/height không có nghĩa.
            d = py;
        } else if (m.type === 'filmstrip') {
            // Dải ngang: giữ phần |y| <= hh, feather ở hai mép.
            d = Math.abs(py) - hh;
        } else if (m.type === 'star') {
            // -py: SDF viết ở hệ y hướng lên, hệ mặt nạ có v hướng xuống
            d = sdStar5(px / hw, -py / hh) * Math.min(hw, hh);
        } else if (m.type === 'heart') {
            d = sdHeart(px / hw, -py / hh) * Math.min(hw, hh);
        } else {
            // Chữ nhật bo góc
            const r = (m.roundness / 100) * Math.min(hw, hh);
            const qx = Math.abs(px) - (hw - r);
            const qy = Math.abs(py) - (hh - r);
            const ox = Math.max(qx, 0);
            const oy = Math.max(qy, 0);
            d = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
        }
        // Feather tính theo nửa chiều cao khung -> độc lập độ phân giải.
        const f = (m.feather / 100) * 0.5;
        let value = f > 1e-5 ? 1 - smoothstep01(-f, f, d) : (d <= 0 ? 1 : 0);
        if (m.invert) value = 1 - value;
        return value;
    }

    // ---- HÌNH HỌC MẶT NẠ (dùng cho tay cầm trên preview) ----
    //
    // Ở ĐÂY chứ không ở editing-runtime.js: đường viền vẽ trên preview phải là ĐÚNG tập
    // d = 0 của SDF trong maskValueAt ở trên. Để hai thứ đó cạnh nhau thì sửa một bên là
    // thấy ngay bên kia; tách ra hai file là sớm muộn đường viền lệch khỏi vùng thật.
    // Hệ toạ độ giống maskValueAt: (u,v), 1 đơn vị = NỬA CHIỀU CAO khung, v hướng xuống.

    // Quay (x,y) theo CHIỀU KIM ĐỒNG HỒ deg độ (v hướng xuống) — đúng chiều mà m.rotation
    // xoay hình (maskValueAt quay ĐIỂM theo chiều ngược lại).
    function maskRotateCw(deg, x, y) {
        const r = (Number(deg) || 0) * Math.PI / 180;
        return { x: (x * Math.cos(r)) - (y * Math.sin(r)), y: (x * Math.sin(r)) + (y * Math.cos(r)) };
    }

    // Đường viền vùng mặt nạ trong hệ (u,v) LOCAL (chưa xoay, chưa dịch tâm).
    // "Tách" là nửa mặt phẳng và "Cuộn phim" là dải ngang -> đường MỞ, kéo dài ra ngoài
    // khung (chúng không có mép trái/phải).
    function maskOutlinePolys(rawMask, aspect) {
        const m = normalize({ mask: rawMask }).mask;
        const asp = Number(aspect) > 0 ? Number(aspect) : 1;
        const hw = Math.max(1e-4, m.width * asp);
        const hh = Math.max(1e-4, m.height);
        const FAR = 40;
        if (m.type === 'split') return [{ pts: [[-FAR, 0], [FAR, 0]], closed: false }];
        if (m.type === 'filmstrip') {
            return [
                { pts: [[-FAR, -hh], [FAR, -hh]], closed: false },
                { pts: [[-FAR, hh], [FAR, hh]], closed: false },
            ];
        }
        if (m.type === 'circle') {
            const pts = [];
            for (let i = 0; i < 72; i += 1) {
                const a = (i / 72) * Math.PI * 2;
                pts.push([Math.cos(a) * hw, Math.sin(a) * hh]);
            }
            return [{ pts, closed: true }];
        }
        /* Ngôi sao / Tim: KHÔNG viết lại đường bao bằng công thức riêng — DÒ chính SDF.
         * Hai hình này có công thức khoảng cách dài, chép thành đường bao thứ hai là sớm
         * muộn viền lệch khỏi vùng thật (đúng lý do khối hình học này nằm cạnh
         * maskValueAt). Cả hai đều "nhìn thấy toàn bộ biên từ tâm" nên bắn tia từ tâm ra
         * và chia đôi tìm chỗ SDF đổi dấu là đủ và luôn khớp.
         * Tia đi trong hệ ĐƠN VỊ của hình (đã chia hw/hh) rồi mới nhân lại — nếu dò trong
         * hệ (u,v) thì hình dẹt sẽ cho bước dò lệch giữa hai trục. */
        if (m.type === 'star' || m.type === 'heart') {
            const sd = m.type === 'star' ? sdStar5 : sdHeart;
            const pts = [];
            const STEPS = 96;
            for (let i = 0; i < STEPS; i += 1) {
                const a = (i / STEPS) * Math.PI * 2;
                const dx = Math.cos(a);
                const dy = Math.sin(a);
                // Biên luôn nằm trong bán kính 1.5 của hệ đơn vị; tìm khoảng đổi dấu
                let lo = 0;
                let hi = 1.5;
                if (sd(dx * hi, dy * hi) < 0) { pts.push([dx * hw * hi, -dy * hh * hi]); continue; }
                for (let k = 0; k < 22; k += 1) {
                    const mid = (lo + hi) / 2;
                    if (sd(dx * mid, dy * mid) <= 0) lo = mid; else hi = mid;
                }
                const r = (lo + hi) / 2;
                // -dy: SDF ở hệ y hướng lên, (u,v) có v hướng xuống (khớp maskValueAt)
                pts.push([dx * hw * r, -dy * hh * r]);
            }
            return [{ pts, closed: true }];
        }
        // Chữ nhật bo góc: bán kính lấy ĐÚNG công thức của maskValueAt (theo cạnh ngắn)
        const r = (m.roundness / 100) * Math.min(hw, hh);
        if (r <= 1e-6) return [{ pts: [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]], closed: true }];
        const ix = hw - r;
        const iy = hh - r;
        const pts = [];
        const arc = (cu, cv, from) => {
            for (let k = 0; k <= 8; k += 1) {
                const a = from + ((k / 8) * (Math.PI / 2));
                pts.push([cu + (Math.cos(a) * r), cv + (Math.sin(a) * r)]);
            }
        };
        arc(ix, -iy, -Math.PI / 2);
        arc(ix, iy, 0);
        arc(-ix, iy, Math.PI / 2);
        arc(-ix, -iy, Math.PI);
        return [{ pts, closed: true }];
    }

    // "Khung nguồn" sf = { cx, cy, ex, ey }: ex/ey là ảnh MÀN HÌNH của một đơn vị u/v.
    // Dùng vector thay vì (góc, tỉ lệ) để đỡ luôn cả LẬT và co giãn không đều — khi đó hình
    // mặt nạ đã xoay bị xiên, và sprite thật cũng xiên đúng như vậy.
    function maskPointToScreen(sf, u, v) {
        return { x: sf.cx + (sf.ex.x * u) + (sf.ey.x * v), y: sf.cy + (sf.ex.y * u) + (sf.ey.y * v) };
    }

    // Nghịch đảo: vector MÀN HÌNH -> (du,dv). Giải [ex ey]·(du,dv) = (dx,dy).
    // Trả null khi khung suy biến (block bị co về 0) — lúc đó không kéo được.
    function maskScreenDeltaToUv(sf, dx, dy) {
        const det = (sf.ex.x * sf.ey.y) - (sf.ey.x * sf.ex.y);
        if (Math.abs(det) < 1e-9) return null;
        return {
            u: ((dx * sf.ey.y) - (sf.ey.x * dy)) / det,
            v: ((sf.ex.x * dy) - (dx * sf.ex.y)) / det,
        };
    }

    /* Mặt nạ dạng CANVAS CÓ ALPHA — dùng cho preview: vẽ đè lên block bằng
     * `globalCompositeOperation = 'destination-in'` là block bị cắt đúng theo mặt nạ.
     *
     * VÌ SAO KHÔNG NHÉT VÀO CHUỖI SHADER như mặt nạ chỉnh màu: chuỗi đó chỉ chạy khi
     * block CÓ chỉnh màu, và nó là lượt trộn MÀU. Cắt hình chỉ cần nhân ALPHA — một phép
     * hợp canvas 2D làm được, không phải bật cả pipeline GLSL cho block không chỉnh gì.
     *
     * CACHE THEO CHỮ KÝ: vòng lặp SDF là mỗi pixel một lần, chạy lại mỗi khung hình thì
     * không thể phát mượt. Thông số mặt nạ đổi mới dựng lại; giữ nguyên thì tái dùng.
     * Chiều dài cạnh bị kẹp (MASK_ALPHA_MAX): mặt nạ là hàm TRƠN (SDF + feather) nên
     * phóng to lúc vẽ không thấy khác, mà dựng ở 4K thì mỗi lần chỉnh trượt là khựng.
     * 512 chứ không phải 1024: khung xem trước cao ~500px nên 1024 chẳng thêm chi tiết
     * nào mắt thấy được, trong khi chi phí là BÌNH PHƯƠNG cạnh — đo trên nguồn
     * 1728×3072 của dự án thật: 1024 mất ~30ms/lần đổi thông số (vượt ngưỡng 16.7ms của
     * một khung), 512 còn ~8ms. Bản XUẤT không đi qua đây mà qua renderMaskGray ở ĐÚNG
     * kích thước stream, nên hạ trần này không đụng tới chất lượng video ra.
     */
    const MASK_ALPHA_MAX = 512;
    // LRU chứ không phải MỘT ô: nhiều block cùng mang mặt nạ trên một khung thì cache 1 ô
    // bị hai bên đạp lẫn nhau và thành dựng lại MỖI block MỖI khung — đúng cái mà cache
    // sinh ra để tránh. 6 ô đủ cho số lớp thường thấy cùng lúc.
    const MASK_ALPHA_CACHE_MAX = 6;
    const maskAlphaCache = new Map();

    function renderMaskAlphaCanvas(mask, width, height) {
        if (typeof document === 'undefined') return null;
        const aspect = Math.max(1e-4, width / Math.max(1, height));
        const scale = Math.min(1, MASK_ALPHA_MAX / Math.max(width, height));
        const w = Math.max(2, Math.round(width * scale));
        const h = Math.max(2, Math.round(height * scale));
        const m = normalizeMask(mask);
        const sig = `${JSON.stringify(m)}|${w}x${h}|${aspect.toFixed(6)}`;
        const hit = maskAlphaCache.get(sig);
        if (hit) {
            maskAlphaCache.delete(sig);      // chạm vào -> đẩy về cuối (mới nhất)
            maskAlphaCache.set(sig, hit);
            return hit;
        }

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const img = ctx.createImageData(w, h);
        const data = img.data;
        const cm = compileMask(m, aspect);
        for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
                // aspect của KHUNG THẬT, không phải của canvas đã kẹp — nếu lấy w/h sau
                // khi kẹp thì hình tròn hoá ô-van khi mặt nạ bị thu nhỏ.
                const v = maskValueCompiled(cm, (x + 0.5) / w, (y + 0.5) / h);
                const i = ((y * w) + x) * 4;
                data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
                data[i + 3] = Math.max(0, Math.min(255, Math.round(v * 255)));
            }
        }
        ctx.putImageData(img, 0, 0);
        if (maskAlphaCache.size >= MASK_ALPHA_CACHE_MAX) {
            maskAlphaCache.delete(maskAlphaCache.keys().next().value);
        }
        maskAlphaCache.set(sig, canvas);
        return canvas;
    }

    // Bake mặt nạ thành ảnh XÁM (dùng cho export: alphamerge lấy alpha từ luma của ảnh
    // thứ hai, nên mặt nạ phải là ảnh xám chứ không phải PNG có alpha).
    function renderMaskGray(mask, width, height) {
        const w = Math.max(2, Math.round(width));
        const h = Math.max(2, Math.round(height));
        const out = new Uint8Array(w * h);
        const asp = w / h;
        const c = compileMask(mask, asp);   // MỘT lần cho cả ảnh, xem compileMask
        for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
                const v = maskValueCompiled(c, (x + 0.5) / w, (y + 0.5) / h);
                out[y * w + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
            }
        }
        return { width: w, height: h, gray: out };
    }

    // ---------------------------------------------------------------------
    // 3b. CÂN BẰNG TRẮNG — giải ra Nhiệt độ / Sắc thái từ một điểm đáng lẽ TRUNG TÍNH
    // ---------------------------------------------------------------------
    //
    // Người dùng bấm ống hút vào chỗ đáng lẽ là xám/trắng; ta cần tìm cặp
    // (temperature, tint) làm pixel đó trở thành trung tính.
    //
    // KHÔNG cần dò lặp — bài toán có NGHIỆM ĐÓNG. Vì temp/tint chỉ tác động ở bước
    // `colorbalance`, và ở đó chúng cộng đều vào cả 3 nhóm nên mỗi kênh chỉ bị dịch
    // thêm một lượng TUYẾN TÍNH:
    //     R' = baseR + dr·K ,  G' = baseG + dg·K ,  B' = baseB + db·K      (K = cbWeightSum)
    //     dr = t − 1.5·ti·(1/3)… cụ thể: dr = t − ti/2, dg = ti, db = −t − ti/2
    // Đặt A = baseR − baseG, B = baseB − baseG, u = t·K, v = ti·K rồi giải
    //     A + u − 1.5v = 0
    //     B − u − 1.5v = 0
    // => u = (B − A)/2 ,  v = (A + B)/3.
    //
    // MỐC CHUẨN LÀ "sau colorbalance", không phải "sau cả chuỗi": curves/HSL/LUT là lựa
    // chọn sáng tạo, có thể phá tính trung tính theo cách mà temp/tint không sửa được.
    // Cân bằng trắng theo nghĩa nhiếp ảnh là chỉnh ở khâu cân bằng màu, đúng như đây.
    //
    // Trả về {temperature, tint} đã kẹp ±100, hoặc null nếu điểm được chọn KHÔNG DÙNG
    // ĐƯỢC để cân bằng trắng.
    //
    // Điều kiện loại: pixel đã KẸP đen hoặc kẹp trắng. Vùng kẹp không còn thông tin màu
    // (mọi sắc lệch đã bị cắt mất) nên nghiệm sẽ ra 0 hoặc ra số vô nghĩa — phải nói cho
    // người dùng biết là chọn sai chỗ, thay vì im lặng đặt temp=tint=0 và trông như nút
    // bị hỏng. LƯU Ý: đừng dùng K≈0 làm điều kiện loại — ở đen tuyệt đối trọng số
    // shadows đạt CỰC ĐẠI (K=0.7), nên nhánh đó gần như không bao giờ chạy.
    const WB_CLIP_LOW = 0.06;
    const WB_CLIP_HIGH = 0.96;

    function solveWhiteBalance(raw, srcRgb) {
        const adj = normalize(raw);
        const maxCh = Math.max(srcRgb[0], srcRgb[1], srcRgb[2]);
        const minCh = Math.min(srcRgb[0], srcRgb[1], srcRgb[2]);
        if (maxCh < WB_CLIP_LOW || minCh > WB_CLIP_HIGH) return null;
        // 1) Cho pixel đi qua các bước ĐỨNG TRƯỚC colorbalance (eq + tone) bằng cách
        //    tắt hết những bước từ colorbalance trở đi.
        const pre = normalize(adj);
        pre.basic.temperature = 0;
        pre.basic.tint = 0;
        WHEEL_KEYS.forEach((k) => { pre.wheels[k] = { r: 0, g: 0, b: 0 }; });
        CURVE_CHANNELS.forEach((ch) => { pre.curves[ch] = defaultCurve(); });
        HSL_BANDS.forEach((band) => { pre.hsl[band.key] = { h: 0, s: 0, l: 0 }; });
        pre.lut = { id: '', name: '', intensity: 100 };
        pre.effects = defaultEffects();
        const c = applyToRgb(pre, srcRgb);

        // 2) base = sau colorbalance khi CHỈ có 3 vòng tròn màu (temp/tint = 0)
        const l = cbLightness(c[0], c[1], c[2]);
        const w = adj.wheels;
        const base = [
            cbComponent(c[0], l, w.lift.r / 100 * CB_WHEEL_GAIN, w.gamma.r / 100 * CB_WHEEL_GAIN, w.gain.r / 100 * CB_WHEEL_GAIN),
            cbComponent(c[1], l, w.lift.g / 100 * CB_WHEEL_GAIN, w.gamma.g / 100 * CB_WHEEL_GAIN, w.gain.g / 100 * CB_WHEEL_GAIN),
            cbComponent(c[2], l, w.lift.b / 100 * CB_WHEEL_GAIN, w.gamma.b / 100 * CB_WHEEL_GAIN, w.gain.b / 100 * CB_WHEEL_GAIN),
        ];

        const K = cbWeightSum(l);
        if (!(K > 1e-4)) return null;   // pixel quá tối/quá sáng: temp/tint gần như vô hiệu

        const A = base[0] - base[1];
        const B = base[2] - base[1];
        const t = ((B - A) / 2) / K;
        const ti = ((A + B) / 3) / K;

        const clamp100 = (v) => Math.max(-100, Math.min(100, v));
        return {
            temperature: Math.round(clamp100((t / CB_TEMP_GAIN) * 100)),
            tint: Math.round(clamp100((ti / CB_TINT_GAIN) * 100)),
        };
    }

    // ---------------------------------------------------------------------
    // 4. BƯỚC 3 — `curves` (natural cubic spline)
    // ---------------------------------------------------------------------
    //
    // Chép thuật toán interpolate() của libavfilter/vf_curves.c: natural cubic spline
    // (đạo hàm bậc 2 = 0 ở 2 biên), giải hệ ba đường chéo bằng quét tiến/lùi.
    // Nhờ dùng CÙNG thuật toán + CÙNG điểm điều khiển, đường cong preview và đường
    // cong FFmpeg dựng ra là một.
    function curveSecondDerivatives(pts) {
        const n = pts.length;
        const y2 = new Float64Array(n);
        const u = new Float64Array(n);
        for (let i = 1; i < n - 1; i++) {
            const x0 = pts[i - 1][0], x1 = pts[i][0], x2 = pts[i + 1][0];
            const y0 = pts[i - 1][1], y1 = pts[i][1], yy2 = pts[i + 1][1];
            const sig = (x1 - x0) / (x2 - x0);
            const p = sig * y2[i - 1] + 2;
            y2[i] = (sig - 1) / p;
            u[i] = (yy2 - y1) / (x2 - x1) - (y1 - y0) / (x1 - x0);
            u[i] = (6 * u[i] / (x2 - x0) - sig * u[i - 1]) / p;
        }
        for (let i = n - 2; i >= 0; i--) y2[i] = y2[i] * y2[i + 1] + u[i];
        return y2;
    }

    function evalCurveAt(pts, y2, x) {
        const n = pts.length;
        if (x <= pts[0][0]) return pts[0][1];
        if (x >= pts[n - 1][0]) return pts[n - 1][1];
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            const mid = (hi + lo) >> 1;
            if (pts[mid][0] > x) hi = mid; else lo = mid;
        }
        const h = pts[hi][0] - pts[lo][0];
        if (h <= 0) return pts[lo][1];
        const A = (pts[hi][0] - x) / h;
        const B = (x - pts[lo][0]) / h;
        const v = A * pts[lo][1] + B * pts[hi][1]
            + ((A * A * A - A) * y2[lo] + (B * B * B - B) * y2[hi]) * (h * h) / 6;
        return Math.max(0, Math.min(1, v));
    }

    // Bảng tra 256 mức cho 1 kênh (dùng cho shader và cho việc bake cube).
    function curveLut(points, size = 256) {
        const pts = normalizeCurve(points);
        const out = new Float32Array(size);
        if (curveIsIdentity(pts)) {
            for (let i = 0; i < size; i++) out[i] = i / (size - 1);
            return out;
        }
        const y2 = curveSecondDerivatives(pts);
        for (let i = 0; i < size; i++) out[i] = evalCurveAt(pts, y2, i / (size - 1));
        return out;
    }

    /* ĐƯỜNG DẪN NẰM BÊN TRONG FILTERGRAPH (`lut3d=file='…'`) — KHÁC hẳn đường dẫn đi
     * qua `-i` (chỗ đó chỉ là tham số dòng lệnh). Bộ phân tích filtergraph cắt tham số
     * theo dấu `:`, và nháy đơn KHÔNG che được `:` của Ổ ĐĨA trên Windows:
     * `lut3d=file='C:/a/b.cube':interp=trilinear` -> "No option name near
     * '/a/b.cube:interp=…'" -> MỌI block có LUT màu chết ở khâu xuất (macOS không lộ ra
     * vì đường dẫn POSIX không có `:`). Phải escape `:` thành `\:` NGAY TRONG cặp
     * nháy đơn — đã kiểm bằng ffmpeg thật: đổi sang đường dẫn sai thì nó báo "No such
     * file or directory" kèm đúng ổ đĩa, tức `C:` đã tới được filter.
     * Dùng CHUNG cho frontend (dựng chuỗi filter) và backend (ghép LUT thật vào chỗ
     * trống LUT3D_SLOT), nên hai đầu không thể lệch cách escape. */
    function filterPath(value) {
        return String(value)
            .replace(/\\/g, '/')
            .replace(/'/g, '')
            .replace(/:/g, '\\:');
    }

    // "0/0 0.5/0.6 1/1" — đúng cú pháp tham số của filter `curves`.
    function curvePointsString(points) {
        return normalizeCurve(points)
            .map(([x, y]) => `${x.toFixed(6).replace(/0+$/, '0')}/${y.toFixed(6).replace(/0+$/, '0')}`)
            .join(' ');
    }

    // ---------------------------------------------------------------------
    // 5. BƯỚC 4 — HSL 8 dải + LUT người dùng (gộp vào MỘT .cube)
    // ---------------------------------------------------------------------

    function rgbToHsl(r, g, b) {
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        const d = max - min;
        if (d < 1e-9) return [0, 0, l];
        const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        let h;
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
        return [h, s, l];
    }

    function hue2rgb(p, q, t) {
        let tt = t;
        if (tt < 0) tt += 1;
        if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
    }

    function hslToRgb(h, s, l) {
        if (s < 1e-9) return [l, l, l];
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const hk = ((h % 360) + 360) % 360 / 360;
        return [hue2rgb(p, q, hk + 1 / 3), hue2rgb(p, q, hk), hue2rgb(p, q, hk - 1 / 3)];
    }

    // Trọng số 8 dải tại một hue: nội suy MƯỢT (smoothstep) giữa 2 tâm dải kề nhau,
    // tổng luôn = 1. Cách này giống Lightroom: kéo 1 dải chỉ ảnh hưởng vùng màu của
    // nó và loang mềm sang 2 bên, không tạo viền cứng.
    function bandWeights(hue) {
        const n = HSL_BANDS.length;
        const w = new Array(n).fill(0);
        const h = ((hue % 360) + 360) % 360;
        for (let i = 0; i < n; i++) {
            const c0 = HSL_BANDS[i].hue;
            const c1 = HSL_BANDS[(i + 1) % n].hue + (i + 1 === n ? 360 : 0);
            let hh = h;
            if (hh < c0) hh += 360;
            if (hh >= c0 && hh <= c1 && c1 > c0) {
                const t = (hh - c0) / (c1 - c0);
                const st = t * t * (3 - 2 * t);
                w[i] = 1 - st;
                w[(i + 1) % n] = st;
                return w;
            }
        }
        w[0] = 1;
        return w;
    }

    const HSL_HUE_RANGE = 30;   // slider ±100 -> xoay tối đa ±30 độ
    const HSL_SAT_RANGE = 1.0;  // slider ±100 -> nhân bão hoà 0..2
    const HSL_LUM_RANGE = 0.5;  // slider ±100 -> dịch độ sáng ±0.5 (theo hướng trần/sàn)

    // Áp HSL 8 dải cho 1 màu RGB (0..1). Hàm THUẦN — shader GLSL bên dưới lặp lại
    // đúng công thức này; bake cube cũng gọi chính hàm này.
    function applyHsl(rgb, adj) {
        const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
        if (s < 1e-6) return rgb;             // xám tuyệt đối -> HSL không có nghĩa
        const w = bandWeights(h);
        let dh = 0, ds = 0, dl = 0;
        for (let i = 0; i < HSL_BANDS.length; i++) {
            const wi = w[i];
            if (wi <= 0) continue;
            const band = adj.hsl[HSL_BANDS[i].key];
            dh += wi * band.h;
            ds += wi * band.s;
            dl += wi * band.l;
        }
        // Bão hoà của dải càng thấp thì tác động càng nhẹ (tránh làm bẩn vùng gần xám)
        const strength = Math.min(1, s * 2);
        const nh = h + (dh / 100) * HSL_HUE_RANGE * strength;
        const ns = Math.max(0, Math.min(1, s * (1 + (ds / 100) * HSL_SAT_RANGE * strength)));
        const dlv = (dl / 100) * HSL_LUM_RANGE * strength;
        const nl = Math.max(0, Math.min(1, dlv >= 0 ? l + (1 - l) * dlv : l + l * dlv));
        return hslToRgb(nh, ns, nl);
    }

    // --- .cube (Adobe/IRIDAS 3D LUT) ---

    function parseCube(text) {
        const lines = String(text || '').split(/\r?\n/);
        let size = 0;
        let domainMin = [0, 0, 0];
        let domainMax = [1, 1, 1];
        const values = [];
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const upper = line.toUpperCase();
            if (upper.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
            if (upper.startsWith('LUT_1D_SIZE')) throw new Error('LUT 1D chưa được hỗ trợ, cần .cube 3D');
            if (upper.startsWith('TITLE')) continue;
            if (upper.startsWith('DOMAIN_MIN')) { domainMin = line.split(/\s+/).slice(1, 4).map(Number); continue; }
            if (upper.startsWith('DOMAIN_MAX')) { domainMax = line.split(/\s+/).slice(1, 4).map(Number); continue; }
            const parts = line.split(/\s+/);
            if (parts.length < 3) continue;
            const r = Number(parts[0]), g = Number(parts[1]), b = Number(parts[2]);
            if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
            values.push(r, g, b);
        }
        if (!Number.isFinite(size) || size < 2 || size > 129) throw new Error('LUT_3D_SIZE không hợp lệ');
        if (values.length !== size * size * size * 3) {
            throw new Error(`Số dòng dữ liệu LUT sai: cần ${size ** 3}, có ${values.length / 3}`);
        }
        return { size, data: Float32Array.from(values), domainMin, domainMax };
    }

    // Chỉ số phẳng trong .cube: r chạy NHANH NHẤT, rồi g, rồi b.
    function cubeIndex(size, ri, gi, bi) { return ((bi * size + gi) * size + ri) * 3; }

    function sampleCubeTrilinear(cube, rgb) {
        const n = cube.size;
        const pos = [0, 0, 0];
        const i0 = [0, 0, 0];
        const f = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
            const v = Math.max(0, Math.min(1, rgb[c])) * (n - 1);
            pos[c] = v;
            i0[c] = Math.min(n - 2, Math.floor(v));
            f[c] = v - i0[c];
        }
        const out = [0, 0, 0];
        for (let corner = 0; corner < 8; corner++) {
            const dr = corner & 1, dg = (corner >> 1) & 1, db = (corner >> 2) & 1;
            const w = (dr ? f[0] : 1 - f[0]) * (dg ? f[1] : 1 - f[1]) * (db ? f[2] : 1 - f[2]);
            if (w <= 0) continue;
            const idx = cubeIndex(n, i0[0] + dr, i0[1] + dg, i0[2] + db);
            out[0] += w * cube.data[idx];
            out[1] += w * cube.data[idx + 1];
            out[2] += w * cube.data[idx + 2];
        }
        return out;
    }

    const BAKE_CUBE_SIZE = 33;

    // Bake HSL 8 dải ∘ LUT người dùng (đã pha theo intensity) thành MỘT .cube.
    // userCube = kết quả parseCube() hoặc null.
    // options.lutMix: ép tỉ lệ pha LUT (0..1) thay cho adj.lut.intensity. Dùng để bake HAI
    // CUBE THÀNH PHẦN khi Cường độ LUT có keyframe: 0 = chỉ HSL, 1 = HSL + LUT hết mức.
    function bakeCube(raw, userCube, size = BAKE_CUBE_SIZE, options = {}) {
        const adj = normalize(raw);
        const n = Math.max(2, Math.min(65, size | 0));
        const data = new Float32Array(n * n * n * 3);
        const hasLut = !!(adj.lut.id && userCube);
        const mix = Number.isFinite(options.lutMix)
            ? (hasLut ? Math.max(0, Math.min(1, options.lutMix)) : 0)
            : (hasLut ? adj.lut.intensity / 100 : 0);
        for (let bi = 0; bi < n; bi++) {
            for (let gi = 0; gi < n; gi++) {
                for (let ri = 0; ri < n; ri++) {
                    let rgb = [ri / (n - 1), gi / (n - 1), bi / (n - 1)];
                    rgb = applyHsl(rgb, adj);
                    if (mix > 0) {
                        const lutted = sampleCubeTrilinear(userCube, rgb);
                        rgb = [
                            rgb[0] + (lutted[0] - rgb[0]) * mix,
                            rgb[1] + (lutted[1] - rgb[1]) * mix,
                            rgb[2] + (lutted[2] - rgb[2]) * mix,
                        ];
                    }
                    const idx = cubeIndex(n, ri, gi, bi);
                    data[idx] = Math.max(0, Math.min(1, rgb[0]));
                    data[idx + 1] = Math.max(0, Math.min(1, rgb[1]));
                    data[idx + 2] = Math.max(0, Math.min(1, rgb[2]));
                }
            }
        }
        return { size: n, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
    }

    // --- Kho LUT người dùng + cache bake ---
    //
    // Bake 1 cube 33³ = 36k lần applyHsl (~30-60ms) — QUÁ CHẬM để chạy mỗi frame
    // preview. Vì vậy: cache theo CHỮ KÝ của riêng phần HSL+LUT (các subtab khác đổi
    // không làm mất cache), giữ tối đa CUBE_CACHE_MAX bảng gần nhất.
    const userLuts = new Map();          // id -> cube đã parse
    const cubeCache = new Map();         // signature -> cube đã bake
    const CUBE_CACHE_MAX = 24;

    // Số lần LUT người dùng được (re-)đăng ký. TĂNG mỗi lần registerUserLut -> mọi
    // cache theo lutStageSignature tự nạp lại đúng lúc nội dung .cube về tới. Đây là
    // chốt chặn cho lỗi "chọn LUT xong preview đứng yên tới khi kéo cường độ":
    // trước đây chữ ký chỉ phụ thuộc hsl|lut.id|intensity — KHÔNG đổi khi file .cube
    // tải xong (id vẫn y cũ) nên texture 3D LUT bị giữ nguyên là bảng cũ.
    let lutRevision = 0;

    function registerUserLut(id, cube) {
        if (!id || !cube) return;
        userLuts.set(String(id), cube);
        cubeCache.clear();               // LUT mới có thể trùng id cũ -> bỏ cache
        lutRevision += 1;
    }

    function getUserLut(id) { return userLuts.get(String(id)) || null; }
    function hasUserLut(id) { return userLuts.has(String(id)); }

    // Chữ ký của phần đi qua lut3d (HSL 8 dải + LUT). Dùng làm key cache VÀ làm tên
    // file .cube phía backend -> 2 block cùng thông số dùng chung 1 file.
    // lutRevision giúp chữ ký ĐỔI ngay khi nội dung .cube mới (re-)đăng ký — buộc
    // các cache texture (ClipColorAdjustFilter, CanvasColorRenderer) tự nạp lại.
    function lutStageSignature(raw) {
        const a = normalize(raw);
        const hsl = HSL_BANDS.map((band) => {
            const s = a.hsl[band.key];
            return `${s.h}/${s.s}/${s.l}`;
        }).join(',');
        return `${hsl}|${a.lut.id}|${a.lut.intensity}|r${lutRevision}`;
    }

    // Bake 2 CUBE THÀNH PHẦN dùng cho Cường độ LUT: A = chỉ HSL, B = HSL + LUT hết mức.
    // Chữ ký của chúng KHÔNG chứa intensity nên cache không bị mất khi cường độ chạy.
    function bakeCubeComponent(adj, size, mix) {
        const key = `${size}|c${mix}|${lutStageSignature({ ...adj, lut: { ...adj.lut, intensity: 100 } })}`;
        const hit = cubeCache.get(key);
        if (hit) return hit;
        const cube = bakeCube(adj, getUserLut(adj.lut.id), size, { lutMix: mix });
        if (cubeCache.size >= CUBE_CACHE_MAX) cubeCache.delete(cubeCache.keys().next().value);
        cubeCache.set(key, cube);
        return cube;
    }

    // Trộn tuyến tính 2 cube TẠI TỪNG MẮT LƯỚI. Hợp lệ vì nội suy trilinear là phép TUYẾN
    // TÍNH: interp(mix(A,B,i)) = mix(interp(A), interp(B), i) — nên bản trộn ở đây và cách
    // export (2 nhánh lut3d rồi blend từng pixel) cho cùng kết quả.
    function mixCubes(cubeA, cubeB, i) {
        const n = cubeA.size;
        const data = new Float32Array(n * n * n * 3);
        for (let k = 0; k < data.length; k += 1) {
            data[k] = cubeA.data[k] + (cubeB.data[k] - cubeA.data[k]) * i;
        }
        return { size: n, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
    }

    function bakeCubeCached(raw, size = BAKE_CUBE_SIZE) {
        const adj = normalize(raw);
        if (!needsLut3d(adj)) return null;
        const key = `${size}|${lutStageSignature(adj)}`;
        const hit = cubeCache.get(key);
        if (hit) return hit;
        // CƯỜNG ĐỘ LUT NẰM GIỮA 0 và 100 (điển hình là khi nó có keyframe: mỗi frame một
        // giá trị mới, tức mỗi frame một chữ ký mới): bake lại từ đầu tốn ~16ms/frame —
        // preview sẽ rớt frame. Trộn 2 cube thành phần đã cache thì chỉ là 108k phép lerp
        // (~0.2ms) và cho ra ĐÚNG cùng con số, vì applyHsl không phụ thuộc intensity.
        const i = adj.lut.intensity / 100;
        const cube = (adj.lut.id && getUserLut(adj.lut.id) && i > 0 && i < 1)
            ? mixCubes(bakeCubeComponent(adj, size, 0), bakeCubeComponent(adj, size, 1), i)
            : bakeCube(adj, getUserLut(adj.lut.id), size);
        if (cubeCache.size >= CUBE_CACHE_MAX) cubeCache.delete(cubeCache.keys().next().value);
        cubeCache.set(key, cube);
        return cube;
    }

    // Hai cube thành phần dưới dạng NỘI DUNG .cube, để export dựng 2 nhánh lut3d rồi
    // `blend` pha giữa chúng theo thời gian. Trả null nếu block không có LUT người dùng
    // (không có LUT thì chẳng có gì để pha).
    function lutBlendCubes(raw, size = BAKE_CUBE_SIZE) {
        const adj = normalize(raw);
        if (!adj.lut.id || !getUserLut(adj.lut.id)) return null;
        return {
            a: cubeToText(bakeCubeComponent(adj, size, 0), 'CrabbyCut LUT mix A (HSL)'),
            b: cubeToText(bakeCubeComponent(adj, size, 1), 'CrabbyCut LUT mix B (HSL+LUT)'),
        };
    }

    // Biểu thức tỉ lệ pha LUT theo thời gian cho `blend=all_expr`. Kẹp [0,1] ngay trong
    // biểu thức: keyframe easing có thể vượt biên (overshoot) và blend không tự kẹp.
    // Biến thời gian của blend là T (chữ HOA) — sidecar tự thay LOCALT bằng (T-start).
    function lutMixKeyframeExpr(raw, keyframes, exprFn) {
        if (!hasAdjustKeyframes(keyframes, 'lutmix') || typeof exprFn !== 'function') return null;
        const list = keyframes[keyframeFieldName('lut.intensity')];
        const e = Array.isArray(list) && list.length ? exprFn(list) : '';
        if (!e) return null;
        return `clip((${e})/100,0,1)`;
    }

    function cubeToText(cube, title = 'CrabbyCut') {
        const lines = [`TITLE "${String(title).replace(/"/g, '')}"`, `LUT_3D_SIZE ${cube.size}`, ''];
        const n = cube.size;
        for (let bi = 0; bi < n; bi++) {
            for (let gi = 0; gi < n; gi++) {
                for (let ri = 0; ri < n; ri++) {
                    const i = cubeIndex(n, ri, gi, bi);
                    lines.push(`${cube.data[i].toFixed(6)} ${cube.data[i + 1].toFixed(6)} ${cube.data[i + 2].toFixed(6)}`);
                }
            }
        }
        return lines.join('\n') + '\n';
    }

    // 3D LUT -> ảnh 2D xếp lát (width = size*size, height = size) để nạp làm texture
    // WebGL1 (WebGL1 không có sampler3D). Lát thứ k = mặt phẳng blue = k.
    function cubeToTiledPixels(cube) {
        const n = cube.size;
        const width = n * n;
        const height = n;
        const px = new Uint8Array(width * height * 4);
        for (let bi = 0; bi < n; bi++) {
            for (let gi = 0; gi < n; gi++) {
                for (let ri = 0; ri < n; ri++) {
                    const src = cubeIndex(n, ri, gi, bi);
                    const x = bi * n + ri;
                    const y = gi;
                    const dst = (y * width + x) * 4;
                    px[dst] = Math.round(cube.data[src] * 255);
                    px[dst + 1] = Math.round(cube.data[src + 1] * 255);
                    px[dst + 2] = Math.round(cube.data[src + 2] * 255);
                    px[dst + 3] = 255;
                }
            }
        }
        return { width, height, pixels: px, size: n };
    }

    // ---------------------------------------------------------------------
    // 6. SINH CHUỖI FILTER FFMPEG (dùng ở sidecar C++ thông qua field payload,
    //    và ở đây để test/đối chiếu trong Node)
    // ---------------------------------------------------------------------
    //
    // Trả về MẢNG chuỗi filter theo đúng thứ tự chuỗi xử lý. lutPath = đường dẫn .cube
    // đã bake (do backend ghi ra đĩa); rỗng -> bỏ bước lut3d.
    //
    // LƯU Ý QUAN TRỌNG cho phía gọi: chuỗi này phải được chèn khi stream còn ở
    // KHÔNG GIAN MÀU NGUỒN (yuv), TRƯỚC bước format=rgba của pipeline biến đổi hình
    // học — vì `eq` chạy trên YUV, còn nếu chèn sau format=rgba thì FFmpeg sẽ tự
    // chuyển đổi qua lại và LÀM MẤT kênh alpha mà rotate/opacity đang cần.
    //
    // frameHeight: chiều cao khung khi RENDER — bắt buộc cho nhóm Hiệu ứng, vì bán kính
    // của unsharp/gblur tính theo pixel. Truyền sai thì bản xuất mờ/nét khác preview.
    //
    // options.skipEq: bỏ hẳn bước `eq` khỏi chuỗi. Dùng khi Phơi sáng/Tương phản/Bão hoà
    // CÓ KEYFRAME — lúc đó sidecar tự dựng `eq` từ biểu thức theo thời gian (xem
    // eqKeyframeExprs). Nếu không bỏ, sẽ có HAI filter eq nối nhau và ảnh bị chỉnh hai lần.
    // Token chỗ trống của lut3d trong chuỗi filter gửi cho backend. Chỉ gồm chữ và gạch
    // dưới nên đi qua được bộ lọc ký tự của backend nguyên vẹn.
    const LUT3D_SLOT = '__LUT3D__';

    function ffmpegFilters(raw, lutPath = '', frameHeight = 1080, options = {}) {
        const adj = normalize(raw);
        const out = [];
        const eq = eqParams(adj);
        if (!options.skipEq && !eqIsIdentity(eq)) {
            out.push(`eq=contrast=${eq.contrast.toFixed(6)}:brightness=${eq.brightness.toFixed(6)}:saturation=${eq.saturation.toFixed(6)}`);
        }
        // 3 bước sau chạy trong không gian RGB; để FFmpeg tự chèn phép đổi sang gbrp.
        // (Đã thử ép gbrp10le cho đỡ làm tròn: KHÔNG tốt hơn — swscale thêm dither khi
        //  hạ lại 8-bit ở cuối, đo ra còn tệ hơn 8-bit thẳng. Đừng làm lại.)
        const rgbStage = [];
        const cb = colorbalanceParams(adj);
        // options.cbLabel: đặt tên instance (`colorbalance@nhãn`) để `sendcmd` trỏ tới được.
        // options.forceColorbalance: BẮT BUỘC phát filter kể cả khi giá trị tĩnh = identity.
        // Cần thiết khi Nhiệt độ/Tông màu/Vòng tròn màu có KEYFRAME mà giá trị gốc đang là 0:
        // không phát thì sendcmd chẳng có filter nào để gửi lệnh tới, và keyframe im lặng
        // mất tác dụng.
        if (!colorbalanceIsIdentity(cb) || options.forceColorbalance) {
            const name = options.cbLabel ? `colorbalance@${sanitizeFilterLabel(options.cbLabel)}` : 'colorbalance';
            rgbStage.push(`${name}=` + CB_KEYS.map((k) => `${k}=${cb[k].toFixed(6)}`).join(':'));
        }
        // TONE CURVE — curves thứ 3, đặt TRƯỚC 2 curves của người dùng. Theo thứ tự
        // chuỗi xử lý: eq -> tone -> colorbalance -> curves(user) -> lut3d. Tone áp
        // trên kênh all nên dùng curves=all='...'. Phải là filter riêng (không gộp
        // với curves all của người dùng — xem chú thích gộp curves ở dưới).
        // options.toneLabel / options.forceTone: nhóm Độ sáng có KEYFRAME -> instance phải
        // CÓ TÊN để lệnh sendcmd trỏ tới, và phải phát kể cả khi giá trị tĩnh = identity
        // (không phát thì lệnh chẳng có filter nào để tới, keyframe im lặng mất tác dụng —
        // đúng bẫy đã gặp với colorbalance).
        const tonePts = toneCurvePoints(adj);
        if (tonePts || options.forceTone) {
            const name = options.toneLabel ? `curves@${sanitizeFilterLabel(options.toneLabel)}` : 'curves';
            rgbStage.push(`${name}=all='${curvePointsString(tonePts || defaultCurve())}'`);
        }
        // CURVES — phải tách làm HAI filter, đừng gộp thành `curves=all=..:r=..`.
        // Trong FFmpeg, tham số `all` KHÔNG nhân chồng lên r/g/b: nó chỉ là curve MẶC
        // ĐỊNH cho kênh nào không khai báo riêng. Người dùng thì hiểu theo kiểu
        // Photoshop/Resolve: kênh riêng xong rồi mới tới curve RGB tổng. Đo thực tế
        // (đầu vào xám 128, all: 0.5->0.7, r: 0.5->0.3): gộp 1 filter cho r=77 (chỉ
        // curve r), nối 2 filter cho r=117 (đúng cái người dùng thấy trên preview).
        const perChannel = ['r', 'g', 'b'].filter((ch) => !curveIsIdentity(adj.curves[ch]));
        if (perChannel.length) {
            rgbStage.push('curves=' + perChannel
                .map((ch) => `${ch}='${curvePointsString(adj.curves[ch])}'`).join(':'));
        }
        if (!curveIsIdentity(adj.curves.all)) {
            rgbStage.push(`curves=all='${curvePointsString(adj.curves.all)}'`);
        }
        if (lutPath) {
            // interp=trilinear để KHỚP với phép nội suy của shader preview
            // (mặc định của lut3d là tetrahedral -> lệch nhẹ ở vùng chuyển màu).
            rgbStage.push(`lut3d=file='${filterPath(lutPath)}':interp=trilinear`);
        } else if (options.lutSlot) {
            // CHỖ TRỐNG cho lut3d. Frontend không biết đường dẫn trên máy chủ (và cũng
            // không nên được quyền chỉ định file cho FFmpeg mở), nên backend mới là nơi
            // ghép `lut3d=file=...` vào. Trước đây backend NỐI VÀO CUỐI chuỗi -> lut3d
            // chạy SAU nhóm hiệu ứng trong khi preview áp TRƯỚC; đo được lệch tới 88/255
            // khi block có cả HSL/LUT lẫn hiệu ứng không gian (LUT sau vignette ≠ trước).
            // Có token thì backend thay ĐÚNG CHỖ, và thứ tự nằm ở MỘT nơi duy nhất là
            // hàm này.
            rgbStage.push(LUT3D_SLOT);
        }
        out.push(...rgbStage);

        // ------- NHÓM HIỆU ỨNG (không gian) — luôn nằm CUỐI chuỗi -------
        // Thứ tự cố định: Độ rõ nét -> Làm sắc nét -> Làm mờ -> Hạt -> Viền mờ.
        // Theo lối làm ảnh: tương phản cục bộ và độ nét là xử lý CHI TIẾT, còn mờ/hạt/
        // viền là hiệu ứng ỐNG KÍNH nên phải đặt sau cùng (đặt hạt trước khi làm nét là
        // nét luôn cả hạt -> nhiễu bị khuếch đại thành lốm đốm).
        const fx = effectsSpec(adj, frameHeight);
        // unsharp: chỉ tác động LUMA (chroma_amount=0, đúng mặc định của FFmpeg) — đã
        // kiểm: U/V giữ nguyên 128 sau khi lọc. Nhờ vậy làm nét không sinh viền màu.
        //
        // BẮT BUỘC ở YUV: `unsharp` cũng nhận gbrp, nhưng khi đó "luma_amount" áp vào
        // plane 0 = kênh G, còn ca=0 tắt luôn B và R -> chỉ làm nét MỘT kênh màu. Ép
        // yuv444p tường minh (thay vì để swscale tự chọn) để không bị lấy mẫu chroma
        // 4:2:0 ngay giữa chuỗi, và để kết quả không đổi theo phiên bản FFmpeg.
        if (fx.clarity || fx.sharpen) out.push('format=yuv444p');
        if (fx.clarity) {
            out.push(`unsharp=lx=${fx.clarity.msize}:ly=${fx.clarity.msize}`
                + `:la=${fx.clarity.amount.toFixed(4)}:ca=0`);
        }
        if (fx.sharpen) {
            out.push(`unsharp=lx=${fx.sharpen.msize}:ly=${fx.sharpen.msize}`
                + `:la=${fx.sharpen.amount.toFixed(4)}:ca=0`);
        }
        // LÀM MỜ dùng `avgblur` XẾP TẦNG, KHÔNG dùng `gblur`.
        //
        // Lý do: `gblur` là xấp xỉ Gauss ĐỆ QUY (IIR) — không thể tái tạo trong fragment
        // shader (đệ quy theo từng dòng). Dùng Gauss thật ở preview để "khớp gần gần"
        // thì lệch p95 ≈ 7/255 ở mọi sigma (đã đo ở 64/256/540px, steps=1..6), quá
        // ngưỡng ≤3/255 của panel này.
        // `avgblur` là trung bình HỘP chính xác (đo đáp ứng xung: sizeX=1 cho đúng
        // 255/9 mỗi tap), xếp tầng 3 lần cho dáng gần Gauss. Hộp thì shader tái tạo
        // được TUYỆT ĐỐI, nên preview và bản xuất khớp bằng dựng, không bằng may.
        // KEYFRAME "Làm mờ": instance phải CÓ TÊN để sendcmd trỏ tới, và phải phát kể cả khi
        // bán kính tĩnh = 0. Mốc 0 dùng `planes=0` — ĐÃ ĐO: đó là identity TUYỆT ĐỐI (max
        // 0/255), trong khi `sizeX=1` (giá trị nhỏ nhất hợp lệ) lệch tới 201/255 vì nó vẫn là
        // hộp 3 tap. Đừng "tối giản" bằng cách hạ sizeX xuống 1.
        if (options.blurLabel || options.forceBlur) {
            const name = `avgblur@${sanitizeFilterLabel(options.blurLabel || 'blur')}`;
            const radius = fx.blur ? fx.blur.radius : 1;
            const planes = fx.blur ? 15 : 0;
            const cascade = fx.blur ? fx.blur.cascade : BLUR_CASCADE;
            for (let i = 0; i < cascade; i += 1) {
                out.push(`${name}${i}=sizeX=${radius}:sizeY=${radius}:planes=${planes}`);
            }
        } else if (fx.blur) {
            const box = `avgblur=sizeX=${fx.blur.radius}:sizeY=${fx.blur.radius}`;
            for (let i = 0; i < fx.blur.cascade; i += 1) out.push(box);
        }
        // Hạt: allf=t = nhiễu ĐỔI THEO TỪNG FRAME (dáng hạt phim). Đây là chỗ DUY NHẤT
        // trong toàn bộ panel không thể WYSIWYG tuyệt đối — nhiễu là ngẫu nhiên nên
        // preview và bản xuất khớp CƯỜNG ĐỘ chứ không khớp từng hạt. Không phải bug.
        if (fx.grain) out.push(`noise=alls=${fx.grain.strength}:allf=t`);
        // KEYFRAME "Viền mờ dần": `angle` của vignette là BIỂU THỨC và có `eval=frame`, nên
        // animate được trực tiếp — không cần sendcmd. Nhưng `mode` (forward/backward) KHÔNG
        // đổi được lúc chạy, mà slider đi qua 0 là đổi chiều, nên phát CẢ HAI instance: mỗi
        // cái nhận phần dương/âm của biểu thức. Đã đo: angle=0 là identity tuyệt đối (max
        // 0/255) ở cả hai chiều, kể cả khi nối tiếp nhau -> chiều không dùng tự vô hiệu.
        if (options.vignetteExprs) {
            out.push(`vignette=angle='${options.vignetteExprs.forward}':mode=forward:eval=frame:dither=0`);
            out.push(`vignette=angle='${options.vignetteExprs.backward}':mode=backward:eval=frame:dither=0`);
        } else if (fx.vignette) {
            // ĐỪNG chèn format=gbrp ở đây để mong nó chạy trên RGB: đã thử, FFmpeg vẫn
            // đàm phán về YUV và cho ra kết quả y như cũ. `vignette` LUÔN nhân trên
            // plane dải hẹp — xem vignetteFactorToYuv() để biết công thức phải khớp.
            out.push(`vignette=angle=${fx.vignette.angle.toFixed(6)}`
                + `:mode=${fx.vignette.backward ? 'backward' : 'forward'}:dither=0`);
        }
        // CỔNG THỜI GIAN (options.enable) — dùng cho LỚP ĐIỀU CHỈNH khi nó chỉ phủ MỘT
        // PHẦN của block. `enable` là tuỳ chọn TIMELINE của libavfilter, phải gắn cho
        // TỪNG filter chứ không bọc được cả chuỗi — vì vậy nó nằm ở ĐÂY, nơi duy nhất
        // biết ranh giới giữa các filter. Ghép chuỗi rồi mới chèn là phải cắt chuỗi
        // bằng regex, kiểu gì cũng sai với `curves=all='...'`.
        // Đã đo: cả 8 filter đang dùng (eq, colorbalance, curves, lut3d, unsharp,
        // avgblur, vignette, noise) đều hỗ trợ timeline.
        // LUT3D_SLOT là chỗ trống backend thay bằng `lut3d=file=...` -> gắn enable vào
        // slot luôn, backend nối chuỗi nên phần enable đi theo.
        if (options.enable) {
            const g = String(options.enable);
            return out.map((f) => (f === LUT3D_SLOT ? `${LUT3D_SLOT}:enable='${g}'` : `${f}:enable='${g}'`));
        }
        return out;
    }

    /* Biểu thức `enable` cho một khoảng thời gian CỤC BỘ của block (giây).
     * Trả về '' khi khoảng phủ TRỌN block -> không phát enable, chuỗi rẻ hơn và không
     * phải lo sai số biên. */
    function enableBetween(from, to, duration) {
        const a = Math.max(0, Number(from) || 0);
        const b = Math.min(Number(duration) || 0, Number(to) || 0);
        if (!(b > a)) return null;                       // không phủ chút nào
        if (a <= 1e-4 && b >= (Number(duration) || 0) - 1e-4) return '';   // phủ trọn
        return `between(t,${a.toFixed(4)},${b.toFixed(4)})`;
    }

    // ---------------------------------------------------------------------
    // 7. GLSL — shader dùng chung cho PixiJS (lane chính) và WebGL canvas (overlay)
    // ---------------------------------------------------------------------
    //
    // Shader lặp lại ĐÚNG 4 bước ở trên. Điểm dễ sai nhất và đã xử lý:
    //   - `eq` chạy trên YUV nên shader phải RGB -> YUV (BT.709, dải hẹp 16-235 như
    //     video h264 nguồn) -> áp lut -> YUV -> RGB. Nếu áp thẳng trên RGB thì
    //     contrast/saturation sẽ LỆCH so với video xuất ra.
    //   - curves dùng bảng tra 256 mức dựng sẵn ở JS (cùng thuật toán spline với
    //     FFmpeg) truyền vào bằng texture 256x4 -> không phải giải spline trong shader.
    //   - lut3d dùng texture xếp lát + nội suy trilinear thủ công (WebGL1).

    const FRAGMENT_SRC = `
precision highp float;

varying vec2 vTextureCoord;
uniform sampler2D uSampler;

uniform float uEqOn;
uniform float uEqContrast;
uniform float uEqBrightness;
uniform float uEqSaturation;

uniform float uToneOn;

uniform float uCbOn;
uniform vec3 uCbShadows;
uniform vec3 uCbMidtones;
uniform vec3 uCbHighlights;

uniform float uCurveOn;
uniform sampler2D uCurveLut;   // 256 x 5 : hàng 0=all, 1=r, 2=g, 3=b, 4=tone

uniform float uLutOn;
uniform sampler2D uLut3d;      // ảnh xếp lát (size*size) x size
uniform float uLutSize;

// --- BT.709, dải hẹp (limited range) — khớp yuv420p của nguồn h264 ---
vec3 rgbToYuv(vec3 c) {
    float y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    float u = (c.b - y) / 1.8556;
    float v = (c.r - y) / 1.5748;
    // về thang plane 0..1 như FFmpeg thấy (Y: 16..235, UV: 16..240 quanh 128)
    return vec3(y * (219.0 / 255.0) + 16.0 / 255.0,
                u * (224.0 / 255.0) + 128.0 / 255.0,
                v * (224.0 / 255.0) + 128.0 / 255.0);
}

vec3 yuvToRgb(vec3 p) {
    float y = (p.x - 16.0 / 255.0) * (255.0 / 219.0);
    float u = (p.y - 128.0 / 255.0) * (255.0 / 224.0);
    float v = (p.z - 128.0 / 255.0) * (255.0 / 224.0);
    float r = y + 1.5748 * v;
    float b = y + 1.8556 * u;
    float g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
    return vec3(r, g, b);
}

// vf_eq.c create_lut(): v' = contrast*(v - 0.5) + 0.5 + brightness
float eqLut(float v, float contrast, float brightness) {
    return clamp(contrast * (v - 0.5) + 0.5 + brightness, 0.0, 1.0);
}

// vf_colorbalance.c get_component()
float cbComp(float v, float l, float s, float m, float h) {
    const float a = 4.0;
    const float b = 0.333;
    const float scale = 0.7;
    float S = s * clamp((b - l) * a + 0.5, 0.0, 1.0) * scale;
    float M = m * clamp((l - b) * a + 0.5, 0.0, 1.0) * clamp((1.0 - l - b) * a + 0.5, 0.0, 1.0) * scale;
    float H = h * clamp((l + b - 1.0) * a + 0.5, 0.0, 1.0) * scale;
    return clamp(v + S + M + H, 0.0, 1.0);
}

float curveAt(float v, float row) {
    float x = clamp(v, 0.0, 1.0) * (255.0 / 256.0) + (0.5 / 256.0);
    return texture2D(uCurveLut, vec2(x, (row + 0.5) / 5.0)).r;
}

vec3 sampleLut3d(vec3 c) {
    float n = uLutSize;
    vec3 v = clamp(c, 0.0, 1.0) * (n - 1.0);
    float b0 = floor(v.b);
    float b1 = min(b0 + 1.0, n - 1.0);
    float fb = v.b - b0;
    float w = n * n;
    // toạ độ trong 1 lát: x = ri, y = gi
    vec2 uv = vec2((v.r + 0.5) / w, (v.g + 0.5) / n);
    vec2 uv0 = uv + vec2(b0 * n / w, 0.0);
    vec2 uv1 = uv + vec2(b1 * n / w, 0.0);
    return mix(texture2D(uLut3d, uv0).rgb, texture2D(uLut3d, uv1).rgb, fb);
}

void main(void) {
    vec4 src = texture2D(uSampler, vTextureCoord);
    // Pixi truyền texture ĐÃ nhân alpha (premultiplied) -> phải bỏ nhân trước khi
    // chỉnh màu, nếu không vùng bán trong suốt sẽ bị sai màu, rồi nhân lại ở cuối.
    float a = src.a;
    vec3 c = a > 0.001 ? src.rgb / a : src.rgb;

    if (uEqOn > 0.5) {
        vec3 yuv = rgbToYuv(c);
        yuv.x = eqLut(yuv.x, uEqContrast, uEqBrightness);
        yuv.y = eqLut(yuv.y, uEqSaturation, 0.0);
        yuv.z = eqLut(yuv.z, uEqSaturation, 0.0);
        c = clamp(yuvToRgb(yuv), 0.0, 1.0);
    }

    // TONE CURVE — áp sau eq, trước colorbalance (hàng 4 của texture uCurveLut)
    if (uToneOn > 0.5) {
        c = vec3(curveAt(c.r, 4.0), curveAt(c.g, 4.0), curveAt(c.b, 4.0));
    }

    if (uCbOn > 0.5) {
        // l = max + min (thang 0..2) — đúng như vf_colorbalance truyền vào, xem cbLightness()
        float l = max(max(c.r, c.g), c.b) + min(min(c.r, c.g), c.b);
        c = vec3(
            cbComp(c.r, l, uCbShadows.r, uCbMidtones.r, uCbHighlights.r),
            cbComp(c.g, l, uCbShadows.g, uCbMidtones.g, uCbHighlights.g),
            cbComp(c.b, l, uCbShadows.b, uCbMidtones.b, uCbHighlights.b)
        );
    }

    if (uCurveOn > 0.5) {
        c = vec3(curveAt(c.r, 1.0), curveAt(c.g, 2.0), curveAt(c.b, 3.0));
        c = vec3(curveAt(c.r, 0.0), curveAt(c.g, 0.0), curveAt(c.b, 0.0));
    }

    if (uLutOn > 0.5) {
        c = sampleLut3d(c);
    }

    gl_FragColor = vec4(clamp(c, 0.0, 1.0) * a, a);
}
`;

    const VERTEX_SRC = `
attribute vec2 aPos;
varying vec2 vTextureCoord;
uniform float uFlipY;
void main(void) {
    vTextureCoord = vec2(aPos.x * 0.5 + 0.5, uFlipY > 0.5 ? 0.5 - aPos.y * 0.5 : aPos.y * 0.5 + 0.5);
    gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

    // Bảng tra curves 256x5 (RGBA8) cho texture. Hàng: 0=all, 1=r, 2=g, 3=b, 4=tone.
    // Hàng tone (4) áp SAU eq, TRƯỚC colorbalance/curves — đúng thứ tự ffmpegFilters.
    function curveLutPixels(raw) {
        const adj = normalize(raw);
        const px = new Uint8Array(256 * 5 * 4);
        CURVE_CHANNELS.forEach((ch, row) => {
            const lut = curveLut(adj.curves[ch], 256);
            for (let i = 0; i < 256; i++) {
                const dst = (row * 256 + i) * 4;
                const v = Math.round(lut[i] * 255);
                px[dst] = v; px[dst + 1] = v; px[dst + 2] = v; px[dst + 3] = 255;
            }
        });
        const tLut = toneLut(adj, 256);
        for (let i = 0; i < 256; i++) {
            const dst = (4 * 256 + i) * 4;
            const v = Math.round(tLut[i] * 255);
            px[dst] = v; px[dst + 1] = v; px[dst + 2] = v; px[dst + 3] = 255;
        }
        return { width: 256, height: 5, pixels: px };
    }

    // Giá trị uniform vô hướng (texture do lớp preview tự quản lý).
    function shaderUniforms(raw) {
        const adj = normalize(raw);
        const eq = eqParams(adj);
        const cb = colorbalanceParams(adj);
        const curveOn = CURVE_CHANNELS.some((ch) => !curveIsIdentity(adj.curves[ch]));
        const toneOn = !toneIsIdentity(adj.tone);
        return {
            uEqOn: eqIsIdentity(eq) ? 0 : 1,
            uEqContrast: eq.contrast,
            uEqBrightness: eq.brightness,
            uEqSaturation: eq.saturation,
            uToneOn: toneOn ? 1 : 0,
            uCbOn: colorbalanceIsIdentity(cb) ? 0 : 1,
            uCbShadows: [cb.rs, cb.gs, cb.bs],
            uCbMidtones: [cb.rm, cb.gm, cb.bm],
            uCbHighlights: [cb.rh, cb.gh, cb.bh],
            uCurveOn: curveOn ? 1 : 0,
            uLutOn: needsLut3d(adj) ? 1 : 0,
        };
    }

    // Áp toàn bộ chuỗi bằng JS thuần cho 1 màu RGB 0..1 — đây là BẢN THAM CHIẾU của
    // shader, dùng để test đối chiếu với FFmpeg.
    //
    // bakedCube = kết quả bakeCube() (HSL ∘ LUT người dùng đã gộp sẵn). Truyền vào thì
    // bước 4 lấy mẫu chính bảng đó — ĐÚNG như shader làm (shader nạp cube này thành
    // texture) và đúng như export làm (sidecar gọi lut3d với chính file này). Bỏ trống
    // thì tính HSL theo công thức giải tích; khi đó kết quả lệch nhẹ so với đường có
    // cube vì lưới 33³ nội suy trilinear — dùng cho chỗ nào chưa bake kịp.
    function applyToRgb(raw, rgb, bakedCube = null) {
        const adj = normalize(raw);
        let c = [rgb[0], rgb[1], rgb[2]];
        const eq = eqParams(adj);
        if (!eqIsIdentity(eq)) {
            const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            let yp = y * (219 / 255) + 16 / 255;
            let up = (c[2] - y) / 1.8556 * (224 / 255) + 128 / 255;
            let vp = (c[0] - y) / 1.5748 * (224 / 255) + 128 / 255;
            const lut = (v, ct, br) => Math.max(0, Math.min(1, ct * (v - 0.5) + 0.5 + br));
            yp = lut(yp, eq.contrast, eq.brightness);
            up = lut(up, eq.saturation, 0);
            vp = lut(vp, eq.saturation, 0);
            const yy = (yp - 16 / 255) * (255 / 219);
            const uu = (up - 128 / 255) * (255 / 224);
            const vv = (vp - 128 / 255) * (255 / 224);
            const r = yy + 1.5748 * vv;
            const b = yy + 1.8556 * uu;
            const g = (yy - 0.2126 * r - 0.0722 * b) / 0.7152;
            c = [r, g, b].map((x) => Math.max(0, Math.min(1, x)));
        }
        // TONE CURVE — áp sau eq, trước colorbalance (khớp thứ tự ffmpegFilters)
        if (!toneIsIdentity(adj.tone)) {
            const tLut = toneLut(adj);
            const at = (v) => tLut[Math.max(0, Math.min(255, Math.round(v * 255)))];
            c = c.map(at);
        }
        const cb = colorbalanceParams(adj);
        if (!colorbalanceIsIdentity(cb)) {
            const l = cbLightness(c[0], c[1], c[2]);
            c = [
                cbComponent(c[0], l, cb.rs, cb.rm, cb.rh),
                cbComponent(c[1], l, cb.gs, cb.gm, cb.gh),
                cbComponent(c[2], l, cb.bs, cb.bm, cb.bh),
            ];
        }
        if (CURVE_CHANNELS.some((ch) => !curveIsIdentity(adj.curves[ch]))) {
            const lutAll = curveLut(adj.curves.all);
            const luts = [curveLut(adj.curves.r), curveLut(adj.curves.g), curveLut(adj.curves.b)];
            const at = (lut, v) => lut[Math.max(0, Math.min(255, Math.round(v * 255)))];
            c = c.map((v, i) => at(lutAll, at(luts[i], v)));
        }
        if (needsLut3d(adj)) {
            c = bakedCube ? sampleCubeTrilinear(bakedCube, c) : applyHsl(c, adj);
        }
        return c.map((v) => Math.max(0, Math.min(1, v)));
    }

    // ---------------------------------------------------------------------
    // 7b. THAM CHIẾU JS CHO NHÓM HIỆU ỨNG (không gian)
    // ---------------------------------------------------------------------
    //
    // applyToRgb chỉ làm được phần màu (mỗi pixel độc lập). Nhóm Hiệu ứng cần cả ảnh,
    // nên phần tham chiếu của nó nằm ở đây: applyToImage() chạy ĐÚNG các phép mà shader
    // chạy, trên một buffer RGBA. Nhờ vậy test trong Node đối chiếu được với FFmpeg mà
    // không cần GPU, và probe Electron đối chiếu được shader với chính hàm này.

    const LUMA = [0.2126, 0.7152, 0.0722];

    function lumaOf(r, g, b) { return LUMA[0] * r + LUMA[1] * g + LUMA[2] * b; }

    // VIGNETTE — nhân hệ số f ĐÚNG NHƯ FFmpeg: trên PLANE dải hẹp, không phải trên RGB.
    //
    // Đo trên FFmpeg 8.1 (ảnh phẳng Y=147, U=90, V=180, f=0.2005):
    //     Y'=29  = round(147·f)              -> Y' = Y·f
    //     U'=119 ≈ round((90-128)·f+128)     -> U' = (U-128)·f + 128
    //     V'=137 ≈ round((180-128)·f+128)
    // Tức Y bị nhân KỂ CẢ sàn đen 16, nên góc khung tối nhanh hơn so với việc nhân RGB
    // (chênh đúng 16·(f−1) ≈ 18/255 ở góc). Đã thử ép `format=gbrp` để nó chạy trên RGB:
    // KHÔNG được, FFmpeg vẫn đàm phán về YUV. Vì vậy preview phải bắt chước đúng cách
    // này, không "làm cho đúng hơn".
    function vignetteFactorToRgb(r, g, b, f) {
        const y = lumaOf(r, g, b);
        const yp = (y * (219 / 255) + 16 / 255) * f;
        const up = ((b - y) / 1.8556 * (224 / 255)) * f + 128 / 255;
        const vp = ((r - y) / 1.5748 * (224 / 255)) * f + 128 / 255;
        const yy = (yp - 16 / 255) * (255 / 219);
        const uu = (up - 128 / 255) * (255 / 224);
        const vv = (vp - 128 / 255) * (255 / 224);
        const nr = yy + 1.5748 * vv;
        const nb = yy + 1.8556 * uu;
        const ng = (yy - 0.2126 * nr - 0.0722 * nb) / 0.7152;
        return [nr, ng, nb].map((v) => Math.max(0, Math.min(1, v)));
    }

    // Tích chập 1D tách trục trên một mặt phẳng float. horizontal=true -> theo trục x.
    // Biên: kẹp (clamp) — giống cách FFmpeg xử lý mép ảnh.
    function convolvePlane(src, w, h, kernel, horizontal) {
        const out = new Float32Array(w * h);
        const r = (kernel.length - 1) / 2;
        for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
                let sum = 0;
                for (let k = 0; k < kernel.length; k += 1) {
                    const d = k - r;
                    const xx = horizontal ? Math.min(w - 1, Math.max(0, x + d)) : x;
                    const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + d));
                    sum += kernel[k] * src[yy * w + xx];
                }
                out[y * w + x] = sum;
            }
        }
        return out;
    }

    // Mặt nạ mờ trên LUMA (đúng như unsharp của FFmpeg): tính luma, làm mờ bằng binomial
    // tách trục, rồi cộng phần chênh vào cả 3 kênh -> không sinh viền màu.
    function unsharpLuma(rgb, w, h, msize, amount) {
        const kernel = binomialKernel(msize);
        const luma = new Float32Array(w * h);
        for (let i = 0; i < w * h; i += 1) {
            luma[i] = lumaOf(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
        }
        const blurred = convolvePlane(convolvePlane(luma, w, h, kernel, true), w, h, kernel, false);
        for (let i = 0; i < w * h; i += 1) {
            const delta = amount * (luma[i] - blurred[i]);
            for (let c = 0; c < 3; c += 1) {
                rgb[i * 3 + c] = Math.max(0, Math.min(1, rgb[i * 3 + c] + delta));
            }
        }
    }

    // Áp TOÀN BỘ chuỗi (màu + không gian) lên một buffer RGB float phẳng (w*h*3, 0..1).
    // frameHeight mặc định = h vì bán kính khai theo tỉ lệ chiều cao khung.
    function applyToImage(raw, rgb, w, h, options = {}) {
        const adj = normalize(raw);
        const bakedCube = options.bakedCube || null;
        const frameHeight = options.frameHeight || h;
        // MẶT NẠ gate TOÀN BỘ phần chỉnh (màu + không gian) nên phải giữ ảnh gốc TỪ ĐẦU,
        // rồi trộn ở cuối — đúng như lượt `maskMix` của shader.
        const masked = maskIsActive(adj);
        const original = masked ? rgb.slice() : null;
        // 1) phần MÀU: từng pixel độc lập -> dùng chung applyToRgb
        for (let i = 0; i < w * h; i += 1) {
            const c = applyToRgb(adj, [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]], bakedCube);
            rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
        }
        // 2) phần KHÔNG GIAN, đúng thứ tự của ffmpegFilters
        const fx = effectsSpec(adj, frameHeight);
        if (fx.clarity) unsharpLuma(rgb, w, h, fx.clarity.msize, fx.clarity.amount);
        if (fx.sharpen) unsharpLuma(rgb, w, h, fx.sharpen.msize, fx.sharpen.amount);
        if (fx.blur) {
            // 3 lượt hộp tách trục — ĐÚNG cái `avgblur` xếp tầng làm ở export.
            const kernel = boxKernel(fx.blur.radius);
            for (let c = 0; c < 3; c += 1) {
                let plane = new Float32Array(w * h);
                for (let i = 0; i < w * h; i += 1) plane[i] = rgb[i * 3 + c];
                for (let pass = 0; pass < fx.blur.cascade; pass += 1) {
                    plane = convolvePlane(convolvePlane(plane, w, h, kernel, true), w, h, kernel, false);
                    // Lượng tử hoá 8-bit SAU MỖI lượt để MÔ HÌNH ĐÚNG shader: mỗi lượt
                    // ghi vào một render target RGBA8. (Không nhằm khớp FFmpeg — đã đo,
                    // thêm bước này không đổi sai số so với FFmpeg.)
                    for (let i = 0; i < w * h; i += 1) {
                        plane[i] = Math.round(Math.max(0, Math.min(1, plane[i])) * 255) / 255;
                    }
                }
                for (let i = 0; i < w * h; i += 1) rgb[i * 3 + c] = plane[i];
            }
        }
        // Hạt: KHÔNG mô phỏng ở đây (nhiễu ngẫu nhiên, không so khớp được với FFmpeg).
        // Test chỉ kiểm chuỗi filter có sinh ra `noise` hay không.
        if (fx.vignette) {
            const cx = w / 2;
            const cy = h / 2;
            // dmax = hypot(max(x0, w-x0), max(y0, h-y0)) — đúng công thức của FFmpeg.
            // Tâm là w/2, KHÔNG phải (w-1)/2 (mặc định x0="w/2"): dùng (w-1)/2 lệch
            // tới 5.5/255 ở góc khung.
            const dmax = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
            for (let y = 0; y < h; y += 1) {
                for (let x = 0; x < w; x += 1) {
                    const dnorm = Math.min(1, Math.hypot(x - cx, y - cy) / dmax);
                    const co = Math.cos(fx.vignette.angle * dnorm);
                    const f4 = co * co * co * co;
                    const f = fx.vignette.backward ? 1 / Math.max(1e-4, f4) : f4;
                    const i = y * w + x;
                    const out3 = vignetteFactorToRgb(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], f);
                    rgb[i * 3] = out3[0]; rgb[i * 3 + 1] = out3[1]; rgb[i * 3 + 2] = out3[2];
                }
            }
        }
        if (masked) {
            const asp = w / Math.max(1, h);
            for (let y = 0; y < h; y += 1) {
                for (let x = 0; x < w; x += 1) {
                    const m = maskValueAt(adj.mask, (x + 0.5) / w, (y + 0.5) / h, asp);
                    if (m >= 0.999) continue;
                    const i = (y * w + x) * 3;
                    for (let c = 0; c < 3; c += 1) {
                        rgb[i + c] = original[i + c] + (rgb[i + c] - original[i + c]) * m;
                    }
                }
            }
        }
        return rgb;
    }

    // ---------------------------------------------------------------------
    // 7c. NHÓM HIỆU ỨNG TRÊN GPU — hoạch định lượt + 3 chương trình GLSL
    // ---------------------------------------------------------------------
    //
    // Nhóm Hiệu ứng không thể nhét vào lượt màu (mỗi pixel cần đọc pixel lân cận), nên
    // preview chạy THÊM các lượt shader, MỖI LƯỢT tương ứng đúng một filter FFmpeg. Cách
    // dựng này giữ WYSIWYG bằng CẤU TRÚC: nếu ffmpegFilters đổi thì spatialPasses cũng
    // phải đổi theo, hai bên không thể lệch âm thầm.
    //
    // Số tap tối đa của một lượt tích chập. 33 phủ được binomial msize 23 (làm nét) và
    // hộp bán kính 16 (làm mờ). KHÔNG dùng `break` theo uniform trong vòng lặp GLSL ES
    // 1.0 (không chắc chắn giữa các driver) — thay vào đó luôn chạy 33 vòng và ĐỆM SỐ 0
    // vào các tap không dùng, tap giữa nằm ở chỉ số 16.
    const MAX_TAPS = 33;
    const TAP_CENTER = (MAX_TAPS - 1) / 2;

    // Trải hạt nhân vào mảng 33 phần tử, canh giữa.
    function padKernel(kernel) {
        const out = new Float32Array(MAX_TAPS);
        const half = (kernel.length - 1) / 2;
        for (let i = 0; i < kernel.length; i += 1) {
            const slot = TAP_CENTER + (i - half);
            if (slot >= 0 && slot < MAX_TAPS) out[slot] = kernel[i];
        }
        return out;
    }

    function hasSpatial(raw) {
        return !effectsIsIdentity(normalize(raw).effects);
    }

    // Cần chạy NHIỀU LƯỢT shader hay không: hiệu ứng không gian, hoặc có mặt nạ (mặt nạ
    // phải trộn kết quả đã chỉnh với ảnh NGUỒN nên tối thiểu 2 lượt).
    function needsMultiPass(raw) {
        return hasSpatial(raw) || maskIsActive(normalize(raw));
    }

    // "Rỗng hoàn toàn" — dùng để quyết định có XOÁ field adjustments hay không.
    // KHÁC isIdentity: có những thứ KHÔNG đổi một pixel nào (isIdentity = true) nhưng vẫn
    // là LỰA CHỌN CỦA NGƯỜI DÙNG, xoá đi là họ mất công đã bỏ ra:
    //   - mặt nạ đã bật nhưng chưa chỉnh màu;
    //   - BỘ LỌC (LUT) đã chọn nhưng cường độ đang để 0. Kéo cường độ về 0 là cách xem
    //     "trước/sau" nhanh nhất, mà bản cũ lại hiểu đó là rỗng rồi gỡ luôn LUT khỏi block:
    //     người dùng muốn kéo cường độ lên lại thì phải sang panel trái chọn LUT từ đầu
    //     (lỗi báo 2026-09-20). Gỡ LUT nay CHỈ xảy ra khi bấm nút "×" trên chip — một hành
    //     động rõ ràng, có chủ đích.
    // Cường độ 0 vẫn KHÔNG tốn gì lúc vẽ/xuất: mọi cửa nhanh đó xét isIdentity (không đổi).
    function isBlank(raw) {
        const a = normalize(raw);
        if (a.lut.id) return false;
        return isIdentity(a) && !maskIsActive(a);
    }

    // Danh sách lượt shader cần chạy SAU lượt màu, đúng thứ tự của ffmpegFilters.
    //   {op:'saveOriginal'}                       - ghim ảnh hiện tại lại để lượt trộn dùng
    //   {op:'conv', axis, weights, lumaOnly}      - tích chập 1D
    //   {op:'unsharpMix', amount}                 - orig + amount*(luma(orig) - lumaĐãMờ)
    //   {op:'pixelFx', grain, vignette}           - hạt + viền mờ, thuần từng pixel
    function spatialPasses(raw, frameHeight = 1080) {
        const fx = effectsSpec(raw, frameHeight);
        const ops = [];
        const pushUnsharp = (spec) => {
            const k = padKernel(binomialKernel(spec.msize));
            // Lượt x đọc ảnh MÀU rồi xuất LUMA đã mờ (dạng xám); lượt y tích chập tiếp
            // trên ảnh xám đó -> ra luma mờ 2D. Lượt trộn cần ảnh gốc nên phải ghim trước.
            ops.push({ op: 'saveOriginal' });
            ops.push({ op: 'conv', axis: 'x', weights: k, lumaOnly: true });
            ops.push({ op: 'conv', axis: 'y', weights: k, lumaOnly: true });
            ops.push({ op: 'unsharpMix', amount: spec.amount });
        };
        if (fx.clarity) pushUnsharp(fx.clarity);
        if (fx.sharpen) pushUnsharp(fx.sharpen);
        if (fx.blur) {
            const k = padKernel(boxKernel(fx.blur.radius));
            for (let i = 0; i < fx.blur.cascade; i += 1) {
                ops.push({ op: 'conv', axis: 'x', weights: k, lumaOnly: false });
                ops.push({ op: 'conv', axis: 'y', weights: k, lumaOnly: false });
            }
        }
        if (fx.grain || fx.vignette) {
            ops.push({
                op: 'pixelFx',
                grainStrength: fx.grain ? fx.grain.strength / 255 : 0,
                vignetteAngle: fx.vignette ? fx.vignette.angle : 0,
                vignetteBackward: !!(fx.vignette && fx.vignette.backward),
            });
        }
        // MẶT NẠ luôn ở lượt CUỐI: nó trộn toàn bộ kết quả đã chỉnh với ảnh nguồn, nên
        // phải chạy sau khi mọi bước màu và không gian đã xong.
        const adj = normalize(raw);
        if (maskIsActive(adj)) ops.push({ op: 'maskMix', mask: adj.mask });
        return ops;
    }

    // Vertex chung cho mọi lượt (tam giác phủ toàn khung).
    const PASS_VERTEX_SRC = `
attribute vec2 aPos;
varying vec2 vTextureCoord;
uniform float uFlipY;
void main(void) {
    vTextureCoord = vec2(aPos.x * 0.5 + 0.5, uFlipY > 0.5 ? 0.5 - aPos.y * 0.5 : aPos.y * 0.5 + 0.5);
    gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

    // Tích chập 1D. Nhân alpha vào trước khi cộng rồi chia lại ở cuối (premultiplied):
    // nếu cộng thẳng RGB thì mép bán trong suốt của overlay sẽ bị kéo màu của vùng rỗng
    // vào, tạo viền tối.
    const CONV_SRC = `
precision highp float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec2 uStep;
uniform float uWeights[${MAX_TAPS}];
uniform float uLumaOnly;
void main(void) {
    vec3 acc = vec3(0.0);
    float accA = 0.0;
    for (int i = 0; i < ${MAX_TAPS}; i++) {
        float w = uWeights[i];
        vec2 uv = vTextureCoord + uStep * (float(i) - ${TAP_CENTER.toFixed(1)});
        vec4 s = texture2D(uSampler, uv);
        acc += s.rgb * s.a * w;
        accA += s.a * w;
    }
    vec3 rgb = accA > 0.001 ? acc / accA : vec3(0.0);
    if (uLumaOnly > 0.5) {
        float y = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
        rgb = vec3(y);
    }
    gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), clamp(accA, 0.0, 1.0));
}
`;

    // Mặt nạ mờ: cộng phần chênh LUMA vào cả 3 kênh -> không sinh viền màu, khớp
    // chroma_amount=0 của `unsharp`.
    const UNSHARP_MIX_SRC = `
precision highp float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;     // luma đã mờ (dạng xám)
uniform sampler2D uOriginal;    // ảnh trước khi làm mờ
uniform float uAmount;
void main(void) {
    vec4 orig = texture2D(uOriginal, vTextureCoord);
    float blurred = texture2D(uSampler, vTextureCoord).r;
    float y = 0.2126 * orig.r + 0.7152 * orig.g + 0.0722 * orig.b;
    float delta = uAmount * (y - blurred);
    gl_FragColor = vec4(clamp(orig.rgb + delta, 0.0, 1.0), orig.a);
}
`;

    // Hạt + viền mờ dần. Viền mờ PHẢI nhân trên plane dải hẹp đúng như FFmpeg —
    // xem vignetteFactorToRgb() để biết vì sao không nhân thẳng vào RGB.
    const PIXEL_FX_SRC = `
precision highp float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec2 uResolution;
uniform float uGrain;
uniform float uVignetteAngle;
uniform float uVignetteBackward;
uniform float uSeed;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453);
}

void main(void) {
    vec4 src = texture2D(uSampler, vTextureCoord);
    vec3 c = src.rgb;

    if (uVignetteAngle > 0.0001) {
        vec2 px = vTextureCoord * uResolution;
        vec2 ctr = uResolution * 0.5;
        float dmax = length(ctr);
        float t = min(1.0, length(px - ctr) / max(1.0, dmax));
        float co = cos(uVignetteAngle * t);
        float f4 = co * co * co * co;
        float f = uVignetteBackward > 0.5 ? 1.0 / max(1e-4, f4) : f4;
        // RGB -> plane dải hẹp -> nhân f -> quay lại RGB
        float y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        float yp = (y * (219.0 / 255.0) + 16.0 / 255.0) * f;
        float up = ((c.b - y) / 1.8556 * (224.0 / 255.0)) * f + 128.0 / 255.0;
        float vp = ((c.r - y) / 1.5748 * (224.0 / 255.0)) * f + 128.0 / 255.0;
        float yy = (yp - 16.0 / 255.0) * (255.0 / 219.0);
        float uu = (up - 128.0 / 255.0) * (255.0 / 224.0);
        float vv = (vp - 128.0 / 255.0) * (255.0 / 224.0);
        float nr = yy + 1.5748 * vv;
        float nb = yy + 1.8556 * uu;
        float ng = (yy - 0.2126 * nr - 0.0722 * nb) / 0.7152;
        c = clamp(vec3(nr, ng, nb), 0.0, 1.0);
    }

    if (uGrain > 0.0001) {
        // Nhiễu ngẫu nhiên -> KHÔNG khớp từng hạt với FFmpeg (đã ghi rõ trong tài liệu),
        // chỉ khớp cường độ. uSeed đổi theo frame để có dáng hạt phim động.
        float n = (hash(floor(vTextureCoord * uResolution)) - 0.5) * 2.0 * uGrain;
        c = clamp(c + n, 0.0, 1.0);
    }

    gl_FragColor = vec4(c, src.a);
}
`;

    // MẶT NẠ — trộn kết quả đã chỉnh với ảnh NGUỒN theo giá trị mặt nạ.
    // Công thức SDF chép đúng từ maskValueAt() (JS) — sửa một bên phải sửa cả bên kia.
    const MASK_MIX_SRC = `
precision highp float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;    // kết quả đã chỉnh (FBO)
uniform sampler2D uSource;     // ảnh nguồn, chưa chỉnh (texture nạp từ DOM)
uniform float uAspect;
uniform float uMaskType;       // 0=rect 1=circle 2=split 3=filmstrip 4=star 5=heart
uniform vec2 uMaskCenter;
uniform float uMaskRot;        // radian, đã đổi dấu
uniform vec2 uMaskHalf;
uniform float uMaskFeather;
uniform float uMaskRound;
uniform float uMaskInvert;

// BẢN CHÉP của sdStar5/sdHeart bên JS (xem ghi chú ở maskValueAt) — sửa một bên PHẢI
// sửa bên kia, nếu không preview và bản xuất ra hai hình khác nhau.
const float STAR_FIT = 1.1055728091;
float sdStar5(vec2 q) {
    const vec2 k1 = vec2(0.809016994375, -0.587785252292);
    const vec2 k2 = vec2(-0.809016994375, -0.587785252292);
    vec2 p = vec2(abs(q.x) / STAR_FIT, (q.y / STAR_FIT) + 0.0954915028);
    p -= 2.0 * max(dot(k1, p), 0.0) * k1;
    p -= 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= 1.0;
    vec2 ba = (0.45 * vec2(-k1.y, k1.x)) - vec2(0.0, 1.0);
    float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, 1.0);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y) * STAR_FIT;
}
float sdHeart(vec2 q) {
    float px = abs(q.x) * 0.75;
    float py = (q.y + 1.0) * 0.5 * 1.15;
    float d;
    if (py + px > 1.0) {
        d = length(vec2(px - 0.25, py - 0.75)) - 0.3535533906;
    } else {
        float a = (px * px) + ((py - 1.0) * (py - 1.0));
        float t = 0.5 * max(px + py, 0.0);
        float b = ((px - t) * (px - t)) + ((py - t) * (py - t));
        d = sqrt(min(a, b)) * sign(px - py);
    }
    return d / 0.575;
}

void main(void) {
    // Lượt này đọc FBO (không lật) nhưng uSource là texture nạp từ DOM (lật) -> dùng
    // MỘT biến chung cho cả việc lấy mẫu nguồn lẫn toạ độ mặt nạ, để không lệch trục.
    vec2 nrm = vec2(vTextureCoord.x, 1.0 - vTextureCoord.y);
    vec4 adjusted = texture2D(uSampler, vTextureCoord);
    vec4 source = texture2D(uSource, nrm);

    float u = (nrm.x - 0.5) * 2.0 * uAspect - uMaskCenter.x * uAspect;
    float v = (nrm.y - 0.5) * 2.0 - uMaskCenter.y;
    float cs = cos(uMaskRot), sn = sin(uMaskRot);
    vec2 p = vec2(u * cs - v * sn, u * sn + v * cs);
    float hw = max(1e-4, uMaskHalf.x);
    float hh = max(1e-4, uMaskHalf.y);

    float d;
    if (uMaskType < 0.5) {
        float r = uMaskRound * min(hw, hh);
        vec2 q = abs(p) - (vec2(hw, hh) - r);
        d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    } else if (uMaskType < 1.5) {
        float qq = length(vec2(p.x / hw, p.y / hh));
        d = (qq - 1.0) * min(hw, hh);
    } else if (uMaskType < 2.5) {
        d = p.y;
    } else if (uMaskType < 3.5) {
        d = abs(p.y) - hh;
    } else if (uMaskType < 4.5) {
        // -p.y: SDF viết ở hệ y hướng lên, hệ mặt nạ có v hướng xuống
        d = sdStar5(vec2(p.x / hw, -p.y / hh)) * min(hw, hh);
    } else {
        d = sdHeart(vec2(p.x / hw, -p.y / hh)) * min(hw, hh);
    }

    float m;
    if (uMaskFeather > 1e-5) m = 1.0 - smoothstep(-uMaskFeather, uMaskFeather, d);
    else m = d <= 0.0 ? 1.0 : 0.0;
    if (uMaskInvert > 0.5) m = 1.0 - m;

    gl_FragColor = vec4(mix(source.rgb, adjusted.rgb, m), adjusted.a);
}
`;

    // ---------------------------------------------------------------------
    // 8. LỚP TIỆN ÍCH WEBGL — dùng cho MEDIA OVERLAY (ảnh/video) trong preview
    // ---------------------------------------------------------------------
    //
    // Lane chính đã có PixiJS nên chỉ cần PIXI.Filter (xem index.html). Overlay thì
    // preview là phần tử DOM <img>/<video>, không đi qua Pixi — nên ta vẽ nguồn đó
    // vào MỘT <canvas> WebGL bằng CHÍNH shader trên. Nhờ dùng chung FRAGMENT_SRC,
    // overlay và lane chính không thể lệch nhau.
    class CanvasColorRenderer {
        constructor(canvas) {
            this.canvas = canvas;
            this.gl = null;
            this.program = null;
            this.locations = {};
            this.textures = {};
            this.lutSize = 0;
            this.failed = false;
            // Nhóm Hiệu ứng (nhiều lượt) — chỉ dựng khi thực sự cần
            this.spatialReady = false;
            this.spatialOps = [];
            this.spatialKey = '';
            this.fboSize = { w: 0, h: 0 };
            this.seed = 0;
            this.adj = null;
            // Chữ ký RIÊNG của từng texture. KEYFRAME màu làm setAdjustments chạy MỖI
            // FRAME, mà bảng curve và cube 33³ (≈144KB) không phụ thuộc thông số có
            // keyframe -> nạp lại là ném băng thông đi vô ích. Cùng cách mà
            // ClipColorAdjustFilter (index.html) đang dùng cho đường PIXI.
            this.curveKey = '';
            this.lutKey = '';
        }

        init() {
            if (this.gl || this.failed) return !!this.gl;
            const gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true })
                || this.canvas.getContext('experimental-webgl', { premultipliedAlpha: false, alpha: true });
            if (!gl) { this.failed = true; return false; }
            const compile = (type, src) => {
                const sh = gl.createShader(type);
                gl.shaderSource(sh, src);
                gl.compileShader(sh);
                if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                    this.failed = true;
                    throw new Error('ColorAdjust shader: ' + gl.getShaderInfoLog(sh));
                }
                return sh;
            };
            const prog = gl.createProgram();
            gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERTEX_SRC));
            gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAGMENT_SRC));
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this.failed = true; return false; }
            gl.useProgram(prog);

            const buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
            const aPos = gl.getAttribLocation(prog, 'aPos');
            gl.enableVertexAttribArray(aPos);
            gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

            this.gl = gl;
            this.program = prog;
            [
                'uSampler', 'uFlipY', 'uEqOn', 'uEqContrast', 'uEqBrightness', 'uEqSaturation',
                'uToneOn',
                'uCbOn', 'uCbShadows', 'uCbMidtones', 'uCbHighlights',
                'uCurveOn', 'uCurveLut', 'uLutOn', 'uLut3d', 'uLutSize',
            ].forEach((name) => { this.locations[name] = gl.getUniformLocation(prog, name); });

            this.textures.source = this.createTexture();
            this.textures.curve = this.createTexture();
            this.textures.lut = this.createTexture();
            return true;
        }

        createTexture() {
            const gl = this.gl;
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            return tex;
        }

        bindUnit(tex, unit) {
            const gl = this.gl;
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex);
        }

        uploadPixels(tex, unit, width, height, pixels, nearest = false) {
            const gl = this.gl;
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            if (nearest) {
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            }
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        }

        // adj = adjustments đã normalize; bakedCube = kết quả bakeCube() hoặc null.
        setAdjustments(adj, bakedCube) {
            if (!this.init()) return;
            const gl = this.gl;
            gl.useProgram(this.program);
            // Giữ lại để draw() hoạch định lượt hiệu ứng theo KÍCH THƯỚC ẢNH thật.
            this.adj = adj;
            // KHÔNG xoá spatialKey ở đây: khoá cache của draw() đã dựng TỪ chính
            // adj.effects/adj.mask (+ kích thước ảnh) nên tự phát hiện thay đổi. Xoá tay
            // thì có keyframe màu là hoạch định lại + cấp phát hạt nhân MỖI FRAME dù
            // nhóm Hiệu ứng chẳng đổi gì.
            const u = shaderUniforms(adj);
            gl.uniform1f(this.locations.uEqOn, u.uEqOn);
            gl.uniform1f(this.locations.uEqContrast, u.uEqContrast);
            gl.uniform1f(this.locations.uEqBrightness, u.uEqBrightness);
            gl.uniform1f(this.locations.uEqSaturation, u.uEqSaturation);
            gl.uniform1f(this.locations.uToneOn, u.uToneOn);
            gl.uniform1f(this.locations.uCbOn, u.uCbOn);
            gl.uniform3fv(this.locations.uCbShadows, u.uCbShadows);
            gl.uniform3fv(this.locations.uCbMidtones, u.uCbMidtones);
            gl.uniform3fv(this.locations.uCbHighlights, u.uCbHighlights);
            gl.uniform1f(this.locations.uCurveOn, u.uCurveOn);
            gl.uniform1f(this.locations.uLutOn, bakedCube ? u.uLutOn : 0);

            // Texture chỉ nạp lại khi CHÍNH nội dung của nó đổi; còn lại chỉ bind lại vào
            // đúng đơn vị (rẻ) để các lượt vẽ sau đọc đúng chỗ.
            const curveKey = JSON.stringify(adj.curves) + '|tone:' + JSON.stringify(adj.tone);
            if (curveKey !== this.curveKey) {
                const curve = curveLutPixels(adj);
                this.uploadPixels(this.textures.curve, 1, curve.width, curve.height, curve.pixels, true);
                this.curveKey = curveKey;
            } else {
                this.bindUnit(this.textures.curve, 1);
            }
            gl.uniform1i(this.locations.uCurveLut, 1);

            if (bakedCube) {
                const lutKey = lutStageSignature(adj);
                if (lutKey !== this.lutKey) {
                    const tiled = cubeToTiledPixels(bakedCube);
                    this.uploadPixels(this.textures.lut, 2, tiled.width, tiled.height, tiled.pixels);
                    gl.uniform1f(this.locations.uLutSize, tiled.size);
                    this.lutSize = tiled.size;
                    this.lutKey = lutKey;
                } else {
                    this.bindUnit(this.textures.lut, 2);
                    gl.uniform1f(this.locations.uLutSize, this.lutSize);
                }
                gl.uniform1i(this.locations.uLut3d, 2);
            } else {
                this.lutKey = '';
            }
        }

        // --- Hạ tầng NHIỀU LƯỢT cho nhóm Hiệu ứng ---
        //
        // Lượt màu vẫn như trước. Khi có hiệu ứng không gian thì lượt màu ghi vào một
        // texture đệm (FBO) rồi các lượt sau ping-pong qua lại, LƯỢT CUỐI mới vẽ ra canvas.
        // Dùng 4 texture đệm: ping / pong / orig (ảnh ghim cho lượt trộn) / source.
        ensureSpatialPrograms() {
            if (this.spatialReady || this.failed) return this.spatialReady;
            const gl = this.gl;
            const build = (frag) => {
                const compile = (type, src) => {
                    const sh = gl.createShader(type);
                    gl.shaderSource(sh, src);
                    gl.compileShader(sh);
                    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                        throw new Error('ColorAdjust spatial shader: ' + gl.getShaderInfoLog(sh));
                    }
                    return sh;
                };
                const p = gl.createProgram();
                gl.attachShader(p, compile(gl.VERTEX_SHADER, PASS_VERTEX_SRC));
                gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
                gl.linkProgram(p);
                if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
                    throw new Error('ColorAdjust spatial link: ' + gl.getProgramInfoLog(p));
                }
                // Buffer đỉnh dùng chung đã bind ở init(); mỗi program cần trỏ lại attribute.
                const aPos = gl.getAttribLocation(p, 'aPos');
                gl.enableVertexAttribArray(aPos);
                gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
                return p;
            };
            try {
                this.progConv = build(CONV_SRC);
                this.progMix = build(UNSHARP_MIX_SRC);
                this.progPixel = build(PIXEL_FX_SRC);
                this.progMask = build(MASK_MIX_SRC);
                this.fbo = gl.createFramebuffer();
                this.textures.ping = this.createTexture();
                this.textures.pong = this.createTexture();
                this.textures.orig = this.createTexture();
                this.fboSize = { w: 0, h: 0 };
                this.spatialReady = true;
            } catch (err) {
                console.warn('[ColorAdjust]', err.message);
                this.failed = true;
                this.spatialReady = false;
            }
            return this.spatialReady;
        }

        // Cấp phát lại 3 texture đệm khi đổi kích thước.
        resizeSpatialTargets(w, h) {
            if (this.fboSize.w === w && this.fboSize.h === h) return;
            const gl = this.gl;
            ['ping', 'pong', 'orig'].forEach((key) => {
                gl.bindTexture(gl.TEXTURE_2D, this.textures[key]);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            });
            this.fboSize = { w, h };
        }

        // Vẽ một lượt: input texture -> output texture (null = ra canvas).
        renderPass(program, inputTex, outputTex, w, h, setup, flipY) {
            const gl = this.gl;
            gl.useProgram(program);
            const aPos = gl.getAttribLocation(program, 'aPos');
            gl.enableVertexAttribArray(aPos);
            gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
            if (outputTex) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTex, 0);
            } else {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            }
            gl.viewport(0, 0, w, h);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, inputTex);
            const loc = (name) => gl.getUniformLocation(program, name);
            gl.uniform1i(loc('uSampler'), 0);
            gl.uniform1f(loc('uFlipY'), flipY ? 1 : 0);
            if (setup) setup(loc, gl);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        // source = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
        draw(source, width, height) {
            if (!this.init()) return false;
            const gl = this.gl;
            const w = Math.max(1, Math.round(width));
            const h = Math.max(1, Math.round(height));
            if (this.canvas.width !== w) this.canvas.width = w;
            if (this.canvas.height !== h) this.canvas.height = h;

            // Nạp khung nguồn
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.textures.source);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            try {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            } catch (_) {
                return false;
            }

            // Hoạch định lượt hiệu ứng theo CHIỀU CAO ẢNH ĐANG XỬ LÝ (không phải chiều
            // cao sequence): bán kính khai theo tỉ lệ chiều cao nên preview proxy 720p và
            // bản xuất 1080p tự cho cùng cảm giác. Cache theo (thông số, chiều cao) vì
            // padKernel cấp phát mảng.
            const key = `${h}|${w}|${JSON.stringify(this.adj && this.adj.effects)}`
                + `|${JSON.stringify(this.adj && this.adj.mask)}`;
            if (key !== this.spatialKey) {
                this.spatialOps = this.adj ? spatialPasses(this.adj, h) : [];
                this.spatialKey = key;
            }
            const passes = this.spatialOps || [];
            // Đường NHANH: không có hiệu ứng không gian -> đúng một lượt ra canvas như cũ.
            if (!passes.length) {
                this.renderPass(this.program, this.textures.source, null, w, h, (loc) => {
                    // các uniform màu đã đặt ở setAdjustments (cùng program nên còn nguyên)
                    gl.uniform1i(loc('uCurveLut'), 1);
                    gl.uniform1i(loc('uLut3d'), 2);
                }, true);
                return true;
            }
            if (!this.ensureSpatialPrograms()) return false;
            this.resizeSpatialTargets(w, h);

            // Lượt MÀU -> ping
            this.renderPass(this.program, this.textures.source, this.textures.ping, w, h, (loc) => {
                gl.uniform1i(loc('uCurveLut'), 1);
                gl.uniform1i(loc('uLut3d'), 2);
            }, true);

            let cur = 'ping';
            let other = 'pong';
            const swap = () => { const t = cur; cur = other; other = t; };
            this.seed = ((this.seed || 0) + 1) % 1024;

            passes.forEach((pass, index) => {
                const isLast = index === passes.length - 1;
                const target = isLast ? null : this.textures[other];
                if (pass.op === 'saveOriginal') {
                    // Copy ảnh hiện tại sang 'orig'. Không có glBlitFramebuffer ở WebGL1
                    // nên copy bằng một lượt vẽ 1:1 qua chương trình trộn với amount=0
                    // — rẻ và không cần thêm shader chỉ để sao chép.
                    this.renderPass(this.progMix, this.textures[cur], this.textures.orig, w, h, (loc) => {
                        gl.activeTexture(gl.TEXTURE3);
                        gl.bindTexture(gl.TEXTURE_2D, this.textures[cur]);
                        gl.uniform1i(loc('uOriginal'), 3);
                        gl.uniform1f(loc('uAmount'), 0);
                    }, false);
                    return;   // 'orig' là texture riêng nên KHÔNG swap
                }
                if (pass.op === 'conv') {
                    this.renderPass(this.progConv, this.textures[cur], target, w, h, (loc) => {
                        gl.uniform2f(loc('uStep'), pass.axis === 'x' ? 1 / w : 0, pass.axis === 'y' ? 1 / h : 0);
                        gl.uniform1fv(loc('uWeights[0]'), pass.weights);
                        gl.uniform1f(loc('uLumaOnly'), pass.lumaOnly ? 1 : 0);
                    }, false);
                } else if (pass.op === 'unsharpMix') {
                    this.renderPass(this.progMix, this.textures[cur], target, w, h, (loc) => {
                        gl.activeTexture(gl.TEXTURE3);
                        gl.bindTexture(gl.TEXTURE_2D, this.textures.orig);
                        gl.uniform1i(loc('uOriginal'), 3);
                        gl.uniform1f(loc('uAmount'), pass.amount);
                    }, false);
                } else if (pass.op === 'maskMix') {
                    const m = pass.mask;
                    const typeIndex = MASK_TYPE_CODE[m.type] || 0;
                    const aspect = w / Math.max(1, h);
                    this.renderPass(this.progMask, this.textures[cur], target, w, h, (loc) => {
                        gl.activeTexture(gl.TEXTURE4);
                        gl.bindTexture(gl.TEXTURE_2D, this.textures.source);
                        gl.uniform1i(loc('uSource'), 4);
                        gl.uniform1f(loc('uAspect'), aspect);
                        gl.uniform1f(loc('uMaskType'), typeIndex);
                        gl.uniform2f(loc('uMaskCenter'), m.x, m.y);
                        gl.uniform1f(loc('uMaskRot'), (-m.rotation * Math.PI) / 180);
                        gl.uniform2f(loc('uMaskHalf'), m.width * aspect, m.height);
                        gl.uniform1f(loc('uMaskFeather'), (m.feather / 100) * 0.5);
                        gl.uniform1f(loc('uMaskRound'), m.roundness / 100);
                        gl.uniform1f(loc('uMaskInvert'), m.invert ? 1 : 0);
                    }, false);
                } else if (pass.op === 'pixelFx') {
                    this.renderPass(this.progPixel, this.textures[cur], target, w, h, (loc) => {
                        gl.uniform2f(loc('uResolution'), w, h);
                        gl.uniform1f(loc('uGrain'), pass.grainStrength);
                        gl.uniform1f(loc('uVignetteAngle'), pass.vignetteAngle);
                        gl.uniform1f(loc('uVignetteBackward'), pass.vignetteBackward ? 1 : 0);
                        gl.uniform1f(loc('uSeed'), this.seed);
                    }, false);
                } else {
                    return;
                }
                if (!isLast) swap();
            });
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return true;
        }

        destroy() {
            const gl = this.gl;
            if (!gl) return;
            Object.values(this.textures).forEach((t) => gl.deleteTexture(t));
            [this.program, this.progConv, this.progMix, this.progPixel, this.progMask]
                .forEach((p) => { if (p) gl.deleteProgram(p); });
            if (this.fbo) gl.deleteFramebuffer(this.fbo);
            this.gl = null;
            this.program = null;
            this.progConv = null;
            this.progMix = null;
            this.progPixel = null;
            this.progMask = null;
            this.spatialReady = false;
            this.textures = {};
        }
    }

    return {
        HSL_BANDS, WHEEL_KEYS, WHEEL_LABELS, CURVE_CHANNELS, CURVE_LABELS,
        BAKE_CUBE_SIZE,
        defaultAdjustments, defaultCurve, defaultTone, normalize, normalizeCurve, clone,
        scaleStrength, scaleStrengthKeyframes,
        isIdentity, curveIsIdentity, toneIsIdentity, toneCurvePoints, toneLut, needsLut3d,
        eqParams, colorbalanceParams, cbComponent, cbLightness, cbWeightSum,
        solveWhiteBalance,
        curveLut, curvePointsString, curveLutPixels,
        filterPath,
        rgbToHsl, hslToRgb, bandWeights, applyHsl,
        parseCube, cubeToText, cubeToTiledPixels, sampleCubeTrilinear, bakeCube,
        bakeCubeCached, lutStageSignature, registerUserLut, getUserLut, hasUserLut,
        // Cường độ LUT có keyframe: 2 cube thành phần + biểu thức pha theo thời gian
        mixCubes, lutBlendCubes, lutMixKeyframeExpr,
        ffmpegFilters, enableBetween, LUT3D_SLOT, shaderUniforms, applyToRgb,
        defaultTone, toneIsIdentity, toneCurvePoints, toneLut,
        defaultEffects, effectsIsIdentity, effectsSpec,
        binomialKernel, gaussianKernel, boxKernel, applyToImage, lumaOf,
        hasSpatial, spatialPasses, MAX_TAPS, needsMultiPass, isBlank,
        KEYFRAME_PARAMS, KEYFRAME_PREFIX, canKeyframe, keyframeFieldName,
        getAdjustParam, setAdjustParam, effectiveAdjustments, hasAdjustKeyframes, eqKeyframeExprs,
        vignetteKeyframeExprs, VIGNETTE_MAX_ANGLE, BLUR_CASCADE,
        sendcmdText, sanitizeFilterLabel, CB_KEYS,
        MASK_TYPES, defaultMask, maskIsActive, maskValueAt, maskValueAtNorm, renderMaskGray,
        // Mặt nạ CẮT HÌNH của block (tab Video) — dùng chung hình học với mặt nạ chỉnh màu
        MASK_TYPES_NO_SIZE, MASK_TYPES_HEIGHT_ONLY, MASK_TYPES_ROUNDNESS, MASK_TYPE_CODE,
        normalizeMask, videoMaskIsActive, renderMaskAlphaCanvas,
        compileMask, maskValueCompiled,
        // Hình học cho tay cầm mặt nạ trên preview (cùng SDF với maskValueAt)
        maskOutlinePolys, maskRotateCw, maskPointToScreen, maskScreenDeltaToUv,
        FRAGMENT_SRC, VERTEX_SRC,
        CanvasColorRenderer,
    };
});
