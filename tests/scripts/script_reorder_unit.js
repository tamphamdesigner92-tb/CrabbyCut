/* Test LOGIC THUẦN của tính năng "Sắp xếp timeline theo kịch bản chuẩn".
 *
 * ĐIỀU ĐANG ĐƯỢC BẢO VỆ:
 *
 *  1. BỘ TÁCH CÂU LÀ DUY NHẤT. Số hiệu câu (script_index) là khoá liên kết giữa kịch bản
 *     và mọi thứ backend trả về. Đối chiếu JS↔Python nằm ở tests/scripts/matching_pipeline.py;
 *     ở đây khoá lại các luật mà cả hai bên phải giữ (xuống dòng là ranh giới câu, không
 *     lọc câu ngắn, bóc đánh dấu đầu mục, loại ký tự vô hình).
 *
 *  2. LUẬT SẮP XẾP. Câu Hook quay ở giữa video phải lên đầu; block không khớp câu nào phải
 *     được GIỮ và dồn về cuối (quyết định của người dùng: không tự xoá dữ liệu); nhiều take
 *     của cùng một câu phải đứng LIỀN NHAU đúng vị trí câu đó; sort phải ỔN ĐỊNH.
 *
 *  3. GỘP MẨU LIỀN KỀ khi chốt Match Script -> Timeline. Chỉ mẩu SÁT CẠNH NHAU được gộp;
 *     mẩu cách nhau (quãng lặng, hoặc mẩu chưa tick chen giữa) phải để riêng — gộp lẫn vào
 *     là nối liền đúng đoạn người dùng chủ ý bỏ đi, và không có lỗi nào báo.
 *
 * KHÔNG CÒN TEST "kiểm chứng nhãn script_index": cơ chế đó đã bị gỡ khỏi sản phẩm
 * (2026-08-22). Nó dựa trên nhãn có sẵn ở step3, mà nhãn ấy do native addon ĐIỀN TRƯỢT nên
 * vô giá trị — đo trên dự án thật thì đường đi ấy cho ra "1 block đúng, 9 block dồn xuống
 * cuối". Nay tính năng bóc băng lại timeline rồi so khớp toàn bộ ở backend; phần đó được
 * canh bằng tests/scripts/script_reorder_align.py.
 */
const assert = require('assert');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SR = require(path.join(PROJECT_ROOT, 'static', 'js', 'script-reorder.js'));

// --- 1. Tách câu -----------------------------------------------------------

function testSplitSentences() {
    // Xuống dòng là ranh giới câu, kể cả khi dòng trên không có dấu chấm. Dán hai dòng
    // thành một câu thì câu đó không bao giờ khớp trọn một vùng nói, vì người quay đọc
    // chúng ở hai thời điểm khác nhau.
    assert.deepStrictEqual(
        SR.splitScriptSentences('Câu một không có dấu chấm\nCâu hai kết thúc đây.'),
        ['Câu một không có dấu chấm', 'Câu hai kết thúc đây.'],
    );
    // KHÔNG lọc câu ngắn: bỏ "Đúng vậy." là toàn bộ số hiệu phía sau lệch đi một.
    assert.deepStrictEqual(
        SR.splitScriptSentences('Đúng vậy. Ba mẹ nhớ bổ sung canxi nhé.'),
        ['Đúng vậy.', 'Ba mẹ nhớ bổ sung canxi nhé.'],
    );
    // Bóc đánh dấu đầu mục, nhưng KHÔNG xén câu mở đầu bằng số như "1,7g/100ml".
    assert.deepStrictEqual(
        SR.splitScriptSentences('1. Dinh dưỡng cân đối\n2) Ngủ sớm\n- Uống đủ nước'),
        ['Dinh dưỡng cân đối', 'Ngủ sớm', 'Uống đủ nước'],
    );
    assert.deepStrictEqual(
        SR.splitScriptSentences('1,7g/100ml là đủ.'),
        ['1,7g/100ml là đủ.'],
    );
    // Ký tự vô hình: tệp .md xuất từ Word hay dính U+FEFF; trim() của JS coi U+FEFF là
    // khoảng trắng nhưng KHÔNG coi U+200B là, nên phải loại tường minh.
    assert.deepStrictEqual(
        SR.splitScriptSentences('﻿Câu đầu.\nCâu sau​'),
        ['Câu đầu.', 'Câu sau'],
    );
    // Dòng trống và khoảng trắng thừa không sinh ra câu rỗng.
    assert.deepStrictEqual(SR.splitScriptSentences('\n\n  \t \n'), []);
    // Đường vẽ theo paragraph (renderer chia /\n{2,}/ trước) phải ra ĐÚNG dãy phẳng.
    const text = 'Câu A.\nCâu B.\n\nCâu C.';
    const perBlock = text.split(/\n{2,}/).flatMap((block) => SR.splitScriptPieces(block));
    assert.deepStrictEqual(perBlock, SR.splitScriptSentences(text));
    console.log('  ok  tách câu: xuống dòng / câu ngắn / đầu mục / ký tự vô hình / theo paragraph');
}

