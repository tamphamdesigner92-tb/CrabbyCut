/* =====================================================================
 * MẶC ĐỊNH TEXTBOX: FONT, CỠ CHỮ THEO ĐỘ PHÂN GIẢI, BỀ RỘNG TỰ CO
 *
 * Chốt ba điều đã quyết (2026-09-06):
 *   1. MỌI textbox mới — thêm tay lẫn do Magic Fill sinh — dùng Nunito, cỡ 58.
 *   2. 58 là số viết ở LỚP 1080; số đo px thật NHÂN theo cạnh ngắn của Sequence, nên chữ
 *      trông y hệt nhau ở 1080 dọc, 1080 ngang và 4K.
 *   3. Bề rộng textbox TỰ CO theo nội dung (kiểu CapCut). `style.box_width` chỉ là bề rộng
 *      TỐI THIỂU do người dùng kéo tay cầm; 0 = chưa kéo = bám sát chữ.
 *
 * LỖI ĐÃ TRẢ GIÁ:
 *   - Cỡ chữ Magic Fill từng dò theo chiều cao Sequence (0.048 × seqH, trần 90) nên mỗi tỉ
 *     lệ khung hình ra một cỡ khác — dọc 9:16 ra 62, ngang 16:9 bị chặn ở 52.
 *   - `defaultTextStyle().box_width` từng ghi cứng 420 vào MỌI box, nên box nào cũng hành
 *     xử như đã kéo tay: gõ chữ ngắn thì khung transform to đùng, và xoá bớt chữ thì khung
 *     KHÔNG BAO GIỜ co lại (measureTextItemBox lấy max(bề rộng chữ, box_width)).
 *
 * CÁCH ĐO: rút THẲNG các hàm thật trong nguồn ra chạy trong vm. Node không có canvas nên
 * thay phép đo chữ bằng THƯỚC ĐO TẤT ĐỊNH (bề rộng = số ký tự × hệ số) — thuật toán vẫn là
 * thuật toán thật, chỉ phép đo là giả và giả một cách biết trước. Phần đo bằng font Nunito
 * thật đã kiểm trực tiếp trong app.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(projectRoot, 'static', 'js', 'editing-runtime.js'), 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `không tìm thấy hàm ${name}() trong nguồn`);
    const bodyStart = src.indexOf('{', src.indexOf(')', start));
    let depth = 0;
    for (let i = bodyStart; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`không đóng được thân hàm ${name}()`);
}

function extractConst(src, name) {
    const m = src.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
    assert.ok(m, `không tìm thấy hằng ${name}`);
    return m[1].trim();
}

const CONSTS = [
    'DEFAULT_TEXT_FONT', 'DEFAULT_TEXT_FONT_SIZE',
    'TEXT_BOX_WIDTH_AUTO', 'LEGACY_DEFAULT_TEXT_BOX_WIDTH',
    'TEXT_STYLE_REFERENCE_SHORT_SIDE',
    'MAGIC_FILL_MAX_LINES', 'MAGIC_FILL_MIN_FONT_1080', 'MAGIC_FILL_BG_RADIUS',
    'MAGIC_FILL_FONT_FAMILY', 'MAGIC_FILL_FONT_WEIGHT', 'MAGIC_FILL_FONT_SIZE_1080',
    'MAGIC_FILL_MIN_LAYER_FONT_1080',
    'MAGIC_FILL_STYLE_PATCH',
];

// Sân khấu chung: các hằng + hàm quy đổi px thật, với payloadSequence() cắm được.
function makeStyleSandbox() {
    const sandbox = { SEQ: { width: 1920, height: 1080 } };
    vm.createContext(sandbox);
    vm.runInContext([
        ...CONSTS.map((n) => `const ${n} = ${extractConst(source, n)};`),
        'function payloadSequence() { return SEQ; }',
        extractFunction(source, 'sequenceTextScale'),
        extractFunction(source, 'scaledTextPx'),
        extractFunction(source, 'defaultTextStyle'),
        extractFunction(source, 'magicFillFontSize'),
        extractFunction(source, 'magicFillMinFont'),
        extractFunction(source, 'magicFillStylePatch'),
        `globalThis.api = { defaultTextStyle, magicFillFontSize, magicFillMinFont,
            magicFillStylePatch, scaledTextPx, sequenceTextScale,
            K: { DEFAULT_TEXT_FONT, DEFAULT_TEXT_FONT_SIZE, TEXT_BOX_WIDTH_AUTO,
                 LEGACY_DEFAULT_TEXT_BOX_WIDTH, TEXT_STYLE_REFERENCE_SHORT_SIDE,
                 MAGIC_FILL_MAX_LINES, MAGIC_FILL_FONT_FAMILY, MAGIC_FILL_FONT_WEIGHT,
                 MAGIC_FILL_FONT_SIZE_1080, MAGIC_FILL_MIN_LAYER_FONT_1080 } };`,
    ].join('\n'), sandbox);
    return sandbox;
}

// ---------------------------------------------------------------------------
// 1. Font + cỡ chữ mặc định, và cách nó nhân theo độ phân giải
// ---------------------------------------------------------------------------
{
    const box = makeStyleSandbox();
    const { api } = box;
    const at = (width, height) => { box.SEQ = { width, height }; return api.defaultTextStyle(); };

    assert.strictEqual(api.K.DEFAULT_TEXT_FONT, 'Nunito', 'font mặc định phải là Nunito');
    assert.strictEqual(api.K.DEFAULT_TEXT_FONT_SIZE, 58, 'cỡ chữ mặc định (lớp 1080) phải là 58');
    assert.strictEqual(api.K.TEXT_STYLE_REFERENCE_SHORT_SIDE, 1080, 'mốc quy đổi phải là cạnh ngắn 1080');

    /* MẤU CHỐT: cạnh ngắn của 1080×1920 và 1920×1080 đều là 1080, nên đổi qua lại giữa
       video dọc và ngang KHÔNG được làm đổi cỡ chữ. Lấy chiều cao thay vì cạnh ngắn là
       video dọc có chữ to gần gấp đôi — đúng cái phải chặn ở đây. */
    assert.strictEqual(at(1080, 1920).font_size, 58, 'dọc 9:16 (1080×1920) phải ra 58');
    assert.strictEqual(at(1920, 1080).font_size, 58, 'ngang 16:9 (1920×1080) phải ra 58');
    assert.strictEqual(at(1080, 1080).font_size, 58, 'vuông 1:1 (1080×1080) phải ra 58');

    // 4K: cạnh ngắn gấp đôi -> mọi số đo gấp đôi, chữ trông y hệt.
    assert.strictEqual(at(2160, 3840).font_size, 116, '4K dọc phải ra 116');
    assert.strictEqual(at(3840, 2160).font_size, 116, '4K ngang phải ra 116');
    // Khung nhỏ: co lại theo đúng tỉ lệ.
    assert.strictEqual(at(540, 960).font_size, 29, '540p dọc phải ra 29');

    // Các số đo px khác cũng phải nhân theo — chữ to gấp đôi mà nét viền/bo góc giữ nguyên
    // thì nhìn như mất viền.
    const k4 = at(3840, 2160);
    const k1 = at(1920, 1080);
    [['stroke_width', 6], ['bg_radius', 8], ['shadow_dy', 4], ['shadow_blur', 8]].forEach(([field, base]) => {
        assert.strictEqual(k1[field], base, `${field} ở lớp 1080 phải là ${base}`);
        assert.strictEqual(k4[field], base * 2, `${field} ở 4K phải gấp đôi (${base * 2})`);
    });

    // Sàn 1px: khung hình rất nhỏ không được làm tròn nét/bo góc về 0 (mất hẳn hiệu ứng).
    box.SEQ = { width: 64, height: 64 };
    assert.ok(api.scaledTextPx(6) >= 1, 'scaledTextPx phải có sàn 1px');
    assert.strictEqual(api.scaledTextPx(0), 0, 'giá trị 0 phải giữ nguyên 0 (tắt hiệu ứng)');

    /* CỠ CHỮ CỦA MAGIC FILL CÓ HẰNG RIÊNG (người dùng chốt 2026-09-16): trước đây nó bám
       DEFAULT_TEXT_FONT_SIZE (58) của textbox thêm tay, nhưng yêu cầu mới là "mọi thứ
       Magic Fill đặt xuống dùng CÙNG một cỡ" — cỡ đó áp cho cả mẫu văn bản, nơi 58 quá to
       (cụm dài nhất của dự án thật tràn khỏi lưới an toàn). Tách hằng để đổi một chỗ. */
    assert.strictEqual(api.K.MAGIC_FILL_FONT_FAMILY, 'Nunito', 'Magic Fill phải dùng font Nunito');
    assert.strictEqual(api.K.MAGIC_FILL_FONT_WEIGHT, 800, 'Magic Fill phải dùng ExtraBold (800)');
    assert.strictEqual(api.K.MAGIC_FILL_FONT_SIZE_1080, 48, 'cỡ chữ Magic Fill ở lớp 1080 phải là 48');
    assert.strictEqual(api.K.MAGIC_FILL_MIN_LAYER_FONT_1080, 34,
        'sàn cỡ chữ của lớp phụ phải là 34 (dòng phụ Zoom Title)');
    assert.ok(api.K.MAGIC_FILL_MIN_LAYER_FONT_1080 < api.K.MAGIC_FILL_FONT_SIZE_1080,
        'sàn lớp phụ phải NHỎ HƠN cỡ lớp chính, nếu không phân cấp bị san phẳng');
    box.SEQ = { width: 1080, height: 1920 };
    assert.strictEqual(api.magicFillFontSize(), 48, 'cỡ Magic Fill ở lớp 1080 phải là 48');
    box.SEQ = { width: 2160, height: 3840 };
    assert.strictEqual(api.magicFillFontSize(), 96, 'cỡ Magic Fill ở 4K phải gấp đôi (96)');
    assert.strictEqual(api.magicFillMinFont(), 48, 'sàn Magic Fill ở 4K phải gấp đôi (24→48)');
    assert.strictEqual(api.magicFillStylePatch().bg_radius, 24, 'bo góc nền Magic Fill ở 4K phải gấp đôi');
    assert.ok(/scaledTextPx\(MAGIC_FILL_FONT_SIZE_1080\)/.test(extractFunction(source, 'magicFillFontSize')),
        'magicFillFontSize() phải tham chiếu hằng riêng của Magic Fill, không chép cứng số');
    // Bản vá style dùng chung cũng phải mang đúng font ấy (đường dự phòng khi không có hiệu ứng).
    assert.strictEqual(api.magicFillStylePatch().font_family, 'Nunito');
    assert.strictEqual(api.magicFillStylePatch().font_weight, 800);

    // Nunito phải có thật ở CẢ hai đầu, nếu không bản xuất khác preview.
    assert.ok(/\{ family: 'Nunito', folder: 'Nunito'/.test(source),
        'Nunito phải có trong EDITING_FONTS');
    assert.ok(/family: 'Nunito',[^}]*weights: \[[^\]]*800/.test(source),
        'EDITING_FONTS phải khai weight 800 cho Nunito (Magic Fill dùng ExtraBold)');
    const backend = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
    assert.ok(/\['Nunito', 'Nunito\//.test(backend),
        'backend phải biết đường dẫn file font Nunito (nếu không bản xuất rơi về Inter)');
    assert.ok(fs.existsSync(path.join(projectRoot, 'static', 'fonts', 'google', 'Nunito', 'Nunito_800ExtraBold.ttf')),
        'thiếu file Nunito_800ExtraBold.ttf — Magic Fill đặt font_weight 800');
}

