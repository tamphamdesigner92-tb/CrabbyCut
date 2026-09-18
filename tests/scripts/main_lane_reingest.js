/* THỨ TỰ NỐI VIDEO cho lane chính dựng tay ở Editing.
 *
 * Vì sao có test này: `collectVideosFromSourcePaths` SẮP THEO TÊN FILE ở cuối hàm. Thứ tự
 * nối quyết định mốc thời gian của từng đoạn trong temp_input.mp4, mà lane chính của
 * Editing trỏ thẳng vào các mốc đó. Người dùng dựng trên "z.mp4" rồi thêm "a.mp4" — sắp
 * theo tên là "a" nhảy lên đầu, mọi clip lane chính và mọi overlay lệch chỗ mà KHÔNG có
 * lỗi nào báo. Cờ `preserveOrder` sinh ra để chặn đúng ca đó.
 *
 * Đo 3 điều:
 *   1. preserveOrder BẬT -> giữ nguyên thứ tự người gọi đưa xuống;
 *   2. preserveOrder TẮT (mặc định) -> vẫn sắp theo tên, giữ nguyên hành vi của hai người
 *      gọi cũ (mở lại .crab, /api/transcribe-local) — đây là phần chống hồi quy;
 *   3. thư mục vẫn được đọc theo tên bên trong nó, và file trùng bị khử một lần.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_TEMP = path.join(__dirname, '..', '..', 'test_temp', 'main_lane_reingest');
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || TEST_TEMP;

const { collectVideosFromSourcePaths } = require('../../backend/server');

const FIXTURE = path.join(TEST_TEMP, 'fixture');

// Video giả: chỉ cần tồn tại + đúng phần mở rộng. Test này đo THỨ TỰ, không giải mã gì.
function writeFake(relPath) {
  const full = path.join(FIXTURE, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(64, 7));
  return full;
}

function main() {
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  const z = writeFake('z.mp4');
  const a = writeFake('a.mp4');
  const m = writeFake('m.mov');

  // --- 1: giữ nguyên thứ tự người dùng thêm ---
  const kept = collectVideosFromSourcePaths([z, a, m], { preserveOrder: true });
  assert.deepStrictEqual(
    kept.map((p) => path.basename(p)),
    ['z.mp4', 'a.mp4', 'm.mov'],
    'preserveOrder phải giữ đúng thứ tự đưa xuống',
  );

  // Thêm "a.mp4" SAU khi đã dựng trên "z.mp4" -> a phải nằm SAU, nếu không mốc của z đổi.
  const appended = collectVideosFromSourcePaths([z, a], { preserveOrder: true });
  assert.deepStrictEqual(appended.map((p) => path.basename(p)), ['z.mp4', 'a.mp4']);
  assert.strictEqual(appended[0], kept[0], 'video cũ phải giữ nguyên vị trí đầu tiên');

  // --- 2: mặc định KHÔNG đổi (chống hồi quy cho mở .crab + /api/transcribe-local) ---
  const sorted = collectVideosFromSourcePaths([z, a, m]);
  assert.deepStrictEqual(
    sorted.map((p) => path.basename(p)),
    ['a.mp4', 'm.mov', 'z.mp4'],
    'không truyền cờ thì vẫn sắp theo tên như trước',
  );

  // --- 3: thư mục đọc theo tên bên trong; file trùng khử một lần ---
  writeFake(path.join('Day1', 'b.mp4'));
  writeFake(path.join('Day1', 'a.mp4'));
  const dir = path.join(FIXTURE, 'Day1');
  const fromDir = collectVideosFromSourcePaths([dir], { preserveOrder: true });
  assert.deepStrictEqual(
    fromDir.map((p) => path.basename(p)),
    ['a.mp4', 'b.mp4'],
    'trong MỘT thư mục vẫn sắp theo tên để tất định',
  );

  const deduped = collectVideosFromSourcePaths([z, a, z], { preserveOrder: true });
  assert.deepStrictEqual(deduped.map((p) => path.basename(p)), ['z.mp4', 'a.mp4']);

  // File không tồn tại / không phải video: bỏ qua, không ném.
  const mixed = collectVideosFromSourcePaths(
    [z, path.join(FIXTURE, 'khong-co.mp4'), writeFake('ghi-chu.txt'), a],
    { preserveOrder: true },
  );
  assert.deepStrictEqual(mixed.map((p) => path.basename(p)), ['z.mp4', 'a.mp4']);

  console.log('main lane reingest order ok');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
