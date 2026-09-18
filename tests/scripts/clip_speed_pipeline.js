/* Test tính năng TỐC ĐỘ (Speed) — bảo vệ hai thứ dễ vỡ nhất của nó.
 *
 * ĐIỀU ĐANG ĐƯỢC BẢO VỆ:
 *
 *   1. KHÔNG MÉO TIẾNG. Đây là toàn bộ lý do tính năng này khó. Test phát một SIN
 *      440 Hz rồi xuất ở 2x: bật "giữ cao độ" thì bản xuất phải VẪN là 440 Hz (FFmpeg
 *      `atempo`/WSOLA), tắt đi thì phải thành 880 Hz (`asetrate`). Đo bằng DFT tại
 *      đúng hai tần số đó chứ không tin vào việc "lệnh có chạy".
 *
 *   2. HAI TRỤC THỜI GIAN KHÔNG ĐƯỢC LẪN. clip.start/end là giờ NGUỒN, vị trí block là
 *      giờ SEQUENCE, và quan hệ là chia/nhân `rate`. Sai chỗ nào thì bản xuất dài sai
 *      hoặc block sau lệch chỗ, nên test đòi ĐÚNG tổng thời lượng và đòi đúng màu tại
 *      những mốc đã tính trước.
 *
 *   3. CHUỖI `atempo` NHIỀU TẦNG. FFmpeg chỉ nhận 0.5..2.0 mỗi tầng; test kiểm tích của
 *      chuỗi bằng đúng tốc độ và mọi tầng nằm trong dải cho phép.
 *
 * Cần `ffmpeg` trong PATH; không có thì phần cần FFmpeg tự bỏ qua.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8131';
/* THƯ MỤC TẠM RIÊNG CHO TEST — BẮT BUỘC, và phải đặt TRƯỚC khi require server.
 * Xem ghi chú cùng nội dung ở export_smoke.js: trỏ vào thư mục tạm mặc định là xoá
 * sạch dữ liệu của dự án người dùng đang mở. */
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR
  || path.join(PROJECT_ROOT, 'test_temp', 'clip_speed');
const TEMP_DIR = path.resolve(process.env.CRAB_TEMP_DIR);

const ClipSpeed = require(path.join(PROJECT_ROOT, 'static', 'js', 'clip-speed.js'));

const SR = 48000;
const MAIN_TONE = 440;      // sin trong video nguồn
const OVERLAY_TONE = 1000;  // sin trong file audio overlay

function ffmpegAvailable() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, `${command} lỗi\n${result.stderr || result.stdout}`);
  return result;
}

function decodeAudio(filePath) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', filePath, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], {
    encoding: 'buffer',
    maxBuffer: 400 * 1024 * 1024,
  });
  assert.strictEqual(result.status, 0, result.stderr?.toString('utf8'));
  const out = new Float32Array(result.stdout.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = result.stdout.readFloatLE(i * 4);
  return out;
}

// Biên độ tại MỘT tần số (Goertzel). Đủ cho việc phân biệt 440 vs 880 và rẻ hơn FFT.
function toneMagnitude(samples, from, to, freq) {
  const n = Math.max(1, to - from);
  const w = (2 * Math.PI * freq) / SR;
  const cosW = Math.cos(w);
  const coeff = 2 * cosW;
  let s1 = 0; let s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
}

function rms(samples, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

function windowOf(seconds) {
  return Math.round(seconds * SR);
}

function mediaDuration(filePath) {
  const result = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath]);
  return Number(JSON.parse(result.stdout).format.duration);
}

function sampleRgb(filePath, seconds) {
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-ss', String(seconds), '-i', filePath,
    '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { cwd: PROJECT_ROOT, encoding: 'buffer', maxBuffer: 1024 * 1024 });
  assert.strictEqual(result.status, 0, result.stderr?.toString('utf8'));
  return [...result.stdout.slice(0, 3)];
}

