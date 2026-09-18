const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { writeCrabFile, readCrabFile, fingerprintFile } = require('./crab-format');
const {
  packageProject, resolvePayloadPaths, writeSrtTo, projectSidecarPath, SIDECAR_PREVIEW_PROXY,
} = require('./project-package');
const { registerRecentProjectIpc } = require('./recent-projects');
const { runSetupWindow } = require('./setup-window');
const RuntimePaths = require('../scripts/runtime_paths.js');

/* CHẾ ĐỘ THIẾT LẬP — bộ cài .exe gọi `CrabbyCut.exe --setup-runtime` rồi CHỜ (xem
 * build/installer.nsh). Ở chế độ này KHÔNG dựng backend và KHÔNG mở cửa sổ chính: chỉ chạy
 * cửa sổ thiết lập rồi thoát, để NSIS biết bước cài môi trường đã kết thúc. */
const SETUP_MODE = process.argv.includes('--setup-runtime');

/* DỮ LIỆU NGƯỜI DÙNG RA NGOÀI THƯ MỤC CÀI ĐẶT — CHỈ Ở BẢN ĐÓNG GÓI.
 *
 * Trình gỡ cài đặt của electron-builder, ở nhánh CẬP NHẬT, dời toàn bộ $INSTDIR sang thư
 * mục tạm rồi `RMDir /r $INSTDIR`, không chừa ngoại lệ nào (xem
 * node_modules/app-builder-lib/templates/nsis/uninstaller.nsh). Mọi thứ của người dùng để
 * trong đó sẽ mất ở lần tự cập nhật ĐẦU TIÊN: cài đặt ứng dụng, thư viện tài nguyên họ tự
 * thêm, báo cáo dự án, cache bóc băng (tốn hàng chục phút dựng lại).
 *
 * ĐẶT VÀO `process.env` NGAY ĐÂY, TRƯỚC MỌI THỨ KHÁC. Hai bên cùng đọc biến này:
 *   - backend (tiến trình con) thừa hưởng qua `{...process.env}` lúc spawn;
 *   - electron/project-package.js chạy ngay trong tiến trình này.
 * Đặt muộn hơn thì bên nào đọc trước sẽ chốt nhầm đường dẫn cũ — lỗi phụ thuộc thứ tự nạp,
 * kiểu lỗi không ai truy ra được.
 *
 * KHÔNG đặt khi chạy từ mã nguồn: lúc đó thư viện và cài đặt nằm trong thư mục dự án, và
 * `npm start` phải thấy đúng thứ người phát triển đang sửa. Đây là chỗ DUY NHẤT quyết định. */
if (app.isPackaged) {
  process.env.CRAB_USER_DATA_DIR = RuntimePaths.userDataRoot();
}

// GPU: NGUYÊN NHÂN GỐC của crash "GPU process isn't usable. Goodbye." (SIGTRAP) trên macOS là
// chữ ký ad-hoc của Electron trong node_modules bị HỎNG -> macOS Library Validation từ chối nạp
// libEGL/libGLESv2 ("library load denied by system policy") -> GPU process chết (exit_code=9).
// ĐÃ XỬ LÝ ở scripts/fix_electron_signature.js (chạy trong npm start): ký lại ad-hoc để chữ ký hợp
// lệ -> GPU/WebGL (Metal) hoạt động bình thường, không cần tắt gì.
// Escape hatch: nếu máy nào vẫn lỗi GPU, đặt CRABBYCUT_DISABLE_GPU=1 để chạy software render.
if (process.env.CRABBYCUT_DISABLE_GPU === '1') {
  try { app.disableHardwareAcceleration(); } catch (_) { /* no-op */ }
}

const BACKEND_HOST = '127.0.0.1';
/* CỔNG MẶC ĐỊNH 17219, KHÔNG PHẢI 8000 (đổi 2026-09-10) — xem chú thích ở
 * backend/server.js. Phải KHỚP với hằng bên đó; đổi được bằng BACKEND_PORT. */
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 17219);
const BACKEND_ORIGIN = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
const BACKEND_HEALTH_PATH = '/api/status';
const HEALTH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 400;

let mainWindow = null;
let mainWindowLoaded = false;
let pendingOpenPath = null;
// Đã hỏi xong "còn thay đổi chưa lưu?" -> lần `close` sau đi thẳng, không hỏi lại (nếu
// không thì mainWindow.close() bên trong handler lại kích hoạt chính handler đó).
let forceClose = false;
let backendProcess = null;
let isExternalBackend = false;
let isQuitting = false;
let shutdownInProgress = false;
let signalShutdownInProgress = false;
/* Đóng cửa sổ TỪ TRANG CHỦ thì thoát hẳn app. macOS thường giữ app sống trong Dock
 * (window-all-closed cố ý không quit) nhưng người dùng chốt: nút đỏ ở Trang chủ là kết
 * thúc. Cờ này để window-all-closed biết lần đóng vừa rồi là "kết thúc thật". */
let quitAfterWindowClose = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* "Backend đã sống chưa" = CÓ ĐÚNG BACKEND CỦA CRABBYCUT trả lời không, chứ không phải
 * "cổng có ai trả lời không". Bản cũ nhận mọi mã 200..499, nên một tiến trình lạ đang giữ
 * cổng (đo được: "Dynamic AI Learning Hub" chạy `python backend.py`, trả 404 cho
 * /api/status) bị coi là backend của mình -> ensureBackendReady() đặt isExternalBackend =
 * true, KHÔNG dựng sidecar, rồi loadURL vào đó và cửa sổ CrabbyCut hiện ra giao diện của
 * app kia. Nay phải ĐỌC BODY và thấy đúng chữ ký `app:'crabbycut'` mới tính là sống.
 * Body giới hạn 64KB: một tiến trình lạ có thể trả về một luồng vô tận. */