// --- 2. Luật sắp xếp ------------------------------------------------------

function testOrderPieces() {
    const pieces = [
        { id: 'a', scriptIndex: 2, start: 10, seq: 0 },
        { id: 'b', scriptIndex: -1, start: 20, seq: 1 },   // lạc: dồn về cuối
        { id: 'c', scriptIndex: 0, start: 90, seq: 2 },    // câu Hook quay ở CUỐI video
        { id: 'd', scriptIndex: 1, start: 30, seq: 3 },
        { id: 'e', scriptIndex: 0, start: 5, seq: 4 },     // take khác của câu Hook
        { id: 'f', scriptIndex: -1, start: 1, seq: 5 },    // lạc thứ hai
    ];
    const order = SR.orderPieces(pieces).map((piece) => piece.id);
    // Câu 0 (hai take, sắp theo thời gian) -> câu 1 -> câu 2 -> hai block lạc GIỮ THỨ TỰ CŨ.
    assert.deepStrictEqual(order, ['e', 'c', 'd', 'a', 'b', 'f']);

    // Sort phải ỔN ĐỊNH: cùng câu, cùng mốc thời gian thì giữ nguyên thứ tự cũ.
    const tie = SR.orderPieces([
        { id: 'x', scriptIndex: 4, start: 7, seq: 0 },
        { id: 'y', scriptIndex: 4, start: 7, seq: 1 },
        { id: 'z', scriptIndex: 4, start: 7, seq: 2 },
    ]).map((piece) => piece.id);
    assert.deepStrictEqual(tie, ['x', 'y', 'z']);
    console.log('  ok  sắp xếp: câu Hook ở cuối video lên đầu / take trùng liền nhau / block lạc dồn cuối / ổn định');
}

// --- 3. Tóm tắt kế hoạch --------------------------------------------------

function testSummarizePlan() {
    const ordered = [
        { blockIndex: 0, scriptIndex: 0, start: 0 },
        { blockIndex: 1, scriptIndex: 1, start: 5 },   // block 1 ra 2 mảnh -> bị cắt
        { blockIndex: 1, scriptIndex: 2, start: 8 },
        { blockIndex: 2, scriptIndex: 2, start: 40 },  // câu 2 có 2 take
        { blockIndex: 3, scriptIndex: -1, start: 60 }, // block lạc
    ];
    const summary = SR.summarizePlan(ordered, 5, 4);
    assert.strictEqual(summary.blockCount, 4);
    assert.strictEqual(summary.pieceCount, 5);
    assert.strictEqual(summary.splitBlockCount, 1, 'chỉ block 1 bị cắt');
    assert.strictEqual(summary.unmatchedPieceCount, 1);
    assert.strictEqual(summary.matchedSentenceCount, 3);
    assert.deepStrictEqual(summary.duplicateSentences, [{ scriptIndex: 2, count: 2 }]);
    assert.deepStrictEqual(summary.missingSentences, [3, 4]);
    console.log('  ok  tóm tắt: số mảnh / block bị cắt / block lạc / câu nhiều take / câu thiếu');
}

// --- 4. Gộp mẩu liền kề (Match Script -> Timeline) ------------------------

function chunk(start, end, scriptIndex, extra) {
    return Object.assign({
        start, end, script_index: scriptIndex,
        text: `nói${scriptIndex}`, matched_text: `nói${scriptIndex}`, script_text: `câu${scriptIndex}`,
        similarity: 1, token_coverage: 1, score: 1, loudness_dBFS: -17, is_selected: true,
    }, extra || {});
}

