/* =====================================================================
 * PHỤ ĐỀ KHÔNG CÒN CHỮ MỒ CÔI (port CrabbyStudio 4c15fd8, phần chia block)
 *
 * Người dùng báo: câu "Lò phản ứng hạt nhân hoạt động dựa trên nguyên lý phân hạch hạt
 * nhân," ra HAI block — block hai chỉ có chữ "nhân". Gốc: splitTextToMaxLines (editing-
 * runtime.js) nhồi đầy 2 dòng rồi mới cắt, phần thừa thành block riêng.
 *
 * Nay tham lam chỉ còn để biết SỐ MẢNH ít nhất; chỗ ngắt do balancedSubtitleChunks chọn.
 * Bài này khoá:
 *   1. Câu thật của người dùng: không mảnh nào 1-2 từ, ngắt ở "… hoạt động | dựa trên …".
 *   2. Số mảnh KHÔNG tăng so với tham lam (không đẻ thêm block).
 *   3. Mỗi mảnh vẫn gói vừa tối đa 2 dòng.
 *   4. Ưu tiên ngắt sau dấu câu; không để từ chức năng ("của", "các") treo cuối mảnh.
 *   5. CJK: mảnh không mở đầu bằng dấu câu đóng; một token dài hơn cả dòng vẫn hiện.
 *
 * CÁCH ĐO: rút THẲNG mã thật (splitTextToMaxLines, balancedSubtitleChunks, wrapTokens) ra
 * chạy trong vm; chỉ thay phép đo canvas (magicWrap) bằng thước tất định: mỗi dòng tối đa
 * LINE ký tự, gói theo từ — cùng hợp đồng {lines, width} với magicWrap thật.
 *
 * Chạy: npm run test:subtitle-balanced-split
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'static', 'js', 'editing-runtime.js'), 'utf8');

function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `không thấy hàm ${name}()`);
  const body = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = body; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`không đóng được ${name}()`);
}
function extractConst(name) {
  const start = src.indexOf(`const ${name} =`);
  assert.notStrictEqual(start, -1, `không thấy const ${name}`);
  const end = src.indexOf(';\n', start);
  return src.slice(start, end + 1);
}

let LINE = 30;   // ký tự mỗi dòng của thước giả — đổi theo từng ca
const sandbox = {
  console,
  defaultTextStyle: () => ({ font_size: 56, font_family: 'Oswald', font_weight: 600 }),
  textLetterSpacingPx: () => 0,
  defaultTextWrapWidth: () => 1000,
  /* Thước tất định: gói theo token (giữ đúng dấu cách / CJK như wrapTokens), mỗi dòng ≤ LINE ký tự. */
  magicWrap: (text) => {
    const toks = sandbox.wrapTokens(text);
    const lines = [];
    let cur = '';
    for (const t of toks) {
      const add = cur ? (t.space ? ` ${t.text}` : t.text) : t.text;
      if (cur && Array.from(cur + add).length > LINE) { lines.push(cur); cur = t.text; } else cur += add;
    }
    if (cur) lines.push(cur);
    return { lines: lines.length ? lines : [''], width: 1 };
  },
};
vm.createContext(sandbox);
vm.runInContext([
  extractConst('CJK_CHAR_RE'), extractConst('CJK_NO_LINE_START_RE'),
  extractConst('SUBTITLE_PHRASE_STARTERS'),
  extractFunction('wrapTokens'), extractFunction('balancedSubtitleChunks'), extractFunction('splitTextToMaxLines'),
  'globalThis.api = { wrapTokens, balancedSubtitleChunks, splitTextToMaxLines };',
].join('\n'), sandbox);
// Mảng sinh trong vm thuộc realm khác (deepStrictEqual so cả prototype) -> đưa về mảng thường.
const splitTextToMaxLines = (...args) => Array.from(sandbox.api.splitTextToMaxLines(...args));

