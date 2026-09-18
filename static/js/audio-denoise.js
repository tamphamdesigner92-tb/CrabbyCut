/* =============================================================================
 * AUDIO DENOISE — KHỬ TIẾNG ỒN cho audio (CrabbyCut)
 *
 * MỘT NƠI DUY NHẤT giữ bảng quy đổi "thông số người dùng -> thông số kỹ thuật".
 * Cả hai đường dùng chung file này nên KHÔNG THỂ lệch nhau:
 *
 *   PREVIEW  (Web Audio)  : previewParams()  -> highpass BiquadFilter + AudioWorklet
 *                           trừ phổ (static/js/denoise-worklet.js)
 *   EXPORT   (FFmpeg)     : ffmpegFilters()  -> highpass + afftdn
 *
 * Vì sao hai bên khớp dù thuật toán khác nhau: cả hai đều là bộ khử nhiễu trên phổ,
 * và ĐẠI LƯỢNG ĐIỀU KHIỂN là một — `nr` (dB) = MỨC GIẢM TỐI ĐA cho phần bị coi là
 * nhiễu. Preview đặt nó làm SÀN ĐỘ LỢI (floorGain = 10^(-nr/20)). Đo trên tín hiệu
 * dạng lời nói + ồn trắng, HAI bên đều cho nền ồn ở khoảng nghỉ giảm gần đúng `nr` dB
 * còn đoạn có tiếng chỉ suy hao dưới ~1.5 dB (xem tests/scripts/audio_denoise_pipeline.js).
 * Cái KHÔNG khớp tuyệt đối là chi tiết ước lượng nhiễu theo thời gian của từng bên;
 * đó là sai khác về "chất", không phải về mức — nghe được là preview đại diện đúng.
 *
 * MÔ HÌNH DỮ LIỆU (gắn trên clip lane chính `clip.audio_denoise` và trên item overlay
 * `item.audio_denoise`; KHÔNG có field = tắt, để dự án cũ mở lên vẫn y nguyên):
 *   { enabled: bool, profile: 'voice' | 'room' | 'strong', amount: 0..100 }
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AudioDenoise = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* BẢNG KIỂU. Ba kiểu khác nhau ở BA chỗ, không hơn — thêm chỗ thứ tư là hai đường
     * preview/export bắt đầu khó giữ khớp:
     *   highpass : cắt ầm ì (rung bàn, gió, điều hoà) — thứ mà trừ phổ làm rất tệ.
     *   nrMin/Max: dải MỨC GIẢM TỐI ĐA (dB) mà thanh "Mức độ" quét qua. Đây là con số
     *              điều khiển thật sự: đo được nền ồn giảm gần đúng bằng `nr`.
     *   nf       : ngưỡng "cái gì bị coi là nhiễu" (dB). Chỉ dùng để chỉnh mức NƯƠNG TAY
     *              với tín hiệu: nf âm hơn -> giữ giọng tốt hơn, khử ít hơn một chút.
     *
     * VÌ SAO KHÔNG DÙNG `tn=1` (track_noise) CỦA afftdn: đo trên FFmpeg 8.1 thì bật tn
     * làm bộ lọc gần như KHÔNG khử gì (-0.2 dB) ở mọi nf/fo/nl đã thử. Với nf CỐ ĐỊNH
     * thì ngược lại: nền ồn giảm đúng bằng `nr` (đo -10.0 / -20.0 / -29.4 dB cho
     * nr = 10 / 20 / 30) và ĐỘC LẬP với mức ồn của nguồn — thử trên nguồn ồn -31 dBFS
     * lẫn -55 dBFS đều ra cùng con số, đoạn có tiếng chỉ suy hao 0.3-0.8 dB. Nhờ vậy
     * không cần đo trước sàn nhiễu của từng file. */
    const PROFILES = {
        voice: {
            key: 'voice',
            label: 'Giọng nói',
            hint: 'Mặc định cho tiếng nói thu bằng mic — cắt ầm ì, giữ nguyên độ ấm.',
            highpass: 90,
            nrMin: 8,
            nrMax: 24,
            nf: -28,
        },
        room: {
            key: 'room',
            label: 'Tiếng ồn nền',
            hint: 'Ồn đều và liên tục: điều hoà, quạt, tiếng máy, tiếng phòng.',
            highpass: 60,
            nrMin: 10,
            nrMax: 30,
            nf: -24,
        },
        strong: {
            key: 'strong',
            label: 'Mạnh',
            hint: 'Nhiễu nặng (ngoài trời, gió, xì băng). Có thể làm giọng hơi mỏng.',
            highpass: 110,
            nrMin: 14,
            nrMax: 40,
            nf: -20,
        },
    };

    const PROFILE_ORDER = ['voice', 'room', 'strong'];
    const DEFAULT = { enabled: false, profile: 'voice', amount: 60 };

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function round1(value) {
        return Math.round(value * 10) / 10;
    }

    function normalize(raw) {
        const src = (raw && typeof raw === 'object') ? raw : {};
        const profile = PROFILES[String(src.profile || '')] ? String(src.profile) : DEFAULT.profile;
        const amountRaw = Number(src.amount);
        const amount = Number.isFinite(amountRaw) ? Math.round(clamp(amountRaw, 0, 100)) : DEFAULT.amount;
        return { enabled: src.enabled === true, profile, amount };
    }

    function isActive(raw) {
        const cfg = normalize(raw);
        return cfg.enabled;
    }

    /* Mức giảm tối đa (dB) mà thanh "Mức độ" đang chọn — con số DUY NHẤT mà cả preview
     * lẫn export đều lấy làm "độ mạnh". Hiện luôn trên UI để người dùng biết mình đang
     * ép bao nhiêu dB, thay vì một phần trăm không có đơn vị. */
    function reductionDb(raw) {
        const cfg = normalize(raw);
        const p = PROFILES[cfg.profile];
        return round1(p.nrMin + (cfg.amount / 100) * (p.nrMax - p.nrMin));
    }

    /* Chuỗi filter FFmpeg (mảng, để backend nối bằng dấu phẩy sau khi lọc ký tự).
     * Rỗng = không khử nhiễu. */
    function ffmpegFilters(raw) {
        const cfg = normalize(raw);
        if (!cfg.enabled) return [];
        const p = PROFILES[cfg.profile];
        const nr = reductionDb(cfg);
        return [
            `highpass=f=${p.highpass}`,
            `afftdn=nr=${nr.toFixed(1)}:nf=${p.nf}`,
        ];
    }

    /* Spec gửi cho backend. Cùng dạng với color_adjust: frontend sinh chuỗi filter,
     * backend lọc ký tự rồi chuyển thẳng xuống sidecar. Kèm luôn thông số gốc để
     * đọc log/debug hiểu được vì sao ra chuỗi đó. */
    function exportSpec(raw) {
        const cfg = normalize(raw);
        const filters = ffmpegFilters(cfg);
        if (!filters.length) return null;
        return {
            filters,
            profile: cfg.profile,
            amount: cfg.amount,
            reduction_db: reductionDb(cfg),
        };
    }

    /* Thông số cho preview. floorGain/noiseFloor là BIÊN ĐỘ TUYẾN TÍNH (không phải dB)
     * — worklet quy sang công suất bằng cách bình phương. */
    function previewParams(raw) {
        const cfg = normalize(raw);
        const p = PROFILES[cfg.profile];
        const nr = reductionDb(cfg);
        return {
            active: cfg.enabled,
            highpassHz: p.highpass,
            // Sàn độ lợi: phần bị coi là nhiễu KHÔNG bị nén quá `nr` dB (giống afftdn).
            floorGain: Math.pow(10, -nr / 20),
            // Hệ số trừ dư (nhân vào CÔNG SUẤT nhiễu ước lượng): ước lượng nào cũng
            // thiếu, trừ đúng bằng ước lượng thì luôn còn sót. Buộc theo thanh "Mức độ".
            overSub: 1.2 + (cfg.amount / 100) * 1.6,
            /* Cận dưới TUYỆT ĐỐI của ước lượng nhiễu. Cố tình để RẤT nhỏ (chỉ chặn chia
             * cho 0 ở đoạn im lặng số học) chứ KHÔNG quy từ `nf`: afftdn với nf cố định
             * đo ra kết quả độc lập với mức ồn của nguồn, nên preview cũng phải độc lập
             * — buộc một sàn theo dBFS vào đây là preview đổi kết quả theo độ to của
             * bản thu trong khi bản xuất thì không. */
            noiseFloor: 1e-6,
        };
    }

    /* Nhãn ngắn cho UI/timeline ("Khử ồn · Giọng nói 17.0 dB"). */
    function summaryLabel(raw) {
        const cfg = normalize(raw);
        if (!cfg.enabled) return '';
        return `${PROFILES[cfg.profile].label} · ${reductionDb(cfg).toFixed(1)} dB`;
    }

    return {
        PROFILES,
        PROFILE_ORDER,
        DEFAULT,
        normalize,
        isActive,
        reductionDb,
        ffmpegFilters,
        exportSpec,
        previewParams,
        summaryLabel,
    };
});
