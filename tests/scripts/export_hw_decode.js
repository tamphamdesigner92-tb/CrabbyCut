/* =====================================================================
 * GIẢI MÃ VIDEOTOOLBOX CHO NGUỒN CHÍNH (mục M.4, SourceHwDecodeArgs trong
 * native/sidecar/core_process.cpp; docs/KE_HOACH_TOI_UU_EXPORT_WIN.md Bước M).
 *
 * Trên macOS, nguồn HEVC hoặc > 8-bit giải mã bằng VideoToolbox (M1 Pro: CPU 36 -> 14,5 giây-CPU
 * ở fixture HEVC 10-bit xoay 90°); H.264 8-bit giữ giải mã CPU vì VideoToolbox CHẬM hơn với nó.
 * Bài test chốt:
 *   a) HEVC 10-bit có cờ xoay: lệnh có `-hwaccel videotoolbox` (chỉ macOS), tắt bằng
 *      CRABBYCUT_EXPORT_HWDEC=0 thì không; bản xuất bật/tắt RA Y HỆT (framemd5) — gồm cả xoay;
 *   b) H.264 8-bit: không bao giờ có `-hwaccel`.
 * Ngoài macOS: không lệnh nào có `-hwaccel videotoolbox`. Máy ảo không có VideoToolbox giải mã
 * thì ffmpeg tự lùi về phần mềm — bản xuất vẫn phải y hệt.
 *
 * Chạy: npm run test:export-hw-decode
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_hw_decode');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const FPS = 30;
const SECONDS = 3;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

function hasEncoder(name) {
  const r = run('ffmpeg', ['-hide_banner', '-encoders']);
  return r.status === 0 && new RegExp(`\\s${name}\\s`).test(r.stdout);
}

// Xuất một lượt, trả { args của lệnh ffmpeg hình, file ra }.
function exportOnce(source, timelineFile, tag, hwdec) {
  const work = path.join(TEST_DIR, `work_${tag}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const output = path.join(TEST_DIR, `${tag}.mp4`);
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, work, 'sequence', String(FPS)], {
    timeout: 300000,
    // libx264 (FFMPEG_EXPORT_HW=0): bộ mã hoá tất định, so framemd5 được. BENCH giữ lại *.cmd.json.
    env: { ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_BENCH: '1', CRABBYCUT_EXPORT_HWDEC: hwdec ? '1' : '0' },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại (${tag}):\n${r.stdout}\n${r.stderr}`);
  const benchDir = path.join(work, 'export_bench');
  const cmds = fs.readdirSync(benchDir).filter((f) => f.endsWith('.cmd.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(benchDir, f), 'utf8')).args);
  assert.ok(cmds.length > 0, `không thấy lệnh ffmpeg nào trong ${benchDir}`);
  return { cmds, output };
}

function hwaccelOf(cmds) {
  const found = new Set();
  cmds.forEach((args) => args.forEach((a, i) => { if (a === '-hwaccel') found.add(args[i + 1]); }));
  return [...found];
}

function frameHashes(file) {
  return mustRun('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], 'framemd5')
    .stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

function writeTimeline(file, width, height) {
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    sequence: { width, height, fps: String(FPS) },
    intervals: [
      { index: 0, script_index: 0, text: 'c0', start: 0.2, end: 1.2 },
      { index: 1, script_index: 1, text: 'c1', start: 1.7, end: 2.8 },
    ],
    editingTracks: [], editingItems: [], assets: [], main_audio_volume: 100, overlays: [],
    settings: { resolution: 'sequence', width, height, fps: String(FPS), codec: 'h264', quality: 'small', audio_bitrate: '128k', render_fps: String(FPS) },
  }), 'utf8');
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_hw_decode: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  if (!hasEncoder('libx265')) {
    console.log('export_hw_decode: BỎ QUA — ffmpeg không có libx265 để dựng nguồn HEVC');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const isMac = process.platform === 'darwin';

  // a) HEVC Main10 320x192 rồi gắn cờ xoay 90° (như video điện thoại quay dọc) -> khung 192x320.
  const hevcRaw = path.join(TEST_DIR, 'hevc_raw.mp4');
  const hevc = path.join(TEST_DIR, 'hevc10_rot.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=320x192:rate=${FPS}:duration=${SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${SECONDS}`,
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error',
    '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', hevcRaw], 'nguồn HEVC');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-display_rotation', '90', '-i', hevcRaw, '-c', 'copy', hevc], 'gắn cờ xoay');
  const hevcTimeline = path.join(TEST_DIR, 'timeline_hevc.json');
  writeTimeline(hevcTimeline, 192, 320);

  const on = exportOnce(hevc, hevcTimeline, 'hevc_on', true);
  const off = exportOnce(hevc, hevcTimeline, 'hevc_off', false);
  assert.deepStrictEqual(hwaccelOf(on.cmds), isMac ? ['videotoolbox'] : [],
    isMac ? 'macOS + HEVC 10-bit: phải giải mã bằng VideoToolbox' : 'ngoài macOS: không -hwaccel videotoolbox');
  assert.deepStrictEqual(hwaccelOf(off.cmds), [], 'CRABBYCUT_EXPORT_HWDEC=0: không -hwaccel');
  const a = frameHashes(on.output);
  const b = frameHashes(off.output);
  assert.ok(a.length >= 55, `bản xuất thiếu khung (${a.length})`);
  assert.strictEqual(a.length, b.length, `số khung lệch (${a.length} bật, ${b.length} tắt)`);
  const diff = a.map((h, i) => (h === b[i] ? -1 : i)).filter((i) => i >= 0);
  assert.deepStrictEqual(diff, [], `khung khác nhau giữa giải mã VideoToolbox và CPU: ${diff.slice(0, 12).join(', ')}`);
  const dims = mustRun('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', on.output], 'ffprobe').stdout.trim();
  assert.strictEqual(dims, '192,320', `nguồn xoay 90° phải ra khung dọc 192x320, đang ${dims}`);

  // b) H.264 8-bit: giữ giải mã CPU.
  const h264 = path.join(TEST_DIR, 'h264.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=320x192:rate=${FPS}:duration=${SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${SECONDS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', h264], 'nguồn H.264');
  const h264Timeline = path.join(TEST_DIR, 'timeline_h264.json');
  writeTimeline(h264Timeline, 320, 192);
  assert.deepStrictEqual(hwaccelOf(exportOnce(h264, h264Timeline, 'h264_on', true).cmds), [],
    'H.264 8-bit: giữ giải mã CPU (VideoToolbox chậm hơn)');

  console.log(`  ok  HEVC 10-bit xoay: ${isMac ? '-hwaccel videotoolbox' : 'không hwaccel (ngoài macOS)'}, `
    + `${a.length} khung khớp framemd5 với giải mã CPU; H.264 8-bit giữ giải mã CPU`);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export hw decode ok');
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