// ---------------------------------------------------------------------------
// 2. Bề rộng TỰ CO theo nội dung (measureTextItemBox thật, thước đo tất định)
// ---------------------------------------------------------------------------
const GLYPH_W = 10;   // mỗi ký tự rộng 10px trong thước đo giả

function makeMeasureSandbox() {
    const sandbox = { SEQ: { width: 1920, height: 1080 } };
    // canvas giả: bề rộng = số ký tự × GLYPH_W
    sandbox.document = {
        createElement: () => ({
            getContext: () => ({
                font: '',
                measureText: (s) => ({
                    width: String(s).length * GLYPH_W,
                    actualBoundingBoxAscent: 40,
                    actualBoundingBoxDescent: 10,
                }),
            }),
        }),
    };
    vm.createContext(sandbox);
    vm.runInContext([
        ...CONSTS.map((n) => `const ${n} = ${extractConst(source, n)};`),
        'function payloadSequence() { return SEQ; }',
        // Giải font không ảnh hưởng phép tính bề rộng ở đây; mục 1 đã khoá phần font rồi.
        'function normalizeTextFontFamily(v) { return String(v || DEFAULT_TEXT_FONT); }',
        'function resolveFontWeight(family, weight) { return Number(weight) || 400; }',
        /* Nạp @font-face rồi vẽ lại (xem ensureTextFontLoaded): sân khấu này không có
           document.fonts và cũng không đo font thật — thước đo giả ở trên cho mỗi ký tự
           đúng 10px — nên stub "font đã sẵn sàng" là đủ và không giấu đi điều gì. */
        'function ensureTextFontLoaded() { return true; }',
        /* measureTextItemBox có nhánh MẪU VĂN BẢN (xem mục "Mẫu Văn Bản" trong
           APP_INTERNALS.md). Ở đây ta đo TEXTBOX THƯỜNG nên cổng đó luôn đóng —
           stub false, không kéo cả engine text-templates.js vào sân khấu này. */
        'function itemIsTextTemplate() { return false; }',
        'function textTemplateLayout() { return null; }',
        extractFunction(source, 'sequenceTextScale'),
        extractFunction(source, 'scaledTextPx'),
        extractFunction(source, 'defaultTextStyle'),
        extractFunction(source, 'textFontVariant'),
        extractFunction(source, 'applyTextCase'),
        extractFunction(source, 'textLetterSpacingPx'),
        extractFunction(source, 'textLineHeightPx'),
        extractFunction(source, 'textCanvasLines'),
        /* NỀN VỆT CỌ: measureTextItemBox cộng phần tràn của vệt vào lề canvas. Lấy hàm
           THẬT chứ không stub — chúng thuần số học, và stub "không phải vệt cọ" là bài đo
           lề này mất hiệu lực ngay khi ai đó đổi công thức tràn. */
        extractFunction(source, 'textBgIsBrush'),
        extractFunction(source, 'brushOverflowPx'),
        // Lề chữ↔mép nền (hai ô W/H của khối Nền) — measureTextItemBox gọi tới.
        extractFunction(source, 'padPctOrNaN'),
        extractFunction(source, 'textBgPadPx'),
        extractFunction(source, 'textBgPadPercent'),
        extractFunction(source, 'textBgPadPatch'),
        extractFunction(source, 'measureTextItemBox'),
        'globalThis.api2 = { measureTextItemBox, defaultTextStyle, textBgPadPercent, textBgPadPatch };',
    ].join('\n'), sandbox);
    return sandbox;
}

