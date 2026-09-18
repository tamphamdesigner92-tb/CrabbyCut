/* Nhóm "Auto Subtitle" của tab Âm thanh: bóc băng audio timeline bằng Whisper rồi
 * rải thành block phụ đề, kiểu CapCut.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * BA QUYẾT ĐỊNH GỐC, ĐỌC TRƯỚC KHI SỬA
 *
 * 1. PHỤ ĐỀ LÀ BLOCK TEXT THẬT, không phải một lớp vẽ riêng.
 *    Đổi lại được NGUYÊN VẸN: preview, xuất video, keyframe, kéo/sửa/xoá từng
 *    câu, ghi vào .crab — tất cả đã chạy tốt cho `type:'text'`. Dựng một "lớp phụ
 *    đề" riêng thì phải rà lại từng đường đó, và chỗ bỏ sót sẽ hỏng ÂM THẦM ở khâu
 *    xuất. Đây cũng là lý do phụ đề trông GIỐNG HỆT phụ đề của "Tạo video AI":
 *    cùng đi qua ER.addTextItem() nên cùng style mặc định, cùng luật tối đa 2 dòng.
 *
 * 2. MỐC THỜI GIAN LÀ MỐC TIMELINE, KHÔNG PHẢI MỐC FILE NGUỒN.
 *    backend/subtitle-jobs.js trộn audio theo đúng trục timeline (mỗi mảnh adelay
 *    về đúng chỗ nó phát), nên mốc Whisper trả về dùng thẳng được. Không có phép
 *    quy đổi nào ở đây — và đó là chủ ý: mọi phép quy đổi mốc đều là một chỗ để lệch.
 *
 * 3b. (WINDOWS) Luật chia phụ đề `chunkSpansForScene` nằm NGAY TRONG tệp này. Trên
 *    nhánh macOS nó sống ở `ai-video-panel.js` và dùng chung với "Tạo video AI" —
 *    nhánh Windows chưa có tệp đó. `cuesFromSegments` vẫn ưu tiên bản của
 *    AiVideoPanel nếu có, nên không bao giờ có hai bản luật cùng chạy một lúc.
 *
 * 3. DỮ LIỆU PHỤ ĐỀ ĐI THEO DỰ ÁN QUA `EditingRuntime` (subtitleState), không có
 *    kho riêng. Nhờ vậy .crab, undo/redo và "Dự án mới" tự đúng, không phải nhớ
 *    thêm một đường lưu thứ hai. Tệp .srt là BẢN XUẤT của state đó, không phải
 *    nguồn sự thật — mất .srt thì Lưu lại là có, mất state thì .srt không dựng lại
 *    được timeline.
 * ────────────────────────────────────────────────────────────────────────────
 */
