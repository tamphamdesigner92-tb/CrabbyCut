// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* GEOCODE — tab Hình học > GeoCode: viết mã (HTML/CSS/JS, JavaScript canvas, Python) rồi sinh
 * ẢNH TĨNH hoặc VIDEO ở kích thước pixel tuỳ chọn, đặt lên lane Hình khối thành block `geocode`.
 *
 * Ba phần, cùng một tệp vì chúng chung một đặc tả:
 *   - PANE (renderPaneHtml / bindPane — khuôn của dubbing.js / auto-subtitle.js);
 *   - DỰNG KHUNG qua main process (desktopEnv.geocodeRender -> electron/geocode-renderer.js).
 *     Khung là CACHE theo khoá nội dung; block giữ MÃ, thiếu khung thì ensureFrames dựng lại;
 *   - NẠP KHUNG cho preview (frameBitmap): ImageBitmap + LRU + nạp trước quanh playhead.
 * editing-runtime.js lo phần block (tạo, vẽ preview, xuất) và gọi vào đây qua window.GeoCode.
 *
 * Bản web (không Electron) không có bộ dựng: pane chỉ báo "cần bản desktop". */
(function () {
    'use strict';

    const env = () => window.desktopEnv || null;
    const RT = () => window.EditingRuntime || null;
    const esc = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const LIMITS = { MIN_SIDE: 16, MAX_SIDE: 4096, MAX_FRAMES: 3600, MIN_FPS: 1, MAX_FPS: 60 };
    const LANGS = [
        { id: 'html', label: 'HTML/CSS/JS' },
        { id: 'canvas', label: _t('JavaScript canvas') },
        { id: 'python', label: 'Python' },
    ];
    // Kích thước có sẵn (W×H px, sửa tay được). 'sequence' = theo khung dự án.
    const PRESETS = [
        { id: 'button', label: _t('Nút'), w: 450, h: 200 },
        { id: 'button-sm', label: _t('Nút nhỏ'), w: 240, h: 80 },
        { id: 'icon', label: 'Icon', w: 512, h: 512 },
        { id: 'logo', label: 'Logo', w: 1000, h: 1000 },
        { id: 'banner', label: 'Banner', w: 728, h: 90 },
        { id: 'lower-third', label: 'Lower third', w: 1920, h: 300 },
        { id: 'square', label: _t('Vuông'), w: 1080, h: 1080 },
        { id: 'vertical', label: _t('Dọc 9:16'), w: 1080, h: 1920 },
        { id: 'fhd', label: 'Full HD', w: 1920, h: 1080 },
        { id: '4k', label: '4K', w: 3840, h: 2160 },
        { id: 'sequence', label: _t('Theo khung dự án'), w: 0, h: 0 },
    ];

    function starterCode(lang) {
        if (lang === 'canvas') {
            return `// ${_t('draw(ctx, t, width, height, frame) được gọi cho từng khung; canvas đã được xoá sẵn.')}
function draw(ctx, t, width, height) {
  const r = Math.min(width, height) * (0.3 + 0.08 * Math.sin(t * Math.PI * 2));
  ctx.fillStyle = '#4f8cff';
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, r, 0, Math.PI * 2);
  ctx.fill();
}
`;
        }
        if (lang === 'python') {
            return `# ${_t('frame(t, width, height) được gọi cho từng khung, trả về ảnh PIL (RGBA), mảng numpy hoặc Figure của matplotlib.')}
from PIL import Image, ImageDraw
import math

def frame(t, width, height):
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = min(width, height) * (0.3 + 0.08 * math.sin(t * math.pi * 2))
    cx, cy = width / 2, height / 2
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(79, 140, 255, 255))
    return img
`;
        }
        return `<style>
  .btn {
    position: absolute; inset: 20px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 999px;
    background: linear-gradient(135deg, #ff7a18, #ffb347);
    color: #fff; font: 700 64px/1 'Segoe UI', Arial, sans-serif;
    box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
    animation: pulse 0.8s ease-in-out infinite alternate;
  }
  @keyframes pulse { from { transform: scale(0.94); } to { transform: scale(1); } }
</style>
<div class="btn">${_t('Đăng ký')}</div>
`;
    }

    const state = {
        lang: 'html',
        code: {},           // mã theo từng ngôn ngữ (đổi qua lại không mất)
        preset: 'button',
        width: 450,
        height: 200,
        duration: 3,
        fps: 0,             // 0 = theo fps sequence
        loop: true,
        bgMode: 'transparent',
        bgColor: '#000000',
        busy: null,         // { jobId, done, total, stage, label }
        previewUrl: '',
        previewT: 0,
        error: '',
        logs: [],
        editingItemId: '',  // block GeoCode đang chọn (sửa + Tạo lại)
    };

    function sequenceSize() {
        const seq = typeof getSequencePayload === 'function' ? getSequencePayload() : { width: 1920, height: 1080 };
        return { width: Number(seq.width) || 1920, height: Number(seq.height) || 1080, fps: seq.fps || seq.source_fps || '' };
    }

    function parseFps(raw) {
        const s = String(raw || '').trim();
        if (!s) return 0;
        if (s.includes('/')) {
            const [a, b] = s.split('/').map(Number);
            return b > 0 ? a / b : 0;
        }
        return Number(s) || 0;
    }

    function defaultFps() {
        const fps = Math.round(parseFps(sequenceSize().fps));
        return fps >= LIMITS.MIN_FPS && fps <= LIMITS.MAX_FPS ? fps : 30;
    }

    function effectiveFps() {
        return state.fps > 0 ? state.fps : defaultFps();
    }

    function currentCode() {
        if (state.code[state.lang] === undefined) state.code[state.lang] = starterCode(state.lang);
        return state.code[state.lang];
    }

    /* Đặc tả gửi bộ dựng — CÙNG dạng với item.geocode (trừ khoá/số khung do bộ dựng trả về). */
    function specFor(kind) {
        return {
            lang: state.lang,
            code: currentCode(),
            width: Math.round(Number(state.width)),
            height: Math.round(Number(state.height)),
            kind,
            fps: kind === 'video' ? effectiveFps() : 0,
            duration: kind === 'video' ? Number(state.duration) : 0,
            bg: state.bgMode === 'color' ? state.bgColor : 'transparent',
        };
    }

    function validate(spec) {
        const side = (v) => Number.isInteger(v) && v >= LIMITS.MIN_SIDE && v <= LIMITS.MAX_SIDE;
        if (!side(spec.width) || !side(spec.height)) {
            return _t('Kích thước phải là số nguyên từ {min} đến {max} px mỗi cạnh', { min: LIMITS.MIN_SIDE, max: LIMITS.MAX_SIDE });
        }
        if (!String(spec.code || '').trim()) return _t('Mã đang trống');
        if (spec.kind === 'video') {
            const max = LIMITS.MAX_FRAMES / spec.fps;
            if (!(spec.duration >= 1 / spec.fps) || spec.duration > max + 1e-9) {
                return _t('Thời lượng phải từ {min} đến {max} giây ở {fps} fps',
                    { min: Math.round((1000 / spec.fps)) / 1000, max: Math.round(max * 100) / 100, fps: spec.fps });
            }
        }
        return '';
    }

    /* ---------------------------------------------------------------- dựng khung */

    let jobSeq = 0;
    const listeners = new Map();   // jobId -> fn(type, payload)
    let unsubscribe = null;

    function listen(jobId, fn) {
        if (!unsubscribe && env()?.onGeocodeEvent) {
            unsubscribe = env().onGeocodeEvent((type, payload) => {
                const cb = listeners.get(payload?.jobId);
                if (cb) cb(type, payload);
            });
        }
        listeners.set(jobId, fn);
        return () => listeners.delete(jobId);
    }

    function available() {
        return !!env()?.geocodeRender;
    }

    /* Dựng (hoặc lấy cache) khung cho một đặc tả. Trả { key, frame_count, width, height, fps,
     * duration, kind, proxy, cached }; ném lỗi kèm log của mã người dùng. */
    async function renderSpec(spec, { onProgress, onLog } = {}) {
        if (!available()) throw new Error(_t('GeoCode cần bản desktop của CrabbyCut.'));
        const jobId = `gc${Date.now().toString(36)}_${++jobSeq}`;
        const stop = listen(jobId, (type, payload) => {
            if (type === 'progress') onProgress?.(payload, jobId);
            else onLog?.(payload, jobId);
        });
        onProgress?.({ stage: 'start', done: 0, total: 0 }, jobId);
        try {
            const res = await env().geocodeRender(jobId, spec);
            if (!res?.ok) throw new Error(res?.error || _t('Không dựng được GeoCode'));
            return { ...res.result, jobId };
        } finally {
            stop();
        }
    }

    /* Block có khung chưa — thiếu (cache bị dọn, mở dự án ở máy khác) thì dựng lại từ mã. Gộp
     * theo khoá: mười block cùng một mã chỉ dựng một lần. */
    const ensuring = new Map();   // key -> Promise
    const missingKeys = new Set();
    function ensureFrames(gc) {
        if (!gc || !gc.render_key || !available()) return Promise.resolve(false);
        if (ensuring.has(gc.render_key)) return ensuring.get(gc.render_key);
        const spec = { lang: gc.lang, code: gc.code, width: gc.width, height: gc.height, kind: gc.kind, fps: gc.fps, duration: gc.duration, bg: gc.bg };
        const job = (async () => {
            const info = await env().geocodeCacheInfo(spec);
            if (info?.ok && info.cached) return true;
            if (info?.ok && info.key !== gc.render_key) {
                console.warn('[geocode] khoá lưu trong dự án khác khoá tính lại', gc.render_key, info.key);
            }
            window.setEditingStatusText?.(_t('Đang dựng lại khung GeoCode…'));
            const res = await renderSpec(spec);
            missingKeys.delete(gc.render_key);
            if (res.key !== gc.render_key) return false;
            return true;
        })().catch((error) => {
            console.warn('[geocode] dựng lại khung lỗi:', error);
            window.showToast?.(_t('Không dựng lại được khung GeoCode: {error}', { error: error.message || String(error) }), { type: 'error' });
            return false;
        }).finally(() => {
            ensuring.delete(gc.render_key);
            frameCache.forgetKey(gc.render_key);
            RT()?.renderPreviewOverlays?.();
        });
        ensuring.set(gc.render_key, job);
        return job;
    }

    /* ---------------------------------------------------------------- khung cho preview */

    const frameCache = (() => {
        // url -> { bitmap, pixels, pending, failed, key }
        const map = new Map();
        const MAX_PIXELS = 120 * 1000 * 1000;   // ~480 MB RGBA
        let pixels = 0;
        function touch(url, entry) { map.delete(url); map.set(url, entry); }
        function evict() {
            for (const [url, entry] of map) {
                if (pixels <= MAX_PIXELS) break;
                if (entry.pending) continue;
                map.delete(url);
                if (entry.bitmap) { pixels -= entry.pixels; entry.bitmap.close?.(); }
            }
        }
        function load(url, key, onReady) {
            const entry = { pending: true, key };
            map.set(url, entry);
            fetch(url).then((resp) => {
                if (resp.status === 404) { entry.missing = true; throw new Error('404'); }
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return resp.blob();
            }).then((blob) => createImageBitmap(blob)).then((bitmap) => {
                entry.bitmap = bitmap;
                entry.pixels = bitmap.width * bitmap.height;
                pixels += entry.pixels;
                evict();
                onReady?.();
            }).catch(() => {
                entry.failed = true;
                if (entry.missing) missingKeys.add(key);
            }).finally(() => { entry.pending = false; });
        }
        return {
            get(url, key, onReady) {
                const entry = map.get(url);
                if (entry) {
                    touch(url, entry);
                    return entry.bitmap || null;
                }
                load(url, key, onReady);
                return null;
            },
            prefetch(url, key) { if (!map.has(url)) load(url, key, null); },
            forgetKey(key) {
                for (const [url, entry] of map) {
                    if (entry.key !== key || entry.pending) continue;
                    if (entry.bitmap) { pixels -= entry.pixels; entry.bitmap.close?.(); }
                    map.delete(url);
                }
            },
        };
    })();

    function frameUrl(key, index, proxy) {
        return `/geocode_cache/${key}/${proxy ? 'proxy/' : ''}frame_${String(index).padStart(5, '0')}.png`;
    }

    // Khung ứng với giây cục bộ `local` của block (lặp hoặc giữ khung cuối).
    function frameIndexAt(gc, local) {
        const n = Math.max(1, Number(gc.frame_count) || 1);
        if (gc.kind !== 'video' || n === 1) return 0;
        const f = Math.floor(Math.max(0, local) * (Number(gc.fps) || 30) + 1e-6);
        return gc.loop ? ((f % n) + n) % n : Math.min(n - 1, f);
    }

    /* ImageBitmap của khung tại `local` cho preview; null khi chưa nạp xong (preview giữ khung
     * đang có, onReady xin vẽ lại). `displayPx` = bề rộng hiển thị thật -> đủ nhỏ thì dùng proxy. */
    function frameBitmap(gc, local, { displayPx = Infinity, playing = false, onReady } = {}) {
        if (!gc || !gc.render_key) return null;
        if (missingKeys.has(gc.render_key)) { ensureFrames(gc); return null; }
        const useProxy = !!(gc.proxy && displayPx <= gc.proxy.width * 1.15);
        const index = frameIndexAt(gc, local);
        const bitmap = frameCache.get(frameUrl(gc.render_key, index, useProxy), gc.render_key, onReady);
        if (gc.kind === 'video' && Number(gc.frame_count) > 1) {
            // Nạp trước vài khung phía trước (khi phát nhiều hơn) để khỏi khựng.
            const ahead = playing ? 12 : 3;
            for (let k = 1; k <= ahead; k += 1) {
                frameCache.prefetch(frameUrl(gc.render_key, frameIndexAt(gc, local + k / (Number(gc.fps) || 30)), useProxy), gc.render_key);
            }
        }
        return bitmap;
    }

    /* ---------------------------------------------------------------- pane */

    function selectedGeocodeItem() {
        const rt = RT();
        const st = rt?.getState?.();
        const id = st?.selectedEditingItemId;
        const item = id ? st.editingItems.find((it) => it.id === id) : null;
        return item && item.type === 'geocode' && st.selectedEditingItemIds.length === 1 ? item : null;
    }

    // Chọn block GeoCode -> nạp lại mã/cỡ/loại của nó vào pane để sửa và "Tạo lại".
    function syncFromSelection() {
        const item = selectedGeocodeItem();
        if (!item) { state.editingItemId = ''; return; }
        if (state.editingItemId === item.id) return;
        state.editingItemId = item.id;
        const gc = item.geocode || {};
        state.lang = LANGS.some((l) => l.id === gc.lang) ? gc.lang : 'html';
        state.code[state.lang] = String(gc.code || '');
        state.width = Number(gc.width) || state.width;
        state.height = Number(gc.height) || state.height;
        state.preset = (PRESETS.find((p) => p.w === state.width && p.h === state.height) || {}).id || 'custom';
        if (gc.kind === 'video') {
            state.duration = Number(gc.duration) || state.duration;
            state.fps = Number(gc.fps) === defaultFps() ? 0 : Number(gc.fps) || 0;
            state.loop = gc.loop !== false;
        }
        state.bgMode = gc.bg && gc.bg !== 'transparent' ? 'color' : 'transparent';
        if (state.bgMode === 'color') state.bgColor = gc.bg;
        state.previewUrl = '';
        state.error = '';
    }

    function injectStyle() {
        window.AutoSubtitlePanel?.injectStyle?.();   // các lớp .edit-sub-* dùng chung
        if (document.getElementById('geocode-style')) return;
        const el = document.createElement('style');
        el.id = 'geocode-style';
        el.textContent = `
            .gc-segs { display: flex; gap: 4px; padding: 2px; border-radius: 7px; background: rgba(255,255,255,0.05); }
            .gc-seg { flex: 1; min-width: 0; width: auto; margin: 0; box-shadow: none; padding: 6px 8px; border: 0;
                border-radius: 5px; background: transparent; color: inherit; font: inherit; font-size: 11px; opacity: 0.7; cursor: pointer; }
            .gc-seg:hover:not(:disabled) { opacity: 1; }
            .gc-seg.is-active { background: rgba(255,176,32,0.16); color: var(--primary); opacity: 1; font-weight: 600; }
            .gc-editor { position: relative; display: flex; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
                background: rgba(0,0,0,0.25); overflow: hidden; height: 260px; resize: vertical; }
            .gc-gutter { flex: 0 0 auto; margin: 0; padding: 8px 6px 8px 8px; text-align: right; user-select: none;
                font: 12px/18px Consolas, 'Cascadia Mono', Menlo, monospace; color: rgba(255,255,255,0.3);
                overflow: hidden; white-space: pre; }
            textarea.gc-code { flex: 1; min-width: 0; margin: 0; padding: 8px; border: 0; outline: none; resize: none;
                background: transparent; color: inherit; font: 12px/18px Consolas, 'Cascadia Mono', Menlo, monospace;
                white-space: pre; overflow: auto; tab-size: 2; }
            .gc-row { display: flex; gap: 6px; align-items: center; }
            /* Nút chữ nhỏ: gỡ quy tắc chung button { width: 100% … } của index.html. */
            .gc-link { flex: 0 0 auto; width: auto; margin: 0; padding: 0; border: 0; box-shadow: none; background: transparent;
                color: inherit; font: inherit; font-size: 11px; opacity: 0.75; cursor: pointer; }
            .gc-link:hover:not(:disabled) { opacity: 1; color: var(--primary); }
            .gc-row > .edit-sub-input { flex: 1; min-width: 0; }
            .gc-row > span { flex: 0 0 auto; opacity: 0.6; font-size: 11px; }
            .gc-preview { display: flex; align-items: center; justify-content: center; min-height: 80px; max-height: 220px;
                border-radius: 6px; overflow: hidden;
                background-color: #2a2a2a; background-image: linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%),
                linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%);
                background-size: 16px 16px; background-position: 0 0, 8px 8px; }
            .gc-preview img { max-width: 100%; max-height: 220px; object-fit: contain; }
            .gc-log { margin: 0; max-height: 140px; overflow: auto; padding: 6px 8px; border-radius: 6px;
                background: rgba(0,0,0,0.3); font: 11px/16px Consolas, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
            .gc-log .is-error { color: var(--danger, #ff6b6b); }
            .gc-log .is-warn { color: #ffcf5c; }
            .gc-editing { padding: 6px 8px; border: 1px dashed rgba(255,176,32,0.45); border-radius: 6px; font-size: 11px; }
            .gc-actions { display: flex; flex-wrap: wrap; gap: 6px; }
            .gc-actions .btn { flex: 1 1 auto; width: auto; margin: 0; }
        `;
        document.head.insertBefore(el, document.getElementById('lumenSkin'));
    }

    function lineNumbers(code) {
        const n = Math.max(1, String(code).split('\n').length);
        let out = '';
        for (let i = 1; i <= n; i += 1) out += `${i}\n`;
        return out;
    }

    function renderPaneHtml() {
        injectStyle();
        syncFromSelection();
        if (!available()) {
            return `<div class="edit-sub-pane" data-gc-zone><div class="edit-sub-block">
                <div class="edit-sub-hint">${_t('GeoCode dựng hình từ mã bằng trình duyệt ẩn và Python của máy — chỉ có trong bản desktop của CrabbyCut.')}</div>
            </div></div>`;
        }
        const busy = !!state.busy;
        const dis = busy ? 'disabled' : '';
        const code = currentCode();
        const seq = sequenceSize();
        const item = state.editingItemId ? selectedGeocodeItem() : null;
        const pct = state.busy && state.busy.total ? Math.round((Math.min(state.busy.done, state.busy.total) / state.busy.total) * 100) : 0;
        const logs = state.logs.slice(-200).map((l) => `<div class="${l.level === 'error' ? 'is-error' : (l.level === 'warn' ? 'is-warn' : '')}">${esc(l.message)}</div>`).join('');
        return `
            <div class="edit-sub-pane" data-gc-zone>
                <div class="edit-sub-block">
                    <div class="edit-sub-hint">${_t('Viết mã để dựng ảnh hoặc video có nền trong suốt, rồi đặt lên lane Hình khối như một block.')}</div>
                </div>
                ${item ? `<div class="gc-editing">${_t('Đang sửa block GeoCode đã chọn — bấm "Tạo lại" để thay khung của block, hoặc "Tạo ảnh"/"Tạo video" để thêm block mới.')}</div>` : ''}
                <div class="edit-sub-block">
                    <div class="edit-sub-label">${_t('Ngôn ngữ')}</div>
                    <div class="gc-segs">${LANGS.map((l) => `<button type="button" class="gc-seg ${l.id === state.lang ? 'is-active' : ''}" data-gc-lang="${l.id}" ${dis}>${esc(l.label)}</button>`).join('')}</div>
                    ${state.lang === 'python' ? `<div class="edit-sub-warn">${_t('Mã Python chạy bằng Python của máy, với toàn quyền của người dùng (khác HTML/JS chạy trong sandbox). Chỉ chạy mã bạn tin.')}</div>` : ''}
                </div>
                <div class="edit-sub-block">
                    <div class="gc-row"><div class="edit-sub-label" style="flex:1">${_t('Mã')}</div>
                        <button type="button" class="gc-link" data-gc-starter ${dis}>${_t('Mẫu khởi đầu')}</button></div>
                    <div class="gc-editor"><pre class="gc-gutter" data-gc-gutter>${lineNumbers(code)}</pre><textarea class="gc-code" id="gcCode" spellcheck="false" autocomplete="off" autocapitalize="off" ${dis}>${esc(code)}</textarea></div>
                </div>
                <div class="edit-sub-block">
                    <label class="edit-sub-label" for="gcPreset">${_t('Kích thước')}</label>
                    <select id="gcPreset" class="edit-sub-input" ${dis}>
                        ${PRESETS.map((p) => `<option value="${p.id}" ${p.id === state.preset ? 'selected' : ''}>${esc(p.label)} · ${p.id === 'sequence' ? `${seq.width}×${seq.height}` : `${p.w}×${p.h}`}</option>`).join('')}
                        <option value="custom" ${state.preset === 'custom' ? 'selected' : ''}>${_t('Tuỳ chỉnh')}</option>
                    </select>
                    <div class="gc-row">
                        <input id="gcWidth" class="edit-sub-input" type="number" min="${LIMITS.MIN_SIDE}" max="${LIMITS.MAX_SIDE}" step="1" value="${state.width}" ${dis} aria-label="${_t('Chiều rộng')}">
                        <span>×</span>
                        <input id="gcHeight" class="edit-sub-input" type="number" min="${LIMITS.MIN_SIDE}" max="${LIMITS.MAX_SIDE}" step="1" value="${state.height}" ${dis} aria-label="${_t('Chiều cao')}">
                        <span>px</span>
                    </div>
                    <label class="edit-sub-label">${_t('Nền')}</label>
                    <div class="gc-row">
                        <div class="gc-segs" style="flex:1">
                            <button type="button" class="gc-seg ${state.bgMode === 'transparent' ? 'is-active' : ''}" data-gc-bg="transparent" ${dis}>${_t('Trong suốt')}</button>
                            <button type="button" class="gc-seg ${state.bgMode === 'color' ? 'is-active' : ''}" data-gc-bg="color" ${dis}>${_t('Màu')}</button>
                        </div>
                        ${state.bgMode === 'color' ? `<input id="gcBgColor" type="color" value="${esc(state.bgColor)}" ${dis} style="width:40px;height:26px;padding:0;border:0;background:none">` : ''}
                    </div>
                </div>
                <div class="edit-sub-block">
                    <div class="edit-sub-label">${_t('Video')}</div>
                    <div class="gc-row">
                        <input id="gcDuration" class="edit-sub-input" type="number" min="0.1" max="120" step="0.1" value="${state.duration}" ${dis} aria-label="${_t('Thời lượng')}">
                        <span>${_t('giây')}</span>
                        <input id="gcFps" class="edit-sub-input" type="number" min="${LIMITS.MIN_FPS}" max="${LIMITS.MAX_FPS}" step="1" value="${state.fps > 0 ? state.fps : ''}" placeholder="${defaultFps()}" ${dis} aria-label="FPS">
                        <span>fps</span>
                    </div>
                    <label class="edit-sub-check"><input type="checkbox" data-gc-loop ${state.loop ? 'checked' : ''} ${dis}><span>${_t('Lặp lại khi block dài hơn video')}</span></label>
                </div>
                <div class="edit-sub-block">
                    ${busy ? `
                        <div class="edit-sub-status"><span>${esc(state.busy.label || _t('Đang dựng…'))}</span><b>${state.busy.total ? `${Math.min(state.busy.done, state.busy.total)}/${state.busy.total}` : ''}</b></div>
                        <div class="edit-sub-progress"><div class="edit-sub-progress-fill" style="width:${pct}%"></div></div>
                        <div class="gc-actions"><button class="btn btn-secondary" type="button" data-gc-cancel>${_t('Huỷ')}</button></div>` : `
                        <div class="gc-actions">
                            <button class="btn btn-secondary" type="button" data-gc-preview>${_t('Xem thử')}</button>
                            <button class="btn btn-primary" type="button" data-gc-create="image">${_t('Tạo ảnh')}</button>
                            <button class="btn btn-primary" type="button" data-gc-create="video">${_t('Tạo video')}</button>
                            ${item ? `<button class="btn btn-primary" type="button" data-gc-regen>${_t('Tạo lại')}</button>` : ''}
                        </div>`}
                    ${state.error ? `<div class="edit-sub-error">${esc(state.error).replace(/\n/g, '<br>')}</div>` : ''}
                </div>
                ${state.previewUrl ? `<div class="edit-sub-block">
                    <div class="edit-sub-label">${_t('Xem thử')}${state.previewT ? ` · t = ${state.previewT} s` : ''}</div>
                    <div class="gc-preview"><img src="${state.previewUrl}" alt=""></div>
                    <div class="gc-row"><span>t</span><input id="gcPreviewT" class="edit-sub-input" type="range" min="0" max="${Math.max(0.1, Number(state.duration) || 0)}" step="0.05" value="${state.previewT}" ${dis}></div>
                </div>` : ''}
                ${logs ? `<div class="edit-sub-block"><div class="gc-row"><div class="edit-sub-label" style="flex:1">${_t('Nhật ký')}</div>
                    <button type="button" class="gc-link" data-gc-clear-log>${_t('Xoá')}</button></div><div class="gc-log" data-gc-log>${logs}</div></div>` : ''}
            </div>`;
    }

    function repaint() {
        const body = document.getElementById('editPanelBody');
        if (!body || !body.querySelector('[data-gc-zone]')) return;
        const scroll = body.scrollTop;
        const area = body.querySelector('#gcCode');
        const caret = area && document.activeElement === area ? [area.selectionStart, area.selectionEnd, area.scrollTop] : null;
        body.innerHTML = renderPaneHtml();
        bindPane(body);
        body.scrollTop = scroll;
        const log = body.querySelector('[data-gc-log]');
        if (log) log.scrollTop = log.scrollHeight;
        if (caret) {
            const next = body.querySelector('#gcCode');
            if (next && !next.disabled) {
                next.focus();
                next.setSelectionRange(caret[0], caret[1]);
                next.scrollTop = caret[2];
            }
        }
    }

    function pushLog(entry) {
        state.logs.push({ level: entry.level || 'info', message: String(entry.message || '') });
        if (state.logs.length > 400) state.logs.splice(0, state.logs.length - 400);
    }

    let repaintPending = false;
    function scheduleRepaint() {
        if (repaintPending) return;
        repaintPending = true;
        requestAnimationFrame(() => { repaintPending = false; repaint(); });
    }

    function onJobEvent(label) {
        return {
            onProgress: (p, jobId) => {
                state.busy = { jobId, done: Number(p.done) || 0, total: Number(p.total) || 0, stage: p.stage, label: p.stage === 'proxy' ? _t('Đang dựng bản xem trước nhỏ…') : label };
                scheduleRepaint();
            },
            onLog: (l) => { pushLog(l); scheduleRepaint(); },
        };
    }

    async function runPreview() {
        const spec = specFor(Number(state.duration) > 0 ? 'video' : 'image');
        const err = validate(spec);
        if (err) { state.error = err; repaint(); return; }
        state.error = '';
        state.busy = { jobId: '', done: 0, total: 1, label: _t('Đang dựng khung xem thử…') };
        repaint();
        try {
            const res = await env().geocodePreview(`gcp${Date.now().toString(36)}`, spec, state.previewT);
            (res?.logs || []).forEach(pushLog);
            if (!res?.ok) throw new Error(res?.error || _t('Không dựng được khung xem thử'));
            state.previewUrl = res.data_url;
            state.previewT = res.t || 0;
        } catch (error) {
            state.error = error.message || String(error);
        } finally {
            state.busy = null;
            repaint();
        }
    }

    // Dựng + đặt block mới (hoặc thay khung của block đang sửa nếu `regenId`).
    async function runCreate(kind, regenId = '') {
        const spec = specFor(kind);
        const err = validate(spec);
        if (err) { state.error = err; repaint(); return; }
        state.error = '';
        state.logs = [];
        const label = kind === 'video' ? _t('Đang dựng video…') : _t('Đang dựng ảnh…');
        state.busy = { jobId: '', done: 0, total: 0, label };
        repaint();
        try {
            const result = await renderSpec(spec, onJobEvent(label));
            const geocode = toItemGeocode(spec, result, state.loop);
            const rt = RT();
            if (regenId) rt?.updateGeocodeItem?.(regenId, geocode);
            else rt?.addGeocodeItem?.(geocode);
            window.setEditingStatusText?.(result.cached
                ? _t('Đã đặt block GeoCode (dùng lại khung đã dựng).')
                : _t('Đã dựng {n} khung GeoCode trong {s} giây.', { n: result.frame_count, s: Math.round((result.render_ms || 0) / 100) / 10 }));
        } catch (error) {
            state.error = error.message || String(error);
        } finally {
            state.busy = null;
            repaint();
        }
    }

    // Dữ liệu lưu trên block: đặc tả + khoá/số khung do bộ dựng trả về.
    function toItemGeocode(spec, result, loop) {
        return {
            lang: spec.lang,
            code: spec.code,
            width: spec.width,
            height: spec.height,
            kind: spec.kind,
            fps: spec.kind === 'video' ? spec.fps : 0,
            duration: spec.kind === 'video' ? spec.duration : 0,
            loop: spec.kind === 'video' ? loop !== false : false,
            bg: spec.bg,
            render_key: result.key,
            frame_count: result.frame_count,
            proxy: result.proxy || null,
        };
    }

    function setSize(w, h) {
        state.width = Math.round(Number(w)) || state.width;
        state.height = Math.round(Number(h)) || state.height;
    }

    function bindPane(body) {
        const zone = body.querySelector('[data-gc-zone]');
        if (!zone) return;
        const area = zone.querySelector('#gcCode');
        const gutter = zone.querySelector('[data-gc-gutter]');
        if (area) {
            area.addEventListener('input', () => {
                state.code[state.lang] = area.value;
                if (gutter) gutter.textContent = lineNumbers(area.value);
            });
            area.addEventListener('scroll', () => { if (gutter) gutter.scrollTop = area.scrollTop; });
            area.addEventListener('keydown', (event) => {
                // Phím tắt của app (Space = phát, Delete = xoá block…) không được ăn phím đang gõ mã.
                event.stopPropagation();
                if (event.key !== 'Tab') return;
                event.preventDefault();
                const { selectionStart: s, selectionEnd: e, value } = area;
                if (event.shiftKey) {
                    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
                    const strip = value.slice(lineStart, lineStart + 2) === '  ' ? 2 : (value[lineStart] === ' ' ? 1 : 0);
                    if (!strip) return;
                    area.value = value.slice(0, lineStart) + value.slice(lineStart + strip);
                    area.setSelectionRange(Math.max(lineStart, s - strip), Math.max(lineStart, e - strip));
                } else {
                    area.value = `${value.slice(0, s)}  ${value.slice(e)}`;
                    area.setSelectionRange(s + 2, s + 2);
                }
                area.dispatchEvent(new Event('input'));
            });
        }
        zone.addEventListener('click', (event) => {
            const t = event.target;
            const langBtn = t.closest('[data-gc-lang]');
            if (langBtn && !state.busy) { state.lang = langBtn.dataset.gcLang; state.previewUrl = ''; repaint(); return; }
            if (t.closest('[data-gc-starter]') && !state.busy) {
                if (currentCode().trim() && currentCode() !== starterCode(state.lang)
                    && !window.confirm(_t('Thay mã đang viết bằng mẫu khởi đầu?'))) return;
                state.code[state.lang] = starterCode(state.lang);
                repaint();
                return;
            }
            const bgBtn = t.closest('[data-gc-bg]');
            if (bgBtn && !state.busy) { state.bgMode = bgBtn.dataset.gcBg; repaint(); return; }
            if (t.closest('[data-gc-preview]')) { runPreview(); return; }
            const create = t.closest('[data-gc-create]');
            if (create) { runCreate(create.dataset.gcCreate); return; }
            if (t.closest('[data-gc-regen]')) {
                const item = selectedGeocodeItem();
                if (item) runCreate(item.geocode?.kind === 'video' ? 'video' : 'image', item.id);
                return;
            }
            if (t.closest('[data-gc-cancel]') && state.busy?.jobId) { env()?.geocodeCancel?.(state.busy.jobId); return; }
            if (t.closest('[data-gc-clear-log]')) { state.logs = []; repaint(); }
        });
        zone.querySelector('#gcPreset')?.addEventListener('change', (event) => {
            state.preset = event.target.value;
            const preset = PRESETS.find((p) => p.id === state.preset);
            if (preset?.id === 'sequence') { const seq = sequenceSize(); setSize(seq.width, seq.height); } else if (preset) setSize(preset.w, preset.h);
            repaint();
        });
        const sizeInput = (id, key) => zone.querySelector(id)?.addEventListener('change', (event) => {
            state[key] = Math.round(Number(event.target.value)) || state[key];
            const match = PRESETS.find((p) => p.w === state.width && p.h === state.height);
            state.preset = match ? match.id : 'custom';
            repaint();
        });
        sizeInput('#gcWidth', 'width');
        sizeInput('#gcHeight', 'height');
        zone.querySelector('#gcDuration')?.addEventListener('change', (event) => { state.duration = Math.max(0, Number(event.target.value) || 0); });
        zone.querySelector('#gcFps')?.addEventListener('change', (event) => { state.fps = Math.round(Number(event.target.value)) || 0; });
        zone.querySelector('[data-gc-loop]')?.addEventListener('change', (event) => { state.loop = !!event.target.checked; });
        zone.querySelector('#gcBgColor')?.addEventListener('change', (event) => { state.bgColor = event.target.value; });
        zone.querySelector('#gcPreviewT')?.addEventListener('change', (event) => { state.previewT = Number(event.target.value) || 0; runPreview(); });
    }

    // Đổi block đang chọn trong lúc pane mở -> nạp lại mã của block đó.
    function onSelectionChanged() {
        const item = selectedGeocodeItem();
        if ((item ? item.id : '') === state.editingItemId) return;
        if (!state.busy) repaint();
    }

    /* MCP (static/js/automation-bridge.js): dựng từ đặc tả tuỳ ý rồi trả dữ liệu cho block. */
    async function buildGeocode(rawSpec, { loop = true, onProgress, onLog } = {}) {
        const spec = {
            lang: rawSpec.lang,
            code: String(rawSpec.code || ''),
            width: Math.round(Number(rawSpec.width)),
            height: Math.round(Number(rawSpec.height)),
            kind: rawSpec.kind === 'video' ? 'video' : 'image',
            fps: rawSpec.kind === 'video' ? Math.round(Number(rawSpec.fps) || defaultFps()) : 0,
            duration: rawSpec.kind === 'video' ? Number(rawSpec.duration) || 3 : 0,
            bg: rawSpec.bg || 'transparent',
        };
        const err = validate(spec);
        if (err) throw new Error(err);
        const result = await renderSpec(spec, { onProgress, onLog });
        return toItemGeocode(spec, result, loop);
    }

    window.GeoCode = {
        LIMITS,
        LANGS,
        PRESETS,
        available,
        renderPaneHtml,
        bindPane,
        repaint,
        onSelectionChanged,
        ensureFrames,
        frameBitmap,
        frameIndexAt,
        buildGeocode,
        starterCode,
        presetSize: (id) => {
            if (id === 'sequence') { const s = sequenceSize(); return { width: s.width, height: s.height }; }
            const p = PRESETS.find((x) => x.id === id);
            return p ? { width: p.w, height: p.h } : null;
        },
        defaultFps,
    };
})();
