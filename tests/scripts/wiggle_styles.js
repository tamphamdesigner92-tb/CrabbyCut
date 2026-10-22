/* =============================================================================
 * WIGGLE — KIỂU CHUYỂN ĐỘNG (Điểm đích / Giật cục) + DỜI DƯỚI PIXEL KHI XUẤT
 *
 *   1. biểu thức FFmpeg (thanh ghi st/ld, không `;`) trùng engine preview từng mốc, mọi kiểu ×
 *      easing × octave × mức nghỉ; dưới trần 4000 ký tự của backend;
 *   2. Điểm đích chạy liền mạch (không nhảy), Giật cục nhảy đúng ở đầu nhịp; kiểu Mượt giữ y hệt;
 *   3. backend chuyển cờ subpixel; sidecar render thật: tâm block bám engine dưới 0,2 px ở ảnh /
 *      video lớp phủ / clip lane chính, kể cả có thu phóng + xoay theo thời gian (không còn bậc 1 px).
 *
 * Chạy: node tests/scripts/wiggle_styles.js   (ca sidecar cần ffmpeg + sidecar đã build)
 * ========================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8129';
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || path.join(ROOT, 'test_temp', 'wiggle_styles');
fs.mkdirSync(process.env.CRAB_TEMP_DIR, { recursive: true });
const TA = require(path.join(ROOT, 'static', 'js', 'text-animations.js'));
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build',
    process.platform === 'win32' ? 'core_process.exe' : 'core_process');

// Bộ tính biểu thức FFmpeg đủ dùng: if/st/ld/isnan... tính TRÁI -> PHẢI như eval.c với chuỗi if.
function makeEval() {
    let reg = new Array(10).fill(0);
    const F = {
        IF: (c, a, b) => (c ? a : b), isnan: Number.isNaN, st: (i, v) => (reg[i] = v), ld: (i) => reg[i],
        lt: (a, b) => (a < b ? 1 : 0), gt: (a, b) => (a > b ? 1 : 0), gte: (a, b) => (a >= b ? 1 : 0),
        clip: (x, lo, hi) => Math.min(hi, Math.max(lo, x)), pow: Math.pow, exp: Math.exp, cos: Math.cos,
        sin: Math.sin, min: Math.min, max: Math.max, floor: Math.floor,
    };
    const cache = new Map();
    return (expr, t) => {
        let fn = cache.get(expr);
        if (!fn) {
            // eslint-disable-next-line no-new-func
            fn = new Function('LOCALT', ...Object.keys(F), `return (${String(expr).replace(/\bif\(/g, 'IF(')});`);
            cache.set(expr, fn);
        }
        reg = new Array(10).fill(0);
        return fn(t, ...Object.values(F));
    };
}

function test(name, fn) {
    fn();
    console.log(`✓ ${name}`);
}

test('biểu thức FFmpeg trùng engine — mọi kiểu × easing × octave × nghỉ, dưới 4000 ký tự', () => {
    const ev = makeEval();
    let worst = 0;
    let maxLen = 0;
    for (const style of TA.WIGGLE_STYLES) {
        for (const opt of TA.EASING_OPTIONS) {
            for (const octaves of [1, 2, 4]) {
                for (const hold of [0, 0.4, 0.9]) {
                    const p = { enabled: true, octaves, amp_mult: 0.6, seed: 7, style, easing: opt.value, hold };
                    const wig = TA.normalizeWiggle({
                        position: { ...p, freq: 2.3, amp: 30 }, scale: { ...p, amp: 20 },
                        rotation: { ...p, amp: 15 }, opacity: { ...p, amp: 40 },
                    });
                    const ex = TA.wiggleFfmpegExprs(wig);
                    ['x', 'y', 'sx', 'sy', 'rot', 'op'].forEach((k) => { maxLen = Math.max(maxLen, (ex[k] || '').length); });
                    for (let t = -0.3; t < 12; t += 0.0731) {
                        const st = TA.wiggleStateAt(wig, t);
                        worst = Math.max(worst, Math.abs(ev(ex.x, t) - st.dx), Math.abs(ev(ex.y, t) - st.dy),
                            Math.abs(ev(ex.sx, t) - st.sx), Math.abs(ev(ex.rot, t) - st.rot), Math.abs(ev(ex.op, t) - st.op));
                    }
                }
            }
        }
    }
    console.log(`  lệch lớn nhất ${worst.toExponential(2)}, biểu thức dài nhất ${maxLen} ký tự`);
    assert.ok(worst < 1e-3, 'biểu thức lệch engine');
    // + phần trượt In/Out (~300 ký tự) vẫn phải lọt trần 4000 của backend
    assert.ok(maxLen < 3500, 'biểu thức wiggle quá dài');
});

test('Điểm đích liền mạch, Giật cục nhảy ở đầu nhịp, nghỉ đứng yên đúng phần nhịp', () => {
    const at = (fx, t) => TA.wiggleStateAt(TA.normalizeWiggle({ position: { enabled: true, freq: 2, amp: 30, ...fx } }), t).dx;
    let maxStep = 0;
    let prev = at({ style: 'target', hold: 0.3 }, 0);
    for (let t = 0.001; t < 10; t += 0.001) {
        const v = at({ style: 'target', hold: 0.3 }, t);
        maxStep = Math.max(maxStep, Math.abs(v - prev));
        prev = v;
    }
    assert.ok(maxStep < 1, `Điểm đích nhảy ${maxStep.toFixed(2)} px trong 1 ms`);
    // Giật cục 2 nhịp/giây: đứng yên trong nhịp, nhảy ~10 lần trong 5 s
    const fxStep = { style: 'step' };
    let jumps = 0;
    prev = at(fxStep, 0);
    for (let t = 0.002; t < 5; t += 0.002) {
        const v = at(fxStep, t);
        if (Math.abs(v - prev) > 1e-6) jumps += 1;
        prev = v;
    }
    assert.ok(jumps >= 9 && jumps <= 11, `Giật cục 2 nhịp/giây × 5 s phải nhảy ~10 lần (đếm ${jumps})`);
    // Nghỉ 50 %: khoảng nửa thời gian đứng yên ở điểm đích; nghỉ 0: gần như luôn chuyển động
    const stillShare = (hold) => {
        let still = 0; let total = 0;
        let p = at({ style: 'target', freq: 1, hold }, 0);
        for (let t = 0.004; t < 20; t += 0.004) {
            const v = at({ style: 'target', freq: 1, hold }, t);
            if (Math.abs(v - p) < 1e-9) still += 1;
            total += 1;
            p = v;
        }
        return still / total;
    };
    const s50 = stillShare(0.5);
    const s0 = stillShare(0);
    assert.ok(Math.abs(s50 - 0.5) < 0.03, `nghỉ 50 % -> đứng yên ${(s50 * 100).toFixed(1)} %`);
    assert.ok(s0 < 0.02, `nghỉ 0 -> đứng yên ${(s0 * 100).toFixed(1)} %`);
    // Mượt: không đổi so với trước (cùng seed ra cùng giá trị như sóng sin cũ)
    const smooth = TA.normalizeWiggle({ position: { enabled: true, seed: 5 } });
    const smooth2 = TA.normalizeWiggle({ position: { enabled: true, seed: 5, style: 'smooth', easing: 'bounce', hold: 0.7 } });
    assert.strictEqual(TA.wiggleStateAt(smooth, 1.3).dx, TA.wiggleStateAt(smooth2, 1.3).dx);
});

test('chuẩn hoá tham số mới + backend chuyển cờ subpixel', () => {
    const fx = TA.normalizeWiggleFx('position', { style: 'xx', easing: 'nope', hold: 5 });
    assert.deepStrictEqual([fx.style, fx.easing, fx.hold], ['smooth', 'ease-in-out', TA.WIGGLE_HOLD_MAX]);
    const spec = TA.videoAnimationExpr({ duration: 4, animation: { wiggle: { position: { enabled: true } } } }, 100);
    assert.strictEqual(spec.subpixel, true);
    assert.ok(!('subpixel' in TA.videoAnimationExpr({ duration: 4, animation: { wiggle: { rotation: { enabled: true } } } }, 100)),
        'chỉ Wiggle VỊ TRÍ mới bật dời dưới pixel');
    const { normalizeEditingPayload } = require(path.join(ROOT, 'backend', 'server.js'));
    const payload = normalizeEditingPayload({
        version: 5,
        tracks: [{ id: 'track_main', type: 'main', order: 0, visible: true }, { id: 'track_1', type: 'overlay', order: 1, visible: true }],
        items: [{
            id: 'ov1', type: 'media', track_id: 'track_1', asset_id: 'a1', timeline_start: 0, duration: 4, source_start: 0,
            transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 }, animation_video: spec,
        }],
        assets: [{ id: 'a1', type: 'media_image', path: '/tmp/none.png', width: 100, height: 100 }],
    }, 10, 30);
    assert.strictEqual(payload.overlays[0].anim_subpixel, true);
});

/* Sidecar thật: ô trắng 100 px rung vài px. Đo TÂM SÁNG (dưới pixel) từng khung so với engine. */
function testSidecar() {
    if (!fs.existsSync(SIDECAR)) {
        console.log(`(bỏ qua ca sidecar: chưa build ${SIDECAR})`);
        return;
    }
    const W = 320; const H = 240; const DUR = 3; const FPS = 30; const START = 0.37;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgls-'));
    const ff = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    const base = path.join(dir, 'base.mp4');
    ff(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=${DUR + 1}:r=${FPS}`, '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${DUR + 1}`,
        '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base]);
    const vsrc = path.join(dir, 'vsrc.mp4');
    ff(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=${DUR + 1}:r=${FPS}`, '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${DUR + 1}`,
        '-shortest', '-vf', 'drawbox=x=110:y=70:w=100:h=100:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', vsrc]);
    const png = path.join(dir, 'sq.png');
    ff(['-f', 'lavfi', '-i', 'color=c=white:s=100x100', '-frames:v', '1', png]);
    const cases = [
        ['vị trí mượt', { position: { enabled: true, amp: 6, freq: 0.8, seed: 3 } }],
        ['điểm đích + xoay + thu phóng giật cục', { position: { enabled: true, amp: 12, freq: 1.5, seed: 3, octaves: 3, style: 'target', easing: 'bounce', hold: 0.3 },
            rotation: { enabled: true, amp: 8 }, scale: { enabled: true, amp: 10, style: 'step' } }],
    ];
    const settings = { resolution: 'sequence', width: W, height: H, fps: String(FPS), render_fps: String(FPS), codec: 'h264', quality: 'high', audio_bitrate: '128k' };
    const seq = { width: W, height: H, preset: 'custom', source_width: W, source_height: H, source_fps: String(FPS) };
    cases.forEach(([label, wiggle], ci) => {
        const item = { duration: DUR, animation: { wiggle } };
        const spec = TA.videoAnimationExpr(item, 100);
        const animFields = {
            anim_x_expr: spec.x_expr, anim_y_expr: spec.y_expr, anim_sx_expr: spec.scale_x_expr || '', anim_sy_expr: spec.scale_y_expr || '',
            anim_rot_expr: spec.rot_expr || '', anim_in_start: 0, anim_in_dur: 0, anim_out_start: 0, anim_out_dur: 0, anim_subpixel: true,
        };
        const ov = { timeline_start: START, duration: DUR, source_start: 0, muted: true, has_audio: false, position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100, ...animFields };
        const runs = [
            ['ảnh', { version: 5, sequence: seq, intervals: [{ index: 0, start: 0, end: DUR + START, audio_volume: 100 }],
                overlays: [{ index: 0, id: 'ov_img', type: 'media', asset_type: 'media_image', asset_path: png, width: 100, height: 100, ...ov }], settings }, base, ['sequence', String(FPS)], START],
            ['video', { version: 5, sequence: seq, intervals: [{ index: 0, start: 0, end: DUR + START, audio_volume: 100 }],
                overlays: [{ index: 0, id: 'ov_vid', type: 'media', asset_type: 'media_video', asset_path: vsrc, ...ov }], settings }, base, ['sequence', String(FPS)], START],
            ['lane chính', { resolution: 'source', width: W, height: H, fps: String(FPS), render_fps: String(FPS), codec: 'h264', quality: 'high', audio_bitrate: '192k',
                intervals: [{ index: 0, start: 0, end: DUR, position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100, audio_volume: 100, ...animFields }] }, vsrc, ['high', String(FPS)], 0],
        ];
        runs.forEach(([kind, payload, input, args, start], ri) => {
            const json = path.join(dir, `p${ci}_${ri}.json`);
            fs.writeFileSync(json, JSON.stringify(payload));
            const out = path.join(dir, `o${ci}_${ri}.mp4`);
            const tmp = path.join(dir, `t${ci}_${ri}`); fs.mkdirSync(tmp);
            const res = spawnSync(SIDECAR, ['export-video', input, out, json, tmp, ...args], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
            assert.strictEqual(res.status, 0, `sidecar lỗi (${label}, ${kind}):\n${res.stdout}\n${res.stderr}`);
            const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }).stdout;
            const n = raw.length / (W * H);
            let worst = 0; let cnt = 0;
            for (let k = 0; k < n; k += 1) {
                const tl = k / FPS - start;
                if (tl < 0.1 || tl > DUR - 0.1) continue;
                let sx = 0; let sy = 0; let s = 0; const off = k * W * H;
                for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const v = raw[off + y * W + x]; if (v > 20) { sx += x * v; sy += y * v; s += v; } }
                const st = TA.animationStateAt(item, tl, { boxHeight: 100 });
                worst = Math.max(worst, Math.abs(sx / s - (W - 1) / 2 - st.dx), Math.abs(sy / s - (H - 1) / 2 - st.dy));
                cnt += 1;
            }
            console.log(`  ${label} · ${kind}: ${cnt} khung, tâm lệch engine tối đa ${worst.toFixed(2)} px`);
            assert.ok(worst < 0.2, `${label} · ${kind}: còn bậc pixel / lệch ${worst.toFixed(2)} px`);
        });
    });
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('✓ sidecar dời dưới pixel: ảnh / video / lane chính bám engine < 0,2 px');
}

testSidecar();
console.log('PASS wiggle_styles');
process.exit(0);
