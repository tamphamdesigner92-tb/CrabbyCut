/* =====================================================================
 * ĐỔI ĐỘ PHÂN GIẢI SEQUENCE -> OVERLAY PHẢI GIỮ NGUYÊN KÍCH THƯỚC TƯƠNG ĐỐI
 *
 * LỖI ĐÃ TRẢ GIÁ (báo cáo 2026-09-06): đổi Sequence sang 4K thì textbox "vẫn bị bé lại".
 * Nguyên nhân: scaledTextPx() chỉ lo được item MỚI. Đổi độ phân giải là đổi chính HỆ TOẠ
 * ĐỘ mà mọi overlay đang sống trong đó, mà applySequencePreset() lại không đụng gì tới
 * chúng — khung hình to gấp đôi trong khi chữ vẫn giữ 58px đã lưu, nhìn ra teo một nửa.
 *
 * Chỗ này đáng chú ý: lane CHÍNH đã được lo từ trước (đổi khổ là chạy lại Auto-Reframe),
 * chỉ lớp overlay bị bỏ quên — nên đây là nửa còn thiếu, không phải một quyết định thiết kế.
 *
 * HAI hệ số, và test này tồn tại chủ yếu để khoá việc KHÔNG được gộp chúng làm một:
 *   - KÍCH THƯỚC theo CẠNH NGẮN (k) — cùng mốc với scaledTextPx, nên box cũ sau quy đổi có
 *     cỡ chữ y hệt box mới tạo ở khổ mới.
 *   - VỊ TRÍ theo TỪNG TRỤC (kx, ky) — position_x/y là px tính từ tâm khung, phải giữ đúng
 *     TỈ LỆ vị trí. Ca lộ ra khác biệt: ngang 1920×1080 -> dọc 1080×1920, cạnh ngắn KHÔNG
 *     đổi (k = 1, cỡ chữ phải y nguyên) nhưng hai trục co giãn ngược chiều nhau.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(projectRoot, 'static', 'js', 'editing-runtime.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

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

// Sân khấu: hàm THẬT, còn các móc nối ra ngoài module thì cắm bản ghi nhận.
function makeSandbox(items, assets = []) {
    const sandbox = { calls: { recordHistory: 0, renderAll: 0 } };
    sandbox.editingItems = items;
    sandbox.editingAssets = assets;
    vm.createContext(sandbox);
    vm.runInContext([
        'function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, Number(v) || 0)); }',
        'function recordHistory() { calls.recordHistory += 1; }',
        'function renderAll() { calls.renderAll += 1; }',
        'function normalizeTransform(t) { return t; }',   // chuẩn hoá không thuộc phạm vi test này
        extractFunction(source, 'findAsset'),
        extractFunction(source, 'itemIsTextTemplate'),
        extractFunction(source, 'scaleKeyframeField'),
        extractFunction(source, 'rescaleOverlaysForSequenceResize'),
        'globalThis.run = rescaleOverlaysForSequenceResize;',
    ].join('\n'), sandbox);
    return sandbox;
}

function textItem() {
    return {
        id: 'it_text', type: 'text', asset_id: '',
        transform: { position_x: 100, position_y: -400, scale: 100, rotation: 0, opacity: 100 },
        style: {
            font_family: 'Nunito', font_size: 58, font_weight: 700,
            box_width: 0, stroke_width: 6, bg_radius: 8,
            shadow_dx: 0, shadow_dy: 4, shadow_blur: 8, line_height: 'auto',
        },
        keyframes: { position_x: [{ t: 0, v: 100 }], position_y: [{ t: 0, v: -400 }, { t: 1, v: -200 }] },
    };
}
/* MẪU VĂN BẢN: mọi số đo của mẫu (cỡ chữ, đường kính hình trang trí, khe hở) sinh ra từ
   MỘT con số template.px_scale, nên đổi khổ Sequence phải nhân đúng con số đó — cùng lý do
   như phóng font_size của textbox thường. Bỏ sót thì mẫu teo còn một nửa ở 4K. */
const templateItem = () => ({
    id: 'it_tpl', type: 'text', asset_id: '',
    transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
    style: { font_family: 'Nunito', font_size: 58, box_width: 0, line_height: 'auto' },
    template: { id: 'approved', texts: ['APPROVED'], px_scale: 1 },
});
const shapeItem = () => ({
    id: 'it_shape', type: 'shape', asset_id: '',
    transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
    style: { shape_type: 'rectangle', width: 360, height: 180, stroke_width: 2, corner_radius: 18 },
});
const mediaItem = (assetId) => ({
    id: `it_${assetId}`, type: 'media', asset_id: assetId,
    transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
    keyframes: { scale: [{ t: 0, v: 100 }, { t: 1, v: 120 }] },
});

