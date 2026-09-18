/* =============================================================================
 * TEXT TEMPLATE ENGINE — "Mẫu văn bản" (tương đương Text template của CapCut)
 *
 * VÌ SAO CẦN MODULE RIÊNG, KHÔNG DÙNG ĐƯỢC TEXTBOX + HOẠT ẢNH SẴN CÓ
 * -------------------------------------------------------------------
 * Một text template của CapCut KHÔNG phải một textbox có style đẹp. Nó là một
 * CẢNH NHỎ nhiều lớp:
 *   · 1..n lớp CHỮ (ô nhập được — CapCut gọi là "Text 1", "Text 2"…),
 *   · 0..n lớp TRANG TRÍ (dấu tích, hoa, nháy kép, tia sáng, thanh màu…),
 *   · mỗi lớp có ĐƯỜNG THỜI GIAN RIÊNG (lệch pha nhau, có lớp lặp vô hạn),
 *   · cả nhóm dùng CHUNG một block trên timeline: kéo/xoay/phóng là đi cả bộ.
 * Engine hoạt ảnh sẵn có (static/js/text-animations.js) áp MỘT trạng thái cho
 * MỘT item, nên không diễn đạt được "chữ zoom vào trong 0.5s còn dấu tích nảy
 * lặp mỗi 0.8s". Vì vậy template có engine riêng ở đây.
 *
 * NGUYÊN TẮC GIỮ NGUYÊN TỪ PHẦN TEXT CŨ
 * -------------------------------------
 *  1. MỘT hàm vẽ duy nhất (drawFrame) phục vụ CẢ preview lẫn export. Preview là
 *     <canvas> vẽ lại theo thời gian, export là chuỗi PNG bake từ CÙNG hàm đó —
 *     không có đường thứ hai để hai bên lệch nhau (xem chú thích ở đầu
 *     text-animations.js: cùng lý do, cùng cách).
 *  2. Mọi số đo VIẾT Ở LỚP 1080 (cạnh ngắn tham chiếu) rồi nhân hệ số `k` do
 *     caller truyền vào — đúng quy ước scaledTextPx()/sequenceTextScale() của
 *     editing-runtime.js. Nhờ vậy một template nhìn y hệt nhau ở 1080 dọc,
 *     1080 ngang và 4K.
 *  3. Module THUẦN: không đụng DOM, không đọc state của app. Chỉ nhận
 *     (template, texts, thời gian, hệ số) và một 2D context để đo/vẽ.
 *
 * SỐ ĐO Ở ĐÂU RA
 * --------------
 * Từng template được ĐO LẠI TỪNG PIXEL trên video mẫu CapCut (30fps, 1080×1920)
 * do người dùng cung cấp: hộp mực của chữ, tâm/bán kính hình trang trí, màu lấy
 * từ histogram, và đường cong hoạt ảnh dựng lại bằng cách bám vị trí một nét
 * chữ qua từng khung. Con số cụ thể ghi ngay tại chỗ khai báo từng template.
 *
 * MÔ HÌNH DỮ LIỆU
 * ---------------
 * Template = {
 *   id, name,                       // id dùng để lưu vào item; name hiện trên thẻ
 *   duration,                       // thời lượng block mặc định (giây)
 *   slots: [{ id, label, default }], // các ô chữ người dùng sửa được
 *   rowGap,                         // khoảng cách giữa các lớp chữ xếp dọc (px@1080)
 *   layers: [ Layer ],
 * }
 * Layer = {
 *   kind: 'text' | 'glyph' | 'image',
 *   // --- kind 'text' ---
 *   slot, font:{family,weight,size,letter,lineStep}, color, align, textCase,
 *   stroke:{color,width}?, shadow:{color,dx,dy,blur}?,
 *   bg:{color,radius,padX, padY | padTop+padBottom}?,   // hộp nền của lớp chữ
 *   // --- kind 'glyph' ---
 *   glyph, size, colors:{...},
 *   // --- kind 'image' --- (ẢNH BITMAP lấy từ library/, xem measureImageLayer)
 *   variant, variants:{ key: {label, prefix, sizeRel, gapRel} }, src, name,
 *   // --- xếp chỗ ---
 *   tilt,                           // độ NGHIÊNG TĨNH của lớp (độ, dương = theo chiều
 *                                   // kim đồng hồ). Đây là số đo THIẾT KẾ, không phải
 *                                   // hoạt ảnh: nó nằm ngoài `anim.tracks.rot` để lớp
 *                                   // vẫn được coi là "đã đứng yên" (stateIsRest) —
 *                                   // nếu nhét vào tracks.rot thì settleTime không bao
 *                                   // giờ tìm được mốc nghỉ và thumbnail lấy sai khung.
 *   place: 'flow'                   // xếp dọc trong "hộp chữ" (theo thứ tự khai báo)
 *        | { fx, fy, lx, ly, dx, dy, line? } // neo tương đối vào hộp chữ:
 *          //   (fx,fy) = điểm neo TRÊN HỘP CHỮ  (0..1 của bề rộng/chiều cao)
 *          //   (lx,ly) = điểm neo TRÊN CHÍNH LỚP (0..1)
 *          //   line    = số thứ tự DÒNG chữ (hoặc 'last'): mốc NGANG đổi từ hộp chữ
 *          //             sang hộp MỰC của dòng đó, `fx` thành 0..1 của bề rộng DÒNG.
 *          //             Cần khi hình phải sát MỘT dòng: hộp chữ rộng bằng dòng dài
 *          //             nhất nên neo theo hộp là hình đè lên dòng ngắn hơn.
 *          //   (dx,dy) = dịch thêm, px@1080
 *   anim: {
 *     delay,                        // giây, tính từ đầu block
 *     period,                       // >0 = LẶP với chu kỳ này; bỏ = chạy một lần
 *     window: [t0, t1],             // chỉ hiện trong khoảng này của mỗi chu kỳ
 *     tracks: { opacity, scale, dx, dy, rot }  // [[t, v], …] nội suy tuyến tính
 *   }
 * }
 *
 * THÊM TEMPLATE MỚI = thêm một object vào TEMPLATES. Không phải sửa engine, trừ
 * khi cần một hình trang trí chưa có -> thêm một hàm vào GLYPHS.
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.TextTemplates = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* Cạnh ngắn tham chiếu — TRÙNG với TEXT_STYLE_REFERENCE_SHORT_SIDE của
       editing-runtime.js. Mọi px trong file này là px ở lớp này. */
    const REF_SHORT_SIDE = 1080;

    /* ===================== HÌNH TRANG TRÍ (GLYPHS) ==========================
     * Vẽ BẰNG ĐƯỜNG VECTOR, không dùng file ảnh: template phải render nét căng ở
     * mọi độ phân giải (1080 -> 4K) và phải bake được ra PNG ở khâu xuất mà
     * không cần tải thêm tài nguyên (một request lỗi = xuất ra thiếu hình).
     *
     * Quy ước: hàm nhận ctx đã được dịch sao cho TÂM hình ở (0,0) và nhận `r` =
     * nửa cạnh hộp. Nhờ vậy phép thu phóng của hoạt ảnh chỉ là ctx.scale.
     * `aspect` = w/h của hộp (mặc định 1 = vuông).
     */
    const GLYPHS = {
        /* Dấu tích trong đĩa tròn (template "Approved").
         * Đo trên khung f45 video mẫu: đĩa d=150px (r=75), tâm cách mực chữ 55px.
         * Dấu tích: nét bo tròn dày 0.28r, 3 điểm (đơn vị r, y dương = xuống). */
        'check-disc': {
            aspect: 1,
            /* Các mảng màu NGƯỜI DÙNG SỬA ĐƯỢC. Panel Thuộc tính dựng ô màu từ đúng
               danh sách này (không hard-code tên khoá ở phía UI), nên thêm một hình
               trang trí mới là tự có ô màu — không phải sửa Inspector. */
            colorKeys: [
                { key: 'disc', label: 'Nền', fallback: '#84cd00' },
                { key: 'mark', label: 'Dấu', fallback: '#ffffff' },
            ],
            draw(ctx, r, colors) {
                ctx.beginPath();
                ctx.arc(0, 0, r, 0, Math.PI * 2);
                ctx.fillStyle = colors.disc || '#84cd00';
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(-0.52 * r, -0.02 * r);
                ctx.lineTo(-0.15 * r, 0.38 * r);
                ctx.lineTo(0.52 * r, -0.42 * r);
                ctx.strokeStyle = colors.mark || '#ffffff';
                ctx.lineWidth = 0.28 * r;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.stroke();
            },
        },

        /* Dấu tích trong đĩa tròn CÓ BÓNG ĐỔ DÀI (template "Correct 1").
         * Đo trên khung f57 video mẫu: đĩa d=202 (r=101), tâm (156.5, 958.5).
         * Dấu tích là một nét gấp khúc bo tròn, 3 điểm (đơn vị r, y dương = xuống):
         *   P0(-0.460,-0.005) -> P1(-0.178, 0.332) -> P2(0.450,-0.371), dày 0.297r.
         * Cách suy ra: nét bo tròn nên mỗi đầu là NỬA ĐĨA bán kính w/2 — điểm cực trái
         * của đầu nét cho P.x + w/2, điểm cực trên cho P.y + w/2; giải hai phương trình
         * đó ra đồng thời cả toạ độ lẫn bề dày (kiểm chéo: bề rộng lát cắt ngang của
         * cánh dài = w/sin(góc) = 40.2px, đo được 38..40).
         *
         * BÓNG ĐỔ DÀI = quét chính dấu tích theo hướng u=(0.642,0.766) (≈50° dưới ngang)
         * cho tới khi ra khỏi đĩa, tô màu nhạt dần. Số đo: mép ngoài của bóng bám đúng
         * tia xuất phát từ hai điểm cực của nét theo phương vuông góc u (khớp tới ±1px ở
         * y=956/1012/1052). Độ đậm: chiếu từng pixel bóng lên trục u rồi hồi quy độ lệch
         * màu so với nền đĩa theo quãng chiếu s (30 điểm trên 3 hàng y=956/1000/1040) ra
         * Δ = 17.5 − 0.1625·s, tức đậm nhất Δ=17.5 sát nét (màu #72bb00 trên nền #84cd00)
         * và nhạt hẳn sau s = 108px = 1.07r. Ở mép đĩa bóng chưa tắt hết (Δ≈8) nên phần
         * còn lại bị chính đĩa cắt — đúng như video.
         * Vẽ bằng MỘT lệnh stroke trên nhiều bản sao đã dịch: một lệnh stroke chỉ hợp
         * thành MỘT vùng rồi tô một lần, nên chỗ các bản sao chồng nhau KHÔNG cộng dồn
         * alpha (vẽ nhiều lệnh thì bóng sẽ vón thành từng vạch đậm). */
        'check-disc-long-shadow': {
            aspect: 1,
            colorKeys: [
                { key: 'disc', label: 'Nền', fallback: '#84cd00' },
                { key: 'mark', label: 'Dấu', fallback: '#ffffff' },
                { key: 'shadow', label: 'Bóng', fallback: '#72bb00' },
            ],
            draw(ctx, r, colors) {
                const P = [[-0.460, -0.005], [-0.178, 0.332], [0.450, -0.371]];
                const width = 0.297 * r;
                ctx.beginPath();
                ctx.arc(0, 0, r, 0, Math.PI * 2);
                ctx.fillStyle = colors.disc || '#84cd00';
                ctx.fill();

                const ux = 0.642;
                const uy = 0.766;
                const start = 0.288 * r;   // hình chiếu của mép trước dấu tích lên trục u
                const len = 1.07 * r;      // quãng nhạt hết, khớp hồi quy bên dưới
                ctx.save();
                ctx.beginPath();
                ctx.arc(0, 0, r, 0, Math.PI * 2);
                ctx.clip();
                const grad = ctx.createLinearGradient(
                    start * ux, start * uy, (start + len) * ux, (start + len) * uy,
                );
                grad.addColorStop(0, colors.shadow || '#72bb00');
                grad.addColorStop(1, withAlpha(colors.shadow || '#72bb00', 0));
                ctx.strokeStyle = grad;
                ctx.lineWidth = width;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                const STEPS = 48;          // bước 3r/48 = 0.0625r, nhỏ hơn nhiều bề dày nét
                for (let i = 0; i <= STEPS; i += 1) {
                    const s = (len * i) / STEPS;
                    ctx.moveTo(P[0][0] * r + s * ux, P[0][1] * r + s * uy);
                    ctx.lineTo(P[1][0] * r + s * ux, P[1][1] * r + s * uy);
                    ctx.lineTo(P[2][0] * r + s * ux, P[2][1] * r + s * uy);
                }
                ctx.stroke();
                ctx.restore();

                ctx.beginPath();
                ctx.moveTo(P[0][0] * r, P[0][1] * r);
                ctx.lineTo(P[1][0] * r, P[1][1] * r);
                ctx.lineTo(P[2][0] * r, P[2][1] * r);
                ctx.strokeStyle = colors.mark || '#ffffff';
                ctx.lineWidth = width;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.stroke();
            },
        },

        /* Dấu X trong VÀNH TRÒN rỗng (template "Incorrect").
         * Đo trên khung f75: vành ngoài d=171 (r=85.5), nét vành 17.5 -> đường tâm vành
         * bán kính 76.75 = 0.898r, bề dày 0.205r. Dấu X: hộp 98×86 tâm trùng vành (lệch
         * xuống 1px), hai nét chéo bo tròn dày 14. Cách suy ra bề dày: lát cắt NGANG của
         * một cánh rộng 22, lát cắt DỌC rộng 18 -> w/|sinθ|=22 và w/|cosθ|=18, giải hệ
         * ra w=13.9 và hướng cánh (0.76,0.65); khớp lại với hộp 98×86 cho nửa-cạnh
         * a=42, b=36.
         *
         * `reveal` = phần cánh ĐÃ VẼ, tính từ hai đầu TRÊN xuống. Video cho thấy đầu nét
         * đang lớn dần luôn TRÒN (lát cắt thu nhỏ dần 22,20,18,16,14,8 chứ không cắt
         * phẳng ngang) — tức là nét được VẼ DẦN, không phải bị một mặt nạ ngang quét qua.
         * Hai cách nhìn giống nhau ở giữa chừng nhưng khác hẳn ở hai đầu. */
        'cross-ring': {
            aspect: 1,
            label: 'Vòng báo sai',
            colorKeys: [
                { key: 'ring', label: 'Vành', fallback: '#ff0000' },
                { key: 'mark', label: 'Dấu X', fallback: '#ff0000' },
            ],
            draw(ctx, r, colors, reveal) {
                ctx.beginPath();
                ctx.arc(0, 0, 0.898 * r, 0, Math.PI * 2);
                ctx.strokeStyle = colors.ring || '#ff0000';
                ctx.lineWidth = 0.205 * r;
                ctx.stroke();
                const p = (reveal == null) ? 1 : Math.max(0, Math.min(1, reveal));
                if (p <= 0.001) return;
                const a = 0.491 * r;
                const b = 0.421 * r;
                const dy = 0.012 * r;      // tâm X thấp hơn tâm vành 1px ở cỡ gốc
                ctx.strokeStyle = colors.mark || '#ff0000';
                ctx.lineWidth = 0.164 * r;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(-a, -b + dy);
                ctx.lineTo(-a + 2 * a * p, -b + 2 * b * p + dy);
                ctx.moveTo(a, -b + dy);
                ctx.lineTo(a - 2 * a * p, -b + 2 * b * p + dy);
                ctx.stroke();
            },
        },

        /* Dấu X TRẮNG trong đĩa đặc (template "Incorrect 2").
         * Đo trên khung f43: đĩa d=161 (r=80.5) màu #ff0000; dấu X hộp 74×74 (đúng 45°)
         * tâm trùng tâm đĩa, lát cắt ngang 23 -> bề dày 23·sin45° = 16.3 = 0.203r, nửa
         * cạnh a = (74−16.3)/2 = 28.9 = 0.359r.
         * Dấu X có BÓNG ĐỔ MỀM: ngay dưới nét, kênh đỏ tụt từ 254 xuống ~139 rồi hồi về
         * nền trong khoảng 10px -> bóng đen ~45%, nhoè ~0.10r, lệch xuống ~0.04r. */
        'cross-disc': {
            aspect: 1,
            label: 'Đĩa báo sai',
            colorKeys: [
                { key: 'disc', label: 'Nền', fallback: '#ff0000' },
                { key: 'mark', label: 'Dấu X', fallback: '#ffffff' },
            ],
            draw(ctx, r, colors, reveal) {
                ctx.beginPath();
                ctx.arc(0, 0, r, 0, Math.PI * 2);
                ctx.fillStyle = colors.disc || '#ff0000';
                ctx.fill();
                const p = (reveal == null) ? 1 : Math.max(0, Math.min(1, reveal));
                if (p <= 0.001) return;
                const a = 0.359 * r;
                ctx.save();
                ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
                ctx.shadowBlur = 0.10 * r;
                ctx.shadowOffsetY = 0.04 * r;
                ctx.strokeStyle = colors.mark || '#ffffff';
                ctx.lineWidth = 0.203 * r;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(-a, -a);
                ctx.lineTo(-a + 2 * a * p, -a + 2 * a * p);
                ctx.moveTo(a, -a);
                ctx.lineTo(a - 2 * a * p, -a + 2 * a * p);
                ctx.stroke();
                ctx.restore();
            },
        },

        /* HAI DẤU NHÁY ĐÓNG cỡ lớn (template "Quote").
         * Đo trên khung f91: cả cặp x 88..271 (rộng 183), y 867..1019 (cao 153) -> aspect
         * 1.196. Mỗi dấu là một ĐẦU VUÔNG rộng 78 (x 88..166 / 192..271) cao 74, nối vào
         * một cái đuôi quét xuống-trái; khe giữa hai dấu 26.
         * Cái đuôi KHÔNG phải hình cong tuỳ ý mà là một PHẦN TƯ VÀNH KHUYÊN có tâm đúng
         * tại GÓC DƯỚI-TRÁI của đầu vuông (88, 941):
         *   · mép ngoài: khớp đường tròn r=76 qua ba điểm đo được (147,992) (139,1000)
         *     (97,1018) — giải hệ x²+y²+Dx+Ey+F=0 ra tâm (89.5, 942.5) r=75.9, tức đúng
         *     góc đầu vuông với BÁN KÍNH = BỀ RỘNG đầu vuông (78);
         *   · mép trong: mép trái của đuôi đi 135 (y=940) -> 130 (966) -> 120 (979) ->
         *     88 (992), khớp đường tròn cùng tâm bán kính ~47 = 0.61 bề rộng.
         * Nhờ hai vòng cung ĐỒNG TÂM, hình chỉ còn ba số: bề rộng đầu vuông, y của khuỷu
         * và tỉ lệ bán kính trong — phóng to/thu nhỏ không làm méo cái đuôi. */
        'quote-marks': {
            aspect: 1.196,
            label: 'Dấu nháy',
            colorKeys: [
                { key: 'mark', label: 'Dấu nháy', fallback: '#fdee00' },
            ],
            draw(ctx, r, colors) {
                const halfW = 1.196 * r;     // nửa bề rộng hộp = aspect·r (91.5 ở cỡ gốc)
                const W = 1.0196 * r;        // bề rộng một dấu = 78; cũng là bán kính cung ngoài
                const elbow = -0.026 * r;    // y khuỷu = đáy đầu vuông = tâm hai cung (941)
                const inner = 0.61 * W;      // bán kính cung trong (47)
                ctx.fillStyle = colors.mark || '#fdee00';
                ctx.beginPath();
                [-halfW, halfW - W].forEach((x) => {
                    ctx.moveTo(x, -r);
                    ctx.lineTo(x + W, -r);
                    ctx.lineTo(x + W, elbow);
                    ctx.arc(x, elbow, W, 0, Math.PI / 2);              // cung ngoài: xuống-trái
                    ctx.lineTo(x, elbow + inner);
                    ctx.arc(x, elbow, inner, Math.PI / 2, 0, true);    // cung trong: quay lên
                    ctx.lineTo(x, elbow);
                    ctx.closePath();
                });
                ctx.fill();
            },
        },

        /* BA NÉT NHẤN viết tay đặt chéo trên góc phải chữ (template "Folgen Sie").
         * Mỗi nét là một CAPSULE — đoạn thẳng bo tròn hai đầu, vẽ bằng một lệnh stroke
         * lineCap:'round'. Số đo trên khung f65 (px@1080, hộp nhóm 168×119 tâm (897, 737.5)):
         *   nét   tâm hai đầu bo tròn (local)          bề dày
         *   1     (-71.33,-14.19) -> (-59.07, 20.69)    15.5
         *   2     ( 7.46,-32.25) -> ( -4.76,  5.55)     16.5
         *   3     ( 60.60, 22.25) -> ( 27.20, 51.35)    17.5
         * Bề dày KHÔNG lấy theo bề rộng lát cắt (nét bút ráp, vài pixel lạc làm rộng thêm
         * ~10%) mà GIẢI TỪ DIỆN TÍCH: A = ℓ·w + π(w/2)² với ℓ = quãng giữa hai tâm đầu bo.
         * Dựng lại rồi chồng lên mặt nạ video được IoU 0.872 (trạng thái trong) / 0.865
         * (ngoài) — phần thiếu là chỗ nét thật hơi thon ở đuôi, không phải sai vị trí.
         *
         * `reveal` Ở ĐÂY KHÔNG PHẢI "VẼ ĐƯỢC BAO NHIÊU" như dấu X của "Incorrect" mà là
         * PHA CỦA NHỊP ĐẬP: 0 = trạng thái TRONG, 1 = trạng thái NGOÀI (mỗi nét trượt ra xa
         * dọc TRỤC CỦA CHÍNH NÓ 16.5/19.6/17.3px). Phải đi qua kênh này chứ không phải
         * dx/dy mức lớp, vì dx/dy dời cả ba nét theo CÙNG một hướng còn ở đây ba nét toả ra
         * ba hướng khác nhau; và không tách thành ba lớp vì nhịp đập thuộc THIẾT KẾ của
         * hình — tách ra thì panel Thuộc tính mọc thêm ba ô màu vô nghĩa.
         * Hộp của hình là HỢP hai trạng thái (168×119, không phải 148×100 của riêng trạng
         * thái trong): phép tính lề canvas ở layout() KHÔNG xét reveal, nên nét ở trạng thái
         * ngoài mà thò ra khỏi hộp là bị xén ở mép canvas. */
        'emphasis-lines': {
            aspect: 168 / 119,
            label: 'Nét nhấn',
            colorKeys: [
                { key: 'mark', label: 'Nét nhấn', fallback: '#ffffff' },
            ],
            draw(ctx, r, colors, reveal) {
                const u = r / 59.5;      // r = nửa CHIỀU CAO hộp (59.5 ở cỡ gốc)
                const p = (reveal == null) ? 1 : Math.max(0, Math.min(1, reveal));
                ctx.strokeStyle = colors.mark || '#ffffff';
                ctx.lineCap = 'round';
                EMPHASIS_STROKES.forEach((s) => {
                    const ox = s.out[0] * p;
                    const oy = s.out[1] * p;
                    ctx.beginPath();
                    ctx.moveTo((s.p0[0] + ox) * u, (s.p0[1] + oy) * u);
                    ctx.lineTo((s.p1[0] + ox) * u, (s.p1[1] + oy) * u);
                    ctx.lineWidth = s.w * u;
                    ctx.stroke();
                });
            },
        },
        /* BÌNH SỮA EM BÉ (template "Mood Matcha") — CỐ Ý KHÔNG chép hình trong video mẫu.
         * Video dùng sticker cốc trà sữa matcha vẽ raster; ở đây đổi thành bình sữa em bé
         * vẽ bằng ĐƯỜNG VECTOR theo yêu cầu, vừa hợp quy ước "không dùng file ảnh" của
         * engine (nét căng ở 4K, bake được ra PNG mà không phải tải thêm tài nguyên) vừa
         * tránh chép lại tác phẩm của người khác.
         * GIỮ NGUYÊN từ video: HỘP 82×110 và chỗ neo so với hộp chữ — nhờ vậy bố cục và
         * đường thời gian vẫn là số đo thật, chỉ nội dung hình là mới.
         * Số đo viết trong hộp 82×110, gốc ở TÂM: x ∈ [−41,41], y ∈ [−55,55]. */
        'baby-bottle': {
            aspect: 82 / 110,
            label: 'Bình sữa',
            colorKeys: [
                { key: 'milk', label: 'Sữa', fallback: '#b7e778' },
                { key: 'bottle', label: 'Thân bình', fallback: '#ffffff' },
                { key: 'cap', label: 'Nắp & núm', fallback: '#8ede3a' },
                { key: 'line', label: 'Nét viền', fallback: '#304227' },
                { key: 'cheek', label: 'Má hồng', fallback: '#f79db1' },
            ],
            draw(ctx, r, colors) {
                const u = r / 55;                 // r = nửa CHIỀU CAO hộp (55 ở cỡ gốc)
                const P = (x, y) => [x * u, y * u];
                ctx.save();
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                ctx.strokeStyle = colors.line || '#304227';
                ctx.lineWidth = 4.5 * u;
                const capColor = colors.cap || '#8ede3a';

                // --- núm ti: một vòm tròn thu nhỏ dần về chân ---
                ctx.beginPath();
                ctx.moveTo(...P(-10, -37));
                ctx.bezierCurveTo(...P(-10, -50), ...P(-5, -55), ...P(0, -55));
                ctx.bezierCurveTo(...P(5, -55), ...P(10, -50), ...P(10, -37));
                ctx.closePath();
                ctx.fillStyle = capColor;
                ctx.fill();
                ctx.stroke();

                // --- cổ vặn ---
                roundRect(ctx, ...P(-22, -39), 44 * u, 15 * u, 5 * u);
                ctx.fill();
                ctx.stroke();

                // --- thân bình ---
                const body = () => roundRect(ctx, ...P(-30, -25), 60 * u, 80 * u, 16 * u);
                body();
                ctx.fillStyle = colors.bottle || '#ffffff';
                ctx.fill();

                // --- sữa: tô trong lòng thân, mặt sữa phẳng ở y = 0 ---
                ctx.save();
                body();
                ctx.clip();
                ctx.fillStyle = colors.milk || '#b7e778';
                ctx.fillRect(...P(-31, 0), 62 * u, 56 * u);
                ctx.beginPath();
                ctx.moveTo(...P(-31, 0));
                ctx.lineTo(...P(31, 0));
                ctx.stroke();
                // vạch chia trên phần thân còn trống
                ctx.lineWidth = 3.5 * u;
                [-16, -8].forEach((y) => {
                    ctx.beginPath();
                    ctx.moveTo(...P(9, y));
                    ctx.lineTo(...P(22, y));
                    ctx.stroke();
                });
                ctx.restore();

                // viền thân vẽ SAU phần sữa để mép trong không bị tô đè
                ctx.lineWidth = 4.5 * u;
                body();
                ctx.stroke();

                // --- mặt cười trên phần sữa ---
                ctx.fillStyle = colors.cheek || '#f79db1';
                [-17, 17].forEach((x) => {
                    ctx.beginPath();
                    ctx.ellipse(...P(x, 27), 6.5 * u, 4.5 * u, 0, 0, Math.PI * 2);
                    ctx.fill();
                });
                ctx.fillStyle = colors.line || '#304227';
                [-9, 9].forEach((x) => {
                    ctx.beginPath();
                    ctx.arc(...P(x, 20), 3.6 * u, 0, Math.PI * 2);
                    ctx.fill();
                });
                ctx.lineWidth = 3.2 * u;
                ctx.beginPath();
                ctx.arc(...P(0, 24), 8 * u, 0.15 * Math.PI, 0.85 * Math.PI);
                ctx.stroke();
                ctx.restore();
            },
        },

        /* BA VỆT NHẤN HÌNH NÊM (template "Mood Matcha") — ba tam giác RỖNG viền trắng toả
         * ra từ góc trên-trái, đặt dưới-phải cụm chữ. Đo trên khung f70 (px@1080), hộp
         * 76×88 tâm (898.5, 1199.5); đỉnh ghi ở toạ độ LOCAL (đã trừ tâm):
         *   nêm 1 (−13.5,−16.5) (36.5,−30.5) (27.5,−43.5)
         *   nêm 2 (−25.5, −6.5) (−18.5, 43.5) (−37.5, 39.5)
         *   nêm 3 ( −8.5, −4.5) ( 19.5, 30.5) ( 29.5, 13.5)
         * Bề dày nét 6 (suy từ diện tích/chu vi của từng cụm: 475px trên chu vi 117). */
        /* HAI BÔNG CÚC (template "Welcome") — một hình duy nhất chứ không phải hai lớp: trên
         * video chúng hiện cùng một lúc và lớn lên cùng một nhịp, tâm phóng nằm giữa CẢ CẶP
         * (đo được: hộp bao của cả cặp ở khung 21 có tâm (112, 814.5), còn hộp cuối cùng tâm
         * (113.5, 816.5) — tức một sticker chứ không phải hai).
         *
         * SỐ ĐO trên khung f61 (px@1080): cả cặp x 44..183, y 734..899 (140×166).
         *   bông LỚN  (cánh hồng nhạt, nhuỵ kem): tâm (134.4, 782.3), đỉnh cánh cách tâm 50,
         *                nhuỵ bán kính 11.75;
         *   bông NHỎ  (cánh kem, nhuỵ hồng nhạt): tâm (79.9, 858.9), đỉnh cách tâm 42.5,
         *                nhuỵ bán kính 8.
         * MỖI CÁNH LÀ MỘT HÌNH TRÒN, năm cái đặt cách tâm d, bán kính r. Hai số ấy được
         * KHỚP bằng phép chồng ảnh: dựng thử cúc với mọi (góc xoay, d, r, cỡ, lệch tâm)
         * rồi lấy cặp cho IoU cao nhất với mặt nạ của từng bông — ra d = 0.54·R, r = 0.46·R
         * cho CẢ HAI bông (IoU 0.88 và 0.90), góc xoay 21° và 64°.
         * Hai bông xoay KHÁC NHAU (đỉnh cánh ở 20° và 63°) — quay cùng góc thì cặp hoa nhìn
         * như bị nhân bản máy móc. */
        'two-flowers': {
            aspect: 140 / 166,
            label: 'Hoa',
            colorKeys: [
                { key: 'petalA', label: 'Cánh bông lớn', fallback: '#febdbd' },
                { key: 'coreA', label: 'Nhuỵ bông lớn', fallback: '#fef9f2' },
                { key: 'petalB', label: 'Cánh bông nhỏ', fallback: '#fef9f2' },
                { key: 'coreB', label: 'Nhuỵ bông nhỏ', fallback: '#febdbd' },
            ],
            draw(ctx, r, colors) {
                const daisy = (cx, cy, R, rot, petal, core, coreR) => {
                    ctx.fillStyle = petal;
                    ctx.beginPath();
                    for (let i = 0; i < 5; i += 1) {
                        const th = ((rot + i * 72) * Math.PI) / 180;
                        const px = cx + 0.54 * R * Math.cos(th);
                        const py = cy + 0.54 * R * Math.sin(th);
                        ctx.moveTo(px + 0.46 * R, py);
                        ctx.arc(px, py, 0.46 * R, 0, Math.PI * 2);
                    }
                    ctx.fill();
                    ctx.fillStyle = core;
                    ctx.beginPath();
                    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
                    ctx.fill();
                };
                // Tỉ lệ quy về r = nửa chiều cao hộp (83 ở cỡ gốc 166).
                daisy(0.288 * r, -0.441 * r, 0.606 * r, 21,
                    colors.petalA || '#febdbd', colors.coreA || '#fef9f2', 0.142 * r);
                daisy(-0.363 * r, 0.510 * r, 0.507 * r, 64,
                    colors.petalB || '#fef9f2', colors.coreB || '#febdbd', 0.096 * r);
            },
        },

        /* MŨI TÊN CUỐN vẽ tay (template "Welcome") — một nét liền: đuôi cong từ trên-phải,
         * xuống thành MỘT VÒNG TRÒN, rồi quét chéo xuống-trái tới mũi nhọn có hai ngạnh.
         * ĐƯỜNG ĐI LẤY TỪ CHÍNH NÉT TRONG VIDEO, không phải vẽ ước chừng: tách nét trắng ra
         * khỏi nền bằng hiệu ảnh với khung trước block, rút XƯƠNG bằng thuật toán Zhang-Suen
         * rồi đi dọc xương đó (ở ngã ba thì chọn nhánh thẳng hướng nhất) — nên mỗi điểm dưới
         * đây là một điểm THẬT trên nét, cách nhau ~7px ở cỡ gốc. Bề dày nét đo được 8px.
         * Hộp: x 892..1020, y 979..1146 (129×168), mọi toạ độ quy về r = 84. */
        'curl-arrow': {
            aspect: 129 / 168,
            label: 'Mũi tên',
            colorKeys: [
                { key: 'mark', label: 'Mũi tên', fallback: '#ffffff' },
            ],
            draw(ctx, r, colors) {
                ctx.strokeStyle = colors.mark || '#ffffff';
                ctx.lineWidth = 0.095 * r;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                [CURL_ARROW_PATH, CURL_ARROW_BARB_R, CURL_ARROW_BARB_L].forEach((pts) => {
                    ctx.beginPath();
                    pts.forEach(([x, y], i) => (i
                        ? ctx.lineTo(x * r, y * r)
                        : ctx.moveTo(x * r, y * r)));
                    ctx.stroke();
                });
            },
        },

        'spark-wedges': {
            aspect: 76 / 88,
            label: 'Vệt nhấn',
            colorKeys: [
                { key: 'mark', label: 'Vệt nhấn', fallback: '#ffffff' },
            ],
            draw(ctx, r, colors) {
                const u = r / 44;                 // r = nửa CHIỀU CAO hộp (44 ở cỡ gốc)
                ctx.strokeStyle = colors.mark || '#ffffff';
                ctx.lineWidth = 6 * u;
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                SPARK_WEDGES.forEach((tri) => {
                    ctx.beginPath();
                    tri.forEach(([x, y], i) => (i ? ctx.lineTo(x * u, y * u) : ctx.moveTo(x * u, y * u)));
                    ctx.closePath();
                    ctx.stroke();
                });
            },
        },

        /* THẺ MÀU chữ nhật đặc, PHỦ TRỌN hộp của lớp (template "Vlog Tag").
         * Khác mọi hình khác trong bảng này ở chỗ nó KHÔNG có hình dáng riêng: hai cạnh
         * do hộp quyết định, mà hộp lại lấy từ HỘP CHỮ (`layer.fit`, xem measureGlyphLayer)
         * — thẻ phải trùm đúng khổ chữ dù người dùng gõ dài ngắn thế nào. Vì vậy `draw`
         * dùng tham số thứ năm `box` thay vì suy hình từ bán kính r như các hình khác.
         * `aspect` ở đây chỉ là giá trị dự phòng cho trường hợp ai đó dùng 'card' mà
         * KHÔNG khai `fit` (khi ấy nó là một ô vuông cạnh `layer.size`). */
        card: {
            aspect: 1,
            label: 'Thẻ màu',
            colorKeys: [
                { key: 'fill', label: 'Màu', fallback: '#ffd744' },
            ],
            draw(ctx, r, colors, reveal, box) {
                const w = (box && Number(box.w) > 0) ? box.w : 2 * r;
                const h = (box && Number(box.h) > 0) ? box.h : 2 * r;
                ctx.fillStyle = colors.fill || '#ffd744';
                ctx.fillRect(-w / 2, -h / 2, w, h);
            },
        },
    };

    /* Đỉnh của ba nêm — TÂM ĐƯỜNG NÉT, không phải đỉnh đo được. Điểm cực của mặt nạ nằm
       trên MÉP NGOÀI nét: với lineJoin/lineCap tròn, góc ngoài là cung tròn bán kính w/2
       quanh đỉnh tâm-nét, nên đỉnh tâm-nét = đỉnh đo được lùi vào 3 (= w/2) theo hướng
       trọng tâm tam giác. Bỏ phép lùi này thì hình vẽ ra to hơn số đo 3px mỗi phía và
       tràn khỏi hộp 76×88. */
    const SPARK_WEDGES = [
        [[-10.77, -17.73], [33.50, -30.45], [25.62, -41.16]],
        [[-25.66, -3.50], [-19.80, 40.80], [-35.72, 37.09]],
        [[-6.16, -2.62], [18.52, 27.67], [26.50, 13.44]],
    ];

    /* ĐƯỜNG ĐI CỦA MŨI TÊN CUỐN ("Welcome"), toạ độ theo r = nửa chiều cao hộp, gốc ở
     * TÂM hộp, y dương = xuống. Lấy từ xương của chính nét vẽ trong video (xem 'curl-arrow').
     * Đường chính đi từ ĐUÔI (trên-phải) → vòng tròn → quét chéo → MŨI NHỌN; hai ngạnh
     * xuất phát từ chính mũi nhọn đó (điểm đầu của cả hai mảng trùng điểm cuối của đường
     * chính, nên ba nét nối liền nhau ở mũi). */
    const CURL_ARROW_PATH = [
        [0.476, -0.982], [0.560, -0.935], [0.631, -0.863], [0.679, -0.780], [0.702, -0.696],
        [0.726, -0.613], [0.726, -0.530], [0.726, -0.446], [0.702, -0.363], [0.667, -0.280],
        [0.607, -0.196], [0.524, -0.137], [0.452, -0.077], [0.369, -0.030], [0.286, -0.006],
        [0.202, 0.006], [0.119, -0.006], [0.036, -0.054], [-0.048, -0.125], [-0.071, -0.208],
        [-0.083, -0.292], [-0.036, -0.375], [0.048, -0.435], [0.131, -0.458], [0.214, -0.458],
        [0.298, -0.435], [0.381, -0.387], [0.429, -0.315], [0.452, -0.232], [0.452, -0.149],
        [0.464, -0.125], [0.417, -0.042], [0.417, 0.042], [0.369, 0.125], [0.310, 0.208],
        [0.226, 0.292], [0.143, 0.327], [0.060, 0.363], [-0.024, 0.375], [-0.107, 0.387],
        [-0.190, 0.423], [-0.274, 0.482], [-0.357, 0.554], [-0.429, 0.637], [-0.476, 0.720],
        [-0.500, 0.804], [-0.500, 0.887],
    ];
    const CURL_ARROW_BARB_R = [
        [-0.500, 0.887], [-0.262, 0.744], [-0.202, 0.696], [-0.143, 0.673], [-0.083, 0.649],
    ];
    const CURL_ARROW_BARB_L = [
        [-0.500, 0.887], [-0.667, 0.625], [-0.679, 0.601], [-0.690, 0.542], [-0.714, 0.482],
        [-0.750, 0.423],
    ];

    /* Số đo của 'emphasis-lines' (xem chú thích ở trên). `out` = quãng trượt của nhịp đập,
       đo bằng hiệu vị trí giữa khung 65 (trong) và khung 70 (ngoài). */
    const EMPHASIS_STROKES = [
        { p0: [-71.33, -14.19], p1: [-59.07, 20.69], w: 15.5, out: [-5.8, -15.4] },
        { p0: [7.46, -32.25], p1: [-4.76, 5.55], w: 16.5, out: [5.6, -19.5] },
        { p0: [60.60, 22.25], p1: [27.20, 51.35], w: 17.5, out: [13.8, -10.3] },
    ];

    // '#rrggbb' -> 'rgba(r,g,b,a)'. Chỉ cần cho điểm dừng "trong suốt" của gradient:
    // addColorStop('transparent') ở Chrome nội suy qua ĐEN nên bóng bị ám xám.
    function withAlpha(hex, alpha) {
        const h = String(hex || '#000000').replace('#', '');
        const r = parseInt(h.substring(0, 2), 16);
        const g = parseInt(h.substring(2, 4), 16);
        const b = parseInt(h.substring(4, 6), 16);
        if ([r, g, b].some(Number.isNaN)) return `rgba(0, 0, 0, ${alpha})`;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    /* ===================== ĐƯỜNG CONG / NỘI SUY ============================= */

    // Giá trị của một track [[t,v],…] tại thời điểm t (nội suy tuyến tính, kẹp 2 đầu).
    function trackAt(list, t, fallback) {
        if (!Array.isArray(list) || !list.length) return fallback;
        if (t <= list[0][0]) return list[0][1];
        const last = list[list.length - 1];
        if (t >= last[0]) return last[1];
        for (let i = 1; i < list.length; i += 1) {
            const [t1, v1] = list[i];
            if (t > t1) continue;
            const [t0, v0] = list[i - 1];
            const span = t1 - t0;
            if (!(span > 0)) return v1;
            return v0 + ((v1 - v0) * (t - t0)) / span;
        }
        return last[1];
    }

    /* `reveal` = phần ĐÃ VẼ XONG của một hình trang trí, 0..1. Khác opacity/scale ở chỗ
       nó không phải phép biến đổi: hình tự quyết định "vẽ được bao nhiêu" (dấu X của
       "Incorrect" mọc dần từ hai đầu trên xuống). Để ở đây thay vì làm một lớp riêng vì
       nó thuộc về THIẾT KẾ của hình, không phải một lớp độc lập người dùng thấy. */
    const IDENTITY_STATE = Object.freeze({ hidden: false, opacity: 1, scale: 1, dx: 0, dy: 0, rot: 0, reveal: 1 });

    /* Trạng thái của MỘT lớp tại thời điểm t (giây, tính từ đầu block).
     * - t < delay              -> ẩn (lớp chưa vào cảnh)
     * - period > 0             -> thời gian cục bộ quay vòng theo chu kỳ
     * - window = [a,b]         -> ngoài khoảng đó trong chu kỳ thì ẩn
     * Trả về hidden=true nghĩa là KHÔNG VẼ GÌ (khác opacity=0 ở chỗ caller có thể
     * bỏ hẳn phép vẽ, và ở chỗ đo hộp bao thì không tính lớp đang ẩn). */
    // Thân chung của layerStateAt/charStateAt: giải anim tại thời điểm ĐÃ TRỪ delay.
    function stateFromAnim(anim, local) {
        /* Nới 1ns ở mốc 0: delay của một ký tự là `delay + i*stagger`, một phép cộng dồn
           số thực — nó rơi lệch cỡ 1e-17 so với thời điểm mà caller tính bằng phép chia
           (k/fps). Chỉ so `local < 0` thì đúng khung đầu tiên của mỗi ký tự lại bị coi là
           chưa tới, chữ nhấp một khung rồi mới hiện. */
        if (local < -1e-9) return { ...IDENTITY_STATE, hidden: true };
        if (local < 0) local = 0;
        const period = Number(anim.period) || 0;
        if (period > 0) local %= period;
        if (Array.isArray(anim.window)) {
            const [a, b] = anim.window;
            if (local < Number(a) || local > Number(b)) return { ...IDENTITY_STATE, hidden: true };
        }
        const tr = anim.tracks || {};
        return {
            hidden: false,
            opacity: Math.max(0, Math.min(1, trackAt(tr.opacity, local, 1))),
            scale: Math.max(0, trackAt(tr.scale, local, 1)),
            dx: trackAt(tr.dx, local, 0),
            dy: trackAt(tr.dy, local, 0),
            rot: trackAt(tr.rot, local, 0),
            reveal: Math.max(0, Math.min(1, trackAt(tr.reveal, local, 1))),
        };
    }

    function layerStateAt(layer, t) {
        const anim = layer && layer.anim;
        if (!anim) return IDENTITY_STATE;
        /* LỚP CHẠY THEO TỪNG KÝ TỰ: `tracks` thuộc về KÝ TỰ, không phải lớp. Áp nó ở
           mức lớp nữa là nhân đôi hiệu ứng (cả khối trôi theo trong khi từng chữ cũng
           trôi). Ở mức lớp chỉ còn một việc: trước `delay` thì chưa có ký tự nào vào
           cảnh -> ẩn hẳn, để caller bỏ luôn phép vẽ. */
        if (anim.perChar) {
            return (t < (Number(anim.delay) || 0)) ? { ...IDENTITY_STATE, hidden: true } : IDENTITY_STATE;
        }
        return stateFromAnim(anim, t - (Number(anim.delay) || 0));
    }

    /* Trạng thái của KÝ TỰ thứ `index` (đếm liên tục qua các dòng của lớp).
     * Mỗi ký tự chạy CÙNG một đường thời gian, chỉ lệch pha `stagger` giây một chữ —
     * đó là cách CapCut làm hiệu ứng "chữ rơi xuống lần lượt": không phải 7 lớp riêng
     * mà là MỘT lớp với 7 pha. Nhờ vậy người dùng gõ chuỗi dài ngắn tuỳ ý mà hiệu ứng
     * vẫn đúng, không cần khai lại template. */
    function charStateAt(layer, t, index) {
        const anim = layer && layer.anim;
        const pc = anim && anim.perChar;
        if (!pc) return layerStateAt(layer, t);
        const delay = (Number(anim.delay) || 0) + (Number(index) || 0) * (Number(pc.stagger) || 0);
        return stateFromAnim(anim, t - delay);
    }

    // Mốc cuối cùng của mọi track trong một anim (giây, tính từ delay của nó).
    function animTrackEnd(anim) {
        const tracks = (anim && anim.tracks) || {};
        let last = 0;
        Object.keys(tracks).forEach((key) => {
            const list = tracks[key];
            if (Array.isArray(list) && list.length) last = Math.max(last, list[list.length - 1][0]);
        });
        return last;
    }

    /* Mọi mốc thời gian "đáng lấy mẫu" của một template: dùng để (a) tính lề canvas
     * cho biên độ hoạt ảnh và (b) ở khâu xuất biết khung nào KHÁC khung trước.
     * Lấy mẫu theo lưới đủ dày (120 mẫu/giây) là an toàn với mọi keyframe ta khai. */
    function sampleTimes(tpl, duration) {
        return sampleRange(Math.max(0.1, Number(duration) || Number(tpl.duration) || 3));
    }

    function sampleRange(dur) {
        const step = 1 / 120;
        const out = [];
        for (let t = 0; t <= Math.max(0.1, dur) + 1e-6; t += step) out.push(t);
        return out;
    }

    /* ===================== ĐO CHỮ ==========================================
     * Hộp của lớp chữ là HỘP MỰC (ink box) — bề rộng/chiều cao thật của nét chữ,
     * không phải hộp có padding như textbox thường.
     *
     * VÌ SAO INK BOX: mọi khoảng cách trong template (khe giữa dấu tích và chữ,
     * lề thanh màu dưới tiêu đề…) đều được ĐO trên video mẫu bằng mực chữ. Nếu
     * hộp lớp mang thêm padding theo cỡ chữ thì cùng một con số 55px sẽ ra khe
     * rộng hẹp khác nhau tuỳ font — tức là không đo được, phải chỉnh tay mỗi lần.
     */
    /* `italic` là MỘT PHẦN CỦA THIẾT KẾ mẫu (mẫu "Folgen Sie" dùng chữ nghiêng), nên nó đi
       cùng font chứ không phải một khoá riêng: canvas nhận kiểu chữ ngay trong chuỗi font.
       Khuôn nghiêng thật được đăng ký @font-face ở editingFontFaceCss; family nào không có
       file italic thì Chrome nghiêng giả, nên người dùng đổi font vẫn giữ được dáng. */
    function fontShorthand(font) {
        return `${font.italic ? 'italic ' : ''}${font.weight || 400} ${font.size}px "${font.family}"`;
    }

    function applyCase(text, mode) {
        const s = String(text == null ? '' : text);
        if (mode === 'uppercase') return s.toUpperCase();
        if (mode === 'lowercase') return s.toLowerCase();
        if (mode === 'title') return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
        return s;
    }

    function splitLines(text) {
        return String(text == null ? '' : text).split(/\r?\n/);
    }

    /* Đo một lớp chữ ở hệ px ĐÃ NHÂN k. Trả về:
     *   lines[]        — chuỗi từng dòng (đã áp Case)
     *   width          — bề rộng MỰC của dòng rộng nhất (hộp tự co theo nội dung)
     *   height         — chiều cao DẢI CHỮ HOA (xem bên dưới)
     *   lineStep       — khoảng cách giữa 2 baseline
     *   baseline0      — baseline dòng ĐẦU, tính từ mép trên hộp
     *   lineWidths[]   — bề rộng mực từng dòng (để căn lề trong hộp)
     *   lineLefts[]    — mép trái mực từng dòng so với anchor (do bearing của glyph đầu)
     *   overTop/overBottom — phần mực TRÀN ra ngoài dải chữ hoa (dấu tiếng Việt ở trên,
     *                        nét thả của g/y ở dưới) -> layout cộng vào lề canvas
     *
     * CHIỀU CAO LẤY THEO DẢI CHỮ HOA, KHÔNG THEO MỰC THẬT
     * ---------------------------------------------------
     * Chiều cao = (số dòng − 1)·lineStep + capHeight, với capHeight đo từ chữ 'H' —
     * KHÔNG phụ thuộc vào chuỗi người dùng gõ. Vì sao:
     *   · Số đo của mẫu lấy từ video CapCut với chuỗi mặc định TOÀN CHỮ HOA, lúc đó
     *     mực đúng bằng dải chữ hoa -> hai cách tính trùng nhau, số đo vẫn khớp.
     *   · Nhưng người dùng gõ tiếng Việt: "ĐÃ DUYỆT" có dấu ngã ở trên và dấu nặng ở
     *     dưới, mực cao hơn dải chữ hoa cả hai đầu. Nếu hộp chạy theo mực thì TÂM DỌC
     *     của hộp trôi theo dấu -> hình trang trí (neo theo fy: 0.5) tự nhiên lệch lên
     *     hoặc xuống tuỳ chuỗi. Lấy dải chữ hoa thì dấu tràn ra ngoài hộp (canvas đã có
     *     lề) còn hình trang trí đứng yên đúng chỗ thiết kế. */
    function measureTextLayer(ctx, layer, text, k) {
        const font = layer.font || {};
        const size = Math.max(1, (Number(font.size) || 60) * k);
        const letter = (Number(font.letter) || 0) * k;
        const shorthand = fontShorthand({ ...font, size });
        const lines = splitLines(applyCase(text, layer.textCase)).map((l) => (l.length ? l : ' '));
        ctx.save();
        ctx.font = shorthand;
        try { ctx.letterSpacing = `${letter}px`; } catch (_) { /* Safari cũ: bỏ qua */ }
        let maxAscent = 0;
        let maxDescent = 0;
        const lineWidths = [];
        const lineLefts = [];
        lines.forEach((line) => {
            const m = ctx.measureText(line);
            /* Hộp MỰC theo đúng định nghĩa của canvas: mực nằm từ
             *   anchorX - actualBoundingBoxLeft  đến  anchorX + actualBoundingBoxRight
             * nên bề rộng mực = Left + Right, và muốn ĐẶT mép trái mực tại X thì phải
             * vẽ ở anchorX = X + actualBoundingBoxLeft. Dấu ngược ở dòng dưới từng làm
             * cả khối chữ lệch ~2·|Left| (đo được 5px ở "APPROVED") -> khe giữa hình
             * trang trí và chữ sai đúng bấy nhiêu. */
            lineWidths.push(Math.max(1, (m.actualBoundingBoxRight || 0) + (m.actualBoundingBoxLeft || 0) || m.width));
            lineLefts.push(m.actualBoundingBoxLeft || 0);
            maxAscent = Math.max(maxAscent, m.actualBoundingBoxAscent || size * 0.72);
            maxDescent = Math.max(maxDescent, m.actualBoundingBoxDescent || 0);
        });
        // Dải chữ hoa: đo từ 'H' nên KHÔNG đổi theo chuỗi người dùng gõ.
        const capProbe = ctx.measureText('H');
        const capHeight = capProbe.actualBoundingBoxAscent || size * 0.72;
        /* --- Vị trí TỪNG KÝ TỰ (chỉ khi lớp chạy hiệu ứng theo ký tự) -------------
         * `ax` = advance của tiền tố, tức đúng chỗ phải gọi fillText cho ký tự đó nếu
         * cả dòng được vẽ từ cùng một anchor. Đo bằng CHÍNH ctx đang set letterSpacing
         * nên khe chữ đã nằm sẵn trong advance — không tự cộng tay, vì cách canvas rải
         * letter-spacing (sau MỖI ký tự, kể cả ký tự cuối) khác với phép cộng thủ công
         * và lệch dần về cuối dòng.
         * L/R = hộp mực riêng của ký tự, dùng làm TÂM phép biến đổi của nó. */
        const chars = [];
        if (layer.anim && layer.anim.perChar) {
            let index = 0;
            lines.forEach((line) => {
                const row = [];
                for (let i = 0; i < line.length; i += 1) {
                    const g = ctx.measureText(line[i]);
                    row.push({
                        ch: line[i],
                        ax: i === 0 ? 0 : ctx.measureText(line.slice(0, i)).width,
                        L: g.actualBoundingBoxLeft || 0,
                        R: g.actualBoundingBoxRight || 0,
                        index,
                    });
                    index += 1;
                }
                chars.push(row);
            });
        }
        ctx.restore();
        // lineStep: bội số của cỡ chữ (mặc định 1.15 — đủ thoáng cho chữ có dấu).
        const lineStep = (Number(font.lineStep) || 1.15) * size;
        /* NỀN BO GÓC nằm TRONG hộp lớp, không phải phủ ra ngoài: hộp tĩnh của mẫu là
           thứ người dùng thấy làm khung transform, nên mọi pixel được vẽ phải nằm gọn
           trong đó. Bật nền là hộp lớp NỞ RA đúng phần đệm — nhờ vậy hình trang trí neo
           theo hộp (dấu tích của "Approved") tự lùi ra, không bị nền chữ đè lên. */
        /* PHẦN ĐỆM TRÊN/DƯỚI TÁCH RIÊNG (`padTop`/`padBottom`, mặc định = `padY`): hộp
           nền của CapCut bám dải ascender→descender nên KHÔNG cân đối quanh dải chữ hoa —
           mẫu "Quote" đo được 9px trên dải chữ hoa và 18px dưới baseline. Đệm cân đối thì
           phải chọn: đúng chiều cao hộp (86) hoặc đúng chỗ đặt baseline (68 tính từ mép
           trên) — không thể cả hai, và lệch 4.5px thấy rõ ở khe giữa hai dòng. */
        const padY = layer.bg ? (Number(layer.bg.padY) || 0) : 0;
        const padTop = layer.bg ? (Number(layer.bg.padTop != null ? layer.bg.padTop : padY) || 0) * k : 0;
        const padBottom = layer.bg ? (Number(layer.bg.padBottom != null ? layer.bg.padBottom : padY) || 0) * k : 0;
        const innerWidth = Math.max(1, Math.max(...lineWidths));
        const height = Math.max(1, capHeight + (lines.length - 1) * lineStep) + padTop + padBottom;
        /* CHIỀU CAO HỘP "MỘT DÒNG" — mốc đo KHÔNG phụ thuộc người dùng gõ bao nhiêu chữ.
         * `height` ở trên nở ra theo SỐ DÒNG, nên mọi thứ neo vào nó cũng nở theo. Với hình
         * Icon/Illus của mẫu "Custom" đó là sai (người dùng chốt 2026-09-16): gõ thêm một
         * dòng là hình to lên theo, trong khi hình là một VẬT THỂ có cỡ riêng, không phải
         * một phần của khối chữ. `baseHeight` chỉ gồm dải chữ hoa + đệm trên/dưới, mà cả ba
         * đều tỉ lệ thuần với CỠ CHỮ (đệm là % cỡ chữ, xem bg_pad_top ở layerTextStyle) —
         * nên nó đứng yên khi đổi nội dung và vẫn co giãn đúng khi đổi cỡ chữ.
         * capHeight đo từ chữ 'H' nên cũng không đổi theo chuỗi (kể cả chữ có dấu). */
        const baseHeight = Math.max(1, capHeight) + padTop + padBottom;
        /* ĐỆM NGANG THEO CHIỀU CAO HỘP (`bg.padXRel`) thay vì theo cỡ chữ.
         * Mẫu "Custom" cần đúng điều này: hình Icon có cạnh = CHIỀU CAO hộp và đè lên
         * hộp đúng nửa cạnh, nên cột đệm trái phải rộng bằng nửa chiều cao hộp thì hình
         * mới không bao giờ chạm chữ. Đệm theo cỡ chữ (đường mặc định) chỉ đúng ở đúng
         * số dòng mà thiết kế được đo: gõ sang 3 dòng là hộp cao lên, hình to theo, mà
         * cột đệm đứng yên -> hình liếm vào chữ.
         * Tính SAU `height` được vì chiều cao hộp không phụ thuộc đệm ngang; đảo thứ tự
         * là vòng tròn. `height` đã nhân k rồi nên KHÔNG nhân k lần nữa. */
        const padXRel = layer.bg ? (Number(layer.bg.padXRel) || 0) : 0;
        const padX = layer.bg
            ? (padXRel > 0 ? padXRel * height : (Number(layer.bg.padX) || 0) * k)
            : 0;
        const width = innerWidth + 2 * padX;
        /* Viền và bóng đổ VẼ RA NGOÀI mực chữ. Chúng không được tính vào hộp (hộp phải
           đứng yên khi bật/tắt viền, nếu không mọi khoảng cách của mẫu nhảy theo) nhưng
           PHẢI được cộng vào lề canvas, nếu không nét viền bị cắt cụt ở mép. */
        // Lề phải theo vòng viền NGOÀI CÙNG (stroke2 nếu có) — lấy nhầm vòng trong thì
        // vòng ngoài bị xén cụt ở mép canvas, chỉ lộ ra ở khâu xuất.
        const strokePx = Math.max(
            (layer.stroke && (Number(layer.stroke.width) || 0) > 0) ? (Number(layer.stroke.width) || 0) : 0,
            (layer.stroke2 && (Number(layer.stroke2.width) || 0) > 0) ? (Number(layer.stroke2.width) || 0) : 0,
        ) * k;
        const shadowPx = layer.shadow
            ? (Math.max(0, Number(layer.shadow.blur) || 0)
                + Math.max(Math.abs(Number(layer.shadow.dx) || 0), Math.abs(Number(layer.shadow.dy) || 0))) * k
            : 0;
        const bleed = strokePx + shadowPx;
        return {
            kind: 'text', lines, width, height, baseHeight, lineStep, innerWidth,
            padX, padTop, padBottom, chars, capHeight,
            baseline0: padTop + capHeight, lineWidths, lineLefts,
            overTop: Math.max(0, maxAscent - capHeight - padTop) + bleed,
            overBottom: Math.max(0, maxDescent - padBottom) + bleed,
            overSide: bleed,
            size, letter, shorthand,
        };
    }

    /* Mép trái MỰC của dòng thứ `i` trong hộp của một lớp chữ (px đã nhân k, gốc = góc
     * trên-trái hộp lớp). MỘT nguồn sự thật cho hai chỗ cần nó:
     *   · phép VẼ — anchor của fillText = mép mực + bearing của glyph đầu (lineLefts),
     *   · phép NEO hình trang trí theo DÒNG (`place.line`).
     * Hai bản riêng thì đổi cách căn lề sẽ làm hình trang trí trôi khỏi chữ mà phép vẽ
     * vẫn đúng — loại lệch chỉ thấy ở một chuỗi nhất định. */
    function lineInkLeft(layer, m, i) {
        const align = layer.align || 'center';
        const inner = Number(m.innerWidth) || 0;
        const w = m.lineWidths[i] || 0;
        const padX = Number(m.padX) || 0;
        return padX + (align === 'left' ? 0 : (align === 'right' ? inner - w : (inner - w) / 2));
    }

    function measureGlyphLayer(layer, k, flowW, flowH) {
        const def = GLYPHS[layer.glyph];
        /* HÌNH ĐO THEO HỘP CHỮ (`fit: {fw, fh, dw, dh}`): cạnh = fw·bề-rộng-hộp-chữ + dw,
         * fh·chiều-cao-hộp-chữ + dh — thay cho `size` cố định. Dùng cho hình phải BÁM
         * KHỔ CHỮ: hai thẻ vàng của "Vlog Tag" là bản sao lệch chỗ của chính hộp chữ, gõ
         * dài ngắn thế nào chúng cũng phải trùm đúng bấy nhiêu.
         * fw/fh nhân vào hộp chữ (đã ở px Sequence) nên KHÔNG nhân k nữa; dw/dh viết ở
         * lớp 1080 như mọi số đo khác nên có.
         * Đo ở PHA 2 của layoutAt, cùng chỗ với lớp ảnh và cùng lý do: hộp chữ chưa có
         * ở pha 1. Lớp `fit` vì thế cũng KHÔNG được nằm trong hộp chữ (`place:'flow'`) —
         * hộp cần cạnh của nó, cạnh của nó cần hộp. */
        if (layer.fit) {
            const f = layer.fit;
            return {
                kind: 'glyph',
                width: Math.max(1, (Number(f.fw) || 0) * (Number(flowW) || 0) + (Number(f.dw) || 0) * k),
                height: Math.max(1, (Number(f.fh) || 0) * (Number(flowH) || 0) + (Number(f.dh) || 0) * k),
                def,
            };
        }
        const size = Math.max(1, (Number(layer.size) || 100) * k);
        const aspect = (def && Number(def.aspect)) || 1;
        return { kind: 'glyph', width: size * aspect, height: size, def };
    }

    /* ===================== LỚP ẢNH (kind:'image') ==========================
     * Khác GLYPH ở một điểm quyết định: glyph là ĐƯỜNG VECTOR viết sẵn trong file
     * này, còn lớp ảnh vẽ MỘT TỆP PNG NGƯỜI DÙNG CHỌN trong library/Elements. Vì vậy
     * engine KHÔNG tự nạp ảnh (module này thuần, không đụng DOM/mạng): caller truyền
     * vào `opts.imageFor(layer, measured)` -> một thứ ctx.drawImage() nhận được
     * (HTMLImageElement/ImageBitmap/canvas), hoặc null. Null thì vẽ Ô GIỮ CHỖ — mẫu
     * vẫn đo đúng, vẫn xuất được, chỉ là chưa có hình.
     *
     * CỠ TÍNH TỪ CHIỀU CAO HỘP CHỮ, KHÔNG PHẢI SỐ PX CỐ ĐỊNH
     * ------------------------------------------------------
     * Bản vẽ thiết kế của mẫu "Custom" ghi thông số theo TỈ LỆ: Icon là hình vuông cạnh
     * X = chiều cao hộp trắng, Illus cạnh Y = 1.41·X. Viết bằng px@1080 thì người dùng
     * đổi cỡ chữ trong panel Thuộc tính là hình đứng im còn chữ to ra — sai hẳn thiết kế.
     * Nên `variants[].sizeRel` là bội của chiều cao HỘP CHỮ (đã nhân k) và layout tự quy
     * ra px; một con số duy nhất đúng ở mọi cỡ chữ và mọi độ phân giải.
     *
     * `variants[].place` (tuỳ chọn) khai luôn CHỖ ĐẬU riêng của từng kiểu — hai kiểu của
     * "Custom" đậu khác hẳn nhau nên không gộp được vào một `place` chung.
     *
     * `gapRel`/`place.dxGap` là cơ chế "khe hở tính theo cạnh hình". Mẫu "Custom" ĐÃ BỎ
     * từ 2026-09-13 (bản vẽ cho thấy hình ĐÈ LÊN hộp chứ không đứng cách một khe), nhưng
     * cơ chế giữ lại cho mẫu sau: không khai gapRel thì gap = 0 và dxGap vô hiệu.
     *
     * `variants` cũng là chỗ khai HAI KIỂU của mẫu (Icon / Illus): đổi kiểu chỉ là ghi
     * `variant` vào override, không phải đổi sang một template khác — đổi template sẽ
     * xoá sạch override (xem switchTextTemplate), tức mất cả hình người dùng đã chọn.
     */
    function imageVariantOf(layer) {
        const table = (layer && layer.variants) || {};
        const keys = Object.keys(table);
        const key = (layer && layer.variant && table[layer.variant]) ? layer.variant : (keys[0] || '');
        return { key, ...(table[key] || {}) };
    }

    /* Trần/sàn của ô "Cỡ hình". Sàn 10% để hình không bao giờ biến mất hẳn (người dùng gõ
       0 rồi không còn gì để bấm vào mà sửa lại); trần 400% vì quá đó là hình trùm kín cả
       khung, không còn là mẫu chữ nữa. */
    const ART_SCALE_MIN = 10;
    const ART_SCALE_MAX = 400;
    function clampArtScale(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return 100;
        return Math.max(ART_SCALE_MIN, Math.min(ART_SCALE_MAX, n));
    }

    /* Hệ số cỡ / độ lệch NGƯỜI DÙNG chỉnh cho một lớp ảnh (xem `artScale/artDx/artDy` ở
       resolve). Để riêng một hàm vì cả phép đo lẫn phép đặt chỗ đều cần, và cả hai phải
       đọc CÙNG một quy ước "không khai = đúng thiết kế gốc". */
    function imageUserTweak(layer) {
        const raw = Number(layer && layer.artScale);
        return {
            scale: Number.isFinite(raw) && raw > 0 ? raw / 100 : 1,
            dx: Number(layer && layer.artDx) || 0,
            dy: Number(layer && layer.artDy) || 0,
        };
    }

    /* `baseH` = chiều cao hộp chữ MỘT DÒNG (`measureTextLayer().baseHeight`), đã ở px đã
     * nhân k -> cạnh và khe cũng ra px đã nhân k.
     *
     * TRƯỚC 2026-09-16 tham số này là chiều cao hộp THẬT (`flowH`), tức cạnh hình nở theo
     * số dòng người dùng gõ. Người dùng chốt: Icon/Illus là vật thể có cỡ riêng, chỉ GIỮ
     * VỊ TRÍ tương đối với hộp chữ chứ không được đổi cỡ theo nội dung hay theo khổ hộp.
     * Đổi sang baseH giữ nguyên mọi tỉ lệ thiết kế ở ca một dòng (ca mà bản vẽ được đo) và
     * khiến cạnh hình chỉ còn phụ thuộc CỠ CHỮ — thứ giờ đã được chốt lúc tạo block. */
    function measureImageLayer(layer, baseH) {
        const v = imageVariantOf(layer);
        const side = Math.max(1, (Number(baseH) || 0) * (Number(v.sizeRel) || 1) * imageUserTweak(layer).scale);
        return {
            kind: 'image',
            width: side,
            height: side,
            gap: side * (Number(v.gapRel) || 0),
            variant: v,
        };
    }

    /* Ô GIỮ CHỖ khi chưa có ảnh (thư viện trống, ảnh chưa tải xong, tệp đã bị xoá).
     * Vẽ nét đứt + biểu tượng ảnh mờ: người dùng thấy NGAY chỗ hình sẽ nằm và biết
     * phải chọn hình, thay vì tưởng mẫu bị lỗi vì khoảng trống câm lặng. */
    function drawImagePlaceholder(ctx, w, h) {
        const r = Math.min(w, h) * 0.12;
        ctx.save();
        ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.03);
        ctx.setLineDash([Math.min(w, h) * 0.10, Math.min(w, h) * 0.07]);
        ctx.strokeStyle = 'rgba(140, 148, 165, 0.85)';
        roundRect(ctx, -w / 2, -h / 2, w, h, r);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(140, 148, 165, 0.55)';
        // núi + mặt trời (biểu tượng "ảnh" tối giản), toạ độ theo nửa cạnh
        const u = Math.min(w, h) / 2;
        ctx.beginPath();
        ctx.arc(-0.28 * u, -0.30 * u, 0.15 * u, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-0.58 * u, 0.42 * u);
        ctx.lineTo(-0.10 * u, -0.12 * u);
        ctx.lineTo(0.22 * u, 0.20 * u);
        ctx.lineTo(0.40 * u, 0.02 * u);
        ctx.lineTo(0.60 * u, 0.42 * u);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    /* Vẽ nội dung một lớp ảnh. ctx đã được dịch sao cho TÂM hộp ở (0,0) và đã áp
     * scale/rotate của hoạt ảnh — y hệt giao ước của GLYPHS.draw. */
    function drawImageLayerContent(ctx, lay, layer, m, box) {
        const img = (lay && typeof lay.imageFor === 'function') ? lay.imageFor(layer, m) : null;
        if (img) {
            /* Ảnh trong library/ vốn đã vuông, nhưng tệp lệch vài pixel là chuyện thường —
               ép vào ĐÚNG hộp vuông thay vì giữ tỉ lệ gốc: hộp là thứ mọi khoảng cách của
               mẫu neo theo, để ảnh tự quyết cỡ thì khe hở đo được sẽ trôi theo từng tệp. */
            try {
                ctx.drawImage(img, -box.w / 2, -box.h / 2, box.w, box.h);
                return;
            } catch (_) { /* ảnh hỏng/chưa decode xong -> rơi xuống ô giữ chỗ */ }
        }
        drawImagePlaceholder(ctx, box.w, box.h);
    }

    /* ===================== XẾP CHỖ (LAYOUT) ================================
     * Hai bước, đúng thứ tự:
     *   1. HỘP CHỮ (flow box) = các lớp place:'flow' xếp DỌC theo thứ tự khai báo,
     *      cách nhau rowGap, căn ngang theo `align` của từng lớp.
     *   2. Các lớp còn lại neo TƯƠNG ĐỐI vào hộp chữ đó.
     * Hộp TĨNH của template = hợp của mọi hộp lớp ở trạng thái nghỉ (scale 1). Đó
     * chính là khung transform mà người dùng thấy khi chọn block, nên nó KHÔNG
     * được phụ thuộc vào thời gian.
     *
     * `tpl.fitWidth` (px@1080, tuỳ chọn) — MẪU TỰ CO CHO VỪA KHỔ
     * ---------------------------------------------------------
     * Mẫu đo từ video CapCut có cỡ chữ CHỐT theo video, và chữ mặc định của chúng đúng
     * là chữ trong video nên không bao giờ lệch khổ. Mẫu "Custom" thì khác: người dùng
     * gõ gì cũng được, mà cỡ chữ lại là một con số cố định — đặt số vừa cho câu mặc định
     * hai dòng (48) thì gõ hai chữ ra hộp bé tí, đặt số to thì câu dài tràn mép khung.
     * Khai `fitWidth` là nói "thiết kế này rộng tối đa bấy nhiêu": layout đo ở cỡ thiết
     * kế rồi CO ĐỀU cả mẫu (một hệ số duy nhất, đúng thứ px_scale vẫn làm) cho tới khi
     * vừa. Cỡ chữ trong layer khi đó là CỠ TỐI ĐA, không phải cỡ cố định.
     *
     * CO ĐỀU CẢ MẪU, KHÔNG RIÊNG CHỮ: cạnh hình Icon/Illus và khe hở sinh ra từ chiều
     * cao hộp chữ (xem measureImageLayer), nên hạ mỗi cỡ chữ là tỉ lệ hình/chữ vỡ.
     *
     * NGÂN SÁCH TÍNH THEO px@1080 × scale, KHÔNG THEO opts.frameW: thumbnail của panel
     * gọi layout với frameW = bề ngang ô 120px, lấy ngân sách theo khung đó là mẫu bị co
     * về 56px rồi drawThumb lại phóng ngược lên — hai phép triệt tiêu nhau và ô xem trước
     * ra sai cỡ. Theo px@1080 thì hệ số co là MỘT con số bất biến với k, nên preview,
     * bản xuất và thumbnail đều ra cùng một bố cục.
     */
    function layout(ctx, tpl, texts, k, opts) {
        const base = layoutAt(ctx, tpl, texts, k, opts);
        const budget = templateFitsItself(tpl) ? (Number(tpl.fitWidth) || 0) * base.scale : 0;
        if (!(budget > 0) || !(base.width > budget)) return base;
        /* Đo LẠI thay vì nhân số đo đã có: bề rộng chữ gần như tuyến tính theo cỡ font
           nhưng không đúng tuyệt đối (làm tròn advance, letter-spacing, hộp ảnh có sàn
           1px), mà mọi khoảng cách của mẫu neo vào hộp đã đo. Cùng cách drawThumb chọn
           hệ số vừa ô — một lượt hiệu chỉnh là đủ. */
        return layoutAt(ctx, tpl, texts, base.scale * (budget / base.width), opts);
    }

    /* Còn tự co được không? Không, nếu người dùng đã tự gõ cỡ chữ cho MỘT lớp chữ bất kỳ
       (cờ do applyTextStyle đặt khi override có `font_size`) — xem lý do ở đó. */
    function templateFitsItself(tpl) {
        return !(tpl.layers || []).some((l) => l && l.kind === 'text' && l.fontSizeLocked);
    }

    function layoutAt(ctx, tpl, texts, k, opts) {
        const scale = Number(k) > 0 ? Number(k) : 1;
        /* ĐO HAI PHA. Pha 1 đo mọi lớp có cỡ TỰ THÂN (chữ, hình vector). Lớp ẢNH phải
           đợi pha 2 vì cạnh của nó tính từ chiều cao HỘP CHỮ — thứ chỉ biết sau khi
           các lớp chữ đã đo xong. Vòng lặp một pha sẽ ra `undefined` ở đúng lớp ảnh. */
        const measured = tpl.layers.map((layer) => {
            if (layer.kind === 'text') return measureTextLayer(ctx, layer, textForSlot(tpl, texts, layer.slot), scale);
            // Lớp ảnh và hình khai `fit` đều lấy cạnh TỪ hộp chữ -> đợi pha 2.
            if (layer.kind === 'image' || layer.fit) return null;
            return measureGlyphLayer(layer, scale);
        });

        // --- 1) hộp chữ ---
        const rowGap = (Number(tpl.rowGap) || 0) * scale;
        /* Lớp ẢNH KHÔNG được xếp vào hộp chữ: cỡ của nó lấy TỪ hộp chữ, cho nó vào hộp
           là vòng tròn (hộp cần cỡ ảnh, cỡ ảnh cần hộp). Lọc ở đây thay vì tin người
           khai template — khai nhầm `place:'flow'` thì nó âm thầm bị bỏ qua ở đây và
           rơi về neo tương đối bên dưới, chứ không làm vỡ phép đo. */
        const flowIdx = tpl.layers.map((l, i) => ((l.place === 'flow' && l.kind !== 'image' && !l.fit) ? i : -1)).filter((i) => i >= 0);
        let flowW = 0;
        let flowH = 0;
        /* Hộp chữ đo NHƯ THỂ MỖI LỚP CHỈ CÓ MỘT DÒNG — mốc cỡ của lớp ảnh (xem baseHeight
           ở measureTextLayer và measureImageLayer). Hình vector (`fit`) KHÔNG dùng mốc này:
           hai thẻ vàng của "Vlog Tag" là bản sao lệch chỗ của chính hộp chữ nên PHẢI trùm
           theo hộp thật, gõ mấy dòng cũng vậy. */
        let flowBaseH = 0;
        flowIdx.forEach((i, n) => {
            flowW = Math.max(flowW, measured[i].width);
            flowH += measured[i].height + (n > 0 ? rowGap : 0);
            flowBaseH += (Number(measured[i].baseHeight) || measured[i].height) + (n > 0 ? rowGap : 0);
        });

        // --- 1b) pha 2: lớp ẢNH (cạnh vuông = bội của chiều cao hộp chữ MỘT DÒNG) ---
        tpl.layers.forEach((layer, i) => {
            if (layer.kind === 'image') measured[i] = measureImageLayer(layer, flowBaseH);
            else if (!measured[i]) measured[i] = measureGlyphLayer(layer, scale, flowW, flowH);
        });

        // Toạ độ tạm: gốc (0,0) = góc trên-trái HỘP CHỮ. Chuẩn hoá về hộp tĩnh ở cuối.
        const boxes = new Array(tpl.layers.length);
        let y = 0;
        flowIdx.forEach((i) => {
            const m = measured[i];
            const align = tpl.layers[i].align || 'center';
            const x = align === 'left' ? 0 : (align === 'right' ? flowW - m.width : (flowW - m.width) / 2);
            boxes[i] = { x, y, w: m.width, h: m.height };
            y += m.height + rowGap;
        });

        /* --- mép MỰC của từng dòng chữ (theo thứ tự xếp dọc) — cho `place.line` ---
         * HỘP CHỮ rộng bằng dòng DÀI NHẤT, nên hình neo theo mép hộp chỉ sát chữ khi
         * dòng của nó ĐÚNG LÀ dòng dài nhất. Ở "Mood Matcha" số đo trên video đúng vì
         * dòng 2 dài hơn dòng 1; gõ một dòng duy nhất là mép hộp trùng mép chữ và bình
         * sữa ĐÈ LÊN chữ. Neo theo MỰC CỦA MỘT DÒNG thì khe luôn là khe đo được, dù
         * người dùng gõ mấy dòng và dòng nào dài hơn. */
        const inkLines = [];
        flowIdx.forEach((i) => {
            const layer = tpl.layers[i];
            if (layer.kind !== 'text') return;
            const m = measured[i];
            m.lines.forEach((_, n) => {
                const left = boxes[i].x + lineInkLeft(layer, m, n);
                inkLines.push({ left, right: left + (m.lineWidths[n] || 0) });
            });
        });
        const inkLineAt = (which) => {
            if (!inkLines.length) return null;
            if (which === 'last') return inkLines[inkLines.length - 1];
            const n = Math.round(Number(which) || 0);
            return inkLines[Math.max(0, Math.min(inkLines.length - 1, n))];
        };

        // --- 2) lớp neo tương đối ---
        tpl.layers.forEach((layer, i) => {
            /* Lớp ẢNH luôn đi đường neo tương đối, kể cả khi bị khai nhầm `place:'flow'`:
               phép xếp hộp chữ ở trên đã loại nó ra (xem lý do ở đó), nên bỏ qua nốt ở đây
               là nó KHÔNG có hộp nào cả -> `boxes[i]` undefined và cả phép đo vỡ. */
            if (layer.place === 'flow' && layer.kind !== 'image' && !layer.fit) return;
            /* LỚP ẢNH: chỗ đậu có thể khai RIÊNG cho từng kiểu (`variants[].place`). Mẫu
               "Custom" cần vậy — Icon đậu tâm vào GÓC TRÊN-TRÁI hộp, Illus canh giữa dọc
               và đè 0.3·Y; hai chỗ đậu khác hẳn nhau nên không gộp được vào một `place`
               chung với vài số bù. Không khai thì về `layer.place`. */
            const vplace = layer.kind === 'image' ? imageVariantOf(layer).place : null;
            const own = (vplace && typeof vplace === 'object') ? vplace : layer.place;
            const p = (own && typeof own === 'object') ? own : {};
            const m = measured[i];
            /* `place.line` (số thứ tự dòng, hoặc 'last') = đổi mốc NGANG từ hộp chữ sang
               hộp MỰC của đúng dòng đó; `fx` khi đó là 0..1 của bề rộng DÒNG. Mốc DỌC vẫn
               là hộp chữ: chiều dọc không có vấn đề này (hộp cao đúng bằng khối chữ). */
            const ref = p.line == null ? null : inkLineAt(p.line);
            /* KHE HỞ THEO CỠ CỦA CHÍNH LỚP (`dxGap`/`dyGap` × `m.gap`) — chỉ lớp ảnh có.
               Ảnh tham chiếu của "Custom" ghi khe theo TỈ LỆ cạnh hình (Icon X/2, Illus
               0.3·Y), mà cạnh ấy lại co giãn theo cỡ chữ; viết khe bằng `dx` px@1080 thì
               tăng cỡ chữ là hình phình ra đè lên chữ còn khe vẫn y nguyên. */
            const gap = Number(m.gap) || 0;
            /* ĐỘ LỆCH NGƯỜI DÙNG (px@1080, chỉ lớp ảnh) — cộng SAU mọi số của thiết kế nên
               nó là "xê dịch so với chỗ đậu gốc", không phải thay chỗ đậu. Nhờ vậy đổi kiểu
               Icon <-> Illus (hai chỗ đậu khác hẳn nhau) vẫn giữ nguyên ý người dùng. */
            const tweak = layer.kind === 'image' ? imageUserTweak(layer) : null;
            const ux = tweak ? tweak.dx * scale : 0;
            const uy = tweak ? tweak.dy * scale : 0;
            const ax = (ref
                ? ref.left + (Number(p.fx) || 0) * (ref.right - ref.left)
                : (Number(p.fx) || 0) * flowW) + (Number(p.dx) || 0) * scale + (Number(p.dxGap) || 0) * gap + ux;
            const ay = (Number(p.fy) || 0) * flowH + (Number(p.dy) || 0) * scale + (Number(p.dyGap) || 0) * gap + uy;
            boxes[i] = {
                x: ax - (Number(p.lx) || 0) * m.width,
                y: ay - (Number(p.ly) || 0) * m.height,
                w: m.width,
                h: m.height,
            };
        });

        // --- hộp tĩnh = hợp mọi hộp lớp; dịch gốc về góc trên-trái của nó ---
        let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
        boxes.forEach((b) => {
            x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
            x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
        });
        if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }
        boxes.forEach((b) => { b.x -= x0; b.y -= y0; });
        const width = Math.max(1, x1 - x0);
        const height = Math.max(1, y1 - y0);

        /* --- lề canvas cho biên độ hoạt ảnh ---
         * Lớp có scale/dịch chuyển vượt ra ngoài hộp tĩnh (chữ zoom từ 12.3x, dấu
         * tích nảy quá 1.11x) sẽ bị XÉN nếu canvas chỉ bằng hộp tĩnh. Lấy mẫu mọi
         * mốc thời gian rồi lấy lề ĐỐI XỨNG quanh tâm — đối xứng vì phần tử
         * preview được canh giữa bằng translate(-50%,-50%): lề lệch là hình bị
         * xê dịch so với khung transform.
         *
         * LỀ TÍNH RIÊNG TỪNG TRỤC, và có TRẦN THEO KHUNG HÌNH. Hai điều đó không
         * phải để cho gọn mà để export chạy nổi: hoạt ảnh của "Approved" phóng chữ
         * lên 12.3x = 8745×1230 px. Tính đủ lề cho nó thì canvas ~9000px và bake 90
         * khung PNG cỡ đó là renderer chết. Nhưng phần chữ NẰM NGOÀI KHUNG HÌNH thì
         * người xem không thấy — chính CapCut cũng chỉ vẽ tới mép khung. Nên trần
         * lề = vừa đủ phủ khung hình (cộng 10% dự phòng cho trường hợp người dùng
         * kéo mẫu ra sát mép hoặc phóng to). Theo trục ngang mẫu này chỉ cần ~130px
         * (khung 1080 rộng hơn hộp tĩnh 916 không nhiều), theo trục dọc cần ~540px
         * để chứa hết chiều cao 1230 của chữ khổng lồ — đúng chỗ MẮT THẤY.
         * opts.frameW/frameH = kích thước Sequence (px). Không truyền -> rơi về
         * khung tham chiếu 1080×1920 (mẫu vốn được thiết kế ở khổ đó). */
        const frameW = Math.max(1, Number(opts && opts.frameW) || REF_SHORT_SIDE * scale);
        const frameH = Math.max(1, Number(opts && opts.frameH) || (REF_SHORT_SIDE * 16 / 9) * scale);
        const capX = Math.max(0, (frameW - width) / 2) + frameW * 0.1;
        const capY = Math.max(0, (frameH - height) / 2) + frameH * 0.1;
        let marginX = 0;
        let marginY = 0;
        const times = sampleTimes(tpl, tpl.duration);
        tpl.layers.forEach((layer, i) => {
            const b = boxes[i];
            const m = measured[i];
            const cx = b.x + b.w / 2;
            const cy = b.y + b.h / 2;
            /* Mực TRÀN ra ngoài hộp (dấu tiếng Việt trên dải chữ hoa, nét thả của g/y)
               phải được cộng vào biên độ, nếu không dấu bị cắt cụt ở mép canvas. Nở đối
               xứng nên lấy giá trị lớn hơn của hai đầu. */
            const inkOver = Math.max(Number(m.overTop) || 0, Number(m.overBottom) || 0);
            const inkSide = Number(m.overSide) || 0;   // viền/bóng tràn ngang
            /* Lớp chạy theo KÝ TỰ: mọi ký tự dùng chung một đường thời gian (chỉ lệch
               pha), nên quét MỘT chu kỳ của đường đó là đã phủ hết biên độ — không cần
               nhân với số ký tự. Biên độ được áp cho CẢ hộp lớp: rộng rãi hơn thực tế
               (ký tự nhỏ hơn hộp) nhưng lề dư thì chỉ tốn vài pixel canvas, còn lề thiếu
               là nét bị xén. */
            const anim = layer.anim;
            const perChar = anim && anim.perChar;
            const scan = perChar ? sampleRange(animTrackEnd(anim)) : times;
            // Mép cắt cố định (nếu có): phần bên trái nó KHÔNG BAO GIỜ được vẽ, nên cũng
            // không cần lề. Thiếu điều này thì lớp chữ trượt vào từ ngoài (dx tới −595px
            // ở "Incorrect") đòi lề bằng cả khung hình, canvas phình ra vô ích.
            const clipX = layer.clip ? b.x + (Number(layer.clip.x0) || 0) * scale : -Infinity;
            // Nghiêng TĨNH cộng vào phép xoay khi tính lề: hộp nghiêng choán chỗ rộng hơn
            // hộp thẳng, thiếu nó là góc hình bị xén ở mép canvas (chỉ lộ ra khi xuất).
            const tilt = Number(layer.tilt) || 0;
            scan.forEach((t) => {
                const st = perChar ? stateFromAnim(anim, t) : layerStateAt(layer, t);
                if (st.hidden || st.opacity <= 0.002) return;
                const hw = (b.w / 2 + inkSide) * st.scale;
                const hh = (b.h / 2 + inkOver) * st.scale;
                const rad = ((st.rot || 0) + tilt) * Math.PI / 180;
                const c = Math.abs(Math.cos(rad));
                const s = Math.abs(Math.sin(rad));
                const ex = hw * c + hh * s;
                const ey = hw * s + hh * c;
                /* Lấy MÉP THẬT của lớp ở trạng thái này (tâm đã dịch theo dx/dy) rồi so
                   với hộp tĩnh. Bản cũ cộng |dx| vào nửa bề rộng và đo quanh tâm TĨNH —
                   an toàn nhưng nở đều hai phía, nên một lớp chỉ trượt sang trái vẫn đòi
                   lề bên phải bằng đúng chừng ấy. Với dx=0 hai cách cho KẾT QUẢ Y HỆT. */
                const left = Math.max(clipX, cx + st.dx * scale - ex);
                const right = cx + st.dx * scale + ex;
                const top = cy + st.dy * scale - ey;
                const bottom = cy + st.dy * scale + ey;
                if (right <= left) return;   // bị mép cắt nuốt trọn
                // Canvas nở ĐỐI XỨNG quanh tâm hộp tĩnh (xem chú thích ở trên).
                marginX = Math.max(marginX, -left, right - width);
                marginY = Math.max(marginY, -top, bottom - height);
            });
        });
        marginX = Math.min(capX, Math.ceil(Math.max(0, marginX)) + 2);
        marginY = Math.min(capY, Math.ceil(Math.max(0, marginY)) + 2);

        /* `imageFor` đi THEO layout chứ không phải tham số của drawFrame: drawFrame được
           gọi ở 4 chỗ (preview, thumbnail panel, PNG tĩnh, chuỗi khung khi xuất) và cả 4
           đều đã cầm sẵn `lay`. Nhét vào đây là bốn đường cùng lấy ảnh từ một nguồn. */
        const imageFor = (opts && typeof opts.imageFor === 'function') ? opts.imageFor : null;
        return { width, height, marginX, marginY, margin: Math.max(marginX, marginY), scale, boxes, measured, imageFor };
    }

    /* ===================== VẼ ============================================== */

    /* Vẽ nội dung MỘT lớp chữ vào hộp của nó (gốc = góc trên-trái hộp).
     * `k` = hệ số quy đổi px@1080 -> px Sequence: MỌI số đo lấy từ layer (bề dày viền,
     * độ lệch/độ nhoè bóng, bo góc nền) đều viết ở lớp 1080 giống cỡ chữ, nên phải nhân
     * k y như measureTextLayer đang làm với font.size. Thiếu phép nhân này thì viền 6px
     * ở khung 4K mảnh đi một nửa so với thiết kế. */
    function drawTextLayerContent(ctx, layer, m, box, k, t, reveal) {
        const scale = Number(k) > 0 ? Number(k) : 1;
        const perChar = !!(layer.anim && layer.anim.perChar) && m.chars && m.chars.length;
        const perCharOrigin = perChar ? (layer.anim.perChar.origin || 'cap') : 'cap';
        /* Nền bo góc — phủ TRỌN hộp lớp (phần đệm đã nằm trong hộp, xem measureTextLayer).
           Với lớp chạy theo ký tự, nền là của LỚP chứ không của ký tự nào: nó KHÔNG trôi
           theo chữ (nếu không, cả tấm nền sẽ nhảy múa), chỉ mượn độ mờ của ký tự ĐẦU TIÊN
           để hiện ra cùng lúc với chữ đầu thay vì chờ sẵn ở đó từ đầu block. */
        if (layer.bg) {
            const a = perChar ? charStateAt(layer, t, 0).opacity : 1;
            if (a > 0.002) {
                /* `radiusRel` = bội của CHIỀU CAO hộp (đi cùng `padXRel`, xem measureTextLayer):
                   bo góc giữ đúng tỉ lệ dù người dùng đổi cỡ chữ hay số dòng. Không khai thì
                   về đường cũ — `radius` là px@1080 nhân k. */
                const radRel = Number(layer.bg.radiusRel) || 0;
                const rawR = radRel > 0 ? radRel * box.h : (Number(layer.bg.radius) || 0) * scale;
                const r = Math.min(rawR, box.w / 2, box.h / 2);
                ctx.save();
                ctx.globalAlpha *= a;
                roundRect(ctx, 0, 0, box.w, box.h, r);
                ctx.fillStyle = layer.bg.color || '#000000';
                ctx.fill();
                ctx.restore();
            }
        }
        ctx.font = m.shorthand;
        try { ctx.letterSpacing = `${m.letter}px`; } catch (_) { /* bỏ qua */ }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const inner = Number(m.innerWidth) || box.w;
        const padX = Number(m.padX) || 0;
        const lineX = (i) => lineInkLeft(layer, m, i) + m.lineLefts[i];
        /* MÉP LỘ DẦN CỦA LỚP CHỮ (`reveal` 0..1 — kiểu "máy đánh chữ" của mẫu "Zoom Title"):
         * một mép CẮT PHẲNG chạy từ trái sang phải qua hộp mực. Khác hẳn hiệu ứng theo ký
         * tự: chữ đang tới bị cắt ĐỨNG giữa thân, đúng như đo được trên video (xem chú thích
         * của mẫu) — perChar không diễn đạt được vì nó chỉ bật/tắt từng ký tự trọn vẹn.
         * ĐẶT SAU phần vẽ nền: nền (thanh màu) hiện NGUYÊN VẸN ngay từ đầu, chỉ chữ mới bị
         * che. Mép cắt lấy theo hộp MỰC (padX..padX+inner) chứ không theo hộp lớp, nếu không
         * phần đệm nền hai bên ăn mất quãng chạy và chữ lộ xong sớm hơn đo được.
         * Nhiều dòng thì cả khối lộ theo MỘT mép chung — mẫu hiện có một dòng; đổi sang
         * "xong dòng này mới tới dòng kia" là đổi hợp đồng, phải đo lại trên video mới. */
        const rv = (reveal == null) ? 1 : Math.max(0, Math.min(1, reveal));
        if (rv < 0.999) {
            ctx.beginPath();
            ctx.rect(-box.w, -box.h, box.w + padX + inner * rv, box.h * 3);
            ctx.clip();
        }
        /* Vẽ MỘT mẩu chữ (cả dòng, hoặc một ký tự) với đủ bóng → viền → thân → gạch.
           Tách ra để hai chế độ (cả dòng / từng ký tự) dùng CHUNG một đường vẽ: nếu viết
           hai bản thì bật hiệu ứng theo ký tự sẽ âm thầm làm mất viền hoặc bóng.

           `phase` = chỉ vẽ MỘT lớp ('shadow' | 'outer' | 'inner' | 'fill'); bỏ trống = vẽ
           cả bốn một lượt. LỚP CHẠY THEO KÝ TỰ PHẢI Vẽ THÀNH TẮNG LỚP CHO CẢ DÒNG: vẽ xong
           hẳn chữ này mới tới chữ sau thì VÒNG VIỀN của chữ sau ĐÈ VÀO thân chữ trước —
           ở "Welcome" viền ngoài dày 29px mà khe giữa hai chữ chỉ 7px, tức nó gặm 22px vào
           chữ trước. Vẽ theo lớp thì các vòng viền hoà thành MỘT đường bao chung, đúng như
           sticker của CapCut. */
        const ringSpec = (spec) => ((spec && (Number(spec.width) || 0) > 0) ? spec : null);
        const outerRing = ringSpec(layer.stroke2);
        const innerRing = ringSpec(layer.stroke);
        const paintRun = (text, x, baseline, inkW, phase) => {
            const want = (p) => !phase || phase === p;
            /* Bóng đổ chỉ đổ MỘT lần, dưới lớp NGOÀI CÙNG được vẽ. Với lớp theo ký tự,
               bóng có pha RIÊNG đi trước mọi nét: bóng của chữ sau vốn đổ đè lên viền chữ
               trước (nó lệch xuống-phải ngay vào đó), đổ hết bóng trước rồi mới vẽ viền thì
               phần bôi bỏ bị chính các nét đó phủ lại. */
            if (layer.shadow && (!phase || phase === 'shadow')) {
                ctx.shadowColor = layer.shadow.color || 'rgba(0,0,0,0.5)';
                ctx.shadowOffsetX = (Number(layer.shadow.dx) || 0) * scale;
                ctx.shadowOffsetY = (Number(layer.shadow.dy) || 0) * scale;
                ctx.shadowBlur = Math.max(0, Number(layer.shadow.blur) || 0) * scale;
            }
            /* VIỀN HAI LỚP (`stroke2` = vòng NGOÀI, `stroke` = vòng trong — mẫu "Mood
               Matcha" có vòng xanh sáng 20px bọc ngoài vòng xanh đậm 13px). Cả hai đều
               tính TỪ MÉP MỰC, không cộng dồn: vẽ vòng ngoài trước với bề dày lớn hơn rồi
               vòng trong đè lên, phần lộ ra của vòng ngoài đúng bằng hiệu hai bề dày. Nhờ
               vậy đổi bề dày vòng trong không làm mép ngoài của cả cụm nhúc nhích. */
            const ring = (spec) => {
                if (!spec) return false;
                ctx.strokeStyle = spec.color || '#000000';
                /* ×2 rồi vẽ stroke TRƯỚC fill: nửa trong của nét bị fill đè, còn lại đúng
                   bề dày người dùng đặt — cùng mẹo với drawTextItemContent của text thường. */
                ctx.lineWidth = (Number(spec.width) || 0) * scale * 2;
                ctx.lineJoin = 'round';
                ctx.miterLimit = 2;
                ctx.strokeText(text, x, baseline);
                return true;
            };
            /* PHA 'shadow': chỉ cần MỘT nét để đổ bóng — lớp ngoài cùng nhìn thấy được. Chính
               nét ấy sẽ được vẽ lại ở pha sau nên vẽ thừa ở đây không đổi hình. */
            if (phase === 'shadow') {
                if (!ring(outerRing) && !ring(innerRing)) {
                    ctx.fillStyle = layer.color || '#ffffff';
                    ctx.fillText(text, x, baseline);
                }
                clearShadow(ctx);
                return;
            }
            if (want('outer') && ring(outerRing)) clearShadow(ctx);
            if (want('inner') && ring(innerRing)) clearShadow(ctx);
            if (!want('fill')) { clearShadow(ctx); return; }
            ctx.fillStyle = layer.color || '#ffffff';
            ctx.fillText(text, x, baseline);
            clearShadow(ctx);
            /* Gạch chân / gạch ngang — cùng vị trí tương đối với text thường, chỉ khác là
               ở đây mốc là BASELINE (mẫu đo theo dải chữ hoa) chứ không phải mép trên dòng. */
            const deco = layer.deco || {};
            if ((deco.underline || deco.strike) && String(text).trim()) {
                const thick = Math.max(1, Math.round(m.size * 0.06));
                ctx.fillStyle = layer.color || '#ffffff';
                if (deco.underline) ctx.fillRect(x, baseline + m.size * 0.14, inkW, thick);
                if (deco.strike) ctx.fillRect(x, baseline - m.size * 0.28, inkW, thick);
            }
        };
        if (!perChar) {
            m.lines.forEach((line, i) => paintRun(line, lineX(i), m.baseline0 + i * m.lineStep, m.lineWidths[i]));
            return;
        }
        /* BỐN LƯỢT QUÉT QUA MỌI KÝ TỰ (xem chú thích `phase` ở paintRun): bóng của mọi chữ
           trước, rồi vòng viền ngoài của mọi chữ, vòng trong, cuối cùng mới tới thân chữ —
           để các vòng viền hoà thành một đường bao chung thay vì chữ sau gặm vào chữ trước. */
        const phases = layer.shadow ? ['shadow', 'outer', 'inner', 'fill'] : ['outer', 'inner', 'fill'];
        phases.forEach((phase) => m.lines.forEach((line, i) => {
            const anchor = lineX(i);
            const baseline = m.baseline0 + i * m.lineStep;
            (m.chars[i] || []).forEach((c) => {
                const st = charStateAt(layer, t, c.index);
                if (st.hidden || st.opacity <= 0.002) return;
                const ax = anchor + c.ax;
                /* Tâm biến đổi của ký tự = tâm hộp MỰC của chính nó theo ngang, và giữa
                   DẢI CHỮ HOA theo dọc. Lấy dải chữ hoa (không phải mực riêng) để chữ có
                   dấu và chữ không dấu cùng xoay/phóng quanh một đường — nếu không, "Ệ"
                   nảy khác "e" ngay trong một từ. */
                const cx = ax + (c.R - c.L) / 2;
                /* GỐC BIẾN ĐỔI THEO CHIỀU DỌC — mặc định là giữa DẢI CHỮ HOA (chữ nở đều
                   hai phía). `perChar.origin:'baseline'` đặt gốc ngay trên BASELINE: chữ
                   mọc LÊN từ dòng kẻ thay vì phình ra hai phía. Đo được ở "Mood Matcha":
                   mép dưới của chữ đứng yên ở baseline+20·s qua từng khung trong khi mép
                   trên đi lên — nếu gốc ở giữa dải chữ hoa thì mép dưới phải đi XUỐNG. */
                const cy = baseline - (perCharOrigin === 'baseline' ? 0 : m.capHeight / 2);
                ctx.save();
                ctx.globalAlpha *= st.opacity;
                ctx.translate(cx + st.dx * scale, cy + st.dy * scale);
                if (st.rot) ctx.rotate(st.rot * Math.PI / 180);
                if (st.scale !== 1) ctx.scale(st.scale, st.scale);
                ctx.translate(-cx, -cy);
                paintRun(c.ch, ax, baseline, c.L + c.R, phase);
                ctx.restore();
            });
        }));
    }

    function clearShadow(ctx) {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
    }

    function roundRect(ctx, x, y, w, h, r) {
        const rr = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }

    /* Vẽ MỘT khung của template vào ctx.
     * Gốc vẽ: (0,0) = góc trên-trái của CANVAS, canvas cỡ (width+2m) × (height+2m)
     * với m = layout.margin — tức hộp tĩnh nằm giữa canvas. Thứ tự phép biến đổi
     * (translate → rotate → scale, gốc = tâm lớp) khớp với transformCssForPreview
     * của editing-runtime để preview DOM và bản bake trùng nhau.
     */
    function drawFrame(ctx, tpl, texts, t, lay) {
        const mx = lay.marginX;
        const my = lay.marginY;
        tpl.layers.forEach((layer, i) => {
            const st = layerStateAt(layer, t);
            if (st.hidden || st.opacity <= 0.002) return;
            const box = lay.boxes[i];
            const meas = lay.measured[i];
            const cx = mx + box.x + box.w / 2 + st.dx * lay.scale;
            const cy = my + box.y + box.h / 2 + st.dy * lay.scale;
            ctx.save();
            /* MÉP CẮT CỐ ĐỊNH: đặt TRƯỚC phép biến đổi của lớp — mép đứng yên còn nội
               dung trượt qua nó, đúng kiểu "chữ chui ra từ sau biểu tượng" của
               "Incorrect"/"Incorrect 2". Đặt sau translate thì mép trôi theo chữ và
               không cắt gì cả. */
            if (layer.clip) {
                const cutX = mx + box.x + (Number(layer.clip.x0) || 0) * lay.scale;
                const W2 = lay.width + 2 * mx;
                const H2 = lay.height + 2 * my;
                ctx.beginPath();
                ctx.rect(cutX, -H2, W2 - cutX + Math.abs(cutX) + W2, 3 * H2);
                ctx.clip();
            }
            ctx.globalAlpha = st.opacity;
            ctx.translate(cx, cy);
            /* Nghiêng TĨNH (`layer.tilt`) đi cùng phép xoay của hoạt ảnh, quanh TÂM hộp
               lớp — hộp tĩnh (thứ layout đo và mọi lớp khác neo theo) không nhúc nhích,
               chỉ nội dung trong hộp nghiêng đi. */
            const rot = (st.rot || 0) + (Number(layer.tilt) || 0);
            if (rot) ctx.rotate(rot * Math.PI / 180);
            if (st.scale !== 1) ctx.scale(st.scale, st.scale);
            if (layer.kind === 'glyph') {
                if (meas.def) meas.def.draw(ctx, box.h / 2, layer.colors || {}, st.reveal, { w: box.w, h: box.h });
            } else if (layer.kind === 'image') {
                drawImageLayerContent(ctx, lay, layer, meas, box);
            } else {
                ctx.translate(-box.w / 2, -box.h / 2);
                drawTextLayerContent(ctx, layer, meas, box, lay.scale, t, st.reveal);
            }
            ctx.restore();
        });
    }

    /* Chữ ký nội dung của một khung: hai khung có cùng chữ ký thì GIỐNG NHAU
     * pixel-for-pixel. Khâu xuất dùng nó để đẩy `null` ("lặp khung trước") thay
     * vì render lại — đúng cơ chế renderAnimationSequence đang dùng cho text.  */
    function frameSignature(tpl, t, texts) {
        return tpl.layers.map((layer) => {
            /* Lớp chạy theo KÝ TỰ: chữ ký phải kể tới TỪNG ký tự, vì lúc chữ thứ 5 đang
               rơi thì trạng thái mức-lớp vẫn là "đứng yên". Bỏ sót là khâu xuất đẩy
               `null` (lặp khung trước) đúng lúc chữ đang chạy -> bản xuất đứng hình. */
            if (layer.kind === 'text' && layer.anim && layer.anim.perChar) {
                const n = charCount(tpl, layer, texts);
                const out = [];
                for (let i = 0; i < n; i += 1) out.push(fmtState(charStateAt(layer, t, i)));
                return out.join(',');
            }
            return fmtState(layerStateAt(layer, t));
        }).join('|');
    }

    function fmtState(st) {
        if (st.hidden) return 'h';
        return `${st.opacity.toFixed(3)},${st.scale.toFixed(4)},${st.dx.toFixed(2)},${st.dy.toFixed(2)},${st.rot.toFixed(2)},${st.reveal.toFixed(4)}`;
    }

    // Số ký tự của một lớp chữ (đếm liên tục qua các dòng, kể cả khoảng trắng — ký tự
    // trắng vẫn CHIẾM một nhịp lệch pha, đúng như CapCut).
    function charCount(tpl, layer, texts) {
        const raw = applyCase(textForSlot(tpl, texts, layer.slot), layer.textCase);
        return splitLines(raw).reduce((n, line) => n + (line.length || 1), 0);
    }

    // Lớp đang ở trạng thái NGHỈ (không mờ, không phóng, không dịch, không xoay).
    function stateIsRest(st) {
        return !st.hidden
            && Math.abs(st.opacity - 1) < 0.005
            && Math.abs(st.scale - 1) < 0.01
            && Math.abs(st.dx) < 0.01 && Math.abs(st.dy) < 0.01 && Math.abs(st.rot) < 0.01
            && st.reveal >= 0.999;   // hình trang trí đã vẽ xong hẳn
    }

    /* Mốc thời gian mà MỌI lớp đã vào cảnh và đứng yên — dùng cho thumbnail của panel
     * và cho ảnh PNG tĩnh dự phòng ở khâu xuất.
     *
     * KHÔNG chỉ là "sau keyframe cuối": lớp LẶP (dấu tích của "Approved" biến mất
     * 0.617→0.8 mỗi chu kỳ) thì phần lớn thời gian sau keyframe cuối lại đúng lúc nó
     * đang ẩn — thumbnail ra một mẫu THIẾU hình trang trí, mà đó lại là thứ nhận diện
     * cả mẫu. Nên: lấy mốc mọi hoạt ảnh MỘT LẦN đã xong, rồi quét về sau tới khi gặp
     * thời điểm mọi lớp cùng ở trạng thái nghỉ. */
    function settleTime(tpl, texts) {
        const duration = Math.max(0.05, Number(tpl.duration) || 3);
        let base = 0;
        let maxPeriod = 0;
        tpl.layers.forEach((layer) => {
            const anim = layer.anim;
            if (!anim) return;
            const last = animTrackEnd(anim);
            const period = Number(anim.period) || 0;
            if (period > 0) { maxPeriod = Math.max(maxPeriod, period); return; }
            /* Lớp theo ký tự xong khi ký tự CUỐI xong, không phải ký tự đầu — với "Correct"
               (7 chữ, lệch pha 1/15s) chênh nhau 0.4s, đủ để thumbnail chụp trúng lúc còn
               nửa chữ đang rơi. */
            const pc = anim.perChar;
            const spread = pc ? Math.max(0, charCount(tpl, layer, texts) - 1) * (Number(pc.stagger) || 0) : 0;
            base = Math.max(base, (Number(anim.delay) || 0) + spread + last);
        });
        const limit = Math.min(duration - 0.01, base + maxPeriod + 0.05);
        /* Đòi trạng thái nghỉ ở CẢ t lẫn t + 1/20s: lớp đang nảy có lúc đi NGANG qua
           đúng 1.0 (dấu tích vọt từ 0.92 lên 1.11 nên cắt 1.0 giữa đường). Lấy trúng
           khoảnh khắc đó thì thumbnail vẫn đúng cỡ nhưng chỉ là tình cờ — mốc phải nằm
           trên ĐOẠN GIỮ mới ổn định khi ai đó chỉnh lại keyframe. */
        for (let t = base; t <= limit + 1e-9; t += 1 / 120) {
            const rest = (tt) => tpl.layers.every((layer) => stateIsRest(layerStateAt(layer, tt)));
            if (rest(t) && rest(Math.min(limit, t + 0.05))) return t;
        }
        return Math.min(base + 0.02, Math.max(0.02, duration - 0.02));
    }

    /* ===================== NỘI DUNG CÁC Ô CHỮ ============================== */

    function textForSlot(tpl, texts, slotId) {
        const idx = tpl.slots.findIndex((s) => s.id === slotId);
        if (idx < 0) return '';
        const raw = Array.isArray(texts) ? texts[idx] : null;
        return (raw == null || raw === '') ? (tpl.slots[idx].default || '') : String(raw);
    }

    function defaultTexts(tpl) {
        return tpl.slots.map((s) => s.default || '');
    }

    /* Chuẩn hoá mảng nội dung về đúng số ô của template (dự án cũ / template đổi).
     *
     * MẪU TỪNG CÓ NHIỀU Ô MÀ NAY GỘP THÀNH MỘT ("Mood Matcha" đổi hai ô "Dòng 1"/"Dòng 2"
     * thành MỘT ô xuống dòng): mảng cũ dài hơn số ô hiện tại, và phần dư là CHỮ NGƯỜI DÙNG
     * ĐÃ GÕ — cắt đi là mở lại dự án cũ thì mất hẳn một dòng. Nối nó vào ô CUỐI bằng ký tự
     * xuống dòng, đúng nghĩa mới của ô đó. Chỉ làm khi mẫu tự khai `mergeLegacyTexts`: một
     * mẫu bớt ô vì lý do khác (ô đó bị bỏ hẳn) thì không được âm thầm dồn chữ lạ vào nhau. */
    function normalizeTexts(tpl, texts) {
        const arr = Array.isArray(texts) ? texts : [];
        const out = tpl.slots.map((s, i) => {
            const raw = arr[i];
            return raw == null ? (s.default || '') : String(raw);
        });
        const n = tpl.slots.length;
        if (tpl.mergeLegacyTexts && n > 0 && arr.length > n) {
            const extra = arr.slice(n)
                .map((v) => (v == null ? '' : String(v)))
                .filter((v) => v.trim() !== '');
            if (extra.length) {
                out[n - 1] = [out[n - 1], ...extra].filter((v) => v !== '').join('\n');
            }
        }
        return out;
    }

    // Font cần nạp trước khi đo/vẽ (document.fonts.load) — thiếu bước này thì lần
    // vẽ đầu ra font dự phòng, hộp đo sai và khung PNG đầu tiên bị lệch.
    function fonts(tpl) {
        const out = [];
        const seen = new Set();
        tpl.layers.forEach((layer) => {
            if (layer.kind !== 'text' || !layer.font) return;
            const style = layer.font.italic ? 'italic' : 'normal';
            const key = `${style} ${layer.font.weight || 400} ${layer.font.family}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({ family: layer.font.family, weight: layer.font.weight || 400, style, size: layer.font.size || 60 });
        });
        return out;
    }

    /* ===================== NGƯỜI DÙNG SỬA THÔNG SỐ CỦA MẪU ==================
     * Mẫu mang một THIẾT KẾ đo từ video CapCut, nhưng người dùng vẫn phải đổi được
     * font/cỡ/màu/viền/nền/bóng của từng lớp chữ và màu của hình trang trí — đúng
     * những thứ họ chỉnh được ở một Text block thường.
     *
     * CÁCH LÀM: thiết kế gốc KHÔNG bị sửa. Mỗi lớp có một KHOÁ ổn định (layerKey) và
     * item mang một bảng `overrides[khoá] = {…}`. Trước khi đo/vẽ, resolve() trộn
     * override lên bản gốc và trả về MỘT template mới — engine phía sau (layout,
     * drawFrame, frameSignature, fonts) không biết gì về override, vẫn chỉ thấy một
     * template bình thường. Nhờ vậy:
     *   · dự án cũ (không có overrides) chạy y nguyên — trộn với {} = bản gốc;
     *   · sửa lại số đo của mẫu trong thư viện vẫn tự lan sang mọi phần override
     *     mà người dùng KHÔNG động tới (override chỉ ghi đè khoá đã đổi… xem dưới).
     *
     * ĐƠN VỊ: style của override viết Ở LỚP 1080 y như thiết kế gốc (cỡ chữ 147.4,
     * viền 6px…). Không phải px của Sequence. Đổi độ phân giải Sequence chỉ đụng
     * `template.px_scale` -> cả mẫu lẫn phần người dùng chỉnh cùng phóng theo, không
     * có con số nào bị quy đổi hai lần.
     *
     * HÌNH DẠNG style: TRÙNG với style của Text block thường (font_family, font_size,
     * stroke_enabled…) — cố ý, để panel Thuộc tính dùng lại NGUYÊN các control và
     * preset Text Style sẵn có thay vì đẻ ra một bộ ô nhập thứ hai.
     */

    // Khoá của một lớp: ổn định qua các lần lưu/mở dự án. Lớp chữ lấy tên ô chữ.
    function layerKey(layer, index) {
        if (layer && layer.key) return String(layer.key);
        if (layer && layer.kind === 'text' && layer.slot) return String(layer.slot);
        return `layer${index}`;
    }

    function hexToRgba(hex, opacityPct) {
        const a = Math.max(0, Math.min(1, (opacityPct == null ? 100 : Number(opacityPct)) / 100));
        if (a >= 1) return hex || '#000000';
        const h = String(hex || '#000000').replace('#', '');
        const r = parseInt(h.substring(0, 2), 16);
        const g = parseInt(h.substring(2, 4), 16);
        const b = parseInt(h.substring(4, 6), 16);
        if ([r, g, b].some(Number.isNaN)) return hex || '#000000';
        return `rgba(${r}, ${g}, ${b}, ${a})`;
    }

    // Phần đệm của nền bo góc, theo cỡ chữ (giống text thường: padding ~0.28 cỡ chữ).
    const BG_PAD_X = 0.28;
    const BG_PAD_Y = 0.22;

    // Đệm trên/dưới của một `bg`: mẫu khai `padTop`/`padBottom` khi hộp nền KHÔNG cân đối
    // (xem measureTextLayer), khai `padY` khi cân đối. Một chỗ đọc duy nhất cho cả hai.
    function bgPad(bg, side) {
        if (!bg) return 0;
        return Number(bg[side] != null ? bg[side] : bg.padY) || 0;
    }

    /* Style "gốc" của một lớp chữ, viết ở HÌNH DẠNG của text thường. Đây là giá trị
       Inspector hiện ra khi người dùng chưa đổi gì — tức thiết kế của mẫu, không phải
       mặc định trắng 64px của một textbox mới. */
    function layerTextStyle(layer) {
        const font = (layer && layer.font) || {};
        const size = Number(font.size) || 60;
        const stroke = layer && layer.stroke;
        const bg = layer && layer.bg;
        const shadow = layer && layer.shadow;
        return {
            font_family: font.family || 'Roboto',
            font_weight: Number(font.weight) || 400,
            /* CHỮ NGHIÊNG cũng phải là một khoá style, y như phần đệm nền ở dưới: panel
               không có ô nhập cho nó, nhưng applyTextStyle dựng lại `font` từ style — thiếu
               khoá này thì chỉ cần đổi màu chữ là "Folgen Sie" hết nghiêng. */
            font_italic: !!font.italic,
            font_size: size,
            letter_spacing: size > 0 ? ((Number(font.letter) || 0) / size) * 100 : 0,
            line_height: 'auto',
            color: (layer && layer.color) || '#ffffff',
            align: (layer && layer.align) || 'center',
            text_case: (layer && layer.textCase) || 'none',
            deco_underline: !!(layer && layer.deco && layer.deco.underline),
            deco_strike: !!(layer && layer.deco && layer.deco.strike),
            stroke_enabled: !!(stroke && (Number(stroke.width) || 0) > 0),
            stroke_color: (stroke && stroke.color) || '#000000',
            stroke_width: (stroke && Number(stroke.width)) || 6,
            /* VÒNG VIỀN NGOÀI (mẫu "Mood Matcha"): panel không có ô nhập cho nó, nhưng nó
               PHẢI là khoá style — applyTextStyle dựng lại phần viền từ style, thiếu khoá
               này thì chỉ cần đổi màu chữ là mất vòng ngoài. Cùng lý do với bg_pad_*. */
            stroke2_color: (layer && layer.stroke2 && layer.stroke2.color) || '#000000',
            stroke2_width: (layer && layer.stroke2 && Number(layer.stroke2.width)) || 0,
            bg_enabled: !!bg,
            bg_color: (bg && bg.color) || '#000000',
            bg_radius: bg && bg.radius != null ? Number(bg.radius) : 8,
            bg_opacity: bg && bg.opacity != null ? Number(bg.opacity) : 100,
            /* PHẦN ĐỆM NỀN CŨNG LÀ MỘT KHOÁ STYLE, tính theo % cỡ chữ. Panel không có ô
               nhập cho nó (người dùng không cần), nhưng nó PHẢI đi qua đây: applyTextStyle
               dựng lại `bg` từ style, nên nếu style không mang phần đệm thì chỉ cần đổi
               màu chữ là hộp nền của "Quote" nhảy từ (39, 9/18) về tỉ lệ mặc định
               (0.28/0.22 cỡ chữ) — mất luôn số đo lấy từ video. Theo % cỡ chữ để người
               dùng đổi cỡ chữ thì hộp nền vẫn nở đúng tỉ lệ thiết kế. */
            bg_pad_x: bg && bg.padX != null && size > 0 ? (Number(bg.padX) / size) * 100 : BG_PAD_X * 100,
            bg_pad_top: bg && size > 0 ? (bgPad(bg, 'padTop') / size) * 100 : BG_PAD_Y * 100,
            bg_pad_bottom: bg && size > 0 ? (bgPad(bg, 'padBottom') / size) * 100 : BG_PAD_Y * 100,
            /* Hai khoá TỈ LỆ THEO CHIỀU CAO HỘP (mẫu "Custom"). Cùng lý do với bg_pad_*:
               applyTextStyle dựng lại `bg` từ style, không mang theo thì chỉ cần đổi màu
               chữ là hộp trắng mất bo góc và cột đệm trái co lại — hình Icon đè lên chữ.
               Là TỈ LỆ sẵn nên đi thẳng, không quy về % cỡ chữ như mấy khoá trên. */
            bg_pad_x_rel: (bg && Number(bg.padXRel)) || 0,
            bg_radius_rel: (bg && Number(bg.radiusRel)) || 0,
            shadow_enabled: !!shadow,
            shadow_color: (shadow && shadow.color) || '#000000',
            shadow_dx: (shadow && Number(shadow.dx)) || 0,
            shadow_dy: (shadow && Number(shadow.dy)) || 4,
            shadow_blur: (shadow && Number(shadow.blur)) || 8,
            shadow_opacity: shadow && shadow.opacity != null ? Number(shadow.opacity) : 100,
        };
    }

    function layerGlyphColors(layer) {
        const def = layer && GLYPHS[layer.glyph];
        const out = {};
        ((def && def.colorKeys) || []).forEach((c) => { out[c.key] = c.fallback; });
        Object.assign(out, (layer && layer.colors) || {});
        return out;
    }

    /* Danh sách lớp mà panel Thuộc tính bày ra cho người dùng. UI đọc CHÍNH cái này,
       không tự đoán theo id mẫu — thêm mẫu/lớp mới là panel tự có mục tương ứng. */
    function editableLayers(tpl) {
        if (!tpl || !Array.isArray(tpl.layers)) return [];
        return tpl.layers.map((layer, index) => {
            const key = layerKey(layer, index);
            if (layer.kind === 'text') {
                const slot = (tpl.slots || []).find((s) => s.id === layer.slot);
                return {
                    index, key, kind: 'text',
                    label: layer.label || (slot && slot.label) || `Chữ ${index + 1}`,
                    slot: layer.slot,
                    style: layerTextStyle(layer),
                };
            }
            if (layer.kind === 'image') {
                /* Panel Thuộc tính dựng ô chọn hình từ CHÍNH mục này (kể cả danh sách kiểu
                   và tiền tố tên tệp để lọc thư viện) — không hard-code "Icon"/"Illus" ở
                   phía UI, nên thêm một kiểu mới chỉ phải sửa template. */
                const v = imageVariantOf(layer);
                return {
                    index, key, kind: 'image',
                    label: layer.label || 'Hình',
                    variant: v.key,
                    variants: Object.keys(layer.variants || {}).map((vk) => ({
                        key: vk,
                        label: (layer.variants[vk] || {}).label || vk,
                        prefix: (layer.variants[vk] || {}).prefix || '',
                    })),
                    prefix: v.prefix || '',
                    src: layer.src || '',
                    name: layer.name || '',
                    // Cỡ và độ lệch người dùng đã chỉnh (mặc định = đúng thiết kế gốc).
                    scale: clampArtScale(layer.artScale),
                    dx: Number(layer.artDx) || 0,
                    dy: Number(layer.artDy) || 0,
                    scaleMin: ART_SCALE_MIN,
                    scaleMax: ART_SCALE_MAX,
                };
            }
            const def = GLYPHS[layer.glyph] || {};
            return {
                index, key, kind: 'glyph',
                label: layer.label || def.label || 'Biểu tượng',
                colorKeys: (def.colorKeys || []).map((c) => ({ key: c.key, label: c.label })),
                colors: layerGlyphColors(layer),
            };
        });
    }

    // Bảng override "rỗng" (= đúng thiết kế gốc) — dùng để dựng Inspector lần đầu.
    function defaultOverrides(tpl) {
        const out = {};
        editableLayers(tpl).forEach((info) => {
            if (info.kind === 'text') out[info.key] = { ...info.style };
            else if (info.kind === 'image') {
                out[info.key] = {
                    variant: info.variant, src: info.src, name: info.name,
                    scale: info.scale, dx: info.dx, dy: info.dy,
                };
            }
            else out[info.key] = { ...info.colors };
        });
        return out;
    }

    /* Một khoá "% cỡ chữ" của style: dự án CŨ không có các khoá đệm nền nên phải rơi về
       mặc định thay vì ra NaN (NaN thì hộp nền biến mất và cả mẫu trôi chỗ). */
    function pct(value, fallback) {
        // null/'' phải rơi về mặc định: `Number(null)` ra 0 (không phải NaN) nên nếu chỉ
        // xét isFinite thì một khoá bỏ trống sẽ thành "đệm 0" và hộp nền dính sát chữ.
        if (value == null || value === '') return fallback;
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    // Trộn override của MỘT lớp chữ lên bản gốc -> layer mới đúng hình dạng engine.
    function applyTextStyle(layer, patch) {
        const st = { ...layerTextStyle(layer), ...(patch || {}) };
        const size = Math.max(1, Number(st.font_size) || 60);
        const lh = st.line_height;
        const lineStep = (lh === undefined || lh === null || lh === 'auto' || lh === '' || !(Number(lh) > 0))
            ? (Number(layer.font && layer.font.lineStep) || 1.15)
            : Number(lh) / size;
        const next = {
            ...layer,
            font: {
                family: st.font_family,
                weight: Number(st.font_weight) || 400,
                italic: !!st.font_italic,
                size,
                letter: (size * (Number(st.letter_spacing) || 0)) / 100,
                lineStep,
            },
            color: st.color,
            align: st.align || 'center',
            textCase: st.text_case && st.text_case !== 'none' ? st.text_case : null,
            deco: { underline: !!st.deco_underline, strike: !!st.deco_strike },
            /* NGƯỜI DÙNG TỰ GÕ CỠ CHỮ -> TẮT phép tự co (`tpl.fitWidth`, xem layout).
               Ô "Cỡ chữ" trong panel phải là con số THẬT: để phép co vẫn chạy thì gõ 60
               hay 120 đều ra cùng một kết quả (cả hai đều bị kéo về đúng khổ) — người
               dùng gõ mà không thấy gì đổi. Tự co là THIẾT KẾ MẶC ĐỊNH của mẫu; gõ số
               là người dùng giành quyền, và giành rồi thì phải được nghe. */
            fontSizeLocked: (patch || {}).font_size !== undefined,
        };
        next.stroke = (st.stroke_enabled && (Number(st.stroke_width) || 0) > 0)
            ? { color: st.stroke_color || '#000000', width: Number(st.stroke_width) || 0 }
            : null;
        /* Vòng ngoài đi theo CÙNG một công tắc "Viền" của panel: tắt viền mà còn trơ lại
           vòng xanh sáng bọc ngoài chỗ trống là thứ người dùng không hiểu nổi. */
        next.stroke2 = (st.stroke_enabled && (Number(st.stroke2_width) || 0) > 0)
            ? { color: st.stroke2_color || '#000000', width: Number(st.stroke2_width) || 0 }
            : null;
        next.bg = st.bg_enabled
            ? {
                color: hexToRgba(st.bg_color || '#000000', st.bg_opacity),
                radius: Number(st.bg_radius) || 0,
                padX: size * (pct(st.bg_pad_x, BG_PAD_X * 100) / 100),
                padTop: size * (pct(st.bg_pad_top, BG_PAD_Y * 100) / 100),
                padBottom: size * (pct(st.bg_pad_bottom, BG_PAD_Y * 100) / 100),
                // Tỉ lệ theo chiều cao hộp — xem bg_pad_x_rel / bg_radius_rel ở layerTextStyle.
                padXRel: Number(st.bg_pad_x_rel) || 0,
                radiusRel: Number(st.bg_radius_rel) || 0,
            }
            : null;
        next.shadow = st.shadow_enabled
            ? {
                color: hexToRgba(st.shadow_color || '#000000', st.shadow_opacity),
                dx: Number(st.shadow_dx) || 0,
                dy: Number(st.shadow_dy) || 0,
                blur: Math.max(0, Number(st.shadow_blur) || 0),
            }
            : null;
        return next;
    }

    /* Template ĐÃ TRỘN override. Trả về object cùng hình dạng template gốc (kể cả `id`),
       nên mọi hàm còn lại của engine nhận nó như một template bình thường. */
    function resolve(tpl, overrides) {
        if (!tpl) return null;
        if (!overrides || !Object.keys(overrides).length) return tpl;
        return {
            ...tpl,
            layers: tpl.layers.map((layer, index) => {
                const patch = overrides[layerKey(layer, index)];
                if (!patch) return layer;
                if (layer.kind === 'text') return applyTextStyle(layer, patch);
                /* LỚP ẢNH chỉ nhận ĐÚNG SÁU khoá. Trộn thẳng cả patch vào layer (kiểu
                   `{...layer, ...patch}`) thì một bảng override cũ/hỏng có thể ghi đè
                   `variants`, `place`, `anim` — tức hình học của mẫu vỡ mà không có đường
                   nào lấy lại. Kiểu không có trong bảng `variants` cũng bị bỏ qua.
                   Ba khoá THÊM 2026-09-16 (người dùng chốt: phải chỉnh được cỡ và chỗ đặt
                   của Icon/Illus trong bảng thông số):
                     · `scale` — % so với cạnh thiết kế (100 = đúng thiết kế);
                     · `dx`/`dy` — xê dịch px@1080 so với CHỖ ĐẬU GỐC, không thay chỗ đậu.
                   Đổi tên khi ghi vào layer (`artScale/artDx/artDy`) để không đụng `place`
                   và để đọc code là biết ngay đây là ý người dùng, không phải số thiết kế. */
                if (layer.kind === 'image') {
                    const next = { ...layer };
                    if (patch.variant && (layer.variants || {})[patch.variant]) next.variant = patch.variant;
                    if (patch.src !== undefined) next.src = String(patch.src || '');
                    if (patch.name !== undefined) next.name = String(patch.name || '');
                    if (patch.scale !== undefined) next.artScale = clampArtScale(patch.scale);
                    if (patch.dx !== undefined) next.artDx = Number(patch.dx) || 0;
                    if (patch.dy !== undefined) next.artDy = Number(patch.dy) || 0;
                    return next;
                }
                return { ...layer, colors: { ...layerGlyphColors(layer), ...patch } };
            }),
        };
    }

    /* ========================================================================
     *                            THƯ VIỆN TEMPLATE
     * ===================================================================== */

    /* Quãng trượt của KHỐI CHỮ mẫu "Quote" (px@1080 theo từng khung 30fps).
     * Hai dòng dùng CHUNG một mảng vì video cho thấy chúng trượt CÙNG một quãng: mép phải
     * hộp nền dòng 1 (999+dx) và dòng 2 (818+dx) đo ở từng khung ra đúng cùng một dx tới
     * từng pixel. Nhờ dùng chung mà dòng ngắn hơn tự lộ ra MUỘN hơn — đúng như video, chứ
     * không phải hai đường thời gian lệch nhau. */
    const QUOTE_SLIDE_DX = [
        [0, -668], [1 / 30, -597], [2 / 30, -530], [3 / 30, -467],
        [4 / 30, -408], [5 / 30, -352], [6 / 30, -300], [7 / 30, -252],
        [8 / 30, -208], [9 / 30, -167], [10 / 30, -130], [11 / 30, -97],
        [12 / 30, -69], [13 / 30, -45], [14 / 30, -26], [15 / 30, -12],
        [16 / 30, -3], [17 / 30, 0],
    ];

    // Lớp chữ của "Quote": hai dòng CÙNG một thiết kế, chỉ khác ô chữ. Viết một lần để
    // hai dòng không thể lệch nhau khi ai đó chỉnh lại số đo.
    function quoteTextLayer(slot) {
        return {
            kind: 'text',
            slot,
            place: 'flow',
            align: 'left',
            color: '#000000',
            font: { family: 'Inter', weight: 500, size: 79.87, letter: 3.355, lineStep: 1.25 },
            bg: { color: '#ffffff', radius: 0, padX: 37, padTop: 9, padBottom: 18 },
            clip: { x0: -4 },
            anim: { delay: 11 / 30, tracks: { dx: QUOTE_SLIDE_DX } },
        };
    }

    /* NHỊP ĐẬP của ba nét nhấn ("Folgen Sie"): bật/tắt CỨNG giữa hai trạng thái, mỗi
     * trạng thái giữ đúng `half` giây. Video đo được các đoạn 6 khung mà TRONG mỗi đoạn
     * giá trị giống hệt nhau tới 0.1px (khung 36-41 trong, 42-47 ngoài, 48-53 trong…) —
     * tức là một sticker 2 khung chạy 5fps, không phải chuyển động được nội suy.
     *
     * VÌ SAO KHÔNG DÙNG `anim.period`: period quay vòng TOÀN BỘ thời gian cục bộ của lớp,
     * tức là quay vòng luôn cả track `scale` vào cảnh — nét nhấn sẽ phóng lại từ 0 mỗi
     * 0.4s. Ở đây một track lặp còn một track chạy một lần, nên nhịp đập được rải thẳng
     * thành keyframe phủ trọn thời lượng.
     * BẬC THANG DỰNG BẰNG CÁCH KẾT THÚC SỚM 0.1ms: mỗi trạng thái giữ từ `i·half` tới
     * `(i+1)·half − EPS`, trạng thái sau bắt đầu đúng tại `(i+1)·half`. KHÔNG dùng hai
     * keyframe TRÙNG mốc: trackAt lấy đoạn ĐẦU TIÊN có t1 ≥ t, nên ở đúng mốc nó vẫn trả
     * giá trị CŨ — nhịp đập sẽ trễ một khung so với video. Đoạn dốc 0.1ms ngắn hơn 1/120s
     * (bước lấy mẫu của sampleTimes) nên trên thực tế vẫn là bật/tắt cứng. */
    function emphasisPulseTrack(duration, delay, half) {
        const EPS = 1e-4;
        const out = [];
        for (let i = 0; i * half < duration - delay; i += 1) {
            out.push([i * half, i % 2], [(i + 1) * half - EPS, i % 2]);
        }
        return out;
    }

    /* Đường phóng vào của MỘT ký tự ("Folgen Sie"): lớn dần từ 0 rồi NẢY DỘI TẮT DẦN quanh
     * 1. Đo bằng chiều cao mực chữ 'F' (ký tự đầu, không bị ký tự khác dính vào) chia cho
     * chiều cao lúc đứng yên 155, từng khung một; mốc 0 = khung 14 của video.
     * Kiểm chéo bằng DIỆN TÍCH mực (phải tỉ lệ s²): √A khung22/khung26 = 1.208 so với tỉ lệ
     * chiều cao 1.193 — đúng là phóng thật, không phải nhiễu ngưỡng nhị phân.
     * Tâm phóng là TÂM KÝ TỰ: mép trên và mép dưới của 'F' nở đều quanh y≈949 qua từng
     * khung, không phải nở về một phía. */
    const FOLGEN_CHAR_SCALE = [
        [0, 0], [1 / 30, 0.185], [2 / 30, 0.368], [3 / 30, 0.548], [4 / 30, 0.723],
        [5 / 30, 0.897], [6 / 30, 1.084], [7 / 30, 1.129], [8 / 30, 1.077], [9 / 30, 1.032],
        [10 / 30, 0.987], [11 / 30, 0.942], [12 / 30, 0.903], [13 / 30, 0.929], [14 / 30, 0.961],
        [15 / 30, 0.987], [16 / 30, 1.013], [17 / 30, 1.052], [18 / 30, 1.032], [19 / 30, 1.006],
        [20 / 30, 0.981], [21 / 30, 0.955], [22 / 30, 0.961], [23 / 30, 0.981], [24 / 30, 1.006],
        [25 / 30, 1.026], [26 / 30, 1.026], [27 / 30, 1.019], [28 / 30, 1.006], [29 / 30, 1],
    ];

    /* Đường phóng vào của cả cụm nét nhấn. Đo bằng CHIỀU DÀI nét thứ 3 (chia cho 66.5 lúc
     * đứng yên) — chọn chiều dài chứ không phải hộp bao vì chiều dài KHÔNG đổi theo nhịp
     * đập, còn hộp bao thì có. Mốc 0 = khung 24 của video. */
    const FOLGEN_SPARK_SCALE = [
        [0, 0], [1 / 30, 0.12], [2 / 30, 0.229], [3 / 30, 0.334], [4 / 30, 0.433],
        [5 / 30, 0.535], [6 / 30, 0.620], [7 / 30, 0.698], [8 / 30, 0.770], [9 / 30, 0.842],
        [10 / 30, 0.901], [11 / 30, 0.956], [12 / 30, 0.999], [13 / 30, 1.035], [14 / 30, 1.072],
        [15 / 30, 1.086], [16 / 30, 1.101], [17 / 30, 1.101], [18 / 30, 1.093], [19 / 30, 1.071],
        [20 / 30, 1.047], [21 / 30, 1.038], [22 / 30, 1.033], [23 / 30, 1.024], [24 / 30, 1.012],
        [25 / 30, 1.008], [26 / 30, 1.006], [27 / 30, 1.003], [28 / 30, 1.002], [29 / 30, 1],
    ];

    /* Hệ số phóng của chữ lớn ("Zoom Title"), khung 14..28 của video, mốc 0 = khung 13.
     * CÁCH ĐO — nền video ĐỘNG mạnh (người mẫu nghiêng đầu) nên phép trừ nền cho ra rác:
     * lấy MẶT NẠ chữ lúc đứng yên, phóng quanh tâm (540.5, 923) theo hệ số thử rồi chấm
     * điểm bằng ĐỘ CHÊNH độ sáng trong nét / ngoài nét — hệ số đúng cho chênh lớn nhất
     * (đỉnh rất nhọn: chênh 178..204 ở hệ số trúng, tụt hẳn khi lệch 3%).
     * Khung 13 chữ có mặt nhưng ĐỘ MỜ BẰNG 0 nên không đo được hệ số; mốc t=0 lấy bằng
     * khung 14 (trackAt kẹp ở keyframe đầu) — vô hình nên không ảnh hưởng hình. */
    const ZOOM_TITLE_SCALE = [
        [0, 9.729], [1 / 30, 9.729], [2 / 30, 9.541], [3 / 30, 9.223], [4 / 30, 8.797],
        [5 / 30, 8.277], [6 / 30, 7.712], [7 / 30, 6.921], [8 / 30, 6.091], [9 / 30, 5.227],
        [10 / 30, 4.433], [11 / 30, 3.672], [12 / 30, 2.956], [13 / 30, 2.264], [14 / 30, 1.613],
        [15 / 30, 1],
    ];

    /* Đường phóng vào của MỘT ký tự ("Mood Matcha"), mốc 0 = lúc ký tự đó bắt đầu.
     * Đo trên chữ 'M' đầu DÒNG 2 — nó là cụm RỜI trong 5 khung đầu nên bề rộng cụm chính
     * là bề rộng chữ, không dính chữ bên cạnh (dòng 1 cho dãy khớp trong sai số 0.03).
     * Δ1..Δ5 là số đo; đoạn sau Δ5 không tách được khỏi phép DỒN DÒNG của video (xem chú
     * thích của mẫu) nên lấy đường lắng trơn từ đỉnh 1.06 về đúng 1. */
    const MATCHA_CHAR_SCALE = [
        [0, 0], [1 / 30, 0.26], [2 / 30, 0.51], [3 / 30, 0.78], [4 / 30, 0.93],
        [5 / 30, 1.03], [6 / 30, 1.06], [7 / 30, 1.04], [8 / 30, 1.02], [9 / 30, 1],
    ];

    /* Lớp chữ DUY NHẤT của "Mood Matcha" — MỘT ô nội dung, hai dòng là phép XUỐNG DÒNG
     * trong chính ô đó (người dùng sửa số dòng bằng Enter, không bị khoá ở đúng hai ô).
     * `lineStep` = 218/206.993 = 1.0532 để hai baseline cách nhau đúng 218px như đo trên
     * video; nhờ vậy hộp lớp cao 148 + 218 = 366 — Y HỆT tổng của hai hộp cũ (148+70+148),
     * nên bình sữa và vệt nhấn neo theo hộp vẫn nằm đúng chỗ đo được. */
    function matchaTextLayer(slot, delay) {
        return {
            kind: 'text',
            slot,
            place: 'flow',
            align: 'center',
            color: '#ffffff',
            font: { family: 'Nunito', weight: 900, size: 206.993, letter: -0.462, lineStep: 218 / 206.993 },
            stroke: { color: '#304227', width: 13 },
            stroke2: { color: '#69eb03', width: 20 },
            anim: {
                delay,
                perChar: { stagger: 0.1, origin: 'baseline' },
                tracks: { scale: MATCHA_CHAR_SCALE },
            },
        };
    }

    /* ĐƯỜNG "NẢY RỒI LẮC GIẢM DẦN" (damped oscillation), dựng bằng CÔNG THỨC thay vì
     * gõ tay từng keyframe:
     *     v(t) = to + (from − to) · e^(−t/τ) · cos(2π·t / T)
     * τ = hằng số tắt dần (giây; càng nhỏ càng tắt nhanh), T = chu kỳ một nhịp lắc.
     *
     * VÌ SAO SINH BẰNG CÔNG THỨC — ngược hẳn với mọi mẫu khác trong file này, nơi
     * keyframe là SỐ ĐO TỪNG PIXEL trên video CapCut và tuyệt đối không được "làm mượt":
     * mẫu "Custom" KHÔNG có video mẫu để đo, chuyển động là do ta thiết kế. Thứ cần chốt
     * ở đây là ĐẶC TÍNH VẬT LÝ (biên độ đầu, tốc độ tắt, nhịp lắc) — ba con số ấy đọc ra
     * ngay ở chỗ gọi, trong khi 90 cặp số chép tay thì không ai sửa nổi và rất dễ gõ lệch
     * một giá trị giữa dãy mà mắt không bắt được.
     *
     * KEYFRAME CUỐI ĐƯỢC ÉP VỀ ĐÚNG `to`: hàm mũ chỉ tiệm cận chứ không bao giờ chạm 0,
     * mà stateIsRest() đòi |scale−1| < 0.01 và |rot| < 0.01 mới coi là "đã đứng yên" —
     * thiếu điểm chốt này thì settleTime() không tìm được mốc nghỉ (thumbnail lấy sai
     * khung) và khâu xuất không gộp được khung nào. Chọn `dur` sao cho phần dư ngay
     * trước điểm chốt đã nhỏ hơn ngưỡng ấy nhiều lần thì cú "nhảy về 0" là vô hình.
     */
    function dampedTrack(from, to, tau, period, dur, step) {
        const dt = Number(step) || 1 / 60;
        const out = [];
        for (let t = 0; t < dur - 1e-9; t += dt) {
            const v = to + (from - to) * Math.exp(-t / tau) * Math.cos((2 * Math.PI * t) / period);
            out.push([Number(t.toFixed(4)), Number(v.toFixed(4))]);
        }
        out.push([Number(Number(dur).toFixed(4)), to]);
        return out;
    }

    /* PHÉP PHÓNG + MỜ DẦN của hai thẻ vàng "Vlog Tag" (hệ số theo từng khung 30fps).
     *
     * CÁCH ĐO. Thẻ nằm SAU hộp trắng nên chỉ đo được phần thò ra: bề rộng dải vàng
     * và độ sâu của nó cho hệ số phóng (tâm thẻ đứng yên qua mọi khung — 514.5 cho thẻ
     * lớn, 911 cho thẻ nhỏ — nên đây là PHÓNG QUANH TÂM chứ không phải trượt ra);
     * màu ở LÕI dải (cách mép 3px) so với #ffd744 cho độ mờ. Phải lấy lõi: dải lúc đầu
     * chỉ dày 3-4px nên lấy trung vị cả dải thì toàn pixel mép, ra "mờ" giả.
     *
     * HAI THẺ KHÔNG CÙNG MỘT ĐƯỜNG CONG (đã thử khớp: lệch pha đi ra 14 khung ở đoạn
     * đầu nhưng 18 khung ở đoạn cuối). Thẻ lớn vào nhanh (xong ở khung 29), thẻ nhỏ vào
     * chậm hơn hẳn (xong ở khung 47) — giữ đúng hai đường đo được thay vì ép chung một.
     *
     * ĐOẠN ĐẦU CỦA CẢ HAI LÀ NGOẠI SUY, không phải số đo: thẻ lớn chỉ lòi ra khỏi hộp
     * trắng khi hệ số vượt 0.817, thẻ nhỏ khi vượt 0.571 — trước đó không nhìn thấy gì
     * nên cũng không đo được. Phần nối được chọn sao cho mốc LÒI RA rơi đúng khung đầu
     * tiên thấy vệt vàng trên video (khung 20 cho thẻ lớn, khung 25 cho thẻ nhỏ).
     */
    const VLOG_BIG_SCALE = [
        [0, 0], [2 / 30, 0.30], [4 / 30, 0.52], [6 / 30, 0.70], [8 / 30, 0.859],
        [9 / 30, 0.887], [10 / 30, 0.913], [11 / 30, 0.934], [12 / 30, 0.953],
        [13 / 30, 0.972], [14 / 30, 0.981], [15 / 30, 0.991], [16 / 30, 0.995], [17 / 30, 1],
    ];
    const VLOG_BIG_FADE = [[0, 0], [8 / 30, 0.71], [12 / 30, 0.91], [15 / 30, 0.98], [17 / 30, 1]];
    const VLOG_SMALL_SCALE = [
        [0, 0], [3 / 30, 0.30], [5 / 30, 0.45], [8 / 30, 0.61], [13 / 30, 0.77],
        [18 / 30, 0.90], [23 / 30, 0.96], [27 / 30, 0.99], [30 / 30, 1],
    ];
    const VLOG_SMALL_FADE = [
        [0, 0], [8 / 30, 0.28], [13 / 30, 0.54], [18 / 30, 0.75],
        [23 / 30, 0.89], [27 / 30, 0.97], [30 / 30, 1],
    ];

    /* HAI ĐƯỜNG PHÓNG của mẫu "Welcome" (hệ số theo từng khung 30fps, block = khung 12..101).
     *
     * CHỮ — từng ký tự bật ra rồi VỌT QUÁ 15% mới lắng. Đo trên chữ 'W' lúc nó còn đứng
     * một mình (khung 13..16, cả bề rộng lẫn chiều cao cho cùng một dãy) và kiểm chéo trên chữ
     * 'e' CUỐI — chữ duy nhất còn tách rời ở đoạn lắng: 0.073 (f21) 0.585 0.95 … 1.07 1.02 1.00
     * (f29), khớp đúng dãy này với lệch pha 8 khung cho 6 khoảng.
     *
     * TRANG TRÍ — hoa và mũi tên dùng CHUNG một đường: đo riêng từng cái (hộp bao của cặp
     * hoa theo mép trái/trên, mũi tên theo mép phải) ra hai dãy trùng nhau trong 2%, nên giữ
     * một mảng chung thay vì chép đôi. Vọt quá 9% ở khung 28-29 rồi lắng ở khung 33. */
    const WELCOME_CHAR_POP = [
        [0, 0], [1 / 30, 0.145], [2 / 30, 0.68], [3 / 30, 0.99], [4 / 30, 1.105],
        [5 / 30, 1.15], [6 / 30, 1.13], [7 / 30, 1.09], [8 / 30, 1.04], [9 / 30, 1],
    ];
    const WELCOME_DECO_POP = [
        [0, 0], [1 / 30, 0.21], [2 / 30, 0.41], [3 / 30, 0.59], [4 / 30, 0.74],
        [5 / 30, 0.88], [6 / 30, 0.97], [7 / 30, 1.05], [8 / 30, 1.09], [9 / 30, 1.09],
        [10 / 30, 1.06], [11 / 30, 1.02], [12 / 30, 1.01], [13 / 30, 1],
    ];

    const TEMPLATES = [
        /* ---------------------------------------------------------------------
         * 1) APPROVED — dấu tích xanh nảy lặp + chữ đậm zoom từ ngoài khung vào.
         *
         * SỐ ĐO (video mẫu Text Template-Approved.mp4, 1080×1920, 30fps; block
         * chiếm khung 12..101 => thời lượng 90 khung = 3.00s):
         *   · Chữ "APPROVED": hộp MỰC 711×100 px. Font: dò cả 51 font của app —
         *     chuẩn hoá cỡ chữ cho chiều cao mực = 100, chuẩn hoá letter-spacing
         *     cho bề rộng mực = 711, rồi so bề rộng MỰC TỪNG CHỮ CÁI với video.
         *     Source Sans 3 700 khớp gần như tuyệt đối: [87,72,72,77,88,85,62,76]
         *     so với [86,72,72,76,87,85,63,76] của CapCut (lệch 0.7%); á quân
         *     Source Sans 3 800 lệch 1.9%, Roboto 900 / Heebo 800 lệch 4.5%.
         *     Kiểm chứng lại bằng phép chồng ảnh difference-blend lên khung video:
         *     Source Sans 3 700 gần như đen hoàn toàn. => size 147.4, letter 1.36px.
         *   · Đĩa tích: d=150px, tâm cách mực chữ 55px về bên trái, cùng tâm dọc
         *     với chữ. Màu đĩa lấy từ histogram: rgb(132,205,0) = #84cd00.
         *   · HOẠT ẢNH CHỮ: opacity 0->1 trong 0.20s; scale ~10.9 -> 1 trong
         *     0.50s, tâm phóng = tâm hộp mực CỦA CHỮ. Kiểm chứng tâm phóng: bám
         *     mép nét chữ qua các khung 18..27, ánh xạ x_f = Xc + s·(x_27 − Xc)
         *     chỉ khớp khi Xc = 633 = tâm hộp chữ (KHÔNG phải tâm cả nhóm 531,
         *     cũng không phải tâm khung 540).
         *     Hệ số phóng ĐO ĐƯỢC ở từng khung 18..27 (dùng thẳng làm keyframe):
         *       7.759 6.975 6.127 5.291 4.481 3.696 2.975 2.278 1.619 1.000
         *     Khoảng 0..0.20s chữ còn rất mờ (opacity < 0.6) nên không đo được
         *     hệ số; hiệu số liên tiếp cho thấy TỐC ĐỘ đạt đỉnh quanh khung 19-21
         *     rồi giảm về hai phía (đường cong chữ S), nên đoạn đầu được nối tiếp
         *     bằng chính dãy hiệu số giảm dần đó -> s(0) ≈ 10.9.
         *   · HOẠT ẢNH ĐĨA: LẶP chu kỳ 0.80s, lệch pha 0.567s so với đầu block.
         *     Đường kính đo ở từng khung của MỘT chu kỳ (÷150 thành hệ số):
         *       10 30 66 103 138 154 162 166 158 150 …
         *     -> nảy 0 -> vọt 1.107 -> lắng về 1 trong 0.43s, giữ tới ~0.62s rồi
         *     TẮT HẲN cho tới hết chu kỳ (khung 48..52 mất sạch rồi hiện lại ở 53
         *     — cắt đứt, không co nhỏ).
         *     Video mẫu có sticker chạy 15fps nên dãy trên đi thành bậc (mỗi giá
         *     trị lặp 2 khung); ta lấy MỘT điểm mỗi bậc và nội suy tuyến tính —
         *     cùng biên độ, cùng thời điểm, nhưng mượt ở 30/60fps.
         *   · KHÔNG có hoạt ảnh ra: chữ đứng nguyên tới khung cuối rồi hết block.
         * ------------------------------------------------------------------ */
        {
            id: 'approved',
            name: 'Approved',
            duration: 3.0,
            rowGap: 0,
            slots: [{ id: 'title', label: 'Nội dung', default: 'APPROVED' }],
            layers: [
                {
                    kind: 'text',
                    slot: 'title',
                    place: 'flow',
                    align: 'left',
                    textCase: 'uppercase',
                    color: '#ffffff',
                    font: { family: 'Source Sans 3', weight: 700, size: 147.4, letter: 1.36, lineStep: 1.12 },
                    anim: {
                        tracks: {
                            opacity: [[0, 0], [0.2, 1]],
                            // mốc thời gian = k/30 s (đúng lưới khung của video đo)
                            scale: [
                                [0, 10.86], [1 / 30, 10.68], [2 / 30, 10.33], [3 / 30, 9.83],
                                [4 / 30, 9.21], [5 / 30, 8.51], [6 / 30, 7.759], [7 / 30, 6.975],
                                [8 / 30, 6.127], [9 / 30, 5.291], [10 / 30, 4.481], [11 / 30, 3.696],
                                [12 / 30, 2.975], [13 / 30, 2.278], [14 / 30, 1.619], [15 / 30, 1],
                            ],
                        },
                    },
                },
                {
                    kind: 'glyph',
                    key: 'check',
                    label: 'Dấu tích',
                    glyph: 'check-disc',
                    size: 150,
                    colors: { disc: '#84cd00', mark: '#ffffff' },
                    // Neo: mép PHẢI đĩa cách mép TRÁI hộp chữ 55px, cùng tâm dọc.
                    place: { fx: 0, fy: 0.5, lx: 1, ly: 0.5, dx: -55, dy: 0 },
                    /* NẢY MỘT LẦN RỒI ĐỨNG YÊN — khác video mẫu CapCut (ở đó đĩa lặp
                       chu kỳ 0.80s: nảy, giữ tới 0.617s rồi TẮT HẲN, hiện lại ở chu kỳ
                       sau). Bản lặp làm dấu tích nhấp nháy suốt cả block, gây rối khi
                       mẫu đứng lâu trên khung hình. Bỏ `period` + `window` là lớp chạy
                       ĐÚNG MỘT LẦN theo keyframe rồi giữ giá trị cuối (1.0×) — xem
                       layerStateAt: không có period thì thời gian cục bộ không quay
                       vòng, và trackAt kẹp ở điểm cuối.
                       Biên độ nảy (0 -> 1.107 -> 1.0 trong 0.43s) và lệch pha 0.567s
                       GIỮ NGUYÊN số đo của video — chỉ phần lặp bị bỏ. */
                    anim: {
                        delay: 0.567,
                        tracks: {
                            scale: [
                                [0, 0], [1 / 30, 0.200], [3 / 30, 0.440], [4 / 30, 0.687],
                                [6 / 30, 0.920], [7 / 30, 1.027], [9 / 30, 1.080], [10 / 30, 1.107],
                                [12 / 30, 1.053], [13 / 30, 1.000],
                            ],
                        },
                    },
                },
            ],
        },

        /* ---------------------------------------------------------------------
         * 2) CORRECT 1 — dấu tích xanh có BÓNG ĐỔ DÀI + chữ rơi xuống TỪNG KÝ TỰ.
         *
         * SỐ ĐO (video mẫu Text Template-Correct 1.mp4, 1080×1920, 30fps; block chiếm
         * khung 13..102 => 90 khung = 3.00s — khung cuối có nội dung là 102, và mọi mốc
         * bên dưới khớp với gốc thời gian đó).
         *
         *  · CHỮ "Correct": hộp MỰC 702×133 px tại x 290..991, baseline y=1026.
         *    Font: dò cả 51 font của app bằng phép CHỒNG ẢNH — dựng "Correct" lên canvas
         *    rồi tính IoU với mặt nạ chữ trắng của khung f45, quét cỡ chữ/letter-spacing/
         *    lệch x,y quanh giá trị chuẩn hoá. Montserrat 800 thắng rõ: IoU 0.896, so với
         *    Montserrat 700 0.875, Raleway 800 0.866, Poppins 700/800 0.847/0.835,
         *    Montserrat 900 0.815. Ảnh chồng difference gần như trùng khít (chỉ còn viền
         *    1px do nén video). => size 183, letter −1.63px.
         *    Bề dày thân chữ 'r' đo được 32px chốt lại cùng kết luận: Montserrat 700 cho
         *    28px (mảnh), 900 cho ~40px (dày), 800 vừa khớp.
         *  · ĐĨA TÍCH: d=202 (r=101), tâm (156.5, 958.5). Mép PHẢI đĩa cách mép TRÁI mực
         *    chữ 32.5px; tâm đĩa cao hơn tâm dải chữ hoa (1026−128/2=962) đúng 3.5px.
         *    Màu đĩa rgb(132,205,0)=#84cd00 (trùng "Approved"), bóng đổ #72bb00.
         *  · HOẠT ẢNH CHỮ — THEO TỪNG KÝ TỰ, không phải cả khối: chữ cái thứ i vào cảnh ở
         *    khung 16+2i (đo trực tiếp: C f16, o f18, r f20, r f22, e f24, c f26, t f28),
         *    tức lệch pha 2 khung = 1/15s. Mỗi chữ RƠI TỪ TRÊN XUỐNG: bắt đầu cao hơn chỗ
         *    đứng ~77px, hạ xuống, vọt quá 4.5px rồi lắng lại sau 11 khung (0.367s).
         *    Dãy dy dưới đây là TRUNG BÌNH của 5 chữ o/r/r/e/c — năm quỹ đạo trùng nhau
         *    trong ±2px nên coi như một đường duy nhất.
         *    (Ghi chú đo được nhưng KHÔNG mô hình hoá: hai chữ cao 'C' và 't' xuất phát
         *    cao hơn — 90 và 87px so với 78px của chữ thấp, khớp gần như tuyệt đối với
         *    0.4·chiều-cao-mực + 37. Chênh 12px ở đúng khung đầu của mỗi chữ, mắt không
         *    bắt được, nên dùng MỘT biên độ chung cho mọi ký tự thay vì gắn hoạt ảnh vào
         *    hình dáng từng chữ cái — thứ sẽ vỡ ngay khi người dùng gõ chuỗi khác.)
         *  · HOẠT ẢNH ĐĨA: cùng đường nảy với "Approved" (đo lại trên video này: đường
         *    kính theo khung ÷202 ra 0.208 0.480 0.735 0.941 1.040 1.077 1.099 1.040
         *    1.000 — trùng dãy của "Approved" trong sai số đo). Video mẫu cho đĩa LẶP chu
         *    kỳ 0.80s y như "Approved"; ở đây cũng bỏ phần lặp, xem chú thích của mẫu 1.
         * ------------------------------------------------------------------ */
        {
            id: 'correct-1',
            name: 'Correct 1',
            duration: 3.0,
            rowGap: 0,
            slots: [{ id: 'title', label: 'Nội dung', default: 'Correct' }],
            layers: [
                {
                    kind: 'text',
                    slot: 'title',
                    place: 'flow',
                    align: 'left',
                    color: '#ffffff',
                    // lineStep KHÔNG đo được (mẫu chỉ có một dòng) — 1.2 là mức thoáng vừa
                    // đủ cho chữ Việt có dấu ở Montserrat 800.
                    font: { family: 'Montserrat', weight: 800, size: 183, letter: -1.63, lineStep: 1.2 },
                    anim: {
                        delay: 3 / 30,                   // ký tự đầu vào cảnh ở khung 16
                        perChar: { stagger: 1 / 15 },    // lệch pha 2 khung một chữ
                        tracks: {
                            opacity: [[0, 0], [1 / 30, 1]],
                            dy: [
                                [0, -76], [1 / 30, -77.7], [2 / 30, -73.7], [3 / 30, -63.1],
                                [4 / 30, -47.0], [5 / 30, -28.9], [6 / 30, -13.1], [7 / 30, -2.1],
                                [8 / 30, 3.6], [9 / 30, 4.5], [10 / 30, 1.5], [11 / 30, 0],
                            ],
                        },
                    },
                },
                {
                    kind: 'glyph',
                    key: 'check',
                    label: 'Dấu tích',
                    glyph: 'check-disc-long-shadow',
                    size: 202,
                    colors: { disc: '#84cd00', mark: '#ffffff', shadow: '#72bb00' },
                    // Neo: mép PHẢI đĩa cách mép TRÁI hộp chữ 32.5px; tâm đĩa nhích lên 3.5px.
                    place: { fx: 0, fy: 0.5, lx: 1, ly: 0.5, dx: -32.5, dy: -3.5 },
                    anim: {
                        delay: 5 / 30,                   // đĩa nảy ở khung 18
                        tracks: {
                            scale: [
                                [0, 0], [1 / 30, 0.208], [3 / 30, 0.480], [4 / 30, 0.735],
                                [6 / 30, 0.941], [7 / 30, 1.040], [9 / 30, 1.077], [10 / 30, 1.099],
                                [12 / 30, 1.040], [13 / 30, 1.000],
                            ],
                        },
                    },
                },
            ],
        },

        /* ---------------------------------------------------------------------
         * 3) INCORRECT — vành tròn đỏ nảy vào, dấu X TỰ VẼ từ hai đầu trên xuống,
         *    chữ TRƯỢT VÀO TỪ TRÁI chui ra từ sau biểu tượng.
         *
         * SỐ ĐO (video mẫu Text Template-Incorrect.mp4, 1080×1920, 30fps; block chiếm
         * khung 13..102 => 90 khung = 3.00s, cùng gốc thời gian với "Correct 1").
         *
         *  · CHỮ "Incorrect": hộp MỰC 580×96 tại x 352..931, baseline 999, dải chữ hoa 94,
         *    thân chữ 'I' rộng 13 (nét mảnh). Font: dò bằng phép CHỒNG ẢNH IoU trên khung
         *    f75. Quicksand 500 cho IoU cao nhất (0.816) nhưng BỊ LOẠI: đầu nét chữ 'I'
         *    của nó bo tròn (lát cắt 3,7,9,11,11) còn video cắt phẳng (7,13,13,13) — IoU
         *    trên một từ toàn nét thẳng bị chi phối bởi bề dày nét, không "thấy" hình
         *    dáng đầu nét. Trong nhóm đầu nét PHẲNG, Raleway 500 thắng: IoU 0.811, so với
         *    Manrope 500 0.780, Prompt 300 0.779, Inter 400 0.757, DM Sans 400 0.746,
         *    Poppins 400 0.708. Raleway cũng khớp riêng chữ 'o' tròn đều (72×72 so với
         *    video 74×74) và bề dày thân 13. => size 134, letter 4.05.
         *    (IoU trần ~0.81 chứ không ~0.90 như "Correct 1": nét mảnh nên viền do nén
         *    video chiếm tỉ lệ lớn hơn. Đây là font GẦN NHẤT trong thư viện app, không
         *    chắc đúng font CapCut dùng — người dùng đổi được ở panel Thuộc tính.)
         *  · VÀNH: ngoài d=171 (r=85.5), nét 17.5, tâm (230.5, 947.5). Mép phải vành cách
         *    mép trái mực chữ 36; tâm vành cao hơn tâm dải chữ hoa 4.
         *  · HOẠT ẢNH VÀNH: nảy vào rồi DỘI HAI NHỊP — vọt lên 1.20 (khung 31-32), tụt về
         *    0.81 (khung 38-40) rồi mới về 1.00 (khung 45). Đường kính đo theo DIỆN TÍCH
         *    pixel đỏ (vành khuyên: S = 0.2742·d²) chứ không theo hộp bao, vì lúc còn nhỏ
         *    hộp bao chỉ vài pixel nên sai số làm tròn nuốt mất cả đoạn đầu.
         *  · DẤU X: bắt đầu ở khung 46, mọc dần từ hai đầu TRÊN xuống, xong ở khung 66.
         *  · CHỮ: trượt vào từ khung 37, dừng ở khung 58 (0.70s); mép cắt cố định ở x=308
         *    (7px vào trong vành) giữ cho phần chữ chưa tới nơi không lòi ra bên trái.
         *    Đo bằng chính mép trái vệt trắng: nó đứng yên ở 308 suốt khung 37..47 rồi mới
         *    chạy theo chữ khi chữ đã vào hẳn trong vùng thấy được.
         *  · Video còn một NHỊP PHỒNG NHẸ của biểu tượng ở khung 82..102 (170→186→172).
         *    Bỏ, cùng lý do bỏ vòng lặp của "Approved" — xem ghi chú ở mẫu 1.
         * ------------------------------------------------------------------ */
        {
            id: 'incorrect',
            name: 'Incorrect',
            duration: 3.0,
            rowGap: 0,
            slots: [{ id: 'title', label: 'Nội dung', default: 'Incorrect' }],
            /* Hình trang trí khai TRƯỚC lớp chữ = vẽ TRƯỚC, tức chữ nằm ĐÈ lên nó. Video
               cho thấy đúng vậy: mép cắt nằm 7px bên trong vành, nét chữ phủ lên chỗ đó.
               Thứ tự khai KHÔNG ảnh hưởng phép xếp chỗ — hộp chữ vẫn do lớp place:'flow'
               quyết định, các lớp khác neo vào nó (xem layout). */
            layers: [
                {
                    kind: 'glyph',
                    key: 'icon',
                    label: 'Vòng báo sai',
                    glyph: 'cross-ring',
                    size: 171,
                    colors: { ring: '#ff0000', mark: '#ff0000' },
                    place: { fx: 0, fy: 0.5, lx: 1, ly: 0.5, dx: -36, dy: -4 },
                    anim: {
                        delay: 5 / 30,               // vành hiện ở khung 18
                        tracks: {
                            scale: [
                                [0, 0.054], [1 / 30, 0.076], [2 / 30, 0.120], [3 / 30, 0.171],
                                [4 / 30, 0.245], [5 / 30, 0.402], [6 / 30, 1.011], [7 / 30, 1.082],
                                [8 / 30, 1.127], [9 / 30, 1.156], [10 / 30, 1.174], [11 / 30, 1.190],
                                [12 / 30, 1.197], [13 / 30, 1.200], [14 / 30, 1.202], [15 / 30, 1.200],
                                [16 / 30, 1.192], [17 / 30, 1.004], [18 / 30, 0.842], [19 / 30, 0.818],
                                [20 / 30, 0.808], [21 / 30, 0.807], [22 / 30, 0.808], [23 / 30, 0.813],
                                [24 / 30, 0.827], [25 / 30, 0.902], [26 / 30, 0.983], [27 / 30, 1.000],
                            ],
                            // Dấu X tự vẽ: khung 46 (= 28/30 sau vành) tới khung 66.
                            reveal: [
                                [0, 0], [28 / 30, 0], [29 / 30, 0.014], [31 / 30, 0.014],
                                [32 / 30, 0.045], [34 / 30, 0.073], [35 / 30, 0.101], [36 / 30, 0.129],
                                [37 / 30, 0.184], [38 / 30, 0.351], [39 / 30, 0.490], [40 / 30, 0.629],
                                [41 / 30, 0.754], [42 / 30, 0.823], [43 / 30, 0.879], [44 / 30, 0.906],
                                [46 / 30, 0.962], [48 / 30, 1],
                            ],
                        },
                    },
                },
                {
                    kind: 'text',
                    slot: 'title',
                    place: 'flow',
                    align: 'left',
                    color: '#ffffff',
                    font: { family: 'Raleway', weight: 500, size: 134, letter: 4.05, lineStep: 1.2 },
                    // Mép cắt: 44px bên TRÁI mực chữ = đúng x 308 của video.
                    clip: { x0: -44 },
                    anim: {
                        delay: 24 / 30,              // chữ bắt đầu trượt ở khung 37
                        tracks: {
                            dx: [
                                [0, -595], [1 / 30, -544], [2 / 30, -495], [3 / 30, -448],
                                [4 / 30, -404], [5 / 30, -362], [6 / 30, -321], [7 / 30, -283],
                                [8 / 30, -247], [9 / 30, -213], [10 / 30, -181], [11 / 30, -152],
                                [12 / 30, -125], [13 / 30, -100], [14 / 30, -78], [15 / 30, -58],
                                [16 / 30, -41], [17 / 30, -27], [18 / 30, -16], [19 / 30, -8],
                                [20 / 30, -2], [21 / 30, 0],
                            ],
                        },
                    },
                },
            ],
        },

        /* ---------------------------------------------------------------------
         * 4) INCORRECT 2 — đĩa đỏ đặc có dấu X trắng đổ bóng, chữ IN HOA viền đỏ trượt
         *    vào từ trái. Cùng bộ với "Incorrect", chỉ khác cách thể hiện.
         *
         * SỐ ĐO (video Text Template-Incorrect 2.mp4; block khung 13..102 = 3.00s):
         *  · CHỮ "INCORRECT": mực trắng 636×76 tại x 308..943, baseline 991, dải chữ hoa
         *    76, thân 'I' rộng 10. Viền ĐỎ mảnh: mực đỏ 304..949 / 910..997, tức lấn ra
         *    ngoài nét trắng ~4px mỗi phía. Font: cùng phép chồng ảnh IoU, Raleway 500
         *    lại thắng (0.798 so với Outfit 400 0.730, Nunito Sans 500 0.715,
         *    Montserrat 500 0.707) — hai mẫu cùng bộ dùng chung một font là hợp lý.
         *    => size 109.5, letter 4.05.
         *  · ĐĨA: d=161, tâm (195.5, 949.5), màu đo được rgb(254,0,0) -> #ff0000 (lệch 1
         *    đơn vị là do nén video). Mép phải đĩa cách mép trái mực chữ 32; tâm đĩa cao
         *    hơn tâm dải chữ hoa 2.5. Đường kính đo theo DIỆN TÍCH NỬA ĐĨA BÊN TRÁI
         *    (S = πd²/8) để chữ bên phải không lọt vào phép đo.
         *  · HOẠT ẢNH ĐĨA: nảy vào từ khung 14, vọt 1.09 ở khung 22, lắng ở khung 28.
         *  · CHỮ: trượt vào từ khung 18, dừng ở khung 32 (0.47s) — nhanh hơn "Incorrect".
         *    Mép cắt cố định ở x=272 (4px vào trong đĩa).
         *  · Video còn cho đĩa PHỒNG LẶP chu kỳ 16 khung (0.533s: 1.00 → 1.12 → 0.98 →
         *    1.00). Bỏ vòng lặp — xem ghi chú ở mẫu 1.
         * ------------------------------------------------------------------ */
        {
            id: 'incorrect-2',
            name: 'Incorrect 2',
            duration: 3.0,
            rowGap: 0,
            slots: [{ id: 'title', label: 'Nội dung', default: 'INCORRECT' }],
            layers: [
                {
                    kind: 'glyph',
                    key: 'icon',
                    label: 'Đĩa báo sai',
                    glyph: 'cross-disc',
                    size: 161,
                    colors: { disc: '#ff0000', mark: '#ffffff' },
                    place: { fx: 0, fy: 0.5, lx: 1, ly: 0.5, dx: -32, dy: -2.5 },
                    anim: {
                        delay: 1 / 30,               // đĩa hiện ở khung 14
                        tracks: {
                            scale: [
                                [0, 0.227], [1 / 30, 0.478], [2 / 30, 0.668], [3 / 30, 0.831],
                                [4 / 30, 0.967], [5 / 30, 0.960], [6 / 30, 1.030], [7 / 30, 1.083],
                                [8 / 30, 1.091], [9 / 30, 1.053], [10 / 30, 1.027], [11 / 30, 1.013],
                                [12 / 30, 1.006], [13 / 30, 1.001], [14 / 30, 1.000],
                            ],
                        },
                    },
                },
                {
                    kind: 'text',
                    slot: 'title',
                    place: 'flow',
                    align: 'left',
                    color: '#ffffff',
                    textCase: 'uppercase',
                    stroke: { color: '#ff0000', width: 4 },
                    font: { family: 'Raleway', weight: 500, size: 109.5, letter: 4.05, lineStep: 1.2 },
                    clip: { x0: -36 },
                    anim: {
                        delay: 5 / 30,               // chữ bắt đầu trượt ở khung 18
                        tracks: {
                            dx: [
                                [0, -647], [1 / 30, -566], [2 / 30, -489], [3 / 30, -417],
                                [4 / 30, -350], [5 / 30, -288], [6 / 30, -232], [7 / 30, -181],
                                [8 / 30, -136], [9 / 30, -96], [10 / 30, -63], [11 / 30, -36],
                                [12 / 30, -16], [13 / 30, -4], [14 / 30, 0],
                            ],
                        },
                    },
                },
            ],
        },

        /* ---------------------------------------------------------------------
         * 5) QUOTE — cặp dấu nháy vàng TRƯỢT LÊN kèm mờ dần vào, hai dòng chữ ĐEN TRÊN
         *    NỀN TRẮNG trượt vào từ trái sau một mép cắt cố định.
         *
         * SỐ ĐO (video Text Template-Quote.mp4, 1080×1920, 30fps; khung cuối còn nội dung
         * là 101 => block = khung 12..101, 90 khung = 3.00s).
         *
         *  · HAI HỘP NỀN TRẮNG (#ffffff — histogram ra rgb(252,250,251), lệch 2-5 đơn vị
         *    là do nén video), góc VUÔNG (hàng y=866 chỉ có 4px, y=867 đã đủ 710px -> mép
         *    trên cắt phẳng, không bo):
         *      dòng 1  x 290..999 (710×86), mực x 326..961 (636), baseline y 934
         *      dòng 2  x 290..818 (529×86), mực x 330..777 (448), baseline y 1034
         *    Hai hộp cách nhau 14px (y 953..966) và hai baseline cách đúng 100px = 86+14.
         *    Đệm: ngang 37 mỗi bên (634+37+37 = 710), TRÊN dải chữ hoa 9 (867 -> 876),
         *    DƯỚI baseline 18 (934 -> 952), tổng 9+59+18 = 86 đúng chiều cao hộp —
         *    hộp KHÔNG cân đối, xem chú thích padTop/padBottom ở measureTextLayer.
         *  · CHỮ: dải chữ hoa 59 ('A','T','N','I' y 876..934), ascender 60 ('l','h','d'),
         *    x-height 46, thân 'l' rộng 8.5. Font: dò cả 51 font của app bằng BA phép đo
         *    độc lập, vì phép chồng ảnh IoU một mình không đủ (chữ nét mảnh, xem ghi chú
         *    của "Incorrect"):
         *      1. IoU trên khung f91 (dò cỡ chữ + letter-spacing quanh giá trị chuẩn hoá,
         *         tính CẢ HAI dòng): Inter 500 đứng đầu (dòng 1 0.744 — cao nhất trong cả
         *         51 font, dòng 2 0.635), sát sau là Prompt 500 (0.714/0.663) và
         *         Figtree 600 (0.588/0.787).
         *      2. Bề rộng MỰC TỪNG CHỮ CÁI (15 chữ của dòng 1, chuẩn hoá theo dải chữ hoa
         *         rồi khớp lại một hệ số chung): Inter đứng đầu, sai số RMS 4.8%.
         *      3. TỈ LỆ ascender/dải-chữ-hoa = 60/59 = 1.017 — chính chỗ này LOẠI được
         *         Prompt/Roboto/Montserrat/Archivo (1.05-1.06, tức chữ 'l' phải cao hơn
         *         chữ 'A' 3px trong khi video chỉ hơn 1px). Chỉ Inter và Figtree có
         *         ascender = dải chữ hoa; giữa hai font đó, bề dày thân chữ chốt lại:
         *         video 8.5/59 = 0.144, Inter 500 cho 0.149, Figtree 600 cho 0.159.
         *    => Inter 500. Cỡ chữ và letter-spacing lấy từ CHÍNH canvas của Chrome (cùng
         *    thước mà engine dùng để đo): size 79.87 cho ascent của 'H' đúng 59, letter
         *    3.355 cho hộp mực dòng 1 đúng 636. Dòng 2 khi đó ra 442.9 so với 448 đo được
         *    (lệch 1.1% — nằm trong sai số của một mẫu chữ chỉ có 11 ký tự).
         *  · DẤU NHÁY: cặp x 88..271, y 867..1019 (183×153) — mép PHẢI cách mép TRÁI hộp
         *    nền 19px, mép TRÊN TRÙNG mép trên hộp nền dòng 1 (cùng y=867, nên neo
         *    fy:0/ly:0 chứ không phải căn giữa dọc). Màu #fdee00 (đo rgb(253,238,0)).
         *  · HOẠT ẢNH DẤU NHÁY: TRƯỢT LÊN + mờ dần, KHÔNG phóng to. Cách tách hai thứ đó:
         *    dựng bản đồ alpha (chiếu hiệu màu từng pixel lên hướng nền->vàng) rồi so hộp
         *    bao — hộp bao cao đúng 152 ngay từ khung 17 và chỉ ĐI LÊN (ymin 977 -> 867),
         *    nếu là phóng to thì chiều cao phải lớn dần. Dãy (dy, alpha) đo từng khung
         *    dưới đây khớp mặt nạ khung cuối đã dịch, sai số dưới 1px.
         *    (Khung 14 đo được alpha 0 nên KHÔNG suy ra được dy; lấy 145 bằng cách nối
         *    tiếp bước 18-19px/khung của đoạn đầu — vô hình nên không ảnh hưởng hình,
         *    chỉ để đường cong liền mạch.)
         *  · HOẠT ẢNH CHỮ: cả KHỐI hai dòng trượt sang phải sau MÉP CẮT cố định ở x=286
         *    (4px bên trái mép hộp nền — đo bằng chính mép trái vệt trắng: nó đứng yên ở
         *    286 suốt khung 23..39 rồi mới về 290 khi chữ vào hẳn). Trước khung 23 khối
         *    chữ nằm TRỌN bên trái mép cắt nên không đo được và cũng không thấy gì.
         *    Xem QUOTE_SLIDE_DX.
         *  · KHÔNG có hoạt ảnh ra: khung 101 còn nguyên, khung 102 hết block.
         * ------------------------------------------------------------------ */
        {
            id: 'quote',
            name: 'Quote',
            duration: 3.0,
            rowGap: 14,          // khe giữa hai hộp nền (y 953..966)
            slots: [
                { id: 'line1', label: 'Dòng 1', default: 'All That Glitters' },
                { id: 'line2', label: 'Dòng 2', default: 'Is Not Gold' },
            ],
            layers: [
                {
                    kind: 'glyph',
                    key: 'quote',
                    label: 'Dấu nháy',
                    glyph: 'quote-marks',
                    size: 153,
                    colors: { mark: '#fdee00' },
                    // Neo: mép PHẢI dấu nháy cách mép TRÁI hộp chữ 19px, MÉP TRÊN trùng nhau.
                    place: { fx: 0, fy: 0, lx: 1, ly: 0, dx: -19, dy: 0 },
                    anim: {
                        delay: 2 / 30,          // khung 14: đã có mặt nhưng alpha 0
                        tracks: {
                            opacity: [
                                [0, 0], [1 / 30, 0.160], [2 / 30, 0.457], [3 / 30, 0.554],
                                [4 / 30, 0.643], [5 / 30, 0.718], [6 / 30, 0.786], [7 / 30, 0.846],
                                [8 / 30, 0.891], [9 / 30, 0.934], [10 / 30, 0.963], [11 / 30, 0.987],
                                [12 / 30, 0.994], [13 / 30, 1],
                            ],
                            dy: [
                                [0, 145], [1 / 30, 126], [2 / 30, 108], [3 / 30, 90],
                                [4 / 30, 72], [5 / 30, 56], [6 / 30, 42], [7 / 30, 31],
                                [8 / 30, 21], [9 / 30, 12], [10 / 30, 6], [11 / 30, 4],
                                [12 / 30, 2], [13 / 30, 0],
                            ],
                        },
                    },
                },
                quoteTextLayer('line1'),
                quoteTextLayer('line2'),
            ],
        },

        /* ------------------------------------------------------------------
         * "Folgen Sie" — chữ NGHIÊNG hiện ra TỪNG KÝ TỰ (phóng từ 0 lên rồi nảy dội tắt
         * dần) + ba nét nhấn ở góc phải trên, phóng vào rồi ĐẬP ra-vào không dứt.
         *
         * SỐ ĐO (video Text Template-Folgen Sie.mp4, 1080×1920, 30fps; khung cuối còn nội
         * dung là 102 => block = khung 13..102, 90 khung = 3.00s).
         *
         *  · CHỮ: trắng tinh #ffffff (lõi đo 254.6/254.3/254.1), KHÔNG viền, KHÔNG bóng.
         *    Hộp mực x 163..916 (rộng 754), y 873..1077. Dải chữ hoa: 'F' y 873..1026,
         *    'S' y 872..1025 => cap 153.5, baseline y=1026. x-height 96 ('o' y 930..1025),
         *    nét thả của 'g' xuống 1080. Tâm ngang của mực 539.5 ≈ tâm khung 540.
         *    Nghiêng ~11° (mép trái thân 'l' đi từ x=365 ở y=880 về x=356 ở y=930).
         *
         *  · FONT — CHỖ CỐ Ý LỆCH SỐ ĐO, ghi rõ ở đây vì người dùng đổi được font ở panel:
         *    video dùng chữ BÚT LÔNG KHÔ (nét ráp, đầu nét toè), thư viện của app KHÔNG có
         *    font nào cùng loại. Dò cả 618 file .ttf của app (kể cả các khuôn Italic trước
         *    nay chưa đăng ký) bằng phép chồng ảnh IoU: cao nhất chỉ 0.52 (Jost 700 Italic /
         *    Karla 800 Italic) — so với 0.90 của "Approved" và 0.81 của "Incorrect" vốn đã
         *    bị coi là "font gần nhất trong thư viện, không phải font CapCut". Dò tiếp hơn
         *    500 font cài trong Windows cũng chỉ tới 0.54. Kết luận: không tìm được, nên
         *    lấy MỘT FONT NGHIÊNG ĐẬM có tỉ lệ gần nhất và giữ nguyên phần đo được là HIỆU
         *    ỨNG (đó mới là thứ nhận diện mẫu).
         *    Roboto Condensed 700 Italic được chọn vì tỉ lệ bề-rộng-mực/dải-chữ-hoa tự nhiên
         *    của nó (5.746) gần số đo của video (754/153.5 = 4.912) nhất trong các khuôn
         *    nghiêng đậm của thư viện — các font khác phải kéo letter-spacing âm sâu hơn nữa
         *    mới khớp bề rộng, và chữ bắt đầu dính nhau.
         *    Cỡ chữ chốt theo DẢI CHỮ HOA (153.5, con số ràng buộc mọi khoảng cách dọc với
         *    nét nhấn), letter-spacing chốt theo bề rộng mực 754 — cả hai đo bằng CHÍNH
         *    canvas của Chrome, cùng thước mà engine dùng: size 215.3 cho ascent của 'H'
         *    đúng 153, letter −12.99 cho hộp mực "Folgen Sie" đúng 754.03.
         *
         *  · HOẠT ẢNH CHỮ: từng ký tự phóng từ 0 lên, vọt quá 1.13 rồi NẢY DỘI TẮT DẦN
         *    (chu kỳ 10 khung = 1/3 s, biên độ +0.13 / −0.10 / +0.05 / −0.045 / +0.026) —
         *    xem FOLGEN_CHAR_SCALE. Kèm mờ dần 0→1 trong ~3.2 khung (alpha đo được f16 0.63,
         *    f17 0.94, f18 1.00).
         *    LỆCH PHA = 1/16 s (1.875 khung), lấy từ mốc hiện của TỪNG ký tự: F16 o18 l20
         *    g22 e23.5 n25.4 [dấu cách] S29.1 i31 e32.9 — khớp đường thẳng 16 + 1.875·i tới
         *    dưới nửa khung, và chính chỗ này cho thấy DẤU CÁCH cũng chiếm một nhịp (bỏ nó
         *    ra thì "Sie" phải hiện sớm hơn 1.9 khung so với đo được).
         *    Ký tự đầu bắt đầu ở khung 14 => delay 1/30.
         *
         *  · BA NÉT NHẤN: bắt đầu khung 24 (delay 11/30), KHÔNG mờ dần (alpha ≈ 0.99 ngay
         *    từ khung đầu nhìn thấy được), chỉ phóng từ 0 lên 1.101 rồi lắng về 1 — xem
         *    FOLGEN_SPARK_SCALE. Tâm phóng là tâm hộp nhóm (kiểm ở khung 30..35, sai số
         *    dưới 2.5px).
         *    NHỊP ĐẬP bắt đầu NGAY TẠI khung 24 ở trạng thái TRONG và đổi mỗi 6 khung
         *    (chu kỳ 12 khung = 0.4s) — dóng ngược từ các đoạn đo chắc chắn ở khung 36-41,
         *    42-47, 48-53… Đây là chỗ mẫu này KHÁC "Approved"/"Correct 1": ở hai mẫu đó
         *    vòng lặp bị bỏ vì dấu tích TẮT HẲN mỗi chu kỳ nên nhấp nháy suốt block; ở đây
         *    nét nhấn không bao giờ biến mất, chỉ thở ra-vào 17px, nên vòng lặp được giữ
         *    đúng như video.
         *    Neo: mép PHẢI nhóm (981) = mép phải hộp chữ (916) + 65; mép DƯỚI nhóm (797)
         *    = mép trên dải chữ hoa (873) − 76.
         *
         *  · KHÔNG có hoạt ảnh ra: khung 102 còn nguyên, khung 103 hết block.
         * ------------------------------------------------------------------ */
        {
            id: 'folgen-sie',
            name: 'Folgen Sie',
            duration: 3.0,
            slots: [{ id: 'title', label: 'Nội dung', default: 'Folgen Sie' }],
            layers: [
                {
                    kind: 'text',
                    slot: 'title',
                    place: 'flow',
                    align: 'center',
                    color: '#ffffff',
                    font: {
                        family: 'Roboto Condensed', weight: 700, italic: true,
                        size: 215.3, letter: -12.99,
                    },
                    anim: {
                        delay: 1 / 30,
                        perChar: { stagger: 1 / 16 },
                        tracks: {
                            opacity: [[0, 0], [2 / 30, 0.63], [3 / 30, 0.94], [4 / 30, 1]],
                            scale: FOLGEN_CHAR_SCALE,
                        },
                    },
                },
                {
                    kind: 'glyph',
                    key: 'spark',
                    label: 'Nét nhấn',
                    glyph: 'emphasis-lines',
                    size: 119,               // = CHIỀU CAO hộp nhóm (hợp hai trạng thái)
                    colors: { mark: '#ffffff' },
                    place: { fx: 1, fy: 0, lx: 1, ly: 1, dx: 65, dy: -76 },
                    anim: {
                        delay: 11 / 30,
                        tracks: {
                            scale: FOLGEN_SPARK_SCALE,
                            reveal: emphasisPulseTrack(3.0, 11 / 30, 0.2),
                        },
                    },
                },
            ],
        },

        /* ------------------------------------------------------------------
         * "Zoom Title" (video mẫu: Text Template-Toumament Summer Season) — TIÊU ĐỀ KHỔNG
         * LỒ THU VỀ kèm hiện dần, rồi THANH MÀU bật ra và dòng phụ GÕ RA TỪNG NÉT.
         *
         * SỐ ĐO (video 1080×1920, 30fps; khung cuối còn nội dung là 102 => block =
         * khung 13..102, 90 khung = 3.00s).
         *
         *  · TIÊU ĐỀ: trắng tinh #ffffff (lõi đo 254.9/254.8/254.8), IN HOA, không viền,
         *    không bóng. Hộp mực x 136..945 (810), y 873..973 => dải chữ hoa 101, tâm
         *    (540.5, 923) — đúng tâm ngang khung hình.
         *    Font: Rubik 800 (IoU 0.844 trên khung f60, dẫn đầu; Rubik 700 0.823, Saira 800
         *    0.822). Size 144.286 cho ascent 'H' đúng 101, letter −8.328 cho hộp mực đúng
         *    810 — cả hai đo bằng CHÍNH canvas của Chrome.
         *  · HOẠT ẢNH TIÊU ĐỀ: phóng từ 9.73× về đúng 1 trong 14 khung (xem
         *    ZOOM_TITLE_SCALE), tâm phóng là TÂM HỘP CHỮ (kiểm: tâm dọc đứng yên ở 923
         *    suốt khung 14..28). Kèm hiện dần TUYẾN TÍNH: độ mờ đo được 0.16 / 0.32 / 0.48 /
         *    0.65 / 0.82 / 1.00 ở khung 14..19 — đúng 1/6 mỗi khung, tức 0 tại khung 13
         *    (đầu block) và đủ 1 sau 0.20s. KHÔNG có hoạt ảnh ra.
         *  · THANH MÀU: #fcba00 (đo rgb(252,186,0)), GÓC VUÔNG (hàng 991 đã đủ 816px),
         *    x 132..947 (816), y 991..1087 (97). BẬT RA NGUYÊN VẸN ở khung 27, không mờ
         *    dần, không phóng (khung 26 chưa có gì, khung 27 đã đủ cỡ và đủ đậm).
         *    Dòng phụ đen #000000, hộp mực x 198..880 (683), y 1020..1055 => dải chữ hoa 36.
         *    Đệm: ngang 66.5 mỗi bên (683+133 = 816), TRÊN dải chữ hoa 29, DƯỚI baseline 32
         *    — lại là hộp nền KHÔNG cân đối, đúng thứ `bg.padTop`/`padBottom` sinh ra cho
         *    "Quote". Font: Nunito Sans 800 (IoU 0.800, cao nhất trong các khuôn ĐỨNG; hai
         *    khuôn nghiêng của Nunito nhỉnh hơn 0.006-0.007 nhưng chữ trong video đứng
         *    thẳng, thấy rõ ở thân 'T'/'S'). Size 51.064, letter −0.575.
         *  · GÕ RA TỪNG NÉT: một mép cắt PHẲNG chạy từ trái sang phải qua hộp mực — chữ
         *    đang tới bị cắt ĐỨNG giữa thân (thấy rõ chữ 'r' của "Tour" ở khung 29), nên
         *    KHÔNG phải hiệu ứng theo ký tự mà là mặt nạ; xem kênh `reveal` ở
         *    drawTextLayerContent. Đo bằng cách quy SỐ PIXEL MỰC của từng khung về vị trí
         *    mép cắt qua bảng cộng dồn mực theo cột (chính xác hơn "mực phải nhất", vì mép
         *    cắt hay rơi vào khe giữa hai chữ): r = 0.060 / 0.136 / 0.214 / 0.315 / 0.386 /
         *    0.450 / 0.529 / 0.650 / 0.714 / 0.787 / 0.864 / 0.937 / 0.996 ở khung 28..40.
         *    Dãy này là CẬN DƯỚI của r: mép cắt rơi vào khe giữa hai chữ thì số pixel mực
         *    đứng yên trong khi mép vẫn chạy, nên phép quy ngược ra vị trí mép luôn THIẾU.
         *    Vì vậy quãng chạy lấy 12.3 khung chứ không phải 13 — đường thẳng phải nằm TRÊN
         *    mọi điểm đo (13 khung cho r=0.615 ở khung 35, thấp hơn giá trị đo 0.650) mà vẫn
         *    chưa đủ 1 ở khung 39 (khung đó mực phải nhất mới tới 846/880, chữ chưa xong).
         *  · KHE giữa hai lớp: baseline tiêu đề 974 -> mép trên thanh 990.5 => rowGap 17.
         *  · THỨ TỰ VẼ: thanh màu ĐÈ LÊN tiêu đề (ở khung 27 tiêu đề còn to 1.61× và trùm
         *    xuống tận y 1004) — đúng thứ tự khai báo của engine, tiêu đề trước.
         * ------------------------------------------------------------------ */
        {
            id: 'zoom-title',
            name: 'Zoom Title',
            duration: 3.0,
            rowGap: 17,
            slots: [
                { id: 'title', label: 'Tiêu đề', default: 'BADMINTON' },
                { id: 'subtitle', label: 'Dòng phụ', default: 'Tournament Summer Season' },
            ],
            layers: [
                {
                    kind: 'text',
                    slot: 'title',
                    place: 'flow',
                    align: 'center',
                    color: '#ffffff',
                    textCase: 'uppercase',
                    font: { family: 'Rubik', weight: 800, size: 144.286, letter: -8.328 },
                    anim: {
                        delay: 0,
                        tracks: {
                            opacity: [[0, 0], [6 / 30, 1]],
                            scale: ZOOM_TITLE_SCALE,
                        },
                    },
                },
                {
                    kind: 'text',
                    slot: 'subtitle',
                    place: 'flow',
                    align: 'center',
                    color: '#000000',
                    font: { family: 'Nunito Sans', weight: 800, size: 51.064, letter: -0.575 },
                    bg: { color: '#fcba00', radius: 0, padX: 66.5, padTop: 29, padBottom: 32 },
                    anim: {
                        delay: 14 / 30,
                        // Mép cắt chạy ĐỀU hết hộp mực trong 12.3 khung; thanh màu KHÔNG bị cắt.
                        tracks: { reveal: [[0, 0], [12.3 / 30, 1]] },
                    },
                },
            ],
        },

        /* ------------------------------------------------------------------
         * "Mood Matcha" — hai dòng chữ TRÒN MẬP viền hai lớp xanh, mọc lên TỪNG KÝ TỰ từ
         * dòng kẻ; kèm một BÌNH SỮA ở trên-trái và ba vệt nhấn ở dưới-phải.
         *
         * SỐ ĐO (video Text Template-Mood Matcha.mp4, 1080×1920, 30fps; khung cuối còn nội
         * dung là 102 => block = khung 13..102, 90 khung = 3.00s).
         *
         *  · CHỮ: lõi TRẮNG #ffffff, viền HAI LỚP đo bằng lát cắt ngang thân chữ 'M'
         *    (x 224..243 ở hàng y=830) và lát dọc qua đỉnh 'M' (y 750..769 ở cột x=260) —
         *    cả hai cho cùng một bộ số: vòng NGOÀI xanh sáng #69eb03 dày 7, vòng TRONG xanh
         *    đậm #304227 dày 13, tổng 20 tính từ mép mực. Không bóng đổ.
         *    Dòng 1 "Mood": mực x 244..777 (534), dải chữ hoa y 770..917 (148).
         *    Dòng 2 "Matcha": mực x 162..867 (706), dải chữ hoa y 988..1135 (148).
         *    Hai baseline cách 218; khe giữa hai HỘP LỚP = 988 − 918 = 70.
         *  · FONT: Nunito 900. Đây là lần đầu phép đo TỈ LỆ chốt được font thay cho IoU:
         *    ở cỡ chữ cho dải chữ hoa đúng 148, Nunito 900 cho "Matcha" rộng 708.3 và
         *    "Mood" rộng 536.8 so với 706 và 534 đo trên video — lệch 0.3% và 0.5% trên
         *    HAI chuỗi độc lập, tức tỉ lệ ngang/dọc của font trùng với video, chỉ cần
         *    letter −0.462 là khớp. (Rubik 900 và Poppins 900 phải kéo letter tới −21..−24
         *    mới khớp bề rộng, tức tỉ lệ sai hẳn.) IoU chồng ảnh chỉ ra Fira Sans 900
         *    (0.689) trên Nunito 900 (0.622), nhưng trần IoU 0.69 nghĩa là "thư viện không
         *    có font cùng loại" — mà Fira Sans là chữ grotesque đầu nét PHẲNG, mất hẳn nét
         *    tròn mập vốn là cả tính cách của mẫu này. Cùng cách loại như "Incorrect" từng
         *    loại Quicksand vì đầu nét bo tròn.
         *  · HOẠT ẢNH CHỮ: từng ký tự phóng từ 0 lên, vọt 1.06 rồi lắng (MATCHA_CHAR_SCALE),
         *    KHÔNG mờ dần (ngay khung đầu nhìn thấy được màu đã bão hoà). Gốc phóng nằm
         *    trên BASELINE, không phải giữa dải chữ hoa: mép dưới chữ đứng yên ở
         *    baseline + 20·s qua từng khung trong khi mép trên đi lên (đo trên 'M' dòng 2:
         *    khung 22 đáy 1139 với s=0.263 -> 1135+5.3 ✓; khung 26 đáy 1158 với s=1.025).
         *    Lệch pha 3 khung = 0.1s.
         *  · CHỖ CỐ Ý LỆCH SỐ ĐO — MỘT Ô NỘI DUNG THAY VÌ HAI (theo yêu cầu): video có
         *    HAI đối tượng chữ riêng, dòng 1 bắt đầu ở khung 14.5 và dòng 2 ở khung 21 —
         *    cách nhau 6.5 khung, KHÔNG phải bội số của lệch pha 3 khung. Ở đây cả mẫu chỉ
         *    còn MỘT ô chữ, hai dòng là phép XUỐNG DÒNG trong ô đó, nên lệch pha chạy LIÊN
         *    TỤC qua chỗ ngắt dòng: 'M' của dòng 2 là ký tự thứ 5 nên vào cảnh ở khung
         *    14.5 + 4·3 = 26.5 thay vì 21. Đánh đổi này để người dùng tự quyết số dòng
         *    (Enter trong ô) chứ không bị khoá ở đúng hai dòng — cùng loại đánh đổi với
         *    phép DỒN DÒNG bị bỏ ở dưới. BỐ CỤC TĨNH KHÔNG ĐỔI: lineStep 218/206.993 giữ
         *    hai baseline cách 218 và hộp lớp cao 366 = 148+70+148 của hai hộp cũ.
         *  · CHỖ CỐ Ý LỆCH SỐ ĐO — PHÉP DỒN DÒNG: trong video, mỗi lần thêm một ký tự thì
         *    CẢ DÒNG được xếp lại và căn giữa lần nữa, nên chữ đã hiện vẫn trôi sang trái
         *    (mép trái dòng 1 đi từ x≈547 ở khung 15 về 224 ở khung 40). Ở đây KHÔNG làm
         *    vậy: hộp tĩnh của mẫu phải độc lập với thời gian — đó là khung transform người
         *    dùng kéo/xoay, và mọi lớp trang trí neo theo nó (bình sữa, vệt nhấn) sẽ nhảy
         *    theo từng ký tự nếu hộp co giãn. Ký tự vì thế hiện ĐÚNG CHỖ CUỐI CÙNG của nó.
         *    Cùng loại đánh đổi với vòng lặp bị bỏ ở "Approved".
         *  · BÌNH SỮA (thay cho cốc trà sữa của video, theo yêu cầu): giữ nguyên HỘP
         *    82×110 và chỗ neo — mép phải cách MỰC DÒNG 1 đúng 26 về bên trái, mép trên
         *    cao hơn đỉnh dải chữ hoa dòng 1 đúng 96. Hiện ở khung 26, phóng 0→1 trong 2
         *    khung rồi lún nhẹ (đo: khung 27 cao 86/110, khung 28 đã 108).
         *    KHE 26 ĐO THEO MỰC DÒNG 1, KHÔNG THEO MÉP HỘP CHỮ: trên video hai số đó
         *    trùng nhau (mép trái hộp = mép trái "Matcha" = 162, mực "Mood" = 244, hiệu
         *    82 đúng bằng bề rộng bình) nên không phân biệt được — nhưng chỉ vì dòng 2
         *    dài hơn dòng 1. Gõ MỘT dòng duy nhất là mép hộp trùng mép chữ và bình sữa
         *    đè lên chữ; còn nếu dòng 2 dài gấp đôi thì neo theo dòng 1 vẫn giữ bình sát
         *    chữ chứ không trôi ra xa. Vì vậy `place.line = 0` (xem layout).
         *    NGHIÊNG 30° về bên PHẢI (theo yêu cầu) — `tilt`, tức nghiêng TĨNH quanh tâm
         *    hộp, KHÔNG nhét vào `tracks.rot`: rot là hoạt ảnh, và một lớp có rot ≠ 0 mãi
         *    thì stateIsRest không bao giờ đúng -> settleTime hết chỗ dừng và thumbnail
         *    của panel lấy sai khung. Hộp tĩnh 82×110 đứng nguyên, chỉ hình trong hộp
         *    nghiêng; lề canvas đã cộng phần choán thêm của hộp nghiêng.
         *  · VỆT NHẤN: hộp 76×88, mép trái cách mép PHẢI hộp chữ 3 về bên trái, mép trên
         *    thấp hơn đáy hộp chữ 20. Hiện ở khung 24, phóng 0→1 trong 4 khung
         *    (bề rộng đo được 29/52/73/76 ở khung 25..28), không mờ dần.
         *  · KHÔNG có hoạt ảnh ra: khung 102 còn nguyên, khung 103 hết block.
         * ------------------------------------------------------------------ */
        {
            id: 'mood-matcha',
            name: 'Mood Matcha',
            duration: 3.0,
            // MỘT lớp chữ duy nhất -> không còn khe giữa hai LỚP; khe giữa hai DÒNG nằm
            // trong `font.lineStep` của lớp đó (xem matchaTextLayer).
            rowGap: 0,
            slots: [
                { id: 'text', label: 'Nội dung', default: 'Mood\nMatcha' },
            ],
            // Dự án CŨ lưu hai ô ['Mood', 'Matcha'] — nối lại thành một ô hai dòng thay vì
            // cắt mất dòng 2 (xem normalizeTexts).
            mergeLegacyTexts: true,
            layers: [
                matchaTextLayer('text', 1.5 / 30),
                {
                    kind: 'glyph',
                    key: 'bottle',
                    label: 'Bình sữa',
                    glyph: 'baby-bottle',
                    size: 110,               // = CHIỀU CAO hộp
                    colors: { milk: '#b7e778', bottle: '#ffffff', cap: '#8ede3a', line: '#304227', cheek: '#f79db1' },
                    // Nghiêng 30° VỀ PHÍA PHẢI (theo yêu cầu) — nghiêng TĨNH, quanh tâm hộp
                    // 82×110, nên hộp và chỗ neo đo được vẫn nguyên.
                    tilt: 30,
                    /* Neo vào MỰC CỦA DÒNG 1 (`line: 0`), không vào mép hộp chữ: khe 26px
                       đo trên video là khe tới CHỮ, và hộp chữ chỉ trùng mép chữ khi dòng
                       1 đúng là dòng dài nhất. dx = −(82 + 26) = −108 -> mép phải bình sữa
                       luôn cách mực dòng 1 đúng 26px, gõ một dòng hay nhiều dòng cũng vậy. */
                    place: { line: 0, fx: 0, fy: 0, lx: 0, ly: 0, dx: -108, dy: -96 },
                    anim: {
                        delay: 13 / 30,
                        tracks: { scale: [[0, 0], [1 / 30, 0.78], [2 / 30, 0.99], [3 / 30, 0.96], [5 / 30, 1]] },
                    },
                },
                {
                    kind: 'glyph',
                    key: 'spark',
                    label: 'Vệt nhấn',
                    glyph: 'spark-wedges',
                    size: 88,
                    colors: { mark: '#ffffff' },
                    place: { fx: 1, fy: 1, lx: 0, ly: 0, dx: -3, dy: 20 },
                    anim: {
                        delay: 11 / 30,
                        tracks: { scale: [[0, 0], [1 / 30, 0.38], [2 / 30, 0.68], [3 / 30, 0.96], [4 / 30, 1]] },
                    },
                },
            ],
        },

        /* ---------------------------------------------------------------------
         * 9) CUSTOM — mẫu DUY NHẤT không đo từ video CapCut.
         *
         * Người dùng ghép MỘT đối tượng trong thư viện (library/Elements) với MỘT ô
         * chữ, và tự chọn đối tượng ấy trong panel Thuộc tính.
         *
         * SỐ ĐO LẤY TỪ BẢN VẼ THIẾT KẾ của người dùng (2026-09-13), đo bằng pixel trên
         * "Dimension - Textbox Icon.png" / "Dimension - Textbox Illus.png" và hai bản
         * dựng mẫu "Textbox - Icon/Illus". Cả năm tệp đều có HỘP TRẮNG cao H = 71px,
         * bước dòng 22px, bo góc 12px, chữ #202020 trên nền #ffffff.
         *
         *   · HỘP TRẮNG bo góc: bán kính 12/71 = 0.169·H; đệm NGANG mỗi bên = H/2 (đúng
         *     hai dải hồng ghi "X/2" ở hai đầu hộp trong bản vẽ Icon).
         *   · Icon  — vuông cạnh X = H, TÂM đặt đúng GÓC TRÊN-TRÁI của hộp trắng. Tức
         *     hình thò ra ngoài hộp X/2 sang trái và X/2 lên trên, phần đè lên hộp phủ
         *     vừa đúng cột đệm trái. Ba tệp xác nhận: dấu + ở (60,40) với góc hộp (60,41);
         *     hình 71×71 tâm (35,35) với góc hộp (36,36) ở cả hai bản dựng.
         *   · Illus — vuông cạnh Y = 1.41·H (đo 100 và 101 trên hai tệp, H = 71), CANH
         *     GIỮA theo chiều dọc của hộp, đè lên hộp 0.3·Y kể từ mép trái hộp.
         *
         * ĐÂY LÀ THAY ĐỔI SO VỚI BẢN TRƯỚC: trước đây hình đứng HẲN BÊN TRÁI hộp chữ,
         * cách một khe hở, và không có nền trắng — đọc nhầm bản vẽ cũ, người dùng báo
         * sai cả hai. Nay hình ĐÈ LÊN hộp, và hộp có nền.
         *
         * MỌI SỐ ĐỀU LÀ TỈ LỆ, KHÔNG PHẢI PX. Các mẫu khác chép nguyên px@1080 đo
         * được trên video; ở đây thiết kế được phát biểu bằng "bao nhiêu lần chiều cao
         * hộp trắng", nên khi người dùng đổi cỡ chữ / số dòng trong panel thì hình, đệm
         * và bo góc tự đi theo. Cơ chế: `variants[].sizeRel` (xem measureImageLayer),
         * `place.lx/ly` (xem layout) và `bg.padXRel` / `bg.radiusRel` (measureTextLayer).
         *
         * ĐỔI KIỂU ICON <-> ILLUS KHÔNG PHẢI ĐỔI MẪU: hai kiểu là hai `variant` của
         * CÙNG một lớp ảnh, ghi vào override. Tách thành hai template thì mỗi lần đổi
         * kiểu, switchTextTemplate sẽ xoá sạch override — mất luôn hình đã chọn và mọi
         * chỉnh sửa font/màu. Đây cũng là lý do lớp ảnh mang sẵn bảng `variants` thay
         * vì để UI tự biết có hai kiểu.
         *
         * HOẠT ẢNH (do ta thiết kế, không đo từ đâu):
         *   · CHỮ — hiện dần TỪNG KÝ TỰ, mỗi ký tự mờ dần vào và nhích lên 16px; lệch
         *     pha 0.012s/ký tự nên một dòng ~30 ký tự chạy hết trong ~0.36s: đọc ra như
         *     một vệt sáng quét ngang chứ không phải máy đánh chữ giật cục.
         *   · HÌNH — popup (0 -> vọt 1.11 -> 1) đi kèm LẮC XOAY giảm dần từ 30° về 0
         *     (nhịp 0.42s, tắt dần τ=0.26s -> tới 1.5s còn 0.09°, mắt không thấy). Hai
         *     đường đều là dampedTrack, tức cùng một họ chuyển động -> nảy và lắc ăn
         *     khớp nhau thay vì mỗi thứ một kiểu.
         *   · Hình vào TRƯỚC chữ 0.06s: mắt bắt vào vật thể lớn trước rồi mới đọc chữ.
         * ------------------------------------------------------------------ */
        {
            id: 'custom',
            name: 'Custom',
            duration: 3.0,
            rowGap: 0,
            /* TỰ CO CHO VỪA KHỔ (xem `fitWidth` ở layout). 880px = ~82% bề ngang khung
               tham chiếu 1080; phần chừa hai bên là vùng an toàn thường thấy của video
               dọc, mẫu không bao giờ chạm mép dù người dùng gõ bao nhiêu chữ.
               Đây là mẫu DUY NHẤT cần nó: tám mẫu kia đo từ video nên cỡ chữ đã chốt
               theo đúng nội dung của video đó. */
            fitWidth: 880,
            slots: [{
                id: 'text',
                label: 'Nội dung',
                default: 'During routine testing.\nThe affected components include.',
            }],
            layers: [
                {
                    kind: 'text',
                    slot: 'text',
                    place: 'flow',
                    align: 'left',
                    /* #202020 TRÊN NỀN TRẮNG — đúng màu đo được trong bản vẽ (màu đặc thứ hai
                       sau #ffffff ở cả năm tệp thiết kế). Bản trước để chữ TRẮNG không nền vì
                       hiểu nhầm rằng nền trắng của bản vẽ chỉ là giấy; hệ quả là chữ chìm vào
                       cảnh quay sáng và thiết kế mất hẳn khối nền — đúng lỗi người dùng báo. */
                    color: '#202020',
                    /* HỘP TRẮNG BO GÓC — khối nền của thiết kế, và cũng là thứ định nghĩa
                       "chiều cao hộp" mà cạnh hình Icon/Illus neo theo (hộp lớp chữ NỞ RA đúng
                       phần đệm, xem measureTextLayer). Đo trên bản vẽ ở H = 71px:
                         bo góc 12  -> 0.169·H      (radiusRel)
                         đệm ngang 35.5 mỗi bên     -> H/2 (padXRel), đúng hai dải "X/2"
                         đệm trên/dưới 19          -> 1.123 lần cỡ chữ, viết ở lớp 120px@1080
                       Đệm DỌC theo cỡ chữ (không theo H) vì chính nó sinh ra H; đệm NGANG và
                       bo góc theo H để mọi số đo của hình vẫn đúng khi người dùng gõ thêm dòng. */
                    bg: {
                        color: '#ffffff',
                        radiusRel: 0.169,
                        padXRel: 0.5,
                        padTop: 134.8,
                        padBottom: 134.8,
                    },
                    /* 120px@1080 là CỠ TỐI ĐA, không phải cỡ cố định: `fitWidth` ở trên co
                       cả mẫu lại khi chữ dài, nên câu mặc định hai dòng vẫn ra ~50px y như
                       trước. Trần 120 để chữ NGẮN không phình thành khẩu hiệu chiếm nửa
                       khung — nó nằm giữa cỡ của các mẫu đo từ video (Zoom Title 96,
                       Approved 147) nên Custom đứng cạnh chúng không lạc lõng.
                       Trước đây đây là con số CHẾT 48, chọn vừa cho đúng câu mặc định: đổi
                       mẫu khác sang Custom là chữ ngắn theo sang và cả cụm (chữ + Icon/
                       Illus, vì cạnh hình lấy từ chiều cao hộp chữ) teo còn 1/4 các mẫu
                       kia — đúng lỗi người dùng báo. */
                    font: { family: 'Source Sans 3', weight: 700, size: 120, letter: 0, lineStep: 1.30 },
                    anim: {
                        perChar: { stagger: 0.012 },
                        tracks: {
                            opacity: [[0, 0], [0.18, 1]],
                            // nhích lên: chậm dần về cuối (không phải tuyến tính) cho mềm mắt
                            dy: [[0, 16], [0.08, 7.4], [0.16, 2.8], [0.24, 0.6], [0.30, 0]],
                        },
                    },
                },
                {
                    kind: 'image',
                    key: 'art',
                    label: 'Hình',
                    variant: 'icon',
                    /* `prefix` = tiền tố TÊN TỆP trong library/Elements mà kiểu này nhận.
                       Panel Thuộc tính lọc thư viện bằng đúng chuỗi này, nên "đang là Icon
                       thì không thả Illus vào được" là hệ quả của MỘT chỗ khai, không phải
                       một luật viết riêng ở phía UI. */
                    /* `sizeRel` = cạnh hình / CHIỀU CAO HỘP TRẮNG. `place` = chỗ TÂM hình đậu
                       trên hộp, theo đúng bản vẽ (xem khối chú thích đầu mẫu):
                         Icon  — tâm đúng GÓC TRÊN-TRÁI hộp: fx/fy = (0,0) là góc ấy, lx/ly =
                                 (0.5,0.5) lấy TÂM hình làm mốc -> hình đè lên hộp X/2 × X/2.
                         Illus — canh giữa dọc (fy 0.5, ly 0.5) và đè lên hộp 0.3·Y: lx = 0.7
                                 đặt mốc ở 70% bề rộng hình, tức mép phải hình thò qua mép trái
                                 hộp đúng 0.3·Y. */
                    variants: {
                        icon: { label: 'Icon', prefix: '[Icon]', sizeRel: 1.0, place: { fx: 0, fy: 0, lx: 0.5, ly: 0.5 } },
                        illus: { label: 'Illus', prefix: '[Illus]', sizeRel: 1.41, place: { fx: 0, fy: 0.5, lx: 0.7, ly: 0.5 } },
                    },
                    /* Rỗng = "chưa chọn" -> caller (editing-runtime) đưa hình đầu tiên hợp
                       kiểu trong thư viện. KHÔNG chốt sẵn một tên tệp ở đây: library/ là
                       thư mục của người dùng, tệp ta ghi cứng hôm nay có thể không còn. */
                    src: '',
                    name: '',
                    /* Chỗ đậu THẬT nằm ở `variants[].place` (hai kiểu đậu khác nhau). Giữ
                       một `place` ở đây làm bản dự phòng cho kiểu không khai — layout ưu tiên
                       bản của variant, xem chỗ đọc `place` trong layoutAt. */
                    place: { fx: 0, fy: 0, lx: 0.5, ly: 0.5 },
                    anim: {
                        delay: 0,
                        tracks: {
                            opacity: [[0, 0], [0.04, 1]],
                            scale: dampedTrack(0, 1, 0.10, 0.44, 0.70, 1 / 60),
                            rot: dampedTrack(30, 0, 0.26, 0.42, 1.50, 1 / 60),
                        },
                    },
                },
            ],
        },

        /* ---------------------------------------------------------------------
         * 10) VLOG TAG — thẻ chữ nền trắng với HAI THẺ VÀNG nấp sau, lần lượt lớn dần
         *     thò ra ở góc trên-trái rồi góc dưới-phải.
         *
         * SỐ ĐO (video Text Template-Vlog Tag.mp4, 1080×1920, 30fps; khung đầu có nội dung
         * là 12, khung cuối là 101 => block = khung 12..101, 90 khung = 3.00s).
         *
         *  · HỘP TRẮNG: x 120..963, y 776..1140 (844×365), góc VUÔNG (hàng y=776 đã đủ
         *    844px), màu #ffffff (histogram ra 251,250,253 — lệch do nén video).
         *  · CHỮ đen ba dòng, mực: dòng 1 x 169..918 (750), dòng 2 161..832 (672), dòng 3
         *    164..639 (476); baseline 884.5 / 983.5 / 1082.5 -> bước dòng đúng 99.
         *    Dải chữ hoa 70 ('B' 815..884), ascender 75 ('f','l' 810..884), x-height 53,
         *    thân 'l' rộng 12.
         *    FONT: OPEN SANS 600 — kết luận rõ nhất trong cả bộ mẫu tới giờ. Ba phép đo
         *    độc lập đều chỉ vào nó: (a) chồng ảnh IoU trên CẢ BA dòng — 0.965/0.934/0.951,
         *    so với á quân Open Sans 500 (0.868 trung bình) và Noto Sans 600 (0.850);
         *    (b) bề rộng mực từng chữ cái (17 chữ) — sai số RMS 1.4%, thấp nhất trong 51
         *    font; (c) tỉ lệ hình dáng asc/cap = 75/70 = 1.071 và x/cap = 0.757 — loại hết
         *    nhóm asc = cap (Inter, Figtree) và nhóm chữ hẹp (Mulish, Prompt).
         *    Cỡ chữ và letter-spacing đo bằng CHÍNH canvas của Chrome: size 97.5 cho
         *    ascent của 'H' đúng 70, letter 0.228 cho mực dòng 1 đúng 750. Kiểm chéo hai
         *    dòng còn lại: 671.6 và 474.0 so với 672 và 476 đo trên video (lệch 0.1% và
         *    0.4%), ascender 75 và descender 23 khớp đúng.
         *    ĐỆM NỀN: ngang 47 mỗi bên (750 + 2×47 = 844 ✓), TRÊN dải chữ hoa 39
         *    (776 -> 815, baseline ở 109 dưới mép trên hộp), DƯỚI baseline cuối 58
         *    (365 = 39 + 70 + 2×99 + 58). Nét thả của 'g','y' (23px) nằm gọn trong 58 đó.
         *  · THẺ VÀNG #ffd744 (đo rgb(255,215,68)), góc vuông, NẰM SAU hộp trắng nên chỉ
         *    thò ra hai dải chữ L:
         *      thẻ LỚN  x 90..939, y 751..1035 (850×285) — thò ra trên-trái;
         *      thẻ NHỎh x 834..987, y 1042..1167 (154×126) — thò ra dưới-phải.
         *    CẠNH CỦA THẺ ĐO THEO HỘP CHỮ, KHÔNG PHẢI SỐ PX CỐ ĐẮNH (`fit`, xem
         *    measureGlyphLayer): thẻ lớn = bề rộng hộp + 6 và 0.781 chiều cao hộp, thẻ nhỏ
         *    = 0.1825 × 0.3452 hộp. Người dùng gõ dài ngắn bao nhiêu thì thẻ vẫn trùm đúng
         *    bấy nhiêu; viết px cố định thì chỉ đúng với đúng chuỗi mẫu.
         *  · HOẠT ẢNH: chữ và hộp trắng KHÔNG có hoạt ảnh — hiện nguyên hình ở khung 12 và
         *    đứng yên tới hết (đo số pixel mực: y hệt nhau từng khung, không mờ dần, không
         *    máy đánh chữ). Hai thẻ vàng PHÓNG TỪ 0 quanh TÂM CHÍNH NÓ: tâm đo được đứng
         *    yên từng khung (514.5 cho thẻ lớn, 911 cho thẻ nhỏ) trong khi hai cạnh lớn dần.
         *    Chúng cũng MỜ DẦN vào: màu ở LÕI dải vàng (cách mép 3px) đi từ (151,122,40)
         *    ở khung 30 lên (255,215,68) ở khung 47 — toàn bộ lõi cùng đậm dần chứ không
         *    phải chỉ mép, tức độ mờ thật. HAI THẺ CHẠY HAI ĐƯỜNG KHÁC NHAU (thẻ lớn xong
         *    ở khung 29, thẻ nhỏ mãi khung 47) — xem VLOG_BIG_SCALE / VLOG_SMALL_SCALE.
         *  · KHÔNG có hoạt ảnh ra: khung 101 còn nguyên, khung 102 hết block.
         * ------------------------------------------------------------------ */
        {
            id: 'vlog-tag',
            name: 'Vlog Tag',
            duration: 3.0,
            rowGap: 0,
            slots: [
                { id: 'text', label: 'Nội dung', default: 'Butterflies taste\nwith their feet\namazingly' },
            ],
            /* Hai thẻ khai TRƯỚC lớp chữ = vẽ trước, tức NẰM SAU hộp trắng — đúng thứ làm
               nên cả mẫu này: phần thẻ bị hộp trắng che đi là lý do ta chỉ thấy hai dải chữ L
               thay vì hai hình chữ nhật. Cũng vì vậy đoạn đầu của phép phóng (hệ số nhỏ) là
               VÔ HÌNH: thẻ lớn chỉ lòi ra khỏi hộp khi hệ số vượt 0.82, thẻ nhỏ khi vượt 0.56. */
            layers: [
                {
                    kind: 'glyph',
                    key: 'cardBack',
                    label: 'Thẻ lớn',
                    glyph: 'card',
                    colors: { fill: '#ffd744' },
                    // Cạnh theo hộp chữ: rộng bằng hộp + 6, cao 0.781 hộp (285/365).
                    fit: { fw: 1, dw: 6, fh: 0.781 },
                    // Góc TRÊN-TRÁI thẻ đặt lệch ra ngoài góc trên-trái hộp chữ (−30, −25).
                    place: { fx: 0, fy: 0, lx: 0, ly: 0, dx: -30, dy: -25 },
                    anim: { delay: 0, tracks: { scale: VLOG_BIG_SCALE, opacity: VLOG_BIG_FADE } },
                },
                {
                    kind: 'glyph',
                    key: 'cardFront',
                    label: 'Thẻ nhỏ',
                    glyph: 'card',
                    colors: { fill: '#ffd744' },
                    fit: { fw: 0.1825, fh: 0.3452 },
                    // Góc DƯỚI-PHẢI thẻ lệch ra ngoài góc dưới-phải hộp chữ (+24, +27).
                    place: { fx: 1, fy: 1, lx: 1, ly: 1, dx: 24, dy: 27 },
                    // Thẻ nhỏ vào muộn hơn 5 khung và chạy chậm hơn hẳn (xem VLOG_SMALL_SCALE).
                    anim: { delay: 5 / 30, tracks: { scale: VLOG_SMALL_SCALE, opacity: VLOG_SMALL_FADE } },
                },
                {
                    kind: 'text',
                    slot: 'text',
                    place: 'flow',
                    align: 'left',
                    color: '#000000',
                    font: { family: 'Open Sans', weight: 600, size: 97.5, letter: 0.228, lineStep: 99 / 97.5 },
                    bg: { color: '#ffffff', radius: 0, padX: 47, padTop: 39, padBottom: 58 },
                    // Không `anim`: video cho thấy chữ hiện nguyên hình ngay khung đầu của block.
                },
            ],
        },
        /* ---------------------------------------------------------------------
         * 11) WELCOME — chữ bóng hồng viền hai lớp bật ra TẮNG CHỮ, kèm hai bông cúc ở
         *     trên-trái và mũi tên cuốn vẽ tay ở dưới-phải.
         *
         * SỐ ĐO (video Text Template-Welcome.mp4, 1080×1920, 30fps; khung đầu có nội dung
         * là 13, khung cuối 101 => block = khung 12..101, 90 khung = 3.00s).
         *
         *  · CHỮ "Welcome": mực 728×154 tại x 176..903, dải chữ hoa 148 (870..1017, baseline
         *    1017), ascender của 'l' cũng 148 (asc = cap), x-height 109, thân 'l' rộng 40
         *    (rất mập — chữ bóng).
         *    FONT: SMOOCH SANS 900. Đây là trường hợp "thư viện không có font cùng loại" giống
         *    "Folgen Sie": mẫu dùng chữ BÓNG (bubble) mà 51 font của app không có họ nào như
         *    vậy. Trong số còn lại, Smooch Sans 900 thắng cả ba phép đo: IoU chồng ảnh 0.798
         *    (Fira Sans 900 0.776, Heebo 900 0.773, Quicksand 700 0.541); tỉ lệ asc/cap = 1.000
         *    và x/cap = 0.758 khớp video (1.000 / 0.736); và quan trọng nhất là TỈ LỆ NGANG/DỌC
         *    tự nhiên đúng — ở cỡ cho dải chữ hoa 148 nó viết "Welcome" rộng 685.7 so với 728
         *    đo được, chỉ cần letter +7.05; các ứng viên kia phải kéo letter tới −22..−31 mới vừa
         *    (tức chữ phải chồng lên nhau — sai hẳn dáng). => size 237.27, letter 7.05.
         *  · MÀU: thân #ff6384, viền TRONG trắng dày 17, viền NGOÀI #febdbd dày 29 (đo bằng lát
         *    cắt ngang qua thân chữ: từ mực ra 17px trắng rồi 12px hồng nhạt — hai viền đều tính
         *    TỪ MỰC nên viền ngoài = 17 + 12).
         *  · BÓNG ĐỔ: dải xám 8px lộ ra ở mép PHẢI và mép DƯỚI, không có ở mép trái/trên.
         *    Màu suy từ hai nền khác nhau (tóc sẫm và da sáng) để khử nền: kết quả ra cùng một
         *    màu xám ~#646464 ở ~80% — tức bóng của sticker, không phải viền thứ ba.
         *  · HOA và MŨI TÊN: xem 'two-flowers' và 'curl-arrow'. Chỗ đậu đo trên khung f61:
         *    cặp hoa x 44..183 y 734..899, mũi tên x 892..1020 y 979..1146, so với hộp chữ
         *    (176, 870).
         *  · HOẠT ẢNH: chữ bật TẮNG CHỮ từ khung 13, lệch pha 1.33 khung; hoa và mũi tên bật
         *    cùng lúc từ khung 20. Cả ba đều phóng từ 0 có vọt quá (xem WELCOME_CHAR_POP /
         *    WELCOME_DECO_POP), không mờ dần — ngay khung đầu nhìn thấy đã bão hoà màu.
         *  · CHỖ CỐ Ý LỆCH SỐ ĐO — PHÉP DỒN DÒNG: trong video, mỗi lần thêm một chữ thì cả
         *    dòng được căn giữa lại nên chữ đã hiện vẫn trôi sang trái (mép trái đi từ 526 ở
         *    khung 13 về 176 ở khung 27). Ở đây ký tự hiện ĐÚNG CHỖ CUỐI CÙNG của nó — cùng
         *    đánh đổi và cùng lý do với "Mood Matcha": hộp tĩnh của mẫu phải độc lập với thời
         *    gian vì nó là khung transform người dùng kéo, và hoa/mũi tên neo theo nó.
         *  · KHÔNG có hoạt ảnh ra: khung 101 còn nguyên, khung 102 hết block.
         * ------------------------------------------------------------------ */
        {
            id: 'welcome',
            name: 'Welcome',
            duration: 3.0,
            rowGap: 0,
            slots: [
                { id: 'text', label: 'Nội dung', default: 'Welcome' },
            ],
            /* Hoa và mũi tên khai TRƯỚC lớp chữ = vẽ trước. Hai hình này không chạm vào chữ
               ở chuỗi mẫu, nhưng gõ chuỗi dài hơn thì mép chữ sẽ lấn tới — lúc đó chữ đè lên
               hình mới đúng (chữ là nội dung, hình là trang trí). */
            layers: [
                {
                    kind: 'glyph',
                    key: 'flowers',
                    label: 'Hoa',
                    glyph: 'two-flowers',
                    size: 166,                 // = CHIỀU CAO hộp (140×166 đo trên video)
                    colors: { petalA: '#febdbd', coreA: '#fef9f2', petalB: '#fef9f2', coreB: '#febdbd' },
                    // Góc trên-trái cặp hoa lệch (−132, −136) so với góc trên-trái hộp chữ.
                    place: { fx: 0, fy: 0, lx: 0, ly: 0, dx: -132, dy: -136 },
                    anim: { delay: 8 / 30, tracks: { scale: WELCOME_DECO_POP } },
                },
                {
                    kind: 'glyph',
                    key: 'arrow',
                    label: 'Mũi tên',
                    glyph: 'curl-arrow',
                    size: 168,                 // = CHIỀU CAO hộp (129×168)
                    colors: { mark: '#ffffff' },
                    // Góc trên-trái mũi tên so với mép PHẢI hộp chữ: lùi trái 11, xuống 109.
                    place: { fx: 1, fy: 0, lx: 0, ly: 0, dx: -11, dy: 109 },
                    anim: { delay: 8 / 30, tracks: { scale: WELCOME_DECO_POP } },
                },
                {
                    kind: 'text',
                    slot: 'text',
                    place: 'flow',
                    align: 'center',
                    color: '#ff6384',
                    font: { family: 'Smooch Sans', weight: 900, size: 237.27, letter: 7.05, lineStep: 1.15 },
                    stroke: { color: '#ffffff', width: 17 },
                    stroke2: { color: '#febdbd', width: 29 },
                    shadow: { color: 'rgba(100, 100, 100, 0.8)', dx: 8, dy: 10, blur: 6 },
                    anim: {
                        delay: 0,
                        // 8 khung cho 6 khoảng giữa 7 chữ = 1.333 khung một chữ.
                        perChar: { stagger: 2 / 45 },
                        tracks: { scale: WELCOME_CHAR_POP },
                    },
                },
            ],
        },
    ];

    const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

    function byId(id) {
        return BY_ID.get(String(id || '')) || null;
    }

    /* ===================== THUMBNAIL CHO PANEL ============================
     * Vẽ template vào một canvas nhỏ, tự chọn hệ số để lấp ~86% bề ngang ô.
     * p ∈ [0,1] = tiến độ trong thời lượng mặc định (hover thì chạy vòng lặp,
     * lúc tĩnh thì lấy settleTime để thấy hình đã vào cảnh xong). */
    function drawThumb(canvas, id, p, opts) {
        /* Nhận CẢ id lẫn object template: mẫu "Custom" phải vẽ thumbnail theo hình mà
           BLOCK đang chọn dùng (lưới "Đổi mẫu" trong panel Thuộc tính), mà hình đó nằm
           trong override của item — không tra ngược được từ id. */
        const tpl = (id && typeof id === 'object') ? id : byId(id);
        if (!canvas || !tpl) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0c0d10';
        ctx.fillRect(0, 0, W, H);
        const texts = defaultTexts(tpl);
        // Đo ở hệ px gốc rồi suy ra hệ số vừa ô (đo 2 lần vì hộp phụ thuộc k tuyến tính).
        const imageFor = (opts && typeof opts.imageFor === 'function') ? opts.imageFor : null;
        const base = layout(ctx, tpl, texts, 1, { frameW: W, frameH: H, imageFor });
        const k = Math.min((W * 0.86) / base.width, (H * 0.7) / base.height);
        const lay = layout(ctx, tpl, texts, k, { frameW: W, frameH: H, imageFor });
        const t = (p == null) ? settleTime(tpl, texts) : Math.max(0, Math.min(1, p)) * (Number(tpl.duration) || 3);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, H);
        ctx.clip();
        ctx.translate((W - lay.width) / 2 - lay.marginX, (H - lay.height) / 2 - lay.marginY);
        drawFrame(ctx, tpl, texts, t, lay);
        ctx.restore();
    }

    return {
        REF_SHORT_SIDE,
        TEMPLATES,
        GLYPHS,
        byId,
        defaultTexts,
        normalizeTexts,
        textForSlot,
        fonts,
        layerKey,
        layerTextStyle,
        layerGlyphColors,
        imageVariantOf,
        editableLayers,
        defaultOverrides,
        resolve,
        layout,
        drawFrame,
        drawThumb,
        frameSignature,
        settleTime,
        layerStateAt,
        charStateAt,
        trackAt,
    };
});
