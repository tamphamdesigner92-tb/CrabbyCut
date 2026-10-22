/**
 * XUẤT GIF — Codec "GIF (ảnh động)" của hộp Xuất (theo app Convert2GIF). Chạy: npm run test:export-gif
 *
 * Gọi /api/export-video thật (backend + sidecar render MP4 tạm + khâu 2-pass palette), chốt:
 *   1. GIF thường: đúng container GIF, đúng chiều rộng chọn, fps GIF, dài đúng timeline (2 đoạn cắt =
 *      2,0 s), không có luồng tiếng, ghi thẳng ra đường dẫn đã ký, không để lại `.exporting` hay MP4 tạm.
 *   2. "Theo kích thước video" (width 0) giữ cỡ khung xuất; Boomerang dài gấp đôi; số màu <= max_colors.
 *   3. GIF + Audio: tệp .mp3 cùng tên nằm cạnh GIF.
 *   4. Từ chối: Codec GIF mà đường dẫn đuôi .mp4 -> 400.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8133';
const projectRoot = path.resolve(__dirname, '..', '..');
process.env.CRAB_TEMP_DIR = path.join(projectRoot, 'test_temp', 'export_gif');
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

function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'format=duration,format_name:stream=codec_type,codec_name,width,height,nb_read_frames', '-of', 'json', file]);
  const j = JSON.parse(r.stdout);
  return { duration: Number(j.format.duration), format: j.format.format_name, streams: j.streams };
}

// Hai đoạn cắt của nguồn 4 s: [0,1] + [2,3] -> timeline 2 s.
function exportForm(settings, extra = {}) {
  const form = new FormData();
  form.append('timeline_json', JSON.stringify([
    { start: 0, end: 1, text: 'a', script_index: 0 },
    { start: 2, end: 3, text: 'b', script_index: 1 },
  ]));
  const sequence = { width: 640, height: 360, preset: 'custom', source_width: 640, source_height: 360, source_fps: '24' };
  form.append('export_settings', JSON.stringify({
    resolution: 'sequence', sequence, fps: '24', codec: 'gif', quality: 'small', audio_bitrate: '128k', ...settings,
  }));
  form.append('sequence_settings', JSON.stringify(sequence));
  form.append('client_started_at_ms', String(Date.now()));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

async function main() {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=4:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-pix_fmt', 'yuv420p',
    path.join(tempDir, 'temp_input.mp4')]);
  const outDir = path.join(tempDir, 'đích xuất');
  fs.mkdirSync(outDir, { recursive: true });

  const server = start();
  const baseUrl = `http://127.0.0.1:${process.env.BACKEND_PORT}`;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reports = [];
  const post = async (settings, target) => {
    const res = await fetch(`${baseUrl}/api/export-video`, {
      method: 'POST',
      body: exportForm(settings, target ? { output_path: target, output_ticket: sign(target) } : {}),
    });
    reports.push(res.headers.get('x-project-report-path'));
    return res;
  };
  const noLeftovers = () => {
    assert.deepStrictEqual(fs.readdirSync(outDir).filter((n) => n.includes('.exporting')), [], 'không còn tệp tạm');
    assert.ok(!fs.existsSync(path.join(tempDir, 'final_cut_gif_source.mp4')), 'MP4 tạm của GIF phải được xoá');
  };
  try {
    // 1. GIF thường: 320 px, 10 fps.
    const target = path.join(outDir, 'Ảnh động.gif');
    let res = await post({ gif: { width: 320, fps: 10, max_colors: 128, dither: 'bayer', effect: 'normal', loop: 0 } }, target);
    assert.ok(res.ok, `GIF thất bại: ${await res.clone().text()}`);
    let body = await res.json();
    assert.strictEqual(body.path, target);
    let info = probe(target);
    assert.strictEqual(info.format, 'gif', `container ${info.format}`);
    assert.deepStrictEqual(info.streams.map((s) => s.codec_type), ['video'], 'GIF không có luồng tiếng');
    assert.strictEqual(info.streams[0].codec_name, 'gif');
    assert.strictEqual(info.streams[0].width, 320, `rộng ${info.streams[0].width}`);
    assert.strictEqual(info.streams[0].height, 180, `cao ${info.streams[0].height}`);
    assert.ok(Math.abs(info.duration - 2.0) < 0.2, `dài ${info.duration}s, kỳ vọng ~2,0s`);
    const frames = Number(info.streams[0].nb_read_frames);
    assert.ok(Math.abs(frames - 20) <= 2, `${frames} khung, kỳ vọng ~20 (10 fps x 2 s)`);
    noLeftovers();
    console.log(`  ok  GIF 320 px / 10 fps: ${frames} khung, ${info.duration.toFixed(2)} s, không tiếng`);

    // 2. Theo kích thước video + Boomerang: cỡ khung xuất (640x360), dài gấp đôi.
    const boom = path.join(outDir, 'Boomerang.gif');
    res = await post({ gif: { width: 0, fps: 12, max_colors: 64, dither: 'sierra2_4a', effect: 'boomerang', loop: -1 } }, boom);
    assert.ok(res.ok, `Boomerang thất bại: ${await res.clone().text()}`);
    await res.json();
    info = probe(boom);
    assert.strictEqual(info.streams[0].width, 640);
    assert.strictEqual(info.streams[0].height, 360);
    assert.ok(Math.abs(info.duration - 4.0) < 0.3, `boomerang dài ${info.duration}s, kỳ vọng ~4,0s`);
    noLeftovers();
    console.log(`  ok  GIF theo cỡ video + Boomerang: 640x360, ${info.duration.toFixed(2)} s`);

    // 3. GIF + Audio: .mp3 cùng tên cạnh GIF.
    const withAudio = path.join(outDir, 'Có tiếng.gif');
    res = await post({ export_audio: true, audio_file_format: 'mp3', audio_file_bitrate: '192k' }, withAudio);
    assert.ok(res.ok, `GIF + Audio thất bại: ${await res.clone().text()}`);
    body = await res.json();
    assert.strictEqual(body.audio_path, path.join(outDir, 'Có tiếng.mp3'));
    assert.strictEqual(probe(withAudio).format, 'gif');
    assert.deepStrictEqual(probe(body.audio_path).streams.map((s) => s.codec_type), ['audio']);
    noLeftovers();
    console.log('  ok  GIF + Audio: Có tiếng.gif + Có tiếng.mp3 (mặc định 480 px)');

    // 4. Từ chối: GIF mà đuôi .mp4.
    res = await post({}, path.join(outDir, 'Sai đuôi.mp4'));
    assert.strictEqual(res.status, 400, `GIF + đuôi .mp4 phải bị từ chối, được ${res.status}`);
    await res.text();
    console.log('  ok  từ chối: Codec GIF + đuôi .mp4');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    reports.filter(Boolean).forEach((p) => fs.rmSync(p, { force: true }));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('export gif ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
