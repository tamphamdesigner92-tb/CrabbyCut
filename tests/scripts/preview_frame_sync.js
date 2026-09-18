/* =====================================================================
 * HÌNH HỌC PREVIEW PHẢI ĐI THEO KHUNG ĐANG HIỆN, KHÔNG THEO ĐỒNG HỒ PHÁT
 *
 * LỖI ĐÃ TRẢ GIÁ (người dùng báo 2026-09-09, dự án `Test_lech fps_ver 2.crab`):
 * "khi playhead đi sang vị trí của block video thứ 2 thì 2 frame đầu tiên lại hiển thị
 * hình ảnh của video block trước đó với kích thước của block video phía sau" -> giật hình
 * ở mỗi điểm chuyển cảnh. Bản render KHÔNG bị, vì export ghi transform TĨNH cho từng đoạn.
 *
 * Preview có hai đường chạy độc lập: ẢNH lấy từ khung <video> đang hiện, HÌNH HỌC lấy theo
 * `video.currentTime`. Hai thứ đó là HAI ĐỒNG HỒ KHÁC NHAU — `currentTime` là "vị trí phát
 * chính thức" và chạy trước tấm hình trên màn hình. Bản chặn trước gác bằng `video.seeking`,
 * nhưng `seeking = false` chỉ có nghĩa "lệnh tua xong", không phải "khung mới đã lên màn
 * hình": đúng cửa sổ giữa hai mốc đó là 2 khung bị vẽ sai.
 *
 * Bản sửa gác bằng `requestVideoFrameCallback.mediaTime` — mốc của tấm hình VỪA ĐƯỢC ĐƯA
 * lên tầng hợp thành. Test này dựng lại đúng chuỗi trạng thái của một điểm chuyển cảnh và
 * đòi: KHÔNG khung nào được vẽ bằng hình học của block B khi ảnh còn là của block A.
 *
 * Số liệu dùng làm ca thử lấy từ chính dự án người dùng gửi (file nối 60000/1001):
 *     block 0 = [0, 5.538867]      DJI, scale 145%, dịch (-203, -139)
 *     block 1 = [5.6, 10.561133]   6.mp4, scale 100%
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

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
    throw new Error(`không đóng được thân hàm ${name}()`);
}

const FRAME = 1001 / 60000;          // một khung ở 60000/1001
const BLOCKS = [
    { start: 0, end: 5.538867, text: 'DJI' },
    { start: 5.6, end: 10.561133, text: '6.mp4' },
];

function makeSandbox() {
    const sandbox = {
        currentMode: 'FINAL',
        latestTimeline: BLOCKS.map((b) => ({ ...b })),
        selectedTimelineClipIndex: -1,
        activeSequenceClipIndex: 0,
        isDraggingPlayhead: false,
        isTimelineSeeking: false,
        video: { currentTime: 0, seeking: false, paused: false },
        performance,
        requestAnimationFrame: () => 0,
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext([
        // Đồng hồ khung hình: test tự đặt tay thay cho rVFC.
        'const previewFrameClock = { mediaTime: NaN, at: 0, seq: 0, frameDur: 0, supported: true };',
        'let settledPreviewClipIndex = -1;',
        'let previewSeekHoldStartedAt = 0;',
        'const PREVIEW_SEEK_HOLD_MAX_MS = 400;',
        'function resolveSequenceFps() { return 60000 / 1001; }',
        'function getActiveSequenceClipIndex() { return activeSequenceClipIndex; }',
        extractFunction(source, 'resolveSequenceClipIndexAtVideoTime'),
        extractFunction(source, 'previewFrameDuration'),
        extractFunction(source, 'presentedFrameBelongsToClip'),
        extractFunction(source, 'resolveActivePreviewClipIndexNow'),
        extractFunction(source, 'isUserScrubbingPlayhead'),
        extractFunction(source, 'getActivePreviewClipIndex'),
        `globalThis.api = {
            getActivePreviewClipIndex,
            presentFrame(mediaTime) {
                const prev = previewFrameClock.mediaTime;
                const delta = mediaTime - prev;
                if (delta > 1 / 240 && delta < 1 / 10) {
                    previewFrameClock.frameDur = previewFrameClock.frameDur
                        ? (previewFrameClock.frameDur * 0.75) + (delta * 0.25)
                        : delta;
                }
                previewFrameClock.mediaTime = mediaTime;
                previewFrameClock.at = performance.now();
                previewFrameClock.seq += 1;
            },
            settled: () => settledPreviewClipIndex,
         };`,
    ].join('\n'), sandbox);
    return sandbox;
}

/* Phát vài khung của block 0 để đồng hồ khung đo được `frameDur` — trong app thật vòng rVFC
 * làm việc này liên tục, ở đây phải mồi tay. */
function primeOnBlockZero(sandbox) {
    for (let i = 0; i < 6; i += 1) {
        const t = i * FRAME;
        sandbox.video.currentTime = t;
        sandbox.api.presentFrame(t);
        assert.strictEqual(sandbox.api.getActivePreviewClipIndex(), 0, 'mồi block 0 phải ra index 0');
    }
}

