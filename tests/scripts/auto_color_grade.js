/* Test MODULE static/js/auto-grade.js — engine "Tự động chỉnh màu".
 *
 * ĐIỀU ĐANG ĐƯỢC BẢO VỆ: bộ giải nghiệm đóng của auto-grade phải NHẤT QUÁN với
 * chuỗi màu thật. Nghĩa là: lấy số mà `AutoGrade.solve()` nhả ra, ghi vào
 * adjustments, cho khung hình chạy qua CHÍNH `ColorAdjust.applyToRgb` (= công thức
 * của GLSL shader preview, và đã được test color_adjust_pipeline đối chiếu với
 * FFmpeg) -> thống kê thu được phải RƠI ĐÚNG vào đích mà bộ giải nhắm.
 *
 * Nếu ai đó sửa eqParams/toneLut trong color-adjust.js mà quên auto-grade, test đổ.
 */
const assert = require('assert');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const ColorAdjust = require(path.join(PROJECT_ROOT, 'static', 'js', 'color-adjust.js'));
const AutoGrade = require(path.join(PROJECT_ROOT, 'static', 'js', 'auto-grade.js'));

// --- tiện ích dựng khung hình giả lập -------------------------------------

/* Sinh RGBA từ một hàm (i) -> [r,g,b] trong 0..1. */
function makeFrame(w, h, fn) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const [r, g, b] = fn(i, w, h);
        data[i * 4] = Math.round(Math.max(0, Math.min(1, r)) * 255);
        data[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
        data[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
        data[i * 4 + 3] = 255;
    }
    return { data, width: w, height: h };
}

/* Khung xám trải đều trong [lo,hi], nhân thêm một hệ số màu (mô phỏng ám màu). */
function rampFrame(lo, hi, castR = 1, castG = 1, castB = 1, w = 64, h = 64) {
    return makeFrame(w, h, (i) => {
        const t = i / (w * h - 1);
        const v = lo + (hi - lo) * t;
        return [v * castR, v * castG, v * castB];
    });
}

/* Cho toàn khung đi qua chuỗi màu THẬT rồi phân tích lại. */
function statsAfterRealChain(frame, adj) {
    const out = new Uint8ClampedArray(frame.data.length);
    for (let i = 0; i < frame.width * frame.height; i++) {
        const rgb = [frame.data[i * 4] / 255, frame.data[i * 4 + 1] / 255, frame.data[i * 4 + 2] / 255];
        const c = ColorAdjust.applyToRgb(adj, rgb);
        out[i * 4] = Math.round(c[0] * 255);
        out[i * 4 + 1] = Math.round(c[1] * 255);
        out[i * 4 + 2] = Math.round(c[2] * 255);
        out[i * 4 + 3] = 255;
    }
    return AutoGrade.analyzeFrame(out, frame.width, frame.height);
}

function solvedAdjustments(frame, options) {
    const stats = AutoGrade.analyzeFrame(frame.data, frame.width, frame.height);
    const patch = AutoGrade.solve(stats, null, options);
    assert.ok(patch, 'bộ giải phải trả về patch cho khung hợp lệ');
    const adj = ColorAdjust.normalize(null);
    AutoGrade.applyPatch(adj, patch);
    return { stats, patch, adj };
}

// --- 1. Phân tích khung hình ----------------------------------------------

