/* =============================================================================
 * HOẠT ẢNH VIDEO — ĐỐI CHIẾU BIỂU THỨC FFMPEG ↔ ENGINE PREVIEW
 *
 * Block video (overlay lẫn clip lane chính) không bake được PNG per-frame, nên bản
 * xuất của nó KHÔNG chạy animationStateAt() mà chạy một chuỗi biểu thức FFmpeg do
 * videoAnimationExpr() sinh ra. Hai đường khác nhau đến mức chỉ cần một dấu ngoặc lệch
 * là video xuất khác preview mà không có gì báo — nên chốt bằng cách ĐO:
 *   1. tự nội suy biểu thức FFmpeg trong Node (ffEval bên dưới), rồi
 *   2. so từng mốc thời gian với chính engine mà preview dùng.
 *
 * Đo 4 kênh hình học: dx, dy, scaleX, scaleY, rotate. KHÔNG đo opacity — kênh đó xuất
 * bằng filter `fade` (alpha tuyến tính theo thời gian) chứ không bằng biểu thức; chỗ
 * đó chỉ chốt được MỐC đầy/cạn, làm ở ca cuối.
 *
 * Hai ca cuối đi HẾT đường ống: backend (server.js) rồi sidecar render thật — biểu thức
 * đúng mà tên field lệch một chữ thì hiệu ứng vẫn mất im lặng.
 *
 * Chạy: node tests/scripts/video_animation_expr.js   (2 ca cuối cần ffmpeg + sidecar)
 * ========================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
// Cổng riêng + thư mục tạm riêng, phải đặt TRƯỚC khi require server (xem export_smoke.js)
process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8127';
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR
    || path.join(ROOT, 'test_temp', 'video_anim');
fs.mkdirSync(process.env.CRAB_TEMP_DIR, { recursive: true });
const TA = require(path.join(ROOT, 'static', 'js', 'text-animations.js'));
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build', 'core_process');

/* Nội suy biểu thức FFmpeg. Bộ hàm dưới đây là ĐÚNG ngữ nghĩa ffmpeg eval, và chỉ phủ
 * những hàm mà ffEase/videoAnimationExpr thực sự dùng — thêm hàm mới vào biểu thức mà
 * quên khai ở đây thì test này gãy ngay, đúng như mong muốn. `if(` phải đổi tên vì `if`
 * là từ khoá của JS. */
const FF_FUNCS = {
    IF: (c, a, b) => (c ? a : b),
    lt: (a, b) => (a < b ? 1 : 0),
    gt: (a, b) => (a > b ? 1 : 0),
    clip: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
    pow: Math.pow,
    exp: Math.exp,
    cos: Math.cos,
    sin: Math.sin,
    max: Math.max,
    min: Math.min,
};

