#!/usr/bin/env node
/* DỰNG MÔI TRƯỜNG CHẠY CHO BẢN CÀI ĐẶT — tải Python, thư viện, ffmpeg về máy người dùng.
 *
 * VÌ SAO PHẢI CÓ: bản đóng gói KHÔNG mang theo `.venv` (nó gắn cứng đường dẫn máy dev nên
 * chép sang máy khác là hỏng) và cũng không mang ffmpeg. Trước tệp này, bản cài chạy được
 * giao diện nhưng mọi thứ chạm tới Python đều chết với `spawn python ENOENT`.
 *
 * DÙNG BẢN PYTHON NHÚNG, KHÔNG DÙNG PYTHON CỦA MÁY. Hai lý do đều đã thành sự thật:
 *   1. Cài gói vào Python của người dùng là làm bẩn môi trường họ đang dùng cho việc khác,
 *      và rước nguyên một lớp xung đột phiên bản mà ta không kiểm soát nổi.
 *   2. requirements.txt ghim `mediapipe==0.10.21` + `opencv-contrib-python<4.12` kèm marker
 *      `python_version < "3.13"`. Máy mặc định 3.13/3.14 thì `pip install` vẫn BÁO THÀNH
 *      CÔNG, chỉ lặng lẽ bỏ qua hai gói đó, rồi Auto-Reframe chết sau với "No module named
 *      'cv2'". Tự mang 3.12 là cách duy nhất chốt được phiên bản.
 *
 * MỌI BƯỚC PHẢI CHẠY LẠI ĐƯỢC. Người dùng ngắt mạng giữa chừng rồi bấm "Thử lại" là chuyện
 * bình thường, nên mỗi bước tự kiểm "đã xong chưa" trước khi làm, và manifest chỉ được ghi
 * `completed: true` ở bước cuối cùng.
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RuntimePaths = require('./runtime_paths.js');
const { detectMachine } = require('./detect_machine.js');
const { downloadFile, humanBytes } = require('./download_file.js');
const { PYTHON_VERSION, vendorPath } = require('./vendor_assets.js');
const {
  GROUPS, groupsForPlatform, modulesForPlatform, groupById,
  normalizePipName, pipNamesForGroup, onDemandGroups,
} = require('./python_requirements.js');

const IS_WIN = process.platform === 'win32';
const PROJECT_ROOT = path.resolve(__dirname, '..');

/* Python được NHÚNG SẴN vào bộ cài (xem scripts/prepare_installer_assets.js), nên hai URL
 * dưới đây chỉ là đường LÙI — dùng khi chạy từ mã nguồn mà chưa ai chạy
 * `npm run assets:installer`. Phiên bản và tên tệp nằm ở scripts/vendor_assets.js. */
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
/* Build GPL của BtbN: có `zscale` và `libplacebo` — hai filter mà đường tonemap HDR của
 * backend dựa vào. Bản "essentials" của gyan.dev THIẾU libplacebo, đừng đổi sang đó. */
const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
/* torch bản mặc định trên PyPI cho Windows là bản CUDA (~2,5 GB). Đường ASR trên Windows
 * chạy bằng faster-whisper/ctranslate2 chứ KHÔNG dùng torch — torch chỉ có mặt vì
 * core_logic.py import nó ở top-level. Lấy bản CPU để khỏi tải 2,5 GB cho một import. */
const TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu';

/* Bao lâu không nghe thấy gì từ pip thì coi là chết. Phải RỘNG RÃI: giải nén torch hoặc
 * biên dịch openai-whisper có thể im lặng vài phút mà vẫn đang chạy bình thường. 5 phút đủ
 * xa mọi khoảng im lặng hợp lệ đo được, và vẫn đủ gần để người dùng không ngồi nhìn một cửa
 * sổ chết suốt buổi. */
const PIP_STALL_MS = 5 * 60 * 1000;
const PIP_ATTEMPTS = 3;
/* Tải file lẻ (Python, ffmpeg) cũng phải thử lại: python.org đo được lúc nhanh 2,5 MB/s
 * lúc 50 KB/s trên cùng một máy, và một lượt đứt giữa chừng không có lý do gì phải làm hỏng
 * cả lượt cài. */
const DOWNLOAD_ATTEMPTS = 3;

/* CHỈ CÓ BẤY NHIÊU BƯỚC TRONG LÚC CÀI ĐẶT.
 * Các thư viện AI (torch, whisper, faster-whisper, mediapipe, opencv, cuBLAS — cộng lại
 * ~2,5 GB) KHÔNG nằm ở đây nữa: chúng được tải ở lần đầu người dùng chạm vào đúng tính năng
 * cần chúng, xem `installFeature()`. Xem thêm chú thích đầu bảng GROUPS ở
 * scripts/python_requirements.js.
 *
 * Trọng số lấy theo thời gian thật đo được, không chia đều. */
const STAGE_WEIGHTS = [
  { id: 'detect', label: 'Kiểm tra cấu hình máy', weight: 4 },
  { id: 'vcredist', label: 'Thư viện hệ thống Visual C++', weight: 6 },
  { id: 'python', label: 'Cài đặt Python', weight: 26 },
  { id: 'pip', label: 'Chuẩn bị trình cài gói', weight: 14 },
  { id: 'ffmpeg', label: 'Cài đặt FFmpeg', weight: 42 },
  { id: 'verify', label: 'Kiểm tra lại', weight: 8 },
];

/* Bước của lượt cài MỘT NHÓM theo yêu cầu. Dùng chung bộ máy tiến độ với bảng trên, nhưng
 * là một thang riêng — lượt này chỉ có tải gói và kiểm lại. */
const FEATURE_STAGE_WEIGHTS = [
  { id: 'packages', label: 'Tải thư viện', weight: 92 },
  { id: 'verify', label: 'Kiểm tra lại', weight: 8 },
];

