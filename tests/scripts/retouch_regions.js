/* Test MODULE static/js/retouch.js — engine Retouch.
 *
 * ĐIỀU ĐANG ĐƯỢC BẢO VỆ: các CHỈ SỐ VÙNG của FaceMesh (faceOval / mắt / môi) là hằng
 * số của MediaPipe được CHÉP vào mã. Chép sai một số thì mặt nạ lệch chỗ, mà đọc code
 * KHÔNG THỂ thấy sai — chỉ nhìn ảnh mới biết. Vì vậy test này không kiểm "có chép đúng
 * không", nó kiểm HÌNH HỌC trên landmark THẬT:
 *   - mắt và miệng phải NẰM TRONG đường viền mặt
 *   - miệng phải ở DƯỚI mắt
 *   - viền môi trong phải nằm trong viền môi ngoài
 *   - cằm phải là điểm THẤP NHẤT, trán là điểm CAO NHẤT của viền mặt
 * Những bất biến này đúng với MỌI khuôn mặt người, nên sai chỉ số là đổ ngay.
 *
 * Dữ liệu mẫu `tests/fixtures/face_landmarks.json` là landmark THẬT trích từ video của
 * dự án (MediaPipe FaceMesh, refine_landmarks) — không phải số bịa.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const Retouch = require(path.join(PROJECT_ROOT, 'static', 'js', 'retouch.js'));
const FIXTURE = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'tests', 'fixtures', 'face_landmarks.json'), 'utf8'));
const FACE = FIXTURE.face;

// --- tiện ích hình học -----------------------------------------------------

// Điểm nằm trong polygon (ray casting).
function inPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > pt.y) !== (b.y > pt.y)
            && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}
const centroid = (poly) => ({
    x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
    y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
});

// --- 1. Dữ liệu mẫu đúng dạng ----------------------------------------------

function testFixtureShape() {
    assert.strictEqual(FIXTURE.landmark_count, Retouch.LANDMARK_COUNT,
        `engine mong ${Retouch.LANDMARK_COUNT} điểm, dữ liệu mẫu có ${FIXTURE.landmark_count}`);
    assert.strictEqual(FACE.length, 478);
    FACE.forEach((p, i) => {
        assert.ok(Array.isArray(p) && p.length === 2, `điểm ${i} sai dạng`);
        assert.ok(p[0] >= -0.5 && p[0] <= 1.5 && p[1] >= -0.5 && p[1] <= 1.5,
            `điểm ${i} nằm ngoài dải chuẩn hoá: ${p}`);
    });
    console.log(`  ok  dữ liệu mẫu: ${FACE.length} điểm chuẩn hoá 0..1`);
}

// --- 2. CHỈ SỐ VÙNG — kiểm bằng hình học, không tin vào việc chép đúng -------

function testRegionsAreAnatomicallySane() {
    const oval = Retouch.regionPolygon(FACE, 'faceOval');
    const le = Retouch.regionPolygon(FACE, 'leftEye');
    const re = Retouch.regionPolygon(FACE, 'rightEye');
    const outer = Retouch.regionPolygon(FACE, 'lipsOuter');
    const inner = Retouch.regionPolygon(FACE, 'lipsInner');

    [['faceOval', oval], ['leftEye', le], ['rightEye', re],
     ['lipsOuter', outer], ['lipsInner', inner]].forEach(([n, poly]) => {
        assert.ok(poly.length >= 3, `vùng ${n} không dựng được polygon`);
    });

    // Mắt và miệng PHẢI nằm trong viền mặt.
    [['leftEye', le], ['rightEye', re], ['lipsOuter', outer]].forEach(([n, poly]) => {
        const c = centroid(poly);
        assert.ok(inPolygon(c, oval), `tâm vùng ${n} phải nằm TRONG faceOval — chỉ số sai?`);
    });

    // Miệng ở DƯỚI mắt (y tăng xuống dưới trong toạ độ ảnh).
    const eyeY = (centroid(le).y + centroid(re).y) / 2;
    const mouthY = centroid(outer).y;
    assert.ok(mouthY > eyeY + 0.02,
        `miệng phải ở dưới mắt: mắt y=${eyeY.toFixed(3)} miệng y=${mouthY.toFixed(3)}`);

    // Hai mắt phải TÁCH BIỆT theo trục ngang.
    const dx = Math.abs(centroid(le).x - centroid(re).x);
    assert.ok(dx > 0.02, `hai mắt phải cách nhau theo trục x, đo được ${dx.toFixed(3)}`);

    // Viền môi TRONG nằm trong viền môi NGOÀI (nếu ngược là đổi chỗ 2 hằng số).
    assert.ok(inPolygon(centroid(inner), outer), 'lipsInner phải nằm trong lipsOuter');
    const areaOf = (poly) => {
        let a = 0;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
        }
        return Math.abs(a / 2);
    };
    assert.ok(areaOf(inner) < areaOf(outer),
        `diện tích lipsInner (${areaOf(inner).toExponential(2)}) phải NHỎ HƠN lipsOuter (${areaOf(outer).toExponential(2)})`);

    console.log('  ok  vùng khớp giải phẫu: mắt/miệng trong viền mặt, miệng dưới mắt, môi trong ⊂ môi ngoài');
}

/* Điểm mốc lẻ (cằm/trán) phải đúng là cực trị của viền mặt. */
function testLandmarkPointsAreExtremes() {
    const oval = Retouch.regionPolygon(FACE, 'faceOval');
    const chin = Retouch.pointAt(FACE, Retouch.POINTS.chin);
    const brow = Retouch.pointAt(FACE, Retouch.POINTS.forehead);
    const maxY = Math.max(...oval.map((p) => p.y));
    const minY = Math.min(...oval.map((p) => p.y));
    assert.ok(Math.abs(chin.y - maxY) < 1e-6, `POINTS.chin phải là điểm THẤP NHẤT của faceOval`);
    assert.ok(Math.abs(brow.y - minY) < 1e-6, `POINTS.forehead phải là điểm CAO NHẤT của faceOval`);

    // Hai mép má phải nằm hai bên mũi.
    const nose = Retouch.pointAt(FACE, Retouch.POINTS.noseTip);
    const lc = Retouch.pointAt(FACE, Retouch.POINTS.leftCheek);
    const rc = Retouch.pointAt(FACE, Retouch.POINTS.rightCheek);
    assert.ok((lc.x - nose.x) * (rc.x - nose.x) < 0,
        'leftCheek và rightCheek phải nằm HAI BÊN mũi');
    console.log('  ok  điểm mốc: cằm = thấp nhất, trán = cao nhất, 2 má kẹp mũi');
}

// --- 3. Hộp bao & chọn mặt -------------------------------------------------

function testFaceBounds() {
    const tight = Retouch.faceBounds(FACE, 0);
    const padded = Retouch.faceBounds(FACE, 0.12);
    assert.ok(tight.width > 0 && tight.height > 0, 'hộp bao phải có kích thước dương');
    assert.ok(padded.width > tight.width && padded.height > tight.height, 'pad phải nới hộp ra');
    assert.ok(padded.x0 >= 0 && padded.y0 >= 0 && padded.x1 <= 1 && padded.y1 <= 1,
        'hộp bao phải bị kẹp trong khung 0..1');
    // Mọi landmark phải nằm trong hộp chặt.
    FACE.forEach((p, i) => {
        assert.ok(p[0] >= tight.x0 - 1e-6 && p[0] <= tight.x1 + 1e-6
            && p[1] >= tight.y0 - 1e-6 && p[1] <= tight.y1 + 1e-6, `điểm ${i} lọt ngoài hộp bao`);
    });
    // Con số này là cơ sở của kế hoạch EXPORT: chỉ bake vùng mặt thay vì cả khung.
    const frac = padded.width * padded.height;
    console.log(`  ok  hộp bao: mặt chiếm ${(frac * 100).toFixed(1)}% diện tích khung `
        + `-> bake vùng mặt rẻ hơn bake cả khung ~${(1 / frac).toFixed(0)} lần`);
}

/* target='single' phải chọn mặt LỚN NHẤT, không phải mặt đầu tiên — thứ tự MediaPipe
 * trả về không ổn định giữa các frame. */
