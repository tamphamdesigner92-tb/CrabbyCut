/* Test LỚP ĐIỀU CHỈNH (adjustment layer) — hợp đồng preview == export.
 *
 * ĐIỀU ĐANG ĐƯỢC BẢO VỆ: lớp Điều chỉnh áp THÊM một chuỗi màu lên trên chuỗi của
 * chính block. Preview làm việc đó bằng LƯỢT SHADER THỨ HAI; export làm bằng chuỗi
 * filter THỨ HAI nối sau chuỗi thứ nhất. Hai cách cài đặt khác nhau -> phải đo cho
 * ra CÙNG một kết quả, nếu không WYSIWYG vỡ đúng ở tính năng này.
 *
 * Cần `ffmpeg` trong PATH; không có thì phần đối chiếu tự bỏ qua (phần toán vẫn chạy).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const ColorAdjust = require(path.join(PROJECT_ROOT, 'static', 'js', 'color-adjust.js'));

function ffmpegAvailable() {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

// --- 1. Cổng thời gian: enableBetween ---------------------------------------

function testEnableBetween() {
    // Phủ TRỌN -> '' (không phát enable). Đây là ca thường gặp nhất (lớp phủ cả bài):
    // phát enable thừa vừa tốn vừa thêm chỗ sai số biên.
    assert.strictEqual(ColorAdjust.enableBetween(0, 5, 5), '', 'phủ trọn phải trả chuỗi rỗng');
    assert.strictEqual(ColorAdjust.enableBetween(-1, 9, 5), '', 'phủ quá 2 đầu vẫn là phủ trọn');
    // Không giao -> null (KHÁC '' — caller phải phân biệt được "không áp" với "áp cả block")
    assert.strictEqual(ColorAdjust.enableBetween(3, 3, 5), null, 'không giao phải trả null');
    assert.strictEqual(ColorAdjust.enableBetween(6, 8, 5), null, 'nằm ngoài block phải trả null');
    // Phủ một phần -> biểu thức between
    // Dùng token LOCALT (không phải `t`): sidecar thay bằng thời gian CỤC BỘ của block —
    // overlay giữ mốc tuyệt đối sau setpts nên `t` thô ở đó không bao giờ rơi vào [0..dur].
    const e = ColorAdjust.enableBetween(1, 3, 5);
    assert.ok(/^between\(LOCALT,1\.0000,3\.0000\)$/.test(e), `phủ một phần phải ra between(LOCALT,..), được "${e}"`);
    // Kẹp về trong block
    assert.ok(/,0\.0000,2\.0000\)$/.test(ColorAdjust.enableBetween(-2, 2, 5)), 'phải kẹp cận dưới về 0');
    assert.ok(/,3\.0000,5\.0000\)$/.test(ColorAdjust.enableBetween(3, 99, 5)), 'phải kẹp cận trên về duration');
    console.log('  ok  enableBetween: phủ trọn / không giao / phủ một phần / kẹp biên');
}

// --- 2. enable phải gắn vào TỪNG filter -------------------------------------

function testEnableOnEveryFilter() {
    const adj = ColorAdjust.normalize(null);
    adj.basic.exposure = 30;
    adj.basic.contrast = 20;
    adj.basic.temperature = 25;
    adj.tone.shadows = 40;
    adj.effects.vignette = 30;
    const plain = ColorAdjust.ffmpegFilters(adj, '', 1080, {});
    const gated = ColorAdjust.ffmpegFilters(adj, '', 1080, { enable: 'between(t,1,2)' });
    assert.strictEqual(gated.length, plain.length, 'gắn enable không được đổi SỐ filter');
    assert.ok(plain.length >= 4, `bối cảnh: phải có nhiều filter để phép thử có nghĩa (${plain.length})`);
    gated.forEach((f, i) => {
        assert.ok(f.endsWith(":enable='between(t,1,2)'"),
            `filter #${i} thiếu enable: ${f}`);
        assert.ok(f.startsWith(plain[i]), `filter #${i} bị đổi nội dung chứ không chỉ thêm enable`);
    });
    // Không truyền enable thì TUYỆT ĐỐI không được có chữ enable (chuỗi của chính block)
    assert.ok(!plain.some((f) => f.includes('enable=')), 'không truyền enable thì chuỗi phải sạch');
    console.log(`  ok  enable gắn vào cả ${gated.length} filter, không đổi nội dung filter`);
}

/* Chỗ trống lut3d cũng phải nhận enable — nếu không, LUT của lớp áp SUỐT block
 * trong khi các thông số khác chỉ áp trong khoảng. */
