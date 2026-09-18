/* TRẦN THỜI LƯỢNG CỦA BLOCK OVERLAY THEO VIDEO NGUỒN (static/js/clip-speed.js).
 *
 * LỖI ĐANG CHẶN (người dùng báo 2026-09-14, dự án "Bin Tom - Tập 3"). Video overlay dài 8s
 * được kéo thành block 6.09s ở tốc độ 1.7947x — tức đòi 10.93s phim từ một file chỉ có 8s.
 * 2.93s dôi ra KHÔNG có khung hình nào, và hai phía hiểu khác nhau:
 *   - preview: <video> chạy hết phim -> 'ended' -> paused; vòng sync thấy "đang phát mà
 *     phần tử pause" nên gọi play(), Chromium tua về 0 rồi phát lại, lượt sau lại tua về
 *     cuối -> đúng cái "giật giật, lặp mấy khung đầu" người dùng thấy;
 *   - bản xuất: overlay biến mất hẳn ở đoạn đó (eof_action=pass, core_process.cpp).
 *
 * Lane CHÍNH đã có chặn tương đương từ 2026-09-13 (xem main_lane_source_limits.js). Test này
 * khoá hai mệnh đề cùng kiểu cho lane overlay: kẹp đúng trần, và sửa được dự án ĐÃ LỠ tràn
 * (mốc hỏng nằm sẵn trong .crab nên không sửa lúc mở là preview vẫn giật).
 */
const assert = require('assert');
const ClipSpeed = require('../../static/js/clip-speed.js');

const { maxItemDuration, clampItemsToSource } = ClipSpeed;

function main() {
    // --- 1: 1x -> trần đúng bằng phần phim còn lại sau source_start ---
    assert.strictEqual(maxItemDuration({ source_start: 0 }, 5), 5);
    assert.strictEqual(maxItemDuration({ source_start: 2 }, 5), 3, 'đã cắt 2s đầu thì chỉ còn 3s');

    // --- 2: tốc độ nén trục thời gian -> trần TIMELINE đổi theo (đây là chỗ dễ quên nhất) ---
    assert.strictEqual(maxItemDuration({ source_start: 0, speed: { rate: 2 } }, 8), 4,
        '2x: 8s phim chỉ phủ được 4s timeline');
    assert.strictEqual(maxItemDuration({ source_start: 0, speed: { rate: 0.5 } }, 8), 16,
        '0.5x: 8s phim kéo dài thành 16s timeline');

    // --- 3: không biết thời lượng nguồn (ảnh/text/shape/asset chưa probe) -> KHÔNG kẹp ---
    [null, undefined, 0, -1, NaN, 'x'].forEach((bad) => {
        assert.strictEqual(maxItemDuration({ source_start: 0 }, bad), Infinity,
            `thời lượng ${String(bad)} phải để block tự do, không cắt bừa`);
    });

    // --- 4: sửa dự án ĐÃ LỠ tràn — chính con số trong "Bin Tom - Tap 3.crab" ---
    const items = [
        { id: 'a', type: 'media', asset_id: 'vid', duration: 6.09, source_start: 0, speed: { rate: 1.7947 } },
        { id: 'b', type: 'media', asset_id: 'img', duration: 30, source_start: 0 },   // ảnh: không có nguồn để hết
        { id: 'c', type: 'media', asset_id: 'vid', duration: 3, source_start: 0 },    // video còn trong biên
    ];
    const durationOf = (item) => (item.asset_id === 'vid' ? 8 : null);
    const fixed = clampItemsToSource(items, durationOf);
    assert.strictEqual(fixed.fixed, 1, 'chỉ đúng một block tràn');
    assert.ok(Math.abs(fixed.items[0].duration - 8 / 1.7947) < 1e-9,
        'block tràn phải co về đúng phần phim còn lại, quy ra timeline');
    assert.strictEqual(fixed.items[0].id, 'a', 'chỉ sửa thời lượng, mọi field khác giữ nguyên');
    assert.notStrictEqual(fixed.items[0], items[0], 'không sửa tại chỗ — nơi gọi còn giữ bản cũ cho undo');
    assert.strictEqual(fixed.items[1], items[1], 'ảnh phải trả về ĐÚNG object cũ');
    assert.strictEqual(fixed.items[2], items[2], 'block lành phải trả về ĐÚNG object cũ');

    // --- 5: dự án LÀNH LẶN thì không được báo sửa gì ---
    assert.strictEqual(clampItemsToSource(items.slice(1, 3), durationOf).fixed, 0);
    assert.strictEqual(clampItemsToSource([], durationOf).fixed, 0);
    assert.strictEqual(clampItemsToSource(null, durationOf).fixed, 0);

    // --- 6: sai số ffprobe không phải lỗi tràn (dung sai 1 khung ở 60fps) ---
    const jitter = [{ type: 'media', asset_id: 'vid', duration: 8.01, source_start: 0 }];
    assert.strictEqual(clampItemsToSource(jitter, durationOf).fixed, 0,
        'lệch vài ms do thời lượng ffprobe không được đếm là tràn');
    const real = [{ type: 'media', asset_id: 'vid', duration: 8.5, source_start: 0 }];
    assert.strictEqual(clampItemsToSource(real, durationOf).fixed, 1);

    // --- 7: sàn thời lượng — source_start vượt quá cả thời lượng asset (dữ liệu hỏng) ---
    const rotten = [{ type: 'media', asset_id: 'vid', duration: 4, source_start: 99 }];
    const healed = clampItemsToSource(rotten, durationOf);
    assert.strictEqual(healed.fixed, 1);
    assert.strictEqual(healed.items[0].duration, 0.2, 'không được ra block 0s / âm');

    console.log('overlay_source_limits: OK');
}

main();
