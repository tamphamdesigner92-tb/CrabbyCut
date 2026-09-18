/* =====================================================================
 * MẪU VĂN BẢN (Text template) — chốt hình học & đường thời gian của từng mẫu
 *
 * VÌ SAO CÓ TEST NÀY: mọi con số trong static/js/text-templates.js được ĐO TỪNG
 * PIXEL trên video mẫu CapCut. Chúng là DỮ LIỆU THAM CHIẾU, không phải tham số
 * tinh chỉnh cho đẹp — sửa nhầm một số là mẫu lệch hẳn so với bản CapCut mà
 * không có gì báo. Test giữ đúng những con số đã đo, và giữ luôn HỢP ĐỒNG của
 * engine (hộp tĩnh, lề canvas, chữ ký khung, vòng lặp) mà preview và khâu xuất
 * đều dựa vào.
 *
 * CÁCH ĐO: engine là module thuần CommonJS nên require thẳng. Node không có
 * canvas, nên ctx đo chữ được thay bằng THƯỚC ĐO TẤT ĐỊNH: trả về đúng hộp mực
 * mà font thật cho ra ở cỡ chữ của mẫu (đã kiểm trong Chrome: "APPROVED" ở
 * Source Sans 3 700 / size 147.4 / letter 1.36 ra hộp mực 710×100). Nhờ vậy
 * thuật toán xếp chỗ vẫn là thuật toán thật, chỉ phép đo chữ là giả — và giả
 * một cách biết trước.
 *
 * SỐ THAM CHIẾU CỦA "APPROVED" (video 1080×1920, 30fps, block = khung 12..101):
 *   nhóm  x 74..988  (rộng 915)
 *   chữ   x 278..988 (rộng 711), y 911..1010 (cao 100)
 *   đĩa   d 150, tâm (148.5, 958.5) -> khe đĩa↔chữ = 54.5
 *   đĩa lặp chu kỳ 0.80s, lệch pha 0.567s; d theo khung:
 *     f30 26 · f39 166 (vọt) · f42..f47 150 · f48..f52 mất · f53 hiện lại
 * ================================================================== */
const assert = require('assert');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const TextTemplates = require(path.join(projectRoot, 'static', 'js', 'text-templates.js'));

/* ---- Thước đo chữ tất định (thay canvas) --------------------------------
 * Hộp mực của "APPROVED" ở cỡ chữ của mẫu: rộng 710, cap-height 100, bearing 0.
 * Tỉ lệ theo cỡ chữ để đo được cả khi caller đổi hệ số k.
 * Chuỗi CÓ DẤU tiếng Việt được giả thêm mực tràn trên/dưới dải chữ hoa (dấu ngã
 * +26, dấu nặng +12) để kiểm đúng cái phần mềm phải chịu ngoài thực tế. */
function fakeCtx() {
    let font = '';
    return {
        set font(v) { font = v; },
        get font() { return font; },
        letterSpacing: '0px',
        save() {}, restore() {},
        measureText(text) {
            const size = Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]) || 100;
            const rel = size / 147.4;
            const perChar = 710 / 8;      // "APPROVED" = 8 ký tự ở size 147.4
            const s = String(text);
            const w = (s.length * perChar) * rel;
            const hasAbove = /[ãàáảâêôơưđ]/i.test(s);
            const hasBelow = /[ệẹịọụạgjpqy]/i.test(s);
            return {
                width: w,
                actualBoundingBoxLeft: 0,
                actualBoundingBoxRight: w,
                actualBoundingBoxAscent: (100 + (hasAbove ? 26 : 0)) * rel,
                actualBoundingBoxDescent: (hasBelow ? 12 : 0) * rel,
            };
        },
    };
}

const FRAME = { frameW: 1080, frameH: 1920 };
const tpl = TextTemplates.byId('approved');
assert.ok(tpl, 'phải có mẫu "approved"');

// ---- 1) Thời lượng & ô chữ -------------------------------------------------
assert.strictEqual(tpl.duration, 3.0, 'thời lượng mặc định = 3.00s (90 khung @30fps đo trên video)');
assert.deepStrictEqual(TextTemplates.defaultTexts(tpl), ['APPROVED']);
assert.deepStrictEqual(TextTemplates.normalizeTexts(tpl, []), ['APPROVED'],
    'thiếu nội dung -> rơi về mặc định của ô');
assert.deepStrictEqual(TextTemplates.normalizeTexts(tpl, ['Xong', 'thừa']), ['Xong'],
    'nội dung thừa bị bỏ, đúng số ô của mẫu');

// ---- 2) Hình học hộp tĩnh --------------------------------------------------
const lay = TextTemplates.layout(fakeCtx(), tpl, TextTemplates.defaultTexts(tpl), 1, FRAME);
// nhóm = đĩa 150 + khe 55 + chữ 710 = 915 (video đo 915)
assert.ok(Math.abs(lay.width - 915) <= 2, `bề rộng nhóm ${lay.width.toFixed(1)} phải ≈ 915`);
assert.ok(Math.abs(lay.height - 150) <= 1, `chiều cao nhóm ${lay.height.toFixed(1)} phải ≈ 150 (đĩa cao hơn chữ)`);

const textBox = lay.boxes[0];
const discBox = lay.boxes[1];
assert.ok(Math.abs((discBox.x + discBox.w) - (textBox.x - 55)) < 0.01,
    'mép phải đĩa cách mép trái mực chữ đúng 55px');
assert.ok(Math.abs((discBox.y + discBox.h / 2) - (textBox.y + textBox.h / 2)) < 0.01,
    'đĩa và chữ cùng tâm dọc');
assert.ok(Math.abs(discBox.w - 150) < 0.01 && Math.abs(discBox.h - 150) < 0.01, 'đĩa 150×150');

/* Hộp KHÔNG ĐƯỢC chạy theo dấu tiếng Việt: nếu chiều cao hộp đo theo mực thật thì
   tâm dọc trôi theo dấu, và hình trang trí neo fy:0.5 sẽ lệch lên/xuống tuỳ chuỗi
   người dùng gõ. Dải chữ hoa cố định -> đĩa đứng đúng chỗ; dấu tràn ra ngoài hộp và
   được lề canvas nuốt. */
const layVi = TextTemplates.layout(fakeCtx(), tpl, ['ĐÃ DUYỆT'], 1, FRAME);
assert.ok(Math.abs(layVi.height - lay.height) < 0.01,
    `chiều cao hộp phải KHÔNG đổi theo dấu (${layVi.height} vs ${lay.height})`);
const viText = layVi.boxes[0];
const viDisc = layVi.boxes[1];
assert.ok(Math.abs((viDisc.y + viDisc.h / 2) - (viText.y + viText.h / 2)) < 0.01,
    'chuỗi có dấu: đĩa vẫn cùng tâm dọc với dải chữ hoa');
assert.ok(layVi.measured[0].overTop > 0 && layVi.measured[0].overBottom > 0,
    'phải báo được phần mực tràn trên/dưới để layout cộng vào lề');
assert.ok(layVi.marginY >= lay.marginY, 'lề dọc phải nới ra cho dấu, không co lại');

// Hệ số k nhân TUYẾN TÍNH mọi số đo (quy ước lớp 1080 -> Sequence thật).
const lay2 = TextTemplates.layout(fakeCtx(), tpl, TextTemplates.defaultTexts(tpl), 2,
    { frameW: 2160, frameH: 3840 });
assert.ok(Math.abs(lay2.width - lay.width * 2) < 1, 'k=2 -> hộp tĩnh gấp đôi');
assert.ok(Math.abs(lay2.height - lay.height * 2) < 1, 'k=2 -> chiều cao gấp đôi');

// ---- 3) Lề canvas: đủ chứa hoạt ảnh, nhưng KHÔNG vượt trần theo khung hình --
/* Chữ phóng 10.9× = 7700px rộng; tính đủ lề cho nó thì canvas ~9000px và bake
   90 khung PNG cỡ đó là renderer chết. Lề phải bị kẹp theo khung hình — phần
   nằm ngoài khung người xem không thấy (chính CapCut cũng chỉ vẽ tới mép). */
const capX = Math.max(0, (FRAME.frameW - lay.width) / 2) + FRAME.frameW * 0.1;
const capY = Math.max(0, (FRAME.frameH - lay.height) / 2) + FRAME.frameH * 0.1;
assert.ok(lay.marginX <= capX + 0.5, `marginX ${lay.marginX} phải bị kẹp ≤ ${capX.toFixed(0)}`);
assert.ok(lay.marginY <= capY + 0.5, `marginY ${lay.marginY} phải bị kẹp ≤ ${capY.toFixed(0)}`);
// Lề dọc phải đủ chứa chiều cao chữ lúc phóng to nhất (100 × 10.86 ≈ 1086)
assert.ok(lay.height + 2 * lay.marginY >= 1080,
    `canvas cao ${(lay.height + 2 * lay.marginY).toFixed(0)} phải chứa nổi chữ cao ~1090 lúc zoom`);
// Đĩa vọt 1.11× (166px) không được bị xén theo trục dọc
assert.ok(lay.height + 2 * lay.marginY >= 166, 'canvas phải chứa cả lúc đĩa vọt 166px');

// ---- 4) Đường thời gian lớp CHỮ -------------------------------------------
const textLayer = tpl.layers[0];
const stAt = (t) => TextTemplates.layerStateAt(textLayer, t);
assert.ok(Math.abs(stAt(0).scale - 10.86) < 0.01, 'chữ bắt đầu ở 10.86×');
assert.strictEqual(stAt(0).opacity, 0, 'chữ bắt đầu trong suốt');
assert.ok(Math.abs(stAt(0.2).opacity - 1) < 1e-6, 'opacity đầy sau 0.20s');
assert.ok(Math.abs(stAt(0.5).scale - 1) < 1e-6, 'chữ về đúng 1× ở 0.50s');
assert.ok(Math.abs(stAt(2.9).scale - 1) < 1e-6, 'sau đó đứng yên tới hết block (không có hoạt ảnh Ra)');
/* Hệ số phóng ĐO TRỰC TIẾP trên khung 18..27 của video (khung 12 = đầu block).
   Đây là số tham chiếu, không phải giá trị tinh chỉnh -> khớp phải gần như tuyệt đối. */
const REF_TEXT_SCALE = {
    18: 7.759, 19: 6.975, 20: 6.127, 21: 5.291, 22: 4.481,
    23: 3.696, 24: 2.975, 25: 2.278, 26: 1.619, 27: 1.0,
};
Object.entries(REF_TEXT_SCALE).forEach(([frame, want]) => {
    const got = stAt((Number(frame) - 12) / 30).scale;
    assert.ok(Math.abs(got - want) < 0.02,
        `scale chữ ở khung ${frame} = ${got.toFixed(3)}, video đo ${want}`);
});

// ---- 5) Đường thời gian lớp ĐĨA (nảy MỘT LẦN) -----------------------------
/* CỐ Ý KHÁC VIDEO MẪU: CapCut cho đĩa lặp chu kỳ 0.80s (nảy, giữ tới 0.617s rồi
   TẮT HẲN, hiện lại ở chu kỳ sau). Bản này bỏ phần lặp — đĩa nảy đúng một lần rồi
   đứng yên tới hết block, vì nhấp nháy suốt cả block gây rối khi mẫu đứng lâu trên
   khung hình. Biên độ nảy và lệch pha GIỮ NGUYÊN số đo của video. */
const discLayer = tpl.layers[1];
const dAt = (t) => TextTemplates.layerStateAt(discLayer, t);
assert.ok(!discLayer.anim.period, 'đĩa KHÔNG được lặp (bỏ period)');
assert.ok(!discLayer.anim.window, 'đĩa KHÔNG được tắt giữa chừng (bỏ window)');
assert.ok(Math.abs(discLayer.anim.delay - 0.567) < 1e-9, 'lệch pha 0.567s (đĩa hiện lần đầu ở khung 29)');
assert.ok(dAt(0.5).hidden, 'trước 0.567s: chưa có đĩa');
assert.ok(!dAt(0.6).hidden, 'sau 0.567s: đĩa vào cảnh');
// đường kính = 150 × scale; đối chiếu vài khung của video
const diamAt = (frame) => {
    const st = dAt((frame - 12) / 30);
    return st.hidden ? null : 150 * st.scale;
};
assert.ok(Math.abs(diamAt(39) - 166) < 6, `f39 đĩa vọt tới ~166 (được ${diamAt(39).toFixed(0)})`);
assert.ok(Math.abs(diamAt(45) - 150) < 2, `f45 đĩa lắng về 150 (được ${diamAt(45).toFixed(0)})`);
// Chỗ mà bản lặp cũ cho đĩa biến mất / nảy lại: nay phải đứng yên ở đúng 150.
assert.ok(Math.abs(diamAt(50) - 150) < 2, 'f48..f52 đĩa KHÔNG được tắt nữa');
assert.ok(Math.abs(diamAt(56) - 150) < 2, 'f56 đĩa KHÔNG được nảy lại');
assert.ok(Math.abs(diamAt(63) - 150) < 2, 'f63 đĩa vẫn đứng yên');
const lastFrameDiam = 150 * dAt(tpl.duration - 0.01).scale;
assert.ok(Math.abs(lastFrameDiam - 150) < 2, 'tới cuối block đĩa vẫn hiện ở đúng cỡ 150');

// ---- 6) Chữ ký khung: hợp đồng gộp khung của khâu xuất --------------------
/* Khâu xuất đẩy `null` ("lặp khung trước") khi chữ ký không đổi. Chữ ký SAI mà
   trùng nhau là bản xuất đứng hình; sai mà khác nhau thì chỉ tốn thời gian. */
const sig = (t) => TextTemplates.frameSignature(tpl, t);
assert.strictEqual(sig(1.30), sig(1.32), 'hai khung trong đoạn mẫu đứng yên phải cùng chữ ký');
assert.strictEqual(sig(2.00), sig(2.90), 'đĩa hết nảy -> phần đuôi block gộp được về một khung');
assert.notStrictEqual(sig(0.60), sig(0.70), 'đĩa đang nảy -> chữ ký phải khác nhau từng khung');
assert.notStrictEqual(sig(0.10), sig(0.20), 'chữ đang zoom -> chữ ký phải khác nhau từng khung');

// ---- 7) settleTime: mốc "đã vào cảnh xong" cho thumbnail & PNG tĩnh -------
const settle = TextTemplates.settleTime(tpl);
assert.ok(settle > 0.5 && settle < tpl.duration, `settleTime ${settle} phải nằm sau hoạt ảnh vào và trong block`);
assert.ok(Math.abs(TextTemplates.layerStateAt(textLayer, settle).scale - 1) < 1e-6,
    'ở settleTime chữ đã về 1× (ảnh tĩnh dự phòng không được là khung chữ khổng lồ)');

/* ---- 8) NGƯỜI DÙNG CHỈNH THÔNG SỐ CỦA MẪU --------------------------------
 * Hợp đồng: bảng override chỉ chứa phần ĐÃ ĐỔI, trộn lên thiết kế gốc bằng
 * resolve(); template gốc KHÔNG được đổi (nó là dữ liệu tham chiếu dùng chung cho
 * mọi block, sửa nhầm là mọi mẫu "Approved" trong dự án đổi theo).
 */
const editable = TextTemplates.editableLayers(tpl);
assert.deepStrictEqual(editable.map((l) => `${l.kind}:${l.key}`), ['text:title', 'glyph:check'],
    'mẫu phải khai đúng các lớp sửa được (khoá ổn định để lưu vào dự án)');
const seed = editable[0].style;
assert.strictEqual(seed.font_family, 'Source Sans 3', 'style gốc lấy từ THIẾT KẾ của mẫu, không phải mặc định của textbox mới');
assert.strictEqual(seed.font_size, 147.4);
assert.strictEqual(seed.text_case, 'uppercase');
assert.ok(Math.abs(seed.letter_spacing - (1.36 / 147.4) * 100) < 1e-9,
    'letter-spacing quy về % của cỡ chữ (cùng đơn vị với ô nhập của text thường)');
assert.deepStrictEqual(editable[1].colorKeys.map((c) => c.key), ['disc', 'mark'],
    'panel dựng ô màu từ danh sách của engine, không tự đặt tên khoá');
assert.strictEqual(editable[1].colors.disc, '#84cd00');

// Bảng rỗng / thiếu = đúng thiết kế gốc (dự án cũ mở lên không đổi hình).
assert.strictEqual(TextTemplates.resolve(tpl, null), tpl, 'không có override -> dùng thẳng bản gốc');
const layPlain = TextTemplates.layout(fakeCtx(), TextTemplates.resolve(tpl, {}), ['APPROVED'], 1, FRAME);
assert.ok(Math.abs(layPlain.width - lay.width) < 1e-9, 'override rỗng không được làm đổi hộp tĩnh');

// Đổi màu hình trang trí + màu/cỡ chữ.
const custom = TextTemplates.resolve(tpl, {
    check: { disc: '#ff0000' },
    title: { color: '#000000', font_size: 73.7 },
});
assert.strictEqual(custom.layers[1].colors.disc, '#ff0000', 'màu đĩa đổi theo override');
assert.strictEqual(custom.layers[1].colors.mark, '#ffffff', 'mảng màu KHÔNG đổi thì giữ nguyên thiết kế');
assert.strictEqual(custom.layers[0].color, '#000000');
assert.strictEqual(custom.layers[0].font.size, 73.7);
assert.ok(Math.abs(custom.layers[0].font.letter - 0.68) < 0.01,
    'letter-spacing là % nên phải co theo cỡ chữ mới (1.36 ở 147.4 -> 0.68 ở 73.7)');
assert.strictEqual(tpl.layers[1].colors.disc, '#84cd00', 'resolve KHÔNG được sửa template gốc');
assert.strictEqual(tpl.layers[0].font.size, 147.4, 'resolve KHÔNG được sửa template gốc');
// Chữ nhỏ đi một nửa -> hộp chữ hẹp lại, nhóm co theo (đĩa vẫn 150 + khe 55).
const layHalf = TextTemplates.layout(fakeCtx(), custom, ['APPROVED'], 1, FRAME);
assert.ok(Math.abs(layHalf.width - (150 + 55 + 355)) < 2,
    `cỡ chữ nửa -> nhóm rộng ~560 (được ${layHalf.width.toFixed(1)})`);

// Đổi font -> danh sách font cần nạp phải đi theo bản ĐÃ TRỘN, không phải bản gốc.
const otherFont = TextTemplates.resolve(tpl, { title: { font_family: 'Roboto', font_weight: 900 } });
assert.deepStrictEqual(TextTemplates.fonts(otherFont).map((f) => `${f.family} ${f.weight}`), ['Roboto 900']);

/* NỀN BO GÓC nằm TRONG hộp lớp: bật nền là hộp NỞ RA đúng phần đệm. Nhờ vậy dấu tích
   (neo vào mép trái hộp chữ) lùi ra và khe 55px được đo tới MÉP NỀN — thứ mắt nhìn
   thấy — thay vì để nền chữ trườn lên đè mất đĩa. */
const withBg = TextTemplates.resolve(tpl, { title: { bg_enabled: true, bg_color: '#000000', bg_opacity: 50 } });
const layBg = TextTemplates.layout(fakeCtx(), withBg, ['APPROVED'], 1, FRAME);
const padX = 147.4 * 0.28;
assert.ok(Math.abs((layBg.boxes[0].w - lay.boxes[0].w) - 2 * padX) < 0.01,
    'hộp lớp chữ phải nở đúng 2× phần đệm ngang khi bật nền');
assert.ok(Math.abs((layBg.boxes[1].x + layBg.boxes[1].w) - (layBg.boxes[0].x - 55)) < 0.01,
    'khe 55px đo tới MÉP NỀN, nên đĩa lùi ra thay vì bị nền đè lên');
assert.ok(Math.abs(layBg.width - (lay.width + 2 * padX)) < 0.01, 'cả nhóm rộng thêm đúng phần đệm nền');
assert.strictEqual(withBg.layers[0].bg.color, 'rgba(0, 0, 0, 0.5)', 'độ mờ nền quy thành rgba cho canvas');

/* Viền & bóng vẽ RA NGOÀI mực: không được tính vào hộp (hộp đứng yên thì mọi khoảng
   cách của mẫu đứng yên) nhưng phải nới LỀ canvas, nếu không nét bị cắt ở mép. */
const withStroke = TextTemplates.resolve(tpl, { title: { stroke_enabled: true, stroke_width: 20 } });
const layStroke = TextTemplates.layout(fakeCtx(), withStroke, ['APPROVED'], 1, FRAME);
assert.ok(Math.abs(layStroke.width - lay.width) < 0.01, 'bật viền KHÔNG được làm đổi hộp tĩnh');
assert.ok(layStroke.marginY > lay.marginY, 'bật viền phải nới lề canvas');
/* Trục ngang KHÔNG nới thêm được vì lề ngang của mẫu này đã CHẠM TRẦN theo khung hình
   (chữ zoom 10.86× vốn đã tràn ra ngoài khung từ lâu) — đúng hợp đồng ở mục 3. */
assert.ok(Math.abs(layStroke.marginX - capX) < 0.5, 'lề ngang vẫn bị kẹp theo khung hình');

/* ==========================================================================
 * MẪU "CORRECT 1" — dấu tích có bóng đổ dài + chữ rơi TỪNG KÝ TỰ
 *
 * SỐ THAM CHIẾU (video Text Template-Correct 1.mp4, 1080×1920, 30fps,
 * block = khung 13..102):
 *   chữ  x 290..991 (mực rộng 702), baseline 1026, dải chữ hoa 128
 *   đĩa  d 202, tâm (156.5, 958.5)  -> khe đĩa↔chữ 32.5 ; tâm đĩa cao hơn 3.5
 *   chữ cái thứ i vào cảnh ở khung 16+2i (C f16 … t f28), rơi xong sau 11 khung
 *   đĩa nảy ở khung 18, cùng đường nảy với "Approved"
 * ======================================================================= */
const tplC = TextTemplates.byId('correct-1');
assert.ok(tplC, 'phải có mẫu "correct-1"');
assert.strictEqual(tplC.duration, 3.0, 'thời lượng 3.00s (90 khung @30fps đo trên video)');
assert.deepStrictEqual(TextTemplates.defaultTexts(tplC), ['Correct']);

/* Thước đo riêng cho "Correct" ở Montserrat 800/183: bảng advance + hộp mực lấy
   từ CHÍNH trình duyệt (canvas measureText) rồi đóng băng ở đây, nên phép xếp chỗ
   trong test là phép xếp chỗ thật, chỉ có phép đo chữ là tất định. */
