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
            const item = need(window.EditingRuntime?.addTextItem, 'EditingRuntime.addTextItem')(placement, { text, duration });
            return flatFields(item);
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

    /* Một bước hoàn tác cho cả lệnh; kết thúc batch kể cả khi lỗi (bỏ sót là hỏng undo về sau).
     * Lệnh LỖI giữa chừng thì quay lui về ảnh chụp vừa ghi: không để lại thay đổi dở dang, cũng
     * không để lại một bước Hoàn tác rỗng. */
    async function asOneUndoStep(fn) {
        const depth = typeof undoStack !== 'undefined' ? undoStack.length : -1;
        const end = rt().beginHistoryBatch();
        try {
            return await fn();
        } catch (error) {
            end();
            if (depth >= 0 && undoStack.length > depth && typeof restoreHistoryState === 'function') {
                restoreHistoryState(undoStack.pop());
                if (typeof updateUndoRedoButtons === 'function') updateUndoRedoButtons();
            }
            throw error;
        } finally {
            end();
            rt().renderAll();
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
        if (kind === 'main') return { main_index: index, ...flatFields(target), transform: target.transform || null, animation: target.animation || null, transition: target.transition || null };
        return { ...flatFields(target), transform: target.transform || null, style: target.style || null, animation: target.animation || null, transition: target.transition || null };
    }

    function mainClipDuration(index) {
        return clipSequenceDuration(latestTimeline[index]);
    }

    const TRANSFORM_FIELDS = ['position_x', 'position_y', 'scale', 'rotation', 'opacity', 'flip_x', 'flip_y'];

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
            if (!changed.length) throw new Error('Không có gì để đổi — truyền transform/volume/speed/timeline_start/duration/text/style/muted');
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
                const end = (Number(left.timeline_start) || 0) + (Number(left.duration) || 0);
                const items = rt().getState().editingItems;
                const right = items.find((it) => it.id !== left.id && it.track_id === left.track_id
                    && Math.abs((Number(it.timeline_start) || 0) - end) < 0.05);
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
        const before = new Set(rt().getState().editingAssets.map((x) => x.id));
        if (mode === 'link') await a.linkAssetPaths(kind, list);
        else await a.importLocalPaths(kind, list);
        /* Chỉ lấy asset ĐÚNG tệp/thư mục được yêu cầu: danh sách asset còn được app tự thêm
         * vào ở nơi khác (nguồn lane chính đăng ký trễ sau new_project), diff thuần sẽ vơ cả. */
        const key = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
        const wanted = list.map(key);
        const added = rt().getState().editingAssets.filter((x) => {
            if (before.has(x.id)) return false;
            const src = key(x.source_path || x.path);
            return wanted.some((w) => src === w || src.startsWith(`${w.replace(/\/$/, '')}/`));
        });
        if (!added.length) throw new Error('Không nhập được tệp nào (sai đường dẫn, sai loại, hoặc đã có trong dự án)');
        let items = [];
        if (add_to_timeline) {
            let cursor = Number.isFinite(Number(start)) ? Number(start) : undefined;
            items = await asOneUndoStep(async () => {
                const out = [];
                for (const asset of added) {
                    await a.ensureAssetProbed(asset);
                    const item = a.addItemForAsset(asset, null, { start: cursor, trackId: track_id || undefined });
                    if (item) {
                        out.push(flatFields(item));
                        cursor = (Number(item.timeline_start) || 0) + (Number(item.duration) || 0);
                    }
                }
                return out;
            });
        }
        return { assets: added.map(assetSummary), items };
    }

    async function addAsset({ asset_id, library, start, track_id, trim_start, trim_end } = {}) {
        requireEditing();
        const a = api();
        const placement = { start: Number.isFinite(Number(start)) ? Number(start) : undefined, trackId: track_id || undefined };
        const trim = (trim_start !== undefined || trim_end !== undefined)
            ? { start: Number(trim_start) || 0, end: Number(trim_end) || undefined }
            : null;
        if (library) {
            if (!library.category || !library.name) throw new Error('"library" cần { category, name } (xem list_assets)');
            const before = new Set(rt().getState().editingItems.map((x) => x.id));
            await a.addLibraryItem(String(library.category), String(library.name), placement, trim);
            const item = rt().getState().editingItems.find((x) => !before.has(x.id));
            if (!item) throw new Error('Không thêm được tài nguyên thư viện (sai tên/danh mục?)');
            return flatFields(item);
        }
        const asset = a.findAsset(String(asset_id || ''));
        if (!asset) throw new Error(`Không có asset "${asset_id}" (xem list_assets)`);
        return asOneUndoStep(async () => {
            await a.ensureAssetProbed(asset);
            const item = a.addItemForAsset(asset, null, placement, trim);
            if (!item) throw new Error('Không thêm được block');
            return flatFields(item);
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
            default:
                throw new Error('"kind" là một trong: transitions, animations, text_styles, text_effects, luts, color_params, export_options, subtitle, library_categories');
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

    async function startJob({ kind, options = {} } = {}) {
        let job;
        if (kind === 'auto_subtitle') job = await startAutoSubtitle(options);
        else if (kind === 'magic_fill') job = await startMagicFill(options);
        else if (kind === 'export') job = await startExport(options);
        else throw new Error('"kind" là auto_subtitle | magic_fill | export');
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
