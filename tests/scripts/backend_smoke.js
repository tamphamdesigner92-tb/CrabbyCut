const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8123';

/* THƯ MỤC TẠM RIÊNG CHO TEST — BẮT BUỘC, và phải đặt TRƯỚC khi require server.
 *
 * Test này gọi POST /api/reset-project, mà endpoint đó DỌN SẠCH thư mục tạm. Trỏ vào
 * thư mục tạm mặc định là xoá luôn dữ liệu của DỰ ÁN NGƯỜI DÙNG ĐANG MỞ: temp_input.mp4,
 * preview_proxy.mp4, toàn bộ file nguồn đã nhập, session_segments.json, cache landmark.
 * Đã xảy ra thật — chạy `npm test` một lần là mất sạch. server.js có sẵn CRAB_TEMP_DIR
 * đúng cho việc này (xem ghi chú ở đầu file đó) nhưng test này chưa dùng.
 */
// KHÔNG đặt tên bắt đầu bằng dấu chấm: `res.download` đi qua `send`, mà `send` trả 404
// cho mọi đường dẫn có đoạn thư mục dạng dotfile — test:export đổ đúng vì lý do này.
const TEST_TEMP = path.join(__dirname, '..', '..', 'test_temp', 'backend_smoke');
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || TEST_TEMP;

const { start } = require('../../backend/server');

async function main() {
  const port = Number(process.env.BACKEND_PORT || 8123);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    const statusRes = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(statusRes.ok, true);
    const status = await statusRes.json();
    assert.strictEqual(typeof status.message, 'string');

    const asrModelsRes = await fetch(`${baseUrl}/api/asr-models`);
    assert.strictEqual(asrModelsRes.ok, true);
    const asrModels = await asrModelsRes.json();
    assert.strictEqual(asrModels.status, 'success');
    assert.strictEqual(Array.isArray(asrModels.models), true);

    const sessionSegments = [
      { start: 0, end: 1.2, text: 'Xin chào mọi người', loudness_dBFS: -12, words: [] },
    ];
    const tempDir = path.resolve(process.env.CRAB_TEMP_DIR);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'session_segments.json'),
      JSON.stringify(sessionSegments),
      'utf8',
    );
    const form = new FormData();
    form.append('reference_script', 'Xin chào mọi người.');
    form.append('script_metadata', JSON.stringify({
      source_type: 'md',
      source_name: 'smoke.md',
      raw_sha1: 'raw',
      clean_sha1: 'clean',
      stale: false,
      notes: [{ text: 'dấu x', raw_start: 0, raw_end: 9, clean_insert_offset: 0, line: 1, column: 1 }],
      bold_ranges: [{ text: 'Xin chào', raw_start: 10, raw_end: 20, clean_start: 0, clean_end: 8, line: 1, column: 10 }],
    }));
    form.append('edited_transcript', '[0.00 - 1.20 | -12.00 dBFS] Xin chào mọi người');
    const filterRes = await fetch(`${baseUrl}/api/filter`, {
      method: 'POST',
      body: form,
    });
    assert.strictEqual(filterRes.ok, true);
    const filtered = await filterRes.json();
    assert.strictEqual(filtered.status, 'success');
    assert.strictEqual(filtered.matching_engine, 'python_reference');
    assert.strictEqual(Array.isArray(filtered.mapped_chunks), true);

    /* Câu đã khớp PHẢI có mục được tick, và mục đó phải mang đúng biên của hàng.
     * Đây là chỗ hợp đồng giữa /filter và màn rà soát từng đứt: bản cũ trả nguyên
     * chunk và chỉ tick khi hàng phủ >40% thời lượng chunk, nên hàng khớp chính
     * xác nằm trong chunk dài thì rơi mất, còn biên tinh thì bị thay bằng biên
     * chunk. */
    const selectedChunks = filtered.mapped_chunks.filter((chunk) => chunk.is_selected);
    assert.ok(selectedChunks.length > 0, 'câu đã khớp nhưng không mục nào được tick');
    const selectedDuration = selectedChunks.reduce((sum, chunk) => sum + (chunk.end - chunk.start), 0);
    const rowDuration = (filtered.timeline_time_order || []).reduce((sum, row) => sum + (row.end - row.start), 0);
    assert.ok(Math.abs(selectedDuration - rowDuration) < 0.05, 'biên bàn giao lệch biên hàng');

    const finalizeRes = await fetch(`${baseUrl}/api/finalize-timeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selected_chunks: [
          { start: 0, end: 1.2, text: 'Xin chào', script_index: 0, script_text: 'Xin chào', score: 1 },
        ],
      }),
    });
    assert.strictEqual(finalizeRes.ok, true);
    const finalized = await finalizeRes.json();
    assert.strictEqual(finalized.status, 'success');
    assert.strictEqual(Array.isArray(finalized.timeline_script_order), true);

    const reportsDir = path.join(__dirname, '..', '..', 'reports');
    const beforeReports = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir).length : 0;
    const resetRes = await fetch(`${baseUrl}/api/reset-project`, { method: 'POST' });
    assert.strictEqual(resetRes.ok, true);
    const resetPayload = await resetRes.json();
    assert.strictEqual(resetPayload.status, 'success');
    assert.strictEqual(typeof resetPayload.report_path, 'string');
    const afterReports = fs.readdirSync(reportsDir).length;
    assert.ok(afterReports >= beforeReports + 1);
    const reportText = fs.readFileSync(resetPayload.report_path, 'utf8');
    assert.ok(reportText.includes('<PROJECT_REPORT>'));
    assert.ok(reportText.includes('<HARDWARE>'));
    assert.ok(reportText.includes('<RAW_VIDEOS>'));
    assert.ok(reportText.includes('<ASR>'));
    assert.ok(reportText.includes('[duration_human]\t'));
    fs.rmSync(resetPayload.report_path, { force: true });

    const resetAgainRes = await fetch(`${baseUrl}/api/reset-project`, { method: 'POST' });
    assert.strictEqual(resetAgainRes.ok, true);
    const resetAgainPayload = await resetAgainRes.json();
    assert.strictEqual(resetAgainPayload.status, 'success');
    assert.strictEqual(resetAgainPayload.report_path, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('backend smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
