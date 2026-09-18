/**
 * AUTO SOUND EFFECTS — TRA NHÓM & TÍNH VỊ TRÍ (LOGIC THUẦN)
 * =========================================================
 * Phần KHÔNG ĐỤNG DOM của tính năng "tự điền SFXs + nhạc nền theo hiệu ứng động / hiệu ứng
 * chuyển cảnh / Element". Tách UMD để test bằng Node (tests/scripts/auto_sfx_assets.js),
 * giống magic-fill-assets.js và auto-reframe-geometry.js.
 *
 * NGUYÊN TẮC: file này KHÔNG giữ bảng luật nào. Mọi hàm nhận `cfg` = phần `autoSfx` của
 * cài đặt ứng dụng (app-settings.js) làm tham số. Nhờ vậy bảng Cài đặt sửa nhóm/luật/ngưỡng
 * là ASE đổi theo ngay, không phải sửa code — và test chứng minh được điều đó bằng cách
 * bơm một cfg tuỳ biến.
 *
 * Quy ước gốc: auto_sfx.txt ở thư mục gốc dự án.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AutoSfxAssets = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    // Trùng khoảng kẹp của volumePercentToDb/volumeDbToPercent trong editing-runtime.js.
    const DB_MIN = -60;
    const DB_MAX = 20;

    function clamp(value, min, max) {
        const n = Number(value);
        if (!Number.isFinite(n)) return min;
        return Math.min(max, Math.max(min, n));
    }

    /** dB -> phần trăm âm lượng (mô hình lưu của app: 100 = 0 dB, tuyến tính). */
    function dbToPercent(db) {
        const value = clamp(db, DB_MIN, DB_MAX);
        if (value <= DB_MIN) return 0;
        return clamp(100 * Math.pow(10, value / 20), 0, 1000);
    }

    /* ---- So khớp đường dẫn thư viện ----
     * auto_sfx.txt (và do đó DEFAULTS) ghi đuôi ".mp3" thường, còn trên đĩa là ".MP3" HOA.
     * Mọi so khớp rel_path vì thế phải hạ hoa thường; đồng thời chuẩn "\" -> "/" cho Windows. */
    function relPathKey(value) {
        return String(value == null ? '' : value).trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    }

    function groupById(list, id) {
        return (Array.isArray(list) ? list : []).find((g) => g && g.id === id) || null;
    }

    // Nhóm hiệu ứng động chứa `effectType`; null nếu hiệu ứng không thuộc nhóm nào
    // (ví dụ 'fade', 'zoom_out' — quy ước cố ý không gán tiếng cho chúng).
    function animGroupFor(cfg, effectType) {
        const type = String(effectType || '');
        if (!type || type === 'none') return null;
        return (cfg && Array.isArray(cfg.animGroups) ? cfg.animGroups : [])
            .find((g) => Array.isArray(g.effects) && g.effects.includes(type)) || null;
    }

    function transitionGroupFor(cfg, transitionType) {
        const type = String(transitionType || '');
        if (!type) return null;
        return (cfg && Array.isArray(cfg.transGroups) ? cfg.transGroups : [])
            .find((g) => Array.isArray(g.transitions) && g.transitions.includes(type)) || null;
    }

    function ruleFor(cfg, kind, groupId) {
        return (cfg && Array.isArray(cfg.rules) ? cfg.rules : [])
            .find((r) => r && r.source && r.source.kind === kind && r.source.group === groupId) || null;
    }

    /**
     * Nhóm SFXs cho một hiệu ứng ĐỘNG (hiệu ứng VÀO). `durationSec` là độ dài thật của
     * hiệu ứng sau khi engine đã co cửa sổ cho block ngắn (TextAnimations.resolveWindows),
     * KHÔNG phải giá trị người dùng nhập — block 0.3s mà đặt hiệu ứng 1.2s thì tiếng phải
     * theo 0.3s mới khớp hình.
     * Ngưỡng dùng "<=" đúng chữ auto_sfx.txt ("=< 0.8s thì nhóm 1, > 0.8s thì nhóm 2").
     */
    function sfxGroupForAnimation(cfg, effectType, durationSec) {
        const group = animGroupFor(cfg, effectType);
        if (!group) return null;
        const rule = ruleFor(cfg, 'anim', group.id);
        if (!rule) return null;
        const th = rule.threshold;
        if (th && Number.isFinite(Number(th.maxDuration))) {
            return Number(durationSec) <= Number(th.maxDuration) ? rule.sfxGroup : th.elseSfxGroup;
        }
        return rule.sfxGroup;
    }

    /** Nhóm SFXs cho một hiệu ứng CHUYỂN CẢNH tại điểm nối 2 block. */
    function sfxGroupForTransition(cfg, transitionType) {
        const group = transitionGroupFor(cfg, transitionType);
        if (!group) return null;
        const rule = ruleFor(cfg, 'transition', group.id);
        return rule ? rule.sfxGroup : null;
    }

    /** Nhóm SFXs cho một Element theo TÊN FILE, ví dụ "[Icon] True.png". */
    function sfxGroupForElementName(cfg, assetName) {
        const key = String(assetName == null ? '' : assetName).trim().toLowerCase();
        if (!key) return null;
        const rule = (cfg && Array.isArray(cfg.elementRules) ? cfg.elementRules : [])
            .find((r) => r && String(r.assetName || '').trim().toLowerCase() === key);
        return rule ? rule.sfxGroup : null;
    }

    /**
     * Đối chiếu danh sách file của một nhóm với thư viện THẬT.
     * `libraryRelPaths` = mảng rel_path lấy từ GET /api/library/all.
     * Trả { files: [rel_path thật], missing: [rel_path trong cấu hình không tìm thấy] }.
     * Tách `missing` ra để bảng Cài đặt tô đỏ và ASE báo lại cho người dùng, thay vì im
     * lặng bỏ qua rồi để họ thắc mắc sao thiếu tiếng.
     */
    function resolveGroupFiles(cfg, groupId, libraryRelPaths) {
        const group = groupById(cfg && cfg.sfxGroups, groupId);
        const wanted = group && Array.isArray(group.files) ? group.files : [];
        return resolveRelPaths(wanted, libraryRelPaths);
    }

    function resolveRelPaths(wanted, libraryRelPaths) {
        const index = new Map();
        (Array.isArray(libraryRelPaths) ? libraryRelPaths : []).forEach((rel) => {
            const key = relPathKey(rel);
            if (key && !index.has(key)) index.set(key, rel);
        });
        const files = [];
        const missing = [];
        (Array.isArray(wanted) ? wanted : []).forEach((rel) => {
            const hit = index.get(relPathKey(rel));
            if (hit) files.push(hit);
            else if (String(rel || '').trim()) missing.push(rel);
        });
        return { files, missing };
    }

    /** Chọn ngẫu nhiên 1 phần tử; `rng` bơm được để test tất định. null nếu rỗng. */
    function pickFromGroup(files, rng) {
        const list = Array.isArray(files) ? files.filter(Boolean) : [];
        if (!list.length) return null;
        const r = typeof rng === 'function' ? rng() : Math.random();
        const idx = Math.min(list.length - 1, Math.max(0, Math.floor(r * list.length)));
        return list[idx];
    }

    function sfxGroupConfig(cfg, groupId) {
        const group = groupById(cfg && cfg.sfxGroups, groupId);
        return {
            id: groupId,
            name: group ? group.name : groupId,
            align: group && group.align === 'start' ? 'start' : 'peak',
            fit: group && group.fit === 'toEffect' ? 'toEffect' : 'full',
        };
    }

    /**
     * Vị trí + độ dài của một block SFX trên timeline. HAI mốc thời gian KHÁC NHAU, tuỳ
     * `align` mà dùng cái nào — lẫn hai cái này là tiếng lệch đúng bằng độ dài hiệu ứng:
     *   align 'peak'  — dùng `atTime` (mốc CẦN NGHE THẤY tiếng: điểm KẾT THÚC hiệu ứng vào,
     *                   điểm chuyển cảnh, lúc [Icon] hiện). ĐỈNH SÓNG của file phải rơi
     *                   đúng đó => start = atTime - lead - peakOffset. Tràn ra trước mốc 0
     *                   thì DỊCH CẢ BLOCK về 0 (không cắt đầu): giữ trọn tiếng, chấp nhận
     *                   đỉnh lệch muộn hơn.
     *                   `lead` = đẩy đỉnh sóng SỚM hơn mốc bấy nhiêu giây (mặc định 0.3s cho
     *                   hiệu ứng động và [Icon]; điểm chuyển cảnh truyền 0).
     *   align 'start' — dùng `blockStart` (đầu block có hiệu ứng). Tiếng chạy SUỐT hiệu ứng
     *                   chứ không phải một cú nhấn tại một mốc, nên phải bắt đầu CÙNG LÚC
     *                   hiệu ứng bắt đầu — ví dụ tiếng gõ phím của hiệu ứng Đánh máy.
     *   fit 'toEffect'— cắt độ dài theo đúng độ dài hiệu ứng.
     * `timelineLimit` là tổng độ dài lane main: mọi SFX không được vượt quá (auto_sfx.txt).
     */
    function placeSfx(opts) {
        const o = opts || {};
        const assetDuration = Math.max(0, Number(o.assetDuration) || 0);
        const limit = Math.max(0, Number(o.timelineLimit) || 0);
        const atTime = Math.max(0, Number(o.atTime) || 0);
        const align = o.align === 'start' ? 'start' : 'peak';
        const peakOffset = align === 'peak' ? Math.max(0, Number(o.peakOffset) || 0) : 0;
        // `lead` chỉ có nghĩa với kiểu canh đỉnh sóng: nhóm canh ĐẦU BLOCK phải trùng khít
        // đầu hiệu ứng (tiếng gõ phím vào sớm 0.3s là nghe lệch hẳn khỏi chữ).
        const lead = align === 'peak' ? Math.max(0, Number(o.lead) || 0) : 0;
        // Không truyền blockStart (mốc chuyển cảnh — không thuộc block nào) thì rơi về atTime.
        const blockStart = Math.max(0, Number(o.blockStart != null ? o.blockStart : atTime) || 0);

        const start = align === 'start' ? blockStart : Math.max(0, atTime - lead - peakOffset);
        let duration = assetDuration;
        if (o.fit === 'toEffect') {
            const effect = Math.max(0, Number(o.effectDuration) || 0);
            if (effect > 0) duration = Math.min(duration, effect);
        }
        if (limit > 0) duration = Math.min(duration, Math.max(0, limit - start));
        return { start, duration };
    }

    /**
     * Keyframe âm lượng cho block nhạc nền: giữ nguyên mức nền rồi giảm dần ở đoạn cuối.
     * Đúng 2 mốc là đủ vì nội suy giữa 2 keyframe đã là một đường giảm liên tục; mốc đầu
     * đặt tại (hết - fade) chứ không phải t=0 để đoạn trước đó giữ mức nền (giữ MÉP: trước
     * keyframe đầu = giá trị keyframe đầu).
     * `t` là giờ CỤC BỘ tính từ đầu block, `v` là PHẦN TRĂM âm lượng.
     */
    function musicFadeKeyframes(durationSec, levels) {
        const duration = Math.max(0, Number(durationSec) || 0);
        const lv = levels && typeof levels === 'object' ? levels : {};
        const fromDb = Number.isFinite(Number(lv.musicDb)) ? Number(lv.musicDb) : -13;
        const toDb = Number.isFinite(Number(lv.musicFadeToDb)) ? Number(lv.musicFadeToDb) : -25;
        const fade = Math.max(0, Number(lv.musicFadeSec) || 0);
        if (duration <= 0 || fade <= 0) return [];
        const startT = Math.max(0, duration - fade);
        // Block ngắn hơn cả đoạn fade -> giảm suốt block, vẫn đúng 2 mốc.
        if (startT <= 0) return [{ t: 0, v: dbToPercent(fromDb), e: 'ease-in-out' }, { t: duration, v: dbToPercent(toDb), e: 'ease-in-out' }];
        return [
            { t: startT, v: dbToPercent(fromDb), e: 'ease-in-out' },
            { t: duration, v: dbToPercent(toDb), e: 'ease-in-out' },
        ];
    }

    return {
        DB_MIN,
        DB_MAX,
        dbToPercent,
        relPathKey,
        animGroupFor,
        transitionGroupFor,
        sfxGroupForAnimation,
        sfxGroupForTransition,
        sfxGroupForElementName,
        sfxGroupConfig,
        resolveGroupFiles,
        resolveRelPaths,
        pickFromGroup,
        placeSfx,
        musicFadeKeyframes,
    };
});
