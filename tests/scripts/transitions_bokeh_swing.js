/**
 * Test HỢP ĐỒNG của hiệu ứng chuyển cảnh "Bokeh đung đưa" (bokehswing).
 *
 * Vì sao cần: mọi hằng số của hiệu ứng này là SỐ ĐO TỪ VIDEO MẪU ("Effect Demo/Transition/
 * Transitions-Bokeh Swing.mp4" so với "Transitions-No effect.mp4" trong cùng thư mục —
 * hai bản dài y hệt và cùng điểm cắt cứng ở khung 113|114, nên bản "No effect" cho biết
 * đúng nội dung lớp A và lớp B ở từng khung). Số đo nằm rải trong mã nguồn dưới dạng bảng
 * và hằng số; sửa nhầm một con số thì hiệu ứng vẫn CHẠY, vẫn trông "có bokeh", chỉ khác
 * nhịp — đúng loại hỏng âm thầm mà test này để chặn.
 *
 * Chạy: npm run test:bokeh-swing
 * KHÔNG cần canvas: test chỉ đụng vào các đường cong + bảng hạt (đã được export riêng).
 * Phần dựng hình (compose) chỉ kiểm là không nổ trong môi trường không có canvas.
 */
const assert = require('assert');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const Transitions = require(path.join(projectRoot, 'static', 'js', 'transitions.js'));

/* ---------- 1) Có mặt trong danh mục ---------- */
const opt = Transitions.optionById('bokehswing');
assert.ok(opt, 'phải có hiệu ứng "bokehswing" trong TRANSITION_OPTIONS');
assert.strictEqual(opt.category, 'effect', 'thuộc nhóm "Hiệu ứng"');
assert.strictEqual(opt.label, 'Bokeh đung đưa');
assert.ok(Transitions.optionsByCategory('effect').some((o) => o.id === 'bokehswing'),
    'phải hiện ra ở sub-tab "Hiệu ứng" của panel Chuyển tiếp');

/* ---------- 2) HAI ĐẦU MÚT — điều kiện của mẹo chồng 1 frame khi export ----------
 * p=0 phải ra ĐÚNG khung A và p=1 ĐÚNG khung B. Với hiệu ứng này nghĩa là: không pha
 * trộn, không quầng sáng, không mất nét ở hai mép. Kiểm trên CẢ BA đường cong vì chỉ cần
 * một đường khác 0 là khung mép đã lệch (và lệch đó chỉ lộ ra ở file xuất). */
assert.strictEqual(Transitions.bokehMix(0), 0, 'p=0: chưa có tí lớp B nào');
assert.strictEqual(Transitions.bokehMix(1), 1, 'p=1: đã là lớp B hoàn toàn');
assert.strictEqual(Transitions.bokehEnv(0), 0, 'p=0: không có ánh sáng');
assert.strictEqual(Transitions.bokehEnv(1), 0, 'p=1: không có ánh sáng');
assert.strictEqual(Transitions.bokehDefocusPx(0, 1080, 1920), 0, 'p=0: nét nguyên');
assert.strictEqual(Transitions.bokehDefocusPx(1, 1080, 1920), 0, 'p=1: nét nguyên');

/* ---------- 3) ĐỔI ẢNH: đường S dốc, điểm giữa SỚM hơn điểm cắt ----------
 * Số đo (khớp bình phương tối thiểu có loại điểm ngoại lai, trên từng khung của mẫu):
 * alpha của lớp B đi 0.23 -> 0.76 chỉ trong quãng p 0.33..0.44, và qua 0.5 ở p≈0.38 —
 * tức TRƯỚC điểm cắt (p=0.5) chừng 7 khung. Ảnh đổi ngay lúc ánh sáng mạnh nhất nên mắt
 * không bắt được; đặt điểm giữa về đúng 0.5 là thấy rõ cú chuyển. */