function fakeCtxCorrect() {
    const ADV = [131.96, 117.14, 79.44, 79.07, 114.57, 108.72, 81.82];  // advance từng chữ
    const INK = [128, 114, 68, 68, 109, 105, 80];                        // bề rộng mực từng chữ
    let font = '';
    const rel = () => (Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]) || 183) / 183;
    return {
        set font(v) { font = v; }, get font() { return font; },
        letterSpacing: '0px', save() {}, restore() {},
        measureText(text) {
            const s = String(text);
            const k = rel();
            if (s === 'H') return { width: 120 * k, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 120 * k, actualBoundingBoxAscent: 128 * k, actualBoundingBoxDescent: 0 };
            const n = Math.min(s.length, 7);
            if (s === 'Correct') {
                // mực rộng 707.55 = Left + Right, với Left âm (chữ 'C' của Montserrat
                // bắt đầu BÊN PHẢI anchor) — giữ đúng dấu, đó chính là chỗ từng làm cả
                // khối chữ lệch 2·|Left| ở mẫu "Approved".
                return { width: 712.72 * k, actualBoundingBoxLeft: -5 * k, actualBoundingBoxRight: 712.55 * k, actualBoundingBoxAscent: 131 * k, actualBoundingBoxDescent: 3 * k };
            }
            if (s.length === 1) {
                const i = 'Correct'.indexOf(s);
                const w = (i >= 0 ? INK[i] : 100) * k;
                return { width: (i >= 0 ? ADV[i] : 110) * k, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w, actualBoundingBoxAscent: 131 * k, actualBoundingBoxDescent: 3 * k };
            }
            const adv = ADV.slice(0, n).reduce((a, b) => a + b, 0) * k;
            return { width: adv, actualBoundingBoxLeft: -5 * k, actualBoundingBoxRight: adv * 0.99, actualBoundingBoxAscent: 131 * k, actualBoundingBoxDescent: 3 * k };
        },
    };
}

// ---- C1) Hình học hộp tĩnh ------------------------------------------------
const layC = TextTemplates.layout(fakeCtxCorrect(), tplC, ['Correct'], 1, FRAME);
const cText = layC.boxes[0];
const cDisc = layC.boxes[1];
assert.ok(Math.abs(cDisc.w - 202) < 0.01 && Math.abs(cDisc.h - 202) < 0.01, 'đĩa 202×202');
assert.ok(Math.abs(cText.h - 128) < 0.01, 'hộp chữ cao đúng dải chữ hoa 128');
assert.ok(Math.abs(cText.x - (cDisc.x + cDisc.w) - 32.5) < 0.01,
    'mép phải đĩa cách mép trái mực chữ đúng 32.5px');
assert.ok(Math.abs((cDisc.y + cDisc.h / 2) - (cText.y + cText.h / 2) + 3.5) < 0.01,
    'tâm đĩa cao hơn tâm dải chữ hoa đúng 3.5px');
assert.ok(Math.abs(layC.height - 202) < 0.01, 'chiều cao nhóm = đường kính đĩa');
assert.ok(Math.abs(layC.width - (202 + 32.5 + 707.55)) < 1,
    `bề rộng nhóm ${layC.width.toFixed(1)} = đĩa + khe + mực chữ`);

// ---- C2) Chữ rơi TỪNG KÝ TỰ ------------------------------------------------
const textC = tplC.layers[0];
assert.ok(textC.anim.perChar, 'lớp chữ phải chạy hoạt ảnh theo từng ký tự');
assert.ok(Math.abs(textC.anim.perChar.stagger - 1 / 15) < 1e-9, 'lệch pha 2 khung = 1/15s');
const chAt = (i, frame) => TextTemplates.charStateAt(textC, (frame - 13) / 30, i);
// chữ cái thứ i vào cảnh đúng khung 16+2i (C f16, o f18, r f20, r f22, e f24, c f26, t f28)
for (let i = 0; i < 7; i += 1) {
    assert.ok(chAt(i, 15 + 2 * i).hidden, `chữ ${i} chưa được hiện ở khung ${15 + 2 * i}`);
    assert.ok(!chAt(i, 16 + 2 * i).hidden, `chữ ${i} phải vào cảnh ở khung ${16 + 2 * i}`);
}
/* Quỹ đạo rơi: bắt đầu cao hơn ~77px, vọt quá ~4.5px rồi lắng. Dãy đối chiếu là
   TRUNG BÌNH đo được của 5 chữ o/r/r/e/c trên video (5 quỹ đạo trùng nhau ±2px). */
const REF_DROP = { 0: -76, 1: -77.7, 2: -73.7, 3: -63.1, 4: -47.0, 5: -28.9, 6: -13.1, 7: -2.1, 8: 3.6, 9: 4.5, 10: 1.5, 11: 0 };
Object.entries(REF_DROP).forEach(([j, want]) => {
    const got = chAt(1, 18 + Number(j)).dy;   // chữ 'o': vào cảnh ở khung 18
    assert.ok(Math.abs(got - want) < 0.5, `dy của 'o' ở khung ${18 + Number(j)} = ${got}, video đo ${want}`);
});
assert.strictEqual(chAt(0, 16).opacity, 0, 'ký tự hiện dần: khung đầu còn trong suốt');
assert.ok(Math.abs(chAt(0, 17).opacity - 1) < 1e-6, 'sau 1 khung là đặc hoàn toàn');
// Cả khối đứng yên khi ký tự CUỐI đã lắng (khung 39 = 13 + 26)
assert.ok(Math.abs(chAt(6, 39).dy) < 1e-9 && Math.abs(chAt(6, 45).dy) < 1e-9, 'chữ cuối lắng ở khung 39');
const settleC = TextTemplates.settleTime(tplC, ['Correct']);
assert.ok(Math.abs(settleC - 26 / 30) < 0.02,
    `settleTime ${settleC.toFixed(3)} phải là lúc ký tự CUỐI xong (0.867s), không phải ký tự đầu`);

/* Ở mức LỚP, tracks không được áp lần nữa — nếu áp thì cả khối trôi theo trong khi
   từng chữ cũng trôi (hiệu ứng nhân đôi, chữ rơi từ ngoài khung vào). */
const layerC0 = TextTemplates.layerStateAt(textC, 0.05);
assert.ok(layerC0.hidden, 'trước delay: cả lớp chưa vào cảnh');
const layerC1 = TextTemplates.layerStateAt(textC, 0.30);
assert.ok(!layerC1.hidden && layerC1.dy === 0 && layerC1.opacity === 1,
    'sau delay: trạng thái mức lớp phải là ĐỨNG YÊN (tracks thuộc về ký tự)');

/* Chữ ký khung phải kể tới từng ký tự: giữa lúc chữ thứ 5 đang rơi mà chữ ký không
   đổi thì khâu xuất đẩy `null` (lặp khung trước) -> bản xuất đứng hình. */
const sigC = (frame) => TextTemplates.frameSignature(tplC, (frame - 13) / 30, ['Correct']);
assert.notStrictEqual(sigC(30), sigC(31), 'đang có chữ rơi -> chữ ký phải khác nhau từng khung');
assert.strictEqual(sigC(60), sigC(70), 'mọi thứ đã lắng -> chữ ký trùng nhau (gộp được khung)');
// Số ký tự đổi theo NỘI DUNG người dùng gõ, chữ ký phải đi theo
assert.notStrictEqual(TextTemplates.frameSignature(tplC, 0.3, ['Correct']),
    TextTemplates.frameSignature(tplC, 0.3, ['Co']), 'chữ ký phải phụ thuộc số ký tự thật');

// ---- C3) Đĩa: cùng đường nảy, cũng chỉ nảy MỘT lần ------------------------
const discC = tplC.layers[1];
assert.ok(!discC.anim.period && !discC.anim.window, 'đĩa nảy một lần rồi đứng yên (như mẫu 1)');
const dC = (frame) => TextTemplates.layerStateAt(discC, (frame - 13) / 30);
assert.ok(dC(17).hidden, 'trước khung 18 chưa có đĩa');
assert.ok(!dC(18).hidden, 'đĩa vào cảnh ở khung 18');
const diamC = (frame) => 202 * dC(frame).scale;
/* Đối chiếu đường kính với video ở đúng các khung ĐO ĐƯỢC (video chạy sticker 15fps
   nên giá trị đi thành bậc; ta lấy một điểm mỗi bậc rồi nội suy — cùng biên độ, cùng
   thời điểm, nhưng mượt ở 30/60fps, y như đã làm với "Approved"). */
[[22, 151], [24, 190], [28, 222]].forEach(([f, want]) => {
    assert.ok(Math.abs(diamC(f) - want) < 5, `khung ${f} đĩa d≈${want} (được ${diamC(f).toFixed(0)})`);
});
assert.ok(Math.abs(diamC(31) - 202) < 2, `khung 31 đĩa lắng về 202 (được ${diamC(31).toFixed(0)})`);
assert.ok(Math.abs(diamC(102) - 202) < 2, 'tới khung cuối block đĩa vẫn đứng ở 202');

// ---- C4) Hình trang trí có ô màu BÓNG cho người dùng chỉnh ----------------
const editC = TextTemplates.editableLayers(tplC);
assert.deepStrictEqual(editC.map((l) => `${l.kind}:${l.key}`), ['text:title', 'glyph:check']);
assert.deepStrictEqual(editC[1].colorKeys.map((c) => c.key), ['disc', 'mark', 'shadow'],
    'đĩa có bóng đổ -> phải bày ra 3 ô màu, kể cả màu bóng');
assert.strictEqual(editC[0].style.font_family, 'Montserrat');
assert.strictEqual(editC[0].style.font_weight, 800);
assert.strictEqual(editC[0].style.font_size, 183);
// Override vẫn chạy y như mẫu 1 — kể cả trên lớp có hiệu ứng theo ký tự.
const customC = TextTemplates.resolve(tplC, { check: { shadow: '#003300' }, title: { font_size: 91.5 } });
assert.strictEqual(customC.layers[1].colors.shadow, '#003300');
assert.strictEqual(customC.layers[1].colors.disc, '#84cd00', 'mảng màu không đổi thì giữ thiết kế');
assert.ok(customC.layers[0].anim.perChar, 'trộn override KHÔNG được làm mất hoạt ảnh theo ký tự');
const layHalfC = TextTemplates.layout(fakeCtxCorrect(), customC, ['Correct'], 1, FRAME);
assert.ok(Math.abs(layHalfC.boxes[0].w - 707.55 / 2) < 1, 'cỡ chữ nửa -> hộp chữ hẹp một nửa');

/* ==========================================================================
 * BỘ "INCORRECT" / "INCORRECT 2" — chữ TRƯỢT VÀO SAU MÉP CẮT + hình tự vẽ
 *
 * SỐ THAM CHIẾU (cả hai video 1080×1920 30fps, block = khung 13..102):
 *   Incorrect   chữ x 352..931 (mực 580×96, baseline 999, dải hoa 94)
 *               vành d 171 tâm (230.5,947.5) -> khe 36, tâm cao hơn 4
 *               vành hiện f18, dấu X tự vẽ f46..f66, chữ trượt f37..f58, cắt ở x=308
 *   Incorrect 2 chữ x 308..943 (mực 636×76, baseline 991, dải hoa 76)
 *               đĩa d 161 tâm (195.5,949.5) -> khe 32, tâm cao hơn 2.5
 *               đĩa hiện f14, chữ trượt f18..f32, cắt ở x=272
 * ======================================================================= */

/* Thước đo Raleway 500, số liệu lấy từ canvas trình duyệt rồi đóng băng.
   Chỉ cần hộp mực của CẢ chuỗi + dải chữ hoa: hai mẫu này không chạy hoạt ảnh
   theo ký tự nên engine không hỏi tới advance từng chữ. */
function fakeCtxRaleway(spec) {
    let font = '';
    const rel = () => (Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]) || spec.size) / spec.size;
    return {
        set font(v) { font = v; }, get font() { return font; },
        letterSpacing: '0px', save() {}, restore() {},
        measureText(text) {
            const k = rel();
            const s = String(text);
            if (s === 'H') return { width: spec.cap * 0.8 * k, actualBoundingBoxLeft: 0, actualBoundingBoxRight: spec.cap * 0.8 * k, actualBoundingBoxAscent: spec.cap * k, actualBoundingBoxDescent: 0 };
            const n = Math.max(1, s.length) / spec.text.length;
            return {
                width: spec.adv * n * k,
                actualBoundingBoxLeft: spec.L * k,
                actualBoundingBoxRight: (spec.R * n) * k,
                actualBoundingBoxAscent: spec.A * k,
                actualBoundingBoxDescent: spec.D * k,
            };
        },
    };
}
const RUL_I1 = { text: 'Incorrect', size: 134, L: -11, R: 595.24, A: 95, D: 2, cap: 95, adv: 600.46 };
const RUL_I2 = { text: 'INCORRECT', size: 109.5, L: -9, R: 650.17, A: 79, D: 1, cap: 78, adv: 655.45 };

// ---- N1) Hình học của hai mẫu ---------------------------------------------
[['incorrect', RUL_I1, 171, 36, -4, 'Incorrect'],
    ['incorrect-2', RUL_I2, 161, 32, -2.5, 'INCORRECT']].forEach(([id, rul, iconD, gap, dyC, txt]) => {
    const t = TextTemplates.byId(id);
    assert.ok(t, `phải có mẫu "${id}"`);
    assert.strictEqual(t.duration, 3.0, `${id}: 3.00s (90 khung @30fps)`);
    assert.deepStrictEqual(TextTemplates.defaultTexts(t), [txt]);
    /* Hình trang trí khai TRƯỚC lớp chữ: chữ phải vẽ ĐÈ lên nó (mép cắt nằm bên trong
       biểu tượng vài px, video cho thấy nét chữ phủ lên chỗ đó). */
    assert.strictEqual(t.layers[0].kind, 'glyph', `${id}: hình trang trí phải khai trước để chữ vẽ đè lên`);
    assert.strictEqual(t.layers[1].kind, 'text');
    const lay = TextTemplates.layout(fakeCtxRaleway(rul), t, [txt], 1, FRAME);
    const gb = lay.boxes[0];
    const tb = lay.boxes[1];
    assert.ok(Math.abs(gb.w - iconD) < 0.01 && Math.abs(gb.h - iconD) < 0.01, `${id}: biểu tượng ${iconD}×${iconD}`);
    assert.ok(Math.abs(tb.h - rul.cap) < 0.01, `${id}: hộp chữ cao đúng dải chữ hoa ${rul.cap}`);
    assert.ok(Math.abs(tb.x - (gb.x + gb.w) - gap) < 0.01, `${id}: khe biểu tượng↔chữ ${gap}px`);
    assert.ok(Math.abs((gb.y + gb.h / 2) - (tb.y + tb.h / 2) - dyC) < 0.01, `${id}: tâm biểu tượng lệch ${dyC}px so với tâm dải chữ hoa`);
    assert.ok(Math.abs(lay.height - iconD) < 0.01, `${id}: chiều cao nhóm = đường kính biểu tượng`);
});

/* ---- N2) MÉP CẮT: hợp đồng quan trọng nhất của hai mẫu này ----------------
 * Chữ trượt vào từ −595px (Incorrect) / −647px (Incorrect 2). Nếu phép tính lề
 * KHÔNG biết tới mép cắt, nó sẽ đòi lề bằng cả nửa khung hình -> canvas phình lên
 * gấp mấy lần và khâu xuất bake 90 khung PNG cỡ đó. Lề thực tế chỉ cần đủ cho biên
 * độ nảy của biểu tượng.
 */
const layI1 = TextTemplates.layout(fakeCtxRaleway(RUL_I1), TextTemplates.byId('incorrect'), ['Incorrect'], 1, FRAME);
const layI2 = TextTemplates.layout(fakeCtxRaleway(RUL_I2), TextTemplates.byId('incorrect-2'), ['INCORRECT'], 1, FRAME);
assert.ok(TextTemplates.byId('incorrect').layers[1].clip, 'lớp chữ "Incorrect" phải có mép cắt');
assert.ok(TextTemplates.byId('incorrect-2').layers[1].clip, 'lớp chữ "Incorrect 2" phải có mép cắt');
assert.ok(layI1.marginX < 60, `lề ngang ${layI1.marginX} phải nhỏ — mép cắt nuốt phần chữ chưa tới nơi`);
assert.ok(layI2.marginX < 60, `lề ngang ${layI2.marginX} phải nhỏ`);
// nhưng vẫn đủ cho biên độ nảy của biểu tượng (vành vọt 1.202×)
assert.ok(layI1.marginY >= Math.ceil(171 * (1.202 - 1) / 2), 'lề dọc phải đủ cho lúc vành vọt to nhất');

/* Mép cắt phải nằm ĐÚNG chỗ đo được trên video: 308 (Incorrect) và 272 (Incorrect 2),
   tính từ mép trái mực chữ. Sai chỗ này là chữ thò ra bên trái biểu tượng. */
const clipAbsI1 = layI1.boxes[1].x + TextTemplates.byId('incorrect').layers[1].clip.x0;
const clipAbsI2 = layI2.boxes[1].x + TextTemplates.byId('incorrect-2').layers[1].clip.x0;
assert.ok(Math.abs(clipAbsI1 - (layI1.boxes[0].x + 171 - 8)) < 1.5,
    'Incorrect: mép cắt nằm ~7px bên trong mép phải vành');
assert.ok(Math.abs(clipAbsI2 - (layI2.boxes[0].x + 161 - 4)) < 1.5,
    'Incorrect 2: mép cắt nằm ~4px bên trong mép phải đĩa');

// ---- N3) Đường thời gian --------------------------------------------------
const inc = TextTemplates.byId('incorrect');
const at = (layer, frame) => TextTemplates.layerStateAt(layer, (frame - 13) / 30);
assert.ok(at(inc.layers[0], 17).hidden, 'Incorrect: trước khung 18 chưa có vành');
assert.ok(!at(inc.layers[0], 18).hidden, 'Incorrect: vành hiện ở khung 18');
const ringD = (f) => 171 * at(inc.layers[0], f).scale;
[[24, 178], [31, 205], [38, 138], [45, 171]].forEach(([f, want]) => {
    assert.ok(Math.abs(ringD(f) - want) < 6, `Incorrect: vành ở khung ${f} d≈${want} (được ${ringD(f).toFixed(0)})`);
});
assert.ok(Math.abs(ringD(102) - 171) < 1, 'Incorrect: tới cuối block vành đứng yên ở 171 (đã bỏ nhịp phồng cuối)');
// dấu X tự vẽ
assert.strictEqual(at(inc.layers[0], 45).reveal, 0, 'Incorrect: khung 45 chưa vẽ dấu X');
assert.ok(at(inc.layers[0], 56).reveal > 0.2 && at(inc.layers[0], 56).reveal < 0.6, 'Incorrect: khung 56 dấu X đang vẽ dở');
assert.ok(at(inc.layers[0], 66).reveal >= 0.999, 'Incorrect: khung 66 dấu X xong');
assert.ok(at(inc.layers[0], 102).reveal >= 0.999, 'Incorrect: vẽ xong thì giữ nguyên tới cuối');
// chữ trượt vào
assert.ok(at(inc.layers[1], 36).hidden, 'Incorrect: trước khung 37 chưa có chữ');
assert.ok(Math.abs(at(inc.layers[1], 37).dx + 595) < 0.5, 'Incorrect: chữ bắt đầu lệch trái 595px');
assert.ok(Math.abs(at(inc.layers[1], 47).dx + 181) < 0.5, 'Incorrect: khung 47 còn lệch 181px');
assert.ok(Math.abs(at(inc.layers[1], 58).dx) < 1e-9, 'Incorrect: khung 58 chữ về đúng chỗ');

const inc2 = TextTemplates.byId('incorrect-2');
const at2 = (layer, frame) => TextTemplates.layerStateAt(layer, (frame - 13) / 30);
assert.ok(at2(inc2.layers[0], 13).hidden, 'Incorrect 2: khung 13 chưa có đĩa');
assert.ok(!at2(inc2.layers[0], 14).hidden, 'Incorrect 2: đĩa hiện ở khung 14');
const discD = (f) => 161 * at2(inc2.layers[0], f).scale;
[[16, 108], [22, 176], [28, 161]].forEach(([f, want]) => {
    assert.ok(Math.abs(discD(f) - want) < 4, `Incorrect 2: đĩa ở khung ${f} d≈${want} (được ${discD(f).toFixed(0)})`);
});
assert.ok(Math.abs(discD(102) - 161) < 1, 'Incorrect 2: tới cuối block đĩa đứng yên (đã bỏ nhịp phồng lặp 0.53s)');
assert.ok(at2(inc2.layers[1], 17).hidden, 'Incorrect 2: trước khung 18 chưa có chữ');
assert.ok(Math.abs(at2(inc2.layers[1], 18).dx + 647) < 0.5, 'Incorrect 2: chữ bắt đầu lệch trái 647px');
assert.ok(Math.abs(at2(inc2.layers[1], 32).dx) < 1e-9, 'Incorrect 2: khung 32 chữ về đúng chỗ');

/* Chữ ký khung phải kể tới `reveal`: lúc dấu X đang tự vẽ, mọi thứ khác đứng yên —
   bỏ sót là khâu xuất gộp khung và bản xuất mất luôn đoạn vẽ dấu X. */
const sigI = (f) => TextTemplates.frameSignature(inc, (f - 13) / 30, ['Incorrect']);
assert.notStrictEqual(sigI(56), sigI(57), 'dấu X đang vẽ -> chữ ký phải khác nhau từng khung');
assert.strictEqual(sigI(70), sigI(95), 'mọi thứ đã xong -> chữ ký trùng (gộp được khung)');

// ---- N4) Ô màu của hai biểu tượng mới -------------------------------------
assert.deepStrictEqual(TextTemplates.editableLayers(inc)[0].colorKeys.map((c) => c.key), ['ring', 'mark']);
assert.deepStrictEqual(TextTemplates.editableLayers(inc2)[0].colorKeys.map((c) => c.key), ['disc', 'mark']);
// Chữ của "Incorrect 2" có viền đỏ -> style gốc bày ra panel phải bật sẵn viền.
const styleI2 = TextTemplates.editableLayers(inc2)[1].style;
assert.strictEqual(styleI2.stroke_enabled, true, 'Incorrect 2: style gốc phải bật viền');
assert.strictEqual(styleI2.stroke_color, '#ff0000');
assert.strictEqual(styleI2.text_case, 'uppercase');
// Override vẫn giữ nguyên mép cắt và hoạt ảnh của lớp.
const ovI1 = TextTemplates.resolve(inc, { icon: { ring: '#00ff00' }, title: { color: '#000000' } });
assert.strictEqual(ovI1.layers[0].colors.ring, '#00ff00');
assert.strictEqual(ovI1.layers[0].colors.mark, '#ff0000', 'mảng màu không đổi thì giữ thiết kế');
assert.deepStrictEqual(ovI1.layers[1].clip, { x0: -44 }, 'trộn override KHÔNG được làm mất mép cắt');
assert.ok(ovI1.layers[1].anim.tracks.dx, 'trộn override KHÔNG được làm mất hoạt ảnh trượt');

