/**
 * BỘ ĐO EXPORT — Bước 0.2 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md.
 * Chạy: npm run bench:export -- --crab "<dự án>.crab" [--cut 300] [--runs 3] [--split]
 *       npm run bench:export -- --lavfi            (ca kiểm nhanh bộ đo, không cần dự án)
 *
 * HAI CHẾ ĐỘ ĐO, đúng như kế hoạch:
 *   (b) MỘT lượt thật trong Electron: mở .crab, gọi performVideoExport() như bấm nút Xuất.
 *       Cho số "từ lúc bấm tới khi có file", gồm cả bước vẽ trước (PNG chữ, chuỗi khung hoạt
 *       ảnh/chuyển cảnh/retouch) mà báo cáo dự án không bao giờ thấy. Backend chạy NGAY TRONG
 *       tiến trình này với CRABBYCUT_EXPORT_CAPTURE_DIR, nên payload của lượt đó được ghi lại.
 *   (a) PHÁT LẠI payload đã ghi `--runs` lần vào /api/export-video: đo phần server + sidecar +
 *       ffmpeg mà không vẽ trước lại. Đây là vòng lặp A/B của Bước 1. `--replay-only` dùng lại
 *       payload của lần chạy trước (không mở Electron).
 *
 * KHÔNG BAO GIỜ đụng dự án người dùng đang mở: temp, cache nối, userData của Electron đều nằm
 * trong `--root` (mặc định test_temp/bench_export/<fixture>). Electron chạy với cổng CDP và
 * user-data-dir riêng nên không vướng khoá một-phiên-bản của app thật.
 *
 * `--split` (nên dùng với bản cắt ngắn): sau lượt phát lại đầu tiên, chạy lại TỪNG lệnh ffmpeg
 * hình của sidecar (đọc từ export_bench/*.cmd.json, cần CRABBYCUT_EXPORT_BENCH=1 — bộ đo tự
 * bật) ở hai biến thể:
 *     null   = cùng đồ thị, bỏ encoder, `-f null -`   -> encode ≈ thật − null
 *     decode = chỉ giải mã [0:v] từ 0 tới `source_to`   -> filter ≈ null − decode
 * Các khâu chạy chồng nhau (fftools đa luồng) nên đây là CHI PHÍ BIÊN của từng khâu, không
 * phải lát cắt tuyệt đối — đủ để biết bỏ công vào khâu nào.
 *
 * `--lossless` / `--gold` (cho tests/scripts/export_fidelity.js): sau lượt phát lại đầu, chạy
 * lại đồ thị của nó ra FFV1 (`runs/<n>/lossless.mkv`) và bản chuẩn yuv444p10 (`gold.mkv`).
 * 4K thì dùng bản cắt ngắn: FFV1 4K ~4 MB/khung, bản chuẩn gấp ~4 lần.
 *
 * Đọc thêm: `--env KEY=VALUE` (lặp được) để bật/tắt cờ thí nghiệm của sidecar khi A/B,
 * `--ffmpeg-dir <bin>` để đo trên bản ffmpeg ghim (đưa lên đầu PATH), `--cpu` =
 * FFMPEG_EXPORT_HW=0. Kết quả: reports/perf_export_<fixture>_<giờ>.json + bảng in ra màn hình.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const REPORTS_DIR = path.join(projectRoot, 'reports');

function parseArgs(argv) {
  const opts = { runs: 3, env: {}, cut: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      assert.ok(i < argv.length, `thiếu giá trị cho ${arg}`);
      return argv[i];
    };
    if (arg === '--crab') opts.crab = path.resolve(next());
    else if (arg === '--cut') opts.cut = Number(next());
    else if (arg === '--runs') opts.runs = Math.max(0, Math.floor(Number(next())));
    else if (arg === '--label') opts.label = next();
    else if (arg === '--tag') opts.tag = next().replace(/[^A-Za-z0-9._-]+/g, '_');
    else if (arg === '--root') opts.root = path.resolve(next());
    else if (arg === '--ffmpeg-dir') opts.ffmpegDir = path.resolve(next());
    else if (arg === '--env') {
      const [key, ...rest] = next().split('=');
      opts.env[key] = rest.join('=');
    } else if (arg === '--rerecord') opts.rerecord = true;
    else if (arg === '--replay-only') opts.replayOnly = true;
    else if (arg === '--split') opts.split = true;
    else if (arg === '--cpu') opts.env.FFMPEG_EXPORT_HW = '0';
    else if (arg === '--keep-output') opts.keepOutput = true;
    else if (arg === '--lossless') opts.lossless = true;
    else if (arg === '--gold') opts.gold = true;
    else if (arg === '--lavfi') opts.lavfi = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`tham số lạ: ${arg}`);
  }
  if (!opts.ffmpegDir && process.env.BENCH_FFMPEG_DIR) opts.ffmpegDir = path.resolve(process.env.BENCH_FFMPEG_DIR);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || (!opts.crab && !opts.lavfi)) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
  process.exit(opts.help ? 0 : 2);
}

const fixtureLabel = opts.label || (opts.lavfi
  ? 'lavfi'
  : `${path.basename(opts.crab, '.crab')}${opts.cut > 0 ? `_cut${opts.cut}s` : ''}`);
const fixtureSlug = fixtureLabel.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
const fixtureDir = path.join(opts.root || path.join(projectRoot, 'test_temp', 'bench_export'), fixtureSlug);
const tempDir = path.join(fixtureDir, 'temp');
const captureDir = path.join(fixtureDir, 'capture');
// Mỗi lần chạy một thư mục riêng (giờ + tag), để lượt A/B sau không đè lượt trước.
const invocationStamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runsDir = path.join(fixtureDir, 'runs', `${invocationStamp}${opts.tag ? `_${opts.tag}` : ''}`);
const BACKEND_PORT = process.env.BENCH_BACKEND_PORT || '8131';
const CDP_PORT = process.env.BENCH_CDP_PORT || '9333';

/* Môi trường cho backend + sidecar + ffmpeg: đặt TRƯỚC khi require server (nó đọc
 * CRAB_TEMP_DIR/BACKEND_PORT lúc nạp module). Sidecar thừa hưởng process.env qua runSidecar. */
