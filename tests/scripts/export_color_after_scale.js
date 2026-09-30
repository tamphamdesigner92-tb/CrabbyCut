/* =====================================================================
 * MÀU THEO TỪNG ĐIỂM ẢNH ÁP SAU BƯỚC CO NHỎ — mục 1.19 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 *
 * Sidecar vốn áp chuỗi màu (của block + lớp Điều chỉnh) ở cỡ NGUỒN rồi mới co về cỡ hiển thị.
 * Nguồn lớn hơn khung nhiều (DJI 1728×3072 trên 1080×1920) thì phần màu tốn gấp bội: dự án thật
 * "Yêu Con 1" mất 85/118,5 s phần hình chỉ cho một lớp Điều chỉnh có keyframe cường độ LUT. Nay
 * các tầng theo từng điểm ảnh chạy SAU phép co (xem ColorChainIsPointwise). Bài test chốt:
 *
 *   1. ĐÚNG CHỖ: tầng dời được thì đứng sau `scale` trong filter script; tầng theo lân cận
 *      (unsharp/avgblur/noise), mọi tầng đứng trước nó, clip PHÓNG TO và clip có keyframe hình học
 *      thì giữ nguyên chỗ cũ — filter script TRÙNG từng chữ với thứ tự cũ (env tắt).
 *   2. CÙNG HÌNH: bản mới so với thứ tự cũ (CRABBYCUT_EXPORT_COLOR_AFTER_SCALE=0), dựng lại ra FFV1,
 *      đủ gần ở TỪNG khung — kể cả khung đầu/cuối của dốc trộn LUT (sendcmd lệch một khung là tụt
 *      hẳn), và màu THẬT SỰ được áp (khác xa bản không chỉnh màu).
 *   3. Đủ các nhánh: đường nhanh lane chính, đường cũ lane chính (clip lật), lớp phủ video.
 *
 * Chạy: npm run test:export-color-after-scale
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { renderFromCommands } = require('./export_fidelity.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_color_after_scale');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const SEQ_W = 320;
const SEQ_H = 180;
const FPS = 30;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}

// Nguồn GẤP ĐÔI khung (640×360 trên sequence 320×180) -> fit_scale 0,5: scale 100 là co nhỏ.
function makeSource(file) {
  mustRun('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${FPS}:duration=4`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-shortest', file], `nguồn ${path.basename(file)}`);
}

// LUT 3D cỡ 9 — hai LUT lệch nhau rõ để dốc trộn thấy được từng khung.
function writeCube(file, fn) {
  const n = 9;
  const lines = [`LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const out = fn(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => Math.max(0, Math.min(1, v)).toFixed(6));
        lines.push(out.join(' '));
      }
    }
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function writeTimeline(file, { clip = {}, overlay = null } = {}) {
  const interval = {
    index: 0, script_index: 0, text: 'c0', start: 0.5, end: 1.5,
    scale: 100, fit_scale: 0.5, position_x: 0, position_y: 0, ...clip,
  };
  fs.writeFileSync(file, JSON.stringify({
    version: 5,
    sequence: { width: SEQ_W, height: SEQ_H, fps: String(FPS) },
    intervals: [interval],
    editingTracks: [], editingItems: [], assets: [], main_audio_volume: 100,
    overlays: overlay ? [overlay] : [],
    settings: { resolution: 'sequence', width: SEQ_W, height: SEQ_H, fps: String(FPS), render_fps: String(FPS), codec: 'h264', quality: 'high', audio_bitrate: '128k' },
  }), 'utf8');
}

/* Một lượt xuất; chép export_bench/ + filter script vào runs/<tag> rồi dựng lại NGAY đồ thị ra FFV1
 * (`lossless`). Phải dựng ngay: file lệnh sendcmd (`lutmix_*.cmd`) nằm ở thư mục tạm, đánh số lại từ
 * 1 ở mỗi tiến trình — lượt xuất sau GHI ĐÈ lên file của lượt trước (đã mắc: bản mới dựng lại bằng
 * lệnh trộn của bản cũ, đột biến trễ một khung lọt qua). `after` = false -> env tắt, thứ tự cũ. */
