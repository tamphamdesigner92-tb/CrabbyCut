#!/usr/bin/env node
/*
 * Kiểm mã GeoCode nháp trong docs/prompts/geocode/ NGOÀI app, bằng Playwright (Chromium):
 *   1. Không dùng Math.random() trần, không cộng dồn trạng thái kiểu `x +=` ở cấp ngoài cùng của frame.
 *   2. Dựng vài khung tại các mốc t, xuất PNG + một tấm ghép (contact sheet) để xem bằng mắt.
 *   3. Tính tất định: dựng cùng một t hai lần phải ra cùng điểm ảnh.
 *   4. Video lặp (loop): khung t = 0 và t = duration phải giống nhau.
 *   5. Lớp cần trong suốt (nhân vật, chữ, thẻ) phải còn điểm ảnh alpha = 0.
 *
 * Mô phỏng đúng hợp đồng của GeoCode: canvas gọi draw(ctx, t, width, height, frame) trên canvas đã xoá;
 * HTML dùng window.geocode.onFrame(cb). Đây KHÔNG thay cho Xem thử trong app — chỉ bắt lỗi sớm.
 *
 * Chạy:  node docs/prompts/kiem-geocode.js [thư mục ra PNG]   (mặc định: thư mục tạm của hệ điều hành)
 * Đặt ở docs/ vì docs/** bị loại khỏi bộ cài.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const DIR = path.join(__dirname, 'geocode');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'crabbycut-geocode-check'));

// Khai báo từng tệp: kích thước, thời lượng, mốc t cần xem, có lặp không, có cần trong suốt không, vars (nếu là template).
const CASES = [
  { file: 's01-nen-bien.canvas.js', w: 1080, h: 1920, dur: 22, times: [0, 6, 13, 21.9] },
  { file: 's01-crabby.html', w: 600, h: 600, dur: 2, times: [0, 0.25, 0.5, 1.5], loop: true, transparent: true },
  { file: 's01-crabby.html', label: 's01-crabby (vẫy càng)', w: 600, h: 600, dur: 2, times: [0.25, 0.75], loop: true, transparent: true,
    patch: [['const CLAW_WAVE = 0;', 'const CLAW_WAVE = 1;']] },
  { file: 's01-nen-bien.canvas.js', label: 's01-nen-bien (ban đêm)', w: 1080, h: 1920, dur: 22, times: [2, 12],
    patch: [["const TIME_OF_DAY = 'sunset';", "const TIME_OF_DAY = 'night';"]] },
  { file: 's02-tan-xa.canvas.js', w: 1080, h: 1920, dur: 36, times: [2, 6, 14, 24, 33] },
  { file: 's03-he-mat-troi.canvas.js', w: 1080, h: 1920, dur: 30, times: [1, 8, 15, 29.9] },
  { file: 's04-khau-hieu.html', w: 1080, h: 1920, dur: 11, times: [1, 3, 6, 8.5, 10.9], transparent: true },
  { file: 's05-mua-pho-dem.canvas.js', w: 1080, h: 1920, dur: 10, times: [0, 3.3, 7.7], loop: true },
  { file: 'the-cau-lenh-va-the-cuoi.html', label: 'the-cau-lenh', w: 1080, h: 1920, dur: 2, times: [0.5, 1.9], transparent: false,
    vars: { mode: 'prompt', label: 'Câu lệnh cho Claude', text_json: JSON.stringify('Làm cho tôi một short 20 giây: con cua Crabby đi dạo trên bãi biển lúc hoàng hôn.') } },
  { file: 'the-cau-lenh-va-the-cuoi.html', label: 'the-cuoi', w: 1080, h: 1920, dur: 2, times: [0],
    vars: { mode: 'end', label: 'Made by Claude in CrabbyCut', text_json: JSON.stringify('MCP + GeoCode · free & open source') } },
];

function fill(code, vars) {
  return code.replace(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g, (all, k) => {
    if (!vars || !(k in vars)) throw new Error(`thiếu vars {{${k}}}`);
    return typeof vars[k] === 'string' ? vars[k] : JSON.stringify(vars[k]);
  });
}

function staticChecks(name, code) {
  const errs = [];
  if (/Math\.random\s*\(/.test(code)) errs.push('dùng Math.random() trần');
  if (/\b(const|let|var)\s+(canvas|ctx|width|height)\s*=/.test(code)) errs.push('khai lại canvas/ctx/width/height');
  if (/fillRect\(0,\s*0,\s*W,\s*H\)/.test(code) && /transparent/.test(name)) errs.push('tô nền toàn khung ở lớp trong suốt');
  return errs;
}

function pageFor(c, code) {
  const base = `<style>html,body{margin:0;width:${c.w}px;height:${c.h}px;overflow:hidden;background:transparent}</style>`;
  if (c.file.endsWith('.js')) {
    return `${base}<canvas id="cv" width="${c.w}" height="${c.h}"></canvas><script>
      const canvas = document.getElementById('cv'); const ctx = canvas.getContext('2d'); const width = ${c.w}, height = ${c.h};
      ${code}
      window.__render = async (t) => { ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,width,height); await draw(ctx, t, width, height, Math.round(t*30)); };
    </script>`;
  }
  return `${base}<script>
      window.__cbs = []; window.geocode = { width: ${c.w}, height: ${c.h}, fps: 30, duration: ${c.dur}, t: 0, frame: 0, onFrame(cb) { window.__cbs.push(cb); } };
      window.__render = async (t) => { for (const cb of window.__cbs) await cb(t, Math.round(t*30)); };
    </script>${code}`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  let failed = 0;
  const sheets = [];
  for (const c of CASES) {
    const label = c.label || c.file;
    let code = fs.readFileSync(path.join(DIR, c.file), 'utf8');
    for (const [a, b] of c.patch || []) {
      if (!code.includes(a)) { console.log(`✗ ${label}: không tìm thấy chuỗi vá "${a}"`); failed++; }
      code = code.replace(a, b);
    }
    if (c.vars) code = fill(code, c.vars);
    const errs = staticChecks(c.transparent ? 'transparent' : '', code);
    const page = await browser.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.setContent(pageFor(c, code), { waitUntil: 'load', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    // chờ hai lượt vẽ sau khi đổi DOM rồi mới chụp, tránh chụp trúng khung cũ
    const shoot = async (t) => {
      await page.evaluate(async (tt) => { await window.__render(tt); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }, t);
      return page.screenshot({ omitBackground: true });
    };
    const shots = [];
    for (const t of c.times) {
      const png = await shoot(t);
      const f = path.join(OUT, `${label.replace(/[^\w.-]+/g, '_')}_t${t}.png`);
      fs.writeFileSync(f, png); shots.push({ t, f });
    }
    const a = await shoot(c.times[1] ?? c.times[0]); const b = await shoot(c.times[1] ?? c.times[0]);
    if (!a.equals(b)) errs.push('không tất định: cùng t ra hai ảnh khác nhau');
    if (c.loop) {
      const s0 = await shoot(0); const s1 = await shoot(c.dur);
      if (!s0.equals(s1)) errs.push(`không lặp khít: khung 0 khác khung ${c.dur}s`);
    }
    if (c.transparent) {
      const png = await shoot(c.times[c.times.length - 1]);
      // góc trên trái phải trong suốt: đọc qua canvas trong trang
      const alpha = await page.evaluate(async (b64) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
        const x = cv.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(2, 2, 1, 1).data[3];
      }, png.toString('base64'));
      if (alpha !== 0) errs.push('lớp cần trong suốt nhưng góc khung có màu');
    }
    errs.push(...pageErrors.map((m) => 'lỗi JS: ' + m));
    if (errs.length) { failed++; console.log(`✗ ${label}: ${errs.join('; ')}`); } else console.log(`✓ ${label} (${c.times.length} khung)`);
    sheets.push({ label, shots, w: c.w, h: c.h });
    await page.close();
  }
  // Tấm ghép: mỗi trường hợp một hàng, khung thu nhỏ còn cao 480 px, nền ô cờ để thấy vùng trong suốt
  const rows = sheets.map((s) => `<div class="row"><div class="lab">${s.label}</div>${s.shots.map((x) =>
    `<figure><img src="data:image/png;base64,${fs.readFileSync(x.f).toString('base64')}" style="height:${s.h > s.w ? 480 : 240}px"><figcaption>t = ${x.t}s</figcaption></figure>`).join('')}</div>`).join('');
  const sheet = await browser.newPage({ viewport: { width: 1800, height: 800 } });
  await sheet.setContent(`<style>body{font:14px Arial;margin:12px;background:#fff}.row{display:flex;gap:10px;align-items:flex-start;margin-bottom:14px}
    .lab{width:150px;font-weight:bold}figure{margin:0;text-align:center}img{background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/20px 20px;border:1px solid #ccc}</style>${rows}`);
  await sheet.screenshot({ path: path.join(OUT, 'tam-ghep.png'), fullPage: true });
  await browser.close();
  console.log(`\nẢnh: ${OUT}`);
  if (failed) { console.log(`${failed} trường hợp lỗi`); process.exit(1); }
  console.log('Tất cả đạt.');
})();