function testEnableOnLutSlot() {
    const adj = ColorAdjust.normalize(null);
    adj.hsl.red = { h: 20, s: 30, l: 10 };
    const gated = ColorAdjust.ffmpegFilters(adj, '', 1080, { lutSlot: true, enable: 'between(t,1,2)' });
    const slot = gated.find((f) => f.includes(ColorAdjust.LUT3D_SLOT));
    assert.ok(slot, 'bối cảnh: phải có chỗ trống lut3d');
    assert.ok(slot.endsWith(":enable='between(t,1,2)'"), `chỗ trống lut3d thiếu enable: ${slot}`);
    console.log('  ok  chỗ trống lut3d cũng nhận enable');
}

// --- 3. Đối chiếu THẬT với FFmpeg: chuỗi nối tiếp == 2 lượt của preview -------

/* Preview áp 2 lượt: applyToRgb(lớp, applyToRgb(block, px)).
 * Export nối 2 chuỗi filter. Hai cái phải ra cùng kết quả.
 *
 * ĐO TƯƠNG ĐỐI, KHÔNG ĐO TUYỆT ĐỐI — và đây là điều phải hiểu trước khi sửa test này:
 * bộ khung thử nạp rgb24 rồi để FFmpeg tự đổi sang YUV cho `eq`, nên MỖI chuỗi đã ăn
 * một vòng làm tròn RGB<->YUV 8-bit. Đo được: chuỗi ĐƠN lệ ch sẵn ~9/255 so với
 * applyToRgb (test color_adjust_pipeline né chuyện này bằng cách làm việc thẳng trong
 * YUV444). Vì vậy đòi 2 chuỗi lệch <1/255 là đòi điều bất khả, và con số tuyệt đối
 * ~12.6 KHÔNG chứng minh có lỗi công thức.
 * Cái CÓ nghĩa: nối chuỗi thứ hai không được làm sai số vọt lên quá mức tích luỹ tự
 * nhiên của thêm một vòng làm tròn (~căn 2 lần). Nếu ai đó nối sai thứ tự hay sót một
 * bước, sai số sẽ vọt lên hàng chục lần chứ không phải 1.4 lần.
 */
