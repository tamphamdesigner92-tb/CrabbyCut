/* =====================================================================
 * KÉO KHUNG TRANSFORM TRÊN PREVIEW PHẢI GHI KEYFRAME TẠI PLAYHEAD
 *
 * VÌ SAO CÓ TEST NÀY (lỗi người dùng báo 2026-09-19): kéo tay cầm góc của khung chọn để
 * phóng to/thu nhỏ một block ĐÃ CÓ KEYFRAME thì hình không nhúc nhích, ô Scale ở bảng
 * Thuộc tính đứng im, "làm xong như chưa làm gì" — trong khi HUD trên khung xem trước
 * vẫn nhảy số. Nguyên nhân nằm gọn trong một biểu thức của mirrorTransformToKeyframes:
 *
 *     Number.isFinite(Number(localT)) ? Number(localT) : overlayLocalTime(item)
 *
 * `Number(null)` ra 0 chứ KHÔNG ra NaN, nên nhánh "đã có mốc tính sẵn" luôn thắng và mốc
 * luôn là 0. Đường kéo overlay truyền thẳng `null` (ý là "tự tính giùm"), nên MỌI cú kéo
 * box trên overlay đều ghi keyframe vào ĐẦU block. Với block đã có keyframe ở đúng field
 * đang kéo, giá trị tại playhead giữ nguyên -> preview và bảng thông số (đều đọc giá trị
 * HIỆU DỤNG tại playhead) không đổi, còn keyframe ở mốc 0 thì bị sửa lén.
 *
 * Hai bất biến test này giữ:
 *   1. gọi KHÔNG truyền mốc (overlay) -> ghi tại overlayLocalTime(), không phải 0;
 *   2. gọi CÓ truyền mốc (block lane chính) -> ghi đúng mốc được truyền.
 * Và một bất biến phụ: field KHÔNG có keyframe thì không tự sinh keyframe mới.
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

/* Sân khấu: hàm keyframe THẬT lấy từ nguồn; móc nối ra ngoài cắm bản tối giản.
 * `overlayLocalTime` trả về mốc playhead CỤC BỘ của overlay — đúng thứ mà bản hỏng bỏ qua. */
function makeSandbox(item, overlayT) {
    const sandbox = { overlayT, window: { TextAnimations }, TextAnimations };
    vm.createContext(sandbox);
    vm.runInContext([
        'const KF_EPS = 0.02;',
        'function overlayLocalTime() { return overlayT; }',
        'function normalizeTransform(t) { return { ...(t || {}) }; }',
        'function clampTransformValue(field, v) { return Number(v) || 0; }',
        extractFunction(source, 'kfFields'),
        extractFunction(source, 'positionKfFields'),
        extractFunction(source, 'objectKeyframes'),
        extractFunction(source, 'fieldHasKeyframes'),
        extractFunction(source, 'upsertKeyframe'),
        extractFunction(source, 'pairPositionKeyframeAt'),
        extractFunction(source, 'mirrorTransformToKeyframes'),
        'globalThis.mirror = mirrorTransformToKeyframes;',
    ].join('\n'), sandbox);
    return sandbox;
}

const times = (list) => Array.from(list || [], (k) => Number(Number(k.t).toFixed(4)));
const values = (list) => Array.from(list || [], (k) => Number(Number(k.v).toFixed(4)));

// ---- 1) Overlay: không truyền mốc -> ghi tại playhead, KHÔNG phải mốc 0 ----
{
    const item = {
        transform: { scale: 158 },
        keyframes: { scale: [{ t: 0, v: 40, e: 'ease-in-out' }, { t: 1, v: 100, e: 'ease-in-out' }] },
    };
    const box = makeSandbox(item, 1);
    box.mirror.call(null, item, ['scale'], null);
    assert.deepStrictEqual(times(item.keyframes.scale), [0, 1],
        'không được đẻ thêm mốc mới — playhead đang đứng đúng trên keyframe 1s');
    assert.deepStrictEqual(values(item.keyframes.scale), [40, 158],
        'giá trị vừa kéo phải vào keyframe TẠI PLAYHEAD (1s); keyframe mốc 0 không được đụng tới');
    console.log('  ok  overlay: kéo tại 1s -> ghi vào keyframe 1s, giữ nguyên keyframe 0s');
}

