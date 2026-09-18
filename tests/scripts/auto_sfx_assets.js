/**
 * Smoke test cho static/js/auto-sfx-assets.js — luật ghép SFXs của Auto Sound Effects,
 * cộng phần đối chiếu KEYFRAME ÂM LƯỢNG (preview ↔ biểu thức FFmpeg khi xuất).
 * Chạy: npm run test:auto-sfx
 */
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const A = require(path.join(ROOT, 'static', 'js', 'auto-sfx-assets.js'));
const AppSettings = require(path.join(ROOT, 'static', 'js', 'app-settings.js'));
const TA = require(path.join(ROOT, 'static', 'js', 'text-animations.js'));

const CFG = AppSettings.defaults().autoSfx;
const FIRST = () => 0;   // random giả lập: luôn lấy ứng viên đầu (test tất định)

/* ---------- ánh xạ hiệu ứng động -> nhóm SFXs (auto_sfx.txt) ---------- */
{
  // Nhóm 1: ngắn -> whoosh nhanh (g1), dài -> whoosh dài (g2)
  ['slide_up', 'slide_down', 'slide_left', 'slide_right', 'drift', 'rotate', 'spin'].forEach((id) => {
    assert.strictEqual(A.sfxGroupForAnimation(CFG, id, 0.5), 'g1', `${id} ngắn -> nhóm 1`);
    assert.strictEqual(A.sfxGroupForAnimation(CFG, id, 1.2), 'g2', `${id} dài -> nhóm 2`);
  });
  // "=< 0.8s thì nhóm 1, > 0.8s thì nhóm 2" — biên phải nằm ĐÚNG phía nhóm 1.
  assert.strictEqual(A.sfxGroupForAnimation(CFG, 'slide_up', 0.8), 'g1', 'đúng 0.8s vẫn là nhóm 1');
  assert.strictEqual(A.sfxGroupForAnimation(CFG, 'slide_up', 0.81), 'g2', 'quá 0.8s là nhóm 2');

  assert.strictEqual(A.sfxGroupForAnimation(CFG, 'pop', 0.4), 'g3');
  assert.strictEqual(A.sfxGroupForAnimation(CFG, 'scale', 1.9), 'g3', 'nhóm 2 KHÔNG có ngưỡng độ dài');
  assert.strictEqual(A.sfxGroupForAnimation(CFG, 'flip', 0.4), 'g7');
  assert.strictEqual(A.sfxGroupForAnimation(CFG, 'typewriter', 1.4), 'g6');

  // Hiệu ứng cố ý KHÔNG gán tiếng.
  ['fade', 'zoom_out', 'none', '', 'khong_ton_tai'].forEach((id) => {
    assert.strictEqual(A.sfxGroupForAnimation(CFG, id, 0.5), null, `${id} phải không ra nhóm nào`);
  });
}

/* ---------- ánh xạ chuyển cảnh -> nhóm SFXs ---------- */
{
  ['slideup', 'slidedown', 'slideleft', 'slideright', 'wipeleft', 'wiperight'].forEach((id) => {
    assert.strictEqual(A.sfxGroupForTransition(CFG, id), 'g1', `${id} -> nhóm 1`);
  });
  ['circleopen', 'circleclose', 'radial', 'swirl'].forEach((id) => {
    assert.strictEqual(A.sfxGroupForTransition(CFG, id), 'g2', `${id} -> nhóm 2`);
  });
  ['fade', 'fadeblack', 'fadewhite', 'dissolve', 'pixelize', 'zoomin', ''].forEach((id) => {
    assert.strictEqual(A.sfxGroupForTransition(CFG, id), null, `${id} phải không ra nhóm nào`);
  });
}

/* ---------- Element: [Icon] True/Wrong ---------- */
{
  assert.strictEqual(A.sfxGroupForElementName(CFG, '[Icon] True.png'), 'g4');
  assert.strictEqual(A.sfxGroupForElementName(CFG, '[Icon] Wrong.png'), 'g5');
  assert.strictEqual(A.sfxGroupForElementName(CFG, '[icon] true.PNG'), 'g4', 'khớp không phân biệt hoa thường');
  assert.strictEqual(A.sfxGroupForElementName(CFG, '[Icon] Wellmune.png'), null);
  assert.strictEqual(A.sfxGroupForElementName(CFG, ''), null);
}

