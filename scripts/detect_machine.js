#!/usr/bin/env node
/* DÒ CẤU HÌNH MÁY TRƯỚC KHI DỰNG MÔI TRƯỜNG.
 *
 * Kết quả của tệp này QUYẾT ĐỊNH tải gì, nên mỗi phép dò ở đây đều gắn với một nhánh cài
 * đặt thật ở scripts/setup_runtime.js — không dò cho vui:
 *   - GPU NVIDIA  -> có cài `nvidia-cublas-cu12` hay không (~400 MB, và thiếu nó thì
 *                    ctranslate2 chết GIỮA phiên bóc băng với "cublas64_12.dll is not found").
 *   - ffmpeg máy  -> dùng lại bản có sẵn hay tải bản riêng (~100 MB).
 *   - VC++ runtime-> mediapipe/opencv nạp msvcp140.dll lúc import; thiếu là ImportError.
 *   - đĩa trống   -> báo TRƯỚC thay vì chết giữa chừng lúc pip đã tải 1,5 GB.
 *
 * Mọi phép dò đều phải KHÔNG BAO GIỜ NÉM. Cửa sổ thiết lập gọi hàm này đầu tiên; nó chết
 * là người dùng nhìn thấy một cửa sổ trắng, không biết hỏng ở đâu.
 */
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { pythonVersionOk } = require('./python_requirements.js');

const IS_WIN = process.platform === 'win32';

/* Dung lượng cần cho một lượt cài đủ (đo trên bản Windows + GPU NVIDIA, 2026-09):
 * python nhúng 60 MB, torch CPU 260 MB, ctranslate2 + cudnn 320 MB, cublas 420 MB,
 * opencv 90 MB, mediapipe 80 MB, whisper + phụ thuộc 180 MB, ffmpeg 180 MB, cache tải
 * ~800 MB (bị xoá sau). Cộng dồn + biên an toàn. */
const REQUIRED_FREE_BYTES = 6 * 1024 * 1024 * 1024;

function run(command, args, timeoutMs = 15000) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (result.error) return { ok: false, stdout: '', stderr: String(result.error.message) };
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error?.message || error) };
  }
}

/* MỘT MỤC PATH CÓ THỂ CHỨA "XÁC" CỦA APP EXECUTION ALIAS.
 * `%LOCALAPPDATA%\Microsoft\WindowsApps` của MỘT TÀI KHOẢN KHÁC còn sót trong PATH là ca đã
 * gặp thật: trong đó `python.exe` là reparse point 0 byte, tài khoản hiện tại không thực thi
 * được. libuv duyệt PATH, thấy "có file tên python.exe" thì DỪNG TÌM, gọi CreateProcess,
 * hỏng, rồi trả ENOENT — nên Python thật nằm ở các mục PATH phía sau không bao giờ được tới.
 * Đó chính là lỗi "spawn python ENOENT" của bản cài đầu tiên. Bỏ qua file 0 byte là cách
 * phân biệt alias với interpreter thật. */
function isUsableExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (stat.size === 0) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/* Tìm MỌI bản của một lệnh trên PATH, trả về ĐƯỜNG DẪN TUYỆT ĐỐI đã lọc alias.
 * Trả về mảng vì bản đầu tiên chưa chắc dùng được (sai phiên bản Python chẳng hạn). */
function whichAll(command) {
  const exts = IS_WIN
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = new Set();
  const found = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (isUsableExecutable(candidate)) found.push(candidate);
    }
  }
  return found;
}

function probePython(exePath) {
  const result = run(exePath, ['-c', 'import sys,json;print(json.dumps(list(sys.version_info[:3])))'], 10000);
  if (!result.ok) return null;
  try {
    const version = JSON.parse(result.stdout.trim());
    return { path: exePath, version, ok: pythonVersionOk(version) };
  } catch (_) {
    return null;
  }
}

/* Python của MÁY chỉ dùng để BÁO CÁO, không dùng để cài gói vào.
 * Cài thẳng vào Python của người dùng là làm bẩn môi trường của họ và tự rước xung đột
 * phiên bản với những thứ họ đang dùng; setup luôn dựng bản nhúng riêng. Dò ở đây để cửa
 * sổ thiết lập nói được "máy đã có Python 3.12" cho người dùng hiểu bối cảnh. */
function detectSystemPython() {
  const candidates = [];
  for (const name of ['python', 'python3']) {
    for (const exe of whichAll(name)) candidates.push(exe);
  }
  /* `py` là launcher, không phải interpreter: hỏi nó liệt kê các bản đã cài. */
  for (const launcher of whichAll('py')) {
    const listed = run(launcher, ['-0p'], 10000);
    if (!listed.ok) continue;
    for (const line of listed.stdout.split(/\r?\n/)) {
      const match = line.match(/([A-Za-z]:\\[^\r\n]+?python\.exe)/i);
      if (match) candidates.push(match[1]);
    }
  }
  const seen = new Set();
  const probed = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const info = probePython(candidate);
    if (info) probed.push(info);
  }
  return {
    found: probed.length > 0,
    compatible: probed.filter((item) => item.ok),
    all: probed,
  };
}

