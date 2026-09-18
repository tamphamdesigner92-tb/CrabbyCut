/* ===== HỆ PHẢN HỒI DÙNG CHUNG (Phase D1) =====
 *
 * Trước file này app KHÔNG có kênh phản hồi nào ngoài #statusText (rộng 210px, bị cắt bằng
 * ellipsis) và 49 chỗ gọi alert() — hộp thoại chặn cả luồng, phá nhịp dựng phim.
 *
 * Cung cấp 3 thứ, đều là TRÌNH BÀY thuần, không rẽ nhánh logic:
 *   window.showToast(message, opts)   -> thông báo nổi, tự tắt, đọc được bằng screen reader
 *   window.setAppProgress(...)        -> thanh tiến độ mảnh dưới header (xác định / vô định)
 *   window.uiFeedbackReady            -> cờ cho code khác kiểm tra trước khi gọi
 *
 * Nạp SỚM (trước mọi module khác) để editing-runtime.js / settings-panel.js gọi được ngay.
 * Host DOM dựng LAZY vì file này chạy trong <head>, lúc đó chưa có document.body.
 *
 * CSS sống trong index.html cùng mọi style khác của app (quy ước sẵn của dự án).
 */
(function () {
    'use strict';

    const MAX_VISIBLE = 4;           // nhiều hơn thì che mất khung xem trước
    const DEFAULT_MS = { info: 4200, success: 3400, warning: 6000, error: 8000 };

    let host = null;
    const live = [];                 // [{ el, message, type, timer, remaining, startedAt, count }]

    function ensureHost() {
        if (host && host.isConnected) return host;
        if (!document.body) return null;
        host = document.getElementById('toastHost');
        if (!host) {
            host = document.createElement('div');
            host.id = 'toastHost';
            host.className = 'toast-host';
            // role=status + polite: đọc khi rảnh, không cắt lời người dùng đang gõ.
            host.setAttribute('role', 'status');
            host.setAttribute('aria-live', 'polite');
            host.setAttribute('aria-atomic', 'false');
            document.body.appendChild(host);
        }
        return host;
    }

    const ICON = {
        info: 'ic-info',
        success: 'ic-check',
        warning: 'ic-alert',
        error: 'ic-alert',
    };

    function normalizeType(raw) {
        const t = String(raw || 'info').toLowerCase();
        if (t === 'warn') return 'warning';
        if (t === 'err' || t === 'danger') return 'error';
        return (t === 'success' || t === 'warning' || t === 'error') ? t : 'info';
    }

    function dismiss(entry) {
        if (!entry || entry.closing) return;
        entry.closing = true;
        window.clearTimeout(entry.timer);
        const idx = live.indexOf(entry);
        if (idx >= 0) live.splice(idx, 1);
        entry.el.classList.add('is-leaving');
        // Dọn theo transitionend, có hẹn giờ dự phòng cho prefers-reduced-motion (transition
        // bị ép về 0.001ms, sự kiện vẫn bắn nhưng đừng phụ thuộc).
        const remove = () => entry.el.remove();
        entry.el.addEventListener('transitionend', remove, { once: true });
        window.setTimeout(remove, 400);
    }

    function arm(entry, ms) {
        window.clearTimeout(entry.timer);
        if (!(ms > 0)) return;                 // duration 0 = dính cho tới khi bấm
        entry.remaining = ms;
        entry.startedAt = Date.now();
        entry.timer = window.setTimeout(() => dismiss(entry), ms);
    }

    /* Toast lặp lại y hệt thì gộp thành một, đếm số lần — vòng lặp lỗi không đẩy 30 thẻ ra
     * màn hình. So theo (type + message) trên các toast CÒN sống. */
    function findDuplicate(message, type) {
        return live.find((e) => e.message === message && e.type === type && !e.closing) || null;
    }

    function showToast(message, opts) {
        const text = String(message == null ? '' : message).trim();
        if (!text) return null;
        const o = opts || {};
        const type = normalizeType(o.type);
        const ms = Number.isFinite(o.duration) ? Number(o.duration) : DEFAULT_MS[type];

        if (!ensureHost()) {
            // Gọi trước khi có body (hiếm): đợi DOM rồi phát lại, không nuốt thông báo.
            document.addEventListener('DOMContentLoaded', () => showToast(text, o), { once: true });
            return null;
        }

        const dup = findDuplicate(text, type);
        if (dup) {
            dup.count += 1;
            let badge = dup.el.querySelector('.toast-count');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'toast-count';
                dup.el.querySelector('.toast-body').appendChild(badge);
            }
            badge.textContent = `×${dup.count}`;
            dup.el.classList.remove('is-bump');
            void dup.el.offsetWidth;           // ép reflow để animation chạy lại
            dup.el.classList.add('is-bump');
            arm(dup, ms);
            return dup;
        }

        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        const title = o.title ? `<div class="toast-title">${escapeText(o.title)}</div>` : '';
        el.innerHTML =
            `<svg class="toast-ico" aria-hidden="true"><use href="#${ICON[type]}"/></svg>`
            + `<div class="toast-body">${title}<div class="toast-msg"></div></div>`
            + '<button type="button" class="toast-close" aria-label="Đóng thông báo">'
            + '<svg class="btn-ico" aria-hidden="true"><use href="#ic-x"/></svg></button>';
        // textContent chứ không innerHTML: thông báo hay chứa tên tệp / message lỗi của
        // người dùng, nhét thẳng vào HTML là mở đường cho markup rác.
        el.querySelector('.toast-msg').textContent = text;

        const entry = { el, message: text, type, timer: 0, remaining: ms, startedAt: 0, count: 1, closing: false };

        el.querySelector('.toast-close').addEventListener('click', () => dismiss(entry));
        el.addEventListener('click', (e) => { if (!e.target.closest('.toast-close')) dismiss(entry); });
        // Rê chuột vào để đọc cho hết thì dừng đồng hồ.
        el.addEventListener('mouseenter', () => {
            if (!entry.timer) return;
            window.clearTimeout(entry.timer);
            entry.remaining = Math.max(600, entry.remaining - (Date.now() - entry.startedAt));
        });
        el.addEventListener('mouseleave', () => { if (entry.remaining > 0) arm(entry, entry.remaining); });

        host.appendChild(el);
        live.push(entry);
        while (live.length > MAX_VISIBLE) dismiss(live[0]);

        // Thêm class ở khung sau để transition vào có điểm bắt đầu.
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => el.classList.add('is-in')));
        // requestAnimationFrame KHÔNG chạy khi document.hidden (khung xem trước tự động hoá,
        // xem BAN_GIAO §7.1) — hẹn giờ dự phòng để toast không kẹt ở trạng thái ẩn.
        window.setTimeout(() => el.classList.add('is-in'), 80);

        arm(entry, ms);
        return entry;
    }

    function escapeText(s) {
        return String(s).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    function clearToasts() {
        live.slice().forEach(dismiss);
    }

    /* ===== Thanh tiến độ (dải mảnh sát mép dưới .header-bar) =====
     * setAppProgress(null)            -> ẩn
     * setAppProgress(0.42)            -> xác định, 42%
     * setAppProgress(done, total)     -> xác định, done/total
     * setAppProgress('busy')          -> vô định (chạy tới lui)
     * Chỉ đụng DOM; mọi tiến độ vẫn do code gọi tự tính như cũ. */
    let bar = null;
    let barFill = null;

    function ensureBar() {
        if (bar && bar.isConnected) return bar;
        if (!document.body) return null;
        bar = document.getElementById('appProgressBar');
        if (!bar) {
            const header = document.querySelector('.header-bar');
            bar = document.createElement('div');
            bar.id = 'appProgressBar';
            bar.className = 'app-progress';
            bar.setAttribute('role', 'progressbar');
            bar.setAttribute('aria-hidden', 'true');
            bar.innerHTML = '<div class="app-progress-fill"></div>';
            (header || document.body).appendChild(bar);
        }
        barFill = bar.querySelector('.app-progress-fill');
        return bar;
    }

    function setAppProgress(value, total) {
        if (!ensureBar()) return;
        if (value === null || value === undefined || value === false) {
            bar.classList.remove('is-on', 'is-indeterminate');
            bar.setAttribute('aria-hidden', 'true');
            bar.removeAttribute('aria-valuenow');
            return;
        }
        bar.classList.add('is-on');
        bar.setAttribute('aria-hidden', 'false');
        if (value === 'busy' || value === true) {
            bar.classList.add('is-indeterminate');
            bar.removeAttribute('aria-valuenow');
            barFill.style.width = '';
            return;
        }
        let ratio = Number(value);
        if (Number.isFinite(total) && Number(total) > 0) ratio = Number(value) / Number(total);
        if (!Number.isFinite(ratio)) { setAppProgress('busy'); return; }
        ratio = Math.max(0, Math.min(1, ratio));
        bar.classList.remove('is-indeterminate');
        bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        barFill.style.width = `${(ratio * 100).toFixed(2)}%`;
    }

    window.showToast = showToast;
    window.clearToasts = clearToasts;
    window.setAppProgress = setAppProgress;
    window.toast = {
        info: (m, o) => showToast(m, Object.assign({}, o, { type: 'info' })),
        success: (m, o) => showToast(m, Object.assign({}, o, { type: 'success' })),
        warn: (m, o) => showToast(m, Object.assign({}, o, { type: 'warning' })),
        error: (m, o) => showToast(m, Object.assign({}, o, { type: 'error' })),
    };
    window.uiFeedbackReady = true;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { ensureHost(); ensureBar(); }, { once: true });
    } else {
        ensureHost();
        ensureBar();
    }
})();
