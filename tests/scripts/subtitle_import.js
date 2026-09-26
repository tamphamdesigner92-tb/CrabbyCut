/**
 * Test cho Văn bản → Local Subtitle (nhập tệp phụ đề có sẵn).
 *
 * Canh bốn chỗ dễ hỏng ÂM THẦM nhất:
 *
 *   1. BỘ ĐỌC ĐỊNH DẠNG (static/js/subtitle-formats.js). Mỗi định dạng có một cái bẫy trông
 *      "vẫn đúng" khi nhìn lướt: phần lẻ ".5" của SRT là 500 ms chứ không phải 5 ms; dấu phẩy
 *      trong câu thoại .ass không được cắt cụt câu; khung hình/tick của TTML phải tra
 *      frameRate/tickRate; LRC không có mốc kết.
 *   2. CUE CHỒNG NHAU. .srt làm tròn ms chồng nhau vài chục ms ở mọi chỗ chuyển câu — để lọt
 *      là mỗi câu bị đẩy sang một lane mới.
 *   3. ĐẶT LÊN TIMELINE (static/js/local-subtitle.js): "Vị trí playhead", timecode 01:00:00,
 *      câu ngoài timeline, nhập lại cùng tệp phải THAY chứ không chồng.
 *   4. NHIỀU BỘ SONG SONG (editing-runtime.js): đồng bộ kiểu chữ chỉ lan TRONG một bộ, xoá
 *      một bộ không đụng bộ khác, gọi không kèm id vẫn là bộ Auto Subtitle như cũ.
 *
 * Chạy trên DOM giả, không cần trình duyệt.
 * Chạy: npm run test:subtitle-import
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SF = require(path.join(ROOT, 'static', 'js', 'subtitle-formats.js'));

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

/* ---------- 1. Bộ đọc định dạng ---------- */
{
    // SRT: thẻ định dạng, {\an8}, thiếu dòng trống giữa hai cue, phần lẻ thiếu chữ số.
    const srt = [
        '1',
        '00:00:01,5 --> 00:00:03,000',
        '<i>Xin chào</i> {\\an8}các bạn',
        'dòng hai &amp; ba',
        '2',
        '00:00:04.250 --> 00:00:06,000',
        '<font color="#ff0">Câu thứ hai</font>',
        '',
        '3',
        '01:02 --> 01:05',
        'Không có giờ',
        '',
    ].join('\r\n');
    const cues = SF.parseArrowCues(srt);
    assert.strictEqual(cues.length, 3, 'SRT phải đọc đủ 3 cue kể cả khi thiếu dòng trống');
    near(cues[0].start, 1.5, '",5" là 500 ms, không phải 5 ms');
    assert.strictEqual(cues[0].text, 'Xin chào các bạn\ndòng hai & ba', 'bỏ thẻ, giải thực thể, GIỮ xuống dòng');
    assert.strictEqual(cues[1].text, 'Câu thứ hai');
    near(cues[2].start, 62, '"01:02" = 1 phút 2 giây');
    console.log('  ok  SRT: thẻ, thực thể, phần lẻ, thiếu dòng trống');

    // VTT: header, NOTE, id cue, cue settings, <v>, mốc từng từ, ruby.
    const vtt = [
        'WEBVTT - tiêu đề',
        'Kind: captions',
        '',
        'NOTE ghi chú',
        'nhiều dòng',
        '',
        'intro',
        '00:01.000 --> 00:02.500 align:start position:10%',
        '<v Lan>Chào <00:01.500>anh</v>',
        '',
        '00:00:03.000 --> 00:00:04.000',
        '<ruby>漢<rt>kan</rt></ruby>字',
    ].join('\n');
    const v = SF.parseSubtitleText(vtt, 'a.vtt');
    assert.strictEqual(v.format, 'vtt');
    assert.strictEqual(v.cues.length, 2, 'NOTE không phải cue');
    assert.strictEqual(v.cues[0].text, 'Chào anh', 'bỏ <v> và mốc từng từ');
    near(v.cues[0].end, 2.5, 'cue settings sau mốc kết không được làm hỏng mốc');
    assert.strictEqual(v.cues[1].text, '漢字', 'phiên âm <rt> phải bỏ cả nội dung');
    console.log('  ok  WebVTT: header, NOTE, settings, <v>, ruby');

    // ASS: dấu phẩy trong câu, override, \N, chế độ vẽ, Comment.
    const ass = [
        '[Script Info]',
        'Title: x',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname',
        'Style: Default,Arial',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\b1}Một, hai,{\\b0} ba\\Nbốn',
        'Comment: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,ghi chú của người dịch',
        'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}Chữ thật',
    ].join('\n');
    const a = SF.parseSubtitleText(ass, 'x.ass');
    assert.strictEqual(a.format, 'ass');
    assert.strictEqual(a.cues.length, 2, 'Comment: không phải thoại');
    assert.strictEqual(a.cues[0].text, 'Một, hai, ba\nbốn', 'dấu phẩy trong câu phải giữ, \\N là xuống dòng');
    near(a.cues[0].end, 2.5, 'phần trăm giây của ASS');
    assert.strictEqual(a.cues[1].text, 'Chữ thật', 'lệnh vẽ vector không được lọt thành chữ');
    console.log('  ok  ASS/SSA: dấu phẩy, override, \\N, chế độ vẽ, Comment');

    // TTML/DFXP: tiền tố namespace, frames, ticks, dur, <br/>, <span>, thụt lề.
    const ttml = `<?xml version="1.0" encoding="UTF-8"?>
<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
       ttp:frameRate="25" ttp:tickRate="10000000">
  <tt:body><tt:div>
    <tt:p begin="00:00:01:12" end="00:00:03:00">Dòng
        một<tt:br/>dòng <tt:span tts:color="red">hai</tt:span></tt:p>
    <tt:p begin="40000000t" dur="2s">Tick &amp; dur</tt:p>
    <tt:p begin="7.5s" end="9000ms">Offset</tt:p>
  </tt:div></tt:body>
</tt:tt>`;
    const t = SF.parseSubtitleText(ttml, 'captions.xml');
    assert.strictEqual(t.format, 'ttml');
    assert.strictEqual(t.cues.length, 3);
    near(t.cues[0].start, 1 + 12 / 25, 'khung hình tính theo ttp:frameRate');
    assert.strictEqual(t.cues[0].text, 'Dòng một\ndòng hai', 'thụt lề trong XML là dấu cách, <br/> mới là xuống dòng');
    near(t.cues[1].start, 4, 'tick tính theo ttp:tickRate');
    near(t.cues[1].end, 6, 'dur cộng vào begin');
    near(t.cues[2].end, 9, '"9000ms"');
    console.log('  ok  TTML/DFXP: namespace, khung hình, tick, dur, <br/>');

    // XML dự án của NLE không phải phụ đề -> báo rõ, không im lặng ra 0 câu.
    assert.throws(() => SF.parseSubtitleText('<?xml version="1.0"?><xmeml version="5"></xmeml>', 'seq.xml'),
        /XML dự án/, 'xmeml phải bị từ chối với câu giải thích');

    // LRC: offset, nhiều mốc một dòng, dòng rỗng = hết câu, dòng cuối.
    const lrc = [
        '[ti:Bài hát]',
        '[offset:+500]',
        '[00:01.00][00:10.00]Điệp khúc',
        '[00:05.00]Lời <00:05.50>một',
        '[00:07.00]',
    ].join('\n');
    const l = SF.parseSubtitleText(lrc, 'song.lrc');
    assert.strictEqual(l.format, 'lrc');
    assert.strictEqual(l.cues.length, 3);
    near(l.cues[0].start, 0.5, '[offset:+500] hiện lời sớm hơn 500 ms');
    near(l.cues[1].end, 6.5, 'dòng rỗng có mốc là mốc kết của dòng trước');
    assert.strictEqual(l.cues[1].text, 'Lời một', 'bỏ mốc từng từ');
    near(l.cues[2].end - l.cues[2].start, 4, 'dòng cuối kéo 4 giây');
    console.log('  ok  LRC: offset, nhiều mốc, dòng rỗng, dòng cuối');

    const sbv = '0:00:01.000,0:00:02.000\nMột[br]hai\n\n0:00:03.000,0:00:04.000\nBa\n';
    const s = SF.parseSubtitleText(sbv, 'yt.sbv');
    assert.strictEqual(s.format, 'sbv');
    assert.strictEqual(s.cues[0].text, 'Một\nhai');
    console.log('  ok  SBV + từ chối XML dự án NLE');

    // Nội dung thắng đuôi tệp: .txt chứa SRT, .srt thực ra là VTT.
    assert.strictEqual(SF.detectFormat('1\n00:00:01,000 --> 00:00:02,000\nx', 'a.txt'), 'srt');
    assert.strictEqual(SF.detectFormat('WEBVTT\n\n00:01.000 --> 00:02.000\nx', 'a.srt'), 'vtt');
    assert.throws(() => SF.parseSubtitleText('chỉ là văn bản', 'a.txt'), /Không nhận ra/);
    console.log('  ok  nhận diện theo nội dung trước đuôi tệp');
}

