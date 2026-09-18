/**
 * Smoke test cho static/js/shortcuts.js — danh mục lệnh + bộ so khớp phím tắt.
 * Chạy: npm run test:shortcuts
 *
 * Vì sao cần: phím tắt là thứ chỉ lộ lỗi khi NGƯỜI DÙNG BẤM. Gõ sai một id lệnh, quên nối
 * dây một lệnh, hay để hai lệnh trùng phím mặc định — tất cả đều chạy im, không ném lỗi,
 * và chỉ phát hiện ra khi ai đó thử đúng phím đó.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const S = require(path.join(ROOT, 'static', 'js', 'shortcuts.js'));
const AppSettings = require(path.join(ROOT, 'static', 'js', 'app-settings.js'));

const ev = (code, m = {}) => ({
    code, key: code,
    metaKey: !!m.meta, ctrlKey: !!m.ctrl, altKey: !!m.alt, shiftKey: !!m.shift,
});

/* ---------- comboFromEvent: dựng chuỗi chuẩn từ sự kiện ---------- */
{
    assert.strictEqual(S.comboFromEvent(ev('KeyS', { meta: true })), 'Cmd+KeyS');
    assert.strictEqual(S.comboFromEvent(ev('KeyS', { ctrl: true })), 'Cmd+KeyS', 'Ctrl và Cmd gộp làm một — mã hiện tại vốn so `ctrlKey || metaKey`');
    assert.strictEqual(S.comboFromEvent(ev('KeyS', { meta: true, shift: true })), 'Cmd+Shift+KeyS');
    assert.strictEqual(S.comboFromEvent(ev('BracketLeft', { alt: true })), 'Alt+BracketLeft');
    assert.strictEqual(S.comboFromEvent(ev('Space')), 'Space');
    assert.strictEqual(S.comboFromEvent(ev('ArrowLeft')), 'ArrowLeft');
    // Mới nhấn RIÊNG phím bổ trợ thì chưa thành tổ hợp — nếu trả về chuỗi, ô bắt phím sẽ
    // chốt ngay lúc người dùng vừa đặt ngón lên Shift.
    ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft'].forEach((code) => {
        assert.strictEqual(S.comboFromEvent(ev(code, { shift: true })), '', `${code} riêng lẻ phải trả ''`);
    });
    assert.strictEqual(S.comboFromEvent(null), '');
}

/* ---------- normalizeCombo: thứ tự bổ trợ cố định + loại mã phím rác ---------- */
{
    // Thứ tự phải CHỐT, nếu không 'Shift+Cmd+KeyS' và 'Cmd+Shift+KeyS' thành 2 tổ hợp khác
    // nhau -> dò trùng sai và so sánh với comboFromEvent cũng sai.
    assert.strictEqual(S.normalizeCombo('Shift+Cmd+KeyS'), 'Cmd+Shift+KeyS');
    assert.strictEqual(S.normalizeCombo('  alt + BracketLeft '), 'Alt+BracketLeft');
    ['ráccc', '', 'Shift', 'xyz123', 'Cmd+', null, undefined].forEach((bad) => {
        assert.strictEqual(S.normalizeCombo(bad), '', `${JSON.stringify(bad)} phải bị loại`);
    });
    ['KeyA', 'Digit3', 'F12', 'Numpad5', 'Comma', 'Space', 'ArrowLeft', 'Delete'].forEach((code) => {
        assert.ok(S.isValidKeyCode(code), `${code} phải hợp lệ`);
    });
}

/* ---------- formatCombo: theo nền tảng ---------- */
{
    assert.strictEqual(S.formatCombo('Cmd+Shift+KeyS', 'darwin'), '⇧⌘S');
    assert.strictEqual(S.formatCombo('Cmd+Shift+KeyS', 'win32'), 'Ctrl+Shift+S');
    assert.strictEqual(S.formatCombo('Cmd+Comma', 'darwin'), '⌘,');
    assert.strictEqual(S.formatCombo('Alt+BracketLeft', 'darwin'), '⌥[');
    assert.strictEqual(S.formatCombo('ArrowLeft', 'darwin'), '←');
    assert.strictEqual(S.formatCombo('', 'darwin'), '', 'lệnh bỏ trống phím -> chuỗi rỗng');
}

/* ---------- DEFAULT_KEYMAP: không được có tổ hợp trùng ----------
 * Trùng thì hai lệnh cùng ăn một phím, `resolve` trả về cái đứng trước trong danh mục —
 * lỗi im lặng, phụ thuộc thứ tự khai báo. Test này là chuông báo khi thêm lệnh mới. */
{
    const def = S.defaultKeymap();
    const seen = new Map();
    Object.entries(def).forEach(([id, combo]) => {
        if (!combo) return;
        assert.ok(!seen.has(combo), `tổ hợp ${combo} bị dùng cho cả "${seen.get(combo)}" lẫn "${id}"`);
        seen.set(combo, id);
    });
    assert.strictEqual(Object.keys(def).length, S.COMMANDS.length);
    // Mọi tổ hợp mặc định phải chuẩn hoá về chính nó (viết sai thứ tự trong COMMANDS thì
    // keymapOverrides sẽ tưởng người dùng đã đổi phím).
    Object.entries(def).forEach(([id, combo]) => {
        assert.strictEqual(S.normalizeCombo(combo), combo, `mặc định của ${id} chưa ở dạng chuẩn`);
    });
}

