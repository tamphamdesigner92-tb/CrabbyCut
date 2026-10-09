/* =====================================================================
 * ĐƯỜNG NHANH YUV CHO CLIP LANE CHÍNH — mục 1.3 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 *
 * Đường cũ dựng MỖI clip lên nền `color` đen ở RGBA rồi đổi về yuv420p — mọi khung phim đi
 * YUV -> RGBA -> YUV ở cỡ sequence. Đường nhanh (MainLaneFastPlan): scale -> crop -> pad ->
 * yuv420p, không RGBA, không overlay. Bài test chốt:
 *
 *   1. ĐÚNG KHUNG, ĐÚNG CHỖ: dựng lại đồ thị của cả hai đường ra FFV1 (lossless, như bộ so 0.3)
 *      rồi so từng clip với BẢN CHUẨN (đồ thị cũ ghép ở yuv444p10, export_fidelity.goldScript).
 *      Clip của đường nhanh phải gần bản chuẩn ÍT NHẤT bằng đường cũ, ở CẢ BA mặt phẳng — lệch
 *      1 px (toạ độ lẻ, mép cắt) hay mẫu màu lệch nửa mẫu đều làm tụt PSNR của clip đó.
 *      Các ca: 100% giữa khung, phóng có mép cắt lẻ (dọc/ngang/cả hai), thu nhỏ có đệm lẻ, dời
 *      âm vừa cắt vừa đệm, 100% ở toạ độ lẻ (đi 4:4:4), clip dài quá nguồn (tpad clone), clip
 *      không có khung nào (dải đen qua concat), chỉnh màu YUV (eq) và RGB (curves) trên clip cắt lẻ.
 *   2. CÙNG SỐ KHUNG ở cả ba bản.
 *   3. ĐÚNG CHỖ RƠI VỀ ĐƯỜNG CŨ: clip lật hình, nguồn BT.601, nguồn SD không nhãn; nguồn HD
 *      không nhãn thì ĐƯỢC đi đường nhanh. Đếm bằng `fast_clips` trong sự kiện `timing`.
 *   4. ProRes (yuv422p10le): so với bản chuẩn, đường nhanh không kém đường cũ ở mặt phẳng nào.
 *
 * Chạy: npm run test:export-fast-path
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { renderFromCommands } = require('./export_fidelity.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_fast_path');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const W = 320;
const H = 180;
const FPS = 30;
const SOURCE_SECONDS = 10;

/* Mỗi clip 1 giây nguồn = 30 khung. `fast` = kỳ vọng đi đường nhanh. */
const CLIPS = [
  { name: '100% giữa khung', start: 0, scale: 100, x: 0, y: 0, fast: true },
  { name: '105%, mép cắt dọc lẻ (180×1,05 -> 190, cắt 5)', start: 1, scale: 105, x: 0, y: 0, fast: true },
  { name: '101%, cắt lẻ cả hai chiều', start: 2, scale: 101, x: 0, y: 0, fast: true },
  { name: '80%, đệm lẻ cả hai chiều', start: 3, scale: 80, x: 3, y: -5, fast: true },
  { name: '75%, cắt lẻ trái + đệm + cắt đáy', start: 4, scale: 75, x: -45.5, y: 30.25, fast: true },
  { name: '100%, đệm lẻ (4:4:4)', start: 5, scale: 100, x: 1, y: 0, fast: true },
  { name: '100%, cắt lẻ (4:4:4 — swscale bỏ qua chr_pos)', start: 5.5, scale: 100, x: -3, y: 2, fast: true },
  { name: '120%, dời lẻ', start: 6, scale: 120, x: 7, y: -3, fast: true },
  { name: 'eq trên clip cắt lẻ', start: 7, scale: 105, x: 0, y: 0, adj: 'eq=brightness=0.08:saturation=1.4', fast: true },
  { name: 'curves (RGB) trên clip cắt lẻ', start: 8, scale: 107, x: 2, y: 1, adj: 'curves=preset=vintage', fast: true },
  { name: 'lật ngang (rơi về đường cũ)', start: 8.5, scale: 110, x: 0, y: 0, flip: true, fast: false },
  { name: 'dài quá nguồn (tpad clone)', start: 9.5, scale: 100, x: 0, y: 0, fast: true },
  { name: 'ngoài nguồn, không khung nào (dải đen)', start: 11, scale: 100, x: 0, y: 0, fast: true },
];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

