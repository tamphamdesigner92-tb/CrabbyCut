/* ===== TIỆN ÍCH TRỢ NĂNG DÙNG CHUNG (Phase E) =====
 *
 * Hai thứ, đều là hành vi CHUNG cho mọi màn hình, uỷ quyền ở document nên tự áp cho cả các
 * phần tử do editing-runtime.js / settings-panel.js dựng động về sau:
 *
 *   1. Điều hướng tab bằng phím mũi tên  (dải [role="tablist"])
 *   2. Bẫy focus + ESC cho hộp thoại     (window.UiA11y.trapFocus)
 *
 * KHÔNG dùng roving tabindex (chuẩn APG khuyên dùng). Roving đòi mọi lượt dựng lại tab phải
 * đồng bộ tabindex, tức phải theo dõi DOM — mà 3 dải tab của app dựng lại rất thường xuyên
 * (mỗi lần đổi block đang chọn). Ở đây mọi tab đều ở lại trong luồng Tab như trước, phím mũi
 * tên là THÊM chứ không thay. Kém chuẩn một nhịp, nhưng không đánh đổi hiệu năng và không
 * có trạng thái nào để lệch.
 */
(function () {
    'use strict';

    /* ---------- 1. Điều hướng tab bằng bàn phím ---------- */

    function tabsOf(list) {
        return Array.from(list.querySelectorAll('[role="tab"]')).filter((el) => !el.disabled);
    }

    document.addEventListener('keydown', (event) => {
        const tab = event.target.closest?.('[role="tab"]');
        if (!tab) return;
        const list = tab.closest('[role="tablist"]');
        if (!list) return;

        const vertical = list.getAttribute('aria-orientation') === 'vertical';
        const prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';
        const nextKey = vertical ? 'ArrowDown' : 'ArrowRight';

        const items = tabsOf(list);
        const at = items.indexOf(tab);
        if (at < 0) return;

        let to = -1;
        if (event.key === prevKey) to = (at - 1 + items.length) % items.length;
        else if (event.key === nextKey) to = (at + 1) % items.length;
        else if (event.key === 'Home') to = 0;
        else if (event.key === 'End') to = items.length - 1;
        else return;

        event.preventDefault();
        // Mũi tên trái/phải là phím tắt TOÀN CỤC của app (lùi/tiến một khung hình). Chặn lan
        // để con trỏ thời gian không nhảy khi người dùng chỉ đang đi giữa các tab.
        event.stopPropagation();

        // Kích hoạt bằng CHÍNH cú click mà handler sẵn có đang nghe — không nhân bản một
        // đường đổi tab thứ hai để rồi lệch nhau.
        items[to].focus();
        items[to].click();
        // Dải tab dựng lại sau khi click (innerHTML mới) -> nút cũ không còn trong DOM.
        // Tìm lại theo vị trí để focus không rơi về <body>.
        const after = tabsOf(list)[to];
        if (after && after !== items[to]) after.focus();
    }, true);

    /* ---------- 2. Bẫy focus cho hộp thoại ---------- */

    const FOCUSABLE = [
        'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
        'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', 'summary',
    ].join(',');

    function focusablesIn(root) {
        return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => {
            if (el.hasAttribute('inert')) return false;
            if (el.closest('[aria-hidden="true"]')) return false;
            // offsetParent null = đang display:none ở đâu đó trên cây cha.
            return el.offsetParent !== null || el === document.activeElement;
        });
    }

    /**
     * Giam Tab trong `panel` và cho ESC đóng. Trả về hàm gỡ.
     * @param {HTMLElement} panel   phần tử [role="dialog"]
     * @param {object} opts
     *   onEscape   () => void   — bỏ trống thì ESC không làm gì
     *   initial    HTMLElement | () => HTMLElement — focus vào đâu khi mở
     */
    function trapFocus(panel, opts) {
        if (!panel) return () => {};
        const o = opts || {};
        const lastFocused = document.activeElement;

        function onKeydown(event) {
            if (event.key === 'Escape' && typeof o.onEscape === 'function') {
                event.preventDefault();
                event.stopPropagation();
                o.onEscape();
                return;
            }
            if (event.key !== 'Tab') return;
            const items = focusablesIn(panel);
            if (!items.length) {
                // Không có gì để focus thì giữ focus ở chính panel, đừng thả ra trang dưới.
                event.preventDefault();
                return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;
            // Focus đang ở NGOÀI panel (mở xong chưa focus vào, hoặc bị đẩy ra) -> kéo về.
            if (!panel.contains(active)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
                return;
            }
            if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
        }

        // capture: phím tắt toàn cục của app nghe ở tầng document, phải chặn trước chúng.
        document.addEventListener('keydown', onKeydown, true);

        const initial = typeof o.initial === 'function' ? o.initial() : o.initial;
        const target = initial || focusablesIn(panel)[0] || panel;
        if (target === panel && !panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
        try { target.focus(); } catch (_) { /* phần tử vừa bị gỡ: bỏ qua */ }

        return function release() {
            document.removeEventListener('keydown', onKeydown, true);
            if (lastFocused && lastFocused.isConnected) {
                try { lastFocused.focus(); } catch (_) { /* như trên */ }
            }
        };
    }

    window.UiA11y = { trapFocus, focusablesIn };
})();
