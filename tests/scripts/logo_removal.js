/* =============================================================================
 * XOÁ LOGO — static/js/logo-removal.js + đường xuất (backend -> sidecar -> FFmpeg)
 *
 * Chốt 4 điều:
 *   1. Mô hình dữ liệu: chuẩn hoá, isActive/isEmpty, quy đổi pixel CHẴN + lề an toàn.
 *   2. WYSIWYG: bản JS mà preview chạy phải trùng FFmpeg thật —
 *        delogoRgba   == `delogo`            (TỪNG PIXEL, trong YUV444 để khỏi lẫn sai số đổi màu)
 *        boxBlurRgba  ≈  `boxblur` power 2
 *        pixelateRgba ≈  `scale=flags=area` + `scale=flags=neighbor`
 *   3. Tự nhận diện: thấy logo cố định ở góc trên nền động; bỏ qua vật ở giữa khung; báo
 *      "cảnh tĩnh" khi nền đứng yên.
 *   4. Backend chỉ dựng lại chuỗi từ số đã kẹp; sidecar thật sự chèn filter vào bản xuất.
 *
 * Chạy: node tests/scripts/logo_removal.js   (phần FFmpeg/sidecar tự bỏ qua nếu thiếu)
 * ========================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
// Test có require backend -> PHẢI trỏ thư mục tạm sang test_temp TRƯỚC (xem backend_smoke.js:
// thiếu dòng này là test xoá dữ liệu dự án người dùng đang mở).
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || path.join(ROOT, 'test_temp', 'logo_removal');

const LogoRemoval = require(path.join(ROOT, 'static', 'js', 'logo-removal.js'));
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build',
    process.platform === 'win32' ? 'core_process.exe' : 'core_process');

function ffmpegAvailable() {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function ffmpegRaw(args) {
    const out = spawnSync('ffmpeg', ['-v', 'error', ...args, '-f', 'rawvideo', '-'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
    return out.stdout;
}

// ------------------------------------------------------------------ 1. dữ liệu
function testModel() {
    const d = LogoRemoval.normalize(null);
    assert.deepStrictEqual(d, { enabled: false, mode: 'delogo', strength: 50, regions: [], objects: [] });
    const n = LogoRemoval.normalize({
        enabled: true, mode: 'weird', strength: 180,
        regions: [
            { x: 0.9, y: -1, w: 0.5, h: 0.2 },        // tràn mép -> bị kẹp vào khung
            { x: 0.1, y: 0.1, w: 0.001, h: 0.2 },     // quá mảnh -> bỏ
            { x: 'a', y: 0, w: 0.1, h: 0.1 },         // hỏng -> bỏ
            ...Array.from({ length: 6 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 })),
        ],
    });
    assert.strictEqual(n.mode, 'delogo');
    assert.strictEqual(n.strength, 100);
    assert.strictEqual(n.regions.length, LogoRemoval.MAX_REGIONS);
    assert.deepStrictEqual(n.regions[0], { x: 0.9, y: 0, w: 0.1, h: 0.2 });

    assert.strictEqual(LogoRemoval.isActive({ enabled: true, regions: [] }), false);
    assert.strictEqual(LogoRemoval.isActive({ enabled: false, regions: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] }), false);
    assert.strictEqual(LogoRemoval.isActive({ enabled: true, regions: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] }), true);
    // Tắt nhưng còn vùng -> KHÔNG rỗng (giữ để bật lại).
    assert.strictEqual(LogoRemoval.isEmpty({ enabled: false, regions: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] }), false);
    assert.strictEqual(LogoRemoval.isEmpty({ enabled: false, regions: [] }), true);

    // Quy đổi pixel: chẵn, trong lề, theo VÙNG ẢNH (content) chứ không theo cả khung.
    const px = LogoRemoval.regionToPixels({ x: 0.5, y: 0.25, w: 0.25, h: 0.5 },
        { x: 100, y: 0, width: 200, height: 100 }, 400, 100);
    assert.deepStrictEqual(px, { x: 200, y: 24, w: 50, h: 52 });
    // Chạm mép -> lùi vào đúng FRAME_MARGIN (delogo từ chối vùng chạm mép khung).
    const edge = LogoRemoval.regionToPixels({ x: 0, y: 0, w: 1, h: 1 }, null, 321, 181);
    assert.deepStrictEqual(edge, { x: 2, y: 2, w: 316, h: 176 });
    [edge.x, edge.y, edge.w, edge.h].forEach((v) => assert.strictEqual(v % 2, 0));
    // Thông số hiệu ứng nằm trong trần mà boxblur chấp nhận (≤ cạnh ngắn / 4).
    for (const s of [0, 50, 100]) {
        const r = LogoRemoval.effectParamPx('blur', s, 40, 24);
        assert.ok(r >= 1 && r <= 6, `blur r=${r}`);
        const b = LogoRemoval.effectParamPx('pixelate', s, 40, 24);
        assert.ok(b >= 2 && b <= 12, `pixelate b=${b}`);
    }
    const rects = LogoRemoval.exportRects({ enabled: true, mode: 'blur', strength: 100,
        regions: [{ x: 0.8, y: 0.05, w: 0.15, h: 0.1 }] }, null, 320, 240);
    assert.strictEqual(rects.length, 1);
    assert.strictEqual(rects[0].p, LogoRemoval.effectParamPx('blur', 100, rects[0].w, rects[0].h));
    console.log('  ✓ mô hình dữ liệu + quy đổi pixel');
}

// --------------------------------------------------------- 2. khớp FFmpeg thật
// Nạp YUV444 3 mặt phẳng vào buffer "RGBA" (Y,U,V,255): các phép của module đều TUYẾN
// TÍNH theo từng kênh nên chạy trên YUV là đo đúng công thức, không lẫn sai số đổi màu.
function yuv444ToRgba(buf, W, H) {
    const P = W * H;
    const out = new Uint8ClampedArray(P * 4);
    for (let i = 0; i < P; i++) {
        out[i * 4] = buf[i]; out[i * 4 + 1] = buf[P + i]; out[i * 4 + 2] = buf[2 * P + i]; out[i * 4 + 3] = 255;
    }
    return out;
}

function diffStats(rgba, W, ref, refW, box) {
    const P = ref.length / 3;
    let max = 0; let sum = 0; let n = 0;
    for (let y = 0; y < box.h; y++) {
        for (let x = 0; x < box.w; x++) {
            for (let c = 0; c < 3; c++) {
                const a = rgba[((box.y + y) * W + box.x + x) * 4 + c];
                const b = ref[c * P + (y + (box.ry || 0)) * refW + x + (box.rx || 0)];
                const d = Math.abs(a - b);
                if (d > max) max = d;
                sum += d; n++;
            }
        }
    }
    return { max, mean: sum / Math.max(1, n) };
}

function testAgainstFfmpeg() {
    if (!ffmpegAvailable()) { console.log('  (bỏ qua so FFmpeg: không có ffmpeg)'); return; }
    const W = 160; const H = 90;
    const src = ffmpegRaw(['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}`, '-frames:v', '1', '-pix_fmt', 'yuv444p']);
    const inFile = path.join(os.tmpdir(), `crab-logo-${process.pid}.yuv`);
    fs.writeFileSync(inFile, src);
    const raw = ['-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-s', `${W}x${H}`, '-i', inFile, '-frames:v', '1'];
    try {
        // DELOGO: từng pixel, cả ca vùng sát lề an toàn.
        for (const r of [{ x: 100, y: 10, w: 40, h: 24 }, { x: 2, y: 2, w: 30, h: 20 }, { x: 10, y: 40, w: 7, h: 9 }]) {
            const ref = ffmpegRaw([...raw, '-vf', `delogo=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}`, '-pix_fmt', 'yuv444p']);
            const img = yuv444ToRgba(src, W, H);
            LogoRemoval.delogoRgba(img, W, r.x, r.y, r.w, r.h);
            const st = diffStats(img, W, ref, W, { x: 0, y: 0, w: W, h: H });
            assert.strictEqual(st.max, 0, `delogo lệch FFmpeg ${st.max} tại vùng ${JSON.stringify(r)}`);
        }
        console.log('  ✓ delogoRgba trùng từng pixel với FFmpeg `delogo`');

        // BOXBLUR power 2 (mép phản xạ): lệch làm tròn trung gian của FFmpeg, vài đơn vị.
        const bx = { x: 100, y: 10, w: 40, h: 24 };
        for (const radius of [1, 3, 6]) {
            const ref = ffmpegRaw([...raw, '-vf',
                `crop=${bx.w}:${bx.h}:${bx.x}:${bx.y},boxblur=luma_radius=${radius}:luma_power=2:chroma_radius=${radius}:chroma_power=2`,
                '-pix_fmt', 'yuv444p']);
            const img = yuv444ToRgba(src, W, H);
            LogoRemoval.boxBlurRgba(img, W, bx.x, bx.y, bx.w, bx.h, radius);
            const st = diffStats(img, W, ref, bx.w, { ...bx, rx: 0, ry: 0 });
            assert.ok(st.mean <= 2.5 && st.max <= 40, `boxblur r=${radius} lệch mean=${st.mean.toFixed(2)} max=${st.max}`);
        }
        console.log('  ✓ boxBlurRgba ≈ FFmpeg `boxblur` power 2');

        for (const block of [4, 8]) {
            const nx = Math.max(1, Math.round(bx.w / block));
            const ny = Math.max(1, Math.round(bx.h / block));
            const ref = ffmpegRaw([...raw, '-vf',
                `crop=${bx.w}:${bx.h}:${bx.x}:${bx.y},scale=${nx}:${ny}:flags=area,scale=${bx.w}:${bx.h}:flags=neighbor`,
                '-pix_fmt', 'yuv444p']);
            const img = yuv444ToRgba(src, W, H);
            LogoRemoval.pixelateRgba(img, W, bx.x, bx.y, bx.w, bx.h, block);
            const st = diffStats(img, W, ref, bx.w, { ...bx, rx: 0, ry: 0 });
            assert.ok(st.mean <= 6, `pixelate b=${block} lệch mean=${st.mean.toFixed(2)}`);
        }
        console.log('  ✓ pixelateRgba ≈ FFmpeg scale area + neighbor');
    } finally {
        fs.rmSync(inFile, { force: true });
    }
}

// ----------------------------------------------------------- 3. tự nhận diện
function makeFrames({ w, h, n, logo, dynamic = true, seed = 7 }) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const frames = [];
    for (let k = 0; k < n; k++) {
        const f = new Uint8Array(w * h);
        const ox = dynamic ? k * 17 : 0;
        const oy = dynamic ? k * 9 : 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                f[y * w + x] = Math.round(120 + 60 * Math.sin((x + ox) * 0.11) * Math.cos((y + oy) * 0.07) + rnd() * 16);
            }
        }
        if (logo) {
            for (let y = logo.y; y < logo.y + logo.h; y++) {
                for (let x = logo.x; x < logo.x + logo.w; x++) {
                    if ((x - logo.x) % 8 < 3 || (y - logo.y) % 7 < 2) f[y * w + x] = 245;
                }
            }
        }
        frames.push(f);
    }
    return frames;
}

function testDetection() {
    const w = 320; const h = 180;
    const logo = { x: 250, y: 12, w: 50, h: 28 };
    const res = LogoRemoval.detectLogoRegions(makeFrames({ w, h, n: 12, logo }), w, h);
    assert.strictEqual(res.regions.length, 1, JSON.stringify(res));
    assert.strictEqual(res.staticScene, false);
    const r = res.regions[0];
    const px = { x0: r.x * w, y0: r.y * h, x1: (r.x + r.w) * w, y1: (r.y + r.h) * h };
    // Hộp phải BAO trọn logo, và chỉ nới lề vừa phải (≤ 12px mỗi phía ở 320px).
    assert.ok(px.x0 <= logo.x && px.y0 <= logo.y && px.x1 >= logo.x + logo.w && px.y1 >= logo.y + logo.h,
        `hộp không bao logo: ${JSON.stringify(px)}`);
    assert.ok(logo.x - px.x0 <= 12 && px.x1 - (logo.x + logo.w) <= 12, `hộp nới quá rộng: ${JSON.stringify(px)}`);

    // Góc dưới-trái cũng phải thấy.
    const bl = { x: 14, y: 140, w: 44, h: 26 };
    const res2 = LogoRemoval.detectLogoRegions(makeFrames({ w, h, n: 10, logo: bl }), w, h);
    assert.strictEqual(res2.regions.length, 1);
    assert.ok(res2.regions[0].x * w <= bl.x && res2.regions[0].y * h <= bl.y);

    // Vật đứng yên GIỮA khung (bảng tên, phụ đề cứng) -> KHÔNG coi là logo.
    const mid = { x: 140, y: 76, w: 40, h: 28 };
    const res3 = LogoRemoval.detectLogoRegions(makeFrames({ w, h, n: 10, logo: mid }), w, h);
    assert.strictEqual(res3.regions.length, 0, `nhận nhầm vật ở giữa: ${JSON.stringify(res3.regions)}`);

    // Không có logo -> không có vùng.
    const res4 = LogoRemoval.detectLogoRegions(makeFrames({ w, h, n: 10 }), w, h);
    assert.strictEqual(res4.regions.length, 0, `nhận nhầm nền: ${JSON.stringify(res4.regions)}`);

    // Nền đứng yên -> phải báo staticScene để UI cảnh báo.
    const res5 = LogoRemoval.detectLogoRegions(makeFrames({ w, h, n: 8, logo, dynamic: false }), w, h);
    assert.strictEqual(res5.staticScene, true);

    // HỒI QUY: nền đổi HẲN giữa các khung (nhiễu độc lập) -> trung vị gradient của nền ≈ 0,
    // gần như chỉ logo có điểm. Bản đầu tính ngưỡng trên pixel điểm > 0 nên ngưỡng bị chính
    // logo kéo lên cao hơn logo và không tìm ra gì (gặp trên video thật).
    {
        let s = 3;
        const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
        const frames = [];
        for (let k = 0; k < 16; k++) {
            const f = new Uint8Array(w * h);
            for (let i = 0; i < w * h; i++) f[i] = Math.round(40 + rnd() * 170);
            for (let y = logo.y; y < logo.y + logo.h; y++) {
                for (let x = logo.x; x < logo.x + logo.w; x++) f[y * w + x] = 250;
            }
            frames.push(f);
        }
        const r6 = LogoRemoval.detectLogoRegions(frames, w, h);
        assert.strictEqual(r6.regions.length, 1, `nền nhiễu độc lập: ${JSON.stringify(r6)}`);
    }

    // Quá ít khung -> không đoán.
    assert.strictEqual(LogoRemoval.detectLogoRegions(makeFrames({ w, h, n: 2, logo }), w, h).reason, 'frames');
    console.log('  ✓ tự nhận diện logo ở góc (bỏ qua giữa khung, báo cảnh tĩnh)');
}

// -------------------------------------------------------------- 4. backend + sidecar
function testBackendNormalize() {
    const { normalizeLogoRemovalFields } = require(path.join(ROOT, 'backend', 'server.js'));
    assert.deepStrictEqual(normalizeLogoRemovalFields(null), {});
    const out = normalizeLogoRemovalFields({
        mode: 'blur;drawtext',
        rects: [
            { x: 10.4, y: '20', w: 40, h: 30, p: 4 },
            { x: 0, y: 0, w: 2, h: 40, p: 0 },               // quá hẹp -> bỏ
            { x: '1];movie=x', y: 0, w: 40, h: 40, p: 0 },   // không phải số -> bỏ
        ],
    });
    // Chế độ lạ -> delogo; chuỗi chỉ gồm số đã kẹp.
    assert.deepStrictEqual(out, { logo_mode: 'delogo', logo_rects: '10:20:40:30:4' });
    assert.ok(/^[0-9:|]+$/.test(out.logo_rects));
    assert.deepStrictEqual(normalizeLogoRemovalFields({ mode: 'pixelate', rects: [] }), {});
    console.log('  ✓ backend chỉ dựng lại chuỗi từ số đã kẹp');
}

function regionMeanRgb(buf, W, box) {
    const acc = [0, 0, 0];
    for (let y = box.y; y < box.y + box.h; y++) {
        for (let x = box.x; x < box.x + box.w; x++) {
            for (let c = 0; c < 3; c++) acc[c] += buf[(y * W + x) * 3 + c];
        }
    }
    return acc.map((v) => v / (box.w * box.h));
}

function testSidecarEndToEnd() {
    if (!ffmpegAvailable() || !fs.existsSync(SIDECAR)) {
        console.log('  (bỏ qua end-to-end: thiếu ffmpeg hoặc chưa build sidecar)');
        return;
    }
    const W = 320; const H = 240;
    const logo = { x: 262, y: 14, w: 40, h: 22 };
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-logo-e2e-'));
    try {
        // Nền TĨNH (smptebars) + "logo" trắng đặc ở góc trên-phải. Có track audio vì filter
        // script luôn tham chiếu [0:a] (xem color_adjust_pipeline.js).
        const srcVideo = path.join(workDir, 'src.mp4');
        execFileSync('ffmpeg', [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', `smptebars=s=${W}x${H}:d=2:r=25,drawbox=x=${logo.x}:y=${logo.y}:w=${logo.w}:h=${logo.h}:color=white:t=fill`,
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2',
            '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', srcVideo,
        ]);
        const grab = (file) => ffmpegRaw(['-ss', '0.5', '-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24']);
        const srcRgb = grab(srcVideo);
        const cfg = { enabled: true, strength: 60, regions: [{
            x: (logo.x - 4) / W, y: (logo.y - 4) / H, w: (logo.w + 8) / W, h: (logo.h + 8) / H,
        }] };

        for (const mode of ['delogo', 'blur', 'pixelate']) {
            const rects = LogoRemoval.exportRects({ ...cfg, mode }, null, W, H);
            assert.strictEqual(rects.length, 1);
            const payload = {
                resolution: 'source', width: W, height: H,
                fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
                intervals: [{
                    index: 0, start: 0.2, end: 1.8, position_x: 0, position_y: 0,
                    scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
                    logo_mode: mode,
                    logo_rects: rects.map((r) => `${r.x}:${r.y}:${r.w}:${r.h}:${r.p}`).join('|'),
                }],
            };
            const payloadPath = path.join(workDir, `timeline_${mode}.json`);
            fs.writeFileSync(payloadPath, JSON.stringify(payload));
            const outPath = path.join(workDir, `out_${mode}.mp4`);
            const result = spawnSync(SIDECAR, ['export-video', srcVideo, outPath, payloadPath, workDir, 'high', '25'],
                { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
            assert.strictEqual(result.status, 0, `sidecar lỗi (${mode}):\n${result.stdout}\n${result.stderr}`);
            const outRgb = grab(outPath);

            // Kỳ vọng = khung nguồn cho qua CHÍNH bản JS mà preview chạy.
            const expect = new Uint8ClampedArray(W * H * 4);
            for (let i = 0; i < W * H; i++) {
                expect[i * 4] = srcRgb[i * 3]; expect[i * 4 + 1] = srcRgb[i * 3 + 1];
                expect[i * 4 + 2] = srcRgb[i * 3 + 2]; expect[i * 4 + 3] = 255;
            }
            LogoRemoval.applyRectRgba(expect, W, rects[0], mode);
            const expRgb = Buffer.alloc(W * H * 3);
            for (let i = 0; i < W * H; i++) {
                expRgb[i * 3] = expect[i * 4]; expRgb[i * 3 + 1] = expect[i * 4 + 1]; expRgb[i * 3 + 2] = expect[i * 4 + 2];
            }
            const box = { x: rects[0].x, y: rects[0].y, w: rects[0].w, h: rects[0].h };
            const got = regionMeanRgb(outRgb, W, box);
            const want = regionMeanRgb(expRgb, W, box);
            const before = regionMeanRgb(srcRgb, W, logo);
            const after = regionMeanRgb(outRgb, W, logo);
            const lech = Math.max(...got.map((v, i) => Math.abs(v - want[i])));
            console.log(`  end-to-end ${mode.padEnd(8)} logo trước ${before.map((v) => v.toFixed(0))}`
                + ` -> sau ${after.map((v) => v.toFixed(0))}  lệch preview=${lech.toFixed(1)}`);
            // Thêm 2 lượt h264 + 4:2:0 -> ngưỡng theo TRUNG BÌNH vùng.
            assert.ok(lech <= 10, `${mode}: bản xuất lệch preview ${lech.toFixed(1)}/255`);
            if (mode === 'delogo') {
                // Logo trắng phải biến mất (không còn gần 235).
                assert.ok(Math.max(...after) < 200, `delogo: logo vẫn còn ${after}`);
            }
            // Ngoài vùng giữ nguyên: đo một ô ở góc trái dưới.
            const far = { x: 20, y: 150, w: 16, h: 16 };
            const farDiff = Math.max(...regionMeanRgb(outRgb, W, far).map((v, i) => Math.abs(v - regionMeanRgb(srcRgb, W, far)[i])));
            assert.ok(farDiff <= 4, `${mode}: vùng ngoài bị đổi ${farDiff.toFixed(1)}`);
        }

        // MEDIA OVERLAY: nhánh filter KHÁC lane chính (WriteVisualOverlayFilter). Overlay phủ
        // kín khung = chính video có logo, lane chính bên dưới là màu phẳng.
        const baseVideo = path.join(workDir, 'base.mp4');
        execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', `color=c=0x305070:s=${W}x${H}:d=2:r=25`,
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2',
            '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', baseVideo]);
        for (const mode of ['delogo', 'blur']) {
            const rects = LogoRemoval.exportRects({ ...cfg, mode }, null, W, H);
            const ovlPayload = {
                version: 5,
                sequence: { width: W, height: H, preset: 'custom', source_width: W, source_height: H, source_fps: '25' },
                intervals: [{ index: 0, start: 0.2, end: 1.8, audio_volume: 100 }],
                overlays: [{
                    index: 0, id: `ov_logo_${mode}`, type: 'media', asset_type: 'media_video',
                    asset_path: srcVideo, timeline_start: 0, duration: 1.5, source_start: 0,
                    muted: true, has_audio: false,
                    position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100,
                    logo_mode: mode,
                    logo_rects: rects.map((r) => `${r.x}:${r.y}:${r.w}:${r.h}:${r.p}`).join('|'),
                }],
                settings: {
                    resolution: 'sequence', width: W, height: H, fps: '25', render_fps: '25',
                    codec: 'h264', quality: 'high', audio_bitrate: '128k',
                },
            };
            const ovlPath = path.join(workDir, `ovl_${mode}.json`);
            fs.writeFileSync(ovlPath, JSON.stringify(ovlPayload));
            const ovlOut = path.join(workDir, `ovl_out_${mode}.mp4`);
            const tmpDir = path.join(workDir, `tmp_${mode}`);
            fs.mkdirSync(tmpDir, { recursive: true });
            const res = spawnSync(SIDECAR, ['export-video', baseVideo, ovlOut, ovlPath, tmpDir, 'sequence', '25'],
                { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
            assert.strictEqual(res.status, 0, `sidecar lỗi (overlay ${mode}):\n${res.stdout}\n${res.stderr}`);
            const outRgb = grab(ovlOut);
            const after = regionMeanRgb(outRgb, W, logo);
            console.log(`  end-to-end overlay ${mode.padEnd(6)} logo -> ${after.map((v) => v.toFixed(0))}`);
            assert.ok(Math.min(...after) < 225, `overlay ${mode}: logo trắng vẫn còn ${after}`);
            // Phần ngoài vùng vẫn là overlay (không lộ lane chính 0x305070 bên dưới).
            const far = regionMeanRgb(outRgb, W, { x: 20, y: 150, w: 16, h: 16 });
            const src = regionMeanRgb(srcRgb, W, { x: 20, y: 150, w: 16, h: 16 });
            assert.ok(Math.max(...far.map((v, i) => Math.abs(v - src[i]))) <= 6, `overlay ${mode}: vùng ngoài bị đổi`);
        }
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

function main() {
    console.log('logo_removal');
    testModel();
    testAgainstFfmpeg();
    testDetection();
    testBackendNormalize();
    testSidecarEndToEnd();
    console.log('logo_removal: OK');
}

main();
