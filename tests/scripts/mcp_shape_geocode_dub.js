/* =====================================================================
 * MCP: LỆNH SHAPE / GEOCODE / LỒNG TIẾNG — ít lượt gọi, kết quả gọn (giảm token của model).
 *
 * A. Cầu nối renderer (static/js/automation-bridge.js THẬT trong vm; shape dựng bằng
 *    addShapeItemWithStyle + normalizeShapeStyle bóc thẳng từ editing-runtime.js):
 *    - add_shape: một hình / cả lô = MỘT bước Hoàn tác, style chuẩn hoá, nối tiếp theo gap,
 *      path thiếu đỉnh bị từ chối, chạy được trong batch;
 *    - GeoCode lô: template {{vars}} điền đúng, thiếu biến báo lỗi, đặt cả lô MỘT bước Hoàn tác,
 *      log info không gửi về; update_geocode vá find/replace trên mã đã lưu, giữ biến đổi, read;
 *    - dub: văn bản -> câu, gửi đúng body cho /api/dubbing/jobs, đặt audio + phụ đề MỘT bước
 *      Hoàn tác, trả mốc từng câu (cộng start).
 * B. MCP server THẬT (stdio) với app giả qua HTTP: tool mới có trong tools/list, crabbycut_add_geocode
 *    / crabbycut_dub TỰ CHỜ job trong server (một lượt gọi, không cần crabbycut_job_status), hết hạn chờ
 *    thì trả job_id; update_geocode chỉ đọc thì không tạo job.
 *
 * Chạy: npm run test:mcp-shape-geocode-dub
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const runtimeJs = fs.readFileSync(path.join(ROOT, 'static', 'js', 'editing-runtime.js'), 'utf8');
const bridgeJs = fs.readFileSync(path.join(ROOT, 'static', 'js', 'automation-bridge.js'), 'utf8');
const textDeformJs = fs.readFileSync(path.join(ROOT, 'static', 'js', 'text-deform.js'), 'utf8');
const distortJs = fs.readFileSync(path.join(ROOT, 'static', 'js', 'distort.js'), 'utf8');
const nestJs = fs.readFileSync(path.join(ROOT, 'static', 'js', 'nest-sequence.js'), 'utf8');
const TextAnimations = require(path.join(ROOT, 'static', 'js', 'text-animations.js'));
const ColorAdjust = require(path.join(ROOT, 'static', 'js', 'color-adjust.js'));

const ok = (msg) => console.log(`  ok  ${msg}`);
const plain = (v) => JSON.parse(JSON.stringify(v));

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `không tìm thấy hàm ${name}()`);
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

function makeApp() {
    const fetchLog = [];
    const sandbox = {
        console, TextAnimations, ColorAdjust, setTimeout, clearTimeout, setInterval, clearInterval,
        navigator: { platform: 'MacIntel' },
        currentMode: 'FINAL', currentStepId: 'step4', latestTimeline: [], undoStack: [], redoStack: [],
        playheadTime: 2, API_BASE: '/api', _t: (s) => s, fetchLog,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`
        function captureFullState() { return JSON.parse(JSON.stringify({ items: rtState.editingItems })); }
        function saveHistoryState() { undoStack.push(captureFullState()); redoStack = []; }
        function restoreHistoryState(state) { rtState.editingItems.splice(0, Infinity, ...JSON.parse(JSON.stringify(state.items))); }
        function updateUndoRedoButtons() {}
        function getCurrentTimelineTime() { return playheadTime; }
        function clipSequenceDuration(clip) { return Number(clip.end) - Number(clip.start); }
        function clampTransformValue(field, value) { return Number(value); }
        var rtState = { editingItems: [], editingAssets: [], editingTracks: [{ id: 'track_shape_1', type: 'shape' }, { id: 'track_text_1', type: 'text' }] };
        var editingItems = rtState.editingItems;
        var idSeq = 0;
        let historySuspended = 0;
        let renderSuspendDepth = 0;
        const renderDirty = { all: false, panel: false };
        let renderAllRuns = 0;
        const KF_EPS = 0.02;
        const MAX_POLYGON_SIDES = 64;
        const MAX_STAR_POINTS = 32;
        const MAX_PATH_POINTS = 500;
        function clamp(value, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min; }
        ${extractFunction(runtimeJs, 'recordHistory')}
        ${extractFunction(runtimeJs, 'beginHistoryBatch')}
        ${extractFunction(runtimeJs, 'suspendHistory')}
        ${extractFunction(runtimeJs, 'renderGated')}
        ${extractFunction(runtimeJs, 'suspendRender')}
        ${extractFunction(runtimeJs, 'upsertKeyframe')}
        ${extractFunction(runtimeJs, 'defaultShapeStyle')}
        ${extractFunction(runtimeJs, 'normalizeShapeStyle')}
        ${extractFunction(runtimeJs, 'normalizePathPoints')}
        ${extractFunction(runtimeJs, 'addShapeItemWithStyle')}
        function renderAll() { if (renderGated('all')) return; renderAllRuns += 1; }
        function renderEditPanel() { if (renderGated('panel')) return; }
        function renderPreviewOverlays() {}
        function nextId(prefix) { return prefix + '_' + (++idSeq); }
        function defaultTransform() { return { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100, flip_x: false, flip_y: false }; }
        function findItem(id) { return rtState.editingItems.find((it) => it.id === id) || null; }
        function selectEditingItem() {}
        function selectItem(id) { renderAll(); }
        // Bản giả của chọn track: track Hình khối duy nhất, start/duration như bản thật.
        function resolveNewItemPlacement(type, want, placement) {
            const start = placement && Number.isFinite(Number(placement.start)) ? Number(placement.start) : playheadTime;
            return { start: Math.max(0, start), duration: Math.max(0.2, Number(want) || 1), track: { id: (placement && placement.trackId) || 'track_shape_1' } };
        }
        function addGeocodeItem(geocode, placement) {
            const p = resolveNewItemPlacement('geocode', (placement && placement.duration) || geocode.duration || 5, placement);
            recordHistory();
            const item = { id: nextId('item'), type: 'geocode', track_id: p.track.id, timeline_start: p.start, duration: p.duration, transform: defaultTransform(), geocode: { ...geocode } };
            rtState.editingItems.push(item);
            renderAll();
            return item;
        }
        function updateGeocodeItem(id, geocode) {
            const item = findItem(id);
            recordHistory();
            item.geocode = { ...geocode };
            renderAll();
            return item;
        }
        var subtitleImports = [];
        var dubbingBlocks = [];
        function addTextItem(placement, options) {
            recordHistory();
            const p = resolveNewItemPlacement('text', options.duration || 5, placement);
            const item = { id: nextId('item_text'), type: 'text', track_id: 'track_text_1', timeline_start: p.start, duration: p.duration,
                text: options.text, transform: defaultTransform(), style: { font_size: 56, ...(options.style || {}) } };
            rtState.editingItems.push(item);
            renderAll();
            return item;
        }
        function addPathTextItem(opts) {
            const pathStyle = opts.preset ? TextDeform.presetStyle(opts.preset)
                : { path_enabled: true, path_points: opts.points, path_closed: !!opts.closed, path_w: opts.w, path_h: opts.h };
            if (!TextDeform.normalizePath(pathStyle)) return null;
            const item = addTextItem(opts.placement, { text: opts.text, duration: opts.duration, style: { ...(opts.style || {}), ...pathStyle } });
            item.transform.position_x = opts.center[0];
            item.transform.position_y = opts.center[1];
            return item;
        }
        function patchTextStyle(item, patch) { item.style = { ...item.style, ...patch }; }
        var EditingRuntime = {
            addTextItem,
            beginHistoryBatch, renderAll, renderEditingTimeline: renderAll, renderPreviewOverlays, selectItem,
            getState: () => rtState,
            timelineDuration: () => 60,
            async addDubbingAudio(entries, options) {
                const end = beginHistoryBatch();
                entries.forEach((e) => { rtState.editingItems.push({ id: nextId('item_audio'), type: 'audio', track_id: 'track_dub', timeline_start: e.start, duration: e.duration, dubbing_source: options.sourceKey }); });
                end();
                renderAll();
                return { placed: entries.length, skipped: 0, clamped: 0, removed: 0 };
            },
            automation: {
                findItem, findTrack: (id) => ({ id }), isTrackLocked: () => false, clampItemTiming: () => {}, itemSourceDurationLimit: () => Infinity,
                itemSupportsAnimation: () => true,
                applyTransformToSelected: () => {},
                normalizeVolumePercent: (v) => Number(v),
                mainClipSequenceSpans: () => [],
                suspendRender, suspendHistory, upsertKeyframe,
                addGeocodeItem, updateGeocodeItem, addShapeItemWithStyle, normalizeShapeStyle,
                addPathTextItem, patchTextStyle,
                renderStats: () => ({ renderAll: renderAllRuns, suspended: renderSuspendDepth }),
            },
        };
        var GeoCode = {
            available: () => true,
            presetSize: () => null,
            builds: [],
            async buildGeocode(spec, opts) {
                this.builds.push(spec);
                opts.onLog({ level: 'info', message: 'frame 1/30' });
                opts.onLog({ level: 'info', message: 'frame 2/30' });
                if (/WARN/.test(spec.code)) opts.onLog({ level: 'warn', message: 'font fallback' });
                return { ...spec, loop: opts.loop !== false, render_key: 'k' + this.builds.length, frame_count: spec.kind === 'video' ? 30 : 1 };
            },
        };
        var DubbingPanel = {
            state: { engine: 'vieneu3', voice: 'Hải Đăng' },
            splitSentences: (text) => String(text).split(/(?<=[.!?])\\s+/).map((s) => s.trim()).filter(Boolean),
            subtitleCuesFromClips: (clips, offset) => clips.map((c) => ({ start: c.start + offset, end: c.start + offset + c.duration, text: c.text })),
        };
        var LocalSubtitlePanel = {
            importCues(cues, opts) { recordHistory(); subtitleImports.push({ cues, opts }); return { count: cues.length }; },
        };
        var desktopEnv = { onAutomationCall(fn) { this.handler = fn; }, setAutomationEnabled: async () => ({ enabled: true }) };
    `, sandbox);
    // fetch giả: server lồng tiếng.
    sandbox.fetch = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        fetchLog.push({ url, method: init.method || 'GET', body });
        const reply = (data) => ({ ok: true, status: 200, json: async () => data });
        if (url === '/api/tts/status') return reply({ env: { ready: true }, engines: [{ id: 'vieneu3', label: 'VieNeu v3', available: true, voices: ['Hải Đăng', 'Ngọc'] }] });
        if (url === '/api/voice-profiles') return reply({ profiles: [{ id: 'p1', name: 'Giọng tôi', path: '/x' }] });
        if (url === '/api/dubbing/jobs') return reply({ job_id: 'remote1', state: 'queued' });
        if (url === '/api/dubbing/jobs/remote1') {
            const cues = fetchLog.find((f) => f.url === '/api/dubbing/jobs').body.cues;
            let at = 0.1;
            const clips = cues.map((c) => { const clip = { start: at, duration: 1.5, text: c.text, path: `/tmp/c${at}.wav` }; at += 2; return clip; });
            return reply({ state: 'done', result: { full: { path: '/tmp/full.wav', start: 0.1, duration: at - 0.5 }, clips, summary: { count: clips.length } } });
        }
        return { ok: false, status: 404, json: async () => ({ detail: `no route ${url}` }) };
    };
    vm.runInContext(textDeformJs, sandbox, { filename: 'text-deform.js' });
    vm.runInContext(distortJs, sandbox, { filename: 'distort.js' });
    vm.runInContext(bridgeJs, sandbox, { filename: 'automation-bridge.js' });
    const call = (method, params) => sandbox.desktopEnv.handler(method, params);
    const waitJob = async (job) => {
        for (let i = 0; i < 100; i += 1) {
            const j = await call('job_status', { job_id: job.id });
            if (j.state !== 'running') return j;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('job không xong');
    };
    return { sandbox, call, waitJob, state: sandbox.rtState };
}

/* App giả có Subsequence: NestSequence THẬT (nhận diện tài sản), các hàm runtime giả lập đúng
 * hợp đồng của editing-runtime.js (tự ghi lịch sử, báo lỗi bằng toast/dòng trạng thái, hỏi bằng
 * window.confirm / window.prompt, vào/ra hoán đổi kho đang sửa). */
