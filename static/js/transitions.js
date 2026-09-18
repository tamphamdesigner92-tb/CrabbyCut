/* =============================================================================
 * TRANSITION ENGINE — engine hiệu ứng CHUYỂN CẢNH giữa 2 block cùng loại (CrabbyCut)
 *
 * File RIÊNG (tách khỏi text-animations.js) để dễ mở rộng: muốn thêm 1 hiệu ứng
 * chuyển cảnh mới thì thêm 1 khoá vào TRANSITION_OPTIONS + 1 case trong compositor
 * bên dưới; không cần đụng vào editing-runtime.js hay UI.
 *
 * NGUYÊN TẮC WYSIWYG (kim chỉ nam của tính năng này): công thức pha trộn dùng cho
 * PREVIEW (canvas phía frontend) và cho EXPORT phải KHỚP nhau tuyệt đối. Cách bảo đảm:
 * MỌI nơi (thumbnail hover, preview thời gian thực, bake khung khi export) đều gọi
 * đúng compose() trong file này — không nơi nào tự viết lại công thức.
 * Tên hiệu ứng vẫn giữ trùng tên transition của bộ lọc `xfade` (FFmpeg) để dễ đối
 * chiếu, NHƯNG lưu ý: compose() có thêm EASING CURVE + BLUR làm mượt (xem mục "LÀM
 * MƯỢT" bên dưới) nên KHÔNG còn khớp bit-perfect với xfade tuyến tính. Vì vậy export
 * phải tiếp tục dùng đường bake chuỗi PNG từ compose(); nếu sau này muốn chuyển sang
 * xfade cho nhanh thì phải tắt easing/blur (Transitions.setSmoothing) để giữ WYSIWYG.
 *
 * ĐIỀU KIỆN ÁP DỤNG (do người dùng chốt): chỉ khả dụng khi 2 block CÙNG LOẠI đứng
 * SÁT CẠNH nhau trên cùng lane (lane chính: 2 clip liền kề; overlay: 2 item chạm
 * cạnh cùng track). MÔ HÌNH THỜI GIAN: "mượn tại điểm cắt" — vùng chuyển cảnh lấy
 * duration/2 từ đuôi block A và duration/2 từ đầu block B quanh điểm giao.
 *
 * TIẾN ĐỘ THEO GIAI ĐOẠN:
 *   - GĐ1 (file này): danh mục hiệu ứng + compositor canvas (hiện dùng cho HOVER
 *     PREVIEW thumbnail trong panel "Chuyển tiếp"). compose() được thiết kế generic
 *     (nhận 2 callback vẽ lớp A/B) để GĐ3 tái dùng chính nó cho preview thật.
 *   - GĐ3: nối compose() vào preview thời gian thực (frame video thật thay cho tile).
 *   - GĐ4: ánh xạ id -> filter xfade khi export ở sidecar core_process.cpp.
 *   - GĐ5 (ĐÃ GỠ 2026-08-03): từng có lớp tự chọn hiệu ứng cho Magic Fill; người dùng
 *     chốt đặt chuyển cảnh THỦ CÔNG nên lớp này đã bỏ. Engine + danh mục giữ nguyên.
 *
 * Module THUẦN dữ liệu + vẽ canvas 2D, KHÔNG phụ thuộc DOM/state của app.
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.Transitions = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DUR_DEFAULT = 0.5; // thời lượng chuyển cảnh mặc định (giây)
    const DUR_MIN = 0.1;
    const DUR_MAX = 2.0;     // trần cứng; trần động còn bị kẹp bởi thời lượng 2 block

    // Nhóm danh mục (dùng làm sub-tab trong panel).
    const TRANSITION_CATEGORIES = [
        { id: 'basic', label: 'Cơ bản' },
        { id: 'motion', label: 'Chuyển động' },
        { id: 'effect', label: 'Hiệu ứng' },
    ];

    // Danh mục hiệu ứng. `id` = tên transition của FFmpeg xfade (để export ánh xạ 1-1).
    // Thêm hiệu ứng mới = thêm 1 dòng ở đây + (nếu cần dáng vẽ riêng) 1 case trong compose().
    const TRANSITION_OPTIONS = [
        // --- Cơ bản ---
        { id: 'fade', label: 'Mờ dần', category: 'basic' },
        { id: 'fadeblack', label: 'Mờ qua đen', category: 'basic' },
        { id: 'fadewhite', label: 'Mờ qua trắng', category: 'basic' },
        { id: 'dissolve', label: 'Hoà tan', category: 'basic' },
        // --- Chuyển động ---
        { id: 'slideleft', label: 'Trượt trái', category: 'motion' },
        { id: 'slideright', label: 'Trượt phải', category: 'motion' },
        { id: 'slideup', label: 'Trượt lên', category: 'motion' },
        { id: 'slidedown', label: 'Trượt xuống', category: 'motion' },
        { id: 'wipeleft', label: 'Quét trái', category: 'motion' },
        { id: 'wiperight', label: 'Quét phải', category: 'motion' },
        { id: 'zoomin', label: 'Phóng to', category: 'motion' },
        // Cùng CẤU TRÚC với 'zoomin' (hai lớp cùng đội khung, gặp nhau ở giữa) nhưng cú
        // đội mạnh hơn 2.4 lần và ảnh đổi SỚM hơn nhịp phóng, nên giữa vùng lúc nào cũng
        // có một bóng RẤT LỚN của cảnh sau đè lên cảnh trước — xem ECHO_* bên dưới.
        { id: 'echoshift', label: 'Phóng chồng bóng', category: 'motion' },
        /* Bốn mẫu dưới đây dựng theo VIDEO MẪU trong "Effect Demo/Transition" (xem mục
         * "BỐN MẪU ĐO TỪ VIDEO" ở cuối file). Điểm chung: mỗi lớp đi theo một BẢNG SỐ ĐO
         * riêng (phóng / xoay / trượt) và ĐIỂM ĐỔI ẢNH nằm lệch khỏi giữa vùng. */
        { id: 'spinslam', label: 'Xoay đập', category: 'motion' },
        { id: 'stretchleft', label: 'Kéo giãn trái', category: 'motion' },
        { id: 'zoomslide', label: 'Phóng trượt', category: 'motion' },
        // --- Hiệu ứng ---
        { id: 'circleopen', label: 'Mở vòng tròn', category: 'effect' },
        { id: 'circleclose', label: 'Đóng vòng tròn', category: 'effect' },
        { id: 'pixelize', label: 'Vỡ hạt', category: 'effect' },
        { id: 'radial', label: 'Toả tròn', category: 'effect' },
        // 'swirl' KHÔNG có transition tương ứng trong xfade của FFmpeg (biến dạng theo bán
        // kính, xfade không làm được). Không sao: export đã luôn bake khung từ compose().
        { id: 'swirl', label: 'Xoắn', category: 'effect' },
        // 'bokehswing' cũng KHÔNG có transition tương ứng trong xfade (xfade không rắc được
        // hạt sáng lên khung). Cùng lý do với 'swirl': export vốn đã bake khung từ compose().
        { id: 'bokehswing', label: 'Bokeh đung đưa', category: 'effect' },
        // 'flashrotate' xếp vào nhóm HIỆU ỨNG (không phải "Chuyển động") vì cái mắt bắt
        // được trước tiên là CÚ CHỚP TRẮNG; phần xoay/phóng chỉ là cái chở nó đi.
        { id: 'flashrotate', label: 'Chớp sáng xoay', category: 'effect' },
    ];

    const OPTION_BY_ID = TRANSITION_OPTIONS.reduce((m, o) => { m[o.id] = o; return m; }, {});

    function optionById(id) { return OPTION_BY_ID[id] || null; }
    function labelFor(id) { const o = OPTION_BY_ID[id]; return o ? o.label : id; }
    function optionsByCategory(cat) {
        if (!cat || cat === 'all') return TRANSITION_OPTIONS.slice();
        return TRANSITION_OPTIONS.filter((o) => o.category === cat);
    }
    function clampDuration(d) {
        d = Number(d);
        if (!isFinite(d)) return DUR_DEFAULT;
        return Math.min(DUR_MAX, Math.max(DUR_MIN, d));
    }

    // Tiến độ TUYẾN TÍNH trong vùng chuyển cảnh: localT giây tính từ đầu vùng.
    // Đây là biến `P` của xfade; việc làm mượt (easing) được áp BÊN TRONG compose()
    // nên mọi nơi gọi compose (thumbnail / preview / bake export) đều mượt giống nhau.
    function progressAt(localT, duration) {
        const d = clampDuration(duration);
        if (d <= 0) return 1;
        return Math.min(1, Math.max(0, localT / d));
    }

    // ---- LÀM MƯỢT: easing + CỬA TRẬP (motion blur thật) + feather ----------------
    // Vấn đề gốc khiến chuyển cảnh "lộ từng frame": hiệu ứng có CHUYỂN ĐỘNG (trượt,
    // phóng to) dịch chuyển rất xa trong MỘT khung hình xuất. Ví dụ trượt ngang 1920px
    // trong 0.5s ở 30fps, easing inOutCubic (đạo hàm đỉnh = 3) -> giữa vùng ảnh nhảy
    // ~380px/khung: mắt thấy từng nấc rời rạc chứ không thấy chuyển động.
    // Máy quay thật không bị vậy vì cửa trập MỞ trong suốt khung hình -> ảnh ghi được là
    // TRUNG BÌNH của mọi vị trí trong khung đó. Ta làm đúng như vậy:
    //   1) EASING: p tuyến tính -> p đã uốn cong (chậm ở 2 đầu, nhanh ở giữa) nên chuyển
    //      cảnh không "bật" cứng tại 2 mép vùng.
    //   2) CỬA TRẬP (shutter): mỗi khung hình xuất được dựng bằng N MẪU CON trải trong
    //      khoảng thời gian của chính khung đó rồi lấy TRUNG BÌNH ĐỀU. Đây là motion blur
    //      THẬT (không phải làm mờ giả), tương đương render ở fps cao gấp N lần rồi gộp
    //      lại — nên chuyển động liền mạch đúng như khi tăng fps. Số mẫu tự co giãn theo
    //      quãng đường ảnh đi được trong khung; phần khe còn sót giữa 2 mẫu được lấp bằng
    //      một lượt blur nhỏ đúng bằng nửa khe (tán đều, không mất chi tiết).
    //      Cửa trập KHÉP DẦN về 0 ở 2 mép vùng -> khung ĐẦU vẫn đúng bằng A, khung CUỐI
    //      đúng bằng B (điều kiện của mẹo chồng 1 frame khi export).
    //   3) BLUR bell-curve: chỉ còn là ĐƯỜNG LÙI khi không tính được cửa trập (không rõ
    //      fps/thời lượng, hoặc tắt shutter) và cho fadeblack/fadewhite.
    //   4) FEATHER: hiệu ứng có ĐƯỜNG BIÊN chạy (quét/vòng tròn/nan quạt) không cần lấy
    //      mẫu con — làm nhoè chính đường biên là đủ và rẻ hơn nhiều. Độ nhoè NỚI THEO
    //      quãng đường biên đi trong 1 khung (cùng nguyên lý cửa trập).
    // Cường độ đặt theo đơn vị "px ở khung 1080p" rồi nhân theo độ phân giải thật.
    const SMOOTH = {
        easing: true,   // bật/tắt easing
        blur: 1,        // hệ số nhân cường độ blur bell-curve (0 = tắt)
        feather: 1,     // hệ số nhân độ nhoè đường biên (0 = biên cứng)
        shutter: 1,     // hệ số nhân độ mở cửa trập (0 = tắt motion blur thật)
        fps: 30,        // fps THAM CHIẾU để tính cửa trập; đặt = fps xuất thì preview khớp export
    };
    function setSmoothing(opts) {
        if (!opts) return SMOOTH;
        if (typeof opts.easing === 'boolean') SMOOTH.easing = opts.easing;
        if (isFinite(opts.blur)) SMOOTH.blur = Math.max(0, Number(opts.blur));
        if (isFinite(opts.feather)) SMOOTH.feather = Math.max(0, Number(opts.feather));
        if (isFinite(opts.shutter)) SMOOTH.shutter = Math.max(0, Number(opts.shutter));
        if (isFinite(opts.fps) && Number(opts.fps) > 0) SMOOTH.fps = Math.min(240, Math.max(1, Number(opts.fps)));
        return SMOOTH;
    }

    const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));
    const easeInOutSine = (p) => 0.5 - Math.cos(Math.PI * p) / 2;
    const easeInOutQuad = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
    const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
    const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);

    // Easing riêng theo "tính cách" từng nhóm hiệu ứng:
    //   - pha trộn alpha (fade/dissolve/pixelize): sine — êm nhất cho độ sáng.
    //   - chuyển động (slide): inOutCubic — có đà, giống CapCut.
    //   - zoom: inOutCubic — B nở ra êm ở đầu (outCubic làm B "bật" vào ngay).
    //   - biên chạy (wipe/circle/radial): inOutQuad — đủ mượt, không "trôi" quá.
    const EASE_BY_ID = {
        fade: easeInOutSine, dissolve: easeInOutSine, pixelize: easeInOutSine,
        fadeblack: easeInOutSine, fadewhite: easeInOutSine,
        slideleft: easeInOutCubic, slideright: easeInOutCubic,
        slideup: easeInOutCubic, slidedown: easeInOutCubic,
        zoomin: easeInOutCubic,
        /* 'echoshift' dùng BẢNG SỐ ĐO (ECHO_ZOOM) chứ không dùng một hàm ease có sẵn.
         * Đã thử: easeInOutQuad là hàm gần nhất nhưng vẫn lệch tới 0.05 ở nửa sau (nhịp
         * phóng thật rụng NHANH hơn) — ở góc khung 1080×1920 chừng ấy là 33px sai chỗ,
         * đủ thấy rõ khi chồng hai khung. easeInOutCubic còn xa hơn: 0.023 so với 0.063
         * đo được tại p=0.18. Đường thật KHÔNG đối xứng (lên chậm, xuống nhanh) nên không
         * hàm inOut một tham số nào tả được. */
        echoshift: (p) => curveAt(ECHO_ZOOM, clamp01(p)),
        wipeleft: easeInOutQuad, wiperight: easeInOutQuad,
        circleopen: easeInOutQuad, circleclose: easeInOutQuad, radial: easeInOutQuad,
        // 'swirl' tự nắn đường cong bên trong (swirlAmount) nên p phải giữ TUYẾN TÍNH ở đây,
        // nếu không ramp bị uốn hai lần và điểm cắt lệch khỏi p=0.5.
        swirl: (p) => p,
        // 'bokehswing' cũng vậy: ba đường cong của nó (đổi ảnh / mất nét / ánh sáng) ĐO
        // ĐƯỢC TỪ VIDEO MẪU và lệch pha nhau, không thể gộp thành một easing chung.
        bokehswing: (p) => p,
        /* Bốn mẫu đo từ video: mỗi LỚP đi theo bảng số đo riêng (phóng / xoay / trượt) và
         * hai lớp KHÔNG đối xứng nhau qua điểm đổi ảnh. Ép một easing chung lên p là uốn
         * cong hai lần — bảng số đo đã mang sẵn nhịp rồi. Giữ p TUYẾN TÍNH ở đây. */
        flashrotate: (p) => p,
        spinslam: (p) => p,
        stretchleft: (p) => p,
        zoomslide: (p) => p,
    };
    function easeProgress(id, p) {
        if (!SMOOTH.easing) return p;
        const fn = EASE_BY_ID[id] || easeInOutSine;
        return clamp01(fn(clamp01(p)));
    }

    // Blur bell-curve đỉnh (px @1080p) — ĐƯỜNG LÙI khi không lấy được mẫu con.
    // fade/dissolve/pixelize KHÔNG có chuyển động hình học nên = 0: pha trộn alpha vốn đã
    // liền mạch, thêm blur chỉ làm mất nét chứ không mượt thêm.
    // 'swirl' = 0: bản thân phép nắn ĐÃ kéo giãn pixel thành vệt xoáy (đó chính là "vệt" ta
    // thấy ở video mẫu, không phải motion blur), thêm blur nữa chỉ mất nét.
    // 'bokehswing' = 0 ở đây vì nó có ĐỘ MẤT NÉT RIÊNG (bokehDefocusPx) đo từ video mẫu —
    // đó là một phần DÁNG của hiệu ứng, không phải mẹo làm mượt, nên không đi qua SMOOTH.blur.
    // Bốn mẫu đo từ video đều = 0: chúng có CHUYỂN ĐỘNG HÌNH HỌC rõ ràng nên cửa trập
    // (motion blur thật, lấy mẫu con) làm đúng việc; blur bell-curve chỉ là đường lùi khi
    // không tính được cửa trập, mà ở đây motionSpanPx() luôn trả về quãng đường thật.
    const BLUR_PEAK = {
        fade: 0, dissolve: 0, pixelize: 0, swirl: 0, bokehswing: 0,
        flashrotate: 0, spinslam: 0, stretchleft: 0, zoomslide: 0,
        fadeblack: 9, fadewhite: 9,
        slideleft: 14, slideright: 14, slideup: 14, slidedown: 14,
        zoomin: 10,
        // 'echoshift' đội khung mạnh gấp 2.4 lần zoomin nên đường lùi cũng phải đậm hơn
        // đúng chừng ấy, nếu không đoạn giữa vùng lộ từng nấc khi không có cửa trập.
        echoshift: 24,
    };
    // Độ nhoè biên TỐI THIỂU (px @1080p) cho các hiệu ứng có đường biên chạy.
    const FEATHER_PX = {
        wipeleft: 28, wiperight: 28,
        circleopen: 24, circleclose: 24,
        radial: 20,
    };
    const FEATHER_MAX_GROW = 6;      // trần nới độ nhoè biên (lần so với mức tối thiểu)
    const SHUTTER_MAX_TAPS = 16;     // trần số mẫu con mỗi khung (chi phí vẽ tuyến tính theo số này)
    const SHUTTER_TAP_PX = 5;        // khe mong muốn giữa 2 mẫu con (px thật)
    const ZOOM_MAG = 1.25;           // "Phóng to": biên độ đội khung tại điểm giao
    /* ---- "Phóng chồng bóng" (echoshift) — dựng theo VIDEO MẪU người dùng đưa
     * ("Effect Demo/Transition/Transitions-Echo Shift.mp4"), đo bằng cách TRỪ NỀN với
     * "Transitions-No effect.mp4" trong cùng thư mục (cùng hai clip, cùng 227 khung, cùng
     * điểm cắt cứng 113|114) nên biết được ĐÚNG nội dung lớp A và lớp B ở từng khung.
     *
     * CÁI TÊN ĐÁNH LẠC HƯỚNG — ĐÃ LOẠI TRỪ TỪNG THỨ MỘT:
     *   · KHÔNG dịch chuyển: tương quan pha cho (0,0) ở mọi khung.
     *   · KHÔNG xoay: dò lưới −6°..+6° luôn cho đỉnh ở đúng 0°.
     *   · KHÔNG có vệt phóng (echo hình học): tỉ lệ năng lượng biên XUYÊN TÂM / TIẾP TUYẾN
     *     ở ba vành r=200..400, 500..700, 800..1050 nằm trong 0.92..1.09 ở MỌI khung —
     *     đúng bằng mức của bản không hiệu ứng. Có vệt phóng thì tỉ lệ này phải tụt hẳn ở
     *     vành ngoài (vệt dài ra theo bán kính).
     *   · KHÔNG có echo theo THỜI GIAN: khớp khung thành tổng các bản trễ k khung
     *     (nội dung base[n−k] ở tỉ lệ s(n−k), k=0..9) dồn TOÀN BỘ trọng số vào k=0.
     *   · KHÔNG đổi màu/tương phản riêng: khớp y = a + b·x cho ba kênh ra hệ số y hệt nhau.
     * Cái thấy được là BÓNG ĐÔI: hai lớp cùng đội khung nhưng lệch pha nhau rất xa, nên
     * suốt giữa vùng cảnh sau hiện lên như một cái bóng khổng lồ mờ đè trên cảnh trước.
     *
     * SỐ ĐO (vùng = khung 92..137, tức 46 khung = 1.53s, đối xứng quanh điểm cắt):
     *   · TỈ LỆ của từng lớp, khớp bằng từ điển tỉ lệ + bình phương tối thiểu KHÔNG ÂM:
     *       lớp A: 1.001 1.013 1.038 1.077 1.132 1.242 1.302  (p = 0 .. 0.49)
     *       lớp B: 1.298 1.183 1.099 1.052 1.029 1.004 1.000  (p = 0.49 .. 0.98)
     *     Hai lớp GẶP NHAU ở 1.30 ngay tại điểm cắt — đúng cấu trúc của "Phóng to". Quy
     *     ngược: biên độ đội khung = 1 + 2·(1.302 − 1) = 1.60.
     *   · ĐỔI ẢNH là một đường RIÊNG, không đi theo nhịp phóng: tỉ lệ lớp B trong ảnh
     *     (cũng từ phép khớp trên) qua 0.5 ở p≈0.38, trong khi nhịp phóng mới ở 0.29.
     *     Nhờ lệch pha đó mà lúc hai lớp ngang nhau, A đang ở 1.16 còn B ở 1.44 — chênh
     *     nhau hẳn một phần tư khung hình, và đó là cái "bóng" của mẫu. Cho ảnh đổi theo
     *     đúng nhịp phóng (như 'zoomin' đang làm) thì hai lớp luôn cùng cỡ lúc ngang nhau.
     *
     * CÁI NÀO MỚI THẬT SỰ TẠO RA KHÁC BIỆT — phép bóc tách, cộng dồn từng thay đổi rồi so
     * từng khung dựng ra với khung mẫu (tương quan trung bình trên 23 khung):
     *     'zoomin' nguyên bản                     0.763
     *     + biên độ 1.60                          0.920   (+0.157)
     *     + bảng nhịp đội khung đo được           0.947   (+0.027)
     *     + đổi ảnh tách khỏi nhịp phóng          0.960   (+0.013)
     * Tức BIÊN ĐỘ chiếm gần hết khoảng cách; hai tinh chỉnh sau chỉ thêm 0.04. Ghi lại để
     * đừng ai (kể cả người viết ra nó) tưởng phép tách đường đổi ảnh là thứ làm nên mẫu
     * này — nó là khác biệt CẤU TRÚC duy nhất so với zoomin (zoomin dùng thẳng p đã ease
     * làm alpha nên không diễn đạt được), nhưng về lượng thì nhỏ.
     * Đối chiếu sàn: 'zoomin' như đang có đạt 0.768 còn 'Mờ dần' 0.718 — tức cú phóng của
     * zoomin chỉ nhích hơn "không phóng gì" 0.05 trong việc dựng lại mẫu này.
     * ---------------------------------------------------------------------------- */
    const ECHO_MAG = 1.60;           // biên độ đội khung (hai lớp gặp nhau ở 1.30)
    /* Ảnh đổi xong ở p này (smoothstep [0, ECHO_MIX_END]) -> điểm giữa 0.385. Hai phép
       chọn độc lập cùng ra con số này: đo trực tiếp tỉ lệ hai lớp cho điểm giữa 0.38, và
       quét 0.68/0.72/0.77/0.84/0.92 rồi so từng khung dựng ra với KHUNG MẪU thì 0.77 cho
       tương quan cao nhất (0.959 so với 0.956/0.957 ở hai bên). */
    const ECHO_MIX_END = 0.77;
    /* NHỊP ĐỘI KHUNG, chuẩn hoá về [0,1] — ghép từ HAI phép đo độc lập vào cùng một đường:
     * nửa đầu lấy từ lớp A ((sA − 1)/0.6, đo được tới điểm cắt), nửa sau lấy từ lớp B
     * ((1.60 − sB)/0.6, đo được từ điểm cắt trở đi). Hai nửa nối nhau liền lạc tại p=0.489
     * (cùng cho 0.503) — đó vừa là phép kiểm chéo cho biên độ 1.60, vừa là bằng chứng hai
     * lớp đi trên CÙNG một nhịp chứ không phải hai đường riêng. */
    const ECHO_ZOOM = [
        [0, 0], [0.044, 0.010], [0.089, 0.022], [0.133, 0.040], [0.178, 0.063],
        [0.222, 0.090], [0.267, 0.128], [0.311, 0.168], [0.356, 0.220], [0.400, 0.307],
        [0.444, 0.403], [0.489, 0.503], [0.533, 0.605], [0.578, 0.695], [0.622, 0.768],
        [0.667, 0.835], [0.711, 0.873], [0.756, 0.913], [0.800, 0.927], [0.844, 0.952],
        [0.889, 0.977], [0.933, 0.993], [1, 1],
    ];
    const PIXELIZE_MAX_CELL = 48;    // "Vỡ hạt": cạnh ô lớn nhất ở giữa vùng (px @1080p)
    // Quy đổi px@1080p -> px thật của khung hiện tại.
    function unitPx(w, h) { return Math.min(w, h) / 1080; }
    // Bell curve: 0 ở 2 mép, 1 ở giữa (hơi bè ra để blur đến/đi dịu hơn).
    function bell(p) { return Math.pow(Math.sin(Math.PI * clamp01(p)), 0.75); }
    // Ramp nửa vùng: 0 -> 1 khi x đi 0 -> 1 (dùng cho fadeblack/fadewhite).
    function halfRamp(x) { return Math.sin((Math.PI / 2) * clamp01(x)); }
    function blurAmount(id, p, w, h) {
        const peak = BLUR_PEAK[id];
        if (!peak || !SMOOTH.blur || !SUPPORTS_FILTER) return 0;
        return peak * unitPx(w, h) * SMOOTH.blur * bell(p);
    }

    // ---- CỬA TRẬP: quãng đường ảnh/biên đi được khi tiến độ ĐÃ EASE đi từ p0 -> p1 ----
    // Chỉ cần con số XẤP XỈ (px thật) để quyết định lấy bao nhiêu mẫu con / nhoè biên bao nhiêu.
    function motionSpanPx(id, p0, p1, w, h) {
        const dp = Math.abs(p1 - p0);
        switch (id) {
            case 'slideleft': case 'slideright': return dp * w;
            case 'slideup': case 'slidedown': return dp * h;
            // Zoom: điểm xa tâm nhất (góc khung) dịch = Δscale * nửa đường chéo.
            case 'zoomin': return dp * (ZOOM_MAG - 1) * maxRadius(w, h);
            case 'echoshift': return dp * (ECHO_MAG - 1) * maxRadius(w, h);
            /* Bốn mẫu đo từ video: quãng đường tính THẲNG từ chính bảng số đo — lấy hiệu
             * giữa hai đầu khoảng rồi quy ra px. Không ước lượng bằng một hằng số biên độ
             * như zoomin/echoshift được, vì ba thành phần (phóng / xoay / trượt) mỗi cái
             * mạnh ở một quãng khác nhau: giữa vùng "Phóng trượt" gần như chỉ có trượt,
             * còn đầu vùng thì chỉ có phóng. */
            case 'flashrotate': case 'spinslam': case 'stretchleft': case 'zoomslide':
                return measuredSpanPx(id, p0, p1, w, h);
            default: return 0;
        }
    }
    function boundarySpanPx(id, p0, p1, w, h) {
        const dp = Math.abs(p1 - p0);
        switch (id) {
            case 'wipeleft': case 'wiperight': return dp * w;
            case 'circleopen': case 'circleclose': return dp * maxRadius(w, h);
            // Nan quạt quay trọn 1 vòng: lấy cung ở nửa bán kính làm đại diện.
            case 'radial': return dp * Math.PI * maxRadius(w, h);
            default: return 0;
        }
    }
    // Nửa độ mở cửa trập tại tiến độ raw, ĐƠN VỊ TIẾN ĐỘ TUYẾN TÍNH. Khép dần về 0 ở 2 mép
    // để khung đầu = A nguyên bản và khung cuối = B nguyên bản.
    function shutterHalf(raw, dpFrame) {
        if (!(dpFrame > 0) || !(SMOOTH.shutter > 0)) return 0;
        return Math.min((dpFrame / 2) * SMOOTH.shutter, raw, 1 - raw);
    }
    // Kế hoạch lấy mẫu con cho 1 khung: null = không cần (hiệu ứng không chuyển động,
    // hoặc quãng đường trong khung nhỏ hơn 1 khe mẫu -> vẽ thẳng vẫn liền mạch).
    function shutterPlan(id, raw, w, h, dpFrame) {
        const half = shutterHalf(raw, dpFrame);
        if (!(half > 1e-6)) return null;
        const lo = raw - half, hi = raw + half;
        const span = motionSpanPx(id, easeProgress(id, lo), easeProgress(id, hi), w, h);
        if (!(span > SHUTTER_TAP_PX)) return null;
        const n = Math.min(SHUTTER_MAX_TAPS, Math.max(2, Math.ceil(span / SHUTTER_TAP_PX) + 1));
        const gap = span / (n - 1);
        // Hết trần mẫu mà khe vẫn rộng -> tán nốt bằng blur đúng nửa khe.
        return { n, lo, hi, blur: gap > 1.2 ? gap * 0.5 : 0 };
    }
    // Độ nhoè biên: tối thiểu theo bảng, nới lên bằng quãng đường biên đi trong 1 khung
    // (chặn trần để biên không loang hết khung ở các hiệu ứng quét rất nhanh như nan quạt).
    function featherAmount(id, w, h, raw, dpFrame) {
        const base = FEATHER_PX[id];
        if (!base || !SMOOTH.feather) return 0;
        const min = base * unitPx(w, h) * SMOOTH.feather;
        const half = shutterHalf(raw, dpFrame);
        const span = half > 0
            ? boundarySpanPx(id, easeProgress(id, raw - half), easeProgress(id, raw + half), w, h)
            : 0;
        return Math.max(1, Math.min(min * FEATHER_MAX_GROW, Math.max(min, span)));
    }

    // ---- Compositor canvas 2D (WYSIWYG seed) ------------------------------------
    // compose(ctx, id, p, w, h, drawA, drawB): vẽ khung kết quả tại tiến độ p∈[0,1].
    //   drawA(g, w, h): vẽ lớp ĐANG RA (block A) lên context g.
    //   drawB(g, w, h): vẽ lớp ĐANG VÀO (block B) lên context g.
    // GĐ1 dùng cho thumbnail (drawA/drawB tô tile mẫu). GĐ3 sẽ truyền callback vẽ
    // frame video thật. Nhờ tách callback, công thức pha trộn là DUY NHẤT cho mọi
    // nơi -> không lệch giữa thumbnail, preview và (mục tiêu) export.
    // opts.fullFrame = true: 2 lớp A/B là khung ĐẦY & ĐỤC (lane chính, thumbnail) -> khi blur
    // phải "tràn viền" (overscan) để mép khung không bị nhoè thành viền tối. Với overlay
    // (lớp trong suốt, nhỏ hơn khung) thì KHÔNG overscan: blur ra ngoài mép item là đúng.
    // opts.duration / opts.fps: thời lượng vùng chuyển cảnh (giây) và fps của khung hình
    // đang dựng — hai số này quyết định ĐỘ MỞ CỬA TRẬP (xem mục "LÀM MƯỢT"). Thiếu thì rơi
    // về DUR_DEFAULT / SMOOTH.fps.
    function compose(ctx, id, pLinear, w, h, drawA, drawB, opts) {
        const raw = clamp01(pLinear);
        const fps = Number(opts && opts.fps) > 0 ? Number(opts.fps) : SMOOTH.fps;
        const dur = clampDuration(opts && opts.duration != null ? opts.duration : DUR_DEFAULT);
        const dpFrame = Math.min(1, 1 / Math.max(1e-6, dur * fps)); // tiến độ đi hết trong 1 khung
        const plan = shutterPlan(id, raw, w, h, dpFrame);
        ctx.save();
        ctx.clearRect(0, 0, w, h);
        if (!plan) {
            composeAt(ctx, id, raw, w, h, drawA, drawB, opts, dpFrame, true);
            ctx.restore();
            return;
        }
        // CỬA TRẬP: dựng n mẫu con rồi lấy trung bình ĐỀU. Vẽ mẫu k lên bộ tích luỹ với
        // alpha 1/(k+1) cho ra đúng trung bình cộng (acc = acc*k/(k+1) + mẫu/(k+1)).
        const acc = scratch(2, w, h);
        const tmp = scratch(3, w, h);
        if (!acc || !tmp) {
            composeAt(ctx, id, raw, w, h, drawA, drawB, opts, dpFrame, true);
            ctx.restore();
            return;
        }
        for (let k = 0; k < plan.n; k += 1) {
            const r = plan.lo + ((plan.hi - plan.lo) * k) / (plan.n - 1);
            tmp.g.setTransform(1, 0, 0, 1, 0, 0);
            tmp.g.globalAlpha = 1;
            tmp.g.globalCompositeOperation = 'source-over';
            if ('filter' in tmp.g) tmp.g.filter = 'none';
            tmp.g.clearRect(0, 0, w, h);
            composeAt(tmp.g, id, r, w, h, drawA, drawB, opts, dpFrame, false);
            acc.g.globalAlpha = 1 / (k + 1);
            acc.g.drawImage(tmp.canvas, 0, 0);
        }
        acc.g.globalAlpha = 1;
        drawBlurred(ctx, (g) => g.drawImage(acc.canvas, 0, 0), w, h, plan.blur, !!(opts && opts.fullFrame));
        ctx.restore();
    }

    // Dựng MỘT mẫu (một tiến độ raw duy nhất). `bellBlur = false` khi mẫu này là mẫu con
    // của cửa trập: motion blur đã do chính việc lấy mẫu tạo ra, thêm blur giả nữa là thừa.
    function composeAt(ctx, id, raw, w, h, drawA, drawB, opts, dpFrame, bellBlur) {
        const p = easeProgress(id, raw);       // tiến độ đã làm mượt (dùng cho mọi công thức vẽ)
        const full = !!(opts && opts.fullFrame);
        const bl = bellBlur ? blurAmount(id, raw, w, h) : 0;
        const ft = featherAmount(id, w, h, raw, dpFrame);
        const layerA = (g, blur) => drawBlurred(g, drawA, w, h, blur == null ? bl : blur, full);
        const layerB = (g, blur) => drawBlurred(g, drawB, w, h, blur == null ? bl : blur, full);
        ctx.save();
        switch (id) {
            case 'fade':
                layerA(ctx);
                ctx.globalAlpha = p;
                layerB(ctx);
                break;
            case 'dissolve': // hoà tan HẠT: B lộ ra theo mảng, không đều như fade
                layerA(ctx, 0);
                drawMasked(ctx, w, h, drawB, dissolveMask(p),
                    (g) => { g.globalAlpha = p; layerB(g, 0); });
                break;
            case 'pixelize': { // cả 2 lớp vỡ hạt to dần rồi mịn lại, crossfade ở giữa
                const cell = 1 + PIXELIZE_MAX_CELL * unitPx(w, h) * bell(raw);
                drawPixelated(ctx, drawA, w, h, cell);
                ctx.globalAlpha = p;
                drawPixelated(ctx, drawB, w, h, cell);
                break;
            }
            case 'fadeblack':
            case 'fadewhite': {
                const col = id === 'fadewhite' ? '#fff' : '#000';
                // Nửa đầu: A mờ về màu (blur tăng dần); nửa sau: B hiện ra từ màu (blur giảm dần).
                const peak = (BLUR_PEAK[id] || 0) * unitPx(w, h) * SMOOTH.blur;
                if (p < 0.5) {
                    layerA(ctx, SUPPORTS_FILTER ? peak * halfRamp(raw * 2) : 0);
                    ctx.globalAlpha = p * 2;
                    ctx.fillStyle = col; ctx.fillRect(0, 0, w, h);
                } else {
                    ctx.fillStyle = col; ctx.fillRect(0, 0, w, h);
                    ctx.globalAlpha = (p - 0.5) * 2;
                    layerB(ctx, SUPPORTS_FILTER ? peak * halfRamp((1 - raw) * 2) : 0);
                }
                break;
            }
            case 'slideleft':   // B đẩy vào từ phải, A trượt ra trái
                shifted(ctx, -p * w, 0, layerA);
                shifted(ctx, (1 - p) * w, 0, layerB);
                break;
            case 'slideright':  // B đẩy vào từ trái
                shifted(ctx, p * w, 0, layerA);
                shifted(ctx, (p - 1) * w, 0, layerB);
                break;
            case 'slideup':
                shifted(ctx, 0, -p * h, layerA);
                shifted(ctx, 0, (1 - p) * h, layerB);
                break;
            case 'slidedown':
                shifted(ctx, 0, p * h, layerA);
                shifted(ctx, 0, (p - 1) * h, layerB);
                break;
            case 'wipeleft':    // B lộ dần từ mép PHẢI sang trái (biên nhoè `ft`)
                layerA(ctx, 0);
                drawMasked(ctx, w, h, drawB, edgeMask('x', w, h, p, ft, false),
                    (g) => clipRect(g, (1 - p) * w, 0, p * w, h, drawB, w, h));
                break;
            case 'wiperight':   // B lộ dần từ mép TRÁI sang phải
                layerA(ctx, 0);
                drawMasked(ctx, w, h, drawB, edgeMask('x', w, h, p, ft, true),
                    (g) => clipRect(g, 0, 0, p * w, h, drawB, w, h));
                break;
            // "Phóng to": cú ĐỘI KHUNG liên tục qua điểm giao — A nở ra tới ZOOM_MAG rồi
            // B nhận tiếp ở đúng cỡ đó và lún về 1. Cả 2 lớp LUÔN ≥ 100% nên khung không
            // bao giờ hở nền (bản cũ cho B bắt đầu ở 40% -> lộ viền đen quanh B).
            // "Phóng chồng bóng" (echoshift) dùng CHUNG đường vẽ này: cùng cấu trúc hai
            // lớp đội khung ngược chiều, chỉ khác BIÊN ĐỘ và khác chỗ ảnh đổi theo một
            // đường RIÊNG thay vì theo nhịp phóng (xem ECHO_MAG / echoMix). Viết chung để
            // sửa dáng đội khung một lần là cả hai cùng theo — hai bản chép tay sẽ lệch.
            case 'zoomin':
            case 'echoshift': {
                const mag = id === 'echoshift' ? ECHO_MAG : ZOOM_MAG;
                const mix = id === 'echoshift' ? echoMix(raw) : p;
                scaled(ctx, w, h, 1 + (mag - 1) * p, (g) => layerA(g, 0));
                ctx.globalAlpha = mix;
                scaled(ctx, w, h, mag - (mag - 1) * p, (g) => layerB(g, 0));
                break;
            }
            case 'circleopen':  // B lộ qua vòng tròn mở rộng từ tâm (biên nhoè)
                layerA(ctx, 0);
                drawMasked(ctx, w, h, drawB, circleMask(w, h, p, ft),
                    (g) => clipCircle(g, w / 2, h / 2, p * maxRadius(w, h), drawB, w, h));
                break;
            case 'circleclose': // A co lại trong vòng tròn thu nhỏ, B lộ ra ngoài
                layerB(ctx, 0);
                drawMasked(ctx, w, h, drawA, circleMask(w, h, 1 - p, ft),
                    (g) => clipCircle(g, w / 2, h / 2, (1 - p) * maxRadius(w, h), drawA, w, h));
                break;
            case 'radial':      // B lộ theo nan quạt quay quanh tâm (biên nan nhoè)
                layerA(ctx, 0);
                drawWedgeFeathered(ctx, w, h, p, ft, drawB);
                break;
            // "Xoắn": A bị xoáy mạnh dần tới điểm cắt, rồi B xoáy ngược lại về bình thường.
            // CẮT THẲNG ở p=0.5 (không crossfade) — ở đỉnh xoáy ảnh không còn nhận ra nên
            // mắt không thấy điểm cắt, đúng như video mẫu.
            case 'swirl': {
                const amount = swirlAmount(raw);
                drawSwirled(ctx, raw < 0.5 ? drawA : drawB, w, h, amount, full);
                break;
            }
            // "Bokeh đung đưa": hạt sáng ấm trôi chéo + khung mất nét + đổi ảnh dưới lúc
            // sáng nhất. Ba đường cong lệch pha nhau, xem chú thích ở drawBokehSwing.
            case 'bokehswing':
                drawBokehSwing(ctx, raw, w, h, drawA, drawB, full);
                break;
            // Bốn mẫu ĐO TỪ VIDEO: cùng một đường vẽ (drawMeasured) vì cấu trúc giống
            // nhau — mỗi lúc CHỈ MỘT LỚP trên khung, đi theo bảng số đo của riêng nó, đổi
            // lớp tại một điểm cố định; khác nhau ở bảng số và ở lớp trang trí đi kèm
            // (chớp trắng / tách màu / lát gương / giao diện camera). Xem MEASURED bên dưới.
            case 'flashrotate':
            case 'spinslam':
            case 'stretchleft':
            case 'zoomslide':
                drawMeasured(ctx, id, raw, w, h, drawA, drawB, full);
                break;
            default:            // fallback: fade
                layerA(ctx);
                ctx.globalAlpha = p;
                layerB(ctx);
        }
        ctx.restore();
    }

    // ---- primitive helpers cho compose ----
    function maxRadius(w, h) { return Math.sqrt(w * w + h * h) / 2; }

    // Canvas nháp dùng lại (KHÔNG cấp phát mỗi frame) cho blur/mask. Mỗi index một vai trò
    // CỐ ĐỊNH để 2 chỗ đang dùng lồng nhau không giẫm lên nhau:
    //   0 = lớp ảnh (blur/mask) · 1 = mặt nạ nan quạt · 2 = bộ tích luỹ cửa trập
    //   3 = mẫu con cửa trập     · 4 = mặt nạ hạt (dissolve) · 5 = ảnh thu nhỏ (pixelize)
    //   6 = nguồn phép nắn xoắn  · 7 = đích phép nắn xoắn
    //   8 = ảnh nền của "Bokeh đung đưa"  · 9 = lớp hạt sáng của nó
    // Trả null nếu môi trường không tạo được canvas (Node test).
    const scratchPool = [];
    function scratch(index, w, h) {
        let c = scratchPool[index];
        if (!c) {
            if (typeof OffscreenCanvas === 'function') c = new OffscreenCanvas(w, h);
            else if (typeof document !== 'undefined') c = document.createElement('canvas');
            else return null;
            scratchPool[index] = c;
        }
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        const g = c.getContext('2d');
        if (!g) return null;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
        if ('filter' in g) g.filter = 'none';
        g.clearRect(0, 0, w, h);
        return { canvas: c, g };
    }
    // ctx.filter (blur) có trong Chromium/Electron; kiểm 1 lần để fallback an toàn.
    const SUPPORTS_FILTER = (function () {
        const s = scratch(0, 2, 2);
        return !!(s && 'filter' in s.g);
    })();

    // Vẽ 1 lớp có blur. blurPx <= ~0.25 -> vẽ trực tiếp (không tốn thêm 1 lần blit).
    // fullFrame: lớp là khung đầy & đục -> vẽ vào canvas nháp CÓ ĐỆM rồi KÉO GIÃN hàng/cột
    // pixel ngoài cùng ra vùng đệm (edge-clamp). Nhờ vậy nhân blur ở 4 mép có dữ liệu để lấy
    // -> mép khung không bị mờ/tối thành viền, và KHÔNG phải phóng ảnh (không lệch khung).
    // Lớp overlay (trong suốt) thì không đệm: blur toả ra ngoài mép item mới đúng.
    function drawBlurred(ctx, draw, w, h, blurPx, fullFrame) {
        if (!(blurPx > 0.25) || !SUPPORTS_FILTER) { draw(ctx, w, h); return; }
        const e = fullFrame ? Math.ceil(blurPx * 3) : 0; // 3*bán kính ~ hết tầm nhân blur
        const s = scratch(0, w + e * 2, h + e * 2);
        if (!s) { draw(ctx, w, h); return; }
        s.g.translate(e, e);
        draw(s.g, w, h);
        if (e > 0) {
            s.g.setTransform(1, 0, 0, 1, 0, 0);
            const W2 = w + e * 2;
            s.g.drawImage(s.canvas, e, e, 1, h, 0, e, e, h);                 // giãn cột trái
            s.g.drawImage(s.canvas, e + w - 1, e, 1, h, e + w, e, e, h);      // giãn cột phải
            s.g.drawImage(s.canvas, 0, e, W2, 1, 0, 0, W2, e);                // giãn hàng trên (kèm góc)
            s.g.drawImage(s.canvas, 0, e + h - 1, W2, 1, 0, e + h, W2, e);    // giãn hàng dưới (kèm góc)
        }
        ctx.save();
        ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
        ctx.drawImage(s.canvas, -e, -e);
        ctx.restore();
    }

    // Vẽ lớp qua MẶT NẠ có biên nhoè. paintMask(g,w,h) tô mặt nạ (alpha) lên toàn khung.
    // hardFallback(g): đường cắt biên cứng khi không có canvas nháp / feather = 0.
    function drawMasked(ctx, w, h, draw, paintMask, hardFallback) {
        const s = paintMask ? scratch(0, w, h) : null;
        if (!s) { hardFallback(ctx); return; }
        draw(s.g, w, h);
        s.g.globalCompositeOperation = 'destination-in';
        paintMask(s.g, w, h);
        ctx.drawImage(s.canvas, 0, 0);
    }

    // Mặt nạ biên thẳng chạy theo trục x (hoặc y). forward=true: lộ dần từ mép đầu.
    // Dịch biên ra ngoài nửa độ nhoè ở 2 đầu -> p=0 chưa lộ gì, p=1 lộ hết (không hở dải mờ).
    function edgeMask(axis, w, h, p, feather, forward) {
        if (!(feather > 0)) return null;
        const len = axis === 'x' ? w : h;
        const t = -feather / 2 + p * (len + feather);           // vị trí biên
        const edge = forward ? t : len - t;                     // lộ từ mép đầu / mép cuối
        const a = edge - feather / 2, b = edge + feather / 2;
        return function (g) {
            const grad = axis === 'x'
                ? g.createLinearGradient(a, 0, b, 0)
                : g.createLinearGradient(0, a, 0, b);
            grad.addColorStop(0, forward ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0)');
            grad.addColorStop(1, forward ? 'rgba(255,255,255,0)' : 'rgba(255,255,255,1)');
            g.fillStyle = grad; g.fillRect(0, 0, w, h);
        };
    }

    // ---- Hoà tan (dissolve): mặt nạ HẠT ngưỡng theo tiến độ ----------------------
    // Khác fade ở chỗ B không lộ ĐỀU mà lộ theo từng mảng: mỗi ô nhiễu có một ngưỡng
    // riêng, p vượt ngưỡng nào thì ô đó hiện. Trường nhiễu sinh bằng PRNG HẰNG SỐ (không
    // dùng Math.random) để preview và export ra đúng một kết quả — điều kiện WYSIWYG.
    // Mặt nạ vẽ ở độ phân giải thấp rồi phóng to có nội suy -> mép mảng mềm, không răng cưa.
    const DISSOLVE_GRID = 128;   // cạnh lưới nhiễu (ô)
    const DISSOLVE_SOFT = 0.35;  // bề rộng dải chuyển của mỗi ô (theo tiến độ)
    let dissolveField = null;
    let dissolveImage = null;
    function dissolveNoiseField() {
        if (dissolveField) return dissolveField;
        const n = DISSOLVE_GRID * DISSOLVE_GRID;
        const f = new Float32Array(n);
        let s = 0x9e3779b9 >>> 0;                 // hạt giống cố định (xorshift32)
        for (let i = 0; i < n; i += 1) {
            s ^= (s << 13); s >>>= 0;
            s ^= (s >>> 17);
            s ^= (s << 5); s >>>= 0;
            f[i] = s / 4294967296;
        }
        dissolveField = f;
        return f;
    }
    function dissolveMask(p) {
        return function (g, w, h) {
            const s = scratch(4, DISSOLVE_GRID, DISSOLVE_GRID);
            if (!s) { g.fillStyle = `rgba(255,255,255,${clamp01(p)})`; g.fillRect(0, 0, w, h); return; }
            const field = dissolveNoiseField();
            if (!dissolveImage || dissolveImage.width !== DISSOLVE_GRID) {
                dissolveImage = s.g.createImageData(DISSOLVE_GRID, DISSOLVE_GRID);
            }
            const data = dissolveImage.data;
            const t = clamp01(p) * (1 + DISSOLVE_SOFT); // p=0 -> chưa lộ ô nào; p=1 -> lộ hết
            for (let i = 0; i < field.length; i += 1) {
                const o = i * 4;
                data[o] = 255; data[o + 1] = 255; data[o + 2] = 255;
                data[o + 3] = Math.round(clamp01((t - field[i]) / DISSOLVE_SOFT) * 255);
            }
            s.g.putImageData(dissolveImage, 0, 0);
            g.imageSmoothingEnabled = true;
            if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
            g.drawImage(s.canvas, 0, 0, w, h);
        };
    }

    /* ---- Xoắn (swirl): NẮN ẢNH theo bán kính ------------------------------------
     * Dựng theo video mẫu người dùng đưa ("Be Xoan.mp4", 1080×1920 @30fps): ảnh bị XOÁY
     * quanh tâm, góc xoay LỚN NHẤT Ở TÂM và giảm dần về 0 ở mép (angle = turns·2π·(1−r/R)).
     * Nhờ vậy chuyển vị = r·angle đạt đỉnh ở nửa bán kính -> vùng giữa bị kéo thành vệt dài
     * nhất, đúng như mẫu. Ramp bung rất nhanh sát điểm cắt (SWIRL_RAMP_POW) nên gần như
     * không thấy gì rồi bùng lên; ở đỉnh ảnh không còn nhận ra được nên ĐIỂM CẮT ĐƯỢC CHE
     * HOÀN TOÀN — mẫu cũng cắt thẳng ở đỉnh, KHÔNG hoà mờ (nên ở đây cũng không crossfade).
     *
     * Đây là hiệu ứng DUY NHẤT phải nắn TỪNG PIXEL (canvas 2D không có shader). Tối ưu để
     * đủ nhanh cho cả preview và bake:
     *   - r của từng pixel KHÔNG đổi theo tiến độ -> tính MỘT LẦN cho mỗi kích thước khung
     *     (swirlCacheFor, cache theo w×h).
     *   - cos/sin của góc chỉ phụ thuộc r -> bảng tra 1024 nấc bán kính mỗi khung (1024 lần
     *     gọi trig, không đáng kể) thay vì 2 triệu lần.
     *   - KHÔNG lấy mẫu con cửa trập cho hiệu ứng này (motionSpanPx trả 0): phép nắn đã tạo
     *     vệt, thêm 16 lần nắn/khung là chậm gấp 16 lần mà không đẹp hơn.
     * Lấy mẫu song tuyến để vùng bị phóng không bị răng cưa. Ngoài khung: fullFrame thì KẸP
     * mép (không sinh viền đen ở góc khi ảnh xoáy ra ngoài), overlay thì trong suốt.
     * -------------------------------------------------------------------------- */
    // Ba hằng số dưới đây đã được DÓ THEO VIDEO MẪU (so từng khung, xem mục VERIFY trong
    // docs): vùng chuyển cảnh của mẫu dài ~16 khung @30fps, điểm cắt ở giữa.
    const SWIRL_TURNS = 0.8;       // số vòng xoáy ở TÂM tại đỉnh vùng chuyển cảnh
    const SWIRL_FALLOFF = 1.6;     // (1−r/R)^FALLOFF: >1 -> mép khung gần như KHÔNG xoáy,
                                   // xoáy dồn vào vùng giữa — đúng dáng mẫu
    const SWIRL_ZOOM = 0.10;       // đội khung ở đỉnh -> góc luôn có dữ liệu
    const SWIRL_RAMP_POW = 3;      // ramp: 1/4 đầu gần như phẳng rồi bung lên ở điểm cắt
    const SWIRL_BUCKETS = 1024;    // số nấc bán kính của bảng tra cos/sin

    // Cường độ xoáy theo tiến độ TUYẾN TÍNH: 0 ở 2 mép vùng, 1 tại điểm cắt (p=0.5).
    // Bằng 0 đúng ở 2 mép nên khung ĐẦU = A nguyên bản, khung CUỐI = B nguyên bản.
    function swirlAmount(raw) {
        return Math.pow(1 - Math.abs(2 * clamp01(raw) - 1), SWIRL_RAMP_POW);
    }

    // Cache theo TỪNG kích thước (không phải 1 ô duy nhất): thumbnail 120×68 ở panel và
    // preview 1080×1920 xen kẽ nhau liên tục, một ô sẽ bị tính lại 2 triệu căn bậc hai mỗi
    // lần đổi qua đổi lại. Giữ tối đa 3 kích thước là đủ (thumb + preview + bake).
    const SWIRL_CACHE_MAX = 3;
    const swirlFields = new Map();   // "w×h" -> { field, out }
    const swirlCos = new Float32Array(SWIRL_BUCKETS + 1);
    const swirlSin = new Float32Array(SWIRL_BUCKETS + 1);

    function swirlCacheFor(w, h, makeImageData) {
        const key = `${w}x${h}`;
        let hit = swirlFields.get(key);
        if (hit) return hit;
        const field = new Float32Array(w * h);
        const cx = (w - 1) / 2, cy = (h - 1) / 2;
        let i = 0;
        for (let y = 0; y < h; y += 1) {
            const dy = y - cy;
            for (let x = 0; x < w; x += 1, i += 1) {
                const dx = x - cx;
                field[i] = Math.sqrt(dx * dx + dy * dy);
            }
        }
        hit = { field, out: makeImageData() };
        if (swirlFields.size >= SWIRL_CACHE_MAX) swirlFields.delete(swirlFields.keys().next().value);
        swirlFields.set(key, hit);
        return hit;
    }

    function drawSwirled(ctx, draw, w, h, amount, full) {
        const turns = SWIRL_TURNS * clamp01(amount);
        // Gần 2 mép vùng thì góc xoáy ~0: vẽ thẳng, không tốn một lượt nắn 2 triệu pixel.
        if (!(turns > 0.002)) { draw(ctx, w, h); return; }
        const src = scratch(6, w, h);
        const dst = scratch(7, w, h);
        if (!src || !dst) { draw(ctx, w, h); return; }
        const zoom = 1 + SWIRL_ZOOM * clamp01(amount);
        src.g.save();
        src.g.translate(w / 2, h / 2); src.g.scale(zoom, zoom); src.g.translate(-w / 2, -h / 2);
        draw(src.g, w, h);
        src.g.restore();
        let sImg;
        try { sImg = src.g.getImageData(0, 0, w, h); } catch (_) { draw(ctx, w, h); return; }
        const cache = swirlCacheFor(w, h, () => dst.g.createImageData(w, h));
        const sPix = sImg.data;
        const dPix = cache.out.data;
        const cx = (w - 1) / 2, cy = (h - 1) / 2;
        const R = Math.sqrt(cx * cx + cy * cy) || 1;
        const twoPi = Math.PI * 2;
        for (let b = 0; b <= SWIRL_BUCKETS; b += 1) {
            const a = turns * twoPi * Math.pow(1 - b / SWIRL_BUCKETS, SWIRL_FALLOFF);
            swirlCos[b] = Math.cos(a);
            swirlSin[b] = Math.sin(a);
        }
        const field = cache.field;
        const kBucket = SWIRL_BUCKETS / R;
        const xMax = w - 1, yMax = h - 1;
        let i = 0;
        for (let y = 0; y < h; y += 1) {
            const dy = y - cy;
            for (let x = 0; x < w; x += 1, i += 1) {
                let b = (field[i] * kBucket) | 0;
                if (b > SWIRL_BUCKETS) b = SWIRL_BUCKETS;
                const ca = swirlCos[b], sa = swirlSin[b];
                const dx = x - cx;
                const sx = cx + dx * ca - dy * sa;
                const sy = cy + dx * sa + dy * ca;
                const o = i * 4;
                if (!full && (sx < -1 || sy < -1 || sx > xMax + 1 || sy > yMax + 1)) {
                    dPix[o] = 0; dPix[o + 1] = 0; dPix[o + 2] = 0; dPix[o + 3] = 0;
                    continue;
                }
                // Song tuyến + KẸP mép (mép kẹp cũng là cách tránh viền đen ở 4 góc).
                let x0 = Math.floor(sx), y0 = Math.floor(sy);
                const fx = sx - x0, fy = sy - y0;
                let x1 = x0 + 1, y1 = y0 + 1;
                if (x0 < 0) x0 = 0; else if (x0 > xMax) x0 = xMax;
                if (x1 < 0) x1 = 0; else if (x1 > xMax) x1 = xMax;
                if (y0 < 0) y0 = 0; else if (y0 > yMax) y0 = yMax;
                if (y1 < 0) y1 = 0; else if (y1 > yMax) y1 = yMax;
                const gx = 1 - fx, gy = 1 - fy;
                const w00 = gx * gy, w10 = fx * gy, w01 = gx * fy, w11 = fx * fy;
                const r0 = y0 * w, r1 = y1 * w;
                const p00 = (r0 + x0) * 4, p10 = (r0 + x1) * 4;
                const p01 = (r1 + x0) * 4, p11 = (r1 + x1) * 4;
                // Trải phẳng các kênh (vòng for lồng trong ở đây tốn ~1.5× thời gian).
                dPix[o] = sPix[p00] * w00 + sPix[p10] * w10 + sPix[p01] * w01 + sPix[p11] * w11;
                dPix[o + 1] = sPix[p00 + 1] * w00 + sPix[p10 + 1] * w10 + sPix[p01 + 1] * w01 + sPix[p11 + 1] * w11;
                dPix[o + 2] = sPix[p00 + 2] * w00 + sPix[p10 + 2] * w10 + sPix[p01 + 2] * w01 + sPix[p11 + 2] * w11;
                // fullFrame: lớp ĐỤC nên alpha luôn 255, khỏi nội suy thêm 1 kênh (~20% vòng lặp).
                dPix[o + 3] = full ? 255
                    : sPix[p00 + 3] * w00 + sPix[p10 + 3] * w10 + sPix[p01 + 3] * w01 + sPix[p11 + 3] * w11;
            }
        }
        dst.g.putImageData(cache.out, 0, 0);
        ctx.drawImage(dst.canvas, 0, 0);
    }

    /* ---- Bokeh đung đưa (bokehswing) -------------------------------------------
     * Dựng theo VIDEO MẪU người dùng đưa ("Effect Demo/Transition/Transitions-Bokeh
     * Swing.mp4", 1080×1920 @30fps) — đo bằng cách TRỪ NỀN với video "Transitions-No
     * effect.mp4" trong cùng thư mục: hai bản dài y hệt (227 khung) và CÙNG một điểm cắt
     * cứng (khung 113|114, chênh lệch giữa 2 khung liền kề vọt lên 99/255), nên bản "No
     * effect" cho biết ĐÚNG nội dung của lớp A và lớp B ở từng khung. Nhờ vậy mọi số dưới
     * đây là hiệu số THẬT chứ không phải ước lượng bằng mắt.
     *
     * SỐ ĐO
     *  · VÙNG: khung 87..141, tức 54 khung = 1.80s, ĐỐI XỨNG quanh điểm cắt 113.5.
     *  · KHÔNG có phép biến đổi hình học nào. Dò tương quan trên lưới xoay −8°..+8° và
     *    phóng 0.94..1.15 đều cho đỉnh ở ĐÚNG 0° / 1.0, tương quan pha cho dịch chuyển
     *    (0,0) ở mọi khung. Vậy "Swing" là chuyển động của CÁC HẠT SÁNG, không phải của
     *    khung hình — đây là chỗ dễ đoán sai nhất của mẫu này.
     *  · ĐỔI ẢNH A->B: khớp bình phương tối thiểu có loại điểm ngoại lai (bỏ 60% điểm
     *    sáng nhất vì hạt bokeh làm hỏng phép khớp) cho alpha của B theo p:
     *      0.11→0.03  0.26→0.11  0.33→0.23  0.37→0.57  0.41→0.70  0.44→0.76  0.52→0.88
     *    tức một đường S RẤT DỐC, và điểm giữa nằm ở p≈0.38 — SỚM HƠN điểm cắt (p=0.5)
     *    khoảng 7 khung. Ảnh đổi ngay lúc ánh sáng mạnh nhất nên mắt không bắt được.
     *  · MẤT NÉT (defocus): tỉ lệ năng lượng tần số cao so với bản gốc tụt còn 0.52 ở
     *    khung 108. Hiệu chuẩn bằng cách làm mờ chính khung gốc: tỉ lệ 0.52 ↔ σ≈2.1px.
     *    Cửa sổ mất nét HẸP HƠN cả vùng: 0 ở p≈0.10, đỉnh p≈0.41, hết ở p≈0.74.
     *  · ÁNH SÁNG: phần CỘNG ĐỀU (nền sáng lên) đạt +55..60/255 ở khung 106 (p≈0.37).
     *    Tỉ lệ kênh đo ở vùng chưa bão hoà: R:G:B = 1 : 0.72 : 0.28 -> amber #ffb03d.
     *    Ở đỉnh tỉ lệ ngả về trắng (1 : 0.98 : 0.71) — đó là BÃO HOÀ của phép cộng, nên
     *    ở đây chỉ cần một màu duy nhất, phép cộng tự làm trắng lên khi chồng nhiều lớp.
     *  · HẠT BOKEH: bán kính trung vị 10–16px, phân vị 90 khoảng 30–70px (px@1080). Số hạt
     *    dựng lên từ ~2 tới ~100 rồi rụng về ~5. Bám vết từng hạt qua 8–17 khung:
     *    v ≈ (−15, −6) px/khung (trôi sang TRÁI và HƠI LÊN), lệch khỏi đường thẳng 4–11px
     *    -> hạt vừa trôi vừa ĐUNG ĐƯA (chính là chữ "Swing"); bán kính co dần ~0.5px/khung.
     *    Quy sang TRỌN vùng: (−15×54, −6×54) ≈ (−810, −324) px@1080.
     *
     * CHỖ CỐ Ý LỆCH SỐ ĐO
     *  · Lớp hạt của mẫu là một CLIP BOKEH QUAY THẬT chồng lên. Ở đây hạt được VẼ BẰNG
     *    GRADIENT theo bảng hạt sinh từ PRNG HẠT GIỐNG CỐ ĐỊNH — vừa giữ quy ước "không
     *    dùng file ảnh" của engine (không phải tải thêm tài nguyên khi bake), vừa bảo đảm
     *    WYSIWYG (preview và export ra ĐÚNG một kết quả; Math.random thì không), vừa không
     *    chép lại tư liệu của người khác. Chỉ số đo được giữ: màu, cỡ, mật độ, hướng trôi,
     *    biên độ đung đưa, và nhịp của ba đường cong.
     *  · Mọi đường cong viết theo p (tiến độ trong vùng) chứ không theo khung: người dùng
     *    đặt thời lượng bao nhiêu thì hiệu ứng vẫn ĐÚNG DÁNG, chỉ nhanh/chậm đi.
     * -------------------------------------------------------------------------- */
    const BOKEH_MID = 0.38;        // p mà ảnh đã đổi được một nửa sang B
    const BOKEH_MID_HALF = 0.19;   // nửa bề rộng quãng đổi ảnh (0.19 -> 0.57)
    /* Cường độ ÁNH SÁNG theo p — BẢNG SỐ ĐO chứ không phải đường luỹ thừa, vì dáng thật
     * không phải hình chuông: bật lên tới ~0.18 rồi GIỮ NGUYÊN một quãng (p 0.09..0.15),
     * mới leo dần và BÙNG ở p≈0.34, sau đó rụng nhanh nhưng để lại một cái ĐUÔI THẤP kéo
     * dài (~0.12 suốt p 0.74..0.82) — không hàm trơn hai tham số nào tả được cả ba đoạn đó.
     * Đo bằng TRUNG VỊ của phần cộng thêm ở từng khung (trung vị = miễn nhiễm với các hạt
     * sáng), chuẩn hoá theo đỉnh 66/255 tại khung 106. */
    const BOKEH_ENV = [
        [0, 0], [0.037, 0.054], [0.074, 0.164], [0.111, 0.177], [0.148, 0.180],
        [0.185, 0.222], [0.222, 0.331], [0.259, 0.443], [0.296, 0.555], [0.333, 0.847],
        [0.370, 1.000], [0.407, 0.874], [0.444, 0.763], [0.481, 0.689], [0.519, 0.600],
        [0.556, 0.497], [0.593, 0.395], [0.630, 0.313], [0.667, 0.234], [0.704, 0.179],
        [0.741, 0.142], [0.778, 0.126], [0.815, 0.117], [0.852, 0.098], [0.889, 0.087],
        [0.926, 0.056], [0.963, 0.043], [1, 0],
    ];
    const BOKEH_BLUR_TOP_PX = 2.2; // độ mất nét ở đỉnh (px @1080)
    const BOKEH_BLUR_IN = 0.10;    // mốc bắt đầu / đỉnh / kết thúc của cửa sổ mất nét
    const BOKEH_BLUR_TOP = 0.41;
    const BOKEH_BLUR_OUT = 0.74;
    const BOKEH_BLUR_SHAPE = 1.4;  // uốn cong nhánh sine cho khớp số đo hai bên đỉnh
    /* MẬT ĐỘ HẠT theo p — đường RIÊNG, không dùng chung với BOKEH_ENV. Đo bằng tỉ lệ điểm
     * ảnh sáng hơn nền quầng 60/255 ở từng khung, chuẩn hoá theo đỉnh 13.8% tại p≈0.39.
     * Vì sao phải tách: ở p=0.07 quầng mới bằng 0.16 đỉnh nhưng đã có hạt sáng tới +170/255
     * (đo: p99.9 của phần cộng thêm). Tức hạt KHÔNG mờ đi lúc đầu vùng — chỉ THƯA hơn.
     * Nhân độ sáng hạt với đường quầng (bản đầu làm vậy) cho ra nửa đầu vùng gần như trống,
     * sai hẳn dáng mẫu. */
    const BOKEH_DENSITY = [
        [0, 0], [0.04, 0.10], [0.07, 0.28], [0.13, 0.30], [0.19, 0.28], [0.24, 0.55],
        [0.30, 0.63], [0.35, 0.73], [0.39, 1.00], [0.46, 0.72], [0.52, 0.60],
        [0.57, 0.44], [0.63, 0.29], [0.69, 0.25], [0.74, 0.14], [0.80, 0.09],
        [0.91, 0.09], [0.97, 0.02], [1, 0],
    ];
    const BOKEH_BLOOM_ALPHA = 0.27;// quầng sáng ĐỀU ở đỉnh (66/255 đo được)
    const BOKEH_RGB = [255, 176, 61];   // #ffb03d — tỉ lệ 1 : 0.69 : 0.24
    /* BÁN KÍNH HẠT — phân bố HAI NHÓM, không phải một. Số đo bắt buộc như vậy: đếm đốm ở
     * từng khung cho trung vị 10–16px và phân vị 90 khoảng 30–70px (px@1080), tức TOÀN HẠT
     * NHỎ; nhưng độ phủ sáng lại tới 13.8% khung = 286k điểm ảnh, mà cả trăm hạt nhỏ cộng
     * lại không ra nổi một phần tư chừng đó. Xem lại danh sách đốm thì thấy vài đốm r=115,
     * 142, 248, 309px — MỘT đốm r=250 đã chiếm 9.5% khung. Đó là các vệt nhoè cỡ lớn của
     * ống kính mở hết cỡ. Một phân bố đơn không tả được cả hai đầu: khớp trung vị thì thiếu
     * hẳn độ phủ, khớp độ phủ thì hạt to bằng nắm tay hết cả. */
    const BOKEH_COUNT = 360;       // số hạt trong bảng (tại đỉnh ~1/2 số này đang sống)
    const BOKEH_BIG_EVERY = 17;    // cứ mỗi 17 hạt thì MỘT hạt thuộc nhóm LỚN (~6%)
    const BOKEH_R_MIN = 5;         // nhóm NHỎ (px @1080): trung vị ~12, phân vị 90 ~34
    const BOKEH_R_MAX = 44;
    const BOKEH_R_SKEW = 2.4;
    const BOKEH_RBIG_MIN = 80;     // nhóm LỚN (px @1080)
    const BOKEH_RBIG_MAX = 260;
    const BOKEH_EDGE = 0.05;       // quãng tắt cứng ở 2 mép vùng (xem bokehField)
    const BOKEH_DRIFT_X = -810;    // quãng trôi cho TRỌN vùng (px @1080)
    const BOKEH_DRIFT_Y = -324;
    const BOKEH_SWAY_PX = 26;      // biên độ đung đưa lớn nhất (px @1080)
    const BOKEH_SHRINK = 0.35;     // hạt co lại bao nhiêu phần khi hết đời

    // Tỉ lệ lớp B trong ảnh nền. smootherstep trên quãng [MID−HALF, MID+HALF] nên
    // bokehMix(0) = 0 và bokehMix(1) = 1 TUYỆT ĐỐI — điều kiện "khung đầu = A, khung
    // cuối = B" của mẹo chồng 1 frame khi export.
    function bokehMix(p) {
        const q = clamp01((clamp01(p) - (BOKEH_MID - BOKEH_MID_HALF)) / (2 * BOKEH_MID_HALF));
        // clamp01 lần nữa: smootherstep tại q=1 ra 1.0000000000000013 (sai số dấu phẩy
        // động của đa thức), đủ để một phép so "≤ 1" ở nơi khác kêu sai.
        return clamp01(q * q * q * (q * (q * 6 - 15) + 10));
    }

    /* Tỉ lệ lớp B trong ảnh của "Phóng chồng bóng". Nhận p TUYẾN TÍNH (không phải p đã
     * ease): nhịp phóng và nhịp đổi ảnh là HAI đường khác nhau, đó là cả tính cách của
     * mẫu này (xem chú thích ECHO_MAG). smoothstep trên [0, ECHO_MIX_END] nên echoMix(0)
     * = 0 và echoMix(1) = 1 tuyệt đối — điều kiện "khung đầu = A, khung cuối = B". */
    function echoMix(raw) {
        const q = clamp01(clamp01(raw) / ECHO_MIX_END);
        return clamp01(q * q * (3 - 2 * q));
    }

    // Nội suy tuyến tính trên bảng [[x, y], …] đã sắp tăng dần theo x; ngoài khoảng thì kẹp.
    function curveAt(table, x) {
        if (x <= table[0][0]) return table[0][1];
        const last = table[table.length - 1];
        if (x >= last[0]) return last[1];
        for (let i = 1; i < table.length; i += 1) {
            const [x1, y1] = table[i];
            if (x <= x1) {
                const [x0, y0] = table[i - 1];
                const t = (x - x0) / (x1 - x0 || 1);
                return y0 + (y1 - y0) * t;
            }
        }
        return last[1];
    }

    // Cường độ ÁNH SÁNG tại p: 0 ở 2 mép (bắt buộc — xem BOKEH_ENV), 1 ở đỉnh p≈0.37.
    function bokehEnv(p) {
        const x = clamp01(p);
        if (x <= 0 || x >= 1) return 0;
        return curveAt(BOKEH_ENV, x);
    }

    // Độ mất nét (px THẬT) tại p. KHÔNG nhân SMOOTH.blur: đây là dáng của hiệu ứng, không
    // phải mẹo làm mượt — tắt smoothing không được làm hiệu ứng mất một nửa tính cách.
    function bokehDefocusPx(p, w, h) {
        const x = clamp01(p);
        let s = 0;
        if (x > BOKEH_BLUR_IN && x < BOKEH_BLUR_OUT) {
            s = x < BOKEH_BLUR_TOP
                ? Math.sin((Math.PI / 2) * (x - BOKEH_BLUR_IN) / (BOKEH_BLUR_TOP - BOKEH_BLUR_IN))
                : Math.sin((Math.PI / 2) * (BOKEH_BLUR_OUT - x) / (BOKEH_BLUR_OUT - BOKEH_BLUR_TOP));
        }
        return BOKEH_BLUR_TOP_PX * Math.pow(Math.max(0, s), BOKEH_BLUR_SHAPE) * unitPx(w, h);
    }

    /* Bảng hạt — sinh MỘT LẦN bằng xorshift32 hạt giống cố định (cùng lý do với trường
     * nhiễu của dissolve: Math.random thì preview và export ra hai kết quả khác nhau).
     * Vị trí lưu theo TỈ LỆ khung (x,y ∈ ~[−0.15, 1.2]) nên một bảng dùng chung cho mọi
     * độ phân giải; bán kính / quãng trôi / biên đung đưa lưu ở px@1080 rồi nhân unitPx. */
    let bokehParticles = null;
    function bokehField() {
        if (bokehParticles) return bokehParticles;
        let s = 0x1f123bb5 >>> 0;
        const rnd = () => {
            s ^= (s << 13); s >>>= 0;
            s ^= (s >>> 17);
            s ^= (s << 5); s >>>= 0;
            return s / 4294967296;
        };
        /* Thời điểm hạt SÁNG NHẤT được rút theo BOKEH_DENSITY bằng phép nghịch đảo hàm
           phân phối tích luỹ: nhờ vậy SỐ HẠT ĐANG SỐNG ở mỗi p tự bám đúng đường mật độ
           đo được, mà từng hạt vẫn sáng hết cỡ (không hạt nào bị làm mờ theo đường chung).
           Rải đều thời điểm rồi gác bằng ngưỡng cũng ra số hạt đúng, nhưng hạt sẽ TẮT PHỰT
           giữa đời khi ngưỡng đi qua nó. */
        const STEPS = 256;
        const cdf = new Float64Array(STEPS + 1);
        for (let i = 1; i <= STEPS; i += 1) {
            cdf[i] = cdf[i - 1] + curveAt(BOKEH_DENSITY, (i - 0.5) / STEPS);
        }
        const total = cdf[STEPS] || 1;
        const invCdf = (u) => {
            const t = u * total;
            let lo = 0; let hi = STEPS;
            while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < t) lo = m + 1; else hi = m; }
            return lo / STEPS;
        };
        const out = [];
        for (let i = 0; i < BOKEH_COUNT; i += 1) {
            const u = rnd();
            const x = -0.15 + rnd() * 1.35;   // sinh LẤN sang phải vì cả đàn trôi sang trái
            const y = -0.10 + rnd() * 1.25;
            const life = 0.18 + rnd() * 0.30;
            /* PHÂN TẦNG ĐỀU (u = (i+0.5)/N) thay vì rút ngẫu nhiên: số hạt đang sống mới
               bám SÁT đường mật độ. Rút ngẫu nhiên thì các hạt NHÓM LỚN — vốn chiếm gần
               hết độ phủ nhưng chỉ có hơn hai chục cái — dồn cục theo thời gian, có quãng
               ba bốn cái cùng lúc, có quãng chẳng cái nào; đo ra độ phủ nhấp nhô 2–3 lần
               so với mẫu ở cùng một p. Ngẫu nhiên vẫn giữ ở vị trí / cỡ / pha đung đưa. */
            const born = invCdf((i + 0.5) / BOKEH_COUNT) - life / 2;
            /* Nhóm LỚN cũng chọn theo BƯỚC ĐỀU trên chỉ số, không tung xúc xắc: chỉ số
               giờ CHÍNH LÀ thời gian (phân tầng ở trên), nên tung xúc xắc lại dồn cục y
               như cũ — chỉ khác là dồn cục một cách tất định. Hai chục hạt lớn rải đều thì
               độ phủ mới theo được đường mật độ. */
            const big = (i % BOKEH_BIG_EVERY) === 0;
            out.push({
                x, y, born, life, big,
                r: big
                    ? BOKEH_RBIG_MIN + (BOKEH_RBIG_MAX - BOKEH_RBIG_MIN) * u * u
                    : BOKEH_R_MIN + (BOKEH_R_MAX - BOKEH_R_MIN) * Math.pow(u, BOKEH_R_SKEW),
                vx: 0.55 + rnd() * 0.95,      // mỗi hạt trôi nhanh chậm khác nhau
                vy: 0.45 + rnd() * 1.10,
                sway: (0.35 + rnd() * 0.65) * BOKEH_SWAY_PX,
                cycles: 0.6 + rnd() * 1.0,
                phase: rnd() * Math.PI * 2,
                peak: 0.62 + rnd() * 0.38,
            });
        }
        bokehParticles = out;
        return out;
    }

    // Vẽ LỚP SÁNG (quầng đều + các hạt) lên g. Lớp này sẽ được CỘNG vào ảnh nền.
    function paintBokehGlow(g, p, w, h) {
        const env = bokehEnv(p);
        /* Cổng tắt ở 2 MÉP VÙNG. Thời điểm sáng nhất của hạt được rút trong [0,1] nhưng đời
           hạt trải ra hai phía, nên vẫn có hạt "thò" ra ngoài mép. Khung ĐẦU phải đúng bằng
           A và khung CUỐI đúng bằng B (điều kiện của mẹo chồng 1 frame khi export) nên phần
           thò đó bị tắt hẳn. Quãng tắt 0.05 nằm gọn trước mốc đo đầu tiên (p=0.07). */
        const edge = clamp01(Math.min(p, 1 - p) / BOKEH_EDGE);
        if (!(edge > 0.002)) return false;
        const R = BOKEH_RGB[0], G = BOKEH_RGB[1], B = BOKEH_RGB[2];
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = `rgba(${R},${G},${B},${(BOKEH_BLOOM_ALPHA * env * edge).toFixed(4)})`;
        g.fillRect(0, 0, w, h);
        const u = unitPx(w, h);
        // Pháp tuyến của vectơ trôi — hạt đung đưa VUÔNG GÓC với hướng nó đang đi.
        const nlen = Math.hypot(BOKEH_DRIFT_X, BOKEH_DRIFT_Y) || 1;
        const nx = -BOKEH_DRIFT_Y / nlen;
        const ny = BOKEH_DRIFT_X / nlen;
        g.globalCompositeOperation = 'lighter';
        bokehField().forEach((q) => {
            const t = (p - q.born) / q.life;
            if (t <= 0 || t >= 1) return;
            // Độ sáng hạt KHÔNG nhân `env`: mẫu cho thấy hạt sáng hết cỡ ngay từ đầu vùng,
            // chỉ thưa hơn — mật độ đã nằm trong cách rút thời điểm ở bokehField().
            const a = clamp01(q.peak * Math.sin(Math.PI * t) * edge);
            if (a < 0.004) return;
            const rad = q.r * u * (1 - BOKEH_SHRINK * t);
            if (!(rad > 0.5)) return;
            const travel = p - q.born;
            const sw = Math.sin(q.phase + Math.PI * 2 * q.cycles * t) * q.sway * u;
            const cx = q.x * w + BOKEH_DRIFT_X * q.vx * travel * u + nx * sw;
            const cy = q.y * h + BOKEH_DRIFT_Y * q.vy * travel * u + ny * sw;
            if (cx < -rad || cy < -rad || cx > w + rad || cy > h + rad) return;
            /* Đĩa bokeh THẬT sáng ở VÀNH hơn ở lõi (quang sai của ống kính mở lớn) rồi tắt
               nhanh ra ngoài — chính nét đó làm nó ra "bokeh" chứ không phải một chấm mờ. */
            const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
            grad.addColorStop(0, `rgba(${R},${G},${B},${(a * 0.70).toFixed(4)})`);
            grad.addColorStop(0.70, `rgba(${R},${G},${B},${(a * 0.84).toFixed(4)})`);
            grad.addColorStop(0.88, `rgba(${R},${G},${B},${a.toFixed(4)})`);
            grad.addColorStop(1, `rgba(${R},${G},${B},0)`);
            g.fillStyle = grad;
            g.beginPath();
            g.arc(cx, cy, rad, 0, Math.PI * 2);
            g.fill();
        });
        return true;
    }

    /* Dựng một khung "Bokeh đung đưa".
     * Thứ tự BẮT BUỘC: hoà A->B TRƯỚC rồi mới cộng ánh sáng — làm ngược lại thì quầng sáng
     * của nửa đầu bị lớp B vẽ đè lên và hiệu ứng mất sạch ở đúng lúc nó mạnh nhất.
     * Cả HAI lớp cùng một độ mất nét: chúng là cùng một "ống kính", lệch nhau là thấy rõ
     * ngay ở giữa vùng khi hai ảnh chồng nhau. */
    function drawBokehSwing(ctx, raw, w, h, drawA, drawB, full) {
        const mix = bokehMix(raw);
        const sig = SUPPORTS_FILTER ? bokehDefocusPx(raw, w, h) : 0;
        /* ĐƯỜNG TẮT HAI ĐẦU MÚT: không mờ, không sáng, không pha trộn -> vẽ THẲNG một lớp,
           bỏ qua canvas nháp. Không chỉ để nhanh: một vòng ghi/đọc qua canvas có alpha làm
           tròn giá trị nhân alpha, đo được lệch 1/255 — mà hợp đồng của engine là khung ĐẦU
           ĐÚNG BẰNG A và khung CUỐI ĐÚNG BẰNG B (mẹo chồng 1 frame khi export dựa vào đó). */
        if (!(sig > 0.25) && bokehEnv(raw) <= 0 && (mix <= 0 || mix >= 1)) {
            (mix >= 1 ? drawB : drawA)(ctx, w, h);
            return;
        }
        const base = scratch(8, w, h);
        const glow = scratch(9, w, h);
        if (!base || !glow) {   // môi trường không có canvas nháp -> ít nhất vẫn hoà hình
            drawBlurred(ctx, drawA, w, h, sig, full);
            ctx.globalAlpha = mix;
            drawBlurred(ctx, drawB, w, h, sig, full);
            return;
        }
        drawBlurred(base.g, drawA, w, h, sig, full);
        base.g.globalAlpha = mix;
        drawBlurred(base.g, drawB, w, h, sig, full);
        base.g.globalAlpha = 1;
        if (paintBokehGlow(glow.g, raw, w, h)) {
            /* Overlay (lớp TRONG SUỐT, nhỏ hơn khung): cắt lớp sáng theo đúng alpha của
               chính item, nếu không quầng sáng tràn ra kín khung và item bay mất trong một
               tấm màu cam. Lane chính (fullFrame) thì lớp đục kín khung nên khỏi cắt. */
            if (!full) {
                glow.g.globalCompositeOperation = 'destination-in';
                glow.g.drawImage(base.canvas, 0, 0);
            }
            base.g.globalCompositeOperation = 'lighter';
            base.g.drawImage(glow.canvas, 0, 0);
        }
        ctx.drawImage(base.canvas, 0, 0);
    }

    /* =========================================================================
     * BỐN MẪU ĐO TỪ VIDEO — "Chớp sáng xoay" / "Xoay đập" / "Kéo giãn trái" / "Phóng trượt"
     *
     * NGUỒN SỐ: bốn video mẫu trong "Effect Demo/Transition" (Flash & Rotate, Spin Slam,
     * Stretch Left, Zoom Slide), đo bằng ĐÚNG cách đã dùng cho "Bokeh đung đưa" và "Phóng
     * chồng bóng": TRỪ NỀN với "Transitions-No effect.mp4" trong cùng thư mục. Cả năm bản
     * dài y hệt (227 khung, 1080×1920 @30fps) và CÙNG một điểm cắt cứng (khung 113|114,
     * chênh lệch giữa 2 khung liền kề vọt lên 98/255), nên bản "No effect" cho biết ĐÚNG
     * nội dung lớp A và lớp B ở từng khung. Từng khung hiệu ứng được khớp bằng cách NẮN
     * khung gốc (phóng / xoay / trượt) rồi dò tham số cho tương quan cao nhất; độ sáng đo
     * riêng bằng TRUNG VỊ từng kênh (trung vị không bị các vùng cháy sáng kéo lệch).
     *
     * CẤU TRÚC CHUNG — vì sao bốn mẫu dùng chung một đường vẽ (drawMeasured):
     *   · Mỗi lúc trên khung chỉ có MỘT lớp (trừ "Phóng trượt", xem bên dưới), lớp đó đi
     *     theo BẢNG SỐ ĐO của riêng nó: cỡ phóng, góc xoay, quãng trượt — cả ba theo p.
     *   · ĐỔI ẢNH là một cú CẮT THẲNG tại `swap`, KHÔNG hoà mờ. Cả bốn mẫu đều vậy: dò
     *     trên video thấy khung trước và khung sau điểm đổi là hai ảnh nguyên vẹn, không
     *     có khung nào là hỗn hợp. Chỗ cắt được che bằng thứ khác (chớp trắng / vệt mờ
     *     chuyển động), đó mới là cái làm nên từng mẫu.
     *   · `swap` KHÔNG nằm giữa vùng. Vùng của các mẫu lệch hẳn về phía lớp A (mẫu lấy
     *     nhiều khung trước điểm cắt hơn sau), y như "Bokeh đung đưa" (0.38) và "Phóng
     *     chồng bóng" (0.385) — chỉ khác là bốn mẫu này lệch về phía BÊN KIA.
     *
     * HAI ĐẦU MÚT: mọi bảng đều bắt đầu ở p=0 với (cỡ 1, góc 0, trượt 0, không trang trí)
     * và kết thúc ở p=1 y như vậy, nên khung ĐẦU đúng bằng A và khung CUỐI đúng bằng B —
     * điều kiện của mẹo chồng 1 frame khi export.
     *
     * MỜ CHUYỂN ĐỘNG: cả bốn KHÔNG dùng blur bell-curve (BLUR_PEAK = 0). Chúng có chuyển
     * động hình học thật nên cửa trập của engine (lấy mẫu con, xem mục "LÀM MƯỢT") tự tạo
     * ra vệt mờ đúng bằng quãng đường ảnh đi trong một khung — đúng cái nhìn thấy ở mẫu.
     * measuredSpanPx() nói cho cửa trập biết quãng đường đó là bao nhiêu.
     * ========================================================================= */

    // Vùng của mỗi mẫu đo được (số khung @30fps) — chỉ để ghi lại, engine luôn quy về p.
    // Người dùng đặt thời lượng bao nhiêu thì hiệu ứng vẫn ĐÚNG DÁNG, chỉ nhanh/chậm đi.
    const MEASURED_SPAN_FRAMES = {
        flashrotate: 26, spinslam: 40, stretchleft: 44, zoomslide: 47,
    };

    /* ---- "Chớp sáng xoay" (flashrotate) — vùng = khung 98..123 (26 khung = 0.87s) ----
     * p = (khung − 98)/25; điểm cắt 113.5 rơi vào p = 0.62.
     *
     * BA ĐƯỜNG, LỆCH PHA NHAU — đó là cả tính cách của mẫu:
     *   1. PHÓNG: lớp A đội khung lên 1.50 rất nhanh (đỉnh ở p≈0.30, tức mới một phần ba
     *      vùng) rồi TỤT XUỐNG DƯỚI 1 — còn 0.76 ở điểm cắt. Tức là "hít vào rồi ném đi",
     *      không phải một cú phóng đều. Lớp B vào ở 1.375 và lún dần về 1.
     *   2. XOAY: KHÔNG có tí nào suốt 40% đầu vùng (dò lưới −6°..+6° cho đỉnh đúng ở 0° ở
     *      mọi khung tới p=0.40), rồi bung ra 34.6° trong 5 khung cuối trước điểm cắt. Lớp
     *      B nhận tiếp ở −26° và tở ngược về 0. Hai lớp CÙNG CHIỀU KIM ĐỒNG HỒ.
     *   3. CHỚP TRẮNG: đo bằng trung vị từng kênh -> tỉ lệ R:G:B = 1 : 1.01 : 1.05, tức
     *      TRẮNG TRUNG TÍNH (không ngả vàng/xanh). Đỉnh 0.50 ngay tại điểm cắt, tắt hẳn ở
     *      p=0.80. Phép khớp y = k·x + c cho c ≈ 255·(1−k) ở MỌI khung (sai < 0.02) —
     *      bằng chứng đây là một LỚP TRẮNG ĐÈ LÊN chứ không phải chỉnh sáng/tương phản.
     * Cú xoay và cú chớp cùng dồn vào 5 khung quanh điểm cắt: đó là lý do mắt không bắt
     * được chỗ cắt dù nó là một cú cắt thẳng. */
    const FLASH_A_SCALE = [
        [0, 1.000], [0.04, 1.010], [0.08, 1.022], [0.12, 1.047], [0.16, 1.088],
        [0.20, 1.153], [0.24, 1.262], [0.28, 1.490], [0.32, 1.495], [0.36, 1.478],
        [0.40, 1.437], [0.44, 1.377], [0.48, 1.285], [0.52, 1.148], [0.56, 0.955],
        [0.60, 0.763], [0.62, 0.690],
    ];
    const FLASH_A_ANGLE = [
        [0, 0], [0.40, 0], [0.44, 1.0], [0.48, 4.3], [0.52, 10.5], [0.56, 21.5],
        [0.60, 34.6], [0.62, 41.6],
    ];
    const FLASH_B_SCALE = [
        [0.62, 1.430], [0.64, 1.375], [0.68, 1.273], [0.72, 1.197], [0.76, 1.142],
        [0.80, 1.095], [0.84, 1.065], [0.88, 1.040], [0.92, 1.020], [0.96, 1.010], [1, 1.000],
    ];
    const FLASH_B_ANGLE = [
        [0.62, -31.5], [0.64, -26.0], [0.68, -15.5], [0.72, -8.8], [0.76, -4.7],
        [0.80, -2.0], [0.84, -0.5], [0.88, 0], [1, 0],
    ];
    const FLASH_WHITE = [
        [0, 0], [0.36, 0], [0.40, 0.02], [0.44, 0.15], [0.48, 0.26], [0.52, 0.39],
        [0.56, 0.50], [0.60, 0.49], [0.64, 0.41], [0.68, 0.29], [0.72, 0.17],
        [0.76, 0.05], [0.80, 0], [1, 0],
    ];

    /* ---- "Xoay đập" (spinslam) — vùng = khung 92..131 (40 khung = 1.33s) -------------
     * p = (khung − 92)/39; ảnh đổi giữa khung 112|113, tức p = 0.526.
     *
     * SỐ ĐO:
     *   · Lớp A: đội khung 1.00 -> 1.50 và xoay 0° -> 27° theo chiều kim đồng hồ, cả hai
     *     ĐỀU TĂNG TỐC (không phải ease đối xứng: nửa đầu đi được 16% quãng xoay, nửa sau
     *     84%). KHÔNG đổi độ sáng: trung vị ba kênh lệch dưới 0.05 ở mọi khung.
     *   · Lớp B vào ở 0.82 — NHỎ HƠN khung — nghiêng ngược −19°, rồi nở ra và tở về 0°
     *     trong 18 khung. Đó là cú "đập": B rơi xuống từ xa rồi ăn khớp vào khung.
     *   · NỀN ĐEN quanh B là CÓ THẬT, không phải lỗi: đo 4 góc khung ở khung 114..119 cho
     *     0..80/255 trong khi bản không hiệu ứng cho 167..173. Nên ở đây KHÔNG lấp mép
     *     (khác hẳn "Chớp sáng xoay").
     *   · TÁCH MÀU: dò dịch chuyển RIÊNG cho từng kênh cho ra kênh ĐỎ lệch sang TRÁI và
     *     kênh LAM lệch sang PHẢI đúng bằng nhau, kênh LỤC đứng yên, và CHỈ THEO PHƯƠNG
     *     NGANG (thành phần dọc đo được 0.0 ở mọi khung). Biên độ nửa: 5px ở khung 110,
     *     10px ở 111, 15px ở 112 (px@1080), rồi tắt trong 3 khung sau điểm cắt. Đã loại
     *     trừ giả thiết "quang sai theo bán kính": dò tỉ lệ phóng riêng từng kênh cho ra
     *     chênh lệch 0.000 — nếu là quang sai ống kính thì kênh ngoài phải phóng to hơn. */
    // Mốc p=0 đặt ĐÚNG 1.000 chứ không phải 1.003 như phép khớp trả về: 0.003 là sai số
    // của chính phép khớp (khung 92 của mẫu và của bản không hiệu ứng giống nhau tới
    // 0.999 tương quan), mà hợp đồng của engine là khung ĐẦU phải đúng bằng A.
    const SPIN_A_SCALE = [
        [0, 1.000], [0.051, 1.005], [0.103, 1.022], [0.154, 1.040], [0.205, 1.070],
        [0.256, 1.112], [0.308, 1.160], [0.359, 1.220], [0.410, 1.298], [0.462, 1.395],
        [0.513, 1.497], [0.526, 1.530],
    ];
    const SPIN_A_ANGLE = [
        [0, 0], [0.051, 0.3], [0.103, 0.8], [0.154, 1.7], [0.205, 3.0], [0.256, 4.5],
        [0.308, 6.8], [0.359, 9.8], [0.410, 14.0], [0.462, 19.7], [0.513, 27.0],
        [0.526, 29.0],
    ];
    const SPIN_B_SCALE = [
        [0.526, 0.800], [0.564, 0.822], [0.590, 0.890], [0.615, 0.895], [0.641, 0.932],
        [0.667, 0.940], [0.692, 0.950], [0.718, 0.950], [0.744, 0.962], [0.769, 0.968],
        [0.795, 0.975], [0.821, 0.980], [0.846, 0.985], [0.872, 0.987], [0.897, 0.992],
        [0.923, 0.993], [0.949, 0.998], [1, 1.000],
    ];
    const SPIN_B_ANGLE = [
        [0.526, -21.5], [0.564, -19.1], [0.590, -15.4], [0.615, -12.4], [0.641, -9.6],
        [0.667, -7.1], [0.692, -6.1], [0.718, -5.2], [0.744, -4.3], [0.769, -3.3],
        [0.795, -2.7], [0.821, -2.0], [0.846, -1.5], [0.872, -1.2], [0.897, -0.8],
        [0.923, -0.5], [0.949, -0.3], [1, 0],
    ];
    // Nửa biên độ tách màu (px @1080): đỏ lệch −d, lam lệch +d, lục đứng yên.
    const SPIN_SPLIT = [
        [0, 0], [0.410, 0], [0.462, 5], [0.487, 10], [0.513, 15], [0.526, 16],
        [0.590, 8], [0.615, 0], [1, 0],
    ];

    /* ---- "Kéo giãn trái" (stretchleft) — vùng = khung 92..135 (44 khung = 1.47s) -----
     * p = (khung − 92)/43; ảnh đổi giữa khung 114|115, tức p = 0.523. Đây là mẫu DUY NHẤT
     * trong bốn mẫu có vùng ĐỐI XỨNG quanh điểm cắt (21.5 khung mỗi bên).
     *
     * SỐ ĐO:
     *   · KHÔNG phóng, KHÔNG xoay, KHÔNG đổi sáng — dò lưới đều cho đỉnh ở 1.0 / 0° /
     *     trung vị lệch dưới 0.02. Chỉ có TRƯỢT NGANG.
     *   · Lớp A trượt sang TRÁI, tăng tốc rất mạnh: 0.03 bề ngang khung ở p=0.14, 0.12 ở
     *     p=0.28, 0.36 ở p=0.42, 0.74 ở p=0.49. Quãng đi trong MỘT khung ở cuối lớn gấp
     *     40 lần lúc đầu — chính chỗ đó sinh ra vệt nhoè ngang mà mắt gọi là "kéo giãn".
     *   · Lớp B vào từ bên PHẢI ở 0.29 bề ngang khung rồi dịu dần về 0 trong 20 khung.
     *     A bay đi rất xa còn B chỉ nhích vào — hai lớp KHÔNG đối xứng nhau.
     *   · LÁT GƯƠNG: phần khung bị bỏ trống khi lớp trượt đi KHÔNG phải nền đen mà là ảnh
     *     LẬT GƯƠNG của chính nó. So ba giả thiết lấp mép trên từng khung (kẹp mép / lật
     *     gương / cuộn vòng), lật gương thắng ở MỌI khung của vùng và cách biệt nới rộng
     *     dần (khung 111: 0.650 so với 0.480 và 0.534). Nhìn ở khung 111..113 thấy rõ hai
     *     bản người đối mặt nhau — đó là dấu của lật gương, cuộn vòng không tạo ra được.
     *
     * MỘT CHỖ PHẢI SUY RA, KHÔNG ĐO ĐƯỢC: quãng trượt của lớp A sau p≈0.49. Lát gương có
     * CHU KỲ đúng 2 bề ngang khung, nên dịch 1.48 và dịch −0.50 cho ra ẢNH Y HỆT NHAU —
     * phép khớp không thể phân biệt (nó thật sự trả về cả hai với cùng một điểm số). Lấy
     * theo đà tăng tốc đo được ở 5 khung trước đó thì tới điểm đổi ảnh là ≈ 1.00. */
    const STRETCH_A_TX = [
        [0, 0], [0.023, -0.004], [0.047, -0.005], [0.070, -0.009], [0.093, -0.015],
        [0.116, -0.020], [0.140, -0.029], [0.163, -0.036], [0.186, -0.049],
        [0.209, -0.061], [0.233, -0.080], [0.256, -0.099], [0.279, -0.120],
        [0.302, -0.145], [0.326, -0.175], [0.349, -0.211], [0.372, -0.248],
        [0.395, -0.291], [0.419, -0.355], [0.442, -0.443], [0.465, -0.583],
        [0.488, -0.744], [0.523, -1.000],
    ];
    const STRETCH_B_TX = [
        [0.523, 0.350], [0.535, 0.292], [0.558, 0.220], [0.581, 0.180], [0.605, 0.152],
        [0.628, 0.124], [0.651, 0.091], [0.674, 0.079], [0.698, 0.067], [0.721, 0.055],
        [0.744, 0.045], [0.767, 0.035], [0.791, 0.025], [0.814, 0.020], [0.837, 0.016],
        [0.860, 0.015], [0.884, 0.011], [0.907, 0.009], [0.930, 0.005], [0.953, 0.001],
        [1, 0],
    ];

    /* ---- "Phóng trượt" (zoomslide) — vùng = khung 85..131 (47 khung = 1.57s) ---------
     * p = (khung − 85)/46; ảnh đổi tại điểm cắt 113.5, tức p = 0.620.
     *
     * SỐ ĐO PHẦN HÌNH:
     *   · Lớp A đội khung rất mạnh: 1.00 -> 2.33, và KHÔNG phải đều — 60% quãng phóng dồn
     *     vào 8 khung (p 0.35..0.48), trước và sau đó gần như đứng yên. Kèm theo là một cú
     *     NGHIÊNG tới −14.5°: dò lưới góc ở khung 106 cho tương quan 0.990 ở −14.5° so với
     *     0.569 ở 0°, nên cú nghiêng là có thật chứ không phải nhiễu của phép khớp.
     *   · Rồi A TRƯỢT sang PHẢI (0.03 -> 0.60 bề ngang khung trong 4 khung) và cú nghiêng
     *     TỞ NGƯỢC về −3° trong cùng 4 khung đó. Tức "phóng vào, gạt đi".
     *   · Lớp B vào từ bên TRÁI ở cỡ 2.57, nghiêng NGƯỢC LẠI +18°, rồi vừa trượt về giữa
     *     vừa lún về cỡ 1 và tở về 0° trong 8 khung.
     *   · KHÔNG đổi độ sáng (trung vị ba kênh lệch dưới 0.05 ở mọi khung của phần hình).
     *
     * CHỖ ĐO KÉM TIN CẬY NHẤT CỦA CẢ BỐN MẪU — ghi lại để đừng ai tưởng nó chắc như phần
     * còn lại: ba khung 114..116 là lúc lớp A đang ra còn lớp B đang vào, HAI LỚP CÙNG
     * trên khung, lại đúng lúc vệt mờ chuyển động mạnh nhất. Khớp một lớp ở đó chỉ đạt
     * tương quan 0.50 / 0.74 / 0.79 (so với 0.97+ ở mọi khung khác). Đã thử giả thiết "hai
     * lớp đi liền nhau như một dải phim" và nó MÂU THUẪN với số đo: suy từ vị trí lớp B ở
     * khung 114 thì lớp A phải ở 1.73 bề ngang, nhưng suy từ khung 115 lại ra 1.27 — lớp A
     * không thể lùi lại. Nên ở đây engine vẫn vẽ MỘT lớp và lấp phần khung bỏ trống bằng
     * chính lớp đó nới ra (`cover`); phần bỏ trống lớn nhất chỉ 20% bề ngang ở đúng khung
     * 115, mà khung đó là khung nhoè nhất vùng. Riêng GÓC NGHIÊNG ở khung 114 (+14.2°) bị
     * BỎ vì nó là mẫu tương quan thấp nhất (0.503) và đi ngược chiều tở của cả đoạn; lấy
     * theo khung 115 (+18.0°, tương quan 0.743) cho cả hai khung.
     *
     * GIAO DIỆN CAMERA: mẫu này vẽ thêm một lớp đồ hoạ mô phỏng màn hình camera điện
     * thoại — khung lấy nét vàng ở giữa, vòng số zoom cong ở đáy khung, số bội zoom và
     * tiêu cự. Đây KHÔNG phải nội dung của hai clip: bản "No effect" ở cùng những khung đó
     * không có gì. Xem ZOOM_UI_* bên dưới. */
    const ZS_A_SCALE = [
        [0, 1.000], [0.043, 1.003], [0.087, 1.010], [0.130, 1.028], [0.174, 1.063],
        [0.217, 1.112], [0.261, 1.190], [0.304, 1.310], [0.348, 1.508], [0.391, 1.917],
        [0.435, 2.215], [0.478, 2.275], [0.500, 2.310], [0.522, 2.310], [0.543, 2.280],
        [0.565, 2.280], [0.587, 2.330], [0.609, 2.330], [0.630, 2.330], [0.641, 2.330],
    ];
    const ZS_A_ANGLE = [
        [0, 0], [0.087, -0.2], [0.130, -0.3], [0.174, -0.7], [0.217, -1.3],
        [0.261, -2.3], [0.304, -3.7], [0.348, -6.0], [0.391, -10.8], [0.435, -14.2],
        [0.478, -14.7], [0.500, -14.2], [0.522, -12.8], [0.543, -9.0], [0.565, -3.8],
        [0.587, -3.0], [0.609, -3.0], [0.630, -3.0], [0.641, -3.0],
    ];
    const ZS_A_TX = [
        [0, 0], [0.500, 0], [0.522, 0.025], [0.543, 0.100], [0.565, 0.275],
        [0.587, 0.475], [0.609, 0.600], [0.630, 0.800], [0.641, 0.870],
    ];
    const ZS_B_SCALE = [
        [0.641, 2.400], [0.652, 1.940], [0.674, 1.370], [0.696, 1.250],
        [0.717, 1.130], [0.739, 1.070], [0.761, 1.010], [0.783, 1.010], [0.848, 1.005],
        [1, 1.000],
    ];
    const ZS_B_ANGLE = [
        [0.641, 18.0], [0.652, 18.0], [0.674, 6.0], [0.696, 4.5], [0.717, 3.8],
        [0.739, 2.2], [0.761, 0.8], [0.783, 0], [1, 0],
    ];
    const ZS_B_TX = [
        [0.641, -0.700], [0.652, -0.675], [0.674, -0.225],
        [0.696, -0.075], [0.717, -0.025], [0.739, 0], [1, 0],
    ];

    /* SỐ BỘI ZOOM hiện trên vòng số, đọc THẲNG từ video mẫu ở từng khung (chữ đủ to để
     * đọc được bằng mắt, không cần đoán): 0.5 giữ suốt tới khung 93 rồi leo 0.6 0.7 0.9
     * 1 1.2 1.7 2.2 2.8 4.2 7.2 9.4 11.5 13.7 rồi chạm trần 15 ở khung 107 và GIỮ 15 tới
     * khung 110, sau đó 14.9 14.4 12 1.6 rồi về 0.5 từ khung 115 trở đi.
     * Lưu ý: con số này KHÔNG bằng cỡ phóng của ảnh (ảnh chỉ đội tới 2.33). Nó là con số
     * của một chiếc máy ảnh tưởng tượng — một phần của lớp đồ hoạ, không phải của hình. */
    const ZOOM_UI_VALUE = [
        [0, 0.5], [0.174, 0.5], [0.196, 0.6], [0.217, 0.7], [0.239, 0.9], [0.261, 1.0],
        [0.283, 1.2], [0.304, 1.7], [0.326, 2.2], [0.348, 2.8], [0.370, 4.2],
        [0.391, 7.2], [0.413, 9.4], [0.435, 11.5], [0.457, 13.7], [0.478, 15.0],
        [0.543, 15.0], [0.565, 14.9], [0.587, 14.4], [0.609, 12.0], [0.630, 1.6],
        [0.652, 0.5], [1, 0.5],
    ];
    /* Độ ĐẬM của lớp giao diện: hiện dần trong 4 khung đầu vùng và tan dần trong 4 khung
     * cuối. Mốc tan đo được: còn rõ tới khung 127, mờ dần 128..131, mất hẳn ở 132 — tức
     * lớp đồ hoạ SỐNG LÂU HƠN phần hình (phần hình đã yên từ khung 123). Vùng của mẫu này
     * vì vậy lấy theo lớp đồ hoạ chứ không theo phần hình. */
    const ZOOM_UI_FADE = [
        [0, 0], [0.043, 0.6], [0.087, 1], [0.913, 1], [0.957, 0.6], [1, 0],
    ];

    /* HÌNH HỌC CỦA VÒNG SỐ — đo trên khung 117 (nền tối nên vạch hiện rõ nhất), đơn vị
     * px@1080. Ba vạch chính đo được nằm ở (178,35), (340,135), (410,235) tính từ đỉnh
     * vòng; khớp đường tròn qua từng cặp cho bán kính 470 / 496 / 475 — trùng nhau trong
     * 3%, nên vạch nằm trên MỘT cung tròn bán kính ≈ 480, tâm ở dưới đáy khung.
     * Góc của các mốc: 0.5× ở 0°, 1× ở 22°, 2× ở 43°, 3× ở 60° — tức ≈ 22° MỖI LẦN GẤP
     * ĐÔI (thang lô-ga-rít). Kiểm chéo: 3× theo thang đó phải ở 22·log2(6) = 56.9°, đo
     * được ~60°. */
    const ZOOM_UI_ARC_TOP = 335;     // đỉnh cung cách ĐÁY khung bao nhiêu (px@1080)
    const ZOOM_UI_ARC_R = 480;       // bán kính cung
    const ZOOM_UI_DEG_PER_OCT = 22;  // góc mỗi lần số bội gấp đôi
    const ZOOM_UI_MINOR_DEG = 2.75;  // khoảng cách hai vạch nhỏ (8 vạch mỗi quãng tám)
    const ZOOM_UI_SWEEP_DEG = 78;    // chỉ vẽ phần cung còn nằm trong khung
    const ZOOM_UI_STOPS = [0.5, 1, 2, 3, 5, 10, 15];
    const ZOOM_UI_MM = { 0.5: '13 MM', 1: '24 MM', 2: '48 MM', 3: '77 MM' };
    // Màu đo được ở 10 điểm sáng nhất của con trỏ: (246..248, 204..208, 20..35) -> #f8ce16.
    const ZOOM_UI_AMBER = '248,206,22';
    const ZOOM_UI_FOCUS = 188;       // cạnh khung lấy nét (đo: x 446..633, y 866..1053)
    const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    /* Dưới cỡ này thì chữ không còn đọc được, chỉ còn là mấy vệt bẩn — bỏ hẳn. Gặp ở ô
     * minh hoạ trong panel "Chuyển tiếp" (canvas 120×68, tức unitPx ≈ 0.06 -> chữ 2.8px);
     * vòng vạch và khung lấy nét vẫn vẽ nên ô minh hoạ vẫn nhận ra được hiệu ứng. */
    const UI_TEXT_MIN_PX = 7;

    // Góc của một số bội trên vòng, tính từ mốc nhỏ nhất (0.5×).
    function zoomUiAngle(v) {
        return ZOOM_UI_DEG_PER_OCT * (Math.log(Math.max(0.01, v) / 0.5) / Math.LN2);
    }
    // Chuỗi hiện trên màn: mẫu bỏ số lẻ khi đã tròn (15× chứ không phải 15.0×).
    function zoomUiText(v) {
        const r = Math.round(v * 10) / 10;
        return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + '×';
    }

    /* Vẽ lớp GIAO DIỆN CAMERA của "Phóng trượt". Lớp này ĐỨNG YÊN so với khung hình (đo:
     * hộp bao của khung lấy nét giữ nguyên x 446..633 ở mọi khung) — nó không đi theo cú
     * phóng/trượt của ảnh, đó chính là thứ làm nó trông như giao diện máy ảnh chứ không
     * phải một vật trong cảnh. */
    function drawCameraUi(ctx, raw, w, h, full) {
        const fade = curveAt(ZOOM_UI_FADE, clamp01(raw));
        if (!(fade > 0.004)) return;
        const u = unitPx(w, h);
        const z = curveAt(ZOOM_UI_VALUE, clamp01(raw));
        const cx = w / 2;
        const top = h - ZOOM_UI_ARC_TOP * u;        // đỉnh cung
        const cy = top + ZOOM_UI_ARC_R * u;         // tâm cung (nằm dưới đáy khung)
        const R = ZOOM_UI_ARC_R * u;
        ctx.save();
        // Với overlay (lớp trong suốt) thì cắt lớp đồ hoạ theo đúng hình của item, nếu
        // không vòng số chạy ra ngoài item và trôi lơ lửng giữa khung.
        if (!full) ctx.globalCompositeOperation = 'source-atop';
        ctx.globalAlpha = fade;
        ctx.lineCap = 'butt';
        ctx.textAlign = 'center';

        // --- Khung lấy nét: ô vuông giữa khung, mỗi cạnh có một vạch ngắn hướng vào trong.
        const fs = ZOOM_UI_FOCUS * u;
        ctx.strokeStyle = `rgba(${ZOOM_UI_AMBER},0.95)`;
        ctx.lineWidth = Math.max(1, 3 * u);
        ctx.strokeRect(cx - fs / 2, h / 2 - fs / 2, fs, fs);
        const tick = fs * 0.12;
        ctx.beginPath();
        ctx.moveTo(cx, h / 2 - fs / 2); ctx.lineTo(cx, h / 2 - fs / 2 + tick);
        ctx.moveTo(cx, h / 2 + fs / 2); ctx.lineTo(cx, h / 2 + fs / 2 - tick);
        ctx.moveTo(cx - fs / 2, h / 2); ctx.lineTo(cx - fs / 2 + tick, h / 2);
        ctx.moveTo(cx + fs / 2, h / 2); ctx.lineTo(cx + fs / 2 - tick, h / 2);
        ctx.stroke();

        // --- Vòng số: xoay cả vòng sao cho số bội hiện tại nằm đúng dưới con trỏ.
        const spin = -zoomUiAngle(z);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((spin * Math.PI) / 180);
        const maxDeg = zoomUiAngle(ZOOM_UI_STOPS[ZOOM_UI_STOPS.length - 1]);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = Math.max(1, 3 * u);
        ctx.beginPath();
        for (let d = 0; d <= maxDeg + 1e-6; d += ZOOM_UI_MINOR_DEG) {
            if (Math.abs(d + spin) > ZOOM_UI_SWEEP_DEG) continue;   // đã ra ngoài khung
            const r = (d * Math.PI) / 180;
            const s = Math.sin(r), c = -Math.cos(r);
            ctx.moveTo(s * R, c * R);
            ctx.lineTo(s * (R - 16 * u), c * (R - 16 * u));
        }
        ctx.stroke();
        ZOOM_UI_STOPS.forEach((v) => {
            const d = zoomUiAngle(v);
            if (Math.abs(d + spin) > ZOOM_UI_SWEEP_DEG) return;
            const r = (d * Math.PI) / 180;
            const s = Math.sin(r), c = -Math.cos(r);
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = Math.max(1, 4 * u);
            ctx.beginPath();
            ctx.moveTo(s * R, c * R);
            ctx.lineTo(s * (R - 40 * u), c * (R - 40 * u));
            ctx.stroke();
            // Nhãn quay THEO vòng (mẫu cũng vậy: chữ "2", "3" nghiêng theo cung).
            ctx.save();
            ctx.translate(s * (R - 74 * u), c * (R - 74 * u));
            ctx.rotate(r);
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            ctx.font = `600 ${Math.round(34 * u)}px ${FONT_STACK}`;
            ctx.textBaseline = 'middle';
            if (34 * u >= UI_TEXT_MIN_PX) ctx.fillText(String(v), 0, 0);
            if (ZOOM_UI_MM[v] && 26 * u >= UI_TEXT_MIN_PX) {
                ctx.fillStyle = `rgba(${ZOOM_UI_AMBER},0.45)`;
                ctx.font = `600 ${Math.round(26 * u)}px ${FONT_STACK}`;
                ctx.fillText(ZOOM_UI_MM[v], 0, 38 * u);
            }
            ctx.restore();
        });
        ctx.restore();

        // --- Con trỏ + số bội + tiêu cự: ĐỨNG YÊN ở giữa, vòng số chạy dưới nó.
        ctx.fillStyle = `rgba(${ZOOM_UI_AMBER},1)`;
        ctx.beginPath();
        ctx.moveTo(cx - 5 * u, top - 20 * u);
        ctx.lineTo(cx + 5 * u, top - 20 * u);
        ctx.lineTo(cx + 3 * u, top - 4 * u);
        ctx.lineTo(cx - 3 * u, top - 4 * u);
        ctx.closePath();
        ctx.fill();
        ctx.textBaseline = 'alphabetic';
        ctx.font = `700 ${Math.round(44 * u)}px ${FONT_STACK}`;
        if (44 * u >= UI_TEXT_MIN_PX) ctx.fillText(zoomUiText(z), cx, top + 92 * u);
        const mm = ZOOM_UI_MM[Math.round(z * 10) / 10];
        if (mm && 30 * u >= UI_TEXT_MIN_PX) {
            ctx.fillStyle = `rgba(${ZOOM_UI_AMBER},0.75)`;
            ctx.font = `600 ${Math.round(30 * u)}px ${FONT_STACK}`;
            ctx.fillText(mm, cx, top + 130 * u);
        }
        ctx.restore();
    }

    /* Bảng tra của bốn mẫu. `swap` = p mà ảnh cắt thẳng từ A sang B; `cover` = lấp phần
     * khung bỏ trống bằng chính lớp đó nới ra; `mirror` = lấp bằng ảnh lật gương. */
    const MEASURED = {
        flashrotate: {
            swap: 0.62, cover: true, flash: FLASH_WHITE,
            a: { scale: FLASH_A_SCALE, angle: FLASH_A_ANGLE },
            b: { scale: FLASH_B_SCALE, angle: FLASH_B_ANGLE },
        },
        spinslam: {
            swap: 0.526, cover: true, split: SPIN_SPLIT,
            a: { scale: SPIN_A_SCALE, angle: SPIN_A_ANGLE },
            b: { scale: SPIN_B_SCALE, angle: SPIN_B_ANGLE },
        },
        stretchleft: {
            swap: 0.523, mirror: true,
            a: { tx: STRETCH_A_TX },
            b: { tx: STRETCH_B_TX },
        },
        zoomslide: {
            swap: 0.641, cover: true, ui: true, pair: [0.609, 0.652],
            a: { scale: ZS_A_SCALE, angle: ZS_A_ANGLE, tx: ZS_A_TX },
            b: { scale: ZS_B_SCALE, angle: ZS_B_ANGLE, tx: ZS_B_TX },
        },
    };

    // Tra bảng cho một lớp; bảng thiếu thì trả về giá trị "không làm gì".
    function layerStateOn(side, p) {
        return {
            scale: side.scale ? curveAt(side.scale, p) : 1,
            angle: side.angle ? curveAt(side.angle, p) : 0,
            tx: side.tx ? curveAt(side.tx, p) : 0,
            ty: side.ty ? curveAt(side.ty, p) : 0,
        };
    }

    // Quãng đường (px thật) ảnh đi được khi p chạy p0 -> p1 — cho CỬA TRẬP biết lấy bao
    // nhiêu mẫu con. Chỉ cần con số xấp xỉ nên cộng thẳng ba thành phần lại: trượt tính
    // theo bề khung, phóng và xoay tính ở điểm xa tâm nhất (góc khung).
    // Lấy lớp ở GIỮA khoảng: nếu khoảng vắt qua điểm đổi ảnh thì hai lớp là hai ảnh khác
    // nhau, hiệu số giữa chúng không còn là "quãng đường" của bất kỳ vật nào.
    function measuredSpanPx(id, p0, p1, w, h) {
        const m = MEASURED[id];
        if (!m) return 0;
        const side = (p0 + p1) / 2 < m.swap ? m.a : m.b;
        const s0 = layerStateOn(side, p0);
        const s1 = layerStateOn(side, p1);
        const R = maxRadius(w, h);
        return Math.abs(s1.tx - s0.tx) * w
            + Math.abs(s1.ty - s0.ty) * h
            + Math.abs(s1.scale - s0.scale) * R
            + Math.abs(((s1.angle - s0.angle) * Math.PI) / 180) * R;
    }

    // Một lượt vẽ lớp đã biến hình. Thứ tự phép biến đổi (trượt -> xoay -> phóng, tất cả
    // quanh TÂM KHUNG) khớp với thứ tự đã dùng khi đo, đổi thứ tự là lệch số.
    function xformPass(ctx, draw, w, h, scale, angle, tx, ty) {
        ctx.save();
        ctx.translate(w / 2 + tx * w, h / 2 + ty * h);
        if (angle) ctx.rotate((angle * Math.PI) / 180);
        if (scale !== 1) ctx.scale(scale, scale);
        ctx.translate(-w / 2, -h / 2);
        draw(ctx, w, h);
        ctx.restore();
    }

    // Cỡ phóng NHỎ NHẤT để một lớp đã nghiêng `angle` và dời (tx, ty) còn phủ kín khung.
    // Suy thẳng từ điều kiện "cả 4 góc khung, quay ngược về hệ của lớp, đều nằm trong lớp".
    // Phải tính cả phần DỜI: lớp B của "Phóng trượt" vừa nghiêng vừa lệch hẳn sang trái.
    function coverScale(angle, tx, ty, w, h) {
        const r = (angle * Math.PI) / 180;
        const ca = Math.cos(r), sa = Math.sin(r);
        let need = 1;
        for (let i = 0; i < 4; i += 1) {
            const x = (i & 1 ? 0.5 : -0.5) * w - tx * w;
            const y = (i & 2 ? 0.5 : -0.5) * h - ty * h;
            const u = x * ca + y * sa;
            const v = -x * sa + y * ca;
            need = Math.max(need, (2 * Math.abs(u)) / w, (2 * Math.abs(v)) / h);
        }
        return need;
    }

    const MIRROR_TILES_MAX = 4;   // trần số lát gương vẽ mỗi lượt (chi phí tuyến tính)

    /* Lát GƯƠNG theo phương ngang: lát chẵn là ảnh gốc, lát lẻ là ảnh lật. Chu kỳ đúng
     * 2 bề ngang khung. Chỉ vẽ những lát THỰC SỰ chạm vào khung (nhiều nhất 2–3 lát), nếu
     * không mỗi mẫu con của cửa trập phải vẽ lại cả chục lát. */
    function drawMirrorTiled(ctx, draw, w, h, tx) {
        const T = tx * w;
        const k0 = Math.floor(-tx) - 1;
        let drawn = 0;
        for (let k = k0; k <= k0 + 3 && drawn < MIRROR_TILES_MAX; k += 1) {
            const x = T + k * w;
            if (x >= w || x + w <= 0) continue;    // lát này không chạm khung
            ctx.save();
            if (((k % 2) + 2) % 2 === 0) ctx.translate(x, 0);
            else { ctx.translate(x + w, 0); ctx.scale(-1, 1); }
            draw(ctx, w, h);
            ctx.restore();
            drawn += 1;
        }
    }

    /* KẸP MÉP: vẽ lớp rồi KÉO GIÃN hàng/cột pixel ngoài cùng ra thêm (ex, ey) về mọi phía.
     * Dùng đúng mẹo của drawBlurred() ở trên, chỉ khác là ở đây phần nới ra để LẤP CHỖ HỞ
     * khi lớp co nhỏ / nghiêng / trượt, chứ không phải để nuôi nhân blur.
     * Vì sao không phóng to hẳn lớp lên rồi vẽ đè: làm thế sinh ra một ảnh THỨ HAI to đùng
     * nhìn thấy rõ sau lớp chính (đã dựng thử và thấy ngay ở "Xoay đập"); kẹp mép chỉ kéo
     * dài đúng những pixel ở rìa thành vệt, đó mới là cái video mẫu cho thấy. Chi phí cũng
     * rẻ hơn: một lượt vẽ lớp + 8 lượt kéo giãn, không cần canvas nháp cỡ lớn. */
    function drawClampExtended(ctx, draw, w, h, ex, ey) {
        const s = scratch(13, w, h);
        if (!s) { draw(ctx, w, h); return; }
        draw(s.g, w, h);
        const c = s.canvas;
        ctx.drawImage(c, 0, 0, 1, h, -ex, 0, ex, h);            // cột trái
        ctx.drawImage(c, w - 1, 0, 1, h, w, 0, ex, h);          // cột phải
        ctx.drawImage(c, 0, 0, w, 1, 0, -ey, w, ey);            // hàng trên
        ctx.drawImage(c, 0, h - 1, w, 1, 0, h, w, ey);          // hàng dưới
        ctx.drawImage(c, 0, 0, 1, 1, -ex, -ey, ex, ey);         // 4 góc
        ctx.drawImage(c, w - 1, 0, 1, 1, w, -ey, ex, ey);
        ctx.drawImage(c, 0, h - 1, 1, 1, -ex, h, ex, ey);
        ctx.drawImage(c, w - 1, h - 1, 1, 1, w, h, ex, ey);
        ctx.drawImage(c, 0, 0);
    }

    const CLAMP_MAX_GROW = 4;    // trần nới mép (lần bề khung) — chặn trường hợp lớp lệch
                                 // quá xa làm vệt kéo dài vô nghĩa

    // Vẽ một lớp theo trạng thái đo được.
    //   opts.mirror: lấp phần khung bỏ trống bằng ảnh LẬT GƯƠNG ("Kéo giãn trái").
    //   opts.cover : lấp bằng cách KẸP MÉP. Cần cho "Chớp sáng xoay" (lớp A co xuống 0.76
    //                và nghiêng 34.6° nên hở tới 47% khung), "Xoay đập" (lớp B vào ở 0.82)
    //                và "Phóng trượt" (lớp B lệch hẳn sang trái ở khung 115). Ba mẫu đó
    //                đều ĐO ĐƯỢC là có lấp: 4 góc khung ở vùng hở cho 80..145/255 chứ
    //                không phải 0; so ba giả thiết lấp mép trên từng khung của "Chớp sáng
    //                xoay" thì kẹp mép thắng cách biệt (0.643 so với 0.454 khi lấp trắng
    //                và 0.249 khi không cho lớp co nhỏ).
    //                Chỉ làm cho lane chính; lớp overlay vốn trong suốt nên để hở mới đúng.
    function drawXform(ctx, draw, w, h, st, full, opts) {
        if (opts && opts.mirror) { drawMirrorTiled(ctx, draw, w, h, st.tx); return; }
        let grow = 0;
        if (full && opts && opts.cover) {
            const need = coverScale(st.angle, st.tx, st.ty, w, h);
            grow = Math.min(CLAMP_MAX_GROW, need / Math.max(0.05, st.scale) - 1);
        }
        if (grow > 1e-3) {
            ctx.save();
            ctx.translate(w / 2 + st.tx * w, h / 2 + st.ty * h);
            if (st.angle) ctx.rotate((st.angle * Math.PI) / 180);
            if (st.scale !== 1) ctx.scale(st.scale, st.scale);
            ctx.translate(-w / 2, -h / 2);
            drawClampExtended(ctx, draw, w, h, (grow * w) / 2, (grow * h) / 2);
            ctx.restore();
            return;
        }
        xformPass(ctx, draw, w, h, st.scale, st.angle, st.tx, st.ty);
    }

    /* TÁCH MÀU: vẽ lớp ba lần, mỗi lần chỉ giữ một kênh, rồi CỘNG lại ở ba vị trí lệch
     * nhau. Canvas 2D không có bộ lọc tách kênh nên dùng 'multiply' với màu nguyên chất
     * (#f00 / #0f0 / #00f) để dập hai kênh kia; phép 'multiply' làm alpha đặc lại nên
     * phải trả alpha về bằng một lượt 'destination-in' với chính lớp gốc — nếu không,
     * lớp overlay (trong suốt) sẽ bị vuông thành một tấm đặc. */
    const SPLIT_CHANNEL_COLORS = ['#f00', '#0f0', '#00f'];
    function drawRgbSplit(ctx, paint, w, h, halfPx) {
        const src = scratch(10, w, h);
        const chan = scratch(11, w, h);
        const out = scratch(12, w, h);
        if (!src || !chan || !out) { paint(ctx); return; }
        paint(src.g);
        for (let i = 0; i < 3; i += 1) {
            chan.g.setTransform(1, 0, 0, 1, 0, 0);
            chan.g.globalCompositeOperation = 'source-over';
            chan.g.globalAlpha = 1;
            chan.g.clearRect(0, 0, w, h);
            chan.g.drawImage(src.canvas, 0, 0);
            chan.g.globalCompositeOperation = 'multiply';
            chan.g.fillStyle = SPLIT_CHANNEL_COLORS[i];
            chan.g.fillRect(0, 0, w, h);
            chan.g.globalCompositeOperation = 'destination-in';
            chan.g.drawImage(src.canvas, 0, 0);
            out.g.globalCompositeOperation = i === 0 ? 'source-over' : 'lighter';
            // i=0 đỏ lệch TRÁI, i=1 lục đứng yên, i=2 lam lệch PHẢI.
            out.g.drawImage(chan.canvas, (i - 1) * halfPx, 0);
        }
        // Cộng ba kênh cũng cộng cả alpha -> mép lớp overlay bị đặc lên gấp ba. Cắt lại
        // theo alpha của chính lớp gốc.
        out.g.globalCompositeOperation = 'destination-in';
        out.g.drawImage(src.canvas, 0, 0);
        ctx.drawImage(out.canvas, 0, 0);
    }

    // Dựng MỘT khung của bốn mẫu đo từ video.
    function drawMeasured(ctx, id, raw, w, h, drawA, drawB, full) {
        const m = MEASURED[id];
        if (!m) { drawA(ctx, w, h); return; }
        const toB = raw >= m.swap;
        const side = toB ? m.b : m.a;
        const draw = toB ? drawB : drawA;
        const st = layerStateOn(side, raw);
        /* CỬA SỔ HAI LỚP (chỉ "Phóng trượt"): đây là một cú TRƯỢT, nên có mấy khung mà lớp
         * A chưa ra hết còn lớp B đã vào một phần — đo được ở khung 114 của mẫu: độ sáng
         * trung bình 108 nằm giữa A (153) và B (74), tức khoảng 43% vẫn là A. Ba mẫu kia
         * KHÔNG có cửa sổ này (độ sáng ở khung đổi ảnh chỉ lệch 6% khỏi lớp mới), nên
         * chúng cắt thẳng. Trong cửa sổ: vẽ lớp NỀN (lớp kia) trước, rồi lớp chính đè lên
         * mà KHÔNG kẹp mép — có kẹp thì lớp chính phủ kín khung và lớp nền biến mất.
         * Bề rộng cửa sổ chọn bằng cách dựng lại cả vùng rồi so với video mẫu: [0.609,
         * 0.652] (3 khung) cho tương quan trung bình 0.947, nới ra [0.587, 0.674] (5 khung)
         * tụt còn 0.945, bỏ hẳn cửa sổ còn 0.939 — và riêng khung 114, khung nhoè nhất
         * vùng, đi từ 0.22 lên 0.50. */
        const pairing = m.pair && raw >= m.pair[0] && raw <= m.pair[1];
        const paint = (g) => {
            if (pairing) {
                const other = layerStateOn(toB ? m.a : m.b, raw);
                drawXform(g, toB ? drawA : drawB, w, h, other, full, m);
                drawXform(g, draw, w, h, st, full, null);
                return;
            }
            drawXform(g, draw, w, h, st, full, m);
        };
        const split = m.split ? curveAt(m.split, raw) * unitPx(w, h) : 0;
        if (split > 0.3) drawRgbSplit(ctx, paint, w, h, split);
        else paint(ctx);
        if (m.flash) {
            const a = curveAt(m.flash, raw);
            if (a > 0.002) {
                ctx.save();
                // 'source-atop': với lane chính (lớp đục kín khung) giống hệt vẽ đè bình
                // thường; với overlay thì chớp sáng chỉ ăn vào đúng hình của item, không
                // tràn ra kín khung.
                ctx.globalCompositeOperation = 'source-atop';
                ctx.globalAlpha = a;
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, w, h);
                ctx.restore();
            }
        }
        if (m.ui) drawCameraUi(ctx, raw, w, h, full);
    }

    // ---- Vỡ hạt (pixelize): thu nhỏ rồi phóng to KHÔNG nội suy ----------------------
    function drawPixelated(ctx, draw, w, h, cell) {
        if (!(cell > 1.2)) { draw(ctx, w, h); return; }
        const sw = Math.max(1, Math.round(w / cell));
        const sh = Math.max(1, Math.round(h / cell));
        const s = scratch(5, sw, sh);
        if (!s) { draw(ctx, w, h); return; }
        s.g.scale(sw / w, sh / h);
        draw(s.g, w, h);
        const prev = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(s.canvas, 0, 0, w, h);
        ctx.imageSmoothingEnabled = prev;
    }

    // Mặt nạ vòng tròn từ tâm với vành nhoè `feather` (p=0 -> rỗng, p=1 -> phủ hết).
    function circleMask(w, h, p, feather) {
        if (!(feather > 0)) return null;
        const R = maxRadius(w, h);
        const outer = clamp01(p) * (R + feather);
        if (!(outer > 0)) return function (g) { g.clearRect(0, 0, w, h); };
        const inner = Math.max(0, outer - feather);
        return function (g) {
            const grad = g.createRadialGradient(w / 2, h / 2, inner, w / 2, h / 2, Math.max(inner + 0.01, outer));
            grad.addColorStop(0, 'rgba(255,255,255,1)');
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = grad; g.fillRect(0, 0, w, h);
        };
    }

    // Nan quạt có biên nhoè: canvas không có conic-gradient nên làm mặt nạ hình quạt rồi
    // BLUR chính mặt nạ. Mặt nạ vẽ trên canvas có đệm (pad) và bán kính vượt khung để blur
    // không tạo viền mờ dọc 4 mép khung.
    function drawWedgeFeathered(ctx, w, h, p, feather, draw) {
        const cx = w / 2, cy = h / 2, R = maxRadius(w, h);
        if (!(feather > 0) || !SUPPORTS_FILTER) { clipWedge(ctx, cx, cy, R, p, draw, w, h); return; }
        const pad = Math.ceil(feather * 2);
        const layer = scratch(0, w, h);
        const mask = scratch(1, w + pad * 2, h + pad * 2);
        if (!layer || !mask) { clipWedge(ctx, cx, cy, R, p, draw, w, h); return; }
        draw(layer.g, w, h);
        mask.g.translate(pad, pad);
        mask.g.fillStyle = '#fff';
        mask.g.beginPath(); mask.g.moveTo(cx, cy);
        mask.g.arc(cx, cy, R * 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp01(p));
        mask.g.closePath(); mask.g.fill();
        layer.g.globalCompositeOperation = 'destination-in';
        layer.g.filter = `blur(${(feather / 2).toFixed(2)}px)`;
        layer.g.drawImage(mask.canvas, -pad, -pad);
        ctx.drawImage(layer.canvas, 0, 0);
    }

    function shifted(ctx, x, y, drawLayer) {
        ctx.save(); ctx.translate(x, y); drawLayer(ctx); ctx.restore();
    }
    function scaled(ctx, w, h, s, drawLayer) {
        ctx.save();
        ctx.translate(w / 2, h / 2); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2);
        drawLayer(ctx); ctx.restore();
    }
    function clipRect(ctx, x, y, cw, ch, draw, w, h) {
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, cw, ch); ctx.clip();
        draw(ctx, w, h); ctx.restore();
    }
    function clipCircle(ctx, cx, cy, r, draw, w, h) {
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2); ctx.clip();
        draw(ctx, w, h); ctx.restore();
    }
    function clipWedge(ctx, cx, cy, r, p, draw, w, h) {
        ctx.save(); ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p); ctx.closePath(); ctx.clip();
        draw(ctx, w, h); ctx.restore();
    }

    // ---- Placeholder tiles cho thumbnail (2 khối màu A/B có nhãn) ----
    function makeTilePainter(kind) {
        // kind: 'A' (đang ra) | 'B' (đang vào)
        const isA = kind === 'A';
        const c1 = isA ? '#3b82f6' : '#f59e0b';
        const c2 = isA ? '#1e3a8a' : '#b45309';
        return function (g, w, h) {
            const grad = g.createLinearGradient(0, 0, w, h);
            grad.addColorStop(0, c1); grad.addColorStop(1, c2);
            g.fillStyle = grad; g.fillRect(0, 0, w, h);
            g.fillStyle = 'rgba(255,255,255,0.92)';
            g.font = `700 ${Math.round(h * 0.42)}px system-ui, sans-serif`;
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(kind, w / 2, h / 2);
        };
    }
    const PAINT_A = makeTilePainter('A');
    const PAINT_B = makeTilePainter('B');

    // Vẽ 1 thumbnail chuyển cảnh vào <canvas> tại tiến độ p (mặc định 0.5 = giữa).
    function drawThumb(canvas, id, p) {
        if (!canvas || !canvas.getContext) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const w = canvas.width, h = canvas.height;
        // Tile mẫu là khung đầy & đục -> fullFrame để blur không ăn viền.
        compose(ctx, id, (typeof p === 'number' ? p : 0.5), w, h, PAINT_A, PAINT_B,
            { fullFrame: true, duration: DUR_DEFAULT });
    }

    // GHI CHÚ: Magic Fill KHÔNG còn tự điền chuyển cảnh (người dùng chốt bỏ 2026-08-03,
    // tự đặt tay). Lớp chính sách "nhóm vị trí -> bể hiệu ứng" (AUTO_POOLS / autoAssign) đã
    // được gỡ. Danh mục hiệu ứng (kể cả "Xoắn") vẫn nguyên để đặt thủ công qua tab Chuyển
    // tiếp. Muốn bật lại tự điền: dựng lại lớp chính sách + bắc cầu ở editing-runtime.js.

    return {
        DUR_DEFAULT, DUR_MIN, DUR_MAX,
        TRANSITION_CATEGORIES,
        TRANSITION_OPTIONS,
        optionById, labelFor, optionsByCategory, clampDuration, progressAt,
        compose, drawThumb,
        SMOOTH, setSmoothing,
        // Ba đường cong ĐO ĐƯỢC của "Bokeh đung đưa" + bảng hạt: xuất ra để test khoá số
        // đo mà không cần canvas (Node không có), và để gỡ lỗi khi ai đó chỉnh hằng số.
        bokehMix, bokehEnv, bokehDefocusPx, bokehField,
        /* "Phóng chồng bóng": nhịp ĐỘI KHUNG và nhịp ĐỔI ẢNH là hai đường khác nhau, xuất
           cả hai để test khoá được số đo mà không cần canvas, và để gỡ lỗi khi chỉnh. */
        echoMix, ECHO_MAG,
        echoZoomAt: (p) => curveAt(ECHO_ZOOM, clamp01(p)),
        /* BỐN MẪU ĐO TỪ VIDEO: xuất trạng thái từng lớp + mấy đường phụ để test khoá được
           số đo mà KHÔNG cần canvas (Node không có), và để gỡ lỗi khi ai đó chỉnh bảng.
           measuredAt(id, p) -> { layer: 'A'|'B', scale, angle, tx, ty } của lớp ĐANG hiện. */
        MEASURED_SPAN_FRAMES,
        measuredSwap: (id) => (MEASURED[id] ? MEASURED[id].swap : null),
        measuredAt(id, p) {
            const m = MEASURED[id];
            if (!m) return null;
            const raw = clamp01(p);
            const toB = raw >= m.swap;
            const st = layerStateOn(toB ? m.b : m.a, raw);
            st.layer = toB ? 'B' : 'A';
            return st;
        },
        measuredSpanPx, coverScale,
        flashWhiteAt: (p) => curveAt(FLASH_WHITE, clamp01(p)),
        spinSplitAt: (p) => curveAt(SPIN_SPLIT, clamp01(p)),
        zoomUiValueAt: (p) => curveAt(ZOOM_UI_VALUE, clamp01(p)),
        zoomUiFadeAt: (p) => curveAt(ZOOM_UI_FADE, clamp01(p)),
        zoomUiAngle, zoomUiText,
    };
});