/* ---------- 2. Cue chồng nhau ---------- */
{
    const { cues, trimmed, merged } = SF.tidyCues([
        { start: 3, end: 5, text: 'C' },
        { start: 0, end: 2.02, text: 'A' },       // chồng 20 ms lên B -> cắt đuôi A
        { start: 2, end: 3, text: 'B' },
        { start: 3.1, end: 4, text: 'D' },        // bắt đầu gần như cùng C -> gộp
        { start: 6, end: 6, text: 'rỗng mốc' },   // end <= start -> bỏ
        { start: 7, end: 8, text: '   ' },        // không chữ -> bỏ
    ]);
    assert.deepStrictEqual(cues.map((c) => c.text), ['A', 'B', 'C\nD']);
    near(cues[0].end, 2, 'đuôi A cắt đúng tại mốc bắt đầu của B');
    near(cues[2].end, 5, 'gộp giữ mốc kết xa nhất');
    assert.strictEqual(trimmed, 1);
    assert.strictEqual(merged, 1);
    assert.ok(cues.every((c, i) => i === 0 || c.start >= cues[i - 1].end), 'không còn hai cue chồng nhau');
    console.log('  ok  cue chồng nhau: cắt đuôi / gộp, không mất chữ');
}

/* ---------- 3. Mã hoá ký tự + ngôn ngữ ---------- */
{
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nTiếng Việt\n';
    const utf8 = Buffer.from(srt, 'utf8');
    const withBom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), utf8]);
    assert.strictEqual(SF.decodeSubtitleBytes(withBom).text, srt, 'BOM UTF-8 phải bị bỏ');
    const u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(srt, 'utf16le')]);
    assert.strictEqual(SF.decodeSubtitleBytes(u16).text, srt, 'UTF-16LE có BOM');
    assert.strictEqual(SF.decodeSubtitleBytes(Buffer.from(srt, 'utf16le')).text, srt, 'UTF-16LE KHÔNG BOM');
    const plain = SF.decodeSubtitleBytes(utf8);
    assert.strictEqual(plain.fallback, false);
    // "Việt" trong Windows-1258: V i 0xEA 0xF2 t (ê + dấu nặng tổ hợp) — không phải UTF-8 hợp lệ.
    const legacy = SF.decodeSubtitleBytes(Buffer.from([0x56, 0x69, 0xEA, 0xF2, 0x74]));
    assert.strictEqual(legacy.fallback, true, 'không phải UTF-8 thì phải báo là đã đoán bảng mã');
    assert.strictEqual(legacy.text.normalize('NFC'), 'Việt');

    assert.strictEqual(SF.detectLanguage([{ text: '안녕하세요' }]), 'ko');
    assert.strictEqual(SF.detectLanguage([{ text: '今日はいい天気' }]), 'ja', 'có kana là tiếng Nhật dù có Hán tự');
    assert.strictEqual(SF.detectLanguage([{ text: '你好 world' }]), 'zh');
    assert.strictEqual(SF.detectLanguage([{ text: 'Xin chào' }]), '');
    console.log('  ok  BOM / UTF-16 / Windows-1258, đoán ngôn ngữ theo chữ viết');
}

