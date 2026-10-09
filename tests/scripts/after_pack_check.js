/* CHỐT afterPack (scripts/after_pack_check.js) — bản đóng gói thiếu tệp bắt buộc phải bị chặn.
 *
 * LỖI ĐANG CHẶN (v1.1.14, người dùng báo 2026-10-09): bộ cài thiếu static/vendor/pixi.min.js +
 * mammoth.browser.min.js (không nằm trong git, chỉ sinh ra lúc `postinstall`). App mở lên Trang
 * chủ trống, mọi nút chết — mà electron-builder vẫn báo build thành công.
 * Chạy: npm run test:after-pack
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const afterPack = require(path.join(ROOT, 'scripts', 'after_pack_check.js'));
const { checkPackedApp, requiredFiles } = afterPack;

function makeApp(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-afterpack-'));
    fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(dir, 'index.html'));
    files.forEach((rel) => {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), 'x');
    });
    return dir;
}

async function main() {
    // 1. Danh sách suy ra từ index.html THẬT: phải có đúng hai thư viện đã làm hỏng 1.1.14.
    const winList = requiredFiles(makeApp([]), 'win32');
    assert.ok(winList.includes('static/vendor/pixi.min.js'), 'phải canh pixi.min.js');
    assert.ok(winList.includes('static/vendor/mammoth.browser.min.js'), 'phải canh mammoth.browser.min.js');
    assert.ok(winList.includes('native/sidecar/build/core_process.exe'));
    assert.ok(requiredFiles(makeApp([]), 'darwin').includes('native/sidecar/build/core_process'), 'macOS: sidecar không có .exe');

    // 2. Đúng ca của 1.1.14: có native, THIẾU vendor -> báo đúng hai tệp vendor.
    const broken = makeApp(['native/addon/build/Release/core_c.node', 'native/sidecar/build/core_process.exe']);
    assert.deepStrictEqual(checkPackedApp(broken, 'win32').missing.sort(),
        ['static/vendor/mammoth.browser.min.js', 'static/vendor/pixi.min.js']);

    // 3. Hook electron-builder phải NÉM LỖI (electron-builder dừng, không ra bộ cài).
    const hook = (appDir) => {
        const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-afterpack-res-'));
        fs.renameSync(appDir, path.join(resources, 'app'));
        return afterPack({ appOutDir: resources, electronPlatformName: 'win32', packager: { getResourcesDir: () => resources } });
    };
    await assert.rejects(hook(broken), /THIẾU tệp bắt buộc/);

    // 4. Đủ tệp -> qua, không ném.
    const full = makeApp(winList);
    assert.deepStrictEqual(checkPackedApp(full, 'win32').missing, []);
    await hook(full);

    // 5. Tệp RỖNG cũng tính là thiếu (chép hỏng giữa chừng).
    const empty = makeApp(winList);
    fs.writeFileSync(path.join(empty, 'static/vendor/pixi.min.js'), '');
    assert.deepStrictEqual(checkPackedApp(empty, 'win32').missing, ['static/vendor/pixi.min.js']);

    console.log('after-pack check: PASS — bộ cài thiếu vendor/native bị chặn, đủ tệp thì qua');
}

main().catch((error) => { console.error(error); process.exit(1); });
