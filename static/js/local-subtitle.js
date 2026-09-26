/* Nhóm "Local Subtitle" của tab Văn bản: nhập tệp phụ đề CÓ SẴN (.srt, .vtt, .ass/.ssa,
 * .xml/.ttml/.dfxp, .lrc, .sbv) rồi rải thành block phụ đề đúng mốc thời gian trong tệp —
 * kiểu "Import captions" của Premiere / "Local captions" của CapCut.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * BỐN QUYẾT ĐỊNH, ĐỌC TRƯỚC KHI SỬA
 *
 * 1. PHỤ ĐỀ LÀ BLOCK TEXT THẬT, cùng đường ER.addTextItem() với Auto Subtitle (xem đầu
 *    auto-subtitle.js): preview, xuất video, keyframe, sửa từng câu, .crab đều chạy sẵn.
 *    Kiểu chữ cũng là kiểu phụ đề của Auto Subtitle (subtitleTextStyle) — định dạng riêng
 *    trong tệp (màu/vị trí của .ass, thẻ <font> của .srt) bị bỏ, giữ chữ và mốc.
 *
 * 2. MỖI TỆP LÀ MỘT BỘ RIÊNG (ER.subtitleImports), như mỗi tệp caption là một track riêng
 *    ở Premiere — quyết định của người dùng (2026-09-26) để làm được phụ đề song ngữ. Nhập
 *    lại ĐÚNG tệp cùng tên thì THAY bộ cũ của tệp đó (sửa tệp ở ngoài rồi nhập lại là thao
 *    tác thường gặp; chồng thêm một bộ y hệt thì không ai muốn). Bộ của Auto Subtitle không
 *    bị động tới.
 *
 * 3. MỐC TRONG TỆP = MỐC TIMELINE, tính từ đầu timeline — cách CapCut và Premiere (mặc định)
 *    cùng làm. Ô "Bắt đầu từ" cho thêm lựa chọn "Vị trí playhead" của Premiere: 00:00 của
 *    tệp đặt tại playhead. KHÔNG quy đổi qua các điểm cắt của lane chính: tệp phụ đề chỉ
 *    biết mốc của MỘT video, không biết timeline đã cắt/đảo thế nào — không NLE nào đoán
 *    việc đó, và đoán sai thì lệch im lặng.
 *
 * 4. TÊN TỆP, MỐC, CHỮ ĐỌC Ở subtitle-formats.js (hàm thuần, test bằng node trần). Tệp này
 *    chỉ lo giao diện và việc đặt block lên timeline.
 * ────────────────────────────────────────────────────────────────────────────
 */
