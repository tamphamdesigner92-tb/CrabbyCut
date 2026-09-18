#!/usr/bin/env node
/* SINH THIRD-PARTY-NOTICES.md TỪ CÂY PHỤ THUỘC THẬT.
 *
 * VÌ SAO LÀ SCRIPT CHỨ KHÔNG PHẢI FILE VIẾT TAY: danh sách phụ thuộc đổi mỗi lần
 * `npm install` hoặc sửa requirements.txt, mà một bản viết tay thì không ai nhớ cập nhật.
 * Bản ghi công lỗi thời KHÔNG báo lỗi — nó chỉ âm thầm trở thành một tuyên bố sai về mặt
 * pháp lý, đúng loại rủi ro mà việc ghi công sinh ra để tránh.
 *
 * Chạy lại sau mỗi lần đổi phụ thuộc:
 *     npm run notices
 *
 * NGUỒN DỮ LIỆU:
 *   - npm: đọc `license` trong package.json của TỪNG gói thật nằm trong node_modules,
 *     KHÔNG suy từ package-lock. Lock file ghi những gì sẽ cài; node_modules là những gì
 *     ĐANG được đóng gói, và đó mới là thứ ta phải ghi công.
 *   - Python: đọc metadata của gói đã cài trong .venv. Nếu chưa dựng .venv thì bỏ qua
 *     phần này và ghi rõ là đã bỏ qua, thay vì in ra một danh sách trống gây hiểu nhầm.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(PROJECT_ROOT, 'THIRD-PARTY-NOTICES.md');

/* Chỉ liệt kê phụ thuộc ĐƯỢC ĐÓNG GÓI. devDependencies (electron-builder, node-gyp…)
 * không đi kèm bản phát hành nên không phát sinh nghĩa vụ ghi công. */
function productionNpmPackages() {
  const root = path.join(PROJECT_ROOT, 'node_modules');
  if (!fs.existsSync(root)) return { error: 'Chưa có node_modules — chạy `npm install` trước.' };

  const result = spawnSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
    cwd: PROJECT_ROOT, encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024,
  });

  const names = new Set();
  const walk = (node) => {
    for (const [name, child] of Object.entries(node?.dependencies || {})) {
      names.add(name);
      walk(child);
    }
  };
  try {
    walk(JSON.parse(result.stdout || '{}'));
  } catch (_) {
    return { error: '`npm ls` không trả JSON đọc được.' };
  }

  const packages = [];
  for (const name of [...names].sort()) {
    const pkgPath = path.join(root, ...name.split('/'), 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    let pj;
    try { pj = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) { continue; }
    let license = pj.license;
    if (!license && Array.isArray(pj.licenses)) license = pj.licenses.map((l) => l.type).join(' OR ');
    if (license && typeof license === 'object') license = license.type;
    packages.push({
      name,
      version: pj.version || '',
      license: license || 'KHÔNG KHAI BÁO',
      homepage: pj.homepage || (typeof pj.repository === 'string' ? pj.repository : pj.repository?.url) || '',
    });
  }
  return { packages };
}

const PY_PROBE = `
import importlib.metadata as md, json
rows = []
for dist in md.distributions():
    try:
        m = dist.metadata
        name = m.get('Name')
        if not name:
            continue
        lic = m.get('License-Expression') or ''
        if not lic:
            cls = [c.rsplit('::', 1)[-1].strip() for c in (m.get_all('Classifier') or []) if c.startswith('License ::')]
            lic = '; '.join(cls)
        if not lic:
            raw = (m.get('License') or '').strip()
            lic = raw if 0 < len(raw) <= 60 else ('(xem gói)' if raw else 'KHÔNG KHAI BÁO')
        rows.append({'name': name, 'version': dist.version or '', 'license': lic.replace('\\n', ' ')})
    except Exception:
        pass
seen, out = set(), []
for r in sorted(rows, key=lambda x: x['name'].lower()):
    key = r['name'].lower()
    if key in seen:
        continue
    seen.add(key)
    out.append(r)
print(json.dumps(out, ensure_ascii=False))
`;

