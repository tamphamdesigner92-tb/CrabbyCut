/* =====================================================================
 * KÉO HÌNH THOI KEYFRAME TRÊN BLOCK
 *
 * Tính năng: nắm hình thoi dưới đáy block rồi kéo ngang để đổi THỜI ĐIỂM của keyframe,
 * đúng nếp các phần mềm dựng phim chuyên nghiệp. Bấm (không kéo) vẫn tua playhead tới
 * keyframe đó như trước.
 *
 * BỐN CHỖ MÀ SAI THÌ HỎNG ÂM THẦM — không lỗi nào báo, hình vẫn vẽ ra đủ:
 *
 *   1) DỜI CẢ CỤM. Một hình thoi là một THỜI ĐIỂM, không phải một thông số: nó là hợp các
 *      mốc của mọi trục. Dời lẻ một trục là xé đôi một keyframe Vị trí — X sang mốc mới còn
 *      Y ở lại — và bất biến ghép cặp X/Y (pairPositionKeyframes) vỡ. Hậu quả chỉ lộ ra ở
 *      đường chuyển động, tức là lúc người dùng xem lại bản dựng.
 *   2) KHÔNG ĐI QUA HÀNG XÓM. Cho đi qua thì phải định nghĩa chuyện gì xảy ra khi hai mốc
 *      chồng nhau; gộp là NUỐT MẤT keyframe của người dùng ngay giữa cú kéo. Kẹp lại là
 *      lựa chọn duy nhất không mất dữ liệu.
 *   3) BẮT DÍNH ĐÚNG MỐC. Bắt dính vào playhead + hai mép block, và KHÔNG bắt dính vào
 *      keyframe khác (chúng là biên của cú kéo — dính vào đó là dừng sát rạt rồi gộp).
 *   4) MOUSEDOWN PHẢI TỚI ĐƯỢC HÌNH THOI. Handler mousedown của #segmentsTrack (index.html)
 *      chạy ở pha CAPTURE và stopPropagation ở nhánh lane chính. Quên nhường hình thoi ở đó
 *      là kéo keyframe TRÊN LANE CHÍNH chết lặng — lane overlay vẫn chạy ngon nên rất dễ
 *      tưởng là xong (đã xảy ra đúng như vậy trong lượt làm tính năng này).
 *
 * Node không có DOM nên test bóc thẳng các hàm thuần từ nguồn ra chạy (cùng lối
 * main_lane_fit_geometry.js / preview_overlay_offset.js đang dùng), phần còn lại kiểm ở
 * mức nguồn.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const runtimeJs = fs.readFileSync(path.join(projectRoot, 'static', 'js', 'editing-runtime.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `không tìm thấy hàm ${name}() trong nguồn`);
    const bodyStart = src.indexOf('{', src.indexOf(')', start));
    let depth = 0;
    for (let i = bodyStart; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`hàm ${name}() không đóng ngoặc`);
}

/* Dựng lại đúng môi trường mà ba hàm đó sống trong đó. `isSnappingEnabled` đi qua tham số
 * vì mã nguồn dò nó bằng `typeof` (biến toàn cục của index.html). */
function loadHelpers({ snapping = true, playheadSeq = 0, thresholdSec = 0.1 } = {}) {
    const factory = new Function(
        'window', 'TextAnimations', 'KF_EPS', 'clamp', 'isSnappingEnabled',
        'currentSequenceTime', 'editingMoveSnapThresholdSeconds',
        `${extractFunction(runtimeJs, 'kfRound')}
         ${extractFunction(runtimeJs, 'blockKeyframeTimes')}
         ${extractFunction(runtimeJs, 'moveKeyframesAt')}
         ${extractFunction(runtimeJs, 'snapKeyframeTime')}
         return { kfRound, blockKeyframeTimes, moveKeyframesAt, snapKeyframeTime };`
    );
    const TextAnimations = {
        KEYFRAME_FIELDS: ['position_x', 'position_y', 'scale', 'rotation', 'opacity'],
        VOLUME_KEYFRAME_FIELD: 'volume',
    };
    return factory(
        { TextAnimations }, TextAnimations, 0.02,
        (v, lo, hi) => Math.min(Math.max(v, lo), hi),
        snapping, () => playheadSeq, () => thresholdSec,
    );
}