function testAnalyze() {
    // Phân vị của một dải tuyến tính phải bám sát chính nó.
    const ramp = rampFrame(0, 1);
    const s = AutoGrade.analyzeFrame(ramp.data, ramp.width, ramp.height);
    assert.ok(Math.abs(s.p50 - 0.5) < 0.02, `p50 dải đều nên ≈0.5, đo được ${s.p50}`);
    assert.ok(Math.abs(s.p05 - 0.05) < 0.02, `p05 ≈0.05, đo được ${s.p05}`);
    assert.ok(Math.abs(s.p95 - 0.95) < 0.02, `p95 ≈0.95, đo được ${s.p95}`);
    assert.ok(!s.flat, 'dải đủ rộng thì không phải khung phẳng');

    // Khung một màu = khung "phẳng" -> phải bị từ chối, KHÔNG được nhả số bừa.
    const flat = makeFrame(32, 32, () => [0.2, 0.2, 0.2]);
    const fs = AutoGrade.analyzeFrame(flat.data, flat.width, flat.height);
    assert.ok(fs.flat, 'khung một màu phải bị đánh dấu flat');
    assert.ok(AutoGrade.isDegenerate(fs), 'khung phẳng phải là degenerate');
    assert.strictEqual(AutoGrade.solve(fs, null, {}), null, 'khung phẳng phải trả null');

    // Khung fade đen (đầu block rất hay gặp) cũng phải bị từ chối.
    const black = makeFrame(32, 32, () => [0.004, 0.004, 0.004]);
    const bs = AutoGrade.analyzeFrame(black.data, black.width, black.height);
    assert.ok(AutoGrade.isDegenerate(bs), 'khung đen phải là degenerate');

    // Đếm kẹp.
    const clipped = makeFrame(64, 64, (i, w, h) => {
        const t = i / (w * h - 1);
        return t < 0.2 ? [0, 0, 0] : (t > 0.8 ? [1, 1, 1] : [t, t, t]);
    });
    const cs = AutoGrade.analyzeFrame(clipped.data, clipped.width, clipped.height);
    assert.ok(cs.clipLow > 0.15 && cs.clipLow < 0.25, `clipLow ≈0.2, đo được ${cs.clipLow}`);
    assert.ok(cs.clipHigh > 0.15 && cs.clipHigh < 0.25, `clipHigh ≈0.2, đo được ${cs.clipHigh}`);

    // Alpha = 0 phải bị bỏ qua, nếu không gray-world bị kéo về màu nền rỗng.
    const half = makeFrame(32, 32, (i) => (i % 2 ? [0.9, 0.1, 0.1] : [0.5, 0.5, 0.5]));
    for (let i = 0; i < 32 * 32; i++) if (i % 2) half.data[i * 4 + 3] = 0;
    const hs = AutoGrade.analyzeFrame(half.data, half.width, half.height);
    assert.ok(hs.flat, 'chỉ còn pixel xám đục -> phẳng (đã bỏ đúng pixel trong suốt)');
    console.log('  ok  phân tích khung: phân vị, kẹp, khung phẳng/đen, alpha');
}

// --- 2. Nghiệm đóng eq: giải xong CHẠY THẬT phải trúng đích -----------------

function testExposureContrastClosedForm() {
    const cases = [
        { name: 'tối và bệt', lo: 0.05, hi: 0.35 },
        { name: 'sáng và bệt', lo: 0.62, hi: 0.92 },
        { name: 'trải rộng sẵn', lo: 0.02, hi: 0.98 },
        { name: 'trung tính hẹp', lo: 0.35, hi: 0.6 },
    ];
    for (const c of cases) {
        const frame = rampFrame(c.lo, c.hi);
        // Chỉ đo phần eq -> tắt tone/WB để không lẫn tác động khác vào phép đo.
        const { patch, adj } = solvedAdjustments(frame, { tone: false, whiteBalance: false, saturation: false });
        const after = statsAfterRealChain(frame, adj);

        // Dự đoán nội bộ (statsAfterEq) phải khớp chuỗi thật — đây là chỗ dễ lệch
        // nhất nếu công thức (*) bị chép sai.
        const predicted = AutoGrade.statsAfterEq(
            AutoGrade.analyzeFrame(frame.data, frame.width, frame.height), patch.basic);
        assert.ok(Math.abs(predicted.p50 - after.p50) < 0.02,
            `[${c.name}] statsAfterEq lệch chuỗi thật: dự đoán ${predicted.p50.toFixed(3)} vs thật ${after.p50.toFixed(3)}`);

        // Trúng đích trung vị (trừ khi thông số đã chạm trần — lúc đó chỉ cần ĐI ĐÚNG HƯỚNG).
        const hitLimit = Math.abs(patch.basic.exposure) >= AutoGrade.LIMIT.exposure
            || Math.abs(patch.basic.contrast) >= AutoGrade.LIMIT.contrast;
        if (!hitLimit) {
            assert.ok(Math.abs(after.p50 - AutoGrade.TARGET.median) < 0.03,
                `[${c.name}] trung vị sau chỉnh phải ≈${AutoGrade.TARGET.median}, đo được ${after.p50.toFixed(3)}`);
            const spread = after.p95 - after.p05;
            assert.ok(Math.abs(spread - AutoGrade.TARGET.spread) < 0.06,
                `[${c.name}] độ trải phải ≈${AutoGrade.TARGET.spread}, đo được ${spread.toFixed(3)}`);
        } else {
            const before = AutoGrade.analyzeFrame(frame.data, frame.width, frame.height);
            assert.ok(Math.abs(after.p50 - AutoGrade.TARGET.median) <= Math.abs(before.p50 - AutoGrade.TARGET.median) + 1e-6,
                `[${c.name}] chạm trần thì ít nhất phải gần đích hơn trước`);
        }
        console.log(`  ok  eq nghiệm đóng [${c.name}]: EV=${patch.basic.exposure} C=${patch.basic.contrast} -> p50=${after.p50.toFixed(3)}`);
    }
}

