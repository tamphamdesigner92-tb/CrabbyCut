/* TIMEBASE CỦA SEQUENCE PHẢI THẮNG NHỊP KHUNG CỦA NGUỒN.
 *
 * LỖI ĐƯỢC CHỐT Ở ĐÂY (người dùng báo 2026-09-09, dự án `Test_lech fps_ver 2.crab`):
 *   1. Thêm DJI 1728x3072@59.94  -> app tự đặt sequence theo nguồn đó.
 *   2. Thêm một clip ngang 50fps -> `source_fps` bị ghi thành '50'.
 *   3. Người dùng chọn lại 59.94 trên thanh điều khiển preview.
 *   4. Xuất ra: nhận được file 50 fps.
 * Nguyên nhân ở tầng này: `render_fps` chỉ đọc `sequence.source_fps` và KHÔNG hề đọc
 * `sequence.fps` — con số người dùng chọn không có đường nào tới ffmpeg.
 *
 * Test đi qua ĐÚNG endpoint /api/export-video và đọc `r_frame_rate` của file thật, vì đây
 * là loại lỗi mà mọi tầng đều "chạy đúng": không có ngoại lệ, không có log, chỉ có một con
 * số sai trong file cuối. Ba ca dưới đây chốt cả THỨ TỰ ƯU TIÊN, không chỉ ca đã lỗi —
 * sửa cho ca 1 chạy mà làm sập bậc dự phòng thì cũng là hồi quy.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8137';

const projectRoot = path.resolve(__dirname, '..', '..');
/* THƯ MỤC TẠM RIÊNG CHO TEST — BẮT BUỘC, và phải đặt TRƯỚC khi require server: main() mở
 * đầu bằng rmSync, trỏ vào thư mục tạm mặc định là xoá sạch dự án người dùng đang mở. */
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR
  || path.join(projectRoot, 'test_temp', 'export_sequence_fps');
const tempDir = path.resolve(process.env.CRAB_TEMP_DIR);
const { start } = require('../../backend/server');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.strictEqual(result.status, 0, `${command} failed\n${result.stderr || result.stdout}`);
  return result;
}

function videoFrameRate(filePath) {
  const result = run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate',
    '-of', 'csv=p=0',
    filePath,
  ]);
  return result.stdout.trim();
}

async function exportWith(baseUrl, { exportFps, sequenceFps, sourceFps }) {
  const sequence = {
    width: 320,
    height: 180,
    preset: 'custom',
    source_width: 160,
    source_height: 90,
    source_fps: sourceFps,
    fps: sequenceFps,
  };
  const form = new FormData();
  form.append('timeline_json', JSON.stringify([{ start: 0, end: 2, text: 'one', script_index: 0 }]));
  form.append('export_settings', JSON.stringify({
    resolution: 'sequence',
    sequence,
    fps: exportFps,
    codec: 'h264',
    quality: 'small',
    audio_bitrate: '128k',
  }));
  form.append('sequence_settings', JSON.stringify(sequence));
  form.append('client_started_at_ms', String(Date.now()));

  const response = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(await response.text());
  await response.arrayBuffer();
  const outputPath = path.join(tempDir, 'final_cut.mp4');
  assert.ok(fs.existsSync(outputPath), 'không thấy file xuất ra');
  const rate = videoFrameRate(outputPath);
  fs.rmSync(outputPath, { force: true });
  return { rate, reportPath: response.headers.get('x-project-report-path') };
}

async function main() {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  const reportsDir = path.join(projectRoot, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportsBefore = new Set(fs.readdirSync(reportsDir));

  // Nguồn 30fps: cố ý KHÁC cả ba con số được kiểm, để không ca nào đúng chỉ vì trùng nguồn.
  run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=3:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-map', '0:v', '-map', '1:a', '-shortest',
    '-pix_fmt', 'yuv420p',
    path.join(tempDir, 'temp_input.mp4'),
  ]);

  const server = start();
  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  await new Promise((resolve) => setTimeout(resolve, 300));

  const reports = [];
  try {
    /* CA 1 — chính ca người dùng báo. Hộp thoại Xuất để "Theo Sequence", timebase sequence
     * là 59.94 và `source_fps` là 50 (đã bị clip thứ hai ghi đè). Phải ra 59.94, KHÔNG phải
     * 50. Và phải là PHÂN SỐ ĐÚNG 60000/1001, không phải timebase 5994/100 làm tròn. */
    const chosen = await exportWith(baseUrl, { exportFps: 'source', sequenceFps: '59.94', sourceFps: '50' });
    reports.push(chosen.reportPath);
    assert.strictEqual(chosen.rate, '60000/1001',
      `sequence 59.94 + source_fps 50 phải xuất 60000/1001, nhận ${chosen.rate}`);
    console.log('  ok  lựa chọn của người dùng (59.94) thắng source_fps (50) -> 60000/1001');

    /* CA 2 — BẬC DỰ PHÒNG vẫn phải còn: chưa chọn gì (fps = '') thì theo nhịp nguồn. */
    const auto = await exportWith(baseUrl, { exportFps: 'source', sequenceFps: '', sourceFps: '50' });
    reports.push(auto.reportPath);
    assert.strictEqual(auto.rate, '50/1',
      `sequence fps rỗng thì phải theo source_fps 50, nhận ${auto.rate}`);
    console.log('  ok  sequence fps rỗng -> vẫn rơi về source_fps (50)');

    /* CA 3 — chọn tay TRONG hộp thoại Xuất thì thắng cả timebase sequence (giống Premiere:
     * ô Frame Rate của Export Settings lấy sequence làm mặc định nhưng ghi đè được). */
    const override = await exportWith(baseUrl, { exportFps: '25', sequenceFps: '59.94', sourceFps: '50' });
    reports.push(override.reportPath);
    assert.strictEqual(override.rate, '25/1',
      `chọn tay 25 fps trong hộp thoại Xuất phải thắng, nhận ${override.rate}`);
    console.log('  ok  chọn tay trong hộp thoại Xuất (25) thắng timebase sequence (59.94)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const name of ['final_cut.mp4', 'temp_input.mp4', 'export_timeline.json']) {
      fs.rmSync(path.join(tempDir, name), { force: true });
    }
    for (const reportPath of reports) {
      if (reportPath) fs.rmSync(reportPath, { force: true });
    }
    for (const name of fs.readdirSync(reportsDir)) {
      if (!reportsBefore.has(name) && /^report_project_\d{8}_\d{6}\.txt$/.test(name)) {
        fs.rmSync(path.join(reportsDir, name), { force: true });
      }
    }
  }

  console.log('export sequence fps ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
