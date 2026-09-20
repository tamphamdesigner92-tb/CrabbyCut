// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* TỰ NHẬN BẢN MỚI TỪ GITHUB RELEASES.
 *
 * TRIẾT LÝ: KHÔNG BAO GIỜ TỰ Ý LÀM GÌ SAU LƯNG NGƯỜI DÙNG.
 * `electron-updater` mặc định tự tải bản mới trong nền và tự cài lúc thoát app. Với một
 * trình dựng phim thì đó là hành vi sai:
 *   - tải nền ngốn băng thông và đĩa đúng lúc người ta đang xuất video;
 *   - tự cài lúc thoát nghĩa là lần mở sau app đã khác đi mà không ai báo trước.
 * Nên cả `autoDownload` lẫn `autoInstallOnAppQuit` đều TẮT. Mỗi bước đều hỏi.
 *
 * CHỈ CHẠY Ở BẢN ĐÓNG GÓI. Chạy từ mã nguồn thì không có `app-update.yml`, và
 * electron-updater sẽ ném "dev-app-update.yml not found" — một lỗi vô nghĩa với người đang
 * sửa mã. `app.isPackaged` là chốt chặn duy nhất.
 */
'use strict';
const http = require('http');
const { app, dialog, shell } = require('electron');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (error) {
  console.error('[updater] không nạp được electron-updater:', error.message);
}

/* TRANG RELEASES — đọc từ ĐÚNG cấu hình mà electron-builder dùng để phát hành
 * (`build.publish[0]`), chứ không viết tay.
 *
 * LỖI ĐÃ TRẢ GIÁ: repo đổi tên `CrabbyCut_Windows` -> `CrabbyCut` ở bản 1.1.11,
 * package.json được sửa nhưng URL viết tay ở đây thì không — nút "Xem có gì mới"
 * dẫn tới một cái tên không còn tồn tại. Nó vẫn mở được nhờ GitHub chuyển hướng tên
 * cũ, nên lỗi này KHÔNG bao giờ tự lộ ra; lần đổi tên sau là gãy hẳn.
 *
 * Hỏng thì lùi về trang chủ: thà mở trang gốc còn hơn ném lỗi giữa hộp thoại. */
function releasesTagUrl(version) {
  let owner = 'tamphamdesigner92-tb';
  let repo = 'CrabbyCut';
  try {
    const publish = require('../package.json').build?.publish;
    const github = (Array.isArray(publish) ? publish : [publish]).find((p) => p?.provider === 'github');
    if (github?.owner) owner = github.owner;
    if (github?.repo) repo = github.repo;
  } catch (_) { /* giữ giá trị dự phòng */ }
  return `https://github.com/${owner}/${repo}/releases/tag/v${version}`;
}

let checking = false;
let downloadedInfo = null;

function log(message) {
  console.log(`[updater] ${message}`);
}

/* App có đang bận việc không được ngắt không?
 *
 * Cài bản cập nhật = thoát app. Thoát giữa một lượt xuất video là mất trắng lượt đó — có
 * thể đã chạy cả chục phút — và để lại tệp ra dở dang. Backend phơi cờ này ở /api/status.
 *
 * Hỏi KHÔNG ĐƯỢC thì trả `false`: không chặn người dùng cập nhật chỉ vì một lượt HTTP
 * trượt. Chốt thật vẫn là hộp thoại "còn thay đổi chưa lưu" ở lượt đóng cửa sổ. */
function isBackendBusy(origin, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(`${origin}/api/status`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) { request.destroy(); resolve(false); }
      });
      response.on('end', () => {
        try { resolve(!!JSON.parse(body)?.export_in_flight); } catch (_) { resolve(false); }
      });
      response.on('error', () => resolve(false));
    });
    request.on('error', () => resolve(false));
    request.setTimeout(timeoutMs, () => { request.destroy(); resolve(false); });
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/* Hỏi cài đặt rồi thoát. KHÔNG tự gọi quitAndInstall mà không hỏi.
 *
 * `quitAndInstall` gọi `app.quit()` bên trong, nên nó ĐI QUA chốt "còn thay đổi chưa lưu"
 * ở `mainWindow.on('close')`. Người dùng bấm Huỷ ở đó thì lượt thoát bị chặn và bản cập
 * nhật không được cài — đúng như mong đợi, không cần xử lý thêm. */
