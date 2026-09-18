/* SỐ HỌC MỐC THỜI GIAN của lane chính dựng tay (static/js/main-lane.js).
 *
 * Vì sao đo riêng: toàn bộ rủi ro của tính năng "thêm video vào lane chính" nằm ở đây.
 * Lệch một chút là overlay dán sai khung hình mà KHÔNG có lỗi nào báo — không có test thì
 * chỉ phát hiện bằng mắt, và chỉ khi nhìn đúng khung.
 *
 * Mệnh đề quan trọng nhất là #3: thêm video vào CUỐI thì mọi row cũ phải giữ nguyên
 * start/end tới từng chữ số. Đó là lời hứa với người dùng "thêm video không làm lệch
 * những gì đã dựng".
 */
const assert = require('assert');
const MainLane = require('../../static/js/main-lane.js');

const {
    segmentTableFromDurations, rowsFromSegments, rebaseRows, concatSourcesFromRows,
} = MainLane;

function src(name, duration) {
    return { source_path: `/v/${name}`, name, duration };
}

function main() {
    // --- 1: bảng segment cộng dồn ---
    const segs = segmentTableFromDurations([src('a.mp4', 3), src('b.mp4', 5), src('c.mp4', 2)]);
    assert.deepStrictEqual(
        segs.map((s) => [s.start, s.end]),
        [[0, 3], [3, 8], [8, 10]],
        'biên phải cộng dồn theo đúng thứ tự nối',
    );
    // Probe hụt (duration null/0) bị bỏ, không làm lệch các đoạn sau.
    const withHole = segmentTableFromDurations([src('a.mp4', 3), src('x.mp4', 0), src('b.mp4', 5)]);
    assert.deepStrictEqual(withHole.map((s) => [s.start, s.end]), [[0, 3], [3, 8]]);

    // --- 2: row hợp lệ cho cả backend lẫn UI ---
    const rows = rowsFromSegments(segs, 0);
    assert.strictEqual(rows.length, 3);
    rows.forEach((r, i) => {
        assert.ok(r.end - r.start >= MainLane.MIN_CLIP_SEC, `row ${i} phải đủ dài cho export`);
        assert.strictEqual(r.source_path, segs[i].source_path, 'row phải nhớ nguồn của nó');
        assert.strictEqual(r.chunk_index, i);
        assert.ok(Array.isArray(r.sub_segments));
    });
    // Đoạn quá ngắn bị loại ngay, không để backend ném lỗi lúc export.
    assert.strictEqual(rowsFromSegments([{ source_path: '/v/t.mp4', name: 't', start: 0, end: 0.01 }]).length, 0);

    // --- 3: THÊM VÀO CUỐI -> row cũ KHÔNG đổi một chữ số nào ---
    const oldSegs = segmentTableFromDurations([src('z.mp4', 4), src('y.mp4', 6)]);
    const oldRows = rowsFromSegments(oldSegs, 0);
    // người dùng cắt z.mp4 làm đôi rồi xoá nửa đầu
    const edited = [
        { ...oldRows[0], start: 1.5 },
        oldRows[1],
    ];
    const newSegs = segmentTableFromDurations([src('z.mp4', 4), src('y.mp4', 6), src('a.mp4', 2)]);
    const kept = rebaseRows(edited, oldSegs, newSegs);
    assert.strictEqual(kept.length, 2);
    assert.strictEqual(kept[0].start, 1.5, 'clip đã cắt phải giữ nguyên vị trí');
    assert.strictEqual(kept[0].end, edited[0].end);
    assert.strictEqual(kept[1].start, edited[1].start, 'clip thứ hai không được dịch');
    assert.strictEqual(kept[1].end, edited[1].end);
    // ...và phần thêm mới chỉ nối vào đuôi
    const freshSegs = newSegs.filter((s) => !oldSegs.some((o) => o.source_path === s.source_path));
    const appended = [...kept, ...rowsFromSegments(freshSegs, kept.length)];
    assert.strictEqual(appended.length, 3);
    assert.strictEqual(appended[2].start, 10, 'video mới bắt đầu ngay sau toàn bộ nguồn cũ');

    // --- 4: biên TRÔI vài ms -> bù đúng cho từng row ---
    const drift = segmentTableFromDurations([src('z.mp4', 4.02), src('y.mp4', 6)]);
    const rebased = rebaseRows(oldRows, oldSegs, drift);
    assert.strictEqual(rebased[0].start, 0, 'đoạn đầu không dịch (delta = 0)');
    assert.ok(Math.abs(rebased[1].start - 4.02) < 1e-9, 'đoạn sau dịch đúng +0.02');
    assert.ok(rebased[1].end <= drift[1].end + 1e-9, 'không được tràn khỏi segment của nó');

    // --- 5: XOÁ nguồn giữa -> row của nó biến mất, row sau dịch lên ---
    const three = segmentTableFromDurations([src('a.mp4', 3), src('b.mp4', 5), src('c.mp4', 2)]);
    const threeRows = rowsFromSegments(three, 0);
    const withoutB = segmentTableFromDurations([src('a.mp4', 3), src('c.mp4', 2)]);
    const after = rebaseRows(threeRows, three, withoutB);
    assert.strictEqual(after.length, 2, 'row của nguồn đã bỏ phải biến mất');
    assert.deepStrictEqual(after.map((r) => [r.start, r.end]), [[0, 3], [3, 5]]);

    // --- 6: suy ngược danh sách nối ---
    assert.deepStrictEqual(concatSourcesFromRows(threeRows), ['/v/a.mp4', '/v/b.mp4', '/v/c.mp4']);
    // hai row cùng một nguồn (bị cắt đôi) chỉ ra MỘT đường dẫn
    assert.deepStrictEqual(
        concatSourcesFromRows([threeRows[0], { ...threeRows[0], start: 1 }, threeRows[1]]),
        ['/v/a.mp4', '/v/b.mp4'],
    );
    // row do luồng LỌC sinh ra (không có source_path) -> null để người gọi dùng bộ nhớ đệm
    assert.strictEqual(concatSourcesFromRows([{ start: 0, end: 5 }]), null);
    assert.deepStrictEqual(concatSourcesFromRows([]), []);

    console.log('main lane rows ok');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