/* Bản THAM LAM cũ (trước 2026-10-01) — để so: cùng thước đo, cùng token. */
function greedy(text, limit = 2) {
  const tokens = sandbox.wrapTokens(text);
  const join = (list) => list.map((t, i) => ((i > 0 && t.space) ? ` ${t.text}` : t.text)).join('');
  const chunks = [];
  let cur = [];
  for (const token of tokens) {
    const next = cur.concat(token);
    if (cur.length && sandbox.magicWrap(join(next)).lines.length > limit) { chunks.push(join(cur)); cur = [{ ...token, space: false }]; } else cur = next;
  }
  if (cur.length) chunks.push(join(cur));
  return chunks;
}
const words = (s) => s.trim().split(/\s+/).filter(Boolean);
const fitsTwoLines = (s) => sandbox.magicWrap(s).lines.length <= 2;

let passed = 0;
function ok(m) { passed += 1; console.log(`  ok  ${m}`); }

// ── 1 + 2 + 3. câu thật của người dùng ───────────────────────────────────────
{
  LINE = 32;
  const text = 'Lò phản ứng hạt nhân hoạt động dựa trên nguyên lý phân hạch hạt nhân,';
  const old = greedy(text);
  assert.strictEqual(old.length, 2, `chuẩn bị: tham lam phải ra 2 mảnh (${JSON.stringify(old)})`);
  assert.strictEqual(old[1], 'nhân,', `chuẩn bị: tái hiện đúng lỗi — mảnh 2 là "nhân," (${JSON.stringify(old)})`);
  const now = splitTextToMaxLines(text, 2);
  assert.strictEqual(now.length, old.length, 'KHÔNG đẻ thêm block');
  assert.ok(now.every((c) => words(c).length >= 3), `không mảnh nào 1-2 từ: ${JSON.stringify(now)}`);
  assert.ok(now.every(fitsTwoLines), 'mỗi mảnh vẫn gói vừa 2 dòng');
  assert.deepStrictEqual(now, ['Lò phản ứng hạt nhân hoạt động', 'dựa trên nguyên lý phân hạch hạt nhân,'],
    'ngắt ở ranh giới cụm tự nhiên (trước "dựa trên")');
  assert.strictEqual(now.join(' '), text, 'không mất / lặp chữ nào');
  ok(`câu người dùng báo: ${JSON.stringify(old)} -> ${JSON.stringify(now)}`);
}

// ── 2. trên nhiều câu dài: không bao giờ thêm mảnh, không bao giờ để mảnh 1 từ ──────────
{
  const corpus = [
    'Năng lượng hạt nhân được tạo ra khi hạt nhân nguyên tử nặng như uranium bị phân tách thành các hạt nhỏ hơn và giải phóng một lượng nhiệt rất lớn',
    'Quá trình này tạo ra nhiệt lượng khổng lồ, dùng để đun sôi nước, tạo hơi nước quay tua bin và phát điện cho hàng triệu hộ gia đình',
    'Các nhà khoa học vẫn đang tìm cách xử lý chất thải phóng xạ một cách an toàn trong nhiều nghìn năm tới',
    'Nuclear power plants split heavy atoms to release heat, which boils water and spins turbines that generate electricity for the grid',
  ];
  let checked = 0;
  for (const line of [24, 28, 32, 40]) {
    LINE = line;
    for (const text of corpus) {
      const old = greedy(text);
      const now = splitTextToMaxLines(text, 2);
      assert.strictEqual(now.length, old.length, `LINE ${line}: số mảnh ${now.length} != ${old.length}`);
      assert.ok(now.every(fitsTwoLines), `LINE ${line}: mảnh tràn 2 dòng ${JSON.stringify(now)}`);
      assert.strictEqual(now.join(' '), text, 'không mất chữ');
      if (now.length > 1) assert.ok(now.every((c) => words(c).length >= 2), `LINE ${line}: mảnh mồ côi ${JSON.stringify(now)}`);
      const lens = now.map((c) => c.length);
      if (now.length > 1) {
        // Không đòi cân TUYỆT ĐỐI: thuật toán cố ý đổi chút cân bằng lấy chỗ ngắt đúng cụm.
        // Thứ phải canh là MẢNH CỤT — mảnh ngắn nhất không dưới 45% độ dài trung bình.
        const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
        assert.ok(Math.min(...lens) >= 0.45 * avg, `LINE ${line}: mảnh cụt ${lens} (tham lam: ${old.map((c) => c.length)})`);
      }
      checked += 1;
    }
  }
  ok(`${checked} ca (4 câu × 4 bề rộng): số mảnh = tham lam, vừa 2 dòng, không mảnh 1 từ, không mảnh cụt`);
}

