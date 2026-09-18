/* =============================================================================
 * RETOUCH ENGINE — làm đẹp khuôn mặt theo landmark (CrabbyCut)
 *
 * File RIÊNG và là NGUỒN SỰ THẬT DUY NHẤT cho cả preview lẫn export, đúng khuôn mà
 * color-adjust.js / transitions.js đang theo. Nguyên tắc WYSIWYG của dự án: công thức
 * viết MỘT LẦN ở đây rồi dùng lại ở shader preview và ở khâu bake khi xuất.
 *
 * DỮ LIỆU VÀO: landmark FaceMesh của MediaPipe — 478 điểm (468 + 10 mống mắt, do
 * `refine_landmarks=True`), CHUẨN HOÁ 0..1 theo khung hình, sinh bởi
 * `asr/auto_reframe_sidecar.py` chế độ `retouch_track`. Chuẩn hoá nên KHÔNG phụ thuộc
 * độ phân giải: cùng bộ điểm dùng được cho preview proxy 540px lẫn bản xuất 3072px.
 *
 * BA NHÓM PHÉP, BA KỸ THUẬT KHÁC HẲN NHAU — đừng gộp:
 *   1. BIẾN DẠNG HÌNH HỌC (Thon mặt, Đầy đặn): dịch UV theo điểm điều khiển lấy từ
 *      landmark. Là phép trên TOẠ ĐỘ, không phải trên màu.
 *   2. TÁCH TẦN SỐ trên mặt nạ da (Mịn da, Xoá khuyết điểm, Đều màu, Nếp nhăn):
 *      low = ảnh đã làm mờ mạnh, high = gốc − low; nén `high` TRONG mặt nạ. Đây là
 *      phép chuẩn của ngành, không phải "blur rồi trộn lại" — blur thẳng là mất hết
 *      chi tiết mắt/tóc và ra mặt nhựa.
 *   3. MÀU CỤC BỘ theo mặt nạ (Trắng da, Trắng răng, Sáng mắt, Quầng thâm, Tông da):
 *      dùng lại chính các phép của color-adjust.js, chỉ thêm mặt nạ vùng.
 *
 * Module THUẦN (không đụng DOM, không đụng state của app) -> chạy được trong Node cho
 * test. Việc lấy landmark và vẽ shader là của caller.
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.Retouch = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const LANDMARK_COUNT = 478;

    // ---------------------------------------------------------------------
    // 1. VÙNG TRÊN FACEMESH — chỉ số điểm theo bộ chuẩn của MediaPipe
    // ---------------------------------------------------------------------
    //
    // CÁC CHỈ SỐ NÀY LÀ HẰNG SỐ CỦA MEDIAPIPE, không phải do ta chọn. Chép sai một số
    // là mặt nạ lệch chỗ mà nhìn code không thấy gì sai -> test `retouch_regions`
    // KIỂM CHỨNG BẰNG HÌNH HỌC trên landmark THẬT (bao lồi của mắt phải nằm trong bao
    // lồi của mặt, miệng phải nằm dưới mắt, …) chứ không tin vào việc chép đúng.
    //
    // Thứ tự trong mảng là thứ tự ĐI VÒNG (polygon khép kín) — dùng để tô mặt nạ.
    const REGIONS = {
        // Đường viền mặt (silhouette) — mặt nạ DA gốc trừ đi mắt/miệng.
        faceOval: [
            10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
            379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
            234, 127, 162, 21, 54, 103, 67, 109,
        ],
        leftEye: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
        rightEye: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
        lipsOuter: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
        // Viền môi TRONG = khoang miệng -> mặt nạ cho "Trắng răng". Răng chỉ lộ ra
        // trong vùng này; dùng viền ngoài là làm trắng cả môi.
        lipsInner: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191],
        // Chân mày — LOẠI khỏi mặt nạ da: làm mịn/trắng lên lông mày là mất nét mày.
        leftBrow: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
        rightBrow: [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
    };

    /* VÙNG QUẦNG THÂM — không có sẵn thành một vòng trong bộ chỉ số MediaPipe, phải
     * DỰNG: dải giữa mí dưới (lower1) và vòng ngoài hốc mắt (lower3). Đi xuôi lower1
     * rồi đi NGƯỢC lower3 để ra polygon khép kín không tự cắt.
     * Test kiểm nó phải nằm DƯỚI mắt và TRONG viền mặt — dựng sai là đổ. */
    const EYE_LOWER = {
        left: {
            inner: [33, 7, 163, 144, 145, 153, 154, 155, 133],
            outer: [226, 31, 228, 229, 230, 231, 232, 233, 244],
        },
        right: {
            inner: [263, 249, 390, 373, 374, 380, 381, 382, 362],
            outer: [446, 261, 448, 449, 450, 451, 452, 453, 464],
        },
    };

    // Điểm mốc lẻ dùng cho hình học (không phải polygon).
    const POINTS = {
        chin: 152,          // đáy cằm
        forehead: 10,       // đỉnh trán (điểm trên cùng của faceOval)
        noseTip: 1,
        leftCheek: 234,     // mép trái khung mặt
        rightCheek: 454,    // mép phải khung mặt
        leftEyeOuter: 33,
        rightEyeOuter: 263,
        mouthLeft: 61,
        mouthRight: 291,
    };

    // ---------------------------------------------------------------------
    // 2. MÔ HÌNH THAM SỐ — khớp bảng tham chiếu (CapCut)
    // ---------------------------------------------------------------------
    //
    // `kind` quyết định phép nào xử lý tham số, để UI và bộ dựng shader không phải
    // đoán: 'warp' = biến dạng hình học, 'freq' = tách tần số, 'color' = màu cục bộ.
    // `range`: 'unit' = 0..100, 'signed' = -100..100.
    const PARAMS = [
        { key: 'plump', name: 'Đầy đặn', kind: 'warp', range: 'unit', region: 'cheek' },
        { key: 'even', name: 'Đều màu', kind: 'freq', range: 'unit', region: 'skin' },
        { key: 'clearBlemishes', name: 'Xoá khuyết điểm', kind: 'freq', range: 'unit', region: 'skin' },
        { key: 'sparkly', name: 'Da căng bóng', kind: 'freq', range: 'unit', region: 'skin' },
        { key: 'dewrinkle', name: 'Xoá nếp nhăn', kind: 'freq', range: 'unit', region: 'skin' },
        { key: 'facelift', name: 'Thon mặt', kind: 'warp', range: 'unit', region: 'jaw' },
        { key: 'smooth', name: 'Mịn da', kind: 'freq', range: 'unit', region: 'skin' },
        { key: 'smileLines', name: 'Nếp cười', kind: 'freq', range: 'unit', region: 'nasolabial' },
        { key: 'brightEye', name: 'Sáng mắt', kind: 'color', range: 'unit', region: 'eye' },
        { key: 'darkCircles', name: 'Quầng thâm', kind: 'color', range: 'unit', region: 'underEye' },
        { key: 'whitening', name: 'Trắng da', kind: 'color', range: 'unit', region: 'skin' },
        { key: 'whiteTeeth', name: 'Trắng răng', kind: 'color', range: 'unit', region: 'teeth' },
        { key: 'clear', name: 'Nét căng', kind: 'freq', range: 'unit', region: 'skin' },
    ];

    const PARAM_KEYS = PARAMS.map((p) => p.key);

    function defaultParams() {
        const out = {};
        PARAM_KEYS.forEach((k) => { out[k] = 0; });
        return out;
    }

    function defaultRetouch() {
        return {
            enabled: false,
            // 'single' = chỉ mặt lớn nhất; 'all' = mọi mặt nhận diện được.
            // Mặc định 'single' vì đa số video là một người nói trước máy, và áp cho
            // mọi mặt trong đám đông thường KHÔNG phải ý người dùng.
            target: 'single',
            params: defaultParams(),
            // Tông da mong muốn (hex) hoặc '' = không đổi tông.
            skinTone: '',
            skinToneAmount: 0,
        };
    }

    function num(value, fallback, lo, hi) {
        const v = Number(value);
        if (!Number.isFinite(v)) return fallback;
        return Math.max(lo, Math.min(hi, v));
    }

    function normalize(raw) {
        const def = defaultRetouch();
        if (!raw || typeof raw !== 'object') return def;
        def.enabled = !!raw.enabled;
        def.target = raw.target === 'all' ? 'all' : 'single';
        const p = raw.params || {};
        PARAMS.forEach((meta) => {
            const lo = meta.range === 'signed' ? -100 : 0;
            def.params[meta.key] = Math.round(num(p[meta.key], 0, lo, 100));
        });
        def.skinTone = /^#[0-9a-fA-F]{6}$/.test(String(raw.skinTone || '')) ? String(raw.skinTone) : '';
        def.skinToneAmount = Math.round(num(raw.skinToneAmount, 0, 0, 100));
        return def;
    }

    /* Không có gì để làm -> caller BỎ QUA hẳn khâu retouch (không dựng mặt nạ, không
     * chạy shader). Kiểm cả `enabled` lẫn "mọi tham số bằng 0": bật công tắc mà chưa
     * kéo gì thì cũng không nên tốn một lượt shader nào. */
    function isIdentity(raw) {
        const r = normalize(raw);
        if (!r.enabled) return true;
        if (PARAM_KEYS.some((k) => r.params[k] !== 0)) return false;
        return !(r.skinTone && r.skinToneAmount > 0);
    }

    // ---------------------------------------------------------------------
    // 2b. BỎ BỚT VIỆC KHÔNG AI ĐỌC — hai phép rút gọn CHÍNH XÁC
    // ---------------------------------------------------------------------
    //
    // Hai hàm dưới đây không phải "xấp xỉ cho nhanh": chúng nhận ra phần việc mà kết
    // quả KHÔNG hề đọc tới, nên bỏ đi cho ra ĐÚNG cùng một ảnh. Đây là chỗ rẻ nhất để
    // lấy lại tốc độ lúc phát — đo được raster mặt nạ 20.5 ms/khung ở lưới 256, mà
    // người dùng thường chỉ bật 1-2 nhóm.

    /* Mỗi mặt nạ chỉ phục vụ một nhóm tham số. Tham số bằng 0 -> số hạng đó bằng 0 dù
     * mặt nạ bằng bao nhiêu -> KHÔNG cần dựng mặt nạ ấy. */
    const MASK_USERS = {
        skin: ['even', 'clearBlemishes', 'sparkly', 'dewrinkle', 'smooth', 'clear', 'whitening'],
        eyes: ['brightEye'],
        teeth: ['whiteTeeth'],
        underEye: ['darkCircles'],
        nasolabial: ['smileLines'],
    };

    function requiredMasks(raw) {
        const r = normalize(raw);
        const out = {};
        Object.keys(MASK_USERS).forEach((name) => {
            out[name] = MASK_USERS[name].some((k) => r.params[k] > 0);
        });
        if (r.skinTone && r.skinToneAmount > 0) out.skin = true;
        return out;
    }

    /* TẦNG MỜ THÔ CÓ TRIỆT TIÊU KHÔNG?
     *
     * Kết quả của applyFreqOps là `base + mid + hi` với base = lc, mid = lf − lc.
     * Nếu KHÔNG tham số nào động vào `base` hay `mid` thì:
     *      out = lc + (lf − lc) + hi = lf + hi
     * tức `lc` biến mất hoàn toàn khỏi công thức. Khi đó truyền lc := lf cho ra ĐÚNG
     * cùng một số (base = lf, mid = 0, out = lf + hi) mà bỏ được lượt làm mờ BÁN KÍNH
     * LỚN — lượt đắt nhất trong hai lượt (đo: thô 4.07 ms so với mịn 1.4 ms ở lưới 256).
     * Chỉ 4 tham số dưới đây động tới base/mid, xem applyFreqOps.
     */
    const COARSE_USERS = ['even', 'sparkly', 'dewrinkle', 'smileLines'];

    function needsCoarse(raw) {
        const r = normalize(raw);
        return COARSE_USERS.some((k) => r.params[k] > 0);
    }

    // ---------------------------------------------------------------------
    // 3. HÌNH HỌC TỪ LANDMARK
    // ---------------------------------------------------------------------

    function pointAt(face, index) {
        const p = face && face[index];
        return p ? { x: p[0], y: p[1] } : null;
    }

    /* Polygon của một vùng, theo thứ tự đi vòng. Trả [] nếu thiếu điểm — thiếu điểm
     * nghĩa là landmark hỏng, và tô một polygon khuyết còn tệ hơn không tô. */
    function regionPolygon(face, regionKey) {
        const idx = REGIONS[regionKey];
        if (!idx || !face) return [];
        const out = [];
        for (const i of idx) {
            const p = pointAt(face, i);
            if (!p) return [];
            out.push(p);
        }
        return out;
    }

    /* Hộp bao khuôn mặt (chuẩn hoá 0..1), nới thêm `pad` theo TỈ LỆ CẠNH HỘP.
     *
     * DÙNG ĐỂ LÀM GÌ: (a) chọn mặt lớn nhất khi target='single'; (b) khi XUẤT, chỉ
     * bake lại VÙNG NÀY thay vì cả khung — retouch không đụng tới đâu khác, nên bake
     * cả khung là phí ~20-25 lần dữ liệu. Xem kế hoạch export.
     */
    function faceBounds(face, pad = 0.12) {
        if (!face || !face.length) return null;
        let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
        for (const p of face) {
            if (p[0] < x0) x0 = p[0];
            if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1];
            if (p[1] > y1) y1 = p[1];
        }
        const w = x1 - x0, h = y1 - y0;
        if (!(w > 0 && h > 0)) return null;
        return {
            x0: Math.max(0, x0 - w * pad),
            y0: Math.max(0, y0 - h * pad),
            x1: Math.min(1, x1 + w * pad),
            y1: Math.min(1, y1 + h * pad),
            width: 0, height: 0,   // điền ở dưới
        };
    }

    function boundsWithSize(face, pad) {
        const b = faceBounds(face, pad);
        if (!b) return null;
        b.width = b.x1 - b.x0;
        b.height = b.y1 - b.y0;
        return b;
    }

    /* VÙNG MÀ RETOUCH CÓ THỂ CHẠM TỚI, toạ độ khung chuẩn hoá 0..1.
     *
     * DÙNG ĐỂ LÀM GÌ: khâu XUẤT chỉ bake lại đúng vùng này rồi vá đè lên khung (đo được:
     * 6.7% diện tích khung, rẻ hơn bake cả khung 10 lần). Cắt HỤT là mất hiệu ứng ở rìa
     * và lộ đường ghép, nên hàm này phải bao PHỦ CHẮC CHẮN mọi pixel bị đổi.
     *
     * KHÔNG PHẢI chỉ là hộp bao mặt nạ. Biến dạng hình học (Thon mặt / Đầy đặn) dịch
     * pixel trong bán kính ảnh hưởng của từng điểm điều khiển, mà bán kính đó (0.50 /
     * 0.44 lần cỡ mặt) vươn RA NGOÀI hộp mặt nạ. Lấy hộp mặt nạ không thôi là cắt cụt
     * đúng chỗ mép hàm — chỗ dễ thấy nhất.
     * Bán kính đo trong không gian chuẩn hoá theo CHIỀU CAO nên quy về trục x phải CHIA
     * cho aspect (cùng quy ước với displaceUv).
     */
    function touchedBounds(faces, rawParams, aspect = 1) {
        const list = Array.isArray(faces) ? faces.filter(Boolean) : [];
        const a = Number(aspect) > 0 ? Number(aspect) : 1;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const grow = (ax0, ay0, ax1, ay1) => {
            if (ax0 < x0) x0 = ax0;
            if (ay0 < y0) y0 = ay0;
            if (ax1 > x1) x1 = ax1;
            if (ay1 > y1) y1 = ay1;
        };
        list.forEach((f) => {
            const b = boundsWithSize(f, MASK_BOUNDS_PAD);
            if (b) grow(b.x0, b.y0, b.x1, b.y1);
            warpControlPoints(f, rawParams, a).forEach((c) => {
                const rx = c.radius / a;
                grow(c.x - rx, c.y - c.radius, c.x + rx, c.y + c.radius);
            });
        });
        if (!(x1 > x0 && y1 > y0)) return null;
        return {
            x0: Math.max(0, x0), y0: Math.max(0, y0),
            x1: Math.min(1, x1), y1: Math.min(1, y1),
            width: Math.min(1, x1) - Math.max(0, x0),
            height: Math.min(1, y1) - Math.max(0, y0),
        };
    }

    /* Chọn mặt để áp theo `target`. 'single' -> mặt có hộp bao LỚN NHẤT (người nói
     * chính, gần máy nhất), KHÔNG phải mặt đầu tiên: thứ tự MediaPipe trả về không
     * ổn định giữa các frame, lấy phần tử [0] là mặt nhảy qua lại giữa 2 người. */
    function selectFaces(faces, target) {
        if (!Array.isArray(faces) || !faces.length) return [];
        if (target === 'all') return faces;
        let best = null, bestArea = -1;
        for (const f of faces) {
            const b = boundsWithSize(f, 0);
            if (!b) continue;
            const area = b.width * b.height;
            if (area > bestArea) { bestArea = area; best = f; }
        }
        return best ? [best] : [];
    }

    /* Kích thước tham chiếu của mặt — dùng để quy mọi biên độ theo TỈ LỆ KHUÔN MẶT,
     * không theo pixel. Mặt gần/xa máy thì hiệu ứng phải như nhau.
     *
     * ĐƠN VỊ: truyền `aspect` (rộng/cao) thì trả về khoảng cách trong KHÔNG GIAN
     * CHUẨN HOÁ THEO CHIỀU CAO — cùng đơn vị mà `displaceUv` đo khoảng cách. Không
     * truyền thì giữ UV thô (dùng cho freqRadii / nasolabialPolygon, vốn chỉ cần một
     * đại lượng tỉ lệ).
     * ĐỪNG TRỘN HAI ĐƠN VỊ: bán kính tính bằng UV thô rồi đem so với khoảng cách đo
     * trong không gian pixel là sai hệ số đúng bằng `aspect` — trên video dọc 1728x3072
     * là sai gần hai lần, và nó biểu hiện thành gradient vọt lên chứ không thành lỗi rõ.
     */
    function faceScale(face, aspect) {
        const a = pointAt(face, POINTS.leftCheek);
        const b = pointAt(face, POINTS.rightCheek);
        if (!a || !b) return 0;
        const k = Number(aspect) > 0 ? Number(aspect) : 1;
        return Math.hypot((b.x - a.x) * k, b.y - a.y);
    }

    // ---------------------------------------------------------------------
    // 4. BIẾN DẠNG HÌNH HỌC — điểm điều khiển
    // ---------------------------------------------------------------------
    //
    // Mô hình: mỗi điểm điều khiển là (tâm, dịch chuyển, bán kính ảnh hưởng). Shader
    // dịch UV theo tổng các ảnh hưởng, mỗi cái tắt dần theo hàm mũ. Cố ý KHÔNG dùng
    // biến dạng theo lưới tam giác: lưới đòi hỏi shader phải biết cả topology, mà
    // WebGL1 thì bất tiện — trong khi kiểu "điểm + bán kính" tái tạo được y hệt ở khâu
    // bake khi xuất, tức giữ được WYSIWYG.

    // Biên độ ở mức slider 100, theo TỈ LỆ bề ngang mặt.
    // BỘ SỐ NÀY ĐƯỢC CHỌN BẰNG ĐO GRADIENT, không phải bằng cảm giác: bản đầu
    // (0.055 / 0.040, bán kính 0.34 / 0.30) cho gradient tổ hợp 0.815 — chưa gấp ảnh
    // nhưng quá sát ngưỡng 1, tức chỉ cần một khuôn mặt góc cạnh hơn là rách mép hàm.
    // Nới BÁN KÍNH rẻ hơn hạ BIÊN ĐỘ: từ 0.815 xuống 0.493 mà độ thon chỉ giảm
    // 5.5% -> 4.7% bề ngang mặt. Xem `warpMaxGradient` và test `testWarpNeverFolds`.
    const FACELIFT_MAX = 0.048;
    const PLUMP_MAX = 0.034;
    const JAW_RADIUS = 0.50;     // theo cỡ mặt (đơn vị chiều cao khung)
    const CHEEK_RADIUS = 0.44;

    // Cặp điểm quai hàm dùng cho "Thon mặt": kéo hai bên vào TÂM cằm.
    const JAW_LEFT = [172, 136, 150, 149, 176];
    const JAW_RIGHT = [397, 365, 379, 378, 400];
    // Vùng má cho "Đầy đặn": đẩy ra NGOÀI + lên trên một chút.
    const CHEEK_LEFT = [50, 101, 118];
    const CHEEK_RIGHT = [280, 330, 347];

    /* @param aspect  rộng/cao của khung. Bán kính trả về nằm trong không gian chuẩn
     *                hoá theo CHIỀU CAO (khớp `displaceUv`); còn `dx` trả về đã quy
     *                ngược về đơn vị UV-x để cộng thẳng vào toạ độ u. */
    function warpControlPoints(face, rawParams, aspect = 1) {
        const r = normalize({ enabled: true, params: rawParams });
        const a = Number(aspect) > 0 ? Number(aspect) : 1;
        const scale = faceScale(face, a);          // đơn vị: chiều cao khung
        const out = [];
        if (!(scale > 0)) return out;
        // Dịch chuyển NGANG tính bằng chiều cao rồi quy về UV-x (chia aspect); dịch
        // chuyển DỌC vốn đã cùng đơn vị với UV-y nên giữ nguyên.
        const toU = (h) => h / a;

        const lift = r.params.facelift / 100;
        if (lift > 0) {
            const chin = pointAt(face, POINTS.chin);
            if (chin) {
                const amount = lift * FACELIFT_MAX * scale;
                // Hai bên hàm kéo về phía TRỤC DỌC qua cằm -> mặt thon lại mà không
                // đổi chiều cao. Kéo về CHÍNH điểm cằm thì mặt bị "rút ngắn".
                [[JAW_LEFT, 1], [JAW_RIGHT, -1]].forEach(([idxs, dir]) => {
                    idxs.forEach((i) => {
                        const p = pointAt(face, i);
                        if (!p) return;
                        out.push({ x: p.x, y: p.y, dx: dir * toU(amount), dy: 0, radius: scale * JAW_RADIUS });
                    });
                });
            }
        }

        const plump = r.params.plump / 100;
        if (plump > 0) {
            const amount = plump * PLUMP_MAX * scale;
            [[CHEEK_LEFT, -1], [CHEEK_RIGHT, 1]].forEach(([idxs, dir]) => {
                idxs.forEach((i) => {
                    const p = pointAt(face, i);
                    if (!p) return;
                    out.push({ x: p.x, y: p.y, dx: dir * toU(amount), dy: -amount * 0.35, radius: scale * CHEEK_RADIUS });
                });
            });
        }
        return out;
    }

    /* Áp trường biến dạng cho MỘT toạ độ UV — CÔNG THỨC THAM CHIẾU.
     * Shader phải cài ĐÚNG hàm này; test đối chiếu hai bên qua đây.
     *
     * @param aspect  tỉ lệ khung = rộng/cao. BẮT BUỘC truyền đúng, xem bên dưới.
     *
     * HAI LỖI CỦA BẢN PHASE 1, sửa ở đây (test cũ không bắt được vì chỉ kiểm CHIỀU và
     * độ lớn, không kiểm tính đẳng hướng lẫn hiện tượng gấp ảnh):
     *
     * 1. KHOẢNG CÁCH PHẢI ĐO TRONG KHÔNG GIAN PIXEL, không phải trong UV.
     *    UV chuẩn hoá 0..1 ở CẢ hai trục, nhưng khung 1728x3072 thì 0.1 theo x = 173px
     *    còn 0.1 theo y = 307px. Đo thẳng trên UV thì vùng ảnh hưởng "tròn" hoá ra
     *    ELIP — biến dạng bè ngang trên video dọc, và khác nhau giữa video ngang/dọc.
     *    Nay nhân dx với `aspect` trước khi tính khoảng cách.
     *
     * 2. CỘNG DỒN nhiều điểm điều khiển chồng nhau -> GẤP ẢNH (fold-over).
     *    JAW_LEFT có 5 điểm cùng hướng, bán kính 0.34*cỡ mặt nên chúng phủ lên nhau
     *    gần hết. Cộng thẳng thì dịch chuyển tổng gấp ~5 lần một điểm, gradient vượt 1
     *    và ảnh gập lên chính nó -> rách mép hàm. Nay CHUẨN HOÁ theo tổng trọng số:
     *    tổng dịch chuyển không bao giờ vượt quá dịch chuyển của điểm mạnh nhất.
     */
    function displaceUv(u, v, controls, aspect = 1) {
        const a = Number(aspect) > 0 ? Number(aspect) : 1;
        let du = 0, dv = 0, wSum = 0, wMax = 0;
        for (const c of controls) {
            const dx = (u - c.x) * a;   // quy về không gian pixel (xem lỗi 1)
            const dy = v - c.y;
            const d2 = dx * dx + dy * dy;
            const r2 = c.radius * c.radius;
            if (d2 > r2) continue;
            // Tắt dần cos² — mượt ở cả tâm lẫn biên, đạo hàm bằng 0 ở biên nên không
            // để lại đường gờ thấy được (đúng lý do nhóm tone của color-adjust cũng
            // dùng cos²).
            const t = Math.sqrt(d2) / c.radius;
            const w = Math.cos((Math.PI / 2) * t) ** 2;
            du -= c.dx * w;
            dv -= c.dy * w;
            wSum += w;
            if (w > wMax) wMax = w;
        }
        // TRUNG BÌNH CÓ TRỌNG SỐ rồi nhân lại trọng số LỚN NHẤT (xem lỗi 2).
        //   - một điểm đơn lẻ  -> (w·d/w)·w = d·w, y hệt như không chuẩn hoá;
        //   - N điểm trùng nhau -> vẫn ra d·w, không cộng dồn thành N lần.
        // Bản đầu dùng `if (wSum > 1) chia cho wSum` — CHỖ GÃY: đạo hàm nhảy bậc ngay
        // tại đường wSum = 1, và chính chỗ gãy đó đẩy gradient lên 0.805 (đo được),
        // sát ngưỡng gấp ảnh. Trung bình có trọng số thì liên tục ở mọi nơi.
        if (wSum > 1e-9) { du = (du / wSum) * wMax; dv = (dv / wSum) * wMax; }
        // Lấy MẪU NGƯỢC: pixel đích lấy màu từ nguồn ở (u+du, v+dv). Dấu trừ ở trên là
        // vì thế — quên là ảnh biến dạng ngược chiều.
        return [u + du, v + dv];
    }

    /* Gradient LỚN NHẤT của trường biến dạng, lấy mẫu số trên hộp bao mặt.
     *
     * DÙNG ĐỂ LÀM GÌ: gradient ≥ 1 nghĩa là trường dịch chuyển GẤP ảnh lên chính nó —
     * hai điểm nguồn khác nhau rơi vào cùng một điểm đích -> mép hàm bị rách/nhoè.
     * Đây là hỏng hóc đặc trưng của warp làm ẩu, và nhìn công thức KHÔNG thấy được:
     * nó phụ thuộc vào biên độ, bán kính VÀ mức chồng nhau giữa các điểm điều khiển.
     * Test đo số này ở mức kéo hết slider và đòi nó phải dưới 1 với biên an toàn.
     */
    function warpMaxGradient(controls, bounds, aspect = 1, steps = 48) {
        if (!controls.length || !bounds) return 0;
        const a = Number(aspect) > 0 ? Number(aspect) : 1;
        const hx = (bounds.x1 - bounds.x0) / steps;
        const hy = (bounds.y1 - bounds.y0) / steps;
        let worst = 0;
        for (let i = 0; i <= steps; i++) {
            for (let j = 0; j <= steps; j++) {
                const u = bounds.x0 + hx * i;
                const v = bounds.y0 + hy * j;
                const p = displaceUv(u, v, controls, a);
                const px = displaceUv(u + hx, v, controls, a);
                const py = displaceUv(u, v + hy, controls, a);
                // Ma trận Jacobi của phép ánh xạ, quy về không gian pixel.
                const j11 = (px[0] - p[0]) / hx, j12 = (py[0] - p[0]) / hy;
                const j21 = (px[1] - p[1]) / hx, j22 = (py[1] - p[1]) / hy;
                // Định thức < 0 = ẢNH ĐÃ GẤP. Trả về mức "lệch khỏi phép đồng nhất"
                // để test có một con số so được.
                const det = j11 * j22 - j12 * j21;
                const dev = Math.max(Math.abs(j11 - 1), Math.abs(j22 - 1),
                                     Math.abs(j12), Math.abs(j21), det <= 0 ? 99 : 0);
                if (dev > worst) worst = dev;
            }
        }
        return worst;
    }

    // ---------------------------------------------------------------------
    // 5. MẶT NẠ VÙNG
    // ---------------------------------------------------------------------
    //
    // BỐN MẶT NẠ GÓI VÀO BỐN KÊNH của MỘT texture RGBA:
    //     R = da · G = mắt · B = răng (khoang miệng) · A = quầng thâm
    // Một texture thay vì bốn: mỗi texture là một lần upload GPU và một sampler trong
    // shader, mà WebGL1 giới hạn số sampler. Gói kênh cũng bảo đảm bốn mặt nạ luôn
    // CÙNG độ phân giải và cùng phép làm mượt biên — lệch nhau là thấy đường ghép.
    const MASK_CHANNELS = ['skin', 'eyes', 'teeth', 'underEye'];

    /* BỐ TRÍ MẶT NẠ TRONG TEXTURE.
     *
     * Cần 5 mặt nạ mà một RGBA chỉ có 4 kênh -> DÙNG 2 TEXTURE. Ghi chú cũ nói "một
     * texture để đỡ sampler" là LO XA KHÔNG CẦN THIẾT: WebGL1 bảo đảm tối thiểu 8
     * texture unit cho fragment shader, mà cả chuỗi retouch chỉ dùng 5 (ảnh nguồn,
     * 2 mặt nạ, 2 tầng mờ). Texture thứ hai còn dư 3 kênh cho mặt nạ về sau (trán,
     * môi…) mà không phải dựng lại bố cục.
     * Cái PHẢI giữ là: mọi mặt nạ cùng độ phân giải và CÙNG phép làm mượt biên —
     * lệch nhau là thấy đường ghép.
     */
    const MASK_LAYOUT = [
        { name: 'skin', tex: 0, ch: 0 },
        { name: 'eyes', tex: 0, ch: 1 },
        { name: 'teeth', tex: 0, ch: 2 },
        { name: 'underEye', tex: 0, ch: 3 },
        { name: 'nasolabial', tex: 1, ch: 0 },
    ];
    const MASK_TEXTURES = 2;
    // Làm mượt biên: xếp tầng box blur 3 lần (xấp xỉ Gauss). ĐÚNG con số mà nhóm
    // Hiệu ứng của color-adjust.js đang dùng, và vì đúng lý do đó: box blur là phép
    // CHÍNH XÁC nên shader/khâu bake tái tạo được tuyệt đối, còn Gauss đệ quy (gblur)
    // thì không. Dùng `ctx.filter='blur()'` của canvas càng không được — nó do trình
    // duyệt tự định nghĩa, preview và bản xuất sẽ lệch.
    const MASK_BLUR_CASCADE = 3;
    // Bán kính làm mượt theo TỈ LỆ BỀ NGANG MẶT (không theo pixel) — cùng lý do với
    // freqRadii: mặt gần/xa máy phải cho cùng cảm giác.
    const MASK_FEATHER_FRAC = 0.035;
    // Lỗ khoét làm mượt NHẸ hơn viền ngoài nhiều — xem lý do trong rasterizeMasks.
    const HOLE_FEATHER_SCALE = 0.28;
    // Lưới mặt nạ tự co giãn để KHUÔN MẶT luôn chiếm đủ pixel. Mặt nạ có chi tiết nhỏ
    // (chân mày dày ~3.6% bề ngang mặt): mặt chỉ 72px trên lưới thì chân mày còn 2.6px,
    // làm mượt bao nhiêu cũng hỏng. Neo theo mặt chứ không theo khung.
    // Lưới mặt nạ (vuông) trong KHÔNG GIAN HỘP BAO MẶT — xem rasterizeMasks.
    const MASK_GRID = 256;
    // Nới hộp bao để phần làm mượt biên không bị cắt cụt ở mép hộp.
    const MASK_BOUNDS_PAD = 0.18;

    /* Polygon của từng mặt nạ. `holes` là các vùng phải KHOÉT khỏi mặt nạ đó.
     *
     * DA = viền mặt TRỪ mắt, TRỪ chân mày, TRỪ khoang miệng. Không khoét thì:
     *   - làm mịn lên mắt -> mất nét mi, mắt "mờ"
     *   - làm trắng lên chân mày -> bay mất mày
     *   - làm mịn lên khoang miệng -> mất ranh giới răng
     * Đây là khác biệt giữa retouch và "blur cả mặt".
     */
    function maskPolygons(face) {
        const poly = (k) => regionPolygon(face, k);
        const skin = poly('faceOval');
        if (!skin.length) return null;
        return {
            skin: { outline: skin, holes: [poly('leftEye'), poly('rightEye'),
                                           poly('leftBrow'), poly('rightBrow'),
                                           poly('lipsInner')].filter((p) => p.length) },
            eyes: { outline: null, parts: [poly('leftEye'), poly('rightEye')].filter((p) => p.length), holes: [] },
            teeth: { outline: poly('lipsInner'), holes: [] },
            underEye: { outline: null, parts: [underEyePolygon(face, 'left'), underEyePolygon(face, 'right')]
                .filter((p) => p.length), holes: [] },
        };
    }

    function underEyePolygon(face, side) {
        const spec = EYE_LOWER[side];
        if (!spec) return [];
        const out = [];
        for (const i of spec.inner) {
            const p = pointAt(face, i);
            if (!p) return [];
            out.push(p);
        }
        // Đi NGƯỢC vòng ngoài -> polygon khép kín, không tự cắt.
        for (let k = spec.outer.length - 1; k >= 0; k--) {
            const p = pointAt(face, spec.outer[k]);
            if (!p) return [];
            out.push(p);
        }
        return out;
    }

    // ---------------------------------------------------------------------
    // 5b. RASTER HOÁ MẶT NẠ
    // ---------------------------------------------------------------------
    //
    // THUẦN JS, KHÔNG DÙNG CANVAS. `ctx.fill()` (khử răng cưa) và `ctx.filter='blur()'`
    // đều do TRÌNH DUYỆT tự định nghĩa — dùng chúng thì preview và khâu bake khi xuất
    // cho ra mặt nạ khác nhau, tức WYSIWYG vỡ ngay ở chỗ khó thấy nhất (mép mặt nạ).
    // Tự rasterize thì hai bên ra ĐÚNG cùng một mảng số.

    /* Tô các polygon vào một kênh bằng SCANLINE với quy tắc EVEN-ODD.
     * Even-odd lo luôn phần LỖ KHOÉT: cho cạnh của lỗ vào cùng danh sách là xong,
     * không cần nhánh riêng. */
    function fillPolygonsEvenOdd(dst, w, h, polys, value) {
        const edges = [];
        for (const poly of polys || []) {
            if (!poly || poly.length < 3) continue;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const a = poly[j], b = poly[i];
                const ay = a.y * h, by = b.y * h;
                if (ay === by) continue;              // cạnh ngang không cắt scanline
                edges.push({ ax: a.x * w, ay, bx: b.x * w, by });
            }
        }
        if (!edges.length) return;
        let minY = h, maxY = 0;
        for (const e of edges) {
            minY = Math.min(minY, e.ay, e.by);
            maxY = Math.max(maxY, e.ay, e.by);
        }
        const yStart = Math.max(0, Math.floor(minY));
        const yEnd = Math.min(h - 1, Math.ceil(maxY));
        const xs = [];
        for (let y = yStart; y <= yEnd; y++) {
            const cy = y + 0.5;                        // tâm pixel
            xs.length = 0;
            for (const e of edges) {
                const lo = Math.min(e.ay, e.by), hi = Math.max(e.ay, e.by);
                // Nửa mở [lo, hi): đỉnh chung của 2 cạnh chỉ được đếm MỘT lần, nếu
                // không even-odd lật nhầm và cả dòng bị tô ngược.
                if (cy < lo || cy >= hi) continue;
                xs.push(e.ax + ((cy - e.ay) / (e.by - e.ay)) * (e.bx - e.ax));
            }
            if (xs.length < 2) continue;
            xs.sort((p, q) => p - q);
            for (let k = 0; k + 1 < xs.length; k += 2) {
                const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
                const xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
                for (let x = xa; x <= xb; x++) dst[y * w + x] = value;
            }
        }
    }

    // Box blur một chiều bằng cửa sổ trượt — O(n) không phụ thuộc bán kính.
    function boxBlur1D(src, dst, w, h, radius, horizontal) {
        const r = Math.max(0, Math.round(radius));
        if (r === 0) { dst.set(src); return; }
        const n = 2 * r + 1;
        const len = horizontal ? w : h;
        const outer = horizontal ? h : w;
        const step = horizontal ? 1 : w;
        for (let o = 0; o < outer; o++) {
            const base = horizontal ? o * w : o;
            let sum = 0;
            // Mép ảnh: LẶP LẠI pixel biên (clamp), không coi ngoài ảnh là 0 — coi là 0
            // thì mặt nạ bị tối đi ở sát mép khung và hiệu ứng nhạt dần một cách vô lý.
            for (let k = -r; k <= r; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * step];
            for (let i = 0; i < len; i++) {
                dst[base + i * step] = sum / n;
                const outIdx = Math.min(len - 1, Math.max(0, i - r));
                const inIdx = Math.min(len - 1, Math.max(0, i + r + 1));
                sum += src[base + inIdx * step] - src[base + outIdx * step];
            }
        }
    }

    /* @param tmp  bộ đệm w*h dùng lại (tuỳ chọn). Không truyền thì tự cấp phát.
     *             Trong vòng vẽ thì PHẢI truyền: mỗi khung có 6 lượt feather, tự cấp
     *             phát là 6 mảng 256KB/khung ném cho GC ngay giữa lúc phát. */
    function featherMask(buf, w, h, radius, tmp) {
        if (!(radius > 0)) return buf;
        const t = (tmp && tmp.length >= buf.length) ? tmp : new Float32Array(buf.length);
        for (let i = 0; i < MASK_BLUR_CASCADE; i++) {
            boxBlur1D(buf, t, w, h, radius, true);
            boxBlur1D(t, buf, w, h, radius, false);
        }
        return buf;
    }

    /* Raster hoá TOÀN BỘ mặt nạ ra các texture RGBA.
     *
     * @param faces   danh sách mặt (đã qua selectFaces)
     * @param options { size, aspect, bounds, need, scratch }
     *   size    — cạnh lưới mặt nạ (vuông). Mặt nạ là hàm trơn nên không cần bằng kích
     *             thước ảnh: để GPU nội suy song tuyến là đủ.
     *   need    — { skin, eyes, teeth, underEye, nasolabial } : bỏ hẳn mặt nạ nào KHÔNG
     *             ai đọc (xem requiredMasks). Không truyền = dựng tất.
     *   scratch — { buf, holeBuf, tmp } Float32Array(size²) dùng lại giữa các khung.
     * @return { width, height, textures: [Uint8ClampedArray RGBA, ...] }
     */
    function rasterizeMasks(faces, options = {}) {
        const list = Array.isArray(faces) ? faces.filter(Boolean) : [];
        const ar = Number(options.aspect) > 0 ? Number(options.aspect) : 1;

        /* RASTER TRONG KHÔNG GIAN CỤC BỘ CỦA MẶT, không phủ cả khung.
         *
         * Lý do (đo được): để chân mày — dày ~3.6% bề ngang mặt — còn sống sau khi làm
         * mượt biên thì mặt phải chiếm ~220px trên lưới. Mà mặt chỉ chiếm ~22% bề ngang
         * khung, nên lưới phủ CẢ KHUNG phải là 979x1740 = 1.7 triệu pixel -> đo được
         * 325 ms/khung, không dùng được cho preview.
         * Raster đúng HỘP BAO MẶT thì 256x256 = 65k pixel cho CÙNG độ chi tiết, rẻ hơn
         * ~26 lần. Shader/khâu bake quy toạ độ khung về toạ độ hộp rồi mới lấy mẫu —
         * `sampleMasks` làm đúng phép quy đổi đó và là tham chiếu cho shader.
         * Ngoài hộp thì mọi mặt nạ = 0, tức retouch không đụng tới, đúng như thiết kế.
         */
        let bounds = options.bounds || null;
        if (!bounds && list.length) {
            let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
            list.forEach((f) => {
                const b = boundsWithSize(f, MASK_BOUNDS_PAD);
                if (!b) return;
                x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
                x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
            });
            if (x1 > x0 && y1 > y0) bounds = { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
        }
        const textures = [];
        const size = Math.max(64, Math.min(1024, Math.round(Number(options.size) || MASK_GRID)));
        const w = size;
        const h = size;
        for (let t = 0; t < MASK_TEXTURES; t++) textures.push(new Uint8ClampedArray(w * h * 4));
        if (!list.length || !bounds) return { width: w, height: h, textures, bounds: null, feather: 0, facePx: 0 };

        // Quy landmark về toạ độ TRONG HỘP (0..1 theo từng cạnh hộp).
        const toLocal = (p) => ({
            x: (p.x - bounds.x0) / bounds.width,
            y: (p.y - bounds.y0) / bounds.height,
        });
        // Bề ngang mặt tính bằng pixel TRÊN LƯỚI mặt nạ.
        let facePx = 0;
        list.forEach((f) => {
            const a = pointAt(f, POINTS.leftCheek), b = pointAt(f, POINTS.rightCheek);
            if (a && b) {
                facePx = Math.max(facePx, Math.hypot(
                    (b.x - a.x) / bounds.width * w, (b.y - a.y) / bounds.height * h));
            }
        });
        const feather = Math.max(1, facePx * MASK_FEATHER_FRAC);

        // Bộ đệm dùng lại nếu caller đưa (vòng vẽ), tự cấp phát nếu không (test, bake).
        const sc = options.scratch && options.scratch.size === w * h ? options.scratch : null;
        const buf = sc ? sc.buf : new Float32Array(w * h);
        const holeBuf = sc ? sc.holeBuf : new Float32Array(w * h);
        const tmp = sc ? sc.tmp : new Float32Array(w * h);
        const need = options.need || null;
        for (const layout of MASK_LAYOUT) {
            // Mặt nạ không ai đọc -> để nguyên kênh 0 và đi tiếp. Kết quả không đổi vì
            // số hạng dùng nó có hệ số 0 (xem requiredMasks).
            if (need && !need[layout.name]) continue;
            buf.fill(0);
            holeBuf.fill(0);
            let hasHole = false;
            for (const face of list) {
                const shape = shapeForMask(face, layout.name);
                const fill = shape.fill.map((poly) => poly.map(toLocal));
                const holes = shape.holes.map((poly) => poly.map(toLocal));
                if (fill.length) fillPolygonsEvenOdd(buf, w, h, fill, 255);
                if (holes.length) { fillPolygonsEvenOdd(holeBuf, w, h, holes, 255); hasHole = true; }
            }
            featherMask(buf, w, h, feather, tmp);
            if (hasHole) {
                // LỖ KHOÉT LÀM MƯỢT NHẸ HƠN NHIỀU rồi TRỪ ra, thay vì gộp chung vào một
                // lượt even-odd rồi làm mượt cả cụm.
                // LÝ DO (đo được): chân mày mỏng hơn viền mặt cả trăm lần. Làm mượt CÙNG
                // bán kính thì lỗ chân mày bị lấp gần hết -> mặt nạ da phủ luôn lông mày,
                // và "làm trắng da" sẽ bay mất mày — đúng cái mà việc khoét lỗ sinh ra để
                // tránh. Đo trước khi sửa: giữa mắt da = 0.65, chân mày da = 1.00.
                // Viền ngoài cần MỀM (không thấy đường cắt ở mép mặt); lỗ cần SẮC.
                featherMask(holeBuf, w, h, Math.max(0.6, feather * HOLE_FEATHER_SCALE), tmp);
                for (let i = 0; i < w * h; i++) buf[i] *= 1 - holeBuf[i] / 255;
            }
            const tex = textures[layout.tex];
            for (let i = 0; i < w * h; i++) tex[i * 4 + layout.ch] = buf[i];
        }
        return { width: w, height: h, textures, bounds, feather, facePx };
    }

    /* Hình của một mặt nạ, TÁCH viền ngoài khỏi lỗ khoét (hai bên làm mượt khác nhau). */
    function shapeForMask(face, name) {
        const m = maskPolygons(face);
        if (!m) return { fill: [], holes: [] };
        if (name === 'nasolabial') {
            return {
                fill: [nasolabialPolygon(face, 'left'), nasolabialPolygon(face, 'right')].filter((p) => p.length),
                holes: [],
            };
        }
        const spec = m[name];
        if (!spec) return { fill: [], holes: [] };
        const fill = [];
        if (spec.outline && spec.outline.length) fill.push(spec.outline);
        (spec.parts || []).forEach((p) => { if (p.length) fill.push(p); });
        return { fill, holes: (spec.holes || []).filter((p) => p.length) };
    }

    /* Gộp viền + lỗ thành MỘT danh sách (even-odd tự lo phần khoét) — dùng cho phép đo
     * và cho đường vẽ nào không cần làm mượt riêng hai phần. */
    function polygonsForMask(face, name) {
        const s = shapeForMask(face, name);
        return [...s.fill, ...s.holes];
    }

    /* Đọc trọng số mặt nạ tại một toạ độ chuẩn hoá — dùng cho đường CPU (test, bake)
     * và làm THAM CHIẾU cho phép lấy mẫu texture của shader. */
    function sampleMasks(raster, u, v) {
        const out = { skin: 0, eyes: 0, teeth: 0, underEye: 0, nasolabial: 0 };
        if (!raster || !raster.bounds) return out;
        // Quy toạ độ KHUNG -> toạ độ trong HỘP BAO MẶT. Ngoài hộp thì mọi mặt nạ = 0
        // (trả sớm), tức retouch không đụng tới — đây cũng chính là phép mà shader phải
        // cài lại, nên sửa ở đây thì phải sửa cả bên kia.
        const lu = (u - raster.bounds.x0) / raster.bounds.width;
        const lv = (v - raster.bounds.y0) / raster.bounds.height;
        if (lu < 0 || lu >= 1 || lv < 0 || lv >= 1) return out;
        const x = Math.min(raster.width - 1, Math.max(0, Math.floor(lu * raster.width)));
        const y = Math.min(raster.height - 1, Math.max(0, Math.floor(lv * raster.height)));
        const i = (y * raster.width + x) * 4;
        for (const l of MASK_LAYOUT) out[l.name] = raster.textures[l.tex][i + l.ch] / 255;
        return out;
    }

    // ---------------------------------------------------------------------
    // 6. NHÓM `color` — CÔNG THỨC THAM CHIẾU
    // ---------------------------------------------------------------------
    //
    // Đây là NGUỒN SỰ THẬT: shader preview và khâu bake khi xuất đều phải cài đúng
    // hàm này, và test đối chiếu qua nó. Mọi phép đều nhân với TRỌNG SỐ MẶT NẠ nên
    // ngoài vùng là bất biến tuyệt đối — điều kiện để retouch không rỉ ra hậu cảnh.

    const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));
    const mix = (a, b, t) => a + (b - a) * t;

    function hexToRgb(hex) {
        const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''));
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }

    /* Áp toàn bộ nhóm `color` cho MỘT pixel.
     * @param rgb    màu gốc 0..1
     * @param raw    bộ tham số retouch
     * @param m      trọng số mặt nạ tại pixel đó {skin, eyes, teeth, underEye} 0..1
     */
    function applyColorOps(rgb, raw, m) {
        const r = normalize(raw);
        const p = r.params;
        const w = {
            skin: clamp01(m && m.skin || 0),
            eyes: clamp01(m && m.eyes || 0),
            teeth: clamp01(m && m.teeth || 0),
            underEye: clamp01(m && m.underEye || 0),
        };
        let c = [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];

        // TRẮNG DA — nâng sáng bằng GAMMA + giảm bão hoà nhẹ. Nâng bằng phép NHÂN thì
        // vùng sáng trên mặt (sống mũi, trán) cháy ngay; cùng bài học với nhóm LUT.
        const white = (p.whitening / 100) * w.skin;
        if (white > 0) {
            const lifted = c.map((v) => Math.pow(v, 1 / (1 + 0.55 * white)));
            const y = luma(lifted[0], lifted[1], lifted[2]);
            c = lifted.map((v) => clamp01(mix(v, mix(v, y, 0.18 * white), 1)));
        }

        // QUẦNG THÂM — nâng riêng vùng TỐI dưới mắt. Nâng đều cả vùng thì gò má bị
        // bệt sáng; trọng số (1 − độ sáng) khiến chỗ càng thâm càng được nâng nhiều.
        const dark = (p.darkCircles / 100) * w.underEye;
        if (dark > 0) {
            const y = luma(c[0], c[1], c[2]);
            const boost = dark * 0.42 * (1 - y);
            // Quầng thâm ngả xanh/tím -> bù thêm chút đỏ, nếu không nâng sáng xong
            // vùng đó vẫn xám xịt.
            c = [clamp01(c[0] + boost * 1.10), clamp01(c[1] + boost * 0.95), clamp01(c[2] + boost * 0.90)];
        }

        // SÁNG MẮT — tăng tương phản cục bộ quanh trung tính: lòng trắng sáng lên,
        // con ngươi vẫn sâu. Nâng sáng đều thì mắt bị "đục".
        const eye = (p.brightEye / 100) * w.eyes;
        if (eye > 0) {
            const k = 1 + 0.45 * eye;
            c = c.map((v) => clamp01((v - 0.5) * k + 0.5 + 0.06 * eye));
        }

        // TRẮNG RĂNG — răng ố là ngả VÀNG, tức thừa đỏ+lục so với lam. Vì vậy kéo bão
        // hoà xuống rồi mới nâng sáng, KHÔNG nâng sáng thẳng (nâng thẳng ra răng vàng
        // sáng hơn chứ không trắng hơn).
        const teeth = (p.whiteTeeth / 100) * w.teeth;
        if (teeth > 0) {
            const y = luma(c[0], c[1], c[2]);
            c = c.map((v) => clamp01(mix(v, y, 0.65 * teeth)));
            c = c.map((v) => clamp01(v + 0.16 * teeth * (1 - v)));
        }

        // TÔNG DA — kéo SẮC về màu đích nhưng GIỮ NGUYÊN ĐỘ SÁNG của pixel. Trộn thẳng
        // sang màu đích là mặt bẹt như dán giấy màu: mất hết khối sáng tối.
        const toneRgb = hexToRgb(r.skinTone);
        const tone = toneRgb ? (r.skinToneAmount / 100) * w.skin : 0;
        if (tone > 0) {
            const y = luma(c[0], c[1], c[2]);
            const ty = luma(toneRgb[0], toneRgb[1], toneRgb[2]) || 1e-6;
            const scaled = toneRgb.map((v) => clamp01(v * (y / ty)));
            c = c.map((v, i) => clamp01(mix(v, scaled[i], tone)));
        }
        return c;
    }

    // ---------------------------------------------------------------------
    // 7. NHÓM `freq` — TÁCH TẦN SỐ
    // ---------------------------------------------------------------------
    //
    // NGUYÊN LÝ (phép chuẩn của ngành, KHÔNG phải "blur rồi trộn lại"):
    //   lowFine   = ảnh mờ bán kính NHỎ   -> mất lỗ chân lông, mụn
    //   lowCoarse = ảnh mờ bán kính LỚN   -> mất cả nếp nhăn, vệt màu
    //   high = gốc − lowFine       (kết cấu mịn: lỗ chân lông, mụn, râu)
    //   mid  = lowFine − lowCoarse (kết cấu thô: nếp nhăn, nếp cười, mảng màu)
    // Nén `high`/`mid` TRONG mặt nạ da rồi cộng lại. Vì `low` được giữ nguyên nên
    // KHỐI SÁNG TỐI và hình dạng mặt không đổi — đó là lý do da mịn mà không "nhựa".
    // Blur thẳng rồi trộn thì mất luôn cả khối, ra mặt phẳng lì.
    //
    // BÁN KÍNH KHAI THEO TỈ LỆ CỠ MẶT, không theo khung và không theo pixel: mặt ở xa
    // máy thì lỗ chân lông nhỏ hơn trên ảnh, dùng bán kính cố định là mặt gần bị mịn
    // quá còn mặt xa không ăn thua. Đây cũng là điều kiện để preview proxy 540px khớp
    // bản xuất 3072px — cùng bài học với nhóm Hiệu ứng của color-adjust.js.
    const FREQ_FINE_FRAC = 0.022;     // ≈ lỗ chân lông / mụn
    const FREQ_COARSE_FRAC = 0.075;   // ≈ nếp nhăn / mảng màu

    /* @param frameW,frameH  kích thước khung tính bằng PIXEL.
     *
     * PHẢI TRUYỀN CẢ HAI CHIỀU. Bản đầu chỉ nhận một số rồi nhân với `faceScale` thô —
     * mà faceScale đo giữa hai mép má nên nó là tỉ lệ theo CHIỀU RỘNG, nhân với pixel
     * CHIỀU CAO là sai đúng bằng tỉ lệ khung. Trên khung dọc 400x712 nó cho bán kính
     * thô 12px = 13% bề ngang mặt (đáng ra 8%) -> mặt bị nhoè quá tay, thấy ngay trên
     * ảnh mà unit test không bắt được vì test chỉ kiểm TỈ LỆ chứ không kiểm trị tuyệt đối.
     * Nay tính thẳng bề ngang mặt bằng pixel rồi mới lấy tỉ lệ.
     */
    /* HAI TẦNG MỜ TÍNH TRONG LƯỚI CỤC BỘ CỦA MẶT, không tính ở độ phân giải nguồn.
     *
     * VÌ SAO BẮT BUỘC (ràng buộc cứng, không phải tối ưu): shader tích chập dùng chung
     * của dự án có MAX_TAPS = 33, tức bán kính tối đa 16px. Mà bán kính thô = 7.5% bề
     * ngang mặt, ở nguồn 1728x3072 là **29.1px** — vượt trần. Tính thẳng ở độ phân giải
     * nguồn thì shader bị kẹp bán kính còn khâu bake thì không -> preview và bản xuất
     * mờ khác nhau, đúng cái WYSIWYG cấm.
     * Trong lưới cục bộ 256 (mặt chiếm ~186px) thì bán kính thô còn ~14px < 16 ở MỌI độ
     * phân giải nguồn — cùng một con số cho preview proxy 540px lẫn bản xuất 3072px.
     *
     * VÌ SAO KHÔNG MẤT CHI TIẾT: hai tầng này theo định nghĩa là TẦN SỐ THẤP (trơn), nên
     * tính ở lưới nhỏ rồi nội suy lên là gần như chính xác. Tầng `high` vẫn được lấy ở
     * ĐỘ PHÂN GIẢI ĐẦY ĐỦ: high = gốc(full) − lowFine(nội suy lên). Chi tiết da nằm
     * trọn trong `high` nên không mất gì.
     */
    const FREQ_GRID = 256;
    // Lưới dùng khi ĐANG PHÁT. Xem khối chú thích của RetouchRenderer để biết vì sao
    // 128 là an toàn (đo được: lệch trung bình 0.22/255 so với lưới 256).
    const FREQ_GRID_PLAYING = 128;

    function clampGrid(g) {
        const v = Math.round(Number(g) || 0);
        if (!(v >= 64)) return FREQ_GRID;
        return Math.max(64, Math.min(1024, v));
    }

    function freqRadiiOnGrid(face, bounds, grid = FREQ_GRID) {
        const a = pointAt(face, POINTS.leftCheek);
        const b = pointAt(face, POINTS.rightCheek);
        if (!a || !b || !bounds) return { fine: 0, coarse: 0, facePx: 0 };
        const facePx = Math.hypot((b.x - a.x) / bounds.width * grid,
                                  (b.y - a.y) / bounds.height * grid);
        return {
            fine: Math.max(1, facePx * FREQ_FINE_FRAC),
            coarse: Math.max(2, facePx * FREQ_COARSE_FRAC),
            facePx,
        };
    }

    /* Làm mờ THAM CHIẾU cho hai tầng tần số — box blur XẾP TẦNG ×3.
     * Chốt thuật toán ở đây để shader và khâu bake không mỗi bên một kiểu: box blur là
     * phép CHÍNH XÁC nên tái tạo được tuyệt đối (cùng lý do nhóm Hiệu ứng của
     * color-adjust.js chọn avgblur xếp tầng thay vì gblur). */
    /* @param scratch { out, plane, tmp } — bộ đệm dùng lại (tuỳ chọn). Trong vòng vẽ thì
     *                nên truyền: mỗi khung hai lượt gọi, mỗi lượt tự cấp phát 786KB +
     *                2×256KB. Truyền `out` thì hàm GHI ĐÈ lên nó và trả về chính nó —
     *                caller phải hiểu là hai lượt gọi cần HAI `out` khác nhau. */
    function blurRgbBoxCascade(rgb, w, h, radius, scratch) {
        const fit = scratch && scratch.out && scratch.out.length === rgb.length
            && scratch.plane && scratch.plane.length >= w * h
            && scratch.tmp && scratch.tmp.length >= w * h;
        const out = fit ? scratch.out : new Float32Array(rgb.length);
        out.set(rgb);
        if (!(radius > 0)) return out;
        const plane = fit ? scratch.plane : new Float32Array(w * h);
        const tmp = fit ? scratch.tmp : new Float32Array(w * h);
        for (let c = 0; c < 3; c++) {
            for (let i = 0; i < w * h; i++) plane[i] = out[i * 3 + c];
            for (let k = 0; k < MASK_BLUR_CASCADE; k++) {
                boxBlur1D(plane, tmp, w, h, radius, true);
                boxBlur1D(tmp, plane, w, h, radius, false);
            }
            for (let i = 0; i < w * h; i++) out[i * 3 + c] = plane[i];
        }
        return out;
    }

    function freqRadii(face, frameW, frameH) {
        const a = pointAt(face, POINTS.leftCheek);
        const b = pointAt(face, POINTS.rightCheek);
        if (!a || !b) return { fine: 0, coarse: 0, facePx: 0 };
        const w = Math.max(1, Number(frameW) || 0);
        const h = Math.max(1, Number(frameH) || Number(frameW) || 0);
        const facePx = Math.hypot((b.x - a.x) * w, (b.y - a.y) * h);
        if (!(facePx > 0)) return { fine: 0, coarse: 0, facePx: 0 };
        return {
            fine: Math.max(1, facePx * FREQ_FINE_FRAC),
            coarse: Math.max(2, facePx * FREQ_COARSE_FRAC),
            facePx,
        };
    }

    /* VÙNG NẾP CƯỜI — DỰNG BẰNG HÌNH HỌC từ các mốc ĐÃ KIỂM CHỨNG (mũi, khoé miệng,
     * mép má), KHÔNG chép thêm một bộ chỉ số MediaPipe nữa.
     * Lý do: mỗi bộ chỉ số chép tay là một chỗ sai âm thầm; ở đây dải nếp cười vốn là
     * một BĂNG chạy từ cánh mũi xuống cạnh khoé miệng, mô tả bằng hình học vừa gọn vừa
     * tự đúng với mọi khuôn mặt. */
    function nasolabialPolygon(face, side) {
        const nose = pointAt(face, POINTS.noseTip);
        const corner = pointAt(face, side === 'left' ? POINTS.mouthLeft : POINTS.mouthRight);
        const cheek = pointAt(face, side === 'left' ? POINTS.leftCheek : POINTS.rightCheek);
        if (!nose || !corner || !cheek) return [];
        // Hướng RA PHÍA MÁ (đơn vị) — dùng để nới băng sang bên.
        const ox = cheek.x - nose.x, oy = cheek.y - nose.y;
        const olen = Math.hypot(ox, oy) || 1;
        const ux = ox / olen, uy = oy / olen;
        const s = faceScale(face) || 0.2;
        const lerp2 = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        const push = (p, k) => ({ x: p.x + ux * s * k, y: p.y + uy * s * k });
        const top = lerp2(nose, corner, 0.18);
        const bot = lerp2(nose, corner, 0.92);
        return [push(top, 0.10), push(bot, 0.06), push(bot, 0.20), push(top, 0.27)];
    }

    /* Áp toàn bộ nhóm `freq` cho MỘT pixel — CÔNG THỨC THAM CHIẾU.
     *
     * Caller cung cấp `lowFine` / `lowCoarse` (đã làm mờ ở bán kính do `freqRadii` quy
     * định). Cố ý KHÔNG làm mờ trong hàm này: làm mờ là phép KHÔNG GIAN, phải chạy
     * theo lượt trên cả ảnh — nhét vào hàm per-pixel là sai kiến trúc và không tái tạo
     * được ở shader.
     *
     * @param m  trọng số mặt nạ {skin, nasolabial} 0..1
     */
    function applyFreqOps(orig, lowFine, lowCoarse, raw, m) {
        const r = normalize(raw);
        const p = r.params;
        const wSkin = clamp01((m && m.skin) || 0);
        const wFold = clamp01((m && m.nasolabial) || 0);
        const c = [clamp01(orig[0]), clamp01(orig[1]), clamp01(orig[2])];
        const lf = [clamp01(lowFine[0]), clamp01(lowFine[1]), clamp01(lowFine[2])];
        const lc = [clamp01(lowCoarse[0]), clamp01(lowCoarse[1]), clamp01(lowCoarse[2])];

        const high = [c[0] - lf[0], c[1] - lf[1], c[2] - lf[2]];
        const mid = [lf[0] - lc[0], lf[1] - lc[1], lf[2] - lc[2]];
        let base = lc.slice();

        // ĐỀU MÀU — kéo SẮC của tầng thấp về màu trung bình cục bộ, GIỮ độ sáng.
        // Đây là chỗ xử lý mảng đỏ / loang màu, KHÁC hẳn làm mịn (vốn xử lý kết cấu).
        const even = (p.even / 100) * wSkin;
        if (even > 0) {
            const y = luma(base[0], base[1], base[2]);
            base = base.map((v) => clamp01(mix(v, y + (v - y) * 0.35, even)));
        }

        // DA CĂNG BÓNG — thêm phản quang ở phần SÁNG của tầng thấp. Nâng sáng đều thì
        // chỉ làm bệt; căng bóng là chênh lệch giữa vùng sáng và vùng còn lại.
        const sparkle = (p.sparkly / 100) * wSkin;
        if (sparkle > 0) {
            const y = luma(base[0], base[1], base[2]);
            const spec = Math.max(0, y - 0.62) / 0.38;
            base = base.map((v) => clamp01(v + sparkle * 0.30 * spec * (1 - v)));
        }

        // MỊN DA — nén ĐỐI XỨNG tầng tần số cao (mọi kết cấu).
        let hi = high.slice();
        const smooth = (p.smooth / 100) * wSkin;
        if (smooth > 0) hi = hi.map((v) => v * (1 - 0.88 * smooth));

        // XOÁ KHUYẾT ĐIỂM — nén BẤT ĐỐI XỨNG: chỉ hạ các gai ÂM (chỗ TỐI hơn xung
        // quanh = mụn, đốm, vết thâm). Giữ nguyên gai dương nên lỗ chân lông và ánh
        // sáng trên da còn lại -> da vẫn ra da. Đây là khác biệt thật với Mịn da,
        // không phải hai tên gọi cho cùng một phép.
        const blem = (p.clearBlemishes / 100) * wSkin;
        if (blem > 0) hi = hi.map((v) => (v < 0 ? v * (1 - 0.92 * blem) : v));

        // NÉT CĂNG — ngược lại: KHUẾCH ĐẠI tầng tần số cao.
        const clear = (p.clear / 100) * wSkin;
        if (clear > 0) hi = hi.map((v) => v * (1 + 0.85 * clear));

        // XOÁ NẾP NHĂN — nén tầng TRUNG (nếp nhăn thô hơn lỗ chân lông nên nằm ở đây,
        // không nằm ở tầng cao). Nén nhầm tầng cao là xoá kết cấu mà nếp nhăn còn nguyên.
        let md = mid.slice();
        const wrinkle = (p.dewrinkle / 100) * wSkin;
        if (wrinkle > 0) md = md.map((v) => v * (1 - 0.75 * wrinkle));

        // NẾP CƯỜI — cùng tầng TRUNG nhưng khu trú trong dải nếp cười.
        const fold = (p.smileLines / 100) * wFold;
        if (fold > 0) md = md.map((v) => v * (1 - 0.80 * fold));

        return [
            clamp01(base[0] + md[0] + hi[0]),
            clamp01(base[1] + md[1] + hi[1]),
            clamp01(base[2] + md[2] + hi[2]),
        ];
    }

    // ---------------------------------------------------------------------
    // 8. GLSL — shader dùng cho preview
    // ---------------------------------------------------------------------
    //
    // ĐÂY LÀ BẢN CÀI ĐẶT THỨ HAI của cùng một phép toán (bản thứ nhất là các hàm JS ở
    // trên). Dự án này đã nhiều lần trả giá vì hai bản cài đặt lệch nhau, nên luật ở
    // đây là: **sửa một bên thì phải sửa bên kia VÀ chạy lại test đối chiếu**
    // (`retouch_shader_parity`) — test đó cho cùng một ảnh chạy qua cả hai đường rồi đo
    // chênh lệch từng pixel.
    //
    // THỨ TỰ CHUỖI (cố định, hai bên giống hệt): BIẾN DẠNG -> TÁCH TẦN SỐ -> MÀU CỤC BỘ.
    // Hình học trước (nó đổi chỗ pixel), rồi kết cấu, rồi màu — đảo thứ tự là ra kết quả
    // khác, vì cả ba đều phi tuyến.
    const MAX_WARP_CONTROLS = 24;

    // vUv TÍNH TỪ TRÊN XUỐNG (0 = mép trên ảnh), KHÔNG phải aPos*0.5+0.5.
    //
    // LỖI ĐÃ MẮC: gốc toạ độ framebuffer của WebGL ở DƯỚI-TRÁI, còn canvas (thứ mà
    // PIXI.Texture.from / drawImage đọc) thì hàng 0 ở TRÊN. Dùng `aPos*0.5+0.5` thì
    // fragment ở đáy framebuffer lấy hàng 0 của ảnh -> ẢNH RA LỘN NGƯỢC.
    // Phép đối chiếu GLSL<->JS KHÔNG bắt được lỗi này: nó đọc bằng readPixels (cũng
    // dưới-lên) nên hai bên dùng chung quy ước ngược và nó tự triệt tiêu. Chỉ chạy
    // end-to-end trên ảnh thật mới lộ. Bài học: đối chiếu công thức không thay được
    // chạy thật một lần.
    const RETOUCH_VERTEX_SRC = `
        attribute vec2 aPos;
        varying vec2 vUv;
        void main() {
            vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
            gl_Position = vec4(aPos, 0.0, 1.0);
        }`;

    const RETOUCH_FRAGMENT_SRC = `
        precision highp float;
        varying vec2 vUv;

        uniform sampler2D uSource;      // ảnh gốc, toạ độ KHUNG
        uniform sampler2D uLowFine;     // tầng mờ nhỏ, toạ độ CỤC BỘ (trong hộp mặt)
        uniform sampler2D uLowCoarse;   // tầng mờ lớn, toạ độ CỤC BỘ
        uniform sampler2D uMask0;       // R=da G=mắt B=răng A=quầng thâm, toạ độ CỤC BỘ
        uniform sampler2D uMask1;       // R=nếp cười
        uniform vec4 uBounds;           // hộp bao mặt: x0, y0, rộng, cao (toạ độ khung)
        uniform float uAspect;          // rộng/cao của khung

        uniform int   uWarpCount;
        uniform vec4  uCtrl[${MAX_WARP_CONTROLS}];    // x, y, dx, dy
        uniform float uCtrlR[${MAX_WARP_CONTROLS}];   // bán kính (đơn vị chiều cao)

        uniform float uSmooth, uBlemish, uClear, uDewrinkle, uSmileLines, uEven, uSparkly;
        uniform float uWhitening, uDarkCircles, uBrightEye, uWhiteTeeth;
        uniform vec3  uSkinTone;
        uniform float uSkinToneAmt;

        const float PI = 3.14159265358979;

        float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

        // Quy toạ độ KHUNG -> toạ độ trong HỘP BAO MẶT. Phải khớp sampleMasks() của JS.
        vec2 toLocal(vec2 uv) { return (uv - uBounds.xy) / uBounds.zw; }
        bool inBox(vec2 l) { return l.x >= 0.0 && l.x < 1.0 && l.y >= 0.0 && l.y < 1.0; }

        // --- BIẾN DẠNG: phải khớp displaceUv() ---
        // Khoảng cách đo trong KHÔNG GIAN PIXEL (nhân aspect vào trục x), và các điểm
        // chồng nhau lấy TRUNG BÌNH CÓ TRỌNG SỐ rồi nhân lại trọng số lớn nhất — cộng
        // dồn thẳng là gấp ảnh.
        vec2 displace(vec2 uv) {
            vec2 d = vec2(0.0);
            float wSum = 0.0;
            float wMax = 0.0;
            for (int i = 0; i < ${MAX_WARP_CONTROLS}; i++) {
                if (i >= uWarpCount) break;
                vec4 c = uCtrl[i];
                float r = uCtrlR[i];
                vec2 diff = vec2((uv.x - c.x) * uAspect, uv.y - c.y);
                float dist = length(diff);
                if (dist > r) continue;
                float t = dist / r;
                float w = pow(cos((PI / 2.0) * t), 2.0);
                d -= c.zw * w;
                wSum += w;
                wMax = max(wMax, w);
            }
            if (wSum > 1e-9) d = (d / wSum) * wMax;
            return uv + d;
        }

        void main() {
            vec2 srcUv = (uWarpCount > 0) ? displace(vUv) : vUv;
            vec3 c = texture2D(uSource, srcUv).rgb;
            vec2 lp = toLocal(vUv);

            if (inBox(lp)) {
                vec4 m0 = texture2D(uMask0, lp);
                float mSkin = m0.r, mEye = m0.g, mTeeth = m0.b, mUnder = m0.a;
                float mFold = texture2D(uMask1, lp).r;

                // ---- TÁCH TẦN SỐ (khớp applyFreqOps) ----
                vec3 lf = texture2D(uLowFine, lp).rgb;
                vec3 lc = texture2D(uLowCoarse, lp).rgb;
                vec3 high = c - lf;
                vec3 mid = lf - lc;
                vec3 base = lc;

                float even = (uEven / 100.0) * mSkin;
                if (even > 0.0) {
                    float y = luma(base);
                    base = clamp(mix(base, vec3(y) + (base - vec3(y)) * 0.35, even), 0.0, 1.0);
                }
                float sparkle = (uSparkly / 100.0) * mSkin;
                if (sparkle > 0.0) {
                    float y = luma(base);
                    float spec = max(0.0, y - 0.62) / 0.38;
                    base = clamp(base + sparkle * 0.30 * spec * (1.0 - base), 0.0, 1.0);
                }
                float sm = (uSmooth / 100.0) * mSkin;
                if (sm > 0.0) high *= (1.0 - 0.88 * sm);
                float bl = (uBlemish / 100.0) * mSkin;
                if (bl > 0.0) {
                    // BẤT ĐỐI XỨNG: chỉ hạ gai ÂM (đốm tối). step() thay cho if từng kênh.
                    vec3 neg = step(high, vec3(0.0));
                    high = mix(high, high * (1.0 - 0.92 * bl), neg);
                }
                float cl = (uClear / 100.0) * mSkin;
                if (cl > 0.0) high *= (1.0 + 0.85 * cl);
                float wr = (uDewrinkle / 100.0) * mSkin;
                if (wr > 0.0) mid *= (1.0 - 0.75 * wr);
                float fold = (uSmileLines / 100.0) * mFold;
                if (fold > 0.0) mid *= (1.0 - 0.80 * fold);
                c = clamp(base + mid + high, 0.0, 1.0);

                // ---- MÀU CỤC BỘ (khớp applyColorOps) ----
                float white = (uWhitening / 100.0) * mSkin;
                if (white > 0.0) {
                    vec3 lifted = pow(c, vec3(1.0 / (1.0 + 0.55 * white)));
                    float y = luma(lifted);
                    c = clamp(mix(lifted, vec3(y), 0.18 * white), 0.0, 1.0);
                }
                float dark = (uDarkCircles / 100.0) * mUnder;
                if (dark > 0.0) {
                    float boost = dark * 0.42 * (1.0 - luma(c));
                    c = clamp(c + boost * vec3(1.10, 0.95, 0.90), 0.0, 1.0);
                }
                float eye = (uBrightEye / 100.0) * mEye;
                if (eye > 0.0) {
                    c = clamp((c - 0.5) * (1.0 + 0.45 * eye) + 0.5 + 0.06 * eye, 0.0, 1.0);
                }
                float teeth = (uWhiteTeeth / 100.0) * mTeeth;
                if (teeth > 0.0) {
                    float y = luma(c);
                    c = clamp(mix(c, vec3(y), 0.65 * teeth), 0.0, 1.0);
                    c = clamp(c + 0.16 * teeth * (1.0 - c), 0.0, 1.0);
                }
                float tone = (uSkinToneAmt / 100.0) * mSkin;
                if (tone > 0.0) {
                    float y = luma(c);
                    float ty = max(1e-6, luma(uSkinTone));
                    vec3 scaled = clamp(uSkinTone * (y / ty), 0.0, 1.0);
                    c = clamp(mix(c, scaled, tone), 0.0, 1.0);
                }
            }
            gl_FragColor = vec4(c, 1.0);
        }`;

    /* Bộ uniform cho shader — dựng từ CÙNG dữ liệu mà đường JS dùng, để hai bên không
     * thể lệch vì đọc tham số khác nhau. */
    function shaderUniforms(raw, controls, raster, aspect) {
        const r = normalize(raw);
        const p = r.params;
        const ctrl = (controls || []).slice(0, MAX_WARP_CONTROLS);
        const tone = hexToRgb(r.skinTone);
        return {
            uAspect: Number(aspect) > 0 ? Number(aspect) : 1,
            uBounds: raster && raster.bounds
                ? [raster.bounds.x0, raster.bounds.y0, raster.bounds.width, raster.bounds.height]
                : [0, 0, 1, 1],
            uWarpCount: ctrl.length,
            uCtrl: ctrl.map((c) => [c.x, c.y, c.dx, c.dy]),
            uCtrlR: ctrl.map((c) => c.radius),
            uSmooth: p.smooth, uBlemish: p.clearBlemishes, uClear: p.clear,
            uDewrinkle: p.dewrinkle, uSmileLines: p.smileLines, uEven: p.even, uSparkly: p.sparkly,
            uWhitening: p.whitening, uDarkCircles: p.darkCircles,
            uBrightEye: p.brightEye, uWhiteTeeth: p.whiteTeeth,
            uSkinTone: tone || [0, 0, 0],
            uSkinToneAmt: tone ? r.skinToneAmount : 0,
        };
    }

    // ---------------------------------------------------------------------
    // 9. BỘ RENDER — đóng gói shader thành thứ dùng được
    // ---------------------------------------------------------------------
    //
    // Cùng khuôn với `ColorAdjust.CanvasColorRenderer`: sở hữu một canvas WebGL, nhận
    // drawable vào và trả canvas ra, để caller cắm vào đúng chỗ mà chuỗi chỉnh màu đang
    // cắm. KHÔNG tự đi tìm dữ liệu — landmark và tham số do caller đưa vào.
    //
    // CÁI ĐẮT NHẤT LÀ RASTER MẶT NẠ + LÀM MỜ (CPU). Chúng chỉ phụ thuộc LANDMARK,
    // không phụ thuộc tham số retouch — nên được CACHE theo landmark: kéo thanh trượt
    // thì chỉ chạy lại shader (rẻ), không dựng lại mặt nạ.
    //
    // KHI PHÁT thì cache không đỡ được (mặt đổi mỗi khung). Số đo trên nguồn 1728×3072,
    // Chrome, lưới 256 — xem tests/manual/retouch_perf.html:
    //     raster mặt nạ 20.5 · cắt vùng 0.1 · getImageData 0.9 · làm mờ 19.6
    //     · upload 1.0 · shader 0.2   => 43.2 ms/khung (23 fps)
    // Ba việc đã làm, theo thứ tự lời/rủi ro:
    //   1. `willReadFrequently:false` cho canvas nháp — bật cờ đó biến canvas thành
    //      canvas PHẦN MỀM, và khi đó `drawImage` từ video 1728×3072 tốn 11.4 ms thay
    //      vì 0.1 ms. Đọc ngược 256² chỉ tốn 0.9 ms nên đổi chác này lãi 10 ms.
    //   2. Bỏ hẳn mặt nạ + tầng mờ thô KHÔNG ai đọc (requiredMasks / needsCoarse) —
    //      phép rút gọn CHÍNH XÁC, không phải xấp xỉ.
    //   3. LƯỚI THẤP KHI ĐANG PHÁT (`setGrid`). Đo trên nguồn thật, lưới 128 so với
    //      256: lệch trung bình 0.22/255, 1.06% pixel lệch quá 2/255, lớn nhất 9.95/255
    //      và chỉ ở mép mặt nạ. Đổi lại raster + làm mờ rẻ đi 4 lần (43.2 -> 12.9 ms,
    //      77 fps). Nỗi lo cũ "hạ lưới thì khoét chân mày kém đi" ĐO RA LÀ KHÔNG:
    //      bán kính làm mượt vốn đã quy theo BỀ NGANG MẶT nên bất biến theo lưới —
    //      giá trị mặt nạ da tại giữa chân mày là 0.545 ở lưới 256 và 0.490 ở lưới 128.
    //      Lúc DỪNG thì quay lại 256, và khâu xuất luôn dùng 256.
    class RetouchRenderer {
        constructor(canvas, options = {}) {
            this.canvas = canvas || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
            this.gl = null;
            this.program = null;
            this.loc = {};
            this.tex = {};
            this.failed = false;
            this.faceKey = '';     // chữ ký landmark + lưới + nhu cầu -> cache mặt nạ + tầng mờ
            this.raster = null;
            this.radii = null;
            this.grid = clampGrid(options.grid);
            this._scratchGrid = 0;
            this._maskScratch = null;
            this._blurFine = null;
            this._blurCoarse = null;
            this._coarseUnit = 2;
        }

        /* Đổi độ phân giải lưới cục bộ (mặt nạ + tầng mờ). Đổi lưới thì mọi thứ đã
         * cache đều vô nghĩa -> xoá chữ ký để khung sau dựng lại. */
        setGrid(g) {
            const next = clampGrid(g);
            if (next === this.grid) return this.grid;
            this.grid = next;
            this.invalidateFace();
            return next;
        }

        _scratch() {
            const G = this.grid;
            if (this._scratchGrid !== G) {
                const n = G * G;
                this._maskScratch = { size: n, buf: new Float32Array(n), holeBuf: new Float32Array(n), tmp: new Float32Array(n) };
                const mk = () => ({ out: new Float32Array(n * 3), plane: new Float32Array(n), tmp: new Float32Array(n) });
                this._blurFine = mk();
                // Hai lượt làm mờ phải có HAI `out` riêng — dùng chung thì lượt sau ghi
                // đè lên kết quả lượt trước và `mid` hoá ra bằng 0.
                this._blurCoarse = mk();
                this._scratchGrid = G;
            }
            return this;
        }

        init() {
            if (this.gl || this.failed) return !!this.gl;
            const gl = this.canvas && (this.canvas.getContext('webgl', { premultipliedAlpha: false })
                || this.canvas.getContext('experimental-webgl'));
            if (!gl) { this.failed = true; return false; }
            const build = (type, src) => {
                const s = gl.createShader(type);
                gl.shaderSource(s, src);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                    this.failed = true;
                    // In ra để lỗi biên dịch shader không im lặng biến thành "không hiệu ứng".
                    if (typeof console !== 'undefined') console.error('[Retouch] shader:', gl.getShaderInfoLog(s));
                    return null;
                }
                return s;
            };
            const vs = build(gl.VERTEX_SHADER, RETOUCH_VERTEX_SRC);
            const fs = build(gl.FRAGMENT_SHADER, RETOUCH_FRAGMENT_SRC);
            if (!vs || !fs) { this.failed = true; return false; }
            const prog = gl.createProgram();
            gl.attachShader(prog, vs);
            gl.attachShader(prog, fs);
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                this.failed = true;
                if (typeof console !== 'undefined') console.error('[Retouch] link:', gl.getProgramInfoLog(prog));
                return false;
            }
            gl.useProgram(prog);
            const buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            // Một tam giác phủ toàn màn hình — rẻ hơn 2 tam giác, không có đường nối giữa.
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
            const aPos = gl.getAttribLocation(prog, 'aPos');
            gl.enableVertexAttribArray(aPos);
            gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
            this.gl = gl;
            this.program = prog;
            ['uSource', 'uLowFine', 'uLowCoarse', 'uMask0', 'uMask1', 'uBounds', 'uAspect',
             'uWarpCount', 'uCtrl', 'uCtrlR', 'uSmooth', 'uBlemish', 'uClear', 'uDewrinkle',
             'uSmileLines', 'uEven', 'uSparkly', 'uWhitening', 'uDarkCircles', 'uBrightEye',
             'uWhiteTeeth', 'uSkinTone', 'uSkinToneAmt'].forEach((n) => {
                this.loc[n] = gl.getUniformLocation(prog, n);
            });
            [0, 1, 2, 3, 4].forEach((unit) => {
                const t = gl.createTexture();
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, t);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                this.tex[unit] = t;
            });
            return true;
        }

        /* Dựng lại mặt nạ + hai tầng mờ khi LANDMARK đổi. Trả false nếu không dựng được.
         * `sourceCanvas` phải là ảnh nguồn đã vẽ sẵn (dùng để lấy mẫu vào lưới cục bộ). */
        /* Dựng hộp bao + mặt nạ cho bộ mặt hiện tại. Trả về hộp để caller biết phải cắt
         * vùng nào của ảnh nguồn ra lưới cục bộ. Tách làm 2 bước (`beginFace` rồi
         * `finishFace`) vì bước ở giữa — lấy mẫu ảnh vào lưới — làm bằng `drawImage`
         * cắt vùng thì NHANH HƠN HẲN vòng lặp JS 65k lần, mà đó là việc của caller
         * (nó mới biết drawable là video, canvas hay ảnh). */
        /* @param raw  bộ tham số retouch — quyết định mặt nạ nào PHẢI dựng. Truyền vào
         *             đây (chứ không phải chỉ ở `draw`) vì việc bỏ bớt nằm ở khâu
         *             raster; đổi tham số sang nhóm khác thì cache phải hỏng, nên nhu
         *             cầu mặt nạ nằm luôn trong chữ ký cache. */
        beginFace(faces, aspect, raw) {
            this._scratch();
            const need = raw ? requiredMasks(raw) : null;
            const needKey = need ? MASK_LAYOUT.map((l) => (need[l.name] ? '1' : '0')).join('') : 'all';
            const key = `${this.grid}:${needKey}:`
                + faces.map((f) => `${f[0][0].toFixed(4)},${f[0][1].toFixed(4)},${f.length}`).join('|');
            if (key === this.faceKey && this.raster) return { bounds: this.raster.bounds, cached: true };
            const raster = rasterizeMasks(faces, {
                aspect, size: this.grid, need, scratch: this._maskScratch,
            });
            if (!raster || !raster.bounds) { this.raster = null; this.faceKey = ''; return null; }
            this._pendingKey = key;
            this._pendingRaster = raster;
            this._pendingCoarse = raw ? needsCoarse(raw) : true;
            return { bounds: raster.bounds, cached: false };
        }

        /* @param localRgb Float32Array(grid²*3) — vùng hộp bao đã cắt về lưới cục bộ. */
        finishFace(faces, localRgb) {
            const raster = this._pendingRaster;
            if (!raster) return false;
            const G = this.grid;
            if (!localRgb || localRgb.length !== G * G * 3) return false;
            const rad = freqRadiiOnGrid(faces[0], raster.bounds, G);
            this.raster = raster;
            this.radii = rad;
            this.lowFine = blurRgbBoxCascade(localRgb, G, G, rad.fine, this._blurFine);
            // Tầng thô triệt tiêu -> KHÔNG tính, và shader lấy luôn texture của tầng mịn
            // (xem needsCoarse). Đây là phép rút gọn chính xác, không phải xấp xỉ.
            this.hasCoarse = this._pendingCoarse !== false;
            this.lowCoarse = this.hasCoarse
                ? blurRgbBoxCascade(localRgb, G, G, rad.coarse, this._blurCoarse)
                : this.lowFine;
            this.faceKey = this._pendingKey || '';
            this._pendingRaster = null;
            return true;
        }

        invalidateFace() { this.faceKey = ''; this._lfKey = ''; }

        /* Vẽ MỘT khung. Trả về canvas kết quả, hoặc null nếu không chạy được (caller
         * phải rơi về ảnh gốc chứ không được hiện khung đen). */
        draw(drawable, texW, texH, faces, raw, aspect) {
            if (!this.init() || !faces || !faces.length) return null;
            const r = normalize(raw);
            if (isIdentity(r)) return null;
            const gl = this.gl;
            if (this.canvas.width !== texW || this.canvas.height !== texH) {
                this.canvas.width = texW;
                this.canvas.height = texH;
            }
            if (!this.raster) return null;
            const G = this.grid;
            const toRGBA = (f, n) => {
                const a = new Uint8ClampedArray(n * 4);
                for (let i = 0; i < n; i++) {
                    a[i * 4] = f[i * 3] * 255;
                    a[i * 4 + 1] = f[i * 3 + 1] * 255;
                    a[i * 4 + 2] = f[i * 3 + 2] * 255;
                    a[i * 4 + 3] = 255;
                }
                return a;
            };
            const up = (unit, data, w, h) => {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, this.tex[unit]);
                if (data instanceof Uint8ClampedArray || data instanceof Uint8Array) {
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                        data instanceof Uint8ClampedArray ? new Uint8Array(data.buffer) : data);
                } else {
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
                }
            };
            gl.useProgram(this.program);
            up(0, drawable);
            if (this._lfKey !== this.faceKey) {
                up(1, toRGBA(this.lowFine, G * G), G, G);
                // Tầng thô triệt tiêu -> KHÔNG upload texture thứ hai, chỉ trỏ sampler
                // uLowCoarse về đúng đơn vị của tầng mịn.
                this._coarseUnit = this.hasCoarse === false ? 1 : 2;
                if (this._coarseUnit === 2) up(2, toRGBA(this.lowCoarse, G * G), G, G);
                up(3, this.raster.textures[0], this.raster.width, this.raster.height);
                up(4, this.raster.textures[1], this.raster.width, this.raster.height);
                this._lfKey = this.faceKey;
            }
            const U = shaderUniforms(r, warpControlPoints(faces[0], r.params, aspect), this.raster, aspect);
            gl.uniform1i(this.loc.uSource, 0);
            gl.uniform1i(this.loc.uLowFine, 1);
            gl.uniform1i(this.loc.uLowCoarse, this._coarseUnit);
            gl.uniform1i(this.loc.uMask0, 3);
            gl.uniform1i(this.loc.uMask1, 4);
            gl.uniform4fv(this.loc.uBounds, new Float32Array(U.uBounds));
            gl.uniform1f(this.loc.uAspect, U.uAspect);
            gl.uniform1i(this.loc.uWarpCount, U.uWarpCount);
            const flat = new Float32Array(MAX_WARP_CONTROLS * 4);
            U.uCtrl.forEach((c, i) => flat.set(c, i * 4));
            gl.uniform4fv(this.loc.uCtrl, flat);
            const rr = new Float32Array(MAX_WARP_CONTROLS);
            U.uCtrlR.forEach((v, i) => { rr[i] = v; });
            gl.uniform1fv(this.loc.uCtrlR, rr);
            ['uSmooth', 'uBlemish', 'uClear', 'uDewrinkle', 'uSmileLines', 'uEven', 'uSparkly',
             'uWhitening', 'uDarkCircles', 'uBrightEye', 'uWhiteTeeth', 'uSkinToneAmt']
                .forEach((k) => gl.uniform1f(this.loc[k], U[k]));
            gl.uniform3fv(this.loc.uSkinTone, new Float32Array(U.uSkinTone));
            gl.viewport(0, 0, texW, texH);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            return this.canvas;
        }

        destroy() {
            const gl = this.gl;
            if (!gl) return;
            Object.values(this.tex).forEach((t) => { try { gl.deleteTexture(t); } catch (_) {} });
            try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {}
            this.gl = null;
        }
    }

    return {
        RetouchRenderer,
        RETOUCH_VERTEX_SRC, RETOUCH_FRAGMENT_SRC, MAX_WARP_CONTROLS, shaderUniforms,
        FREQ_GRID, FREQ_GRID_PLAYING, clampGrid, freqRadiiOnGrid, blurRgbBoxCascade,
        MASK_USERS, COARSE_USERS, requiredMasks, needsCoarse,
        LANDMARK_COUNT, REGIONS, POINTS, PARAMS, PARAM_KEYS,
        MASK_CHANNELS, MASK_LAYOUT, MASK_TEXTURES, MASK_BLUR_CASCADE, MASK_FEATHER_FRAC,
        EYE_LOWER, maskPolygons, underEyePolygon,
        HOLE_FEATHER_SCALE, MASK_GRID, MASK_BOUNDS_PAD,
        fillPolygonsEvenOdd, featherMask, rasterizeMasks, polygonsForMask, shapeForMask, sampleMasks,
        applyColorOps, hexToRgb, lumaOf: luma,
        FREQ_FINE_FRAC, FREQ_COARSE_FRAC, freqRadii, nasolabialPolygon, applyFreqOps,
        FACELIFT_MAX, PLUMP_MAX, JAW_RADIUS, CHEEK_RADIUS,
        JAW_LEFT, JAW_RIGHT, CHEEK_LEFT, CHEEK_RIGHT,
        defaultRetouch, defaultParams, normalize, isIdentity,
        pointAt, regionPolygon, faceBounds: boundsWithSize, selectFaces, faceScale, touchedBounds,
        warpControlPoints, displaceUv, warpMaxGradient,
    };
});
