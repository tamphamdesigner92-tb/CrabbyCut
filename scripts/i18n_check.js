#!/usr/bin/env node
/**
 * KIỂM ĐỘ PHỦ BẢN DỊCH (docs/I18N.md)
 * ===================================
 *   node scripts/i18n_check.js              -> báo khoá thiếu bản dịch en/zh (exit 1 nếu thiếu)
 *   node scripts/i18n_check.js --unused     -> thêm danh sách khoá trong từ điển không còn dùng
 *   node scripts/i18n_check.js --scan FILE… -> liệt kê dòng còn chuỗi tiếng Việt CHƯA bọc _t()
 *                                              (dò gợi ý, có thể có báo nhầm: log, regex…)
 *   node scripts/i18n_check.js --missing-json OUT -> ghi các khoá thiếu ra OUT (mảng JSON)
 *
 * Nguồn khoá:
 *   - mọi lời gọi `_t('…')` / `_t("…")` / _t(`…`) (không có ${}) trong .js/.html đã liệt kê;
 *   - markup tĩnh của index.html + electron/setup.html: text node và title/placeholder/
 *     aria-label/alt, phần tử `data-i18n-html` lấy nguyên innerHTML, bỏ `data-i18n-skip`.
 * Chỉ tính khoá có ít nhất một chữ cái (bỏ "×", "30 fps"… vì không cần dịch — số và ký hiệu).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const I18n = require(path.join(ROOT, 'static', 'js', 'i18n.js'));
const LOCALES = ['en', 'zh'];

const JS_DIRS = ['static/js', 'electron', 'backend'];
const HTML_FILES = ['index.html', 'electron/setup.html'];
const SKIP_JS = new Set(['static/js/i18n.js']);

const VN_RE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

function listSources() {
    const files = [];
    JS_DIRS.forEach((dir) => {
        fs.readdirSync(path.join(ROOT, dir)).forEach((name) => {
            const p = path.join(ROOT, dir, name);
            if (/\.(js|html)$/.test(name) && fs.statSync(p).isFile() && !SKIP_JS.has(rel(p))) files.push(p);
        });
    });
    HTML_FILES.forEach((f) => { if (!files.includes(path.join(ROOT, f))) files.push(path.join(ROOT, f)); });
    return files;
}

/* ---- lời gọi _t(...) ---- */
function unescapeJs(body, quote) {
    // Đủ cho chuỗi giao diện: \n, \t, \\, \', \", \`, \uXXXX.
    return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m, c) => {
        if (c[0] === 'u') return String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ''), 16));
        if (c[0] === 'x' && c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16));
        return { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`' }[c] ?? (c === quote ? c : c);
    });
}

function extractCalls(text, file, keys, problems) {
    const re = /(?<![\w$.])(?:I18n\.t|_t)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = re.exec(text))) {
        const [, quote, body] = m;
        const line = text.slice(0, m.index).split('\n').length;
        if (quote === '`' && body.includes('${')) {
            problems.push(`${file}:${line}: _t() với template có \${…} — dùng tham số {tên}`);
            continue;
        }
        const key = I18n.normKey(unescapeJs(body, quote));
        if (!/\p{L}/u.test(key)) continue;
        if (!keys.has(key)) keys.set(key, `${file}:${line}`);
    }
}

/* ---- markup tĩnh ---- */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'label'];