/* ==========================================================================
 * MẪU "QUOTE" — hai dòng chữ trên NỀN TRẮNG trượt vào sau mép cắt + cặp dấu
 * nháy vàng trượt lên.
 *
 * SỐ THAM CHIẾU (video Text Template-Quote.mp4, 1080×1920 30fps, block = khung 12..101):
 *   dòng 1  hộp nền x 290..999 (710×86), mực x 326..961 (636), baseline y 934
 *   dòng 2  hộp nền x 290..818 (529×86), mực 448, baseline y 1034
 *   khe hai hộp 14 (y 953..966); dải chữ hoa 59; đệm nền 37 ngang, 9 trên, 18 dưới
 *   dấu nháy 183×153 tại x 88..271 y 867..1019 -> khe 19, MÉP TRÊN trùng hộp dòng 1
 *   dấu nháy hiện từ khung 14 (alpha 0), trượt lên 145px, xong ở khung 27
 *   chữ trượt từ khung 23 (dx -668) tới khung 40, mép cắt cố định ở x=286
 * ======================================================================= */

/* Thước đo Inter 500 ở CỠ CHỮ CỦA MẪU (size 79.87, letter 3.355), số liệu lấy từ
   chính canvas của Chrome rồi đóng băng. Bảng theo TỪNG CHUỖI (không suy ra theo
   số ký tự như hai mẫu trước): mẫu này có hai ô chữ dài ngắn khác nhau và cả hai
   bề rộng đều là số đo đối chiếu với video, nên phải giữ đúng từng chuỗi. */
const INTER_Q = {
    size: 79.87,
    cap: 59,
    rows: {
        H: { adv: 62.84, L: -6, R: 54, A: 59, D: 0 },
        'All That Glitters': { adv: 643.38, L: -1, R: 637, A: 61, D: 1 },
        'Is Not Gold': { adv: 457.60, L: -6, R: 448.86, A: 59, D: 1 },
        'Đường mới': { adv: 442.00, L: -1, R: 436.37, A: 61, D: 18 },
    },
};
function fakeCtxInter() {
    let font = '';
    const rel = () => (Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]) || INTER_Q.size) / INTER_Q.size;
    return {
        set font(v) { font = v; }, get font() { return font; },
        letterSpacing: '0px', save() {}, restore() {},
        measureText(text) {
            const k = rel();
            const s = String(text);
            const row = INTER_Q.rows[s];
            if (row) {
                return {
                    width: row.adv * k,
                    actualBoundingBoxLeft: row.L * k,
                    actualBoundingBoxRight: row.R * k,
                    actualBoundingBoxAscent: row.A * k,
                    actualBoundingBoxDescent: row.D * k,
                };
            }
            // chuỗi lạ (test tự bịa): suy theo bề rộng trung bình một ký tự của dòng 1
            const per = 636 / 'All That Glitters'.length;
            const w = Math.max(1, s.length) * per * k;
            return {
                width: w, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w,
                actualBoundingBoxAscent: INTER_Q.cap * k, actualBoundingBoxDescent: 0,
            };
        },
    };
}

const tplQ = TextTemplates.byId('quote');
assert.ok(tplQ, 'phải có mẫu "quote"');
assert.strictEqual(tplQ.duration, 3.0, 'Quote: 3.00s (90 khung @30fps, block 12..101)');
assert.deepStrictEqual(TextTemplates.defaultTexts(tplQ), ['All That Glitters', 'Is Not Gold'],
    'Quote có HAI ô chữ, đúng thứ tự hai dòng của video');
assert.strictEqual(tplQ.rowGap, 14, 'khe giữa hai hộp nền = 14px (y 953..966)');

// ---- Q1) Hình học: hai hộp nền + chỗ đứng của dấu nháy ---------------------
const textsQ = TextTemplates.defaultTexts(tplQ);
const layQ = TextTemplates.layout(fakeCtxInter(), tplQ, textsQ, 1, FRAME);
const qGlyph = layQ.boxes[0];
const qL1 = layQ.boxes[1];
const qL2 = layQ.boxes[2];
assert.ok(Math.abs(qGlyph.w - 183) < 0.5 && Math.abs(qGlyph.h - 153) < 0.01,
    `dấu nháy 183×153 (được ${qGlyph.w.toFixed(1)}×${qGlyph.h.toFixed(1)})`);
assert.ok(Math.abs(qL1.w - 710) < 0.5, `hộp nền dòng 1 rộng 710 (được ${qL1.w.toFixed(1)})`);
assert.ok(Math.abs(qL1.h - 86) < 0.01 && Math.abs(qL2.h - 86) < 0.01, 'hai hộp nền cao 86');
assert.ok(Math.abs(qL2.x - qL1.x) < 0.01, 'hai hộp nền CÙNG mép trái (align left)');
assert.ok(Math.abs(qL2.y - (qL1.y + qL1.h + 14)) < 0.01, 'hộp dòng 2 cách hộp dòng 1 đúng 14px');
assert.ok(Math.abs(layQ.measured[2].baseline0 + qL2.y - (layQ.measured[1].baseline0 + qL1.y) - 100) < 0.01,
    'hai baseline cách đúng 100px (86 + khe 14)');
assert.ok(Math.abs(qL1.x - (qGlyph.x + qGlyph.w) - 19) < 0.5,
    `khe dấu nháy↔hộp nền = 19px (được ${(qL1.x - qGlyph.x - qGlyph.w).toFixed(1)})`);
assert.ok(Math.abs(qGlyph.y - qL1.y) < 0.01,
    'dấu nháy neo theo MÉP TRÊN hộp chữ (fy:0/ly:0), không phải căn giữa dọc');
assert.ok(Math.abs(layQ.width - 912) < 1, `cả nhóm rộng 912 (được ${layQ.width.toFixed(1)})`);
assert.ok(Math.abs(layQ.height - 186) < 0.5, `cả nhóm cao 186 (được ${layQ.height.toFixed(1)})`);

/* ĐỆM NỀN KHÔNG CÂN ĐỐI là số đo, không phải cho đẹp: baseline phải nằm 68px dưới
   mép trên hộp (9 đệm + 59 dải chữ hoa) trong khi hộp cao 86. Đệm cân đối thì chỉ
   đúng được một trong hai. */
const mQ1 = layQ.measured[1];
assert.ok(Math.abs(mQ1.padTop - 9) < 0.01 && Math.abs(mQ1.padBottom - 18) < 0.01,
    'đệm nền trên 9 / dưới 18 (đo trên video)');
assert.ok(Math.abs(mQ1.baseline0 - 68) < 0.01,
    `baseline nằm 68px dưới mép trên hộp nền (được ${mQ1.baseline0})`);
assert.ok(Math.abs(mQ1.capHeight - 59) < 0.01, 'dải chữ hoa 59');
// Chuỗi tiếng Việt: hộp KHÔNG đổi, dấu tràn ra ngoài và chỉ nới lề canvas.
const layQVi = TextTemplates.layout(fakeCtxInter(), tplQ, ['Đường mới', 'Is Not Gold'], 1, FRAME);
assert.ok(Math.abs(layQVi.boxes[1].h - 86) < 0.01, 'chuỗi có dấu: hộp nền vẫn cao 86');
/* Ở mẫu này phần đệm nền (9 trên / 18 dưới) ĐÃ ĐỦ nuốt cả dấu trên lẫn nét thả của
   chữ "g" (mực đo được: ascent 61 so với 59+9, descent 18 so với 18) -> không còn
   phần nào tràn ra ngoài hộp. Đó chính là lý do hộp nền của CapCut không cân đối:
   phần đệm dưới sinh ra để chứa nét thả. */
assert.strictEqual(layQVi.measured[1].overTop, 0, 'dấu trên vẫn nằm trong đệm nền');
assert.strictEqual(layQVi.measured[1].overBottom, 0, 'nét thả nằm trong đệm nền dưới');

// ---- Q2) Đường thời gian --------------------------------------------------
const atQ = (layer, frame) => TextTemplates.layerStateAt(layer, (frame - 12) / 30);
assert.ok(atQ(tplQ.layers[0], 13).hidden, 'Quote: khung 13 chưa có dấu nháy');
assert.ok(atQ(tplQ.layers[0], 14).opacity < 0.01, 'Quote: khung 14 dấu nháy còn trong suốt');
[[15, 126, 0.16], [16, 108, 0.457], [20, 42, 0.786], [23, 12, 0.934], [27, 0, 1]]
    .forEach(([f, dy, op]) => {
        const st = atQ(tplQ.layers[0], f);
        assert.ok(Math.abs(st.dy - dy) < 0.5, `Quote: khung ${f} dấu nháy lệch ${dy}px (được ${st.dy})`);
        assert.ok(Math.abs(st.opacity - op) < 0.01, `Quote: khung ${f} alpha ${op} (được ${st.opacity.toFixed(3)})`);
    });
const qEnd = atQ(tplQ.layers[0], 101);
assert.ok(Math.abs(qEnd.dy) < 1e-9 && qEnd.opacity === 1,
    'Quote: tới cuối block dấu nháy đứng yên, không có hoạt ảnh ra');
assert.ok(Math.abs(qEnd.scale - 1) < 1e-9,
    'Quote: dấu nháy KHÔNG phóng to (hộp bao cao 152 ngay từ khung 17 trên video)');

// Hai dòng trượt CÙNG một quãng — dòng ngắn hơn tự lộ ra muộn hơn.
[1, 2].forEach((i) => {
    assert.ok(atQ(tplQ.layers[i], 22).hidden, `Quote: lớp ${i} chưa vào cảnh trước khung 23`);
    [[23, -668], [26, -467], [30, -252], [35, -69], [40, 0]].forEach(([f, dx]) => {
        assert.ok(Math.abs(atQ(tplQ.layers[i], f).dx - dx) < 0.5,
            `Quote: lớp ${i} khung ${f} dx=${dx} (được ${atQ(tplQ.layers[i], f).dx})`);
    });
    assert.ok(Math.abs(atQ(tplQ.layers[i], 101).dx) < 1e-9, `Quote: lớp ${i} đứng yên tới cuối block`);
});
assert.strictEqual(tplQ.layers[1].anim.tracks.dx, tplQ.layers[2].anim.tracks.dx,
    'hai dòng phải dùng CHUNG mảng dx (video đo ra cùng một quãng tới từng pixel)');

/* Mép cắt: cả hai dòng cắt ở 4px bên trái mép hộp nền = x 286 của video, và lề
   ngang KHÔNG được phình theo quãng trượt -668px. */
[1, 2].forEach((i) => {
    assert.deepStrictEqual(tplQ.layers[i].clip, { x0: -4 }, `Quote: lớp ${i} phải có mép cắt -4`);
});
assert.ok(layQ.marginX < 60, `Quote: lề ngang ${layQ.marginX} phải nhỏ — mép cắt nuốt phần chữ chưa tới`);
assert.ok(Math.abs((qL1.x + tplQ.layers[1].clip.x0) - (qGlyph.x + qGlyph.w + 15)) < 0.5,
    'mép cắt nằm 15px bên phải dấu nháy (= x 286 khi nhóm đặt ở x 88 như video)');

// Lề dọc phải đủ cho quãng trượt LÊN 145px của dấu nháy (lúc đầu nó ở NGOÀI hộp tĩnh).
assert.ok(layQ.height + 2 * layQ.marginY >= 186 + 145,
    `canvas cao ${(layQ.height + 2 * layQ.marginY).toFixed(0)} phải chứa nổi dấu nháy lúc còn ở dưới 145px`);

// ---- Q3) Chữ ký khung & mốc đứng yên --------------------------------------
const sigQ = (f) => TextTemplates.frameSignature(tplQ, (f - 12) / 30, textsQ);
assert.notStrictEqual(sigQ(30), sigQ(31), 'Quote: đang trượt -> chữ ký khác nhau từng khung');
assert.strictEqual(sigQ(45), sigQ(101), 'Quote: đã xong -> chữ ký trùng (khâu xuất gộp được khung)');
const settleQ = TextTemplates.settleTime(tplQ, textsQ);
assert.ok(settleQ >= 28 / 30 - 1e-9 && settleQ < 1.2,
    `Quote: mốc đứng yên ${settleQ.toFixed(3)}s phải ở sau khung 40 (28/30 sau đầu block)`);

// ---- Q4) Thông số người dùng chỉnh được -----------------------------------
const editQ = TextTemplates.editableLayers(tplQ);
assert.deepStrictEqual(editQ.map((l) => l.key), ['quote', 'line1', 'line2'],
    'panel phải bày ra dấu nháy + hai lớp chữ');
assert.deepStrictEqual(editQ[0].colorKeys.map((c) => c.key), ['mark']);
assert.strictEqual(editQ[1].style.bg_enabled, true, 'Quote: style gốc phải BẬT nền');
assert.strictEqual(editQ[1].style.bg_color, '#ffffff');
assert.strictEqual(editQ[1].style.color, '#000000');
assert.strictEqual(editQ[1].style.align, 'left');

/* HỢP ĐỒNG QUAN TRỌNG NHẤT của phần đệm nền: đổi MỘT thuộc tính bất kỳ (đây là màu
   chữ) KHÔNG được làm hộp nền nhảy về tỉ lệ mặc định 0.28/0.22 cỡ chữ. applyTextStyle
   dựng lại `bg` từ style, nên phần đệm phải đi qua style (bg_pad_*). */
const ovQ = TextTemplates.resolve(tplQ, { line1: { color: '#ff0000' } });
assert.ok(Math.abs(ovQ.layers[1].bg.padX - 37) < 0.01
    && Math.abs(ovQ.layers[1].bg.padTop - 9) < 0.01
    && Math.abs(ovQ.layers[1].bg.padBottom - 18) < 0.01,
    `đổi màu chữ KHÔNG được đổi phần đệm nền (được ${JSON.stringify(ovQ.layers[1].bg)})`);
assert.strictEqual(ovQ.layers[1].color, '#ff0000');
assert.deepStrictEqual(ovQ.layers[1].clip, { x0: -4 }, 'trộn override KHÔNG được làm mất mép cắt');
assert.strictEqual(ovQ.layers[1].anim.tracks.dx, tplQ.layers[1].anim.tracks.dx,
    'trộn override KHÔNG được làm mất hoạt ảnh trượt');
const layOvQ = TextTemplates.layout(fakeCtxInter(), ovQ, textsQ, 1, FRAME);
assert.ok(Math.abs(layOvQ.boxes[1].w - qL1.w) < 0.01 && Math.abs(layOvQ.boxes[1].h - qL1.h) < 0.01,
    'đổi màu chữ -> hộp nền giữ nguyên 710×86');
// Đổi CỠ CHỮ thì phần đệm nở theo tỉ lệ thiết kế (đệm viết theo % cỡ chữ).
const ovQBig = TextTemplates.resolve(tplQ, { line1: { font_size: INTER_Q.size * 2 } });
assert.ok(Math.abs(ovQBig.layers[1].bg.padTop - 18) < 0.02
    && Math.abs(ovQBig.layers[1].bg.padX - 74) < 0.02,
    'cỡ chữ gấp đôi -> phần đệm nền gấp đôi, giữ đúng tỉ lệ thiết kế');
// Tắt nền: hộp co lại đúng phần đệm, mẫu vẫn chạy.
const ovQNoBg = TextTemplates.resolve(tplQ, { line1: { bg_enabled: false } });
const layNoBg = TextTemplates.layout(fakeCtxInter(), ovQNoBg, textsQ, 1, FRAME);
assert.ok(Math.abs(layNoBg.boxes[1].w - (qL1.w - 74)) < 0.01, 'tắt nền -> hộp hẹp lại đúng 2×37');
assert.ok(Math.abs(layNoBg.boxes[1].h - 59) < 0.01, 'tắt nền -> hộp cao đúng dải chữ hoa');

/* Mẫu CŨ (khai `padY` cân đối) vẫn phải đo y như trước khi có padTop/padBottom —
   dự án cũ mở lên không được đổi hình. Kiểm bằng một lớp dựng tại chỗ. */
const symTpl = {
    id: 'test-sym', name: 'sym', duration: 1, rowGap: 0,
    slots: [{ id: 'title', default: 'Is Not Gold' }],
    layers: [{
        kind: 'text', slot: 'title', place: 'flow', align: 'left', color: '#fff',
        font: { family: 'Inter', weight: 500, size: INTER_Q.size, letter: 0, lineStep: 1.25 },
        bg: { color: '#000', radius: 0, padX: 10, padY: 20 },
    }],
};
const laySym = TextTemplates.layout(fakeCtxInter(), symTpl, ['Is Not Gold'], 1, FRAME);
assert.ok(Math.abs(laySym.boxes[0].h - (59 + 40)) < 0.01, 'padY cân đối: hộp = dải chữ hoa + 2×padY');
assert.ok(Math.abs(laySym.measured[0].baseline0 - (20 + 59)) < 0.01, 'padY cân đối: baseline = padY + dải chữ hoa');

/* =======================================================================
 * MẪU "FOLGEN SIE" — chữ NGHIÊNG hiện từng ký tự (phóng vào có nảy dội) + ba nét
 * nhấn phóng vào rồi ĐẬP ra-vào không dứt.
 *
 * SỐ THAM CHIẾU (video 1080×1920, 30fps, block = khung 13..102):
 *   chữ    mực x 163..916 (754), dải chữ hoa y 873..1026 (153.5), baseline 1026
 *   nét    hộp (hợp hai trạng thái nhịp đập) x 813..981, y 678..797 = 168×119
 *          mép phải nét − mép phải chữ = 65 · mép trên chữ − mép dưới nét = 76
 *   ký tự  lệch pha 1/16 s; F16 o18 l20 g22 e23.5 n25.4 [dấu cách] S29.1 i31 e32.9
 *   nét    hiện khung 24, nhịp đập đổi trạng thái mỗi 6 khung (chu kỳ 0.4s)
 * ==================================================================== */
const tplF = TextTemplates.byId('folgen-sie');
assert.ok(tplF, 'phải có mẫu "folgen-sie"');
assert.strictEqual(tplF.duration, 3.0, 'thời lượng 3.00s (90 khung @30fps đo trên video)');
assert.deepStrictEqual(TextTemplates.defaultTexts(tplF), ['Folgen Sie']);

/* Thước đo Roboto Condensed 700 ITALIC ở size 215.3 / letter −12.99, bảng lấy từ
   chính canvas của Chrome rồi đóng băng. Có đủ advance TỪNG KÝ TỰ và advance của
   TIỀN TỐ vì mẫu chạy hiệu ứng theo ký tự — engine hỏi cả hai. */
const RC_TEXT = 'Folgen Sie';
const RC_PREFIX = [0, 86.4601, 175.1279, 214.7014, 306.8383, 393.824, 483.5431, 519.7525, 619.4586, 659.0321, 746.0178];
const RC_CHAR = [
    { w: 86.4601, L: 0, R: 110, A: 153, D: 0 },
    { w: 90.8754, L: -4, R: 98, A: 117, D: 3 },
    { w: 39.5735, L: 0, R: 58, A: 161, D: 0 },
    { w: 92.137, L: 2, R: 104, A: 117, D: 46 },
    { w: 86.9857, L: -4, R: 95, A: 117, D: 3 },
    { w: 89.719, L: 2, R: 95, A: 117, D: 0 },
    { w: 36.2094, L: 0, R: 0, A: 0, D: 0 },
    { w: 99.7061, L: -3, R: 114, A: 156, D: 3 },
    { w: 39.5735, L: 0, R: 57, A: 160, D: 0 },
    { w: 86.9857, L: -4, R: 95, A: 117, D: 3 },
];
const RC_SIZE = 215.3;
function fakeCtxRobotoCondensed() {
    let font = '';
    const rel = () => (Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]) || RC_SIZE) / RC_SIZE;
    const box = (w, L, R, A, D, k) => ({
        width: w * k, actualBoundingBoxLeft: L * k, actualBoundingBoxRight: R * k,
        actualBoundingBoxAscent: A * k, actualBoundingBoxDescent: D * k,
    });
    return {
        set font(v) { font = v; }, get font() { return font; },
        letterSpacing: '0px', save() {}, restore() {},
        measureText(text) {
            const k = rel();
            const s = String(text);
            if (s === 'H') return box(115.2649, 0, 132, 153, 0, k);
            if (s === RC_TEXT) return box(746.0178, 0, 754.0321, 161, 46, k);
            const pre = RC_TEXT.startsWith(s) ? s.length : -1;
            if (s.length === 1) {
                const i = RC_TEXT.indexOf(s);
                const c = RC_CHAR[i >= 0 ? i : 0];
                return box(c.w, c.L, c.R, c.A, c.D, k);
            }
            if (pre >= 0) return box(RC_PREFIX[pre], 0, RC_PREFIX[pre], 153, 0, k);
            // chuỗi lạ (test chuỗi người dùng gõ): rải đều theo số ký tự
            const n = s.length / RC_TEXT.length;
            return box(746.0178 * n, 0, 754.0321 * n, 161, 46, k);
        },
    };
}

// ---- F1) Hình học hộp tĩnh & chỗ neo của nét nhấn --------------------------
const layF = TextTemplates.layout(fakeCtxRobotoCondensed(), tplF, ['Folgen Sie'], 1, FRAME);
const fText = layF.boxes[0];
const fSpark = layF.boxes[1];
assert.ok(Math.abs(fText.w - 754.03) < 0.05, `hộp mực chữ rộng 754 (đo video), nhận ${fText.w}`);
assert.ok(Math.abs(fText.h - 153) < 0.01, 'hộp chữ cao đúng DẢI CHỮ HOA 153 (baseline 1026 − đỉnh 873)');
assert.ok(Math.abs(fSpark.w - 168) < 0.01 && Math.abs(fSpark.h - 119) < 0.01,
    'hộp nét nhấn = HỢP hai trạng thái nhịp đập, 168×119');
assert.ok(Math.abs((fSpark.x + fSpark.w) - (fText.x + fText.w) - 65) < 0.01,
    'mép phải nét nhấn cách mép phải chữ đúng 65px (981 − 916 trên video)');
