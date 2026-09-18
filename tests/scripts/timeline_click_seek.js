/* =====================================================================
 * ĐỒNG HỒ PREVIEW & CÚ BẤM VÀO VÙNG TRỐNG CỦA TIMELINE (giai đoạn Editing)
 *
 * HAI LỖI ĐÃ TRẢ GIÁ (báo cáo 2026-09-06, ảnh chụp ở bước Editing):
 *
 * 1. Ô đồng hồ hiện "00:00:53:04 / 00:00:48:03" — tử số LỚN HƠN mẫu số, và không khớp
 *    vạch thước dưới playhead. Nguyên nhân: ở FINAL, tử số lấy `video.currentTime`
 *    (giờ NGUỒN — chạy suốt cả file gốc, kể cả những đoạn đã bị loại khỏi sequence) còn
 *    mẫu số lấy getTimelineDuration() (độ dài SEQUENCE). Hai hệ quy chiếu khác nhau đặt
 *    cạnh nhau. Thước timeline vẽ theo hệ SEQUENCE, nên tử số cũng phải theo hệ đó.
 *
 * 2. Bấm vào VÙNG TRỐNG của timeline thì playhead nhảy quá chỗ vừa bấm, trong khi bấm
 *    TRÚNG block trên lane chính lại đúng. Nguyên nhân là bẫy THỨ TỰ + CUỘN, hai handler
 *    cùng ăn một cú bấm:
 *      - mouseup chạy trước: finishEditingMarquee() tua đúng chỗ bấm; vì playhead ghim
 *        giữa khung nhìn nên setVideoTimeFromTimelineTime() CUỘN timeline ngay tại đó;
 *      - rồi 'click' nổi lên #segmentsTrack: handler tính lại thời điểm từ CÙNG một
 *        clientX nhưng với scrollLeft ĐÃ ĐỔI -> ra thời điểm khác -> tua lần hai.
 *    Sai số đúng bằng khoảng cách từ con trỏ tới tâm khung nhìn. Bấm trúng block thì
 *    handler click của .editing-main-block gọi stopPropagation() nên không có lần hai.
 *
 * CÁCH ĐO: rút THẲNG các hàm thật trong index.html ra chạy trong vm (chúng nằm trong một
 * khối <script> khổng lồ, không import được), rồi dựng lại đúng chuỗi sự kiện trên.
 * Phần nào là thứ tự sự kiện DOM thuần thì khoá bằng cách soi mã nguồn — ghi rõ ở dưới.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const editingRuntime = fs.readFileSync(
    path.join(projectRoot, 'static', 'js', 'editing-runtime.js'), 'utf8');
const perfRuntime = fs.readFileSync(
    path.join(projectRoot, 'static', 'js', 'perf-runtime.js'), 'utf8');

/* Cắt nguyên văn một khai báo `function NAME(...) {...}` bằng cách đếm ngoặc nhọn.
   Không dùng regex tham lam: thân hàm có cả chuỗi lẫn ngoặc lồng nhau. */
function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    assert.notStrictEqual(start, -1, `không tìm thấy hàm ${name}() trong nguồn`);
    const bodyStart = source.indexOf('{', source.indexOf(')', start));
    let depth = 0;
    for (let i = bodyStart; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`không đóng được thân hàm ${name}()`);
}

const EXTRACTED = [
    'getActiveSequenceClipIndex',
    'resolveSequenceClipIndexAtVideoTime',
    'clipSpeedRate',
    'clipSequenceDuration',
    'getFinalSequenceOffset',
    'getCurrentTimelineTime',
    'getTimelineDuration',
    'getDisplayClockTime',
    'getTimelineSidePaddingPx',
    'timelineTimeToPx',
    'pxToTimelineTime',
    'timelineClipSpanFromClientX',
];

// ---------------------------------------------------------------------------
// Sân khấu: sequence 3 block cắt từ những chỗ RẤT XA nhau trong file nguồn, để giờ
// nguồn và giờ sequence không thể tình cờ trùng nhau (trùng thì test luôn xanh dù lỗi
// còn nguyên — đúng cái bẫy làm lỗi này sống lâu).
// ---------------------------------------------------------------------------
const TIMELINE = [
    { start: 0, end: 20 },      // sequence 0 .. 20
    { start: 40, end: 60 },     // sequence 20 .. 40
    { start: 80, end: 88.1 },   // sequence 40 .. 48.1
];
const SEQUENCE_TOTAL = 48.1;
const VIEWPORT_W = 1000;        // -> đệm hai bên = 500px, playhead ghim ở tâm
const ZOOM = 100;               // px mỗi giây

