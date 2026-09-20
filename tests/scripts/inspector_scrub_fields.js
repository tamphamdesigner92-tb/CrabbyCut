/* =====================================================================
 * KÉO CHUỘT ĐỂ CHỈNH SỐ Ở BẢNG THUỘC TÍNH — mọi ô có `data-scrub-axis` phải kéo được
 *
 * VÌ SAO CÓ TEST NÀY: một ô số ở panel muốn kéo được cần HAI thứ ở HAI CHỖ KHÁC NHAU
 * trong editing-runtime.js:
 *   1. thẻ <input> mang `data-scrub-axis` (chỗ dựng HTML), và
 *   2. một dòng trong bảng `editingScrubConfig` (chỗ xử lý con trỏ) — bảng này mới là
 *      thứ beginEditingInspectorScrub tra để biết bước nhảy/biên/trục.
 * Thiếu (2) thì ô vẫn nhìn y hệt các ô khác, vẫn gõ số được, chỉ có kéo là im — không
 * có lỗi nào ở console. Đúng lỗi đã xảy ra với hai ô W/H của khối Nền (báo 2026-09-10):
 * chúng có `data-scrub-axis` ngay từ đầu nhưng không bao giờ có mặt trong bảng.
 *
 * CÁCH ĐO: đọc THẲNG nguồn. Đây là hợp đồng giữa hai đoạn văn bản trong cùng một file
 * nên so văn bản là đúng mức — không cần dựng DOM.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(projectRoot, 'static', 'js', 'editing-runtime.js'), 'utf8');

// ---- 1) Bảng editingScrubConfig ------------------------------------------
const cfgStart = source.indexOf('function editingScrubConfig(');
assert.notStrictEqual(cfgStart, -1, 'không tìm thấy editingScrubConfig() trong nguồn');
const cfgEnd = source.indexOf('\n    }', cfgStart);
const cfgSrc = source.slice(cfgStart, cfgEnd);
const CONFIG = new Map();
for (const m of cfgSrc.matchAll(/^\s{12}([A-Za-z0-9_]+):\s*\{([^}]*)\}/gm)) {
    CONFIG.set(m[1], { axis: /axis:\s*'y'/.test(m[2]) ? 'y' : 'x', body: m[2] });
}
assert.ok(CONFIG.size >= 20, `bảng scrub chỉ đọc ra ${CONFIG.size} dòng — regex đã hỏng?`);

// ---- 2) Mọi ô có data-scrub-axis phải có dòng trong bảng ------------------
const marked = new Map();
for (const m of source.matchAll(/<input\s+id="([A-Za-z0-9_]+)"[^>]*data-scrub-axis="([xy])"/g)) {
    marked.set(m[1], m[2]);
}
assert.ok(marked.size >= 10, `chỉ thấy ${marked.size} ô mang data-scrub-axis — regex đã hỏng?`);

marked.forEach((axis, id) => {
    assert.ok(CONFIG.has(id),
        `ô "${id}" mang data-scrub-axis nhưng THIẾU dòng trong editingScrubConfig -> kéo chuột không ăn`);
    assert.strictEqual(CONFIG.get(id).axis, axis,
        `ô "${id}": trục ở data-scrub-axis ("${axis}") khác trục trong bảng scrub ("${CONFIG.get(id).axis}")`);
});

// Hai ô từng bị bỏ sót — gọi tên hẳn để ai xoá là biết ngay đang xoá cái gì.
['editingTextBgPadX', 'editingTextBgPadY'].forEach((id) => {
    assert.ok(marked.has(id) && CONFIG.has(id),
        `ô lề nền "${id}" phải kéo chuột chỉnh được (lỗi báo 2026-09-10)`);
});
assert.strictEqual(CONFIG.get('editingTextBgPadY').axis, 'y',
    'ô "H" (lề trên/dưới của nền) phải kéo THEO CHIỀU DỌC, đúng nghĩa của ô');

/* ---- 3) Ô kéo được cũng phải nằm trong danh sách "field sống" ------------
 * updateEditingInspectorField chỉ vẽ lại preview ngay lập tức cho các id trong
 * isTextLiveField. Ô kéo được mà không có ở đó thì hình chỉ nhảy khi thả chuột — kéo
 * mà không thấy gì thì coi như không kéo được. */
