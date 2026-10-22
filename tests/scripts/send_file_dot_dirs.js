/* Phục vụ tệp theo ĐƯỜNG TUYỆT ĐỐI khi đường có thư mục bắt đầu bằng dấu chấm.
 *
 * Express 5 / `send`: res.sendFile(<đường tuyệt đối>) KHÔNG có `root` thì soi MỌI đoạn của
 * đường; gặp đoạn bắt đầu bằng "." (`D:\.footage\`, `~/.config/…`, worktree `.claude\worktrees\…`)
 * là coi như dotfile và trả 404 dù tệp có thật. Test đặt cả dữ liệu người dùng lẫn thư mục nguồn
 * dưới thư mục chấm rồi gọi từng endpoint trả tệp:
 *   1. /api/source-file              (video nguồn người dùng — kể cả Range để <video> tua được)
 *   2. /api/voice-profiles/:id/audio (giọng mẫu dưới USER_DATA_ROOT)
 *   3. /api/logo-ai/patch/...        (miếng vá dưới logo_ai_cache)
 *   4. /api/audio-peaks              (file .pk dưới peaks_cache, nguồn trong TEMP_DIR)
 * và kiểm danh sách trắng / chặn dotfile vẫn giữ nguyên (403/404 như cũ).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8141';
const TEST_ROOT = path.join(__dirname, '..', '..', 'test_temp', 'send_file_dot_dirs');
const DOT_ROOT = path.join(TEST_ROOT, '.hidden');
const USER_DATA = path.join(DOT_ROOT, '.userdata');
process.env.CRAB_USER_DATA_DIR = USER_DATA;
process.env.CRAB_TEMP_DIR = path.join(USER_DATA, 'temp_uploads');
delete process.env.CRAB_VOICE_PROFILES_DIR;
delete process.env.CRAB_LOGO_AI_CACHE_DIR;

const FOOTAGE = path.join(DOT_ROOT, '.footage');

// WAV PCM 16-bit mono: đủ để sidecar sinh peak, không cần ffmpeg CLI.
function writeToneWav(file, seconds = 1, sampleRate = 24000) {
  const count = seconds * sampleRate;
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    data.writeInt16LE(Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * 440 * i / sampleRate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function writeBytes(file, length, fill) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) buffer[i] = (i * 7 + fill) & 0xff;
  fs.writeFileSync(file, buffer);
  return buffer;
}

async function fetchPeaks(baseUrl, query, timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    const res = await fetch(`${baseUrl}/api/audio-peaks?${query}`);
    if (res.status !== 202) return res;
    await res.arrayBuffer();
    assert.ok(Date.now() - started < timeoutMs, 'job sinh peak quá lâu');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  const clip = path.join(FOOTAGE, 'Day1', 'clip.mp4');
  const clipBytes = writeBytes(clip, 4096, 3);
  // Tệp ẩn TRONG thư mục đã đăng ký: không lộ ra panel (scan bỏ qua) nên phải giữ nguyên 404 như cũ.
  writeBytes(path.join(FOOTAGE, '.secret.mp4'), 64, 9);
  const outsider = path.join(DOT_ROOT, 'outside.mp4');
  writeBytes(outsider, 64, 1);

  const voiceId = 'vp_dotdir01';
  const voiceBytes = writeBytes(path.join(USER_DATA, 'voice_profiles', voiceId, 'reference.wav'), 512, 5);

  const patchKey = 'a1b2c3d4e5f6a7b8c9d0e1f2';
  const patchRun = 'run_dotdir01';
  const patchFile = 'r0_000001.png';
  const patchBytes = writeBytes(path.join(USER_DATA, 'logo_ai_cache', patchKey, patchRun, patchFile), 256, 11);

  writeToneWav(path.join(process.env.CRAB_TEMP_DIR, 'peaks', 'tone.wav'));

  const { start } = require('../../backend/server');
  const port = Number(process.env.BACKEND_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    // --- 1: video nguồn trong thư mục chấm ---
    const scanRes = await fetch(`${baseUrl}/api/video-sources/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_paths: [FOOTAGE] }),
    });
    assert.strictEqual(scanRes.ok, true, 'scan thư mục chấm phải thành công');
    const sourceUrl = `${baseUrl}/api/source-file?path=${encodeURIComponent(clip)}`;
    const full = await fetch(sourceUrl);
    assert.strictEqual(full.status, 200, `/api/source-file dưới thư mục chấm phải 200 (nhận ${full.status})`);
    assert.ok(Buffer.from(await full.arrayBuffer()).equals(clipBytes), 'source-file trả sai nội dung');
    assert.strictEqual(full.headers.get('accept-ranges'), 'bytes');

    const ranged = await fetch(sourceUrl, { headers: { Range: 'bytes=100-199' } });
    assert.strictEqual(ranged.status, 206, 'Range phải trả 206 để <video> tua được');
    assert.strictEqual(ranged.headers.get('content-range'), `bytes 100-199/${clipBytes.length}`);
    assert.ok(Buffer.from(await ranged.arrayBuffer()).equals(clipBytes.subarray(100, 200)));

    const denied = await fetch(`${baseUrl}/api/source-file?path=${encodeURIComponent(outsider)}`);
    assert.strictEqual(denied.status, 403, 'đường chưa đăng ký vẫn phải bị chặn');
    const hidden = await fetch(`${baseUrl}/api/source-file?path=${encodeURIComponent(path.join(FOOTAGE, '.secret.mp4'))}`);
    assert.strictEqual(hidden.status, 404, 'tệp ẩn (tên bắt đầu bằng dấu chấm) vẫn không phát');

    // --- 2: giọng mẫu ---
    const voice = await fetch(`${baseUrl}/api/voice-profiles/${voiceId}/audio`);
    assert.strictEqual(voice.status, 200, `giọng mẫu dưới thư mục chấm phải 200 (nhận ${voice.status})`);
    assert.strictEqual(voice.headers.get('cache-control'), 'no-store');
    assert.ok(Buffer.from(await voice.arrayBuffer()).equals(voiceBytes), 'giọng mẫu trả sai nội dung');

    // --- 3: miếng vá xoá logo ---
    const patch = await fetch(`${baseUrl}/api/logo-ai/patch/${patchKey}/${patchRun}/${patchFile}`);
    assert.strictEqual(patch.status, 200, `miếng vá dưới thư mục chấm phải 200 (nhận ${patch.status})`);
    assert.strictEqual(patch.headers.get('cache-control'), 'private, max-age=86400, immutable');
    assert.ok(Buffer.from(await patch.arrayBuffer()).equals(patchBytes), 'miếng vá trả sai nội dung');

    // --- 4: sóng âm ---
    const peaks = await fetchPeaks(baseUrl, `url=${encodeURIComponent('/temp_uploads/peaks/tone.wav')}`);
    assert.strictEqual(peaks.status, 200, `/api/audio-peaks dưới thư mục chấm phải 200 (nhận ${peaks.status})`);
    assert.strictEqual(peaks.headers.get('content-type'), 'application/octet-stream');
    const pk = Buffer.from(await peaks.arrayBuffer());
    assert.strictEqual(pk.subarray(0, 4).toString('latin1'), 'CRWV', 'file peak sai magic');

    console.log('send file dot dirs ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
