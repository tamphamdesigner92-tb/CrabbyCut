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
            cursor += duration;
            return row;
        });
    }

    function overlayItems() {
        const state = window.EditingRuntime?.getState?.();
        if (!state) return { tracks: [], items: [] };
        return {
            tracks: (state.editingTracks || []).map(flatFields),
            items: (state.editingItems || []).map((item) => ({
                ...flatFields(item),
                timeline_end: round3((Number(item.timeline_start) || 0) + (Number(item.duration) || 0)),
            })),
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

        add_text: ({ text, start, duration, track_id } = {}) => {
            requireEditing();
            if (typeof text !== 'string' || !text.trim()) throw new Error('"text" không được rỗng');
            const placement = { start: Number.isFinite(Number(start)) ? Number(start) : undefined, trackId: track_id || undefined };
            const add = need(window.EditingRuntime?.addTextItem, 'EditingRuntime.addTextItem');
            return asOneUndoStep(() => itemResult(add(placement, { text, duration })));
        },

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
    async function asOneUndoStep(fn, { joinSince } = {}) {
        const runtime = rt();
        const mark = joinSince || historyMark();
        const joined = !!joinSince && historyTop() !== joinSince.top;
        const endHistory = joined ? runtime.automation.suspendHistory() : runtime.beginHistoryBatch();
        const releaseRender = runtime.automation.suspendRender();
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
            const info = keyframeFieldOf(name);
            checkKeyframeTarget(info.kind, sel);
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
                a.clampItemTiming(target);
            } else {
                for (const key of ['timeline_start', 'duration', 'text', 'style', 'muted']) {
                    if (params[key] !== undefined) throw new Error(`"${key}" không áp cho clip lane chính (dùng split/trim bằng giao diện)`);
                }
            }
            // Sau cùng: biên kiểm keyframe là thời lượng block SAU khi đã đổi duration/speed.
            if (params.keyframes !== undefined) {
                changed.push(...applyKeyframes(sel, params.keyframes, { mode: params.keyframe_mode, time: params.keyframe_time }));
            }
            if (!changed.length) throw new Error('Không có gì để đổi — truyền transform/keyframes/volume/speed/timeline_start/duration/text/style/muted');
            if (typeof updateSequencePreviewTransform === 'function') updateSequencePreviewTransform();
            return { changed, block: describeTarget(sel) };
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

    async function setAnimation(params) {
        requireEditing();
        const TA = window.TextAnimations;
        if (!TA) throw new Error('TextAnimations chưa nạp');
        return asOneUndoStep(() => {
            const sel = selectTarget(params);
            const { kind, target } = sel;
            if (kind === 'item' && !api().itemSupportsAnimation(target)) throw new Error(`Block loại "${target.type}" không có hoạt ảnh`);
            let next;
            if (params.combo) {
                if (params.combo === 'none') next = null;
                else {
                    next = TA.applyCombo(params.combo, params.combo_duration, 0.5);
                    if (!next) throw new Error(`Không có combo "${params.combo}" (xem catalog animations)`);
                }
            } else {
                const current = TA.normalizeAnimation(target.animation) || { in: { type: 'none' }, out: { type: 'none' } };
                next = {
                    in: params.in ? { ...current.in, ...params.in } : current.in,
                    out: params.out ? { ...current.out, ...params.out } : current.out,
                };
                for (const side of ['in', 'out']) {
                    const type = next[side].type || 'none';
                    if (!TA.EFFECT_OPTIONS.some((o) => o.value === type)) throw new Error(`Hiệu ứng "${type}" không có (xem catalog animations)`);
                }
            }
            const normalized = next ? TA.normalizeAnimation(next) : null;
            if (normalized) target.animation = normalized;
            else delete target.animation;
            if (typeof updateSequencePreviewTransform === 'function') updateSequencePreviewTransform();
            rt().renderPreviewOverlays();
            return describeTarget(sel);
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
        return flatFields(asset);
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
            default:
                throw new Error('"kind" là một trong: transitions, animations, text_styles, text_effects, luts, color_params, export_options, subtitle, library_categories, geocode');
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
            document.getElementById('exportBitrateMbps').value = String(options.bitrate_mbps);
        }
        setSelect('exportAudioBitrate', options.audio_bitrate);
        setSelect('exportAudioFormat', options.audio_format);
        setSelect('exportAudioFileBitrate', options.audio_file_bitrate);
        if (typeof syncExportKindUi === 'function') syncExportKindUi();
        const job = newJob('export', { options: { ...options } });
        job._timer = setInterval(() => {
            job.message = (document.getElementById('exportProgressText')?.textContent || statusLine()).trim();
        }, 1000);
        Promise.resolve(need(performVideoExport, 'performVideoExport')()).then(() => {
            const box = document.getElementById('exportProgress');
            const text = (document.getElementById('exportProgressText')?.textContent || statusLine()).trim();
            const timing = window.__crabLastExportTiming;
            if (box?.dataset.state === 'done') finish(job, 'complete', { progress: 100, message: text, result: { output_path: options.output_path, timing: timing ? flatFields(timing) : null } });
            else finish(job, 'failed', { error: timing?.error || text || 'Xuất video không thành công' });
        }).catch((error) => finish(job, 'failed', { error: error?.message || String(error) }));
        return job;
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

    async function addGeocodeNow(params = {}) {
        requireEditing();
        const spec = geocodeSpecFrom(params);
        if (spec.lang === 'python') {
            window.showToast?.(_t('MCP đang chạy mã Python (GeoCode)'), { type: 'info' });
            console.info('[automation] MCP chạy mã Python của GeoCode', { width: spec.width, height: spec.height, kind: spec.kind });
        }
        const logs = [];
        const geocode = await window.GeoCode.buildGeocode(spec, {
            loop: params.loop !== false,
            onLog: (entry) => { logs.push(`${entry.level || 'info'}: ${entry.message}`); },
        });
        const added = await asOneUndoStep(async () => {
            const placement = {
                start: Number.isFinite(Number(params.start)) ? Number(params.start) : undefined,
                trackId: params.track_id || undefined,
                duration: Number(params.block_duration) > 0 ? Number(params.block_duration) : undefined,
            };
            const item = api().addGeocodeItem(geocode, placement);
            if (!item) throw new Error('Không đặt được block GeoCode');
            const extra = {};
            BLOCK_EXTRA_KEYS.forEach((k) => { if (params[k] !== undefined && k !== 'volume' && k !== 'muted') extra[k] = params[k]; });
            if (Object.keys(extra).length) await updateBlock({ item_id: item.id, ...extra });
            if (params.animation) await setAnimation({ item_id: item.id, ...params.animation });
            return itemResult(api().findItem(item.id));
        });
        return {
            ...added,
            geocode: { render_key: geocode.render_key, frame_count: geocode.frame_count, width: geocode.width, height: geocode.height, kind: geocode.kind },
            logs: logs.slice(-60),
        };
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

    async function startJob({ kind, options = {} } = {}) {
        let job;
        if (kind === 'auto_subtitle') job = await startAutoSubtitle(options);
        else if (kind === 'magic_fill') job = await startMagicFill(options);
        else if (kind === 'export') job = await startExport(options);
        else if (kind === 'geocode') job = await startGeocodeJob(options);
        else throw new Error('"kind" là auto_subtitle | magic_fill | export | geocode');
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
        apply_text_preset: applyTextPreset,
        set_animation: setAnimation,
        set_transition: setTransition,
        set_color: setColor,
        import_media: importMedia,
        add_asset: addAsset,
        add_media_batch: addMediaBatch,
        batch: runBatch,
        add_geocode: addGeocodeNow,
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