const liveLine = /const isTextLiveField = \[([^\]]*)\]/.exec(source);
assert.ok(liveLine, 'không tìm thấy danh sách isTextLiveField');
const live = new Set([...liveLine[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
marked.forEach((_axis, id) => {
    if (!id.startsWith('editingText')) return;   // ô của Shape có đường sống riêng
    assert.ok(live.has(id),
        `ô chữ "${id}" kéo được nhưng không nằm trong isTextLiveField -> kéo mà preview không đổi`);
});

/* ---- 4) Ô KHÔNG CÓ id: phải tự khai thông số (`data-scrub-*`) -------------
 * Các hàng dựng theo VÒNG LẶP (mỗi lớp ảnh của mẫu Custom một hàng "Cỡ hình"/"Lệch hình")
 * không có id duy nhất nào để đặt, nên không thể có mặt trong bảng `editingScrubConfig`.
 * Chúng đi đường thứ hai: tự mang `data-scrub-step` (+ min/max/integer) và
 * editingScrubConfig đọc thẳng từ dataset.
 * ĐÂY LÀ CÙNG MỘT CÁI BẪY với mục (2), chỉ khác lối vào: ô mang `data-scrub-axis` mà
 * KHÔNG có id VÀ KHÔNG có `data-scrub-step` thì cũng im re khi kéo, không lỗi nào báo
 * (người dùng báo 2026-09-16 với ba ô mới của mẫu Custom). */
assert.ok(/input\s*&&\s*input\.dataset\s*&&\s*input\.dataset\.scrubStep/.test(cfgSrc),
    'editingScrubConfig phải có nhánh đọc thông số từ `data-scrub-*` cho ô không có id');

const idless = [...source.matchAll(/<input(?![^>]* id=)[^>]*data-scrub-axis="([xy])"[^>]*>/g)];
assert.ok(idless.length >= 3,
    `chỉ thấy ${idless.length} ô kéo-được-không-id — ba ô của mẫu Custom đâu? (regex hỏng?)`);
idless.forEach((m) => {
    assert.ok(/data-scrub-step="/.test(m[0]),
        `ô không có id mang data-scrub-axis nhưng THIẾU data-scrub-step -> kéo chuột không ăn:
  ${m[0].slice(0, 160)}`);
});

/* Ba ô ấy cũng phải nằm trong nhánh vẽ-lại-ngay của updateEditingInspectorField, cùng lý
   do với mục (3): kéo mà preview không đổi thì coi như không kéo được. */
assert.ok(/\|\|\s*isTemplateArtNumField\)\s*&&\s*!options\.commit/.test(source),
    'ô "Cỡ hình"/"Lệch hình" phải nằm trong nhánh vẽ lại ngay (isTemplateArtNumField)');

/* ---- 5) Hàm ĐƯỢC VÁ không được truyền thẳng vào addEventListener ---------
 * editing-runtime.js vá lại một loạt hàm của index.html (patchInspector) để chúng biết
 * đường OVERLAY. Nhưng addEventListener chốt cứng THAM CHIẾU tại lúc đăng ký, mà
 * index.html chạy TRƯỚC editing-runtime.js — truyền thẳng tên hàm là vĩnh viễn chạy bản
 * gốc, bản vá không bao giờ được gọi.
 * Lỗi thật đã mắc (sửa 2026-09-19): `window.addEventListener('pointerup', endInspectorScrub)`
 * khiến thả chuột sau khi kéo một ô số của block overlay lại quy bảng thông số về
 * transform của CLIP LANE CHÍNH (hoặc về 0/100% khi không có clip nào chọn) — giá trị đã
 * ghi đúng vào block, chỉ riêng bảng là hiện sai, nên trông y như "kéo xong không ăn".
 * Cách đúng: bọc trong lambda để tên được tra LÚC GỌI. */
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const PATCHED_IN_RUNTIME = [...source.matchAll(/^\s{8}(\w+) = function patched\w+/gm)].map((m) => m[1]);
assert.ok(PATCHED_IN_RUNTIME.length >= 5,
    `chỉ đọc ra ${PATCHED_IN_RUNTIME.length} hàm được vá trong patchInspector — regex hỏng?`);
PATCHED_IN_RUNTIME.forEach((name) => {
    const direct = new RegExp(`addEventListener\\(\\s*['"][a-z]+['"]\\s*,\\s*${name}\\s*[,)]`);
    assert.ok(!direct.test(indexHtml),
        `index.html truyền THẲNG "${name}" vào addEventListener, mà hàm này bị editing-runtime.js vá lại`
        + ` -> listener giữ bản GỐC và bản vá không bao giờ chạy. Bọc lại: (event) => ${name}(event)`);
});

console.log('inspector_scrub_fields: OK');
