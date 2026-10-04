/* =====================================================================
 * BỘ NHỚ ĐỆM KHUNG VẼ TRƯỚC — mục 25 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 * (backend/prebake-cache.js, /api/prebake/lookup, materializePrebakeSeq trong server.js).
 *
 * Renderer tính khoá cho chuỗi khung (miếng vá Retouch, chữ/ảnh động) và hỏi backend trước khi
 * dựng. Test này chốt phía backend:
 *   1. khoá sai dạng -> không cache được; khoá đúng chưa có -> trượt, `cacheable`;
 *   2. lượt xuất gửi khung (multipart JPEG) KÈM khoá -> backend cất; hỏi lại -> trúng, trả đủ meta;
 *   3. lượt xuất chỉ gửi khoá (không khung) -> trỏ vào mục cache, bản xuất TRÙNG lượt có khung từng
 *      khung; chuỗi khung trong export_timeline.json nằm trong thư mục cache (đường dẫn đứng yên);
 *   4. đường base64 nội tuyến (chữ động, có phần tử null = lặp khung) cũng cất + dùng lại được;
 *   5. tệp nguồn đổi nội dung -> khoá cũ thành trượt; lượt xuất chỉ gửi khoá cũ thì LỖI, không lặng lẽ
 *      xuất thiếu miếng vá;
 *   6. Cài đặt tắt "Dùng lại phần đã render" -> lookup báo tắt, lượt xuất vẫn chạy, không cất gì;
 *   7. Cài đặt › Bộ nhớ đệm: mục "render" tính cả khung vẽ trước, không dọn được khi renderer vừa hỏi
 *      trúng (đang chuẩn bị xuất), dọn được sau lượt xuất;
 *   8. mô-đun: dọn thư mục tạm bỏ dở, mục quá hạn, vượt trần (cũ nhất trước).
 *   9. nội dung .cube gửi một lần (`@cube:cN` + editing_json.cube_texts): giải đúng, thiếu thì lỗi rõ.
 *  10. nhiều tệp nguồn (chuyển cảnh lớp phủ giữa hai ảnh/video): mảng đường dẫn, thứ tự, một tệp đổi.
 *
 * Chạy: npm run test:export-prebake-cache
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-prebake-'));
const CACHE_DIR = path.join(tempDir, 'prebake_cache');
process.env.CRAB_TEMP_DIR = path.join(tempDir, 'temp');
process.env.CRAB_PREBAKE_CACHE_DIR = CACHE_DIR;
// Cài đặt riêng (mặc định: cache bật) — không đọc/ghi cài đặt thật của người dùng.
process.env.CRAB_USER_DATA_DIR = path.join(tempDir, 'userdata');
process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8159';
fs.mkdirSync(process.env.CRAB_TEMP_DIR, { recursive: true });
fs.mkdirSync(process.env.CRAB_USER_DATA_DIR, { recursive: true });

const { start } = require('../../backend/server');
const { createPrebakeCache } = require('../../backend/prebake-cache');

const FPS = 24;
const FRAMES = 13;
const TRANSPARENT_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, `${command} failed\n${result.stderr || result.stdout}`);
  return result;
}

function solidFrame(color, ext) {
  const file = path.join(tempDir, `gen_${color}.${ext}`);
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=96x64:d=1`, '-frames:v', '1', file]);
  const buf = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return buf;
}

function makeSource(color) {
  run('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:d=3:r=30`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-map', '0:v', '-map', '1:a', '-shortest', '-pix_fmt', 'yuv420p',
    path.join(process.env.CRAB_TEMP_DIR, 'temp_input.mp4')]);
}

function frameMd5(file) {
  const r = run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-']);
  return r.stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

const randomKey = () => crypto.randomBytes(32).toString('hex');

// Một item chuỗi khung kiểu miếng vá Retouch lane chính (type text + PNG 1×1, như renderer gửi).
function seqItem(id, seq) {
  return {
    id, type: 'text', track_id: 'track_main', timeline_start: 1, duration: FRAMES / FPS, source_start: 0,
    transform: { position_x: 20, position_y: -10, scale: 100, rotation: 0, opacity: 100 },
    rendered_text_png: TRANSPARENT_1PX, rendered_text_width: 1, rendered_text_height: 1,
    animation_render: { fps: FPS, seq: { start: 0, duration: FRAMES / FPS, width: 96, height: 64, frame_count: FRAMES, ...seq } },
  };
}

async function exportWith(baseUrl, items, files = [], extra = {}) {
  const form = new FormData();
  form.append('timeline_json', JSON.stringify(extra.timeline || [{ start: 0, end: 3, text: 'src', script_index: 0 }]));
  const settings = {
    resolution: 'sequence',
    sequence: { width: 320, height: 180, preset: 'custom', source_width: 160, source_height: 90, source_fps: String(FPS) },
    fps: String(FPS), codec: 'h264', quality: 'small', audio_bitrate: '128k',
  };
  form.append('export_settings', JSON.stringify(settings));
  form.append('sequence_settings', JSON.stringify(settings.sequence));
  form.append('export_preset', 'custom');
  form.append('export_fps', String(FPS));
  form.append('editing_json', JSON.stringify({
    version: 5,
    tracks: [{ id: 'track_main', type: 'main', order: 0, visible: true, volume: 100 }],
    items,
    assets: [],
    ...(extra.cubeTexts ? { cube_texts: extra.cubeTexts } : {}),
  }));
  files.forEach((f) => form.append('transition_frames', new Blob([f.buf], { type: f.type }), f.name));
  const response = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: form });
  const status = response.status;
  if (status !== 200) return { status, text: await response.text() };
  const out = path.join(tempDir, `out_${crypto.randomBytes(4).toString('hex')}.mp4`);
  fs.writeFileSync(out, Buffer.from(await response.arrayBuffer()));
  return { status, out };
}

async function lookup(baseUrl, entries) {
  const response = await fetch(`${baseUrl}/api/prebake/lookup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }),
  });
  assert.strictEqual(response.status, 200, `lookup HTTP ${response.status}`);
  return response.json();
}

function cacheEntries() {
  return fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR).filter((n) => !n.includes('.tmp-')) : [];
}

function seqOverlayPath() {
  const timeline = JSON.parse(fs.readFileSync(path.join(process.env.CRAB_TEMP_DIR, 'export_timeline.json'), 'utf8'));
  const seq = (timeline.overlays || []).find((o) => o.asset_type === 'image_seq');
  assert.ok(seq, 'export_timeline.json không có overlay image_seq');
  return seq.asset_path;
}

async function testEndpoints(baseUrl) {
  makeSource('red');
  const green = solidFrame('green', 'jpg');
  const files = Array.from({ length: FRAMES }, (_, i) => ({ name: `retouch_3__${String(i).padStart(4, '0')}.jpg`, buf: green, type: 'image/jpeg' }));
  const K1 = randomKey();

  // 1. khoá sai dạng / khoá đúng chưa có
  let res = await lookup(baseUrl, [{ key: 'not-a-key', source_path: '' }, { key: K1, source_path: '' }]);
  assert.strictEqual(res.enabled, true, 'cache phải bật (CRAB_PREBAKE_CACHE_DIR + cài đặt mặc định)');
  assert.deepStrictEqual(res.results[0], { enabled: true, hit: false, cacheable: false });
  assert.deepStrictEqual(res.results[1], { enabled: true, hit: false, cacheable: true });

  // 2. gửi khung kèm khoá -> cất
  const meta = { rect: { x: 10, y: 12, w: 96, h: 64 }, feather: 8, width: 96, height: 64, duration: FRAMES / FPS };
  const first = await exportWith(baseUrl, [seqItem('retouch_3', {
    frame_files: files.map((f) => f.name), cache_key: K1, source_path: '', cache_meta: meta,
  })], files);
  assert.strictEqual(first.status, 200, `lượt có khung lỗi: ${first.text}`);
  assert.strictEqual(cacheEntries().length, 1, 'lượt có khung phải cất đúng một mục');
  assert.ok(seqOverlayPath().startsWith(CACHE_DIR), `chuỗi khung phải nằm trong cache: ${seqOverlayPath()}`);
  res = await lookup(baseUrl, [{ key: K1, source_path: '' }]);
  assert.strictEqual(res.results[0].hit, true, 'hỏi lại phải trúng');
  assert.deepStrictEqual(res.results[0].meta.rect, meta.rect);
  assert.strictEqual(res.results[0].meta.frame_count, FRAMES);
  assert.strictEqual(res.results[0].meta.ext, '.jpg');

  // 3. chỉ gửi khoá -> bản xuất trùng từng khung
  const second = await exportWith(baseUrl, [seqItem('retouch_3', { cache_key: K1, source_path: '' })]);
  assert.strictEqual(second.status, 200, `lượt chỉ gửi khoá lỗi: ${second.text}`);
  assert.deepStrictEqual(frameMd5(second.out), frameMd5(first.out), 'bản xuất từ cache phải trùng bản có khung');
  assert.strictEqual(cacheEntries().length, 1, 'trúng cache thì không cất thêm');

  // 4. base64 nội tuyến (chữ động: không có tệp nguồn, null = lặp khung trước)
  const blue = `data:image/png;base64,${solidFrame('blue', 'png').toString('base64')}`;
  const white = `data:image/png;base64,${solidFrame('white', 'png').toString('base64')}`;
  const frames = Array.from({ length: FRAMES }, (_, i) => (i === 0 ? blue : (i === 6 ? white : null)));
  const K2 = randomKey();
  const textSeq = { frames, cache_key: K2, cache_meta: { seq: { start: 0, duration: FRAMES / FPS, width: 96, height: 64, frame_count: FRAMES } } };
  const third = await exportWith(baseUrl, [seqItem('item_text_a', textSeq)]);
  assert.strictEqual(third.status, 200, `lượt base64 lỗi: ${third.text}`);
  res = await lookup(baseUrl, [{ key: K2 }]);
  assert.strictEqual(res.results[0].hit, true, 'chuỗi base64 phải được cất');
  assert.deepStrictEqual(res.results[0].meta.seq, textSeq.cache_meta.seq);
  const fourth = await exportWith(baseUrl, [seqItem('item_text_a', { cache_key: K2 })]);
  assert.strictEqual(fourth.status, 200, `lượt base64 chỉ gửi khoá lỗi: ${fourth.text}`);
  assert.deepStrictEqual(frameMd5(fourth.out), frameMd5(third.out), 'chữ động từ cache phải trùng bản có khung');

  // 7a. mục "render" ở Cài đặt › Bộ nhớ đệm tính cả khung vẽ trước; vừa hỏi trúng thì không dọn được
  let usage = await (await fetch(`${baseUrl}/api/cache/usage`)).json();
  const renderUsage = usage.items.find((i) => i.id === 'render');
  assert.ok(renderUsage && renderUsage.files >= FRAMES * 2, `mục render phải đếm khung vẽ trước: ${JSON.stringify(renderUsage)}`);
  await lookup(baseUrl, [{ key: K1, source_path: '' }]);   // renderer hỏi trúng -> giữ
  let clear = await fetch(`${baseUrl}/api/cache/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'render' }),
  });
  assert.strictEqual(clear.status, 409, 'đang giữ mục (renderer chuẩn bị xuất) thì không được dọn');
  const fifth = await exportWith(baseUrl, [seqItem('retouch_3', { cache_key: K1, source_path: '' })]);
  assert.strictEqual(fifth.status, 200, `lượt xuất nhả giữ lỗi: ${fifth.text}`);

  // 5. tệp nguồn đổi nội dung -> khoá cũ trượt; gửi khoá cũ mà không khung -> lỗi, không im lặng
  makeSource('yellow');
  res = await lookup(baseUrl, [{ key: K1, source_path: '' }]);
  assert.deepStrictEqual([res.results[0].hit, res.results[0].cacheable], [false, true], 'nguồn đổi thì phải trượt');
  res = await lookup(baseUrl, [{ key: K2 }]);
  assert.strictEqual(res.results[0].hit, true, 'chuỗi không đọc tệp nguồn không bị đổi nguồn ảnh hưởng');
  // (lượt xuất lỗi này cũng nhả phần giữ của lượt hỏi trúng K2 ngay trên — xem 7b)
  const stale = await exportWith(baseUrl, [seqItem('retouch_3', { cache_key: K1, source_path: '' })]);
  assert.notStrictEqual(stale.status, 200, 'chỉ gửi khoá mà mục không còn hợp lệ thì phải báo lỗi');
  assert.ok(/bộ nhớ đệm khung vẽ trước/i.test(stale.text || ''), `lỗi phải nói rõ nguyên nhân: ${stale.text}`);

  // 7b. hết giữ -> dọn được, dọn cả khung vẽ trước
  clear = await fetch(`${baseUrl}/api/cache/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'render' }),
  });
  assert.strictEqual(clear.status, 200, `dọn mục render lỗi: HTTP ${clear.status}`);
  assert.deepStrictEqual(cacheEntries(), [], 'dọn mục render phải xoá cả khung vẽ trước');

  // 6. tắt công tắc -> lookup báo tắt, lượt xuất có khung vẫn chạy, không cất
  const saved = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ export: { renderCache: false } }),
  });
  assert.strictEqual(saved.status, 200, 'không ghi được cài đặt');
  res = await lookup(baseUrl, [{ key: K1, source_path: '' }]);
  assert.strictEqual(res.enabled, false, 'tắt "Dùng lại phần đã render" thì cache khung vẽ trước cũng tắt');
  const off = await exportWith(baseUrl, [seqItem('retouch_3', {
    frame_files: files.map((f) => f.name), cache_key: K1, source_path: '', cache_meta: meta,
  })], files);
  assert.strictEqual(off.status, 200, `lượt xuất khi tắt cache lỗi: ${off.text}`);
  assert.deepStrictEqual(cacheEntries(), [], 'tắt cache thì không cất gì');
  console.log('  [ok] endpoint: cất, trúng, trùng từng khung, base64, nguồn đổi, giữ khi dọn, công tắc');
}

function sampleRgb(file, seconds) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1',
    '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { cwd: projectRoot, encoding: 'buffer' });
  assert.strictEqual(r.status, 0, r.stderr?.toString('utf8'));
  return [...r.stdout.slice(0, 3)];
}

/* 9. NỘI DUNG .cube GỬI MỘT LẦN: spec màu của clip mang `@cube:cN`, nội dung nằm ở editing_json.cube_texts
 * (exportCubeRef ở editing-runtime.js). Tham chiếu phải được giải ĐÚNG (bản xuất ra màu của LUT), và thiếu
 * nội dung thì lượt xuất LỖI — không được lặng lẽ bỏ LUT như với một .cube hỏng. */
