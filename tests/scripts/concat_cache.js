/* BỘ NHỚ ĐỆM FILE ĐÃ NỐI — "mở lại dự án phải nhanh" (2026-09-08).
 *
 * Mở một tệp .crab là xoá sạch temp_uploads rồi chép lại + nối lại toàn bộ video nguồn, dù
 * không có gì đổi kể từ lần lưu. Dự án thật của người dùng (14 nguồn ~450MB) vì thế mở rất
 * lâu. Nay backend giữ bản đã nối trong concat_cache/, khoá theo danh sách nguồn + size +
 * mtime THEO ĐÚNG THỨ TỰ NỐI, và trúng khoá thì chỉ tạo hard link sang temp_input.mp4.
 *
 * Bài kiểm mô phỏng ĐÚNG cách mở lại dự án: nối một lần, XOÁ SẠCH temp_uploads (giống
 * /api/reset-project), rồi nối lại y hệt. Nếu cache hoạt động thì lượt sau không chép file
 * nguồn nào, không sinh normalized_sources, và temp_input.mp4 quay lại với ĐÚNG mtime cũ
 * (file mới nối luôn có mtime mới — đây là dấu hiệu không thể giả).
 *
 * Kiểm cả chiều NGƯỢC: đổi thứ tự nguồn phải TRƯỢT cache — nếu không, đổi thứ tự lane chính
 * là nhận về bản nối của thứ tự cũ, tức mọi clip trỏ sai cảnh.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8151';
const TEST_TEMP = path.join(__dirname, '..', '..', 'test_temp', 'concat_cache');
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || TEST_TEMP;
/* KHÔNG dùng concat_cache/ thật: mỗi mục là một file vài chục MB, và bài kiểm này cố tình
 * tạo ra nhiều mục. Đặt NGOÀI thư mục tạm (không phải bên trong): bài kiểm mô phỏng
 * /api/reset-project bằng cách xoá sạch thư mục tạm — cache nằm trong đó thì bị xoá theo,
 * và đúng cái đang cần đo lại biến mất. */
process.env.CRAB_CONCAT_CACHE_DIR = process.env.CRAB_CONCAT_CACHE_DIR || `${TEST_TEMP}_store`;

const { start } = require('../../backend/server');

const LIBRARY = path.join(__dirname, '..', '..', 'library', 'Video');
const CLIPS = ['[Vid] Be om, be gay - 1.mp4', '[Vid] Be om, be gay - 2.mp4']
    .map((name) => path.join(LIBRARY, name));
const CONCAT_PATH = path.join(TEST_TEMP, 'temp_input.mp4');
const CACHE_DIR = path.resolve(process.env.CRAB_CONCAT_CACHE_DIR);

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

// Bản chép của video nguồn mà copyLocalSourcesToTemp() tạo ra trong temp_uploads.
function sourceCopiesInTemp() {
    try {
        return fs.readdirSync(TEST_TEMP).filter((name) => /\.mp4$/i.test(name) && name !== 'temp_input.mp4');
    } catch (_) {
        return [];
    }
}

// Dọn đúng như /api/reset-project làm trước khi mở một dự án.
function wipeTempDir() {
    for (const name of fs.readdirSync(TEST_TEMP)) {
        fs.rmSync(path.join(TEST_TEMP, name), { recursive: true, force: true });
    }
}

function cacheEntries() {
    try {
        return fs.readdirSync(CACHE_DIR).filter((name) => name.endsWith('.mp4'));
    } catch (_) {
        return [];
    }
}

async function main() {
    for (const clip of CLIPS) {
        if (!fs.existsSync(clip)) {
            console.log(`concat cache: BỎ QUA (thiếu fixture ${path.basename(clip)})`);
            return;
        }
    }
    fs.rmSync(TEST_TEMP, { recursive: true, force: true });
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    const cacheBefore = new Set();   // cache riêng của bài kiểm -> luôn rỗng lúc bắt đầu

    const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
    const server = start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const mine = [];   // mục cache do CHÍNH bài kiểm này tạo -> dọn ở cuối
    try {
        // --- 1: lượt đầu phải nối thật và ghi vào cache ---
        const first = await reingest(baseUrl, CLIPS);
        assert.ok(sourceCopiesInTemp().length >= 2, 'lượt đầu phải chép video nguồn vào temp_uploads');
        assert.ok(Array.isArray(first.segments) && first.segments.length === 2, 'phải trả bảng đoạn 2 nguồn');
        const added = cacheEntries().filter((name) => !cacheBefore.has(name));
        assert.strictEqual(added.length, 1, 'phải sinh ĐÚNG một mục trong concat_cache');
        mine.push(added[0]);

        // --- 2: mở lại dự án (temp_uploads sạch trơn) -> TRÚNG cache ---
        const mtimeFirst = Math.trunc(fs.statSync(CONCAT_PATH).mtimeMs);
        wipeTempDir();
        assert.strictEqual(fs.existsSync(CONCAT_PATH), false, 'đã xoá sạch temp_uploads');
        const second = await reingest(baseUrl, CLIPS);
        assert.strictEqual(fs.existsSync(CONCAT_PATH), true, 'phải dựng lại temp_input.mp4 từ cache');
        assert.strictEqual(Math.trunc(fs.statSync(CONCAT_PATH).mtimeMs), mtimeFirst,
            'trúng cache thì phải là CHÍNH file cũ (mtime không đổi), không phải bản nối mới');
        assert.strictEqual(second.video_version, first.video_version,
            'video_version phải giữ nguyên -> sóng âm/proxy của lần trước cũng dùng lại được');
        assert.deepStrictEqual(second.segments, first.segments, 'bảng đoạn phải y hệt lượt trước');
        assert.deepStrictEqual(sourceCopiesInTemp(), [],
            'trúng cache thì KHÔNG được chép lại video nguồn nào');
        assert.strictEqual(fs.existsSync(path.join(TEST_TEMP, 'normalized_sources')), false,
            'trúng cache thì KHÔNG được chuẩn hoá lại nguồn nào');

        // --- 3: đổi THỨ TỰ nguồn -> phải TRƯỢT cache ---
        const reversed = [CLIPS[1], CLIPS[0]];
        const third = await reingest(baseUrl, reversed);
        assert.notStrictEqual(third.video_version, first.video_version,
            'đổi thứ tự nối phải sinh file mới, không được dùng lại bản của thứ tự cũ');
        assert.deepStrictEqual(third.segments.map((s) => s.source_path), reversed,
            'bảng đoạn phải theo thứ tự MỚI');
        const addedAgain = cacheEntries().filter((name) => !cacheBefore.has(name) && !mine.includes(name));
        assert.strictEqual(addedAgain.length, 1, 'thứ tự khác = khoá khác = một mục cache nữa');
        mine.push(addedAgain[0]);

        console.log('concat cache ok');
    } finally {
        server.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
