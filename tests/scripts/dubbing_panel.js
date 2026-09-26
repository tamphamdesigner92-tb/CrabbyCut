/**
 * Test cho Âm thanh → Lồng tiếng (static/js/dubbing.js) — phần giao diện ↔ backend ↔ timeline.
 *
 * Canh ba chỗ dễ lệch ÂM THẦM:
 *   1. MỐC ĐẶT CLIP: tệp phụ đề + "Vị trí playhead" phải cộng playhead; bộ phụ đề đã nằm trên
 *      timeline thì KHÔNG cộng gì (mốc block đã là mốc timeline). File ghép bắt đầu ở câu đầu
 *      (result.full.start), không phải 00:00.
 *   2. "Mỗi câu một clip": đặt từng câu tại mốc THẬT sau khi xếp (clip.start), không phải mốc
 *      phụ đề — câu bị đẩy lùi vì câu trước tràn phải nằm đúng chỗ đã đẩy.
 *   3. KIỂM TRƯỚC KHI GỬI: F5 thiếu giọng mẫu/lời mẫu, chưa cài môi trường, timeline trống —
 *      báo ngay, không gửi job để rồi chết sau vài phút tải model.
 *
 * DOM giả + fetch giả, không cần trình duyệt hay server TTS.
 * Chạy: npm run test:dubbing-panel
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SF = require(path.join(ROOT, 'static', 'js', 'subtitle-formats.js'));

function loadPanel(ER) {
    const win = {
        document: { getElementById: () => null, createElement: () => ({}), head: { insertBefore: () => {} } },
        setTimeout, clearTimeout, console,
        SubtitleFormats: SF,
        EditingRuntime: ER,
        showToast: () => {},
    };
    const src = fs.readFileSync(path.join(ROOT, 'static', 'js', 'dubbing.js'), 'utf8');
    new Function('window', 'document', 'setTimeout', 'clearTimeout', 'console', 'API_BASE', src)(
        win, win.document, setTimeout, clearTimeout, console, '/api');
    return win.DubbingPanel;
}

function fakeRuntime({ total = 60, playhead = 0 } = {}) {
    const calls = [];
    return {
        calls,
        timelineDuration: () => total,
        currentSequenceTime: () => playhead,
        getSubtitleState: () => ({ id: 'sub_auto', item_ids: ['a'] }),
        getSubtitleImports: () => [],
        subtitleCuesFromItems: (id) => (id === '' ? [
            { start: 30, end: 32, text: 'Câu trên timeline' },
        ] : []),
        addDubbingAudio: async (entries, options) => {
            calls.push({ entries, options });
            return { placed: entries.length, skipped: 0, clamped: 0, removed: 0 };
        },
        renderEditPanel: () => {},
    };
}

const READY_STATUS = {
    env: { ready: true, setup_in_progress: false },
    server: { running: true },
    engines: [
        { id: 'f5', label: 'F5', available: true, voices: [], models: [{ key: 'f5-vi', ready: true }] },
        { id: 'vieneu', label: 'VieNeu', available: true, voices: ['Ly', 'Ngoc'], models: [{ key: 'vieneu-tts', ready: false }] },
    ],
};

function fakeFile(name, text) {
    return { name, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
}

/* fetch giả: trả status, nhận job, rồi báo job xong với kết quả cho trước. */
function installFetch(result) {
    const seen = [];
    global.fetch = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        seen.push({ url, method: init.method || 'GET', body });
        let data;
        if (url.endsWith('/tts/status')) data = READY_STATUS;
        else if (url.endsWith('/dubbing/jobs') && init.method === 'POST') data = { job_id: 'dub_1', state: 'running', stage: 'models', done: 0, total: 2 };
        else if (url.includes('/dubbing/jobs/dub_1')) data = { job_id: 'dub_1', state: 'done', stage: 'done', done: 2, total: 2, warnings: [], result };
        else data = {};
        return { ok: true, status: 200, json: async () => data };
    };
    return seen;
}

const waitFor = async (cond, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('hết giờ chờ');
        await new Promise((r) => setTimeout(r, 20));
    }
};

const SRT = [
    '1', '00:00:02,000 --> 00:00:04,000', 'Xin chào', '',
    '2', '00:00:05,000 --> 00:00:06,000', '[ÂM NHẠC]', '',
    '3', '00:00:07,000 --> 00:00:09,000', 'Tạm biệt', '',
].join('\n');