async function testCubeRefs(baseUrl) {
  makeSource('red');
  const lines = ['TITLE "test"', 'LUT_3D_SIZE 2', ''];
  for (let i = 0; i < 8; i += 1) lines.push('0.000000 0.000000 1.000000');   // mọi màu -> xanh lam
  const cube = `${lines.join('\n')}\n`;
  const timeline = (ref) => [{ start: 0, end: 3, text: 'src', script_index: 0, color_adjust: { filters: ['__LUT3D__'], cube: ref } }];
  const ok = await exportWith(baseUrl, [], [], { timeline: timeline('@cube:c1'), cubeTexts: { c1: cube } });
  assert.strictEqual(ok.status, 200, `xuất với @cube lỗi: ${ok.text}`);
  const rgb = sampleRgb(ok.out, 1.5);
  // Nguồn 160×90 không phủ kín sequence 320×180 -> trung bình cả khung chỉ ~nửa; bản không có LUT thì đỏ ~127.
  assert.ok(rgb[2] > 100 && rgb[0] < 30 && rgb[1] < 30, `LUT tham chiếu không được áp (màu ${rgb})`);
  const missing = await exportWith(baseUrl, [], [], { timeline: timeline('@cube:c2'), cubeTexts: { c1: cube } });
  assert.notStrictEqual(missing.status, 200, 'thiếu nội dung cube thì lượt xuất phải lỗi');
  assert.ok(/cube_texts/.test(missing.text || ''), `lỗi phải nói rõ thiếu cube_texts: ${missing.text}`);
  console.log('  [ok] @cube: tham chiếu giải đúng (ra màu LUT), thiếu nội dung -> lỗi rõ');
}