function pythonPackages() {
  const { pythonCommand, pythonEnv } = require('./python_command.js');
  const python = pythonCommand();
  const result = spawnSync(python, ['-c', PY_PROBE], {
    cwd: PROJECT_ROOT, env: pythonEnv(), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { error: `Không đọc được môi trường Python (${python}). Dựng .venv rồi chạy lại.` };
  }
  try {
    return { packages: JSON.parse(result.stdout.trim().split(/\r?\n/).pop()) };
  } catch (_) {
    return { error: 'Phép dò Python không trả JSON đọc được.' };
  }
}

function table(packages) {
  const lines = ['| Gói | Phiên bản | Giấy phép |', '|---|---|---|'];
  for (const p of packages) {
    const name = p.homepage ? `[${p.name}](${String(p.homepage).replace(/^git\+/, '').replace(/\.git$/, '')})` : p.name;
    lines.push(`| ${name} | ${p.version} | ${p.license} |`);
  }
  return lines.join('\n');
}

function summary(packages) {
  const counts = new Map();
  for (const p of packages) counts.set(p.license, (counts.get(p.license) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
    .map(([lic, n]) => `| ${lic} | ${n} |`).join('\n');
}

function main() {
  const npm = productionNpmPackages();
  const py = pythonPackages();

  const parts = [];
  parts.push(`# Ghi công phần mềm của bên thứ ba

CrabbyCut phát hành theo **GNU General Public License v3.0 hoặc mới hơn** — xem
[\`LICENSE\`](LICENSE) và [\`LICENSE-EXCEPTION.md\`](LICENSE-EXCEPTION.md).

Tài liệu này liệt kê phần mềm của bên thứ ba mà CrabbyCut **đóng gói hoặc cài đặt**, kèm
giấy phép của chúng. Bản quyền của từng thành phần thuộc về tác giả tương ứng.

> Tệp này được **sinh tự động** bởi \`scripts/generate_third_party_notices.js\`.
> Đừng sửa tay — sửa script rồi chạy \`npm run notices\`.
> Sinh lúc: ${new Date().toISOString()}
`);

  parts.push(`## 1. FFmpeg

CrabbyCut **không liên kết** thư viện FFmpeg. Nó chạy \`ffmpeg\` và \`ffprobe\` như **tiến
trình riêng** qua dòng lệnh (xem \`native/sidecar/core_process.cpp\` — chỉ \`#include\`
header chuẩn của C++ và \`<windows.h>\`, không có \`libavcodec\`/\`libavformat\`).

Nếu máy người dùng chưa có bản FFmpeg đủ filter, bước thiết lập tải build sau về:

- **Bản dựng:** \`ffmpeg-master-latest-win64-gpl\` của BtbN
- **Trang phát hành:** https://github.com/BtbN/FFmpeg-Builds/releases
- **Mã nguồn bộ dựng:** https://github.com/BtbN/FFmpeg-Builds
- **Mã nguồn FFmpeg:** https://github.com/FFmpeg/FFmpeg
- **Giấy phép:** GPL-3.0-or-later (build này bật \`--enable-gpl --enable-version3\`)

Electron cũng kèm \`ffmpeg.dll\` bản LGPL của riêng nó; xem \`LICENSE.electron.txt\` và
\`LICENSES.chromium.html\` trong thư mục cài đặt.

## 2. Electron, Chromium, Node.js

Bản cài đặt được dựng trên Electron (MIT), bao gồm Chromium và Node.js với tập giấy phép
riêng của chúng. Văn bản đầy đủ nằm cạnh tệp thực thi sau khi cài:
\`LICENSE.electron.txt\` và \`LICENSES.chromium.html\`.

## 3. Python

Bước thiết lập tải bản Python nhúng chính thức từ python.org, phát hành theo
**PSF License Agreement** — https://docs.python.org/3/license.html
`);

  if (npm.error) {
    parts.push(`## 4. Gói npm\n\n> ⚠️ ${npm.error}`);
  } else {
    parts.push(`## 4. Gói npm được đóng gói (${npm.packages.length})

Chỉ tính phụ thuộc \`production\`. \`devDependencies\` (electron-builder, node-gyp…) không
đi kèm bản phát hành.

### Tổng hợp theo giấy phép

| Giấy phép | Số gói |
|---|---|
${summary(npm.packages)}

### Danh sách đầy đủ

${table(npm.packages)}`);
  }

  if (py.error) {
    parts.push(`## 5. Gói Python\n\n> ⚠️ ${py.error}`);
  } else {
    parts.push(`## 5. Gói Python (${py.packages.length})

CrabbyCut **không phân phối lại** các gói này. Chúng do \`pip\` tải từ PyPI về máy người
dùng trong bước thiết lập theo yêu cầu (xem \`scripts/setup_runtime.js\`), và chỉ tải nhóm
nào ứng với tính năng người dùng thật sự dùng tới.

Riêng \`nvidia-cublas-cu12\` và \`nvidia-cuda-nvrtc-cu12\` mang giấy phép **độc quyền của
NVIDIA**, không phải mã nguồn mở; xem [\`LICENSE-EXCEPTION.md\`](LICENSE-EXCEPTION.md).

### Tổng hợp theo giấy phép

| Giấy phép | Số gói |
|---|---|
${summary(py.packages)}

### Danh sách đầy đủ

${table(py.packages)}`);
  }

  parts.push(`## 6. Font

Thư mục \`static/fonts/google/\` chứa font từ dự án Google Fonts. Giấy phép theo từng họ
font được ghi trong \`static/fonts/google/FONTS_MANIFEST.md\`; văn bản giấy phép nằm cùng
thư mục:

| Tệp | Áp dụng cho |
|---|---|
| \`LICENSE-OFL-1.1.txt\` | Phần lớn các họ font (SIL Open Font License 1.1) |
| \`LICENSE-Apache-2.0.txt\` | Roboto Slab |
| \`LICENSE-UFL-1.0.txt\` | Ubuntu (Ubuntu Font Licence 1.0) |

## 7. Tài nguyên media

Kho tài nguyên (\`library/\`) **không đi kèm mã nguồn công khai**. Nhạc, hiệu ứng âm thanh,
video và hình ảnh mẫu có giấy phép riêng và phần lớn giấy phép stock **cấm phân phối lại**
tệp gốc. Xem \`library/README.md\`.

Ngoại lệ: các tệp \`.cube\` trong \`library/luts/\` do chính
\`scripts/generate_preset_luts.js\` của dự án sinh ra, nên thuộc giấy phép của CrabbyCut.
`);

  fs.writeFileSync(OUT_PATH, `${parts.join('\n\n')}\n`, 'utf8');
  const npmCount = npm.packages?.length ?? 0;
  const pyCount = py.packages?.length ?? 0;
  console.log(`[notices] Đã ghi ${path.relative(PROJECT_ROOT, OUT_PATH)} — ${npmCount} gói npm, ${pyCount} gói Python.`);
  if (npm.error) console.warn(`[notices] ⚠️  ${npm.error}`);
  if (py.error) console.warn(`[notices] ⚠️  ${py.error}`);
}

if (require.main === module) main();
module.exports = { main };