let stageTable = STAGE_WEIGHTS;

let emit = () => {};
let logStream = null;

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try { logStream?.write(text); } catch (_) { /* log hỏng không được làm chết setup */ }
}

/* Gộp tiến độ cục bộ của một bước thành tiến độ toàn cục.
 *
 * `quiet` = vẫn bắn sự kiện cho cửa sổ nhưng KHÔNG ghi xuống nhật ký. Dành cho các nhịp
 * tần suất cao (thanh tải file, thanh tiến độ của pip): chúng bắn vài lần mỗi giây, ghi hết
 * thì một lượt cài để lại vài chục nghìn dòng gần như giống hệt nhau và thứ thật sự cần khi
 * đi truy lỗi — gói nào hỏng, URL nào không với tới được — chìm mất. */
function stageProgress(stageId, ratio, message, quiet = false) {
  let before = 0;
  let current = 0;
  let total = 0;
  for (const stage of stageTable) {
    total += stage.weight;
    if (stage.id === stageId) current = stage.weight;
    else if (current === 0) before += stage.weight;
  }
  const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
  emit({
    type: 'progress',
    stage: stageId,
    stage_label: stageTable.find((s) => s.id === stageId)?.label || stageId,
    stage_ratio: clamped,
    ratio: (before + current * clamped) / total,
    message: message || null,
  });
  if (message && !quiet) log(`${stageId}: ${message}`);
}

/* Tệp này đã được NHÚNG SẴN vào bộ cài chưa? Nếu có thì khỏi đụng tới mạng.
 * Xem scripts/prepare_installer_assets.js — nó kéo các tệp này về `vendor/` lúc DỰNG. */
function bundledAsset(vendorKey) {
  if (!vendorKey) return null;
  try {
    const file = vendorPath(vendorKey);
    return fs.existsSync(file) ? file : null;
  } catch (_) {
    return null;
  }
}

async function downloadCached(url, fileName, stageId, label, vendorKey) {
  const bundled = bundledAsset(vendorKey);
  if (bundled) {
    log(`Dùng tệp nhúng sẵn trong bộ cài: ${bundled}`);
    stageProgress(stageId, 1, `${label} — đã có sẵn trong bộ cài, không cần tải.`);
    return bundled;
  }

  const dir = RuntimePaths.downloadCacheDir();
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  if (fs.existsSync(dest)) {
    log(`Dùng lại file đã tải: ${dest}`);
    return dest;
  }
  let lastTick = 0;
  const onProgress = (received, total) => {
    const now = Date.now();
    // Bắn tối đa ~10 sự kiện/giây: NDJSON của một lượt tải 400 MB mà không tiết chế thì
    // riêng việc vẽ lại giao diện đã ăn hết CPU.
    if (now - lastTick < 100 && received !== total) return;
    lastTick = now;
    const text = total
      ? `${label} — ${humanBytes(received)} / ${humanBytes(total)}`
      : `${label} — ${humanBytes(received)}`;
    stageProgress(stageId, total ? received / total : 0, text, true);
  };

  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      await downloadFile(url, dest, onProgress);
      return dest;
    } catch (error) {
      lastError = error;
      log(`Tải thất bại lần ${attempt}/${DOWNLOAD_ATTEMPTS}: ${error.message}`);
      /* Xoá file dở trước khi thử lại — `download()` ghi vào `.part` rồi mới đổi tên, nên
       * một mảnh sót lại không làm hỏng lượt sau, nhưng dọn đi thì đỡ chiếm đĩa. */
      await fsp.rm(`${dest}.part`, { force: true }).catch(() => {});
      if (attempt < DOWNLOAD_ATTEMPTS) {
        stageProgress(stageId, 0, `${label} — mạng trục trặc, đang thử lại (lần ${attempt + 1}/${DOWNLOAD_ATTEMPTS}).`);
        await new Promise((done) => setTimeout(done, 3000));
      }
    }
  }
  throw lastError;
}

/* Chạy một tiến trình con, đẩy từng dòng stdout/stderr ra ngoài để cửa sổ thiết lập hiển
 * thị. `pip install` im lặng mười phút là thứ khiến người dùng bấm tắt. */
