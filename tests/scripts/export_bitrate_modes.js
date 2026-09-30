/* =====================================================================
 * Ô "BITRATE" KIỂU CAPCUT — mục 1.20 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md (người dùng chốt 2026-10-01)
 *
 * Ô "Bitrate" (Thấp hơn / Khuyến nghị / Cao hơn / Tùy chỉnh Mbps) thay ô "Chất lượng". Ba mức đầu là
 * CHẤT LƯỢNG CỐ ĐỊNH có TRẦN (NVENC `-cq` 23/19/16, CPU CRF 23/18/16); trần = bitrate cố định cũ của
 * Cân bằng / Cao / 2×Cao theo số điểm ảnh, nên bản xuất không bao giờ to hơn bản cũ cùng mức. "Tùy
 * chỉnh" = bitrate trung bình người dùng nhập, đỉnh ×1,5. Bài test chốt:
 *
 *   1. Backend `normalizeExportSettings`: mức hợp lệ, số Mbps (dải 0,5..400, làm tròn 0,01), số sai
 *      -> Khuyến nghị, payload cũ chỉ có `quality` -> mức tương ứng, `quality` đi kèm cho preset CPU.
 *   2. Sidecar dựng ĐÚNG tham số encoder cho từng mức (đọc `export_bench/*.cmd.json`), cả CPU lẫn
 *      NVENC (bỏ qua NVENC nếu máy không có), cả H.264 lẫn H.265, và payload cũ / số sai.
 *   3. Bản xuất NVENC thật: mức chất lượng không vượt trần, "Tùy chỉnh" không vượt đỉnh ×1,5.
 *
 * Chạy: npm run test:export-bitrate-modes
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test_temp', 'export_bitrate_modes');
const SIDECAR = process.env.CRABBYCUT_SIDECAR || path.join(ROOT, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const SEQ_W = 1920;
const SEQ_H = 1080;
const FPS = 25;
const SECONDS = 2;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function testBackend() {
  const { normalizeExportSettings } = require('../../backend/server');
  const norm = (settings) => normalizeExportSettings({ export_settings: JSON.stringify(settings) });
  const pick = (s) => ({ rate_mode: s.rate_mode, rate_mbps: s.rate_mbps, quality: s.quality });
  const cases = [
    [{ rate_mode: 'lower' }, { rate_mode: 'lower', rate_mbps: undefined, quality: 'balanced' }],
    [{ rate_mode: 'recommended' }, { rate_mode: 'recommended', rate_mbps: undefined, quality: 'high' }],
    [{ rate_mode: 'higher' }, { rate_mode: 'higher', rate_mbps: undefined, quality: 'high' }],
    [{ rate_mode: 'custom', rate_mbps: 12.345 }, { rate_mode: 'custom', rate_mbps: 12.35, quality: 'high' }],
    [{ rate_mode: 'custom', rate_mbps: '20' }, { rate_mode: 'custom', rate_mbps: 20, quality: 'high' }],
    // Số ngoài dải / không phải số -> Khuyến nghị, KHÔNG mang rate_mbps.
    [{ rate_mode: 'custom', rate_mbps: 0.2 }, { rate_mode: 'recommended', rate_mbps: undefined, quality: 'high' }],
    [{ rate_mode: 'custom', rate_mbps: 999 }, { rate_mode: 'recommended', rate_mbps: undefined, quality: 'high' }],
    [{ rate_mode: 'custom', rate_mbps: 'abc' }, { rate_mode: 'recommended', rate_mbps: undefined, quality: 'high' }],
    // Mức lạ -> theo `quality` (mặc định Cao -> Khuyến nghị).
    [{ rate_mode: 'max' }, { rate_mode: 'recommended', rate_mbps: undefined, quality: 'high' }],
    // Payload cũ chỉ có `quality`.
    [{ quality: 'high' }, { rate_mode: 'recommended', rate_mbps: undefined, quality: 'high' }],
    [{ quality: 'balanced' }, { rate_mode: 'lower', rate_mbps: undefined, quality: 'balanced' }],
    [{ quality: 'small' }, { rate_mode: 'lower', rate_mbps: undefined, quality: 'small' }],
    [{}, { rate_mode: 'recommended', rate_mbps: undefined, quality: 'high' }],
  ];
  for (const [input, want] of cases) {
    assert.deepStrictEqual(pick(norm(input)), want, `normalizeExportSettings(${JSON.stringify(input)})`);
  }
  console.log(`  ok  backend: ${cases.length} ca mức / số Mbps / lùi về Khuyến nghị / payload cũ`);
}

function nvencAvailable() {
  const r = run('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.2',
    '-c:v', 'h264_nvenc', '-f', 'null', '-']);
  return r.status === 0;
}

function writeTimeline(file, settings) {
  fs.writeFileSync(file, JSON.stringify({
    version: 5,
    sequence: { width: SEQ_W, height: SEQ_H, fps: String(FPS) },
    intervals: [{ index: 0, script_index: 0, text: 'c0', start: 0, end: SECONDS, scale: 100, position_x: 0, position_y: 0 }],
    editingTracks: [], editingItems: [], assets: [], main_audio_volume: 100, overlays: [],
    settings: {
      resolution: 'sequence', width: SEQ_W, height: SEQ_H, fps: String(FPS), render_fps: String(FPS),
      codec: 'h264', audio_bitrate: '128k', ...settings,
    },
  }), 'utf8');
}

/* Một lượt xuất; trả về tham số encoder (từ `-c:v` tới trước `-c:a`) và đường dẫn bản xuất. */
function exportOnce(tag, source, settings, hw) {
  const timeline = path.join(TEST_DIR, `${tag}.json`);
  writeTimeline(timeline, settings);
  const output = path.join(TEST_DIR, `${tag}.${settings.codec === 'prores' ? 'mov' : 'mp4'}`);
  const benchDir = path.join(TEST_DIR, 'export_bench');
  fs.rmSync(benchDir, { recursive: true, force: true });
  const r = run(SIDECAR, ['export-video', source, output, timeline, TEST_DIR, 'sequence', String(FPS)], {
    timeout: 300000,
    env: { ...process.env, FFMPEG_EXPORT_HW: hw ? '1' : '0', CRABBYCUT_EXPORT_BENCH: '1' },
  });
  assert.strictEqual(r.status, 0, `xuất thất bại (${tag}):\n${r.stdout}\n${r.stderr}`);
  const cmdFile = fs.readdirSync(benchDir).find((n) => /\.cmd\.json$/.test(n) && !/^audio/.test(n));
  assert.ok(cmdFile, `${tag}: không thấy *.cmd.json`);
  const { args } = JSON.parse(fs.readFileSync(path.join(benchDir, cmdFile), 'utf8'));
  const from = args.indexOf('-c:v');
  const to = args.indexOf('-c:a', from);
  assert.ok(from > 0 && to > from, `${tag}: không tìm thấy tham số encoder trong ${cmdFile}`);
  return { enc: args.slice(from, to), output };
}