function checkBackendHealth(requestTimeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: BACKEND_HOST,
        port: BACKEND_PORT,
        path: BACKEND_HEALTH_PATH,
        method: 'GET',
      },
      (res) => {
        if (!(res.statusCode >= 200 && res.statusCode < 300)) {
          res.resume();
          resolve(false);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 65536) { req.destroy(); resolve(false); }
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body)?.app === 'crabbycut');
          } catch (_) {
            resolve(false);
          }
        });
        res.on('error', () => resolve(false));
      }
    );

    req.on('error', () => resolve(false));
    req.setTimeout(requestTimeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function startBackendSidecar() {
  const projectRoot = path.resolve(__dirname, '..');
  const nodeCommand = process.env.BACKEND_NODE || process.execPath;
  const backendScript = path.join(projectRoot, 'backend', 'server.js');
  const env = {
    ...process.env,
    BACKEND_HOST,
    BACKEND_PORT: String(BACKEND_PORT),
  };

  if (!process.env.BACKEND_NODE) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  // CRAB_USER_DATA_DIR đi theo `...process.env` ở trên — đặt một lần ở đầu tệp này.

  backendProcess = spawn(nodeCommand, [backendScript], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk}`);
  });

  backendProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend:err] ${chunk}`);
  });
}

async function ensureBackendReady() {
  const alreadyRunning = await checkBackendHealth();
  if (alreadyRunning) {
    isExternalBackend = true;
    return;
  }

  startBackendSidecar();

  const startedAt = Date.now();
  while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
    if (backendProcess && backendProcess.exitCode !== null) {
      throw new Error(`Backend sidecar exited early with code ${backendProcess.exitCode}`);
    }

    if (await checkBackendHealth()) {
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('Backend health-check timed out.');
}

async function stopBackendSidecar() {
  if (!backendProcess || isExternalBackend) return;

  const proc = backendProcess;
  backendProcess = null;

  if (proc.exitCode !== null || proc.killed) return;

  proc.kill('SIGTERM');

  await Promise.race([
    new Promise((resolve) => proc.once('exit', resolve)),
    sleep(5000),
  ]);

  if (proc.exitCode === null && !proc.killed) {
    proc.kill('SIGKILL');
  }
}

function createWindow() {
  /* GỠ HẲN MENU MẶC ĐỊNH CỦA ELECTRON.
   * `autoHideMenuBar` chỉ ẩn chứ không xoá: bấm Alt là File/Edit/View/Window/Help lại
   * bung ra, chèn thêm một dải cao phía trên header nên toàn bộ giao diện nhảy/giật.
   * Alt còn là phím bổ trợ của timeline (cuộn ngang), nên phải xoá menu chứ không thể
   * chỉ ẩn. setApplicationMenu(null) gỡ luôn nên Alt không còn gì để bung ra. */
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: '#111214',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    // Chốt thêm ở cấp cửa sổ, phòng khi có menu được gắn lại về sau.
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindowLoaded = false;
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindowLoaded = true;
    if (pendingOpenPath) {
      const filePath = pendingOpenPath;
      pendingOpenPath = null;
      mainWindow.webContents.send('open-project-file', filePath);
    }
  });

  mainWindow.loadURL(BACKEND_ORIGIN);

  /* CẢNH BÁO KHI THOÁT MÀ CHƯA LƯU.
   * Trước đây đóng cửa sổ là mất trắng, không hỏi một câu. Làm ở MAIN process chứ không
   * dùng `beforeunload` của renderer: Electron không hiện hộp thoại của beforeunload, và
   * hộp thoại tự vẽ trong renderer thì không chặn được cửa sổ đang đóng.
   * Luồng: chặn close -> hỏi renderer còn dirty không -> showMessageBox -> đóng/lưu/huỷ.
   * `forceClose` chặn đệ quy (lần close thứ hai đi thẳng). */
  mainWindow.on('close', (event) => {
    if (forceClose || !mainWindowLoaded) return;
    event.preventDefault();
    (async () => {
      /* Cmd+Q / Thoát từ menu đi qua before-quit (isQuitting = true) -> KHÔNG chặn về Trang
       * chủ, người dùng đã nói rõ là muốn thoát. Chỉ nút đỏ mới về Trang chủ. */
      if (!isQuitting) {
        const intent = await requestRendererCloseIntent();
        if (intent === 'home' || intent === 'cancelled') return;   // cửa sổ ở nguyên
      }
      let dirty = false;
      try {
        dirty = await requestRendererDirtyState();
      } catch (_) { dirty = false; }
      if (!dirty) { forceClose = true; quitAfterWindowClose = true; mainWindow.close(); return; }
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Lưu', 'Không lưu', 'Huỷ'],
        defaultId: 0,
        cancelId: 2,
        title: 'Còn thay đổi chưa lưu',
        message: 'Dự án còn thay đổi chưa lưu.',
        detail: 'Lưu lại trước khi đóng CrabbyCut?',
      });
      if (response === 2) return;                    // Huỷ -> cửa sổ ở nguyên
      if (response === 0) {
        try { await requestRendererSave(); } catch (_) { /* lỗi lưu -> vẫn đóng theo ý người dùng */ }
      }
      forceClose = true;
      quitAfterWindowClose = true;
      mainWindow.close();
    })();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    mainWindowLoaded = false;
  });
}