{
    const box = makeMeasureSandbox();
    const { api2 } = box;
    const measure = (text, boxWidth) => api2.measureTextItemBox({
        text,
        style: { ...api2.defaultTextStyle(), box_width: boxWidth },
    });

    // Mặc định phải là TỰ CO, không phải con số cũ 420.
    assert.strictEqual(api2.defaultTextStyle().box_width, 0,
        'textbox mới phải ở chế độ tự co (box_width = 0)');

    // (a) TỰ CO: chữ dài ra thì box rộng ra, chữ ngắn lại thì box HẸP LẠI.
    const wLong = measure('Guồn lực dành cho tăng cân', 0).width;
    const wShort = measure('Tăng cân', 0).width;
    assert.ok(wLong > wShort,
        `tự co: chữ dài phải cho box rộng hơn (${wLong} vs ${wShort})`);
    /* Đây chính là nửa bị hỏng trước đây: rút ngắn nội dung mà khung không bao giờ co.
       Chênh lệch phải đúng bằng số ký tự chênh × bề rộng mỗi ký tự. */
    const deltaChars = 'Guồn lực dành cho tăng cân'.length - 'Tăng cân'.length;
    assert.strictEqual(wLong - wShort, deltaChars * GLYPH_W,
        'bề rộng phải bám sát số ký tự, không có phần dư cố định nào');

    // (b) ĐÃ KÉO TAY: box_width là bề rộng TỐI THIỂU -> chữ ngắn vẫn giữ bề rộng đó...
    const manual = 800;
    assert.strictEqual(measure('Tăng cân', manual).width, measure('A', manual).width,
        'đã kéo tay thì chữ ngắn hơn không làm box hẹp lại');
    // ...nhưng chữ dài hơn thì box vẫn nở ra (không cắt chữ).
    const veryLong = 'x'.repeat(200);
    assert.ok(measure(veryLong, manual).width > manual,
        'đã kéo tay nhưng chữ dài hơn thì box vẫn phải nở ra');

    // (c) contentWidth luôn là bề rộng CHỮ, bỏ qua bề rộng đặt tay — chỗ kéo tay cầm cần
    //     nó làm điểm xuất phát để không nhảy cỡ khi vừa chạm vào tay cầm.
    assert.strictEqual(measure('Tăng cân', manual).contentWidth, measure('Tăng cân', 0).width,
        'contentWidth phải bằng bề rộng ở chế độ tự co');

    // (d) Chiều cao vẫn theo SỐ DÒNG của nội dung (vốn đã đúng, khoá lại kẻo hồi quy).
    assert.ok(measure('a\nb\nc', 0).height > measure('a', 0).height,
        'nhiều dòng phải cho box cao hơn');

    /* (e) LỀ CHỮ ↔ MÉP NỀN (hai ô W/H, kiểu CapCut).
     *  · "Auto" (bg_pad_x/y = null) phải cho ĐÚNG công thức cũ max(10, ceil(0.28·cỡ chữ)) —
     *    dự án cũ mở lên không được đổi một pixel. Đây là chỗ từng hỏng: `Number(null)`
     *    ra 0 chứ không phải NaN, nên style mặc định bị hiểu là "lề 0%" và mọi textbox
     *    mất sạch phần đệm (xem padPctOrNaN).
     *  · Đặt tay thì lề = % CỠ CHỮ, hai trục ĐỘC LẬP nhau. */
    const st = api2.defaultTextStyle();
    const size = Number(st.font_size);
    const autoPad = Math.max(10, Math.ceil(size * 0.28));
    const auto = measure('Tăng cân', 0);
    assert.strictEqual(auto.padX, autoPad, `lề Auto ngang phải là ${autoPad}px (được ${auto.padX})`);
    assert.strictEqual(auto.padY, autoPad, `lề Auto dọc phải là ${autoPad}px (được ${auto.padY})`);
    const measurePad = (padX, padY) => api2.measureTextItemBox({
        text: 'Tăng cân',
        style: { ...st, box_width: 0, bg_pad_x: padX, bg_pad_y: padY },
    });
    const wide = measurePad(50, 10);
    assert.strictEqual(wide.padX, Math.round(size * 0.5), 'W = 50% -> lề ngang = nửa cỡ chữ');
    assert.strictEqual(wide.padY, Math.round(size * 0.1), 'H = 10% -> lề dọc = 1/10 cỡ chữ');
    assert.strictEqual(wide.width, auto.width - 2 * autoPad + 2 * wide.padX,
        'bề rộng hộp = bề rộng chữ + 2 lề ngang');
    assert.strictEqual(wide.height, auto.height - 2 * autoPad + 2 * wide.padY,
        'chiều cao hộp = chiều cao chữ + 2 lề dọc');
    assert.strictEqual(measurePad(0, 0).padX, 0, 'đặt 0% thì lề bằng 0 (sàn 10px chỉ dành cho Auto)');

    /* Preview DOM và bản vẽ canvas phải dùng CÙNG hai số đó, nếu không preview lệch bản
       xuất. Soi mã nguồn vì hai chỗ đó nằm trong hàm dựng khung, không gọi lẻ được. */
    assert.ok(/textBox\.padY \* previewScale}px \$\{textBox\.padX \* previewScale}px/.test(source),
        'preview DOM phải đặt padding theo padY/padX riêng trục');
    assert.ok(/const padX = measured\.padX;/.test(source) && /const padY = measured\.padY;/.test(source),
        'drawTextItemContent phải đọc padX/padY riêng trục');
}