/* KẸP KHÔNG ĐƯỢC LÀM TRƯỢT ĐÍCH: contrast bị kẹp thì exposure phải được giải LẠI
 * theo contrast đã kẹp. Đây là lỗi rất dễ mắc nên chốt riêng một mục. */
function testClampReSolvesExposure() {
    const stats = { p01: 0.30, p05: 0.32, p50: 0.36, p95: 0.40, p99: 0.42, clipLow: 0, clipHigh: 0 };
    const basic = AutoGrade.solveExposureContrast(stats, AutoGrade.TARGET);
    assert.strictEqual(Math.abs(basic.contrast), AutoGrade.LIMIT.contrast,
        'dải cực hẹp thì contrast phải chạm trần (bối cảnh của phép thử)');
    const predicted = AutoGrade.statsAfterEq(stats, basic);
    assert.ok(Math.abs(predicted.p50 - AutoGrade.TARGET.median) < 0.03,
        `contrast chạm trần nhưng trung vị vẫn phải trúng đích, đo được ${predicted.p50.toFixed(3)}`);
    console.log('  ok  kẹp contrast xong vẫn giải lại exposure để trúng trung vị');
}

// --- 3. Cân bằng trắng tự động ---------------------------------------------

function testAutoWhiteBalance() {
    // Ám vàng (R,G cao hơn B) -> sau khi chỉnh 3 kênh của mốc xám phải cân lại.
    const casts = [
        { name: 'ám vàng', r: 1.0, g: 0.95, b: 0.78 },
        { name: 'ám lam', r: 0.80, g: 0.92, b: 1.0 },
        { name: 'ám lục', r: 0.88, g: 1.0, b: 0.88 },
    ];
    for (const c of casts) {
        const frame = rampFrame(0.05, 0.9, c.r, c.g, c.b);
        const { adj } = solvedAdjustments(frame, { tone: false, saturation: false });
        assert.ok(adj.basic.temperature !== 0 || adj.basic.tint !== 0,
            `[${c.name}] phải sinh ra temp/tint khác 0`);

        // Đo trên CHÍNH mốc xám: cho nó qua chuỗi thật rồi xem 3 kênh có sát nhau không.
        const before = AutoGrade.analyzeFrame(frame.data, frame.width, frame.height);
        const gray = AutoGrade.grayReference(before, {});
        const outGray = ColorAdjust.applyToRgb(adj, gray);
        const spread = Math.max(...outGray) - Math.min(...outGray);
        const spreadBefore = Math.max(...gray) - Math.min(...gray);
        assert.ok(spread < spreadBefore * 0.5,
            `[${c.name}] độ lệch 3 kênh của mốc xám phải giảm quá nửa: ${spreadBefore.toFixed(3)} -> ${spread.toFixed(3)}`);
        console.log(`  ok  auto WB [${c.name}]: temp=${adj.basic.temperature} tint=${adj.basic.tint}, lệch kênh ${spreadBefore.toFixed(3)} -> ${spread.toFixed(3)}`);
    }
}

/* Cảnh ĐƠN SẮC THẬT (hoàng hôn) không được bị "sửa" thành xám: đó là ý đồ nghệ
 * thuật, không phải lỗi cân bằng trắng. */
