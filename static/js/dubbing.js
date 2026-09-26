/* Nhóm "Lồng tiếng" của tab Âm thanh: đọc tệp phụ đề (có mốc thời gian) thành giọng nói AI rồi
 * đặt audio lên timeline ĐÚNG mốc của từng câu.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NĂM QUYẾT ĐỊNH, ĐỌC TRƯỚC KHI SỬA
 *
 * 1. NGUỒN CÂU là tệp phụ đề người dùng nhập (.srt/.vtt/.ass… — đọc bằng subtitle-formats.js,
 *    cùng bộ đọc với Local Subtitle) HOẶC một bộ phụ đề đã có trên timeline (Auto/Local
 *    Subtitle — đọc từ chính block, nên chữ/mốc người dùng đã sửa được tính).
 *
 * 2. MỐC: như Local Subtitle — mốc trong tệp = mốc timeline tính từ 00:00, hoặc từ playhead.
 *    Bộ phụ đề đã nằm trên timeline thì mốc của block đã là mốc timeline, không cộng gì.
 *
 * 3. CĂN THỜI GIAN port từ Vi-TTS Studio (repo TTS-App): "auto_fit" — câu dài hơn khung được
 *    đọc nhanh hơn tới một trần, vẫn tràn thì đẩy câu sau lùi. Logic nằm ở tts/dubbing_core.py
 *    (Python, có test) chứ không ở đây.
 *
 * 4. KẾT QUẢ là block AUDIO thật trên lane "Lồng tiếng" (ER.addDubbingAudio): một clip ghép cả
 *    bài, hoặc mỗi câu một clip để kéo chỉnh riêng. Lồng lại cùng nguồn thì THAY bản cũ.
 *
 * 5. MODEL TẢI LẦN ĐẦU có tiến trình ở góc trái thanh trạng thái (model-download-status.js) —
 *    panel chỉ nhắc người dùng nhìn xuống đó, không vẽ thanh tải thứ hai.
 * ────────────────────────────────────────────────────────────────────────────
 */