// ===================== 1. HỢP ĐỒNG CỦA MODULE =====================
function testModuleContract() {
  assert.deepStrictEqual(ClipSpeed.normalize(undefined), { rate: 1, pitch_correct: true, mode: 'normal' });
  assert.strictEqual(ClipSpeed.isActive(undefined), false);
  assert.strictEqual(ClipSpeed.isActive({ rate: 1.5 }), true);

  // Giá trị rác không được làm vỡ mô hình (rate = 0 là chia cho 0 ở khắp nơi).
  assert.strictEqual(ClipSpeed.normalize({ rate: 0 }).rate, ClipSpeed.RATE_MIN);
  assert.strictEqual(ClipSpeed.normalize({ rate: -3 }).rate, ClipSpeed.RATE_MIN);
  assert.strictEqual(ClipSpeed.normalize({ rate: 1e9 }).rate, ClipSpeed.RATE_MAX);
  assert.strictEqual(ClipSpeed.normalize({ rate: 'abc' }).rate, 1);
  assert.strictEqual(ClipSpeed.normalize({ pitch_correct: false }).pitch_correct, false);
  assert.strictEqual(ClipSpeed.normalize({ mode: 'curve' }).mode, 'curve');
  assert.strictEqual(ClipSpeed.normalize({ mode: 'linh tinh' }).mode, 'normal');

  // Hai trục thời gian phải đi ngược nhau và khép kín.
  assert.ok(Math.abs(ClipSpeed.sequenceDuration(4, 2) - 2) < 1e-9);
  assert.ok(Math.abs(ClipSpeed.sourceDuration(2, 2) - 4) < 1e-9);
  for (const rate of [0.1, 0.5, 1, 1.5, 2, 7.3, 100]) {
    const back = ClipSpeed.sourceDuration(ClipSpeed.sequenceDuration(12, rate), rate);
    assert.ok(Math.abs(back - 12) < 1e-6, `quy đổi thời gian không khép kín ở ${rate}x`);
  }
  assert.ok(Math.abs(ClipSpeed.clipSequenceDuration({ start: 2, end: 10, speed: { rate: 4 } }) - 2) < 1e-9);
  assert.ok(Math.abs(ClipSpeed.itemSourceDuration({ duration: 3, speed: { rate: 0.5 } }) - 1.5) < 1e-9);

  // Chuỗi atempo: tích đúng bằng tốc độ, và MỌI tầng nằm trong dải FFmpeg nhận.
  for (const rate of [0.1, 0.25, 0.5, 0.75, 1.5, 2, 3, 4, 16, 100]) {
    const chain = ClipSpeed.atempoChain(rate);
    assert.ok(chain.length >= 1, `${rate}x không sinh được chuỗi atempo`);
    let product = 1;
    for (const part of chain) {
      const value = Number(/^atempo=([\d.]+)$/.exec(part)[1]);
      assert.ok(value >= ClipSpeed.ATEMPO_MIN - 1e-9 && value <= ClipSpeed.ATEMPO_MAX + 1e-9,
        `tầng ${part} nằm ngoài dải atempo cho phép`);
      product *= value;
    }
    assert.ok(Math.abs(product - rate) / rate < 1e-3, `chuỗi atempo của ${rate}x cho tích ${product}`);
  }
  assert.deepStrictEqual(ClipSpeed.atempoChain(1), [], '1.0x không được sinh filter nào');

  /* GIỜ NGUỒN CỦA KHUNG BAKE — chỗ đã từng sai và gây ra đúng hai triệu chứng người dùng
   * báo: "tiếng thì speed mà hình thì không" (đường bake cả khung) và "lệch khung vùng vá
   * Retouch" (đường vá). Khâu bake đi theo thời gian TIMELINE của khung, phải nhân `rate`
   * mới ra giờ nguồn để seek. */
  assert.strictEqual(ClipSpeed.sourceTimeAt(0, 1, 1, 10), 1, '1x phải giữ nguyên mốc');
  assert.strictEqual(ClipSpeed.sourceTimeAt(0, 1, 2, 10), 2, '2x: 1 giây timeline = 2 giây nguồn');
  assert.strictEqual(ClipSpeed.sourceTimeAt(0, 1, 0.5, 10), 0.5, '0.5x: 1 giây timeline = 0.5 giây nguồn');
  assert.strictEqual(ClipSpeed.sourceTimeAt(4.5, 2, 2, 10), 8.5, 'phải cộng từ mốc vào của block');
  // Kẹp theo độ dài NGUỒN, không theo độ dài timeline: kẹp nhầm là khung cuối đứng hình
  // sớm (2x thì đứng ngay từ nửa block).
  assert.strictEqual(ClipSpeed.sourceTimeAt(0, 9, 2, 10), 10, 'phải kẹp đúng ở cuối đoạn nguồn');
  assert.strictEqual(ClipSpeed.sourceTimeAt(0, 100, 3, 6), 6);
  // Toàn block: khung cuối của chuỗi bake phải chạm gần cuối đoạn NGUỒN, không phải cuối
  // đoạn timeline — đây chính là phép thử phân biệt bản đúng với bản sai.
  const rate = 2, srcSpan = 8, fps = 30;
  const seqDur = ClipSpeed.sequenceDuration(srcSpan, rate);         // 4 s trên timeline
  const lastLocal = (Math.round(seqDur * fps) - 1) / fps;
  const lastSrc = ClipSpeed.sourceTimeAt(0, lastLocal, rate, srcSpan);
  assert.ok(lastSrc > srcSpan - 0.1,
    `khung cuối của chuỗi bake dừng ở ${lastSrc.toFixed(3)}s trong khi đoạn nguồn dài ${srcSpan}s`);
  console.log('  [1] hợp đồng module: ok');
}

