const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8125';

const projectRoot = path.resolve(__dirname, '..', '..');
/* THƯ MỤC TẠM RIÊNG CHO TEST — BẮT BUỘC, và phải đặt TRƯỚC khi require server.
 * main() bên dưới mở đầu bằng `fs.rmSync(tempDir, {recursive:true})`. Trỏ vào thư mục
 * tạm mặc định là xoá sạch dữ liệu của DỰ ÁN NGƯỜI DÙNG ĐANG MỞ (temp_input.mp4,
 * preview_proxy.mp4, file nguồn đã nhập, cache landmark). Đã xảy ra thật. */
// KHÔNG đặt tên bắt đầu bằng dấu chấm: `res.download` đi qua `send`, mà `send` trả 404
// cho mọi đường dẫn có đoạn thư mục dạng dotfile.
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR
  || path.join(projectRoot, 'test_temp', 'export_smoke');
const tempDir = path.resolve(process.env.CRAB_TEMP_DIR);
const { start } = require('../../backend/server');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: options.encoding || 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.strictEqual(result.status, 0, `${command} failed\n${result.stderr || result.stdout}`);
  return result;
}

function ffprobeJson(filePath) {
  const result = run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate',
    '-of', 'json',
    filePath,
  ]);
  return JSON.parse(result.stdout);
}

function sampleRgb(filePath, seconds) {
  const result = spawnSync('ffmpeg', [
    '-v', 'error',
    '-ss', String(seconds),
    '-i', filePath,
    '-frames:v', '1',
    '-vf', 'scale=1:1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-',
  ], {
    cwd: projectRoot,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024,
  });
  assert.strictEqual(result.status, 0, result.stderr?.toString('utf8'));
  return [...result.stdout.slice(0, 3)];
}

function sampleRgbAt(filePath, seconds, x, y) {
  const result = spawnSync('ffmpeg', [
    '-v', 'error',
    '-ss', String(seconds),
    '-i', filePath,
    '-frames:v', '1',
    '-vf', `crop=2:2:${x}:${y},scale=1:1`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-',
  ], {
    cwd: projectRoot,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024,
  });
  assert.strictEqual(result.status, 0, result.stderr?.toString('utf8'));
  return [...result.stdout.slice(0, 3)];
}

function assertMostlyBlack(pixel, label) {
  assert.ok(pixel[0] < 12 && pixel[1] < 12 && pixel[2] < 12, `${label} is not black: ${pixel}`);
}

async function main() {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  const reportsDir = path.join(projectRoot, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportsBefore = new Set(fs.readdirSync(reportsDir));
  const sourcePath = path.join(tempDir, 'temp_input.mp4');
  run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=2:r=30',
    '-f', 'lavfi', '-i', 'color=c=green:s=160x90:d=2:r=30',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=2:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a',
    '-shortest',
    '-pix_fmt', 'yuv420p',
    sourcePath,
  ]);

  const server = start();
  const port = Number(process.env.BACKEND_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  await new Promise((resolve) => setTimeout(resolve, 300));

  try {
    const form = new FormData();
    form.append('timeline_json', JSON.stringify([
      {
        start: 4,
        end: 6,
        text: 'blue first',
        script_index: 2,
        sub_segments: [{ start: 2, end: 4, text: 'green must not be exported' }],
      },
      {
        start: 0,
        end: 2,
        text: 'red second',
        script_index: 0,
        transform: {
          position_x: 40,
          position_y: 0,
          scale: 50,
          rotation: 0,
          opacity: 100,
        },
      },
    ]));
    form.append('export_settings', JSON.stringify({
      resolution: 'sequence',
      sequence: {
        width: 320,
        height: 180,
        preset: 'custom',
        source_width: 160,
        source_height: 90,
        source_fps: '24',
      },
      fps: '24',
      codec: 'h264',
      quality: 'small',
      audio_bitrate: '128k',
    }));
    form.append('sequence_settings', JSON.stringify({
      width: 320,
      height: 180,
      preset: 'custom',
      source_width: 160,
      source_height: 90,
      source_fps: '24',
    }));
    form.append('client_started_at_ms', String(Date.now()));

    const response = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: form });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    await response.arrayBuffer();

    const outputPath = path.join(tempDir, 'final_cut.mp4');
    assert.ok(fs.existsSync(outputPath));
    const info = ffprobeJson(outputPath);
    const video = info.streams.find((stream) => stream.codec_type === 'video');
    assert.strictEqual(video.width, 320);
    assert.strictEqual(video.height, 180);
    assert.strictEqual(video.r_frame_rate, '24/1');
    const duration = Number(info.format.duration);
    assert.ok(duration > 3.8 && duration < 4.4, `unexpected duration ${duration}`);

    const first = sampleRgb(outputPath, 0.5);
    const second = sampleRgb(outputPath, 2.5);
    assert.ok(first[2] > first[0] && first[2] > first[1], `first clip is not blue: ${first}`);
    assert.ok(second[0] > second[1] && second[0] > second[2], `second clip average is not red: ${second}`);
    assert.ok(sampleRgbAt(outputPath, 0.5, 160, 90)[2] > 180, 'first clip center is not blue');
    assertMostlyBlack(sampleRgbAt(outputPath, 0.5, 12, 12), 'sequence border');
    assert.ok(sampleRgbAt(outputPath, 2.5, 200, 90)[0] > 180, 'transformed second clip target is not red');
    assertMostlyBlack(sampleRgbAt(outputPath, 2.5, 100, 90), 'transformed second clip outside area');

    const reportPath = response.headers.get('x-project-report-path');
    const reportsAfterExport = new Set(fs.readdirSync(reportsDir));
    const resetResponse = await fetch(`${baseUrl}/api/reset-project`, { method: 'POST' });
    assert.strictEqual(resetResponse.ok, true);
    await resetResponse.json();
    const reportsAfterReset = new Set(fs.readdirSync(reportsDir));
    assert.deepStrictEqual([...reportsAfterReset].sort(), [...reportsAfterExport].sort());
    if (reportPath) fs.rmSync(reportPath, { force: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(path.join(tempDir, 'final_cut.mp4'), { force: true });
    fs.rmSync(path.join(tempDir, 'temp_input.mp4'), { force: true });
    fs.rmSync(path.join(tempDir, 'export_timeline.json'), { force: true });
    for (const name of fs.readdirSync(reportsDir)) {
      if (!reportsBefore.has(name) && /^report_project_\d{8}_\d{6}\.txt$/.test(name)) {
        fs.rmSync(path.join(reportsDir, name), { force: true });
      }
    }
  }

  console.log('export smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
