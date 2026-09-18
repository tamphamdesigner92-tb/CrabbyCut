/**
 * Test HỢP ĐỒNG của bốn hiệu ứng chuyển cảnh dựng theo VIDEO MẪU:
 *   "Chớp sáng xoay" (flashrotate) · "Xoay đập" (spinslam)
 *   "Kéo giãn trái" (stretchleft) · "Phóng trượt" (zoomslide)
 *
 * Vì sao cần: cả bốn chỉ là BẢNG SỐ ĐO chạy qua một đường vẽ chung. Sửa nhầm một con số
 * thì hiệu ứng VẪN CHẠY, vẫn là một cú xoay/trượt, chỉ mất đúng cái làm nên nó — không có
 * gì bắt lỗi cả. Nên phải khoá lại: hai đầu mút, tính đơn điệu, những con số đã đo được
 * từ video, và việc bốn mẫu KHÔNG được trùng nhau (đó là lý do duy nhất để chúng tồn tại
 * riêng trong danh mục).
 *
 * Chạy: npm run test:transitions-measured
 * KHÔNG cần canvas: mọi thứ kiểm ở đây đều đi qua các hàm đã export.
 */
const assert = require('assert');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const Transitions = require(path.join(projectRoot, 'static', 'js', 'transitions.js'));

const IDS = ['flashrotate', 'spinslam', 'stretchleft', 'zoomslide'];
const at = (id, p) => Transitions.measuredAt(id, p);
const samples = (n) => [...Array(n + 1).keys()].map((i) => i / n);

/* ---------- 1) Có mặt trong danh mục, nhãn tiếng Việt, đúng nhóm ---------- */
const WANT = {
    flashrotate: ['Chớp sáng xoay', 'effect'],
    spinslam: ['Xoay đập', 'motion'],
    stretchleft: ['Kéo giãn trái', 'motion'],
    zoomslide: ['Phóng trượt', 'motion'],
};
IDS.forEach((id) => {
    const o = Transitions.optionById(id);
    assert.ok(o, `phải có hiệu ứng "${id}"`);
    assert.strictEqual(o.label, WANT[id][0]);
    assert.strictEqual(o.category, WANT[id][1], `"${id}" phải thuộc nhóm ${WANT[id][1]}`);
    assert.ok(Transitions.optionsByCategory(o.category).some((x) => x.id === id),
        `"${id}" phải hiện ra khi panel lọc theo nhóm của nó`);
});

/* ---------- 2) HAI ĐẦU MÚT — điều kiện của mẹo chồng 1 frame khi export ----------
 * p=0 phải ra ĐÚNG khung A và p=1 ĐÚNG khung B: nghĩa là lớp đang hiện phải ở cỡ 1, góc 0,
 * không trượt, và MỌI lớp trang trí (chớp trắng / tách màu / giao diện camera) phải tắt. */
IDS.forEach((id) => {
    const a = at(id, 0);
    const b = at(id, 1);
    assert.strictEqual(a.layer, 'A', `${id}: p=0 phải là lớp A`);
    assert.strictEqual(b.layer, 'B', `${id}: p=1 phải là lớp B`);
    [['p=0', a], ['p=1', b]].forEach(([nhan, s]) => {
        assert.ok(Math.abs(s.scale - 1) < 1e-9, `${id} ${nhan}: cỡ phải đúng bằng 1`);
        assert.ok(Math.abs(s.angle) < 1e-9, `${id} ${nhan}: góc phải đúng bằng 0`);
        assert.ok(Math.abs(s.tx) < 1e-9 && Math.abs(s.ty) < 1e-9,
            `${id} ${nhan}: không được trượt`);
    });
});
assert.strictEqual(Transitions.flashWhiteAt(0), 0, 'p=0: chưa chớp');
assert.strictEqual(Transitions.flashWhiteAt(1), 0, 'p=1: đã tắt chớp');
assert.strictEqual(Transitions.spinSplitAt(0), 0, 'p=0: chưa tách màu');
assert.strictEqual(Transitions.spinSplitAt(1), 0, 'p=1: đã hết tách màu');
assert.strictEqual(Transitions.zoomUiFadeAt(0), 0, 'p=0: giao diện camera chưa hiện');
assert.strictEqual(Transitions.zoomUiFadeAt(1), 0, 'p=1: giao diện camera đã tan');

