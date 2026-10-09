/* =====================================================================
 * GHÉP LỚP PHỦ Ở YUV — mục 1.5 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 *
 * `overlay=format=auto` với lớp phủ RGBA kéo cả luồng chính sang RGBA; nay lớp phủ đứng yên
 * đổi sang yuva420p (BT.709/tv) và ghép bằng `overlay=format=yuv420`. Ở yuv420, `overlay` làm
 * tròn x/y xuống số CHẴN, nên sidecar đệm 1 px trong suốt khi toạ độ lẻ (WriteVisualOverlayFilter).
 *
 * Bài test chốt ba điều:
 *   1. VỊ TRÍ ĐÚNG TỪNG PIXEL: khung bao của lớp phủ đỏ đặc ở toạ độ chẵn, lẻ, thập phân, âm
 *      phải trùng giữa đường cũ (CRABBYCUT_EXPORT_YUVCOMP=0), đường mới, và công thức
 *      left = trunc((W − w)/2 + dx) mà `overlay` RGBA vẫn dùng. Lệch 1 px là miếng vá Retouch
 *      trượt khỏi mặt (xem overlay_placement_contract.js).
 *   2. CHUỖI CHÍNH KHÔNG CÒN RGBA: mọi `overlay` của chuỗi lớp phủ nhận luồng chính ở yuv420p
 *      (đọc từ -print_graphs_file khi CRABBYCUT_EXPORT_BENCH=1; ffmpeg < 8.0 thì bỏ qua mục này).
 *   3. MÀU GẦN NHƯ Y HỆT: lớp phủ bán trong suốt, PSNR mới/cũ ≥ 40 dB trên cả khung.
 *   4. MÀU Ở MÉP: đĩa vàng mép khử răng cưa ở toạ độ lẻ, trên bản lossless của đồ thị
 *      (renderFromCommands), U/V quanh đĩa so với bản chuẩn đã hạ về 4:2:0. Đo 2026-09-29: đường cũ
 *      U 49,6 dB; trung bình có trọng số alpha (AlphaWeightedYuva420) 46,3; trung bình THƯỜNG (đột
 *      biến) 41,6. Ngưỡng: không kém đường cũ quá 4 dB. Phần lệch còn lại là do `overlay` trộn
 *      mẫu màu theo alpha trung bình ngay ở 4:2:0, còn đường cũ ghép ở cỡ đầy đủ rồi mới hạ mẫu.
 *
 * Chạy: npm run test:export-yuv-composite
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { renderFromCommands } = require('./export_fidelity.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_yuv_composite');
// CRABBYCUT_SIDECAR: chạy test với một bản sidecar khác bản đã build (vd khi bản chuẩn đang được
// bộ đo dùng và không được ghi đè).
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const W = 320;
const H = 180;
const FPS = 30;
const OV_W = 40;
const OV_H = 20;
// dx, dy: chẵn, lẻ, thập phân, âm — mọi ca làm tròn.
const POSITIONS = [[0, 0], [1, 0], [0, 1], [-1, -1], [3, 5], [2.5, -3.5], [-7, 2], [5.5, 1.5], [-2.5, -0.5]];
const SLOT = 1.4;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

// Mặt phẳng LUMA của một khung. Vị trí đo trên luma vì luma là thứ ở độ phân giải đầy đủ ở cả
// hai đường; màu (chroma) ở mép cột lẻ vốn chung một mẫu với cột bên cạnh.
function frameLuma(file, t) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { cwd: ROOT, encoding: 'buffer', maxBuffer: 1 << 24 });
  assert.strictEqual(r.status, 0, r.stderr?.toString('utf8'));
  return r.stdout;
}

// Khung bao của lớp phủ đỏ đặc (luma ~63) trên nền đen (luma 16). Bỏ qua dải trên cùng
// (y < 50): lớp phủ bán trong suốt nằm ở đó (y 11..46).
function redBox(luma) {
  let x0 = W; let y0 = H; let x1 = -1; let y1 = -1;
  for (let y = 50; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (luma[y * W + x] > 40) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  return { x0, y0, x1, y1 };
}

// Đĩa vàng ở ô thời gian cuối (sau các ô vị trí), toạ độ lẻ; tâm theo công thức overlay RGBA.
const DISC = 64;
const DISC_POS = [3, 5];
const DISC_SLOT = POSITIONS.length;

function writeTimeline(file, solidPng, halfPng, discPng) {
  const overlays = POSITIONS.map(([dx, dy], i) => ({
    index: i, id: `ov_${i}`, type: 'media', asset_type: 'text_image', asset_path: solidPng,
    timeline_start: +(i * SLOT).toFixed(3), duration: 1, source_start: 0,
    position_x: dx, position_y: dy, scale: 100, opacity: 100,
    track_id: 'track_text_1', track_order: 0, muted: true, volume: 0, has_audio: false,
  }));
  overlays.push({
    index: POSITIONS.length + 1, id: 'ov_disc', type: 'media', asset_type: 'text_image', asset_path: discPng,
    timeline_start: +(DISC_SLOT * SLOT).toFixed(3), duration: 1, source_start: 0,
    position_x: DISC_POS[0], position_y: DISC_POS[1], scale: 100, opacity: 100,
    track_id: 'track_text_1', track_order: 0, muted: true, volume: 0, has_audio: false,
  });
  // Lớp phủ bán trong suốt, phủ suốt phim ở góc trên trái (toạ độ lẻ) — cho phép so màu.
  overlays.push({
    index: POSITIONS.length, id: 'ov_half', type: 'media', asset_type: 'text_image', asset_path: halfPng,
    timeline_start: 0, duration: (POSITIONS.length + 1) * SLOT, source_start: 0,
    position_x: -101, position_y: -61, scale: 100, opacity: 100,
    track_id: 'track_text_2', track_order: 1, muted: true, volume: 0, has_audio: false,
  });
  fs.writeFileSync(file, JSON.stringify({
    version: 4,
    sequence: { width: W, height: H, fps: String(FPS) },
    intervals: [{ index: 0, script_index: 0, text: 'c0', start: 0, end: (POSITIONS.length + 1) * SLOT }],
    editingTracks: [
      { id: 'track_text_1', type: 'text', order: 0, visible: true },
      { id: 'track_text_2', type: 'text', order: 1, visible: true },
    ],
    editingItems: [], assets: [], main_audio_volume: 100, overlays,
    settings: { resolution: 'sequence', width: W, height: H, fps: String(FPS), codec: 'h264', quality: 'high', audio_bitrate: '128k', render_fps: String(FPS) },
  }), 'utf8');
}

function exportOnce(source, timelineFile, output, yuv) {
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 600000,
    env: { ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_YUVCOMP: yuv ? '1' : '0', CRABBYCUT_EXPORT_BENCH: '1' },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại (yuv=${yuv}):\n${r.stdout}\n${r.stderr}`);
  // Chép export_bench/ + filter script ra runs/<old|new> cho renderFromCommands (mục 4).
  const runDir = path.join(TEST_DIR, 'runs', yuv ? 'new' : 'old');
  fs.mkdirSync(runDir, { recursive: true });
  fs.cpSync(path.join(TEST_DIR, 'export_bench'), path.join(runDir, 'export_bench'), { recursive: true });
  for (const name of fs.readdirSync(TEST_DIR)) {
    if (/^export_filter_batch_\d+\.txt$/.test(name)) fs.copyFileSync(path.join(TEST_DIR, name), path.join(runDir, name));
  }
  const graphs = path.join(TEST_DIR, 'export_bench', 'batch_0000.graphs.json');
  return fs.existsSync(graphs) ? JSON.parse(fs.readFileSync(graphs, 'utf8')) : null;
}

/* PSNR của U và V trong một vùng, khung `frame`. So ở 4:2:0: bản chuẩn (4:4:4) được HẠ MẪU trước
 * bằng swscale — so ở 4:4:4 thì sai số hạ mẫu mà cả hai bản đều có lấn hết phần pha loãng màu mép
 * (đột biến bỏ trọng số alpha vẫn xanh). */
