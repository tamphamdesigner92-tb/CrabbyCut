/**
 * Smoke test cho static/js/magic-fill-assets.js — phần logic thuần của Magic Fill khi
 * tìm ảnh/video trong library/ theo từ khoá (ghi chú /*…*\/) của kịch bản chuẩn.
 * Chạy: npm run test:magic-fill-assets
 */
const assert = require('assert');
const path = require('path');

const MFA = require(path.join(__dirname, '..', '..', 'static', 'js', 'magic-fill-assets.js'));
const { normalizeMarkdownScript } = require(path.join(__dirname, '..', '..', 'static', 'js', 'script-markdown.js'));

// Danh mục library giả lập theo đúng quy ước tên file thật của dự án:
//   [Tiền tố] từ khoá 1, từ khoá 2 - số
const LIBRARY = [
  { name: '[Vid] Be om, be gay - 1.mp4', rel_path: 'Video/[Vid] Be om, be gay - 1.mp4', type: 'media_video' },
  { name: '[Vid] Be om, be gay - 2.mp4', rel_path: 'Video/[Vid] Be om, be gay - 2.mp4', type: 'media_video' },
  { name: '[Vid] Be khoe, be tuoi cuoi - 1.mp4', rel_path: 'Video/[Vid] Be khoe, be tuoi cuoi - 1.mp4', type: 'media_video' },
  { name: '[Vid] Be di hoc.mp4', rel_path: 'Video/[Vid] Be di hoc.mp4', type: 'media_video' },
  { name: '[Icon] Wellmune.png', rel_path: 'Elements/[Icon] Wellmune.png', type: 'media_image' },
  { name: '[Icon] Lactoferrin.png', rel_path: 'Elements/[Icon] Lactoferrin.png', type: 'media_image' },
  { name: '[Illus] Om, sot - 1.png', rel_path: 'Elements/[Illus] Om, sot - 1.png', type: 'media_image' },
  { name: '[Illus] Giam phat trien chieu cao - 1.png', rel_path: 'Elements/[Illus] Giam phat trien chieu cao - 1.png', type: 'media_image' },
  { name: '[Icon] True.png', rel_path: 'Elements/[Icon] True.png', type: 'media_image' },
  { name: '[Icon] Wrong.png', rel_path: 'Elements/[Icon] Wrong.png', type: 'media_image' },
  { name: '[Icon] Logo LE.png', rel_path: 'Elements/[Icon] Logo LE.png', type: 'media_image' },
  { name: '[Icon] HMO.png', rel_path: 'Elements/[Icon] HMO.png', type: 'media_image' },
  { name: '[Icon] DHA.png', rel_path: 'Elements/[Icon] DHA.png', type: 'media_image' },
  { name: '[Icon] Sua non.png', rel_path: 'Elements/[Icon] Sua non.png', type: 'media_image' },
  { name: '[Icon] Dam A2.png', rel_path: 'Elements/[Icon] Dam A2.png', type: 'media_image' },
  { name: '[Illus] Loi khuan.png', rel_path: 'Elements/[Illus] Loi khuan.png', type: 'media_image' },
  { name: '[Illus] Chuyen gia, chuyen gia y te.png', rel_path: 'Elements/[Illus] Chuyen gia, chuyen gia y te.png', type: 'media_image' },
  { name: '[SFXs] Swish.MP3', rel_path: 'SFXs/[SFXs] Swish.MP3', type: 'audio' },
];

const FIRST = () => 0;   // random giả lập: luôn lấy ứng viên đầu tiên (test tất định)

/* ---------- describeAssetName: [Tiền tố] nội dung - số ---------- */
{
  const vid = MFA.describeAssetName('[Vid] Be khoe, be tuoi cuoi - 1.mp4', 'media_video');
  assert.strictEqual(vid.tag, 'vid');
  assert.strictEqual(vid.kind, MFA.KIND_COVER);
  assert.strictEqual(vid.base, 'Be khoe, be tuoi cuoi');           // đã cắt hậu tố "- 1" + đuôi file
  assert.deepStrictEqual(vid.keywords.map((k) => k.text), ['Be khoe', 'be tuoi cuoi']);

  assert.strictEqual(MFA.describeAssetName('[Icon] Wellmune.png', 'media_image').kind, MFA.KIND_INSET);
  assert.strictEqual(MFA.describeAssetName('[Illus] Om, sot - 1.png', 'media_image').kind, MFA.KIND_INSET);
  // [SFXs]/[Mus] không phải đối tượng hình -> không bao giờ được đặt vào khung
  assert.strictEqual(MFA.describeAssetName('[SFXs] Swish.MP3', 'audio').kind, MFA.KIND_AUDIO);
  assert.strictEqual(MFA.describeAssetName('[Mus] Nen vui.mp3', 'audio').kind, MFA.KIND_AUDIO);
  // Không có tiền tố -> suy theo loại file
  assert.strictEqual(MFA.describeAssetName('bcast.mp4', 'media_video').kind, MFA.KIND_COVER);
  assert.strictEqual(MFA.describeAssetName('bcast.png', 'media_image').kind, MFA.KIND_INSET);
  // Hậu tố CHỈ cắt khi có dấu gạch — "Omega 3" phải giữ nguyên số 3
  assert.strictEqual(MFA.describeAssetName('[Icon] Omega 3.png', 'media_image').base, 'Omega 3');
}

