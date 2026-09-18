/* Test MODULE static/js/color-adjust.js — bảo vệ hợp đồng WYSIWYG của panel
 * "Điều chỉnh" (Color Adjustments).
 *
 * ĐIỀU ĐANG ĐƯỢC BẢO VỆ: công thức mà PREVIEW dùng (ColorAdjust.applyToRgb — chính
 * là công thức trong GLSL shader) phải cho ra CÙNG KẾT QUẢ với chuỗi filter mà
 * EXPORT dùng (ColorAdjust.ffmpegFilters chạy qua FFmpeg thật). Nếu ai đó sửa một
 * bên mà quên bên kia, test này đổ.
 *
 * Phép so sánh chạy HOÀN TOÀN trong không gian YUV444 8-bit — giống hệt cái mà chuỗi
 * filter export nhìn thấy (nguồn h264 -> yuv420p) — để sai số của phép đổi RGB<->YUV
 * không lẫn vào kết quả đo.
 *
 * Cần `ffmpeg` trong PATH; không có thì các mục cần FFmpeg tự bỏ qua (phần toán
 * thuần vẫn chạy).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const ColorAdjust = require(path.join(PROJECT_ROOT, 'static', 'js', 'color-adjust.js'));

const W = 24;
const H = 24;
const PIXELS = W * H;

function ffmpegAvailable() {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

// --- BT.709 dải hẹp: byte plane <-> RGB 0..1 (khớp rgbToYuv/yuvToRgb trong shader) ---
function yuvBytesToRgb(y, u, v) {
    const yy = (y / 255 - 16 / 255) * (255 / 219);
    const uu = (u / 255 - 128 / 255) * (255 / 224);
    const vv = (v / 255 - 128 / 255) * (255 / 224);
    const r = yy + 1.5748 * vv;
    const b = yy + 1.8556 * uu;
    const g = (yy - 0.2126 * r - 0.0722 * b) / 0.7152;
    return [r, g, b].map((x) => Math.max(0, Math.min(1, x)));
}

function rgbToYuvBytes(r, g, b) {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return [
        (y * (219 / 255) + 16 / 255) * 255,
        ((b - y) / 1.8556 * (224 / 255) + 128 / 255) * 255,
        ((r - y) / 1.5748 * (224 / 255) + 128 / 255) * 255,
    ];
}

// Bộ mẫu tất định phủ đủ dải sáng và dải màu.
//
// QUAN TRỌNG: phải sinh từ màu RGB HỢP LỆ rồi mới đổi sang YUV. Nếu bốc đại giá trị
// Y/U/V thì phần lớn tổ hợp nằm NGOÀI gamut RGB — quy về RGB bị kẹp, và phép đo sau
// đó chỉ đang đo cái kẹp đó chứ không đo công thức chỉnh màu.
function buildSourcePlanes() {
    const y = Buffer.alloc(PIXELS);
    const u = Buffer.alloc(PIXELS);
    const v = Buffer.alloc(PIXELS);
    for (let i = 0; i < PIXELS; i += 1) {
        const rgb = [((i * 37) % 256) / 255, ((i * 91) % 256) / 255, ((i * 149) % 256) / 255];
        const [yy, uu, vv] = rgbToYuvBytes(rgb[0], rgb[1], rgb[2]);
        y[i] = Math.max(0, Math.min(255, Math.round(yy)));
        u[i] = Math.max(0, Math.min(255, Math.round(uu)));
        v[i] = Math.max(0, Math.min(255, Math.round(vv)));
    }
    return Buffer.concat([y, u, v]);
}

function runFfmpegChain(workDir, srcPath, chain) {
    const outPath = path.join(workDir, 'out.yuv');
    execFileSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-s', `${W}x${H}`,
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        '-i', srcPath,
        '-vf', ['setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709', ...chain].join(','),
        '-f', 'rawvideo', '-pix_fmt', 'yuv444p', outPath,
    ]);
    return fs.readFileSync(outPath);
}

// Sai số tối đa cho phép, đơn vị 1/255 trên kênh R/G/B ĐÃ HIỂN THỊ (tức cái mắt
// người nhìn thấy: preview vs frame xuất ra).
//
// Nguồn sai số KHÔNG THỂ loại bỏ: mọi filter màu của FFmpeg đều chạy qua bảng tra
// 8-bit (`eq` còn khuếch đại sai số đó theo contrast), YUV trung gian làm tròn thêm
// một lần nữa, còn preview thì tính liên tục bằng float trên GPU. Một bước đơn lẻ đo
// được ≤5/255; kéo hết 5 subtab cùng lúc thì cộng dồn lên ~14/255 ở vài pixel cá biệt.
//
// Ngưỡng này để BẮT LỖI CÔNG THỨC, không phải để đo chất lượng: khi công thức
// colorbalance sai (dùng lightness /2) test cho 36-111/255, tức lệch thật luôn cao
// hơn hẳn nhiễu lượng tử. Nới ngưỡng ra chỉ khi có lý do rõ ràng.
const TOLERANCE = 16;

function compareCase(workDir, srcPath, srcPlanes, name, adj, cube) {
    let lutPath = '';
    if (cube) {
        lutPath = path.join(workDir, `${name.replace(/[^a-z0-9]+/gi, '_')}.cube`);
        fs.writeFileSync(lutPath, ColorAdjust.cubeToText(cube));
    }
    const chain = ColorAdjust.ffmpegFilters(adj, lutPath);
    const got = runFfmpegChain(workDir, srcPath, chain);

    let maxDiff = 0;
    let sum = 0;
    let worst = null;
    const diffs = [];
    for (let i = 0; i < PIXELS; i += 1) {
        const rgbIn = yuvBytesToRgb(srcPlanes[i], srcPlanes[PIXELS + i], srcPlanes[2 * PIXELS + i]);
        // preview: shader tính trên RGB rồi kẹp về dải hiển thị. Truyền CHÍNH cube đã
        // bake vào — shader cũng nạp đúng bảng này thành texture, nên đây mới là so
        // sánh trung thực (nếu để null thì đang so HSL giải tích với lut3d, lệch giả).
        const expect = ColorAdjust.applyToRgb(adj, rgbIn, cube || null).map((v) => v * 255);
        // export: giải mã YUV mà FFmpeg trả về ra đúng RGB sẽ hiện lên màn hình
        const actual = yuvBytesToRgb(got[i], got[PIXELS + i], got[2 * PIXELS + i]).map((v) => v * 255);
        for (let c = 0; c < 3; c += 1) {
            const d = Math.abs(actual[c] - expect[c]);
            sum += d;
            diffs.push(d);
            if (d > maxDiff) {
                maxDiff = d;
                worst = { pixel: i, channel: 'RGB'[c], expect: expect[c].toFixed(1), actual: actual[c].toFixed(1) };
            }
        }
    }
    const avg = sum / (PIXELS * 3);
    diffs.sort((a, b) => a - b);
    const p95 = diffs[Math.floor(diffs.length * 0.95)];
    console.log(`  ${name.padEnd(26)} max=${maxDiff.toFixed(1)}  p95=${p95.toFixed(1)}  avg=${avg.toFixed(2)}  (${chain.length} filter)`);
    assert.ok(
        maxDiff <= TOLERANCE,
        `preview và export lệch quá ngưỡng ở "${name}": ${maxDiff.toFixed(1)} > ${TOLERANCE}\n`
        + `  worst=${JSON.stringify(worst)}\n  chain=${chain.join(',')}`,
    );
    return maxDiff;
}

function mk(fn) {
    const a = ColorAdjust.defaultAdjustments();
    fn(a);
    return a;
}

// ---------------------------------------------------------------- phần toán thuần
function testPureMath() {
    const def = ColorAdjust.defaultAdjustments();
    assert.ok(ColorAdjust.isIdentity(def), 'mặc định phải là identity');
    assert.deepStrictEqual(ColorAdjust.ffmpegFilters(def), [], 'identity không sinh filter nào');
    assert.ok(!ColorAdjust.needsLut3d(def), 'identity không cần lut3d');

    // normalize phải kẹp và vá dữ liệu rác từ .crab cũ
    const dirty = ColorAdjust.normalize({
        basic: { exposure: 999, contrast: 'x', saturation: -500 },
        hsl: { blue: { s: 250 } },
        curves: { all: [[0.5, 0.7], [0.2, 0.3]] },   // chưa sắp xếp, thiếu 2 biên
        lut: { id: 'a'.repeat(500), intensity: -20 },
    });
    assert.strictEqual(dirty.basic.exposure, 100);
    assert.strictEqual(dirty.basic.contrast, 0);
    assert.strictEqual(dirty.basic.saturation, -100);
    assert.strictEqual(dirty.hsl.blue.s, 100);
    assert.strictEqual(dirty.curves.all[0][0], 0, 'curve phải có điểm ở x=0');
    assert.strictEqual(dirty.curves.all[dirty.curves.all.length - 1][0], 1, 'curve phải có điểm ở x=1');
    assert.ok(dirty.curves.all.every((p, i, arr) => i === 0 || p[0] > arr[i - 1][0]), 'x phải tăng dần');
    assert.strictEqual(dirty.lut.intensity, 0);
    assert.strictEqual(dirty.lut.id.length, 200);

    // Spline: đi qua đúng điểm điều khiển
    const lut = ColorAdjust.curveLut([[0, 0], [0.25, 0.15], [0.75, 0.85], [1, 1]]);
    assert.ok(Math.abs(lut[0] - 0) < 1e-6);
    assert.ok(Math.abs(lut[255] - 1) < 1e-6);
    assert.ok(Math.abs(lut[64] - 0.15) < 0.01, `spline tại x=0.25 phải ~0.15, có ${lut[64]}`);
    assert.ok(Math.abs(lut[191] - 0.85) < 0.01, `spline tại x=0.75 phải ~0.85, có ${lut[191]}`);
    // Đường chéo -> LUT tuyến tính
    const idLut = ColorAdjust.curveLut(ColorAdjust.defaultCurve());
    for (let i = 0; i < 256; i += 37) assert.ok(Math.abs(idLut[i] - i / 255) < 1e-6);

    // Trọng số 8 dải HSL luôn cộng lại bằng 1 (không có vùng hue nào bị bỏ sót)
    for (let h = 0; h < 360; h += 7) {
        const sum = ColorAdjust.bandWeights(h).reduce((a, b) => a + b, 0);
        assert.ok(Math.abs(sum - 1) < 1e-6, `tổng trọng số tại hue ${h} = ${sum}`);
    }

    // .cube: bake -> text -> parse phải khứ hồi
    const hslAdj = mk((a) => { a.hsl.blue.s = 60; a.hsl.red.h = -40; });
    const cube = ColorAdjust.bakeCube(hslAdj, null, 17);
    const round = ColorAdjust.parseCube(ColorAdjust.cubeToText(cube));
    assert.strictEqual(round.size, 17);
    let cubeMax = 0;
    for (let i = 0; i < cube.data.length; i += 1) cubeMax = Math.max(cubeMax, Math.abs(round.data[i] - cube.data[i]));
    assert.ok(cubeMax < 1e-5, `khứ hồi .cube lệch ${cubeMax}`);

    // .cube identity (không HSL, không LUT) phải là bảng đồng nhất
    const idCube = ColorAdjust.bakeCube(ColorAdjust.defaultAdjustments(), null, 9);
    for (let i = 0; i < idCube.data.length; i += 3) {
        const bi = Math.floor(i / 3 / 81), gi = Math.floor(i / 3 / 9) % 9, ri = (i / 3) % 9;
        assert.ok(Math.abs(idCube.data[i] - ri / 8) < 1e-6, 'cube identity phải trả về chính màu vào');
        assert.ok(Math.abs(idCube.data[i + 1] - gi / 8) < 1e-6);
        assert.ok(Math.abs(idCube.data[i + 2] - bi / 8) < 1e-6);
    }

    // parseCube phải từ chối file hỏng
    assert.throws(() => ColorAdjust.parseCube('LUT_3D_SIZE 4\n0 0 0\n'), /Số dòng dữ liệu LUT sai/);
    assert.throws(() => ColorAdjust.parseCube('nothing here'), /LUT_3D_SIZE/);

    // Trộn theo intensity: 0% phải bằng đúng không áp LUT
    const strongLut = ColorAdjust.parseCube(ColorAdjust.cubeToText(
        ColorAdjust.bakeCube(mk((a) => { a.hsl.green.s = 100; }), null, 9),
    ));
    const zero = ColorAdjust.bakeCube(mk((a) => { a.lut.id = 'x'; a.lut.intensity = 0; }), strongLut, 9);
    for (let i = 0; i < zero.data.length; i += 1) assert.ok(Math.abs(zero.data[i] - idCube.data[i]) < 1e-6);

    // Ảnh xám tuyệt đối không bị HSL đụng vào (hue vô nghĩa)
    const grey = ColorAdjust.applyHsl([0.5, 0.5, 0.5], ColorAdjust.normalize(hslAdj));
    assert.deepStrictEqual(grey.map((v) => Math.round(v * 1000)), [500, 500, 500]);

    // ---------------- ĐƯỜNG CONG TONE (nhóm Độ sáng) ----------------
    assert.ok(ColorAdjust.toneIsIdentity(ColorAdjust.defaultTone()), 'tone mặc định phải là identity');
    assert.strictEqual(ColorAdjust.toneCurvePoints(ColorAdjust.defaultAdjustments()), null,
        'tone identity phải trả null (không sinh filter)');
    const toneAdj = mk((a) => { a.tone.highlights = 50; a.tone.shadows = -30; a.tone.whites = 20; a.tone.blacks = -10; });
    const tonePts = ColorAdjust.toneCurvePoints(toneAdj);
    assert.ok(Array.isArray(tonePts) && tonePts.length >= 5, 'tone curve phải có đủ điểm điều khiển');
    assert.ok(tonePts[0][0] === 0 && tonePts[tonePts.length - 1][0] === 1,
        'tone curve phải có điểm ở x=0 và x=1');
    for (let i = 1; i < tonePts.length; i += 1) {
        assert.ok(tonePts[i][0] > tonePts[i - 1][0], 'x của tone curve phải tăng nghiêm ngặt');
        assert.ok(tonePts[i][1] >= tonePts[i - 1][1] - 1e-9, 'tone curve phải đơn điệu không giảm');
    }
    const toneIdLut = ColorAdjust.toneLut(ColorAdjust.defaultAdjustments());
    assert.ok(Math.abs(toneIdLut[128] - 128 / 255) < 1e-6, 'tone identity phải tuyến tính');
    assert.ok(!ColorAdjust.isIdentity(toneAdj), 'tone != 0 -> isIdentity phải false');

    // Tra bảng theo mức 8-bit (đúng cái shader và filter `curves` thực sự dùng).
    const toneAt = (adj, level) => Math.round(ColorAdjust.toneLut(adj)[level] * 255);
    const toneOnly = (key, value) => mk((a) => { a.tone[key] = value; });

    // CHỐT CHẶN 1 — MỖI slider phải có tác dụng THẤY ĐƯỢC ở vùng của nó, CẢ HAI CHIỀU.
    // Bản đầu dịch y ngay tại 2 điểm biên nên "Vùng sáng nhất" tăng bị kẹp trần y=1 và
    // "Vùng tối nhất" giảm bị kẹp sàn y=0 -> hai slider CHẾT HOÀN TOÀN (đo được
    // 128->128, 32->32, 224->224) mà không có test nào đổ.
    const TONE_PROBE = {
        shadows: 64,       // vùng tối
        highlights: 192,   // vùng sáng
        glow: 96,          // vùng trung-tối
        blacks: 32,        // sát đáy
        whites: 224,       // sát đỉnh
    };
    Object.entries(TONE_PROBE).forEach(([key, level]) => {
        [100, -100].forEach((value) => {
            const delta = toneAt(toneOnly(key, value), level) - level;
            assert.ok(
                Math.abs(delta) >= 8,
                `tone.${key}=${value} gần như không đổi gì tại mức ${level}`
                + ` (lệch ${delta}/255) — slider coi như chết`,
            );
            // Chiều phải đúng: dương = sáng lên, âm = tối đi
            assert.ok(
                (value > 0 && delta > 0) || (value < 0 && delta < 0),
                `tone.${key}=${value} đổi SAI CHIỀU tại mức ${level} (lệch ${delta}/255)`,
            );
        });
    });

    // CHỐT CHẶN 2 — tác động phải CỤC BỘ. Nếu chỉ đặt một điểm điều khiển rời rồi để
    // spline tự nối 2 biên thì tác động lan ra toàn dải: đo được shadows=100 đẩy xám
    // 128 lên 196, tức "Bóng" biến thành "độ sáng tổng".
    const TONE_FAR_END = {
        shadows: 240,      // Bóng không được đụng vùng sáng
        highlights: 16,    // Vùng sáng không được đụng vùng tối
        whites: 32,
        blacks: 224,
    };
    Object.entries(TONE_FAR_END).forEach(([key, level]) => {
        [100, -100].forEach((value) => {
            const delta = Math.abs(toneAt(toneOnly(key, value), level) - level);
            assert.ok(delta <= 2, `tone.${key}=${value} lan sang mức ${level} (lệch ${delta}/255)`
                + ' — thông số này phải chỉ tác động vùng sáng của riêng nó');
        });
    });

    // CHỐT CHẶN 3 — MỘT CHIỀU: thông số dương không được làm TỐI ở bất kỳ mức nào, và
    // ngược lại. Mỗi thông số là một "bump" một dấu nên toàn bộ đường cong phải dịch
    // về đúng một phía. Bản đầu ghim cứng điểm ở x=0.4 nên nâng Bóng lên 100 lại làm
    // TỐI trung tính (đo được 128->115) — ngược hẳn kỳ vọng, mà 2 chốt chặn trên
    // không bắt được vì chúng chỉ soi vùng của riêng thông số đó.
    ['shadows', 'highlights', 'glow', 'blacks', 'whites'].forEach((key) => {
        [100, -100].forEach((value) => {
            const lut = ColorAdjust.toneLut(toneOnly(key, value));
            for (let i = 0; i < 256; i += 1) {
                const delta = Math.round(lut[i] * 255) - i;
                if (value > 0) {
                    assert.ok(delta >= -1, `tone.${key}=+100 lại LÀM TỐI mức ${i} (lệch ${delta}/255)`);
                } else {
                    assert.ok(delta <= 1, `tone.${key}=-100 lại LÀM SÁNG mức ${i} (lệch ${delta}/255)`);
                }
            }
        });
    });

    // CHỐT CHẶN 4 — bảng tra không được LẬT (lật = đảo sáng + banding). Cho phép sai số
    // dưới 1 bậc lượng tử: spline vượt biên nhẹ giữa 2 điểm là chuyện bình thường và
    // biến mất khi làm tròn về 8-bit (đo được sâu nhất 0.24/255).
    ['shadows', 'highlights', 'glow', 'blacks', 'whites'].forEach((key) => {
        [100, -100].forEach((value) => {
            const lut = ColorAdjust.toneLut(toneOnly(key, value));
            let deepest = 0;
            for (let i = 1; i < lut.length; i += 1) deepest = Math.max(deepest, lut[i - 1] - lut[i]);
            assert.ok(deepest * 255 < 1, `tone.${key}=${value} làm đường cong lật ${(deepest * 255).toFixed(2)}/255`);
        });
    });

    // CHỐT CHẶN LỖI "LUT KHÔNG ĂN NGAY": lutStageSignature PHẢI đổi sau khi
    // registerUserLut đăng ký nội dung .cube mới — kể cả khi lut.id/intensity không
    // đổi. Nếu chữ ký không đổi, các cache texture (ClipColorAdjustFilter,
    // CanvasColorRenderer) giữ texture cũ → preview đứng yên tới khi user kéo
    // cường độ (lúc đó intensity đổi → chữ ký mới đổi → mới thấy LUT).
    const lutAdj = mk((a) => { a.lut.id = 'test-lut-rev'; a.lut.intensity = 80; });
    const sigBefore = ColorAdjust.lutStageSignature(lutAdj);
    ColorAdjust.registerUserLut('test-lut-rev', ColorAdjust.bakeCube(
        mk((a) => { a.hsl.red.s = 50; }), null, 9));
    const sigAfter = ColorAdjust.lutStageSignature(lutAdj);
    assert.notStrictEqual(sigBefore, sigAfter,
        'lutStageSignature phải ĐỔI sau registerUserLut (chốt chặn lỗi LUT không ăn ngay)');
    // Cùng nội dung nhưng intensity khác -> vẫn phải đổi (không chỉ phụ thuộc revision)
    const sigMid = ColorAdjust.lutStageSignature(mk((a) => { a.lut.id = 'test-lut-rev'; a.lut.intensity = 50; }));
    assert.notStrictEqual(sigMid, sigAfter, 'intensity khác -> chữ ký phải khác');

    console.log('  phần toán thuần ok');
}

// ------------------------------------------------------- đối chiếu với FFmpeg thật
function testAgainstFfmpeg() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-coloradjust-'));
    try {
        const srcPlanes = buildSourcePlanes();
        const srcPath = path.join(workDir, 'src.yuv');
        fs.writeFileSync(srcPath, srcPlanes);

        // 1) Không chỉnh gì -> FFmpeg phải trả về đúng byte gốc (chuỗi filter rỗng)
        const passthrough = runFfmpegChain(workDir, srcPath, []);
        assert.ok(passthrough.equals(srcPlanes), 'chuỗi rỗng phải không đổi 1 byte nào');

        const cases = [
            ['exposure +30', mk((a) => { a.basic.exposure = 30; })],
            ['exposure -35', mk((a) => { a.basic.exposure = -35; })],
            ['contrast +40', mk((a) => { a.basic.contrast = 40; })],
            ['contrast -40', mk((a) => { a.basic.contrast = -40; })],
            ['saturation -50', mk((a) => { a.basic.saturation = -50; })],
            ['saturation +60', mk((a) => { a.basic.saturation = 60; })],
            ['temperature +50', mk((a) => { a.basic.temperature = 50; })],
            ['tint -40', mk((a) => { a.basic.tint = -40; })],
            ['3 vòng tròn màu', mk((a) => {
                a.wheels.lift.r = 30; a.wheels.gamma.g = -25; a.wheels.gain.b = -40;
            })],
            ['curves chữ S', mk((a) => { a.curves.all = [[0, 0], [0.25, 0.15], [0.75, 0.85], [1, 1]]; })],
            ['curves all + r/g/b', mk((a) => { a.curves.all = [[0,0],[0.5,0.58],[1,1]];
                a.curves.r = [[0, 0.05], [1, 1]];
                a.curves.g = [[0, 0], [0.5, 0.55], [1, 1]];
                a.curves.b = [[0, 0], [0.5, 0.42], [1, 0.95]];
            })],
            ['cơ bản + curves', mk((a) => {
                a.basic.exposure = 15; a.basic.contrast = 25; a.basic.saturation = -20; a.basic.temperature = 30;
                a.curves.all = [[0, 0], [0.5, 0.55], [1, 1]];
            })],
            ['tone highlights +50', mk((a) => { a.tone.highlights = 50; })],
            ['tone shadows -40', mk((a) => { a.tone.shadows = -40; })],
            ['tone whites +30 blacks -30', mk((a) => { a.tone.whites = 30; a.tone.blacks = -30; })],
            ['tone glow +60', mk((a) => { a.tone.glow = 60; })],
            ['tone 5 thông số', mk((a) => {
                a.tone.highlights = 40; a.tone.shadows = -35; a.tone.whites = 25; a.tone.blacks = -20; a.tone.glow = 30;
            })],
            ['cơ bản + tone + curves', mk((a) => {
                a.basic.exposure = 10; a.basic.contrast = 15;
                a.tone.highlights = 35; a.tone.shadows = -25;
                a.curves.all = [[0, 0], [0.5, 0.58], [1, 1]];
            })],
        ];
        cases.forEach(([name, adj]) => compareCase(workDir, srcPath, srcPlanes, name, adj));

        // Các trường hợp có HSL/LUT -> phải kèm .cube đã bake
        const hslAdj = mk((a) => { a.hsl.blue.s = 60; a.hsl.red.h = -40; a.hsl.green.l = 35; });
        compareCase(workDir, srcPath, srcPlanes, 'hsl 3 dải (lut3d)', hslAdj,
            ColorAdjust.bakeCube(hslAdj, null, 33));

        const allAdj = mk((a) => {
            a.basic.exposure = 12; a.basic.contrast = 20; a.basic.saturation = 15;
            a.basic.temperature = -25; a.basic.tint = 10;
            a.wheels.lift.b = 20; a.wheels.gamma.r = -15; a.wheels.gain.g = 10;
            a.curves.all = [[0, 0], [0.3, 0.26], [0.7, 0.74], [1, 1]];
            a.hsl.aqua.s = -50; a.hsl.orange.l = 20;
        });
        compareCase(workDir, srcPath, srcPlanes, 'TẤT CẢ cùng lúc', allAdj,
            ColorAdjust.bakeCube(allAdj, null, 33));
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

// ---------------------------------------- end-to-end qua SIDECAR C++
//
// 2 mục trên đã chứng minh "công thức khớp FFmpeg". Mục này chứng minh phần còn lại:
// chuỗi filter thực sự ĐẾN ĐƯỢC ffmpeg qua sidecar, chèn ĐÚNG CHỖ trong filter script
// (trước format=rgba) và không làm hỏng filtergraph.
const SIDECAR = path.join(PROJECT_ROOT, 'native', 'sidecar', 'build',
    process.platform === 'win32' ? 'core_process.exe' : 'core_process');

function samplePixel(videoPath, seconds) {
    const out = spawnSync('ffmpeg', [
        '-v', 'error', '-ss', String(seconds), '-i', videoPath,
        '-frames:v', '1', '-vf', 'crop=8:8:100:100,scale=1:1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
    return [out.stdout[0], out.stdout[1], out.stdout[2]];
}

function testSidecarEndToEnd() {
    if (!fs.existsSync(SIDECAR)) {
        console.log('  (bỏ qua end-to-end: chưa build sidecar — chạy npm run build:sidecar)');
        return;
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-coloradjust-e2e-'));
    try {
        // Nguồn: 2 giây màu phẳng đã biết, h264 yuv420p bt709 (giống nguồn thật của app).
        // PHẢI có track audio: filter script của sidecar luôn tham chiếu [0:a], nguồn
        // câm sẽ làm ffmpeg báo "Stream specifier ':a' matches no streams".
        const srcVideo = path.join(workDir, 'src.mp4');
        execFileSync('ffmpeg', [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'color=c=0x4C7FB2:s=320x240:d=2:r=25',
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2',
            '-shortest',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
            '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
            srcVideo,
        ]);

        const adj = mk((a) => {
            a.basic.exposure = 25;
            a.basic.contrast = 30;
            a.basic.saturation = -40;
            a.basic.temperature = 35;
            a.curves.all = [[0, 0], [0.5, 0.58], [1, 1]];
        });
        const chain = ColorAdjust.ffmpegFilters(adj);
        const payload = {
            resolution: 'source', width: 320, height: 240,
            fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
            intervals: [{
                index: 0, start: 0.2, end: 1.8, position_x: 0, position_y: 0,
                scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
                adj_filters: chain.join(','),
            }],
        };
        const payloadPath = path.join(workDir, 'export_timeline.json');
        fs.writeFileSync(payloadPath, JSON.stringify(payload));
        const outPath = path.join(workDir, 'out.mp4');
        const result = spawnSync(SIDECAR, [
            'export-video', srcVideo, outPath, payloadPath, workDir, 'high', '25',
        ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
        assert.strictEqual(result.status, 0, `sidecar lỗi:\n${result.stdout}\n${result.stderr}`);
        assert.ok(fs.existsSync(outPath), 'sidecar không tạo được file xuất');

        // Kỳ vọng = màu nguồn cho qua chính công thức của preview.
        const srcRgb = samplePixel(srcVideo, 0.5);
        const expect = ColorAdjust.applyToRgb(adj, srcRgb.map((v) => v / 255), null).map((v) => v * 255);
        const got = samplePixel(outPath, 0.5);
        const diff = Math.max(...got.map((g, i) => Math.abs(g - expect[i])));
        console.log(`  end-to-end sidecar        nguồn ${srcRgb} -> xuất ${got}`
            + `  (preview kỳ vọng ${expect.map((v) => v.toFixed(0))})  lệch=${diff.toFixed(1)}`);
        // Ngưỡng rộng hơn mục trên: thêm một lượt encode h264 có mất mát ở giữa.
        assert.ok(diff <= 10, `frame xuất lệch preview ${diff.toFixed(1)}/255 (chain=${chain.join(',')})`);
        // Chốt chặn: nếu filter KHÔNG được chèn thì output = nguồn, phải khác rõ rệt.
        const untouched = Math.max(...got.map((g, i) => Math.abs(g - srcRgb[i])));
        assert.ok(untouched > 15, 'frame xuất giống hệt nguồn -> chuỗi filter chưa được chèn');

        testMaskSidecar(workDir);
        testAdjustKeyframeSidecar(workDir);
        testSendcmdSidecar(workDir);
        testToneSendcmdSidecar(workDir);
        testLutMixSidecar(workDir);
        testEffectsKeyframeSidecar(workDir);
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

// ---------------------------------- CÂN BẰNG TRẮNG ----------------------------------
//
// solveWhiteBalance phải tìm được cặp (temperature, tint) làm điểm được chọn trở thành
// TRUNG TÍNH ở mốc "sau colorbalance". Nghiệm là dạng ĐÓNG (không dò lặp) nên test đo
// thẳng: áp nghiệm vào rồi xem 3 kênh còn lệch nhau bao nhiêu.
function afterColorbalance(adj, src) {
    // Dựng lại đúng mốc mà solveWhiteBalance nhắm tới: qua eq+tone rồi qua colorbalance,
    // bỏ hết curves/HSL/LUT/hiệu ứng.
    const pre = ColorAdjust.normalize(adj);
    pre.basic.temperature = 0;
    pre.basic.tint = 0;
    ColorAdjust.WHEEL_KEYS.forEach((k) => { pre.wheels[k] = { r: 0, g: 0, b: 0 }; });
    ColorAdjust.CURVE_CHANNELS.forEach((ch) => { pre.curves[ch] = ColorAdjust.defaultCurve(); });
    ColorAdjust.HSL_BANDS.forEach((b) => { pre.hsl[b.key] = { h: 0, s: 0, l: 0 }; });
    pre.lut = { id: '', name: '', intensity: 100 };
    pre.effects = ColorAdjust.defaultEffects();
    const c = ColorAdjust.applyToRgb(pre, src);
    const cb = ColorAdjust.colorbalanceParams(adj);
    const l = ColorAdjust.cbLightness(c[0], c[1], c[2]);
    return [
        ColorAdjust.cbComponent(c[0], l, cb.rs, cb.rm, cb.rh),
        ColorAdjust.cbComponent(c[1], l, cb.gs, cb.gm, cb.gh),
        ColorAdjust.cbComponent(c[2], l, cb.bs, cb.bm, cb.bh),
    ];
}

function testWhiteBalance() {
    const cases = [
        ['xám lệch ấm', [0.62, 0.52, 0.42]],
        ['xám lệch lạnh', [0.40, 0.50, 0.64]],
        ['xám lệch lục', [0.45, 0.58, 0.46]],
        ['xám lệch hồng', [0.58, 0.44, 0.56]],
        ['gần trung tính', [0.505, 0.500, 0.498]],
        ['vùng tối', [0.14, 0.10, 0.07]],
        ['vùng sáng', [0.90, 0.86, 0.80]],
    ];
    cases.forEach(([name, src]) => {
        const base = ColorAdjust.defaultAdjustments();
        const wb = ColorAdjust.solveWhiteBalance(base, src);
        assert.ok(wb, `solveWhiteBalance trả null ở "${name}"`);
        const applied = ColorAdjust.normalize(base);
        applied.basic.temperature = wb.temperature;
        applied.basic.tint = wb.tint;
        const out = afterColorbalance(applied, src);
        const spread = (Math.max(...out) - Math.min(...out)) * 255;
        assert.ok(spread <= 2,
            `"${name}": sau cân bằng trắng 3 kênh còn lệch ${spread.toFixed(1)}/255`
            + ` (temp=${wb.temperature}, tint=${wb.tint})`);
        // Chiều phải hợp lý: ảnh lệch ẤM (r>b) thì phải bù về phía LẠNH (temp âm)
        if (src[0] - src[2] > 0.05) assert.ok(wb.temperature < 0, `"${name}" phải bù nhiệt độ âm`);
        if (src[2] - src[0] > 0.05) assert.ok(wb.temperature > 0, `"${name}" phải bù nhiệt độ dương`);
    });

    // Phải giải đúng cả khi đã có eq/tone/vòng tròn màu đứng trước
    const withPrior = mk((a) => {
        a.basic.exposure = 20; a.basic.contrast = 15; a.tone.shadows = 30; a.wheels.gain.b = 25;
    });
    const src = [0.60, 0.52, 0.44];
    const wb = ColorAdjust.solveWhiteBalance(withPrior, src);
    assert.ok(wb, 'solveWhiteBalance phải chạy được khi đã có eq/tone/vòng màu');
    const applied = ColorAdjust.normalize(withPrior);
    applied.basic.temperature = wb.temperature;
    applied.basic.tint = wb.tint;
    const out = afterColorbalance(applied, src);
    const spread = (Math.max(...out) - Math.min(...out)) * 255;
    assert.ok(spread <= 2, `có eq/tone/vòng màu: còn lệch ${spread.toFixed(1)}/255`);

    // Vùng đã KẸP đen/trắng phải bị TỪ CHỐI: ở đó không còn thông tin màu nên nghiệm sẽ
    // ra 0 và người dùng tưởng nút bị hỏng.
    // (Đừng dùng K≈0 làm điều kiện loại: ở đen tuyệt đối K=0.7 vì trọng số shadows đạt
    //  cực đại — đã mắc lỗi này.)
    const defAdj = ColorAdjust.defaultAdjustments();
    assert.strictEqual(ColorAdjust.solveWhiteBalance(defAdj, [0, 0, 0]), null, 'đen tuyệt đối phải trả null');
    assert.strictEqual(ColorAdjust.solveWhiteBalance(defAdj, [1, 1, 1]), null, 'trắng kẹp phải trả null');
    assert.strictEqual(ColorAdjust.solveWhiteBalance(defAdj, [0.02, 0.01, 0.03]), null, 'gần đen phải trả null');
    assert.ok(ColorAdjust.solveWhiteBalance(defAdj, [0.3, 0.25, 0.2]), 'vùng tối VỪA PHẢI thì vẫn phải giải được');
    assert.ok(Number.isFinite(ColorAdjust.cbWeightSum(0)), 'cbWeightSum phải hữu hạn ở l=0');
    assert.ok(Math.abs(ColorAdjust.cbWeightSum(0) - 0.7) < 1e-9,
        'ở l=0 trọng số shadows phải đạt cực đại (0.7) — chốt lại để không ai lại tưởng K≈0');
    console.log('  cân bằng trắng ok');
}

// ------------------------- ỐNG HÚT CHỌN DẢI MÀU (subtab HSL) -------------------------
//
// Ống hút HSL không ghi dữ liệu, nó chỉ chuyển ô màu đang chọn sang dải mà điểm vừa hút
// thuộc về. Điều PHẢI đúng: dải chọn ra bằng bandWeights phải là dải mà shader/lut3d
// thực sự tác động mạnh nhất lên màu đó — nếu lệch, người dùng kéo slider mà thấy màu
// khác đổi.
function testHslBandPick() {
    const pickBand = (rgb) => {
        const [hue] = ColorAdjust.rgbToHsl(rgb[0], rgb[1], rgb[2]);
        const w = ColorAdjust.bandWeights(hue);
        let best = 0;
        w.forEach((v, i) => { if (v > w[best]) best = i; });
        return ColorAdjust.HSL_BANDS[best].key;
    };
    const cases = [
        [[0.85, 0.12, 0.12], 'red'],
        [[0.95, 0.55, 0.10], 'orange'],
        [[0.95, 0.90, 0.15], 'yellow'],
        [[0.15, 0.80, 0.25], 'green'],
        [[0.15, 0.85, 0.85], 'aqua'],
        [[0.10, 0.30, 0.90], 'blue'],
        [[0.55, 0.20, 0.90], 'purple'],
        [[0.95, 0.20, 0.65], 'magenta'],
    ];
    cases.forEach(([rgb, expected]) => {
        assert.strictEqual(pickBand(rgb), expected,
            `hút màu rgb(${rgb.map((v) => Math.round(v * 255))}) phải ra dải "${expected}",`
            + ` không phải "${pickBand(rgb)}"`);
    });

    // Dải chọn ra phải LÀ dải tác động mạnh nhất thật sự: kéo dải đó lên thì màu đổi
    // nhiều hơn hẳn so với kéo một dải khác. Đây mới là điều người dùng cảm nhận.
    const probe = [0.10, 0.30, 0.90];              // lam
    const band = pickBand(probe);
    const shift = (key) => {
        const a = ColorAdjust.defaultAdjustments();
        a.hsl[key].l = 100;
        const out = ColorAdjust.applyHsl(probe, ColorAdjust.normalize(a));
        return Math.max(...out.map((v, i) => Math.abs(v - probe[i])));
    };
    const own = shift(band);
    const other = shift(band === 'green' ? 'red' : 'green');
    assert.ok(own > other * 3,
        `dải "${band}" phải tác động mạnh hơn hẳn dải khác lên chính màu đó (${own.toFixed(3)} vs ${other.toFixed(3)})`);
    console.log('  ống hút chọn dải HSL ok');
}

// ------------------------------- NHÓM HIỆU ỨNG (không gian) -------------------------------
//
// Không dùng compareCase được: unsharp/avgblur/vignette đọc pixel LÂN CẬN nên tham chiếu
// phải là applyToImage (cả ảnh) chứ không phải applyToRgb (từng pixel).
const FX_W = 64;
const FX_H = 64;
const FX_PIXELS = FX_W * FX_H;

// Ảnh thử phải có CẢ cạnh sắc (để unsharp/blur bộc lộ) lẫn vùng phẳng và dốc màu.
function buildFxImage() {
    const rgb = new Float32Array(FX_PIXELS * 3);
    for (let y = 0; y < FX_H; y += 1) {
        for (let x = 0; x < FX_W; x += 1) {
            const i = (y * FX_W + x) * 3;
            const checker = ((x >> 3) + (y >> 3)) % 2 === 0;
            rgb[i] = checker ? 0.75 : 0.2;
            rgb[i + 1] = checker ? 0.35 : 0.65;
            rgb[i + 2] = (x / (FX_W - 1)) * 0.8 + 0.1;
        }
    }
    return rgb;
}

function compareFxCase(workDir, name, adj, limits) {
    const srcRgb = buildFxImage();
    const Y = Buffer.alloc(FX_PIXELS);
    const U = Buffer.alloc(FX_PIXELS);
    const V = Buffer.alloc(FX_PIXELS);
    for (let i = 0; i < FX_PIXELS; i += 1) {
        const [yy, uu, vv] = rgbToYuvBytes(srcRgb[i * 3], srcRgb[i * 3 + 1], srcRgb[i * 3 + 2]);
        Y[i] = Math.max(0, Math.min(255, Math.round(yy)));
        U[i] = Math.max(0, Math.min(255, Math.round(uu)));
        V[i] = Math.max(0, Math.min(255, Math.round(vv)));
    }
    const srcPath = path.join(workDir, 'fx.yuv');
    fs.writeFileSync(srcPath, Buffer.concat([Y, U, V]));
    const outPath = path.join(workDir, 'fxo.yuv');
    // frameHeight = FX_H để bán kính pixel giống nhau ở cả hai bên
    const chain = ColorAdjust.ffmpegFilters(adj, '', FX_H);
    execFileSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-s', `${FX_W}x${FX_H}`,
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        '-i', srcPath,
        '-vf', ['setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709', ...chain].join(','),
        '-f', 'rawvideo', '-pix_fmt', 'yuv444p', outPath,
    ]);
    const got = fs.readFileSync(outPath);

    // Tham chiếu bắt đầu từ CHÍNH giá trị plane (cùng điểm khởi đầu với FFmpeg)
    const ref = new Float32Array(FX_PIXELS * 3);
    for (let i = 0; i < FX_PIXELS; i += 1) {
        const c = yuvBytesToRgb(Y[i], U[i], V[i]);
        ref[i * 3] = c[0]; ref[i * 3 + 1] = c[1]; ref[i * 3 + 2] = c[2];
    }
    ColorAdjust.applyToImage(adj, ref, FX_W, FX_H, { frameHeight: FX_H });

    const diffs = [];
    // Bỏ 6 pixel viền: FFmpeg và tham chiếu xử lý MÉP ảnh khác nhau, và vùng đó không
    // nói lên điều gì về công thức.
    for (let y = 6; y < FX_H - 6; y += 1) {
        for (let x = 6; x < FX_W - 6; x += 1) {
            const i = y * FX_W + x;
            const a = yuvBytesToRgb(got[i], got[FX_PIXELS + i], got[2 * FX_PIXELS + i]);
            for (let c = 0; c < 3; c += 1) diffs.push(Math.abs(a[c] * 255 - ref[i * 3 + c] * 255));
        }
    }
    diffs.sort((p, q) => p - q);
    const max = diffs[diffs.length - 1];
    const p95 = diffs[Math.floor(diffs.length * 0.95)];
    const avg = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    console.log(`  ${name.padEnd(26)} max=${max.toFixed(1)}  p95=${p95.toFixed(1)}  avg=${avg.toFixed(2)}  (${chain.length} filter)`);
    assert.ok(p95 <= limits.p95, `"${name}": p95 ${p95.toFixed(1)} > ${limits.p95}\n  chain=${chain.join(',')}`);
    assert.ok(max <= limits.max, `"${name}": max ${max.toFixed(1)} > ${limits.max}\n  chain=${chain.join(',')}`);
}

function testEffects() {
    // --- phần không cần FFmpeg: chuỗi filter và quy đổi theo độ phân giải ---
    const def = ColorAdjust.defaultAdjustments();
    assert.ok(ColorAdjust.effectsIsIdentity(def.effects), 'effects mặc định phải là identity');
    const fxAdj = mk((a) => { a.effects.sharpen = 50; });
    assert.ok(!ColorAdjust.isIdentity(fxAdj), 'effects != 0 -> isIdentity phải false');

    // ĐỘC LẬP ĐỘ PHÂN GIẢI: bán kính phải TỈ LỆ với chiều cao khung, nếu không thì
    // preview (khung nhỏ) và bản xuất (1080p) mờ/nét khác nhau hẳn.
    const blurAdj = mk((a) => { a.effects.blur = 100; });
    const r1080 = ColorAdjust.effectsSpec(blurAdj, 1080).blur.radius;
    const r540 = ColorAdjust.effectsSpec(blurAdj, 540).blur.radius;
    assert.ok(Math.abs(r1080 / r540 - 2) < 0.25, `bán kính blur phải tỉ lệ chiều cao: ${r1080} vs ${r540}`);
    const sharp1080 = ColorAdjust.effectsSpec(mk((a) => { a.effects.sharpen = 100; }), 1080).sharpen.msize;
    assert.ok(sharp1080 % 2 === 1 && sharp1080 >= 3 && sharp1080 <= 23,
        `msize của unsharp phải là số LẺ trong [3,23], có ${sharp1080}`);

    // Hạt nhân: binomial (khớp unsharp) và hộp (khớp avgblur) phải chuẩn hoá về tổng 1
    [3, 5, 13, 23].forEach((m) => {
        const k = ColorAdjust.binomialKernel(m);
        assert.strictEqual(k.length, m, `binomial ${m} phải có ${m} tap`);
        assert.ok(Math.abs(k.reduce((s, v) => s + v, 0) - 1) < 1e-9, 'binomial phải cộng lại bằng 1');
        assert.ok(Math.abs(k[0] - k[k.length - 1]) < 1e-12, 'binomial phải đối xứng');
    });
    assert.deepStrictEqual(ColorAdjust.boxKernel(1).map((v) => v.toFixed(4)),
        ['0.3333', '0.3333', '0.3333'], 'hộp bán kính 1 = 3 tap đều nhau');

    // Chuỗi filter phải đúng filter và đúng THỨ TỰ (chi tiết trước, ống kính sau)
    const allFx = mk((a) => {
        a.effects.clarity = 50; a.effects.sharpen = 50; a.effects.blur = 50;
        a.effects.grain = 50; a.effects.vignette = 50;
    });
    const chain = ColorAdjust.ffmpegFilters(allFx, '', 1080).join(' | ');
    ['unsharp', 'avgblur', 'noise', 'vignette'].forEach((f) => {
        assert.ok(chain.includes(f), `chuỗi filter thiếu ${f}: ${chain}`);
    });
    assert.ok(chain.indexOf('unsharp') < chain.indexOf('avgblur'), 'làm nét phải TRƯỚC làm mờ');
    assert.ok(chain.indexOf('avgblur') < chain.indexOf('vignette'), 'viền mờ phải ở CUỐI');
    // Phải khớp theo BIÊN tên filter: chuỗi "avgblur" cũng chứa "gblur" nên
    // includes('gblur') luôn đúng và assertion sẽ báo động giả.
    assert.ok(!ColorAdjust.ffmpegFilters(allFx, '', 1080).some((f) => /^gblur[=,]?/.test(f)),
        'KHÔNG được dùng gblur: nó là xấp xỉ Gauss đệ quy, shader không tái tạo được');
    // unsharp phải chạy trên yuv444p (nếu để gbrp thì chỉ làm nét kênh G)
    assert.ok(chain.indexOf('format=yuv444p') < chain.indexOf('unsharp'),
        'phải ép format=yuv444p trước unsharp');
    // avgblur phải xếp tầng đúng số lượt
    const blurCount = ColorAdjust.ffmpegFilters(allFx, '', 1080).filter((f) => f.startsWith('avgblur')).length;
    assert.strictEqual(blurCount, ColorAdjust.effectsSpec(allFx, 1080).blur.cascade,
        'số filter avgblur phải bằng số lượt xếp tầng');

    if (!ffmpegAvailable()) {
        console.log('  (bỏ qua đối chiếu FFmpeg cho nhóm hiệu ứng: không có ffmpeg)');
        return;
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-fx-'));
    try {
        // Ngưỡng đo được trên FFmpeg 8.1. unsharp khớp rất sát vì hạt nhân binomial đã
        // đối chiếu bằng đáp ứng xung; blur/vignette lỏng hơn do làm tròn 8-bit qua
        // nhiều lượt và do mode=backward có phép chia dễ kẹp trần ở góc khung.
        compareFxCase(workDir, 'sharpen 100', mk((a) => { a.effects.sharpen = 100; }), { max: 4, p95: 2 });
        compareFxCase(workDir, 'clarity 100', mk((a) => { a.effects.clarity = 100; }), { max: 4, p95: 2 });
        compareFxCase(workDir, 'blur 100', mk((a) => { a.effects.blur = 100; }), { max: 9, p95: 6 });
        compareFxCase(workDir, 'vignette +80', mk((a) => { a.effects.vignette = 80; }), { max: 7, p95: 5 });
        // backward (làm sáng viền) chia cho hệ số -> vài pixel góc kẹp trần, chỉ chốt p95
        compareFxCase(workDir, 'vignette -60', mk((a) => { a.effects.vignette = -60; }), { max: 60, p95: 4 });
        compareFxCase(workDir, 'nét + rõ + viền', mk((a) => {
            a.effects.sharpen = 60; a.effects.clarity = 50; a.effects.vignette = 40;
        }), { max: 8, p95: 6 });
        compareFxCase(workDir, 'màu + hiệu ứng', mk((a) => {
            a.basic.exposure = 15; a.basic.saturation = 20; a.tone.highlights = 30;
            a.effects.sharpen = 50; a.effects.vignette = 50;
        }), { max: 16, p95: 10 });
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

// ------------------------------ KEYFRAME THÔNG SỐ MÀU ------------------------------
const TextAnimations = require(path.join(PROJECT_ROOT, 'static', 'js', 'text-animations.js'));

function testAdjustKeyframeMath() {
    // BỐN cơ chế xuất, mỗi cái do một RÀNG BUỘC CỦA FFMPEG chứ không phải lựa chọn tuỳ ý:
    //   eq      — filter màu DUY NHẤT nhận biểu thức theo thời gian
    //   sendcmd — colorbalance có cờ T, giá trị lệnh là MỘT SỐ
    //   curves  — cũng sendcmd, nhưng giá trị lệnh là cả CHUỖI ĐIỂM ĐIỀU KHIỂN
    //   lutmix  — lut3d không có tham số trộn -> phải split + blend=all_expr theo T
    // Chốt PHÂN LOẠI CƠ CHẾ, không chốt danh sách phẳng. Thông số nào chưa hỗ trợ thì
    // canKeyframe = false (và nút hình thoi bị khoá kèm tooltip).
    assert.deepStrictEqual(
        ColorAdjust.KEYFRAME_PARAMS.filter((p) => p.via === 'eq').map((p) => p.path),
        ['basic.exposure', 'basic.contrast', 'basic.saturation']);
    assert.deepStrictEqual(
        ColorAdjust.KEYFRAME_PARAMS.filter((p) => p.via === 'curves').map((p) => p.path),
        ['tone.highlights', 'tone.shadows', 'tone.whites', 'tone.blacks', 'tone.glow']);
    assert.deepStrictEqual(
        ColorAdjust.KEYFRAME_PARAMS.filter((p) => p.via === 'lutmix').map((p) => p.path),
        ['lut.intensity']);
    assert.deepStrictEqual(
        ColorAdjust.KEYFRAME_PARAMS.filter((p) => p.via === 'blur').map((p) => p.path), ['effects.blur']);
    assert.deepStrictEqual(
        ColorAdjust.KEYFRAME_PARAMS.filter((p) => p.via === 'vignette').map((p) => p.path), ['effects.vignette']);
    assert.ok(ColorAdjust.KEYFRAME_PARAMS.every(
        (p) => ['eq', 'sendcmd', 'curves', 'lutmix', 'blur', 'vignette'].includes(p.via)),
        'mọi thông số keyframe phải khai rõ cơ chế xuất');
    assert.ok(ColorAdjust.canKeyframe('basic.exposure'));
    assert.ok(ColorAdjust.canKeyframe('tone.highlights'));
    assert.ok(ColorAdjust.canKeyframe('lut.intensity'));
    assert.ok(ColorAdjust.canKeyframe('effects.blur'), 'avgblur có cờ T -> làm mờ keyframe được');
    assert.ok(ColorAdjust.canKeyframe('effects.vignette'), 'vignette có eval=frame -> viền mờ keyframe được');
    // BA thông số này KHÔNG có đường xuất nào: unsharp/noise vừa không có cờ `T` vừa không
    // nhận biểu thức. Giữ khoá kèm tooltip, đừng mở UI rồi âm thầm mất tác dụng.
    ['effects.sharpen', 'effects.clarity', 'effects.grain'].forEach((p) => {
        assert.ok(!ColorAdjust.canKeyframe(p), `${p}: unsharp/noise không đổi được lúc chạy`);
    });
    assert.ok(!ColorAdjust.canKeyframe('hsl.red.h'), 'dải HSL đi qua lut3d -> không keyframe được');
    assert.ok(!ColorAdjust.canKeyframe('curves.all'), 'đường cong người dùng -> chưa làm');
    assert.strictEqual(ColorAdjust.keyframeFieldName('basic.exposure'), 'adj.basic.exposure');

    // Đọc/ghi theo đường dẫn có dấu chấm
    const a = ColorAdjust.defaultAdjustments();
    ColorAdjust.setAdjustParam(a, 'basic.exposure', 42);
    assert.strictEqual(ColorAdjust.getAdjustParam(a, 'basic.exposure'), 42);
    assert.strictEqual(ColorAdjust.getAdjustParam(a, 'khong.co.duong.nay'), undefined);

    const kf = {
        'adj.basic.exposure': [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 80, e: 'linear' }],
    };
    assert.ok(ColorAdjust.hasAdjustKeyframes(kf));
    assert.ok(!ColorAdjust.hasAdjustKeyframes({ position_x: [{ t: 0, v: 1 }] }),
        'keyframe TRANSFORM không được tính là keyframe màu');

    // Giá trị hiệu dụng: nội suy đúng, và GIỮ MÉP ngoài khoảng
    const base = ColorAdjust.defaultAdjustments();
    const evalAt = (t) => ColorAdjust.effectiveAdjustments(base, kf, t, TextAnimations.evalKeyframeField)
        .basic.exposure;
    assert.strictEqual(evalAt(0), 0);
    assert.strictEqual(evalAt(1), 40);
    assert.strictEqual(evalAt(2), 80);
    assert.strictEqual(evalAt(-5), 0, 'trước keyframe đầu phải giữ mép');
    assert.strictEqual(evalAt(99), 80, 'sau keyframe cuối phải giữ mép');
    // Không đụng thông số khác
    assert.strictEqual(ColorAdjust.effectiveAdjustments(base, kf, 1, TextAnimations.evalKeyframeField)
        .basic.contrast, 0);

    // Biểu thức eq: phải chứa token LOCALT (sidecar sẽ thay bằng trục thời gian) và
    // phải gộp ĐÚNG công thức eqParams (contrast = c*gain, brightness = 0.5c(gain-1)).
    const withContrast = mk((x) => { x.basic.contrast = 20; });
    const ex = ColorAdjust.eqKeyframeExprs(withContrast, kf, TextAnimations.keyframeFieldFfmpegExpr);
    assert.ok(ex, 'phải sinh được biểu thức eq');
    ['contrast', 'brightness', 'saturation'].forEach((k) => assert.ok(typeof ex[k] === 'string' && ex[k]));
    assert.ok(ex.contrast.includes('LOCALT'), 'biểu thức phải dùng token LOCALT');
    assert.ok(ex.contrast.includes('pow(2,'), 'exposure phải quy đổi thành pow(2, E/50)');
    assert.ok(!ex.saturation.includes('LOCALT'), 'thông số KHÔNG keyframe phải là hằng số');
    assert.strictEqual(ColorAdjust.eqKeyframeExprs(withContrast, {}, TextAnimations.keyframeFieldFfmpegExpr), null,
        'không có keyframe -> không sinh biểu thức');

    // Biểu thức tại t phải KHỚP eqParams của giá trị hiệu dụng — đây là chốt WYSIWYG:
    // preview dùng eqParams(giá trị nội suy), export dùng biểu thức này.
    [0, 0.5, 1, 1.5, 2].forEach((t) => {
        const eff = ColorAdjust.effectiveAdjustments(withContrast, kf, t, TextAnimations.evalKeyframeField);
        const want = ColorAdjust.eqParams(eff);
        const got = {
            contrast: evalFfmpegExpr(ex.contrast, t),
            brightness: evalFfmpegExpr(ex.brightness, t),
            saturation: evalFfmpegExpr(ex.saturation, t),
        };
        ['contrast', 'brightness', 'saturation'].forEach((k) => {
            assert.ok(Math.abs(got[k] - want[k]) < 1e-4,
                `t=${t} ${k}: biểu thức cho ${got[k]} nhưng eqParams cho ${want[k]}`);
        });
    });

    // skipEq: có keyframe thì chuỗi tĩnh KHÔNG được chứa eq nữa, nếu không ảnh bị
    // chỉnh HAI LẦN (một lần tĩnh, một lần theo biểu thức).
    assert.ok(!ColorAdjust.ffmpegFilters(withContrast, '', 1080, { skipEq: true }).some((f) => f.startsWith('eq=')),
        'skipEq phải bỏ hẳn eq khỏi chuỗi tĩnh');
    assert.ok(ColorAdjust.ffmpegFilters(withContrast, '', 1080).some((f) => f.startsWith('eq=')),
        'không skipEq thì vẫn phải có eq tĩnh');
    // --- KEYFRAME qua sendcmd (Nhiệt độ / Tông màu / 3 Vòng tròn màu) ---
    assert.strictEqual(ColorAdjust.KEYFRAME_PARAMS.length, 22, 'phải có 22 thông số keyframe được');
    assert.ok(ColorAdjust.canKeyframe('basic.temperature'));
    assert.ok(ColorAdjust.canKeyframe('wheels.gain.b'));
    const kfTemp = { 'adj.basic.temperature': [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 80, e: 'linear' }] };
    // Phân loại đúng cơ chế: temperature KHÔNG được đi đường eq (colorbalance không nhận
    // biểu thức), và exposure KHÔNG được đi đường sendcmd (đã có eq rẻ hơn).
    assert.ok(ColorAdjust.hasAdjustKeyframes(kfTemp, 'sendcmd'));
    assert.ok(!ColorAdjust.hasAdjustKeyframes(kfTemp, 'eq'));
    assert.ok(!ColorAdjust.hasAdjustKeyframes(kf, 'sendcmd'));
    assert.strictEqual(ColorAdjust.eqKeyframeExprs(base, kfTemp, TextAnimations.keyframeFieldFfmpegExpr), null,
        'keyframe temperature không được sinh biểu thức eq');

    const cmd = ColorAdjust.sendcmdText(base, kfTemp, TextAnimations.evalKeyframeField,
        { fps: 25, duration: 2, label: 'cb_t' });
    const cmdLines = cmd.trim().split('\n');
    assert.strictEqual(cmdLines.length % ColorAdjust.CB_KEYS.length, 0,
        'mỗi mốc phải gửi đủ 9 tham số của colorbalance (chúng bị TRỘN từ temp/tint/wheels)');
    assert.ok(/^0\.0000 colorbalance@cb_t rs -?[\d.]+;$/.test(cmdLines[0]), `dòng đầu sai cú pháp: ${cmdLines[0]}`);
    // Giá trị phải khớp colorbalanceParams của giá trị nội suy tại đúng mốc đó
    const midT = 1.0;
    const effMid = ColorAdjust.effectiveAdjustments(base, kfTemp, midT, TextAnimations.evalKeyframeField);
    const wantRm = ColorAdjust.colorbalanceParams(effMid).rm.toFixed(4);
    assert.ok(cmd.includes(`1.0000 colorbalance@cb_t rm ${wantRm};`),
        `file lệnh phải có rm=${wantRm} tại t=1.0`);
    // Lọc mốc trùng: keyframe ngắn trong clip dài không được sinh lệnh cho cả clip
    const kfShort = { 'adj.basic.temperature': [{ t: 1, v: 0, e: 'linear' }, { t: 1.5, v: 60, e: 'linear' }] };
    const shortLines = ColorAdjust.sendcmdText(base, kfShort, TextAnimations.evalKeyframeField,
        { fps: 30, duration: 20, label: 'x' }).trim().split('\n').length;
    assert.ok(shortLines < 400, `phải lọc mốc trùng, có ${shortLines} dòng cho clip 20s`);
    assert.strictEqual(ColorAdjust.sendcmdText(base, {}, TextAnimations.evalKeyframeField, {}), '',
        'không có keyframe sendcmd -> không sinh file lệnh');

    // --- KEYFRAME NHÓM ĐỘ SÁNG (qua `curves` + sendcmd) ---
    const kfTone = { 'adj.tone.highlights': [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 100, e: 'linear' }] };
    assert.ok(ColorAdjust.hasAdjustKeyframes(kfTone, 'curves'));
    assert.ok(!ColorAdjust.hasAdjustKeyframes(kfTone, 'sendcmd'), 'tone KHÔNG đi đường colorbalance');
    assert.ok(!ColorAdjust.hasAdjustKeyframes(kfTone, 'eq'), 'tone KHÔNG sinh biểu thức eq');
    const toneCmd = ColorAdjust.sendcmdText(base, kfTone, TextAnimations.evalKeyframeField,
        { fps: 25, duration: 2, label: 'cb_t', toneLabel: 'tone_t' });
    const toneLines = toneCmd.trim().split('\n');
    // MỘT lệnh mỗi mốc (không phải 9 như colorbalance) vì cả đường cong nằm trong một chuỗi
    assert.ok(toneLines.every((l) => /^\d+\.\d+ curves@tone_t all '[\d./ ]+';$/.test(l)),
        `cú pháp lệnh curves sai, ví dụ: ${toneLines[0]}`);
    assert.ok(!toneCmd.includes('colorbalance@'), 'chỉ keyframe tone thì không được có lệnh colorbalance');
    // Giá trị phải khớp toneCurvePoints của giá trị NỘI SUY tại đúng mốc
    const effTone = ColorAdjust.effectiveAdjustments(base, kfTone, 1.0, TextAnimations.evalKeyframeField);
    assert.ok(toneCmd.includes(`1.0000 curves@tone_t all '${ColorAdjust.curvePointsString(ColorAdjust.toneCurvePoints(effTone))}';`),
        'chuỗi điểm tại t=1.0 phải khớp toneCurvePoints(giá trị nội suy)');
    // Mốc đầu (tone = identity) phải gửi ĐƯỜNG CHÉO, không được bỏ lệnh: bỏ thì filter giữ
    // nguyên đường cong của mốc trước.
    assert.ok(toneLines[0].includes("all '0.0/0.0 1.0/1.0'"), `mốc đầu phải là đường chéo: ${toneLines[0]}`);
    // forceTone: tone tĩnh = identity mà có keyframe -> curves VẪN phải được phát, CÓ TÊN
    assert.ok(!ColorAdjust.ffmpegFilters(base, '', 1080).some((f) => f.startsWith('curves')),
        'tone identity thì bình thường không phát curves');
    assert.ok(ColorAdjust.ffmpegFilters(base, '', 1080, { forceTone: true, toneLabel: 'tone_t' })
        .some((f) => f.startsWith("curves@tone_t=all='0.0/0.0 1.0/1.0'")),
        'forceTone + toneLabel phải phát curves CÓ TÊN với đường chéo');

    // --- KEYFRAME CƯỜNG ĐỘ LUT (qua split + blend=all_expr) ---
    const kfLut = { 'adj.lut.intensity': [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 100, e: 'linear' }] };
    assert.ok(ColorAdjust.hasAdjustKeyframes(kfLut, 'lutmix'));
    ['eq', 'sendcmd', 'curves'].forEach((via) => {
        assert.ok(!ColorAdjust.hasAdjustKeyframes(kfLut, via), `cường độ LUT không đi đường ${via}`);
    });
    assert.strictEqual(ColorAdjust.sendcmdText(base, kfLut, TextAnimations.evalKeyframeField, {}), '',
        'cường độ LUT không sinh file lệnh sendcmd');
    const mixExpr = ColorAdjust.lutMixKeyframeExpr(base, kfLut, TextAnimations.keyframeFieldFfmpegExpr);
    assert.ok(mixExpr.includes('LOCALT') && mixExpr.startsWith('clip(') && mixExpr.includes('/100'),
        `biểu thức pha phải kẹp [0,1] và quy về 0..1: ${mixExpr}`);
    assert.strictEqual(ColorAdjust.lutMixKeyframeExpr(base, {}, TextAnimations.keyframeFieldFfmpegExpr), null);
    // Không có LUT người dùng -> không có gì để pha
    assert.strictEqual(ColorAdjust.lutBlendCubes(base), null);
    // Trộn 2 cube tại mắt lưới == bake trực tiếp ở cùng cường độ (nội suy trilinear là phép
    // TUYẾN TÍNH nên hai cách phải trùng khít, không chỉ gần).
    const n = 9;
    const lutData = new Float32Array(n * n * n * 3);
    for (let bi = 0; bi < n; bi += 1) {
        for (let gi = 0; gi < n; gi += 1) {
            for (let ri = 0; ri < n; ri += 1) {
                const at = ((bi * n + gi) * n + ri) * 3;
                lutData[at] = Math.min(1, (ri / (n - 1)) * 0.4 + 0.6);
                lutData[at + 1] = (gi / (n - 1)) * 0.5;
                lutData[at + 2] = (bi / (n - 1)) * 0.3;
            }
        }
    }
    ColorAdjust.registerUserLut('math-lut', { size: n, data: lutData, domainMin: [0, 0, 0], domainMax: [1, 1, 1] });
    const lutAdj = mk((a) => { a.lut.id = 'math-lut'; a.hsl.orange.s = 30; });
    const cubeA = ColorAdjust.bakeCube(lutAdj, ColorAdjust.getUserLut('math-lut'), 9, { lutMix: 0 });
    const cubeB = ColorAdjust.bakeCube(lutAdj, ColorAdjust.getUserLut('math-lut'), 9, { lutMix: 1 });
    [0, 0.25, 0.5, 0.75, 1].forEach((i) => {
        lutAdj.lut.intensity = i * 100;
        const direct = ColorAdjust.bakeCube(lutAdj, ColorAdjust.getUserLut('math-lut'), 9);
        const mixed = ColorAdjust.mixCubes(cubeA, cubeB, i);
        let max = 0;
        for (let k = 0; k < direct.data.length; k += 1) {
            max = Math.max(max, Math.abs(direct.data[k] - mixed.data[k]));
        }
        assert.ok(max < 1e-6, `trộn cube lệch bake trực tiếp ${max} ở mix=${i}`);
    });
    assert.ok(ColorAdjust.lutBlendCubes(lutAdj, 9).a.startsWith('TITLE'), 'phải xuất được nội dung .cube');

    // forceColorbalance: temperature keyframe mà giá trị tĩnh = 0 thì filter VẪN phải được
    // phát, nếu không sendcmd chẳng có instance nào để gửi lệnh tới.
    const noCb = ColorAdjust.ffmpegFilters(base, '', 1080);
    assert.ok(!noCb.some((f) => f.startsWith('colorbalance')), 'giá trị 0 thì bình thường không phát colorbalance');
    const forced = ColorAdjust.ffmpegFilters(base, '', 1080, { forceColorbalance: true, cbLabel: 'cb_t' });
    assert.ok(forced.some((f) => f.startsWith('colorbalance@cb_t=')),
        'forceColorbalance + cbLabel phải phát colorbalance CÓ TÊN');
    console.log('  keyframe thông số màu (toán) ok');
}

// Đánh giá biểu thức kiểu FFmpeg (tập con đủ dùng: pow/if/lt/clip + số học) tại LOCALT=t.
function evalFfmpegExpr(expr, t) {
    const js = String(expr)
        .replace(/\bLOCALT\b/g, `(${t})`)
        .replace(/\bpow\(/g, 'Math.pow(')
        .replace(/\bif\(/g, '__if(')
        .replace(/\blt\(/g, '__lt(')
        .replace(/\bclip\(/g, '__clip(');
    // eslint-disable-next-line no-new-func
    const fn = new Function('__if', '__lt', '__clip', `return (${js});`);
    return fn(
        (c, a, b) => (c ? a : b),
        (x, y) => (x < y ? 1 : 0),
        (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
    );
}

// End-to-end: keyframe có THẬT SỰ đổi theo thời gian trong video xuất ra hay không.
function testAdjustKeyframeSidecar(workDir) {
    const W = 160;
    const H = 120;
    const srcVideo = path.join(workDir, 'kfsrc.mp4');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=0x606060:s=${W}x${H}:d=3:r=25`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=3', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        srcVideo]);

    // Phơi sáng chạy 0 -> 45 trong 2 giây (trục CỤC BỘ của clip, clip trim từ 0.5s).
    // Cố ý KHÔNG kéo tới 80: nguồn xám 96 gặp exposure 80 sẽ KẸP TRẦN 255 ở cuối clip và
    // phép đo "tăng dần" mất tác dụng đúng chỗ cần đo (đã mắc: 253 -> 255 chỉ hơn 2).
    const adj = ColorAdjust.defaultAdjustments();
    const keyframes = {
        'adj.basic.exposure': [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 45, e: 'linear' }],
    };
    const ex = ColorAdjust.eqKeyframeExprs(adj, keyframes, TextAnimations.keyframeFieldFfmpegExpr);
    const payload = {
        resolution: 'source', width: W, height: H,
        fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
        intervals: [{
            index: 0, start: 0.5, end: 2.5, position_x: 0, position_y: 0,
            scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
            adj_filters: ColorAdjust.ffmpegFilters(adj, '', H, { skipEq: true }).join(','),
            adj_eq_contrast_expr: ex.contrast,
            adj_eq_brightness_expr: ex.brightness,
            adj_eq_saturation_expr: ex.saturation,
        }],
    };
    const payloadPath = path.join(workDir, 'kf_timeline.json');
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    const outPath = path.join(workDir, 'kf_out.mp4');
    const result = spawnSync(SIDECAR, ['export-video', srcVideo, outPath, payloadPath, workDir, 'high', '25'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(result.status, 0, `sidecar lỗi khi có keyframe màu:\n${result.stdout}\n${result.stderr}`);

    const lumAt = (seconds) => {
        const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', outPath,
            '-frames:v', '1', '-vf', 'crop=16:16:72:52,scale=1:1',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
        assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
        return 0.2126 * out.stdout[0] + 0.7152 * out.stdout[1] + 0.0722 * out.stdout[2];
    };
    const samples = [0.1, 0.6, 1.1, 1.6, 1.9].map((s) => ({ t: s, lum: lumAt(s) }));
    console.log('  keyframe end-to-end     '
        + samples.map((s) => `t=${s.t}s:${s.lum.toFixed(0)}`).join('  '));

    // PHẢI tăng dần theo thời gian — đây là điều duy nhất chứng minh biểu thức được
    // đánh giá TỪNG FRAME (thiếu eval=frame thì mọi mốc cho cùng một giá trị).
    for (let i = 1; i < samples.length; i += 1) {
        assert.ok(samples[i].lum > samples[i - 1].lum + 3,
            `độ sáng phải tăng dần theo keyframe: ${samples.map((s) => s.lum.toFixed(0)).join(', ')}`);
    }
    assert.ok(samples[samples.length - 1].lum - samples[0].lum > 30,
        'biên độ keyframe quá nhỏ, có thể biểu thức không được áp');
    // Không được kẹp trần: kẹp thì đoạn cuối phẳng và phép đo trên mất tác dụng.
    assert.ok(samples[samples.length - 1].lum < 250,
        'mẫu cuối đã kẹp trần trắng — hãy giảm biên độ keyframe của test');
}


// End-to-end `sendcmd`: keyframe Nhiệt độ có thật sự đổi theo thời gian trong video xuất ra.
// Đây là điều DUY NHẤT chứng minh file lệnh tới được FFmpeg và trỏ đúng instance filter.
function testSendcmdSidecar(workDir) {
    const W = 160;
    const H = 120;
    const srcVideo = path.join(workDir, 'scsrc.mp4');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=0x707070:s=${W}x${H}:d=3:r=25`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=3', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        srcVideo]);

    const adj = ColorAdjust.defaultAdjustments();
    const keyframes = {
        'adj.basic.temperature': [{ t: 0, v: -90, e: 'linear' }, { t: 2, v: 90, e: 'linear' }],
    };
    const label = 'cb_e2e';
    const cmdText = ColorAdjust.sendcmdText(adj, keyframes, TextAnimations.evalKeyframeField,
        { fps: 25, duration: 2, label });
    assert.ok(cmdText, 'phải sinh được file lệnh');
    const cmdPath = path.join(workDir, 'cb_cmd.txt');
    fs.writeFileSync(cmdPath, cmdText);

    const chain = ColorAdjust.ffmpegFilters(adj, '', H, { forceColorbalance: true, cbLabel: label });
    assert.ok(chain.some((f) => f.includes(`colorbalance@${label}=`)), 'chuỗi phải có colorbalance CÓ TÊN');
    const payload = {
        resolution: 'source', width: W, height: H,
        fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
        intervals: [{
            index: 0, start: 0.5, end: 2.5, position_x: 0, position_y: 0,
            scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
            adj_filters: [`sendcmd=f='${ColorAdjust.filterPath(cmdPath)}'`, ...chain].join(','),
        }],
    };
    const payloadPath = path.join(workDir, 'sc_timeline.json');
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    const outPath = path.join(workDir, 'sc_out.mp4');
    const result = spawnSync(SIDECAR, ['export-video', srcVideo, outPath, payloadPath, workDir, 'high', '25'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(result.status, 0, `sidecar lỗi khi có sendcmd:\n${result.stdout}\n${result.stderr}`);

    // Nhiệt độ chạy từ LẠNH (-90) sang ẤM (+90) -> hiệu (đỏ - lam) phải TĂNG DẦN
    const warmthAt = (seconds) => {
        const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', outPath,
            '-frames:v', '1', '-vf', 'crop=16:16:72:52,scale=1:1',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
        assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
        return out.stdout[0] - out.stdout[2];
    };
    const samples = [0.1, 0.6, 1.1, 1.6, 1.9].map((s) => ({ t: s, w: warmthAt(s) }));
    console.log('  sendcmd end-to-end      '
        + samples.map((s) => `t=${s.t}s:${s.w > 0 ? '+' : ''}${s.w}`).join('  ') + '   (đỏ − lam)');
    for (let i = 1; i < samples.length; i += 1) {
        assert.ok(samples[i].w > samples[i - 1].w + 2,
            `độ ấm phải tăng dần theo keyframe: ${samples.map((s) => s.w).join(', ')}`);
    }
    assert.ok(samples[0].w < 0 && samples[samples.length - 1].w > 0,
        `phải đi từ LẠNH sang ẤM, đo được ${samples[0].w} -> ${samples[samples.length - 1].w}`);
}

// ------------------------------------- MẶT NẠ -------------------------------------
// NHÓM ĐỘ SÁNG qua `sendcmd` + `curves` — cơ chế KHÁC colorbalance ở chỗ giá trị lệnh là
// cả CHUỖI ĐIỂM ĐIỀU KHIỂN. Đây là điều duy nhất chứng minh chuỗi đó tới được FFmpeg,
// được parse, và đổi đường cong theo từng mốc.
function testToneSendcmdSidecar(workDir) {
    const W = 160;
    const H = 120;
    // NGUỒN PHẢI NẰM TRONG VÙNG TÁC ĐỘNG: "Vùng sáng" có tâm x=0.75 và tắt ở ±0.25, nên
    // xám 0x70 (0.44) gần như KHÔNG bị ảnh hưởng — bẫy 5.2 (đo ở vùng trọng số 0), đã mắc
    // đúng lúc spike. 0xC0 = 0.753 nằm ngay tâm.
    const srcVideo = path.join(workDir, 'tonesrc.mp4');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=0xC0C0C0:s=${W}x${H}:d=3:r=25`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=3', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        srcVideo]);

    const adj = ColorAdjust.defaultAdjustments();
    const keyframes = {
        'adj.tone.highlights': [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 100, e: 'linear' }],
    };
    const toneLabel = 'tone_e2e';
    const cmdText = ColorAdjust.sendcmdText(adj, keyframes, TextAnimations.evalKeyframeField,
        { fps: 25, duration: 2, label: 'cb_e2e', toneLabel });
    assert.ok(cmdText.includes(`curves@${toneLabel} all '`),
        'file lệnh phải chứa lệnh curves có chuỗi điểm trong nháy đơn');
    assert.ok(!cmdText.includes('colorbalance@'),
        'chỉ keyframe tone thì KHÔNG được sinh lệnh colorbalance (không có gì biến thiên)');
    const cmdPath = path.join(workDir, 'tone_cmd.txt');
    fs.writeFileSync(cmdPath, cmdText);

    // forceTone: giá trị tĩnh đang identity, không force thì curves không được phát và
    // lệnh chẳng có filter nào để tới -> keyframe im lặng mất tác dụng.
    const chain = ColorAdjust.ffmpegFilters(adj, '', H, { forceTone: true, toneLabel });
    assert.ok(chain.some((f) => f.startsWith(`curves@${toneLabel}=`)), 'chuỗi phải có curves CÓ TÊN');
    const payload = {
        resolution: 'source', width: W, height: H,
        fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
        intervals: [{
            index: 0, start: 0.5, end: 2.5, position_x: 0, position_y: 0,
            scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
            adj_filters: [`sendcmd=f='${ColorAdjust.filterPath(cmdPath)}'`, ...chain].join(','),
        }],
    };
    const payloadPath = path.join(workDir, 'tone_timeline.json');
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    const outPath = path.join(workDir, 'tone_out.mp4');
    const result = spawnSync(SIDECAR, ['export-video', srcVideo, outPath, payloadPath, workDir, 'high', '25'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(result.status, 0, `sidecar lỗi khi có sendcmd tone:\n${result.stdout}\n${result.stderr}`);

    const lumaAt = (seconds) => {
        const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', outPath,
            '-frames:v', '1', '-vf', 'crop=16:16:72:52,scale=1:1',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
        assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
        return out.stdout[0];
    };
    const samples = [0.1, 0.6, 1.1, 1.6, 1.9].map((s) => ({ t: s, v: lumaAt(s) }));
    console.log('  tone sendcmd end-to-end ' + samples.map((s) => `t=${s.t}s:${s.v}`).join('  ')
        + `   (nguồn 192, ${cmdText.trim().split('\n').length} dòng lệnh)`);
    for (let i = 1; i < samples.length; i += 1) {
        assert.ok(samples[i].v > samples[i - 1].v + 2,
            `độ sáng vùng sáng phải tăng dần: ${samples.map((s) => s.v).join(', ')}`);
    }
    // Mẫu cuối KHÔNG được kẹp trần: kẹp thì phép đo "tăng dần" mất tác dụng đúng chỗ cần đo
    assert.ok(samples[samples.length - 1].v < 255, 'mẫu cuối bị kẹp trần -> chọn lại biên độ');
}

// CƯỜNG ĐỘ LUT qua `split` -> 2×`lut3d` -> `blend=all_expr`. Đây là ca DUY NHẤT trong panh
// panel phải mổ vào filtergraph (thêm nhãn, thêm câu lệnh), nên phải chạy qua sidecar thật:
// chỉ nó mới cho biết đoạn graph có hợp lệ và có pha đúng theo thời gian.
function testLutMixSidecar(workDir) {
    const W = 160;
    const H = 120;
    const srcVideo = path.join(workDir, 'lmsrc.mp4');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=0x8090A0:s=${W}x${H}:d=3:r=25`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=3', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        srcVideo]);

    // LUT thử: đẩy mạnh đỏ, hạ lục/lam -> hiệu (đỏ − lam) là thước đo nhạy
    const n = 17;
    const data = new Float32Array(n * n * n * 3);
    for (let b = 0; b < n; b += 1) {
        for (let g = 0; g < n; g += 1) {
            for (let r = 0; r < n; r += 1) {
                const i = ((b * n + g) * n + r) * 3;
                data[i] = Math.min(1, (r / (n - 1)) * 0.4 + 0.6);
                data[i + 1] = (g / (n - 1)) * 0.5;
                data[i + 2] = (b / (n - 1)) * 0.3;
            }
        }
    }
    ColorAdjust.registerUserLut('e2e-lut', { size: n, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] });

    const adj = ColorAdjust.defaultAdjustments();
    adj.lut.id = 'e2e-lut';
    adj.lut.intensity = 0;   // giá trị TĨNH = 0: nếu đường 2 nhánh không chạy thì không đổi gì
    const keyframes = {
        'adj.lut.intensity': [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 100, e: 'linear' }],
    };
    const mixExpr = ColorAdjust.lutMixKeyframeExpr(adj, keyframes, TextAnimations.keyframeFieldFfmpegExpr);
    assert.ok(mixExpr && mixExpr.includes('LOCALT'), 'phải sinh được biểu thức pha mang token LOCALT');
    assert.ok(mixExpr.startsWith('clip('), 'phải KẸP [0,1]: easing có thể vượt biên mà blend không tự kẹp');
    const cubes = ColorAdjust.lutBlendCubes(adj, 17);
    assert.ok(cubes && cubes.a && cubes.b, 'phải bake được 2 cube thành phần');
    const aPath = path.join(workDir, 'lm_a.cube');
    const bPath = path.join(workDir, 'lm_b.cube');
    fs.writeFileSync(aPath, cubes.a);
    fs.writeFileSync(bPath, cubes.b);

    const payload = {
        resolution: 'source', width: W, height: H,
        fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
        intervals: [{
            index: 0, start: 0.5, end: 2.5, position_x: 0, position_y: 0,
            scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
            adj_lut_a_path: aPath,
            adj_lut_b_path: bPath,
            adj_lut_mix_expr: mixExpr,
        }],
    };
    const payloadPath = path.join(workDir, 'lm_timeline.json');
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    const outPath = path.join(workDir, 'lm_out.mp4');
    const result = spawnSync(SIDECAR, ['export-video', srcVideo, outPath, payloadPath, workDir, 'high', '25'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(result.status, 0, `sidecar lỗi khi pha 2 nhánh LUT:\n${result.stdout}\n${result.stderr}`);

    const warmthAt = (seconds) => {
        const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', outPath,
            '-frames:v', '1', '-vf', 'crop=16:16:72:52,scale=1:1',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
        assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
        return out.stdout[0] - out.stdout[2];
    };
    const samples = [0.1, 0.6, 1.1, 1.6, 1.9].map((s) => ({ t: s, w: warmthAt(s) }));
    console.log('  lut mix end-to-end      '
        + samples.map((s) => `t=${s.t}s:${s.w > 0 ? '+' : ''}${s.w}`).join('  ') + '   (đỏ − lam)');
    lutMixWysiwyg(workDir, adj, aPath, bPath);
    lutMixWithSurroundingFilters(workDir, srcVideo, aPath, bPath, mixExpr);
    for (let i = 1; i < samples.length; i += 1) {
        assert.ok(samples[i].w > samples[i - 1].w + 2,
            `cường độ LUT phải tăng dần: ${samples.map((s) => s.w).join(', ')}`);
    }
    // Đầu clip mix ≈ 0 nên phải còn ở phía NGUỒN (0x80,0x90,0xA0 -> đỏ−lam = −32), cuối
    // clip mix = 1 nên phải ở phía LUT hết mức. Đo được −20 → +147: mẫu đầu không đúng −32
    // vì t=0.1s đã ứng với mix ≈ 0.05 và LUT này rất mạnh, nên chỉ chốt về PHÍA nào.
    assert.ok(samples[0].w < -10, `đầu clip phải còn gần nguồn, đo được ${samples[0].w}`);
    assert.ok(samples[samples.length - 1].w > 100, `cuối clip phải áp LUT gần hết, đo được ${samples[samples.length - 1].w}`);
}

// Đoạn 2 nhánh nằm GIỮA chuỗi filter: phải có filter cả TRƯỚC (eq) lẫn SAU (vignette) nó,
// vì chỗ nối `[...lm]null,<nửa sau>` là chỗ dễ sinh filtergraph sai nhất. Đồng thời chốt luôn
// khâu backend: chính nó tách chuỗi tại chỗ trống thành adj_filters / adj_filters_post.
function lutMixWithSurroundingFilters(workDir, srcVideo, aPath, bPath, mixExpr) {
    // eslint-disable-next-line global-require
    const { normalizeColorAdjustFields } = require(path.join(PROJECT_ROOT, 'backend', 'server.js'));
    const adj = mk((a) => {
        a.basic.contrast = 20;       // -> eq, đứng TRƯỚC tầng LUT
        a.effects.vignette = 50;     // -> vignette, đứng SAU tầng LUT
        a.lut.id = 'e2e-lut';
        a.lut.intensity = 0;
    });
    const filters = ColorAdjust.ffmpegFilters(adj, '', 120, { lutSlot: true });
    const fields = normalizeColorAdjustFields({
        filters,
        cube: '',
        lut_mix: { a: fs.readFileSync(aPath, 'utf8'), b: fs.readFileSync(bPath, 'utf8'), expr: mixExpr },
    });
    // Backend phải tách ĐÚNG chỗ: eq ở nửa trước, vignette ở nửa sau, và không nửa nào còn token
    assert.ok(fields.adj_filters.startsWith('eq='), `nửa trước phải là eq: ${fields.adj_filters}`);
    assert.ok(fields.adj_filters_post.startsWith('vignette='),
        `nửa sau phải là vignette: ${fields.adj_filters_post}`);
    assert.ok(!`${fields.adj_filters}${fields.adj_filters_post}`.includes(ColorAdjust.LUT3D_SLOT));
    assert.ok(fields.adj_lut_a_path && fields.adj_lut_b_path && fields.adj_lut_mix_expr);
    // Không có lut_mix -> KHÔNG được tách chuỗi, chỉ thay token tại chỗ
    const plain = normalizeColorAdjustFields({ filters, cube: fs.readFileSync(aPath, 'utf8') });
    assert.ok(!plain.adj_filters_post, 'đường tĩnh không được sinh adj_filters_post');
    assert.ok(/^eq=.*,lut3d=.*,vignette=/.test(plain.adj_filters),
        `đường tĩnh phải chèn lut3d GIỮA eq và vignette: ${plain.adj_filters}`);

    const payload = {
        resolution: 'source', width: 160, height: 120,
        fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
        intervals: [{
            index: 0, start: 0.5, end: 2.5, position_x: 0, position_y: 0,
            scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
            ...fields,
        }],
    };
    const payloadPath = path.join(workDir, 'lms_timeline.json');
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    const outPath = path.join(workDir, 'lms_out.mp4');
    const result = spawnSync(SIDECAR, ['export-video', srcVideo, outPath, payloadPath, workDir, 'high', '25'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(result.status, 0,
        `sidecar lỗi khi có filter cả trước lẫn sau đoạn 2 nhánh:\n${result.stdout}\n${result.stderr}`);
    const warmthAt = (seconds) => {
        const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', outPath,
            '-frames:v', '1', '-vf', 'crop=16:16:72:52,scale=1:1',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
        assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
        return out.stdout[0] - out.stdout[2];
    };
    const first = warmthAt(0.1);
    const last = warmthAt(1.9);
    console.log(`  lut mix + eq/vignette   t=0.1s:${first > 0 ? '+' : ''}${first}  t=1.9s:+${last}   (đỏ − lam)`);
    assert.ok(last > first + 40, `vẫn phải pha theo thời gian khi có filter bao quanh: ${first} -> ${last}`);
}

// WYSIWYG của cường độ LUT: PREVIEW trộn 2 cube tại từng mắt lưới rồi mới nội suy, EXPORT
// nội suy từng nhánh rồi mới trộn từng PIXEL. Hai thứ đó bằng nhau về mặt toán (nội suy
// trilinear là phép tuyến tính) — phép đo này chốt lại điều đó trên FFmpeg thật, ở tỉ lệ pha
// TĨNH để tách hẳn khỏi trục thời gian (trục thời gian đã do phép đo ramp ở trên chứng minh).
function lutMixWysiwyg(workDir, adj, aPath, bPath) {
    const W = 32;
    const H = 32;
    const srcRgb = [];
    for (let i = 0; i < W * H; i += 1) {
        srcRgb.push((i * 7) % 256, (i * 13) % 256, (i * 29) % 256);
    }
    const srcPath = path.join(workDir, 'lmw.rgb');
    fs.writeFileSync(srcPath, Buffer.from(srcRgb));
    const worst = [];
    [0, 0.35, 0.7, 1].forEach((mix) => {
        const outPath = path.join(workDir, `lmw_${mix}.rgb`);
        execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', srcPath,
            '-filter_complex', `[0:v]split[a][b];`
                + `[a]lut3d=file='${ColorAdjust.filterPath(aPath)}':interp=trilinear[a2];`
                + `[b]lut3d=file='${ColorAdjust.filterPath(bPath)}':interp=trilinear[b2];`
                + `[a2][b2]blend=all_expr='A*(1-${mix})+B*${mix}'[v]`,
            '-map', '[v]', '-frames:v', '1',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', outPath]);
        const got = fs.readFileSync(outPath);
        // Tham chiếu = ĐÚNG cái preview làm: trộn cube rồi áp
        const mixed = ColorAdjust.mixCubes(
            ColorAdjust.parseCube(fs.readFileSync(aPath, 'utf8')),
            ColorAdjust.parseCube(fs.readFileSync(bPath, 'utf8')), mix);
        let max = 0;
        // Tham chiếu phải là adjustments HIỆU DỤNG tại thời điểm đó (cường độ = mix·100),
        // không phải giá trị TĨNH: `needsLut3d` xét giá trị tĩnh, mà ở đây tĩnh = 0 nên
        // applyToRgb sẽ bỏ hẳn tầng LUT và phép đo lại đang đo cái bỏ đó (đã mắc: 63/255).
        const effAdj = { ...adj, lut: { ...adj.lut, intensity: mix * 100 } };
        for (let i = 0; i < W * H; i += 1) {
            const want = ColorAdjust.applyToRgb(effAdj,
                [srcRgb[i * 3] / 255, srcRgb[i * 3 + 1] / 255, srcRgb[i * 3 + 2] / 255], mixed);
            for (let c = 0; c < 3; c += 1) {
                max = Math.max(max, Math.abs(got[i * 3 + c] - Math.round(Math.max(0, Math.min(1, want[c])) * 255)));
            }
        }
        worst.push(`mix ${mix}: ${max}`);
        // Ngưỡng 3/255: mỗi nhánh lut3d làm tròn về 8-bit TRƯỚC khi blend trộn, còn preview
        // trộn ở float rồi mới làm tròn một lần.
        assert.ok(max <= 3, `preview và export lệch ${max}/255 ở mix=${mix}`);
    });
    console.log(`  lut mix preview↔export  ${worst.join('  ')}   (/255)`);
}

// NHÓM HIỆU ỨNG có keyframe — 2/5 thông số làm được, mỗi cái một cơ chế KHÁC nhau:
//   "Làm mờ"      -> sendcmd (avgblur sizeX/sizeY/planes có cờ T)
//   "Viền mờ dần" -> biểu thức (vignette angle + eval=frame), HAI instance cho hai chiều
// Chạy qua sidecar thật vì cả hai đều nằm trong chuỗi filter do sidecar dựng.
function testEffectsKeyframeSidecar(workDir) {
    // KHUNG PHẢI ĐỦ LỚN: bán kính mờ khai theo TỈ LỆ chiều cao (BLUR_FRAC = 1.2%), nên ở
    // 120px chiều cao bán kính tối đa chỉ ~1.4px — cơ chế chạy đúng mà phép đo không thấy gì
    // (đã mắc: 3.56 -> 3.44). 480px cho bán kính tới ~6px, đủ để đo.
    const W = 640;
    const H = 480;
    const srcVideo = path.join(workDir, 'fxkf.mp4');
    // Nguồn phải có CHI TIẾT (đo độ mờ) và phải TĨNH: `testsrc2` là hoạ tiết ĐỘNG nên độ gắt
    // tự đổi theo frame và phép đo "mờ dần" mất nghĩa (đã mắc: 3.50 -> 3.77 dù mờ đang tăng).
    // Cách đúng: bốc MỘT frame ra PNG rồi loop thành video -> mọi frame giống hệt nhau.
    const stillPath = path.join(workDir, 'fxstill.png');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:d=1:r=1`, '-frames:v', '1', stillPath]);
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-loop', '1', '-t', '3', '-i', stillPath,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=3', '-shortest',
        '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', srcVideo]);

    const runSidecar = (name, chain, cmdText) => {
        const parts = [];
        if (cmdText) {
            const cmdPath = path.join(workDir, `${name}_cmd.txt`);
            fs.writeFileSync(cmdPath, cmdText);
            parts.push(`sendcmd=f='${ColorAdjust.filterPath(cmdPath)}'`);
        }
        parts.push(...chain);
        const payload = {
            resolution: 'source', width: W, height: H,
            fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
            intervals: [{
                index: 0, start: 0.5, end: 2.5, position_x: 0, position_y: 0,
                scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
                adj_filters: parts.join(','),
            }],
        };
        const payloadPath = path.join(workDir, `${name}_timeline.json`);
        fs.writeFileSync(payloadPath, JSON.stringify(payload));
        const outPath = path.join(workDir, `${name}_out.mp4`);
        const result = spawnSync(SIDECAR, ['export-video', srcVideo, outPath, payloadPath, workDir, 'high', '25'],
            { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
        assert.strictEqual(result.status, 0, `sidecar lỗi (${name}):\n${result.stdout}\n${result.stderr}`);
        return outPath;
    };
    // "Độ gắt" = tổng chênh lệch giữa 2 pixel kề nhau trên cùng hàng: mờ thì nhỏ đi.
    const sharpnessAt = (outPath, seconds) => {
        const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', outPath,
            '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
        assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
        const d = out.stdout;
        let tot = 0;
        for (let i = 0; i + 1 < d.length; i += 1) if ((i + 1) % W) tot += Math.abs(d[i + 1] - d[i]);
        return Math.round((tot / d.length) * 100) / 100;
    };

    const base = ColorAdjust.defaultAdjustments();
    // ---- LÀM MỜ: 0 -> 100 ----
    const kfBlur = { 'adj.effects.blur': [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 100, e: 'linear' }] };
    const blurLabel = 'blur_e2e';
    const blurChain = ColorAdjust.ffmpegFilters(base, '', H, { blurLabel, forceBlur: true });
    assert.strictEqual(blurChain.length, ColorAdjust.BLUR_CASCADE,
        'phải phát đúng số instance avgblur bằng số lượt xếp tầng');
    assert.ok(blurChain.every((f) => f.startsWith(`avgblur@${blurLabel}`) && f.includes('planes=0')),
        `mốc identity phải dùng planes=0 (sizeX=1 KHÔNG phải identity, đo được 201/255): ${blurChain[0]}`);
    const blurCmd = ColorAdjust.sendcmdText(base, kfBlur, TextAnimations.evalKeyframeField,
        { fps: 25, duration: 2, label: 'cb_e2e', blurLabel, frameHeight: H });
    assert.ok(blurCmd.includes(`avgblur@${blurLabel}0 sizeX`) && blurCmd.includes('planes 15;'),
        'file lệnh phải đặt cả sizeX/sizeY/planes cho từng instance');
    const blurOut = runSidecar('blur', blurChain, blurCmd);
    // Mốc ĐẦU phải là t=0: effectsSpec kẹp bán kính tối thiểu = 1 (hộp 3 tap), nên chỉ đúng
    // giá trị 0 mới là identity — ngay t=0.1 thông số đã là 5 và bán kính đã thành 1. Đây là
    // hành vi CÓ TỪ TRƯỚC của slider (0 -> 1 là một bước nhảy nhỏ) và preview khớp y hệt vì
    // hai bên dùng chung effectsSpec.
    const bs = [0, 1.0, 1.9].map((t) => ({ t, v: sharpnessAt(blurOut, t) }));
    console.log('  hiệu ứng: làm mờ     ' + bs.map((s) => `t=${s.t}s:${s.v}`).join('  ') + '   (độ gắt, mờ thì giảm)');
    assert.ok(bs[0].v > bs[1].v && bs[1].v > bs[2].v,
        `độ gắt phải giảm dần khi mờ tăng: ${bs.map((s) => s.v).join(', ')}`);
    // MỐC 0 PHẢI LÀ IDENTITY: so với CHÍNH đường xuất đó nhưng không có filter nào, chứ
    // không so với file nguồn — bản xuất còn qua scale + encode nên độ gắt tự giảm (đo được
    // 1.04 vs 1.72 ở nguồn), so kiểu đó là đang đo cái encode chứ không đo filter.
    const plainOut = runSidecar('nofx', [], '');
    const plainSharp = sharpnessAt(plainOut, 0);
    assert.ok(Math.abs(bs[0].v - plainSharp) < 0.02,
        `mốc mờ=0 phải là identity (planes=0): ${bs[0].v} vs không filter ${plainSharp}`);

    // ---- VIỀN MỜ DẦN: -80 (sáng viền) -> +80 (tối viền), ĐI QUA 0 nên phải đủ 2 chiều ----
    const kfVig = { 'adj.effects.vignette': [{ t: 0, v: -80, e: 'linear' }, { t: 2, v: 80, e: 'linear' }] };
    const vigExprs = ColorAdjust.vignetteKeyframeExprs(base, kfVig, TextAnimations.keyframeFieldFfmpegExpr);
    assert.ok(vigExprs.forward.includes('max(0,(') && vigExprs.backward.includes('max(0,-('),
        'phải tách phần dương/âm: mode của vignette KHÔNG đổi được lúc chạy');
    const vigChain = ColorAdjust.ffmpegFilters(base, '', H, { vignetteExprs: vigExprs });
    assert.strictEqual(vigChain.length, 2, 'phải phát ĐÚNG 2 instance vignette (2 chiều)');
    assert.ok(vigChain.every((f) => f.includes('eval=frame')),
        'thiếu eval=frame thì biểu thức chỉ tính một lần lúc khởi tạo');
    assert.ok(vigChain.some((f) => f.includes('mode=forward')) && vigChain.some((f) => f.includes('mode=backward')));
    const vigOut = runSidecar('vig', vigChain, '');
    // Đo GÓC khung: viền sáng -> góc sáng hơn tâm; viền tối -> góc tối hơn
    const cornerVsCenter = (seconds) => {
        const grab = (crop) => {
            const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', vigOut,
                '-frames:v', '1', '-vf', `${crop},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                { encoding: 'buffer' });
            assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
            return out.stdout[0];
        };
        return grab('crop=12:12:0:0') - grab(`crop=12:12:${W / 2 - 6}:${H / 2 - 6}`);
    };
    const vs = [0.1, 1.0, 1.9].map((t) => ({ t, v: cornerVsCenter(t) }));
    console.log('  hiệu ứng: viền mờ    ' + vs.map((s) => `t=${s.t}s:${s.v > 0 ? '+' : ''}${s.v}`).join('  ')
        + '   (góc − tâm; âm = viền tối)');
    assert.ok(vs[0].v > vs[2].v + 10,
        `viền phải đi từ SÁNG sang TỐI: ${vs.map((s) => s.v).join(', ')}`);
}

function testMaskMath() {
    const def = ColorAdjust.defaultAdjustments();
    assert.ok(!ColorAdjust.maskIsActive(def), 'mặt nạ mặc định phải tắt');
    // Mặt nạ đã bật nhưng chưa chỉnh màu: isIdentity vẫn true (không đổi hình gì) NHƯNG
    // isBlank phải false, nếu không applyAdjust sẽ xoá mất mặt nạ người dùng vừa dựng.
    const maskOnly = mk((a) => { a.mask.enabled = true; });
    assert.ok(ColorAdjust.isIdentity(maskOnly), 'mặt nạ đơn thuần không đổi hình -> isIdentity true');
    assert.ok(!ColorAdjust.isBlank(maskOnly), 'mặt nạ đã bật -> isBlank phải false (không được xoá dữ liệu)');
    assert.ok(ColorAdjust.needsMultiPass(maskOnly), 'có mặt nạ -> phải chạy nhiều lượt');

    // QUY ĐỔI RA PIXEL mà UI hiện ("1152 × 648 px"): chiều rộng thật = width × W, chiều cao
    // thật = height × H. Chốt bằng chính bake mặt nạ — nếu quy ước đơn vị đổi thì dòng hiển
    // thị trong panel sẽ nói sai, mà kiểu sai đó rất khó phát hiện bằng mắt.
    [[0.6, 0.6], [0.5, 0.25], [0.25, 0.9]].forEach(([w, h]) => {
        const W = 480;
        const H = 270;
        const g = ColorAdjust.renderMaskGray(
            { enabled: true, type: 'rect', width: w, height: h, feather: 0, roundness: 0 }, W, H);
        let onRow = 0;
        for (let x = 0; x < W; x += 1) if (g.gray[Math.floor(H / 2) * W + x] > 127) onRow += 1;
        let onCol = 0;
        for (let y = 0; y < H; y += 1) if (g.gray[y * W + Math.floor(W / 2)] > 127) onCol += 1;
        // Dung sai 1 pixel: biên của maskValueAt là `d <= 0` (BAO GỒM) và bake lấy mẫu ở TÂM
        // pixel, nên khi biên rơi đúng giữa hai tâm thì đếm được thêm một pixel. Đây là làm
        // tròn của phép ĐO, không phải lệch công thức.
        assert.ok(Math.abs(onRow - Math.round(w * W)) <= 1,
            `chiều rộng thật phải = width × W (w=${w}): đo ${onRow}, tính ${Math.round(w * W)}`);
        assert.ok(Math.abs(onCol - Math.round(h * H)) <= 1,
            `chiều cao thật phải = height × H (h=${h}): đo ${onCol}, tính ${Math.round(h * H)}`);
    });

    // HÌNH TRÒN PHẢI TRÒN THẬT khi hai số PIXEL bằng nhau. Đây là lý do ô nhập Rộng/Cao của
    // panel hiện theo pixel: hw = width×asp và hh = height (hai mốc khác nhau: W và H), nên
    // width = height chỉ ra hình tròn khi khung vuông — trên khung 9:16 nó ra oval cao, đúng
    // như người dùng báo. Điều kiện tròn là `width×W == height×H`, tức hai số PIXEL bằng nhau.
    [[480, 270], [270, 480], [400, 400]].forEach(([W, H]) => {
        const side = Math.round(Math.min(W, H) * 0.5);          // đường kính mong muốn (px)
        const g = ColorAdjust.renderMaskGray(
            { enabled: true, type: 'circle', width: side / W, height: side / H, feather: 0 }, W, H);
        let onRow = 0;
        for (let x = 0; x < W; x += 1) if (g.gray[Math.floor(H / 2) * W + x] > 127) onRow += 1;
        let onCol = 0;
        for (let y = 0; y < H; y += 1) if (g.gray[y * W + Math.floor(W / 2)] > 127) onCol += 1;
        assert.ok(Math.abs(onRow - onCol) <= 2,
            `khung ${W}×${H}: cùng số pixel thì hình tròn phải TRÒN, đo được ${onRow}×${onCol}`);
        assert.ok(Math.abs(onRow - side) <= 2, `đường kính phải ≈ ${side}px, đo được ${onRow}`);
    });

    const asp = 16 / 9;
    const at = (m, nx, ny) => ColorAdjust.maskValueAt(m, nx, ny, asp);

    // Chữ nhật 0.6x0.6 không feather: trong = 1, ngoài = 0, và biên đúng chỗ
    const rect = ColorAdjust.normalize({ mask: { enabled: true, type: 'rect', feather: 0 } }).mask;
    assert.strictEqual(at(rect, 0.5, 0.5), 1, 'tâm chữ nhật phải trong mặt nạ');
    assert.strictEqual(at(rect, 0.5, 0.02), 0, 'sát mép trên phải ngoài mặt nạ');
    assert.strictEqual(at(rect, 0.02, 0.5), 0, 'sát mép trái phải ngoài mặt nạ');
    // height=0.6 (nửa-khung) -> biên trên/dưới ở ny = 0.5 ± 0.3
    assert.strictEqual(at(rect, 0.5, 0.35), 1, 'ny=0.35 còn trong');
    assert.strictEqual(at(rect, 0.5, 0.15), 0, 'ny=0.15 đã ngoài');

    // ĐẢO phải lật đúng
    const inv = ColorAdjust.normalize({ mask: { enabled: true, type: 'rect', feather: 0, invert: true } }).mask;
    assert.strictEqual(at(inv, 0.5, 0.5), 0);
    assert.strictEqual(at(inv, 0.02, 0.5), 1);

    // Feather phải cho giá trị TRUNG GIAN ở biên, và đơn điệu từ trong ra ngoài
    const soft = ColorAdjust.normalize({ mask: { enabled: true, type: 'rect', feather: 40 } }).mask;
    const ramp = [0.5, 0.42, 0.34, 0.26, 0.18, 0.10].map((ny) => at(soft, 0.5, ny));
    for (let i = 1; i < ramp.length; i += 1) {
        assert.ok(ramp[i] <= ramp[i - 1] + 1e-9, `feather phải giảm dần ra ngoài: ${ramp.join(', ')}`);
    }
    assert.ok(ramp.some((v) => v > 0.05 && v < 0.95), `feather phải có vùng chuyển tiếp: ${ramp.join(', ')}`);

    // "Hình tròn" phải TRÒN THẬT trên khung 16:9 — nếu quên nhân tỉ lệ khung thì bán kính
    // theo trục ngang sẽ khác trục dọc và đây là chỗ lộ ra.
    const circle = ColorAdjust.normalize({
        mask: { enabled: true, type: 'circle', feather: 0, width: 0.5, height: 0.5 },
    }).mask;
    // đi ra 0.45 nửa-khung theo mỗi trục: cùng khoảng cách hình học -> cùng kết quả
    const rightIn = at(circle, 0.5 + (0.45 / 2) / asp, 0.5);
    const downIn = at(circle, 0.5, 0.5 + 0.45 / 2);
    assert.strictEqual(rightIn, downIn, 'hình tròn phải đối xứng theo hình học, không theo pixel');

    // "Tách" = nửa mặt phẳng; "Cuộn phim" = dải ngang
    const split = ColorAdjust.normalize({ mask: { enabled: true, type: 'split', feather: 0 } }).mask;
    assert.strictEqual(at(split, 0.5, 0.2), 1, 'Tách: nửa trên trong mặt nạ');
    assert.strictEqual(at(split, 0.5, 0.8), 0, 'Tách: nửa dưới ngoài mặt nạ');
    const strip = ColorAdjust.normalize({ mask: { enabled: true, type: 'filmstrip', feather: 0, height: 0.3 } }).mask;
    assert.strictEqual(at(strip, 0.5, 0.5), 1, 'Cuộn phim: giữa trong mặt nạ');
    assert.strictEqual(at(strip, 0.5, 0.1), 0, 'Cuộn phim: ngoài dải phải ngoài mặt nạ');
    assert.strictEqual(at(strip, 0.5, 0.9), 0, 'Cuộn phim: đối xứng hai mép');

    // XOAY: quay "Tách" 180° thì hai nửa phải đổi vai
    const rot = ColorAdjust.normalize({ mask: { enabled: true, type: 'split', feather: 0, rotation: 180 } }).mask;
    assert.strictEqual(at(rot, 0.5, 0.2), 0, 'Tách xoay 180°: nửa trên ra ngoài');
    assert.strictEqual(at(rot, 0.5, 0.8), 1, 'Tách xoay 180°: nửa dưới vào trong');

    // Bake ảnh xám: kích thước đúng, giá trị biên đúng
    const baked = ColorAdjust.renderMaskGray(rect, 64, 36);
    assert.strictEqual(baked.width, 64);
    assert.strictEqual(baked.height, 36);
    assert.strictEqual(baked.gray[18 * 64 + 32], 255, 'tâm ảnh mặt nạ phải trắng');
    assert.strictEqual(baked.gray[0], 0, 'góc ảnh mặt nạ phải đen');

    // ĐỘC LẬP ĐỘ PHÂN GIẢI: bake ở 2 kích thước rồi so tại CÙNG toạ độ tỉ lệ
    const small = ColorAdjust.renderMaskGray(soft, 80, 45);
    const large = ColorAdjust.renderMaskGray(soft, 320, 180);
    [[0.5, 0.5], [0.3, 0.4], [0.75, 0.62], [0.1, 0.1]].forEach(([nx, ny]) => {
        const a = small.gray[Math.floor(ny * 45) * 80 + Math.floor(nx * 80)];
        const b = large.gray[Math.floor(ny * 180) * 320 + Math.floor(nx * 320)];
        assert.ok(Math.abs(a - b) <= 6,
            `mặt nạ phải độc lập độ phân giải tại (${nx},${ny}): ${a} vs ${b}`);
    });
    console.log('  mặt nạ (toán) ok');
}

// End-to-end qua SIDECAR: filtergraph split/alphamerge/overlay có thật sự chạy và có
// giới hạn đúng vùng hay không. Đây là phần rủi ro nhất của mặt nạ.
function testMaskSidecar(workDir) {
    // Mặt nạ nửa trái trắng / nửa phải đen, dựng bằng chính engine ("Tách" xoay 90°)
    const adj = mk((a) => {
        a.basic.exposure = 60;      // sáng lên rõ để dễ đo
        a.mask.enabled = true;
        a.mask.type = 'split';
        a.mask.rotation = -90;      // ranh giới dọc: một nửa theo trục X
        a.mask.feather = 0;
    });
    const W = 320;
    const H = 240;
    const baked = ColorAdjust.renderMaskGray(ColorAdjust.normalize(adj).mask, W, H);
    // Ghi PNG bằng ffmpeg từ dữ liệu xám thô (test chạy trong Node, không có canvas)
    const rawPath = path.join(workDir, 'mask.gray');
    fs.writeFileSync(rawPath, Buffer.from(baked.gray));
    const maskPath = path.join(workDir, 'mask.png');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-i', rawPath,
        '-frames:v', '1', maskPath]);
    // Kiểm chính ảnh mặt nạ trước: hai nửa phải khác nhau, nếu không phép đo sau vô nghĩa
    assert.notStrictEqual(baked.gray[120 * W + 40], baked.gray[120 * W + 280],
        'ảnh mặt nạ phải chia hai nửa khác nhau');

    const srcVideo = path.join(workDir, 'msrc.mp4');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=0x506070:s=${W}x${H}:d=2:r=25`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        srcVideo]);

    const payload = {
        resolution: 'source', width: W, height: H,
        fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
        intervals: [{
            index: 0, start: 0.2, end: 1.8, position_x: 0, position_y: 0,
            scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
            adj_filters: ColorAdjust.ffmpegFilters(adj, '', H).join(','),
            adj_mask_path: maskPath,
        }],
    };
    const payloadPath = path.join(workDir, 'mask_timeline.json');
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    const outPath = path.join(workDir, 'mask_out.mp4');
    const result = spawnSync(SIDECAR, ['export-video', srcVideo, outPath, payloadPath, workDir, 'high', '25'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(result.status, 0, `sidecar lỗi khi có mặt nạ:\n${result.stdout}\n${result.stderr}`);

    const sample = (x) => {
        const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.6', '-i', outPath,
            '-frames:v', '1', '-vf', `crop=8:8:${x}:120,scale=1:1`,
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
        assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
        return [out.stdout[0], out.stdout[1], out.stdout[2]];
    };
    const left = sample(40);
    const right = sample(272);
    const srcRgb = [0x50, 0x60, 0x70];
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    console.log(`  mặt nạ end-to-end       nguồn ${srcRgb} -> trong mặt nạ ${left} · ngoài ${right}`);
    // Bên trong mặt nạ phải SÁNG hơn hẳn; bên ngoài phải gần như y nguyên nguồn.
    assert.ok(lum(left) - lum(right) > 25,
        `mặt nạ không giới hạn được vùng: trong=${lum(left).toFixed(0)} ngoài=${lum(right).toFixed(0)}`);
    assert.ok(Math.abs(lum(right) - lum(srcRgb)) < 12,
        `vùng NGOÀI mặt nạ phải giữ nguyên màu nguồn, đo được ${lum(right).toFixed(0)} vs ${lum(srcRgb).toFixed(0)}`);
}

// ===================== PREVIEW BÁM PLAYHEAD (keyframe màu) =====================
//
// Lỗi đã mắc: keyframe xuất ra ĐÚNG nhưng preview đứng im, vì các đường VẼ truyền
// `obj.adjustments` (giá trị BASE) vào bộ chỉnh màu thay vì giá trị hiệu dụng tại
// playhead. Toán thì đúng, WYSIWYG vẫn vỡ — nên phần này chốt CẤU TRÚC của đường vẽ,
// không chỉ chốt công thức.
function testPreviewFollowsPlayhead() {
    // 1) Toán: uniform của shader PHẢI khác nhau ở 2 thời điểm — nếu không thì dù có nối
    //    dây đúng, preview cũng chẳng đổi gì.
    const base = ColorAdjust.defaultAdjustments();
    const kf = {
        'adj.basic.exposure': [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 60, e: 'linear' }],
        'adj.basic.temperature': [{ t: 0, v: -60, e: 'linear' }, { t: 2, v: 60, e: 'linear' }],
    };
    const uniformsAt = (t) => ColorAdjust.shaderUniforms(
        ColorAdjust.effectiveAdjustments(base, kf, t, TextAnimations.evalKeyframeField));
    const u0 = uniformsAt(0);
    const u1 = uniformsAt(1);
    const u2 = uniformsAt(2);
    assert.ok(u2.uEqContrast > u1.uEqContrast && u1.uEqContrast > u0.uEqContrast,
        'uniform eq phải tăng dần theo thời gian (phơi sáng gộp vào contrast)');
    assert.ok(u0.uCbShadows[0] < u2.uCbShadows[0],
        'uniform colorbalance phải chạy theo keyframe Nhiệt độ');

    // 2) Cấu trúc: mọi đường vẽ đưa ảnh qua bộ chỉnh màu phải truyền giá trị HIỆU DỤNG.
    //    Bắt theo mẫu văn bản vì đây là chỗ dễ tái phạm nhất: thêm một đường vẽ mới rồi
    //    truyền quen tay `x.adjustments`.
    const runtimeSrc = fs.readFileSync(
        path.join(PROJECT_ROOT, 'static', 'js', 'editing-runtime.js'), 'utf8');
    const indexSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'index.html'), 'utf8');
    const rawCalls = runtimeSrc.match(/colorAdjustedDrawable\([^;]*?\.adjustments/g) || [];
    assert.deepStrictEqual(rawCalls, [],
        `đường vẽ còn truyền adjustments BASE vào colorAdjustedDrawable: ${rawCalls.join(' | ')}`);
    assert.ok(/effectiveAdjustments/.test(indexSrc),
        'sprite lane chính (index.html) phải lấy adjustments hiệu dụng tại playhead');
    assert.ok(!/const clipAdj = activeClip \? activeClip\.adjustments/.test(indexSrc),
        'sprite lane chính không được dùng activeClip.adjustments (base) để dựng filter');
    assert.ok(/effectiveAdjustments,/.test(runtimeSrc),
        'effectiveAdjustments phải được EditingRuntime xuất ra cho index.html dùng chung');

    // 2b) SỐ TRÊN PANEL cũng phải bám playhead. Lỗi đã mắc: preview đổi đúng nhưng ô số kẹt ở
    // giá trị của lần dựng panel cuối (keyframe Nhiệt độ 0 → 80 thì về mốc 0 vẫn hiện 80), vì
    // panel chỉ dựng lại khi CHỌN hoặc SỬA. Phép sửa là đẩy giá trị hiệu dụng ra DOM mỗi lần
    // render preview — cùng chỗ mà bảng transform đang dùng.
    assert.ok(/function syncAdjustPanelValues\(\)/.test(runtimeSrc),
        'phải có hàm đồng bộ số của panel Điều chỉnh theo playhead');
    assert.ok(/if \(!inspectorEditInProgress\) syncAdjustPanelValues\(\);/.test(runtimeSrc),
        'phải gọi từ đường render preview (phủ mọi cách di chuyển playhead), và BỎ QUA khi đang sửa');
    const syncBody = runtimeSrc.slice(runtimeSrc.indexOf('function syncAdjustPanelValues()'));
    assert.ok(/currentAdjustments\(\)/.test(syncBody.slice(0, 2000)),
        'panel phải lấy giá trị HIỆU DỤNG (currentAdjustments), không lấy base');

    // 3) Ảnh có hoạt ảnh được bake ra chuỗi PNG: đó là đường xuất DUY NHẤT của nó, nên có
    //    keyframe màu thì phải vẽ lại màu TỪNG FRAME và không được gộp frame vùng hold.
    assert.ok(/perFrame/.test(runtimeSrc),
        'bake chuỗi PNG phải có đường per-frame cho ảnh có keyframe màu');
    // Gộp frame vùng hold phải xét CẢ chữ ký nội dung: gộp theo transform không thôi là
    // đóng băng màu; bỏ gộp cả span thì payload phình vô ích ở đoạn màu không đổi.
    assert.ok(/isStatic && prevStatic && sameContent/.test(runtimeSrc)
        && /contentSigAt/.test(runtimeSrc),
        'phép gộp frame hold phải xét chữ ký nội dung (contentSigAt), không chỉ transform');
    console.log('  preview bám playhead ok');
}

// ===================== VỊ TRÍ CHÈN lut3d KHI EXPORT =====================
//
// LỖI ĐÃ MẮC: backend nối `lut3d` vào CUỐI chuỗi filter, nên nó chạy SAU nhóm hiệu ứng
// không gian, trong khi preview áp TRƯỚC. Đo bằng ffmpeg thật (LUT đẩy đỏ + vignette):
// lệch max 88/255 — gấp 5 lần ngưỡng TOLERANCE của cả panel. Nay frontend đặt TOKEN đúng
// chỗ và backend chỉ thay vào, nên thứ tự chỉ còn nằm ở MỘT nơi: ffmpegFilters().
function testLutSlotOrder() {
    const adj = mk((a) => {
        a.hsl.orange.s = 40;      // -> cần lut3d
        a.effects.sharpen = 40;   // -> nhóm hiệu ứng (phải chạy SAU lut3d)
        a.effects.vignette = 60;
    });
    const parts = ColorAdjust.ffmpegFilters(adj, '', 1080, { lutSlot: true });
    const slotAt = parts.indexOf(ColorAdjust.LUT3D_SLOT);
    assert.ok(slotAt >= 0, 'phải có chỗ trống cho lut3d khi lutSlot = true');
    ['format=yuv444p', 'unsharp', 'vignette'].forEach((name) => {
        const at = parts.findIndex((f) => f.startsWith(name));
        assert.ok(at > slotAt, `lut3d phải đứng TRƯỚC ${name} (đang ở ${slotAt}, ${name} ở ${at})`);
    });
    assert.ok(!ColorAdjust.ffmpegFilters(adj, '', 1080).includes(ColorAdjust.LUT3D_SLOT),
        'không bật lutSlot thì KHÔNG được có token (đường preview/test dùng chuỗi này)');

    // Phép thay của backend phải cho ra ĐÚNG chuỗi mà ffmpegFilters sinh khi biết đường dẫn
    const lut = "lut3d=file='/tmp/x.cube':interp=trilinear";
    assert.strictEqual(
        parts.join(',').split(ColorAdjust.LUT3D_SLOT).join(lut),
        ColorAdjust.ffmpegFilters(adj, '/tmp/x.cube', 1080).join(','),
        'thay token phải khớp chuỗi có lutPath');

    // Bake .cube lỗi -> token phải bị xoá SẠCH cùng dấu phẩy, không để lại tên filter lạ
    const dropped = parts.join(',')
        .replace(new RegExp(`,?${ColorAdjust.LUT3D_SLOT},?`, 'g'), (m) => (m.startsWith(',') && m.endsWith(',') ? ',' : ''));
    assert.ok(!dropped.includes(ColorAdjust.LUT3D_SLOT), 'token phải bị xoá hết');
    assert.ok(!dropped.includes(',,') && !dropped.startsWith(',') && !dropped.endsWith(','),
        `chuỗi còn dấu phẩy lạc: ${dropped}`);
    console.log('  vị trí chèn lut3d ok');
}

// ===================== HÌNH HỌC TAY CẦM MẶT NẠ =====================
//
// Cái duy nhất đáng chốt ở đây: đường viền vẽ trên preview phải là ĐÚNG biên của vùng mặt
// nạ mà shader/PNG thật dùng. Nếu lệch, người dùng kéo theo đường viền mà màu ăn ra chỗ
// khác — sai kiểu khó phát hiện nhất.
function testMaskOutlineGeometry() {
    const CASES = [
        { type: 'rect', x: 0, y: 0, rotation: 0, width: 0.5, height: 0.4, roundness: 0 },
        { type: 'rect', x: 0.3, y: -0.2, rotation: 37, width: 0.45, height: 0.3, roundness: 60 },
        { type: 'circle', x: -0.25, y: 0.15, rotation: -20, width: 0.4, height: 0.28, roundness: 0 },
        { type: 'filmstrip', x: 0, y: 0.1, rotation: 15, width: 0.5, height: 0.22, roundness: 0 },
        { type: 'split', x: 0, y: -0.3, rotation: 100, width: 0.5, height: 0.5, roundness: 0 },
    ];
    const asp = 16 / 9;
    CASES.forEach((base) => {
        // feather = 0 -> giá trị mặt nạ là bậc thang tại d = 0, nên "đúng biên" đo được
        // bằng cách lấy 2 điểm lệch nhẹ vào trong / ra ngoài theo PHÁP TUYẾN.
        const mask = { ...ColorAdjust.defaultMask(), ...base, enabled: true, feather: 0, invert: false };
        const polys = ColorAdjust.maskOutlinePolys(mask, asp);
        assert.ok(polys.length >= 1, `${base.type}: phải có đường viền`);
        // Điểm biên (u,v) toàn cục -> toạ độ chuẩn hoá 0..1 để gọi maskValueAt
        const toN = (u, v) => ({ nx: (u / (2 * asp)) + 0.5, ny: (v / 2) + 0.5 });
        let checked = 0;
        polys.forEach((poly) => {
            // Đường MỞ ("Tách"/"Cuộn phim") kéo dài ra tận ngoài khung để vẽ, nên không đo
            // ở đầu mút mà lấy vài điểm dọc đường, trong khoảng còn nằm trong khung.
            const samples = poly.closed
                ? poly.pts
                : [-1, 0, 1].map((lu) => [lu, poly.pts[0][1]]);
            samples.forEach(([lu, lv]) => {
                const g = ColorAdjust.maskRotateCw(mask.rotation, lu, lv);
                const cu = (mask.x * asp) + g.x;
                const cv = mask.y + g.y;
                // Pháp tuyến hướng RA NGOÀI, tính trong hệ local rồi xoay:
                //  - nửa mặt phẳng / dải ngang: trục v của chính mặt nạ
                //  - hình lồi (chữ nhật/ellipse): hướng từ tâm ra điểm biên
                let lnu = lu;
                let lnv = lv;
                if (poly.closed === false) { lnu = 0; lnv = lv >= 0 ? 1 : -1; }
                if (Math.hypot(lnu, lnv) < 1e-6) { lnu = 0; lnv = 1; }
                const n = ColorAdjust.maskRotateCw(mask.rotation, lnu, lnv);
                const len = Math.hypot(n.x, n.y) || 1;
                const eps = 0.02;
                const inP = toN(cu - (n.x / len) * eps, cv - (n.y / len) * eps);
                const outP = toN(cu + (n.x / len) * eps, cv + (n.y / len) * eps);
                const vIn = ColorAdjust.maskValueAt(mask, inP.nx, inP.ny, asp);
                const vOut = ColorAdjust.maskValueAt(mask, outP.nx, outP.ny, asp);
                assert.strictEqual(vIn, 1,
                    `${base.type}: ngay TRONG đường viền phải thuộc mặt nạ (local ${lu},${lv})`);
                assert.strictEqual(vOut, 0,
                    `${base.type}: ngay NGOÀI đường viền phải ngoài mặt nạ (local ${lu},${lv})`);
                checked += 1;
            });
        });
        assert.ok(checked >= 3, `${base.type}: quá ít điểm biên được kiểm (${checked})`);
    });

    // Ánh xạ màn hình ⇄ (u,v) phải là NGHỊCH ĐẢO thật, kể cả khi block xoay / lật / co giãn
    // không đều — đây là phép mà cú kéo dựa vào.
    const frames = [
        { rot: 0, sx: 1, sy: 1 },
        { rot: 30, sx: 0.6, sy: 0.6 },
        { rot: -75, sx: -0.8, sy: 0.8 },      // lật X
        { rot: 12, sx: 0.5, sy: -1.3 },       // lật Y + co giãn không đều
    ];
    frames.forEach((f) => {
        const rad = f.rot * Math.PI / 180;
        const rot = (x, y) => ({ x: x * Math.cos(rad) - y * Math.sin(rad), y: x * Math.sin(rad) + y * Math.cos(rad) });
        const unit = 270;   // nửa chiều cao nguồn (pixel màn hình) — số nào cũng được
        const sf = {
            cx: 640, cy: 360,
            ex: rot(f.sx * unit, 0),
            ey: rot(0, f.sy * unit),
        };
        [[0.4, -0.7], [-1.2, 0.3], [0, 0], [1.8, 1.8]].forEach(([u, v]) => {
            const p = ColorAdjust.maskPointToScreen(sf, u, v);
            const back = ColorAdjust.maskScreenDeltaToUv(sf, p.x - sf.cx, p.y - sf.cy);
            assert.ok(back, 'khung không được suy biến');
            assert.ok(Math.abs(back.u - u) < 1e-9 && Math.abs(back.v - v) < 1e-9,
                `nghịch đảo sai: (${u},${v}) -> (${back.u},${back.v}) với rot=${f.rot}`);
        });
    });
    // Khung suy biến (scale 0) phải trả null chứ không sinh NaN rồi ghi rác vào dữ liệu
    assert.strictEqual(
        ColorAdjust.maskScreenDeltaToUv({ cx: 0, cy: 0, ex: { x: 0, y: 0 }, ey: { x: 0, y: 0 } }, 5, 5),
        null);
    console.log('  hình học tay cầm mặt nạ ok');
}

function main() {
    console.log('color adjust: kiểm tra');
    testPreviewFollowsPlayhead();
    testMaskOutlineGeometry();
    testLutSlotOrder();
    testPureMath();
    testWhiteBalance();
    testHslBandPick();
    testMaskMath();
    testAdjustKeyframeMath();
    if (!ffmpegAvailable()) {
        console.log('  (bỏ qua đối chiếu FFmpeg: không tìm thấy ffmpeg trong PATH)');
    } else {
        testAgainstFfmpeg();
        console.log('color adjust: nhóm hiệu ứng (không gian)');
        testEffects();
        testSidecarEndToEnd();
    }
    console.log('color adjust pipeline ok');
}

main();