// ---------------------------------------------------------------------------
// 1. 1080 dọc -> 4K dọc: mọi thứ gấp đôi (kx = ky = k = 2)
// ---------------------------------------------------------------------------
{
    const items = [textItem(), shapeItem(), mediaItem('as_known'), mediaItem('as_unknown'), templateItem()];
    const box = makeSandbox(items, [
        { id: 'as_known', width: 1920, height: 1080 },
        { id: 'as_unknown' },                       // asset không biết kích thước
        { id: 'as_audio' },
    ]);
    const changed = box.run({ width: 1080, height: 1920 }, { width: 2160, height: 3840 });
    assert.strictEqual(changed, true, 'đổi khổ thật thì phải báo có thay đổi');
    assert.strictEqual(box.calls.recordHistory, 1, 'phải ghi 1 mốc Hoàn tác (đúng một lần)');
    assert.strictEqual(box.calls.renderAll, 1, 'phải vẽ lại một lần');

    const [t, s, mKnown, mUnknown, tpl] = items;
    // Cỡ chữ: 58 -> 116, đúng bằng cỡ mà một textbox MỚI tạo ở 4K sẽ nhận.
    assert.strictEqual(t.style.font_size, 116, 'cỡ chữ phải gấp đôi ở 4K');
    assert.strictEqual(t.style.stroke_width, 12, 'nét viền phải gấp đôi');
    assert.strictEqual(t.style.bg_radius, 16, 'bo góc nền phải gấp đôi');
    assert.strictEqual(t.style.shadow_blur, 16, 'độ nhoè bóng phải gấp đôi');
    /* box_width = 0 là "tự co theo nội dung", KHÔNG phải một số đo -> nhân vào là biến box
       thành cố định 1px rồi bị kẹp lên 1, mất luôn chế độ tự co. */
    assert.strictEqual(t.style.box_width, 0, 'box_width tự co (0) phải giữ nguyên 0');
    assert.strictEqual(t.style.line_height, 'auto', "line_height 'auto' phải giữ nguyên");

    assert.strictEqual(t.transform.position_x, 200, 'vị trí X phải gấp đôi');
    assert.strictEqual(t.transform.position_y, -800, 'vị trí Y phải gấp đôi');
    // Bỏ sót keyframe thì item có hoạt ảnh nhảy về toạ độ cũ ngay khung hình đầu tiên.
    assert.deepStrictEqual(t.keyframes.position_y.map((k) => k.v), [-800, -400],
        'giá trị keyframe vị trí cũng phải quy đổi');

    assert.strictEqual(tpl.template.px_scale, 2, 'mẫu văn bản: px_scale phải gấp đôi ở 4K');
    assert.strictEqual(s.style.width, 720, 'shape phải gấp đôi bề rộng');
    assert.strictEqual(s.style.height, 360, 'shape phải gấp đôi chiều cao');
    assert.strictEqual(s.style.stroke_width, 4, 'nét shape phải gấp đôi');

    /* Ảnh/video: kích thước gốc là số pixel của CHÍNH TỆP, ta không có số đo nào để phóng
       -> phải chỉnh transform.scale. */
    assert.strictEqual(mKnown.transform.scale, 200, 'media biết kích thước phải tăng scale');
    assert.deepStrictEqual(mKnown.keyframes.scale.map((k) => k.v), [200, 240],
        'keyframe scale của media cũng phải quy đổi');
    /* Asset KHÔNG biết kích thước thì itemBaseSize đã lấy theo Sequence (width × 0.45) nên
       nó tự lớn theo rồi — chạm vào là phóng HAI lần. */
    assert.strictEqual(mUnknown.transform.scale, 100,
        'media không biết kích thước phải giữ nguyên scale (baseSize vốn đã theo Sequence)');
}

// ---------------------------------------------------------------------------
// 2. Ngang -> dọc: cạnh ngắn KHÔNG đổi -> kích thước y nguyên, chỉ vị trí đổi
// ---------------------------------------------------------------------------
{
    const items = [textItem(), shapeItem()];
    const box = makeSandbox(items);
    box.run({ width: 1920, height: 1080 }, { width: 1080, height: 1920 });
    const [t, s] = items;

    // k = 1080/1080 = 1 -> không được đụng vào cỡ chữ. Đây là ca mà việc dùng CHIỀU CAO
    // (hay một hệ số duy nhất) thay cho cạnh ngắn sẽ lộ ra ngay: chữ sẽ to lên 1.78 lần.
    assert.strictEqual(t.style.font_size, 58, 'đổi tỉ lệ khung mà cạnh ngắn giữ nguyên -> cỡ chữ giữ nguyên');
    assert.strictEqual(s.style.width, 360, 'shape cũng phải giữ nguyên bề rộng');

    // Vị trí theo TỪNG TRỤC -> giữ đúng tỉ lệ trong khung.
    assert.ok(Math.abs(t.transform.position_x - 100 * (1080 / 1920)) < 1e-9,
        `vị trí X phải co theo trục X, nhận ${t.transform.position_x}`);
    assert.ok(Math.abs(t.transform.position_y - (-400) * (1920 / 1080)) < 1e-9,
        `vị trí Y phải giãn theo trục Y, nhận ${t.transform.position_y}`);
    // Cùng một tỉ lệ so với nửa khung hình trước và sau -> box neo ở đâu vẫn ở đó.
    assert.ok(Math.abs((-400 / (1080 / 2)) - (t.transform.position_y / (1920 / 2))) < 1e-9,
        'tỉ lệ vị trí theo chiều dọc phải giữ nguyên');
}