function testSelectFaces() {
    const small = FACE.map(([x, y]) => [x * 0.3 + 0.6, y * 0.3 + 0.6]);
    // Mặt nhỏ đứng TRƯỚC trong mảng -> lấy [0] là sai.
    const picked = Retouch.selectFaces([small, FACE], 'single');
    assert.strictEqual(picked.length, 1, 'single phải trả đúng 1 mặt');
    const pb = Retouch.faceBounds(picked[0], 0);
    const bb = Retouch.faceBounds(FACE, 0);
    assert.ok(Math.abs(pb.width - bb.width) < 1e-9, 'single phải chọn mặt LỚN NHẤT, không phải mặt đầu tiên');
    assert.strictEqual(Retouch.selectFaces([small, FACE], 'all').length, 2, 'all phải trả mọi mặt');
    assert.strictEqual(Retouch.selectFaces([], 'single').length, 0, 'không có mặt thì trả rỗng');
    console.log('  ok  chọn mặt: single = mặt lớn nhất (không phải phần tử [0]), all = mọi mặt');
}

// --- 4. Mô hình tham số ----------------------------------------------------

function testParamModel() {
    assert.strictEqual(Retouch.PARAMS.length, 13, 'phải có đủ 13 thông số như bảng tham chiếu');
    const kinds = new Set(Retouch.PARAMS.map((p) => p.kind));
    assert.deepStrictEqual([...kinds].sort(), ['color', 'freq', 'warp'],
        'mỗi thông số phải thuộc đúng 1 trong 3 nhóm kỹ thuật');

    assert.ok(Retouch.isIdentity(null), 'null phải là identity');
    assert.ok(Retouch.isIdentity({ enabled: false, params: { smooth: 100 } }),
        'tắt công tắc thì dù kéo hết vẫn phải là identity (không tốn lượt shader)');
    assert.ok(Retouch.isIdentity({ enabled: true }), 'bật mà chưa kéo gì cũng là identity');
    assert.ok(!Retouch.isIdentity({ enabled: true, params: { smooth: 1 } }), 'kéo 1 nấc là KHÔNG identity');
    assert.ok(!Retouch.isIdentity({ enabled: true, skinTone: '#c08050', skinToneAmount: 30 }),
        'chỉ đổi tông da cũng KHÔNG identity');

    // normalize phải kẹp và làm tròn
    const n = Retouch.normalize({ enabled: true, params: { smooth: 999, plump: -5, clear: 12.7 }, skinTone: 'xxx' });
    assert.strictEqual(n.params.smooth, 100, 'phải kẹp trần 100');
    assert.strictEqual(n.params.plump, 0, 'thông số 0..100 phải kẹp sàn 0');
    assert.strictEqual(n.params.clear, 13, 'phải làm tròn về số nguyên');
    assert.strictEqual(n.skinTone, '', 'hex sai định dạng phải bị bỏ');
    assert.strictEqual(n.target, 'single', 'target mặc định là single');
    console.log('  ok  mô hình tham số: 13 thông số / 3 nhóm, isIdentity + normalize đúng');
}

// --- 5. Biến dạng hình học -------------------------------------------------

function testWarp() {
    // Không kéo gì -> KHÔNG có điểm điều khiển -> UV giữ nguyên tuyệt đối.
    assert.strictEqual(Retouch.warpControlPoints(FACE, {}).length, 0, 'tham số 0 thì không có điểm điều khiển');
    const [u0, v0] = Retouch.displaceUv(0.5, 0.5, []);
    assert.ok(u0 === 0.5 && v0 === 0.5, 'không có điểm điều khiển thì UV bất biến');

    const lift = Retouch.warpControlPoints(FACE, { facelift: 100 });
    assert.ok(lift.length > 0, 'Thon mặt phải sinh điểm điều khiển');
    // THON MẶT: điểm trên quai hàm phải bị kéo VÀO TRONG (về phía trục dọc qua mặt).
    const oval = Retouch.regionPolygon(FACE, 'faceOval');
    const cx = centroid(oval).x;
    let checked = 0;
    Retouch.JAW_LEFT.concat(Retouch.JAW_RIGHT).forEach((i) => {
        const p = Retouch.pointAt(FACE, i);
        const [u] = Retouch.displaceUv(p.x, p.y, lift);
        // Lấy mẫu ngược: UV nguồn dịch RA NGOÀI nghĩa là ảnh co VÀO TRONG.
        const movedOutward = Math.abs(u - cx) > Math.abs(p.x - cx);
        assert.ok(movedOutward, `điểm hàm ${i}: Thon mặt phải làm ảnh co vào trong`);
        checked++;
    });

    // Biên độ phải THEO TỈ LỆ MẶT: mặt nhỏ đi một nửa thì dịch chuyển cũng nhỏ đi ~nửa.
    const half = FACE.map(([x, y]) => [x * 0.5, y * 0.5]);
    const liftHalf = Retouch.warpControlPoints(half, { facelift: 100 });
    const mag = (cs) => Math.max(...cs.map((c) => Math.hypot(c.dx, c.dy)));
    const ratio = mag(lift) / mag(liftHalf);
    assert.ok(Math.abs(ratio - 2) < 0.15,
        `biên độ phải tỉ lệ với cỡ mặt (mong đợi ~2x, đo được ${ratio.toFixed(2)}x)`);

    // Ngoài bán kính ảnh hưởng thì KHÔNG được đụng vào — nếu không, biến dạng lan ra
    // cả hậu cảnh.
    const far = Retouch.displaceUv(0.02, 0.02, lift);
    assert.ok(Math.abs(far[0] - 0.02) < 1e-9 && Math.abs(far[1] - 0.02) < 1e-9,
        'điểm xa mặt phải không bị dịch');
    console.log(`  ok  biến dạng: ${checked} điểm hàm co đúng chiều, biên độ tỉ lệ cỡ mặt, không lan ra ngoài`);
}

// --- 6. Mặt nạ vùng --------------------------------------------------------

/* Mặt nạ DA phải KHOÉT mắt / chân mày / khoang miệng. Không khoét thì làm mịn lên mắt
 * (mất nét mi), làm trắng lên chân mày (bay mày) — đúng khác biệt giữa retouch và
 * "blur cả mặt". */
function testMaskPolygons() {
    const m = Retouch.maskPolygons(FACE);
    assert.ok(m, 'phải dựng được mặt nạ từ landmark hợp lệ');
    assert.deepStrictEqual(Object.keys(m).sort(), [...Retouch.MASK_CHANNELS].sort(),
        'phải có đủ 4 kênh mặt nạ');

    assert.ok(m.skin.outline.length >= 3, 'mặt nạ da phải có viền ngoài');
    assert.strictEqual(m.skin.holes.length, 5,
        'da phải khoét đúng 5 vùng: 2 mắt + 2 chân mày + khoang miệng');
    // Mỗi lỗ khoét phải THỰC SỰ nằm trong viền mặt.
    m.skin.holes.forEach((h, i) => {
        assert.ok(inPolygon(centroid(h), m.skin.outline), `lỗ khoét #${i} phải nằm trong viền mặt`);
    });

    assert.strictEqual(m.eyes.parts.length, 2, 'mặt nạ mắt phải có 2 phần');
    assert.strictEqual(m.underEye.parts.length, 2, 'mặt nạ quầng thâm phải có 2 phần');
    assert.ok(m.teeth.outline.length >= 3, 'mặt nạ răng = viền môi trong');
    console.log('  ok  mặt nạ: 4 kênh, da khoét đúng 5 vùng, mọi lỗ nằm trong viền mặt');
}

/* Vùng quầng thâm KHÔNG có sẵn trong bộ chỉ số MediaPipe — nó được DỰNG từ 2 vòng mí
 * dưới. Dựng sai là polygon tự cắt hoặc nằm nhầm chỗ, nên phải kiểm hình học. */
function testUnderEyeGeometry() {
    const oval = Retouch.regionPolygon(FACE, 'faceOval');
    ['left', 'right'].forEach((side) => {
        const poly = Retouch.underEyePolygon(FACE, side);
        assert.ok(poly.length >= 6, `quầng thâm ${side} phải dựng được polygon`);
        const c = centroid(poly);
        assert.ok(inPolygon(c, oval), `quầng thâm ${side} phải nằm TRONG viền mặt`);
        const eye = Retouch.regionPolygon(FACE, side === 'left' ? 'leftEye' : 'rightEye');
        assert.ok(c.y > centroid(eye).y,
            `quầng thâm ${side} phải nằm DƯỚI mắt (đo được ${c.y.toFixed(3)} vs ${centroid(eye).y.toFixed(3)})`);
        // Không tự cắt: diện tích theo công thức giày buộc phải > 0 đáng kể.
        let a = 0;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
        }
        assert.ok(Math.abs(a / 2) > 1e-6, `quầng thâm ${side} có diện tích ~0 -> polygon tự cắt?`);
    });
    console.log('  ok  quầng thâm: dựng từ 2 vòng mí dưới, nằm dưới mắt và trong viền mặt');
}

