const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8126';
/* ÉP ASR LỖI — đây là điều test này muốn kiểm: lỗi có nổi lên tới client và có được
 * ghi vào report hay không. Mỗi nền tảng một biến vì hai sidecar khác nhau; đặt CẢ HAI
 * cho gọn, biến của nền tảng kia chỉ bị bỏ qua.
 * KHÔNG được dựa vào việc máy thiếu thư viện/model để test tự đỏ: lúc ASR chạy được
 * thật thì test sẽ đỏ dù sản phẩm hoàn toàn đúng (đã xảy ra sau khi sửa cuBLAS). */
process.env.MAC_ASR_FORCE_ENGINE_FAILURE = 'mlx_whisper';
process.env.WINDOWS_ASR_FORCE_ENGINE_FAILURE = 'faster_whisper';

/* TÊN ENGINE KHÁC NHAU THEO NỀN TẢNG, phần còn lại của hợp đồng thì không: ASR lỗi
 * -> request trả lỗi, và /api/reset-project ghi report có [requested_engine]. Bản đầu
 * khoá cứng 'mlx_whisper' nên trên Windows test đỏ ở CHỖ SO CHUỖI, dù backend cư xử
 * hoàn toàn đúng (nó báo "ASR engine 'faster_whisper' failed"). Suy tên theo nền tảng
 * để test bảo vệ đúng cái nó muốn bảo vệ ở CẢ hai nơi.
 * Trên Windows resolveAsrRequest() luôn chốt về WINDOWS_ASR_ENGINE, nên engine được
 * yêu cầu là faster_whisper bất kể client gửi gì. */
const EXPECTED_ENGINE = process.platform === 'win32' ? 'faster_whisper' : 'mlx_whisper';
/* Hai sidecar dựng câu lỗi theo HAI khuôn khác nhau, không chỉ khác tên engine:
 *   asr/mac_mlx_sidecar.py:195              -> "ASR engine '<engine>' failed: …"
 *   asr/windows_faster_whisper_sidecar.py:690 -> "Windows ASR faster-whisper failed: …"
 * Cái test cần chốt là câu lỗi CÓ nổi lên tới client (chứ không bị nuốt) và report ghi
 * đúng engine đã yêu cầu — nên so theo khuôn của nền tảng đang chạy. */
const EXPECTED_FAILURE_TEXT = process.platform === 'win32'
  ? 'Windows ASR faster-whisper failed'
  : `ASR engine '${EXPECTED_ENGINE}' failed`;

const projectRoot = path.resolve(__dirname, '..', '..');
const tempDir = path.join(projectRoot, 'temp_uploads');
const inputDir = path.join(projectRoot, '.test_inputs');
const reportsDir = path.join(projectRoot, 'reports');
const { start } = require('../../backend/server');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.strictEqual(result.status, 0, `${command} failed\n${result.stderr || result.stdout}`);
}

async function main() {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(inputDir, { recursive: true, force: true });
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportsBefore = new Set(fs.readdirSync(reportsDir));

  const sourcePath = path.join(inputDir, 'asr_report_source.mp4');
  run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.5:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
    '-shortest',
    '-pix_fmt', 'yuv420p',
    sourcePath,
  ]);

  const server = start();
  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    const transcribeRes = await fetch(`${baseUrl}/api/transcribe-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_paths: [sourcePath],
        reference_script: 'Test',
        transcribe_mode: 'vi_smart',
        asr_engine: 'legacy_disabled',
        client_started_at_ms: Date.now(),
      }),
    });
    assert.strictEqual(transcribeRes.ok, false);
    const errorPayload = await transcribeRes.json();
    assert.ok(errorPayload.detail.includes(EXPECTED_FAILURE_TEXT),
      `detail phải nêu engine đã thất bại, nhận: ${errorPayload.detail}`);

    const resetRes = await fetch(`${baseUrl}/api/reset-project`, { method: 'POST' });
    assert.strictEqual(resetRes.ok, true);
    const resetPayload = await resetRes.json();
    assert.strictEqual(typeof resetPayload.report_path, 'string');
    const reportText = fs.readFileSync(resetPayload.report_path, 'utf8');
    assert.ok(reportText.includes('<PROJECT_REPORT>'));
    assert.ok(reportText.includes('<RAW_VIDEOS>'));
    assert.ok(reportText.includes('[file_count]\t1'));
    assert.ok(reportText.includes('[total_duration_sec]\t'));
    assert.ok(reportText.includes('[total_size_bytes]\t'));
    assert.ok(reportText.includes(`[requested_engine]\t${EXPECTED_ENGINE}`));
    assert.ok(reportText.includes('[mode]\tvi_smart'));
    assert.ok(reportText.includes('<ERRORS>'));
    assert.ok(reportText.includes(EXPECTED_FAILURE_TEXT));

    fs.rmSync(resetPayload.report_path, { force: true });
    for (const name of fs.readdirSync(reportsDir)) {
      if (!reportsBefore.has(name) && /^report_project_\d{8}_\d{6}\.txt$/.test(name)) {
        fs.rmSync(path.join(reportsDir, name), { force: true });
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(inputDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('asr report smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
