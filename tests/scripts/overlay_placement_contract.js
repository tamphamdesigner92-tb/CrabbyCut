/* HỢP ĐỒNG ĐẶT LỚP: sidecar phải đặt media overlay ĐÚNG chỗ mà `layerPlacement` của
 * frontend tính ra.
 *
 * VÌ SAO CẦN: khâu bake miếng vá Retouch cho overlay cắt một hình chữ nhật trong không
 * gian SEQUENCE dựa trên phép đặt lớp của frontend (`overlayItemPlacement` ->
 * `layerPointToSequence`), rồi dán lại bằng `position_x = rect.x − (W_seq − w)/2`. Nếu
 * ffmpeg đặt lớp theo một quy ước khác — dù chỉ nửa pixel, hay khác ở phép XOAY — thì
 * miếng vá lệch khỏi khuôn mặt và người dùng thấy đúng cái hình chữ nhật mà cả tính năng
 * này sinh ra để tránh.
 *
 * Test viết THẲNG công thức mong đợi (không gọi lại mã frontend): chỗ cần khoá là RANH
 * GIỚI giữa hai bên. Gọi lại chính hàm của frontend thì hai bên cùng sai vẫn xanh.
 *   kích thước lớp = cỡ asset × scale%          (sidecar: scale=ceil(iw*s/2)*2)
 *   tâm lớp        = (W_seq/2 + pos_x, H_seq/2 + pos_y)
 *   XOAY quanh TÂM lớp, tâm KHÔNG đổi           (sidecar: rotate ow=rotw:oh=roth rồi overlay)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SIDECAR = path.join(PROJECT_ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');

const SEQ_W = 320;
const SEQ_H = 240;
const FPS = 30;
const ASSET_W = 160;
const ASSET_H = 120;

function run(command, args, label) {
  const r = spawnSync(command, args, { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `${label} failed\n${r.stderr || r.stdout}`);
  return r;
}

// Đọc 1 khung ra mảng RGB để dò màu tại toạ độ cụ thể.
function readFrame(videoPath, frameIndex) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', videoPath,
    '-vf', `select=eq(n\\,${frameIndex})`, '-vsync', '0', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { cwd: PROJECT_ROOT, encoding: 'buffer', maxBuffer: 1 << 26 });
  assert.strictEqual(r.status, 0, r.stderr?.toString('utf8'));
  const buf = r.stdout;
  assert.strictEqual(buf.length, SEQ_W * SEQ_H * 3, 'khung đọc ra sai kích thước');
  return (x, y) => {
    const o = (y * SEQ_W + x) * 3;
    return [buf[o], buf[o + 1], buf[o + 2]];
  };
}

const isRed = (p) => p[0] > 150 && p[1] < 90 && p[2] < 90;
const isMagenta = (p) => p[0] > 150 && p[2] > 150 && p[1] < 90;
const isBlack = (p) => p[0] < 60 && p[1] < 60 && p[2] < 60;

function buildInputs(workDir) {
  const main = path.join(workDir, 'main.mp4');
  const overlay = path.join(workDir, 'overlay.mp4');
  const patchDir = path.join(workDir, 'patch');
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${SEQ_W}x${SEQ_H}:d=1:r=${FPS}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', main], 'main');
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=red:s=${ASSET_W}x${ASSET_H}:d=1:r=${FPS}`,
    '-pix_fmt', 'yuv420p', overlay], 'overlay');
  fs.mkdirSync(patchDir, { recursive: true });
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=magenta:s=20x20:d=1:r=${FPS}`,
    '-frames:v', '3', path.join(patchDir, 'frame_%04d.png')], 'patch frames');
  return { main, overlay, patchPattern: path.join(patchDir, 'frame_%04d.png') };
}

function exportWith(workDir, inputs, overlays, tag) {
  const payload = path.join(workDir, `payload_${tag}.json`);
  const out = path.join(workDir, `out_${tag}.mp4`);
  fs.writeFileSync(payload, JSON.stringify({
    version: 5,
    sequence: { width: SEQ_W, height: SEQ_H, preset: 'custom', source_width: SEQ_W, source_height: SEQ_H, source_fps: String(FPS) },
    intervals: [{ index: 0, start: 0, end: 0.9, audio_volume: 100 }],
    overlays,
    settings: {
      resolution: 'sequence', width: SEQ_W, height: SEQ_H,
      fps: String(FPS), render_fps: String(FPS),
      codec: 'h264', quality: 'high', audio_bitrate: '128k',
    },
  }));
  const tmp = path.join(workDir, `tmp_${tag}`);
  fs.mkdirSync(tmp, { recursive: true });
  run(SIDECAR, ['export-video', inputs.main, out, payload, tmp, 'sequence', String(FPS)], `export ${tag}`);
  return out;
}

function mediaOverlay(inputs, index, transform) {
  return {
    index,
    id: `ov_${index}`,
    type: 'media',
    asset_type: 'media_video',
    asset_path: inputs.overlay,
    timeline_start: 0,
    duration: 0.8,
    source_start: 0,
    muted: true,
    has_audio: false,
    ...transform,
  };
}

function main() {
  assert.ok(fs.existsSync(SIDECAR), `chưa build sidecar: ${SIDECAR} (npm run build:sidecar)`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab_overlay_place_'));
  try {
    const inputs = buildInputs(workDir);

    // ---- 1. KHÔNG XOAY: cỡ = asset × scale%, tâm = giữa khung + position ----
    const scale = 50;
    const posX = 40;
    const posY = -30;
    const w = ASSET_W * scale / 100;   // 80
    const h = ASSET_H * scale / 100;   // 60
    const cx = SEQ_W / 2 + posX;       // 200
    const cy = SEQ_H / 2 + posY;       // 90
    const left = cx - w / 2;           // 160
    const top = cy - h / 2;            // 60

    // Miếng vá 20×20 đặt tại một điểm BÊN TRONG lớp, bằng đúng công thức của khâu bake.
    const rect = { x: Math.round(left) + 4, y: Math.round(top) + 4, w: 20, h: 20 };
    const patch = {
      index: 1,
      id: 'patch',
      type: 'media',
      asset_type: 'image_seq',
      asset_path: inputs.patchPattern,
      seq_fps: FPS,
      frame_count: 3,
      timeline_start: 0,
      duration: 0.8,
      source_start: 0,
      position_x: rect.x - (SEQ_W - rect.w) / 2,
      position_y: rect.y - (SEQ_H - rect.h) / 2,
      scale: 100, rotation: 0, opacity: 100,
    };
    const out1 = exportWith(workDir, inputs,
      [mediaOverlay(inputs, 0, { position_x: posX, position_y: posY, scale, rotation: 0, opacity: 100 }), patch],
      'plain');
    const at1 = readFrame(out1, 10);

    // Lớp phủ đúng hộp đã tính: trong hộp là đỏ, ngay ngoài mép là nền đen.
    assert.ok(isRed(at1(Math.round(left) + 2, Math.round(top) + 40)),
      'lớp không nằm ở hộp mà layerPlacement tính ra (mép trái)');
    assert.ok(isRed(at1(Math.round(left + w) - 2, Math.round(top) + 40)),
      'lớp không phủ tới mép phải của hộp');
    assert.ok(isBlack(at1(Math.round(left) - 3, Math.round(top) + 40)),
      'lớp TRÀN ra ngoài mép trái của hộp');
    assert.ok(isBlack(at1(Math.round(left + w) + 3, Math.round(top) + 40)),
      'lớp TRÀN ra ngoài mép phải của hộp');
    assert.ok(isBlack(at1(Math.round(cx), Math.round(top) - 3)),
      'lớp TRÀN lên trên mép hộp');
    console.log(`  ok  lớp phủ đúng hộp ${w}x${h} tại (${left},${top}) — cỡ asset × scale%, tâm = giữa khung + position`);

    // Miếng vá rơi ĐÚNG rect, không lệch pixel nào.
    assert.ok(isMagenta(at1(rect.x + 1, rect.y + 1)), 'miếng vá không nằm ở góc trên-trái của rect');
    assert.ok(isMagenta(at1(rect.x + rect.w - 2, rect.y + rect.h - 2)), 'miếng vá không phủ tới góc dưới-phải');
    assert.ok(isRed(at1(rect.x - 2, rect.y + 10)), 'miếng vá TRÀN sang trái rect');
    assert.ok(isRed(at1(rect.x + rect.w + 2, rect.y + 10)), 'miếng vá TRÀN sang phải rect');
    console.log(`  ok  miếng vá rơi đúng rect (${rect.x},${rect.y},${rect.w}x${rect.h}) qua position_x = rect.x − (W−w)/2`);

    // ---- 2. CÓ XOAY: tâm lớp KHÔNG đổi, hộp bao NỞ RA ----
    const out2 = exportWith(workDir, inputs,
      [mediaOverlay(inputs, 0, { position_x: posX, position_y: posY, scale, rotation: 30, opacity: 100 })],
      'rot');
    const at2 = readFrame(out2, 10);
    assert.ok(isRed(at2(Math.round(cx), Math.round(cy))), 'xoay xong TÂM lớp bị dịch đi');
    // Góc trên-trái của hộp CHƯA xoay giờ phải trống (đã quay đi), còn điểm ngoài hộp cũ
    // theo phương nở ra thì phải có màu.
    assert.ok(isBlack(at2(Math.round(left) + 2, Math.round(top) + 2)),
      'xoay 30° mà góc hộp cũ vẫn đầy — có vẻ phép xoay không được áp');
    assert.ok(isRed(at2(Math.round(cx), Math.round(top) - 4)),
      'xoay xong hộp bao phải NỞ RA theo chiều dọc');
    console.log('  ok  xoay quanh TÂM lớp: tâm giữ nguyên, hộp bao nở ra');

    console.log('overlay placement contract ok');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
