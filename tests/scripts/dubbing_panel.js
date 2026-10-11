/**
 * Test cho Âm thanh → Lồng tiếng (static/js/dubbing.js) — phần giao diện ↔ backend ↔ timeline.
 *
 * Canh ba chỗ dễ lệch ÂM THẦM:
 *   1. MỐC ĐẶT CLIP: tệp phụ đề + "Vị trí playhead" phải cộng playhead; bộ phụ đề đã nằm trên
 *      timeline thì KHÔNG cộng gì (mốc block đã là mốc timeline). File ghép bắt đầu ở câu đầu
 *      (result.full.start), không phải 00:00.
 *   2. "Mỗi câu một clip": đặt từng câu tại mốc THẬT sau khi xếp (clip.start), không phải mốc
 *      phụ đề — câu bị đẩy lùi vì câu trước tràn phải nằm đúng chỗ đã đẩy.
 *   3. KIỂM TRƯỚC KHI GỬI: chưa cài môi trường, chưa có câu/văn bản, timeline trống — báo ngay,
 *      không gửi job để rồi chết sau vài phút tải model.
 *   4. VĂN BẢN KHÔNG MỐC (v1.1.17): tách câu, gửi chế độ "sequential" + khoảng nghỉ, chọn hồ sơ
 *      giọng thì gửi id (không gửi tên giọng dựng sẵn), và phụ đề sinh kèm đúng mốc tiếng đọc
 *      (+ playhead), câu dài chia thành nhiều block theo tỉ lệ ký tự.
 *
 * DOM giả + fetch giả, không cần trình duyệt hay server TTS.
 * Chạy: npm run test:dubbing-panel
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SF = require(path.join(ROOT, 'static', 'js', 'subtitle-formats.js'));

function loadPanel(ER, extra = {}) {
    const win = {
        ...extra,
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
        {
            id: 'vieneu3', label: 'VieNeu v3', available: true, clone: true, models: [{ key: 'vieneu3-torch', ready: true }],
            voices: ['Hải Đăng', 'Mai Anh'],
            voice_details: [
                { id: 'Hải Đăng', label: 'Hải Đăng', description: 'Nam · Bắc · Phong cách tự nhiên' },
                { id: 'Mai Anh', label: 'Mai Anh', description: 'Nữ · Bắc · Phong cách tin tức' },
            ],
        },
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
        else if (url.endsWith('/voice-profiles')) data = { profiles: [{ id: 'vp_abc123', name: 'Giọng tôi', ref_text: '', duration: 6 }] };
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
        panel.state.engine = 'vieneu3';
        assert.strictEqual(panel.validate(true), '', 'nghe thử không cần câu nào (server đọc câu mẫu)');
        assert.match(panel.validate(false), /phụ đề/, 'lồng tiếng mà chưa có câu nào');
        panel.state.sourceMode = 'text';
        panel.state.text = '   ';
        assert.match(panel.validate(false), /văn bản/, 'chế độ văn bản mà chưa có chữ');
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
        assert.ok(!('ref_audio' in body) && !('voice_profile' in body), 'không chọn hồ sơ -> không gửi giọng mẫu');
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

    /* ---------- 4. Văn bản không mốc + hồ sơ giọng + phụ đề sinh kèm ---------- */
    {
        const P = loadPanel(fakeRuntime());
        assert.deepStrictEqual(
            P.splitSentences('Xin chào các bạn. Hôm nay trời đẹp!\n\nTiêu đề không dấu chấm\nCâu cuối…'),
            ['Xin chào các bạn.', 'Hôm nay trời đẹp!', 'Tiêu đề không dấu chấm', 'Câu cuối…'],
            'tách theo dấu câu và xuống dòng, bỏ dòng trống');
        const long = `${'một hai ba bốn, '.repeat(30)}hết.`;
        assert.ok(P.splitSentences(long).every((x) => x.length <= 220), 'câu quá dài bị cắt nhỏ');
        const subs = P.subtitleCuesFromClips([
            { start: 0, duration: 2, text: 'Ngắn.' },
            { start: 2.4, duration: 6, text: `${'a'.repeat(50)} ${'b'.repeat(50)}` },
        ], 10);
        assert.strictEqual(subs.length, 3, 'câu > 84 ký tự chia hai block');
        assert.deepStrictEqual([subs[0].start, subs[0].end], [10, 12], 'cộng mốc bắt đầu');
        assert.ok(Math.abs(subs[1].start - 12.4) < 1e-9 && Math.abs(subs[2].end - 18.4) < 1e-9, 'các block phủ đúng khoảng tiếng đọc');
        console.log('  ok  tách câu + chia phụ đề theo tiếng đọc');
    }
    {
        const ER = fakeRuntime({ playhead: 5 });
        const imported = [];
        const LocalSubtitlePanel = { importCues: (cues, meta) => { imported.push({ cues, meta }); return { count: cues.length }; } };
        const panel = loadPanel(ER, { LocalSubtitlePanel });
        installFetch({
            full: { path: 'C:\\out\\full.wav', start: 0, duration: 4 },
            clips: [{ start: 0, duration: 1.5, text: 'Câu một.' }, { start: 1.9, duration: 2.1, text: 'Câu hai.' }],
            summary: { count: 2 }, skipped: {},
        });
        await panel.refreshStatus();
        panel.state.engine = 'vieneu3';
        panel.state.sourceMode = 'text';
        panel.state.text = 'Câu một. Câu hai.';
        panel.state.textName = '';
        panel.state.gap = 0.4;
        panel.state.startAt = 'playhead';
        panel.state.makeSubs = true;
        panel.state.split = false;
        panel.state.voiceProfile = 'vp_abc123';
        const body = panel.jobBody(false);
        assert.strictEqual(body.timing_mode, 'sequential');
        assert.strictEqual(body.gap, 0.4);
        assert.strictEqual(body.voice_profile, 'vp_abc123', 'gửi id hồ sơ giọng');
        assert.strictEqual(body.voice, '', 'chọn hồ sơ thì không gửi giọng dựng sẵn');
        assert.deepStrictEqual(body.cues.map((c) => c.text), ['Câu một.', 'Câu hai.']);
        assert.ok(panel.renderPaneHtml().includes('Giọng tôi'), 'danh sách giọng có hồ sơ của người dùng');
        let clickHandler = null;
        const zone = { querySelector: () => null, addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; } };
        panel.bindPane({ querySelector: (sel) => (sel === '[data-dub-zone]' ? zone : null) });
        clickHandler({ target: { closest: (sel) => (sel === '[data-dub-start]' ? {} : null) } });
        await waitFor(() => ER.calls.length === 1 && imported.length === 1);
        assert.strictEqual(ER.calls[0].entries[0].start, 5, 'audio văn bản đặt từ playhead');
        assert.strictEqual(ER.calls[0].options.sourceKey, 'text:typed');
        assert.deepStrictEqual(imported[0].cues.map((c) => [c.start, c.end]), [[5, 6.5], [6.9, 9]], 'phụ đề khớp mốc tiếng + playhead');
        panel.state.makeSubs = false;
        panel.state.voiceProfile = '';
        assert.strictEqual(panel.jobBody(false).voice_profile, undefined);
        console.log('  ok  văn bản: sequential + hồ sơ giọng + phụ đề khớp tiếng');
    }

    /* ---------- 5. Qwen3-TTS / Chatterbox (v1.1.17): tuỳ chọn engine + môi trường riêng ---------- */
    {
        const panel = loadPanel(fakeRuntime());
        const qwen = {
            id: 'qwen3', label: 'Qwen3-TTS', available: true, clone: true, env_id: 'qwen', env_ready: true,
            models: [{ key: 'qwen3-0.6b-custom', ready: true }], voices: ['Ryan'],
            voice_details: [{ id: 'Ryan', label: 'Ryan', description: '' }],
            languages: [{ id: 'Auto', label: 'Auto' }, { id: 'English', label: 'English' }],
            modes: [{ id: 'custom', available: true }, { id: 'clone', available: true },
                { id: 'design', available: false, reason: 'cần GPU mạnh' }],
        };
        const cb = {
            id: 'chatterbox', label: 'Chatterbox Multilingual', available: true, clone: true, env_id: 'chatterbox', env_ready: false,
            env_size_mb: 3800, models: [{ key: 'chatterbox-mtl', ready: false }], voices: ['default'],
            voice_details: [{ id: 'default', label: 'Giọng mặc định', description: '' }],
            languages: [{ id: 'en', label: 'Tiếng Anh' }, { id: 'fr', label: 'Tiếng Pháp' }],
        };
        panel.state.status = { env: { ready: true }, envs: {}, engines: [qwen, cb] };
        panel.state.profiles = [{ id: 'vp_abc123', name: 'Giọng tôi', ref_text: '', duration: 6 }];
        panel.state.cues = [{ start: 0, end: 1, text: 'Hello' }];

        panel.state.engine = 'qwen3';
        panel.state.qwenMode = 'custom';
        panel.state.voice = 'Ryan';
        panel.state.languages.qwen3 = 'English';
        panel.state.instruct = 'Speak happily';
        panel.state.voiceProfile = 'vp_abc123';
        let body = panel.jobBody(false);
        assert.deepStrictEqual(body.engine_options, { mode: 'custom', language: 'English', instruct: 'Speak happily' });
        assert.strictEqual(body.voice, 'Ryan');
        assert.ok(!body.voice_profile, 'giọng có sẵn của Qwen không gửi hồ sơ giọng');
        panel.state.qwenMode = 'clone';
        body = panel.jobBody(false);
        assert.strictEqual(body.voice_profile, 'vp_abc123', 'chế độ nhân bản gửi hồ sơ giọng');
        panel.state.voiceProfile = '';
        assert.match(panel.validate(false), /hồ sơ giọng/, 'nhân bản mà chưa chọn hồ sơ');
        panel.state.qwenMode = 'design';
        assert.match(panel.validate(false), /GPU mạnh/, 'thiết kế giọng trên máy không đủ sức -> báo lý do của server');
        assert.ok(panel.renderPaneHtml().includes('dubQwenMode'), 'panel vẽ ô chọn chế độ Qwen');

        panel.state.engine = 'chatterbox';
        assert.match(panel.validate(false), /Cài thêm/, 'môi trường riêng chưa cài -> nhắc bấm "Cài thêm"');
        assert.ok(panel.renderPaneHtml().includes('data-dub-env-setup="chatterbox"'), 'panel vẽ nút cài thêm');
        cb.env_ready = true;
        panel.state.languages.chatterbox = 'fr';
        panel.state.exaggeration = 0.8;
        panel.state.cfgWeight = 0.3;
        body = panel.jobBody(false);
        assert.deepStrictEqual(body.engine_options, { language: 'fr', exaggeration: 0.8, cfg_weight: 0.3 });
        assert.ok(panel.renderPaneHtml().includes('dubExaggeration'), 'panel vẽ thanh cảm xúc của Chatterbox');
        console.log('  ok  Qwen3-TTS / Chatterbox: tuỳ chọn engine, hồ sơ giọng theo chế độ, nút cài môi trường riêng');
    }

    console.log('\nTất cả đều qua.');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
