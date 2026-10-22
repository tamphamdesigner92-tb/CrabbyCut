/**
 * SUBSEQUENCE (NEST) — phần tính toán thuần (static/js/nest-sequence.js):
 * gói block thành nội dung sequence con, bung ngược ra, quy đổi giờ, quét sâu asset.
 */
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const N = require(path.join(ROOT, 'static', 'js', 'nest-sequence.js'));

function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); } catch (error) { console.error(`FAIL - ${name}`); throw error; }
}

let seq = 0;
const newId = (prefix) => () => `${prefix}${++seq}`;

const tracks = [
  { id: 'tText', type: 'text', order: 0 },
  { id: 'tV2', type: 'media', order: 1 },
  { id: 'tV1', type: 'media', order: 2 },
  { id: 'track_main', type: 'main', order: 3 },
  { id: 'tA1', type: 'audio', order: 4 },
];

test('planNest: dời về gốc t0, mỗi lane dùng tới -> một lane mới giữ thứ tự', () => {
  const items = [
    { id: 'a', type: 'media', track_id: 'tV1', timeline_start: 10, duration: 4, asset_id: 'v' },
    { id: 'b', type: 'media', track_id: 'tV2', timeline_start: 12, duration: 3, asset_id: 'img' },
    { id: 'c', type: 'audio', track_id: 'tA1', timeline_start: 11, duration: 6, asset_id: 'mp3' },
  ];
  const plan = N.planNest(items, tracks, (type) => `new_${type}_${++seq}`);
  assert.strictEqual(plan.t0, 10);
  assert.strictEqual(plan.duration, 7);   // 11 + 6 - 10
  assert.deepStrictEqual(plan.tracks.map((t) => t.type), ['media', 'media', 'audio']);
  const byId = Object.fromEntries(plan.items.map((it) => [it.id, it]));
  assert.strictEqual(byId.a.timeline_start, 0);
  assert.strictEqual(byId.b.timeline_start, 2);
  assert.strictEqual(byId.c.timeline_start, 1);
  // lane V2 (trên) vẫn trên lane V1 (dưới) bên trong
  const order = Object.fromEntries(plan.tracks.map((t) => [t.id, t.order]));
  assert.ok(order[byId.b.track_id] < order[byId.a.track_id]);
  // không đụng vào item gốc
  assert.strictEqual(items[0].timeline_start, 10);
  assert.ok(plan.movedIds.has('a') && plan.movedIds.has('c'));
});

test('planNest: chuyển cảnh chỉ giữ khi block kề bên phải cũng được gói', () => {
  const items = [
    { id: 'l', type: 'media', track_id: 'tV1', timeline_start: 0, duration: 2, transition: { type: 'fade', duration: 0.5 } },
    { id: 'r', type: 'media', track_id: 'tV1', timeline_start: 2, duration: 2, transition: { type: 'fade', duration: 0.5 } },
  ];
  const plan = N.planNest(items, tracks, newId('t'));
  const byId = Object.fromEntries(plan.items.map((it) => [it.id, it]));
  assert.ok(byId.l.transition, 'cặp l|r còn nguyên trong gói');
  assert.ok(!byId.r.transition, 'r không còn block kề bên phải');
});

test('dropDanglingTransitions: block cha trỏ sang block vừa bị gói thì mất chuyển cảnh', () => {
  const parent = [
    { id: 'x', track_id: 'tV1', timeline_start: 0, duration: 2, transition: { type: 'fade' } },
    { id: 'y', track_id: 'tV1', timeline_start: 2, duration: 2 },
  ];
  N.dropDanglingTransitions(parent.filter((it) => it.id !== 'y'), new Set(['y']));
  assert.ok(!parent[0].transition);
});

test('childTimeAt: theo source_start và tốc độ của block Subsequence', () => {
  const item = { timeline_start: 5, source_start: 1, speed: { rate: 2 } };
  assert.strictEqual(N.childTimeAt(item, 5), 1);
  assert.strictEqual(N.childTimeAt(item, 6.5), 4);
});