/* ---------- ENGINE ĐỌC CẤU HÌNH, KHÔNG DÙNG BẢNG CỨNG ----------
 * Đây là bất biến quan trọng nhất: bảng Cài đặt sửa được thì kết quả PHẢI đổi theo. */
{
  const custom = AppSettings.normalize({
    autoSfx: {
      animGroups: [{ id: 'moi', name: 'Nhóm tự tạo', effects: ['flip', 'pop'] }],
      transGroups: [{ id: 'tmoi', name: 'Chuyển cảnh tự tạo', transitions: ['pixelize'] }],
      sfxGroups: [
        { id: 'sA', name: 'A', files: ['SFXs/[SFXs] Turn-Card.mp3'], align: 'peak', fit: 'full' },
        { id: 'sB', name: 'B', files: ['SFXs/[SFXs] Typing-1.mp3'], align: 'start', fit: 'toEffect' },
      ],
      rules: [
        { source: { kind: 'anim', group: 'moi' }, sfxGroup: 'sA', threshold: { maxDuration: 1.5, elseSfxGroup: 'sB' } },
        { source: { kind: 'transition', group: 'tmoi' }, sfxGroup: 'sB' },
      ],
      elementRules: [{ assetName: '[Icon] Wellmune.png', sfxGroup: 'sB' }],
    },
  }).autoSfx;

  assert.strictEqual(A.sfxGroupForAnimation(custom, 'flip', 1.0), 'sA', 'ngưỡng mới 1.5s: 1.0s vẫn nhóm trên');
  assert.strictEqual(A.sfxGroupForAnimation(custom, 'flip', 1.6), 'sB', 'ngưỡng mới 1.5s: 1.6s sang nhóm dưới');
  assert.strictEqual(A.sfxGroupForAnimation(custom, 'slide_up', 0.5), null, 'hiệu ứng bị bỏ khỏi nhóm -> hết tiếng');
  assert.strictEqual(A.sfxGroupForTransition(custom, 'pixelize'), 'sB', 'chuyển cảnh mới thêm vào nhóm -> có tiếng');
  assert.strictEqual(A.sfxGroupForTransition(custom, 'wipeleft'), null);
  assert.strictEqual(A.sfxGroupForElementName(custom, '[Icon] Wellmune.png'), 'sB');
  assert.strictEqual(A.sfxGroupForElementName(custom, '[Icon] True.png'), null, 'dòng Element bị bỏ -> hết tiếng');
  assert.deepStrictEqual(A.sfxGroupConfig(custom, 'sB'), { id: 'sB', name: 'B', align: 'start', fit: 'toEffect' });
}

/* ---------- khớp tên file KHÔNG phân biệt hoa thường (.mp3 <-> .MP3) ---------- */
{
  const disk = ['SFXs/[SFXs] Swish-1.MP3', 'SFXs/[SFXs] Turn-Card.MP3', 'Music/[Mus] Coconut-Groove.MP3'];
  const r = A.resolveRelPaths(['SFXs/[SFXs] Turn-Card.mp3', 'SFXs/[SFXs] Khong-Co.mp3'], disk);
  assert.deepStrictEqual(r.files, ['SFXs/[SFXs] Turn-Card.MP3'], 'phải trả đúng tên THẬT trên đĩa');
  assert.deepStrictEqual(r.missing, ['SFXs/[SFXs] Khong-Co.mp3'], 'file thiếu phải được báo ra, không im lặng bỏ qua');

  const g7 = A.resolveGroupFiles(CFG, 'g7', disk);
  assert.deepStrictEqual(g7.files, ['SFXs/[SFXs] Turn-Card.MP3']);
  assert.strictEqual(A.pickFromGroup(g7.files, FIRST), 'SFXs/[SFXs] Turn-Card.MP3');
  assert.strictEqual(A.pickFromGroup([], FIRST), null, 'nhóm rỗng -> null, caller tự bỏ qua mốc');
  // rng trả 0.999… vẫn phải nằm trong mảng (không tràn chỉ số).
  assert.strictEqual(A.pickFromGroup(['a', 'b'], () => 0.999999), 'b');
}