function testTwoChainsMatchPreview() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabby-adjlayer-'));
    try {
        const W = 32, H = 32;
        // Ảnh thử: dải xám + vài mảng màu, sinh từ RGB hợp lệ
        const rgb = Buffer.alloc(W * H * 3);
        for (let i = 0; i < W * H; i++) {
            const t = i / (W * H - 1);
            rgb[i * 3] = Math.round(255 * Math.min(1, t * 1.2));
            rgb[i * 3 + 1] = Math.round(255 * t);
            rgb[i * 3 + 2] = Math.round(255 * Math.max(0, 1 - t * 0.8));
        }
        const srcPath = path.join(tmp, 'src.rgb');
        fs.writeFileSync(srcPath, rgb);

        const blockAdj = ColorAdjust.normalize(null);
        blockAdj.basic.exposure = 25;
        blockAdj.basic.contrast = 15;
        const layerAdj = ColorAdjust.normalize(null);
        layerAdj.basic.temperature = 30;
        layerAdj.basic.saturation = -20;
        layerAdj.tone.shadows = 25;

        // Chạy một danh sách chuỗi qua FFmpeg rồi so với hàm tham chiếu của preview.
        const measure = (adjs, ref) => {
            const chain = adjs.flatMap((a) => ColorAdjust.ffmpegFilters(a, '', H, {})).join(',');
            const outPath = path.join(tmp, 'out.rgb');
            execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
                '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', srcPath,
                '-vf', `${chain},format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', outPath]);
            const got = fs.readFileSync(outPath);
            assert.strictEqual(got.length, rgb.length, 'kích thước ảnh ra phải giữ nguyên');
            let max = 0, sum = 0;
            for (let i = 0; i < W * H; i++) {
                const src = [rgb[i * 3] / 255, rgb[i * 3 + 1] / 255, rgb[i * 3 + 2] / 255];
                const r = ref(src);
                for (let k = 0; k < 3; k++) {
                    const d = Math.abs(r[k] * 255 - got[i * 3 + k]);
                    if (d > max) max = d;
                    sum += d;
                }
            }
            return { max, avg: sum / (W * H * 3) };
        };

        // ĐƯỜNG NỀN: chuỗi ĐƠN trong CHÍNH bộ khung thử này lệch bao nhiêu.
        const baseBlock = measure([blockAdj], (s) => ColorAdjust.applyToRgb(blockAdj, s));
        const baseLayer = measure([layerAdj], (s) => ColorAdjust.applyToRgb(layerAdj, s));
        const single = Math.max(baseBlock.max, baseLayer.max);
        // HAI chuỗi nối tiếp, tham chiếu = 2 lượt applyToRgb ĐÚNG thứ tự block -> lớp.
        const both = measure([blockAdj, layerAdj],
            (s) => ColorAdjust.applyToRgb(layerAdj, ColorAdjust.applyToRgb(blockAdj, s)));

        assert.ok(both.max <= single * 2, `nối chuỗi thứ hai làm sai số vọt bất thường: `
            + `đơn=${single.toFixed(2)}/255 -> đôi=${both.max.toFixed(2)}/255 (trần = 2x đơn)`);
        assert.ok(both.avg <= baseBlock.avg + baseLayer.avg + 0.5,
            `sai số TRUNG BÌNH vọt: ${both.avg.toFixed(2)} > ${baseBlock.avg.toFixed(2)}+${baseLayer.avg.toFixed(2)}`);

        // THỨ TỰ PHẢI ĐÚNG: đảo lại (lớp trước, block sau) phải cho kết quả KHÁC hẳn,
        // nếu không phép thử trên chẳng chứng minh được gì về thứ tự.
        const swapped = measure([blockAdj, layerAdj],
            (s) => ColorAdjust.applyToRgb(blockAdj, ColorAdjust.applyToRgb(layerAdj, s)));
        assert.ok(swapped.max > single * 2,
            `bối cảnh hỏng: đảo thứ tự mà sai số không tăng (${swapped.max.toFixed(2)}) `
            + `-> phép thử không phân biệt được thứ tự`);
        console.log(`  ok  2 chuỗi nối tiếp khớp 2 lượt preview: đơn=${single.toFixed(2)} `
            + `đôi=${both.max.toFixed(2)} (đảo thứ tự=${swapped.max.toFixed(2)}) /255`);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/* Cổng thời gian phải CHẠY THẬT trên luồng đã concat: trong khoảng thì đổi màu,
 * ngoài khoảng thì giữ nguyên từng pixel. */
function testEnableGatesInRealRender() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabby-adjgate-'));
    try {
        const layerAdj = ColorAdjust.normalize(null);
        layerAdj.basic.exposure = 60;
        const gated = ColorAdjust.ffmpegFilters(layerAdj, '', 64, { enable: 'between(t,1.0,2.0)' }).join(',');
        const out = path.join(tmp, 'g.mp4');
        execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'color=c=0x404040:s=64x64:r=10:d=3',
            '-vf', `${gated},format=yuv420p`, out]);
        const at = (t) => {
            const buf = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t),
                '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                { maxBuffer: 1 << 22 });
            return buf[0];
        };
        const before = at(0.4), inside = at(1.5), after = at(2.6);
        assert.ok(Math.abs(before - 0x40) <= 2, `ngoài khoảng (trước) phải giữ nguyên 64, đo được ${before}`);
        assert.ok(Math.abs(after - 0x40) <= 2, `ngoài khoảng (sau) phải giữ nguyên 64, đo được ${after}`);
        assert.ok(inside > before + 20, `trong khoảng phải sáng lên rõ, đo được ${inside} vs ${before}`);
        console.log(`  ok  cổng thời gian chạy thật: t=0.4s ${before} · t=1.5s ${inside} · t=2.6s ${after}`);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}


// --- 5. OPACITY CỦA LỚP = CƯỜNG ĐỘ HIỆU ỨNG (ColorAdjust.scaleStrength) ------
//
// ĐIỀU ĐANG ĐƯỢC BẢO VỆ: lớp Điều chỉnh không vẽ hình nào, nên Opacity của nó phải
// làm mờ dần CHÍNH BỘ CHỈNH mà nó áp. Cài đặt = kéo mọi thông số về trung tính theo
// tỉ lệ, để preview và bản xuất nhận CÙNG một object `adjustments` (không cần thêm
// một lượt trộn ở sidecar — thứ sẽ thành bản cài đặt thứ hai của cùng một phép).
// Test này chốt 3 điều: hai đầu mút, tính đơn điệu, và ĐỘ LỆCH so với pha alpha.

function withPatch(patch) {
    const a = ColorAdjust.normalize(null);
    Object.assign(a.basic, patch.basic || {});
    Object.assign(a.tone, patch.tone || {});
    Object.assign(a.effects, patch.effects || {});
    Object.keys(patch.hsl || {}).forEach((band) => Object.assign(a.hsl[band], patch.hsl[band]));
    Object.keys(patch.curves || {}).forEach((ch) => { a.curves[ch] = patch.curves[ch]; });
    Object.keys(patch.wheels || {}).forEach((w) => Object.assign(a.wheels[w], patch.wheels[w]));
    if (patch.lut) a.lut = { ...a.lut, ...patch.lut };
    return a;
}

function testScaleStrengthEndpoints() {
    const adj = withPatch({
        basic: { exposure: 30, contrast: 25, saturation: -40, temperature: 20, tint: -15 },
        tone: { shadows: 40, highlights: -30, whites: 20, blacks: -20, glow: 25 },
        effects: { sharpen: 60, blur: 30, grain: 20, vignette: -40 },
        hsl: { red: { h: 20, s: 40, l: -20 } },
        curves: { all: [[0, 0], [0.3, 0.18], [0.7, 0.82], [1, 1]] },
        wheels: { lift: { r: 30, g: -20, b: 10 } },
        lut: { id: 'x', name: 'X', intensity: 80 },
    });
    // 100% -> KHÔNG được sửa gì (đường thường: lớp không đặt Opacity)
    assert.deepStrictEqual(ColorAdjust.scaleStrength(adj, 1), ColorAdjust.normalize(adj),
        'cường độ 100% phải trả lại nguyên bộ chỉnh');
    // 0% -> identity, để mọi cửa nhanh (isIdentity/needsLut3d) tự bỏ qua lớp
    const off = ColorAdjust.scaleStrength(adj, 0);
    assert.ok(ColorAdjust.isIdentity(off), 'cường độ 0% phải cho isIdentity() = true');
    assert.strictEqual(off.lut.intensity, 0, 'cường độ 0% phải tắt cả LUT');
    assert.strictEqual(off.lut.id, 'x', 'nhưng KHÔNG được xoá LUT đã chọn (panel còn phải hiện tên)');
    assert.ok(ColorAdjust.CURVE_CHANNELS.every((ch) => ColorAdjust.curveIsIdentity(off.curves[ch])),
        'cường độ 0% phải kéo mọi đường cong về đường chéo');
    // Mặt nạ là HÌNH HỌC, không phải cường độ -> giữ nguyên
    const masked = ColorAdjust.scaleStrength(withPatch({ basic: { exposure: 20 } }), 0.5);
    assert.deepStrictEqual(masked.mask, ColorAdjust.defaultMask(), 'mặt nạ không được cường độ chạm vào');
    console.log('  ok  scaleStrength: 100% giữ nguyên · 0% về identity · mặt nạ không đổi');
}

function testScaleStrengthMonotone() {
    const adj = withPatch({
        basic: { exposure: 30, contrast: 25, saturation: -40 },
        tone: { shadows: 40 },
        lut: { id: 'x', intensity: 100 },
    });
    // Cường độ tăng -> kết quả phải đi XA gốc dần (không được lộn ngược ở giữa)
    const probe = [0.2, 0.45, 0.7];
    let prev = -1;
    [0, 0.2, 0.4, 0.6, 0.8, 1].forEach((k) => {
        const out = ColorAdjust.applyToRgb(ColorAdjust.scaleStrength(adj, k), probe);
        const dist = Math.hypot(out[0] - probe[0], out[1] - probe[1], out[2] - probe[2]);
        assert.ok(dist >= prev - 1e-9, `cường độ ${k} phải không gần gốc hơn mức trước (${dist} < ${prev})`);
        prev = dist;
    });
    console.log('  ok  scaleStrength: đơn điệu theo cường độ');
}

/* ĐỘ LỆCH SO VỚI PHA ALPHA — con số này là LỜI HỨA của tính năng, nên chốt bằng test.
 * Chỉ đo trên pixel mà bản ĐỦ CƯỜNG ĐỘ không bị kẹp biên: ở chỗ bị kẹp thì "pha đầu ra"
 * và "giảm cường độ" khác nhau về BẢN CHẤT (pha một pixel đã cháy trắng không đưa được
 * chi tiết trở lại), và ở đó giảm cường độ mới là cái người dùng muốn. */
function testScaleStrengthVsAlphaBlend() {
    const grid = [];
    for (let r = 1; r <= 9; r += 1) {
        for (let g = 1; g <= 9; g += 1) {
            for (let b = 1; b <= 9; b += 1) grid.push([r / 10, g / 10, b / 10]);
        }
    }
    const cases = [
        // eq (phơi sáng/tương phản/bão hoà) phải KHỚP TUYỆT ĐỐI: phơi sáng có nhánh
        // riêng trong scaleStrength đúng vì lý do này.
        { name: 'phơi sáng +40', adj: withPatch({ basic: { exposure: 40 } }), tol: 0.01 },
        { name: 'phơi sáng -40', adj: withPatch({ basic: { exposure: -40 } }), tol: 0.01 },
        { name: 'tương phản +40', adj: withPatch({ basic: { contrast: 40 } }), tol: 0.01 },
        { name: 'phơi sáng +25 + tương phản +30', adj: withPatch({ basic: { exposure: 25, contrast: 30 } }), tol: 0.01 },
        { name: 'bão hoà -60', adj: withPatch({ basic: { saturation: -60 } }), tol: 0.01 },
        // colorbalance cũng tuyến tính -> cũng khớp tuyệt đối
        { name: 'nhiệt độ +50', adj: withPatch({ basic: { temperature: 50 } }), tol: 0.01 },
        { name: 'vòng tròn màu lift', adj: withPatch({ wheels: { lift: { r: 40, b: -30 } } }), tol: 0.01 },
        // curves/tone là tra bảng 256 mức -> lệch chỉ là sai số lượng tử của bảng
        { name: 'curves chữ S', adj: withPatch({ curves: { all: [[0, 0], [0.25, 0.15], [0.75, 0.85], [1, 1]] } }), tol: 0.6 },
        { name: 'tone shadows +50', adj: withPatch({ tone: { shadows: 50 } }), tol: 0.6 },
        /* HSL là tầng KHÔNG tuyến tính thật sự: trọng số dải phụ thuộc chính sắc độ/bão
         * hoà của pixel, nên kéo `s` của dải != pha đầu ra. ~6/255 ở mức s=60 l=-30 là
         * mức đã đo — với một núm cường độ thì không nhìn ra được. */
        { name: 'HSL dải đỏ', adj: withPatch({ hsl: { red: { s: 60, l: -30 } } }), tol: 6 },
        // Nhiều tầng KHÔNG tuyến tính xếp chồng: pha đầu ra của cả chuỗi != pha thông số
        // từng tầng. Trần 12/255 là mức đã đo — nó ở đây để BẮT hồi quy, không phải để
        // nới ra khi có số đo xấu hơn.
        {
            name: 'tone + curves + HSL + eq',
            adj: withPatch({
                basic: { exposure: 25, contrast: 30, saturation: -30, temperature: 35 },
                tone: { shadows: 40, highlights: -30 },
                curves: { all: [[0, 0], [0.3, 0.2], [0.7, 0.8], [1, 1]] },
                hsl: { red: { s: 40 } },
            }),
            tol: 12,
        },
    ];
    cases.forEach(({ name, adj, tol }) => {
        let worst = 0;
        let counted = 0;
        [0.25, 0.5, 0.75].forEach((k) => {
            const scaled = ColorAdjust.scaleStrength(adj, k);
            grid.forEach((c) => {
                const full = ColorAdjust.applyToRgb(adj, c);
                if (full.some((v) => v <= 0.02 || v >= 0.98)) return;   // bỏ pixel bị kẹp
                const got = ColorAdjust.applyToRgb(scaled, c);
                counted += 1;
                for (let i = 0; i < 3; i += 1) {
                    worst = Math.max(worst, Math.abs(got[i] - (c[i] + (full[i] - c[i]) * k)) * 255);
                }
            });
        });
        assert.ok(counted > 100, `${name}: quá ít pixel không kẹp để phép đo có nghĩa (${counted})`);
        assert.ok(worst <= tol, `${name}: lệch ${worst.toFixed(2)}/255 so với pha alpha, trần ${tol}`);
        console.log(`  ok  ${name.padEnd(30)} lệch ${worst.toFixed(2)}/255 (trần ${tol})`);
    });
}

// Keyframe của bộ chỉnh cũng phải chịu cường độ: bản xuất dựng biểu thức/sendcmd TRỰC
// TIẾP từ các danh sách này, bỏ sót là preview mờ mà bản xuất vẫn đủ cường độ.
function testScaleStrengthKeyframes() {
    const kf = {
        'adj.basic.saturation': [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 80, e: 'ease-in-out' }],
        'adj.lut.intensity': [{ t: 0, v: 100 }, { t: 1, v: 40 }],
        'transform.opacity': [{ t: 0, v: 50 }],   // KHÔNG phải keyframe màu -> không được chạm
    };
    const out = ColorAdjust.scaleStrengthKeyframes(kf, 0.5);
    assert.deepStrictEqual(out['adj.basic.saturation'].map((p) => p.v), [0, 40], 'phải nhân giá trị keyframe màu');
    assert.deepStrictEqual(out['adj.basic.saturation'].map((p) => p.e), ['linear', 'ease-in-out'], 'phải giữ easing');
    assert.deepStrictEqual(out['adj.basic.saturation'].map((p) => p.t), [0, 2], 'phải giữ mốc thời gian');
    assert.deepStrictEqual(out['adj.lut.intensity'].map((p) => p.v), [50, 20], 'cường độ LUT cũng phải chịu');
    assert.deepStrictEqual(out['transform.opacity'], kf['transform.opacity'], 'không được chạm keyframe ngoài bộ chỉnh');
    assert.strictEqual(ColorAdjust.scaleStrengthKeyframes(kf, 1), kf, 'cường độ 100% phải trả lại chính object cũ');
    // Và phải KHỚP với đường tĩnh: nội suy rồi kéo == kéo rồi nội suy (cả hai tuyến tính)
    const evalFn = (list, t) => {
        const arr = list.slice().sort((a, b) => a.t - b.t);
        if (t <= arr[0].t) return arr[0].v;
        const last = arr[arr.length - 1];
        if (t >= last.t) return last.v;
        for (let i = 0; i < arr.length - 1; i += 1) {
            if (t <= arr[i + 1].t) {
                const p = (t - arr[i].t) / (arr[i + 1].t - arr[i].t);
                return arr[i].v + (arr[i + 1].v - arr[i].v) * p;
            }
        }
        return last.v;
    };
    const at1s = ColorAdjust.effectiveAdjustments(null, kf, 1, evalFn);
    const a = ColorAdjust.scaleStrength(at1s, 0.5).basic.saturation;
    const b = ColorAdjust.effectiveAdjustments(null, out, 1, evalFn).basic.saturation;
    assert.ok(Math.abs(a - b) < 1e-9, `kéo-rồi-nội-suy phải bằng nội-suy-rồi-kéo (${a} vs ${b})`);
    console.log('  ok  scaleStrengthKeyframes: khớp đường tĩnh, giữ t/easing, không chạm field khác');
}

function main() {
    console.log('adjust layer: cổng thời gian (toán thuần)');
    testEnableBetween();
    testEnableOnEveryFilter();
    testEnableOnLutSlot();
    console.log('adjust layer: Opacity = cường độ hiệu ứng');
    testScaleStrengthEndpoints();
    testScaleStrengthMonotone();
    testScaleStrengthKeyframes();
    testScaleStrengthVsAlphaBlend();
    if (!ffmpegAvailable()) {
        console.log('  (bỏ qua đối chiếu FFmpeg: không tìm thấy ffmpeg trong PATH)');
    } else {
        console.log('adjust layer: đối chiếu THẬT với FFmpeg');
        testTwoChainsMatchPreview();
        testEnableGatesInRealRender();
    }
    console.log('adjust layer pipeline ok');
}

main();