/* Dựng lại cửa sổ cho một tiến trình ĐANG SỐNG nhưng không còn cửa sổ nào.
 * KHÔNG gọi thẳng ensureBackendReady(): backend có thể đã chết theo một cách nào đó, mà
 * ensureBackendReady() lại đặt isExternalBackend = true khi thấy backend còn sống — gọi
 * bừa là sidecar của CHÍNH mình bị đánh dấu "của người khác" rồi không được tắt lúc thoát.
 * Nên: cổng còn sống thì mở cửa sổ luôn, chỉ khi chết mới dựng lại backend. */
async function reopenMainWindow() {
  try {
    if (!(await checkBackendHealth())) await ensureBackendReady();
    createWindow();
  } catch (error) {
    dialog.showErrorBox('Không thể khởi động backend', String(error?.message || error));
  }
}

function isCrabPath(p) {
  return typeof p === 'string' && p.toLowerCase().endsWith('.crab') && p !== '.' && !p.startsWith('-');
}

function deliverOpenPath(filePath) {
  if (mainWindow && mainWindowLoaded) {
    mainWindow.webContents.send('open-project-file', filePath);
  } else {
    pendingOpenPath = filePath;
  }
}

ipcMain.handle('project-save', async (_event, { payloadJson, targetPath, suggestedName }) => {
  try {
    let finalPath = targetPath;
    if (!finalPath) {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Lưu dự án CrabbyCut',
        defaultPath: suggestedName || 'Untitled.crab',
        filters: [{ name: 'CrabbyCut Project', extensions: ['crab'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      finalPath = result.filePath;
      if (!finalPath.toLowerCase().endsWith('.crab')) finalPath += '.crab';
    }
    const sizeBytes = writeCrabFile(finalPath, payloadJson);
    return { path: finalPath, size_bytes: sizeBytes };
  } catch (error) {
    return { error: 'write_failed', detail: String(error?.message || error) };
  }
});

/* ================== AUTO SAVE ==================
 * GHI BẢN SAO, KHÔNG bao giờ đụng file .crab của người dùng — sửa hỏng rồi thoát vẫn quay
 * lại được. Đúng lối Premiere: thư mục "CrabbyCut Auto-Save" nằm CẠNH file dự án nên nó đi
 * theo khi copy thư mục và người dùng tự tìm thấy.
 * Dự án chưa từng Lưu (chưa có đường dẫn) thì vẫn phải cứu được -> ghi vào thư mục dữ liệu
 * riêng của app (app.getPath('userData')), không rải rác vào thư mục dự án nguồn. */
const AUTOSAVE_DIR_NAME = 'CrabbyCut Auto-Save';

/* Hỏi renderer một câu rồi chờ trả lời. `ipcMain.handle` chỉ đi CHIỀU renderer -> main, nên
 * chiều ngược lại phải tự dựng: gửi kèm mã lượt hỏi, renderer trả về qua một kênh chung.
 * Có timeout để renderer treo thì cửa sổ vẫn đóng được, không kẹt vĩnh viễn. */
let askSeq = 0;
const pendingAsks = new Map();
const pendingBusy = new Map();

/* HAI HỘP THOẠI CÙNG LÚC — lỗi đã trả giá (báo cáo 2026-09-06).
 *
 * Bấm nút đỏ khi dự án còn thay đổi chưa lưu: renderer mở hộp thoại TỰ VẼ của nó
 * ("Rời khỏi dự án sẽ dọn dữ liệu tạm...") rồi CHỜ NGƯỜI DÙNG. Nhưng askRenderer chỉ đợi
 * 4 giây rồi coi như renderer treo, trả null, và main đi tiếp tới hộp thoại NATIVE màu
 * trắng. Người dùng thấy hai hộp thoại chồng nhau; trả lời hộp trắng thì app thoát hẳn
 * thay vì về Trang chủ như hộp kia hứa.
 *
 * Cái timeout đó không phân biệt được "renderer TREO" với "renderer đang ĐỢI NGƯỜI DÙNG"
 * — mà hai chuyện này đòi hai cách xử lý ngược nhau.
 *
 * Cách sửa: renderer báo BẬN ngay khi nhận câu hỏi (trước khi mở hộp thoại), main nhận
 * tín hiệu đó thì gia hạn. Renderer treo thật thì không có tín hiệu nào và timeout ngắn
 * vẫn hoạt động y như cũ — vẫn không bao giờ kẹt không đóng được cửa sổ. */
const ASK_BUSY_TIMEOUT_MS = 10 * 60 * 1000;   // trần khi renderer báo đang đợi người dùng

function settleAsk(id, value) {
  const resolve = pendingAsks.get(id);
  if (!resolve) return;
  pendingAsks.delete(id);
  pendingBusy.delete(id);
  resolve(value);
}

ipcMain.on('renderer-reply', (_event, { id, value }) => settleAsk(id, value));

// Renderer đang mở hộp thoại và chờ người dùng -> đừng bỏ cuộc theo timeout ngắn.
ipcMain.on('renderer-busy', (_event, { id }) => {
  const extend = pendingBusy.get(id);
  if (extend) extend();
});

function askRenderer(channel, timeoutMs = 4000) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null);
  const id = ++askSeq;
  return new Promise((resolve) => {
    let timer = null;
    const arm = (ms) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        pendingBusy.delete(id);
        if (pendingAsks.delete(id)) resolve(null);
      }, ms);
    };
    pendingAsks.set(id, (value) => {
      if (timer) clearTimeout(timer);
      resolve(value);
    });
    pendingBusy.set(id, () => arm(ASK_BUSY_TIMEOUT_MS));
    arm(timeoutMs);
    mainWindow.webContents.send(channel, { id });
  });
}

