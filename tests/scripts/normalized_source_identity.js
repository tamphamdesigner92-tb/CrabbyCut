/* BẢN CHUẨN HOÁ PHẢI ĐI THEO FILE NGUỒN, KHÔNG THEO VỊ TRÍ TRONG DANH SÁCH NỐI.
 *
 * LỖI ĐANG KHOÁ LẠI (người dùng báo 2026-09-08). Khi các nguồn khác định dạng nhau, backend
 * mã hoá lại từng nguồn vào `temp_uploads/normalized_sources/` rồi mới nối. Bản trước đặt tên
 * bản chuẩn hoá theo VỊ TRÍ (`source_002.mp4` = "nguồn thứ 2"), và chỉ hỏi "bản ra có mới hơn
 * nguồn không" trước khi dùng lại. Bỏ một video khỏi lane chính rồi thêm video khác vào đúng
 * chỗ đó là: file mới mang cùng số thứ tự, gặp bản chuẩn hoá của FILE CŨ, và bản cũ luôn "mới
 * hơn" (nó vừa được tạo, còn footage thì quay từ tuần trước). temp_input.mp4 nối bằng hình
 * của file CŨ trong khi cả app tin đoạn đó là file MỚI: playhead đứng trên block 8.mp4 mà
 * preview chiếu 7.mp4.
 *
 * Bài kiểm dựng đúng ca đó và đo bằng BẢNG ĐOẠN của /api/project/reingest: đoạn thứ 2 phải
 * mang thời lượng của file thứ 2 THẬT. Với bản lỗi, nó mang thời lượng của file trước đó.
 *
 * PHẢI ĐỦ BA LƯỢT thì mới tái hiện được, vì còn một cửa gác nữa: bản chuẩn hoá chỉ được dùng
 * lại khi nó MỚI HƠN nguồn (nguồn ở đây là bản chép trong temp_uploads). Đưa một file LẦN ĐẦU
 * vào dự án thì bản chép của nó vừa được tạo -> mới hơn bản chuẩn hoá cũ -> mã hoá lại, không
 * lộ lỗi. Ca thật của người dùng là file ĐÃ TỪNG ở trong dự án (bản chép đã nằm sẵn trong
 * temp_uploads từ trước, copyLocalSourcesToTemp giữ nguyên nó): lúc đó bản chuẩn hoá của file
 * KHÁC lại mới hơn bản chép của file này, và cửa gác mở toang.
 *
 * Lượt cuối phải là một BỘ NGUỒN CHƯA TỪNG NỐI (ở đây: đảo thứ tự), nếu không bộ nhớ đệm bản
 * đã nối trả về kết quả cũ và cả bước chuẩn hoá không hề chạy — lỗi bị che.
 *
 * MỘT NGUỒN "LẠC LOÀI" PHẢI CÓ MẶT Ở MỌI LƯỢT: backend chỉ chuẩn hoá khi các nguồn KHÁC ĐỊNH
 * DẠNG nhau. Trong library/ chỉ "[Vid] Be om, be gay - 2.mp4" là h264/24fps/không tiếng, hai
 * clip còn lại đều hevc/30fps/có tiếng — nên nó (ODD) phải nằm trong mọi danh sách, không thì
 * cả bước chuẩn hoá không chạy và lỗi không thể lộ ra.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8153';
const TEST_TEMP = path.join(__dirname, '..', '..', 'test_temp', 'normalized_identity');
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || TEST_TEMP;
process.env.CRAB_CONCAT_CACHE_DIR = process.env.CRAB_CONCAT_CACHE_DIR || `${TEST_TEMP}_store`;

const { start } = require('../../backend/server');

const LIBRARY = path.join(__dirname, '..', '..', 'library', 'Video');
const ODD = path.join(LIBRARY, '[Vid] Be om, be gay - 2.mp4');       // h264/24fps -> ép chuẩn hoá
const A = path.join(LIBRARY, '[Vid] Be om, be gay - 1.mp4');        // hevc 12,0s
const B = path.join(LIBRARY, '[Vid] Be khoe, be tuoi cuoi - 1.mp4');// hevc 7,9s

function durationOf(filePath) {
    const out = execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { encoding: 'utf8' });
    return Number(String(out).trim());
}

async function reingest(baseUrl, sources) {
    const res = await fetch(`${baseUrl}/api/project/reingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_paths: sources, preserve_order: true }),
    });
    if (!res.ok) console.log('CHI TIẾT LỖI:', await res.text());
    assert.strictEqual(res.ok, true, `reingest phải thành công: ${res.status}`);
    return res.json();
}

async function main() {
    for (const clip of [ODD, A, B]) {
        if (!fs.existsSync(clip)) {
            console.log(`normalized source identity: BỎ QUA (thiếu fixture ${path.basename(clip)})`);
            return;
        }
    }
    fs.rmSync(TEST_TEMP, { recursive: true, force: true });
    fs.rmSync(`${TEST_TEMP}_store`, { recursive: true, force: true });

    const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
    const server = start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
        const durOdd = durationOf(ODD);
        const durA = durationOf(A);
        const durB = durationOf(B);
        [[durOdd, durA], [durOdd, durB], [durA, durB]].forEach(([x, y]) => {
            assert.ok(Math.abs(x - y) > 1, 'ba fixture phải chênh nhau rõ rệt thì phép đo mới phân biệt được');
        });

        // --- Lượt 1: [ODD, A] -> chuẩn hoá cả hai; "vị trí 2" là bản chuẩn hoá của A ---
        const one = await reingest(baseUrl, [ODD, A]);
        assert.ok(Math.abs(one.segments[0].duration - durOdd) < 0.2, 'lượt 1: đoạn 1 phải là ODD');
        assert.ok(Math.abs(one.segments[1].duration - durA) < 0.2, 'lượt 1: đoạn 2 phải là A');

        // --- Lượt 2: [ODD, B] -> "vị trí 2" bị ghi đè thành bản chuẩn hoá của B, mtime MỚI ---
        const two = await reingest(baseUrl, [ODD, B]);
        assert.ok(Math.abs(two.segments[1].duration - durB) < 0.2,
            `lượt 2: đoạn 2 phải là B (${two.segments[1].duration.toFixed(3)}s vs ${durB.toFixed(3)}s)`);

        /* --- Lượt 3: [A, ODD] — ĐÂY là ca của người dùng ---
         * A dọn sang VỊ TRÍ 1, nơi bản chuẩn hoá của ODD đang chiếm. Bản chép của A trong
         * temp_uploads có từ lượt 1 và được dùng lại (mtime cũ), còn bản chuẩn hoá của ODD ở
         * vị trí 1 thì "mới hơn" nó -> bản lỗi dùng lại và nối HÌNH CỦA ODD vào chỗ của A.
         * Bộ nguồn này chưa từng được nối (thứ tự khác lượt 1) nên bộ nhớ đệm bản đã nối
         * không che mất bước chuẩn hoá. */
        const three = await reingest(baseUrl, [A, ODD]);
        assert.strictEqual(three.segments.length, 2);
        assert.deepStrictEqual(three.segments.map((s) => s.source_path), [A, ODD],
            'bảng đoạn phải theo đúng thứ tự vừa gửi');
        assert.ok(Math.abs(three.segments[0].duration - durA) < 0.2,
            'đoạn 1 phải mang HÌNH của A — bản lỗi dùng lại bản chuẩn hoá của ODD nên ra '
            + `${three.segments[0].duration.toFixed(3)}s thay vì ${durA.toFixed(3)}s`);
        assert.ok(Math.abs(three.segments[1].duration - durOdd) < 0.2,
            'đoạn 2 phải mang HÌNH của ODD');

        // --- Đổi thứ tự KHÔNG được kéo theo mã hoá lại: bản chuẩn hoá khoá theo file, không theo vị trí ---
        const normalizedDir = path.join(TEST_TEMP, 'normalized_sources');
        const before = fs.readdirSync(normalizedDir).map((n) => ({
            name: n, mtime: Math.trunc(fs.statSync(path.join(normalizedDir, n)).mtimeMs),
        }));
        fs.rmSync(`${TEST_TEMP}_store`, { recursive: true, force: true });   // ép nối lại thật
        await reingest(baseUrl, [ODD, A]);
        const after = fs.readdirSync(normalizedDir).map((n) => ({
            name: n, mtime: Math.trunc(fs.statSync(path.join(normalizedDir, n)).mtimeMs),
        }));
        assert.deepStrictEqual(after, before,
            'nguồn không đổi thì KHÔNG được mã hoá lại (bộ đệm bản chuẩn hoá phải còn tác dụng)');

        console.log('normalized source identity ok');
    } finally {
        server.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