assert.ok(Math.abs(fText.y - (fSpark.y + fSpark.h) - 76) < 0.01,
    'mép trên dải chữ hoa cách mép dưới nét nhấn đúng 76px (873 − 797 trên video)');

// ---- F2) Chữ NGHIÊNG phải đi tới tận chuỗi font của canvas -----------------
const fFonts = TextTemplates.fonts(tplF);
assert.strictEqual(fFonts.length, 1);
assert.strictEqual(fFonts[0].style, 'italic',
    'fonts() phải khai kiểu nghiêng — đó là thứ preloadTemplateFonts/document.fonts.check dùng');
assert.strictEqual(TextTemplates.layerTextStyle(tplF.layers[0]).font_italic, true);
/* Nghiêng là một khoá STYLE, nếu không thì chỉ cần đổi màu chữ ở Inspector là mẫu
   hết nghiêng (đúng lỗi mà bg_pad_* từng mắc ở "Quote"). */
const ovF = TextTemplates.resolve(tplF, { title: { color: '#ff0000' } });
assert.strictEqual(ovF.layers[0].font.italic, true, 'đổi màu chữ KHÔNG được làm mất chữ nghiêng');
assert.strictEqual(ovF.layers[0].color, '#ff0000');
const layOvF = TextTemplates.layout(fakeCtxRobotoCondensed(), ovF, ['Folgen Sie'], 1, FRAME);
assert.ok(Math.abs(layOvF.boxes[0].w - fText.w) < 0.01, 'đổi màu chữ -> hộp giữ nguyên');

// ---- F3) Lệch pha theo ký tự: DẤU CÁCH cũng chiếm một nhịp -----------------
const fAnim = tplF.layers[0].anim;
assert.ok(Math.abs(fAnim.perChar.stagger - 1 / 16) < 1e-9, 'lệch pha 1/16 s (1.875 khung)');
assert.ok(Math.abs(fAnim.delay - 1 / 30) < 1e-9, 'ký tự đầu bắt đầu ở khung 14 => delay 1/30');
/* Mốc BẮT ĐẦU hoạt ảnh của từng ký tự = khung 14 + 1.875·i. Trên video ký tự chỉ NHÌN
   THẤY được muộn hơn ~2 khung (scale còn nhỏ, alpha còn thấp) — dãy đo được là
   16, 18, 20, 22, 23.5, 25.4, [dấu cách], 29.1, 31, 32.9, đúng bằng dãy này cộng 2. */
['F', 'o', 'l', 'g', 'e', 'n', ' ', 'S', 'i', 'e'].forEach((ch, i) => {
    const want = 14 + 1.875 * i;                     // khung của video
    const t = (fAnim.delay + i * fAnim.perChar.stagger);
    assert.ok(Math.abs((13 + t * 30) - want) < 0.01,
        `ký tự ${i} ("${ch}") phải bắt đầu ở khung ${want}`);
    // đúng mốc đó thì trạng thái vừa hết "ẩn"; sớm hơn một chút là vẫn ẩn.
    assert.ok(TextTemplates.charStateAt(tplF.layers[0], t - 1e-6, i).hidden,
        `ký tự ${i} chưa được hiện trước mốc của nó`);
    assert.ok(!TextTemplates.charStateAt(tplF.layers[0], t, i).hidden);
});
/* Bỏ dấu cách ra khỏi phép đếm là "Sie" hiện sớm hơn gần 2 khung — chốt lại rằng
   charCount/charStateAt đếm CẢ ký tự trắng. */
const sigA = TextTemplates.frameSignature(tplF, 0.6, ['Folgen Sie']);
const sigB = TextTemplates.frameSignature(tplF, 0.6, ['FolgenSie']);
assert.notStrictEqual(sigA, sigB, 'chữ ký khung phải đổi khi số ký tự đổi (bỏ dấu cách)');

// ---- F4) Đường phóng vào của một ký tự: vọt lên rồi NẢY DỘI TẮT DẦN --------
const fScale = fAnim.tracks.scale;
assert.ok(Math.abs(TextTemplates.trackAt(fScale, 0, 1) - 0) < 1e-9, 'ký tự bắt đầu từ scale 0');
assert.ok(Math.abs(TextTemplates.trackAt(fScale, 7 / 30, 1) - 1.129) < 1e-9,
    'đỉnh vọt 1.129 ở khung thứ 7 (đo chiều cao mực chữ F: 175/155)');
assert.ok(Math.abs(TextTemplates.trackAt(fScale, 12 / 30, 1) - 0.903) < 1e-9,
    'hõm sâu nhất 0.903 ở khung thứ 12');
assert.ok(Math.abs(TextTemplates.trackAt(fScale, 29 / 30, 1) - 1) < 1e-9, 'lắng về đúng 1');
assert.ok(Math.abs(TextTemplates.trackAt(fScale, 5, 1) - 1) < 1e-9, 'sau keyframe cuối thì đứng yên');
// biên độ phải TẮT DẦN, nếu không là chép nhầm một mốc và chữ rung mãi
const peaks = [7, 17, 25].map((f) => TextTemplates.trackAt(fScale, f / 30, 1) - 1);
assert.ok(peaks[0] > peaks[1] && peaks[1] > peaks[2] && peaks[2] > 0, 'các đỉnh phải nhỏ dần');
// mờ dần xong trong ~4 khung (alpha đo được f16 0.63, f17 0.94, f18 1.00)
assert.ok(Math.abs(TextTemplates.trackAt(fAnim.tracks.opacity, 4 / 30, 1) - 1) < 1e-9);

// ---- F5) Nét nhấn: phóng vào MỘT LẦN + nhịp đập LẶP trên cùng một lớp ------
const sparkLayer = tplF.layers[1];
assert.ok(Math.abs(sparkLayer.anim.delay - 11 / 30) < 1e-9, 'nét nhấn hiện ở khung 24 => delay 11/30');
assert.ok(!sparkLayer.anim.period,
    'KHÔNG được dùng `period`: nó quay vòng cả track scale, nét nhấn sẽ phóng lại từ 0 mỗi chu kỳ');
assert.ok(!sparkLayer.anim.tracks.opacity,
    'nét nhấn KHÔNG mờ dần (alpha đo được ≈0.99 ngay từ khung đầu nhìn thấy được)');
assert.ok(Math.abs(TextTemplates.trackAt(sparkLayer.anim.tracks.scale, 16 / 30, 1) - 1.101) < 1e-9,
    'đỉnh vọt 1.101 ở khung 40 của video');
/* NHỊP ĐẬP: bậc thang CỨNG, đổi trạng thái mỗi 6 khung, bắt đầu ở trạng thái TRONG
   ngay tại khung 24. Dóng theo các đoạn đo chắc chắn trên video. */
[[24, 0], [29, 0], [30, 1], [35, 1], [36, 0], [41, 0], [42, 1], [47, 1], [48, 0], [65, 0], [70, 1]]
    .forEach(([frame, want]) => {
        const st = TextTemplates.layerStateAt(sparkLayer, (frame - 13) / 30);
        assert.strictEqual(st.reveal, want,
            `khung ${frame} phải ở trạng thái ${want ? 'NGOÀI' : 'TRONG'} của nhịp đập`);
    });
// bậc thang thật: sát trước mốc vẫn là giá trị cũ, đúng mốc đã là giá trị mới
const pulse = sparkLayer.anim.tracks.reveal;
assert.strictEqual(TextTemplates.trackAt(pulse, 0.2 - 1e-3, 1), 0);
assert.strictEqual(TextTemplates.trackAt(pulse, 0.2, 1), 1);
assert.ok(pulse[pulse.length - 1][0] >= 3.0 - 11 / 30 - 0.2,
    'nhịp đập phải phủ tới hết thời lượng block, không tắt giữa chừng');

// ---- F6) Hình nét nhấn phải nằm GỌN trong hộp ở CẢ hai trạng thái ----------
/* layout() tính lề canvas mà KHÔNG xét `reveal`, nên nét ở trạng thái ngoài thò ra
   khỏi hộp là bị xén ở mép canvas — chỉ lộ ra ở khâu xuất. Đo bằng ctx giả ghi lại
   đường vẽ, cộng nửa bề dày nét (lineCap tròn). */
const glyphDef = TextTemplates.GLYPHS['emphasis-lines'];
assert.ok(glyphDef, 'phải có hình "emphasis-lines"');
assert.ok(Math.abs(glyphDef.aspect - 168 / 119) < 1e-9, 'tỉ lệ hộp = 168/119 đo trên video');
function pathProbe() {
    const pts = [];
    let lw = 0;
    return {
        pts,
        set lineWidth(v) { lw = v; }, get lineWidth() { return lw; },
        strokeStyle: '', lineCap: '',
        beginPath() {}, stroke() {},
        moveTo(x, y) { pts.push([x, y, lw]); },
        lineTo(x, y) { pts.push([x, y, lw]); },
    };
}
[0, 1].forEach((reveal) => {
    const p = pathProbe();
    glyphDef.draw(p, 59.5, { mark: '#ffffff' }, reveal);
    assert.strictEqual(p.pts.length, 6, 'ba nét, mỗi nét hai điểm');
    p.pts.forEach(([x, y, w]) => {
        assert.ok(Math.abs(x) + w / 2 <= 84 + 1.5,
            `nét vượt mép ngang của hộp ở trạng thái ${reveal} (x=${x}, dày=${w})`);
        assert.ok(Math.abs(y) + w / 2 <= 59.5 + 1.5,
            `nét vượt mép dọc của hộp ở trạng thái ${reveal} (y=${y}, dày=${w})`);
    });
});
/* Hai trạng thái phải KHÁC nhau và mỗi nét trượt theo TRỤC CỦA CHÍNH NÓ (nếu ai đó
   thay bằng dx/dy mức lớp thì ba nét sẽ dời cùng một hướng — chốt lại ở đây). */
const inA = pathProbe(); glyphDef.draw(inA, 59.5, {}, 0);
const inB = pathProbe(); glyphDef.draw(inB, 59.5, {}, 1);
const moves = [0, 2, 4].map((i) => [inB.pts[i][0] - inA.pts[i][0], inB.pts[i][1] - inA.pts[i][1]]);
assert.ok(moves.every(([dx, dy]) => Math.hypot(dx, dy) > 10), 'mỗi nét phải trượt thật (>10px)');
assert.ok(Math.abs(moves[0][0] - moves[2][0]) > 5,
    'ba nét KHÔNG được trượt cùng một hướng — đó là chỗ khác biệt với dx/dy mức lớp');

// ---- F7) Thumbnail/PNG tĩnh phải rơi vào lúc mọi lớp đứng yên --------------
const settleF = TextTemplates.settleTime(tplF, ['Folgen Sie']);
assert.ok(settleF > 0 && settleF < tplF.duration);
tplF.layers.forEach((layer, i) => {
    const st = TextTemplates.layerStateAt(layer, settleF);
    assert.ok(!st.hidden && Math.abs(st.scale - 1) < 0.01,
        `lớp ${i} phải đứng yên ở mốc settleTime (${settleF})`);
});

/* =======================================================================
 * MẪU "ZOOM TITLE" — tiêu đề khổng lồ thu về + thanh màu bật ra rồi dòng phụ GÕ RA
 * TỪNG NÉT sau một mép cắt phẳng.
 *
 * SỐ THAM CHIẾU (video Toumament Summer Season, 1080×1920, 30fps, block = khung 13..102):
 *   tiêu đề  mực x 136..945 (810), dải chữ hoa y 873..973 (101), tâm (540.5, 923)
 *            phóng 9.729 -> 1.000 trong 14 khung; mờ dần 1/6 mỗi khung (đủ 1 ở khung 19)
 *   thanh    #fcba00, x 132..947 (816), y 991..1087 (97), bật ra NGUYÊN VẸN ở khung 27
 *   dòng phụ mực x 198..880 (683), dải chữ hoa 36; đệm 66.5 / trên 29 / dưới 32
 *            mép cắt chạy đều hết hộp mực trong 12.3 khung
 *   khe      baseline tiêu đề 974 -> mép trên thanh 990.5 => rowGap 17
 * ==================================================================== */
const tplZ = TextTemplates.byId('zoom-title');
assert.ok(tplZ, 'phải có mẫu "zoom-title"');
assert.strictEqual(tplZ.duration, 3.0, 'thời lượng 3.00s (90 khung @30fps đo trên video)');
assert.deepStrictEqual(TextTemplates.defaultTexts(tplZ), ['BADMINTON', 'Tournament Summer Season']);
assert.strictEqual(tplZ.rowGap, 17, 'khe tiêu đề ↔ thanh màu = 17px (đo trên video)');

/* Thước đo hai font của mẫu, bảng lấy từ chính canvas của Chrome rồi đóng băng.
   Hai lớp KHÔNG chạy hiệu ứng theo ký tự nên engine chỉ hỏi hộp mực cả chuỗi + 'H'. */
const RUL_Z = {
    BADMINTON: { size: 144.286, w: 817.9969, L: -8, R: 818.0005, A: 103, D: 2, cap: 101 },
    'Tournament Summer Season': { size: 51.064, w: 684.8029, L: 0, R: 682.9972, A: 37, D: 1, cap: 36 },
};
function fakeCtxZoom() {
    let font = '';
    const box = (w, L, R, A, D, k) => ({
        width: w * k, actualBoundingBoxLeft: L * k, actualBoundingBoxRight: R * k,
        actualBoundingBoxAscent: A * k, actualBoundingBoxDescent: D * k,
    });
    // Cỡ chữ trong chuỗi font cho biết ĐANG đo lớp nào (hai lớp hai cỡ khác hẳn nhau).
    const specFor = () => {
        const size = Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]) || 0;
        let best = null; let bestErr = Infinity;
        Object.values(RUL_Z).forEach((s) => {
            for (const k of [1, 2, 0.5, 3, 4]) {
                const err = Math.abs(size - s.size * k) / s.size;
                if (err < bestErr) { bestErr = err; best = s; }
            }
        });
        return best;
    };
    return {
        set font(v) { font = v; }, get font() { return font; },
        letterSpacing: '0px', save() {}, restore() {},
        measureText(text) {
            const spec = specFor();
            const k = (Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]) || spec.size) / spec.size;
            const s = String(text);
            if (s === 'H') return box(spec.cap * 1.05, 0, spec.cap, spec.cap, 0, k);
            const ref = RUL_Z[s];
            if (ref) return box(ref.w, ref.L, ref.R, ref.A, ref.D, k);
            const n = Math.max(1, s.length) / Object.keys(RUL_Z).find((t) => RUL_Z[t] === spec).length;
            return box(spec.w * n, spec.L, spec.R * n, spec.A, spec.D, k);
        },
    };
}

// ---- Z1) Hình học hộp tĩnh & hộp nền không cân đối -------------------------
const layZ = TextTemplates.layout(fakeCtxZoom(), tplZ, TextTemplates.defaultTexts(tplZ), 1, FRAME);
const zTitle = layZ.boxes[0];
const zBar = layZ.boxes[1];
assert.ok(Math.abs(zTitle.w - 810) < 0.05 && Math.abs(zTitle.h - 101) < 0.01,
    `hộp tiêu đề = 810×101 (mực đo trên video), nhận ${zTitle.w}×${zTitle.h}`);
assert.ok(Math.abs(zBar.w - 816) < 0.05 && Math.abs(zBar.h - 97) < 0.01,
    `thanh màu = 816×97 (683 + 2×66.5, và 29+36+32), nhận ${zBar.w}×${zBar.h}`);
assert.ok(Math.abs(zBar.y - (zTitle.y + zTitle.h) - 17) < 0.01, 'khe hai lớp đúng 17px');
assert.ok(Math.abs(layZ.width - 816) < 0.05 && Math.abs(layZ.height - 215) < 0.01,
    'hộp tĩnh của cả nhóm = 816×215');
/* Hộp nền KHÔNG cân đối (29 trên / 32 dưới): baseline phải nằm 65px dưới mép trên thanh —
   cân đối thì ra 66.5 và cả dòng chữ trôi 1.5px so với video. */
assert.strictEqual(layZ.measured[1].baseline0, 65, 'baseline dòng phụ = padTop 29 + dải chữ hoa 36');
/* Đổi màu chữ KHÔNG được làm hộp nền nhảy về tỉ lệ mặc định (đúng lỗi mà bg_pad_* sinh ra
   để chặn) — kiểm lại trên mẫu này vì nó là mẫu thứ hai dùng đệm lệch. */
const ovZ = TextTemplates.resolve(tplZ, { subtitle: { color: '#123456' } });
const layOvZ = TextTemplates.layout(fakeCtxZoom(), ovZ, TextTemplates.defaultTexts(tplZ), 1, FRAME);
assert.ok(Math.abs(layOvZ.boxes[1].w - zBar.w) < 0.01 && Math.abs(layOvZ.boxes[1].h - zBar.h) < 0.01,
    'đổi màu chữ -> thanh màu giữ nguyên 816×97');

// ---- Z2) Tiêu đề: phóng 9.73× về 1, KHÔNG vọt quá ---------------------------
const zAnim = tplZ.layers[0].anim;
assert.strictEqual(zAnim.delay, 0, 'tiêu đề có mặt ngay từ đầu block (khung 13, độ mờ 0)');
assert.ok(Math.abs(TextTemplates.trackAt(zAnim.tracks.scale, 1 / 30, 1) - 9.729) < 1e-9,
    'khung 14 phóng 9.729× (đo bằng phép dò mặt nạ)');
assert.ok(Math.abs(TextTemplates.trackAt(zAnim.tracks.scale, 15 / 30, 1) - 1) < 1e-9,
    'khung 28 về đúng 1');
/* Đơn điệu GIẢM: mẫu này KHÔNG có nảy dội (khác "Folgen Sie"/"Approved"). Một keyframe
   chép nhầm dấu là chữ giật ngược mà hộp tĩnh vẫn đúng, nhìn qua không thấy. */
let prevScale = Infinity;
zAnim.tracks.scale.forEach(([t, v], i) => {
    if (i === 0) { prevScale = v; return; }
    assert.ok(v <= prevScale + 1e-9, `hệ số phóng phải giảm dần, gãy ở mốc ${t}`);
    prevScale = v;
});
assert.ok(Math.abs(TextTemplates.trackAt(zAnim.tracks.opacity, 6 / 30, 1) - 1) < 1e-9,
    'mờ dần đủ 1 sau 6 khung (đo 0.16/0.32/0.48/0.65/0.82/1.00 ở khung 14..19)');
assert.ok(Math.abs(TextTemplates.trackAt(zAnim.tracks.opacity, 3 / 30, 1) - 0.5) < 0.02,
    'mờ dần TUYẾN TÍNH: giữa quãng phải đúng 0.5');

// ---- Z3) Dòng phụ: mép cắt chạy đều, thanh màu bật ra nguyên vẹn -----------
const zSub = tplZ.layers[1].anim;
assert.ok(Math.abs(zSub.delay - 14 / 30) < 1e-9, 'thanh màu bật ra ở khung 27 => delay 14/30');
assert.ok(!zSub.tracks.opacity && !zSub.tracks.scale,
    'thanh màu KHÔNG mờ dần, KHÔNG phóng — khung 26 chưa có gì, khung 27 đã đủ cỡ và đủ đậm');
assert.strictEqual(TextTemplates.layerStateAt(tplZ.layers[1], (26 - 13) / 30).hidden, true,
    'khung 26 lớp dòng phụ còn ẩn hẳn');
assert.strictEqual(TextTemplates.layerStateAt(tplZ.layers[1], (27 - 13) / 30).reveal, 0,
    'khung 27: thanh màu đã hiện mà chữ chưa lộ nét nào');
[[31, 0.325], [35, 0.650], [39, 0.976], [40, 1]].forEach(([f, want]) => {
    const r = TextTemplates.layerStateAt(tplZ.layers[1], (f - 13) / 30).reveal;
    assert.ok(Math.abs(r - want) < 0.005, `khung ${f}: mép cắt phải ở ${want}, nhận ${r}`);
});
/* Dãy đo trên video là CẬN DƯỚI của mép cắt (mép rơi vào khe giữa hai chữ thì số pixel mực
   đứng yên trong khi mép vẫn chạy). Đường thẳng của mẫu phải nằm TRÊN mọi điểm đo — đó là
   lý do quãng chạy là 12.3 khung chứ không phải 13. */
[[28, 0.060], [29, 0.136], [30, 0.214], [31, 0.315], [32, 0.386], [33, 0.450], [34, 0.529],
    [35, 0.650], [36, 0.714], [37, 0.787], [38, 0.864], [39, 0.937]].forEach(([f, floor]) => {
    const r = TextTemplates.layerStateAt(tplZ.layers[1], (f - 13) / 30).reveal;
    assert.ok(r >= floor - 1e-6, `khung ${f}: mép cắt (${r.toFixed(3)}) không được chậm hơn cận dưới đo được ${floor}`);
});
assert.ok(TextTemplates.layerStateAt(tplZ.layers[1], (39 - 13) / 30).reveal < 1,
    'khung 39 chữ CHƯA xong (video còn thiếu 34px cuối) — quãng chạy không được ngắn hơn nữa');

/* ---- Z4) HỢP ĐỒNG CỦA MÉP LỘ DẦN: cắt CHỮ, KHÔNG cắt NỀN ------------------
 * Đây là chỗ hỏng âm thầm: đặt clip trước phần vẽ nền thì thanh màu cũng lộ dần theo, mà
 * trên preview nhỏ nhìn vẫn "có vẻ đúng". Đo bằng ctx giả ghi lại THỨ TỰ thao tác. */
function drawProbe() {
    const log = [];
    const noop = () => {};
    const ctx = {
        log,
        font: '', letterSpacing: '0px', textAlign: '', textBaseline: '',
        fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 0, lineJoin: '', miterLimit: 0,
        lineCap: '', shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
        save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
        beginPath: noop, moveTo: noop, lineTo: noop, arcTo: noop, arc: noop, closePath: noop,
        stroke: noop, strokeText: noop, fillRect: noop, clearRect: noop,
        fill() { log.push({ op: 'fill', color: this.fillStyle }); },
        rect(x, y, w, h) { log.push({ op: 'rect', x, y, w, h }); },
        clip() { log.push({ op: 'clip' }); },
        fillText(t) { log.push({ op: 'text', t }); },
        measureText: fakeCtxZoom().measureText,
    };
    return ctx;
}
const probe = drawProbe();
const lz = TextTemplates.layout(fakeCtxZoom(), tplZ, TextTemplates.defaultTexts(tplZ), 1, FRAME);
TextTemplates.drawFrame(probe, tplZ, TextTemplates.defaultTexts(tplZ), (33 - 13) / 30, lz);
const iBg = probe.log.findIndex((e) => e.op === 'fill' && e.color === '#fcba00');
const iClip = probe.log.findIndex((e) => e.op === 'clip');
const iText = probe.log.findIndex((e) => e.op === 'text' && String(e.t).startsWith('Tournament'));
assert.ok(iBg >= 0, 'phải có lệnh tô thanh màu #fcba00');
assert.ok(iClip > iBg, 'mép cắt phải đặt SAU khi tô nền — nếu không thanh màu cũng bị lộ dần');
assert.ok(iText > iClip, 'chữ phải vẽ SAU mép cắt');
const cutRect = probe.log[iClip - 1];
assert.strictEqual(cutRect.op, 'rect', 'ngay trước clip phải là rect của mép cắt');
/* Bề rộng vùng giữ lại = box.w (phần thừa bên trái để không xén viền/bóng) + padX +
   innerWidth × reveal. Chốt con số này để mép cắt luôn bám HỘP MỰC, không bám hộp lớp. */
