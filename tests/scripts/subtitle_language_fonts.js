/* =====================================================================
 * AUTO SUBTITLE ĐA NGÔN NGỮ — FONT THEO NGÔN NGỮ + NGẮT DÒNG CHỮ CJK
 *
 * Canh ba thứ mà hỏng thì hỏng ÂM THẦM: không có dòng lỗi nào, chỉ có bản xuất sai.
 *
 *   1. FONT PHẢI CÓ THẬT TRÊN ĐĨA. Chữ của mọi block text được bake thành PNG bằng
 *      canvas của renderer (renderTextItemToPng), nên font thiếu KHÔNG ném lỗi: trình
 *      duyệt lặng lẽ rơi về font khác, hoặc vẽ ra một hàng ô vuông — và cái hàng ô vuông
 *      đó đi thẳng vào video xuất ra. Không mở preview thì không ai biết.
 *
 *   2. BA DANH SÁCH NGÔN NGỮ PHẢI KHỚP NHAU. Mã ngôn ngữ đi qua ba tệp (menu ở renderer
 *      -> lọc trắng ở backend -> tham số `language` của Whisper). Lệch một mã thì backend
 *      hạ về 'vi' và người dùng chọn "日本語" lại nhận phụ đề tiếng Việt — đúng cái kiểu
 *      sai mà nhìn giao diện không thấy được.
 *
 *   3. CHỮ TRUNG/NHẬT PHẢI NGẮT ĐƯỢC DÒNG. Hai thứ tiếng đó viết LIỀN, không khoảng
 *      trắng. Bản cũ ngắt dòng bằng `split(/\s+/)` nên cả câu ra ĐÚNG MỘT "từ": không có
 *      chỗ nào để xuống dòng -> phụ đề tràn ra ngoài khung hình, và splitTextToMaxLines
 *      không cắt nổi câu thành mảnh nên mất luôn phép khớp mốc từng từ.
 *
 * CÁCH ĐO: rút THẲNG hàm thật trong nguồn ra chạy trong vm, theo đúng lối của
 * magic_fill_text_defaults.js. Node không có canvas nên phép đo chữ được thay bằng THƯỚC
 * ĐO TẤT ĐỊNH (bề rộng = số ký tự × 10) — thuật toán vẫn là thuật toán thật, chỉ cái
 * thước là giả, và giả một cách biết trước.
 *
 * Chạy: npm run test:subtitle-langs
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const runtimeSrc = read('static', 'js', 'editing-runtime.js');
const panelSrc = read('static', 'js', 'auto-subtitle.js');
const serverSrc = read('backend', 'server.js');
const sidecarSrc = read('asr', 'windows_faster_whisper_sidecar.py');

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
    assert.ok(m, `không tìm thấy hằng ${name} trong nguồn`);
    return m[1].trim();
}

/* ---------- 1. Font CJK có thật, và được khai đúng kiểu biến thiên ---------- */
{
    // EDITING_FONTS là mảng nhiều dòng -> cắt theo cặp ngoặc vuông thay vì regex một dòng.
    const start = runtimeSrc.indexOf('const EDITING_FONTS = [');
    assert.notStrictEqual(start, -1, 'không tìm thấy EDITING_FONTS');
    const open = runtimeSrc.indexOf('[', start);
    let depth = 0;
    let close = -1;
    for (let i = open; i < runtimeSrc.length; i += 1) {
        if (runtimeSrc[i] === '[') depth += 1;
        else if (runtimeSrc[i] === ']') { depth -= 1; if (depth === 0) { close = i; break; } }
    }
    assert.notStrictEqual(close, -1, 'không đóng được mảng EDITING_FONTS');
    const ALL_W = [100, 200, 300, 400, 500, 600, 700, 800, 900];
    const fonts = vm.runInNewContext(runtimeSrc.slice(open, close + 1), { ALL_W });

    const byFamily = new Map(fonts.map((f) => [f.family, f]));
    const langFonts = vm.runInNewContext(`(${extractConst(runtimeSrc, 'SUBTITLE_LANGUAGE_FONTS')})`);

    for (const [code, family] of Object.entries(langFonts)) {
        const font = byFamily.get(family);
        assert.ok(font, `ngôn ngữ '${code}' trỏ tới font '${family}' KHÔNG có trong EDITING_FONTS`);
        /* Font thiếu file thì trình duyệt không báo lỗi — nó rơi về font khác hoặc vẽ ô
           vuông, và cái đó đi thẳng vào bản xuất. Nên phải kiểm trên ĐĨA, không phải kiểm
           bảng khai. */
        const file = font.variable
            ? path.join(ROOT, 'static', 'fonts', 'google', font.folder, font.variable)
            : path.join(ROOT, 'static', 'fonts', 'google', font.folder, `${font.folder}_400Regular.ttf`);
        assert.ok(fs.existsSync(file), `thiếu tệp font cho '${family}': ${file}`);
        assert.ok(fs.statSync(file).size > 1024 * 1024,
            `'${family}' nhỏ bất thường (${file}) — bộ Latin không có glyph CJK nào`);
    }
    console.log('  ok  mọi font theo ngôn ngữ đều có mặt trên đĩa với kích thước của bộ CJK');

    /* Bản biến thiên PHẢI khai font-weight thành một DẢI. Khai một số duy nhất thì trục
       wght trong font không được nối vào: chọn SemiBold vẫn ra Regular, im lặng. */
    const faceCss = extractFunction(runtimeSrc, 'editingFontFaceCss');
    assert.ok(/font-weight:\s*100 900/.test(faceCss),
        'font biến thiên phải khai font-weight theo dải "100 900"');
    assert.ok(/truetype-variations/.test(faceCss),
        'font biến thiên phải khai format("truetype-variations")');
    console.log('  ok  @font-face của font biến thiên khai đúng dải độ dày');
}

