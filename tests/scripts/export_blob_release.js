/* =====================================================================
 * ĐƯỜNG XUẤT DỰ PHÒNG (tải bản xuất về Blob) PHẢI THU HỒI blob: URL KHI LƯU XONG
 *
 * Không thu hồi thì Chromium giữ cả tệp trong <userData>/blob_storage tới khi tắt app — mỗi
 * lượt xuất thêm một bản (đo 11 GB sau lượt 39 phút; kiểm thật 2026-10-10 trong Electron: tệp
 * 700 MB tải từ backend -> đối chứng giữ 728 MB sau GC, bản sửa về 0). Thu hồi NGAY sau click lại
 * làm hỏng lượt lưu còn chờ hộp thoại, nên main báo khi DownloadItem `done`.
 *
 * Hàm thật chạy trong VM:
 *   A. electron/main.js watchBlobDownloads: chỉ blob:, báo đúng trang sau `done`, không báo khi
 *      trang đã đóng, gắn một lần cho mỗi session (createWindow chạy lại được);
 *   B. index.html releaseExportBlobUrlWhenSaved: Electron -> chờ đúng URL rồi mới thu hồi, URL
 *      khác/lạ không bị đụng; trình duyệt thường -> thu hồi sau một phút; lượt xuất dự phòng gọi nó.
 *
 * Chạy: npm run test:export-blob-release
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');

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

function fakeSession() {
  const handlers = [];
  return { handlers, on(evt, fn) { if (evt === 'will-download') handlers.push(fn); } };
}
function fakeItem(url) {
  const done = [];
  return { getURL: () => url, once(evt, fn) { if (evt === 'done') done.push(fn); }, finish() { done.forEach((fn) => fn()); } };
}
function fakeContents() {
  return { sent: [], destroyed: false, isDestroyed() { return this.destroyed; }, send(ch, url) { this.sent.push([ch, url]); } };
}

// --- A: main process ---
{
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(`const watchedDownloadSessions = new WeakSet();\n${extractFunction(MAIN, 'watchBlobDownloads')}\nglobalThis.watch = watchBlobDownloads;`, sb);
  const ses = fakeSession();
  sb.watch(ses);
  sb.watch(ses);
  assert.strictEqual(ses.handlers.length, 1, 'gắn will-download MỘT lần cho mỗi session (createWindow chạy lại)');
  const contents = fakeContents();
  const blobItem = fakeItem('blob:http://127.0.0.1:8000/abc');
  ses.handlers[0]({}, blobItem, contents);
  assert.deepStrictEqual(contents.sent, [], 'chưa báo khi lượt tải còn chờ hộp thoại lưu');
  blobItem.finish();
  assert.deepStrictEqual(contents.sent, [['blob-download-done', 'blob:http://127.0.0.1:8000/abc']], 'báo đúng URL khi xong');
  const httpItem = fakeItem('http://127.0.0.1:8000/file.mp4');
  ses.handlers[0]({}, httpItem, contents);
  httpItem.finish();
  assert.strictEqual(contents.sent.length, 1, 'tải http: không liên quan');
  const closed = fakeContents();
  const late = fakeItem('blob:x');
  ses.handlers[0]({}, late, closed);
  closed.destroyed = true;
  assert.doesNotThrow(() => late.finish(), 'trang đã đóng: không gửi, không ném lỗi');
  assert.deepStrictEqual(closed.sent, []);
  assert.ok(/watchBlobDownloads\(mainWindow\.webContents\.session\)/.test(extractFunction(MAIN, 'createWindow')),
    'createWindow phải gắn watchBlobDownloads');
  assert.ok(/onBlobDownloadDone[\s\S]{0,120}ipcRenderer\.on\('blob-download-done'/.test(PRELOAD), 'preload phải nối kênh blob-download-done');
  console.log('  ok  main: chỉ blob:, báo khi done, một lần mỗi session, trang đóng thì thôi');
}

// --- B: renderer ---
function rendererSandbox(withDesktop) {
  const revoked = [];
  const timers = [];
  let listener = null;
  const sb = {
    revoked, timers,
    URL: { revokeObjectURL: (u) => revoked.push(u) },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    window: withDesktop ? { desktopEnv: { onBlobDownloadDone: (cb) => { listener = cb; } } } : {},
  };
  vm.createContext(sb);
  const start = INDEX.indexOf('const pendingExportBlobUrls = new Set();');
  assert.notStrictEqual(start, -1, 'index.html phải có pendingExportBlobUrls');
  const fn = extractFunction(INDEX, 'releaseExportBlobUrlWhenSaved');
  const setup = INDEX.slice(start, INDEX.indexOf('function releaseExportBlobUrlWhenSaved', start));
  vm.runInContext(`${setup}\n${fn}\nglobalThis.release = releaseExportBlobUrlWhenSaved; globalThis.pending = pendingExportBlobUrls;`, sb);
  sb.fire = (url) => listener(url);
  return sb;
}
{
  const sb = rendererSandbox(true);
  sb.release('blob:a');
  sb.release('blob:b');
  assert.deepStrictEqual(sb.revoked, [], 'Electron: KHÔNG thu hồi ngay (hộp thoại lưu còn mở)');
  assert.strictEqual(sb.timers.length, 0);
  sb.fire('blob:a');
  assert.deepStrictEqual(sb.revoked, ['blob:a'], 'thu hồi đúng URL vừa lưu xong');
  sb.fire('blob:zzz');
  assert.deepStrictEqual(sb.revoked, ['blob:a'], 'URL không phải bản xuất: không đụng');
  sb.fire('blob:a');
  assert.deepStrictEqual(sb.revoked, ['blob:a'], 'không thu hồi hai lần');
  assert.strictEqual(sb.pending.size, 1);

  const web = rendererSandbox(false);
  web.release('blob:w');
  assert.deepStrictEqual(web.revoked, []);
  assert.strictEqual(web.timers.length, 1);
  assert.ok(web.timers[0].ms >= 30000, 'trình duyệt thường: thu hồi sau khi tải đã bắt đầu');
  web.timers[0].fn();
  assert.deepStrictEqual(web.revoked, ['blob:w']);

  const fallback = INDEX.slice(INDEX.indexOf('const exportBlob = await response.blob();'));
  assert.ok(/a\.click\(\);\s*releaseExportBlobUrlWhenSaved\(a\.href\);/.test(fallback.slice(0, 1500)),
    'đường tải về dự phòng của performVideoExport phải gọi releaseExportBlobUrlWhenSaved sau click');
  console.log('  ok  renderer: Electron chờ main báo đúng URL; web thu hồi sau một phút; đường dự phòng có gọi');
}
console.log('export blob release ok');