(async () => {
    /* ---------- 3. Kiểm trước khi gửi ---------- */
    {
        const panel = loadPanel(fakeRuntime());
        panel.state.status = { env: { ready: false }, engines: [] };
        assert.match(panel.validate(false), /Cài thư viện/, 'chưa cài môi trường -> nhắc bấm nút cài');
        panel.state.status = READY_STATUS;
        panel.state.engine = 'f5';
        panel.state.refPath = '';
        assert.match(panel.validate(true), /giọng mẫu/, 'F5 thiếu tệp giọng mẫu');
        panel.state.refPath = 'C:\\mau.wav';
        panel.state.refText = '   ';
        assert.match(panel.validate(true), /Lời|lời/, 'F5 thiếu lời của giọng mẫu');
        panel.state.refText = 'xin chào';
        assert.strictEqual(panel.validate(true), '', 'nghe thử F5 đủ điều kiện');
        assert.match(panel.validate(false), /phụ đề/, 'lồng tiếng mà chưa có câu nào');
        const empty = loadPanel(fakeRuntime({ total: 0 }));
        empty.state.status = READY_STATUS;
        empty.state.engine = 'vieneu';
        empty.state.cues = [{ start: 0, end: 1, text: 'a' }];
        assert.match(empty.validate(false), /Timeline chưa có video/, 'timeline trống');
        console.log('  ok  kiểm điều kiện trước khi gửi job');
    }

    /* ---------- Đọc tệp + thân job ---------- */
    {
        const panel = loadPanel(fakeRuntime({ playhead: 12 }));
        await panel.importFile(fakeFile('Phim A.srt', SRT));
        assert.strictEqual(panel.state.source, 'file');
        assert.strictEqual(panel.state.cues.length, 3, 'panel giữ nguyên câu — lọc câu nhạc là việc của server');
        panel.state.engine = 'vieneu';
        panel.state.voice = 'Ngoc';
        const body = panel.jobBody(false);
        assert.strictEqual(body.voice, 'Ngoc');
        assert.strictEqual(body.ref_audio, '', 'VieNeu không gửi giọng mẫu');
        assert.strictEqual(body.cues.length, 3);
        assert.strictEqual(body.name, 'Phim A (lồng tiếng)', 'tên tệp ra theo tên phụ đề');
        const preview = panel.jobBody(true);
        assert.ok(preview.preview && preview.text === 'Xin chào' && !preview.cues, 'nghe thử đọc câu đầu, không gửi cả bài');
        console.log('  ok  đọc tệp phụ đề + dựng thân job');
    }

    /* ---------- 1. Mốc đặt clip: tệp + playhead, một clip ghép ---------- */
    {
        const ER = fakeRuntime({ playhead: 12 });
        const panel = loadPanel(ER);
        installFetch({
            full: { path: 'C:\\out\\full.wav', start: 2.0, duration: 7.5 },
            clips: [{ path: 'C:\\out\\1.wav', start: 2.0, duration: 1.5 }, { path: 'C:\\out\\3.wav', start: 7.4, duration: 1.2 }],
            summary: { count: 2 }, skipped: { music: 1 },
        });
        await panel.refreshStatus();
        await panel.importFile(fakeFile('Phim A.srt', SRT));
        panel.state.engine = 'vieneu';
        panel.state.startAt = 'playhead';
        panel.state.split = false;
        panel.state.replace = true;
        assert.ok(panel.renderPaneHtml().includes('data-dub-start'), 'panel vẽ được nút "Tạo lồng tiếng"');
        assert.strictEqual(panel.validate(false), '');
        // Bấm nút qua đúng đường người dùng đi: bindPane -> click [data-dub-start].
        let clickHandler = null;
        const zone = {
            querySelector: () => null,
            addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; },
        };
        panel.bindPane({ querySelector: (sel) => (sel === '[data-dub-zone]' ? zone : null) });
        clickHandler({ target: { closest: (sel) => (sel === '[data-dub-start]' ? {} : null) } });
        await waitFor(() => ER.calls.length === 1);
        const call = ER.calls[0];
        assert.strictEqual(call.entries.length, 1, 'một clip ghép');
        assert.strictEqual(call.entries[0].start, 14, 'mốc = full.start (2s) + playhead (12s)');
        assert.strictEqual(call.options.sourceKey, 'file:phim a.srt');
        assert.strictEqual(call.options.replace, true);
        console.log('  ok  tệp phụ đề + playhead: clip ghép đặt ở full.start + playhead');
    }

    /* ---------- 1+2. Bộ trên timeline, mỗi câu một clip ---------- */
    {
        const ER = fakeRuntime({ playhead: 12 });
        const panel = loadPanel(ER);
        installFetch({
            full: { path: 'C:\\out\\full.wav', start: 30, duration: 2 },
            clips: [{ path: 'C:\\out\\1.wav', start: 30.4, duration: 1.8 }],
            summary: { count: 1 }, skipped: {},
        });
        await panel.refreshStatus();
        let changeHandler = null;
        let clickHandler = null;
        const zone = {
            querySelector: () => null,
            addEventListener: (type, fn) => {
                if (type === 'change') changeHandler = fn;
                if (type === 'click') clickHandler = fn;
            },
        };
        panel.bindPane({ querySelector: (sel) => (sel === '[data-dub-zone]' ? zone : null) });
        changeHandler({ target: { value: 'set:auto', matches: (sel) => sel === '[data-dub-set]' } });
        assert.strictEqual(panel.state.cues.length, 1, 'chọn bộ Auto Subtitle trên timeline');
        panel.state.engine = 'vieneu';
        panel.state.startAt = 'playhead';   // KHÔNG được áp cho bộ trên timeline
        panel.state.split = true;
        clickHandler({ target: { closest: (sel) => (sel === '[data-dub-start]' ? {} : null) } });
        await waitFor(() => ER.calls.length === 1);
        const entry = ER.calls[0].entries[0];
        assert.strictEqual(entry.start, 30.4, 'clip từng câu ở mốc thật sau khi xếp, không cộng playhead');
        assert.strictEqual(entry.path, 'C:\\out\\1.wav');
        assert.strictEqual(ER.calls[0].options.sourceKey, 'set:auto');
        console.log('  ok  bộ phụ đề trên timeline + mỗi câu một clip: đúng mốc thật, không cộng playhead');
    }

    console.log('\nTất cả đều qua.');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
