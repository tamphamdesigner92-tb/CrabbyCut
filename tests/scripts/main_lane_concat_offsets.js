/* GIẢ ĐỊNH CỐT LÕI của lane chính dựng tay, đo trên VIDEO THẬT.
 *
 * Toàn bộ tính năng đứng trên một giả định: sau khi backend nối N video, đoạn thứ i trong
 * temp_input.mp4 bắt đầu đúng ở TỔNG THỜI LƯỢNG của i video đầu. Nếu sai, mọi clip lane
 * chính trỏ lệch và mọi overlay dán sai khung hình — mà KHÔNG có lỗi nào báo, chỉ phát hiện
 * bằng mắt và chỉ khi nhìn đúng khung.
 *
 * main_lane_rows.js đo phần số học thuần; test này đo phần mà số học đó GIẢ ĐỊNH về thế
 * giới thật: chạy concat thật qua sidecar rồi đối chiếu thời lượng file ra.
 *
 * Đo 3 điều:
 *   1. preserve_order:true -> temp_input.mp4 dài đúng bằng tổng 2 nguồn (sai số < 0.15s);
 *   2. THÊM nguồn thứ ba vào cuối -> hai đoạn đầu GIỮ NGUYÊN biên (lời hứa "thêm video
 *      không làm lệch những gì đã dựng");
 *   3. bảng segment của MainLane khớp với file thật;
 *   4. /api/project/reingest TRẢ VỀ bảng đoạn của đúng file nó vừa nối (thêm 2026-09-08);
 *   5. BỎ một nguồn ở GIỮA -> bảng mới + rebaseRows dời clip phía sau về đúng chỗ.
 *
 * (4) và (5) khoá lại lỗi người dùng báo 2026-09-08: renderer TỰ ĐOÁN bảng đoạn (ffprobe
 * file gốc rồi cộng dồn, và suy bảng CŨ từ danh sách nguồn HIỆN TẠI). Đoán đó sai ngay khi
 * file đã nối còn chứa một nguồn mà lane chính không còn clip nào — xoá một video rồi thêm
 * video khác thì preview chiếu đúng cái video vừa xoá, và không tua tới được block cuối.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8147';
const TEST_TEMP = path.join(__dirname, '..', '..', 'test_temp', 'main_lane_concat');
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || TEST_TEMP;
// Cache bản đã nối cũng phải nằm trong test_temp: mỗi mục là một file vài chục MB.
process.env.CRAB_CONCAT_CACHE_DIR = process.env.CRAB_CONCAT_CACHE_DIR || `${TEST_TEMP}_store`;

const { start } = require('../../backend/server');
const MainLane = require('../../static/js/main-lane.js');

const LIBRARY = path.join(__dirname, '..', '..', 'library', 'Video');
// Nối video thật là phép nặng nhất trong test suite — 3 clip là đủ để lộ lỗi thứ tự/biên.
const CLIPS = ['[Vid] Be om, be gay - 1.mp4', '[Vid] Be om, be gay - 2.mp4', '[Vid] Be khoe, be tuoi cuoi - 1.mp4']
    .map((name) => path.join(LIBRARY, name));

function durationOf(filePath) {
    const out = execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { encoding: 'utf8' });
    const n = Number(String(out).trim());
    assert.ok(Number.isFinite(n) && n > 0, `không đọc được thời lượng: ${filePath}`);
    return n;
}

// Nối lại là mã hoá/copy stream nên biên xê dịch trong khoảng khung hình; 0.15s ~ 4 khung
// ở 25fps — đủ chặt để bắt lỗi thứ tự (lệch hàng giây) mà không giòn vì sai số codec.
const TOL = 0.15;

async function reingest(baseUrl, sources) {
    const res = await fetch(`${baseUrl}/api/project/reingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_paths: sources, preserve_order: true }),
    });
    // In chi tiết lỗi backend khi trượt: 'reingest 500' trần trụi không nói được gì.
    if (!res.ok) console.log('CHI TIẾT LỖI:', await res.text());
    assert.strictEqual(res.ok, true, `reingest phải thành công: ${res.status}`);
    return res.json();
}

async function main() {
    for (const clip of CLIPS) {
        if (!fs.existsSync(clip)) {
            console.log(`main lane concat offsets: BỎ QUA (thiếu fixture ${path.basename(clip)})`);
            return;
        }
    }
    fs.rmSync(TEST_TEMP, { recursive: true, force: true });

    const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
    const server = start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const concatPath = path.join(TEST_TEMP, 'temp_input.mp4');
    try {
        const durations = CLIPS.map(durationOf);

        // --- 1: hai nguồn, giữ đúng thứ tự đưa xuống ---
        const twoOrder = [CLIPS[1], CLIPS[0]];   // CỐ Ý đảo: tên file sắp ngược lại
        await reingest(baseUrl, twoOrder);
        assert.strictEqual(fs.existsSync(concatPath), true, 'phải sinh temp_input.mp4');
        const twoExpected = durations[1] + durations[0];
        const twoActual = durationOf(concatPath);
        assert.ok(Math.abs(twoActual - twoExpected) < TOL,
            `file nối phải dài bằng tổng 2 nguồn: thực ${twoActual.toFixed(3)}s, mong ${twoExpected.toFixed(3)}s`);

        const twoSegs = MainLane.segmentTableFromDurations([
            { source_path: twoOrder[0], name: 'b', duration: durations[1] },
            { source_path: twoOrder[1], name: 'a', duration: durations[0] },
        ]);
        assert.strictEqual(twoSegs[0].start, 0);
        assert.ok(Math.abs(twoSegs[twoSegs.length - 1].end - twoActual) < TOL,
            'bảng segment phải khớp thời lượng file thật');

        // --- 2: THÊM nguồn thứ ba vào cuối -> biên hai đoạn đầu KHÔNG đổi ---
        const threeOrder = [...twoOrder, CLIPS[2]];
        await reingest(baseUrl, threeOrder);
        const threeActual = durationOf(concatPath);
        const threeExpected = twoExpected + durations[2];
        assert.ok(Math.abs(threeActual - threeExpected) < TOL,
            `nối thêm phải dài ra đúng thời lượng clip mới: thực ${threeActual.toFixed(3)}s, mong ${threeExpected.toFixed(3)}s`);

        const threeSegs = MainLane.segmentTableFromDurations([
            { source_path: threeOrder[0], name: 'b', duration: durations[1] },
            { source_path: threeOrder[1], name: 'a', duration: durations[0] },
            { source_path: threeOrder[2], name: 'c', duration: durations[2] },
        ]);
        assert.strictEqual(threeSegs[0].start, twoSegs[0].start, 'đoạn 1 phải giữ nguyên biên');
        assert.strictEqual(threeSegs[0].end, twoSegs[0].end);
        assert.strictEqual(threeSegs[1].start, twoSegs[1].start, 'đoạn 2 phải giữ nguyên biên');
        assert.strictEqual(threeSegs[1].end, twoSegs[1].end);

        // --- 3: rebase trong ca APPEND không dời một row nào ---
        const rowsBefore = MainLane.rowsFromSegments(twoSegs, 0);
        const rebased = MainLane.rebaseRows(rowsBefore, twoSegs, threeSegs);
        assert.deepStrictEqual(
            rebased.map((r) => [r.start, r.end]),
            rowsBefore.map((r) => [r.start, r.end]),
            'thêm video vào cuối KHÔNG được dời clip cũ',
        );

        // --- 4: reingest TRẢ VỀ bảng đoạn của đúng file vừa nối ---
        const three = await reingest(baseUrl, threeOrder);
        assert.ok(Array.isArray(three.segments) && three.segments.length === 3,
            'reingest phải trả bảng đoạn cho cả 3 nguồn');
        assert.deepStrictEqual(three.segments.map((s) => s.source_path), threeOrder,
            'bảng đoạn phải giữ ĐÚNG thứ tự nối và mang ĐƯỜNG DẪN GỐC (không phải bản chép trong temp)');
        assert.strictEqual(three.segments[0].start, 0, 'đoạn đầu phải bắt đầu ở 0');
        three.segments.forEach((seg, i) => {
            if (i === 0) return;
            assert.strictEqual(seg.start, three.segments[i - 1].end, 'các đoạn phải nối liền nhau');
        });
        const reportedTotal = three.segments[three.segments.length - 1].end;
        assert.ok(Math.abs(reportedTotal - durationOf(concatPath)) < TOL,
            `bảng đoạn phải khớp file thật: bảng ${reportedTotal.toFixed(3)}s, file ${durationOf(concatPath).toFixed(3)}s`);

        // --- 5: BỎ nguồn ở GIỮA -> clip của nguồn cuối phải dời LÊN đúng chỗ ---
        // Đây là ca đã làm hỏng dự án thật: nguồn thứ 2 bị xoá khỏi lane chính, nguồn thứ 3
        // giữ nguyên clip. Nếu bảng cũ/mới không đúng, clip đó vẫn trỏ vào mốc cũ -> chiếu
        // nhầm cảnh (đúng chỗ nguồn vừa bị xoá từng nằm).
        const oldSegs = three.segments;
        const rowsOfThird = MainLane.rowsFromSegments([oldSegs[2]], 0);
        const twoLeft = [threeOrder[0], threeOrder[2]];
        const shrunk = await reingest(baseUrl, twoLeft);
        assert.deepStrictEqual(shrunk.segments.map((s) => s.source_path), twoLeft,
            'bảng đoạn sau khi bỏ nguồn phải chỉ còn 2 nguồn còn lại');
        const movedRows = MainLane.rebaseRows(rowsOfThird, oldSegs, shrunk.segments);
        assert.strictEqual(movedRows.length, 1, 'clip của nguồn còn lại không được biến mất');
        assert.ok(Math.abs(movedRows[0].start - shrunk.segments[1].start) < 0.001,
            `clip phải dời về đầu đoạn mới: ${movedRows[0].start.toFixed(3)}s, mong ${shrunk.segments[1].start.toFixed(3)}s`);
        assert.ok(movedRows[0].start < oldSegs[2].start - 0.5,
            'dời LÊN thật sự (bỏ một nguồn ở giữa thì mốc phải nhỏ đi), không phải giữ nguyên mốc cũ');

        console.log(`main lane concat offsets ok (${twoActual.toFixed(2)}s -> ${threeActual.toFixed(2)}s)`);
    } finally {
        server.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