// --- 7. Nhóm phép màu ------------------------------------------------------

const ZERO_MASK = { skin: 0, eyes: 0, teeth: 0, underEye: 0 };
const SKIN_PX = [0.72, 0.55, 0.46];

/* HỢP ĐỒNG QUAN TRỌNG NHẤT của nhóm color: NGOÀI mặt nạ thì pixel BẤT BIẾN TUYỆT ĐỐI.
 * Sai điều này là retouch rỉ ra hậu cảnh — lỗi thấy ngay mà rất dễ lọt nếu quên nhân
 * trọng số ở một phép nào đó. */
function testColorOpsRespectMask() {
    const full = { whitening: 100, darkCircles: 100, brightEye: 100, whiteTeeth: 100 };
    const out = Retouch.applyColorOps(SKIN_PX, {
        enabled: true, params: full, skinTone: '#c08050', skinToneAmount: 100,
    }, ZERO_MASK);
    out.forEach((v, i) => {
        assert.ok(Math.abs(v - SKIN_PX[i]) < 1e-12,
            `kéo hết mọi slider nhưng mặt nạ = 0 thì kênh ${i} phải BẤT BIẾN (${v} vs ${SKIN_PX[i]})`);
    });
    // Tham số = 0 thì dù mặt nạ = 1 cũng bất biến.
    const idle = Retouch.applyColorOps(SKIN_PX, { enabled: true },
        { skin: 1, eyes: 1, teeth: 1, underEye: 1 });
    idle.forEach((v, i) => assert.ok(Math.abs(v - SKIN_PX[i]) < 1e-12, 'tham số 0 phải bất biến'));
    console.log('  ok  ngoài mặt nạ (và tham số 0) -> pixel bất biến tuyệt đối');
}

/* Mỗi phép phải đi ĐÚNG CHIỀU với tên của nó — cùng bài học với nhóm Sắc của
 * auto-grade: giá trị hợp lệ và khác nhau KHÔNG chứng minh hướng đúng. */
function testColorOpsDirection() {
    const L = (c) => Retouch.lumaOf(c[0], c[1], c[2]);
    const sat = (c) => Math.max(...c) - Math.min(...c);

    // Trắng da -> SÁNG hơn
    const wh = Retouch.applyColorOps(SKIN_PX, { enabled: true, params: { whitening: 100 } },
        { ...ZERO_MASK, skin: 1 });
    assert.ok(L(wh) > L(SKIN_PX) + 0.02, `Trắng da phải làm sáng hơn (${L(wh).toFixed(3)} vs ${L(SKIN_PX).toFixed(3)})`);

    // Quầng thâm -> nâng vùng TỐI nhiều hơn vùng sáng
    const darkPx = [0.28, 0.22, 0.24], litPx = [0.72, 0.66, 0.68];
    const p = { enabled: true, params: { darkCircles: 100 } }, mk = { ...ZERO_MASK, underEye: 1 };
    const gainDark = L(Retouch.applyColorOps(darkPx, p, mk)) - L(darkPx);
    const gainLit = L(Retouch.applyColorOps(litPx, p, mk)) - L(litPx);
    assert.ok(gainDark > gainLit * 1.5,
        `Quầng thâm phải nâng chỗ TỐI nhiều hơn chỗ sáng (${gainDark.toFixed(3)} vs ${gainLit.toFixed(3)})`);

    // Trắng răng -> GIẢM bão hoà (răng ố là ngả vàng) và tăng sáng
    const toothPx = [0.78, 0.72, 0.52];
    const tw = Retouch.applyColorOps(toothPx, { enabled: true, params: { whiteTeeth: 100 } },
        { ...ZERO_MASK, teeth: 1 });
    assert.ok(sat(tw) < sat(toothPx) * 0.6, `Trắng răng phải giảm bão hoà (${sat(tw).toFixed(3)} vs ${sat(toothPx).toFixed(3)})`);
    assert.ok(L(tw) > L(toothPx), 'Trắng răng phải sáng hơn');

    // Sáng mắt -> TĂNG TƯƠNG PHẢN: lòng trắng sáng lên, con ngươi KHÔNG sáng theo
    const sclera = [0.82, 0.82, 0.84], pupil = [0.10, 0.10, 0.12];
    const pe = { enabled: true, params: { brightEye: 100 } }, me = { ...ZERO_MASK, eyes: 1 };
    assert.ok(L(Retouch.applyColorOps(sclera, pe, me)) > L(sclera), 'Sáng mắt phải làm lòng trắng sáng hơn');
    assert.ok(L(Retouch.applyColorOps(pupil, pe, me)) < L(pupil) + 0.03,
        'Sáng mắt KHÔNG được làm con ngươi sáng lên (mắt sẽ đục)');
    console.log('  ok  hướng đúng: trắng da sáng · quầng thâm nâng chỗ tối · răng giảm bão hoà · mắt tăng tương phản');
}

/* Tông da phải GIỮ ĐỘ SÁNG của pixel — trộn thẳng sang màu đích là mặt bẹt như dán
 * giấy màu, mất hết khối sáng tối. */
function testSkinTonePreservesLuma() {
    const mask = { ...ZERO_MASK, skin: 1 };
    const cfg = { enabled: true, skinTone: '#8d5524', skinToneAmount: 100 };
    [[0.85, 0.70, 0.60], [0.55, 0.42, 0.34], [0.30, 0.22, 0.18]].forEach((px) => {
        const out = Retouch.applyColorOps(px, cfg, mask);
        const before = Retouch.lumaOf(px[0], px[1], px[2]);
        const after = Retouch.lumaOf(out[0], out[1], out[2]);
        assert.ok(Math.abs(after - before) < 0.03,
            `đổi tông da phải giữ độ sáng: ${before.toFixed(3)} -> ${after.toFixed(3)}`);
    });
    // Hex sai định dạng -> không đổi gì (normalize đã loại, nhưng chốt lại ở đây)
    const bad = Retouch.applyColorOps(SKIN_PX, { enabled: true, skinTone: 'đỏ', skinToneAmount: 100 }, mask);
    bad.forEach((v, i) => assert.ok(Math.abs(v - SKIN_PX[i]) < 1e-12, 'hex sai thì không được đổi màu'));
    console.log('  ok  tông da: giữ nguyên độ sáng (không bẹt khối), hex sai thì bỏ qua');
}

/* Kết quả luôn nằm trong [0,1] — tràn dải là ra vệt cháy/đen trên mặt. */
function testColorOpsStayInGamut() {
    const extremes = [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0.98, 0.97, 0.2], [0.02, 0.01, 0.03]];
    const cfg = {
        enabled: true,
        params: { whitening: 100, darkCircles: 100, brightEye: 100, whiteTeeth: 100 },
        skinTone: '#ffd7b0', skinToneAmount: 100,
    };
    const full = { skin: 1, eyes: 1, teeth: 1, underEye: 1 };
    extremes.forEach((px) => {
        Retouch.applyColorOps(px, cfg, full).forEach((v, i) => {
            assert.ok(Number.isFinite(v) && v >= 0 && v <= 1,
                `kênh ${i} tràn dải với pixel ${JSON.stringify(px)}: ${v}`);
        });
    });
    console.log('  ok  mọi tổ hợp cực trị vẫn nằm trong [0,1]');
}

// --- 8. Nhóm tách tần số ---------------------------------------------------

// Dựng 3 tầng cho một pixel: gốc, mờ nhỏ, mờ lớn.
// `hi` = gai tần số cao (mụn/lỗ chân lông), `md` = tầng trung (nếp nhăn).
function layers(base, hi = 0, md = 0) {
    const lc = base.slice();
    const lf = base.map((v) => v + md);
    const c = lf.map((v) => v + hi);
    return { orig: c, lowFine: lf, lowCoarse: lc };
}
const SKIN_ONLY = { skin: 1, nasolabial: 0 };
const NO_MASK = { skin: 0, nasolabial: 0 };

/* BẤT BIẾN NỀN TẢNG: tham số 0 thì low + mid + high phải TÁI TẠO ĐÚNG ảnh gốc.
 * Nếu phép tách/ghép sai thì mọi thứ dựng trên nó đều sai một cách âm thầm. */