/* ---------- 4. Đặt lên timeline (local-subtitle.js) ---------- */
function makeEnv() {
    const win = {
        document: {
            getElementById: () => null,
            createElement: () => ({}),
            head: { insertBefore: () => {} },
        },
        setTimeout, clearTimeout, console,
        SubtitleFormats: SF,
    };
    return win;
}

function loadScript(win, relPath) {
    const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    new Function('window', 'document', 'setTimeout', 'clearTimeout', 'console', 'API_BASE', src)(
        win, win.document, setTimeout, clearTimeout, console, '/api');
}

function fakeRuntime({ total = 60, playhead = 0 } = {}) {
    const items = [];
    let imports = [];
    let auto = { id: 'sub_auto', item_ids: ['auto_1'] };
    let batches = 0;
    let nextId = 0;   // KHÔNG dùng items.length: mảng co lại sau khi gỡ là id bị trùng
    return {
        items,
        batches: () => batches,
        timelineDuration: () => total,
        currentSequenceTime: () => playhead,
        subtitleTextStyle: (lang) => ({ font_family: lang === 'ja' ? 'Noto Sans JP' : 'Nunito' }),
        subtitleFontForLanguage: (lang) => (lang === 'ja' ? 'Noto Sans JP' : 'Nunito'),
        beginHistoryBatch: () => { batches += 1; return () => {}; },
        addTextItem: (placement, options) => {
            // Kẹp như resolveNewItemPlacement: không vượt quá cuối timeline.
            const duration = Math.min(options.duration, total - placement.start);
            const item = { id: `t${++nextId}`, timeline_start: placement.start, duration, text: options.text, options };
            items.push(item);
            return item;
        },
        removeSubtitleItems: (setId) => {
            const set = setId ? imports.find((s) => s.id === setId) : auto;
            const ids = new Set(set?.item_ids || []);
            const before = items.length;
            for (let i = items.length - 1; i >= 0; i -= 1) if (ids.has(items[i].id)) items.splice(i, 1);
            return before - items.length;
        },
        getSubtitleImports: () => JSON.parse(JSON.stringify(imports)),
        setSubtitleImports: (list) => { imports = JSON.parse(JSON.stringify(list)); return list; },
        getSubtitleState: () => auto,
        setSubtitleState: (next) => { auto = next; },
        subtitleCuesFromItems: () => [],
        renderAll: () => {},
        renderEditPanel: () => {},
    };
}