// ---------------------------------------------------------------------------
// 3. Không đổi khổ / không có overlay / số liệu hỏng -> KHÔNG được đụng gì
// ---------------------------------------------------------------------------
{
    const items = [textItem()];
    const box = makeSandbox(items);
    assert.strictEqual(box.run({ width: 1080, height: 1920 }, { width: 1080, height: 1920 }), false,
        'khổ không đổi thì phải là no-op');
    assert.strictEqual(box.calls.recordHistory, 0, 'no-op không được ghi mốc Hoàn tác');
    assert.strictEqual(items[0].style.font_size, 58, 'no-op không được đổi cỡ chữ');

    [[null, { width: 1, height: 1 }], [{ width: 0, height: 0 }, { width: 100, height: 100 }],
     [{ width: 100, height: 100 }, undefined]].forEach((args, i) => {
        assert.strictEqual(box.run(args[0], args[1]), false, `đầu vào hỏng #${i} phải bị bỏ qua`);
    });
    assert.strictEqual(box.calls.recordHistory, 0, 'đầu vào hỏng cũng không được ghi mốc Hoàn tác');

    // Chỉ có audio -> không có gì trên khung hình để quy đổi.
    const onlyAudio = makeSandbox([{ id: 'a', type: 'audio', transform: { position_x: 5, position_y: 5 } }]);
    assert.strictEqual(onlyAudio.run({ width: 1080, height: 1920 }, { width: 2160, height: 3840 }), false,
        'chỉ có item audio thì phải là no-op');
}

// ---------------------------------------------------------------------------
// 4. Item audio nằm chung với overlay: vẫn không được đụng tới
// ---------------------------------------------------------------------------
{
    const audio = { id: 'a', type: 'audio', asset_id: '', transform: { position_x: 7, position_y: 9, scale: 100 } };
    const items = [textItem(), audio];
    makeSandbox(items).run({ width: 1080, height: 1920 }, { width: 2160, height: 3840 });
    assert.strictEqual(audio.transform.position_x, 7, 'item audio không được quy đổi');
    assert.strictEqual(audio.transform.position_y, 9, 'item audio không được quy đổi');
}

// ---------------------------------------------------------------------------
// 5. Đường nối dây trong index.html
// ---------------------------------------------------------------------------
{
    const preset = extractFunction(indexHtml, 'applySequencePreset');
    assert.ok(/const prevSize = sequenceSizeSnapshot\(\);/.test(preset),
        'applySequencePreset() phải chụp lại khổ CŨ trước khi đổi');
    assert.ok(/rescaleOverlaysAfterSequenceResize\(prevSize\)/.test(preset),
        'applySequencePreset() phải quy đổi overlay sau khi đổi khổ');

    /* KHÔNG được móc vào setSequenceSourceInfo: hàm đó còn chạy lúc nạp video nguồn và lúc
       mở dự án — quy đổi ở đó là bóp méo đúng cái dự án vừa mở ra. */
    const srcInfo = extractFunction(indexHtml, 'setSequenceSourceInfo');
    assert.ok(!/rescaleOverlaysAfterSequenceResize/.test(srcInfo),
        'setSequenceSourceInfo() KHÔNG được quy đổi overlay (nó chạy cả lúc mở dự án)');

    /* Hai ô W/H: quy đổi ở 'change', mốc so sánh lấy ở 'focus'. Gõ "3840" là bốn sự kiện
       'input'; quy đổi theo 'input' thì bố cục bị nhân bốn lần qua những khổ vô nghĩa. */
    const wh = indexHtml.slice(indexHtml.indexOf("['sequenceWidth', 'sequenceHeight'].forEach"));
    const block = wh.slice(0, wh.indexOf('\n    });') + 8);
    assert.ok(/addEventListener\('focus'/.test(block) && /sequenceSizeBeforeEdit = sequenceSizeSnapshot\(\)/.test(block),
        "ô W/H phải chụp khổ cũ ở 'focus'");
    assert.ok(/addEventListener\('change'[\s\S]*rescaleOverlaysAfterSequenceResize\(prev\)/.test(block),
        "ô W/H phải quy đổi ở 'change'");
    const inputHandler = block.slice(block.indexOf("addEventListener('input'"), block.indexOf("addEventListener('focus'"));
    assert.ok(!/rescaleOverlaysAfterSequenceResize/.test(inputHandler),
        "handler 'input' KHÔNG được quy đổi (mỗi ký tự gõ là một lần nhân bố cục)");
}

console.log('sequence_resize_rescale: OK');