function testSaturatedSceneRefusesWhiteBalance() {
    const sunset = makeFrame(64, 64, (i, w, h) => {
        const t = i / (w * h - 1);
        return [0.15 + 0.8 * t, 0.06 + 0.30 * t, 0.02 + 0.08 * t];   // cam đậm
    });
    const stats = AutoGrade.analyzeFrame(sunset.data, sunset.width, sunset.height);
    assert.strictEqual(AutoGrade.grayReference(stats, {}), null,
        'cảnh đơn sắc mạnh phải TỪ CHỐI đưa ra mốc trung tính');
    const patch = AutoGrade.solve(stats, null, {});
    assert.strictEqual(patch.basic.temperature, 0, 'không có mốc thì temp phải để nguyên 0');
    assert.strictEqual(patch.basic.tint, 0, 'không có mốc thì tint phải để nguyên 0');
    console.log('  ok  cảnh đơn sắc: từ chối auto WB thay vì nhuộm ngược');
}

// --- 4. Nhóm tone (điểm đen/trắng + cứu vùng kẹp) ---------------------------

function testToneGroup() {
    // Đen bị "nhấc" lên (sương/bạc màu) -> phải kéo điểm đen xuống.
    const lifted = rampFrame(0.22, 0.95);
    const { patch, adj } = solvedAdjustments(lifted, { whiteBalance: false, saturation: false });
    assert.ok(patch.tone.blacks < 0, `đen bị nhấc thì blacks phải âm, đo được ${patch.tone.blacks}`);
    const after = statsAfterRealChain(lifted, adj);
    assert.ok(after.p01 < AutoGrade.analyzeFrame(lifted.data, lifted.width, lifted.height).p01 + 0.02,
        'điểm đen sau chỉnh phải thấp hơn (hoặc bằng) trước');

    // solveTone phải dò trên ĐÚNG toneLut của engine.
    const v = AutoGrade.solveTone('blacks', 0.25, 0.02, AutoGrade.LIMIT.blacks);
    const probe = ColorAdjust.normalize(null);
    probe.tone.blacks = v;
    const got = ColorAdjust.toneLut(probe, 256)[Math.round(0.25 * 255)];
    assert.ok(Math.abs(got - 0.02) < 0.05 || Math.abs(v) >= AutoGrade.LIMIT.blacks,
        `chia đôi phải trúng đích trên toneLut: muốn 0.02, đo được ${got.toFixed(3)} (blacks=${v})`);

    // Cứu vùng kẹp: CHỈ chạy khi có kẹp thật.
    const clean = AutoGrade.solveToneGroup(
        { p01: 0.02, p99: 0.98, clipLow: 0, clipHigh: 0 }, AutoGrade.TARGET);
    assert.strictEqual(clean.highlights, 0, 'không kẹp sáng thì không được đụng highlights');
    assert.strictEqual(clean.shadows, 0, 'không kẹp tối thì không được đụng shadows');

    const blown = AutoGrade.solveToneGroup(
        { p01: 0.02, p99: 0.98, clipLow: 0.10, clipHigh: 0.08 }, AutoGrade.TARGET);
    assert.ok(blown.highlights < 0, 'kẹp sáng thì highlights phải âm (kéo về)');
    assert.ok(blown.shadows > 0, 'kẹp tối thì shadows phải dương (nâng lên)');
    console.log('  ok  tone: điểm đen/trắng bằng chia đôi trên toneLut, cứu kẹp có điều kiện');
}

// --- 5. Hợp đồng ghi dữ liệu ------------------------------------------------

/* Auto grade KHÔNG được xoá việc người dùng đã làm bằng tay. */
function testPatchPreservesManualWork() {
    const adj = ColorAdjust.normalize(null);
    adj.curves.r = [[0, 0], [0.5, 0.7], [1, 1]];
    adj.wheels.lift = { r: 20, g: -10, b: 5 };
    adj.hsl.red = { h: 12, s: 30, l: -8 };
    adj.effects.vignette = 40;
    adj.mask.enabled = true;
    const before = JSON.parse(JSON.stringify({
        curves: adj.curves, wheels: adj.wheels, hsl: adj.hsl, effects: adj.effects, mask: adj.mask,
    }));

    const frame = rampFrame(0.1, 0.7, 1.0, 0.95, 0.8);
    const stats = AutoGrade.analyzeFrame(frame.data, frame.width, frame.height);
    AutoGrade.applyPatch(adj, AutoGrade.solve(stats, adj, {}));

    assert.deepStrictEqual(adj.curves, before.curves, 'auto grade không được đụng curves');
    assert.deepStrictEqual(adj.wheels, before.wheels, 'auto grade không được đụng vòng tròn màu');
    assert.deepStrictEqual(adj.hsl, before.hsl, 'auto grade không được đụng HSL');
    assert.deepStrictEqual(adj.effects, before.effects, 'auto grade không được đụng nhóm hiệu ứng');
    assert.deepStrictEqual(adj.mask, before.mask, 'auto grade không được đụng mặt nạ');
    assert.strictEqual(adj.lut.id, '', 'không chọn phong cách thì LUT phải để nguyên');
    console.log('  ok  patch giữ nguyên curves/wheels/HSL/effects/mask của người dùng');
}

