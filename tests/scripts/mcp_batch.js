/* =====================================================================
 * LỆNH GỘP CỦA MCP — crabbycut_add_media_batch / crabbycut_batch / keyframe qua update_block
 *
 * VÌ SAO CÓ TEST NÀY: mục đích của lệnh gộp là ba lời hứa, và cả ba đều hỏng ÂM THẦM:
 *   1) CẢ LÔ = MỘT BƯỚC HOÀN TÁC. Mỗi hàm thao tác của runtime tự recordHistory(); quên treo
 *      lịch sử là một lô 20 ảnh thành 20+ bước, vượt trần Hoàn tác (20) — Ctrl+Z không bao
 *      giờ quay về được trạng thái trước lô. Nhập tệp tự ghi một mốc: phần đặt block phải
 *      NHẬP CHUNG vào mốc đó chứ không thêm bước thứ hai.
 *   2) CẢ LÔ = MỘT LƯỢT VẼ. addItemForAsset/selectEditingItem mỗi cái gọi renderAll(); quên
 *      treo vẽ thì lô vẫn đúng dữ liệu, chỉ chậm — không ai thấy lỗi, chỉ thấy app ì.
 *   3) LỖI GIỮA CHỪNG = HOÀN NGUYÊN SẠCH, kể cả khi chồng Hoàn tác ĐÃ ĐẦY (độ dài đứng yên
 *      vì shift, so độ dài là tưởng không có mốc mới và bỏ qua quay lui).
 * Thêm: keyframe ghi đúng mốc/đúng easing, vị trí X/Y luôn có mốc trùng nhau
 * (pairPositionKeyframes), tham chiếu "$0.item_id" giữa các bước của crabbycut_batch.
 *
 * CÁCH ĐO: chạy static/js/automation-bridge.js THẬT trong vm, với text-animations.js và
 * color-adjust.js thật. Các hàm treo vẽ / treo lịch sử / upsertKeyframe bóc THẲNG từ
 * editing-runtime.js; phần còn lại của runtime (thêm block, chọn block) là bản giả tối giản
 * nhưng gọi renderAll()/recordHistory() đúng như bản thật.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const runtimeJs = fs.readFileSync(path.join(projectRoot, 'static', 'js', 'editing-runtime.js'), 'utf8');
const bridgeJs = fs.readFileSync(path.join(projectRoot, 'static', 'js', 'automation-bridge.js'), 'utf8');
const TextAnimations = require(path.join(projectRoot, 'static', 'js', 'text-animations.js'));
const ColorAdjust = require(path.join(projectRoot, 'static', 'js', 'color-adjust.js'));

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
    throw new Error(`hàm ${name}() không đóng ngoặc`);
}

const ok = (msg) => console.log(`  ok  ${msg}`);
// Mảng sinh trong vm khác realm (prototype khác) -> so qua JSON.
const deepEq = (actual, expected, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

// renderAll THẬT mở đầu bằng cổng treo vẽ + bộ đếm — bản giả phải mở đầu y hệt.
const renderAllSrc = extractFunction(runtimeJs, 'renderAll');
assert.ok(/^function renderAll\(\) \{\s*if \(renderGated\('all'\)\) return;\s*renderAllRuns \+= 1;/.test(renderAllSrc),
    'renderAll() phải mở đầu bằng `if (renderGated(\'all\')) return; renderAllRuns += 1;`');
for (const name of ['renderEditingTimeline', 'renderPreviewOverlays', 'renderEditPanel']) {
    assert.ok(/renderGated\('(all|panel)'\)/.test(extractFunction(runtimeJs, name).slice(0, 400)),
        `${name}() phải đi qua cổng treo vẽ (renderGated) — không thì lệnh gộp vẽ lại theo từng block`);
}
assert.ok(/patchedUpdateTimelineLayout\(\) \{\s*if \(renderGated\('all'\)\) return;/.test(runtimeJs),
    'updateTimelineLayout (bản vá) phải đi qua cổng treo vẽ');
assert.ok(/patchedUpdateSequencePreviewTransform\(\) \{\s*if \(renderGated\('all'\)\) return;/.test(runtimeJs),
    'updateSequencePreviewTransform (bản vá) phải đi qua cổng treo vẽ');
ok('mọi đường vẽ lại của runtime đều đi qua cổng treo vẽ');

function makeApp({ undoPrefill = 0 } = {}) {
    const sandbox = {
        console,
        navigator: { platform: 'Win32' },
        TextAnimations,
        ColorAdjust,
        currentMode: 'FINAL',
        currentStepId: 'step4',
        latestTimeline: [],
        undoStack: [],
        redoStack: [],
        playheadTime: 1,
        _t: (s) => s,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`
        function maxHistory() { return 20; }
        function captureFullState() {
            return JSON.parse(JSON.stringify({ items: rtState.editingItems, assets: rtState.editingAssets }));
        }
        function saveHistoryState() {
            undoStack.push(captureFullState());
            if (undoStack.length > maxHistory()) undoStack.shift();
            redoStack = [];
        }
        function restoreHistoryState(state) {
            rtState.editingItems.splice(0, Infinity, ...JSON.parse(JSON.stringify(state.items)));
            rtState.editingAssets.splice(0, Infinity, ...JSON.parse(JSON.stringify(state.assets)));
            updateTimelineLayout();
        }
        function executeUndo() { if (undoStack.length) restoreHistoryState(undoStack.pop()); }
        function updateUndoRedoButtons() {}
        function getCurrentTimelineTime() { return playheadTime; }
        function clipSequenceDuration(clip) { return Number(clip.end) - Number(clip.start); }
        function clampTransformValue(field, value) {
            const lim = { scale: [1, 1000], opacity: [0, 100], rotation: [-3600, 3600] }[field] || [-20000, 20000];
            return Math.max(lim[0], Math.min(lim[1], Number(value)));
        }
        var rtState = { editingItems: [], editingAssets: [], editingTracks: [{ id: 'track_media_1', type: 'media' }, { id: 'track_text_1', type: 'text' }] };
        var selectedId = '';
        var idSeq = 0;
        const KF_EPS = 0.02;
        let historySuspended = 0;
        let renderSuspendDepth = 0;
        const renderDirty = { all: false, panel: false };
        let renderAllRuns = 0;
        var panelRuns = 0;
        ${extractFunction(runtimeJs, 'recordHistory')}
        ${extractFunction(runtimeJs, 'beginHistoryBatch')}
        ${extractFunction(runtimeJs, 'suspendHistory')}
        ${extractFunction(runtimeJs, 'renderGated')}
        ${extractFunction(runtimeJs, 'suspendRender')}
        ${extractFunction(runtimeJs, 'upsertKeyframe')}
        function renderAll() {
            if (renderGated('all')) return;
            renderAllRuns += 1;
        }
        function renderEditPanel() { if (renderGated('panel')) return; panelRuns += 1; }
        function renderPreviewOverlays() { if (renderGated('all')) return; }
        function updateTimelineLayout() { if (renderGated('all')) return; }
        function updateSequencePreviewTransform() { if (renderGated('all')) return; renderPreviewOverlays(); }
        function findItem(id) { return rtState.editingItems.find((it) => it.id === id) || null; }
        function selectItem(id) { selectedId = id; renderAll(); }
        function nextTime(trackId) {
            return rtState.editingItems.filter((it) => it.track_id === trackId);
        }
        function addItemForAsset(asset, _type, placement, trim) {
            const type = asset.type === 'audio' ? 'audio' : 'media';
            const trackId = (placement && placement.trackId) || (type === 'audio' ? 'track_audio_1' : 'track_media_1');
            const start = placement && Number.isFinite(Number(placement.start)) ? Number(placement.start) : playheadTime;
            const duration = Number(placement && placement.duration) > 0 ? Number(placement.duration) : 5;
            const item = { id: 'item_' + (++idSeq), type, track_id: trackId, timeline_start: start, duration,
                asset_id: asset.id, source_start: trim ? trim.start : 0, volume: 100, muted: false,
                transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100, flip_x: false, flip_y: false } };
            rtState.editingItems.push(item);
            selectItem(item.id);     // bản thật: selectEditingItem -> renderAll
            renderAll();             // bản thật: renderAll ở cuối addItemForAsset
            return item;
        }
        async function importLocalPaths(kind, paths) {
            const fresh = paths.filter((p) => !/missing/.test(p));
            if (!fresh.length) throw new Error('Nhập tệp thất bại (400)');
            recordHistory();
            fresh.forEach((p) => rtState.editingAssets.push({ id: 'asset_' + (++idSeq), type: kind === 'audio' ? 'audio' : 'media_image', source_path: p, path: p }));
            renderEditPanel();
        }
        function addTextItem(placement, options) {
            recordHistory();
            const item = { id: 'item_' + (++idSeq), type: 'text', track_id: 'track_text_1',
                timeline_start: placement && placement.start !== undefined ? placement.start : playheadTime,
                duration: Number(options && options.duration) || 5, text: options.text,
                transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 } };
            rtState.editingItems.push(item);
            selectItem(item.id);
            renderAll();
            return item;
        }
        var EditingRuntime = {
            beginHistoryBatch,
            renderAll,
            renderEditingTimeline: renderAll,
            renderPreviewOverlays,
            selectItem,
            addTextItem,
            getState: () => rtState,
            automation: {
                importLocalPaths,
                linkAssetPaths: importLocalPaths,
                addItemForAsset,
                findAsset: (id) => rtState.editingAssets.find((a) => a.id === id) || null,
                findItem,
                findTrack: (id) => ({ id }),
                isTrackLocked: () => false,
                ensureAssetProbed: async (asset) => asset,
                clampItemTiming: () => {},
                itemSourceDurationLimit: () => Infinity,
                itemSupportsAnimation: (it) => ['media', 'text', 'shape'].includes(it.type),
                applyTransformToSelected: (field, value) => {
                    const it = findItem(selectedId);
                    it.transform[field] = clampTransformValue(field, value);
                },
                applyVolumeToSelected: (v) => { findItem(selectedId).volume = v; },
                normalizeVolumePercent: (v) => Math.max(0, Math.min(1000, Number(v))),
                mainClipSequenceSpans: () => [],
                refreshAdjustPanel: () => {},
                adjustLutCatalog: () => [],
                suspendRender,
                suspendHistory,
                upsertKeyframe,
                renderStats: () => ({ renderAll: renderAllRuns, suspended: renderSuspendDepth }),
            },
        };
        var Transitions = { DUR_MIN: 0.1, DUR_MAX: 2, DUR_DEFAULT: 0.5, optionById: (id) => (id === 'fade' ? { id } : null), clampDuration: (d) => d };
        var desktopEnv = {
            onAutomationCall(fn) { this.handler = fn; },
            setAutomationEnabled: async () => ({ enabled: true }),
        };
    `, sandbox);
    vm.runInContext(bridgeJs, sandbox, { filename: 'automation-bridge.js' });
    const call = (method, params) => sandbox.desktopEnv.handler(method, params);
    for (let i = 0; i < undoPrefill; i += 1) vm.runInContext('saveHistoryState()', sandbox);
    const renders = () => vm.runInContext('renderAllRuns', sandbox);
    return { sandbox, call, renders, state: sandbox.rtState };
}

const COMBO = TextAnimations.COMBO_OPTIONS[0].value;

// ---------------------------------------------------------------- 1) 20 ảnh + keyframe
(async () => {
    {
        const app = makeApp();
        const items = Array.from({ length: 20 }, (_, i) => ({
            path: `C:/clips/img_${i}.png`,
            keyframes: {
                position: [{ t: 0, x: -400, y: 0 }, { t: 2, x: 0, y: 50, e: 'ease-out' }],
                scale: [{ t: 0, v: 80, e: 'linear' }, { t: 2, v: 100 }],
            },
            animation: { combo: COMBO },
        }));
        items.push({ path: 'C:/clips/img_0.png', duration: 1 });   // trùng đường dẫn -> dùng lại asset
        const renders0 = app.renders();
        const res = await app.call('add_media_batch', { items, defaults: { duration: 3 }, start: 10, gap: 0.5 });
        assert.strictEqual(res.created, 21, 'phải tạo đủ 21 block');
        assert.strictEqual(app.state.editingAssets.length, 20, 'cùng đường dẫn phải dùng lại MỘT asset, không nhập hai lần');
        assert.strictEqual(app.sandbox.undoStack.length, 1, `cả lô phải là MỘT bước Hoàn tác (thấy ${app.sandbox.undoStack.length})`);
        assert.strictEqual(app.renders() - renders0, 1, `cả lô phải vẽ lại đúng MỘT lần (thấy ${app.renders() - renders0})`);
        const first = app.state.editingItems.find((it) => it.id === res.items[0].item_id);
        assert.strictEqual(first.timeline_start, 10);
        assert.strictEqual(first.duration, 3, 'defaults.duration phải áp cho mục');
        assert.strictEqual(res.items[1].timeline_start, 13.5, 'mục sau = đuôi mục trước + gap');
        assert.strictEqual(res.items[20].duration, 1, 'giá trị của mục thắng defaults');
        deepEq(first.keyframes.position_x.map((k) => [k.t, k.v, k.e]), [[0, -400, 'ease-in-out'], [2, 0, 'ease-out']]);
        deepEq(first.keyframes.position_y.map((k) => [k.t, k.v, k.e]), [[0, 0, 'ease-in-out'], [2, 50, 'ease-out']]);
        deepEq(first.keyframes.scale.map((k) => [k.t, k.v, k.e]), [[0, 80, 'linear'], [2, 100, 'ease-in-out']]);
        assert.ok(first.animation && first.animation.in, 'combo hoạt ảnh phải được gắn');
        assert.strictEqual(res.items[20].item_id && app.state.editingItems.find((it) => it.id === res.items[20].item_id).keyframes, undefined,
            'mục không khai keyframe thì không được dính keyframe của mục khác');
        ok('20 ảnh kèm keyframe + hoạt ảnh = 1 bước Hoàn tác, 1 lượt vẽ, đúng keyframe/easing/vị trí');

        app.sandbox.executeUndo();
        assert.strictEqual(app.state.editingItems.length, 0, 'một lần Ctrl+Z phải xoá sạch cả lô');
        assert.strictEqual(app.state.editingAssets.length, 0, '…kể cả asset vừa nhập (nhập + đặt block là một bước)');
        ok('một lần Hoàn tác gỡ sạch cả lô, kể cả phần nhập tệp');
    }

    // ------------------------------------------------------------ 2) lỗi giữa chừng
    for (const prefill of [0, 20]) {
        const app = makeApp({ undoPrefill: prefill });
        const topBefore = app.sandbox.undoStack[app.sandbox.undoStack.length - 1];
        await assert.rejects(
            app.call('add_media_batch', { items: [
                { path: 'C:/a.png' },
                { path: 'C:/b.png', keyframes: { skew: [{ t: 0, v: 1 }] } },
            ] }),
            /Mục 1: keyframes\.skew không hỗ trợ.*hoàn nguyên cả lô/,
        );
        assert.strictEqual(app.state.editingItems.length, 0, 'lỗi ở mục 1 phải gỡ cả block của mục 0');
        assert.strictEqual(app.state.editingAssets.length, 0, 'lỗi phải gỡ cả asset vừa nhập');
        assert.strictEqual(app.sandbox.undoStack.length, prefill, 'không được để lại bước Hoàn tác rỗng');
        assert.strictEqual(app.sandbox.undoStack[app.sandbox.undoStack.length - 1], topBefore, 'đỉnh chồng Hoàn tác phải về như cũ');
        assert.strictEqual(app.sandbox.EditingRuntime.automation.renderStats().suspended, 0, 'lỗi không được để kẹt cờ treo vẽ');
        assert.strictEqual(vm.runInContext('historySuspended', app.sandbox), 0, 'lỗi không được để kẹt cờ treo lịch sử');
    }
    ok('mục lỗi (on_error=abort) hoàn nguyên sạch cả lô — kể cả khi chồng Hoàn tác đã ĐẦY');

    {
        const app = makeApp();
        const res = await app.call('add_media_batch', {
            on_error: 'continue',
            items: [
                { path: 'C:/a.png' },
                { path: 'C:/missing.png' },
                { path: 'C:/b.png', keyframes: { opacity: [{ t: 99, v: 0 }] } },
                { path: 'C:/c.png', volume: 50 },
            ],
        });
        assert.strictEqual(res.created, 2);
        assert.match(res.items[1].error, /missing/);
        assert.match(res.items[2].error, /nằm ngoài block/);
        assert.strictEqual(app.state.editingItems.length, 2, 'mục lỗi không được để lại block dở');
        assert.strictEqual(app.sandbox.undoStack.length, 1);
        ok('on_error=continue: mục lỗi được quay lui riêng, các mục khác vẫn vào, vẫn 1 bước Hoàn tác');
    }

    {
        // Chuyển cảnh trong `defaults` áp cả cho mục CUỐI (không có block kề phải): bỏ qua + ghi
        // chú, không được làm hỏng cả lô (lỗi thấy khi chạy thật qua MCP 2026-10-17).
        const app = makeApp();
        const res = await app.call('add_media_batch', {
            start: 0,
            defaults: { duration: 2, transition: { type: 'fade', duration: 0.4 } },
            items: [{ path: 'C:/t1.png' }, { path: 'C:/t2.png' }, { path: 'C:/t3.png' }],
        });
        assert.strictEqual(res.created, 3);
        const tr = app.state.editingItems.map((it) => (it.transition ? it.transition.type : null));
        deepEq(tr, ['fade', 'fade', null], 'hai mục đầu có chuyển cảnh, mục cuối không');
        assert.match(res.items[2].transition_skipped, /no adjacent block/);
        ok('chuyển cảnh trong defaults: mục cuối được bỏ qua kèm ghi chú, lô vẫn thành công');
    }

    // ------------------------------------------------------------ 3) crabbycut_batch
    {
        const app = makeApp();
        const renders0 = app.renders();
        const res = await app.call('batch', { ops: [
            { tool: 'crabbycut_add_text', args: { text: 'Xin chào', start: 2, duration: 4 } },
            { tool: 'update_block', args: { item_id: '$0.item_id', keyframes: { opacity: [{ t: 2, v: 0 }, { t: 4, v: 100 }] }, keyframe_time: 'timeline' } },
            { tool: 'update_block', args: { item_id: '$0.item_id', keyframes: { position_x: [{ t: 1, v: 30 }] } } },
            { tool: 'set_animation', args: { item_id: '$0.item_id', combo: COMBO } },
        ] });
        assert.strictEqual(res.ok_count, 4);
        assert.strictEqual(app.sandbox.undoStack.length, 1, 'cả lô lệnh phải là MỘT bước Hoàn tác');
        assert.strictEqual(app.renders() - renders0, 1, 'cả lô lệnh phải vẽ lại đúng MỘT lần');
        const item = app.state.editingItems[0];
        deepEq(item.keyframes.opacity.map((k) => [k.t, k.v]), [[0, 0], [2, 100]],
            'keyframe_time "timeline" phải đổi sang giờ cục bộ (block bắt đầu ở 2 s)');
        deepEq(item.keyframes.position_y.map((k) => k.t), [1],
            'keyframe position_x đơn lẻ phải được ghép cặp sang position_y (pairPositionKeyframes)');
        ok('crabbycut_batch: tham chiếu "$0.item_id", keyframe theo giờ timeline, ghép cặp vị trí, 1 bước + 1 lượt vẽ');

        await app.call('update_block', { item_id: item.id, keyframes: { opacity: [] }, keyframe_mode: 'replace' });
        assert.strictEqual(item.keyframes.opacity, undefined, 'replace với mảng rỗng phải xoá keyframe field đó');
        ok('keyframe_mode replace + [] xoá keyframe');

        const depth = app.sandbox.undoStack.length;
        await assert.rejects(app.call('batch', { ops: [
            { tool: 'add_text', args: { text: 'A' } },
            { tool: 'crabbycut_screenshot', args: {} },
        ] }), /không chạy được trong batch/);
        await assert.rejects(app.call('batch', { ops: [
            { tool: 'add_text', args: { text: 'A' } },
            { tool: 'update_block', args: { item_id: '$5.item_id', transform: { scale: 50 } } },
        ] }), /Bước 1 \(update_block\): Tham chiếu "\$5\.item_id": bước 5 chưa chạy/);
        assert.strictEqual(app.sandbox.undoStack.length, depth, 'batch lỗi không được để lại bước Hoàn tác');
        assert.strictEqual(app.state.editingItems.length, 1, 'batch lỗi phải gỡ block chữ của bước 0');
        ok('batch từ chối tool ui/screenshot, tham chiếu sai báo rõ, lỗi = hoàn nguyên cả lô');
    }

    // ------------------------------------------------------------ 4) keyframe âm lượng + màu
    {
        const app = makeApp();
        const res = await app.call('add_media_batch', { items: [{
            path: 'C:/v.png',
            duration: 4,
            keyframes: { volume: [{ t: 0, v: 0 }, { t: 1, v: 100 }], 'basic.exposure': [{ t: 0, v: -20 }, { t: 3, v: 20 }] },
        }] });
        const item = app.state.editingItems.find((it) => it.id === res.items[0].item_id);
        deepEq(item.keyframes.volume.map((k) => k.v), [0, 100]);
        deepEq(item.keyframes['adj.basic.exposure'].map((k) => k.v), [-20, 20],
            'thông số màu phải lưu dưới khoá "adj.<path>" như nút ◆ của panel màu');
        assert.ok(item.adjustments, 'block có keyframe màu phải có adjustments chuẩn hoá');
        await assert.rejects(app.call('update_block', { item_id: item.id, keyframes: { 'basic.temperature_x': [{ t: 0, v: 1 }] } }), /không hỗ trợ/);
        await assert.rejects(app.call('update_block', { item_id: item.id, keyframes: { scale: [{ t: 0, v: 1, e: 'wobble' }] } }), /Easing "wobble"/);
        ok('keyframe âm lượng + màu ghi đúng khoá; field/easing lạ bị từ chối rõ ràng');
    }

    console.log('mcp_batch: OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
