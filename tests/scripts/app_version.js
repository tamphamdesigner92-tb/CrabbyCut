/**
 * Số phiên bản trên giao diện (Trang chủ, thanh trạng thái, Cài đặt → Về CrabbyCut).
 *
 * Canh ĐÚNG MỘT điều: con số người dùng nhìn thấy phải là "version" của package.json — chính
 * con số electron-builder đặt vào tên bộ cài và updater so với GitHub Releases. Bài học thật:
 * tag v1.1.12 được phát hành trong khi package.json vẫn ghi 1.1.11, tức bộ cài tự nhận mình là
 * bản cũ. Ghi cứng số vào HTML sẽ lặp lại đúng lỗi đó ở mọi lần phát hành.
 *
 * Chạy: npm run test:app-version
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

/* ---------- 1. Một nguồn duy nhất ---------- */
{
    assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `package.json version phải dạng x.y.z, đang "${pkg.version}"`);
    assert.strictEqual(lock.version, pkg.version, 'package-lock.json phải cùng version với package.json');
    assert.strictEqual(lock.packages[''].version, pkg.version, 'packages[""] của lock cũng phải cùng version');

    const main = read('electron', 'main.js');
    assert.ok(/ipcMain\.handle\('app-info'[\s\S]{0,80}version: app\.getVersion\(\)/.test(main),
        'main process phải trả app.getVersion() (= package.json), không tự đặt số');
    const server = read('backend', 'server.js');
    assert.ok(/'\/api\/app-info'[\s\S]{0,400}package\.json/.test(server), 'đường dự phòng của bản web phải đọc package.json');
    console.log(`  ok  một nguồn: package.json ${pkg.version} (lock khớp, main + backend cùng đọc nó)`);
}

/* ---------- 2. Giao diện không ghi cứng số ---------- */
{
    const html = read('index.html');
    const badge = /<span class="app-version-badge" data-app-version[^>]*hidden><\/span>/.exec(html);
    assert.ok(badge, 'huy hiệu cạnh logo phải RỖNG + hidden, để app-info.js điền số thật');
    const status = /<div class="app-statusbar-version" data-app-version data-app-version-prefix="Phiên bản: " hidden><\/div>/.exec(html);
    assert.ok(status, 'thanh trạng thái phải có ô "Phiên bản: …" rỗng + hidden');
    assert.ok(html.indexOf('app-statusbar-version') > html.indexOf('class="app-statusbar-right"'),
        'ô phiên bản nằm ở góc PHẢI thanh trạng thái');
    assert.ok(html.indexOf('src="/static/js/app-info.js') < html.indexOf('src="/static/js/settings-panel.js'),
        'app-info.js phải nạp trước settings-panel.js');
    assert.ok(!html.includes(`v${pkg.version}`), `index.html không được ghi cứng "v${pkg.version}"`);

    const css = read('static', 'css', 'lumen-skin.css');
    assert.ok(/body\.home-active \.app-version-badge:not\(\[hidden\]\) \{ display: inline-block; \}/.test(css),
        'huy hiệu cạnh logo chỉ hiện ở Trang chủ');
    assert.ok(/body\.home-active \.app-statusbar-version \{ display: none; \}/.test(css),
        'ô phiên bản ở thanh trạng thái ẩn ở Trang chủ (ở đó số nằm cạnh logo)');
    console.log('  ok  Trang chủ + thanh trạng thái: phần tử rỗng, số điền lúc chạy');
}

/* ---------- 3. app-info.js điền đúng ---------- */
async function checkAppInfo() {
    const els = [
        { dataset: {}, textContent: '', hidden: true },
        { dataset: { appVersionPrefix: 'Phiên bản: ' }, textContent: '', hidden: true },
    ];
    const win = {
        desktopEnv: { getAppInfo: async () => ({ version: pkg.version, author: 'Tam Pham' }) },
    };
    const doc = {
        readyState: 'complete',
        querySelectorAll: (sel) => (sel === '[data-app-version]' ? els : []),
        addEventListener: () => {},
    };
    const src = read('static', 'js', 'app-info.js');
    new Function('window', 'document', 'fetch', 'console', src)(win, doc, async () => { throw new Error('không được gọi backend khi đã có desktopEnv'); }, console);
    const info = await win.AppInfo.load();
    assert.strictEqual(info.version, pkg.version);
    assert.strictEqual(els[0].textContent, `v${pkg.version}`);
    assert.strictEqual(els[0].hidden, false);
    assert.strictEqual(els[1].textContent, `Phiên bản: v${pkg.version}`);
    assert.strictEqual(win.AppInfo.versionLabel('v2.0.0'), 'v2.0.0', 'không được thành "vv2.0.0"');
    assert.strictEqual(win.AppInfo.versionLabel(''), '');

    // Không lấy được số -> phần tử GIỮ NGUYÊN ẩn (thà không hiện còn hơn hiện số sai).
    const hiddenEl = { dataset: {}, textContent: '', hidden: true };
    const win2 = {};
    const doc2 = { readyState: 'complete', querySelectorAll: () => [hiddenEl], addEventListener: () => {} };
    const quiet = { warn: () => {} };
    new Function('window', 'document', 'fetch', 'console', src)(win2, doc2, async () => ({ ok: false, status: 500 }), quiet);
    assert.strictEqual(await win2.AppInfo.load(), null);
    assert.strictEqual(hiddenEl.hidden, true);
    console.log('  ok  app-info.js: điền "v…" + tiền tố, lỗi thì giữ ẩn');
}

/* ---------- 4. Cài đặt → Về CrabbyCut ---------- */
{
    const panel = read('static', 'js', 'settings-panel.js');
    assert.ok(/\{ id: 'about', label: 'Về CrabbyCut', ready: true \}/.test(panel), 'phải có mục "Về CrabbyCut"');
    assert.ok(/about: aboutPaneHtml/.test(panel), 'mục phải có nội dung');
    const pane = panel.slice(panel.indexOf('function aboutPaneHtml'), panel.indexOf('function render()'));
    assert.ok(!pane.includes(pkg.version) && !/Tam Pham|GPL-3/.test(pane),
        'phiên bản / tác giả / giấy phép phải đọc từ AppInfo (package.json), không ghi cứng');
    // IPC mở liên kết chỉ nhận KHOÁ — renderer không được đưa URL tuỳ ý cho shell.openExternal.
    const preload = read('electron', 'preload.js');
    assert.ok(/openProjectLink: async \(key\) => ipcRenderer\.invoke\('open-project-link', key\)/.test(preload));
    const main = read('electron', 'main.js');
    assert.ok(/const url = PROJECT_LINKS\[String\(key \|\| ''\)\]/.test(main), 'main tự tra URL theo khoá');
    console.log('  ok  Cài đặt → Về CrabbyCut: đọc từ package.json, liên kết mở theo khoá');
}

checkAppInfo()
    .then(() => console.log('app_version: PASS'))
    .catch((error) => { console.error(error); process.exit(1); });