const rz = TextTemplates.layerStateAt(tplZ.layers[1], (33 - 13) / 30).reveal;
const wantW = lz.boxes[1].w + lz.measured[1].padX + lz.measured[1].innerWidth * rz;
assert.ok(Math.abs(cutRect.w - wantW) < 0.01,
    `mép cắt phải tính theo hộp MỰC: cần ${wantW.toFixed(2)}, nhận ${cutRect.w}`);
// reveal = 1 thì KHÔNG được đặt clip (thừa, và là chỗ dễ lệch nửa pixel ở khâu xuất)
const probeFull = drawProbe();
TextTemplates.drawFrame(probeFull, tplZ, TextTemplates.defaultTexts(tplZ), 2.0, lz);
assert.ok(!probeFull.log.some((e) => e.op === 'clip'), 'lộ hết rồi thì không đặt mép cắt nữa');

/* =======================================================================
 * MẪU "MOOD MATCHA" — hai dòng chữ tròn mập viền HAI LỚP, mọc lên TỪNG KÝ TỰ từ dòng
 * kẻ; bình sữa ở trên-trái, ba vệt nhấn ở dưới-phải.
 *
 * SỐ THAM CHIẾU (video 1080×1920, 30fps, block = khung 13..102):
 *   dòng 1 "Mood"   mực x 244..777 (534), dải chữ hoa y 770..917 (148)
 *   dòng 2 "Matcha" mực x 162..867 (706), dải chữ hoa y 988..1135 (148); khe hai hộp 70
 *   viền   vòng ngoài #69eb03 dày 7 + vòng trong #304227 dày 13 = 20 tính từ mép mực
 *   bình   hộp 82×110, mép trái = mép trái hộp chữ − 26, mép trên = đỉnh dòng 1 − 96
 *   vệt    hộp 76×88, mép trái = mép phải hộp chữ − 3, mép trên = đáy hộp chữ + 20
 *   nhịp   dòng 1 bắt đầu khung 14.5, lệch pha 3 khung
 *
 * CHỖ CỐ Ý LỆCH SỐ ĐO (theo yêu cầu): video có HAI đối tượng chữ; ở đây chỉ còn MỘT ô
 * nội dung, hai dòng là phép XUỐNG DÒNG trong ô đó. Bố cục tĩnh phải KHÔNG ĐỔI (hai
 * baseline cách 218, hộp lớp cao 366 = 148+70+148) còn lệch pha thì chạy LIÊN TỤC qua
 * chỗ ngắt dòng. Bình sữa nghiêng TĨNH 30° quanh tâm hộp.
 * ==================================================================== */
const tplM = TextTemplates.byId('mood-matcha');
assert.ok(tplM, 'phải có mẫu "mood-matcha"');
assert.strictEqual(tplM.duration, 3.0, 'thời lượng 3.00s (90 khung @30fps đo trên video)');
assert.deepStrictEqual(TextTemplates.defaultTexts(tplM), ['Mood\nMatcha'],
    'MỘT ô nội dung duy nhất, hai dòng ngăn nhau bằng ký tự xuống dòng');
assert.strictEqual(tplM.slots.length, 1, 'không còn ô "Dòng 2" riêng');
assert.strictEqual(tplM.layers.filter((l) => l.kind === 'text').length, 1,
    'một ô nội dung = MỘT lớp chữ (mọi lớp trang trí neo theo đúng một hộp chữ)');
/* DỰ ÁN CŨ lưu HAI ô — phải nối lại thành một ô hai dòng, không được cắt mất dòng 2. */
assert.deepStrictEqual(TextTemplates.normalizeTexts(tplM, ['Vibe', 'Coffee']), ['Vibe\nCoffee'],
    'nội dung hai ô của dự án cũ nối thành một ô hai dòng');
assert.deepStrictEqual(TextTemplates.normalizeTexts(tplM, ['Vibe', '  ']), ['Vibe'],
    'ô cũ để trống thì không thêm dòng rỗng vào cuối');

/* Thước đo Nunito 900 ở size 206.993 / letter −0.462, bảng lấy từ canvas của Chrome rồi
   đóng băng. Có advance TỪNG KÝ TỰ và advance của TIỀN TỐ vì hai lớp chạy theo ký tự. */
const NU = {
    size: 206.993,
    H: { w: 162.2321, L: -12, R: 150, A: 148, D: 2 },
    Mood: { w: 558.681, L: -13, R: 549.8092, A: 148, D: 3 },
    Matcha: { w: 728.1097, L: -13, R: 719.0015, A: 148, D: 3 },
    chars: {
        M: { w: 182.5172, L: -13, R: 170, A: 148, D: 2 },
        o: { w: 124.146, L: -5, R: 119, A: 105, D: 3 },
        d: { w: 127.8718, L: -5, R: 119, A: 148, D: 3 },
        a: { w: 117.1083, L: -5, R: 108, A: 105, D: 3 },
        t: { w: 87.7157, L: 3, R: 89, A: 134, D: 3 },
        c: { w: 99.7212, L: -5, R: 99, A: 105, D: 3 },
        h: { w: 124.974, L: -10, R: 116, A: 148, D: 2 },
    },
    pref: {
        Mood: [0, 182.5172, 306.6632, 430.8092, 558.681],
        Matcha: [0, 182.5172, 299.6255, 387.3412, 486.0275, 611.0015, 728.1097],
    },
};
function fakeCtxNunito() {
    let font = '';
    const rel = () => (Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]) || NU.size) / NU.size;
    const box = (s, k) => ({
        width: s.w * k, actualBoundingBoxLeft: s.L * k, actualBoundingBoxRight: s.R * k,
        actualBoundingBoxAscent: s.A * k, actualBoundingBoxDescent: s.D * k,
    });
    return {
        set font(v) { font = v; }, get font() { return font; },
        letterSpacing: '0px', save() {}, restore() {},
        measureText(text) {
            const k = rel();
            const s = String(text);
            if (s === 'H') return box(NU.H, k);
            if (NU[s]) return box(NU[s], k);
            if (s.length === 1 && NU.chars[s]) return box(NU.chars[s], k);
            for (const word of ['Mood', 'Matcha']) {
                if (word.startsWith(s)) {
                    const w = NU.pref[word][s.length];
                    return box({ w, L: -13, R: w, A: 148, D: 3 }, k);
                }
            }
            const n = Math.max(1, s.length) / 6;
            return box({ w: NU.Matcha.w * n, L: -13, R: NU.Matcha.R * n, A: 148, D: 3 }, k);
        },
    };
}

// ---- M1) Hình học hộp tĩnh & chỗ neo ---------------------------------------
/* Gộp hai lớp thành một KHÔNG được làm bố cục nhúc nhích: hộp chữ vẫn cao 366 (=
   148 + 218, đúng tổng 148+70+148 của hai hộp cũ) và rộng bằng dòng dài nhất. */
const layM = TextTemplates.layout(fakeCtxNunito(), tplM, TextTemplates.defaultTexts(tplM), 1, FRAME);
const [mTxt, mBottle, mSpark] = layM.boxes;
const measM = layM.measured[0];
assert.deepStrictEqual(measM.lines, ['Mood', 'Matcha'], 'ô nội dung tự tách thành hai dòng');
assert.ok(Math.abs(measM.capHeight - 148) < 0.01, 'DẢI CHỮ HOA cao 148');
assert.ok(Math.abs(measM.lineStep - 218) < 0.01,
    `hai baseline cách đúng 218px (770->988 trên video), nhận ${measM.lineStep}`);
assert.ok(Math.abs(mTxt.h - 366) < 0.01,
    `hộp chữ cao 366 = 148 + 218, y hệt tổng hai hộp cũ (148+70+148), nhận ${mTxt.h}`);
assert.ok(Math.abs(mTxt.w - 706) < 0.05,
    `hộp chữ rộng bằng dòng dài nhất "Matcha" = 706 (mực đo trên video), nhận ${mTxt.w}`);
assert.ok(Math.abs(measM.lineWidths[0] - 536.8) < 0.5,
    `dòng 1 rộng 536.8 — video đo 534, lệch 0.5% là sai số của phép chọn font`);
assert.ok(Math.abs(mBottle.w - 82) < 0.01 && Math.abs(mBottle.h - 110) < 0.01,
    'hộp bình sữa giữ đúng 82×110 của sticker trong video');
assert.ok(Math.abs(mBottle.y - mTxt.y + 96) < 0.01, 'bình sữa cao hơn đỉnh dòng 1 đúng 96px');
/* KHE 26px ĐO THEO MỰC DÒNG 1, không theo mép hộp chữ — hộp rộng bằng dòng DÀI NHẤT nên
   neo theo hộp thì gõ MỘT dòng là bình sữa đè lên chữ. Hai số trùng nhau trên video
   (dòng 2 dài hơn dòng 1) nên chỉ chuỗi khác mới phân biệt được -> xem M9. */
const mInk1 = (lay, txtBox) => txtBox.x + (lay.measured[0].innerWidth - lay.measured[0].lineWidths[0]) / 2;
assert.ok(Math.abs((mInk1(layM, mTxt) - (mBottle.x + mBottle.w)) - 26) < 0.01,
    `mép phải bình sữa cách mực dòng 1 đúng 26px, nhận ${mInk1(layM, mTxt) - (mBottle.x + mBottle.w)}`);
assert.ok(Math.abs(mSpark.w - 76) < 0.01 && Math.abs(mSpark.h - 88) < 0.01, 'hộp vệt nhấn 76×88');
assert.ok(Math.abs(mSpark.x - (mTxt.x + mTxt.w) + 3) < 0.01, 'vệt nhấn lùi trái 3px so với mép phải hộp chữ');
assert.ok(Math.abs(mSpark.y - (mTxt.y + mTxt.h) - 20) < 0.01, 'vệt nhấn thấp hơn đáy hộp chữ 20px');

// ---- M2) MỘT lớp chữ, lệch pha chạy LIÊN TỤC qua chỗ ngắt dòng -------------
const mA = tplM.layers[0].anim;
assert.ok(Math.abs(mA.perChar.stagger - 0.1) < 1e-9, 'lệch pha 3 khung = 0.1s');
assert.ok(Math.abs(mA.delay * 30 - 1.5) < 0.01, 'ký tự đầu vào cảnh ở khung 14.5 (block bắt đầu ở 13)');
assert.ok(!mA.tracks.opacity,
    'chữ KHÔNG mờ dần: ngay khung đầu nhìn thấy được màu đã bão hoà');
/* Chỉ số ký tự ĐẾM LIÊN TỤC qua các dòng — đó là điều làm cho một lớp hai dòng chạy
   được: 'M' của dòng 2 là ký tự thứ 5, vào cảnh ở khung 14.5 + 4·3 = 26.5. Nếu chỉ số
   reset theo từng dòng thì cả dòng 2 bật lên cùng lúc với dòng 1. */
const mIdx = measM.chars.map((row) => row.map((c) => c.index));
assert.deepStrictEqual(mIdx, [[0, 1, 2, 3], [4, 5, 6, 7, 8, 9]],
    'chỉ số ký tự đếm liên tục qua chỗ ngắt dòng');
const mStart = (i) => mA.delay + i * mA.perChar.stagger;
assert.ok(Math.abs(mStart(4) * 30 - 13.5) < 1e-6,
    'ký tự đầu DÒNG 2 vào cảnh 13.5 khung sau ký tự đầu dòng 1');

// ---- M3) Ký tự mọc LÊN TỪ BASELINE, không nở đều hai phía ------------------
assert.strictEqual(mA.perChar.origin, 'baseline');
/* Đo bằng ctx giả ghi lại phép translate: tâm biến đổi của ký tự phải nằm ĐÚNG trên
   baseline của dòng. Gốc giữa dải chữ hoa (mặc định) sẽ cho baseline − 74. */
function translateProbe() {
    const tr = [];
    const noop = () => {};
    return {
        tr,
        font: '', letterSpacing: '0px', textAlign: '', textBaseline: '',
        fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 0, lineJoin: '', miterLimit: 0,
        lineCap: '', shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
        save: noop, restore: noop, rotate: noop, scale: noop,
        beginPath: noop, moveTo: noop, lineTo: noop, arcTo: noop, arc: noop, ellipse: noop,
        bezierCurveTo: noop, closePath: noop, clip: noop, rect: noop, fill: noop, stroke: noop,
        fillRect: noop, clearRect: noop, fillText: noop,
        strokeText(t) { tr.push({ op: 'strokeText', t, w: this.lineWidth, color: this.strokeStyle }); },
        translate(x, y) { tr.push({ op: 'translate', x, y }); },
        measureText: fakeCtxNunito().measureText,
    };
}
const pr = translateProbe();
TextTemplates.drawFrame(pr, tplM, TextTemplates.defaultTexts(tplM), mA.delay + 0.02, layM);
/* Chuỗi translate của một ký tự: (tâm+dx,tâm+dy) rồi (−tâm,−tâm). Cặp đầu tiên sau khi
   engine đã dời về gốc hộp lớp cho y = baseline của dòng (= chiều cao dải chữ hoa). */
const tr = pr.tr.filter((e) => e.op === 'translate');
let charCy = null;
for (let i = 0; i + 1 < tr.length; i += 1) {
    // cặp (tâm, −tâm) triệt tiêu nhau chính là phép dời về tâm KÝ TỰ; phép dời về gốc hộp
    // lớp (−w/2, −h/2) không có cặp đối xứng nên không lọt vào đây.
    if (tr[i + 1].y < 0 && Math.abs(tr[i].y + tr[i + 1].y) < 1e-6 && Math.abs(tr[i].x + tr[i + 1].x) < 1e-6) {
        charCy = tr[i].y; break;
    }
}
assert.ok(charCy != null, 'phải có phép dời về tâm ký tự');
assert.ok(Math.abs(charCy - 148) < 0.01,
    `tâm biến đổi của ký tự phải nằm trên BASELINE (148 dưới đỉnh hộp), nhận ${charCy}`);

// ---- M4) Viền HAI LỚP: vòng ngoài vẽ trước, lề canvas theo vòng NGOÀI ------
const strokes = pr.tr.filter((e) => e.op === 'strokeText');
assert.ok(strokes.length >= 2, 'mỗi mẩu chữ phải có hai lệnh viền');
assert.strictEqual(strokes[0].color, '#69eb03', 'vòng NGOÀI (xanh sáng) phải vẽ TRƯỚC');
assert.strictEqual(strokes[1].color, '#304227', 'vòng TRONG (xanh đậm) vẽ sau, đè lên vòng ngoài');
assert.ok(strokes[0].w > strokes[1].w,
    'vòng ngoài phải dày hơn — hai vòng đều tính TỪ MÉP MỰC, không cộng dồn');
assert.ok(Math.abs(strokes[0].w - 40) < 0.01 && Math.abs(strokes[1].w - 26) < 0.01,
    'lineWidth = 2× bề dày thiết kế (20 và 13)');
assert.ok(Math.abs(layM.measured[0].overSide - 20) < 0.01,
    'lề canvas phải theo vòng NGOÀI (20), lấy nhầm vòng trong (13) là vòng ngoài bị xén ở mép');

// ---- M5) Vòng ngoài phải sống sót qua bảng override -----------------------
const ovM = TextTemplates.resolve(tplM, { text: { color: '#ff0000' } });
assert.ok(ovM.layers[0].stroke2 && ovM.layers[0].stroke2.color === '#69eb03',
    'đổi màu chữ KHÔNG được làm mất vòng viền ngoài');
assert.ok(Math.abs(ovM.layers[0].stroke2.width - 20) < 1e-9);
// Tắt "Viền" ở panel thì TẮT CẢ HAI vòng — còn trơ vòng ngoài là thứ không hiểu nổi.
const ovOff = TextTemplates.resolve(tplM, { text: { stroke_enabled: false } });
assert.strictEqual(ovOff.layers[0].stroke, null);
assert.strictEqual(ovOff.layers[0].stroke2, null);

// ---- M6) Đường phóng của ký tự: vọt 1.06 rồi lắng về 1 --------------------
const mScale = mA.tracks.scale;
assert.strictEqual(TextTemplates.trackAt(mScale, 0, 1), 0);
[[1, 0.26], [2, 0.51], [3, 0.78], [4, 0.93], [5, 1.03]].forEach(([f, want]) => {
    assert.ok(Math.abs(TextTemplates.trackAt(mScale, f / 30, 1) - want) < 1e-9,
        `khung thứ ${f} sau khi ký tự vào cảnh phải phóng ${want} (đo trên 'M' dòng 2)`);
});
assert.ok(Math.abs(TextTemplates.trackAt(mScale, 6 / 30, 1) - 1.06) < 1e-9, 'đỉnh vọt 1.06');
assert.ok(Math.abs(TextTemplates.trackAt(mScale, 9 / 30, 1) - 1) < 1e-9, 'lắng về đúng 1');

// ---- M7) Hai hình trang trí ------------------------------------------------
assert.ok(TextTemplates.GLYPHS['baby-bottle'], 'phải có hình "baby-bottle"');
assert.ok(TextTemplates.GLYPHS['spark-wedges'], 'phải có hình "spark-wedges"');
assert.ok(Math.abs(TextTemplates.GLYPHS['baby-bottle'].aspect - 82 / 110) < 1e-9,
    'bình sữa giữ đúng tỉ lệ hộp của sticker trong video (82×110)');
/* Bình sữa là hình TỰ VẼ (đổi từ cốc trà sữa của video) nên phải có đủ ô màu cho panel —
   thiếu ô nào là người dùng không đổi được phần đó mà cũng không biết vì sao. */
const bottleKeys = TextTemplates.GLYPHS['baby-bottle'].colorKeys.map((c) => c.key).sort();
assert.deepStrictEqual(bottleKeys, ['bottle', 'cap', 'cheek', 'line', 'milk']);
tplM.layers.slice(1).forEach((layer) => {
    const def = TextTemplates.GLYPHS[layer.glyph];
    def.colorKeys.forEach((ck) => {
        assert.ok(layer.colors[ck.key], `lớp "${layer.key}" thiếu màu cho khoá "${ck.key}"`);
    });
});
// Nét của hình phải nằm gọn trong hộp (cùng lý do với "Folgen Sie": layout không xét reveal)
const wedgeProbe = { pts: [], lineWidth: 0, strokeStyle: '', lineJoin: '', lineCap: '',
    beginPath() {}, closePath() {}, stroke() {},
    moveTo(x, y) { this.pts.push([x, y, this.lineWidth]); },
    lineTo(x, y) { this.pts.push([x, y, this.lineWidth]); } };
TextTemplates.GLYPHS['spark-wedges'].draw(wedgeProbe, 44, {});
assert.strictEqual(wedgeProbe.pts.length, 9, 'ba nêm, mỗi nêm ba đỉnh');
wedgeProbe.pts.forEach(([x, y, w]) => {
    assert.ok(Math.abs(x) + w / 2 <= 38 + 1.5, `nêm vượt mép ngang của hộp (x=${x})`);
    assert.ok(Math.abs(y) + w / 2 <= 44 + 1.5, `nêm vượt mép dọc của hộp (y=${y})`);
});

// ---- M8) Bình sữa NGHIÊNG TĨNH 30°, không phải hoạt ảnh -------------------
const mBottleLayer = tplM.layers.find((l) => l.key === 'bottle');
assert.strictEqual(mBottleLayer.tilt, 30, 'bình sữa nghiêng 30° về bên PHẢI');
assert.ok(!mBottleLayer.anim.tracks.rot,
    'nghiêng TĨNH phải nằm ở `tilt`, KHÔNG ở tracks.rot — rot ≠ 0 mãi thì stateIsRest '
    + 'không bao giờ đúng và settleTime hết chỗ dừng (thumbnail lấy sai khung)');
/* Hệ quả phải giữ: settleTime vẫn tìm được mốc "mọi lớp đã đứng yên" nằm TRONG block. */
const mSettle = TextTemplates.settleTime(tplM, TextTemplates.defaultTexts(tplM));
assert.ok(mSettle > 0 && mSettle < tplM.duration,
    `settleTime phải nằm trong block, nhận ${mSettle}`);
assert.ok(mSettle >= mStart(9) + 9 / 30 - 1e-6,
    'mốc nghỉ phải sau khi ký tự CUỐI phóng xong');
/* drawFrame phải thật sự xoay hộp bình sữa 30° (rad = π/6) ở mốc đã đứng yên, và
   KHÔNG xoay hộp chữ (tilt của nó không được đặt). */
function rotateProbe() {
    const rots = [];
    const base = translateProbe();
    return Object.assign(base, { rots, rotate(a) { rots.push(a); } });
}
const rp = rotateProbe();
TextTemplates.drawFrame(rp, tplM, TextTemplates.defaultTexts(tplM), mSettle, layM);
assert.deepStrictEqual(rp.rots.map((a) => Number((a * 180 / Math.PI).toFixed(4))), [30],
    'đúng MỘT phép xoay 30° (của bình sữa) trong cả khung — hộp chữ không nghiêng');
/* Lề canvas phải cộng phần hộp nghiêng choán thêm — nếu không, góc bình sữa bị xén ở
   mép canvas và chỉ lộ ra ở khâu xuất. Hộp 82×110 nghiêng 30° có nửa bề rộng
   41·cos30 + 55·sin30 = 63.0 (thay vì 41), mà bình sữa vốn đã là mép TRÁI của hộp
   tĩnh, nên lề ngang phải ≥ 63 − 41 = 22. */
const layNoTilt = TextTemplates.layout(
    fakeCtxNunito(),
    { ...tplM, layers: tplM.layers.map((l) => (l.key === 'bottle' ? { ...l, tilt: 0 } : l)) },
    TextTemplates.defaultTexts(tplM), 1, FRAME,
);
assert.ok(layM.marginX >= 22 && layM.marginX > layNoTilt.marginX,
    `lề ngang phải nở ra cho hộp nghiêng (${layM.marginX} so với ${layNoTilt.marginX} khi không nghiêng)`);