const requestRendererDirtyState = () => askRenderer('ask-project-dirty').then((v) => v === true);
/* Nút đỏ: chưa ở Trang chủ thì renderer VỀ Trang chủ và ta giữ cửa sổ lại.
 * 'already-home' -> đóng thật; 'home' | 'cancelled' -> ở lại. Renderer treo/không trả lời
 * thì askRenderer trả null -> coi như 'already-home' để không bao giờ kẹt không đóng được. */
const requestRendererCloseIntent = () => askRenderer('ask-close-intent').then((v) => (
  v === 'home' || v === 'cancelled' ? v : 'already-home'
));
// Lưu có thể mở hộp thoại chọn nơi lưu (dự án chưa từng lưu) -> cho hạn dài hơn hẳn.
const requestRendererSave = () => askRenderer('ask-project-save', 120000);

function autosaveDirFor(projectPath) {
  if (projectPath) return path.join(path.dirname(projectPath), AUTOSAVE_DIR_NAME);
  return path.join(app.getPath('userData'), 'autosave');
}

// Tên có dấu thời gian SẮP XẾP ĐƯỢC theo thứ tự chữ cái (YYYYMMDD-HHmmss) -> xoay vòng chỉ
// cần sort tên, không phải stat từng file.
function autosaveStamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function autosaveSafeBase(name) {
  const base = String(name || 'Untitled').replace(/\.crab$/i, '');
  return base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'Untitled';
}

/** Danh sách bản auto save của MỘT dự án, mới nhất trước. Hàm thuần để test được. */
function listAutosaveFiles(dir, base) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const prefix = `${base}_`;
  return names
    .filter((n) => n.startsWith(prefix) && n.toLowerCase().endsWith('.crab'))
    .sort()
    .reverse();
}

