/* Phần chạy TRONG Electron của tests/scripts/geocode_render.js — xem chú thích ở tệp đó.
 * Ghi kết quả từng mục ra stdout dạng "ok ..." / "FAIL ..." rồi thoát với mã 0/1. */
const { app, nativeImage } = require('electron');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

app.on('window-all-closed', () => { /* test không có cửa sổ chính — đừng tự thoát */ });

const GeoCode = require(path.join(__dirname, '..', '..', 'electron', 'geocode-renderer.js'));
const { frameName } = require(path.join(__dirname, '..', '..', 'scripts', 'geocode_cache.js'));

function pixels(file) {
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();   // BGRA (nhân trước alpha — chỉ đọc pixel đục hoặc alpha 0)
  return {
    width,
    height,
    at(x, y) { const i = (y * width + x) * 4; return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i], a: bmp[i + 3] }; },
    raw: bmp,
  };
}

const near = (a, b, tol = 6) => Math.abs(a - b) <= tol;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`ok  ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error && error.stack || error}`);
  }
}

const ANIM_HTML = `<style>
  #box { position:absolute; left:0; top:50px; width:50px; height:100px; background:#ff0000; animation: move 2s linear forwards; }
  @keyframes move { from { left: 0px } to { left: 400px } }
</style><div id="box"></div>`;

