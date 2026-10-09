/**
 * BẢNG CÀI ĐẶT ỨNG DỤNG — UI
 * ==========================
 * Dựng nội dung modal Cài đặt (Menu → Cài đặt…). Khung NHIỀU MỤC (cột nav trái + pane
 * phải); lần này chỉ mục "Auto Sound Effects" có nội dung, các mục khác để sẵn chỗ.
 *
 * Vì sao tách khỏi index.html: index.html đã ~9.8k dòng và pane ASE là một trình soạn cấu
 * hình đầy đủ (nhóm, luật, số liệu). index.html chỉ giữ VỎ modal + mở/đóng.
 *
 * MÔ HÌNH SỬA: thao tác ghi vào một BẢN NHÁP (`draft`) trong bộ nhớ, bấm "Lưu" mới gọi
 * AppSettings.save(). Bấm "Huỷ"/đóng thì bản nháp bị vứt — người dùng nghịch thoải mái mà
 * không sợ hỏng cấu hình đang chạy. Cấu hình KHÔNG vào undo/redo của dự án (nó là cài đặt
 * ứng dụng) và KHÔNG hồi tố lên các block Auto Sound Effects đã điền.
 */
(function () {
    const API_BASE = '/api';
    const PANE_ASE = 'auto-sfx';

    const SECTIONS = [
        { id: 'general', label: _t('Chung'), ready: true },
        { id: 'shortcuts', label: _t('Phím tắt'), ready: true },
        { id: 'autosave', label: _t('Tự động lưu'), ready: true },
        { id: 'preview', label: _t('Xem trước'), ready: true },
        { id: PANE_ASE, label: _t('Auto Sound Effects'), ready: true },
        { id: 'cache', label: _t('Bộ nhớ đệm'), ready: true },
        { id: 'export', label: _t('Xuất video'), ready: false },
        { id: 'about', label: _t('Về CrabbyCut'), ready: true },
    ];

    let draft = null;          // bản nháp đang sửa
    let activeSection = 'general';
    let libraryCache = {};     // category -> [{name, url}]
    let bound = false;
    let previewAudio = null;

    /* ---- trạng thái riêng của mục Phím tắt ---- */
    let keymapDraft = null;    // { commandId: combo } đầy đủ
    let capturingId = null;    // lệnh đang chờ nhận phím
    let pendingConflict = null; // { id, combo, holders:[id] } — dải cảnh báo dưới đáy
    let keyFilter = '';        // ô tìm kiếm
    let layerMods = new Set(); // bổ trợ đang xem trên bàn phím trực quan
    let pickedKeyCode = '';    // bấm một phím trên bàn phím -> lọc danh sách
    let cacheUsage = null;     // kết quả /api/cache/usage

    /* ---------- tiện ích ---------- */

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function root() { return document.getElementById('settingsModalBody'); }

    function cfg() { return draft && draft.autoSfx ? draft.autoSfx : null; }

    // Id nhóm mới: tiền tố + số nhỏ nhất chưa dùng, để id ngắn và đọc được trong file JSON.
    function nextGroupId(list, prefix) {
        let n = list.length + 1;
        while (list.some((g) => g.id === `${prefix}${n}`)) n += 1;
        return `${prefix}${n}`;
    }

    function effectOptions() {
        const list = (window.TextAnimations && TextAnimations.EFFECT_OPTIONS) || [];
        return list.filter((o) => o.value && o.value !== 'none');
    }

    function transitionOptions() {
        return (window.Transitions && Transitions.TRANSITION_OPTIONS) || [];
    }

    function labelForEffect(id) {
        const hit = effectOptions().find((o) => o.value === id);
        return hit ? hit.label : id;
    }

    function labelForTransition(id) {
        const hit = transitionOptions().find((o) => o.id === id);
        return hit ? hit.label : id;
    }

    function sfxGroupName(id) {
        const hit = (cfg().sfxGroups || []).find((g) => g.id === id);
        return hit ? hit.name : id;
    }

    // Danh sách file của một category trong library/, đã nạp sẵn (xem ensureLibrary).
    function libraryRelPaths(category) {
        const folder = { sfxs: 'SFXs', music: 'Music', elements: 'Elements' }[category] || '';
        return (libraryCache[category] || []).map((item) => `${folder}/${item.name}`);
    }

    // Cấu hình ghi tên file theo auto_sfx.txt (".mp3" thường) còn đĩa là ".MP3" HOA -> so
    // khớp phải hạ hoa thường. Dùng chung hàm chuẩn hoá của AutoSfxAssets để hai bên không lệch.
    function pathKey(value) {
        return window.AutoSfxAssets
            ? AutoSfxAssets.relPathKey(value)
            : String(value || '').trim().replace(/\\/g, '/').toLowerCase();
    }

    function fileExists(category, rel) {
        const key = pathKey(rel);
        return libraryRelPaths(category).some((p) => pathKey(p) === key);
    }

    function baseName(rel) {
        const parts = String(rel || '').split('/');
        return parts[parts.length - 1] || rel;
    }

    async function ensureLibrary(category) {
        if (libraryCache[category]) return libraryCache[category];
        try {
            const resp = await fetch(`${API_BASE}/library?category=${encodeURIComponent(category)}`);
            const data = resp.ok ? await resp.json() : null;
            libraryCache[category] = Array.isArray(data?.items) ? data.items : [];
        } catch (_) {
            libraryCache[category] = [];
        }
        return libraryCache[category];
    }

    /* ---------- dựng HTML ---------- */

    function selectHtml(attrs, options, selected, placeholder) {
        const opts = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '')
            + options.map((o) => `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
        return `<select ${attrs}>${opts}</select>`;
    }

    function chipHtml(label, act, groupId, member) {
        return `<span class="set-chip">${esc(label)}`
            + `<button type="button" class="set-chip-x" data-set-act="${act}" data-group="${esc(groupId)}" data-member="${esc(member)}" aria-label="${esc(_t('Bỏ {name}', { name: label }))}">×</button>`
            + `</span>`;
    }

    // Thẻ nhóm hiệu ứng động / chuyển cảnh — cùng một khuôn, chỉ khác nguồn danh mục.
    function memberGroupCardHtml(group, kind) {
        const isAnim = kind === 'anim';
        const members = isAnim ? (group.effects || []) : (group.transitions || []);
        const all = isAnim
            ? effectOptions().map((o) => ({ value: o.value, label: o.label }))
            : transitionOptions().map((o) => ({ value: o.id, label: o.label }));
        // Một hiệu ứng chỉ được thuộc MỘT nhóm: nếu nằm ở 2 nhóm thì tra luật ra 2 kết quả
        // khác nhau tuỳ thứ tự duyệt — mập mờ. Chặn ngay ở chỗ chọn.
        const used = new Set();
        (isAnim ? cfg().animGroups : cfg().transGroups).forEach((g) => {
            (isAnim ? g.effects : g.transitions).forEach((m) => used.add(m));
        });
        const free = all.filter((o) => !used.has(o.value));
        return `
        <div class="set-card">
            <div class="set-card-head">
                <input class="set-name" type="text" value="${esc(group.name)}" data-set-act="rename-${kind}" data-group="${esc(group.id)}">
                <button type="button" class="set-x" data-set-act="del-${kind}-group" data-group="${esc(group.id)}" title="${_t('Xoá nhóm')}">×</button>
            </div>
            <div class="set-chips">${members.map((m) => chipHtml(isAnim ? labelForEffect(m) : labelForTransition(m), `del-${kind}-member`, group.id, m)).join('') || `<span class="set-empty">${_t('Chưa có hiệu ứng nào')}</span>`}</div>
            <div class="set-add">
                ${selectHtml(`data-set-pick="${kind}" data-group="${esc(group.id)}"`, free, '', free.length ? _t('Chọn hiệu ứng…') : _t('Đã dùng hết'))}
                <button type="button" class="set-btn" data-set-act="add-${kind}-member" data-group="${esc(group.id)}"${free.length ? '' : ' disabled'}>${_t('+ Thêm')}</button>
            </div>
        </div>`;
    }

    function fileRowHtml(rel, category, act, groupId) {
        const missing = !fileExists(category, rel);
        return `<div class="set-file${missing ? ' is-missing' : ''}">
            <button type="button" class="set-play" data-set-act="preview-file" data-file="${esc(rel)}" aria-label="${_t('Nghe thử')}">▶</button>
            <span class="set-file-name">${esc(baseName(rel))}</span>
            ${missing ? `<span class="set-missing">${_t('thiếu file')}</span>` : ''}
            <button type="button" class="set-x" data-set-act="${act}" data-group="${esc(groupId || '')}" data-member="${esc(rel)}" title="${_t('Bỏ khỏi nhóm')}">×</button>
        </div>`;
    }

    function sfxGroupCardHtml(group) {
        const pool = libraryRelPaths('sfxs')
            .filter((rel) => !(group.files || []).some((f) => pathKey(f) === pathKey(rel)))
            .map((rel) => ({ value: rel, label: baseName(rel) }));
        return `
        <div class="set-card">
            <div class="set-card-head">
                <input class="set-name" type="text" value="${esc(group.name)}" data-set-act="rename-sfx" data-group="${esc(group.id)}">
                <button type="button" class="set-x" data-set-act="del-sfx-group" data-group="${esc(group.id)}" title="${_t('Xoá nhóm')}">×</button>
            </div>
            <div class="set-files">${(group.files || []).map((f) => fileRowHtml(f, 'sfxs', 'del-sfx-file', group.id)).join('') || `<span class="set-empty">${_t('Chưa có file nào')}</span>`}</div>
            <div class="set-add">
                ${selectHtml(`data-set-pick="sfx" data-group="${esc(group.id)}"`, pool, '', pool.length ? _t('Chọn file SFXs…') : _t('Đã dùng hết'))}
                <button type="button" class="set-btn" data-set-act="add-sfx-file" data-group="${esc(group.id)}"${pool.length ? '' : ' disabled'}>${_t('+ Thêm')}</button>
            </div>
            <div class="set-row2">
                <label>${_t('Canh theo')}
                    ${selectHtml(`data-set-act="set-align" data-group="${esc(group.id)}"`, [
                        { value: 'peak', label: _t('Đỉnh sóng rơi đúng mốc') },
                        { value: 'start', label: _t('Đầu tiếng trùng đầu block') },
                    ], group.align)}
                </label>
                <label>${_t('Độ dài')}
                    ${selectHtml(`data-set-act="set-fit" data-group="${esc(group.id)}"`, [
                        { value: 'full', label: _t('Giữ nguyên cả file') },
                        { value: 'toEffect', label: _t('Cắt theo độ dài hiệu ứng') },
                    ], group.fit)}
                </label>
            </div>
        </div>`;
    }

    function ruleRowHtml(rule, index) {
        const sources = [
            ...cfg().animGroups.map((g) => ({ value: `anim:${g.id}`, label: _t('Hiệu ứng động — {name}', { name: g.name }) })),
            ...cfg().transGroups.map((g) => ({ value: `transition:${g.id}`, label: _t('Chuyển cảnh — {name}', { name: g.name }) })),
        ];
        const sfxOpts = cfg().sfxGroups.map((g) => ({ value: g.id, label: g.name }));
        const th = rule.threshold;
        return `
        <div class="set-rule">
            <div class="set-rule-main">
                ${selectHtml(`data-set-act="rule-source" data-index="${index}"`, sources, `${rule.source.kind}:${rule.source.group}`)}
                <span class="set-arrow">→</span>
                ${selectHtml(`data-set-act="rule-sfx" data-index="${index}"`, sfxOpts, rule.sfxGroup)}
                <button type="button" class="set-x" data-set-act="del-rule" data-index="${index}" title="${_t('Xoá luật')}">×</button>
            </div>
            <label class="set-th-toggle">
                <input type="checkbox" data-set-act="rule-th-toggle" data-index="${index}"${th ? ' checked' : ''}>
                ${_t('Đổi nhóm theo độ dài hiệu ứng')}
            </label>
            ${th ? `<div class="set-rule-th">
                <span>${_t('nếu ≤')}</span>
                <input type="number" min="0.05" max="10" step="0.05" value="${th.maxDuration}" data-set-act="rule-th-dur" data-index="${index}">
                <span>${_t('s dùng nhóm trên, ngược lại')}</span>
                ${selectHtml(`data-set-act="rule-th-else" data-index="${index}"`, sfxOpts, th.elseSfxGroup)}
            </div>` : ''}
        </div>`;
    }

    function elementRowHtml(rule, index) {
        const files = libraryRelPaths('elements').map((rel) => ({ value: baseName(rel), label: baseName(rel) }));
        const sfxOpts = cfg().sfxGroups.map((g) => ({ value: g.id, label: g.name }));
        const missing = !files.some((f) => f.value.toLowerCase() === String(rule.assetName).toLowerCase());
        return `
        <div class="set-rule set-rule-1line${missing ? ' is-missing' : ''}">
            ${selectHtml(`data-set-act="el-name" data-index="${index}"`, missing ? [{ value: rule.assetName, label: _t('{name} (thiếu file)', { name: rule.assetName }) }, ...files] : files, rule.assetName)}
            <span class="set-arrow">→</span>
            ${selectHtml(`data-set-act="el-sfx" data-index="${index}"`, sfxOpts, rule.sfxGroup)}
            <button type="button" class="set-x" data-set-act="del-element" data-index="${index}" title="${_t('Xoá dòng')}">×</button>
        </div>`;
    }

    // Mẫu văn bản của engine: [{ value: id, label: tên hiện trên thẻ }].
    function templateOptions() {
        const list = window.TextTemplates && Array.isArray(TextTemplates.TEMPLATES) ? TextTemplates.TEMPLATES : [];
        return list.map((t) => ({ value: t.id, label: t.name || t.id }));
    }

    function templateRowHtml(rule, index) {
        // Mẫu đã có dòng khác thì không cho chọn trùng (mỗi mẫu một dòng, xem normalizeAutoSfx).
        const taken = new Set(cfg().templateRules.filter((_, i) => i !== index).map((r) => r.templateId));
        const tpls = templateOptions().filter((o) => !taken.has(o.value));
        const sfxOpts = cfg().sfxGroups.map((g) => ({ value: g.id, label: g.name }));
        return `
        <div class="set-rule set-rule-1line">
            ${selectHtml(`data-set-act="tpl-id" data-index="${index}"`, tpls, rule.templateId)}
            <span class="set-arrow">→</span>
            ${selectHtml(`data-set-act="tpl-sfx" data-index="${index}"`, sfxOpts, rule.sfxGroup)}
            <button type="button" class="set-x" data-set-act="del-template" data-index="${index}" title="${_t('Xoá dòng')}">×</button>
        </div>`;
    }

    // `act` mặc định là 'level' (mục Auto Sound Effects, ghi vào autoSfx.levels[key]); các mục
    // khác truyền act riêng để CHANGES định tuyến thẳng tới nhánh của chúng.
    function numberRowHtml(label, key, value, min, max, step, unit, act) {
        return `<label class="set-num">
            <span>${esc(label)}</span>
            <input type="number" min="${min}" max="${max}" step="${step}" value="${value}" data-set-act="${act || 'level'}" data-key="${key}">
            <span class="set-unit">${esc(unit)}</span>
        </label>`;
    }

    function asePaneHtml() {
        const c = cfg();
        const musicPool = libraryRelPaths('music')
            .filter((rel) => !c.musicFiles.some((f) => pathKey(f) === pathKey(rel)))
            .map((rel) => ({ value: rel, label: baseName(rel) }));
        return `
        <p class="set-intro">${_t('Quy tắc tự điền tiếng động và nhạc nền. Sửa ở đây chỉ áp cho <b>lần chạy Auto Sound Effects tiếp theo</b>, không đổi các block đã điền.')}</p>

        <section class="set-sec"><h4>${_t('1 · Nhóm hiệu ứng động')}</h4>
            ${c.animGroups.map((g) => memberGroupCardHtml(g, 'anim')).join('')}
            <button type="button" class="set-btn" data-set-act="add-anim-group">${_t('+ Nhóm mới')}</button>
        </section>

        <section class="set-sec"><h4>${_t('2 · Nhóm hiệu ứng chuyển tiếp')}</h4>
            ${c.transGroups.map((g) => memberGroupCardHtml(g, 'transition')).join('')}
            <button type="button" class="set-btn" data-set-act="add-transition-group">${_t('+ Nhóm mới')}</button>
        </section>

        <section class="set-sec"><h4>${_t('3 · Nhóm SFXs')}</h4>
            ${c.sfxGroups.map((g) => sfxGroupCardHtml(g)).join('')}
            <button type="button" class="set-btn" data-set-act="add-sfx-group">${_t('+ Nhóm mới')}</button>
        </section>

        <section class="set-sec"><h4>${_t('4 · Nhạc nền [Mus]')}</h4>
            <div class="set-card">
                <div class="set-files">${c.musicFiles.map((f) => fileRowHtml(f, 'music', 'del-music-file', '')).join('') || `<span class="set-empty">${_t('Chưa có file nào — sẽ không thêm nhạc nền')}</span>`}</div>
                <div class="set-add">
                    ${selectHtml('data-set-pick="music"', musicPool, '', musicPool.length ? _t('Chọn file nhạc…') : _t('Đã dùng hết'))}
                    <button type="button" class="set-btn" data-set-act="add-music-file"${musicPool.length ? '' : ' disabled'}>${_t('+ Thêm')}</button>
                </div>
            </div>
        </section>

        <section class="set-sec"><h4>${_t('5 · Element → nhóm SFXs')}</h4>
            ${c.elementRules.map((r, i) => elementRowHtml(r, i)).join('') || `<span class="set-empty">${_t('Chưa có dòng nào')}</span>`}
            <button type="button" class="set-btn" data-set-act="add-element">${_t('+ Thêm dòng')}</button>
        </section>

        <section class="set-sec"><h4>${_t('6 · Mẫu văn bản → nhóm SFXs')}</h4>
            ${c.templateRules.map((r, i) => templateRowHtml(r, i)).join('') || `<span class="set-empty">${_t('Chưa có dòng nào')}</span>`}
            <button type="button" class="set-btn" data-set-act="add-template"${c.templateRules.length < templateOptions().length ? '' : ' disabled'}>${_t('+ Thêm dòng')}</button>
            <p class="set-note">${_t('Mỗi block mẫu văn bản được một tiếng, bắt đầu đúng lúc mẫu xuất hiện (đầu block) — không vang trước chữ, "Đặt sớm hơn mốc" không áp cho mẫu. Mẫu có hình [Icon] trùng một dòng ở mục 5 (ví dụ Tuỳ chỉnh chọn [Icon] True/Wrong) thì dùng nhóm của dòng Element đó.')}</p>
        </section>

        <section class="set-sec"><h4>${_t('7 · Bảng luật ghép')}</h4>
            ${c.rules.map((r, i) => ruleRowHtml(r, i)).join('') || `<span class="set-empty">${_t('Chưa có luật nào — Auto Sound Effects sẽ không điền gì')}</span>`}
            <button type="button" class="set-btn" data-set-act="add-rule">${_t('+ Thêm luật')}</button>
        </section>

        <section class="set-sec"><h4>${_t('8 · Số liệu')}</h4>
            <div class="set-nums">
                ${numberRowHtml(_t('Âm lượng SFX'), 'sfxDb', c.levels.sfxDb, -60, 20, 0.5, 'dB')}
                ${numberRowHtml(_t('Âm lượng nhạc nền'), 'musicDb', c.levels.musicDb, -60, 20, 0.5, 'dB')}
                ${numberRowHtml(_t('Cuối nhạc giảm xuống'), 'musicFadeToDb', c.levels.musicFadeToDb, -60, 20, 0.5, 'dB')}
                ${numberRowHtml(_t('Thời gian giảm'), 'musicFadeSec', c.levels.musicFadeSec, 0.1, 10, 0.1, 's')}
                ${numberRowHtml(_t('Đặt sớm hơn mốc (hiệu ứng động & Icon)'), 'animLeadSec', c.levels.animLeadSec, 0, 3, 0.05, 's')}
            </div>
            <p class="set-note">${_t('"Đặt sớm hơn mốc" đẩy đỉnh sóng của tiếng lên trước điểm kết thúc hiệu ứng vào — nghe ăn khớp hơn là trùng khít. KHÔNG áp cho điểm chuyển cảnh và nhóm canh theo đầu block (tiếng gõ phím).')}</p>
        </section>`;
    }

    /* ================= MỤC PHÍM TẮT (kiểu Premiere) ================= */

    // Bố cục ANSI-US. Mỗi ô: [mã phím, nhãn, cỡ tương đối]. Cỡ để hàng nào cũng đủ 15 đơn vị.
    const KB_ROWS = [
        [['Escape', 'esc', 1.4], ['F1', 'F1', 1], ['F2', 'F2', 1], ['F3', 'F3', 1], ['F4', 'F4', 1], ['F5', 'F5', 1], ['F6', 'F6', 1], ['F7', 'F7', 1], ['F8', 'F8', 1], ['F9', 'F9', 1], ['F10', 'F10', 1], ['F11', 'F11', 1], ['F12', 'F12', 1]],
        [['Backquote', '`', 1], ['Digit1', '1', 1], ['Digit2', '2', 1], ['Digit3', '3', 1], ['Digit4', '4', 1], ['Digit5', '5', 1], ['Digit6', '6', 1], ['Digit7', '7', 1], ['Digit8', '8', 1], ['Digit9', '9', 1], ['Digit0', '0', 1], ['Minus', '−', 1], ['Equal', '=', 1], ['Backspace', '⌫', 1.8]],
        [['Tab', 'tab', 1.5], ['KeyQ', 'Q', 1], ['KeyW', 'W', 1], ['KeyE', 'E', 1], ['KeyR', 'R', 1], ['KeyT', 'T', 1], ['KeyY', 'Y', 1], ['KeyU', 'U', 1], ['KeyI', 'I', 1], ['KeyO', 'O', 1], ['KeyP', 'P', 1], ['BracketLeft', '[', 1], ['BracketRight', ']', 1], ['Backslash', '\\', 1.3]],
        [[null, 'caps', 1.8], ['KeyA', 'A', 1], ['KeyS', 'S', 1], ['KeyD', 'D', 1], ['KeyF', 'F', 1], ['KeyG', 'G', 1], ['KeyH', 'H', 1], ['KeyJ', 'J', 1], ['KeyK', 'K', 1], ['KeyL', 'L', 1], ['Semicolon', ';', 1], ['Quote', "'", 1], ['Enter', '⏎', 2]],
        [[null, '⇧', 2.3], ['KeyZ', 'Z', 1], ['KeyX', 'X', 1], ['KeyC', 'C', 1], ['KeyV', 'V', 1], ['KeyB', 'B', 1], ['KeyN', 'N', 1], ['KeyM', 'M', 1], ['Comma', ',', 1], ['Period', '.', 1], ['Slash', '/', 1], [null, '⇧', 2.5]],
        [[null, 'ctrl', 1.3], [null, '⌥', 1.3], [null, '⌘', 1.6], ['Space', 'space', 6.2], [null, '⌘', 1.6], [null, '⌥', 1.3], ['Delete', 'del', 1.5]],
        [['ArrowLeft', '←', 1], ['ArrowUp', '↑', 1], ['ArrowDown', '↓', 1], ['ArrowRight', '→', 1]],
    ];

    // Tổ hợp mà LỚP đang xem sẽ tra: các bổ trợ đang bật + phím đó.
    function layerCombo(code) {
        const S = window.Shortcuts;
        const mods = S.MOD_ORDER.filter((m) => layerMods.has(m));
        return S.normalizeCombo([...mods, code].join('+'));
    }

    function commandsUsingCombo(combo) {
        return window.Shortcuts.COMMAND_IDS.filter((id) => keymapDraft[id] === combo);
    }

    function keyboardHtml() {
        const S = window.Shortcuts;
        const modBtns = ['Cmd', 'Alt', 'Shift', 'Ctrl'].map((m) => {
            const label = S.isMacPlatform() ? ({ Cmd: '⌘ Cmd', Alt: '⌥ Alt', Shift: '⇧ Shift', Ctrl: '⌃ Ctrl' })[m] : m;
            return `<button type="button" class="kb-mod${layerMods.has(m) ? ' is-on' : ''}" data-set-act="kb-mod" data-mod="${m}">${esc(label)}</button>`;
        }).join('');
        const rows = KB_ROWS.map((row) => `<div class="kb-row">${row.map(([code, label, size]) => {
            if (!code) return `<div class="kb-key is-dead" style="flex:${size}">${esc(label)}</div>`;
            const used = commandsUsingCombo(layerCombo(code));
            const cls = ['kb-key'];
            if (used.length) cls.push('is-assigned');
            if (pickedKeyCode === code) cls.push('is-picked');
            const tip = used.length ? used.map((id) => S.commandById(id).label).join(' · ') : '';
            return `<button type="button" class="${cls.join(' ')}" style="flex:${size}" data-set-act="kb-key" data-code="${code}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(label)}</button>`;
        }).join('')}</div>`).join('');
        return `<div class="kb-mods">${modBtns}<span class="kb-hint">${_t('Bấm phím bổ trợ để xem lớp phím tắt · bấm một phím để lọc danh sách')}</span></div>
            <div class="kb-board">${rows}</div>`;
    }

    function shortcutRowHtml(cmd) {
        const S = window.Shortcuts;
        const combo = keymapDraft[cmd.id];
        const capturing = capturingId === cmd.id;
        const clash = pendingConflict && pendingConflict.holders.includes(cmd.id);
        return `<div class="sc-row${clash ? ' is-clash' : ''}">
            <span class="sc-name">${esc(cmd.label)}</span>
            <button type="button" class="sc-key${capturing ? ' is-capturing' : ''}" data-set-act="sc-capture" data-cmd="${cmd.id}">
                ${capturing ? _t('Nhấn tổ hợp phím…') : (esc(S.formatCombo(combo)) || `<span class="sc-none">${_t('chưa gán')}</span>`)}
            </button>
        </div>`;
    }

    function shortcutsPaneHtml() {
        const S = window.Shortcuts;
        const custom = Object.keys(S.keymapOverrides(keymapDraft)).length > 0;
        const q = keyFilter.trim().toLowerCase();
        const match = (cmd) => {
            if (pickedKeyCode && !String(keymapDraft[cmd.id] || '').endsWith(pickedKeyCode)) return false;
            if (!q) return true;
            return cmd.label.toLowerCase().includes(q)
                || S.formatCombo(keymapDraft[cmd.id]).toLowerCase().includes(q);
        };
        const groups = S.GROUPS.map((g) => {
            const rows = S.COMMANDS.filter((c) => c.group === g.id && match(c));
            if (!rows.length) return '';
            return `<div class="sc-group"><h5>${esc(g.label)}</h5>${rows.map(shortcutRowHtml).join('')}</div>`;
        }).join('');
        const fixed = S.CONTEXT_KEYS
            .filter((k) => !q || k.label.toLowerCase().includes(q) || k.display.toLowerCase().includes(q))
            .map((k) => `<div class="sc-row is-fixed"><span class="sc-name">${esc(k.label)}</span><span class="sc-key is-fixed">${esc(k.display)}</span></div>`)
            .join('');
        const conflict = pendingConflict ? `<div class="sc-conflict" role="alert">
            <span>${_t('<b>{combo}</b> đang được dùng cho «{holders}». Gán cho «{command}» sẽ gỡ khỏi lệnh kia.', {
                combo: esc(S.formatCombo(pendingConflict.combo)),
                holders: esc(pendingConflict.holders.map((id) => S.commandById(id).label).join('», «')),
                command: esc(S.commandById(pendingConflict.id).label),
            })}</span>
            <button type="button" class="set-btn" data-set-act="sc-conflict-ok">${_t('Gán đè')}</button>
            <button type="button" class="set-btn" data-set-act="sc-conflict-cancel">${_t('Huỷ')}</button>
        </div>` : '';
        return `
        <div class="sc-head">
            <span class="sc-preset">${_t('Bộ phím: <b>{name}</b>', { name: custom ? _t('Tuỳ chỉnh') : _t('Mặc định CrabbyCut') })}</span>
            <button type="button" class="set-btn" data-set-act="sc-reset">${_t('Khôi phục mặc định')}</button>
        </div>
        ${keyboardHtml()}
        <div class="sc-search">
            <input type="text" placeholder="${_t('Tìm lệnh hoặc phím…')}" value="${esc(keyFilter)}" data-set-act="sc-search">
            ${pickedKeyCode ? `<button type="button" class="set-btn" data-set-act="sc-clear-pick">${_t('Bỏ lọc phím {key}', { key: esc(S.keyLabel(pickedKeyCode)) })}</button>` : ''}
        </div>
        <div class="sc-list">
            ${groups || `<span class="set-empty">${_t('Không có lệnh nào khớp')}</span>`}
            ${fixed ? `<div class="sc-group"><h5>${_t('Phím cố định (không đổi được)')}</h5>${fixed}</div>` : ''}
        </div>
        ${conflict}`;
    }

    /* ================= CÁC MỤC ĐƠN GIẢN ================= */

    function checkboxRowHtml(label, key, checked, hint) {
        return `<label class="set-check"><input type="checkbox" data-set-act="${key}"${checked ? ' checked' : ''}>
            <span>${esc(label)}</span></label>${hint ? `<p class="set-note">${esc(hint)}</p>` : ''}`;
    }

    function generalPaneHtml() {
        const g = draft.general;
        // Tên ngôn ngữ luôn viết bằng CHÍNH ngôn ngữ đó (người lỡ chọn nhầm vẫn tìm được đường về).
        const I = window.I18n;
        const langOptions = [{ value: 'auto', label: _t('Theo hệ thống') }]
            .concat((I ? I.SUPPORTED : ['vi']).map((code) => ({ value: code, label: I ? I.NATIVE_NAMES[code] : code })));
        return `<p class="set-intro">${_t('Các thiết lập chung của ứng dụng.')}</p>
        <section class="set-sec"><h4>${_t('Ngôn ngữ')}</h4>
            <div class="set-row2">
                <label>${_t('Ngôn ngữ giao diện')}
                    ${selectHtml('data-set-act="language"', langOptions, g.language)}
                </label>
            </div>
            <p class="set-note">${_t('Đổi ngôn ngữ cần tải lại giao diện. Dự án đang mở sẽ được mở lại sau khi tải.')}</p>
        </section>
        <section class="set-sec"><h4>${_t('Chỉnh sửa')}</h4>
            <div class="set-nums">${numberRowHtml(_t('Số bước Hoàn tác'), 'undoSteps', g.undoSteps, 5, 100, 1, _t('bước'), 'undoSteps')}</div>
            <p class="set-note">${_t('Càng nhiều bước càng tốn bộ nhớ: mỗi bước là một ảnh chụp toàn bộ timeline.')}</p>
        </section>
        <section class="set-sec"><h4>${_t('Timeline')}</h4>
            ${checkboxRowHtml(_t('Bật bắt dính playhead khi mở ứng dụng'), 'snapDefault', g.snapDefault,
                _t('Chỉ là trạng thái BAN ĐẦU — nút bắt dính trên thanh công cụ vẫn tắt/bật được bất cứ lúc nào.'))}
        </section>
        <section class="set-sec"><h4>${_t('Nâng cao')}</h4>
            ${checkboxRowHtml(_t('Chế độ Nhà phát triển'), 'devMode', g.devMode, _t('Hiện overlay khung xương nhận diện ở bước Editing.'))}
        </section>`;
    }

    function autosavePaneHtml() {
        const a = draft.autoSave;
        return `<p class="set-intro">${_t('Tự động lưu ghi <b>bản sao</b> có dấu thời gian vào thư mục <b>CrabbyCut Auto-Save</b> cạnh file dự án — <b>không bao giờ ghi đè</b> file .crab của bạn. Dự án chưa từng Lưu thì bản sao nằm trong thư mục dữ liệu của ứng dụng. Mở lại bằng Menu → “Mở bản lưu tự động…”.')}</p>
        <section class="set-sec">
            ${checkboxRowHtml(_t('Bật tự động lưu'), 'asEnabled', a.enabled)}
            <div class="set-nums">
                ${numberRowHtml(_t('Lưu mỗi'), 'intervalMin', a.intervalMin, 1, 60, 1, _t('phút'), 'intervalMin')}
                ${numberRowHtml(_t('Giữ tối đa'), 'keepVersions', a.keepVersions, 1, 50, 1, _t('bản'), 'keepVersions')}
            </div>
            <p class="set-note">${_t('Quá số bản đặt ở đây thì bản cũ nhất bị xoá. Lượt lưu được hoãn lại khi đang phát xem trước hoặc backend đang xử lý, để không làm khựng hình.')}</p>
        </section>
        <section class="set-sec"><h4>${_t('Khi thoát')}</h4>
            ${checkboxRowHtml(_t('Hỏi trước khi đóng nếu còn thay đổi chưa lưu'), 'warnOnExit', a.warnOnExit)}
        </section>`;
    }

    function previewPaneHtml() {
        const p = draft.preview;
        return `<p class="set-intro">${_t('Ảnh hưởng tới khung xem trước, không ảnh hưởng bản xuất.')}</p>
        <section class="set-sec"><h4>${_t('Chất lượng')}</h4>
            <div class="set-row2">
                <label>${_t('Chất lượng khi mở ứng dụng')}
                    ${selectHtml('data-set-act="pvQuality"', [
                        { value: 'proxy', label: _t('Bản proxy (nhẹ, mượt)') },
                        { value: 'original', label: _t('Nguồn gốc (nét, nặng)') },
                    ], p.defaultQuality)}
                </label>
                <label>${_t('Chất lượng vùng chuyển cảnh')}
                    ${selectHtml('data-set-act="pvTransition"', [
                        { value: 'auto', label: _t('Tự động (hạ khi đang phát)') },
                        { value: 'sharp', label: _t('Luôn nét') },
                    ], p.transitionQuality)}
                </label>
            </div>
            <p class="set-note">${_t('“Tự động” dựng vùng chuyển cảnh ở độ phân giải khung xem trước khi đang phát rồi trả lại độ nét khi dừng. Chọn “Luôn nét” thì hiệu ứng <b>Xoắn</b> có thể giật, vì nó phải nắn từng điểm ảnh.')}</p>
        </section>
        <section class="set-sec"><h4>${_t('Điều hướng')}</h4>
            <div class="set-nums">${numberRowHtml(_t('Phím ← / → nhảy'), 'frameStep', p.frameStep, 1, 30, 1, _t('khung'), 'frameStep')}</div>
        </section>`;
    }

    function cachePaneHtml() {
        if (!cacheUsage) return `<p class="set-intro">${_t('Đang đọc dung lượng…')}</p>`;
        const rows = cacheUsage.map((it) => `<div class="set-file">
            <span class="set-file-name">${esc(_t(it.label))}</span>
            <span class="set-cache-size">${esc(it.human)} · ${_t('{n} tệp', { n: it.files })}</span>
            ${it.clearable
                ? `<button type="button" class="set-btn" data-set-act="cache-clear" data-cache="${esc(it.id)}">${_t('Dọn')}</button>`
                : `<span class="set-missing">${_t('chỉ đọc')}</span>`}
        </div>`).join('');
        return `<p class="set-intro">${_t('Dữ liệu tạm sinh ra trong lúc làm việc.')}</p>
        <section class="set-sec"><div class="set-card"><div class="set-files">${rows}</div></div>
            <p class="set-note">${_t('<b>Sóng âm</b> và <b>kết quả bóc băng</b> dọn được vì sinh lại được (chỉ mất thời gian chờ lần sau). <b>Dữ liệu dự án đang mở</b> chỉ đọc — đó là nguồn đã nhập, bản proxy và ảnh đã dựng của chính dự án bạn đang làm; xoá tay là mất dự án.')}</p>
        </section>`;
    }

    /* ================= VỀ CRABBYCUT ================= */
    /* Mọi con số / tên ở đây đến từ package.json qua window.AppInfo (xem static/js/app-info.js):
     * nâng version hay đổi giấy phép ở package.json là mục này tự đúng, không có chỗ ghi cứng
     * thứ hai để quên sửa. Chỉ câu về ngoại lệ NVIDIA là chữ cố định — nó là nội dung của
     * LICENSE-EXCEPTION.md, package.json không có trường nào mang nó. */
    function aboutPaneHtml() {
        const info = window.AppInfo?.get?.();
        if (!info) {
            window.AppInfo?.load?.().then(() => { if (activeSection === 'about') render(); });
            return `<p class="set-intro">${_t('Đang đọc thông tin phiên bản…')}</p>`;
        }
        const version = window.AppInfo.versionLabel(info.version);
        const site = String(info.homepage || '').replace(/^https?:\/\//, '');
        const row = (label, value) => (value ? `<dt>${esc(label)}</dt><dd>${value}</dd>` : '');
        const runtime = info.electron
            ? `Electron ${esc(info.electron)} · Chromium ${esc(String(info.chrome || '').split('.')[0])} · ${esc(info.arch || '')}`
            : '';
        const canUpdate = typeof window.desktopEnv?.checkForUpdates === 'function';
        return `<div class="set-about-head">
            <svg class="app-logo" viewBox="0 0 876.8 229.5" role="img" aria-label="CrabbyCut"><use href="#logo-crabbycut"/></svg>
            <span class="set-about-ver">${esc(version)}</span>
        </div>
        <p class="set-intro">${_t('Ứng dụng dựng video tự động theo kịch bản.')}</p>
        <section class="set-sec"><div class="set-card"><dl class="set-kv">
            ${row(_t('Phiên bản'), esc(version))}
            ${row(_t('Tác giả'), esc(info.author))}
            ${row(_t('Giấy phép'), info.license ? `${esc(info.license)} <span class="set-kv-sub">${_t('· kèm ngoại lệ cho thư viện NVIDIA CUDA')}</span>` : '')}
            ${row(_t('Mã nguồn'), esc(site))}
            ${row(_t('Nền tảng'), runtime)}
        </dl></div></section>
        <div class="set-about-actions">
            ${canUpdate ? `<button type="button" class="set-btn" data-set-act="about-update">${_t('Kiểm tra bản mới')}</button>` : ''}
            <button type="button" class="set-btn" data-set-act="about-link" data-link="home">${_t('Trang dự án')}</button>
            <button type="button" class="set-btn" data-set-act="about-link" data-link="issues">${_t('Báo lỗi')}</button>
            <button type="button" class="set-btn" data-set-act="about-link" data-link="license">${_t('Giấy phép')}</button>
        </div>
        <p class="set-note">${_t('Phần mềm tự do, cung cấp nguyên trạng và không kèm bảo hành. Danh sách thành phần bên thứ ba ở tệp THIRD-PARTY-NOTICES.md đi kèm mã nguồn.')}</p>`;
    }

    function render() {
        const host = root();
        if (!host || !draft) return;
        // role=tab + aria-selected (Phase E): cột trái là một dải tab DỌC — trước đây mục
        // đang mở chỉ được đánh dấu bằng màu nền.
        const nav = SECTIONS.map((s) => `<button type="button" class="set-nav-item${s.id === activeSection ? ' is-active' : ''}"`
            + ` role="tab" aria-selected="${s.id === activeSection}" aria-controls="settingsPane"`
            + `${s.ready ? '' : ` disabled title="${_t('Chưa có nội dung')}"`} data-set-nav="${s.id}">${esc(s.label)}</button>`).join('');
        const PANES = {
            general: generalPaneHtml,
            shortcuts: shortcutsPaneHtml,
            autosave: autosavePaneHtml,
            preview: previewPaneHtml,
            cache: cachePaneHtml,
            about: aboutPaneHtml,
            [PANE_ASE]: asePaneHtml,
        };
        const pane = PANES[activeSection]
            ? PANES[activeSection]()
            : `<p class="set-intro">${_t('Mục này chưa có nội dung.')}</p>`;
        host.innerHTML = `<div class="set-nav" role="tablist" aria-orientation="vertical" aria-label="${_t('Mục cài đặt')}">${nav}</div>`
            + `<div class="set-pane" id="settingsPane" role="tabpanel" tabindex="0">${pane}</div>`;
    }

    /* ---------- thao tác trên bản nháp ---------- */

    function findGroup(list, id) { return list.find((g) => g.id === id) || null; }

    function pickedValue(kind, groupId) {
        const sel = root().querySelector(groupId
            ? `select[data-set-pick="${kind}"][data-group="${CSS.escape(groupId)}"]`
            : `select[data-set-pick="${kind}"]`);
        return sel ? sel.value : '';
    }

    function playPreview(rel) {
        const url = `/library/${rel.split('/').map(encodeURIComponent).join('/')}`;
        if (previewAudio) { previewAudio.pause(); previewAudio = null; }
        previewAudio = new Audio(url);
        previewAudio.play().catch(() => {});
    }

    const ACTIONS = {
        'add-anim-group': () => {
            cfg().animGroups.push({ id: nextGroupId(cfg().animGroups, 'a'), name: _t('Nhóm mới'), effects: [] });
        },
        'add-transition-group': () => {
            cfg().transGroups.push({ id: nextGroupId(cfg().transGroups, 't'), name: _t('Nhóm mới'), transitions: [] });
        },
        'add-sfx-group': () => {
            cfg().sfxGroups.push({ id: nextGroupId(cfg().sfxGroups, 'g'), name: _t('Nhóm mới'), files: [], align: 'peak', fit: 'full' });
        },
        'add-anim-member': (el) => {
            const value = pickedValue('anim', el.dataset.group);
            const group = findGroup(cfg().animGroups, el.dataset.group);
            if (value && group && !group.effects.includes(value)) group.effects.push(value);
        },
        'add-transition-member': (el) => {
            const value = pickedValue('transition', el.dataset.group);
            const group = findGroup(cfg().transGroups, el.dataset.group);
            if (value && group && !group.transitions.includes(value)) group.transitions.push(value);
        },
        'add-sfx-file': (el) => {
            const value = pickedValue('sfx', el.dataset.group);
            const group = findGroup(cfg().sfxGroups, el.dataset.group);
            if (value && group && !group.files.some((f) => pathKey(f) === pathKey(value))) group.files.push(value);
        },
        'add-music-file': () => {
            const value = pickedValue('music', '');
            if (value && !cfg().musicFiles.some((f) => pathKey(f) === pathKey(value))) cfg().musicFiles.push(value);
        },
        'del-anim-member': (el) => {
            const group = findGroup(cfg().animGroups, el.dataset.group);
            if (group) group.effects = group.effects.filter((m) => m !== el.dataset.member);
        },
        'del-transition-member': (el) => {
            const group = findGroup(cfg().transGroups, el.dataset.group);
            if (group) group.transitions = group.transitions.filter((m) => m !== el.dataset.member);
        },
        'del-sfx-file': (el) => {
            const group = findGroup(cfg().sfxGroups, el.dataset.group);
            if (group) group.files = group.files.filter((f) => f !== el.dataset.member);
        },
        'del-music-file': (el) => {
            cfg().musicFiles = cfg().musicFiles.filter((f) => f !== el.dataset.member);
        },
        // Xoá nhóm thì xoá luôn luật/dòng Element trỏ tới nó — để lại luật mồ côi thì
        // normalize() cũng vứt, nhưng người dùng sẽ không hiểu vì sao luật biến mất sau khi Lưu.
        'del-anim-group': (el) => {
            cfg().animGroups = cfg().animGroups.filter((g) => g.id !== el.dataset.group);
            cfg().rules = cfg().rules.filter((r) => !(r.source.kind === 'anim' && r.source.group === el.dataset.group));
        },
        'del-transition-group': (el) => {
            cfg().transGroups = cfg().transGroups.filter((g) => g.id !== el.dataset.group);
            cfg().rules = cfg().rules.filter((r) => !(r.source.kind === 'transition' && r.source.group === el.dataset.group));
        },
        'del-sfx-group': (el) => {
            const id = el.dataset.group;
            cfg().sfxGroups = cfg().sfxGroups.filter((g) => g.id !== id);
            cfg().rules = cfg().rules.filter((r) => r.sfxGroup !== id && r.threshold?.elseSfxGroup !== id);
            cfg().elementRules = cfg().elementRules.filter((r) => r.sfxGroup !== id);
            cfg().templateRules = cfg().templateRules.filter((r) => r.sfxGroup !== id);
        },
        'add-rule': () => {
            const anim = cfg().animGroups[0];
            const sfx = cfg().sfxGroups[0];
            if (!anim || !sfx) return;
            cfg().rules.push({ source: { kind: 'anim', group: anim.id }, sfxGroup: sfx.id, threshold: null });
        },
        'del-rule': (el) => { cfg().rules.splice(Number(el.dataset.index), 1); },
        'add-element': () => {
            const files = libraryRelPaths('elements');
            const sfx = cfg().sfxGroups[0];
            if (!files.length || !sfx) return;
            cfg().elementRules.push({ assetName: baseName(files[0]), sfxGroup: sfx.id });
        },
        'del-element': (el) => { cfg().elementRules.splice(Number(el.dataset.index), 1); },
        'add-template': () => {
            const taken = new Set(cfg().templateRules.map((r) => r.templateId));
            const free = templateOptions().find((o) => !taken.has(o.value));
            const sfx = cfg().sfxGroups[0];
            if (!free || !sfx) return;
            cfg().templateRules.push({ templateId: free.value, sfxGroup: sfx.id });
        },
        'del-template': (el) => { cfg().templateRules.splice(Number(el.dataset.index), 1); },
        'preview-file': (el) => { playPreview(el.dataset.file); return false; },

        /* ---- Phím tắt ---- */
        'kb-mod': (el) => {
            const m = el.dataset.mod;
            if (layerMods.has(m)) layerMods.delete(m); else layerMods.add(m);
        },
        'kb-key': (el) => { pickedKeyCode = pickedKeyCode === el.dataset.code ? '' : el.dataset.code; },
        'sc-clear-pick': () => { pickedKeyCode = ''; },
        'sc-capture': (el) => {
            capturingId = capturingId === el.dataset.cmd ? null : el.dataset.cmd;
            pendingConflict = null;
        },
        'sc-reset': () => {
            if (!window.confirm(_t('Khôi phục toàn bộ phím tắt về mặc định?'))) return false;
            keymapDraft = window.Shortcuts.defaultKeymap();
            capturingId = null;
            pendingConflict = null;
        },
        'sc-conflict-ok': () => {
            // Gỡ phím khỏi các lệnh đang giữ rồi mới gán — đúng cách Premiere xử lý xung đột.
            pendingConflict.holders.forEach((id) => { keymapDraft[id] = ''; });
            keymapDraft[pendingConflict.id] = pendingConflict.combo;
            pendingConflict = null;
            capturingId = null;
        },
        'sc-conflict-cancel': () => { pendingConflict = null; capturingId = null; },

        /* ---- Bộ nhớ đệm ---- */
        'cache-clear': (el) => {
            const id = el.dataset.cache;
            const item = (cacheUsage || []).find((x) => x.id === id);
            if (!item || !window.confirm(_t('Dọn "{name}" ({size})?\n\nDữ liệu này sẽ được sinh lại khi cần.', { name: _t(item.label), size: item.human }))) return false;
            fetch(`${API_BASE}/cache/clear`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
            }).then(() => loadCacheUsage()).catch((err) => alert(err.message || String(err)));
            return false;
        },

        /* ---- Về CrabbyCut ---- */
        'about-update': () => {
            window.desktopEnv?.checkForUpdates?.().catch((err) => alert(err.message || String(err)));
            return false;
        },
        /* Desktop: gửi KHOÁ cho main (main tự dựng URL — xem `open-project-link` ở main.js).
           Bản web: mở tab mới từ homepage của package.json. */
        'about-link': (el) => {
            const key = el.dataset.link;
            if (window.desktopEnv?.openProjectLink) {
                window.desktopEnv.openProjectLink(key);
                return false;
            }
            const home = String(window.AppInfo?.get?.()?.homepage || '');
            const url = { home, issues: home && `${home}/issues`, license: home && `${home}/blob/main/LICENSE` }[key];
            if (url && /^https:\/\//.test(url)) window.open(url, '_blank', 'noopener');
            return false;
        },
    };

    // Thao tác đổi giá trị (select / input), tách khỏi ACTIONS vì chạy ở sự kiện change.
    const CHANGES = {
        'rename-anim': (el) => { const g = findGroup(cfg().animGroups, el.dataset.group); if (g) g.name = el.value; return false; },
        'rename-transition': (el) => { const g = findGroup(cfg().transGroups, el.dataset.group); if (g) g.name = el.value; return false; },
        'rename-sfx': (el) => { const g = findGroup(cfg().sfxGroups, el.dataset.group); if (g) g.name = el.value; return true; },
        'set-align': (el) => { const g = findGroup(cfg().sfxGroups, el.dataset.group); if (g) g.align = el.value; return false; },
        'set-fit': (el) => { const g = findGroup(cfg().sfxGroups, el.dataset.group); if (g) g.fit = el.value; return false; },
        'rule-source': (el) => {
            const [kind, group] = String(el.value).split(':');
            cfg().rules[Number(el.dataset.index)].source = { kind, group };
            return false;
        },
        'rule-sfx': (el) => { cfg().rules[Number(el.dataset.index)].sfxGroup = el.value; return false; },
        'rule-th-toggle': (el) => {
            const rule = cfg().rules[Number(el.dataset.index)];
            const fallback = cfg().sfxGroups.find((g) => g.id !== rule.sfxGroup) || cfg().sfxGroups[0];
            rule.threshold = el.checked && fallback ? { maxDuration: 0.8, elseSfxGroup: fallback.id } : null;
            return true;
        },
        'rule-th-dur': (el) => {
            const rule = cfg().rules[Number(el.dataset.index)];
            if (rule.threshold) rule.threshold.maxDuration = Number(el.value);
            return false;
        },
        'rule-th-else': (el) => {
            const rule = cfg().rules[Number(el.dataset.index)];
            if (rule.threshold) rule.threshold.elseSfxGroup = el.value;
            return false;
        },
        'el-name': (el) => { cfg().elementRules[Number(el.dataset.index)].assetName = el.value; return true; },
        'el-sfx': (el) => { cfg().elementRules[Number(el.dataset.index)].sfxGroup = el.value; return false; },
        'tpl-id': (el) => { cfg().templateRules[Number(el.dataset.index)].templateId = el.value; return true; },
        'tpl-sfx': (el) => { cfg().templateRules[Number(el.dataset.index)].sfxGroup = el.value; return false; },
        'level': (el) => { cfg().levels[el.dataset.key] = Number(el.value); return false; },

        /* ---- Chung / Auto save / Xem trước ---- */
        'undoSteps': (el) => { draft.general.undoSteps = Number(el.value); return false; },
        'snapDefault': (el) => { draft.general.snapDefault = el.checked; return false; },
        'devMode': (el) => { draft.general.devMode = el.checked; return false; },
        'language': (el) => { draft.general.language = el.value; return false; },
        'asEnabled': (el) => { draft.autoSave.enabled = el.checked; return false; },
        'intervalMin': (el) => { draft.autoSave.intervalMin = Number(el.value); return false; },
        'keepVersions': (el) => { draft.autoSave.keepVersions = Number(el.value); return false; },
        'warnOnExit': (el) => { draft.autoSave.warnOnExit = el.checked; return false; },
        'pvQuality': (el) => { draft.preview.defaultQuality = el.value; return false; },
        'pvTransition': (el) => { draft.preview.transitionQuality = el.value; return false; },
        'frameStep': (el) => { draft.preview.frameStep = Number(el.value); return false; },
        'sc-search': (el) => { keyFilter = el.value; return false; },
    };

    async function loadCacheUsage() {
        try {
            const resp = await fetch(`${API_BASE}/cache/usage`);
            const data = resp.ok ? await resp.json() : null;
            cacheUsage = Array.isArray(data?.items) ? data.items : [];
        } catch (_) {
            cacheUsage = [];
        }
        if (activeSection === 'cache') render();
    }

    /* Bắt phím cho ô "Nhấn tổ hợp phím…". Nghe ở pha CAPTURE trên `document` và nuốt sự
     * kiện: nếu không, chính phím đang gán sẽ chạy lệnh của nó (gán Space là preview phát
     * luôn, gán ⌘S là mở hộp thoại lưu). Đây cũng là lý do không thể tái dụng ô input
     * thường — phải chặn ở tầng cao nhất.
     *   Esc  -> huỷ bắt
     *   Del  -> bỏ trống phím của lệnh
     * Tổ hợp trùng lệnh khác thì KHÔNG gán ngay: dựng dải cảnh báo để người dùng quyết,
     * đúng cách Premiere làm. */
    function onCaptureKeydown(event) {
        if (!capturingId || !isOpen() || !window.Shortcuts) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') { capturingId = null; render(); return; }
        const S = window.Shortcuts;
        if (event.code === 'Delete' || event.code === 'Backspace') {
            // Delete là phím tắt hợp lệ của app; ở đây nó mang nghĩa "bỏ trống" nên chỉ
            // nhận khi KHÔNG kèm bổ trợ (Cmd+Delete… vẫn gán được như bình thường).
            if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
                keymapDraft[capturingId] = '';
                capturingId = null;
                render();
                return;
            }
        }
        const combo = S.comboFromEvent(event);
        if (!combo) return;                       // mới nhấn riêng phím bổ trợ, chờ tiếp
        const holders = S.conflictsOf(keymapDraft, combo, capturingId);
        if (holders.length) {
            pendingConflict = { id: capturingId, combo, holders };
            render();
            return;
        }
        keymapDraft[capturingId] = combo;
        capturingId = null;
        render();
    }

    function bind() {
        if (bound) return;
        bound = true;
        const host = root();
        if (!host) return;
        document.addEventListener('keydown', onCaptureKeydown, true);

        host.addEventListener('click', (event) => {
            const nav = event.target.closest('[data-set-nav]');
            if (nav && !nav.disabled) {
                activeSection = nav.dataset.setNav;
                if (activeSection === 'cache' && !cacheUsage) loadCacheUsage();
                render();
                return;
            }
            const btn = event.target.closest('[data-set-act]');
            if (!btn || btn.tagName === 'SELECT' || btn.tagName === 'INPUT') return;
            const fn = ACTIONS[btn.dataset.setAct];
            if (!fn) return;
            if (fn(btn) !== false) render();
        });

        // `change` cho select/checkbox/number; `input` cho ô tên (gõ tới đâu ghi tới đó,
        // KHÔNG render lại — render lại sẽ cướp con trỏ đang gõ, nên các handler tên trả false).
        const apply = (event) => {
            const el = event.target.closest('[data-set-act]');
            if (!el || !(el.tagName === 'SELECT' || el.tagName === 'INPUT')) return;
            const fn = CHANGES[el.dataset.setAct];
            if (!fn) return;
            if (fn(el)) render();
        };
        host.addEventListener('change', apply);
        host.addEventListener('input', (event) => {
            if (event.target.classList.contains('set-name')) apply(event);
        });

        document.getElementById('btnSettingsSave')?.addEventListener('click', async () => {
            try {
                // Keymap giữ dạng ĐẦY ĐỦ trong lúc sửa (dễ tra), nhưng chỉ GHI phần khác
                // mặc định — xem chú thích ở app-settings.js.
                if (window.Shortcuts && keymapDraft) draft.shortcuts = window.Shortcuts.keymapOverrides(keymapDraft);
                // So với ngôn ngữ ĐANG HIỆN (đã phân giải 'auto'), không so với giá trị cũ trong
                // cài đặt: 'auto' -> 'en' trên Windows tiếng Anh là không đổi gì, khỏi tải lại.
                const I = window.I18n;
                const nextLocale = I ? I.resolve(draft.general.language,
                    window.__CRAB_I18N__?.systemLocale || navigator.language) : null;
                const languageChanged = !!I && nextLocale !== I.getLocale();
                await AppSettings.save(draft);
                close();
                if (languageChanged && typeof window.reloadForLanguageChange === 'function'
                    && window.confirm(_t('Đã lưu. Tải lại giao diện ngay để áp dụng ngôn ngữ mới?'))) {
                    await window.reloadForLanguageChange();
                }
            } catch (err) {
                alert(err.message || String(err));
            }
        });
        document.getElementById('btnSettingsCancel')?.addEventListener('click', () => close());
        document.getElementById('btnSettingsReset')?.addEventListener('click', async () => {
            if (!window.confirm(_t('Khôi phục toàn bộ cài đặt về mặc định?'))) return;
            try {
                const next = await AppSettings.reset();
                draft = JSON.parse(JSON.stringify(next));
                keymapDraft = window.Shortcuts ? window.Shortcuts.mergeKeymap(draft.shortcuts) : null;
                capturingId = null;
                pendingConflict = null;
                render();
            } catch (err) {
                alert(err.message || String(err));
            }
        });
    }

    /* ---------- mở / đóng ---------- */

    async function open() {
        if (!window.AppSettings) return;
        const current = await AppSettings.ready();
        // Bản nháp là BẢN SAO SÂU: sửa thoải mái, huỷ thì cấu hình đang chạy còn nguyên.
        draft = JSON.parse(JSON.stringify(current));
        // Keymap dùng dạng ĐẦY ĐỦ khi sửa; lúc Lưu mới rút về phần khác mặc định.
        keymapDraft = window.Shortcuts ? window.Shortcuts.mergeKeymap(draft.shortcuts) : null;
        capturingId = null;
        pendingConflict = null;
        keyFilter = '';
        pickedKeyCode = '';
        layerMods = new Set();
        cacheUsage = null;
        await Promise.all(['sfxs', 'music', 'elements'].map(ensureLibrary));
        if (activeSection === 'cache') loadCacheUsage();
        document.body.classList.add('settings-modal-open');
        const panel = document.getElementById('settingsModalPanel');
        panel?.classList.add('active');
        render();
        bind();
        // Bẫy focus (Phase E). ESC do handler ở index.html lo -> không truyền onEscape.
        // Focus vào mục đang mở ở cột trái, không phải nút Đóng.
        releaseTrap?.();
        releaseTrap = window.UiA11y?.trapFocus(panel, {
            initial: () => panel?.querySelector('.set-nav-item.is-active'),
        }) || null;
    }

    let releaseTrap = null;

    function close() {
        if (previewAudio) { previewAudio.pause(); previewAudio = null; }
        draft = null;
        capturingId = null;
        pendingConflict = null;
        document.body.classList.remove('settings-modal-open');
        document.getElementById('settingsModalPanel')?.classList.remove('active');
        releaseTrap?.();
        releaseTrap = null;
    }

    function isOpen() {
        return document.body.classList.contains('settings-modal-open');
    }

    window.SettingsPanel = { open, close, isOpen };
})();