function videoKbps(file) {
  const r = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=bit_rate',
    '-of', 'json', file]);
  const j = JSON.parse(r.stdout);
  return Number(j.streams[0].bit_rate) / 1000;
}

function testSidecar() {
  if (!fs.existsSync(SIDECAR) || run('ffmpeg', ['-version']).status !== 0) {
    console.log('  (bỏ qua phần sidecar: chưa build sidecar hoặc thiếu ffmpeg)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const source = path.join(TEST_DIR, 'temp_input.mp4');
  const s = run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${SEQ_W}x${SEQ_H}:rate=${FPS}:duration=${SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-shortest', source]);
  assert.strictEqual(s.status, 0, `dựng nguồn:\n${s.stderr}`);

  // CPU: CRF theo mức (không trần — đúng hành vi CPU cũ), "Tùy chỉnh" = ABR + đỉnh ×1,5.
  const cpuCases = [
    ['cpu_lower', { rate_mode: 'lower' }, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']],
    ['cpu_recommended', { rate_mode: 'recommended' }, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']],
    ['cpu_higher', { rate_mode: 'higher' }, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16']],
    ['cpu_custom', { rate_mode: 'custom', rate_mbps: 12.5 }, ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '12500k', '-maxrate', '18750k', '-bufsize', '37500k']],
    ['cpu_hevc', { rate_mode: 'recommended', codec: 'hevc' }, ['-c:v', 'libx265', '-preset', 'veryfast', '-crf', '18', '-tag:v', 'hvc1']],
    // Payload cũ (chỉ `quality`) và số Mbps sai (sidecar tự lùi, kể cả khi backend bị vượt qua).
    ['cpu_legacy_balanced', { quality: 'balanced' }, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']],
    ['cpu_legacy_small', { quality: 'small' }, ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']],
    ['cpu_bad_custom', { rate_mode: 'custom', rate_mbps: 1000 }, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']],
  ];
  for (const [tag, settings, want] of cpuCases) {
    const { enc } = exportOnce(tag, source, { codec: 'h264', ...settings }, false);
    assert.deepStrictEqual(enc, want, `${tag}: tham số encoder`);
  }
  console.log(`  ok  CPU: ${cpuCases.length} ca tham số encoder (CRF theo mức, Tùy chỉnh ABR, payload cũ, số sai)`);

  if (!nvencAvailable()) {
    console.log('  (bỏ qua phần NVENC: máy không có h264_nvenc dùng được)');
    return;
  }
  // 1920×1080 -> trần = đúng bitrate cố định cũ của mức (H.264 8.500 / 13.000 / 26.000 kbps; H.265 11.000).
  const nv = (cq, cap) => ['-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-maxrate', `${cap}k`, '-bufsize', `${cap * 2}k`];
  const nvCases = [
    ['nv_lower', { rate_mode: 'lower' }, ['-c:v', 'h264_nvenc', '-preset', 'fast', ...nv(23, 8500)]],
    ['nv_recommended', { rate_mode: 'recommended' }, ['-c:v', 'h264_nvenc', '-preset', 'fast', ...nv(19, 13000)]],
    ['nv_higher', { rate_mode: 'higher' }, ['-c:v', 'h264_nvenc', '-preset', 'fast', ...nv(16, 26000)]],
    ['nv_custom', { rate_mode: 'custom', rate_mbps: 4 }, ['-c:v', 'h264_nvenc', '-preset', 'fast', '-rc', 'vbr', '-b:v', '4000k', '-maxrate', '6000k', '-bufsize', '12000k']],
    ['nv_hevc', { rate_mode: 'recommended', codec: 'hevc' }, ['-c:v', 'hevc_nvenc', '-preset', 'fast', ...nv(19, 11000), '-tag:v', 'hvc1']],
    ['nv_legacy_high', { quality: 'high' }, ['-c:v', 'h264_nvenc', '-preset', 'fast', ...nv(19, 13000)]],
  ];
  const outputs = {};
  for (const [tag, settings, want] of nvCases) {
    const { enc, output } = exportOnce(tag, source, { codec: 'h264', ...settings }, true);
    assert.deepStrictEqual(enc, want, `${tag}: tham số encoder`);
    outputs[tag] = output;
  }
  console.log(`  ok  NVENC: ${nvCases.length} ca tham số encoder (-cq 23/19/16 + trần, Tùy chỉnh, H.265, payload cũ)`);

  // Bản xuất thật: mức chất lượng không vượt trần; Tùy chỉnh không vượt đỉnh ×1,5 (dư 10% cho vỏ mp4).
  const rec = videoKbps(outputs.nv_recommended);
  const low = videoKbps(outputs.nv_lower);
  const custom = videoKbps(outputs.nv_custom);
  assert.ok(rec <= 13000 * 1.1, `Khuyến nghị ra ${rec.toFixed(0)} kbps, vượt trần 13.000`);
  assert.ok(low < rec, `Thấp hơn (${low.toFixed(0)} kbps) phải nhỏ hơn Khuyến nghị (${rec.toFixed(0)} kbps)`);
  assert.ok(custom <= 6000 * 1.1, `Tùy chỉnh 4 Mbps ra ${custom.toFixed(0)} kbps, vượt đỉnh 6.000`);
  console.log(`  ok  NVENC bản xuất thật: Thấp hơn ${low.toFixed(0)} < Khuyến nghị ${rec.toFixed(0)} ≤ 13.000 kbps; Tùy chỉnh 4 Mbps ra ${custom.toFixed(0)} kbps`);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

testBackend();
testSidecar();
console.log('export bitrate modes ok');
