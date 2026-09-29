/* =====================================================================
 * SEEK THEO BATCH — mục 1.1a của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 *
 * Dự án có lớp phủ dài bị chia batch ~180 s (xem export_long_subtitles.js). Trước bản sửa,
 * mỗi batch mở nguồn bằng `-i` KHÔNG seek nên giải mã lại từ giây 0: dự án phụ đề 4K AV1 39 phút
 * mất ~27 phút chỉ cho phần giải mã thừa (batch cuối 24,8 s phim mà chạy 255 s). Nay batch chỉ-hình
 * mở bằng `-itsoffset S -ss S -i` — PTS giữ nguyên nên filter script không đổi gì.
 *
 * Bài test chốt ĐÚNG điều bản sửa hứa: bật hay tắt seek, bản xuất RA Y HỆT.
 *   1. có seek thật (batch 2 trở đi có `seek_to` > 0), và tắt được bằng CRABBYCUT_EXPORT_SEEK=0;
 *   2. hình khớp TỪNG KHUNG (framemd5) — nguồn testsrc2 nên khung nào cũng khác nhau, lệch một
 *      khung ở bất kỳ mối ghép nào là lộ ngay;
 *   3. tiếng khớp TỪNG BYTE — lượt tiếng không được seek (xem BatchSeekSeconds: AAC giải mã từ
 *      giữa file cho mẫu khác đi vài LSB).
 * Ba bố cục: một clip dài (dạng phụ đề), nhiều clip đảo thứ tự (mốc nguồn sớm nhất của batch
 * không phải clip đầu tiên của nó), và bản nối `-c copy` từ hai cấu hình mã hoá khác nhau.
 *
 * Chạy: npm run test:export-batch-seek
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_batch_seek');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const SECONDS = 420;
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
  const total = intervals.reduce((s, it) => s + (it.end - it.start), 0);
  const overlays = [];
  // Lớp phủ ảnh TĨNH trải đều, chừa khe để bộ hoạch định có chỗ cắt batch an toàn.
  for (let i = 0; i < 30; i += 1) {
    overlays.push({
      index: i, id: `item_text_${i}`, type: 'media', asset_type: 'text_image', asset_path: overlayPng,
      timeline_start: Number(((i / 30) * (total - 3)).toFixed(3)), duration: 1.5, source_start: 0,
      position_x: 40, position_y: 20, scale: 100, opacity: 100, track_id: 'track_text_1', track_order: 0,
      muted: true, volume: 0, has_audio: false,
    });
  }
  fs.writeFileSync(file, JSON.stringify({
    version: 4,
    sequence: { width: 320, height: 180, fps: String(FPS) },
    intervals: intervals.map((it, index) => ({ index, script_index: index, text: `c${index}`, ...it })),
    editingTracks: [{ id: 'track_text_1', type: 'text', order: 0, visible: true, muted: false, volume: 100 }],
    editingItems: [], assets: [], main_audio_volume: 100, overlays,
    settings: { resolution: 'sequence', width: 320, height: 180, fps: String(FPS), codec: 'h264', quality: 'small', audio_bitrate: '128k', render_fps: String(FPS) },
  }), 'utf8');
}

function exportOnce(source, timelineFile, output, seek) {
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 900000,
    // CPU cho tất định và chạy được trên máy không có NVENC.
    env: { ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_SEEK: seek ? '1' : '0' },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại (seek=${seek}):\n${r.stdout}\n${r.stderr}`);
  const timing = r.stdout.split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .find((e) => e && e.type === 'timing');
  assert.ok(timing, `sidecar phải phát sự kiện timing:\n${r.stdout}`);
  // Batch trung gian to bằng chính bản xuất (4K 39 phút: ~11,5 GB) -> phải dọn ngay sau khi ghép.
  assert.ok(!fs.existsSync(path.join(TEST_DIR, 'export_batches')), 'thư mục batch trung gian phải được xoá sau khi ghép xong');
  return { runs: JSON.parse(timing.message).runs, log: r.stdout };
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

function compareLayout(name, source, intervals, overlayPng, minBatches) {
  const timelineFile = path.join(TEST_DIR, `${name}.json`);
  writeTimeline(timelineFile, intervals, overlayPng);
  const off = exportOnce(source, timelineFile, path.join(TEST_DIR, `${name}_noseek.mp4`), false);
  const on = exportOnce(source, timelineFile, path.join(TEST_DIR, `${name}_seek.mp4`), true);
  const videoOff = off.runs.filter((r) => r.mode === 'video');
  const videoOn = on.runs.filter((r) => r.mode === 'video');
  assert.ok(videoOn.length >= minBatches, `${name}: phải chia ít nhất ${minBatches} batch hình, đang ${videoOn.length}`);
  assert.ok(videoOff.every((r) => !r.seek_to), `${name}: CRABBYCUT_EXPORT_SEEK=0 thì không batch nào được seek`);
  const seeked = videoOn.filter((r) => r.seek_to > 0);
  assert.ok(seeked.length >= videoOn.length - 1, `${name}: batch 2 trở đi phải seek, đang ${JSON.stringify(videoOn.map((r) => r.seek_to))}`);
  for (const r of seeked) {
    // ~1 s lề; cộng thêm tối đa 0,1 s vì seek tính cả mốc bắt đầu của luồng hình (videoStart,
    // bản nối `-c copy` có thể lệch vài chục ms).
    assert.ok(r.seek_to <= r.source_from - 0.9, `${name}/${r.label}: seek ${r.seek_to} phải sớm hơn mốc nguồn đầu ${r.source_from} khoảng 1 s`);
  }
  assert.ok(on.runs.filter((r) => r.mode !== 'video').every((r) => !r.seek_to), `${name}: lượt có tiếng không được seek`);

  const a = frameHashes(path.join(TEST_DIR, `${name}_noseek.mp4`));
  const b = frameHashes(path.join(TEST_DIR, `${name}_seek.mp4`));
  assert.strictEqual(b.length, a.length, `${name}: số khung lệch (${a.length} không seek, ${b.length} có seek)`);
  const firstDiff = a.findIndex((h, i) => h !== b[i]);
  assert.strictEqual(firstDiff, -1, `${name}: khung ${firstDiff} (≈${(firstDiff / FPS).toFixed(2)} s) khác nhau giữa có và không seek`);
  assert.ok(audioBytes(path.join(TEST_DIR, `${name}_seek.mp4`)).equals(audioBytes(path.join(TEST_DIR, `${name}_noseek.mp4`))),
    `${name}: tiếng phải giống từng byte`);
  console.log(`  ok  ${name}: ${videoOn.length} batch, seek ${seeked.map((r) => r.seek_to.toFixed(1)).join('/')} s — ${a.length} khung khớp framemd5, tiếng khớp từng byte`);
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_batch_seek: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const source = path.join(TEST_DIR, 'temp_input.mp4');
  makeSource(source, SECONDS);
  const overlayPng = path.join(TEST_DIR, 'sub.png');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red@0.8:size=120x40,format=rgba', '-frames:v', '1', overlayPng], 'png');

  // 1. Một clip dài — đúng hình dạng dự án phụ đề.
  compareLayout('one_clip', source, [{ start: 0, end: SECONDS }], overlayPng, 3);
  // 2. Nhiều clip đảo thứ tự (350 s -> 2 batch): batch 1 mở đầu bằng nguồn 300 s nhưng mốc sớm
  //    nhất của nó là 20 s; batch 2 cắt giữa clip 20–130 s. Cả hai đều phải seek đúng mốc sớm nhất.
  compareLayout('reordered', source, [
    { start: 300, end: 400 }, { start: 20, end: 130 }, { start: 210, end: 290 }, { start: 140, end: 200 },
  ], overlayPng, 2);

  // 3. Bản nối `-c copy` từ hai cấu hình x264 khác nhau (khác SPS/PPS, đoạn sau không lặp header
  //    trong luồng) — đúng loại file mà kế hoạch lo seek vào đoạn 2 sẽ giải mã sai. Đo 2026-09-28:
  //    mp4 do ffmpeg nối vẫn cho bản xuất y hệt khi seek, nên ca này phải ĐẠT như hai ca trên.
  //    (SourceSeekSafe vẫn chặn file mang side data "New Extradata" — chốt phòng hờ, chưa gặp
  //    trên file thật, và không dựng được bằng ffmpeg để test.)
  const partA = path.join(TEST_DIR, 'part_a.mp4');
  const partB = path.join(TEST_DIR, 'part_b.mp4');
  makeSource(partA, 200);
  makeSource(partB, 220, 'ref=2:no-deblock=1');
  const list = path.join(TEST_DIR, 'parts.txt');
  fs.writeFileSync(list, `file '${partA.replace(/\\/g, '/')}'\nfile '${partB.replace(/\\/g, '/')}'\n`);
  const mixed = path.join(TEST_DIR, 'mixed_input.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', mixed], 'concat');
  compareLayout('mixed_encoders', mixed, [{ start: 0, end: 410 }], overlayPng, 3);

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export batch seek ok');
}

main();