/* ---------- splitNoteKeywords: tách theo "," HOẶC "/" ---------- */
{
  assert.deepStrictEqual(MFA.splitNoteKeywords('Be om, be gay'), ['Be om', 'be gay']);
  assert.deepStrictEqual(MFA.splitNoteKeywords('Be om / be gay'), ['Be om', 'be gay']);
  assert.deepStrictEqual(MFA.splitNoteKeywords('Om, sot / gay yeu'), ['Om', 'sot', 'gay yeu']);
  assert.deepStrictEqual(MFA.splitNoteKeywords('  Om  '), ['Om']);
  assert.deepStrictEqual(MFA.splitNoteKeywords('a,,  ,b'), ['a', 'b']);
}

/* ---------- noteMatchRatio: tỉ lệ từ khoá CỦA TÊN FILE có trong ghi chú ---------- */
{
  // CA LỖI THẬT (2026-08-03): mẫu số phải là ĐỘ DÀI TỪ KHOÁ, không phải số từ khoá của file.
  // "Be om" nằm trọn trong "bé ốm/ ho/ khóc" -> 2/2 = 100%, dù từ khoá "be gay" không khớp.
  assert.strictEqual(MFA.noteMatchRatio('[Vid] Be om, be gay - 1.mp4', 'bé ốm/ ho/ khóc', 'media_video'), 1);
  // 1 chữ khớp trong từ khoá 1 chữ -> 100%
  assert.strictEqual(MFA.noteMatchRatio('[Illus] Om, sot - 1.png', 'bé ốm/ ho/ khóc', 'media_image'), 1);
  assert.strictEqual(MFA.noteMatchRatio('[Icon] Wellmune.png', 'Wellmune, de khang', 'media_image'), 1);
  // Ghi chú ngăn bằng "/" cũng như ","
  assert.strictEqual(MFA.noteMatchRatio('[Vid] Be khoe, be tuoi cuoi - 1.mp4', 'be khoe / be tuoi cuoi', 'media_video'), 1);
  // Chỉ chung một chữ "be" trong từ khoá 2 chữ -> 1/2 = 50% -> CHƯA đạt (cần TRÊN 50%)
  assert.strictEqual(MFA.noteMatchRatio('[Vid] Be khoe, be tuoi cuoi - 1.mp4', 'Be om, be gay', 'media_video'), 0.5);
  // CA LỖI THẬT: "Giam phat trien chieu cao" (5 chữ)
  //   - trong "…phát triển chiều cao…" = 4/5 = 80% -> khớp (đúng chỗ của nó)
  //   - trong "giảm số ngày ốm"        = 1/5 = 20% -> KHÔNG khớp (trước đây bị khớp oan)
  assert.strictEqual(
    MFA.noteMatchRatio('[Illus] Giam phat trien chieu cao - 1.png', 'guồn lực dành cho tăng cân và phát triển chiều cao sẽ ít đi', 'media_image'), 0.8);
  assert.strictEqual(
    MFA.noteMatchRatio('[Illus] Giam phat trien chieu cao - 1.png', 'giảm số ngày ốm', 'media_image'), 0.2);
}

/* ---------- matchNoteAssets: 1 [Vid] + 1 [Icon]/[Illus] mỗi ghi chú ---------- */
{
  // CA LỖI THẬT: ghi chú "bé ốm/ ho/ khóc" phải ra được video (trước đây ra rỗng)
  const real = MFA.matchNoteAssets('bé ốm/ ho/ khóc', LIBRARY, { random: FIRST });
  assert.ok(real.cover, 'ghi chú "bé ốm/ ho/ khóc" phải chọn được 1 [Vid]');
  assert.ok(real.cover.asset.name.startsWith('[Vid] Be om, be gay'));
  assert.strictEqual(real.inset.asset.name, '[Illus] Om, sot - 1.png');

  // 2 biến thể "- 1"/"- 2" cùng khớp 100% -> bốc ngẫu nhiên, cả 2 đều hợp lệ
  const variants = new Set();
  for (const roll of [0, 0.99]) {
    variants.add(MFA.matchNoteAssets('Be om, be gay', LIBRARY, { random: () => roll }).cover.asset.name);
  }
  assert.deepStrictEqual([...variants].sort(),
    ['[Vid] Be om, be gay - 1.mp4', '[Vid] Be om, be gay - 2.mp4']);

  // File khớp 100% không bao giờ thua file khớp thấp hơn dù bốc ngẫu nhiên
  // ("bé đi học…" khớp Be di hoc 100% và Be khoe, be vui choi 67%)
  for (const roll of [0, 0.4, 0.99]) {
    const pick = MFA.matchNoteAssets('bé đi học, chơi với các bạn', LIBRARY, { random: () => roll });
    assert.strictEqual(pick.cover.asset.name, '[Vid] Be di hoc.mp4');
  }

  // Không liên quan -> rỗng; [SFXs] không bao giờ được chọn làm đối tượng hình
  const none = MFA.matchNoteAssets('ngan sach quang cao, swish', LIBRARY, { random: FIRST });
  assert.strictEqual(none.cover, null);
  assert.strictEqual(none.inset, null);
}

