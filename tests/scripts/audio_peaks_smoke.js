/* Smoke test SÓNG ÂM THẬT (.pk) — bảo vệ tính CHÍNH XÁC của dữ liệu waveform.
 *
 * Kiểm 3 nhóm:
 *   1) ĐỘ CHÍNH XÁC: dựng file audio có tiếng bíp tại ĐÚNG mốc giây với biên độ
 *      biết trước -> peak phải rơi đúng vị trí (±3ms) và đúng biên độ (±2/255),
 *      vùng im lặng phải bằng 0 tuyệt đối.
 *   2) HÀNH VI ENDPOINT: 202 khi đang sinh -> 200 khi xong; lần 2 phải là cache hit
 *      (nhanh & byte y hệt); nguồn không có audio -> file 32 byte cờ no_audio.
 *   3) AN TOÀN: chặn đường dẫn ngoài temp_uploads/ và library/ (path traversal).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8124';

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TEMP_DIR = path.join(PROJECT_ROOT, 'temp_uploads');
const WORK_DIR = path.join(TEMP_DIR, 'peaks_smoke');
const PEAKS_CACHE_DIR = path.join(PROJECT_ROOT, 'peaks_cache');

const TONE_AMPLITUDE = 0.9;      // biên độ tiếng bíp (0..1)
const TONE_STARTS = [1, 3, 5];   // mốc bắt đầu bíp (giây)
const TONE_LENGTH = 0.2;         // độ dài mỗi bíp (giây)
const CLIP_DURATION = 6;

function ffmpegAvailable() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'inherit' });
  assert.strictEqual(result.status, 0, `ffmpeg thất bại: ${args.join(' ')}`);
}

function parsePeakFile(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const header = {
    magic: String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)),
    version: view.getUint16(4, true),
    headerSize: view.getUint16(6, true),
    sampleRate: view.getUint32(8, true),
    bucketSamples: view.getUint16(12, true),
    flags: view.getUint16(14, true),
    duration: view.getFloat64(16, true),
    peakCount: view.getUint32(24, true),
  };
  const body = new Uint8Array(buffer.buffer, buffer.byteOffset + header.headerSize, header.peakCount * 2);
  return { header, body, peaksPerSecond: header.sampleRate / header.bucketSamples };
}

async function fetchPeaks(baseUrl, query, { timeoutMs = 60000 } = {}) {
  const started = Date.now();
  let sawPending = false;
  for (;;) {
    const res = await fetch(`${baseUrl}/api/audio-peaks?${query}`);
    if (res.status === 200) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, sawPending, key: res.headers.get('x-peaks-key') };
    }
    if (res.status === 202) {
      sawPending = true;
      assert.ok(Date.now() - started < timeoutMs, 'job sinh peak quá lâu');
      await new Promise((resolve) => setTimeout(resolve, 200));
      continue;
    }
    throw new Error(`/api/audio-peaks trả HTTP ${res.status}: ${await res.text()}`);
  }
}

// Các vùng liên tục có tiếng (peak > ngưỡng nhiễu) -> [{start, end, maxPeak}] theo giây.
function findToneRegions({ body, header, peaksPerSecond }, threshold = 8) {
  const regions = [];
  let startIndex = -1;
  let maxPeak = 0;
  for (let i = 0; i <= header.peakCount; i += 1) {
    const value = i < header.peakCount ? body[i * 2] : 0;
    if (value > threshold) {
      if (startIndex < 0) { startIndex = i; maxPeak = 0; }
      maxPeak = Math.max(maxPeak, value);
    } else if (startIndex >= 0) {
      regions.push({ start: startIndex / peaksPerSecond, end: i / peaksPerSecond, maxPeak });
      startIndex = -1;
    }
  }
  return regions;
}

async function main() {
  if (!ffmpegAvailable()) {
    console.log('audio peaks smoke skipped (không tìm thấy ffmpeg)');
    return;
  }
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const tonePath = path.join(WORK_DIR, 'peaks_tone.wav');
  const silentVideoPath = path.join(WORK_DIR, 'peaks_no_audio.mp4');

  // Bíp 1kHz biên độ TONE_AMPLITUDE, chỉ bật trong [start, start+TONE_LENGTH) của mỗi 2 giây.
  // exprs='...' bắt buộc phải nháy đơn: biểu thức có dấu phẩy, không quote thì ffmpeg
  // hiểu thành dấu phân tách option của filter.
  const gate = `gte(mod(t,2),1)*lt(mod(t,2),${1 + TONE_LENGTH})`;
  runFfmpeg(['-f', 'lavfi', '-i',
    `aevalsrc=exprs='${TONE_AMPLITUDE}*sin(2*PI*1000*t)*(${gate})':d=${CLIP_DURATION}:s=48000`,
    tonePath]);
  runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=25',
    '-pix_fmt', 'yuv420p', silentVideoPath]);

  const { start } = require('../../backend/server');
  const port = Number(process.env.BACKEND_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const createdCacheFiles = [];
  try {
    // ---- 1) Độ chính xác ----
    const toneQuery = `url=${encodeURIComponent('/temp_uploads/peaks_smoke/peaks_tone.wav')}`;
    const tone = await fetchPeaks(baseUrl, toneQuery);
    if (tone.key) createdCacheFiles.push(path.join(PEAKS_CACHE_DIR, `${tone.key}.pk`));
    const parsed = parsePeakFile(tone.buffer);
    const { header, body, peaksPerSecond } = parsed;

    assert.strictEqual(header.magic, 'CRWV');
    assert.strictEqual(header.version, 1);
    assert.strictEqual(header.headerSize, 32);
    assert.strictEqual(header.sampleRate, 24000);
    assert.strictEqual(header.bucketSamples, 32);
    assert.strictEqual(header.flags, 0);
    assert.strictEqual(peaksPerSecond, 750);
    assert.ok(Math.abs(header.duration - CLIP_DURATION) < 0.05,
      `duration lệch: ${header.duration}`);
    assert.ok(Math.abs(header.peakCount - CLIP_DURATION * peaksPerSecond) <= 2,
      `peakCount lệch: ${header.peakCount}`);
    assert.strictEqual(tone.buffer.length, header.headerSize + header.peakCount * 2);

    const regions = findToneRegions(parsed);
    assert.strictEqual(regions.length, TONE_STARTS.length,
      `số vùng có tiếng phải là ${TONE_STARTS.length}, nhận ${regions.length}`);
    const expectedPeak = Math.round(TONE_AMPLITUDE * 255);
    regions.forEach((region, index) => {
      const expectedStart = TONE_STARTS[index];
      assert.ok(Math.abs(region.start - expectedStart) <= 0.003,
        `bíp #${index + 1} lệch thời điểm: ${region.start} (mong đợi ${expectedStart})`);
      assert.ok(Math.abs((region.end - region.start) - TONE_LENGTH) <= 0.006,
        `bíp #${index + 1} lệch độ dài: ${(region.end - region.start).toFixed(4)}`);
      assert.ok(Math.abs(region.maxPeak - expectedPeak) <= 2,
        `bíp #${index + 1} lệch biên độ: ${region.maxPeak} (mong đợi ${expectedPeak})`);
    });
    // Vùng im lặng phải bằng 0 TUYỆT ĐỐI (không rò biên bucket).
    for (let i = 0; i < header.peakCount; i += 1) {
      const t = i / peaksPerSecond;
      const inTone = TONE_STARTS.some((s) => t >= s - 0.004 && t < s + TONE_LENGTH + 0.004);
      if (!inTone) {
        assert.strictEqual(body[i * 2], 0, `có tiếng ở vùng im lặng t=${t.toFixed(4)}`);
      }
    }
    // RMS luôn ≤ peak trong cùng bucket.
    for (let i = 0; i < header.peakCount; i += 1) {
      assert.ok(body[i * 2 + 1] <= body[i * 2], `rms > peak tại bucket ${i}`);
    }

    // ---- 2) Endpoint: cache hit lần 2 ----
    const again = await fetchPeaks(baseUrl, toneQuery);
    assert.strictEqual(again.sawPending, false, 'lần 2 phải là cache hit, không được pending');
    assert.ok(again.buffer.equals(tone.buffer), 'cache hit trả byte khác lần đầu');

    // ---- 2b) Nguồn KHÔNG có audio -> file rỗng + cờ no_audio ----
    const silent = await fetchPeaks(baseUrl,
      `url=${encodeURIComponent('/temp_uploads/peaks_smoke/peaks_no_audio.mp4')}`);
    if (silent.key) createdCacheFiles.push(path.join(PEAKS_CACHE_DIR, `${silent.key}.pk`));
    const silentParsed = parsePeakFile(silent.buffer);
    assert.strictEqual(silent.buffer.length, 32);
    assert.strictEqual(silentParsed.header.flags & 0x1, 0x1, 'thiếu cờ no_audio');
    assert.strictEqual(silentParsed.header.peakCount, 0);

    // ---- 3) An toàn: chỉ nhận file trong temp_uploads/ và library/ ----
    const blocked = [
      'path=/etc/passwd',
      `url=${encodeURIComponent('/temp_uploads/../../etc/passwd')}`,
      `path=${encodeURIComponent(path.join(PROJECT_ROOT, 'index.html'))}`,
      `path=${encodeURIComponent(path.join(PROJECT_ROOT, 'backend', 'server.js'))}`,
      'url=/library/../.gitignore',
      '',
    ];
    for (const query of blocked) {
      const res = await fetch(`${baseUrl}/api/audio-peaks?${query}`);
      assert.strictEqual(res.status, 404, `phải chặn nguồn không hợp lệ: "${query}"`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
    for (const file of createdCacheFiles) fs.rmSync(file, { force: true });
  }
  console.log('audio peaks smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