function ffEval(expr, localTime) {
    // ffmpeg đánh giá LƯỜI (if chỉ tính nhánh được chọn) còn JS thì tính cả hai — vô hại
    // ở đây vì mọi nhánh đều là biểu thức số thuần, không có chia 0 hay hàm ném lỗi.
    const js = String(expr).replace(/\bif\(/g, 'IF(');
    const names = Object.keys(FF_FUNCS);
    // eslint-disable-next-line no-new-func
    const fn = new Function('LOCALT', ...names, `return (${js});`);
    const value = fn(localTime, ...names.map((n) => FF_FUNCS[n]));
    assert.ok(Number.isFinite(value), `biểu thức ra giá trị không hữu hạn: ${expr}`);
    return value;
}

const EFFECTS = Object.keys(TA.EFFECT_SPECS);
const EASINGS = TA.EASING_OPTIONS.map((o) => o.value);
const BOX_H = 400;          // chiều cao hộp -> slideDist (biên trượt) khác 0 rõ rệt
const DURATION = 3;
const SIDE_DUR = 0.8;
const EPS = 1e-6;

/* Ngưỡng theo ĐƠN VỊ của từng kênh, không dùng một số chung. Hai bên không thể trùng đến
 * bit cuối: ffEase viết hằng số 'bounce' ở dạng thập phân rút gọn (0.363636 thay cho 4/11)
 * nên sai số tương đối ~5e-5, và nó được nhân với biên độ của kênh (tới 240px / 180°).
 * Ngưỡng dưới đây vẫn nhỏ hơn 1/100 pixel và 1/100 độ — dưới mọi mức nhìn thấy được. */
const CHANNEL_TOL = { dx: 0.01, dy: 0.01, rotate: 0.01, scaleX: 1e-4, scaleY: 1e-4 };

function run() {
    // ---- Ca 1: MỌI hiệu ứng × MỌI easing, biểu thức phải trùng engine từng mốc ----
    let compared = 0;
    for (const effect of EFFECTS) {
        for (const easing of EASINGS) {
            const item = {
                duration: DURATION,
                animation: {
                    in: { type: effect, duration: SIDE_DUR, easing },
                    out: { type: effect, duration: SIDE_DUR, easing },
                },
            };
            const spec = TA.videoAnimationExpr(item, BOX_H);
            assert.ok(spec && spec.x_expr, `${effect}/${easing}: thiếu spec biểu thức`);
            // Kênh vắng mặt = hiệu ứng không dùng kênh đó -> giá trị trung tính
            const chan = {
                dx: spec.x_expr,
                dy: spec.y_expr,
                scaleX: spec.scale_x_expr || '1',
                scaleY: spec.scale_y_expr || '1',
                rotate: spec.rot_expr || '0',
            };
            for (let i = 0; i <= 60; i += 1) {
                const t = (DURATION * i) / 60;
                const state = TA.animationStateAt(item, t, { boxHeight: BOX_H });
                assert.ok(state && !state.hidden, `${effect}/${easing}@${t}: state rỗng`);
                Object.keys(chan).forEach((key) => {
                    const got = ffEval(chan[key], t);
                    // Engine kẹp scale ≥ 0; biểu thức kẹp ≥ 0.001 (scale=0 làm ffmpeg
                    // chia 0). Chỉ khác nhau đúng tại đáy nên so sau khi kẹp cùng sàn.
                    const want = key.startsWith('scale')
                        ? Math.max(0.001, state[key])
                        : state[key];
                    assert.ok(Math.abs(got - want) < CHANNEL_TOL[key],
                        `${effect}/${easing}@${t.toFixed(3)} kênh ${key}: `
                        + `biểu thức ${got.toFixed(6)} ≠ engine ${want.toFixed(6)}`);
                    compared += 1;
                });
            }
        }
    }
    console.log(`✓ biểu thức khớp engine: ${EFFECTS.length} hiệu ứng × ${EASINGS.length} easing, ${compared} phép so`);

    // ---- Ca 2: hiệu ứng KHÔNG hình học không được kéo theo filter đắt ----
    // rotate + scale=eval=frame chạy mọi frame của cả block; hiệu ứng mờ/trượt xong bằng
    // fade + overlay x/y nên KHÔNG được sinh hai kênh đó (đây là cả lý do chúng tuỳ chọn).
    ['fade', 'slide_up', 'slide_left'].forEach((effect) => {
        const spec = TA.videoAnimationExpr({
            duration: DURATION,
            animation: {
                in: { type: effect, duration: SIDE_DUR, easing: 'ease-out' },
                out: { type: 'none' },
            },
        }, BOX_H);
        assert.ok(!spec.scale_x_expr && !spec.scale_y_expr && !spec.rot_expr,
            `${effect}: không thu phóng/xoay mà vẫn gửi kênh scale/rot`);
    });
    // ...còn hiệu ứng hình học thì PHẢI có, nếu không bản xuất im lặng bỏ mất hiệu ứng
    assert.ok(TA.videoAnimationExpr({
        duration: DURATION,
        animation: { in: { type: 'spin', duration: SIDE_DUR, easing: 'ease-out' }, out: { type: 'none' } },
    }, BOX_H).rot_expr, 'spin: thiếu kênh xoay');
    assert.ok(TA.videoAnimationExpr({
        duration: DURATION,
        animation: { in: { type: 'pop', duration: SIDE_DUR, easing: 'spring' }, out: { type: 'none' } },
    }, BOX_H).scale_x_expr, 'pop: thiếu kênh thu phóng');
    console.log('✓ kênh scale/rot chỉ gửi khi hiệu ứng thực sự dùng');

    // ---- Ca 3: LẬT chỉ co trục X ----
    // Đây là ca duy nhất scale KHÔNG đẳng hướng; nếu sidecar/biểu thức gộp hai trục thì
    // "lật" sẽ thành "thu nhỏ" mà vẫn trông hợp lý -> phải chốt riêng.
    const flip = TA.videoAnimationExpr({
        duration: DURATION,
        animation: { in: { type: 'flip', duration: SIDE_DUR, easing: 'linear' }, out: { type: 'none' } },
    }, BOX_H);
    assert.ok(flip.scale_x_expr, 'flip: thiếu kênh scale trục X');
    assert.ok(!flip.scale_y_expr, 'flip: không được co trục Y');
    assert.ok(ffEval(flip.scale_x_expr, SIDE_DUR / 2) < 0.9,
        'flip: giữa cửa sổ In trục X phải còn đang co');

    // ---- Ca 4: cửa trập opacity (fade) đầy/cạn đúng mốc ----
    // `fade` chạy alpha tuyến tính, còn engine dùng min(1, op*v): với op > 1 (pop) alpha
    // đầy khi mới đi 1/op cửa sổ. Thời lượng fade phải co theo, nếu không pop trên video
    // mờ suốt cú phóng — khác preview và khác hẳn cùng hiệu ứng trên block ảnh.
    const popSpec = TA.videoAnimationExpr({
        duration: DURATION,
        animation: {
            in: { type: 'pop', duration: SIDE_DUR, easing: 'linear' },
            out: { type: 'pop', duration: SIDE_DUR, easing: 'linear' },
        },
    }, BOX_H);
    assert.ok(Math.abs(popSpec.in_dur - SIDE_DUR / 2) < EPS,
        `pop: cửa trập vào phải là ${SIDE_DUR / 2}s, nhận ${popSpec.in_dur}`);
    // Cửa trập ra phải CẠN đúng lúc cửa sổ Out kết thúc (= hết block)
    assert.ok(Math.abs((popSpec.out_start + popSpec.out_dur) - DURATION) < 1e-4,
        'pop: cửa trập ra phải cạn đúng lúc cửa sổ Out kết thúc');
    // fade (op = 1) giữ nguyên hành vi cũ — chốt để bản sửa này không lặng lẽ đổi hiệu ứng
    // đang dùng nhiều nhất.
    const fadeSpec = TA.videoAnimationExpr({
        duration: DURATION,
        animation: {
            in: { type: 'fade', duration: SIDE_DUR, easing: 'ease-in-out' },
            out: { type: 'fade', duration: SIDE_DUR, easing: 'ease-in-out' },
        },
    }, BOX_H);
    assert.ok(Math.abs(fadeSpec.in_dur - SIDE_DUR) < EPS, 'fade: cửa trập vào phải nguyên thời lượng');
    assert.ok(Math.abs(fadeSpec.out_start - (DURATION - SIDE_DUR)) < 1e-4,
        'fade: cửa trập ra phải bắt đầu đúng đầu cửa sổ Out');
    console.log('✓ cửa trập opacity đúng mốc (pop co 1/2, fade nguyên)');

    // ---- Ca 5: video dùng CHUNG thư viện hiệu ứng với ảnh ----
    // Chính điều người dùng yêu cầu: lưới hiệu ứng của block video không được ít hơn ảnh.
    const imageEffects = TA.EFFECT_OPTIONS
        .map((o) => o.value)
        .filter((v) => v !== 'typewriter');   // typewriter chỉ có nghĩa với text
    imageEffects.forEach((v) => {
        assert.ok(TA.VIDEO_SUPPORTED_EFFECTS.has(v), `video còn thiếu hiệu ứng "${v}" so với ảnh`);
    });
    // Mọi combo cũng phải dùng được cho video (lưới "Kết hợp" lọc theo cùng tập này)
    TA.COMBO_OPTIONS.forEach((c) => {
        assert.ok(TA.VIDEO_SUPPORTED_EFFECTS.has(c.in.type) && TA.VIDEO_SUPPORTED_EFFECTS.has(c.out.type),
            `combo "${c.value}" chưa dùng được cho video`);
    });
    console.log(`✓ video phủ đủ ${imageEffects.length} hiệu ứng + ${TA.COMBO_OPTIONS.length} combo của ảnh`);

    testBackendPassthrough();
    testSidecarRender();
    console.log('PASS video_animation_expr');
}

/* ---- Ca 6: backend chuyển tiếp ĐỦ kênh xuống sidecar ----
 * Biểu thức đúng nhưng field bị đổi tên/lọt lưới bộ lọc ký tự thì sidecar không thấy gì
 * và hiệu ứng biến mất KHÔNG có lỗi nào. Đo bằng chính normalizeEditingPayload. */
function testBackendPassthrough() {
    const { normalizeEditingPayload } = require(path.join(ROOT, 'backend', 'server.js'));
    const spec = TA.videoAnimationExpr({
        duration: 4,
        animation: {
            in: { type: 'spin', duration: 0.6, easing: 'ease-out' },
            out: { type: 'scale', duration: 0.6, easing: 'ease-in-out' },
        },
    }, 1080);
    const payload = normalizeEditingPayload({
        version: 5,
        tracks: [
            { id: 'track_main', type: 'main', order: 0, visible: true },
            { id: 'track_1', type: 'overlay', order: 1, visible: true },
        ],
        items: [{
            id: 'ov1', type: 'media', track_id: 'track_1', asset_id: 'a1',
            timeline_start: 0, duration: 4, source_start: 0,
            transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
            animation_video: spec,
        }],
        assets: [{ id: 'a1', type: 'video', path: '/tmp/none.mp4', width: 1920, height: 1080 }],
    }, 10, 30);
    const ov = (payload.overlays || [])[0];
    assert.ok(ov, 'backend không dựng được overlay video');
    ['anim_x_expr', 'anim_y_expr', 'anim_sx_expr', 'anim_sy_expr', 'anim_rot_expr'].forEach((k) => {
        assert.ok(typeof ov[k] === 'string' && ov[k].length > 0, `backend rơi mất field ${k}`);
    });
    // Bộ lọc ký tự không được cắt gọt biểu thức (chỉ được bỏ ký tự lạ — mà ở đây không có)
    assert.strictEqual(ov.anim_rot_expr, spec.rot_expr, 'backend làm méo biểu thức xoay');
    console.log('✓ backend chuyển tiếp đủ 5 kênh hoạt ảnh video xuống sidecar');
}

// Hộp bao (bounding box) của phần KHÔNG đen trong 1 frame -> đo được hình đã bị xoay/co
// bao nhiêu, thứ mà đo một điểm ảnh không nói lên được.
function contentBox(videoPath, time, W, H) {
    const out = spawnSync('ffmpeg', ['-v', 'error', '-i', videoPath,
        '-ss', String(time), '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
    const buf = out.stdout;
    let x0 = W; let y0 = H; let x1 = -1; let y1 = -1;
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            const i = (y * W + x) * 3;
            // Ngưỡng cao hơn nhiễu nén nhưng thấp hơn nguồn đã nhân opacity giữa cửa sổ
            if (0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2] > 30) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
    }
    return { w: x1 - x0 + 1, h: y1 - y0 + 1, empty: x1 < 0 };
}

/* ---- Ca 7: SIDECAR render thật ----
 * Chốt hai kênh mà bản trước KHÔNG có (thu phóng + xoay). Đo bằng hộp bao của phần không
 * đen trên frame xuất ra:
 *   - thu phóng: giữa cửa sổ In hộp phải NHỎ hơn khung, ở đoạn giữ phải phủ KÍN khung
 *   - xoay     : với hiệu ứng 'spin' (-180° -> giữa cửa sổ là -90°) khung 320×240 phải
 *                thành hộp CAO hơn RỘNG; nếu sidecar bỏ qua kênh xoay thì nó vẫn ngang. */
function testSidecarRender() {
    assert.ok(fs.existsSync(SIDECAR), `chưa build sidecar: ${SIDECAR} (chạy npm run build:sidecar)`);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanim-'));
    const W = 320;
    const H = 240;
    const DUR = 2.4;
    const SIDE = 0.8;
    const srcVideo = path.join(workDir, 'src.mp4');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=0xc0d0e0:s=${W}x${H}:d=${DUR + 0.4}:r=25`,
        '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${DUR + 0.4}`, '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', srcVideo]);

    const render = (effect, name) => {
        const spec = TA.videoAnimationExpr({
            duration: DUR,
            animation: {
                in: { type: effect, duration: SIDE, easing: 'linear' },
                out: { type: 'none' },
            },
        }, H);
        const payload = {
            resolution: 'source', width: W, height: H,
            fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
            intervals: [{
                index: 0, start: 0, end: DUR, position_x: 0, position_y: 0,
                scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
                anim_x_expr: spec.x_expr, anim_y_expr: spec.y_expr,
                anim_sx_expr: spec.scale_x_expr || '', anim_sy_expr: spec.scale_y_expr || '',
                anim_rot_expr: spec.rot_expr || '',
                anim_in_start: spec.in_start, anim_in_dur: spec.in_dur,
                anim_out_start: spec.out_start, anim_out_dur: spec.out_dur,
            }],
        };
        const payloadPath = path.join(workDir, `${name}.json`);
        fs.writeFileSync(payloadPath, JSON.stringify(payload));
        const outPath = path.join(workDir, `${name}.mp4`);
        const res = spawnSync(SIDECAR, ['export-video', srcVideo, outPath, payloadPath, workDir, 'high', '25'],
            { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
        assert.strictEqual(res.status, 0,
            `sidecar lỗi với hoạt ảnh '${effect}':\n${res.stdout}\n${res.stderr}`);
        return outPath;
    };

    // -- thu phóng --
    const scaleOut = render('scale', 'anim_scale');
    const mid = contentBox(scaleOut, SIDE / 2, W, H);
    const hold = contentBox(scaleOut, DUR - 0.4, W, H);
    console.log(`  thu phóng: giữa cửa sổ ${mid.w}x${mid.h} · đoạn giữ ${hold.w}x${hold.h} (khung ${W}x${H})`);
    assert.ok(!mid.empty, 'giữa cửa sổ In phải còn thấy hình');
    assert.ok(mid.w < W * 0.85 && mid.h < H * 0.85,
        `giữa cửa sổ In hình phải đang co (đo ${mid.w}x${mid.h})`);
    assert.ok(hold.w > W * 0.97 && hold.h > H * 0.97,
        `đoạn giữ phải trở lại phủ kín khung (đo ${hold.w}x${hold.h})`);

    // -- xoay --
    const spinOut = render('spin', 'anim_spin');
    const spun = contentBox(spinOut, SIDE / 2, W, H);
    const spunHold = contentBox(spinOut, DUR - 0.4, W, H);
    console.log(`  xoay: giữa cửa sổ ${spun.w}x${spun.h} — phải CAO hơn RỘNG (nguồn ${W}x${H} ngang)`);
    assert.ok(!spun.empty, 'giữa cửa sổ In của spin phải còn thấy hình');
    assert.ok(spun.h > spun.w,
        `nguồn ngang xoay -90° phải thành hộp dọc (đo ${spun.w}x${spun.h}) — kênh xoay bị bỏ qua?`);
    // Filter `rotate` chạy SUỐT block (kể cả đoạn giữ, với góc 0) và nở canvas ra hình
    // vuông theo đường chéo. Chốt rằng đoạn giữ vẫn phủ KÍN khung — nếu công thức ow/oh
    // hay phép căn tâm sai thì chỗ này hiện thành viền đen ở mọi clip có hiệu ứng xoay.
    assert.ok(spunHold.w > W * 0.97 && spunHold.h > H * 0.97,
        `đoạn giữ của spin phải phủ kín khung (đo ${spunHold.w}x${spunHold.h})`);

    // -- OVERLAY: đường filter KHÁC hẳn lane chính (WriteVisualOverlayFilter) --
    // Đáng đo riêng vì ở đây vị trí là biểu thức 'x=(W-w)/2+...' phụ thuộc `w` — bề rộng
    // BIẾN THIÊN theo frame khi scale động. Sai chỗ này thì lớp phủ trượt khỏi tâm trong
    // lúc phóng thay vì phóng tại chỗ. Lane chính để gần như đen để không lẫn vào phép đo.
    const baseDark = path.join(workDir, 'base_dark.mp4');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=0x080808:s=${W}x${H}:d=${DUR + 0.4}:r=25`,
        '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${DUR + 0.4}`, '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', baseDark]);
    const ovlSpec = TA.videoAnimationExpr({
        duration: DUR,
        animation: {
            in: { type: 'scale', duration: SIDE, easing: 'linear' },
            out: { type: 'none' },
        },
    }, H);
    const ovlPayload = {
        version: 5,
        sequence: { width: W, height: H, preset: 'custom', source_width: W, source_height: H, source_fps: '25' },
        intervals: [{ index: 0, start: 0, end: DUR, audio_volume: 100 }],
        overlays: [{
            index: 0, id: 'ov_anim', type: 'media', asset_type: 'media_video',
            asset_path: srcVideo, timeline_start: 0, duration: DUR, source_start: 0,
            muted: true, has_audio: false,
            position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100,
            anim_x_expr: ovlSpec.x_expr, anim_y_expr: ovlSpec.y_expr,
            anim_sx_expr: ovlSpec.scale_x_expr, anim_sy_expr: ovlSpec.scale_y_expr,
            anim_in_start: ovlSpec.in_start, anim_in_dur: ovlSpec.in_dur,
            anim_out_start: ovlSpec.out_start, anim_out_dur: ovlSpec.out_dur,
        }],
        settings: {
            resolution: 'sequence', width: W, height: H, fps: '25', render_fps: '25',
            codec: 'h264', quality: 'high', audio_bitrate: '128k',
        },
    };
    const ovlJson = path.join(workDir, 'ovl.json');
    fs.writeFileSync(ovlJson, JSON.stringify(ovlPayload));
    const ovlOut = path.join(workDir, 'ovl_out.mp4');
    const ovlTmp = path.join(workDir, 'tmp_ovl');
    fs.mkdirSync(ovlTmp, { recursive: true });
    const ovlRes = spawnSync(SIDECAR, ['export-video', baseDark, ovlOut, ovlJson, ovlTmp, 'sequence', '25'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(ovlRes.status, 0,
        `sidecar lỗi với overlay có hoạt ảnh thu phóng:\n${ovlRes.stdout}\n${ovlRes.stderr}`);
    const ovlMid = contentBox(ovlOut, SIDE / 2, W, H);
    const ovlHold = contentBox(ovlOut, DUR - 0.4, W, H);
    console.log(`  overlay thu phóng: giữa cửa sổ ${ovlMid.w}x${ovlMid.h} · đoạn giữ ${ovlHold.w}x${ovlHold.h}`);
    assert.ok(!ovlMid.empty, 'giữa cửa sổ In của overlay phải còn thấy hình');
    assert.ok(ovlMid.w < W * 0.85 && ovlMid.h < H * 0.85,
        `overlay giữa cửa sổ In phải đang co (đo ${ovlMid.w}x${ovlMid.h})`);
    assert.ok(ovlHold.w > W * 0.97 && ovlHold.h > H * 0.97,
        `overlay ở đoạn giữ phải trở lại phủ kín khung (đo ${ovlHold.w}x${ovlHold.h})`);

    fs.rmSync(workDir, { recursive: true, force: true });
    console.log('✓ sidecar render đúng thu phóng/xoay theo thời gian (lane chính + overlay)');
}

run();
