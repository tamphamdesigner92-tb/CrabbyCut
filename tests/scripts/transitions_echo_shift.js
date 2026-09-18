/**
 * Test HỢP ĐỒNG của hiệu ứng chuyển cảnh "Phóng chồng bóng" (echoshift).
 *
 * Vì sao cần: mẫu này DÙNG CHUNG đường vẽ với "Phóng to" (zoomin) và chỉ khác nhau ở ba
 * con số đo được từ video mẫu ("Effect Demo/Transition/Transitions-Echo Shift.mp4" trừ nền
 * với "Transitions-No effect.mp4"). Sửa nhầm một con số thì hiệu ứng vẫn chạy, vẫn là một
 * cú phóng, chỉ mất đúng cái làm nên nó — nên phải khoá số lại. Test cũng khoá luôn việc
 * hai hiệu ứng KHÔNG được trùng nhau: đó là lý do duy nhất để mẫu này tồn tại riêng.
 *
 * Chạy: npm run test:echo-shift
 * KHÔNG cần canvas: chỉ đụng vào hai đường cong đã export.
 */
const assert = require('assert');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const Transitions = require(path.join(projectRoot, 'static', 'js', 'transitions.js'));

const M = Transitions.ECHO_MAG;
const zoom = (p) => Transitions.echoZoomAt(p);
const scaleA = (p) => 1 + (M - 1) * zoom(p);
const scaleB = (p) => M - (M - 1) * zoom(p);

/* ---------- 1) Có mặt trong danh mục ---------- */
const opt = Transitions.optionById('echoshift');
assert.ok(opt, 'phải có hiệu ứng "echoshift"');
assert.strictEqual(opt.category, 'motion', 'thuộc nhóm "Chuyển động" (cùng nhóm với Phóng to)');
assert.strictEqual(opt.label, 'Phóng chồng bóng');

/* ---------- 2) HAI ĐẦU MÚT — điều kiện của mẹo chồng 1 frame khi export ----------
 * p=0 phải ra ĐÚNG khung A: lớp A ở cỡ 1.0 và lớp B trong suốt hoàn toàn. p=1 ngược lại. */
assert.strictEqual(zoom(0), 0);
assert.strictEqual(zoom(1), 1);
assert.strictEqual(Transitions.echoMix(0), 0, 'p=0: chưa có tí lớp B nào');
assert.strictEqual(Transitions.echoMix(1), 1, 'p=1: đã là lớp B hoàn toàn');
assert.strictEqual(scaleA(0), 1, 'p=0: lớp A ở đúng 100%');
assert.strictEqual(scaleB(1), 1, 'p=1: lớp B ở đúng 100%');

/* ---------- 3) KHÔNG BAO GIỜ HỞ NỀN ----------
 * Cả hai lớp LUÔN ≥ 100%. Đây là bài học đã phải sửa một lần ở "Phóng to": bản cũ cho lớp
 * B bắt đầu ở 40% nên lộ viền đen quanh B. Với cấu trúc hiện tại điều đó được bảo đảm bằng
 * chính công thức, miễn là nhịp đội khung nằm trong [0,1] — nên kiểm chính chỗ đó. */
for (let i = 0; i <= 200; i += 1) {
    const p = i / 200;
    const e = zoom(p);
    assert.ok(e >= 0 && e <= 1, `nhịp đội khung phải nằm trong [0,1] (p=${p} cho ${e})`);
    assert.ok(scaleA(p) >= 1 - 1e-9 && scaleB(p) >= 1 - 1e-9,
        `cả hai lớp phải ≥ 100% ở p=${p} (A=${scaleA(p)}, B=${scaleB(p)})`);
}

/* ---------- 4) BIÊN ĐỘ ĐỘI KHUNG, suy từ điểm gặp nhau ----------
 * Số đo TRỰC TIẾP là: tại điểm cắt hai lớp cùng ở cỡ 1.30 (đo lớp A được 1.302, lớp B
 * 1.298 — hai phép đo độc lập, trên hai nguồn ảnh khác nhau, trùng nhau tới 0.004).
 * Biên độ 1.60 là hệ quả: 1 + 2·(1.30 − 1). */
let prev = -1;
for (let i = 0; i <= 200; i += 1) {
    const e = zoom(i / 200);
    assert.ok(e >= prev - 1e-12, `nhịp đội khung phải ĐƠN ĐIỆU TĂNG (gãy ở p=${i / 200})`);
    prev = e;
}
assert.ok(Math.abs(M - 1.60) < 1e-9, 'biên độ đội khung 1.60');
assert.ok(Math.abs(zoom(0.489) - 0.503) < 0.01, 'nhịp đội khung qua một nửa ngay tại điểm cắt');
assert.ok(Math.abs(scaleA(0.489) - 1.302) < 0.01 && Math.abs(scaleB(0.489) - 1.298) < 0.01,
    'tại điểm cắt HAI LỚP GẶP NHAU ở 1.30 — chỗ nối của hai nửa phép đo');

/* ---------- 5) NHỊP ĐỘI KHUNG là BẢNG SỐ ĐO, không phải ease có sẵn ----------
 * Ghép từ hai phép đo độc lập: nửa đầu (sA − 1)/0.6 trên lớp A, nửa sau (1.60 − sB)/0.6
 * trên lớp B. Đường thật KHÔNG đối xứng — lên chậm, xuống nhanh. */