(function () {
    'use strict';

    const _t = (typeof globalThis !== 'undefined' && globalThis._t)
        || ((k, p) => (p ? String(k).replace(/\{(\w+)\}/g, (m, n) => (n in p ? p[n] : m)) : k));

    const POLL_MS = 800;
    const PREFS_KEY = 'crab.dubbing.prefs.v1';

    const TIMING_MODES = [
        { id: 'auto_fit', label: _t('Tự co giãn cho vừa khung'), hint: _t('Câu dài hơn khung phụ đề được đọc nhanh hơn (tối đa theo "Tăng tốc tối đa"); vẫn tràn thì câu sau lùi lại một chút.') },
        { id: 'dynamic_shift', label: _t('Giữ tốc độ, dời câu sau'), hint: _t('Không đổi tốc độ đọc. Câu nào đè lên câu trước thì dời tới ngay sau câu trước.') },
        { id: 'fixed_duration', label: _t('Cắt đúng khung phụ đề'), hint: _t('Mỗi câu nằm gọn trong khung của nó; phần dài hơn bị cắt đuôi. F5-TTS được nhắc độ dài từ lúc đọc nên hiếm khi phải cắt.') },
    ];
    const MAX_SPEEDS = [1.2, 1.45, 1.7, 2.0];
    const START_OPTIONS = [
        { id: 'zero', label: _t('Đầu timeline') },
        { id: 'playhead', label: _t('Vị trí playhead') },
    ];

    const state = {
        status: null,          // GET /api/tts/status
        statusError: '',
        statusLoading: false,
        // nguồn câu
        source: '',            // 'file' | 'set:<id>' | 'set:auto'
        sourceName: '',
        cues: [],
        fileNotes: '',
        showCues: false,
        // tuỳ chọn (nhớ giữa các lần mở — xem loadPrefs)
        engine: 'vieneu',
        voice: 'Ly',
        describe: '',
        refPath: '',
        refText: '',
        speed: 1,
        timingMode: 'auto_fit',
        maxSpeed: 1.45,
        startAt: 'zero',
        split: false,
        replace: true,
        // lượt chạy
        job: null,
        jobKind: '',           // 'dub' | 'preview'
        busy: false,
        lastError: '',
        lastNotes: [],
    };
    let pollTimer = null;
    let statusTimer = null;
    let previewAudio = null;

    const esc = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const ER = () => window.EditingRuntime || null;
    const SF = () => window.SubtitleFormats || null;
    const AUTO = () => window.AutoSubtitlePanel || null;
    const API = () => ((typeof API_BASE !== 'undefined' && API_BASE) || '/api');

    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, { type: type || 'info' });
        else console.log(`[dubbing] ${message}`);
    }
    function clock(seconds) {
        return AUTO()?.clock ? AUTO().clock(seconds) : String(Math.round(Number(seconds) || 0));
    }
    const baseName = (fileName) => String(fileName || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

    function loadPrefs() {
        try {
            const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
            if (!raw || typeof raw !== 'object') return;
            ['engine', 'voice', 'describe', 'refPath', 'refText', 'timingMode', 'startAt'].forEach((k) => {
                if (typeof raw[k] === 'string') state[k] = raw[k];
            });
            ['speed', 'maxSpeed'].forEach((k) => { if (Number.isFinite(Number(raw[k]))) state[k] = Number(raw[k]); });
            ['split', 'replace'].forEach((k) => { if (typeof raw[k] === 'boolean') state[k] = raw[k]; });
        } catch (_) { /* localStorage bị chặn: dùng mặc định */ }
    }
    function savePrefs() {
        try {
            const keep = {};
            ['engine', 'voice', 'describe', 'refPath', 'refText', 'speed', 'timingMode', 'maxSpeed', 'startAt', 'split', 'replace']
                .forEach((k) => { keep[k] = state[k]; });
            localStorage.setItem(PREFS_KEY, JSON.stringify(keep));
        } catch (_) { /* no-op */ }
    }
    loadPrefs();

    async function api(method, path, body) {
        const resp = await fetch(`${API()}${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const error = new Error(data.detail || _t('Lỗi máy chủ ({status})', { status: resp.status }));
            error.status = resp.status;
            throw error;
        }
        return data;
    }

    // ── Trạng thái môi trường + engine ──────────────────────────────────────

    async function refreshStatus() {
        if (state.statusLoading) return;
        state.statusLoading = true;
        try {
            state.status = await api('GET', '/tts/status');
            state.statusError = '';
        } catch (error) {
            state.statusError = error.message || String(error);
        } finally {
            state.statusLoading = false;
        }
        // Đang cài thư viện thì hỏi lại đều đặn để nút "Cài đặt" tự biến mất khi xong.
        clearTimeout(statusTimer);
        if (state.status?.env?.setup_in_progress) statusTimer = setTimeout(refreshStatus, 3000);
        repaint();
    }

    function engines() { return state.status?.engines || []; }
    function currentEngine() { return engines().find((e) => e.id === state.engine) || null; }
    function engineModelsReady(engine) { return (engine?.models || []).every((m) => m.ready); }

    async function startSetup() {
        try {
            await api('POST', '/tts/setup');
            window.ModelDownloadStatus?.kick();
            toast(_t('Đang cài thư viện lồng tiếng — tiến trình ở góc trái thanh trạng thái.'), 'info');
        } catch (error) {
            toast(error.message, 'error');
        }
        refreshStatus();
    }

    // ── Nguồn câu ───────────────────────────────────────────────────────────

    function timelineSets() {
        const runtime = ER();
        if (!runtime) return [];
        const out = [];
        const auto = runtime.getSubtitleState?.();
        if (auto) {
            const cues = runtime.subtitleCuesFromItems?.('') || [];
            if (cues.length) out.push({ key: 'set:auto', name: 'Auto Subtitle', cues });
        }
        (runtime.getSubtitleImports?.() || []).forEach((set) => {
            const cues = runtime.subtitleCuesFromItems?.(set.id) || [];
            if (cues.length) out.push({ key: `set:${set.id}`, name: set.name || set.source_name || 'Subtitle', cues });
        });
        return out;
    }

    async function importFile(file) {
        if (!file) return;
        if (!SF()) { toast(_t('Chưa nạp được {file}.', { file: 'subtitle-formats.js' }), 'error'); return; }
        try {
            const buffer = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Response(file).arrayBuffer();
            const decoded = SF().decodeSubtitleBytes(buffer);
            const parsed = SF().parseSubtitleText(decoded.text, file.name || '');
            state.source = 'file';
            state.sourceName = String(file.name || '');
            state.cues = parsed.cues.map((c) => ({ start: c.start, end: c.end, text: c.text }));
            const notes = [];
            if (decoded.fallback) notes.push(_t('tệp không phải UTF-8, đã đọc theo bảng mã Windows-1258'));
            if (parsed.merged) notes.push(_t('{n} câu bắt đầu cùng lúc được gộp', { n: parsed.merged }));
            if (parsed.trimmed) notes.push(_t('{n} câu chồng mốc lên câu sau được cắt đuôi', { n: parsed.trimmed }));
            state.fileNotes = notes.join('; ');
            state.lastError = '';
        } catch (error) {
            state.lastError = `${file.name || ''}: ${error?.message || error}`;
        }
        repaint();
    }

    function chooseSet(key) {
        const set = timelineSets().find((s) => s.key === key);
        if (!set) return;
        state.source = key;
        state.sourceName = set.name;
        state.cues = set.cues;
        state.fileNotes = '';
        state.lastError = '';
        repaint();
    }

    function sourceKey() {
        return state.source === 'file' ? `file:${state.sourceName.toLowerCase()}` : state.source;
    }

    // Mốc đặt lên timeline: tệp thì cộng playhead nếu chọn; bộ trên timeline thì đã là mốc thật.
    function timeOffset() {
        if (state.source !== 'file' || state.startAt !== 'playhead') return 0;
        return Number(ER()?.currentSequenceTime?.()) || 0;
    }

    // ── Giọng mẫu (F5) ──────────────────────────────────────────────────────

    async function pickReference(input) {
        const pick = window.desktopEnv?.pickEditingAssets;
        if (typeof pick === 'function') {
            const paths = await pick('audio');
            if (Array.isArray(paths) && paths[0]) {
                state.refPath = paths[0];
                savePrefs();
                repaint();
            }
            return;
        }
        input?.click();
    }

    // ── Chạy job ────────────────────────────────────────────────────────────

    function jobBody(preview) {
        const body = {
            engine: state.engine,
            voice: state.engine === 'voxcpm' ? state.describe : state.voice,
            ref_audio: state.engine === 'f5' ? state.refPath : '',
            ref_text: state.engine === 'f5' ? state.refText : '',
            speed: state.speed,
            timing_mode: state.timingMode,
            max_speed: state.maxSpeed,
            split_clips: state.split,
            name: state.sourceName ? _t('{name} (lồng tiếng)', { name: baseName(state.sourceName) || state.sourceName }) : _t('Lồng tiếng'),
        };
        if (preview) {
            body.preview = true;
            const first = state.cues.find((c) => String(c.text || '').trim());
            body.text = first ? first.text : '';
        } else {
            body.cues = state.cues;
        }
        return body;
    }

    function validate(preview) {
        const engine = currentEngine();
        if (!state.status?.env?.ready) return _t('Chưa cài thư viện lồng tiếng — bấm "Cài thư viện lồng tiếng" ở trên.');
        if (!engine) return _t('Chọn một mô hình giọng đọc.');
        if (!engine.available) return engine.reason || _t('Mô hình này không chạy được trên máy này.');
        if (state.engine === 'f5') {
            if (!state.refPath) return _t('F5-TTS cần một tệp giọng mẫu (3-12 giây, một người nói, không nhạc nền).');
            if (!String(state.refText || '').trim()) return _t('Nhập đúng lời nói trong tệp giọng mẫu — F5-TTS cần nó để bắt chước giọng.');
        }
        if (!preview) {
            if (!state.cues.length) return _t('Nhập tệp phụ đề hoặc chọn một bộ phụ đề trên timeline trước.');
            if (!(Number(ER()?.timelineDuration?.()) > 0)) return _t('Timeline chưa có video nào. Thêm video vào lane chính trước — lồng tiếng được đặt theo mốc thời gian của timeline.');
        }
        return '';
    }

    async function start(preview) {
        if (state.busy) return;
        const problem = validate(preview);
        if (problem) { state.lastError = problem; repaint(); return; }
        state.busy = true;
        state.lastError = '';
        state.lastNotes = [];
        state.jobKind = preview ? 'preview' : 'dub';
        state.job = { state: 'queued', stage: 'queued', done: 0, total: preview ? 1 : state.cues.length, message: _t('Đang khởi động máy đọc…') };
        savePrefs();
        repaint();
        // Lượt đầu có thể phải tải model -> để thanh trạng thái hỏi dồn ngay.
        window.ModelDownloadStatus?.kick();
        try {
            state.job = await api('POST', '/dubbing/jobs', jobBody(preview));
            schedulePoll();
        } catch (error) {
            state.busy = false;
            state.job = null;
            state.lastError = error.message || String(error);
            if (error.status === 409) refreshStatus();
            repaint();
        }
    }

    function schedulePoll() {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, POLL_MS);
    }

    async function poll() {
        const id = state.job?.job_id;
        if (!id) return;
        try {
            const job = await api('GET', `/dubbing/jobs/${encodeURIComponent(id)}`);
            state.job = job;
            if (job.stage === 'models') window.ModelDownloadStatus?.kick();
            if (job.state === 'done') { await finish(job); return; }
            if (job.state === 'error' || job.state === 'cancelled') {
                state.busy = false;
                if (job.state === 'error') state.lastError = job.error || _t('Lồng tiếng thất bại.');
                refreshStatus();
                repaint();
                return;
            }
        } catch (error) {
            state.busy = false;
            state.lastError = error.message || String(error);
            repaint();
            return;
        }
        repaint();
        schedulePoll();
    }

    async function finish(job) {
        const result = job.result || {};
        try {
            if (state.jobKind === 'preview') {
                playPreview(result.full?.url);
                return;
            }
            const offset = timeOffset();
            const entries = state.split
                ? (result.clips || []).filter((c) => c.path).map((c) => ({ path: c.path, start: c.start + offset, duration: c.duration }))
                : [{ path: result.full?.path, start: (Number(result.full?.start) || 0) + offset, duration: result.full?.duration }];
            const placed = await ER().addDubbingAudio(entries, { sourceKey: sourceKey(), replace: state.replace });
            const notes = [...(job.warnings || [])];
            const skipped = result.skipped || {};
            const skippedCount = Object.values(skipped).reduce((a, b) => a + (Number(b) || 0), 0);
            if (skippedCount) notes.push(_t('{n} câu không đọc (rỗng, chỉ ký hiệu hoặc chú thích nhạc)', { n: skippedCount }));
            if (placed.skipped) notes.push(_t('{n} đoạn nằm sau cuối timeline bị bỏ', { n: placed.skipped }));
            if (placed.clamped) notes.push(_t('{n} đoạn bị cắt ngắn ở cuối timeline', { n: placed.clamped }));
            const s = result.summary || {};
            if (s.sped_up) notes.push(_t('{n} câu được đọc nhanh hơn (tối đa {x}x)', { n: s.sped_up, x: s.max_speed }));
            state.lastNotes = notes;
            toast(_t('Đã lồng tiếng {n} câu lên lane "Lồng tiếng". Ctrl+Z hoàn tác.', { n: s.count || 0 }), 'info');
        } catch (error) {
            state.lastError = error.message || String(error);
        } finally {
            state.busy = false;
            refreshStatus();
            repaint();
        }
    }

    function playPreview(url) {
        if (!url) return;
        try {
            if (previewAudio) previewAudio.pause();
            previewAudio = new Audio(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`);
            previewAudio.play().catch(() => {});
        } catch (_) { /* no-op */ }
    }

    async function cancel() {
        const id = state.job?.job_id;
        if (!id) return;
        try { await api('POST', `/dubbing/jobs/${encodeURIComponent(id)}/cancel`); } catch (_) { /* poll sẽ thấy */ }
    }

    // ── Giao diện ───────────────────────────────────────────────────────────

    function injectStyle() {
        AUTO()?.injectStyle?.();   // các lớp .edit-sub-* dùng chung
        if (document.getElementById('dubbing-style')) return;
        const el = document.createElement('style');
        el.id = 'dubbing-style';
        el.textContent = `
            .edit-dub-drop { min-height: 96px; flex: 0 0 auto; }
            .edit-dub-drop.is-dragover { border-color: var(--primary); background: rgba(255,176,32,0.08); }
            .edit-dub-source { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
                padding: 8px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; }
            .edit-dub-source b { font-size: 12px; overflow-wrap: anywhere; }
            .edit-dub-source span { font-size: 10px; opacity: 0.6; white-space: nowrap; }
            .edit-dub-row { display: flex; gap: 8px; }
            .edit-dub-row > * { flex: 1; min-width: 0; }
            .edit-dub-ref { font-size: 11px; opacity: 0.8; overflow-wrap: anywhere; }
            textarea.edit-sub-input { resize: vertical; min-height: 52px; font-family: inherit; }
            .edit-dub-toggle { background: transparent; border: 0; padding: 0; color: inherit; font: inherit;
                font-size: 11px; opacity: 0.75; cursor: pointer; text-align: left; }
            .edit-dub-toggle:hover { opacity: 1; }
            .edit-dub-setup { padding: 8px; border: 1px dashed rgba(255,176,32,0.45); border-radius: 6px; }
        `;
        document.head.insertBefore(el, document.getElementById('lumenSkin'));
    }

    function renderSetupHtml() {
        const env = state.status?.env;
        if (!state.status) {
            return state.statusError
                ? `<div class="edit-sub-error">${esc(state.statusError)}</div>`
                : `<div class="edit-sub-hint">${_t('Đang kiểm tra môi trường lồng tiếng…')}</div>`;
        }
        if (env.ready) return '';
        return `
            <div class="edit-sub-block edit-dub-setup">
                <div class="edit-sub-warn">${_t('Lồng tiếng cần cài thêm thư viện Python (F5-TTS, VieNeu-TTS — khoảng 1,5 GB, chỉ một lần).')}</div>
                <div class="edit-sub-actions">
                    <button class="btn btn-primary" type="button" data-dub-setup ${env.setup_in_progress ? 'disabled' : ''}>
                        ${env.setup_in_progress ? _t('Đang cài… (xem thanh trạng thái)') : _t('Cài thư viện lồng tiếng')}
                    </button>
                </div>
                ${env.setup_error ? `<div class="edit-sub-error">${esc(env.setup_error).replace(/\n/g, '<br>')}</div>` : ''}
            </div>`;
    }

    function renderSourceHtml() {
        const sets = timelineSets();
        const accept = SF()?.ACCEPT || '.srt,.vtt,.ass,.ssa,.xml,.ttml,.dfxp,.lrc,.sbv';
        const rows = state.showCues ? state.cues.slice(0, 300).map((cue) => `
            <button type="button" class="edit-sub-cue" data-sub-seek="${Number(cue.start) + timeOffset()}">
                <time>${clock(Number(cue.start) + timeOffset())}</time><span>${esc(cue.text)}</span>
            </button>`).join('') : '';
        return `
            <div class="edit-sub-block">
                <div class="edit-sub-label">${_t('Phụ đề nguồn')}</div>
                <button class="edit-import-drop edit-dub-drop" type="button" data-dub-pick ${state.busy ? 'disabled' : ''}>
                    <span class="edit-import-drop-ico"><svg class="btn-ico"><use href="#ic-plus"/></svg></span>
                    <span class="edit-import-drop-title">${_t('Nhập tệp phụ đề')}</span>
                    <span class="edit-import-drop-sub">${_t('.srt .vtt .ass .xml .lrc .sbv — bấm hoặc kéo thả vào đây')}</span>
                </button>
                <input type="file" id="dubFileInput" accept="${esc(accept)}" hidden>
                ${sets.length ? `
                    <select class="edit-sub-input" data-dub-set ${state.busy ? 'disabled' : ''}>
                        <option value="">${_t('…hoặc dùng bộ phụ đề trên timeline')}</option>
                        ${sets.map((s) => `<option value="${esc(s.key)}"${s.key === state.source ? ' selected' : ''}>${esc(s.name)} · ${esc(_t('{n} câu', { n: s.cues.length }))}</option>`).join('')}
                    </select>` : ''}
                ${state.cues.length ? `
                    <div class="edit-dub-source">
                        <b title="${esc(state.sourceName)}">${esc(state.sourceName)}</b>
                        <span>${esc(_t('{n} câu', { n: state.cues.length }))} · ${clock(state.cues[0].start)}–${clock(state.cues[state.cues.length - 1].end)}</span>
                    </div>
                    ${state.fileNotes ? `<div class="edit-sub-hint">${esc(state.fileNotes)}</div>` : ''}
                    <button type="button" class="edit-dub-toggle" data-dub-cues>${state.showCues ? `▾ ${_t('Ẩn danh sách câu')}` : `▸ ${_t('Xem danh sách câu')}`}</button>
                    ${rows ? `<div class="edit-sub-list">${rows}</div>` : ''}` : ''}
                ${state.source === 'file' ? `
                    <label class="edit-sub-label" for="dubStart">${_t('Bắt đầu từ')}</label>
                    <select id="dubStart" class="edit-sub-input" ${state.busy ? 'disabled' : ''}>
                        ${START_OPTIONS.map((o) => `<option value="${o.id}"${o.id === state.startAt ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
                    </select>` : ''}
            </div>`;
    }

    function engineOptionLabel(engine) {
        if (!engine.available) return `${engine.label} — ${_t('không hỗ trợ trên máy này')}`;
        if (!engineModelsReady(engine)) {
            return engine.size_mb
                ? `${engine.label} — ${_t('tải ~{size} lần đầu', { size: engine.size_mb >= 1000 ? `${(engine.size_mb / 1000).toFixed(1)} GB` : `${engine.size_mb} MB` })}`
                : engine.label;
        }
        return engine.label;
    }

    function renderVoiceHtml() {
        const list = engines();
        const engine = currentEngine();
        const disabled = state.busy ? 'disabled' : '';
        let voiceHtml = '';
        if (engine && state.engine === 'vieneu') {
            const voices = engine.voices?.length ? engine.voices : ['Ly'];
            voiceHtml = `
                <label class="edit-sub-label" for="dubVoice">${_t('Giọng')}</label>
                <select id="dubVoice" class="edit-sub-input" ${disabled}>
                    ${voices.map((v) => `<option value="${esc(v)}"${v === state.voice ? ' selected' : ''}>${esc(v)}</option>`).join('')}
                </select>`;
        } else if (engine && state.engine === 'f5') {
            voiceHtml = `
                <div class="edit-sub-hint">${_t('F5-TTS bắt chước giọng từ một đoạn thu mẫu 3-12 giây: một người nói, rõ, không nhạc nền.')}</div>
                <div class="edit-dub-row">
                    <button class="btn btn-secondary" type="button" data-dub-ref ${disabled}>${state.refPath ? _t('Đổi giọng mẫu…') : _t('Chọn giọng mẫu…')}</button>
                </div>
                <input type="file" id="dubRefInput" accept=".wav,.mp3,.m4a,.flac" hidden>
                ${state.refPath ? `<div class="edit-dub-ref" title="${esc(state.refPath)}">${esc(state.refPath.replace(/^.*[\\/]/, ''))}</div>` : ''}
                <label class="edit-sub-label" for="dubRefText">${_t('Lời trong giọng mẫu')}</label>
                <textarea id="dubRefText" class="edit-sub-input" rows="2" placeholder="${esc(_t('Gõ chính xác những gì người trong tệp mẫu nói'))}" ${disabled}>${esc(state.refText)}</textarea>`;
        } else if (engine && state.engine === 'voxcpm') {
            voiceHtml = `
                <label class="edit-sub-label" for="dubDescribe">${_t('Mô tả giọng')}</label>
                <input id="dubDescribe" class="edit-sub-input" type="text" value="${esc(state.describe)}" placeholder="${esc(_t('Ví dụ: giọng nữ trẻ, ấm, đọc chậm'))}" ${disabled}>`;
        }
        return `
            <div class="edit-sub-block">
                <label class="edit-sub-label" for="dubEngine">${_t('Mô hình giọng đọc')}</label>
                <select id="dubEngine" class="edit-sub-input" ${disabled}>
                    ${list.map((e) => `<option value="${esc(e.id)}"${e.id === state.engine ? ' selected' : ''}${e.available ? '' : ' disabled'}>${esc(engineOptionLabel(e))}</option>`).join('')}
                </select>
                ${engine && !engineModelsReady(engine) && engine.available ? `<div class="edit-sub-hint">${_t('Lần đầu dùng sẽ tải mô hình — tiến trình hiện ở góc trái thanh trạng thái.')}</div>` : ''}
                ${voiceHtml}
                <label class="edit-sub-label" for="dubSpeed">${_t('Tốc độ đọc')} · ${state.speed.toFixed(2)}x</label>
                <input id="dubSpeed" type="range" min="0.8" max="1.3" step="0.05" value="${state.speed}" ${disabled}>
                <div class="edit-sub-actions">
                    <button class="btn btn-secondary" type="button" data-dub-preview ${state.busy ? 'disabled' : ''}>${_t('Nghe thử')}</button>
                </div>
            </div>`;
    }

    function renderTimingHtml() {
        const mode = TIMING_MODES.find((m) => m.id === state.timingMode) || TIMING_MODES[0];
        const disabled = state.busy ? 'disabled' : '';
        return `
            <div class="edit-sub-block">
                <label class="edit-sub-label" for="dubTiming">${_t('Khớp thời gian')}</label>
                <select id="dubTiming" class="edit-sub-input" ${disabled}>
                    ${TIMING_MODES.map((m) => `<option value="${m.id}"${m.id === mode.id ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
                </select>
                <div class="edit-sub-hint">${esc(mode.hint)}</div>
                ${mode.id === 'auto_fit' ? `
                    <label class="edit-sub-label" for="dubMaxSpeed">${_t('Tăng tốc tối đa')}</label>
                    <select id="dubMaxSpeed" class="edit-sub-input" ${disabled}>
                        ${MAX_SPEEDS.map((v) => `<option value="${v}"${Math.abs(v - state.maxSpeed) < 1e-6 ? ' selected' : ''}>${v}x</option>`).join('')}
                    </select>` : ''}
                <label class="edit-sub-check"><input type="checkbox" data-dub-split ${state.split ? 'checked' : ''} ${disabled}><span>${_t('Mỗi câu một clip riêng (kéo chỉnh từng câu)')}</span></label>
                <label class="edit-sub-check"><input type="checkbox" data-dub-replace ${state.replace ? 'checked' : ''} ${disabled}><span>${_t('Thay bản lồng tiếng cũ của cùng phụ đề')}</span></label>
            </div>`;
    }

    function stageText(job) {
        if (!job) return '';
        if (job.stage === 'models') return _t('Đang tải mô hình lần đầu — xem tiến trình ở góc trái thanh trạng thái.');
        if (job.stage === 'loading') return _t('Đang nạp mô hình vào bộ nhớ…');
        if (job.stage === 'synth') return state.jobKind === 'preview' ? _t('Đang đọc thử…') : _t('Đang đọc câu {done}/{total}', { done: Math.min(job.total, job.done + 1), total: job.total });
        if (job.stage === 'merge') return _t('Đang ghép và đặt lên timeline…');
        return job.message || _t('Đang khởi động máy đọc…');
    }

    function renderRunHtml() {
        const job = state.job;
        const running = state.busy && job;
        const pct = job && job.total ? Math.round((Math.min(job.done, job.total) / job.total) * 100) : 0;
        return `
            <div class="edit-sub-block">
                ${running ? `
                    <div class="edit-sub-status"><span>${esc(stageText(job))}</span><b>${pct}%</b></div>
                    <div class="edit-sub-progress"><div class="edit-sub-progress-fill" style="width:${pct}%"></div></div>
                    ${job.stage === 'synth' && job.message ? `<div class="edit-sub-hint">“${esc(job.message)}”</div>` : ''}
                    <div class="edit-sub-actions"><button class="btn btn-secondary" type="button" data-dub-cancel>${_t('Huỷ')}</button></div>` : `
                    <div class="edit-sub-actions">
                        <button class="btn btn-primary" type="button" data-dub-start ${state.cues.length ? '' : 'disabled'}>${_t('Tạo lồng tiếng')}</button>
                    </div>`}
                ${state.lastError ? `<div class="edit-sub-error">${esc(state.lastError).replace(/\n/g, '<br>')}</div>` : ''}
                ${state.lastNotes.length ? `<div class="edit-sub-warn">${state.lastNotes.map(esc).join('<br>')}</div>` : ''}
            </div>`;
    }

    function renderPaneHtml() {
        injectStyle();
        if (!state.status && !state.statusLoading) setTimeout(refreshStatus, 0);
        return `
            <div class="edit-sub-pane" data-dub-zone>
                <div class="edit-sub-block">
                    <div class="edit-sub-hint">${_t('Đọc tệp phụ đề thành giọng nói AI, đặt đúng mốc thời gian của từng câu lên lane "Lồng tiếng".')}</div>
                </div>
                ${renderSetupHtml()}
                ${renderSourceHtml()}
                ${state.status?.env?.ready ? renderVoiceHtml() + renderTimingHtml() : ''}
                ${renderRunHtml()}
            </div>`;
    }

    function repaint() {
        const body = document.getElementById('editPanelBody');
        if (!body || !body.querySelector('[data-dub-zone]')) return;
        // Giữ con trỏ trong ô đang gõ (lời giọng mẫu) qua lượt vẽ lại do poll.
        const active = document.activeElement;
        const focusId = active && body.contains(active) ? active.id : '';
        const caret = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
        const scroll = body.scrollTop;
        body.innerHTML = renderPaneHtml();
        bindPane(body);
        body.scrollTop = scroll;
        if (focusId) {
            const el = document.getElementById(focusId);
            if (el) {
                el.focus();
                if (caret && typeof el.setSelectionRange === 'function') el.setSelectionRange(caret[0], caret[1]);
            }
        }
    }

    function bindPane(body) {
        const zone = body.querySelector('[data-dub-zone]');
        if (!zone) return;
        const fileInput = zone.querySelector('#dubFileInput');
        const refInput = zone.querySelector('#dubRefInput');
        const drop = zone.querySelector('[data-dub-pick]');

        fileInput?.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            fileInput.value = '';
            importFile(file);
        });
        refInput?.addEventListener('change', () => {
            const file = refInput.files?.[0];
            refInput.value = '';
            if (file && file.path) { state.refPath = file.path; savePrefs(); repaint(); }
        });

        zone.addEventListener('click', (event) => {
            const t = event.target;
            if (t.closest('[data-dub-pick]')) { if (!state.busy) fileInput?.click(); return; }
            if (t.closest('[data-dub-setup]')) { startSetup(); return; }
            if (t.closest('[data-dub-ref]')) { pickReference(refInput); return; }
            if (t.closest('[data-dub-preview]')) { start(true); return; }
            if (t.closest('[data-dub-start]')) { start(false); return; }
            if (t.closest('[data-dub-cancel]')) { cancel(); return; }
            if (t.closest('[data-dub-cues]')) { state.showCues = !state.showCues; repaint(); return; }
            const cue = t.closest('[data-sub-seek]');
            if (cue) {
                const at = Number(cue.dataset.subSeek);
                if (Number.isFinite(at) && typeof window.setVideoTimeFromTimelineTime === 'function') window.setVideoTimeFromTimelineTime(at);
            }
        });

        zone.addEventListener('change', (event) => {
            const t = event.target;
            if (t.matches('[data-dub-set]')) { if (t.value) chooseSet(t.value); return; }
            if (t.id === 'dubStart') state.startAt = t.value === 'playhead' ? 'playhead' : 'zero';
            else if (t.id === 'dubEngine') {
                state.engine = t.value;
                const engine = currentEngine();
                if (engine?.voices?.length && !engine.voices.includes(state.voice)) state.voice = engine.voices.includes('Ly') ? 'Ly' : engine.voices[0];
            } else if (t.id === 'dubVoice') state.voice = t.value;
            else if (t.id === 'dubTiming') state.timingMode = TIMING_MODES.some((m) => m.id === t.value) ? t.value : 'auto_fit';
            else if (t.id === 'dubMaxSpeed') state.maxSpeed = Number(t.value) || 1.45;
            else if (t.matches('[data-dub-split]')) state.split = !!t.checked;
            else if (t.matches('[data-dub-replace]')) state.replace = !!t.checked;
            else return;
            savePrefs();
            repaint();
        });

        zone.addEventListener('input', (event) => {
            const t = event.target;
            if (t.id === 'dubRefText') { state.refText = t.value; savePrefs(); }
            else if (t.id === 'dubDescribe') { state.describe = t.value; savePrefs(); }
            else if (t.id === 'dubSpeed') {
                state.speed = Math.max(0.8, Math.min(1.3, Number(t.value) || 1));
                const label = zone.querySelector('label[for="dubSpeed"]');
                if (label) label.textContent = `${_t('Tốc độ đọc')} · ${state.speed.toFixed(2)}x`;
                savePrefs();
            }
        });

        /* Kéo thả tệp phụ đề. Nhóm này KHÔNG nằm trong vùng nhận tệp phương tiện của
           #editPanelBody (setupPanelImportDnd chỉ nhận ở nhóm "Nhập"), nên thả ở đây chỉ có một nghĩa. */
        const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
        zone.addEventListener('dragover', (event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            drop?.classList.add('is-dragover');
        });
        zone.addEventListener('dragleave', (event) => {
            if (event.relatedTarget && zone.contains(event.relatedTarget)) return;
            drop?.classList.remove('is-dragover');
        });
        zone.addEventListener('drop', (event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            drop?.classList.remove('is-dragover');
            const files = Array.from(event.dataTransfer.files || []);
            const exts = (SF()?.EXTENSIONS || ['.srt', '.vtt', '.ass', '.ssa', '.xml', '.ttml', '.dfxp', '.lrc', '.sbv']);
            const sub = files.find((f) => exts.some((ext) => String(f.name || '').toLowerCase().endsWith(ext)));
            if (sub) importFile(sub);
            else toast(_t('Thả một tệp phụ đề (.srt, .vtt, .ass…).'), 'warning');
        });
    }

    /* Dự án mới / mở dự án khác: nguồn câu cũ không còn nghĩa. Tuỳ chọn giọng thì giữ. */
    function resetState() {
        state.source = '';
        state.sourceName = '';
        state.cues = [];
        state.fileNotes = '';
        state.showCues = false;
        state.lastError = '';
        state.lastNotes = [];
        repaint();
    }

    window.DubbingPanel = {
        renderPaneHtml,
        bindPane,
        resetState,
        refreshStatus,
        state,
        TIMING_MODES,
        // Mở ra cho test.
        importFile,
        jobBody,
        validate,
    };
}());
