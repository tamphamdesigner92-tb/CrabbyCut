/* BIÊN MEDIA CỦA CLIP LANE CHÍNH (static/js/main-lane.js).
 *
 * LỖI ĐANG CHẶN (người dùng báo 2026-09-13). Thêm video A (5s) rồi B (15s) vào lane chính,
 * XOÁ block B khỏi lane chính (B vẫn còn trong panel Tệp phương tiện), rồi kéo dài block A:
 * A kéo được tới 20s và preview chiếu ra nội dung của B.
 *
 * VÌ SAO. Lane chính chạy trên MỘT file temp_input.mp4 do backend nối mọi nguồn lại, và mốc
 * của clip là giờ trong file NỐI đó. Xoá block KHÔNG nối lại file (đúng — nối lại rất đắt, và
 * media vẫn phải còn dùng được), nên B vẫn nằm trong file. Bản trước kẹp mép phải theo thời
 * lượng CẢ file nối và mép trái về 0 -> kéo qua biên là chiếu tiếp footage của video kế bên.
 * Premiere Pro / CapCut chặn cứng ở mép media; sourceLimitsFor là mốc chặn đó.
 *
 * Mệnh đề quan trọng nhất là #2 và #4: kẹp đúng biên đoạn, và sửa được dự án ĐÃ LỠ tràn (mốc
 * hỏng nằm sẵn trong .crab nên không sửa lúc mở là preview vẫn chiếu nhầm cảnh).
 */
const assert = require('assert');
const MainLane = require('../../static/js/main-lane.js');

const { sourceLimitsFor, clampRowsToSegments, segmentAt, MIN_CLIP_SEC } = MainLane;

// Đúng bảng đoạn của dự án người dùng gửi kèm (FIx loi_ver 2.crab): DJI 6.05605s nối trước,
// 6.mp4 38.08805s nối sau -> file nối dài 44.1441s.
const SEGMENTS = [
    { source_path: '/m/DJI.MP4', name: 'DJI.MP4', start: 0, end: 6.05605, duration: 6.05605 },
    { source_path: '/m/6.mp4', name: '6.mp4', start: 6.05605, end: 44.1441, duration: 38.08805 },
];

