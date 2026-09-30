/* =============================================================================
 * XOÁ LOGO BẰNG AI — chế độ 'ai' của tab Retouch > Xoá logo
 *
 * Chốt 5 điều:
 *   1. Mô hình dữ liệu: 'ai' là chế độ hợp lệ; chưa có miếng vá thì công thức pixel dự phòng
 *      là delogo trên CÙNG vùng.
 *   2. Backend (backend/logo-ai.js) với bộ chạy GIẢ: cổng an toàn nguồn/vùng, khoá ổn định,
 *      hàng đợi một job, lượt đã có phủ khoảng xin thì trả ngay, gộp khoảng sát nhau nhưng
 *      KHÔNG gộp khoảng xa nhau, huỷ, đường dẫn miếng vá không lách được, field xuất đọc từ
 *      index trên đĩa.
 *   3. Sidecar Python (CRAB_LOGO_AI_FAKE=1, không cần model) đọc TỪNG khung thật + PTS thật.
 *   4. Sidecar xuất C++ dán miếng vá ĐÚNG KHUNG: nguồn đổi màu mỗi khung, miếng vá giả lấp
 *      bằng màu của chính khung đó -> lệch một khung là vùng logo khác màu nền xung quanh.
 *      Chạy cả nguồn CFR, nguồn VFR, tốc độ 1.5x, và nhánh media overlay.
 *   5. Có model thật (CRAB_LOGO_AI_MODEL_DIR hoặc thư mục models mặc định) thì chạy thêm một
 *      ảnh tĩnh qua LaMa.
 *   6. VẬT THỂ CHUYỂN ĐỘNG: mô hình dữ liệu (mốc, nội suy), backend nhận mốc vật thể (khoá đổi
 *      theo mốc), field xuất gộp công thức + AI, và end-to-end: một hộp trắng CHẠY ngang khung
 *      trên nguồn đổi màu mỗi khung -> bám theo từ MỘT mốc, bản xuất không còn hộp trắng và
 *      miếng vá của từng khung rơi đúng khung (cùng phép đo lệch màu như logo cố định).
 *
 * Chạy: node tests/scripts/logo_ai.js   (phần ffmpeg/python/sidecar tự bỏ qua nếu thiếu)
 * ========================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || path.join(ROOT, 'test_temp', 'logo_ai');
process.env.CRAB_LOGO_AI_CACHE_DIR = process.env.CRAB_LOGO_AI_CACHE_DIR || path.join(ROOT, 'test_temp', 'logo_ai_cache');

const LogoRemoval = require(path.join(ROOT, 'static', 'js', 'logo-removal.js'));
const { createLogoAi, MODEL } = require(path.join(ROOT, 'backend', 'logo-ai.js'));
const { pythonCommand, pythonEnv } = require(path.join(ROOT, 'scripts', 'python_command.js'));
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build',
    process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const PY_SIDECAR = path.join(ROOT, 'asr', 'logo_inpaint_sidecar.py');

function ffmpegAvailable() {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function pythonHas(modules) {
    const r = spawnSync(pythonCommand(), ['-c', `import ${modules.join(',')}`], { env: pythonEnv(), stdio: 'ignore' });
    return r.status === 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ 1. dữ liệu
function testModel() {
    assert.ok(LogoRemoval.MODES.includes('ai'));
    const cfg = LogoRemoval.normalize({ enabled: true, mode: 'ai', strength: 70, regions: [{ x: 0.7, y: 0.05, w: 0.2, h: 0.1 }] });
    assert.strictEqual(cfg.mode, 'ai');
    assert.ok(LogoRemoval.isActive(cfg));
    assert.strictEqual(LogoRemoval.fallbackMode('ai'), 'delogo');
    assert.strictEqual(LogoRemoval.fallbackMode('blur'), 'blur');
    assert.strictEqual(LogoRemoval.fallbackMode('???'), 'delogo');
    const rects = LogoRemoval.exportRects(cfg, null, 320, 240);
    assert.strictEqual(rects.length, 1);
    assert.strictEqual(rects[0].p, 0);
    // applyRectRgba với 'ai' = delogo trên cùng vùng (preview tạm trước khi có miếng vá).
    const W = 40; const H = 30;
    const a = new Uint8ClampedArray(W * H * 4).map((_, i) => (i * 37) % 251);
    const b = Uint8ClampedArray.from(a);
    const r = { x: 10, y: 8, w: 12, h: 10, p: 0 };
    LogoRemoval.applyRectRgba(a, W, r, 'ai');
    LogoRemoval.applyRectRgba(b, W, r, 'delogo');
    assert.deepStrictEqual(a, b);
    console.log('  ✓ mô hình dữ liệu: chế độ ai + dự phòng delogo');

    // Vật thể: mốc sắp theo t, mốc trùng (< KEY_EPS) giữ mốc sau, nội suy / giữ mốc ngoài.
    const oc = LogoRemoval.normalize({ enabled: true, mode: 'delogo', objects: [{ keys: [
        { t: 2, x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
        { t: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { t: 2.01, x: 0.6, y: 0.5, w: 0.2, h: 0.2 },
    ] }] });
    assert.strictEqual(oc.objects[0].keys.length, 2);
    assert.strictEqual(oc.objects[0].keys[1].x, 0.6);
    assert.ok(LogoRemoval.isActive(oc), 'chỉ có vật thể vẫn là đang bật');
    assert.ok(LogoRemoval.needsAi(oc), 'vật thể luôn cần lượt AI');
    assert.ok(!LogoRemoval.needsAi({ enabled: true, mode: 'delogo', regions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }));
    const mid = LogoRemoval.objectBoxAt(oc.objects[0], 1.005);
    assert.ok(Math.abs(mid.x - 0.35) < 1e-3, `nội suy giữa hai mốc: ${mid.x}`);
    assert.strictEqual(LogoRemoval.objectBoxAt(oc.objects[0], -5).x, 0.1);
    assert.strictEqual(LogoRemoval.objectBoxAt(oc.objects[0], 99).x, 0.6);
    const up = LogoRemoval.upsertObjectKey(oc.objects[0], 2.005, { x: 0.7, y: 0.5, w: 0.2, h: 0.2 });
    assert.deepStrictEqual(up.keys.map((k) => k.x), [0.1, 0.7]);
    assert.ok(!LogoRemoval.isEmpty({ enabled: false, objects: oc.objects }), 'tắt mà còn vật thể thì giữ');
    console.log('  ✓ mô hình dữ liệu: vật thể chuyển động (mốc, nội suy, ghi đè mốc)');
}

// ------------------------------------------------------------------ 2. backend
async function testBackendQueue() {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-logo-ai-q-'));
    const allowedDir = path.join(work, 'allowed');
    fs.mkdirSync(allowedDir);
    const src = path.join(allowedDir, 'clip.mp4');
    fs.writeFileSync(src, 'fake video');
    const outside = path.join(work, 'secret.mp4');
    fs.writeFileSync(outside, 'x');
    const calls = [];
    let release = null;
    const fakeRunner = async (script, inputPath, outputPath, opts) => {
        const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
        calls.push(input);
        opts.onProgress?.(0.5);
        if (input.start >= 100) {
            // Lượt "chậm" để thử huỷ: chờ tới khi bị kill.
            await new Promise((resolve, reject) => {
                release = reject;
                opts.onChild?.({ kill: () => reject(new Error('killed')) });
            });
        }
        const times = [];
        for (let t = input.start; t < input.end; t += 0.04) times.push(Number(t.toFixed(6)));
        fs.mkdirSync(input.out_dir, { recursive: true });
        const rects = input.rects.map((r, k) => {
            fs.writeFileSync(path.join(input.out_dir, `r${k}.ffconcat`), 'ffconcat version 1.0\n');
            fs.writeFileSync(path.join(input.out_dir, `r${k}_000000.png`), 'png');
            return { ...r, box: { x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 }, frames: times.map(() => 0) };
        });
        const index = { version: 1, still: input.still, width: input.frame_w, height: input.frame_h,
            start: input.start, end: input.end, times, rects };
        fs.writeFileSync(path.join(input.out_dir, 'index.json'), JSON.stringify(index));
        return { status: 'success', index };
    };
    const ai = createLogoAi({
        cacheDir: path.join(work, 'cache'),
        modelDir: path.join(work, 'models'),
        scriptPath: 'fake.py',
        runSidecar: fakeRunner,
        resolveSource: (raw) => {
            const p = path.resolve(String(raw || ''));
            return p.startsWith(allowedDir + path.sep) && fs.existsSync(p) ? p : null;
        },
        tempJsonPath: (prefix) => path.join(work, `${prefix}_${Math.random().toString(16).slice(2)}.json`),
    });
    const base = { source_path: src, frame_w: 320, frame_h: 240, rects: [{ x: 250, y: 10, w: 50, h: 30 }] };
    const waitDone = async (view) => {
        for (let i = 0; i < 200 && view && (view.state === 'queued' || view.state === 'running'); i++) {
            await sleep(10);
            view = ai.jobStatus(view.job_id);
        }
        return view;
    };
    try {
        // Cổng an toàn.
        assert.throws(() => ai.request({ ...base, source_path: outside, start: 0, end: 1 }), /không hợp lệ/);
        assert.throws(() => ai.request({ ...base, rects: [{ x: 0, y: 0, w: 2, h: 40 }], start: 0, end: 1 }), /vùng logo/);
        assert.throws(() => ai.request({ ...base, start: 2, end: 1 }), /Khoảng thời gian/);
        // Vùng tràn khung bị kẹp, không bị tin nguyên.
        const n = ai.normalizeRequest({ ...base, rects: [{ x: 300, y: 230, w: 999, h: 999 }], start: 0, end: 1 });
        assert.deepStrictEqual(n.rects, [{ x: 300, y: 230, w: 20, h: 10 }]);

        // Chưa có gì -> none; không tự chạy.
        const none = ai.request({ ...base, start: 1, end: 3 });
        assert.strictEqual(none.state, 'none');
        assert.strictEqual(calls.length, 0);

        // Xin chạy -> done; lần sau (khoảng con) trả ngay, không gọi sidecar thêm.
        let v = await waitDone(ai.request({ ...base, start: 1, end: 3 }, { run: true }));
        assert.strictEqual(v.state, 'done', JSON.stringify(v));
        assert.strictEqual(calls.length, 1);
        const sub = ai.request({ ...base, start: 1.5, end: 2.5 });
        assert.strictEqual(sub.state, 'done');
        assert.strictEqual(sub.run, v.run);

        // Kéo dài SÁT khoảng cũ -> gộp thành một lượt [1, 4], lượt cũ bị dọn.
        const firstRun = v.run;
        v = await waitDone(ai.request({ ...base, start: 2.5, end: 4 }, { run: true }));
        assert.strictEqual(v.state, 'done');
        assert.strictEqual(calls[1].start, 1);
        assert.strictEqual(calls[1].end, 4);
        assert.ok(!fs.existsSync(path.join(work, 'cache', v.key, firstRun)), 'lượt cũ bị phủ trọn phải được dọn');

        // Khoảng XA -> lượt riêng, không xử lý cả quãng giữa.
        v = await waitDone(ai.request({ ...base, start: 40, end: 41 }, { run: true }));
        assert.strictEqual(v.state, 'done');
        assert.strictEqual(calls[2].start, 40);
        assert.strictEqual(ai.request({ ...base, start: 1, end: 4 }).state, 'done', 'lượt [1,4] vẫn còn');

        // Vùng khác -> khoá khác.
        const k2 = ai.request({ ...base, rects: [{ x: 10, y: 10, w: 50, h: 30 }], start: 1, end: 3 });
        assert.strictEqual(k2.state, 'none');
        assert.notStrictEqual(k2.key, v.key);

        // Vật thể: chỉ có vật thể (không vùng) là hợp lệ; mốc được kẹp/sắp; mốc khác -> khoá khác.
        const objBody = { ...base, rects: [], objects: [{ keys: [{ t: 2, x: 10, y: 10, w: 40, h: 40 }, { t: 1, x: 300, y: 0, w: 999, h: 40 }] }] };
        const on = ai.normalizeRequest({ ...objBody, start: 1, end: 3 });
        assert.deepStrictEqual(on.objects[0].keys.map((k) => [k.t, k.x, k.w]), [[1, 300, 20], [2, 10, 40]]);
        const ko1 = ai.request({ ...objBody, start: 1, end: 3 });
        const ko2 = ai.request({ ...objBody, objects: [{ keys: [{ t: 2, x: 12, y: 10, w: 40, h: 40 }] }], start: 1, end: 3 });
        assert.strictEqual(ko1.state, 'none');
        assert.notStrictEqual(ko1.key, ko2.key);
        assert.notStrictEqual(ko1.key, k2.key);
        // Ảnh tĩnh: vật thể bị bỏ -> không còn gì để làm.
        assert.throws(() => ai.request({ ...objBody, still: true }), /vật thể hợp lệ/);

        // Huỷ lượt đang chạy.
        const slow = ai.request({ ...base, start: 100, end: 101 }, { run: true });
        for (let i = 0; i < 100 && ai.jobStatus(slow.job_id).state !== 'running'; i++) await sleep(5);
        await sleep(20);
        ai.cancel(slow.job_id);
        const canceled = await waitDone(ai.jobStatus(slow.job_id));
        assert.strictEqual(canceled.state, 'canceled');
        assert.strictEqual(ai.request({ ...base, start: 100, end: 101 }).state, 'none');
        void release;

        // Đường dẫn miếng vá: chỉ đúng khuôn.
        const done = ai.request({ ...base, start: 1, end: 4 });
        assert.ok(ai.patchPath(done.key, done.run, 'r0_000000.png'));
        assert.strictEqual(ai.patchPath(done.key, done.run, '../index.json'), null);
        assert.strictEqual(ai.patchPath('..', done.run, 'r0_000000.png'), null);
        assert.strictEqual(ai.patchPath(done.key, '..', 'r0_000000.png'), null);
        assert.strictEqual(ai.patchPath(done.key, done.run, 'r9_000000.png'), null);

        // Field xuất: dựng từ index trên đĩa.
        const f = ai.exportFields({ mode: 'ai', key: done.key, run: done.run });
        assert.strictEqual(f.logo_ai_dir, path.join(work, 'cache', done.key, done.run));
        assert.strictEqual(f.logo_ai_rects, '246:6');
        assert.strictEqual(f.logo_ai_t0, 1);
        assert.strictEqual(ai.exportFields({ mode: 'ai', key: done.key, run: 'run_nonexist00' }), null);
        assert.strictEqual(ai.exportFields({ mode: 'ai', key: 'x/../../', run: done.run }), null);
    } finally {
        ai.cancelAll();
        fs.rmSync(work, { recursive: true, force: true });
    }

    // server.js: 'ai' không dùng được -> delogo trên các hình chữ nhật gửi kèm.
    const { normalizeLogoRemovalFields, logoAi } = require(path.join(ROOT, 'backend', 'server.js'));
    assert.deepStrictEqual(
        normalizeLogoRemovalFields({ mode: 'ai', key: 'abc', run: 'nope', rects: [{ x: 10, y: 20, w: 40, h: 30, p: 0 }] }),
        { logo_mode: 'delogo', logo_rects: '10:20:40:30:0' });
    // Chế độ công thức + lượt AI của vật thể -> CẢ HAI bộ field (công thức trước, vá sau).
    const realExport = logoAi.exportFields;
    logoAi.exportFields = (raw) => (raw.key === 'k' && raw.run === 'r'
        ? { logo_ai_dir: '/x', logo_ai_rects: '1:2', logo_ai_t0: 0 } : null);
    try {
        assert.deepStrictEqual(
            normalizeLogoRemovalFields({ mode: 'blur', key: 'k', run: 'r', objects: 1, rects: [{ x: 10, y: 20, w: 40, h: 30, p: 3 }] }),
            { logo_mode: 'blur', logo_rects: '10:20:40:30:3', logo_ai_dir: '/x', logo_ai_rects: '1:2', logo_ai_t0: 0 });
        assert.deepStrictEqual(normalizeLogoRemovalFields({ mode: 'delogo', key: 'k', run: 'r', objects: 1, rects: [] }),
            { logo_ai_dir: '/x', logo_ai_rects: '1:2', logo_ai_t0: 0 });
        assert.deepStrictEqual(normalizeLogoRemovalFields({ mode: 'ai', key: 'k', run: 'r', rects: [{ x: 10, y: 20, w: 40, h: 30, p: 0 }] }),
            { logo_ai_dir: '/x', logo_ai_rects: '1:2', logo_ai_t0: 0 });
    } finally {
        logoAi.exportFields = realExport;
    }
    console.log('  ✓ backend: cổng an toàn, cache phủ khoảng, gộp sát / tách xa, huỷ, field xuất');
}

// ------------------------------------------------------------------ 3+4. end-to-end
function runPySidecar(input, work, fake = true) {
    const inPath = path.join(work, `in_${Math.random().toString(16).slice(2)}.json`);
    const outPath = `${inPath}.out.json`;
    fs.writeFileSync(inPath, JSON.stringify(input));
    const r = spawnSync(pythonCommand(), [PY_SIDECAR, inPath, outPath], {
        env: pythonEnv(fake ? { CRAB_LOGO_AI_FAKE: '1' } : {}),
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: ROOT,
    });
    const out = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null;
    assert.ok(out && out.status === 'success', `python sidecar lỗi:\n${r.stdout}\n${r.stderr}\n${JSON.stringify(out)}`);
    return out.index;
}

function rawFrames(file, W, H, extra = []) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, ...extra, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    assert.strictEqual(r.status, 0, r.stderr?.toString('utf8'));
    const n = W * H * 3;
    const frames = [];
    for (let o = 0; o + n <= r.stdout.length; o += n) frames.push(r.stdout.subarray(o, o + n));
    return frames;
}

function meanRgb(buf, W, box) {
    const acc = [0, 0, 0];
    for (let y = box.y; y < box.y + box.h; y++) {
        for (let x = box.x; x < box.x + box.w; x++) {
            for (let c = 0; c < 3; c++) acc[c] += buf[(y * W + x) * 3 + c];
        }
    }
    return acc.map((v) => v / (box.w * box.h));
}

/* Mỗi khung ra: màu vùng logo (từ miếng vá) phải trùng màu nền QUANH vùng (từ luồng chính) —
 * cả hai chỉ trùng khi miếng vá là của CHÍNH khung đó. Trả độ lệch lớn nhất qua các khung. */