// ---------------------------------------------------------------------------
// 2b. Ô W/H khi LỀ TRÊN/DƯỚI LỆCH NHAU (mẫu văn bản)
//
// Hộp nền của mẫu đo từ video CapCut bám dải ascender→descender nên không cân đối
// ("Quote": 9px trên dải chữ hoa, 18px dưới baseline ở cỡ 79.87 = 11.27% / 22.54%).
// Ô "H" phải bày ra TRUNG BÌNH hai phía và khi kéo thì GIỮ ĐÚNG TỈ LỆ đó — làm phẳng
// thành hai lề bằng nhau là mất số đo của mẫu ngay ở cú kéo đầu tiên.
// ---------------------------------------------------------------------------
{
    const { api2 } = makeMeasureSandbox();
    const size = 79.87;
    const tplStyle = { font_size: size, bg_pad_x: 46.3277, bg_pad_top: 11.2683, bg_pad_bottom: 22.5366 };

    assert.strictEqual(api2.textBgPadPercent(tplStyle, size, 'x'), 46.3, 'ô W bày ra lề ngang (1 số lẻ)');
    assert.strictEqual(api2.textBgPadPercent(tplStyle, size, 'y'), 16.9, 'ô H bày ra TRUNG BÌNH lề trên/dưới');

    const patched = api2.textBgPadPatch(tplStyle, 'y', 30);
    assert.ok(Math.abs(patched.bg_pad_top - 20) < 0.01 && Math.abs(patched.bg_pad_bottom - 40) < 0.01,
        `kéo H lên 30% phải giữ tỉ lệ 1:2 (được ${JSON.stringify(patched)})`);
    assert.ok(!('bg_pad_y' in patched), 'lớp có lề trên/dưới riêng thì KHÔNG được ghi bg_pad_y');
    assert.strictEqual(api2.textBgPadPercent({ ...tplStyle, ...patched }, size, 'y'), 30,
        'đọc lại ô H sau khi ghi phải ra đúng số vừa đặt');

    // Text thường (không có lề trên/dưới riêng) -> ghi thẳng bg_pad_y.
    // deepEqual (không strict): object trả về từ sandbox vm khác realm nên khác prototype.
    assert.deepEqual(api2.textBgPadPatch({ font_size: 64 }, 'y', 12), { bg_pad_y: 12 });
    assert.deepEqual(api2.textBgPadPatch({ font_size: 64 }, 'x', 12), { bg_pad_x: 12 });
    // Kẹp biên: không cho lề âm, không cho vượt 300%.
    assert.deepEqual(api2.textBgPadPatch({ font_size: 64 }, 'x', -5), { bg_pad_x: 0 });
    assert.deepEqual(api2.textBgPadPatch({ font_size: 64 }, 'x', 9999), { bg_pad_x: 300 });
    /* Style mặc định (bg_pad_* = null) phải bày ra đúng tỉ lệ của công thức Auto, không
       phải 0 — chính là lỗi `Number(null) === 0` ở trên, nhưng nhìn từ phía panel. */
    const st = api2.defaultTextStyle();
    const autoPct = Math.round((Math.max(10, Math.ceil(Number(st.font_size) * 0.28)) / Number(st.font_size)) * 1000) / 10;
    assert.strictEqual(api2.textBgPadPercent(st, Number(st.font_size), 'x'), autoPct,
        'ô W của text mặc định phải bày ra tỉ lệ Auto, không phải 0');
}

