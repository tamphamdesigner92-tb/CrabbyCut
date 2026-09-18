/* Test tính năng KHỬ TIẾNG ỒN — bảo vệ hợp đồng WYSIWYG giữa PREVIEW và EXPORT.
 *
 * ĐIỀU ĐANG ĐƯỢC BẢO VỆ, theo đúng thứ tự quan trọng:
 *
 *   1. HAI ĐƯỜNG CÙNG MỘT MỨC. Bộ lọc chạy trong preview (AudioWorklet trừ phổ ở
 *      static/js/denoise-worklet.js) và chuỗi filter chạy khi xuất (FFmpeg afftdn, do
 *      static/js/audio-denoise.js sinh) là HAI thuật toán khác nhau. Cái phải khớp là
 *      MỨC: nền ồn ở khoảng nghỉ giảm gần đúng `nr` dB ở CẢ HAI, và đoạn có tiếng thì
 *      gần như không suy hao. Ai sửa bảng quy đổi mà chỉ ngó một bên -> test đổ.
 *
 *   2. ĐỘC LẬP VỚI MỨC ỒN CỦA NGUỒN. Đây là lý do afftdn ở đây dùng `nf` CỐ ĐỊNH chứ
 *      không bật `tn=1` (xem ghi chú trong audio-denoise.js: bật tn thì FFmpeg 8.1 gần
 *      như không khử gì). Test chạy lại trên nguồn ồn nhỏ hơn 24 dB và đòi kết quả
 *      không đổi — nếu ai đó đổi sang nf động/tự đo, con số sẽ trôi và test bắt được.
 *
 *   3. DÂY NỐI TỚI SIDECAR. Xuất thật qua backend rồi ĐỌC filter script mà sidecar
 *      ghi ra, đòi chuỗi khử ồn nằm đúng chỗ: sau `atrim`, TRƯỚC `volume`, ở cả nhánh
 *      lane chính lẫn nhánh audio overlay.
 *
 * Cần `ffmpeg` trong PATH. Không có thì các mục cần FFmpeg tự bỏ qua (phần thuật toán
 * thuần vẫn chạy).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8129';
/* THƯ MỤC TẠM RIÊNG CHO TEST — BẮT BUỘC, và phải đặt TRƯỚC khi require server.
 * Trỏ vào thư mục tạm mặc định là nghiền nát dữ liệu của dự án người dùng đang mở
 * (temp_input.mp4, file nguồn đã nhập, cache). Xem ghi chú cùng nội dung ở export_smoke.js. */
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR
  || path.join(PROJECT_ROOT, 'test_temp', 'audio_denoise');
const TEMP_DIR = path.resolve(process.env.CRAB_TEMP_DIR);

const AudioDenoise = require(path.join(PROJECT_ROOT, 'static', 'js', 'audio-denoise.js'));

const SR = 48000;

function ffmpegAvailable() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

/* ---------------------------------------------------------------------------
 * TÍN HIỆU THỬ: dạng LỜI NÓI, không phải sine liên tục.
 *
 * Sine liên tục là phép thử SAI cho mọi bộ khử nhiễu: nó đứng yên theo thời gian nên
 * đúng theo định nghĩa là "nhiễu dừng", và bộ lọc nào cũng phải cắt nó. Tín hiệu ở đây
 * là các đợt đa hài 0.4s xen kẽ 0.4s im lặng — đủ để phân biệt "khử nền ồn" với "bóp
 * chết mọi thứ", vì có cả khoảng NGHỈ (chỉ còn ồn) lẫn đoạn CÓ TIẾNG.
 * ------------------------------------------------------------------------- */
const BURST_SEC = 0.4;
const PERIOD = BURST_SEC * 2;
const DURATION = 4;

function buildSignal(noiseAmp, seedInit = 12345) {
  const n = SR * DURATION;
  const out = new Float32Array(n);
  let seed = seedInit;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    if (Math.floor(t / BURST_SEC) % 2 === 0) {
      for (const f of [220, 440, 880, 1600]) v += Math.sin(2 * Math.PI * f * t) / 4;
    }
    out[i] = v * 0.25 + rnd() * noiseAmp;
  }
  return out;
}