// ── 4. dấu câu + từ chức năng ─────────────────────────────────────────────────
{
  const sentence = 'Năng lượng sạch, rẻ và an toàn, là mục tiêu chung của nhiều quốc gia trên thế giới hiện nay';
  for (const line of [34, 38, 44]) {
    // Tham lam ở các bề rộng này: cắt giữa "thế | giới", hoặc để "nay" mồ côi.
    LINE = line;
    const comma = splitTextToMaxLines(sentence, 2);
    assert.deepStrictEqual(comma, ['Năng lượng sạch, rẻ và an toàn,', 'là mục tiêu chung của nhiều quốc gia trên thế giới hiện nay'],
      `LINE ${line}: ngắt sau dấu phẩy khi mảnh sau vẫn vừa 2 dòng (${JSON.stringify(comma)})`);
  }
  LINE = 30;   // tham lam: "… mục tiêu chung của" | "nhiều quốc gia …"
  const noDangle = splitTextToMaxLines(sentence, 2);
  assert.ok(!/của$/.test(noDangle[0]), `"của" không được treo cuối mảnh: ${JSON.stringify(noDangle)}`);
  LINE = 26;
  for (const t of [
    'Đây là bước quan trọng nhất của toàn bộ quá trình sản xuất điện năng từ nhiên liệu hạt nhân',
    'Người ta kiểm soát tốc độ phản ứng bằng các thanh điều khiển hấp thụ neutron dư thừa trong lò',
  ]) {
    const out = splitTextToMaxLines(t, 2);
    const dangling = out.slice(0, -1).filter((c) => /\s(của|các|những|và|để|với|trong)$/.test(c));
    assert.deepStrictEqual(dangling, [], `từ chức năng treo cuối mảnh: ${JSON.stringify(out)}`);
  }
  ok('ngắt sau dấu phẩy khi có; không để "của/các/và…" treo cuối mảnh');
}

// ── 5. CJK + token quá dài ───────────────────────────────────────────────────
{
  LINE = 12;
  const zh = '核反应堆利用重原子核的裂变释放出大量的热能，这些热能用来把水加热成蒸汽并推动涡轮机发电。';
  const out = splitTextToMaxLines(zh, 2);
  assert.strictEqual(out.join(''), zh, 'CJK: nối lại KHÔNG chèn dấu cách');
  assert.ok(out.every((c) => !/^[，。！？、；：]/.test(c)), `CJK: mảnh mở đầu bằng dấu câu đóng ${JSON.stringify(out)}`);
  assert.ok(out.every(fitsTwoLines), 'CJK: vừa 2 dòng');
  LINE = 10;
  const url = 'Xem https://example.com/mot-duong-dan-rat-dai-khong-the-ngat de biet them chi tiet ve du an nay';
  const u = splitTextToMaxLines(url, 2);
  assert.ok(u.some((c) => c.includes('https://example.com/mot-duong-dan-rat-dai-khong-the-ngat')), 'token dài hơn dòng vẫn còn nguyên');
  assert.strictEqual(u.join(' '), url);
  LINE = 40;
  assert.deepStrictEqual(splitTextToMaxLines('Câu ngắn vừa một block', 2), ['Câu ngắn vừa một block'], 'câu ngắn: nguyên văn một mảnh');
  ok('CJK không mở đầu bằng dấu câu đóng, không chèn dấu cách; URL dài vẫn hiện; câu ngắn giữ nguyên');
}

console.log(`subtitle balanced split ok (${passed} nhóm)`);