/* ---------- matchBoldAsset: dùng CHUNG luật khớp với ghi chú ---------- */
{
  // "ốm vặt" -> từ khoá "Om" phủ 100% -> khớp; chỉ nhận icon/illus, không nhận [Vid]
  const om = MFA.matchBoldAsset('ốm vặt', LIBRARY);
  assert.strictEqual(om.asset.name, '[Illus] Om, sot - 1.png');
  assert.strictEqual(om.kind, MFA.KIND_INSET);

  // CA LỖI THẬT: "giảm số ngày ốm" KHÔNG được kéo [Illus] Giam phat trien chieu cao vào
  // (chỉ chung mỗi chữ "giảm" = 1/5 = 20%); chỉ [Illus] Om, sot là hợp lệ.
  assert.strictEqual(MFA.matchBoldAsset('giảm số ngày ốm', LIBRARY).asset.name, '[Illus] Om, sot - 1.png');

  // …nhưng nó vẫn khớp ĐÚNG chỗ của nó (4/5 = 80%)
  const cao = MFA.matchBoldAsset('guồn lực dành cho tăng cân và phát triển chiều cao sẽ ít đi', LIBRARY);
  assert.strictEqual(cao.asset.name, '[Illus] Giam phat trien chieu cao - 1.png');

  assert.strictEqual(MFA.matchBoldAsset('Wellmune', LIBRARY).asset.name, '[Icon] Wellmune.png');
  // Lọc theo tiền tố: cùng một cụm, hỏi riêng [Illus] thì [Icon] Wellmune không được trả
  assert.strictEqual(MFA.matchBoldAsset('Wellmune', LIBRARY, { tags: ['illus'] }), null);
  // Bold không liên quan -> null
  assert.strictEqual(MFA.matchBoldAsset('ngân sách quý bốn', LIBRARY), null);
  assert.strictEqual(MFA.matchBoldAsset('và của', LIBRARY), null);
}

/* ---------- splitBoldPhrase: CHỈ tách bằng dấu "," ---------- */
{
  assert.deepStrictEqual(MFA.splitBoldPhrase('HMO, lợi khuẩn, DHA, đạm A2'),
    { parts: ['HMO', 'lợi khuẩn', 'DHA', 'đạm A2'], split: true });
  /* Từ nối BÊN TRONG một cụm bold chỉ là chữ bình thường của cụm, KHÔNG chia (người dùng
     chốt 2026-09-16): "**canxi và vitamin D**" là MỘT cụm, không phải hai. */
  assert.deepStrictEqual(MFA.splitBoldPhrase('canxi và vitamin D'),
    { parts: ['canxi và vitamin D'], split: false });
  assert.deepStrictEqual(MFA.splitBoldPhrase('sữa non HOẶC lợi khuẩn'),
    { parts: ['sữa non HOẶC lợi khuẩn'], split: false });
  // Có "," thì mới tách — từ nối nằm trong một phần vẫn giữ nguyên văn phần đó
  assert.deepStrictEqual(MFA.splitBoldPhrase('HMO, lợi khuẩn hay sữa non'),
    { parts: ['HMO', 'lợi khuẩn hay sữa non'], split: true });
  // Cụm liền mạch -> nguyên văn, KHÔNG tách
  assert.deepStrictEqual(MFA.splitBoldPhrase('phát triển chiều cao'),
    { parts: ['phát triển chiều cao'], split: false });
  assert.deepStrictEqual(MFA.splitBoldPhrase('hay quá'),
    { parts: ['hay quá'], split: false });
}

