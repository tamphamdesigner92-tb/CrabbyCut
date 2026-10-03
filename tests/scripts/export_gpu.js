/* =====================================================================
 * ĐỒ THỊ GPU = ĐỒ THỊ CPU — mục 1.21 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md (bộ lọc CUDA crabgeo_cuda/
 * crabblend_cuda của bản ffmpeg riêng; BatchGpuEligible / PrepareExportBatch / RunExportJobs ở sidecar).
 *
 * Cùng một dự án, xuất bằng đồ thị CPU (CRABBYCUT_EXPORT_GPU=0) và đồ thị GPU (=1), cả hai qua NVENC ở
 * bitrate rất cao (gần không mất mát), rồi chốt:
 *   1. số khung bằng nhau, từng khung GPU gần khung CPU (PSNR ≥ 38 dB — ngưỡng của bộ so 0.3);
 *   2. chuỗi khung (mỗi khung một mức xám) hiện ĐÚNG khung dự định ở bản GPU — bản đầu của đồ thị GPU
 *      để GPU chạy không đồng bộ thì lớp phủ chữ hiện khung cũ hơn 6 / mới hơn 2 khi 3 lượt chạy song
 *      song (2026-10-02), nên dự án có 3 chuỗi khung ở 3 batch chạy cùng lúc;
 *   3. batch có clip chỉnh màu (chưa có bản GPU) đi đồ thị CPU, batch còn lại đi GPU, trong cùng lượt;
 *   4. đồ thị GPU lỗi (CRABBYCUT_EXPORT_GPU_TEST_FAIL=1) -> batch đó chạy lại bằng đồ thị CPU, bản xuất
 *      trùng từng khung với bản CPU;
 *   5. nguồn NVDEC không giải mã được (H.264 10-bit) -> giải mã CPU, tải lên dạng p010.
 * Dự án A: nguồn 1280×720 25 khung/s KHÔNG gắn nhãn màu (crabgeo đọc theo bt709 như UntaggedColorFix),
 * sequence 640×360 ở nhịp lẻ của "Bin Tom" (1218000/40601); clip co 50% / 37% đặt lệch lẻ / 80% cắt một
 * phần / 65%; ảnh tĩnh có alpha ở toạ độ lẻ; video lớp phủ 150% độ mờ 60%.
 * Dự án C: lớp phủ chỉ có keyframe ĐỘ MỜ (biểu thức `opacity` của crabblend). Không so với CPU được:
 * đường CPU ghép lớp đó ở RGB (format=gbrap) nên kéo CẢ batch qua YUV -> RGB -> YUV (lệch ~35 dB
 * trên testsrc2, kể cả trước khi lớp phủ hiện) — so với chính đồ thị GPU ở độ mờ tĩnh: keyframe
 * "2 s đầu 50%, sau đó 100%" phải trùng bản 50% ở đoạn đầu và bản 100% ở đoạn sau.
 * Dự án D: clip có LUT tĩnh (`lut3d` trong adj_filters) và LUT trộn theo keyframe cường độ (adj_lut_a/b
 * + biểu thức) — tuỳ chọn lut/lut2/mix của crabgeo (bản n8.1.1-crabbycut.2 trở đi; bản cũ thì batch đó
 * phải đi CPU). LUT B đổi kênh màu: `mix` lệch thời gian là lệch hẳn khỏi CPU.
 * Dự án E: lớp phủ chưa có bản GPU vẫn để batch đi GPU — video mép mềm (dựng bằng CPU tới yuva420p rồi
 * tải lên, phải trùng CPU), chuỗi khung có keyframe cỡ và ảnh xoay (ghép RGBA lên khung trong suốt rồi
 * tải lên). Nền phẳng: đường CPU ghép lớp động ở RGB, vòng YUV -> RGB -> YUV trên nền phẳng gần như
 * không sai số. Chuỗi khung phải hiện ĐÚNG khung.
 *
 * Cần bản ffmpeg có crabgeo_cuda + GPU NVIDIA; thiếu thì BỎ QUA.
 * Chạy: npm run test:export-gpu
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_gpu');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const FPS_TEXT = '1218000/40601';
const FPS = 1218000 / 40601;
const W = 640;
const H = 360;
const SEQ_FRAMES = 60;
const SEQ_SIZE = 96;
const MIN_PSNR = 38;
// Ba chuỗi khung, mỗi chuỗi ở một batch (3 batch ~8 s chạy cùng lúc), mức xám riêng để không lẫn nhau.
// Không vắt qua mốc 8 s / 16 s (biên clip mà lượt chia batch song song chọn — xem PlanOverlayBatches).
const SEQS = [
  { start: 40, x: -150, y: 60, base: 20 },
  { start: 290, x: 150, y: -60, base: 30 },
  { start: 530, x: 0, y: 100, base: 40 },
];
const level = (seq, k) => seq.base + 3 * k;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

function makeAssets() {
  const seqDirs = SEQS.map((seq, i) => {
    const dir = path.join(TEST_DIR, `seq${i}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let k = 0; k < SEQ_FRAMES; k++) {
      const v = level(seq, k).toString(16).padStart(2, '0');
      mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${v}${v}${v}:s=${SEQ_SIZE}x${SEQ_SIZE}`,
        '-frames:v', '1', '-pix_fmt', 'rgba', path.join(dir, `frame_${String(k).padStart(4, '0')}.png`)], 'khung chuỗi');
    }
    return dir;
  });
  // Ảnh tĩnh có alpha + mép màu (chữ nhật đỏ đục giữa nền vàng bán trong suốt): đường alpha_chroma.
  const still = path.join(TEST_DIR, 'still.png');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=yellow@0.7:s=81x41,format=rgba',
    '-vf', 'drawbox=x=20:y=10:w=41:h=21:color=red@1:t=fill', '-frames:v', '1', still], 'ảnh tĩnh');
  const clip = path.join(TEST_DIR, 'overlay_video.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${FPS_TEXT}:duration=6`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip], 'video lớp phủ');
  return { seqDirs, still, clip };
}

// Nguồn 1280×720 không gắn nhãn màu; `tenBit` = H.264 High 10 (NVDEC của GPU NVIDIA không giải mã được).
function makeSource(file, seconds, tenBit) {
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=25:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}:sample_rate=48000`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50',
    ...(tenBit ? ['-pix_fmt', 'yuv420p10le', '-profile:v', 'high10'] : ['-pix_fmt', 'yuv420p']),
    '-c:a', 'aac', '-b:a', '128k', '-shortest', file], 'nguồn');
}

function writeTimeline(file, intervals, overlays, renderFps = FPS_TEXT) {
  fs.writeFileSync(file, JSON.stringify({
    version: 4,
    sequence: { width: W, height: H, fps: 'source' },
    intervals,
    editingTracks: [], editingItems: [], assets: [], main_audio_volume: 100, overlays,
    settings: { resolution: 'sequence', width: W, height: H, fps: 'source', codec: 'h264', quality: 'high',
      rate_mode: 'custom', rate_mbps: 60, audio_bitrate: '128k', render_fps: renderFps },
  }), 'utf8');
}

function timingOf(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'timing') return JSON.parse(event.message);
    } catch (_) { /* không phải JSON */ }
  }
  return null;
}