function exportOnce(tag, source, timelineFile, after) {
  const output = path.join(TEST_DIR, `${tag}.mp4`);
  const r = run(SIDECAR, ['export-video', source, output, timelineFile, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 600000,
    env: {
      ...process.env, FFMPEG_EXPORT_HW: '0', CRABBYCUT_EXPORT_BENCH: '1',
      CRABBYCUT_EXPORT_COLOR_AFTER_SCALE: after ? '1' : '0',
    },
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
  // Tên file lệnh sendcmd có số thứ tự chạy theo cả tiến trình -> bỏ đi khi so hai script.
  return {
    runDir, script, scriptNorm: script.replace(/lutmix_[A-Za-z0-9_]+\.cmd/g, 'lutmix.cmd'),
    lossless: renderFromCommands(runDir),
  };
}

// PSNR RGB (BT.709, như lúc hiển thị) từng khung giữa hai bản FFV1.
function psnrFrames(a, b, tag) {
  const stats = path.join(TEST_DIR, `psnr_${tag}.log`).replace(/\\/g, '/');
  const statsArg = stats.replace(/:/g, '\\:');
  const conv = 'scale=in_color_matrix=bt709:in_range=tv,format=gbrp';
  mustRun('ffmpeg', ['-v', 'error', '-i', a, '-i', b, '-lavfi',
    `[0:v]${conv}[x];[1:v]${conv}[y];[x][y]psnr=stats_file='${statsArg}'`, '-f', 'null', '-'], `psnr ${tag}`);
  return fs.readFileSync(stats, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const m = /mse_avg:([\d.]+)/.exec(line);
    const mse = m ? Number(m[1]) : NaN;
    return mse <= 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  });
}

/* Vị trí tầng màu so với phép co của CHÍNH chuỗi đang xét: `from` = đoạn chữ mở đầu chuỗi (clip
 * lane chính là chuỗi `…:v]trim=start=` đầu tiên — input của nó có thể là dải nguồn riêng, không
 * phải [0:v]; lớp phủ nhận ra bằng setpts dời tới mốc bắt đầu của nó). */
function colorAfterScale(script, from, marker, scaleToken) {
  const at = script.indexOf(from);
  assert.ok(at >= 0, `không thấy "${from}" trong filter script`);
  const seg = script.slice(at);
  const c = seg.indexOf(marker);
  const s = seg.indexOf(scaleToken);
  assert.ok(c >= 0, `không thấy "${marker}" trong chuỗi ${from}`);
  assert.ok(s >= 0, `không thấy "${scaleToken}" trong chuỗi ${from}`);
  return c > s;
}

function main() {
  if (!fs.existsSync(SIDECAR)) {
    console.log('export_color_after_scale: BỎ QUA — chưa build sidecar (npm run build:sidecar)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const source = path.join(TEST_DIR, 'temp_input.mp4');
  makeSource(source);
  const warm = path.join(TEST_DIR, 'warm.cube');
  const cool = path.join(TEST_DIR, 'cool.cube');
  // "warm" khác HẲN "cool" (đảo đỏ, bình phương lục, căn lam): trộn lệch nửa độ là thấy rõ.
  writeCube(warm, (r, g, b) => [1 - r * 0.9, g * g, Math.sqrt(b)]);
  writeCube(cool, (r, g, b) => [r * 0.82, g * 0.97 + 0.02, b * 1.1 + 0.05]);
  /* Lớp Điều chỉnh có keyframe cường độ LUT: dốc 0 -> 1 DỐC ĐỨNG trong 2 khung (0,4 -> 0,467 s).
   * Dốc thoải thì lệnh sendcmd trễ một khung chỉ lệch vài phần trăm độ trộn, lọt ngưỡng 30 dB;
   * dốc 2 khung thì trễ một khung là lệch nửa độ trộn (đã thử đột biến: tụt dưới ngưỡng). */
  const MIX = 'clip((LOCALT-0.4)*15,0,1)';
  const lutMix = { adj_layer_lut_a_path: cool, adj_layer_lut_b_path: warm, adj_layer_lut_mix_expr: MIX };

  const MAIN = ':v]trim=start=';
  const OVERLAY = 'setpts=PTS-STARTPTS+0.100000/TB';
  const FAST_SCALE = 'scale=w=';
  const OLD_SCALE = 'scale=max(2';
  const cases = [
    { name: 'lớp Điều chỉnh trộn LUT, co 50% (đường nhanh)', clip: { ...lutMix }, marker: 'lut3d=', from: MAIN, scale: FAST_SCALE, moved: true },
    { name: 'eq của block + curves của lớp, co 50%', clip: { adj_filters: 'eq=brightness=0.06:saturation=1.3', adj_layer_filters: 'curves=preset=vintage' }, marker: 'eq=', from: MAIN, scale: FAST_SCALE, moved: true },
    { name: 'unsharp của block giữ chỗ, lớp LUT dời', clip: { adj_filters: 'unsharp=lx=5:ly=5:la=1.2', ...lutMix }, marker: 'lut3d=', from: MAIN, scale: FAST_SCALE, moved: true, keepMarker: 'unsharp=' },
    { name: 'lớp có avgblur -> cả hai tầng giữ chỗ', clip: { adj_filters: 'eq=saturation=1.3', adj_layer_filters: 'avgblur=sizeX=2:sizeY=2' }, marker: 'eq=', from: MAIN, scale: FAST_SCALE, moved: false },
    { name: 'phóng to 125% -> giữ chỗ', clip: { scale: 250, ...lutMix }, marker: 'lut3d=', from: MAIN, scale: FAST_SCALE, moved: false },
    { name: 'clip lật (đường cũ), co 50%', clip: { flip_x: true, ...lutMix }, marker: 'lut3d=', from: MAIN, scale: OLD_SCALE, moved: true },
    { name: 'keyframe scale -> giữ chỗ', clip: { kf_scale_expr: '100+20*LOCALT', ...lutMix }, marker: 'lut3d=', from: MAIN, scale: 'scale=w=', moved: false, structureOnly: true },
    {
      name: 'lớp phủ video co 40% có LUT',
      overlay: {
        index: 0, id: 'ov', type: 'media', asset_type: 'media_video', asset_path: source,
        timeline_start: 0.1, duration: 0.8, source_start: 1, muted: true, has_audio: false,
        position_x: 20, position_y: -10, rotation: 0, opacity: 100, scale: 80, fit_scale: 0.5,
        adj_lut_a_path: cool, adj_lut_b_path: warm, adj_lut_mix_expr: MIX,
      },
      marker: 'lut3d=', from: OVERLAY, scale: OLD_SCALE, moved: true,
    },
  ];

  for (const [k, c] of cases.entries()) {
    const tl = path.join(TEST_DIR, `timeline_${k}.json`);
    writeTimeline(tl, { clip: c.clip || {}, overlay: c.overlay || null });
    const now = exportOnce(`c${k}_new`, source, tl, true);
    const old = exportOnce(`c${k}_old`, source, tl, false);

    // 1. ĐÚNG CHỖ
    assert.strictEqual(colorAfterScale(old.script, c.from, c.marker, c.scale), false,
      `ca ${k} (${c.name}): env tắt mà tầng màu vẫn đứng sau phép co`);
    if (!c.moved) {
      assert.strictEqual(now.scriptNorm, old.scriptNorm, `ca ${k} (${c.name}): không được dời mà filter script khác thứ tự cũ`);
      console.log(`  ok  ca ${k} ${c.name}: giữ nguyên thứ tự cũ (script trùng)`);
      continue;
    }
    assert.strictEqual(colorAfterScale(now.script, c.from, c.marker, c.scale), true,
      `ca ${k} (${c.name}): "${c.marker}" phải đứng sau phép co`);
    if (c.keepMarker) {
      assert.strictEqual(colorAfterScale(now.script, c.from, c.keepMarker, c.scale), false,
        `ca ${k} (${c.name}): "${c.keepMarker}" (theo lân cận) phải giữ chỗ trước phép co`);
    }
    if (c.structureOnly) continue;

    // 2. CÙNG HÌNH
    const frames = psnrFrames(now.lossless, old.lossless, `c${k}`);
    assert.strictEqual(frames.length, FPS, `ca ${k}: ${frames.length} khung, kỳ vọng ${FPS}`);
    const worst = Math.min(...frames);
    assert.ok(worst >= 30, `ca ${k} (${c.name}): khung tệ nhất chỉ ${worst.toFixed(2)} dB so với thứ tự cũ`);
    console.log(`  ok  ca ${k} ${c.name}: sau phép co; so thứ tự cũ tệ nhất ${worst.toFixed(1)} dB, `
      + `trung bình ${(frames.reduce((s, v) => s + Math.min(v, 99), 0) / frames.length).toFixed(1)} dB`);
  }

  // Màu THẬT SỰ được áp: bản mới của ca 0 khác xa bản không chỉnh màu.
  const tlPlain = path.join(TEST_DIR, 'timeline_plain.json');
  writeTimeline(tlPlain);
  const plain = exportOnce('plain', source, tlPlain, true).lossless;
  const graded = path.join(TEST_DIR, 'runs', 'c0_new', 'lossless.mkv');
  const vsPlain = psnrFrames(graded, plain, 'plain');
  const lastHalf = vsPlain.slice(FPS / 2);
  assert.ok(Math.max(...lastHalf) < 30, `LUT không được áp? nửa sau clip so bản không màu cao nhất ${Math.max(...lastHalf).toFixed(1)} dB`);
  console.log(`  ok  LUT thật sự được áp (nửa sau clip so bản không màu ≤ ${Math.max(...lastHalf).toFixed(1)} dB)`);

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('export color after scale ok');
}

main();
