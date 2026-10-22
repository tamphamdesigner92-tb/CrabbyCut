/* =====================================================================
 * BIẾN DẠNG CHỮ (Warp) + CHỮ THEO ĐƯỜNG — phần toán của static/js/text-deform.js.
 *
 *  - warp: bend/méo = 0 là không hiệu ứng; mọi kiểu giữ TÂM đứng yên; Arc giữ đúng chiều dài
 *    cung ở đường giữa (chữ không dài/ngắn đi), bend dương uốn vồng lên; hộp đo ĐỐI XỨNG quanh
 *    tâm (position_x/y giữ nghĩa "tâm khối chữ");
 *  - đường: lấy mẫu đúng chiều dài, căn giữa/đầu/cuối, dời theo %, đường kín quay vòng, đảo
 *    phía đổi chiều; glyph nằm trên đường với góc tiếp tuyến;
 *  - deformMeasure: chữ thường không đổi hộp; có hiệu ứng thì hộp mới + giữ lề viền/bóng;
 *  - ô inspector -> patch được kẹp đúng khoảng; mẫu đường đều hợp lệ.
 *
 * Chạy: npm run test:text-deform
 * ================================================================== */
const assert = require('assert');
const path = require('path');

const TD = require(path.join(__dirname, '..', '..', 'static', 'js', 'text-deform.js'));
const ok = (msg) => console.log(`  ok  ${msg}`);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} != ${b} (±${eps})`);

// ---- Warp
{
    assert.strictEqual(TD.normalizeWarp({}), null, 'không warp_type -> không hiệu ứng');
    assert.strictEqual(TD.normalizeWarp({ warp_type: 'none', warp_bend: 80 }), null);
    assert.strictEqual(TD.normalizeWarp({ warp_type: 'arc', warp_bend: 0, warp_h: 0, warp_v: 0 }), null, 'mọi thông số 0 = không hiệu ứng');
    assert.strictEqual(TD.normalizeWarp({ warp_type: 'heart' }), null, 'kiểu lạ bị bỏ qua');
    const w = TD.normalizeWarp({ warp_type: 'arc', warp_bend: 250, warp_h: -400 });
    assert.deepStrictEqual([w.bend, w.h], [1, -1], 'kẹp -100..100');
    assert.strictEqual(TD.normalizeWarp({ warp_type: 'arc' }).bend, 0.5, 'Bend mặc định 50 như AE');
    // Kiểu đối xứng giữ tâm đứng yên; Arc Lower/Upper, Arch, Shell dịch cả phần giữa (như AE).
    const centred = ['arc', 'bulge', 'flag', 'wave', 'fish', 'rise', 'fisheye', 'inflate', 'squeeze', 'twist'];
    for (const t of TD.WARP_TYPES) {
        const warp = TD.normalizeWarp({ warp_type: t.id, warp_bend: 70, warp_h: 30, warp_v: -20 });
        const [x, y] = TD.warpPoint(warp, 0, 0, 200, 50);
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `${t.id}: số hữu hạn`);
        if (!centred.includes(t.id)) continue;
        near(x, 0, 1e-9, `${t.id}: tâm đứng yên (x)`);
        near(y, 0, 1e-9, `${t.id}: tâm đứng yên (y)`);
    }
    // Arc: điểm trên đường giữa nằm trên đường tròn bán kính r0 quanh (0, r0); chiều dài cung = bề rộng.
    const arc = TD.normalizeWarp({ warp_type: 'arc', warp_bend: 50 });
    const hw = 300;
    const r0 = (2 * hw) / (arc.bend * Math.PI);
    const [ex, ey] = TD.warpPoint(arc, hw, 0, hw, 60);
    near(Math.hypot(ex, ey - r0), r0, 1e-6, 'Arc: mép phải trên đường tròn');
    near(Math.atan2(ex, r0 - ey) * r0, hw, 1e-6, 'Arc: chiều dài cung = nửa bề rộng chữ');
    assert.ok(ey > 0, 'Arc bend dương: hai đầu hạ xuống (vồng lên ở giữa)');
    const down = TD.warpPoint(TD.normalizeWarp({ warp_type: 'arc', warp_bend: -50 }), hw, 0, hw, 60);
    assert.ok(down[1] < 0, 'Arc bend âm: hai đầu nhấc lên');
    // Hộp đối xứng chứa mọi điểm của lưới.
    const ext = TD.warpExtents(arc, 600, 120, 300, 60);
    assert.ok(ext.hx >= 300 && ext.hy > 60, `hộp Arc phải nở ra theo chiều dọc (${ext.hx}x${ext.hy})`);
    ok('warp: thông số 0 = tắt, kẹp giá trị, tâm đứng yên ở các kiểu đối xứng, Arc giữ chiều dài cung, hộp đối xứng');
}

// ---- Đường
{
    const line = TD.normalizePath({ path_enabled: true, path_points: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], path_w: 1000, path_h: 0 });
    const s = TD.samplePath(line);
    near(s.length, 1000, 1e-6, 'đường thẳng dài đúng bề rộng box');
    const p = TD.pointAt(s, 250);
    near(p.x, 250, 1e-6, 'điểm ở 1/4 đường');
    near(p.angle, 0, 1e-9, 'góc tiếp tuyến của đường ngang = 0');
    assert.strictEqual(TD.pointAt(s, 1200), null, 'ngoài đường hở -> null');
    const measure = () => 50;          // mọi ký tự rộng 50 px
    let lay = TD.layoutPathGlyphs(line, 'abcd', measure, 10);
    assert.strictEqual(lay.total, 4 * 50 + 3 * 10, 'tổng bề rộng tính cả letter-spacing giữa các ký tự');
    near(lay.glyphs[0].x, 500 - 230 / 2 + 25, 1e-6, 'căn giữa đường');
    lay = TD.layoutPathGlyphs({ ...line, align: 'left' }, 'abcd', measure, 0);
    near(lay.glyphs[0].x, 25, 1e-6, 'căn đầu đường');
    lay = TD.layoutPathGlyphs({ ...line, align: 'left', offset: 0.1 }, 'abcd', measure, 0);
    near(lay.glyphs[0].x, 125, 1e-6, 'dời 10% chiều dài');
    lay = TD.layoutPathGlyphs({ ...line, align: 'right' }, 'abcd', measure, 0);
    near(lay.glyphs[3].x, 975, 1e-6, 'căn cuối đường');
    const flipped = TD.layoutPathGlyphs({ ...line, align: 'left', flip: true }, 'ab', measure, 0);
    near(flipped.glyphs[0].x, 975, 1e-6, 'đảo phía: đi từ cuối về đầu');
    near(Math.abs(flipped.glyphs[0].angle), Math.PI, 1e-9, 'đảo phía: chữ lộn ngược sang bên kia đường');
    // Đường kín (vòng tròn): căn giữa quanh điểm đầu, ký tự vượt quá vòng thì quay lại.
    const circle = TD.normalizePath(TD.presetStyle('circle'));
    const cs = TD.samplePath(circle);
    near(cs.length, Math.PI * 520, 520 * 0.02, 'chu vi vòng tròn mẫu');
    const ring = TD.layoutPathGlyphs(circle, 'x'.repeat(40), measure, 0);
    assert.strictEqual(ring.glyphs.length, 40, 'đường kín: mọi ký tự đều có chỗ');
    near(ring.glyphs[19].x + 25, 260, 30, 'đường kín căn giữa quanh đỉnh trên cùng');
    // Mẫu đường đều hợp lệ.
    TD.PATH_PRESETS.forEach((pr) => {
        const np = TD.normalizePath(TD.presetStyle(pr.id));
        assert.ok(np && TD.samplePath(np).length > 100, `mẫu ${pr.id} hợp lệ`);
    });
    assert.strictEqual(TD.normalizePath({ path_enabled: true, path_points: [{ x: 0, y: 0 }] }), null, '1 đỉnh -> không phải đường');
    assert.strictEqual(TD.normalizePath({ ...TD.presetStyle('arc'), path_enabled: false }), null, 'path_enabled false -> chữ thường');
    ok('đường: chiều dài, căn đầu/giữa/cuối, dời %, đảo phía, đường kín quay vòng, mẫu hợp lệ');
}

// ---- deformMeasure
{
    const base = { width: 400, height: 100, margin: 6, fontSize: 60, displayLines: ['Hai', 'dòng'], letterPx: 0 };
    assert.strictEqual(TD.deformMeasure({}, base), null, 'chữ thường: giữ nguyên số đo');
    const warped = TD.deformMeasure({ warp_type: 'arch', warp_bend: 60 }, base);
    assert.strictEqual(warped.margin, 6, 'giữ lề viền/bóng');
    assert.ok(warped.width >= 400 && warped.width <= 406, `Arch chỉ đẩy dọc: bề rộng giữ nguyên (+lề an toàn 2px mỗi bên), đang ${warped.width}`);
    assert.ok(warped.height > 100, 'Arch: hộp cao thêm');
    assert.strictEqual(warped.deform.base, base, 'mang số đo chữ gốc cho khâu vẽ');
    const onPath = TD.deformMeasure({ ...TD.presetStyle('wave'), path_shift: 10 }, base, 4);
    const pad = Math.ceil(60 * 1.25 + 4 + 10 + 4);
    assert.strictEqual(onPath.width, Math.ceil(860 + 2 * pad), 'hộp chữ theo đường = box đường + lề chữ hai bên');
    assert.deepStrictEqual(onPath.displayLines, ['Hai dòng'], 'chữ theo đường là một dòng');
    ok('deformMeasure: chữ thường giữ nguyên; warp/đường ra hộp mới, giữ lề, mang số đo gốc');
}

// ---- Ô inspector
{
    const f = (key, value, extra = {}) => TD.patchFromField({ dataset: { textDeform: key }, value, ...extra });
    assert.deepStrictEqual(f('warp_type', 'bulge'), { warp_type: 'bulge' });
    assert.deepStrictEqual(f('warp_type', 'xx'), { warp_type: 'none' });
    assert.deepStrictEqual(f('warp_bend', '500'), { warp_bend: 100 });
    assert.deepStrictEqual(f('path_w', '3'), { path_w: 10 });
    assert.deepStrictEqual(f('path_flip', '', { checked: true }), { path_flip: true });
    assert.deepStrictEqual(f('path_align', 'weird'), { path_align: 'center' });
    assert.ok(/data-text-deform="warp_type"/.test(TD.inspectorHtml({})), 'inspector có ô kiểu Warp');
    assert.ok(!/data-text-deform-section="path"/.test(TD.inspectorHtml({})), 'chữ thường: không có mục đường');
    assert.ok(/data-text-deform-section="path"/.test(TD.inspectorHtml(TD.presetStyle('arc'))), 'chữ theo đường: có mục đường');
    ok('ô inspector -> patch được kẹp đúng khoảng; mục đường chỉ hiện với chữ theo đường');
}

// ---- Kerning (editing-runtime.js): tuỳ chọn font_kerning áp ở mọi chỗ đo/vẽ, Magic Fill tắt sẵn
{
    const fs = require('fs');
    const rt = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'js', 'editing-runtime.js'), 'utf8');
    const grab = (name) => {
        const start = rt.indexOf(`function ${name}(`);
        assert.notStrictEqual(start, -1, `không thấy ${name}()`);
        let depth = 0;
        for (let i = rt.indexOf('{', rt.indexOf(')', start)); i < rt.length; i += 1) {
            if (rt[i] === '{') depth += 1;
            else if (rt[i] === '}' && --depth === 0) return rt.slice(start, i + 1);
        }
        return '';
    };
    // eslint-disable-next-line no-new-func
    const textFontKerning = new Function(`${grab('textFontKerning')}; return textFontKerning;`)();
    assert.strictEqual(textFontKerning({}), 'normal', 'mặc định theo font');
    assert.strictEqual(textFontKerning({ font_kerning: 'none' }), 'none');
    assert.strictEqual(textFontKerning({ font_kerning: 'auto' }), 'normal');
    assert.ok(/fontKerning = textFontKerning\(style\)/.test(grab('measureTextItemBox')), 'phép đo hộp chữ dùng đúng kerning');
    assert.ok((grab('drawTextItemContent').match(/fontKerning = textFontKerning\(style\)/g) || []).length >= 2, 'vẽ chữ (cả lớp bóng) dùng đúng kerning');
    assert.ok(/font_kerning: 'none'/.test(grab('magicFillStylePatch')) && /font_kerning: 'none'/.test(grab('magicFillTextPatch')), 'Magic Fill tắt kerning sẵn');
    assert.ok(/el\.style\.fontKerning = /.test(rt), 'preview DOM dùng đúng kerning');
    ok('kerning: mặc định theo font, "none" áp ở đo/vẽ/preview; Magic Fill tắt sẵn');
}

console.log('text_deform: OK');
