/* Test PHÉP LẤY MỐC TỪNG TỪ cho tính năng "Sắp xếp timeline theo kịch bản".
 *
 * ĐIỀU ĐANG ĐƯỢC BẢO VỆ — cả ba đều SAI IM LẶNG nếu vỡ:
 *
 *  1. LẤY THEO ĐIỂM GIỮA CỦA TỪ. Backend nói "mảnh này gồm từ 3..7", renderer cắt bằng
 *     buildSplitTimelineItems cũng chia theo điểm giữa. Hai bên dùng luật khác nhau là
 *     mảnh lệch một từ, và điểm cắt rơi vào giữa âm tiết.
 *
 *  2. CỔNG "BẢN BÓC BĂNG CÓ PHỦ NỔI TIMELINE KHÔNG". Block trên timeline sinh ra từ lời
 *     nói đã khớp kịch bản, nên block KHÔNG có từ nào nghĩa là dòng từ này thuộc video
 *     khác (mở lại dự án từ .crab, hoặc đã ingest lại nguồn). Cổng này quyết định có bóc
 *     băng lại cả video hay không; hỏng theo chiều "luôn thấy phủ" thì tính năng so khớp
 *     trên dữ liệu lạc mà không ai biết.
 *
 *  3. KHÔNG NỐI AUDIO ĐỂ BÓC BĂNG LẠI. Bài học đắt nhất của tính năng: bản đầu bóc băng
 *     lại các khoảng ĐÃ NỐI, đo trên dự án thật ra 157 từ với ~60 từ ảo giác và mất trắng
 *     7,1 giây đầu (7/17 câu). Lấy mốc từ bản bóc băng CẢ VIDEO rồi cắt: 243 từ, 17/17 câu.
 *     Test này khoá lại hình dạng "cắt từ một dòng từ liền mạch".
 */
const assert = require('assert');
const path = require('path');

// Thư mục tạm riêng: require server.js kéo theo ensureDirs().
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR
    || path.join(__dirname, '..', '..', 'test_temp', 'timeline_words_slice');

const { flattenSessionWords, sliceWordsByBlocks, sessionWordsCoverBlocks } = require('../../backend/server');

function testFlatten() {
    const segments = [
        { start: 0, end: 2, loudness_dBFS: -17, words: [
            { word: 'một', start: 0.1, end: 0.4 },
            { word: ' hệ ', start: 0.4, end: 0.7 },
            { word: '', start: 0.7, end: 0.9 },          // rỗng: bỏ
            { word: 'miễn', start: 0.9, end: 1.2 },
            { word: 'lỗi', start: 1.5, end: 1.5 },        // end <= start: bỏ
        ] },
        // Segment đứng sau trong mảng nhưng SỚM hơn về thời gian -> phải được sắp lại.
        { start: 0, end: 0.1, loudness_dBFS: -20, words: [{ text: 'ĐẦU', start: 0.0, end: 0.05 }] },
        { start: 3, end: 4, words: null },
    ];
    const words = flattenSessionWords(segments);
    assert.deepStrictEqual(words.map((w) => w.text), ['ĐẦU', 'một', 'hệ', 'miễn'],
        'phải bỏ từ rỗng/mốc hỏng, trim khoảng trắng, và SẮP THEO THỜI GIAN');
    assert.strictEqual(words[0].loudness_dBFS, -20, 'độ ồn phải lấy theo segment chứa từ');
    // Nhận cả khoá 'word' (ASR thô) lẫn 'text' (sub_segments đã chuẩn hoá).
    assert.strictEqual(words[1].text, 'một');
    console.log('  ok  gom dòng từ: bỏ từ hỏng, nhận cả word/text, sắp theo thời gian');
}

function testSliceByMidpoint() {
    // Từ nằm vắt qua biên block: điểm giữa quyết định nó thuộc bên nào.
    const words = [
        { text: 'a', start: 0.0, end: 1.0, loudness_dBFS: -17 },   // giữa 0.5 -> block1
        { text: 'b', start: 1.4, end: 2.6, loudness_dBFS: -17 },   // giữa 2.0 -> block1 (biên 2.0)
        { text: 'c', start: 2.4, end: 3.0, loudness_dBFS: -17 },   // giữa 2.7 -> block2
        { text: 'd', start: 9.0, end: 9.5, loudness_dBFS: -17 },   // ngoài mọi block
    ];
    const blocks = [{ index: 0, start: 0, end: 2.0 }, { index: 1, start: 2.0, end: 4.0 }];
    const out = sliceWordsByBlocks(words, blocks);
    assert.deepStrictEqual(out[0].sub_segments.map((w) => w.text), ['a', 'b'],
        'từ có điểm giữa đúng ở biên phải thuộc block trước');
    assert.deepStrictEqual(out[1].sub_segments.map((w) => w.text), ['c'],
        'từ vắt qua biên nhưng điểm giữa ở block sau thì thuộc block sau');
    // Không được nhân đôi hay bỏ sót từ nào nằm trong vùng đã phủ.
    const total = out.reduce((n, b) => n + b.sub_segments.length, 0);
    assert.strictEqual(total, 3, 'từ ngoài mọi block bị bỏ, từ trong vùng không được nhân đôi');
    // text dựng lại TỪ CHÍNH CÁC TỪ — đây là điểm cốt tử: bản đầu dùng item.text của
    // renderer, mà text đó bị nhân 2-3 lần nên bộ so khớp nhận rác.
    assert.strictEqual(out[0].text, 'a b');
    assert.strictEqual(out[1].text, 'c');
    // Giữ nguyên index/khoảng của block để backend ghép kết quả về đúng chỗ.
    assert.deepStrictEqual(out.map((b) => b.index), [0, 1]);
    assert.strictEqual(out[1].start, 2.0);
    console.log('  ok  cắt dòng từ: theo điểm giữa, không nhân đôi, text dựng từ chính các từ');
}

function testCoverageGate() {
    const words = [
        { text: 'x', start: 1.0, end: 1.4, loudness_dBFS: 0 },
        { text: 'y', start: 5.0, end: 5.4, loudness_dBFS: 0 },
    ];
    assert.strictEqual(
        sessionWordsCoverBlocks(words, [{ index: 0, start: 0, end: 2 }, { index: 1, start: 4, end: 6 }]),
        true, 'mọi block có từ -> dùng được bản bóc băng hiện có');
    assert.strictEqual(
        sessionWordsCoverBlocks(words, [{ index: 0, start: 0, end: 2 }, { index: 1, start: 40, end: 60 }]),
        false, 'một block không có từ nào -> PHẢI bóc băng lại, không so khớp trên dữ liệu lạc');
    assert.strictEqual(sessionWordsCoverBlocks([], [{ index: 0, start: 0, end: 2 }]), false,
        'không có từ nào -> phải bóc băng lại');
    assert.strictEqual(sessionWordsCoverBlocks(words, []), false, 'không có block -> không có gì để phủ');
    console.log('  ok  cổng phủ: thiếu từ ở bất kỳ block nào là phải bóc băng lại cả video');
}

console.log('Mốc từng từ cho sắp xếp theo kịch bản');
testFlatten();
testSliceByMidpoint();
testCoverageGate();
console.log('\ntimeline words slice ok');
process.exit(0);
