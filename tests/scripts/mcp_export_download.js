/* =====================================================================
 * JOB XUẤT CỦA MCP KHI BACKEND CHẠY NGOÀI — tệp phải ra ĐÚNG output_path, job chỉ báo xong khi
 * tệp đã nằm trên đĩa.
 *
 * Lỗi đo 2026-10-17 (Electron thật, backend ngoài ở cổng 8123): crabbycut_start_job export với
 * output_path báo "complete" + output_path, nhưng thư mục đích TRỐNG. Backend ngoài không có khoá
 * ký nên `export-pick-output` trả `unsupported` TRƯỚC khi lấy đường dẫn MCP -> renderer đi đường
 * tải blob -> Chromium mở hộp thoại Lưu mà không ai bấm và ghi cả bản xuất vào Downloads dưới tên
 * `<guid>.tmp`; app bị tắt thì tệp .tmp nằm lại đó. Bản cài cũng rơi vào nhánh này khi backend
 * của lần chạy trước còn sống (app bị kill/crash).
 *
 * Hàm thật chạy trong VM:
 *   A. electron/main.js `export-pick-output` + watchBlobDownloads + takeAutomationDownloadTarget:
 *      backend ngoài -> giữ output_path cho lượt tải blob, setSavePath đúng chỗ, không mở hộp thoại;
 *      tải khác đuôi (EDL/.srt) không lấy mất đích; lượt chọn sau (xuất tay) xoá đích cũ; backend
 *      do main spawn -> trả đường dẫn có chữ ký như cũ, không đặt đích tải.
 *   B. static/js/automation-bridge.js (cả tệp) startExport: đường tải blob -> chờ main báo lượt tải
 *      xong rồi mới "complete" với đường dẫn Chromium ghi ra; tải huỷ / không ai lưu -> "failed";
 *      đường ghi thẳng -> output_path lấy từ server trả về.
 *
 * Chạy: npm run test:mcp-export-download
 * ================================================================== */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'static', 'js', 'automation-bridge.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const ok = (msg) => console.log(`  ok  ${msg}`);

function balancedFrom(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('không đóng được ngoặc');
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `không tìm thấy hàm ${name}()`);
  return src.slice(start, balancedFrom(src, src.indexOf('{', src.indexOf(')', start))));
}

function extractPickHandler() {
  const at = MAIN.indexOf("ipcMain.handle('export-pick-output', ");
  assert.notStrictEqual(at, -1, 'không thấy handler export-pick-output');
  const fnStart = MAIN.indexOf('async (', at);
  const bodyOpen = MAIN.indexOf('{', MAIN.indexOf('=>', fnStart));
  return MAIN.slice(fnStart, balancedFrom(MAIN, bodyOpen));
}

const kindsStart = MAIN.indexOf('const EXPORT_OUTPUT_KINDS = {');
assert.notStrictEqual(kindsStart, -1, 'không thấy EXPORT_OUTPUT_KINDS');
const KINDS_SRC = MAIN.slice(kindsStart, balancedFrom(MAIN, MAIN.indexOf('{', kindsStart)) + 1);

// ------------------------------------------------------------- A) main process
function mainSandbox({ external }) {
  const sb = {
    path, crypto, process: { env: {} },
    isExternalBackend: external,
    dialogCalls: 0,
    pendingAutomation: '',
    _t: (s) => s,
  };
  sb.automationBridge = { takeExportOutput: (ext) => {
    const file = sb.pendingAutomation;
    sb.pendingAutomation = '';
    return file ? file.replace(/\.[^.\\/]+$/, `.${ext}`) : '';
  } };
  sb.dialog = { showSaveDialog: async () => { sb.dialogCalls += 1; return { canceled: true }; } };
  sb.app = { getPath: () => 'C:\\Videos' };
  vm.createContext(sb);
  const take = extractFunction(MAIN, 'takeAutomationDownloadTarget');
  vm.runInContext(`
    var automationDownloadTarget = '';
    var lastExportDir = '';
    var mainWindow = null;
    const EXPORT_OUTPUT_SECRET = 'k';
    const watchedDownloadSessions = new WeakSet();
    ${KINDS_SRC}
    ${take}
    ${extractFunction(MAIN, 'watchBlobDownloads')}
    globalThis.pick = ${extractPickHandler()};
    globalThis.watch = watchBlobDownloads;
  `, sb);
  return sb;
}

function fakeSession() {
  const handlers = [];
  return { handlers, on(evt, fn) { if (evt === 'will-download') handlers.push(fn); } };
}
function fakeItem(url, filename) {
  const done = [];
  let savePath = '';
  return {
    getURL: () => url,
    getFilename: () => filename,
    setSavePath: (p) => { savePath = p; },
    getSavePath: () => savePath,
    once(evt, fn) { if (evt === 'done') done.push(fn); },
    finish(state = 'completed') { done.forEach((fn) => fn({}, state)); },
  };
}
function fakeContents() {
  return { sent: [], isDestroyed: () => false, send(...args) { this.sent.push(args); } };
}

