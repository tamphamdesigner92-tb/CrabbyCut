/**
 * Mức âm lượng khi TRỘN nhiều luồng tiếng lúc xuất.
 * Chạy: npm run test:audio-mix
 *
 * BẤT BIẾN được canh: thêm block audio overlay (Auto Sound Effects điền SFXs + nhạc nền)
 * KHÔNG được làm nhỏ lời thoại ở lane chính. Preview cộng thẳng các GainNode ở âm lượng đã
 * đặt, nên bản xuất phải làm y hệt.
 *
 * Lỗi test này sinh ra để chặn (đã sửa 2026-08-15): `amix` mặc định `normalize=1` — nó CHIA
 * MỌI ĐẦU VÀO cho số luồng. Chạy Auto Sound Effects xong là bản xuất nhỏ hẳn so với preview
 * (7 luồng -> −20·log10(7) ≈ −17 dB trên mọi thứ, kể cả giọng nói). Lỗi thuộc loại "im lặng":
 * bản xuất vẫn chạy, vẫn có tiếng, chỉ là nhỏ đi — không có gì báo lỗi cả.
 *
 * Cách đo: lane chính phát sine 440 Hz, các block overlay phát 3000 Hz. Lọc dải quanh 440 Hz
 * rồi đo RMS => tách được PHẦN ĐÓNG GÓP CỦA LANE CHÍNH ra khỏi bản trộn.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build', 'core_process');
const SEQ_W = 160;
const SEQ_H = 90;
const FPS = 24;
const DUR = 2;
const MAIN_HZ = 440;
const OVERLAY_HZ = 3000;
const OVERLAY_COUNT = 6;          // 5 SFX + 1 nhạc nền — đúng quy mô một lượt ASE thật

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `${label} lỗi:\n${r.stderr || r.stdout}`);
  return r;
}

// RMS (dB) của tín hiệu sau khi lọc quanh `centerHz`. Không lọc thì đo cả bản trộn.
function rmsDb(file, centerHz) {
  const filters = [];
  if (centerHz) filters.push(`bandpass=f=${centerHz}:width_type=h:w=${Math.round(centerHz / 6)}`);
  filters.push('astats=measure_perchannel=none');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', filters.join(','), '-f', 'null', '-'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const line = (r.stderr || '').split('\n').find((l) => l.includes('RMS level dB'));
  assert.ok(line, `không đọc được RMS của ${file}:\n${r.stderr}`);
  return Number(line.split(':').pop().trim());
}

function buildInputs(workDir) {
  const main = path.join(workDir, 'main.mp4');
  const sfx = path.join(workDir, 'sfx.wav');
  run('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=${SEQ_W}x${SEQ_H}:d=${DUR}:r=${FPS}`,
    '-f', 'lavfi', '-i', `sine=frequency=${MAIN_HZ}:duration=${DUR}`,
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', main], 'dựng nguồn lane chính');
  run('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${OVERLAY_HZ}:duration=${DUR}`, sfx], 'dựng file SFX');
  return { main, sfx };
}

function exportWith(workDir, inputs, overlays, tag) {
  const payloadPath = path.join(workDir, `payload_${tag}.json`);
  const out = path.join(workDir, `out_${tag}.mp4`);
  fs.writeFileSync(payloadPath, JSON.stringify({
    version: 5,
    sequence: { width: SEQ_W, height: SEQ_H, preset: 'custom', source_width: SEQ_W, source_height: SEQ_H, source_fps: String(FPS) },
    intervals: [{ index: 0, start: 0, end: DUR, audio_volume: 100 }],
    overlays,
    settings: {
      resolution: 'sequence', width: SEQ_W, height: SEQ_H,
      fps: String(FPS), render_fps: String(FPS),
      codec: 'h264', quality: 'high', audio_bitrate: '192k',
    },
  }));
  const tmp = path.join(workDir, `tmp_${tag}`);
  fs.mkdirSync(tmp, { recursive: true });
  run(SIDECAR, ['export-video', inputs.main, out, payloadPath, tmp, 'sequence', String(FPS)], `export ${tag}`);
  return out;
}

// Block audio overlay đúng khuôn Auto Sound Effects sinh ra.
function audioOverlay(inputs, index, volume) {
  return {
    index,
    id: `sfx_${index}`,
    type: 'audio',
    asset_type: 'audio',
    asset_path: inputs.sfx,
    timeline_start: 0,
    duration: DUR,
    source_start: 0,
    muted: false,
    has_audio: true,
    volume,
  };
}

function main() {
  assert.ok(fs.existsSync(SIDECAR), `chưa build sidecar: ${SIDECAR} (npm run build:sidecar)`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab_audio_mix_'));
  try {
    const inputs = buildInputs(workDir);

    const solo = exportWith(workDir, inputs, [], 'solo');
    // −6 dB cho SFX, −13 dB cho nhạc nền — đúng mặc định của Auto Sound Effects.
    const overlays = Array.from({ length: OVERLAY_COUNT }, (_, i) => audioOverlay(
      inputs, i, i === OVERLAY_COUNT - 1 ? 100 * Math.pow(10, -13 / 20) : 100 * Math.pow(10, -6 / 20),
    ));
    const mixed = exportWith(workDir, inputs, overlays, 'mixed');

    const mainSolo = rmsDb(solo, MAIN_HZ);
    const mainMixed = rmsDb(mixed, MAIN_HZ);
    const drop = mainSolo - mainMixed;
    console.log(`  lane chính một mình: ${mainSolo.toFixed(2)} dB`);
    console.log(`  lane chính trong bản trộn ${OVERLAY_COUNT + 1} luồng: ${mainMixed.toFixed(2)} dB (lệch ${drop.toFixed(2)} dB)`);

    // Ngưỡng 1 dB: đủ chặt để bắt cú chia cho 7 (≈17 dB) và cả cú chia cho 2, nhưng vẫn
    // rộng hơn sai số của encode AAC + bộ lọc dải.
    assert.ok(Math.abs(drop) < 1.0,
      `thêm ${OVERLAY_COUNT} block audio làm lane chính lệch ${drop.toFixed(2)} dB — `
      + 'phải giữ nguyên (amix cần normalize=0; preview cộng thẳng, không chia cho số luồng)');

    // Và bản trộn phải TO HƠN bản không có SFX: thêm tiếng là thêm năng lượng.
    const allSolo = rmsDb(solo, 0);
    const allMixed = rmsDb(mixed, 0);
    console.log(`  tổng bản xuất: ${allSolo.toFixed(2)} dB -> ${allMixed.toFixed(2)} dB`);
    assert.ok(allMixed > allSolo,
      `thêm SFX mà tổng lại nhỏ đi (${allSolo.toFixed(2)} -> ${allMixed.toFixed(2)} dB)`);

    console.log('[audio-mix] OK — thêm block audio KHÔNG làm nhỏ lane chính (amix normalize=0).');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
