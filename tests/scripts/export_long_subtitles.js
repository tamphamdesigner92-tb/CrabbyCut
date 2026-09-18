/* =====================================================================
 * XUẤT VIDEO DÀI CÓ PHỤ ĐỀ — CHIA LƯỢT RENDER THEO THỜI GIAN
 *
 * VẤN ĐỀ: mọi lớp phủ được nối thành MỘT chuỗi `overlay`, và mỗi khung hình đầu ra phải đi
 * qua TOÀN BỘ chuỗi đó kể cả những lớp đang tắt. Đo trên video 30s 720p:
 *     50 lớp phủ -> x23,7 realtime | 300 -> x8,7 | 600 -> x2,2 | 1200 -> vượt trần dòng lệnh
 * Chi phí đi theo (số khung × số lớp phủ), nên video 3 GIỜ với ~1.500 phụ đề ngoại suy ra
 * ~3,5 giờ CHỈ để duyệt chuỗi. Chia theo thời gian giữ chuỗi luôn ngắn -> chi phí đi theo
 * độ dài phim một cách tuyến tính, không còn nhân lên.
 *
 * Bài test chạy ở quy mô RÚT GỌN nhưng đi qua ĐÚNG mọi nhánh của bản thật: cắt clip giữa
 * chừng tại biên khung, dời lớp phủ về gốc toạ độ từng batch, đánh số input lại, render
 * tiếng một lượt, ghép hình + tiếng. Bốn thứ được chốt:
 *
 *   1. XUẤT ĐƯỢC và ĐÚNG THỜI LƯỢNG — cắt sai biên khung là trôi vài khung mỗi batch;
 *   2. PHỤ ĐỀ HIỆN ĐÚNG CHỖ — lấy mẫu điểm ảnh ở nhiều mốc TRẢI ĐỀU qua các mối ghép batch.
 *      Đây là chốt quan trọng nhất: dời sai `timelineStart` hay đánh số input sai thì phụ
 *      đề vẫn "có", chỉ là hiện sai lúc — bản xuất trông vẫn bình thường;
 *   3. TIẾNG LIỀN MẠCH — nối tiếng theo batch làm mỗi mối dài thêm 23ms (priming AAC);
 *      thời lượng tiếng phải khớp hình, không trôi.
 *   4. KHÔNG CHIA khi phim ngắn — chia batch cho một phim 30s chỉ tổ tốn lượt spawn.
 *
 * Chạy: npm run test:export-long-subtitles
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_long_subtitles');
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build',
    process.platform === 'win32' ? 'core_process.exe' : 'core_process');

// 600s nguồn: vượt ngưỡng chia (240s) và cho ra nhiều batch ở nhịp 180s.
const VIDEO_SECONDS = 600;
const FPS = 30;
const SUB_COUNT = 240;          // ~1 phụ đề / 2,5s, đúng mật độ của Auto Subtitle
const SUB_DURATION = 1.6;

function run(cmd, args, opts = {}) {
    return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function probe(file, entries) {
    const r = run('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', file]);
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}

// Điểm ảnh tại (x, y) ở thời điểm `t`.
function pixelAt(file, t, x, y) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
        '-vf', `crop=6:6:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { cwd: ROOT, encoding: 'buffer', maxBuffer: 1024 * 1024 });
    assert.strictEqual(r.status, 0, r.stderr?.toString('utf8'));
    return [...r.stdout.slice(0, 3)];
}

function buildProject(dir, seconds, subCount) {
    const genDir = path.join(dir, 'generated_text');
    fs.mkdirSync(genDir, { recursive: true });
    const source = path.join(dir, 'temp_input.mp4');
    /* Nguồn TỐI: phụ đề màu đỏ chói nên phép lấy mẫu phân biệt được "có phụ đề" với "không"
       mà không phụ thuộc vào nội dung nền. */
    let r = run('ffmpeg', ['-y', '-v', 'error',
        '-f', 'lavfi', '-i', `color=c=black:size=320x180:rate=${FPS}:duration=${seconds}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', source]);
    assert.strictEqual(r.status, 0, `không dựng được nguồn:\n${r.stderr}`);

    const first = path.join(genDir, 'item_text_sub_0000.png');
    r = run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
        '-i', 'color=c=red:size=120x40,format=rgba', '-frames:v', '1', first]);
    assert.strictEqual(r.status, 0, r.stderr);

    const overlays = [];
    for (let i = 0; i < subCount; i += 1) {
        const file = path.join(genDir, `item_text_mu0pma${String(i).padStart(4, '0')}_${i}.png`);
        if (i > 0) fs.copyFileSync(first, file);
        overlays.push({
            index: i,
            id: `item_text_${i}`,
            type: 'media',
            asset_type: 'text_image',
            asset_path: i === 0 ? first : file,
            // Trải đều, luôn chừa khe giữa hai phụ đề để bộ hoạch định có chỗ cắt an toàn.
            timeline_start: Number(((i / subCount) * (seconds - 2)).toFixed(3)),
            duration: SUB_DURATION,
            source_start: 0,
            position_x: 0,
            position_y: 0,
            scale: 100,
            opacity: 100,
            track_id: 'track_text_1',
            track_order: 0,
            muted: true,
            volume: 0,
            has_audio: false,
        });
    }

    const timelineFile = path.join(dir, 'export_timeline.json');
    fs.writeFileSync(timelineFile, JSON.stringify({
        version: 4,
        sequence: { width: 320, height: 180, fps: String(FPS) },
        // MỘT interval cho cả phim — đúng hình dạng của dự án phụ đề thật, và là lý do
        // cách chia theo số clip sẵn có không cắt được gì.
        intervals: [{ start: 0, end: seconds }],
        editingTracks: [{ id: 'track_text_1', type: 'text', order: 0, visible: true, muted: false, volume: 100 }],
        editingItems: [],
        assets: [],
        main_audio_volume: 100,
        overlays,
        settings: { resolution: 'sequence', width: 320, height: 180, fps: String(FPS), codec: 'h264', quality: 'small', audio_bitrate: '128k', render_fps: String(FPS) },
    }), 'utf8');
    return { source, timelineFile, overlays };
}

function main() {
    if (!fs.existsSync(SIDECAR)) {
        console.log('export_long_subtitles: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
        return;
    }
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const { source, timelineFile, overlays } = buildProject(TEST_DIR, VIDEO_SECONDS, SUB_COUNT);
    const output = path.join(TEST_DIR, 'final_cut.mp4');
    const started = Date.now();
    const r = run(SIDECAR, ['export-video', source, output, timelineFile, TEST_DIR, 'sequence', String(FPS)],
        { timeout: 1800000 });
    const elapsed = (Date.now() - started) / 1000;
    const log = `${r.stdout || ''}\n${r.stderr || ''}`;
    assert.strictEqual(r.status, 0, `xuất thất bại:\n${log}`);
    assert.ok(fs.existsSync(output), 'không có tệp xuất ra');

    // --- 0. phải THẬT SỰ chia batch, nếu không bài test này chẳng kiểm gì ---
    const batchLine = /Chia (\d+) lượt render theo thời gian/.exec(log);
    assert.ok(batchLine, `phải chia lượt render theo thời gian:\n${log}`);
    const batchCount = Number(batchLine[1]);
    assert.ok(batchCount >= 3, `phim ${VIDEO_SECONDS}s phải ra ít nhất 3 lượt, đang ${batchCount}`);
    console.log(`  ok  chia ${batchCount} lượt render (${SUB_COUNT} phụ đề, ${VIDEO_SECONDS}s) — ${elapsed.toFixed(1)}s`);

    // --- 1. thời lượng: cắt sai biên khung là trôi vài khung mỗi mối ghép ---
    const meta = probe(output, 'format=duration:stream=codec_type,nb_frames');
    const duration = Number(meta.format.duration);
    assert.ok(Math.abs(duration - VIDEO_SECONDS) < 0.15,
        `thời lượng phải ≈ ${VIDEO_SECONDS}s, đang ${duration.toFixed(3)}s (trôi ${((duration - VIDEO_SECONDS) * 1000).toFixed(0)}ms)`);
    const video = meta.streams.find((s) => s.codec_type === 'video');
    if (video?.nb_frames) {
        const frames = Number(video.nb_frames);
        assert.ok(Math.abs(frames - VIDEO_SECONDS * FPS) <= batchCount,
            `số khung phải ≈ ${VIDEO_SECONDS * FPS}, đang ${frames}`);
    }
    console.log(`  ok  thời lượng ${duration.toFixed(3)}s, không trôi qua ${batchCount} mối ghép`);

    // --- 2. phụ đề đúng chỗ, lấy mẫu TRẢI ĐỀU qua các mối ghép ---
    let checkedOn = 0;
    let checkedOff = 0;
    for (let k = 0; k < 24; k += 1) {
        const sub = overlays[Math.floor((k / 24) * SUB_COUNT)];
        // giữa khoảng hiện của phụ đề
        const onT = sub.timeline_start + SUB_DURATION / 2;
        const [r1, g1, b1] = pixelAt(output, onT, 157, 87);
        assert.ok(r1 > 120 && r1 > g1 + 60 && r1 > b1 + 60,
            `t=${onT.toFixed(2)}s phải thấy phụ đề, đang rgb(${r1},${g1},${b1}) — dời sai mốc giữa các batch?`);
        checkedOn += 1;
        // ngay TRƯỚC khi phụ đề xuất hiện: phải là nền đen
        const offT = sub.timeline_start - 0.35;
        if (offT > 0.2) {
            const [r2, g2, b2] = pixelAt(output, offT, 157, 87);
            assert.ok(r2 < 90, `t=${offT.toFixed(2)}s KHÔNG được có phụ đề, đang rgb(${r2},${g2},${b2}) — phụ đề bị kéo dài/lệch?`);
            checkedOff += 1;
        }
    }
    console.log(`  ok  phụ đề đúng mốc: ${checkedOn} điểm có, ${checkedOff} điểm không — trải đều cả phim`);

    // --- 3. tiếng liền mạch, không trôi theo mối ghép ---
    const audio = probe(output, 'stream=codec_type,duration');
    const audioStream = (audio.streams || []).find((s) => s.codec_type === 'audio');
    assert.ok(audioStream, 'bản xuất phải CÓ tiếng — chế độ VideoOnly mà quên -an thì tiếng sai nguồn');
    const audioDuration = Number(audioStream.duration || duration);
    assert.ok(Math.abs(audioDuration - VIDEO_SECONDS) < 0.15,
        `tiếng phải ≈ ${VIDEO_SECONDS}s, đang ${audioDuration.toFixed(3)}s — nối tiếng theo batch?`);
    assert.ok(Math.abs(audioDuration - duration) < 0.1,
        `tiếng (${audioDuration.toFixed(3)}s) phải khớp hình (${duration.toFixed(3)}s)`);
    console.log(`  ok  tiếng ${audioDuration.toFixed(3)}s — một lượt liền mạch, khớp hình`);

    // --- 4. phim NGẮN thì không chia ---
    const shortDir = path.join(TEST_DIR, 'ngan');
    fs.mkdirSync(shortDir, { recursive: true });
    const shortProject = buildProject(shortDir, 30, 20);
    const shortOut = path.join(shortDir, 'out.mp4');
    const sr = run(SIDECAR, ['export-video', shortProject.source, shortOut, shortProject.timelineFile,
        shortDir, 'sequence', String(FPS)], { timeout: 600000 });
    assert.strictEqual(sr.status, 0, `xuất phim ngắn thất bại:\n${sr.stdout}\n${sr.stderr}`);
    assert.ok(!/Chia \d+ lượt render/.test(`${sr.stdout}`),
        'phim 30s KHÔNG được chia batch — chia chỉ tổ tốn lượt spawn ffmpeg');
    console.log('  ok  phim ngắn vẫn chạy một lượt như cũ');

    /* --- 5. LỚP PHỦ VẮT NGANG CẢ PHIM VÀ CÓ HOẠT ẢNH -> KHÔNG ĐƯỢC CẮT ---
     * Đây là nhánh lùi: một watermark có hiệu ứng động phủ trọn phim thì không có mốc nào
     * cắt được an toàn (cắt đôi là nửa sau chạy lại hiệu ứng từ đầu). Bộ hoạch định phải
     * NHẬN RA và quay về một lượt — chậm, nhưng đúng. Im lặng cắt bừa mới là hỏng. */
    const animDir = path.join(TEST_DIR, 'hoat-anh');
    fs.mkdirSync(animDir, { recursive: true });
    const animProject = buildProject(animDir, 300, 12);
    const animTl = JSON.parse(fs.readFileSync(animProject.timelineFile, 'utf8'));
    animTl.overlays.push({
        ...animTl.overlays[0],
        index: 999,
        id: 'watermark',
        timeline_start: 0,
        duration: 300,
        // Hoạt ảnh trượt ngang -> biến thiên theo thời gian trên toàn bộ phim.
        anim_x_expr: '20*sin(LOCALT)',
        anim_y_expr: '0',
    });
    fs.writeFileSync(animProject.timelineFile, JSON.stringify(animTl), 'utf8');
    const animOut = path.join(animDir, 'out.mp4');
    const ar = run(SIDECAR, ['export-video', animProject.source, animOut, animProject.timelineFile,
        animDir, 'sequence', String(FPS)], { timeout: 900000 });
    assert.strictEqual(ar.status, 0, `xuất dự án có watermark hoạt ảnh thất bại:\n${ar.stdout}\n${ar.stderr}`);
    assert.ok(!/Chia \d+ lượt render/.test(`${ar.stdout}`),
        'lớp phủ hoạt ảnh phủ trọn phim thì KHÔNG được cắt — cắt đôi là nửa sau chạy lại hiệu ứng');
    const animMeta = probe(animOut, 'format=duration');
    assert.ok(Math.abs(Number(animMeta.format.duration) - 300) < 0.15, 'nhánh lùi vẫn phải ra đúng thời lượng');
    console.log('  ok  lớp phủ hoạt ảnh phủ trọn phim: nhận ra và lùi về một lượt, vẫn đúng');

    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    console.log('export_long_subtitles: PASS');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