/* ---------- 3) ĐIỂM ĐỔI ẢNH nằm ĐÚNG chỗ đo được, và KHÔNG ở giữa vùng ----------
 * Cả bốn mẫu đều lấy nhiều khung trước điểm cắt hơn sau, nên điểm đổi ảnh lệch khỏi 0.5.
 * Đây là khác biệt CẤU TRÚC so với các hiệu ứng cũ (fade/slide/zoom đổi đúng ở giữa). */
const SWAP = { flashrotate: 0.62, spinslam: 0.526, stretchleft: 0.523, zoomslide: 0.641 };
IDS.forEach((id) => {
    const s = Transitions.measuredSwap(id);
    assert.ok(Math.abs(s - SWAP[id]) < 1e-9, `${id}: điểm đổi ảnh phải là ${SWAP[id]}, nhận ${s}`);
    assert.ok(Math.abs(s - 0.5) > 0.02, `${id}: điểm đổi ảnh KHÔNG được rơi vào giữa vùng`);
    assert.strictEqual(at(id, s - 1e-6).layer, 'A', `${id}: ngay trước điểm đổi vẫn là lớp A`);
    assert.strictEqual(at(id, s).layer, 'B', `${id}: từ điểm đổi trở đi là lớp B`);
});

/* ---------- 4) "Chớp sáng xoay": ba đường LỆCH PHA nhau ----------
 * Đó là cả tính cách của mẫu. Nếu ai đó gộp chúng lại thành một đường chung thì hiệu ứng
 * xẹp xuống thành một cú phóng-xoay tầm thường. */
{
    // Cú phóng đạt đỉnh ~1.50 ở khoảng một phần ba đầu vùng...
    const peak = samples(400).reduce((best, p) => (at('flashrotate', p).scale > at('flashrotate', best).scale ? p : best), 0);
    assert.ok(Math.abs(at('flashrotate', peak).scale - 1.495) < 0.01,
        `đỉnh phóng phải ≈ 1.495, nhận ${at('flashrotate', peak).scale}`);
    assert.ok(peak > 0.24 && peak < 0.36, `đỉnh phóng phải rơi vào p≈0.30, nhận ${peak}`);
    // ...rồi TỤT XUỐNG DƯỚI 1 trước khi đổi ảnh — "hít vào rồi ném đi".
    assert.ok(at('flashrotate', 0.60).scale < 0.80,
        'sát điểm đổi ảnh, lớp A phải co xuống dưới 0.80 (cú ném đi)');
    // Cú xoay CHƯA hề bắt đầu suốt 40% đầu vùng.
    for (let p = 0; p <= 0.40; p += 0.01) {
        assert.ok(Math.abs(at('flashrotate', p).angle) < 1e-9,
            `40% đầu vùng KHÔNG được xoay tí nào (gãy ở p=${p.toFixed(2)})`);
    }
    assert.ok(at('flashrotate', 0.60).angle > 30, 'rồi bung ra > 30° ngay trước điểm đổi ảnh');
    // Hai lớp xoay CÙNG CHIỀU kim đồng hồ: A đi từ 0 lên dương, B từ âm về 0.
    assert.ok(at('flashrotate', 0.64).angle < -20, 'lớp B nhận tiếp ở góc âm (khoảng −26°)');
    // Chớp trắng đạt đỉnh ~0.50 ĐÚNG quanh điểm đổi ảnh, và tắt hẳn trước khi hết vùng.
    const flashPeak = samples(400).reduce((best, p) => (Transitions.flashWhiteAt(p) > Transitions.flashWhiteAt(best) ? p : best), 0);
    assert.ok(Math.abs(Transitions.flashWhiteAt(flashPeak) - 0.50) < 0.01,
        `đỉnh chớp trắng phải ≈ 0.50, nhận ${Transitions.flashWhiteAt(flashPeak)}`);
    assert.ok(Math.abs(flashPeak - 0.62) < 0.07, 'đỉnh chớp phải nằm sát điểm đổi ảnh');
    assert.strictEqual(Transitions.flashWhiteAt(0.85), 0, 'chớp phải tắt hẳn ở p=0.85');
    assert.strictEqual(Transitions.flashWhiteAt(0.30), 0, 'và chưa hề bật ở p=0.30');
}

