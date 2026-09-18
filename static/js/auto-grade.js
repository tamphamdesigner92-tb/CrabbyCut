/* =============================================================================
 * AUTO COLOR GRADING — engine "Tự động chỉnh màu" của CrabbyCut
 *
 * VIỆC CỦA FILE NÀY: đọc MỘT khung hình của block rồi TÍNH RA các giá trị cho
 * đúng những thông số mà panel "Điều chỉnh" đã có (Phơi sáng, Tương phản, Bão hoà,
 * Nhiệt độ, Sắc thái, Vùng tối nhất/Vùng sáng nhất/Bóng/Vùng sáng). KHÔNG thêm
 * bước xử lý mới nào vào chuỗi màu.
 *
 * VÌ SAO KHÔNG THÊM FILTER RIÊNG (nguyên tắc quan trọng nhất ở đây):
 *   Kết quả được ghi thẳng vào `adjustments` sẵn có, y như cách ỐNG HÚT CÂN BẰNG
 *   TRẮNG đang làm. Nhờ vậy export / keyframe / undo / .crab / WYSIWYG đi theo
 *   đường đã có sẵn và ĐÃ ĐƯỢC TEST — auto grade không phát sinh gì để bảo trì.
 *   Hệ quả cố ý: người dùng chỉnh tay đè lên kết quả auto được ngay, vì đó vẫn chỉ
 *   là mấy con số trong cùng những slider đó.
 *
 * NGHIỆM ĐÓNG CHO PHẦN eq (không dò lặp) — chép lại đúng đại số của color-adjust.js:
 *   eq chạy trên plane Y dải hẹp:  yp = s·y + o   (s = 219/255, o = 16/255)
 *   eqParams():  C = c·g,  B = 0.5·c·(g−1)       (c = 1+contrast/100, g = 2^(EV/50))
 *   Thay vào  yp2 = C·(yp − 0.5) + 0.5 + B  và rút gọn:
 *
 *        yp2 = c·g·yp + 0.5·(1 − c)                         (*)
 *
 *   Số hạng chứa 0.5·c·g triệt tiêu hoàn toàn — đây là lý do giải được bằng tay.
 *   Từ (*): độ dốc theo y đúng bằng c·g, nên ĐỘ TRẢI (p95−p05) chỉ phụ thuộc tích
 *   c·g, còn TRUNG VỊ thì phụ thuộc cả c. Hai ràng buộc, hai ẩn -> giải thẳng:
 *
 *        M   = c·g = trảiMongMuon / trảiĐoĐược
 *        c   = 2·(M·yp50 + 0.5 − T·s − o)        (T = trung vị mong muốn)
 *        g   = M / c
 *
 *   Đừng thay bằng vòng lặp dò: sai số của cách này là 0 (kiểm bằng test đối chiếu
 *   thẳng với ColorAdjust.applyToRgb), còn dò lặp thì vừa chậm vừa phụ thuộc điểm
 *   xuất phát.
 *
 * PHẦN KHÔNG CÓ NGHIỆM ĐÓNG — điểm đen/điểm trắng (`tone.blacks` / `tone.whites`):
 *   đường cong tone là spline ĐÃ KẸP [0,1], không nghịch đảo được bằng công thức.
 *   Ở đây dùng CHIA ĐÔI trên chính `ColorAdjust.toneLut()` (hàm đơn điệu theo tham
 *   số) — nghĩa là dò trên ĐÚNG bảng mà preview và export dùng, không phải trên một
 *   mô hình xấp xỉ viết lại. 24 vòng chia đôi là đủ dưới một bậc lượng tử 8-bit.
 *
 * CÂN BẰNG TRẮNG dùng LẠI `ColorAdjust.solveWhiteBalance()` — không viết lại phép
 * giải temp/tint ở đây. Điểm "đáng lẽ trung tính" được ước lượng bằng GRAY-WORLD CÓ
 * TRỌNG SỐ (xem `grayReference`), rồi đưa vào đúng cái hàm mà ống hút đang gọi.
 * BẮT BUỘC gọi SAU khi đã ghi exposure/contrast/tone vào adj: solveWhiteBalance cho
 * pixel chạy qua eq+tone trước rồi mới giải, nên thứ tự sai là lệch màu.
 *
 * Module THUẦN (không đụng DOM, không đụng state của app) -> chạy được trong Node
 * cho test. Việc lấy khung hình là của caller (editing-runtime.js).
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./color-adjust.js'));
    } else {
        root.AutoGrade = factory(root.ColorAdjust);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ColorAdjust) {
    'use strict';

    // ---------------------------------------------------------------------
    // 1. MỤC TIÊU (đích mà bộ giải nhắm tới)
    // ---------------------------------------------------------------------
    //
    // Các con số này là "gu" của bản tự động, cố ý đặt DỊU chứ không đặt theo kiểu
    // ép mọi cảnh về cùng một chỗ: mục tiêu của tính năng là một NỀN vững để người
    // dùng chỉnh tiếp, không phải bản grade cuối cùng.
    const TARGET = {
        // Trung vị độ chói. 0.46 chứ không phải 0.5: xám giữa cảm nhận (18% phản xạ)
        // sau gamma sRGB rơi vào khoảng 0.46, đặt 0.5 làm ảnh hơi "bệt sáng".
        median: 0.46,
        // Độ trải p05..p95 mong muốn. 0.72 giữ được chi tiết 2 đầu; đẩy lên ~0.9 là
        // bắt đầu nghiến đen/cháy sáng ở cảnh tương phản cao.
        spread: 0.72,
        // Bão hoà trung bình (theo HSL) — dưới mức này thì nâng, trên thì hạ.
        saturation: 0.34,
        // Điểm đen/điểm trắng sau khi chỉnh (chừa mép để không mất chi tiết).
        black: 0.015,
        white: 0.985,
    };

    /* KIỂU CHỈNH TỰ ĐỘNG — đổi ĐÍCH mà bộ giải nhắm tới, KHÔNG phải chọn LUT.
     *
     * PHÂN BIỆT VỚI BỘ LỌC (LUT), vì hai thứ này rất dễ bị gộp làm một:
     *   - Kiểu chỉnh ở đây = "đưa footage về chuẩn NÀO" (sáng bao nhiêu, tương phản
     *     bao nhiêu, ấm hay lạnh). Nó vẫn là phép SỬA, đo từ chính khung hình.
     *   - LUT = lựa chọn THẨM MỸ chồng lên trên, không đo gì cả.
     * Vì vậy chọn kiểu ở đây KHÔNG bao giờ ghi vào `adj.lut`; hai lớp độc lập, dùng
     * chung được (auto grade xong vẫn áp LUT lên trên bình thường).
     *
     * QUY ƯỚC DẤU (ĐO ĐƯỢC trên xám 128, đừng suy luận lại — tôi đã hiểu ngược một
     * lần và cả 4 kiểu nhóm "Sắc" ra sai màu: chọn "Ngả vàng" thì ảnh ngả tím):
     *     temperature > 0  ->  ĐỎ / ẤM        temperature < 0  ->  LAM / LẠNH
     *     tint        > 0  ->  LỤC            tint        < 0  ->  MAGENTA (hồng/tím)
     * Suy ra: vàng = ấm + tint DƯƠNG (đỏ+lục) · hồng = ấm + tint ÂM ·
     *         lục = tint DƯƠNG · tím = lạnh + tint ÂM.
     * Test `testHueDirection` khoá đúng 4 hướng này.
     *
     * `bias` cộng vào SAU khi solveWhiteBalance đã trung tính hoá — tức "Ấm" nghĩa là
     * cân trắng cho đúng RỒI mới ngả ấm có chủ đích, chứ không phải bỏ qua cân trắng.
     */
    const STYLES = [
        // --- Trung tính / độ sáng ---
        { id: '', name: 'Trung tính', group: 'Cơ bản',
          hint: 'Cân về chuẩn, không thêm ý đồ màu.',
          targets: {}, bias: {} },
        { id: 'soft_bright', name: 'Sáng & dịu', group: 'Cơ bản',
          hint: 'Sáng hơn, tương phản thấp, màu nhẹ — nội dung tích cực/giáo dục.',
          targets: { median: 0.53, spread: 0.62, saturation: 0.28, black: 0.030 }, bias: {} },
        { id: 'high_key', name: 'Rất sáng (high-key)', group: 'Cơ bản',
          hint: 'Sáng nhất, gần như không bóng tối — bảng trắng, quay màn hình.',
          targets: { median: 0.60, spread: 0.55, saturation: 0.27, black: 0.045, white: 0.975 }, bias: {} },
        { id: 'bright', name: 'Sáng vừa', group: 'Cơ bản',
          hint: 'Sáng hơn trung tính một chút, giữ nguyên tương phản.',
          targets: { median: 0.50 }, bias: {} },
        { id: 'dim', name: 'Trầm', group: 'Cơ bản',
          hint: 'Tối hơn, đằm hơn — kể chuyện, phỏng vấn.',
          targets: { median: 0.40, spread: 0.70 }, bias: {} },

        // --- Tương phản ---
        { id: 'flat', name: 'Phẳng (để chỉnh tay)', group: 'Tương phản',
          hint: 'Nền phẳng, giữ tối đa chi tiết 2 đầu để tự grade tiếp.',
          targets: { median: 0.48, spread: 0.56, saturation: 0.30, black: 0.035, white: 0.965 }, bias: {} },
        { id: 'low_contrast', name: 'Tương phản nhẹ', group: 'Tương phản',
          hint: 'Mềm, không có mảng đen sâu.',
          targets: { spread: 0.64, black: 0.028 }, bias: {} },
        { id: 'punchy', name: 'Đậm nét', group: 'Tương phản',
          hint: 'Tương phản và màu mạnh hơn.',
          targets: { median: 0.45, spread: 0.86, saturation: 0.44 }, bias: {} },
        { id: 'high_contrast', name: 'Tương phản cao', group: 'Tương phản',
          hint: 'Đen sâu, trắng gắt — đồ hoạ, tiêu đề.',
          targets: { median: 0.44, spread: 0.94, black: 0.006, white: 0.994 }, bias: {} },

        // --- Nhiệt độ ---
        { id: 'warm_soft', name: 'Ấm nhẹ', group: 'Nhiệt độ',
          hint: 'Ngả ấm vừa phải, giữ da tự nhiên.',
          targets: {}, bias: { temperature: 8, tint: -1 } },
        { id: 'warm', name: 'Ấm', group: 'Nhiệt độ',
          hint: 'Cân trắng xong ngả ấm có chủ đích.',
          targets: { saturation: 0.36 }, bias: { temperature: 15, tint: -2 } },
        { id: 'warm_strong', name: 'Ấm đậm', group: 'Nhiệt độ',
          hint: 'Ngả ấm rõ — hoàng hôn, đèn vàng.',
          targets: { saturation: 0.38 }, bias: { temperature: 28, tint: -4 } },
        { id: 'cool_soft', name: 'Lạnh nhẹ', group: 'Nhiệt độ',
          hint: 'Ngả lạnh vừa phải, sạch mắt.',
          targets: {}, bias: { temperature: -8, tint: 0 } },
        { id: 'cool', name: 'Lạnh', group: 'Nhiệt độ',
          hint: 'Cân trắng xong ngả lạnh có chủ đích.',
          targets: { saturation: 0.33 }, bias: { temperature: -15, tint: 0 } },
        { id: 'cool_strong', name: 'Lạnh đậm', group: 'Nhiệt độ',
          hint: 'Ngả lạnh rõ — đêm, cảnh mưa.',
          targets: { saturation: 0.31 }, bias: { temperature: -28, tint: 0 } },

        // --- Sắc ---
        { id: 'amber', name: 'Ngả vàng', group: 'Sắc',
          hint: 'Vàng kim, không đỏ — nắng chiều.',
          targets: { saturation: 0.37 }, bias: { temperature: 18, tint: 10 } },
        { id: 'rose', name: 'Ngả hồng', group: 'Sắc',
          hint: 'Hồng phấn nhẹ — chân dung, nội dung nhẹ nhàng.',
          targets: { saturation: 0.35 }, bias: { temperature: 8, tint: -16 } },
        { id: 'green', name: 'Ngả lục', group: 'Sắc',
          hint: 'Ngả lục — thiên nhiên, cây cỏ.',
          targets: { saturation: 0.35 }, bias: { temperature: -4, tint: 18 } },
        { id: 'violet', name: 'Ngả tím', group: 'Sắc',
          hint: 'Ngả tím lạnh — đêm, sân khấu.',
          targets: { saturation: 0.34 }, bias: { temperature: -12, tint: -18 } },

        // --- Bão hoà ---
        { id: 'muted', name: 'Màu nhạt', group: 'Bão hoà',
          hint: 'Rút bớt màu, giữ sáng — nền cho chữ.',
          targets: { saturation: 0.22 }, bias: {} },
        { id: 'vivid', name: 'Màu đậm', group: 'Bão hoà',
          hint: 'Màu bật hơn, không đụng tương phản.',
          targets: { saturation: 0.48 }, bias: {} },
    ];

    function styleById(id) {
        return STYLES.find((s) => s.id === (id || '')) || STYLES[0];
    }

    // Trần cho từng thông số. Auto grade CỐ Ý không dùng hết dải ±100: một khung
    // hình duy nhất không đủ cơ sở để đẩy tới cực đại, và người dùng còn phải chỉnh
    // tiếp lên trên kết quả này.
    const LIMIT = {
        exposure: 70,
        contrast: 60,
        saturation: 60,
        temperature: 70,
        tint: 70,
        blacks: 60,
        whites: 60,
        highlights: 60,
        shadows: 60,
    };

    const YUV_SCALE = 219 / 255;   // s trong công thức (*)
    const YUV_OFFSET = 16 / 255;   // o trong công thức (*)

    // Pixel coi như đã KẸP -> loại khỏi mọi phép thống kê. Cùng tinh thần với
    // WB_CLIP_LOW/HIGH của color-adjust.js: chỗ đã kẹp không còn mang thông tin màu.
    const CLIP_LOW = 0.02;
    const CLIP_HIGH = 0.98;

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function clampSym(v, limit) { return clamp(v, -limit, limit); }

    // Rec.709 — CÙNG hệ số mà color-adjust.js dùng cho plane Y. Đừng đổi sang
    // Rec.601 cho "giống ảnh": lệch hệ số là bộ giải nhắm sai đích.
    function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

    // ---------------------------------------------------------------------
    // 2. PHÂN TÍCH KHUNG HÌNH
    // ---------------------------------------------------------------------

    const HIST_BINS = 1024;   // mịn hơn 256 để phân vị không bị bậc thang ở cảnh phẳng

    /* Đọc RGBA (ImageData.data hoặc mảng tương đương) -> thống kê thuần số.
     *
     * LẤY MẪU THƯA: khung nguồn có thể là 4K (8.3M pixel). Duyệt hết chỉ để lấy phân
     * vị là phí — bước nhảy được chọn sao cho còn ~120k mẫu, sai số phân vị khi đó
     * dưới một bậc 8-bit mà nhanh hơn ~70 lần.
     *
     * BỎ PIXEL TRONG SUỐT (alpha thấp): media overlay có vùng rỗng, tính cả vào thì
     * gray-world bị kéo về màu nền canvas.
     */
    function analyzeFrame(data, width, height, options) {
        const opts = options || {};
        const maxSamples = Math.max(1000, opts.maxSamples || 120000);
        const total = Math.max(1, (width | 0) * (height | 0));
        const stride = Math.max(1, Math.floor(total / maxSamples));

        const hist = new Float64Array(HIST_BINS);
        let counted = 0;
        let clippedLow = 0;
        let clippedHigh = 0;
        let satSum = 0;
        let satCount = 0;
        // Gray-world CÓ TRỌNG SỐ: pixel càng gần trung tính càng đáng tin làm mốc
        // trắng. Xem `grayReference` để biết vì sao không lấy trung bình trần.
        let gwR = 0, gwG = 0, gwB = 0, gwW = 0;

        for (let i = 0; i < total; i += stride) {
            const p = i * 4;
            const a = data[p + 3];
            if (a !== undefined && a < 8) continue;
            const r = data[p] / 255;
            const g = data[p + 1] / 255;
            const b = data[p + 2] / 255;
            const y = luma(r, g, b);

            const mx = Math.max(r, g, b);
            const mn = Math.min(r, g, b);
            if (mx < CLIP_LOW) clippedLow++;
            if (mn > CLIP_HIGH) clippedHigh++;

            hist[Math.min(HIST_BINS - 1, Math.round(y * (HIST_BINS - 1)))]++;
            counted++;

            // Bão hoà HSL (cùng định nghĩa với ColorAdjust.rgbToHsl) — chỉ tính ở
            // vùng chưa kẹp, vì ở đen/trắng tuyệt đối sắc độ vô nghĩa.
            if (mx >= CLIP_LOW && mn <= CLIP_HIGH) {
                const l = (mx + mn) / 2;
                const d = mx - mn;
                if (d > 1e-6) {
                    satSum += d / (1 - Math.abs(2 * l - 1) + 1e-6);
                    satCount++;
                } else {
                    satCount++;
                }

                // Trọng số = (gần trung tính) × (gần trung độ sáng).
                //  - Càng ít bão hoà càng có khả năng là vật thể xám thật.
                //  - Vùng quá tối nhiễu nhiều, vùng quá sáng sắp kẹp -> hạ trọng số.
                const chroma = d / (mx + 1e-6);
                const wNeutral = 1 / (1 + 12 * chroma * chroma);
                const wTone = Math.exp(-Math.pow((y - 0.5) / 0.34, 2));
                const w = wNeutral * wTone;
                gwR += r * w; gwG += g * w; gwB += b * w; gwW += w;
            }
        }

        if (!counted) return null;

        const pct = (frac) => {
            const want = frac * counted;
            let acc = 0;
            for (let i = 0; i < HIST_BINS; i++) {
                acc += hist[i];
                if (acc >= want) return i / (HIST_BINS - 1);
            }
            return 1;
        };

        const p01 = pct(0.01);
        const p05 = pct(0.05);
        const p50 = pct(0.50);
        const p95 = pct(0.95);
        const p99 = pct(0.99);

        return {
            samples: counted,
            p01, p05, p50, p95, p99,
            clipLow: clippedLow / counted,
            clipHigh: clippedHigh / counted,
            saturation: satCount ? satSum / satCount : 0,
            gray: gwW > 1e-6 ? [gwR / gwW, gwG / gwW, gwB / gwW] : null,
            // Khung "vô dụng cho phân tích": gần như một màu (fade đen/trắng, slate,
            // khung rỗng). Bộ giải PHẢI từ chối thay vì nhả ra số vô nghĩa — xem
            // `isDegenerate`.
            flat: (p99 - p01) < 0.045,
        };
    }

    /* Khung có phân tích được không. Tách riêng để caller còn biết mà NHẢY sang
     * khung khác (đầu block hay là frame fade-in đen là chuyện rất thường gặp). */
    function isDegenerate(stats) {
        return !stats || !stats.samples || stats.flat || !stats.gray;
    }

    /* Mốc trung tính để cân bằng trắng.
     *
     * VÌ SAO KHÔNG DÙNG TRUNG BÌNH TRẦN (gray-world kinh điển): cảnh có một mảng màu
     * lớn (áo đỏ, trời xanh, cỏ) sẽ kéo trung bình theo màu đó, và auto WB "sửa" bằng
     * cách nhuộm ngược cả khung sang màu bù — hỏng hơn là không làm gì. Trọng số
     * `wNeutral` ở trên hạ hẳn ảnh hưởng của pixel bão hoà, nên mốc bám vào những
     * vùng thực sự gần xám.
     *
     * Trả về null khi mốc tìm được vẫn còn quá bão hoà: thà KHÔNG chỉnh WB còn hơn
     * chỉnh sai. Cảnh đơn sắc thật (hoàng hôn, đèn sân khấu) rơi vào nhánh này —
     * đúng ý đồ, vì ở đó "trắng" là lựa chọn sáng tạo chứ không phải lỗi máy.
     */
    function grayReference(stats, options) {
        const opts = options || {};
        const maxChroma = opts.maxChroma !== undefined ? opts.maxChroma : 0.34;
        if (!stats || !stats.gray) return null;
        const [r, g, b] = stats.gray;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        if (mx < 1e-4) return null;
        if ((mx - mn) / mx > maxChroma) return null;
        return [r, g, b];
    }

    // ---------------------------------------------------------------------
    // 3. GIẢI eq (phơi sáng + tương phản) — nghiệm đóng, xem đầu file
    // ---------------------------------------------------------------------

    function solveExposureContrast(stats, targets) {
        const T = targets.median;
        const spreadNow = Math.max(0.02, stats.p95 - stats.p05);
        const M = clamp(targets.spread / spreadNow, 0.4, 3.0);   // = c·g

        const yp50 = YUV_SCALE * stats.p50 + YUV_OFFSET;
        let c = 2 * (M * yp50 + 0.5 - T * YUV_SCALE - YUV_OFFSET);
        c = clamp(c, 0.4, 2.0);

        let contrast = clampSym((c - 1) * 100, LIMIT.contrast);
        // Sau khi KẸP contrast thì c đổi -> phải giải LẠI g theo c đã kẹp, nếu không
        // trung vị trượt khỏi đích đúng bằng phần bị kẹp. (Lỗi này rất dễ mắc: kẹp
        // xong rồi vẫn dùng g cũ.)
        const cFinal = 1 + contrast / 100;
        const g = clamp((T * YUV_SCALE + YUV_OFFSET - 0.5 * (1 - cFinal)) / (cFinal * yp50), 0.25, 4);
        const exposure = clampSym(50 * Math.log2(g), LIMIT.exposure);

        return { exposure: Math.round(exposure), contrast: Math.round(contrast) };
    }

    function solveSaturation(stats, targets) {
        const now = stats.saturation;
        if (!(now > 0.02)) return 0;   // ảnh gần như đen trắng: đừng "bơm màu" từ hư không
        const ratio = clamp(targets.saturation / now, 0.5, 1.8);
        return Math.round(clampSym((ratio - 1) * 100, LIMIT.saturation));
    }

    // ---------------------------------------------------------------------
    // 4. GIẢI ĐIỂM ĐEN / ĐIỂM TRẮNG — chia đôi trên chính toneLut của engine
    // ---------------------------------------------------------------------

    // Giá trị mà đường cong tone (chỉ bật MỘT thông số) trả về tại x.
    function toneAt(param, value, x) {
        const adj = ColorAdjust.normalize(null);
        adj.tone[param] = value;
        const lut = ColorAdjust.toneLut(adj, 256);
        return lut[clamp(Math.round(x * 255), 0, 255)];
    }

    /* Tìm giá trị thông số tone sao cho toneAt(param, v, x) ≈ target.
     * Đơn điệu theo v nên chia đôi là đủ và luôn hội tụ. */
    function solveTone(param, x, target, limit) {
        let lo = -limit;
        let hi = limit;
        const at = (v) => toneAt(param, v, x);
        const fLo = at(lo);
        const fHi = at(hi);
        // Đích nằm NGOÀI tầm với của thông số -> trả về biên gần nhất, không cố ép.
        if ((target - fLo) * (target - fHi) > 0) {
            return Math.abs(target - fLo) < Math.abs(target - fHi) ? lo : hi;
        }
        const increasing = fHi > fLo;
        for (let i = 0; i < 24; i++) {
            const mid = (lo + hi) / 2;
            const f = at(mid);
            if ((f < target) === increasing) lo = mid; else hi = mid;
        }
        return Math.round((lo + hi) / 2);
    }

    /* Điểm đen/trắng + cứu vùng kẹp.
     *
     * Đo trên khung ĐÃ qua eq (caller truyền `post`), vì eq đứng TRƯỚC tone trong
     * chuỗi: đo trên khung gốc rồi đặt tone là sai mốc.
     */
    function solveToneGroup(post, targets) {
        const out = { blacks: 0, whites: 0, highlights: 0, shadows: 0 };

        if (post.p01 > targets.black + 0.02) {
            out.blacks = clampSym(solveTone('blacks', post.p01, targets.black, LIMIT.blacks), LIMIT.blacks);
        }
        if (post.p99 < targets.white - 0.02) {
            out.whites = clampSym(solveTone('whites', post.p99, targets.white, LIMIT.whites), LIMIT.whites);
        }

        // CỨU VÙNG KẸP: chỉ chạy khi thực sự có pixel kẹp, và tỉ lệ thuận với mức
        // kẹp đo được. Cố ý không "luôn luôn kéo highlights xuống một chút cho an
        // toàn" — làm vậy là bạc màu mọi cảnh bình thường.
        if (post.clipHigh > 0.005) {
            out.highlights = -Math.round(clamp(post.clipHigh * 400, 0, LIMIT.highlights));
        }
        if (post.clipLow > 0.02) {
            out.shadows = Math.round(clamp(post.clipLow * 200, 0, LIMIT.shadows));
        }
        return out;
    }

    // ---------------------------------------------------------------------
    // 5. ĐIỂM VÀO CHÍNH
    // ---------------------------------------------------------------------

    /* Dự đoán thống kê SAU khi áp eq, không cần lấy mẫu lại khung hình.
     * Dùng chính công thức (*) nên khớp tuyệt đối với cái eq thật sẽ làm. */
    function statsAfterEq(stats, basic) {
        const c = 1 + basic.contrast / 100;
        const g = Math.pow(2, basic.exposure / 50);
        const map = (y) => {
            const yp2 = c * g * (YUV_SCALE * y + YUV_OFFSET) + 0.5 * (1 - c);
            return clamp((yp2 - YUV_OFFSET) / YUV_SCALE, 0, 1);
        };
        const out = {
            p01: map(stats.p01), p05: map(stats.p05), p50: map(stats.p50),
            p95: map(stats.p95), p99: map(stats.p99),
        };
        // Kẹp SINH RA bởi chính eq phải được đếm thêm, nếu không phần cứu vùng kẹp
        // không bao giờ chạy cho ca "auto đẩy sáng làm cháy trời".
        out.clipLow = stats.clipLow + (map(stats.p05) <= 0 ? 0.05 : 0);
        out.clipHigh = stats.clipHigh + (map(stats.p95) >= 1 ? 0.05 : 0);
        return out;
    }

    /* TÍNH bộ thông số tự động cho MỘT khung hình.
     *
     * @param stats   kết quả analyzeFrame()
     * @param baseAdj adjustments hiện có của block (để solveWhiteBalance biết những
     *                bước đứng trước colorbalance đang đặt gì)
     * @param options { styleId, targets, whiteBalance:false, ... }
     *                `targets` truyền tay ĐÈ LÊN targets của kiểu — dùng cho test.
     * @return null nếu khung không phân tích được; ngược lại là PATCH để ghi vào adj.
     */
    function solve(stats, baseAdj, options) {
        const opts = options || {};
        if (isDegenerate(stats)) return null;
        const style = styleById(opts.styleId);
        const targets = Object.assign({}, TARGET, style.targets, opts.targets || {});

        const basic = solveExposureContrast(stats, targets);
        basic.saturation = opts.saturation === false ? 0 : solveSaturation(stats, targets);

        const post = statsAfterEq(stats, basic);
        const tone = opts.tone === false
            ? { blacks: 0, whites: 0, highlights: 0, shadows: 0 }
            : solveToneGroup(post, targets);

        // CÂN BẰNG TRẮNG — phải giải trên adj ĐÃ có exposure/contrast/tone, xem đầu file.
        let temperature = 0;
        let tint = 0;
        if (opts.whiteBalance !== false) {
            const gray = grayReference(stats, opts);
            if (gray) {
                const probe = ColorAdjust.normalize(baseAdj);
                probe.basic.exposure = basic.exposure;
                probe.basic.contrast = basic.contrast;
                probe.basic.saturation = basic.saturation;
                Object.assign(probe.tone, tone);
                const wb = ColorAdjust.solveWhiteBalance(probe, gray);
                if (wb) {
                    temperature = clampSym(wb.temperature, LIMIT.temperature);
                    tint = clampSym(wb.tint, LIMIT.tint);
                }
            }
        }

        // BIAS của kiểu chỉnh cộng vào SAU cân bằng trắng: cân cho đúng trước, rồi mới
        // ngả ấm/lạnh có chủ đích. Cộng trước là bộ giải WB triệt tiêu mất ý đồ đó.
        // Vẫn kẹp lại theo LIMIT để kiểu chỉnh không đẩy vượt trần chung.
        const bias = style.bias || {};
        temperature = clampSym(temperature + (bias.temperature || 0), LIMIT.temperature);
        tint = clampSym(tint + (bias.tint || 0), LIMIT.tint);

        return {
            styleId: style.id,
            basic: {
                exposure: basic.exposure,
                contrast: basic.contrast,
                saturation: basic.saturation,
                temperature: Math.round(temperature),
                tint: Math.round(tint),
            },
            tone,
        };
    }

    /* GHI patch vào một bản adjustments (sửa TẠI CHỖ, hợp với chữ ký mutate() của
     * applyAdjust trong editing-runtime.js).
     *
     * CỐ Ý KHÔNG ĐỤNG: curves, wheels, hsl, effects, mask VÀ **lut**. Đó là những chỗ
     * người dùng dựng bằng tay và auto grade không có cơ sở nào để đoán; xoá chúng đi
     * là mất việc của người ta.
     * RIÊNG `lut`: auto grade là lớp SỬA, LUT là lớp THẨM MỸ chồng lên trên — hai lớp
     * độc lập (chốt 2026-08-04). Trong chuỗi màu `lut3d` vốn đã đứng CUỐI nên thứ tự
     * "LUT áp lên kết quả tự động" là sẵn có, không phải dựng thêm gì.
     */
    function applyPatch(adj, patch) {
        if (!adj || !patch) return adj;
        Object.assign(adj.basic, patch.basic);
        Object.assign(adj.tone, patch.tone);
        return adj;
    }

    return {
        TARGET, LIMIT, HIST_BINS, STYLES, styleById,
        analyzeFrame, isDegenerate, grayReference,
        solveExposureContrast, solveSaturation, solveTone, solveToneGroup,
        statsAfterEq, solve, applyPatch,
        luma,
    };
});