function testFreqReconstructsExactly() {
    const L = layers([0.5, 0.42, 0.38], 0.07, -0.05);
    const out = Retouch.applyFreqOps(L.orig, L.lowFine, L.lowCoarse, { enabled: true }, SKIN_ONLY);
    out.forEach((v, i) => assert.ok(Math.abs(v - L.orig[i]) < 1e-12,
        `tham số 0 phải tái tạo đúng gốc: kênh ${i} ${v} vs ${L.orig[i]}`));
    // Ngoài mặt nạ, kéo hết mọi slider cũng phải bất biến.
    const full = { enabled: true, params: { smooth: 100, clearBlemishes: 100, clear: 100,
        dewrinkle: 100, even: 100, sparkly: 100, smileLines: 100 } };
    Retouch.applyFreqOps(L.orig, L.lowFine, L.lowCoarse, full, NO_MASK).forEach((v, i) =>
        assert.ok(Math.abs(v - L.orig[i]) < 1e-12, `ngoài mặt nạ phải bất biến: kênh ${i}`));
    console.log('  ok  tách tần số tái tạo đúng gốc; ngoài mặt nạ bất biến tuyệt đối');
}

/* Mịn da nén ĐỐI XỨNG; Nét căng KHUẾCH ĐẠI — hai chiều ngược nhau trên cùng tầng. */
function testSmoothAndClearAreOpposite() {
    const amp = (params, hi) => {
        const L = layers([0.55, 0.45, 0.40], hi, 0);
        const out = Retouch.applyFreqOps(L.orig, L.lowFine, L.lowCoarse,
            { enabled: true, params }, SKIN_ONLY);
        return out[0] - L.lowFine[0];   // biên độ gai còn lại
    };
    const raw = amp({}, 0.09);
    const sm = amp({ smooth: 100 }, 0.09);
    const cl = amp({ clear: 100 }, 0.09);
    assert.ok(Math.abs(sm) < Math.abs(raw) * 0.2, `Mịn da phải nén gai: ${raw.toFixed(4)} -> ${sm.toFixed(4)}`);
    assert.ok(Math.abs(cl) > Math.abs(raw) * 1.3, `Nét căng phải khuếch đại gai: ${raw.toFixed(4)} -> ${cl.toFixed(4)}`);
    console.log(`  ok  Mịn da nén gai (${raw.toFixed(3)}→${sm.toFixed(3)}), Nét căng khuếch đại (→${cl.toFixed(3)})`);
}

/* XOÁ KHUYẾT ĐIỂM khác MỊN DA ở chỗ nó BẤT ĐỐI XỨNG: chỉ hạ gai ÂM (chỗ TỐI hơn xung
 * quanh = mụn/đốm), giữ nguyên gai DƯƠNG (lỗ chân lông, ánh sáng trên da) nên da vẫn
 * ra da. Nếu hai phép cho kết quả như nhau thì một trong hai là thừa. */
function testBlemishIsAsymmetric() {
    const run = (params, hi) => {
        const L = layers([0.55, 0.45, 0.40], hi, 0);
        return Retouch.applyFreqOps(L.orig, L.lowFine, L.lowCoarse,
            { enabled: true, params }, SKIN_ONLY)[0] - L.lowFine[0];
    };
    const darkSpot = -0.10, brightSpot = 0.10;
    const bDark = run({ clearBlemishes: 100 }, darkSpot);
    const bBright = run({ clearBlemishes: 100 }, brightSpot);
    assert.ok(Math.abs(bDark) < Math.abs(darkSpot) * 0.2,
        `Xoá khuyết điểm phải hạ gai TỐI: ${darkSpot} -> ${bDark.toFixed(4)}`);
    assert.ok(Math.abs(bBright - brightSpot) < 1e-9,
        `Xoá khuyết điểm phải GIỮ NGUYÊN gai SÁNG: ${brightSpot} -> ${bBright.toFixed(4)}`);
    // Còn Mịn da thì hạ CẢ HAI -> hai phép thực sự khác nhau.
    const sBright = run({ smooth: 100 }, brightSpot);
    assert.ok(Math.abs(sBright) < Math.abs(brightSpot) * 0.2,
        'Mịn da phải hạ cả gai sáng (khác Xoá khuyết điểm)');
    console.log('  ok  Xoá khuyết điểm bất đối xứng (chỉ hạ đốm TỐI) — khác thật với Mịn da');
}

/* Xoá nếp nhăn tác động tầng TRUNG, không phải tầng CAO. Nén nhầm tầng là xoá mất kết
 * cấu da mà nếp nhăn vẫn còn nguyên. */
function testDewrinkleHitsMidBand() {
    const withMid = layers([0.5, 0.42, 0.38], 0, 0.08);
    const withHigh = layers([0.5, 0.42, 0.38], 0.08, 0);
    const p = { enabled: true, params: { dewrinkle: 100 } };
    const dMid = Retouch.applyFreqOps(withMid.orig, withMid.lowFine, withMid.lowCoarse, p, SKIN_ONLY)[0]
        - withMid.orig[0];
    const dHigh = Retouch.applyFreqOps(withHigh.orig, withHigh.lowFine, withHigh.lowCoarse, p, SKIN_ONLY)[0]
        - withHigh.orig[0];
    assert.ok(Math.abs(dMid) > 0.03, `Xoá nếp nhăn phải tác động tầng TRUNG (đo ${dMid.toFixed(4)})`);
    assert.ok(Math.abs(dHigh) < 1e-9, `Xoá nếp nhăn KHÔNG được đụng tầng CAO (đo ${dHigh.toFixed(4)})`);

    // Nếp cười dùng mặt nạ RIÊNG -> mặt nạ da không kích hoạt nó.
    const pf = { enabled: true, params: { smileLines: 100 } };
    const noFold = Retouch.applyFreqOps(withMid.orig, withMid.lowFine, withMid.lowCoarse, pf, SKIN_ONLY);
    assert.ok(Math.abs(noFold[0] - withMid.orig[0]) < 1e-12,
        'Nếp cười chỉ chạy trong mặt nạ nasolabial, không theo mặt nạ da');
    const inFold = Retouch.applyFreqOps(withMid.orig, withMid.lowFine, withMid.lowCoarse, pf,
        { skin: 1, nasolabial: 1 });
    assert.ok(Math.abs(inFold[0] - withMid.orig[0]) > 0.03, 'trong dải nếp cười thì phải có tác dụng');
    console.log('  ok  Xoá nếp nhăn ở tầng TRUNG (không đụng tầng cao); Nếp cười theo mặt nạ riêng');
}

/* Đều màu kéo SẮC về trung bình cục bộ nhưng GIỮ độ sáng — khác hẳn làm mịn. */
function testEvenReducesChromaKeepsLuma() {
    const patchy = [0.62, 0.40, 0.36];   // mảng đỏ trên da
    const L = layers(patchy, 0.02, 0.01);
    const out = Retouch.applyFreqOps(L.orig, L.lowFine, L.lowCoarse,
        { enabled: true, params: { even: 100 } }, SKIN_ONLY);
    const sat = (c) => Math.max(...c) - Math.min(...c);
    assert.ok(sat(out) < sat(L.orig) * 0.85,
        `Đều màu phải giảm chênh lệch kênh: ${sat(L.orig).toFixed(3)} -> ${sat(out).toFixed(3)}`);
    const dl = Math.abs(Retouch.lumaOf(...out) - Retouch.lumaOf(...L.orig));
    assert.ok(dl < 0.03, `Đều màu phải giữ độ sáng (lệch ${dl.toFixed(4)})`);
    console.log('  ok  Đều màu: giảm loang màu, giữ độ sáng');
}

/* Da căng bóng nâng vùng SÁNG nhiều hơn vùng tối — nâng đều chỉ làm bệt. */
function testSparkleFavoursHighlights() {
    const gain = (base) => {
        const L = layers(base, 0.01, 0);
        const out = Retouch.applyFreqOps(L.orig, L.lowFine, L.lowCoarse,
            { enabled: true, params: { sparkly: 100 } }, SKIN_ONLY);
        return Retouch.lumaOf(...out) - Retouch.lumaOf(...L.orig);
    };
    const bright = gain([0.80, 0.76, 0.72]);
    const dark = gain([0.30, 0.26, 0.24]);
    assert.ok(bright > dark * 3 + 0.001,
        `Da căng bóng phải nâng vùng sáng nhiều hơn hẳn (${bright.toFixed(4)} vs ${dark.toFixed(4)})`);
    console.log(`  ok  Da căng bóng: nâng vùng sáng ${bright.toFixed(3)} vs vùng tối ${dark.toFixed(3)}`);
}