/* ---------- 5) "Xoay đập": phóng + xoay đều TĂNG TỐC, rồi B lún vào khung ---------- */
{
    let prevS = -1;
    let prevA = -1;
    for (let i = 0; i <= 200; i += 1) {
        const p = (i / 200) * (SWAP.spinslam - 1e-6);
        const s = at('spinslam', p);
        assert.ok(s.scale >= prevS - 1e-9, `cú phóng của lớp A phải ĐƠN ĐIỆU TĂNG (gãy ở p=${p})`);
        assert.ok(s.angle >= prevA - 1e-9, `cú xoay của lớp A phải ĐƠN ĐIỆU TĂNG (gãy ở p=${p})`);
        prevS = s.scale; prevA = s.angle;
    }
    // TĂNG TỐC: nửa sau của lớp A phải đi được nhiều hơn hẳn nửa đầu.
    const half = SWAP.spinslam / 2;
    const d1 = at('spinslam', half).angle - at('spinslam', 0).angle;
    const d2 = at('spinslam', SWAP.spinslam - 1e-6).angle - at('spinslam', half).angle;
    assert.ok(d2 > d1 * 3, `cú xoay phải TĂNG TỐC: nửa sau ${d2.toFixed(1)}° so với nửa đầu ${d1.toFixed(1)}°`);
    assert.ok(at('spinslam', SWAP.spinslam - 1e-6).angle > 26, 'lớp A xoay tới ~27° ở điểm đổi ảnh');
    // Cú "đập": lớp B vào NHỎ HƠN khung rồi nở dần về 1 — đây là chỗ phân biệt với "Phóng to".
    assert.ok(at('spinslam', SWAP.spinslam).scale < 0.85, 'lớp B phải vào ở cỡ nhỏ hơn 0.85');
    let prevB = -1;
    for (let i = 0; i <= 200; i += 1) {
        const p = SWAP.spinslam + ((1 - SWAP.spinslam) * i) / 200;
        const s = at('spinslam', p);
        assert.ok(s.scale >= prevB - 1e-9, `lớp B phải nở ĐƠN ĐIỆU về 1 (gãy ở p=${p})`);
        assert.ok(s.angle <= 1e-9, 'lớp B luôn nghiêng về phía âm');
        prevB = s.scale;
    }
    // Tách màu: CHỈ quanh điểm đổi ảnh, đỉnh 16px@1080, và bằng 0 ở cả hai đầu vùng.
    const sp = (p) => Transitions.spinSplitAt(p);
    assert.ok(Math.abs(sp(SWAP.spinslam) - 16) < 0.5, 'đỉnh tách màu 16px@1080 tại điểm đổi ảnh');
    assert.strictEqual(sp(0.30), 0, 'chưa tách màu ở p=0.30');
    assert.strictEqual(sp(0.70), 0, 'đã hết tách màu ở p=0.70');
}

/* ---------- 6) "Kéo giãn trái": chỉ TRƯỢT NGANG, và hai lớp KHÔNG đối xứng ---------- */
{
    for (let i = 0; i <= 200; i += 1) {
        const s = at('stretchleft', i / 200);
        assert.ok(Math.abs(s.scale - 1) < 1e-9, 'không được phóng');
        assert.ok(Math.abs(s.angle) < 1e-9, 'không được xoay');
        assert.ok(Math.abs(s.ty) < 1e-9, 'không được trượt dọc');
    }
    let prev = 1;
    for (let i = 0; i <= 200; i += 1) {
        const p = (i / 200) * (SWAP.stretchleft - 1e-6);
        const tx = at('stretchleft', p).tx;
        assert.ok(tx <= prev + 1e-9, `lớp A phải trượt SANG TRÁI, không lùi lại (gãy ở p=${p})`);
        prev = tx;
    }
    // TĂNG TỐC rất mạnh — chính chỗ đó sinh ra vệt nhoè mà mắt gọi là "kéo giãn".
    const step = (p0, p1) => Math.abs(at('stretchleft', p1).tx - at('stretchleft', p0).tx);
    assert.ok(step(0.44, 0.47) > step(0.09, 0.12) * 20,
        'quãng trượt trong một khung ở cuối phải lớn gấp hàng chục lần lúc đầu');
    // A bay đi RẤT XA còn B chỉ nhích vào — hai lớp không đối xứng.
    const aEnd = Math.abs(at('stretchleft', SWAP.stretchleft - 1e-6).tx);
    const bStart = Math.abs(at('stretchleft', SWAP.stretchleft).tx);
    assert.ok(aEnd > 0.9, `lớp A phải đi được gần trọn một bề khung (nhận ${aEnd})`);
    assert.ok(bStart < 0.45 && bStart > 0.2, `lớp B chỉ vào từ ~0.35 bề khung (nhận ${bStart})`);
    assert.ok(at('stretchleft', SWAP.stretchleft).tx > 0, 'lớp B phải vào từ bên PHẢI');
}