function main() {
    // --- 1: dò đoạn theo VỊ TRÍ, không theo source_path ---
    assert.strictEqual(segmentAt(SEGMENTS, 0), SEGMENTS[0]);
    assert.strictEqual(segmentAt(SEGMENTS, 6.05605), SEGMENTS[1], 'đúng biên thì thuộc về đoạn SAU');
    assert.strictEqual(segmentAt(SEGMENTS, 20), SEGMENTS[1]);
    // Clip do người dùng cắt bằng dao nằm GIỮA đoạn vẫn phải ra đúng đoạn đó.
    assert.strictEqual(segmentAt(SEGMENTS, 3.2), SEGMENTS[0]);

    // --- 2: biên trim = biên đoạn của chính clip, KHÔNG phải [0, hết file nối] ---
    assert.deepStrictEqual(sourceLimitsFor(SEGMENTS, 0, 44.1441), { start: 0, end: 6.05605 },
        'clip của video đầu không được kéo quá 6.05605s — quá là chiếu sang video sau');
    assert.deepStrictEqual(sourceLimitsFor(SEGMENTS, 10, 44.1441), { start: 6.05605, end: 44.1441 },
        'clip của video sau không được kéo mép trái về trước 6.05605s');

    // --- 3: chưa có bảng đoạn (dự án cũ / đệm bị dọn) -> giữ nguyên hành vi cũ ---
    assert.deepStrictEqual(sourceLimitsFor([], 0, 44.1441), { start: 0, end: 44.1441 });
    assert.deepStrictEqual(sourceLimitsFor(null, 0), { start: 0, end: Infinity });

    // --- 4: sửa dự án ĐÃ LỠ tràn — chính con số trong FIx loi_ver 2.crab ---
    const broken = [{ start: 0, end: 15.0586760800843, source_path: '/m/DJI.MP4', text: 'DJI.MP4' }];
    const fixed = clampRowsToSegments(broken, SEGMENTS);
    assert.strictEqual(fixed.fixed, 1);
    assert.strictEqual(fixed.rows.length, 1);
    assert.strictEqual(fixed.rows[0].end, 6.05605, 'phải cắt về đúng mép media của DJI');
    assert.strictEqual(fixed.rows[0].start, 0);
    assert.strictEqual(fixed.rows[0].text, 'DJI.MP4', 'chỉ sửa mốc, mọi thứ khác giữ nguyên');
    assert.notStrictEqual(fixed.rows[0], broken[0], 'không sửa tại chỗ — nơi gọi còn giữ bản cũ cho undo');

    // --- 5: lane chính LÀNH LẶN thì hàm sửa KHÔNG được đụng vào gì ---
    const healthy = [
        { start: 0, end: 6.05605, source_path: '/m/DJI.MP4' },
        { start: 6.05605, end: 20, source_path: '/m/6.mp4' },
        { start: 20, end: 44.1441, source_path: '/m/6.mp4' },   // cắt bằng dao
    ];
    const untouched = clampRowsToSegments(healthy, SEGMENTS);
    assert.strictEqual(untouched.fixed, 0, 'không được báo sửa khi không có gì sai');
    untouched.rows.forEach((row, i) => assert.strictEqual(row, healthy[i], 'phải trả về ĐÚNG object cũ'));

    // --- 6: mép TRÁI tràn ngược về đoạn trước cũng phải bị kéo lại ---
    const bleedLeft = [{ start: 2, end: 30, source_path: '/m/6.mp4' }];
    // start=2 rơi vào đoạn DJI -> clip bị coi là của DJI và bị cắt về [2, 6.05605].
    const cutLeft = clampRowsToSegments(bleedLeft, SEGMENTS);
    assert.deepStrictEqual([cutLeft.rows[0].start, cutLeft.rows[0].end], [2, 6.05605]);

    /* --- 7: CLIP VẮT QUA RANH GIỚI — nắn MÉP TRÁI, không được gọt cụt.
     * Mốc bắt đầu thò vào đuôi đoạn trước một mẩu không đáng kể (đây là 0,025s trên một
     * clip 24s) thì clip thuộc về đoạn SAU: đẩy mép trái về ranh giới, giữ nguyên nội dung.
     * Bản trước coi nó là clip của DJI và cắt về [6.031, 6.05605] = 0,025s -> ngắn hơn sàn
     * export -> BỎ HẲN row, mất trắng 24 giây nội dung mà chỉ báo "đã cắt về đúng độ dài". */
    const straddle = clampRowsToSegments(
        [{ start: 6.05605 - MIN_CLIP_SEC / 2, end: 30, source_path: '/m/6.mp4' }],
        SEGMENTS,
    );
    assert.strictEqual(straddle.rows.length, 1, 'clip vắt qua ranh giới KHÔNG được biến mất');
    assert.strictEqual(straddle.fixed, 1);
    assert.deepStrictEqual([straddle.rows[0].start, straddle.rows[0].end], [6.05605, 30]);

    // --- 7b: cắt xong mà vẫn ngắn hơn sàn export thì BỎ row, không để nó chết ở phút cuối.
    // Clip 0,03s nằm gọn cuối đoạn DJI: phần thuộc DJI chiếm 87% nên vẫn là clip của DJI.
    const slivers = clampRowsToSegments(
        [{ start: 6.03, end: 6.06, source_path: '/m/DJI.MP4' }],
        SEGMENTS,
    );
    assert.strictEqual(slivers.rows.length, 0);
    assert.strictEqual(slivers.fixed, 1);

    /* --- 7c: CA THẬT của dự án "Yêu Con 1 - Test ver 2" (người dùng báo 2026-09-16).
     * Lane chính cắt theo lời thoại trên file nối 13 video; hai câu bắt đầu sớm hơn ranh
     * giới nguồn 0,086s và 0,107s rồi chạy trọn trong video kế tiếp. Mở lại dự án là toast
     * "2 clip … đã được cắt về đúng độ dài" — thực tế 6,80s teo còn 0,081s và 2,43s còn
     * 0,106s, tức mất hẳn hai câu thoại mà không có cách nào biết. */
    const REAL = [
        { source_path: '/s/0404.MP4', start: 37.564, end: 44.177, duration: 6.613 },
        { source_path: '/s/0406.MP4', start: 44.177, end: 51.351, duration: 7.174 },
        { source_path: '/s/0407.MP4', start: 51.351, end: 57.490, duration: 6.139 },
        { source_path: '/s/0408.MP4', start: 57.490, end: 67.333, duration: 9.843 },
    ];
    const real = clampRowsToSegments([
        { start: 44.094, end: 50.890, text: 'là lý do rất nhiều ba mẹ…' },
        { start: 57.383, end: 59.816, text: 'Đi tươi tóa được nhiều ba mẹ…' },
    ], REAL);
    assert.strictEqual(real.rows.length, 2, 'không câu thoại nào được biến mất');
    assert.strictEqual(real.fixed, 2);
    assert.deepStrictEqual([real.rows[0].start, real.rows[0].end], [44.177, 50.890]);
    assert.deepStrictEqual([real.rows[1].start, real.rows[1].end], [57.490, 59.816]);
    // Mất đúng mẩu thò sang video trước, không mất nội dung
    assert.ok(real.rows[0].end - real.rows[0].start > 6.7);
    assert.ok(real.rows[1].end - real.rows[1].start > 2.3);

    // --- 8: không có bảng đoạn -> trả nguyên lane chính, không đoán mò ---
    assert.deepStrictEqual(clampRowsToSegments(broken, []), { rows: broken, fixed: 0 });

    console.log('main lane source limits ok');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