function exportOnce(dir, source, timelineFile, output, env) {
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, dir, 'sequence', 'source'], {
    timeout: 600000,
    env: { ...process.env, CRABBYCUT_EXPORT_PARALLEL: '3', ...env },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại (${JSON.stringify(env)}):\n${r.stdout}\n${r.stderr}`);
  return { timing: timingOf(r.stdout), stdout: r.stdout };
}

function frameHashes(file) {
  return mustRun('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], 'framemd5')
    .stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

// PSNR từng khung (yuv) của `a` so với `b`; trả [chỉ số khung, dB] tệ nhất và danh sách khung dưới ngưỡng.
function framePsnr(a, b, tag) {
  // stats_file tương đối (cwd = TEST_DIR): `C:` trong filtergraph phải thoát.
  const log = `${tag}_psnr.log`;
  const r = run('ffmpeg', ['-v', 'error', '-i', a, '-i', b, '-lavfi', `[0:v][1:v]psnr=stats_file=${log}`, '-f', 'null', '-'],
    { cwd: TEST_DIR });
  assert.strictEqual(r.status, 0, `psnr:\n${r.stderr}`);
  const file = path.join(TEST_DIR, log);
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map((l) => {
    const p = /psnr_avg:([\d.]+|inf)/.exec(l)[1];
    return [Number(/n:(\d+)/.exec(l)[1]) - 1, p === 'inf' ? 99 : Number(p)];
  });
  fs.rmSync(file, { force: true });
  const worst = rows.reduce((m, r) => (r[1] < m[1] ? r : m), [0, Infinity]);
  return { worst, bad: rows.filter((r) => r[1] < MIN_PSNR), count: rows.length };
}

// Mức Y trung bình giữa vùng chuỗi khung `seq`, cho từng khung trong [from, to].
function seqLumas(file, seq, from, to) {
  const x = Math.trunc((W - SEQ_SIZE) / 2 + seq.x) + 24;
  const y = Math.trunc((H - SEQ_SIZE) / 2 + seq.y) + 24;
  const r = mustRun('ffmpeg', ['-v', 'info', '-i', file, '-vf',
    `trim=start_frame=${from}:end_frame=${to + 1},crop=48:48:${x}:${y},format=yuv420p,signalstats,`
    + 'metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], 'signalstats');
  return [...r.stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
}

function checkSequences(file, tag) {
  const toY = (l) => 16 + (l * 219) / 255;
  for (const [i, seq] of SEQS.entries()) {
    const s = seq.start;
    const lumas = seqLumas(file, seq, s - 1, s + SEQ_FRAMES);
    assert.strictEqual(lumas.length, SEQ_FRAMES + 2, `${tag}: đọc mức xám chuỗi ${i}`);
    for (let k = 0; k < SEQ_FRAMES; k++) {
      const decoded = Math.round((((lumas[k + 1] - 16) * 255) / 219 - seq.base) / 3);
      assert.ok(Math.abs(lumas[k + 1] - toY(level(seq, k))) <= 1.5,
        `${tag}: chuỗi ${i} — khung nền ${s + k} phải hiện khung ${k} (Y ${lumas[k + 1].toFixed(1)}, đọc ra khung ${decoded})`);
    }
    assert.ok(Math.abs(lumas[0] - toY(level(seq, 0))) > 1.5, `${tag}: chuỗi ${i} — khung ${s - 1} chưa có chuỗi`);
    assert.ok(Math.abs(lumas[SEQ_FRAMES + 1] - toY(level(seq, SEQ_FRAMES - 1))) > 1.5,
      `${tag}: chuỗi ${i} — khung ${s + SEQ_FRAMES} chuỗi đã hết`);
  }
}

const videoRuns = (t) => (t?.runs || []).filter((r) => r.mode === 'video' || r.mode === 'full');

function scenarioA(assets) {
  const dir = path.join(TEST_DIR, 'A');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'temp_input.mp4');
  makeSource(source, 32, false);
  const clip = (i, start, scale, x, y, extra = {}) => ({
    index: i, script_index: i, text: `c${i}`, start, end: start + 4, scale, position_x: x, position_y: y, ...extra,
  });
  const intervals = [
    clip(0, 0, 50, 0, 0),
    clip(1, 5, 37, 13, -7),
    clip(2, 10, 80, -101, 33),
    clip(3, 15, 50, 0, 0, { adj_filters: 'eq=saturation=1.3' }),   // chưa có bản GPU -> batch này đi CPU
    clip(4, 20, 65, 7, 3),
    clip(5, 25, 50, 0, 0),
  ];
  const base = { source_start: 0, scale: 100, opacity: 100, muted: true, volume: 0, has_audio: false };
  const overlays = [
    { ...base, id: 'still', type: 'media', asset_type: 'text_image', asset_path: assets.still,
      timeline_start: 1, duration: 9, position_x: -201, position_y: -97 },
    ...SEQS.map((seq, i) => ({ ...base, id: `seq${i}`, type: 'media', asset_type: 'image_seq',
      asset_path: path.join(assets.seqDirs[i], 'frame_%04d.png'), seq_fps: FPS, frame_count: SEQ_FRAMES,
      timeline_start: seq.start / FPS, duration: SEQ_FRAMES / FPS, position_x: seq.x, position_y: seq.y })),
    { ...base, id: 'video', type: 'media', asset_type: 'media_video', asset_path: assets.clip,
      // x 240..720: không đè lên vùng đo của chuỗi 0 (đang chạy cùng lúc, x 122..218)
      timeline_start: 2, duration: 5, scale: 150, opacity: 60, position_x: 161, position_y: 41 },
  ].map((o, i) => ({ ...o, index: i }));
  const timelineFile = path.join(dir, 'timeline.json');
  writeTimeline(timelineFile, intervals, overlays);

  const cpuOut = path.join(dir, 'cpu.mp4');
  const gpuOut = path.join(dir, 'gpu.mp4');
  const failOut = path.join(dir, 'gpu_fail.mp4');
  const cpu = exportOnce(dir, source, timelineFile, cpuOut, { CRABBYCUT_EXPORT_GPU: '0' });
  const gpu = exportOnce(dir, source, timelineFile, gpuOut, { CRABBYCUT_EXPORT_GPU: '1' });
  if (gpu.timing?.render !== 'gpu' && /GPU không dùng được/.test(gpu.stdout)) return false;

  assert.strictEqual(cpu.timing.render, 'cpu', 'GPU=0: render bằng CPU');
  assert.ok(videoRuns(cpu.timing).every((r) => !r.gpu), 'GPU=0: không batch nào đi GPU');
  assert.strictEqual(gpu.timing.render, 'gpu', 'GPU=1: render bằng GPU');
  const runs = videoRuns(gpu.timing);
  assert.ok(runs.length >= 3, `GPU=1: phải chia ≥ 3 batch, đang ${runs.length}`);
  const gpuRuns = runs.filter((r) => r.gpu).length;
  assert.ok(gpuRuns >= 2 && gpuRuns < runs.length,
    `batch có clip chỉnh màu đi CPU, còn lại GPU: ${runs.map((r) => (r.gpu ? 'gpu' : 'cpu')).join(',')}`);
  assert.ok(runs.every((r) => !r.gpu_fallback), 'GPU=1: không batch nào phải lùi về CPU');

  const a = frameHashes(cpuOut);
  const b = frameHashes(gpuOut);
  assert.strictEqual(b.length, a.length, `số khung lệch (CPU ${a.length}, GPU ${b.length})`);
  const p = framePsnr(gpuOut, cpuOut, 'gpu_a');
  assert.deepStrictEqual(p.bad.map((r) => `${r[0]}:${r[1].toFixed(1)}`), [],
    `khung GPU khác CPU (dưới ${MIN_PSNR} dB)`);
  checkSequences(gpuOut, 'GPU');

  // Đồ thị GPU hỏng -> batch GPU chạy lại bằng đồ thị CPU, bản xuất trùng bản CPU.
  const cacheFile = path.join(dir, 'gpu_probe_cache.txt');
  assert.ok(fs.existsSync(cacheFile), 'lượt GPU phải lưu kết quả dò GPU (gpu_probe_cache.txt)');
  const fail = exportOnce(dir, source, timelineFile, failOut, { CRABBYCUT_EXPORT_GPU: '1', CRABBYCUT_EXPORT_GPU_TEST_FAIL: '1' });
  const failRuns = videoRuns(fail.timing);
  assert.strictEqual(failRuns.filter((r) => r.gpu_fallback).length, gpuRuns, 'mọi batch GPU phải lùi về CPU');
  assert.strictEqual(fail.timing.render, 'cpu', 'lùi hết về CPU -> render "cpu"');
  assert.strictEqual(fail.timing.gpu_probe_cached, true, 'lượt sau dùng kết quả dò đã lưu');
  assert.ok(!fs.existsSync(cacheFile), 'đồ thị GPU lỗi -> phải xoá kết quả dò đã lưu (lượt sau dò lại)');
  const c = frameHashes(failOut);
  const same = c.length === a.length && c.every((h, i) => h === a[i]);
  if (!same) {
    const q = framePsnr(failOut, cpuOut, 'gpu_fail');
    assert.ok(q.count === a.length && q.worst[1] >= 60, `bản lùi về CPU phải trùng bản CPU (tệ nhất ${q.worst[1]} dB)`);
  }
  console.log(`  ok  dự án A: ${a.length} khung, ${gpuRuns}/${runs.length} batch GPU, tệ nhất ${p.worst[1].toFixed(1)} dB `
    + `(khung ${p.worst[0]}); 3 chuỗi khung đúng khung; lùi về CPU ${same ? 'trùng từng khung' : 'gần trùng'}`);
  return true;
}

function scenarioB() {
  const dir = path.join(TEST_DIR, 'B');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'temp_input.mp4');
  makeSource(source, 9, true);
  const intervals = [
    { index: 0, script_index: 0, text: 'c0', start: 0, end: 3, scale: 50 },
    { index: 1, script_index: 1, text: 'c1', start: 4, end: 7.5, scale: 43, position_x: 5, position_y: -3 },
  ];
  const timelineFile = path.join(dir, 'timeline.json');
  writeTimeline(timelineFile, intervals, []);
  const cpuOut = path.join(dir, 'cpu.mp4');
  const gpuOut = path.join(dir, 'gpu.mp4');
  exportOnce(dir, source, timelineFile, cpuOut, { CRABBYCUT_EXPORT_GPU: '0' });
  const gpu = exportOnce(dir, source, timelineFile, gpuOut, { CRABBYCUT_EXPORT_GPU: '1' });
  assert.strictEqual(gpu.timing.render, 'gpu', 'nguồn 10-bit: render bằng GPU (giải mã CPU, tải lên p010)');
  assert.ok(!/giải mã NVDEC/.test(gpu.stdout), 'H.264 10-bit: NVDEC không giải mã được -> giải mã CPU');
  const p = framePsnr(gpuOut, cpuOut, 'gpu_b');
  assert.strictEqual(p.count, frameHashes(cpuOut).length, 'nguồn 10-bit: số khung');
  assert.deepStrictEqual(p.bad.map((r) => `${r[0]}:${r[1].toFixed(1)}`), [], `nguồn 10-bit: khung GPU khác CPU`);
  console.log(`  ok  dự án B (H.264 10-bit, giải mã CPU): ${p.count} khung, tệ nhất ${p.worst[1].toFixed(1)} dB`);
}

function scenarioC(assets) {
  const dir = path.join(TEST_DIR, 'C');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'temp_input.mp4');
  makeSource(source, 9, false);
  const intervals = [
    { index: 0, script_index: 0, text: 'c0', start: 0, end: 4, scale: 50 },
    { index: 1, script_index: 1, text: 'c1', start: 4.5, end: 8.5, scale: 50 },
  ];
  const START = 1;
  const overlay = (extra) => [{ index: 0, id: 'still', type: 'media', asset_type: 'text_image', asset_path: assets.still,
    source_start: 0, timeline_start: START, duration: 5, scale: 200, opacity: 100, position_x: -101, position_y: -51,
    muted: true, volume: 0, has_audio: false, ...extra }];
  const variants = {
    kf: { kf_opacity_expr: 'if(lt(LOCALT,2),50,100)' },
    op50: { opacity: 50 },
    op100: { opacity: 100 },
  };
  const out = {};
  for (const [i, [name, extra]] of Object.entries(variants).entries()) {
    const timelineFile = path.join(dir, `timeline_${name}.json`);
    writeTimeline(timelineFile, intervals, overlay(extra));
    out[name] = path.join(dir, `${name}.mp4`);
    const r = exportOnce(dir, source, timelineFile, out[name], { CRABBYCUT_EXPORT_GPU: '1' });
    assert.ok(videoRuns(r.timing).every((run) => run.gpu), `dự án C (${name}): phải đi đồ thị GPU`);
    // Cùng nguồn, cùng bản ffmpeg: lượt đầu dò, các lượt sau dùng kết quả đã lưu (GpuProbeResult).
    assert.strictEqual(r.timing.gpu_probe_cached, i > 0, `dự án C (${name}): gpu_probe_cached`);
  }
  // Bỏ 2 khung ở mỗi mép (mốc đổi độ mờ có thể rơi giữa hai khung).
  const range = (a, b) => [Math.ceil(a * FPS) + 2, Math.floor(b * FPS) - 2];
  const window = (rows, [a, b]) => rows.filter((r) => r[0] >= a && r[0] <= b);
  const rowsOf = (a, b, tag) => {
    const log = `${tag}_psnr.log`;
    run('ffmpeg', ['-v', 'error', '-i', a, '-i', b, '-lavfi', `[0:v][1:v]psnr=stats_file=${log}`, '-f', 'null', '-'], { cwd: TEST_DIR });
    const file = path.join(TEST_DIR, log);
    const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map((l) => {
      const p = /psnr_avg:([\d.]+|inf)/.exec(l)[1];
      return [Number(/n:(\d+)/.exec(l)[1]) - 1, p === 'inf' ? 99 : Number(p)];
    });
    fs.rmSync(file, { force: true });
    return rows;
  };
  const half = range(START, START + 2);
  const full = range(START + 2, START + 5);
  const vs50 = rowsOf(out.kf, out.op50, 'c50');
  const vs100 = rowsOf(out.kf, out.op100, 'c100');
  const min = (rows) => Math.min(...rows.map((r) => r[1]));
  const max = (rows) => Math.max(...rows.map((r) => r[1]));
  assert.ok(min(window(vs50, half)) >= 45, `keyframe 50%: phải trùng bản độ mờ 50% (tệ nhất ${min(window(vs50, half)).toFixed(1)} dB)`);
  assert.ok(min(window(vs100, full)) >= 45, `keyframe 100%: phải trùng bản độ mờ 100% (tệ nhất ${min(window(vs100, full)).toFixed(1)} dB)`);
  assert.ok(max(window(vs100, half)) < 40, 'đoạn 50% phải khác bản 100% (kiểm độ nhạy)');
  console.log(`  ok  dự án C (keyframe độ mờ): đoạn 50% trùng bản 50% (≥ ${min(window(vs50, half)).toFixed(1)} dB), `
    + `đoạn 100% trùng bản 100% (≥ ${min(window(vs100, full)).toFixed(1)} dB)`);
}

// .cube 17³, r chạy nhanh nhất; `fn(r, g, b)` -> [r, g, b] trên thang 0..1.
function writeCube(file, fn) {
  const n = 17;
  const lines = ['TITLE "export_gpu"', `LUT_3D_SIZE ${n}`, ''];
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) lines.push(fn(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(' '));
    }
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

// Đường dẫn bên trong filtergraph như backend ghi (ColorAdjust.filterPath): `/` và `\:`.
const filterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');

// `allow`: chỉ số khung được phép khác CPU (kèm lý do ở nơi gọi).
function videoFramesCheck(cpuOut, gpuOut, tag, allow = []) {
  const p = framePsnr(gpuOut, cpuOut, tag);
  assert.strictEqual(p.count, frameHashes(cpuOut).length, `${tag}: số khung`);
  const bad = p.bad.filter((r) => !allow.includes(r[0]));
  assert.deepStrictEqual(bad.map((r) => `${r[0]}:${r[1].toFixed(1)}`), [], `${tag}: khung GPU khác CPU (dưới ${MIN_PSNR} dB)`);
  return p;
}

// Mức Y trung bình của ô 16×16 tại (x, y) ở khung `n`.
function lumaAt(file, n, x, y) {
  const r = mustRun('ffmpeg', ['-v', 'info', '-i', file, '-vf',
    `trim=start_frame=${n}:end_frame=${n + 1},crop=16:16:${x}:${y},format=yuv420p,signalstats,`
    + 'metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], 'signalstats');
  return Number(/lavfi\.signalstats\.YAVG=([\d.]+)/.exec(r.stderr)[1]);
}

function scenarioD(lutOk) {
  const dir = path.join(TEST_DIR, 'D');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'temp_input.mp4');
  makeSource(source, 10, false);
  const gamma = (k) => (r, g, b) => [r ** k, g ** k, b ** k];
  const lutC = writeCube(path.join(dir, 'static.cube'), gamma(1.15));
  const lutA = writeCube(path.join(dir, 'mix_a.cube'), gamma(0.9));
  /* Âm bản: tuyến tính (nội suy ba chiều đúng tuyệt đối), đi qua xám ở mix 0,5 nên `mix` lệch thời
   * gian là lệch hẳn. KHÔNG dùng LUT đổi kênh (g, b, r): độ sáng ra lấy gần hết từ kênh màu, nên khác
   * biệt cách nâng/hạ mẫu màu 4:2:0 giữa crabgeo và swscale (vốn đã có, ~40 dB ở mép màu testsrc2)
   * dồn vào độ sáng -> 29 dB ở mép, dù cả hai bản đều đúng. */
  const lutB = writeCube(path.join(dir, 'mix_b.cube'), (r, g, b) => [1 - r, 1 - g, 1 - b]);
  const intervals = [
    { index: 0, script_index: 0, text: 'c0', start: 0, end: 4, scale: 50,
      adj_filters: `lut3d=file='${filterPath(lutC)}':interp=trilinear` },
    // Lớp Điều chỉnh có keyframe cường độ LUT: A -> B trong 2 s đầu của clip.
    { index: 1, script_index: 1, text: 'c1', start: 4.5, end: 8.5, scale: 43, position_x: 9, position_y: -5,
      adj_layer_lut_a_path: lutA, adj_layer_lut_b_path: lutB, adj_layer_lut_mix_expr: 'clip(LOCALT/2,0,1)' },
  ];
  const timelineFile = path.join(dir, 'timeline.json');
  writeTimeline(timelineFile, intervals, []);
  const cpuOut = path.join(dir, 'cpu.mp4');
  const gpuOut = path.join(dir, 'gpu.mp4');
  exportOnce(dir, source, timelineFile, cpuOut, { CRABBYCUT_EXPORT_GPU: '0' });
  const gpu = exportOnce(dir, source, timelineFile, gpuOut, { CRABBYCUT_EXPORT_GPU: '1' });
  const runs = videoRuns(gpu.timing);
  if (!lutOk) {
    assert.ok(runs.every((r) => !r.gpu), 'ffmpeg chưa có LUT trong crabgeo: clip có LUT phải đi đồ thị CPU');
    console.log('  ok  dự án D (LUT): ffmpeg chưa có lut/lut2/mix -> đồ thị CPU');
    return;
  }
  assert.ok(runs.length && runs.every((r) => r.gpu && !r.gpu_fallback), `clip chỉ có LUT phải đi đồ thị GPU: ${JSON.stringify(runs)}`);
  const p = videoFramesCheck(cpuOut, gpuOut, 'lut');
  console.log(`  ok  dự án D (LUT tĩnh + LUT trộn theo keyframe): ${p.count} khung GPU, tệ nhất ${p.worst[1].toFixed(1)} dB (khung ${p.worst[0]})`);
}

function scenarioE(assets) {
  const dir = path.join(TEST_DIR, 'E');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'temp_input.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x5a7a9a:s=1280x720:rate=25:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=12:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', source], 'nguồn phẳng');
  const intervals = [
    { index: 0, script_index: 0, text: 'c0', start: 0, end: 5, scale: 50 },
    { index: 1, script_index: 1, text: 'c1', start: 5.5, end: 10.5, scale: 60 },
  ];
  const base = { source_start: 0, scale: 100, opacity: 100, muted: true, volume: 0, has_audio: false };
  /* 30 khung/s tròn + một chuỗi khung (timebase µs) trộn TRƯỚC, gần điều kiện của "Yêu Con". Lỗi
   * khung trong suốt chậm một khung ở đó (2026-10-03, chữa bằng cách dời sớm 1 ms trước crabblend)
   * CHƯA tái hiện được ở dự án tổng hợp này — bản đột biến bỏ bước dời vẫn qua; phép kiểm của nó là
   * bộ so 0.3 trên "Yêu Con" (khung 200–210 tụt 28 dB khi lỗi). */
  const EFPS = 30;
  const seq = { start: 60, x: 120, y: 50, base: 20 };
  const overlays = [
    // Mép mềm: OverlayGpu::CpuYuv (chuỗi CPU tới yuva420p, crabblend thay overlay=yuv420).
    { ...base, id: 'feather', type: 'media', asset_type: 'media_video', asset_path: assets.clip,
      timeline_start: 1, duration: 4, scale: 120, feather_px: 10, position_x: -150, position_y: -60 },
    { ...base, id: 'seq', type: 'media', asset_type: 'image_seq',
      asset_path: path.join(assets.seqDirs[1], 'frame_%04d.png'), seq_fps: EFPS, frame_count: SEQ_FRAMES,
      timeline_start: 1.5, duration: SEQ_FRAMES / EFPS, position_x: -60, position_y: 100 },
    // Keyframe cỡ trên chuỗi khung: OverlayGpu::CpuCanvas. Cỡ ≥ 100% nên ô đo giữa chuỗi luôn nằm trong.
    { ...base, id: 'kfseq', type: 'media', asset_type: 'image_seq',
      asset_path: path.join(assets.seqDirs[0], 'frame_%04d.png'), seq_fps: EFPS, frame_count: SEQ_FRAMES,
      timeline_start: seq.start / EFPS, duration: SEQ_FRAMES / EFPS, position_x: seq.x, position_y: seq.y,
      kf_scale_expr: '100+LOCALT*60' },
    // Ảnh tĩnh xoay: không còn là lớp phủ đứng yên -> CpuCanvas.
    { ...base, id: 'rot', type: 'media', asset_type: 'text_image', asset_path: assets.still,
      timeline_start: 6, duration: 3, scale: 200, rotation: 20, position_x: -120, position_y: 40 },
  ].map((o, i) => ({ ...o, index: i }));
  const timelineFile = path.join(dir, 'timeline.json');
  writeTimeline(timelineFile, intervals, overlays, String(EFPS));
  const cpuOut = path.join(dir, 'cpu.mp4');
  const gpuOut = path.join(dir, 'gpu.mp4');
  exportOnce(dir, source, timelineFile, cpuOut, { CRABBYCUT_EXPORT_GPU: '0' });
  const gpu = exportOnce(dir, source, timelineFile, gpuOut, { CRABBYCUT_EXPORT_GPU: '1' });
  const runs = videoRuns(gpu.timing);
  assert.ok(runs.length && runs.every((r) => r.gpu && !r.gpu_fallback),
    `lớp phủ mép mềm / keyframe cỡ / xoay không được kéo batch về CPU: ${JSON.stringify(runs)}`);
  /* Khung cuối cửa sổ của ảnh xoay (6..9 s): ảnh tĩnh lặp ở 25 khung/s, khung lặp cuối bắt đầu ở
   * 8,96 s; khung nền 269 (8,967 s) vẫn trong cửa sổ. Đường CPU (và bản GPU riêng — crabblend như
   * overlay) đã tắt ảnh ở khung này: `eof_action=pass` coi khung lặp cuối hết hạn ngay ở mốc của nó.
   * Đường khung trong suốt hiện đủ cửa sổ [6, 9) — đúng ý người dùng hơn, nên được phép khác CPU ở
   * đúng khung đó, và phải CÓ ảnh ở đó. */
  const rotLast = Math.ceil(9 * EFPS) - 1;
  const p = videoFramesCheck(cpuOut, gpuOut, 'fallback', [rotLast]);
  const rotX = Math.trunc(W / 2 - 120) - 8;
  const rotY = Math.trunc(H / 2 + 40) - 8;
  assert.ok(Math.abs(lumaAt(gpuOut, rotLast, rotX, rotY) - lumaAt(gpuOut, rotLast - 1, rotX, rotY)) < 3,
    `ảnh xoay phải còn ở khung cuối cửa sổ (${rotLast})`);
  assert.ok(Math.abs(lumaAt(gpuOut, rotLast + 1, rotX, rotY) - lumaAt(gpuOut, rotLast - 1, rotX, rotY)) > 10,
    `ảnh xoay phải hết ở khung ${rotLast + 1}`);
  // Chuỗi khung có keyframe cỡ hiện đúng khung dự định ở bản GPU.
  const toY = (l) => 16 + (l * 219) / 255;
  const lumas = seqLumas(gpuOut, seq, seq.start, seq.start + SEQ_FRAMES - 1);
  assert.strictEqual(lumas.length, SEQ_FRAMES, 'đọc mức xám chuỗi keyframe cỡ');
  lumas.forEach((y, k) => {
    assert.ok(Math.abs(y - toY(level(seq, k))) <= 1.5,
      `chuỗi keyframe cỡ: khung nền ${seq.start + k} phải hiện khung ${k} (Y ${y.toFixed(1)})`);
  });
  console.log(`  ok  dự án E (lớp phủ dựng bằng CPU rồi tải lên): ${runs.length} batch GPU, ${p.count} khung, `
    + `tệ nhất ${p.worst[1].toFixed(1)} dB (khung ${p.worst[0]}); chuỗi keyframe cỡ đúng khung`);
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_gpu: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  const filters = run('ffmpeg', ['-hide_banner', '-filters']).stdout || '';
  if (!/crabgeo_cuda/.test(filters) || !/crabblend_cuda/.test(filters)) {
    console.log('export_gpu: BỎ QUA — ffmpeg không có bộ lọc CUDA của CrabbyCut (bản ffmpeg riêng, mục 1.21)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const assets = makeAssets();
  if (!scenarioA(assets)) {
    console.log('export_gpu: BỎ QUA — máy không dùng được GPU NVIDIA (CUDA/NVENC)');
    return;
  }
  scenarioB();
  scenarioC(assets);
  const lutOk = /lut2/.test(run('ffmpeg', ['-hide_banner', '-h', 'filter=crabgeo_cuda']).stdout || '');
  scenarioD(lutOk);
  scenarioE(assets);
  if (!process.env.KEEP_TEST_DIR) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export gpu ok');
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
