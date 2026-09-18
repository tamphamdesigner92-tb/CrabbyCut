/* =====================================================================
 * LỚP HỢP THÀNH CỦA PREVIEW KHÔNG ĐƯỢC ĂN CSS TRANG TRÍ CỦA PANEL
 *
 * LỖI ĐÃ TRẢ GIÁ (người dùng báo 2026-09-09): "khung transform của các video không fit vừa
 * kích thước của video mà có một nền màu đen. Nhưng khi render ra thì không bị lỗi này."
 *
 * NGUYÊN NHÂN. index.html có một luật làm đẹp cho thẻ <video> trong panel:
 *     video:not(#previewVideo) { max-width:100%; max-height:100%; background:#000;
 *                               border-radius:var(--r-md); box-shadow:var(--sh-3) }
 * Nó khớp LUÔN phần tử <video> của overlay lane phụ trong preview. `.editing-preview-item`
 * đã khai `max-width/max-height: none` để thoát ra nhưng KHÔNG THẮNG: `:not(#previewVideo)`
 * mang trọng số của một ID, nên `video:not(#previewVideo)` là (1,0,1) còn
 * `.editing-preview-item` chỉ (0,1,0).
 *
 * ĐO ĐƯỢC TRONG CHROMIUM (sequence 1728x3072, overlay 6.mp4 1920x1080 @ scale 100%):
 *     el.style.width = 208.889px  ->  getComputedStyle().width = 188px   (= bề rộng khung)
 *     tỉ lệ hộp 1.6000  vs  tỉ lệ video 1.7778
 *     background rgb(0,0,0), border-radius 8px, box-shadow có
 * Bề rộng bị `max-width:100%` kẹp -> tỉ lệ hộp lệch khỏi tỉ lệ video -> `object-fit: contain`
 * letterbox -> `background:#000` của chính luật đó tô đen phần lệch. Bản render đúng vì
 * ffmpeg không có max-width nào.
 * Chỉ lộ khi asset RỘNG HƠN sequence (1920 > 1728) — hoặc CAO HƠN, do `max-height`.
 *
 * TEST NÀY CHỐT HAI LỚP CỦA BẢN SỬA (tĩnh, không cần ffmpeg/trình duyệt):
 *   1. Mọi luật trong index.html nhắm vào thẻ video/img mà đặt thuộc tính TRANG TRÍ đều
 *      phải loại trừ .editing-preview-item — thêm một luật trang trí mới mà quên loại trừ
 *      là lỗi quay lại y như cũ.
 *   2. .editing-preview-item tự khai lại các giá trị trung tính (lớp chốt thứ hai).
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const runtimeJs = fs.readFileSync(path.join(projectRoot, 'static', 'js', 'editing-runtime.js'), 'utf8');

/* Thuộc tính mà một lớp hợp thành KHÔNG được nhận từ CSS chung: mỗi cái là một thứ preview
 * có mà bản xuất không có. `max-width/max-height` là hai cái đã gây ra lỗi (kẹp hộp), còn
 * lại là trang trí thuần. */
const DECORATIVE = [
  'max-width', 'max-height', 'background', 'background-color',
  'box-shadow', 'border-radius', 'border', 'filter', 'outline',
];

// Cắt CSS thành các luật { selector, body } — bỏ qua chú thích và chịu được @media lồng.
function cssRules(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    const selector = text.slice(i, open).trim();
    const body = text.slice(open + 1, j - 1);
    // @media/@supports: đi vào trong thay vì coi cả khối là một luật.
    if (selector.startsWith('@')) {
      rules.push(...cssRules(body));
    } else if (selector) {
      rules.push({ selector, body });
    }
    i = j;
  }
  return rules;
}