// ---- 2) Overlay: playhead ở giữa hai keyframe -> chèn mốc mới tại playhead --
{
    const item = {
        transform: { scale: 77 },
        keyframes: { scale: [{ t: 0, v: 40, e: 'ease-in-out' }, { t: 2, v: 100, e: 'ease-in-out' }] },
    };
    const box = makeSandbox(item, 1.2);
    box.mirror.call(null, item, ['scale'], null);
    assert.deepStrictEqual(times(item.keyframes.scale), [0, 1.2, 2],
        'phải chèn keyframe MỚI tại playhead 1.2s');
    assert.deepStrictEqual(values(item.keyframes.scale), [40, 77, 100],
        'hai mốc cũ giữ nguyên giá trị; chỉ mốc mới mang giá trị vừa kéo');
    console.log('  ok  overlay: kéo giữa hai mốc -> chèn keyframe tại playhead');
}

// ---- 3) Lane chính: mốc được TRUYỀN VÀO phải thắng overlayLocalTime() ------
// Block lane chính không có `timeline_start` nên overlayLocalTime() cho số vô nghĩa;
// nơi gọi truyền mainClipLocalTime(). Truyền 0 là trường hợp dễ hỏng nhất (0 trông y hệt
// "chưa có mốc" nếu ai đó lại viết `Number(localT) || ...`).
{
    const item = {
        transform: { scale: 133 },
        keyframes: { scale: [{ t: 0, v: 50, e: 'ease-in-out' }, { t: 3, v: 90, e: 'ease-in-out' }] },
    };
    const box = makeSandbox(item, 99); // overlayLocalTime cố tình sai để lộ nếu bị dùng nhầm
    box.mirror.call(null, item, ['scale'], 0);
    assert.deepStrictEqual(times(item.keyframes.scale), [0, 3], 'mốc 0 truyền vào phải được dùng');
    assert.deepStrictEqual(values(item.keyframes.scale), [133, 90]);
    console.log('  ok  lane chính: mốc truyền vào (kể cả 0) được tôn trọng');
}

// ---- 4) Field KHÔNG có keyframe thì không tự sinh keyframe -----------------
{
    const item = { transform: { scale: 158, rotation: 12 }, keyframes: { rotation: [{ t: 1, v: 0, e: 'ease-in-out' }] } };
    const box = makeSandbox(item, 1);
    box.mirror.call(null, item, ['scale'], null);
    assert.ok(!item.keyframes.scale, 'Scale chưa keyframe -> kéo box chỉ đổi base, không đẻ keyframe');
    assert.deepStrictEqual(values(item.keyframes.rotation), [0], 'field không nằm trong thao tác thì không bị động tới');
    console.log('  ok  field chưa keyframe -> không tự sinh keyframe');
}

// ---- 5) Di chuyển: ghi X thì Y phải có keyframe tại CÙNG mốc --------------
{
    const item = {
        transform: { position_x: 120, position_y: -30 },
        keyframes: {
            position_x: [{ t: 0, v: 0, e: 'ease-in-out' }, { t: 2, v: 200, e: 'ease-in-out' }],
            position_y: [{ t: 0, v: 0, e: 'ease-in-out' }, { t: 2, v: 0, e: 'ease-in-out' }],
        },
    };
    const box = makeSandbox(item, 0.8);
    box.mirror.call(null, item, ['position_x', 'position_y'], null);
    assert.deepStrictEqual(times(item.keyframes.position_x), [0, 0.8, 2]);
    assert.deepStrictEqual(times(item.keyframes.position_y), [0, 0.8, 2],
        'hai trục phải luôn có keyframe tại cùng bộ mốc');
    assert.deepStrictEqual(values(item.keyframes.position_x), [0, 120, 200]);
    assert.deepStrictEqual(values(item.keyframes.position_y), [0, -30, 0]);
    console.log('  ok  kéo di chuyển -> X và Y cùng có mốc tại playhead');
}

/* ---- 6) Hợp đồng nguồn: đừng bọc Number() quanh mốc nữa ------------------
 * Chốt bằng văn bản vì đây đúng là cách lỗi đã quay lại được: ai đó "dọn dẹp" cho gọn
 * rồi viết lại `Number(localT)` là 0 lại nuốt mất nhánh tự tính, mà 5 kiểm tra ở trên
 * vẫn có thể xanh nếu họ đồng thời đổi cả nơi gọi. */
{
    const fn = extractFunction(source, 'mirrorTransformToKeyframes');
    assert.ok(/Number\.isFinite\(localT\)/.test(fn),
        'mốc phải được kiểm bằng Number.isFinite(localT) trên GIÁ TRỊ GỐC — Number(null) ra 0 nên bọc Number() là hỏng');
    assert.ok(!/Number\.isFinite\(Number\(localT\)\)/.test(fn),
        'Number.isFinite(Number(localT)) chính là bản hỏng đã sửa ngày 2026-09-19');
    console.log('  ok  nguồn vẫn kiểm mốc trên giá trị gốc');
}

console.log('preview_drag_keyframe_mirror: PASS');