{
    const win = makeEnv();
    const ER = fakeRuntime({ total: 60, playhead: 10 });
    win.EditingRuntime = ER;
    loadScript(win, 'static/js/local-subtitle.js');
    const panel = win.LocalSubtitlePanel;
    assert.ok(panel, 'local-subtitle.js phải mở window.LocalSubtitlePanel');

    const parsed = SF.parseSubtitleText([
        '1', '00:00:01,000 --> 00:00:03,000', 'Dòng một', 'Line one', '',
        '2', '00:00:58,000 --> 00:01:05,000', 'Tràn cuối', '',
        '3', '00:02:00,000 --> 00:02:02,000', 'Ngoài timeline', '',
    ].join('\n'), 'phim.vi.srt');

    const r1 = panel.applyImport(parsed, { fileName: 'phim.vi.srt' });
    assert.strictEqual(r1.count, 2, 'câu nằm hẳn ngoài timeline phải bị bỏ, không dồn về mép cuối');
    assert.strictEqual(r1.skipped, 1);
    assert.strictEqual(r1.clamped, 1, 'câu tràn qua cuối timeline phải được đếm để báo');
    near(ER.items[0].timeline_start, 1, '"Đầu timeline": mốc trong tệp = mốc timeline');
    assert.strictEqual(ER.items[0].text, 'Dòng một\nLine one');
    assert.strictEqual(ER.items[0].options.keepLineBreaks, true, 'phải giữ cách ngắt dòng của tệp');
    assert.strictEqual(ER.items[0].options.defer, true, 'dựng hàng loạt phải defer lượt vẽ');
    const sets1 = ER.getSubtitleImports();
    assert.strictEqual(sets1.length, 1);
    assert.strictEqual(sets1[0].name, 'phim.vi');
    assert.strictEqual(sets1[0].sync_style, true, 'bộ mới bật sẵn "Đồng bộ các subtitle"');
    assert.deepStrictEqual(ER.getSubtitleState().item_ids, ['auto_1'], 'bộ Auto Subtitle không được bị động tới');

    // Tệp thứ hai (tiếng Anh) -> một bộ MỚI, song song.
    panel.state.startAt = 'playhead';
    const en = SF.parseSubtitleText('1\n00:00:01,000 --> 00:00:02,000\nHello\n', 'phim.en.srt');
    panel.applyImport(en, { fileName: 'phim.en.srt' });
    near(ER.items[ER.items.length - 1].timeline_start, 11, '"Vị trí playhead": 00:00 của tệp đặt tại playhead (10 s)');
    assert.strictEqual(ER.getSubtitleImports().length, 2, 'tệp khác tên phải thành bộ riêng');

    // Nhập lại ĐÚNG tệp cùng tên (khác hoa/thường) -> THAY bộ cũ, giữ id và vị trí trong danh sách.
    panel.state.startAt = 'zero';
    const idBefore = ER.getSubtitleImports()[0].id;
    const again = SF.parseSubtitleText('1\n00:00:05,000 --> 00:00:06,000\nBản sửa\n', 'PHIM.VI.SRT');
    const r3 = panel.applyImport(again, { fileName: 'PHIM.VI.SRT' });
    assert.strictEqual(r3.replaced, true);
    const sets3 = ER.getSubtitleImports();
    assert.strictEqual(sets3.length, 2, 'nhập lại không được đẻ thêm bộ');
    assert.strictEqual(sets3[0].id, idBefore, 'bộ được thay giữ nguyên id và vị trí');
    assert.ok(!ER.items.some((it) => it.text === 'Dòng một\nLine one'), 'block của bộ cũ phải bị gỡ');
    assert.ok(ER.items.some((it) => it.text === 'Hello'), 'block của bộ KHÁC phải còn nguyên');

    // Timecode phát sóng 01:00:00 -> trừ giờ tròn và báo lại.
    const broadcast = SF.parseSubtitleText('1\n01:00:02,000 --> 01:00:04,000\nTC\n', 'bc.srt');
    const r4 = panel.applyImport(broadcast, { fileName: 'bc.srt' });
    assert.strictEqual(r4.shiftedHours, 1);
    near(ER.items[ER.items.length - 1].timeline_start, 2, '01:00:02 phải về 00:00:02');

    // Mọi câu ngoài timeline -> ném lỗi có câu giải thích, không dựng gì.
    const far = SF.parseSubtitleText('1\n00:05:00,000 --> 00:05:02,000\nXa\n', 'far.srt');
    const countBefore = ER.items.length;
    assert.throws(() => panel.applyImport(far, { fileName: 'far.srt' }), /nằm ngoài timeline/);
    assert.strictEqual(ER.items.length, countBefore);

    // Timeline trống.
    const emptyWin = makeEnv();
    emptyWin.EditingRuntime = fakeRuntime({ total: 0 });
    loadScript(emptyWin, 'static/js/local-subtitle.js');
    assert.throws(() => emptyWin.LocalSubtitlePanel.applyImport(en, { fileName: 'x.srt' }), /chưa có video/);

    // Xoá một bộ: chỉ block của bộ đó.
    const enSet = ER.getSubtitleImports().find((s) => s.source_name === 'phim.en.srt');
    const helloCount = ER.items.filter((it) => it.text === 'Hello').length;
    assert.strictEqual(helloCount, 1);
    panel.removeSet(enSet.id);
    assert.ok(!ER.items.some((it) => it.text === 'Hello'));
    assert.ok(ER.items.some((it) => it.text === 'Bản sửa'), 'xoá một bộ không được đụng bộ khác');
    assert.ok(!ER.getSubtitleImports().some((s) => s.id === enSet.id));
    console.log('  ok  đặt lên timeline: playhead, 01:00:00, ngoài timeline, thay/xoá đúng bộ');
}

