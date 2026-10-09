/**
 * GHI BẢN XUẤT THẲNG RA CHỖ NGƯỜI DÙNG CHỌN — mục 1.16 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 * (người dùng chốt 2026-09-29: hỏi chỗ lưu TRƯỚC khi xuất, như Premiere).
 * Chạy: npm run test:export-output-path
 *
 * Main process ký đường dẫn chọn trong hộp thoại lưu gốc bằng HMAC (khoá phiên, truyền cho backend
 * qua CRAB_EXPORT_OUTPUT_SECRET). Test chốt:
 *   1. Đường dẫn có chữ ký đúng (thư mục tên tiếng Việt, ĐÈ một tệp cũ): server trả JSON, tệp ra
 *      đúng chỗ, đủ thời lượng, không còn tệp tạm `.exporting`, không có final_cut.mp4 trong temp.
 *   2. Chữ ký giả -> 400, không ghi gì: HTTP API không kiểm nguồn gọi, thiếu chốt này là mọi trang
 *      web đang mở trên máy ghi được tệp vào chỗ bất kỳ.
 *   3. Đúng chữ ký nhưng sai đuôi (codec h264 mà .mov) -> 400.
 *   4. Không gửi đường dẫn -> đường tải về cũ (bench:export, trình duyệt, backend ngoài).
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8126';
const projectRoot = path.resolve(__dirname, '..', '..');
// Thư mục tạm riêng, đặt TRƯỚC khi require server (xem export_smoke.js). Không bắt đầu bằng dấu chấm.
process.env.CRAB_TEMP_DIR = path.join(projectRoot, 'test_temp', 'export_output_path');
const tempDir = path.resolve(process.env.CRAB_TEMP_DIR);
const SECRET = crypto.randomBytes(16).toString('hex');
process.env.CRAB_EXPORT_OUTPUT_SECRET = SECRET;
const { start } = require('../../backend/server');

const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('hex');

function run(command, args) {
  const r = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `${command} failed\n${r.stderr || r.stdout}`);
  return r;
}

function durationOf(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(String(r.stdout).trim());
}

function exportForm(extra = {}) {
  const form = new FormData();
  form.append('timeline_json', JSON.stringify([{ start: 0, end: 2, text: 'a', script_index: 0 }]));
  const sequence = { width: 320, height: 180, preset: 'custom', source_width: 160, source_height: 90, source_fps: '24' };
  form.append('export_settings', JSON.stringify({ resolution: 'sequence', sequence, fps: '24', codec: 'h264', quality: 'small', audio_bitrate: '128k' }));
  form.append('sequence_settings', JSON.stringify(sequence));
  form.append('client_started_at_ms', String(Date.now()));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

async function main() {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=2:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-pix_fmt', 'yuv420p',
    path.join(tempDir, 'temp_input.mp4')]);
  const outDir = path.join(tempDir, 'đích xuất');
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'Bản xuất.mp4');
  fs.writeFileSync(target, 'tệp cũ sẽ bị ghi đè');

  const server = start();
  const baseUrl = `http://127.0.0.1:${process.env.BACKEND_PORT}`;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reports = [];
  try {
    // 1. Chữ ký đúng -> ghi thẳng ra đích.
    let res = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: exportForm({ output_path: target, output_ticket: sign(target) }) });
    assert.ok(res.ok, `xuất thất bại: ${await res.clone().text()}`);
    assert.ok((res.headers.get('content-type') || '').includes('application/json'), 'phải trả JSON, không trả cả tệp');
    const body = await res.json();
    reports.push(res.headers.get('x-project-report-path'));
    assert.strictEqual(body.path, target);
    const d = durationOf(target);
    assert.ok(d > 1.8 && d < 2.3, `tệp xuất dài ${d}s, kỳ vọng ~2s (tệp cũ phải bị thay)`);
    assert.deepStrictEqual(fs.readdirSync(outDir), ['Bản xuất.mp4'], 'không được còn tệp tạm .exporting cạnh tệp đích');
    assert.ok(!fs.existsSync(path.join(tempDir, 'final_cut.mp4')), 'không được ghi thêm một bản vào thư mục tạm');
    console.log('  ok  chữ ký đúng: ghi thẳng ra đích (thư mục tiếng Việt, đè tệp cũ), trả JSON');

    // 2. Chữ ký giả -> 400, không ghi.
    const forged = path.join(outDir, 'giả mạo.mp4');
    res = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: exportForm({ output_path: forged, output_ticket: sign(target) }) });
    assert.strictEqual(res.status, 400, `chữ ký giả phải bị từ chối, được ${res.status}`);
    await res.text();
    assert.ok(!fs.existsSync(forged) && !fs.existsSync(forged.replace(/\.mp4$/, '.exporting.mp4')), 'chữ ký giả không được ghi gì');
    console.log('  ok  chữ ký giả: 400, không ghi tệp nào');

    // 3. Sai đuôi so với codec -> 400.
    const wrongExt = path.join(outDir, 'sai đuôi.mov');
    res = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: exportForm({ output_path: wrongExt, output_ticket: sign(wrongExt) }) });
    assert.strictEqual(res.status, 400, `sai đuôi phải bị từ chối, được ${res.status}`);
    await res.text();
    console.log('  ok  sai đuôi (.mov cho h264): 400');

    // 4. Không có đường dẫn -> đường tải về cũ.
    res = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: exportForm() });
    assert.ok(res.ok);
    assert.ok(!(res.headers.get('content-type') || '').includes('application/json'), 'không có đường dẫn thì vẫn trả tệp như cũ');
    const bytes = Buffer.from(await res.arrayBuffer());
    reports.push(res.headers.get('x-project-report-path'));
    assert.ok(bytes.length > 1000 && fs.existsSync(path.join(tempDir, 'final_cut.mp4')));
    console.log('  ok  không có đường dẫn: tải về như cũ');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    reports.filter(Boolean).forEach((p) => fs.rmSync(p, { force: true }));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('export output path ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
