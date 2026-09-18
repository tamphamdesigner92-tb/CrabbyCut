const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'native', 'sidecar', 'core_process.cpp');
const buildDir = path.join(root, 'native', 'sidecar', 'build');
const isWindows = process.platform === 'win32';
const output = path.join(buildDir, isWindows ? 'core_process.exe' : 'core_process');

fs.mkdirSync(buildDir, { recursive: true });

function onPath(exe) {
  // `where`/`which` là cách duy nhất đáng tin: spawnSync một compiler không tồn tại chỉ
  // trả ENOENT sau khi đã thử chạy, còn ở đây cần BIẾT TRƯỚC để chọn nhánh biên dịch.
  const probe = spawnSync(isWindows ? 'where' : 'which', [exe], { encoding: 'utf8' });
  return probe.status === 0 && String(probe.stdout || '').trim().length > 0;
}

/* MSVC KHÔNG NẰM TRÊN PATH của shell thường.
 * `cl.exe` chỉ có PATH/INCLUDE/LIB đúng ở trong "Developer Command Prompt" (do vcvars64.bat
 * dựng ra). Bản gốc của script này gọi thẳng `cl`, nên trên Windows `npm run build:sidecar`
 * chỉ chạy được nếu người dùng tình cờ mở đúng cửa sổ đó — còn từ terminal thường (hay từ
 * `npm test`) thì ENOENT. Ở đây tự dò VS bằng vswhere rồi chạy `cl` BÊN TRONG môi trường mà
 * vcvars64.bat đã nạp, nên terminal nào cũng build được.
 * Trả về null nếu máy không có VS/toolset C++ -> bên gọi rơi về compiler khác trên PATH. */
function msvcCommand() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  const found = spawnSync(vswhere, [
    '-latest', '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], { encoding: 'utf8' });
  const installPath = String(found.stdout || '').trim().split(/\r?\n/)[0];
  if (found.status !== 0 || !installPath) return null;
  const vcvars = path.join(installPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (!fs.existsSync(vcvars)) return null;
  return { vcvars };
}

function runMsvcViaVcvars(vcvars) {
  /* Phải đi qua cmd.exe: vcvars64.bat ĐẶT BIẾN MÔI TRƯỜNG rồi mới gọi cl, hai việc đó bắt
   * buộc ở CÙNG một tiến trình shell. `>nul` để log của vcvars không lẫn vào output build.
   * Ghi ra file .bat tạm thay vì truyền chuỗi dài cho `cmd /c`: đường dẫn ở đây có dấu cách
   * lẫn ngoặc kép, mà `cmd /c` còn có luật tự XOÁ cặp ngoặc ngoài cùng — nguồn lỗi kinh điển. */
  const script = path.join(os.tmpdir(), `crab_build_sidecar_${process.pid}.bat`);
  /* `/Fo:` PHẢI kết thúc bằng DẤU GẠCH XUÔI, không phải gạch chéo ngược: `/Fo:"…\build\"`
   * thì dấu `\` cuối lại escape luôn dấu ngoặc kép đóng, cl nhận nguyên `build".obj` và
   * chết với C1083 "Invalid argument". cl hiểu `/` trong đường dẫn nên đổi hết cho chắc. */
  const objDir = `${buildDir.replace(/\\/g, '/')}/`;
  const lines = [
    '@echo off',
    // 2>&1 luôn: vcvars có lúc kêu về vswhere ra stderr, log đó lẫn vào output build gây hiểu nhầm.
    `call "${vcvars}" >nul 2>&1`,
    'if errorlevel 1 exit /b 1',
    `cl /nologo /EHsc /O2 /std:c++17 "${source}" /Fe:"${output}" /Fo:"${objDir}"`,
  ];
  fs.writeFileSync(script, lines.join('\r\n') + '\r\n', 'utf8');
  try {
    return spawnSync('cmd.exe', ['/c', script], { cwd: root, stdio: 'inherit' });
  } finally {
    fs.rmSync(script, { force: true });
  }
}

let result;
if (process.env.CXX) {
  // CXX được đặt tay thì TÔN TRỌNG tuyệt đối, không tự đoán gì thêm.
  const compiler = process.env.CXX;
  const isCl = path.basename(compiler).toLowerCase().replace(/\.exe$/, '') === 'cl';
  const args = isCl
    ? ['/nologo', '/EHsc', '/O2', '/std:c++17', source, `/Fe:${output}`, `/Fo:${buildDir}${path.sep}`]
    : ['-std=c++17', '-O2', source, '-o', output];
  result = spawnSync(compiler, args, { cwd: root, stdio: 'inherit' });
} else if (isWindows) {
  const msvc = onPath('cl') ? 'path' : msvcCommand();
  if (msvc === 'path') {
    result = spawnSync('cl', ['/nologo', '/EHsc', '/O2', '/std:c++17', source,
      `/Fe:${output}`, `/Fo:${buildDir}${path.sep}`], { cwd: root, stdio: 'inherit' });
  } else if (msvc) {
    result = runMsvcViaVcvars(msvc.vcvars);
  } else {
    /* Không có MSVC -> thử compiler POSIX-style nào có trên PATH (MinGW-w64 của Qt,
     * MSYS2, LLVM…). core_process.cpp đã bọc #ifdef _WIN32 đầy đủ nên biên dịch được
     * bằng g++/clang++; chỉ khác ở chỗ đây là SIDECAR (một exe độc lập, nói chuyện qua
     * stdio/JSON), không phải native addon — addon thì BUỘC phải MSVC vì nạp cùng tiến
     * trình với Electron. */
    const fallback = ['g++', 'clang++', 'c++'].find(onPath);
    if (!fallback) {
      console.error('[sidecar] Không tìm thấy compiler C++ nào.');
      console.error('[sidecar] Cài "Desktop development with C++" của Visual Studio, hoặc');
      console.error('[sidecar] đặt CXX trỏ tới g++/clang++ có sẵn. Ví dụ:');
      console.error('[sidecar]   set CXX=C:\\Qt\\Tools\\mingw1310_64\\bin\\g++.exe');
      process.exit(1);
    }
    console.log(`[sidecar] Không thấy MSVC -> dùng ${fallback} trên PATH.`);
    result = spawnSync(fallback, ['-std=c++17', '-O2', source, '-o', output],
      { cwd: root, stdio: 'inherit' });
  }
} else {
  result = spawnSync('c++', ['-std=c++17', '-O2', source, '-o', output],
    { cwd: root, stdio: 'inherit' });
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status || 0);