/* ---------- 5. Nhiều bộ song song trong editing-runtime.js ---------- */
{
    /* Chạy THẬT khối hàm phụ đề của editing-runtime.js (từ `let subtitleState` tới hết
       removeSubtitleItems) với vài phụ thuộc giả — kiểm luật, không kiểm bản chép lại của luật. */
    const src = fs.readFileSync(path.join(ROOT, 'static', 'js', 'editing-runtime.js'), 'utf8');
    const from = src.indexOf('    let subtitleState = null;');
    const to = src.indexOf('    // ===== Chuyển cảnh (Transition)');
    assert.ok(from > 0 && to > from, 'không tìm thấy khối hàm phụ đề trong editing-runtime.js');
    const block = src.slice(from, to);
    const factory = new Function('env', `
        let editingItems = env.items;
        let selectedEditingItemId = '';
        let selectedEditingItemIds = new Set();
        const deepClone = (v) => JSON.parse(JSON.stringify(v || null));
        const isTrackLocked = (track) => !!(track && track.locked);
        const itemTrack = (it) => env.tracks[it.track_id];
        const renderAll = () => {};
        ${block}
        return {
            getItems: () => editingItems,
            setSubtitleState, getSubtitleState, setSubtitleImports, getSubtitleImports,
            isSubtitleItem, subtitleSyncTargets, subtitleStyleSyncEnabled, setSubtitleStyleSync,
            removeSubtitleItems, subtitleCuesFromItems,
        };`);
    const env = {
        tracks: { a: {}, b: {}, locked: { locked: true } },
        items: [
            { id: 'a1', track_id: 'a', timeline_start: 0, duration: 1, text: 'auto 1' },
            { id: 'a2', track_id: 'a', timeline_start: 1, duration: 1, text: 'auto 2' },
            { id: 'v1', track_id: 'b', timeline_start: 0, duration: 1, text: 'vi 1' },
            { id: 'v2', track_id: 'locked', timeline_start: 1, duration: 1, text: 'vi 2' },
            { id: 'x', track_id: 'a', timeline_start: 5, duration: 1, text: 'chữ người dùng' },
        ],
    };
    const R = factory(env);
    R.setSubtitleState({ id: 'sub_auto', item_ids: ['a1', 'a2'], sync_style: true });
    R.setSubtitleImports([{ id: 'imp_vi', name: 'vi', item_ids: ['v1', 'v2'] }]);   // thiếu sync_style = BẬT

    assert.ok(R.isSubtitleItem({ id: 'v1' }) && R.isSubtitleItem({ id: 'a2' }), 'block của mọi bộ đều là phụ đề');
    assert.ok(!R.isSubtitleItem({ id: 'x' }), 'chữ người dùng tự đặt không phải phụ đề');
    const targetsVi = R.subtitleSyncTargets({ id: 'v1' }).map((it) => it.id);
    assert.deepStrictEqual(targetsVi, ['v1'], 'đồng bộ chỉ lan TRONG bộ, và bỏ block ở lane khoá');
    assert.deepStrictEqual(R.subtitleSyncTargets({ id: 'a1' }).map((it) => it.id), ['a1', 'a2']);
    assert.strictEqual(R.subtitleStyleSyncEnabled('imp_vi'), true, 'bộ thiếu khoá sync_style ra BẬT');

    R.setSubtitleStyleSync(false, 'imp_vi');
    assert.strictEqual(R.subtitleStyleSyncEnabled('imp_vi'), false);
    assert.strictEqual(R.subtitleStyleSyncEnabled(), true, 'tắt bộ nhập không được tắt bộ Auto Subtitle');
    assert.deepStrictEqual(R.subtitleSyncTargets({ id: 'v1' }), []);

    assert.deepStrictEqual(R.subtitleCuesFromItems().map((c) => c.text), ['auto 1', 'auto 2'],
        'không truyền id = bộ Auto Subtitle, như hành vi cũ');
    assert.deepStrictEqual(R.subtitleCuesFromItems('imp_vi').map((c) => c.text), ['vi 1', 'vi 2']);

    assert.strictEqual(R.removeSubtitleItems('imp_vi'), 2);
    assert.deepStrictEqual(R.getItems().map((it) => it.id), ['a1', 'a2', 'x'], 'chỉ gỡ block của đúng bộ');
    assert.strictEqual(R.removeSubtitleItems(), 2, 'không truyền id = gỡ bộ Auto Subtitle');
    assert.deepStrictEqual(R.getItems().map((it) => it.id), ['x']);

    // Sổ nhập đi theo history/.crab qua getHistoryState; dự án cũ thiếu khoá -> [].
    assert.deepStrictEqual(R.setSubtitleImports(undefined), []);
    assert.ok(/subtitleImports: deepClone\(subtitleImports\)/.test(src), 'getHistoryState phải lưu subtitleImports');
    assert.ok(/setSubtitleImports\(state\.subtitleImports\)/.test(src), 'restore phải đọc lại subtitleImports');
    assert.ok(/subtitleImports = \[\];/.test(src), '"Dự án mới" phải dọn các bộ đã nhập');
    const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(/EditingRuntime\?\.setSubtitleImports\?\.\(\[\]\)/.test(indexSrc),
        'mở dự án khác phải dọn các bộ đã nhập (tệp .crab cũ có thể không có `history`)');
    console.log('  ok  nhiều bộ song song: đồng bộ/xoá theo từng bộ, mặc định vẫn là bộ Auto Subtitle');
}

/* ---------- 6. Vị trí trong giao diện ---------- */
{
    const src = fs.readFileSync(path.join(ROOT, 'static', 'js', 'editing-runtime.js'), 'utf8');
    const tabs = src.slice(src.indexOf('const EDIT_PANEL_SUBTABS = {'), src.indexOf('const BASIC_SHAPES'));
    const audio = tabs.slice(tabs.indexOf('audio:'), tabs.indexOf('text:'));
    const text = tabs.slice(tabs.indexOf('text:'), tabs.indexOf('shape:'));
    assert.ok(!/'subtitle'/.test(audio), 'Auto Subtitle không còn ở tab Âm thanh');
    assert.ok(/id: 'subtitle', label: 'Auto Subtitle'/.test(text), 'Auto Subtitle nằm ở tab Văn bản');
    assert.ok(/id: 'local-subtitle', label: 'Local Subtitle'/.test(text), 'Local Subtitle nằm ở tab Văn bản');
    console.log('  ok  Auto Subtitle + Local Subtitle nằm ở tab Văn bản');
}

console.log('subtitle_import: PASS');
