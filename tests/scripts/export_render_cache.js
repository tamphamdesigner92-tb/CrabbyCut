/* =====================================================================
 * BỘ NHỚ ĐỆM RENDER CHO LƯỢT XUẤT LẠI — mục 1.13 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 * (RenderCacheKey / RenderCacheLookup / RenderCacheStore ở sidecar).
 *
 * Dự án 42 s, 3 batch hình (PARALLEL=3, cắt ở biên clip 14 s / 28 s), mỗi batch một ảnh lớp phủ;
 * ảnh ở batch 1 và 2 có độ mờ keyframe (mỗi cái sinh một tệp lệnh sendcmd cạnh filter script). Chốt:
 *   1. lượt đầu render đủ 3 batch hình + lượt tiếng và cất cả 4 vào cache;
 *   2. ghi lại ảnh lớp phủ với NỘI DUNG Y HỆT (mtime mới, như frontend bake lại mỗi lượt xuất) -> trùng
 *      cả 4, bản xuất trùng lượt đầu từng khung + từng mẫu tiếng;
 *   3. thêm keyframe độ mờ cho ảnh batch 0 (batch 0 có thêm một tệp lệnh -> trước bản sửa, số thứ tự tệp
 *      lệnh của mọi batch sau đổi theo) + đổi nội dung ảnh batch 2 -> chỉ batch 1 và lượt tiếng trùng; bản
 *      xuất trùng từng khung với bản render lại từ đầu không cache (H.264: batch cũ + mới ghép `-c copy`);
 *   4. đổi âm lượng tiếng gốc -> mọi batch hình trùng, lượt tiếng chạy lại; tiếng trùng bản không cache;
 *   5. trần dung lượng: tổng cache sau lượt xuất không vượt CRABBYCUT_RENDER_CACHE_MAX_BYTES;
 *   6. ổ còn ít chỗ (CRABBYCUT_RENDER_CACHE_MIN_FREE_BYTES) -> render bình thường, không cất gì;
 *   7. không truyền CRABBYCUT_RENDER_CACHE_DIR -> tắt hẳn.
 *
 * Chạy: npm run test:export-render-cache
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_render_cache');
const CACHE_DIR = path.join(TEST_DIR, 'render_cache');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const W = 320;
const H = 180;
const CLIPS = [7, 7, 7, 7, 7, 7];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

function makePng(file, color) {
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=48x24,format=rgba`,
    '-frames:v', '1', file], 'ảnh lớp phủ');
}

// Ghi lại tệp với nội dung y hệt -> mtime mới (định danh theo nội dung phải không đổi).
function rewriteSame(file) {
  const data = fs.readFileSync(file);
  fs.rmSync(file);
  fs.writeFileSync(file, data);
}

function writeTimeline(file, images, opacityExprs, mainVolume = 100) {
  const base = { source_start: 0, scale: 100, opacity: 100, muted: true, volume: 0, has_audio: false };
  const spans = [[2, 4], [16, 4], [30, 4]];
  const overlays = spans.map(([start, duration], i) => ({
    ...base, index: i, id: `item_still_${i}`, type: 'media', asset_type: 'text_image', asset_path: images[i],
    timeline_start: start, duration, position_x: -60 + 60 * i, position_y: -40,
    track_id: 'track_text_1', track_order: 0,
    ...(opacityExprs[i] ? { kf_opacity_expr: opacityExprs[i] } : {}),
  }));
  const intervals = CLIPS.map((d, i) => ({ index: i, script_index: i, text: `c${i}`, start: 10 * i, end: 10 * i + d }));
  fs.writeFileSync(file, JSON.stringify({
    version: 4,
    sequence: { width: W, height: H, fps: 'source' },
    intervals,
    editingTracks: [{ id: 'track_text_1', type: 'text', order: 0, visible: true, muted: false, volume: 100 }],
    editingItems: [], assets: [], main_audio_volume: mainVolume, overlays,
    settings: { resolution: 'sequence', width: W, height: H, fps: 'source', codec: 'h264', quality: 'high',
      audio_bitrate: '128k', render_fps: '25' },
  }), 'utf8');
}

function timingOf(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'timing') return JSON.parse(event.message);
    } catch (_) { /* không phải JSON */ }
  }
  return null;
}