// ---- M9) Bình sữa luôn cách MỰC DÒNG 1 đúng 26px với MỌI chuỗi ------------
/* Hai ca của người dùng, và chúng kéo về hai phía ngược nhau:
     · MỘT dòng duy nhất -> mép hộp chữ TRÙNG mép chữ; neo theo hộp là bình sữa đè lên
       chữ (đúng lỗi đã báo).
     · Dòng 2 dài hơn dòng 1 nhiều -> mép hộp chữ lùi xa sang trái; neo theo hộp là bình
       sữa trôi ra xa chữ.
   Neo theo MỰC DÒNG 1 giải cả hai bằng một số đo duy nhất. */
const mGap = (text) => {
    const lay = TextTemplates.layout(fakeCtxNunito(), tplM, [text], 1, FRAME);
    const [txt, bottle] = lay.boxes;
    const mm = lay.measured[0];
    const ink1 = txt.x + (mm.innerWidth - mm.lineWidths[0]) / 2;   // căn giữa
    return ink1 - (bottle.x + bottle.w);
};
[
    ['Mood\nMatcha', 'hai dòng, dòng dưới DÀI hơn (đúng chuỗi của video)'],
    ['Mood Matcha', 'MỘT dòng duy nhất — ca đang bị bình sữa đè lên chữ'],
    ['Matcha\nMood', 'hai dòng, dòng dưới NGẮN hơn'],
    ['Mood\nMatcha Matcha', 'dòng dưới dài gấp đôi — bình sữa không được trôi ra xa'],
].forEach(([text, why]) => {
    assert.ok(Math.abs(mGap(text) - 26) < 0.01,
        `khe bình sữa -> mực dòng 1 phải luôn là 26px (${why}), nhận ${mGap(text)}`);
});
/* Và phải THẬT SỰ dịch đi so với cách neo theo hộp: với một dòng duy nhất, cách cũ
   (fx·flowW) đặt bình sữa ở −26 tức chồng lên 56px đầu của chữ. */
const layOne = TextTemplates.layout(fakeCtxNunito(), tplM, ['Mood Matcha'], 1, FRAME);
const [oneTxt, oneBottle] = layOne.boxes;
assert.ok(oneBottle.x + oneBottle.w <= oneTxt.x + 0.01,
    'một dòng: bình sữa phải nằm HẲN bên trái chữ, không chồng lên');

/* ==========================================================================
 * MẪU "CUSTOM" — mẫu DUY NHẤT không đo từ video, và mẫu DUY NHẤT có LỚP ẢNH.
 *
 * Thiết kế phát biểu bằng TỈ LỆ, đo trên bản vẽ của người dùng (2026-09-13:
 * "Dimension - Textbox Icon/Illus.png" + hai bản dựng "Textbox - Icon/Illus"),
 * mọi số quy về H = CHIỀU CAO HỘP TRẮNG:
 *   Hộp   : nền #ffffff, bo góc 0.169·H, đệm ngang H/2 mỗi bên
 *   Icon  : vuông cạnh X = H,      TÂM đặt đúng GÓC TRÊN-TRÁI hộp
 *   Illus : vuông cạnh Y = 1.41·H, CANH GIỮA dọc, đè lên hộp 0.3·Y
 *
 * BẢN TRƯỚC SAI CẢ HAI: hình đứng HẲN bên trái hộp cách một khe (Icon X/2, Illus
 * 0.3Y) và chữ trắng KHÔNG có nền. Test này khoá lại bản đúng.
 *
 * VÌ SAO TEST NÀY KHÁC MỌI TEST Ở TRÊN: các mẫu kia khoá lại SỐ ĐO PIXEL đọc từ video
 * CapCut. Ở đây không có pixel nào để khoá — thứ phải giữ là QUAN HỆ TỈ LỆ. Nên test
 * đòi các đẳng thức trên đúng ở nhiều cỡ chữ và nhiều số dòng khác nhau: đó đúng là
 * thứ vỡ ngay nếu ai đó "đơn giản hoá" tỉ lệ thành một hằng số px cho gọn.
 * ========================================================================== */
const tplCus = TextTemplates.byId('custom');
assert.ok(tplCus, 'phải có mẫu "custom"');
const cusArtLayer = tplCus.layers.find((l) => l.kind === 'image');
assert.ok(cusArtLayer, 'mẫu "custom" phải có một lớp kind:"image"');

// Dựng layout của mẫu ở MỘT kiểu / MỘT chuỗi / MỘT cỡ chữ.
function cusLayout(variant, texts, fontSize, opts) {
    const ov = { art: { variant } };
    if (fontSize) ov.text = { font_size: fontSize };
    const tpl = TextTemplates.resolve(tplCus, ov);
    const use = texts || TextTemplates.defaultTexts(tpl);
    const lay = TextTemplates.layout(fakeCtx(), tpl, use, 1, { ...FRAME, ...(opts || {}) });
    return { tpl, texts: use, lay, txt: lay.boxes[0], img: lay.boxes[1] };
}

// ---- C0) HỘP TRẮNG: có nền, chữ sẫm, đệm/bo góc theo chiều cao hộp --------
/* Người dùng báo "chữ không có nền trắng như thiết kế" — nền là MỘT PHẦN của thiết kế,
   không phải trang trí thêm: chính nó định nghĩa "chiều cao hộp" mà cạnh hình neo theo.
   Bỏ nền là mọi số đo của hình sai theo, nên khoá lại ở đây. */
const cusTextLayer = tplCus.layers.find((l) => l.kind === 'text');
assert.ok(cusTextLayer.bg, 'lớp chữ của "Custom" phải có nền');
assert.strictEqual(cusTextLayer.bg.color, '#ffffff', 'nền phải TRẮNG');
assert.ok(/^#([0-9a-f]{2})\1\1$/i.test(cusTextLayer.color) && parseInt(cusTextLayer.color.slice(1, 3), 16) < 90,
    `chữ phải SẪM để đọc được trên nền trắng, nhận ${cusTextLayer.color}`);
assert.strictEqual(cusTextLayer.bg.padXRel, 0.5, 'đệm ngang = nửa chiều cao hộp (hai dải "X/2" của bản vẽ)');
assert.ok(cusTextLayer.bg.radiusRel > 0, 'bo góc phải tính theo chiều cao hộp, không phải px cứng');

// ---- C1) Các đẳng thức của bản vẽ, ở mọi cỡ chữ và mọi số dòng ------------
/* `anchor(txt, img)` trả về điểm mà TÂM hình phải trùng, theo từng kiểu. */
const CUS_RULES = [
    {
        variant: 'icon',
        sizeRel: 1.0,
        where: 'TÂM hình đặt đúng GÓC TRÊN-TRÁI hộp',
        anchor: (txt) => [txt.x, txt.y],
    },
    {
        variant: 'illus',
        sizeRel: 1.41,
        where: 'canh giữa dọc, đè lên hộp 0.3·Y',
        anchor: (txt, img) => [txt.x + 0.3 * img.w - img.w / 2, txt.y + txt.h / 2],
    },
];
CUS_RULES.forEach(({ variant, sizeRel, where, anchor }) => {
    [
        ['một dòng ngắn', ['Ngắn']],
        ['hai dòng mặc định', null],
        ['ba dòng dài ngắn xen kẽ', ['A\nMột dòng dài hơn hẳn hai dòng kia\nBa']],
        ['tiếng Việt đủ dấu trên lẫn dưới', ['Đã duyệt\nrất tệ']],
    ].forEach(([why, texts]) => {
        [0, 32, 96].forEach((fontSize) => {
            const { txt, img, lay } = cusLayout(variant, texts, fontSize);
            const tag = `${variant} · ${why} · cỡ chữ ${fontSize || 'mặc định'}`;
            assert.ok(Math.abs(img.w - img.h) < 1e-6, `${tag}: hình phải VUÔNG (${img.w}×${img.h})`);
            /* Cạnh hình = sizeRel × chiều cao hộp MỘT DÒNG (`baseHeight`), KHÔNG phải chiều
               cao hộp thật — đổi 2026-09-16, xem measureImageLayer. Hộp một dòng là đúng ca
               mà bản vẽ được đo, nên mọi tỉ lệ thiết kế giữ nguyên ở ca đó; gõ thêm dòng thì
               hộp cao lên mà hình đứng yên (người dùng chốt: hình là vật thể có cỡ riêng). */
            const baseH = lay.measured[0].baseHeight;
            assert.ok(Math.abs(img.w - sizeRel * baseH) < 1e-6,
                `${tag}: cạnh hình phải = ${sizeRel}× chiều cao hộp MỘT DÒNG (${img.w} so với ${sizeRel * baseH})`);
            const [ax, ay] = anchor(txt, img);
            assert.ok(Math.abs((img.x + img.w / 2) - ax) < 1e-6,
                `${tag}: ${where} — tâm ngang ${img.x + img.w / 2} phải là ${ax}`);
            assert.ok(Math.abs((img.y + img.h / 2) - ay) < 1e-6,
                `${tag}: ${where} — tâm dọc ${img.y + img.h / 2} phải là ${ay}`);
            /* PHẦN ĐÈ KHÔNG ĐƯỢC CHẠM CHỮ: đó là lý do đệm ngang phải là H/2 chứ không
               phải một tỉ lệ của cỡ chữ — gõ thêm dòng là hộp cao lên, hình to theo, mà
               cột đệm theo cỡ chữ thì đứng yên và hình liếm vào chữ. */
            const inkLeft = txt.x + (cusLayout(variant, texts, fontSize).lay.measured[0].padX);
            assert.ok(img.x + img.w <= inkLeft + 1e-6,
                `${tag}: mép phải hình (${img.x + img.w}) không được vượt mép trái CHỮ (${inkLeft})`);
        });
    });
});

/* Hệ quả cần nói rõ: chiều cao hộp chữ tính theo DẢI CHỮ HOA nên dấu tiếng Việt tràn
   ra ngoài KHÔNG làm hình to nhỏ theo chuỗi — gõ "Đã duyệt" và "Da duyet" phải ra
   cùng một cỡ hình, nếu không mỗi lần sửa chữ là cả bố cục nhảy. */
assert.ok(Math.abs(cusLayout('icon', ['Đã duyệt']).img.w - cusLayout('icon', ['Da duyet']).img.w) < 1e-6,
    'dấu tiếng Việt không được làm đổi cỡ hình');

/* ĐỔI MỘT THUỘC TÍNH CHỮ BẤT KỲ KHÔNG ĐƯỢC LÀM MẤT HÌNH DẠNG HỘP. applyTextStyle dựng
   lại `bg` từ style, nên `padXRel`/`radiusRel` phải đi qua đường style — thiếu một khoá
   là chỉ cần đổi màu chữ thì cột đệm co về tỉ lệ mặc định và hình Icon đè lên chữ. */
const cusRecolour = TextTemplates.resolve(tplCus, { text: { color: '#112233' } });
const cusRecolourBg = cusRecolour.layers.find((l) => l.kind === 'text').bg;
assert.strictEqual(cusRecolourBg.padXRel, cusTextLayer.bg.padXRel, 'đổi màu chữ không được làm mất padXRel');
assert.strictEqual(cusRecolourBg.radiusRel, cusTextLayer.bg.radiusRel, 'đổi màu chữ không được làm mất radiusRel');
const cusRecolourLay = TextTemplates.layout(fakeCtx(), cusRecolour, TextTemplates.defaultTexts(tplCus), 1, FRAME);
assert.ok(Math.abs(cusRecolourLay.measured[0].padX / cusRecolourLay.boxes[0].h - 0.5) < 1e-6,
    'sau khi đổi màu chữ, đệm ngang vẫn phải là nửa chiều cao hộp');

// ---- C2) Lớp ảnh KHÔNG được rơi vào hộp chữ -------------------------------
/* Cạnh hình tính TỪ chiều cao hộp chữ, nên nếu nó cũng nằm trong hộp thì phép đo là
   một vòng tròn. layout() phải tự loại nó ra, kể cả khi template khai nhầm. */
assert.notStrictEqual(cusArtLayer.place, 'flow', 'lớp ảnh phải neo tương đối, không "flow"');
const cusWeird = { ...tplCus, layers: tplCus.layers.map((l) => (l.kind === 'image' ? { ...l, place: 'flow' } : l)) };
assert.doesNotThrow(
    () => TextTemplates.layout(fakeCtx(), cusWeird, TextTemplates.defaultTexts(cusWeird), 1, FRAME),
    'khai nhầm place:"flow" cho lớp ảnh không được làm vỡ phép đo',
);

// ---- C3) Panel đọc kiểu + tiền tố lọc TỪ TEMPLATE, không tự đoán ----------
/* Luật "đang là Icon thì không thả Illus vào được" ở panel Thuộc tính dựa HẲN vào
   `prefix` mà template khai ra qua editableLayers. Đổi/xoá nó là luật đó im lặng biến
   mất — panel sẽ nhận mọi tệp. */
const cusArtInfo = TextTemplates.editableLayers(tplCus).find((l) => l.kind === 'image');
assert.ok(cusArtInfo, 'editableLayers phải bày lớp ảnh ra cho panel Thuộc tính');
assert.deepStrictEqual(cusArtInfo.variants.map((v) => `${v.key}:${v.prefix}`), ['icon:[Icon]', 'illus:[Illus]'],
    'hai kiểu và tiền tố tên tệp của chúng phải do TEMPLATE khai');
assert.strictEqual(cusArtInfo.variant, 'icon', 'kiểu mặc định là Icon');

/* ---- C3b) CỠ HÌNH ĐỨNG YÊN KHI ĐỔI NỘI DUNG / KHỔ HỘP ---------------------
 * Người dùng chốt 2026-09-16: "Icon và Illus không thay đổi scale khi nội dung trong box
 * thay đổi hoặc khi kích thước của textbox thay đổi — chỉ giữ vị trí tương đối".
 * Trước đó cạnh hình = 1.41 × chiều cao hộp THẬT, nên gõ thêm một dòng là hình phình theo:
 * trên dự án thật ("Yêu Con 1") bốn cụm cùng kiểu ra bốn cỡ hình khác nhau. */
{
    // Cỡ chữ CHỐT (đúng như block do người dùng tạo ra) rồi đổi nội dung đủ kiểu.
    const sides = [
        ['một dòng ngắn', ['chất đạm']],
        ['một dòng dài', ['vitamin và khoáng chất']],
        ['hai dòng', ['Dòng một ở đây\nDòng hai ở đây']],
        ['bốn dòng', ['Một\nHai\nBa\nBốn']],
    ].map(([why, texts]) => {
        const { txt, img } = cusLayout('illus', texts, 34.4);
        return { why, side: img.w, boxW: txt.w, boxH: txt.h };
    });
    const side0 = sides[0].side;
    sides.forEach((s) => {
        assert.ok(Math.abs(s.side - side0) < 1e-6,
            `cỡ hình phải ĐỨNG YÊN khi đổi nội dung — "${s.why}" ra ${s.side}, mong ${side0}`);
    });
    // …trong khi HỘP CHỮ thì phải nở/co theo nội dung (yêu cầu 4: chỉ hộp đổi, chữ thì không).
    assert.ok(sides[1].boxW > sides[0].boxW, 'chữ dài hơn -> hộp phải RỘNG ra');
    assert.ok(sides[3].boxH > sides[0].boxH, 'nhiều dòng hơn -> hộp phải CAO lên');

    /* VỊ TRÍ TƯƠNG ĐỐI vẫn giữ đúng thiết kế ở mọi khổ hộp: Illus canh giữa dọc hộp và đè
       lên hộp đúng 0.3·Y. Đây là nửa còn lại của yêu cầu — cỡ đứng yên, chỗ đặt thì bám. */
    [['một dòng', ['A']], ['bốn dòng', ['Một\nHai\nBa\nBốn']]].forEach(([why, texts]) => {
        const { txt, img } = cusLayout('illus', texts, 34.4);
        assert.ok(Math.abs((img.y + img.h / 2) - (txt.y + txt.h / 2)) < 1e-6,
            `${why}: hình vẫn phải canh giữa dọc theo HỘP`);
        assert.ok(Math.abs((img.x + img.w) - (txt.x + 0.3 * img.w)) < 1e-6,
            `${why}: mép phải hình vẫn đè lên hộp đúng 0.3·Y`);
    });
}

/* ---- C3c) NGƯỜI DÙNG CHỈNH CỠ / CHỖ ĐẶT CỦA HÌNH -------------------------
 * Ba khoá override thêm 2026-09-16 (`scale`, `dx`, `dy`) — yêu cầu "cho phép thay đổi
 * kích thước và vị trí của Icon/Illus trong bảng thông số so với mặc định lúc tạo". */
{
    const base = cusLayout('illus', ['chất đạm'], 34.4);
    const big = (() => {
        const tpl = TextTemplates.resolve(tplCus, { art: { variant: 'illus', scale: 150 }, text: { font_size: 34.4 } });
        const lay = TextTemplates.layout(fakeCtx(), tpl, ['chất đạm'], 1, FRAME);
        return { txt: lay.boxes[0], img: lay.boxes[1] };
    })();
    assert.ok(Math.abs(big.img.w - base.img.w * 1.5) < 1e-6,
        `scale 150% phải cho cạnh gấp rưỡi (${big.img.w} so với ${base.img.w * 1.5})`);
    // Hộp CHỮ không được đổi vì người dùng phóng hình — hình là lớp neo, không nằm trong hộp.
    assert.ok(Math.abs(big.txt.w - base.txt.w) < 1e-6 && Math.abs(big.txt.h - base.txt.h) < 1e-6,
        'phóng hình KHÔNG được làm đổi hộp chữ');

    const moved = (() => {
        const tpl = TextTemplates.resolve(tplCus, { art: { variant: 'illus', dx: -20, dy: 8 }, text: { font_size: 34.4 } });
        const lay = TextTemplates.layout(fakeCtx(), tpl, ['chất đạm'], 1, FRAME);
        return { txt: lay.boxes[0], img: lay.boxes[1] };
    })();
    /* So bằng KHOẢNG CÁCH hình→hộp, không so toạ độ tuyệt đối: hộp tĩnh được chuẩn hoá về
       góc trên-trái của HỢP mọi lớp, nên đẩy hình sang trái là cả cụm dịch theo. */
    const relBase = [base.img.x - base.txt.x, base.img.y - base.txt.y];
    const relMoved = [moved.img.x - moved.txt.x, moved.img.y - moved.txt.y];
    assert.ok(Math.abs((relMoved[0] - relBase[0]) - (-20)) < 1e-6,
        `dx phải đẩy hình sang trái 20px so với hộp (được ${relMoved[0] - relBase[0]})`);
    assert.ok(Math.abs((relMoved[1] - relBase[1]) - 8) < 1e-6,
        `dy phải đẩy hình xuống 8px so với hộp (được ${relMoved[1] - relBase[1]})`);

    // Cỡ bị KẸP trần/sàn: gõ 0 hay 99999 không được làm hình biến mất hay trùm cả khung.
    const artOf = (ov) => TextTemplates.resolve(tplCus, { art: ov }).layers.find((l) => l.kind === 'image');
    assert.strictEqual(artOf({ scale: 99999 }).artScale, 400, 'cỡ hình bị kẹp trần 400%');
    assert.strictEqual(artOf({ scale: 1 }).artScale, 10, 'cỡ hình bị kẹp sàn 10%');
    assert.strictEqual(artOf({ scale: 0 }).artScale, 100, 'cỡ 0 / rác -> về đúng thiết kế');

    // Engine phải BÀY ra ba khoá này cho panel, kèm trần/sàn (UI không tự đặt số).
    const info = TextTemplates.editableLayers(tplCus).find((l) => l.kind === 'image');
    assert.strictEqual(info.scale, 100, 'mặc định = 100% (đúng thiết kế)');
    assert.strictEqual(info.dx, 0);
    assert.strictEqual(info.dy, 0);
    assert.strictEqual(info.scaleMin, 10);
    assert.strictEqual(info.scaleMax, 400);
    const dflt = TextTemplates.defaultOverrides(tplCus).art;
    assert.ok('scale' in dflt && 'dx' in dflt && 'dy' in dflt, 'defaultOverrides phải có đủ ba khoá mới');
}

// ---- C4) override của lớp ảnh chỉ đụng được ĐÚNG SÁU khoá -----------------
const cusBad = TextTemplates.resolve(tplCus, {
    art: { variant: 'khong-ton-tai', src: 'x.png', name: 'x', place: { fx: 9 }, variants: {}, anim: null },
});
const cusBadArt = cusBad.layers.find((l) => l.kind === 'image');
assert.strictEqual(cusBadArt.variant, 'icon', 'kiểu lạ bị bỏ qua, giữ kiểu của thiết kế');
assert.deepStrictEqual(cusBadArt.place, cusArtLayer.place, 'override KHÔNG được ghi đè `place`');
assert.deepStrictEqual(Object.keys(cusBadArt.variants), ['icon', 'illus'], 'override KHÔNG được ghi đè `variants`');
assert.ok(cusBadArt.anim && cusBadArt.anim.tracks, 'override KHÔNG được ghi đè `anim`');
assert.strictEqual(cusBadArt.src, 'x.png', 'nhưng `src` thì phải nhận');

// ---- C5) Ảnh thật được vẽ đúng hộp; chưa có ảnh thì vẽ ô giữ chỗ ----------
function cusImageProbe() {
    const base = translateProbe();
    const drawn = [];
    let strokes = 0;
    return Object.assign(base, {
        drawn,
        strokeCount: () => strokes,
        setLineDash() {},
        stroke() { strokes += 1; },
        drawImage(im, x, y, w, h) { drawn.push({ im, x, y, w, h }); },
    });
}
const CUS_FAKE_IMG = { tag: 'anh-gia' };
const cusWithImg = cusLayout('icon', null, 0, { imageFor: () => CUS_FAKE_IMG });
const cusSettle = TextTemplates.settleTime(tplCus, cusWithImg.texts);
const cusProbe = cusImageProbe();
TextTemplates.drawFrame(cusProbe, cusWithImg.tpl, cusWithImg.texts, cusSettle, cusWithImg.lay);
assert.strictEqual(cusProbe.drawn.length, 1, 'đúng MỘT lần drawImage cho lớp ảnh');
assert.strictEqual(cusProbe.drawn[0].im, CUS_FAKE_IMG, 'phải vẽ đúng ảnh mà caller đưa qua opts.imageFor');
assert.ok(Math.abs(cusProbe.drawn[0].w - cusWithImg.img.w) < 1e-6 && Math.abs(cusProbe.drawn[0].h - cusWithImg.img.h) < 1e-6,
    'ảnh phải lấp ĐÚNG hộp vuông của lớp (ép vào hộp, không giữ tỉ lệ riêng của tệp)');