// ---------------------------------------------------------------------------
// 3. Các đường ghi/đọc box_width khác — soi mã nguồn (nằm trong hàm quá lớn)
// ---------------------------------------------------------------------------
{
    // Kéo tay cầm phải xuất phát từ bề rộng ĐANG THẤY, không phải một số mặc định.
    assert.ok(/startTextWidth: item\.type === 'text'/.test(source),
        'startPreviewBoxDrag() phải ghi lại bề rộng chữ đang thấy (startTextWidth)');
    assert.ok(/measureTextItemBox\(item\)\.contentWidth/.test(source),
        'startTextWidth phải lấy contentWidth khi box đang tự co');
    assert.ok(!/Number\(style\.box_width \|\| 420\)/.test(source),
        'chỗ kéo tay cầm còn dùng số mặc định cũ 420 làm điểm xuất phát');

    // Magic Fill không được ghim bề rộng nữa.
    const magicFill = extractFunction(source, 'magicFill');
    assert.ok(/box_width: TEXT_BOX_WIDTH_AUTO/.test(magicFill),
        'box Magic Fill phải để bề rộng tự co');
    assert.ok(!/box_width: p\.boxWidth/.test(magicFill),
        'box Magic Fill còn ghim bề rộng đo lúc tạo -> sửa chữ xong khung không co lại');

    // Dự án cũ: đúng con số mặc định cũ 420 -> trả về tự co, các bề rộng khác giữ nguyên.
    const restore = extractFunction(source, 'restoreEditingHistoryState');
    assert.ok(/Number\(it\.style\?\.box_width\) === LEGACY_DEFAULT_TEXT_BOX_WIDTH/.test(restore),
        'phải chuẩn hoá đúng bề rộng mặc định CŨ (420) về tự co khi mở dự án cũ');
    assert.ok(/it\.style\.box_width = TEXT_BOX_WIDTH_AUTO/.test(restore),
        'chuẩn hoá phải ghi TEXT_BOX_WIDTH_AUTO');
}

// ---------------------------------------------------------------------------
// 4. Thuật toán cắt cụm dài (hàm THẬT, thước đo tất định)
// ---------------------------------------------------------------------------
const CHAR_W = 10;
const LINE_CHARS = 10;
const FAKE_MAX_WIDTH = CHAR_W * LINE_CHARS;

function makeSplitter() {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext([
        /* Giãn chữ lấy từ hiệu ứng "Hồng kẹo" (magicFillLetterPct) — cả một chuỗi
           TEXT_EFFECT_PRESETS + AppSettings, không rút vào vm được. Thay bằng số cố định:
           thuật toán CẮT không đọc con số này, nó chỉ đi qua magicWrap mà ở đây đã là
           thước đo giả. Phần "gói dòng phải dùng đúng giãn chữ của hiệu ứng" khoá ở mục 6. */
        'function magicFillLetterPct() { return 0; }',
        `const MAGIC_FILL_MAX_LINES = ${extractConst(source, 'MAGIC_FILL_MAX_LINES')};`,
        `function magicWrap(text, fontSize, family, weight, letterPx, maxWidth) {
            const words = String(text || '').split(/\\s+/).filter(Boolean);
            const lines = [];
            let cur = '';
            for (const w of words) {
                const t = cur ? cur + ' ' + w : w;
                if (cur && t.length * ${CHAR_W} > maxWidth) { lines.push(cur); cur = w; }
                else cur = t;
            }
            if (cur) lines.push(cur);
            return { lines: lines.length ? lines : [String(text || '')], width: 1 };
        }`,
        extractFunction(source, 'magicSplitToMaxLines'),
        'globalThis.magicSplitToMaxLines = magicSplitToMaxLines;',
        'globalThis.magicWrap = magicWrap;',
    ].join('\n'), sandbox);
    return sandbox;
}

const S = makeSplitter();
// Trải sang mảng của realm này: mảng do vm trả về mang Array.prototype KHÁC nên
// deepStrictEqual sẽ báo lệch dù nội dung y hệt.
const split = (text, maxLines = 2) =>
    [...S.magicSplitToMaxLines(text, 'Nunito', 700, FAKE_MAX_WIDTH, 58, maxLines)];