if (opts.ffmpegDir) process.env.PATH = `${opts.ffmpegDir}${path.delimiter}${process.env.PATH}`;
process.env.CRAB_TEMP_DIR = tempDir;
process.env.CRAB_CONCAT_CACHE_DIR = path.join(fixtureDir, 'concat_cache');
process.env.BACKEND_PORT = BACKEND_PORT;
process.env.CRABBYCUT_EXPORT_BENCH = process.env.CRABBYCUT_EXPORT_BENCH || '1';
for (const [key, value] of Object.entries(opts.env)) process.env[key] = value;

const baseUrl = `http://127.0.0.1:${BACKEND_PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function median(values) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function firstLine(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').split(/\r?\n/)[0].trim() : null;
}

/* ---------------- Lấy mẫu CPU / GPU trong lúc một lượt chạy ---------------- */
function startSampler() {
  const cpuSamples = [];
  let last = os.cpus();
  const timer = setInterval(() => {
    const now = os.cpus();
    let busy = 0;
    let total = 0;
    now.forEach((cpu, i) => {
      const a = last[i]?.times;
      const b = cpu.times;
      if (!a) return;
      const idle = b.idle - a.idle;
      const work = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq);
      busy += work;
      total += work + idle;
    });
    if (total > 0) cpuSamples.push((100 * busy) / total);
    last = now;
  }, 1000);
  /* nvidia-smi dmon: một dòng mỗi giây, cột theo tiêu đề "# gpu sm mem enc dec ...". Máy
   * không có NVIDIA thì spawn lỗi -> không có số GPU, không sao. */
  const gpuRows = [];
  let header = null;
  let gpu = null;
  try {
    gpu = spawn('nvidia-smi', ['dmon', '-s', 'u', '-d', '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    gpu.on('error', () => {});
    let buffer = '';
    gpu.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        if (line.startsWith('#')) {
          if (!header && cols.includes('sm')) header = cols.slice(1);
        } else if (header && cols.length === header.length) {
          const row = {};
          header.forEach((key, idx) => { row[key] = Number(cols[idx]); });
          gpuRows.push(row);
        }
      }
    });
  } catch (_) { gpu = null; }
  return () => {
    clearInterval(timer);
    if (gpu) { try { gpu.kill(); } catch (_) {} }
    const avg = (key) => median(gpuRows.map((r) => r[key])) === null ? null
      : +(gpuRows.reduce((s, r) => s + (Number.isFinite(r[key]) ? r[key] : 0), 0) / gpuRows.length).toFixed(1);
    return {
      cpu_avg_pct: cpuSamples.length ? +(cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length).toFixed(1) : null,
      cpu_samples: cpuSamples.length,
      gpu_sm_pct: avg('sm'),
      gpu_enc_pct: avg('enc'),
      gpu_dec_pct: avg('dec'),
    };
  };
}

/* ---------------- Chờ máy rảnh (không còn ffmpeg nền) ---------------- */
function busyMediaProcesses() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const names = String(r.stdout || '').split(/\r?\n/).map((l) => (l.split('","')[0] || '').replace(/^"/, '').toLowerCase());
  return names.filter((n) => n === 'ffmpeg.exe' || n === 'ffprobe.exe' || n === 'core_process.exe').length;
}

async function waitForIdle(label, timeoutMs = 60 * 60 * 1000) {
  const started = Date.now();
  let quiet = 0;
  let lastLog = Date.now();
  while (Date.now() - started < timeoutMs) {
    const busy = process.platform === 'win32' ? busyMediaProcesses() : 0;
    quiet = busy === 0 ? quiet + 1 : 0;
    if (quiet >= 5) return Date.now() - started;
    if (Date.now() - lastLog > 30000) {
      lastLog = Date.now();
      console.log(`  [chờ rảnh] ${label}: còn ${busy} tiến trình ffmpeg/sidecar nền...`);
    }
    await sleep(1000);
  }
  throw new Error(`quá ${Math.round(timeoutMs / 60000)} phút mà việc nền (${label}) chưa xong`);
}

/* ---------------- Electron + CDP ---------------- */
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (/export-timing|Export error|Animation pre-render|pre-render error/i.test(text)) console.log(`  [renderer] ${text.slice(0, 300)}`);
      }
    };
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /* KHÔNG dùng `replMode`: ở chế độ đó giá trị trả về là chính đối tượng Promise (không được
   * chờ) nên mọi `await` phía renderer trả về `{}` ngay. Chế độ thường vẫn đọc/gán được biến
   * `let` top-level của index.html bằng tên trần (chung global lexical scope). */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`renderer: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  close() { try { this.ws.close(); } catch (_) {} }
}

