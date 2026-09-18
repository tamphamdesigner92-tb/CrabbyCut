/**
 * Smoke test cho static/js/app-settings.js — schema + normalize() của Cài đặt ứng dụng.
 * normalize() là chốt chặn an toàn DUY NHẤT (frontend gọi trước khi gửi, backend gọi trước
 * khi ghi đĩa), nên mọi bất biến của nó phải được canh ở đây.
 * Chạy: npm run test:app-settings
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const AppSettings = require(path.join(ROOT, 'static', 'js', 'app-settings.js'));
const TA = require(path.join(ROOT, 'static', 'js', 'text-animations.js'));
const Transitions = require(path.join(ROOT, 'static', 'js', 'transitions.js'));

const json = (v) => JSON.stringify(v);

/* ---------- đầu vào rác đều ra cấu hình hợp lệ ---------- */
{
  const base = AppSettings.defaults();
  [undefined, null, 0, 'x', [], {}, { autoSfx: null }, { autoSfx: 'hỏng' }].forEach((bad) => {
    assert.strictEqual(json(AppSettings.normalize(bad)), json(base), `đầu vào ${json(bad)} phải ra DEFAULTS`);
  });
  assert.strictEqual(base.version, AppSettings.SCHEMA_VERSION);
}

/* ---------- idempotent: chuẩn hoá 2 lần không đổi gì ---------- */
{
  const once = AppSettings.normalize({});
  assert.strictEqual(json(AppSettings.normalize(once)), json(once), 'normalize phải idempotent');
  // DEFAULTS viết tay cũng phải là điểm bất động — nếu không, file ghi ra đĩa sẽ khác bản
  // trong code và mọi so sánh khi gỡ lỗi thành vô nghĩa.
  assert.strictEqual(json(AppSettings.normalize(AppSettings.DEFAULTS)), json(once), 'DEFAULTS phải là điểm bất động của normalize');
}

/* ---------- mọi id trong DEFAULTS phải TỒN TẠI THẬT trong engine ---------- */
{
  const c = AppSettings.defaults().autoSfx;
  const effects = new Set(TA.EFFECT_OPTIONS.map((o) => o.value));
  const transitions = new Set(Transitions.TRANSITION_OPTIONS.map((o) => o.id));
  c.animGroups.forEach((g) => g.effects.forEach((id) => {
    assert.ok(effects.has(id), `hiệu ứng "${id}" trong DEFAULTS không có trong TextAnimations.EFFECT_OPTIONS`);
  }));
  c.transGroups.forEach((g) => g.transitions.forEach((id) => {
    assert.ok(transitions.has(id), `chuyển cảnh "${id}" trong DEFAULTS không có trong Transitions.TRANSITION_OPTIONS`);
  }));
  // Một hiệu ứng nằm ở 2 nhóm thì tra luật ra 2 kết quả tuỳ thứ tự duyệt -> phải duy nhất.
  const seenEffect = new Set();
  c.animGroups.forEach((g) => g.effects.forEach((id) => {
    assert.ok(!seenEffect.has(id), `hiệu ứng "${id}" nằm ở nhiều hơn một nhóm`);
    seenEffect.add(id);
  }));
}

/* ---------- mọi file trong DEFAULTS phải có thật trong library/ ----------
 * auto_sfx.txt ghi đuôi ".mp3" thường còn trên đĩa là ".MP3" HOA -> khớp KHÔNG phân biệt
 * hoa thường. Test này là cái chuông báo khi ai đó đổi tên/xoá file trong library/. */
{
  const LIB = path.join(ROOT, 'library');
  const onDisk = new Set();
  ['SFXs', 'Music'].forEach((sub) => {
    let names = [];
    try { names = fs.readdirSync(path.join(LIB, sub)); } catch (_) { names = []; }
    names.forEach((name) => onDisk.add(`${sub}/${name}`.toLowerCase()));
  });
  const c = AppSettings.defaults().autoSfx;
  const wanted = [...c.sfxGroups.flatMap((g) => g.files), ...c.musicFiles];
  // auto_sfx.txt liệt kê 15 file SFXs (7 nhóm) + 2 file nhạc nền.
  assert.strictEqual(wanted.length, 17, 'DEFAULTS phải liệt kê đúng số file của auto_sfx.txt');
  wanted.forEach((rel) => {
    assert.ok(onDisk.has(rel.toLowerCase()), `thiếu file trong library/: ${rel}`);
  });
}

