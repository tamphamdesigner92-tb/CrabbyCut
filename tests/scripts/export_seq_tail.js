/* =====================================================================
 * GIỮ KHUNG CUỐI CỦA CHUỖI KHUNG HOẠT ẢNH — thay eof_action=repeat bằng khung nhân bản
 * (SequenceTailFrames, native/sidecar/core_process.cpp; docs/KE_HOACH_TOI_UU_EXPORT_WIN.md mục C).
 *
 * `repeat` đúng hình nhưng đắt (Bin Tom, 17 chuỗi: cả lượt 24,1 -> 20,6 s khi bỏ). `pass` trơn thì
 * mất 1–3 khung ở mép cửa sổ vì `setpts` cắt phần lẻ làm cả chuỗi sớm lên. Bài test chốt: bật hay
 * tắt (CRABBYCUT_EXPORT_SEQPASS=0), bản xuất RA Y HỆT (framemd5), với ba ca:
 *   a) chuỗi phủ đúng cửa sổ, nhịp 29,97 (mốc bắt đầu lẻ -> setpts cắt phần lẻ);
 *   b) chuỗi 2 khung giữ suốt 4 s (ảnh tĩnh có retouch đi đường này);
 *   c) không có frame_count (payload cũ) -> phải giữ eof_action=repeat.
 * Kèm kiểm filter script: a/b có `tpad … stop_mode=clone` + `pass`, c có `repeat`.
 *
 * Chạy: npm run test:export-seq-tail
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_seq_tail');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const FPS = 30;
const SECONDS = 10;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

// Chuỗi PNG có alpha, khung nào cũng khác (số khung vẽ bằng testsrc2 thu nhỏ + ô màu theo chỉ số).
function makeSequence(dir, frames, w, h) {
  fs.mkdirSync(dir, { recursive: true });
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30`,
    '-frames:v', String(frames), '-vf', 'format=rgba,colorchannelmixer=aa=0.8', '-start_number', '0',
    path.join(dir, 'frame_%04d.png')], 'không dựng được chuỗi PNG');
}

function seqOverlay(index, dir, start, duration, seqFps, frameCount, x, y) {
  return {
    index, id: `item_anim_${index}`, type: 'media', asset_type: 'image_seq',
    asset_path: path.join(dir, 'frame_%04d.png'), seq_fps: seqFps,
    ...(frameCount ? { frame_count: frameCount } : {}),
    timeline_start: start, duration, source_start: 0,
    position_x: x, position_y: y, scale: 100, opacity: 100, track_id: 'track_text_1', track_order: 0,
    muted: true, volume: 0, has_audio: false,
  };
}

function exportOnce(source, timelineFile, output, seqPass) {
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 300000,
    // CRABBYCUT_EXPORT_BENCH giữ lại filter script để đọc bên dưới.
    env: { ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_BENCH: '1', CRABBYCUT_EXPORT_SEQPASS: seqPass ? '1' : '0' },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại (seqpass=${seqPass}):\n${r.stdout}\n${r.stderr}`);
  return fs.readFileSync(path.join(TEST_DIR, 'export_filter_batch_0.txt'), 'utf8');
}

function frameHashes(file) {
  return mustRun('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], 'framemd5')
    .stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_seq_tail: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const source = path.join(TEST_DIR, 'temp_input.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${FPS}:duration=${SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${SECONDS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], 'nguồn');

  // a) 45 khung ở 29,97, cửa sổ 1,5 s bắt đầu ở mốc lẻ; b) 2 khung giữ 4 s; c) như a nhưng thiếu frame_count.
  const seqA = path.join(TEST_DIR, 'seq_a');
  const seqB = path.join(TEST_DIR, 'seq_b');
  const seqC = path.join(TEST_DIR, 'seq_c');
  makeSequence(seqA, 45, 96, 54);
  makeSequence(seqB, 2, 80, 40);
  makeSequence(seqC, 45, 64, 36);
  const overlays = [
    seqOverlay(0, seqA, 1.2345, 45 / 29.97, 29.97, 45, -60, -30),
    seqOverlay(1, seqB, 3.51, 4.0, 30, 2, 60, 30),
    seqOverlay(2, seqC, 6.017, 45 / 29.97, 29.97, 0, 0, 0),
  ];
  const timelineFile = path.join(TEST_DIR, 'timeline.json');
  fs.writeFileSync(timelineFile, JSON.stringify({
    version: 4,
    sequence: { width: 320, height: 180, fps: String(FPS) },
    intervals: [{ index: 0, script_index: 0, text: 'c0', start: 0, end: SECONDS }],
    editingTracks: [{ id: 'track_text_1', type: 'text', order: 0, visible: true, muted: false, volume: 100 }],
    editingItems: [], assets: [], main_audio_volume: 100, overlays,
    settings: { resolution: 'sequence', width: 320, height: 180, fps: String(FPS), codec: 'h264', quality: 'small', audio_bitrate: '128k', render_fps: String(FPS) },
  }), 'utf8');

  const offOut = path.join(TEST_DIR, 'repeat.mp4');
  const onOut = path.join(TEST_DIR, 'tail.mp4');
  const offScript = exportOnce(source, timelineFile, offOut, false);
  const onScript = exportOnce(source, timelineFile, onOut, true);

  assert.strictEqual((offScript.match(/eof_action=repeat/g) || []).length, 3, 'tắt: cả ba chuỗi dùng repeat');
  assert.strictEqual((offScript.match(/stop_mode=clone\[ov/g) || []).length, 0, 'tắt: không nối khung nhân bản');
  assert.strictEqual((onScript.match(/eof_action=repeat/g) || []).length, 1, 'bật: chỉ chuỗi thiếu frame_count giữ repeat');
  const tails = [...onScript.matchAll(/tpad=stop=(\d+):stop_mode=clone\[ov(\d+)\]/g)].map((m) => [Number(m[2]), Number(m[1])]);
  assert.deepStrictEqual(tails.map((t) => t[0]).sort(), [0, 1], 'bật: chuỗi a và b nối khung nhân bản');
  const tailOf = Object.fromEntries(tails);
  assert.ok(tailOf[1] >= 4 * 30 - 2, `chuỗi 2 khung giữ 4 s phải nối >= ${4 * 30 - 2} khung, đang ${tailOf[1]}`);

  const a = frameHashes(offOut);
  const b = frameHashes(onOut);
  assert.strictEqual(b.length, a.length, `số khung lệch (${a.length} repeat, ${b.length} nhân bản)`);
  const diff = a.map((h, i) => (h === b[i] ? -1 : i)).filter((i) => i >= 0);
  assert.deepStrictEqual(diff, [], `khung khác nhau giữa repeat và khung nhân bản: ${diff.slice(0, 12).join(', ')}`);
  /* Lớp phủ thật sự hiện (không phải cả hai bản cùng mất nó): so với bản xuất KHÔNG lớp phủ, vùng
   * của chuỗi a (96×54, tâm lệch −60/−30) ở khung 60 (t = 2 s, giữa cửa sổ) phải khác hẳn. */
  const noOverlayFile = path.join(TEST_DIR, 'timeline_noov.json');
  const noOverlay = JSON.parse(fs.readFileSync(timelineFile, 'utf8'));
  noOverlay.overlays = [];
  noOverlay.version = 3;
  fs.writeFileSync(noOverlayFile, JSON.stringify(noOverlay), 'utf8');
  const plain = path.join(TEST_DIR, 'plain.mp4');
  exportOnce(source, noOverlayFile, plain, true);
  const r = run('ffmpeg', ['-v', 'info', '-i', offOut, '-i', plain, '-lavfi',
    '[0:v]select=eq(n\\,60),crop=96:54:52:33[x];[1:v]select=eq(n\\,60),crop=96:54:52:33[y];[x][y]psnr', '-f', 'null', '-']);
  const m = /PSNR y:([\d.]+|inf)/.exec(r.stderr || '');
  assert.ok(m, `không đọc được PSNR:\n${r.stderr}`);
  assert.ok(m[1] !== 'inf' && Number(m[1]) < 30, `chuỗi a phải hiện ở khung 60 (PSNR vùng lớp phủ so với bản không lớp phủ ${m[1]} dB)`);
  console.log(`  ok  ${a.length} khung khớp framemd5; khung nhân bản: chuỗi a ${tailOf[0]}, chuỗi 2 khung ${tailOf[1]}; chuỗi thiếu frame_count giữ repeat`);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export seq tail ok');
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