let prevMix = -1;
for (let i = 0; i <= 100; i += 1) {
    const m = Transitions.bokehMix(i / 100);
    assert.ok(m >= prevMix - 1e-12, `đổi ảnh phải ĐƠN ĐIỆU TĂNG (gãy ở p=${i / 100})`);
    assert.ok(m >= 0 && m <= 1, 'tỉ lệ lớp B luôn trong [0,1]');
    prevMix = m;
}
assert.ok(Math.abs(Transitions.bokehMix(0.38) - 0.5) < 0.02,
    `điểm giữa của phép đổi ảnh phải ở p≈0.38, nhận ${Transitions.bokehMix(0.38)}`);
assert.ok(Transitions.bokehMix(0.18) === 0 && Transitions.bokehMix(0.58) === 1,
    'cả cú đổi ảnh gói gọn trong p 0.19..0.57 (đo được: ngoài quãng đó ảnh gần như đứng yên)');
assert.ok(Transitions.bokehMix(0.44) - Transitions.bokehMix(0.33) > 0.45,
    'đoạn dốc nhất phải đổi được hơn 45% chỉ trong p 0.33..0.44');

/* ---------- 4) ÁNH SÁNG: bảng số đo, KHÔNG phải hình chuông ----------
 * Dáng thật có ba đoạn: bật lên ~0.18 rồi GIỮ NGUYÊN (p 0.09..0.15), leo dần và BÙNG ở
 * p≈0.37, rồi rụng nhanh nhưng để lại ĐUÔI THẤP kéo dài (~0.12 suốt p 0.74..0.82).
 * Một hình chuông đối xứng sẽ sai cả ba đoạn — đó là lý do phải giữ bảng. */
const envPeak = [...Array(101).keys()]
    .map((i) => i / 100)
    .reduce((best, p) => (Transitions.bokehEnv(p) > Transitions.bokehEnv(best) ? p : best), 0);
assert.ok(Math.abs(envPeak - 0.37) < 0.015, `ánh sáng mạnh nhất ở p≈0.37, nhận ${envPeak}`);
assert.ok(Math.abs(Transitions.bokehEnv(0.37) - 1) < 1e-9, 'đỉnh được chuẩn hoá về đúng 1');
[
    [0.074, 0.164, 'đoạn bật lên'],
    [0.111, 0.177, 'đoạn GIỮ NGUYÊN — hình chuông không có đoạn này'],
    [0.148, 0.180, 'đoạn GIỮ NGUYÊN'],
    [0.296, 0.555, 'đoạn leo'],
    [0.333, 0.847, 'cú BÙNG sát đỉnh'],
    [0.519, 0.600, 'đoạn rụng'],
    [0.778, 0.126, 'ĐUÔI THẤP kéo dài'],
    [0.815, 0.117, 'ĐUÔI THẤP kéo dài'],
].forEach(([p, want, why]) => {
    assert.ok(Math.abs(Transitions.bokehEnv(p) - want) < 0.005,
        `ánh sáng tại p=${p} phải là ${want} (${why}), nhận ${Transitions.bokehEnv(p)}`);
});
// Đuôi PHẢI dày hơn hẳn hình chuông: sin(pi*0.8) = 0.588 so với 0.12 đo được.
assert.ok(Transitions.bokehEnv(0.8) < 0.2,
    'đuôi phải THẤP (đo 0.12) — nếu ra ~0.59 là ai đó đã thay bảng bằng hình chuông');

/* ---------- 5) MẤT NÉT: cửa sổ HẸP HƠN cả vùng ----------
 * Đo bằng tỉ lệ năng lượng tần số cao so với bản gốc (tụt còn 0.52 ở khung 108), hiệu
 * chuẩn bằng cách làm mờ chính khung gốc -> sigma. Cửa sổ: 0 ở p≈0.10, đỉnh p≈0.41,
 * hết ở p≈0.74 — hạt sáng vẫn còn bay tới p=1 trong khi ảnh ĐÃ nét trở lại từ p≈0.75. */
assert.strictEqual(Transitions.bokehDefocusPx(0.08, 1080, 1920), 0, 'trước p=0.10 chưa mất nét');
assert.strictEqual(Transitions.bokehDefocusPx(0.80, 1080, 1920), 0, 'sau p=0.74 đã nét lại');
assert.ok(Transitions.bokehEnv(0.80) > 0.1,
    'nhưng ánh sáng thì VẪN CÒN ở p=0.80 — hai cửa sổ lệch nhau, không được gộp làm một');
