/* MÀU ĐẦU RA CỦA BẢN XUẤT + LỚP ĐIỀU CHỈNH TRÊN OVERLAY — chạy thẳng sidecar.
 *
 * Hai lỗi thật đã gặp trên dự án "Yêu Con 1" (2026-09-25):
 *   1) Chỉ cần MỘT ảnh JPG làm lớp phủ là bản xuất thành `yuvj420p · pc · bt470bg` (full
 *      range + BT.601 kiểu JPEG). Nhiều trình phát bỏ qua nhãn range/matrix nên người dùng
 *      thấy màu bản xuất "khác hẳn" preview. Xem OutputColorFilters trong core_process.cpp.
 *   2) Lớp Điều chỉnh phủ MỘT PHẦN một overlay không bao giờ bật: cổng `enable` viết theo
 *      `t` thô, trong khi overlay giữ mốc TUYỆT ĐỐI trên sequence. Nay enableBetween phát
 *      token LOCALT để sidecar thay bằng (t - start).
 *
 * Cần ffmpeg trong PATH và sidecar đã build (npm run build:sidecar).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build',
    process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_color_output');
const ColorAdjust = require(path.join(ROOT, 'static', 'js', 'color-adjust.js'));

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
    assert.strictEqual(r.status, 0, `${cmd} lỗi:\n${r.stderr || r.stdout}`);
    return r;
}

function probeColor(file) {
    const r = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
        'stream=pix_fmt,color_range,color_space,color_primaries,color_transfer', '-of', 'json', file]);
    return JSON.parse(r.stdout).streams[0];
}

// Trung bình RGB của một ô, giải mã THEO NHÃN của tệp (đúng như trình phát chuẩn làm).
function sample(file, sec, crop) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1',
        '-vf', `crop=${crop},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { cwd: ROOT, encoding: 'buffer', maxBuffer: 1024 * 1024 });
    assert.strictEqual(r.status, 0, r.stderr?.toString('utf8'));
    return [...r.stdout.slice(0, 3)];
}

function exportWith(name, overlays, source) {
    const timeline = path.join(TEST_DIR, `${name}.json`);
    fs.writeFileSync(timeline, JSON.stringify({
        version: 4,
        sequence: { width: 320, height: 180, fps: '30' },
        intervals: [{ start: 0, end: 3 }],
        editingTracks: [{ id: 't1', type: 'media', order: 0, visible: true, muted: false, volume: 100 }],
        editingItems: [],
        assets: [],
        main_audio_volume: 100,
        overlays,
        settings: { resolution: 'sequence', width: 320, height: 180, fps: 'source', codec: 'h264',
            quality: 'high', audio_bitrate: '128k', render_fps: '30' },
    }), 'utf8');
    const out = path.join(TEST_DIR, `${name}.mp4`);
    run(SIDECAR, ['export-video', source, out, timeline, TEST_DIR, 'sequence', 'source'], { timeout: 600000 });
    return out;
}

function imageOverlay(file, extra = {}) {
    return {
        index: 0, id: 'ov0', type: 'media', asset_type: 'media_image', asset_path: file,
        timeline_start: 0, duration: 3, source_start: 0, position_x: 0, position_y: 0,
        scale: 100, opacity: 100, track_id: 't1', track_order: 0, muted: true, volume: 0,
        has_audio: false, ...extra,
    };
}

function main() {
    if (!fs.existsSync(SIDECAR)) {
        console.log('export_color_output: BỎ QUA (sidecar chưa build)');
        return;
    }
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Nguồn video chuẩn: yuv420p · tv · bt709, gắn nhãn đầy đủ như máy quay/điện thoại.
    const source = path.join(TEST_DIR, 'temp_input.mp4');
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:size=320x180:rate=30:duration=3',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-vf', 'format=yuv420p', '-c:v', 'libx264', '-color_range', 'tv', '-colorspace', 'bt709',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-shortest', source]);

    // ---- 1) Ảnh JPG làm lớp phủ KHÔNG được kéo bản xuất sang full range / BT.601 ----
    const jpg = path.join(TEST_DIR, 'logo.jpg');
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=80x40', '-frames:v', '1', jpg]);
    const withJpg = exportWith('jpg_overlay', [imageOverlay(jpg, { position_y: -60 })], source);
    const tags = probeColor(withJpg);
    assert.strictEqual(tags.pix_fmt, 'yuv420p', `pix_fmt phải là yuv420p, nhận ${tags.pix_fmt} (yuvj420p = lỗi cũ)`);
    assert.strictEqual(tags.color_range, 'tv', `dải màu phải là tv (limited), nhận ${tags.color_range}`);
    assert.strictEqual(tags.color_space, 'bt709', `ma trận phải là bt709, nhận ${tags.color_space}`);
    assert.strictEqual(tags.color_primaries, 'bt709', `primaries phải được gắn bt709, nhận ${tags.color_primaries}`);
    assert.strictEqual(tags.color_transfer, 'bt709', `transfer phải được gắn bt709, nhận ${tags.color_transfer}`);
    // Màu của phần video KHÔNG đổi vì phép chuyển đầu ra. So với CHÍNH nguồn (bản thân nguồn
    // đã lệch ~3/255 so với 0x80 do làm tròn khi mã hoá). Đo được: sidecar cũ lệch tới 4.
    const ref = sample(source, 1.5, '40:40:140:110');
    const grey = sample(withJpg, 1.5, '40:40:140:110');
    assert.ok(grey.every((v, i) => Math.abs(v - ref[i]) <= 3), `vùng xám bị lệch màu: nguồn=${ref} xuất=${grey}`);
    console.log(`  ok  lớp phủ JPG: bản xuất vẫn yuv420p·tv·bt709 (đủ nhãn), xám nguồn=${ref} xuất=${grey}`);

    // ---- 2) Lớp Điều chỉnh phủ MỘT PHẦN overlay bật đúng cửa sổ thời gian ----
    // Overlay nằm ở [1s, 3s); lớp phủ phần [0.5s, 1.5s) CỦA overlay -> tuyệt đối [1.5s, 2.5s).
    const png = path.join(TEST_DIR, 'card.png');
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x606060:size=120x80,format=rgba', '-frames:v', '1', png]);
    const adj = ColorAdjust.normalize(null);
    adj.basic.exposure = 60;
    const enable = ColorAdjust.enableBetween(0.5, 1.5, 2);
    assert.ok(/LOCALT/.test(enable), `enableBetween phải dùng token LOCALT, nhận "${enable}"`);
    const layerFilters = ColorAdjust.ffmpegFilters(adj, '', 180, { enable }).join(',');
    const withLayer = exportWith('overlay_layer', [imageOverlay(png, {
        timeline_start: 1, duration: 2, adj_layer_filters: layerFilters,
    })], source);
    const crop = '40:40:140:70';   // giữa overlay
    const before = sample(withLayer, 1.2, crop);
    const inside = sample(withLayer, 2.0, crop);
    const after = sample(withLayer, 2.8, crop);
    assert.ok(inside[0] > before[0] + 30,
        `trong cửa sổ lớp phải SÁNG hơn hẳn: trước=${before} trong=${inside} — lớp không bật trên overlay?`);
    assert.ok(Math.abs(after[0] - before[0]) <= 6,
        `sau cửa sổ lớp phải TẮT: trước=${before} sau=${after}`);
    console.log(`  ok  lớp phủ một phần overlay: trước=${before[0]} trong=${inside[0]} sau=${after[0]}`);

    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    console.log('export_color_output: PASS');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