function rms(samples, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

const toDb = (ratio) => 20 * Math.log10(ratio);

/* So sánh vào/ra trên hai loại khoảng, BỎ 1 giây đầu vì mọi bộ ước lượng nhiễu đều
 * cần thời gian hội tụ — đo cả đoạn khởi động là đo cái chưa chạy. */
function measure(before, after) {
  let gapIn = 0; let gapOut = 0; let burstIn = 0; let burstOut = 0;
  let count = 0;
  for (let k = 1; k * PERIOD + PERIOD <= DURATION; k++) {
    const base = k * PERIOD;
    const gapFrom = Math.round((base + BURST_SEC + 0.05) * SR);
    const gapTo = Math.round((base + PERIOD - 0.05) * SR);
    const burstFrom = Math.round((base + 0.05) * SR);
    const burstTo = Math.round((base + BURST_SEC - 0.05) * SR);
    gapIn += rms(before, gapFrom, gapTo);
    gapOut += rms(after, gapFrom, gapTo);
    burstIn += rms(before, burstFrom, burstTo);
    burstOut += rms(after, burstFrom, burstTo);
    count++;
  }
  assert.ok(count >= 3, 'tín hiệu thử quá ngắn để đo');
  return { gapDb: toDb(gapOut / gapIn), burstDb: toDb(burstOut / burstIn) };
}

/* --- PREVIEW: chạy chính AudioWorkletProcessor của app trong Node ---
 * File worklet không export gì (chạy trong scope worklet), nên nạp bằng cách dựng sẵn
 * hai global mà nó cần rồi bắt lấy class qua registerProcessor. Nhờ vậy test chạy
 * ĐÚNG mã của preview, không phải một bản chép lại. */
function loadPreviewProcessor() {
  globalThis.AudioWorkletProcessor = class {};
  globalThis.sampleRate = SR;
  let captured = null;
  globalThis.registerProcessor = (_name, ProcessorClass) => { captured = ProcessorClass; };
  require(path.join(PROJECT_ROOT, 'static', 'js', 'denoise-worklet.js'));
  assert.ok(captured, 'denoise-worklet.js không đăng ký processor nào');
  return captured;
}

function runPreview(ProcessorClass, signal, cfg) {
  const processor = new ProcessorClass();
  const params = AudioDenoise.previewParams(cfg);
  const audioParams = {
    floorGain: [params.floorGain],
    overSub: [params.overSub],
    noiseFloor: [params.noiseFloor],
  };
  const QUANTUM = 128; // Web Audio luôn gọi process() theo khối 128 mẫu
  const out = new Float32Array(signal.length);
  for (let offset = 0; offset + QUANTUM <= signal.length; offset += QUANTUM) {
    const block = new Float32Array(QUANTUM);
    processor.process([[signal.subarray(offset, offset + QUANTUM)]], [[block]], audioParams);
    out.set(block, offset);
  }
  return out;
}

/* --- EXPORT: chạy đúng chuỗi filter mà backend sẽ gửi xuống sidecar ---
 * File trung gian dùng PCM 32-bit FLOAT chứ không phải 16-bit: nguồn êm nhất trong test
 * có nền ồn ~-55 dBFS, giảm thêm 40 dB là chạm đúng sàn lượng tử của int16 (~-90 dBFS)
 * -> phép đo sẽ đang đo cái sàn đó chứ không đo bộ lọc. */
function writeWav(samples, filePath) {
  const pcm = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) pcm.writeFloatLE(Math.max(-1, Math.min(1, samples[i])), i * 4);
  const raw = `${filePath}.raw`;
  fs.writeFileSync(raw, pcm);
  const result = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', raw,
    '-c:a', 'pcm_f32le', filePath,
  ]);
  assert.strictEqual(result.status, 0, result.stderr?.toString('utf8'));
  fs.rmSync(raw, { force: true });
}

function decodeWav(filePath) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', filePath, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], {
    encoding: 'buffer',
    maxBuffer: 400 * 1024 * 1024,
  });
  assert.strictEqual(result.status, 0, result.stderr?.toString('utf8'));
  const out = new Float32Array(result.stdout.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = result.stdout.readFloatLE(i * 4);
  return out;
}

function runFfmpegChain(inputWav, outputWav, cfg) {
  const chain = AudioDenoise.ffmpegFilters(cfg).join(',');
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', inputWav, '-af', chain, outputWav], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `chuỗi filter không chạy được: ${chain}\n${result.stderr}`);
  return chain;
}