function testMergeAdjacent() {
    // Hai mẩu chia ĐÚNG một mốc -> gộp. Mẩu cách 4 giây -> để riêng.
    const out = SR.mergeAdjacentChunks([chunk(0, 2, 0), chunk(2, 5, 1), chunk(9, 11, 2)]);
    assert.strictEqual(out.length, 2, 'chỉ cặp liền kề được gộp');
    assert.strictEqual(out[0].start, 0);
    assert.strictEqual(out[0].end, 5);
    assert.strictEqual(out[0].text, 'nói0 nói1', 'lời nói phải được nối, không mất mẩu nào');
    // script_index giữ của mẩu ĐẦU theo thời gian, cả cụm dồn vào merged_script_indices —
    // cùng quy ước với _merge_close_or_overlapping_rows của pipeline.
    assert.strictEqual(out[0].script_index, 0);
    assert.deepStrictEqual(out[0].merged_script_indices, [0, 1]);
    assert.deepStrictEqual(out[1].merged_script_indices, [2]);

    // Khoảng cách ĐÚNG BẰNG dung sai thì vẫn là liền kề; nhích thêm một chút là không.
    assert.strictEqual(SR.mergeAdjacentChunks([chunk(0, 2, 0), chunk(2 + SR.ADJACENT_MERGE_SEC, 4, 1)]).length, 1);
    assert.strictEqual(SR.mergeAdjacentChunks([chunk(0, 2, 0), chunk(2 + SR.ADJACENT_MERGE_SEC + 0.002, 4, 1)]).length, 2,
        'mẩu chưa tick chen giữa (luôn dài hơn 0,02s) phải chặn việc gộp');

    // Đầu vào không theo thứ tự thời gian vẫn phải ra đúng: người dùng tick lung tung.
    const shuffled = SR.mergeAdjacentChunks([chunk(2, 5, 1), chunk(9, 11, 2), chunk(0, 2, 0)]);
    assert.deepStrictEqual(shuffled.map((c) => [c.start, c.end]), [[0, 5], [9, 11]]);

    // Ba mẩu liên tiếp gộp thành một, không phải hai.
    const three = SR.mergeAdjacentChunks([chunk(0, 1, 0), chunk(1, 2, 1), chunk(2, 3, 2)]);
    assert.strictEqual(three.length, 1);
    assert.deepStrictEqual(three[0].merged_script_indices, [0, 1, 2]);
    assert.strictEqual(three[0].end, 3);

    // Hai mẩu chồng nhau chút (do snap biên từ) -> end lấy MAX, không được làm block ngắn đi.
    const overlap = SR.mergeAdjacentChunks([chunk(0, 2.1, 0), chunk(2.0, 2.05, 1)]);
    assert.strictEqual(overlap.length, 1);
    assert.strictEqual(overlap[0].end, 2.1, 'end phải lấy max, không lấy end của mẩu sau');

    // Điểm chất lượng trung bình có TRỌNG SỐ THEO THỜI LƯỢNG: mẩu 0,5s không được kéo
    // điểm của mẩu 9,5s về giữa.
    const weighted = SR.mergeAdjacentChunks([
        chunk(0, 9.5, 0, { token_coverage: 1.0 }),
        chunk(9.5, 10, 1, { token_coverage: 0.0 }),
    ]);
    assert.ok(weighted[0].token_coverage > 0.9,
        `trung bình phải theo thời lượng, được ${weighted[0].token_coverage}`);

    // Không có gì để gộp / đầu vào rác thì không nổ.
    assert.deepStrictEqual(SR.mergeAdjacentChunks([]), []);
    assert.deepStrictEqual(SR.mergeAdjacentChunks(null), []);
    assert.strictEqual(SR.mergeAdjacentChunks([chunk(0, 1, 0), { start: 'x', end: null }]).length, 1,
        'mẩu thiếu mốc hợp lệ bị bỏ, không kéo cả hàm chết theo');
    console.log('  ok  gộp liền kề: chỉ mẩu sát cạnh / ngưỡng dung sai / đầu vào lộn xộn / chồng nhau / trọng số');
}

console.log('Sắp xếp timeline theo kịch bản — logic thuần');
testSplitSentences();
testOrderPieces();
testSummarizePlan();
testMergeAdjacent();
console.log('\nscript reorder unit ok');
