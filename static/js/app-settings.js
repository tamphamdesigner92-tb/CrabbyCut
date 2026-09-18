/**
 * CÀI ĐẶT ỨNG DỤNG — SCHEMA + CHUẨN HOÁ + I/O
 * ===========================================
 * Lớp cấu hình DÙNG CHUNG cho frontend (bảng Cài đặt trong Menu) và backend
 * (`/api/settings` require thẳng file này để chuẩn hoá trước khi ghi đĩa) — cùng một
 * `normalize()` ở hai đầu thì không có đường nào ghi được cấu hình sai vào
 * `settings/app_settings.json`. Cùng khuôn UMD với audio-denoise.js / clip-speed.js.
 *
 * `normalize()` là CHỐT CHẶN AN TOÀN DUY NHẤT: mọi thứ đọc từ đĩa hay từ UI đều đi qua
 * nó. Nó vá thiếu bằng mặc định, kẹp số, loại trùng, và BỎ mọi id hiệu ứng/chuyển cảnh
 * không còn tồn tại trong engine (người dùng nâng cấp app mà engine đổi tên hiệu ứng thì
 * cấu hình cũ không làm hỏng ASE — chỉ mất đúng phần không hiểu được).
 *
 * Vì sao nhóm/luật nằm ở CẤU HÌNH chứ không phải hằng số trong code: quy ước ghép tiếng
 * (auto_sfx.txt) là thứ người dùng muốn tự đổi — thêm file SFXs mới, tách nhóm, đổi ngưỡng
 * thời lượng. Code chỉ giữ GIÁ TRỊ MẶC ĐỊNH (DEFAULTS) đúng bằng nội dung auto_sfx.txt.
 *
 * KHÔNG vào undo/redo và KHÔNG lưu trong .crab: đây là cài đặt ứng dụng, không phải trạng
 * thái dự án. Đổi cấu hình cũng KHÔNG hồi tố lên các block Auto Sound Effects đã điền.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AppSettings = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const SCHEMA_VERSION = 1;

    // Khoảng hợp lệ của các con số trong mục "Số liệu" của bảng Cài đặt.
    const LIMITS = {
        db: { min: -60, max: 20 },
        fadeSec: { min: 0.1, max: 10 },
        maxDuration: { min: 0.05, max: 10 },
        leadSec: { min: 0, max: 3 },
        // Auto save
        intervalMin: { min: 1, max: 60 },
        keepVersions: { min: 1, max: 50 },
        // Chung / Xem trước
        undoSteps: { min: 5, max: 100 },
        frameStep: { min: 1, max: 30 },
    };

    const PREVIEW_QUALITY = ['proxy', 'original'];
    const TRANSITION_QUALITY = ['auto', 'sharp'];

    const ALIGN_VALUES = ['peak', 'start'];
    const FIT_VALUES = ['full', 'toEffect'];

    /* ---- MẶC ĐỊNH: chép đúng auto_sfx.txt, đã đối chiếu id thật của engine ----
     * Hiệu ứng động  -> text-animations.js EFFECT_OPTIONS
     * Chuyển cảnh    -> transitions.js TRANSITION_OPTIONS
     * File           -> rel_path trong library/ (khớp KHÔNG phân biệt hoa thường vì
     *                   auto_sfx.txt ghi ".mp3" còn trên đĩa là ".MP3") */
    const DEFAULT_AUTO_SFX = {
        animGroups: [
            { id: 'a1', name: 'Nhóm 1 — Trượt / Xoay / Trôi', effects: ['slide_up', 'slide_down', 'slide_left', 'slide_right', 'drift', 'rotate', 'spin'] },
            { id: 'a2', name: 'Nhóm 2 — Pop / Thu phóng vào', effects: ['pop', 'scale'] },
            { id: 'a3', name: 'Nhóm 3 — Lật', effects: ['flip'] },
            { id: 'a4', name: 'Nhóm 4 — Đánh máy (chữ)', effects: ['typewriter'] },
        ],
        transGroups: [
            { id: 't1', name: 'Nhóm 1 — Trượt / Quét', transitions: ['slideup', 'slidedown', 'slideleft', 'slideright', 'wipeleft', 'wiperight'] },
            { id: 't2', name: 'Nhóm 2 — Vòng tròn / Toả / Xoắn', transitions: ['circleopen', 'circleclose', 'radial', 'swirl'] },
        ],
        // Thứ tự khoá ở đây khớp thứ tự normalizeAutoSfx() dựng ra, để file trên đĩa và
        // bản chuẩn hoá giống nhau tới từng ký tự (dễ so sánh khi gỡ lỗi).
        sfxGroups: [
            {
                id: 'g1', name: 'Nhóm 1 — Whoosh nhanh',
                files: ['SFXs/[SFXs] Short-Whoosh-4.mp3', 'SFXs/[SFXs] Swish-1.mp3', 'SFXs/[SFXs] Fast-Whoosh-10.mp3', 'SFXs/[SFXs] Fast-Whoosh-E14.mp3'],
                align: 'peak', fit: 'full',
            },
            {
                id: 'g2', name: 'Nhóm 2 — Whoosh dài',
                files: ['SFXs/[SFXs] Woosh-Wind-4.mp3', 'SFXs/[SFXs] Deep-woosh-1.mp3'],
                align: 'peak', fit: 'full',
            },
            {
                id: 'g3', name: 'Nhóm 3 — Pop',
                files: ['SFXs/[SFXs] Pop-lower-sound.mp3', 'SFXs/[SFXs] Pop-Sound-to-Open.mp3'],
                align: 'peak', fit: 'full',
            },
            {
                id: 'g4', name: 'Nhóm 4 — Trả lời đúng',
                files: ['SFXs/[SFXs] Correct-Answer-1.mp3', 'SFXs/[SFXs] Correct-answer-Piropyrone.mp3', 'SFXs/[SFXs] Ding-the-answer-is-Correct.mp3'],
                align: 'peak', fit: 'full',
            },
            {
                id: 'g5', name: 'Nhóm 5 — Trả lời sai',
                files: ['SFXs/[SFXs] Drip-drip-the-wrong-answer.mp3', 'SFXs/[SFXs] Wrong-answer.mp3'],
                align: 'peak', fit: 'full',
            },
            // Nhóm 6 là ĐẶC LỆ của auto_sfx.txt: tiếng gõ phím chạy SUỐT hiệu ứng đánh máy
            // chứ không phải một cú nhấn tại một mốc -> canh đầu block + cắt theo hiệu ứng.
            {
                id: 'g6', name: 'Nhóm 6 — Gõ phím',
                files: ['SFXs/[SFXs] Typing-1.mp3'],
                align: 'start', fit: 'toEffect',
            },
            {
                id: 'g7', name: 'Nhóm 7 — Lật thẻ',
                files: ['SFXs/[SFXs] Turn-Card.mp3'],
                align: 'peak', fit: 'full',
            },
        ],
        musicFiles: ['Music/[Mus] Coconut-Groove.mp3', 'Music/[Mus] Playful-Beauty-Lifestyle-House.mp3'],
        elementRules: [
            { assetName: '[Icon] True.png', sfxGroup: 'g4' },
            { assetName: '[Icon] Wrong.png', sfxGroup: 'g5' },
        ],
        rules: [
            // Nhóm hiệu ứng động 1: hiệu ứng NGẮN đi với whoosh nhanh, hiệu ứng DÀI đi với
            // whoosh dài — nên luật này có nhánh ngưỡng, các luật khác thì không.
            { source: { kind: 'anim', group: 'a1' }, sfxGroup: 'g1', threshold: { maxDuration: 0.8, elseSfxGroup: 'g2' } },
            { source: { kind: 'anim', group: 'a2' }, sfxGroup: 'g3', threshold: null },
            { source: { kind: 'anim', group: 'a3' }, sfxGroup: 'g7', threshold: null },
            { source: { kind: 'anim', group: 'a4' }, sfxGroup: 'g6', threshold: null },
            { source: { kind: 'transition', group: 't1' }, sfxGroup: 'g1', threshold: null },
            { source: { kind: 'transition', group: 't2' }, sfxGroup: 'g2', threshold: null },
        ],
        // animLeadSec: đẩy tiếng của HIỆU ỨNG ĐỘNG và [Icon] sớm hơn mốc một chút. Tai người
        // nghe thấy tiếng trước khi hình chốt lại thì thấy "ăn khớp" hơn là trùng khít; điểm
        // CHUYỂN CẢNH thì không áp (mốc ở đó là điểm cắt, đẩy sớm sẽ nghe rời khỏi hình).
        levels: { sfxDb: -6, musicDb: -13, musicFadeToDb: -25, musicFadeSec: 0.8, animLeadSec: 0.3 },
    };

    // Auto save GHI BẢN SAO, không đụng file .crab của người dùng — sửa hỏng vẫn quay lại
    // được. Xem mục "Auto Save" trong APP_INTERNALS.md.
    const DEFAULT_AUTO_SAVE = { enabled: true, intervalMin: 5, keepVersions: 10, warnOnExit: true };
    const DEFAULT_GENERAL = { undoSteps: 20, devMode: false, snapDefault: true };
    // transitionQuality 'auto' = 2 mức (CSS px khi phát, ×dpr khi dừng); 'sharp' = luôn ×dpr,
    // nét hơn khi phát nhưng hiệu ứng Xoắn sẽ giật (xem transitionRenderScale).
    const DEFAULT_PREVIEW = { defaultQuality: 'proxy', frameStep: 1, transitionQuality: 'auto' };

    const DEFAULTS = {
        version: SCHEMA_VERSION,
        autoSfx: DEFAULT_AUTO_SFX,
        // Chỉ chứa phần KHÁC mặc định (xem Shortcuts.keymapOverrides) -> mặc định đổi ở bản
        // sau thì người chưa gán tay nhận phím mới, không kẹt ở phím cũ.
        shortcuts: {},
        autoSave: DEFAULT_AUTO_SAVE,
        general: DEFAULT_GENERAL,
        preview: DEFAULT_PREVIEW,
        // Thư viện rỗng lúc đầu: hiệu ứng dựng sẵn nằm trong engine, đây chỉ chứa phần
        // người dùng tự lưu.
        textEffects: [],
    };

    function deepClone(value) { return JSON.parse(JSON.stringify(value)); }

    function clampNumber(value, min, max, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    function cleanText(value, fallback) {
        const s = String(value == null ? '' : value).trim();
        return s || fallback;
    }

    /* ---- Danh mục id hợp lệ của engine ----
     * Giải LƯỜI (lúc gọi, không phải lúc nạp module): ở trình duyệt thứ tự thẻ <script> có
     * thể đặt file này trước text-animations.js; ở Node thì phải require. Không giải được
     * (test chạy độc lập, engine chưa nạp) thì trả null = KHÔNG lọc, để cấu hình đi qua
     * nguyên vẹn thay vì bị xoá oan. */
    function tryRequire(rel) {
        if (typeof module !== 'object' || !module.exports || typeof require !== 'function') return null;
        try { return require(rel); } catch (_) { return null; }
    }

    function engineEffectIds() {
        const g = typeof globalThis !== 'undefined' ? globalThis : {};
        const TA = g.TextAnimations || tryRequire('./text-animations.js');
        const list = TA && TA.EFFECT_OPTIONS;
        if (!Array.isArray(list) || !list.length) return null;
        // 'none' không phải hiệu ứng thật, không được phép nằm trong nhóm.
        return new Set(list.map((o) => o.value).filter((v) => v && v !== 'none'));
    }

    function engineShortcuts() {
        const g = typeof globalThis !== 'undefined' ? globalThis : {};
        return g.Shortcuts || tryRequire('./shortcuts.js') || null;
    }

    function engineTransitionIds() {
        const g = typeof globalThis !== 'undefined' ? globalThis : {};
        const TR = g.Transitions || tryRequire('./transitions.js');
        const list = TR && TR.TRANSITION_OPTIONS;
        if (!Array.isArray(list) || !list.length) return null;
        return new Set(list.map((o) => o.id).filter(Boolean));
    }

    // Danh sách id: bỏ rỗng, bỏ trùng, bỏ id engine không biết (nếu tra được danh mục).
    function normalizeIdList(raw, allowed) {
        const seen = new Set();
        return (Array.isArray(raw) ? raw : []).reduce((out, value) => {
            const id = String(value == null ? '' : value).trim();
            if (!id || seen.has(id)) return out;
            if (allowed && !allowed.has(id)) return out;
            seen.add(id);
            out.push(id);
            return out;
        }, []);
    }

    // Đường dẫn thư viện: chuẩn về dấu "/" và bỏ "./" đầu; KHÔNG hạ hoa thường vì đây là
    // chuỗi hiển thị — việc khớp hoa/thường do auto-sfx-assets.js lo lúc tra file thật.
    function normalizeRelPathList(raw) {
        const seen = new Set();
        return (Array.isArray(raw) ? raw : []).reduce((out, value) => {
            const rel = String(value == null ? '' : value).trim().replace(/\\/g, '/').replace(/^\.\//, '');
            if (!rel) return out;
            const key = rel.toLowerCase();
            if (seen.has(key)) return out;
            seen.add(key);
            out.push(rel);
            return out;
        }, []);
    }

    // Nhóm phải có id DUY NHẤT và có ít nhất 1 thành viên — nhóm rỗng chỉ làm rối bảng luật.
    function normalizeGroups(raw, memberKey, allowedMembers, extra) {
        const seen = new Set();
        return (Array.isArray(raw) ? raw : []).reduce((out, group) => {
            if (!group || typeof group !== 'object') return out;
            const id = cleanText(group.id, '');
            if (!id || seen.has(id)) return out;
            const members = normalizeIdList(group[memberKey], allowedMembers);
            if (!members.length) return out;
            seen.add(id);
            const entry = { id, name: cleanText(group.name, id), [memberKey]: members };
            if (typeof extra === 'function') extra(entry, group);
            out.push(entry);
            return out;
        }, []);
    }

    function normalizeAutoSfx(raw) {
        const src = raw && typeof raw === 'object' ? raw : {};
        const effectIds = engineEffectIds();
        const transitionIds = engineTransitionIds();

        // Nhóm phải chốt TRƯỚC luật: luật tham chiếu id nhóm, nên nếu nhóm rơi về mặc định
        // mà luật lại được soi theo danh sách nhóm (rỗng) của người dùng thì luật rụng sạch.
        let animGroups = normalizeGroups(src.animGroups, 'effects', effectIds);
        if (!animGroups.length) animGroups = deepClone(DEFAULT_AUTO_SFX.animGroups);
        let transGroups = normalizeGroups(src.transGroups, 'transitions', transitionIds);
        if (!transGroups.length) transGroups = deepClone(DEFAULT_AUTO_SFX.transGroups);
        let sfxGroups = (Array.isArray(src.sfxGroups) ? src.sfxGroups : []).reduce((out, group) => {
            if (!group || typeof group !== 'object') return out;
            const id = cleanText(group.id, '');
            if (!id || out.some((g) => g.id === id)) return out;
            out.push({
                id,
                name: cleanText(group.name, id),
                // Nhóm SFXs được phép RỖNG (người dùng vừa tạo nhóm, chưa chọn file) —
                // khác nhóm hiệu ứng. Lúc chạy ASE thì nhóm rỗng bị bỏ qua và báo ra.
                files: normalizeRelPathList(group.files),
                align: ALIGN_VALUES.includes(group.align) ? group.align : 'peak',
                fit: FIT_VALUES.includes(group.fit) ? group.fit : 'full',
            });
            return out;
        }, []);
        if (!sfxGroups.length) sfxGroups = deepClone(DEFAULT_AUTO_SFX.sfxGroups);

        const animIds = new Set(animGroups.map((g) => g.id));
        const transIds = new Set(transGroups.map((g) => g.id));
        const sfxIds = new Set(sfxGroups.map((g) => g.id));

        // Phân biệt "chưa có khoá" (cấu hình cũ/rỗng -> lấy mặc định) với "mảng rỗng"
        // (người dùng CỐ Ý xoá hết -> tôn trọng, ASE sẽ không điền gì).
        const rulesSrc = Array.isArray(src.rules) ? src.rules : DEFAULT_AUTO_SFX.rules;
        const elementSrc = Array.isArray(src.elementRules) ? src.elementRules : DEFAULT_AUTO_SFX.elementRules;
        const musicSrc = Array.isArray(src.musicFiles) ? src.musicFiles : DEFAULT_AUTO_SFX.musicFiles;

        // Luật trỏ tới nhóm đã bị xoá thì tự rụng theo — nếu không, ASE sẽ tra ra nhóm ma.
        const ruleSeen = new Set();
        const rules = rulesSrc.reduce((out, rule) => {
            if (!rule || typeof rule !== 'object') return out;
            const source = rule.source && typeof rule.source === 'object' ? rule.source : {};
            const kind = source.kind === 'transition' ? 'transition' : (source.kind === 'anim' ? 'anim' : '');
            const group = cleanText(source.group, '');
            const sfxGroup = cleanText(rule.sfxGroup, '');
            if (!kind || !group || !sfxGroup) return out;
            if (!(kind === 'anim' ? animIds : transIds).has(group)) return out;
            if (!sfxIds.has(sfxGroup)) return out;
            const key = `${kind}|${group}`;
            if (ruleSeen.has(key)) return out;   // một nhóm nguồn chỉ có một luật
            ruleSeen.add(key);
            let threshold = null;
            const th = rule.threshold;
            if (th && typeof th === 'object' && sfxIds.has(cleanText(th.elseSfxGroup, ''))) {
                threshold = {
                    maxDuration: clampNumber(th.maxDuration, LIMITS.maxDuration.min, LIMITS.maxDuration.max, 0.8),
                    elseSfxGroup: cleanText(th.elseSfxGroup, ''),
                };
            }
            out.push({ source: { kind, group }, sfxGroup, threshold });
            return out;
        }, []);

        const elementSeen = new Set();
        const elementRules = elementSrc.reduce((out, rule) => {
            if (!rule || typeof rule !== 'object') return out;
            const assetName = cleanText(rule.assetName, '');
            const sfxGroup = cleanText(rule.sfxGroup, '');
            if (!assetName || !sfxIds.has(sfxGroup)) return out;
            const key = assetName.toLowerCase();
            if (elementSeen.has(key)) return out;
            elementSeen.add(key);
            out.push({ assetName, sfxGroup });
            return out;
        }, []);

        const levelsSrc = src.levels && typeof src.levels === 'object' ? src.levels : {};
        const D = DEFAULT_AUTO_SFX.levels;
        const levels = {
            sfxDb: clampNumber(levelsSrc.sfxDb, LIMITS.db.min, LIMITS.db.max, D.sfxDb),
            musicDb: clampNumber(levelsSrc.musicDb, LIMITS.db.min, LIMITS.db.max, D.musicDb),
            musicFadeToDb: clampNumber(levelsSrc.musicFadeToDb, LIMITS.db.min, LIMITS.db.max, D.musicFadeToDb),
            musicFadeSec: clampNumber(levelsSrc.musicFadeSec, LIMITS.fadeSec.min, LIMITS.fadeSec.max, D.musicFadeSec),
            animLeadSec: clampNumber(levelsSrc.animLeadSec, LIMITS.leadSec.min, LIMITS.leadSec.max, D.animLeadSec),
        };

        return { animGroups, transGroups, sfxGroups, musicFiles: normalizeRelPathList(musicSrc), elementRules, rules, levels };
    }

    /* Keymap: chỉ giữ phần khác mặc định, bỏ id lệnh không còn tồn tại và tổ hợp rác.
     * Giao việc hiểu tổ hợp cho shortcuts.js — một bản cài đặt duy nhất cho cả hai đầu.
     * Không tra được module (test chạy độc lập) thì giữ nguyên chuỗi thay vì xoá oan. */
    function normalizeShortcuts(raw) {
        const src = raw && typeof raw === 'object' ? raw : {};
        const S = engineShortcuts();
        if (!S) return { ...src };
        return S.keymapOverrides(S.mergeKeymap(src));
    }

    function normalizeAutoSave(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const D = DEFAULT_AUTO_SAVE;
        return {
            enabled: typeof s.enabled === 'boolean' ? s.enabled : D.enabled,
            intervalMin: Math.round(clampNumber(s.intervalMin, LIMITS.intervalMin.min, LIMITS.intervalMin.max, D.intervalMin)),
            keepVersions: Math.round(clampNumber(s.keepVersions, LIMITS.keepVersions.min, LIMITS.keepVersions.max, D.keepVersions)),
            warnOnExit: typeof s.warnOnExit === 'boolean' ? s.warnOnExit : D.warnOnExit,
        };
    }

    /* ---- THƯ VIỆN "HIỆU ỨNG CHỮ" NGƯỜI DÙNG TỰ LƯU ----
     * Nút "Lưu hiệu ứng" ở panel Thuộc tính ghi vào đây. Nằm ở CÀI ĐẶT ỨNG DỤNG chứ không
     * phải trong .crab vì đây là THƯ VIỆN dùng lại giữa mọi dự án — cùng lý do với phím tắt.
     *
     * Một hiệu ứng = `patch` (phần cố định: font, màu, công tắc viền/nền/bóng) + `ratios`
     * (các số đo quy theo TỈ LỆ cỡ chữ). Chia đôi như vậy để hiệu ứng tự co giãn: bề dày
     * viền lưu ở px thì áp lên chữ cỡ 300 chỉ còn sợi chỉ — đúng cấu trúc mà bộ hiệu ứng
     * dựng sẵn của engine đang dùng, nên hai loại đi chung một đường áp dụng.
     *
     * KHÔNG nhận cỡ chữ / canh lề / bề rộng hộp: hiệu ứng phải áp được lên mọi khối chữ
     * mà không xô layout của nó. */
    const TEXT_EFFECT_MAX = 200;
    const TEXT_EFFECT_NAME_MAX = 60;
    // Giá trị hợp lệ theo KIỂU: chuỗi (màu/font/hình nền), số, hoặc bật/tắt. `null` được
    // giữ nguyên cho hai khoá lề (null = "Auto", khác hẳn 0 = "không lề").
    const TEXT_EFFECT_PATCH_KEYS = [
        'font_family', 'font_weight', 'color', 'letter_spacing',
        'stroke_enabled', 'stroke_color', 'stroke2_color',
        'bg_enabled', 'bg_color', 'bg_opacity', 'bg_shape', 'bg_pad_x', 'bg_pad_y',
        'shadow_enabled', 'shadow_color', 'shadow_opacity',
    ];
    const TEXT_EFFECT_RATIO_KEYS = ['stroke_width', 'stroke2_width', 'bg_radius', 'shadow_dx', 'shadow_dy', 'shadow_blur'];

    function normalizeTextEffectPatch(raw) {
        const src = raw && typeof raw === 'object' ? raw : {};
        const out = {};
        TEXT_EFFECT_PATCH_KEYS.forEach((key) => {
            if (!(key in src)) return;
            const v = src[key];
            if (v === null) { out[key] = null; return; }
            if (typeof v === 'boolean') { out[key] = v; return; }
            if (typeof v === 'number') { out[key] = Number.isFinite(v) ? v : 0; return; }
            if (typeof v === 'string') { out[key] = v.slice(0, 120); return; }
        });
        return out;
    }

    function normalizeTextEffects(raw) {
        if (!Array.isArray(raw)) return [];
        const seen = new Set();
        const out = [];
        raw.forEach((item) => {
            if (!item || typeof item !== 'object') return;
            const id = cleanText(item.id, '');
            if (!id || seen.has(id)) return;
            const patch = normalizeTextEffectPatch(item.patch);
            // Hiệu ứng không mô tả được gì thì bỏ — giữ lại chỉ tạo ra thẻ rỗng bấm không ra gì.
            if (!Object.keys(patch).length) return;
            const ratios = {};
            const rawRatios = item.ratios && typeof item.ratios === 'object' ? item.ratios : {};
            TEXT_EFFECT_RATIO_KEYS.forEach((key) => {
                if (!(key in rawRatios)) return;
                ratios[key] = clampNumber(rawRatios[key], -5, 5, 0);
            });
            seen.add(id);
            out.push({
                id: id.slice(0, 64),
                name: cleanText(item.name, 'Hiệu ứng của tôi').slice(0, TEXT_EFFECT_NAME_MAX),
                patch,
                ratios,
            });
        });
        return out.slice(0, TEXT_EFFECT_MAX);
    }

    function normalizeGeneral(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const D = DEFAULT_GENERAL;
        return {
            undoSteps: Math.round(clampNumber(s.undoSteps, LIMITS.undoSteps.min, LIMITS.undoSteps.max, D.undoSteps)),
            devMode: typeof s.devMode === 'boolean' ? s.devMode : D.devMode,
            snapDefault: typeof s.snapDefault === 'boolean' ? s.snapDefault : D.snapDefault,
        };
    }

    function normalizePreview(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const D = DEFAULT_PREVIEW;
        return {
            defaultQuality: PREVIEW_QUALITY.includes(s.defaultQuality) ? s.defaultQuality : D.defaultQuality,
            frameStep: Math.round(clampNumber(s.frameStep, LIMITS.frameStep.min, LIMITS.frameStep.max, D.frameStep)),
            transitionQuality: TRANSITION_QUALITY.includes(s.transitionQuality) ? s.transitionQuality : D.transitionQuality,
        };
    }

    /**
     * Chuẩn hoá TOÀN BỘ object cài đặt. Đầu vào rỗng/hỏng/thiếu khoá đều ra một object
     * hợp lệ. Idempotent: normalize(normalize(x)) sâu-bằng normalize(x).
     */
    function normalize(raw) {
        const src = raw && typeof raw === 'object' ? raw : {};
        return {
            version: SCHEMA_VERSION,
            autoSfx: normalizeAutoSfx(src.autoSfx),
            shortcuts: normalizeShortcuts(src.shortcuts),
            autoSave: normalizeAutoSave(src.autoSave),
            general: normalizeGeneral(src.general),
            preview: normalizePreview(src.preview),
            textEffects: normalizeTextEffects(src.textEffects),
        };
    }

    /** Keymap đầy đủ (mặc định + phần người dùng đổi) từ một object cài đặt. */
    function keymapOf(settings) {
        const S = engineShortcuts();
        if (!S) return {};
        return S.mergeKeymap((settings || {}).shortcuts);
    }

    function defaults() { return normalize(deepClone(DEFAULTS)); }

    /* ================= Phần chỉ chạy ở FRONTEND ================= */

    const API_BASE = '/api';
    let cached = null;
    let loadPromise = null;
    const listeners = new Set();

    function emit() {
        listeners.forEach((fn) => { try { fn(cached); } catch (_) {} });
    }

    function onChange(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    // Cấu hình lỗi mạng/backend KHÔNG được chặn tính năng: rơi về mặc định và chạy tiếp.
    function load(force) {
        if (!force && loadPromise) return loadPromise;
        loadPromise = fetch(`${API_BASE}/settings`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => { cached = normalize(data); emit(); return cached; })
            .catch(() => { cached = defaults(); emit(); return cached; });
        return loadPromise;
    }

    function ready() { return cached ? Promise.resolve(cached) : load(); }

    function get() { return cached || (cached = defaults()); }

    function save(next) {
        const payload = normalize(next);
        return fetch(`${API_BASE}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Không lưu được cài đặt'))))
            .then((data) => { cached = normalize(data); emit(); return cached; });
    }

    function reset() {
        return fetch(`${API_BASE}/settings/reset`, { method: 'POST' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Không khôi phục được cài đặt'))))
            .then((data) => { cached = normalize(data); emit(); return cached; });
    }

    return {
        SCHEMA_VERSION,
        LIMITS,
        TEXT_EFFECT_MAX,
        TEXT_EFFECT_NAME_MAX,
        TEXT_EFFECT_PATCH_KEYS,
        TEXT_EFFECT_RATIO_KEYS,
        ALIGN_VALUES,
        FIT_VALUES,
        PREVIEW_QUALITY,
        TRANSITION_QUALITY,
        DEFAULTS,
        defaults,
        normalize,
        keymapOf,
        load,
        ready,
        get,
        save,
        reset,
        onChange,
    };
});
