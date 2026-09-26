/* THANH TRẠNG THÁI → GÓC TRÁI: tiến trình tải model AI lần đầu.
 *
 * Yêu cầu của người dùng (2026-09-27): mọi model AI (Whisper cho bóc băng/Auto Subtitle, F5-TTS
 * và VieNeu cho Lồng tiếng…) khi tải về lần đầu phải hiện thông báo + thanh tiến trình ở góc
 * trái thanh trạng thái. Nguồn dữ liệu: GET /api/model-downloads (backend/model-downloads.js).
 *
 * POLL CÓ NHỊP: 1 giây khi đang có lượt tải (hoặc vừa được `kick()` — tính năng sắp làm việc có
 * thể phải tải), 6 giây lúc rảnh. Lượt tải có thể bắt đầu từ chỗ không ai `kick()` (ví dụ bóc
 * băng lần đầu trên macOS tải ngầm), nên không tắt hẳn poll lúc rảnh — một request cục bộ mỗi
 * 6 giây là rẻ.
 */
(function () {
    'use strict';

    const _t = (typeof globalThis !== 'undefined' && globalThis._t)
        || ((k, p) => (p ? String(k).replace(/\{(\w+)\}/g, (m, n) => (n in p ? p[n] : m)) : k));

    const FAST_MS = 1000;
    const IDLE_MS = 6000;
    const KICK_WINDOW_MS = 20000;

    let timer = null;
    let fastUntil = 0;
    let lastItems = [];
    const speedSamples = new Map();   // id -> { at, bytes, rate }
    const toastedErrors = new Set();

    function humanBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
        if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
        return `${Math.max(0, Math.round(n / 1024))} KB`;
    }

    function trackSpeed(item) {
        const now = Date.now();
        const prev = speedSamples.get(item.id);
        const bytes = Number(item.downloaded) || 0;
        if (!prev || bytes < prev.bytes) {
            speedSamples.set(item.id, { at: now, bytes, rate: 0 });
            return 0;
        }
        const dt = (now - prev.at) / 1000;
        if (dt < 0.8) return prev.rate;
        const instant = (bytes - prev.bytes) / dt;
        // Làm mượt: tốc độ tức thời của hub nhảy loạn giữa các tệp.
        const rate = prev.rate ? prev.rate * 0.6 + instant * 0.4 : instant;
        speedSamples.set(item.id, { at: now, bytes, rate });
        return rate;
    }

    function labelFor(item) {
        const name = item.label || item.id;
        if (item.state === 'error') return _t('Tải {name} thất bại', { name });
        if (item.state === 'done') return _t('Đã tải xong {name}', { name });
        if (item.kind === 'packages') {
            return item.message
                ? _t('Đang cài {name}: {detail}', { name, detail: item.message })
                : _t('Đang cài {name}…', { name });
        }
        return _t('Đang tải mô hình {name} lần đầu…', { name });
    }

    function render(items) {
        const root = document.getElementById('modelDownloadStatus');
        if (!root) return;
        const active = items.filter((i) => i.state === 'downloading');
        const shown = active[0] || items.find((i) => i.state === 'error') || items[0];
        if (!shown) {
            root.hidden = true;
            return;
        }
        const label = root.querySelector('[data-mdl-label]');
        const fill = root.querySelector('[data-mdl-fill]');
        const meta = root.querySelector('[data-mdl-meta]');
        const total = Number(shown.total) || 0;
        const done = Number(shown.downloaded) || 0;
        const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
        const indeterminate = shown.state === 'downloading' && !(total > 0);
        root.hidden = false;
        root.classList.toggle('is-indeterminate', indeterminate);
        root.classList.toggle('is-error', shown.state === 'error');
        root.classList.toggle('is-done', shown.state === 'done');
        const more = active.length > 1 ? ` ${_t('(+{n} lượt tải khác)', { n: active.length - 1 })}` : '';
        label.textContent = labelFor(shown) + more;
        root.title = shown.state === 'error' ? String(shown.error || '') : label.textContent;
        fill.style.width = shown.state === 'downloading' ? (indeterminate ? '' : `${(ratio * 100).toFixed(1)}%`) : '';
        const parts = [];
        if (shown.state === 'downloading') {
            if (total > 0) {
                parts.push(`${Math.floor(ratio * 100)}%`);
                parts.push(`${humanBytes(done)} / ${humanBytes(total)}`);
            } else if (done > 0) {
                parts.push(humanBytes(done));
            }
            const rate = trackSpeed(shown);
            if (rate > 1024) parts.push(`${humanBytes(rate)}/s`);
        }
        meta.textContent = parts.join(' · ');

        for (const item of items) {
            if (item.state === 'error' && !toastedErrors.has(item.id + item.finished_at)) {
                toastedErrors.add(item.id + item.finished_at);
                if (typeof window.showToast === 'function') {
                    window.showToast(`${labelFor(item)}: ${String(item.error || '').slice(0, 240)}`, { type: 'error' });
                }
            }
        }
    }

    async function poll() {
        timer = null;
        try {
            const base = (typeof API_BASE !== 'undefined' && API_BASE) || '/api';
            const resp = await fetch(`${base}/model-downloads`, { cache: 'no-store' });
            if (resp.ok) {
                const data = await resp.json();
                lastItems = Array.isArray(data.items) ? data.items : [];
                render(lastItems);
            }
        } catch (_) {
            // backend đang khởi động / tắt — lượt sau thử lại
        }
        schedule();
    }

    function schedule() {
        if (timer) return;
        const busy = lastItems.some((i) => i.state === 'downloading') || lastItems.length > 0 || Date.now() < fastUntil;
        timer = setTimeout(poll, busy ? FAST_MS : IDLE_MS);
    }

    /* Tính năng sắp chạy việc CÓ THỂ phải tải model thì gọi kick(): poll dồn ngay để thanh hiện
       lên trong vòng một giây thay vì đợi nhịp rảnh. */
    function kick() {
        fastUntil = Date.now() + KICK_WINDOW_MS;
        if (timer) { clearTimeout(timer); timer = null; }
        poll();
    }

    function start() {
        if (!document.getElementById('modelDownloadStatus')) return;
        poll();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    window.ModelDownloadStatus = { kick, items: () => lastItems.slice(), humanBytes };
}());