const blurPeak = [...Array(201).keys()]
    .map((i) => Transitions.bokehDefocusPx(i / 200, 1080, 1920))
    .reduce((a, b) => Math.max(a, b), 0);
assert.ok(Math.abs(blurPeak - 2.2) < 0.01, `mất nét đỉnh 2.2px @1080, nhận ${blurPeak}`);
[[0.22, 0.95], [0.26, 1.31], [0.41, 2.20], [0.63, 0.83]].forEach(([p, want]) => {
    assert.ok(Math.abs(Transitions.bokehDefocusPx(p, 1080, 1920) - want) < 0.12,
        `mất nét tại p=${p} phải ≈${want}px, nhận ${Transitions.bokehDefocusPx(p, 1080, 1920)}`);
});
// Quy đổi theo CẠNH NGẮN: cùng một mẫu phải nhoè bằng nhau ở 1080 dọc và ở 4K.
assert.ok(Math.abs(Transitions.bokehDefocusPx(0.41, 2160, 3840) - 2 * blurPeak) < 1e-6,
    'độ nhoè phải nhân theo cạnh ngắn (đổi độ phân giải không được đổi dáng)');

/* ---------- 6) BẢNG HẠT: tất định và đúng phân bố đo được ---------- */
const field = Transitions.bokehField();
assert.strictEqual(field, Transitions.bokehField(), 'bảng hạt dựng MỘT LẦN rồi dùng lại');
assert.strictEqual(field.length, 360);
/* Tất định là ĐIỀU KIỆN WYSIWYG: preview và bản bake khi xuất phải ra ĐÚNG một kết quả.
   Math.random ở đây là hỏng ngầm — xem preview thấy đẹp, xuất ra khác hẳn. */
const fingerprint = field.slice(0, 5).map((q) => [q.x, q.y, q.r, q.born].map((v) => v.toFixed(6)).join(','));
assert.deepStrictEqual(fingerprint, [
    '0.692669,-0.062911,99.819037,-0.188112',
    '1.102161,0.614348,35.452610,-0.183870',
    '1.073662,0.053012,16.506705,-0.163580',
    '1.169319,0.144195,18.037498,-0.102796',
    '-0.073379,-0.013028,9.328964,-0.110945',
], 'bảng hạt phải sinh từ PRNG HẠT GIỐNG CỐ ĐỊNH — đổi hạt giống là mất WYSIWYG');

// Hai NHÓM bán kính (xem chú thích BOKEH_R_*): nhiều hạt nhỏ + vài vệt nhoè rất lớn.
const smalls = field.filter((q) => !q.big).map((q) => q.r).sort((a, b) => a - b);
const bigs = field.filter((q) => q.big).map((q) => q.r);
const at = (arr, q) => arr[Math.floor((arr.length - 1) * q)];
assert.ok(bigs.length >= 18 && bigs.length <= 26, `nhóm lớn khoảng 6% của 360, nhận ${bigs.length}`);
assert.ok(Math.abs(at(smalls, 0.5) - 12) < 3, `trung vị nhóm nhỏ ~12px @1080, nhận ${at(smalls, 0.5)}`);
assert.ok(Math.abs(at(smalls, 0.9) - 34) < 6, `phân vị 90 nhóm nhỏ ~34px @1080, nhận ${at(smalls, 0.9)}`);
assert.ok(Math.min(...bigs) >= 80 && Math.max(...bigs) <= 260,
    'nhóm lớn nằm trong 80..260px @1080 (mẫu có đốm r=115, 142, 248)');
/* MỘT đốm r=250 đã phủ ~9.5% khung 1080×1920 — chính nhóm này làm nên độ phủ sáng 13.8%
   đo được, cả trăm hạt nhỏ cộng lại không ra nổi một phần tư chừng đó. */
const bigArea = bigs.reduce((s, r) => s + Math.PI * r * r, 0);
const smallArea = smalls.reduce((s, r) => s + Math.PI * r * r, 0);
assert.ok(bigArea > smallArea * 1.5,
    'nhóm LỚN phải chiếm phần lớn diện tích sáng — nếu không, độ phủ sẽ thiếu hẳn so với mẫu');

