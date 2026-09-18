const assert = require('assert');
const core = require('../../native/addon');

/* Addon C++ nay chỉ còn hai việc: trích đỉnh sóng âm và chốt timeline.
 * Bản cài đặt song song của pipeline so khớp (filterTimeline) đã gỡ ở Phase 7 —
 * xem docs/APP_INTERNALS.md. */
assert.strictEqual(typeof core.extractAudioPeaks, 'function');
assert.strictEqual(typeof core.finalizeTimeline, 'function');
assert.strictEqual(core.filterTimeline, undefined,
  'filterTimeline phải đã bị gỡ — bộ so khớp chỉ còn một bản ở core_logic.py');

const samples = new Int16Array([0, 1000, -2000, 3000, -4000, 5000, -6000, 7000]);
const peaks = core.extractAudioPeaks(samples, { numPeaks: 4 });
assert.strictEqual(peaks.length, 4);
assert.ok(peaks[0] >= 0 && peaks[0] <= 1);

// Đúng hình dạng mà renderer gửi lên /api/finalize-timeline: các mục đã tick ở
// màn "Rà soát so khớp kịch bản".
const selectedChunks = [
  {
    start: 1.24, end: 6.15, script_index: 0, chunk_index: 2,
    script_text: 'Xin chào mọi người.', text: 'Xin chào mọi người',
    loudness_dBFS: -12, similarity: 0.97, token_coverage: 1, score: 0.98,
  },
  {
    start: 9.55, end: 13.1, script_index: 1, chunk_index: 5,
    script_text: 'Hôm nay chúng ta quay video.', text: 'Hôm nay chúng ta quay video',
    loudness_dBFS: -11, similarity: 0.95, token_coverage: 1, score: 0.96,
  },
];

const finalized = core.finalizeTimeline({ selected_chunks: selectedChunks });
assert.strictEqual(Array.isArray(finalized.timeline_script_order), true);
assert.strictEqual(finalized.timeline_script_order.length, 2);

const [first, second] = finalized.timeline_script_order;
assert.strictEqual(first.script_index, 0);
assert.strictEqual(second.script_index, 1);
// Biên phải đi qua NGUYÊN VẸN: từ Phase 5 đây là biên đã bám mép từ và chừa lề theo
// khoảng lặng thật, làm tròn ở đây là phá đúng thứ vừa tính.
assert.ok(Math.abs(first.start - 1.24) < 1e-6, 'start bị đổi giá trị');
assert.ok(Math.abs(second.end - 13.1) < 1e-6, 'end bị đổi giá trị');
assert.strictEqual(first.matched_text, 'Xin chào mọi người');

assert.strictEqual(typeof finalized.edl, 'string');
assert.ok(finalized.edl.includes('USER_CUT'));
assert.strictEqual(typeof finalized.timeline_xml, 'string');
assert.ok(finalized.timeline_xml.includes('<clip script_index='));
assert.ok(finalized.timeline_xml.includes('<script_text>Xin chào mọi người.</script_text>'));

// script_index = -1 thì kế thừa chỉ số của hàng trước (renderer gửi vậy khi người
// dùng cắt một mục làm đôi).
const inherited = core.finalizeTimeline({
  selected_chunks: [
    { start: 0, end: 1, script_index: 3, text: 'a' },
    { start: 1, end: 2, script_index: -1, text: 'b' },
  ],
});
assert.strictEqual(inherited.timeline_script_order[1].script_index, 3);

console.log('native smoke ok');