/* ---------- boldJoinerKind: chữ xen giữa 2 cụm bold có cho gộp không ---------- */
{
  assert.strictEqual(MFA.boldJoinerKind(' '), 'space');
  assert.strictEqual(MFA.boldJoinerKind(''), 'space');
  assert.strictEqual(MFA.boldJoinerKind(', '), 'separator');
  assert.strictEqual(MFA.boldJoinerKind(' , '), 'separator');
  /* Từ nối KHÔNG còn cho gộp (thu hẹp 2026-09-16): chỉ khoảng trắng và "," mới gộp. */
  assert.strictEqual(MFA.boldJoinerKind(' hay '), null);
  assert.strictEqual(MFA.boldJoinerKind(' và '), null);
  assert.strictEqual(MFA.boldJoinerKind(' HOẶC '), null);
  // Có một chữ THẬT -> hai cụm rời nhau, không được gộp
  assert.strictEqual(MFA.boldJoinerKind(' là công thức '), null);
  assert.strictEqual(MFA.boldJoinerKind(' của '), null);
}

/* ---------- groupBoldRanges + planBoldGroups: CA LỖI THẬT của dự án "Bin Tom - Tap 3" ----
 * Kịch bản gõ NĂM cụm bold rời (**HMO**, **lợi khuẩn** hay **sữa non**…), không phải một
 * cụm có dấu phân chia — bản đầu xử lý từng cụm nên chỉ "lợi khuẩn" ra mẫu Custom.
 * Dựng bold_ranges bằng CHÍNH parser thật (normalizeMarkdownScript) thay vì viết tay
 * offset: viết tay là sớm muộn cũng lệch khỏi thứ parser sinh ra.
 * ------------------------------------------------------------------------------------ */
const planOf = (md, assets = LIBRARY, options = {}) => {
  const r = normalizeMarkdownScript(md, { sourceType: 'md', sourceName: 't.md' });
  const bolds = (r.metadata.bold_ranges || []).filter((b) => b && String(b.text || '').trim());
  const groups = MFA.groupBoldRanges(bolds, r.clean_text);
  const { builds, fallbackIndex } = MFA.planBoldGroups(groups, assets, options);
  return { groups, builds, fallbackIndex, clean: r.clean_text };
};
// Mô tả gọn một build để so sánh: [mode, chữ, tên file]
const shape = (build) => build.units.map((u) => [u.mode, u.texts ? u.texts.join(' | ') : u.text, u.asset ? u.asset.name : null]);

