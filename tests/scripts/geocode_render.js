/* =====================================================================
 * GEOCODE — BỘ DỰNG KHUNG (electron/geocode-renderer.js)
 *
 * VÌ SAO CÓ TEST NÀY: khung GeoCode là thứ đi thẳng vào bản xuất, mà mọi cái sai của nó đều
 * "trông vẫn ổn" nếu chỉ nhìn qua:
 *   - cỡ khung lệch (HiDPI nhân đôi, Windows kẹp cửa sổ về cỡ màn hình) -> nút 450×200 xuất ra
 *     thành 900×400 hoặc bị cắt;
 *   - alpha nhân trước bị coi là alpha thẳng -> mọi vùng bán trong suốt tối đi;
 *   - hoạt ảnh chạy theo đồng hồ THẬT -> máy chậm ra khung khác máy nhanh, dựng lại ra hình khác;
 *   - mã HTML gọi được backend/localhost hay đọc tệp của người dùng.
 * Chạy Electron THẬT (cửa sổ offscreen + CDP chỉ có ở đó), cache riêng trong test_temp/.
 * ================================================================== */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const cacheDir = path.join(projectRoot, 'test_temp', 'geocode_render_cache');
fs.rmSync(cacheDir, { recursive: true, force: true });
fs.mkdirSync(cacheDir, { recursive: true });

const electron = require('electron');
// Phải XOÁ hẳn biến này (MCP/backend hay đặt nó): Electron coi cả chuỗi rỗng là "chạy như node".
const env = { ...process.env, CRAB_GEOCODE_CACHE_DIR: cacheDir };
delete env.ELECTRON_RUN_AS_NODE;
const res = spawnSync(electron, [path.join(__dirname, 'geocode_render_electron.js'),
  `--user-data-dir=${path.join(projectRoot, 'test_temp', 'geocode_render_userdata')}`], {
  cwd: projectRoot,
  env,
  encoding: 'utf8',
  timeout: 300_000,
});
const out = `${res.stdout || ''}`;
process.stdout.write(out.split('\n').filter((l) => /^(ok|FAIL|skip)/.test(l)).map((l) => `  ${l}`).join('\n') + '\n');
if (res.status !== 0) {
  process.stderr.write((res.stderr || '').split('\n').filter((l) => !/crashpad/.test(l)).join('\n'));
  console.error(`geocode_render: THẤT BẠI (exit ${res.status}${res.error ? `, ${res.error.message}` : ''})`);
  process.exit(1);
}
fs.rmSync(cacheDir, { recursive: true, force: true });
console.log('geocode_render: OK');
