/* =============================================================================
 * WIGGLE (kiểu After Effects) — ĐỐI CHIẾU ENGINE PREVIEW ↔ BIỂU THỨC XUẤT ↔ SIDECAR
 *
 * Wiggle rung LIÊN TỤC suốt block. Preview + chuỗi khung bake (ảnh/chữ/shape) chạy
 * animationStateAt(); block VIDEO xuất bằng biểu thức FFmpeg (videoAnimationExpr cho
 * dịch/thu phóng/xoay, wiggleOpacityFfmpegExpr cho độ mờ). Test chốt:
 *   1. block KHÔNG có wiggle ra kết quả Y HỆT bản engine trước khi có Wiggle (git HEAD);
 *   2. biểu thức FFmpeg trùng engine từng mốc, kể cả khi chồng lên In/Out;
 *   3. biên độ, seed, trục, tắt/bật đúng nghĩa;
 *   4. backend chuyển tiếp nguyên biểu thức; sidecar render thật đúng vị trí + độ mờ.
 *
 * Chạy: node tests/scripts/wiggle.js   (ca sidecar cần ffmpeg + sidecar đã build)
 * ========================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8128';
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || path.join(ROOT, 'test_temp', 'wiggle');
fs.mkdirSync(process.env.CRAB_TEMP_DIR, { recursive: true });
const TA = require(path.join(ROOT, 'static', 'js', 'text-animations.js'));
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build',
    process.platform === 'win32' ? 'core_process.exe' : 'core_process');

const FF_FUNCS = {
    IF: (c, a, b) => (c ? a : b),
    lt: (a, b) => (a < b ? 1 : 0),
    gt: (a, b) => (a > b ? 1 : 0),
    clip: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
    pow: Math.pow, exp: Math.exp, cos: Math.cos, sin: Math.sin, max: Math.max, min: Math.min,
};
function ffEval(expr, localTime) {
    const js = String(expr).replace(/\bif\(/g, 'IF(');
    const names = Object.keys(FF_FUNCS);
    // eslint-disable-next-line no-new-func
    const fn = new Function('LOCALT', ...names, `return (${js});`);
    const v = fn(localTime, ...names.map((n) => FF_FUNCS[n]));
    assert.ok(Number.isFinite(v), `biểu thức không hữu hạn: ${expr}`);
    return v;
}

function test(name, fn) {
    try { fn(); console.log(`✓ ${name}`); } catch (e) { console.error(`✗ ${name}`); throw e; }
}

const FULL = {
    position: { enabled: true, freq: 2.5, amp: 60, octaves: 2, amp_mult: 0.6, seed: 7 },
    scale: { enabled: true, freq: 1.5, amp: 20, uniform: false, seed: 3 },
    rotation: { enabled: true, freq: 3, amp: 25, octaves: 3 },
    opacity: { enabled: true, freq: 4, amp: 70 },
};

test('block KHÔNG có wiggle: engine ra y hệt bản trước khi có Wiggle (git HEAD)', () => {
    const src = execFileSync('git', ['show', 'HEAD:static/js/text-animations.js'], { cwd: ROOT, encoding: 'utf8' });
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wgl-old-')), 'ta.js');
    fs.writeFileSync(tmp, src);
    const OLD = require(tmp);
    const effects = Object.keys(TA.EFFECT_SPECS).concat(['typewriter']);
    let n = 0;
    effects.forEach((effect) => {
        TA.EASING_OPTIONS.forEach(({ value: easing }) => {
            const item = { duration: 2.5, animation: { in: { type: effect, duration: 0.7, easing }, out: { type: effect, duration: 0.6, easing } } };
            assert.deepStrictEqual(TA.normalizeAnimation(item.animation), OLD.normalizeAnimation(item.animation));
            assert.deepStrictEqual(TA.videoAnimationExpr(item, 300), OLD.videoAnimationExpr(item, 300));
            for (let i = 0; i <= 40; i += 1) {
                const t = (2.5 * i) / 40;
                assert.deepStrictEqual(TA.animationStateAt(item, t, { boxHeight: 300, charCount: 5 }),
                    OLD.animationStateAt(item, t, { boxHeight: 300, charCount: 5 }), `${effect}/${easing}@${t}`);
                n += 1;
            }
        });
    });
    assert.strictEqual(TA.normalizeAnimation({ in: { type: 'none' }, out: { type: 'none' } }), null);
    assert.strictEqual(TA.hasAnimation({ duration: 2, animation: null }), false);
    // Wiggle có mà TẮT hết = như không có hoạt ảnh
    assert.strictEqual(TA.hasAnimation({ duration: 2, animation: { wiggle: { position: { enabled: false, amp: 50 } } } }), false);
    assert.strictEqual(TA.hasAnimation({ duration: 2, animation: { wiggle: { position: { enabled: true, amp: 0 } } } }), false);
    console.log(`  ${n} mốc so khớp`);
});

test('chỉ có wiggle: có hoạt ảnh, không ẩn, biên độ đỉnh ≈ Biên độ (không vượt)', () => {
    const item = { duration: 30, animation: { wiggle: { position: { enabled: true, amp: 40 }, rotation: { enabled: true, amp: 12 } } } };
    assert.ok(TA.hasAnimation(item));
    let mx = 0; let my = 0; let mr = 0;
    for (let t = 0; t <= 30; t += 0.01) {
        const s = TA.animationStateAt(item, t, { boxHeight: 100 });
        assert.ok(!s.hidden && s.opacityMul === 1 && s.scaleX === 1);
        mx = Math.max(mx, Math.abs(s.dx)); my = Math.max(my, Math.abs(s.dy)); mr = Math.max(mr, Math.abs(s.rotate));
    }
    assert.ok(mx <= 40 + 1e-9 && mx > 30, `|dx| tối đa ${mx}`);
    assert.ok(my <= 40 + 1e-9 && my > 30, `|dy| tối đa ${my}`);
    assert.ok(mr <= 12 + 1e-9 && mr > 9, `|rot| tối đa ${mr}`);
});

test('seed tất định; seed / loại khác nhau rung khác nhau; trục X/Y; đều hai trục', () => {
    const at = (wiggle, t) => TA.wiggleStateAt(TA.normalizeWiggle(wiggle), t);
    const a = at({ position: { enabled: true, seed: 5 } }, 1.3);
    assert.deepStrictEqual(a, at({ position: { enabled: true, seed: 5 } }, 1.3));
    assert.notStrictEqual(a.dx, at({ position: { enabled: true, seed: 6 } }, 1.3).dx);
    assert.notStrictEqual(a.dx, a.dy, 'X và Y không được rung cùng nhịp');
    assert.strictEqual(at({ position: { enabled: true, axis: 'x' } }, 0.7).dy, 0);
    assert.strictEqual(at({ position: { enabled: true, axis: 'y' } }, 0.7).dx, 0);
    const u = at({ scale: { enabled: true, amp: 30 } }, 0.9);
    assert.strictEqual(u.sx, u.sy);
    const nu = at({ scale: { enabled: true, amp: 30, uniform: false } }, 0.9);
    assert.notStrictEqual(nu.sx, nu.sy);
    // Độ mờ chỉ làm MỜ ĐI, nằm trong [1 - amp, 1]
    for (let t = 0; t < 10; t += 0.05) {
        const o = at({ opacity: { enabled: true, amp: 60 } }, t).op;
        assert.ok(o >= 0.4 - 1e-9 && o <= 1 + 1e-9, `op ${o}`);
    }
    // Kẹp tham số
    const fx = TA.normalizeWiggleFx('rotation', { freq: 999, amp: -5, octaves: 9, amp_mult: 3, seed: -2 });
    assert.deepStrictEqual([fx.freq, fx.amp, fx.octaves, fx.amp_mult, fx.seed],
        [TA.WIGGLE_FREQ_MAX, 0, TA.WIGGLE_OCTAVES_MAX, 1, 0]);
});

test('biểu thức FFmpeg (video) trùng engine từng mốc — riêng wiggle và chồng lên In/Out', () => {
    const cases = [
        { duration: 4, animation: { wiggle: FULL } },
        { duration: 4, animation: { in: { type: 'spin', duration: 0.8, easing: 'back' }, out: { type: 'slide_up', duration: 0.6, easing: 'ease-in' }, wiggle: FULL } },
        { duration: 4, animation: { in: { type: 'flip', duration: 0.5, easing: 'linear' }, out: { type: 'none' }, wiggle: { position: { enabled: true, axis: 'y', amp: 33 } } } },
    ];
    let n = 0;
    cases.forEach((item, ci) => {
        const spec = TA.videoAnimationExpr(item, 400);
        const ch = { dx: spec.x_expr, dy: spec.y_expr, scaleX: spec.scale_x_expr || '1', scaleY: spec.scale_y_expr || '1', rotate: spec.rot_expr || '0' };
        for (let i = 0; i <= 200; i += 1) {
            const t = (4 * i) / 200;
            const st = TA.animationStateAt(item, t, { boxHeight: 400 });
            Object.entries(ch).forEach(([k, expr]) => {
                const want = k.startsWith('scale') ? Math.max(0.001, st[k]) : st[k];
                const got = ffEval(expr, t);
                const tol = k.startsWith('scale') ? 2e-4 : 0.02;
                assert.ok(Math.abs(got - want) < tol, `ca ${ci} @${t.toFixed(2)} ${k}: ${got} ≠ ${want}`);
                n += 1;
            });
        }
    });
    // Độ mờ video = cơ sở × hệ số wiggle (đơn vị %)
    const anim = { wiggle: { opacity: { enabled: true, amp: 70, freq: 4 } } };
    const opStatic = TA.wiggleOpacityFfmpegExpr(anim, null, 80);
    const kfExpr = TA.keyframeFieldFfmpegExpr([{ t: 0, v: 100 }, { t: 2, v: 40, e: 'linear' }]);
    const opKf = TA.wiggleOpacityFfmpegExpr(anim, kfExpr, 100);
    for (let i = 0; i <= 100; i += 1) {
        const t = (3 * i) / 100;
        const mul = TA.animationStateAt({ duration: 3, animation: anim }, t, {}).opacityMul;
        assert.ok(Math.abs(ffEval(opStatic, t) - 80 * mul) < 0.01);
        assert.ok(Math.abs(ffEval(opKf, t) - TA.evalKeyframeField([{ t: 0, v: 100 }, { t: 2, v: 40, e: 'linear' }], t) * mul) < 0.02);
        n += 2;
    }
    assert.strictEqual(TA.wiggleOpacityFfmpegExpr({ wiggle: { position: { enabled: true } } }, null, 100), null);
    assert.strictEqual(TA.wiggleOpacityFfmpegExpr(null, null, 100), null);
    console.log(`  ${n} phép so`);
});

test('backend chuyển tiếp NGUYÊN biểu thức wiggle (bộ lọc ký tự không cắt)', () => {
    const { normalizeEditingPayload } = require(path.join(ROOT, 'backend', 'server.js'));
    const spec = TA.videoAnimationExpr({ duration: 4, animation: { wiggle: FULL } }, 1080);
    const op = TA.wiggleOpacityFfmpegExpr({ wiggle: FULL }, null, 100);
    const payload = normalizeEditingPayload({
        version: 5,
        tracks: [{ id: 'track_main', type: 'main', order: 0, visible: true }, { id: 'track_1', type: 'overlay', order: 1, visible: true }],
        items: [{
            id: 'ov1', type: 'media', track_id: 'track_1', asset_id: 'a1', timeline_start: 0, duration: 4, source_start: 0,
            transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
            animation_video: spec, keyframe_expr: { opacity_expr: op },
        }],
        assets: [{ id: 'a1', type: 'video', path: '/tmp/none.mp4', width: 1920, height: 1080 }],
    }, 10, 30);
    const ov = payload.overlays[0];
    assert.strictEqual(ov.anim_x_expr, spec.x_expr);
    assert.strictEqual(ov.anim_y_expr, spec.y_expr);
    assert.strictEqual(ov.anim_sx_expr, spec.scale_x_expr);
    assert.strictEqual(ov.anim_sy_expr, spec.scale_y_expr);
    assert.strictEqual(ov.anim_rot_expr, spec.rot_expr);
    assert.strictEqual(ov.kf_opacity_expr, op);
    assert.ok(spec.x_expr.length < 4000 && spec.rot_expr.length < 4000, 'biểu thức vượt trần 4000 ký tự của backend');
});

/* Sidecar render thật: overlay 160×120 (scale 50%) trên nền đen, rung vị trí + độ mờ.
 * Đo TÂM hộp sáng và độ sáng trung bình ở vài mốc, so với engine. */
