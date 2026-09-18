/* =====================================================================
 * VỊ TRÍ = MỘT KEYFRAME DÙNG CHUNG CHO CẢ X VÀ Y
 *
 * VÌ SAO CÓ TEST NÀY: trước đây bảng thông số có HAI hình thoi cho Vị trí (một cho X, một
 * cho Y), nên đánh dấu một mốc vị trí phải bấm hai lần — mọi phần mềm dựng khác (CapCut,
 * Premiere) chỉ bấm một. Bản gộp giữ NGUYÊN dữ liệu hai mảng `position_x` / `position_y`
 * (đường xuất, sidecar và file .crab cũ không đổi một dòng) và chỉ thêm một BẤT BIẾN:
 *   hai mảng luôn có keyframe tại CÙNG bộ mốc thời gian.
 * Bất biến đó sống ở BA chỗ rời nhau, hỏng một chỗ là vỡ:
 *   1. `toggleKeyframeForSelected('position')` — bật/tắt phải áp cho CẢ hai trục.
 *   2. `pairPositionKeyframeAt()` — ghi một trục (kéo chuột / gõ số) thì trục kia phải
 *      được chèn keyframe tại đúng mốc đó.
 *   3. `TextAnimations.pairPositionKeyframes()` — vá dữ liệu cũ khi mở dự án.
 * Và một hợp đồng UI: markup chỉ được còn MỘT cụm nút, mang `data-kf-field="position"`.
 *
 * ĐIỀU QUAN TRỌNG NHẤT phải giữ: mọi thao tác ghép cặp KHÔNG được đổi đường chuyển động
 * đã có — giá trị chèn luôn là giá trị NỘI SUY tại mốc đó.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(projectRoot, 'static', 'js', 'editing-runtime.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
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

/* Sân khấu: các hàm keyframe THẬT lấy từ nguồn, còn móc nối ra ngoài (chọn khối, khoá
 * track, playhead, vẽ lại) thì cắm bản tối giản. `localTime` là playhead cục bộ dùng cho
 * mọi đối tượng — đủ cho phạm vi test này. */
function makeSandbox(item, localTime) {
    const sandbox = {
        window: { TextAnimations },
        TextAnimations,
        latestTimeline: [],
        calls: { recordHistory: 0, renderAll: 0 },
        localTime,
    };
    vm.createContext(sandbox);
    vm.runInContext([
        'const KF_EPS = 0.02;',
        'function recordHistory() { calls.recordHistory += 1; }',
        'function renderAll() { calls.renderAll += 1; }',
        'function isTrackLocked() { return false; }',
        'function itemTrack() { return null; }',
        'function findTrack() { return null; }',
        'function selectedMainIndexesArray() { return []; }',
        'function selectedItemsArray() { return [globalThis.target]; }',
        'function overlayLocalTime() { return localTime; }',
        'function mainClipLocalTime() { return localTime; }',
        'function normalizeTransform(t) { return { ...(t || {}) }; }',
        'function ensureClipTransform(c) { return c.transform; }',
        'function ensureMainClipAudioVolume() { return 100; }',
        'function normalizeVolumePercent(v) { return Number(v) || 0; }',
        // Biên thật của Vị trí không thuộc phạm vi test này; giữ nguyên giá trị để so sánh
        // số học không bị biên cắt mất.
        'function clampTransformValue(field, v) { return Number(v) || 0; }',
        extractFunction(source, 'kfFields'),
        extractFunction(source, 'positionKfFields'),
        extractFunction(source, 'isPositionKfControl'),
        extractFunction(source, 'kfControlFields'),
        extractFunction(source, 'kfListForControl'),
        extractFunction(source, 'objectKeyframes'),
        extractFunction(source, 'fieldHasKeyframes'),
        extractFunction(source, 'upsertKeyframe'),
        extractFunction(source, 'removeKeyframeAt'),
        extractFunction(source, 'pairPositionKeyframeAt'),
        extractFunction(source, 'keyframeNavTarget'),
        extractFunction(source, 'toggleKeyframeForSelected'),
        'globalThis.toggleKf = toggleKeyframeForSelected;',
        'globalThis.pairAt = pairPositionKeyframeAt;',
        'globalThis.listFor = kfListForControl;',
        'globalThis.navTarget = keyframeNavTarget;',
    ].join('\n'), sandbox);
    sandbox.target = item;
    return sandbox;
}