function makeNestApp() {
    const app = makeApp();
    const sb = app.sandbox;
    sb.toasts = [];
    sb.statusEl = { textContent: '' };
    sb.document = { getElementById: (id) => (id === 'statusText' ? sb.statusEl : null) };
    sb.showToast = (msg) => { sb.toasts.push(String(msg)); };
    vm.runInContext(nestJs, sb, { filename: 'nest-sequence.js' });
    vm.runInContext(`
        var nestStack = [];
        // Sửa kho TẠI CHỖ: hàm bóc từ runtime (addShapeItemWithStyle) giữ tham chiếu mảng editingItems.
        function setItems(list) { rtState.editingItems.splice(0, Infinity, ...list); }
        rtState.selectedEditingItemId = '';
        rtState.selectedEditingItemIds = [];
        EditingRuntime.automation.findAsset = (id) => rtState.editingAssets.find((a) => a.id === id) || null;
        function nestAssetOf(item) { const a = item && EditingRuntime.automation.findAsset(item.asset_id); return NestSequence.isNestAsset(a) ? a : null; }
        function makeNest(name, items) {
            const asset = { id: nextId('nest'), type: 'media_video', item_type: 'media', source: 'nest', name, duration: 4, url: '', path: '', nest: { tracks: [], items } };
            rtState.editingAssets.push(asset);
            return asset;
        }
        function instance(asset, start) {
            const it = { id: nextId('item'), type: 'media', track_id: 'track_media_1', timeline_start: start, duration: asset.duration, asset_id: asset.id, transform: defaultTransform() };
            rtState.editingItems.push(it);
            return it;
        }
        Object.assign(EditingRuntime, {
            createNestFromSelection(opts) {
                const items = (opts.itemIds || []).map((id) => findItem(id)).filter(Boolean);
                if ((opts.mainIndexes || []).length) { showToast('Chỉ gói được các clip lane chính NẰM LIỀN NHAU.', { type: 'warning' }); return Promise.resolve(false); }
                if (window.slowCreate) return new Promise((resolve) => setTimeout(() => { window.slowCreate = false; resolve(EditingRuntime.createNestFromSelection(opts)); }, 40));
                if (!items.length) { statusText.textContent = 'Chọn ít nhất một block để tạo Subsequence.'; return false; }
                recordHistory();
                const asset = makeNest('Subsequence ' + (rtState.editingAssets.length + 1), JSON.parse(JSON.stringify(items)));
                setItems(rtState.editingItems.filter((it) => !items.includes(it)));
                const it = instance(asset, Math.min(...items.map((x) => x.timeline_start)));
                rtState.selectedEditingItemId = it.id;
                renderAll();
                return true;
            },
            enterNest(id) {
                const item = findItem(id); const asset = nestAssetOf(item);
                if (!asset || nestStack.some((f) => f.assetId === asset.id)) return false;
                nestStack.push({ assetId: asset.id, instanceItemId: id, parentItems: rtState.editingItems.slice() });
                setItems(JSON.parse(JSON.stringify(asset.nest.items)));
                return true;
            },
            enterNestFromMainRow() { return false; },
            exitNest(levels = 1) {
                for (let n = 0; n < levels && nestStack.length; n += 1) {
                    const f = nestStack.pop();
                    EditingRuntime.automation.findAsset(f.assetId).nest.items = rtState.editingItems.slice();
                    setItems(f.parentItems);
                }
                return true;
            },
            exitAllNests() { return nestStack.length ? EditingRuntime.exitNest(nestStack.length) : false; },
            isInsideNest: () => nestStack.length > 0,
            nestPath: () => nestStack.map((f) => ({ assetId: f.assetId, instanceItemId: f.instanceItemId })),
            rootLatestTimeline: () => latestTimeline,
            projectItemsDeep: () => [...rtState.editingItems, ...rtState.editingAssets.flatMap((a) => (a.nest ? a.nest.items : []))],
            unnestItem(id) {
                const item = findItem(id); const asset = nestAssetOf(item);
                if (!asset) return false;
                if (item.transform.scale !== 100 && !window.confirm('Biến đổi... sẽ mất khi bung ra. Tiếp tục?')) return false;
                recordHistory();
                setItems(rtState.editingItems.filter((x) => x !== item));
                const placed = asset.nest.items.map((c) => ({ ...JSON.parse(JSON.stringify(c)), id: nextId('item') }));
                rtState.editingItems.push(...placed);
                rtState.selectedEditingItemIds = placed.map((x) => x.id);
                return true;
            },
            duplicateNestItem(id, independent) {
                const item = findItem(id); let asset = nestAssetOf(item);
                if (!asset) return false;
                recordHistory();
                if (independent) asset = makeNest('Subsequence copy', JSON.parse(JSON.stringify(asset.nest.items)));
                const copy = instance(asset, item.timeline_start + item.duration);
                rtState.selectedEditingItemId = copy.id;
                return true;
            },
            makeNestItemUnique(id) {
                const item = findItem(id); const asset = nestAssetOf(item);
                if (!asset) return false;
                recordHistory();
                item.asset_id = makeNest(asset.name + ' 2', JSON.parse(JSON.stringify(asset.nest.items))).id;
                return true;
            },
            renameNestAsset(asset) {
                const next = window.prompt('Tên Subsequence', asset.name);
                if (next === null || !String(next).trim()) return false;
                recordHistory();
                asset.name = String(next).trim().slice(0, 60);
                return true;
            },
        });
        var statusText = window.statusEl;
    `, sb);
    return app;
}

