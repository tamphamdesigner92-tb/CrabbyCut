/**
 * BỘ SO CHẤT LƯỢNG EXPORT — Bước 0.3 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md.
 * Chạy: node tests/scripts/export_fidelity.js --old <A> --new <B> [--gold-from <A>]
 *   A, B = thư mục lượt đo của bench:export (runs/<n>, chạy bench với --keep-output) hoặc
 *          thẳng một file .mp4. Thư mục thì lấy final_cut.mp4 + export_timeline.json trong đó.
 *
 * VÌ SAO KHÔNG DÙNG MỘT NGƯỠNG SSIM ĐƠN GIẢN: đo vi mô cho thấy SSIM ≥ 0,995 đánh trượt cả
 * những thay đổi CHÍNH XÁC HƠN (đường YUV nhanh bỏ được một vòng YUV→RGB→YUV 8-bit, nên nó
 * lệch khỏi bản cũ mà lại gần sự thật hơn). Vì vậy so theo ba lớp, như đã chốt với người dùng:
 *
 *   (a) GẦN BẢN CHUẨN ÍT NHẤT BẰNG BẢN CŨ. Bản chuẩn = CÙNG đồ thị filter của lượt cũ (đọc từ
 *       export_bench/*.cmd.json + filter script mà sidecar giữ lại khi CRABBYCUT_EXPORT_BENCH=1)
 *       nhưng ghép ở yuv444p10 — không hạ mẫu màu, không vòng qua RGB 8-bit — ra FFV1 lossless.
 *       10-bit 4:4:4 là mức cao nhất `overlay` hỗ trợ (vf_overlay.c không có định dạng 16-bit).
 *       Hai bản cùng đổi sang gbrp16le bằng CÙNG ma trận BT.709/tv rồi mới đo PSNR.
 *   (b) MỚI SO VỚI CŨ: VMAF ≥ 95, PSNR ≥ 45 dB, và KHÔNG khung nào PSNR < 38 dB. Ngưỡng PSNR 45 dB
 *       được MIỄN khi bản mới gần bản chuẩn hơn bản cũ ≥ 1 dB (người dùng chốt 2026-09-29).
 *   (c) cùng số khung, cùng thời lượng.
 *   (d) khung ở mọi điểm nối lane chính và khung đầu/cuối của mọi lớp phủ (±1 khung) được liệt
 *       kê riêng: mất một khung phụ đề ở 4K làm PSNR của đúng khung đó tụt xuống ~24 dB, trong
 *       khi trung bình cả phim gần như không nhúc nhích.
 * Tiếng: so PCM, chỉ BÁO (không đánh trượt) — chỉ đòi khớp tuyệt đối khi binary ffmpeg và chuỗi
 * tiếng không đổi, và việc đó người chạy biết chứ công cụ không biết.
 *
 * SO TRÊN BẢN LOSSLESS CỦA ĐỒ THỊ, không trên file mp4: bench:export --lossless chạy lại đúng
 * lệnh ffmpeg của lượt đó với FFV1 thay cho NVENC/x264 (`lossless.mkv` trong thư mục lượt), và
 * --gold dựng luôn bản chuẩn (`gold.mkv`). So trên mp4 thì nhiễu của bộ mã hoá lấn hết thay đổi
 * của đồ thị: hai lượt GIỐNG HỆT nhau qua NVENC mà VMAF chỉ 97,9. Thư mục lượt không có
 * lossless.mkv thì mới lùi về final_cut.mp4 (khi thứ thay đổi CHÍNH là bộ mã hoá, mục 1.9).
 *
 * Cũ và mới PHẢI dựng bằng CÙNG một binary ffmpeg (swscale đổi giữa các bản) — --ffmpeg-dir
 * đưa bản ghim lên đầu PATH, như bench:export.
 * Tham số: --vmaf-subsample N (mặc định 1 = mọi khung; 4K dài nên đặt 5–10), --no-vmaf,
 *          --tolerance-db X (dung sai cho tiêu chí (a), mặc định 0,05 dB), --json <file>.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const opts = { vmafSubsample: 1, vmaf: true, toleranceDb: 0.05 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => { i += 1; assert.ok(i < argv.length, `thiếu giá trị cho ${arg}`); return argv[i]; };
    if (arg === '--old') opts.old = path.resolve(next());
    else if (arg === '--new') opts.new = path.resolve(next());
    else if (arg === '--gold') opts.gold = path.resolve(next());
    else if (arg === '--gold-from') opts.goldFrom = path.resolve(next());
    else if (arg === '--vmaf-subsample') opts.vmafSubsample = Math.max(1, Math.floor(Number(next())));
    else if (arg === '--no-vmaf') opts.vmaf = false;
    else if (arg === '--tolerance-db') opts.toleranceDb = Number(next());
    else if (arg === '--json') opts.json = path.resolve(next());
    else if (arg === '--ffmpeg-dir') opts.ffmpegDir = path.resolve(next());
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`tham số lạ: ${arg}`);
  }
  return opts;
}

function run(args, cwd, label) {
  const r = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`${label || args[0]} thất bại (exit ${r.status}):\n${String(r.stderr || r.stdout).split(/\r?\n/).filter(Boolean).slice(-8).join('\n')}`);
  }
  return r;
}

function resolveInput(target) {
  if (fs.statSync(target).isDirectory()) {
    const lossless = path.join(target, 'lossless.mkv');
    const encoded = path.join(target, 'final_cut.mp4');
    const video = fs.existsSync(lossless) ? lossless : encoded;
    assert.ok(fs.existsSync(video), `${target} không có lossless.mkv lẫn final_cut.mp4 — chạy bench:export với --lossless hoặc --keep-output`);
    const timelineFile = path.join(target, 'export_timeline.json');
    return {
      video,
      audio: fs.existsSync(encoded) ? encoded : null,
      lossless: video === lossless,
      dir: target,
      gold: fs.existsSync(path.join(target, 'gold.mkv')) ? path.join(target, 'gold.mkv') : null,
      timeline: fs.existsSync(timelineFile) ? JSON.parse(fs.readFileSync(timelineFile, 'utf8')) : null,
    };
  }
  return { video: target, audio: target, lossless: false, dir: path.dirname(target), gold: null, timeline: null };
}

function probe(file) {
  const r = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=width,height,pix_fmt,avg_frame_rate,nb_read_packets,duration,color_range,color_space',
    '-show_entries', 'format=duration', '-of', 'json', file], undefined, 'ffprobe');
  const json = JSON.parse(r.stdout);
  const s = json.streams[0];
  const [num, den] = String(s.avg_frame_rate).split('/').map(Number);
  return {
    width: s.width,
    height: s.height,
    pix_fmt: s.pix_fmt,
    fps: den ? num / den : num,
    frames: Number(s.nb_read_packets),
    duration: Number(json.format?.duration),
    color: `${s.color_range || '?'}/${s.color_space || '?'}`,
  };
}

/* ---------------- Bản chuẩn: biến đổi filter script của lượt cũ ---------------- */

