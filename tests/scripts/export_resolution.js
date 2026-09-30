/* =====================================================================
 * Ô "ĐỘ PHÂN GIẢI" CỦA HỘP THOẠI XUẤT CÓ TÁC DỤNG THẬT — mục 1.12 của
 * docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 *
 * Trước đây backend luôn ép cỡ bản xuất = cỡ sequence, nên chọn "1080p" hay "720p" không đổi gì.
 * Nay đồ thị vẫn dựng ở cỡ sequence, còn đuôi đồ thị (OutputColorFilters của sidecar) co phần hình
 * về cỡ backend tính (exportOutputFrame) rồi đệm đen nếu khổ lệch.
 *
 * Kiểm:
 *   1. exportOutputFrame: cỡ khung + cỡ phần hình cho cả hai kiểu (như Premiere / như CapCut);
 *   2. sidecar xuất đúng cỡ khung, viền đen đúng chỗ (và KHÔNG có viền khi khổ khớp);
 *   3. phần hình đặt đúng chỗ: so với bản xuất đúng cỡ sequence rồi co bằng ffmpeg — lệch 4 px là
 *      PSNR tụt hẳn, nên phép so bắt được sai vị trí;
 *   4. có lớp phủ (đuôi đồ thị nhánh overlay) và ProRes (yuv422p10le) cũng vậy.
 *
 * Chạy: npm run test:export-resolution
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_resolution');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const FPS = 24;
const SECONDS = 3;

process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || path.join(TEST_DIR, 'backend_temp');
const { exportOutputFrame } = require('../../backend/server');

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

function makeSource(target, w, h) {
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${FPS}:duration=${SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', target], 'không dựng được nguồn');
}

function writeTimeline(file, seq, codec, frame, overlayPng) {
  const overlays = overlayPng ? [0, 1].map((i) => ({
    index: i, id: `item_text_${i}`, type: 'media', asset_type: 'text_image', asset_path: overlayPng,
    timeline_start: 0.5 + i, duration: 1, source_start: 0,
    position_x: i ? -30 : 30, position_y: 10, scale: 100, opacity: 100, track_id: 'track_text_1', track_order: 0,
    muted: true, volume: 0, has_audio: false,
  })) : [];
  fs.writeFileSync(file, JSON.stringify({
    version: overlays.length ? 4 : 3,
    sequence: { width: seq.w, height: seq.h, fps: String(FPS) },
    intervals: [{ index: 0, script_index: 0, text: 'c0', start: 0, end: SECONDS }],
    editingTracks: [{ id: 'track_text_1', type: 'text', order: 0, visible: true, muted: false, volume: 100 }],
    editingItems: [], assets: [], main_audio_volume: 100, overlays,
    settings: {
      resolution: 'sequence', width: seq.w, height: seq.h, fps: String(FPS), codec, quality: 'high',
      audio_bitrate: '128k', render_fps: String(FPS), ...(frame || {}),
    },
  }), 'utf8');
}

function exportOnce(name, source, seq, codec, frame, overlayPng) {
  const timelineFile = path.join(TEST_DIR, `${name}.json`);
  writeTimeline(timelineFile, seq, codec, frame, overlayPng);
  const output = path.join(TEST_DIR, `${name}${codec === 'prores' ? '.mov' : '.mp4'}`);
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 300000,
    env: { ...process.env, FFMPEG_EXPORT_HW: '0' },
  });
  assert.strictEqual(r.status, 0, `${name}: xuất thất bại:\n${r.stdout}\n${r.stderr}`);
  return output;
}

function probeSize(file) {
  const r = mustRun('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', file], 'ffprobe');
  const [w, h] = r.stdout.trim().split(',').map(Number);
  return { w, h };
}

// Mặt phẳng Y (8-bit, dải tv như bản xuất) của khung giữa phim. Lấy thẳng Y của yuv420p —
// đổi sang `gray` thì swscale có thể giãn dải và đen thành 0 thay vì 16.
function lumaFrame(file, w, h) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', '1.5', '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, r.stderr?.toString('utf8'));
  assert.strictEqual(r.stdout.length, w * h * 1.5, 'cỡ khung thô');
  return r.stdout.subarray(0, w * h);
}

/* Trung bình PSNR (Y) giữa phần hình của `out` và bản `ref` co bằng lanczos. Cả hai cắt thụt vào
 * INSET px mỗi cạnh; `dx` dời chỗ cắt của bản tham chiếu (dời bên out thì bị kẹp khi phần hình
 * rộng kín khung). */
