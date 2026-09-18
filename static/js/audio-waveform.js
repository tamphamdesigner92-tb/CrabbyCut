/* =============================================================================
 * AUDIO WAVEFORM STORE — nguồn DỮ LIỆU SÓNG ÂM THẬT cho timeline (CrabbyCut)
 *
 * File RIÊNG (thuần dữ liệu + vẽ canvas, KHÔNG phụ thuộc DOM/state của app) để
 * editing-runtime.js chỉ việc hỏi "cho tôi N cột biên độ trong khoảng thời gian
 * nguồn [a,b]" rồi vẽ. Muốn đổi cách hiển thị (màu, dạng thanh) thì sửa ở đây.
 *
 * DỮ LIỆU: file .pk do sidecar `audio-peaks` sinh (xem native/sidecar/core_process.cpp
 * và khối "SÓNG ÂM THẬT" trong backend/server.js). Mỗi peak = 2 byte [max|abs|, rms]
 * tại 750 peak/giây. Backend trả 200 (nhị phân) hoặc 202 (đang sinh) -> store tự
 * poll lại với backoff nên UI KHÔNG BAO GIỜ phải chờ.
 *
 * MIP PYRAMID: mỗi lần zoom nhỏ lại, 1 cột pixel có thể trải hàng nghìn peak. Nếu
 * quét thẳng dữ liệu gốc thì mỗi frame tốn hàng triệu phép so sánh. Vì vậy store
 * dựng LƯỜI các mức giảm mẫu ×4 (max của max, rms = √mean(rms²)) và luôn chọn mức
 * sao cho 1 cột chỉ đọc 1..4 phần tử -> chi phí vẽ gần như không đổi theo zoom.
 *
 * TOẠ ĐỘ: mọi API nhận THỜI GIAN NGUỒN (giây trong file gốc), nên block đã trim
 * (source_start / clip.start-end) vẫn khớp tuyệt đối.
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AudioWaveform = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MAGIC = 'CRWV';
    const FORMAT_VERSION = 1;
    const HEADER_SIZE = 32;
    const FLAG_NO_AUDIO = 0x1;

    const MIP_FACTOR = 4;        // mỗi mức giảm mẫu 4 lần
    const MIP_MIN_COUNT = 64;    // thôi giảm mẫu khi còn quá ít peak
    const MAX_COLUMNS = 8192;    // trần số cột 1 lần vẽ (viewport rộng nhất cũng dưới mức này)

    // Màu mặc định (caller có thể ghi đè theo từng target/giai đoạn).
    // Hệ số phóng biên độ khi VẼ (không đụng dữ liệu, không đụng âm lượng xuất bản).
    // Xem chú thích trong drawColumns.
    const DISPLAY_GAIN = 1.35;
    const DEFAULT_PEAK_COLOR = 'rgba(0,210,255,0.92)';
    const DEFAULT_RMS_COLOR = 'rgba(206,247,255,0.72)';
    const DEFAULT_BASELINE_COLOR = 'rgba(255,255,255,0.16)';

    const RETRY_FIRST_MS = 160;  // 202 -> poll lại: nhanh lúc đầu, giãn dần
    const RETRY_MAX_MS = 1200;
    const RETRY_GIVEUP_MS = 120000;
    const FETCH_MAX_ATTEMPTS = 3; // số lần thử lại khi lỗi mạng/HTTP

    const MAX_ENTRIES = 24;                  // LRU: số nguồn giữ trong RAM
    const MAX_BYTES = 48 * 1024 * 1024;      // LRU: tổng dung lượng peak giữ trong RAM

    // Trần bề rộng bộ đệm dải sóng, tính bằng điểm ảnh thiết bị (xem paintViewportBuffered).
    const STRIP_MAX_DEVICE_PX = 8192;

    const store = new Map();     // key -> entry
    const listeners = new Set();
    let scratch = new Float32Array(0);
    const strips = new Map();    // bufferKey -> { canvas, sig, startCss, widthCss, heightCss, stats }
    let dataVersion = 0;         // tăng mỗi lần dữ liệu peak đổi -> mọi bộ đệm phải dựng lại

    function now() { return Date.now(); }

    function emitChange(key) {
        /* Dữ liệu .pk về muộn (tải bất đồng bộ) hoặc bị nạp lại -> mọi dải đệm đang giữ hình
         * CŨ. Tăng version NGAY ĐÂY, trước khi gọi listener: bên gọi thường schedule một lượt
         * vẽ trong rAF, và lượt đó phải thấy chữ ký đã khác để chịu dựng lại. Thiếu dòng này
         * thì sóng âm đứng nguyên ở trạng thái dở dang lúc dữ liệu chưa tải xong. */
        dataVersion += 1;
        for (const listener of listeners) {
            try { listener(key); } catch (_) { /* listener lỗi không được phá store */ }
        }
    }

    // Đăng ký callback "có dữ liệu mới" -> caller schedule vẽ lại. Trả hàm huỷ đăng ký.
    function onChange(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function parsePeakBuffer(buffer) {
        if (!buffer || buffer.byteLength < HEADER_SIZE) throw new Error('file peak quá ngắn');
        const view = new DataView(buffer);
        const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        if (magic !== MAGIC) throw new Error(`magic không đúng: ${magic}`);
        const version = view.getUint16(4, true);
        if (version !== FORMAT_VERSION) throw new Error(`version .pk không hỗ trợ: ${version}`);
        const headerSize = view.getUint16(6, true) || HEADER_SIZE;
        const sampleRate = view.getUint32(8, true);
        const bucketSamples = view.getUint16(12, true) || 1;
        const flags = view.getUint16(14, true);
        const duration = view.getFloat64(16, true);
        const declared = view.getUint32(24, true);
        // Không tin tuyệt đối peakCount trong header: kẹp theo dung lượng thật để
        // 1 file bị cắt ngang không làm vẽ ra vùng nhớ rác.
        const available = Math.max(0, Math.floor((buffer.byteLength - headerSize) / 2));
        const peakCount = Math.max(0, Math.min(declared, available));
        return {
            peaksPerSecond: sampleRate / bucketSamples,
            flags,
            duration,
            peakCount,
            data: new Uint8Array(buffer, headerSize, peakCount * 2),
        };
    }

    function newEntry(key, url) {
        return {
            key,
            url,
            status: 'idle',   // idle | pending | ready | no_audio | error
            error: null,
            data: null,
            peakCount: 0,
            peaksPerSecond: 750,
            duration: 0,
            mips: [],
            bytes: 0,
            attempts: 0,
            deadline: 0,
            timer: null,
            lastUsed: now(),
        };
    }

    function resetEntry(entry, url) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.url = url;
        entry.status = 'idle';
        entry.error = null;
        entry.data = null;
        entry.peakCount = 0;
        entry.mips = [];
        entry.bytes = 0;
        entry.attempts = 0;
        entry.deadline = 0;
        entry.timer = null;
    }

    function applyParsed(entry, parsed) {
        entry.data = parsed.data;
        entry.peakCount = parsed.peakCount;
        entry.peaksPerSecond = parsed.peaksPerSecond;
        entry.duration = parsed.duration;
        entry.bytes = parsed.data.byteLength;
        entry.mips = [];
        entry.error = null;
        entry.status = ((parsed.flags & FLAG_NO_AUDIO) || parsed.peakCount === 0) ? 'no_audio' : 'ready';
        entry.lastUsed = now();
        return entry;
    }

    // Nạp trực tiếp 1 buffer .pk vào store (không qua HTTP). Dùng cho test và cho
    // trường hợp dữ liệu peak đã có sẵn trong tay (không cần gọi endpoint).
    function ingest(key, buffer, url) {
        if (!key || !buffer) return null;
        let entry = store.get(key);
        if (!entry) {
            entry = newEntry(key, url || `ingest:${key}`);
            store.set(key, entry);
        }
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        if (url) entry.url = url;
        applyParsed(entry, parsePeakBuffer(buffer));
        evictIfNeeded();
        emitChange(key);
        return entry;
    }

    function evictIfNeeded() {
        let total = 0;
        for (const entry of store.values()) total += entry.bytes;
        if (store.size <= MAX_ENTRIES && total <= MAX_BYTES) return;
        const candidates = Array.from(store.values())
            .filter((entry) => entry.status === 'ready' || entry.status === 'error')
            .sort((a, b) => a.lastUsed - b.lastUsed);
        for (const entry of candidates) {
            if (store.size <= MAX_ENTRIES && total <= MAX_BYTES) break;
            total -= entry.bytes;
            if (entry.timer) clearTimeout(entry.timer);
            store.delete(entry.key);
        }
    }

    function scheduleRetry(entry, delayMs) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            entry.timer = null;
            startFetch(entry);
        }, delayMs);
    }

    function startFetch(entry) {
        if (typeof fetch !== 'function') {
            entry.status = 'error';
            entry.error = 'môi trường không có fetch';
            return;
        }
        entry.status = 'pending';
        if (!entry.deadline) entry.deadline = now() + RETRY_GIVEUP_MS;
        const requestUrl = entry.url;
        // cache:'no-store' — URL không content-addressed (đổi file nguồn vẫn cùng URL) nên
        // KHÔNG để trình duyệt giữ bản cũ; cache thật của ta là store trong RAM này.
        fetch(requestUrl, { cache: 'no-store' }).then((res) => {
            if (entry.url !== requestUrl) return; // nguồn đã bị đổi giữa đường
            if (res.status === 202) {
                if (now() > entry.deadline) {
                    entry.status = 'error';
                    entry.error = 'sinh dữ liệu sóng âm quá lâu';
                    emitChange(entry.key);
                    return;
                }
                const waited = Math.max(0, RETRY_GIVEUP_MS - (entry.deadline - now()));
                const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * Math.pow(1.5, Math.floor(waited / 1000)));
                scheduleRetry(entry, delay);
                return;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.arrayBuffer().then((buffer) => {
                if (entry.url !== requestUrl) return;
                applyParsed(entry, parsePeakBuffer(buffer));
                evictIfNeeded();
                emitChange(entry.key);
            });
        }).catch((error) => {
            if (entry.url !== requestUrl) return;
            entry.attempts += 1;
            if (entry.attempts < FETCH_MAX_ATTEMPTS && now() < entry.deadline) {
                scheduleRetry(entry, Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * Math.pow(2, entry.attempts)));
                return;
            }
            entry.status = 'error';
            entry.error = String(error && error.message ? error.message : error);
            emitChange(entry.key);
        });
    }

    // Bảo đảm có dữ liệu cho 1 nguồn. Gọi mỗi frame cũng an toàn & rẻ (chỉ tra Map).
    // key: id ổn định của nguồn (vd 'main' hoặc 'asset:<id>'); url: endpoint trả .pk.
    function ensure(key, url) {
        if (!key || !url) return null;
        let entry = store.get(key);
        if (!entry) {
            entry = newEntry(key, url);
            store.set(key, entry);
        } else if (entry.url !== url) {
            resetEntry(entry, url); // nguồn đổi (đổi asset/đổi file) -> nạp lại
        }
        entry.lastUsed = now();
        if (entry.status === 'idle') startFetch(entry);
        return entry;
    }

    function statusOf(key) {
        const entry = store.get(key);
        return entry ? entry.status : 'idle';
    }

    function maxMipLevel(entry) {
        let level = 0;
        let count = entry.peakCount;
        while (count > MIP_MIN_COUNT) {
            count = Math.ceil(count / MIP_FACTOR);
            level += 1;
        }
        return level;
    }

    // Mức giảm mẫu (dựng lười, cache trong entry). level 0 = dữ liệu gốc.
    function mipAt(entry, level) {
        if (level <= 0) return { step: 1, count: entry.peakCount, data: entry.data };
        if (entry.mips[level]) return entry.mips[level];
        const prev = mipAt(entry, level - 1);
        const count = Math.ceil(prev.count / MIP_FACTOR);
        const data = new Uint8Array(count * 2);
        for (let i = 0; i < count; i += 1) {
            const from = i * MIP_FACTOR;
            const to = Math.min(prev.count, from + MIP_FACTOR);
            let peak = 0;
            let squares = 0;
            let used = 0;
            for (let j = from; j < to; j += 1) {
                const p = prev.data[j * 2];
                if (p > peak) peak = p;
                const r = prev.data[j * 2 + 1];
                squares += r * r;
                used += 1;
            }
            data[i * 2] = peak;
            data[i * 2 + 1] = used ? Math.round(Math.sqrt(squares / used)) : 0;
        }
        const mip = { step: prev.step * MIP_FACTOR, count, data };
        entry.mips[level] = mip;
        entry.bytes += data.byteLength;
        return mip;
    }

    function ensureScratch(size) {
        if (scratch.length < size) scratch = new Float32Array(size);
        return scratch;
    }

    /* Lấy `colCount` cột biên độ cho khoảng THỜI GIAN NGUỒN [srcStart, srcEnd).
     * Trả { values: Float32Array [peak0, rms0, peak1, rms1, ...] (0..1), count } —
     * mảng DÙNG LẠI giữa các lần gọi, phải vẽ xong trước khi gọi tiếp.
     * Trả null nếu nguồn chưa sẵn sàng / không có tiếng. */
    function columns(key, srcStart, srcEnd, colCount) {
        const entry = store.get(key);
        if (!entry || entry.status !== 'ready' || entry.peakCount <= 0) return null;
        entry.lastUsed = now();
        const start = Math.max(0, Number(srcStart) || 0);
        const end = Number(srcEnd) || 0;
        if (!(end > start)) return null;
        const total = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(colCount) || 1));
        const pps = entry.peaksPerSecond;
        const peaksPerColumn = ((end - start) * pps) / total;
        const level = Math.max(0, Math.min(
            maxMipLevel(entry),
            Math.floor(Math.log(Math.max(1, peaksPerColumn)) / Math.log(MIP_FACTOR)),
        ));
        const mip = mipAt(entry, level);
        const values = ensureScratch(total * 2);
        const span = (end - start) / total;
        for (let i = 0; i < total; i += 1) {
            const t0 = start + span * i;
            const t1 = t0 + span;
            let from = Math.floor((t0 * pps) / mip.step);
            let to = Math.ceil((t1 * pps) / mip.step);
            if (to <= from) to = from + 1;
            // Ngoài phạm vi dữ liệu (block dài hơn nguồn) -> im lặng, KHÔNG kéo lặp peak cuối.
            if (from >= mip.count || to <= 0) {
                values[i * 2] = 0;
                values[i * 2 + 1] = 0;
                continue;
            }
            if (from < 0) from = 0;
            if (to > mip.count) to = mip.count;
            let peak = 0;
            let squares = 0;
            let used = 0;
            for (let j = from; j < to; j += 1) {
                const p = mip.data[j * 2];
                if (p > peak) peak = p;
                const r = mip.data[j * 2 + 1];
                squares += r * r;
                used += 1;
            }
            values[i * 2] = peak / 255;
            values[i * 2 + 1] = used ? Math.sqrt(squares / used) / 255 : 0;
        }
        return { values, count: total };
    }

    /* Vẽ cột biên độ vào ctx trong hình chữ nhật rect {x,y,w,h}.
     * Dáng CapCut: envelope PEAK đối xứng quanh trục giữa + lõi RMS đậm hơn ở trong.
     * opts: {gain, peakColor, rmsColor, baselineColor, alpha} */
    function drawColumns(ctx, rect, cols, opts) {
        if (!ctx || !rect || !cols || !cols.count) return;
        const o = opts || {};
        /* gain của caller = ÂM LƯỢNG THẬT của block (volume/100), phải giữ nguyên quan hệ
           "tăng Volume -> sóng cao hơn". DISPLAY_GAIN là hệ số RIÊNG cho phần NHÌN: nguồn
           quay thực tế hiếm khi chạm đỉnh 0 dB nên ở gain 1.0 sóng vẽ ra thấp lè tè, khó
           canh điểm cắt. Nhân thêm ở ĐÂY (bộ vẽ dùng chung) để mọi giai đoạn cùng một dáng
           sóng; Math.min(1, ...) bên dưới vẫn chặn nên chỗ to nhất chỉ chạm mép dải. */
        const gain = (o.gain == null ? 1 : Math.max(0, o.gain)) * DISPLAY_GAIN;
        const centerY = rect.y + rect.h / 2;
        const half = rect.h / 2;
        const colWidth = rect.w / cols.count;
        // Zoom cao (mỗi cột ≥3px) -> chừa 1px khe cho ra dáng "thanh" như CapCut.
        const barWidth = Math.max(0.6, colWidth - (colWidth >= 3 ? 1 : 0));
        ctx.save();
        if (o.alpha != null) ctx.globalAlpha = o.alpha;
        if (o.baselineColor) {
            ctx.fillStyle = o.baselineColor;
            ctx.fillRect(rect.x, centerY - 0.5, rect.w, 1);
        }
        ctx.beginPath();
        for (let i = 0; i < cols.count; i += 1) {
            const value = cols.values[i * 2] * gain;
            if (value <= 0) continue;
            const h = Math.max(0.75, Math.min(1, value) * half);
            ctx.rect(rect.x + i * colWidth, centerY - h, barWidth, h * 2);
        }
        ctx.fillStyle = o.peakColor || DEFAULT_PEAK_COLOR;
        ctx.fill();
        if (o.rmsColor !== 'none') {
            ctx.beginPath();
            for (let i = 0; i < cols.count; i += 1) {
                const value = cols.values[i * 2 + 1] * gain;
                if (value <= 0) continue;
                const h = Math.max(0.5, Math.min(1, value) * half);
                ctx.rect(rect.x + i * colWidth, centerY - h, barWidth, h * 2);
            }
            ctx.fillStyle = o.rmsColor || DEFAULT_RMS_COLOR;
            ctx.fill();
        }
        ctx.restore();
    }

    /* =====================================================================
     * paintViewport — BỘ VẼ DÙNG CHUNG cho MỌI giai đoạn (Editing + các bước trước)
     *
     * Vì sao ở đây chứ không nằm trong editing-runtime.js: nếu mỗi giai đoạn tự
     * viết vòng lặp vẽ thì các bản sao sẽ lệch nhau (đúng cái bệnh phải chữa:
     * timeline bước trước từng dùng dữ liệu/công thức khác Editing). Mọi nơi gọi
     * hàm này -> hình dạng, màu, cách xử lý "chưa có dữ liệu" là DUY NHẤT.
     *
     * Canvas do CALLER tạo & đặt vào DOM (mỗi giai đoạn có chỗ đặt/z-index riêng);
     * hàm này chỉ chịu trách nhiệm: ghim canvas theo viewport, xoá, và vẽ từng target.
     *
     * view: { canvas, scrollLeft, scrollTop, viewWidth, viewHeight, dpr? }
     * targets: [{ key, url, rect:{x,y,w,h,mapRect?}, srcStart, srcEnd, gain?, alpha?,
     *             mapRect?, peakColor?, rmsColor?, baselineColor? }]
     *   rect ở TOẠ ĐỘ NỘI DUNG (không trừ scroll). Ánh xạ tuyến tính
     *   [srcStart, srcEnd] -> [mapRect.x, mapRect.x + mapRect.w] (mặc định mapRect =
     *   rect), nên hàm này KHÔNG cần biết zoom của app. Truyền mapRect khi dải sóng bị
     *   THỤT LỀ so với khối thật (xem chú thích chỗ tính secPerPx).
     * Trả { drawn, pending, skipped } để test/gỡ lỗi.
     * ================================================================== */
    function paintViewport(view, targets) {
        const canvas = view && view.canvas;
        if (!canvas || !canvas.getContext) return { drawn: 0, pending: 0, skipped: 0 };
        const viewWidth = Math.max(1, Math.round(view.viewWidth || 0));
        const viewHeight = Math.max(1, Math.round(view.viewHeight || 0));
        const scrollLeft = Number(view.scrollLeft) || 0;
        const scrollTop = Number(view.scrollTop) || 0;
        const dpr = view.dpr || Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        const backingW = Math.round(viewWidth * dpr);
        const backingH = Math.round(viewHeight * dpr);
        if (canvas.width !== backingW) canvas.width = backingW;
        if (canvas.height !== backingH) canvas.height = backingH;
        canvas.style.width = `${viewWidth}px`;
        canvas.style.height = `${viewHeight}px`;
        canvas.style.left = `${scrollLeft}px`;
        canvas.style.top = `${scrollTop}px`;
        canvas.style.display = 'block';
        const ctx = canvas.getContext('2d');
        if (!ctx) return { drawn: 0, pending: 0, skipped: 0 };
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, viewWidth, viewHeight);
        ctx.translate(-scrollLeft, -scrollTop); // từ đây vẽ theo toạ độ nội dung

        const viewRight = scrollLeft + viewWidth;
        const viewBottom = scrollTop + viewHeight;
        const stats = { drawn: 0, pending: 0, skipped: 0 };
        for (const target of (targets || [])) {
            const rect = target && target.rect;
            if (!rect || !(rect.w > 0) || !(rect.h > 0)) { stats.skipped += 1; continue; }
            if (rect.y > viewBottom || rect.y + rect.h < scrollTop) { stats.skipped += 1; continue; }
            const x0 = Math.max(rect.x, scrollLeft);
            const x1 = Math.min(rect.x + rect.w, viewRight);
            if (!(x1 - x0 > 0.5)) { stats.skipped += 1; continue; }
            const alpha = target.alpha == null ? 1 : target.alpha;
            const baselineColor = target.baselineColor || view.baselineColor || DEFAULT_BASELINE_COLOR;
            const entry = ensure(target.key, target.url);
            const status = entry ? entry.status : 'idle';
            if (status === 'no_audio' || status === 'error') { stats.skipped += 1; continue; }
            if (status !== 'ready') {
                // Chưa có dữ liệu -> CHỈ vạch trục mờ. TUYỆT ĐỐI không vẽ sóng giả.
                ctx.save();
                ctx.globalAlpha = 0.5 * alpha;
                ctx.fillStyle = baselineColor;
                ctx.fillRect(x0, rect.y + rect.h / 2 - 0.5, x1 - x0, 1);
                ctx.restore();
                stats.pending += 1;
                continue;
            }
            // Chỉ lấy đúng phần thời gian nguồn của KHÚC ĐANG NHÌN THẤY.
            // mapRect = hình chữ nhật dùng để ÁNH XẠ THỜI GIAN (mặc định = rect vẽ).
            // Tách 2 thứ này vì dải sóng thường được thụt lề cho đẹp (vd 4px mỗi bên
            // để không đè tay cầm resize): nếu ánh xạ theo rect đã thụt thì px/giây bị
            // sai tỉ lệ (dải 600px thụt 8px -> lệch 1.35%, block càng ngắn càng lệch)
            // và sóng không còn thẳng hàng với playhead.
            const mapCandidate = target.mapRect || rect.mapRect;
            const mapRect = mapCandidate && mapCandidate.w > 0 ? mapCandidate : rect;
            const secPerPx = (target.srcEnd - target.srcStart) / mapRect.w;
            const t0 = target.srcStart + (x0 - mapRect.x) * secPerPx;
            const t1 = target.srcStart + (x1 - mapRect.x) * secPerPx;
            const cols = columns(target.key, t0, t1, Math.round((x1 - x0) * dpr));
            if (!cols) { stats.skipped += 1; continue; }
            drawColumns(ctx, { x: x0, y: rect.y, w: x1 - x0, h: rect.h }, cols, {
                gain: target.gain == null ? 1 : target.gain,
                alpha,
                peakColor: target.peakColor,
                rmsColor: target.rmsColor,
                baselineColor,
            });
            stats.drawn += 1;
        }
        return stats;
    }

    /* =====================================================================
     * paintViewportBuffered — CÙNG HÌNH VỚI paintViewport, RẺ HƠN KHI CUỘN
     *
     * `paintViewport` là canvas ẢO HOÁ: vẽ đúng phần đang thấy rồi dời canvas bằng
     * `style.left`. Lúc PHÁT, timeline cuộn bám playhead MỖI KHUNG, và listener 'scroll'
     * gọi vẽ lại -> TÔ LẠI CẢ DẢI SÓNG MỖI KHUNG. `drawColumns` dựng một ctx.rect() cho
     * MỖI CỘT, hai lượt (peak + RMS): khung nhìn 2000px ở dpr 1,5 là ~6000 hình chữ nhật
     * mỗi khung.
     *
     * Chi phí đó KHÔNG hiện trong đồng hồ JS của HUD: Canvas 2D của Chromium chỉ GHI LẠI
     * lệnh vẽ ở luồng JS (đo được 0,6ms trung vị) rồi RA-XTER BẤT ĐỒNG BỘ trên luồng
     * raster — và chính luồng đó chẹn compositor. Vì thế HUD báo "TỔNG JS 2-4% ngân sách"
     * trong khi khung hình rớt 60-80% và `Nhịp UI` xuống 13-25 fps.
     *
     * Số đo (dự án 1728×3072@60fps, Match Script, Preview Cuts, màn 4K toàn màn hình):
     *     vẽ như cũ (canvas trong DOM)              -> 28,9 fps · rớt 52,6%
     *     vẽ vào canvas NGOÀI DOM (không hợp thành) -> 29,4 fps · rớt 50,1%  <- chậm y hệt
     *     chỉ đổi style.left, không vẽ lại          -> 60,0 fps · rớt 0%
     * Tức đây là công VẼ, không phải công hợp thành.
     *
     * CÁCH LÀM: vẽ ĐÚNG DỮ LIỆU THẬT (cùng .pk, cùng công thức, cùng màu) MỘT LẦN vào một
     * dải đệm NGOÀI MÀN HÌNH rộng hơn khung nhìn, rồi mỗi lượt cuộn chỉ `drawImage` lát
     * đang thấy. Blit là MỘT lệnh, thay cho hàng nghìn rect. Hình ra giống hệt tới từng
     * pixel — đây là bộ đệm, KHÔNG phải sóng âm tượng trưng.
     *
     * ĐÃ THỬ VÀ BỎ — chặn bớt SỐ LƯỢT vẽ (vẽ thừa hai bên một biên, chỉ vẽ lại khi cuộn
     * quá biên). Nhanh hơn thật, nhưng chỉ giảm TẦN SUẤT chứ không giảm GIÁ mỗi lượt: sang
     * dự án 60fps (playhead chạy nhanh gấp đôi -> vượt biên gấp đôi số lần) là hỏng lại,
     * đo được 30,7 fps · rớt 49,4%. Ngoài ra `style.left` chỉ đổi khi có lượt vẽ nên canvas
     * đứng lại ở chỗ cũ và HỞ MỘT DẢI TRẮNG ở mép. Đệm + blit vừa nhanh vừa đúng pixel.
     *
     * Dải đệm TRƯỢT theo phần đang xem thay vì phủ cả timeline: ở zoom cao, bề rộng nội
     * dung vượt giới hạn kích thước canvas của trình duyệt.
     *
     * view = view của paintViewport + { bufferKey, contentWidth, createCanvas? }
     *   bufferKey    : mỗi timeline một bộ đệm riêng ('editing', 'timeline'...).
     *   contentWidth : bề rộng NỘI DUNG cuộn (CSS px) để kẹp bề rộng dải đệm.
     *   createCanvas : chỉ dùng cho test (Node không có document).
     * Trả về stats của paintViewport, kèm { mode:'blit'|'direct', rebuilt }.
     * ================================================================== */
    function makeStripCanvas(view) {
        if (view && typeof view.createCanvas === 'function') return view.createCanvas();
        if (typeof document !== 'undefined' && document.createElement) return document.createElement('canvas');
        return null;
    }

    /* Chữ ký hình học: đệm chỉ dùng lại được khi MỌI thứ quyết định hình vẽ còn nguyên.
     * Làm tròn toạ độ về 0,01px để rung số thực không làm dựng lại đệm oan.
     * PHẢI có `gain` và MÀU: ở Editing mỗi block có Volume riêng (gain đổi -> sóng cao
     * thấp khác) và mỗi loại lane một màu — thiếu chúng là kéo Volume mà sóng không đổi. */
    function stripSignature(targets, heightCss, dpr, scrollTop, baselineColor) {
        const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
        let s = `v${dataVersion}|h${r2(heightCss)}|d${dpr}|t${r2(scrollTop)}`
              + `|b${baselineColor || ''}|n${targets.length}`;
        for (const t of targets) {
            const rc = t.rect || {};
            const mp = t.mapRect || rc.mapRect || {};
            s += `|${t.key || ''}:${r2(rc.x)},${r2(rc.y)},${r2(rc.w)},${r2(rc.h)}`
               + `:${r2(mp.x)},${r2(mp.w)}`
               + `:${r2(t.srcStart)},${r2(t.srcEnd)}`
               + `:${t.gain == null ? 1 : r2(t.gain)},${t.alpha == null ? 1 : r2(t.alpha)}`
               + `:${t.peakColor || ''},${t.rmsColor || ''},${t.baselineColor || ''}`
               + `:${statusOf(t.key)}`;
        }
        return s;
    }

    function paintViewportBuffered(view, targets) {
        const canvas = view && view.canvas;
        if (!canvas || !canvas.getContext) return { drawn: 0, pending: 0, skipped: 0, mode: 'none' };
        const list = targets || [];
        const viewWidth = Math.max(1, Math.round(view.viewWidth || 0));
        const viewHeight = Math.max(1, Math.round(view.viewHeight || 0));
        const scrollLeft = Number(view.scrollLeft) || 0;
        const scrollTop = Number(view.scrollTop) || 0;
        const dpr = view.dpr || Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        const contentCss = Math.max(viewWidth, Number(view.contentWidth) || 0);
        const maxStripCss = Math.floor(STRIP_MAX_DEVICE_PX / dpr);
        const widthCss = Math.min(Math.max(1, contentCss), maxStripCss);
        const direct = () => ({ ...paintViewport(view, list), mode: 'direct', rebuilt: true });
        // Khung nhìn rộng hơn cả trần đệm -> đệm vô nghĩa (vẫn phải vẽ lại mỗi lượt cuộn).
        if (viewWidth > widthCss) return direct();

        const bufferKey = view.bufferKey || 'default';
        const sig = stripSignature(list, viewHeight, dpr, scrollTop, view.baselineColor);
        let strip = strips.get(bufferKey);
        const covers = !!strip
            && strip.sig === sig
            && scrollLeft >= strip.startCss - 0.01
            && scrollLeft + viewWidth <= strip.startCss + strip.widthCss + 0.01;

        if (!covers) {
            const stripCanvas = (strip && strip.canvas) || makeStripCanvas(view);
            if (!stripCanvas || !stripCanvas.getContext) return direct();
            // Đặt dải sao cho phần đang cần nằm GIỮA -> cuộn tiếp cả hai chiều đều còn dư.
            const middle = scrollLeft + viewWidth / 2;
            const startCss = Math.max(0, Math.min(Math.max(0, contentCss - widthCss), middle - widthCss / 2));
            const stats = paintViewport({
                canvas: stripCanvas,
                scrollLeft: startCss,
                scrollTop,
                viewWidth: widthCss,
                viewHeight,
                dpr,
                baselineColor: view.baselineColor,
            }, list);
            strip = { canvas: stripCanvas, sig, startCss, widthCss, heightCss: viewHeight, stats };
            strips.set(bufferKey, strip);
        }

        /* BLIT lát đang thấy — vẽ ĐÚNG khung nhìn nên canvas luôn khớp pixel với vị trí
         * cuộn, không còn cảnh hở mép. Nguồn lấy từ mép trái khung nhìn trong dải đệm. */
        const bw = Math.round(viewWidth * dpr);
        const bh = Math.round(viewHeight * dpr);
        if (canvas.width !== bw) canvas.width = bw;
        if (canvas.height !== bh) canvas.height = bh;
        canvas.style.width = `${viewWidth}px`;
        canvas.style.height = `${viewHeight}px`;
        canvas.style.left = `${scrollLeft}px`;
        canvas.style.top = `${scrollTop}px`;
        canvas.style.display = 'block';
        const ctx = canvas.getContext('2d');
        if (!ctx) return { drawn: 0, pending: 0, skipped: 0, mode: 'none' };
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, bw, bh);
        ctx.drawImage(strip.canvas, Math.round((scrollLeft - strip.startCss) * dpr), 0, bw, bh, 0, 0, bw, bh);
        return { ...strip.stats, mode: 'blit', rebuilt: !covers };
    }

    // Thông tin gỡ lỗi/kiểm thử (không dùng trong luồng vẽ).
    function debugState() {
        const items = [];
        let bytes = 0;
        for (const entry of store.values()) {
            bytes += entry.bytes;
            items.push({
                key: entry.key,
                status: entry.status,
                error: entry.error,
                peakCount: entry.peakCount,
                peaksPerSecond: entry.peaksPerSecond,
                duration: entry.duration,
                mipLevels: entry.mips.filter(Boolean).length,
                bytes: entry.bytes,
            });
        }
        return { entries: items, totalBytes: bytes };
    }

    function reset() {
        for (const entry of store.values()) {
            if (entry.timer) clearTimeout(entry.timer);
        }
        store.clear();
        // Đệm giữ hình vẽ từ dữ liệu vừa bị xoá -> phải bỏ theo, nếu không lượt vẽ sau
        // dùng lại nó và hiện sóng của nguồn cũ.
        strips.clear();
        dataVersion += 1;
    }

    return {
        MAGIC, FORMAT_VERSION, HEADER_SIZE, FLAG_NO_AUDIO, MIP_FACTOR,
        DEFAULT_PEAK_COLOR, DEFAULT_RMS_COLOR, DEFAULT_BASELINE_COLOR,
        onChange, ensure, ingest, status: statusOf, columns, drawColumns, paintViewport,
        paintViewportBuffered, parsePeakBuffer, debugState, reset,
    };
});