function testFreqStaysInGamut() {
    const cfg = { enabled: true, params: { smooth: 100, clearBlemishes: 100, clear: 100,
        dewrinkle: 100, even: 100, sparkly: 100, smileLines: 100 } };
    const mask = { skin: 1, nasolabial: 1 };
    [[0, 0, 0], [1, 1, 1], [0.99, 0.02, 0.5], [0.5, 0.5, 0.5]].forEach((base) => {
        [-0.3, 0, 0.3].forEach((hi) => [-0.3, 0, 0.3].forEach((md) => {
            const L = layers(base, hi, md);
            Retouch.applyFreqOps(L.orig, L.lowFine, L.lowCoarse, cfg, mask).forEach((v, i) => {
                assert.ok(Number.isFinite(v) && v >= 0 && v <= 1,
                    `tràn dải: base=${base} hi=${hi} md=${md} kênh ${i} = ${v}`);
            });
        }));
    });
    console.log('  ok  mọi tổ hợp tầng/cực trị vẫn nằm trong [0,1]');
}

/* Bán kính làm mờ phải theo TỈ LỆ CỠ MẶT — điều kiện để preview proxy khớp bản xuất. */
function testFreqRadiiScale() {
    const big = Retouch.freqRadii(FACE, 1080, 1920);
    const small = Retouch.freqRadii(FACE, 540, 960);
    assert.ok(big.fine > 0 && big.coarse > big.fine, 'bán kính thô phải lớn hơn bán kính mịn');
    assert.ok(Math.abs(big.fine / small.fine - 2) < 0.05,
        `bán kính phải tỉ lệ với số pixel khung (mong ~2x, đo ${(big.fine / small.fine).toFixed(2)}x)`);
    const half = FACE.map(([x, y]) => [x * 0.5, y * 0.5]);
    const rHalf = Retouch.freqRadii(half, 1080, 1920);
    assert.ok(Math.abs(big.fine / rHalf.fine - 2) < 0.06,
        `bán kính phải tỉ lệ với CỠ MẶT (mong ~2x, đo ${(big.fine / rHalf.fine).toFixed(2)}x)`);

    /* TRỊ TUYỆT ĐỐI, không chỉ tỉ lệ. Bản đầu chỉ kiểm tỉ lệ nên LỌT lỗi đơn vị: hàm
     * nhân tỉ lệ theo CHIỀU RỘNG với pixel CHIỀU CAO, ra bán kính thô 13% bề ngang mặt
     * thay vì 8% -> mặt nhoè quá tay. Chỉ nhìn ảnh mới phát hiện. Nay chốt bằng số. */
    [[400, 712], [1080, 1920], [1728, 3072]].forEach(([w, h]) => {
        const r = Retouch.freqRadii(FACE, w, h);
        assert.ok(r.facePx > 0, 'phải trả về bề ngang mặt tính bằng pixel');
        const coarsePct = r.coarse / r.facePx;
        const finePct = r.fine / r.facePx;
        assert.ok(Math.abs(coarsePct - Retouch.FREQ_COARSE_FRAC) < 0.005,
            `[${w}x${h}] bán kính thô phải = ${(Retouch.FREQ_COARSE_FRAC * 100).toFixed(1)}% bề ngang mặt, `
            + `đo được ${(coarsePct * 100).toFixed(1)}%`);
        assert.ok(Math.abs(finePct - Retouch.FREQ_FINE_FRAC) < 0.005,
            `[${w}x${h}] bán kính mịn sai tỉ lệ: ${(finePct * 100).toFixed(1)}%`);
    });
    console.log('  ok  bán kính = đúng % bề ngang mặt ở mọi kích thước khung (kiểm trị tuyệt đối)');
}

/* Dải nếp cười dựng bằng hình học -> phải kiểm nó rơi đúng chỗ trên mặt THẬT. */
function testNasolabialGeometry() {
    const oval = Retouch.regionPolygon(FACE, 'faceOval');
    const nose = Retouch.pointAt(FACE, Retouch.POINTS.noseTip);
    const eyeY = (centroid(Retouch.regionPolygon(FACE, 'leftEye')).y
        + centroid(Retouch.regionPolygon(FACE, 'rightEye')).y) / 2;
    ['left', 'right'].forEach((side) => {
        const poly = Retouch.nasolabialPolygon(FACE, side);
        assert.strictEqual(poly.length, 4, `dải nếp cười ${side} phải là tứ giác`);
        const c = centroid(poly);
        assert.ok(inPolygon(c, oval), `dải nếp cười ${side} phải nằm TRONG viền mặt`);
        assert.ok(c.y > eyeY, `dải nếp cười ${side} phải nằm DƯỚI mắt`);
        const corner = Retouch.pointAt(FACE, side === 'left' ? Retouch.POINTS.mouthLeft : Retouch.POINTS.mouthRight);
        // Phải nằm về ĐÚNG bên (cùng phía với khoé miệng tương ứng, so với mũi).
        assert.ok((c.x - nose.x) * (corner.x - nose.x) > 0,
            `dải nếp cười ${side} nằm nhầm bên mặt`);
    });
    // Hai dải phải ở hai bên khác nhau.
    const cl = centroid(Retouch.nasolabialPolygon(FACE, 'left'));
    const cr = centroid(Retouch.nasolabialPolygon(FACE, 'right'));
    assert.ok((cl.x - nose.x) * (cr.x - nose.x) < 0, 'hai dải nếp cười phải nằm hai bên mũi');
    console.log('  ok  dải nếp cười: trong viền mặt, dưới mắt, đúng bên (dựng bằng hình học)');
}

// --- 9. Biến dạng: tính đẳng hướng & chống gấp ảnh -------------------------

// Tỉ lệ khung của footage dự án (dọc) — ca khắc nghiệt nhất cho lỗi elip.
const ASPECT_PORTRAIT = 1728 / 3072;

/* VÙNG ẢNH HƯỞNG PHẢI TRÒN TRONG KHÔNG GIAN PIXEL, không tròn trong UV.
 * Bản Phase 1 đo khoảng cách thẳng trên UV nên trên video dọc 1728x3072 vùng ảnh
 * hưởng hoá ELIP — biến dạng bè ngang, và khác nhau giữa video ngang/dọc.
 * Test cũ không bắt được vì chỉ kiểm CHIỀU và độ lớn. */
function testWarpIsIsotropicInPixelSpace() {
    const c = [{ x: 0.5, y: 0.5, dx: 0.02, dy: 0, radius: 0.10 }];
    const A = ASPECT_PORTRAIT;
    // Hai điểm cách tâm CÙNG khoảng cách PIXEL nhưng theo hai trục khác nhau.
    // Trong UV: bước theo x phải chia cho aspect để ra cùng cự ly pixel.
    const dPix = 0.05;
    const alongX = Retouch.displaceUv(0.5 + dPix / A, 0.5, c, A);
    const alongY = Retouch.displaceUv(0.5, 0.5 + dPix, c, A);
    const magX = Math.hypot(alongX[0] - (0.5 + dPix / A), alongX[1] - 0.5);
    const magY = Math.hypot(alongY[0] - 0.5, alongY[1] - (0.5 + dPix));
    assert.ok(magX > 1e-6, 'bối cảnh: điểm thử phải nằm trong vùng ảnh hưởng');
    assert.ok(Math.abs(magX - magY) < magX * 0.02,
        `vùng ảnh hưởng phải TRÒN trong không gian pixel: theo x ${magX.toFixed(5)} vs theo y ${magY.toFixed(5)}`);

    // Và phải KHÁC kết quả khi bỏ qua aspect -> chứng tỏ phép thử thật sự phân biệt.
    const naive = Retouch.displaceUv(0.5 + dPix / A, 0.5, c, 1);
    const magNaive = Math.hypot(naive[0] - (0.5 + dPix / A), naive[1] - 0.5);
    assert.ok(Math.abs(magNaive - magY) > magY * 0.05,
        'bối cảnh hỏng: bỏ qua aspect mà kết quả không đổi -> phép thử vô nghĩa');
    console.log('  ok  vùng ảnh hưởng tròn trong không gian PIXEL (không bị elip trên video dọc)');
}

/* CHỒNG ĐIỂM ĐIỀU KHIỂN KHÔNG ĐƯỢC CỘNG DỒN VÔ HẠN.
 * JAW_LEFT có 5 điểm cùng hướng, bán kính lớn nên phủ lên nhau gần hết. Cộng thẳng
 * thì dịch chuyển tổng gấp ~5 lần một điểm -> ảnh gập lên chính nó. */