/* ---------- 7) "Phóng trượt": phóng mạnh + nghiêng, rồi gạt đi; kèm giao diện camera ---- */
{
    // Cú phóng tới ~2.33 và cú nghiêng tới ~−14.5° — cả hai đều là số đo, không phải ước lượng.
    const top = samples(400).reduce((best, p) => (at('zoomslide', p).scale > at('zoomslide', best).scale ? p : best), 0);
    assert.ok(Math.abs(at('zoomslide', top).scale - 2.33) < 0.02, 'đỉnh phóng ≈ 2.33');
    const tilt = samples(400).reduce((best, p) => (at('zoomslide', p).angle < at('zoomslide', best).angle ? p : best), 0);
    assert.ok(Math.abs(at('zoomslide', tilt).angle + 14.7) < 0.3, 'cú nghiêng sâu nhất ≈ −14.7°');
    // 60% quãng phóng dồn vào một quãng ngắn ở giữa (p 0.35..0.48) — không phải phóng đều.
    const grew = at('zoomslide', 0.478).scale - at('zoomslide', 0.348).scale;
    assert.ok(grew / (2.33 - 1) > 0.55, `hơn nửa quãng phóng phải dồn vào p 0.35..0.48 (nhận ${(grew / 1.33).toFixed(2)})`);
    // Rồi TRƯỢT sang PHẢI trong khi cú nghiêng TỞ NGƯỢC về gần 0.
    assert.ok(at('zoomslide', 0.609).tx > 0.5, 'lớp A phải trượt sang phải trước điểm đổi ảnh');
    assert.ok(at('zoomslide', 0.609).angle > -4, 'và cú nghiêng đã tở gần hết');
    // Lớp B vào từ bên TRÁI, nghiêng NGƯỢC CHIỀU với lớp A.
    assert.ok(at('zoomslide', SWAP.zoomslide).tx < -0.5, 'lớp B phải vào từ bên TRÁI');
    assert.ok(at('zoomslide', SWAP.zoomslide).angle > 15,
        'lớp B nghiêng NGƯỢC chiều lớp A (dương, khoảng +18°)');
    // Giao diện camera: số bội leo tới trần 15× rồi rơi về 0.5×.
    const zv = (p) => Transitions.zoomUiValueAt(p);
    assert.strictEqual(zv(0), 0.5, 'bắt đầu ở 0.5×');
    assert.ok(Math.abs(zv(0.50) - 15) < 0.01, 'chạm trần 15× ở khoảng giữa vùng');
    assert.ok(Math.abs(zv(0.70) - 0.5) < 0.01, 'rồi rơi hẳn về 0.5× sau điểm đổi ảnh');
    assert.strictEqual(Transitions.zoomUiText(15), '15×', 'số tròn thì không hiện phần thập phân');
    assert.strictEqual(Transitions.zoomUiText(1.62), '1.6×');
    // Vòng số là thang LÔ-GA-RÍT ~22° mỗi lần gấp đôi (đo trên khung 117 của video mẫu).
    assert.ok(Math.abs(Transitions.zoomUiAngle(0.5)) < 1e-9, '0.5× nằm ở mốc 0°');
    assert.ok(Math.abs(Transitions.zoomUiAngle(1) - 22) < 0.01, '1× ở 22°');
    assert.ok(Math.abs(Transitions.zoomUiAngle(2) - 44) < 0.01, '2× ở 44°');
    // Lớp đồ hoạ SỐNG LÂU HƠN phần hình: còn rõ ở p=0.90 rồi mới tan.
    assert.ok(Transitions.zoomUiFadeAt(0.90) > 0.9, 'giao diện còn rõ ở p=0.90');
    assert.ok(Transitions.zoomUiFadeAt(0.98) < 0.4, 'và tan dần về cuối vùng');
}

/* ---------- 8) BỐN MẪU KHÔNG ĐƯỢC TRÙNG NHAU ----------
 * Chúng dùng chung một đường vẽ nên rất dễ trở thành bốn thẻ giống hệt trong panel. So
 * từng cặp trên toàn vùng: phải khác nhau rõ rệt ở ít nhất một thành phần. */