{
  // ===== GỘP: 5 cụm bold rời ngăn nhau bằng "," -> MỘT nhóm liệt kê =====
  const five = planOf('Thành phần nổi bật như **HMO**, **lợi khuẩn**, **sữa non**, **DHA**, **đạm A2**.');
  assert.strictEqual(five.groups.length, 1, 'năm cụm bold liền kề phải gộp thành MỘT nhóm');
  assert.deepStrictEqual(five.groups[0].indices, [0, 1, 2, 3, 4]);
  assert.strictEqual(five.groups[0].text, 'HMO, lợi khuẩn, sữa non, DHA, đạm A2');
  assert.strictEqual(five.builds.length, 1);
  assert.deepStrictEqual(shape(five.builds[0]), [
    ['template', 'HMO', '[Icon] HMO.png'],
    ['template', 'lợi khuẩn', '[Illus] Loi khuan.png'],
    ['template', 'sữa non', '[Icon] Sua non.png'],
    ['template', 'DHA', '[Icon] DHA.png'],
    ['template', 'đạm A2', '[Icon] Dam A2.png'],
  ]);
  assert.deepStrictEqual(five.builds[0].units.map((u) => u.variant),
    ['icon', 'illus', 'icon', 'icon', 'icon']);

  /* ===== KHÔNG GỘP qua từ nối: "hay"/"và"/"hoặc" xen giữa hai cụm bold là hai nhóm RỜI
     (người dùng chốt 2026-09-16 — trước đó chúng cho gộp thành nhóm liệt kê). ===== */
  const conj = planOf('Thành phần nổi bật như **HMO** hay **sữa non**.');
  assert.strictEqual(conj.groups.length, 2, '"hay" xen giữa -> hai nhóm rời');
  assert.deepStrictEqual(conj.groups.map((g) => g.text), ['HMO', 'sữa non']);
  /* …và HAI nhóm nối bằng "hay" cũng KHÔNG được gộp thành Zoom Title: hai vế nối bằng từ
     nối là hai ý ngang hàng, không phải cặp tiêu đề + dòng phụ. */
  assert.strictEqual(conj.builds.length, 2, '"hay" xen giữa -> không gộp Zoom Title');
  assert.ok(conj.builds.every((b) => b.units[0].mode !== 'zoom'));
  assert.ok(planOf('Nhờ **HMO** và **sữa non** đó.').builds.every((b) => b.units[0].mode !== 'zoom'));
  assert.ok(planOf('Nhờ **HMO** hoặc **sữa non** đó.').builds.every((b) => b.units[0].mode !== 'zoom'));

  /* ===== Từ nối BÊN TRONG một cụm bold: KHÔNG chia nhỏ, cả cụm là MỘT phần (người dùng
     chốt 2026-09-16). Trước đó cụm này bị cắt thành "sữa non" + "lợi khuẩn" -> hai mẫu. */
  const inner = planOf('Nhờ **sữa non hay lợi khuẩn** đó.');
  assert.strictEqual(inner.groups.length, 1);
  assert.deepStrictEqual(inner.groups[0].parts, ['sữa non hay lợi khuẩn']);
  assert.strictEqual(inner.groups[0].enumerated, false, 'từ nối không biến cụm thành liệt kê');
  assert.deepStrictEqual(shape(inner.builds[0]),
    [['template', 'sữa non hay lợi khuẩn', '[Illus] Loi khuan.png']]);

  /* ===== Từ nối ĐƯỢC BÔI ĐẬM thì nó là một cụm bold: hai bên nối với nó bằng khoảng
     trắng -> tất cả về CÙNG MỘT nhóm (không phải hai nhóm, nên không đụng Zoom Title). */
  const boldConj = planOf('Nhờ **HMO** **và** **sữa non** nhé.');
  assert.strictEqual(boldConj.groups.length, 1, 'từ nối in đậm -> gộp bằng khoảng trắng');
  assert.strictEqual(boldConj.groups[0].text, 'HMO và sữa non');
  assert.deepStrictEqual(boldConj.groups[0].parts, ['HMO và sữa non']);
  assert.strictEqual(boldConj.builds.length, 1);
  assert.notStrictEqual(boldConj.builds[0].units[0].mode, 'zoom');

  // ===== GỘP bằng KHOẢNG TRẮNG: 3 cụm rời -> MỘT cụm liền mạch, ≥ 6 từ -> Vlog Tag =====
  const long = planOf('Trẻ có **đủ điều kiện** **để** **tăng trưởng và phát triển bình thường** hay không.');
  assert.strictEqual(long.groups.length, 1, 'ba cụm cách nhau một khoảng trắng phải gộp');
  assert.strictEqual(long.groups[0].text, 'đủ điều kiện để tăng trưởng và phát triển bình thường');
  assert.deepStrictEqual(shape(long.builds[0]),
    [['vlog', 'đủ điều kiện để tăng trưởng và phát triển bình thường', null]]);

  // ===== CÂU có ĐÚNG HAI nhóm cách nhau bằng chữ thường -> MỘT mẫu Zoom Title =====
  const two = planOf('Bởi một **công thức tốt** là công thức **được** **thiết kế cân bằng** ngay từ đầu.');
  assert.strictEqual(two.groups.length, 2, '"là công thức" là chữ thật -> hai nhóm');
  assert.deepStrictEqual(two.groups.map((g) => g.text), ['công thức tốt', 'được thiết kế cân bằng']);
  assert.strictEqual(two.builds.length, 1, 'hai nhóm cùng câu phải gộp thành MỘT khối');
  assert.deepStrictEqual(shape(two.builds[0]), [['zoom', 'công thức tốt | được thiết kế cân bằng', null]]);
  assert.deepStrictEqual(two.builds[0].units[0].texts, ['công thức tốt', 'được thiết kế cân bằng']);
  assert.deepStrictEqual(two.builds[0].groups, [0, 1]);

  /* Hai nhóm nhưng MỘT nhóm là câu LIỆT KÊ (bị dấu "," chia nhỏ) -> KHÔNG gộp Zoom Title:
     nhồi danh sách vào hai ô chữ là mất mục; nhóm liệt kê phải lên mẫu Custom từng mục. */
  const twoList = planOf('Gồm **HMO**, **sữa non** là nhờ **công thức tốt** thôi.');
  assert.strictEqual(twoList.groups.length, 2);
  assert.strictEqual(twoList.builds.length, 2, 'nhóm có dấu "," -> không gộp Zoom Title');
  assert.ok(twoList.builds.every((b) => b.units[0].mode !== 'zoom'));
  assert.deepStrictEqual(shape(twoList.builds[0]), [
    ['template', 'HMO', '[Icon] HMO.png'],
    ['template', 'sữa non', '[Icon] Sua non.png'],
  ]);

  // Hai nhóm nhưng KHÁC CÂU (khác dòng) -> KHÔNG gộp
  const twoLines = planOf('Một **công thức tốt** thôi.\nCòn **ngân sách quý bốn** thì khác.');
  assert.strictEqual(twoLines.builds.length, 2, 'khác dòng thì không phải "cùng một câu"');
  assert.ok(twoLines.builds.every((b) => b.units[0].mode !== 'zoom'));

  // BA nhóm cùng câu -> KHÔNG gộp (Zoom Title chỉ có 2 ô chữ, nhóm thứ ba sẽ biến mất)
  const three = planOf('Có **công thức tốt** rồi **ngân sách quý bốn** rồi **đợt kiểm tra sau** nữa.');
  assert.strictEqual(three.groups.length, 3);
  assert.ok(three.builds.every((b) => b.units[0].mode !== 'zoom'), 'ba nhóm thì không gộp Zoom Title');
}

