/* =====================================================================
 * XUẤT SONG SONG NHIỀU BATCH = XUẤT MỘT LƯỢT, TỪNG KHUNG VÀ TỪNG MẪU — mục 1.8 của
 * docs/KE_HOACH_TOI_UU_EXPORT_WIN.md (ExportParallelWorkers / RunExportJobs ở sidecar).
 *
 * Dự án ngắn có lớp phủ nay được chia vài batch ở BIÊN CLIP và chạy cùng lúc. Bài test chốt, cho
 * từng kịch bản:
 *   1. bản chia batch (CRABBYCUT_EXPORT_PARALLEL=3) và bản một lượt (=1) giống hệt: framemd5 hình
 *      và PCM tiếng. Xuất ProRes (nén nội khung) để phần mã hoá không phụ thuộc chỗ cắt;
 *   2. lượt song song thật sự chia ≥ 3 batch và chạy 3 lượt hình cùng lúc;
 *   3. chuỗi khung (mỗi khung một mức xám) hiện ĐÚNG khung dự định: khung k ở khung nền S+k, khung
 *      S−1 chưa có, sau cửa sổ đã hết. Trước bản sửa, mốc đầu của chuỗi bị `setpts` cắt phần lẻ
 *      (sớm một khung, khung 0 rơi ngoài cửa sổ `enable`), và khung "hoà" (chuỗi bake đúng nhịp
 *      xuất) đổi phe theo làm tròn µs — tức theo số mẫu tiếng và theo chỗ cắt batch.
 *
 * Nhịp xuất là nhịp THẬT của "Bin Tom" (iPhone): 1218000/40601 = 29,99926… khung/s — mốc đoạn và số
 * mẫu tiếng mỗi đoạn đều lẻ, và in 6 chữ số ra 29.999261 (làm tròn XUỐNG: `-framerate` của chuỗi khung
 * chậm hơn lưới xuất một chút). Nhịp NTSC (29.970030, làm tròn lên) không lộ ra lỗi nào. Nguồn 25
 * khung/s (có đổi nhịp). Lớp phủ trong mọi kịch bản: chuỗi khung 45 khung ở khung 452; video cùng nhịp
 * xuất đặt đúng khung 900 ("hoà" ở mọi khung, nhất là khung cuối cửa sổ); ảnh tĩnh vắt qua một mốc cắt
 * (được xén theo batch). Hai kịch bản vì mỗi bố cục làm lộ một nhóm lỗi khác (đã thử bằng đột biến):
 *   A. 6 clip × 7 s, tiếng 48 kHz, ảnh tĩnh 10–20 s vắt qua mốc 14 s;
 *   B. 12 clip dài lẻ (2,7–4,3 s), tiếng 44,1 kHz (đổi mẫu lên 48 kHz -> độ dài đoạn tiếng lẻ mẫu), ảnh
 *      tĩnh 8–12 s vắt qua mốc 9,7 s và một ảnh ở batch cuối.
 * Batch nào cũng có lớp phủ: ProRes ghép mọi lớp phủ ở RGBA, nên ở bản một lượt CẢ luồng đi vòng
 * YUV -> RGBA -> YUV; batch không có lớp phủ nào thì khỏi vòng đó (đúng hơn, nhưng khác bản một lượt).
 *
 * Chạy: npm run test:export-parallel
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_parallel');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const FPS_TEXT = '1218000/40601';
const FPS = 1218000 / 40601;
const W = 320;
const H = 180;
const SEQ_START_FRAME = 452;   // `setpts` cắt phần lẻ (lỗi cũ) thì chuỗi sớm một khung
const SEQ_FRAMES = 45;
const SEQ_SIZE = 64;
const VIDEO_START_FRAME = 900;
const level = (k) => 20 + 5 * k;   // mức xám (RGB) của khung k trong chuỗi

const SCENARIOS = [
  { name: 'A', audioRate: 48000, spacing: 10, clips: [7, 7, 7, 7, 7, 7], stills: [[10, 10]] },
  { name: 'B', audioRate: 44100, spacing: 5, clips: [3.1, 3.7, 2.9, 4.3, 3.3, 3.9, 2.7, 4.1, 3.5, 3.0, 3.6, 4.2],
    stills: [[8, 4], [36, 4]] },
];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

function makeSharedAssets() {
  const seqDir = path.join(TEST_DIR, 'seq');
  fs.mkdirSync(seqDir, { recursive: true });
  for (let k = 0; k < SEQ_FRAMES; k++) {
    const v = level(k).toString(16).padStart(2, '0');
    mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${v}${v}${v}:s=${SEQ_SIZE}x${SEQ_SIZE}`,
      '-frames:v', '1', '-pix_fmt', 'rgba', path.join(seqDir, `frame_${String(k).padStart(4, '0')}.png`)], 'khung chuỗi');
  }
  const still = path.join(TEST_DIR, 'still.png');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=yellow@0.85:s=40x20,format=rgba',
    '-frames:v', '1', still], 'ảnh tĩnh');
  const clip = path.join(TEST_DIR, 'overlay_video.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=64x36:rate=${FPS_TEXT}:duration=6`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip], 'video lớp phủ');
  return { seqDir, still, clip };
}

function makeSource(dir, audioRate) {
  const source = path.join(dir, 'temp_input.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=25:duration=62`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=62:sample_rate=${audioRate}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', source], 'nguồn');
  return source;
}

function writeTimeline(file, assets, scenario) {
  const base = { source_start: 0, scale: 100, opacity: 100, muted: true, volume: 0, has_audio: false };
  const overlays = scenario.stills.map(([start, duration], i) => ({
    ...base, index: i, id: `item_still_${i}`, type: 'media', asset_type: 'text_image', asset_path: assets.still,
    timeline_start: start, duration, position_x: i ? 80 : -100, position_y: i ? -60 : -50,
    track_id: 'track_text_1', track_order: 0,
  }));
  overlays.push(
    { ...base, index: overlays.length, id: 'item_seq_anim', type: 'media', asset_type: 'image_seq',
      asset_path: path.join(assets.seqDir, 'frame_%04d.png'), seq_fps: FPS, frame_count: SEQ_FRAMES,
      timeline_start: SEQ_START_FRAME / FPS, duration: SEQ_FRAMES / FPS, position_x: 0, position_y: 0,
      track_id: 'track_text_2', track_order: 1 },
    { ...base, index: overlays.length + 1, id: 'item_video', type: 'media', asset_type: 'media_video',
      asset_path: assets.clip, timeline_start: VIDEO_START_FRAME / FPS, duration: 4, position_x: 100, position_y: 50,
      track_id: 'track_media_1', track_order: 2 },
  );
  // Clip cách quãng trên nguồn (dải nguồn + seek theo batch đều được dùng).
  const intervals = scenario.clips.map((d, i) => ({
    index: i, script_index: i, text: `c${i}`, start: scenario.spacing * i, end: scenario.spacing * i + d,
  }));
  fs.writeFileSync(file, JSON.stringify({
    version: 4,
    sequence: { width: W, height: H, fps: 'source' },
    intervals,
    editingTracks: [
      { id: 'track_text_1', type: 'text', order: 0, visible: true, muted: false, volume: 100 },
      { id: 'track_text_2', type: 'text', order: 1, visible: true, muted: false, volume: 100 },
      { id: 'track_media_1', type: 'media', order: 2, visible: true, muted: false, volume: 100 },
    ],
    editingItems: [], assets: [], main_audio_volume: 100, overlays,
    settings: { resolution: 'sequence', width: W, height: H, fps: 'source', codec: 'prores', quality: 'high',
      audio_bitrate: '128k', render_fps: FPS_TEXT },
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

function exportOnce(dir, source, timelineFile, output, workers) {
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, dir, 'sequence', 'source'], {
    timeout: 600000,
    env: { ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_PARALLEL: String(workers) },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại (PARALLEL=${workers}):\n${r.stdout}\n${r.stderr}`);
  return timingOf(r.stdout);
}

function frameHashes(file) {
  return mustRun('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], 'framemd5')
    .stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

function pcm(file) {
  return spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }).stdout;
}

// Mức Y trung bình (8-bit, dải tv) ở giữa vùng chuỗi khung, cho từng khung trong [from, to].
function seqLumas(file, from, to) {
  const x = (W - SEQ_SIZE) / 2 + 16;
  const y = (H - SEQ_SIZE) / 2 + 16;
  const r = mustRun('ffmpeg', ['-v', 'info', '-i', file, '-vf',
    `select='between(n\\,${from}\\,${to})',crop=32:32:${x}:${y},format=yuv420p,signalstats,`
    + 'metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], 'signalstats');
  return [...r.stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
}

function checkScenario(scenario, assets) {
  const dir = path.join(TEST_DIR, scenario.name);
  fs.mkdirSync(dir, { recursive: true });
  const source = makeSource(dir, scenario.audioRate);
  const timelineFile = path.join(dir, 'timeline.json');
  writeTimeline(timelineFile, assets, scenario);

  const single = path.join(dir, 'single.mov');
  const parallel = path.join(dir, 'parallel.mov');
  const tSingle = exportOnce(dir, source, timelineFile, single, 1);
  const tParallel = exportOnce(dir, source, timelineFile, parallel, 3);
  const tag = `kịch bản ${scenario.name}`;

  const videoRuns = (t) => (t?.runs || []).filter((r) => r.mode === 'video' || r.mode === 'full');
  assert.strictEqual(videoRuns(tSingle).length, 1, `${tag}, PARALLEL=1: một lượt`);
  assert.ok(videoRuns(tParallel).length >= 3, `${tag}, PARALLEL=3: phải chia ≥ 3 batch, đang ${videoRuns(tParallel).length}`);
  assert.strictEqual(tParallel.workers, 3, `${tag}, PARALLEL=3: 3 lượt hình cùng lúc`);

  const a = frameHashes(single);
  const b = frameHashes(parallel);
  const totalSeconds = scenario.clips.reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(a.length - totalSeconds * FPS) <= scenario.clips.length, `${tag}: số khung bản một lượt ${a.length}`);
  assert.strictEqual(b.length, a.length, `${tag}: số khung lệch (${a.length} một lượt, ${b.length} song song)`);
  const diff = a.map((h, i) => (h === b[i] ? -1 : i)).filter((i) => i >= 0);
  assert.deepStrictEqual(diff, [], `${tag}: khung khác nhau giữa một lượt và song song: ${diff.slice(0, 12).join(', ')}`);
  const pa = pcm(single);
  const pb = pcm(parallel);
  assert.ok(pa.length > 0 && pa.equals(pb), `${tag}: tiếng khác nhau (${pa.length} so với ${pb.length} byte)`);

  // Chuỗi khung đúng khung dự định (ở cả hai bản — đã trùng nhau ở trên).
  const s = SEQ_START_FRAME;
  const lumas = seqLumas(single, s - 1, s + SEQ_FRAMES);
  assert.strictEqual(lumas.length, SEQ_FRAMES + 2, `${tag}: đọc mức xám`);
  const toY = (l) => 16 + (l * 219) / 255;
  for (let k = 0; k < SEQ_FRAMES; k++) {
    const decoded = Math.round((((lumas[k + 1] - 16) * 255) / 219 - 20) / 5);
    assert.ok(Math.abs(lumas[k + 1] - toY(level(k))) <= 1.5,
      `${tag}: khung nền ${s + k} phải hiện khung ${k} của chuỗi (Y ${lumas[k + 1].toFixed(1)}, đọc ra khung ${decoded})`);
  }
  // Ngay trước và ngay sau cửa sổ: nền testsrc2, không phải khung đầu / khung cuối của chuỗi.
  assert.ok(Math.abs(lumas[0] - toY(level(0))) > 1.5, `${tag}: khung ${s - 1} chưa có chuỗi (Y ${lumas[0].toFixed(1)})`);
  assert.ok(Math.abs(lumas[SEQ_FRAMES + 1] - toY(level(SEQ_FRAMES - 1))) > 1.5,
    `${tag}: khung ${s + SEQ_FRAMES} chuỗi đã hết (Y ${lumas[SEQ_FRAMES + 1].toFixed(1)})`);
  console.log(`  ok  ${tag}: ${a.length} khung + tiếng trùng nhau; song song ${videoRuns(tParallel).length} batch, `
    + `${tParallel.workers} lượt cùng lúc; chuỗi khung ${SEQ_FRAMES} khung đúng từ khung ${s}`);
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_parallel: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const assets = makeSharedAssets();
  for (const scenario of SCENARIOS) checkScenario(scenario, assets);
  if (!process.env.KEEP_TEST_DIR) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export parallel ok');
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