function makeSource(file, { size = `${W}x${H}`, tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'] } = {}) {
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${FPS}:duration=${SOURCE_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SOURCE_SECONDS}`,
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', ...tags,
    '-c:a', 'aac', '-shortest', file], `nguồn ${path.basename(file)}`);
}

function writeTimeline(file, clips, { width = W, height = H, codec = 'h264' } = {}) {
  const intervals = clips.map((c, i) => ({
    index: i, script_index: i, text: `c${i}`, start: c.start, end: c.start + 1,
    scale: c.scale, position_x: c.x, position_y: c.y, ...(c.adj ? { adj_filters: c.adj } : {}),
    ...(c.flip ? { flip_x: true } : {}),
  }));
  fs.writeFileSync(file, JSON.stringify({
    version: 4,
    sequence: { width, height, fps: String(FPS) },
    intervals,
    editingTracks: [], editingItems: [], assets: [], main_audio_volume: 100, overlays: [],
    settings: { resolution: 'sequence', width, height, fps: String(FPS), codec, quality: 'high', audio_bitrate: '128k', render_fps: String(FPS) },
  }), 'utf8');
}

/* Một lượt xuất; trả về số clip đi đường nhanh (sự kiện `timing`) và thư mục lượt đo — bản chép
 * export_bench/ + filter script, để renderFromCommands dựng lại đồ thị ra FFV1. */
function exportOnce(tag, source, timelineFile, fastPath, ext = '.mp4') {
  const output = path.join(TEST_DIR, `${tag}${ext}`);
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 600000,
    env: { ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_BENCH: '1', CRABBYCUT_EXPORT_FASTPATH: fastPath ? '1' : '0' },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại (${tag}):\n${r.stdout}\n${r.stderr}`);
  const counts = [...String(r.stdout).matchAll(/fast_clips\\?"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(counts.length, `${tag}: không thấy fast_clips trong sự kiện timing:\n${r.stdout}`);
  const runDir = path.join(TEST_DIR, 'runs', tag);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.cpSync(path.join(TEST_DIR, 'export_bench'), path.join(runDir, 'export_bench'), { recursive: true });
  for (const name of fs.readdirSync(TEST_DIR)) {
    if (/^export_filter_batch_\d+\.txt$/.test(name)) fs.copyFileSync(path.join(TEST_DIR, name), path.join(runDir, name));
  }
  return { output, runDir, fastClips: counts.reduce((a, b) => a + b, 0) };
}

function frameCount(file) {
  const r = mustRun('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], `đếm khung ${file}`);
  return Number(String(r.stdout).trim());
}

/* PSNR từng khung, từng mặt phẳng. 'yuv' = yuv444p10 (so với bản chuẩn); 'rgb' = cả hai đổi sang
 * gbrp bằng CÙNG ma trận BT.709 — tức là như lúc trình phát hiển thị, kẹp gam RGB ở cả hai bên.
 * So mới/cũ phải ở RGB: đường cũ kẹp gam RGB ngay sau chuỗi màu (YUV -> RGBA), đường nhanh giữ
 * YUV nguyên vẹn; với chỉnh màu mạnh (eq tăng bão hoà trên testsrc2) luma YUV hai bên lệch tới
 * 26 dB trong khi hình hiển thị gần như trùng. */
function psnrFrames(distorted, reference, tag, space = 'yuv') {
  const stats = path.join(TEST_DIR, `psnr_${tag}.log`).replace(/\\/g, '/');
  const statsArg = stats.replace(/:/g, '\\:');
  const conv = space === 'rgb'
    ? 'scale=in_color_matrix=bt709:in_range=tv,format=gbrp'
    : 'format=yuv444p10le';
  mustRun('ffmpeg', ['-v', 'error', '-i', distorted, '-i', reference, '-lavfi',
    `[0:v]${conv}[a];[1:v]${conv}[b];[a][b]psnr=stats_file='${statsArg}'`,
    '-f', 'null', '-'], `psnr ${tag}`);
  const names = space === 'rgb' ? ['r', 'g', 'b'] : ['y', 'u', 'v'];
  return fs.readFileSync(stats, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const row = { peak: space === 'rgb' ? 255 : 1023 };
    for (const k of names) {
      const m = new RegExp(`mse_${k}:([\\d.]+)`).exec(line);
      row[k] = m ? Number(m[1]) : NaN;
    }
    row.all = space === 'rgb' ? (row.r + row.g + row.b) / 3 : NaN;
    return row;
  });
}

// PSNR của một dải khung, tính từ MSE trung bình (không phải trung bình của các PSNR).
function rangePsnr(frames, from, to, plane) {
  let sum = 0;
  let n = 0;
  for (let i = from; i < to; i++) { sum += frames[i][plane]; n += 1; }
  const mse = sum / n;
  const peak = frames[from].peak;
  return mse <= 0 ? Infinity : 10 * Math.log10((peak * peak) / mse);
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_fast_path: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // ---- 1 + 2: nguồn BT.709, so với bản chuẩn từng clip ----
  const source = path.join(TEST_DIR, 'temp_input.mp4');
  makeSource(source);
  const timeline = path.join(TEST_DIR, 'timeline.json');
  writeTimeline(timeline, CLIPS);
  const oldRun = exportOnce('old', source, timeline, false);
  const newRun = exportOnce('new', source, timeline, true);
  assert.strictEqual(oldRun.fastClips, 0, 'CRABBYCUT_EXPORT_FASTPATH=0 mà vẫn có clip đi đường nhanh');
  const expectedFast = CLIPS.filter((c) => c.fast).length;
  assert.strictEqual(newRun.fastClips, expectedFast, `số clip đi đường nhanh: ${newRun.fastClips}, kỳ vọng ${expectedFast}`);
  console.log(`  ok  ${newRun.fastClips}/${CLIPS.length} clip đi đường nhanh (clip lật hình giữ đường cũ)`);

  const oldLossless = renderFromCommands(oldRun.runDir);
  const newLossless = renderFromCommands(newRun.runDir);
  const gold = renderFromCommands(oldRun.runDir, { gold: true });
  const counts = [frameCount(oldLossless), frameCount(newLossless), frameCount(gold)];
  assert.ok(counts.every((c) => c === CLIPS.length * FPS), `số khung cũ/mới/chuẩn = ${counts}, kỳ vọng ${CLIPS.length * FPS}`);
  console.log(`  ok  cùng ${counts[0]} khung ở bản cũ, bản mới và bản chuẩn`);

  const oldVsGold = psnrFrames(oldLossless, gold, 'old_gold');
  const newVsGold = psnrFrames(newLossless, gold, 'new_gold');
  const newVsOld = psnrFrames(newLossless, oldLossless, 'new_old', 'rgb');
  CLIPS.forEach((clip, i) => {
    const from = i * FPS;
    const to = from + FPS;
    const row = {};
    for (const plane of ['y', 'u', 'v']) {
      const a = rangePsnr(oldVsGold, from, to, plane);
      const b = rangePsnr(newVsGold, from, to, plane);
      row[plane] = `${a === Infinity ? '∞' : a.toFixed(1)}→${b === Infinity ? '∞' : b.toFixed(1)}`;
      assert.ok(b >= a - 0.1, `clip ${i} (${clip.name}) mặt phẳng ${plane}: mới ${b.toFixed(2)} dB < cũ ${a.toFixed(2)} dB so với bản chuẩn`);
    }
    /* VỊ TRÍ: luma mới so với bản chuẩn. Bản chuẩn dựng từ đồ thị CŨ nên mang đúng toạ độ cũ,
     * lại không kẹp gam RGB. Lệch 1 px trên testsrc2 làm luma tụt xuống ~22–30 dB (đã đo khi dò
     * lỗi mép phải của clip 75%). So mới/cũ trực tiếp thì không dùng được làm phép dò: vòng
     * YUV -> RGB -> YUV của đường cũ trên màu bão hoà của testsrc2 tự nó đã lệch 33–39 dB (RGB),
     * và 26 dB (luma) khi có eq tăng bão hoà. */
    const rgbNewOld = rangePsnr(newVsOld, from, to, 'all');
    if (!clip.fast) {
      // Rơi về đường cũ: cùng một chuỗi filter ở cả hai lượt -> phải trùng.
      assert.ok(rgbNewOld >= 60, `clip ${i} (${clip.name}): đi đường cũ mà RGB mới/cũ chỉ ${rgbNewOld.toFixed(2)} dB`);
    } else if (clip.adj) {
      /* Clip có chỉnh màu đi nhánh RGB = đúng phép tính của đường cũ, chỉ bỏ nền + overlay: phải
       * gần như TRÙNG đường cũ (cả vị trí lẫn phép kẹp gam RGB). */
      assert.ok(rgbNewOld >= 45, `clip ${i} (${clip.name}): RGB mới/cũ chỉ ${rgbNewOld.toFixed(2)} dB — nhánh RGB phải trùng đường cũ`);
    } else {
      const lumaNewGold = rangePsnr(newVsGold, from, to, 'y');
      assert.ok(lumaNewGold >= 45, `clip ${i} (${clip.name}): luma mới/chuẩn chỉ ${lumaNewGold.toFixed(2)} dB — lệch vị trí?`);
    }
    console.log(`  ok  clip ${i} ${clip.name}: so bản chuẩn cũ→mới Y ${row.y} U ${row.u} V ${row.v} dB; RGB mới/cũ ${rgbNewOld === Infinity ? '∞' : rgbNewOld.toFixed(1)} dB`);
  });

  // ---- 3: nguồn nào được đi đường nhanh ----
  const two = CLIPS.slice(1, 3);
  const cases = [
    { name: 'BT.601 (smpte170m)', tags: ['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv'], expect: 0 },
    { name: 'SD không nhãn', tags: [], expect: 0 },
    { name: 'HD không nhãn (được gán BT.709)', tags: [], size: '1280x720', width: 1280, height: 720, expect: two.length },
  ];
  for (const [k, c] of cases.entries()) {
    const src = path.join(TEST_DIR, `src_case${k}.mp4`);
    makeSource(src, { size: c.size || `${W}x${H}`, tags: c.tags });
    const tl = path.join(TEST_DIR, `timeline_case${k}.json`);
    writeTimeline(tl, two, { width: c.width || W, height: c.height || H });
    const got = exportOnce(`case${k}`, src, tl, true).fastClips;
    assert.strictEqual(got, c.expect, `nguồn ${c.name}: ${got} clip đi đường nhanh, kỳ vọng ${c.expect}`);
    console.log(`  ok  nguồn ${c.name}: ${got} clip đi đường nhanh`);
  }

  // ---- 4: ProRes ----
  const proresClips = [CLIPS[2], CLIPS[3], CLIPS[4]];
  const tlProres = path.join(TEST_DIR, 'timeline_prores.json');
  writeTimeline(tlProres, proresClips, { codec: 'prores' });
  const pOld = exportOnce('prores_old', source, tlProres, false, '.mov');
  const pNew = exportOnce('prores_new', source, tlProres, true, '.mov');
  assert.strictEqual(pNew.fastClips, proresClips.length, `ProRes: ${pNew.fastClips} clip đi đường nhanh`);
  const pOldLossless = renderFromCommands(pOld.runDir);
  const pNewLossless = renderFromCommands(pNew.runDir);
  /* SO VỚI BẢN CHUẨN, không đòi mới/cũ ≥ 45 dB (người dùng duyệt 2026-10-05). Ngưỡng tuyệt đối đó
   * chỉ đạt nhờ cách làm tròn SIMD của x86: cùng đồ thị, cùng nguồn FFmpeg, x86 bật SIMD 45,52 dB,
   * còn x86 tắt SIMD và Apple Silicon đều 44,59 dB (docs/DONG_BO_WIN_MAC.md mục 6). Tiêu chí của
   * phần 1–2: so với bản chuẩn 4:4:4 10-bit, bản mới không kém bản cũ ở mặt phẳng nào. */
  const pGold = renderFromCommands(pOld.runDir, { gold: true });
  const pOldGold = psnrFrames(pOldLossless, pGold, 'prores_old_gold');
  const pNewGold = psnrFrames(pNewLossless, pGold, 'prores_new_gold');
  const fmt = (v) => (v === Infinity ? '∞' : v.toFixed(1));
  const pRow = {};
  for (const plane of ['y', 'u', 'v']) {
    const a = rangePsnr(pOldGold, 0, pOldGold.length, plane);
    const b = rangePsnr(pNewGold, 0, pNewGold.length, plane);
    pRow[plane] = `${fmt(a)}→${fmt(b)}`;
    assert.ok(b >= a - 0.1, `ProRes mặt phẳng ${plane}: mới ${b.toFixed(2)} dB < cũ ${a.toFixed(2)} dB so với bản chuẩn`);
  }
  const pY = rangePsnr(psnrFrames(pNewLossless, pOldLossless, 'prores'), 0, pOldGold.length, 'y');
  console.log(`  ok  ProRes: ${pNew.fastClips} clip đường nhanh; so bản chuẩn cũ→mới Y ${pRow.y} U ${pRow.u} V ${pRow.v} dB`
    + ` (luma mới/cũ ${fmt(pY)} dB, chỉ để tham khảo)`);

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export fast path ok');
}

main();
