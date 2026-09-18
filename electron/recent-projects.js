/* DANH MỤC "DỰ ÁN GẦN ĐÂY" cho màn hình Home.
 *
 * Người dùng vẫn TỰ CHỌN nơi lưu tệp .crab (không có thư mục dự án do ứng dụng quản lý),
 * nên Home không thể quét một thư mục nào cả — nó phải nhớ những gì đã Lưu/Mở. Danh mục
 * này chính là bộ nhớ đó, cộng thêm ảnh đại diện chụp lúc lưu.
 *
 * ĐẶT Ở userData, KHÔNG phải temp_uploads: /api/reset-project xoá sạch temp_uploads mỗi lần
 * tạo dự án mới — ảnh đại diện của mọi dự án sẽ bay theo.
 *
 * `baseDir` nhận qua tham số (không tự gọi app.getPath) để test bằng node thuần được,
 * cùng khuôn với electron/crab-format.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INDEX_NAME = 'recent-projects.json';
const THUMB_DIR_NAME = 'project-thumbs';
const INDEX_VERSION = 1;

// Hai hệ tệp mặc định của macOS/Windows KHÔNG phân biệt hoa thường: cùng một tệp mở bằng
// hai cách viết khác nhau phải ra cùng một mục, nếu không Home hiện hai thẻ trùng.
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function canonicalPath(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

function keyOf(filePath) {
  return crypto.createHash('sha256').update(canonicalPath(filePath)).digest('hex').slice(0, 16);
}

function projectNameOf(filePath) {
  return path.basename(String(filePath || '')).replace(/\.crab$/i, '') || 'Dự án';
}

function createRecentStore({ baseDir, maxItems = 20 } = {}) {
  if (!baseDir) throw new Error('recent-projects: thiếu baseDir');
  const indexPath = path.join(baseDir, INDEX_NAME);
  const thumbDir = path.join(baseDir, THUMB_DIR_NAME);

  function readIndex() {
    // Tệp hỏng/thiếu -> danh sách rỗng chứ KHÔNG ném: đây là tiện ích, hỏng nó không được
    // phép chặn người dùng mở ứng dụng.
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.items)) return { version: INDEX_VERSION, items: [] };
      return { version: INDEX_VERSION, items: parsed.items.filter((it) => it && it.path && it.id) };
    } catch (_) {
      return { version: INDEX_VERSION, items: [] };
    }
  }

  function writeIndex(data) {
    fs.mkdirSync(baseDir, { recursive: true });
    // .tmp rồi rename như writeCrabFile: cắt điện giữa chừng thì mất bản ghi mới, chứ
    // không để lại một tệp JSON cụt làm hỏng cả danh mục.
    const tmp = `${indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, indexPath);
  }

  function thumbPath(id) {
    return path.join(thumbDir, `${id}.jpg`);
  }

  function removeThumb(id) {
    try { fs.rmSync(thumbPath(id), { force: true }); } catch (_) { /* không có thì thôi */ }
  }

  // Ảnh của mục đã bị cắt khỏi danh mục (hoặc sót lại từ bản cũ) thì dọn — nếu không thư
  // mục cứ phình ra mãi mà không ai nhìn tới.
  function pruneOrphanThumbs(items) {
    let names = [];
    try { names = fs.readdirSync(thumbDir); } catch (_) { return; }
    const alive = new Set(items.map((it) => `${it.id}.jpg`));
    for (const name of names) {
      if (!alive.has(name)) {
        try { fs.rmSync(path.join(thumbDir, name), { force: true }); } catch (_) { /* bỏ qua */ }
      }
    }
  }

  function list() {
    const items = readIndex().items.slice().sort((a, b) => (b.touched_at || 0) - (a.touched_at || 0));
    return items.map((it) => {
      let exists = false;
      let sizeBytes = it.size_bytes || 0;
      try {
        const stat = fs.statSync(it.path);
        exists = stat.isFile();
        if (exists) sizeBytes = stat.size;
      } catch (_) { exists = false; }
      return { ...it, size_bytes: sizeBytes, exists };
    });
  }

  /* Ghi nhận một dự án vừa được Lưu/Mở. `thumbBase64 = null` -> GIỮ NGUYÊN ảnh cũ (autosave
   * gọi hàm này thường xuyên nhưng chỉ thỉnh thoảng mới chụp lại ảnh). */
  function touch({ path: filePath, name, savedAt, thumbBase64 } = {}) {
    if (!filePath) return null;
    const id = keyOf(filePath);
    const data = readIndex();
    const now = Number(savedAt) || Date.now();
    const existing = data.items.find((it) => it.id === id);
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(filePath).size; } catch (_) { sizeBytes = existing?.size_bytes || 0; }

    if (thumbBase64) {
      fs.mkdirSync(thumbDir, { recursive: true });
      fs.writeFileSync(thumbPath(id), Buffer.from(String(thumbBase64), 'base64'));
    }
    const hasThumb = (thumbBase64 ? true : !!existing?.thumb) && fs.existsSync(thumbPath(id));
    const entry = {
      id,
      path: path.resolve(filePath),
      name: String(name || '') || projectNameOf(filePath),
      saved_at: now,
      touched_at: now,
      size_bytes: sizeBytes,
      thumb: hasThumb ? `${id}.jpg` : '',
    };
    const items = data.items.filter((it) => it.id !== id);
    items.unshift(entry);
    items.sort((a, b) => (b.touched_at || 0) - (a.touched_at || 0));
    const kept = items.slice(0, Math.max(1, maxItems));
    for (const dropped of items.slice(kept.length)) removeThumb(dropped.id);
    writeIndex({ version: INDEX_VERSION, items: kept });
    pruneOrphanThumbs(kept);
    return entry;
  }

  /* Gỡ khỏi DANH SÁCH. Chỉ xoá ảnh đại diện — TUYỆT ĐỐI không đụng tệp .crab của người
   * dùng: "gỡ khỏi danh sách gần đây" và "xoá dự án" là hai việc hoàn toàn khác nhau. */
  function remove(id) {
    const data = readIndex();
    const items = data.items.filter((it) => it.id !== id);
    if (items.length === data.items.length) return false;
    removeThumb(id);
    writeIndex({ version: INDEX_VERSION, items });
    return true;
  }

  function readThumb(id) {
    try { return fs.readFileSync(thumbPath(id)); } catch (_) { return null; }
  }

  return { list, touch, remove, readThumb, keyOf, indexPath, thumbDir };
}

