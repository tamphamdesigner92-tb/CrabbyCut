/* =====================================================================
 * LỚP PHỦ ĐẶT Ở 0 CÓ MỜ VÀO/RA PHẢI HIỆN TRONG BẢN XUẤT (OverlayFirstPtsNegative,
 * native/sidecar/core_process.cpp).
 *
 * Lỗi 2026-10-17 (dự án "Giai-thich-thay-ma"): block GeoCode đầu tiên (0 -> 7,3 s, fade in/out
 * 0,3 s) mất hẳn trong bản xuất, các block sau thì không. Sidecar đặt chuỗi khung sớm ¼ khung
 * (video sớm 0,1 ms) nên block ở 0 có khung đầu mang PTS ÂM; `fade` của FFmpeg so PTS (có dấu)
 * với mốc kiểu uint64 -> coi như đã hết hiệu ứng ngay khung đầu: fade-out trong suốt cả block.
 *
 * Kiểm (sidecar thật):
 *   a) chuỗi khung ở 0 + video lớp phủ ở 0, cả hai có fade in/out: giữa block (khung 60) phải
 *      hiện; khung 0 (đầu fade-in) chưa hiện; cuối fade-out (khung 89) gần như đã tắt;
 *   b) filter script: chỉ hai lớp phủ ở 0 được dời mốc quanh fade, chuỗi khung ở 3 s giữ nguyên.
 *
 * Chạy: npm run test:export-overlay-fade-zero
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_overlay_fade_zero');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const FPS = 30;
const SECONDS = 5;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

// Hoạt ảnh mờ vào/ra như renderer gửi cho GeoCode/video (x/y đứng yên).
function fadeAnim(duration) {
  return {
    anim_x_expr: '0', anim_y_expr: '0',
    anim_in_start: 0, anim_in_dur: 0.3,
    anim_out_start: duration - 0.3, anim_out_dur: 0.3,
  };
}

function exportOnce(source, timelineFile, output) {
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 300000,
    // CRABBYCUT_EXPORT_BENCH giữ lại filter script để đọc bên dưới.
    env: { ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_BENCH: '1' },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại:\n${r.stdout}\n${r.stderr}`);
  return fs.readFileSync(path.join(TEST_DIR, 'export_filter_batch_0.txt'), 'utf8');
}

// PSNR vùng `crop` ở khung `n` giữa hai bản xuất (Infinity = trùng hệt).
function regionPsnr(a, b, n, crop) {
  const r = run('ffmpeg', ['-v', 'info', '-i', a, '-i', b, '-lavfi',
    `[0:v]select=eq(n\\,${n}),crop=${crop}[x];[1:v]select=eq(n\\,${n}),crop=${crop}[y];[x][y]psnr`, '-f', 'null', '-']);
  const m = /PSNR y:([\d.]+|inf)/.exec(r.stderr || '');
  assert.ok(m, `không đọc được PSNR:\n${r.stderr}`);
  return m[1] === 'inf' ? Infinity : Number(m[1]);
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_overlay_fade_at_zero: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // Nền tối phẳng: lớp phủ sáng hiện ra là thấy ngay.
  const source = path.join(TEST_DIR, 'temp_input.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=0x101830:size=320x180:rate=${FPS}:duration=${SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${SECONDS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], 'nguồn');
  // Chuỗi khung 90 khung có alpha (như GeoCode video) và một video lớp phủ.
  const seqDir = path.join(TEST_DIR, 'seq');
  fs.mkdirSync(seqDir, { recursive: true });
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=96x54:rate=${FPS}`,
    '-frames:v', '90', '-vf', 'format=rgba', '-start_number', '0', path.join(seqDir, 'frame_%05d.png')], 'chuỗi PNG');
  const ovVideo = path.join(TEST_DIR, 'ov.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=96x54:rate=${FPS}:duration=4`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ovVideo], 'video lớp phủ');

  const base = { source_start: 0, scale: 100, rotation: 0, opacity: 100, track_order: 0, muted: true, volume: 0, has_audio: false };
  const overlays = [
    { ...base, index: 0, id: 'gc_zero', type: 'media', asset_type: 'image_seq', track_id: 'track_shape_1',
      asset_path: path.join(seqDir, 'frame_%05d.png'), seq_fps: FPS, frame_count: 90,
      timeline_start: 0, duration: 3, position_x: -80, position_y: 0, ...fadeAnim(3) },
    { ...base, index: 1, id: 'video_zero', type: 'media', asset_type: 'media_video', track_id: 'track_shape_2',
      asset_path: ovVideo, timeline_start: 0, duration: 3, position_x: 80, position_y: 0, ...fadeAnim(3) },
    { ...base, index: 2, id: 'gc_later', type: 'media', asset_type: 'image_seq', track_id: 'track_shape_1',
      asset_path: path.join(seqDir, 'frame_%05d.png'), seq_fps: FPS, frame_count: 90,
      timeline_start: 3.25, duration: 1.5, position_x: -80, position_y: 0, ...fadeAnim(1.5) },
  ];
  const payload = {
    version: 4,
    sequence: { width: 320, height: 180, fps: String(FPS) },
    intervals: [{ index: 0, script_index: 0, text: 'c0', start: 0, end: SECONDS }],
    editingTracks: [
      { id: 'track_shape_1', type: 'shape', order: 0, visible: true, muted: false, volume: 100 },
      { id: 'track_shape_2', type: 'shape', order: 1, visible: true, muted: false, volume: 100 },
    ],
    editingItems: [], assets: [], main_audio_volume: 100, overlays,
    settings: { resolution: 'sequence', width: 320, height: 180, fps: String(FPS), codec: 'h264', quality: 'small', audio_bitrate: '128k', render_fps: String(FPS) },
  };
  const timelineFile = path.join(TEST_DIR, 'timeline.json');
  fs.writeFileSync(timelineFile, JSON.stringify(payload), 'utf8');
  const out = path.join(TEST_DIR, 'out.mp4');
  const script = exportOnce(source, timelineFile, out);

  // b) Dời mốc chỉ ở hai lớp phủ đặt tại 0; lớp phủ ở 3,25 s giữ đồ thị cũ.
  const shifted = script.split(';').filter((p) => p.includes('setpts=PTS+round(1/TB)'));
  assert.strictEqual(shifted.length, 2, `chỉ hai lớp phủ ở 0 được dời mốc quanh fade, đang ${shifted.length}`);
  shifted.forEach((p) => {
    assert.ok(/setpts=PTS\+round\(1\/TB\),fade=t=in:st=1\.0+:d=0\.30+:alpha=1,fade=t=out:st=3\.70+:d=0\.30+:alpha=1,setpts=PTS-round\(1\/TB\)/.test(p),
      `mốc fade phải dời đúng 1 s rồi trả về:\n${p}`);
  });

  const plainFile = path.join(TEST_DIR, 'timeline_plain.json');
  fs.writeFileSync(plainFile, JSON.stringify({ ...payload, overlays: [], version: 3 }), 'utf8');
  const plain = path.join(TEST_DIR, 'plain.mp4');
  exportOnce(source, plainFile, plain);

  // a) Vùng lớp phủ: chuỗi khung ở x = 160 − 80 − 48, video ở x = 160 + 80 − 48; y = 90 − 27.
  const seqCrop = '96:54:32:63';
  const videoCrop = '96:54:192:63';
  for (const [name, crop] of [['chuỗi khung', seqCrop], ['video', videoCrop]]) {
    const mid = regionPsnr(out, plain, 60, crop);
    assert.ok(mid < 30, `${name} ở 0 phải hiện giữa block (khung 60, PSNR so với bản không lớp phủ ${mid} dB)`);
    const first = regionPsnr(out, plain, 0, crop);
    assert.ok(first > 40, `${name}: khung 0 là đầu fade-in, phải gần như chưa hiện (PSNR ${first} dB)`);
    const tail = regionPsnr(out, plain, 89, crop);
    assert.ok(tail > mid + 5, `${name}: khung cuối fade-out phải mờ hơn hẳn giữa block (PSNR ${tail} so với ${mid} dB)`);
  }
  const later = regionPsnr(out, plain, 120, seqCrop);
  assert.ok(later < 30, `chuỗi khung ở 3,25 s phải hiện (khung 120, PSNR ${later} dB)`);
  console.log('  ok  chuỗi khung + video lớp phủ ở 0 có mờ vào/ra: hiện giữa block, fade-in/out đúng; lớp phủ sau 0 giữ đồ thị cũ');
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export overlay fade at zero ok');
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
