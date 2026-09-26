/**
 * Test cho thanh "Đang tải mô hình…" ở góc trái thanh trạng thái — phía backend:
 *   1. backend/model-downloads.js: vòng đời một lượt tải, đồng bộ ảnh chụp từ server TTS, lượt
 *      xong được giữ thêm một lúc rồi mới rơi khỏi danh sách.
 *   2. parseTqdmBytes (backend/server.js): nhận thanh tqdm đo theo BYTE của model tải ngầm
 *      (openai-whisper, huggingface_hub) nhưng KHÔNG nhận nhầm thanh "frames/s" của lúc bóc băng.
 *
 * Chạy: npm run test:model-downloads
 */
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const reg = require(path.join(ROOT, 'backend', 'model-downloads.js'));

/* ---------- 1. Sổ tải ---------- */
{
    reg.reset();
    reg.begin('asr:large', { label: 'Whisper Large', total: 1000 });
    reg.update('asr:large', { downloaded: 250 });
    let [item] = reg.list();
    assert.strictEqual(item.state, 'downloading');
    assert.strictEqual(item.downloaded, 250);
    assert.strictEqual(reg.activeCount(), 1);
    reg.update('asr:large', { downloaded: 5000 });
    assert.strictEqual(reg.list()[0].downloaded, 1000, 'không vượt tổng');
    reg.end('asr:large');
    [item] = reg.list();
    assert.strictEqual(item.state, 'done');
    assert.strictEqual(item.downloaded, 1000, 'xong thì đầy thanh');
    assert.strictEqual(reg.activeCount(), 0);
    item.finished_at = 0;   // bản sao — sổ gốc không đổi
    assert.strictEqual(reg.list().length, 1, 'lượt vừa xong còn hiện thêm một lúc');
    console.log('  ok  vòng đời begin -> update -> end');
}

{
    reg.reset();
    // Ảnh chụp từ server TTS (GET /health -> downloads): đang tải -> xong.
    reg.syncSnapshot([{ id: 'tts:f5-vi', label: 'Vi-F5-TTS', state: 'downloading', downloaded: 10, total: 100 }]);
    assert.strictEqual(reg.list()[0].state, 'downloading');
    reg.syncSnapshot([{ id: 'tts:f5-vi', label: 'Vi-F5-TTS', state: 'downloading', downloaded: 60, total: 100 }]);
    assert.strictEqual(reg.list()[0].downloaded, 60);
    reg.syncSnapshot([{ id: 'tts:f5-vi', label: 'Vi-F5-TTS', state: 'done', downloaded: 100, total: 100 }]);
    assert.strictEqual(reg.list()[0].state, 'done');
    // Server vẫn trả lượt "done" cũ ở mọi lần hỏi sau — không được hồi sinh nó thành lượt mới.
    const before = reg.list()[0].finished_at;
    reg.syncSnapshot([{ id: 'tts:f5-vi', label: 'Vi-F5-TTS', state: 'done', downloaded: 100, total: 100 }]);
    assert.strictEqual(reg.list()[0].finished_at, before, 'ảnh chụp lặp lại không làm mới lượt đã xong');
    // Lỗi -> ghi lỗi.
    reg.syncSnapshot([{ id: 'tts:vocos', label: 'Vocos', state: 'downloading', downloaded: 0, total: 5 }]);
    reg.syncSnapshot([{ id: 'tts:vocos', label: 'Vocos', state: 'error', error: 'mất mạng' }]);
    const vocos = reg.list().find((e) => e.id === 'tts:vocos');
    assert.strictEqual(vocos.state, 'error');
    assert.strictEqual(vocos.error, 'mất mạng');
    // Model đã có sẵn từ trước (server báo "done" mà sổ chưa từng thấy đang tải) -> không hiện gì.
    reg.syncSnapshot([{ id: 'tts:vieneu', state: 'done', downloaded: 1, total: 1 }]);
    assert.ok(!reg.list().some((e) => e.id === 'tts:vieneu'), 'không báo "đã tải xong" cho model vốn có sẵn');
    console.log('  ok  đồng bộ ảnh chụp từ server TTS');
}

{
    reg.reset();
    reg.begin('x', { label: 'X' });
    reg.end('x');
    const realNow = Date.now;
    Date.now = () => realNow() + reg.KEEP_DONE_MS + 1000;
    try {
        assert.strictEqual(reg.list().length, 0, 'lượt xong rơi khỏi danh sách sau KEEP_DONE_MS');
    } finally {
        Date.now = realNow;
    }
    console.log('  ok  lượt đã xong tự rơi khỏi danh sách');
}

/* ---------- 2. Đọc thanh tqdm theo byte ---------- */
{
    const { parseTqdmBytes } = require(path.join(ROOT, 'backend', 'server.js'));
    const whisper = parseTqdmBytes(' 45%|████▌     | 1.30G/2.88G [00:30<00:40, 42.1MiB/s]');
    assert.ok(whisper && Math.abs(whisper.total - 2.88 * 1024 ** 3) < 1e6, 'openai-whisper: đơn vị nhị phân (iB)');
    const hub = parseTqdmBytes('model.safetensors:  12%|█▏        | 71.3M/587M [00:05<00:30, 14.2MB/s]');
    assert.deepStrictEqual(hub, { downloaded: 71300000, total: 587000000 }, 'huggingface_hub: đơn vị thập phân');
    const many = parseTqdmBytes(' 1%| | 10.0M/1.00G [00:01<01:00, 10MB/s]\r 2%| | 20.0M/1.00G [00:02<01:00, 10MB/s]');
    assert.strictEqual(many.downloaded, 20000000, 'nhiều lần cập nhật trong một cụm -> lấy lần CUỐI');
    assert.strictEqual(parseTqdmBytes(' 50%|█████     | 1500/3000 [00:10<00:10, 150.00frames/s]'), null, 'thanh frames/s của lúc bóc băng không phải lượt tải');
    assert.strictEqual(parseTqdmBytes('Loading weights: 100%|██| 244/244 [00:00<00:00, 260.81it/s]'), null, 'thanh it/s không phải lượt tải');
    console.log('  ok  parseTqdmBytes');
}

console.log('\nTất cả đều qua.');
