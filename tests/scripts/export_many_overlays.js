/* =====================================================================
 * XUẤT VIDEO VỚI RẤT NHIỀU LỚP PHỦ — TRẦN ĐỘ DÀI DÒNG LỆNH CỦA WINDOWS
 *
 * LỖI ĐÃ TRẢ GIÁ (2026-09-14, dự án thật 131 phụ đề tự động):
 *   toast "ffmpeg batch export failed", và stderr trong report chỉ có đúng một câu:
 *   "The command line is too long."
 *
 * Vì sao: `Run()` chạy lệnh bằng `std::system()`, mà trên Windows nó đi qua `cmd.exe /c`
 * — TRẦN 8.191 KÝ TỰ. Mỗi lớp phủ ảnh là một `-loop 1 -t <d> -i "<đường dẫn ~98 ký tự>"`,
 * và khi dự án CÓ lớp phủ thì export không chia batch (xem CommandExportVideo) nên tất cả
 * nằm trên MỘT dòng lệnh: 131 × ~125 ≈ 16.400 ký tự. Ngưỡng gãy rơi vào ~65 lớp phủ, tức
 * một video chừng 8 phút có phụ đề tự động là đã chạm.
 *
 * Hai thứ đẩy trần lên, bài test này canh cả hai:
 *   1. bỏ cmd.exe, gọi CreateProcessW  -> 8.191 thành 32.766;
 *   2. chạy ffmpeg với cwd = temp và truyền đường dẫn lớp phủ TƯƠNG ĐỐI -> mỗi lớp phủ
 *      ngắn đi ~64 ký tự.
 *
 * ĐO BẰNG CÁCH XUẤT THẬT, không phải đếm ký tự: chỉ có chạy thật mới chứng minh được cả
 * hai thay đổi đó không làm hỏng chính bản xuất (đường dẫn tương đối mà sai cwd thì ffmpeg
 * báo "No such file", chứ không âm thầm bỏ lớp phủ).
 *
 * Chạy: npm run test:export-many-overlays
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_many_overlays');
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build',
    process.platform === 'win32' ? 'core_process.exe' : 'core_process');

/* SỐ LỚP PHỦ. 131 là đúng con số của dự án đã làm lộ lỗi; 8.191 / 125 ≈ 65 nên con số này
 * nằm SÂU bên kia ngưỡng gãy cũ — bài test thất bại chắc chắn nếu ai đó đưa cmd.exe trở lại. */
const OVERLAY_COUNT = 131;

function run(command, args, options = {}) {
    return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
}

function main() {
    if (!fs.existsSync(SIDECAR)) {
        console.log('export_many_overlays: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
        return;
    }
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    /* Ảnh lớp phủ đặt trong một thư mục con của TEST_DIR, đúng như `generated_text/` thật:
       phần tiền tố lặp lại chính là thứ làm phình dòng lệnh. */
    const genDir = path.join(TEST_DIR, 'generated_text');
    fs.mkdirSync(genDir, { recursive: true });

    // --- nguồn: 12 giây, đủ để 131 lớp phủ trải ra mà mỗi cái vẫn có thời lượng thật ---
    const source = path.join(TEST_DIR, 'temp_input.mp4');
    let r = run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=12',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
    assert.strictEqual(r.status, 0, `không dựng được video nguồn:\n${r.stderr}`);

    /* Tên tệp dài như thật (`item_text_<id>_<n>.png`): dòng lệnh phình lên vì ĐỘ DÀI ĐƯỜNG
       DẪN, nên đặt tên ngắn ở test là tự làm nhẹ bài toán mình đang đo. */
    const overlays = [];
    for (let i = 0; i < OVERLAY_COUNT; i += 1) {
        const name = `item_text_mu0pma${String(i).padStart(3, '0')}_${i}.png`;
        const file = path.join(genDir, name);
        r = run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
            '-i', `color=c=red@0.8:size=60x24,format=rgba`, '-frames:v', '1', file]);
        assert.strictEqual(r.status, 0, `không dựng được ảnh lớp phủ:\n${r.stderr}`);
        overlays.push({
            index: i,
            id: `item_text_${i}`,
            type: 'media',
            asset_type: 'text_image',
            asset_path: file,
            timeline_start: Number(((i / OVERLAY_COUNT) * 11).toFixed(3)),
            duration: 0.6,
            source_start: 0,
            position_x: 0,
            position_y: 40,
            scale: 100,
            opacity: 100,
            track_id: 'track_text_1',
            track_order: 0,
            muted: true,
            volume: 0,
            has_audio: false,
        });
    }

    const timelineFile = path.join(TEST_DIR, 'export_timeline.json');
    fs.writeFileSync(timelineFile, JSON.stringify({
        version: 4,
        sequence: { width: 320, height: 180, fps: '30' },
        intervals: [{ start: 0, end: 12 }],
        editingTracks: [{ id: 'track_text_1', type: 'text', order: 0, visible: true, muted: false, volume: 100 }],
        editingItems: [],
        assets: [],
        main_audio_volume: 100,
        overlays,
        settings: { resolution: 'sequence', width: 320, height: 180, fps: 'source', codec: 'h264', quality: 'high', audio_bitrate: '128k', render_fps: '30' },
    }), 'utf8');

    const output = path.join(TEST_DIR, 'final_cut.mp4');
    r = run(SIDECAR, ['export-video', source, output, timelineFile, TEST_DIR, 'sequence', 'source'], { timeout: 600000 });
    const log = `${r.stdout || ''}\n${r.stderr || ''}`;

    /* Chính là thông báo của cmd.exe. Bắt riêng nó để khi hỏng lại thì lỗi nói đúng nguyên
       nhân, thay vì chỉ "export thất bại". */
    assert.ok(!/command line is too long/i.test(log),
        `dòng lệnh vẫn vượt trần — cmd.exe đã quay lại?\n${log}`);
    assert.ok(!/vượt trần/.test(log), `dòng lệnh vượt cả trần của CreateProcess:\n${log}`);
    assert.strictEqual(r.status, 0, `export ${OVERLAY_COUNT} lớp phủ thất bại:\n${log}`);
    assert.ok(fs.existsSync(output) && fs.statSync(output).size > 1024, 'không có tệp xuất ra');
    console.log(`  ok  xuất được video có ${OVERLAY_COUNT} lớp phủ (ngưỡng gãy cũ ~65)`);

    /* LỚP PHỦ PHẢI THẬT SỰ CÓ TRONG HÌNH. Đường dẫn tương đối mà sai cwd thì ffmpeg báo lỗi,
       nhưng một thay đổi tương lai có thể làm nó âm thầm bỏ lớp phủ — lúc đó bản xuất vẫn
       "thành công" mà thiếu toàn bộ phụ đề. Lấy mẫu điểm ảnh để chốt. */
    const pixel = spawnSync('ffmpeg', ['-v', 'error', '-ss', '5.5', '-i', output,
        '-frames:v', '1', '-vf', 'crop=8:8:156:120,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { cwd: ROOT, encoding: 'buffer', maxBuffer: 1024 * 1024 });
    assert.strictEqual(pixel.status, 0, pixel.stderr?.toString('utf8'));
    const [red, green, blue] = [...pixel.stdout.slice(0, 3)];
    assert.ok(red > green + 40 && red > blue + 40,
        `giữa khung phải thấy lớp phủ đỏ, đang là rgb(${red},${green},${blue}) — lớp phủ bị bỏ im lặng?`);
    console.log(`  ok  lớp phủ có mặt trong bản xuất: rgb(${red},${green},${blue})`);

    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    console.log('export_many_overlays: PASS');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