/* Array.from chứ không phải .map(): mảng do hàm trong vm tạo ra thuộc realm KHÁC, nên
 * prototype của nó không phải Array.prototype của host và deepStrictEqual sẽ báo lệch dù
 * nội dung giống hệt. Array.from dựng lại mảng trong realm của test. */
const times = (list) => Array.from(list || [], (k) => Number(Number(k.t).toFixed(4)));
const values = (list) => Array.from(list || [], (k) => Number(Number(k.v).toFixed(4)));

// ---- 1) Một lần bấm hình thoi = keyframe cho CẢ hai trục -------------------
{
    const item = { transform: { position_x: -11.1, position_y: -904.7 }, keyframes: {} };
    const box = makeSandbox(item, 1.5);
    box.toggleKf.call(null, 'position');
    assert.deepStrictEqual(times(item.keyframes.position_x), [1.5], 'X phải có keyframe tại playhead');
    assert.deepStrictEqual(times(item.keyframes.position_y), [1.5], 'Y phải có keyframe tại CÙNG mốc');
    assert.deepStrictEqual(values(item.keyframes.position_x), [-11.1]);
    assert.deepStrictEqual(values(item.keyframes.position_y), [-904.7],
        'giá trị khởi tạo phải là giá trị hiệu dụng của TỪNG trục, không lấy chung một số');
    console.log('  ok  bấm 1 lần -> keyframe cả X và Y, đúng giá trị từng trục');
}

// ---- 2) Bấm lại tại cùng mốc = xoá CẢ hai trục ----------------------------
{
    const item = {
        transform: { position_x: 0, position_y: 0 },
        keyframes: {
            position_x: [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 100, e: 'linear' }],
            position_y: [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 50, e: 'linear' }],
        },
    };
    const box = makeSandbox(item, 2);
    box.toggleKf.call(null, 'position');
    assert.deepStrictEqual(times(item.keyframes.position_x), [0], 'mốc 2s phải biến khỏi X');
    assert.deepStrictEqual(times(item.keyframes.position_y), [0], 'mốc 2s phải biến khỏi Y');
    console.log('  ok  bấm lại -> xoá cả cụm, không để sót nửa dữ liệu');
}

// ---- 3) Dữ liệu cũ lệch nhau: một trục có keyframe, trục kia không --------
// Nút đang sáng (X có keyframe ở đây) nên bấm phải là XOÁ, và xoá sạch.
{
    const item = {
        transform: { position_x: 0, position_y: 0 },
        keyframes: { position_x: [{ t: 1, v: 30, e: 'linear' }] },
    };
    const box = makeSandbox(item, 1);
    box.toggleKf.call(null, 'position');
    assert.ok(!item.keyframes.position_x, 'X phải được dọn sạch');
    assert.ok(!item.keyframes.position_y, 'Y vốn rỗng thì vẫn rỗng');
    console.log('  ok  dữ liệu lệch: bấm lại vẫn dọn sạch được');
}

// ---- 4) Ghi MỘT trục -> trục kia được ghép mốc, đường đi KHÔNG đổi --------
{
    const item = {
        transform: { position_x: 0, position_y: 0 },
        keyframes: {
            position_x: [{ t: 0, v: 0, e: 'linear' }, { t: 4, v: 400, e: 'linear' }],
            position_y: [{ t: 0, v: 0, e: 'linear' }, { t: 4, v: 200, e: 'linear' }],
        },
    };
    const box = makeSandbox(item, 1);
    const yBefore = [0, 0.5, 1, 2, 4].map((t) => TextAnimations.evalKeyframeField(item.keyframes.position_y, t));
    // Kéo khối sang ngang tại 1s: chỉ trục X đổi giá trị (auto-keyframe đã ghi mốc 1s cho X).
    item.keyframes.position_x = [{ t: 0, v: 0, e: 'linear' }, { t: 1, v: 999, e: 'ease-in-out' }, { t: 4, v: 400, e: 'linear' }];
    box.pairAt.call(null, item, 'position_x', 1);
    assert.deepStrictEqual(times(item.keyframes.position_y), [0, 1, 4], 'Y phải được chèn keyframe tại 1s');
    const yAfter = [0, 0.5, 1, 2, 4].map((t) => TextAnimations.evalKeyframeField(item.keyframes.position_y, t));
    assert.deepStrictEqual(yAfter.map((v) => Number(v.toFixed(6))), yBefore.map((v) => Number(v.toFixed(6))),
        'chèn keyframe ghép cặp KHÔNG được làm lệch đường chuyển động của trục kia');
    console.log('  ok  ghi một trục -> trục kia ghép mốc mà đường đi giữ nguyên');
}

