/* =====================================================================
 * MỖI DẢI NGUỒN MỘT INPUT — mục 1.1 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 *
 * Trước: mọi clip lane chính đọc cùng một [0:v], bộ giải mã chạy một mạch từ đầu tới mốc cuối
 * batch cần, mỗi khung phát tới đủ N nhánh `trim`. Nay các cửa sổ `trim` được gom thành dải, mỗi
 * dải một input `-itsoffset S -ss S` (xem PlanSourceRanges) — PTS giữ nguyên nên filter script
 * chỉ đổi chỉ số input.
 *
 * Bài test chốt ĐÚNG điều bản sửa hứa: bật hay tắt (CRABBYCUT_EXPORT_RANGES=0), bản xuất RA Y HỆT.
 *   1. có dải thật (`source_ranges` trong sự kiện timing) và mốc seek hợp lý;
 *   2. hình khớp TỪNG KHUNG (framemd5) — nguồn testsrc2 nên khung nào cũng khác nhau;
 *   3. tiếng khớp TỪNG BYTE (lượt tiếng không dùng dải);
 * Bố cục: clip rải khắp nguồn và đảo thứ tự (có clip dùng lại cùng đoạn, clip chồng nhau), nhiều
 * clip hơn trần số dải (phải gộp), clip đổi tốc độ, dự án không lớp phủ (nhánh 80 clip), và bản nối
 * `-c copy` hai cấu hình mã hoá (SourceSeekSafe = false -> không được dùng dải).
 *
 * Chạy: npm run test:export-source-ranges
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_source_ranges');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const SECONDS = 300;
const FPS = 24;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

function makeSource(target, seconds, x264Params) {
  // GOP 2 s + B-frame: seek phải rơi về keyframe TRƯỚC mốc và giải mã tới mốc, như nguồn thật.
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${FPS}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(FPS * 2), '-bf', '2', '-pix_fmt', 'yuv420p',
    ...(x264Params ? ['-x264-params', x264Params] : []),
    '-c:a', 'aac', '-b:a', '96k', '-shortest', target], 'không dựng được nguồn');
}

function writeTimeline(file, intervals, overlayPng) {
  const total = intervals.reduce((s, it) => s + (it.end - it.start) / (it.speed_rate || 1), 0);
  const overlays = overlayPng ? [0, 1, 2].map((i) => ({
    index: i, id: `item_text_${i}`, type: 'media', asset_type: 'text_image', asset_path: overlayPng,
    timeline_start: Number(((i / 3) * (total - 2)).toFixed(3)), duration: 1.5, source_start: 0,
    position_x: 40, position_y: 20, scale: 100, opacity: 100, track_id: 'track_text_1', track_order: 0,
    muted: true, volume: 0, has_audio: false,
  })) : [];
  fs.writeFileSync(file, JSON.stringify({
    version: overlays.length ? 4 : 3,
    sequence: { width: 320, height: 180, fps: String(FPS) },
    intervals: intervals.map((it, index) => ({ index, script_index: index, text: `c${index}`, ...it })),
    editingTracks: [{ id: 'track_text_1', type: 'text', order: 0, visible: true, muted: false, volume: 100 }],
    editingItems: [], assets: [], main_audio_volume: 100, overlays,
    settings: { resolution: 'sequence', width: 320, height: 180, fps: String(FPS), codec: 'h264', quality: 'small', audio_bitrate: '128k', render_fps: String(FPS) },
  }), 'utf8');
}

function exportOnce(source, timelineFile, output, ranges) {
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 900000,
    // CPU cho tất định và chạy được trên máy không có NVENC. Một lượt (không chia batch song song,
    // mục 1.8): bài này đếm dải nguồn của MỘT lượt ffmpeg; chia batch thì mỗi batch gom dải riêng.
    env: { ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_RANGES: ranges ? '1' : '0', CRABBYCUT_EXPORT_PARALLEL: '1' },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại (ranges=${ranges}):\n${r.stdout}\n${r.stderr}`);
  const timing = r.stdout.split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .find((e) => e && e.type === 'timing');
  assert.ok(timing, `sidecar phải phát sự kiện timing:\n${r.stdout}`);
  return JSON.parse(timing.message).runs;
}

function frameHashes(file) {
  return mustRun('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], 'framemd5')
    .stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

function audioBytes(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, r.stderr?.toString('utf8'));
  return r.stdout;
}

function compareLayout(name, source, intervals, overlayPng, expectRanges) {
  const timelineFile = path.join(TEST_DIR, `${name}.json`);
  writeTimeline(timelineFile, intervals, overlayPng);
  const offOut = path.join(TEST_DIR, `${name}_off.mp4`);
  const onOut = path.join(TEST_DIR, `${name}_on.mp4`);
  const off = exportOnce(source, timelineFile, offOut, false);
  const on = exportOnce(source, timelineFile, onOut, true);
  assert.ok(off.every((r) => !r.source_ranges), `${name}: CRABBYCUT_EXPORT_RANGES=0 thì không lượt nào dùng dải`);
  const videoRuns = on.filter((r) => r.mode !== 'audio');
  const used = videoRuns.map((r) => r.source_ranges);
  expectRanges(used, on);
  assert.ok(on.filter((r) => r.mode === 'audio').every((r) => !r.source_ranges), `${name}: lượt tiếng không được dùng dải`);

  const a = frameHashes(offOut);
  const b = frameHashes(onOut);
  assert.strictEqual(b.length, a.length, `${name}: số khung lệch (${a.length} không dải, ${b.length} có dải)`);
  const firstDiff = a.findIndex((h, i) => h !== b[i]);
  assert.strictEqual(firstDiff, -1, `${name}: khung ${firstDiff} (≈${(firstDiff / FPS).toFixed(2)} s) khác nhau giữa có và không dải`);
  assert.ok(audioBytes(onOut).equals(audioBytes(offOut)), `${name}: tiếng phải giống từng byte`);
  console.log(`  ok  ${name}: dải ${JSON.stringify(used)} — ${a.length} khung khớp framemd5, tiếng khớp từng byte`);
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_source_ranges: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const source = path.join(TEST_DIR, 'temp_input.mp4');
  makeSource(source, SECONDS);
  const overlayPng = path.join(TEST_DIR, 'sub.png');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red@0.8:size=120x40,format=rgba', '-frames:v', '1', overlayPng], 'png');

  // 1. Rải khắp nguồn + đảo thứ tự; clip 3 dùng lại đúng đoạn của clip 0, clip 4 chồng lên clip 1.
  //    Một batch có tiếng (tổng < 240 s): mọi dải là input thêm, input 0 giữ tiếng.
  compareLayout('scattered', source, [
    { start: 200, end: 204.5 }, { start: 30.25, end: 36 }, { start: 150, end: 152 },
    { start: 200, end: 204.5 }, { start: 34, end: 40 }, { start: 280.5, end: 286 }, { start: 8, end: 11 },
  ], overlayPng, (used) => {
    // 200..204.5 (hai clip) và các dải khác nhau: 8–11, 30,25–40 (hai clip chồng), 150, 200, 280,5
    assert.deepStrictEqual(used, [5], `scattered: phải gom đúng 5 dải, đang ${JSON.stringify(used)}`);
  });
  // 2. Nhiều clip hơn trần (nguồn 320x180 -> tối đa 12 dải): 20 clip cách nhau 14 s -> gộp còn 12.
  const many = [];
  for (let i = 0; i < 20; i += 1) many.push({ start: 5 + i * 14, end: 5 + i * 14 + 2 });
  compareLayout('many', source, many, overlayPng, (used) => {
    assert.deepStrictEqual(used, [12], `many: phải gộp về 12 dải, đang ${JSON.stringify(used)}`);
  });
  // 3. Đổi tốc độ: nguồn đọc dài/ngắn hơn phần sequence — cửa sổ trim tính theo giờ NGUỒN.
  compareLayout('speed', source, [
    { start: 120, end: 128, speed_rate: 2 }, { start: 60, end: 62, speed_rate: 0.5 }, { start: 250, end: 256, speed_rate: 1.5 },
  ], overlayPng, (used) => {
    assert.deepStrictEqual(used, [3], `speed: phải có 3 dải, đang ${JSON.stringify(used)}`);
  });
  // 4. Không lớp phủ (nhánh 80 clip): cũng dùng dải.
  compareLayout('no_overlay', source, [
    { start: 250, end: 253 }, { start: 20, end: 24 }, { start: 180, end: 183 },
  ], null, (used) => {
    assert.deepStrictEqual(used, [3], `no_overlay: phải có 3 dải, đang ${JSON.stringify(used)}`);
  });
  // 5. Bản nối `-c copy` hai cấu hình x264 khác nhau: SourceSeekSafe có thể false -> không dải; nếu
  //    demuxer không báo chỗ đổi (mp4 do ffmpeg nối) thì dùng dải và bản xuất vẫn phải y hệt.
  const partA = path.join(TEST_DIR, 'part_a.mp4');
  const partB = path.join(TEST_DIR, 'part_b.mp4');
  makeSource(partA, 150);
  makeSource(partB, 150, 'repeat-headers=1:bframes=0');
  const list = path.join(TEST_DIR, 'parts.txt');
  fs.writeFileSync(list, `file '${partA.replace(/\\/g, '/')}'\nfile '${partB.replace(/\\/g, '/')}'\n`);
  const mixed = path.join(TEST_DIR, 'mixed.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', mixed], 'nối -c copy');
  compareLayout('mixed_encoders', mixed, [
    { start: 200, end: 204 }, { start: 40, end: 44 }, { start: 140, end: 160 },
  ], overlayPng, (used) => {
    assert.ok(used[0] === 0 || used[0] === 3, `mixed_encoders: 0 dải (không seek được) hoặc 3 dải, đang ${JSON.stringify(used)}`);
  });

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export source ranges ok');
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