/* ---------- 2. Ba danh sách ngôn ngữ khớp nhau ---------- */
{
    const panelCodes = new Set(
        Array.from(panelSrc.matchAll(/\{\s*id:\s*'([a-z]{2,4})',\s*label:[^}]*font:/g)).map((m) => m[1]),
    );
    assert.ok(panelCodes.size >= 6, `menu ngôn ngữ chỉ đọc ra ${panelCodes.size} mã — regex hỏng?`);
    for (const need of ['vi', 'en', 'zh', 'ja', 'ko', 'auto']) {
        assert.ok(panelCodes.has(need), `menu Auto Subtitle thiếu ngôn ngữ '${need}'`);
    }

    const serverCodes = new Set(
        vm.runInNewContext(`(${extractConst(serverSrc, 'SUBTITLE_LANGUAGES').replace(/^new Set\(/, '').replace(/\)$/, '')})`),
    );
    assert.deepStrictEqual([...panelCodes].sort(), [...serverCodes].sort(),
        'menu ở auto-subtitle.js và lọc trắng ở server.js phải cùng một bộ mã');

    const m = sidecarSrc.match(/SUPPORTED_LANGUAGES\s*=\s*\(([^)]*)\)/);
    assert.ok(m, 'không tìm thấy SUPPORTED_LANGUAGES trong sidecar');
    const sidecarCodes = new Set(Array.from(m[1].matchAll(/"([a-z]{2,4})"/g)).map((x) => x[1]));
    // Sidecar KHÔNG liệt 'auto' (ở đó auto = không ép ngôn ngữ, tức `language=None`).
    const expected = [...panelCodes].filter((c) => c !== 'auto').sort();
    assert.deepStrictEqual([...sidecarCodes].sort(), expected,
        'SUPPORTED_LANGUAGES ở sidecar phải khớp menu (trừ "auto")');
    console.log(`  ok  ba danh sách ngôn ngữ khớp nhau: ${expected.join(', ')} (+auto)`);

    // Tiếng Trung chỉ có MỘT mã ở Whisper; bản giản thể neo bằng initial_prompt.
    assert.ok(/SIMPLIFIED_CHINESE_PROMPT\s*=\s*"[^"]*[一-鿿][^"]*"/.test(sidecarSrc),
        'phải có initial_prompt viết bằng chữ giản thể để neo bộ chữ đầu ra');
    assert.ok(/initial_prompt=initial_prompt/.test(sidecarSrc),
        'initial_prompt phải thật sự được truyền vào transcribe()');
    console.log('  ok  tiếng Trung giản thể được neo bằng initial_prompt và prompt đó có đi vào ASR');
}