/* ---------- planBoldGroup: từng luật một ---------- */
{
  // (1) Thương hiệu -> ảnh logo, KHÔNG chữ, và KHÔNG bị gộp Zoom Title
  const logo = planOf('Cách mà **Little Étoile** làm.');
  assert.deepStrictEqual(shape(logo.builds[0]), [['logo', 'Little Étoile', '[Icon] Logo LE.png']]);
  const logoPair = planOf('Thì **Little Étoile** cũng là **công thức tốt** thôi.');
  assert.ok(logoPair.builds.every((b) => b.units[0].mode !== 'zoom'), 'nhóm logo không bao giờ bị gộp');
  assert.ok(logoPair.builds.some((b) => b.units[0].mode === 'logo'));

  // (3) ≥ 6 từ THẮNG cả việc khớp [Illus] (người dùng chốt 2026-09-16)
  const longIllus = planOf('Là **chuyên gia y tế hàng đầu trong nước ta** đó.');
  assert.strictEqual(MFA.BOLD_LONG_PHRASE_WORDS, 6);
  assert.deepStrictEqual(shape(longIllus.builds[0])[0][0], 'vlog');
  // …nhưng đúng cụm đó rút ngắn < 6 từ thì lại về mẫu Custom kiểu illus
  const shortIllus = planOf('Là **chuyên gia y tế** đó.');
  assert.deepStrictEqual(shape(shortIllus.builds[0]),
    [['template', 'chuyên gia y tế', '[Illus] Chuyen gia, chuyen gia y te.png']]);

  // (4) Cụm liền mạch ngắn chỉ khớp [Icon] -> ẢNH TRẦN, không kèm chữ
  assert.deepStrictEqual(shape(planOf('Có **Wellmune** nhé.').builds[0]),
    [['image', 'Wellmune', '[Icon] Wellmune.png']]);

  // (5) Không khớp gì, < 6 từ -> chữ thường
  assert.deepStrictEqual(shape(planOf('Về **ngân sách quý bốn** nhé.').builds[0]),
    [['text', 'ngân sách quý bốn', null]]);

  /* (2) MỘT phần khớp là CẢ nhóm lên mẫu; phần không khớp mượn hình bất kỳ — nhưng không
     bao giờ là True/Wrong (nghĩa đúng/sai) hay logo thương hiệu. */
  const mixed = planOf('Gồm **HMO**, **ngân sách quý bốn** nhé.');
  const mu = mixed.builds[0].units;
  assert.deepStrictEqual(mu.map((u) => u.mode), ['template', 'template']);
  assert.strictEqual(mu[0].asset.name, '[Icon] HMO.png');
  assert.strictEqual(mu[1].fallback, true);
  assert.ok(!['[Icon] True.png', '[Icon] Wrong.png', '[Icon] Logo LE.png'].includes(mu[1].asset.name),
    `hình bất kỳ không được mang nghĩa: ${mu[1].asset.name}`);
  // Con trỏ luân phiên tiến lên -> lần sau mượn hình KHÁC
  assert.strictEqual(mixed.fallbackIndex, 1);
  const mixed2 = planOf('Gồm **HMO**, **ngân sách quý bốn** nhé.', LIBRARY, { fallbackIndex: mixed.fallbackIndex });
  assert.notStrictEqual(mixed2.builds[0].units[1].asset.name, mu[1].asset.name);

  // (2) Nhóm liệt kê KHÔNG phần nào khớp: < 6 từ -> chữ NGUYÊN VĂN (không cắt thành mảnh)
  assert.deepStrictEqual(shape(planOf('Giữa **lợi ích**, **nguy cơ** nữa.').builds[0]),
    [['text', 'lợi ích, nguy cơ', null]]);
  // …còn ≥ 6 từ thì rơi sang Vlog Tag, không phải mấy box chữ đứng cạnh nhau
  assert.strictEqual(shape(planOf('Giữa **lợi ích rất lớn**, **nguy cơ khó lường** nữa.').builds[0])[0][0], 'vlog');

  // Kho "hình bất kỳ" loại sạch [Vid]/[SFXs] lẫn ba hình mang nghĩa
  const pool = MFA.boldFallbackAssets(LIBRARY).map((x) => x.asset.name);
  assert.ok(pool.length >= 2);
  assert.ok(pool.every((n) => n.startsWith('[Icon]') || n.startsWith('[Illus]')));
  assert.ok(!pool.includes('[Icon] Logo LE.png') && !pool.includes('[Icon] True.png') && !pool.includes('[Icon] Wrong.png'));
}