test('planUnnest: cắt theo cửa sổ đang hiện, dời điểm nguồn của video bị cắt mép trái', () => {
  const content = {
    items: [
      { id: 'v', type: 'media', track_id: 'in1', timeline_start: 0, duration: 6, source_start: 2 },
      { id: 't', type: 'text', track_id: 'in2', timeline_start: 5, duration: 3 },
      { id: 'gone', type: 'text', track_id: 'in2', timeline_start: 0, duration: 0.5 },
    ],
  };
  const nestItem = { timeline_start: 20, duration: 4, source_start: 1 };   // cửa sổ [1, 5]
  const out = N.planUnnest(nestItem, content, (child) => child.type === 'media');
  const byId = Object.fromEntries(out.map((p) => [p.item.id, p.item]));
  assert.ok(!byId.gone, 'block nằm ngoài cửa sổ bị bỏ');
  assert.ok(!byId.t, 'block bắt đầu đúng mép phải cửa sổ bị bỏ');
  assert.strictEqual(byId.v.timeline_start, 20);
  assert.strictEqual(byId.v.duration, 4);
  assert.strictEqual(byId.v.source_start, 3);   // 2 + 1 giây bị cắt
  assert.strictEqual(N.planUnnest({ ...nestItem, speed: { rate: 1.5 } }, content, () => true), null);
});

test('collectDeepItems / referencedNestIds / nestContains: lồng nhiều cấp, dùng chung, vòng', () => {
  const inner = { id: 'nB', source: 'nest', nest: { tracks: [], items: [{ id: 'i2', type: 'media', asset_id: 'clip' }] } };
  const outer = { id: 'nA', source: 'nest', nest: { tracks: [], items: [
    { id: 'i1', type: 'media', asset_id: 'nB' },
    { id: 'i1b', type: 'media', asset_id: 'nB' },
  ] } };
  const assets = [inner, outer, { id: 'clip', type: 'media_video' }];
  const root = [{ id: 'r1', type: 'media', asset_id: 'nA' }];
  const deep = N.collectDeepItems(root, assets).map((it) => it.id);
  assert.deepStrictEqual(deep, ['r1', 'i1', 'i2', 'i1b'], 'nội dung dùng chung chỉ duyệt một lần');
  assert.deepStrictEqual([...N.referencedNestIds(root, assets)].sort(), ['nA', 'nB']);
  assert.ok(N.nestContains('nA', 'nB', assets));
  assert.ok(!N.nestContains('nB', 'nA', assets));
  // vòng tham chiếu không treo
  inner.nest.items.push({ id: 'loop', type: 'media', asset_id: 'nA' });
  assert.ok(N.collectDeepItems(root, assets).length < 20);
});

test('contentDuration + contentHasAudio + cloneContent + nextNestName', () => {
  const content = { tracks: [{ id: 'k', type: 'media' }], items: [
    { id: 'm', type: 'media', track_id: 'k', timeline_start: 1, duration: 2, asset_id: 'img' },
  ] };
  assert.strictEqual(N.contentDuration(content), 3);
  assert.strictEqual(N.contentDuration({ items: [] }), 0.2);
  assert.ok(!N.contentHasAudio(content, [{ id: 'img', type: 'media_image', has_audio: false }]));
  assert.ok(N.contentHasAudio(content, [{ id: 'img', type: 'media_video', has_audio: true }]));
  const copy = N.cloneContent(content, (t) => `T_${t}`, newId('I'));
  assert.notStrictEqual(copy.items[0].id, 'm');
  assert.strictEqual(copy.items[0].track_id, copy.tracks[0].id);
  assert.strictEqual(content.items[0].id, 'm', 'bản gốc không đổi');
  const names = [{ source: 'nest', nest: {}, name: 'Subsequence 1' }, { source: 'nest', nest: {}, name: 'Subsequence 3' }];
  assert.strictEqual(N.nextNestName(names), 'Subsequence 2');
});
