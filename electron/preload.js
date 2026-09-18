const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopEnv', {
  isElectron: true,
  /* Kiểm tra bản mới do NGƯỜI DÙNG chủ động bấm. Lượt tự kiểm lúc khởi động nằm ở main
   * process và im lặng khi đã mới nhất; lượt này thì luôn trả lời, vì đã hỏi thì phải được
   * đáp. Trả về phiên bản đang chạy để giao diện hiện được. */
  checkForUpdates: async () => ipcRenderer.invoke('check-for-updates'),
  pickVideoSources: async () => ipcRenderer.invoke('pick-video-sources'),
  pickEditingAssets: async (kind) => ipcRenderer.invoke('pick-editing-assets', kind),
  pickEditingAssetFolders: async () => ipcRenderer.invoke('pick-editing-asset-folders'),
  // Nút "Nhập" gộp: chọn tệp LẪN thư mục trong một hộp thoại. Trả null trên nền tảng
  // không hỗ trợ (Windows/Linux) -> renderer hạ xuống menu 2 mục.
  pickEditingAssetsAny: async (kind) => ipcRenderer.invoke('pick-editing-assets-any', kind),
  saveProject: async (payloadJson, targetPath, suggestedName) =>
    ipcRenderer.invoke('project-save', { payloadJson, targetPath, suggestedName }),
  openProjectDialog: async () => ipcRenderer.invoke('project-open-dialog'),
  // Đóng gói dự án: chép media vào một thư mục tự chứa cạnh tệp .crab đã re-link.
  /* `subtitleSrt` = nội dung .srt dựng lại từ timeline ngay lúc gói (xem currentSrtText ở
   * auto-subtitle.js). Không truyền đường dẫn tệp .srt cũ: tệp đó có thể đã cũ hơn timeline
   * hoặc không còn trên đĩa. */
  packageProject: async (payloadJson, projectName, subtitleSrt, previewProxyPath) =>
    ipcRenderer.invoke('project-package', { payloadJson, projectName, subtitleSrt, previewProxyPath }),
  /* Bản proxy xem trước đi kèm dự án ("<Tên dự án>.proxy.mp4" cạnh .crab). Chạy NGẦM sau
   * mỗi lượt Lưu — xem `project-save-proxy` ở main.js. */
  saveProjectProxy: async (projectPath, proxyPath) =>
    ipcRenderer.invoke('project-save-proxy', { projectPath, proxyPath }),
  /* Auto Subtitle: ghi .srt cạnh tệp .crab (projectPath rỗng -> hỏi chỗ lưu, trừ khi
   * `silent` = lượt ghi đi kèm việc Lưu dự án). */
  saveSubtitleSrt: async (projectPath, content, suggestedName, silent) =>
    ipcRenderer.invoke('subtitle-save-srt', { projectPath, content, suggestedName, silent }),
  saveFrameImage: async (dataBase64, suggestedName) =>
    ipcRenderer.invoke('save-frame-image', { dataBase64, suggestedName }),
  readProjectFile: async (filePath) => ipcRenderer.invoke('project-read', filePath),
  statMedia: async (entries) => ipcRenderer.invoke('media-stat', entries),
  // "Mở vị trí tệp" của menu chuột phải ở panel Tệp phương tiện: mở Explorer/Finder và
  // chọn sẵn tệp. Trả false nếu tệp không còn trên đĩa.
  showItemInFolder: async (filePath) => ipcRenderer.invoke('shell-show-item', filePath),
  // Dự án gần đây cho màn hình Home (xem electron/recent-projects.js).
  listRecentProjects: async () => ipcRenderer.invoke('recent-projects-list'),
  touchRecentProject: async (entry) => ipcRenderer.invoke('recent-projects-touch', entry),
  removeRecentProject: async (id) => ipcRenderer.invoke('recent-projects-remove', { id }),
  // Hộp thoại gốc cho tệp kịch bản, trả kèm nội dung (xem electron/main.js).
  pickScriptFile: async () => ipcRenderer.invoke('pick-script-file'),
  pickRelinkFile: async (meta) => ipcRenderer.invoke('pick-relink-file', meta),
  onOpenProjectFile: (callback) => {
    ipcRenderer.on('open-project-file', (_event, filePath) => callback(filePath));
  },
  // AUTO SAVE — ghi BẢN SAO, không đụng file dự án (xem electron/main.js).
  autosaveProject: async (payloadJson, projectPath, suggestedName, keepVersions) =>
    ipcRenderer.invoke('project-autosave', { payloadJson, projectPath, suggestedName, keepVersions }),
  listAutosaves: async (projectPath, suggestedName) =>
    ipcRenderer.invoke('autosave-list', { projectPath, suggestedName }),
  /* Main hỏi renderer trước khi đóng cửa sổ. `ipcMain.handle` chỉ đi một chiều nên chiều
   * này tự dựng: main gửi kèm mã lượt hỏi, renderer trả lời qua kênh chung. */
  /* Báo BẬN ngay khi nhận câu hỏi, TRƯỚC khi chạy handler.
   *
   * Vì sao cần: handler có thể mở hộp thoại và chờ người dùng lâu tuỳ ý, trong khi main
   * chỉ đợi 4 giây rồi coi renderer là đã treo — và đi tiếp tới hộp thoại native của nó.
   * Kết quả là HAI hộp thoại chồng nhau (lỗi báo cáo 2026-09-06). Tín hiệu này nói với
   * main "tôi còn sống, đang đợi người dùng" để nó gia hạn.
   *
   * Gửi TRƯỚC `await` là bắt buộc: gửi sau thì nó cũng bị chính cái chờ đó giữ lại. */
  onAskProjectDirty: (handler) => {
    ipcRenderer.on('ask-project-dirty', async (_event, { id }) => {
      ipcRenderer.send('renderer-busy', { id });
      let value = false;
      try { value = !!(await handler()); } catch (_) { value = false; }
      ipcRenderer.send('renderer-reply', { id, value });
    });
  },
  /* Nút đỏ: chưa ở Trang chủ thì VỀ Trang chủ, không đóng cửa sổ. Renderer trả về
   * 'already-home' (cho đóng thật) | 'home' (đã về Trang chủ, giữ cửa sổ) |
   * 'cancelled' (người dùng huỷ ở hộp thoại lưu, giữ cửa sổ). Trả chuỗi chứ không phải
   * boolean vì ba trạng thái này dẫn tới ba hành động khác nhau ở main. */
  onAskCloseIntent: (handler) => {
    ipcRenderer.on('ask-close-intent', async (_event, { id }) => {
      ipcRenderer.send('renderer-busy', { id });
      let value = 'already-home';
      try { value = String((await handler()) || 'already-home'); } catch (_) { value = 'already-home'; }
      ipcRenderer.send('renderer-reply', { id, value });
    });
  },
  onAskProjectSave: (handler) => {
    ipcRenderer.on('ask-project-save', async (_event, { id }) => {
      ipcRenderer.send('renderer-busy', { id });
      let value = false;
      try { value = !!(await handler()); } catch (_) { value = false; }
      ipcRenderer.send('renderer-reply', { id, value });
    });
  },
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  }
});
