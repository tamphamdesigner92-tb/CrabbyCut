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
  // auto_sfx.txt liệt kê 17 file SFXs (9 nhóm, nhóm 8-9 thêm ở cài đặt bản 2) + 2 file nhạc nền.
  assert.strictEqual(wanted.length, 19, 'DEFAULTS phải liệt kê đúng số file của auto_sfx.txt');
  /* Tài nguyên trong library/ KHÔNG nằm trong git (.gitignore, library/README.md): bản clone sạch
   * (CI, máy mới) chỉ có .gitkeep -> không có gì để so, bỏ qua thay vì đỏ oan. Có thư viện thì kiểm đủ. */
  if (![...onDisk].some((name) => !name.endsWith('/.gitkeep'))) {
    console.log('  --  library/ chưa có tài nguyên (bản clone sạch) -> bỏ qua kiểm file của auto_sfx');
  } else {
    wanted.forEach((rel) => {
      assert.ok(onDisk.has(rel.toLowerCase()), `thiếu file trong library/: ${rel}`);
    });
  }
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
      templateRules: [
        { templateId: 'approved', sfxGroup: 'khong_co' },   // nhóm ma -> bỏ
        { templateId: 'mau_da_go', sfxGroup: 'g3' },        // mẫu không còn trong engine -> bỏ
        { templateId: 'quote', sfxGroup: 'g1' },
        { templateId: 'quote', sfxGroup: 'g3' },            // trùng mẫu -> bỏ
      ],
    },
  }).autoSfx;
  assert.deepStrictEqual(out.templateRules, [{ templateId: 'quote', sfxGroup: 'g1' }], 'dòng mẫu văn bản hỏng/trùng phải bị bỏ');
  assert.strictEqual(out.rules.length, 1, 'chỉ luật thứ 3 hợp lệ về nguồn+đích');
  assert.strictEqual(out.rules[0].threshold, null, 'ngưỡng trỏ nhóm không tồn tại phải bị bỏ, luật vẫn sống');
  assert.strictEqual(out.elementRules.length, 0, 'dòng Element trỏ nhóm ma phải bị bỏ');
}

/* ---------- phân biệt "chưa có khoá" với "mảng rỗng cố ý" ---------- */
{
  assert.ok(AppSettings.normalize({ autoSfx: {} }).autoSfx.rules.length > 0, 'thiếu khoá rules -> lấy mặc định');
  // Cài đặt lưu từ trước khi có bảng mẫu văn bản -> nhận bảng mặc định, không mất tiếng.
  assert.ok(AppSettings.normalize({ autoSfx: {} }).autoSfx.templateRules.length > 0, 'thiếu khoá templateRules -> lấy mặc định');
}

/* ---------- nâng cấp cài đặt bản 1 -> 2: CỘNG nhóm chuyển cảnh mới, không sửa gì cũ ---------- */
{
  const D = AppSettings.defaults().autoSfx;
  const v1 = {
    version: 1,
    autoSfx: {
      ...D,
      // Người dùng bản 1 đã tự xếp 'fade' vào nhóm của mình và đặt sẵn một nhóm id 'tflash'.
      transGroups: [
        { id: 't1', name: 'T1', transitions: ['slideleft', 'fade'] },
        { id: 'tflash', name: 'Của tôi', transitions: ['pixelize'] },
      ],
      sfxGroups: D.sfxGroups.filter((g) => !['gflash', 'gsparkle'].includes(g.id)),
      rules: [{ source: { kind: 'transition', group: 't1' }, sfxGroup: 'g3', threshold: null }],
    },
  };
  const up = AppSettings.normalize(v1);
  assert.strictEqual(up.version, AppSettings.SCHEMA_VERSION);
  const byId = Object.fromEntries(up.autoSfx.transGroups.map((g) => [g.id, g.transitions]));
  assert.deepStrictEqual(byId.t1, ['slideleft', 'fade'], 'nhóm của người dùng giữ nguyên');
  assert.deepStrictEqual(byId.tflash, ['pixelize'], 'trùng id -> giữ bản của người dùng, không đè');
  assert.deepStrictEqual(byId.tfade, ['fadeblack', 'dissolve'], 'fade đã có nhóm -> không kéo sang nhóm mặc định');
  assert.deepStrictEqual(byId.tzoom, ['zoomin', 'echoshift', 'spinslam']);
  assert.ok(up.autoSfx.sfxGroups.some((g) => g.id === 'gsparkle'), 'nhóm SFXs mới được thêm');
  assert.strictEqual(up.autoSfx.rules.find((r) => r.source.group === 't1').sfxGroup, 'g3', 'luật cũ giữ nguyên');
  assert.ok(up.autoSfx.rules.some((r) => r.source.group === 'tzoom'), 'luật cho nhóm mới được thêm');
  // Đã ở bản 2 thì KHÔNG cộng lại (người dùng xoá nhóm mới là tôn trọng).
  const removed = AppSettings.normalize({ ...up, autoSfx: { ...up.autoSfx, transGroups: up.autoSfx.transGroups.filter((g) => g.id !== 'tzoom') } });
  assert.ok(!removed.autoSfx.transGroups.some((g) => g.id === 'tzoom'), 'bản 2: nhóm bị xoá không tự mọc lại');
  assert.deepStrictEqual(AppSettings.normalize(up), up, 'idempotent sau nâng cấp');
  assert.deepStrictEqual(AppSettings.normalize({ autoSfx: { templateRules: [] } }).autoSfx.templateRules, [], 'mảng rỗng cố ý được tôn trọng');
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
  assert.deepStrictEqual(Object.keys(d).sort(), ['autoSave', 'autoSfx', 'export', 'general', 'preview', 'shortcuts', 'textEffects', 'version']);
  // Xuất video: mặc định render bằng GPU (người dùng chốt 2026-10-02), giá trị lạ -> GPU.
  assert.strictEqual(d.export.renderDevice, 'gpu');
  assert.strictEqual(AppSettings.normalize({ export: { renderDevice: 'cpu' } }).export.renderDevice, 'cpu');
  assert.strictEqual(AppSettings.normalize({ export: { renderDevice: 'tpu' } }).export.renderDevice, 'gpu');

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
  assert.deepStrictEqual(legacy.export, { renderDevice: 'gpu', renderCache: true },
    'cấu hình cũ chưa có mục Xuất video -> GPU, dùng lại phần đã render');
  // Cache render (mục 1.13): chỉ nhận boolean; giá trị lạ về mặc định (bật).
  assert.strictEqual(AppSettings.normalize({ export: { renderCache: false } }).export.renderCache, false);
  assert.strictEqual(AppSettings.normalize({ export: { renderCache: 'no' } }).export.renderCache, true);
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