assert.ok(Math.abs(cusProbe.drawn[0].x + cusProbe.drawn[0].w / 2) < 1e-6
    && Math.abs(cusProbe.drawn[0].y + cusProbe.drawn[0].h / 2) < 1e-6,
    'ảnh phải canh quanh gốc (ctx đã được dời về TÂM hộp) — lệch là mọi phép xoay/phóng sai tâm');
const cusNoImg = cusImageProbe();
TextTemplates.drawFrame(cusNoImg, cusWithImg.tpl, cusWithImg.texts, cusSettle, cusLayout('icon').lay);
assert.strictEqual(cusNoImg.drawn.length, 0, 'không có imageFor -> KHÔNG được gọi drawImage');
assert.ok(cusNoImg.strokeCount() > 0, 'thay vào đó phải vẽ Ô GIỮ CHỖ (nét đứt), không để trống câm lặng');

// ---- C6) Popup + lắc xoay 30° giảm dần ------------------------------------
const cusRot = cusArtLayer.anim.tracks.rot;
const cusScale = cusArtLayer.anim.tracks.scale;
assert.strictEqual(cusRot[0][1], 30, 'lắc bắt đầu ở 30°');
assert.strictEqual(cusRot[cusRot.length - 1][1], 0,
    'KEYFRAME CUỐI phải đúng 0: hàm mũ chỉ tiệm cận, thiếu điểm chốt thì stateIsRest '
    + 'không bao giờ đúng -> settleTime hết chỗ dừng và khâu xuất không gộp được khung nào');
assert.strictEqual(cusScale[0][1], 0, 'popup: bắt đầu từ 0');
assert.strictEqual(cusScale[cusScale.length - 1][1], 1, 'popup: chốt đúng 1');
assert.ok(Math.max(...cusScale.map((kf) => kf[1])) > 1.05, 'popup phải VỌT QUÁ 1 (nảy), không chỉ phình ra');
/* Phải LẮC QUA LẠI chứ không phải xoay một mạch về 0, và biên độ mỗi nhịp phải NHỎ
   DẦN — đó là toàn bộ nội dung của "dao động lắc giảm dần". */
let cusSignFlips = 0;
for (let i = 1; i < cusRot.length; i += 1) {
    if (cusRot[i][1] !== 0 && cusRot[i - 1][1] !== 0 && Math.sign(cusRot[i][1]) !== Math.sign(cusRot[i - 1][1])) cusSignFlips += 1;
}
assert.ok(cusSignFlips >= 3, `phải đổi chiều ít nhất 3 lần (lắc), nhận ${cusSignFlips}`);
const cusPeaks = [];
for (let i = 1; i < cusRot.length - 1; i += 1) {
    const [a, b, c] = [Math.abs(cusRot[i - 1][1]), Math.abs(cusRot[i][1]), Math.abs(cusRot[i + 1][1])];
    if (b >= a && b >= c && b > 0.05) cusPeaks.push(b);
}
assert.ok(cusPeaks.length >= 3, `phải có ít nhất 3 đỉnh lắc, nhận ${cusPeaks.length}`);
cusPeaks.forEach((v, i) => {
    if (i) assert.ok(v < cusPeaks[i - 1], `biên độ phải GIẢM dần (đỉnh ${i}: ${v} không nhỏ hơn ${cusPeaks[i - 1]})`);
});

// ---- C7) Mẫu vẫn có mốc NGHỈ nằm trong block ------------------------------
assert.ok(cusSettle > 0 && cusSettle < tplCus.duration, `settleTime phải nằm trong block, nhận ${cusSettle}`);
const cusRest = TextTemplates.layerStateAt(cusArtLayer, cusSettle);
assert.ok(Math.abs(cusRest.rot) < 0.01 && Math.abs(cusRest.scale - 1) < 0.01,
    'ở mốc nghỉ hình phải đứng thẳng và đúng cỡ — đây là khung thumbnail của panel');
/* Ngược lại, ĐANG lắc thì chữ ký khung phải ĐỔI, nếu không khâu xuất đẩy `null`
   ("lặp khung trước") giữa lúc hình đang xoay và bản xuất đứng hình. */
assert.notStrictEqual(
    TextTemplates.frameSignature(tplCus, 0.20, cusWithImg.texts),
    TextTemplates.frameSignature(tplCus, 0.25, cusWithImg.texts),
    'hai khung giữa cú lắc phải có chữ ký khác nhau',
);

// ---- C8) Lề canvas chứa trọn cú nảy + lắc ---------------------------------
/* Hình nằm sát mép TRÁI hộp tĩnh, lại vừa phóng quá cỡ vừa xoay — thiếu lề là góc hình
   bị xén, và vì preview cũng dùng chính lề này nên lỗi lộ ra ở CẢ hai nơi cùng lúc,
   tức không ai phát hiện bằng cách so preview với bản xuất. */
const cusIconLay = cusLayout('icon');
let cusNeed = 0;
for (let t = 0; t <= tplCus.duration; t += 1 / 120) {
    const st = TextTemplates.layerStateAt(cusArtLayer, t);
    if (st.hidden || st.opacity <= 0.002) continue;
    const half = (cusIconLay.img.w / 2) * st.scale;
    const rad = (st.rot || 0) * Math.PI / 180;
    cusNeed = Math.max(cusNeed, half * (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad))) - cusIconLay.img.w / 2);
}
assert.ok(cusNeed > 4, 'cú nảy+lắc phải thật sự tràn ra ngoài hộp tĩnh (nếu không, phép kiểm dưới đây vô nghĩa)');
assert.ok(cusIconLay.lay.marginX + 1e-6 >= cusNeed,
    `lề ngang ${cusIconLay.lay.marginX} phải phủ hết phần tràn ${cusNeed.toFixed(2)}px của hình`);

// ---- C9) TỰ CO CHO VỪA KHỔ (`fitWidth`) -----------------------------------
/* LỖI ĐƯỢC CHẶN Ở ĐÂY: cỡ chữ của "Custom" từng là con số CHẾT 48, chọn vừa cho đúng
   câu mặc định hai dòng. Đổi một mẫu bất kỳ sang Custom là chữ NGẮN theo sang, và vì
   cạnh hình Icon/Illus lấy từ chiều cao hộp chữ nên cả cụm teo còn ~1/4 các mẫu khác
   (đo được: 290×94 so với 802×570 của "Mood Matcha") — người dùng phải phóng block lên
   mới đọc nổi. Nay cỡ trong layer là CỠ TỐI ĐA và layout co đều cả mẫu cho vừa
   `fitWidth`. Ba thứ phải giữ:                                                       */
assert.ok(tplCus.fitWidth > 0, 'mẫu "custom" phải khai fitWidth');
const cusMaxSize = tplCus.layers.find((l) => l.kind === 'text').font.size;

// 1) Chữ DÀI: co lại cho vừa ngân sách, không bao giờ tràn.
['icon', 'illus'].forEach((variant) => {
    const long = cusLayout(variant, ['During routine testing.\nThe affected components include.']);
    assert.ok(long.lay.width <= tplCus.fitWidth + 1,
        `${variant}: chữ dài phải co về <= fitWidth, nhận ${long.lay.width.toFixed(1)}`);
    assert.ok(long.lay.scale < 1, `${variant}: chữ dài thì phải THỰC SỰ co (scale ${long.lay.scale})`);
});

// 2) Chữ NGẮN: giữ nguyên cỡ tối đa, KHÔNG phình ra cho đầy ngân sách.
const cusTiny = cusLayout('icon', ['Ngắn']);
assert.strictEqual(cusTiny.lay.scale, 1, 'chữ ngắn còn nằm trong ngân sách thì không được co');
assert.ok(cusTiny.lay.width < tplCus.fitWidth,
    'chữ ngắn phải GIỮ cỡ tối đa chứ không giãn ra cho đầy khổ');
const cusShort = cusLayout('icon', ['Mood\nMatcha']);
/* Và cụm ấy phải ngang tầm các mẫu đo từ video — đây chính là con số người dùng báo sai.
   Lấy "Mood Matcha" làm mốc vì đó là mẫu trong ảnh chụp của báo lỗi. */
const cusRefLay = TextTemplates.layout(fakeCtx(), TextTemplates.byId('mood-matcha'), ['Mood\nMatcha'], 1, FRAME);
assert.ok(cusShort.lay.height > cusRefLay.height * 0.3,
    `cụm Custom (cao ${cusShort.lay.height.toFixed(0)}) không được teo so với mẫu khác `
    + `(cao ${cusRefLay.height.toFixed(0)})`);

// 3) NGÂN SÁCH THEO px@1080, KHÔNG THEO opts.frameW. Thumbnail của panel gọi layout với
//    frameW = bề ngang ô 120px; đọc ngân sách từ đó là mẫu co về vài chục px rồi drawThumb
//    phóng ngược lên — hai phép triệt tiêu nhau, ô xem trước ra sai cỡ.
const cusThumb = cusLayout('icon', null, null, { frameW: 120, frameH: 68 });
const cusFrame = cusLayout('icon');
assert.ok(Math.abs(cusThumb.lay.width - cusFrame.lay.width) < 0.01,
    'hệ số co phải độc lập với khung truyền vào (preview / bản xuất / thumbnail cùng bố cục)');

// 4) Hệ số co nhân ĐỀU với k, để px_scale (độ phân giải Sequence) vẫn là một phép nhân.
const cusK2 = TextTemplates.layout(fakeCtx(), tplCus, TextTemplates.defaultTexts(tplCus), 2, FRAME);
assert.ok(Math.abs(cusK2.width - cusFrame.lay.width * 2) < 0.02,
    'layout ở k=2 phải rộng gấp đôi k=1 — nếu không, đổi độ phân giải là bố cục đổi theo');
assert.ok(cusMaxSize * cusFrame.lay.scale < cusMaxSize,
    'câu mặc định phải rơi vào nhánh co (nếu không, mọi phép kiểm trên là vô nghĩa)');

// 5) NGƯỜI DÙNG GÕ CỠ CHỮ -> tắt phép co, con số trong ô "Cỡ chữ" là con số được vẽ.
const cusTyped = cusLayout('icon', null, 90);
assert.strictEqual(cusTyped.lay.scale, 1, 'có override font_size thì KHÔNG được tự co nữa');
assert.ok(cusTyped.lay.width > tplCus.fitWidth,
    'gõ cỡ to là chấp nhận tràn khổ — đó là lựa chọn của người dùng, không phải lỗi');
/* Và cỡ 90 phải cho hộp to hơn hẳn cỡ tự co (~40) — tức lệnh của người dùng có tác dụng
   thật, chứ không bị phép co kéo về cùng một kết quả dù gõ số nào. */
assert.ok(cusTyped.lay.height > cusFrame.lay.height * 1.5,
    'cỡ chữ người dùng gõ phải thực sự đổi hộp');

/* ==========================================================================
 * MẪU "VLOG TAG" — hộp chữ trắng + HAI THẺ VÀNG nấp sau, phóng ra lần lượt
 *
 * SỐ THAM CHIẾU (video Text Template-Vlog Tag.mp4, 1080×1920 30fps, block = khung 12..101):
 *   hộp trắng  x 120..963, y 776..1140 (844×365), góc vuông
 *   chữ       3 dòng, mực 750 / 672 / 476, baseline 884.5 / 983.5 / 1082.5 (bước 99)
 *             dải chữ hoa 70, ascender 75; đệm nền 47 ngang, 39 trên, 58 dưới
 *   thẻ lớn   x 90..939,  y 751..1035 (850×285)
 *   thẻ nhỏ   x 834..987, y 1042..1167 (154×126)
 *   thẻ lớn hiện ra từ khung 20 (hệ số 0.859) và xong ở 29; thẻ nhỏ lệch pha 16 khung
 * ======================================================================= */

/* Thước đo Open Sans 600 ở size 97.5 / letter 0.228, lấy từ canvas của Chrome rồi
   đóng băng. Ba dòng mẫu + 'H'; chuỗi lạ suy theo số ký tự của dòng 1. */
const OS = {
    size: 97.5,
    H: { w: 73.50, L: -8, R: 65, A: 70, D: 0 },
    rows: {
        'Butterflies taste': { w: 761.40, L: -8, R: 758.00, A: 75, D: 1 },
        'with their feet': { w: 673.40, L: 0, R: 671.61, A: 75, D: 1 },
        amazingly: { w: 477.36, L: -4, R: 477.96, A: 74, D: 23 },
    },
};
function fakeCtxOpenSans() {
    let font = '';
    const rel = () => (Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]) || OS.size) / OS.size;
    const box = (r, k) => ({
        width: r.w * k, actualBoundingBoxLeft: r.L * k, actualBoundingBoxRight: r.R * k,
        actualBoundingBoxAscent: r.A * k, actualBoundingBoxDescent: r.D * k,
    });
    return {
        set font(v) { font = v; }, get font() { return font; },
        letterSpacing: '0px', save() {}, restore() {},
        measureText(text) {
            const k = rel();
            const t = String(text);
            if (t === 'H') return box(OS.H, k);
            if (OS.rows[t]) return box(OS.rows[t], k);
            const per = 750 / 'Butterflies taste'.length;
            const w = Math.max(1, t.length) * per;
            // Chuỗi có dấu tiếng Việt: mực tràn cao hơn ascender, đúng thứ hộp phải chịu.
            const A = /[ãàáảâêôơưđ]/i.test(t) ? 85 : 75;
            const D = /[ệẹịọụạgjpqy]/i.test(t) ? 23 : 1;
            return box({ w, L: 0, R: w, A, D }, k);
        },
    };
}

const tplV = TextTemplates.byId('vlog-tag');
assert.ok(tplV, 'phải có mẫu "vlog-tag"');
assert.strictEqual(tplV.duration, 3.0, 'Vlog Tag: 3.00s (90 khung @30fps, block 12..101)');
assert.deepStrictEqual(TextTemplates.defaultTexts(tplV), ['Butterflies taste\nwith their feet\namazingly'],
    'MỘT ô nội dung, ba dòng ngăn nhau bằng ký tự xuống dòng');
/* Hai thẻ khai TRƯỚC lớp chữ = vẽ trước = nằm SAU hộp trắng. Đảo thứ tự là thẻ đè
   lên chữ và cả mẫu mất ý nghĩa (không còn hai dải chữ L). */
assert.deepStrictEqual(tplV.layers.map((l) => l.kind), ['glyph', 'glyph', 'text'],
    'hai thẻ phải khai trước lớp chữ để nằm sau hộp trắng');

// ---- V1) Hình học: hộp trắng + hai thẻ đúng số đo video --------------------
const textsV = TextTemplates.defaultTexts(tplV);
const layV = TextTemplates.layout(fakeCtxOpenSans(), tplV, textsV, 1, FRAME);
const [vBig, vSmall, vText] = layV.boxes;
const measV = layV.measured[2];
assert.strictEqual(measV.lines.length, 3, 'ô nội dung tự tách thành ba dòng');
assert.ok(Math.abs(measV.capHeight - 70) < 0.01, 'dải chữ hoa 70');
assert.ok(Math.abs(measV.lineStep - 99) < 0.01, `hai baseline cách đúng 99px, nhận ${measV.lineStep}`);
assert.ok(Math.abs(vText.w - 844) < 0.5, `hộp trắng rộng 844 (750 + 2×47), nhận ${vText.w}`);
assert.ok(Math.abs(vText.h - 365) < 0.01, `hộp trắng cao 365 (39 + 70 + 2×99 + 58), nhận ${vText.h}`);
assert.ok(Math.abs(measV.baseline0 - 109) < 0.01,
    `baseline dòng 1 nằm 109px dưới mép trên hộp (776 -> 885), nhận ${measV.baseline0}`);
assert.ok(Math.abs(measV.padTop - 39) < 0.01 && Math.abs(measV.padBottom - 58) < 0.01,
    'đệm nền trên 39 / dưới 58 (không cân đối — phần dưới chứa nét thả)');
/* Nét thả của 'g','y' (23px) nằm GỌN trong đệm dưới 58 -> không có gì tràn ra ngoài hộp. */
assert.strictEqual(measV.overBottom, 0, 'nét thả nằm trong đệm nền dưới');

assert.ok(Math.abs(vBig.w - 850) < 0.01 && Math.abs(vBig.h - 285.1) < 0.2,
    `thẻ lớn 850×285, nhận ${vBig.w.toFixed(1)}×${vBig.h.toFixed(1)}`);
assert.ok(Math.abs(vSmall.w - 154) < 0.2 && Math.abs(vSmall.h - 126) < 0.2,
    `thẻ nhỏ 154×126, nhận ${vSmall.w.toFixed(1)}×${vSmall.h.toFixed(1)}`);
assert.ok(Math.abs((vText.x - vBig.x) - 30) < 0.01 && Math.abs((vText.y - vBig.y) - 25) < 0.01,
    'góc trên-trái thẻ lớn lệch ra ngoài hộp chữ đúng (−30, −25)');
assert.ok(Math.abs((vSmall.x + vSmall.w) - (vText.x + vText.w) - 24) < 0.2
    && Math.abs((vSmall.y + vSmall.h) - (vText.y + vText.h) - 27) < 0.2,
    'góc dưới-phải thẻ nhỏ lệch ra ngoài hộp chữ đúng (+24, +27)');
assert.ok(Math.abs(layV.width - 898) < 0.5 && Math.abs(layV.height - 417) < 0.5,
    `hộp tĩnh cả nhóm 898×417 (x 90..987, y 751..1167 trên video), nhận ${layV.width.toFixed(1)}×${layV.height.toFixed(1)}`);

// ---- V2) `fit`: cạnh thẻ LẤY TỪ HỘP CHỮ, không phải số px cố định ------
/* Đây là cả lý do `fit` tồn tại: người dùng gõ chuỗi khác thì thẻ phải trùm đúng
   khổ chữ mới. Viết px cố định thì chỉ đúng với đúng chuỗi mẫu. */
const layV2 = TextTemplates.layout(fakeCtxOpenSans(), tplV, ['Một dòng'], 1, FRAME);
const [bBig, bSmall, bText] = layV2.boxes;
assert.ok(bText.w < vText.w && bText.h < vText.h, 'chuỗi ngắn hơn -> hộp chữ nhỏ hơn');
assert.ok(Math.abs(bBig.w - (bText.w + 6)) < 0.01, 'thẻ lớn luôn rộng bằng hộp chữ + 6');
assert.ok(Math.abs(bBig.h - bText.h * 0.781) < 0.01, 'thẻ lớn luôn cao 0.781 hộp chữ');
assert.ok(Math.abs(bSmall.w - bText.w * 0.1825) < 0.01 && Math.abs(bSmall.h - bText.h * 0.3452) < 0.01,
    'thẻ nhỏ luôn theo tỉ lệ hộp chữ');
assert.ok(Math.abs((bText.x - bBig.x) - 30) < 0.01, 'khoảng lệch góc KHÔNG đổi theo chuỗi');
// Hệ số k nhân tuyến tính cả phần `fit` (fw/fh nhân vào hộp đã quy đổi, dw/dh ở lớp 1080).
const layV3 = TextTemplates.layout(fakeCtxOpenSans(), tplV, textsV, 2, { frameW: 2160, frameH: 3840 });
assert.ok(Math.abs(layV3.boxes[0].w - vBig.w * 2) < 0.02 && Math.abs(layV3.boxes[1].h - vSmall.h * 2) < 0.02,
    'k=2 -> cả hai thẻ gấp đôi');
/* LỚP `fit` KHÔNG ĐƯỢC RƠI VÀO HỘP CHỮ: cạnh của nó lấy từ hộp, cho vào hộp là vòng tròn.
   Khai nhầm `place:'flow'` thì layout phải ÂM THẦM bỏ qua, không được làm vỡ phép đo. */
const tplVFlow = {
    ...tplV,
    layers: tplV.layers.map((l, i) => (i === 0 ? { ...l, place: 'flow' } : l)),
};
const layVFlow = TextTemplates.layout(fakeCtxOpenSans(), tplVFlow, textsV, 1, FRAME);
assert.ok(Math.abs(layVFlow.boxes[2].w - vText.w) < 0.01 && Math.abs(layVFlow.boxes[2].h - vText.h) < 0.01,
    'khai nhầm place:flow cho lớp `fit` không được làm hộp chữ phình ra');
assert.ok(Number.isFinite(layVFlow.boxes[0].w) && layVFlow.boxes[0].w > 0, 'lớp `fit` vẫn được đo');

// ---- V3) Đường thời gian -------------------------------------------------
const atV = (layer, frame) => TextTemplates.layerStateAt(layer, (frame - 12) / 30);
/* CHỮ KHÔNG CÓ HOẠT ẢNH: video cho thấy hộp trắng + chữ hiện nguyên hình ở khung 12 và
   đứng yên tới hết (số pixel mực y hệt nhau từng khung). */
assert.ok(!tplV.layers[2].anim, 'lớp chữ KHÔNG được mang hoạt ảnh');
[12, 20, 50, 101].forEach((f) => {
    const st = atV(tplV.layers[2], f);
    assert.ok(!st.hidden && st.opacity === 1 && st.scale === 1,
        `chữ phải đứng yên ở khung ${f}`);
});
/* HAI THẺ CHẠY HAI ĐƯỜNG KHÁC NHAU — đã thử ép chung một đường và không khớp: lệch
   pha giữa hai thẻ đi ra 14 khung ở đoạn đầu nhưng 18 khung ở đoạn cuối. Thẻ lớn xong
   ở khung 29, thẻ nhỏ mãi khung 47. */
assert.notStrictEqual(tplV.layers[0].anim.tracks.scale, tplV.layers[1].anim.tracks.scale,
    'hai thẻ phải giữ HAI đường đo được riêng, không ép chung một');