function exportOnce(source, timelineFile, output, cacheEnv) {
  const env = { ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_PARALLEL: '3' };
  delete env.CRABBYCUT_RENDER_CACHE_DIR;
  Object.assign(env, cacheEnv);
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, TEST_DIR, 'sequence', 'source'],
    { timeout: 600000, env });
  assert.strictEqual(r.status, 0, `xuất thất bại:\n${r.stdout}\n${r.stderr}`);
  const timing = timingOf(r.stdout);
  assert.ok(timing, 'sidecar phải phát sự kiện timing');
  return timing;
}

const cacheOn = (extra = {}) => ({ CRABBYCUT_RENDER_CACHE_DIR: CACHE_DIR, CRABBYCUT_RENDER_CACHE_MIN_FREE_BYTES: '0', ...extra });
const videoRuns = (t) => (t.runs || []).filter((r) => r.mode === 'video');
const hits = (t) => videoRuns(t).map((r) => r.cache_hit);
const audioHit = (t) => (t.runs || []).find((r) => r.mode === 'audio').cache_hit;

function cacheEntries() {
  let names = [];
  try { names = fs.readdirSync(CACHE_DIR); } catch (_) { return []; }
  return names.filter((n) => /^[0-9a-f]{64}\.(mp4|m4a)$/.test(n))
    .map((n) => ({ name: n, size: fs.statSync(path.join(CACHE_DIR, n)).size }));
}

function frameHashes(file) {
  return mustRun('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], 'framemd5')
    .stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

function pcm(file) {
  return spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }).stdout;
}