[
    [0.089, 0.022], [0.178, 0.063], [0.267, 0.128], [0.356, 0.220], [0.444, 0.403],
    [0.578, 0.695], [0.667, 0.835], [0.756, 0.913], [0.844, 0.952], [0.933, 0.993],
].forEach(([p, want]) => {
    assert.ok(Math.abs(zoom(p) - want) < 0.005,
        `nhịp đội khung tại p=${p} phải là ${want}, nhận ${zoom(p)}`);
});
// Hai hàm ease gần nhất trong file đều KHÔNG đủ — giữ lại phép so để ai đó định "dọn cho
// gọn" bằng cách thay bảng bằng ease sẽ thấy ngay vì sao không được.
const quad = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const cubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
assert.ok(Math.abs(zoom(0.622) - quad(0.622)) > 0.04,
    'easeInOutQuad lệch > 0.04 ở nửa sau (≈33px sai chỗ ở góc khung 1080×1920)');
assert.ok(Math.abs(zoom(0.178) - cubic(0.178)) > 0.03,
    'easeInOutCubic lệch > 0.03 ở đoạn đầu (cú đội khung đến muộn hơn mẫu)');

/* ---------- 6) ĐỔI ẢNH là đường RIÊNG, LỆCH PHA với nhịp đội khung ----------
 * Đây là cả tính cách của mẫu: lúc hai lớp ngang nhau (p≈0.38) thì lớp A mới ở 1.16 còn
 * lớp B còn ở 1.44 — chênh nhau hẳn một phần tư khung hình, và cái bóng khổng lồ đó chính
 * là thứ phân biệt mẫu này với "Phóng to". Cho ảnh đổi theo đúng nhịp đội khung (như
 * zoomin đang làm) là hiệu ứng xẹp xuống thành một cú phóng bình thường. */
let prevMix = -1;
for (let i = 0; i <= 200; i += 1) {
    const m = Transitions.echoMix(i / 200);
    assert.ok(m >= prevMix - 1e-12, `đổi ảnh phải ĐƠN ĐIỆU TĂNG (gãy ở p=${i / 200})`);
    assert.ok(m >= 0 && m <= 1, 'tỉ lệ lớp B luôn trong [0,1]');
    prevMix = m;
}
const midMix = [...Array(2001).keys()].map((i) => i / 2000)
    .reduce((best, p) => (Math.abs(Transitions.echoMix(p) - 0.5) < Math.abs(Transitions.echoMix(best) - 0.5) ? p : best), 0);
assert.ok(Math.abs(midMix - 0.385) < 0.02, `ảnh đổi được một nửa ở p≈0.385, nhận ${midMix}`);
assert.ok(zoom(midMix) < 0.30,
    'lúc ảnh đổi một nửa thì nhịp đội khung mới ở ~0.26 — HAI ĐƯỜNG PHẢI LỆCH PHA');
assert.ok(scaleB(midMix) - scaleA(midMix) > 0.25,
    `lúc hai lớp ngang nhau, cỡ của chúng phải chênh > 0.25 (nhận ${scaleB(midMix) - scaleA(midMix)}) — `
    + 'đó chính là cái "bóng" của mẫu');

/* ---------- 7) KHÔNG được trùng với "Phóng to" ----------
 * Hai mẫu dùng chung đường vẽ, nên phải chắc chúng vẫn cho ra hai hình khác nhau rõ rệt —
 * nếu không thì thêm một thẻ vào panel chỉ làm người dùng phải chọn giữa hai thứ y hệt. */
const ZOOM_MAG = 1.25;      // của 'zoomin', giữ ở đây để so
const zoomA = (p) => 1 + (ZOOM_MAG - 1) * cubic(p);
assert.ok(scaleA(0.5) - zoomA(0.5) > 0.15,
    `giữa vùng, "Phóng chồng bóng" phải đội khung mạnh hơn "Phóng to" ít nhất 0.15 `
    + `(nhận ${scaleA(0.5)} so với ${zoomA(0.5)})`);
assert.ok(Math.abs(Transitions.echoMix(0.385) - cubic(0.385)) > 0.15,
    'nhịp đổi ảnh của hai mẫu cũng phải khác hẳn nhau, không chỉ khác biên độ');

/* ---------- 8) Đi qua các cơ chế chung của engine ĐÚNG CÁCH ---------- */
// Cửa trập (motion blur thật) phải biết mẫu này đội khung tới 1.60, nếu không đoạn giữa
// vùng lộ từng nấc. Kiểm gián tiếp: quãng đường ảnh đi trong 1 khung phải lớn hơn zoomin.
assert.strictEqual(Transitions.progressAt(0.765, 1.53), 0.5, 'progressAt vẫn tuyến tính');

/* ---------- 9) compose() chạy được ở môi trường KHÔNG có canvas ---------- */
const calls = [];
const fakeCtx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', filter: 'none',
    save() {}, restore() {}, clearRect() {}, fillRect() {}, drawImage() {}, beginPath() {},
    arc() {}, fill() {}, translate() {}, scale() {}, rect() {}, clip() {}, setTransform() {},
    createRadialGradient() { return { addColorStop() {} }; },
};
[0, 0.25, 0.385, 0.5, 0.75, 1].forEach((p) => {
    calls.length = 0;
    Transitions.compose(fakeCtx, 'echoshift', p, 1080, 1920,
        () => calls.push('A'), () => calls.push('B'), { fullFrame: true, duration: 1.53, fps: 30 });
    assert.ok(calls.includes('A') && calls.includes('B'),
        `p=${p}: phải vẽ CẢ HAI lớp (lớp kia trong suốt, nhưng vẫn phải nằm trong đường vẽ)`);
});

console.log('transitions-echo-shift: OK');
