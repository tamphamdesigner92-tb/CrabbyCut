// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* CẦU NỐI TỰ ĐỘNG HOÁ — PHÍA RENDERER.
 *
 * Nhận lệnh từ main (electron/automation-bridge.js, do MCP server mcp/crabbycut-mcp.js gửi tới)
 * và chạy nó bằng CHÍNH các hàm mà nút bấm/phím tắt đang dùng — nên mọi thao tác đi qua
 * undo/redo, đánh dấu "chưa lưu" và vẽ lại y như người dùng tự làm.
 *
 * Phụ thuộc global của index.html (classic script, nạp trước file này): latestTimeline,
 * currentStepId, currentMode, currentProjectPath, projectDirty, undoStack, redoStack, video,
 * executeUndo/executeRedo, togglePlayPause, saveProject, openProjectByPath,
 * setVideoTimeFromTimelineTime, getCurrentTimelineTime, getTimelineDuration,
 * clipSequenceDuration, clipSpeedRate, splitLatestTimelineAt, selectTimelineClip,
 * usesVirtualClock/isVirtualClockPlaying — và window.EditingRuntime. Đọc qua `typeof` để
 * một hàm bị đổi tên thì lệnh đó báo lỗi rõ ràng chứ không làm chết cả cầu nối.
 *
 * Bật/tắt theo Cài đặt › Chung › Nâng cao (general.automationBridge, mặc định tắt). */
