/* Smoke test MODULE static/js/audio-waveform.js — bảo vệ phần TOÁN của sóng âm:
 * ánh xạ cột pixel <-> THỜI GIAN NGUỒN (kể cả khi block đã trim), mip pyramid không
 * làm mất đỉnh, ngoài phạm vi nguồn phải im lặng, và cờ no_audio.
 *
 * Không cần browser: nạp .pk trực tiếp bằng AudioWaveform.ingest(). Phần VẼ (canvas)
 * đã được kiểm bằng probe Electron (xem docs/APP_STRUCTURE.md).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SIDECAR = path.join(PROJECT_ROOT, 'native', 'sidecar', 'build',
    process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const AudioWaveform = require(path.join(PROJECT_ROOT, 'static', 'js', 'audio-waveform.js'));

const TONE_AMPLITUDE = 0.9;
const TONE_STARTS = [1, 3, 5];
const TONE_LENGTH = 0.2;
const CLIP_DURATION = 6;

function toolAvailable(bin, args) {
    return spawnSync(bin, args, { stdio: 'ignore' }).status === 0;
}

// Các khoảng có tiếng (theo giây, tính từ srcStart) suy ra từ mảng cột.
function toneRegions(cols, srcStart, srcEnd, threshold = 0.02) {
    const span = (srcEnd - srcStart) / cols.count;
    const regions = [];
    let from = -1;
    for (let i = 0; i <= cols.count; i += 1) {
        const hot = i < cols.count && cols.values[i * 2] > threshold;
        if (hot && from < 0) from = i;
        else if (!hot && from >= 0) {
            regions.push([srcStart + from * span, srcStart + i * span]);
            from = -1;
        }
    }
    return regions;
}

function maxPeak(cols) {
    let max = 0;
    for (let i = 0; i < cols.count; i += 1) max = Math.max(max, cols.values[i * 2]);
    return max;
}

function main() {
    if (!fs.existsSync(SIDECAR)) {
        console.log('audio waveform columns skipped (chưa build sidecar: npm run build:sidecar)');
        return;
    }
    if (!toolAvailable('ffmpeg', ['-version'])) {
        console.log('audio waveform columns skipped (không tìm thấy ffmpeg)');
        return;
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-wave-'));
    try {
        const tonePath = path.join(workDir, 'tone.wav');
        const silentPath = path.join(workDir, 'silent.mp4');
        const tonePk = path.join(workDir, 'tone.pk');
        const silentPk = path.join(workDir, 'silent.pk');
        const gate = `gte(mod(t,2),1)*lt(mod(t,2),${1 + TONE_LENGTH})`;
        assert.strictEqual(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
            `aevalsrc=exprs='${TONE_AMPLITUDE}*sin(2*PI*1000*t)*(${gate})':d=${CLIP_DURATION}:s=48000`,
            tonePath], { stdio: 'inherit' }).status, 0, 'không dựng được file bíp');
        assert.strictEqual(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
            'testsrc=duration=2:size=160x120:rate=25', '-pix_fmt', 'yuv420p', silentPath],
            { stdio: 'inherit' }).status, 0, 'không dựng được video không tiếng');
        assert.strictEqual(spawnSync(SIDECAR, ['audio-peaks', tonePath, tonePk], { stdio: 'ignore' }).status, 0);
        assert.strictEqual(spawnSync(SIDECAR, ['audio-peaks', silentPath, silentPk], { stdio: 'ignore' }).status, 0);

        const toBuffer = (file) => {
            const raw = fs.readFileSync(file);
            return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
        };
        const tone = AudioWaveform.ingest('tone', toBuffer(tonePk));
        assert.strictEqual(tone.status, 'ready');
        assert.strictEqual(tone.peaksPerSecond, 750);
        assert.ok(Math.abs(tone.duration - CLIP_DURATION) < 0.05);

        // ---- 1) Ánh xạ cột -> thời gian nguồn (zoom cao: 1200 cột cho 6 giây) ----
        const full = AudioWaveform.columns('tone', 0, CLIP_DURATION, 1200);
        assert.ok(full && full.count === 1200);
        const fullRegions = toneRegions(full, 0, CLIP_DURATION);
        assert.strictEqual(fullRegions.length, TONE_STARTS.length,
            `phải có ${TONE_STARTS.length} vùng có tiếng, nhận ${fullRegions.length}`);
        const colSpan = CLIP_DURATION / 1200; // 5ms
        fullRegions.forEach(([start, end], index) => {
            assert.ok(Math.abs(start - TONE_STARTS[index]) <= colSpan * 1.5,
                `vùng #${index + 1} lệch đầu: ${start.toFixed(4)} vs ${TONE_STARTS[index]}`);
            assert.ok(Math.abs((end - start) - TONE_LENGTH) <= colSpan * 2,
                `vùng #${index + 1} lệch độ dài: ${(end - start).toFixed(4)}`);
        });
        // Biên độ giữ đúng (0.9 ± 1 bậc lượng tử 8-bit).
        assert.ok(Math.abs(maxPeak(full) - TONE_AMPLITUDE) <= 0.01,
            `biên độ lệch: ${maxPeak(full)}`);

        // ---- 2) BLOCK ĐÃ TRIM: source_start = 2 -> chỉ còn 2 bíp, ở 3s và 5s ----
        const trimmed = AudioWaveform.columns('tone', 2, CLIP_DURATION, 800);
        const trimmedRegions = toneRegions(trimmed, 2, CLIP_DURATION);
        assert.strictEqual(trimmedRegions.length, 2, 'trim rồi phải còn 2 vùng có tiếng');
        assert.ok(Math.abs(trimmedRegions[0][0] - 3) <= 0.02, `vùng đầu sau trim: ${trimmedRegions[0][0]}`);
        assert.ok(Math.abs(trimmedRegions[1][0] - 5) <= 0.02, `vùng sau sau trim: ${trimmedRegions[1][0]}`);

        // ---- 3) MIP PYRAMID: zoom nhỏ vẫn KHÔNG mất đỉnh (mip lấy max của max) ----
        const zoomedOut = AudioWaveform.columns('tone', 0, CLIP_DURATION, 40); // 150 peak/cột -> mip cấp 3
        assert.ok(zoomedOut && zoomedOut.count === 40);
        assert.ok(Math.abs(maxPeak(zoomedOut) - maxPeak(full)) <= 1 / 255,
            `mip làm mất đỉnh: ${maxPeak(zoomedOut)} vs ${maxPeak(full)}`);
        const mipState = AudioWaveform.debugState().entries.find((e) => e.key === 'tone');
        assert.ok(mipState.mipLevels >= 1, 'chưa dựng mức giảm mẫu nào');
        // Tổng RAM của mip phải nhỏ (≤ ~1.4× dữ liệu gốc).
        assert.ok(mipState.bytes <= tone.peakCount * 2 * 1.4,
            `mip tốn RAM quá nhiều: ${mipState.bytes}`);

        // ---- 4) RMS ≤ peak ở mọi cột, và mọi giá trị trong [0,1] ----
        for (let i = 0; i < full.count; i += 1) {
            const peak = full.values[i * 2];
            const rms = full.values[i * 2 + 1];
            assert.ok(peak >= 0 && peak <= 1 && rms >= 0 && rms <= 1, `giá trị ngoài [0,1] tại cột ${i}`);
            assert.ok(rms <= peak + 1e-6, `rms > peak tại cột ${i}`);
        }

        // ---- 5) Ngoài phạm vi nguồn (block dài hơn audio) -> im lặng, không lặp đỉnh cuối ----
        const beyond = AudioWaveform.columns('tone', CLIP_DURATION + 1, CLIP_DURATION + 3, 100);
        assert.ok(beyond, 'vẫn phải trả mảng cột');
        assert.strictEqual(maxPeak(beyond), 0, 'ngoài phạm vi nguồn phải im lặng');

        // ---- 6) Nguồn không có audio -> status no_audio, columns null ----
        const silent = AudioWaveform.ingest('silent', toBuffer(silentPk));
        assert.strictEqual(silent.status, 'no_audio');
        assert.strictEqual(AudioWaveform.columns('silent', 0, 2, 100), null);

        // ---- 7) Nguồn chưa nạp -> columns null (caller vẽ vạch trục, không vẽ sóng giả) ----
        assert.strictEqual(AudioWaveform.columns('chua-co', 0, 1, 10), null);
        assert.strictEqual(AudioWaveform.status('chua-co'), 'idle');

        // ---- 8) File .pk hỏng/không đúng magic -> ném lỗi rõ ràng ----
        assert.throws(() => AudioWaveform.ingest('rac', new ArrayBuffer(64)), /magic/);

        // ---- 9) paintViewport: ánh xạ pixel <-> thời gian + cull theo viewport ----
        // Canvas/ctx giả chỉ ghi lại các hình chữ nhật được vẽ (toạ độ NỘI DUNG, vì
        // translate bị bỏ qua) -> kiểm được toán ánh xạ mà không cần browser.
        const mockCanvas = () => {
            const rects = [];
            const blits = [];
            const ctx = {
                fillStyle: '', globalAlpha: 1,
                setTransform() {}, clearRect() {}, translate() {}, save() {}, restore() {},
                beginPath() {}, fill() {},
                rect(x, y, w, h) { rects.push({ x, y, w, h }); },
                fillRect(x, y, w, h) { rects.push({ x, y, w, h, baseline: true }); },
                drawImage(src, sx) { blits.push({ src, sx }); },
            };
            return { canvas: { width: 0, height: 0, style: {}, getContext: () => ctx }, rects, blits };
        };
        const BLOCK_LEFT = 100;
        const BLOCK_WIDTH = 600;   // 6 giây × 100 px/giây
        const INSET = 4;           // dải sóng thụt lề như trên timeline thật
        const paintTone = (view) => {
            const mock = mockCanvas();
            const stats = AudioWaveform.paintViewport({
                canvas: mock.canvas,
                scrollLeft: view.scrollLeft, scrollTop: 0,
                viewWidth: view.viewWidth, viewHeight: 100, dpr: 1,
            }, [{
                key: 'tone',
                url: 'ingest:tone',
                rect: {
                    x: BLOCK_LEFT + INSET, y: 10, w: BLOCK_WIDTH - INSET * 2, h: 40,
                    mapRect: { x: BLOCK_LEFT, w: BLOCK_WIDTH },
                },
                srcStart: 0, srcEnd: CLIP_DURATION,
            }]);
            return { stats, rects: mock.rects.filter((r) => !r.baseline) };
        };

        const painted = paintTone({ scrollLeft: 0, viewWidth: 2000 });
        assert.strictEqual(painted.stats.drawn, 1, 'phải vẽ 1 target');
        assert.ok(painted.rects.length > 0, 'không có thanh sóng nào được vẽ');
        // Mỗi bíp ở t giây phải nằm quanh x = BLOCK_LEFT + t*100 (mapRect = block, KHÔNG
        // phải rect đã thụt lề: nếu ánh xạ theo rect thụt thì t=5 lệch ~3px -> test đổ).
        for (const rect of painted.rects) {
            const t = (rect.x - BLOCK_LEFT) / (BLOCK_WIDTH / CLIP_DURATION);
            const inBurst = TONE_STARTS.some((s) => t >= s - 0.02 && t <= s + TONE_LENGTH + 0.02);
            assert.ok(inBurst, `vẽ thanh sóng ngoài vùng có tiếng: x=${rect.x} -> t=${t.toFixed(3)}`);
        }
        for (const start of TONE_STARTS) {
            const x = BLOCK_LEFT + start * (BLOCK_WIDTH / CLIP_DURATION);
            assert.ok(painted.rects.some((r) => Math.abs(r.x - x) <= 1.5),
                `thiếu thanh sóng tại mốc ${start}s (x≈${x})`);
        }
        // Cull theo viewport: chỉ nhìn thấy [520, 700] -> chỉ còn bíp ở t=5s (x≈600).
        const clipped = paintTone({ scrollLeft: 520, viewWidth: 180 });
        assert.ok(clipped.rects.length > 0, 'cull quá tay: không còn gì để vẽ');
        for (const rect of clipped.rects) {
            assert.ok(rect.x >= 519 && rect.x <= 701, `vẽ ra ngoài viewport: x=${rect.x}`);
        }
        /* ---- 10) paintViewportBuffered: cuộn KHÔNG được tô lại dải sóng ----
         * Đây là bản sửa nút thắt preview (rớt 52-81% khung khi phát). Cái phải chốt là
         * HÀNH VI đệm, không phải hình vẽ: hình do paintViewport lo và đã kiểm ở trên.
         *   · lượt đầu  -> dựng đệm (rebuilt), số rect > 0
         *   · cuộn trong phạm vi đệm -> CHỈ blit, KHÔNG thêm một rect nào
         *   · cuộn ra ngoài đệm      -> dựng lại
         *   · dữ liệu peak đổi       -> dựng lại (chữ ký mang version của store)
         * Không có test này thì một lần "tối ưu" sau (vd đổi chữ ký) rất dễ âm thầm biến
         * đệm thành vô hiệu, mà hình vẫn đúng nên không ai phát hiện. */
        const bufTarget = [{
            key: 'tone',
            url: 'ingest:tone',
            rect: { x: BLOCK_LEFT, y: 10, w: BLOCK_WIDTH, h: 40 },
            srcStart: 0, srcEnd: CLIP_DURATION,
        }];
        const bufMock = mockCanvas();
        // Dải đệm rộng 1000px CSS (contentWidth), khung nhìn 400px -> còn 600px dư để cuộn.
        const paintBuffered = (scrollLeft) => AudioWaveform.paintViewportBuffered({
            canvas: bufMock.canvas,
            bufferKey: 'test',
            scrollLeft, scrollTop: 0,
            viewWidth: 400, viewHeight: 100, dpr: 1,
            contentWidth: 1000,
            createCanvas: () => mockCanvas().canvas,
        }, bufTarget);

        const first = paintBuffered(0);
        assert.strictEqual(first.mode, 'blit', 'lượt đầu phải đi đường đệm + blit');
        assert.strictEqual(first.rebuilt, true, 'lượt đầu phải dựng đệm');
        assert.strictEqual(bufMock.blits.length, 1, 'lượt đầu thiếu blit');
        const rectsAfterFirst = bufMock.rects.length;
        assert.strictEqual(rectsAfterFirst, 0, 'thanh sóng phải vẽ vào ĐỆM, không vào canvas hiển thị');

        // Cuộn 200px: vẫn nằm trong dải đệm [0,1000] -> không được dựng lại.
        const scrolled = paintBuffered(200);
        assert.strictEqual(scrolled.rebuilt, false, 'cuộn trong phạm vi đệm mà vẫn dựng lại');
        assert.strictEqual(bufMock.blits.length, 2, 'cuộn phải blit lát mới');
        assert.strictEqual(bufMock.blits[1].sx, 200, 'blit lấy sai vị trí trong dải đệm');

        // Dữ liệu peak đổi -> chữ ký khác -> phải dựng lại (nếu không sóng đứng hình cũ).
        AudioWaveform.ingest('tone', toBuffer(tonePk));
        assert.strictEqual(paintBuffered(200).rebuilt, true, 'peak đổi mà đệm không dựng lại');

        // Khung nhìn rộng hơn cả nội dung+trần -> không đệm được, phải vẽ thẳng như cũ.
        const wideMock = mockCanvas();
        const wide = AudioWaveform.paintViewportBuffered({
            canvas: wideMock.canvas,
            bufferKey: 'test-wide',
            scrollLeft: 0, scrollTop: 0,
            viewWidth: 9000, viewHeight: 100, dpr: 1,
            contentWidth: 9000,
            createCanvas: () => mockCanvas().canvas,
        }, bufTarget);
        assert.strictEqual(wide.mode, 'direct', 'quá trần đệm thì phải vẽ thẳng');
        assert.ok(wideMock.rects.length > 0, 'đường vẽ thẳng phải vẽ thật vào canvas hiển thị');

        // Nguồn chưa nạp -> chỉ vạch trục (fillRect), không có thanh sóng.
        const pendingMock = mockCanvas();
        const pendingStats = AudioWaveform.paintViewport({
            canvas: pendingMock.canvas, scrollLeft: 0, scrollTop: 0,
            viewWidth: 800, viewHeight: 100, dpr: 1,
        }, [{ key: 'chua-nap-gi', url: 'ingest:chua-nap-gi', rect: { x: 0, y: 0, w: 400, h: 20 }, srcStart: 0, srcEnd: 4 }]);
        assert.strictEqual(pendingStats.pending, 1);
        assert.strictEqual(pendingMock.rects.filter((r) => !r.baseline).length, 0,
            'nguồn chưa có dữ liệu thì KHÔNG được vẽ thanh sóng nào');
        assert.strictEqual(pendingMock.rects.filter((r) => r.baseline).length, 1, 'thiếu vạch trục khi đang chờ');
        // Nguồn no_audio -> không vẽ gì cả.
        const silentMock = mockCanvas();
        const silentStats = AudioWaveform.paintViewport({
            canvas: silentMock.canvas, scrollLeft: 0, scrollTop: 0,
            viewWidth: 800, viewHeight: 100, dpr: 1,
        }, [{ key: 'silent', url: 'ingest:silent', rect: { x: 0, y: 0, w: 400, h: 20 }, srcStart: 0, srcEnd: 2 }]);
        assert.strictEqual(silentStats.skipped, 1);
        assert.strictEqual(silentMock.rects.length, 0, 'nguồn không có tiếng thì không vẽ gì');
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
        AudioWaveform.reset();
    }
    console.log('audio waveform columns ok');
}

main();