const ok = (msg) => console.log(`  ok  ${msg}`);

// ---------------------------------------------------------------- 1) DỜI CẢ CỤM
{
    const { moveKeyframesAt } = loadHelpers();
    const owner = {
        keyframes: {
            position_x: [{ t: 1, v: -200, e: 'linear' }, { t: 3, v: 200, e: 'ease-in-out' }],
            position_y: [{ t: 1, v: 0, e: 'linear' }, { t: 3, v: 50, e: 'ease-in-out' }],
            volume: [{ t: 1, v: 80, e: 'linear' }],
            'adj.basic.exposure': [{ t: 1, v: 25, e: 'linear' }],
            opacity: [{ t: 3, v: 100, e: 'linear' }],   // không ở mốc đang kéo -> phải đứng yên
        },
    };
    const changed = moveKeyframesAt(owner, 1, 2.4);
    assert.strictEqual(changed, true, 'phải báo có thay đổi');
    assert.deepStrictEqual(owner.keyframes.position_x.map((k) => k.t), [2.4, 3],
        'trục X phải dời sang mốc mới');
    assert.deepStrictEqual(owner.keyframes.position_y.map((k) => k.t), [2.4, 3],
        'trục Y phải dời THEO — xé đôi keyframe Vị trí là phá bất biến ghép cặp X/Y');
    assert.deepStrictEqual(owner.keyframes.volume.map((k) => k.t), [2.4],
        'keyframe âm lượng ở cùng mốc cũng phải dời');
    assert.deepStrictEqual(owner.keyframes['adj.basic.exposure'].map((k) => k.t), [2.4],
        "keyframe MÀU ('adj.*') cũng phải dời: hình thoi đại diện cho THỜI ĐIỂM");
    assert.deepStrictEqual(owner.keyframes.opacity.map((k) => k.t), [3],
        'keyframe ở mốc khác không được động tới');
    assert.strictEqual(owner.keyframes.position_x[0].v, -200, 'giá trị phải giữ nguyên');
    assert.strictEqual(owner.keyframes.position_x[0].e, 'linear', 'easing phải giữ nguyên');
    ok('dời một hình thoi là dời CẢ CỤM keyframe tại mốc đó (transform + âm lượng + màu)');

    // Kéo ngược về mốc nhỏ hơn: danh sách vẫn phải xếp tăng dần, nếu không evalKeyframeField
    // (nội suy tuyến tính theo thứ tự) trả ra đường chuyển động lộn ngược.
    moveKeyframesAt(owner, 3, 0.5);
    assert.deepStrictEqual(owner.keyframes.position_x.map((k) => k.t), [0.5, 2.4],
        'danh sách phải được sắp lại sau khi dời');
    ok('dời sang mốc nhỏ hơn thì danh sách vẫn xếp tăng dần');

    // Dung sai KF_EPS: hai keyframe cùng một trục nằm sát nhau là dữ liệu hỏng sẵn (UI luôn
    // coi chúng là MỘT). Cú kéo phải thu về một, không được nhân chúng ra ở mốc đích.
    const messy = { keyframes: { scale: [{ t: 1, v: 100 }, { t: 1.005, v: 120 }, { t: 4, v: 150 }] } };
    moveKeyframesAt(messy, 1, 2);
    assert.deepStrictEqual(messy.keyframes.scale.map((k) => k.t), [2, 4],
        'cặp keyframe trùng dung sai phải thu về MỘT sau khi dời');
    ok('keyframe trùng dung sai không bị nhân bản ra mốc đích');

    // Không có gì ở mốc đó -> không đụng vào dữ liệu.
    const untouched = { keyframes: { scale: [{ t: 4, v: 150 }] } };
    assert.strictEqual(moveKeyframesAt(untouched, 1, 2), false, 'không có keyframe ở mốc -> false');
    assert.deepStrictEqual(untouched.keyframes.scale.map((k) => k.t), [4], 'dữ liệu phải y nguyên');
    ok('mốc không có keyframe nào thì không sửa gì');
}

