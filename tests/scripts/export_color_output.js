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

    // ---- 3) KEYFRAME của lớp đi tới sidecar (trước đây backend vứt mọi field ngoài adj_filters) ----
    // Độ sáng eq của LỚP: 0 trong 1s đầu của overlay, +0.35 sau đó (LOCALT = thời gian cục bộ).
    const withKf = exportWith('overlay_layer_kf', [imageOverlay(png, {
        timeline_start: 1, duration: 2,
        adj_layer_eq_brightness_expr: 'if(lt(LOCALT,1),0,0.35)',
    })], source);
    const kfEarly = sample(withKf, 1.4, crop);
    const kfLate = sample(withKf, 2.6, crop);
    assert.ok(kfLate[0] > kfEarly[0] + 30,
        `keyframe eq của lớp phải làm sáng nửa sau: đầu=${kfEarly} sau=${kfLate}`);
    console.log(`  ok  keyframe eq của lớp: đầu=${kfEarly[0]} sau=${kfLate[0]}`);

    // ---- 4) Nguồn KHÔNG gắn nhãn màu phải được đọc ĐÚNG như preview (Chromium) ----
    // Sai số cho phép 5/255: màu bão hoà qua một vòng mã hoá lại lệch ~4 (xám chỉ ~2).
    // ĐO trong app: Chromium đọc nguồn thiếu nhãn theo BT.709 khi CAO >= 720, theo BT.601 khi
    // thấp hơn; FFmpeg luôn BT.601. Chỉ ca HD là lệch -> sidecar gắn bt709 cho riêng ca đó.
    const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    const makeUntagged = (name, size) => {
        const file = path.join(TEST_DIR, name);
        run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0xD04828:size=${size}:rate=30:duration=3`,
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
            '-vf', 'format=yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', file]);
        assert.ok(['unknown', undefined].includes(probeColor(file).color_space),
            `bối cảnh: ${name} phải KHÔNG có nhãn color_space`);
        return file;
    };
    const decodeAs = (file, matrix) => {
        const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', '1.5', '-i', file, '-frames:v', '1',
            '-vf', `setparams=colorspace=${matrix},scale=1:1:flags=area`,
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { cwd: ROOT, encoding: 'buffer' });
        return [...r.stdout.slice(0, 3)];
    };
    const hd = makeUntagged('untagged_hd.mp4', '1280x720');
    const sd = makeUntagged('untagged_sd.mp4', '320x180');
    const as709 = decodeAs(hd, 'bt709');
    const as601 = decodeAs(hd, 'smpte170m');
    assert.ok(dist(as709, as601) >= 6, `bối cảnh: 709 và 601 phải khác nhau rõ (${as709} vs ${as601})`);

    const gotHd = sample(exportWith('untagged_hd_main', [], hd), 1.5, '40:40:140:70');
    assert.ok(dist(gotHd, as709) <= 5 && dist(gotHd, as709) < dist(gotHd, as601),
        `nguồn HD thiếu nhãn phải xuất theo BT.709 (như preview): nhận ${gotHd}, 709=${as709}, 601=${as601}`);
    const gotSd = sample(exportWith('untagged_sd_main', [], sd), 1.5, '40:40:140:70');
    const sd601 = decodeAs(sd, 'smpte170m');
    const sd709 = decodeAs(sd, 'bt709');
    assert.ok(dist(gotSd, sd601) <= 5 && dist(gotSd, sd601) < dist(gotSd, sd709),
        `nguồn SD thiếu nhãn phải GIỮ BT.601 (như preview): nhận ${gotSd}, 601=${sd601}, 709=${sd709}`);
    console.log(`  ok  nguồn thiếu nhãn: HD xuất=${gotHd} (709=${as709}) · SD xuất=${gotSd} (601=${sd601})`);

    // Nguồn HD đó làm VIDEO overlay.
    const withUntaggedOv = exportWith('untagged_overlay', [{
        ...imageOverlay(hd), asset_type: 'media_video', has_audio: false,
    }], source);
    const gotOv = sample(withUntaggedOv, 1.5, '40:40:140:70');
    assert.ok(dist(gotOv, as709) <= 5 && dist(gotOv, as709) < dist(gotOv, as601),
        `video overlay HD thiếu nhãn phải xuất theo BT.709: nhận ${gotOv}, 709=${as709}, 601=${as601}`);
    console.log(`  ok  video overlay HD thiếu nhãn đọc theo BT.709: xuất=${gotOv}`);

    // ---- 5) Cường độ LUT keyframe: quãng GIỮ 100% (trước keyframe đầu) phải CÓ LUT ----
    // Lỗi FFmpeg: blend nhận all_opacity = 1 TRÒN qua lệnh lúc chạy thì ra nhánh dưới (không
    // LUT). Keyframe 100% @5s -> 0% @10s trước đây mất trắng LUT ở 0–5s.
    global.window = global.window || {};
    // eslint-disable-next-line global-require
    const TextAnimations = require(path.join(ROOT, 'static', 'js', 'text-animations.js'));
    const lutN = 9;
    const lutData = new Float32Array(lutN * lutN * lutN * 3);
    for (let b = 0; b < lutN; b += 1) for (let g = 0; g < lutN; g += 1) for (let r = 0; r < lutN; r += 1) {
        const i = ((b * lutN + g) * lutN + r) * 3;
        lutData[i] = Math.min(1, (r / (lutN - 1)) * 0.4 + 0.6);
        lutData[i + 1] = (g / (lutN - 1)) * 0.5;
        lutData[i + 2] = (b / (lutN - 1)) * 0.3;
    }
    ColorAdjust.registerUserLut('hold-lut', { size: lutN, data: lutData, domainMin: [0, 0, 0], domainMax: [1, 1, 1] });
    const lutAdj = ColorAdjust.defaultAdjustments();
    lutAdj.lut.id = 'hold-lut';
    lutAdj.lut.intensity = 100;
    const lutKf = { 'adj.lut.intensity': [{ t: 1, v: 100, e: 'linear' }, { t: 2, v: 0, e: 'linear' }] };
    const lutMix = ColorAdjust.lutMixKeyframeExpr(lutAdj, lutKf, TextAnimations.keyframeFieldFfmpegExpr);
    const lutCubes = ColorAdjust.lutBlendCubes(lutAdj, lutN);
    const lutA = path.join(TEST_DIR, 'hold_a.cube');
    const lutB = path.join(TEST_DIR, 'hold_b.cube');
    fs.writeFileSync(lutA, lutCubes.a);
    fs.writeFileSync(lutB, lutCubes.b);
    const holdTl = path.join(TEST_DIR, 'hold.json');
    fs.writeFileSync(holdTl, JSON.stringify({
        version: 4, sequence: { width: 320, height: 180, fps: '30' },
        intervals: [{ start: 0, end: 3, adj_layer_lut_a_path: lutA, adj_layer_lut_b_path: lutB, adj_layer_lut_mix_expr: lutMix }],
        editingTracks: [], editingItems: [], assets: [], main_audio_volume: 100, overlays: [],
        settings: { resolution: 'sequence', width: 320, height: 180, fps: 'source', codec: 'h264',
            quality: 'high', audio_bitrate: '128k', render_fps: '30' },
    }));
    const holdOut = path.join(TEST_DIR, 'hold.mp4');
    run(SIDECAR, ['export-video', source, holdOut, holdTl, TEST_DIR, 'sequence', 'source'], { timeout: 600000 });
    const whole = '320:180:0:0';
    const srcGrey = sample(source, 0.5, whole);
    const held = sample(holdOut, 0.5, whole);     // trước keyframe đầu: GIỮ 100%
    const faded = sample(holdOut, 2.6, whole);    // sau keyframe cuối: 0%
    assert.ok(dist(held, srcGrey) > 30,
        `quãng giữ 100% trước keyframe đầu phải CÓ LUT: nguồn=${srcGrey} xuất=${held}`);
    assert.ok(dist(faded, srcGrey) <= 4, `sau keyframe 0% phải về lại nguồn: nguồn=${srcGrey} xuất=${faded}`);
    console.log(`  ok  cường độ LUT giữ 100% trước keyframe đầu: nguồn=${srcGrey} giữ=${held} cuối=${faded}`);

    // ---- 6) HAI LỚP ĐIỀU CHỈNH XẾP CHỒNG: lớp DƯỚI (LUT có keyframe) KHÔNG được mất ----
    // Dự án thật "Yêu Con 1 – ver 7": lớp "Ửng hồng" (LUT, cường độ keyframe 100 -> 0) nằm DƯỚI
    // lớp "Bạc hà" (LUT tĩnh). Luật cũ "một lớp, lớp trên thắng" bỏ trắng lớp dưới. Nay lớp 0 =
    // lớp dưới (field adj_layer_*), lớp 1 = lớp trên (adj_layer1_*), áp đúng thứ tự đó.
    const upperAdj = ColorAdjust.normalize(null);
    upperAdj.basic.exposure = 25;
    const upperFilters = ColorAdjust.ffmpegFilters(upperAdj, '', 180, {}).join(',');
    const stackTl = path.join(TEST_DIR, 'stack.json');
    fs.writeFileSync(stackTl, JSON.stringify({
        version: 4, sequence: { width: 320, height: 180, fps: '30' },
        intervals: [{ start: 0, end: 3,
            adj_layer_lut_a_path: lutA, adj_layer_lut_b_path: lutB, adj_layer_lut_mix_expr: lutMix,
            adj_layer1_filters: upperFilters, adj_layer_count: 2 }],
        editingTracks: [], editingItems: [], assets: [], main_audio_volume: 100, overlays: [],
        settings: { resolution: 'sequence', width: 320, height: 180, fps: 'source', codec: 'h264',
            quality: 'high', audio_bitrate: '128k', render_fps: '30' },
    }));
    const stackOut = path.join(TEST_DIR, 'stack.mp4');
    run(SIDECAR, ['export-video', source, stackOut, stackTl, TEST_DIR, 'sequence', 'source'], { timeout: 600000 });
    const stackHeld = sample(stackOut, 0.5, whole);    // LUT 100% (lớp dưới) + phơi sáng (lớp trên)
    const stackFaded = sample(stackOut, 2.6, whole);   // LUT 0% -> chỉ còn lớp trên
    // Lớp trên phải có mặt ở cả hai quãng (sáng hơn chính quãng đó khi không có nó).
    assert.ok(stackFaded[1] > srcGrey[1] + 20,
        `lớp TRÊN (phơi sáng) phải có mặt: nguồn=${srcGrey} xuất=${stackFaded}`);
    // Lớp dưới phải có mặt ở quãng giữ 100%: hình học màu của LUT (R cao, B thấp) còn nguyên,
    // tức KHÁC hẳn "chỉ lớp trên" ở quãng cuối.
    assert.ok(stackHeld[0] - stackHeld[2] > 60,
        `lớp DƯỚI (LUT keyframe) phải có mặt khi xếp chồng: giữ=${stackHeld} (chỉ lớp trên=${stackFaded})`);
    assert.ok(dist(stackHeld, stackFaded) > 30,
        `quãng LUT 100% phải khác quãng LUT 0%: giữ=${stackHeld} cuối=${stackFaded}`);
    console.log(`  ok  hai lớp xếp chồng: LUT keyframe (dưới) + phơi sáng (trên) giữ=${stackHeld} cuối=${stackFaded}`);

    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    console.log('export_color_output: PASS');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
