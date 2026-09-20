/* =====================================================================
 * MỐC XUẤT PHÁT CỦA CÚ KÉO KHUNG TRANSFORM PHẢI LÀ GIÁ TRỊ ĐANG THẤY
 *
 * VÌ SAO CÓ TEST NÀY (lỗi người dùng báo 2026-09-20): nắm một trong 4 góc khung transform
 * rồi bắt đầu rê chuột thì khung "nhảy" phắt sang một cỡ khác (nhỏ hơn hoặc lớn hơn tuỳ
 * keyframe tại playhead đang nằm phía nào so với base), và từ đó tới lúc thả chuột, điểm
 * góc thật của khung luôn lệch khỏi con trỏ.
 *
 * Nguyên nhân: HAI PHÍA ĐỌC HAI NGUỒN KHÁC NHAU.
 *   - renderSelectionBox() vẽ khung theo transform HIỆU DỤNG tại playhead (nội suy keyframe);
 *   - startPreviewBoxDrag() lại chốt mốc xuất phát bằng transform BASE (item.transform).
 * Với block đã có keyframe thì base ≠ hiệu dụng, nên cú mousemove đầu tiên ghi thẳng
 * base × (tỉ lệ ≈ 1) vào item -> khung nhảy; và centerX/centerY (tâm co giãn/xoay) cũng
 * lấy theo vị trí base nên lệch khỏi tâm khung đang vẽ suốt cú kéo.
 *
 * Bất biến test này giữ:
 *   1. item CÓ keyframe -> startTransform + tâm lấy theo giá trị HIỆU DỤNG tại playhead;
 *   2. item KHÔNG keyframe -> vẫn đúng như cũ (base);
 *   3. block lane chính -> mốc giờ cục bộ đi qua mainClipLocalTime(), không phải
 *      timeline_start (row lane chính không có field đó);
 *   4. phép đo khung dùng clientWidth/clientHeight chứ không phải rect.width — khung có
 *      `border: 1px` nên hai con số lệch nhau 2px, trộn hai nguồn là lệch ngay từ pixel đầu.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(projectRoot, 'static', 'js', 'editing-runtime.js'), 'utf8');
const TextAnimations = require(path.join(projectRoot, 'static', 'js', 'text-animations.js'));

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

// Sân khấu preview: sequence dọc 1080x1920, khung vẽ 270x480 (previewScale = 0.25) đặt ở
// (100, 50) trên màn hình. Khung có viền 1px nên rect rộng hơn client 2px — cố ý, để lộ
// ngay nếu toán kéo quay về đọc rect.width.
const SEQ = { width: 1080, height: 1920 };
const FRAME = { left: 100, top: 50, clientW: 270, clientH: 480, border: 1 };
const PREVIEW_SCALE = FRAME.clientW / SEQ.width;

const TRANSFORM_DEFAULTS = {
    position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100, flip_x: false, flip_y: false,
};

function makeSandbox({ item, seqTime, isMainClip = false, mainClipStart = 0 }) {
    const frameEl = {
        clientWidth: FRAME.clientW,
        clientHeight: FRAME.clientH,
        getBoundingClientRect: () => ({
            left: FRAME.left,
            top: FRAME.top,
            width: FRAME.clientW + FRAME.border * 2,
            height: FRAME.clientH + FRAME.border * 2,
        }),
    };
    const sandbox = {
        console,
        window: { TextAnimations },
        TextAnimations,
        theItem: item,
        seqTime,
        isMain: isMainClip,
        mainClipStart,
        selectedTimelineClipIndex: isMainClip ? 3 : -1,
        document: {
            getElementById: (id) => (id === 'sequencePreviewFrame' ? frameEl : null),
            body: { classList: { add() {}, remove() {} } },
        },
        historyCalls: 0,
    };
    vm.createContext(sandbox);
    vm.runInContext([
        'let previewBoxDrag = null;',
        `const TRANSFORM_DEFAULTS = ${JSON.stringify(TRANSFORM_DEFAULTS)};`,
        'function normalizeTransform(t) { return { ...TRANSFORM_DEFAULTS, ...(t || {}) }; }',
        `function payloadSequence() { return ${JSON.stringify(SEQ)}; }`,
        'function currentSequenceTime() { return seqTime; }',
        'function mainClipLocalTime() { return Math.max(0, seqTime - mainClipStart); }',
        'function isMainLaneBoxItem(it) { return isMain && it === theItem; }',
        'function selectedVisualItemForBox() { return theItem; }',
        'function isTrackLocked() { return false; }',
        'function findTrack() { return null; }',
        'function itemTrack() { return null; }',
        'function stopSelectionBoxEvent() {}',
        'function deepClone(v) { return JSON.parse(JSON.stringify(v)); }',
        'function measureTextItemBox() { return { contentWidth: 0 }; }',
        'function normalizeShapeStyle(s) { return { width: 100, height: 100, ...(s || {}) }; }',
        'function recordHistory() { historyCalls += 1; }',
        extractFunction(source, 'selectionBoxTransform'),
        extractFunction(source, 'previewFrameMetrics'),
        extractFunction(source, 'startPreviewBoxDrag'),
        'globalThis.start = startPreviewBoxDrag;',
        'globalThis.readDrag = () => previewBoxDrag;',
        'globalThis.metrics = previewFrameMetrics;',
    ].join('\n'), sandbox);
    return sandbox;
}

const mouseAt = (x, y) => ({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg} (được ${a}, mong ${b})`);

// ---- 1) Item CÓ keyframe: mốc xuất phát là giá trị HIỆU DỤNG tại playhead ----
{
    const item = {
        id: 'ov1',
        type: 'media',
        timeline_start: 2,
        transform: { scale: 158, position_x: 300, position_y: -200 },
        keyframes: {
            scale: [{ t: 0, v: 40, e: 'ease-in-out' }, { t: 2, v: 100, e: 'ease-in-out' }],
            position_x: [{ t: 0, v: 0, e: 'ease-in-out' }, { t: 2, v: 400, e: 'ease-in-out' }],
            position_y: [{ t: 0, v: 0, e: 'ease-in-out' }, { t: 2, v: 0, e: 'ease-in-out' }],
        },
    };
    const localT = 1.3;
    const effective = TextAnimations.effectiveTransformAt(
        { ...TRANSFORM_DEFAULTS, ...item.transform }, item.keyframes, localT);

    // base ≠ hiệu dụng ở cả scale lẫn vị trí — nếu không thì test này không chứng minh gì.
    assert.notStrictEqual(effective.scale, item.transform.scale, 'sân khấu hỏng: scale base trùng hiệu dụng');
    assert.notStrictEqual(effective.position_x, item.transform.position_x, 'sân khấu hỏng: X base trùng hiệu dụng');

    const box = makeSandbox({ item, seqTime: Number(item.timeline_start) + localT });
    box.start.call(null, mouseAt(300, 200), 'scale');
    const drag = box.readDrag();

    near(drag.startTransform.scale, effective.scale,
        'startTransform.scale phải là scale ĐANG THẤY tại playhead, không phải base');
    near(drag.centerX, FRAME.left + FRAME.clientW / 2 + effective.position_x * PREVIEW_SCALE,
        'tâm co giãn/xoay phải lấy theo vị trí hiệu dụng');
    near(drag.centerY, FRAME.top + FRAME.clientH / 2 + effective.position_y * PREVIEW_SCALE,
        'tâm co giãn/xoay phải lấy theo vị trí hiệu dụng');
    near(drag.previewScale, PREVIEW_SCALE, 'previewScale phải tính từ clientWidth, không phải rect.width');
    console.log('  ok  item có keyframe: mốc kéo bám giá trị hiệu dụng tại playhead');
}

// ---- 2) Item KHÔNG keyframe: giữ nguyên hành vi cũ (base) -------------------
{
    const item = {
        id: 'ov2',
        type: 'media',
        timeline_start: 0,
        transform: { scale: 158, position_x: 300, position_y: -200 },
        keyframes: {},
    };
    const box = makeSandbox({ item, seqTime: 1 });
    box.start.call(null, mouseAt(180, 120), 'scale');
    const drag = box.readDrag();
    near(drag.startTransform.scale, 158, 'không keyframe -> mốc kéo vẫn là base');
    near(drag.centerX, FRAME.left + FRAME.clientW / 2 + 300 * PREVIEW_SCALE, 'tâm theo base');
    near(drag.centerY, FRAME.top + FRAME.clientH / 2 + (-200) * PREVIEW_SCALE, 'tâm theo base');
    console.log('  ok  item không keyframe: hành vi cũ không đổi');
}

// ---- 3) Block LANE CHÍNH: giờ cục bộ đi qua mainClipLocalTime() ------------
// Row lane chính KHÔNG có `timeline_start`. Lấy nhầm field đó ra NaN và transform hiệu
// dụng rơi về base — đúng cái bẫy mà renderSelectionBox đã phải rào trước đó.
{
    const clip = {
        type: 'media',
        transform: { scale: 100, position_x: 0, position_y: 0 },
        keyframes: {
            scale: [{ t: 0, v: 50, e: 'ease-in-out' }, { t: 4, v: 150, e: 'ease-in-out' }],
        },
    };
    const localT = 2;
    const expected = TextAnimations.effectiveTransformAt(
        { ...TRANSFORM_DEFAULTS, ...clip.transform }, clip.keyframes, localT);
    const box = makeSandbox({ item: clip, seqTime: 7 + localT, isMainClip: true, mainClipStart: 7 });
    box.start.call(null, mouseAt(210, 160), 'scale');
    const drag = box.readDrag();
    near(drag.startTransform.scale, expected.scale,
        'lane chính: mốc kéo phải theo giờ cục bộ của span, không phải timeline_start');
    assert.strictEqual(drag.mainClipIndex, 3, 'lane chính phải nhớ CHỈ SỐ row, không phải id');
    console.log('  ok  lane chính: giờ cục bộ lấy qua mainClipLocalTime()');
}

/* ---- 4) Hợp đồng nguồn: hai phía phải dùng CHUNG một hàm ------------------
 * Chốt bằng văn bản vì đây đúng là cách lỗi quay lại được: ai đó chép lại phép nội suy
 * vào một trong hai phía rồi hai đường số lại trôi khỏi nhau trong im lặng. */
{
    const drag = extractFunction(source, 'startPreviewBoxDrag');
    assert.ok(/selectionBoxTransform\(item\)/.test(drag),
        'startPreviewBoxDrag phải lấy mốc qua selectionBoxTransform() — cùng nguồn với khung chọn');
    assert.ok(!/normalizeTransform\(item\.transform\)/.test(drag),
        'đọc thẳng item.transform chính là bản hỏng đã sửa ngày 2026-09-20');
    const render = extractFunction(source, 'renderSelectionBox');
    assert.ok(/selectionBoxTransform\(item, seqTime\)/.test(render),
        'renderSelectionBox cũng phải đi qua selectionBoxTransform()');
    const met = extractFunction(source, 'previewFrameMetrics');
    assert.ok(/clientWidth/.test(met) && /clientHeight/.test(met),
        'phép đo khung phải dùng clientWidth/clientHeight (khung có viền 1px)');
    console.log('  ok  nguồn: khung chọn và toán kéo dùng chung một phép tính');
}

console.log('preview_drag_start_effective: PASS');
