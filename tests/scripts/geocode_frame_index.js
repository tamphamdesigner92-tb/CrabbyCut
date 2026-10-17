/* =====================================================================
 * GEOCODE — PREVIEW CHỌN ĐÚNG KHUNG NHƯ BẢN XUẤT
 *
 * LỖI ĐÃ GẶP (kiểm trong Electron thật, 2026-10-17, chuỗi khung có thanh đánh số): preview
 * chậm bản xuất ĐÚNG MỘT KHUNG ở hai tình huống —
 *   1. block đặt lệch lưới khung (kéo tới 6.01 s): backend snap mốc đầu về lưới (snapT ở
 *      normalizeEditingPayload) còn preview tính từ mốc thô -> lệch ở MỌI vị trí playhead;
 *   2. playhead đứng đúng mốc khung: video.currentTime bị cắt xuống micro-giây (8.2 ->
 *      8.199999) nên floor() rơi về khung trước.
 * Cả hai đều "trông vẫn ổn" khi nhìn qua — chỉ so khung đánh số mới thấy.
 *
 * Test nạp static/js/geocode.js THẬT trong vm rồi đòi: với mọi mốc đầu (trên lưới / lệch lưới)
 * và mọi khung xuất n, khung preview tại playhead n/fps (cắt micro-giây như <video>) TRÙNG khung
 * mà bản xuất đặt ở đó. Mô hình bản xuất: image_seq bắt đầu ở round(start·fps)/fps, khung xuất n
 * hiện khung chuỗi n − round(start·fps); loop -> k % N (materializeGeocodeFrames dựng liên kết
 * cứng như vậy), không loop -> giữ khung cuối. Khớp sidecar thật đã đo ở lượt kiểm kể trên.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(projectRoot, 'static', 'js', 'geocode.js'), 'utf8');
const window = {};
const context = vm.createContext({
  window,
  _t: (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars && k in vars ? vars[k] : `{${k}}`)),
  console,
  document: { head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, appendChild() {} }), getElementById: () => null },
});
vm.runInContext(source, context, { filename: 'geocode.js' });
const GeoCode = window.GeoCode;
assert.ok(GeoCode && typeof GeoCode.frameIndexAt === 'function' && typeof GeoCode.localTimeAt === 'function',
  'geocode.js phải xuất frameIndexAt + localTimeAt');

// Giờ của <video>: currentTime chỉ giữ tới micro-giây và CẮT xuống.
const videoClock = (t) => Math.floor(t * 1e6) / 1e6;

function exportFrame(gc, n, start, seqFps) {
  const k = n - Math.round(start * seqFps);
  if (k < 0) return null;
  return gc.loop ? k % gc.frame_count : Math.min(gc.frame_count - 1, k);
}

let checked = 0;
const seqFps = 30;
for (const loop of [true, false]) {
  const gc = { kind: 'video', fps: 30, frame_count: 60, loop };
  // Mốc đầu: trên lưới, lệch lưới hai phía, lệch ngay sát nửa khung.
  for (const start of [0, 1, 6, 6.01, 6.0166, 2.987, 3.3, 0.049]) {
    const startFrame = Math.round(start * seqFps);
    for (let n = startFrame; n < startFrame + 200; n += 1) {
      const playhead = videoClock(n / seqFps);
      const preview = GeoCode.frameIndexAt(gc, GeoCode.localTimeAt(playhead, start, seqFps));
      const expected = exportFrame(gc, n, start, seqFps);
      assert.strictEqual(preview, expected,
        `loop=${loop} start=${start} khung xuất ${n} (playhead ${playhead}): preview ${preview} ≠ xuất ${expected}`);
      checked += 1;
    }
  }
}

// Không có fps sequence (chưa có lane chính) -> giữ mốc thô, không chia cho 0.
assert.strictEqual(GeoCode.localTimeAt(5, 1.5, 0), 3.5);
assert.strictEqual(GeoCode.localTimeAt(5, 1.5, undefined), 3.5);
// Ảnh tĩnh luôn khung 0.
assert.strictEqual(GeoCode.frameIndexAt({ kind: 'image', frame_count: 1 }, 7.3), 0);

console.log(`geocode_frame_index: OK (${checked} vị trí playhead)`);
