/* Xuất khi block lane phụ DÀI HƠN video lane chính (như CapCut) — hai đường:
 *   1. Lane chính trống (`blank_base=1`): backend dựng nền đen đúng độ dài timeline.
 *   2. Lane chính có video ngắn hơn overlay (`tail_pad_seconds`): backend nối đuôi đen vào
 *      nguồn, overlay không bị cắt theo lane chính. Thử cả đường nhanh (H.264 -> concat copy)
 *      lẫn đường mã hoá lại (nguồn MPEG-4 Part 2).
 * Overlay là một block hình khối trắng (PNG dựng sẵn) phủ giữa khung. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8127';
const projectRoot = path.resolve(__dirname, '..', '..');
// Thư mục tạm RIÊNG — bắt buộc trước khi require server (xem export_smoke.js).
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR
  || path.join(projectRoot, 'test_temp', 'export_overlay_tail');
const tempDir = path.resolve(process.env.CRAB_TEMP_DIR);
const { start } = require('../../backend/server');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, `${command} failed\n${result.stderr || result.stdout}`);
  return result;
}

function durationOf(filePath) {
  return Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath]).stdout.trim());
}

function rgbAt(filePath, seconds, x, y) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', filePath,
    '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { cwd: projectRoot, encoding: 'buffer', maxBuffer: 1024 * 1024 });
  assert.strictEqual(result.status, 0, result.stderr?.toString('utf8'));
  return [...result.stdout.slice(0, 3)];
}

const isBlack = (p) => p[0] < 16 && p[1] < 16 && p[2] < 16;
const isWhite = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;
const isRed = (p) => p[0] > 150 && p[1] < 80 && p[2] < 80;

const SEQ = { width: 320, height: 180, preset: 'custom', source_width: 320, source_height: 180, source_fps: '24' };

function shapePngDataUrl() {
  const png = path.join(tempDir, 'shape.png');
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=80x40', '-frames:v', '1', png]);
  return `data:image/png;base64,${fs.readFileSync(png).toString('base64')}`;
}

function editingJson(shapeUrl, start, duration) {
  return JSON.stringify({
    tracks: [
      { id: 'track_shape_1', type: 'shape', order: 0, visible: true },
      { id: 'track_main', type: 'main', order: 1, visible: true, volume: 100 },
    ],
    assets: [],
    items: [{
      id: 'item_shape_1', type: 'shape', track_id: 'track_shape_1',
      timeline_start: start, duration,
      transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
      style: {}, rendered_shape_png: shapeUrl,
    }],
  });
}

async function exportWith(baseUrl, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('export_settings', JSON.stringify({
    resolution: 'sequence', sequence: SEQ, fps: '24', codec: 'h264', quality: 'small', audio_bitrate: '128k',
  }));
  form.append('sequence_settings', JSON.stringify(SEQ));
  const response = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(await response.text());
  await response.arrayBuffer();
  const reportPath = response.headers.get('x-project-report-path');
  if (reportPath) fs.rmSync(reportPath, { force: true });
  const outputPath = path.join(tempDir, 'final_cut.mp4');
  assert.ok(fs.existsSync(outputPath), 'no output file');
  return outputPath;
}

async function main() {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  const server = start();
  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const shapeUrl = shapePngDataUrl();
  const source = path.join(tempDir, 'temp_input.mp4');
  try {
    // 1. Lane chính trống: nền đen 4s, hình khối từ 1s tới 4s.
    let out = await exportWith(baseUrl, {
      timeline_json: JSON.stringify([{ start: 0, end: 4 }]),
      blank_base: '1',
      editing_json: editingJson(shapeUrl, 1, 3),
    });
    let dur = durationOf(out);
    assert.ok(dur > 3.7 && dur < 4.4, `blank base: unexpected duration ${dur}`);
    assert.ok(isBlack(rgbAt(out, 0.5, 160, 90)), 'blank base: frame before overlay must be black');
    assert.ok(isWhite(rgbAt(out, 2.5, 160, 90)), 'blank base: overlay missing');
    assert.ok(isBlack(rgbAt(out, 2.5, 10, 10)), 'blank base: border must be black');

    // 2 + 3. Video đỏ 2s trên lane chính, hình khối kéo tới 5s -> đuôi đen 3s.
    const sources = [
      ['h264 fast path', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']],
      ['mpeg4 re-encode', ['-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'aac']],
    ];
    for (const [label, codecArgs] of sources) {
      run('ffmpeg', ['-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=2:r=24',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-map', '0:v', '-map', '1:a', ...codecArgs, '-shortest', source]);
      out = await exportWith(baseUrl, {
        timeline_json: JSON.stringify([{ start: 0, end: 2 }]),
        tail_pad_seconds: '3',
        editing_json: editingJson(shapeUrl, 1, 4),
      });
      dur = durationOf(out);
      assert.ok(dur > 4.7 && dur < 5.4, `${label}: unexpected duration ${dur}`);
      assert.ok(isRed(rgbAt(out, 0.5, 10, 10)), `${label}: main video missing at 0.5s`);
      assert.ok(isBlack(rgbAt(out, 3.5, 10, 10)), `${label}: tail must be black`);
      assert.ok(isWhite(rgbAt(out, 4.5, 160, 90)), `${label}: overlay cut off at main-lane end`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('export overlay tail ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
