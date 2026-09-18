/* Smoke test PROXY LQ CHO ASSET OVERLAY (xem khối cùng tên trong backend/server.js).
 *
 * Kiểm 4 nhóm, đều là những chỗ mà sai thì HỎNG ÂM THẦM (preview vẫn chạy, chỉ là
 * chạy bằng bản gốc / hoặc phát ra một file dở):
 *   1) HÌNH DẠNG PROXY: cao tối đa 720, bề rộng CHIA HẾT CHO 16, ALL-INTRA (mọi khung
 *      là khung I). Cả ba đều là quyết định có số đo đứng sau (xem BuildPreviewProxyCommand
 *      và AppendPreviewEncoderArgs trong core_process.cpp) — "tối ưu" mất là mất luôn lý do.
 *   2) HÀNH VI ENDPOINT: queued -> ready; lần 2 là cache hit trả ngay 'ready' cùng key;
 *      nguồn KHÔNG PHẢI video -> 'unsupported' (không dựng job vô nghĩa).
 *   3) CỔNG JOB NỀN: `busy:true` thì job mới KHÔNG được khởi động; `busy:false` mở lại.
 *      Đây là tầng chống giật quan trọng nhất, và là thứ dễ bị bỏ quên nhất.
 *   4) AN TOÀN: chặn đường dẫn ngoài danh sách trắng (path traversal).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8127';

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TEMP_DIR = path.join(PROJECT_ROOT, 'temp_uploads');
const WORK_DIR = path.join(TEMP_DIR, 'proxy_smoke');
const PROXY_CACHE_DIR = path.join(PROJECT_ROOT, 'proxy_cache');

// Nguồn cao hơn 720 để proxy BẮT BUỘC phải hạ cỡ, và bề rộng lẻ 1080 -> 1080/1920*720 = 405,
// tức số LẺ: đúng ca mà `scale=-2` (chẵn) đi qua được còn `-16` thì phải kéo về 400.
const SRC_WIDTH = 1080;
const SRC_HEIGHT = 1920;
const SRC_DURATION = 2;

function toolAvailable(bin) {
  return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
}

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'inherit' });
  assert.strictEqual(result.status, 0, `ffmpeg thất bại: ${args.join(' ')}`);
}

function probe(file, entries, selectStream = 'v:0') {
  const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', selectStream,
    '-show_entries', entries, '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0, `ffprobe thất bại trên ${file}`);
  return out.stdout.trim().split(/\r?\n/);
}

async function askProxy(baseUrl, filePath) {
  const res = await fetch(`${baseUrl}/api/editing-assets/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });
  assert.strictEqual(res.status, 200, `/api/editing-assets/proxy trả HTTP ${res.status}`);
  return res.json();
}

async function gate(baseUrl, busy, ttlMs) {
  const res = await fetch(`${baseUrl}/api/background-jobs/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ busy, ttl_ms: ttlMs }),
  });
  assert.strictEqual(res.status, 200);
  return res.json();
}

async function waitReady(baseUrl, filePath, timeoutMs = 120000) {
  const started = Date.now();
  let sawPendingStatus = false;
  for (;;) {
    const data = await askProxy(baseUrl, filePath);
    if (data.status === 'ready' && data.url) return { ...data, sawPendingStatus };
    assert.notStrictEqual(data.status, 'unsupported', 'nguồn video hợp lệ mà bị coi là unsupported');
    assert.ok(!data.error, `job proxy lỗi: ${data.error}`);
    sawPendingStatus = true;
    assert.ok(Date.now() - started < timeoutMs, 'job dựng proxy quá lâu');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main() {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe')) {
    console.log('asset proxy cache skipped (không tìm thấy ffmpeg/ffprobe)');
    return;
  }
  const sidecar = path.join(PROJECT_ROOT, 'native', 'sidecar', 'build',
    process.platform === 'win32' ? 'core_process.exe' : 'core_process');
  if (!fs.existsSync(sidecar)) {
    console.log('asset proxy cache skipped (chưa build sidecar: npm run build:sidecar)');
    return;
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const srcPath = path.join(WORK_DIR, 'proxy_src.mp4');
  const audioPath = path.join(WORK_DIR, 'proxy_src.wav');
  runFfmpeg(['-f', 'lavfi', '-i',
    `testsrc=duration=${SRC_DURATION}:size=${SRC_WIDTH}x${SRC_HEIGHT}:rate=30`,
    '-pix_fmt', 'yuv420p', srcPath]);
  runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', '1', audioPath]);

  const { start } = require('../../backend/server');
  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  const server = start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const created = [];
  try {
    // ---- 3) CỔNG JOB NỀN (làm TRƯỚC, vì phải chặn được job ngay lượt đầu) ----
    // Cổng đóng 3s -> yêu cầu proxy phải nằm ở 'queued', KHÔNG được nhảy sang 'running'.
    await gate(baseUrl, true, 3000);
    const gated = await askProxy(baseUrl, srcPath);
    assert.strictEqual(gated.paused, true, 'endpoint phải báo cổng đang đóng');
    assert.strictEqual(gated.status, 'queued', `cổng đóng mà job đã ${gated.status}`);
    assert.strictEqual(gated.url, '', 'chưa xong thì KHÔNG được trả url');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const stillGated = await askProxy(baseUrl, srcPath);
    assert.strictEqual(stillGated.status, 'queued', 'cổng đóng mà job vẫn được khởi động');
    assert.strictEqual(stillGated.url, '', 'cổng đóng mà job vẫn chạy tới xong');

    // Mở cổng -> job phải chạy và xong.
    await gate(baseUrl, false);
    const ready = await waitReady(baseUrl, srcPath);
    assert.ok(ready.sawPendingStatus, 'lượt đầu phải ở trạng thái chờ, không thể ready ngay');
    assert.match(ready.url, /^\/proxy_cache\/[0-9a-f]{24}\.mp4$/, `url proxy sai khuôn: ${ready.url}`);
    const proxyPath = path.join(PROXY_CACHE_DIR, `${ready.key}.mp4`);
    created.push(proxyPath);
    assert.ok(fs.existsSync(proxyPath), 'ready mà không có file trên đĩa');
    assert.ok(fs.statSync(proxyPath).size > 0, 'file proxy rỗng');
    // Không được để lại file dở của job.
    assert.ok(!fs.existsSync(path.join(PROXY_CACHE_DIR, `${ready.key}.part.mp4`)),
      'job xong mà vẫn còn file .part.mp4');

    // ---- 1) HÌNH DẠNG PROXY ----
    const [w, h] = probe(proxyPath, 'stream=width,height').map(Number);
    assert.strictEqual(h, 720, `proxy phải cao 720, nhận ${h}`);
    assert.strictEqual(w % 16, 0, `bề rộng proxy PHẢI chia hết cho 16, nhận ${w}`);
    assert.ok(w > 0 && w < SRC_WIDTH, `bề rộng proxy vô lý: ${w}`);
    const pictTypes = probe(proxyPath, 'frame=pict_type');
    assert.ok(pictTypes.length > 10, `proxy quá ít khung: ${pictTypes.length}`);
    assert.ok(pictTypes.every((t) => t === 'I'),
      'proxy PHẢI all-intra (-g 1): tua ở lane overlay mới rẻ — xem AppendPreviewEncoderArgs');

    // Phục vụ được qua HTTP và có Range (để <video> tua được).
    const fileRes = await fetch(`${baseUrl}${ready.url}`, { headers: { Range: 'bytes=0-15' } });
    assert.strictEqual(fileRes.status, 206, 'proxy phải phục vụ được Range request');

    // ---- 2) CACHE HIT ----
    const again = await askProxy(baseUrl, srcPath);
    assert.strictEqual(again.status, 'ready');
    assert.strictEqual(again.url, ready.url, 'lần 2 phải trả đúng cache cũ, cùng key');

    // Nguồn không phải video -> không dựng job.
    const notVideo = await askProxy(baseUrl, audioPath);
    assert.strictEqual(notVideo.status, 'unsupported', 'file audio không được coi là dựng proxy được');

    // ---- 4) AN TOÀN ----
    const outside = await askProxy(baseUrl, path.join(PROJECT_ROOT, 'package.json'));
    assert.strictEqual(outside.status, 'unsupported', 'đường dẫn ngoài danh sách trắng phải bị chặn');
    const traversal = await askProxy(baseUrl, '/temp_uploads/../../package.json');
    assert.strictEqual(traversal.status, 'unsupported', 'path traversal phải bị chặn');
  } finally {
    await gate(baseUrl, false).catch(() => {});
    server.close();
    for (const file of created) fs.rmSync(file, { force: true });
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
  }
  console.log('asset proxy cache ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