function shape(id) {
    return samples(60).map((p) => {
        const s = at(id, p);
        return [s.scale, s.angle / 30, s.tx];
    });
}
for (let i = 0; i < IDS.length; i += 1) {
    for (let j = i + 1; j < IDS.length; j += 1) {
        const a = shape(IDS[i]);
        const b = shape(IDS[j]);
        const far = a.reduce((m, row, k) => Math.max(m,
            Math.abs(row[0] - b[k][0]), Math.abs(row[1] - b[k][1]), Math.abs(row[2] - b[k][2])), 0);
        assert.ok(far > 0.3,
            `"${IDS[i]}" và "${IDS[j]}" quá giống nhau (lệch nhiều nhất ${far.toFixed(2)}) — `
            + 'thêm một thẻ vào panel chỉ để người dùng phải chọn giữa hai thứ y hệt');
    }
}
// Và KHÔNG được trùng với hai mẫu phóng có sẵn: "Phóng to" đội khung tới 1.25 rất đều.
assert.ok(at('zoomslide', 0.5).scale > 2,
    '"Phóng trượt" phải đội khung mạnh hơn hẳn "Phóng to" (1.25) và "Phóng chồng bóng" (1.60)');

/* ---------- 9) CỬA TRẬP phải biết quãng đường của bốn mẫu ----------
 * Nếu measuredSpanPx() trả 0 thì engine không lấy mẫu con, và đoạn giữa vùng lộ từng nấc. */
IDS.forEach((id) => {
    const s = Transitions.measuredSwap(id);
    const span = Transitions.measuredSpanPx(id, s - 0.03, s - 0.01, 1080, 1920);
    assert.ok(span > 20, `${id}: cửa trập phải thấy quãng đường > 20px sát điểm đổi ảnh, nhận ${span}`);
    assert.strictEqual(Transitions.measuredSpanPx(id, 0, 0, 1080, 1920), 0,
        `${id}: quãng đường bằng 0 khi tiến độ không nhích`);
});

/* ---------- 10) coverScale: lấp mép phải đủ, không thừa ---------- */
assert.strictEqual(Transitions.coverScale(0, 0, 0, 1080, 1920), 1,
    'lớp đứng yên, không nghiêng: không cần nới mép');
assert.ok(Transitions.coverScale(30, 0, 0, 1080, 1920) > 1.6,
    'nghiêng 30° thì phải nới ra đáng kể mới phủ kín khung');
assert.ok(Transitions.coverScale(0, -0.5, 0, 1080, 1920) > 1.9,
    'lệch nửa bề khung thì phải nới gấp đôi');

/* ---------- 11) compose() chạy được ở môi trường KHÔNG có canvas ---------- */
const fakeGrad = { addColorStop() {} };
const fakeCtx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '',
    filter: 'none', lineWidth: 1, lineCap: 'butt', font: '', textAlign: '', textBaseline: '',
    save() {}, restore() {}, clearRect() {}, fillRect() {}, strokeRect() {}, drawImage() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {},
    fillText() {}, translate() {}, rotate() {}, scale() {}, rect() {}, clip() {},
    setTransform() {}, createRadialGradient() { return fakeGrad; },
    createLinearGradient() { return fakeGrad; },
};
IDS.forEach((id) => {
    const frames = Transitions.MEASURED_SPAN_FRAMES[id];
    assert.ok(frames > 20, `${id}: phải ghi lại vùng đo được (số khung @30fps)`);
    [0, 0.25, Transitions.measuredSwap(id), 0.75, 1].forEach((p) => {
        const seen = [];
        Transitions.compose(fakeCtx, id, p, 1080, 1920,
            () => seen.push('A'), () => seen.push('B'),
            { fullFrame: true, duration: frames / 30, fps: 30 });
        assert.ok(seen.length > 0, `${id} p=${p}: phải vẽ ít nhất một lớp`);
    });
});
// Và hai đầu mút chỉ được vẽ ĐÚNG một lớp — không lẫn lớp kia vào.
IDS.forEach((id) => {
    const frames = Transitions.MEASURED_SPAN_FRAMES[id];
    [[0, 'B'], [1, 'A']].forEach(([p, cam]) => {
        const seen = [];
        Transitions.compose(fakeCtx, id, p, 1080, 1920,
            () => seen.push('A'), () => seen.push('B'),
            { fullFrame: true, duration: frames / 30, fps: 30 });
        assert.ok(!seen.includes(cam),
            `${id} p=${p}: KHÔNG được đụng tới lớp ${cam} (khung đầu = A, khung cuối = B)`);
    });
});

console.log('transitions-measured: OK');