function sameFrames(a, b, what) {
  const fa = frameHashes(a);
  const fb = frameHashes(b);
  assert.ok(fa.length > 1000, `${what}: số khung ${fa.length}`);
  assert.strictEqual(fb.length, fa.length, `${what}: số khung lệch (${fa.length} / ${fb.length})`);
  const diff = fa.map((h, i) => (h === fb[i] ? -1 : i)).filter((i) => i >= 0);
  assert.deepStrictEqual(diff, [], `${what}: khung khác nhau: ${diff.slice(0, 12).join(', ')}`);
  return fa.length;
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_render_cache: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const source = path.join(TEST_DIR, 'temp_input.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=25:duration=62`,
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=62:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', source], 'nguồn');
  const images = ['a', 'b', 'c'].map((n) => path.join(TEST_DIR, `still_${n}.png`));
  makePng(images[0], 'yellow@0.85');
  makePng(images[1], 'cyan@0.8');
  makePng(images[2], 'magenta@0.9');
  const ramp = 'min(100,30+LOCALT*20)';
  const timelineFile = path.join(TEST_DIR, 'timeline.json');

  // 1. Lượt đầu: render đủ, cất đủ.
  writeTimeline(timelineFile, images, [null, ramp, ramp]);
  const out1 = path.join(TEST_DIR, 'out1.mp4');
  const t1 = exportOnce(source, timelineFile, out1, cacheOn());
  assert.strictEqual(videoRuns(t1).length, 3, `lượt 1: 3 batch hình, đang ${videoRuns(t1).length}`);
  assert.deepStrictEqual(hits(t1), [false, false, false], 'lượt 1: chưa có gì trong cache');
  assert.strictEqual(audioHit(t1), false, 'lượt 1: lượt tiếng chưa có trong cache');
  assert.strictEqual(t1.cache_stored, 4, 'lượt 1: cất 3 batch hình + lượt tiếng');
  assert.strictEqual(cacheEntries().length, 4, 'lượt 1: cache có 4 mục');
  console.log(`  ok  lượt 1: 3 batch hình + lượt tiếng render và cất vào cache (khoá ${t1.cache_key_ms} ms)`);

  // 2. Ảnh ghi lại nội dung y hệt -> trùng cả 3, bản xuất trùng từng khung + từng mẫu.
  images.forEach(rewriteSame);
  const out2 = path.join(TEST_DIR, 'out2.mp4');
  const t2 = exportOnce(source, timelineFile, out2, cacheOn());
  assert.deepStrictEqual(hits(t2), [true, true, true], 'lượt 2: trùng cả 3 batch');
  assert.strictEqual(audioHit(t2), true, 'lượt 2: lượt tiếng trùng');
  assert.strictEqual(t2.cache_stored, 0, 'lượt 2: không có gì mới để cất');
  const frames = sameFrames(out1, out2, 'lượt 2 so với lượt 1');
  const p1 = pcm(out1);
  assert.ok(p1.length > 0 && p1.equals(pcm(out2)), 'lượt 2: tiếng khác lượt 1');
  console.log(`  ok  lượt 2: dùng lại cả 3 batch + lượt tiếng, ${frames} khung + tiếng trùng lượt 1`);

  // 3. Batch 0 thêm tệp lệnh, batch 2 đổi ảnh -> chỉ batch 1 trùng; trùng bản render lại không cache.
  makePng(images[2], 'green@0.9');
  writeTimeline(timelineFile, images, [ramp, ramp, ramp]);
  const out3 = path.join(TEST_DIR, 'out3.mp4');
  const t3 = exportOnce(source, timelineFile, out3, cacheOn());
  assert.deepStrictEqual(hits(t3), [false, true, false], 'lượt 3: chỉ batch 1 không đổi');
  assert.strictEqual(audioHit(t3), true, 'lượt 3: chỉ hình đổi -> lượt tiếng trùng');
  assert.strictEqual(t3.cache_stored, 2, 'lượt 3: cất 2 batch mới');
  const ref = path.join(TEST_DIR, 'ref3.mp4');
  const tRef = exportOnce(source, timelineFile, ref, {});
  assert.deepStrictEqual(hits(tRef), [false, false, false], 'không truyền thư mục cache: tắt hẳn');
  assert.strictEqual(tRef.cache_stored, 0, 'không truyền thư mục cache: không cất gì');
  assert.strictEqual(cacheEntries().length, 6, 'cache có 6 mục (4 cũ + 2 mới)');
  sameFrames(out3, ref, 'lượt 3 (batch cũ + mới) so với render lại từ đầu');
  assert.ok(pcm(out3).equals(pcm(ref)), 'lượt 3: tiếng khác bản render lại');
  console.log('  ok  lượt 3: chỉ batch không đổi được dùng lại; bản ghép trùng bản render lại từng khung');

  // 4. Đổi âm lượng tiếng gốc: hình trùng hết, tiếng chạy lại và trùng bản render lại không cache.
  writeTimeline(timelineFile, images, [ramp, ramp, ramp], 70);
  const out4a = path.join(TEST_DIR, 'out4a.mp4');
  const t4a = exportOnce(source, timelineFile, out4a, cacheOn());
  assert.deepStrictEqual(hits(t4a), [true, true, true], 'lượt 4: âm lượng không đụng batch hình');
  assert.strictEqual(audioHit(t4a), false, 'lượt 4: đổi âm lượng -> lượt tiếng chạy lại');
  const ref4 = path.join(TEST_DIR, 'ref4.mp4');
  exportOnce(source, timelineFile, ref4, {});
  const p4 = pcm(out4a);
  assert.ok(p4.length > 0 && p4.equals(pcm(ref4)) && !p4.equals(pcm(out3)), 'lượt 4: tiếng phải là tiếng mới (70%), trùng bản không cache');
  sameFrames(out4a, ref4, 'lượt 4 so với render lại từ đầu');
  console.log('  ok  lượt 4: đổi âm lượng — hình dùng lại, tiếng render lại đúng');

  // 5. Trần dung lượng: mục mới dùng giữ lại, tổng không vượt trần.
  const biggest = Math.max(...cacheEntries().map((e) => e.size));
  const cap = biggest * 2 + 1;
  const t4 = exportOnce(source, timelineFile, path.join(TEST_DIR, 'out4.mp4'),
    cacheOn({ CRABBYCUT_RENDER_CACHE_MAX_BYTES: String(cap) }));
  assert.deepStrictEqual(hits(t4), [true, true, true], 'lượt 5: trùng cả 3');
  const left = cacheEntries();
  const total = left.reduce((s, e) => s + e.size, 0);
  assert.ok(total <= cap && left.length >= 1 && left.length < 7, `lượt 5: còn ${left.length} mục, ${total} byte, trần ${cap}`);
  console.log(`  ok  lượt 5: dọn theo trần — còn ${left.length} mục (${total} / ${cap} byte)`);

  // 6. Ổ "đầy": render, không cất.
  makePng(images[1], 'orange@0.8');
  const before = cacheEntries().length;
  const t5 = exportOnce(source, timelineFile, path.join(TEST_DIR, 'out5.mp4'),
    cacheOn({ CRABBYCUT_RENDER_CACHE_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) }));
  assert.strictEqual(hits(t5)[1], false, 'lượt 6: batch 1 đổi ảnh phải render lại');
  assert.strictEqual(t5.cache_stored, 0, 'lượt 6: ổ thiếu chỗ thì không cất');
  assert.ok(cacheEntries().length <= before, 'lượt 6: cache không thêm mục');
  console.log('  ok  lượt 6: ổ thiếu chỗ — render bình thường, không cất');

  if (!process.env.KEEP_TEST_DIR) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export render cache ok');
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