/* KIỂU CHỈNH đổi ĐÍCH của bộ giải — và TUYỆT ĐỐI không đụng LUT.
 *
 * Đây là hợp đồng quan trọng nhất sau khi tách hai lớp (2026-08-04): auto grade là lớp
 * SỬA, LUT là lớp THẨM MỸ. Ai đó nối lại hai thứ này thì test đổ. */
function testStylesNeverTouchLut() {
    const frame = rampFrame(0.12, 0.78, 1.0, 0.96, 0.88);
    for (const style of AutoGrade.STYLES) {
        const stats = AutoGrade.analyzeFrame(frame.data, frame.width, frame.height);
        const patch = AutoGrade.solve(stats, null, { styleId: style.id });
        assert.ok(patch, `[${style.name}] phải ra patch`);
        assert.strictEqual(patch.styleId, style.id, 'patch phải mang đúng styleId');

        // LUT do người dùng đặt trước đó phải CÒN NGUYÊN sau khi auto grade chạy.
        const adj = ColorAdjust.normalize(null);
        adj.lut = { id: 'teal_orange', name: 'Teal & Orange', intensity: 60 };
        AutoGrade.applyPatch(adj, patch);
        assert.deepStrictEqual(adj.lut, { id: 'teal_orange', name: 'Teal & Orange', intensity: 60 },
            `[${style.name}] auto grade KHÔNG được đụng vào lut`);
    }
    console.log(`  ok  ${AutoGrade.STYLES.length} kiểu chỉnh, không kiểu nào ghi vào lut`);
}

/* Mỗi kiểu phải THỰC SỰ khác nhau ở kết quả — nếu không thì menu chỉ để trang trí.
 *
 * KHUNG THỬ PHẢI CÓ MÀU THẬT: bản đầu dùng dải xám (bão hoà ≈ 0), khiến
 * `solveSaturation` của MỌI kiểu đều đụng trần +60 rồi trùng nhau — test đổ vì khung
 * thử sai chứ không phải vì engine sai. Cảnh thật luôn có màu, nên đo trên cảnh có màu. */
function colorfulFrame(w = 64, h = 64) {
    return makeFrame(w, h, (i, W, H) => {
        const t = i / (W * H - 1);
        // dải sáng 0.08→0.85 kèm sắc quay vòng -> phủ cả độ sáng lẫn sắc độ
        const v = 0.08 + 0.77 * t;
        const a = t * Math.PI * 2;
        return [
            v * (1 + 0.34 * Math.cos(a)),
            v * (1 + 0.34 * Math.cos(a - 2.094)),
            v * (1 + 0.34 * Math.cos(a + 2.094)),
        ];
    });
}