/* ---------- lọc id engine không biết, bỏ nhóm rỗng, loại trùng ---------- */
{
  const out = AppSettings.normalize({
    autoSfx: {
      animGroups: [
        { id: 'x', name: 'X', effects: ['pop', 'khong_ton_tai', 'pop'] },
        { id: 'rong', name: 'Rỗng', effects: ['khong_ton_tai'] },
        { id: 'x', name: 'Trùng id', effects: ['flip'] },
      ],
      rules: [{ source: { kind: 'anim', group: 'x' }, sfxGroup: 'g1' }],
    },
  }).autoSfx;
  assert.strictEqual(out.animGroups.length, 1, 'nhóm rỗng và nhóm trùng id phải bị bỏ');
  assert.deepStrictEqual(out.animGroups[0].effects, ['pop'], 'id lạ và id trùng phải bị lọc');
  assert.strictEqual(out.rules.length, 1, 'luật trỏ tới nhóm còn sống phải được giữ');
}

/* ---------- luật mồ côi tự rụng theo nhóm bị xoá ---------- */
{
  const out = AppSettings.normalize({
    autoSfx: {
      rules: [
        { source: { kind: 'anim', group: 'khong_co' }, sfxGroup: 'g1' },
        { source: { kind: 'anim', group: 'a1' }, sfxGroup: 'khong_co' },
        { source: { kind: 'anim', group: 'a1' }, sfxGroup: 'g1', threshold: { maxDuration: 0.8, elseSfxGroup: 'khong_co' } },
        { source: { kind: 'anim', group: 'a1' }, sfxGroup: 'g3' },   // trùng nguồn -> bỏ
      ],
      elementRules: [{ assetName: '[Icon] True.png', sfxGroup: 'khong_co' }],
    },
  }).autoSfx;
  assert.strictEqual(out.rules.length, 1, 'chỉ luật thứ 3 hợp lệ về nguồn+đích');
  assert.strictEqual(out.rules[0].threshold, null, 'ngưỡng trỏ nhóm không tồn tại phải bị bỏ, luật vẫn sống');
  assert.strictEqual(out.elementRules.length, 0, 'dòng Element trỏ nhóm ma phải bị bỏ');
}

/* ---------- phân biệt "chưa có khoá" với "mảng rỗng cố ý" ---------- */
{
  assert.ok(AppSettings.normalize({ autoSfx: {} }).autoSfx.rules.length > 0, 'thiếu khoá rules -> lấy mặc định');
  assert.strictEqual(AppSettings.normalize({ autoSfx: { rules: [] } }).autoSfx.rules.length, 0, 'rules: [] là lựa chọn cố ý, phải tôn trọng');
  assert.strictEqual(AppSettings.normalize({ autoSfx: { musicFiles: [] } }).autoSfx.musicFiles.length, 0, 'musicFiles: [] phải được tôn trọng');
}

/* ---------- kẹp số + giá trị align/fit lạ ---------- */
{
  const out = AppSettings.normalize({
    autoSfx: {
      levels: { sfxDb: 999, musicDb: -999, musicFadeToDb: 'x', musicFadeSec: 0, animLeadSec: -5 },
      sfxGroups: [{ id: 'g1', name: 'G1', files: ['SFXs/a.mp3'], align: 'linh tinh', fit: 'linh tinh' }],
    },
  }).autoSfx;
  assert.strictEqual(out.levels.sfxDb, AppSettings.LIMITS.db.max);
  assert.strictEqual(out.levels.musicDb, AppSettings.LIMITS.db.min);
  assert.strictEqual(out.levels.musicFadeToDb, -25, 'giá trị không phải số -> lấy mặc định');
  assert.strictEqual(out.levels.musicFadeSec, AppSettings.LIMITS.fadeSec.min);
  assert.strictEqual(out.levels.animLeadSec, AppSettings.LIMITS.leadSec.min, 'đẩy sớm không được âm');
  assert.strictEqual(AppSettings.defaults().autoSfx.levels.animLeadSec, 0.3);
  assert.strictEqual(out.sfxGroups[0].align, 'peak');
  assert.strictEqual(out.sfxGroups[0].fit, 'full');
}

/* ---------- đường dẫn: chuẩn "\" -> "/", bỏ "./", loại trùng không phân biệt hoa thường ---------- */
{
  const out = AppSettings.normalize({
    autoSfx: { musicFiles: ['./Music\\a.MP3', 'Music/a.mp3', 'Music/b.mp3', '   '] },
  }).autoSfx;
  assert.deepStrictEqual(out.musicFiles, ['Music/a.MP3', 'Music/b.mp3']);
}