function makeSandbox() {
    const outer = {
        clientWidth: VIEWPORT_W,
        scrollLeft: 0,
        getBoundingClientRect: () => ({ left: 0, width: VIEWPORT_W }),
    };
    const sandbox = {
        currentMode: 'FINAL',
        latestTimeline: TIMELINE.map((block) => ({ ...block })),
        activeSequenceClipIndex: -1,
        videoDuration: 120,             // file nguồn dài hơn hẳn sequence
        zoomScale: ZOOM,
        video: { currentTime: 0 },
        outer,
        document: { getElementById: (id) => (id === 'timelineTrackOuter' ? outer : null) },
    };
    sandbox.window = sandbox;           // window.ClipSpeed vắng mặt -> rate = 1, đúng nhánh mặc định
    vm.createContext(sandbox);
    vm.runInContext(EXTRACTED.map((name) => extractFunction(indexHtml, name)).join('\n'), sandbox);
    return sandbox;
}

// =========================================================================
// 1. ĐỒNG HỒ: tử số phải cùng hệ quy chiếu với mẫu số
// =========================================================================
{
    const s = makeSandbox();
    assert.ok(Math.abs(s.getTimelineDuration() - SEQUENCE_TOTAL) < 1e-9,
        `tổng sequence sai: ${s.getTimelineDuration()}`);

    // Playhead nằm trong block cuối, cách đầu block 5s -> vị trí sequence = 40 + 5 = 45.
    s.video.currentTime = 85;
    const clock = s.getDisplayClockTime();
    assert.ok(Math.abs(clock - 45) < 1e-9,
        `đồng hồ phải chỉ 45s (giờ sequence), đang chỉ ${clock}`);
    /* Chốt lại đúng hình dạng của lỗi đã báo: giờ NGUỒN (85) vượt tổng sequence (48.1).
       Nếu ai đó lỡ trả video.currentTime về lại thì phép so này đổ. */
    assert.ok(s.video.currentTime > s.getTimelineDuration(),
        'sân khấu hỏng: giờ nguồn phải vượt tổng sequence thì mới tái hiện được lỗi');
    assert.ok(clock <= s.getTimelineDuration() + 1e-9,
        `tử số (${clock}) không được vượt mẫu số (${s.getTimelineDuration()})`);

    // RAW/MAPPED: hai hệ là một -> phải trả thẳng currentTime, không quy đổi gì.
    s.currentMode = 'RAW';
    s.video.currentTime = 73.5;
    assert.strictEqual(s.getDisplayClockTime(), 73.5,
        'ngoài FINAL thì đồng hồ phải bám thẳng video.currentTime');
}

