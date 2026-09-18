/**
 * PHÍM TẮT — DANH MỤC LỆNH + BỘ SO KHỚP
 * =====================================
 * Nguồn sự thật DUY NHẤT cho mọi phím tắt "lệnh" của app. Trước đây phím được so khớp
 * bằng chuỗi `if (e.code === 'KeyS')` rải rác trong 2 bộ điều phối, nên (a) không đổi được,
 * (b) không có chỗ nào liệt kê ra được để hiển thị cho người dùng, (c) nhãn hiển thị
 * (tooltip, mục Menu) là chuỗi chép tay, sửa phím một nơi là lệch nơi kia.
 *
 * Module thuần, không đụng DOM, UMD như app-settings.js / auto-sfx-assets.js để test bằng Node.
 *
 * DÙNG `event.code` (PHÍM VẬT LÝ), không dùng `event.key`:
 *   - Giữ đúng hành vi mã cũ (nó vốn đã so `e.code`).
 *   - `key` đổi theo bố cục bàn phím và theo Shift ('s' -> 'S'), nên keymap lưu bằng `key`
 *     sẽ hỏng khi người dùng đổi bố cục. Premiere cũng gán theo vị trí phím.
 *
 * PHẠM VI: chỉ các lệnh THẬT SỰ (mở/lưu, hoàn tác, phát, chọn…). Các phím NGỮ CẢNH
 * (Esc đóng hộp thoại, Enter chốt ô nhập, Esc huỷ ống hút màu…) CỐ TÌNH không đổi được —
 * gán nhầm là tự khoá mình khỏi hộp thoại. Chúng được khai ở CONTEXT_KEYS chỉ để bảng
 * Cài đặt liệt kê ra cho đủ, đúng cách Premiere làm.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.Shortcuts = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    /* ---- Bổ trợ ----
     * 'Cmd' gộp cả metaKey (macOS) lẫn ctrlKey (Windows/Linux) vì toàn bộ mã hiện tại đang
     * so `e.ctrlKey || e.metaKey`. Giữ nguyên quy ước đó: một tổ hợp 'Cmd+KeyS' chạy được
     * bằng ⌘S trên Mac và Ctrl+S trên Windows, không phải khai hai lần.
     * 'Ctrl' RIÊNG (chỉ ctrlKey, không metaKey) chưa lệnh nào dùng nhưng vẫn hỗ trợ để
     * người dùng gán được. */
    const MOD_ORDER = ['Cmd', 'Ctrl', 'Alt', 'Shift'];

    // Nhóm hiển thị trong bảng Cài đặt.
    const GROUPS = [
        { id: 'file', label: 'Tệp' },
        { id: 'edit', label: 'Chỉnh sửa' },
        { id: 'tool', label: 'Công cụ' },
        { id: 'playback', label: 'Phát lại' },
        { id: 'select', label: 'Chọn' },
    ];

    /* `allowInInput: true` = phím vẫn chạy KHI ĐANG GÕ trong textarea/input. Đúng hành vi
     * sẵn có của ⌘S/⌘O (chúng cố ý đặt TRƯỚC guard gõ chữ ở index.html) — đang gõ kịch bản
     * mà ⌘S không lưu được thì rất khó chịu. */
    const COMMANDS = [
        { id: 'project.save', group: 'file', label: 'Lưu dự án', combo: 'Cmd+KeyS', allowInInput: true },
        { id: 'project.saveAs', group: 'file', label: 'Lưu thành…', combo: 'Cmd+Shift+KeyS', allowInInput: true },
        { id: 'project.open', group: 'file', label: 'Mở dự án…', combo: 'Cmd+KeyO', allowInInput: true },
        { id: 'app.settings', group: 'file', label: 'Mở Cài đặt', combo: 'Cmd+Comma', allowInInput: true },

        { id: 'edit.undo', group: 'edit', label: 'Hoàn tác', combo: 'Cmd+KeyZ' },
        { id: 'edit.redo', group: 'edit', label: 'Làm lại', combo: 'Cmd+Shift+KeyZ' },
        { id: 'edit.delete', group: 'edit', label: 'Xoá block / clip đang chọn', combo: 'Delete' },

        { id: 'tool.razor', group: 'tool', label: 'Dao cắt (bật/tắt)', combo: 'Cmd+KeyK' },

        { id: 'playback.togglePlay', group: 'playback', label: 'Phát / Tạm dừng', combo: 'Space' },
        { id: 'playback.prevFrame', group: 'playback', label: 'Lùi một khung hình', combo: 'ArrowLeft' },
        { id: 'playback.nextFrame', group: 'playback', label: 'Tiến một khung hình', combo: 'ArrowRight' },

        { id: 'select.blocksLeft', group: 'select', label: 'Chọn các block bên trái', combo: 'Alt+BracketLeft' },
        { id: 'select.blocksRight', group: 'select', label: 'Chọn các block bên phải', combo: 'Alt+BracketRight' },
    ];

    /* Phím NGỮ CẢNH — chỉ để liệt kê, KHÔNG đổi được. `combo` ở đây là chuỗi hiển thị sẵn
     * chứ không phải tổ hợp chuẩn hoá, vì nhiều dòng là "Delete hoặc Backspace". */
    const CONTEXT_KEYS = [
        { display: 'Esc', label: 'Đóng hộp thoại đang mở (Cài đặt · Xuất video · Chụp khung hình · Menu)' },
        { display: 'Esc', label: 'Đóng lớp xem trước tệp ở panel trái' },
        { display: 'Esc', label: 'Huỷ ống hút màu / cân bằng trắng' },
        { display: 'Esc', label: 'Kết thúc sửa text trên preview (không lưu thay đổi)' },
        { display: 'Enter', label: 'Chốt giá trị ô nhập ở bảng thông số' },
        { display: 'Esc', label: 'Huỷ sửa ô nhập, trả về giá trị cũ' },
        { display: 'Enter / Esc', label: 'Trả lời popup "tách block tại điểm đổi góc máy?"' },
        { display: '⌘ / Ctrl + bấm', label: 'Chọn thêm / bỏ chọn từng block trên timeline' },
        { display: 'Kéo quét vùng trống', label: 'Chọn mọi block trong khung quét (giữ ⌘/Ctrl để cộng dồn)' },
        { display: 'Bấm vùng trống', label: 'Bỏ chọn tất cả' },
        { display: 'Alt + kéo block', label: 'Nhân bản block' },
        { display: 'Alt + lăn chuột', label: 'Phóng to/thu nhỏ timeline' },
        { display: 'Shift + lăn chuột', label: 'Hít playhead vào mốc block' },
        { display: 'Shift / Alt + kéo số', label: 'Tinh chỉnh ×0.1 / tăng nhanh ×10 ở bảng thông số' },
    ];

    const COMMAND_BY_ID = COMMANDS.reduce((m, c) => { m[c.id] = c; return m; }, {});
    const COMMAND_IDS = COMMANDS.map((c) => c.id);

    function commandById(id) { return COMMAND_BY_ID[id] || null; }

    /* ---- Chuẩn hoá tổ hợp ----
     * Dạng chuẩn: các bổ trợ theo ĐÚNG thứ tự MOD_ORDER rồi tới mã phím, nối bằng '+'.
     * Cố định thứ tự để 'Shift+Cmd+KeyS' và 'Cmd+Shift+KeyS' là MỘT, nếu không thì so sánh
     * và dò trùng đều sai. */
    const MODIFIER_CODES = new Set([
        'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
        'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock',
    ]);

    function comboFromEvent(event) {
        if (!event || !event.code) return '';
        if (MODIFIER_CODES.has(event.code)) return '';   // mới nhấn bổ trợ, chưa thành tổ hợp
        const mods = [];
        if (event.metaKey || event.ctrlKey) mods.push('Cmd');
        if (event.altKey) mods.push('Alt');
        if (event.shiftKey) mods.push('Shift');
        return [...mods, event.code].join('+');
    }

    /* Mã phím CHẤP NHẬN ĐƯỢC. Cần thật sự kiểm, không chỉ "khác rỗng": file cài đặt hỏng
     * hoặc sửa tay có thể chứa chuỗi bất kỳ, mà một binding không bao giờ khớp `event.code`
     * thì im lặng vô hiệu — người dùng thấy phím tắt hiện trong bảng nhưng bấm không ăn. */
    const NAMED_CODES = new Set([
        'Space', 'Enter', 'Tab', 'Delete', 'Backspace', 'Escape',
        'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
        'Home', 'End', 'PageUp', 'PageDown', 'Insert',
        'Comma', 'Period', 'Slash', 'Backslash', 'Semicolon', 'Quote',
        'BracketLeft', 'BracketRight', 'Minus', 'Equal', 'Backquote', 'IntlBackslash',
    ]);

    function isValidKeyCode(code) {
        if (!code || MODIFIER_CODES.has(code)) return false;
        if (NAMED_CODES.has(code)) return true;
        return /^Key[A-Z]$/.test(code)
            || /^Digit[0-9]$/.test(code)
            || /^F([1-9]|1[0-9]|2[0-4])$/.test(code)
            || /^Numpad[A-Za-z0-9]+$/.test(code);
    }

    // Chuẩn hoá chuỗi người dùng/cấu hình đưa vào: sắp lại thứ tự bổ trợ, bỏ phần rác.
    // '' nếu không hợp lệ.
    function normalizeCombo(raw) {
        const parts = String(raw == null ? '' : raw).split('+').map((s) => s.trim()).filter(Boolean);
        if (!parts.length) return '';
        const mods = new Set();
        let code = '';
        parts.forEach((p) => {
            const m = MOD_ORDER.find((x) => x.toLowerCase() === p.toLowerCase());
            if (m) { mods.add(m); return; }
            code = p;   // phần không phải bổ trợ = mã phím; nhiều mã thì lấy cái cuối
        });
        if (!isValidKeyCode(code)) return '';
        return [...MOD_ORDER.filter((m) => mods.has(m)), code].join('+');
    }

    /* ---- Hiển thị ----
     * macOS dùng ký hiệu (⌘⌥⇧⌃) không có dấu '+', đúng quy ước hệ điều hành; nơi khác dùng
     * chữ nối bằng '+'. */
    const KEY_LABELS = {
        Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
        Delete: 'Delete', Backspace: 'Backspace', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab',
        Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
        BracketLeft: '[', BracketRight: ']', Minus: '−', Equal: '=', Backquote: '`',
    };

    function keyLabel(code) {
        if (KEY_LABELS[code]) return KEY_LABELS[code];
        if (/^Key[A-Z]$/.test(code)) return code.slice(3);
        if (/^Digit[0-9]$/.test(code)) return code.slice(5);
        if (/^F[0-9]{1,2}$/.test(code)) return code;
        if (/^Numpad/.test(code)) return `Num ${code.slice(6)}`;
        return code;
    }

    function isMacPlatform(platform) {
        const p = platform != null ? String(platform) : (
            (typeof navigator !== 'undefined' && (navigator.userAgentData?.platform || navigator.platform)) || ''
        );
        return /mac|darwin/i.test(p);
    }

    function formatCombo(combo, platform) {
        const norm = normalizeCombo(combo);
        if (!norm) return '';
        const parts = norm.split('+');
        const code = parts.pop();
        const mods = new Set(parts);
        const mac = isMacPlatform(platform);
        if (mac) {
            let out = '';
            if (mods.has('Ctrl')) out += '⌃';
            if (mods.has('Alt')) out += '⌥';
            if (mods.has('Shift')) out += '⇧';
            if (mods.has('Cmd')) out += '⌘';
            return out + keyLabel(code);
        }
        const names = [];
        if (mods.has('Cmd') || mods.has('Ctrl')) names.push('Ctrl');
        if (mods.has('Alt')) names.push('Alt');
        if (mods.has('Shift')) names.push('Shift');
        names.push(keyLabel(code));
        return names.join('+');
    }

    /* ---- Keymap ----
     * Chỉ lưu phần KHÁC mặc định. Nhờ vậy khi bản sau đổi phím mặc định của một lệnh,
     * người dùng chưa từng gán tay sẽ nhận phím mới thay vì kẹt ở phím cũ. */
    function defaultKeymap() {
        return COMMANDS.reduce((m, c) => { m[c.id] = c.combo; return m; }, {});
    }

    function mergeKeymap(overrides) {
        const map = defaultKeymap();
        const src = overrides && typeof overrides === 'object' ? overrides : {};
        Object.keys(src).forEach((id) => {
            if (!COMMAND_BY_ID[id]) return;                       // lệnh không còn tồn tại
            const combo = src[id] === '' ? '' : normalizeCombo(src[id]);
            if (combo === '' && src[id] !== '') return;           // chuỗi rác -> giữ mặc định
            map[id] = combo;                                     // '' = người dùng CỐ Ý bỏ trống
        });
        return map;
    }

    // Chỉ giữ các mục KHÁC mặc định, để ghi vào file cài đặt.
    function keymapOverrides(keymap) {
        const def = defaultKeymap();
        const out = {};
        Object.keys(def).forEach((id) => {
            const cur = keymap && Object.prototype.hasOwnProperty.call(keymap, id) ? keymap[id] : def[id];
            const norm = cur === '' ? '' : normalizeCombo(cur);
            if (norm !== def[id]) out[id] = norm;
        });
        return out;
    }

    /** Lệnh khớp với sự kiện bàn phím; null nếu không có. */
    function resolve(keymap, event) {
        const combo = comboFromEvent(event);
        if (!combo) return null;
        const map = keymap || defaultKeymap();
        const hit = COMMAND_IDS.find((id) => map[id] && map[id] === combo);
        return hit || null;
    }

    /** Các lệnh đang giữ `combo` (trừ `exceptId`) — dùng cho dải cảnh báo xung đột. */
    function conflictsOf(keymap, combo, exceptId) {
        const norm = normalizeCombo(combo);
        if (!norm) return [];
        const map = keymap || defaultKeymap();
        return COMMAND_IDS.filter((id) => id !== exceptId && map[id] === norm);
    }

    /* Đang gõ chữ thì bỏ qua phím tắt. Trước đây logic này bị CHÉP ở 2 chỗ với khác biệt
     * nhỏ (bản ở index.html thiếu `?.` nên ném TypeError khi activeElement là null). Một
     * bản dùng chung, có optional chaining. */
    function isTypingTarget(el) {
        const tag = el?.tagName;
        return tag === 'TEXTAREA' || tag === 'INPUT' || el?.isContentEditable === true;
    }

    /* Ghi lại nhãn phím tắt trên UI từ keymap ĐANG DÙNG. Trước đây 8 chỗ (3 mục Menu,
     * 5 tooltip nút) chép cứng chuỗi '⌘S', '(Ctrl + Z)'… — đổi phím là bảng Cài đặt nói
     * một đằng, tooltip nói một nẻo.
     *   - `.app-menu-shortcut`  -> ghi vào textContent
     *   - phần tử khác          -> ghi `title` = "<data-shortcut-title> (<phím>)"
     * Chỉ chạy ở trình duyệt; gọi lúc khởi động và mỗi lần lưu cài đặt. */
    function syncLabels(keymap, doc) {
        const d = doc || (typeof document !== 'undefined' ? document : null);
        if (!d) return 0;
        const map = keymap || defaultKeymap();
        const nodes = d.querySelectorAll('[data-shortcut-cmd]');
        nodes.forEach((el) => {
            const id = el.getAttribute('data-shortcut-cmd');
            const text = formatCombo(map[id]);
            if (el.classList.contains('app-menu-shortcut')) {
                el.textContent = text;
                return;
            }
            const base = el.getAttribute('data-shortcut-title') || '';
            el.title = text ? `${base} (${text})` : base;
        });
        return nodes.length;
    }

    return {
        MOD_ORDER,
        GROUPS,
        syncLabels,
        COMMANDS,
        COMMAND_IDS,
        CONTEXT_KEYS,
        commandById,
        comboFromEvent,
        normalizeCombo,
        isValidKeyCode,
        keyLabel,
        formatCombo,
        isMacPlatform,
        defaultKeymap,
        mergeKeymap,
        keymapOverrides,
        resolve,
        conflictsOf,
        isTypingTarget,
    };
});
