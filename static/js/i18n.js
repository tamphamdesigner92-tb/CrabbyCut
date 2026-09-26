/**
 * ĐA NGÔN NGỮ GIAO DIỆN (i18n)
 * ============================
 * Một module dùng chung cho renderer (index.html + static/js/*), backend (server.js require
 * thẳng file này) và Electron main (hộp thoại gốc, cửa sổ Setup). Cùng khuôn UMD với
 * app-settings.js.
 *
 * KIỂU GETTEXT — KHOÁ LÀ CHÍNH CÂU TIẾNG VIỆT:
 *     _t('Hoàn tác')                          -> 'Undo' (en) / '撤销' (zh) / 'Hoàn tác' (vi)
 *     _t('Đã xoá {n} clip', { n: 3 })         -> 'Deleted 3 clips'
 * Tiếng Việt là ngôn ngữ NGUỒN: không có từ điển vi, _t() trả lại đúng khoá. Nhờ vậy code vẫn
 * đọc được như cũ và mọi test đang so chuỗi tiếng Việt vẫn xanh. Từ điển en/zh nằm ở
 * static/i18n/<locale>.json — khoá là câu tiếng Việt đã CHUẨN HOÁ KHOẢNG TRẮNG (mọi chuỗi
 * khoảng trắng thành một dấu cách, bỏ đầu/cuối), nên xuống dòng/thụt lề trong template
 * literal không làm lệch khoá.
 *
 * Giá trị trong từ điển có thể là object số nhiều cho tiếng Anh:
 *     "Đã xoá {n} clip": { "one": "Deleted {n} clip", "other": "Deleted {n} clips" }
 * — chọn theo params.n (n === 1 -> one).
 *
 * ĐỔI NGÔN NGỮ = TẢI LẠI GIAO DIỆN (giống Premiere phải khởi động lại): ngôn ngữ chốt MỘT
 * lần lúc nạp trang, từ `window.__CRAB_I18N__` do backend chèn vào index.html (xem
 * injectI18n ở backend/server.js). Không có cơ chế vẽ lại nóng — hằng số cấp module
 * (`const SECTIONS = [{ label: _t('Chung') }]`) vì thế dịch đúng ngay.
 *
 * Phần markup TĨNH của index.html không phải bọc _t(): translateDom() đi một lượt lúc khởi
 * động, thay text node + thuộc tính (title, placeholder, aria-label, alt) khớp nguyên văn một
 * khoá. Phần tử có `data-i18n-skip` (và mọi con của nó) bị bỏ qua; phần tử có
 * `data-i18n-html` được dịch theo NGUYÊN innerHTML (dùng cho câu có <b>/<kbd> xen giữa, vì
 * thứ tự từ tiếng Trung/Anh khác tiếng Việt nên không dịch từng mảnh được).
 *
 * Quy ước thuật ngữ + cách thêm chuỗi mới: docs/I18N.md.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.I18n = api;
    // Tên ngắn dùng khắp nơi. `_t` vì `t` đã là biến thời gian ở hàng trăm chỗ.
    root._t = api.t;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const SUPPORTED = ['vi', 'en', 'zh'];
    // Nhãn hiện trong ô chọn ngôn ngữ — LUÔN viết bằng chính ngôn ngữ đó, không dịch.
    const NATIVE_NAMES = { vi: 'Tiếng Việt', en: 'English', zh: '简体中文' };
    // Thẻ BCP-47 cho Intl/toLocaleString và <html lang>.
    const TAGS = { vi: 'vi-VN', en: 'en-US', zh: 'zh-CN' };

    const dicts = {};            // locale -> Map(khoá đã chuẩn hoá -> bản dịch)
    const cache = new Map();     // khoá THÔ -> bản dịch (hoặc null = không có), theo locale hiện tại
    const missing = new Set();
    let locale = 'vi';

    function normKey(key) {
        return String(key).replace(/\s+/g, ' ').trim();
    }

    /** 'auto' / thiếu -> theo ngôn ngữ hệ điều hành; tiếng Trung mọi biến thể -> zh (giản thể). */
    function resolve(preference, systemLocale) {
        if (SUPPORTED.includes(preference)) return preference;
        const sys = String(systemLocale || '').toLowerCase();
        if (sys.startsWith('vi')) return 'vi';
        if (sys.startsWith('zh')) return 'zh';
        return 'en';
    }

    function register(loc, table) {
        if (!SUPPORTED.includes(loc) || !table || typeof table !== 'object') return;
        const map = dicts[loc] || new Map();
        Object.keys(table).forEach((k) => {
            if (k.startsWith('//')) return;          // dòng ghi chú trong JSON
            map.set(normKey(k), table[k]);
        });
        dicts[loc] = map;
        if (loc === locale) cache.clear();
    }

    function setLocale(loc) {
        const next = SUPPORTED.includes(loc) ? loc : 'vi';
        if (next === locale) return;
        locale = next;
        cache.clear();
        missing.clear();
    }

    function interpolate(text, params) {
        if (!params) return text;
        return text.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(params, name)
            ? String(params[name]) : m));
    }

    function lookup(key) {
        if (locale === 'vi') return null;
        if (cache.has(key)) return cache.get(key);
        const map = dicts[locale];
        const hit = map ? map.get(normKey(key)) : undefined;
        const value = hit === undefined ? null : hit;
        if (value === null) missing.add(normKey(key));
        cache.set(key, value);
        return value;
    }

    /** Dịch một câu. Không có bản dịch -> trả lại câu tiếng Việt (không bao giờ ra khoá rỗng). */
    function t(key, params) {
        if (key == null) return '';
        let text = String(key);
        const hit = lookup(text);
        if (hit != null) {
            if (typeof hit === 'object') {
                const n = params && Number(params.n);
                text = String((n === 1 ? hit.one : hit.other) ?? hit.other ?? hit.one ?? text);
            } else {
                text = String(hit);
            }
        }
        return interpolate(text, params);
    }

    /** Có bản dịch cho khoá này ở ngôn ngữ hiện tại không (vi luôn true). */
    function has(key) {
        return locale === 'vi' || lookup(String(key)) != null;
    }

    // `label` là nhãn của <optgroup> (và <option label>).
    const DOM_ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'label'];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

    function translateText(raw) {
        const key = normKey(raw);
        if (!key) return null;
        const hit = lookup(key);
        if (hit == null || typeof hit === 'object') return null;
        // Giữ khoảng trắng đầu/cuối: nó là khoảng cách giữa text node và phần tử kế bên.
        const lead = raw.match(/^\s*/)[0];
        const tail = raw.match(/\s*$/)[0];
        return lead + hit + tail;
    }

    /**
     * Dịch markup TĨNH (một lần lúc khởi động). KHÔNG gọi lên vùng có nội dung người dùng
     * (tên dự án, chữ trong kịch bản…): một chữ người dùng tình cờ trùng khoá sẽ bị dịch mất.
     */
    function translateDom(rootEl) {
        if (locale === 'vi' || !rootEl || typeof document === 'undefined') return;
        const translateAttrs = (el) => DOM_ATTRS.forEach((attr) => {
            const v = el.getAttribute(attr);
            if (v == null) return;
            const next = translateText(v);
            if (next != null) el.setAttribute(attr, next);
        });
        const walk = (el) => {
            if (el.nodeType !== 1 || el.hasAttribute('data-i18n-skip')) return;
            // <textarea>: nội dung là chữ người dùng -> không đụng, nhưng placeholder/title vẫn dịch.
            if (el.tagName === 'TEXTAREA') { translateAttrs(el); return; }
            if (SKIP_TAGS.has(el.tagName)) return;
            if (el.isContentEditable && el.getAttribute('contenteditable') != null) return;
            translateAttrs(el);
            if (el.hasAttribute('data-i18n-html')) {
                const hit = lookup(normKey(el.innerHTML));
                if (hit != null && typeof hit !== 'object') {
                    el.innerHTML = hit;
                    return;
                }
            }
            // <template> giữ con trong .content, không phải childNodes.
            const kids = el.tagName === 'TEMPLATE' ? el.content.childNodes : el.childNodes;
            Array.from(kids).forEach((node) => {
                if (node.nodeType === 3) {
                    const next = translateText(node.nodeValue);
                    if (next != null) node.nodeValue = next;
                } else if (node.nodeType === 1) {
                    walk(node);
                } else if (node.nodeType === 11) {
                    Array.from(node.childNodes).forEach((c) => c.nodeType === 1 && walk(c));
                }
            });
        };
        walk(rootEl);
    }

    /** Định dạng số theo ngôn ngữ giao diện (1.234,5 ở vi; 1,234.5 ở en/zh). */
    function formatNumber(value, options) {
        try { return Number(value).toLocaleString(TAGS[locale], options); } catch (_) { return String(value); }
    }

    // Khởi động trong trình duyệt: backend chèn { language, systemLocale } trước thẻ script này.
    if (typeof window !== 'undefined' && window.__CRAB_I18N__) {
        const boot = window.__CRAB_I18N__;
        locale = resolve(boot.language, boot.systemLocale
            || (typeof navigator !== 'undefined' ? (navigator.languages || [])[0] || navigator.language : ''));
    }

    return {
        SUPPORTED,
        NATIVE_NAMES,
        t,
        has,
        register,
        resolve,
        setLocale,
        getLocale: () => locale,
        tag: () => TAGS[locale],
        translateDom,
        formatNumber,
        normKey,
        // Gỡ lỗi: các khoá đã gặp mà chưa có bản dịch ở ngôn ngữ hiện tại.
        missing: () => Array.from(missing),
    };
});