function testOverlappingControlsDoNotPileUp() {
    const one = [{ x: 0.5, y: 0.5, dx: 0.03, dy: 0, radius: 0.2 }];
    const five = Array.from({ length: 5 }, () => ({ x: 0.5, y: 0.5, dx: 0.03, dy: 0, radius: 0.2 }));
    const mag = (cs) => {
        const p = Retouch.displaceUv(0.5, 0.5, cs, 1);
        return Math.hypot(p[0] - 0.5, p[1] - 0.5);
    };
    const m1 = mag(one), m5 = mag(five);
    assert.ok(Math.abs(m5 - m1) < m1 * 0.02,
        `5 điểm trùng nhau phải cho dịch chuyển NHƯ 1 điểm (${m1.toFixed(5)} vs ${m5.toFixed(5)}), `
        + 'không phải gấp 5 lần');
    console.log(`  ok  điểm điều khiển chồng nhau không cộng dồn (${m1.toFixed(4)} ≈ ${m5.toFixed(4)})`);
}

/* KHÔNG ĐƯỢC GẤP ẢNH ở mức kéo HẾT slider — gấp ảnh = mép hàm rách/nhoè, hỏng hóc
 * đặc trưng của warp làm ẩu và nhìn công thức không thấy được. */
function testWarpNeverFolds() {
    const bounds = Retouch.faceBounds(FACE, 0.35);   // nới rộng để phủ cả vùng ảnh hưởng
    const cases = [
        ['Thon mặt 100', { facelift: 100 }],
        ['Đầy đặn 100', { plump: 100 }],
        ['cả hai 100', { facelift: 100, plump: 100 }],
    ];
    for (const [name, params] of cases) {
        const ctrl = Retouch.warpControlPoints(FACE, params);
        assert.ok(ctrl.length > 0, `[${name}] phải có điểm điều khiển`);
        const g = Retouch.warpMaxGradient(ctrl, bounds, ASPECT_PORTRAIT);
        assert.ok(g < 1, `[${name}] trường biến dạng GẤP ẢNH (gradient ${g.toFixed(3)} ≥ 1)`);
        assert.ok(g < 0.6, `[${name}] gradient ${g.toFixed(3)} quá sát ngưỡng gấp — cần giảm biên độ hoặc nới bán kính`);
    }
    // Đối chứng: trường cố ý quá mạnh PHẢI bị bắt, nếu không phép đo vô dụng.
    const evil = [{ x: 0.5, y: 0.5, dx: 0.5, dy: 0, radius: 0.05 }];
    const gEvil = Retouch.warpMaxGradient(evil, { x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.7 }, 1);
    assert.ok(gEvil >= 1, `bối cảnh hỏng: trường quá mạnh mà không bị bắt (${gEvil.toFixed(2)})`);
    console.log('  ok  không gấp ảnh ở mức kéo hết (và phép đo bắt được trường quá mạnh)');
}

/* Biến dạng phải TẮT HẲN ngoài vùng mặt — không được kéo theo hậu cảnh/vai. */
function testWarpConfinedToFace() {
    const ctrl = Retouch.warpControlPoints(FACE, { facelift: 100, plump: 100 });
    const b = Retouch.faceBounds(FACE, 0.6);
    [[0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98], [0.5, 0.02]].forEach(([u, v]) => {
        if (u >= b.x0 && u <= b.x1 && v >= b.y0 && v <= b.y1) return;   // bỏ qua nếu lọt hộp
        const p = Retouch.displaceUv(u, v, ctrl, ASPECT_PORTRAIT);
        assert.ok(Math.abs(p[0] - u) < 1e-12 && Math.abs(p[1] - v) < 1e-12,
            `điểm (${u},${v}) ngoài mặt mà vẫn bị dịch`);
    });
    console.log('  ok  biến dạng tắt hẳn ngoài vùng mặt');
}

// --- 10. Raster hoá mặt nạ -------------------------------------------------

const AR = 1728 / 3072;
const midOf = (a, b) => ({
    x: (Retouch.pointAt(FACE, a).x + Retouch.pointAt(FACE, b).x) / 2,
    y: (Retouch.pointAt(FACE, a).y + Retouch.pointAt(FACE, b).y) / 2,
});

/* Mặt nạ phải rơi ĐÚNG vị trí giải phẫu sau khi raster + làm mượt biên.
 * Đây là phép đo trên MẢNG SỐ THẬT, không phải trên polygon — nó bắt được cả lỗi
 * raster lẫn lỗi làm mượt, thứ mà test polygon ở trên không thấy. */
function testRasterHitsAnatomy() {
    const r = Retouch.rasterizeMasks([FACE], { aspect: AR });
    assert.ok(r.bounds, 'phải trả về hộp bao');
    assert.strictEqual(r.textures.length, Retouch.MASK_TEXTURES, 'phải đủ số texture');
    const at = (p, n) => Retouch.sampleMasks(r, p.x, p.y)[n];

    const cheek = { x: (Retouch.pointAt(FACE, 234).x + Retouch.pointAt(FACE, 1).x) / 2,
                    y: (Retouch.pointAt(FACE, 234).y + Retouch.pointAt(FACE, 1).y) / 2 };
    assert.ok(at(cheek, 'skin') > 0.9, `má phải nằm trọn trong mặt nạ da (${at(cheek, 'skin').toFixed(2)})`);

    const eyeC = centroid(Retouch.regionPolygon(FACE, 'leftEye'));
    assert.ok(at(eyeC, 'skin') < 0.25, `giữa mắt phải bị KHOÉT khỏi mặt nạ da (${at(eyeC, 'skin').toFixed(2)})`);
    assert.ok(at(eyeC, 'eyes') > 0.25, `giữa mắt phải nằm trong mặt nạ mắt (${at(eyeC, 'eyes').toFixed(2)})`);

    // Chân mày mỏng nhất -> ca khó nhất của phép làm mượt.
    const brow = midOf(105, 52);
    assert.ok(at(brow, 'skin') < 0.45,
        `chân mày phải bị khoét đáng kể khỏi mặt nạ da (${at(brow, 'skin').toFixed(2)}) — `
        + 'nếu không thì "trắng da" sẽ bay mất mày');

    const mouth = centroid(Retouch.regionPolygon(FACE, 'lipsInner'));
    assert.ok(at(mouth, 'skin') < 0.15, `khoang miệng phải bị khoét (${at(mouth, 'skin').toFixed(2)})`);
    assert.ok(at(mouth, 'teeth') > 0.5, `khoang miệng phải nằm trong mặt nạ răng (${at(mouth, 'teeth').toFixed(2)})`);

    [[0.02, 0.02], [0.98, 0.02], [0.5, 0.97]].forEach(([u, v]) => {
        Retouch.MASK_CHANNELS.concat(['nasolabial']).forEach((n) => {
            assert.strictEqual(Retouch.sampleMasks(r, u, v)[n], 0,
                `ngoài mặt (${u},${v}) mọi mặt nạ phải = 0`);
        });
    });
    console.log(`  ok  raster khớp giải phẫu: má ${at(cheek, 'skin').toFixed(2)} · mắt ${at(eyeC, 'skin').toFixed(2)} `
        + `· mày ${at(brow, 'skin').toFixed(2)} · miệng ${at(mouth, 'skin').toFixed(2)} · ngoài 0`);
}

/* LỖ KHOÉT phải làm mượt NHẸ hơn viền ngoài. Làm mượt cùng bán kính thì chân mày
 * (mỏng) bị lấp lại — đo được trước khi sửa: da tại chân mày = 1.00. */
function testHoleFeatherIsSharperThanOutline() {
    assert.ok(Retouch.HOLE_FEATHER_SCALE < 0.5,
        'lỗ khoét phải làm mượt nhẹ hơn hẳn viền ngoài');
    const r = Retouch.rasterizeMasks([FACE], { aspect: AR });
    const brow = midOf(105, 52);
    const sharp = Retouch.sampleMasks(r, brow.x, brow.y).skin;
    // Đối chứng: ép lỗ dùng CÙNG bán kính với viền -> chân mày phải bị lấp rõ rệt.
    // (mô phỏng bằng cách raster ở lưới nhỏ, nơi chân mày mỏng đi tương đối)
    const coarse = Retouch.rasterizeMasks([FACE], { aspect: AR, size: 96 });
    const blunt = Retouch.sampleMasks(coarse, brow.x, brow.y).skin;
    assert.ok(blunt > sharp,
        `bối cảnh: lưới thô phải khoét kém hơn lưới mịn (${blunt.toFixed(2)} vs ${sharp.toFixed(2)})`);
    console.log(`  ok  lỗ khoét sắc hơn viền ngoài (mày: lưới mịn ${sharp.toFixed(2)} vs lưới thô ${blunt.toFixed(2)})`);
}