/* ---------- Các mục cài đặt ngoài Auto Sound Effects ---------- */
{
  const d = AppSettings.defaults();
  assert.deepStrictEqual(Object.keys(d).sort(), ['autoSave', 'autoSfx', 'general', 'preview', 'shortcuts', 'textEffects', 'version']);

  // Kẹp số + giá trị lạ rơi về mặc định.
  const out = AppSettings.normalize({
    autoSave: { enabled: 'x', intervalMin: 999, keepVersions: 0, warnOnExit: false },
    general: { undoSteps: 1, devMode: 'x', snapDefault: false },
    preview: { defaultQuality: 'zzz', frameStep: 999, transitionQuality: 'zzz' },
  });
  assert.strictEqual(out.autoSave.enabled, true, 'kiểu sai -> lấy mặc định');
  assert.strictEqual(out.autoSave.warnOnExit, false, 'false HỢP LỆ, không được coi là thiếu');
  assert.strictEqual(out.autoSave.intervalMin, AppSettings.LIMITS.intervalMin.max);
  assert.strictEqual(out.autoSave.keepVersions, AppSettings.LIMITS.keepVersions.min);
  assert.strictEqual(out.general.undoSteps, AppSettings.LIMITS.undoSteps.min);
  assert.strictEqual(out.general.snapDefault, false);
  assert.strictEqual(out.preview.defaultQuality, 'proxy');
  assert.strictEqual(out.preview.transitionQuality, 'auto');
  assert.strictEqual(out.preview.frameStep, AppSettings.LIMITS.frameStep.max);

  // Số bước Hoàn tác phải là SỐ NGUYÊN — undoStack.length so với số thập phân thì cắt sai.
  assert.strictEqual(AppSettings.normalize({ general: { undoSteps: 12.7 } }).general.undoSteps, 13);

  // Cấu hình CŨ (chỉ có autoSfx, từ trước khi có 4 mục này) phải nâng cấp sạch.
  const legacy = AppSettings.normalize({ autoSfx: { levels: { sfxDb: -9 } } });
  assert.strictEqual(legacy.autoSfx.levels.sfxDb, -9, 'phần cũ phải giữ nguyên');
  assert.deepStrictEqual(legacy.autoSave, AppSettings.DEFAULTS.autoSave);
  assert.deepStrictEqual(legacy.shortcuts, {});
  assert.deepStrictEqual(legacy.textEffects, [], 'cấu hình cũ chưa có thư viện hiệu ứng -> rỗng');
}

/* ---------- Thư viện "Hiệu ứng chữ" người dùng tự lưu ---------- */
{
  const out = AppSettings.normalize({
    textEffects: [
      // Hợp lệ: giữ nguyên, lọc sạch khoá lạ ở cả patch lẫn ratios.
      { id: 'ux1', name: 'Của tôi', patch: { color: '#ff0000', bg_pad_x: null, font_size: 200, huh: 1 },
        ratios: { stroke_width: 0.08, font_size: 3 } },
      { id: 'ux1', name: 'Trùng id', patch: { color: '#00ff00' } },   // rụng: trùng id
      { id: '', name: 'Không id', patch: { color: '#0000ff' } },      // rụng: thiếu id
      { id: 'ux2', name: 'Rỗng', patch: { font_size: 90 } },          // rụng: patch không còn khoá nào
      { id: 'ux3', patch: { color: '#ffffff' }, ratios: { stroke_width: 999 } },
    ],
  }).textEffects;
  assert.deepStrictEqual(out.map((fx) => fx.id), ['ux1', 'ux3']);
  assert.deepStrictEqual(out[0].patch, { color: '#ff0000', bg_pad_x: null },
    'chỉ khoá DIỆN MẠO được vào patch — cỡ chữ/canh lề đứng ngoài để hiệu ứng không xô layout');
  assert.deepStrictEqual(out[0].ratios, { stroke_width: 0.08 });
  assert.strictEqual(out[1].name, 'Hiệu ứng của tôi', 'thiếu tên -> tên mặc định');
  assert.strictEqual(out[1].ratios.stroke_width, 5, 'tỉ lệ vô lý bị kẹp');
  assert.deepStrictEqual(AppSettings.normalize({ textEffects: 'x' }).textEffects, []);
}

console.log('[app-settings] OK — DEFAULTS khớp engine + library, normalize idempotent, lọc id lạ, rụng luật mồ côi, kẹp số, nâng cấp cấu hình cũ.');