/* Tách chuỗi filtergraph thành các filter (theo `,` và `;` ở cấp ngoài), tôn trọng `'…'` và
 * ký tự thoát `\` — `enable='between(t,1,2)'` có dấu phẩy bên trong không được cắt. */
function tokenizeGraph(text) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { current += ch + text[i + 1]; i += 1; continue; }
    if (ch === "'") quoted = !quoted;
    if (!quoted && (ch === ',' || ch === ';')) {
      parts.push({ text: current, sep: ch });
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push({ text: current, sep: '' });
  return parts;
}

function splitOptions(args) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '\\' && i + 1 < args.length) { current += ch + args[i + 1]; i += 1; continue; }
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === ':') { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

/* Định dạng 8-bit của đồ thị -> 10-bit 4:4:4 của bản chuẩn. Chỗ nào đường cũ ĐỔI SANG RGBA
 * thì bản chuẩn đổi sang YUV bằng ma trận BT.709/tv NÓI RÕ: `format=` trần để swscale tự chọn
 * ma trận RGB->YUV mặc định là BT.601, trong khi đường cũ đổi ở cuối bằng BT.709
 * (OutputColorFilters). Lần dựng đầu thiếu bước này và bản cũ chỉ cách bản chuẩn 33 dB — lệch
 * ma trận ở mọi lớp phủ PNG, không phải sai số thật. */
const GOLD_FORMAT = {
  rgba: 'scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le',
  yuva420p: 'scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le',
  yuv420p: 'format=yuv444p10le',
  /* Chuỗi màu (LUT, blend trộn LUT) của đường CPU kết thúc bằng `format=rgb24`: lut3d đàm phán định
   * dạng theo bộ lọc sau nó nên nhận luôn rgb24 — nguồn 10-bit bị hạ về RGB 8-bit TRƯỚC khi qua LUT.
   * Bản chuẩn giữ nguyên chữ đó thì mắc y lỗi ấy: đo 2026-10-03 trên "Yêu Con" (LUT tĩnh), so một
   * bản dựng float thật, đường CPU 39,4 dB, bản chuẩn cũ 39,5 dB, đồ thị GPU (LUT tính float) 49,3 dB
   * — bộ so chấm ngược. Float thì lut3d/blend chạy float từ đầu tới cuối. */
  rgb24: 'format=gbrpf32le',
};

function goldFilter(body) {
  const eq = body.indexOf('=');
  const name = (eq < 0 ? body : body.slice(0, eq)).trim();
  if (eq < 0) return { text: body, changed: false };
  const args = body.slice(eq + 1);
  if (name === 'format' && GOLD_FORMAT[args.trim()]) {
    return { text: GOLD_FORMAT[args.trim()], changed: true };
  }
  if (name === 'overlay') {
    const options = splitOptions(args);
    const idx = options.findIndex((o) => o.startsWith('format='));
    if (idx >= 0) options[idx] = 'format=yuv444p10';
    else options.push('format=yuv444p10');
    return { text: `overlay=${options.join(':')}`, changed: true };
  }
  return { text: body, changed: false };
}

function goldScript(scriptText) {
  let changes = 0;
  const out = tokenizeGraph(scriptText).map(({ text, sep }) => {
    // Nhãn đầu `[a][b]` và nhãn cuối `[c]` giữ nguyên, chỉ biến đổi phần thân filter.
    const m = /^(\s*(?:\[[^\]]*\]\s*)*)([\s\S]*?)((?:\s*\[[^\]]*\])*\s*)$/.exec(text);
    const g = goldFilter(m[2]);
    if (g.changed) changes += 1;
    return `${m[1]}${g.text}${m[3]}${sep}`;
  }).join('');
  return { text: out, changes };
}

