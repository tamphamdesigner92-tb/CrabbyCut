/* =====================================================================
 * PERF HUD — Giai đoạn 0 của docs/KE_HOACH_PREVIEW_MUOT.md
 *
 * MỤC ĐÍCH: trả lời ĐÚNG MỘT câu hỏi trên DỰ ÁN THẬT của người dùng — trong lúc phát ở
 * Match Script, thời gian đi đâu? Đợt tối ưu trước thất bại vì đo trên fixture tổng hợp
 * rồi tối ưu một thứ có thể không phải nút thắt trên máy thật.
 *
 * HAI RÀNG BUỘC TỰ ĐẶT RA, và lý do:
 *
 * 1. KHÔNG TỐN GÌ KHI TẮT. Lúc nạp, file này chỉ gắn MỘT listener `keydown`. Không bọc
 *    hàm nào, không rAF, không đo gì. Dụng cụ đo mà tự nó trở thành thứ bị đo thì số
 *    liệu vô nghĩa. Mọi phép bọc chỉ xảy ra lúc BẬT, và được gỡ sạch lúc TẮT.
 *
 * 2. BỌC LÚC CHẠY, KHÔNG PHẢI LÚC NẠP. `perf-runtime.js` gán đè `drawRuler`,
 *    `drawTimelineSegments`, `scrollTimelineToCurrentTime`... sau khi index.html nạp
 *    xong. Bọc lúc nạp là bọc phải bản CŨ rồi bị ghi đè mất. Bọc lúc bật thì luôn tóm
 *    đúng bản đang thật sự chạy.
 *
 * VÌ SAO ĐO `droppedVideoFrames`: đây là con số DUY NHẤT tương ứng với cảm nhận "giật".
 * Phần trăm frame-time có thể đẹp trong khi người dùng vẫn thấy khựng; và theo đo đạc
 * trước đó, biên độ dao động frame-time tới ~29% nên chênh lệch nhỏ không phân biệt được
 * với nhiễu. Số khung hình RỚT thì không bị nhiễu đó đánh lừa.
 *
 * BẪY PHẢI BIẾT KHI ĐỌC SỐ: Chromium DỪNG compositing khi cửa sổ bị cửa sổ khác che
 * (CalculateNativeWinOcclusion) — rAF tụt về ~0-1 Hz và mọi số liệu thành rác. HUD tự
 * phát hiện và cảnh báo, nhưng cách chắc chắn là ghim cửa sổ CrabbyCut lên trên cùng.
 *
 * Bật/tắt: F9, hoặc window.PerfHUD.toggle() trong Console.
 * ================================================================== */