(async () => {
  {
    const sb = mainSandbox({ external: true });
    const ses = fakeSession();
    sb.watch(ses);
    const contents = fakeContents();
    const target = 'D:\\Xuất\\bản MCP.mp4';
    sb.pendingAutomation = target;
    const picked = await sb.pick({}, { suggestedName: 'x', ext: 'mp4' });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(picked)), { unsupported: true }, 'backend ngoài: vẫn đi đường tải về (không có khoá ký)');
    assert.strictEqual(sb.automationDownloadTarget, target, 'đường dẫn MCP phải được giữ cho lượt tải blob, không bỏ rơi');
    assert.strictEqual(sb.dialogCalls, 0);

    const edl = fakeItem('blob:http://127.0.0.1/edl', 'studio_timeline.edl');
    ses.handlers[0]({}, edl, contents);
    assert.strictEqual(edl.getSavePath(), '', 'tải khác đuôi (EDL) không được ghi vào chỗ của bản xuất');
    assert.strictEqual(sb.automationDownloadTarget, target, 'và không lấy mất đích của bản xuất');

    const video = fakeItem('blob:http://127.0.0.1/vid', 'studio_final_cut.mp4');
    ses.handlers[0]({}, video, contents);
    assert.strictEqual(video.getSavePath(), target, 'bản xuất phải lưu thẳng ra output_path — không mở hộp thoại Lưu, không .tmp trong Downloads');
    assert.strictEqual(sb.automationDownloadTarget, '', 'đích dùng một lần');
    video.finish('completed');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(contents.sent)),
      [['blob-download-done', 'blob:http://127.0.0.1/vid', { state: 'completed', path: target }]],
      'báo renderer URL + trạng thái + đường dẫn đã ghi');

    // Lượt MCP hỏng trước khi tải (đích còn treo) rồi người dùng xuất tay: không được lấy đích cũ.
    sb.pendingAutomation = 'D:\\Xuất\\hỏng.mp4';
    await sb.pick({}, { ext: 'mp4' });
    await sb.pick({}, { ext: 'mp4' });
    assert.strictEqual(sb.automationDownloadTarget, '', 'lượt chọn sau phải xoá đích của lượt MCP trước');
    const manual = fakeItem('blob:http://127.0.0.1/manual', 'studio_final_cut.mp4');
    ses.handlers[0]({}, manual, contents);
    assert.strictEqual(manual.getSavePath(), '', 'xuất tay: để Chromium hỏi chỗ lưu như cũ');

    // Chỉ Audio: đuôi theo loại xuất.
    sb.pendingAutomation = 'D:\\Xuất\\tiếng.mp4';
    await sb.pick({}, { ext: 'wav' });
    const wav = fakeItem('blob:http://127.0.0.1/wav', 'studio_final_cut.wav');
    ses.handlers[0]({}, wav, contents);
    assert.strictEqual(wav.getSavePath(), 'D:\\Xuất\\tiếng.wav');
    ok('main, backend ngoài: output_path đi theo lượt tải blob, đúng đuôi, dùng một lần');
  }
  {
    const sb = mainSandbox({ external: false });
    sb.pendingAutomation = 'D:\\Xuất\\ký.mp4';
    const picked = await sb.pick({}, { ext: 'mp4' });
    assert.strictEqual(picked.path, 'D:\\Xuất\\ký.mp4');
    assert.strictEqual(picked.ticket, crypto.createHmac('sha256', 'k').update('D:\\Xuất\\ký.mp4').digest('hex'));
    assert.strictEqual(sb.automationDownloadTarget, '', 'backend do main spawn: ghi thẳng, không cần đích tải');
    assert.strictEqual(sb.dialogCalls, 0);
    ok('main, backend do main spawn: vẫn trả đường dẫn có chữ ký như cũ');
  }

  // Lượt xuất dự phòng phải để lại URL blob cho job chờ.
  const fallback = INDEX.slice(INDEX.indexOf('const exportBlob = await response.blob();'));
  assert.ok(/exportTiming\.download_url = a\.href;\s*a\.click\(\);/.test(fallback.slice(0, 1500)),
    'performVideoExport (đường tải về) phải ghi exportTiming.download_url trước a.click()');

  // ----------------------------------------------------------- B) renderer: job xuất
  function bridgeApp(exportImpl, { shortWait = false } = {}) {
    const elements = {
      exportProgress: { dataset: { state: 'idle' } },
      exportProgressText: { textContent: '' },
    };
    let downloadListener = null;
    const sb = {
      console,
      navigator: { platform: 'Win32' },
      currentMode: 'FINAL',
      currentStepId: 'step4',
      _t: (s) => s,
      document: { getElementById: (id) => elements[id] || null },
      setInterval, clearInterval,
      // Mốc chờ lượt lưu (10 phút) rút về 0 để thử nhánh "không ai lưu".
      setTimeout: (fn, ms) => setTimeout(fn, shortWait && ms >= 60000 ? 0 : ms),
      clearTimeout,
    };
    sb.window = sb;
    sb.desktopEnv = {
      onAutomationCall(fn) { this.handler = fn; },
      onBlobDownloadDone(fn) { downloadListener = fn; },
      setAutomationEnabled: async () => ({ enabled: true }),
    };
    sb.performVideoExport = async () => exportImpl({ elements, sb, fire: (...args) => downloadListener(...args) });
    vm.createContext(sb);
    vm.runInContext(BRIDGE, sb, { filename: 'automation-bridge.js' });
    assert.ok(downloadListener, 'cầu nối phải nghe blob-download-done ngay lúc nạp');
    const call = (method, params) => sb.desktopEnv.handler(method, params);
    const waitJob = async (id) => {
      for (let i = 0; i < 200; i += 1) {
        const job = await call('job_status', { job_id: id });
        if (job.state !== 'running') return job;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('job không xong');
    };
    return { call, waitJob, fire: (...args) => downloadListener(...args) };
  }
  const OUT = 'D:\\Xuất\\bản MCP.mp4';
  const downloadPath = (fireWhen, info) => ({ elements, sb, fire }) => {
    sb.__crabLastExportTiming = { download_ms: 1, download_url: 'blob:x/1' };
    elements.exportProgress.dataset.state = 'done';
    elements.exportProgressText.textContent = 'Đã xuất xong';
    if (fireWhen === 'before') fire('blob:x/1', info);
    else if (fireWhen === 'after') setTimeout(() => { fire('blob:other', { state: 'completed', path: 'D:\\khác.edl' }); fire('blob:x/1', info); }, 20);
  };
  {
    // Bản xuất nhỏ: lượt tải xong TRƯỚC khi performVideoExport trả về.
    const app = bridgeApp(downloadPath('before', { state: 'completed', path: OUT }));
    const job = await app.waitJob((await app.call('start_job', { kind: 'export', options: { output_path: OUT } })).id);
    assert.strictEqual(job.state, 'complete');
    assert.strictEqual(job.result.output_path, OUT);
  }
  {
    const app = bridgeApp(downloadPath('after', { state: 'completed', path: OUT }));
    const started = await app.call('start_job', { kind: 'export', options: { output_path: OUT } });
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual((await app.call('job_status', { job_id: started.id })).state, 'running',
      'chưa được báo xong khi tệp còn đang tải/chờ lưu');
    const job = await app.waitJob(started.id);
    assert.strictEqual(job.state, 'complete');
    assert.strictEqual(job.result.output_path, OUT, 'đường dẫn lấy từ lượt tải ĐÚNG URL, không lẫn lượt tải khác');
  }
  ok('job, đường tải blob: chỉ "complete" khi tệp đã lưu, với đường dẫn thật');
  {
    const app = bridgeApp(downloadPath('after', { state: 'cancelled', path: '' }));
    const job = await app.waitJob((await app.call('start_job', { kind: 'export', options: { output_path: OUT } })).id);
    assert.strictEqual(job.state, 'failed');
    assert.ok(/huỷ/.test(job.error), job.error);
  }
  {
    const app = bridgeApp(downloadPath('never'), { shortWait: true });
    const job = await app.waitJob((await app.call('start_job', { kind: 'export', options: { output_path: OUT } })).id);
    assert.strictEqual(job.state, 'failed', 'hộp thoại Lưu không ai bấm: không được báo xong');
    assert.ok(/chưa được lưu/.test(job.error), job.error);
  }
  ok('job, đường tải blob: huỷ / không ai lưu -> failed, không báo xong giả');
  {
    const app = bridgeApp(({ elements, sb }) => {
      sb.__crabLastExportTiming = { download_ms: 0, output_path: OUT };
      elements.exportProgress.dataset.state = 'done';
    });
    const job = await app.waitJob((await app.call('start_job', { kind: 'export', options: { output_path: OUT } })).id);
    assert.strictEqual(job.state, 'complete');
    assert.strictEqual(job.result.output_path, OUT);
  }
  {
    const app = bridgeApp(({ elements, sb }) => {
      sb.__crabLastExportTiming = { error: 'ffmpeg hỏng' };
      elements.exportProgress.dataset.state = 'error';
    });
    const job = await app.waitJob((await app.call('start_job', { kind: 'export', options: { output_path: OUT } })).id);
    assert.strictEqual(job.state, 'failed');
    assert.strictEqual(job.error, 'ffmpeg hỏng');
  }
  ok('job, ghi thẳng / xuất lỗi: như cũ');
  console.log('mcp export download ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