// Thẻ lớn: hệ số phóng đo trên bề rộng dải vàng thò ra khỏi mép trên hộp trắng.
[[20, 0.859], [24, 0.953], [27, 0.991], [29, 1]].forEach(([f, want]) => {
    const got = atV(tplV.layers[0], f).scale;
    assert.ok(Math.abs(got - want) < 0.01, `thẻ lớn khung ${f}: hệ số ${want} (nhận ${got.toFixed(3)})`);
});
// Thẻ nhỏ: đo trên độ sâu của dải vàng dưới đáy hộp trắng.
[[25, 0.61], [30, 0.77], [35, 0.90], [40, 0.96], [47, 1]].forEach(([f, want]) => {
    const got = atV(tplV.layers[1], f).scale;
    assert.ok(Math.abs(got - want) < 0.01, `thẻ nhỏ khung ${f}: hệ số ${want} (nhận ${got.toFixed(3)})`);
});
/* CẢ HAI CŨNG MỜ DẦN VÀO: màu ở LÕI dải vàng (cách mép 3px — lấy trung vị cả dải thì
   toàn pixel mép, ra "mờ" giả) đi từ (151,122,40) ở khung 30 lên (255,215,68) ở khung 47.
   Bỏ phần này là thẻ bật ra đột ngột đục màu thay vì lộ dần. */
[[20, 0.71], [24, 0.91], [29, 1]].forEach(([f, want]) => {
    const got = atV(tplV.layers[0], f).opacity;
    assert.ok(Math.abs(got - want) < 0.01, `thẻ lớn khung ${f}: độ mờ ${want} (nhận ${got.toFixed(3)})`);
});
[[25, 0.28], [35, 0.75], [40, 0.89], [47, 1]].forEach(([f, want]) => {
    const got = atV(tplV.layers[1], f).opacity;
    assert.ok(Math.abs(got - want) < 0.01, `thẻ nhỏ khung ${f}: độ mờ ${want} (nhận ${got.toFixed(3)})`);
});
assert.ok(Math.abs(atV(tplV.layers[0], 101).scale - 1) < 1e-9
    && Math.abs(atV(tplV.layers[1], 101).scale - 1) < 1e-9,
    'tới cuối block cả hai thẻ đứng yên (không có hoạt ảnh ra)');

/* ĐOẠN ĐẦU CỦA PHÉP PHÓNG PHẢI NẰM TRỌN SAU HỘP TRẮNG — video không thấy gì cho
   tới khung 20, và đó cũng là lý do đoạn đầu được nối bằng ngoại suy thay vì số đo.
   Kiểm bằng chính hình học: hộp thẻ ở khung 19 phải nằm gọn trong hộp trắng, khung 20
   thì đã thò lên trên. */
const cardRect = (box, sc) => ({
    x0: box.x + box.w / 2 - (box.w * sc) / 2, y0: box.y + box.h / 2 - (box.h * sc) / 2,
    x1: box.x + box.w / 2 + (box.w * sc) / 2, y1: box.y + box.h / 2 + (box.h * sc) / 2,
});
const inside = (r, b) => r.x0 >= b.x - 0.01 && r.y0 >= b.y - 0.01
    && r.x1 <= b.x + b.w + 0.01 && r.y1 <= b.y + b.h + 0.01;
assert.ok(inside(cardRect(vBig, atV(tplV.layers[0], 19).scale), vText),
    'khung 19: thẻ lớn còn nấp trọn sau hộp trắng (video chưa thấy gì)');
assert.ok(!inside(cardRect(vBig, atV(tplV.layers[0], 20).scale), vText),
    'khung 20: thẻ lớn bắt đầu thò ra (video thấy vệt vàng đầu tiên)');
assert.ok(inside(cardRect(vSmall, atV(tplV.layers[1], 24).scale), vText),
    'khung 24: thẻ nhỏ còn nấp sau hộp trắng');
assert.ok(!inside(cardRect(vSmall, atV(tplV.layers[1], 25).scale), vText),
    'khung 25: thẻ nhỏ thò ra (video thấy vệt đầu tiên dưới đáy hộp)');

// ---- V4) Chữ ký khung & mốc đứng yên --------------------------------------
const sigV = (f) => TextTemplates.frameSignature(tplV, (f - 12) / 30, textsV);
assert.notStrictEqual(sigV(24), sigV(25), 'đang phóng -> chữ ký khác nhau từng khung');
assert.strictEqual(sigV(60), sigV(101), 'đã xong -> chữ ký trùng (khâu xuất gộp được khung)');
const settleV = TextTemplates.settleTime(tplV, textsV);
assert.ok(settleV >= 35 / 30 - 1e-9 && settleV < 1.6,
    `mốc đứng yên ${settleV.toFixed(3)}s phải ở sau khung 45, nhưng vẫn trong block`);
// Lề canvas: hai thẻ chỉ CO LẠI chứ không vượt hộp tĩnh -> không cần lề lớn.
assert.ok(layV.marginX <= 8 && layV.marginY <= 8,
    `lề canvas phải nhỏ (${layV.marginX}×${layV.marginY}) — không lớp nào vượt ra ngoài hộp tĩnh`);

// ---- V5) Thông số người dùng chỉnh được -----------------------------------
const editV = TextTemplates.editableLayers(tplV);
assert.deepStrictEqual(editV.map((l) => l.key), ['cardBack', 'cardFront', 'text']);
assert.deepStrictEqual(editV[0].colorKeys.map((c) => c.key), ['fill'], 'thẻ chỉ có MỘT mảng màu');
assert.strictEqual(editV[2].style.bg_enabled, true, 'style gốc của lớp chữ phải bật nền');
assert.strictEqual(editV[2].style.bg_color, '#ffffff');
assert.strictEqual(editV[2].style.color, '#000000');
assert.strictEqual(editV[2].style.font_family, 'Open Sans');
assert.strictEqual(editV[2].style.font_weight, 600);
// Đổi màu thẻ: không được làm mất `fit` hay hoạt ảnh, và thẻ kia giữ nguyên màu.
const ovV = TextTemplates.resolve(tplV, { cardBack: { fill: '#00b0ff' }, text: { color: '#222222' } });
assert.strictEqual(ovV.layers[0].colors.fill, '#00b0ff');
assert.strictEqual(ovV.layers[1].colors.fill, '#ffd744', 'thẻ không đổi thì giữ màu thiết kế');
assert.deepStrictEqual(ovV.layers[0].fit, tplV.layers[0].fit, 'trộn override KHÔNG được làm mất `fit`');
assert.strictEqual(ovV.layers[0].anim.tracks.scale, tplV.layers[0].anim.tracks.scale,
    'trộn override KHÔNG được làm mất hoạt ảnh phóng');
const layOvV = TextTemplates.layout(fakeCtxOpenSans(), ovV, textsV, 1, FRAME);
assert.ok(Math.abs(layOvV.boxes[0].w - vBig.w) < 0.01, 'đổi màu không làm thẻ đổi cỡ');
// Đổi cỡ chữ: hộp chữ nở ra thì hai thẻ nở theo (đúng điểm của `fit`).
const ovVBig = TextTemplates.resolve(tplV, { text: { font_size: OS.size * 2 } });
const layOvVBig = TextTemplates.layout(fakeCtxOpenSans(), ovVBig, textsV, 1, FRAME);
assert.ok(Math.abs(layOvVBig.boxes[0].w - (layOvVBig.boxes[2].w + 6)) < 0.01,
    'phóng cỡ chữ -> thẻ lớn vẫn rộng bằng hộp chữ + 6');

/* ==========================================================================
 * MẪU "WELCOME" — chữ bóng viền hai lớp bật TẮNG CHỮ + hai bông cúc + mũi tên cuốn
 *
 * SỐ THAM CHIẾU (video Text Template-Welcome.mp4, 1080×1920 30fps, block = khung 12..101):
 *   chữ    mực 728×154 tại x 176..903, dải chữ hoa 148 (870..1017), x-height 109
 *   màu    thân #ff6384, viền trong trắng 17, viền ngoài #febdbd 29, bóng xám lệch (8,10)
 *   hoa    cả cặp x 44..183 y 734..899 (140×166)
 *   tên    x 892..1020 y 979..1146 (129×168)
 *   chữ bật từ khung 13 lệch pha 1.33 khung; hoa và mũi tên bật từ khung 20
 * ======================================================================= */

/* Thước đo Smooch Sans 900 ở size 237.27 / letter 7.05, số liệu lấy từ canvas của Chrome
   rồi đóng băng. Có advance của TẪNG KÝ TỰ và của TIỀN TỐ vì lớp chạy theo ký tự. */
const SM = {
    size: 237.27,
    cap: 147,
    H: { w: 99.11, L: -4, R: 88, A: 147, D: 0 },
    word: { w: 737.63, L: 1, R: 727, A: 147, D: 2 },
    chars: {
        W: { w: 150.6, L: -1, R: 145, A: 147, D: 0 },
        e: { w: 88.9, L: 2, R: 84, A: 112, D: 2 },
        l: { w: 47.4, L: 2, R: 42, A: 147, D: 0 },
        c: { w: 85.3, L: 2, R: 81, A: 112, D: 2 },
        o: { w: 93.2, L: 2, R: 89, A: 112, D: 2 },
        m: { w: 143.5, L: 2, R: 139, A: 112, D: 0 },
    },
    pref: [0, 150.6, 239.5, 286.9, 372.2, 465.4, 608.9, 697.8],
};
function fakeCtxSmooch() {
    let font = '';
    const rel = () => (Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]) || SM.size) / SM.size;
    const box = (o, k) => ({
        width: o.w * k, actualBoundingBoxLeft: o.L * k, actualBoundingBoxRight: o.R * k,
        actualBoundingBoxAscent: o.A * k, actualBoundingBoxDescent: o.D * k,
    });
    return {
        set font(v) { font = v; }, get font() { return font; },
        letterSpacing: '0px', save() {}, restore() {},
        measureText(text) {
            const k = rel();
            const t = String(text);
            if (t === 'H') return box(SM.H, k);
            if (t === 'Welcome') return box(SM.word, k);
            if (t.length === 1 && SM.chars[t]) return box(SM.chars[t], k);
            if ('Welcome'.startsWith(t)) {
                const w = SM.pref[t.length];
                return box({ w, L: 1, R: w, A: 147, D: 2 }, k);
            }
            const n = Math.max(1, t.length) / 7;
            return box({ w: SM.word.w * n, L: 1, R: SM.word.R * n, A: 147, D: 2 }, k);
        },
    };
}

const tplW = TextTemplates.byId('welcome');
assert.ok(tplW, 'phải có mẫu "welcome"');
assert.strictEqual(tplW.duration, 3.0, 'Welcome: 3.00s (90 khung @30fps, block 12..101)');
assert.deepStrictEqual(TextTemplates.defaultTexts(tplW), ['Welcome']);
assert.deepStrictEqual(tplW.layers.map((l) => l.kind), ['glyph', 'glyph', 'text'],
    'hai hình trang trí khai TRƯỚC lớp chữ — gõ chuỗi dài thì chữ phải đè lên hình');

// ---- W1) Hình học: hộp chữ + chỗ đậu của hoa và mũi tên -------------------
const textsW = TextTemplates.defaultTexts(tplW);
const layW = TextTemplates.layout(fakeCtxSmooch(), tplW, textsW, 1, FRAME);
const [wFlower, wArrow, wText] = layW.boxes;
const measW = layW.measured[2];
assert.ok(Math.abs(measW.capHeight - 147) < 0.01, 'dải chữ hoa 147 (video 148)');
assert.ok(Math.abs(wText.w - 728) < 0.5, `hộp chữ rộng 728 (nhận ${wText.w.toFixed(1)})`);
assert.ok(Math.abs(wFlower.w - 140) < 0.5 && Math.abs(wFlower.h - 166) < 0.01,
    `cặp hoa 140×166 (nhận ${wFlower.w.toFixed(1)}×${wFlower.h.toFixed(1)})`);
assert.ok(Math.abs(wArrow.w - 129) < 0.5 && Math.abs(wArrow.h - 168) < 0.01,
    `mũi tên 129×168 (nhận ${wArrow.w.toFixed(1)}×${wArrow.h.toFixed(1)})`);
assert.ok(Math.abs((wText.x - wFlower.x) - 132) < 0.01 && Math.abs((wText.y - wFlower.y) - 136) < 0.01,
    'góc trên-trái cặp hoa lệch (−132, −136) so với góc trên-trái hộp chữ');
assert.ok(Math.abs(wArrow.x - (wText.x + wText.w) + 11) < 0.01
    && Math.abs(wArrow.y - wText.y - 109) < 0.01,
    'mũi tên đậu vào mép PHẢI hộp chữ: lùi trái 11, xuống 109');

// ---- W2) Màu và viền hai lớp ---------------------------------------------
const wStyle = TextTemplates.editableLayers(tplW)[2].style;
assert.strictEqual(wStyle.color, '#ff6384');
assert.strictEqual(wStyle.stroke_color, '#ffffff');
assert.ok(Math.abs(wStyle.stroke_width - 17) < 1e-9, 'viền TRONG (trắng) dày 17');
assert.strictEqual(wStyle.stroke2_color, '#febdbd');
assert.ok(Math.abs(wStyle.stroke2_width - 29) < 1e-9,
    'viền NGOÀI dày 29 — tính TỪ MỰC, nên phần hồng nhạt lộ ra đúng 29−17 = 12 như đo');
assert.ok(Math.abs(measW.overSide - 45) < 0.01,
    'lề canvas = vòng NGOÀI 29 + phần bóng tràn ra 16 (nhoè 6 + lệch 10) = 45; lấy nhầm vòng trong là vòng ngoài bị xén cụt ở mép canvas');
assert.strictEqual(wStyle.shadow_enabled, true, 'có bóng đổ xám lệch xuống-phải');

// ---- W3) Vẽ theo TẮNG LỚP cho CẢ DÒNG (hợp đồng mới của perChar) ----------
/* Vẽ xong hẳn chữ này mới tới chữ sau thì viền ngoài 29px của chữ sau đè 22px vào chữ
   trước (khe giữa hai chữ chỉ 7px) — nhìn như chữ bị gặm. Phải quét theo lớp: bóng của
   MỌI chữ, rồi vòng ngoài của MỌI chữ, rồi vòng trong, cuối cùng mới tới thân chữ. */
function opProbe(ctxMeasure) {
    const ops = [];
    const noop = () => {};
    return {
        ops,
        font: '', letterSpacing: '0px', textAlign: '', textBaseline: '',
        fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 0, lineJoin: '', miterLimit: 0,
        lineCap: '', shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
        save: noop, restore: noop, rotate: noop, scale: noop, translate: noop,
        beginPath: noop, moveTo: noop, lineTo: noop, arcTo: noop, arc: noop, ellipse: noop,
        bezierCurveTo: noop, closePath: noop, clip: noop, rect: noop, fill: noop, stroke: noop,
        fillRect: noop, clearRect: noop,
        strokeText(t) { ops.push({ op: 'stroke', t, color: this.strokeStyle, w: this.lineWidth, shadow: this.shadowColor }); },
        fillText(t) { ops.push({ op: 'fill', t, color: this.fillStyle, shadow: this.shadowColor }); },
        measureText: ctxMeasure.measureText,
    };
}
const wProbe = opProbe(fakeCtxSmooch());
// mốc mọi ký tự đã vào cảnh
TextTemplates.drawFrame(wProbe, tplW, textsW, 1.2, layW);
const wOps = wProbe.ops.filter((o) => o.t && 'Welcome'.includes(o.t));
const seq = wOps.map((o) => (o.op === 'fill' ? 'F' : (o.color === '#febdbd' ? 'O' : 'I'))).join('');
assert.ok(/^(?:O{7})?O{7}I{7}F{7}$/.test(seq) || /^O{7}O{7}I{7}F{7}$/.test(seq),
    `phải quét theo lớp (bóng+ngoài, ngoài, trong, thân), nhận "${seq}"`);
// pha đầu tiên là pha BÓNG: chỉ pha đó mới được đặt shadowColor
const shadowOps = wOps.filter((o) => o.shadow && o.shadow !== 'transparent');
assert.strictEqual(shadowOps.length, 7,
    `bóng chỉ đổ MỘT lượt cho mỗi ký tự (nhận ${shadowOps.length})`);
assert.ok(shadowOps.every((o) => o.color === '#febdbd'),
    'bóng phải đổ dưới vòng NGOÀI CÙNG, không phải dưới thân chữ');
assert.ok(wOps.slice(0, 7).every((o) => o.shadow && o.shadow !== 'transparent'),
    'pha đầu tiên phải là pha bóng, đi TRƯỚC mọi nét viền — nếu không bóng của chữ sau\n'
    + 'bôi đè lên viền chữ trước');

// ---- W4) Đường thời gian -------------------------------------------------
const atW = (layer, frame) => TextTemplates.layerStateAt(layer, (frame - 12) / 30);
const wA = tplW.layers[2].anim;
assert.ok(Math.abs(wA.perChar.stagger * 30 - 4 / 3) < 1e-9,
    'lệch pha 1.333 khung (8 khung cho 6 khoảng giữa 7 chữ)');
const charW = (i, frame) => TextTemplates.charStateAt(tplW.layers[2], (frame - 12) / 30, i).scale;
[[13, 0.145], [14, 0.68], [15, 0.99], [16, 1.105], [17, 1.15], [21, 1]].forEach(([f, want]) => {
    assert.ok(Math.abs(charW(0, f) - want) < 0.01,
        `chữ 'W' khung ${f}: hệ số ${want} (nhận ${charW(0, f).toFixed(3)})`);
});
/* Chữ 'e' CUỐI (chỉ số 6) — chỗ kiểm chéo lệch pha: nó vào cảnh ở khung 20 (12 + 6×1.33)
   và đo được 0.585 ở khung 22, 1.07 ở khung 27, 1.00 ở khung 29. */
assert.ok(Math.abs(charW(6, 22) - 0.68) < 0.02, "chữ 'e' cuối ở khung 22 đang bật dở");
assert.ok(Math.abs(charW(6, 29) - 1) < 0.01, "chữ 'e' cuối lắng ở khung 29");
assert.ok(TextTemplates.charStateAt(tplW.layers[2], (12.5 - 12) / 30, 6).hidden,
    'trước lượt của nó thì chữ cuối chưa vào cảnh');
// Hoa và mũi tên: cùng delay, cùng đường cong
assert.strictEqual(tplW.layers[0].anim.tracks.scale, tplW.layers[1].anim.tracks.scale,
    'hoa và mũi tên dùng CHUNG một đường phóng (đo riêng ra hai dãy trùng trong 2%)');
assert.ok(Math.abs(tplW.layers[0].anim.delay * 30 - 8) < 1e-9
    && Math.abs(tplW.layers[1].anim.delay * 30 - 8) < 1e-9, 'cả hai bật từ khung 20');
assert.ok(atW(tplW.layers[0], 19).hidden, 'khung 19 chưa có hoa');
[[21, 0.21], [25, 0.88], [28, 1.09], [33, 1]].forEach(([f, want]) => {
    assert.ok(Math.abs(atW(tplW.layers[0], f).scale - want) < 0.01,
        `hoa khung ${f}: hệ số ${want} (nhận ${atW(tplW.layers[0], f).scale.toFixed(3)})`);
});
assert.ok(Math.abs(atW(tplW.layers[0], 101).scale - 1) < 1e-9
    && Math.abs(atW(tplW.layers[1], 101).scale - 1) < 1e-9,
    'tới cuối block hai hình đứng yên (không có hoạt ảnh ra)');

// ---- W5) Mốc đứng yên & chữ ký khung -------------------------------------
const settleW = TextTemplates.settleTime(tplW, textsW);
assert.ok(settleW >= 21 / 30 - 1e-9 && settleW < 1.2,
    `mốc đứng yên ${settleW.toFixed(3)}s phải sau khi cả chữ lẫn hình đã lắng`);
const sigW = (f) => TextTemplates.frameSignature(tplW, (f - 12) / 30, textsW);
assert.notStrictEqual(sigW(16), sigW(17), 'đang bật chữ -> chữ ký khác từng khung');
assert.strictEqual(sigW(60), sigW(101), 'đã xong -> chữ ký trùng (khâu xuất gộp được khung)');

// ---- W6) Thông số người dùng chỉnh được -----------------------------------
const editW = TextTemplates.editableLayers(tplW);
assert.deepStrictEqual(editW.map((l) => l.key), ['flowers', 'arrow', 'text']);
assert.deepStrictEqual(editW[0].colorKeys.map((c) => c.key), ['petalA', 'coreA', 'petalB', 'coreB'],
    'cặp hoa có bốn mảng màu (cánh/nhuỵ của từng bông)');
assert.deepStrictEqual(editW[1].colorKeys.map((c) => c.key), ['mark']);
const ovW = TextTemplates.resolve(tplW, { flowers: { petalA: '#00b0ff' }, text: { color: '#222222' } });
assert.strictEqual(ovW.layers[0].colors.petalA, '#00b0ff');
assert.strictEqual(ovW.layers[0].colors.coreA, '#fef9f2', 'mảng màu không đổi thì giữ thiết kế');
assert.ok(ovW.layers[2].stroke2 && ovW.layers[2].stroke2.color === '#febdbd',
    'đổi màu chữ KHÔNG được làm mất vòng viền ngoài');
assert.ok(ovW.layers[2].anim.perChar, 'trộn override KHÔNG được làm mất hiệu ứng theo ký tự');

// ---- 9) Font mà mẫu cần phải NẰM TRONG bộ font của app --------------------
/* Mẫu dùng font không có trong EDITING_FONTS là preview ra font dự phòng và bản
   xuất khác preview — đúng loại lỗi âm thầm mà test này để chặn. */
const fs = require('fs');
const runtimeSrc = fs.readFileSync(path.join(projectRoot, 'static', 'js', 'editing-runtime.js'), 'utf8');
TextTemplates.TEMPLATES.forEach((t) => {
    TextTemplates.fonts(t).forEach((f) => {
        assert.ok(runtimeSrc.includes(`family: '${f.family}'`),
            `mẫu "${t.id}" dùng font "${f.family}" — không thấy trong EDITING_FONTS của editing-runtime.js`);
        const folder = new RegExp(`family: '${f.family.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}', folder: '([^']+)'`).exec(runtimeSrc);
        assert.ok(folder, `không đọc được folder font của "${f.family}"`);
        const file = path.join(projectRoot, 'static', 'fonts', 'google', folder[1]);
        assert.ok(fs.existsSync(file), `thiếu thư mục font ${file}`);
        /* Kiểu chữ cũng phải có FILE thật: mẫu khai `italic` mà family không có khuôn
           nghiêng thì Chrome nghiêng giả — dùng được nhưng nét méo, và đó không phải
           thứ ta đã đo. Với mẫu, đòi đúng file. */
        const wantItalic = f.style === 'italic';
        const weights = fs.readdirSync(file)
            .filter((n) => n.includes(`_${f.weight}`) && n.includes('Italic') === wantItalic);
        assert.ok(weights.length,
            `thiếu file font ${f.family} weight ${f.weight}${wantItalic ? ' Italic' : ''} trong ${file}`);
    });
});

console.log('text-templates: OK');