async function promptInstall(win, info, backendOrigin) {
  if (await isBackendBusy(backendOrigin)) {
    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Đang xuất video',
      message: `Bản ${info.version} đã tải xong.`,
      detail: 'CrabbyCut đang xuất video nên chưa thể khởi động lại.\n\n'
        + 'Bản cập nhật sẽ được cài ở lần bạn mở lại ứng dụng.',
      buttons: ['Đã hiểu'],
    });
    /* Bật lại cờ cài-khi-thoát CHỈ ở nhánh này: người dùng đã biết có bản mới đang chờ,
     * nên cài lúc họ chủ động thoát không còn là chuyện bất ngờ. */
    autoUpdater.autoInstallOnAppQuit = true;
    return;
  }

  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Bản cập nhật đã sẵn sàng',
    message: `CrabbyCut ${info.version} đã tải xong.`,
    detail: 'Cài đặt bây giờ? Ứng dụng sẽ đóng lại và tự mở lại sau khi cài xong.\n\n'
      + 'Dự án đang mở sẽ được hỏi lưu trước khi đóng.',
    buttons: ['Cài đặt và khởi động lại', 'Để lần sau'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response !== 0) {
    autoUpdater.autoInstallOnAppQuit = true;   // để lần sau = cài lúc họ tự thoát
    return;
  }

  log(`cài đặt bản ${info.version}`);
  /* isSilent=false: vẫn hiện giao diện bộ cài, vì bộ cài này còn chạy bước thiết lập môi
   * trường (xem build/installer.nsh) và bước đó cần người dùng nhìn thấy.
   * isForceRunAfter=true: mở lại app sau khi cài xong. */
  autoUpdater.quitAndInstall(false, true);
}

async function promptDownload(win, info, backendOrigin) {
  const size = info?.files?.[0]?.size;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Có bản CrabbyCut mới',
    message: `CrabbyCut ${info.version} đã có.`,
    detail: `Bạn đang dùng ${app.getVersion()}.`
      + (size ? `\nDung lượng tải về: ${formatBytes(size)} (chỉ tải phần khác biệt nếu có thể).` : '')
      + '\n\nTải về ngay? Bạn vẫn dùng ứng dụng bình thường trong lúc tải.',
    buttons: ['Tải về', 'Để sau', 'Xem có gì mới'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response === 2) {
    await shell.openExternal(releasesTagUrl(info.version));
    return;
  }
  if (response !== 0) return;

  try {
    await autoUpdater.downloadUpdate();
    /* `update-downloaded` bắn ra sau khi promise này giải quyết; giữ info ở đó rồi mới hỏi
     * cài, để không hỏi hai lần nếu người dùng bấm kiểm tra lại giữa chừng. */
    if (downloadedInfo) await promptInstall(win, downloadedInfo, backendOrigin);
  } catch (error) {
    log(`tải thất bại: ${error?.message || error}`);
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Không tải được bản cập nhật',
      message: 'Không tải được bản cập nhật.',
      detail: `${error?.message || error}\n\n`
        + 'Kiểm tra kết nối mạng rồi thử lại, hoặc tải thủ công ở trang Releases.',
      buttons: ['Đã hiểu'],
    });
  }
}

/* Kiểm tra bản mới.
 * `silent` = không báo gì khi đã là bản mới nhất hoặc khi kiểm tra hỏng. Dùng cho lượt tự
 * kiểm lúc khởi động — bật app lên mà bị một hộp thoại "bạn đang dùng bản mới nhất" chặn
 * đường là phiền vô ích. Lượt người dùng CHỦ ĐỘNG bấm kiểm tra thì `silent = false`. */
async function checkForUpdates(win, backendOrigin, { silent = true } = {}) {
  if (!autoUpdater || !app.isPackaged || checking) return;
  checking = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo;
    const hasUpdate = !!result?.downloadPromise || (info && info.version !== app.getVersion());

    if (!hasUpdate) {
      log(`đang ở bản mới nhất (${app.getVersion()})`);
      if (!silent) {
        await dialog.showMessageBox(win, {
          type: 'info',
          title: 'Không có bản mới',
          message: `Bạn đang dùng bản mới nhất (${app.getVersion()}).`,
          buttons: ['Đóng'],
        });
      }
      return;
    }

    log(`có bản mới: ${info.version}`);
    await promptDownload(win, info, backendOrigin);
  } catch (error) {
    log(`kiểm tra thất bại: ${error?.message || error}`);
    if (!silent) {
      await dialog.showMessageBox(win, {
        type: 'error',
        title: 'Không kiểm tra được bản cập nhật',
        message: 'Không kiểm tra được bản cập nhật.',
        detail: String(error?.message || error),
        buttons: ['Đã hiểu'],
      });
    }
  } finally {
    checking = false;
  }
}

function initUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  autoUpdater.on('update-downloaded', (info) => {
    downloadedInfo = info;
    log(`đã tải xong bản ${info.version}`);
  });
}

module.exports = { initUpdater, checkForUpdates };