async function partA() {
    // ---- Shape
    {
        const app = makeApp();
        const one = await app.call('add_shape', { shape_type: 'star', points: 7, fill_color: '#ff0000', start: 1, duration: 3, transform: { position_x: 100 }, animation: { in: { type: 'fade', duration: 0.5 } } });
        assert.ok(one.item_id && one.timeline_start === 1 && one.duration === 3, `một hình: ${JSON.stringify(one)}`);
        const star = app.state.editingItems[0];
        assert.strictEqual(star.style.shape_type, 'star');
        assert.strictEqual(star.style.points, 7);
        assert.strictEqual(star.style.width, 360, 'sao mặc định vuông 360×360 như nút bấm');
        assert.strictEqual(star.style.fill_color, '#ff0000');
        assert.strictEqual(app.sandbox.undoStack.length, 1, 'một hình = một bước Hoàn tác');

        const many = await app.call('add_shape', {
            start: 10, gap: 0.5, defaults: { shape_type: 'circle', width: 120, height: 120, duration: 2 },
            items: [{ fill_color: '#00ff00' }, { shape_type: 'rectangle', corner_radius: 40 }, { start: 30, shape_type: 'polygon', sides: 8 }],
        });
        assert.strictEqual(many.created, 3);
        assert.deepStrictEqual(plain(many.items.map((r) => r.timeline_start)), [10, 12.5, 30], 'nối tiếp theo gap, start riêng thắng');
        assert.strictEqual(app.sandbox.undoStack.length, 2, 'cả lô = MỘT bước Hoàn tác');
        const rect = app.state.editingItems.find((it) => it.style.shape_type === 'rectangle');
        assert.strictEqual(rect.style.width, 120, 'defaults áp cho từng mục');
        assert.strictEqual(rect.style.corner_radius, 40);
        await assert.rejects(app.call('add_shape', { shape_type: 'path', path_points: [{ x: 0, y: 0 }] }), /path_points/);
        await assert.rejects(app.call('add_shape', { shape_type: 'heart' }), /shape_type/);
        const batch = await app.call('batch', { ops: [{ tool: 'crabbycut_add_shape', args: { shape_type: 'line', start: 40 } }, { tool: 'update_block', args: { item_id: '$0.item_id', duration: 4 } }] });
        assert.strictEqual(batch.ok_count, 2, 'add_shape chạy được trong batch + tham chiếu $0.item_id');
        const shapes = await app.call('catalog', { kind: 'shapes' });
        assert.ok(shapes.shape_types.includes('path'));
        ok('add_shape: một hình / cả lô một bước Hoàn tác, style chuẩn hoá, nối theo gap, chạy trong batch');
    }

    // ---- Chữ: style + warp + path trong MỘT lượt gọi
    {
        const app = makeApp();
        const t = await app.call('add_text', { text: 'Xin chào', start: 2, style: { color: '#ff0000' }, warp: { type: 'arc', bend: 40 }, transform: { position_x: 120 } });
        const item = app.state.editingItems[0];
        assert.ok(t.item_id === item.id, JSON.stringify(t));
        assert.strictEqual(item.style.warp_type, 'arc');
        assert.strictEqual(item.style.warp_bend, 40);
        assert.strictEqual(item.style.color, '#ff0000');
        assert.strictEqual(app.sandbox.undoStack.length, 1, 'chữ + kiểu + warp + biến đổi = MỘT bước Hoàn tác');
        const p = await app.call('add_text', { text: 'Quanh vòng', path: { preset: 'circle', x: 10, y: -20, offset: 25, flip: true, width: 600 } });
        const pi = app.state.editingItems.find((i) => i.id === p.item_id);
        assert.strictEqual(pi.style.path_enabled, true);
        assert.deepStrictEqual([pi.style.path_offset, pi.style.path_flip, pi.style.path_w], [25, true, 600], 'tuỳ chọn đường + cỡ box ghi đúng');
        assert.deepStrictEqual([pi.transform.position_x, pi.transform.position_y], [10, -20], 'tâm box đường');
        await assert.rejects(app.call('add_text', { text: 'x', warp: { type: 'heart' } }), /warp.type/);
        await assert.rejects(app.call('add_text', { text: 'x', path: { preset: 'zigzag' } }), /path.preset/);
        await assert.rejects(app.call('add_text', { text: 'x', path: { points: [{ x: 0, y: 0 }] } }), /preset hoặc points/);
        const plainText = await app.call('add_text', { text: 'Thường' });
        assert.ok(plainText.item_id, 'add_text không tham số mới vẫn như cũ');
        const cat = await app.call('catalog', { kind: 'text_warps' });
        assert.ok(cat.warp_types.includes('twist') && cat.path_presets.some((x) => x.id === 'wave'));
        ok('add_text: style + warp + path + biến đổi trong một lượt gọi / một bước Hoàn tác; giá trị lạ bị từ chối; catalog text_warps');
    }

    // ---- GeoCode
    {
        const app = makeApp();
        const G = app.sandbox.GeoCode;
        const single = await app.call('add_geocode', { lang: 'html', code: '<b>hi</b>', width: 400, height: 200, start: 3 });
        assert.deepStrictEqual(plain(single.logs), [], 'dựng xong không lỗi: không gửi log info về model');
        const job = await app.call('start_job', {
            kind: 'geocode',
            options: {
                template: '<style>.box{color:{{color}}}</style><div class="box">{{title}}</div>',
                defaults: { lang: 'html', width: 1080, height: 1920, kind: 'video', duration: 2, fps: 30, animation: { in: { type: 'fade', duration: 0.3 } } },
                start: 0, gap: 0,
                items: [{ vars: { color: 'red', title: 'Một' } }, { vars: { color: 'blue', title: 'Hai' }, block_duration: 3 }, { code: '<i>WARN</i>' }],
            },
        });
        const done = await app.waitJob(job);
        assert.strictEqual(done.state, 'complete', JSON.stringify(done));
        assert.strictEqual(G.builds[1].code, '<style>.box{color:red}</style><div class="box">Một</div>', 'template điền đúng vars');
        assert.strictEqual(G.builds[3].code, '<i>WARN</i>', 'mục có code riêng dùng code đó');
        assert.deepStrictEqual(plain(done.result.items.map((r) => [r.timeline_start, r.duration])), [[0, 2], [2, 3], [5, 2]], 'nối tiếp nhau');
        assert.deepStrictEqual(plain(done.result.items[2].logs), ['warn: font fallback'], 'chỉ cảnh báo được gửi về');
        assert.ok(!('logs' in done.result.items[0]), 'mục không cảnh báo: không có trường logs');
        const undoBefore = app.sandbox.undoStack.length;
        assert.strictEqual(undoBefore, 2, 'lẻ + cả lô = 2 bước Hoàn tác');
        const bad = await app.call('start_job', { kind: 'geocode', options: { template: '{{a}}{{b}}', defaults: { lang: 'html', width: 100, height: 100 }, items: [{ vars: { a: 1 } }] } }).catch((e) => e);
        assert.ok(/thiếu vars cho \{\{b\}\}/.test(String(bad && bad.message)), `thiếu biến phải báo lỗi: ${bad && bad.message}`);

        const target = done.result.items[0].item_id;
        app.state.editingItems.find((it) => it.id === target).transform.position_x = 77;
        const upd = await app.waitJob(await app.call('start_job', { kind: 'geocode_update', options: { item_id: target, replace: [{ find: 'color:red', with: 'color:gold' }] } }));
        assert.strictEqual(upd.state, 'complete', JSON.stringify(upd));
        const after = app.state.editingItems.find((it) => it.id === target);
        assert.ok(after.geocode.code.includes('color:gold') && !after.geocode.code.includes('color:red'), 'vá find/replace trên mã đã lưu');
        assert.strictEqual(after.transform.position_x, 77, 'giữ biến đổi của block');
        assert.strictEqual(app.sandbox.undoStack.length, undoBefore + 1, 'sửa = một bước Hoàn tác');
        const notFound = await app.waitJob(await app.call('start_job', { kind: 'geocode_update', options: { item_id: target, replace: [{ find: 'nope', with: 'x' }] } }));
        assert.ok(notFound.state === 'failed' && /không thấy/.test(notFound.error), 'find không có trong mã phải báo lỗi');
        const read = await app.call('update_geocode', { item_id: target, read: true });
        assert.ok(read.geocode.code.includes('color:gold') && read.geocode.width === 1080, 'read trả mã + đặc tả hiện tại');
        assert.strictEqual(G.builds.length, 5, 'read không dựng lại');
        ok('GeoCode: lô dùng template {{vars}}, một bước Hoàn tác, log gọn; update_geocode vá find/replace, giữ biến đổi, read không dựng lại');
    }

    // ---- Biến dạng (Distort) qua update_block + catalog
    {
        const app = makeApp();
        const D = app.sandbox.Distort;
        const sh = await app.call('add_shape', { shape_type: 'rectangle', start: 0, duration: 4 });
        const item = () => app.state.editingItems.find((it) => it.id === sh.item_id);
        const undo0 = app.sandbox.undoStack.length;
        const r = await app.call('update_block', {
            item_id: sh.item_id,
            distort: [
                { id: 'w', type: 'wave', params: { wave_type: 'square', height: 25, width: 9999 } },
                { type: 'bezier', params: { tl_vertex: [0.1, 0.05] } },
            ],
            keyframes: {
                'dst.w.height': [{ t: 0, v: 0 }, { t: 2, v: 40, e: 'linear' }],
                'dst.w.wave_type': [{ t: 0, v: 'sine' }, { t: 1, v: 'triangle' }],
                'dst.d1.br_vertex': [{ t: 0, x: 1, y: 1 }, { t: 3, v: [0.8, 0.9] }],
            },
        });
        assert.strictEqual(app.sandbox.undoStack.length, undo0 + 1, 'distort + keyframes = MỘT bước Hoàn tác');
        const st = item().distort;
        assert.deepStrictEqual(plain(st.map((f) => [f.id, f.type, f.enabled])), [['w', 'wave', true], ['d1', 'bezier', true]], 'thứ tự giữ, id tự cấp d1');
        assert.strictEqual(st[0].params.wave_type, 'square');
        assert.strictEqual(st[0].params.width, 4000, 'số vượt dải bị kẹp');
        assert.strictEqual(st[0].params.speed, 1, 'thông số không nêu = mặc định');
        assert.deepStrictEqual(plain(st[1].params.tl_vertex), [0.1, 0.05]);
        const kf = item().keyframes;
        assert.deepStrictEqual(plain(kf['dst.w.height'].map((k) => [k.t, k.v, k.e])), [[0, 0, 'ease-in-out'], [2, 40, 'linear']]);
        assert.deepStrictEqual(plain(kf['dst.d1.br_vertex'].map((k) => k.v)), [[1, 1], [0.8, 0.9]], 'vec2 nhận x/y hoặc v [x, y]');
        assert.strictEqual(D.effectParamsAt(item(), D.normalizeStack(item().distort)[0], 1).height, 20, 'keyframe nội suy được bằng distort.js');
        assert.strictEqual(D.effectParamsAt(item(), D.normalizeStack(item().distort)[0], 0.5).wave_type, 'sine', 'enum giữ (hold)');
        assert.ok(r.changed.includes('distort') && r.distort.length === 2 && r.distort[0].keyframes.includes('dst.w.height'), `kết quả tóm tắt distort: ${JSON.stringify(r.distort)}`);

        // Gộp theo id: chỉ ghi đè params được nêu, giữ keyframe; hiệu ứng bị bỏ thì keyframe đi theo.
        await app.call('update_block', { item_id: sh.item_id, distort: [{ id: 'w', enabled: false, params: { phase: 90 } }, { type: 'mesh', params: { rows: 2, cols: 3 } }] });
        const st2 = item().distort;
        assert.deepStrictEqual(plain(st2.map((f) => [f.id, f.type, f.enabled])), [['w', 'wave', false], ['d2', 'mesh', true]], 'id cũ d1 không bị dùng lại');
        assert.deepStrictEqual([st2[0].params.wave_type, st2[0].params.height, st2[0].params.phase], ['square', 25, 90], 'giữ thông số cũ, ghi đè phase');
        assert.ok(item().keyframes['dst.w.height'], 'giữ keyframe của hiệu ứng còn lại');
        assert.ok(!item().keyframes['dst.d1.br_vertex'], 'bỏ bezier -> keyframe của nó bị xoá');

        // Mesh: lưới sai cỡ là lỗi; đổi rows/cols đặt lại lưới + keyframe lưới.
        const len = D.meshLength(2, 3);
        await assert.rejects(app.call('update_block', { item_id: sh.item_id, distort: [{ id: 'w' }, { id: 'd2', params: { mesh: [1, 2, 3] } }] }), new RegExp(`${len} số`));
        const mesh = D.meshIdentity(2, 3);
        mesh[0] = 0.2;
        await app.call('update_block', { item_id: sh.item_id, distort: [{ id: 'w' }, { id: 'd2', params: { mesh } }], keyframes: { 'dst.d2.mesh': [{ t: 0, v: mesh }, { t: 2, v: D.meshIdentity(2, 3) }] } });
        assert.strictEqual(item().distort[1].params.mesh[0], 0.2);
        await app.call('update_block', { item_id: sh.item_id, distort: [{ id: 'w' }, { id: 'd2', params: { rows: 4 } }] });
        assert.strictEqual(item().distort[1].params.mesh, null, 'đổi rows -> lưới về đều');
        assert.ok(!item().keyframes['dst.d2.mesh'], 'đổi rows -> bỏ keyframe lưới');

        // Puppet: ghim + keyframe vị trí ghim; bỏ ghim thì keyframe ghim đi theo.
        await app.call('update_block', {
            item_id: sh.item_id,
            distort: [{ id: 'p', type: 'puppet', params: { pins: [{ id: 'a', rest: [0.5, 0.2] }, { id: 'b', rest: [0.5, 0.8], pos: [0.6, 0.9] }] } }],
            keyframes: { 'dst.p.pin_a': [{ t: 0, v: [0.5, 0.2] }, { t: 1, v: [0.3, 0.1] }] },
        });
        assert.deepStrictEqual(plain(item().distort.map((f) => f.id)), ['p'], 'danh sách mới thay trọn danh sách cũ');
        assert.ok(!Object.keys(item().keyframes).some((k) => k.startsWith('dst.w.')), 'bỏ wave -> keyframe wave bị xoá');
        assert.deepStrictEqual(plain(item().distort[0].params.pins[0].pos), [0.5, 0.2], 'pos mặc định = rest');
        await app.call('update_block', { item_id: sh.item_id, distort: [{ id: 'p', params: { pins: [{ id: 'b', rest: [0.5, 0.8] }] } }] });
        assert.ok(!item().keyframes['dst.p.pin_a'], 'bỏ ghim a -> keyframe ghim a bị xoá');

        // Lỗi rõ ràng, không để lại thay đổi dở và không thêm bước Hoàn tác.
        const before = JSON.stringify(item());
        const undoN = app.sandbox.undoStack.length;
        await assert.rejects(app.call('update_block', { item_id: sh.item_id, distort: [{ type: 'twirl' }] }), /wave, bezier, mesh, liquify, puppet|type là một trong/);
        await assert.rejects(app.call('update_block', { item_id: sh.item_id, distort: [{ type: 'wave', params: { wave_type: 'zigzag' } }] }), /wave_type là một trong/);
        await assert.rejects(app.call('update_block', { item_id: sh.item_id, distort: [{ type: 'wave', params: { amplitude: 3 } }] }), /amplitude không có ở wave/);
        await assert.rejects(app.call('update_block', { item_id: sh.item_id, distort: [{ id: 'p', type: 'wave' }] }), /không đổi loại/);
        await assert.rejects(app.call('update_block', { item_id: sh.item_id, keyframes: { 'dst.p.triangles': [{ t: 0, v: 100 }] } }), /không keyframe được/);
        await assert.rejects(app.call('update_block', { item_id: sh.item_id, keyframes: { 'dst.zz.height': [{ t: 0, v: 1 }] } }), /không có hiệu ứng "zz"/);
        await assert.rejects(app.call('update_block', { item_id: sh.item_id, distort: [], keyframes: { 'dst.p.pin_b': [{ t: 0, v: [0, 0] }] } }), /không có hiệu ứng "p"/);
        assert.strictEqual(JSON.stringify(item()), before, 'lệnh lỗi quay lui trọn vẹn');
        assert.strictEqual(app.sandbox.undoStack.length, undoN, 'lệnh lỗi không để lại bước Hoàn tác');

        await app.call('update_block', { item_id: sh.item_id, distort: [] });
        assert.ok(!('distort' in item()) && !Object.keys(item().keyframes || {}).some((k) => k.startsWith('dst.')), '[] bỏ hết hiệu ứng + keyframe');
        const txt = await app.call('add_text', { text: 'x' });
        await assert.rejects(app.call('update_block', { item_id: txt.item_id, distort: [{ type: 'wave' }] }), /chỉ cho block ảnh\/video/);

        // Trong batch: thêm shape + distort cùng MỘT bước Hoàn tác.
        const undoB = app.sandbox.undoStack.length;
        const b = await app.call('batch', { ops: [{ tool: 'add_shape', args: { shape_type: 'circle', start: 5 } }, { tool: 'update_block', args: { item_id: '$0.item_id', distort: [{ id: 'lq', type: 'liquify', params: { percent: 150 } }], keyframes: { 'dst.lq.offset': [{ t: 0, v: [0, 0] }, { t: 1, v: [0.1, 0] }] } } }] });
        assert.strictEqual(b.ok_count, 2, JSON.stringify(b));
        assert.strictEqual(app.sandbox.undoStack.length, undoB + 1, 'batch = MỘT bước Hoàn tác');

        const cat = await app.call('catalog', { kind: 'distort' });
        assert.deepStrictEqual(Object.keys(cat.effects).sort(), ['bezier', 'liquify', 'mesh', 'puppet', 'wave']);
        const wt = cat.effects.wave.params.find((p) => p.key === 'wave_type');
        assert.ok(wt.options.includes('smooth_noise') && wt.keyframable && wt.default === 'sine');
        const h = cat.effects.wave.params.find((p) => p.key === 'height');
        assert.deepStrictEqual([h.min, h.max, h.default], [-2000, 2000, 10]);
        assert.strictEqual(cat.effects.mesh.params.find((p) => p.key === 'rows').keyframable, false);
        assert.strictEqual(cat.max_effects, 8);
        ok('distort: update_block ghi danh sách + keyframe dst.* một bước Hoàn tác, gộp theo id, dọn keyframe, lỗi rõ ràng không để dở; chạy trong batch; catalog distort');
    }

    // ---- Subsequence (Nest)
    {
        const app = makeNestApp();
        const sb = app.sandbox;
        const st = () => app.state;
        const a = await app.call('add_shape', { shape_type: 'circle', start: 1, duration: 2 });
        const b = await app.call('add_shape', { shape_type: 'square', start: 2, duration: 2 });
        const nativeConfirm = sb.confirm;
        const u0 = sb.undoStack.length;
        const c = await app.call('subsequence', { action: 'create', item_ids: [a.item_id, b.item_id], name: 'Intro' });
        assert.strictEqual(sb.undoStack.length, u0 + 1, 'tạo + đặt tên = MỘT bước Hoàn tác');
        assert.ok(c.item_id && c.subsequence.name === 'Intro' && c.subsequence.instances === 1, JSON.stringify(c));
        assert.strictEqual(sb.confirm, nativeConfirm, 'trả lại window.confirm/prompt sau lệnh');
        const tl = await app.call('get_timeline', {});
        const blk = tl.items.find((it) => it.id === c.item_id);
        assert.deepStrictEqual(plain(blk.subsequence), { asset_id: c.subsequence.asset_id, name: 'Intro' }, 'get_timeline đánh dấu block Subsequence');
        assert.strictEqual(tl.in_subsequence, false);
        const assets = await app.call('list_assets', {});
        assert.ok(assets.project_assets.some((x) => x.id === c.subsequence.asset_id && x.subsequence === true), 'list_assets đánh dấu tài sản Subsequence');

        // Lỗi: lý do của app được gửi về, không để lại bước Hoàn tác.
        const u1 = sb.undoStack.length;
        await assert.rejects(app.call('subsequence', { action: 'create', main_indexes: [0] }), /Không có clip lane chính 0/);
        sb.latestTimeline.push({ start: 0, end: 3, text: 'a' }, { start: 3, end: 5, text: 'b' });
        await assert.rejects(app.call('subsequence', { action: 'create', main_indexes: [0, 1] }), /LIỀN NHAU/, 'toast của app thành lỗi MCP');
        await assert.rejects(app.call('subsequence', { action: 'enter', item_id: 'nope' }), /Không có block/);
        await assert.rejects(app.call('subsequence', { action: 'enter', main_index: 0 }), /không phải Subsequence/);
        await assert.rejects(app.call('subsequence', { action: 'duplicate', main_index: 0 }), /chỉ cho block Subsequence trên lane overlay/);
        await assert.rejects(app.call('subsequence', { action: 'rename', item_id: c.item_id }), /Cần "name"/);
        await assert.rejects(app.call('subsequence', { action: 'fly' }), /"action" là một trong/);
        assert.strictEqual(sb.undoStack.length, u1, 'lệnh lỗi không thêm bước Hoàn tác');

        // Vào / ra: get_state + get_timeline báo đang ở trong; lệnh sửa làm việc với nội dung bên trong.
        const e = await app.call('subsequence', { action: 'enter', item_id: c.item_id });
        assert.strictEqual(e.in_subsequence, true);
        assert.deepStrictEqual(plain(e.subsequence_path), [{ asset_id: c.subsequence.asset_id, name: 'Intro', instance: c.item_id }]);
        assert.strictEqual(sb.undoStack.length, u1, 'vào = điều hướng, không ghi lịch sử');
        const inner = await app.call('get_timeline', {});
        assert.ok(inner.in_subsequence && inner.items.length === 2 && inner.items.every((it) => it.type === 'shape'), 'timeline = nội dung bên trong');
        const innerId = inner.items[0].id;
        await app.call('update_block', { item_id: innerId, keyframes: { opacity: [{ t: 0, v: 50 }] } });
        const x = await app.call('subsequence', { action: 'exit' });
        assert.ok(x.exited === 1 && x.in_subsequence === false, JSON.stringify(x));
        assert.strictEqual((await app.call('get_state', {})).in_subsequence, false);

        // Xuất + thêm video lane chính khi đang ở trong: tự trở về timeline gốc TRƯỚC.
        await app.call('subsequence', { action: 'enter', item_id: c.item_id });
        let insideAtExport = null;
        sb.performVideoExport = async () => { insideAtExport = sb.EditingRuntime.isInsideNest(); };
        const job = await app.call('start_job', { kind: 'export', options: { output_path: '/tmp/x.mp4' } });
        await app.waitJob(job);
        assert.strictEqual(insideAtExport, false, 'xuất = timeline gốc (đã ra khỏi Subsequence)');
        await app.call('subsequence', { action: 'enter', item_id: c.item_id });
        let insideAtMain = null;
        sb.addSourcePathsToMainLane = async () => { insideAtMain = sb.EditingRuntime.isInsideNest(); return true; };
        await app.call('add_main_videos', { paths: ['/v/a.mp4'] });
        assert.strictEqual(insideAtMain, false, 'thêm video lane chính = timeline gốc');

        // Đổi tên, nhân bản (dùng chung / độc lập), tách, bung.
        const r = await app.call('subsequence', { action: 'rename', asset_id: c.subsequence.asset_id, name: '  Mở đầu  ' });
        assert.strictEqual(r.subsequence.name, 'Mở đầu');
        const d1 = await app.call('subsequence', { action: 'duplicate', item_id: c.item_id });
        assert.ok(d1.shared_content && d1.subsequence.instances === 2, JSON.stringify(d1));
        const d2 = await app.call('subsequence', { action: 'duplicate', item_id: c.item_id, independent: true });
        assert.ok(!d2.shared_content && d2.subsequence.asset_id !== c.subsequence.asset_id);
        const mu = await app.call('subsequence', { action: 'make_unique', item_id: d1.item_id });
        assert.notStrictEqual(mu.subsequence.asset_id, c.subsequence.asset_id);
        const list = await app.call('subsequence', { action: 'list' });
        assert.strictEqual(list.subsequences.length, 3);
        st().editingItems.find((it) => it.id === c.item_id).transform.scale = 150;
        const u2 = sb.undoStack.length;
        await assert.rejects(app.call('subsequence', { action: 'unnest', item_id: c.item_id }), /discard_effects: true/, 'hộp confirm của app thành lỗi có hướng dẫn');
        assert.strictEqual(sb.undoStack.length, u2);
        const un = await app.call('subsequence', { action: 'unnest', item_id: c.item_id, discard_effects: true });
        assert.strictEqual(un.count, 2);
        assert.ok(un.item_ids.every((id) => st().editingItems.some((it) => it.id === id)) && !st().editingItems.some((it) => it.id === c.item_id));
        assert.ok(st().editingItems.some((it) => it.keyframes && it.keyframes.opacity), 'sửa bên trong được giữ khi ra');
        assert.strictEqual(sb.undoStack.length, u2 + 1, 'bung = MỘT bước Hoàn tác');

        // Hai lệnh chạy CHỒNG nhau (tạo chờ lâu + đổi tên): confirm/prompt/showToast trả về đúng bản gốc.
        const nativePrompt = sb.prompt;
        const nativeToast = sb.showToast;
        const s1 = await app.call('add_shape', { shape_type: 'circle', start: 20, duration: 1 });
        sb.slowCreate = true;
        const slow = app.call('subsequence', { action: 'create', item_ids: [s1.item_id] });
        await new Promise((r) => setTimeout(r, 10));   // lệnh tạo đã vào tới chỗ chờ
        assert.notStrictEqual(sb.showToast, nativeToast, 'đang chờ: toast được gom');
        assert.strictEqual(sb.confirm, nativeConfirm, 'đang chờ lệnh tạo: hộp xác nhận của người dùng KHÔNG bị tự trả lời');
        await app.call('subsequence', { action: 'rename', item_id: d2.item_id, name: 'Song song' });
        await slow;
        assert.ok(sb.confirm === nativeConfirm && sb.prompt === nativePrompt && sb.showToast === nativeToast, 'chạy chồng không rò wrapper');

        // Biến dạng không áp cho block Subsequence.
        await assert.rejects(app.call('update_block', { item_id: d2.item_id, distort: [{ type: 'wave' }] }), /Subsequence/);
        ok('subsequence: tạo/đặt tên một bước Hoàn tác, vào/ra báo trong get_state/get_timeline, xuất + lane chính tự trở ra, đổi tên/nhân bản/tách/bung, lỗi của app gửi về');
    }

    // ---- Lồng tiếng
    {
        const app = makeApp();
        const job = await app.call('start_job', { kind: 'dub', options: { text: 'Câu một. Câu hai! Câu ba?', start: 5, name: 'Intro', gap: 0.3 } });
        const done = await app.waitJob(job);
        assert.strictEqual(done.state, 'complete', JSON.stringify(done));
        const post = app.sandbox.fetchLog.find((f) => f.url === '/api/dubbing/jobs');
        assert.strictEqual(post.body.timing_mode, 'sequential', 'văn bản = đọc nối tiếp');
        assert.strictEqual(post.body.voice, 'Hải Đăng', 'giọng mặc định = lựa chọn ở panel');
        assert.strictEqual(post.body.gap, 0.3);
        assert.deepStrictEqual(plain(post.body.cues.map((c) => c.text)), ['Câu một.', 'Câu hai!', 'Câu ba?']);
        const r = done.result;
        assert.deepStrictEqual(plain(r.clips), [{ i: 0, start: 5.1, end: 6.6 }, { i: 1, start: 7.1, end: 8.6 }, { i: 2, start: 9.1, end: 10.6 }], 'mốc từng câu đã cộng start');
        assert.strictEqual(r.subtitles, 3, 'sinh phụ đề khớp tiếng');
        assert.ok(!JSON.stringify(r).includes('Câu một'), 'kết quả không trả lại chữ đã gửi');
        assert.strictEqual(app.sandbox.undoStack.length, 1, 'audio + phụ đề = MỘT bước Hoàn tác');
        assert.strictEqual(app.state.editingItems[0].dubbing_source, 'mcp:Intro');
        await assert.rejects(app.call('start_job', { kind: 'dub', options: {} }), /text/);
        await assert.rejects(app.call('start_job', { kind: 'dub', options: { text: 'x', engine: 'nope' } }), /Không có engine/);
        const voices = await app.call('catalog', { kind: 'voices' });
        assert.deepStrictEqual(plain(voices.engines[0].voices), ['Hải Đăng', 'Ngọc']);
        assert.deepStrictEqual(plain(voices.profiles), [{ id: 'p1', name: 'Giọng tôi' }], 'hồ sơ giọng chỉ id + tên');
        ok('dub: văn bản -> câu, giọng mặc định của panel, audio + phụ đề một bước Hoàn tác, trả mốc từng câu');
    }
}