/* ---------- groupBoldRanges: offset lệch thì KHÔNG gộp bừa ---------- */
{
  /* Kịch bản chuẩn bị sửa tay sau khi parser ghi offset (ca thật: ô "đang hiệu chỉnh" có
     thêm dòng so với ô nhập). Thà lỡ một phép gộp còn hơn gộp nhầm hai cụm cách nhau cả
     câu — thứ hỏng ÂM THẦM, không có lỗi nào báo ra. */
  const r = normalizeMarkdownScript('Có **HMO**, **DHA** nhé.', { sourceType: 'md', sourceName: 't.md' });
  const bolds = r.metadata.bold_ranges;
  const shifted = `MỘT DÒNG THÊM VÀO\n${r.clean_text}`;
  assert.strictEqual(MFA.groupBoldRanges(bolds, r.clean_text).length, 1, 'đúng kịch bản thì gộp');
  assert.strictEqual(MFA.groupBoldRanges(bolds, shifted).length, 2, 'offset lệch thì mỗi cụm đứng riêng');
}

/* ---------- boldTextInAnimation: luân phiên, 2 cụm liền nhau không trùng ---------- */
{
  const seen = [];
  for (let i = 0; i < MFA.BOLD_TEXT_IN_ANIMATIONS.length + 3; i += 1) seen.push(MFA.boldTextInAnimation(i).type);
  for (let i = 1; i < seen.length; i += 1) assert.notStrictEqual(seen[i], seen[i - 1], `trùng hiệu ứng ở cụm ${i}`);
  // Chạy lại cùng chỉ số ra cùng kết quả (tái lập được, không bốc ngẫu nhiên)
  assert.strictEqual(MFA.boldTextInAnimation(3).type, MFA.boldTextInAnimation(3).type);
  assert.strictEqual(MFA.boldTextInAnimation(0).type, MFA.BOLD_TEXT_IN_ANIMATIONS[0].type);
}

/* ---------- keywordsFromScript: ghi chú gắn với DÒNG chứa nó + CÂU HOOK ---------- */
{
  const md = [
    'Bé nhà bạn hay **ốm vặt** không? /*CÂU HOOK (cắt trong vid)*/',
    'Đó là do sức đề kháng kém. /*Be om, be gay*/',
    'Hãy bổ sung **Wellmune** mỗi ngày. /*Wellmune*/ /*Be khoe, be tuoi cuoi*/',
  ].join('\n');
  const parsed = normalizeMarkdownScript(md, { sourceName: 'kich-ban.md' });
  const keywords = MFA.keywordsFromScript(parsed.metadata, parsed.clean_text);
  assert.strictEqual(keywords.length, 4);

  // Ghi chú DÒNG ĐẦU = câu hook: đánh dấu isHook, không dùng để so khớp
  assert.strictEqual(keywords[0].text, 'CÂU HOOK (cắt trong vid)');
  assert.strictEqual(keywords[0].isHook, true);
  assert.deepStrictEqual(keywords.slice(1).map((k) => k.isHook), [false, false, false]);

  assert.strictEqual(keywords[1].lineText, 'Đó là do sức đề kháng kém.');
  // 2 ghi chú cùng một dòng -> cùng một khoảng thời gian (cùng lineStart)
  assert.strictEqual(keywords[2].lineStart, keywords[3].lineStart);
  assert.ok(keywords[1].lineStart < keywords[2].lineStart, 'giữ đúng thứ tự kịch bản');

  // Ghi chú "CÂU HOOK…" nằm ở dòng khác vẫn được nhận diện là hook
  const md2 = 'Mo dau. /*Be om*/\nCau hai. /*HOOK phu*/';
  const p2 = normalizeMarkdownScript(md2);
  const kw2 = MFA.keywordsFromScript(p2.metadata, p2.clean_text);
  assert.deepStrictEqual(kw2.map((k) => k.isHook), [true, true]);

  // Nhánh ghi chú thật: dòng 2 khớp [Vid] Be om, be gay
  const noteHit = MFA.matchNoteAssets(keywords[1].text, LIBRARY, { random: FIRST });
  assert.ok(noteHit.cover && noteHit.cover.asset.name.startsWith('[Vid] Be om, be gay'));
}

/* ---------- coverScalePercent: [Vid] phủ kín khung, không lọt nền ---------- */
{
  // Nguồn 1920x1080 vào khung dọc 1080x1920 -> phải phóng theo chiều cao
  const scale = MFA.coverScalePercent(1920, 1080, 1080, 1920);
  assert.ok(scale >= (1920 / 1080) * 100, `scale ${scale} phải phủ kín chiều cao`);
  assert.ok(1920 * (scale / 100) >= 1080 - 0.5 && 1080 * (scale / 100) >= 1920 - 0.5, 'phủ kín cả 2 chiều');
  // Nguồn nhỏ hơn khung -> vẫn phóng lên cho kín
  assert.ok(MFA.coverScalePercent(640, 360, 1920, 1080) >= 300);
}