async function launchElectron() {
  const electronBin = require('electron');
  const userDataDir = path.join(fixtureDir, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  /* Cờ chống bóp nhịp khi cửa sổ bị che: bake chuyển cảnh/retouch tua <video> + chờ khung,
   * bị Chromium hãm lúc nền là số vẽ trước sai hẳn (xem memory crabbycut-do-hieu-nang).
   * KHÔNG ghim cửa sổ lên trên cùng — người dùng đang làm việc trên máy này. */
  const child = spawn(electronBin, [
    '.',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ], { cwd: projectRoot, env: { ...process.env, BACKEND_PORT }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', () => {});
  const started = Date.now();
  while (Date.now() - started < 90000) {
    try {
      const targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json`);
      const page = targets.find((t) => t.type === 'page' && String(t.url).startsWith(baseUrl));
      if (page) {
        const cdp = new Cdp(page.webSocketDebuggerUrl);
        await cdp.opened;
        await cdp.send('Runtime.enable');
        return { child, cdp };
      }
    } catch (_) { /* chưa lên */ }
    await sleep(500);
  }
  killTree(child.pid);
  throw new Error('Electron không mở được trang CrabbyCut qua CDP trong 90 s');
}

/* CPU-giây cộng dồn của mọi tiến trình Electron (main + renderer + GPU). Lấy hiệu hai lần đọc
 * là biết giao diện tiêu bao nhiêu CPU trong lúc xuất — phần đó bị trừ thẳng vào ffmpeg, vì
 * ffmpeg đã bão hoà CPU (đo 2026-09-28: cùng ~1.000 CPU-giây mà lượt trong app chậm hơn
 * lượt phát lại ~30%). */
function electronCpuSeconds() {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '(Get-Process -Name electron -ErrorAction SilentlyContinue | Measure-Object -Property CPU -Sum).Sum'],
  { encoding: 'utf8' });
  const value = Number(String(r.stdout || '').trim());
  return Number.isFinite(value) ? value : null;
}

/* CPU profile của renderer GIỮA lượt xuất (sau khi ffmpeg đã chạy), để biết giao diện đang
 * làm gì trong lúc lẽ ra nó phải ngồi yên chờ. Ghi .cpuprofile (mở được bằng DevTools) và trả
 * về các hàm tốn thời gian tự thân nhiều nhất. */
async function profileRenderer(cdp, delayMs, durationMs, outFile) {
  await sleep(delayMs);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  await sleep(durationMs);
  const { profile } = await cdp.send('Profiler.stop');
  fs.writeFileSync(outFile, JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas || [];
  (profile.samples || []).forEach((id, i) => {
    const node = byId.get(id);
    const f = node.callFrame;
    const key = `${f.functionName || '(anonymous)'} ${path.basename(f.url || '')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const idle = self.get('(idle) :0') || 0;
  return {
    window_ms: durationMs,
    busy_ms: Math.round(total - idle),
    top: [...self.entries()].filter(([k]) => !k.startsWith('(idle)'))
      .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, ms]) => `${Math.round(ms)} ms  ${k}`),
  };
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
}

async function recordInElectron() {
  console.log(`[bench-export] mở Electron + dự án: ${opts.crab}`);
  const { child, cdp } = await launchElectron();
  try {
    const readyStarted = Date.now();
    while (!(await cdp.evaluate("typeof openProjectByPath === 'function' && !!window.desktopEnv && document.readyState === 'complete'"))) {
      if (Date.now() - readyStarted > 60000) throw new Error('renderer không sẵn sàng sau 60 s');
      await sleep(500);
    }
    // Dự án mới tinh nên không có hộp "thay thế công việc hiện tại?"; chặn phòng hờ.
    await cdp.evaluate('window.confirm = () => true; window.alert = () => {}; true');
    const openStarted = Date.now();
    await cdp.evaluate(`openProjectByPath(${JSON.stringify(opts.crab)})`);
    const loaded = await cdp.evaluate('({ clips: latestTimeline.length, step: currentStepId, items: EditingRuntime.getHistoryState().editingItems.length })');
    assert.ok(loaded && loaded.clips > 0, `mở dự án xong mà lane chính rỗng: ${JSON.stringify(loaded)}`);
    console.log(`  đã mở sau ${((Date.now() - openStarted) / 1000).toFixed(1)} s: ${loaded.clips} clip, ${loaded.items} item, bước ${loaded.step}`);
    const idleMs = await waitForIdle('nối nguồn / proxy / sóng âm');
    console.log(`  việc nền xong sau ${(idleMs / 1000).toFixed(1)} s nữa`);

    if (opts.cut > 0) {
      /* BẢN CẮT NGẮN cùng cấu trúc: giữ lane chính tới đúng `cut` giây sequence, bỏ item bắt
       * đầu sau mốc đó, rút ngắn item vắt qua. Chỉ sửa trạng thái trong bộ nhớ của renderer;
       * tệp .crab không bị ghi lại. */
      const cutInfo = await cdp.evaluate(`(() => {
        const cut = ${Number(opts.cut)};
        let acc = 0;
        const kept = [];
        for (const clip of latestTimeline) {
          if (acc >= cut - 1e-6) break;
          const dur = clipSequenceDuration(clip);
          if (acc + dur > cut) {
            kept.push({ ...clip, end: Number(clip.start) + (cut - acc) * clipSpeedRate(clip) });
            acc = cut;
            break;
          }
          kept.push(clip);
          acc += dur;
        }
        latestTimeline = kept;
        const state = EditingRuntime.getHistoryState();
        const before = state.editingItems.length;
        state.editingItems = state.editingItems
          .filter((it) => Number(it.timeline_start) < cut)
          .map((it) => (Number(it.timeline_start) + Number(it.duration) > cut
            ? { ...it, duration: cut - Number(it.timeline_start) } : it));
        EditingRuntime.restoreHistoryState(state);
        return { clips: kept.length, duration: acc, items_before: before, items: state.editingItems.length };
      })()`);
      console.log(`  cắt còn ${cutInfo.duration.toFixed(1)} s: ${cutInfo.clips} clip, ${cutInfo.items}/${cutInfo.items_before} item`);
    }

    const settings = await cdp.evaluate(`({
      resolution: document.getElementById('exportResolution')?.value,
      fps: document.getElementById('exportFps')?.value,
      codec: document.getElementById('exportCodec')?.value,
      quality: document.getElementById('exportQuality')?.value,
    })`);
    console.log(`  xuất (renderer) với ${JSON.stringify(settings)} ...`);
    const sampler = startSampler();
    const electronCpuBefore = electronCpuSeconds();
    const t0 = Date.now();
    fs.mkdirSync(runsDir, { recursive: true });
    const profilePromise = profileRenderer(cdp, 30000, 15000, path.join(runsDir, 'renderer_during_export.cpuprofile'))
      .catch((error) => ({ error: String(error?.message || error) }));
    const timing = await cdp.evaluate(`(async () => {
      const originalClick = HTMLAnchorElement.prototype.click;
      // Không tải file về thư mục Downloads: bỏ qua cú click trên link blob: của bản xuất.
      HTMLAnchorElement.prototype.click = function () {
        if (String(this.href || '').startsWith('blob:')) { URL.revokeObjectURL(this.href); return; }
        return originalClick.call(this);
      };
      try {
        window.__crabLastExportTiming = null;
        // pickOutput: false — không có ai bấm hộp thoại lưu (mục 1.16); đi đường tải về cũ.
        await performVideoExport({ pickOutput: false });
        return window.__crabLastExportTiming;
      } finally {
        HTMLAnchorElement.prototype.click = originalClick;
      }
    })()`);
    const usage = sampler();
    const wallMs = Date.now() - t0;
    const electronCpuAfter = electronCpuSeconds();
    if (electronCpuBefore !== null && electronCpuAfter !== null) {
      usage.electron_cpu_s = +(electronCpuAfter - electronCpuBefore).toFixed(1);
      usage.electron_cores = +(usage.electron_cpu_s / (wallMs / 1000)).toFixed(2);
    }
    // Lượt xuất ngắn hơn cửa sổ đo thì profile vẫn đang chạy — không chờ nó.
    const rendererProfile = wallMs > 50000 ? await profilePromise : { skipped: 'lượt xuất ngắn hơn cửa sổ đo' };
    if (rendererProfile.top) {
      console.log(`  renderer bận ${rendererProfile.busy_ms}/${rendererProfile.window_ms} ms trong cửa sổ đo; nóng nhất:`);
      rendererProfile.top.slice(0, 6).forEach((line) => console.log(`    ${line}`));
    }
    if (!timing || timing.error) throw new Error(`lượt xuất trong renderer lỗi: ${timing?.error || 'không có số đo'}`);
    return { kind: 'renderer', wall_ms: wallMs, settings, ...flattenRendererTiming(timing), usage, renderer_profile: rendererProfile };
  } finally {
    cdp.close();
    killTree(child.pid);
  }
}

function flattenRendererTiming(t) {
  return {
    total_ms: t.total_ms,
    prebake_ms: t.prebake_ms,
    prebake: t.prebake,
    request_ms: t.request_ms,
    download_ms: t.download_ms,
    output_bytes: t.output_bytes,
    report_path: t.report_path,
    server: t.server,
  };
}

/* ---------------- Phát lại payload đã ghi ---------------- */

/* POST multipart bằng `http` thuần, KHÔNG dùng fetch: fetch của Node (undici) bỏ cuộc nếu sau
 * 300 s chưa có header phản hồi (UND_ERR_HEADERS_TIMEOUT) — bản 39 phút cần ~55 phút mới có
 * header. Thân gửi đi phát thẳng từ đĩa, phản hồi (bản xuất ~12 GB) chỉ đếm byte rồi bỏ, không
 * gom vào RAM. */
function postMultipart(url, fields, files) {
  const boundary = `----crabbench${Date.now().toString(16)}`;
  const esc = (s) => String(s).replace(/"/g, '%22').replace(/\r|\n/g, ' ');
  const parts = [];
  for (const [name, value] of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(name)}"\r\n\r\n`));
    parts.push(Buffer.from(String(value), 'utf8'));
    parts.push(Buffer.from('\r\n'));
  }
  for (const file of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(file.field)}"; filename="${esc(file.name)}"\r\n`
      + `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
    parts.push({ path: file.path, size: fs.statSync(file.path).size });
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const length = parts.reduce((s, p) => s + (Buffer.isBuffer(p) ? p.length : p.size), 0);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': length },
    }, (res) => {
      const headersMs = Date.now() - t0;
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (res.statusCode !== 200 && bytes < 65536) chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, bytes, headersMs, totalMs: Date.now() - t0,
        errorText: res.statusCode === 200 ? '' : Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    (async () => {
      for (const part of parts) {
        if (Buffer.isBuffer(part)) {
          if (!req.write(part)) await new Promise((r) => req.once('drain', r));
        } else {
          for await (const chunk of fs.createReadStream(part.path)) {
            if (!req.write(chunk)) await new Promise((r) => req.once('drain', r));
          }
        }
      }
      req.end();
    })().catch(reject);
  });
}

async function replayOnce() {
  const capture = JSON.parse(fs.readFileSync(path.join(captureDir, 'form.json'), 'utf8'));
  const fields = Object.entries(capture.fields)
    // Không phát lại mốc/đo của lượt ghi: lượt phát lại KHÔNG có bước vẽ trước.
    .filter(([key]) => key !== 'client_started_at_ms' && key !== 'client_timing_json');
  fields.push(['client_started_at_ms', String(Date.now())]);
  const files = capture.files.map((file) => ({
    field: file.field, name: file.originalname, type: file.mimetype, path: path.join(captureDir, 'frames', file.file),
  }));
  const sampler = startSampler();
  const res = await postMultipart(`${baseUrl}/api/export-video`, fields, files);
  const usage = sampler();
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.errorText.slice(0, 800)}`);
  let server = null;
  try { server = JSON.parse(res.headers['x-export-timing'] || 'null'); } catch (_) {}
  return {
    kind: 'replay',
    total_ms: res.totalMs,
    request_ms: res.headersMs,
    download_ms: res.totalMs - res.headersMs,
    output_bytes: res.bytes,
    report_path: res.headers['x-project-report-path'] || null,
    server,
    usage,
  };
}

/* ---------------- Tách khâu: -f null và chỉ giải mã ---------------- */
function runFfmpegTimed(args, cwd) {
  const t0 = Date.now();
  const r = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const ms = Date.now() - t0;
  const bench = /bench:\s*utime=([\d.]+)s\s+stime=([\d.]+)s\s+rtime=([\d.]+)s/.exec(r.stderr || '');
  return {
    ms,
    exit: r.status,
    cpu_s: bench ? +(Number(bench[1]) + Number(bench[2])).toFixed(1) : null,
    error: r.status === 0 ? undefined : String(r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | '),
  };
}

function splitStages(benchDir, sidecarRuns) {
  const out = [];
  for (const run of sidecarRuns || []) {
    if (run.mode === 'audio') continue;
    const cmdFile = path.join(benchDir, `${run.label}.cmd.json`);
    if (!fs.existsSync(cmdFile)) continue;
    const { cwd, args } = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
    const verbose = args.map((a, i) => (args[i - 1] === '-v' ? 'info' : a));
    // Tham số encoder nằm SAU `-sn -dn` (AppendStreamMapArgs) — cắt ở đó là bỏ encoder +
    // mọi cờ bench + đường ra.
    const cutAt = verbose.lastIndexOf('-dn');
    assert.ok(cutAt > 0, `${cmdFile}: không tìm thấy -dn để tách encoder`);
    const nullArgs = [...verbose.slice(0, cutAt + 1), '-benchmark', '-f', 'null', '-'];
    const source = args[args.indexOf('-i') + 1];
    // Giải mã ĐÚNG khoảng mà lệnh thật giải mã: từ mốc seek của batch (nếu có) tới source_to.
    // `-to` của input là vị trí tuyệt đối, không tính từ -ss.
    const seek = Number(run.seek_to) > 0 ? ['-ss', Number(run.seek_to).toFixed(6)] : [];
    const decodeArgs = [args[0], '-hide_banner', '-v', 'info', '-nostdin', '-benchmark', ...seek,
      '-to', (Number(run.source_to) + 0.5).toFixed(3), '-i', source, '-map', '0:v:0', '-f', 'null', '-'];
    console.log(`  [split] ${run.label}: -f null ...`);
    const nullRun = runFfmpegTimed(nullArgs, cwd);
    console.log(`  [split] ${run.label}: chỉ giải mã ${Number(run.seek_to) || 0}..${run.source_to}s ...`);
    const decodeRun = runFfmpegTimed(decodeArgs, cwd);
    out.push({
      label: run.label,
      full_ms: run.run_ms,
      null_ms: nullRun.ms,
      decode_ms: decodeRun.ms,
      null_cpu_s: nullRun.cpu_s,
      decode_cpu_s: decodeRun.cpu_s,
      encode_ms_est: Math.round(run.run_ms - nullRun.ms),
      filter_ms_est: Math.round(nullRun.ms - decodeRun.ms),
      errors: [nullRun.error, decodeRun.error].filter(Boolean),
    });
  }
  return out;
}

/* ---------------- Ca kiểm nhanh bằng lavfi ---------------- */
function prepareLavfiCapture() {
  fs.mkdirSync(tempDir, { recursive: true });
  const seg = 10;
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:d=${seg}:r=30`,
    '-f', 'lavfi', '-i', `color=c=blue:s=1920x1080:d=${seg}:r=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seg * 2}`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
    '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast',
    path.join(tempDir, 'temp_input.mp4')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const sequence = { width: 1920, height: 1080, preset: 'custom', source_width: 1920, source_height: 1080, source_fps: '30', fps: '30' };
  const fields = {
    timeline_json: JSON.stringify([
      { start: seg, end: seg * 2, text: 'blue first', script_index: 1 },
      { start: 0, end: seg, text: 'testsrc second', script_index: 0,
        transform: { position_x: 40, position_y: 0, scale: 50, rotation: 0, opacity: 100 } },
    ]),
    export_settings: JSON.stringify({ resolution: 'sequence', sequence, fps: 'source', codec: 'h264', quality: 'high', audio_bitrate: '192k' }),
    sequence_settings: JSON.stringify(sequence),
  };
  fs.mkdirSync(path.join(captureDir, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(captureDir, 'form.json'), JSON.stringify({ captured_at: new Date().toISOString(), fields, files: [] }));
}

/* ---------------- Tổng hợp ---------------- */
function summarizeRun(run) {
  const s = run.server || {};
  const sc = s.sidecar || {};
  const videoRuns = (sc.runs || []).filter((r) => r.mode !== 'audio');
  const audioRun = (sc.runs || []).find((r) => r.mode === 'audio');
  return {
    kind: run.kind,
    total_s: run.total_ms / 1000,
    prebake_s: Number.isFinite(run.prebake_ms) ? run.prebake_ms / 1000 : null,
    upload_s: Number.isFinite(s.upload_ms) ? s.upload_ms / 1000 : null,
    server_s: Number.isFinite(s.server_ms) ? s.server_ms / 1000 : null,
    sidecar_s: Number.isFinite(s.sidecar_ms) ? s.sidecar_ms / 1000 : null,
    probe_s: Number.isFinite(sc.probe_ms) ? sc.probe_ms / 1000 : null,
    video_s: videoRuns.length ? videoRuns.reduce((a, r) => a + r.run_ms, 0) / 1000 : null,
    audio_s: audioRun ? audioRun.run_ms / 1000 : null,
    concat_s: Number.isFinite(sc.concat_ms) ? sc.concat_ms / 1000 : null,
    download_s: Number.isFinite(run.download_ms) ? run.download_ms / 1000 : null,
    batches: videoRuns.length,
    cpu_pct: run.usage?.cpu_avg_pct ?? null,
    gpu_enc_pct: run.usage?.gpu_enc_pct ?? null,
    gpu_dec_pct: run.usage?.gpu_dec_pct ?? null,
  };
}

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function printTable(rows) {
  const cols = [
    ['lượt', (r, i) => `${i + 1}:${r.kind}`],
    ['tổng s', (r) => fmt(r.total_s)],
    ['vẽ trước', (r) => fmt(r.prebake_s)],
    ['tải lên', (r) => fmt(r.upload_s, 2)],
    ['server', (r) => fmt(r.server_s)],
    ['dò nguồn', (r) => fmt(r.probe_s, 2)],
    ['hình', (r) => fmt(r.video_s)],
    ['tiếng', (r) => fmt(r.audio_s)],
    ['ghép', (r) => fmt(r.concat_s, 2)],
    ['tải về', (r) => fmt(r.download_s, 2)],
    ['batch', (r) => String(r.batches)],
    ['CPU%', (r) => fmt(r.cpu_pct, 0)],
    ['enc%', (r) => fmt(r.gpu_enc_pct, 0)],
    ['dec%', (r) => fmt(r.gpu_dec_pct, 0)],
  ];
  const table = rows.map((r, i) => cols.map(([, f]) => f(r, i)));
  const widths = cols.map(([h], c) => Math.max(h.length, ...table.map((row) => row[c].length)));
  console.log(cols.map(([h], c) => h.padStart(widths[c])).join('  '));
  for (const row of table) console.log(row.map((v, c) => v.padStart(widths[c])).join('  '));
}

function keepRunArtifacts(index, run) {
  const dir = path.join(runsDir, String(index + 1));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const benchDir = path.join(tempDir, 'export_bench');
  if (fs.existsSync(benchDir)) fs.cpSync(benchDir, path.join(dir, 'export_bench'), { recursive: true });
  // Filter script được sidecar GIỮ LẠI khi bench bật (xem ExportBatch) — chép theo.
  for (const name of fs.readdirSync(tempDir)) {
    if (/^export_filter_batch_\d+\.txt$/.test(name) || name === 'export_timeline.json') {
      fs.copyFileSync(path.join(tempDir, name), path.join(dir, name));
    }
  }
  if (run.report_path && fs.existsSync(run.report_path)) {
    fs.copyFileSync(run.report_path, path.join(dir, path.basename(run.report_path)));
  }
  const output = path.join(tempDir, 'final_cut.mp4');
  if (fs.existsSync(output)) {
    if (opts.keepOutput) fs.renameSync(output, path.join(dir, 'final_cut.mp4'));
    else fs.rmSync(output, { force: true });
  }
  fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(run, null, 2));
  return dir;
}

async function main() {
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportsBefore = new Set(fs.readdirSync(REPORTS_DIR));
  const environment = {
    at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    cpu: `${os.cpus()[0]?.model || '?'} × ${os.cpus().length}`,
    ram_gb: Math.round(os.totalmem() / 2 ** 30),
    gpu: firstLine('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']) || '(không có nvidia-smi)',
    ffmpeg: firstLine('ffmpeg', ['-hide_banner', '-version']),
    ffmpeg_dir: opts.ffmpegDir || '(PATH)',
    env: { ...opts.env, CRABBYCUT_EXPORT_BENCH: process.env.CRABBYCUT_EXPORT_BENCH },
  };
  console.log(`[bench-export] fixture "${fixtureLabel}" — ${environment.ffmpeg}`);
  console.log(`  thư mục: ${fixtureDir}`);

  const { start } = require('../../backend/server');
  const server = start();
  await sleep(500);
  const runs = [];
  let splits = null;
  try {
    const hasCapture = fs.existsSync(path.join(captureDir, 'form.json'));
    if (opts.lavfi) {
      prepareLavfiCapture();
    } else if (!opts.replayOnly && (opts.rerecord || !hasCapture)) {
      process.env.CRABBYCUT_EXPORT_CAPTURE_DIR = captureDir;
      try {
        runs.push(await recordInElectron());
      } finally {
        delete process.env.CRABBYCUT_EXPORT_CAPTURE_DIR;
      }
      keepRunArtifacts(0, runs[0]);
    } else {
      assert.ok(hasCapture, `chưa có payload đã ghi ở ${captureDir} — chạy lại không kèm --replay-only`);
      console.log(`  dùng payload đã ghi lúc ${JSON.parse(fs.readFileSync(path.join(captureDir, 'form.json'), 'utf8')).captured_at}`);
    }
    for (let i = 0; i < opts.runs; i++) {
      await waitForIdle('trước lượt phát lại');
      console.log(`  phát lại ${i + 1}/${opts.runs} ...`);
      const run = await replayOnce();
      runs.push(run);
      const summary = summarizeRun(run);
      console.log(`    tổng ${fmt(summary.total_s)} s, sidecar ${fmt(summary.sidecar_s)} s, hình ${fmt(summary.video_s)} s, CPU ${fmt(summary.cpu_pct, 0)}%`);
      const kept = keepRunArtifacts(runs.length - 1, run);
      if (opts.split && i === 0) {
        splits = splitStages(path.join(kept, 'export_bench'), run.server?.sidecar?.runs);
      }
      // Cho export_fidelity.js: render lại đồ thị của lượt này ở FFV1 (và bản chuẩn) NGAY BÂY
      // GIỜ, khi PNG chữ/chuỗi khung của nó còn trong temp.
      if (i === 0 && (opts.lossless || opts.gold)) {
        const { renderFromCommands } = require('./export_fidelity');
        if (opts.lossless) renderFromCommands(kept, { gold: false });
        if (opts.gold) renderFromCommands(kept, { gold: true });
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const rows = runs.map(summarizeRun);
  const replays = rows.filter((r) => r.kind === 'replay');
  const medianOf = (key) => median(replays.map((r) => r[key]));
  const result = {
    kind: 'crabbycut-export-bench',
    version: 2,
    fixture: { label: fixtureLabel, crab: opts.crab || null, cut_seconds: opts.cut || null, dir: fixtureDir },
    tag: opts.tag || null,
    runs_dir: runsDir,
    environment,
    runs,
    summary: rows,
    replay_median: replays.length ? {
      runs: replays.length,
      total_s: medianOf('total_s'),
      server_s: medianOf('server_s'),
      sidecar_s: medianOf('sidecar_s'),
      video_s: medianOf('video_s'),
      audio_s: medianOf('audio_s'),
      cpu_pct: medianOf('cpu_pct'),
    } : null,
    split: splits,
  };
  const outPath = path.join(REPORTS_DIR,
    `perf_export_${fixtureSlug}${opts.tag ? `_${opts.tag}` : ''}_${invocationStamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  console.log('');
  printTable(rows);
  if (result.replay_median) {
    const m = result.replay_median;
    console.log(`\n  trung vị ${m.runs} lượt phát lại: tổng ${fmt(m.total_s)} s · server ${fmt(m.server_s)} s · hình ${fmt(m.video_s)} s · tiếng ${fmt(m.audio_s)} s`);
  }
  if (splits) {
    console.log('\n  tách khâu (lượt phát lại 1): nhãn  thật  -f null  giải mã  => encode≈  filter≈  (giây)');
    for (const s of splits) {
      console.log(`    ${s.label}  ${fmt(s.full_ms / 1000)}  ${fmt(s.null_ms / 1000)}  ${fmt(s.decode_ms / 1000)}  => ${fmt(s.encode_ms_est / 1000)}  ${fmt(s.filter_ms_est / 1000)}${s.errors.length ? `  LỖI: ${s.errors.join('; ')}` : ''}`);
    }
  }
  console.log(`\n[bench-export] ghi ${path.relative(projectRoot, outPath)}`);

  // Báo cáo dự án do chính lần đo sinh ra đã được chép vào runs/<n>/ — xoá khỏi reports/
  // để không lẫn với báo cáo thật của người dùng.
  for (const name of fs.readdirSync(REPORTS_DIR)) {
    if (!reportsBefore.has(name) && /^report_project_\d{8}_\d{6}\.txt$/.test(name)) {
      fs.rmSync(path.join(REPORTS_DIR, name), { force: true });
    }
  }
}

main().catch((error) => {
  console.error('[bench-export] thất bại:', error);
  process.exitCode = 1;
}).finally(() => {
  // Server trong tiến trình giữ vài timer (dọn cache...) -> thoát chủ động.
  setTimeout(() => process.exit(process.exitCode || 0), 200);
});