/* ---------- resolve + conflictsOf ---------- */
{
    const def = S.defaultKeymap();
    assert.strictEqual(S.resolve(def, ev('KeyZ', { meta: true })), 'edit.undo');
    assert.strictEqual(S.resolve(def, ev('KeyZ', { meta: true, shift: true })), 'edit.redo', 'Shift phải tách được Redo khỏi Undo');
    assert.strictEqual(S.resolve(def, ev('Space')), 'playback.togglePlay');
    assert.strictEqual(S.resolve(def, ev('KeyQ')), null);
    assert.deepStrictEqual(S.conflictsOf(def, 'Cmd+KeyK'), ['tool.razor']);
    assert.deepStrictEqual(S.conflictsOf(def, 'Cmd+KeyK', 'tool.razor'), [], 'bỏ qua chính lệnh đang gán');
    assert.deepStrictEqual(S.conflictsOf(def, 'KeyQ'), []);
}

/* ---------- mergeKeymap / keymapOverrides: chỉ lưu phần KHÁC mặc định ---------- */
{
    const km = S.mergeKeymap({ 'playback.togglePlay': 'KeyJ' });
    assert.strictEqual(km['playback.togglePlay'], 'KeyJ');
    assert.strictEqual(km['edit.undo'], 'Cmd+KeyZ', 'lệnh không đổi vẫn giữ mặc định');
    assert.deepStrictEqual(S.keymapOverrides(km), { 'playback.togglePlay': 'KeyJ' });

    // Id lệnh không còn tồn tại (bản cũ) -> bỏ, không làm hỏng cả keymap.
    assert.deepStrictEqual(S.keymapOverrides(S.mergeKeymap({ 'khong.co.that': 'KeyQ' })), {});
    // Tổ hợp rác -> giữ mặc định.
    assert.strictEqual(S.mergeKeymap({ 'tool.razor': 'ráccc' })['tool.razor'], 'Cmd+KeyK');
    // '' là lựa chọn CỐ Ý "bỏ trống phím", khác hẳn với rác.
    assert.strictEqual(S.mergeKeymap({ 'tool.razor': '' })['tool.razor'], '');
    assert.deepStrictEqual(S.keymapOverrides(S.mergeKeymap({ 'tool.razor': '' })), { 'tool.razor': '' });
    // Lệnh bỏ trống phím thì KHÔNG khớp với sự kiện nào.
    assert.strictEqual(S.resolve(S.mergeKeymap({ 'tool.razor': '' }), ev('KeyK', { meta: true })), null);
}

/* ---------- allowInInput: đúng các lệnh chạy được khi đang gõ ---------- */
{
    const allowed = S.COMMANDS.filter((c) => c.allowInInput).map((c) => c.id).sort();
    assert.deepStrictEqual(allowed, ['app.settings', 'project.open', 'project.save', 'project.saveAs'],
        'chỉ nhóm Tệp mới được chạy khi con trỏ đang ở trong ô nhập');
}

/* ---------- MỌI lệnh phải được NỐI DÂY ----------
 * Danh mục có lệnh mà bộ điều phối quên xử lý (hoặc gõ sai id) thì phím tắt hiện đủ trong
 * bảng Cài đặt nhưng bấm không ăn — đúng loại lỗi im lặng mà file test này sinh ra để chặn.
 * Soi trực tiếp mã nguồn 2 bộ điều phối. */
{
    const sources = [
        fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
        fs.readFileSync(path.join(ROOT, 'static', 'js', 'editing-runtime.js'), 'utf8'),
    ].join('\n');
    S.COMMAND_IDS.forEach((id) => {
        assert.ok(sources.includes(`'${id}'`), `lệnh "${id}" chưa được nối dây ở bộ điều phối nào`);
    });
}

/* ---------- Nhãn trên UI phải trỏ tới lệnh CÓ THẬT ---------- */
{
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const ids = [...html.matchAll(/data-shortcut-cmd="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length >= 8, `phải còn đủ nhãn phím tắt trên UI, đang có ${ids.length}`);
    ids.forEach((id) => {
        assert.ok(S.commandById(id), `data-shortcut-cmd="${id}" không khớp lệnh nào`);
    });
    // Không còn chuỗi phím chép cứng trong mục Menu (chúng nay do syncLabels ghi).
    assert.ok(!/class="app-menu-shortcut">[⌘⌥⇧]/.test(html.replace(/data-shortcut-cmd="[^"]*"/g, '')),
        'mục Menu không được chép cứng ký hiệu phím');
}

/* ---------- Nối với app-settings: keymapOf ---------- */
{
    const s = AppSettings.normalize({ shortcuts: { 'playback.togglePlay': 'KeyJ' } });
    const km = AppSettings.keymapOf(s);
    assert.strictEqual(km['playback.togglePlay'], 'KeyJ');
    assert.strictEqual(S.resolve(km, ev('KeyJ')), 'playback.togglePlay');
    assert.strictEqual(S.resolve(km, ev('Space')), null, 'phím cũ phải hết tác dụng');
}

console.log('[shortcuts] OK — combo chuẩn hoá, mặc định không trùng, xung đột, ghi đè, và mọi lệnh đều đã nối dây.');
