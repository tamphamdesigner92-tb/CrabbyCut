/* =====================================================================
 * CẮT TRƯỚC KHI PHÓNG TO — mục 1.4 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 *
 * Clip lane chính phóng to ≥ 1,3× đi đường nhanh: thay vì co CẢ khung nguồn rồi cắt cửa sổ
 * sequence, sidecar cắt trước vùng nguồn cần (trên lưới tỉ lệ rút gọn, chừa lề cho nhân nội suy)
 * rồi mới co (PreCropPlanAxis). Bài test chốt:
 *
 *   1. ĐÚNG CHỖ: clip phóng ≥ 1,3× có `crop` đứng TRƯỚC `scale` trong chuỗi của nó; clip phóng
 *      ít hơn, clip có hiệu ứng theo lân cận (unsharp) thì không — filter script của chúng trùng
 *      thứ tự cũ (env CRABBYCUT_EXPORT_PRECROP=0).
 *   2. CÙNG HÌNH: dựng lại cả hai bản ra FFV1, từng clip so với bản cũ ≥ 50 dB ở MỌI khung (vùng
 *      cắt nằm trên lưới nên chỉ lệch phần làm tròn của bước lấy mẫu) — kể cả toạ độ lẻ, clip có
 *      curves (cắt trước chuỗi màu), và clip vừa phóng vừa dời ra mép.
 *   3. CÙNG SỐ KHUNG.
 *
 * Chạy: npm run test:export-precrop
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { renderFromCommands } = require('./export_fidelity.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_precrop');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const SEQ_W = 320;
const SEQ_H = 180;
const FPS = 25;

/* Nguồn 640×360 trên sequence 320×180 -> fit_scale 0,5: scale 300% = phóng 1,5× nguồn. Mỗi clip
 * 1 giây nguồn = 25 khung. `pre` = kỳ vọng có cắt trước. */
const CLIPS = [
  { name: 'phóng 1,5× giữa khung', start: 0, scale: 300, x: 0, y: 0, pre: true },
  { name: 'phóng 2×, dời lẻ', start: 1, scale: 400, x: 7, y: -5, pre: true },
  { name: 'phóng 3×, dời sát mép trái', start: 2, scale: 600, x: 400, y: 30, pre: true },
  { name: 'phóng 1,35× (lưới thô)', start: 3, scale: 270, x: -3, y: 2, pre: true },
  { name: 'phóng 1,2× — dưới ngưỡng', start: 4, scale: 240, x: 0, y: 0, pre: false },
  { name: 'phóng 2× + curves (cắt trước chuỗi màu)', start: 5, scale: 400, x: 11, y: 3, adj: 'curves=preset=vintage', pre: true },
  { name: 'phóng 2× + unsharp — giữ thứ tự cũ', start: 6, scale: 400, x: 0, y: 0, adj: 'unsharp=lx=5:ly=5:la=1.2', pre: false },
];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

function writeTimeline(file) {
  const intervals = CLIPS.map((c, i) => ({
    index: i, script_index: i, text: `c${i}`, start: c.start, end: c.start + 1,
    scale: c.scale, fit_scale: 0.5, position_x: c.x, position_y: c.y, ...(c.adj ? { adj_filters: c.adj } : {}),
  }));
  fs.writeFileSync(file, JSON.stringify({
    version: 5,
    sequence: { width: SEQ_W, height: SEQ_H, fps: String(FPS) },
    intervals,
    editingTracks: [], editingItems: [], assets: [], main_audio_volume: 100, overlays: [],
    settings: { resolution: 'sequence', width: SEQ_W, height: SEQ_H, fps: String(FPS), render_fps: String(FPS), codec: 'h264', audio_bitrate: '128k' },
  }), 'utf8');
}