/* ---------- insetPlacement: [Icon]/[Illus] né mặt người ---------- */
const SAFE = { top: 108, bottom: 864, left: 115, right: 1728 };
{
  // Mặt ở NỬA TRÊN -> đối tượng xuống nửa dưới
  const low = MFA.insetPlacement({
    assetW: 300, assetH: 300, seqW: 1920, seqH: 1080, safe: SAFE,
    faceBand: { top: 150, bottom: 400 },
  });
  assert.strictEqual(low.scale, 100, 'đủ chỗ thì giữ nguyên cỡ gốc');
  assert.ok(low.rect.top > 400, 'phải nằm dưới mặt người');
  assert.ok(low.rect.bottom <= SAFE.bottom + 0.5, 'không lòi khỏi lưới an toàn');

  // Mặt ở NỬA DƯỚI -> đối tượng lên nửa trên
  const high = MFA.insetPlacement({
    assetW: 300, assetH: 300, seqW: 1920, seqH: 1080, safe: SAFE,
    faceBand: { top: 700, bottom: 1000 },
  });
  assert.ok(high.rect.bottom < 700, 'phải nằm trên mặt người');
  assert.ok(high.rect.top >= SAFE.top - 0.5);

  // Không có dữ liệu mặt -> mặc định nửa dưới (đối xứng với text Magic Fill neo cạnh trên)
  const noFace = MFA.insetPlacement({
    assetW: 300, assetH: 300, seqW: 1920, seqH: 1080, safe: SAFE, faceBand: null,
  });
  assert.ok(noFace.positionY > 0, 'mặc định nằm dưới tâm khung');

  // TUYỆT ĐỐI KHÔNG ĐỔI SCALE (người dùng chốt 2026-08-03): băng trống hẹp hơn ảnh thì
  // GIỮ NGUYÊN 100% và đẩy xa mặt nhất có thể, KHÔNG thu nhỏ như bản cũ.
  const tight = MFA.insetPlacement({
    assetW: 900, assetH: 900, seqW: 1920, seqH: 1080, safe: SAFE,
    faceBand: { top: 150, bottom: 600 },
  });
  assert.strictEqual(tight.scale, 100, 'không được thu nhỏ');
  assert.strictEqual(Math.round(tight.rect.bottom - tight.rect.top), 900, 'giữ nguyên chiều cao gốc');
  assert.ok(tight.rect.bottom <= 1080 + 0.5, 'vẫn nằm trong khung hình');
  // Mặt ở nửa trên -> ảnh bị dồn xuống hết mức (mép dưới sát đáy vùng cho phép)
  assert.ok(tight.rect.top > 150, 'đẩy xuống dưới hết mức, xa mặt nhất có thể');

  // Ảnh cao hơn cả khung hình -> căn giữa khung, vẫn giữ 100%
  const huge = MFA.insetPlacement({
    assetW: 1400, assetH: 1400, seqW: 1920, seqH: 1080, safe: SAFE,
    faceBand: { top: 150, bottom: 400 },
  });
  assert.strictEqual(huge.scale, 100);
  assert.strictEqual(huge.positionY, 0);

  // Có text box Magic Fill trùng thời gian -> đẩy đối tượng tránh đè (vẫn không đổi scale)
  const blocked = MFA.insetPlacement({
    assetW: 300, assetH: 300, seqW: 1920, seqH: 1080, safe: SAFE,
    faceBand: { top: 150, bottom: 400 },
    blocked: [{ top: 420, bottom: 560 }],
  });
  assert.strictEqual(blocked.scale, 100);
  assert.ok(blocked.rect.top >= 560, 'không đè lên text box đã đặt');

  // CA LỖI THẬT (2026-08-03): mặt ở NỬA DƯỚI + text box neo cạnh TRÊN thu hẹp băng.
  // Bản cũ suy "phía đặt" từ mép băng (bandTop bị text box đẩy xuống) nên tưởng phải đặt
  // xuống dưới -> ném ảnh đúng vào mặt. Phía đặt PHẢI suy từ chính vị trí mặt.
  const lowFaceBlocked = MFA.insetPlacement({
    assetW: 500, assetH: 500, seqW: 1920, seqH: 1080, safe: SAFE,
    faceBand: { top: 690, bottom: 910 },      // mặt nửa DƯỚI
    blocked: [{ top: 105, bottom: 205 }],     // text box neo cạnh TRÊN
  });
  assert.strictEqual(lowFaceBlocked.scale, 100);
  assert.ok(lowFaceBlocked.rect.bottom <= 690, `phải nằm TRÊN mặt, đang ở [${Math.round(lowFaceBlocked.rect.top)},${Math.round(lowFaceBlocked.rect.bottom)}]`);
  assert.ok(lowFaceBlocked.rect.top >= 0, 'không lòi khỏi khung');
}

console.log('[magic-fill-assets] OK — ghi chú (đa từ khoá + ưu tiên [Vid]), bold→mẫu Custom/ảnh/chữ, cover-fit, né mặt người.');