(function () {
    const env = window.desktopEnv;
    if (!env || typeof env.onAutomationCall !== 'function') return;

    const MAX_TEXT = 200;

    function need(fn, name) {
        if (typeof fn !== 'function') throw new Error(`Hàm "${name}" không có trong bản này`);
        return fn;
    }

    function requireEditing() {
        if (currentMode !== 'FINAL' || currentStepId !== 'step4') {
            throw new Error('Lệnh này chỉ chạy ở bước Editing (step4). Hiện tại: '
                + `${currentStepId} / ${currentMode}`);
        }
    }

    function round3(n) {
        return Math.round((Number(n) || 0) * 1000) / 1000;
    }

    // Chỉ giữ trường nguyên thuỷ, cắt chuỗi dài — clip/item chứa cả mảng word-level, transform,
    // keyframe… gửi nguyên cho model là phí token mà nó không cần để hiểu timeline.
    function flatFields(obj) {
        const out = {};
        for (const [key, value] of Object.entries(obj || {})) {
            if (typeof value === 'number') out[key] = round3(value);
            else if (typeof value === 'boolean') out[key] = value;
            else if (typeof value === 'string') out[key] = value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
        }
        return out;
    }

    /* ---- Subsequence (Nest): nhận diện + đường đang mở (xem lệnh subsequence bên dưới) ---- */
    function nestAssetById(id) {
        if (!id || !window.NestSequence) return null;
        const asset = window.EditingRuntime?.automation?.findAsset?.(String(id));
        return NestSequence.isNestAsset(asset) ? asset : null;
    }

    function nestRef(asset) {
        return { asset_id: asset.id, name: asset.name || '' };
    }

    // Đang sửa bên trong Subsequence nào: timeline đọc/sửa lúc này là của sequence con.
    function subsequenceState() {
        const path = window.EditingRuntime?.nestPath?.() || [];
        if (!path.length) return { in_subsequence: false };
        return {
            in_subsequence: true,
            subsequence_path: path.map((f) => ({ asset_id: f.assetId, name: nestAssetById(f.assetId)?.name || '', instance: f.instanceItemId })),
        };
    }

    // Trở về timeline gốc (chốt nội dung đang sửa). Trả true nếu đã phải ra.
    function leaveSubsequences() {
        const r = window.EditingRuntime;
        if (!r?.isInsideNest?.()) return false;
        r.exitAllNests();
        return true;
    }

    // Block vừa tạo: có `item_id` để lệnh gộp tham chiếu kiểu "$0.item_id".
    function itemResult(item) {
        return { item_id: item.id, ...flatFields(item) };
    }

    function isPlaying() {
        if (typeof usesVirtualClock === 'function' && usesVirtualClock()) {
            return typeof isVirtualClockPlaying === 'function' && isVirtualClockPlaying();
        }
        return !!(typeof video !== 'undefined' && video && !video.paused);
    }

    function playhead() {
        return typeof getCurrentTimelineTime === 'function' ? round3(getCurrentTimelineTime()) : 0;
    }

    function mainLaneClips() {
        const rows = Array.isArray(latestTimeline) ? latestTimeline : [];
        let cursor = 0;
        return rows.map((clip, index) => {
            const duration = need(clipSequenceDuration, 'clipSequenceDuration')(clip);
            const row = {
                index,
                timeline_start: round3(cursor),
                timeline_end: round3(cursor + duration),
                ...flatFields(clip),
            };
            const nest = clip?.nest_asset_id ? nestAssetById(clip.nest_asset_id) : null;
            if (nest) row.subsequence = nestRef(nest);
            cursor += duration;
            return row;
        });
    }

    function overlayItems() {
        const state = window.EditingRuntime?.getState?.();
        if (!state) return { tracks: [], items: [] };
        return {
            tracks: (state.editingTracks || []).map(flatFields),
            items: (state.editingItems || []).map((item) => {
                const nest = item?.type === 'media' ? nestAssetById(item.asset_id) : null;
                return {
                    ...flatFields(item),
                    timeline_end: round3((Number(item.timeline_start) || 0) + (Number(item.duration) || 0)),
                    ...(nest ? { subsequence: nestRef(nest) } : {}),
                };
            }),
            selected_item_ids: state.selectedEditingItemIds || [],
            selected_main_indexes: state.selectedMainClipIndexes || [],
        };
    }

    function getState() {
        return {
            step: currentStepId,
            mode: currentMode,
            project_path: (typeof currentProjectPath !== 'undefined' && currentProjectPath) || '',
            project_name: window.getProjectDisplayName?.() || '',
            dirty: typeof projectDirty !== 'undefined' ? !!projectDirty : null,
            duration: typeof getTimelineDuration === 'function' ? round3(getTimelineDuration()) : 0,
            playhead: playhead(),
            playing: isPlaying(),
            main_clip_count: Array.isArray(latestTimeline) ? latestTimeline.length : 0,
            overlay_item_count: window.EditingRuntime?.getState?.()?.editingItems?.length || 0,
            undo_available: typeof undoStack !== 'undefined' ? undoStack.length : null,
            redo_available: typeof redoStack !== 'undefined' ? redoStack.length : null,
            editing_ready: currentMode === 'FINAL' && currentStepId === 'step4',
            ...subsequenceState(),
        };
    }

    function seek(time) {
        const t = Number(time);
        if (!Number.isFinite(t) || t < 0) throw new Error('"time" phải là số giây ≥ 0');
        const total = typeof getTimelineDuration === 'function' ? getTimelineDuration() : t;
        need(setVideoTimeFromTimelineTime, 'setVideoTimeFromTimelineTime')(Math.min(t, total));
        window.EditingRuntime?.renderPreviewOverlays?.();
        return { playhead: playhead() };
    }

    /* Cắt lane chính tại một thời điểm SEQUENCE. splitLatestTimelineAt nhận giờ NGUỒN (giống
     * dao cắt), nên quy đổi: tìm clip phủ thời điểm đó, khoảng đã đi trong clip × tốc độ. */
    function splitMainAt(sequenceTime) {
        const rows = Array.isArray(latestTimeline) ? latestTimeline : [];
        let cursor = 0;
        for (let index = 0; index < rows.length; index += 1) {
            const clip = rows[index];
            const duration = clipSequenceDuration(clip);
            if (sequenceTime > cursor && sequenceTime < cursor + duration) {
                const sourceTime = Number(clip.start) + (sequenceTime - cursor) * clipSpeedRate(clip);
                const ok = need(splitLatestTimelineAt, 'splitLatestTimelineAt')(index, sourceTime, { exact: true });
                if (ok === false) throw new Error('Không cắt được (điểm cắt quá sát mép clip?)');
                return { split: 'main', index, time: round3(sequenceTime) };
            }
            cursor += duration;
        }
        throw new Error(`Không có clip lane chính nào phủ thời điểm ${round3(sequenceTime)}s`);
    }

    const METHODS = {
        get_state: () => getState(),

        get_timeline: ({ include_overlays = true } = {}) => ({
            ...getState(),
            main_lane: mainLaneClips(),
            ...(include_overlays ? overlayItems() : {}),
        }),

        seek: ({ time }) => seek(time),

        play: async () => {
            if (!isPlaying()) await need(togglePlayPause, 'togglePlayPause')();
            return { playing: isPlaying() };
        },

        pause: async () => {
            if (isPlaying()) await need(togglePlayPause, 'togglePlayPause')();
            return { playing: isPlaying(), playhead: playhead() };
        },

        undo: () => {
            need(executeUndo, 'executeUndo')();
            return getState();
        },

        redo: () => {
            need(executeRedo, 'executeRedo')();
            return getState();
        },

        select: ({ main_index, item_id } = {}) => {
            requireEditing();
            const rt = window.EditingRuntime;
            if (item_id) need(rt?.selectItem, 'EditingRuntime.selectItem')(String(item_id));
            else if (Number.isInteger(main_index)) need(rt?.selectMainClip, 'EditingRuntime.selectMainClip')(main_index);
            else need(rt?.clearSelection, 'EditingRuntime.clearSelection')();
            return overlayItems();
        },

        split: ({ time, item_id } = {}) => {
            requireEditing();
            const t = Number.isFinite(Number(time)) ? Number(time) : getCurrentTimelineTime();
            if (item_id) {
                const ok = need(window.EditingRuntime?.splitItemAtTime, 'EditingRuntime.splitItemAtTime')(String(item_id), t);
                if (!ok) throw new Error('Không cắt được block (block quá ngắn, track khoá, hoặc thời điểm nằm ngoài block)');
                return { split: 'item', item_id, time: round3(t) };
            }
            return splitMainAt(t);
        },

        delete_selected: () => {
            requireEditing();
            const ok = need(window.EditingRuntime?.deleteSelectedBlocks, 'EditingRuntime.deleteSelectedBlocks')();
            if (!ok) throw new Error('Không có block nào đang chọn (hoặc track đang khoá)');
            return getState();
        },

        add_text: (params = {}) => addTextBlock(params),

        save_project: async () => {
            if (!currentProjectPath) {
                throw new Error('Dự án chưa từng được lưu — người dùng cần bấm Lưu lần đầu để chọn chỗ lưu.');
            }
            await need(saveProject, 'saveProject')(false);
            return getState();
        },

        open_project: async ({ path } = {}) => {
            if (typeof path !== 'string' || !/\.crab$/i.test(path)) throw new Error('"path" phải là đường dẫn tệp .crab');
            // Không bao giờ vứt thay đổi của người dùng: dự án đang dở thì để họ tự lưu trước.
            if (projectDirty) throw new Error('Dự án đang mở có thay đổi chưa lưu — hãy lưu (save_project) trước.');
            await need(openProjectByPath, 'openProjectByPath')(path);
            return getState();
        },
    };

    /* =====================================================================
     * CHỈNH SỬA THEO TÍNH NĂNG
     * Mỗi lệnh = MỘT bước hoàn tác (beginHistoryBatch), chạy qua đúng hàm mà panel/inspector
     * gọi (EditingRuntime.automation.*), rồi vẽ lại một lượt ở cuối.
     * ===================================================================== */

    function rt() {
        const runtime = window.EditingRuntime;
        if (!runtime?.automation) throw new Error('EditingRuntime chưa nạp xong');
        return runtime;
    }

    function api() {
        return rt().automation;
    }

    /* Mốc trên cùng của undoStack. So theo DANH TÍNH chứ không theo độ dài: chồng đã đầy
     * (general.undoSteps) thì mỗi lần ghi là một lần shift, độ dài đứng yên — so độ dài là
     * tưởng "không có mốc mới" và lệnh lỗi không được quay lui. */
    function historyTop() {
        return typeof undoStack !== 'undefined' && undoStack.length ? undoStack[undoStack.length - 1] : null;
    }

    /* Ảnh chụp vị trí chồng Hoàn tác: đỉnh (để biết có mốc mới không) + đáy (chồng đầy thì ghi
     * mốc mới là đẩy mốc CŨ NHẤT ra — lệnh lỗi phải trả nó về chỗ cũ). */
    function historyMark() {
        return { top: historyTop(), bottom: typeof undoStack !== 'undefined' ? undoStack[0] : undefined };
    }

    /* Một bước hoàn tác + một lượt vẽ cho cả lệnh; kết thúc batch kể cả khi lỗi (bỏ sót là hỏng
     * undo về sau). Lệnh LỖI giữa chừng thì quay lui về ảnh chụp vừa ghi: không để lại thay đổi
     * dở dang, cũng không để lại một bước Hoàn tác rỗng.
     *
     * `joinSince`: historyMark() chụp TRƯỚC KHI lệnh bắt đầu. Có mốc mới ghi từ đó (bước nhập tệp
     * tự ghi) thì phần này nhập chung vào mốc đó thay vì thêm bước thứ hai — nhập + đặt block là
     * MỘT lần Ctrl+Z. Gọi lồng (trong lệnh gộp) thì lịch sử đang treo: không ghi gì thêm. */
    async function asOneUndoStep(fn, { joinSince, liveRender = false } = {}) {
        const runtime = rt();
        const mark = joinSince || historyMark();
        const joined = !!joinSince && historyTop() !== joinSince.top;
        const endHistory = joined ? runtime.automation.suspendHistory() : runtime.beginHistoryBatch();
        // liveRender: thao tác chờ lâu (dựng Subsequence lane chính) tự vẽ giữa chừng — không treo vẽ.
        const releaseRender = liveRender ? () => {} : runtime.automation.suspendRender();
        try {
            return await fn();
        } catch (error) {
            endHistory();
            if (historyTop() !== mark.top && typeof restoreHistoryState === 'function') {
                restoreHistoryState(undoStack.pop());
                if (mark.bottom && !undoStack.includes(mark.bottom)) undoStack.unshift(mark.bottom);
                if (typeof updateUndoRedoButtons === 'function') updateUndoRedoButtons();
            }
            throw error;
        } finally {
            endHistory();
            runtime.renderAll();
            releaseRender();
        }
    }

    function isLocked(trackId) {
        return api().isTrackLocked(api().findTrack(trackId));
    }

    /* Chọn ĐÚNG MỘT đích (clip lane chính theo index, hoặc block overlay theo id) — các hàm
     * apply*ToSelected của runtime làm việc trên phần đang chọn, y như inspector. */
    function selectTarget({ main_index, item_id } = {}) {
        if (item_id) {
            const item = api().findItem(String(item_id));
            if (!item) throw new Error(`Không có block id "${item_id}"`);
            if (isLocked(item.track_id)) throw new Error(`Track ${item.track_id} đang khoá`);
            rt().selectItem(item.id);
            return { kind: 'item', target: api().findItem(item.id) };
        }
        const index = Number(main_index);
        if (!Number.isInteger(index) || !latestTimeline?.[index]) {
            throw new Error('Cần "main_index" (clip lane chính) hoặc "item_id" (block overlay)');
        }
        if (isLocked('track_main')) throw new Error('Lane chính đang khoá');
        rt().selectMainClip(index);
        return { kind: 'main', target: latestTimeline[index], index };
    }

    function describeTarget({ kind, target, index }) {
        const keyframes = target.keyframes && Object.keys(target.keyframes).length ? target.keyframes : null;
        if (kind === 'main') return { main_index: index, ...flatFields(target), transform: target.transform || null, keyframes, animation: target.animation || null, transition: target.transition || null };
        return { item_id: target.id, ...flatFields(target), transform: target.transform || null, keyframes, style: target.style || null, animation: target.animation || null, transition: target.transition || null };
    }

    function mainClipDuration(index) {
        return clipSequenceDuration(latestTimeline[index]);
    }

    const TRANSFORM_FIELDS = ['position_x', 'position_y', 'scale', 'rotation', 'opacity', 'flip_x', 'flip_y'];

    /* =====================================================================
     * KEYFRAME QUA MCP
     * keyframes = { field: [{ t, v, e }] } — đúng mô hình lưu của app (text-animations.js):
     *   t = giây CỤC BỘ từ đầu block (hoặc giây sequence với keyframe_time: "timeline"),
     *   v = giá trị (px / % / độ — cùng đơn vị ô Thuộc tính), e = easing của đoạn RỜI mốc này.
     * Field nhận: position_x/y, scale, rotation, opacity; "position" = [{t, x, y}] cho cả hai
     * trục; volume (%); thông số màu keyframe được ("basic.exposure" hoặc "adj.basic.exposure").
     * Ghi bằng upsertKeyframe của runtime rồi pairPositionKeyframes — giữ bất biến "X và Y luôn
     * có mốc trùng nhau" mà nút ◆ Vị trí dựa vào.
     * ===================================================================== */

    const KF_TIME_EPS = 0.02;

    function easingValues() {
        return (window.TextAnimations?.EASING_OPTIONS || []).map((o) => o.value);
    }

    // Đầu + độ dài của block trên trục SEQUENCE (để đổi giờ timeline -> giờ cục bộ và kiểm biên).
    function blockSpan({ kind, target, index }) {
        if (kind === 'item') return { start: Number(target.timeline_start) || 0, duration: Number(target.duration) || 0 };
        const span = api().mainClipSequenceSpans()[index];
        return { start: span ? span.start : 0, duration: span ? span.duration : mainClipDuration(index) };
    }

    function keyframeFieldOf(name) {
        const TA = window.TextAnimations;
        const CA = window.ColorAdjust;
        const raw = String(name || '');
        if (raw === 'position') return { kind: 'position', fields: ['position_x', 'position_y'] };
        if ((TA?.KEYFRAME_FIELDS || []).includes(raw)) return { kind: 'transform', fields: [raw] };
        if (raw === (TA?.VOLUME_KEYFRAME_FIELD || 'volume')) return { kind: 'volume', fields: [raw] };
        const path = raw.startsWith('adj.') ? raw.slice(4) : raw;
        if (CA?.canKeyframe?.(path)) return { kind: 'color', fields: [CA.keyframeFieldName(path)] };
        const colorList = (CA?.KEYFRAME_PARAMS || []).map((p) => p.path).join(', ');
        throw new Error(`keyframes.${raw} không hỗ trợ. Có: position, ${(TA?.KEYFRAME_FIELDS || []).join(', ')}, volume, và màu: ${colorList}`);
    }

    function checkKeyframeTarget(kind, { kind: targetKind, target }) {
        if (targetKind === 'main') return;
        const type = target.type;
        if ((kind === 'transform' || kind === 'position') && ['audio', 'adjust'].includes(type)) {
            throw new Error(`Block loại "${type}" không có keyframe biến đổi`);
        }
        if (kind === 'volume' && !['media', 'audio'].includes(type)) throw new Error('Keyframe âm lượng chỉ cho block media/âm thanh');
        if (kind === 'color' && !['media', 'adjust'].includes(type)) throw new Error('Keyframe màu chỉ cho clip lane chính, block media hoặc lớp Điều chỉnh');
    }

    function keyframeValue(kind, field, raw) {
        const v = Number(raw);
        if (!Number.isFinite(v)) throw new Error(`Giá trị keyframe "${field}" phải là số`);
        if (kind === 'transform' || kind === 'position') {
            return typeof clampTransformValue === 'function' ? clampTransformValue(field, v) : v;
        }
        if (kind === 'volume') return api().normalizeVolumePercent(v);
        return v;
    }

    /* Ghi keyframe cho MỘT đích đã chọn (selectTarget). mode "merge" chèn/ghi đè từng mốc,
     * "replace" thay trọn danh sách của field được nêu (mảng rỗng = xoá hết keyframe field đó).
     * Trả về danh sách field đã đổi. */
    function applyKeyframes(sel, spec, { mode = 'merge', time = 'local' } = {}) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('"keyframes" phải là object { field: [{t, v, e}] }');
        if (!['merge', 'replace'].includes(mode)) throw new Error('"keyframe_mode" là merge | replace');
        if (!['local', 'timeline'].includes(time)) throw new Error('"keyframe_time" là local | timeline');
        const { target } = sel;
        const span = blockSpan(sel);
        const easings = easingValues();
        if (!target.keyframes || typeof target.keyframes !== 'object') target.keyframes = {};
        const kfs = target.keyframes;
        const changed = [];
        let touchedPosition = false;
        let touchedColor = false;
        for (const [name, list] of Object.entries(spec)) {
            if (!Array.isArray(list)) throw new Error(`keyframes.${name} phải là mảng [{t, v, e}]`);
            const dst = distortKeyframeInfo(sel, name);
            const info = dst || keyframeFieldOf(name);
            if (!dst) checkKeyframeTarget(info.kind, sel);
            if (mode === 'replace') info.fields.forEach((f) => { kfs[f] = []; });
            for (const entry of list) {
                if (!entry || typeof entry !== 'object') throw new Error(`keyframes.${name}: mỗi mốc là { t, v, e }`);
                let t = Number(entry.t);
                if (!Number.isFinite(t)) throw new Error(`keyframes.${name}: thiếu "t" (giây)`);
                if (time === 'timeline') t -= span.start;
                if (t < -KF_TIME_EPS || t > span.duration + KF_TIME_EPS) {
                    throw new Error(`keyframes.${name}: t=${round3(entry.t)} nằm ngoài block (0–${round3(span.duration)} s${time === 'timeline' ? ` cục bộ, block bắt đầu ở ${round3(span.start)} s` : ' cục bộ'})`);
                }
                t = round3(Math.max(0, Math.min(span.duration, t)));
                const ease = entry.e === undefined ? 'ease-in-out' : String(entry.e);
                if (!easings.includes(ease)) throw new Error(`Easing "${ease}" không có. Có: ${easings.join(', ')}`);
                let values;
                if (info.kind === 'position') {
                    const pair = Array.isArray(entry.v) ? entry.v : [entry.x, entry.y];
                    values = info.fields.map((f, i) => [f, keyframeValue(info.kind, f, pair[i])]);
                } else if (info.kind === 'distort') {
                    values = [[info.fields[0], info.value(entry)]];
                } else {
                    values = [[info.fields[0], keyframeValue(info.kind, info.fields[0], entry.v)]];
                }
                for (const [field, value] of values) {
                    const next = api().upsertKeyframe(kfs[field], t, value, ease);
                    // upsertKeyframe giữ easing cũ khi mốc đã có — MCP nêu easing thì phải ăn.
                    const hit = next.find((k) => Math.abs(Number(k.t) - t) <= KF_TIME_EPS);
                    if (hit && entry.e !== undefined) hit.e = ease;
                    kfs[field] = next;
                }
            }
            info.fields.forEach((f) => {
                if (Array.isArray(kfs[f]) && !kfs[f].length) delete kfs[f];
            });
            if (info.kind === 'position' || info.fields.some((f) => f === 'position_x' || f === 'position_y')) touchedPosition = true;
            if (info.kind === 'color') touchedColor = true;
            changed.push(`keyframes.${name}`);
        }
        if (touchedPosition) window.TextAnimations?.pairPositionKeyframes?.(target);
        if (touchedColor && window.ColorAdjust) target.adjustments = ColorAdjust.normalize(target.adjustments);
        return changed;
    }

    /* =====================================================================
     * BIẾN DẠNG (Distort) QUA MCP
     * distort = [{ id?, type, enabled?, params? }] — danh sách MỚI, đúng thứ tự áp (static/js/
     * distort.js). Mục có id trùng hiệu ứng đang có thì GIỮ thông số + keyframe cũ và chỉ ghi đè
     * các params được nêu; mục không có id là hiệu ứng mới; hiệu ứng không còn trong danh sách
     * bị xoá cùng keyframe 'dst.<id>.*' (như nút × của Inspector). [] = bỏ hết.
     * Thông số sai (khoá lạ, enum không có, số không hợp lệ, lưới sai cỡ) BÁO LỖI thay vì lặng lẽ
     * về mặc định như normalizeStack — model cần biết mình truyền sai.
     * ===================================================================== */

    const DISTORT_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;

    function requireDistort(sel) {
        const D = window.Distort;
        if (!D) throw new Error('Module Biến dạng (distort.js) chưa nạp');
        const { kind, target } = sel;
        if (kind !== 'item' || !D.supportsItem(target)) throw new Error('Biến dạng (distort) chỉ cho block ảnh/video (media) hoặc Shape');
        if (window.NestSequence?.isNestAsset?.(api().findAsset?.(target.asset_id))) throw new Error('Block Subsequence (Nest) không có Biến dạng');
        return D;
    }

    function distortParamKeys(type) {
        return window.Distort.EFFECT_DEFS[type].params.map((p) => p.key);
    }

    // Kiểm + chuẩn hoá MỘT giá trị thông số; `fx` (rows/cols) để đối chiếu cỡ lưới Mesh.
    function distortValue(def, raw, where, fx) {
        const D = window.Distort;
        if (def.kind === 'enum') {
            const ids = def.options.map((o) => o.id);
            if (!ids.includes(String(raw))) throw new Error(`${where} là một trong: ${ids.join(', ')}`);
            return String(raw);
        }
        if (def.kind === 'num') {
            if (raw === null || raw === '' || !Number.isFinite(Number(raw))) throw new Error(`${where} phải là số (${def.min}..${def.max})`);
            return D.normalizeParam(def, raw);
        }
        if (def.kind === 'vec2') {
            if (!Array.isArray(raw) || raw.length !== 2 || !raw.every((n) => Number.isFinite(Number(n)))) {
                throw new Error(`${where} phải là [x, y] (tỉ lệ 0..1 của hộp block, gốc trên-trái)`);
            }
            return D.normalizeParam(def, raw);
        }
        if (def.kind === 'mesh') {
            if (raw === null) return null;
            const want = D.meshLength(fx.params.rows, fx.params.cols);
            if (!Array.isArray(raw) || raw.length !== want || !raw.every((n) => Number.isFinite(Number(n)))) {
                throw new Error(`${where} phải là mảng ${want} số = (rows+1)×(cols+1)×${D.MESH_STRIDE} (x, y, rồi tay cầm trái/phải/lên/xuống tương đối), hoặc null = lưới đều`);
            }
            return D.normalizeParam(def, raw);
        }
        if (def.kind === 'field') {
            if (raw === null) return null;
            if (!Array.isArray(raw) || raw.length !== D.FIELD_LEN || !raw.every((n) => Number.isFinite(Number(n)))) {
                throw new Error(`${where} phải là mảng ${D.FIELD_LEN} số (trường dời ${D.FIELD_N + 1}×${D.FIELD_N + 1} đỉnh × dx,dy), hoặc null = không dời`);
            }
            return D.normalizeParam(def, raw);
        }
        if (def.kind === 'pins') {
            if (!Array.isArray(raw)) throw new Error(`${where} phải là mảng [{id, rest: [x, y], pos?: [x, y]}]`);
            const seen = new Set();
            raw.forEach((pin, i) => {
                const id = String(pin?.id ?? '');
                if (!/^[A-Za-z0-9-]{1,24}$/.test(id)) throw new Error(`${where}[${i}].id phải là 1-24 ký tự chữ/số/-`);
                if (seen.has(id)) throw new Error(`${where}: trùng id ghim "${id}"`);
                seen.add(id);
                distortValue({ kind: 'vec2' }, pin.rest, `${where}[${i}].rest`);
                if (pin.pos !== undefined) distortValue({ kind: 'vec2' }, pin.pos, `${where}[${i}].pos`);
            });
            if (raw.length > 64) throw new Error(`${where}: tối đa 64 ghim`);
            return D.normalizeParam(def, raw);
        }
        throw new Error(`${where}: không ghi được`);
    }

    // Ghi trọn danh sách hiệu ứng. Trả về danh sách hiệu ứng mới (đã chuẩn hoá).
    function applyDistort(sel, list) {
        const D = requireDistort(sel);
        const { target } = sel;
        if (!Array.isArray(list)) throw new Error('"distort" phải là mảng [{type, enabled, params}] ([] = bỏ hết)');
        if (list.length > D.MAX_EFFECTS) throw new Error(`"distort": tối đa ${D.MAX_EFFECTS} hiệu ứng`);
        const old = D.normalizeStack(target.distort);
        const kfs = target.keyframes && typeof target.keyframes === 'object' ? target.keyframes : {};
        const dropKf = (prefix) => Object.keys(kfs).forEach((k) => { if (k.startsWith(prefix)) delete kfs[k]; });
        const listed = new Set(list.map((raw) => (raw && raw.id !== undefined ? String(raw.id) : null)).filter(Boolean));
        const taken = new Set([...old.map((f) => f.id), ...listed]);
        const freshId = () => {
            for (let n = 1; ; n += 1) if (!taken.has(`d${n}`)) { taken.add(`d${n}`); return `d${n}`; }
        };
        const used = new Set();
        const next = list.map((raw, i) => {
            const where = `distort[${i}]`;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} phải là object {type, enabled, params}`);
            const unknown = Object.keys(raw).filter((k) => !['id', 'type', 'enabled', 'params'].includes(k));
            if (unknown.length) throw new Error(`${where}: khoá lạ ${unknown.join(', ')} (có: id, type, enabled, params)`);
            let id = null;
            if (raw.id !== undefined) {
                id = String(raw.id);
                if (!DISTORT_ID_RE.test(id)) throw new Error(`${where}.id phải là 1-24 ký tự chữ/số/_/-`);
                if (used.has(id)) throw new Error(`${where}: trùng id "${id}"`);
            }
            const prev = id ? old.find((f) => f.id === id) : null;
            const type = raw.type !== undefined ? String(raw.type) : prev?.type;
            if (!D.EFFECT_DEFS[type]) throw new Error(`${where}.type là một trong: ${D.TYPE_IDS.join(', ')}`);
            if (prev && prev.type !== type) throw new Error(`${where}: hiệu ứng "${id}" là ${prev.type}, không đổi loại được (bỏ id để thêm hiệu ứng mới)`);
            if (raw.params !== undefined && (!raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params))) {
                throw new Error(`${where}.params phải là object`);
            }
            if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error(`${where}.enabled phải là true/false`);
            id = id || freshId();
            used.add(id);
            const fx = { id, type, enabled: raw.enabled !== undefined ? raw.enabled : (prev ? prev.enabled : true), params: prev ? { ...prev.params } : {} };
            const given = raw.params || {};
            const keys = distortParamKeys(type);
            Object.keys(given).forEach((key) => {
                if (!keys.includes(key)) {
                    const hint = type === 'puppet' && /^pin_/.test(key) ? ' (ghim đặt qua params.pins; keyframe vị trí ghim: keyframes "dst.<id>.pin_<pinId>")' : '';
                    throw new Error(`${where}.params.${key} không có ở ${type}. Có: ${keys.join(', ')}${hint}`);
                }
            });
            // rows/cols trước: lưới Mesh đối chiếu theo cỡ MỚI.
            const order = keys.filter((k) => k in given).sort((a, b) => (a === 'mesh') - (b === 'mesh'));
            order.forEach((key) => {
                fx.params[key] = distortValue(D.paramDef(type, key), given[key], `${where}.params.${key}`, fx);
            });
            const norm = D.normalizeEffect(fx, i);
            norm.id = id;
            if (prev && type === 'mesh' && (norm.params.rows !== prev.params.rows || norm.params.cols !== prev.params.cols)) {
                // Đổi số hàng/cột: lưới cũ và keyframe của nó không còn khớp -> đặt lại (như Inspector / AE).
                if (!('mesh' in given)) norm.params.mesh = null;
                delete kfs[D.kfField(id, 'mesh')];
            }
            if (prev && type === 'puppet') {
                const alive = new Set((norm.params.pins || []).map((p) => p.id));
                (prev.params.pins || []).forEach((p) => { if (!alive.has(p.id)) delete kfs[D.kfField(id, `pin_${p.id}`)]; });
            }
            return norm;
        });
        old.forEach((f) => { if (!used.has(f.id)) dropKf(`${D.KF_PREFIX}${f.id}.`); });
        if (next.length) target.distort = next;
        else delete target.distort;
        return next;
    }

    // Khoá keyframe 'dst.<id>.<param>' -> { kind: 'distort', fields, value(entry) }; null nếu không phải khoá Distort.
    function distortKeyframeInfo(sel, name) {
        const raw = String(name || '');
        if (!raw.startsWith('dst.')) return null;
        const D = requireDistort(sel);
        const parsed = D.parseKfField(raw);
        if (!parsed) throw new Error(`keyframes.${raw}: khoá Biến dạng là "dst.<id hiệu ứng>.<thông số>"`);
        const fx = D.normalizeStack(sel.target.distort).find((f) => f.id === parsed.effectId);
        if (!fx) {
            const ids = D.normalizeStack(sel.target.distort).map((f) => `${f.id} (${f.type})`);
            throw new Error(`keyframes.${raw}: block không có hiệu ứng "${parsed.effectId}". Có: ${ids.join(', ') || '(chưa có — thêm bằng "distort")'}`);
        }
        const def = D.paramDef(fx.type, parsed.key);
        const kfKeys = D.EFFECT_DEFS[fx.type].params.filter((p) => !p.noKf && p.kind !== 'pins').map((p) => p.key);
        if (fx.type === 'puppet') kfKeys.push('pin_<pinId>');
        if (!def || def.noKf || def.kind === 'pins') throw new Error(`keyframes.${raw}: "${parsed.key}" của ${fx.type} không keyframe được. Có: ${kfKeys.join(', ')}`);
        if (/^pin_/.test(parsed.key) && D.getParam(fx.params, parsed.key) === null) throw new Error(`keyframes.${raw}: không có ghim "${parsed.key.slice(4)}"`);
        return {
            kind: 'distort',
            fields: [raw],
            value: (entry) => {
                const v = def.kind === 'vec2' && entry.v === undefined && entry.x !== undefined ? [entry.x, entry.y] : entry.v;
                const out = distortValue(def, v, `keyframes.${raw}`, fx);
                if (out === null) throw new Error(`keyframes.${raw}: mốc cần giá trị thật (không nhận null)`);
                return out;
            },
        };
    }

    // Tóm tắt gọn cho kết quả: lưới Mesh / trường Liquify (hàng nghìn số) chỉ báo độ dài.
    function distortSummary(item) {
        if (!window.Distort || !Array.isArray(item.distort)) return [];
        return Distort.normalizeStack(item.distort).map((fx) => {
            const params = {};
            Object.entries(fx.params).forEach(([k, v]) => {
                params[k] = (k === 'mesh' || k === 'field') && Array.isArray(v) ? `[${v.length} numbers]` : v;
            });
            const keyframed = Object.keys(item.keyframes || {}).filter((k) => k.startsWith(`${Distort.KF_PREFIX}${fx.id}.`));
            return { id: fx.id, type: fx.type, enabled: fx.enabled, params, ...(keyframed.length ? { keyframes: keyframed } : {}) };
        });
    }

    async function updateBlock(params) {
        requireEditing();
        return asOneUndoStep(() => {
            const sel = selectTarget(params);
            const { kind, target } = sel;
            const a = api();
            const changed = [];

            const transform = params.transform && typeof params.transform === 'object' ? params.transform : {};
            for (const [field, value] of Object.entries(transform)) {
                if (!TRANSFORM_FIELDS.includes(field)) throw new Error(`transform.${field} không hỗ trợ. Có: ${TRANSFORM_FIELDS.join(', ')}`);
                a.applyTransformToSelected(field, value);
                changed.push(`transform.${field}`);
            }
            if (params.volume !== undefined) {
                a.applyVolumeToSelected(Number(params.volume));
                changed.push('volume');
            }
            if (params.speed !== undefined || params.pitch_correct !== undefined) {
                const patch = {};
                if (params.speed !== undefined) patch.rate = Number(params.speed);
                if (params.pitch_correct !== undefined) patch.pitch_correct = !!params.pitch_correct;
                a.applySpeedToSelected(patch);
                a.afterSpeedChange(kind === 'main' ? 'editingMain' : 'editingItem', '', true);
                changed.push('speed');
            }

            if (kind === 'item') {
                if (params.timeline_start !== undefined) { target.timeline_start = Math.max(0, Number(params.timeline_start) || 0); changed.push('timeline_start'); }
                if (params.duration !== undefined) {
                    const limit = a.itemSourceDurationLimit(target);
                    const want = Math.max(0.2, Number(params.duration) || 0.2);
                    target.duration = Number.isFinite(limit) && limit > 0 ? Math.min(want, limit) : want;
                    changed.push('duration');
                }
                if (params.muted !== undefined) { target.muted = !!params.muted; changed.push('muted'); }
                if (params.text !== undefined) {
                    if (target.type !== 'text') throw new Error('"text" chỉ dành cho block chữ');
                    target.text = String(params.text);
                    changed.push('text');
                }
                if (params.style && typeof params.style === 'object') {
                    if (target.type === 'text') a.patchTextStyle(target, { ...params.style });
                    else target.style = { ...(target.style || {}), ...params.style };
                    changed.push('style');
                }
                if (params.distort !== undefined) {
                    applyDistort(sel, params.distort);
                    changed.push('distort');
                }
                a.clampItemTiming(target);
            } else {
                if (params.distort !== undefined) requireDistort(sel);
                for (const key of ['timeline_start', 'duration', 'text', 'style', 'muted']) {
                    if (params[key] !== undefined) throw new Error(`"${key}" không áp cho clip lane chính (dùng split/trim bằng giao diện)`);
                }
            }
            // Sau cùng: biên kiểm keyframe là thời lượng block SAU khi đã đổi duration/speed.
            if (params.keyframes !== undefined) {
                changed.push(...applyKeyframes(sel, params.keyframes, { mode: params.keyframe_mode, time: params.keyframe_time }));
            }
            if (!changed.length) throw new Error('Không có gì để đổi — truyền transform/keyframes/volume/speed/timeline_start/duration/text/style/muted/distort');
            if (typeof updateSequencePreviewTransform === 'function') updateSequencePreviewTransform();
            const result = { changed, block: describeTarget(sel) };
            if (changed.some((c) => c === 'distort' || c.startsWith('keyframes.dst.'))) result.distort = distortSummary(target);
            return result;
        });
    }

    async function applyTextPreset({ item_id, style_preset, effect } = {}) {
        requireEditing();
        return asOneUndoStep(() => {
            const sel = selectTarget({ item_id });
            const item = sel.target;
            if (item.type !== 'text') throw new Error('Chỉ áp cho block chữ');
            const a = api();
            if (style_preset) {
                const preset = a.textStylePresets().find((p) => p.id === style_preset);
                if (!preset) throw new Error(`Không có kiểu chữ "${style_preset}" (xem catalog text_styles)`);
                a.patchTextStyle(item, { ...preset.patch });
            }
            if (effect !== undefined) {
                if (effect === 'none' || effect === '' || effect === null) {
                    a.patchTextStyle(item, a.textEffectNonePatch());
                } else {
                    const fx = a.findTextEffect(effect);
                    if (!fx) throw new Error(`Không có hiệu ứng chữ "${effect}" (xem catalog text_effects)`);
                    a.patchTextStyle(item, a.textEffectPatch(fx, a.inspectorTextStyle(item)));
                }
            }
            if (!style_preset && effect === undefined) throw new Error('Truyền "style_preset" và/hoặc "effect"');
            return describeTarget(sel);
        });
    }

    /* WIGGLE (kiểu After Effects) qua MCP: `wiggle` sửa TỪNG PHẦN theo loại, giữ loại không nêu.
     *   "none" | null | false        -> bỏ hết wiggle
     *   { position: null | false }   -> bỏ riêng loại đó
     *   { position: true }           -> bật (tham số cũ hoặc mặc định)
     *   { position: { amp: 40, … } } -> gộp vào tham số cũ; thiếu `enabled` = bật
     * Kiểm chặt (loại / khoá lạ, số ngoài dải -> lỗi) rồi chuẩn hoá qua normalizeWiggleFx. */
    const WIGGLE_KEYS = {
        common: ['enabled', 'freq', 'amp', 'octaves', 'amp_mult', 'seed', 'style', 'easing', 'hold'],
        position: ['axis'],
        scale: ['uniform'],
    };
    function mergeWiggleParam(prev, spec) {
        const TA = window.TextAnimations;
        if (spec === 'none' || spec === null || spec === false) return null;
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
            throw new Error('"wiggle" là object { position|scale|rotation|opacity: {...} } hoặc "none" (xem catalog wiggle)');
        }
        const out = { ...(TA.normalizeWiggle(prev) || {}) };
        const ranges = {
            freq: [TA.WIGGLE_FREQ_MIN, TA.WIGGLE_FREQ_MAX],
            octaves: [1, TA.WIGGLE_OCTAVES_MAX],
            amp_mult: [0, 1],
            seed: [0, TA.WIGGLE_SEED_MAX],
            hold: [0, TA.WIGGLE_HOLD_MAX],
        };
        for (const [type, fx] of Object.entries(spec)) {
            if (!TA.WIGGLE_TYPES.includes(type)) throw new Error(`Không có wiggle "${type}" (một trong: ${TA.WIGGLE_TYPES.join(', ')})`);
            if (fx === null || fx === false) { delete out[type]; continue; }
            const patch = fx === true ? {} : fx;
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(`wiggle.${type} là object, true hoặc null`);
            const allowed = WIGGLE_KEYS.common.concat(WIGGLE_KEYS[type] || []);
            for (const [key, value] of Object.entries(patch)) {
                if (!allowed.includes(key)) throw new Error(`wiggle.${type} không có khoá "${key}" (có: ${allowed.join(', ')})`);
                if (key === 'enabled' || key === 'uniform') {
                    if (typeof value !== 'boolean') throw new Error(`wiggle.${type}.${key} là true/false`);
                } else if (key === 'axis') {
                    if (!['xy', 'x', 'y'].includes(value)) throw new Error(`wiggle.${type}.axis là "xy", "x" hoặc "y"`);
                } else if (key === 'style') {
                    if (!TA.WIGGLE_STYLES.includes(value)) throw new Error(`wiggle.${type}.style là một trong: ${TA.WIGGLE_STYLES.join(', ')}`);
                } else if (key === 'easing') {
                    const easings = TA.EASING_OPTIONS.map((o) => o.value);
                    if (!easings.includes(value)) throw new Error(`wiggle.${type}.easing là một trong: ${easings.join(', ')}`);
                } else {
                    const lim = key === 'amp' ? [0, TA.WIGGLE_AMP_MAX[type]] : ranges[key];
                    if (typeof value !== 'number' || !Number.isFinite(value) || value < lim[0] || value > lim[1]) {
                        throw new Error(`wiggle.${type}.${key} phải là số trong [${lim[0]}, ${lim[1]}]`);
                    }
                }
            }
            out[type] = TA.normalizeWiggleFx(type, { ...(out[type] || {}), enabled: true, ...patch });
        }
        return Object.keys(out).length ? out : null;
    }

    // Tóm tắt wiggle của block cho kết quả lệnh (null nếu không có).
    function wiggleSummary(target) {
        const w = window.TextAnimations.normalizeWiggle(target && target.animation && target.animation.wiggle);
        if (!w) return null;
        // Kiểu chuyển động chỉ hiện khi có nghĩa: `style` khác 'smooth'; `easing`/`hold` chỉ ở 'target'
        // — kiểu Mượt (mặc định) tóm tắt y như trước khi có tuỳ chọn kiểu.
        Object.values(w).forEach((fx) => {
            if (fx.style === 'smooth') delete fx.style;
            if (fx.style !== 'target') { delete fx.easing; delete fx.hold; }
        });
        return w;
    }

    async function setAnimation(params) {
        requireEditing();
        const TA = window.TextAnimations;
        if (!TA) throw new Error('TextAnimations chưa nạp');
        return asOneUndoStep(() => {
            const sel = selectTarget(params);
            const { kind, target } = sel;
            if (kind === 'item' && !api().itemSupportsAnimation(target)) throw new Error(`Block loại "${target.type}" không có hoạt ảnh`);
            let next;
            // Wiggle: không truyền `wiggle` thì giữ nguyên; có thì gộp theo loại (mergeWiggleParam).
            const prevWiggle = target.animation && typeof target.animation === 'object' ? target.animation.wiggle : null;
            const keptWiggle = params.wiggle !== undefined ? mergeWiggleParam(prevWiggle, params.wiggle) : prevWiggle;
            if (params.combo) {
                if (params.combo === 'none') next = keptWiggle ? { in: { type: 'none' }, out: { type: 'none' } } : null;
                else {
                    next = TA.applyCombo(params.combo, params.combo_duration, 0.5);
                    if (!next) throw new Error(`Không có combo "${params.combo}" (xem catalog animations)`);
                }
                if (next && keptWiggle) next.wiggle = keptWiggle;
            } else {
                const current = TA.normalizeAnimation(target.animation) || { in: { type: 'none' }, out: { type: 'none' } };
                next = {
                    in: params.in ? { ...current.in, ...params.in } : current.in,
                    out: params.out ? { ...current.out, ...params.out } : current.out,
                };
                if (keptWiggle) next.wiggle = keptWiggle;
                for (const side of ['in', 'out']) {
                    const type = next[side].type || 'none';
                    if (!TA.EFFECT_OPTIONS.some((o) => o.value === type)) throw new Error(`Hiệu ứng "${type}" không có (xem catalog animations)`);
                }
            }
            const normalized = next ? TA.normalizeAnimation(next) : null;
            if (normalized) target.animation = normalized;
            // Wiggle đang tắt hết: vẫn giữ tham số để bật lại ở Inspector không mất.
            else if (keptWiggle) target.animation = { in: { type: 'none' }, out: { type: 'none' }, wiggle: keptWiggle };
            else delete target.animation;
            if (typeof updateSequencePreviewTransform === 'function') updateSequencePreviewTransform();
            rt().renderPreviewOverlays();
            const result = describeTarget(sel);
            if (params.wiggle !== undefined) result.wiggle = wiggleSummary(target);
            return result;
        });
    }

    // Block overlay chạm mép phải của `left` trên cùng track (đích của chuyển cảnh overlay).
    function rightNeighbor(left) {
        if (!left) return null;
        const end = (Number(left.timeline_start) || 0) + (Number(left.duration) || 0);
        return rt().getState().editingItems.find((it) => it.id !== left.id && it.track_id === left.track_id
            && Math.abs((Number(it.timeline_start) || 0) - end) < 0.05) || null;
    }

    async function setTransition(params) {
        requireEditing();
        const T = window.Transitions;
        if (!T) throw new Error('Transitions chưa nạp');
        const type = params.type === undefined ? 'fade' : params.type;
        if (type && type !== 'none' && !T.optionById(type)) throw new Error(`Không có chuyển cảnh "${type}" (xem catalog transitions)`);
        return asOneUndoStep(() => {
            let left;
            let cap;
            if (params.item_id) {
                left = api().findItem(String(params.item_id));
                if (!left) throw new Error(`Không có block id "${params.item_id}"`);
                if (!['media', 'text', 'shape'].includes(left.type)) throw new Error('Chuyển cảnh overlay chỉ cho block media/chữ/hình');
                if (isLocked(left.track_id)) throw new Error('Track đang khoá');
                const right = rightNeighbor(left);
                if (!right && type && type !== 'none') throw new Error('Block này không có block sát bên phải trên cùng track');
                cap = Math.min(T.DUR_MAX, Number(left.duration) || 0, Number(right?.duration) || T.DUR_MAX);
            } else {
                const i = Number(params.main_index);
                if (!Number.isInteger(i) || !latestTimeline?.[i]) throw new Error('Cần "main_index" hoặc "item_id"');
                if (type && type !== 'none' && !latestTimeline[i + 1]) throw new Error('Clip cuối lane chính không có clip kế tiếp để chuyển cảnh');
                if (isLocked('track_main')) throw new Error('Lane chính đang khoá');
                left = latestTimeline[i];
                cap = Math.min(T.DUR_MAX, mainClipDuration(i), latestTimeline[i + 1] ? mainClipDuration(i + 1) : T.DUR_MAX);
            }
            if (!type || type === 'none') {
                delete left.transition;
            } else {
                if (cap < T.DUR_MIN) throw new Error('Hai block quá ngắn để chuyển cảnh');
                const want = Number(params.duration) || left.transition?.duration || T.DUR_DEFAULT;
                left.transition = { type, duration: T.clampDuration(Math.min(want, cap)) };
            }
            rt().renderEditingTimeline();
            return { transition: left.transition || null };
        });
    }

    async function setColor(params) {
        requireEditing();
        const CA = window.ColorAdjust;
        if (!CA) throw new Error('ColorAdjust chưa nạp');
        return asOneUndoStep(async () => {
            const sel = selectTarget(params);
            const { kind, target } = sel;
            if (kind === 'item' && !['media', 'adjust'].includes(target.type)) throw new Error('Màu/LUT chỉ áp cho clip lane chính, block media hoặc lớp Điều chỉnh');
            const a = api();
            if (params.lut_id !== undefined) {
                const id = params.lut_id || '';
                if (id && !a.adjustLutCatalog().some((l) => l.id === id)) {
                    await rt().refreshLutCatalog?.();
                    if (!a.adjustLutCatalog().some((l) => l.id === id)) throw new Error(`Không có LUT "${id}" (xem catalog luts)`);
                }
                a.applyLutToTargets([target], id);
            }
            const values = params.params && typeof params.params === 'object' ? params.params : {};
            const defaults = CA.defaultAdjustments();
            if (Object.keys(values).length || params.lut_intensity !== undefined) {
                const adj = CA.normalize(target.adjustments);
                for (const [path, value] of Object.entries(values)) {
                    if (typeof CA.getAdjustParam(defaults, path) !== 'number') throw new Error(`Thông số màu "${path}" không có (xem catalog color_params)`);
                    CA.setAdjustParam(adj, path, Number(value));
                }
                if (params.lut_intensity !== undefined) adj.lut.intensity = Math.max(0, Math.min(100, Number(params.lut_intensity) || 0));
                const clean = CA.normalize(adj);
                if (CA.isBlank(clean) && !CA.hasAdjustKeyframes(target.keyframes)) delete target.adjustments;
                else target.adjustments = clean;
            }
            if (typeof updateSequencePreviewTransform === 'function') updateSequencePreviewTransform();
            a.refreshAdjustPanel();
            return { adjustments: target.adjustments || null };
        });
    }

    /* ---- Media ---- */

    /* Claude hay gửi "C:/a/b.mp4"; app so đường dẫn nguyên chuỗi với bản backend trả về
     * (kiểu Windows "C:\a\b.mp4"), lệch dấu gạch là "không đọc được video nào". */
    const IS_WINDOWS = /^win/i.test(navigator.platform || '');
    function pathList(paths) {
        return (Array.isArray(paths) ? paths : [paths])
            .filter((p) => typeof p === 'string' && p.trim())
            .map((p) => (IS_WINDOWS ? p.trim().replace(/\//g, '\\') : p.trim()));
    }

    function assetSummary(asset) {
        const out = flatFields(asset);
        if (nestAssetById(asset?.id) === asset) out.subsequence = true;
        return out;
    }

    async function importMedia({ paths, kind = 'media', mode = 'copy', add_to_timeline = false, start, track_id } = {}) {
        requireEditing();
        const list = pathList(paths);
        if (!list.length) throw new Error('"paths" phải là danh sách đường dẫn tuyệt đối');
        if (!['media', 'audio'].includes(kind)) throw new Error('"kind" là media (video/ảnh) hoặc audio');
        const a = api();
        const mark = historyMark();
        const before = new Set(rt().getState().editingAssets.map((x) => x.id));
        if (mode === 'link') await a.linkAssetPaths(kind, list);
        else await a.importLocalPaths(kind, list);
        /* Chỉ lấy asset ĐÚNG tệp/thư mục được yêu cầu: danh sách asset còn được app tự thêm
         * vào ở nơi khác (nguồn lane chính đăng ký trễ sau new_project), diff thuần sẽ vơ cả. */
        const wanted = list.map(pathKey);
        const added = rt().getState().editingAssets.filter((x) => {
            if (before.has(x.id)) return false;
            const src = pathKey(x.source_path || x.path);
            return wanted.some((w) => src === w || src.startsWith(`${w}/`));
        });
        if (!added.length) throw new Error('Không nhập được tệp nào (sai đường dẫn, sai loại, hoặc đã có trong dự án)');
        let items = [];
        if (add_to_timeline) {
            await Promise.all(added.map((asset) => a.ensureAssetProbed(asset)));
            let cursor = Number.isFinite(Number(start)) ? Number(start) : undefined;
            // Nhập + đặt block = MỘT bước Hoàn tác (nhập đã tự ghi mốc, phần này nhập chung vào).
            items = await asOneUndoStep(() => {
                const out = [];
                for (const asset of added) {
                    const item = a.addItemForAsset(asset, null, { start: cursor, trackId: track_id || undefined });
                    if (item) {
                        out.push(itemResult(item));
                        cursor = (Number(item.timeline_start) || 0) + (Number(item.duration) || 0);
                    }
                }
                return out;
            }, { joinSince: mark });
        }
        return { assets: added.map(assetSummary), items };
    }

    async function addAsset({ asset_id, library, start, track_id, trim_start, trim_end, duration } = {}) {
        requireEditing();
        const a = api();
        const placement = {
            start: Number.isFinite(Number(start)) ? Number(start) : undefined,
            trackId: track_id || undefined,
            duration: Number(duration) > 0 ? Number(duration) : undefined,
        };
        const trim = trimOf(trim_start, trim_end);
        if (library) {
            if (!library.category || !library.name) throw new Error('"library" cần { category, name } (xem list_assets)');
            return asOneUndoStep(async () => itemResult(await addLibraryBlock(library, placement, trim)));
        }
        const asset = a.findAsset(String(asset_id || ''));
        if (!asset) throw new Error(`Không có asset "${asset_id}" (xem list_assets)`);
        await a.ensureAssetProbed(asset);
        return asOneUndoStep(() => {
            const item = a.addItemForAsset(asset, null, placement, trim);
            if (!item) throw new Error('Không thêm được block');
            return itemResult(item);
        });
    }

    function trimOf(trimStart, trimEnd) {
        if (trimStart === undefined && trimEnd === undefined) return null;
        return { start: Number(trimStart) || 0, end: Number(trimEnd) || undefined };
    }

    async function addLibraryBlock(library, placement, trim) {
        const before = new Set(rt().getState().editingItems.map((x) => x.id));
        await api().addLibraryItem(String(library.category), String(library.name), placement, trim);
        const item = rt().getState().editingItems.find((x) => !before.has(x.id));
        if (!item) throw new Error(`Không thêm được tài nguyên thư viện "${library.category}/${library.name}" (sai tên/danh mục? xem list_assets)`);
        return item;
    }

    /* =====================================================================
     * LỆNH GỘP
     * Mỗi lệnh lẻ = 1 HTTP + 1 IPC + 1 ảnh chụp toàn bộ state (undo) + vài lượt vẽ lại; đưa 20
     * ảnh kèm keyframe bằng lệnh lẻ là hàng chục lượt gọi và vượt trần Hoàn tác (20 bước).
     * Hai lệnh dưới chạy cả lô trong MỘT bước Hoàn tác + MỘT lượt vẽ (asOneUndoStep).
     * on_error "abort" (mặc định): một mục lỗi = hoàn nguyên cả lô. "continue": mục lỗi được
     * quay lui riêng (ảnh chụp trước mục đó), các mục còn lại vẫn chạy.
     * ===================================================================== */

    const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff|wma)$/i;
    const MAX_BATCH = 500;

    function pathKey(p) {
        return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    function errorText(error) {
        return error?.message || String(error);
    }

    // Ảnh chụp để quay lui MỘT mục khi on_error = "continue" (không đụng undoStack).
    function snapshotForItem(onError) {
        return onError === 'continue' && typeof captureFullState === 'function' ? captureFullState() : null;
    }

    function rollbackItem(snapshot) {
        if (snapshot && typeof restoreHistoryState === 'function') restoreHistoryState(snapshot);
    }

    // Gộp `defaults` vào từng mục: object con (transform, keyframes, animation…) gộp một tầng.
    function withDefaults(defaults, item) {
        const out = { ...(defaults || {}) };
        for (const [key, value] of Object.entries(item || {})) {
            const base = out[key];
            out[key] = value && typeof value === 'object' && !Array.isArray(value) && base && typeof base === 'object' && !Array.isArray(base)
                ? { ...base, ...value }
                : value;
        }
        return out;
    }

    /* Nhập MỘT lượt cho mọi đường dẫn (một request mỗi loại media/audio), tệp nào đã có trong
     * dự án thì dùng lại asset sẵn có. Trả Map pathKey -> asset, và Map pathKey -> lỗi. */
    async function importForBatch(paths, mode) {
        const a = api();
        const assets = () => rt().getState().editingAssets;
        const found = new Map();
        const errors = new Map();
        const missing = [];
        for (const p of paths) {
            const key = pathKey(p);
            if (found.has(key) || missing.some((m) => pathKey(m) === key)) continue;
            const hit = assets().find((x) => pathKey(x.source_path) === key);
            if (hit) found.set(key, hit);
            else missing.push(p);
        }
        const groups = { media: missing.filter((p) => !AUDIO_EXT_RE.test(p)), audio: missing.filter((p) => AUDIO_EXT_RE.test(p)) };
        for (const [kind, list] of Object.entries(groups)) {
            if (!list.length) continue;
            try {
                if (mode === 'link') await a.linkAssetPaths(kind, list);
                else await a.importLocalPaths(kind, list);
            } catch (error) {
                list.forEach((p) => errors.set(pathKey(p), errorText(error)));
            }
        }
        for (const p of missing) {
            const key = pathKey(p);
            // Asset mới nhập: lấy bản ghi SAU CÙNG khớp đường dẫn (nhập copy có thể trùng tên cũ).
            const hit = assets().filter((x) => pathKey(x.source_path) === key).pop();
            if (hit) found.set(key, hit);
            else if (!errors.has(key)) errors.set(key, `Không nhập được "${p}" (không tồn tại hoặc sai loại tệp)`);
        }
        return { found, errors, imported: missing.length - Array.from(errors.keys()).length };
    }

    const BLOCK_EXTRA_KEYS = ['transform', 'keyframes', 'keyframe_mode', 'keyframe_time', 'volume', 'muted'];

    async function addMediaBatch({ items, mode = 'copy', gap = 0, start, track_id, defaults, on_error = 'abort' } = {}) {
        requireEditing();
        if (!Array.isArray(items) || !items.length) throw new Error('"items" phải là mảng có ít nhất 1 phần tử');
        if (items.length > MAX_BATCH) throw new Error(`Tối đa ${MAX_BATCH} mục mỗi lô`);
        if (!['copy', 'link'].includes(mode)) throw new Error('"mode" là copy | link');
        if (!['abort', 'continue'].includes(on_error)) throw new Error('"on_error" là abort | continue');
        const a = api();
        const list = items.map((item) => withDefaults(defaults, item));
        list.forEach((item, i) => {
            const sources = ['path', 'asset_id', 'library'].filter((k) => item[k] !== undefined && item[k] !== '');
            if (sources.length !== 1) throw new Error(`Mục ${i}: cần đúng MỘT trong path | asset_id | library`);
            if (item.path !== undefined) item.path = pathList(item.path)[0] || '';
        });

        const mark = historyMark();
        const { found, errors, imported } = await importForBatch(list.filter((it) => it.path).map((it) => it.path), mode);
        const assetOf = (item) => (item.path ? found.get(pathKey(item.path)) : (item.asset_id ? a.findAsset(String(item.asset_id)) : null));
        // Số đo (thời lượng/kích thước) của mọi asset: song song, NGOÀI bước Hoàn tác.
        const toProbe = Array.from(new Set(list.map(assetOf).filter(Boolean)));
        await Promise.all(toProbe.map((asset) => a.ensureAssetProbed(asset).catch(() => asset)));

        const gapSec = Math.max(0, Number(gap) || 0);
        return asOneUndoStep(async () => {
            let cursor = Number.isFinite(Number(start)) ? Number(start) : (typeof getCurrentTimelineTime === 'function' ? getCurrentTimelineTime() : 0);
            const results = [];
            for (let i = 0; i < list.length; i += 1) {
                const it = list[i];
                const snapshot = snapshotForItem(on_error);
                try {
                    let at;
                    if (typeof it.start === 'number') at = it.start;
                    else if (it.start === undefined || it.start === 'after_previous') at = i === 0 ? cursor : cursor + gapSec;
                    else throw new Error('"start" là số giây hoặc "after_previous"');
                    if (!(at >= 0)) throw new Error('"start" phải ≥ 0');
                    const placement = {
                        start: at,
                        trackId: it.track_id || track_id || undefined,
                        duration: Number(it.duration) > 0 ? Number(it.duration) : undefined,
                    };
                    const trim = trimOf(it.trim_start, it.trim_end);
                    let item;
                    if (it.library) {
                        if (!it.library.category || !it.library.name) throw new Error('"library" cần { category, name }');
                        item = await addLibraryBlock(it.library, placement, trim);
                    } else {
                        const asset = assetOf(it);
                        if (!asset) throw new Error(it.path ? (errors.get(pathKey(it.path)) || `Không có tệp "${it.path}"`) : `Không có asset "${it.asset_id}"`);
                        item = a.addItemForAsset(asset, null, placement, trim);
                    }
                    if (!item) throw new Error('Không thêm được block');
                    const extra = {};
                    BLOCK_EXTRA_KEYS.forEach((k) => { if (it[k] !== undefined) extra[k] = it[k]; });
                    if (Object.keys(extra).length) await updateBlock({ item_id: item.id, ...extra });
                    if (it.animation) await setAnimation({ item_id: item.id, ...it.animation });
                    if (it.color) await setColor({ item_id: item.id, ...it.color });
                    cursor = (Number(item.timeline_start) || 0) + (Number(item.duration) || 0);
                    results.push({
                        index: i, item_id: item.id, asset_id: item.asset_id || null, track_id: item.track_id,
                        timeline_start: round3(item.timeline_start), duration: round3(item.duration),
                    });
                } catch (error) {
                    if (on_error !== 'continue') throw new Error(`Mục ${i}: ${errorText(error)} — đã hoàn nguyên cả lô`);
                    rollbackItem(snapshot);
                    results.push({ index: i, error: errorText(error) });
                }
            }
            /* Chuyển cảnh đặt SAU khi mọi block đã nằm chỗ: nó cần block kề phải trên cùng lane.
             * Mục KHÔNG có block kề phải (mục cuối, hoặc có gap) thì bỏ qua và ghi chú — nhất là
             * khi chuyển cảnh đến từ `defaults`, áp cho cả mục cuối là chuyện bình thường. */
            for (const row of results) {
                const transition = list[row.index].transition;
                if (!transition || !row.item_id) continue;
                if (transition.type && transition.type !== 'none' && !rightNeighbor(a.findItem(row.item_id))) {
                    row.transition_skipped = 'no adjacent block on the right on the same track';
                    continue;
                }
                const snapshot = snapshotForItem(on_error);
                try {
                    await setTransition({ item_id: row.item_id, ...transition });
                } catch (error) {
                    if (on_error !== 'continue') throw new Error(`Mục ${row.index} (transition): ${errorText(error)} — đã hoàn nguyên cả lô`);
                    rollbackItem(snapshot);
                    row.transition_error = errorText(error);
                }
            }
            const created = results.filter((r) => r.item_id).length;
            if (!created) throw new Error(`Không thêm được mục nào: ${results.map((r) => `#${r.index} ${r.error}`).join('; ')}`);
            return { items: results, created, failed: results.length - created, imported_assets: imported, undo_steps: 1 };
        }, { joinSince: mark });
    }

    /* crabbycut_batch: chạy tuần tự nhiều lệnh SỬA trong một bước Hoàn tác. Tham chiếu kết quả
     * bước trước bằng chuỗi "$<chỉ số>.<đường dẫn>", ví dụ "$0.item_id", "$2.items.3.item_id". */
    const BATCHABLE = new Set([
        'add_text', 'update_block', 'apply_text_preset', 'set_animation', 'set_transition', 'set_color',
        'split', 'select', 'delete_selected', 'seek', 'add_asset', 'import_media', 'add_media_batch',
        // GeoCode trong lô: dựng XONG rồi mới sang bước sau (lệnh lẻ thì đi job — xem startGeocodeJob).
        'add_geocode',
        'add_shape',
    ]);

    function resolveRefs(value, results) {
        if (typeof value === 'string') {
            const m = /^\$(\d+)(?:\.(.+))?$/.exec(value);
            if (!m) return value;
            const step = results[Number(m[1])];
            if (!step) throw new Error(`Tham chiếu "${value}": bước ${m[1]} chưa chạy (chỉ tham chiếu được bước TRƯỚC)`);
            if (!step.ok) throw new Error(`Tham chiếu "${value}": bước ${m[1]} đã lỗi`);
            let node = step.result;
            for (const key of (m[2] ? m[2].split('.') : [])) {
                if (node === null || node === undefined || !Object.prototype.hasOwnProperty.call(Object(node), key)) {
                    throw new Error(`Tham chiếu "${value}": kết quả bước ${m[1]} không có "${key}"`);
                }
                node = node[key];
            }
            return node;
        }
        if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results));
        if (value && typeof value === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v, results);
            return out;
        }
        return value;
    }

    async function runBatch({ ops, on_error = 'abort' } = {}) {
        requireEditing();
        if (!Array.isArray(ops) || !ops.length) throw new Error('"ops" phải là mảng [{ tool, args }]');
        if (ops.length > MAX_BATCH) throw new Error(`Tối đa ${MAX_BATCH} lệnh mỗi lô`);
        if (!['abort', 'continue'].includes(on_error)) throw new Error('"on_error" là abort | continue');
        const names = ops.map((op) => String(op?.tool || op?.method || '').replace(/^crabbycut_/, ''));
        names.forEach((name, i) => {
            if (!BATCHABLE.has(name)) {
                throw new Error(`Bước ${i}: "${ops[i]?.tool || ''}" không chạy được trong batch. Được: ${Array.from(BATCHABLE).join(', ')}`);
            }
        });
        return asOneUndoStep(async () => {
            const results = [];
            for (let i = 0; i < ops.length; i += 1) {
                const snapshot = snapshotForItem(on_error);
                try {
                    const args = resolveRefs(ops[i].args || {}, results);
                    const result = await METHODS[names[i]](args);
                    results.push({ index: i, tool: names[i], ok: true, result: result === undefined ? null : result });
                } catch (error) {
                    if (on_error !== 'continue') throw new Error(`Bước ${i} (${names[i]}): ${errorText(error)} — đã hoàn nguyên cả lô`);
                    rollbackItem(snapshot);
                    results.push({ index: i, tool: names[i], ok: false, error: errorText(error) });
                }
            }
            const okCount = results.filter((r) => r.ok).length;
            return { results, ok_count: okCount, failed_count: results.length - okCount, undo_steps: 1 };
        });
    }

    async function listAssets({ library_category } = {}) {
        const state = rt().getState();
        const out = {
            project_assets: state.editingAssets.map(assetSummary),
            main_lane_sources: (typeof projectVideoLibrary !== 'undefined' ? projectVideoLibrary : []).map(flatFields),
        };
        if (library_category) {
            const resp = await fetch(`/api/library?category=${encodeURIComponent(library_category)}`);
            const data = await resp.json();
            if (!resp.ok) throw new Error(data?.detail || data?.error || `HTTP ${resp.status}`);
            out.library = (data.items || []).map(flatFields);
        }
        return out;
    }

    async function addMainVideos({ paths } = {}) {
        const list = pathList(paths);
        if (!list.length) throw new Error('"paths" phải là danh sách đường dẫn video tuyệt đối');
        if (currentStepId !== 'step4') throw new Error('Mở/tạo dự án ở bước Editing trước (new_project)');
        // Lane chính chỉ có ở timeline gốc — đang trong Subsequence thì trở ra trước (như các lệnh lane chính của UI).
        leaveSubsequences();
        const ok = await need(window.addSourcePathsToMainLane, 'addSourcePathsToMainLane')(list);
        if (!ok) throw new Error(document.getElementById('statusText')?.textContent || 'Không thêm được video vào lane chính');
        return getState();
    }

    async function newProject({ video_paths } = {}) {
        if (typeof projectDirty !== 'undefined' && projectDirty) {
            throw new Error('Dự án đang mở có thay đổi chưa lưu — hãy lưu (save_project) trước.');
        }
        // Như nút "Tạo dự án mới" (startNewProjectFromHome): ẩn Trang chủ trước, lỗi thì hiện lại.
        if (typeof hideHome === 'function') hideHome();
        try {
            await need(window.startBlankProject, 'startBlankProject')({ resetBackend: true });
        } catch (error) {
            if (typeof showHome === 'function') showHome();
            throw error;
        }
        if (Array.isArray(video_paths) && video_paths.length) return addMainVideos({ paths: video_paths });
        return getState();
    }

    /* =====================================================================
     * SUBSEQUENCE (Nest) QUA MCP — gọi đúng các hàm mà menu chuột phải / bấm đúp dùng
     * (editing-runtime.js). Hộp thoại của chúng (confirm khi bung mất hiệu ứng, prompt đổi tên)
     * được trả lời thay bằng tham số; lý do thất bại (toast / dòng trạng thái) được gửi về model.
     * Mỗi thao tác sửa = MỘT bước Hoàn tác; vào/ra chỉ là điều hướng, không ghi lịch sử.
     * ===================================================================== */

    /* Gom toast cảnh báo/lỗi trong lúc một lệnh chạy (có thể chờ lâu và chạy CHỒNG nhau): MỘT wrapper
     * dùng chung, mỗi lượt đăng ký một ngăn gom; ngăn cuối rời đi mới trả window.showToast — không
     * bao giờ "trả lại" nhầm wrapper của lượt khác. */
    const toastCollectors = new Set();
    let toastOrig = null;
    function toastWrapper(msg, opts) {
        // Chỉ cảnh báo/lỗi: toast thông tin của việc khác chạy cùng lúc không thành "lý do thất bại".
        if (opts && ['warning', 'error'].includes(opts.type)) toastCollectors.forEach((notes) => notes.push(String(msg)));
        return toastOrig.apply(this, arguments);
    }
    function collectToasts(notes) {
        if (!toastCollectors.size) {
            if (typeof window.showToast !== 'function') return () => {};
            toastOrig = window.showToast;
            window.showToast = toastWrapper;
        }
        toastCollectors.add(notes);
        return () => {
            toastCollectors.delete(notes);
            if (!toastCollectors.size && window.showToast === toastWrapper) window.showToast = toastOrig;
        };
    }

    /* Chạy fn, gom lý do thất bại (toast + dòng trạng thái). `dialogs` trả lời confirm/prompt thay
     * người dùng — CHỈ cho hàm ĐỒNG BỘ (unnestItem, renameNestAsset): thay rồi trả ngay trong cùng
     * lượt chạy, không để hộp thoại của người dùng bị tự trả lời trong lúc chờ. */
    async function withUiAnswers(fn, dialogs = null) {
        const notes = [];
        const asked = [];
        const status = document.getElementById('statusText');
        const statusBefore = (status?.textContent || '').trim();
        const stopToasts = collectToasts(notes);
        try {
            let ok;
            if (dialogs) {
                const orig = { confirm: window.confirm, prompt: window.prompt };
                window.confirm = (msg) => { asked.push(String(msg)); return !!dialogs.confirm; };
                window.prompt = (msg) => { asked.push(String(msg)); return dialogs.prompt ?? null; };
                try {
                    ok = fn();
                } finally {
                    window.confirm = orig.confirm;
                    window.prompt = orig.prompt;
                }
                if (ok && typeof ok.then === 'function') throw new Error('withUiAnswers: hộp thoại chỉ trả lời cho hàm đồng bộ');
            } else {
                ok = await fn();
            }
            const statusAfter = (status?.textContent || '').trim();
            if (!ok && statusAfter && statusAfter !== statusBefore) notes.push(statusAfter);
            return { ok, notes, asked };
        } finally {
            stopToasts();
        }
    }

    function nestRuntime() {
        const r = rt();
        if (!window.NestSequence || typeof r.createNestFromSelection !== 'function') throw new Error('Bản này chưa có Subsequence');
        return r;
    }

    // Đích là block Subsequence (item_id) hoặc row Subsequence lane chính (main_index) hoặc asset_id.
    function nestTarget({ item_id, main_index, asset_id } = {}, { allowMain = true, allowAsset = false } = {}) {
        if (item_id !== undefined && item_id !== null && item_id !== '') {
            const item = api().findItem(String(item_id));
            if (!item) throw new Error(`Không có block id "${item_id}" ở timeline đang mở${subsequenceState().in_subsequence ? ' (đang ở trong Subsequence — exit để về cấp cha)' : ''}`);
            const asset = item.type === 'media' ? nestAssetById(item.asset_id) : null;
            if (!asset) throw new Error(`Block "${item_id}" không phải Subsequence`);
            if (isLocked(item.track_id)) throw new Error(`Track ${item.track_id} đang khoá`);
            return { kind: 'item', item, asset };
        }
        if (main_index !== undefined && main_index !== null) {
            if (!allowMain) throw new Error('Thao tác này chỉ cho block Subsequence trên lane overlay ("item_id")');
            const index = Number(main_index);
            const row = Number.isInteger(index) ? latestTimeline?.[index] : null;
            if (!row) throw new Error(`Không có clip lane chính ${main_index}${subsequenceState().in_subsequence ? ' (trong Subsequence không có lane chính)' : ''}`);
            const asset = nestAssetById(row.nest_asset_id);
            if (!asset) throw new Error(`Clip lane chính ${index} không phải Subsequence`);
            return { kind: 'main', index, asset };
        }
        if (allowAsset && asset_id) {
            const asset = nestAssetById(asset_id);
            if (!asset) throw new Error(`Không có Subsequence asset "${asset_id}"`);
            return { kind: 'asset', asset };
        }
        throw new Error(`Cần "item_id" (block Subsequence)${allowMain ? ' hoặc "main_index" (row Subsequence lane chính)' : ''}${allowAsset ? ' hoặc "asset_id"' : ''}`);
    }

    function failNest(res, fallback) {
        const why = res.notes.filter(Boolean).pop();
        return new Error(why || fallback);
    }

    function nestInstances(assetId) {
        const deep = rt().projectItemsDeep?.() || rt().getState().editingItems;
        const items = deep.filter((it) => it && it.type === 'media' && String(it.asset_id) === String(assetId)).length;
        const rows = (rt().rootLatestTimeline?.() || latestTimeline || []).filter((r) => r?.nest_asset_id === assetId).length;
        return items + rows;
    }

    function nestDetails(asset) {
        return { ...nestRef(asset), duration: round3(Number(asset.duration) || 0), has_audio: !!asset.has_audio, instances: nestInstances(asset.id) };
    }

    async function subsequence(params = {}) {
        requireEditing();
        const r = nestRuntime();
        const action = String(params.action || '');
        const done = (extra) => ({ action, ...extra, ...subsequenceState() });
        switch (action) {
            case 'list': {
                const assets = rt().getState().editingAssets.filter((a) => nestAssetById(a.id) === a);
                return done({ subsequences: assets.map(nestDetails) });
            }
            case 'create': {
                const itemIds = Array.isArray(params.item_ids) ? params.item_ids.map(String) : [];
                const mainIndexes = Array.isArray(params.main_indexes) ? params.main_indexes.map(Number) : [];
                if (!itemIds.length && !mainIndexes.length) throw new Error('Cần "item_ids" và/hoặc "main_indexes" (các block gói vào Subsequence)');
                itemIds.forEach((id) => {
                    const item = api().findItem(id);
                    if (!item) throw new Error(`Không có block id "${id}"`);
                    if (isLocked(item.track_id)) throw new Error(`Track ${item.track_id} đang khoá`);
                });
                mainIndexes.forEach((i) => {
                    if (!Number.isInteger(i) || !latestTimeline?.[i]) throw new Error(`Không có clip lane chính ${i}${subsequenceState().in_subsequence ? ' (trong Subsequence không có lane chính)' : ''}`);
                });
                if (params.name !== undefined && !String(params.name).trim()) throw new Error('"name" không được rỗng');
                const before = new Set(rt().getState().editingAssets.map((a) => a.id));
                return asOneUndoStep(async () => {
                    const res = await withUiAnswers(() => r.createNestFromSelection({ itemIds, mainIndexes }));
                    if (!res.ok) throw failNest(res, 'Không tạo được Subsequence');
                    const asset = rt().getState().editingAssets.find((a) => !before.has(a.id) && nestAssetById(a.id) === a);
                    if (!asset) throw new Error('Không tìm thấy Subsequence vừa tạo');
                    if (params.name !== undefined) {
                        const renamed = await withUiAnswers(() => r.renameNestAsset(asset), { prompt: String(params.name) });
                        if (!renamed.ok) throw failNest(renamed, 'Không đổi được tên');
                    }
                    const item = rt().getState().editingItems.find((it) => it.type === 'media' && it.asset_id === asset.id);
                    const mainIndex = (latestTimeline || []).findIndex((row) => row?.nest_asset_id === asset.id);
                    return done({
                        subsequence: nestDetails(asset),
                        ...(item ? { item_id: item.id, timeline_start: round3(item.timeline_start), duration: round3(item.duration), track_id: item.track_id } : {}),
                        ...(!item && mainIndex >= 0 ? { main_index: mainIndex } : {}),
                    });
                }, { liveRender: mainIndexes.length > 0 });
            }
            case 'enter': {
                const target = nestTarget(params);
                const res = await withUiAnswers(() => (target.kind === 'item' ? r.enterNest(target.item.id) : r.enterNestFromMainRow(target.index)));
                if (!res.ok) throw failNest(res, `Không mở được "${target.asset.name}" (đã đang mở nó ở một cấp ngoài?)`);
                return done({ entered: nestRef(target.asset), note: 'Timeline commands now edit the inside of this Subsequence (get_timeline shows its content); exit to go back.' });
            }
            case 'exit': {
                if (!r.isInsideNest()) return done({ exited: 0 });
                const depth = (r.nestPath?.() || []).length;
                const levels = params.all ? depth : Math.max(1, Math.min(depth, Math.round(Number(params.levels) || 1)));
                r.exitNest(levels);
                return done({ exited: levels });
            }
            case 'rename': {
                const name = String(params.name ?? '').trim();
                if (!name) throw new Error('Cần "name" (tên mới, tối đa 60 ký tự)');
                const target = nestTarget(params, { allowAsset: true });
                return asOneUndoStep(async () => {
                    const res = await withUiAnswers(() => r.renameNestAsset(target.asset), { prompt: name });
                    if (!res.ok) throw failNest(res, 'Không đổi được tên');
                    return done({ subsequence: nestRef(target.asset) });
                });
            }
            case 'duplicate': {
                const target = nestTarget(params, { allowMain: false });
                return asOneUndoStep(async () => {
                    const res = await withUiAnswers(() => r.duplicateNestItem(target.item.id, !!params.independent));
                    if (!res.ok) throw failNest(res, 'Không nhân bản được');
                    const copy = api().findItem(rt().getState().selectedEditingItemId);
                    if (!copy || copy.id === target.item.id) throw new Error('Không tìm thấy bản sao');
                    return done({
                        item_id: copy.id, timeline_start: round3(copy.timeline_start), track_id: copy.track_id,
                        subsequence: nestDetails(nestAssetById(copy.asset_id)), shared_content: copy.asset_id === target.asset.id,
                    });
                });
            }
            case 'make_unique': {
                const target = nestTarget(params, { allowMain: false });
                return asOneUndoStep(async () => {
                    const res = await withUiAnswers(() => r.makeNestItemUnique(target.item.id));
                    if (!res.ok) throw failNest(res, 'Không tách được');
                    return done({ item_id: target.item.id, subsequence: nestDetails(nestAssetById(api().findItem(target.item.id).asset_id)) });
                });
            }
            case 'unnest': {
                const target = nestTarget(params, { allowMain: false });
                return asOneUndoStep(async () => {
                    const res = await withUiAnswers(() => r.unnestItem(target.item.id), { confirm: !!params.discard_effects, prompt: null });
                    if (!res.ok) {
                        if (res.asked.length && !params.discard_effects) {
                            throw new Error('Block Subsequence có biến đổi/hiệu ứng/màu/âm lượng riêng — bung ra sẽ mất. Truyền discard_effects: true để vẫn bung.');
                        }
                        throw failNest(res, 'Không bung được Subsequence');
                    }
                    const placed = rt().getState().selectedEditingItemIds || [];
                    return done({ item_ids: placed, count: placed.length });
                });
            }
            default:
                throw new Error('"action" là một trong: list, create, enter, exit, rename, duplicate, make_unique, unnest');
        }
    }

    /* ---- Danh mục cho model tự tra ---- */

    async function catalog({ kind } = {}) {
        const a = api();
        switch (kind) {
            case 'transitions':
                return { durations: { min: Transitions.DUR_MIN, max: Transitions.DUR_MAX, default: Transitions.DUR_DEFAULT }, options: Transitions.TRANSITION_OPTIONS.map(flatFields) };
            case 'animations':
                return {
                    effects: TextAnimations.EFFECT_OPTIONS.map(flatFields),
                    easings: TextAnimations.EASING_OPTIONS.map(flatFields),
                    combos: TextAnimations.COMBO_OPTIONS.map((c) => ({ value: c.value, label: c.label, in: c.in.type, out: c.out.type })),
                    duration_range: [0.2, 2],
                };
            case 'text_styles':
                return a.textStylePresets().map((p) => ({ id: p.id, patch: p.patch }));
            case 'text_effects':
                return a.allTextEffects().map((fx) => ({ id: fx.id, name: fx.name }));
            case 'luts': {
                const resp = await fetch('/api/color-luts');
                const data = await resp.json();
                return (data.luts || []).map(flatFields);
            }
            case 'color_params': {
                const d = ColorAdjust.defaultAdjustments();
                const paths = [];
                const walk = (node, prefix) => {
                    for (const [k, v] of Object.entries(node)) {
                        if (typeof v === 'number') paths.push(`${prefix}${k}`);
                        else if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'lut' && k !== 'mask' && k !== 'curves') walk(v, `${prefix}${k}.`);
                    }
                };
                walk(d, '');
                return { params: paths, note: 'Most values range -100..100 (effects.blur 0..100). Use set_color { params: { "basic.exposure": 20 } }.' };
            }
            case 'export_options': {
                const opts = (id) => Array.from(document.getElementById(id)?.options || []).map((o) => ({ value: o.value, label: o.textContent.trim() }));
                return {
                    resolution: opts('exportResolution'), fps: opts('exportFps'), codec: opts('exportCodec'),
                    bitrate: opts('exportBitrate'), audio_bitrate: opts('exportAudioBitrate'),
                    audio_format: opts('exportAudioFormat'), audio_file_bitrate: opts('exportAudioFileBitrate'),
                };
            }
            case 'subtitle':
                return {
                    scopes: (window.AutoSubtitlePanel?.SCOPES || []).map((s) => ({ id: s.id, label: s.label })),
                    languages: (window.AutoSubtitlePanel?.LANGUAGES || []).map((l) => ({ id: l.id, label: l.label })),
                };
            case 'library_categories':
                return ['video', 'elements', 'sfxs', 'music'];
            case 'geocode': {
                const G = window.GeoCode;
                return {
                    available: !!G?.available?.(),
                    languages: {
                        html: 'Full HTML document or fragment (CSS/JS allowed, https CDNs allowed, no file:// or localhost). CSS animations, transitions, element.animate(), requestAnimationFrame, setTimeout and Date/performance.now run on a virtual clock, so frames are exact. window.geocode = { t, frame, fps, duration, width, height, onFrame(cb) }.',
                        canvas: 'JavaScript that defines function draw(ctx, t, width, height, frame); called once per frame on a cleared canvas of exactly width x height.',
                        python: 'Python 3 run with the machine\'s real Python (needs Pillow). Define def frame(t, width, height) returning a PIL.Image (RGBA), a numpy HxWx3/HxWx4 array or a matplotlib Figure, or set a variable image. print() goes to the log. Runs with full user permissions.',
                    },
                    presets: (G?.PRESETS || []).map((p) => ({ id: p.id, label: p.label, ...(G.presetSize(p.id) || {}) })),
                    limits: { side_px: [16, 4096], fps: [1, 60], max_frames: 3600, note: 'kind video: duration * fps <= 3600 (60 s @60fps, 120 s @30fps)' },
                    default_fps: G?.defaultFps?.() || 30,
                    scale_note: 'Block scale 100% = exactly width x height pixels on the sequence.',
                };
            }
            case 'voices':
                return voicesCatalog();
            case 'text_warps':
                return {
                    warp_types: (window.TextDeform?.WARP_TYPES || []).map((w) => w.id),
                    warp: 'crabbycut_add_text warp {type, bend -100..100 (default 50), horizontal -100..100, vertical -100..100}; later: update_block style {warp_type, warp_bend, warp_h, warp_v} (warp_type "none" turns it off)',
                    path_presets: (window.TextDeform?.PATH_PRESETS || []).map((p) => ({ id: p.id, width: p.w, height: p.h, closed: p.closed })),
                    path: 'crabbycut_add_text path {preset | points [{x, y, ix?, iy?, ox?, oy?}] as 0..1 fractions of the width x height box (Pen model, Bezier handles relative to the point) + closed, width, height, x, y (box centre, px from frame centre), offset -100..100 (% of path length), align left|center|right, flip, shift (px)}; later: update_block style {path_offset, path_align, path_flip, path_shift, path_w, path_h, path_points, path_closed, path_enabled}',
                };
            case 'shapes':
                return {
                    shape_types: SHAPE_TYPES,
                    style: 'width/height px (20-4000), fill_color/stroke_color #rrggbb, stroke_width 0-100, stroke_position inside|center|outside, corner_radius (rectangle/square/triangle/trapezoid/polygon), outer_corner_radius + inner_corner_radius (star), sides 3+ (polygon), points 3+ (star)',
                    path: 'shape_type "path": path_points [{x, y, ix?, iy?, ox?, oy?, r?}] with x/y as 0..1 fractions of the width x height box, ix/iy/ox/oy Bezier handles relative to the point (same units), r corner radius px; path_closed true|false',
                };
            case 'wiggle': {
                const TA = window.TextAnimations;
                const fx = (type) => {
                    const d = TA.normalizeWiggleFx(type, {});
                    const out = {
                        enabled: { default: false, note: 'set_animation turns a type on when it is given without enabled' },
                        freq: { min: TA.WIGGLE_FREQ_MIN, max: TA.WIGGLE_FREQ_MAX, default: d.freq, unit: 'wiggles/second' },
                        amp: { min: 0, max: TA.WIGGLE_AMP_MAX[type], default: d.amp,
                            unit: { position: 'px (sequence)', scale: '% of scale', rotation: 'degrees', opacity: '% fade (dims only, range 1-amp..1)' }[type] },
                        octaves: { min: 1, max: TA.WIGGLE_OCTAVES_MAX, default: d.octaves, integer: true },
                        amp_mult: { min: 0, max: 1, default: d.amp_mult, note: 'amplitude multiplier per extra octave' },
                        seed: { min: 0, max: TA.WIGGLE_SEED_MAX, default: d.seed, integer: true, note: 'random seed; same seed = same motion' },
                        style: { options: TA.WIGGLE_STYLES, default: d.style,
                            note: 'smooth = sum of sine waves (default); target = like After Effects: every beat (freq per second) move to a new random target with `easing`, then rest for `hold`; step = jerky: hold still, jump instantly to a new point every beat' },
                        easing: { options: TA.EASING_OPTIONS.map((o) => o.value), default: d.easing, note: 'style "target" only: easing of each move to the next target' },
                        hold: { min: 0, max: TA.WIGGLE_HOLD_MAX, default: d.hold, note: 'style "target" only: fraction of each beat spent resting at the target (0 = always moving)' },
                    };
                    if (type === 'position') out.axis = { options: ['xy', 'x', 'y'], default: 'xy' };
                    if (type === 'scale') out.uniform = { default: true, note: 'false = X and Y wiggle independently' };
                    return out;
                };
                return {
                    note: 'After Effects style wiggle, continuous for the whole block, stacked on in/out animation and keyframes. Set with crabbycut_set_animation { wiggle: { <type>: {...} } } (partial: other types kept; <type>: null removes it; wiggle: "none" removes all), or inside "animation" of add_text / add_shape / add_geocode / add_media_batch. Works on text, shape, image, video, GeoCode and main lane clips (not text templates).',
                    types: Object.fromEntries(TA.WIGGLE_TYPES.map((t) => [t, fx(t)])),
                };
            }
            case 'distort': {
                const D = window.Distort;
                if (!D) throw new Error('Module Biến dạng (distort.js) chưa nạp');
                // Như dòng hướng dẫn ở Inspector: hiệu ứng nào chưa làm hình đổi cho tới khi đặt điểm/lưới/ghim.
                const notes = {
                    wave: 'Bends as soon as it is added (height != 0); speed != 0 makes the wave move on its own.',
                    bezier: 'Defaults = no change. Move the 4 vertices / 8 tangents (box fractions) to bend.',
                    mesh: 'rows/cols only split the grid; nothing bends until params.mesh (or its keyframes) moves vertices/handles.',
                    puppet: 'Nothing bends until pins exist and some pin pos differs from its rest; use 2+ pins (one pin only drags the whole shape).',
                    liquify: 'Brush settings are for painting in the UI; nothing bends until params.field holds a displacement (percent scales it, offset shifts it).',
                };
                const effects = {};
                D.TYPE_IDS.forEach((type) => {
                    const def = D.EFFECT_DEFS[type];
                    effects[type] = {
                        label: def.label,
                        note: notes[type] || '',
                        params: def.params.map((p) => {
                            const out = { key: p.key, label: p.label, kind: p.kind, keyframable: !p.noKf && p.kind !== 'pins' };
                            if (p.def !== undefined) out.default = p.def;
                            if (p.kind === 'num') Object.assign(out, { min: p.min, max: p.max, step: p.step, unit: p.unit || '' });
                            if (p.kind === 'enum') out.options = p.options.map((o) => o.id);
                            return out;
                        }),
                    };
                });
                return {
                    applies_to: 'overlay blocks of type media (image/video) and shape; not main-lane clips, text or Subsequence (Nest) blocks',
                    max_effects: D.MAX_EFFECTS,
                    effects,
                    usage: 'crabbycut_update_block distort: [{id?, type, enabled?, params?}] = the NEW ordered stack (applied top to bottom). An entry whose id matches an existing effect keeps its params/keyframes and only overwrites the params given; an entry without id is a new effect (missing params = defaults); effects left out are removed with their keyframes; [] removes all. The result lists every effect id.',
                    keyframes: 'crabbycut_update_block keyframes {"dst.<effect id>.<param>": [{t, v, e}]} for params with keyframable true; enum params hold (no interpolation). Puppet pin position: "dst.<id>.pin_<pinId>" with v [x, y].',
                    units: {
                        vec2: '[x, y] as fractions of the block box (0..1, origin top-left; values outside allowed, clamped to -50..50)',
                        bezier: '12 points: tl_vertex, tl_tangent, tr_tangent, rt_vertex, rt_tangent, rb_tangent, br_vertex, br_tangent, bl_tangent, lb_vertex, lb_tangent, lt_tangent (vertices at the corners, tangents at 1/3 and 2/3 of each edge by default)',
                        mesh: `array of (rows+1)*(cols+1)*${D.MESH_STRIDE} numbers, row-major vertices: x, y (box fractions) then left/right/up/down handles (dx, dy relative to the vertex); null = undistorted grid. Changing rows/cols resets the mesh and its keyframes.`,
                        field: `Liquify displacement: array of ${D.FIELD_LEN} numbers = (${D.FIELD_N}+1)^2 vertices x (dx, dy) in box fractions; null = none. Brushes (tool, brush_size, brush_pressure) only matter for painting in the UI.`,
                        pins: 'Puppet: pins [{id (1-24 letters/digits/-), rest: [x, y] (where the pin sits on the source), pos: [x, y] (where it is dragged to; default = rest)}], max 64. Pins pull the image like the After Effects Puppet Pin tool.',
                    },
                };
            }
            default:
                throw new Error('"kind" là một trong: transitions, animations, text_styles, text_effects, luts, color_params, export_options, subtitle, library_categories, geocode, shapes, voices, text_warps, distort');
        }
    }

    /* =====================================================================
     * JOB CHẠY LÂU — Auto Subtitle, Magic Fill, Xuất video
     * start_job trả job_id NGAY; MCP hỏi job_status định kỳ. Một lượt gọi RPC chỉ chờ 30 s,
     * mà bóc băng/xuất video có thể mất vài phút.
     * ===================================================================== */

    const jobs = new Map();
    let jobSeq = 0;

    function statusLine() {
        return (document.getElementById('statusText')?.textContent || '').trim();
    }

    function newJob(kind, extra = {}) {
        const job = {
            id: `job_${Date.now().toString(36)}_${++jobSeq}`,
            kind, state: 'running', progress: null, message: '', result: null, error: '',
            started_at: new Date().toISOString(), finished_at: '', ...extra,
        };
        jobs.set(job.id, job);
        return job;
    }

    function finish(job, state, patch = {}) {
        if (job.state !== 'running') return;
        Object.assign(job, patch, { state, finished_at: new Date().toISOString() });
        clearInterval(job._timer);
        delete job._timer;
    }

    function publicJob(job) {
        const { _timer, _cancel, ...rest } = job;
        return { ...rest, cancellable: typeof _cancel === 'function' && job.state === 'running' };
    }

    async function startAutoSubtitle(options) {
        requireEditing();
        const panel = window.AutoSubtitlePanel;
        if (!panel?.start) throw new Error('Auto Subtitle chưa nạp');
        const jobId = await panel.start({ scope: options.scope, language: options.language });
        if (!jobId) throw new Error(panel.state.lastError || 'Không bắt đầu được (timeline không có đoạn audio nào đang bật tiếng?)');
        const job = newJob('auto_subtitle', { options: { scope: panel.state.scope, language: panel.state.language } });
        job._cancel = async () => { await panel.cancel(); finish(job, 'cancelled', { message: 'Đã huỷ' }); };
        job._timer = setInterval(() => {
            const s = panel.state;
            job.progress = Number.isFinite(Number(s.job?.progress)) ? Number(s.job.progress) : job.progress;
            job.message = s.job?.message || s.job?.stage || '';
            if (s.busy) return;
            if (s.job?.state === 'cancelled') finish(job, 'cancelled');
            else if (s.lastError || s.job?.state === 'failed') finish(job, 'failed', { error: s.lastError || s.job?.error || 'Thất bại' });
            else if (s.job?.state === 'complete') {
                const sub = rt().getSubtitleState?.();
                finish(job, 'complete', { progress: 100, result: { subtitle_count: sub?.cues?.length ?? sub?.item_ids?.length ?? null, language: sub?.language || s.language } });
            }
        }, 700);
        return job;
    }

    async function startMagicFill() {
        requireEditing();
        if (typeof currentScriptMetadata === 'undefined' || !currentScriptMetadata) {
            throw new Error('Chưa có kịch bản (.md) cho dự án — nạp kịch bản ở panel Kịch bản trước (có thể dùng tool giao diện).');
        }
        const before = rt().getState().editingItems.length;
        const job = newJob('magic_fill');
        job._timer = setInterval(() => { job.message = statusLine(); }, 700);
        Promise.resolve(rt().magicFill()).then(() => {
            const created = rt().getState().editingItems.length - before;
            const message = statusLine();
            if (created > 0) finish(job, 'complete', { progress: 100, message, result: { created_items: created } });
            else finish(job, 'failed', { error: message || 'Magic Fill không tạo block nào' });
        }).catch((error) => finish(job, 'failed', { error: error?.message || String(error) }));
        return job;
    }

    function setSelect(id, value) {
        if (value === undefined || value === null) return;
        const el = document.getElementById(id);
        if (!el) throw new Error(`Không thấy ô #${id}`);
        const ok = Array.from(el.options).some((o) => o.value === String(value));
        if (!ok) throw new Error(`Giá trị "${value}" không hợp lệ cho ${id} (xem catalog export_options)`);
        el.value = String(value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setCheckbox(id, value) {
        if (value === undefined) return;
        const el = document.getElementById(id);
        if (!el) throw new Error(`Không thấy ô #${id}`);
        el.checked = !!value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function startExport(options) {
        requireEditing();
        if (typeof videoExportInFlight !== 'undefined' && videoExportInFlight) throw new Error('Đang có một lượt xuất video chạy');
        if (!options.output_path) throw new Error('"output_path" (đường dẫn tuyệt đối của tệp xuất) là bắt buộc');
        /* Xuất luôn là xuất TIMELINE CHÍNH (như openExportModal): đang sửa trong Subsequence thì
         * chốt nội dung và trở ra trước, nếu không payload là của sequence con. */
        leaveSubsequences();
        // Chuẩn bị y như bấm nút "Xuất video" mở hộp thoại, rồi điền các ô theo options.
        if (typeof syncExportFileNameFromProject === 'function') syncExportFileNameFromProject();
        if (typeof syncExportBitrateUi === 'function') syncExportBitrateUi();
        if (typeof resetExportKindUi === 'function') resetExportKindUi();
        window.resetExportProgressUi?.();
        setCheckbox('exportWantVideo', options.video);
        setCheckbox('exportWantAudio', options.audio);
        setSelect('exportResolution', options.resolution);
        setSelect('exportFps', options.fps);
        setSelect('exportCodec', options.codec);
        setSelect('exportBitrate', options.bitrate);
        if (options.bitrate_mbps !== undefined) {
            setSelect('exportBitrate', 'custom');
            const mbpsInput = document.getElementById('exportBitrateMbps');
            mbpsInput.value = String(options.bitrate_mbps);
            // Như người dùng gõ: đánh dấu "đã chạm" để số gợi ý (bitrate nguồn, đo bất đồng bộ) không đè lên.
            mbpsInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        setSelect('exportAudioBitrate', options.audio_bitrate);
        setSelect('exportAudioFormat', options.audio_format);
        setSelect('exportAudioFileBitrate', options.audio_file_bitrate);
        if (typeof syncExportKindUi === 'function') syncExportKindUi();
        const job = newJob('export', { options: { ...options } });
        job._timer = setInterval(() => {
            job.message = (document.getElementById('exportProgressText')?.textContent || statusLine()).trim();
        }, 1000);
        Promise.resolve(need(performVideoExport, 'performVideoExport')()).then(async () => {
            const box = document.getElementById('exportProgress');
            const text = (document.getElementById('exportProgressText')?.textContent || statusLine()).trim();
            const timing = window.__crabLastExportTiming;
            if (box?.dataset.state !== 'done') {
                finish(job, 'failed', { error: timing?.error || text || 'Xuất video không thành công' });
                return;
            }
            const result = { output_path: timing?.output_path || '', timing: timing ? flatFields(timing) : null };
            // Không ghi thẳng ra đĩa (backend ngoài) -> bản xuất đi đường tải blob: chỉ báo xong
            // khi lượt tải đã nằm trên đĩa, với ĐÚNG đường dẫn Chromium ghi ra.
            if (!result.output_path && timing?.download_url) {
                const saved = await waitBlobDownload(timing.download_url, EXPORT_DOWNLOAD_WAIT_MS);
                if (saved?.state !== 'completed' || !saved.path) {
                    finish(job, 'failed', { error: saved
                        ? `Đã render xong nhưng lượt lưu tệp ${saved.state === 'cancelled' ? 'bị huỷ' : 'bị gián đoạn'}`
                        : 'Đã render xong nhưng tệp chưa được lưu (hộp thoại Lưu của app đang chờ?)' });
                    return;
                }
                result.output_path = saved.path;
            }
            finish(job, 'complete', { progress: 100, message: text, result });
        }).catch((error) => finish(job, 'failed', { error: error?.message || String(error) }));
        return job;
    }

    /* LƯỢT TẢI BLOB ĐÃ XONG: url -> { state, path } (electron/main.js, watchBlobDownloads). Ghi từ
     * lúc nạp trang chứ không đợi job hỏi tới: bản xuất nhỏ tải xong trước cả khi
     * performVideoExport trả về. */
    const EXPORT_DOWNLOAD_WAIT_MS = 10 * 60 * 1000;
    const blobDownloads = new Map();
    const blobDownloadWaiters = new Map();
    env.onBlobDownloadDone?.((url, info) => {
        const waiter = blobDownloadWaiters.get(url);
        if (waiter) {
            blobDownloadWaiters.delete(url);
            waiter(info || {});
            return;
        }
        blobDownloads.set(url, info || {});
        if (blobDownloads.size > 20) blobDownloads.delete(blobDownloads.keys().next().value);
    });

    function waitBlobDownload(url, timeoutMs) {
        if (blobDownloads.has(url)) {
            const info = blobDownloads.get(url);
            blobDownloads.delete(url);
            return Promise.resolve(info);
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => { blobDownloadWaiters.delete(url); resolve(null); }, timeoutMs);
            blobDownloadWaiters.set(url, (info) => { clearTimeout(timer); resolve(info); });
        });
    }

    /* =====================================================================
     * GEOCODE (static/js/geocode.js) — dựng ảnh/video từ mã rồi đặt block lên lane Hình khối.
     * Dựng có thể mất vài chục giây nên lệnh lẻ đi JOB (start_job kind "geocode"); trong
     * crabbycut_batch thì chờ dựng xong ngay trong bước đó. Dựng nằm NGOÀI bước Hoàn tác (không
     * treo giao diện lúc dựng); đặt block + biến đổi + keyframe + hoạt ảnh = MỘT bước.
     * Mọi ngôn ngữ kể cả Python THẬT của máy (quyết định 2026-10-17) — cầu nối vốn chỉ chạy khi
     * người dùng tự bật; mỗi lần MCP chạy Python thì báo toast + ghi log.
     * ===================================================================== */

    function geocodeSpecFrom(params) {
        const G = window.GeoCode;
        if (!G?.available?.()) throw new Error('GeoCode cần bản desktop của CrabbyCut');
        let width = params.width;
        let height = params.height;
        if (params.preset) {
            const size = G.presetSize(String(params.preset));
            if (!size) throw new Error(`Không có preset "${params.preset}" (xem catalog geocode)`);
            if (width === undefined) width = size.width;
            if (height === undefined) height = size.height;
        }
        if (width === undefined || height === undefined) throw new Error('Cần "width" + "height" (px) hoặc "preset"');
        if (!['html', 'canvas', 'python'].includes(params.lang)) throw new Error('"lang" là html | canvas | python');
        return {
            lang: params.lang,
            code: String(params.code || ''),
            width: Number(width),
            height: Number(height),
            kind: params.kind === 'video' ? 'video' : 'image',
            fps: params.fps,
            duration: params.duration,
            bg: params.bg || 'transparent',
        };
    }

    /* Nhật ký dựng GeoCode gửi về model: dựng thành công thì chỉ giữ dòng cảnh báo/lỗi (mỗi khung
     * một dòng info là phí token mà model không dùng). `verbose_logs: true` lấy lại đủ 60 dòng cuối. */
    function geocodeLogsOut(logs, verbose) {
        if (verbose) return logs.slice(-60).map((l) => `${l.level}: ${l.message}`);
        return logs.filter((l) => l.level === 'error' || l.level === 'warn' || l.level === 'warning')
            .slice(-10).map((l) => `${l.level}: ${String(l.message).slice(0, 300)}`);
    }

    async function renderGeocode(params) {
        const spec = geocodeSpecFrom(params);
        if (spec.lang === 'python') {
            window.showToast?.(_t('MCP đang chạy mã Python (GeoCode)'), { type: 'info' });
            console.info('[automation] MCP chạy mã Python của GeoCode', { width: spec.width, height: spec.height, kind: spec.kind });
        }
        const logs = [];
        const geocode = await window.GeoCode.buildGeocode(spec, {
            loop: params.loop !== false,
            onLog: (entry) => { logs.push({ level: entry.level || 'info', message: entry.message }); },
        });
        return { geocode, logs };
    }

    // Đặt block đã dựng + biến đổi/keyframe/hoạt ảnh. Gọi TRONG asOneUndoStep.
    async function placeGeocode(geocode, params, start) {
        const placement = {
            start: Number.isFinite(Number(start)) ? Number(start) : undefined,
            trackId: params.track_id || undefined,
            duration: Number(params.block_duration) > 0 ? Number(params.block_duration) : undefined,
        };
        const item = api().addGeocodeItem(geocode, placement);
        if (!item) throw new Error('Không đặt được block GeoCode');
        const extra = {};
        BLOCK_EXTRA_KEYS.forEach((k) => { if (params[k] !== undefined && k !== 'volume' && k !== 'muted') extra[k] = params[k]; });
        if (Object.keys(extra).length) await updateBlock({ item_id: item.id, ...extra });
        if (params.animation) await setAnimation({ item_id: item.id, ...params.animation });
        return api().findItem(item.id);
    }

    function geocodeOut(geocode) {
        return { render_key: geocode.render_key, frame_count: geocode.frame_count, width: geocode.width, height: geocode.height, kind: geocode.kind };
    }

    async function addGeocodeNow(params = {}) {
        requireEditing();
        const { geocode, logs } = await renderGeocode(params);
        const added = await asOneUndoStep(async () => itemResult(await placeGeocode(geocode, params, params.start)));
        return { ...added, geocode: geocodeOut(geocode), logs: geocodeLogsOut(logs, params.verbose_logs === true) };
    }

    /* MẪU MÃ DÙNG CHUNG: `template` có chỗ trống {{tên}}, mỗi mục chỉ gửi `vars` — 8 block cùng
     * một bộ CSS/khung cảnh thì CSS chỉ đi MỘT lần thay vì 8 lần. Mục có `code` riêng thì dùng code
     * đó. Chỗ trống không có trong vars là lỗi (dễ quên tên biến hơn là cố ý để trống). */
    function fillGeocodeTemplate(template, vars, index) {
        const missing = new Set();
        const code = String(template).replace(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g, (all, name) => {
            if (vars && Object.prototype.hasOwnProperty.call(vars, name)) {
                const v = vars[name];
                return typeof v === 'string' ? v : JSON.stringify(v);
            }
            missing.add(name);
            return all;
        });
        if (missing.size) throw new Error(`Mục ${index}: thiếu vars cho {{${Array.from(missing).join('}}, {{')}}}`);
        return code;
    }

    /* crabbycut_add_geocode với `items`: dựng LẦN LƯỢT (ngoài bước Hoàn tác — dựng lâu), rồi đặt cả lô
     * trong MỘT bước Hoàn tác. Mục không có `start` nối tiếp mục trước (+ gap), mục đầu ở `start`
     * của lô hoặc playhead. */
    // Kiểm + điền template TRƯỚC khi tạo job: sai đặc tả/thiếu biến báo ngay ở lượt gọi.
    function prepareGeocodeItems({ items, template, defaults, on_error = 'abort' } = {}) {
        requireEditing();
        if (!Array.isArray(items) || !items.length) throw new Error('"items" phải là mảng có ít nhất 1 phần tử');
        if (items.length > 50) throw new Error('Tối đa 50 block GeoCode mỗi lô');
        if (!['abort', 'continue'].includes(on_error)) throw new Error('"on_error" là abort | continue');
        return items.map((raw, i) => {
            const it = withDefaults(defaults, raw);
            if (it.code === undefined || it.code === '') {
                if (!template) throw new Error(`Mục ${i}: cần "code" hoặc "template" + "vars"`);
                it.code = fillGeocodeTemplate(template, it.vars, i);
            }
            try { geocodeSpecFrom(it); } catch (error) { throw new Error(`Mục ${i}: ${errorText(error)}`); }
            return it;
        });
    }

    async function addGeocodeMany(options = {}, prepared = null) {
        const { start, gap = 0, on_error = 'abort', verbose_logs } = options;
        const list = prepared || prepareGeocodeItems(options);
        const built = [];
        for (let i = 0; i < list.length; i += 1) {
            try {
                // eslint-disable-next-line no-await-in-loop
                built.push(await renderGeocode(list[i]));
            } catch (error) {
                if (on_error !== 'continue') throw new Error(`Mục ${i}: ${errorText(error)}`);
                built.push({ error: errorText(error) });
            }
        }
        const gapSec = Math.max(0, Number(gap) || 0);
        return asOneUndoStep(async () => {
            let cursor = Number.isFinite(Number(start)) ? Number(start) : playhead();
            const results = [];
            for (let i = 0; i < list.length; i += 1) {
                const it = list[i];
                if (built[i].error) { results.push({ index: i, error: built[i].error }); continue; }
                const snapshot = snapshotForItem(on_error);
                try {
                    const at = typeof it.start === 'number' ? it.start : (results.some((r) => r.item_id) ? cursor + gapSec : cursor);
                    // eslint-disable-next-line no-await-in-loop
                    const item = await placeGeocode(built[i].geocode, it, at);
                    cursor = (Number(item.timeline_start) || 0) + (Number(item.duration) || 0);
                    const logs = geocodeLogsOut(built[i].logs, verbose_logs === true);
                    results.push({
                        index: i, item_id: item.id, track_id: item.track_id,
                        timeline_start: round3(item.timeline_start), duration: round3(item.duration),
                        render_key: built[i].geocode.render_key, ...(logs.length ? { logs } : {}),
                    });
                } catch (error) {
                    if (on_error !== 'continue') throw new Error(`Mục ${i}: ${errorText(error)} — đã hoàn nguyên cả lô`);
                    rollbackItem(snapshot);
                    results.push({ index: i, error: errorText(error) });
                }
            }
            const created = results.filter((r) => r.item_id).length;
            if (!created) throw new Error(`Không đặt được block nào: ${results.map((r) => `#${r.index} ${r.error}`).join('; ')}`);
            return { items: results, created, failed: results.length - created, undo_steps: 1 };
        });
    }

    /* crabbycut_update_geocode: sửa block GeoCode ĐANG CÓ mà không gửi lại cả mã — `replace`
     * [{find, with, all}] vá trên mã đang lưu trong block, hoặc `code` mới; đổi cỡ/độ dài/fps/nền
     * thì dựng lại. Giữ vị trí, biến đổi, keyframe, hoạt ảnh (updateGeocodeItem). `read: true` mà
     * không đổi gì = trả mã hiện tại để xem. */
    const GEOCODE_SPEC_KEYS = ['lang', 'width', 'height', 'kind', 'fps', 'duration', 'bg'];

    async function updateGeocode(params = {}) {
        requireEditing();
        const item = api().findItem(String(params.item_id || ''));
        if (!item || item.type !== 'geocode') throw new Error(`Không có block GeoCode id "${params.item_id}"`);
        if (isLocked(item.track_id)) throw new Error(`Track ${item.track_id} đang khoá`);
        const gc = item.geocode || {};
        const specChanged = GEOCODE_SPEC_KEYS.filter((k) => params[k] !== undefined && params[k] !== gc[k]);
        const wantsRebuild = params.code !== undefined || (Array.isArray(params.replace) && params.replace.length)
            || specChanged.length
            || ((params.kind || gc.kind) === 'video' && params.loop !== undefined && (params.loop !== false) !== (gc.loop === true));
        if (!wantsRebuild) {
            if (params.block_duration === undefined && !params.read) throw new Error('Không có gì để đổi — truyền code / replace / width / height / kind / fps / duration / bg / loop / block_duration, hoặc read: true');
            const out = { item_id: item.id };
            if (params.block_duration !== undefined) {
                await updateBlock({ item_id: item.id, duration: params.block_duration });
                out.duration = round3(api().findItem(item.id).duration);
            }
            if (params.read) out.geocode = { ...Object.fromEntries(GEOCODE_SPEC_KEYS.map((k) => [k, gc[k]])), loop: gc.loop === true, code: gc.code || '' };
            return out;
        }
        let code = params.code !== undefined ? String(params.code) : String(gc.code || '');
        (Array.isArray(params.replace) ? params.replace : []).forEach((r, i) => {
            const find = String(r?.find ?? '');
            if (!find) throw new Error(`replace[${i}]: thiếu "find"`);
            if (!code.includes(find)) throw new Error(`replace[${i}]: không thấy "${find.slice(0, 80)}" trong mã của block`);
            const repl = String(r?.with ?? '');
            code = r?.all ? code.split(find).join(repl) : code.replace(find, () => repl);
        });
        const spec = { ...Object.fromEntries(GEOCODE_SPEC_KEYS.map((k) => [k, params[k] !== undefined ? params[k] : gc[k]])), code };
        const { geocode, logs } = await renderGeocode({ ...spec, loop: params.loop !== undefined ? params.loop !== false : gc.loop === true });
        const updated = await asOneUndoStep(async () => {
            const it = api().updateGeocodeItem(item.id, geocode);
            if (!it) throw new Error('Không cập nhật được block GeoCode');
            if (params.block_duration !== undefined) await updateBlock({ item_id: item.id, duration: params.block_duration });
            return api().findItem(item.id);
        });
        const out = {
            item_id: updated.id, timeline_start: round3(updated.timeline_start), duration: round3(updated.duration),
            geocode: geocodeOut(geocode), logs: geocodeLogsOut(logs, params.verbose_logs === true),
        };
        if (params.read) out.code = geocode.code || code;
        return out;
    }

    async function startGeocodeJob(options) {
        requireEditing();
        geocodeSpecFrom(options);   // báo lỗi đặc tả NGAY, không đợi tới job
        const job = newJob('geocode', { options: { lang: options.lang, kind: options.kind || 'image', width: options.width, height: options.height, preset: options.preset } });
        addGeocodeNow(options)
            .then((result) => finish(job, 'complete', { progress: 100, message: 'Đã đặt block GeoCode', result }))
            .catch((error) => finish(job, 'failed', { error: error?.message || String(error) }));
        return job;
    }

    // Lô GeoCode (items) và sửa GeoCode: dựng lâu nên đi job như add_geocode lẻ.
    function startGeocodeTask(kind, run, summary) {
        requireEditing();
        const job = newJob(kind, { options: summary });
        run()
            .then((result) => finish(job, 'complete', { progress: 100, message: 'Xong', result }))
            .catch((error) => finish(job, 'failed', { error: errorText(error) }));
        return job;
    }

    /* =====================================================================
     * CHỮ: add_text nhận thêm kiểu chữ, biến dạng (warp) và chữ theo đường (path) — trọn một block
     * chữ trong MỘT lượt gọi, MỘT bước Hoàn tác (trước đây: add_text + update_block + ... ).
     * Warp/path là khoá phẳng trong style (static/js/text-deform.js) nên update_block { style }
     * sửa được về sau như mọi thuộc tính chữ.
     * ===================================================================== */
    function warpStyleFrom(warp) {
        if (!warp) return {};
        if (warp === 'none' || warp.type === 'none') return { warp_type: 'none' };
        const ids = (window.TextDeform?.WARP_TYPES || []).map((w) => w.id);
        if (!ids.includes(warp.type)) throw new Error(`"warp.type" là none | ${ids.join(' | ')}`);
        return {
            warp_type: warp.type,
            ...(warp.bend !== undefined ? { warp_bend: Number(warp.bend) } : {}),
            ...(warp.horizontal !== undefined ? { warp_h: Number(warp.horizontal) } : {}),
            ...(warp.vertical !== undefined ? { warp_v: Number(warp.vertical) } : {}),
        };
    }

    function pathOptionStyle(path) {
        const out = {};
        if (path.offset !== undefined) out.path_offset = Number(path.offset);
        if (path.align !== undefined) out.path_align = path.align;
        if (path.flip !== undefined) out.path_flip = !!path.flip;
        if (path.shift !== undefined) out.path_shift = Number(path.shift);
        return out;
    }

    async function addTextBlock(params = {}) {
        requireEditing();
        const { text, start, duration, track_id } = params;
        if (typeof text !== 'string' || !text.trim()) throw new Error('"text" không được rỗng');
        const placement = { start: Number.isFinite(Number(start)) ? Number(start) : undefined, trackId: track_id || undefined };
        const style = { ...(params.style && typeof params.style === 'object' ? params.style : {}), ...warpStyleFrom(params.warp) };
        const path = params.path && typeof params.path === 'object' ? params.path : null;
        if (path) {
            const presets = (window.TextDeform?.PATH_PRESETS || []).map((p) => p.id);
            if (path.preset !== undefined && !presets.includes(path.preset)) throw new Error(`"path.preset" là ${presets.join(' | ')}`);
            if (path.preset === undefined && !(Array.isArray(path.points) && path.points.length >= 2)) {
                throw new Error('"path" cần preset hoặc points (>= 2 đỉnh {x, y} theo tỉ lệ 0..1 của box width x height)');
            }
        }
        return asOneUndoStep(async () => {
            let item;
            if (path) {
                item = need(api().addPathTextItem, 'addPathTextItem')({
                    preset: path.preset, points: path.points, closed: path.closed, w: path.width, h: path.height,
                    text, duration, placement, style,
                    center: [Number(path.x) || 0, Number(path.y) || 0],
                });
                if (!item) throw new Error('Không tạo được chữ theo đường (đường không hợp lệ?)');
                // Mẫu đường mang sẵn dời/căn/phía/cỡ mặc định -> tuỳ chọn của lượt gọi vá SAU khi tạo.
                const after = {
                    ...pathOptionStyle(path),
                    ...(path.preset !== undefined && path.width !== undefined ? { path_w: Number(path.width) } : {}),
                    ...(path.preset !== undefined && path.height !== undefined ? { path_h: Number(path.height) } : {}),
                };
                if (Object.keys(after).length) api().patchTextStyle(item, after);
            } else {
                const add = need(window.EditingRuntime?.addTextItem, 'EditingRuntime.addTextItem');
                item = add(placement, { text, duration, ...(Object.keys(style).length ? { style } : {}) });
            }
            const extra = {};
            ['transform', 'keyframes', 'keyframe_mode', 'keyframe_time'].forEach((k) => { if (params[k] !== undefined) extra[k] = params[k]; });
            if (Object.keys(extra).length) await updateBlock({ item_id: item.id, ...extra });
            if (params.animation) await setAnimation({ item_id: item.id, ...params.animation });
            return itemResult(api().findItem(item.id));
        });
    }

    /* =====================================================================
     * SHAPE (Hình học › Hình dạng) — crabbycut_add_shape: một hình (trường ở cấp trên) hoặc `items`,
     * cả lô MỘT bước Hoàn tác. Style theo đúng mô hình của inspector (normalizeShapeStyle).
     * ===================================================================== */
    const SHAPE_TYPES = ['rectangle', 'square', 'circle', 'triangle', 'trapezoid', 'polygon', 'star', 'line', 'path'];
    const SHAPE_STYLE_KEYS = ['shape_type', 'width', 'height', 'fill_color', 'stroke_color', 'stroke_width',
        'stroke_position', 'corner_radius', 'outer_corner_radius', 'inner_corner_radius', 'sides', 'points',
        'path_points', 'path_closed'];

    async function addShapes({ items, defaults, start, gap = 0, track_id, on_error = 'abort', ...single } = {}) {
        requireEditing();
        const many = Array.isArray(items) && items.length > 0;
        const raw = many ? items : [single];
        if (raw.length > MAX_BATCH) throw new Error(`Tối đa ${MAX_BATCH} hình mỗi lô`);
        if (!['abort', 'continue'].includes(on_error)) throw new Error('"on_error" là abort | continue');
        const list = raw.map((it, i) => {
            const merged = withDefaults(defaults, it);
            const style = { ...(merged.style && typeof merged.style === 'object' ? merged.style : {}) };
            SHAPE_STYLE_KEYS.forEach((k) => { if (merged[k] !== undefined) style[k] = merged[k]; });
            if (!style.shape_type) style.shape_type = 'rectangle';
            if (!SHAPE_TYPES.includes(style.shape_type)) throw new Error(`Mục ${i}: "shape_type" là ${SHAPE_TYPES.join(' | ')}`);
            if (style.shape_type === 'path' && !(Array.isArray(style.path_points) && style.path_points.length >= 2)) {
                throw new Error(`Mục ${i}: shape_type "path" cần path_points (>= 2 đỉnh {x, y} theo tỉ lệ 0..1 của box)`);
            }
            return { ...merged, style };
        });
        const gapSec = Math.max(0, Number(gap) || 0);
        return asOneUndoStep(async () => {
            let cursor = Number.isFinite(Number(start)) ? Number(start) : playhead();
            const results = [];
            for (let i = 0; i < list.length; i += 1) {
                const it = list[i];
                const snapshot = snapshotForItem(on_error);
                try {
                    let at;
                    if (typeof it.start === 'number') at = it.start;
                    else if (it.start === undefined || it.start === 'after_previous') at = results.some((r) => r.item_id) ? cursor + gapSec : cursor;
                    else throw new Error('"start" là số giây hoặc "after_previous"');
                    const item = api().addShapeItemWithStyle(it.style, {
                        start: at,
                        trackId: it.track_id || track_id || undefined,
                        duration: Number(it.duration) > 0 ? Number(it.duration) : undefined,
                    });
                    if (!item) throw new Error('Không thêm được hình');
                    const extra = {};
                    BLOCK_EXTRA_KEYS.forEach((k) => { if (it[k] !== undefined && k !== 'volume' && k !== 'muted') extra[k] = it[k]; });
                    // eslint-disable-next-line no-await-in-loop
                    if (Object.keys(extra).length) await updateBlock({ item_id: item.id, ...extra });
                    // eslint-disable-next-line no-await-in-loop
                    if (it.animation) await setAnimation({ item_id: item.id, ...it.animation });
                    cursor = (Number(item.timeline_start) || 0) + (Number(item.duration) || 0);
                    results.push({
                        index: i, item_id: item.id, track_id: item.track_id,
                        timeline_start: round3(item.timeline_start), duration: round3(item.duration),
                    });
                } catch (error) {
                    if (on_error !== 'continue') throw new Error(`${many ? `Mục ${i}: ` : ''}${errorText(error)}${many ? ' — đã hoàn nguyên cả lô' : ''}`);
                    rollbackItem(snapshot);
                    results.push({ index: i, error: errorText(error) });
                }
            }
            if (!many) {
                if (results[0].error) throw new Error(results[0].error);
                const { index, ...one } = results[0];
                return one;
            }
            const created = results.filter((r) => r.item_id).length;
            if (!created) throw new Error(`Không thêm được hình nào: ${results.map((r) => `#${r.index} ${r.error}`).join('; ')}`);
            return { items: results, created, failed: results.length - created, undo_steps: 1 };
        });
    }

    /* =====================================================================
     * LỒNG TIẾNG (Âm thanh › Lồng tiếng) — crabbycut_dub: đọc văn bản / danh sách câu / câu có mốc
     * thành giọng AI rồi đặt lên lane "Lồng tiếng" (+ phụ đề khớp tiếng khi đọc văn bản). Cùng server
     * (/api/dubbing/jobs), cùng cách đặt (addDubbingAudio) và cùng phụ đề (LocalSubtitlePanel) với
     * panel. Giọng/engine bỏ trống = lựa chọn người dùng đang để ở panel. Kết quả GỌN: mốc từng câu
     * (đủ để canh hình/chữ theo lời đọc) — không trả lại chữ đã gửi.
     * ===================================================================== */
    async function ttsApi(method, path, body) {
        const resp = await fetch(`${typeof API_BASE !== 'undefined' ? API_BASE : '/api'}${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.detail || `Lỗi máy chủ (${resp.status})`);
        return data;
    }

    const DUB_TIMING = ['auto_fit', 'dynamic_shift', 'fixed_duration'];

    function dubCuesFrom(options) {
        if (Array.isArray(options.cues) && options.cues.length) {
            const cues = options.cues.map((c, i) => {
                const s = Number(c?.start);
                const e = Number(c?.end);
                const text = String(c?.text || '').trim();
                if (!(s >= 0) || !(e > s) || !text) throw new Error(`cues[${i}]: cần { start, end > start, text }`);
                return { start: s, end: e, text };
            });
            return { cues, textMode: false };
        }
        let sentences = null;
        if (Array.isArray(options.sentences) && options.sentences.length) sentences = options.sentences.map((s) => String(s || '').trim()).filter(Boolean);
        else if (typeof options.text === 'string' && options.text.trim()) {
            const split = window.DubbingPanel?.splitSentences;
            sentences = typeof split === 'function' ? split(options.text) : options.text.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
        }
        if (!sentences || !sentences.length) throw new Error('Cần "text", "sentences" hoặc "cues" (câu có mốc { start, end, text })');
        return { cues: sentences.map((text, i) => ({ start: i, end: i + 1, text })), textMode: true };
    }

    async function startDubJob(options = {}) {
        requireEditing();
        const { cues, textMode } = dubCuesFrom(options);
        const prefs = window.DubbingPanel?.state || {};
        const status = await ttsApi('GET', '/tts/status');
        if (!status?.env?.ready) throw new Error('Chưa cài thư viện lồng tiếng — người dùng bấm "Cài thư viện lồng tiếng" ở tab Âm thanh › Lồng tiếng.');
        const engineId = String(options.engine || prefs.engine || 'vieneu3');
        const engine = (status.engines || []).find((e) => e.id === engineId);
        if (!engine) throw new Error(`Không có engine "${engineId}" (xem crabbycut_catalog kind "voices")`);
        if (!engine.available) throw new Error(engine.reason || `Engine ${engineId} không chạy được trên máy này`);
        if (engine.env_id && engine.env_id !== 'main' && !engine.env_ready) throw new Error(`${engine.label || engineId} cần cài thêm thư viện riêng ở tab Lồng tiếng`);
        if (!(Number(rt().timelineDuration?.()) > 0)) throw new Error('Timeline chưa có video nào — lồng tiếng được đặt theo mốc của timeline.');
        const timing = options.timing_mode || 'auto_fit';
        if (!textMode && !DUB_TIMING.includes(timing)) throw new Error(`"timing_mode" là ${DUB_TIMING.join(' | ')}`);
        const defaultVoice = engineId === prefs.engine && prefs.voice ? prefs.voice : (engine.voices || [])[0] || '';
        const name = String(options.name || 'MCP').slice(0, 80);
        // voxcpm "giọng" là câu mô tả (panel: state.describe); engine_options mặc định như panel.
        const panelVoice = engineId === 'voxcpm' ? (prefs.describe || '') : defaultVoice;
        const body = {
            engine: engineId,
            voice: options.voice_profile ? '' : String(options.voice || panelVoice),
            speed: Number(options.speed) > 0 ? Number(options.speed) : 1,
            timing_mode: textMode ? 'sequential' : timing,
            max_speed: Number(options.max_speed) > 0 ? Number(options.max_speed) : 1.45,
            split_clips: options.split === true,
            name: `${name} (lồng tiếng)`,
            cues,
        };
        if (textMode) body.gap = Number.isFinite(Number(options.gap)) ? Math.max(0, Number(options.gap)) : 0.4;
        if (options.voice_profile) body.voice_profile = String(options.voice_profile);
        if (options.engine_options && typeof options.engine_options === 'object') body.engine_options = options.engine_options;
        else if (engineId === 'qwen3') body.engine_options = { mode: prefs.qwenMode || 'custom', language: prefs.languages?.qwen3 || 'Auto', instruct: prefs.instruct || '' };
        else if (engineId === 'chatterbox') body.engine_options = { language: prefs.languages?.chatterbox || 'en', exaggeration: prefs.exaggeration ?? 0.5, cfg_weight: prefs.cfgWeight ?? 0.5 };
        const offset = Math.max(0, Number(options.start) || 0);
        window.ModelDownloadStatus?.kick?.();
        // Tạo job SAU khi server nhận lệnh: POST lỗi thì lỗi trả thẳng về, không để job "running" mồ côi.
        const remote = await ttsApi('POST', '/dubbing/jobs', body);
        const job = newJob('dub', { options: { engine: engineId, voice: body.voice || body.voice_profile || '', sentences: cues.length, text_mode: textMode } });
        const remoteId = remote.job_id;
        job._cancel = async () => {
            try { await ttsApi('POST', `/dubbing/jobs/${encodeURIComponent(remoteId)}/cancel`); } catch (_) { /* poll sẽ thấy */ }
            finish(job, 'cancelled', { message: 'Đã huỷ' });
        };
        const place = async (result, warnings) => {
            const clips = (result.clips || []).filter((c) => Number(c.duration) > 0);
            const entries = options.split === true
                ? clips.filter((c) => c.path).map((c) => ({ path: c.path, start: c.start + offset, duration: c.duration }))
                : [{ path: result.full?.path, start: (Number(result.full?.start) || 0) + offset, duration: result.full?.duration }];
            const out = await asOneUndoStep(async () => {
                const placed = await rt().addDubbingAudio(entries, { sourceKey: `mcp:${name}`, replace: options.replace !== false });
                let subtitles = 0;
                if (textMode && options.make_subtitles !== false && window.LocalSubtitlePanel?.importCues && window.DubbingPanel?.subtitleCuesFromClips) {
                    const subs = window.DubbingPanel.subtitleCuesFromClips(clips, offset);
                    if (subs.length) subtitles = window.LocalSubtitlePanel.importCues(subs, { fileName: `${name} (lồng tiếng).srt` }).count || 0;
                }
                return { placed, subtitles };
            });
            const notes = [...(warnings || [])];
            const skipped = Object.values(result.skipped || {}).reduce((a, b) => a + (Number(b) || 0), 0);
            if (skipped) notes.push(`${skipped} câu không đọc (rỗng/chỉ ký hiệu)`);
            if (out.placed.skipped) notes.push(`${out.placed.skipped} đoạn nằm sau cuối timeline bị bỏ`);
            if (out.placed.clamped) notes.push(`${out.placed.clamped} đoạn bị cắt ở cuối timeline`);
            const s = result.summary || {};
            if (s.sped_up) notes.push(`${s.sped_up} câu được đọc nhanh hơn (tối đa ${s.max_speed}x)`);
            const fullStart = (Number(result.full?.start) || 0) + offset;
            return {
                sentences: s.count || clips.length,
                start: round3(fullStart),
                end: round3(fullStart + (Number(result.full?.duration) || 0)),
                // Mốc từng câu trên timeline (i = thứ tự câu đã gửi) — canh GeoCode/chữ theo lời đọc.
                clips: clips.map((c, i) => ({ i, start: round3(c.start + offset), end: round3(c.start + offset + c.duration) })),
                audio_blocks: out.placed.placed, replaced_blocks: out.placed.removed, subtitles: out.subtitles,
                ...(notes.length ? { notes } : {}),
            };
        };
        const poll = async () => {
            if (job.state !== 'running') return;
            try {
                const r = await ttsApi('GET', `/dubbing/jobs/${encodeURIComponent(remoteId)}`);
                if (Number(r.total) > 0) job.progress = Math.round((Number(r.done) || 0) * 100 / Number(r.total));
                job.message = r.message || r.stage || '';
                if (r.stage === 'models') window.ModelDownloadStatus?.kick?.();
                if (r.state === 'done') {
                    finish(job, 'complete', { progress: 100, message: 'Đã lồng tiếng', result: await place(r.result || {}, r.warnings) });
                    return;
                }
                if (r.state === 'error' || r.state === 'cancelled') {
                    finish(job, r.state === 'error' ? 'failed' : 'cancelled', { error: r.error || '' });
                    return;
                }
            } catch (error) {
                finish(job, 'failed', { error: errorText(error) });
                return;
            }
            setTimeout(poll, 800);
        };
        setTimeout(poll, 800);
        return job;
    }

    // catalog kind "voices": engine + giọng có sẵn + hồ sơ giọng nhân bản, gọn (chỉ tên).
    async function voicesCatalog() {
        const status = await ttsApi('GET', '/tts/status');
        const profiles = await ttsApi('GET', '/voice-profiles').then((d) => d.profiles || []).catch(() => []);
        const prefs = window.DubbingPanel?.state || {};
        return {
            ready: !!status?.env?.ready,
            default: { engine: prefs.engine || 'vieneu3', voice: prefs.voice || '' },
            engines: (status.engines || []).map((e) => ({
                id: e.id, label: e.label, available: !!e.available,
                ...(e.available ? {} : { reason: e.reason || '' }),
                ...(e.env_id && e.env_id !== 'main' && !e.env_ready ? { needs_setup: true } : {}),
                clone: !!e.clone,
                ...(Array.isArray(e.modes) ? { modes: e.modes.map((m) => m.id) } : {}),
                ...(Array.isArray(e.languages) ? { languages: e.languages } : {}),
                voices: (Array.isArray(e.voice_details) && e.voice_details.length ? e.voice_details.map((v) => v.id) : (e.voices || [])),
            })),
            profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
        };
    }

    async function startJob({ kind, options = {} } = {}) {
        let job;
        if (kind === 'auto_subtitle') job = await startAutoSubtitle(options);
        else if (kind === 'magic_fill') job = await startMagicFill(options);
        else if (kind === 'export') job = await startExport(options);
        else if (kind === 'geocode') {
            if (Array.isArray(options.items) && options.items.length) {
                const prepared = prepareGeocodeItems(options);
                job = startGeocodeTask('geocode', () => addGeocodeMany(options, prepared), { items: prepared.length });
            } else {
                job = await startGeocodeJob(options);
            }
        } else if (kind === 'geocode_update') {
            job = startGeocodeTask('geocode_update', () => updateGeocode(options), { item_id: options.item_id });
        } else if (kind === 'dub') job = await startDubJob(options);
        else throw new Error('"kind" là auto_subtitle | magic_fill | export | geocode | geocode_update | dub');
        return publicJob(job);
    }

    /* =====================================================================
     * ĐỌC GIAO DIỆN — danh sách phần tử bấm được, có mã ref để click/gõ.
     * Toạ độ trả về là CSS px; MCP server đổi sang toạ độ ảnh chụp.
     * ===================================================================== */

    let refSeq = 0;
    const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="slider"], [role="option"], [role="switch"], [contenteditable="true"], [draggable="true"], [data-action]';

    function labelOf(el) {
        const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        if (el.tagName === 'SELECT') {
            const opt = el.options[el.selectedIndex];
            return `${aria}${aria ? ' ' : ''}= "${opt ? opt.textContent.trim() : ''}"`;
        }
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            const labelEl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest('label');
            const name = aria || labelEl?.textContent?.trim() || el.placeholder || el.name || el.id || '';
            if (type === 'checkbox' || type === 'radio') return `${name} [${el.checked ? 'x' : ' '}]`;
            return `${name} = "${String(el.value || '').slice(0, 60)}"`;
        }
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        return (aria && text && !text.includes(aria) ? `${aria} — ${text}` : (aria || text)).slice(0, 80)
            || el.getAttribute('alt') || el.id || el.className?.toString().split(' ')[0] || '';
    }

    function roleOf(el) {
        const role = el.getAttribute('role');
        if (role) return role;
        if (el.tagName === 'INPUT') return `input:${(el.getAttribute('type') || 'text').toLowerCase()}`;
        return el.tagName.toLowerCase();
    }

    function visibleRect(el) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return null;
        return r;
    }

    function uiSnapshot({ query = '', limit = 200, include_covered = false, region } = {}) {
        const q = String(query || '').toLowerCase();
        const seen = new Set();
        const candidates = new Set(document.querySelectorAll(INTERACTIVE));
        // Khối/thẻ tự vẽ (block timeline, thẻ tài nguyên…) không phải <button> nhưng có con trỏ tay.
        document.querySelectorAll('body *').forEach((el) => {
            if (candidates.has(el) || el.children.length > 40) return;
            if (getComputedStyle(el).cursor !== 'pointer') return;
            const parent = el.parentElement;
            if (parent && getComputedStyle(parent).cursor === 'pointer') return;
            candidates.add(el);
        });
        const rows = [];
        for (const el of candidates) {
            if (rows.length >= limit) break;
            const r = visibleRect(el);
            if (!r) continue;
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
            if (region && (r.right < region.x || r.left > region.x + region.w || r.bottom < region.y || r.top > region.y + region.h)) continue;
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const hit = document.elementFromPoint(cx, cy);
            const covered = !(hit && (hit === el || el.contains(hit) || hit.contains(el)));
            if (covered && !include_covered) continue;
            const label = labelOf(el);
            if (q && !label.toLowerCase().includes(q) && !(el.id || '').toLowerCase().includes(q)) continue;
            if (!el.dataset.crabRef) el.dataset.crabRef = `e${++refSeq}`;
            if (seen.has(el.dataset.crabRef)) continue;
            seen.add(el.dataset.crabRef);
            rows.push({
                ref: el.dataset.crabRef,
                role: roleOf(el),
                label,
                x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
                disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
                active: el.classList.contains('is-active') || el.classList.contains('active') || el.getAttribute('aria-selected') === 'true',
                covered,
                id: el.id || undefined,
            });
        }
        rows.sort((a, b) => (a.y - b.y) || (a.x - b.x));
        return { viewport: { w: innerWidth, h: innerHeight }, focused: document.activeElement?.dataset?.crabRef || document.activeElement?.id || '', elements: rows };
    }

    function uiResolve({ ref } = {}) {
        const el = document.querySelector(`[data-crab-ref="${CSS.escape(String(ref || ''))}"]`);
        if (!el) throw new Error(`Không còn phần tử ref "${ref}" — gọi lại ui_snapshot`);
        let r = el.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            r = el.getBoundingClientRect();
        }
        if (r.width < 1 || r.height < 1) throw new Error(`Phần tử ${ref} đang ẩn`);
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: labelOf(el) };
    }

    function uiFocus({ ref } = {}) {
        const el = document.querySelector(`[data-crab-ref="${CSS.escape(String(ref || ''))}"]`);
        if (!el) throw new Error(`Không còn phần tử ref "${ref}" — gọi lại ui_snapshot`);
        el.focus();
        if (typeof el.select === 'function' && /^(INPUT|TEXTAREA)$/.test(el.tagName)) el.select();
        return { focused: ref };
    }

    Object.assign(METHODS, {
        update_block: updateBlock,
        subsequence,
        apply_text_preset: applyTextPreset,
        set_animation: setAnimation,
        set_transition: setTransition,
        set_color: setColor,
        import_media: importMedia,
        add_asset: addAsset,
        add_media_batch: addMediaBatch,
        batch: runBatch,
        add_geocode: addGeocodeNow,
        add_shape: addShapes,
        update_geocode: updateGeocode,
        list_assets: listAssets,
        add_main_videos: addMainVideos,
        new_project: newProject,
        catalog,
        start_job: startJob,
        job_status: ({ job_id } = {}) => {
            const job = jobs.get(String(job_id || ''));
            if (!job) throw new Error(`Không có job "${job_id}"`);
            return publicJob(job);
        },
        list_jobs: () => Array.from(jobs.values()).map(publicJob),
        cancel_job: async ({ job_id } = {}) => {
            const job = jobs.get(String(job_id || ''));
            if (!job) throw new Error(`Không có job "${job_id}"`);
            if (job.state !== 'running') return publicJob(job);
            if (typeof job._cancel !== 'function') throw new Error(`Job ${job.kind} không huỷ được giữa chừng`);
            await job._cancel();
            return publicJob(job);
        },
        ui_snapshot: uiSnapshot,
        ui_resolve: uiResolve,
        ui_focus: uiFocus,
    });

    env.onAutomationCall(async (method, params) => {
        if (!Object.prototype.hasOwnProperty.call(METHODS, method)) {
            throw new Error(`Lệnh không tồn tại: ${method}. Có: ${Object.keys(METHODS).join(', ')}`);
        }
        const result = await METHODS[method](params || {});
        // Qua JSON một lượt: IPC chỉ nhận dữ liệu structured-clone được, và kết quả phải đúng
        // thứ MCP server sẽ thấy.
        return result === undefined ? null : JSON.parse(JSON.stringify(result));
    });

    let lastEnabled = null;
    function syncEnabled(settings) {
        const enabled = !!settings?.general?.automationBridge;
        if (enabled === lastEnabled) return;
        lastEnabled = enabled;
        env.setAutomationEnabled(enabled).then((res) => {
            if (enabled && res && !res.enabled) {
                window.showToast?.(_t('Không bật được cầu nối điều khiển: {error}', { error: res.error || '?' }), { type: 'error' });
            }
        }).catch(() => {});
    }
    window.AppSettings?.onChange(syncEnabled);
    window.AppSettings?.ready?.().then(syncEnabled);
})();