/* ffmpeg CỦA MÁY CHỈ DÙNG LẠI ĐƯỢC KHI ĐỦ FILTER.
 * App dựng filtergraph có `zscale` (tonemap HDR, xem HDR_TONEMAP_ZSCALE ở backend) — một
 * build ffmpeg thiếu zscale vẫn `ffmpeg -version` ngon lành rồi chết lúc export với
 * "No such filter: 'zscale'". Kiểm filter chứ không kiểm sự tồn tại. */
const REQUIRED_FILTERS = ['zscale', 'scale', 'overlay', 'drawtext', 'atempo', 'concat'];

function probeFfmpeg(exePath) {
  const version = run(exePath, ['-hide_banner', '-version'], 15000);
  if (!version.ok) return null;
  const filters = run(exePath, ['-hide_banner', '-filters'], 20000);
  const text = filters.ok ? filters.stdout : '';
  const missing = REQUIRED_FILTERS.filter((name) => !new RegExp(`\\s${name}\\s`).test(text));
  const banner = version.stdout.split(/\r?\n/)[0] || '';
  return {
    path: exePath,
    version: banner.trim(),
    missingFilters: missing,
    usable: missing.length === 0,
  };
}

function detectSystemFfmpeg() {
  for (const exe of whichAll('ffmpeg')) {
    const info = probeFfmpeg(exe);
    if (!info) continue;
    /* ffprobe phải nằm CẠNH ffmpeg: backend gọi cả hai bằng tên trần, nên một bộ thiếu
     * ffprobe là dùng được nửa vời — mọi phép đo nguồn (thời lượng, khổ hình) chết. */
    const probeExe = path.join(path.dirname(exe), IS_WIN ? 'ffprobe.exe' : 'ffprobe');
    info.hasFfprobe = isUsableExecutable(probeExe);
    info.usable = info.usable && info.hasFfprobe;
    if (info.usable) return info;
  }
  return null;
}

function detectNvidia() {
  const candidates = whichAll('nvidia-smi');
  /* Driver NVIDIA đặt nvidia-smi ở System32 nhưng KHÔNG phải máy nào cũng có thư mục đó
   * trên PATH của tiến trình con — thêm đường dẫn cố định làm lưới đỡ. */
  if (IS_WIN) {
    const fallback = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe');
    if (isUsableExecutable(fallback)) candidates.push(fallback);
  }
  for (const exe of candidates) {
    const result = run(exe, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 15000);
    if (!result.ok) continue;
    const gpus = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, vram] = line.split(',').map((part) => part.trim());
      return { name, vram_mb: Number(vram) || null };
    });
    if (gpus.length) {
      return {
        available: true,
        gpus,
        max_vram_mb: Math.max(...gpus.map((gpu) => gpu.vram_mb || 0)) || null,
      };
    }
  }
  return { available: false, gpus: [], max_vram_mb: null };
}

/* mediapipe và opencv nạp msvcp140.dll / vcruntime140_1.dll NGAY LÚC IMPORT. Máy Windows
 * sạch (bản mới cài, chưa từng chạy game hay app C++ nào) thường KHÔNG có, và lỗi hiện ra
 * là "DLL load failed while importing cv2" — không hề nhắc tới VC++ redistributable. */
function detectVcRedist() {
  if (!IS_WIN) return { required: false, present: true };
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const needed = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
  const missing = needed.filter((dll) => !isUsableExecutable(path.join(system32, dll)));
  return { required: true, present: missing.length === 0, missing };
}

function detectDiskSpace(targetDir) {
  /* Đo trên Ổ ĐĨA CHỨA THƯ MỤC ĐÍCH, không phải ổ C: — người dùng có thể đã đổi
   * %LOCALAPPDATA% hoặc đặt CRAB_RUNTIME_DIR sang ổ khác. */
  let probe = targetDir;
  while (probe && !fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const stat = fs.statfsSync(probe);
    const free = stat.bavail * stat.bsize;
    return { path: probe, free_bytes: free, enough: free >= REQUIRED_FREE_BYTES };
  } catch (_) {
    // statfsSync có từ Node 18.15; thiếu thì coi như không chặn được, đừng bịa số.
    return { path: probe, free_bytes: null, enough: true, unknown: true };
  }
}

function detectMachine(targetDir) {
  return {
    platform: process.platform,
    arch: process.arch,
    os: IS_WIN ? `Windows ${os.release()}` : `${os.type()} ${os.release()}`,
    cpu: os.cpus()?.[0]?.model?.trim() || 'Không xác định',
    cpu_count: os.cpus()?.length || null,
    ram_bytes: os.totalmem(),
    python: detectSystemPython(),
    ffmpeg: detectSystemFfmpeg(),
    nvidia: detectNvidia(),
    vcredist: detectVcRedist(),
    disk: detectDiskSpace(targetDir || os.tmpdir()),
    required_free_bytes: REQUIRED_FREE_BYTES,
  };
}

module.exports = {
  detectMachine,
  detectSystemPython,
  detectSystemFfmpeg,
  detectNvidia,
  detectVcRedist,
  detectDiskSpace,
  whichAll,
  isUsableExecutable,
  probeFfmpeg,
  probePython,
  REQUIRED_FREE_BYTES,
  REQUIRED_FILTERS,
};

if (require.main === module) {
  const { runtimeRoot } = require('./runtime_paths.js');
  console.log(JSON.stringify(detectMachine(runtimeRoot()), null, 2));
}