/* ---------- 3. Ngắt dòng chữ CJK ---------- */
{
    const CHAR_PX = 10;
    const ctx = {
        font: '',
        letterSpacing: '',
        measureText: (s) => ({ width: Array.from(String(s)).length * CHAR_PX }),
    };
    const sandbox = {
        magicMeasureCtx: () => ctx,
        normalizeTextFontFamily: (f) => f,
        resolveFontWeight: (_f, w) => w,
        console,
    };
    vm.createContext(sandbox);
    /* Hai hằng này là REGEX có dấu `;` NGAY TRONG lớp ký tự, nên extractConst (cắt tới dấu
       `;` đầu tiên) sẽ xén cụt chúng. Lấy trọn DÒNG khai báo là đúng và đủ — cả hai đều
       viết gọn trên một dòng. */
    const constLine = (name) => {
        const line = runtimeSrc.split('\n').find((l) => l.includes(`const ${name} = /`));
        assert.ok(line, `không tìm thấy hằng ${name}`);
        return line.trim().replace(/^const /, 'var ');
    };
    vm.runInContext([
        constLine('CJK_CHAR_RE'),
        constLine('CJK_NO_LINE_START_RE'),
        extractFunction(runtimeSrc, 'wrapTokens'),
        extractFunction(runtimeSrc, 'magicWrap'),
    ].join('\n'), sandbox);

    const wrap = (text, maxWidth) => sandbox.magicWrap(text, 40, 'Noto Sans SC', 400, 0, maxWidth).lines;

    /* Tiếng Trung: 14 chữ, khổ 10 chữ/dòng -> PHẢI ra 2 dòng. Bản cũ ra đúng 1 dòng dài
       140px, tràn khỏi khung hình mà không có dấu hiệu gì. */
    const zh = '一起搭建一个老照片修复工作流';
    const zhLines = wrap(zh, 10 * CHAR_PX);
    assert.ok(zhLines.length >= 2, `chữ Hán phải ngắt được dòng, đang ra ${zhLines.length} dòng`);
    assert.strictEqual(zhLines.join(''), zh, 'ghép lại các dòng phải ra ĐÚNG câu gốc');
    assert.ok(!zhLines.join('').includes(' '), 'không được chèn dấu cách vào giữa hai chữ Hán');
    console.log('  ok  chữ Hán ngắt được dòng và không bị chèn dấu cách');

    // Tiếng Nhật: kana + hán trộn nhau, cùng luật.
    const ja = 'こんにちは世界これはテストです';
    const jaLines = wrap(ja, 8 * CHAR_PX);
    assert.ok(jaLines.length >= 2, 'chữ Nhật phải ngắt được dòng');
    assert.strictEqual(jaLines.join(''), ja, 'ghép lại phải ra đúng câu tiếng Nhật gốc');
    console.log('  ok  chữ Nhật (kana + hán) ngắt được dòng');

    /* KINSOKU: dấu câu đóng của CJK không được đứng đầu dòng. Không có luật này thì câu
       nào kết bằng "。" cũng có xác suất đẩy đúng một dấu chấm sang dòng hai. */
    const kin = wrap('一起搭建一个老照片修。', 10 * CHAR_PX);
    assert.ok(!kin.slice(1).some((l) => l.startsWith('。')), 'dấu "。" không được mở đầu một dòng');
    console.log('  ok  dấu câu đóng của CJK không rơi xuống đầu dòng');

    /* TEXT LATIN KHÔNG ĐƯỢC ĐỔI MỘT LI. Đây là phần Magic Fill và mọi textbox sẵn có đang
       dùng — sửa luật ngắt dòng mà làm lệch chỗ này là hỏng một tính năng khác. */
    const en = 'the quick brown fox jumps over';
    const enLines = wrap(en, 12 * CHAR_PX);
    assert.ok(enLines.length >= 2, 'câu tiếng Anh dài phải ngắt dòng');
    assert.strictEqual(enLines.join(' '), en, 'chữ Latin phải nối lại bằng ĐÚNG một dấu cách');
    assert.ok(enLines.every((l) => Array.from(l).length <= 12 || !l.includes(' ')),
        'không dòng Latin nào được vượt khổ khi còn chỗ ngắt');
    /* Một TỪ dài hơn cả dòng vẫn phải được giữ nguyên, không cắt ra mảnh rỗng (và không
       lặp vô hạn). Sao chép mảng sang mảng của realm này trước khi so: mảng do vm trả về
       mang prototype của realm khác nên deepStrictEqual bắt lỗi dù nội dung y hệt. */
    assert.deepStrictEqual([...wrap('supercalifragilistic', 5 * CHAR_PX)], ['supercalifragilistic'],
        'từ Latin dài hơn khổ dòng phải được giữ nguyên');
    console.log('  ok  chữ Latin ngắt dòng y như trước (nối bằng một dấu cách, không cắt từ)');

    // Trộn hai hệ chữ trong một câu: tên riêng Latin nằm giữa chữ Hán.
    const mixed = '这是 CrabbyCut 的字幕';
    const mixedLines = wrap(mixed, 6 * CHAR_PX);
    assert.strictEqual(
        mixedLines.map((l, i) => (i ? l : l)).join('').replace(/\s+/g, ''),
        mixed.replace(/\s+/g, ''),
        'câu trộn Hán + Latin phải giữ đủ ký tự sau khi ngắt dòng',
    );
    console.log('  ok  câu trộn chữ Hán và chữ Latin không mất ký tự');
}

