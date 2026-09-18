/* CHỐT CÁC BẢO ĐẢM CỦA electron/updater.js.
 *
 * Bộ cập nhật là thứ chạy TRÊN MÁY NGƯỜI DÙNG, tự quyết định lúc nào đóng ứng dụng của họ.
 * Sai một chốt ở đây là mất trắng một lượt xuất video đã chạy cả chục phút, hoặc là app tự
 * đổi phiên bản sau lưng người dùng. Không có cách nào thử tay những ca đó trên máy dev, nên
 * chúng phải được khoá bằng test.
 *
 * KHÔNG dựng cả Electron: nạp module với `require` giả để chạy bằng node thuần, cùng khuôn
 * với tests/scripts/app_settings.js.
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const Module = require('module');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const UPDATER_PATH = path.join(PROJECT_ROOT, 'electron', 'updater.js');

/* ---- Electron giả ---------------------------------------------------------
 * Ghi lại mọi hộp thoại đã hiện và mọi lời gọi quitAndInstall, để bài test khẳng định
 * được "đã hỏi trước khi làm". */
function makeFakeElectron({ isPackaged = true, answers = [] } = {}) {
  const calls = { dialogs: [], quitAndInstall: [], openExternal: [] };
  let answerIndex = 0;
  return {
    calls,
    module: {
      app: {
        isPackaged,
        getVersion: () => '1.1.9',
      },
      dialog: {
        showMessageBox: async (_win, options) => {
          calls.dialogs.push(options);
          const response = answers[answerIndex] ?? 1;
          answerIndex += 1;
          return { response };
        },
      },
      shell: {
        openExternal: async (url) => { calls.openExternal.push(url); },
      },
    },
  };
}

function makeFakeAutoUpdater(overrides = {}) {
  const state = {
    autoDownload: true,            // mặc định THẬT của electron-updater
    autoInstallOnAppQuit: true,    // mặc định THẬT của electron-updater
    logger: null,
    listeners: {},
    quitAndInstallArgs: null,
    downloadCalled: 0,
  };
  return {
    state,
    api: {
      get autoDownload() { return state.autoDownload; },
      set autoDownload(v) { state.autoDownload = v; },
      get autoInstallOnAppQuit() { return state.autoInstallOnAppQuit; },
      set autoInstallOnAppQuit(v) { state.autoInstallOnAppQuit = v; },
      set logger(v) { state.logger = v; },
      get logger() { return state.logger; },
      on: (event, fn) => { state.listeners[event] = fn; },
      checkForUpdates: overrides.checkForUpdates || (async () => ({ updateInfo: { version: '1.1.9' } })),
      downloadUpdate: overrides.downloadUpdate || (async () => { state.downloadCalled += 1; }),
      quitAndInstall: (...args) => { state.quitAndInstallArgs = args; },
    },
  };
}

/* Nạp updater.js với `electron` và `electron-updater` bị thay bằng bản giả. */
function loadUpdater(fakeElectron, fakeAutoUpdater) {
  const original = Module.prototype.require;
  Module.prototype.require = function patched(request) {
    if (request === 'electron') return fakeElectron;
    if (request === 'electron-updater') return { autoUpdater: fakeAutoUpdater };
    return original.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(UPDATER_PATH)];
    return require(UPDATER_PATH);
  } finally {
    Module.prototype.require = original;
  }
}

/* Backend giả, chỉ để trả `export_in_flight`. */
function startFakeBackend(exportInFlight) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/status') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ app: 'crabbycut', export_in_flight: exportInFlight }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
    if (detail !== undefined) console.error('       ', JSON.stringify(detail));
  }
}