// ------------------------------------------------- 2) HỢP CÁC MỐC (nguồn của hình thoi)
{
    const { blockKeyframeTimes } = loadHelpers();
    const times = blockKeyframeTimes({
        position_x: [{ t: 1 }, { t: 3 }],
        position_y: [{ t: 1.005 }, { t: 3 }],   // lệch 5ms — UI coi là CÙNG một keyframe
        volume: [{ t: 2 }],
        'adj.basic.exposure': [{ t: 5 }],       // chưa hiện hình thoi (xem ghi chú bên dưới)
    });
    assert.deepStrictEqual(times, [1, 2, 3],
        'mốc lệch dưới KF_EPS phải gom làm MỘT hình thoi — hai cái chồng nhau thì kéo cái nào'
        + ' cũng chỉ trúng một nửa dữ liệu');
    ok('hình thoi là HỢP các mốc, gom theo dung sai KF_EPS');
}

// ---------------------------------------------------------------- 3) KẸP + BẮT DÍNH
{
    // Kẹp trong khoảng hở giữa hai hàng xóm, KHÔNG đi qua được.
    const { snapKeyframeTime } = loadHelpers({ snapping: false });
    const drag = { lo: 1.03, hi: 2.97, duration: 5, blockStartSeq: 0 };
    assert.strictEqual(snapKeyframeTime(drag, 4.2), 2.97, 'kéo quá hàng xóm phải dừng ở biên phải');
    assert.strictEqual(snapKeyframeTime(drag, -3), 1.03, 'kéo quá hàng xóm phải dừng ở biên trái');
    assert.strictEqual(snapKeyframeTime(drag, 2), 2, 'trong khoảng thì giữ nguyên giá trị thô');
    ok('cú kéo bị kẹp giữa hai keyframe liền kề — không nuốt mất cái nào');

    // Bắt dính vào playhead (giờ CỤC BỘ = giờ sequence - mốc đầu block).
    const snapped = loadHelpers({ snapping: true, playheadSeq: 12.4, thresholdSec: 0.1 });
    const d2 = { lo: 0, hi: 5, duration: 5, blockStartSeq: 10 };   // playhead cục bộ = 2.4
    assert.strictEqual(snapped.snapKeyframeTime(d2, 2.35), 2.4, 'sát playhead thì phải dính vào playhead');
    assert.strictEqual(snapped.snapKeyframeTime(d2, 1.5), 1.5, 'xa playhead thì giữ giá trị thô');
    assert.strictEqual(snapped.snapKeyframeTime(d2, 0.05), 0, 'sát mép trái thì dính vào mốc 0');
    assert.strictEqual(snapped.snapKeyframeTime(d2, 4.96), 5, 'sát mép phải thì dính vào cuối block');
    ok('bắt dính vào playhead và hai mép block');

    // Playhead nằm NGOÀI khoảng kéo (ví dụ đang đứng đúng trên keyframe hàng xóm) thì không
    // được kéo cú kéo ra ngoài biên — dính vào đó là gộp mất keyframe.
    const d3 = { lo: 1.03, hi: 2.97, duration: 5, blockStartSeq: 10 };   // playhead cục bộ = 2.4
    const outside = loadHelpers({ snapping: true, playheadSeq: 13.0, thresholdSec: 0.5 });
    assert.strictEqual(outside.snapKeyframeTime(d3, 2.9), 2.9,
        'mốc bắt dính nằm ngoài [lo,hi] phải bị bỏ qua');
    ok('mốc bắt dính ngoài khoảng kéo bị bỏ qua');

    // Tắt bắt dính -> chỉ còn phép kẹp.
    const off = loadHelpers({ snapping: false, playheadSeq: 12.4 });
    assert.strictEqual(off.snapKeyframeTime(d2, 2.35), 2.35, 'tắt bắt dính thì không được tự dính');
    assert.strictEqual(off.snapKeyframeTime(d2, 3.22747312339515), 3.227,
        'mốc phải được làm tròn về MILI GIÂY ở CẢ nhánh tắt bắt dính — phép đổi pixel sang'
        + ' giây sinh rác dấu phẩy động và con số đó đi thẳng vào .crab');
    ok('tắt bắt dính thì giữ đúng giá trị thô');
}