function testStylesActuallyDiffer() {
    const frame = colorfulFrame();
    const stats = AutoGrade.analyzeFrame(frame.data, frame.width, frame.height);
    // Bối cảnh của phép thử: bão hoà phải NẰM TRONG dải, không đụng trần.
    const probe = AutoGrade.solve(stats, null, { styleId: '' });
    assert.ok(Math.abs(probe.basic.saturation) < AutoGrade.LIMIT.saturation,
        `khung thử phải có màu thật (bão hoà chưa chạm trần), đo được ${probe.basic.saturation}`);

    const seen = new Map();
    for (const style of AutoGrade.STYLES) {
        const p = AutoGrade.solve(stats, null, { styleId: style.id });
        const key = JSON.stringify([p.basic, p.tone]);
        for (const [name, k] of seen) {
            assert.notStrictEqual(key, k, `kiểu "${style.name}" cho kết quả TRÙNG với "${name}"`);
        }
        seen.set(style.name, key);
    }

    const of = (id) => AutoGrade.solve(stats, null, { styleId: id });
    const neutral = of('');
    // Ấm phải ấm HƠN trung tính, Lạnh phải lạnh HƠN — đúng chiều, không chỉ "khác".
    assert.ok(of('warm').basic.temperature > neutral.basic.temperature,
        'Ấm phải có nhiệt độ cao hơn Trung tính');
    assert.ok(of('cool').basic.temperature < neutral.basic.temperature,
        'Lạnh phải có nhiệt độ thấp hơn Trung tính');
    // "Sáng & dịu" phải SÁNG hơn và TƯƠNG PHẢN THẤP hơn "Đậm nét".
    const soft = of('soft_bright');
    const punchy = of('punchy');
    assert.ok(soft.basic.exposure > punchy.basic.exposure,
        `Sáng & dịu phải phơi sáng cao hơn Đậm nét (${soft.basic.exposure} vs ${punchy.basic.exposure})`);
    assert.ok(soft.basic.contrast < punchy.basic.contrast,
        `Sáng & dịu phải tương phản thấp hơn Đậm nét (${soft.basic.contrast} vs ${punchy.basic.contrast})`);
    console.log('  ok  các kiểu khác nhau và ĐÚNG CHIỀU (ấm/lạnh, dịu/đậm)');
}

/* HƯỚNG MÀU CỦA TỪNG KIỂU PHẢI ĐÚNG VỚI TÊN NÓ.
 *
 * Lỗi thật đã xảy ra (người dùng báo): cả 4 kiểu nhóm "Sắc" bị NGƯỢC DẤU tint — chọn
 * "Ngả vàng" thì ảnh ngả tím, chọn "Ngả tím" thì ra lục. Sai kiểu này KHÔNG lộ ra ở
 * bất kỳ phép đo nào khác (giá trị vẫn hợp lệ, các kiểu vẫn khác nhau, vẫn không đụng
 * LUT) — chỉ có đối chiếu TÊN với MÀU THẬT mới bắt được.
 *
 * Quy ước đo được trên xám 128: temp>0 = đỏ/ấm · temp<0 = lam/lạnh ·
 *                               tint>0 = lục   · tint<0 = magenta (hồng/tím).
 */
function testHueDirection() {
    const GREY = [0.5, 0.5, 0.5];
    const measure = (styleId) => {
        const s = AutoGrade.styleById(styleId);
        const adj = ColorAdjust.normalize(null);
        adj.basic.temperature = s.bias.temperature || 0;
        adj.basic.tint = s.bias.tint || 0;
        const [r, g, b] = ColorAdjust.applyToRgb(adj, GREY);
        return { name: s.name, warm: r - b, green: g - (r + b) / 2 };
    };
    // [id, phải ẤM?, phải LỤC?]  (null = không xét chiều đó)
    const WANT = [
        ['amber', true, true],    // vàng = đỏ + lục
        ['rose', true, false],    // hồng = ấm + magenta
        ['green', null, true],    // lục
        ['violet', false, false], // tím = lạnh + magenta
        ['warm', true, null],
        ['warm_strong', true, null],
        ['cool', false, null],
        ['cool_strong', false, null],
    ];
    for (const [id, wantWarm, wantGreen] of WANT) {
        const m = measure(id);
        if (wantWarm !== null) {
            assert.ok(wantWarm ? m.warm > 0.01 : m.warm < -0.01,
                `"${m.name}" phải ${wantWarm ? 'ẤM' : 'LẠNH'}, đo được r−b = ${m.warm.toFixed(3)}`);
        }
        if (wantGreen !== null) {
            assert.ok(wantGreen ? m.green > 0.008 : m.green < -0.008,
                `"${m.name}" phải ngả ${wantGreen ? 'LỤC' : 'MAGENTA'}, đo được g−(r+b)/2 = ${m.green.toFixed(3)}`);
        }
    }
    // "Lạnh" KHÔNG được ngả lục — lạnh + lục là màu bệnh hoạn trên da người.
    for (const id of ['cool_soft', 'cool', 'cool_strong']) {
        const m = measure(id);
        assert.ok(Math.abs(m.green) < 0.008, `"${m.name}" phải trung tính về lục/magenta, đo được ${m.green.toFixed(3)}`);
    }
    console.log('  ok  hướng màu khớp TÊN kiểu (vàng/hồng/lục/tím, ấm/lạnh)');
}

