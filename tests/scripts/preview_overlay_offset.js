/* =====================================================================
 * KHUNG TRANSFORM / KHUNG MẶT NẠ PHẢI BÁM ĐỐI TƯỢNG KHI PREVIEW ĐANG ZOOM
 *
 * LỖI ĐÃ TRẢ GIÁ (báo cáo 2026-09-06): zoom preview lên rồi chọn textbox thì khung
 * transform (8 tay cầm) trôi LÊN TRÊN và SANG TRÁI so với textbox.
 *
 * NGUYÊN NHÂN — trộn hai hệ toạ độ:
 *   - #editingSelectionBox là con `position:absolute` của #sequencePreviewShell, nên toạ
 *     độ `left/top` của nó tính theo hộp NỘI DUNG, tức CUỘN THEO nội dung;
 *   - nhưng vị trí khung lại đo bằng hiệu hai getBoundingClientRect(), là toạ độ THỊ GIÁC
 *     — đã trừ sẵn scroll.
 * Ở mức vừa-khung shell là `overflow:hidden`, scroll luôn 0 nên hai hệ trùng nhau và
 * không ai thấy gì. Zoom vào thì shell thành `overflow:auto` (.is-zoomed) và cuộn được ->
 * khung lệch đúng bằng (scrollLeft, scrollTop).
 *
 * Đo trên trình duyệt thật với đúng DOM/CSS của app (shell cuộn 140/90 px): công thức cũ
 * đặt khung lệch (−140, −90); công thức mới lệch (0, 0).
 *
 * Test này KHÔNG dựng lại phép đo — Node không có layout engine. Nó khoá hai điều mà một
 * lần "dọn dẹp" sau này rất dễ làm hỏng: hàm bù toạ độ còn nguyên các số hạng của nó, và
 * KHÔNG có chỗ nào quay lại lấy hiệu hai rect trần.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

// 1. Hàm bù toạ độ phải cộng scroll và trừ viền — thiếu số hạng nào cũng là lỗi cũ quay lại.
{
    const fn = extractFunction(source, 'previewFrameOffsetIn');
    [
        ['scrollLeft', /\+ \(selectionRoot\.scrollLeft \|\| 0\)/],
        ['scrollTop', /\+ \(selectionRoot\.scrollTop \|\| 0\)/],
        ['clientLeft', /- \(selectionRoot\.clientLeft \|\| 0\)/],
        ['clientTop', /- \(selectionRoot\.clientTop \|\| 0\)/],
    ].forEach(([label, re]) => {
        assert.ok(re.test(fn), `previewFrameOffsetIn() thiếu số hạng ${label}`);
    });
}

/* 2. MỌI lớp phủ đặt theo toạ độ nội dung của shell phải đi qua hàm đó. Hai lớp hiện có là
   khung chọn (renderSelectionBox) và khung mặt nạ (renderMaskOverlay) — cả hai từng tự đo
   bằng hiệu hai rect, và cả hai đều lệch y như nhau khi zoom. */
['renderSelectionBox', 'renderMaskOverlay'].forEach((name) => {
    const fn = extractFunction(source, name);
    assert.ok(/previewFrameOffsetIn\(selectionRoot\)/.test(fn),
        `${name}() phải lấy độ lệch khung qua previewFrameOffsetIn()`);
    assert.ok(!/frameRect\.left - rootRect\.left/.test(fn),
        `${name}() còn tự lấy hiệu hai rect — sẽ lệch đúng bằng scrollLeft khi preview zoom`);
});

/* 3. Không còn chỗ nào KHÁC trong file dùng lại lối đo cũ. Bỏ thân previewFrameOffsetIn ra
   khỏi phép quét: chính nó mới được phép chứa hiệu hai rect (rồi bù scroll ngay sau đó). */
{
    const helper = extractFunction(source, 'previewFrameOffsetIn');
    const rest = source.split(helper).join('');
    assert.ok(!/frameRect\.left - rootRect\.left/.test(rest),
        'còn sót phép đo "frameRect.left - rootRect.left" (bỏ qua scroll) ngoài previewFrameOffsetIn');
}

console.log('preview_overlay_offset: OK');