/* Chạy lại MỌI lệnh ffmpeg hình của một lượt đo (export_bench/batch_*.cmd.json) với FFV1 thay
 * cho bộ mã hoá, ghép các batch thành `<runDir>/<name>.mkv`. `gold` = biến đổi filter script
 * sang bản chuẩn (goldScript). Phải chạy khi input của lượt đó CÒN trong temp (PNG chữ, chuỗi
 * khung) — bench:export gọi ngay sau lượt đo; bản chép filter script trong runDir được ưu tiên
 * vì bản trong temp có thể đã bị lượt sau ghi đè. So tiếng thì dùng file mp4. */
function renderFromCommands(runDir, { gold = false } = {}) {
  const name = gold ? 'gold' : 'lossless';
  const benchDir = path.join(runDir, 'export_bench');
  assert.ok(fs.existsSync(benchDir), `${runDir} không có export_bench/ (bench:export bật CRABBYCUT_EXPORT_BENCH=1 thì mới có)`);
  const workDir = path.join(runDir, `${name}_parts`);
  fs.mkdirSync(workDir, { recursive: true });
  const cmdFiles = fs.readdirSync(benchDir).filter((n) => /^batch_\d+\.cmd\.json$/.test(n)).sort();
  assert.ok(cmdFiles.length, `${benchDir}: không có batch_*.cmd.json`);
  const parts = [];
  for (const file of cmdFiles) {
    const label = file.replace(/\.cmd\.json$/, '');
    const { cwd, args } = JSON.parse(fs.readFileSync(path.join(benchDir, file), 'utf8'));
    const scriptIdx = args.indexOf('-/filter_complex') + 1;
    assert.ok(scriptIdx > 0, `${file}: không thấy -/filter_complex`);
    const kept = path.join(runDir, path.basename(args[scriptIdx]));
    let scriptPath = fs.existsSync(kept) ? kept : args[scriptIdx];
    let note = '';
    if (gold) {
      const transformed = goldScript(fs.readFileSync(scriptPath, 'utf8'));
      scriptPath = path.join(workDir, `${label}.filter.txt`);
      fs.writeFileSync(scriptPath, transformed.text, 'utf8');
      note = ` (${transformed.changes} filter đổi sang yuv444p10)`;
    } else if (args.includes('-init_hw_device')) {
      // Đồ thị GPU (mục 1.21): khung [v] nằm trên GPU — tải về RAM rồi mới vào FFV1.
      const text = fs.readFileSync(scriptPath, 'utf8').replace(/(setparams=[^;[]*)\[v\]/, '$1,hwdownload,format=yuv420p[v]');
      scriptPath = path.join(workDir, `${label}.filter.txt`);
      fs.writeFileSync(scriptPath, text, 'utf8');
      note = ' (đồ thị GPU, tải về trước FFV1)';
    }
    const cutAt = args.lastIndexOf('-dn');
    assert.ok(cutAt > 0, `${file}: không tìm thấy -dn để thay encoder`);
    // Giữ `-map [a]` của lượt "full": bỏ nó thì nhãn [a] trong filter script thành đầu ra
    // treo và ffmpeg từ chối cả đồ thị ("has an unconnected output"). Tiếng ghi PCM, rẻ.
    const renderArgs = args.slice(0, cutAt + 1);
    renderArgs[scriptIdx] = scriptPath;
    const output = path.join(workDir, `${label}.mkv`);
    renderArgs.push('-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '16', '-slicecrc', '0',
      '-c:a', 'pcm_s16le', output);
    console.log(`  [${name}] ${label}${note} ...`);
    const t0 = Date.now();
    run(renderArgs, cwd, `${name} ${label}`);
    console.log(`  [${name}] ${label}: xong sau ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    parts.push(output);
  }
  const joined = path.join(runDir, `${name}.mkv`);
  if (parts.length === 1) {
    fs.renameSync(parts[0], joined);
  } else {
    const list = path.join(workDir, 'concat.txt');
    fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    run(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v', '-c', 'copy', joined], undefined, `${name} concat`);
    parts.forEach((p) => fs.rmSync(p, { force: true }));
  }
  return joined;
}

/* ---------------- Đo ---------------- */

function readStats(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const row = {};
    for (const m of line.matchAll(/(\w+):([-\w.]+)/g)) row[m[1]] = m[2] === 'inf' ? Infinity : Number(m[2]);
    return row;
  });
}

/* PSNR + SSIM một lượt. `space`:
 *   'yuv' — so thẳng YUV như bản xuất (tiêu chí b);
 *   'rgb' — cả hai qua gbrp16le/gbrp bằng CÙNG ma trận (tiêu chí a, so với bản chuẩn).
 * stats_file dùng đường dẫn TƯƠNG ĐỐI (cwd = workDir): `C:` trong filtergraph phải thoát. */
function compare(distorted, reference, workDir, tag, space) {
  const conv = (bits) => (space === 'rgb'
    ? `scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=bicubic+accurate_rnd+full_chroma_int,format=gbrp${bits}`
    : 'null');
  const graph = [
    `[0:v]setpts=PTS-STARTPTS,split[d1][d2]`,
    `[1:v]setpts=PTS-STARTPTS,split[r1][r2]`,
    `[d1]${conv('16le')}[dp]`, `[r1]${conv('16le')}[rp]`,
    `[dp][rp]psnr=stats_file=${tag}_psnr.log[o1]`,
    `[d2]${conv('')}[ds]`, `[r2]${conv('')}[rs]`,
    `[ds][rs]ssim=stats_file=${tag}_ssim.log[o2]`,
  ].join(';');
  const t0 = Date.now();
  run(['ffmpeg', '-hide_banner', '-v', 'error', '-nostdin', '-i', distorted, '-i', reference,
    '-filter_complex', graph, '-map', '[o1]', '-map', '[o2]', '-f', 'null', '-'], workDir, `so ${tag}`);
  const psnr = readStats(path.join(workDir, `${tag}_psnr.log`));
  const ssim = readStats(path.join(workDir, `${tag}_ssim.log`));
  const mseAvg = psnr.reduce((s, r) => s + r.mse_avg, 0) / psnr.length;
  const maxVal = space === 'rgb' ? 65535 : 255;
  const perFrame = psnr.map((r) => r.psnr_avg);
  const worst = perFrame.map((v, i) => ({ frame: i, psnr: v })).sort((a, b) => a.psnr - b.psnr).slice(0, 5);
  return {
    space,
    frames: psnr.length,
    psnr_db: mseAvg > 0 ? +(10 * Math.log10((maxVal * maxVal) / mseAvg)).toFixed(3) : Infinity,
    psnr_min_db: +Math.min(...perFrame).toFixed(3),
    ssim: +(ssim.reduce((s, r) => s + (r.All ?? 0), 0) / ssim.length).toFixed(5),
    worst_frames: worst,
    per_frame_psnr: perFrame,
    seconds: +((Date.now() - t0) / 1000).toFixed(1),
  };
}

function vmaf(distorted, reference, workDir, subsample) {
  const threads = Math.max(1, os.cpus().length);
  const t0 = Date.now();
  run(['ffmpeg', '-hide_banner', '-v', 'error', '-nostdin', '-i', distorted, '-i', reference,
    '-filter_complex', `[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]libvmaf=log_path=vmaf.json:log_fmt=json:n_threads=${threads}:n_subsample=${subsample}`,
    '-f', 'null', '-'], workDir, 'libvmaf');
  const json = JSON.parse(fs.readFileSync(path.join(workDir, 'vmaf.json'), 'utf8'));
  const frames = (json.frames || []).map((f) => f.metrics?.vmaf).filter(Number.isFinite);
  return {
    vmaf: +Number(json.pooled_metrics?.vmaf?.mean).toFixed(3),
    vmaf_min: frames.length ? +Math.min(...frames).toFixed(3) : null,
    subsample,
    seconds: +((Date.now() - t0) / 1000).toFixed(1),
  };
}

function audioCompare(a, b, workDir) {
  const pcm = (file, out) => spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0',
    '-f', 's16le', '-ac', '2', '-ar', '48000', out], { cwd: workDir });
  const pa = path.join(workDir, 'a_old.pcm');
  const pb = path.join(workDir, 'a_new.pcm');
  if (pcm(a, pa).status !== 0 || pcm(b, pb).status !== 0) return { available: false };
  const x = fs.readFileSync(pa);
  const y = fs.readFileSync(pb);
  let maxDiff = 0;
  const n = Math.min(x.length, y.length) >> 1;
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(x.readInt16LE(i * 2) - y.readInt16LE(i * 2)));
  fs.rmSync(pa, { force: true });
  fs.rmSync(pb, { force: true });
  return { available: true, identical: x.equals(y), samples_old: x.length / 4, samples_new: y.length / 4, max_abs_diff: maxDiff };
}

/* Khung ở điểm nối lane chính + khung đầu/cuối lớp phủ. Lưới khung thật do sidecar dựng
 * (BuildTimelineFrameGrid) và không ghi ra JSON, nên tính gần đúng theo giây rồi xét ±1 khung. */
function boundaryFrames(timeline, fps, frameCount) {
  if (!timeline) return [];
  const marks = new Map();
  const add = (frame, why) => {
    for (const f of [frame - 1, frame, frame + 1]) {
      if (f < 0 || f >= frameCount) continue;
      if (!marks.has(f)) marks.set(f, why);
    }
  };
  let t = 0;
  for (const item of timeline.intervals || []) {
    const speed = Number(item.speed_rate) > 0 ? Number(item.speed_rate) : 1;
    add(Math.round(t * fps), `đầu clip ${item.index}`);
    t += Math.max(0, Number(item.end) - Number(item.start)) / speed;
    add(Math.round(t * fps) - 1, `cuối clip ${item.index}`);
  }
  for (const ov of timeline.overlays || []) {
    const start = Number(ov.timeline_start) || 0;
    const end = start + (Number(ov.duration) || 0);
    add(Math.round(start * fps), `đầu lớp phủ ${ov.id}`);
    add(Math.round(end * fps) - 1, `cuối lớp phủ ${ov.id}`);
  }
  return [...marks.entries()].map(([frame, why]) => ({ frame, why }));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.old || !opts.new) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    process.exit(opts.help ? 0 : 2);
  }
  if (opts.ffmpegDir) process.env.PATH = `${opts.ffmpegDir}${path.delimiter}${process.env.PATH}`;
  const oldIn = resolveInput(opts.old);
  const newIn = resolveInput(opts.new);
  assert.strictEqual(oldIn.lossless, newIn.lossless,
    'một bên là bản lossless của đồ thị, một bên là mp4 đã mã hoá — không so được với nhau');
  const workDir = path.join(newIn.dir, 'fidelity');
  fs.mkdirSync(workDir, { recursive: true });
  const ffmpeg = String(run(['ffmpeg', '-hide_banner', '-version']).stdout).split(/\r?\n/)[0];
  console.log(`[fidelity] ${ffmpeg}\n  cũ: ${oldIn.video}\n  mới: ${newIn.video}`);

  const pOld = probe(oldIn.video);
  const pNew = probe(newIn.video);
  const result = { ffmpeg, old: { file: oldIn.video, ...pOld }, new: { file: newIn.video, ...pNew }, checks: {}, failures: [] };

  // (c) cùng số khung, cùng thời lượng (dung sai nửa khung).
  result.checks.frames = { old: pOld.frames, new: pNew.frames, ok: pOld.frames === pNew.frames };
  const halfFrame = 0.5 / (pOld.fps || 30);
  result.checks.duration = { old: pOld.duration, new: pNew.duration, ok: Math.abs(pOld.duration - pNew.duration) <= halfFrame + 0.03 };
  if (!result.checks.frames.ok) result.failures.push(`(c) số khung lệch: cũ ${pOld.frames}, mới ${pNew.frames}`);
  if (!result.checks.duration.ok) result.failures.push(`(c) thời lượng lệch: cũ ${pOld.duration}, mới ${pNew.duration}`);

  // (b) mới so với cũ.
  console.log('  (b) PSNR/SSIM mới so với cũ ...');
  const nvso = compare(newIn.video, oldIn.video, workDir, 'new_vs_old', 'yuv');
  result.checks.new_vs_old = { ...nvso, per_frame_psnr: undefined };
  // PSNR mới/cũ ≥ 45 dB xét SAU (a) — xem khối "(b) nới" bên dưới.
  if (nvso.psnr_min_db < 38) result.failures.push(`(b) khung tệ nhất ${nvso.psnr_min_db} dB < 38 (khung ${nvso.worst_frames[0].frame})`);
  if (opts.vmaf) {
    console.log(`  (b) VMAF (n_subsample=${opts.vmafSubsample}) ...`);
    const v = vmaf(newIn.video, oldIn.video, workDir, opts.vmafSubsample);
    result.checks.vmaf = v;
    if (!(v.vmaf >= 95)) result.failures.push(`(b) VMAF ${v.vmaf} < 95`);
  }

  // (d) khung ở điểm nối và mép lớp phủ.
  const marks = boundaryFrames(oldIn.timeline || newIn.timeline, pOld.fps, nvso.per_frame_psnr.length);
  if (marks.length) {
    const scored = marks.map((m) => ({ ...m, psnr: nvso.per_frame_psnr[m.frame] })).sort((a, b) => a.psnr - b.psnr);
    result.checks.boundaries = { count: scored.length, worst: scored.slice(0, 8) };
    if (scored[0].psnr < 38) result.failures.push(`(d) khung biên ${scored[0].frame} (${scored[0].why}) chỉ ${scored[0].psnr} dB`);
  }

  // (a) so với bản chuẩn.
  let gold = opts.gold || oldIn.gold || null;
  if (!gold && opts.goldFrom) gold = renderFromCommands(opts.goldFrom, { gold: true });
  if (gold) {
    console.log('  (a) cũ và mới so với bản chuẩn (RGB 16-bit) ...');
    const oldGold = compare(oldIn.video, gold, workDir, 'old_vs_gold', 'rgb');
    const newGold = compare(newIn.video, gold, workDir, 'new_vs_gold', 'rgb');
    result.checks.gold = {
      file: gold,
      old: { ...oldGold, per_frame_psnr: undefined },
      new: { ...newGold, per_frame_psnr: undefined },
      delta_db: +(newGold.psnr_db - oldGold.psnr_db).toFixed(3),
    };
    if (newGold.psnr_db < oldGold.psnr_db - opts.toleranceDb) {
      result.failures.push(`(a) mới xa bản chuẩn hơn cũ: ${newGold.psnr_db} dB so với ${oldGold.psnr_db} dB`);
    }
  } else {
    result.checks.gold = { skipped: 'không có --gold / --gold-from' };
  }

  /* (b) nới — người dùng chốt 2026-09-29 (mục 1.5 của kế hoạch): ngưỡng "PSNR mới/cũ ≥ 45 dB" BỎ
   * khi bản mới gần bản chuẩn hơn bản cũ RÕ RỆT (≥ GOLD_GAIN_DB). Lý do: bản cũ tự nó cách bản
   * chuẩn ~40 dB (vòng YUV -> RGB -> YUV 8-bit), nên một thay đổi chính xác hơn nhiều buộc phải
   * lệch khỏi bản cũ chừng ấy — Bin Tom với 1.3 + 1.5: mới/cũ 43,5 dB, còn so bản chuẩn 40,3 ->
   * 52,5 dB. VMAF ≥ 95 và ngưỡng khung tệ nhất vẫn giữ nguyên. Không có bản chuẩn thì vẫn đòi 45. */
  const GOLD_GAIN_DB = 1;
  const goldGain = result.checks.gold && Number.isFinite(result.checks.gold.delta_db) ? result.checks.gold.delta_db : null;
  if (nvso.psnr_db < 45) {
    if (goldGain !== null && goldGain >= GOLD_GAIN_DB) {
      result.checks.new_vs_old.psnr_waived = `bản mới gần bản chuẩn hơn ${goldGain} dB (≥ ${GOLD_GAIN_DB})`;
    } else {
      result.failures.push(`(b) PSNR mới/cũ ${nvso.psnr_db} dB < 45`);
    }
  }

  result.checks.audio = oldIn.audio && newIn.audio
    ? audioCompare(oldIn.audio, newIn.audio, workDir)
    : { available: false };
  result.pass = result.failures.length === 0;

  const outPath = opts.json || path.join(workDir, 'fidelity.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  const c = result.checks;
  console.log('');
  console.log(`  khung: cũ ${pOld.frames} / mới ${pNew.frames} · thời lượng ${pOld.duration} / ${pNew.duration}`);
  console.log(`  mới/cũ: PSNR ${c.new_vs_old.psnr_db} dB (tệ nhất ${c.new_vs_old.psnr_min_db}) · SSIM ${c.new_vs_old.ssim}${c.vmaf ? ` · VMAF ${c.vmaf.vmaf} (min ${c.vmaf.vmaf_min})` : ''}`
    + (c.new_vs_old.psnr_waived ? ` · miễn ngưỡng 45 dB: ${c.new_vs_old.psnr_waived}` : ''));
  if (c.boundaries) console.log(`  khung biên: ${c.boundaries.count} khung, tệ nhất ${c.boundaries.worst[0].psnr} dB (${c.boundaries.worst[0].why})`);
  if (c.gold.old) console.log(`  so bản chuẩn: cũ ${c.gold.old.psnr_db} dB · mới ${c.gold.new.psnr_db} dB (Δ ${c.gold.delta_db})`);
  if (c.audio.available) console.log(`  tiếng: ${c.audio.identical ? 'giống hệt' : `khác, lệch tối đa ${c.audio.max_abs_diff}`}`);
  console.log(result.pass ? '[fidelity] ĐẠT' : `[fidelity] KHÔNG ĐẠT:\n  - ${result.failures.join('\n  - ')}`);
  console.log(`  ghi ${outPath}`);
  if (!result.pass) process.exitCode = 1;
}

module.exports = { renderFromCommands, goldScript };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[fidelity] lỗi:', error.message || error);
    process.exitCode = 2;
  }
}