// Thời điểm hạt sáng nhất rải theo BOKEH_DENSITY bằng phân tầng đều -> số hạt sống bám
// đúng đường mật độ. Kiểm bằng cách đếm hạt sống ở vài mốc p.
const alive = (p) => field.filter((q) => p > q.born && p < q.born + q.life).length;
const aliveTop = Math.max(...[...Array(101).keys()].map((i) => alive(i / 100)));
const topP = [...Array(101).keys()].map((i) => i / 100).find((p) => alive(p) === aliveTop);
assert.ok(Math.abs(topP - 0.39) < 0.06, `đông hạt nhất ở p≈0.39 (đo trên mẫu), nhận ${topP}`);
assert.ok(alive(0.80) / aliveTop < 0.25, 'tới p=0.80 hạt đã thưa hẳn (đo: còn 9% đỉnh)');
assert.ok(alive(0.13) / aliveTop > 0.12, 'ngay p=0.13 đã có hạt (đo: 30% đỉnh) — không được trống');

// Hướng trôi: SANG TRÁI và HƠI LÊN (đo bám vết: v ≈ (−15, −6) px/khung @30fps).
assert.ok(field.every((q) => q.vx > 0 && q.vy > 0),
    'hệ số trôi của mọi hạt phải dương — dấu nằm ở BOKEH_DRIFT_*, không ở từng hạt');
assert.ok(field.every((q) => q.sway > 0 && q.cycles > 0),
    'mọi hạt phải có biên độ và tần số ĐUNG ĐƯA — đó là chữ "Swing" của tên hiệu ứng');

/* ---------- 7) Không đi qua các cơ chế làm mượt chung ---------- */
assert.strictEqual(Transitions.SMOOTH.easing, true, 'test này chạy với easing đang bật');
// p phải giữ TUYẾN TÍNH: ba đường cong bên trong đã có dáng riêng, ease thêm là uốn hai lần.
assert.strictEqual(Transitions.progressAt(0.9, 1.8), 0.5);

/* ---------- 8) compose() chạy được ở môi trường KHÔNG có canvas ----------
 * Node không có OffscreenCanvas/document nên scratch() trả null và ctx.filter không tồn
 * tại. Đường lùi phải là "vẫn hoà được hình", không phải ném lỗi: chính đường này chạy
 * khi ai đó gọi engine từ script kiểm tra hoặc từ một môi trường lạ. */
const calls = [];
const fakeCtx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '',
    save() {}, restore() {}, clearRect() {}, fillRect() {}, drawImage() {}, beginPath() {},
    arc() {}, fill() {}, translate() {}, scale() {},
    createRadialGradient() { return { addColorStop() {} }; },
    setTransform() {},
};
[0, 0.2, 0.38, 0.5, 0.8, 1].forEach((p) => {
    calls.length = 0;
    Transitions.compose(fakeCtx, 'bokehswing', p, 1080, 1920,
        () => calls.push('A'), () => calls.push('B'), { fullFrame: true, duration: 1.8, fps: 30 });
    assert.ok(calls.length > 0, `p=${p}: phải vẽ ít nhất một lớp, không được ra khung trống`);
});
// Hai đầu mút chỉ vẽ ĐÚNG MỘT lớp (đường tắt) — vừa nhanh vừa không làm tròn qua canvas.
calls.length = 0;
Transitions.compose(fakeCtx, 'bokehswing', 0, 1080, 1920,
    () => calls.push('A'), () => calls.push('B'), { fullFrame: true, duration: 1.8, fps: 30 });
assert.deepStrictEqual(calls, ['A'], 'p=0 chỉ vẽ lớp A, không đụng lớp B');
calls.length = 0;
Transitions.compose(fakeCtx, 'bokehswing', 1, 1080, 1920,
    () => calls.push('A'), () => calls.push('B'), { fullFrame: true, duration: 1.8, fps: 30 });
assert.deepStrictEqual(calls, ['B'], 'p=1 chỉ vẽ lớp B, không đụng lớp A');

console.log('transitions-bokeh-swing: OK');
