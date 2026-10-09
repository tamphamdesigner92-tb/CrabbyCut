/* =====================================================================
 * KHÔNG CẮT BATCH QUA THỨ BIẾN THIÊN THEO THỜI GIAN — mục 1.7 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 *
 * Bản xuất dài chia thành các batch ~180 s; bộ hoạch định chỉ được cắt BÊN TRONG một clip / qua một
 * lớp phủ khi thứ đó không biến thiên theo thời gian — cắt đôi thì nửa sau chạy lại giờ cục bộ từ 0
 * (keyframe màu, viền mờ dần có keyframe… chạy lại từ đầu). Hai chỗ từng lọt:
 *   A. ảnh tĩnh có biểu thức thời gian (token LOCALT) trong chuỗi màu CỦA CHÍNH NÓ:
 *      OverlayIsTimeVarying chỉ kiểm chuỗi của lớp Điều chỉnh, không kiểm adj_filters;
 *   B. keyframe màu đi qua `sendcmd` (file lệnh theo giờ cục bộ của block) — cả IntervalIsTimeVarying
 *      lẫn OverlayIsTimeVarying chỉ dò LOCALT, không dò sendcmd.
 * Bài test dựng phim 300 s (mốc cắt mong muốn ở 180 s) và đọc cỡ từng batch hình trong sự kiện
 * `timing`: mốc cắt không được rơi vào trong lớp phủ (A) / trong clip (B). Đối chứng: cùng lớp phủ
 * mà không có biểu thức thời gian thì ĐƯỢC cắt qua (bộ hoạch định vẫn cắt ở 180 s).
 *
 * Chạy: npm run test:export-batch-time-varying
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_batch_time_varying');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const SECONDS = 300;   // bộ hoạch định chỉ chia khi phim ≥ 240 s (kOverlayBatchMinTotalSeconds)
const FPS = 10;
const OV_START = 170;
const OV_END = 195;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

// Đường dẫn trong chuỗi filter: gạch chéo xuôi, `:` của ổ đĩa phải escape (như FilterPath).
function filterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

function writeTimeline(file, { intervalExtra = {}, overlayExtra = null }) {
  const overlays = overlayExtra ? [{
    index: 0, id: 'item_img', type: 'media', asset_type: 'media_image', asset_path: path.join(TEST_DIR, 'logo.png'),
    timeline_start: OV_START, duration: OV_END - OV_START, source_start: 0,
    position_x: 20, position_y: 10, scale: 100, opacity: 100, track_id: 'track_v1', track_order: 0,
    muted: true, volume: 0, has_audio: false, ...overlayExtra,
  }] : [];
  fs.writeFileSync(file, JSON.stringify({
    version: 5,
    sequence: { width: 160, height: 90, fps: String(FPS) },
    intervals: [{ index: 0, script_index: 0, text: 'c0', start: 0, end: SECONDS, scale: 100, position_x: 0, position_y: 0, ...intervalExtra }],
    editingTracks: [{ id: 'track_v1', type: 'media', order: 0, visible: true, muted: false, volume: 100 }],
    editingItems: [], assets: [], main_audio_volume: 100, overlays,
    settings: { resolution: 'sequence', width: 160, height: 90, fps: String(FPS), render_fps: String(FPS), codec: 'h264', audio_bitrate: '128k' },
  }), 'utf8');
}

// Cỡ (giây sequence) của từng batch HÌNH, theo thứ tự.
function videoBatches(tag, source, timeline) {
  const output = path.join(TEST_DIR, `${tag}.mp4`);
  const r = run(SIDECAR, ['export-video', source, output, timeline, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 600000, env: { ...process.env, FFMPEG_EXPORT_HW: '0' },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại (${tag}):\n${r.stdout}\n${r.stderr}`);
  const timing = r.stdout.split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .find((e) => e && e.type === 'timing');
  assert.ok(timing, `${tag}: không thấy sự kiện timing`);
  const runs = JSON.parse(timing.message).runs.filter((x) => x.mode === 'video' || x.mode === 'full');
  return runs.map((x) => Number(x.sequence_duration));
}

function cuts(batches) {
  const out = [];
  let at = 0;
  for (let i = 0; i < batches.length - 1; i++) { at += batches[i]; out.push(at); }
  return out;
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_batch_time_varying: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const source = path.join(TEST_DIR, 'temp_input.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=${FPS}:duration=${SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${SECONDS}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(FPS * 2),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', source], 'nguồn');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=40x24', '-frames:v', '1',
    path.join(TEST_DIR, 'logo.png')], 'ảnh');
  const cmdFile = path.join(TEST_DIR, 'cb.cmd');
  fs.writeFileSync(cmdFile, '0.0-100.0 colorbalance@cb rs 0.1;\n100.0-1000.0 colorbalance@cb rs -0.1;\n', 'utf8');
  const sendcmd = `sendcmd=f='${filterPath(cmdFile)}',colorbalance@cb=rs=0`;

  // Đối chứng: ảnh tĩnh không biểu thức thời gian -> được cắt qua, mốc rơi trong lớp phủ (180 s).
  const tl0 = path.join(TEST_DIR, 'tl_static.json');
  writeTimeline(tl0, { overlayExtra: { adj_filters: 'eq=saturation=1.3' } });
  const c0 = cuts(videoBatches('static', source, tl0));
  assert.ok(c0.some((t) => t > OV_START && t < OV_END),
    `đối chứng: ảnh tĩnh không biến thiên phải cắt được qua (mốc cắt ${JSON.stringify(c0)})`);
  console.log(`  ok  đối chứng: ảnh tĩnh không biến thiên được cắt qua (mốc ${c0.join(', ')} s)`);

  // A. Ảnh tĩnh có LOCALT trong chuỗi màu của chính nó.
  const tlA = path.join(TEST_DIR, 'tl_localt.json');
  writeTimeline(tlA, { overlayExtra: { adj_filters: "vignette=angle='PI/5+0.2*sin(LOCALT)':eval=frame" } });
  const cA = cuts(videoBatches('localt', source, tlA));
  assert.ok(!cA.some((t) => t > OV_START + 0.01 && t < OV_END - 0.01),
    `A: ảnh có LOCALT trong chuỗi màu bị cắt qua (mốc cắt ${JSON.stringify(cA)}, lớp phủ ${OV_START}–${OV_END} s)`);
  console.log(`  ok  A: ảnh tĩnh có biểu thức thời gian trong chuỗi màu không bị cắt qua (mốc ${cA.join(', ') || 'không cắt'} s)`);

  // A'. Ảnh tĩnh có keyframe màu qua sendcmd.
  const tlA2 = path.join(TEST_DIR, 'tl_ov_sendcmd.json');
  writeTimeline(tlA2, { overlayExtra: { adj_filters: sendcmd } });
  const cA2 = cuts(videoBatches('ov_sendcmd', source, tlA2));
  assert.ok(!cA2.some((t) => t > OV_START + 0.01 && t < OV_END - 0.01),
    `A': ảnh có sendcmd trong chuỗi màu bị cắt qua (mốc cắt ${JSON.stringify(cA2)})`);
  console.log(`  ok  A': ảnh tĩnh có keyframe màu (sendcmd) không bị cắt qua (mốc ${cA2.join(', ') || 'không cắt'} s)`);

  // B. Clip lane chính có keyframe màu qua sendcmd: không được xén thành hai clip.
  const tlB = path.join(TEST_DIR, 'tl_clip_sendcmd.json');
  writeTimeline(tlB, { intervalExtra: { adj_filters: sendcmd }, overlayExtra: { adj_filters: 'eq=saturation=1.3' } });
  const cB = cuts(videoBatches('clip_sendcmd', source, tlB));
  assert.deepStrictEqual(cB, [], `B: clip có keyframe màu (sendcmd) bị cắt đôi ở ${JSON.stringify(cB)}`);
  console.log('  ok  B: clip lane chính có keyframe màu (sendcmd) không bị cắt đôi');

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export batch time varying ok');
}

main();