// Một lượt xuất; dựng lại NGAY ra FFV1 (thư mục tạm dùng chung giữa các lượt).
function exportOnce(tag, source, timeline, precrop) {
  const output = path.join(TEST_DIR, `${tag}.mp4`);
  const r = run(SIDECAR, ['export-video', source, output, timeline, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 600000,
    env: { ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_BENCH: '1', CRABBYCUT_EXPORT_PRECROP: precrop ? '1' : '0' },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại (${tag}):\n${r.stdout}\n${r.stderr}`);
  const runDir = path.join(TEST_DIR, 'runs', tag);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.cpSync(path.join(TEST_DIR, 'export_bench'), path.join(runDir, 'export_bench'), { recursive: true });
  let script = '';
  for (const name of fs.readdirSync(TEST_DIR)) {
    if (/^export_filter_batch_\d+\.txt$/.test(name)) {
      fs.copyFileSync(path.join(TEST_DIR, name), path.join(runDir, name));
      script += fs.readFileSync(path.join(TEST_DIR, name), 'utf8');
    }
  }
  // Chuỗi hình của từng clip = dòng `[N:v]trim=start=…` thứ i (theo thứ tự clip).
  const clipLines = script.split(/\r?\n/).filter((l) => /^\[\d+:v\]trim=start=/.test(l));
  return { lossless: renderFromCommands(runDir), clipLines };
}

function frameCount(file) {
  const r = mustRun('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], `đếm khung ${file}`);
  return Number(String(r.stdout).trim());
}

// PSNR luma từng khung (từ MSE) giữa hai bản FFV1.
function psnrFrames(a, b) {
  const stats = path.join(TEST_DIR, 'psnr.log').replace(/\\/g, '/');
  mustRun('ffmpeg', ['-v', 'error', '-i', a, '-i', b, '-lavfi', `[0:v][1:v]psnr=stats_file='${stats.replace(/:/g, '\\:')}'`,
    '-f', 'null', '-'], 'psnr');
  return fs.readFileSync(stats, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const mse = Number((/mse_y:([\d.]+)/.exec(line) || [])[1]);
    return mse <= 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  });
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_precrop: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const source = path.join(TEST_DIR, 'temp_input.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${FPS}:duration=8`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-shortest', source], 'nguồn');
  const timeline = path.join(TEST_DIR, 'timeline.json');
  writeTimeline(timeline);
  const now = exportOnce('new', source, timeline, true);
  const old = exportOnce('old', source, timeline, false);
  assert.strictEqual(now.clipLines.length, CLIPS.length, `filter script có ${now.clipLines.length} chuỗi clip, kỳ vọng ${CLIPS.length}`);

  const counts = [frameCount(now.lossless), frameCount(old.lossless)];
  assert.ok(counts.every((c) => c === CLIPS.length * FPS), `số khung mới/cũ = ${counts}, kỳ vọng ${CLIPS.length * FPS}`);
  console.log(`  ok  cùng ${counts[0]} khung ở bản mới và bản cũ`);

  const frames = psnrFrames(now.lossless, old.lossless);
  CLIPS.forEach((clip, i) => {
    const line = now.clipLines[i];
    const cropAt = line.indexOf(',crop=');
    const scaleAt = line.indexOf(',scale=');
    const hasPre = cropAt >= 0 && scaleAt >= 0 && cropAt < scaleAt;
    assert.strictEqual(hasPre, clip.pre, `clip ${i} (${clip.name}): ${clip.pre ? 'thiếu' : 'không được có'} crop trước scale:\n${line}`);
    assert.ok(!(old.clipLines[i].indexOf(',crop=') >= 0 && old.clipLines[i].indexOf(',crop=') < old.clipLines[i].indexOf(',scale=')),
      `clip ${i}: env tắt mà vẫn cắt trước`);
    if (!clip.pre) {
      assert.strictEqual(line, old.clipLines[i], `clip ${i} (${clip.name}): không cắt trước mà chuỗi khác thứ tự cũ`);
    }
    const slice = frames.slice(i * FPS, (i + 1) * FPS);
    const worst = Math.min(...slice);
    assert.ok(worst >= 50, `clip ${i} (${clip.name}): khung tệ nhất ${worst.toFixed(2)} dB so với bản cũ`);
    console.log(`  ok  clip ${i} ${clip.name}: ${clip.pre ? 'cắt trước' : 'giữ thứ tự cũ'}; so bản cũ tệ nhất ${worst === Infinity ? '∞' : worst.toFixed(1)} dB`);
  });

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export precrop ok');
}

main();