/* ---------- đặt block: đỉnh sóng rơi đúng mốc ---------- */
{
  // Bình thường: start = mốc − khoảng cách tới đỉnh sóng.
  const normal = A.placeSfx({ atTime: 5, peakOffset: 0.3, assetDuration: 2, timelineLimit: 60, align: 'peak', fit: 'full' });
  assert.strictEqual(normal.start, 4.7);
  assert.strictEqual(normal.duration, 2);

  // `lead`: đẩy đỉnh sóng SỚM hơn mốc (hiệu ứng động + [Icon]). Cộng dồn với peakOffset.
  const lead = A.placeSfx({ atTime: 5, lead: 0.3, peakOffset: 0.3, assetDuration: 2, timelineLimit: 60, align: 'peak', fit: 'full' });
  assert.ok(Math.abs(lead.start - 4.4) < 1e-9, 'lead 0.3s phải đẩy block sớm thêm 0.3s');
  // Nhóm canh ĐẦU BLOCK bỏ qua lead: tiếng gõ phím phải trùng khít đầu hiệu ứng.
  const leadIgnored = A.placeSfx({ atTime: 5, blockStart: 3, lead: 0.3, assetDuration: 2, effectDuration: 1, timelineLimit: 60, align: 'start', fit: 'toEffect' });
  assert.strictEqual(leadIgnored.start, 3, 'align start phải bỏ qua lead');

  // Tràn ra trước mốc 0 -> DỊCH CẢ BLOCK về 0, KHÔNG cắt (lựa chọn đã chốt: giữ trọn tiếng).
  const overflow = A.placeSfx({ atTime: 0.2, peakOffset: 0.5, assetDuration: 2, timelineLimit: 60, align: 'peak', fit: 'full' });
  assert.strictEqual(overflow.start, 0);
  assert.strictEqual(overflow.duration, 2, 'không được trim đầu');

  // Không được dài quá tổng lane main.
  const clamped = A.placeSfx({ atTime: 9.5, peakOffset: 0, assetDuration: 5, timelineLimit: 10, align: 'peak', fit: 'full' });
  assert.strictEqual(clamped.duration, 0.5);

  // align 'start' + fit 'toEffect' (tiếng gõ phím của hiệu ứng Đánh máy): tiếng phải bắt đầu
  // CÙNG LÚC hiệu ứng bắt đầu, tức tại `blockStart` — KHÔNG phải `atTime` (là lúc hiệu ứng
  // KẾT THÚC). Lẫn hai trường này thì tiếng vào muộn đúng bằng độ dài hiệu ứng.
  const typing = A.placeSfx({
    atTime: 4.2, blockStart: 3, peakOffset: 9,
    assetDuration: 8, effectDuration: 1.2, timelineLimit: 60, align: 'start', fit: 'toEffect',
  });
  assert.strictEqual(typing.start, 3, 'align start phải bám blockStart, không bám atTime');
  assert.strictEqual(typing.duration, 1.2, 'cắt theo đúng độ dài hiệu ứng đánh máy');

  // Cùng bộ mốc đó nhưng canh theo đỉnh sóng thì phải bám atTime — chứng minh hai kiểu canh
  // đọc HAI trường khác nhau chứ không phải cùng một số.
  const peaky = A.placeSfx({
    atTime: 4.2, blockStart: 3, peakOffset: 0.2,
    assetDuration: 1, timelineLimit: 60, align: 'peak', fit: 'full',
  });
  assert.ok(Math.abs(peaky.start - 4) < 1e-9, 'align peak phải bám atTime − peakOffset');

  // Không truyền blockStart (mốc chuyển cảnh — không thuộc block nào) -> rơi về atTime.
  const noBlock = A.placeSfx({ atTime: 5, assetDuration: 2, effectDuration: 0.5, timelineLimit: 60, align: 'start', fit: 'full' });
  assert.strictEqual(noBlock.start, 5);

  // Hiệu ứng dài hơn file thì lấy độ dài FILE (không kéo dãn tiếng).
  const shortFile = A.placeSfx({ atTime: 0, blockStart: 0, assetDuration: 0.9, effectDuration: 5, timelineLimit: 60, align: 'start', fit: 'toEffect' });
  assert.strictEqual(shortFile.duration, 0.9);
}