(function () {
    'use strict';

    const HUD_ID = 'crabbyPerfHud';
    const SAMPLE_MS = 1000;          // nhịp gom số liệu

    /* HAI ngưỡng, không phải một — bài học từ lượt đo đầu tiên (2026-09-06).
     *
     * Bản đầu chỉ có một ngưỡng 20 fps gắn nhãn "cửa sổ bị che". Người dùng đo thật ra
     * 19 và 22 fps, tức là bản đầu vừa BÁO ĐỘNG NHẦM ở lượt 19 fps vừa IM LẶNG ở lượt
     * 22 fps — trong khi cả hai lượt đều là cùng một hiện tượng và đều KHÔNG phải do che
     * cửa sổ. Cửa sổ bị che thật thì Chromium dừng hẳn compositing và rAF về ~0-2 fps
     * (đã đo trực tiếp: đúng 0). Dải 15-30 fps là dấu hiệu của compositor/GPU không theo
     * kịp — một chuyện hoàn toàn khác, và là chuyện đáng đi tìm. */
    const OCCLUDED_FPS = 3;          // ≤ mức này = compositing đã dừng hẳn
    const SLOW_FPS = 50;             // dưới mức này khi đang phát = GPU/compositor đuối

    // Các hàm toàn cục sẽ bọc, gom theo NHÓM để bảng đọc được thay vì liệt kê 8 dòng rời.
    const PHASES = [
        { key: 'timeline', label: 'Timeline vẽ lại', fns: ['drawRuler', 'drawWaveform', 'drawTimelineSegments', 'updatePlayhead'] },
        { key: 'transcript', label: 'Transcript sync', fns: ['syncScriptHighlightAndTrim'] },
        { key: 'preview', label: 'Preview transform', fns: ['updateSequencePreviewTransform'] },
        { key: 'autoscroll', label: 'Cuộn bám playhead', fns: ['scrollTimelineToCurrentTime'] },
    ];

    let on = false;
    let hudEl = null;
    let rafId = 0;
    let sampleTimer = 0;
    let longTaskObserver = null;
    const restores = [];             // các hàm hoàn nguyên, chạy khi tắt

    // ---- bộ tích luỹ: sum/count/max, KHÔNG dùng mảng ------------------------
    // push 60 Hz × 5 pha thì tự nó đã đo được — đó là lỗi của bộ đo cũ.
    const acc = {};
    let rafTicks = 0;
    let rafWorst = 0;
    let rafPrev = 0;
    let rafIntervals = 0;
    let rafIntervalSum = 0;
    let longTasks = 0;
    const pixiTickers = new Map();   // ticker -> {count, sum}
    let dropBase = null;
    // Nhịp khung video THẬT SỰ lên màn hình = delta totalVideoFrames giữa hai lần lấy mẫu.
    // Khác với "Nhịp UI" (rAF): đây là con số của video, kia là của giao diện.
    let presentedFps = 0;
    let presentedPrev = null;

    /* ===== XU HƯỚNG THEO THỜI GIAN — thêm sau lượt đo 2026-09-06 =============
     * Người dùng báo "càng chạy về cuối giật lag càng tăng", và trước đó là "bật tắt app
     * nhiều lần thì giật hơn". Hai tín hiệu ĐỘC LẬP đều nói về suy giảm THEO THỜI GIAN.
     * Nhưng mọi số của HUD tới giờ đều là ảnh chụp MỘT GIÂY, nên nó mù hoàn toàn với đúng
     * thứ quan trọng nhất. Đây là lỗ hổng của chính dụng cụ đo, không phải của ứng dụng.
     *
     * Ba số dưới đây biến "cảm giác tệ dần" thành con số so sánh được:
     *   - tỉ lệ rớt 10 GIÂY GẦN NHẤT, đặt cạnh tỉ lệ tích luỹ: gần > tích luỹ = đang tệ đi
     *   - bộ nhớ JS và mức tăng kể từ lúc bật: bắt rò rỉ
     *   - mức đệm THẤP NHẤT từng thấy: bắt cạn đệm thoáng qua mà ảnh chụp bỏ lỡ */
    const TREND_WINDOW = 10;          // giây
    const dropWindow = [];            // [{dropped, total}] mỗi giây, giữ TREND_WINDOW mục
    let heapBase = 0;
    let bufferMin = Infinity;

    /* NHỊP KHUNG CỦA CHÍNH TỆP VIDEO, đo qua requestVideoFrameCallback.
     * Vì sao cần: proxy báo "Khung trình bày 80 fps" trong khi bản gốc chỉ 60 — proxy nhẹ
     * hơn 18 lần mà lại tạo NHIỀU khung hơn. Bộ dựng proxy không đặt `-r` nên nó thừa
     * hưởng nhịp khung của nguồn; nguồn quay biến thiên (VFR) có thể khiến ffmpeg chọn
     * nhịp cao rồi nhân đôi khung. Đây là số duy nhất phân biệt được điều đó.
     * ⚠️ ĐÍNH CHÍNH (2026-09-06): tôi đặt tên số này là "nhịp khung TỆP" và ĐÓ LÀ SAI.
     * `requestVideoFrameCallback` bắn TỐI ĐA một lần mỗi khung compositor, nên khi
     * compositor tụt xuống 17 fps thì số này cũng bị kẹp xuống ~18 — nó KHÔNG đọc được
     * nhịp khung của tệp. Đo được 18,3 trong khi bộ giải mã đang tạo 63 khung/giây.
     * Giữ lại vì vẫn hữu ích, nhưng gọi đúng tên: đây là nhịp khung LÊN MÀN HÌNH.
     * Đặt cạnh số của bộ giải mã, hai dòng cho thấy phần công giải mã bị vứt đi. */
    let srcFps = 0;
    let vfcHandle = 0;
    let vfcPrevMedia = -1;
    let vfcGapSum = 0;
    let vfcGapCount = 0;

    /* ===== ĐO LÚC PHÁT — thêm sau lượt đo 2 (2026-09-06) ====================
     * Lượt 2 đo lúc DỪNG và loại trừ được gần hết: GPU là NVIDIA thật, proxy LQ 406×720
     * đang bật, canvas preview chỉ 0,13 MP, và khi dừng thì rAF 60 fps chằn chặn (khoảng
     * cách tệ nhất 16,8 ms). Tức nền tảng hoàn toàn khoẻ.
     * Vậy mà lúc PHÁT thì rAF sập còn 19-22 fps và rớt 30% khung, trong khi JS chỉ 4,5%
     * và long task = 0. Chỉ còn ba khả năng, và ba bộ đếm dưới đây tách bạch chúng:
     *   (a) nghẽn giải mã / nạp dữ liệu  -> waiting/stalled, readyState, đệm sẵn
     *   (b) tua liên tục (jump-cut)      -> số lượt seek mỗi giây
     *   (c) nghẽn đường nạp texture GPU  -> phép thử A/B bằng phím F10 */
    let seeks = 0;
    let waits = 0;
    let stalls = 0;
    let pixiPaused = false;
    const pixiSeen = new Set();      // các ticker đã gặp, để tắt/bật cho phép thử A/B

    function resetAcc() {
        PHASES.forEach((p) => { acc[p.key] = { count: 0, sum: 0, max: 0 }; });
        rafTicks = 0; rafWorst = 0; rafIntervals = 0; rafIntervalSum = 0; longTasks = 0;
        seeks = 0; waits = 0; stalls = 0;
        pixiTickers.forEach((v) => { v.count = 0; v.sum = 0; });
    }

    function record(key, ms) {
        const a = acc[key];
        if (!a) return;
        a.count += 1;
        a.sum += ms;
        if (ms > a.max) a.max = ms;
    }

    // ---- bọc / gỡ bọc -------------------------------------------------------
    /* ⚠️ `wrapped` PHẢI là một const ở scope này, KHÔNG được viết
       `window[name] = function wrapped(...)`. Tên của một named function EXPRESSION chỉ
       nhìn thấy được BÊN TRONG chính nó, nên closure hoàn nguyên bên dưới sẽ ném
       ReferenceError — và vì disable() bọc try/catch, việc gỡ bọc thất bại HOÀN TOÀN ÂM
       THẦM: tắt HUD rồi mà mọi hàm vẫn còn bị bọc. Đã dính đúng lỗi này lúc dựng. */
    function wrapGlobal(name, key) {
        const original = window[name];
        if (typeof original !== 'function') return;
        const wrapped = function (...args) {
            const t0 = performance.now();
            try {
                return original.apply(this, args);
            } finally {
                record(key, performance.now() - t0);
            }
        };
        window[name] = wrapped;
        restores.push(() => {
            /* Chỉ trả lại nếu KHÔNG có ai gán đè trong lúc HUD đang bật. Trả lại một cách
               mù quáng sẽ xoá mất bản của người khác — đúng lớp lỗi mà chính HUD này sinh
               ra nếu cẩu thả. */
            if (window[name] === wrapped) window[name] = original;
        });
    }

    /* MỘT hook duy nhất tóm được CẢ HAI app PIXI (preview + timeline). Mỗi PIXI.Application
       có ticker riêng (không dùng shared), nhưng mọi ticker đều đi qua prototype này — nên
       không cần với tới biến `timelineRenderer` / `sequencePreviewRenderer` (chúng khai báo
       bằng `let` nên KHÔNG nằm trên window, với tới được cũng mong manh). */
    function wrapPixiTickers() {
        const T = window.PIXI && window.PIXI.Ticker && window.PIXI.Ticker.prototype;
        if (!T || typeof T.update !== 'function') return;
        const original = T.update;
        // const, không phải named function expression — xem cảnh báo ở wrapGlobal().
        const wrappedUpdate = function (...args) {
            const t0 = performance.now();
            try {
                return original.apply(this, args);
            } finally {
                pixiSeen.add(this);
                let slot = pixiTickers.get(this);
                if (!slot) { slot = { count: 0, sum: 0 }; pixiTickers.set(this, slot); }
                slot.count += 1;
                slot.sum += performance.now() - t0;
            }
        };
        T.update = wrappedUpdate;
        restores.push(() => { if (T.update === wrappedUpdate) T.update = original; });
    }

    /* Đếm sự kiện của thẻ <video>. Gắn lúc BẬT, gỡ lúc TẮT (đẩy vào `restores` như mọi
       phép bọc khác) — HUD không được để lại dấu vết nào sau khi tắt. */
    function wrapVideoEvents() {
        const v = videoEl();
        if (!v) return;
        const onSeek = () => { seeks += 1; };
        const onWait = () => { waits += 1; };
        const onStall = () => { stalls += 1; };
        v.addEventListener('seeking', onSeek);
        v.addEventListener('waiting', onWait);
        v.addEventListener('stalled', onStall);
        restores.push(() => {
            v.removeEventListener('seeking', onSeek);
            v.removeEventListener('waiting', onWait);
            v.removeEventListener('stalled', onStall);
        });
    }

    /* PHÉP THỬ A/B (F10): tắt hẳn mọi ticker PIXI trong lúc vẫn đang phát.
       Đây là cách DỨT ĐIỂM để biết đường hợp thành/nạp texture của preview có phải thủ
       phạm không — thay vì suy đoán. Nếu tắt ticker mà rAF vọt lên 60 fps và khung hình
       hết rớt, thủ phạm nằm ở đó. Nếu không đổi gì, loại nó khỏi danh sách. */
    function setPixiPaused(next) {
        pixiPaused = !!next;
        pixiSeen.forEach((t) => {
            try { if (pixiPaused) t.stop(); else t.start(); } catch (_) { /* ticker đã huỷ */ }
        });
    }

    // ---- lấy số liệu --------------------------------------------------------
    function videoEl() {
        return document.getElementById('previewVideo');
    }

    function dropStats() {
        const v = videoEl();
        if (!v || typeof v.getVideoPlaybackQuality !== 'function') return null;
        let q;
        try { q = v.getVideoPlaybackQuality(); } catch (_) { return null; }
        if (!q) return null;
        // Đo từ lúc BẬT HUD, không phải từ lúc nạp video — nếu không, số liệu bị pha
        // loãng bởi cả những lần phát trước đó.
        if (!dropBase) dropBase = { dropped: q.droppedVideoFrames || 0, total: q.totalVideoFrames || 0 };
        return {
            dropped: (q.droppedVideoFrames || 0) - dropBase.dropped,
            total: (q.totalVideoFrames || 0) - dropBase.total,
        };
    }

    /* ===== BỐN SỐ ĐO THÊM SAU LƯỢT ĐO ĐẦU (2026-09-06) =====================
     * Lượt đầu cho kết quả dứt khoát: toàn bộ JS đo được chỉ chiếm ~4,5% một giây, mà
     * preview vẫn rớt 30% khung và rAF chỉ 19-22 fps. Tức nút thắt KHÔNG nằm ở JS. Bốn số
     * dưới đây nhắm thẳng vào chỗ còn lại: GPU, nguồn video, và số điểm ảnh phải hợp thành
     * mỗi khung. Đều lấy MỘT LẦN lúc bật (trừ nhịp khung), nên không tốn gì khi chạy. */
    let gpuInfoCache = null;

    function gpuInfo() {
        if (gpuInfoCache) return gpuInfoCache;
        let renderer = '(không đọc được)';
        let software = false;
        try {
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (gl) {
                const ext = gl.getExtension('WEBGL_debug_renderer_info');
                if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || renderer);
                else renderer = String(gl.getParameter(gl.RENDERER) || renderer);
                // SwiftShader/llvmpipe = Chromium đang render bằng CPU -> đúng dấu hiệu này.
                software = /swiftshader|llvmpipe|software|basic render/i.test(renderer);
            } else {
                renderer = 'KHÔNG CÓ WebGL';
                software = true;
            }
        } catch (_) { /* giữ giá trị mặc định */ }
        gpuInfoCache = { renderer, software };
        return gpuInfoCache;
    }

    /* Proxy LQ tên file là preview_proxy.mp4 (PREVIEW_PROXY_NAME ở backend). So bằng URL
       thay vì đọc biến `previewQualityMode` — biến đó khai báo bằng `let` nên không nằm
       trên window, với tới được cũng mong manh. */
    function sourceInfo() {
        const v = videoEl();
        if (!v) return null;
        const src = v.currentSrc || v.src || '';
        return {
            w: v.videoWidth || 0,
            h: v.videoHeight || 0,
            proxy: /preview_proxy/i.test(src),
        };
    }

    // Số điểm ảnh THẬT mà GPU phải hợp thành mỗi khung cho khung xem trước.
    function previewCanvasInfo() {
        const c = document.querySelector('#sequencePixiRoot canvas');
        if (!c) return null;
        return { w: c.width, h: c.height, mp: (c.width * c.height) / 1e6 };
    }

    // Chrome-only; thiếu thì trả 0 và HUD tự bỏ dòng đó.
    function startVideoFrameProbe() {
        const v = videoEl();
        if (!v || typeof v.requestVideoFrameCallback !== 'function') return;
        const step = (_now, meta) => {
            const t = meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : -1;
            if (vfcPrevMedia >= 0 && t > vfcPrevMedia) {
                const gap = t - vfcPrevMedia;
                // Bỏ khoảng nhảy do tua (mọi nhịp khung thật đều dưới 0,5s).
                if (gap > 0 && gap < 0.5) { vfcGapSum += gap; vfcGapCount += 1; }
            }
            vfcPrevMedia = t;
            if (on) vfcHandle = v.requestVideoFrameCallback(step);
        };
        vfcHandle = v.requestVideoFrameCallback(step);
        restores.push(() => {
            try { if (vfcHandle) v.cancelVideoFrameCallback(vfcHandle); } catch (_) {}
            vfcHandle = 0;
        });
    }

    function heapMb() {
        const m = performance && performance.memory;
        return m && m.usedJSHeapSize ? m.usedJSHeapSize / 1048576 : 0;
    }

    function stageLabel() {
        const mode = typeof currentMode !== 'undefined' ? currentMode : '?';
        const step = typeof currentStepId !== 'undefined' ? currentStepId : '?';
        return `${mode} / ${step}`;
    }

    function isPlaying() {
        const v = videoEl();
        return !!(v && !v.paused && !v.ended);
    }

    // ---- vẽ HUD -------------------------------------------------------------
    function ensureHud() {
        if (hudEl && hudEl.isConnected) return hudEl;
        hudEl = document.createElement('div');
        hudEl.id = HUD_ID;
        hudEl.style.cssText = [
            'position:fixed', 'right:12px', 'top:12px', 'z-index:2147483647',
            'background:rgba(10,12,16,.92)', 'color:#e8eaed', 'padding:10px 12px',
            'border:1px solid #2c3140', 'border-radius:8px',
            'font:11px/1.5 ui-monospace,Consolas,monospace', 'white-space:pre',
            'pointer-events:none', 'min-width:340px', 'box-shadow:0 6px 24px rgba(0,0,0,.5)',
        ].join(';');
        document.body.appendChild(hudEl);
        return hudEl;
    }

    function pad(s, n) { return String(s).padEnd(n); }
    function num(v, d = 1) { return Number(v).toFixed(d); }

    function render() {
        const el = ensureHud();
        const fps = rafTicks;
        const drops = dropStats();
        if (drops) {
            presentedFps = presentedPrev === null ? 0 : Math.max(0, drops.total - presentedPrev);
            presentedPrev = drops.total;
            /* Lưu MỐC TÍCH LUỸ mỗi giây rồi lấy hiệu hai đầu cửa sổ — không cộng dồn từng
               nhịp, để một nhịp lấy mẫu bị bỏ lỡ (tab bị bóp) không làm sai cả cửa sổ. */
            dropWindow.push({ dropped: drops.dropped, total: drops.total });
            while (dropWindow.length > TREND_WINDOW + 1) dropWindow.shift();
        }
        const avgGap = rafIntervals ? rafIntervalSum / rafIntervals : 0;
        const playing = isPlaying();

        const lines = [];
        lines.push(`CrabbyCut PERF — ${stageLabel()}${playing ? '   ● ĐANG PHÁT' : '   ○ dừng'}`);
        lines.push('─'.repeat(46));

        if (drops && drops.total > 0) {
            const pct = (drops.dropped / drops.total) * 100;
            const flag = pct >= 1 ? '  ← GIẬT' : '';
            lines.push(`Khung hình RỚT   ${drops.dropped} / ${drops.total}  (${num(pct, 1)}%)${flag}`);
            /* Cửa sổ gần đây so với tích luỹ: ĐANG TỆ DẦN hay đã ổn định? Đây là con số
               tương ứng với "càng chạy về cuối càng giật" mà ảnh chụp 1 giây không thấy. */
            if (dropWindow.length >= 3) {
                const a = dropWindow[0];
                const b = dropWindow[dropWindow.length - 1];
                const dTot = b.total - a.total;
                const dDrop = b.dropped - a.dropped;
                if (dTot > 0) {
                    const recent = (dDrop / dTot) * 100;
                    const xu = recent > pct + 2 ? '  ↑ ĐANG TỆ DẦN' : (recent < pct - 2 ? '  ↓ đang đỡ hơn' : '  = ổn định');
                    lines.push(`  ${dropWindow.length - 1}s gần nhất  ${dDrop} / ${dTot}  (${num(recent, 1)}%)${xu}`);
                }
            }
        } else {
            lines.push('Khung hình RỚT   — (chưa phát khung nào từ lúc bật)');
        }
        lines.push(`Nhịp UI          ${fps} fps   khoảng cách TB ${num(avgGap)}ms  tệ nhất ${num(rafWorst)}ms`);
        lines.push(`Long task        ${longTasks} lượt/giây`);
        lines.push('─'.repeat(46));
        lines.push(`${pad('Pha (mỗi giây)', 20)}${pad('lượt', 7)}${pad('tổng ms', 10)}lớn nhất`);
        PHASES.forEach((p) => {
            const a = acc[p.key];
            lines.push(`  ${pad(p.label, 18)}${pad(a.count, 7)}${pad(num(a.sum), 10)}${num(a.max)}`);
        });

        let tickCount = 0;
        let tickSum = 0;
        pixiTickers.forEach((v) => { tickCount += v.count; tickSum += v.sum; });
        lines.push('─'.repeat(46));
        lines.push(`Ticker PIXI      ${pixiTickers.size} ticker · ${tickCount} lượt/giây · ${num(tickSum)}ms`);

        /* Tổng phần JS đo được, đặt cạnh 1000 ms để thấy ngay nó có phải nút thắt không.
           Lượt đo đầu ra 4,5% — nhờ dòng này mà khỏi đi tối ưu nhầm cả tuần. */
        const jsTotal = PHASES.reduce((s, p) => s + acc[p.key].sum, 0) + tickSum;
        lines.push(`TỔNG JS          ${num(jsTotal)}ms / 1000ms  (${num(jsTotal / 10)}% ngân sách)`);

        lines.push('─'.repeat(46));
        const g = gpuInfo();
        const src = sourceInfo();
        const cv = previewCanvasInfo();
        lines.push(`GPU              ${g.software ? '⚠ PHẦN MỀM! ' : ''}${g.renderer.slice(0, 52)}`);
        if (src) {
            lines.push(`Nguồn video      ${src.w}×${src.h}  ·  ${src.proxy ? 'LQ proxy' : 'HQ gốc'}`);
        }
        if (cv) {
            lines.push(`Canvas preview   ${cv.w}×${cv.h}  =  ${num(cv.mp, 2)} MP mỗi khung`);
        }
        if (vfcGapCount >= 5) { srcFps = 1 / (vfcGapSum / vfcGapCount); vfcGapSum = 0; vfcGapCount = 0; }
        /* HAI nhịp khác nhau, phải đọc cùng lúc:
             giải mã   = totalVideoFrames/giây — công bộ giải mã BỎ RA
             lên màn hình = qua rVFC, bị kẹp bởi nhịp compositor — công THU VỀ
           Chênh lệch lớn = đang giải mã thừa rồi vứt đi. */
        lines.push(`Khung giải mã    ${presentedFps} fps`);
        if (srcFps > 0) {
            const phi = presentedFps > 0 ? presentedFps / srcFps : 0;
            const canhBao = phi >= 2 ? `   ← giải mã thừa ${num(phi, 1)}×` : '';
            lines.push(`Khung LÊN MÀN HÌNH ${num(srcFps, 1)} fps${canhBao}`);
        }
        const vv = videoEl();
        let ahead = 0;
        try {
            if (vv && vv.buffered && vv.buffered.length) {
                ahead = Math.max(0, vv.buffered.end(vv.buffered.length - 1) - vv.currentTime);
            }
        } catch (_) { /* buffered có thể ném khi chưa nạp */ }
        const heap = heapMb();
        if (heap > 0) {
            const grow = heap - heapBase;
            const canhBao = grow > 200 ? '  ← TĂNG NHIỀU' : '';
            lines.push(`Bộ nhớ JS        ${num(heap, 0)} MB   (${grow >= 0 ? '+' : ''}${num(grow, 0)} MB từ lúc bật)${canhBao}`);
        }
        lines.push(`Tua / chờ / kẹt  ${seeks} / ${waits} / ${stalls} lượt/giây`);
        if (playing && Number.isFinite(ahead)) bufferMin = Math.min(bufferMin, ahead);
        const minTxt = Number.isFinite(bufferMin) ? `  (thấp nhất ${num(bufferMin)}s)` : '';
        lines.push(`Đệm sẵn          ${num(ahead)}s${minTxt}   readyState ${vv ? vv.readyState : '-'}`);
        if (pixiPaused) {
            lines.push('');
            lines.push('▣ PHÉP THỬ A/B: ticker PIXI ĐANG TẮT (F10 để bật lại)');
        }

        /* HAI cảnh báo tách bạch. KHÔNG được viết `fps > 0 &&`: cửa sổ bị che hoàn toàn
           thì rAF về đúng 0 — ca tệ nhất lại im lặng. */
        if (playing && fps <= OCCLUDED_FPS) {
            lines.push('');
            lines.push(`⚠ Chỉ ${fps} fps — compositing đã DỪNG HẲN: cửa sổ bị che hoặc thu nhỏ.`);
            lines.push('  Mọi số ở trên KHÔNG dùng được (trừ "Khung hình RỚT" — giải mã vẫn chạy).');
            lines.push('  Đưa cửa sổ CrabbyCut lên trên cùng rồi đo lại.');
        } else if (playing && fps < SLOW_FPS) {
            lines.push('');
            lines.push(`◆ ${fps} fps — GPU/compositor KHÔNG THEO KỊP (không phải do che cửa sổ:`);
            lines.push('  bị che thì rAF về ~0). Đây là số liệu THẬT và đáng đi tìm nguyên nhân.');
            lines.push('  Đối chiếu 4 dòng GPU / Nguồn video / Canvas preview ở trên.');
        }
        lines.push('');
        lines.push('F9 để tắt');
        el.textContent = lines.join('\n');
    }

    // ---- vòng đo ------------------------------------------------------------
    function tick(ts) {
        rafTicks += 1;
        if (rafPrev) {
            const gap = ts - rafPrev;
            rafIntervals += 1;
            rafIntervalSum += gap;
            if (gap > rafWorst) rafWorst = gap;
        }
        rafPrev = ts;
        rafId = requestAnimationFrame(tick);
    }

    function enable() {
        if (on) return;
        on = true;
        dropBase = null;
        presentedPrev = null;
        presentedFps = 0;
        srcFps = 0; vfcPrevMedia = -1; vfcGapSum = 0; vfcGapCount = 0;
        dropWindow.length = 0;
        heapBase = heapMb();
        bufferMin = Infinity;
        gpuInfoCache = null;
        resetAcc();
        PHASES.forEach((p) => p.fns.forEach((fn) => wrapGlobal(fn, p.key)));
        wrapPixiTickers();
        wrapVideoEvents();
        startVideoFrameProbe();
        try {
            longTaskObserver = new PerformanceObserver((list) => { longTasks += list.getEntries().length; });
            longTaskObserver.observe({ entryTypes: ['longtask'] });
        } catch (_) { longTaskObserver = null; }
        rafPrev = 0;
        rafId = requestAnimationFrame(tick);
        sampleTimer = window.setInterval(() => { render(); resetAcc(); }, SAMPLE_MS);
        render();
    }

    function disable() {
        if (!on) return;
        on = false;
        while (restores.length) {
            const fn = restores.pop();
            /* Gỡ bọc phải luôn chạy HẾT — một lỗi không được chặn các mục còn lại. Nhưng
               PHẢI kêu lên: lần dựng đầu tiên chính cái catch này đã nuốt mất một
               ReferenceError khiến HUD tắt rồi mà hàm vẫn còn bị bọc, không ai hay. */
            try { fn(); } catch (err) { console.error('PerfHUD: gỡ bọc thất bại —', err); }
        }
        if (pixiPaused) setPixiPaused(false);
        pixiTickers.clear();
        pixiSeen.clear();
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        if (sampleTimer) window.clearInterval(sampleTimer);
        sampleTimer = 0;
        if (longTaskObserver) { try { longTaskObserver.disconnect(); } catch (_) {} }
        longTaskObserver = null;
        if (hudEl) { hudEl.remove(); hudEl = null; }
    }

    function toggle() { if (on) disable(); else enable(); }

    // Tất cả chi phí lúc TẮT nằm gọn ở đúng listener này.
    window.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        if (event.key === 'F9') { event.preventDefault(); toggle(); return; }
        // F10 chỉ có tác dụng khi HUD đang bật — nếu không thì để nguyên cho ứng dụng.
        if (event.key === 'F10' && on) { event.preventDefault(); setPixiPaused(!pixiPaused); }
    }, true);

    window.PerfHUD = {
        toggle,
        enable,
        disable,
        isOn: () => on,
        setPixiPaused,
        isPixiPaused: () => pixiPaused,
        /* Trả về ảnh chụp số liệu của giây ĐANG diễn ra — để dán vào báo cáo mà không
           cần chụp màn hình. */
        snapshot: () => ({
            stage: stageLabel(),
            playing: isPlaying(),
            drops: dropStats(),
            rafFps: rafTicks,
            rafWorstGapMs: rafWorst,
            longTasksPerSec: longTasks,
            phases: Object.fromEntries(PHASES.map((p) => [p.key, { ...acc[p.key] }])),
            decodedFps: presentedFps,
            onScreenFps: srcFps,
            heapMb: heapMb(),
            heapGrowthMb: heapMb() - heapBase,
            bufferMinSec: Number.isFinite(bufferMin) ? bufferMin : null,
            seeksPerSec: seeks,
            waitsPerSec: waits,
            stallsPerSec: stalls,
            pixiPaused,
            gpu: gpuInfo(),
            source: sourceInfo(),
            previewCanvas: previewCanvasInfo(),
            pixiTickers: pixiTickers.size,
            pixiTicksPerSec: Array.from(pixiTickers.values()).reduce((s, v) => s + v.count, 0),
        }),
    };
})();
