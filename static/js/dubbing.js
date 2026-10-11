/* Nhóm "Lồng tiếng" của tab Âm thanh: đọc tệp phụ đề (có mốc thời gian) thành giọng nói AI rồi
 * đặt audio lên timeline ĐÚNG mốc của từng câu — hoặc (v1.1.17) đọc VĂN BẢN bất kỳ (gõ tay,
 * .txt/.md/.docx): tách câu, đọc nối tiếp với khoảng nghỉ chọn được, rồi sinh kèm phụ đề khớp
 * tiếng (bật sẵn, có ô tắt — người dùng chốt 2026-10-11).
 *
 * GIỌNG: engine mặc định VieNeu-TTS v3 Turbo (F5-TTS gỡ ở v1.1.17). Giọng dựng sẵn lọc được theo
 * phong cách đọc; giọng nhân bản lấy từ HỒ SƠ GIỌNG do Cài đặt quản lý (backend/voice-profiles.js)
 * — panel chỉ gửi id, backend tra ra tệp mẫu.
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
        { id: 'fixed_duration', label: _t('Cắt đúng khung phụ đề'), hint: _t('Mỗi câu nằm gọn trong khung của nó; phần dài hơn bị cắt đuôi.') },
    ];
    /* Khoảng nghỉ giữa hai câu khi đọc VĂN BẢN (không có mốc) — chế độ "sequential" ở
       tts/dubbing_core.py. */
    const GAPS = [0.2, 0.4, 0.6, 0.8, 1.2];
    const TEXT_ACCEPT = '.txt,.md,.markdown,.docx,.doc';
    /* Phụ đề sinh kèm khi đọc văn bản: theo luật chia đã chốt cho Auto Subtitle (42 ký tự × 2
       dòng) — câu dài hơn thì chia thành nhiều block theo tỉ lệ số ký tự. */
    const SUB_MAX_CHARS = 84;
    const DEFAULT_ENGINE = 'vieneu3';
    const DEFAULT_V3_VOICE = 'Hải Đăng';
    const MAX_SPEEDS = [1.2, 1.45, 1.7, 2.0];
    const START_OPTIONS = [
        { id: 'zero', label: _t('Đầu timeline') },
        { id: 'playhead', label: _t('Vị trí playhead') },
    ];

    const state = {
        status: null,          // GET /api/tts/status
        statusError: '',
        statusLoading: false,
        // nguồn câu: phụ đề có mốc, hoặc văn bản thường (v1.1.17)
        sourceMode: 'subtitle', // 'subtitle' | 'text'
        text: '',              // văn bản gõ/nạp (sourceMode = 'text')
        textName: '',          // tên tệp văn bản đã nạp (rỗng = gõ tay)
        gap: 0.4,              // nghỉ giữa câu (giây) khi đọc văn bản
        makeSubs: true,        // sinh phụ đề khớp tiếng khi đọc văn bản (người dùng chốt: bật sẵn)
        source: '',            // 'file' | 'set:<id>' | 'set:auto'
        sourceName: '',
        cues: [],
        fileNotes: '',
        showCues: false,
        // tuỳ chọn (nhớ giữa các lần mở — xem loadPrefs)
        engine: DEFAULT_ENGINE,
        voice: DEFAULT_V3_VOICE,
        voiceProfile: '',      // id hồ sơ giọng (Cài đặt → Hồ sơ giọng); rỗng = giọng dựng sẵn
        styleFilter: '',       // lọc danh sách giọng theo phong cách đọc
        describe: '',
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
        profiles: [],          // GET /api/voice-profiles
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
            ['engine', 'voice', 'voiceProfile', 'styleFilter', 'describe', 'timingMode', 'startAt', 'sourceMode'].forEach((k) => {
                if (typeof raw[k] === 'string') state[k] = raw[k];
            });
            ['speed', 'maxSpeed', 'gap'].forEach((k) => { if (Number.isFinite(Number(raw[k]))) state[k] = Number(raw[k]); });
            ['split', 'replace', 'makeSubs'].forEach((k) => { if (typeof raw[k] === 'boolean') state[k] = raw[k]; });
            // F5-TTS gỡ ở v1.1.17: prefs cũ trỏ vào nó -> về engine mặc định.
            if (state.engine === 'f5') { state.engine = DEFAULT_ENGINE; state.voice = DEFAULT_V3_VOICE; }
            if (state.sourceMode !== 'text') state.sourceMode = 'subtitle';
        } catch (_) { /* localStorage bị chặn: dùng mặc định */ }
    }
    function savePrefs() {
        try {
            const keep = {};
            ['engine', 'voice', 'voiceProfile', 'styleFilter', 'describe', 'speed', 'timingMode', 'maxSpeed', 'startAt', 'split', 'replace',
                'sourceMode', 'gap', 'makeSubs']
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
        await refreshProfiles({ paint: false });
        // Đang cài thư viện thì hỏi lại đều đặn để nút "Cài đặt" tự biến mất khi xong.
        clearTimeout(statusTimer);
        if (state.status?.env?.setup_in_progress) statusTimer = setTimeout(refreshStatus, 3000);
        repaint();
    }

    /* Hồ sơ giọng do Cài đặt quản lý; panel chỉ đọc. Cài đặt đổi gì thì gọi
       DubbingPanel.refreshProfiles() để danh sách ở đây khớp ngay. */
    async function refreshProfiles({ paint = true } = {}) {
        try {
            const data = await api('GET', '/voice-profiles');
            state.profiles = Array.isArray(data.profiles) ? data.profiles : [];
        } catch (_) {
            state.profiles = [];
        }
        if (state.voiceProfile && !state.profiles.some((p) => p.id === state.voiceProfile)) state.voiceProfile = '';
        if (paint) repaint();
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
        if (state.sourceMode === 'text') return `text:${(state.textName || 'typed').toLowerCase()}`;
        return state.source === 'file' ? `file:${state.sourceName.toLowerCase()}` : state.source;
    }

    // Mốc đặt lên timeline: tệp/văn bản thì cộng playhead nếu chọn; bộ trên timeline thì đã là mốc thật.
    function timeOffset() {
        const fromFile = state.sourceMode === 'text' || state.source === 'file';
        if (!fromFile || state.startAt !== 'playhead') return 0;
        return Number(ER()?.currentSequenceTime?.()) || 0;
    }

    // ── Văn bản không mốc thời gian (v1.1.17) ───────────────────────────────

    /* Tách văn bản thành câu để đọc lần lượt. Một câu = một lượt sinh của model, nên đừng để
       câu quá dài (model dễ lảm nhảm): cắt tiếp ở dấu phẩy rồi ở khoảng trắng khi vượt trần.
       Xuống dòng luôn là ranh giới (tiêu đề, gạch đầu dòng không có dấu chấm). */
    const SENTENCE_MAX = 220;
    function splitLong(piece) {
        if (piece.length <= SENTENCE_MAX) return [piece];
        const out = [];
        let rest = piece;
        while (rest.length > SENTENCE_MAX) {
            const head = rest.slice(0, SENTENCE_MAX);
            let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '));
            if (cut < SENTENCE_MAX * 0.4) cut = head.lastIndexOf(' ');
            if (cut <= 0) cut = SENTENCE_MAX;
            out.push(rest.slice(0, cut + 1).trim());
            rest = rest.slice(cut + 1).trim();
        }
        if (rest) out.push(rest);
        return out;
    }
    function splitSentences(text) {
        const out = [];
        String(text || '').split(/\r?\n/).forEach((line) => {
            const clean = line.replace(/\s+/g, ' ').trim();
            if (!clean) return;
            clean.split(/(?<=[.!?…。！？])\s+/).forEach((sentence) => {
                const s = sentence.trim();
                if (s) out.push(...splitLong(s));
            });
        });
        return out;
    }
    /* Câu giả cho server: chế độ "sequential" bỏ qua mốc, chỉ cần thứ tự (start tăng dần,
       end > start để normalize_cues giữ lại). */
    function textCues() {
        return splitSentences(state.text).map((sentence, i) => ({ start: i, end: i + 1, text: sentence }));
    }

    /* Đọc tệp văn bản: .txt chữ thuần, .md bỏ cú pháp Markdown (cùng bộ đọc với tab Kịch bản),
       .docx qua mammoth. .doc (Word 97-2003) mammoth không đọc được -> báo lưu sang .docx. */
    async function importTextFile(file) {
        if (!file) return;
        const name = String(file.name || '');
        const ext = name.split('.').pop().toLowerCase();
        try {
            let text = '';
            if (ext === 'docx' || ext === 'doc') {
                if (!window.mammoth) throw new Error(_t('Chưa nạp được {file}.', { file: 'mammoth' }));
                try {
                    const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
                    text = String(result.value || '');
                } catch (_) {
                    throw new Error(_t('Không đọc được tệp Word này. Tệp .doc (Word 97-2003) hãy mở bằng Word rồi lưu sang .docx.'));
                }
            } else if (ext === 'md' || ext === 'markdown') {
                const raw = await file.text();
                text = window.ScriptMarkdown?.normalizeMarkdownScript
                    ? String(window.ScriptMarkdown.normalizeMarkdownScript(raw).clean_text || '')
                    : raw;
            } else if (ext === 'txt') {
                text = await file.text();
            } else {
                throw new Error(_t('Chỉ nhận tệp .txt, .md, .docx.'));
            }
            if (!text.trim()) throw new Error(_t('Tệp không có chữ nào để đọc.'));
            state.text = text.replace(/\r\n/g, '\n').trim();
            state.textName = name;
            state.lastError = '';
        } catch (error) {
            state.lastError = `${name}: ${error?.message || error}`;
        }
        repaint();
    }

    /* Câu đã đọc -> block phụ đề. Câu dài hơn SUB_MAX_CHARS chia thành nhiều block, thời lượng
       chia theo số ký tự (giọng đọc đều nên tỉ lệ này sát thực tế). */
    function subtitleCuesFromClips(clips, offset) {
        const out = [];
        (clips || []).forEach((clip) => {
            const text = String(clip.text || '').trim();
            const start = Number(clip.start) + offset;
            const duration = Number(clip.duration) || 0;
            if (!text || !(duration > 0)) return;
            const parts = [];
            let rest = text;
            while (rest.length > SUB_MAX_CHARS) {
                let cut = rest.lastIndexOf(' ', SUB_MAX_CHARS);
                if (cut <= 0) cut = SUB_MAX_CHARS;
                parts.push(rest.slice(0, cut).trim());
                rest = rest.slice(cut).trim();
            }
            if (rest) parts.push(rest);
            const total = parts.reduce((sum, p) => sum + p.length, 0) || 1;
            let at = start;
            parts.forEach((part) => {
                const len = duration * (part.length / total);
                out.push({ start: at, end: at + len, text: part });
                at += len;
            });
        });
        return out;
    }

    // ── Chạy job ────────────────────────────────────────────────────────────

    // Câu sẽ đọc: phụ đề (có mốc) hoặc văn bản đã tách câu.
    function activeCues() {
        return state.sourceMode === 'text' ? textCues() : state.cues;
    }

    function activeName() {
        if (state.sourceMode === 'text') return state.textName || _t('Văn bản');
        return state.sourceName;
    }

    // Engine đang chọn có nhận hồ sơ giọng không (server báo `clone`).
    function usesProfile() {
        return !!(state.voiceProfile && currentEngine()?.clone);
    }

    function jobBody(preview) {
        const text = state.sourceMode === 'text';
        const name = activeName();
        const body = {
            engine: state.engine,
            voice: state.engine === 'voxcpm' ? state.describe : (usesProfile() ? '' : state.voice),
            speed: state.speed,
            timing_mode: text ? 'sequential' : state.timingMode,
            max_speed: state.maxSpeed,
            split_clips: state.split,
            name: name ? _t('{name} (lồng tiếng)', { name: baseName(name) || name }) : _t('Lồng tiếng'),
        };
        if (text) body.gap = state.gap;
        if (usesProfile()) body.voice_profile = state.voiceProfile;
        if (preview) {
            body.preview = true;
            const first = activeCues().find((c) => String(c.text || '').trim());
            body.text = first ? first.text : '';
        } else {
            body.cues = activeCues();
        }
        return body;
    }

    function validate(preview) {
        const engine = currentEngine();
        if (!state.status?.env?.ready) return _t('Chưa cài thư viện lồng tiếng — bấm "Cài thư viện lồng tiếng" ở trên.');
        if (!engine) return _t('Chọn một mô hình giọng đọc.');
        if (!engine.available) return engine.reason || _t('Mô hình này không chạy được trên máy này.');
        // Nghe thử không cần câu nào: server đọc câu mẫu (PREVIEW_TEXT) khi text rỗng.
        if (!preview) {
            if (!activeCues().length) {
                return state.sourceMode === 'text'
                    ? _t('Gõ hoặc nạp văn bản cần đọc trước.')
                    : _t('Nhập tệp phụ đề hoặc chọn một bộ phụ đề trên timeline trước.');
            }
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
        state.job = { state: 'queued', stage: 'queued', done: 0, total: preview ? 1 : activeCues().length, message: _t('Đang khởi động máy đọc…') };
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
            const textMode = state.sourceMode === 'text';
            const entries = state.split
                ? (result.clips || []).filter((c) => c.path).map((c) => ({ path: c.path, start: c.start + offset, duration: c.duration }))
                : [{ path: result.full?.path, start: (Number(result.full?.start) || 0) + offset, duration: result.full?.duration }];
            const placed = await ER().addDubbingAudio(entries, { sourceKey: sourceKey(), replace: state.replace });
            const notes = [...(job.warnings || [])];
            // Văn bản không có phụ đề sẵn -> dựng phụ đề khớp đúng tiếng vừa đọc (người dùng chốt
            // 2026-10-11: bật sẵn, có ô tắt). Đi đường Local Subtitle nên sửa/xuất SRT/đổi kiểu
            // như mọi bộ phụ đề khác; lồng lại cùng tên thì bộ cũ được thay.
            if (textMode && state.makeSubs) {
                const subs = subtitleCuesFromClips(result.clips, offset);
                const LS = window.LocalSubtitlePanel;
                if (subs.length && LS?.importCues) {
                    const done = LS.importCues(subs, { fileName: `${baseName(activeName()) || _t('Văn bản')} (${_t('lồng tiếng')}).srt` });
                    notes.push(_t('Đã tạo {n} phụ đề khớp tiếng (tab Văn bản → Local Subtitle)', { n: done.count }));
                }
            }
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
            .edit-dub-row > [data-dub-text-clear] { flex: 0 0 auto; }
            .edit-dub-ref { font-size: 11px; opacity: 0.8; overflow-wrap: anywhere; }
            textarea.edit-sub-input { resize: vertical; min-height: 52px; font-family: inherit; }
            .edit-dub-toggle { background: transparent; border: 0; padding: 0; color: inherit; font: inherit;
                font-size: 11px; opacity: 0.75; cursor: pointer; text-align: left; }
            .edit-dub-toggle:hover { opacity: 1; }
            .edit-dub-setup { padding: 8px; border: 1px dashed rgba(255,176,32,0.45); border-radius: 6px; }
            .edit-dub-modes { display: flex; gap: 4px; padding: 2px; border-radius: 7px; background: rgba(255,255,255,0.05); }
            .edit-dub-mode { flex: 1; min-width: 0; padding: 6px 8px; border: 0; border-radius: 5px; background: transparent;
                color: inherit; font: inherit; font-size: 11px; opacity: 0.7; cursor: pointer; }
            .edit-dub-mode:hover:not(:disabled) { opacity: 1; }
            .edit-dub-mode.is-active { background: rgba(255,176,32,0.16); color: var(--primary); opacity: 1; font-weight: 600; }
            textarea.edit-dub-text { min-height: 120px; }
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
                <div class="edit-sub-warn">${String(env.torch_variant || '').startsWith('cu')
                    ? _t('Lồng tiếng cần cài thêm thư viện Python (VieNeu-TTS + bản torch chạy GPU NVIDIA — khoảng 3,5 GB, chỉ một lần). Bản cũ đã cài cũng phải cài lại một lần để chạy được GPU.')
                    : _t('Lồng tiếng cần cài thêm thư viện Python (VieNeu-TTS — khoảng 1 GB, chỉ một lần).')}</div>
                <div class="edit-sub-actions">
                    <button class="btn btn-primary" type="button" data-dub-setup ${env.setup_in_progress ? 'disabled' : ''}>
                        ${env.setup_in_progress ? _t('Đang cài… (xem thanh trạng thái)') : _t('Cài thư viện lồng tiếng')}
                    </button>
                </div>
                ${env.setup_error ? `<div class="edit-sub-error">${esc(env.setup_error).replace(/\n/g, '<br>')}</div>` : ''}
            </div>`;
    }

    function renderModeHtml() {
        const disabled = state.busy ? 'disabled' : '';
        const tab = (id, label) => `<button type="button" class="edit-dub-mode${state.sourceMode === id ? ' is-active' : ''}" data-dub-mode="${id}" ${disabled}>${esc(label)}</button>`;
        return `<div class="edit-dub-modes" role="tablist">${tab('subtitle', _t('Phụ đề (có mốc thời gian)'))}${tab('text', _t('Văn bản'))}</div>`;
    }

    function renderTextSourceHtml() {
        const disabled = state.busy ? 'disabled' : '';
        const cues = textCues();
        return `
            <div class="edit-sub-block">
                <div class="edit-sub-label">${_t('Văn bản cần đọc')}</div>
                <textarea id="dubText" class="edit-sub-input edit-dub-text" rows="7" placeholder="${esc(_t('Gõ hoặc dán văn bản vào đây, hoặc nạp tệp .txt / .md / .docx'))}" ${disabled}>${esc(state.text)}</textarea>
                <div class="edit-dub-row">
                    <button class="btn btn-secondary" type="button" data-dub-text-pick ${disabled}>${_t('Nạp tệp văn bản…')}</button>
                    ${state.text ? `<button class="btn btn-secondary" type="button" data-dub-text-clear ${disabled}>${_t('Xoá')}</button>` : ''}
                </div>
                <input type="file" id="dubTextInput" accept="${TEXT_ACCEPT}" hidden>
                <div class="edit-sub-hint" data-dub-text-count>${state.textName ? `${esc(state.textName)} · ` : ''}${esc(_t('{n} câu', { n: cues.length }))}</div>
                <label class="edit-sub-label" for="dubGap">${_t('Nghỉ giữa các câu')}</label>
                <select id="dubGap" class="edit-sub-input" ${disabled}>
                    ${GAPS.map((v) => `<option value="${v}"${Math.abs(v - state.gap) < 1e-6 ? ' selected' : ''}>${String(v).replace('.', ',')} s</option>`).join('')}
                </select>
                <label class="edit-sub-label" for="dubStart">${_t('Bắt đầu từ')}</label>
                <select id="dubStart" class="edit-sub-input" ${disabled}>
                    ${START_OPTIONS.map((o) => `<option value="${o.id}"${o.id === state.startAt ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
                </select>
                <label class="edit-sub-check"><input type="checkbox" data-dub-subs ${state.makeSubs ? 'checked' : ''} ${disabled}><span>${_t('Tạo phụ đề khớp với giọng đọc')}</span></label>
            </div>`;
    }

    function renderSourceHtml() {
        if (state.sourceMode === 'text') return renderTextSourceHtml();
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

    /* "Nam · Bắc · Phong cách tin tức" -> "Phong cách tin tức" (VieNeu v3 ghi phong cách đọc ở cuối
       mô tả giọng). Không có thì rỗng. */
    function voiceStyle(detail) {
        const parts = String(detail?.description || '').split('·').map((x) => x.trim()).filter(Boolean);
        const last = parts[parts.length - 1] || '';
        return /^(Phong cách|Giọng đọc)/i.test(last) ? last : '';
    }

    function voiceDetails(engine) {
        if (Array.isArray(engine?.voice_details) && engine.voice_details.length) return engine.voice_details;
        return (engine?.voices || []).map((v) => ({ id: v, label: v, description: '' }));
    }

    /* Giọng dựng sẵn (lọc được theo phong cách đọc) + hồ sơ giọng nhân bản của người dùng
       (chỉ với engine nhận giọng mẫu — server báo `clone`). */
    function renderPresetVoicesHtml(engine, disabled) {
        const details = voiceDetails(engine);
        const styles = [...new Set(details.map(voiceStyle).filter(Boolean))];
        const shown = state.styleFilter ? details.filter((d) => voiceStyle(d) === state.styleFilter) : details;
        const canClone = !!engine.clone;
        const selected = canClone && state.voiceProfile ? `profile:${state.voiceProfile}` : state.voice;
        const presetOptions = shown.map((d) => `<option value="${esc(d.id)}"${d.id === selected ? ' selected' : ''}>${esc(d.label)}${d.description ? ` — ${esc(d.description)}` : ''}</option>`).join('');
        const profileOptions = canClone ? state.profiles.map((p) => `<option value="profile:${esc(p.id)}"${`profile:${p.id}` === selected ? ' selected' : ''}>${esc(p.name)}</option>`).join('') : '';
        // Giọng đang chọn bị bộ lọc giấu đi -> vẫn phải có trong danh sách, nếu không select tự nhảy sang giọng khác.
        const hiddenSelected = !selected.startsWith('profile:') && !shown.some((d) => d.id === selected) && details.some((d) => d.id === selected)
            ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : '';
        return `
            ${styles.length > 1 ? `
                <label class="edit-sub-label" for="dubStyle">${_t('Phong cách đọc')}</label>
                <select id="dubStyle" class="edit-sub-input" ${disabled}>
                    <option value="">${_t('Tất cả phong cách')}</option>
                    ${styles.map((st) => `<option value="${esc(st)}"${st === state.styleFilter ? ' selected' : ''}>${esc(st)}</option>`).join('')}
                </select>` : ''}
            <label class="edit-sub-label" for="dubVoice">${_t('Giọng')}</label>
            <select id="dubVoice" class="edit-sub-input" ${disabled}>
                ${profileOptions ? `<optgroup label="${esc(_t('Hồ sơ giọng của bạn (nhân bản)'))}">${profileOptions}</optgroup>` : ''}
                <optgroup label="${esc(_t('Giọng có sẵn'))}">${hiddenSelected}${presetOptions}</optgroup>
            </select>
            ${canClone ? `
                <div class="edit-dub-row">
                    <button class="btn btn-secondary" type="button" data-dub-profiles>${state.profiles.length ? _t('Quản lý hồ sơ giọng…') : _t('Tạo hồ sơ giọng nhân bản…')}</button>
                </div>` : ''}`;
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
        if (engine && (state.engine === 'vieneu3' || state.engine === 'vieneu')) {
            voiceHtml = renderPresetVoicesHtml(engine, disabled);
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
        const checks = `
                <label class="edit-sub-check"><input type="checkbox" data-dub-split ${state.split ? 'checked' : ''} ${disabled}><span>${_t('Mỗi câu một clip riêng (kéo chỉnh từng câu)')}</span></label>
                <label class="edit-sub-check"><input type="checkbox" data-dub-replace ${state.replace ? 'checked' : ''} ${disabled}><span>${state.sourceMode === 'text' ? _t('Thay bản lồng tiếng cũ của cùng văn bản') : _t('Thay bản lồng tiếng cũ của cùng phụ đề')}</span></label>`;
        // Văn bản không có mốc: đọc nối tiếp (khoảng nghỉ chọn ở khối Văn bản), không có gì để khớp.
        if (state.sourceMode === 'text') return `<div class="edit-sub-block">${checks}</div>`;
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
                ${checks}
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
                        <button class="btn btn-primary" type="button" data-dub-start ${activeCues().length ? '' : 'disabled'}>${_t('Tạo lồng tiếng')}</button>
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
                    <div class="edit-sub-hint">${state.sourceMode === 'text'
                        ? _t('Đọc văn bản bất kỳ thành giọng nói AI, các câu nối tiếp nhau trên lane "Lồng tiếng".')
                        : _t('Đọc tệp phụ đề thành giọng nói AI, đặt đúng mốc thời gian của từng câu lên lane "Lồng tiếng".')}</div>
                </div>
                ${renderSetupHtml()}
                ${renderModeHtml()}
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
        const textInput = zone.querySelector('#dubTextInput');
        const drop = zone.querySelector('[data-dub-pick]') || zone.querySelector('#dubText');

        fileInput?.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            fileInput.value = '';
            importFile(file);
        });
        textInput?.addEventListener('change', () => {
            const file = textInput.files?.[0];
            textInput.value = '';
            importTextFile(file);
        });

        zone.addEventListener('click', (event) => {
            const t = event.target;
            if (t.closest('[data-dub-pick]')) { if (!state.busy) fileInput?.click(); return; }
            if (t.closest('[data-dub-setup]')) { startSetup(); return; }
            const modeBtn = t.closest('[data-dub-mode]');
            if (modeBtn) {
                if (state.busy) return;
                state.sourceMode = modeBtn.dataset.dubMode === 'text' ? 'text' : 'subtitle';
                state.lastError = '';
                state.lastNotes = [];
                savePrefs();
                repaint();
                return;
            }
            if (t.closest('[data-dub-text-pick]')) { textInput?.click(); return; }
            if (t.closest('[data-dub-text-clear]')) { state.text = ''; state.textName = ''; repaint(); return; }
            if (t.closest('[data-dub-profiles]')) {
                if (window.SettingsPanel?.open) window.SettingsPanel.open('voices');
                return;
            }
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
                if (engine?.voices?.length && !engine.voices.includes(state.voice)) {
                    const fallback = state.engine === 'vieneu3' ? DEFAULT_V3_VOICE : 'Ly';
                    state.voice = engine.voices.includes(fallback) ? fallback : engine.voices[0];
                }
                state.styleFilter = '';
            } else if (t.id === 'dubVoice') {
                if (t.value.startsWith('profile:')) state.voiceProfile = t.value.slice('profile:'.length);
                else { state.voiceProfile = ''; state.voice = t.value; }
            } else if (t.id === 'dubStyle') state.styleFilter = t.value;
            else if (t.id === 'dubGap') state.gap = Number(t.value) || 0.4;
            else if (t.matches('[data-dub-subs]')) state.makeSubs = !!t.checked;
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
            if (t.id === 'dubText') {
                // Gõ tay: chỉ cập nhật dòng đếm câu, KHÔNG vẽ lại (vẽ lại cướp con trỏ).
                state.text = t.value;
                if (!t.value.trim()) state.textName = '';
                const count = zone.querySelector('[data-dub-text-count]');
                if (count) count.textContent = `${state.textName ? `${state.textName} · ` : ''}${_t('{n} câu', { n: textCues().length })}`;
                const startBtn = zone.querySelector('[data-dub-start]');
                if (startBtn) startBtn.disabled = !textCues().length;
            } else if (t.id === 'dubDescribe') { state.describe = t.value; savePrefs(); }
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
            if (state.sourceMode === 'text') {
                const doc = files.find((f) => TEXT_ACCEPT.split(',').some((ext) => String(f.name || '').toLowerCase().endsWith(ext)));
                if (doc) importTextFile(doc);
                else toast(_t('Thả một tệp văn bản (.txt, .md, .docx).'), 'warning');
                return;
            }
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
        refreshProfiles,
        state,
        TIMING_MODES,
        // Mở ra cho test.
        splitSentences,
        textCues,
        subtitleCuesFromClips,
        importFile,
        jobBody,
        validate,
    };
}());