/* Đăng ký 3 kênh IPC của danh mục. Tách khỏi main.js để test gọi được ĐÚNG mã chạy thật
 * (main.js không require được trong test: nạp nó là khởi động cả ứng dụng).
 * `getBaseDir` là hàm chứ không phải chuỗi vì app.getPath('userData') chỉ chắc chắn đúng
 * sau khi app ready, mà mọi handler đều chạy sau đó. */
function registerRecentProjectIpc(ipcMain, getBaseDir) {
  let store = null;
  const recents = () => (store || (store = createRecentStore({ baseDir: getBaseDir() })));

  ipcMain.handle('recent-projects-list', async () => {
    try {
      const items = recents().list().map((item) => {
        // Trả ẢNH KÈM THEO dạng data URL: trang chạy trên origin http://127.0.0.1 nên
        // <img src="file:///…"> bị chặn. 20 ảnh ~25KB, chỉ đọc một lần lúc mở Home.
        const buf = item.thumb ? recents().readThumb(item.id) : null;
        return {
          ...item,
          thumb_data_url: buf && buf.length < 400000 ? `data:image/jpeg;base64,${buf.toString('base64')}` : null,
        };
      });
      return { items };
    } catch (error) {
      return { error: 'list_failed', detail: String(error?.message || error), items: [] };
    }
  });

  ipcMain.handle('recent-projects-touch', async (_event, entry) => {
    try { return { entry: recents().touch(entry || {}) }; }
    catch (error) { return { error: 'touch_failed', detail: String(error?.message || error) }; }
  });

  // CHỈ gỡ khỏi danh sách + xoá ảnh đại diện. KHÔNG BAO GIỜ đụng tệp .crab của người dùng.
  ipcMain.handle('recent-projects-remove', async (_event, { id } = {}) => {
    try { return { removed: recents().remove(String(id || '')) }; }
    catch (error) { return { error: 'remove_failed', detail: String(error?.message || error) }; }
  });
}

module.exports = { createRecentStore, registerRecentProjectIpc, keyOf, projectNameOf };
