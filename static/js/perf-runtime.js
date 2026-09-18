(function () {
    const defaultFlags = {
        perf_scheduler: true,
        virtualized_transcript: true,
        timeline_pointer_capture: true,
        pixi_viewport_culling: true,
        ruler_dom_overlay: true,
        trim_debug: false,
    };

    function parseFlagValue(value, fallback) {
        if (value === undefined || value === null || value === '') return fallback;
        if (typeof value === 'boolean') return value;
        const normalized = String(value).trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
        return fallback;
    }

    function readFlags() {
        let merged = { ...defaultFlags };

        if (window.APP_PERF_FLAGS && typeof window.APP_PERF_FLAGS === 'object') {
            merged = { ...merged, ...window.APP_PERF_FLAGS };
        }

        try {
            const raw = localStorage.getItem('app_perf_flags');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    merged = { ...merged, ...parsed };
                }
            }
        } catch (_) {
            // ignore malformed storage data
        }

        const query = new URLSearchParams(window.location.search);
        Object.keys(defaultFlags).forEach((key) => {
            if (query.has(key)) {
                merged[key] = parseFlagValue(query.get(key), merged[key]);
            }
        });

        Object.keys(defaultFlags).forEach((key) => {
            merged[key] = parseFlagValue(merged[key], defaultFlags[key]);
        });

        return merged;
    }

    const flags = readFlags();
    window.APP_PERF_FLAGS = flags;

    if (!Object.values(flags).some(Boolean)) {
        return;
    }

    const timelineOuter = document.getElementById('timelineTrackOuter');
    const timelineTrack = document.getElementById('timelineTrack');
    const segmentsTrack = document.getElementById('segmentsTrack');
    const timelinePixiRoot = document.getElementById('timelinePixiRoot');
    const transcriptContainer = document.getElementById('transcriptContainer');
    const timeDisplay = document.getElementById('timeDisplay');
    const rulerLabelLayer = document.getElementById('timeRulerLabels');

    if (!timelineOuter || !timelineTrack || !segmentsTrack || !transcriptContainer || !timeDisplay) {
        return;
    }

    const perfMetrics = {
        longTaskCount: 0,
        frameTimes: [],
        maxFrameSamples: 900,
        markFrameDelta(delta) {
            if (!Number.isFinite(delta) || delta <= 0) return;
            this.frameTimes.push(delta);
            if (this.frameTimes.length > this.maxFrameSamples) this.frameTimes.shift();
        },
        getSnapshot() {
            const samples = this.frameTimes.slice().sort((a, b) => a - b);
            const getP = (percent) => {
                if (samples.length === 0) return 0;
                const idx = Math.min(samples.length - 1, Math.max(0, Math.floor((percent / 100) * (samples.length - 1))));
                return samples[idx];
            };
            return {
                longTaskCount: this.longTaskCount,
                samples: samples.length,
                p50FrameMs: getP(50),
                p90FrameMs: getP(90),
                p99FrameMs: getP(99),
            };
        },
        reset() {
            this.longTaskCount = 0;
            this.frameTimes = [];
        },
    };

    if (typeof PerformanceObserver !== 'undefined') {
        try {
            const observer = new PerformanceObserver((list) => {
                perfMetrics.longTaskCount += list.getEntries().length;
            });
            observer.observe({ entryTypes: ['longtask'] });
        } catch (_) {
            // entry type may not be supported
        }
    }
    window.APP_PERF_METRICS = perfMetrics;

    const baseUpdateTimelineLayout = updateTimelineLayout;
    const baseRenderWordLevelTranscript = renderWordLevelTranscript;
    const baseSyncScriptHighlightAndTrim = syncScriptHighlightAndTrim;

    function markMappedSelectionDirty() {
        playbackState.mappedSelectionDirty = true;
    }

    const playbackState = {
        mappedSelectionDirty: true,
        mappedSelectedChunks: [],
        mappedSpans: [],
        jumpCursor: 0,
        jumpChunksRef: null,
    };

    /* Hai mốc cho việc PHÁT XEM TRƯỚC BẢN CẮT (Preview Cuts) — xem getMappedPlaybackSpans.
       JOIN_EPS: hai chunk cách nhau dưới ngần này coi như LIỀN NHAU. ~1 khung ở 25fps;
       mép chunk do ASR sinh nên hiếm khi trùng nhau tuyệt đối tới từng chữ số. */
    const SPAN_JOIN_EPS = 0.04;
    let timelineDataVersion = 0;

    function getMappedSelectedChunks() {
        if (!playbackState.mappedSelectionDirty) {
            return playbackState.mappedSelectedChunks;
        }
        playbackState.mappedSelectionDirty = false;
        playbackState.mappedSelectedChunks = (globalMappedChunks || []).filter((chunk) => chunk.is_selected);
        return playbackState.mappedSelectedChunks;
    }

    /* ĐOẠN PHÁT LIÊN TỤC cho Preview Cuts — gộp các chunk đã chọn NẰM LIỀN NHAU làm một.
     *
     * VÌ SAO CẦN: `runJumpCutLogic` tua (`video.currentTime = ...`) ở MỖI mép chunk. Nhưng
     * ở Match Script người dùng thường chọn nhiều chunk LIÊN TIẾP, mà hai chunk liên tiếp
     * thì `chunk[i].end === chunk[i+1].start` — lệnh tua đó nhảy tới đúng chỗ video đang
     * đứng. Một lệnh tua VÔ NGHĨA, nhưng trình duyệt vẫn phải xả sạch hàng đợi khung đã
     * giải mã và dựng lại từ đầu. Với chunk cỡ câu, đó là một lần xả mỗi 1-2 giây.
     *
     * Đo được (2026-09-06): Preview Cuts rớt 10,5-30,0% khung hình, trong khi Play thường
     * trên nguồn HQ nặng gấp 18 lần chỉ rớt 0,0%. Chênh lệch nằm trọn ở các lệnh tua này.
     *
     * Gộp lại KHÔNG đổi hành vi một chút nào: chỉ bỏ những lệnh tua nhảy-tại-chỗ, còn mọi
     * khe đã bỏ chọn vẫn bị nhảy qua y như cũ. Preview Cuts vẫn phát đúng bản đã cắt.
     *
     * Dùng chung cờ bẩn với getMappedSelectedChunks() nên đổi lựa chọn là tự dựng lại. Nhận
     * dạng mảng ổn định giữa các lượt gọi — `jumpChunksRef` dựa vào điều đó. */
    function getMappedPlaybackSpans() {
        const chunks = getMappedSelectedChunks();
        if (playbackState.mappedSpansSource === chunks) return playbackState.mappedSpans;
        const spans = [];
        for (const chunk of chunks) {
            const start = Number(chunk.start);
            const end = Number(chunk.end);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
            const last = spans[spans.length - 1];
            if (last && start - last.end <= SPAN_JOIN_EPS) {
                // Liền ngay sau đoạn trước (hoặc chồng lấn) -> nối dài, đừng cắt thêm mép.
                if (end > last.end) last.end = end;
            } else {
                spans.push({ start, end });
            }
        }
        playbackState.mappedSpans = spans;
        playbackState.mappedSpansSource = chunks;
        return spans;
    }

    function getActiveChunksForPlayback() {
        if (currentMode === 'MAPPED') return getMappedPlaybackSpans();
        return latestTimeline || [];
    }

    const viewportFrameState = {
        left: -1,
        width: -1,
        height: -1,
    };

    function syncViewportLayersFrame() {
        const nextLeft = Math.max(0, Math.round(timelineOuter.scrollLeft));
        const nextWidth = Math.max(1, Math.round(timelineOuter.clientWidth));
        const nextHeight = Math.max(1, Math.round(timelineTrack.clientHeight));

        if (
            nextLeft === viewportFrameState.left
            && nextWidth === viewportFrameState.width
            && nextHeight === viewportFrameState.height
        ) {
            return;
        }

        viewportFrameState.left = nextLeft;
        viewportFrameState.width = nextWidth;
        viewportFrameState.height = nextHeight;

        if (timelinePixiRoot) {
            timelinePixiRoot.style.left = `${nextLeft}px`;
            timelinePixiRoot.style.width = `${nextWidth}px`;
            timelinePixiRoot.style.height = `${nextHeight}px`;
        }

        if (rulerLabelLayer) {
            rulerLabelLayer.style.left = `${nextLeft}px`;
            rulerLabelLayer.style.width = `${nextWidth}px`;
        }
    }

    function applyRendererViewport() {
        syncViewportLayersFrame();
        if (!timelineRenderer || typeof timelineRenderer.setViewport !== 'function') return;
        const start = timelineOuter.scrollLeft;
        const defaultEnd = start + timelineOuter.clientWidth;
        const fullTrackEnd = start + Math.max(timelineOuter.clientWidth, timelineTrack.clientWidth || 0);
        timelineRenderer.setViewport({
            start,
            end: flags.pixi_viewport_culling ? defaultEnd : fullTrackEnd,
        });
    }

    const dirty = {
        timelineGeometry: false,
        timelineVisual: false,
        transcriptViewport: false,
        transcriptActive: false,
        trimPreview: false,
    };

    let framePending = false;
    let lastFlushTs = 0;

    function markDirty(flag) {
        if (flag && Object.prototype.hasOwnProperty.call(dirty, flag)) {
            dirty[flag] = true;
        }
        if (!flags.perf_scheduler) return;
        if (framePending) return;
        framePending = true;
        requestAnimationFrame(flushFrame);
    }

    window.markDirty = markDirty;

    function flushFrame(ts) {
        framePending = false;

        if (lastFlushTs > 0) {
            perfMetrics.markFrameDelta(ts - lastFlushTs);
        }
        lastFlushTs = ts;

        const needsTimeline = dirty.timelineGeometry || dirty.timelineVisual;
        const needsTranscript = dirty.transcriptViewport || dirty.transcriptActive || dirty.trimPreview;

        if (needsTimeline) {
            applyRendererViewport();
            baseUpdateTimelineLayout();
        }

        if (needsTranscript) {
            syncScriptHighlightAndTrim();
        }

        dirty.timelineGeometry = false;
        dirty.timelineVisual = false;
        dirty.transcriptViewport = false;
        dirty.transcriptActive = false;
        dirty.trimPreview = false;
    }

    if (flags.perf_scheduler) {
        updateTimelineLayout = function () {
            markDirty('timelineGeometry');
            markDirty('timelineVisual');
        };
    }

    // -----------------------------
    // Ruler DOM overlay (sharp text)
    // -----------------------------
    const rulerLabelPool = [];
    let lastRulerDomSignature = '';

    function getRulerSteps() {
        let majorStep = 10;
        let minorStep = 1;
        if (zoomScale > 150) {
            majorStep = 2;
            minorStep = 0.5;
        } else if (zoomScale > 60) {
            majorStep = 5;
            minorStep = 1;
        } else if (zoomScale < 20) {
            majorStep = 60;
            minorStep = 10;
        }
        return { majorStep, minorStep };
    }

    function getRulerLabelNode(index) {
        if (!rulerLabelLayer) return null;
        if (!rulerLabelPool[index]) {
            const el = document.createElement('div');
            el.className = 'time-ruler-label';
            rulerLabelLayer.appendChild(el);
            rulerLabelPool[index] = el;
        }
        return rulerLabelPool[index];
    }

    function hideUnusedRulerLabels(fromIndex) {
        for (let i = fromIndex; i < rulerLabelPool.length; i += 1) {
            if (rulerLabelPool[i]) {
                rulerLabelPool[i].style.display = 'none';
            }
        }
    }

    function renderRulerDomLabels() {
        if (!flags.ruler_dom_overlay || !rulerLabelLayer || videoDuration === 0) {
            hideUnusedRulerLabels(0);
            lastRulerDomSignature = '';
            return;
        }

        const timelineDuration = getTimelineDuration();
        const sidePadding = getTimelineSidePaddingPx();
        const { majorStep, minorStep } = getRulerSteps();
        const viewStart = timelineOuter.scrollLeft;
        const viewEnd = viewStart + timelineOuter.clientWidth;

        const signature = [
            Math.round(timelineDuration * 100),
            Math.round(zoomScale * 100),
            Math.round(sidePadding),
            Math.round(viewStart),
            Math.round(viewEnd),
            majorStep,
            minorStep,
        ].join('|');
        if (signature === lastRulerDomSignature) {
            return;
        }
        lastRulerDomSignature = signature;

        let labelCount = 0;
        const tickCount = Math.max(0, Math.floor((timelineDuration / minorStep) + 0.5));
        for (let tickIndex = 0; tickIndex <= tickCount; tickIndex += 1) {
            const t = tickIndex * minorStep;
            const majorRatio = t / majorStep;
            const isMajor = Math.abs(majorRatio - Math.round(majorRatio)) < 0.001;
            if (!isMajor) continue;

            const worldX = sidePadding + (t * zoomScale);
            if (worldX < viewStart - 40 || worldX > viewEnd + 40) continue;

            const localX = Math.round(worldX - viewStart + 4);
            const node = getRulerLabelNode(labelCount);
            if (!node) break;
            node.style.display = 'block';
            node.style.left = `${localX}px`;
            const txt = formatTime(t);
            if (node.textContent !== txt) {
                node.textContent = txt;
            }
            labelCount += 1;
        }

        hideUnusedRulerLabels(labelCount);
    }

    drawRuler = function () {
        if (videoDuration === 0) {
            hideUnusedRulerLabels(0);
            return;
        }
        if (!timelineRenderer) return;

        applyRendererViewport();
        timelineRenderer.renderRuler({
            timelineDuration: getTimelineDuration(),
            zoomScale,
            sidePadding: getTimelineSidePaddingPx(),
            formatTime,
            showLabels: !flags.ruler_dom_overlay,
        });

        renderRulerDomLabels();
    };

    /* ⚠️ BẢN NÀY GHI ĐÈ bản cùng tên trong index.html, và nó MỚI LÀ BẢN CHẠY THẬT (đo được:
     * 56/56 lượt gán scrollLeft trong 8 giây phát đều đi qua đây). Sửa chốt chặn cuộn ở
     * index.html mà quên tệp này thì KHÔNG có tác dụng gì — đã mất một lượt sửa vì chuyện đó. */
    scrollTimelineToCurrentTime = function () {
        if (videoDuration === 0) return;
        const centerOffset = timelineOuter.clientWidth / 2;
        const timelineTime = getCurrentTimelineTime();
        const nextScrollLeft = Math.max(0, timelineTimeToPx(timelineTime) - centerOffset);
        /* Ngưỡng 0,5px GIỮ NGUYÊN như bản gốc: timeline vẫn trôi mượt từng pixel.
         * Đã thử nâng lên 4px để giảm số lượt cuộn (53,3 fps · rớt 2,0% so với 22,3 fps · 17,1%),
         * nhưng đó chỉ là cách gián tiếp để bớt vẽ lại SÓNG ÂM. Sửa thẳng chỗ đó
         * (xem WAVE_MARGIN_PX trong index.html) cho 59,9 fps · rớt 0% MÀ VẪN giữ ngưỡng 0,5px
         * — đo cả hai trên cùng phiên. Nên không đánh đổi độ mượt của timeline nữa. */
        if (Math.abs(timelineOuter.scrollLeft - nextScrollLeft) < 0.5) return;
        isProgrammaticScroll = true;
        timelineOuter.scrollLeft = nextScrollLeft;
        /* GHI LẠI VỊ TRÍ VỪA CUỘN — xem chú thích dài ở handler 'scroll' trong index.html.
         * Tóm tắt: cờ `isProgrammaticScroll` bên dưới được xoá bằng setTimeout 50 ms, nhưng
         * Chromium bắn 'scroll' bất đồng bộ; khi một khung kéo dài hơn 50 ms (76 ms trên máy
         * RTX 4070 với cửa sổ phóng to) thì cờ đã tắt trước lúc sự kiện tới, và handler tưởng
         * lượt cuộn của CHÍNH ta là người dùng kéo -> tua video lùi ~0,14 s -> xả bộ giải mã
         * -> khung sau càng chậm -> tự khuếch đại. So VỊ TRÍ thì đúng ở mọi nhịp khung.
         * Đọc ngược lại thay vì lưu `nextScrollLeft`: trình duyệt kẹp và làm tròn theo DPI. */
        lastProgrammaticScrollLeft = timelineOuter.scrollLeft;
        window.clearTimeout(timelineScrollStopTimer);
        timelineScrollStopTimer = window.setTimeout(() => {
            isProgrammaticScroll = false;
        }, 50);
    };

    scrollToPlayhead = function () {
        if (videoDuration === 0) return;
        const centerOffset = timelineOuter.clientWidth / 2;
        const timelineTime = getCurrentTimelineTime();
        const targetLeft = timelineTimeToPx(timelineTime) - centerOffset;
        const tucThi = !!(video && !video.paused);
        isProgrammaticScroll = true;
        timelineOuter.scrollTo({
            left: Math.max(0, targetLeft),
            behavior: tucThi ? 'auto' : 'smooth',
        });
        /* Chỉ ghi mốc vị trí cho nhánh TỨC THÌ (lúc đang phát). Nhánh 'smooth' chạy hoạt ảnh
         * nhiều khung với vị trí trung gian, không có MỘT vị trí nào để so — đặt -1 để tắt
         * phép so vị trí và rơi về cờ thời gian (180 ms), vốn đủ vì lúc đó video đang DỪNG:
         * một lệnh tua thừa ở đó không kéo theo vòng xả-bộ-giải-mã như lúc phát. */
        lastProgrammaticScrollLeft = tucThi ? timelineOuter.scrollLeft : -1;
        window.clearTimeout(timelineScrollStopTimer);
        timelineScrollStopTimer = window.setTimeout(() => {
            isProgrammaticScroll = false;
        }, video && !video.paused ? 60 : 180);
    };

    // -----------------------------
    // Timeline hit-layer pooling + pointer drag state machine
    // -----------------------------
    const hitPool = [];
    let lastRenderedTimelineData = [];
    const trimSession = {
        id: 0,
        phase: 'idle', // idle | active
        pointerId: null,
        pointerType: null,
        startedAt: 0,
        lastClientX: 0,
        captureTarget: null,
        capturedPointerId: null,
        rafToken: 0,
        watchdogTimer: null,
    };
    const trimMetrics = {
        staleRefCount: 0,
        forcedAbortCount: 0,
        missedPointerUpRecoveredCount: 0,
        lastAbortReason: '',
        lastFinishReason: '',
    };
    const TRIM_WATCHDOG_MS = 1400;

    function isTrimActive() {
        return trimSession.phase === 'active';
    }

    function bumpTrimRafToken() {
        trimSession.rafToken += 1;
        return trimSession.rafToken;
    }

    function clearTrimWatchdog() {
        if (trimSession.watchdogTimer != null) {
            window.clearTimeout(trimSession.watchdogTimer);
            trimSession.watchdogTimer = null;
        }
    }

    function armTrimWatchdog(reason = '') {
        clearTrimWatchdog();
        if (!isTrimActive()) return;
        trimSession.watchdogTimer = window.setTimeout(() => {
            abortTrimSession(`watchdog_${reason || 'timeout'}`, true);
        }, TRIM_WATCHDOG_MS);
    }

    function releaseTrimPointerCapture() {
        const target = trimSession.captureTarget;
        const pointerId = trimSession.capturedPointerId;
        trimSession.captureTarget = null;
        trimSession.capturedPointerId = null;
        if (!target || pointerId == null) return;
        if (typeof target.releasePointerCapture !== 'function') return;
        try {
            if (typeof target.hasPointerCapture === 'function') {
                if (target.hasPointerCapture(pointerId)) {
                    target.releasePointerCapture(pointerId);
                }
            } else {
                target.releasePointerCapture(pointerId);
            }
        } catch (_) {
            // ignore release failure
        }
    }

    function getHitPoolStats() {
        let hidden = 0;
        let detached = 0;
        for (let i = 0; i < hitPool.length; i += 1) {
            const node = hitPool[i];
            if (!node) continue;
            if (!node.isConnected) detached += 1;
            if (node.style.display === 'none') hidden += 1;
        }
        return {
            hitPoolSize: hitPool.length,
            hiddenHitNodes: hidden,
            detachedHitNodes: detached,
        };
    }

    function getTrimDebugSnapshot() {
        const now = performance.now();
        const poolStats = getHitPoolStats();
        return {
            activeTrimAgeMs: isTrimActive() ? Math.max(0, now - trimSession.startedAt) : 0,
            activeSessionId: isTrimActive() ? trimSession.id : null,
            pointerId: trimSession.pointerId,
            pointerType: trimSession.pointerType,
            staleRefCount: trimMetrics.staleRefCount,
            forcedAbortCount: trimMetrics.forcedAbortCount,
            missedPointerUpRecoveredCount: trimMetrics.missedPointerUpRecoveredCount,
            lastAbortReason: trimMetrics.lastAbortReason,
            lastFinishReason: trimMetrics.lastFinishReason,
            ...poolStats,
        };
    }

    if (flags.trim_debug) {
        window.APP_TRIM_DEBUG = {
            getSnapshot: getTrimDebugSnapshot,
            reset() {
                trimMetrics.staleRefCount = 0;
                trimMetrics.forcedAbortCount = 0;
                trimMetrics.missedPointerUpRecoveredCount = 0;
                trimMetrics.lastAbortReason = '';
                trimMetrics.lastFinishReason = '';
            },
        };
    }

    function ensureHitNode(slot) {
        const pooled = hitPool[slot];
        if (pooled) {
            // Giai đoạn Editing xoá sạch #segmentsTrack (renderEditingTimeline /
            // restoreStandardTimeline dùng innerHTML=''), khiến node trong pool bị tách
            // khỏi DOM nhưng vẫn còn trong hitPool -> lần vẽ sau không có block bắt chuột
            // nào cả, mất trim handle + dao cắt ở RAW/MAPPED. Gắn lại nếu đã bị tách.
            if (!pooled.isConnected && segmentsTrack) segmentsTrack.appendChild(pooled);
            return pooled;
        }

        const block = document.createElement('div');
        block.className = 'timeline-hit-block';

        const leftHandle = document.createElement('div');
        leftHandle.className = 'resize-handle left';
        leftHandle.dataset.direction = 'LEFT';

        const rightHandle = document.createElement('div');
        rightHandle.className = 'resize-handle right';
        rightHandle.dataset.direction = 'RIGHT';

        const bindHandle = (handle) => {
            const downHandler = (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                const parent = handle.parentElement;
                const idx = Number(parent?.dataset.index);
                if (!Number.isFinite(idx)) return;
                const item = lastRenderedTimelineData[idx];
                if (!item) return;

                e.preventDefault();
                e.stopPropagation();

                if (isTrimActive() || currentResizingItem) {
                    abortTrimSession('restart_session', false);
                }

                startResize(e, item, handle.dataset.direction, parent);
                trimSession.id += 1;
                trimSession.phase = 'active';
                trimSession.pointerId = (e.pointerId !== undefined) ? e.pointerId : 'mouse';
                trimSession.pointerType = e.pointerType || 'mouse';
                trimSession.startedAt = performance.now();
                trimSession.lastClientX = Number.isFinite(e.clientX) ? e.clientX : 0;
                window.__APP_ACTIVE_TRIM_POINTER = true;

                if (
                    flags.timeline_pointer_capture
                    && e.pointerId !== undefined
                    && typeof handle.setPointerCapture === 'function'
                ) {
                    try {
                        handle.setPointerCapture(e.pointerId);
                        trimSession.captureTarget = handle;
                        trimSession.capturedPointerId = e.pointerId;
                    } catch (_) {
                        // ignore capture failure
                    }
                }
                armTrimWatchdog('down');
            };

            handle.addEventListener('pointerdown', downHandler);
            if (!window.PointerEvent) {
                handle.addEventListener('mousedown', downHandler);
            }
        };

        bindHandle(leftHandle);
        bindHandle(rightHandle);

        block.appendChild(leftHandle);
        block.appendChild(rightHandle);
        segmentsTrack.appendChild(block);
        hitPool[slot] = block;
        return block;
    }

    drawTimelineSegments = function (data, mode) {
        if (videoDuration === 0) {
            for (let i = 0; i < hitPool.length; i += 1) {
                hitPool[i].style.display = 'none';
            }
            return;
        }

        const timelineData = Array.isArray(data) ? data : [];
        lastRenderedTimelineData = timelineData;

        applyRendererViewport();
        if (timelineRenderer) {
            timelineRenderer.renderSegments({
                data: timelineData,
                mode,
                zoomScale,
                sidePadding: getTimelineSidePaddingPx(),
                dataVersion: timelineDataVersion,
                selectedIndex: currentMode === 'FINAL' ? selectedTimelineClipIndex : -1,
            });
        }

        let used = 0;
        let currentLeftSeq = getTimelineSidePaddingPx();

        for (let index = 0; index < timelineData.length; index += 1) {
            const item = timelineData[index];
            const blockWidth = (item.end - item.start) * zoomScale;
            if (blockWidth <= 0) continue;

            const leftPos = (mode === 'FINAL') ? currentLeftSeq : timelineTimeToPx(item.start);
            currentLeftSeq += blockWidth;

            const node = ensureHitNode(used);
            node.style.display = 'block';
            node.style.left = `${leftPos}px`;
            node.style.width = `${blockWidth}px`;
            node.dataset.index = String(index);
            node.dataset.mode = mode;
            node.classList.toggle('clip-tone-a', (mode === 'FINAL' || (mode === 'MAPPED' && item.is_selected)) && index % 2 === 0);
            node.classList.toggle('clip-tone-b', (mode === 'FINAL' || (mode === 'MAPPED' && item.is_selected)) && index % 2 === 1);
            node.classList.toggle('is-clickable', mode === 'FINAL');
            node.classList.toggle('is-trimmable', mode === 'RAW' || mode === 'MAPPED');
            node.classList.toggle('is-selected', mode === 'FINAL' && typeof isTimelineClipSelected === 'function' && isTimelineClipSelected(index));

            const showHandles = (mode === 'RAW' || mode === 'MAPPED');
            node.children[0].style.display = showHandles ? 'block' : 'none';
            node.children[1].style.display = showHandles ? 'block' : 'none';

            used += 1;
        }

        for (let i = used; i < hitPool.length; i += 1) {
            hitPool[i].style.display = 'none';
            hitPool[i].classList.remove('is-clickable', 'is-selected');
        }
    };

    startResize = function (e, item, direction, blockEl) {
        e.stopPropagation();
        if (typeof e.preventDefault === 'function') e.preventDefault();
        saveHistoryState();
        isDraggingPlayhead = false;
        isTimelineSeeking = false;
        bumpTrimRafToken();
        currentResizingItem = { data: item, dom: blockEl };
        resizeDirection = direction;
        resizeStartX = e.clientX;
        resizeStartVal = direction === 'LEFT' ? item.start : item.end;
    };

    let lastTrimPreviewAt = 0;
    handleResizeDrag = function (e) {
        if (resizeTicking || !currentResizingItem) return;
        const sessionIdSnapshot = trimSession.id;
        const rafTokenSnapshot = trimSession.rafToken;
        resizeTicking = true;
        const resizeCtx = currentResizingItem;
        const startXSnapshot = resizeStartX;
        const startValSnapshot = resizeStartVal;
        const directionSnapshot = resizeDirection;
        const clientXSnapshot = Number.isFinite(e.clientX) ? e.clientX : trimSession.lastClientX;

        requestAnimationFrame(() => {
            try {
                if (!isTrimActive()) return;
                if (trimSession.id !== sessionIdSnapshot) return;
                if (trimSession.rafToken !== rafTokenSnapshot) return;
                if (!currentResizingItem || currentResizingItem !== resizeCtx) return;
                const item = resizeCtx.data;
                const dom = resizeCtx.dom;
                if (!item || !dom || !dom.isConnected) {
                    trimMetrics.staleRefCount += 1;
                    abortTrimSession('stale_dom_ref', true);
                    return;
                }

                const pointerX = Number.isFinite(clientXSnapshot) ? clientXSnapshot : startXSnapshot;
                const deltaX = pointerX - startXSnapshot;
                const deltaSec = deltaX / zoomScale;
                // Ngưỡng bắt dính theo PIXEL (matchTrimSnapSeconds ở index.html). Trước đây
                // đọc window.MATCH_TRIM_SNAP_SECONDS — vốn là `const` trong script inline nên
                // KHÔNG hề nằm trên window -> luôn rơi về 0.2s cố định, quá rộng khi zoom cao
                // và quá hẹp khi zoom thấp.
                const snapThresholdSec = typeof window.matchTrimSnapSeconds === 'function'
                    ? window.matchTrimSnapSeconds()
                    : 10 / Math.max(1, Number(zoomScale) || 100);
                const playheadTime = video.currentTime;

                if (directionSnapshot === 'LEFT') {
                    let newStart = startValSnapshot + deltaSec;
                    if (typeof snapTrimBoundary === 'function') {
                        newStart = snapTrimBoundary(newStart, item, 'LEFT', snapThresholdSec);
                    } else if (isSnappingEnabled && Math.abs(newStart - playheadTime) <= snapThresholdSec) {
                        newStart = playheadTime;
                    }
                    if (newStart < 0) newStart = 0;
                    if (newStart >= item.end - 0.1) newStart = item.end - 0.1;
                    item.start = newStart;
                } else {
                    let newEnd = startValSnapshot + deltaSec;
                    if (typeof snapTrimBoundary === 'function') {
                        newEnd = snapTrimBoundary(newEnd, item, 'RIGHT', snapThresholdSec);
                    } else if (isSnappingEnabled && Math.abs(newEnd - playheadTime) <= snapThresholdSec) {
                        newEnd = playheadTime;
                    }
                    if (newEnd <= item.start + 0.1) newEnd = item.start + 0.1;
                    if (newEnd > videoDuration) newEnd = videoDuration;
                    item.end = newEnd;
                }

                const leftPos = timelineTimeToPx(item.start);
                const blockWidth = (item.end - item.start) * zoomScale;
                dom.style.left = `${leftPos}px`;
                dom.style.width = `${blockWidth}px`;

                applyRendererViewport();
                if (timelineRenderer) {
                    timelineRenderer.updateSegment({
                        index: Number(dom.dataset.index),
                        item,
                        mode: currentMode,
                        zoomScale,
                        sidePadding: getTimelineSidePaddingPx(),
                    });
                }

                const now = performance.now();
                if (now - lastTrimPreviewAt >= 100) {
                    lastTrimPreviewAt = now;
                    markDirty('trimPreview');
                }
                armTrimWatchdog('move');
            } finally {
                resizeTicking = false;
            }
        });
    };

    function rebuildAllWordsCacheIfNeeded() {
        if (allWordsCache.length > 0) return;
        if (!globalRawSegments || globalRawSegments.length === 0) return;

        allWordsCache = [];
        for (let i = 0; i < globalRawSegments.length; i += 1) {
            const seg = globalRawSegments[i];
            if (seg.sub_segments) {
                allWordsCache.push(...seg.sub_segments);
            }
        }
    }

    function commitCurrentTrimSelection() {
        window.__APP_ACTIVE_TRIM_POINTER = false;
        resizeTicking = false;
        clearTrimWatchdog();
        if (!currentResizingItem) return;
        const item = currentResizingItem.data;
        if (typeof snapTrimItemToAdjacentBoundaries === 'function') {
            snapTrimItemToAdjacentBoundaries(item);
        }

        if (currentMode === 'MAPPED' || currentMode === 'RAW') {
            rebuildAllWordsCacheIfNeeded();
            const overlappingWords = allWordsCache.filter((w) => (
                (w.start >= item.start - 0.05 && w.start <= item.end + 0.05)
                || (w.end >= item.start - 0.05 && w.end <= item.end + 0.05)
            ));

            if (overlappingWords.length > 0) {
                item.sub_segments = overlappingWords;
                item.text = overlappingWords.map((w) => w.text).join(' ');
            }

            const dataToRender = currentMode === 'MAPPED' ? globalMappedChunks : globalRawSegments;
            renderWordLevelTranscript(dataToRender, currentMode);
        } else {
            markDirty('transcriptActive');
            markDirty('timelineVisual');
        }

        currentResizingItem = null;
    }

    function resetTrimSessionState() {
        trimSession.phase = 'idle';
        trimSession.pointerId = null;
        trimSession.pointerType = null;
        trimSession.startedAt = 0;
        trimSession.lastClientX = 0;
        clearTrimWatchdog();
        releaseTrimPointerCapture();
    }

    function finishTrimSession(reason = 'finish') {
        if (!isTrimActive() && !currentResizingItem) return;
        trimMetrics.lastFinishReason = reason;
        bumpTrimRafToken();
        resetTrimSessionState();
        window.__APP_ACTIVE_TRIM_POINTER = false;
        commitCurrentTrimSelection();
    }

    function abortTrimSession(reason = 'abort', commit = true) {
        if (!isTrimActive() && !currentResizingItem) return;
        trimMetrics.forcedAbortCount += 1;
        trimMetrics.lastAbortReason = reason;
        bumpTrimRafToken();
        resetTrimSessionState();
        window.__APP_ACTIVE_TRIM_POINTER = false;
        resizeTicking = false;
        if (commit) {
            commitCurrentTrimSelection();
        } else {
            currentResizingItem = null;
        }
    }

    function isCurrentTrimPointer(e) {
        if (!isTrimActive()) return false;
        if (!e) return false;
        if (trimSession.pointerId === 'mouse') return true;
        return e.pointerId === trimSession.pointerId;
    }

    function updateTrimSession(e) {
        if (!isTrimActive()) return;
        if (!isCurrentTrimPointer(e)) return;

        if (Number.isFinite(e.clientX)) {
            trimSession.lastClientX = e.clientX;
        }

        // Missed pointerup recovery
        if (typeof e.buttons === 'number' && e.buttons === 0) {
            trimMetrics.missedPointerUpRecoveredCount += 1;
            finishTrimSession('buttons_zero_recover');
            return;
        }

        if (e.cancelable) e.preventDefault();
        handleResizeDrag(e);
    }

    function endTrimSessionFromPointer(e, reason = 'pointerup') {
        if (!isTrimActive()) return;
        // ưu tiên pointer hiện tại, nhưng không kẹt nếu id mismatch bất thường.
        if (!isCurrentTrimPointer(e) && e && e.pointerType && e.pointerType !== 'mouse') {
            finishTrimSession(`${reason}_fallback`);
            return;
        }
        finishTrimSession(reason);
    }

    window.addEventListener('pointermove', (e) => {
        updateTrimSession(e);
    }, { passive: false });

    window.addEventListener('pointerup', (e) => {
        endTrimSessionFromPointer(e, 'pointerup');
    }, { passive: true });

    window.addEventListener('pointercancel', () => {
        abortTrimSession('pointercancel', true);
    }, { passive: true });

    window.addEventListener('blur', () => {
        abortTrimSession('window_blur', true);
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            abortTrimSession('visibility_hidden', true);
        }
    });

    window.addEventListener('pagehide', () => {
        abortTrimSession('pagehide', true);
    });

    window.addEventListener('mousemove', (e) => {
        if (!isTrimActive()) return;
        if (e.cancelable) e.preventDefault();
        e.stopImmediatePropagation();
    }, { capture: true, passive: false });

    window.addEventListener('mouseup', (e) => {
        if (!isTrimActive()) return;
        if (e.cancelable) e.preventDefault();
        e.stopImmediatePropagation();
    }, { capture: true, passive: false });

    window.addEventListener('contextmenu', (e) => {
        if (!isTrimActive()) return;
        e.preventDefault();
    });

    // -----------------------------
    // Virtualized transcript
    // -----------------------------
    const virtualState = {
        enabled: !!flags.virtualized_transcript,
        data: [],
        mode: 'RAW',
        estimatedHeight: 92,
        overscanRows: 6,
        heights: new Map(),
        offsets: [0],
        totalHeight: 0,
        nodes: new Map(),
        root: null,
        layer: null,
        layoutDirty: true,
        needsMeasureAll: true,
        containerWidth: 0,
        activeIndex: -1,
        lastAutoScrollAt: 0,
        sortedRanges: [],
        finalSequenceRanges: [],
        pendingEnsureIndex: -1,
    };

    function ensureWords(item) {
        if (item.sub_segments && item.sub_segments.length > 0) {
            return item.sub_segments;
        }

        const rawWords = (item.text || '').trim().split(/\s+/).filter(Boolean);
        if (rawWords.length === 0) {
            item.sub_segments = [];
            return item.sub_segments;
        }

        const totalDur = Math.max(0.01, (item.end - item.start));
        const wDur = totalDur / rawWords.length;
        item.sub_segments = rawWords.map((word, i) => ({
            start: item.start + (i * wDur),
            end: item.start + ((i + 1) * wDur),
            text: word,
        }));
        return item.sub_segments;
    }

    function ensureVirtualStructure() {
        const hasLiveStructure = virtualState.root
            && virtualState.layer
            && virtualState.root.isConnected
            && virtualState.root.parentNode === transcriptContainer
            && virtualState.layer.parentNode === virtualState.root;
        if (hasLiveStructure) return;

        transcriptContainer.innerHTML = '';
        transcriptContainer.classList.add('perf-virtualized');
        virtualState.nodes.forEach((node) => node.remove());
        virtualState.nodes.clear();

        const root = document.createElement('div');
        root.className = 'transcript-virtual-root';

        const layer = document.createElement('div');
        layer.className = 'transcript-virtual-layer';

        root.appendChild(layer);
        transcriptContainer.appendChild(root);

        virtualState.root = root;
        virtualState.layer = layer;
    }

    function getEstimatedHeight(index) {
        return virtualState.heights.get(index) || virtualState.estimatedHeight;
    }

    function rebuildOffsets() {
        const offsets = new Array(virtualState.data.length + 1);
        offsets[0] = 0;
        for (let i = 0; i < virtualState.data.length; i += 1) {
            offsets[i + 1] = offsets[i] + getEstimatedHeight(i);
        }
        virtualState.offsets = offsets;
        virtualState.totalHeight = offsets[offsets.length - 1] || 0;
        virtualState.layoutDirty = false;

        if (virtualState.root) {
            virtualState.root.style.height = `${Math.max(1, virtualState.totalHeight)}px`;
        }
    }

    function findIndexByOffset(offset) {
        const arr = virtualState.offsets;
        let lo = 0;
        let hi = arr.length - 1;
        let best = 0;

        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] <= offset) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        return Math.min(virtualState.data.length - 1, Math.max(0, best));
    }

    function getVisibleRange() {
        const len = virtualState.data.length;
        if (len === 0) return { start: 0, end: 0 };

        const top = Math.max(0, transcriptContainer.scrollTop);
        const height = Math.max(1, transcriptContainer.clientHeight);
        const overscanPx = virtualState.estimatedHeight * virtualState.overscanRows;

        const startOffset = Math.max(0, top - overscanPx);
        const endOffset = Math.min(virtualState.totalHeight, top + height + overscanPx);

        const start = findIndexByOffset(startOffset);
        const end = Math.min(len, findIndexByOffset(endOffset) + 2);
        return { start, end };
    }

    function createParagraphNode(index) {
        const item = virtualState.data[index];
        if (virtualState.mode === 'FINAL' && typeof ensureClipTransform === 'function') {
            ensureClipTransform(item);
        }
        const pDiv = document.createElement('div');
        const useTone = virtualState.mode === 'FINAL' || (virtualState.mode === 'MAPPED' && item.is_selected);
        const selectedClass = virtualState.mode === 'FINAL'
            && typeof isTimelineClipSelected === 'function'
            && isTimelineClipSelected(index)
            ? 'inspector-selected-para'
            : '';
        pDiv.className = `t-paragraph ${virtualState.mode === 'MAPPED' && item.is_selected ? 'ai-selected-para' : ''} ${selectedClass} ${useTone ? (index % 2 === 0 ? 'clip-tone-a' : 'clip-tone-b') : ''}`;
        pDiv.dataset.pindex = String(index);

        const meta = document.createElement('div');
        meta.className = 'paragraph-meta';
        meta.innerHTML = `<span>⏱️ ${item.start.toFixed(2)}s - ${item.end.toFixed(2)}s</span> <span>Đoạn #${index + 1}</span>`;
        pDiv.appendChild(meta);

        const wrap = document.createElement('div');
        wrap.className = 'word-wrap';
        const wordSpans = [];

        const words = ensureWords(item);
        for (let i = 0; i < words.length; i += 1) {
            const w = words[i];
            const span = document.createElement('span');
            span.className = 'word-item';
            span.innerText = w.text;
            span.dataset.start = String(w.start);
            span.dataset.end = String(w.end);
            wrap.appendChild(span);
            wrap.appendChild(document.createTextNode(' '));
            wordSpans.push(span);
        }
        pDiv.appendChild(wrap);
        pDiv.__wordSpans = wordSpans;

        if (virtualState.mode === 'FINAL') {
            pDiv.setAttribute('draggable', 'true');
            pDiv.style.cursor = 'grab';
        }

        return pDiv;
    }

    function measureParagraphNode(index, node) {
        const measured = Math.ceil(node.getBoundingClientRect().height);
        const prevHeight = virtualState.heights.get(index);
        if (!prevHeight || Math.abs(prevHeight - measured) > 1) {
            virtualState.heights.set(index, measured);
            virtualState.layoutDirty = true;
        }
    }

    function renderVirtualizedRange() {
        if (!virtualState.enabled) return;
        ensureVirtualStructure();

        const width = transcriptContainer.clientWidth;
        if (width !== virtualState.containerWidth) {
            virtualState.containerWidth = width;
            virtualState.needsMeasureAll = true;
            virtualState.layoutDirty = true;
        }

        if (virtualState.layoutDirty) {
            rebuildOffsets();
        }

        const { start, end } = getVisibleRange();
        const active = new Set();

        for (let i = start; i < end; i += 1) {
            active.add(i);
            let node = virtualState.nodes.get(i);
            const isNewNode = !node;
            if (!node) {
                node = createParagraphNode(i);
                virtualState.nodes.set(i, node);
                virtualState.layer.appendChild(node);
            }

            node.style.position = 'absolute';
            node.style.left = '0';
            node.style.right = '0';
            node.style.top = `${virtualState.offsets[i]}px`;

            if (isNewNode || virtualState.needsMeasureAll) {
                measureParagraphNode(i, node);
            }
        }

        virtualState.nodes.forEach((node, index) => {
            if (!active.has(index)) {
                node.remove();
                virtualState.nodes.delete(index);
            }
        });

        if (virtualState.needsMeasureAll) {
            virtualState.needsMeasureAll = false;
        }

        if (virtualState.layoutDirty) {
            rebuildOffsets();
            requestAnimationFrame(() => {
                markDirty('transcriptViewport');
            });
        }

        if (virtualState.pendingEnsureIndex >= 0) {
            const idx = virtualState.pendingEnsureIndex;
            const node = virtualState.nodes.get(idx);
            if (node) {
                virtualState.pendingEnsureIndex = -1;
            }
        }
    }

    function rebuildSortedRanges() {
        virtualState.sortedRanges = virtualState.data
            .map((item, index) => ({ index, start: Number(item.start) || 0, end: Number(item.end) || 0 }))
            .sort((a, b) => a.start - b.start);
    }

    function rebuildFinalSequenceRanges() {
        let seqCursor = 0;
        virtualState.finalSequenceRanges = virtualState.data.map((item, index) => {
            const dur = Math.max(0, (Number(item.end) || 0) - (Number(item.start) || 0));
            const range = {
                index,
                seqStart: seqCursor,
                seqEnd: seqCursor + dur,
                videoStart: Number(item.start) || 0,
                videoEnd: Number(item.end) || 0,
            };
            seqCursor += dur;
            return range;
        });
    }

    function findActiveIndexRawMapped(time) {
        const ranges = virtualState.sortedRanges;
        if (!ranges || ranges.length === 0) return -1;

        let lo = 0;
        let hi = ranges.length - 1;
        let best = -1;

        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (ranges[mid].start <= time) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        if (best === -1) return -1;
        for (let i = Math.max(0, best - 3); i <= Math.min(ranges.length - 1, best + 3); i += 1) {
            const range = ranges[i];
            if (time >= range.start && time <= range.end) return range.index;
        }
        return -1;
    }

    function findActiveIndexFinal() {
        const ranges = virtualState.finalSequenceRanges;
        if (!ranges || ranges.length === 0) return -1;

        const currentVideoTime = video.currentTime;
        const epsilon = 0.05;

        // Ưu tiên sequence cursor khi đang playback FINAL để luôn bám đúng thứ tự reorder.
        const cursor = Math.max(0, Math.min(getActiveSequenceClipIndex(), ranges.length - 1));
        const cursorRange = ranges[cursor];
        if (
            cursorRange
            && currentVideoTime >= cursorRange.videoStart - epsilon
            && currentVideoTime <= cursorRange.videoEnd + epsilon
        ) {
            return cursorRange.index;
        }

        // Dò gần cursor trước (độ trễ jump giữa chunk có thể vài frame).
        for (let offset = 1; offset <= 3; offset += 1) {
            const leftIdx = cursor - offset;
            if (leftIdx >= 0) {
                const left = ranges[leftIdx];
                if (currentVideoTime >= left.videoStart - epsilon && currentVideoTime <= left.videoEnd + epsilon) {
                    return left.index;
                }
            }

            const rightIdx = cursor + offset;
            if (rightIdx < ranges.length) {
                const right = ranges[rightIdx];
                if (currentVideoTime >= right.videoStart - epsilon && currentVideoTime <= right.videoEnd + epsilon) {
                    return right.index;
                }
            }
        }

        // Fallback toàn cục cho seek/scrub thủ công.
        for (let i = 0; i < ranges.length; i += 1) {
            const range = ranges[i];
            if (currentVideoTime >= range.videoStart - epsilon && currentVideoTime <= range.videoEnd + epsilon) {
                return range.index;
            }
        }

        return -1;
    }

    function findActiveSegmentIndexByTime(time) {
        if (virtualState.mode === 'FINAL') {
            return findActiveIndexFinal();
        }
        return findActiveIndexRawMapped(time);
    }

    function clampScrollTop(top) {
        const maxTop = Math.max(0, virtualState.totalHeight - transcriptContainer.clientHeight);
        return Math.max(0, Math.min(maxTop, top));
    }

    function scrollToTranscriptIndex(index, behavior, forceInstant) {
        if (index < 0 || index >= virtualState.data.length) return;
        const top = clampScrollTop((virtualState.offsets[index] || 0) - (transcriptContainer.clientHeight * 0.35));

        if (forceInstant || behavior === 'auto') {
            transcriptContainer.scrollTop = top;
        } else {
            transcriptContainer.scrollTo({ top, behavior: 'smooth' });
        }

        virtualState.lastAutoScrollAt = performance.now();
        markDirty('transcriptViewport');
    }

    function syncVirtualTranscript() {
        if (!virtualState.enabled) return;
        const data = virtualState.data;
        if (!data || data.length === 0) return;

        renderVirtualizedRange();

        const currentTime = video.currentTime;
        const nextActiveIndex = findActiveSegmentIndexByTime(currentTime);
        const prevActiveIndex = virtualState.activeIndex;

        if (nextActiveIndex !== prevActiveIndex) {
            const prevNode = virtualState.nodes.get(prevActiveIndex);
            if (prevNode) {
                prevNode.classList.remove('active-paragraph');
            }

            const nextNode = virtualState.nodes.get(nextActiveIndex);
            if (!nextNode && nextActiveIndex >= 0) {
                const distance = (prevActiveIndex >= 0) ? Math.abs(nextActiveIndex - prevActiveIndex) : Number.POSITIVE_INFINITY;
                const farJump = !Number.isFinite(distance) || distance > 12;
                scrollToTranscriptIndex(nextActiveIndex, farJump ? 'auto' : 'smooth', farJump);
                virtualState.pendingEnsureIndex = nextActiveIndex;
            } else if (nextNode) {
                nextNode.classList.add('active-paragraph');
                const now = performance.now();
                const distance = (prevActiveIndex >= 0) ? Math.abs(nextActiveIndex - prevActiveIndex) : Number.POSITIVE_INFINITY;
                if (now - virtualState.lastAutoScrollAt > 180) {
                    const behavior = (distance > 12 || !video.paused) ? 'auto' : 'smooth';
                    scrollToTranscriptIndex(nextActiveIndex, behavior, behavior === 'auto');
                }
            }

            virtualState.activeIndex = nextActiveIndex;
        }

        const activeNode = virtualState.nodes.get(nextActiveIndex);
        if (activeNode) {
            activeNode.classList.add('active-paragraph');
            if (virtualState.pendingEnsureIndex === nextActiveIndex) {
                virtualState.pendingEnsureIndex = -1;
            }
        } else if (nextActiveIndex >= 0 && nextActiveIndex === prevActiveIndex) {
            virtualState.pendingEnsureIndex = nextActiveIndex;
            scrollToTranscriptIndex(nextActiveIndex, 'auto', true);
        }

        virtualState.nodes.forEach((node, idx) => {
            const item = data[idx];
            if (!item) return;

            if (virtualState.mode === 'MAPPED') {
                node.classList.toggle('ai-selected-para', !!item.is_selected);
                node.classList.toggle('clip-tone-a', !!item.is_selected && idx % 2 === 0);
                node.classList.toggle('clip-tone-b', !!item.is_selected && idx % 2 === 1);
            } else if (virtualState.mode === 'FINAL') {
                node.classList.toggle('clip-tone-a', idx % 2 === 0);
                node.classList.toggle('clip-tone-b', idx % 2 === 1);
                node.classList.toggle(
                    'inspector-selected-para',
                    typeof isTimelineClipSelected === 'function' && isTimelineClipSelected(idx),
                );
            }

            if (idx !== nextActiveIndex) {
                node.classList.remove('active-paragraph');
            }

            const spans = Array.isArray(node.__wordSpans) ? node.__wordSpans : node.querySelectorAll('.word-item');
            for (let i = 0; i < spans.length; i += 1) {
                const span = spans[i];
                const wStart = parseFloat(span.dataset.start);
                const wEnd = parseFloat(span.dataset.end);
                const trimmedOut = wStart < item.start || wEnd > item.end;
                span.classList.toggle('trimmed-out', trimmedOut);

                const activeWord = idx === nextActiveIndex
                    && !trimmedOut
                    && currentTime >= wStart
                    && currentTime <= wEnd;
                span.classList.toggle('active-play-word', activeWord);
            }
        });
    }

    function setVirtualTranscriptData(data, mode) {
        timelineDataVersion += 1;
        playbackState.jumpChunksRef = null;
        playbackState.jumpCursor = 0;
        virtualState.data = Array.isArray(data) ? data : [];
        virtualState.mode = mode;
        if (typeof syncRazorToolAvailability === 'function') {
            syncRazorToolAvailability();
        }
        if (mode !== 'MAPPED' && typeof clearScriptHoverHighlight === 'function') {
            clearScriptHoverHighlight();
        }
        virtualState.activeIndex = -1;
        virtualState.pendingEnsureIndex = -1;
        virtualState.lastAutoScrollAt = 0;
        virtualState.heights.clear();
        virtualState.layoutDirty = true;
        virtualState.needsMeasureAll = true;

        virtualState.nodes.forEach((node) => node.remove());
        virtualState.nodes.clear();

        rebuildSortedRanges();
        rebuildFinalSequenceRanges();
        markMappedSelectionDirty();
        if (typeof syncTimelineSidePanels === 'function') {
            syncTimelineSidePanels();
        }
    }

    if (virtualState.enabled) {
        renderWordLevelTranscript = function (data, mode) {
            currentMode = mode;
            setVirtualTranscriptData(data, mode);
            markDirty('transcriptViewport');
            markDirty('transcriptActive');
            markDirty('timelineGeometry');
            markDirty('timelineVisual');
        };

        syncScriptHighlightAndTrim = function () {
            syncVirtualTranscript();
        };

        transcriptContainer.addEventListener('scroll', () => {
            markDirty('transcriptViewport');
        }, { passive: true });

        transcriptContainer.addEventListener('click', (e) => {
            const word = e.target.closest('.word-item');
            if (word) {
                const seekTime = parseFloat(word.dataset.start);
                if (Number.isFinite(seekTime)) {
                    video.currentTime = seekTime;
                    setTimeout(scrollToPlayhead, 50);
                    markDirty('transcriptActive');
                }
                return;
            }

            const paragraph = e.target.closest('.t-paragraph');
            if (!paragraph) return;
            const pIndex = parseInt(paragraph.dataset.pindex, 10);
            if (Number.isNaN(pIndex)) return;

            if (virtualState.mode === 'MAPPED') {
                const item = virtualState.data[pIndex];
                if (!item) return;
                saveHistoryState();
                item.is_selected = !item.is_selected;
                markMappedSelectionDirty();
                video.currentTime = item.start;
                const useTone = !!item.is_selected;
                paragraph.classList.toggle('clip-tone-a', useTone && pIndex % 2 === 0);
                paragraph.classList.toggle('clip-tone-b', useTone && pIndex % 2 === 1);
                markDirty('timelineVisual');
                markDirty('transcriptActive');
                setTimeout(scrollToPlayhead, 50);
            } else if (virtualState.mode === 'FINAL') {
                if (typeof selectTimelineClip === 'function') {
                    selectTimelineClip(pIndex, { seek: true });
                }
                markDirty('transcriptActive');
            }
        });

        transcriptContainer.addEventListener('dragstart', (e) => {
            if (virtualState.mode !== 'FINAL') return;
            const paragraph = e.target.closest('.t-paragraph');
            if (!paragraph) return;
            const pIndex = paragraph.dataset.pindex;
            if (pIndex == null) return;
            e.dataTransfer.setData('text/plain', pIndex);
            paragraph.style.opacity = '0.4';
        });

        transcriptContainer.addEventListener('dragend', (e) => {
            const paragraph = e.target.closest('.t-paragraph');
            if (paragraph) paragraph.style.opacity = '1';
        });

        transcriptContainer.addEventListener('dragover', (e) => {
            if (virtualState.mode !== 'FINAL') return;
            const paragraph = e.target.closest('.t-paragraph');
            if (!paragraph) return;
            e.preventDefault();
            paragraph.style.borderTop = '3px solid var(--primary)';
        });

        transcriptContainer.addEventListener('dragleave', (e) => {
            const paragraph = e.target.closest('.t-paragraph');
            if (paragraph) paragraph.style.borderTop = '1px solid transparent';
        });

        transcriptContainer.addEventListener('drop', (e) => {
            if (virtualState.mode !== 'FINAL') return;
            const paragraph = e.target.closest('.t-paragraph');
            if (!paragraph) return;

            e.preventDefault();
            paragraph.style.borderTop = '1px solid transparent';

            const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
            const toIndex = parseInt(paragraph.dataset.pindex, 10);
            if (Number.isNaN(fromIndex) || Number.isNaN(toIndex) || fromIndex === toIndex) return;

            // Dùng chung với kéo-thả block trên timeline (index.html) để con trỏ clip đang
            // phát được dịch theo, tránh playhead nhảy về đầu sau khi sắp xếp lại.
            reorderTimelineClip(fromIndex, toIndex);
        });

        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => {
                virtualState.needsMeasureAll = true;
                virtualState.layoutDirty = true;
                markDirty('transcriptViewport');
            });
            ro.observe(transcriptContainer);
        }
    } else {
        renderWordLevelTranscript = baseRenderWordLevelTranscript;
        syncScriptHighlightAndTrim = baseSyncScriptHighlightAndTrim;
    }

    // -----------------------------
    // Playback loop + timeupdate normalization
    // -----------------------------
    let playbackHandle = null;
    let lastPlaybackUiAt = 0;

    function updateTimeDisplayOnly() {
        const total = currentMode === 'FINAL' ? getTimelineDuration() : videoDuration;
        /* Cùng hệ quy chiếu với `total` và với thước timeline — xem getDisplayClockTime()
           trong index.html. Vòng phát nằm ở đây (không phải handler timeupdate của
           index.html), nên thiếu chỗ này thì đồng hồ vẫn chạy giờ NGUỒN lúc đang phát. */
        const current = typeof getDisplayClockTime === 'function'
            ? getDisplayClockTime()
            : video.currentTime;
        timeDisplay.innerText = `${formatTimecode(current)} / ${formatTimecode(total)}`;
    }

    /* MỌI lệnh tua của vòng phát phải đi qua đây.
     *
     * `runJumpCutLogic` chạy MỖI KHUNG HÌNH, còn `video.currentTime = x` là thao tác BẤT
     * ĐỒNG BỘ: gán xong thì getter trả về giá trị mới ngay, nhưng bộ giải mã còn đang dựng
     * lại hàng đợi. Ra lệnh tua mới trong lúc đó là cắt ngang lệnh cũ và bắt xả lại từ đầu
     * — mỗi lần như vậy là một nắm khung hình bị rớt.
     *
     * Bỏ qua một khung ở đây hoàn toàn an toàn: khung sau `runJumpCutLogic` chạy lại và
     * điều kiện vẫn còn đó, nên lệnh tua chỉ bị HOÃN chứ không mất. */
    function seekPlayback(time) {
        if (!Number.isFinite(time)) return false;
        if (video.seeking) return false;
        video.currentTime = time;
        return true;
    }

    function runJumpCutLogic() {
        const activeChunks = getActiveChunksForPlayback();
        if (!(isPreviewing || (currentMode === 'FINAL' && !video.paused))) {
            return;
        }
        if (!activeChunks || activeChunks.length === 0) return;

        if (playbackState.jumpChunksRef !== activeChunks) {
            playbackState.jumpChunksRef = activeChunks;
            playbackState.jumpCursor = 0;
        }

        // FINAL mode: bắt buộc phát theo THỨ TỰ SEQUENCE hiện tại (thứ tự mảng), không
        // theo timestamp gốc của source video — áp dụng cho cả Play thường và Preview Cuts
        // (trước đây Preview Cuts rơi xuống nhánh dò theo timestamp bên dưới nên block đã
        // đảo thứ tự làm playhead đứng/nhảy về đầu timeline).
        // Con trỏ clip là state DÙNG CHUNG với index.html (activeSequenceClipIndex) để
        // playhead/transcript/preview luôn nói cùng một chuyện.
        if (currentMode === 'FINAL') {
            const epsilon = 0.05;
            const currentTime = video.currentTime;
            let cursor = resolveSequenceClipIndexAtVideoTime(currentTime, epsilon);

            if (cursor < 0) {
                // Rơi vào vùng trống (tua tay ra ngoài mọi clip): về đầu clip tại con trỏ.
                cursor = Math.max(0, Math.min(getActiveSequenceClipIndex(), activeChunks.length - 1));
                setActiveSequenceClipIndex(cursor);
                seekPlayback(Number(activeChunks[cursor].start));
                return;
            }

            setActiveSequenceClipIndex(cursor);
            // TỐC ĐỘ BLOCK: mỗi clip có thể có rate riêng nên phải đặt lại mỗi khi con trỏ
            // clip đổi — đặt một lần lúc bấm Play là sang block sau vẫn giữ tốc độ cũ.
            window.applyMainClipPlaybackRate?.(cursor);

            // Tới cuối chunk hiện tại -> nhảy chunk kế theo sequence
            if (currentTime >= Number(activeChunks[cursor].end) - epsilon) {
                if (cursor < activeChunks.length - 1) {
                    setActiveSequenceClipIndex(cursor + 1);
                    window.applyMainClipPlaybackRate?.(cursor + 1);
                    seekPlayback(Number(activeChunks[cursor + 1].start));
                } else {
                    video.pause();
                    if (isPreviewing) document.getElementById('btnPreviewCuts')?.click();
                }
            }
            return;
        }

        let startIndex = Math.max(0, Math.min(playbackState.jumpCursor, activeChunks.length - 1));
        const currentTime = video.currentTime;
        if (
            currentTime < activeChunks[startIndex].start - 0.05
            || currentTime > activeChunks[startIndex].end + 0.05
        ) {
            while (startIndex < activeChunks.length - 1 && currentTime > activeChunks[startIndex].end + 0.05) {
                startIndex += 1;
            }
            while (startIndex > 0 && currentTime < activeChunks[startIndex].start - 0.05) {
                startIndex -= 1;
            }
        }

        let insideAnyChunk = false;
        for (let i = startIndex; i < activeChunks.length; i += 1) {
            const chunk = activeChunks[i];
            if (video.currentTime >= chunk.start - 0.05 && video.currentTime <= chunk.end) {
                insideAnyChunk = true;
                playbackState.jumpCursor = i;
                if (video.currentTime >= chunk.end - 0.05 && i < activeChunks.length - 1) {
                    playbackState.jumpCursor = i + 1;
                    seekPlayback(activeChunks[i + 1].start);
                } else if (video.currentTime >= chunk.end - 0.05 && i === activeChunks.length - 1) {
                    video.pause();
                    if (isPreviewing) document.getElementById('btnPreviewCuts')?.click();
                }
                break;
            }
        }

        if (!insideAnyChunk) {
            const nextChunk = activeChunks.find((c) => c.start > video.currentTime);
            if (nextChunk) {
                const nextIndex = activeChunks.indexOf(nextChunk);
                if (nextIndex >= 0) playbackState.jumpCursor = nextIndex;
                seekPlayback(nextChunk.start);
            }
        }
    }

    function cancelPlaybackLoop() {
        if (playbackHandle == null) return;
        if (video.cancelVideoFrameCallback && typeof video.cancelVideoFrameCallback === 'function') {
            try {
                video.cancelVideoFrameCallback(playbackHandle);
            } catch (_) {
                // ignore
            }
        } else {
            cancelAnimationFrame(playbackHandle);
        }
        playbackHandle = null;
    }

    function queuePlaybackLoop() {
        if (!flags.perf_scheduler) return;
        if (video.paused || video.ended) return;
        if (playbackHandle != null) return;

        const tick = (ts) => {
            playbackHandle = null;
            if (video.paused || video.ended) return;

            if (lastPlaybackUiAt > 0) {
                perfMetrics.markFrameDelta(ts - lastPlaybackUiAt);
            }

            runJumpCutLogic();

            if (ts - lastPlaybackUiAt >= 33) {
                updateTimeDisplayOnly();
                if (!isUserScrollingTimeline) {
                    scrollTimelineToCurrentTime();
                }
                markDirty('transcriptActive');
                lastPlaybackUiAt = ts;
            }

            queuePlaybackLoop();
        };

        if (video.requestVideoFrameCallback && typeof video.requestVideoFrameCallback === 'function') {
            playbackHandle = video.requestVideoFrameCallback((_, meta) => {
                tick(meta && Number.isFinite(meta.expectedDisplayTime) ? meta.expectedDisplayTime : performance.now());
            });
        } else {
            playbackHandle = requestAnimationFrame(tick);
        }
    }

    if (flags.perf_scheduler) {
        video.addEventListener('timeupdate', (e) => {
            // Legacy handler in index.html vẫn cần jump-cut, nhưng phần UI/sync nặng
            // đã chuyển qua playback scheduler để tránh chạy chồng.
            runJumpCutLogic();
            if (video.paused) {
                updateTimeDisplayOnly();
                markDirty('transcriptActive');
            }
            queuePlaybackLoop();
            e.stopImmediatePropagation();
        }, true);
    }

    video.addEventListener('play', () => {
        lastPlaybackUiAt = 0;
        queuePlaybackLoop();
    });

    video.addEventListener('pause', () => {
        cancelPlaybackLoop();
        updateTimeDisplayOnly();
        markDirty('transcriptActive');
    });

    video.addEventListener('ended', () => {
        cancelPlaybackLoop();
        updateTimeDisplayOnly();
        markDirty('transcriptActive');
    });

    timelineOuter.addEventListener('scroll', () => {
        applyRendererViewport();
        renderRulerDomLabels();
        if (flags.perf_scheduler) {
            markDirty('timelineVisual');
        }
    }, { passive: true });

    applyRendererViewport();
    markDirty('timelineGeometry');
    markDirty('timelineVisual');
    markDirty('transcriptViewport');
    markDirty('transcriptActive');
})();