function chromaPsnr(distorted, reference, frame, crop) {
  const r = mustRun('ffmpeg', ['-v', 'info', '-i', distorted, '-i', reference, '-lavfi',
    `[0:v]select=eq(n\\,${frame}),format=yuv420p,crop=${crop}[a];[1:v]select=eq(n\\,${frame}),format=yuv420p,crop=${crop}[b];[a][b]psnr`,
    '-frames:v', '1', '-f', 'null', '-'], 'psnr màu mép');
  const m = /u:([\d.]+|inf) v:([\d.]+|inf)/.exec(r.stderr || '');
  assert.ok(m, `không đọc được PSNR:\n${r.stderr}`);
  const n = (s) => (s === 'inf' ? Infinity : Number(s));
  return { u: n(m[1]), v: n(m[2]) };
}

// Định dạng luồng CHÍNH ở đầu vào của từng `overlay` trên chuỗi lớp phủ (bỏ overlay clip-lên-nền).
function mainFormatsIntoOverlayChain(graphs) {
  const out = [];
  for (const g of graphs.graphs || []) {
    for (const f of g.filters || []) {
      if (f.filter_name !== 'overlay') continue;
      const main = (f.filter_inputs || []).find((p) => p.pad_name === 'main');
      if (main && !/color/.test(String(main.source_filter_id))) out.push(main.format);
    }
  }
  return out;
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_yuv_composite: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const seconds = (POSITIONS.length + 1) * SLOT;
  const source = path.join(TEST_DIR, 'temp_input.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:size=${W}x${H}:rate=${FPS}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', source], 'nguồn');
  const solidPng = path.join(TEST_DIR, 'solid.png');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=red:size=${OV_W}x${OV_H},format=rgba`, '-frames:v', '1', solidPng], 'png đặc');
  const halfPng = path.join(TEST_DIR, 'half.png');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x36,format=rgba,colorchannelmixer=aa=0.5', '-frames:v', '1', halfPng], 'png bán trong suốt');
  const timelineFile = path.join(TEST_DIR, 'timeline.json');
  const discPng = path.join(TEST_DIR, 'disc.png');
  // Mép khử răng cưa 1,5 px; điểm ảnh trong suốt hẳn mang màu ĐEN như canvas lưu (đó chính là
  // thứ làm phép hạ mẫu thường pha loãng màu mép).
  const cov = `clip((${DISC / 2 - 4}-hypot(X-${DISC / 2 - 0.5},Y-${DISC / 2 - 0.5}))/1.5+0.5,0,1)`;
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black@0:size=${DISC}x${DISC},format=rgba,`
    + `geq=r='250*ceil(${cov})':g='210*ceil(${cov})':b='20*ceil(${cov})':a='255*${cov}'`, '-frames:v', '1', discPng], 'png đĩa vàng');
  writeTimeline(timelineFile, solidPng, halfPng, discPng);

  const oldOut = path.join(TEST_DIR, 'old.mp4');
  const newOut = path.join(TEST_DIR, 'new.mp4');
  const oldGraphs = exportOnce(source, timelineFile, oldOut, false);
  const newGraphs = exportOnce(source, timelineFile, newOut, true);

  // 1. Vị trí.
  POSITIONS.forEach(([dx, dy], i) => {
    const t = i * SLOT + 0.5;
    const a = redBox(frameLuma(oldOut, t));
    const b = redBox(frameLuma(newOut, t));
    const expX = Math.trunc((W - OV_W) / 2 + dx);
    const expY = Math.trunc((H - OV_H) / 2 + dy);
    assert.deepStrictEqual(a, { x0: expX, y0: expY, x1: expX + OV_W - 1, y1: expY + OV_H - 1 },
      `đường cũ lệch công thức ở (${dx}, ${dy})`);
    assert.deepStrictEqual(b, a, `đường YUV đặt lớp phủ (${dx}, ${dy}) ở ${JSON.stringify(b)}, đường cũ ${JSON.stringify(a)}`);
  });
  console.log(`  ok  ${POSITIONS.length} toạ độ (chẵn/lẻ/thập phân/âm): khung bao trùng từng pixel với đường cũ và công thức`);

  // 2. Chuỗi chính ở YUV.
  if (oldGraphs && newGraphs) {
    const before = mainFormatsIntoOverlayChain(oldGraphs);
    const after = mainFormatsIntoOverlayChain(newGraphs);
    assert.ok(before.length >= POSITIONS.length && before.every((f) => f === 'rgba'), `đường cũ phải ghép RGBA: ${before}`);
    assert.ok(after.length === before.length && after.every((f) => f === 'yuv420p'), `đường YUV: luồng chính vào overlay phải là yuv420p, đang ${after}`);
    console.log(`  ok  ${after.length} overlay trên chuỗi chính nhận yuv420p (trước: rgba)`);
  } else {
    console.log('  --  bỏ qua kiểm đồ thị: ffmpeg này không có -print_graphs_file');
  }

  // 3. Màu của lớp phủ bán trong suốt.
  const psnr = run('ffmpeg', ['-v', 'info', '-i', newOut, '-i', oldOut, '-lavfi', 'psnr', '-f', 'null', '-']);
  const m = /average:([\d.]+|inf)/.exec(psnr.stderr || '');
  const avg = !m ? NaN : (m[1] === 'inf' ? Infinity : Number(m[1]));
  assert.ok(avg >= 40, `PSNR mới/cũ ${avg} dB < 40`);
  console.log(`  ok  lớp phủ bán trong suốt: PSNR mới/cũ ${Number.isFinite(avg) ? avg.toFixed(2) : '∞'} dB`);

  // 4. Màu ở mép đĩa vàng, trên bản lossless của đồ thị, so với bản chuẩn (đồ thị cũ ở 4:4:4).
  const oldLossless = renderFromCommands(path.join(TEST_DIR, 'runs', 'old'));
  const newLossless = renderFromCommands(path.join(TEST_DIR, 'runs', 'new'));
  const gold = renderFromCommands(path.join(TEST_DIR, 'runs', 'old'), { gold: true });
  const frame = Math.round((DISC_SLOT * SLOT + 0.5) * FPS);
  const left = Math.trunc((W - DISC) / 2 + DISC_POS[0]);
  const top = Math.trunc((H - DISC) / 2 + DISC_POS[1]);
  // Vùng cắt chẵn (4:2:0): lùi về số chẵn gần nhất.
  const x0 = (left - 4) & ~1;
  const y0 = (top - 4) & ~1;
  const crop = `${DISC + 8}:${DISC + 8}:${x0}:${y0}`;
  const a = chromaPsnr(oldLossless, gold, frame, crop);
  const b = chromaPsnr(newLossless, gold, frame, crop);
  for (const plane of ['u', 'v']) {
    assert.ok(b[plane] >= a[plane] - 4,
      `màu mép kênh ${plane}: mới ${b[plane].toFixed(2)} dB, cũ ${a[plane].toFixed(2)} dB so bản chuẩn — mép bị pha loãng?`);
  }
  console.log(`  ok  màu mép đĩa vàng (toạ độ lẻ), so bản chuẩn cũ→mới: U ${a.u.toFixed(1)}→${b.u.toFixed(1)} V ${a.v.toFixed(1)}→${b.v.toFixed(1)} dB`);

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export yuv composite ok');
}

main();
