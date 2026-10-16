/* =====================================================================
 * KHUNG NGUỒN CHO BƯỚC DỰNG RETOUCH TỪ BACKEND — backend/retouch-frames.js (nhánh 1B)
 *
 * Renderer từng tua thẻ <video> từng khung (81 ms/khung trên nguồn DJI HEVC 10-bit); nay xin
 * POST /api/retouch/frames để ffmpeg giải mã tuần tự. Bài test chốt:
 *   1. Quy tắc chọn: mốc t lấy khung CUỐI có PTS ≤ đích (như <video> hiện khung chứa t); mốc trước
 *      khung đầu -> khung đầu; mốc quá cuối -> khung cuối; mốc trùng -> khung lặp.
 *   2. Endpoint thật trên video 25 fps mà MỖI KHUNG một mức xám: đúng khung cho từng mốc (kể cả mốc
 *      rơi đúng biên khung và giữa khung), đúng số khung, đúng cỡ, ở cả hai quy ước trục thời gian:
 *      lane chính (đích = t + start_time của LUỒNG HÌNH — bản nối có edit list, hình bắt đầu muộn
 *      hơn tiếng) và asset (đích = t + start_time của TỆP).
 *   3. Từ chối: mốc giảm dần, nguồn ngoài cổng an toàn, env tắt.
 *
 * Chạy: npm run test:retouch-frames
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { spawnSync } = require('child_process');
const { createRetouchFramesHandler, createFrameSelector } = require('../../backend/retouch-frames.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'retouch_frames');
const W = 64;
const H = 48;
const FPS = 25;
const LEVEL_STEP = 7;   // khung n có mức xám Y = 16 + (n·7 mod 200), Cb = 91 + n (xem makeSource)

function testSelector() {
  const out = [];
  const sel = createFrameSelector([0, 0.03, 0.04, 0.04, 0.079, 0.5], (frame, i) => out.push([i, frame]));
  sel.feed(0.0, 'f0');
  sel.feed(0.04, 'f1');
  sel.feed(0.08, 'f2');
  assert.strictEqual(sel.finish(), 6);
  assert.deepStrictEqual(out, [[0, 'f0'], [1, 'f0'], [2, 'f1'], [3, 'f1'], [4, 'f1'], [5, 'f2']]);
  const early = [];
  const sel2 = createFrameSelector([0, 0.1], (frame, i) => early.push([i, frame]));
  sel2.feed(0.5, 'g0');   // mốc trước khung đầu tiên -> khung đầu tiên
  sel2.finish();
  assert.deepStrictEqual(early, [[0, 'g0'], [1, 'g0']]);
  console.log('  ok  quy tắc chọn khung: biên khung, giữa khung, trùng mốc, trước khung đầu, quá cuối');
}

function mustRun(cmd, args, what) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr}`);
  return r;
}

// Video mỗi khung một mức xám. `videoDelay` > 0: luồng hình bắt đầu MUỘN hơn tiếng (như edit list
// của temp_input.mp4) -> start_time của luồng hình > start_time của tệp.
function makeSource(file, videoDelay) {
  const args = ['-y', '-v', 'error'];
  if (videoDelay > 0) args.push('-itsoffset', String(videoDelay));
  args.push('-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:r=${FPS}:d=3,geq=lum='16+mod(N*${LEVEL_STEP},200)':cb='91+N':cr=128`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3.2',
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-g', '25',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', file);
  mustRun('ffmpeg', args, 'nguồn');
}

function videoStartTime(file) {
  const r = mustRun('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time',
    '-of', 'csv=p=0', file], 'ffprobe');
  return Number(String(r.stdout).trim());
}

/* Mức xám (kênh G của RGBA, điểm giữa khung) của TỪNG khung theo thứ tự, giải mã thẳng bằng ffmpeg với
 * cùng phép đổi màu — làm bảng tra "mức xám -> chỉ số khung" (không suy từ công thức geq: phép đổi dải
 * màu khi mã hoá dời mức đi vài đơn vị). Hai khung liền nhau cách nhau ~8 mức. */
function grayTable(file) {
  // `-fps_mode passthrough`: rawvideo mặc định khung đều -> nhân bản khung đầu lấp chỗ trống trước
  // start_time của luồng hình, bảng lệch đi vài khung (đã mắc với tệp hình bắt đầu muộn).
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=in_color_matrix=bt709:in_range=tv,format=rgba',
    '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 256 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, 'giải mã bảng tra');
  const fb = W * H * 4;
  const out = [];
  for (let k = 0; k * fb < r.stdout.length; k++) out.push(pixelAt(r.stdout, k));
  return out;
}

/* Bộ RGB ở điểm giữa khung thứ k của một khối RGBA. CHỈ mức xám thì không định danh được khung:
 * 16 + (n·7 mod 200) quay vòng sau ~29 khung, khung 14 (114) và khung 71 (113) chỉ cách nhau 1 mức —
 * ffmpeg 8.1 làm tròn khác 8.1.1 một đơn vị là tra nhầm khung (đỏ trên Mac, xanh trên Windows). Cb
 * tăng đều theo n nên bộ RGB của mọi khung trong 3 s đều khác hẳn nhau. */
function pixelAt(buf, k) {
  const o = k * W * H * 4 + ((H / 2) * W + W / 2) * 4;
  return [buf[o], buf[o + 1], buf[o + 2]];
}