ipcMain.handle('project-autosave', async (_event, { payloadJson, projectPath, suggestedName, keepVersions }) => {
  try {
    const dir = autosaveDirFor(projectPath);
    const base = autosaveSafeBase(projectPath ? path.basename(projectPath) : suggestedName);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${base}_${autosaveStamp(new Date())}.crab`);
    const sizeBytes = writeCrabFile(target, payloadJson);
    // Xoay vòng: giữ N bản mới nhất. Không giới hạn thì thư mục phình vô hạn — Premiere cũng
    // có đúng thông số "Maximum project versions".
    const keep = Math.max(1, Math.min(50, Number(keepVersions) || 10));
    const files = listAutosaveFiles(dir, base);
    files.slice(keep).forEach((name) => {
      try { fs.unlinkSync(path.join(dir, name)); } catch (_) { /* bỏ qua */ }
    });
    return { path: target, dir, size_bytes: sizeBytes, kept: Math.min(files.length, keep) };
  } catch (error) {
    return { error: 'autosave_failed', detail: String(error?.message || error) };
  }
});

ipcMain.handle('autosave-list', async (_event, { projectPath, suggestedName }) => {
  try {
    const dir = autosaveDirFor(projectPath);
    const base = autosaveSafeBase(projectPath ? path.basename(projectPath) : suggestedName);
    return {
      dir,
      items: listAutosaveFiles(dir, base).map((name) => {
        const full = path.join(dir, name);
        let stat = null;
        try { stat = fs.statSync(full); } catch (_) { /* bỏ qua */ }
        return { name, path: full, size_bytes: stat ? stat.size : 0, mtime_ms: stat ? stat.mtimeMs : 0 };
      }),
    };
  } catch (error) {
    return { error: 'list_failed', detail: String(error?.message || error), items: [] };
  }
});

/* ---- DỰ ÁN GẦN ĐÂY (màn hình Home) ----
 * Người dùng tự chọn nơi lưu .crab nên Home không quét thư mục nào được — nó đọc danh mục
 * này. Thân handler nằm ở electron/recent-projects.js để test gọi được đúng mã chạy thật. */
registerRecentProjectIpc(ipcMain, () => app.getPath('userData'));

ipcMain.handle('save-frame-image', async (_event, { dataBase64, suggestedName }) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Lưu khung hình',
      defaultPath: suggestedName || 'frame.png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    let finalPath = result.filePath;
    if (!finalPath.toLowerCase().endsWith('.png')) finalPath += '.png';
    fs.writeFileSync(finalPath, Buffer.from(String(dataBase64 || ''), 'base64'));
    return { path: finalPath };
  } catch (error) {
    return { error: 'write_failed', detail: String(error?.message || error) };
  }
});

/* AUTO SUBTITLE — ghi tệp .srt CẠNH file .crab.
 *
 * VÌ SAO Ở MAIN PROCESS: renderer không có quyền ghi đĩa, và backend (server.js) thì KHÔNG
 * BIẾT dự án đang lưu ở đâu — đường dẫn .crab chỉ sống trong renderer + main.
 *
 * `projectPath` rỗng = dự án chưa Lưu lần nào: khi đó hỏi người dùng chỗ lưu thay vì ném
 * tệp vào một thư mục họ không ngờ tới.
 *
 * Tên tệp lấy đúng tên .crab (Tên dự án.crab -> Tên dự án.srt) nên hai thứ đi thành cặp và
 * lần ghi sau ĐÈ LÊN bản cũ, không rải ra một đống .srt mồ côi.
 */
ipcMain.handle('subtitle-save-srt', async (_event, { projectPath, content, suggestedName, silent }) => {
  try {
    const text = String(content == null ? '' : content);
    let finalPath = '';
    if (projectPath) {
      const dir = path.dirname(projectPath);
      const base = path.basename(projectPath).replace(/\.crab$/i, '');
      finalPath = path.join(dir, `${base}.srt`);
    } else {
      // `silent` = lượt ghi đi kèm việc Lưu dự án; chưa có .crab thì bỏ qua lặng lẽ, KHÔNG
      // bật hộp thoại giữa chừng một thao tác người dùng không hề yêu cầu.
      if (silent) return { skipped: 'no_project_path' };
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Lưu phụ đề (.srt)',
        defaultPath: suggestedName || 'subtitle.srt',
        filters: [{ name: 'SubRip Subtitle', extensions: ['srt'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      finalPath = result.filePath;
      if (!finalPath.toLowerCase().endsWith('.srt')) finalPath += '.srt';
    }
    /* BOM UTF-8 + CRLF — lý do đầy đủ ở writeSrtTo (electron/project-package.js). Dùng chung
     * MỘT hàm với lượt Đóng gói: hai chỗ tự ghi riêng là sớm muộn cũng lệch định dạng, mà
     * .srt lệch định dạng thì vẫn "trông đúng" khi mở bằng mắt. */
    writeSrtTo(finalPath, text);
    return { path: finalPath };
  } catch (error) {
    return { error: 'write_failed', detail: String(error?.message || error) };
  }
});

/* Bản dự án ĐÃ ĐÓNG GÓI ghi đường dẫn media TƯƠNG ĐỐI so với chính tệp .crab. Giải về
 * tuyệt đối NGAY Ở ĐÂY, trước khi payload rời main process: nhờ vậy renderer (index.html)
 * luôn chỉ thấy đường dẫn tuyệt đối như xưa, không một nhánh nào phải biết đến đóng gói. */
function readCrabResolved(filePath) {
  const result = readCrabFile(filePath);
  if (!result?.payloadJson) return result;
  /* TÀI NGUYÊN THƯ VIỆN (library/) được KHÔI PHỤC ngay trong lượt đọc này: tệp nào máy này
   * chưa có mà gói có thì chép vào library/, và `path` của asset thư viện được dựng lại theo
   * library/ của CHÍNH máy này. Thiếu bước đó thì mở gói trên máy có thư viện cũ hơn là block
   * overlay/nhạc/SFX im lặng và LUT không được áp — không một dòng lỗi nào (xem
   * restoreLibraryAssets ở electron/project-package.js). `library` đi tiếp xuống renderer để
   * nó nói ra đã khôi phục gì / còn thiếu gì. */
  const library = { restored: [], missing: [], failed: [] };
  result.payloadJson = resolvePayloadPaths(result.payloadJson, filePath, { library });
  result.library = library;
  return result;
}

ipcMain.handle('project-open-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Mở dự án CrabbyCut',
    properties: ['openFile'],
    filters: [{ name: 'CrabbyCut Project', extensions: ['crab'] }],
  });
  if (result.canceled || !result.filePaths?.length) return { canceled: true };
  return readCrabResolved(result.filePaths[0]);
});

ipcMain.handle('project-read', async (_event, filePath) => readCrabResolved(String(filePath || '')));

/* BẢN PROXY XEM TRƯỚC ĐI KÈM DỰ ÁN — "<Tên dự án>.proxy.mp4" cạnh tệp .crab.
 *
 * VÌ SAO ĐÁNG LÀM: proxy được dựng từ file NỐI, mà file nối bị dựng lại ở mỗi lượt mở dự án,
 * nên proxy cũng bị encode lại từ đầu — video 16 phút 1440p mất vài phút, mỗi lần mở.
 *
 * VÌ SAO CHẠY NGẦM VÀ KHÔNG BAO GIỜ LÀM HỎNG LƯỢT LƯU: tệp .crab đã ghi xong trước khi hàm
 * này được gọi, và proxy là thứ DỰNG LẠI ĐƯỢC. Chép ~100MB mà bắt người dùng đứng chờ là
 * đánh đổi sai — nguyên tắc sẵn có của dự án là "Đóng gói là hành động riêng, Lưu vẫn nhẹ
 * như cũ" (xem project-package.js).
 *
 * BỎ QUA khi đã có bản đúng kích thước: lượt Lưu thứ hai trở đi không chép lại gì. So bằng
 * KÍCH THƯỚC chứ không mtime — chép file làm mới mtime nên mtime luôn khác, còn proxy của
 * cùng một bản nối thì luôn cùng dung lượng (danh tính trong .crab mới là thứ chốt tính
 * đúng đắn — xem tryAdoptPreviewProxy ở backend/server.js). */
ipcMain.handle('project-save-proxy', async (_event, { projectPath, proxyPath }) => {
  try {
    if (!projectPath || !proxyPath) return { skipped: 'missing_input' };
    const source = path.resolve(String(proxyPath));
    const srcStat = fs.statSync(source);
    if (!srcStat.isFile() || srcStat.size <= 0) return { skipped: 'no_proxy' };
    const target = projectSidecarPath(projectPath, SIDECAR_PREVIEW_PROXY);
    try {
      if (fs.statSync(target).size === srcStat.size) return { path: target, reused: true };
    } catch (_) { /* chưa có -> chép */ }
    /* Ghi ra tệp .part rồi mới rename: "tệp tồn tại" phải ĐỒNG NGHĨA "đã chép xong". Không
       có bước này thì tắt ứng dụng giữa chừng để lại một mp4 cụt, và lượt mở sau nhận nó. */
    const partPath = `${target}.part`;
    await fs.promises.copyFile(source, partPath);
    await fs.promises.rename(partPath, target);
    return { path: target, reused: false, size_bytes: srcStat.size };
  } catch (error) {
    return { error: 'proxy_copy_failed', detail: String(error?.message || error) };
  }
});

/* ĐÓNG GÓI DỰ ÁN (kiểu "Collect Files and Copy" của Premiere) — xem electron/project-package.js.
 * Chép media, KHÔNG di chuyển: footage gốc của người dùng nằm nguyên chỗ cũ. */
ipcMain.handle('project-package', async (_event, { payloadJson, projectName, subtitleSrt, previewProxyPath }) => {
  try {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn nơi đặt thư mục dự án đã đóng gói',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Đóng gói vào đây',
    });
    if (picked.canceled || !picked.filePaths?.length) return { canceled: true };
    const result = packageProject({
      payloadJson,
      destDir: picked.filePaths[0],
      projectName: projectName || 'CrabbyCut Project',
      subtitleSrt,
      previewProxyPath,
    });
    const sizeBytes = writeCrabFile(result.crabPath, result.payloadJson);
    return {
      path: result.crabPath,
      project_dir: result.projectDir,
      copied: result.copied,
      missing: result.missing,
      library_copied: result.libraryCopied,
      library_missing: result.libraryMissing,
      media_bytes: result.bytes,
      size_bytes: sizeBytes,
      srt_path: result.srtPath || null,
      proxy_path: result.proxyPath || null,
    };
  } catch (error) {
    return { error: 'package_failed', detail: String(error?.message || error) };
  }
});

ipcMain.handle('media-stat', async (_event, entries) => {
  const list = Array.isArray(entries) ? entries : [];
  return list.map((entry) => {
    const filePath = String(entry?.path || '');
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error('not a file');
      return {
        path: filePath,
        exists: true,
        size_bytes: stat.size,
        mtime_ms: Math.trunc(stat.mtimeMs),
        fingerprint: fingerprintFile(filePath, stat),
      };
    } catch {
      return { path: filePath, exists: false };
    }
  });
});

/* "Mở vị trí tệp" (menu chuột phải ở panel Tệp phương tiện).
 *
 * Kiểm tra tồn tại TRƯỚC khi gọi shell: showItemInFolder() với đường dẫn đã mất thì im
 * lặng không làm gì trên Windows — người dùng bấm mà không có gì xảy ra và không hiểu tại
 * sao. Trả false để renderer nói rõ "tệp có thể đã bị di chuyển".
 */
ipcMain.handle('shell-show-item', async (_event, filePath) => {
  const target = String(filePath || '');
  try {
    if (!target || !fs.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  } catch {
    return false;
  }
});

/* Chọn tệp KỊCH BẢN bằng hộp thoại gốc.
 *
 * Trước đây tab "Kịch bản" là chỗ DUY NHẤT trong Editing còn bấm vào một
 * <input type="file"> ẩn (nằm trong bước Upload đang display:none) thay vì đi qua
 * dialog gốc như mọi nút chọn tệp khác. Trên macOS, `accept=".md"` được Chromium
 * quy đổi sang UTI: máy nào chưa đăng ký UTI cho Markdown thì NSOpenPanel làm mờ
 * hết tệp .md — hộp thoại mở ra nhưng không chọn được gì. Hộp thoại gốc nhận
 * thẳng phần mở rộng nên không dính chuyện đó.
 *
 * Trả luôn NỘI DUNG chứ không chỉ đường dẫn: renderer cần chữ để đưa vào ô nhập,
 * mà nó không đọc được tệp tuỳ ý (contextIsolation, không nodeIntegration). */
const SCRIPT_TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown']);

ipcMain.handle('pick-script-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn tệp kịch bản',
    properties: ['openFile'],
    filters: [
      { name: 'Kịch bản', extensions: ['md', 'markdown', 'txt', 'docx', 'doc'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths?.length) return { canceled: true };

  const filePath = result.filePaths[0];
  const name = path.basename(filePath);
  const extension = name.split('.').pop().toLowerCase();
  try {
    if (SCRIPT_TEXT_EXTENSIONS.has(extension)) {
      return { name, extension, text: fs.readFileSync(filePath, 'utf8') };
    }
    return { name, extension, base64: fs.readFileSync(filePath).toString('base64') };
  } catch (error) {
    return { error: 'read_failed', name, detail: String(error?.message || error) };
  }
});

ipcMain.handle('pick-relink-file', async (_event, meta) => {
  const name = String(meta?.name || '');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: name ? `Tìm lại file: ${name}` : 'Tìm lại file media',
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths?.length) return null;
  return result.filePaths[0];
});

// macOS: double-click .crab (kể cả trước khi app ready) → buffer rồi gửi renderer.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (isCrabPath(filePath)) deliverOpenPath(filePath);
});

/* CHẾ ĐỘ THIẾT LẬP KHÔNG ĐƯỢC XIN KHOÁ SINGLE-INSTANCE.
 * Bộ cài chạy `--setup-runtime` trong lúc người dùng rất có thể đang mở CrabbyCut bản cũ
 * (cài đè). Xin khoá thì nhánh dưới thấy đã có tiến trình khác giữ, gọi app.quit() và
 * NSIS nhận về mã 0 — bước cài môi trường bị BỎ QUA hoàn toàn mà không ai biết. */
// Windows/Linux: double-click khi app đang chạy → instance thứ hai chuyển argv về đây.
const gotSingleInstanceLock = SETUP_MODE ? true : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  /* IM LẶNG THOÁT LÀ MỘT CÁI BẪY: `npm start` kết thúc với mã 0, không cửa sổ, không một
   * dòng nào — nhìn y hệt "ứng dụng không khởi động được". In ra để terminal nói được lý do. */
  console.log('[CrabbyCut] Đã có một tiến trình CrabbyCut đang chạy — chuyển yêu cầu về tiến trình đó và thoát.');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const crabArg = argv.find(isCrabPath);
    if (crabArg) deliverOpenPath(crabArg);
    /* macOS: đóng cửa sổ bằng nút đỏ KHÔNG thoát app (window-all-closed cố ý không quit),
     * nên tiến trình chính sống tiếp với mainWindow = null và VẪN GIỮ khoá single-instance.
     * Lần `npm start` sau rơi vào nhánh trên rồi thoát ngay -> người dùng thấy "chạy lệnh
     * mà chẳng có gì hiện ra". Không còn cửa sổ thì DỰNG LẠI, đúng như app.on('activate'). */
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      reopenMainWindow();
    }
    app.focus({ steal: true });   // đưa app ra trước, nếu không cửa sổ mở sau lưng terminal
  });
}

// Windows/Linux: double-click khi app chưa chạy → path nằm trong argv lần khởi động đầu.
const argvCrabPath = process.argv.slice(1).find(isCrabPath);
if (argvCrabPath) pendingOpenPath = argvCrabPath;

ipcMain.handle('pick-video-sources', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Chọn video hoặc thư mục video',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths || [];
});

const EDITING_ASSET_FILTERS = {
  media: [
    { name: 'Media', extensions: ['mp4', 'mov', 'm4v', 'webm', 'png', 'jpg', 'jpeg', 'webp', 'svg'] },
    { name: 'All Files', extensions: ['*'] },
  ],
  audio: [
    { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac'] },
    { name: 'All Files', extensions: ['*'] },
  ],
};

/* MỘT nút "Nhập" duy nhất (kiểu CapCut): hộp thoại cho chọn LẪN LỘN tệp và thư mục.
 * Chỉ macOS làm được — NSOpenPanel bật cả hai cờ cùng lúc. Windows/Linux thì
 * openFile + openDirectory loại trừ nhau (một trong hai bị bỏ qua), nên ở đó hàm này
 * trả về null để renderer tự hạ xuống menu 2 mục "Tệp…" / "Thư mục…". */
ipcMain.handle('pick-editing-assets-any', async (_event, kind) => {
  if (process.platform !== 'darwin') return null;
  const normalized = String(kind || '').toLowerCase();
  const result = await dialog.showOpenDialog({
    title: 'Nhập tệp hoặc thư mục',
    buttonLabel: 'Nhập',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: EDITING_ASSET_FILTERS[normalized] || EDITING_ASSET_FILTERS.media,
  });
  if (result.canceled) return [];
  return result.filePaths || [];
});

ipcMain.handle('pick-editing-assets', async (_event, kind) => {
  const normalized = String(kind || '').toLowerCase();
  const filtersByKind = EDITING_ASSET_FILTERS;
  const result = await dialog.showOpenDialog({
    title: 'Chọn asset Editing',
    properties: ['openFile', 'multiSelections'],
    filters: filtersByKind[normalized] || filtersByKind.media,
  });
  if (result.canceled) return [];
  return result.filePaths || [];
});

// Chọn THƯ MỤC cho panel Editing. Hộp thoại riêng chứ không thêm 'openDirectory' vào
// hộp thoại trên: macOS cho phép trộn openFile+openDirectory nhưng Windows thì không —
// một trong hai thuộc tính bị bỏ qua, và người dùng Windows sẽ không chọn được thư mục.
ipcMain.handle('pick-editing-asset-folders', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Chọn thư mục phương tiện',
    properties: ['openDirectory', 'multiSelections'],
  });
  if (result.canceled) return [];
  return result.filePaths || [];
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('before-quit', (event) => {
  if (shutdownInProgress) return;
  if (isExternalBackend || !backendProcess || backendProcess.exitCode !== null) return;

  event.preventDefault();
  shutdownInProgress = true;
  stopBackendSidecar()
    .catch(() => {})
    .finally(() => {
      app.quit();
    });
});

app.on('window-all-closed', async () => {
  /* quitAfterWindowClose: cửa sổ vừa đóng từ Trang chủ (hoặc qua Cmd+Q) -> kết thúc thật,
   * kể cả trên macOS. Giữ tiến trình sống mà không còn cửa sổ còn kéo theo một cái bẫy:
   * khoá single-instance vẫn bị giữ, nên `npm start` lần sau thoát ngay và người dùng thấy
   * "chạy lệnh mà chẳng có gì hiện ra" (xem app.on('second-instance')). */
  if (process.platform !== 'darwin' || quitAfterWindowClose) {
    await stopBackendSidecar();
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

/* Đảm bảo môi trường Python/FFmpeg đã có trước khi backend chạy.
 *
 * VÌ SAO KIỂM Ở MỖI LẦN MỞ chứ không chỉ lúc cài: bước cài môi trường có thể đã bị bỏ dở
 * (người dùng bấm Huỷ, mất mạng, tắt máy giữa chừng), và thư mục runtime nằm NGOÀI thư mục
 * cài đặt nên người dùng hoàn toàn có thể xoá nó mà bản cài vẫn còn nguyên. Không kiểm lại
 * thì hỏng đó chỉ lộ ra rất muộn, dưới dạng "spawn python ENOENT" giữa lúc đang bóc băng.
 *
 * Phép kiểm ở đây là phép kiểm RẺ (chỉ xem manifest + vài file) — chạy mỗi lần mở app nên
 * không được gọi Python. Phép kiểm sâu nằm trong chính cửa sổ thiết lập. */
async function ensureRuntimeReady() {
  /* CHỈ CHẶN Ở BẢN ĐÓNG GÓI. Chạy từ mã nguồn (`npm start`) thì môi trường là `.venv` của
   * dự án, và `pythonCommand()` đã ưu tiên nó sẵn — thư mục runtime của bộ cài không liên
   * quan gì và sẽ KHÔNG BAO GIỜ tồn tại trên máy phát triển.
   *
   * Bỏ điều kiện này ra thì `npm start` mở cửa sổ thiết lập rồi tải 2,6 GB đè lên một
   * `.venv` vốn đã đầy đủ — đúng thứ đã xảy ra khi thêm hàm này. Máy phát triển đã có
   * `scripts/preflight_python.js` chạy đầu chuỗi `npm start` lo phần kiểm môi trường, và nó
   * cố ý CHỈ CẢNH BÁO chứ không chặn (xem chú thích đầu tệp đó). Giữ đúng luật ấy.
   *
   * Muốn thử cửa sổ thiết lập từ mã nguồn thì chạy `electron . --setup-runtime` — nhánh
   * SETUP_MODE ở `app.whenReady()` không đi qua đây. */
  if (!app.isPackaged) return true;

  const state = RuntimePaths.verifyRuntimeQuick();
  if (state.ok) return true;

  const result = await runSetupWindow({
    reason: state.reason === 'incomplete' ? 'incomplete' : 'missing',
    appVersion: app.getVersion(),
  });

  if (result.ok) return true;

  /* Người dùng huỷ giữa chừng: KHÔNG chặn họ mở app. Dựng phim, cắt ghép, xuất video —
   * những việc không đụng tới Python — vẫn chạy được, và chặn cả app vì thiếu ASR là thù
   * địch. Chỉ cảnh báo để họ biết vì sao nút bóc băng sẽ báo lỗi. */
  const choice = await dialog.showMessageBox({
    type: 'warning',
    title: 'Môi trường chưa được cài đủ',
    message: 'CrabbyCut chưa cài xong các thành phần xử lý AI.',
    detail: 'Bạn vẫn có thể dựng và xuất video như bình thường, nhưng Bóc băng (ASR), '
      + 'Auto-Reframe và Retouch sẽ báo lỗi cho tới khi cài xong.\n\n'
      + `Thư mục môi trường: ${RuntimePaths.runtimeRoot()}`,
    buttons: ['Mở app luôn', 'Cài lại bây giờ', 'Thoát'],
    defaultId: 1,
    cancelId: 0,
  });

  if (choice.response === 2) return false;
  if (choice.response === 1) return ensureRuntimeReady();
  return true;
}

app.whenReady().then(async () => {
  if (SETUP_MODE) {
    /* Bộ cài đang chờ mã thoát này. 0 = đủ, 2 = xong nhưng thiếu vài thứ, 1 = hỏng/huỷ. */
    const result = await runSetupWindow({ reason: 'installer', appVersion: app.getVersion() });
    app.exit(result.ok ? (result.complete ? 0 : 2) : 1);
    return;
  }

  try {
    const ready = await ensureRuntimeReady();
    if (!ready) { app.quit(); return; }

    await ensureBackendReady();
    createWindow();
  } catch (error) {
    dialog.showErrorBox('Không thể khởi động backend', String(error?.message || error));
    await stopBackendSidecar();
    app.quit();
  }
});

app.on('quit', async () => {
  if (!isQuitting) return;
});

async function shutdownFromSignal(signal) {
  if (signalShutdownInProgress) return;
  signalShutdownInProgress = true;
  isQuitting = true;
  try {
    await stopBackendSidecar();
  } finally {
    app.exit(signal === 'SIGINT' ? 130 : 143);
  }
}

process.on('SIGINT', () => {
  shutdownFromSignal('SIGINT').catch(() => app.exit(130));
});

process.on('SIGTERM', () => {
  shutdownFromSignal('SIGTERM').catch(() => app.exit(143));
});
