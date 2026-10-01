/* =====================================================================
 * BỎ `geq` TÍNH TỪNG ĐIỂM ẢNH — mục 1.6 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 *
 * Hai chỗ sidecar từng dùng `geq` (bốn biểu thức cho MỖI điểm ảnh của MỖI khung):
 *   - độ mờ có keyframe (KfOpacityFilter): nay `colorchannelmixer` hệ số `aa`, độ mờ tính một lần
 *     mỗi khung bằng `sendcmd` [expr]. Test.crab: cả lượt xuất 57,5 -> 16 s.
 *   - mép mềm miếng vá Retouch (AppendFeatherAlpha): nay dốc mép vẽ MỘT lần rồi nhân vào alpha.
 * Bài test chốt, mỗi ca so với cách cũ (env CRABBYCUT_EXPORT_KFOP=0 / CRABBYCUT_EXPORT_FEATHER1=0),
 * dựng lại cả hai bản ra FFV1:
 *   1. lớp phủ video phóng 150% có keyframe độ mờ 100 -> 10 -> 0 (cả đoạn GIỮ 100% và đoạn về 0);
 *   2. clip lane chính có keyframe độ mờ (đường cũ của lane, nền đen);
 *   3. chuỗi PNG có alpha riêng (0,8) + mép mềm 6 px;
 * — mọi khung ≥ 45 dB so với cách cũ (chỉ lệch phần làm tròn alpha ±1), cùng số khung, và filter
 * script đúng là đường mới (không còn geq ở chỗ đó). Thêm một phép đo tuyệt đối: lớp phủ ở đoạn
 * độ mờ 0 phải biến mất hẳn (khung trùng bản không có lớp phủ).
 *
 * Chạy: npm run test:export-alpha-filters
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { renderFromCommands } = require('./export_fidelity.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_alpha_filters');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const W = 320;
const H = 180;
const FPS = 25;
const SECONDS = 2;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

function writeTimeline(file, { interval = {}, overlays = [] }) {
  fs.writeFileSync(file, JSON.stringify({
    version: 5,
    sequence: { width: W, height: H, fps: String(FPS) },
    intervals: [{ index: 0, script_index: 0, text: 'c0', start: 0, end: SECONDS, scale: 100, position_x: 0, position_y: 0, ...interval }],
    editingTracks: [], editingItems: [], assets: [], main_audio_volume: 100, overlays,
    settings: { resolution: 'sequence', width: W, height: H, fps: String(FPS), render_fps: String(FPS), codec: 'h264', audio_bitrate: '128k' },
  }), 'utf8');
}

// Một lượt xuất; dựng lại NGAY ra FFV1 (file lệnh sendcmd nằm ở thư mục tạm dùng chung).
function exportOnce(tag, source, timeline, env) {
  const output = path.join(TEST_DIR, `${tag}.mp4`);
  const r = run(SIDECAR, ['export-video', source, output, timeline, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 300000,
    env: { ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_BENCH: '1', ...env },
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
  return { script, lossless: renderFromCommands(runDir) };
}

// PSNR RGB từng khung (từ MSE trung bình ba kênh) giữa hai bản FFV1.
function psnrFrames(a, b, tag) {
  const stats = path.join(TEST_DIR, `psnr_${tag}.log`).replace(/\\/g, '/');
  const conv = 'scale=in_color_matrix=bt709:in_range=tv,format=gbrp';
  mustRun('ffmpeg', ['-v', 'error', '-i', a, '-i', b, '-lavfi',
    `[0:v]${conv}[x];[1:v]${conv}[y];[x][y]psnr=stats_file='${stats.replace(/:/g, '\\:')}'`, '-f', 'null', '-'], `psnr ${tag}`);
  return fs.readFileSync(stats, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const mse = Number((/mse_avg:([\d.]+)/.exec(line) || [])[1]);
    return mse <= 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  });
}

function compare(name, fresh, old, minDb = 45) {
  const frames = psnrFrames(fresh.lossless, old.lossless, name.replace(/\W+/g, '_'));
  assert.strictEqual(frames.length, SECONDS * FPS, `${name}: ${frames.length} khung, kỳ vọng ${SECONDS * FPS}`);
  const worst = Math.min(...frames);
  assert.ok(worst >= minDb, `${name}: khung tệ nhất ${worst.toFixed(2)} dB so với cách cũ`);
  return { frames, worst };
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_alpha_filters: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  /* Nền MÀU PHẲNG: lúc có lớp phủ, `overlay=format=auto` kéo cả luồng chính qua RGB rồi về YUV —
   * với nền testsrc2 (màu rất bão hoà) riêng vòng đó đã lệch ~30 dB so với bản không lớp phủ (ở cả
   * cách cũ), làm phép đo "độ mờ 0 thì biến mất" mất nghĩa. Màu phẳng thì vòng đó gần như không lệch. */
  const base = path.join(TEST_DIR, 'temp_input.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x305070:size=${W}x${H}:rate=${FPS}:duration=${SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-shortest', base], 'nền');
  const ovl = path.join(TEST_DIR, 'ovl.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `mandelbrot=size=120x68:rate=${FPS}`, '-t', String(SECONDS),
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', ovl], 'lớp phủ');

  // ---- 1. Lớp phủ video 150%, keyframe độ mờ: GIỮ 100% tới 0,3 s, về 10% ở 1 s, về 0 sau 1,2 s ----
  const opExpr = 'if(lt(LOCALT,0.3),100,if(lt(LOCALT,1),100-90*(LOCALT-0.3)/0.7,max(0,10-50*(LOCALT-1))))';
  const tl1 = path.join(TEST_DIR, 'tl_overlay.json');
  writeTimeline(tl1, { overlays: [{ index: 0, id: 'ov', type: 'media', asset_type: 'media_video', asset_path: ovl,
    timeline_start: 0.2, duration: 1.6, source_start: 0, muted: true, has_audio: false,
    position_x: 15, position_y: -10, rotation: 0, opacity: 100, scale: 150, kf_opacity_expr: opExpr }] });
  const ovNew = exportOnce('ov_new', base, tl1, { CRABBYCUT_EXPORT_KFOP: '1' });
  const ovOld = exportOnce('ov_old', base, tl1, { CRABBYCUT_EXPORT_KFOP: '0' });
  assert.ok(/colorchannelmixer@kfop\d+=aa=1/.test(ovNew.script) && !/geq=/.test(ovNew.script),
    'lớp phủ: bản mới phải dùng colorchannelmixer, không còn geq');
  assert.ok(/geq=r='r\(X,Y\)'/.test(ovOld.script), 'lớp phủ: env tắt phải về geq cũ');
  const ov = compare('lớp phủ keyframe độ mờ', ovNew, ovOld);
  // Độ mờ 0 (từ ~1,4 s): lớp phủ biến mất hẳn -> khung trùng bản chỉ có nền.
  const tlPlain = path.join(TEST_DIR, 'tl_plain.json');
  writeTimeline(tlPlain, {});
  const plain = exportOnce('plain', base, tlPlain, {});
  const vsPlain = psnrFrames(ovNew.lossless, plain.lossless, 'plain');
  const gone = vsPlain.slice(Math.ceil(1.5 * FPS), Math.floor(1.75 * FPS));
  const shown = vsPlain.slice(Math.ceil(0.3 * FPS), Math.floor(0.5 * FPS));
  assert.ok(gone.every((v) => v >= 50), `độ mờ 0 mà lớp phủ vẫn còn (so bản chỉ nền ${Math.min(...gone).toFixed(1)} dB)`);
  assert.ok(shown.every((v) => v < 30), `độ mờ 100 mà không thấy lớp phủ (so bản chỉ nền ${Math.max(...shown).toFixed(1)} dB)`);
  console.log(`  ok  lớp phủ 150% keyframe độ mờ: so cách cũ tệ nhất ${ov.worst === Infinity ? '∞' : ov.worst.toFixed(1)} dB; `
    + 'đoạn 100% hiện rõ, đoạn 0% biến mất');

  // ---- 2. Clip lane chính có keyframe độ mờ (nền đen phía sau) ----
  const tl2 = path.join(TEST_DIR, 'tl_clip.json');
  writeTimeline(tl2, { interval: { kf_opacity_expr: 'clip(100-60*LOCALT,0,100)' } });
  const clNew = exportOnce('clip_new', base, tl2, { CRABBYCUT_EXPORT_KFOP: '1' });
  const clOld = exportOnce('clip_old', base, tl2, { CRABBYCUT_EXPORT_KFOP: '0' });
  assert.ok(/colorchannelmixer@kfop\d+=aa=1/.test(clNew.script), 'clip lane chính: bản mới phải dùng colorchannelmixer');
  /* Ngưỡng 40 dB: cả clip là MỘT màu phẳng nhân alpha, nên alpha làm tròn khác 1/255 (geq cắt
   * phần lẻ, colorchannelmixer làm tròn) lệch ĐỀU 1–2 mức trên toàn khung -> 43–48 dB ở vài khung,
   * mắt không thấy. Lệch thật (sai độ mờ, trễ khung) thì tụt xa hơn nhiều. */
  const cl = compare('clip lane chính keyframe độ mờ', clNew, clOld, 40);
  console.log(`  ok  clip lane chính keyframe độ mờ: so cách cũ tệ nhất ${cl.worst === Infinity ? '∞' : cl.worst.toFixed(1)} dB`);

  // ---- 3. Chuỗi PNG alpha 0,8 + mép mềm 6 px ----
  const seqDir = path.join(TEST_DIR, 'seq');
  fs.mkdirSync(seqDir, { recursive: true });
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=25', '-frames:v', '40',
    '-vf', 'format=rgba,colorchannelmixer=aa=0.8', '-start_number', '0', path.join(seqDir, 'frame_%04d.png')], 'chuỗi PNG');
  const tl3 = path.join(TEST_DIR, 'tl_feather.json');
  writeTimeline(tl3, { overlays: [{ index: 0, id: 'rt', type: 'media', asset_type: 'image_seq',
    asset_path: path.join(seqDir, 'frame_%04d.png'), seq_fps: 25, frame_count: 40,
    timeline_start: 0.2, duration: 1.6, source_start: 0, position_x: -20, position_y: 9, scale: 100, opacity: 100,
    muted: true, has_audio: false, feather_px: 6 }] });
  const ftNew = exportOnce('feather_new', base, tl3, { CRABBYCUT_EXPORT_FEATHER1: '1' });
  const ftOld = exportOnce('feather_old', base, tl3, { CRABBYCUT_EXPORT_FEATHER1: '0' });
  assert.ok(/alphamerge/.test(ftNew.script) && !/geq=r=/.test(ftNew.script), 'mép mềm: bản mới phải dùng dốc mép một lần + alphamerge');
  assert.ok(/geq=r='r\(X,Y\)'[^\n]*alpha\(X,Y\)\*min\(1,/.test(ftOld.script), 'mép mềm: env tắt phải về geq cũ');
  const ft = compare('mép mềm chuỗi PNG alpha', ftNew, ftOld);
  console.log(`  ok  mép mềm 6 px trên chuỗi PNG alpha 0,8: so cách cũ tệ nhất ${ft.worst === Infinity ? '∞' : ft.worst.toFixed(1)} dB`);

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export alpha filters ok');
}

main();