app.whenReady().then(async () => {
  await check('ảnh tĩnh HTML 450×200: đúng cỡ, góc trong suốt, nội dung đúng màu', async () => {
    const r = await GeoCode.render({ lang: 'html', kind: 'image', width: 450, height: 200,
      code: '<div style="position:absolute;left:100px;top:50px;width:250px;height:100px;background:#2050f0;border-radius:20px"></div>' });
    assert.strictEqual(r.frame_count, 1);
    const p = pixels(path.join(r.dir, frameName(0)));
    assert.deepStrictEqual([p.width, p.height], [450, 200], 'khung phải đúng 450×200 (không nhân HiDPI, không bị kẹp)');
    assert.strictEqual(p.at(0, 0).a, 0, 'góc ngoài nút phải trong suốt (alpha = 0)');
    assert.strictEqual(p.at(449, 199).a, 0);
    const c = p.at(225, 100);
    assert.ok(near(c.r, 0x20) && near(c.g, 0x50) && near(c.b, 0xf0) && c.a === 255, `giữa nút phải là #2050f0, thấy ${JSON.stringify(c)}`);
    const again = await GeoCode.render({ lang: 'html', kind: 'image', width: 450, height: 200,
      code: '<div style="position:absolute;left:100px;top:50px;width:250px;height:100px;background:#2050f0;border-radius:20px"></div>' });
    assert.strictEqual(again.cached, true, 'cùng mã + cùng cỡ phải lấy lại từ cache');
  });

  let firstAnim = null;
  await check('CSS animation 2 s @30fps: đúng 60 khung, vị trí theo đồng hồ ảo', async () => {
    const r = await GeoCode.render({ lang: 'html', kind: 'video', width: 450, height: 200, fps: 30, duration: 2, code: ANIM_HTML });
    assert.strictEqual(r.frame_count, 60);
    assert.ok(fs.existsSync(path.join(r.dir, frameName(59))) && !fs.existsSync(path.join(r.dir, frameName(60))), 'phải đúng 60 tệp khung');
    const p0 = pixels(path.join(r.dir, frameName(0)));
    assert.deepStrictEqual([p0.width, p0.height], [450, 200]);
    assert.strictEqual(p0.at(25, 100).a, 255, 'khung 0: hộp đỏ ở x 0..50');
    const p30 = pixels(path.join(r.dir, frameName(30)));
    assert.strictEqual(p30.at(25, 100).a, 0, 'khung 30 (t=1 s): hộp đã rời mép trái');
    assert.ok(p30.at(225, 100).a === 255 && p30.at(225, 100).r > 200, 'khung 30 (t=1 s): hộp ở x 200..250 — đúng nửa đường');
    assert.strictEqual(p30.at(195, 100).a, 0);
    firstAnim = Buffer.from(p30.raw);
  });

  await check('đồng hồ ảo: hai lần dựng ra khung t=1 s giống hệt nhau', async () => {
    const r1 = GeoCode.cacheInfo({ lang: 'html', kind: 'video', width: 450, height: 200, fps: 30, duration: 2, code: ANIM_HTML });
    fs.rmSync(r1.dir, { recursive: true, force: true });
    const r = await GeoCode.render({ lang: 'html', kind: 'video', width: 450, height: 200, fps: 30, duration: 2, code: ANIM_HTML });
    assert.strictEqual(r.cached, false, 'đã xoá cache thì phải dựng lại');
    const p30 = pixels(path.join(r.dir, frameName(30)));
    assert.ok(firstAnim && Buffer.compare(firstAnim, p30.raw) === 0, 'khung t=1 s phải trùng từng byte giữa hai lần dựng');
  });

  await check('setTimeout / requestAnimationFrame / performance.now chạy theo giờ ảo', async () => {
    const code = `<div id="d" style="position:absolute;inset:0;background:#000"></div><script>
      setTimeout(() => { document.getElementById('d').style.background = '#00ff00'; }, 500);
      function loop(ts) { document.title = String(ts); requestAnimationFrame(loop); }
      requestAnimationFrame(loop);
    </script>`;
    const r = await GeoCode.render({ lang: 'html', kind: 'video', width: 64, height: 64, fps: 10, duration: 1, code });
    assert.ok(pixels(path.join(r.dir, frameName(4))).at(32, 32).g < 20, 'khung 4 (0,4 s): chưa tới hẹn 500 ms');
    assert.ok(pixels(path.join(r.dir, frameName(5))).at(32, 32).g > 200, 'khung 5 (0,5 s): hẹn 500 ms đã chạy');
  });

  await check('JavaScript canvas: draw(ctx, t, …) được gọi mỗi khung, canvas xoá trước', async () => {
    const code = `function draw(ctx, t, w, h) { ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.round(t * 100), 0, 10, h); }`;
    const r = await GeoCode.render({ lang: 'canvas', kind: 'video', width: 200, height: 20, fps: 10, duration: 1, code });
    const p = pixels(path.join(r.dir, frameName(5)));   // t = 0,5 s -> vạch ở x 50..60
    assert.strictEqual(p.at(55, 10).a, 255);
    assert.strictEqual(p.at(5, 10).a, 0, 'vạch của khung trước phải bị xoá');
  });

  await check('nền màu: bg = #rrggbb phủ kín khung', async () => {
    const r = await GeoCode.render({ lang: 'html', kind: 'image', width: 32, height: 32, bg: '#123456', code: '<span></span>' });
    const c = pixels(path.join(r.dir, frameName(0))).at(1, 1);
    assert.ok(c.a === 255 && near(c.r, 0x12) && near(c.g, 0x34) && near(c.b, 0x56), JSON.stringify(c));
  });

  await check('khung > 1280 px: có bản proxy nhỏ cho preview', async () => {
    const r = await GeoCode.render({ lang: 'html', kind: 'image', width: 1600, height: 200, code: '<div style="width:100%;height:100%;background:#f80"></div>' });
    assert.deepStrictEqual(r.proxy, { width: 1280, height: 160 });
    const p = pixels(path.join(r.dir, 'proxy', frameName(0)));
    assert.deepStrictEqual([p.width, p.height], [1280, 160]);
  });

  await check('cỡ lớn hơn màn hình (3840×2160) vẫn đúng cỡ', async () => {
    const r = await GeoCode.render({ lang: 'html', kind: 'image', width: 3840, height: 2160, code: '<div style="position:absolute;right:0;bottom:0;width:4px;height:4px;background:#0f0"></div>' });
    const p = pixels(path.join(r.dir, frameName(0)));
    assert.deepStrictEqual([p.width, p.height], [3840, 2160]);
    assert.ok(p.at(3839, 2159).g > 200, 'pixel góc dưới phải là ô xanh ở mép (khung nhìn đúng 3840×2160)');
  });

  await check('sandbox: mã HTML không gọi được localhost / file://', async () => {
    const logs = [];
    const code = `<script>
      for (const url of ['http://127.0.0.1:17219/api/settings', 'file:///C:/Windows/win.ini']) {
        try { const x = new XMLHttpRequest(); x.open('GET', url, false); x.send(); console.log('LEAK ' + url + ' ' + x.status); }
        catch (e) { console.log('BLOCKED ' + url); }
      }
    </script>`;
    await GeoCode.render({ lang: 'html', kind: 'image', width: 16, height: 16, code }, { onLog: (l) => logs.push(l.message) });
    assert.ok(!logs.some((m) => m.startsWith('LEAK')), logs.join(' | '));
    assert.strictEqual(logs.filter((m) => m.startsWith('BLOCKED')).length, 2, logs.join(' | '));
  });

  await check('đặc tả sai bị từ chối rõ ràng (cỡ, fps, thời lượng)', async () => {
    assert.throws(() => GeoCode.normalizeSpec({ lang: 'html', code: 'x', width: 8, height: 100 }), /Chiều rộng|Width/);
    assert.throws(() => GeoCode.normalizeSpec({ lang: 'html', code: 'x', width: 100, height: 5000 }), /Chiều cao|Height/);
    assert.throws(() => GeoCode.normalizeSpec({ lang: 'html', code: 'x', width: 100, height: 100, kind: 'video', fps: 60, duration: 61 }), /60/);
    assert.throws(() => GeoCode.normalizeSpec({ lang: 'ruby', code: 'x', width: 100, height: 100 }));
  });

  const py = await GeoCode.checkPython();
  if (!py.ok) {
    results.push(`skip Python (${py.cmd}: ${String(py.error).split('\n').pop()})`);
  } else {
    await check(`Python (${py.version}): frame(t, w, h) -> đúng số khung, đúng cỡ, alpha thẳng`, async () => {
      const code = `from PIL import Image, ImageDraw
def frame(t, width, height):
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = int(t * 40)
    d.rectangle([x, 0, x + 9, height - 1], fill=(255, 128, 0, 128))
    print('t =', t)
    return img
`;
      const logs = [];
      const r = await GeoCode.render({ lang: 'python', kind: 'video', width: 80, height: 20, fps: 4, duration: 1, code }, { onLog: (l) => logs.push(l.message) });
      assert.strictEqual(r.frame_count, 4);
      const p = pixels(path.join(r.dir, frameName(2)));   // t = 0,5 -> x 20..29
      assert.deepStrictEqual([p.width, p.height], [80, 20]);
      assert.ok(p.at(24, 10).a > 120 && p.at(24, 10).a < 136, `alpha phải ~128, thấy ${p.at(24, 10).a}`);
      assert.strictEqual(p.at(5, 10).a, 0);
      assert.ok(logs.some((m) => m.includes('t = 0.5')), 'print() của người dùng phải vào log, không lẫn vào khung');
    });
    await check('Python lỗi: báo traceback, không để lại cache dở', async () => {
      const spec = { lang: 'python', kind: 'image', width: 16, height: 16, code: 'def frame(t, w, h):\n    raise RuntimeError("hỏng rồi")\n' };
      await assert.rejects(GeoCode.render(spec), /hỏng rồi/);
      assert.strictEqual(GeoCode.cacheInfo(spec).cached, false);
      const parent = GeoCode.geocodeCacheDir();
      assert.ok(!fs.readdirSync(parent).some((n) => n.includes('.tmp-')), 'thư mục tạm phải được dọn');
    });
  }

  await check('xem thử: một khung ở giây t, không ghi cache', async () => {
    const spec = { lang: 'html', kind: 'video', width: 450, height: 200, fps: 30, duration: 2, code: `${ANIM_HTML}<!-- preview -->` };
    const { png, t } = await GeoCode.previewFrame(spec, 1);
    assert.strictEqual(t, 1);
    const img = nativeImage.createFromBuffer(png);
    assert.deepStrictEqual(img.getSize(), { width: 450, height: 200 });
    assert.strictEqual(GeoCode.cacheInfo(spec).cached, false);
  });

  console.log(results.join('\n'));
  app.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
