/**
 * XUẤT ÂM THANH RIÊNG — hai ô Video / Audio của hộp Xuất kiểu CapCut (v1.1.17, người dùng chốt
 * 2026-10-11). Chạy: npm run test:export-audio-file
 *
 * Gọi /api/export-video thật (backend + sidecar `export-audio`), chốt:
 *   1. CHỈ Audio, đủ 4 định dạng: đúng codec/container (MP3 libmp3lame, WAV pcm_s16le, AAC trong .m4a,
 *      FLAC), không có luồng hình, dài đúng timeline (2 đoạn cắt = 2,0 s), ghi thẳng ra đường dẫn đã ký,
 *      không để lại tệp `.exporting`.
 *   2. Video + Audio: video ra đúng chỗ (có cả hình lẫn tiếng, như cũ) VÀ một tệp .mp3 cùng tên cạnh
 *      nó; mức âm của tệp riêng KHỚP tiếng trong video (cùng bộ trộn) — lệch < 1 dB.
 *   3. Chỉ Video (mặc định): không sinh tệp âm thanh nào.
 *   4. Từ chối: chỉ Audio mà đường dẫn đuôi .mp4 -> 400; bỏ cả hai ô -> 400.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8131';
const projectRoot = path.resolve(__dirname, '..', '..');
process.env.CRAB_TEMP_DIR = path.join(projectRoot, 'test_temp', 'export_audio_file');
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
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,sample_rate,channels',
    '-of', 'json', file]);
  const j = JSON.parse(r.stdout);
  return { duration: Number(j.format.duration), format: j.format.format_name, streams: j.streams };
}

// Mức âm trung bình (dB) của luồng tiếng đầu tiên.
function meanVolume(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr || '');
  assert.ok(m, `không đo được mức âm của ${file}`);
  return Number(m[1]);
}

// Hai đoạn cắt của nguồn 4 s: [0,1] + [2,3] -> timeline 2 s.
function exportForm(settings, extra = {}) {
  const form = new FormData();
  form.append('timeline_json', JSON.stringify([
    { start: 0, end: 1, text: 'a', script_index: 0 },
    { start: 2, end: 3, text: 'b', script_index: 1 },
  ]));
  const sequence = { width: 320, height: 180, preset: 'custom', source_width: 160, source_height: 90, source_fps: '24' };
  form.append('export_settings', JSON.stringify({
    resolution: 'sequence', sequence, fps: '24', codec: 'h264', quality: 'small', audio_bitrate: '128k', ...settings,
  }));
  form.append('sequence_settings', JSON.stringify(sequence));
  form.append('client_started_at_ms', String(Date.now()));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

async function main() {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=4:r=24',
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
  try {
    // 1. Chỉ Audio — đủ 4 định dạng.
    const formats = [
      { format: 'mp3', ext: '.mp3', codec: 'mp3', container: 'mp3' },
      { format: 'wav', ext: '.wav', codec: 'pcm_s16le', container: 'wav' },
      { format: 'aac', ext: '.m4a', codec: 'aac', container: 'mov,mp4,m4a,3gp,3g2,mj2' },
      { format: 'flac', ext: '.flac', codec: 'flac', container: 'flac' },
    ];
    for (const f of formats) {
      const target = path.join(outDir, `Âm thanh${f.ext}`);
      const res = await post({ export_video: false, export_audio: true, audio_file_format: f.format, audio_file_bitrate: '192k' }, target);
      assert.ok(res.ok, `${f.format}: xuất thất bại: ${await res.clone().text()}`);
      const body = await res.json();
      assert.strictEqual(body.path, target);
      const info = probe(target);
      assert.strictEqual(info.format, f.container, `${f.format}: container ${info.format}`);
      assert.deepStrictEqual(info.streams.map((s) => s.codec_type), ['audio'], `${f.format}: chỉ được có luồng tiếng`);
      assert.strictEqual(info.streams[0].codec_name, f.codec, `${f.format}: codec ${info.streams[0].codec_name}`);
      assert.ok(Math.abs(info.duration - 2.0) < 0.12, `${f.format}: dài ${info.duration}s, kỳ vọng ~2,0s (2 đoạn cắt)`);
      console.log(`  ok  chỉ Audio ${f.format.toUpperCase()}: ${f.codec} / ${info.duration.toFixed(3)} s, không có hình`);
    }
    assert.deepStrictEqual(fs.readdirSync(outDir).filter((n) => n.includes('.exporting')), [], 'không còn tệp tạm');

    // 2. Video + Audio: video như cũ + tệp .mp3 cùng tên cạnh nó, cùng mức âm.
    const videoTarget = path.join(outDir, 'Phim.mp4');
    let res = await post({ export_video: true, export_audio: true, audio_file_format: 'mp3', audio_file_bitrate: '320k' }, videoTarget);
    assert.ok(res.ok, `video + audio thất bại: ${await res.clone().text()}`);
    let body = await res.json();
    const sibling = path.join(outDir, 'Phim.mp3');
    assert.strictEqual(body.path, videoTarget);
    assert.strictEqual(body.audio_path, sibling, 'tệp âm thanh nằm cạnh video, cùng tên');
    const vinfo = probe(videoTarget);
    assert.deepStrictEqual(vinfo.streams.map((s) => s.codec_type).sort(), ['audio', 'video'], 'video vẫn có cả hình lẫn tiếng');
    const ainfo = probe(sibling);
    assert.deepStrictEqual(ainfo.streams.map((s) => s.codec_type), ['audio']);
    assert.ok(Math.abs(ainfo.duration - vinfo.duration) < 0.12, `độ dài lệch: audio ${ainfo.duration} / video ${vinfo.duration}`);
    const dv = meanVolume(videoTarget);
    const da = meanVolume(sibling);
    assert.ok(Math.abs(dv - da) < 1.0, `mức âm lệch: video ${dv} dB, tệp riêng ${da} dB`);
    assert.deepStrictEqual(fs.readdirSync(outDir).filter((n) => n.includes('.exporting')), [], 'không còn tệp tạm');
    console.log(`  ok  Video + Audio: Phim.mp4 (hình + tiếng) + Phim.mp3 cạnh nó, mức âm ${dv} / ${da} dB`);

    // 3. Chỉ Video (mặc định, khách cũ không gửi gì): không sinh tệp âm thanh.
    const onlyVideo = path.join(outDir, 'Chỉ hình.mp4');
    res = await post({}, onlyVideo);
    assert.ok(res.ok);
    body = await res.json();
    assert.ok(!body.audio_path, 'chỉ Video thì không có audio_path');
    assert.ok(!fs.existsSync(path.join(outDir, 'Chỉ hình.mp3')));
    console.log('  ok  chỉ Video (mặc định): xuất như cũ, không có tệp âm thanh');

    // 4. Từ chối.
    const wrong = path.join(outDir, 'Sai đuôi.mp4');
    res = await post({ export_video: false, export_audio: true, audio_file_format: 'wav' }, wrong);
    assert.strictEqual(res.status, 400, `chỉ Audio mà đuôi .mp4 phải bị từ chối, được ${res.status}`);
    await res.text();
    res = await post({ export_video: false, export_audio: false }, path.join(outDir, 'Không gì.mp4'));
    assert.strictEqual(res.status, 400, `bỏ cả hai ô phải bị từ chối, được ${res.status}`);
    await res.text();
    console.log('  ok  từ chối: chỉ Audio + đuôi .mp4, bỏ cả hai ô');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    reports.filter(Boolean).forEach((p) => fs.rmSync(p, { force: true }));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('export audio file ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
