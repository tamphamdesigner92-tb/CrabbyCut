/* =====================================================================
 * ĐỘ NHẠY ZOOM KHUNG XEM TRƯỚC BẰNG LĂN CHUỘT / TRACKPAD
 *
 * VÌ SAO CÓ TEST NÀY (người dùng báo 2026-09-20, máy Mac): zoom preview bằng trackpad nhảy
 * quá nhanh, không cách nào dừng đúng mức muốn xem. Bản cũ dùng MỘT NẤC CỐ ĐỊNH ×1.12 cho
 * MỌI sự kiện `wheel`, trong khi trackpad bắn rất nhiều sự kiện delta rất nhỏ -> mỗi nhịp
 * ngón tay là một cú nhảy 12%.
 *
 * Bản mới quy đổi theo ĐỘ LỚN của delta: ×1.12 cho mỗi 100 đơn vị (đúng một nấc bánh xe
 * chuột rời), nên chuột rời giữ nguyên cảm giác cũ còn trackpad thì mịn hẳn.
 *
 * Bất biến test này giữ:
 *   1. một nấc chuột rời (|deltaY| = 100) vẫn ra ×1.12 như trước;
 *   2. nhịp trackpad mảnh (|deltaY| ≈ 3) chỉ nhích dưới 1% — không phải 12%;
 *   3. hệ số là hàm MŨ: gộp N nhịp nhỏ ra đúng bằng một nhịp lớn cùng tổng delta (zoom
 *      không lệ thuộc trình duyệt gộp sự kiện thưa hay dày);
 *   4. delta âm = phóng to, dương = thu nhỏ (đúng chiều cũ);
 *   5. deltaMode dòng/trang được quy về pixel, và cú bắn dị thường bị kẹp ở đúng một nấc.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `không tìm thấy hàm ${name}() trong index.html`);
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
    const m = new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`).exec(src);
    assert.ok(m, `không tìm thấy hằng ${name} trong index.html`);
    return `const ${name} = ${m[1]};`;
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
    extractConst(html, 'PREVIEW_ZOOM_WHEEL_SENS'),
    extractConst(html, 'PREVIEW_ZOOM_WHEEL_MAX_DELTA'),
    extractFunction(html, 'previewZoomWheelDelta'),
    'globalThis.delta = previewZoomWheelDelta;',
    'globalThis.factor = (d) => Math.exp(-d * PREVIEW_ZOOM_WHEEL_SENS);',
    'globalThis.MAXD = PREVIEW_ZOOM_WHEEL_MAX_DELTA;',
].join('\n'), sandbox);

const wheel = (deltaY, deltaMode = 0) => ({ deltaY, deltaMode });
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg} (được ${a}, mong ≈ ${b})`);

// ---- 1) Chuột rời: một nấc = ×1.12, đúng như trước khi sửa -----------------
{
    near(sandbox.factor(sandbox.delta(wheel(-100))), 1.12, 1e-9, 'lăn lên một nấc phải phóng to đúng 12%');
    near(sandbox.factor(sandbox.delta(wheel(100))), 1 / 1.12, 1e-9, 'lăn xuống một nấc phải thu nhỏ đúng 12%');
    console.log('  ok  chuột rời: một nấc vẫn ×1.12 như bản cũ');
}

// ---- 2) Trackpad: nhịp mảnh phải nhích rất nhỏ -----------------------------
// Đây chính là cái người dùng kêu: bản cũ trả 1.12 cho CẢ nhịp này.
{
    const f = sandbox.factor(sandbox.delta(wheel(-3)));
    assert.ok(f > 1, 'chụm ra phải phóng to');
    assert.ok(f < 1.01, `nhịp trackpad mảnh phải dưới 1% mỗi nhịp, đang là ${((f - 1) * 100).toFixed(2)}%`);
    console.log(`  ok  trackpad: nhịp |deltaY|=3 chỉ nhích ${((f - 1) * 100).toFixed(2)}% (bản cũ: 12%)`);
}

// ---- 3) Hàm mũ: gộp nhịp không đổi kết quả --------------------------------
{
    let acc = 1;
    for (let i = 0; i < 10; i += 1) acc *= sandbox.factor(sandbox.delta(wheel(-10)));
    near(acc, sandbox.factor(sandbox.delta(wheel(-100))), 1e-9,
        '10 nhịp ×10 phải ra đúng bằng 1 nhịp ×100 — nếu không, zoom lệ thuộc nhịp gộp sự kiện của trình duyệt');
    console.log('  ok  gộp nhịp: 10 nhịp nhỏ = 1 nhịp lớn cùng tổng delta');
}

// ---- 4) Chiều zoom giữ nguyên quy ước cũ ----------------------------------
{
    assert.ok(sandbox.factor(sandbox.delta(wheel(-40))) > 1, 'deltaY âm = phóng to');
    assert.ok(sandbox.factor(sandbox.delta(wheel(40))) < 1, 'deltaY dương = thu nhỏ');
    console.log('  ok  chiều zoom không đổi');
}

// ---- 5) deltaMode + kẹp biên ----------------------------------------------
{
    // Firefox bắn theo DÒNG (deltaMode = 1): 1 dòng ≈ 16px, không được coi là 1 pixel.
    near(sandbox.delta(wheel(-3, 1)), -48, 1e-9, 'deltaMode dòng phải quy về pixel');
    near(sandbox.delta(wheel(-1, 2)), -100, 1e-9, 'deltaMode trang phải quy về pixel');
    // Driver gộp cả trăm đơn vị vào một sự kiện -> kẹp lại, không cú nhảy nào quá một nấc.
    assert.strictEqual(sandbox.delta(wheel(-5000)), -sandbox.MAXD, 'cú bắn dị thường phải bị kẹp');
    assert.strictEqual(sandbox.delta(wheel(5000)), sandbox.MAXD, 'cú bắn dị thường phải bị kẹp');
    near(sandbox.factor(sandbox.delta(wheel(-5000))), 1.12, 1e-9, 'kẹp rồi thì tối đa vẫn là một nấc');
    console.log('  ok  deltaMode quy về pixel, cú bắn dị thường bị kẹp ở một nấc');
}

/* ---- 6) Hợp đồng nguồn: đừng quay lại nấc cố định ------------------------
 * Chốt bằng văn bản vì bản hỏng chỉ là MỘT dòng, rất dễ bị "dọn cho gọn" mà quay lại. */
{
    assert.ok(!/event\.deltaY\s*<\s*0\s*\?\s*1\.12/.test(html),
        'nấc cố định `event.deltaY < 0 ? 1.12 : 1/1.12` chính là bản trackpad nhảy quá nhanh, đã bỏ ngày 2026-09-20');
    assert.ok(/previewZoomWheelResidual/.test(html),
        'phải giữ phần dư delta, nếu không nhịp trackpad mảnh bị chốt 0.0005 của setPreviewZoom nuốt mất');
    console.log('  ok  nguồn: không còn nấc zoom cố định');
}

console.log('preview_zoom_wheel: PASS');