(function () {
    'use strict';

    const API = (typeof API_BASE === 'string' && API_BASE) ? API_BASE : '/api';
    const POLL_MS = 700;

    const SCOPES = [
        { id: 'all', label: 'Toàn bộ timeline', hint: 'Lane chính + mọi block âm thanh đang bật tiếng' },
        { id: 'main', label: 'Chỉ lane chính', hint: 'Tiếng thu trực tiếp trong video' },
        { id: 'overlay', label: 'Chỉ lane âm thanh', hint: 'Tệp lồng tiếng / thu ngoài đặt ở lane dưới' },
    ];

    /* NGÔN NGỮ BÓC BĂNG.
     *
     * Whisper nhận 99 thứ tiếng. Danh sách này CỐ Ý hẹp hơn nhiều: chỉ những thứ tiếng mà
     * ứng dụng có font vẽ được (xem EDITING_FONTS ở editing-runtime.js). Bày ra tiếng Ả Rập
     * hay tiếng Thái rồi dựng ra 300 block toàn ô vuông thì tệ hơn hẳn là không bày —
     * người dùng mất cả lượt bóc băng mới biết.
     *
     * `font` = family mà phụ đề sẽ dùng. Ba font Noto Sans SC/JP/KR là BẮT BUỘC với
     * Trung/Nhật/Hàn: 49 family còn lại đều là bản Latin, không có glyph CJK nào.
     *
     * 'auto' không chọn font ở đây được — lúc bấm nút thì chưa ai biết video nói tiếng gì.
     * Font được chốt SAU khi bóc băng xong, theo ngôn ngữ Whisper thật sự nghe ra
     * (job.result.language — xem finishJob).
     *
     * TIẾNG TRUNG chỉ có MỘT mã 'zh'; Whisper không tách giản thể/phồn thể. Bản giản thể
     * được neo bằng `initial_prompt` phía sidecar (SIMPLIFIED_CHINESE_PROMPT).
     *
     * Giữ ĐỒNG BỘ với SUBTITLE_LANGUAGES ở backend/server.js và SUPPORTED_LANGUAGES ở
     * asr/windows_faster_whisper_sidecar.py. */
    const LANGUAGES = [
        { id: 'vi', label: 'Tiếng Việt', font: 'Nunito' },
        { id: 'en', label: 'English', font: 'Nunito' },
        { id: 'zh', label: '中文 — Trung (giản thể)', font: 'Noto Sans SC' },
        { id: 'ja', label: '日本語 — Nhật', font: 'Noto Sans JP' },
        { id: 'ko', label: '한국어 — Hàn', font: 'Noto Sans KR' },
        { id: 'auto', label: 'Tự nhận diện', font: '' },
    ];

    const state = {
        /* MẶC ĐỊNH "Chỉ lane chính": nguồn đúng trong hầu hết dự án là tiếng thu trực tiếp
           của video. "Toàn bộ timeline" trộn thêm nhạc nền và mọi block âm thanh đang bật
           tiếng vào cùng một bản trộn, và Whisper bóc nhạc ra thành lời thoại ảo. */
        scope: 'main',
        language: 'vi',
        jobId: null,
        job: null,
        timer: null,
        busy: false,
        lastError: '',
    };

    const esc = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, { type: type || 'info' });
        else console.log(`[auto-subtitle] ${message}`);
    }

    const ER = () => window.EditingRuntime || null;

    /* Kiểu chữ của phụ đề cho một ngôn ngữ (nền đen bo góc + font khớp chữ viết — xem
     * subtitleTextStyle ở editing-runtime.js). MỘT đường duy nhất, vì style này được dùng ở
     * HAI chỗ phải khớp nhau tuyệt đối: chia câu thành mảnh ≤2 dòng (cuesFromSegments) và
     * dựng block (addTextItem). Tính riêng hai lần là hai bộ số đo khác nhau cho cùng một
     * thứ, và hậu quả là block vẽ ra nhiều dòng hơn phép chia đã hứa. */
    function subtitleStyleFor(language) {
        const runtime = ER();
        return runtime?.subtitleTextStyle ? runtime.subtitleTextStyle(language) : undefined;
    }

    // ── Định dạng .srt ──────────────────────────────────────────────────────

    function srtTimestamp(seconds) {
        const total = Math.max(0, Number(seconds) || 0);
        const ms = Math.round(total * 1000);
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        const milli = ms % 1000;
        const pad = (n, w) => String(n).padStart(w, '0');
        return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
    }

    /* SubRip chuẩn: số thứ tự từ 1, mốc "HH:MM:SS,mmm --> HH:MM:SS,mmm", chữ, dòng
     * trống. Xuống dòng TRONG một phụ đề giữ nguyên \n — đó chính là 2 dòng mà block
     * text đang hiện, nên .srt và video khớp từng dòng một. */
    function buildSrt(cues) {
        return (Array.isArray(cues) ? cues : [])
            .filter((c) => c && String(c.text || '').trim())
            .map((cue, index) => {
                const start = Math.max(0, Number(cue.start) || 0);
                const end = Math.max(start + 0.001, Number(cue.end) || 0);
                const text = String(cue.text).replace(/\r\n?/g, '\n').trim();
                return `${index + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${text}\n`;
            })
            .join('\n');
    }

    // ── Câu ASR -> phụ đề ───────────────────────────────────────────────────

    /* Chuẩn hoá để ĐẾM ký tự: chữ thường, bỏ dấu câu/khoảng trắng, GIỮ dấu tiếng Việt.
     * Phải cùng đơn vị đo với bước gán từ->câu của ASR thì phép gán từ->mảnh dưới đây mới
     * khớp. */
    function normLen(text) {
        return String(text == null ? '' : text)
            .normalize('NFC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_]/gu, '')
            .length;
    }

    /* Cắt MỘT câu thành nhiều phụ đề, mỗi phụ đề tối đa 2 dòng, và trả mốc thời gian cho
     * từng mảnh.
     *
     * Khớp tiếng bằng MỐC TỪNG TỪ thật (`scene.words`): mảnh bắt đầu đúng lúc từ đầu của nó
     * được đọc và kết thúc đúng lúc từ cuối dứt. Không có `words` thì rơi về chia [start, end]
     * theo TỈ LỆ SỐ KÝ TỰ — kém chính xác hơn nhưng vẫn hơn hẳn một block 6 dòng đứng im suốt
     * câu.
     *
     * ⚠️ NHÁNH macOS (v2.0.x) ĐỂ HÀM NÀY Ở `ai-video-panel.js` và dùng chung cho cả "Tạo video
     * AI" lẫn Auto Subtitle. Nhánh Windows CHƯA có ai-video-panel.js, nên bản luật sống ở đây.
     * `cuesFromSegments` vẫn ưu tiên `AiVideoPanel.chunkSpansForScene` nếu file đó được port
     * sang — để không bao giờ có hai bản luật cùng chạy một lúc. Sửa luật thì sửa CẢ HAI nhánh.
     */
    function chunkSpansForScene(scene, ER_, style) {
        const start = Math.max(0, Number(scene?.start) || 0);
        const end = Math.max(start, Number(scene?.end) || start);
        const text = String(scene?.text || '');
        /* `style` đi kèm để phép chia ĐO BẰNG ĐÚNG FONT SẼ VẼ. Bỏ nó ra thì câu tiếng Hàn
           được đo bằng Nunito (rộng hơn Noto Sans KR ~10% ở cùng cỡ chữ) và mảnh nào nằm
           sát mép khổ sẽ vẽ ra 3 dòng dù đã hứa tối đa 2. */
        const chunks = (typeof ER_?.splitTextToMaxLines === 'function')
            ? ER_.splitTextToMaxLines(text, 2, style)
            : [text];
        if (chunks.length <= 1) return [{ text: chunks[0] ?? text, start, end }];

        const words = Array.isArray(scene?.words)
            ? scene.words.filter((w) => w && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)))
            : [];

        if (words.length >= chunks.length) {
            const spans = [];
            let index = 0;
            for (let c = 0; c < chunks.length; c += 1) {
                const remaining = chunks.length - c;          // số mảnh còn lại KỂ CẢ mảnh này
                const first = index;
                if (remaining === 1) {
                    index = words.length;                      // mảnh cuối lấy hết phần còn lại
                } else {
                    const target = normLen(chunks[c]);
                    let taken = 0;
                    // Luôn chừa đủ ít nhất 1 từ cho mỗi mảnh còn lại phía sau.
                    while (index < words.length && (words.length - index) > (remaining - 1)) {
                        const add = normLen(words[index].text);
                        if (taken > 0 && Math.abs(taken - target) <= Math.abs(taken + add - target)) break;
                        taken += add;
                        index += 1;
                    }
                    if (index <= first) index = first + 1;     // phải tiến ít nhất một từ
                }
                const last = Math.max(first, index - 1);
                spans.push({
                    text: chunks[c],
                    start: Number(words[first].start),
                    end: Number(words[last].end),
                });
            }
            /* Kẹp về [start, end] của câu và ép ĐƠN ĐIỆU: mốc ASR lệch có thể làm mảnh sau bắt
             * đầu trước mảnh trước, sinh block chồng nhau -> mỗi cái bị đẩy sang lane mới. */
            let cursor = start;
            for (const span of spans) {
                span.start = Math.min(Math.max(span.start, cursor), end);
                span.end = Math.min(Math.max(span.end, span.start + 0.3), end);
                cursor = span.end;
            }
            return spans;
        }

        const total = chunks.reduce((sum, c) => sum + normLen(c), 0) || 1;
        const spans = [];
        let cursor = start;
        chunks.forEach((chunk, i) => {
            const last = i === chunks.length - 1;
            const stop = last ? end : Math.min(end, cursor + ((end - start) * normLen(chunk) / total));
            spans.push({ text: chunk, start: cursor, end: Math.max(stop, cursor + 0.3) });
            cursor = spans[spans.length - 1].end;
        });
        return spans;
    }

    function cuesFromSegments(segments, style) {
        const runtime = ER();
        // Ưu tiên bản của ai-video-panel.js nếu nhánh này được port thêm tính năng đó — hai bản
        // luật cùng chạy là hai kiểu ngắt phụ đề khác nhau cho cùng một thứ người dùng nhìn thấy.
        const split = window.AiVideoPanel?.chunkSpansForScene || chunkSpansForScene;
        if (!runtime) {
            throw new Error('Chưa nạp được editing-runtime.js — không chia được phụ đề.');
        }
        const cues = [];
        (Array.isArray(segments) ? segments : []).forEach((seg) => {
            const scene = {
                start: Number(seg.start) || 0,
                end: Number(seg.end) || 0,
                text: String(seg.text || '').trim(),
                words: Array.isArray(seg.words) ? seg.words : [],
            };
            if (!scene.text || scene.end <= scene.start) return;
            for (const span of split(scene, runtime, style)) {
                const text = String(span.text || '').trim();
                if (!text) continue;
                cues.push({
                    start: Math.max(0, Number(span.start) || 0),
                    end: Math.max(0, Number(span.end) || 0),
                    text,
                });
            }
        });
        /* Ép ĐƠN ĐIỆU lần cuối trên TOÀN BỘ danh sách (chunkSpansForScene chỉ ép trong
         * phạm vi một câu). Hai câu ASR chồng mốc lên nhau là hai block text chồng
         * nhau, và mỗi cái bị đẩy sang một lane mới — timeline thành cái thang. */
        cues.sort((a, b) => a.start - b.start);
        let cursor = 0;
        for (const cue of cues) {
            cue.start = Math.max(cue.start, cursor);
            cue.end = Math.max(cue.end, cue.start + 0.3);
            cursor = cue.end;
        }
        return cues;
    }

    // ── Đưa phụ đề lên timeline ─────────────────────────────────────────────

    function applyCuesToTimeline(cues, meta) {
        const runtime = ER();
        if (!runtime) throw new Error('Chưa nạp được editing-runtime.js.');
        /* Truyền style vào addTextItem NGAY lúc tạo chứ không gán sau: bề rộng gói dòng và
           toạ độ Y được ĐO trên chính style này, gán sau thì block đã bị gói theo font cũ.
           Cùng một hàm với lúc chia mảnh (xem subtitleStyleFor) để hai phép đo không lệch. */
        const style = subtitleStyleFor(meta?.language);
        const endBatch = typeof runtime.beginHistoryBatch === 'function'
            ? runtime.beginHistoryBatch()
            : () => {};
        let clamped = 0;
        try {
            // Chạy lại lần hai: gỡ bộ CŨ trước, nếu không hai bộ nằm chồng nhau và
            // mỗi câu mới bị đẩy sang một lane mới.
            runtime.removeSubtitleItems();

            const itemIds = [];
            const placed = [];
            cues.forEach((cue) => {
                const want = Math.max(0.3, cue.end - cue.start);
                /* `defer: true` — KHÔNG vẽ lại sau từng block. Video 10 phút ra 300+ phụ đề;
                 * renderAll() mỗi lượt là treo UI vài giây. Vẽ một lần ở cuối (dưới). */
                const item = runtime.addTextItem(
                    { start: cue.start },
                    { text: cue.text, duration: want, defer: true, style },
                );
                if (!item) return;
                itemIds.push(String(item.id));
                const got = Number(item.duration) || 0;
                // resolveNewItemPlacement() KẸP duration theo tổng lane chính. Phụ đề của
                // một tệp lồng tiếng dài hơn lane chính sẽ bị cắt cụt — im lặng thì người
                // dùng chỉ phát hiện lúc xem lại bản xuất.
                if (want - got > 0.15) clamped += 1;
                placed.push({ start: cue.start, end: cue.start + got, text: cue.text });
            });

            runtime.setSubtitleState({
                id: `sub_${Date.now().toString(36)}`,
                created_at: new Date().toISOString(),
                engine: meta?.engine || '',
                source_scope: meta?.scope || state.scope,
                // Ngôn ngữ THẬT của bản bóc băng (với "Tự nhận diện" là thứ Whisper nghe
                // ra). Giữ lại để panel nói được đang dùng font nào sau khi mở lại dự án.
                language: meta?.language || '',
                /* "Đồng bộ các subtitle" — bật sẵn, đúng như CapCut. Một video 10 phút ra
                   300+ block: tắt sẵn thì cú chỉnh cỡ chữ đầu tiên là 300 thao tác tay.
                   Xem subtitleStyleSyncEnabled ở editing-runtime.js. */
                sync_style: true,
                cues: placed,
                item_ids: itemIds,
            });
        } finally {
            endBatch();
            // MỘT lượt vẽ cho cả bộ (xem `defer` ở trên). Trong finally: lỗi giữa chừng
            // thì timeline vẫn phải hiện đúng những block đã kịp dựng.
            if (typeof runtime.renderAll === 'function') runtime.renderAll();
        }
        if (typeof runtime.renderEditPanel === 'function') runtime.renderEditPanel();
        return { count: cues.length, clamped };
    }

    // ── Ghi tệp .srt ────────────────────────────────────────────────────────

    function projectPath() {
        // `currentProjectPath` là `let` trong index.html nên KHÔNG nằm trên window —
        // index.html mở một getter riêng (xem getCurrentProjectPath).
        return typeof window.getCurrentProjectPath === 'function'
            ? String(window.getCurrentProjectPath() || '')
            : '';
    }

    function suggestedSrtName() {
        const name = typeof window.getProjectDisplayName === 'function'
            ? String(window.getProjectDisplayName() || '').trim()
            : '';
        return `${name || 'subtitle'}.srt`;
    }

    /* `silent` = lượt ghi đi kèm việc Lưu dự án (index.html gọi): không toast, không
     * hộp thoại, và dự án chưa có đường dẫn thì bỏ qua. */
    /* Bộ phụ đề dùng để ghi .srt: ĐỌC TỪ BLOCK ĐANG CÓ TRÊN TIMELINE trước, `cues` đã
     * lưu chỉ là bản dự phòng. Người dùng sửa chữ / kéo mốc từng block sau khi tạo là
     * chuyện bình thường (phụ đề là block text thật) — ghi .srt theo ảnh chụp lúc tạo
     * thì tệp lệch với video ngay lần sửa đầu, và lệch IM LẶNG. */
    function currentCues() {
        const runtime = ER();
        const live = runtime?.subtitleCuesFromItems?.() || [];
        if (live.length) return live;
        return runtime?.getSubtitleState?.()?.cues || [];
    }

    /* Nội dung .srt của bộ phụ đề ĐANG CÓ trên timeline, hoặc '' nếu dự án chưa có phụ đề.
     * Đóng gói dự án gọi hàm này (index.html) để gói được một tệp .srt DỰNG LẠI ngay tại thời
     * điểm gói, thay vì chép tệp .srt trên đĩa — tệp trên đĩa có thể đã cũ hơn timeline (sửa
     * phụ đề xong bấm "Đóng gói" mà chưa Lưu) hoặc không còn tồn tại (dự án chép từ máy khác).
     * Đi qua đúng currentCues() như lượt Lưu nên hai đường không bao giờ ra hai nội dung khác
     * nhau cho cùng một timeline. */
    function currentSrtText() {
        if (!ER()?.getSubtitleState?.()) return '';
        const cues = currentCues();
        return cues.length ? buildSrt(cues) : '';
    }

    async function writeSrtFile({ silent = false } = {}) {
        const runtime = ER();
        const sub = runtime?.getSubtitleState?.();
        const cues = sub ? currentCues() : [];
        if (!sub || !cues.length) {
            if (!silent) toast('Chưa có phụ đề nào để lưu .srt.', 'warning');
            return null;
        }
        const save = window.desktopEnv?.saveSubtitleSrt;
        if (typeof save !== 'function') {
            if (!silent) toast('Lưu .srt chỉ khả dụng trên bản desktop.', 'warning');
            return null;
        }
        const result = await save(projectPath(), buildSrt(cues), suggestedSrtName(), silent);
        if (!result || result.canceled || result.skipped) return null;
        if (result.error) {
            if (!silent) toast(`Lưu .srt thất bại: ${result.detail || result.error}`, 'error');
            return null;
        }
        // Nhớ chỗ đã ghi để panel nói được "đã lưu ở đâu" sau khi mở lại dự án.
        runtime.setSubtitleState({ ...sub, srt_path: result.path });
        if (!silent) toast(`Đã lưu phụ đề: ${result.path}`, 'info');
        return result.path;
    }

    // ── Job bóc băng ────────────────────────────────────────────────────────

    function stopPolling() {
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    }

    function schedulePoll() {
        stopPolling();
        state.timer = setTimeout(pollJob, POLL_MS);
    }

    async function pollJob() {
        if (!state.jobId) return;
        try {
            const resp = await fetch(`${API}/subtitles/jobs/${encodeURIComponent(state.jobId)}`);
            const data = await resp.json();
            if (!resp.ok) throw new Error(data?.detail || data?.error || `Lỗi ${resp.status}`);
            state.job = data;
            if (data.state === 'running' || data.state === 'queued') {
                repaint();
                schedulePoll();
                return;
            }
            stopPolling();
            state.busy = false;
            if (data.state === 'complete') await finishJob(data);
            else if (data.state === 'failed') {
                state.lastError = data.error || data.message || 'Tạo phụ đề thất bại.';
                toast(state.lastError, 'error');
            }
            repaint();
        } catch (error) {
            stopPolling();
            state.busy = false;
            state.lastError = String(error?.message || error);
            repaint();
        }
    }

    async function finishJob(job) {
        const segments = job?.result?.segments || [];
        (job.warnings || []).forEach((w) => toast(w, 'warning'));
        if (!segments.length) {
            state.lastError = 'Không nghe thấy lời thoại nào trong audio của timeline.';
            return;
        }
        /* Font phụ đề bám theo ngôn ngữ BACKEND BÁO VỀ, không theo ô đang chọn trong menu:
           với "Tự nhận diện" thì ô đó là chuỗi 'auto', và chọn font theo nó sẽ ra font
           Latin cho một video tiếng Nhật — tức 300 block toàn ô vuông.

           PHẢI khai TRƯỚC cuesFromSegments: bước chia câu cũng đo bằng chính style này
           (xem subtitleStyleFor), nên hai bước phải nhìn thấy cùng một ngôn ngữ. */
        const language = String(job.result?.language || state.language || 'vi');
        const style = subtitleStyleFor(language);
        const cues = cuesFromSegments(segments, style);
        if (!cues.length) {
            state.lastError = 'Bóc băng xong nhưng không dựng được câu phụ đề nào.';
            return;
        }
        const applied = applyCuesToTimeline(cues, { engine: job.result?.engine, scope: state.scope, language });
        // Ghi .srt NGAY (im lặng nếu dự án chưa Lưu — lúc Lưu sẽ tự ghi, xem saveProject).
        await writeSrtFile({ silent: true });
        state.lastError = '';
        let msg = `Đã tạo ${applied.count} phụ đề`;
        if (job.result?.cache_hit) msg += ' (dùng lại cache bóc băng)';
        toast(`${msg}. Ctrl+Z hoàn tác toàn bộ.`, 'info');
        if (applied.clamped) {
            toast(`${applied.clamped} phụ đề bị cắt ngắn vì lane chính hết trước lời thoại. `
                + 'Kéo dài lane chính rồi tạo lại nếu cần.', 'warning');
        }
    }

    async function createJob() {
        const runtime = ER();
        if (!runtime) { toast('Chưa nạp được editing-runtime.js.', 'error'); return; }
        const entries = runtime.collectAudibleTimelineSpans(state.scope);
        if (!entries.length) {
            toast('Không có đoạn audio nào đang bật tiếng theo lựa chọn này. '
                + 'Kiểm tra lane chính / block âm thanh và nút tắt tiếng.', 'warning');
            return;
        }
        state.busy = true;
        state.lastError = '';
        state.job = { state: 'queued', progress: 0, message: 'Đang gửi yêu cầu…' };
        repaint();
        try {
            const resp = await fetch(`${API}/subtitles/transcribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entries,
                    transcribe_mode: 'vi_smart',
                    language: state.language,
                    /* Kịch bản chuẩn (nếu có) làm gợi ý ngữ cảnh cho Whisper — cùng đường
                     * mà bước Upload → Transcribe đã dùng, giúp đúng tên riêng/thuật ngữ.
                     *
                     * CHỈ GỬI KHI BÓC TIẾNG VIỆT. Kịch bản chuẩn của dự án này luôn là văn
                     * bản tiếng Việt; ném nó vào lượt bóc tiếng Nhật/Hàn là mồi cho Whisper
                     * một ngữ cảnh SAI NGÔN NGỮ, và nó sẽ chèn chữ tiếng Việt vào giữa phụ
                     * đề — một dạng ảo giác tự mình tạo ra. */
                    reference_script: (state.language === 'vi' && typeof window.currentReferenceScriptText === 'function')
                        ? window.currentReferenceScriptText()
                        : '',
                    asr_engine: typeof window.getSelectedAsrEngine === 'function'
                        ? window.getSelectedAsrEngine()
                        : undefined,
                    asr_model: typeof window.getSelectedAsrModel === 'function'
                        ? window.getSelectedAsrModel()
                        : undefined,
                }),
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data?.detail || data?.error || `Lỗi ${resp.status}`);
            state.jobId = data.job_id;
            state.job = data;
            repaint();
            schedulePoll();
        } catch (error) {
            state.busy = false;
            state.jobId = null;
            state.job = null;
            state.lastError = String(error?.message || error);
            toast(state.lastError, 'error');
            repaint();
        }
    }

    async function cancelJob() {
        if (!state.jobId) return;
        stopPolling();
        try {
            await fetch(`${API}/subtitles/jobs/${encodeURIComponent(state.jobId)}/cancel`, { method: 'POST' });
        } catch (_) { /* job đã chết thì thôi */ }
        state.busy = false;
        state.job = { state: 'cancelled', progress: 0, message: 'Đã huỷ' };
        repaint();
    }

    function clearSubtitles() {
        const runtime = ER();
        if (!runtime) return;
        const sub = runtime.getSubtitleState?.();
        if (!sub) return;
        const endBatch = typeof runtime.beginHistoryBatch === 'function' ? runtime.beginHistoryBatch() : () => {};
        let removed = 0;
        try {
            removed = runtime.removeSubtitleItems();
            runtime.setSubtitleState(null);
        } finally {
            endBatch();
        }
        toast(`Đã xoá ${removed} block phụ đề. Ctrl+Z hoàn tác.`, 'info');
        repaint();
    }

    // ── Giao diện ───────────────────────────────────────────────────────────

    function injectStyle() {
        if (document.getElementById('auto-subtitle-style')) return;
        const el = document.createElement('style');
        el.id = 'auto-subtitle-style';
        // Chỉ dùng token/lớp sẵn có của panel; không đặt màu mới.
        el.textContent = `
            .edit-sub-pane { display: flex; flex-direction: column; gap: 10px; padding: 2px; }
            .edit-sub-block { display: flex; flex-direction: column; gap: 6px; }
            .edit-sub-label { font-size: 11px; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.04em; }
            .edit-sub-hint { font-size: 11px; opacity: 0.65; line-height: 1.45; }
            .edit-sub-warn { font-size: 11px; color: #ffb454; line-height: 1.45; }
            .edit-sub-error { font-size: 11px; color: #ff6b6b; line-height: 1.45; }
            .edit-sub-input {
                width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px;
                background: rgba(255,255,255,0.05); color: inherit;
                border: 1px solid rgba(255,255,255,0.12);
            }
            .edit-sub-check {
                display: flex; align-items: center; gap: 8px; cursor: pointer;
                font-size: 12px; line-height: 1.35; user-select: none;
            }
            .edit-sub-check input { margin: 0; cursor: pointer; accent-color: var(--accent, #3b82f6); }
            .edit-sub-actions { display: flex; gap: 8px; }
            .edit-sub-actions .btn { flex: 1; }
            .edit-sub-progress {
                position: relative; height: 6px; border-radius: 3px; overflow: hidden;
                background: rgba(255,255,255,0.10);
            }
            .edit-sub-progress-fill {
                position: absolute; inset: 0 auto 0 0; border-radius: 3px;
                background: var(--accent, #3b82f6); transition: width 220ms ease;
            }
            .edit-sub-progress.is-error .edit-sub-progress-fill { background: #ff6b6b; }
            .edit-sub-status { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; opacity: 0.85; }
            .edit-sub-status b { font-variant-numeric: tabular-nums; }
            .edit-sub-list {
                max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
                border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 4px;
            }
            .edit-sub-cue {
                display: grid; grid-template-columns: 62px 1fr; gap: 8px; align-items: start;
                padding: 4px 6px; border-radius: 4px; text-align: left; width: 100%;
                background: transparent; border: 0; color: inherit; cursor: pointer; font: inherit;
            }
            .edit-sub-cue:hover { background: rgba(255,255,255,0.06); }
            .edit-sub-cue time { font-size: 10px; opacity: 0.6; font-variant-numeric: tabular-nums; padding-top: 2px; }
            .edit-sub-cue span { font-size: 12px; line-height: 1.35; white-space: pre-wrap; }
        `;
        document.head.appendChild(el);
    }

    function clock(seconds) {
        const total = Math.max(0, Number(seconds) || 0);
        const m = Math.floor(total / 60);
        const s = Math.floor(total % 60);
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function renderProgressHtml() {
        const job = state.job;
        if (!job) return '';
        const pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
        const failed = job.state === 'failed';
        return `
            <div class="edit-sub-block">
                <div class="edit-sub-progress ${failed ? 'is-error' : ''}">
                    <div class="edit-sub-progress-fill" style="width:${pct}%"></div>
                </div>
                <div class="edit-sub-status">
                    <span>${esc(job.message || job.state || '')}</span>
                    <b>${Math.round(pct)}%</b>
                </div>
            </div>`;
    }

    function languageById(id) {
        return LANGUAGES.find((l) => l.id === String(id || '').toLowerCase()) || null;
    }

    function languageHint() {
        const lang = languageById(state.language);
        if (!lang) return '';
        if (lang.id === 'auto') {
            return 'Whisper tự nghe ra ngôn ngữ, rồi phụ đề lấy font khớp với ngôn ngữ đó. '
                + 'Chọn thẳng ngôn ngữ vẫn chắc hơn khi video có lẫn nhiều thứ tiếng.';
        }
        const zh = lang.id === 'zh' ? ' Whisper chỉ có một mã cho tiếng Trung — bản giản thể được neo bằng gợi ý ngữ cảnh.' : '';
        return `Phụ đề dùng font ${lang.font}, hỗ trợ đầy đủ chữ của ngôn ngữ này.${zh}`;
    }

    /* Nút "Đồng bộ các subtitle". Cờ sống trong subtitleState (đi theo .crab + undo/redo) —
     * xem subtitleStyleSyncEnabled ở editing-runtime.js. Chỉ hiện khi dự án ĐÃ có phụ đề:
     * chưa có bộ nào thì không có gì để đồng bộ, và cũng không có chỗ để ghi cờ. */
    function renderSyncHtml() {
        const runtime = ER();
        if (!runtime?.getSubtitleState?.()) return '';
        const on = runtime.subtitleStyleSyncEnabled?.() !== false;
        return `
            <label class="edit-sub-check">
                <input type="checkbox" id="subSyncStyle"${on ? ' checked' : ''}>
                <span>Đồng bộ các subtitle</span>
            </label>
            <div class="edit-sub-hint">${on
                ? 'Chỉnh kiểu chữ hoặc thông số ở subtab "Biến đổi" của MỘT phụ đề là cả bộ đổi theo. '
                    + 'Nội dung chữ và mốc thời gian của từng câu vẫn giữ riêng.'
                : 'Mỗi phụ đề giữ kiểu chữ và thông số biến đổi riêng.'}</div>`;
    }

    function renderResultHtml() {
        const sub = ER()?.getSubtitleState?.();
        if (!sub) return '';
        // Danh sách hiện bản SỐNG trên timeline (xem currentCues) -> sửa chữ một block là
        // thấy ngay ở đây, không phải bản chụp lúc bóc băng.
        const cues = currentCues();
        if (!cues.length) return '';
        const rows = cues.map((cue, index) => `
            <button type="button" class="edit-sub-cue" data-sub-seek="${Number(cue.start) || 0}" data-sub-index="${index}">
                <time>${clock(cue.start)}</time><span>${esc(cue.text)}</span>
            </button>`).join('');
        const lang = languageById(sub.language);
        return `
            <div class="edit-sub-block">
                <div class="edit-sub-label">${cues.length} phụ đề trên timeline${lang && lang.font ? ` · ${esc(lang.font)}` : ''}</div>
                ${renderSyncHtml()}
                <div class="edit-sub-actions">
                    <button class="btn btn-secondary" type="button" id="subSaveSrt">Lưu .srt</button>
                    <button class="btn btn-secondary" type="button" id="subClear">Xoá phụ đề</button>
                </div>
                <div class="edit-sub-hint">${sub.srt_path
                    ? `Tệp phụ đề: <code>${esc(sub.srt_path)}</code>`
                    : 'Tệp .srt được ghi cạnh tệp .crab ngay khi bạn Lưu dự án.'}</div>
                <div class="edit-sub-list">${rows}</div>
            </div>`;
    }

    function renderPaneHtml() {
        injectStyle();
        const running = state.busy || state.job?.state === 'running' || state.job?.state === 'queued';
        const scope = SCOPES.find((s) => s.id === state.scope) || SCOPES[0];
        return `
            <div class="edit-sub-pane" data-sub-zone>
                <div class="edit-sub-block">
                    <div class="edit-sub-hint">Bóc băng âm thanh đang có trên timeline bằng Whisper (chạy trên máy)
                        rồi rải thành block phụ đề — cùng kiểu chữ với phụ đề của "Tạo video AI",
                        tối đa 2 dòng mỗi câu. Sửa từng câu như mọi block văn bản khác.</div>
                </div>

                <div class="edit-sub-block">
                    <label class="edit-sub-label" for="subScope">Nguồn âm thanh</label>
                    <select id="subScope" class="edit-sub-input" ${running ? 'disabled' : ''}>
                        ${SCOPES.map((s) => `<option value="${s.id}"${s.id === state.scope ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
                    </select>
                    <div class="edit-sub-hint">${esc(scope.hint)}. Block/lane đang tắt tiếng thì không được bóc băng.</div>
                </div>

                <div class="edit-sub-block">
                    <label class="edit-sub-label" for="subLang">Ngôn ngữ lời thoại</label>
                    <select id="subLang" class="edit-sub-input" ${running ? 'disabled' : ''}>
                        ${LANGUAGES.map((l) => `<option value="${l.id}"${l.id === state.language ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}
                    </select>
                    <div class="edit-sub-hint">${esc(languageHint())}</div>
                </div>

                <div class="edit-sub-actions">
                    <button class="btn btn-primary" type="button" id="subCreate" ${running ? 'disabled' : ''}>
                        ${ER()?.getSubtitleState?.() ? 'Tạo lại phụ đề' : 'Tạo phụ đề'}
                    </button>
                    ${running ? '<button class="btn btn-danger" type="button" id="subCancel">Huỷ</button>' : ''}
                </div>

                ${renderProgressHtml()}
                ${state.lastError ? `<div class="edit-sub-error">${esc(state.lastError)}</div>` : ''}
                ${renderResultHtml()}
            </div>`;
    }

    /* Vẽ lại KHI VÀ CHỈ KHI panel đang mở đúng nhóm này: job chạy nền, người dùng có
     * thể đã chuyển sang tab khác giữa chừng — ghi đè #editPanelBody lúc đó là cướp
     * mất nội dung họ đang xem. */
    function repaint() {
        const body = document.getElementById('editPanelBody');
        if (!body || !body.querySelector('[data-sub-zone]')) return;
        body.innerHTML = renderPaneHtml();
        bindPane(body);
    }

    /* Bind vào [data-sub-zone] chứ KHÔNG vào #editPanelBody: node body sống mãi còn
     * nội dung bị ghi đè mỗi lượt vẽ — bind vào body là chồng listener (xem ghi chú
     * cùng loại ở ai-video-panel.js). */
    function bindPane(body) {
        const zone = body.querySelector('[data-sub-zone]');
        if (!zone) return;

        zone.querySelector('#subScope')?.addEventListener('change', (event) => {
            state.scope = event.target.value || 'main';
            repaint();
        });
        zone.querySelector('#subLang')?.addEventListener('change', (event) => {
            state.language = languageById(event.target.value) ? event.target.value : 'vi';
            repaint();
        });
        /* Bật/tắt đồng bộ KHÔNG ghi history: nó không đổi một pixel nào trên khung hình,
           chỉ đổi cách các lượt chỉnh SAU đó lan ra. Nhét vào undo/redo thì Ctrl+Z sau khi
           chỉnh cỡ chữ sẽ hoàn tác cái nút thay vì hoàn tác cỡ chữ. */
        zone.querySelector('#subSyncStyle')?.addEventListener('change', (event) => {
            ER()?.setSubtitleStyleSync?.(!!event.target.checked);
            repaint();
        });
        zone.querySelector('#subCreate')?.addEventListener('click', () => { createJob(); });
        zone.querySelector('#subCancel')?.addEventListener('click', () => { cancelJob(); });
        zone.querySelector('#subSaveSrt')?.addEventListener('click', () => { writeSrtFile({ silent: false }); });
        zone.querySelector('#subClear')?.addEventListener('click', () => { clearSubtitles(); });

        zone.addEventListener('click', (event) => {
            const cue = event.target.closest('[data-sub-seek]');
            if (!cue) return;
            const at = Number(cue.dataset.subSeek);
            if (Number.isFinite(at) && typeof window.setVideoTimeFromTimelineTime === 'function') {
                window.setVideoTimeFromTimelineTime(at);
            }
        });
    }

    /* Dự án mới / mở dự án khác: job của dự án cũ không còn nghĩa gì. index.html gọi. */
    function resetState() {
        stopPolling();
        state.jobId = null;
        state.job = null;
        state.busy = false;
        state.lastError = '';
        state.scope = 'main';
        state.language = 'vi';
        repaint();
    }

    window.AutoSubtitlePanel = {
        renderPaneHtml,
        bindPane,
        resetState,
        state,
        SCOPES,
        LANGUAGES,
        // Ghi .srt kèm lượt Lưu dự án (index.html gọi với silent = true).
        writeSrtFile,
        // Đóng gói dự án gọi để lấy nội dung .srt dựng lại tại thời điểm gói.
        currentSrtText,
        /* Mở ra để test canh. `finishJob` KHÔNG thuần (nó ghi vào timeline) nhưng vẫn phải
         * mở: đây là hàm chạy SAU khi job nền xong, tức không một test nào chạm tới nếu chỉ
         * gọi các hàm thuần — và đúng chỗ đó đã lọt một lỗi `ReferenceError` (dùng biến
         * trước dòng `const` của nó) ra tới tay người dùng, sau khi bóc băng xong xuôi. */
        finishJob,
        buildSrt,
        srtTimestamp,
        cuesFromSegments,
        chunkSpansForScene,
        currentCues,
    };
}());