function styleBlocks(html) {
  const out = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function declaredProps(body) {
  return DECORATIVE.filter((prop) => new RegExp(`(^|;|\\s)${prop}\\s*:`, 'i').test(body));
}

/* Luật có nhắm vào THẺ video/img "trần" không? (tức không neo bằng class/id nào của riêng
 * nó, nên nó quét mọi thẻ video/img — kể cả lớp hợp thành của preview.) */
function targetsBareMediaTag(selector) {
  return selector.split(',').some((part) => {
    const compound = part.trim();
    if (!/(^|[\s>+~])(video|img)(?![\w-])/i.test(compound)) return false;
    // Bỏ `:not(...)` ra trước khi tìm class/id neo: `video:not(#x)` vẫn là selector TRẦN.
    const withoutNot = compound.replace(/:not\([^)]*\)/gi, '');
    return !/[.#]/.test(withoutNot);
  });
}

const EXEMPT = ['.editing-preview-item', '.editing-preview-src'];

const offenders = [];
for (const block of styleBlocks(indexHtml)) {
  for (const rule of cssRules(block)) {
    if (!targetsBareMediaTag(rule.selector)) continue;
    const props = declaredProps(rule.body);
    if (!props.length) continue;
    const exempted = EXEMPT.every((cls) => rule.selector.includes(`:not(${cls})`));
    if (!exempted) offenders.push({ selector: rule.selector, props });
  }
}

assert.strictEqual(offenders.length, 0,
  'Luật CSS chung cho thẻ video/img đặt thuộc tính trang trí mà KHÔNG loại trừ lớp hợp thành '
  + `của preview (${EXEMPT.join(', ')}):\n`
  + offenders.map((o) => `    ${o.selector}\n      -> ${o.props.join(', ')}`).join('\n')
  + '\n  Thêm :not(.editing-preview-item):not(.editing-preview-src) vào selector đó.');
console.log('  ok  không luật video/img chung nào chạm vào lớp hợp thành của preview');

/* LỚP CHỐT THỨ HAI: .editing-preview-item tự khai lại giá trị trung tính.
 * Lấy ĐÚNG khối đó bằng cách dò dấu ngoặc, KHÔNG chạy cssRules trên cả tệp: CSS ở đây nằm
 * trong một template literal giữa hàng nghìn dòng JS, nên mọi `{}` của JS cũng thành "luật". */
function ruleBodyAt(source, selector) {
  const marker = `${selector} {`;
  const at = source.indexOf(marker);
  if (at < 0) return null;
  const open = at + marker.length - 1;
  let depth = 1;
  let j = open + 1;
  while (j < source.length && depth > 0) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}') depth -= 1;
    j += 1;
  }
  return { selector, body: source.slice(open + 1, j - 1) };
}

const previewItemRule = ruleBodyAt(runtimeJs, '.editing-preview-item');
assert.ok(previewItemRule, 'không tìm thấy luật .editing-preview-item trong editing-runtime.js');
const NEUTRAL = {
  'max-width': 'none',
  'max-height': 'none',
  'background': 'transparent',
  'box-shadow': 'none',
  'border-radius': '0',
};
for (const [prop, want] of Object.entries(NEUTRAL)) {
  const m = previewItemRule.body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`, 'i'));
  assert.ok(m, `.editing-preview-item phải khai ${prop} (mong ${want})`);
  assert.strictEqual(m[1].trim().replace(/px$/, ''), want,
    `.editing-preview-item: ${prop} phải là ${want}, đang là ${m[1].trim()}`);
}
console.log('  ok  .editing-preview-item khai lại đủ 5 giá trị trung tính');

/* CSS của editing-runtime nằm trong TEMPLATE LITERAL của JS -> một dấu backtick lọt vào chú
 * thích là đóng chuỗi giữa đường và cả tệp chết ở runtime (đã mắc đúng lỗi này khi viết bản
 * sửa trên: "ReferenceError: preview is not defined"). node --check bắt được ca nặng, nhưng
 * ca nhẹ thì tệp vẫn parse được mà chạy sai — nên chốt thẳng ở đây. */
const cssLiteralStart = runtimeJs.indexOf('.editing-preview-item {');
assert.ok(cssLiteralStart > 0, 'không định vị được khối CSS của preview');
const around = runtimeJs.slice(Math.max(0, cssLiteralStart - 3000), cssLiteralStart);
const lastComment = around.lastIndexOf('/*');
if (lastComment >= 0) {
  assert.ok(!around.slice(lastComment).includes('`'),
    'chú thích ngay trên .editing-preview-item có dấu backtick — nó đóng template literal '
    + 'chứa CSS và làm editing-runtime.js chết ở runtime');
}
console.log('  ok  chú thích của khối CSS không chứa backtick');

console.log('preview overlay css contract ok');