// ---- 5) Trục kia CHƯA hề có keyframe -> không tự sinh ---------------------
// Lúc đó người dùng chưa bật keyframe vị trí; sinh ra là tự ý biến giá trị tĩnh thành động.
{
    const item = {
        transform: { position_x: 0, position_y: 254 },
        keyframes: { position_x: [{ t: 0, v: 0, e: 'linear' }] },
    };
    const box = makeSandbox(item, 0);
    box.pairAt.call(null, item, 'position_x', 0);
    assert.ok(!item.keyframes.position_y, 'không được tự sinh keyframe cho trục chưa bật');
    console.log('  ok  trục chưa bật keyframe thì không bị đụng tới');
}

// ---- 6) Nút ◂ ▸ nhảy theo mốc HỢP của cả hai trục -------------------------
{
    const item = {
        transform: {},
        keyframes: {
            position_x: [{ t: 0, v: 0 }, { t: 3, v: 10 }],
            position_y: [{ t: 0, v: 0 }, { t: 3.005, v: 20 }],
        },
    };
    const box = makeSandbox(item, 0);
    const list = box.listFor.call(null, item, 'position');
    assert.deepStrictEqual(times(list), [0, 3],
        'hai mốc lệch nhau 5ms (dưới KF_EPS) phải gộp thành MỘT, không thành hai lần nhảy');
    assert.strictEqual(box.navTarget.call(null, list, 0, 'next'), 3);
    assert.strictEqual(box.navTarget.call(null, list, 3, 'next'), null);
    console.log('  ok  ◂ ▸ chạy trên mốc hợp nhất của hai trục');
}

// ---- 7) Hợp đồng markup: CHỈ còn một cụm nút, mang field ảo 'position' ----
{
    const perAxis = indexHtml.match(/data-kf-field="position_[xy]"/g) || [];
    assert.strictEqual(perAxis.length, 0,
        `còn ${perAxis.length} nút keyframe theo từng trục trong index.html — phải gộp hết về "position"`);
    const diamonds = indexHtml.match(/class="kf-diamond" data-kf-field="position"/g) || [];
    assert.strictEqual(diamonds.length, 1, 'phải có ĐÚNG một hình thoi cho Vị trí');
    const navs = indexHtml.match(/class="kf-nav" data-kf-field="position"/g) || [];
    assert.strictEqual(navs.length, 2, 'phải có đúng hai mũi tên ◂ ▸ cho Vị trí');
    // Cụm nút nằm ở CỘT THỨ BA của hàng, nên hàng phải khai lại grid 3 cột.
    assert.ok(/class="ins-row-2 ins-row-2-kf"/.test(indexHtml),
        'hàng Vị trí phải mang ins-row-2-kf (grid 3 cột) để cụm nút có chỗ đứng');
    assert.ok(/\.ins-row-2-kf\s*\{[^}]*grid-template-columns:\s*1fr 1fr auto/.test(indexHtml),
        'thiếu luật CSS grid 3 cột cho .ins-row-2-kf');
    console.log('  ok  markup + CSS: đúng một cụm nút "position" ở cột thứ ba');
}

