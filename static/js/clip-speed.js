/* =============================================================================
 * CLIP SPEED — TỐC ĐỘ PHÁT của block, KHÔNG méo tiếng (CrabbyCut)
 *
 * MỘT NƠI DUY NHẤT giữ mô hình dữ liệu + phép quy đổi thời gian của tính năng tốc độ.
 * Cả bốn nơi dùng chung file này nên không thể lệch nhau:
 *
 *   index.html            : ánh xạ thời gian SEQUENCE <-> thời gian NGUỒN (lane chính)
 *   editing-runtime.js    : bề rộng block, trim/cắt, preview, sóng âm
 *   backend/server.js     : chuẩn hoá payload export
 *   core_process.cpp      : nhận rate rồi tự dựng setpts / atempo (xem BuildAtempoFilter)
 *
 * HAI TRỤC THỜI GIAN, đừng lẫn:
 *   - thời gian NGUỒN  (giây trong file gốc): clip.start/end, item.source_start
 *   - thời gian SEQUENCE (giây trên timeline đã dựng): vị trí block, playhead
 * Quan hệ:  sequence = nguồn / rate   và   nguồn = sequence × rate
 * Vì vậy rate = 2 làm block NGẮN đi một nửa trên timeline, rate = 0.5 làm nó DÀI gấp đôi.
 *
 * KHÔNG MÉO TIẾNG (pitch_correct = true, mặc định):
 *   - preview : thuộc tính `preservesPitch` của HTMLMediaElement (Chromium làm sẵn
 *               time-stretch giữ cao độ).
 *   - export  : chuỗi `atempo` của FFmpeg (WSOLA — kéo dãn thời gian, giữ cao độ).
 *   Tắt pitch_correct = cố ý cho méo giọng (hiệu ứng "máy nhựa"): preview đặt
 *   preservesPitch = false, export dùng asetrate + aresample.
 *
 * BẪY `atempo`: FFmpeg chỉ nhận 0.5 <= tempo <= 2.0, nên phải NỐI CHUỖI nhiều atempo
 * (4x -> atempo=2,atempo=2). Chuỗi dựng ở C++ (BuildAtempoFilter trong core_process.cpp);
 * hàm atempoChain() ở đây là bản JS ĐỐI CHIẾU cho test, không đi vào sản phẩm.
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ClipSpeed = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const RATE_MIN = 0.1;
    const RATE_MAX = 100;
    const RATE_EPS = 1e-4;          // dưới ngưỡng này coi như đúng 1.0x
    const DEFAULT = { rate: 1, pitch_correct: true, mode: 'normal' };
    // Preset nhanh trên UI, theo thứ tự hiện trên hàng nút.
    const PRESETS = [0.1, 0.5, 1, 1.5, 2, 5];
    // Giới hạn của một tầng `atempo` trong FFmpeg.
    const ATEMPO_MIN = 0.5;
    const ATEMPO_MAX = 2.0;

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function normalize(raw) {
        const src = (raw && typeof raw === 'object') ? raw : {};
        const parsed = Number(src.rate);
        const rate = Number.isFinite(parsed) ? clamp(parsed, RATE_MIN, RATE_MAX) : DEFAULT.rate;
        return {
            // Làm tròn 4 chữ số: giá trị đi qua .crab, payload export và biểu thức FFmpeg,
            // để nguyên đuôi nhị phân là mỗi nơi in ra một chuỗi khác nhau.
            rate: Math.round(rate * 10000) / 10000,
            pitch_correct: src.pitch_correct !== false,
            mode: src.mode === 'curve' ? 'curve' : 'normal',
        };
    }

    /* Tốc độ hiệu dụng của MỘT block (clip lane chính hoặc item overlay). Nhận thẳng
     * object block để mọi nơi gọi giống nhau, khỏi phải nhớ field tên gì. */
    function rateOf(block) {
        return normalize(block && block.speed).rate;
    }

    function isActive(raw) {
        return Math.abs(normalize(raw).rate - 1) > RATE_EPS;
    }

    // Độ dài trên TIMELINE của một đoạn nguồn dài `sourceDuration` giây.
    function sequenceDuration(sourceDuration, rate) {
        const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
        return Math.max(0, Number(sourceDuration) || 0) / r;
    }

    // Độ dài NGUỒN cần lấy để phủ `seqDuration` giây trên timeline.
    function sourceDuration(seqDuration, rate) {
        const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
        return Math.max(0, Number(seqDuration) || 0) * r;
    }

    // Độ dài của block trên timeline, tính thẳng từ clip lane chính (start/end nguồn).
    function clipSequenceDuration(clip) {
        const raw = Math.max(0, (Number(clip && clip.end) || 0) - (Number(clip && clip.start) || 0));
        return sequenceDuration(raw, rateOf(clip));
    }

    // Độ dài NGUỒN mà một item overlay tiêu thụ (item.duration là thời gian TIMELINE).
    function itemSourceDuration(item) {
        return sourceDuration(Number(item && item.duration) || 0, rateOf(item));
    }

    /* GIỜ NGUỒN của khung thứ k trong một block, từ thời gian TIMELINE cục bộ.
     *
     * Tách riêng vì đây là chỗ ĐÃ TỪNG SAI và sai rất khó thấy: khâu bake chuỗi khung
     * Retouch dùng thẳng `k / fps` làm giờ nguồn. Không có tốc độ thì đúng; có tốc độ thì
     * chuỗi khung đi qua nguồn ở 1x trong khi hình nền (setpts) và tiếng (atempo) đã chạy
     * ở `rate` — đường VÁ thì miếng vá lấy mặt sai thời điểm, còn đường BAKE CẢ KHUNG thì
     * chính hình nhìn thấy phát ở tốc độ thường trong khi tiếng đã nhanh/chậm.
     *
     * Kẹp theo `sourceSpan` (độ dài NGUỒN), KHÔNG theo độ dài timeline. */
    function sourceTimeAt(sourceStart, localSeqTime, rate, sourceSpan) {
        const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
        const span = Math.max(0, Number(sourceSpan) || 0);
        const local = Math.max(0, Number(localSeqTime) || 0);
        return (Number(sourceStart) || 0) + Math.min(span, local * r);
    }

    /* TRẦN THỜI LƯỢNG TIMELINE của một block, theo phần phim CÒN LẠI của nguồn.
     *
     * Block tiêu thụ `duration × rate` giây nguồn kể từ `source_start`, nên phần nguồn
     * còn dùng được là `assetDuration − source_start`, quy về timeline thì chia rate.
     * Kéo dài quá con số này là đòi những khung hình KHÔNG TỒN TẠI — preview thì <video>
     * chạy hết phim rồi bị play() lại từ đầu (nhìn thấy mấy khung đầu nhấp nháy lặp lại),
     * bản xuất thì overlay biến mất hẳn (eof_action=pass ở core_process.cpp).
     *
     * `assetDuration` KHÔNG biết (ảnh, text, shape, asset chưa probe) -> Infinity: không
     * có "hết nguồn" nào để kẹp, và kẹp bừa theo số liệu rỗng thì cắt cụt block lành. */
    function maxItemDuration(item, assetDuration) {
        const dur = Number(assetDuration);
        if (!Number.isFinite(dur) || dur <= 0) return Infinity;
        const start = Math.max(0, Number(item && item.source_start) || 0);
        return Math.max(0, sequenceDuration(Math.max(0, dur - start), rateOf(item)));
    }

    /* SỬA các block ĐÃ LỠ dài quá nguồn (dự án .crab lưu trước khi tay cầm trim biết kẹp).
     * `durationOf(item)` do nơi gọi cung cấp — chỉ nó biết item nào trỏ vào asset VIDEO và
     * asset đó dài bao nhiêu; trả về null/NaN nghĩa là "không biết" -> bỏ qua item đó.
     * KHÔNG sửa tại chỗ (nơi gọi còn giữ bản cũ cho undo), và chỉ đụng vào item thật sự
     * tràn — cùng hợp đồng với clampRowsToSegments của lane chính. */
    function clampItemsToSource(items, durationOf, minDuration) {
        const list = Array.isArray(items) ? items : [];
        const floor = Number.isFinite(minDuration) && minDuration > 0 ? minDuration : 0.2;
        let fixed = 0;
        const out = list.map((item) => {
            if (!item || typeof item !== 'object') return item;
            const limit = maxItemDuration(item, durationOf ? durationOf(item) : null);
            if (!Number.isFinite(limit)) return item;
            const capped = Math.max(floor, limit);
            // Dung sai 1 khung ở 60fps: sai số dấu phẩy động của ffprobe không phải lỗi tràn.
            if (!(Number(item.duration) > capped + 0.017)) return item;
            fixed += 1;
            return { ...item, duration: capped };
        });
        return { items: out, fixed };
    }

    /* Chuỗi `atempo` cho một tốc độ bất kỳ — BẢN ĐỐI CHIẾU cho test; sản phẩm dùng
     * BuildAtempoFilter bên C++. Chia dần cho 2 (hoặc 0.5) tới khi phần dư lọt vào dải
     * [0.5, 2.0] mà FFmpeg chấp nhận. */
    function atempoChain(rate) {
        const r0 = normalize({ rate }).rate;
        if (Math.abs(r0 - 1) <= RATE_EPS) return [];
        const parts = [];
        let r = r0;
        while (r > ATEMPO_MAX) { parts.push(ATEMPO_MAX); r /= ATEMPO_MAX; }
        while (r < ATEMPO_MIN) { parts.push(ATEMPO_MIN); r /= ATEMPO_MIN; }
        parts.push(r);
        return parts.map((value) => `atempo=${(Math.round(value * 10000) / 10000)}`);
    }

    // Nhãn hiển thị: 1x / 1.5x / 0.25x — bỏ số 0 thừa cho gọn.
    function formatRate(rate) {
        const r = normalize({ rate }).rate;
        const text = r.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
        return `${text}x`;
    }

    function formatDuration(seconds) {
        const value = Math.max(0, Number(seconds) || 0);
        const mm = Math.floor(value / 60);
        const ss = value - mm * 60;
        return mm > 0 ? `${mm}:${ss.toFixed(2).padStart(5, '0')}` : `${ss.toFixed(2)}s`;
    }

    return {
        RATE_MIN,
        RATE_MAX,
        RATE_EPS,
        DEFAULT,
        PRESETS,
        ATEMPO_MIN,
        ATEMPO_MAX,
        normalize,
        rateOf,
        isActive,
        sequenceDuration,
        sourceDuration,
        clipSequenceDuration,
        itemSourceDuration,
        sourceTimeAt,
        maxItemDuration,
        clampItemsToSource,
        atempoChain,
        formatRate,
        formatDuration,
    };
});