// ------------------------------------------------ 4) HỢP ĐỒNG NGUỒN (chỗ dễ chết lặng)
{
    /* #segmentsTrack nghe mousedown ở pha CAPTURE rồi stopPropagation cho nhánh lane chính.
     * Không nhường hình thoi ở đó thì listener của chính hình thoi KHÔNG BAO GIỜ chạy. */
    const capture = indexHtml.slice(indexHtml.indexOf("document.getElementById('segmentsTrack')?.addEventListener('mousedown'"));
    // Biên là dòng GÁN `const mainEditingBlock`, không phải lần xuất hiện đầu tiên của chuỗi
    // '.editing-main-block' — chuỗi đó còn nằm trong chính khối chú thích của bản vá.
    const guard = capture.slice(0, capture.indexOf('const mainEditingBlock'));
    assert.ok(/closest\?\.\('\.editing-kf-marker'\)\)\s*return;/.test(guard),
        'handler CAPTURE của #segmentsTrack phải nhường .editing-kf-marker TRƯỚC nhánh lane chính'
        + ' — nếu không thì kéo keyframe trên lane chính chết lặng');
    ok('#segmentsTrack nhường hình thoi ở pha capture');

    /* Ngược lại: chính hình thoi phải chặn lan, nếu không mousedown rơi xuống block và cú kéo
     * keyframe biến thành cú kéo BLOCK. Và phải chặn TRƯỚC khi xét lane khoá — lane khoá vẫn
     * không được để cú bấm hoá thành kéo block. */
    const start = extractFunction(runtimeJs, 'startKeyframeDrag');
    const stopAt = start.indexOf('stopPropagation');
    const lockAt = start.indexOf('ctx.locked');
    assert.ok(stopAt > 0 && lockAt > stopAt,
        'startKeyframeDrag phải stopPropagation TRƯỚC khi xét ctx.locked');
    assert.ok(/kfMinGap\(\)/.test(start),
        'khoảng kẹp phải chừa kfMinGap() cho hàng xóm');
    assert.ok(!/const\s+KF_MIN_GAP\s*=\s*KF_EPS/.test(runtimeJs),
        'kfMinGap phải là HÀM: KF_EPS khai báo bằng const mãi phía dưới, tính sẵn ở mức module'
        + ' là chạm vùng chết (TDZ) và ném ReferenceError ngay lúc nạp');
    ok('hình thoi chặn lan trước mọi nhánh, và không có bẫy TDZ với KF_EPS');

    // Marker phải thực sự nối dây cú kéo, và cú kéo phải được nghe ở mức window.
    const append = extractFunction(runtimeJs, 'appendKeyframeMarkers');
    assert.ok(/addEventListener\('mousedown'[\s\S]*startKeyframeDrag\(/.test(append),
        'marker phải nối mousedown vào startKeyframeDrag');
    assert.ok(/addEventListener\('click'[\s\S]*setSequenceTime\(/.test(append),
        'bấm (không kéo) vẫn phải tua playhead tới keyframe');
    assert.ok(runtimeJs.includes("window.addEventListener('mousemove', handleKeyframeDrag")
        && runtimeJs.includes("window.addEventListener('mouseup', finishKeyframeDrag")
        && runtimeJs.includes("window.addEventListener('blur', finishKeyframeDrag"),
        'mousemove/mouseup phải nghe ở window (kéo ra khỏi block vẫn chạy) + lưới blur');
    ok('marker nối dây đủ: kéo, bấm-để-tua, và lưới an toàn khi mất focus');
}

console.log('keyframe_drag ok');