// ===================== 1. HỢP ĐỒNG CỦA MODULE =====================
function testModuleContract() {
  const def = AudioDenoise.normalize(undefined);
  assert.deepStrictEqual(def, { enabled: false, profile: 'voice', amount: 60 });
  assert.strictEqual(AudioDenoise.isActive(undefined), false);
  assert.deepStrictEqual(AudioDenoise.ffmpegFilters(undefined), []);
  assert.strictEqual(AudioDenoise.exportSpec(undefined), null);
  assert.strictEqual(AudioDenoise.summaryLabel(undefined), '');

  // Giá trị rác không được làm vỡ mô hình.
  assert.deepStrictEqual(
    AudioDenoise.normalize({ enabled: 'yes', profile: 'khong-co', amount: 999 }),
    { enabled: false, profile: 'voice', amount: 100 },
    'enabled chỉ nhận đúng boolean true; profile lạ và amount ngoài dải phải bị kẹp',
  );
  assert.strictEqual(AudioDenoise.normalize({ amount: -5 }).amount, 0);
  assert.strictEqual(AudioDenoise.normalize({ amount: 'abc' }).amount, 60);

  for (const key of AudioDenoise.PROFILE_ORDER) {
    const profile = AudioDenoise.PROFILES[key];
    assert.ok(profile, `thiếu profile ${key}`);
    // Dải nf hợp lệ của afftdn là -80..-20; ra ngoài là FFmpeg từ chối cả chuỗi filter.
    assert.ok(profile.nf >= -80 && profile.nf <= -20, `nf của ${key} ngoài dải afftdn`);
    const low = AudioDenoise.reductionDb({ enabled: true, profile: key, amount: 0 });
    const high = AudioDenoise.reductionDb({ enabled: true, profile: key, amount: 100 });
    assert.ok(low < high, `mức độ phải tăng theo thanh trượt (${key})`);
    // afftdn chỉ nhận nr trong 0.01..97.
    assert.ok(low >= 0.01 && high <= 97, `nr của ${key} ngoài dải afftdn`);
    // Sàn độ lợi của preview PHẢI là chính nr đó quy sang tuyến tính — đây là điểm nối
    // duy nhất giữ cho hai đường cùng một mức giảm tối đa.
    const params = AudioDenoise.previewParams({ enabled: true, profile: key, amount: 100 });
    assert.ok(Math.abs(params.floorGain - Math.pow(10, -high / 20)) < 1e-9, `floorGain của ${key} không khớp nr`);
    assert.strictEqual(params.highpassHz, profile.highpass);
  }

  const spec = AudioDenoise.exportSpec({ enabled: true, profile: 'room', amount: 80 });
  assert.strictEqual(spec.profile, 'room');
  assert.strictEqual(spec.reduction_db, AudioDenoise.reductionDb({ enabled: true, profile: 'room', amount: 80 }));
  assert.strictEqual(spec.filters.length, 2);
  assert.ok(/^highpass=f=\d+$/.test(spec.filters[0]), spec.filters[0]);
  assert.ok(/^afftdn=nr=[\d.]+:nf=-\d+$/.test(spec.filters[1]), spec.filters[1]);
  // `tn=1` từng được dùng và ĐO RA là gần như không khử gì trên FFmpeg 8.1. Chốt lại
  // để không ai vô tình thêm về.
  assert.ok(!spec.filters[1].includes('tn='), 'afftdn không được bật track_noise (xem ghi chú trong audio-denoise.js)');

  // Chuỗi filter đi thẳng vào filter script của FFmpeg: không được chứa ký tự tách
  // filter/label, nếu không một lỗi đánh máy trong bảng quy đổi thành filter lạ.
  for (const key of AudioDenoise.PROFILE_ORDER) {
    for (const filter of AudioDenoise.ffmpegFilters({ enabled: true, profile: key, amount: 50 })) {
      assert.ok(!/[;[\]\\"']/.test(filter), `filter chứa ký tự nguy hiểm: ${filter}`);
    }
  }
  console.log('  [1] hợp đồng module: ok');
}

// ===================== 2 + 3. PREVIEW vs EXPORT =====================
function testPreviewMatchesExport() {
  const ProcessorClass = loadPreviewProcessor();
  const hasFfmpeg = ffmpegAvailable();
  if (!hasFfmpeg) console.log('  [!] không có ffmpeg -> bỏ qua nửa export');

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const loud = buildSignal(0.05);            // nền ồn ~ -31 dBFS
  const quiet = buildSignal(0.003, 999);     // nền ồn ~ -55 dBFS (thấp hơn ~24 dB)
  const loudWav = path.join(TEMP_DIR, 'denoise_loud.wav');
  const quietWav = path.join(TEMP_DIR, 'denoise_quiet.wav');
  const outWav = path.join(TEMP_DIR, 'denoise_out.wav');
  if (hasFfmpeg) {
    writeWav(loud, loudWav);
    writeWav(quiet, quietWav);
  }

  const cases = [
    { enabled: true, profile: 'voice', amount: 60 },
    { enabled: true, profile: 'room', amount: 80 },
    { enabled: true, profile: 'strong', amount: 100 },
  ];

  for (const cfg of cases) {
    const nr = AudioDenoise.reductionDb(cfg);
    const label = `${cfg.profile}/${cfg.amount} (nr=${nr} dB)`;

    const preview = measure(loud, runPreview(ProcessorClass, loud, cfg));
    // Nền ồn ở khoảng nghỉ phải giảm GẦN BẰNG mức đã hứa. Nới 6 dB vì `nr` là mức giảm
    // TỐI ĐA: phần đuôi hội tụ của bộ ước lượng luôn ăn bớt một ít, và càng đặt sâu thì
    // phần "ăn bớt" đó càng lộ (đo được 35.7/40 dB ở mức mạnh nhất).
    assert.ok(preview.gapDb <= -(nr - 6), `preview ${label}: nền ồn chỉ giảm ${preview.gapDb.toFixed(1)} dB`);
    assert.ok(preview.gapDb >= -(nr + 4), `preview ${label}: giảm ${preview.gapDb.toFixed(1)} dB, quá tay so với nr`);
    // Và đoạn CÓ TIẾNG phải sống sót — đây là ranh giới giữa "khử nhiễu" và "bóp chết".
    assert.ok(preview.burstDb > -3, `preview ${label}: đoạn có tiếng suy hao ${preview.burstDb.toFixed(1)} dB`);

    if (!hasFfmpeg) continue;

    const chain = runFfmpegChain(loudWav, outWav, cfg);
    const exported = measure(loud, decodeWav(outWav));
    assert.ok(exported.gapDb <= -(nr - 6), `export ${label} [${chain}]: nền ồn chỉ giảm ${exported.gapDb.toFixed(1)} dB`);
    assert.ok(exported.burstDb > -3, `export ${label}: đoạn có tiếng suy hao ${exported.burstDb.toFixed(1)} dB`);

    // ĐÂY LÀ HỢP ĐỒNG CHÍNH: hai đường phải cho cùng một mức, không chỉ "đều có khử".
    assert.ok(
      Math.abs(preview.gapDb - exported.gapDb) <= 5,
      `${label}: preview giảm ${preview.gapDb.toFixed(1)} dB nhưng export giảm ${exported.gapDb.toFixed(1)} dB`,
    );

    // ĐỘC LẬP VỚI MỨC ỒN NGUỒN: cùng cấu hình, nguồn êm hơn 24 dB, kết quả không đổi.
    runFfmpegChain(quietWav, outWav, cfg);
    const quietExported = measure(quiet, decodeWav(outWav));
    assert.ok(
      Math.abs(quietExported.gapDb - exported.gapDb) <= 3,
      `${label}: mức khử đổi theo độ ồn của nguồn (${exported.gapDb.toFixed(1)} vs ${quietExported.gapDb.toFixed(1)} dB)`,
    );

    console.log(`  [2] ${label}: preview ${preview.gapDb.toFixed(1)}/${preview.burstDb.toFixed(1)} dB`
      + ` | export ${exported.gapDb.toFixed(1)}/${exported.burstDb.toFixed(1)} dB (nghỉ/tiếng)`);
  }

  for (const file of [loudWav, quietWav, outWav]) fs.rmSync(file, { force: true });
}

// ===================== 4. DÂY NỐI BACKEND -> SIDECAR =====================
async function testExportWiring() {
  if (!ffmpegAvailable()) {
    console.log('  [!] không có ffmpeg -> bỏ qua kiểm tra dây nối export');
    return;
  }
  const { start } = require(path.join(PROJECT_ROOT, 'backend', 'server.js'));
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const sourcePath = path.join(TEMP_DIR, 'temp_input.mp4');
  let result = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=4:r=24',
    '-f', 'lavfi', '-i', 'anoisesrc=d=4:a=0.05:r=48000',
    '-shortest', '-pix_fmt', 'yuv420p', sourcePath,
  ], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);

  const overlayPath = path.join(TEMP_DIR, 'overlay_audio.wav');
  result = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'anoisesrc=d=2:a=0.05:r=48000', overlayPath,
  ], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);

  const reportsDir = path.join(PROJECT_ROOT, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportsBefore = new Set(fs.readdirSync(reportsDir));

  const server = start();
  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    const mainDenoise = { enabled: true, profile: 'room', amount: 80 };
    const overlayDenoise = { enabled: true, profile: 'strong', amount: 100 };
    const sequence = { width: 160, height: 90, preset: 'custom', source_width: 160, source_height: 90, source_fps: '24' };

    /* BỐ TRÍ ĐỂ TÁCH ĐƯỢC HAI NHÁNH.
     *   0-2 s : chỉ có lane chính -> đo được nhánh lane chính.
     *   2-4 s : CHỈ có audio overlay (lane chính để volume 0) -> đo được nhánh overlay.
     * Phải tắt tiếng lane chính ở đoạn sau: để nó kêu thì phần ồn CHƯA lọc của nó trộn
     * đè lên và che mất mức khử của overlay (đo thử: -3.7 dB thay vì -20 dB).
     * Xuất HAI lần, một lần bật một lần tắt, rồi so hai bản với nhau: cùng nguồn, cùng
     * encoder, khác đúng một thứ. So hai đoạn trong CÙNG một bản thì không kết luận được
     * vì overlay đã trộn vào đoạn sau. */
    const buildForm = (denoiseOn) => {
      const form = new FormData();
      form.append('timeline_json', JSON.stringify([
        { start: 0, end: 2, text: 'block 1', script_index: 0, ...(denoiseOn ? { audio_denoise: mainDenoise } : {}) },
        { start: 2, end: 4, text: 'block 2', script_index: 1, audio_volume: 0 },
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
          ...(denoiseOn ? { audio_denoise: overlayDenoise } : {}),
        }],
        assets: [{
          id: 'asset_audio_1',
          type: 'audio',
          name: 'overlay_audio.wav',
          path: overlayPath,
          has_audio: true,
          duration: 2,
        }],
      }));
      form.append('export_settings', JSON.stringify({
        resolution: 'sequence', sequence, fps: '24', codec: 'h264', quality: 'small', audio_bitrate: '320k',
      }));
      form.append('sequence_settings', JSON.stringify(sequence));
      return form;
    };

    const runExport = async (denoiseOn) => {
      const response = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: buildForm(denoiseOn) });
      if (!response.ok) throw new Error(`export lỗi: ${await response.text()}`);
      await response.arrayBuffer();
      const outputPath = path.join(TEMP_DIR, 'final_cut.mp4');
      assert.ok(fs.existsSync(outputPath));
      const audio = decodeWav(outputPath);
      const payload = JSON.parse(fs.readFileSync(path.join(TEMP_DIR, 'export_timeline.json'), 'utf8'));
      return { audio, payload };
    };

    const off = await runExport(false);
    const on = await runExport(true);

    // 4a. Backend đưa ĐÚNG chuỗi filter vào payload gửi sidecar — và chỉ vào block/item
    // thật sự bật, chứ không rải cho cả timeline.
    const expectedMain = AudioDenoise.ffmpegFilters(mainDenoise).join(',');
    const expectedOverlay = AudioDenoise.ffmpegFilters(overlayDenoise).join(',');
    assert.strictEqual(on.payload.intervals[0].audio_denoise_filter, expectedMain);
    assert.strictEqual(on.payload.intervals[1].audio_denoise_filter, '', 'block không bật khử ồn mà vẫn có filter');
    const audioOverlay = (on.payload.overlays || []).find((o) => o.type === 'audio');
    assert.ok(audioOverlay, 'audio overlay không tới được payload export');
    assert.strictEqual(audioOverlay.audio_denoise_filter, expectedOverlay);
    assert.strictEqual(off.payload.intervals[0].audio_denoise_filter, '');
    assert.strictEqual((off.payload.overlays || []).find((o) => o.type === 'audio').audio_denoise_filter, '');

    // 4b. SIDECAR thật sự dùng chuỗi đó — đo trên chính file xuất ra.
    const window = (audio, from, to) => rms(audio, Math.round(from * SR), Math.round(to * SR));
    const mainDelta = toDb(window(on.audio, 0.6, 1.8) / window(off.audio, 0.6, 1.8));
    const overlayDelta = toDb(window(on.audio, 2.6, 3.8) / window(off.audio, 2.6, 3.8));
    assert.ok(mainDelta < -6, `nhánh lane chính không khử ồn khi xuất (chỉ ${mainDelta.toFixed(1)} dB)`);
    assert.ok(overlayDelta < -10, `nhánh audio overlay không khử ồn khi xuất (chỉ ${overlayDelta.toFixed(1)} dB)`);
    console.log(`  [4] export thật: lane chính ${mainDelta.toFixed(1)} dB, audio overlay ${overlayDelta.toFixed(1)} dB`);
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
  testPreviewMatchesExport();
  await testExportWiring();
  console.log('audio denoise pipeline ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