/* Raster trong KHÔNG GIAN HỘP BAO MẶT, không phủ cả khung — đây là thứ khiến nó dùng
 * được cho preview. Đo được: phủ cả khung 979x1740 = 325 ms/khung; theo hộp 256x256 =
 * 16.7 ms/khung, CÙNG độ chi tiết. */
function testRasterIsFaceLocalAndCheap() {
    const r = Retouch.rasterizeMasks([FACE], { aspect: AR });
    assert.strictEqual(r.width, Retouch.MASK_GRID, 'lưới phải cố định, không phình theo khung');
    assert.strictEqual(r.height, Retouch.MASK_GRID);
    const b = r.bounds;
    assert.ok(b.width < 0.6 && b.height < 0.45,
        `hộp bao phải NHỎ hơn khung nhiều (${(b.width * 100).toFixed(0)}% x ${(b.height * 100).toFixed(0)}%)`);
    // Mọi landmark phải nằm trong hộp, nếu không mặt nạ bị cắt cụt.
    FACE.forEach((p, i) => {
        assert.ok(p[0] >= b.x0 - 1e-9 && p[0] <= b.x1 + 1e-9
            && p[1] >= b.y0 - 1e-9 && p[1] <= b.y1 + 1e-9, `landmark ${i} lọt ngoài hộp mặt nạ`);
    });
    // Mặt phải chiếm đủ pixel trên lưới để chân mày (~3.6% bề ngang mặt) còn sống.
    assert.ok(r.facePx > 150, `mặt phải chiếm >150px trên lưới, đo được ${r.facePx.toFixed(0)}px`);
    console.log(`  ok  raster cục bộ theo mặt: lưới ${r.width}² cho mặt ${r.facePx.toFixed(0)}px `
        + `(hộp = ${(b.width * 100).toFixed(0)}%×${(b.height * 100).toFixed(0)}% khung)`);
}

/* TẤT ĐỊNH: cùng đầu vào phải ra cùng mảng số. Đây là điều kiện để preview và khâu
 * bake khi xuất dùng chung mặt nạ — cũng là lý do KHÔNG dùng canvas 2D (`ctx.fill` khử
 * răng cưa và `ctx.filter='blur()'` đều do trình duyệt tự định nghĩa). */
function testRasterIsDeterministic() {
    const a = Retouch.rasterizeMasks([FACE], { aspect: AR });
    const b = Retouch.rasterizeMasks([FACE], { aspect: AR });
    for (let t = 0; t < a.textures.length; t++) {
        assert.deepStrictEqual(Array.from(a.textures[t]), Array.from(b.textures[t]),
            `texture ${t} không tất định`);
    }
    // Không có mặt -> mọi mặt nạ = 0, không nổ.
    const empty = Retouch.rasterizeMasks([], { aspect: AR });
    assert.strictEqual(empty.bounds, null, 'không có mặt thì không có hộp');
    assert.ok(empty.textures.every((t) => t.every((v) => v === 0)), 'không có mặt thì mặt nạ phải rỗng');
    console.log('  ok  raster tất định và chịu được đầu vào rỗng');
}

/* Biên mặt nạ phải CHUYỂN DẦN, không nhảy bậc — biên cứng là thấy đường cắt trên mặt. */
function testMaskEdgeIsFeathered() {
    const r = Retouch.rasterizeMasks([FACE], { aspect: AR });
    const chin = Retouch.pointAt(FACE, Retouch.POINTS.chin);
    // Quét dọc qua mép cằm, đếm số bước có giá trị TRUNG GIAN.
    let mids = 0;
    for (let k = -14; k <= 14; k++) {
        const v = Retouch.sampleMasks(r, chin.x, chin.y + k * 0.0016).skin;
        if (v > 0.08 && v < 0.92) mids++;
    }
    assert.ok(mids >= 3, `mép mặt nạ phải chuyển dần (chỉ có ${mids} bước trung gian -> biên cứng)`);
    console.log(`  ok  mép mặt nạ chuyển dần (${mids} bước trung gian khi cắt qua cằm)`);
}

// --- 9. BỎ BỚT VIỆC ĐỂ CHẠY NHANH — phải là phép rút gọn CHÍNH XÁC ----------
//
// ĐIỀU ĐANG ĐƯỢC BẢO VỆ: để retouch phát được mượt, engine bỏ hẳn (a) mặt nạ mà không
// tham số nào đọc tới và (b) tầng mờ THÔ khi nó triệt tiêu khỏi công thức. Cả hai được
// bán là "cho ra ĐÚNG cùng một ảnh". Nếu chúng chỉ gần đúng thì preview lệch bản xuất,
// và lệch theo kiểu chỉ hiện ra với đúng vài tổ hợp tham số — loại lỗi khó tìm nhất.
// Vì vậy test này đòi TRÙNG BIT, không phải "sai số nhỏ".

function testRequiredMasksIsExact() {
    // Chỉ bật Mịn da -> chỉ mặt nạ DA được đọc.
    const cfg = { enabled: true, params: { smooth: 60 } };
    const need = Retouch.requiredMasks(cfg);
    assert.ok(need.skin, 'Mịn da phải cần mặt nạ da');
    ['eyes', 'teeth', 'underEye', 'nasolabial'].forEach((k) => {
        assert.ok(!need[k], `Mịn da KHÔNG được đòi mặt nạ ${k}`);
    });
    // Mỗi tham số kéo đúng mặt nạ của nó.
    const pairs = [['brightEye', 'eyes'], ['whiteTeeth', 'teeth'],
                   ['darkCircles', 'underEye'], ['smileLines', 'nasolabial']];
    pairs.forEach(([param, mask]) => {
        const n = Retouch.requiredMasks({ enabled: true, params: { [param]: 50 } });
        assert.ok(n[mask], `${param} phải cần mặt nạ ${mask}`);
    });
    // Tông da là đường riêng (không nằm trong params) nhưng vẫn đọc mặt nạ da.
    assert.ok(Retouch.requiredMasks({ enabled: true, skinTone: '#c8926b', skinToneAmount: 40 }).skin,
        'tông da phải cần mặt nạ da');

    // TRÙNG BIT: kênh được yêu cầu phải y hệt bản dựng đủ; kênh bỏ qua phải bằng 0.
    const full = Retouch.rasterizeMasks([FACE], { aspect: 0.5625, size: 128 });
    const lean = Retouch.rasterizeMasks([FACE], { aspect: 0.5625, size: 128, need });
    Retouch.MASK_LAYOUT.forEach((l) => {
        const a = full.textures[l.tex], b = lean.textures[l.tex];
        let diff = 0, nonZero = 0;
        for (let i = l.ch; i < a.length; i += 4) {
            if (a[i] !== b[i]) diff++;
            if (b[i] !== 0) nonZero++;
        }
        if (need[l.name]) assert.strictEqual(diff, 0, `mặt nạ ${l.name} được yêu cầu mà lệch ${diff} pixel`);
        else assert.strictEqual(nonZero, 0, `mặt nạ ${l.name} bị bỏ mà vẫn còn ${nonZero} pixel khác 0`);
    });
    console.log('  ok  bỏ mặt nạ không ai đọc: kênh cần TRÙNG BIT, kênh bỏ bằng 0');
}

