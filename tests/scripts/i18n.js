/**
 * ĐA NGÔN NGỮ (docs/I18N.md): lõi _t() + phân giải ngôn ngữ + mục Ngôn ngữ trong cài đặt,
 * và ĐỘ PHỦ từ điển — mọi khoá dùng trong mã nguồn phải có bản dịch en + zh.
 */
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const I18n = require(path.join(ROOT, 'static', 'js', 'i18n.js'));
const AppSettings = require(path.join(ROOT, 'static', 'js', 'app-settings.js'));

function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); } catch (error) { console.error(`FAIL - ${name}`); throw error; }
}

test('resolve: auto theo hệ điều hành, zh mọi biến thể -> giản thể, còn lại -> en', () => {
  assert.strictEqual(I18n.resolve('auto', 'vi-VN'), 'vi');
  assert.strictEqual(I18n.resolve('auto', 'zh-TW'), 'zh');
  assert.strictEqual(I18n.resolve('auto', 'zh-Hans-CN'), 'zh');
  assert.strictEqual(I18n.resolve('auto', 'fr-FR'), 'en');
  assert.strictEqual(I18n.resolve('auto', ''), 'en');
  assert.strictEqual(I18n.resolve('zh', 'vi-VN'), 'zh');
  assert.strictEqual(I18n.resolve(undefined, 'vi'), 'vi');
});

test('_t: tiếng Việt trả nguyên khoá + nội suy tham số', () => {
  I18n.setLocale('vi');
  assert.strictEqual(I18n.t('Hoàn tác'), 'Hoàn tác');
  assert.strictEqual(I18n.t('Đã xoá {n} clip', { n: 3 }), 'Đã xoá 3 clip');
  assert.strictEqual(I18n.t('Giữ {x} lạ'), 'Giữ {x} lạ');
  assert.strictEqual(globalThis._t, I18n.t);
});

test('_t: tra từ điển, gộp khoảng trắng, số nhiều, thiếu thì rơi về tiếng Việt', () => {
  I18n.register('en', {
    '__test Hoàn tác': 'Undo',
    '__test Đã xoá {n} clip': { one: 'Deleted {n} clip', other: 'Deleted {n} clips' },
  });
  I18n.setLocale('en');
  assert.strictEqual(I18n.t('__test Hoàn tác'), 'Undo');
  assert.strictEqual(I18n.t('  __test   Hoàn\n        tác '), 'Undo');
  assert.strictEqual(I18n.t('__test Đã xoá {n} clip', { n: 1 }), 'Deleted 1 clip');
  assert.strictEqual(I18n.t('__test Đã xoá {n} clip', { n: 4 }), 'Deleted 4 clips');
  assert.strictEqual(I18n.t('__test chưa dịch {a}', { a: 'x' }), '__test chưa dịch x');
  assert.ok(I18n.missing().includes('__test chưa dịch {a}'));
  I18n.setLocale('vi');
});

test('cài đặt: general.language chuẩn hoá, mặc định auto', () => {
  assert.strictEqual(AppSettings.defaults().general.language, 'auto');
  assert.strictEqual(AppSettings.normalize({ general: { language: 'zh' } }).general.language, 'zh');
  assert.strictEqual(AppSettings.normalize({ general: { language: 'fr' } }).general.language, 'auto');
  assert.deepStrictEqual(AppSettings.LANGUAGES, ['auto', 'vi', 'en', 'zh']);
});

test('từ điển phủ mọi khoá trong mã nguồn (scripts/i18n_check.js)', () => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'i18n_check.js')], { cwd: ROOT, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Thiếu bản dịch:\n${String(error.stdout || '').slice(0, 4000)}`);
  }
});
