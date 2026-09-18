/* NGUỒN DỌC + NGUỒN NGANG TRONG CÙNG MỘT DỰ ÁN — bản nối phải MỘT KHỔ, và video xuất ra
 * phải đủ độ dài.
 *
 * LỖI ĐANG KHOÁ LẠI (người dùng báo 2026-09-09). Bước chuẩn hoá trước khi nối ép chung
 * codec/fps/pix_fmt nhưng KHÔNG ép chung khổ hình, nên thêm một clip ngang vào dự án dọc là
 * `temp_input.mp4` ĐỔI KHỔ GIỮA CHỪNG. Preview vẫn xem được — nhưng lúc export, ffmpeg dựng
 * lại đồ thị filter ngay tại chỗ đổi khổ ("Reconfiguring filter graph because video parameters
 * changed") và bộ lọc `concat` gãy theo: file xuất ra CHỈ CÒN ĐOẠN ĐẦU (timeline 71,7s -> file
 * 21,2s) mà ffmpeg vẫn thoát mã 0, không một cảnh báo nào.
 *
 * Đo 5 điều:
 *   1. mọi bản chuẩn hoá ra CÙNG một khổ, và khổ đó là KHUNG BAO của mọi nguồn
 *      (max rộng × max cao) — KHÔNG phải khổ nguồn đầu tiên như bản trước;
 *   2. temp_input.mp4 không đổi thông số giữa chừng — đo bằng chính cảnh báo
 *      "Reconfiguring filter graph" của ffmpeg khi chạy hết file;
 *   3. KHÔNG nguồn nào bị thu nhỏ: vùng ảnh thật (`content` trong bảng đoạn) đúng bằng khổ
 *      nguồn. Đây là điều mà bản "khổ nguồn đầu tiên" làm sai — clip ngang 1920×1080 trong
 *      dự án dọc bị nén còn 1080×607 và mất 68% pixel VĨNH VIỄN;
 *   4. bảng đoạn khai đúng vùng ảnh (vị trí + kích thước) cho từng nguồn, và vị trí đó khớp
 *      với ĐÚNG chỗ ffmpeg đã đặt ảnh — đo bằng cách đọc pixel viền trong khung nối thật;
 *   5. /api/export-video trả về video dài ĐÚNG bằng tổng các đoạn trên timeline.
 *
 * Fixture ngang được dựng tại chỗ từ một clip trong library/ (xoay 90°) — không dựa vào máy
 * người dùng có sẵn clip ngang.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8157';
const TEST_TEMP = path.join(__dirname, '..', '..', 'test_temp', 'mixed_orientation');
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || TEST_TEMP;
process.env.CRAB_CONCAT_CACHE_DIR = process.env.CRAB_CONCAT_CACHE_DIR || `${TEST_TEMP}_store`;

const { start } = require('../../backend/server');

const LIBRARY = path.join(__dirname, '..', '..', 'library', 'Video');
const PORTRAIT = path.join(LIBRARY, '[Vid] Be om, be gay - 1.mp4');          // 1080×1920
const PORTRAIT_2 = path.join(LIBRARY, '[Vid] Be khoe, be tuoi cuoi - 1.mp4');
const FIXTURE_DIR = path.join(TEST_TEMP, 'fixture');
const LANDSCAPE = path.join(FIXTURE_DIR, 'landscape.mp4');

function ffprobeCsv(filePath, entries) {
    return String(execFileSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', entries,
        '-of', 'csv=p=0', filePath,
    ], { encoding: 'utf8' })).trim();
}

function sizeOf(filePath) {
    return ffprobeCsv(filePath, 'stream=width,height');
}

function durationOf(filePath) {
    return Number(String(execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { encoding: 'utf8' })).trim());
}

/* Màu [r,g,b] tại điểm (x,y) trong khung, ở giây `time`. Trích qua `crop` rồi ghi ra rawvideo
 * rgb24 — không cần thư viện ảnh nào. Đây là cách duy nhất đo được "ffmpeg đã đặt ảnh ở đâu
 * trong khung": mọi phép so số-với-số đều dùng chung công thức với code đang kiểm, nên khớp
 * mà không chứng minh được gì.
 * Ô 2×2 ở toạ độ CHẴN, không phải 1×1: yuv420p lấy mẫu màu theo khối 2×2 nên crop cạnh lẻ bị
 * ffmpeg từ chối ("Invalid too big or non positive size"). */
