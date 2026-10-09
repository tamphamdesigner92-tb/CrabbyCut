/* =============================================================================
 * LOGO REMOVAL ENGINE — xoá logo / watermark CỐ ĐỊNH trên khung hình (CrabbyCut)
 *
 * File RIÊNG và là NGUỒN SỰ THẬT DUY NHẤT cho preview lẫn export, cùng khuôn với
 * retouch.js / color-adjust.js: dữ liệu, chuẩn hoá, quy đổi pixel và công thức xử lý
 * viết MỘT LẦN ở đây. Preview gọi các hàm *Rgba() trên ImageData; export gửi đúng các
 * hình chữ nhật pixel mà `exportRects` tính ra cho sidecar dựng filter FFmpeg.
 *
 * BA CHẾ ĐỘ:
 *   'delogo'   — nội suy từ VIỀN của hình chữ nhật, CHÉP ĐÚNG công thức của filter
 *                `delogo` (libavfilter/vf_delogo.c): mỗi pixel bên trong = trung bình
 *                có trọng số của 4 cạnh, trọng số tỉ lệ nghịch khoảng cách. Viền của
 *                hình chữ nhật là mẫu -> vùng vẽ nên RỘNG hơn logo một chút.
 *   'blur'     — làm mờ hộp 2 lượt (= `boxblur` power 2 của FFmpeg), mép phản xạ.
 *   'pixelate' — khảm: thu nhỏ trung bình theo ô rồi phóng lại kiểu láng giềng gần
 *                (= `scale=flags=area` rồi `scale=flags=neighbor`).
 *   'ai'       — mô hình inpainting MI-GAN VẼ LẠI nền phía sau logo. Quá nặng để chạy theo
 *                từng khung lúc xem/xuất nên là một LƯỢT XỬ LÝ TRƯỚC (asr/logo_inpaint_sidecar.py)
 *                ra các miếng vá PNG theo đúng PTS từng khung nguồn; preview và sidecar xuất
 *                cùng dán các miếng vá đó. Chưa xử lý xong thì mọi nơi rơi về 'delogo' trên
 *                CÙNG hình chữ nhật (`fallbackMode`) — module này không biết gì về miếng vá.
 *
 * TOẠ ĐỘ VÙNG: tỉ lệ 0..1, gốc TRÊN-TRÁI, theo VÙNG ẢNH THẬT của block (lane chính:
 * vùng ảnh của clip trong khung nối; overlay: cả asset). Lưu tỉ lệ nên độc lập độ phân
 * giải — cùng một vùng dùng cho proxy LQ lẫn bản xuất gốc.
 *
 * TỰ NHẬN DIỆN (`detectLogoRegions`): logo cố định là thứ có CẠNH GIỐNG NHAU ở mọi
 * khung trong khi nền phía sau đổi. Lấy TRUNG VỊ gradient theo thời gian: cạnh của nền
 * chuyển động triệt tiêu nhau, cạnh của logo ở lại. Chỉ xét 4 góc khung.
 *
 * Module THUẦN (không DOM, không state của app) -> chạy được trong Node cho test.
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.LogoRemoval = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MODES = ['delogo', 'blur', 'pixelate', 'ai'];
    const MAX_REGIONS = 4;
    // Cạnh nhỏ nhất của một vùng (tỉ lệ). Nhỏ hơn thì delogo không còn pixel bên trong.
    const MIN_REGION = 0.005;
    // Lề an toàn (pixel) giữa vùng và mép khung khi XUẤT: `delogo` từ chối hình chữ nhật
    // chạm/ra ngoài khung ("Logo area is outside of the frame") và cả bản xuất đổ theo.
    // Preview dùng CÙNG lề để hai bên xử lý đúng một vùng.
    const FRAME_MARGIN = 2;
    // Cạnh nhỏ nhất (pixel) của vùng sau quy đổi — dưới mức này bỏ vùng, không xử lý.
    const MIN_REGION_PX = 6;

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function round5(v) { return Math.round(v * 1e5) / 1e5; }

    // ---------------------------------------------------------------------
    // 1. MÔ HÌNH DỮ LIỆU — `clip.logo_removal` / `item.logo_removal`
    // ---------------------------------------------------------------------

    function defaultLogoRemoval() {
        return {
            enabled: false,
            mode: 'delogo',
            // 0..100 — chỉ có nghĩa với 'blur' / 'pixelate'.
            strength: 50,
            regions: [],
        };
    }

    function normalizeRegion(raw) {
        if (!raw || typeof raw !== 'object') return null;
        let x = Number(raw.x);
        let y = Number(raw.y);
        let w = Number(raw.w);
        let h = Number(raw.h);
        if (![x, y, w, h].every(Number.isFinite)) return null;
        x = clamp(x, 0, 1);
        y = clamp(y, 0, 1);
        w = clamp(w, 0, 1 - x);
        h = clamp(h, 0, 1 - y);
        if (w < MIN_REGION || h < MIN_REGION) return null;
        return { x: round5(x), y: round5(y), w: round5(w), h: round5(h) };
    }

    function normalize(raw) {
        const out = defaultLogoRemoval();
        if (!raw || typeof raw !== 'object') return out;
        out.enabled = raw.enabled === true;
        out.mode = MODES.includes(raw.mode) ? raw.mode : 'delogo';
        const s = Number(raw.strength);
        out.strength = Number.isFinite(s) ? Math.round(clamp(s, 0, 100)) : 50;
        out.regions = (Array.isArray(raw.regions) ? raw.regions : [])
            .map(normalizeRegion)
            .filter(Boolean)
            .slice(0, MAX_REGIONS);
        return out;
    }

    // Có THẬT SỰ xử lý gì không (bật + có ít nhất một vùng). Dùng ở mọi đường vẽ/xuất.
    function isActive(cfg) {
        if (!cfg) return false;
        const c = normalize(cfg);
        return c.enabled && c.regions.length > 0;
    }

    // Field RỖNG hẳn (tắt VÀ không còn vùng) -> xoá khỏi dữ liệu dự án. KHÁC isActive:
    // tắt công tắc nhưng còn vùng thì GIỮ, để bật lại không phải vẽ lại từ đầu.
    function isEmpty(cfg) {
        if (!cfg) return true;
        const c = normalize(cfg);
        return !c.enabled && c.regions.length === 0;
    }

    // ---------------------------------------------------------------------
    // 2. QUY ĐỔI SANG PIXEL — MỘT hàm cho preview lẫn export
    // ---------------------------------------------------------------------

    /* Vùng tỉ lệ -> hình chữ nhật pixel NGUYÊN trên một khung W×H.
     * `content` = vùng ảnh thật của block trong khung đó (pixel). Toạ độ và kích thước
     * được làm CHẴN: stream YUV 4:2:0 có mặt phẳng màu nửa độ phân giải, số lẻ là
     * `crop`/`delogo` tự làm tròn và vùng lệch 1px so với preview. */
    function regionToPixels(region, content, frameW, frameH, margin = FRAME_MARGIN) {
        const r = normalizeRegion(region);
        if (!r || !(frameW > 0) || !(frameH > 0)) return null;
        const c = content && content.width > 0 && content.height > 0
            ? content
            : { x: 0, y: 0, width: frameW, height: frameH };
        const evenDown = (v) => Math.floor(v / 2) * 2;
        const evenUp = (v) => Math.ceil(v / 2) * 2;
        const lo = evenUp(margin);
        const hiX = evenDown(frameW - margin);
        const hiY = evenDown(frameH - margin);
        const x0 = clamp(evenDown(c.x + r.x * c.width), lo, hiX);
        const y0 = clamp(evenDown(c.y + r.y * c.height), lo, hiY);
        const x1 = clamp(evenUp(c.x + (r.x + r.w) * c.width), lo, hiX);
        const y1 = clamp(evenUp(c.y + (r.y + r.h) * c.height), lo, hiY);
        const w = x1 - x0;
        const h = y1 - y0;
        if (w < MIN_REGION_PX || h < MIN_REGION_PX) return null;
        return { x: x0, y: y0, w, h };
    }

    /* Thông số hiệu ứng theo PIXEL của chính vùng đó — quy từ `strength` 0..100 theo cạnh
     * NGẮN của vùng, để cùng một mức cho cùng cảm giác ở mọi độ phân giải.
     *   blur: bán kính hộp. Trần = 1/4 cạnh ngắn: `boxblur` đòi bán kính ≤ nửa cạnh của
     *         MẶT PHẲNG, mà mặt phẳng màu 4:2:0 chỉ bằng nửa vùng.
     *   pixelate: cạnh ô khảm. */
    function effectParamPx(mode, strength, w, h) {
        const s = clamp(Number(strength) || 0, 0, 100) / 100;
        const m = Math.max(1, Math.min(w, h));
        if (mode === 'blur') {
            const cap = Math.max(1, Math.floor(m / 4));
            return clamp(Math.round(1 + s * (cap - 1)), 1, cap);
        }
        if (mode === 'pixelate') {
            const cap = Math.max(2, Math.floor(m / 2));
            return clamp(Math.round(2 + s * (cap - 2)), 2, cap);
        }
        return 0;
    }

    /* Danh sách hình chữ nhật cần xử lý trên khung W×H, kèm thông số pixel.
     * Trả [] khi không có gì để làm. Export gửi đúng mảng này cho backend. */
    /* Chế độ công thức pixel dùng cho một cấu hình: 'ai' khi CHƯA có miếng vá thì xử lý như
     * 'delogo' (cùng vùng, không cần tham số) — preview tạm và bản xuất dự phòng giống nhau. */
    function fallbackMode(mode) {
        return mode === 'ai' ? 'delogo' : (MODES.includes(mode) ? mode : 'delogo');
    }

    function exportRects(cfg, content, frameW, frameH) {
        const c = normalize(cfg);
        if (!c.enabled || !c.regions.length) return [];
        const out = [];
        c.regions.forEach((region) => {
            const px = regionToPixels(region, content, frameW, frameH);
            if (!px) return;
            // 'ai' không có tham số: effectParamPx trả 0 như 'delogo'.
            out.push({ ...px, p: effectParamPx(c.mode, c.strength, px.w, px.h) });
        });
        return out;
    }

    // ---------------------------------------------------------------------
    // 3. XỬ LÝ PIXEL (RGBA, tại chỗ) — preview và bake chuỗi khung dùng chung
    // ---------------------------------------------------------------------

    /* DELOGO — chép công thức `apply_delogo` của FFmpeg (SAR 1:1).
     * `data` là buffer RGBA rộng `stride` pixel; (rx,ry,rw,rh) là hình chữ nhật BỊ THAY.
     * FFmpeg hiện hành nới hình chữ nhật ra 1px mỗi phía (band = 1) rồi lấy HÀNG/CỘT
     * NGOÀI CÙNG đó làm mẫu — tức mẫu nằm NGOÀI vùng, và cả vùng (kể cả mép) bị thay.
     * Đã đối chiếu từng pixel với `delogo` thật (tests/scripts/logo_removal.js). Caller vì
     * vậy phải để 1px quanh vùng còn nằm trong buffer (xem FRAME_MARGIN).
     * Hàng/cột mẫu không bị ghi nên ghi tại chỗ vẫn đúng. Mẫu cạnh lấy 3 điểm liền nhau
     * (như FFmpeg) để bớt nhạy nhiễu. */
    function delogoRgba(data, stride, rx, ry, rw, rh) {
        const x1 = rx - 1;
        const x2 = rx + rw;
        const y1 = ry - 1;
        const y2 = ry + rh;
        if (x1 < 0 || y1 < 0 || x2 >= stride || (y2 + 1) * stride * 4 > data.length) return;
        if (x2 - x1 < 2 || y2 - y1 < 2) return;
        const at = (x, y, ch) => data[(y * stride + x) * 4 + ch];
        for (let ch = 0; ch < 3; ch++) {
            for (let y = y1 + 1; y < y2; y++) {
                const left = at(x1, y, ch) + at(x1, y - 1, ch) + at(x1, y + 1, ch);
                const right = at(x2, y, ch) + at(x2, y - 1, ch) + at(x2, y + 1, ch);
                const dyT = y - y1;
                const dyB = y2 - y;
                for (let x = x1 + 1; x < x2; x++) {
                    const dxL = x - x1;
                    const dxR = x2 - x;
                    const wl = dxR * dyT * dyB;
                    const wr = dxL * dyT * dyB;
                    const wt = dxL * dxR * dyB;
                    const wb = dxL * dxR * dyT;
                    const top = at(x, y1, ch) + at(x - 1, y1, ch) + at(x + 1, y1, ch);
                    const bot = at(x, y2, ch) + at(x - 1, y2, ch) + at(x + 1, y2, ch);
                    const weight = (wl + wr + wt + wb) * 3;
                    const v = (left * wl + right * wr + top * wt + bot * wb) / weight;
                    data[(y * stride + x) * 4 + ch] = Math.round(v);
                }
            }
        }
    }

    // Một lượt làm mờ hộp 1 chiều, mép PHẢN XẠ (như blur() của vf_boxblur).
    function boxPass(src, dst, count, step, offset, radius) {
        const n = count;
        const win = 2 * radius + 1;
        const idx = (i) => {
            let j = i;
            if (j < 0) j = -j;
            if (j >= n) j = 2 * (n - 1) - j;
            return clamp(j, 0, n - 1);
        };
        let sum = 0;
        for (let i = -radius; i <= radius; i++) sum += src[offset + idx(i) * step];
        for (let i = 0; i < n; i++) {
            dst[offset + i * step] = sum / win;
            sum += src[offset + idx(i + radius + 1) * step] - src[offset + idx(i - radius) * step];
        }
    }

    /* LÀM MỜ HỘP 2 lượt × 2 trục (= `boxblur=r:2`) trên hình chữ nhật của buffer RGBA. */
    function boxBlurRgba(data, stride, rx, ry, rw, rh, radius, passes = 2) {
        const r = Math.min(Math.floor(radius), Math.floor((Math.min(rw, rh) - 1) / 2));
        if (!(r >= 1)) return;
        const a = new Float32Array(rw * rh);
        const b = new Float32Array(rw * rh);
        for (let ch = 0; ch < 3; ch++) {
            for (let y = 0; y < rh; y++) {
                for (let x = 0; x < rw; x++) a[y * rw + x] = data[((ry + y) * stride + rx + x) * 4 + ch];
            }
            for (let p = 0; p < passes; p++) {
                for (let y = 0; y < rh; y++) boxPass(a, b, rw, 1, y * rw, r);
                for (let x = 0; x < rw; x++) boxPass(b, a, rh, rw, x, r);
            }
            for (let y = 0; y < rh; y++) {
                for (let x = 0; x < rw; x++) {
                    data[((ry + y) * stride + rx + x) * 4 + ch] = Math.round(a[y * rw + x]);
                }
            }
        }
    }

    /* KHẢM — ô biên floor(i·w/n): cùng lưới mà `scale=flags=area` xuống n ô rồi
     * `scale=flags=neighbor` lên lại cho ra. */
    function pixelateRgba(data, stride, rx, ry, rw, rh, block) {
        const b = Math.max(2, Math.floor(block));
        const nx = Math.max(1, Math.round(rw / b));
        const ny = Math.max(1, Math.round(rh / b));
        for (let cy = 0; cy < ny; cy++) {
            const y0 = Math.floor((cy * rh) / ny);
            const y1 = Math.floor(((cy + 1) * rh) / ny);
            for (let cx = 0; cx < nx; cx++) {
                const x0 = Math.floor((cx * rw) / nx);
                const x1 = Math.floor(((cx + 1) * rw) / nx);
                const count = Math.max(1, (x1 - x0) * (y1 - y0));
                const sum = [0, 0, 0];
                for (let y = y0; y < y1; y++) {
                    for (let x = x0; x < x1; x++) {
                        const i = ((ry + y) * stride + rx + x) * 4;
                        sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2];
                    }
                }
                const avg = sum.map((s) => Math.round(s / count));
                for (let y = y0; y < y1; y++) {
                    for (let x = x0; x < x1; x++) {
                        const i = ((ry + y) * stride + rx + x) * 4;
                        data[i] = avg[0]; data[i + 1] = avg[1]; data[i + 2] = avg[2];
                    }
                }
            }
        }
    }

    /* Áp MỘT hình chữ nhật (đã quy đổi bằng exportRects) lên buffer RGBA.
     * `rect` toạ độ theo buffer: caller cắt vùng ra ImageData riêng thì truyền gốc 0,0. */
    function applyRectRgba(data, stride, rect, mode) {
        if (!rect) return;
        mode = fallbackMode(mode);
        if (mode === 'blur') boxBlurRgba(data, stride, rect.x, rect.y, rect.w, rect.h, rect.p);
        else if (mode === 'pixelate') pixelateRgba(data, stride, rect.x, rect.y, rect.w, rect.h, rect.p);
        else delogoRgba(data, stride, rect.x, rect.y, rect.w, rect.h);
    }

    // ---------------------------------------------------------------------
    // 4. TỰ NHẬN DIỆN LOGO CỐ ĐỊNH Ở GÓC
    // ---------------------------------------------------------------------

    function rgbaToLuma(data, w, h) {
        const out = new Uint8Array(w * h);
        for (let i = 0, j = 0; i < w * h; i++, j += 4) {
            out[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
        }
        return out;
    }

    // Vùng được xét: 4 GÓC khung (bỏ dải chữ thập ở giữa). Logo kênh/TikTok nằm ở góc;
    // xét cả khung là bắt nhầm phụ đề cứng, bảng tên ở giữa dưới, v.v.
    function inCornerZone(x, y, w, h) {
        const fx = x / w;
        const fy = y / h;
        return (fx < 0.42 || fx > 0.58) && (fy < 0.36 || fy > 0.64);
    }

    function medianOf(buf, n) {
        // Chèn — n nhỏ (≤ 32 khung), nhanh hơn sort() và không cấp phát.
        for (let i = 1; i < n; i++) {
            const v = buf[i];
            let j = i - 1;
            while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
            buf[j + 1] = v;
        }
        return n % 2 ? buf[(n - 1) >> 1] : (buf[n / 2 - 1] + buf[n / 2]) / 2;
    }

    /* frames: mảng ảnh XÁM (Uint8Array w×h, xem rgbaToLuma), cùng kích thước, lấy rải
     * khắp đoạn video. Trả { regions: [{x,y,w,h,score}], staticScene, reason }.
     *   regions: tỉ lệ 0..1 theo khung vào, đã nới lề để viền delogo lấy mẫu ở nền sạch.
     *   staticScene: nền gần như đứng yên -> không phân biệt được logo với cảnh, kết quả
     *                có thể là cạnh của cảnh. UI phải nói ra điều này. */
    function detectLogoRegions(frames, w, h, options = {}) {
        const n = Array.isArray(frames) ? frames.length : 0;
        if (n < 3 || !(w > 8) || !(h > 8)) return { regions: [], staticScene: false, reason: 'frames' };
        const N = w * h;
        const buf = new Float32Array(n);
        const score = new Float32Array(N);
        let dynamicPx = 0;
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const i = y * w + x;
                // Nền ĐỘNG: độ lệch luma giữa các khung. Đếm để biết cảnh có chuyển động
                // hay không (chỉ để cảnh báo, không lọc theo pixel: logo trong suốt một
                // phần cũng đổi luma theo nền).
                let lo = 255;
                let hi = 0;
                for (let k = 0; k < n; k++) {
                    const v = frames[k][i];
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
                if (hi - lo > 24) dynamicPx++;
                if (!inCornerZone(x, y, w, h)) continue;
                for (let k = 0; k < n; k++) buf[k] = frames[k][i + 1] - frames[k][i - 1];
                const gx = medianOf(buf, n);
                for (let k = 0; k < n; k++) buf[k] = frames[k][i + w] - frames[k][i - w];
                const gy = medianOf(buf, n);
                score[i] = Math.sqrt(gx * gx + gy * gy);
            }
        }
        const staticScene = dynamicPx / Math.max(1, (w - 2) * (h - 2)) < 0.12;

        // Ngưỡng: sàn cố định + thích nghi theo phân bố điểm của CẢ vùng góc (tính cả pixel
        // điểm 0), để cảnh nhiều chi tiết đứng yên không biến cả góc thành "logo".
        // PHẢI tính trên cả vùng: chỉ lấy pixel điểm > 0 thì trên nền động, số pixel đó
        // phần lớn CHÍNH LÀ logo -> ngưỡng bị logo kéo lên cao hơn cả logo (đo được 224 với
        // logo 221 trên video thật) và không tìm ra gì. Có trần: nền động cho trung vị
        // gradient ≈ 0, nên cạnh logo (thường > 80) luôn vượt 60.
        let sum = 0;
        let sum2 = 0;
        let cnt = 0;
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                if (!inCornerZone(x, y, w, h)) continue;
                const s = score[y * w + x];
                sum += s; sum2 += s * s; cnt++;
            }
        }
        const mean = cnt ? sum / cnt : 0;
        const std = cnt ? Math.sqrt(Math.max(0, sum2 / cnt - mean * mean)) : 0;
        const minEdge = Number(options.minEdge) || 20;
        const thr = Math.max(minEdge, Math.min(60, mean + 3 * std));
        const edge = new Uint8Array(N);
        let edgeCount = 0;
        for (let i = 0; i < N; i++) if (score[i] >= thr) { edge[i] = 1; edgeCount++; }
        if (!edgeCount) return { regions: [], staticScene, reason: 'none' };

        // Nở mặt nạ để các nét rời của cùng một logo (chữ + biểu tượng) nhập thành MỘT khối.
        const rad = Math.max(2, Math.round(Math.min(w, h) * 0.02));
        const dil = dilate(edge, w, h, rad);

        // Thành phần liên thông trên mặt nạ đã nở.
        const label = new Int32Array(N);
        const stack = new Int32Array(N);
        const comps = [];
        let next = 1;
        for (let s0 = 0; s0 < N; s0++) {
            if (!dil[s0] || label[s0]) continue;
            let sp = 0;
            stack[sp++] = s0;
            label[s0] = next;
            let minX = w, minY = h, maxX = 0, maxY = 0, edges = 0, total = 0;
            while (sp) {
                const i = stack[--sp];
                const x = i % w;
                const y = (i - x) / w;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (edge[i]) { edges++; total += score[i]; }
                if (x > 0 && dil[i - 1] && !label[i - 1]) { label[i - 1] = next; stack[sp++] = i - 1; }
                if (x < w - 1 && dil[i + 1] && !label[i + 1]) { label[i + 1] = next; stack[sp++] = i + 1; }
                if (y > 0 && dil[i - w] && !label[i - w]) { label[i - w] = next; stack[sp++] = i - w; }
                if (y < h - 1 && dil[i + w] && !label[i + w]) { label[i + w] = next; stack[sp++] = i + w; }
            }
            next++;
            // Hộp của mặt nạ đã nở rộng hơn nét thật đúng `rad` mỗi phía -> co lại.
            comps.push({
                x0: Math.min(w - 1, minX + rad), y0: Math.min(h - 1, minY + rad),
                x1: Math.max(0, maxX - rad), y1: Math.max(0, maxY - rad),
                edges, total,
            });
        }

        const minEdges = Math.max(10, Math.round(N * 0.0002));
        const pad = Math.max(2, Math.round(Math.min(w, h) * 0.012));
        const regions = comps
            .filter((c) => c.x1 > c.x0 && c.y1 > c.y0)
            .filter((c) => {
                const bw = c.x1 - c.x0 + 1;
                const bh = c.y1 - c.y0 + 1;
                if (c.edges < minEdges) return false;
                // Quá nhỏ = nhiễu nén; quá lớn = cả mảng cảnh đứng yên, không phải logo.
                if (bw < w * 0.02 || bh < h * 0.012) return false;
                if (bw > w * 0.5 || bh > h * 0.4) return false;
                // Logo có mật độ nét đáng kể trong hộp của nó; một đường kẻ dài đơn độc
                // (mép bàn, khung cửa) thì không.
                return c.edges / (bw * bh) >= 0.04;
            })
            .map((c) => {
                const x0 = clamp(c.x0 - pad, 0, w - 1);
                const y0 = clamp(c.y0 - pad, 0, h - 1);
                const x1 = clamp(c.x1 + pad + 1, 1, w);
                const y1 = clamp(c.y1 + pad + 1, 1, h);
                return {
                    x: round5(x0 / w), y: round5(y0 / h),
                    w: round5((x1 - x0) / w), h: round5((y1 - y0) / h),
                    score: Math.round(c.total),
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_REGIONS);
        return { regions, staticScene, reason: regions.length ? 'ok' : 'none' };
    }

    // Nở mặt nạ nhị phân theo hình vuông bán kính r (tách 2 trục, đếm trượt -> O(N)).
    function dilate(mask, w, h, r) {
        const tmp = new Uint8Array(w * h);
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            let c = 0;
            for (let x = -r; x <= r; x++) if (x >= 0 && x < w) c += mask[y * w + x];
            for (let x = 0; x < w; x++) {
                tmp[y * w + x] = c > 0 ? 1 : 0;
                const add = x + r + 1;
                const sub = x - r;
                if (add < w) c += mask[y * w + add];
                if (sub >= 0) c -= mask[y * w + sub];
            }
        }
        for (let x = 0; x < w; x++) {
            let c = 0;
            for (let y = -r; y <= r; y++) if (y >= 0 && y < h) c += tmp[y * w + x];
            for (let y = 0; y < h; y++) {
                out[y * w + x] = c > 0 ? 1 : 0;
                const add = y + r + 1;
                const sub = y - r;
                if (add < h) c += tmp[add * w + x];
                if (sub >= 0) c -= tmp[sub * w + x];
            }
        }
        return out;
    }

    return {
        MODES, MAX_REGIONS, MIN_REGION, FRAME_MARGIN, MIN_REGION_PX,
        defaultLogoRemoval, normalize, normalizeRegion, isActive, isEmpty,
        regionToPixels, effectParamPx, exportRects, fallbackMode,
        delogoRgba, boxBlurRgba, pixelateRgba, applyRectRgba,
        rgbaToLuma, inCornerZone, detectLogoRegions, dilate,
    };
});