function caseJumpCutHoldsUntilFrameArrives() {
    const sandbox = makeSandbox();
    primeOnBlockZero(sandbox);

    /* KHUNG CUỐI của block 0 trên file nối. Block 0 kết thúc ở 5.538867 nên khung cuối bắt
     * đầu ngay trước mốc đó; lấy đúng lưới khung 60000/1001. */
    const lastFrameOfA = Math.floor(5.538867 / FRAME) * FRAME;
    sandbox.video.currentTime = lastFrameOfA;
    sandbox.api.presentFrame(lastFrameOfA);
    assert.strictEqual(sandbox.api.getActivePreviewClipIndex(), 0);

    /* runJumpCutLogic phát hiện đã hết block 0 -> đẩy con trỏ sang 1 và ra lệnh tua tới
     * 5.6. `currentTime` đổi NGAY, `seeking` bật lên. Ảnh trên màn hình vẫn là khung cuối
     * của block 0. */
    sandbox.activeSequenceClipIndex = 1;
    sandbox.video.currentTime = 5.6;
    sandbox.video.seeking = true;
    assert.strictEqual(sandbox.api.getActivePreviewClipIndex(), 0,
        'đang tua: phải giữ block 0 vì ảnh vẫn là của block 0');

    /* ĐÂY LÀ CHỖ BẢN CŨ SAI. `seeked` đã bắn (`seeking = false`) nhưng khung mới CHƯA lên
     * tầng hợp thành — `mediaTime` vẫn là khung cuối của block 0. Bản cũ gác bằng
     * `video.seeking` nên tới đây là chuyển ngay sang hình học của block 1 trong khi ảnh
     * còn là block 0: đúng 2 khung giật mà người dùng thấy. */
    sandbox.video.seeking = false;
    assert.strictEqual(sandbox.api.getActivePreviewClipIndex(), 0,
        'seeked đã bắn nhưng khung chưa tới: VẪN phải giữ block 0');
    sandbox.api.getActivePreviewClipIndex();
    assert.strictEqual(sandbox.api.getActivePreviewClipIndex(), 0,
        'giữ phải bền qua nhiều lượt vẽ, không chỉ lượt đầu');

    // Khung của block 1 lên màn hình -> lúc này MỚI được đổi hình học.
    sandbox.api.presentFrame(5.6);
    assert.strictEqual(sandbox.api.getActivePreviewClipIndex(), 1,
        'khung của block 1 đã hiện: phải chuyển sang block 1');
    console.log('  ok  điểm chuyển cảnh: hình học chỉ đổi KHI khung mới đã lên màn hình');
}

function casePreviousFrameNeverCountsAsNextBlock() {
    /* Sai số dấu phẩy động ở mép: khoảng của khung cuối block 0 KẾT THÚC đúng tại
     * `block1.start`. Đòi giao nhau > 0 là nó lọt qua và bản sửa thành vô nghĩa — chốt lại
     * ở đây để không ai "đơn giản hoá" phép so đó. */
    const sandbox = makeSandbox();
    primeOnBlockZero(sandbox);
    const frameEndingAtBoundary = 5.6 - FRAME;
    sandbox.video.currentTime = frameEndingAtBoundary;
    sandbox.api.presentFrame(frameEndingAtBoundary);
    sandbox.activeSequenceClipIndex = 1;
    sandbox.video.currentTime = 5.6;
    assert.strictEqual(sandbox.api.getActivePreviewClipIndex(), 0,
        'khung kết thúc ĐÚNG tại mép block 1 vẫn thuộc block 0');
    console.log('  ok  khung sát mép không bị tính là đã sang block sau');
}

function caseScrubbingStaysResponsive() {
    // Rê playhead thì phải bám tay, không được giữ khung (rê là seek liên tục).
    const sandbox = makeSandbox();
    primeOnBlockZero(sandbox);
    sandbox.isDraggingPlayhead = true;
    sandbox.activeSequenceClipIndex = 1;
    sandbox.video.currentTime = 8;
    sandbox.video.seeking = true;
    assert.strictEqual(sandbox.api.getActivePreviewClipIndex(), 1,
        'đang rê playhead thì không giữ khung');
    console.log('  ok  rê playhead vẫn bám tay tức thì');
}

function caseHoldHasCeiling() {
    // Một cú tua treo không được làm đứng hình vô hạn.
    const sandbox = makeSandbox();
    primeOnBlockZero(sandbox);
    sandbox.activeSequenceClipIndex = 1;
    sandbox.video.currentTime = 5.6;
    assert.strictEqual(sandbox.api.getActivePreviewClipIndex(), 0);
    // Lùi mốc bắt đầu giữ về quá khứ để mô phỏng đã chờ quá trần.
    vm.runInContext('previewSeekHoldStartedAt = performance.now() - (PREVIEW_SEEK_HOLD_MAX_MS + 50);', sandbox);
    assert.strictEqual(sandbox.api.getActivePreviewClipIndex(), 1,
        'quá trần chờ thì phải nhả, không treo hình');
    console.log(`  ok  có trần thời gian chờ, không treo hình`);
}

function caseNoFrameClockFallsBackToOldBehaviour() {
    // Trình duyệt thiếu rVFC: phép gác không có dữ liệu -> KHÔNG chặn gì cả.
    const sandbox = makeSandbox();
    vm.runInContext('previewFrameClock.supported = false;', sandbox);
    sandbox.activeSequenceClipIndex = 1;
    sandbox.video.currentTime = 5.6;
    assert.strictEqual(sandbox.api.getActivePreviewClipIndex(), 1,
        'không đo được khung thì không được chặn');
    console.log('  ok  thiếu requestVideoFrameCallback -> rơi về hành vi cũ, không treo');
}

caseJumpCutHoldsUntilFrameArrives();
casePreviousFrameNeverCountsAsNextBlock();
caseScrubbingStaysResponsive();
caseHoldHasCeiling();
caseNoFrameClockFallsBackToOldBehaviour();
console.log('preview frame sync ok');