/* Bias ấm/lạnh cộng SAU cân bằng trắng — cộng trước thì bộ giải WB triệt tiêu mất. */
function testBiasAppliedAfterWhiteBalance() {
    // Khung ám lam mạnh: WB sẽ phải kéo temperature LÊN để bù.
    const frame = rampFrame(0.08, 0.9, 0.80, 0.92, 1.0);
    const stats = AutoGrade.analyzeFrame(frame.data, frame.width, frame.height);
    const neutral = AutoGrade.solve(stats, null, { styleId: '' });
    const warm = AutoGrade.solve(stats, null, { styleId: 'warm' });
    const delta = warm.basic.temperature - neutral.basic.temperature;
    const expected = AutoGrade.styleById('warm').bias.temperature;
    // Bằng đúng bias (trừ khi chạm trần) -> chứng tỏ nó CỘNG THÊM chứ không bị WB nuốt.
    assert.ok(Math.abs(delta - expected) <= 1 || Math.abs(warm.basic.temperature) >= AutoGrade.LIMIT.temperature,
        `bias ấm phải cộng nguyên vẹn sau WB: lệch ${delta}, mong đợi ${expected}`);
    console.log(`  ok  bias cộng sau cân bằng trắng (nền ám lam: ${neutral.basic.temperature} -> ${warm.basic.temperature})`);
}

/* Kết quả phải nằm trong dải hợp lệ của panel, nếu không normalize sẽ kẹp âm thầm
 * và số trên slider khác số bộ giải tính ra. */
function testOutputWithinPanelRange() {
    const frames = [
        rampFrame(0.0, 0.08), rampFrame(0.9, 1.0), rampFrame(0.4, 0.45, 1.0, 0.6, 0.6),
        rampFrame(0.02, 0.99, 0.7, 1.0, 0.85),
    ];
    for (const f of frames) {
        const stats = AutoGrade.analyzeFrame(f.data, f.width, f.height);
        const patch = AutoGrade.solve(stats, null, {});
        if (!patch) continue;
        const all = { ...patch.basic, ...patch.tone };
        for (const [k, v] of Object.entries(all)) {
            assert.ok(Number.isFinite(v), `${k} phải là số hữu hạn, đo được ${v}`);
            assert.ok(v >= -100 && v <= 100, `${k}=${v} nằm ngoài dải ±100 của panel`);
            assert.strictEqual(v, Math.round(v), `${k}=${v} phải là số nguyên (slider dùng số nguyên)`);
        }
        // Chốt lại bằng normalize: nếu bị kẹp thì giá trị sẽ đổi.
        const adj = ColorAdjust.normalize(null);
        AutoGrade.applyPatch(adj, patch);
        const round = ColorAdjust.normalize(adj);
        assert.deepStrictEqual(round.basic, adj.basic, 'normalize không được đổi basic (tức là không bị kẹp)');
        assert.deepStrictEqual(round.tone, adj.tone, 'normalize không được đổi tone');
    }
    console.log('  ok  mọi đầu ra nằm trong dải panel và sống sót qua normalize');
}

function main() {
    console.log('auto color grade: phân tích khung hình');
    testAnalyze();
    console.log('auto color grade: nghiệm đóng eq (đối chiếu chuỗi màu thật)');
    testExposureContrastClosedForm();
    testClampReSolvesExposure();
    console.log('auto color grade: cân bằng trắng tự động');
    testAutoWhiteBalance();
    testSaturatedSceneRefusesWhiteBalance();
    console.log('auto color grade: nhóm tone');
    testToneGroup();
    console.log('auto color grade: hợp đồng ghi dữ liệu');
    testPatchPreservesManualWork();
    testOutputWithinPanelRange();
    console.log('auto color grade: kiểu chỉnh (tách hẳn khỏi LUT)');
    testStylesNeverTouchLut();
    testStylesActuallyDiffer();
    testHueDirection();
    testBiasAppliedAfterWhiteBalance();
    console.log('auto color grade ok');
}

main();