// ---------------------------------------------------------------- B. MCP server thật
async function partB() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crabby-mcp-'));
    const calls = [];
    const jobs = new Map();
    let seq = 0;
    const token = 'tkn';
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            assert.strictEqual(req.headers.authorization, `Bearer ${token}`);
            const { method, params } = JSON.parse(raw);
            calls.push(method);
            let result;
            if (method === 'start_job') {
                const id = `job_${++seq}`;
                // "slow" chạy mãi; job khác xong sau 2 lượt hỏi.
                jobs.set(id, { id, kind: params.kind, polls: params.options.slow ? Infinity : 2 });
                result = { id, state: 'running', kind: params.kind };
            } else if (method === 'job_status') {
                const j = jobs.get(params.job_id);
                j.polls -= 1;
                result = j.polls > 0 ? { id: j.id, state: 'running', progress: 10 } : { id: j.id, state: 'complete', result: { item_id: 'item_x', kind: j.kind } };
            } else if (method === 'update_geocode') {
                result = { item_id: params.item_id, geocode: { code: 'abc' } };
            } else if (method === 'add_shape') {
                result = { item_id: 'item_shape_1' };
            }
            res.end(JSON.stringify({ ok: true, result }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const dir = path.join(home, 'automation');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `bridge-${process.pid}.json`), JSON.stringify({
        pid: process.pid, port: server.address().port, token, version: 'test', packaged: false, platform: process.platform, startedAt: new Date().toISOString(),
    }));
    const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'crabbycut-mcp.js')], { env: { ...process.env, CRAB_APP_DATA_DIR: home, CRABBYCUT_TARGET: '' }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const waiters = new Map();
    child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            waiters.get(msg.id)?.(msg);
        }
    });
    let rid = 0;
    const request = (method, params) => new Promise((resolve) => {
        const id = ++rid;
        waiters.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const tool = async (name, args) => {
        const msg = await request('tools/call', { name, arguments: args });
        const text = msg.result?.content?.[0]?.text || '';
        return { isError: !!msg.result?.isError, data: msg.result?.isError ? text : JSON.parse(text) };
    };
    try {
        await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
        const list = await request('tools/list', {});
        const names = list.result.tools.map((t) => t.name);
        for (const n of ['crabbycut_add_shape', 'crabbycut_update_geocode', 'crabbycut_dub', 'crabbycut_add_geocode']) assert.ok(names.includes(n), `thiếu tool ${n}`);
        const geo = list.result.tools.find((t) => t.name === 'crabbycut_add_geocode');
        assert.ok(geo.inputSchema.properties.items && geo.inputSchema.properties.template, 'add_geocode nhận items + template');

        calls.length = 0;
        const g = await tool('crabbycut_add_geocode', { lang: 'html', code: '<b>x</b>', width: 100, height: 100 });
        assert.ok(!g.isError && g.data.state === 'complete' && g.data.item_id === 'item_x', `add_geocode phải tự chờ job xong: ${JSON.stringify(g)}`);
        assert.deepStrictEqual(calls, ['start_job', 'job_status', 'job_status'], 'server tự hỏi job_status, model chỉ gọi MỘT lần');
        const d = await tool('crabbycut_dub', { text: 'Xin chào.' });
        assert.ok(d.data.state === 'complete' && d.data.kind === 'dub', JSON.stringify(d));
        const slow = await tool('crabbycut_dub', { text: 'x', slow: true, wait_seconds: 1 }).catch((e) => e);
        // "slow" không có trong schema nhưng server không chặn trường lạ — đủ để giả job chạy lâu.
        assert.ok(slow.data && slow.data.state === 'running' && /crabbycut_job_status/.test(slow.data.next), `hết hạn chờ phải trả job_id: ${JSON.stringify(slow)}`);
        calls.length = 0;
        const read = await tool('crabbycut_update_geocode', { item_id: 'item_x', read: true });
        assert.deepStrictEqual(calls, ['update_geocode'], 'chỉ đọc mã: gọi thẳng, không tạo job');
        assert.strictEqual(read.data.geocode.code, 'abc');
        calls.length = 0;
        await tool('crabbycut_update_geocode', { item_id: 'item_x', replace: [{ find: 'a', with: 'b' }] });
        assert.strictEqual(calls[0], 'start_job', 'vá mã = job dựng lại');
        const ss = list.result.tools.find((t) => t.name === 'crabbycut_subsequence');
        assert.ok(ss && ss.inputSchema.properties.action.enum.includes('unnest'), 'có tool crabbycut_subsequence');
        const ub = list.result.tools.find((t) => t.name === 'crabbycut_update_block');
        assert.deepStrictEqual(ub.inputSchema.properties.distort.items.properties.type.enum, ['wave', 'bezier', 'mesh', 'puppet', 'liquify'], 'update_block nhận distort');
        assert.ok(list.result.tools.find((t) => t.name === 'crabbycut_catalog').inputSchema.properties.kind.enum.includes('distort'), 'catalog có kind distort');
        const sh = await tool('crabbycut_add_shape', { shape_type: 'circle' });
        assert.strictEqual(sh.data.item_id, 'item_shape_1');
        ok('MCP server: tool mới có trong danh sách, add_geocode/dub tự chờ job (một lượt gọi), hết hạn chờ trả job_id, read không tạo job');
    } finally {
        child.kill();
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
}

(async () => {
    try {
        await partA();
        await partB();
        console.log('mcp_shape_geocode_dub: OK');
        process.exit(0);
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();
