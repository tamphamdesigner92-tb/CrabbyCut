/* =====================================================================
 * BACKEND TẮT THEO MAIN PROCESS — kể cả khi main bị kill/crash.
 *
 * Trên macOS/Linux, app bị kill/crash thì backend sống sót: lần mở sau app thấy cổng có backend
 * CrabbyCut trả lời nên coi là "backend ngoài" — không có khoá ký đường dẫn xuất (job xuất MCP
 * rơi vào Downloads dạng .tmp, đo 2026-10-17) và chạy mã của bản cũ nếu vừa cập nhật. (Windows
 * không bị: job object của libuv giết con theo cha.) Thoát bình thường trên Windows thì
 * `proc.kill('SIGTERM')` là TerminateProcess: handler shutdown() của backend không chạy.
 *
 * Tiến trình THẬT (server.js chạy như lúc Electron spawn):
 *   A. "main" giả spawn backend y như startBackendSidecar (stdin pipe + CRAB_EXIT_WITH_PARENT=1)
 *      rồi bị kill cứng -> backend phải tự thoát và nhả cổng.
 *   B. stopBackendSidecar THẬT (bóc từ electron/main.js) -> backend tắt êm qua EOF của stdin
 *      (mã 143 của shutdown(), không bị kill), nhanh hơn mốc chờ 4 s.
 *   C. Không có biến (npm run backend:dev, test) -> stdin đóng cũng không tắt.
 *
 * Chạy: npm run test:backend-exit-with-parent
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'backend', 'server.js');
const MAIN = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const TEMP = path.join(ROOT, 'test_temp', 'backend_exit_with_parent');
const PORT = 8139;

const ok = (msg) => console.log(`  ok  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function backendEnv(extra = {}) {
  return { ...process.env, BACKEND_PORT: String(PORT), CRAB_TEMP_DIR: TEMP, CRAB_CONCAT_CACHE_DIR: path.join(TEMP, 'concat'), CRAB_USER_DATA_DIR: path.join(TEMP, 'userdata'), ...extra };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(800) });
    return (await res.json())?.app === 'crabbycut';
  } catch (_) { return false; }
}

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`hết ${ms} ms chờ: ${what}`);
}

(async () => {
  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.mkdirSync(TEMP, { recursive: true });
  assert.ok(!(await healthy()), `cổng ${PORT} đang có backend khác — tắt nó trước`);

  // Hợp đồng ở main: stdin là pipe + biến bật.
  const spawnSrc = extractFunction(MAIN, 'startBackendSidecar');
  assert.ok(/CRAB_EXIT_WITH_PARENT: '1'/.test(spawnSrc), 'startBackendSidecar phải đặt CRAB_EXIT_WITH_PARENT=1');
  assert.ok(/stdio: \['pipe', 'pipe', 'pipe'\]/.test(spawnSrc), 'stdin của backend phải là pipe (đầu ghi nằm ở main)');

  // --- A: main bị kill cứng.
  {
    const fakeMain = spawn(process.execPath, ['-e', `
      const { spawn } = require('child_process');
      // Windows: libuv gom con vào job object kill-on-close nên con chết theo cha SẴN — test sẽ
      // xanh cả khi không có watchParentStdin. detached = ra khỏi job, giống hành vi macOS/Linux.
      const b = spawn(process.execPath, [${JSON.stringify(SERVER)}], { env: { ...process.env, CRAB_EXIT_WITH_PARENT: '1' }, stdio: ['pipe', 'ignore', 'ignore'], detached: process.platform === 'win32' });
      console.log(b.pid);
      setInterval(() => {}, 1000);
    `], { env: backendEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
    const backendPid = await new Promise((resolve) => fakeMain.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
    try {
      await waitFor(healthy, 20000, 'backend lên');
      fakeMain.kill('SIGKILL');
      const t0 = Date.now();
      await waitFor(async () => !alive(backendPid), 8000, 'backend tự thoát sau khi main chết');
      assert.ok(!(await healthy()), 'cổng phải được nhả');
      ok(`main bị kill cứng -> backend tự thoát sau ${Date.now() - t0} ms, cổng nhả`);
    } finally {
      // Đỏ thì backend (detached) còn sống — không để nó giữ cổng sau khi test thoát.
      try { process.kill(backendPid, 'SIGKILL'); } catch (_) { /* đã thoát */ }
      try { fakeMain.kill('SIGKILL'); } catch (_) { /* đã thoát */ }
    }
  }

  // --- B: thoát bình thường qua stopBackendSidecar thật.
  {
    const proc = spawn(process.execPath, [SERVER], { env: backendEnv({ CRAB_EXIT_WITH_PARENT: '1' }), stdio: ['pipe', 'ignore', 'ignore'] });
    proc.stdin.on('error', () => {});
    await waitFor(healthy, 20000, 'backend lên');
    const sb = { backendProcess: proc, isExternalBackend: false, sleep, Promise };
    vm.createContext(sb);
    vm.runInContext(`async ${extractFunction(MAIN, 'stopBackendSidecar')}\nglobalThis.stop = stopBackendSidecar;`, sb);
    const t0 = Date.now();
    await sb.stop();
    const took = Date.now() - t0;
    assert.strictEqual(proc.signalCode, null, `backend phải tự tắt (shutdown()), không bị kill — signal ${proc.signalCode}`);
    assert.strictEqual(proc.exitCode, 143, `mã thoát của shutdown('SIGTERM') — được ${proc.exitCode}`);
    assert.ok(took < 3500, `tắt êm phải xong trước mốc chờ 4 s của main (${took} ms)`);
    ok(`stopBackendSidecar: backend tắt êm qua EOF (mã 143, ${took} ms)`);
  }

  // --- C: không có biến -> không tắt theo stdin.
  {
    const env = backendEnv();
    delete env.CRAB_EXIT_WITH_PARENT;
    const proc = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    await waitFor(healthy, 20000, 'backend lên');
    proc.stdin.end();
    await sleep(1500);
    assert.ok(await healthy(), 'không có CRAB_EXIT_WITH_PARENT: stdin đóng không được tắt backend');
    proc.kill('SIGKILL');
    await waitFor(async () => !(await healthy()), 5000, 'dọn backend');
    ok('không có biến: bỏ qua stdin (backend:dev, test)');
  }

  fs.rmSync(TEMP, { recursive: true, force: true });
  console.log('backend exit with parent ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
