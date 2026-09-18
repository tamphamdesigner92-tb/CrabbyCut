/* Sinh bộ LUT DỰNG SẴN (.cube) cho subtab "LUT" của panel Điều chỉnh.
 *
 * VÌ SAO SINH BẰNG SCRIPT THAY VÌ COMMIT FILE .cube "từ đâu đó": file .cube là mấy
 * nghìn dòng số — nhìn vào không biết nó làm gì, sửa cũng không dám. Ở đây mỗi preset
 * là MỘT HÀM vài dòng, đọc là hiểu, muốn chỉnh thì sửa hàm rồi chạy lại:
 *
 *     node scripts/generate_preset_luts.js
 *
 * Kích thước lưới 17³ (không phải 33³): file chỉ ~130KB thay vì ~930KB.
 *
 * SAI SỐ NỘI SUY THỰC ĐO (lưới thử lệch pha 1/64 để rơi vào GIỮA ô — chỗ tệ nhất):
 * trung bình ≤ 0.08/255, ĐỈNH 2.8–4.8/255 tuỳ preset. Chú thích cũ ghi "< 1/255" là
 * SAI, và sai với cả bộ preset gốc (teal_orange 3.5, cool_blue 3.5, punch 3.1) chứ
 * không riêng nhóm mới. Vẫn giữ 17³ vì:
 *   - preview và export đọc CÙNG một file .cube, nên sai số này KHÔNG phá WYSIWYG —
 *     nó chỉ là lệch so với hàm lý tưởng, thứ người dùng không có gì để đối chiếu;
 *   - đỉnh sai số nằm ở vài điểm rời rạc, trung bình thấp hơn hai bậc.
 * Nếu sau này thêm preset có bước NHẢY theo màu (không chỉ gãy khúc) thì phải nâng
 * SIZE, vì lúc đó sai số sẽ không còn cục bộ nữa.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'library', 'luts');
const SIZE = 17;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Đường cong chữ S mềm quanh 0.5 — dùng chung cho các preset cần "đằm" hơn.
function sCurve(v, amount) {
    return clamp01(lerp(v, v * v * (3 - 2 * v), amount));
}

// Trộn màu theo vùng sáng: shadow (tối) và highlight (sáng) được nhuộm khác nhau.
function splitTone(rgb, shadowTint, highlightTint, strength) {
    const y = luma(rgb[0], rgb[1], rgb[2]);
    return rgb.map((v, i) => clamp01(
        v + strength * ((1 - y) * shadowTint[i] + y * highlightTint[i]),
    ));
}

// NHUỘM MÀU CÓ TÔN TRỌNG TRẦN — bản "mềm" của splitTone, dùng cho nhóm tươi sáng
// và nhóm dịu. Giữ cho vùng gần trắng không bị MỘT kênh chạm 1.0 trước các kênh
// khác: "Nắng ấm" bản đầu làm kênh đỏ của bảng trắng (0.93) kẹp trần và đẩy bão hoà
// +12.6% — bảng trắng thành mảng cam bệt, đúng cái tệ nhất cho video giáo dục.
//
// CHẶN CHÁY Ở VÙNG CỰC SÁNG mà KHÔNG giết lượng nhuộm ở phần còn lại.
//
// Bản đầu nhân thẳng với headroom (1−v). SAI, và sai nặng: look "dịu" đẩy phần lớn
// ảnh lên vùng sáng (v ≈ 0.55–0.85), ở đó (1−v) chỉ còn 0.15–0.45 nên tint co lại
// gần hết. Đo được: 10 preset nhóm dịu chỉ khác nhau 0.62–3.05/255 — vô hình, đúng
// như người dùng báo "khác mỗi cái tên".
// Nay giữ NGUYÊN lượng nhuộm tới 0.82 rồi mới cuộn về 0 ở 1.0: vẫn không kênh nào
// chạm trần trước kênh khác, mà look thì còn nguyên.
const headroomGuard = (v) => (v <= 0.82 ? 1 : Math.max(0, (1 - v) / 0.18));

function splitToneSoft(rgb, shadowTint, highlightTint, strength) {
    const y = luma(rgb[0], rgb[1], rgb[2]);
    return rgb.map((v, i) => {
        const d = strength * ((1 - y) * shadowTint[i] + y * highlightTint[i]);
        return clamp01(v + (d > 0 ? d * headroomGuard(v) : d * Math.min(1, v / 0.18)));
    });
}

// NÂNG SÁNG BẰNG GAMMA, KHÔNG BẰNG PHÉP NHÂN. Nhân thì vùng sáng đụng trần 1.0 và
// cháy ngay (mây, áo trắng, bảng trắng — thứ đầy rẫy trong video giáo dục); gamma
// kéo vùng trung gian lên mà vẫn giữ nguyên trần, nên ảnh sáng lên mà không mất
// chi tiết vùng sáng. g > 1 = sáng hơn.
const gammaUp = (v, g) => clamp01(Math.pow(clamp01(v), 1 / g));

// Nâng đáy đen — mở bóng cho look thoáng ("airy"). Khác `vintage_fade` ở chỗ đây
// nâng ít và không rút bão hoà, nên trông sạch chứ không bạc màu.
const liftBlacks = (v, amount) => clamp01(amount + v * (1 - amount));

// VIBRANCE — KHÁC saturation: màu đang nhạt được tăng nhiều, màu đã đậm tăng ít.
// Đây là lý do mọi preset "tươi" bên dưới dùng vibrance thay vì đẩy saturation
// thẳng: da người vốn đã bão hoà sẵn, đẩy saturation đều tay là mặt đỏ rực — đúng
// cái làm hỏng những look "tươi sáng" làm ẩu.
function vibrance(rgb, amount) {
    const y = luma(rgb[0], rgb[1], rgb[2]);
    const sat = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
    const k = 1 + amount * (1 - sat);
    return rgb.map((v) => clamp01(y + (v - y) * k));
}

// NÉN DẢI TƯƠNG PHẢN quanh trung tính — ngược với sCurve. Đây là thứ tạo ra cảm
// giác "dịu": ảnh vẫn sáng nhưng không có mảng đen sâu hay mảng trắng gắt.
const flatten = (v, amount) => clamp01(lerp(v, 0.5 + (v - 0.5) * 0.78, amount));

// Kéo màu về phía độ sáng = giảm bão hoà đều.
function desaturate(rgb, amount) {
    const y = luma(rgb[0], rgb[1], rgb[2]);
    return rgb.map((v) => clamp01(lerp(v, y, amount)));
}

// GIẢM BÃO HOÀ NHƯNG CHỪA DA NGƯỜI.
//
// Vì sao cần: các look lạnh/bệt của nhóm dịu phải rút bão hoà khá mạnh (0.22–0.36)
// mới ra được chất riêng, nhưng đo trên 3 tông da thì chúng rút mất 15–18% bão hoà
// của MẶT NGƯỜI -> mặt xám bệch. Với video nói trước máy (đúng loại footage nhóm này
// nhắm tới) thì đó là hỏng hẳn, không phải "phong cách".
//
// `w` = mức "giống da": chỉ bật khi đỏ > lục > lam (thứ tự kênh đặc trưng của da).
// Trời (lam trội) và cây (lục trội) cho w = 0 nên vẫn được rút bão hoà đầy đủ —
// tức look vẫn giữ nguyên cá tính ở mọi chỗ TRỪ da người.
function desaturateKeepSkin(rgb, amount, keep = 0.78) {
    const y = luma(rgb[0], rgb[1], rgb[2]);
    const w = clamp01((rgb[0] - rgb[1]) * 5) * clamp01((rgb[1] - rgb[2]) * 6);
    const a = amount * (1 - keep * w);
    return rgb.map((v) => clamp01(lerp(v, y, a)));
}

// NỀN CHUNG của nhóm dịu: sáng lên bằng gamma, mở bóng, nén tương phản.
// Gom lại một chỗ để 10 preset dưới đây có CÙNG "chất" — khác nhau ở phần nhuộm
// màu chứ không phải ở độ sáng, nhờ vậy đổi qua lại giữa chúng không bị giật sáng.
const softBase = (v, { gamma = 1.18, lift = 0.045, flat = 0.55 } = {}) =>
    flatten(liftBlacks(gammaUp(v, gamma), lift), flat);

// ÁP ĐƯỜNG CONG TÔNG THEO ĐỘ CHÓI, GIỮ NGUYÊN SẮC — thay cho việc bẻ từng kênh RGB.
//
// LỖI GỐC của bản đầu (đo ra mới thấy, đoán hai lần đều trượt): `softBase` áp riêng
// lên từng kênh, mà nén tương phản thì nén luôn KHOẢNG CÁCH GIỮA CÁC KÊNH = mất bão
// hoà. Đo trên da người: 27.0 -> 19.6 điểm bão hoà CHỈ do bước này, trước cả bước
// giảm bão hoà cố ý. Đó là lý do mặt người trong mọi look dịu bị xám bệch, và cũng
// góp phần làm 10 preset trông giống nhau (cái gì cũng bị kéo về xám).
//
// Cách đúng: tính độ chói -> chạy đường cong TRÊN ĐỘ CHÓI -> dịch cả 3 kênh theo
// cùng một lượng. Khoảng cách giữa các kênh (tức bão hoà) được giữ NGUYÊN VẸN, việc
// giảm bão hoà bao nhiêu là do `desaturateKeepSkin` quyết định — mỗi thứ một việc.
function softTone(rgb, opts) {
    const y = luma(rgb[0], rgb[1], rgb[2]);
    const y2 = softBase(y, opts);
    return rgb.map((v) => clamp01(y2 + (v - y)));
}

const PRESETS = [
    // ----- NHÓM DỊU NHẸ (trắng sáng, trong trẻo, tương phản thấp) -----
    // Nhóm được ưu tiên: sáng và sạch nhưng KHÔNG rực, KHÔNG tương phản mạnh.
    //
    // CÁI TẠO RA CÁ TÍNH RIÊNG là TÁCH TÔNG NGƯỢC HƯỚNG (bóng một sắc, vùng sáng sắc
    // đối lập) — đúng cách các look phim phân biệt nhau. Bản đầu chỉ nhuộm cùng một
    // hướng với biên độ 0.004–0.046 nên 10 preset chỉ khác nhau 0.62–3.05/255, tức
    // "khác mỗi cái tên" (người dùng báo, đo lại đúng vậy). Nay biên độ 0.05–0.16 và
    // hai đầu ngược hướng.
    //
    // RÀNG BUỘC PHẢI GIỮ (nếu không là hỏng chất "dịu"): tất cả vẫn đi qua `softBase`
    // (sáng bằng gamma + mở bóng + nén tương phản) và vẫn giảm bão hoà. Khác biệt nằm
    // ở SẮC ĐỘ và độ bệt, KHÔNG ở độ tương phản.
    {
        id: 'soft_milk',
        name: 'Sữa',
        cat: 'soft',
        fn: (r, g, b) => {
            // Kem trung tính: vàng chứ KHÔNG đỏ — đây là chỗ phân biệt với "Đào nhạt"
            // (kênh đỏ thấp hơn, kênh lục cao hơn). Bản đầu hai cái chỉ khác 3.96/255.
            let rgb = softTone([r, g, b], { gamma: 1.15, lift: 0.058, flat: 0.60 });
            rgb = desaturateKeepSkin(rgb, 0.15);
            return splitToneSoft(rgb, [0.045, 0.048, -0.012], [0.072, 0.080, 0.004], 1);
        },
    },
    {
        id: 'porcelain',
        name: 'Sứ',
        cat: 'soft',
        fn: (r, g, b) => {
            // Sạch lạnh: bóng xanh lam rõ, vùng sáng trắng hơi lam — da người mịn.
            let rgb = softTone([r, g, b], { gamma: 1.25, lift: 0.035, flat: 0.50 });
            rgb = desaturateKeepSkin(rgb, 0.13);
            return splitToneSoft(rgb, [-0.052, 0.004, 0.104], [0.016, 0.020, 0.022], 1);
        },
    },
    {
        id: 'clean_daylight',
        name: 'Ánh ngày',
        cat: 'soft',
        fn: (r, g, b) => {
            // SÁNG NHẤT nhóm và gần như không nhuộm — nó phân biệt bằng ĐỘ SÁNG,
            // không bằng sắc độ. Giữ bão hoà gần nguyên để màu vẫn trung thực.
            let rgb = softTone([r, g, b], { gamma: 1.40, lift: 0.026, flat: 0.40 });
            rgb = desaturateKeepSkin(rgb, 0.04);
            return splitToneSoft(rgb, [0.000, 0.006, 0.016], [0.010, 0.014, 0.016], 1);
        },
    },
    {
        id: 'soft_peach',
        name: 'Đào nhạt',
        cat: 'soft',
        fn: (r, g, b) => {
            // Đào: bóng nâu đỏ, vùng sáng cam đào rõ rệt.
            let rgb = softTone([r, g, b], { gamma: 1.18, lift: 0.048, flat: 0.56 });
            rgb = desaturateKeepSkin(rgb, 0.14);
            return splitToneSoft(rgb, [0.075, 0.020, -0.020], [0.115, 0.055, -0.005], 1);
        },
    },
    {
        id: 'blush',
        name: 'Ửng hồng',
        cat: 'soft',
        fn: (r, g, b) => {
            // Hồng phấn: bóng ngả mận/tím, vùng sáng hồng — khác Đào ở kênh LAM.
            let rgb = softTone([r, g, b], { gamma: 1.17, lift: 0.052, flat: 0.60 });
            rgb = desaturateKeepSkin(rgb, 0.17);
            return splitToneSoft(rgb, [0.060, -0.005, 0.055], [0.105, 0.030, 0.070], 1);
        },
    },
    {
        id: 'misty_blue',
        name: 'Sương lam',
        cat: 'soft',
        fn: (r, g, b) => {
            // Lam sương: lạnh ĐỀU cả hai đầu, bão hoà thấp — cảm giác mờ sương.
            let rgb = softTone([r, g, b], { gamma: 1.22, lift: 0.092, flat: 0.74 });
            rgb = desaturateKeepSkin(rgb, 0.06);
            return splitToneSoft(rgb, [-0.062, 0.000, 0.128], [0.006, 0.014, 0.026], 1);
        },
    },
    {
        id: 'mint_air',
        name: 'Bạc hà',
        cat: 'soft',
        fn: (r, g, b) => {
            // Bạc hà: bóng xanh mòng két, vùng sáng lục nhạt — khác Sương lam ở kênh LỤC.
            let rgb = softTone([r, g, b], { gamma: 1.20, lift: 0.045, flat: 0.55 });
            rgb = desaturateKeepSkin(rgb, 0.15);
            return splitToneSoft(rgb, [-0.075, 0.080, 0.040], [-0.006, 0.040, 0.018], 1);
        },
    },
    {
        id: 'honey_light',
        name: 'Mật nhạt',
        cat: 'soft',
        fn: (r, g, b) => {
            // Mật ong: ẤM NHẤT và giữ màu nhiều nhất nhóm, vùng sáng vàng kim.
            let rgb = softTone([r, g, b], { gamma: 1.16, lift: 0.040, flat: 0.48 });
            rgb = desaturateKeepSkin(rgb, 0.14);
            return splitToneSoft(rgb, [0.052, 0.034, -0.030], [0.100, 0.082, -0.034], 1);
        },
    },
    {
        id: 'linen',
        name: 'Vải lanh',
        cat: 'soft',
        fn: (r, g, b) => {
            // Matte: bóng nâng CAO NHẤT (bệt kiểu phim), be xám, bão hoà rất thấp.
            let rgb = softTone([r, g, b], { gamma: 1.13, lift: 0.100, flat: 0.72 });
            rgb = desaturateKeepSkin(rgb, 0.32);
            return splitToneSoft(rgb, [0.055, 0.040, 0.015], [0.070, 0.058, 0.030], 1);
        },
    },
    {
        id: 'overcast',
        name: 'Trời râm',
        cat: 'soft',
        fn: (r, g, b) => {
            // Trời râm: xám lục lạnh, PHẲNG NHẤT — khác Sương lam ở chỗ không ngả lam
            // mà ngả lục-xám, và khác Vải lanh ở chỗ lạnh chứ không ấm.
            let rgb = softTone([r, g, b], { gamma: 1.15, lift: 0.065, flat: 0.78 });
            rgb = desaturateKeepSkin(rgb, 0.19);
            return splitToneSoft(rgb, [-0.046, 0.052, 0.068], [0.014, 0.022, 0.014], 1);
        },
    },
    // ----- NHÓM TƯƠI SÁNG (nội dung tích cực, giáo dục, hướng dẫn) -----
    // Đặt LÊN ĐẦU danh sách vì đây là nhóm được dùng nhiều nhất cho loại nội dung đó;
    // thứ tự trong presets.json chính là thứ tự ô chọn. Đổi thứ tự AN TOÀN vì dự án
    // tham chiếu preset theo `id`, không theo chỉ số.
    {
        id: 'bright_clean',
        name: 'Tươi sáng',
        cat: 'bright',
        fn: (r, g, b) => {
            // Look "mặc định" của nhóm: sáng, sạch, màu trung thực. Hợp giảng bài,
            // review, nói trước máy — chỗ mà màu KHÔNG nên gây chú ý.
            let rgb = [r, g, b].map((v) => gammaUp(v, 1.20));
            rgb = rgb.map((v) => sCurve(v, 0.12));   // tương phản nhẹ, cố ý không nghiến đen
            rgb = vibrance(rgb, 0.20);
            return splitToneSoft(rgb, [0.0, 0.005, 0.015], [0.02, 0.015, 0.0], 1);
        },
    },
    {
        id: 'sunny_warm',
        name: 'Nắng ấm',
        cat: 'bright',
        fn: (r, g, b) => {
            // Ánh nắng: vùng sáng ngả vàng-cam, bóng vẫn trong. Hợp cảnh ngoài trời,
            // gia đình, trẻ em.
            let rgb = [r, g, b].map((v) => gammaUp(v, 1.16));
            // Kéo lam xuống VỪA PHẢI (0.975, không phải 0.96): phần lớn cảm giác "ấm"
            // đã nằm ở tint vùng sáng bên dưới, hạ lam mạnh nữa thì bảng trắng/áo
            // trắng ngả cam thấy rõ — đo được +9.9% bão hoà trên trắng 0.93 ở bản trước.
            rgb = [clamp01(rgb[0] * 1.03 + 0.004), clamp01(rgb[1] * 1.01 + 0.004), clamp01(rgb[2] * 0.975)];
            rgb = vibrance(rgb, 0.16);
            return splitToneSoft(rgb, [0.02, 0.008, -0.008], [0.05, 0.03, -0.012], 1);
        },
    },
    {
        id: 'vivid_pop',
        name: 'Rực rỡ',
        cat: 'bright',
        fn: (r, g, b) => {
            // Năng lượng cao: màu bật hẳn. Hợp nội dung thiếu nhi, quảng cáo ngắn,
            // đồ hoạ nhiều mảng màu phẳng.
            let rgb = [r, g, b].map((v) => gammaUp(v, 1.10));
            rgb = vibrance(rgb, 0.45);
            return rgb.map((v) => sCurve(v, 0.26));
        },
    },
    {
        id: 'pastel_soft',
        name: 'Pastel dịu',
        cat: 'bright',
        fn: (r, g, b) => {
            // Sáng nhưng ÊM: đáy đen nâng nhẹ, bão hoà kéo bớt. Hợp nội dung nhẹ
            // nhàng, sức khoẻ tinh thần, kể chuyện.
            let rgb = [r, g, b].map((v) => liftBlacks(gammaUp(v, 1.14), 0.055));
            const y = luma(rgb[0], rgb[1], rgb[2]);
            rgb = rgb.map((v) => clamp01(lerp(v, y, 0.12)));
            rgb = vibrance(rgb, 0.10);
            return splitToneSoft(rgb, [0.015, 0.005, 0.02], [0.03, 0.02, 0.01], 1);
        },
    },
    {
        id: 'fresh_nature',
        name: 'Xanh tươi',
        cat: 'bright',
        fn: (r, g, b) => {
            // Đẩy CÓ CHỌN LỌC vùng lục trội (cây cỏ, bảng xanh, sân bóng). Trọng số
            // `w` bằng 0 khi đỏ trội, nên DA NGƯỜI không dính — đẩy lục đều tay là
            // mặt người ngả xanh, lỗi kinh điển của look "thiên nhiên".
            let rgb = [r, g, b].map((v) => gammaUp(v, 1.15));
            const w = clamp01((rgb[1] - Math.max(rgb[0], rgb[2])) * 3);
            rgb = [rgb[0], clamp01(rgb[1] + 0.06 * w * (1 - rgb[1])), rgb[2]];
            rgb = vibrance(rgb, 0.22);
            return splitToneSoft(rgb, [-0.01, 0.01, 0.015], [0.01, 0.02, 0.0], 1);
        },
    },
    {
        id: 'airy_white',
        name: 'Trong trẻo',
        cat: 'bright',
        fn: (r, g, b) => {
            // High-key: sáng nhất nhóm, tương phản thấp. Hợp quay bảng trắng, thao
            // tác màn hình, nền trắng — chỗ cần chữ nổi rõ mà không chói.
            let rgb = [r, g, b].map((v) => liftBlacks(gammaUp(v, 1.30), 0.04));
            rgb = rgb.map((v) => sCurve(v, 0.06));
            rgb = vibrance(rgb, 0.12);
            return splitToneSoft(rgb, [0.0, 0.005, 0.02], [0.005, 0.01, 0.02], 1);
        },
    },
    // ----- NHÓM ĐIỆN ẢNH / PHONG CÁCH -----
    {
        id: 'teal_orange',
        name: 'Teal & Orange',
        cat: 'cine',
        fn: (r, g, b) => {
            let rgb = [sCurve(r, 0.35), sCurve(g, 0.3), sCurve(b, 0.3)];
            // vùng tối ngả lam-lục, vùng sáng ngả cam — công thức "look" điện ảnh quen thuộc
            rgb = splitTone(rgb, [-0.05, 0.02, 0.10], [0.08, 0.02, -0.07], 1);
            return rgb;
        },
    },
    {
        id: 'warm_film',
        name: 'Phim ấm',
        cat: 'cine',
        fn: (r, g, b) => {
            let rgb = [clamp01(r * 1.06 + 0.012), clamp01(g * 1.01), clamp01(b * 0.94)];
            rgb = [sCurve(rgb[0], 0.18), sCurve(rgb[1], 0.18), sCurve(rgb[2], 0.18)];
            return splitTone(rgb, [0.03, 0.01, -0.01], [0.04, 0.02, -0.03], 1);
        },
    },
    {
        id: 'cool_blue',
        name: 'Lạnh xanh',
        cat: 'cine',
        fn: (r, g, b) => {
            const rgb = [clamp01(r * 0.94), clamp01(g * 0.99), clamp01(b * 1.08 + 0.01)];
            return splitTone(rgb, [-0.02, 0.0, 0.05], [-0.03, 0.0, 0.04], 1);
        },
    },
    {
        id: 'vintage_fade',
        name: 'Hoài cổ (fade)',
        cat: 'cine',
        fn: (r, g, b) => {
            // "fade": nâng đáy đen lên -> mất đen tuyệt đối, giống phim cũ đã bạc màu
            const lift = 0.075;
            const rgb = [r, g, b].map((v) => clamp01(lift + v * (1 - lift) * 0.95));
            const y = luma(rgb[0], rgb[1], rgb[2]);
            // giảm bão hoà nhẹ bằng cách kéo về phía độ sáng
            return rgb.map((v, i) => clamp01(lerp(v, y, 0.18) + [0.02, 0.005, -0.015][i]));
        },
    },
    {
        id: 'mono_classic',
        name: 'Đen trắng',
        cat: 'mono',
        fn: (r, g, b) => {
            const y = sCurve(luma(r, g, b), 0.25);
            return [y, y, y];
        },
    },
    {
        id: 'punch',
        name: 'Đậm nét (punch)',
        cat: 'cine',
        fn: (r, g, b) => {
            const y = luma(r, g, b);
            // tăng bão hoà = đẩy ra xa độ sáng, kèm chữ S mạnh cho tương phản
            const sat = 1.25;
            return [r, g, b].map((v) => sCurve(clamp01(y + (v - y) * sat), 0.4));
        },
    },
];

function cubeText(preset) {
    const lines = [
        `# CrabbyCut preset LUT — sinh bởi scripts/generate_preset_luts.js`,
        `TITLE "${preset.name}"`,
        `LUT_3D_SIZE ${SIZE}`,
        '',
    ];
    // Thứ tự bắt buộc của .cube: R chạy nhanh nhất, rồi G, rồi B.
    for (let bi = 0; bi < SIZE; bi += 1) {
        for (let gi = 0; gi < SIZE; gi += 1) {
            for (let ri = 0; ri < SIZE; ri += 1) {
                const out = preset.fn(ri / (SIZE - 1), gi / (SIZE - 1), bi / (SIZE - 1));
                lines.push(out.map((v) => clamp01(v).toFixed(6)).join(' '));
            }
        }
    }
    return lines.join('\n') + '\n';
}

function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    PRESETS.forEach((preset) => {
        const file = path.join(OUT_DIR, `${preset.id}.cube`);
        fs.writeFileSync(file, cubeText(preset));
        const kb = (fs.statSync(file).size / 1024).toFixed(0);
        console.log(`  ${preset.id.padEnd(16)} ${preset.name.padEnd(18)} ${kb} KB`);
    });
    // Manifest để backend biết TÊN HIỂN THỊ (tên file thì không mang dấu tiếng Việt).
    const manifest = PRESETS.map((p) => ({ id: p.id, name: p.name, cat: p.cat || 'cine', file: `${p.id}.cube` }));
    fs.writeFileSync(path.join(OUT_DIR, 'presets.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Đã sinh ${PRESETS.length} LUT vào library/luts/`);
}

main();