/* 10. NHIỀU TỆP NGUỒN (chuyển cảnh lớp phủ giữa hai ảnh/video: source_path là MẢNG đường dẫn, xem
 * overlayTransitionPrebakeKey). Cất + trúng với đúng mảng; đổi thứ tự, đổi nội dung MỘT tệp -> trượt;
 * phần tử rỗng / mảng rỗng -> không cache được (không được hiểu thành nguồn lane chính). */
async function testMultiSource(baseUrl) {
  const saved = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ export: { renderCache: true } }),
  });
  assert.strictEqual(saved.status, 200, 'không bật lại được cache');
  makeSource('red');
  const imgA = path.join(process.env.CRAB_TEMP_DIR, 'ov_a.png');
  const imgB = path.join(process.env.CRAB_TEMP_DIR, 'ov_b.png');
  fs.writeFileSync(imgA, solidFrame('green', 'png'));
  fs.writeFileSync(imgB, solidFrame('blue', 'png'));
  const green = solidFrame('green', 'png');
  const files = Array.from({ length: FRAMES }, (_, i) => ({ name: `trans_ov__${String(i).padStart(4, '0')}.png`, buf: green, type: 'image/png' }));
  const K3 = randomKey();
  const pair = [imgA, imgB];
  let res = await lookup(baseUrl, [{ key: K3, source_path: pair }]);
  assert.deepStrictEqual([res.results[0].hit, res.results[0].cacheable], [false, true], 'mảng nguồn hợp lệ phải cache được');
  const first = await exportWith(baseUrl, [seqItem('trans_ov', {
    frame_files: files.map((f) => f.name), cache_key: K3, source_path: pair, cache_meta: { width: 96, height: 64, duration: FRAMES / FPS },
  })], files);
  assert.strictEqual(first.status, 200, `lượt có khung (mảng nguồn) lỗi: ${first.text}`);
  res = await lookup(baseUrl, [{ key: K3, source_path: pair }, { key: K3, source_path: [imgB, imgA] }]);
  assert.strictEqual(res.results[0].hit, true, 'cùng mảng nguồn phải trúng');
  assert.strictEqual(res.results[1].hit, false, 'đổi thứ tự nguồn là khoá khác');
  const second = await exportWith(baseUrl, [seqItem('trans_ov', { cache_key: K3, source_path: pair })]);
  assert.strictEqual(second.status, 200, `lượt chỉ gửi khoá (mảng nguồn) lỗi: ${second.text}`);
  assert.deepStrictEqual(frameMd5(second.out), frameMd5(first.out), 'bản xuất từ cache phải trùng bản có khung');
  fs.writeFileSync(imgB, solidFrame('white', 'png'));
  res = await lookup(baseUrl, [{ key: K3, source_path: pair }, { key: K3, source_path: [imgA, ''] },
    { key: K3, source_path: [] }, { key: K3, source_path: [imgA, path.join(tempDir, 'ngoai_thu_muc.png')] }]);
  assert.deepStrictEqual([res.results[0].hit, res.results[0].cacheable], [false, true], 'một tệp nguồn đổi thì phải trượt');
  assert.strictEqual(res.results[1].cacheable, false, 'phần tử rỗng -> không cache được');
  assert.strictEqual(res.results[2].cacheable, false, 'mảng rỗng -> không cache được');
  assert.strictEqual(res.results[3].cacheable, false, 'tệp ngoài thư mục cho phép -> không cache được');
  console.log('  [ok] nhiều tệp nguồn: cất, trúng, thứ tự, một tệp đổi, phần tử hỏng');
}