// Ba nơi ghi vào #timeDisplay đều phải đi qua getDisplayClockTime(): handler timeupdate
// và seekTimeline() ở index.html, vòng phát ở perf-runtime.js (chỗ chạy lúc đang phát).
{
    const writes = indexHtml.match(/timeDisplay'\)\.innerText = `\$\{formatTimecode\(([^)]*)\)/g) || [];
    assert.ok(writes.length >= 2, `không thấy đủ chỗ ghi đồng hồ trong index.html (${writes.length})`);
    writes.forEach((line) => {
        assert.ok(!/formatTimecode\(video\.currentTime\)/.test(line),
            `đồng hồ lại ghi giờ NGUỒN: ${line}`);
    });
    assert.ok(/const displayTime = currentMode === 'FINAL' \? targetTime :/.test(indexHtml),
        'seekTimeline() phải hiện thẳng targetTime (giờ sequence) khi ở FINAL');
    assert.ok(!/timeDisplay\.innerText = `\$\{formatTimecode\(video\.currentTime\)/.test(perfRuntime),
        'vòng phát ở perf-runtime.js vẫn ghi giờ NGUỒN vào đồng hồ');
    assert.ok(/getDisplayClockTime/.test(perfRuntime),
        'perf-runtime.js phải dùng getDisplayClockTime()');
}

// =========================================================================
// 2. BẤM VÀO VÙNG TRỐNG: chỉ được tua MỘT lần
// =========================================================================
/* Dựng lại đúng chuỗi sự kiện thật bằng các hàm pixel<->thời gian THẬT của index.html.
   `clickSeek` = phần việc của handler 'click' trên #segmentsTrack; bật/tắt nó chính là
   bật/tắt suppressNextTimelineClickOnce(). */
function simulateEmptyAreaClick({ clickSuppressed }) {
    const s = makeSandbox();
    const outer = s.outer;

    // Playhead đang ở 10s, timeline đã cuộn để nó nằm giữa khung nhìn.
    const startTime = 10;
    const centerScroll = (t) => Math.max(0, s.timelineTimeToPx(t) - (VIEWPORT_W / 2));
    outer.scrollLeft = centerScroll(startTime);
    s.video.currentTime = 10;   // block 0: giờ nguồn == giờ sequence

    // Con trỏ bấm cách tâm khung nhìn 300px về bên phải.
    const pointerOffsetFromCenter = 300;
    const clientX = (VIEWPORT_W / 2) + pointerOffsetFromCenter;
    const clickedTime = s.pxToTimelineTime(outer.scrollLeft + clientX);

    // (a) mouseup -> finishEditingMarquee(): tua tới chỗ bấm RỒI cuộn theo playhead.
    let playhead = clickedTime;
    outer.scrollLeft = centerScroll(playhead);

    // (b) 'click' nổi lên #segmentsTrack — dùng CÙNG clientX nhưng scrollLeft đã đổi.
    if (!clickSuppressed) {
        const span = s.timelineClipSpanFromClientX(clientX);
        assert.ok(span, 'handler click phải tìm được block dưới con trỏ');
        playhead = Math.max(span.start, Math.min(span.end, span.time));
    }
    return { clickedTime, playhead, pointerOffsetFromCenter };
}

{
    // Bản CHƯA sửa: lần tua thứ hai đẩy playhead đi thêm đúng bằng độ lệch con trỏ/tâm.
    const buggy = simulateEmptyAreaClick({ clickSuppressed: false });
    const drift = buggy.playhead - buggy.clickedTime;
    assert.ok(Math.abs(drift - (buggy.pointerOffsetFromCenter / ZOOM)) < 1e-9,
        `sân khấu hỏng: phải tái hiện được độ trôi ${buggy.pointerOffsetFromCenter / ZOOM}s, đo được ${drift}s`);

    // Bản ĐÃ sửa: cú click bị bỏ -> playhead đứng đúng chỗ đã bấm.
    const fixed = simulateEmptyAreaClick({ clickSuppressed: true });
    assert.ok(Math.abs(fixed.playhead - fixed.clickedTime) < 1e-9,
        `playhead phải dừng đúng chỗ bấm (${fixed.clickedTime}s), đang ở ${fixed.playhead}s`);
}

/* Khoá thứ tự sự kiện DOM — phần vm không mô phỏng được:
   nhánh "bấm mà không kéo" của finishEditingMarquee() phải bỏ cú 'click' đi kèm, và phải
   bỏ TRƯỚC khi tua (setSequenceTime cuộn timeline ngay trong lời gọi đó). */
{
    const marquee = extractFunction(editingRuntime, 'finishEditingMarquee');
    const notMoved = marquee.slice(marquee.indexOf('if (!m.moved)'), marquee.indexOf('if (!commit)'));
    assert.ok(notMoved.includes('suppressNextTimelineClickOnce'),
        'finishEditingMarquee(): nhánh bấm-không-kéo phải gọi suppressNextTimelineClickOnce()');
    /* So bằng `setSequenceTime(clamp(` — tức LỜI GỌI thật, không phải chữ "setSequenceTime"
       trong khối chú thích ngay phía trên nó. */
    assert.ok(notMoved.indexOf('suppressNextTimelineClickOnce') < notMoved.indexOf('setSequenceTime(clamp('),
        'phải bỏ cú click TRƯỚC khi setSequenceTime() cuộn timeline');
}

/* Và lý do bấm TRÚNG block vẫn đúng: handler click của .editing-main-block chặn nổi bọt,
   nên #segmentsTrack không bao giờ tua lần hai. Mất dòng này là lỗi quay lại ở block. */
{
    const anchor = editingRuntime.indexOf("block.addEventListener('click', (event) => {");
    assert.notStrictEqual(anchor, -1, 'không tìm thấy handler click của block lane chính');
    assert.ok(editingRuntime.slice(anchor, anchor + 200).includes('event.stopPropagation()'),
        'handler click của block lane chính phải stopPropagation()');
}

console.log('timeline_click_seek: OK');
