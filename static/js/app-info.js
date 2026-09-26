/* Số phiên bản của ứng dụng cho giao diện: huy hiệu cạnh logo ở Trang chủ, "Phiên bản: …" ở
 * góc phải thanh trạng thái, và Cài đặt → "Về CrabbyCut".
 *
 * MỘT NGUỒN DUY NHẤT: "version" trong package.json. Bản desktop hỏi main process
 * (desktopEnv.getAppInfo → app.getVersion(), cũng là con số electron-builder đặt vào tên bộ cài
 * và updater so với GitHub Releases); bản web hỏi backend (/api/app-info, đọc cùng tệp đó).
 * KHÔNG ghi cứng số nào trong HTML — ghi cứng là quên sửa ở bản phát hành kế tiếp, và giao
 * diện nói một đằng trong khi updater hiểu một nẻo.
 *
 * Phần tử nào muốn hiện số thì mang `data-app-version` (tuỳ chọn `data-app-version-prefix`):
 * tệp này điền "v1.2.3" vào rồi bỏ `hidden`. Chưa lấy được số thì phần tử cứ ẩn — thà không
 * hiện còn hơn hiện một con số sai.
 */
(function () {
    'use strict';

    let info = null;
    let pending = null;
    const listeners = new Set();

    function versionLabel(value) {
        const v = String(value || '').trim().replace(/^v/i, '');
        return v ? `v${v}` : '';
    }

    function paint(root) {
        const label = versionLabel(info?.version);
        if (!label) return;
        (root || document).querySelectorAll('[data-app-version]').forEach((el) => {
            el.textContent = `${el.dataset.appVersionPrefix || ''}${label}`;
            el.hidden = false;
        });
    }

    async function fetchInfo() {
        try {
            if (typeof window.desktopEnv?.getAppInfo === 'function') {
                const got = await window.desktopEnv.getAppInfo();
                if (got?.version) return got;
            }
        } catch (_) { /* rơi xuống đường backend */ }
        const base = (typeof API_BASE === 'string' && API_BASE) ? API_BASE : '/api';
        const resp = await fetch(`${base}/app-info`);
        if (!resp.ok) throw new Error(`app-info ${resp.status}`);
        return resp.json();
    }

    function load() {
        if (info) return Promise.resolve(info);
        if (!pending) {
            pending = fetchInfo()
                .then((got) => {
                    info = got && got.version ? got : null;
                    paint();
                    listeners.forEach((fn) => { try { fn(info); } catch (_) { /* ignore */ } });
                    return info;
                })
                .catch((error) => {
                    console.warn('[app-info] không lấy được số phiên bản:', error);
                    pending = null;   // lượt gọi sau thử lại
                    return null;
                });
        }
        return pending;
    }

    window.AppInfo = {
        load,
        get: () => info,
        versionLabel,
        paint,
        onReady: (fn) => { listeners.add(fn); if (info) fn(info); },
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => load());
    else load();
}());
