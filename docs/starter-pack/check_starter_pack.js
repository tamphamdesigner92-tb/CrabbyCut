#!/usr/bin/env node
/**
 * KIỂM BỘ TÀI NGUYÊN KHỞI ĐẦU (starter pack)
 * ==========================================
 * Chạy: npm run test:starter-pack                 (chỉ kiểm danh sách, không cần tệp thật)
 *       npm run test:starter-pack -- --dir <thư mục>   (kiểm thêm tệp thật + CREDITS.md)
 *
 * 1. Mọi tên trong manifest.json đúng quy ước docs/QUY_UOC_DAT_TEN_TAI_NGUYEN.md
 *    (tiền tố hợp lệ, đuôi được nhận, không có chữ rác).
 * 2. Chạy đúng logic Magic Fill (static/js/magic-fill-assets.js) trên kich-ban-mau.md:
 *    mỗi tệp "magic-fill" phải được chọn đúng chỗ dự kiến, và không tệp nào chen vào
 *    dòng không dành cho nó.
 * 3. Mọi tệp Auto SFX mặc định (static/js/app-settings.js) đều có trong gói, để người
 *    dùng chép gói vào library/ là Auto SFX chạy ngay, không phải sửa Cài đặt.
 * 4. Với --dir: từng tệp có mặt, và CREDITS.md có dòng cho từng tệp với giấy phép đã điền.
 *
 * Đặt trong docs/ vì docs/** bị loại khỏi bộ cài.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MFA = require(path.join(ROOT, 'static', 'js', 'magic-fill-assets.js'));
const { normalizeMarkdownScript } = require(path.join(ROOT, 'static', 'js', 'script-markdown.js'));
const AppSettings = require(path.join(ROOT, 'static', 'js', 'app-settings.js'));

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const files = manifest.files;
let failures = 0;
const check = (ok, msg) => {
  if (ok) return;
  failures += 1;
  console.error(`  ✗ ${msg}`);
};

const VIDEO = /\.(mp4|mov|m4v|webm)$/i;
const IMAGE = /\.(png|jpg|jpeg|webp|svg)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac)$/i;
const typeOf = (p) => (VIDEO.test(p) ? 'media_video' : IMAGE.test(p) ? 'media_image' : AUDIO.test(p) ? 'audio' : null);
const nameOf = (p) => p.split('/').pop();
const JUNK = /\b(final|copy|edited|ver\d*|v\d+|\d{3,4}x\d{3,4}|1080p?|720p?)\b/i;

/* ---------- 1. Quy ước tên ---------- */
console.log('1. Quy ước tên tệp');
const seen = new Set();
for (const f of files) {
  const name = nameOf(f.path);
  const type = typeOf(name);
  check(type, `${name}: đuôi tệp không được nhận`);
  check(!seen.has(f.path.toLowerCase()), `${f.path}: trùng tên`);
  seen.add(f.path.toLowerCase());
  const info = MFA.describeAssetName(name, type);
  check(['vid', 'icon', 'illus', 'sfxs', 'mus'].includes(info.tag), `${name}: thiếu tiền tố [Vid]/[Icon]/[Illus]/[SFXs]/[Mus]`);
  if (f.for === 'magic-fill') check(!JUNK.test(info.base), `${name}: có chữ rác (final, v2, 1080…)`);
}

/* ---------- 2. Magic Fill trên kịch bản mẫu ---------- */
console.log('2. Magic Fill trên kịch bản mẫu');
const assets = files
  .filter((f) => typeOf(f.path) !== 'audio')
  .map((f) => ({ name: nameOf(f.path), rel_path: f.path, type: typeOf(f.path) }));
const md = fs.readFileSync(path.join(__dirname, manifest.script), 'utf8');
const parsed = normalizeMarkdownScript(md, { sourceType: 'md', sourceName: manifest.script });