const linesOf = (text) => S.magicWrap(text, 58, 'Nunito', 700, 0, FAKE_MAX_WIDTH).lines.length;

{
    // (a) Ngắn -> đúng 1 box
    assert.deepStrictEqual(split('abc'), ['abc'], 'cụm ngắn không được cắt');

    // (b) Dài -> nhiều box, MỖI box ≤ maxLines dòng
    const long = Array.from({ length: 18 }, (_, i) => `w${i}`).join(' ');
    const chunks = split(long, 2);
    assert.ok(chunks.length > 1, `cụm dài phải bị cắt, nhận ${chunks.length} box`);
    chunks.forEach((c, i) => {
        assert.ok(linesOf(c) <= 2, `box ${i} có ${linesOf(c)} dòng, vượt trần 2`);
    });

    /* (c) KHÔNG ĐƯỢC MẤT CHỮ. Đây là điều duy nhất người dùng phát hiện ngay mà lại dễ hỏng
       nhất khi sửa vòng lặp: ghép các mảnh lại phải ra đúng câu gốc, đúng thứ tự. */
    assert.strictEqual(chunks.join(' '), long, 'ghép các box lại phải khớp nguyên văn cụm gốc');
    assert.ok(chunks.every((c) => c.trim().length), 'không được sinh mảnh rỗng');

    // (d) maxLines = 1 -> cắt dày hơn, vẫn không mất chữ
    const oneLine = split(long, 1);
    assert.ok(oneLine.length > chunks.length, 'giới hạn 1 dòng phải cắt ra nhiều box hơn 2 dòng');
    assert.strictEqual(oneLine.join(' '), long, 'cắt 1 dòng cũng không được mất chữ');
    oneLine.forEach((c) => assert.strictEqual(linesOf(c), 1, 'mỗi box phải đúng 1 dòng'));

    /* (e) MỘT TỪ dài hơn cả dòng: phải giữ nguyên trong một mảnh, KHÔNG lặp vô hạn và
       KHÔNG sinh mảnh rỗng. Đây là ca làm treo trình duyệt nếu điều kiện `cur.length` bị
       bỏ — chỗ dễ "dọn dẹp" nhầm nhất trong hàm. */
    const giant = 'x'.repeat(LINE_CHARS * 3);
    const withGiant = split(`abc ${giant} def`, 2);
    assert.strictEqual(withGiant.join(' '), `abc ${giant} def`, 'ca từ-dài không được mất chữ');
    assert.ok(withGiant.every((c) => c.trim().length), 'ca từ-dài không được sinh mảnh rỗng');

    // (f) Rỗng / khoảng trắng -> luôn trả đúng 1 phần tử (bước sau giả định vậy)
    assert.strictEqual(split('').length, 1, 'chuỗi rỗng vẫn phải trả 1 phần tử');
    assert.strictEqual(split('   ').length, 1, 'chuỗi toàn khoảng trắng vẫn phải trả 1 phần tử');
}