function testSidecar() {
    if (!fs.existsSync(SIDECAR)) {
        console.log(`(bỏ qua ca sidecar: chưa build ${SIDECAR})`);
        return;
    }
    const W = 320; const H = 240; const DUR = 3;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgl-'));
    const mk = (color, out) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=${color}:s=${W}x${H}:d=${DUR + 0.4}:r=25`,
        '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${DUR + 0.4}`, '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);
    const src = path.join(dir, 'src.mp4'); mk('0xf0f0f0', src);
    const base = path.join(dir, 'base.mp4'); mk('0x000000', base);
    const anim = { wiggle: { position: { enabled: true, amp: 50, freq: 1.5, seed: 11 }, opacity: { enabled: true, amp: 60, freq: 1.2, seed: 4 } } };
    const item = { duration: DUR, animation: anim };
    const spec = TA.videoAnimationExpr(item, H);
    const payload = {
        version: 5,
        sequence: { width: W, height: H, preset: 'custom', source_width: W, source_height: H, source_fps: '25' },
        intervals: [{ index: 0, start: 0, end: DUR, audio_volume: 100 }],
        overlays: [{
            index: 0, id: 'ov_wgl', type: 'media', asset_type: 'media_video', asset_path: src,
            timeline_start: 0, duration: DUR, source_start: 0, muted: true, has_audio: false,
            position_x: 0, position_y: 0, scale: 50, rotation: 0, opacity: 100,
            anim_x_expr: spec.x_expr, anim_y_expr: spec.y_expr,
            anim_in_start: spec.in_start, anim_in_dur: spec.in_dur, anim_out_start: spec.out_start, anim_out_dur: spec.out_dur,
            kf_opacity_expr: TA.wiggleOpacityFfmpegExpr(anim, null, 100),
        }],
        settings: { resolution: 'sequence', width: W, height: H, fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '128k' },
    };
    const json = path.join(dir, 'p.json');
    fs.writeFileSync(json, JSON.stringify(payload));
    const out = path.join(dir, 'out.mp4');
    const tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp);
    const res = spawnSync(SIDECAR, ['export-video', base, out, json, tmp, 'sequence', '25'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(res.status, 0, `sidecar lỗi:\n${res.stdout}\n${res.stderr}`);
    // Giải mã TOÀN BỘ rồi lấy đúng khung k (tua bằng -ss có thể rơi lệch một khung).
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    assert.strictEqual(raw.status, 0);
    [10, 25, 40, 55, 70].forEach((k) => {
        const off = k * W * H;
        const px = (x, y) => raw.stdout[off + y * W + x];
        let x0 = W; let y0 = H; let x1 = -1; let y1 = -1; let sum = 0; let cnt = 0;
        for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
            if (px(x, y) > 12) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
        for (let y = y0 + 6; y <= y1 - 6; y += 1) for (let x = x0 + 6; x <= x1 - 6; x += 1) { sum += px(x, y); cnt += 1; }
        const tf = k / 25;
        const st = TA.animationStateAt(item, tf, { boxHeight: H });
        const cx = (x0 + x1) / 2 - W / 2; const cy = (y0 + y1) / 2 - H / 2;
        const lum = sum / cnt;
        // Nguồn 0xf0 qua yuv (dải hẹp) ≈ 235 khi đầy độ mờ
        const full = 235;
        console.log(`  khung ${k} (${tf.toFixed(2)}s): tâm (${cx.toFixed(1)}, ${cy.toFixed(1)}) ~ engine (${st.dx.toFixed(1)}, ${st.dy.toFixed(1)}) · sáng ${lum.toFixed(0)} ~ ${(full * st.opacityMul).toFixed(0)}`);
        assert.ok(Math.abs(cx - st.dx) < 3 && Math.abs(cy - st.dy) < 3, 'vị trí xuất lệch engine');
        assert.ok(Math.abs(lum - full * st.opacityMul) < 14, 'độ mờ xuất lệch engine');
    });
    console.log('✓ sidecar render đúng vị trí + độ mờ wiggle (overlay video)');

    // ---- CLIP LANE CHÍNH: đường filter riêng (interval), chồng lên hiệu ứng Vào ----
    const mItem = { duration: DUR, animation: { in: { type: 'fade', duration: 0.4, easing: 'linear' }, out: { type: 'none' },
        wiggle: { position: { enabled: true, amp: 40, freq: 1.3, seed: 2 }, opacity: { enabled: true, amp: 50, freq: 1, seed: 9 } } } };
    const mSpec = TA.videoAnimationExpr(mItem, H);
    const mPayload = {
        resolution: 'source', width: W, height: H, fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
        intervals: [{
            index: 0, start: 0, end: DUR, position_x: 0, position_y: 0, scale: 50, rotation: 0, opacity: 100, audio_volume: 100,
            anim_x_expr: mSpec.x_expr, anim_y_expr: mSpec.y_expr, anim_sx_expr: mSpec.scale_x_expr || '', anim_sy_expr: mSpec.scale_y_expr || '',
            anim_rot_expr: mSpec.rot_expr || '',
            anim_in_start: mSpec.in_start, anim_in_dur: mSpec.in_dur, anim_out_start: mSpec.out_start, anim_out_dur: mSpec.out_dur,
            kf_opacity_expr: TA.wiggleOpacityFfmpegExpr(mItem.animation, null, 100),
        }],
    };
    const mJson = path.join(dir, 'm.json');
    fs.writeFileSync(mJson, JSON.stringify(mPayload));
    const mOut = path.join(dir, 'm.mp4');
    const mRes = spawnSync(SIDECAR, ['export-video', src, mOut, mJson, dir, 'high', '25'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(mRes.status, 0, `sidecar lỗi (lane chính):\n${mRes.stdout}\n${mRes.stderr}`);
    const mRaw = spawnSync('ffmpeg', ['-v', 'error', '-i', mOut, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    [15, 35, 55, 70].forEach((k) => {
        const off = k * W * H;
        const px = (x, y) => mRaw.stdout[off + y * W + x];
        let x0 = W; let y0 = H; let x1 = -1; let y1 = -1; let sum = 0; let cnt = 0;
        for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
            if (px(x, y) > 12) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
        for (let y = y0 + 6; y <= y1 - 6; y += 1) for (let x = x0 + 6; x <= x1 - 6; x += 1) { sum += px(x, y); cnt += 1; }
        const st = TA.animationStateAt(mItem, k / 25, { boxHeight: H });
        const cx = (x0 + x1) / 2 - W / 2; const cy = (y0 + y1) / 2 - H / 2;
        console.log(`  lane chính khung ${k}: tâm (${cx.toFixed(1)}, ${cy.toFixed(1)}) ~ engine (${st.dx.toFixed(1)}, ${st.dy.toFixed(1)}) · sáng ${(sum / cnt).toFixed(0)} ~ ${(235 * st.opacityMul).toFixed(0)}`);
        assert.ok(Math.abs(cx - st.dx) < 3 && Math.abs(cy - st.dy) < 3, 'lane chính: vị trí xuất lệch engine');
        assert.ok(Math.abs(sum / cnt - 235 * st.opacityMul) < 14, 'lane chính: độ mờ xuất lệch engine');
    });
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('✓ sidecar render đúng wiggle cho clip lane chính (chồng lên hiệu ứng Vào)');
}

testSidecar();
console.log('PASS wiggle');
process.exit(0);