// ---- 8) 'position' KHÔNG được lọt vào KEYFRAME_FIELDS ---------------------
// Nó là field ẢO, không có mảng dữ liệu; lọt vào là mọi vòng lặp render/xuất đọc nhầm.
{
    assert.ok(!TextAnimations.KEYFRAME_FIELDS.includes(TextAnimations.POSITION_KEYFRAME_FIELD),
        "'position' là field ảo của UI, không được nằm trong KEYFRAME_FIELDS");
    assert.deepStrictEqual(TextAnimations.POSITION_KEYFRAME_FIELDS, ['position_x', 'position_y']);
    // Đường sinh biểu thức FFmpeg vẫn đọc hai trục riêng -> bản xuất không đổi.
    const exprs = TextAnimations.keyframeFfmpegExprs({
        position_x: [{ t: 0, v: 0, e: 'linear' }, { t: 1, v: 10, e: 'linear' }],
        position_y: [{ t: 0, v: 0, e: 'linear' }, { t: 1, v: 20, e: 'linear' }],
    });
    assert.ok(exprs && exprs.x_expr && exprs.y_expr, 'export vẫn phải sinh x_expr và y_expr riêng');
    console.log('  ok  dữ liệu/đường xuất giữ nguyên hai trục');
}

// ---- 9) Vá dự án cũ: ghép mốc mà không đổi hình ảnh -----------------------
{
    const obj = {
        transform: { position_x: 0, position_y: 254 },
        keyframes: {
            position_x: [{ t: 0, v: 0, e: 'linear' }, { t: 4, v: 400, e: 'linear' }],
            position_y: [{ t: 1, v: 10, e: 'linear' }, { t: 3, v: 30, e: 'linear' }],
        },
    };
    const probe = [0, 0.5, 1, 2, 3, 4];
    const before = probe.map((t) => [
        TextAnimations.evalKeyframeField(obj.keyframes.position_x, t),
        TextAnimations.evalKeyframeField(obj.keyframes.position_y, t)]);
    assert.strictEqual(TextAnimations.pairPositionKeyframes(obj), true);
    assert.deepStrictEqual(times(obj.keyframes.position_x), [0, 1, 3, 4]);
    assert.deepStrictEqual(times(obj.keyframes.position_y), [0, 1, 3, 4]);
    const after = probe.map((t) => [
        TextAnimations.evalKeyframeField(obj.keyframes.position_x, t),
        TextAnimations.evalKeyframeField(obj.keyframes.position_y, t)]);
    before.forEach((pair, i) => {
        assert.ok(Math.abs(pair[0] - after[i][0]) < 1e-9 && Math.abs(pair[1] - after[i][1]) < 1e-9,
            `vá dự án cũ làm lệch vị trí tại t=${probe[i]}`);
    });
    // Chạy lại không được sinh thêm gì.
    const snapshot = JSON.stringify(obj.keyframes);
    TextAnimations.pairPositionKeyframes(obj);
    assert.strictEqual(JSON.stringify(obj.keyframes), snapshot, 'pairPositionKeyframes phải idempotent');

    // Trục rỗng hoàn toàn -> lấp bằng giá trị TĨNH, vị trí trên khung không đổi.
    const oneAxis = {
        transform: { position_x: 0, position_y: 254 },
        keyframes: { position_x: [{ t: 0, v: 0, e: 'linear' }, { t: 2, v: 100, e: 'linear' }] },
    };
    TextAnimations.pairPositionKeyframes(oneAxis);
    assert.deepStrictEqual(times(oneAxis.keyframes.position_y), [0, 2]);
    assert.deepStrictEqual(values(oneAxis.keyframes.position_y), [254, 254],
        'trục chưa keyframe phải được lấp bằng đúng giá trị tĩnh đang có');
    console.log('  ok  vá dự án cũ: ghép mốc, giữ nguyên hình ảnh, idempotent');
}

// ---- 10) Không có keyframe vị trí -> không đụng gì ------------------------
{
    const obj = { transform: {}, keyframes: { scale: [{ t: 0, v: 100 }] } };
    assert.strictEqual(TextAnimations.pairPositionKeyframes(obj), false);
    assert.ok(!obj.keyframes.position_x && !obj.keyframes.position_y);
    assert.strictEqual(TextAnimations.pairPositionKeyframes(null), false);
    assert.strictEqual(TextAnimations.pairPositionKeyframes({}), false);
    console.log('  ok  khối không keyframe vị trí thì không bị đụng tới');
}

console.log('position keyframe pairing ok');