// ---------------------------------------------------------------------------
// 5. Khoá cách bước (1b) của magicFill dùng kết quả cắt
// ---------------------------------------------------------------------------
{
    const fn = extractFunction(source, 'magicFill');

    assert.ok(/const maxFont = magicFillFontSize\(\);/.test(fn),
        'magicFill phải lấy trần cỡ chữ từ magicFillFontSize(), không dò theo chiều cao Sequence nữa');
    assert.ok(!/MAGIC_FILL_MAX_FONT_RATIO|MAGIC_FILL_MAX_FONT_CAP/.test(source),
        'còn sót cách tính cỡ chữ theo chiều cao Sequence');

    /* Không cắt khi thời lượng không đủ: đổi một box đọc được lấy mấy box nhấp nháy là
       tệ hơn chữ nhỏ. */
    assert.ok(/Math\.floor\(p\.dur \/ MAGIC_FILL_MIN_DUR\)/.test(fn),
        'phải chặn số mảnh theo thời lượng (mỗi box ≥ MAGIC_FILL_MIN_DUR)');
    assert.ok(/if \(chunks\.length > maxChunks\) chunks = \[p\.content\];/.test(fn),
        'quá số mảnh cho phép thì phải quay về MỘT box và để magicFitFontSize thu nhỏ');

    // Mảnh cuối ăn hết phần dư -> tổng các box phủ đúng khoảng thời gian của cụm gốc.
    assert.ok(/ci === chunks\.length - 1[\s\S]{0,80}p\.tlEnd/.test(fn),
        'mảnh cuối phải kết thúc đúng tại p.tlEnd của cụm gốc');

    /* Luật "cụm in đậm -> khối gì" GỘP CỤM LIỀN KỀ trước, nên nó phải chạy trên `bolds`
       (toàn bộ cụm của kịch bản, có offset để dò cụm liền kề) — không phải trên `planned`
       (đã lọc bớt) và càng không phải trên `boxes` (đã cắt nhỏ). Thời gian mới tra ngược
       từ `planned` qua `plannedByBold`. */
    assert.ok(/groupBoldRanges\(bolds, scriptCtxText\)/.test(fn),
        'phép gộp cụm liền kề phải chạy trên `bolds` + kịch bản chuẩn');
    assert.ok(/planBoldGroups\(boldGroups, libraryItems\)/.test(fn),
        'luật "nhóm -> khối gì" phải chạy trên nhóm đã gộp');
    assert.ok(/const plannedByBold = new Map\(planned\.map\(/.test(fn),
        'thời gian của khối phải tra ngược từ `planned` theo boldIndex');
    assert.ok(/for \(const p of textPhrases\)/.test(fn),
        'bước cắt cụm dài chỉ áp cho cụm dựng bằng CHỮ (textPhrases)');
    ['const unifiedFont = Math.max(minFont, Math.min(...boxes.map(',
     'boxes.sort((a, b) => a.tlStart - b.tlStart);'].forEach((needle) => {
        assert.ok(fn.includes(needle), `bước dựng box phải chạy trên \`boxes\`: thiếu "${needle}"`);
    });
}

// ---------------------------------------------------------------------------
// 6. Cụm in đậm KHÔNG khớp hình -> hiệu ứng chữ "Hồng kẹo" + động vào luân phiên
//    (người dùng chốt 2026-09-15)
// ---------------------------------------------------------------------------
{
    const fn = extractFunction(source, 'magicFill');

    // Hiệu ứng phải TRA TỪ BẢNG PRESET, không phải một bảng màu chép tay cho Magic Fill
    assert.ok(/const MAGIC_FILL_TEXT_EFFECT_ID = 'fx7';/.test(source),
        'phải chốt id hiệu ứng chữ mặc định của Magic Fill');
    const fx7 = source.slice(source.indexOf("id: 'fx7'"), source.indexOf("id: 'fx8'"));
    assert.ok(/name: 'Hồng kẹo'/.test(fx7), 'fx7 phải đúng là hiệu ứng "Hồng kẹo"');

    /* Font/độ đậm dùng để ĐO phải ĐÚNG BẰNG font sẽ VẼ, nếu không chữ gói theo một phép đo
       rồi vẽ bằng font rộng hơn -> box lòi khỏi lưới an toàn.
       ĐỔI 2026-09-16: trước đây cả hai lấy từ patch của hiệu ứng "Hồng kẹo" (Poppins 900);
       nay magicFillTextPatch ÉP lại font của Magic Fill nên đo theo hiệu ứng là đo nhầm. */
    assert.ok(/const family = MAGIC_FILL_FONT_FAMILY;/.test(fn) && /const weight = MAGIC_FILL_FONT_WEIGHT;/.test(fn),
        'font + độ đậm để đo phải là hằng của Magic Fill, không lấy từ patch của hiệu ứng');
    assert.ok(/await awaitTextFontLoaded\(family, weight\)/.test(fn),
        'phải await font trước khi đo, nếu không gói dòng bằng metric của font dự phòng');

    /* Hiệu ứng "Hồng kẹo" vẫn quyết định MÀU/NỀN/VIỀN, chỉ hai khoá font bị giành lại. */
    const patchFn = extractFunction(source, 'magicFillTextPatch');
    assert.ok(/font_family: MAGIC_FILL_FONT_FAMILY/.test(patchFn) && /font_weight: MAGIC_FILL_FONT_WEIGHT/.test(patchFn),
        'magicFillTextPatch phải ép font của Magic Fill lên trên patch của hiệu ứng');
    assert.ok(patchFn.indexOf('textEffectPatch') < patchFn.indexOf('font_family: MAGIC_FILL_FONT_FAMILY'),
        'font phải ép SAU patch hiệu ứng, nếu không hiệu ứng ghi đè lại');

    /* MẪU VĂN BẢN: font + cỡ ghi vào override của TỪNG BLOCK (không đụng thiết kế gốc của
       mẫu — người dùng chốt "không phải thay đổi font mặc định của các Text Template"). */
    const tplItemFn = extractFunction(source, 'magicFillTemplateItem');
    assert.ok(/font_family: MAGIC_FILL_FONT_FAMILY/.test(tplItemFn)
        && /font_weight: MAGIC_FILL_FONT_WEIGHT/.test(tplItemFn)
        && /font_size: Math\.min\(/.test(tplItemFn),
        'block mẫu do Magic Fill dựng phải mang font + cỡ của Magic Fill trong overrides');
    /* CHUẨN HOÁ THEO LỚP CHÍNH: một hệ số cho cả mẫu, chọn theo lớp chữ LỚN NHẤT. Ép mọi
       lớp về cùng một số sẽ xoá phân cấp tiêu đề/dòng phụ 2.8:1 của "Zoom Title". */
    assert.ok(/MAGIC_FILL_FONT_SIZE_1080 \/ designMax/.test(tplItemFn),
        'cỡ chữ mẫu phải chuẩn hoá theo lớp chữ lớn nhất, giữ tỉ lệ trong mẫu');
    assert.ok(/MAGIC_FILL_MIN_LAYER_FONT_1080/.test(tplItemFn) && /Math\.min\(\s*MAGIC_FILL_FONT_SIZE_1080/.test(tplItemFn),
        'cỡ lớp chữ phải bị kẹp vào [sàn lớp phụ, cỡ lớp chính]');

    /* SỐ CUỐI CÙNG cho ba mẫu Magic Fill dùng — tính lại bằng CHÍNH engine mẫu, không chép
       tay: đổi thiết kế mẫu hay đổi hằng số là con số ở đây đổi theo và test nói ra ngay. */
    {
        const TT = require(path.join(projectRoot, 'static', 'js', 'text-templates.js'));
        const MF = 48;
        const FLOOR = 34;
        const sizesOf = (id) => {
            const layers = TT.editableLayers(TT.byId(id)).filter((l) => l.kind === 'text');
            const designMax = Math.max(...layers.map((l) => l.style.font_size));
            return layers.map((l) => Math.min(MF, Math.max(FLOOR,
                Math.round((l.style.font_size * MF / designMax) * 10) / 10)));
        };
        assert.deepStrictEqual(sizesOf('custom'), [48], 'mẫu Custom: một lớp chữ, cỡ 48');
        assert.deepStrictEqual(sizesOf('vlog-tag'), [48], 'mẫu Vlog Tag: cỡ 48');
        assert.deepStrictEqual(sizesOf('zoom-title'), [48, 34],
            'Zoom Title: tiêu đề 48, dòng phụ 34 (sàn kéo lên từ 17 — người dùng chốt)');
    }
    assert.ok(/editableLayers\(tpl\)/.test(tplItemFn),
        'phải duyệt lớp chữ qua editableLayers, không đoán tên khoá lớp');
    assert.ok(!/TEMPLATES.*font/.test(tplItemFn),
        'KHÔNG được sửa thiết kế gốc của mẫu — chỉ ghi vào overrides của block');
    assert.ok(/magicFillTextPatch\(unifiedFont\)/.test(fn),
        'style của box phải là patch hiệu ứng đã quy theo cỡ chữ đang dùng');
    const wrapFn = extractFunction(source, 'magicFitFontSize');
    assert.ok(/magicFillLetterPct\(\)/.test(wrapFn),
        'phép dò cỡ chữ phải dùng đúng giãn chữ của hiệu ứng');

    // Viền của hiệu ứng nằm NGOÀI mực chữ -> phải trừ khỏi bề rộng gói dòng
    assert.ok(/const inkWidth = Math\.max\(40, safeWidth - \(2 \* Math\.ceil\(maxFont \* magicFillStrokeRatio\(\)\)\)\);/.test(fn),
        'bề rộng gói dòng phải trừ hai bên viền của hiệu ứng');
    assert.ok(!/magicWrap\(p\.content, unifiedFont, family, weight, letterPx, safeWidth\)/.test(fn),
        'còn gói dòng theo safeWidth trần -> chữ có viền sẽ chạm mép lưới an toàn');

    // Hiệu ứng động VÀO luân phiên; RA giữ mờ dần
    assert.ok(/animation: magicFillTextAnimation\(p\.anim\)/.test(fn),
        'box chữ phải nhận hiệu ứng vào luân phiên');
    const animFn = extractFunction(source, 'magicFillTextAnimation');
    assert.ok(/\.\.\.base, in: \{ \.\.\.base\.in/.test(animFn),
        'chỉ được thay phía VÀO, phía RA giữ nguyên mặc định (mờ dần)');
}

// ---------------------------------------------------------------------------
// 7. Kịch bản chuẩn dùng để đọc OFFSET phải là bản KHỚP offset
//    CA LỖI THẬT (dự án "Bin Tom - Tap 3", 2026-09-16)
// ---------------------------------------------------------------------------
{
    const fn = extractFunction(source, 'magicFill');
    assert.ok(/const scriptCtxText = magicCleanScriptText\(meta\);/.test(fn),
        'magicFill phải chọn kịch bản chuẩn qua magicCleanScriptText, không lấy ô đầu tiên có chữ');

    /* Ô "đang hiệu chỉnh" (#refScriptReview) ĐƯỢC PHÉP lệch khỏi ô nhập (#refScriptInput)
       — người dùng thêm/bớt câu ở đó để bóc băng lại, còn offset của metadata bám theo ô
       nhập. Bản cũ ưu tiên review vô điều kiện nên đọc nhầm chỗ, hỏng ÂM THẦM. */
    const pick = extractFunction(source, 'magicCleanScriptText');
    assert.ok(/\['refScriptInput', 'refScriptReview'\]/.test(pick),
        'nguồn sự thật (#refScriptInput) phải đứng trước để thắng khi bằng điểm');
    assert.ok(/text\.slice\(s, e\)\.trim\(\) === String\(\(b && b\.text\) \|\| ''\)\.trim\(\)/.test(pick),
        'phải chấm điểm bằng chính offset clean_start/clean_end của cụm in đậm');
    assert.ok(/if \(hit > best\.hit\)/.test(pick), 'phải chọn bản KHỚP NHIỀU NHẤT');
    assert.ok(!/\['refScriptReview', 'refScriptInput'\]/.test(source),
        'còn sót chỗ ưu tiên ô "đang hiệu chỉnh" vô điều kiện');

    // Chạy thật hàm chọn với hai ô lệch nhau: phải nhặt đúng bản khớp offset.
    const sandbox = { picked: null };
    vm.createContext(sandbox);
    const TEXT_A = 'Có HMO nhé.';                 // khớp offset
    const TEXT_B = 'Dòng thêm vào\nCó HMO nhé.';  // lệch một dòng
    vm.runInContext([
        `const BOX = { refScriptInput: ${JSON.stringify(TEXT_A)}, refScriptReview: ${JSON.stringify(TEXT_B)} };`,
        'const document = { getElementById: (id) => (BOX[id] === undefined ? null : { value: BOX[id] }) };',
        extractFunction(source, 'magicCleanScriptText'),
        `const META = { bold_ranges: [{ text: 'HMO', clean_start: ${TEXT_A.indexOf('HMO')}, clean_end: ${TEXT_A.indexOf('HMO') + 3} }] };`,
        'globalThis.picked = magicCleanScriptText(META);',
        // Đảo hai ô: bản khớp offset giờ nằm ở ô review -> phải nhặt ô review
        `BOX.refScriptInput = ${JSON.stringify(TEXT_B)}; BOX.refScriptReview = ${JSON.stringify(TEXT_A)};`,
        'globalThis.pickedSwapped = magicCleanScriptText(META);',
    ].join('\n'), sandbox);
    assert.strictEqual(sandbox.picked, TEXT_A, 'phải bỏ qua ô "đang hiệu chỉnh" đã lệch offset');
    assert.strictEqual(sandbox.pickedSwapped, TEXT_A, 'bản khớp offset nằm ở ô nào cũng phải nhặt đúng');
}

console.log('magic_fill_text_defaults: OK');