function testCoarseLayerCancelsExactly() {
    // 4 tham số này (và chỉ 4) động vào `base`/`mid` -> mới cần tầng thô.
    Retouch.COARSE_USERS.forEach((k) => {
        assert.ok(Retouch.needsCoarse({ enabled: true, params: { [k]: 30 } }), `${k} phải cần tầng thô`);
    });
    ['smooth', 'clearBlemishes', 'clear', 'whitening', 'brightEye', 'whiteTeeth', 'darkCircles']
        .forEach((k) => {
            assert.ok(!Retouch.needsCoarse({ enabled: true, params: { [k]: 30 } }),
                `${k} KHÔNG được đòi tầng thô`);
        });

    // Phép rút gọn: khi không cần tầng thô, truyền lowCoarse := lowFine phải cho ra
    // ĐÚNG cùng con số với khi truyền tầng thô thật.
    const cfg = { enabled: true, params: { smooth: 70, clearBlemishes: 55, clear: 25, whitening: 40 } };
    const m = { skin: 1, nasolabial: 0 };
    let worst = 0;
    for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const orig = [0.2 + 0.6 * t, 0.35 + 0.4 * t, 0.5 - 0.3 * t];
        const lf = [orig[0] - 0.05, orig[1] + 0.03, orig[2] - 0.02];
        const lc = [lf[0] - 0.08, lf[1] - 0.06, lf[2] + 0.07];   // tầng thô THẬT, khác hẳn lf
        const real = Retouch.applyFreqOps(orig, lf, lc, cfg, m);
        const lean = Retouch.applyFreqOps(orig, lf, lf, cfg, m); // lc := lf
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(real[c] - lean[c]));
    }
    assert.strictEqual(worst, 0, `tầng thô phải triệt tiêu TUYỆT ĐỐI, lệch lớn nhất = ${worst}`);

    // Ngược lại: có tham số dùng tầng thô thì phép rút gọn PHẢI đổi kết quả — nếu không
    // thì phép thử trên vô nghĩa (hai đường trùng nhau vì lý do khác).
    const cfg2 = { enabled: true, params: { dewrinkle: 80 } };
    const orig = [0.5, 0.5, 0.5], lf = [0.45, 0.5, 0.55], lc = [0.35, 0.5, 0.65];
    const a = Retouch.applyFreqOps(orig, lf, lc, cfg2, m);
    const b = Retouch.applyFreqOps(orig, lf, lf, cfg2, m);
    assert.ok(Math.abs(a[0] - b[0]) > 1e-6, 'Xoá nếp nhăn PHẢI phụ thuộc tầng thô');
    console.log('  ok  tầng mờ thô triệt tiêu tuyệt đối khi không ai đọc (và không triệt tiêu khi có)');
}

function testScratchBuffersChangeNothing() {
    const n = 128 * 128;
    const scratch = { size: n, buf: new Float32Array(n), holeBuf: new Float32Array(n), tmp: new Float32Array(n) };
    const a = Retouch.rasterizeMasks([FACE], { aspect: 0.5625, size: 128 });
    const b = Retouch.rasterizeMasks([FACE], { aspect: 0.5625, size: 128, scratch });
    // Gọi lần hai trên CÙNG bộ đệm: phải không nhiễm bẩn từ lần trước.
    const c = Retouch.rasterizeMasks([FACE], { aspect: 0.5625, size: 128, scratch });
    a.textures.forEach((tex, t) => {
        for (let i = 0; i < tex.length; i++) {
            assert.strictEqual(b.textures[t][i], tex[i], `bộ đệm dùng lại làm lệch texture ${t} tại ${i}`);
            assert.strictEqual(c.textures[t][i], tex[i], `lượt gọi thứ hai bị nhiễm bẩn tại ${i}`);
        }
    });

    const G = 64, rgb = new Float32Array(G * G * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = ((i * 37) % 251) / 251;
    const mk = () => ({ out: new Float32Array(G * G * 3), plane: new Float32Array(G * G), tmp: new Float32Array(G * G) });
    const s1 = mk(), s2 = mk();
    const refFine = Retouch.blurRgbBoxCascade(rgb, G, G, 3);
    const refCoarse = Retouch.blurRgbBoxCascade(rgb, G, G, 9);
    const gotFine = Retouch.blurRgbBoxCascade(rgb, G, G, 3, s1);
    const gotCoarse = Retouch.blurRgbBoxCascade(rgb, G, G, 9, s2);
    for (let i = 0; i < rgb.length; i++) {
        assert.strictEqual(gotFine[i], refFine[i], `blur mịn lệch tại ${i} khi dùng bộ đệm`);
        assert.strictEqual(gotCoarse[i], refCoarse[i], `blur thô lệch tại ${i} khi dùng bộ đệm`);
    }
    // HAI lượt blur phải có HAI `out` riêng, nếu không lượt sau đè lượt trước và `mid`
    // hoá ra bằng 0 — lỗi này im lặng, chỉ hiện ra bằng việc mất tầng trung.
    assert.notStrictEqual(gotFine, gotCoarse, 'hai lượt blur đang dùng chung một mảng out');
    console.log('  ok  bộ đệm dùng lại không đổi kết quả (và hai lượt blur không đè nhau)');
}

function testMaskFeatherIsGridInvariant() {
    /* NỖI LO CŨ, ĐO RA LÀ KHÔNG CÓ: "hạ lưới mặt nạ xuống thì chân mày — chỉ dày ~3.6%
     * bề ngang mặt — sẽ bị khoét kém đi". Không, vì bán kính làm mượt đã quy theo BỀ
     * NGANG MẶT (MASK_FEATHER_FRAC) chứ không theo pixel, nên nó co giãn cùng lưới.
     * Test khoá tính chất đó lại: hạ lưới xuống một nửa thì lỗ chân mày vẫn phải là lỗ.
     * Nhờ tính chất này mà lúc PHÁT engine dùng được lưới 128 (rẻ hơn 4 lần).           */
    const brow = { x: FACE[105][0], y: FACE[105][1] };     // giữa chân mày trái
    const cheek = { x: (FACE[50][0] + FACE[101][0]) / 2, y: (FACE[50][1] + FACE[101][1]) / 2 };
    const seen = [];
    [Retouch.FREQ_GRID, Retouch.FREQ_GRID_PLAYING].forEach((size) => {
        const r = Retouch.rasterizeMasks([FACE], { aspect: 0.5625, size });
        const b = Retouch.sampleMasks(r, brow.x, brow.y).skin;
        const c = Retouch.sampleMasks(r, cheek.x, cheek.y).skin;
        assert.ok(c > 0.95, `lưới ${size}: gò má phải là da đặc (${c.toFixed(3)})`);
        assert.ok(b < 0.7, `lưới ${size}: lỗ chân mày bị lấp (${b.toFixed(3)})`);
        seen.push(b);
    });
    assert.ok(Math.abs(seen[0] - seen[1]) < 0.15,
        `khoét chân mày phải gần như không đổi theo lưới (${seen.map((v) => v.toFixed(3)).join(' vs ')})`);
    console.log(`  ok  khoét chân mày bất biến theo lưới (${seen.map((v) => v.toFixed(3)).join(' / ')}) -> lưới 128 dùng được lúc phát`);
}

function main() {
    console.log('retouch: dữ liệu landmark');
    testFixtureShape();
    console.log('retouch: chỉ số vùng FaceMesh (kiểm bằng hình học trên mặt THẬT)');
    testRegionsAreAnatomicallySane();
    testLandmarkPointsAreExtremes();
    console.log('retouch: hộp bao & chọn mặt');
    testFaceBounds();
    testSelectFaces();
    console.log('retouch: mô hình tham số');
    testParamModel();
    console.log('retouch: biến dạng hình học');
    testWarp();
    console.log('retouch: mặt nạ vùng');
    testMaskPolygons();
    testUnderEyeGeometry();
    console.log('retouch: nhóm phép màu cục bộ');
    testColorOpsRespectMask();
    testColorOpsDirection();
    testSkinTonePreservesLuma();
    testColorOpsStayInGamut();
    console.log('retouch: nhóm tách tần số');
    testFreqReconstructsExactly();
    testSmoothAndClearAreOpposite();
    testBlemishIsAsymmetric();
    testDewrinkleHitsMidBand();
    testEvenReducesChromaKeepsLuma();
    testSparkleFavoursHighlights();
    testFreqStaysInGamut();
    testFreqRadiiScale();
    testNasolabialGeometry();
    console.log('retouch: biến dạng — đẳng hướng & chống gấp ảnh');
    testWarpIsIsotropicInPixelSpace();
    testOverlappingControlsDoNotPileUp();
    testWarpNeverFolds();
    testWarpConfinedToFace();
    console.log('retouch: raster hoá mặt nạ');
    testRasterHitsAnatomy();
    testHoleFeatherIsSharperThanOutline();
    testRasterIsFaceLocalAndCheap();
    testRasterIsDeterministic();
    testMaskEdgeIsFeathered();
    console.log('retouch: bỏ bớt việc để chạy nhanh (phải là rút gọn CHÍNH XÁC)');
    testRequiredMasksIsExact();
    testCoarseLayerCancelsExactly();
    testScratchBuffersChangeNothing();
    testMaskFeatherIsGridInvariant();
    console.log('retouch regions ok');
}

main();