function runStreaming(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(`$ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    /* ĐỒNG HỒ CHẾT ĐỨNG.
     * Đã gặp thật: pip đang tải nvidia_cublas (420 MB) thì kết nối tới PyPI chết — socket
     * biến mất (netstat không còn kết nối nào), file .whl đứng ở 0 byte, mà pip KHÔNG thoát
     * và cũng không báo gì. Cửa sổ thiết lập treo vô thời hạn ở 49%.
     * `--timeout`/`--retries` của pip lo được phần lớn ca, nhưng không phải mọi ca (nó chỉ
     * tính giờ cho socket của CHÍNH nó). Đây là lưới đỡ cuối: im lặng hoàn toàn quá lâu thì
     * giết tiến trình con và ném lỗi — bên gọi sẽ thử lại, và wheel đã tải xong vẫn nằm
     * trong pip-cache nên lượt thử lại không phải tải lại từ đầu. */
    let stallTimer = null;
    const stallMs = options.stallMs || 0;
    const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
    const armStall = () => {
      if (!stallMs) return;
      clearStall();
      stallTimer = setTimeout(() => {
        log(`Không nhận được dữ liệu trong ${Math.round(stallMs / 1000)} giây — huỷ tiến trình con.`);
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
          else child.kill('SIGKILL');
        } catch (_) { /* no-op */ }
      }, stallMs);
    };
    armStall();
    const tail = [];
    /* Thanh tiến độ của pip refresh vài lần MỖI GIÂY. Ghi hết vào nhật ký thì một lượt cài
     * để lại vài chục nghìn dòng gần như giống hệt nhau, và thứ thật sự cần khi đi truy lỗi
     * (gói nào hỏng, URL nào không với tới được) chìm mất. Vẫn CHUYỂN TIẾP cho `onLine` để
     * cửa sổ thiết lập hiển thị được, chỉ không ghi xuống đĩa. */
    const isProgressBar = (line) => /[─━#=]{4,}|\d+(?:\.\d+)?\/\d+(?:\.\d+)?\s*(?:kB|MB|GB)/i.test(line);
    const onLine = (line) => {
      if (!line.trim()) return;
      armStall();
      if (!isProgressBar(line)) {
        tail.push(line);
        if (tail.length > 40) tail.shift();
        log(`  | ${line}`);
      }
      if (options.onLine) options.onLine(line);
    };
    let outBuf = '';
    let errBuf = '';
    /* TÁCH THEO CẢ `\r` LẪN `\n`, KHÔNG CHỈ `\n`.
     * pip vẽ thanh tiến độ tải bằng cách ghi đè MỘT dòng bằng ký tự `\r` — không có `\n`
     * nào cho tới khi tải xong. Tách theo `/\r?\n/` thì suốt lượt tải torch (~200 MB, vài
     * phút) không một dòng nào thoát ra: cửa sổ thiết lập đứng im và người dùng tưởng treo.
     * Đây là đúng khoảng im lặng đã quan sát được trong nhật ký lượt chạy thử. */
    const pump = (buffer, chunk) => {
      const merged = buffer + chunk.toString('utf8');
      const lines = merged.split(/\r\n|\r|\n/);
      const rest = lines.pop() || '';
      lines.forEach(onLine);
      return rest;
    };
    child.stdout.on('data', (chunk) => { outBuf = pump(outBuf, chunk); });
    child.stderr.on('data', (chunk) => { errBuf = pump(errBuf, chunk); });
    child.on('error', (error) => { clearStall(); reject(error); });
    child.on('exit', (code) => {
      clearStall();
      if (outBuf.trim()) onLine(outBuf);
      if (errBuf.trim()) onLine(errBuf);
      if (code === 0 || options.allowFailure) resolve(code);
      else reject(new Error(`${path.basename(command)} thoát với mã ${code}\n${tail.slice(-12).join('\n')}`));
    });
  });
}

/* GIẢI NÉN ZIP KHÔNG CẦN THƯ VIỆN NGOÀI.
 * `tar.exe` của Windows 10 1803+ là bsdtar, đọc được zip và nhanh hơn Expand-Archive nhiều
 * lần. Expand-Archive giữ lại làm lưới đỡ cho bản Windows cũ hơn. */
async function extractZip(zipPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  if (IS_WIN) {
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(tarExe)) {
      try {
        await runStreaming(tarExe, ['-xf', zipPath, '-C', destDir]);
        return;
      } catch (error) {
        log(`tar.exe không giải nén được (${error.message}); chuyển sang Expand-Archive.`);
      }
    }
    await runStreaming('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ]);
    return;
  }
  await runStreaming('unzip', ['-o', zipPath, '-d', destDir]);
}

// ---------------------------------------------------------------------------
// Các bước

async function stageVcRedist(machine) {
  if (!IS_WIN || machine.vcredist.present) {
    stageProgress('vcredist', 1, 'Thư viện Visual C++ đã có sẵn.');
    return { installed: false, present: true };
  }
  stageProgress('vcredist', 0, 'Máy thiếu Visual C++ Runtime — đang tải bản cài chính thức của Microsoft.');
  const installer = await downloadCached(VC_REDIST_URL, 'vc_redist.x64.exe', 'vcredist', 'Visual C++ Runtime');
  stageProgress('vcredist', 0.7, 'Đang cài Visual C++ Runtime (có thể hiện hộp thoại xin quyền quản trị).');
  /* KHÔNG để lỗi ở đây làm chết cả lượt thiết lập: gói này cần quyền quản trị, người dùng
   * hoàn toàn có thể bấm "No" ở hộp thoại UAC. Thiếu nó thì chỉ mediapipe/opencv hỏng
   * (Auto-Reframe, Retouch) — bóc băng và dựng phim vẫn chạy. Báo ở bước verify. */
  const code = await runStreaming(installer, ['/install', '/quiet', '/norestart'], { allowFailure: true });
  stageProgress('vcredist', 1, code === 0 ? 'Đã cài Visual C++ Runtime.' : 'Bỏ qua Visual C++ Runtime (chưa cài được).');
  return { installed: code === 0, present: code === 0, exit_code: code };
}

async function stagePython() {
  const pythonExe = RuntimePaths.runtimePython();
  if (fs.existsSync(pythonExe)) {
    stageProgress('python', 1, `Python ${PYTHON_VERSION} đã có trong thư mục ứng dụng.`);
    return { version: PYTHON_VERSION, path: pythonExe, reused: true };
  }
  if (!IS_WIN) throw new Error('Bộ thiết lập tự động hiện chỉ hỗ trợ Windows.');

  stageProgress('python', 0, `Đang tải Python ${PYTHON_VERSION}.`);
  const zip = await downloadCached(PYTHON_EMBED_URL, `python-${PYTHON_VERSION}-embed-amd64.zip`, 'python', `Python ${PYTHON_VERSION}`, 'python');

  stageProgress('python', 0.8, 'Đang giải nén Python.');
  const home = RuntimePaths.pythonHome();
  await fsp.rm(home, { recursive: true, force: true });
  await extractZip(zip, home);

  /* BẢN NHÚNG MẶC ĐỊNH KHÔNG THẤY site-packages.
   * File `python312._pth` chốt cứng sys.path và để `import site` ở dạng chú thích. Giữ
   * nguyên thì pip cài xong, gói nằm đúng chỗ, mà `import faster_whisper` vẫn báo không
   * tìm thấy — không có một thông báo nào nhắc tới `._pth`. Phải ghi đè file này. */
  const tag = `python${PYTHON_VERSION.split('.').slice(0, 2).join('')}`;
  const pthPath = path.join(home, `${tag}._pth`);
  await fsp.writeFile(pthPath, [
    `${tag}.zip`,
    '.',
    'Lib\\site-packages',
    '',
    '# CrabbyCut: bắt buộc bật site để pip và site-packages hoạt động.',
    'import site',
    '',
  ].join('\r\n'), 'utf8');
  await fsp.mkdir(path.join(home, 'Lib', 'site-packages'), { recursive: true });

  stageProgress('python', 1, `Đã cài Python ${PYTHON_VERSION}.`);
  return { version: PYTHON_VERSION, path: pythonExe, reused: false };
}

async function stagePip(pythonExe) {
  const check = await runStreaming(pythonExe, ['-m', 'pip', '--version'], { allowFailure: true });
  if (check === 0) {
    stageProgress('pip', 1, 'pip đã sẵn sàng.');
    return;
  }
  stageProgress('pip', 0.1, 'Đang tải get-pip.');
  const getPip = await downloadCached(GET_PIP_URL, 'get-pip.py', 'pip', 'get-pip', 'getPip');
  stageProgress('pip', 0.5, 'Đang cài pip.');
  await runStreaming(pythonExe, [getPip, '--no-warn-script-location'], {
    onLine: (line) => stageProgress('pip', 0.7, line.slice(0, 160)),
  });
  stageProgress('pip', 1, 'Đã cài pip.');
}

/* Lọc requirements.txt thành một tệp con CHỈ chứa những gói của một nhóm tính năng.
 *
 * CỐ Ý KHÔNG viết sẵn một danh sách gói thứ hai ở đây: requirements.txt vẫn là nguồn sự
 * thật duy nhất về PHIÊN BẢN và marker (`mediapipe==0.10.21`,
 * `opencv-contrib-python<4.12; python_version < "3.13"`). Bảng GROUPS chỉ nói gói nào
 * thuộc tính năng nào. Chép tay phiên bản sang đây là chắc chắn có ngày hai bên lệch nhau,
 * và kiểu lệch đó không báo lỗi — nó cài nhầm phiên bản rồi chết ở một chỗ khác hẳn.
 *
 * `null` = nhóm này không có gói nào hợp lệ trên nền tảng hiện tại (ví dụ `asr_mac` trên
 * Windows: mọi dòng đều bị marker `platform_system == "Darwin"` loại).
 */
async function requirementsForFeature(featureId, machine) {
  const wanted = new Set(pipNamesForGroup(featureId, {
    platform: process.platform,
    hasNvidia: !!machine?.nvidia?.available,
  }));
  if (!wanted.size) return null;

  const source = await fsp.readFile(path.join(PROJECT_ROOT, 'requirements.txt'), 'utf8');
  const picked = [];
  const seen = new Set();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const name = normalizePipName(line.split(/[<>=!~;\s[]/)[0]);
    if (!wanted.has(name)) continue;
    picked.push(line);
    seen.add(name);
  }

  /* Gói có trong bảng GROUPS mà KHÔNG có dòng nào trong requirements.txt: vẫn cài, không
   * ghim phiên bản. Đây đúng ca `numpy` — nó được import ở auto_reframe_sidecar.py nhưng
   * requirements.txt không liệt kê (nó về theo torch/opencv). Bỏ qua thì nhóm `vision`
   * thiếu một gói mà không ai biết. */
  for (const name of wanted) {
    if (!seen.has(name)) picked.push(name);
  }

  if (!picked.length) return null;

  const outPath = path.join(RuntimePaths.runtimeRoot(), `requirements.${featureId}.txt`);
  await fsp.writeFile(outPath, `${picked.join('\n')}\n`, 'utf8');
  return { path: outPath, packages: picked };
}

/* Bộ đôi cờ + hàm bọc dùng chung cho MỌI lượt gọi pip, dù là lúc cài đặt hay lúc tải nhóm
 * theo yêu cầu. Gom về một chỗ để hai đường không bao giờ chạy với cấu hình khác nhau.
 *
 * BA CỜ DƯỚI ĐÂY ĐỀU LÀ HẬU QUẢ CỦA MỘT LẦN TREO THẬT (tải nvidia_cublas 420 MB):
 *   --timeout 30  : pip mặc định chờ 15 giây cho lượt KẾT NỐI, nhưng một socket đã bắt tay
 *                   xong rồi chết giữa chừng thì không có ai tính giờ cả -> treo vĩnh viễn.
 *                   Cờ này áp hạn cho cả lượt đọc.
 *   --retries 5   : nối lại thay vì chết hẳn khi mạng chập chờn.
 *   --progress-bar raw : pip CHỈ vẽ thanh tiến độ khi stdout là terminal. Ở đây stdout là
 *                   ống dẫn, nên pip im lặng suốt lượt tải 420 MB và người dùng không thể
 *                   phân biệt "đang tải chậm" với "đã chết". Chế độ `raw` in ra
 *                   `Progress <đã tải> of <tổng>` dạng văn bản thuần, đọc được qua ống dẫn.
 */
function pipEnvFor() {
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    /* Cache của pip mặc định nằm ở %LOCALAPPDATA%\pip — để nguyên thì gỡ CrabbyCut xong
     * vẫn còn ~1 GB rác trong hồ sơ người dùng. Dồn vào thư mục runtime để dọn được, và để
     * lượt thử lại sau khi đứt mạng không phải tải lại từ đầu. */
    PIP_CACHE_DIR: path.join(RuntimePaths.runtimeRoot(), 'pip-cache'),
  };
}

function makePipRunner(pythonExe) {
  const env = pipEnvFor();
  const pipInstall = (args, onLine) => runStreaming(
    pythonExe,
    [
      '-m', 'pip', 'install', '--no-warn-script-location',
      '--timeout', '30', '--retries', '5', '--progress-bar', 'raw',
      ...args,
    ],
    { env, onLine, stallMs: PIP_STALL_MS },
  );

  /* Thử lại CẢ LỆNH pip khi nó chết vì mạng. Rẻ vì mọi wheel đã tải xong đều còn trong
   * pip-cache: lượt thử lại bỏ qua chúng và đi thẳng tới gói đang dở. */
  return async function pipInstallWithRetry(args, onLine, label) {
    let lastError = null;
    for (let attempt = 1; attempt <= PIP_ATTEMPTS; attempt += 1) {
      try {
        await pipInstall(args, onLine);
        return;
      } catch (error) {
        lastError = error;
        log(`pip thất bại lần ${attempt}/${PIP_ATTEMPTS} (${label}): ${error.message}`);
        if (attempt < PIP_ATTEMPTS) {
          stageProgress('packages', 0.5, `Mạng trục trặc — đang thử lại ${label} (lần ${attempt + 1}/${PIP_ATTEMPTS}).`);
          await new Promise((done) => setTimeout(done, 3000));
        }
      }
    }
    throw lastError;
  };
}

/* Đọc dòng của pip thành thông báo người dùng hiểu được.
 * Quan trọng nhất là nhánh `Progress ... of ...`: đây là thứ DUY NHẤT cho người dùng biết
 * một lượt tải 420 MB còn sống hay đã chết. */
function makePipLineReader(ratioFor) {
  let currentPackage = '';
  return (line) => {
    const raw = line.match(/^\s*Progress\s+(\d+)\s+of\s+(\d+)/i);
    if (raw) {
      const name = currentPackage ? `${currentPackage} — ` : '';
      stageProgress('packages', ratioFor('download'), `Đang tải ${name}${humanBytes(Number(raw[1]))} / ${humanBytes(Number(raw[2]))}`, true);
      return;
    }
    const collecting = line.match(/^\s*(?:Collecting|Downloading|Building wheel for)\s+([^\s<>=;(]+)/i);
    if (collecting) {
      currentPackage = collecting[1];
      stageProgress('packages', ratioFor('download'), `Đang tải ${currentPackage}`);
    } else if (/^\s*Installing collected packages/i.test(line)) {
      currentPackage = '';
      stageProgress('packages', ratioFor('install'), 'Đang cài đặt các gói đã tải.');
    } else if (/^\s*Successfully installed/i.test(line)) {
      stageProgress('packages', ratioFor('done'), 'Đã cài xong các gói.');
    }
  };
}


async function stageFfmpeg(machine) {
  /* Dùng lại ffmpeg của máy khi nó ĐỦ FILTER — tiết kiệm ~180 MB tải về. Phép kiểm "đủ
   * filter" nằm ở detect_machine.js: chỉ `ffmpeg -version` chạy được là chưa đủ, build
   * thiếu `zscale` sẽ chết lúc export chứ không chết lúc kiểm. */
  if (machine.ffmpeg?.usable) {
    stageProgress('ffmpeg', 1, `Dùng FFmpeg sẵn có trên máy: ${machine.ffmpeg.path}`);
    return { source: 'system', path: machine.ffmpeg.path, dir: path.dirname(machine.ffmpeg.path) };
  }
  if (fs.existsSync(RuntimePaths.ffmpegBinary('ffmpeg'))) {
    stageProgress('ffmpeg', 1, 'FFmpeg riêng của ứng dụng đã có sẵn.');
    return { source: 'bundled', path: RuntimePaths.ffmpegBinary('ffmpeg'), dir: RuntimePaths.ffmpegDir() };
  }
  if (!IS_WIN) throw new Error('Bộ thiết lập tự động hiện chỉ hỗ trợ Windows.');

  stageProgress('ffmpeg', 0, 'Máy chưa có FFmpeg phù hợp — đang tải bản riêng cho ứng dụng.');
  const zip = await downloadCached(FFMPEG_URL, 'ffmpeg-win64-gpl.zip', 'ffmpeg', 'FFmpeg');

  stageProgress('ffmpeg', 0.8, 'Đang giải nén FFmpeg.');
  const staging = path.join(RuntimePaths.runtimeRoot(), 'ffmpeg-staging');
  await fsp.rm(staging, { recursive: true, force: true });
  await extractZip(zip, staging);

  /* Zip của BtbN bọc mọi thứ trong MỘT thư mục có tên kèm ngày build
   * (ffmpeg-master-latest-win64-gpl/bin/...). Tên đó đổi theo mỗi bản nên phải đi tìm
   * `bin/ffmpeg.exe` chứ không ghép đường dẫn cứng. */
  const binDir = await findFfmpegBin(staging);
  if (!binDir) throw new Error('Không tìm thấy ffmpeg.exe trong gói vừa tải.');

  const target = RuntimePaths.ffmpegDir();
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(target, { recursive: true });
  for (const name of await fsp.readdir(binDir)) {
    await fsp.copyFile(path.join(binDir, name), path.join(target, name));
  }
  await fsp.rm(staging, { recursive: true, force: true });

  stageProgress('ffmpeg', 1, 'Đã cài FFmpeg.');
  return { source: 'bundled', path: RuntimePaths.ffmpegBinary('ffmpeg'), dir: target };
}

async function findFfmpegBin(root, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { return null; }
  if (entries.some((entry) => entry.isFile() && /^ffmpeg\.exe$/i.test(entry.name))) return root;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hit = await findFfmpegBin(path.join(root, entry.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

/* PHÉP KIỂM SÂU — import THẬT từng module, không dùng find_spec.
 * find_spec trả `true` KHÔNG chứng minh gói chạy được: ca đã gặp là ctranslate2 4.4 có spec
 * đầy đủ nhưng `import` nổ vì `pkg_resources`. Đây là bước cuối nên chịu được vài giây. */
const VERIFY_SCRIPT = [
  'import json, sys',
  'result = {}',
  'for name in sys.argv[1:]:',
  '    try:',
  '        __import__(name)',
  '        result[name] = {"ok": True}',
  '    except Exception as exc:',
  '        result[name] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}',
  'print(json.dumps({"python": sys.version.split()[0], "modules": result}, ensure_ascii=False))',
].join('\n');

async function verifyModules(pythonExe, modules) {
  if (!modules.length) return { python: null, modules: {} };
  const output = [];
  await runStreaming(pythonExe, ['-c', VERIFY_SCRIPT, ...modules], {
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    onLine: (line) => output.push(line),
  });
  const jsonLine = [...output].reverse().find((line) => line.trim().startsWith('{'));
  if (!jsonLine) return { python: null, modules: {} };
  try { return JSON.parse(jsonLine); } catch (_) { return { python: null, modules: {} }; }
}

/* KIỂM PHẦN LÕI — và CHỈ phần lõi.
 * Bước cài đặt không còn kéo thư viện AI nào về nữa, nên kiểm chúng ở đây thì lượt cài nào
 * cũng kết thúc với một danh sách "thiếu" dài dằng dặc — đúng thứ làm người dùng tưởng bộ
 * cài hỏng. Cái cần chứng minh ở đây chỉ là: Python chạy được, và FFmpeg chạy được. */
async function stageVerify(pythonExe, ffmpeg) {
  stageProgress('verify', 0.2, 'Đang kiểm tra Python.');
  const report = await verifyModules(pythonExe, ['json', 'zlib', 'ssl']);
  /* `ssl` là module DUY NHẤT trong ba cái trên có thể thiếu thật ở bản nhúng, và thiếu nó
   * thì MỌI lượt tải gói về sau đều chết — bắt ngay ở đây thay vì để lộ ra lúc người dùng
   * bấm Bóc băng. */
  const pythonOk = Object.values(report.modules).every((item) => item.ok);

  stageProgress('verify', 0.6, 'Đang kiểm tra FFmpeg.');
  const ffmpegExe = ffmpeg.source === 'system' ? ffmpeg.path : RuntimePaths.ffmpegBinary('ffmpeg');
  let ffmpegOk = false;
  try {
    await runStreaming(ffmpegExe, ['-hide_banner', '-version']);
    ffmpegOk = true;
  } catch (error) {
    log(`FFmpeg không chạy được: ${error.message}`);
  }

  stageProgress('verify', 1, pythonOk && ffmpegOk
    ? 'Môi trường cơ bản đã sẵn sàng.'
    : 'Kiểm tra xong — còn thành phần chưa đạt.');

  return {
    python_version: report.python,
    python_ok: pythonOk,
    modules: report.modules,
    ffmpeg_ok: ffmpegOk,
  };
}

// ---------------------------------------------------------------------------
// CÀI MỘT NHÓM TÍNH NĂNG THEO YÊU CẦU

/* Nhóm này đã cài chưa? Đọc manifest chứ KHÔNG gọi Python.
 * Hàm này nằm trên đường đi của mọi lượt bấm nút có dùng Python, nên nó phải rẻ. Phép kiểm
 * thật (import từng module) chỉ chạy một lần, ngay sau khi cài xong. */
function featureInstalled(featureId) {
  const manifest = RuntimePaths.readManifest();
  return !!manifest?.features?.[featureId]?.installed;
}

/* Tải và cài thư viện cho MỘT tính năng.
 *
 * Gọi lại khi đã cài rồi thì trả về ngay (trừ khi `force`), nên bên gọi cứ việc gọi vô tư
 * trước mỗi lần dùng tính năng mà không phải tự nhớ trạng thái.
 */
/* MỘT LƯỢT CÀI TẠI MỘT THỜI ĐIỂM, TRÊN TOÀN BỘ TIẾN TRÌNH.
 *
 * Khoá theo NHÓM (ở backend) là chưa đủ: người dùng hoàn toàn có thể chạm vào hai tính năng
 * khác nhau gần nhau — Bóc băng rồi Auto-Reframe. Hai lượt `installFeature` khác nhóm chạy
 * song song thì (a) hai tiến trình pip cùng ghi vào MỘT `site-packages`, và (b) chúng dùng
 * chung `logStream`/`stageTable` ở cấp module nên lượt kết thúc trước đóng nhật ký của lượt
 * còn đang chạy. Nối đuôi nhau là đủ; không lượt nào bị bỏ. */
let featureQueue = Promise.resolve();

function installFeature(featureId, options = {}) {
  const group = groupById(featureId);
  if (!group) {
    /* Nhóm CÓ trong bảng nhưng không dành cho nền tảng này (đúng ca `asr_mac` trên Windows,
     * `asr` trên macOS) là chuyện BÌNH THƯỜNG — `groupsForPlatform()` đã lọc nó ra. Ném ở
     * đây thì backend gọi tới là chết cả lượt chạy sidecar, trong khi chẳng có gì sai cả.
     * Chỉ id KHÔNG tồn tại trong bảng mới là lỗi lập trình, và lỗi đó phải kêu to. */
    const known = GROUPS.some((item) => item.id === featureId);
    if (known) return Promise.resolve({ featureId, skipped: 'not_on_this_platform' });
    return Promise.reject(new Error(`Không có nhóm tính năng "${featureId}".`));
  }

  /* Phép kiểm "đã cài rồi" nằm NGOÀI hàng đợi: nó chỉ đọc một tệp JSON, và bắt nó xếp hàng
   * sau một lượt tải 400 MB thì mọi lượt bấm nút đều đứng hình. */
  if (!options.force && featureInstalled(featureId)) {
    return Promise.resolve({ featureId, alreadyInstalled: true });
  }

  const task = featureQueue.then(
    () => runFeatureInstall(group, featureId, options),
    () => runFeatureInstall(group, featureId, options),
  );
  // Hàng đợi chỉ để nối thứ tự — nuốt lỗi ở đây để một lượt hỏng không chặn lượt sau.
  featureQueue = task.catch(() => {});
  return task;
}

async function runFeatureInstall(group, featureId, options = {}) {
  /* Kiểm lại sau khi tới lượt: lượt chạy trước trong hàng đợi có thể chính là nhóm này
   * (người dùng bấm hai lần trước khi lượt đầu kịp ghi manifest). */
  if (!options.force && featureInstalled(featureId)) {
    return { featureId, alreadyInstalled: true };
  }

  const pythonExe = RuntimePaths.runtimePython();
  if (!fs.existsSync(pythonExe)) {
    throw new Error(
      'Môi trường Python của CrabbyCut chưa được cài. '
      + 'Hãy cài lại ứng dụng, hoặc mở lại CrabbyCut để chạy bước thiết lập.',
    );
  }

  const root = RuntimePaths.runtimeRoot();
  await fsp.mkdir(root, { recursive: true });
  logStream = fs.createWriteStream(RuntimePaths.setupLogPath(), { flags: 'a' });
  stageTable = FEATURE_STAGE_WEIGHTS;
  log(`=== Cài thư viện cho tính năng: ${group.label} ===`);

  try {
    /* Lấy lại cấu hình máy từ manifest thay vì dò lại: phép dò tốn vài giây (nvidia-smi,
     * ffprobe, duyệt PATH) và ở đây chỉ cần đúng MỘT thông tin — có GPU NVIDIA hay không. */
    const machine = RuntimePaths.readManifest()?.machine || detectMachine(root);
    const requirements = await requirementsForFeature(featureId, machine);
    if (!requirements) {
      /* Không có gói nào hợp lệ trên nền tảng này (ví dụ `asr_mac` trên Windows). Đánh dấu
       * đã cài để bên gọi khỏi hỏi lại mãi. */
      RuntimePaths.markFeature(featureId, { installed: true, packages: [] });
      return { featureId, alreadyInstalled: false, packages: [] };
    }

    log(`Gói cần cài: ${requirements.packages.join(', ')}`);
    const pipInstallWithRetry = makePipRunner(pythonExe);
    const pipLine = makePipLineReader((phase) => (phase === 'download' ? 0.45 : 0.9));

    stageProgress('packages', 0.02, `Chuẩn bị tải thư viện cho ${group.trigger || group.label}.`);

    /* torch PHẢI lấy từ index CPU. Bản mặc định trên PyPI cho Windows là bản CUDA ~2,5 GB,
     * trong khi đường ASR chạy bằng ctranslate2 chứ không dùng torch để tính. Cài trước từ
     * index CPU thì tới lượt tệp requirements pip thấy `torch` đã thoả và bỏ qua. */
    if (requirements.packages.some((line) => normalizePipName(line.split(/[<>=!~;\s[]/)[0]) === 'torch')) {
      stageProgress('packages', 0.05, 'Đang tải PyTorch (bản CPU).');
      await pipInstallWithRetry(['torch', '--index-url', TORCH_CPU_INDEX], pipLine, 'PyTorch');
    }

    await pipInstallWithRetry(['-r', requirements.path], pipLine, group.label);

    stageProgress('verify', 0.3, 'Đang kiểm tra lại thư viện vừa cài.');
    const modules = group.modules.map((item) => item.module);
    const report = await verifyModules(pythonExe, modules);
    const failed = group.modules
      .filter((item) => report.modules[item.module] && !report.modules[item.module].ok)
      .map((item) => ({ module: item.module, pip: item.pip, error: report.modules[item.module].error }));

    if (failed.length) {
      /* KHÔNG đánh dấu đã cài. Đánh dấu ở đây thì lần sau bên gọi tin là đủ, chạy thẳng vào
       * sidecar và chết với "No module named" — mất luôn cơ hội tải lại. */
      const detail = failed.map((item) => `${item.pip} (${item.error})`).join('; ');
      throw new Error(`Cài xong nhưng vẫn thiếu: ${detail}`);
    }

    RuntimePaths.markFeature(featureId, {
      installed: true,
      packages: requirements.packages,
      modules,
    });

    /* DỌN CACHE pip SAU KHI ĐÃ XÁC NHẬN CÀI ĐÚNG — đo được 683 MB cho riêng nhóm `asr`,
     * gần bằng chính số byte đã cài vào site-packages.
     *
     * Dọn Ở ĐÂY chứ không sớm hơn: trong lúc cài, cache chính là thứ khiến một lượt đứt
     * mạng không phải tải lại từ đầu (xem `pipInstallWithRetry`). Sau khi `verifyModules()`
     * đã nói mọi module import được thì nó không còn việc gì nữa.
     *
     * Cái giá: nhóm cài sau phải tải lại vài gói dùng chung (numpy, typing-extensions…) —
     * vài MB, đổi lấy vài trăm MB không bao giờ đọc tới. */
    await fsp.rm(path.join(RuntimePaths.runtimeRoot(), 'pip-cache'), { recursive: true, force: true })
      .catch(() => { /* dọn không được thì thôi, không phải lỗi của lượt cài */ });
    stageProgress('verify', 1, `Đã cài xong thư viện cho ${group.trigger || group.label}.`);
    log(`=== Cài xong tính năng: ${group.label} ===`);
    return { featureId, alreadyInstalled: false, packages: requirements.packages };
  } catch (error) {
    log(`LỖI khi cài tính năng ${featureId}: ${error?.stack || error?.message || error}`);
    throw error;
  } finally {
    stageTable = STAGE_WEIGHTS;
    try { logStream?.end(); } catch (_) { /* no-op */ }
    logStream = null;
  }
}

// ---------------------------------------------------------------------------

async function setupRuntime(options = {}) {
  const root = RuntimePaths.runtimeRoot();
  await fsp.mkdir(root, { recursive: true });
  logStream = fs.createWriteStream(RuntimePaths.setupLogPath(), { flags: 'a' });
  log(`=== Bắt đầu thiết lập (CrabbyCut) ===`);

  try {
    stageProgress('detect', 0.2, 'Đang đọc cấu hình máy.');
    const machine = detectMachine(root);
    log(`Máy: ${machine.os} | ${machine.cpu} | RAM ${humanBytes(machine.ram_bytes)}`);
    log(`GPU NVIDIA: ${machine.nvidia.available ? machine.nvidia.gpus.map((g) => g.name).join(', ') : 'không có'}`);
    log(`FFmpeg máy: ${machine.ffmpeg ? machine.ffmpeg.path : 'không có'}`);
    emit({ type: 'machine', machine });

    if (machine.arch !== 'x64') {
      throw new Error(`Bản cài này chỉ hỗ trợ Windows 64-bit (máy đang là ${machine.arch}).`);
    }
    if (!machine.disk.enough) {
      throw new Error(
        `Ổ đĩa chứa ${machine.disk.path} chỉ còn ${humanBytes(machine.disk.free_bytes)}, `
        + `cần ít nhất ${humanBytes(machine.required_free_bytes)}. Hãy giải phóng bớt rồi thử lại.`,
      );
    }
    stageProgress('detect', 1, 'Đã đọc xong cấu hình máy.');

    /* Manifest được ghi với `completed: false` NGAY TỪ ĐẦU. Nếu máy tắt giữa chừng, lần mở
     * app sau `verifyRuntimeQuick()` thấy `completed !== true` và mở lại cửa sổ thiết lập —
     * thay vì chạy tiếp trên một môi trường mới cài được một nửa. */
    RuntimePaths.writeManifest({
      schema: RuntimePaths.RUNTIME_SCHEMA,
      completed: false,
      started_at: new Date().toISOString(),
      machine,
    });

    const vcredist = await stageVcRedist(machine);
    const python = await stagePython();
    await stagePip(python.path);
    const ffmpeg = await stageFfmpeg(machine);
    const verify = await stageVerify(python.path, ffmpeg);

    if (!options.keepDownloads) {
      /* Cache TẢI FILE (zip Python, zip ffmpeg) không còn dùng tới. CỐ Ý KHÔNG đụng tới
       * `pip-cache`: các nhóm tính năng sẽ được tải dần về sau, và cache đó là thứ khiến
       * một lượt tải đứt giữa chừng không phải làm lại từ đầu. */
      await fsp.rm(RuntimePaths.downloadCacheDir(), { recursive: true, force: true }).catch(() => {});
    }

    /* Khung `features` được ghi sẵn với `installed: false` cho từng nhóm. Có khung rỗng thì
     * backend đọc trạng thái bằng một phép tra thẳng, không phải phân biệt "chưa cài" với
     * "manifest đời cũ chưa có trường này". */
    const features = {};
    for (const group of onDemandGroups()) {
      features[group.id] = { installed: false, label: group.label, trigger: group.trigger || group.label };
    }

    const manifest = {
      schema: RuntimePaths.RUNTIME_SCHEMA,
      completed: true,
      completed_at: new Date().toISOString(),
      app_version: options.appVersion || null,
      python: { ...python, verified_version: verify.python_version },
      ffmpeg,
      vcredist,
      verify,
      features,
      machine,
    };
    RuntimePaths.writeManifest(manifest);
    const complete = verify.python_ok && verify.ffmpeg_ok;
    log(`=== Thiết lập kết thúc: ${complete ? 'ĐẦY ĐỦ' : 'CÓ CẢNH BÁO'} ===`);

    emit({ type: 'done', ok: true, complete, manifest });
    return manifest;
  } catch (error) {
    log(`LỖI: ${error?.stack || error?.message || error}`);
    emit({
      type: 'done',
      ok: false,
      error: String(error?.message || error),
      log_path: RuntimePaths.setupLogPath(),
    });
    throw error;
  } finally {
    try { logStream?.end(); } catch (_) { /* no-op */ }
    logStream = null;
  }
}

function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : () => {};
}

module.exports = {
  setupRuntime,
  installFeature,
  featureInstalled,
  setEmitter,
  STAGE_WEIGHTS,
  FEATURE_STAGE_WEIGHTS,
  PYTHON_VERSION,
};

/* Chạy độc lập: `node scripts/setup_runtime.js` — in NDJSON ra stdout để bên gọi (cửa sổ
 * thiết lập, hoặc người dùng chạy tay lúc gỡ lỗi) đọc được cùng một luồng sự kiện. */
if (require.main === module) {
  setEmitter((event) => process.stdout.write(`${JSON.stringify(event)}\n`));
  setupRuntime({ keepDownloads: process.argv.includes('--keep-downloads') })
    .then((manifest) => {
      const complete = manifest.verify.broken.length === 0 && manifest.verify.ffmpeg_ok;
      process.exit(complete ? 0 : 2);
    })
    .catch(() => process.exit(1));
}
