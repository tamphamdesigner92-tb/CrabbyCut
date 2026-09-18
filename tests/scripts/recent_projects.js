/* DANH MỤC "DỰ ÁN GẦN ĐÂY" (electron/recent-projects.js).
 *
 * Đây là thứ duy nhất nhớ được người dùng đã làm những dự án nào — tệp .crab nằm rải rác
 * do họ tự chọn nơi lưu. Hỏng danh mục là màn hình Home trống trơn.
 *
 * Mệnh đề quan trọng nhất là #6: `remove()` KHÔNG được đụng tệp .crab. "Gỡ khỏi danh sách
 * gần đây" và "xoá dự án" là hai việc hoàn toàn khác nhau; lẫn lộn là mất việc của người
 * dùng vĩnh viễn.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { createRecentStore } = require('../../electron/recent-projects.js');

const TEST_TEMP = path.join(__dirname, '..', '..', 'test_temp', 'recent_projects');
const PROJECTS = path.join(TEST_TEMP, 'projects');

// JPEG 1x1 hợp lệ — chỉ cần vài byte có thật để kiểm việc ghi/đọc/xoá ảnh đại diện.
const THUMB_A = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==', 'base64');
const THUMB_B = Buffer.concat([THUMB_A, Buffer.from([0])]);

function fakeProject(name) {
  const full = path.join(PROJECTS, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(128, 3));
  return full;
}

function main() {
  fs.rmSync(TEST_TEMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TEMP, { recursive: true });
  const store = createRecentStore({ baseDir: TEST_TEMP, maxItems: 3 });

  const p1 = fakeProject('Tap01.crab');
  const p2 = fakeProject('Tap02.crab');

  // --- 1: thêm mục, mới nhất đứng trước ---
  store.touch({ path: p1, savedAt: 1000 });
  store.touch({ path: p2, savedAt: 2000 });
  let items = store.list();
  assert.deepStrictEqual(items.map((i) => i.name), ['Tap02', 'Tap01'], 'mới nhất phải đứng trước');
  assert.strictEqual(items[0].exists, true);
  assert.ok(items[0].size_bytes > 0, 'phải đọc được kích thước tệp');

  // --- 2: touch lại KHÔNG sinh mục trùng, nhảy lên đầu ---
  store.touch({ path: p1, savedAt: 3000 });
  items = store.list();
  assert.strictEqual(items.length, 2, 'không được sinh mục trùng');
  assert.strictEqual(items[0].name, 'Tap01');

  // --- 3: chuẩn hoá đường dẫn -> vẫn là MỘT mục ---
  const weird = path.join(PROJECTS, '..', 'projects', 'Tap01.crab');
  store.touch({ path: weird, savedAt: 4000 });
  assert.strictEqual(store.list().length, 2, 'đường dẫn vòng vèo phải ra cùng một mục');
  if (process.platform === 'darwin' || process.platform === 'win32') {
    store.touch({ path: path.join(PROJECTS, 'TAP01.CRAB'), savedAt: 4100 });
    assert.strictEqual(store.list().length, 2, 'khác hoa/thường trên FS này phải ra cùng một mục');
    // Cách viết dùng lần cuối thắng (tên hiển thị đi theo đường dẫn vừa mở) — ghi lại bằng
    // cách viết chuẩn để các bước sau đọc tên quen thuộc.
    store.touch({ path: p1, savedAt: 4200 });
  }

  // --- 4: vượt maxItems -> cắt đúng số VÀ xoá ảnh của mục bị cắt ---
  const p3 = fakeProject('Tap03.crab');
  const p4 = fakeProject('Tap04.crab');
  store.touch({ path: p3, savedAt: 5000, thumbBase64: THUMB_A.toString('base64') });
  const idP3 = store.keyOf(p3);
  assert.ok(fs.existsSync(path.join(store.thumbDir, `${idP3}.jpg`)), 'phải ghi ảnh đại diện');
  store.touch({ path: p4, savedAt: 6000 });
  items = store.list();
  assert.strictEqual(items.length, 3, `maxItems=3 phải cắt bớt (đang có ${items.length})`);
  assert.deepStrictEqual(items.map((i) => i.name), ['Tap04', 'Tap03', 'Tap01']);
  // Tap02 bị cắt -> ảnh của nó (nếu có) phải biến mất; kiểm bằng số tệp trong thumbDir
  const thumbFiles = fs.existsSync(store.thumbDir) ? fs.readdirSync(store.thumbDir) : [];
  assert.deepStrictEqual(thumbFiles, [`${idP3}.jpg`], 'chỉ còn ảnh của mục còn trong danh sách');

  // --- 5: thumbBase64 = null GIỮ NGUYÊN ảnh cũ; có giá trị thì ghi đè ---
  store.touch({ path: p3, savedAt: 7000 });
  assert.ok(store.readThumb(idP3)?.equals(THUMB_A), 'null phải giữ nguyên ảnh cũ');
  store.touch({ path: p3, savedAt: 7100, thumbBase64: THUMB_B.toString('base64') });
  assert.ok(store.readThumb(idP3)?.equals(THUMB_B), 'có ảnh mới thì phải ghi đè');
  assert.strictEqual(store.list().find((i) => i.id === idP3).thumb, `${idP3}.jpg`);

  // --- 6: remove() gỡ khỏi danh sách nhưng KHÔNG xoá tệp .crab ---
  assert.strictEqual(store.remove(idP3), true);
  assert.strictEqual(store.list().some((i) => i.id === idP3), false, 'mục phải biến mất');
  assert.strictEqual(store.readThumb(idP3), null, 'ảnh đại diện phải bị xoá');
  assert.strictEqual(fs.existsSync(p3), true, 'TỆP .crab PHẢI CÒN NGUYÊN');
  assert.strictEqual(store.remove('khong-co-id'), false);

  // --- 7: tệp .crab bị xoá/di chuyển -> exists:false, KHÔNG tự gỡ khỏi danh sách ---
  fs.rmSync(p4);
  items = store.list();
  const gone = items.find((i) => i.name === 'Tap04');
  assert.ok(gone, 'mục mất tệp vẫn phải nằm trong danh sách (ổ ngoài có thể đang rút ra)');
  assert.strictEqual(gone.exists, false);

  // --- 8: JSON rác -> tự phục hồi, không ném ---
  fs.writeFileSync(store.indexPath, '{ day khong phai json', 'utf8');
  assert.deepStrictEqual(store.list(), [], 'danh mục hỏng phải trả rỗng');
  store.touch({ path: p1, savedAt: 8000 });
  assert.strictEqual(store.list().length, 1, 'ghi tiếp được sau khi danh mục hỏng');

  // --- 9: không sót tệp .tmp (ghi phải nguyên tử) ---
  const leftovers = fs.readdirSync(TEST_TEMP).filter((n) => n.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], 'không được để lại tệp .tmp');

  // --- 10: ảnh mồ côi bị dọn ---
  fs.mkdirSync(store.thumbDir, { recursive: true });
  fs.writeFileSync(path.join(store.thumbDir, 'mo-coi.jpg'), THUMB_A);
  store.touch({ path: p1, savedAt: 9000 });
  assert.strictEqual(fs.existsSync(path.join(store.thumbDir, 'mo-coi.jpg')), false, 'ảnh mồ côi phải bị dọn');

  console.log('recent projects ok');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