function frameIndexOfGray(table, rgb) {
  let best = -1;
  let dist = Infinity;
  table.forEach((v, n) => {
    const d = Math.max(Math.abs(v[0] - rgb[0]), Math.abs(v[1] - rgb[1]), Math.abs(v[2] - rgb[2]));
    if (d < dist) { dist = d; best = n; }
  });
  return dist <= 2 ? best : -1;
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/frames', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function testEndpoint() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const plain = path.join(TEST_DIR, 'plain.mp4');
  const delayed = path.join(TEST_DIR, 'delayed.mp4');
  makeSource(plain, 0);
  makeSource(delayed, 0.1);
  const delayedStart = videoStartTime(delayed);
  assert.ok(delayedStart > 0.05, `bối cảnh: luồng hình phải bắt đầu muộn (${delayedStart})`);

  const app = express();
  app.use(express.json());
  // '' = lane chính (temp_input.mp4); đường dẫn khác chỉ nhận đúng hai tệp của test.
  app.post('/frames', createRetouchFramesHandler({
    resolveSource: (raw) => {
      const text = String(raw || '').trim();
      if (!text) return app.locals.main;
      return [plain, delayed].includes(text) ? text : null;
    },
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = server.address().port;
  try {
    const times = [0, 0.039, 0.04, 0.5, 0.52, 1.0, 1.0, 2.96, 5.0];
    const tables = new Map([[plain, grayTable(plain)], [delayed, grayTable(delayed)]]);
    assert.strictEqual(tables.get(plain).length, 75, 'bối cảnh: nguồn 3 s × 25 fps');
    const check = async (label, body, expectIndex) => {
      const r = await post(port, body);
      assert.strictEqual(r.status, 200, `${label}: HTTP ${r.status} ${r.body.toString('utf8').slice(0, 200)}`);
      assert.strictEqual(Number(r.headers['x-frame-width']), W);
      assert.strictEqual(Number(r.headers['x-frame-height']), H);
      assert.strictEqual(r.body.length, times.length * W * H * 4, `${label}: số byte`);
      const table = tables.get(body.source_path || app.locals.main);
      const got = times.map((_, k) => frameIndexOfGray(table, pixelAt(r.body, k)));
      assert.deepStrictEqual(got, times.map(expectIndex), `${label}: khung theo mốc ${JSON.stringify(times)}`);
      console.log(`  ok  ${label}: khung ${got.join(',')}`);
    };
    // Tệp thường: khung n ở n/25 s -> mốc t lấy floor(t·25 + ε); quá cuối -> khung cuối (74).
    const plainIndex = (t) => Math.min(74, Math.floor(t * FPS + 1e-3));
    await check('asset thường', { source_path: plain, times }, plainIndex);
    // Asset có luồng hình bắt đầu muộn: trục của asset là trục đã trừ start_time CỦA TỆP (= 0 ở
    // đây, tiếng bắt đầu ở 0) -> khung đầu chỉ có từ t = 0,1; trước đó lấy khung đầu.
    const assetDelayedIndex = (t) => Math.max(0, Math.min(74, Math.floor((t - delayedStart) * FPS + 1e-3)));
    await check('asset hình bắt đầu muộn', { source_path: delayed, times }, assetDelayedIndex);
    // Lane chính (temp_input.mp4) có luồng hình bắt đầu muộn: t = 0 là KHUNG ĐẦU của luồng hình.
    app.locals.main = delayed;
    await check('lane chính (đích = t + start_time luồng hình)', { source_path: '', times }, plainIndex);

    // Vùng cắt (toạ độ chuẩn hoá) -> pixel chẵn + lề 8 px; nội dung trùng đúng phần đó của khung đủ.
    const full = await post(port, { source_path: plain, times: [0.5] });
    const part = await post(port, { source_path: plain, times: [0.5], crop: { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 } });
    assert.strictEqual(part.status, 200);
    const cx = Number(part.headers['x-crop-x']), cy = Number(part.headers['x-crop-y']);
    const cw = Number(part.headers['x-frame-width']), ch = Number(part.headers['x-frame-height']);
    assert.deepStrictEqual([Number(part.headers['x-source-width']), Number(part.headers['x-source-height'])], [W, H]);
    assert.ok(cx % 2 === 0 && cy % 2 === 0 && cx <= Math.floor(0.4 * W) - 8 + 1 && cx + cw >= Math.ceil(0.6 * W),
      `vùng cắt ${cx},${cy} ${cw}x${ch} phải bao [0,4..0,6] + lề`);
    assert.strictEqual(part.body.length, cw * ch * 4);
    for (let row = 0; row < ch; row++) {
      const a = full.body.subarray(((cy + row) * W + cx) * 4, ((cy + row) * W + cx + cw) * 4);
      const b = part.body.subarray(row * cw * 4, (row + 1) * cw * 4);
      assert.ok(a.equals(b), `vùng cắt hàng ${row} khác khung đủ`);
    }
    console.log(`  ok  vùng cắt: ${cw}x${ch} ở (${cx},${cy}), trùng từng byte phần tương ứng của khung đủ`);

    const bad = await post(port, { source_path: plain, times: [1, 0.5] });
    assert.strictEqual(bad.status, 400, 'mốc giảm dần phải bị từ chối');
    const outside = await post(port, { source_path: path.join(ROOT, 'package.json'), times: [0] });
    assert.strictEqual(outside.status, 400, 'nguồn ngoài cổng an toàn phải bị từ chối');
    process.env.CRAB_RETOUCH_FRAMES = '0';
    const off = await post(port, { source_path: plain, times: [0] });
    delete process.env.CRAB_RETOUCH_FRAMES;
    assert.strictEqual(off.status, 503, 'env tắt phải trả 503 để renderer tua như cũ');
    console.log('  ok  từ chối: mốc giảm dần, nguồn ngoài cổng an toàn, env tắt');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

(async () => {
  testSelector();
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.log('  (bỏ qua phần endpoint: thiếu ffmpeg)');
    return;
  }
  await testEndpoint();
  console.log('retouch frames ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