function frameAlignmentError(frames, W, logo) {
    const inner = { x: logo.x + 6, y: logo.y + 4, w: logo.w - 12, h: logo.h - 8 };
    const ring = { x: logo.x - 24, y: logo.y + logo.h + 20, w: 16, h: 16 };
    let worst = 0;
    let white = 0;
    frames.forEach((f) => {
        const a = meanRgb(f, W, inner);
        const b = meanRgb(f, W, ring);
        worst = Math.max(worst, ...a.map((v, i) => Math.abs(v - b[i])));
        if (Math.min(...a) > 230) white++;
    });
    return { worst, white };
}

function makeColorSource(file, W, H, logo, { vfr = false, seconds = 2 } = {}) {
    // Màu PHẲNG đổi mỗi khung (bước lớn giữa hai khung liền nhau) + "logo" trắng cố định.
    const geq = "geq=r='20+mod(N*37\\,200)':g='20+mod(N*91+60\\,200)':b='20+mod(N*53+120\\,200)'";
    const vf = [`format=rgb24`, geq, `drawbox=x=${logo.x}:y=${logo.y}:w=${logo.w}:h=${logo.h}:color=white:t=fill`];
    // VFR: chèn hai cú nhảy PTS lệch lưới 25fps — nguồn quay điện thoại hay có kiểu này.
    if (vfr) vf.push("setpts='N/25/TB+if(gte(N\\,20)\\,0.017\\,0)+if(gte(N\\,33)\\,0.011\\,0)'");
    vf.push('format=yuv420p');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=25:d=${seconds}`,
        '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${seconds}`,
        '-vf', vf.join(','), '-shortest',
        ...(vfr ? ['-fps_mode', 'vfr', '-video_track_timescale', '90000'] : []),
        '-c:v', 'libx264', '-crf', '12', '-c:a', 'aac', file]);
}

