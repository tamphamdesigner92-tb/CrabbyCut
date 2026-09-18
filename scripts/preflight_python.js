#!/usr/bin/env node
/* KIỂM MÔI TRƯỜNG PYTHON TRƯỚC KHI MỞ APP — chạy đầu chuỗi `npm start`.
 *
 * VÌ SAO CẦN: `.venv/` nằm trong .gitignore, và không có bước nào tự cài gói Python
 * (`postinstall` chỉ chạy `prepare:vendor`). Nên máy vừa clone repo về là có đủ mã nguồn
 * nhưng KHÔNG có thư viện nào — và điều đó chỉ lộ ra rất muộn, dưới dạng một lỗi Python
 * khó hiểu ném thẳng lên UI giữa lúc đang dùng:
 *     "Cài model ASR thất bại: Windows ASR faster-whisper failed:
 *      Missing Python package: faster-whisper."
 * Preflight kéo sự thật đó lên ngay giây đầu của `npm start`, kèm lệnh cần chạy.
 *
 * CHỈ CẢNH BÁO, KHÔNG CHẶN (trừ khi có cờ `--strict`). Thiếu `mediapipe` không có lý do gì
 * ngăn mở app để sửa timeline; chặn `npm start` vì môi trường chưa đủ là thù địch khi đang
 * làm việc trên một mảng không liên quan. `--strict` để dành cho CI về sau.
 *
 * CỐ Ý KHÔNG TỰ CHẠY `pip install`. Hai lý do, cả hai đều đã thành sự thật ở dự án này:
 *   1. requirements.txt kéo theo `torch` + `openai-whisper` — hàng trăm MB tới vài GB. Treo
 *      mười mấy phút ở một lệnh tên là "start" thì không ai đoán được.
 *   2. requirements.txt KHÔNG ghim phiên bản, nên mỗi lần cài lại là một lần giao số phận
 *      ứng dụng cho resolver. Chính tệp đó đã chép lại hai lần bị resolver làm chết app
 *      (`mlx-whisper` dừng cả file trên Windows; `whisperx` ghim `ctranslate2<4.5.0` kéo
 *      `pkg_resources` chết). Việc cài phải do người dùng chủ động bấm.
 *
 * Phép dò dùng `importlib.util.find_spec` chứ không `import` thật: nhanh (~130 ms cả tiến
 * trình) và không kéo `torch` vào RAM chỉ để hỏi một câu. Đánh đổi đã biết: find_spec trả
 * `true` KHÔNG chứng minh gói chạy được (đúng ca `ctranslate2` 4.4 mà requirements.txt đã
 * ghi — spec có, `import` nổ vì `pkg_resources`). Phép kiểm sâu vẫn là
 * `asr/windows_faster_whisper_sidecar.py --check-imports`, chạy trong luồng ASR như cũ.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { pythonCommand, pythonEnv, PROJECT_ROOT } = require('./python_command.js');
const {
  groupsForPlatform,
  modulesForPlatform,
  pythonVersionOk,
  PYTHON_MIN,
  PYTHON_MAX_EXCLUSIVE,
} = require('./python_requirements.js');

const STRICT = process.argv.includes('--strict');
const NOTE_PATH = path.join(PROJECT_ROOT, 'docs', 'MOI_TRUONG_PYTHON.md');
const IS_WIN = process.platform === 'win32';

/* Đường dẫn interpreter bên trong .venv khác nhau giữa hai bố cục — cùng quy ước với
 * python_command.js, đừng để hai nơi hiểu khác nhau. */
const VENV_PYTHON = IS_WIN
  ? path.join('.venv', 'Scripts', 'python.exe')
  : path.join('.venv', 'bin', 'python');

/* Lệnh dựng venv: trên Windows dùng launcher `py -3.12` để KHÔNG dính bản mặc định (máy có
 * thể đang mặc định 3.13/3.14, xem chú thích PYTHON_MAX_EXCLUSIVE ở python_requirements.js). */
const CREATE_VENV_CMD = IS_WIN ? 'py -3.12 -m venv .venv' : 'python3.12 -m venv .venv';
const INSTALL_CMD = `${VENV_PYTHON} -m pip install -r requirements.txt`;
const VERIFY_CMD = IS_WIN
  ? `${VENV_PYTHON} asr/windows_faster_whisper_sidecar.py --check-imports`
  : `${VENV_PYTHON} -c "import core_logic"`;

const PROBE = [
  'import importlib.util, json, sys',
  'found = {}',
  'for name in sys.argv[1:]:',
  '    try:',
  '        found[name] = importlib.util.find_spec(name) is not None',
  '    except Exception:',
  '        found[name] = False',
  'print(json.dumps({"executable": sys.executable, "version": list(sys.version_info[:3]), "found": found}))',
].join('\n');