function pixelAt(filePath, time, x, y) {
    const even = (v) => Math.max(0, Math.round(v / 2) * 2);
    const out = execFileSync('ffmpeg', [
        '-v', 'error', '-ss', String(time), '-i', filePath,
        '-vf', `crop=2:2:${even(x)}:${even(y)}`,
        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { maxBuffer: 1 << 20 });
    return [out[0], out[1], out[2]];
}

// Số lần ffmpeg phải DỰNG LẠI đồ thị filter khi đọc hết file = số lần file đổi thông số.
function filterReconfigCount(filePath) {
    let out = '';
    try {
        execFileSync('ffmpeg', ['-v', 'info', '-i', filePath, '-f', 'null', '-'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        out = String(error?.stderr || '');
    }
    const text = out || '';
    return (text.match(/Reconfiguring filter graph/gi) || []).length;
}

async function main() {
    for (const clip of [PORTRAIT, PORTRAIT_2]) {
        if (!fs.existsSync(clip)) {
            console.log(`mixed orientation export: BỎ QUA (thiếu fixture ${path.basename(clip)})`);
            return;
        }
    }
    fs.rmSync(TEST_TEMP, { recursive: true, force: true });
    fs.rmSync(`${TEST_TEMP}_store`, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    // Clip NGANG: xoay clip dọc 90° và cắt ngắn cho nhanh.
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', PORTRAIT_2, '-t', '5',
        '-vf', 'transpose=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
        '-c:a', 'aac', LANDSCAPE], { stdio: 'ignore' });
    assert.strictEqual(sizeOf(LANDSCAPE), '1920,1080', 'fixture phải là clip NGANG');
    assert.strictEqual(sizeOf(PORTRAIT), '1080,1920', 'nguồn đầu phải là clip DỌC');

    const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
    const server = start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
        const sources = [PORTRAIT, LANDSCAPE];
        const res = await fetch(`${baseUrl}/api/project/reingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_paths: sources, preserve_order: true }),
        });
        assert.strictEqual(res.ok, true, `reingest phải thành công: ${res.status}`);
        const body = await res.json();
        const { segments } = body;
        assert.strictEqual(segments.length, 2, 'phải nối được 2 nguồn');

        // --- 1: mọi bản chuẩn hoá cùng một khổ = KHUNG BAO của mọi nguồn ---
        // 1080×1920 + 1920×1080 -> 1920×1920. Không nguồn nào phải thu nhỏ.
        const normalizedDir = path.join(TEST_TEMP, 'normalized_sources');
        const normalized = fs.readdirSync(normalizedDir).map((n) => path.join(normalizedDir, n));
        assert.strictEqual(normalized.length, 2, 'cả hai nguồn đều phải được chuẩn hoá');
        normalized.forEach((file) => {
            assert.strictEqual(sizeOf(file), '1920,1920',
                `bản chuẩn hoá phải về khung bao của mọi nguồn: ${path.basename(file)} = ${sizeOf(file)}`);
        });

        // --- 2: file đã nối KHÔNG đổi thông số giữa chừng ---
        const concatPath = path.join(TEST_TEMP, 'temp_input.mp4');
        assert.strictEqual(sizeOf(concatPath), '1920,1920', 'file nối phải mang khung bao');
        assert.strictEqual(filterReconfigCount(concatPath), 0,
            'file nối KHÔNG được đổi thông số giữa chừng — đó chính là thứ làm gãy concat lúc export');
        assert.deepStrictEqual(body.concat_frame, { width: 1920, height: 1920 },
            'khổ khung nối phải do backend khai ra (frontend không được suy từ cỡ thẻ <video>: có thể đang là proxy LQ)');

        /* --- 3 + 4: bảng đoạn khai đúng vùng ảnh thật, và khai ĐÚNG CHỖ ffmpeg đặt ảnh ---
         * Điều 4 đo bằng pixel thật chứ không so số với số: trích một khung của mỗi đoạn rồi
         * đọc màu ở 2 điểm — TÂM vùng ảnh (phải KHÁC đen: đó là ảnh) và giữa dải viền (phải
         * gần như đen). Nếu `content` lệch khỏi chỗ ffmpeg đặt thật thì đúng hai phép đo này
         * đảo nhau. So số với số thì cả hai phía cùng dùng MainLane.contentRectIn nên sẽ
         * "khớp" kể cả khi công thức sai — không đo được gì cả. */
        const expectedContent = [
            { x: 420, y: 0, width: 1080, height: 1920 },     // dọc: viền hai bên
            { x: 0, y: 420, width: 1920, height: 1080 },     // ngang: viền trên/dưới
        ];
        segments.forEach((seg, i) => {
            assert.deepStrictEqual(seg.content, expectedContent[i],
                `đoạn ${i}: vùng ảnh thật phải là ${JSON.stringify(expectedContent[i])}, nhận ${JSON.stringify(seg.content)}`);
            assert.strictEqual(seg.content.width * seg.content.height,
                seg.source_width * seg.source_height,
                `đoạn ${i}: vùng ảnh phải giữ NGUYÊN số pixel của nguồn (${seg.source_width}×${seg.source_height})`
                + ' — thu nhỏ ở đây là mất chi tiết vĩnh viễn');
        });
        const midTime = (seg) => seg.start + ((seg.end - seg.start) / 2);
        segments.forEach((seg, i) => {
            const c = seg.content;
            const inside = pixelAt(concatPath, midTime(seg), c.x + (c.width / 2), c.y + (c.height / 2));
            assert.ok(Math.max(...inside) > 24,
                `đoạn ${i}: TÂM vùng ảnh phải có hình, đo được ${inside} — content đang trỏ vào vùng viền`);
            // Điểm giữa dải viền: bên trái với clip dọc, phía trên với clip ngang.
            const border = c.x > 0
                ? pixelAt(concatPath, midTime(seg), c.x / 2, 1920 / 2)
                : pixelAt(concatPath, midTime(seg), 1920 / 2, c.y / 2);
            assert.ok(Math.max(...border) < 24,
                `đoạn ${i}: dải viền phải là đen, đo được ${border} — content đang khai nhỏ hơn ảnh thật`);
        });

        // --- 5: export ra đủ độ dài, và clip khác khổ được VỪA KHUNG (không bị cắt) ---
        // `content` đi kèm từng đoạn: backend đổi nó thành `fit_scale` cho sidecar. Đây cũng
        // là đúng thứ mà frontend gửi (xem timelineForExport trong index.html).
        const intervals = segments.map((seg, i) => ({
            start: seg.start, end: seg.end, text: `clip ${i}`, is_selected: true, content: seg.content,
        }));
        const expected = intervals.reduce((sum, it) => sum + (it.end - it.start), 0);
        const form = new FormData();
        form.append('timeline_json', JSON.stringify(intervals));
        form.append('export_settings', JSON.stringify({
            resolution: 'source', fps: 'source', codec: 'h264', quality: 'small',
            sequence: { width: 1080, height: 1920, source_width: 1080, source_height: 1920, source_fps: '30' },
        }));
        const exportRes = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: form });
        if (!exportRes.ok) console.log('CHI TIẾT LỖI:', await exportRes.text());
        assert.strictEqual(exportRes.ok, true, `export phải thành công: ${exportRes.status}`);
        const outPath = path.join(TEST_TEMP, 'export_check.mp4');
        fs.writeFileSync(outPath, Buffer.from(await exportRes.arrayBuffer()));
        const actual = durationOf(outPath);
        assert.ok(Math.abs(actual - expected) < 0.5,
            `video xuất ra phải dài bằng timeline: ${actual.toFixed(2)}s vs ${expected.toFixed(2)}s `
            + '(bản lỗi chỉ ra đúng đoạn đầu)');
        assert.strictEqual(sizeOf(outPath), '1080,1920', 'bản xuất phải mang khổ sequence');

        /* BỐ CỤC TRONG BẢN XUẤT — đây là phần đo "giống CapCut" chứ không chỉ "chạy được".
         * Sequence 1080×1920, khung nối 1920×1920:
         *   - đoạn DỌC (ảnh 1080×1920): hệ số vừa khung = 1 -> ảnh phủ TRỌN khung, kể cả
         *     sát mép trên/dưới;
         *   - đoạn NGANG (ảnh 1920×1080): hệ số = 1080/1920 = 0.5625 -> ảnh cao 607px nằm
         *     giữa, trên/dưới là nền đen. Bản trước (vẽ theo đúng số pixel nguồn) sẽ CẮT hai
         *     bên clip ngang và phủ kín chiều cao — đúng hai phép đo dưới đây phân biệt.
         * Mốc thời gian tính trên trục TIMELINE của bản xuất, không phải trục file nối. */
        let tlCursor = 0;
        const tlMid = intervals.map((it) => {
            const mid = tlCursor + ((it.end - it.start) / 2);
            tlCursor += (it.end - it.start);
            return mid;
        });
        // Đoạn DỌC: có hình ở cả gần mép trên và gần mép dưới.
        [60, 1860].forEach((y) => {
            const px = pixelAt(outPath, tlMid[0], 540, y);
            assert.ok(Math.max(...px) > 24,
                `đoạn dọc phải phủ trọn chiều cao khung, y=${y} đo được ${px}`);
        });
        // Đoạn NGANG: giữa khung có hình, còn hai dải trên/dưới phải là nền đen.
        const midPx = pixelAt(outPath, tlMid[1], 540, 960);
        assert.ok(Math.max(...midPx) > 24, `giữa đoạn ngang phải có hình, đo được ${midPx}`);
        [60, 1860].forEach((y) => {
            const px = pixelAt(outPath, tlMid[1], 540, y);
            assert.ok(Math.max(...px) < 24,
                `clip ngang phải VỪA KHUNG (letterbox), y=${y} đo được ${px} — bản lỗi cắt hai bên`
                + ' và phủ kín chiều cao thay vì thu vừa khung');
        });

        console.log(`mixed orientation export ok (${actual.toFixed(2)}s / ${expected.toFixed(2)}s, clip ngang vừa khung)`);
    } finally {
        server.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
