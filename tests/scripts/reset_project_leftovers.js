/* /api/reset-project phải XOÁ HẾT temp_uploads, kể cả khi một mục không xoá được.
 *
 * LỖI ĐANG KHOÁ LẠI (báo cáo 2026-09-08): bản trước gọi fs.rmSync thẳng trong vòng for, nên
 * mục đầu tiên bị hệ điều hành giữ (Windows: Explorer đang mở thư mục và dựng thumbnail,
 * ffmpeg chưa nhả handle, thẻ <video> còn stream temp_input.mp4) ném EPERM/EBUSY và ném luôn
 * ra khỏi vòng lặp — mọi mục CÒN LẠI không được xét, ensureDirs() không chạy, API trả 500 mà
 * renderer bỏ qua trong catch. Người dùng tạo dự án mới xong vẫn thấy nguyên video của dự án
 * cũ trong temp_uploads.
 *
 * CÁCH DỰNG CA "BỊ GIỮ": lấy một thư mục con của temp làm CWD của chính tiến trình test.
 * Windows không cho xoá thư mục đang là CWD của một tiến trình -> EPERM, đúng dạng lỗi thật.
 * (fs.openSync KHÔNG dùng được: libuv mở file kèm FILE_SHARE_DELETE nên file đang mở vẫn xoá
 * được.) Tên bắt đầu bằng "0-" để nó nằm ĐẦU danh sách readdir: có vậy mới đo được rằng lỗi
 * ở mục đầu không chặn các mục sau.
 *
 * Trên nền tảng cho xoá thư mục đang dùng (Linux/macOS), bài kiểm rơi về nhánh "xoá sạch,
 * leftovers rỗng" — vẫn là đúng hợp đồng.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8143';
const TEST_TEMP = path.join(__dirname, '..', '..', 'test_temp', 'reset_project_leftovers');
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || TEST_TEMP;

const { start } = require('../../backend/server');

const BUSY_NAME = '0-busy';

function seedTempDir() {
  fs.mkdirSync(path.join(TEST_TEMP, 'editing_assets'), { recursive: true });
  fs.mkdirSync(path.join(TEST_TEMP, BUSY_NAME), { recursive: true });
  fs.writeFileSync(path.join(TEST_TEMP, 'temp_input.mp4'), Buffer.alloc(64, 1));
  fs.writeFileSync(path.join(TEST_TEMP, 'zz-source.mp4'), Buffer.alloc(64, 2));
  fs.writeFileSync(path.join(TEST_TEMP, 'editing_assets', 'overlay.mp4'), Buffer.alloc(64, 3));
}

async function main() {
  const home = process.cwd();
  fs.rmSync(TEST_TEMP, { recursive: true, force: true });
  seedTempDir();
  const busyDir = path.resolve(TEST_TEMP, BUSY_NAME);

  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  const server = start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    process.chdir(busyDir);   // giữ thư mục lại: Windows sẽ không xoá được nó
    const res = await fetch(`${baseUrl}/api/reset-project`, { method: 'POST' });
    process.chdir(home);
    assert.strictEqual(res.ok, true, 'reset-project phải trả 200 dù có mục không xoá được');
    const data = await res.json();
    const leftovers = (data.leftovers || []).map((x) => x.name);

    // 1. Mục đứng SAU mục lỗi vẫn phải bị xoá — đây chính là hồi quy cần khoá.
    assert.strictEqual(fs.existsSync(path.join(TEST_TEMP, 'temp_input.mp4')), false,
      'temp_input.mp4 phải bị xoá dù mục đầu danh sách bị giữ');
    assert.strictEqual(fs.existsSync(path.join(TEST_TEMP, 'zz-source.mp4')), false,
      'video nguồn đã chép sang temp phải bị xoá');
    assert.strictEqual(fs.existsSync(path.join(TEST_TEMP, 'editing_assets', 'overlay.mp4')), false,
      'asset overlay trong editing_assets phải bị xoá');

    // 2. ensureDirs() vẫn chạy: dự án mới cần bộ thư mục có sẵn.
    ['thumbnails', 'editing_assets'].forEach((name) => {
      assert.strictEqual(fs.existsSync(path.join(TEST_TEMP, name)), true, `phải dựng lại ${name}/`);
    });

    // 3. Mục bị giữ phải được BÁO RA, không im lặng.
    if (fs.existsSync(busyDir)) {
      assert.deepStrictEqual(leftovers, [BUSY_NAME],
        'mục không xoá được phải nằm trong leftovers để renderer nói cho người dùng');
    } else {
      assert.deepStrictEqual(leftovers, [], 'nền tảng xoá được thư mục đang dùng -> không có leftovers');
    }

    // 4. Không còn ai giữ nữa -> dọn lại là sạch hẳn, không báo gì.
    const again = await fetch(`${baseUrl}/api/reset-project`, { method: 'POST' });
    const againData = await again.json();
    assert.deepStrictEqual(againData.leftovers || [], [], 'không còn ai giữ thì phải xoá sạch');
    assert.strictEqual(fs.existsSync(busyDir), false, 'thư mục vừa được nhả phải bị xoá');

    console.log('reset project leftovers ok');
  } finally {
    try { process.chdir(home); } catch (_) { /* đã về ở trên */ }
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