function contentPsnr(out, ref, frame, dx = 0) {
  const INSET = 8;
  const x = (frame.output_width - frame.output_content_width) / 2 & ~1;
  const y = (frame.output_height - frame.output_content_height) / 2 & ~1;
  const w = frame.output_content_width - 2 * INSET;
  const h = frame.output_content_height - 2 * INSET;
  const r = run('ffmpeg', ['-v', 'info', '-i', out, '-i', ref, '-lavfi',
    `[0:v]crop=${w}:${h}:${x + INSET}:${y + INSET},format=yuv420p[a];`
    + `[1:v]scale=${frame.output_content_width}:${frame.output_content_height}:flags=lanczos,`
    + `crop=${w}:${h}:${INSET + dx}:${INSET},format=yuv420p[b];[a][b]psnr`,
    '-f', 'null', '-']);
  const m = /PSNR y:([\d.]+|inf)/.exec(r.stderr || '');
  assert.ok(m, `không đọc được PSNR:\n${r.stderr}`);
  return m[1] === 'inf' ? 99 : Number(m[1]);
}

function checkBars(name, file, frame) {
  const { output_width: ow, output_height: oh, output_content_width: cw, output_content_height: ch } = frame;
  const x = (ow - cw) / 2 & ~1;
  const y = (oh - ch) / 2 & ~1;
  const luma = lumaFrame(file, ow, oh);
  let worstBar = 0;
  let contentSum = 0;
  let contentCount = 0;
  const margin = 4;   // mép phần hình có vọt do lanczos + nén, bỏ 4 px
  for (let row = 0; row < oh; row += 2) {
    for (let col = 0; col < ow; col += 2) {
      const v = luma[row * ow + col];
      const inside = col >= x && col < x + cw && row >= y && row < y + ch;
      const nearEdge = col >= x - margin && col < x + cw + margin && row >= y - margin && row < y + ch + margin;
      if (!nearEdge) worstBar = Math.max(worstBar, Math.abs(v - 16));
      if (inside) { contentSum += v; contentCount += 1; }
    }
  }
  if (cw < ow || ch < oh) assert.ok(worstBar <= 2, `${name}: viền phải đen (Y≈16), lệch tối đa ${worstBar}`);
  assert.ok(contentSum / contentCount > 40, `${name}: phần hình không được đen (Y trung bình ${(contentSum / contentCount).toFixed(1)})`);
}

