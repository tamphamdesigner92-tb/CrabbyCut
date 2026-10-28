// Xuất ảnh social preview và banner từ docs/brand/brand-assets.html ra PNG.
// Chạy: node docs/brand/render.js  (cần Playwright + Chromium)
const path = require('path');
const { chromium } = require('playwright');

const SRC = path.join(__dirname, 'brand-assets.html');
const OUT = __dirname;
const ASSETS = [
  { id: 'preview', file: 'social-preview-1280x640.png', w: 1280, h: 640 },
  { id: 'banner', file: 'banner-1500x500.png', w: 1500, h: 500 },
  { id: 'youtube', file: 'banner-youtube-2560x1440.png', w: 2560, h: 1440 },
];

(async () => {
  const browser = await chromium.launch();
  for (const a of ASSETS) {
    const page = await browser.newPage({ viewport: { width: a.w, height: a.h } });
    await page.goto('file://' + SRC + '?v=' + a.id);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('#' + a.id).screenshot({ path: path.join(OUT, a.file) });
    await page.close();
    console.log('OK', a.file);
  }
  await browser.close();
})();