function testEndToEnd() {
    if (!ffmpegAvailable() || !fs.existsSync(SIDECAR)) {
        console.log('  (bỏ qua end-to-end: thiếu ffmpeg hoặc chưa build sidecar)');
        return;
    }
    if (!pythonHas(['numpy', 'cv2'])) {
        console.log('  (bỏ qua end-to-end: python thiếu numpy/cv2)');
        return;
    }
    const W = 320; const H = 240;
    const logo = { x: 250, y: 14, w: 50, h: 26 };
    const rect = { x: logo.x - 4, y: logo.y - 4, w: logo.w + 8, h: logo.h + 8 };
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-logo-ai-e2e-'));
    try {
        for (const vfr of [false, true]) {
            const src = path.join(work, vfr ? 'src_vfr.mp4' : 'src.mp4');
            makeColorSource(src, W, H, logo, { vfr });
            const index = runPySidecar({
                source_path: src, still: false, start: 0.1, end: 1.9, frame_w: W, frame_h: H,
                rects: [rect], out_dir: path.join(work, vfr ? 'run_vfr' : 'run_cfr'),
            }, work);
            // Đọc đủ từng khung thật trong [0.1, 1.9) và giữ PTS thật.
            const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
                'frame=pts_time', '-of', 'csv=p=0', src], { encoding: 'utf8' })
                .split(/\r?\n/).map((l) => Number(String(l).replace(/,$/, ''))).filter(Number.isFinite);
            const want = probe.filter((t) => t >= 0.1 - 1e-6 && t < 1.9 - 1e-6);
            assert.strictEqual(index.times.length, want.length, `${vfr ? 'VFR' : 'CFR'}: số khung ${index.times.length} ≠ ${want.length}`);
            index.times.forEach((t, i) => assert.ok(Math.abs(t - want[i]) < 1e-3, `PTS khung ${i}: ${t} ≠ ${want[i]}`));
            assert.strictEqual(index.rects[0].frames.length, index.times.length);
            const fields = {
                logo_ai_dir: path.join(work, vfr ? 'run_vfr' : 'run_cfr'),
                logo_ai_rects: `${index.rects[0].box.x}:${index.rects[0].box.y}`,
                logo_ai_t0: index.times[0],
            };

            // LANE CHÍNH, tốc độ 1x và 1.5x. `shift` = ĐỐI CHỨNG ÂM: cố tình dời miếng vá đi
            // một khung — phép đo phải bắt được, không thì các lần "khớp" ở trên chẳng chứng
            // minh gì.
            for (const [speed, shift] of [[1, 0], [1.5, 0], [1, 1]]) {
                const payload = {
                    resolution: 'source', width: W, height: H,
                    fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '128k',
                    intervals: [{
                        index: 0, start: 0.3, end: 1.7, position_x: 0, position_y: 0,
                        scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
                        ...(speed !== 1 ? { speed_rate: speed } : {}),
                        ...fields,
                        logo_ai_t0: fields.logo_ai_t0 + shift * 0.04,
                    }],
                };
                const tag = `${vfr ? 'vfr' : 'cfr'}_${speed}${shift ? '_lech1' : ''}`;
                const payloadPath = path.join(work, `timeline_${tag}.json`);
                fs.writeFileSync(payloadPath, JSON.stringify(payload));
                const outPath = path.join(work, `out_${tag}.mp4`);
                const res = spawnSync(SIDECAR, ['export-video', src, outPath, payloadPath, work, 'high', '25'],
                    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
                assert.strictEqual(res.status, 0, `sidecar lỗi (${tag}):\n${res.stdout}\n${res.stderr}`);
                const frames = rawFrames(outPath, W, H);
                const expectFrames = Math.round((1.4 / speed) * 25);
                assert.ok(Math.abs(frames.length - expectFrames) <= 1, `${tag}: ${frames.length} khung, cần ~${expectFrames}`);
                // Khung cuối của đối chứng âm không có miếng vá (eof_action=pass) -> bỏ ra.
                const { worst, white } = frameAlignmentError(shift ? frames.slice(0, -2) : frames, W, logo);
                console.log(`  end-to-end lane chính ${tag.padEnd(11)} ${frames.length} khung, lệch màu vá/nền tối đa ${worst.toFixed(1)}`);
                if (shift) {
                    assert.ok(worst > 30, `${tag}: dời miếng vá 1 khung mà phép đo không thấy (${worst.toFixed(1)})`);
                    continue;
                }
                assert.strictEqual(white, 0, `${tag}: logo trắng còn ở ${white} khung`);
                assert.ok(worst <= 12, `${tag}: miếng vá lệch khung (lệch màu ${worst.toFixed(1)})`);
            }

            // MEDIA OVERLAY video phủ kín khung.
            const base = path.join(work, 'base.mp4');
            if (!fs.existsSync(base)) {
                execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
                    '-f', 'lavfi', '-i', `color=c=0x305070:s=${W}x${H}:d=2:r=25`,
                    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2',
                    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base]);
            }
            const ovl = {
                version: 5,
                sequence: { width: W, height: H, preset: 'custom', source_width: W, source_height: H, source_fps: '25' },
                intervals: [{ index: 0, start: 0.1, end: 1.9, audio_volume: 100 }],
                overlays: [{
                    index: 0, id: 'ov_ai', type: 'media', asset_type: 'media_video',
                    asset_path: src, timeline_start: 0.2, duration: 1.2, source_start: 0.4,
                    muted: true, has_audio: false,
                    position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100,
                    ...fields,
                }],
                settings: {
                    resolution: 'sequence', width: W, height: H, fps: '25', render_fps: '25',
                    codec: 'h264', quality: 'high', audio_bitrate: '128k',
                },
            };
            const ovlPath = path.join(work, `ovl_${vfr}.json`);
            fs.writeFileSync(ovlPath, JSON.stringify(ovl));
            const ovlOut = path.join(work, `ovl_out_${vfr}.mp4`);
            const tmpDir = path.join(work, `tmp_${vfr}`);
            fs.mkdirSync(tmpDir, { recursive: true });
            const res = spawnSync(SIDECAR, ['export-video', base, ovlOut, ovlPath, tmpDir, 'sequence', '25'],
                { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
            assert.strictEqual(res.status, 0, `sidecar lỗi (overlay):\n${res.stdout}\n${res.stderr}`);
            // Chỉ xét các khung overlay đang hiện (0.2s .. 1.4s trên timeline), bỏ khung mép.
            const all = rawFrames(ovlOut, W, H);
            const shown = all.slice(Math.ceil(0.2 * 25) + 1, Math.floor(1.4 * 25) - 1);
            const { worst, white } = frameAlignmentError(shown, W, logo);
            console.log(`  end-to-end overlay ${vfr ? 'vfr' : 'cfr'}      ${shown.length} khung, lệch màu vá/nền tối đa ${worst.toFixed(1)}`);
            assert.strictEqual(white, 0, `overlay: logo trắng còn ở ${white} khung`);
            assert.ok(worst <= 12, `overlay: miếng vá lệch khung (lệch màu ${worst.toFixed(1)})`);
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

function defaultModelDir() {
    if (process.env.CRAB_LOGO_AI_MODEL_DIR) return process.env.CRAB_LOGO_AI_MODEL_DIR;
    return path.join(require(path.join(ROOT, 'scripts', 'runtime_paths.js')).appDataRoot(), 'models', 'logo_ai');
}

function testRealModel() {
    const modelPath = path.join(defaultModelDir(), MODEL.file);
    if (!fs.existsSync(modelPath) || !ffmpegAvailable() || !pythonHas(['numpy', 'cv2', 'onnxruntime'])) {
        console.log('  (bỏ qua LaMa thật: chưa có model/onnxruntime)');
        return;
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-logo-ai-real-'));
    try {
        const W = 320; const H = 240;
        const logo = { x: 250, y: 14, w: 50, h: 26 };
        const img = path.join(work, 'still.png');
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
            `smptebars=s=${W}x${H},drawbox=x=${logo.x}:y=${logo.y}:w=${logo.w}:h=${logo.h}:color=white:t=fill`,
            '-frames:v', '1', img]);
        const index = runPySidecar({
            source_path: img, still: true, frame_w: W, frame_h: H,
            rects: [{ x: logo.x - 4, y: logo.y - 4, w: logo.w + 8, h: logo.h + 8 }],
            out_dir: path.join(work, 'run'), model_path: modelPath, model_url: '', model_sha256: '',
        }, work, false);
        assert.strictEqual(index.still, true);
        const patch = rawFrames(path.join(work, 'run', 'r0_000000.png'), index.rects[0].box.w, index.rects[0].box.h)[0];
        const f = 4 + (index.rects[0].box.w - logo.w - 8) / 2;
        const inner = meanRgb(patch, index.rects[0].box.w, { x: Math.round(f) + 6, y: Math.round(f) + 4, w: logo.w - 12, h: logo.h - 8 });
        console.log(`  LaMa thật (${index.provider}): vùng logo trắng -> ${inner.map((v) => v.toFixed(0))}`);
        assert.ok(Math.min(...inner) < 225, 'LaMa: logo trắng vẫn còn');
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

/* VẬT THỂ CHUYỂN ĐỘNG end-to-end: hộp trắng CHẠY ngang trên nền đổi màu mỗi khung. Chỉ một
 * mốc ở đầu đoạn -> lượt AI phải tự bám theo hộp; bản xuất (lane chính) không được còn khung
 * nào có hộp trắng, và bên trong vị trí THẬT của hộp ở mỗi khung phải trùng màu nền quanh nó
 * (miếng vá của vật thể cỡ cả quãng đi, alpha theo từng khung — lệch khung là lộ). Kèm một
 * vùng logo CỐ ĐỊNH xoá bằng delogo cùng lúc (field công thức + field AI trên cùng block). */
function testMovingObject() {
    if (!ffmpegAvailable() || !fs.existsSync(SIDECAR) || !pythonHas(['numpy', 'cv2'])) {
        console.log('  (bỏ qua vật thể end-to-end: thiếu ffmpeg/sidecar/numpy/cv2)');
        return;
    }
    const W = 320; const H = 240;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-logo-ai-obj-'));
    try {
        const src = path.join(work, 'obj.mp4');
        // Hộp 36×36 chạy 3 px/khung; nền đổi màu PHẲNG mỗi khung + vân dọc nhẹ cho bộ bám có
        // chỗ bám; một "logo" trắng CỐ ĐỊNH ở góc trên phải cho vùng delogo.
        const geq = "geq=r='20+mod(N*37\\,120)+mod(X\\,16)':g='20+mod(N*91+60\\,120)':b='20+mod(N*53+120\\,120)'";
        execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=25:d=2`,
            '-f', 'lavfi', '-i', 'color=c=white:s=36x36:r=25:d=2',
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2',
            '-filter_complex', [`[0:v]format=rgb24,${geq},drawbox=x=270:y=10:w=36:h=20:color=white:t=fill[bg]`,
                "[bg][1:v]overlay=x='30+3*n':y=120,format=yuv420p[v]"].join(';'),
            '-map', '[v]', '-map', '2:a', '-shortest',
            '-c:v', 'libx264', '-crf', '12', '-c:a', 'aac', src]);
        const index = runPySidecar({
            source_path: src, still: false, start: 0, end: 2, frame_w: W, frame_h: H, rects: [],
            objects: [{ keys: [{ t: 0.0, x: 28, y: 118, w: 40, h: 40 }] }],
            out_dir: path.join(work, 'run'),
        }, work);
        const obj = index.rects.find((r) => r.kind === 'object');
        assert.ok(obj && Array.isArray(obj.track) && obj.track.length === index.times.length, 'index phải có hộp bám từng khung');
        // Bám đúng: tâm hộp bám theo tâm thật (30+3n+18) trong vài px.
        let worstTrack = 0;
        obj.core.forEach((c, i) => {
            const n = Math.round(index.times[i] * 25);
            worstTrack = Math.max(worstTrack, Math.abs(c[0] + c[2] / 2 - (30 + 3 * n + 18)));
        });
        assert.ok(worstTrack < 8, `bộ bám lệch ${worstTrack.toFixed(1)} px`);
        const payload = {
            resolution: 'source', width: W, height: H,
            fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '128k',
            intervals: [{
                index: 0, start: 0.2, end: 1.8, position_x: 0, position_y: 0,
                scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
                logo_mode: 'delogo', logo_rects: '266:6:44:28:0',
                logo_ai_dir: path.join(work, 'run'), logo_ai_rects: `${obj.box.x}:${obj.box.y}`, logo_ai_t0: index.times[0],
            }],
        };
        const payloadPath = path.join(work, 'timeline.json');
        fs.writeFileSync(payloadPath, JSON.stringify(payload));
        const outPath = path.join(work, 'out.mp4');
        const res = spawnSync(SIDECAR, ['export-video', src, outPath, payloadPath, work, 'high', '25'],
            { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
        assert.strictEqual(res.status, 0, `sidecar lỗi (vật thể):
${res.stdout}
${res.stderr}`);
        const frames = rawFrames(outPath, W, H);
        let worst = 0;
        let white = 0;
        let logoWhite = 0;
        frames.slice(0, -1).forEach((f, i) => {
            const n = i + 5;  // khung ra i = khung nguồn 0.2 s + i
            const inner = { x: 30 + 3 * n + 6, y: 126, w: 24, h: 24 };
            const ring = { x: 30 + 3 * n + 6, y: 170, w: 24, h: 12 };
            const a = meanRgb(f, W, inner);
            const b = meanRgb(f, W, ring);
            worst = Math.max(worst, ...a.map((v, c) => Math.abs(v - b[c])));
            if (Math.min(...a) > 225) white++;
            if (Math.min(...meanRgb(f, W, { x: 276, y: 14, w: 24, h: 12 })) > 225) logoWhite++;
        });
        console.log(`  end-to-end vật thể chạy     ${frames.length} khung, bám lệch ≤ ${worstTrack.toFixed(1)} px, lệch màu vá/nền tối đa ${worst.toFixed(1)}`);
        assert.strictEqual(white, 0, `vật thể trắng còn ở ${white} khung`);
        assert.strictEqual(logoWhite, 0, `logo cố định (delogo) còn ở ${logoWhite} khung`);
        assert.ok(worst <= 20, `miếng vá vật thể lệch khung / lệch màu (${worst.toFixed(1)})`);
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

async function main() {
    console.log('logo_ai');
    testModel();
    await testBackendQueue();
    testEndToEnd();
    testMovingObject();
    testRealModel();
    console.log('logo_ai: OK');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
