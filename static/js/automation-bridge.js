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