async function main() {
  // ---- 1. initUpdater phải TẮT hai hành vi tự động mặc định của electron-updater --------
  {
    const fe = makeFakeElectron();
    const fa = makeFakeAutoUpdater();
    const updater = loadUpdater(fe.module, fa.api);
    updater.initUpdater();
    check('initUpdater tắt autoDownload', fa.state.autoDownload === false, fa.state.autoDownload);
    check('initUpdater tắt autoInstallOnAppQuit', fa.state.autoInstallOnAppQuit === false, fa.state.autoInstallOnAppQuit);
    check('initUpdater đăng ký update-downloaded', typeof fa.state.listeners['update-downloaded'] === 'function');
  }

  // ---- 2. Chạy từ mã nguồn KHÔNG được kiểm tra cập nhật --------------------------------
  {
    const fe = makeFakeElectron({ isPackaged: false });
    let checked = false;
    const fa = makeFakeAutoUpdater({ checkForUpdates: async () => { checked = true; return {}; } });
    const updater = loadUpdater(fe.module, fa.api);
    updater.initUpdater();
    await updater.checkForUpdates(null, 'http://127.0.0.1:1', { silent: true });
    check('bản chạy từ mã nguồn không gọi checkForUpdates', checked === false);
    check('bản chạy từ mã nguồn không hiện hộp thoại nào', fe.calls.dialogs.length === 0, fe.calls.dialogs);
  }

  // ---- 3. Đang ở bản mới nhất + silent -> im lặng tuyệt đối ----------------------------
  {
    const fe = makeFakeElectron();
    const fa = makeFakeAutoUpdater({ checkForUpdates: async () => ({ updateInfo: { version: '1.1.9' } }) });
    const updater = loadUpdater(fe.module, fa.api);
    updater.initUpdater();
    await updater.checkForUpdates(null, 'http://127.0.0.1:1', { silent: true });
    check('đã mới nhất + silent -> không hộp thoại', fe.calls.dialogs.length === 0, fe.calls.dialogs);
  }

  // ---- 4. Đang ở bản mới nhất + người dùng chủ động -> PHẢI trả lời --------------------
  {
    const fe = makeFakeElectron({ answers: [0] });
    const fa = makeFakeAutoUpdater({ checkForUpdates: async () => ({ updateInfo: { version: '1.1.9' } }) });
    const updater = loadUpdater(fe.module, fa.api);
    updater.initUpdater();
    await updater.checkForUpdates(null, 'http://127.0.0.1:1', { silent: false });
    check('đã mới nhất + chủ động -> có trả lời', fe.calls.dialogs.length === 1, fe.calls.dialogs.length);
  }

  // ---- 5. Có bản mới nhưng người dùng chọn "Để sau" -> KHÔNG tải -----------------------
  {
    const fe = makeFakeElectron({ answers: [1] });          // 1 = Để sau
    const fa = makeFakeAutoUpdater({ checkForUpdates: async () => ({ updateInfo: { version: '1.2.0' } }) });
    const updater = loadUpdater(fe.module, fa.api);
    updater.initUpdater();
    await updater.checkForUpdates(null, 'http://127.0.0.1:1', { silent: true });
    check('có bản mới -> hỏi trước khi tải', fe.calls.dialogs.length === 1, fe.calls.dialogs.length);
    check('chọn "Để sau" -> KHÔNG tải', fa.state.downloadCalled === 0, fa.state.downloadCalled);
    check('chọn "Để sau" -> KHÔNG cài', fa.state.quitAndInstallArgs === null);
  }

  // ---- 6. CHỐT QUAN TRỌNG NHẤT: đang xuất video thì KHÔNG được khởi động lại -----------
  {
    const { server, origin } = await startFakeBackend(true);
    const fe = makeFakeElectron({ answers: [0, 0] });       // Tải -> (sẽ bị chặn trước khi hỏi cài)
    const fa = makeFakeAutoUpdater({ checkForUpdates: async () => ({ updateInfo: { version: '1.2.0' } }) });
    const updater = loadUpdater(fe.module, fa.api);
    updater.initUpdater();
    fa.state.listeners['update-downloaded']({ version: '1.2.0' });   // giả lập tải xong
    await updater.checkForUpdates(null, origin, { silent: true });
    server.close();

    check('đang xuất video -> KHÔNG gọi quitAndInstall', fa.state.quitAndInstallArgs === null, fa.state.quitAndInstallArgs);
    const busyDialog = fe.calls.dialogs.find((d) => /đang xuất video/i.test(d.title || ''));
    check('đang xuất video -> báo cho người dùng biết', !!busyDialog, fe.calls.dialogs.map((d) => d.title));
    check('đang xuất video -> hoãn sang lúc thoát', fa.state.autoInstallOnAppQuit === true);
  }

  // ---- 7. KHÔNG bận + người dùng đồng ý -> mới được cài --------------------------------
  {
    const { server, origin } = await startFakeBackend(false);
    const fe = makeFakeElectron({ answers: [0, 0] });       // Tải -> Cài đặt và khởi động lại
    const fa = makeFakeAutoUpdater({ checkForUpdates: async () => ({ updateInfo: { version: '1.2.0' } }) });
    const updater = loadUpdater(fe.module, fa.api);
    updater.initUpdater();
    fa.state.listeners['update-downloaded']({ version: '1.2.0' });
    await updater.checkForUpdates(null, origin, { silent: true });
    server.close();

    check('không bận + đồng ý -> có gọi quitAndInstall', fa.state.quitAndInstallArgs !== null);
    check('quitAndInstall(isSilent=false) — bộ cài phải hiện giao diện',
      fa.state.quitAndInstallArgs && fa.state.quitAndInstallArgs[0] === false, fa.state.quitAndInstallArgs);
    check('quitAndInstall(isForceRunAfter=true) — mở lại app sau khi cài',
      fa.state.quitAndInstallArgs && fa.state.quitAndInstallArgs[1] === true, fa.state.quitAndInstallArgs);
  }

  // ---- 8. Backend không trả lời -> coi như KHÔNG bận, đừng chặn người dùng -------------
  {
    const fe = makeFakeElectron({ answers: [0, 1] });       // Tải -> Để lần sau
    const fa = makeFakeAutoUpdater({ checkForUpdates: async () => ({ updateInfo: { version: '1.2.0' } }) });
    const updater = loadUpdater(fe.module, fa.api);
    updater.initUpdater();
    fa.state.listeners['update-downloaded']({ version: '1.2.0' });
    // Cổng 1 chắc chắn không có ai nghe.
    await updater.checkForUpdates(null, 'http://127.0.0.1:1', { silent: true });
    const installDialog = fe.calls.dialogs.find((d) => /sẵn sàng/i.test(d.title || ''));
    check('backend im lặng -> vẫn hỏi cài (không chặn oan)', !!installDialog, fe.calls.dialogs.map((d) => d.title));
  }

  // ---- 9. Tải thất bại -> báo lỗi, không cài ------------------------------------------
  {
    const fe = makeFakeElectron({ answers: [0, 0] });
    const fa = makeFakeAutoUpdater({
      checkForUpdates: async () => ({ updateInfo: { version: '1.2.0' } }),
      downloadUpdate: async () => { throw new Error('mạng đứt'); },
    });
    const updater = loadUpdater(fe.module, fa.api);
    updater.initUpdater();
    await updater.checkForUpdates(null, 'http://127.0.0.1:1', { silent: true });
    const errorDialog = fe.calls.dialogs.find((d) => d.type === 'error');
    check('tải hỏng -> báo lỗi cho người dùng', !!errorDialog, fe.calls.dialogs.map((d) => d.type));
    check('tải hỏng -> KHÔNG cài', fa.state.quitAndInstallArgs === null);
  }

  console.log('');
  if (failures) {
    console.error(`updater guards: ${failures} bài KHÔNG đạt`);
    process.exit(1);
  }
  console.log('updater guards ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
