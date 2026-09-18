/* ĐƯỜNG DẪN CÓ DẤU — sidecar C++ phải làm việc được dưới hồ sơ người dùng tiếng Việt.
 *
 * VÌ SAO CÓ TEST NÀY. Bản 1.1.9 chết ngay ở thao tác đầu tiên trên máy có tên người dùng
 * "Hòa Nguyễn": mọi lệnh sidecar đều báo
 *     create_directories: The filename, directory name, or volume label syntax is incorrect.:
 *     "C:\Users\Hòa Nguy?n\AppData\Local\CrabbyCut\temp_uploads"
 * Nguyên nhân: `main(int argc, char** argv)` nhận tham số ĐÃ bị Windows hạ xuống trang mã
 * ANSI của máy, ký tự nào không có trong trang mã đó thành `?` — mà `?` là ký tự cấm trong
 * tên tệp. Xem khối "ĐƯỜNG DẪN CÓ DẤU" trong native/sidecar/core_process.cpp.
 *
 * Lỗi này KHÔNG bao giờ lộ ra trên máy phát triển có tên người dùng thuần ASCII, và không
 * một test nào khác chạm tới nó vì tất cả đều chạy dưới thư mục dự án. Nên phép kiểm phải
 * cố ý dựng một thư mục mang dấu — và dấu phải là chữ NGOÀI trang mã 1252 (ễ, ộ), chứ "ò"
 * thì 1252 có sẵn, đi qua argv vẫn nguyên vẹn và test hoá ra vô dụng.
 *
 * Chạy sidecar y như backend chạy: spawn với MẢNG tham số (không qua shell).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SIDECAR = path.join(PROJECT_ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
// "Hồ sơ Nguyễn" — ồ (U+1ED3) và ễ (U+1EC5) đều NGOÀI CP1252.
const WORK_ROOT = path.join(PROJECT_ROOT, 'test_temp', 'H\u1ED3 s\u01A1 Nguy\u1EC5n', 'CrabbyCut');
const TEMP_DIR = path.join(WORK_ROOT, 'temp_uploads');
const SOURCE = path.join(WORK_ROOT, 'ngu\u1ED3n c\u00F3 d\u1EA5u.mp4');

function ffmpegAvailable() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function runSidecar(args) {
  const result = spawnSync(SIDECAR, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const lastEvent = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  return { status: result.status, lastEvent, stderr: String(result.stderr || '').trim() };
}

function check(label, args, expectedFile) {
  const { status, lastEvent, stderr } = runSidecar(args);
  assert.strictEqual(status, 0, `${label} thất bại (exit ${status})\n  ${lastEvent}\n  ${stderr}`);
  assert.ok(fs.existsSync(expectedFile), `${label}: không thấy ${expectedFile}`);
  console.log(`  ok  ${label}`);
}

function main() {
  assert.ok(fs.existsSync(SIDECAR), `Chưa build sidecar: ${SIDECAR}. Chạy npm run build:sidecar.`);
  if (!ffmpegAvailable()) {
    console.log('sidecar unicode path: BỎ QUA (không có ffmpeg trên PATH)');
    return;
  }

  fs.rmSync(path.dirname(WORK_ROOT), { recursive: true, force: true });
  fs.mkdirSync(WORK_ROOT, { recursive: true });

  /* Nguồn cũng đặt tên có dấu: đường dẫn ĐẦU VÀO đi qua đúng một lối với đường dẫn đầu ra,
   * hỏng chuyển mã thì ffmpeg chỉ báo "No such file or directory" — khác lỗi, cùng gốc. */
  const made = spawnSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SOURCE,
  ], { stdio: 'inherit' });
  assert.strictEqual(made.status, 0, 'không dựng được video nguồn cho test');

  // Đúng bốn lệnh mà một lần "thêm video vào Timeline" gọi tới.
  check('concat      -> temp_uploads/temp_input.mp4',
    ['concat', path.join(TEMP_DIR, 'temp_input.mp4'), SOURCE, SOURCE],
    path.join(TEMP_DIR, 'temp_input.mp4'));
  check('thumbnail   -> temp_uploads/thumbnails/',
    ['thumbnail', SOURCE, path.join(TEMP_DIR, 'thumbnails', 'thumb.jpg'), '1'],
    path.join(TEMP_DIR, 'thumbnails', 'thumb.jpg'));
  check('audio-peaks -> temp_uploads/peaks.pk',
    ['audio-peaks', SOURCE, path.join(TEMP_DIR, 'peaks.pk')],
    path.join(TEMP_DIR, 'peaks.pk'));
  check('preview-proxy -> temp_uploads/preview_proxy.mp4',
    ['preview-proxy', SOURCE, path.join(TEMP_DIR, 'preview_proxy.mp4')],
    path.join(TEMP_DIR, 'preview_proxy.mp4'));

  /* Đường dẫn quay VỀ cũng phải còn nguyên dấu: sidecar in kết quả ra stdout dạng JSON, và
   * backend dùng chuỗi đó để dựng URL. Chuyển mã sai một chiều thôi là đủ hỏng. */
  const peaks = runSidecar(['audio-peaks', SOURCE, path.join(TEMP_DIR, 'peaks2.pk')]);
  assert.ok(peaks.lastEvent.includes('Nguy\u1EC5n'),
    `stdout của sidecar mất dấu tiếng Việt: ${peaks.lastEvent}`);
  console.log('  ok  đường dẫn trong JSON trả về còn nguyên dấu');

  fs.rmSync(path.dirname(WORK_ROOT), { recursive: true, force: true });
  console.log('sidecar unicode path ok');
}

main();