function testModulePrune() {
  const dir = path.join(tempDir, 'prune');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(tempDir, 'src.bin');
  fs.writeFileSync(src, crypto.randomBytes(1000));
  const frame = path.join(tempDir, 'f.png');
  fs.writeFileSync(frame, crypto.randomBytes(4000));
  const cache = createPrebakeCache({
    dir, allowed: true, enabled: () => true, resolveSource: (p) => (p === 'SRC' ? src : null),
    salt: () => 'test', ttlMs: 60 * 60 * 1000, maxBytes: 20000,
  });
  const names = [0, 1, 2].map(() => cache.entryName(randomKey(), undefined));
  names.forEach((n) => assert.ok(cache.storeFiles(n, [frame, frame], { seq: {} }), 'storeFiles phải cất được'));
  assert.strictEqual(cache.entryName(randomKey(), 'NOPE'), null, 'nguồn không hợp lệ -> không cache');
  assert.ok(cache.entryName(randomKey(), 'SRC'), 'nguồn hợp lệ -> có tên mục');
  // mục 0 quá hạn, mục 1 dùng lâu hơn mục 2; thư mục tạm bỏ dở 2 giờ trước
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, names[0], 'meta.json'), old, old);
  const older = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(path.join(dir, names[1], 'meta.json'), older, older);
  const tmp = path.join(dir, `${names[2]}.tmp-1-abcd`);
  fs.mkdirSync(tmp);
  fs.utimesSync(tmp, old, old);
  // thêm mục 3 (mới nhất) -> tổng 3 mục × ~8 KB > 20000 -> bỏ mục 1 (cũ nhất còn hạn)
  const n3 = cache.entryName(randomKey(), undefined);
  cache.storeFiles(n3, [frame, frame], { seq: {} });
  cache.prune();
  const left = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(left, [names[2], n3].sort(), `dọn sai: còn ${left.join(', ')}`);
  console.log('  [ok] mô-đun: dọn thư mục tạm, mục quá hạn, vượt trần (cũ nhất trước)');
}

async function main() {
  testModulePrune();
  const server = start();
  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    await testEndpoints(baseUrl);
    await testCubeRefs(baseUrl);
    await testMultiSource(baseUrl);
  } finally {
    server.close?.();
  }
  console.log('export_prebake_cache: OK');
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
