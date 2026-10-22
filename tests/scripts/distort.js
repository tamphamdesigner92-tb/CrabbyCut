/* =====================================================================
 * BIẾN DẠNG (Distort kiểu After Effects) — static/js/distort.js + bản C++ ở sidecar.
 *
 *  - dữ liệu: chuẩn hoá hiệu ứng, kẹp thông số, id trùng; keyframe số nội suy theo easing,
 *    liệt kê giữ (Hold), giữ mép trước/sau;
 *  - Wave Warp: độ cao 0 = lưới gốc; ghim All Edges giữ góc đứng yên; cận maxExtents chứa trọn
 *    lưới đã dời; lưới thưa theo trục vuông góc phương sóng chạy;
 *  - rasterMesh: lưới gốc ở mật độ 1 cho ra đúng ảnh nguồn (nằm giữa khung đã nở);
 *  - exportSpec: khung đứng yên gộp một mục, sóng chạy mỗi khung một mục;
 *  - JS <-> sidecar (`distort-selftest`): cùng spec (backend distortSpecText) cho ra cùng lưới
 *    (sai số 1e-6 đơn vị hộp) và cùng ảnh uốn (lệch tối đa 1 mức / kênh).
 *
 * Chạy: npm run test:distort   (cần sidecar đã build: npm run build:sidecar)
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const D = require(path.join(ROOT, 'static', 'js', 'distort.js'));
const SIDECAR = process.env.DISTORT_SIDECAR
    || path.join(ROOT, 'native', 'sidecar', 'build', process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const ok = (msg) => console.log(`  ok  ${msg}`);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} != ${b} (±${eps})`);

const wave = (params = {}, extra = {}) => ({ id: 'd1', type: 'wave', enabled: true, params: { ...params }, ...extra });

// ---- Dữ liệu
{
    assert.deepStrictEqual(D.normalizeStack(null), []);
    assert.deepStrictEqual(D.normalizeStack([{ type: 'nope' }]), [], 'loại lạ bị bỏ');
    const [fx] = D.normalizeStack([wave({ height: 99999, width: 0, wave_type: 'heart' })]);
    assert.strictEqual(fx.params.height, 2000, 'kẹp Wave Height');
    assert.strictEqual(fx.params.width, 1, 'kẹp Wave Width');
    assert.strictEqual(fx.params.wave_type, 'sine', 'kiểu sóng lạ về Sine');
    assert.strictEqual(fx.params.direction, 90, 'mặc định Direction 90° như AE');
    const two = D.normalizeStack([wave(), wave()]);
    assert.notStrictEqual(two[0].id, two[1].id, 'id trùng được tách');
    assert.ok(!D.isActive({ type: 'text', distort: [wave()] }), 'chữ không nhận Distort');
    assert.ok(!D.isActive({ type: 'shape', distort: [wave({}, { enabled: false })] }), 'tắt hết = không hoạt động');
    assert.ok(D.isActive({ type: 'media', distort: [wave()] }));
    ok('chuẩn hoá hiệu ứng + thông số');
}

// ---- Keyframe
{
    const def = D.paramDef('wave', 'height');
    const list = [{ t: 1, v: 0, e: 'linear' }, { t: 3, v: 100, e: 'linear' }];
    assert.strictEqual(D.evalParamKeyframes(list, 0, def), 0, 'trước keyframe đầu = giá trị đầu');
    near(D.evalParamKeyframes(list, 2, def), 50, 1e-9, 'tuyến tính ở giữa');
    assert.strictEqual(D.evalParamKeyframes(list, 9, def), 100, 'sau keyframe cuối = giá trị cuối');
    const enumDef = D.paramDef('wave', 'wave_type');
    const holds = [{ t: 0, v: 'sine' }, { t: 2, v: 'square' }];
    assert.strictEqual(D.evalParamKeyframes(holds, 1.99, enumDef), 'sine', 'liệt kê giữ (Hold)');
    assert.strictEqual(D.evalParamKeyframes(holds, 2, enumDef), 'square');
    const item = { type: 'media', distort: [wave({ height: 10 })], keyframes: { 'dst.d1.height': list } };
    near(D.stackAt(item, 2)[0].params.height, 50, 1e-9, 'stackAt áp keyframe');
    assert.ok(D.isTimeVarying(item), 'có keyframe -> đổi theo thời gian');
    assert.ok(!D.isTimeVarying({ type: 'media', distort: [wave({ speed: 0 })] }), 'sóng đứng yên, không keyframe');
    assert.ok(D.isTimeVarying({ type: 'media', distort: [wave({ speed: 1 })] }), 'sóng chạy');
    assert.deepStrictEqual(D.parseKfField('dst.d1.phase'), { effectId: 'd1', key: 'phase' });
    ok('keyframe: nội suy, Hold, giữ mép');
}

// ---- Wave Warp: hình học
{
    const boxW = 300;
    const boxH = 120;
    const flat = { type: 'shape', distort: [wave({ height: 0 })] };
    const spec = D.gridSpec(flat, boxW, boxH);
    const base = D.evalGrid([], boxW, boxH, spec, 0);
    const zero = D.evalGrid(D.stackAt(flat, 0), boxW, boxH, spec, 0);
    assert.deepStrictEqual(Array.from(zero), Array.from(base), 'độ cao 0 = lưới gốc');
    near(base[0], -boxW / 2, 1e-9, 'gốc ở tâm hộp (x)');
    near(base[1], -boxH / 2, 1e-9, 'gốc ở tâm hộp (y)');

    const pinned = { type: 'shape', distort: [wave({ height: 30, width: 50, pinning: 'all_edges', phase: 37 })] };
    const ps = D.gridSpec(pinned, boxW, boxH);
    const g = D.evalGrid(D.stackAt(pinned, 0.7), boxW, boxH, ps, 0.7);
    const at = (i, j) => [g[(j * (ps.cols + 1) + i) * 2], g[(j * (ps.cols + 1) + i) * 2 + 1]];
    [[0, 0], [ps.cols, 0], [0, ps.rows], [ps.cols, ps.rows]].forEach(([i, j]) => {
        const [x, y] = at(i, j);
        near(x, (i / ps.cols - 0.5) * boxW, 1e-9, 'All Edges: góc đứng yên (x)');
        near(y, (j / ps.rows - 0.5) * boxH, 1e-9, 'All Edges: góc đứng yên (y)');
    });

    // Hướng 90° (sóng chạy ngang, dời dọc): trục dọc gần như không đổi -> ít hàng.
    const horiz = { type: 'media', distort: [wave({ height: 20, width: 40, direction: 90 })] };
    const hs = D.gridSpec(horiz, 1920, 1080);
    assert.ok(hs.cols >= Math.ceil((1920 * 8) / 40) - 1 && hs.rows === D.MIN_CELLS, `lưới thưa theo trục dọc (${hs.cols}x${hs.rows})`);
    assert.ok(hs.cols <= D.MAX_CELLS, 'lưới có trần');

    // Cận maxExtents chứa trọn mọi khung (keyframe Height vượt đích do easing "Bật lại").
    const kf = {
        type: 'shape',
        distort: [wave({ height: 25, width: 30, direction: 33, speed: 2, wave_type: 'smooth_noise' })],
        keyframes: { 'dst.d1.height': [{ t: 0, v: 5, e: 'back' }, { t: 1, v: 60 }] },
    };
    const ext = D.maxExtents(kf, boxW, boxH);
    const ks = D.gridSpec(kf, boxW, boxH);
    for (let t = 0; t <= 2; t += 0.05) {
        const pts = D.evalGrid(D.stackAt(kf, t), boxW, boxH, ks, t);
        for (let q = 0; q < pts.length; q += 2) {
            assert.ok(Math.abs(pts[q]) <= ext.hx && Math.abs(pts[q + 1]) <= ext.hy, `cận maxExtents chứa trọn lưới tại t=${t.toFixed(2)}`);
        }
    }
    ok('Wave Warp: lưới gốc, ghim, lưới thưa, cận khung');
}

// ---- Bezier / Mesh Warp
{
    const boxW = 240;
    const boxH = 160;
    const fresh = { type: 'shape', distort: [{ id: 'b1', type: 'bezier', params: {} }, { id: 'm1', type: 'mesh', params: { rows: 3, cols: 4 } }] };
    const spec = D.gridSpec(fresh, boxW, boxH);
    const a = D.evalGrid(D.stackAt(fresh, 0), boxW, boxH, spec, 0);
    const b = D.evalGrid([], boxW, boxH, spec, 0);
    let err = 0;
    for (let q = 0; q < a.length; q += 1) err = Math.max(err, Math.abs(a[q] - b[q]));
    assert.ok(err < 1e-9, `Bezier + Mesh mặc định = ánh xạ đồng nhất (lệch ${err})`);

    // Kéo đỉnh Bezier: hai tiếp tuyến kề đi theo; góc hộp đi đúng tới đỉnh mới.
    const [bz] = D.normalizeStack([{ id: 'b1', type: 'bezier', params: {} }]);
    const patch = D.dragHandle(bz, bz.params, 'br_vertex', 1.2, 1.1);
    assert.deepStrictEqual(Object.keys(patch).sort(), ['br_tangent', 'br_vertex', 'rb_tangent']);
    near(patch.rb_tangent[0], 1.2, 1e-12, 'tiếp tuyến phải-dưới đi theo đỉnh (x)');
    near(patch.br_tangent[1], 1.1, 1e-12, 'tiếp tuyến dưới-phải đi theo đỉnh (y)');
    const corner = D.coons(D.bezierPatch({ ...bz.params, ...patch }), 1, 1);
    near(corner[0], 1.2, 1e-12, 'góc (1,1) tới đỉnh mới (x)');
    near(corner[1], 1.1, 1e-12, 'góc (1,1) tới đỉnh mới (y)');

    // Mesh: kéo đỉnh -> tay cầm tương đối đi theo; kéo tay cầm chỉ đổi tay cầm.
    const [me] = D.normalizeStack([{ id: 'm1', type: 'mesh', params: { rows: 2, cols: 2 } }]);
    const moved = D.dragHandle(me, me.params, 'v4:p', 0.6, 0.45).mesh;   // đỉnh giữa (1,1)
    assert.deepStrictEqual([moved[40], moved[41]], [0.6, 0.45]);
    assert.strictEqual(moved[44], me.params.mesh ? me.params.mesh[44] : 1 / 6, 'tay cầm phải giữ offset');
    const tan = D.dragHandle(me, { ...me.params, mesh: moved }, 'v4:r', 0.9, 0.45).mesh;
    near(tan[44], 0.3, 1e-12, 'tay cầm phải = điểm kéo − đỉnh');
    // Lưới khác cỡ Rows/Columns bị bỏ (về lưới đều).
    const bad = D.normalizeStack([{ id: 'm', type: 'mesh', params: { rows: 2, cols: 2, mesh: [1, 2, 3] } }])[0];
    assert.strictEqual(bad.params.mesh, null, 'lưới sai cỡ bị bỏ');

    // Keyframe véc-tơ: nội suy từng số, lưới nội suy cả mảng.
    const item = {
        type: 'media',
        distort: [{ id: 'b1', type: 'bezier', params: {} }, { id: 'm1', type: 'mesh', params: { rows: 2, cols: 2 } }],
        keyframes: {
            'dst.b1.tl_vertex': [{ t: 0, v: [0, 0], e: 'linear' }, { t: 2, v: [0.2, -0.4], e: 'linear' }],
            'dst.m1.mesh': [{ t: 0, v: D.meshIdentity(2, 2), e: 'linear' }, { t: 1, v: moved, e: 'linear' }],
        },
    };
    const st = D.stackAt(item, 1);
    near(st[0].params.tl_vertex[0], 0.1, 1e-12, 'vec2 nội suy (x)');
    near(st[0].params.tl_vertex[1], -0.2, 1e-12, 'vec2 nội suy (y)');
    near(st[1].params.mesh[40], 0.6, 1e-12, 'lưới tới keyframe cuối');
    near(D.stackAt(item, 0.5)[1].params.mesh[40], 0.55, 1e-12, 'lưới nội suy giữa hai keyframe');
    assert.ok(D.isTimeVarying(item), 'keyframe lưới -> đổi theo thời gian');

    // Cận khung chứa trọn lưới đã uốn ở mọi thời điểm.
    const ext = D.maxExtents(item, boxW, boxH);
    const ks = D.gridSpec(item, boxW, boxH);
    for (let t = 0; t <= 2; t += 0.1) {
        const pts = D.evalGrid(D.stackAt(item, t), boxW, boxH, ks, t);
        for (let q = 0; q < pts.length; q += 2) {
            assert.ok(Math.abs(pts[q]) <= ext.hx && Math.abs(pts[q + 1]) <= ext.hy, `cận maxExtents chứa trọn Bezier/Mesh tại t=${t.toFixed(1)}`);
        }
    }
    // Tay nắm: Bezier 12, Mesh 2×2 có 9 đỉnh.
    assert.strictEqual(D.handleModel(bz, bz.params).handles.length, 12);
    assert.strictEqual(D.handleModel(me, me.params).handles.filter((h) => h.kind === 'vertex').length, 9);
    ok('Bezier/Mesh Warp: đồng nhất, kéo đỉnh/tay cầm, keyframe véc-tơ, cận khung, tay nắm');
}

// ---- Puppet (ARAP)
{
    const boxW = 300;
    const boxH = 150;
    const P = (pins, extra = {}) => D.normalizeStack([{ id: 'u1', type: 'puppet', params: { triangles: 200, pins, ...extra } }])[0];
    // Không ghim = lưới gốc.
    const none = D.puppetSolve(P([]).params, boxW, boxH);
    near(D.puppetMap(none.pts, none.cols, none.rows, 0.37, 0.61)[0], 0.37, 1e-12, 'không ghim: đứng yên');
    // Ghim tới đúng đích; một ghim = tịnh tiến cả hình.
    const two = P([{ id: 'a', rest: [0.2, 0.5], pos: [0.2, 0.5] }, { id: 'b', rest: [0.8, 0.5], pos: [0.85, 0.25] }]);
    const s2 = D.puppetSolve(two.params, boxW, boxH);
    const hitB = D.puppetMap(s2.pts, s2.cols, s2.rows, 0.8, 0.5);
    near(hitB[0], 0.85, 1e-4, 'ghim b tới đích (x)');
    near(hitB[1], 0.25, 1e-4, 'ghim b tới đích (y)');
    const one = D.puppetSolve(P([{ id: 'a', rest: [0.5, 0.5], pos: [0.6, 0.45] }]).params, boxW, boxH);
    const far = D.puppetMap(one.pts, one.cols, one.rows, 0.05, 0.9);
    near(far[0], 0.15, 1e-3, 'một ghim: tịnh tiến (x)');
    near(far[1], 0.85, 1e-3, 'một ghim: tịnh tiến (y)');
    // Ánh xạ ngược: điểm đã uốn -> điểm gốc -> uốn lại = chính nó.
    const back = D.puppetInverse(s2, null, hitB[0], hitB[1]);
    near(back[0], 0.8, 1e-6, 'puppetInverse (x)');
    near(back[1], 0.5, 1e-6, 'puppetInverse (y)');
    // Mặt nạ: hai đảo hình rời nhau (trái / phải). Kéo đảo phải không kéo theo đảo trái.
    const two2 = P([{ id: 'r', rest: [0.85, 0.5], pos: [0.85, 0.2] }, { id: 'r2', rest: [0.7, 0.5], pos: [0.7, 0.5] }]);
    const mask = D.puppetMask(two2.params, boxW, boxH, (x0, y0, x1) => (x1 <= 0.35 || x0 >= 0.6 ? 255 : 0));
    const sm = D.puppetSolve(two2.params, boxW, boxH, mask);
    const left = D.puppetMap(sm.pts, sm.cols, sm.rows, 0.15, 0.5);
    near(left[0], 0.15, 1e-3, 'đảo trái đứng yên (x)');
    near(left[1], 0.5, 1e-3, 'đảo trái đứng yên (y)');
    const free = D.puppetSolve(two2.params, boxW, boxH);
    assert.ok(Math.abs(D.puppetMap(free.pts, free.cols, free.rows, 0.15, 0.5)[1] - 0.5) > 1e-3, 'không mặt nạ thì đảo trái bị kéo theo (đối chứng)');
    // Keyframe Position của ghim -> đổi theo thời gian, nội suy véc-tơ.
    const item = {
        type: 'shape',
        distort: [{ id: 'u1', type: 'puppet', params: two.params }],
        keyframes: { 'dst.u1.pin_b': [{ t: 0, v: [0.8, 0.5], e: 'linear' }, { t: 2, v: [0.9, 0.1], e: 'linear' }] },
    };
    assert.ok(D.isTimeVarying(item), 'keyframe ghim -> đổi theo thời gian');
    const mid = D.stackAt(item, 1)[0].params.pins.find((p) => p.id === 'b').pos;
    near(mid[0], 0.85, 1e-12, 'ghim nội suy (x)');
    near(mid[1], 0.3, 1e-12, 'ghim nội suy (y)');
    // Lưới vẽ là bội của lưới Puppet -> ánh xạ khớp tuyệt đối tại đỉnh lưới Puppet.
    const spec = D.gridSpec(item, boxW, boxH);
    const pg = D.puppetGrid(two.params, boxW, boxH);
    assert.strictEqual(spec.cols % pg.cols, 0, 'lưới vẽ là bội lưới Puppet (cột)');
    assert.strictEqual(spec.rows % pg.rows, 0, 'lưới vẽ là bội lưới Puppet (hàng)');
    // Cận khung chứa trọn.
    const ext = D.maxExtents(item, boxW, boxH);
    for (let t = 0; t <= 2; t += 0.25) {
        const pts = D.evalGrid(D.stackAt(item, t), boxW, boxH, spec, t);
        for (let q = 0; q < pts.length; q += 2) {
            assert.ok(Math.abs(pts[q]) <= ext.hx && Math.abs(pts[q + 1]) <= ext.hy, `cận maxExtents chứa trọn Puppet tại t=${t}`);
        }
    }
    // Kéo ghim qua dragHandle -> khoá 'pin_<id>'.
    assert.deepStrictEqual(D.dragHandle(two, two.params, 'pin:b', 0.5, 0.5), { pin_b: [0.5, 0.5] });
    ok('Puppet: đứng yên/tịnh tiến, ghim tới đích, ngược, mặt nạ tách đảo, keyframe ghim, lưới bội, cận khung');
}

// ---- Dạng sóng
{
    near(D.waveShape('sine', 0.25), 1, 1e-12, 'Sine đỉnh ở ¼ chu kỳ');
    assert.strictEqual(D.waveShape('square', 0.1), 1);
    assert.strictEqual(D.waveShape('square', 0.6), -1);
    near(D.waveShape('triangle', 0.25), 1, 1e-12, 'Triangle đỉnh ở ¼');
    near(D.waveShape('triangle', 0.75), -1, 1e-12);
    ['sine', 'square', 'triangle', 'sawtooth', 'circle', 'semicircle', 'uncircle', 'noise', 'smooth_noise'].forEach((s) => {
        for (let u = -3; u <= 3; u += 0.0137) {
            const v = D.waveShape(s, u);
            assert.ok(v >= -1 - 1e-12 && v <= 1 + 1e-12, `${s} trong [-1, 1]`);
        }
    });
    assert.strictEqual(D.hash32(7), D.hash32(7), 'Noise tất định');
    ok('dạng sóng nằm trong [-1, 1], tất định');
}

// ---- rasterMesh: lưới gốc = ảnh nguồn
{
    // Cỡ CHẴN: khung nở ra đối xứng thì nguồn nằm đúng lưới pixel (không lệch nửa điểm ảnh).
    const sw = 24;
    const sh = 12;
    const src = new Uint8ClampedArray(sw * sh * 4);
    for (let i = 0; i < sw * sh; i += 1) {
        src[i * 4] = (i * 37) % 256; src[i * 4 + 1] = (i * 91) % 256; src[i * 4 + 2] = (i * 13) % 256; src[i * 4 + 3] = 255;
    }
    const item = { type: 'shape', distort: [wave({ height: 0 })] };
    const spec = { cols: 8, rows: 8 };
    const ext = { hx: sw / 2 + 3, hy: sh / 2 + 2 };
    const size = D.outputSize(ext, 1);
    const pts = D.gridToPixels(D.evalGrid(D.stackAt(item, 0), sw, sh, spec, 0), 1, size.width, size.height);
    const out = new Uint8ClampedArray(size.width * size.height * 4);
    D.rasterMesh(src, sw, sh, spec.cols, spec.rows, pts, out, size.width, size.height);
    const ox = (size.width - sw) / 2;
    const oy = (size.height - sh) / 2;
    for (let y = 0; y < sh; y += 1) {
        for (let x = 0; x < sw; x += 1) {
            for (let c = 0; c < 4; c += 1) {
                assert.strictEqual(out[((y + oy) * size.width + x + ox) * 4 + c], src[(y * sw + x) * 4 + c], 'lưới gốc chép đúng điểm ảnh');
            }
        }
    }
    assert.strictEqual(out[3], 0, 'phần nở ra trong suốt');
    ok('rasterMesh: lưới gốc chép đúng nguồn, phần nở trong suốt');
}

// ---- exportSpec
{
    const still = { type: 'media', distort: [wave({ height: 12, speed: 0 })] };
    const s1 = D.exportSpec(still, 640, 360, 30, 2);
    assert.strictEqual(s1.frames.length, 60);
    assert.strictEqual(s1.stacks.length, 1, 'khung đứng yên gộp một mục');
    const run = { type: 'media', distort: [wave({ height: 12, speed: 1.5 })] };
    const s2 = D.exportSpec(run, 640, 360, 30, 2);
    assert.strictEqual(s2.stacks.length, 60, 'sóng chạy: mỗi khung một mục');
    near(s2.stacks[3][0].t, 3.5 / 30, 1e-12, 'lấy mẫu giữa khung');

    // Mesh có keyframe: lưới gửi THEO THAM CHIẾU (mỗi lưới keyframe một lần) mà dựng lại vẫn trùng
    // từng số với lưới preview; Mesh 31×31 dài 60 s không còn phình payload.
    const big = D.meshIdentity(31, 31).map((v, i) => v + ((i % 7) - 3) * 0.002);
    const meshed = {
        type: 'media',
        distort: [{ id: 'm1', type: 'mesh', params: { rows: 31, cols: 31, quality: 2 } }],
        keyframes: { 'dst.m1.mesh': [{ t: 0, v: D.meshIdentity(31, 31), e: 'spring' }, { t: 40, v: big, e: 'linear' }] },
    };
    const s3 = D.exportSpec(meshed, 320, 180, 30, 60);
    assert.strictEqual(s3.meshes.length, 2, 'hai lưới keyframe, gửi một lần');
    const bytes = JSON.stringify(s3).length;
    assert.ok(bytes < 2 * 1024 * 1024, `spec Mesh 31×31 / 60 s phải nhỏ (đang ${(bytes / 1048576).toFixed(1)} MB)`);
    [0.4, 13.3, 39.9, 55].forEach((t) => {
        const k = Math.min(s3.frames.length - 1, Math.floor(t * 30));
        const tt = (k + 0.5) / 30;
        const fromSpec = D.evalSpecStack(s3.stacks[s3.frames[k]], 320, 180, s3.grid, s3.meshes, s3.puppets);
        const fromPreview = D.evalGrid(D.stackAt(meshed, tt), 320, 180, s3.grid, tt);
        let e = 0;
        for (let q = 0; q < fromSpec.length; q += 1) e = Math.max(e, Math.abs(fromSpec[q] - fromPreview[q]));
        assert.strictEqual(e, 0, `lưới từ spec trùng preview tại t=${tt.toFixed(2)} (lệch ${e})`);
    });
    ok('exportSpec: gộp khung đứng yên, mẫu giữa khung');
}

// ---- JS <-> sidecar
{
    assert.ok(fs.existsSync(SIDECAR), `chưa build sidecar: ${SIDECAR} (npm run build:sidecar)`);
    const { distortSpecText } = require(path.join(ROOT, 'backend', 'server.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-distort-'));
    const sw = 97;
    const sh = 61;
    const src = Buffer.alloc(sw * sh * 4);
    for (let y = 0; y < sh; y += 1) {
        for (let x = 0; x < sw; x += 1) {
            const q = (y * sw + x) * 4;
            src[q] = (x * 5 + y * 3) % 256; src[q + 1] = (x * 11) % 256; src[q + 2] = (y * 17) % 256;
            // Alpha có chỗ trong suốt / nửa trong để thử phép nhân sẵn.
            src[q + 3] = ((x >> 3) + (y >> 3)) % 3 === 0 ? 0 : (((x + y) % 2) ? 255 : 128);
        }
    }
    fs.writeFileSync(path.join(dir, 'src.rgba'), src);
    const cases = [
        { name: 'sine + ghim cạnh dọc', fx: wave({ height: 9, width: 23, direction: 90, speed: 1, pinning: 'vertical_edges', phase: 40 }) },
        { name: 'square chéo', fx: wave({ height: 6, width: 17, direction: 225, speed: -0.5, wave_type: 'square' }) },
        { name: 'smooth noise + center', fx: wave({ height: 11, width: 31, direction: 10, speed: 2, wave_type: 'smooth_noise', pinning: 'center' }) },
    ];
    // Box ≠ cỡ nguồn để thử luôn hệ số k (ảnh nguồn 97 px cho hộp 48.5 đơn vị -> k = 2).
    const boxW = sw / 2;
    const boxH = sh / 2;
    // Bezier + Mesh đã uốn (kèm keyframe lưới) xếp chồng với Wave.
    const meshUsed = D.meshIdentity(2, 3);
    meshUsed[(1 * 4 + 1) * 10] += 0.12; meshUsed[(1 * 4 + 1) * 10 + 1] -= 0.08; meshUsed[(1 * 4 + 2) * 10 + 4] += 0.1;
    cases.push({
        name: 'bezier + mesh + wave',
        fx: { id: 'b1', type: 'bezier', params: { br_vertex: [1.15, 1.05], tl_tangent: [0.4, -0.2], lb_tangent: [-0.1, 0.7] } },
        more: [
            { id: 'm1', type: 'mesh', params: { rows: 2, cols: 3, mesh: meshUsed } },
        ],
        keyframes: { 'dst.m1.mesh': [{ t: 0, v: D.meshIdentity(2, 3), e: 'ease-in-out' }, { t: 0.5, v: meshUsed }] },
    });
    // Puppet (lưới đã giải gửi kèm, ghim có keyframe) đứng ĐẦU ngăn, sau đó Bezier.
    cases.push({
        name: 'puppet + bezier + wave',
        fx: { id: 'u1', type: 'puppet', params: { triangles: 120, pins: [
            { id: 'a', rest: [0.25, 0.5], pos: [0.25, 0.5] },
            { id: 'b', rest: [0.75, 0.4], pos: [0.85, 0.2] },
        ] } },
        more: [{ id: 'b1', type: 'bezier', params: { tl_tangent: [0.3, 0.1] } }],
        keyframes: { 'dst.u1.pin_b': [{ t: 0, v: [0.75, 0.4], e: 'ease-out' }, { t: 0.5, v: [0.85, 0.2] }] },
    });
    cases.forEach(({ name, fx, more, keyframes }) => {
        const item = {
            type: 'media',
            distort: [fx, ...(more || []), wave({ height: 3, width: 9, direction: 0, speed: 3, wave_type: 'triangle' }, { id: 'd2' })],
            keyframes: keyframes || {},
        };
        const spec = D.exportSpec(item, boxW, boxH, 30, 0.5);
        const stackIdx = spec.frames[7];
        const specPath = path.join(dir, 'spec.txt');
        fs.writeFileSync(specPath, distortSpecText(spec));
        const prefix = path.join(dir, 'out');
        const res = spawnSync(SIDECAR, ['distort-selftest', specPath, String(stackIdx), path.join(dir, 'src.rgba'), String(sw), String(sh), prefix], { encoding: 'utf8' });
        assert.strictEqual(res.status, 0, `sidecar distort-selftest lỗi: ${res.stdout}${res.stderr}`);
        const dims = JSON.parse(res.stdout.trim().split('\n').pop());

        const jsGrid = D.evalSpecStack(spec.stacks[stackIdx], boxW, boxH, spec.grid, spec.meshes, spec.puppets);
        const cGrid = fs.readFileSync(`${prefix}.grid`, 'utf8').trim().split('\n').map(Number);
        assert.strictEqual(cGrid.length, jsGrid.length, `${name}: cùng số đỉnh`);
        let maxGrid = 0;
        for (let q = 0; q < jsGrid.length; q += 1) maxGrid = Math.max(maxGrid, Math.abs(jsGrid[q] - cGrid[q]));
        assert.ok(maxGrid <= 1e-6, `${name}: lưới lệch ${maxGrid}`);

        const k = sw / boxW;
        const size = D.outputSize(spec.ext, k);
        assert.deepStrictEqual([dims.width, dims.height], [size.width, size.height], `${name}: cùng cỡ ảnh ra`);
        const pts = D.gridToPixels(jsGrid, k, size.width, size.height);
        const jsOut = new Uint8ClampedArray(size.width * size.height * 4);
        D.rasterMesh(new Uint8ClampedArray(src), sw, sh, spec.grid.cols, spec.grid.rows, pts, jsOut, size.width, size.height);
        const cOut = fs.readFileSync(`${prefix}.rgba`);
        assert.strictEqual(cOut.length, jsOut.length, `${name}: cùng cỡ dữ liệu`);
        let maxPx = 0;
        let painted = 0;
        for (let q = 0; q < jsOut.length; q += 1) {
            maxPx = Math.max(maxPx, Math.abs(jsOut[q] - cOut[q]));
            if (q % 4 === 3 && jsOut[q] > 0) painted += 1;
        }
        assert.ok(painted > sw * sh / 4, `${name}: có hình được vẽ`);
        assert.ok(maxPx <= 1, `${name}: ảnh uốn lệch ${maxPx} mức`);
        ok(`JS <-> sidecar khớp: ${name} (lưới ±${maxGrid.toExponential(1)}, điểm ảnh ±${maxPx})`);
    });
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log('distort: tất cả đạt');