/* ---------- 4. Kiểu chữ mặc định của phụ đề ---------- */
{
    const fn = extractFunction(runtimeSrc, 'subtitleTextStyle');
    // Số liệu chốt theo nhánh "Tạo video AI" (v2.0.1) + ảnh tham chiếu người dùng gửi.
    assert.ok(/bg_enabled:\s*true/.test(fn), 'phụ đề phải bật nền');
    assert.ok(/bg_color:\s*'#000000'/.test(fn), "nền phụ đề phải là '#000000'");
    assert.ok(/bg_radius:\s*scaledTextPx\(20\)/.test(fn), 'bo góc nền phải là 20 (theo lớp 1080)');
    assert.ok(/bg_opacity:\s*25/.test(fn), 'độ mờ nền phải là 25%');
    assert.ok(/font_weight:\s*resolveFontWeight\(family,\s*600\)/.test(fn),
        'phụ đề dùng SemiBold, khớp mặc định của "Tạo video AI"');
    /* bg_pad_x/y KHÔNG được ghim số: để null = "Auto" (0.28·cỡ chữ), nhờ vậy đổi cỡ chữ
       thì lề chữ↔mép nền vẫn đúng tỉ lệ. Ghim số cứng là lề sai ngay lần đổi cỡ đầu. */
    assert.ok(!/bg_pad_[xy]:/.test(fn), 'bg_pad_x/y phải để nguyên mặc định "Auto"');
    console.log('  ok  kiểu chữ mặc định của phụ đề khớp thiết kế (nền đen, R20, O25, SemiBold)');

    // Cờ "Đồng bộ các subtitle": mặc định BẬT, và dự án cũ (thiếu khoá) cũng phải ra BẬT.
    const sync = extractFunction(runtimeSrc, 'subtitleStyleSyncEnabled');
    assert.ok(/sync_style !== false/.test(sync),
        'dự án cũ không có khoá sync_style phải ra BẬT, không phải một hành vi thứ ba');
    assert.ok(/sync_style:\s*true/.test(panelSrc), 'bộ phụ đề mới phải bật sẵn đồng bộ');
    console.log('  ok  "Đồng bộ các subtitle" bật sẵn, và dự án cũ cũng ra bật');
}

/* ---------- 5. Ngôn ngữ phải nằm trong khoá cache ASR ---------- */
{
    /* Thiếu khoá này thì đổi ngôn ngữ rồi bấm "Tạo lại phụ đề" sẽ TRÚNG cache của lượt
       trước và trả về nguyên bản tiếng cũ — trông y như model bóc sai. */
    const fn = extractFunction(serverSrc, 'buildSubtitleAsrCacheKey');
    assert.ok(/language:\s*language \|\| 'vi'/.test(fn),
        'khoá cache bóc băng của Auto Subtitle phải gồm cả ngôn ngữ');
    console.log('  ok  ngôn ngữ nằm trong khoá cache ASR (đổi ngôn ngữ là cache trượt)');

    // Không truyền `language` -> sidecar giữ "vi": Transcribe và Magic Fill không đổi hành vi.
    assert.ok(/if code == "":\s*\n\s*return "vi", None/.test(sidecarSrc),
        'thiếu khoá language thì sidecar phải giữ mặc định "vi" như bản cũ');
    console.log('  ok  đường Transcribe/Magic Fill (không truyền language) vẫn mặc định "vi"');
}