(function () {
    'use strict';

    const START_OPTIONS = [
        { id: 'zero', label: 'Đầu timeline', hint: 'Mốc trong tệp tính từ 00:00 của timeline — đúng khi tệp phụ đề làm cho chính video trên lane chính.' },
        { id: 'playhead', label: 'Vị trí playhead', hint: '00:00 của tệp đặt tại playhead — dùng khi phụ đề chỉ thuộc một đoạn giữa timeline.' },
    ];

    /* Timecode kiểu phát sóng: nhiều tệp .srt/.xml xuất từ phần mềm dựng phim bắt đầu ở
     * 01:00:00 (Premiere/Avid mặc định đặt sequence ở 01:00:00:00). Đặt thẳng lên timeline là
     * mọi câu nằm sau cuối video. Câu đầu từ mốc giờ này trở đi VÀ nằm sau cuối timeline thì
     * trừ bớt số giờ tròn — và nói ra cho người dùng biết. */
    const BROADCAST_HOUR = 3600;

    const state = {
        startAt: 'zero',
        busy: false,
        lastError: '',
        notes: [],            // các cảnh báo của lượt nhập vừa rồi (cắt/gộp câu, bảng mã…)
        openSetId: '',        // bộ đang mở danh sách câu
    };

    const esc = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const ER = () => window.EditingRuntime || null;
    const SF = () => window.SubtitleFormats || null;
    const AUTO = () => window.AutoSubtitlePanel || null;

    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, { type: type || 'info' });
        else console.log(`[local-subtitle] ${message}`);
    }

    function clock(seconds) {
        return AUTO()?.clock ? AUTO().clock(seconds) : String(Math.round(Number(seconds) || 0));
    }

    const baseName = (fileName) => String(fileName || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Phụ đề';

    // ── Đưa một tệp lên timeline ────────────────────────────────────────────

    /* `parsed` = kết quả SubtitleFormats.parseSubtitleText. Trả { set, count, skipped, clamped,
     * shiftedHours } — số liệu để nơi gọi báo lại. Ném Error (câu tiếng Việt) khi không đặt
     * được câu nào. */
    function applyImport(parsed, meta) {
        const runtime = ER();
        if (!runtime) throw new Error('Chưa nạp được editing-runtime.js.');
        const total = Number(runtime.timelineDuration?.()) || 0;
        if (!(total > 0)) {
            throw new Error('Timeline chưa có video nào. Thêm video vào lane chính trước — '
                + 'phụ đề được khớp theo mốc thời gian của timeline.');
        }
        const offset = state.startAt === 'playhead' ? (Number(runtime.currentSequenceTime?.()) || 0) : 0;
        const firstStart = parsed.cues[0].start;
        const shiftedHours = (firstStart >= BROADCAST_HOUR && firstStart + offset >= total)
            ? Math.floor(firstStart / BROADCAST_HOUR)
            : 0;
        const shift = offset - (shiftedHours * BROADCAST_HOUR);
        const moved = parsed.cues.map((cue) => ({ start: cue.start + shift, end: cue.end + shift, text: cue.text }));
        // resolveNewItemPlacement KẸP mốc bắt đầu vào trong timeline: để lọt một câu nằm sau
        // cuối video là nó bị dồn về sát mép cuối, chồng lên nhau thành một đống — bỏ hẳn.
        const inside = moved.filter((cue) => cue.end > 0 && cue.start < total - 0.05)
            .map((cue) => ({ ...cue, start: Math.max(0, cue.start) }));
        const skipped = moved.length - inside.length;
        if (!inside.length) {
            throw new Error(`Mọi câu trong tệp đều nằm ngoài timeline (dài ${clock(total)}; câu đầu ở `
                + `${clock(firstStart)}). Kiểm tra đúng tệp phụ đề của video này chưa, hoặc đổi "Bắt đầu từ".`);
        }

        const language = parsed.language || '';
        const style = runtime.subtitleTextStyle ? runtime.subtitleTextStyle(language) : undefined;
        const fileName = String(meta?.fileName || '');
        const existing = (runtime.getSubtitleImports?.() || [])
            .find((set) => String(set.source_name || '').toLowerCase() === fileName.toLowerCase());
        const endBatch = typeof runtime.beginHistoryBatch === 'function' ? runtime.beginHistoryBatch() : () => {};
        let clamped = 0;
        let set = null;
        try {
            if (existing) runtime.removeSubtitleItems(existing.id);
            const itemIds = [];
            const placed = [];
            inside.forEach((cue) => {
                const want = Math.max(0.1, cue.end - cue.start);
                /* `defer` — một lượt vẽ cho cả bộ (xem applyCuesToTimeline ở auto-subtitle.js).
                   `keepLineBreaks` — giữ cách ngắt dòng của người làm phụ đề. */
                const item = runtime.addTextItem(
                    { start: cue.start },
                    { text: cue.text, duration: want, defer: true, style, keepLineBreaks: true },
                );
                if (!item) return;
                itemIds.push(String(item.id));
                const got = Number(item.duration) || 0;
                if (want - got > 0.15) clamped += 1;
                placed.push({ start: cue.start, end: cue.start + got, text: cue.text });
            });
            set = {
                id: existing?.id || `subimp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                created_at: new Date().toISOString(),
                engine: 'file',
                name: baseName(fileName),
                source_name: fileName,
                format: parsed.format,
                language,
                start_at: state.startAt,
                offset: shift,
                // Bật sẵn như bộ của Auto Subtitle — xem subtitleStyleSyncEnabled.
                sync_style: existing ? existing.sync_style !== false : true,
                cues: placed,
                item_ids: itemIds,
            };
            const list = (runtime.getSubtitleImports?.() || []).filter((s) => s.id !== set.id);
            const at = existing ? (runtime.getSubtitleImports() || []).findIndex((s) => s.id === existing.id) : -1;
            if (at >= 0) list.splice(at, 0, set); else list.push(set);
            runtime.setSubtitleImports(list);
        } finally {
            endBatch();
            if (typeof runtime.renderAll === 'function') runtime.renderAll();
        }
        return { set, count: set.item_ids.length, skipped, clamped, shiftedHours, replaced: !!existing };
    }

    async function readFileText(file) {
        const buffer = typeof file.arrayBuffer === 'function'
            ? await file.arrayBuffer()
            : await new Response(file).arrayBuffer();
        return SF().decodeSubtitleBytes(buffer);
    }

    async function importFiles(files) {
        const list = Array.from(files || []).filter(Boolean);
        if (!list.length || state.busy) return;
        if (!SF()) { toast('Chưa nạp được subtitle-formats.js.', 'error'); return; }
        state.busy = true;
        state.lastError = '';
        state.notes = [];
        repaint();
        const errors = [];
        let lastSetId = '';
        try {
            for (const file of list) {
                const name = String(file.name || '');
                try {
                    const decoded = await readFileText(file);
                    const parsed = SF().parseSubtitleText(decoded.text, name);
                    const result = applyImport(parsed, { fileName: name });
                    lastSetId = result.set.id;
                    const notes = [];
                    if (decoded.fallback) {
                        notes.push('tệp không phải UTF-8, đã đọc theo bảng mã Windows-1258 — chữ lỗi thì lưu lại tệp dạng UTF-8');
                    }
                    if (result.shiftedHours) notes.push(`timecode bắt đầu ở ${String(result.shiftedHours).padStart(2, '0')}:00:00 nên đã trừ ${result.shiftedHours} giờ`);
                    if (parsed.merged) notes.push(`${parsed.merged} câu bắt đầu cùng lúc được gộp thành một block`);
                    if (parsed.trimmed) notes.push(`${parsed.trimmed} câu chồng mốc lên câu sau được cắt đuôi`);
                    if (result.skipped) notes.push(`${result.skipped} câu nằm ngoài timeline bị bỏ`);
                    if (result.clamped) notes.push(`${result.clamped} câu bị cắt ngắn ở cuối timeline`);
                    if (notes.length) state.notes.push(`${name}: ${notes.join('; ')}.`);
                    toast(`${result.replaced ? 'Đã thay' : 'Đã nhập'} ${result.count} phụ đề từ ${name}. Ctrl+Z hoàn tác.`, 'info');
                } catch (error) {
                    errors.push(`${name}: ${error?.message || error}`);
                }
            }
        } finally {
            state.busy = false;
        }
        if (errors.length) {
            state.lastError = errors.join('\n');
            toast(errors[0], 'error');
        }
        if (lastSetId) state.openSetId = lastSetId;
        ER()?.renderEditPanel?.();
        repaint();
    }

    // ── Thao tác trên một bộ ────────────────────────────────────────────────

    function findSet(setId) {
        return (ER()?.getSubtitleImports?.() || []).find((set) => set.id === setId) || null;
    }

    function removeSet(setId) {
        const runtime = ER();
        const set = findSet(setId);
        if (!runtime || !set) return;
        const endBatch = typeof runtime.beginHistoryBatch === 'function' ? runtime.beginHistoryBatch() : () => {};
        let removed = 0;
        try {
            removed = runtime.removeSubtitleItems(set.id);
            runtime.setSubtitleImports((runtime.getSubtitleImports() || []).filter((s) => s.id !== set.id));
        } finally {
            endBatch();
        }
        toast(`Đã xoá ${removed} block phụ đề của "${set.name}". Ctrl+Z hoàn tác.`, 'info');
        repaint();
    }

    /* Xuất .srt của MỘT bộ, dựng từ block ĐANG CÓ trên timeline (cùng lý do như
     * currentCues ở auto-subtitle.js: người dùng sửa chữ/kéo mốc sau khi nhập). Luôn hỏi
     * chỗ lưu — projectPath rỗng — vì "<Tên dự án>.srt" cạnh .crab là chỗ của bộ Auto
     * Subtitle, và ghi bộ nhập vào đó là đè mất nó. */
    async function exportSet(setId) {
        const set = findSet(setId);
        const cues = set ? (ER()?.subtitleCuesFromItems?.(set.id) || []) : [];
        if (!cues.length) { toast('Bộ phụ đề này không còn block nào trên timeline.', 'warning'); return; }
        const text = AUTO()?.buildSrt ? AUTO().buildSrt(cues) : '';
        if (!text) { toast('Chưa nạp được auto-subtitle.js (bộ dựng .srt).', 'error'); return; }
        const fileName = `${set.name} (CrabbyCut).srt`;
        const save = window.desktopEnv?.saveSubtitleSrt;
        if (typeof save === 'function') {
            const result = await save('', text, fileName, false);
            if (!result || result.canceled || result.skipped) return;
            if (result.error) { toast(`Lưu .srt thất bại: ${result.detail || result.error}`, 'error'); return; }
            toast(`Đã lưu phụ đề: ${result.path}`, 'info');
            return;
        }
        // Bản web: tải xuống.
        const url = URL.createObjectURL(new Blob([`﻿${text.replace(/\n/g, '\r\n')}`], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ── Giao diện ───────────────────────────────────────────────────────────

    function injectStyle() {
        AUTO()?.injectStyle?.();   // các lớp .edit-sub-* dùng chung với Auto Subtitle
        if (document.getElementById('local-subtitle-style')) return;
        const el = document.createElement('style');
        el.id = 'local-subtitle-style';
        el.textContent = `
            .edit-lsub-drop { min-height: 110px; flex: 0 0 auto; }
            .edit-lsub-drop.is-dragover { border-color: var(--primary); background: rgba(255,176,32,0.08); }
            .edit-lsub-set {
                display: flex; flex-direction: column; gap: 6px; padding: 8px;
                border: 1px solid rgba(255,255,255,0.08); border-radius: 6px;
            }
            .edit-lsub-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
            .edit-lsub-name { font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
            .edit-lsub-meta { font-size: 10px; opacity: 0.6; white-space: nowrap; }
            .edit-lsub-toggle {
                background: transparent; border: 0; padding: 0; color: inherit; font: inherit;
                font-size: 11px; opacity: 0.75; cursor: pointer; text-align: left;
            }
            .edit-lsub-toggle:hover { opacity: 1; }
        `;
        document.head.insertBefore(el, document.getElementById('lumenSkin'));
    }

    function renderSetHtml(set) {
        const runtime = ER();
        const cues = runtime?.subtitleCuesFromItems?.(set.id) || [];
        const sync = runtime?.subtitleStyleSyncEnabled?.(set.id) !== false;
        const open = state.openSetId === set.id;
        const font = runtime?.subtitleFontForLanguage?.(set.language) || '';
        const label = SF()?.FORMAT_LABELS?.[set.format] || set.format || '';
        const rows = open ? cues.map((cue) => `
            <button type="button" class="edit-sub-cue" data-sub-seek="${Number(cue.start) || 0}">
                <time>${clock(cue.start)}</time><span>${esc(cue.text)}</span>
            </button>`).join('') : '';
        return `
            <div class="edit-lsub-set" data-lsub-set="${esc(set.id)}">
                <div class="edit-lsub-head">
                    <span class="edit-lsub-name" title="${esc(set.source_name)}">${esc(set.name)}</span>
                    <span class="edit-lsub-meta">${cues.length} câu</span>
                </div>
                <div class="edit-sub-hint">${esc(label)}${font ? ` · ${esc(font)}` : ''}</div>
                <label class="edit-sub-check">
                    <input type="checkbox" data-lsub-sync="${esc(set.id)}"${sync ? ' checked' : ''}>
                    <span>Đồng bộ các subtitle</span>
                </label>
                <div class="edit-sub-actions">
                    <button class="btn btn-secondary" type="button" data-lsub-export="${esc(set.id)}"${cues.length ? '' : ' disabled'}>Xuất .srt</button>
                    <button class="btn btn-secondary" type="button" data-lsub-remove="${esc(set.id)}">Xoá</button>
                </div>
                ${cues.length ? `<button type="button" class="edit-lsub-toggle" data-lsub-open="${esc(set.id)}">${open ? '▾ Ẩn danh sách câu' : '▸ Xem danh sách câu'}</button>` : ''}
                ${open && rows ? `<div class="edit-sub-list">${rows}</div>` : ''}
            </div>`;
    }

    function renderPaneHtml() {
        injectStyle();
        const sets = ER()?.getSubtitleImports?.() || [];
        const start = START_OPTIONS.find((o) => o.id === state.startAt) || START_OPTIONS[0];
        const accept = SF()?.ACCEPT || '.srt,.vtt,.ass,.ssa,.xml,.ttml,.dfxp,.lrc,.sbv';
        return `
            <div class="edit-sub-pane" data-lsub-zone>
                <div class="edit-sub-block">
                    <div class="edit-sub-hint">Nhập tệp phụ đề có sẵn — mỗi câu thành một block văn bản đúng mốc
                        thời gian trong tệp. Mỗi tệp là một bộ riêng, nên đặt được phụ đề hai thứ tiếng cùng lúc.</div>
                </div>

                <div class="edit-sub-block">
                    <label class="edit-sub-label" for="lsubStart">Bắt đầu từ</label>
                    <select id="lsubStart" class="edit-sub-input" ${state.busy ? 'disabled' : ''}>
                        ${START_OPTIONS.map((o) => `<option value="${o.id}"${o.id === state.startAt ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
                    </select>
                    <div class="edit-sub-hint">${esc(start.hint)}</div>
                </div>

                <button class="edit-import-drop edit-lsub-drop" type="button" data-lsub-pick ${state.busy ? 'disabled' : ''}>
                    <span class="edit-import-drop-ico"><svg class="btn-ico"><use href="#ic-plus"/></svg></span>
                    <span class="edit-import-drop-title">${state.busy ? 'Đang nhập…' : 'Nhập tệp phụ đề'}</span>
                    <span class="edit-import-drop-sub">.srt .vtt .ass .xml .lrc .sbv — bấm hoặc kéo thả vào đây</span>
                </button>
                <input type="file" id="lsubFileInput" accept="${esc(accept)}" multiple hidden>

                ${state.lastError ? `<div class="edit-sub-error">${esc(state.lastError).replace(/\n/g, '<br>')}</div>` : ''}
                ${state.notes.length ? `<div class="edit-sub-warn">${state.notes.map(esc).join('<br>')}</div>` : ''}

                ${sets.length ? `
                    <div class="edit-sub-block">
                        <div class="edit-sub-label">${sets.length} bộ phụ đề đã nhập</div>
                        ${sets.map(renderSetHtml).join('')}
                    </div>` : ''}
            </div>`;
    }

    /* Vẽ lại chỉ khi panel đang mở đúng nhóm này — cùng lý do như repaint() ở auto-subtitle.js. */
    function repaint() {
        const body = document.getElementById('editPanelBody');
        if (!body || !body.querySelector('[data-lsub-zone]')) return;
        body.innerHTML = renderPaneHtml();
        bindPane(body);
    }

    /* Bind vào [data-lsub-zone] (nội dung vẽ lại mỗi lượt), không vào #editPanelBody sống
     * mãi — bind vào body là chồng listener. */
    function bindPane(body) {
        const zone = body.querySelector('[data-lsub-zone]');
        if (!zone) return;
        const input = zone.querySelector('#lsubFileInput');
        const drop = zone.querySelector('[data-lsub-pick]');

        zone.querySelector('#lsubStart')?.addEventListener('change', (event) => {
            state.startAt = START_OPTIONS.some((o) => o.id === event.target.value) ? event.target.value : 'zero';
            repaint();
        });
        input?.addEventListener('change', () => {
            const files = Array.from(input.files || []);
            input.value = '';
            importFiles(files);
        });
        zone.addEventListener('click', (event) => {
            if (event.target.closest('[data-lsub-pick]')) { if (!state.busy) input?.click(); return; }
            const exp = event.target.closest('[data-lsub-export]');
            if (exp) { exportSet(exp.dataset.lsubExport); return; }
            const rm = event.target.closest('[data-lsub-remove]');
            if (rm) { removeSet(rm.dataset.lsubRemove); return; }
            const openBtn = event.target.closest('[data-lsub-open]');
            if (openBtn) {
                state.openSetId = state.openSetId === openBtn.dataset.lsubOpen ? '' : openBtn.dataset.lsubOpen;
                repaint();
                return;
            }
            const cue = event.target.closest('[data-sub-seek]');
            if (cue) {
                const at = Number(cue.dataset.subSeek);
                if (Number.isFinite(at) && typeof window.setVideoTimeFromTimelineTime === 'function') {
                    window.setVideoTimeFromTimelineTime(at);
                }
            }
        });
        /* Bật/tắt đồng bộ KHÔNG ghi history — cùng lý do như ô cùng tên ở auto-subtitle.js. */
        zone.addEventListener('change', (event) => {
            const box = event.target.closest?.('[data-lsub-sync]');
            if (!box) return;
            ER()?.setSubtitleStyleSync?.(!!box.checked, box.dataset.lsubSync);
            repaint();
        });

        /* Kéo thả tệp phụ đề vào panel. Tab Văn bản KHÔNG nằm trong vùng nhận tệp phương tiện
           của #editPanelBody (setupPanelImportDnd), nên thả ở đây chỉ có một nghĩa. */
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
            importFiles(Array.from(event.dataTransfer.files || []));
        });
    }

    /* Dự án mới / mở dự án khác: cảnh báo của lượt nhập trước không còn nghĩa. index.html gọi.
     * Bản thân các bộ đã nhập nằm trong EditingRuntime (đi theo .crab), không ở đây. */
    function resetState() {
        state.busy = false;
        state.lastError = '';
        state.notes = [];
        state.openSetId = '';
        state.startAt = 'zero';
        repaint();
    }

    window.LocalSubtitlePanel = {
        renderPaneHtml,
        bindPane,
        resetState,
        state,
        START_OPTIONS,
        // Mở ra cho test (tests/scripts/subtitle_import.js).
        applyImport,
        importFiles,
        removeSet,
    };
}());