const noteHits = new Map(); // dòng (1-based) -> { cover, inset }
for (const k of MFA.keywordsFromScript(parsed.metadata, parsed.clean_text)) {
  if (k.isHook) continue;
  const m = MFA.matchNoteAssets(k.text, assets, { random: () => 0 });
  // Mọi ứng viên bằng điểm cao nhất đều có thể được bốc -> tính cả nhóm, không chỉ cái đầu.
  const top = (kind) => {
    const list = (m.matches || []).filter((c) => c.kind === kind);
    if (!list.length) return [];
    const best = Math.max(...list.map((c) => c.ratio));
    return list.filter((c) => c.ratio >= best - 1e-6).map((c) => c.asset.name);
  };
  noteHits.set(k.lineIndex + 1, {
    cover: m.matches ? top(MFA.KIND_COVER) : (m.cover ? [m.cover.asset.name] : []),
    inset: m.matches ? top(MFA.KIND_INSET) : (m.inset ? [m.inset.asset.name] : []),
  });
}
const bolds = (parsed.metadata.bold_ranges || []).filter((b) => b && String(b.text || '').trim());
const { builds } = MFA.planBoldGroups(MFA.groupBoldRanges(bolds, parsed.clean_text), assets, {});
const boldHits = new Map(); // chữ in đậm (chuẩn hoá) -> tên tệp
for (const b of builds) {
  for (const u of b.units) {
    if (u.asset && !u.fallback) boldHits.set(MFA.normalizeWord(u.text), u.asset.name);
  }
}

for (const f of files.filter((x) => x.for === 'magic-fill')) {
  const name = nameOf(f.path);
  if (f.bold) {
    check(boldHits.get(MFA.normalizeWord(f.bold)) === name,
      `${name}: cụm in đậm "${f.bold}" lấy "${boldHits.get(MFA.normalizeWord(f.bold)) || 'không có'}"`);
  }
  if (f.line) {
    const hit = noteHits.get(f.line) || { cover: [], inset: [] };
    const got = hit[f.expect] || [];
    check(got.length === 1 && got[0] === name,
      `${name}: ghi chú dòng ${f.line} (${f.expect}) có thể lấy [${got.join(' | ') || 'không có'}]`);
  }
}
// Không tệp nào chen vào ghi chú của dòng khác dòng dành cho nó.
const ownLine = new Map(files.filter((f) => f.line).map((f) => [nameOf(f.path), f.line]));
for (const [line, hit] of noteHits) {
  for (const name of [...hit.cover, ...hit.inset]) {
    const own = ownLine.get(name);
    check(own === line, `${name}: chen vào ghi chú dòng ${line}${own ? ` (dành cho dòng ${own})` : ''}`);
  }
}

/* ---------- 3. Auto SFX mặc định ---------- */
console.log('3. Tệp Auto SFX mặc định');
const cfg = AppSettings.DEFAULTS.autoSfx;
const wanted = [
  ...cfg.sfxGroups.flatMap((g) => g.files),
  ...cfg.musicFiles,
  ...(cfg.elementRules || []).map((r) => `Elements/${r.assetName}`),
];
const have = new Set(files.map((f) => f.path.toLowerCase()));
for (const rel of wanted) check(have.has(rel.toLowerCase()), `thiếu ${rel} (Auto SFX mặc định cần tệp này)`);

/* ---------- 4. Tệp thật + CREDITS.md (tuỳ chọn) ---------- */
const dirArg = process.argv.indexOf('--dir');
if (dirArg > 0) {
  const dir = path.resolve(process.argv[dirArg + 1] || '.');
  console.log(`4. Tệp thật trong ${dir}`);
  for (const f of files) check(fs.existsSync(path.join(dir, f.path)), `không thấy tệp ${f.path}`);
  const creditsPath = path.join(dir, 'CREDITS.md');
  if (!fs.existsSync(creditsPath)) {
    check(false, 'không thấy CREDITS.md ở gốc gói');
  } else {
    const rows = fs.readFileSync(creditsPath, 'utf8').split('\n').filter((l) => l.startsWith('|'));
    for (const f of files) {
      const row = rows.find((l) => l.includes(nameOf(f.path)));
      check(row, `CREDITS.md thiếu dòng cho ${nameOf(f.path)}`);
      if (row) check(!/chưa có/i.test(row), `CREDITS.md: ${nameOf(f.path)} còn ô "chưa có"`);
    }
  }
}

assert.ok(true);
if (failures) {
  console.error(`\n${failures} lỗi.`);
  process.exit(1);
}
console.log(`\nĐạt: ${files.length} tệp, kịch bản ${manifest.script}.`);