function checkFrameMath() {
  // Premiere "Scale To Fit": đúng cỡ preset, khổ lệch thì viền đen.
  assert.deepStrictEqual(exportOutputFrame(3840, 1646, 'p1080', 'fit'),
    { output_width: 1920, output_height: 1080, output_content_width: 1920, output_content_height: 824 });
  assert.deepStrictEqual(exportOutputFrame(1080, 1920, 'p1080', 'fit'),
    { output_width: 1920, output_height: 1080, output_content_width: 608, output_content_height: 1080 });
  assert.deepStrictEqual(exportOutputFrame(1920, 1080, 'p720', 'fit'),
    { output_width: 1280, output_height: 720, output_content_width: 1280, output_content_height: 720 });
  // CapCut: giữ khổ sequence, preset là cạnh ngắn.
  assert.deepStrictEqual(exportOutputFrame(3840, 1646, 'p1080', 'short'),
    { output_width: 2520, output_height: 1080, output_content_width: 2520, output_content_height: 1080 });
  assert.deepStrictEqual(exportOutputFrame(1080, 1920, 'p720', 'short'),
    { output_width: 720, output_height: 1280, output_content_width: 720, output_content_height: 1280 });
  // Theo sequence / preset trùng cỡ sequence / preset lạ -> null (xuất đúng cỡ sequence).
  assert.strictEqual(exportOutputFrame(1920, 1080, 'source'), null);
  assert.strictEqual(exportOutputFrame(1920, 1080, 'p1080'), null);
  assert.strictEqual(exportOutputFrame(1080, 1920, 'p1080', 'short'), null);
  assert.strictEqual(exportOutputFrame(1920, 1080, 'khong_co'), null);
  console.log('  ok  exportOutputFrame: fit (Premiere) / short (CapCut) / theo sequence');
}

function main() {
  checkFrameMath();
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_resolution: BỎ QUA phần xuất — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const overlayPng = path.join(TEST_DIR, 'sub.png');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=yellow@0.9:size=60x20,format=rgba',
    '-frames:v', '1', overlayPng], 'png');

  const cases = [
    // khổ rộng 2.4:1 -> 720p: viền trên/dưới
    { name: 'wide', seq: { w: 480, h: 200 }, preset: 'p720', codec: 'h264' },
    // 4:3 -> 720p: viền hai bên; kèm lớp phủ (đuôi đồ thị nhánh overlay)
    { name: 'narrow_overlay', seq: { w: 320, h: 240 }, preset: 'p720', codec: 'h264', overlay: true },
    // cùng khổ 16:9, phóng to -> không viền
    { name: 'same_aspect', seq: { w: 640, h: 360 }, preset: 'p720', codec: 'h264' },
    // ProRes 4:2:2 10-bit, khổ dọc -> 720p ngang: viền hai bên
    { name: 'prores_vertical', seq: { w: 360, h: 640 }, preset: 'p720', codec: 'prores' },
  ];
  for (const c of cases) {
    const source = path.join(TEST_DIR, `${c.name}_src.mp4`);
    makeSource(source, c.seq.w, c.seq.h);
    const frame = exportOutputFrame(c.seq.w, c.seq.h, c.preset, 'fit');
    assert.ok(frame, `${c.name}: phải có cỡ xuất`);
    const ref = exportOnce(`${c.name}_ref`, source, c.seq, c.codec, null, c.overlay ? overlayPng : null);
    const out = exportOnce(c.name, source, c.seq, c.codec, frame, c.overlay ? overlayPng : null);
    assert.deepStrictEqual(probeSize(ref), { w: c.seq.w, h: c.seq.h }, `${c.name}: không chọn cỡ thì giữ cỡ sequence`);
    assert.deepStrictEqual(probeSize(out), { w: frame.output_width, h: frame.output_height }, `${c.name}: cỡ bản xuất`);
    checkBars(c.name, out, frame);
    const psnr = contentPsnr(out, ref, frame);
    const shifted = contentPsnr(out, ref, frame, 4);
    assert.ok(psnr >= 30, `${c.name}: phần hình phải khớp bản co từ cỡ sequence (PSNR Y ${psnr} dB)`);
    assert.ok(psnr - shifted >= 5, `${c.name}: phép so phải nhạy vị trí (đúng ${psnr} dB, lệch 4 px ${shifted} dB)`);
    console.log(`  ok  ${c.name}: ${c.seq.w}x${c.seq.h} -> ${frame.output_width}x${frame.output_height}`
      + ` (hình ${frame.output_content_width}x${frame.output_content_height}), PSNR Y ${psnr.toFixed(1)} dB, lệch 4 px ${shifted.toFixed(1)} dB`);
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export resolution ok');
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