// ===================== 2. XUẤT THẬT: THỜI LƯỢNG + CAO ĐỘ =====================
async function testExportPipeline() {
  if (!ffmpegAvailable()) {
    console.log('  [!] không có ffmpeg -> bỏ qua phần xuất thật');
    return;
  }
  const { start } = require(path.join(PROJECT_ROOT, 'backend', 'server.js'));
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  /* NGUỒN: 8 giây, hình đổi màu ở giây 4 (đỏ -> xanh dương), tiếng là SIN 440 Hz suốt
   * cả file. Màu để kiểm trục thời gian, sin để kiểm cao độ. */
  const sourcePath = path.join(TEMP_DIR, 'temp_input.mp4');
  run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=4:r=30',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=4:r=30',
    '-f', 'lavfi', '-i', `sine=frequency=${MAIN_TONE}:duration=8:sample_rate=48000`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-shortest', '-pix_fmt', 'yuv420p', sourcePath,
  ]);

  const overlayPath = path.join(TEMP_DIR, 'overlay_tone.wav');
  run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${OVERLAY_TONE}:duration=4:sample_rate=48000`,
    '-c:a', 'pcm_s16le', overlayPath,
  ]);

  const reportsDir = path.join(PROJECT_ROOT, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportsBefore = new Set(fs.readdirSync(reportsDir));

  const server = start();
  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    const sequence = { width: 160, height: 90, preset: 'custom', source_width: 160, source_height: 90, source_fps: '30' };

    /* BỐ TRÍ ĐÃ TÍNH TRƯỚC:
     *   block 1: nguồn 0-4 s ở 2.0x  -> chiếm 0-2 s trên timeline (ĐỎ)
     *   block 2: nguồn 4-8 s ở 1.0x  -> chiếm 2-6 s trên timeline (XANH), tắt tiếng
     *   overlay: file 4 s ở 2.0x     -> chiếm 2-4 s trên timeline
     * Tổng = 6 s. Vùng 2-4 s chỉ còn tiếng overlay (main đã volume 0), vùng 4-6 s im.
     * Nhờ tắt tiếng main ở block 2 mà đo được overlay riêng, không lẫn tiếng nền. */
    const buildForm = (pitchCorrect) => {
      const form = new FormData();
      form.append('timeline_json', JSON.stringify([
        { start: 0, end: 4, text: 'nhanh', script_index: 0, speed: { rate: 2, pitch_correct: pitchCorrect } },
        { start: 4, end: 8, text: 'thuong', script_index: 1, audio_volume: 0 },
      ]));
      form.append('editing_json', JSON.stringify({
        tracks: [
          { id: 'track_main', type: 'main', order: 0 },
          { id: 'track_audio_1', type: 'audio', order: 1 },
        ],
        items: [{
          id: 'item_audio_1',
          type: 'audio',
          track_id: 'track_audio_1',
          asset_id: 'asset_audio_1',
          timeline_start: 2,
          duration: 2,
          source_start: 0,
          volume: 100,
          speed: { rate: 2, pitch_correct: pitchCorrect },
        }],
        assets: [{
          id: 'asset_audio_1', type: 'audio', name: 'overlay_tone.wav',
          path: overlayPath, has_audio: true, duration: 4,
        }],
      }));
      form.append('export_settings', JSON.stringify({
        resolution: 'sequence', sequence, fps: '30', codec: 'h264', quality: 'high', audio_bitrate: '320k',
      }));
      form.append('sequence_settings', JSON.stringify(sequence));
      return form;
    };

    const runExport = async (pitchCorrect) => {
      const response = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: buildForm(pitchCorrect) });
      if (!response.ok) throw new Error(`export lỗi: ${await response.text()}`);
      await response.arrayBuffer();
      const outputPath = path.join(TEMP_DIR, 'final_cut.mp4');
      assert.ok(fs.existsSync(outputPath));
      const kept = path.join(TEMP_DIR, `speed_${pitchCorrect ? 'pitch' : 'nopitch'}.mp4`);
      fs.copyFileSync(outputPath, kept);
      return {
        file: kept,
        audio: decodeAudio(kept),
        payload: JSON.parse(fs.readFileSync(path.join(TEMP_DIR, 'export_timeline.json'), 'utf8')),
      };
    };

    const kept = await runExport(true);

    // 2a. Backend chuyển đúng tham số xuống sidecar.
    assert.strictEqual(kept.payload.intervals[0].speed_rate, 2);
    assert.strictEqual(kept.payload.intervals[0].speed_pitch_correct, true);
    assert.strictEqual(kept.payload.intervals[1].speed_rate, 1);
    const overlayPayload = (kept.payload.overlays || []).find((o) => o.type === 'audio');
    assert.ok(overlayPayload, 'audio overlay không tới được payload export');
    assert.strictEqual(overlayPayload.speed_rate, 2);

    // 2b. TRỤC THỜI GIAN: 4 s nguồn ở 2x + 4 s ở 1x = 6 s, không phải 8 s.
    const duration = mediaDuration(kept.file);
    assert.ok(Math.abs(duration - 6) < 0.25, `thời lượng xuất ra ${duration.toFixed(3)}s, chờ ~6s`);

    // 2c. Hình đúng chỗ: 0-2 s là block đã tăng tốc (ĐỎ), 2-6 s là block thường (XANH).
    const red = sampleRgb(kept.file, 1);
    const blue = sampleRgb(kept.file, 4);
    assert.ok(red[0] > red[2] + 40, `giây 1 phải là ĐỎ, đo được ${red}`);
    assert.ok(blue[2] > blue[0] + 40, `giây 4 phải là XANH, đo được ${blue}`);

    // 2d. GIỮ CAO ĐỘ: block chạy 2x nhưng sin vẫn phải là 440 Hz, không phải 880 Hz.
    const a = windowOf(0.4); const b = windowOf(1.6);
    const at440 = toneMagnitude(kept.audio, a, b, MAIN_TONE);
    const at880 = toneMagnitude(kept.audio, a, b, MAIN_TONE * 2);
    assert.ok(at440 > at880 * 4,
      `2x + giữ cao độ phải còn ${MAIN_TONE} Hz (đo 440=${at440.toFixed(5)}, 880=${at880.toFixed(5)})`);

    // 2e. OVERLAY chạy 2x: 4 s nguồn nén vào 2-4 s, vẫn đúng cao độ 1000 Hz; và phải
    // DỪNG ở giây 4 — nếu atrim lấy sai độ dài nguồn thì tiếng tràn sang 4-6 s.
    // Đo bằng TỈ LỆ, không bằng ngưỡng tuyệt đối: `amix` chia biên độ theo số nhánh
    // nên mức tuyệt đối phụ thuộc bố trí test, còn tỉ lệ thì không.
    const overlayRms = rms(kept.audio, windowOf(2.4), windowOf(3.6));
    const overlayOff = rms(kept.audio, windowOf(4.4), windowOf(5.6));
    const overlayAt1k = toneMagnitude(kept.audio, windowOf(2.4), windowOf(3.6), OVERLAY_TONE);
    const overlayAt2k = toneMagnitude(kept.audio, windowOf(2.4), windowOf(3.6), OVERLAY_TONE * 2);
    assert.ok(overlayRms > overlayOff * 5,
      `overlay 2x không kêu đúng khoảng của nó (2-4s rms=${overlayRms.toFixed(5)}, 4-6s rms=${overlayOff.toFixed(5)})`);
    assert.ok(overlayAt1k > overlayAt2k * 4,
      `overlay 2x bị đổi cao độ (${OVERLAY_TONE}=${overlayAt1k.toFixed(5)}, ${OVERLAY_TONE * 2}=${overlayAt2k.toFixed(5)})`);

    // 2f. TẮT giữ cao độ -> đúng hiệu ứng "máy nhựa": 440 Hz phải nhảy lên 880 Hz.
    const shifted = await runExport(false);
    const shiftedA = windowOf(0.4); const shiftedB = windowOf(1.6);
    const s440 = toneMagnitude(shifted.audio, shiftedA, shiftedB, MAIN_TONE);
    const s880 = toneMagnitude(shifted.audio, shiftedA, shiftedB, MAIN_TONE * 2);
    assert.ok(s880 > s440 * 4,
      `2x + tắt giữ cao độ phải thành ${MAIN_TONE * 2} Hz (đo 440=${s440.toFixed(5)}, 880=${s880.toFixed(5)})`);
    // Và thời lượng KHÔNG được đổi theo: hai chế độ chỉ khác nhau ở cao độ.
    const shiftedDuration = mediaDuration(shifted.file);
    assert.ok(Math.abs(shiftedDuration - duration) < 0.25,
      `tắt giữ cao độ làm đổi thời lượng (${shiftedDuration.toFixed(3)} vs ${duration.toFixed(3)})`);

    console.log(`  [2] xuất thật: ${duration.toFixed(2)}s (chờ 6s)`
      + ` | giữ cao độ 440/880 = ${at440.toFixed(4)}/${at880.toFixed(4)}`
      + ` | tắt giữ cao độ 440/880 = ${s440.toFixed(4)}/${s880.toFixed(4)}`);
    console.log(`  [2] overlay 2x: rms trong block ${overlayRms.toFixed(4)} vs ngoài ${overlayOff.toFixed(4)}`
      + ` | ${OVERLAY_TONE}/${OVERLAY_TONE * 2} Hz = ${overlayAt1k.toFixed(4)}/${overlayAt2k.toFixed(4)}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const name of fs.readdirSync(reportsDir)) {
      if (!reportsBefore.has(name) && /^report_project_\d{8}_\d{6}\.txt$/.test(name)) {
        fs.rmSync(path.join(reportsDir, name), { force: true });
      }
    }
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
}

async function main() {
  testModuleContract();
  await testExportPipeline();
  console.log('clip speed pipeline ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
