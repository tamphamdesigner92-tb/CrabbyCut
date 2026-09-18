/* CỬA SỔ THIẾT LẬP MÔI TRƯỜNG — chạy lúc cài đặt và lúc mở app nếu môi trường chưa đủ.
 *
 * VÌ SAO KHÔNG LÀM HẲN TRONG NSIS: bước này tải về hơn 1 GB và chạy mười tới ba mươi phút.
 * NSIS không có tiến trình con bất đồng bộ, nên nhét vào đó là một hộp thoại đứng im không
 * phản hồi suốt thời gian đó — người dùng sẽ tắt nó giữa chừng và để lại máy cài dở. Bộ cài
 * chỉ GỌI cửa sổ này (xem build/installer.nsh) rồi chờ; mọi thứ cần nói với người dùng
 * (đang tải gì, còn bao nhiêu, hỏng ở đâu) đều nằm ở đây.
 *
 * TIẾN TRÌNH CON, KHÔNG PHẢI TRONG TIẾN TRÌNH MAIN: pip và ffmpeg đẻ ra hàng chục tiến
 * trình con; chạy thẳng trong main thì lượt "Huỷ" không có cách nào dừng chúng lại, và một
 * ngoại lệ chưa bắt ở bước cài gói giết luôn cả cửa sổ đang báo tiến độ.
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { BrowserWindow, ipcMain, shell } = require('electron');

const RuntimePaths = require('../scripts/runtime_paths.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SETUP_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'setup_runtime.js');

function createSetupWindow() {
  return new BrowserWindow({
    width: 720,
    height: 560,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#111214',
    title: 'Thiết lập CrabbyCut',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
}

/* Mở cửa sổ thiết lập và CHỜ tới khi xong.
 * Trả về { ok, complete, cancelled } — `ok` là chạy trọn không lỗi, `complete` là mọi thành
 * phần đều đạt (có thể ok mà không complete: ví dụ người dùng từ chối UAC của Visual C++
 * nên Auto-Reframe thiếu cv2, trong khi dựng phim và bóc băng vẫn dùng được). */
function runSetupWindow(options = {}) {
  return new Promise((resolve) => {
    const win = createSetupWindow();
    let child = null;
    let settled = false;
    let lastEvent = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };

    const send = (channel, payload) => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    };

    const killChild = () => {
      if (!child || child.exitCode !== null) return;
      /* SIGKILL chứ không SIGTERM: cây tiến trình ở đây là node -> pip -> nhiều tiến trình
       * tải song song, SIGTERM chỉ dừng cái ngọn còn pip vẫn ghi tiếp vào site-packages. */
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch (_) { /* no-op */ }
    };

    const startSetup = () => {
      if (child && child.exitCode === null) return;
      lastEvent = null;
      send('setup:reset');

      /* Chạy scripts/setup_runtime.js bằng CHÍNH Electron ở chế độ Node. Bản cài đặt không
       * có `node.exe` nào cả — đây là runtime Node duy nhất chắc chắn tồn tại trên máy. */
      child = spawn(process.execPath, [SETUP_SCRIPT], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch (_) { continue; }
          lastEvent = event;
          send('setup:event', event);
        }
      });
      child.stderr.on('data', (chunk) => {
        process.stderr.write(`[setup:err] ${chunk}`);
      });
      child.on('error', (error) => {
        send('setup:event', { type: 'done', ok: false, error: String(error.message) });
      });
      child.on('exit', (code) => {
        /* Mã 0 = đủ, 2 = chạy xong nhưng có cảnh báo, khác = hỏng. Nếu tiến trình chết mà
         * chưa kịp bắn sự kiện `done` nào (hết RAM, bị diệt) thì phải tự dựng một cái —
         * không thì cửa sổ đứng im ở thanh tiến độ dở dang mà không nút nào sáng lên. */
        if (!lastEvent || lastEvent.type !== 'done') {
          send('setup:event', {
            type: 'done',
            ok: false,
            error: `Tiến trình thiết lập dừng đột ngột (mã ${code}).`,
            log_path: RuntimePaths.setupLogPath(),
          });
        }
        send('setup:exit', { code });
      });
    };

    const handlers = {
      'setup:start': () => { startSetup(); },
      'setup:retry': () => { startSetup(); },
      'setup:open-log': () => { shell.openPath(RuntimePaths.setupLogPath()); },
      'setup:cancel': () => {
        killChild();
        finish({ ok: false, complete: false, cancelled: true });
      },
      'setup:finish': () => {
        const state = RuntimePaths.verifyRuntimeQuick();
        finish({ ok: state.ok, complete: !!lastEvent?.complete, cancelled: false });
      },
    };

    const cleanup = () => {
      for (const channel of Object.keys(handlers)) ipcMain.removeAllListeners(channel);
      killChild();
    };

    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.on(channel, handler);
    }

    win.on('closed', () => {
      /* Bấm nút X là huỷ — nhưng phải diệt cây tiến trình trước, nếu không pip chạy tiếp
       * trong nền và ghi vào một môi trường không ai còn theo dõi. */
      finish({ ok: false, complete: false, cancelled: true });
    });

    win.loadFile(path.join(__dirname, 'setup.html'));
    win.webContents.once('did-finish-load', () => {
      send('setup:init', {
        reason: options.reason || 'missing',
        appVersion: options.appVersion || null,
        runtimeRoot: RuntimePaths.runtimeRoot(),
        autoStart: options.autoStart !== false,
      });
    });
  });
}

module.exports = { runSetupWindow };