/* ---------- 6. Vòng đời: dọn khi sang dự án khác, đi theo tệp khi lưu/gói ---------- */
{
    const indexSrc = read('index.html');

    /* "Dự án mới" phải dọn SỔ PHỤ ĐỀ cùng lúc với editingItems. Giữ sổ mà xoá block là một
       trạng thái không tồn tại thật, và hậu quả nặng nhất không phải ở giao diện: lượt Lưu
       đầu tiên của dự án mới sẽ ghi bộ cue CŨ ra "<Dự án mới>.srt" (saveProject luôn gọi
       writeSrtFile) — dữ liệu dự án này trộn vào dự án khác, im lặng. */
    const reset = extractFunction(runtimeSrc, 'resetProjectState');
    assert.ok(/subtitleState = null;/.test(reset),
        '"Dự án mới" phải dọn subtitleState — nếu không, lượt Lưu đầu tiên ghi phụ đề dự án cũ ra .srt mới');
    console.log('  ok  "Dự án mới" dọn sổ phụ đề cùng với block');

    /* Mở dự án khác: restoreHistoryState() đặt lại khoá này, NHƯNG nó chỉ chạy `if (history)`
       — tệp .crab đời cũ không có `history` thì sổ của dự án trước sống sót qua. */
    assert.ok(/EditingRuntime\?\.setSubtitleState\?\.\(null\)/.test(indexSrc),
        'mở dự án khác cũng phải dọn sổ phụ đề (tệp .crab cũ có thể không có `history`)');
    console.log('  ok  mở dự án khác cũng dọn sổ phụ đề');

    // Lưu / Lưu thành: .srt được ghi lại cạnh .crab ở MỌI lượt Lưu, sau khi đường dẫn đã đổi.
    const save = indexSrc.slice(indexSrc.indexOf('async function saveProject('));
    const body = save.slice(0, save.indexOf('\n    }\n'));
    assert.ok(body.indexOf('currentProjectPath = result.path') < body.indexOf('writeSrtFile'),
        'writeSrtFile phải chạy SAU khi currentProjectPath đổi, nếu không "Lưu thành" ghi .srt về thư mục cũ');
    console.log('  ok  "Lưu thành" ghi .srt vào thư mục MỚI (thứ tự đúng)');

    // Đóng gói: .srt dựng lại từ timeline rồi truyền xuống main, không chép tệp cũ.
    assert.ok(/AutoSubtitlePanel\?\.currentSrtText\?\.\(\)/.test(indexSrc),
        'đóng gói phải dựng lại .srt từ timeline (tệp trên đĩa có thể đã cũ hơn hoặc không còn)');
    const pkgSrc = read('electron', 'project-package.js');
    assert.ok(/subtitleState\.srt_path = `\$\{folder\}\.srt`/.test(pkgSrc),
        'gói phải ghi srt_path TƯƠNG ĐỐI để mang gói đi đâu cũng đúng');
    assert.ok(/function resolveSubtitlePath/.test(pkgSrc), 'phải có đường re-link .srt lúc mở');
    console.log('  ok  đóng gói: .srt dựng lại tại chỗ, đường dẫn ghi tương đối');

    /* Tệp .srt phải nằm CẠNH .crab và mang ĐÚNG tên .crab — giao ước này là thứ khiến lần ghi
       sau đè lên bản cũ thay vì rải ra một đống .srt mồ côi, và cũng là thứ khiến re-link suy
       ra được vị trí mới mà không phải hỏi người dùng. Hai chỗ ghi .srt phải cùng giao ước. */
    const mainSrc = read('electron', 'main.js');
    assert.ok(/\.replace\(\/\\\.crab\$\/i, ''\)/.test(mainSrc), 'lượt Lưu: .srt lấy đúng tên .crab');
    assert.ok(/writeSrtTo\(finalPath, text\)/.test(mainSrc),
        'lượt Lưu phải dùng CHUNG writeSrtTo với lượt Đóng gói — hai chỗ tự ghi riêng là lệch định dạng');
    console.log('  ok  hai đường ghi .srt dùng chung một hàm và một giao ước đặt tên');
}

console.log('subtitle_language_fonts: PASS');