/* ---------- dB -> percent + keyframe fade của nhạc nền ---------- */
{
  const pct = (db) => 100 * Math.pow(10, db / 20);
  assert.ok(Math.abs(A.dbToPercent(0) - 100) < 1e-9);
  assert.ok(Math.abs(A.dbToPercent(-6) - pct(-6)) < 1e-9);
  assert.strictEqual(A.dbToPercent(-60), 0, 'sàn -60 dB = im lặng');

  const kf = A.musicFadeKeyframes(30, CFG.levels);
  assert.strictEqual(kf.length, 2, 'đúng 2 mốc là đủ cho một đường giảm');
  assert.ok(Math.abs(kf[0].t - 29.2) < 1e-9, 'mốc đầu = hết − thời gian giảm');
  assert.strictEqual(kf[1].t, 30);
  assert.ok(Math.abs(kf[0].v - pct(CFG.levels.musicDb)) < 1e-9);
  assert.ok(Math.abs(kf[1].v - pct(CFG.levels.musicFadeToDb)) < 1e-9);

  // Block ngắn hơn cả đoạn fade -> giảm suốt block, vẫn 2 mốc và không có t âm.
  const shortKf = A.musicFadeKeyframes(0.5, CFG.levels);
  assert.strictEqual(shortKf.length, 2);
  assert.strictEqual(shortKf[0].t, 0);
  assert.strictEqual(shortKf[1].t, 0.5);

  assert.deepStrictEqual(A.musicFadeKeyframes(0, CFG.levels), []);
  assert.deepStrictEqual(A.musicFadeKeyframes(10, { ...CFG.levels, musicFadeSec: 0 }), []);
}

/* ---------- KEYFRAME ÂM LƯỢNG: preview ↔ biểu thức FFmpeg ----------
 * Cùng lối đối chiếu mà tests/scripts/video_animation_expr.js dùng cho hoạt ảnh: hai đường
 * (JS lúc phát, biểu thức lúc xuất) phải cho cùng một giá trị, nếu không thì nghe ở preview
 * một kiểu mà bản xuất một kiểu. */
{
  const FF = {
    IF: (c, a, b) => (c ? a : b),
    lt: (a, b) => (a < b ? 1 : 0),
    clip: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
    pow: Math.pow,
    exp: Math.exp,
    cos: Math.cos,
    sin: Math.sin,
  };
  const ffEval = (expr, t) => {
    const names = Object.keys(FF);
    // eslint-disable-next-line no-new-func
    return new Function('LOCALT', ...names, `return (${String(expr).replace(/\bif\(/g, 'IF(')});`)(t, ...names.map((n) => FF[n]));
  };

  const keyframes = { volume: A.musicFadeKeyframes(12, CFG.levels) };
  assert.ok(TA.hasVolumeKeyframes(keyframes), 'phải nhận ra có keyframe âm lượng');
  // Bất biến kiến trúc: 'volume' KHÔNG được nằm trong KEYFRAME_FIELDS, nếu không block
  // audio chỉ có keyframe âm lượng sẽ bị kéo qua đường render/bake TRANSFORM.
  assert.ok(!TA.KEYFRAME_FIELDS.includes('volume'), "'volume' phải nằm ngoài KEYFRAME_FIELDS");
  assert.strictEqual(TA.hasKeyframes(keyframes), false, 'keyframe âm lượng không được kích hoạt đường transform');

  const expr = TA.volumeKeyframeFfmpegExpr(keyframes);
  assert.ok(expr && expr.includes('LOCALT'), 'biểu thức phải theo token LOCALT');
  let maxErr = 0;
  for (let i = 0; i <= 240; i += 1) {
    const t = (i / 240) * 13;                       // quét cả phần SAU khi hết block (giữ mép)
    maxErr = Math.max(maxErr, Math.abs(TA.volumeAt(keyframes, t) / 100 - ffEval(expr, t)));
  }
  // Sai số chỉ đến từ làm tròn 4 chữ số của bộ sinh biểu thức (kfNum), như mọi field khác.
  assert.ok(maxErr < 1e-3, `preview và bản xuất lệch quá nhiều: ${maxErr}`);

  assert.strictEqual(TA.volumeAt({}, 1), null, 'không có keyframe -> null để caller dùng giá trị tĩnh');
  assert.strictEqual(TA.volumeKeyframeFfmpegExpr({}), null);
}

console.log('[auto-sfx] OK — luật nhóm theo auto_sfx.txt, engine đọc cấu hình, đặt block theo đỉnh sóng, keyframe âm lượng preview≙xuất.');