function decodeEntities(s) {
    return s.replace(/&(amp|lt|gt|quot|#39|nbsp|apos);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }[e]));
}

function extractMarkup(html, file, keys) {
    // Bỏ nội dung <script>/<style>/chú thích, giữ nguyên độ dài dòng để số dòng còn đúng.
    const blank = (s) => s.replace(/[^\n]/g, ' ');
    const src = html
        .replace(/<!--[\s\S]*?-->/g, blank)
        .replace(/<![^>]*>/g, blank)
        .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, a, b, c) => a + blank(b) + c)
        .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, b, c) => a + blank(b) + c);
    const tokenRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
    const stack = [];   // { tag, skip, htmlStart }
    let m;
    const add = (raw, at) => {
        const key = I18n.normKey(decodeEntities(raw));
        if (!key || !/\p{L}/u.test(key)) return;
        if (!keys.has(key)) keys.set(key, `${file}:${src.slice(0, at).split('\n').length}`);
    };
    while ((m = tokenRe.exec(src))) {
        const [whole, close, tagRaw, attrs, selfClose, text] = m;
        const skipping = stack.some((s) => s.skip || s.html);
        if (text !== undefined) {
            if (!skipping && !stack.some((s) => s.tag === 'script' || s.tag === 'style')) add(text, m.index);
            continue;
        }
        const tag = tagRaw.toLowerCase();
        if (close) {
            for (let i = stack.length - 1; i >= 0; i -= 1) {
                if (stack[i].tag !== tag) continue;
                const entry = stack[i];
                stack.length = i;
                if (entry.html && !stack.some((s) => s.skip || s.html)) {
                    add(html.slice(entry.htmlStart, m.index), entry.htmlStart);
                }
                break;
            }
            continue;
        }
        if (!skipping) {
            ATTRS.forEach((a) => {
                const am = new RegExp(`\\s${a}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
                if (am) add(am[2] ?? am[3], m.index);
            });
        }
        if (VOID.has(tag) || selfClose) continue;
        stack.push({
            tag,
            skip: /\sdata-i18n-skip\b/.test(attrs),
            html: /\sdata-i18n-html\b/.test(attrs),
            htmlStart: m.index + whole.length,
        });
    }
}

function collectKeys() {
    const keys = new Map();
    const problems = [];
    listSources().forEach((p) => {
        const text = fs.readFileSync(p, 'utf8');
        extractCalls(text, rel(p), keys, problems);
        if (HTML_FILES.includes(rel(p))) extractMarkup(text, rel(p), keys);
    });
    // Tên preset LUT có sẵn: backend dịch bằng _t(p.name) khi trả /api/color-luts.
    try {
        const presetsFile = 'library/luts/presets.json';
        JSON.parse(fs.readFileSync(path.join(ROOT, presetsFile), 'utf8')).forEach((p) => {
            const key = I18n.normKey(p && p.name);
            if (key && /\p{L}/u.test(key) && !keys.has(key)) keys.set(key, presetsFile);
        });
    } catch (_) { /* không có thư viện LUT thì thôi */ }
    return { keys, problems };
}

function loadDict(loc) {
    const p = path.join(ROOT, 'static', 'i18n', `${loc}.json`);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const map = new Map();
    Object.keys(raw).forEach((k) => { if (!k.startsWith('//')) map.set(I18n.normKey(k), raw[k]); });
    return map;
}

/* ---- --scan: chuỗi tiếng Việt chưa bọc ---- */
function scan(files) {
    let total = 0;
    files.forEach((f) => {
        const lines = fs.readFileSync(path.resolve(ROOT, f), 'utf8').split('\n');
        let inBlock = false;
        lines.forEach((line, i) => {
            let s = line;
            if (inBlock) {
                const end = s.indexOf('*/');
                if (end < 0) return;
                s = s.slice(end + 2);
                inBlock = false;
            }
            s = s.replace(/\/\*[\s\S]*?\*\//g, '');
            const open = s.indexOf('/*');
            if (open >= 0) { inBlock = true; s = s.slice(0, open); }
            if (/^\s*(\/\/|\*|<!--)/.test(s)) return;
            s = s.replace(/(^|[^:'"`\\])\/\/.*$/, '$1');
            // Bỏ phần đã nằm trong _t(…) đơn giản.
            const stripped = s.replace(/_t\(\s*(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '');
            const lit = stripped.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) || [];
            // Markup tĩnh của .html thì translateDom lo — chỉ dò chuỗi trong code.
            const bad = lit.filter((x) => VN_RE.test(x));
            if (bad.length) {
                total += 1;
                console.log(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
            }
        });
    });
    console.log(`\n${total} dòng còn chuỗi tiếng Việt ngoài _t().`);
}

function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--scan') return scan(args.slice(1));
    const { keys, problems } = collectKeys();
    let missingTotal = 0;
    const missingAll = new Set();
    LOCALES.forEach((loc) => {
        const dict = loadDict(loc);
        const missing = [...keys.keys()].filter((k) => !dict.has(k));
        missing.forEach((k) => missingAll.add(k));
        missingTotal += missing.length;
        console.log(`[${loc}] ${keys.size - missing.length}/${keys.size} khoá có bản dịch`);
        missing.slice(0, 40).forEach((k) => console.log(`   thiếu: ${JSON.stringify(k)}  (${keys.get(k)})`));
        if (missing.length > 40) console.log(`   … và ${missing.length - 40} khoá nữa`);
        if (args.includes('--unused')) {
            const unused = [...dict.keys()].filter((k) => !keys.has(k));
            console.log(`   ${unused.length} khoá thừa trong ${loc}.json`);
            unused.forEach((k) => console.log(`   thừa: ${JSON.stringify(k)}`));
        }
    });
    const outIdx = args.indexOf('--missing-json');
    if (outIdx >= 0) {
        fs.writeFileSync(args[outIdx + 1], JSON.stringify([...missingAll].map((k) => ({ key: k, at: keys.get(k) })), null, 2));
    }
    problems.forEach((p) => console.log(`LỖI: ${p}`));
    if (missingTotal || problems.length) process.exitCode = 1;
}

main();