function probe(python, modules) {
  const result = spawnSync(python, ['-c', PROBE, ...modules], {
    cwd: PROJECT_ROOT,
    env: pythonEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  /* `python` trên Windows mà không có bản cài thật thì là shim của Microsoft Store: nó thoát
   * 9009 và in lời mời cài từ Store — KHÔNG phải JSON. Gộp mọi ca "không chạy được" vào một
   * nhánh, vì với người dùng thì chúng như nhau: chưa có Python dùng được. */
  if (result.error || result.status !== 0) {
    return { ok: false, reason: (result.error && result.error.message) || (result.stderr || '').trim() || `exit ${result.status}` };
  }
  try {
    return { ok: true, data: JSON.parse(String(result.stdout || '').trim()) };
  } catch (_) {
    return { ok: false, reason: `Không đọc được kết quả dò: ${String(result.stdout || '').trim().slice(0, 200)}` };
  }
}

function evaluate(found) {
  return groupsForPlatform().map((group) => {
    const missing = group.modules.filter((item) => !found[item.module]);
    return { group, missing, ok: missing.length === 0 };
  });
}

function writeNote(lines) {
  try {
    fs.mkdirSync(path.dirname(NOTE_PATH), { recursive: true });
    fs.writeFileSync(NOTE_PATH, lines.join('\n'), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/* Ghi chú là ẢNH CHỤP trạng thái máy tại một thời điểm. Môi trường đã đủ mà vẫn để tệp cũ
 * nằm đó thì lần sau đọc phải sẽ tưởng còn thiếu — nên xoá. */
function clearNote() {
  try {
    if (fs.existsSync(NOTE_PATH)) fs.unlinkSync(NOTE_PATH);
  } catch (_) { /* không quan trọng tới mức phải làm hỏng `npm start` */ }
}

function buildNote({ python, isVenv, versionLabel, versionOk, results, probeError }) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    '# Môi trường Python chưa đủ để chạy CrabbyCut',
    '',
    '> **Tệp này do `scripts/preflight_python.js` tự sinh lúc `npm start`** — nó là ảnh chụp',
    '> trạng thái MÁY NÀY, không phải tài liệu của dự án. Tệp nằm trong `.gitignore`, sẽ được',
    '> ghi đè ở lần chạy sau và tự xoá khi môi trường đã đủ. Đừng sửa tay.',
    '',
    `Thời điểm kiểm: ${now}`,
    `Interpreter: \`${python}\`${isVenv ? ' (venv của dự án)' : ' — **KHÔNG phải venv của dự án**'}`,
    `Phiên bản: ${versionLabel}`,
    '',
    '## Vì sao lại thiếu',
    '',
    '`.venv/` nằm trong `.gitignore`, và không có bước nào trong `npm install` cài gói Python',
    '(`postinstall` chỉ chạy `prepare:vendor` để đồng bộ font/asset). Nên máy vừa `git clone`',
    'về là có đủ mã nguồn nhưng chưa có thư viện nào — cho tới khi bạn tự cài.',
    '',
  ];

  if (probeError) {
    lines.push(
      '## Không chạy được interpreter Python nào',
      '',
      '```',
      probeError,
      '```',
      '',
      'Trên Windows, `python` mà chưa cài bản thật thì chỉ là shim của Microsoft Store (thoát 9009).',
      'Cài Python 3.12 từ python.org rồi làm tiếp phần dưới.',
      '',
    );
  }

  if (!versionOk) {
    lines.push(
      '## ⚠ Phiên bản Python không phù hợp',
      '',
      `Cần Python >= ${PYTHON_MIN.join('.')} và < ${PYTHON_MAX_EXCLUSIVE.join('.')}; đang dùng **${versionLabel}**.`,
      '',
      '`requirements.txt` ghim `mediapipe==0.10.21` và `opencv-contrib-python<4.12` kèm marker',
      '`python_version < "3.13"` (mediapipe không có wheel cho 3.13+). Điều nguy hiểm là **pip sẽ',
      'vẫn báo cài thành công** — nó chỉ lặng lẽ bỏ qua hai gói đó vì marker không khớp — rồi',
      'Auto-Reframe chết sau đó với `No module named \'cv2\'`. Hãy dựng lại venv bằng Python 3.12.',
      '',
    );
  }

  lines.push('## Thiếu những gì', '');
  for (const item of results) {
    if (item.ok) {
      lines.push(`- ✅ **${item.group.label}** — đủ`);
      continue;
    }
    lines.push(`- ❌ **${item.group.label}** — thiếu:`);
    for (const mod of item.missing) {
      lines.push(`  - \`${mod.pip}\` (import \`${mod.module}\`, dùng ở \`${mod.source}\`)`);
    }
  }

  lines.push(
    '',
    '## Cách cài',
    '',
    'Chạy trong thư mục gốc của dự án:',
    '',
    '```bash',
    `${CREATE_VENV_CMD}`,
    '```',
    '',
    '```bash',
    `${INSTALL_CMD}`,
    '```',
    '',
    'Rồi kiểm lại bằng chính phép thăm dò mà ứng dụng dùng — phải thấy `"faster_whisper": true`',
    'và `"ctranslate2": true`:',
    '',
    '```bash',
    `${VERIFY_CMD}`,
    '```',
    '',
    'Xong thì chạy lại `npm start`; preflight sẽ tự xoá tệp này.',
    '',
    '## Lưu ý',
    '',
    '- **Tải khá nặng và khá lâu.** `requirements.txt` kéo cả `torch` và `openai-whisper`;',
    '  riêng `torch` bản Windows từ PyPI có thể chiếm vài GB sau khi giải nén.',
    '- **Không cần cài lại sau mỗi `git pull`.** `.venv/` bị git bỏ qua nên `pull` không đụng',
    '  tới nó. Chỉ phải cài lại khi clone sang máy mới, hoặc khi `requirements.txt` có thêm gói',
    '  — lúc đó preflight sẽ lại sinh ra tệp này.',
    '- **`nvidia-cublas-cu12` không có tên import**, nên preflight không kiểm được nó. Nó chỉ là',
    '  DLL nạp theo `PATH`, và thiếu thì lỗi nổ ra *giữa* phiên bóc băng',
    '  (`Library cublas64_12.dll is not found`) chứ không phải lúc nạp model. Xem',
    '  `_ensure_cuda_dll_path()` trong `asr/windows_faster_whisper_sidecar.py`.',
    '',
  );
  return lines;
}

function main() {
  const python = pythonCommand();
  const isVenv = python.includes(`${path.sep}.venv${path.sep}`);
  const modules = modulesForPlatform();
  const probed = probe(python, modules);

  if (!probed.ok) {
    console.error('');
    console.error('[preflight] ✗ Không chạy được Python.');
    console.error(`[preflight]   Đã thử: ${python}`);
    console.error(`[preflight]   ${probed.reason}`);
    const results = groupsForPlatform().map((group) => ({ group, missing: group.modules, ok: false }));
    const written = writeNote(buildNote({
      python, isVenv, versionLabel: 'không xác định', versionOk: false, results, probeError: probed.reason,
    }));
    if (written) console.error(`[preflight]   Hướng dẫn chi tiết: docs${path.sep}MOI_TRUONG_PYTHON.md`);
    console.error('');
    process.exit(STRICT ? 1 : 0);
  }

  const { executable, version, found } = probed.data;
  const versionLabel = Array.isArray(version) ? version.join('.') : 'không xác định';
  const versionOk = pythonVersionOk(version);
  const results = evaluate(found || {});
  const missingCount = results.reduce((sum, item) => sum + item.missing.length, 0);

  if (!missingCount && versionOk) {
    clearNote();
    console.log(`[preflight] ✓ Môi trường Python đủ — ${executable} (${versionLabel})`);
    return;
  }

  console.error('');
  console.error(`[preflight] Interpreter: ${executable} (${versionLabel})${isVenv ? '' : '  ← KHÔNG phải .venv của dự án'}`);
  if (!versionOk) {
    console.error(`[preflight] ✗ Cần Python >= ${PYTHON_MIN.join('.')} và < ${PYTHON_MAX_EXCLUSIVE.join('.')} (mediapipe/opencv không có wheel cho 3.13+).`);
  }
  for (const item of results) {
    if (item.ok) {
      console.error(`[preflight] ✓ ${item.group.label}`);
    } else {
      console.error(`[preflight] ✗ ${item.group.label} — thiếu: ${item.missing.map((m) => m.pip).join(', ')}`);
    }
  }
  console.error('');
  console.error('[preflight] Khắc phục:');
  console.error(`[preflight]   ${CREATE_VENV_CMD}`);
  console.error(`[preflight]   ${INSTALL_CMD}`);
  const written = writeNote(buildNote({ python: executable, isVenv, versionLabel, versionOk, results, probeError: null }));
  if (written) console.error(`[preflight] Chi tiết + lý do: docs${path.sep}MOI_TRUONG_PYTHON.md`);
  console.error('[preflight] App vẫn mở được; chỉ các tính năng nêu trên là không chạy.');
  console.error('');
  process.exit(STRICT ? 1 : 0);
}

main();
