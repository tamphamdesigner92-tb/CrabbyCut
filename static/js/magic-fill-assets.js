/**
 * MAGIC FILL — ASSET THEO TỪ KHOÁ KỊCH BẢN
 * =========================================
 * Phần LOGIC THUẦN (không đụng DOM) của bước "tìm ảnh/video trong library/ theo từ khoá
 * trong kịch bản chuẩn .md rồi đặt vào timeline". Tách riêng thành module UMD để test
 * được bằng Node (tests/scripts/magic_fill_assets.js), giống auto-reframe-geometry.js.
 *
 * QUY ƯỚC ĐẶT TÊN FILE TRONG library/ (người dùng chốt 2026-08-02):
 *     [Tiền tố] nội dung - số
 *   - Tiền tố: Vid | Icon | Illus | SFXs | Mus  (quyết định CÁCH ĐẶT, không theo thư mục)
 *   - Nội dung: nhiều TỪ KHOÁ ngăn nhau bằng dấu "," (mỗi cụm là một từ khoá, có thể nhiều chữ)
 *   - Hậu tố "- số": tuỳ chọn, chỉ để phân biệt các file trùng tiền tố + trùng nội dung
 *   Ví dụ: "[Icon] Lactoferrin", "[Vid] Be khoe, be tuoi cuoi - 1"
 *
 * Bốn việc chính:
 *   1) keywordsFromScript()  — từ khoá = GHI CHÚ /*...*\/ của kịch bản (metadata.notes[]),
 *      tách tiếp bằng "," hoặc "/"; mỗi từ khoá gắn với DÒNG chứa nó trong clean_text (thời
 *      gian hiện/mất = thời gian dòng đó được nói). Ghi chú ở DÒNG ĐẦU = CÂU HOOK: đánh dấu
 *      `isHook`, KHÔNG dùng để so khớp (chỉ ghi nhớ cho tính năng sau).
 *   2) matchNoteAssets()     — so khớp TỪ KHOÁ TRONG TÊN FILE với ghi chú; đạt khi tỉ lệ từ
 *      khoá của file xuất hiện trong ghi chú > 50%. Mỗi ghi chú lấy tối đa 1 [Vid] + 1
 *      [Icon]/[Illus]; nhiều file cùng đạt điểm cao nhất -> chọn NGẪU NHIÊN.
 *   3) planBoldGroups()     — nhánh CỤM IN ĐẬM: quyết định mỗi cụm in đậm dựng ra khối
 *      gì (mẫu Custom kèm hình / ảnh trần / chữ thường). Xem khối chú thích của nó.
 *   4) coverScalePercent() / insetPlacement() — hình học đặt đối tượng vào khung hình:
 *      [Vid] phủ kín khung; [Icon]/[Illus] giữ cỡ gốc, nằm nửa khung ĐỐI DIỆN mặt người.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.MagicFillAssets = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    // Tiền tố tên file quyết định CÁCH ĐẶT, không phụ thuộc thư mục chứa nó.
    const KIND_COVER = 'cover';  // [Vid] — phủ kín khung hình dự án
    const KIND_INSET = 'inset';  // [Icon] / [Illus] — giữ cỡ gốc, né mặt người
    const KIND_AUDIO = 'audio';  // [SFXs] / [Mus] — không phải đối tượng hình, không đặt
    const TAG_KINDS = { vid: KIND_COVER, icon: KIND_INSET, illus: KIND_INSET, sfxs: KIND_AUDIO, mus: KIND_AUDIO };

    // "trên 50%" theo đúng chữ người dùng chốt: phải LỚN HƠN, nên 1/2 từ khoá là CHƯA đạt.
    const NOTE_MATCH_MIN_RATIO = 0.5;

    const INSET_GAP_RATIO = 0.02;     // khoảng hở tối thiểu với mặt người / box đã đặt

    function normalizeWord(value) {
        return String(value || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/đ/g, 'd')
            .replace(/[^a-z0-9]/g, '');
    }

    function tokenize(value) {
        return String(value || '')
            .split(/[\s,.;:!?()[\]{}"'\/\\_+–—-]+/)
            .map(normalizeWord)
            .filter(Boolean);
    }

    function clamp(value, min, max) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return min;
        return Math.max(min, Math.min(max, parsed));
    }

    /**
     * Phân tích tên file theo quy ước "[Tiền tố] nội dung - số".
     * "[Vid] Be khoe, be tuoi cuoi - 1.mp4"
     *   -> { tag:'vid', kind:'cover', base:'Be khoe, be tuoi cuoi',
     *        keywords:[{text:'Be khoe',tokens:['be','khoe']}, {text:'be tuoi cuoi',tokens:[...]}] }
     * Hậu tố CHỈ được cắt khi có dấu gạch ("- 1"), nếu không "[Icon] Omega 3" sẽ mất số 3.
     */
    function describeAssetName(name, assetType) {
        const raw = String(name || '');
        const tagMatch = raw.match(/^\s*\[([^\]]+)\]/);
        const tag = tagMatch ? normalizeWord(tagMatch[1]) : '';
        let base = tagMatch ? raw.slice(tagMatch[0].length) : raw;
        base = base.replace(/\.[a-z0-9]{2,5}$/i, '');            // đuôi file
        base = base.replace(/[\s_]*[-–—][\s_]*\d+\s*$/, '');     // hậu tố "- 1"
        base = base.trim();
        const isVideoType = assetType === 'media_video' || assetType === 'video';
        // Tiền tố lạ / không có -> suy theo loại file (video phủ khung, ảnh là inset)
        const kind = TAG_KINDS[tag] || (isVideoType ? KIND_COVER : KIND_INSET);
        const keywords = base
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .map((text) => ({ text, tokens: tokenize(text) }))
            .filter((k) => k.tokens.length);
        return { tag, kind, base, keywords, tokens: tokenize(base) };
    }

    /**
     * LUẬT KHỚP DUY NHẤT (dùng chung cho ghi chú và cụm in đậm).
     * Độ khớp của MỘT từ khoá K với đoạn text T = (số chữ của K có trong T) / (số chữ của K).
     * MẪU SỐ LÀ ĐỘ DÀI CỦA CHÍNH TỪ KHOÁ — đây là điểm dễ sai nhất:
     *   - "Be om" trong "bé ốm/ ho/ khóc"                     = 2/2 = 100% -> khớp
     *   - "Giam phat trien chieu cao" trong "…phát triển chiều cao…" = 4/5 =  80% -> khớp
     *   - "Giam phat trien chieu cao" trong "giảm số ngày ốm"  = 1/5 =  20% -> KHÔNG khớp
     * Nếu lấy mẫu số là số TỪ KHOÁ của file (bản cũ) thì "[Vid] Be om, be gay" chỉ được
     * 1/2 = 50% với ghi chú "bé ốm/ho/khóc" và bị loại oan.
     */
    function keywordCoverage(keywordTokens, textTokens) {
        if (!keywordTokens.length || !textTokens.length) return 0;
        const pool = textTokens.slice();
        let hit = 0;
        for (const token of keywordTokens) {
            const at = pool.indexOf(token);
            if (at >= 0) { pool.splice(at, 1); hit += 1; }
        }
        return hit / keywordTokens.length;
    }

    // Từ khoá khớp MẠNH NHẤT của một file với đoạn text: CHỈ CẦN MỘT từ khoá đạt ngưỡng là
    // file được coi là khớp (các từ khoá được so LẦN LƯỢT và ĐỘC LẬP với nhau).
    function bestKeywordMatch(info, textTokens) {
        let best = { ratio: 0, keyword: '' };
        for (const key of (info && info.keywords) || []) {
            const ratio = keywordCoverage(key.tokens, textTokens);
            if (ratio > best.ratio) best = { ratio, keyword: key.text };
        }
        return best;
    }

    // Bản tiện dụng cho test/gỡ lỗi: độ khớp giữa MỘT TÊN FILE và MỘT đoạn text.
    function noteMatchRatio(assetName, text, assetType) {
        return bestKeywordMatch(describeAssetName(assetName, assetType), tokenize(text)).ratio;
    }

    // Ứng viên khớp trong toàn library, tách sẵn theo cách đặt (cover / inset).
    function collectMatches(text, assets, minRatio, tagFilter) {
        const textTokens = tokenize(text);
        const covers = [];
        const insets = [];
        if (!textTokens.length) return { covers, insets };
        for (const asset of (Array.isArray(assets) ? assets : [])) {
            if (!asset || (asset.type !== 'media_image' && asset.type !== 'media_video')) continue;
            const info = describeAssetName(asset.name, asset.type);
            if (info.kind !== KIND_COVER && info.kind !== KIND_INSET) continue; // [SFXs]/[Mus]: bỏ
            if (tagFilter && !tagFilter(info)) continue;
            const best = bestKeywordMatch(info, textTokens);
            if (!(best.ratio > minRatio)) continue;
            const cand = { asset, info, kind: info.kind, ratio: best.ratio, keyword: best.keyword };
            (info.kind === KIND_COVER ? covers : insets).push(cand);
        }
        return { covers, insets };
    }

    function pickRandom(list, random) {
        if (!list.length) return null;
        if (list.length === 1) return list[0];
        const roll = typeof random === 'function' ? Number(random()) : Math.random();
        const index = Math.min(list.length - 1, Math.max(0, Math.floor((Number.isFinite(roll) ? roll : 0) * list.length)));
        return list[index];
    }

    // Trong nhóm ứng viên, chỉ giữ những file có tỉ lệ khớp CAO NHẤT rồi bốc ngẫu nhiên —
    // để "- 1"/"- 2" (cùng nội dung, khớp bằng điểm) được luân phiên, nhưng file khớp 100%
    // không bao giờ thua file khớp 60%.
    function pickBestRandom(candidates, random) {
        if (!candidates.length) return null;
        const top = Math.max(...candidates.map((c) => c.ratio));
        return pickRandom(candidates.filter((c) => c.ratio >= top - 1e-6), random);
    }

    /**
     * So khớp MỘT ghi chú với toàn bộ library: lấy từ khoá trong TÊN file đi dò ghi chú.
     * Mỗi ghi chú giữ tối đa 1 [Vid] (phủ khung) + 1 [Icon]/[Illus] (né mặt) vì nhiều đối
     * tượng cùng loại, cùng thời điểm sẽ che nhau.
     * @param {string} noteText — nội dung ghi chú (nhiều từ khoá ngăn bằng "," hoặc "/")
     * @param {Array<{name:string, rel_path:string, type:string}>} assets
     * @param {{minRatio?:number, random?:function}} [options]
     * @returns {{cover:object|null, inset:object|null, matches:Array}}
     */
    function matchNoteAssets(noteText, assets, options = {}) {
        const minRatio = Number.isFinite(Number(options.minRatio)) ? Number(options.minRatio) : NOTE_MATCH_MIN_RATIO;
        const { covers, insets } = collectMatches(noteText, assets, minRatio, null);
        return {
            cover: pickBestRandom(covers, options.random),
            inset: pickBestRandom(insets, options.random),
            matches: covers.concat(insets),
        };
    }

    // Một GHI CHÚ chứa nhiều từ khoá ngăn nhau bằng dấu "," HOẶC "/".
    function splitNoteKeywords(noteText) {
        return String(noteText || '')
            .split(/[,/]/)
            .map((part) => part.trim())
            .filter(Boolean);
    }

    /* =====================================================================
     * CỤM IN ĐẬM -> KHỐI GÌ TRÊN KHUNG HÌNH  (người dùng chốt 2026-09-15/16)
     * =====================================================================
     * BƯỚC 0 — GỘP CỤM LIỀN KỀ (`groupBoldRanges`). ĐÂY LÀ BƯỚC QUAN TRỌNG NHẤT và là
     * thứ bản đầu thiếu. Người viết kịch bản gõ
     *     … như **HMO**, **lợi khuẩn** hay **sữa non**, **DHA**, **đạm A2**…
     * tức NĂM cụm bold rời, KHÔNG phải một cụm có dấu phân chia. Bản đầu xử lý từng cụm
     * một nên "lợi khuẩn" (khớp [Illus]) ra mẫu Custom còn bốn cụm kia (chỉ khớp [Icon])
     * ra ảnh trần — đúng lỗi người dùng báo trên dự án thật 2026-09-16.
     * Luật gộp: hai cụm bold LIỀN KỀ, CÙNG DÒNG, mà phần chữ xen giữa chúng CHỈ gồm
     * khoảng trắng và dấu "," -> cùng MỘT NHÓM.
     *   · xen giữa chỉ có khoảng trắng -> nối thành MỘT phần con (cụm liền mạch);
     *   · xen giữa có dấu ","          -> mở phần con MỚI (nhóm liệt kê).
     * Từ nối "và"/"hoặc"/"hay" KHÔNG-in-đậm xen giữa hai cụm bold thì KHÔNG cho gộp (người
     * dùng chốt 2026-09-16); còn nằm BÊN TRONG một cụm bold thì chúng chỉ là chữ bình
     * thường của cụm đó, không chia gì cả — chỉ dấu "," mới chia (`splitBoldPhrase`).
     * "…**đủ điều kiện** **để** **tăng trưởng và phát triển bình thường**…" nhờ vậy thành
     * MỘT nhóm thay vì ba khối chữ đứng cạnh nhau.
     *
     * BƯỚC 1 — MỖI NHÓM DỰNG RA KHỐI GÌ. Luật khớp vẫn là luật DUY NHẤT của cả file (một
     * từ khoá trong TÊN FILE phải phủ > 50% chữ của nó trong đoạn text). Thứ tự ƯU TIÊN:
     *
     *   (0) CÂU có ĐÚNG HAI nhóm (cách nhau bằng chữ thường) -> gộp làm MỘT mẫu
     *       "Zoom Title": nhóm đầu vào ô Tiêu đề, nhóm sau vào ô Dòng phụ. Luật này thắng
     *       mọi luật dưới, kể cả khi một nhóm đã ≥ 6 từ (người dùng chốt). CHỈ khi:
     *         · KHÔNG nhóm nào bị dấu "," chia thành cụm nhỏ (câu liệt kê phải lên mẫu
     *           Custom từng mục theo (2), nhồi vào hai ô chữ là mất mục), VÀ
     *         · chữ KHÔNG-in-đậm xen giữa hai nhóm không phải chỉ là "và"/"hoặc"/"hay" (hai
     *           vế nối bằng từ nối là hai ý ngang hàng, không phải cặp tiêu đề + dòng phụ).
     *       NGOẠI LỆ: nhóm logo thương hiệu không bao giờ bị gộp — xem (1).
     *   (1) Nhóm đúng bằng "Little Étoile" -> ảnh [Icon] Logo LE (mode 'logo'), không chữ.
     *   (2) Nhóm LIỆT KÊ có ít nhất MỘT phần con khớp -> MỌI phần con thành mẫu "Custom";
     *       phần không khớp mượn một hình bất kỳ (luân phiên, xem boldFallbackAssets).
     *       VÌ SAO cả nhóm: một câu liệt kê mà nửa số mục có hình, nửa còn lại là chữ trơn
     *       thì nhìn như lỗi render — người dùng chốt phải đồng bộ.
     *   (3) Nhóm ≥ BOLD_LONG_PHRASE_WORDS (6) từ -> mẫu "Vlog Tag" cho CẢ nhóm. Thắng cả
     *       việc nhóm có khớp [Illus] (người dùng chốt): hộp chữ Custom với 6+ từ rất rộng,
     *       hình đè mép trông mất cân. Nhóm liệt kê KHÔNG phần nào khớp cũng rơi vào đây —
     *       lúc đó nó không còn là danh sách, chỉ là một câu dài.
     *   (4) Nhóm liền mạch < 6 từ: khớp [Illus] -> mẫu "Custom" kiểu Illus, hình là chính
     *       nó; chỉ khớp [Icon] -> ẢNH TRẦN không kèm chữ (mode 'image').
     *   (5) Còn lại -> chữ thường (mode 'text', hiệu ứng "Hồng kẹo" + động vào luân phiên).
     * ===================================================================== */

    /* TỪ NỐI. KHÔNG phải dấu phân chia: BÊN TRONG một cụm in đậm, "và"/"hoặc"/"hay" chỉ là
       chữ bình thường (người dùng chốt 2026-09-16) — chỉ dấu "," mới chia cụm. Tập này chỉ
       còn dùng để CHẶN luật gộp: từ nối KHÔNG-in-đậm nằm giữa hai cụm bold thì hai cụm đó
       là hai nhóm rời, và cũng không được gộp thành mẫu "Zoom Title".
       So bằng normalizeWord nên "và"/"VÀ"/"va" đều tính là một. */
    const CONJUNCTION_WORDS = new Set(['va', 'hoac', 'hay']);
    // Cụm in đậm được coi là TÊN THƯƠNG HIỆU -> dùng riêng ảnh logo.
    const LOGO_BOLD_KEY = 'littleetoile';
    // Tên (đã bỏ tiền tố + hậu tố) của chính ảnh logo trong library/Elements.
    const LOGO_ASSET_KEY = 'logole';
    /* Hình KHÔNG được đem ra làm "hình bất kỳ" cho phần con không khớp: logo là của riêng
       thương hiệu, còn True/Wrong mang nghĩa đúng/sai — dán một dấu ✗ cạnh một lời khẳng
       định tích cực là nói ngược lại nội dung, tệ hơn hẳn việc không có hình. */
    const BOLD_FALLBACK_DENY = new Set([LOGO_ASSET_KEY, 'true', 'wrong']);

    /* Hiệu ứng ĐỘNG VÀO cho cụm in đậm dựng bằng chữ thường. Dùng theo VÒNG (index của
       cụm % độ dài) nên hai cụm liền nhau không bao giờ trùng hiệu ứng — đúng yêu cầu
       "luân phiên để không lặp lại giữa 2 cụm liền nhau", mà vẫn tái lập được (chạy lại
       Magic Fill trên cùng kịch bản ra cùng kết quả, khác hẳn bốc ngẫu nhiên). */
    const BOLD_TEXT_IN_ANIMATIONS = [
        { type: 'pop', easing: 'spring' },
        { type: 'slide_up', easing: 'ease-out' },
        { type: 'scale', easing: 'back' },
        { type: 'flip', easing: 'back' },
        { type: 'rotate', easing: 'back' },
        { type: 'drift', easing: 'ease-out' },
        { type: 'slide_left', easing: 'ease-out' },
        { type: 'zoom_out', easing: 'ease-in-out' },
    ];
    function boldTextInAnimation(index) {
        const n = BOLD_TEXT_IN_ANIMATIONS.length;
        const i = Number.isFinite(Number(index)) ? Math.floor(Number(index)) : 0;
        return BOLD_TEXT_IN_ANIMATIONS[((i % n) + n) % n];
    }

    /**
     * Tách một cụm in đậm — CHỈ bằng dấu "," (người dùng chốt 2026-09-16). Từ nối
     * "và"/"hoặc"/"hay" NẰM TRONG một cụm bold chỉ là chữ bình thường của cụm đó, không
     * chia gì cả: "**canxi và vitamin D**" là MỘT cụm, không phải hai.
     * Chỉ ra ĐÚNG MỘT phần thì trả lại NGUYÊN VĂN cụm gốc chứ không phải phần đã bị lược.
     * @returns {{parts:string[], split:boolean}}
     */
    function splitBoldPhrase(text) {
        const raw = String(text || '').trim();
        const clean = raw.split(',').map((p) => p.trim()).filter(Boolean);
        if (clean.length > 1) return { parts: clean, split: true };
        return { parts: raw ? [raw] : [], split: false };
    }

    /**
     * Đối tượng [Icon]/[Illus] khớp NHẤT với một đoạn text. Bằng điểm thì ưu tiên tên
     * file NGẮN hơn (tên ngắn = từ khoá sát nghĩa hơn, không phải trúng nhờ một từ phụ).
     * @param {string} text
     * @param {Array} assets
     * @param {{tags?:string[], minRatio?:number}} [options] — tags mặc định ['icon','illus']
     * @returns {{asset:object, info:object, ratio:number, keyword:string}|null}
     */
    function matchBoldAsset(text, assets, options = {}) {
        const tags = Array.isArray(options.tags) ? options.tags : ['icon', 'illus'];
        const minRatio = Number.isFinite(Number(options.minRatio)) ? Number(options.minRatio) : NOTE_MATCH_MIN_RATIO;
        const { insets } = collectMatches(text, assets, minRatio, (info) => tags.indexOf(info.tag) >= 0);
        insets.sort((a, b) => (b.ratio - a.ratio) || (String(a.asset.name).length - String(b.asset.name).length));
        return insets[0] || null;
    }

    // Kho "hình bất kỳ" cho phần con không khớp — sắp theo tên để lần chạy nào cũng ra
    // cùng thứ tự (xem lý do tái lập ở BOLD_TEXT_IN_ANIMATIONS).
    function boldFallbackAssets(assets) {
        return (Array.isArray(assets) ? assets : [])
            .filter((a) => a && a.type === 'media_image')
            .map((asset) => ({ asset, info: describeAssetName(asset.name, asset.type) }))
            .filter((x) => (x.info.tag === 'icon' || x.info.tag === 'illus')
                && !BOLD_FALLBACK_DENY.has(normalizeWord(x.info.base)))
            .sort((a, b) => String(a.asset.name).localeCompare(String(b.asset.name)));
    }

    function findLogoAsset(assets) {
        return (Array.isArray(assets) ? assets : [])
            .filter((a) => a && a.type === 'media_image')
            .map((asset) => ({ asset, info: describeAssetName(asset.name, asset.type) }))
            .find((x) => x.info.tag === 'icon' && normalizeWord(x.info.base) === LOGO_ASSET_KEY) || null;
    }

    // Cụm bold dài bao nhiêu TỪ thì chuyển sang mẫu "Vlog Tag" thay vì chữ/hộp Custom.
    const BOLD_LONG_PHRASE_WORDS = 6;

    function wordCount(text) {
        return String(text || '').trim().split(/\s+/).filter(Boolean).length;
    }

    // Chữ của nhóm có bị dấu "," chia thành NHIỀU cụm nhỏ không (câu liệt kê)?
    function hasCommaParts(text) {
        return String(text || '').split(',').map((p) => p.trim()).filter(Boolean).length > 1;
    }

    /* Chữ (KHÔNG in đậm) xen giữa hai nhóm CHỈ gồm từ nối "và"/"hoặc"/"hay" — có thể kèm
       ","/khoảng trắng? Dùng cho luật Zoom Title: gap rỗng hoặc null -> false. Từ nối được
       BÔI ĐẬM không rơi vào đây: nó là một cụm bold, đã nối liền thành cùng MỘT nhóm. */
    function isConjunctionGap(gap) {
        const raw = String(gap == null ? '' : gap).trim();
        if (!raw) return false;
        const tokens = raw.split(/[\s,]+/).filter(Boolean);
        if (!tokens.length) return false;
        return tokens.every((token) => CONJUNCTION_WORDS.has(normalizeWord(token)));
    }

    /**
     * Phần chữ XEN GIỮA hai cụm bold liền kề cho phép gộp chúng lại không?
     * @returns {'space'|'separator'|null} — null = có chữ thật, KHÔNG được gộp
     */
    function boldJoinerKind(between) {
        const raw = String(between == null ? '' : between);
        if (!raw.trim()) return 'space';             // chỉ khoảng trắng (hoặc dính liền)
        /* Chỉ khoảng trắng và dấu "," mới cho gộp (người dùng chốt 2026-09-16). Một chữ
           thật xen giữa — kể cả "và"/"hoặc"/"hay" — là hai cụm RỜI nhau. */
        if (/[^\s,]/.test(raw)) return null;
        return raw.indexOf(',') >= 0 ? 'separator' : 'space';
    }

    /* Vị trí của một cụm bold trong KỊCH BẢN CHUẨN. Ưu tiên offset clean_start/clean_end do
       parser ghi; kịch bản bị sửa tay làm lệch offset thì trả null -> cụm đó không gộp với
       ai (thà lỡ một phép gộp còn hơn gộp nhầm hai cụm cách nhau cả câu). */
    function boldCleanRange(bold, text) {
        const target = String((bold && bold.text) || '').trim();
        if (!target) return null;
        const s = Number(bold && bold.clean_start);
        const e = Number(bold && bold.clean_end);
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
        if (text.slice(s, e).trim() !== target) return null;
        return { start: s, end: e };
    }

    function lineIndexAt(text, offset) {
        return String(text).slice(0, Math.max(0, offset)).split('\n').length - 1;
    }

    /**
     * GỘP các cụm bold liền kề thành NHÓM (xem bước 0 ở khối chú thích trên).
     * @param {Array<{text:string, clean_start?:number, clean_end?:number, line?:number}>} boldRanges
     *   theo ĐÚNG thứ tự kịch bản (metadata.bold_ranges)
     * @param {string} cleanText — kịch bản chuẩn (bản đã bỏ ** và ghi chú)
     * @returns {Array<{indices:number[], parts:string[], text:string, enumerated:boolean, lineIndex:number}>}
     *   indices — chỉ số của các cụm bold thành viên TRONG `boldRanges`
     */
    function groupBoldRanges(boldRanges, cleanText) {
        const text = String(cleanText || '');
        const groups = [];
        (Array.isArray(boldRanges) ? boldRanges : []).forEach((bold, index) => {
            const value = String((bold && bold.text) || '').trim();
            if (!value) return;
            const range = boldCleanRange(bold, text);
            const lineIndex = range ? lineIndexAt(text, range.start) : (Number(bold && bold.line) || -1 - index);
            const prev = groups[groups.length - 1];
            const adjacent = !!(prev && prev.lastEnd !== null && range && range.start >= prev.lastEnd
                && prev.lineIndex === lineIndex);
            const between = adjacent ? text.slice(prev.lastEnd, range.start) : null;
            const joiner = adjacent ? boldJoinerKind(between) : null;
            if (prev && joiner) {
                prev.indices.push(index);
                prev.lastEnd = range.end;
                if (joiner === 'separator') { prev.parts.push(value); prev.enumerated = true; }
                else prev.parts[prev.parts.length - 1] += ` ${value}`;
                return;
            }
            groups.push({
                indices: [index],
                parts: [value],
                enumerated: false,
                lineIndex,
                // Chữ xen giữa nhóm TRƯỚC và nhóm này (null = không rõ/khác dòng). Luật gộp
                // Zoom Title cần biết nó để loại trường hợp nối bằng "và"/"hoặc"/"hay".
                gapBefore: between,
                firstStart: range ? range.start : null,
                lastEnd: range ? range.end : null,
            });
        });
        return groups.map((g) => {
            /* Chữ của cả nhóm lấy NGUYÊN VĂN từ kịch bản (kể cả dấu "," xen giữa) khi biết
               vị trí — nối tay bằng ", " sẽ viết lại lời kịch bản. */
            const whole = (g.firstStart !== null && g.lastEnd !== null)
                ? text.slice(g.firstStart, g.lastEnd).trim()
                : g.parts.join(' ');
            // Dấu "," NẰM TRONG chính một cụm bold cũng tách (vd một cụm duy nhất
            // "chất đạm, chất béo, …" do người viết bôi đậm cả câu liệt kê).
            const parts = [];
            for (const part of g.parts) parts.push(...splitBoldPhrase(part).parts);
            return {
                indices: g.indices,
                parts,
                text: whole,
                enumerated: g.enumerated || parts.length > 1,
                lineIndex: g.lineIndex,
                gapBefore: g.gapBefore,
            };
        });
    }

    function isLogoGroup(group, assets) {
        return normalizeWord(group && group.text) === LOGO_BOLD_KEY && !!findLogoAsset(assets);
    }

    /**
     * MỘT nhóm -> danh sách KHỐI phải dựng (bước 1, mục 1..5 ở khối chú thích trên).
     * Hàm THUẦN: không biết timeline, không biết kích thước khung hình.
     * @returns {{units:Array, fallbackIndex:number}}
     *   unit = { mode:'logo'|'image'|'template'|'vlog'|'zoom'|'text', text, texts?,
     *            asset?, info?, variant?, ratio?, fallback? }
     */
    function planBoldGroup(group, assets, options = {}) {
        const raw = String((group && group.text) || '').trim();
        const minRatio = Number.isFinite(Number(options.minRatio)) ? Number(options.minRatio) : NOTE_MATCH_MIN_RATIO;
        let fallbackIndex = Number.isFinite(Number(options.fallbackIndex)) ? Math.floor(Number(options.fallbackIndex)) : 0;
        const done = (units) => ({ units, fallbackIndex });
        if (!raw) return done([]);

        // (1) Thương hiệu -> ảnh logo, không chữ.
        if (isLogoGroup(group, assets)) {
            const logo = findLogoAsset(assets);
            return done([{ mode: 'logo', text: raw, asset: logo.asset, info: logo.info }]);
        }

        const parts = (group.parts && group.parts.length) ? group.parts : [raw];

        // (2) Nhóm liệt kê có ít nhất MỘT phần khớp -> cả nhóm lên mẫu "Custom".
        if (group.enumerated) {
            const hits = parts.map((part) => matchBoldAsset(part, assets, { minRatio }));
            if (hits.some(Boolean)) {
                const pool = boldFallbackAssets(assets);
                return done(parts.map((part, i) => {
                    const hit = hits[i];
                    if (hit) {
                        return { mode: 'template', variant: hit.info.tag, text: part, asset: hit.asset, info: hit.info, ratio: hit.ratio };
                    }
                    if (!pool.length) return { mode: 'text', text: part };
                    const fb = pool[((fallbackIndex % pool.length) + pool.length) % pool.length];
                    fallbackIndex += 1;
                    return { mode: 'template', variant: fb.info.tag, text: part, asset: fb.asset, info: fb.info, ratio: 0, fallback: true };
                }));
            }
            // Không phần nào khớp: nhóm không còn là danh sách, chỉ là một câu dài -> (3)/(5).
        }

        // (3) Nhóm dài -> "Vlog Tag" cho CẢ nhóm, thắng cả việc có khớp [Illus].
        if (wordCount(raw) >= BOLD_LONG_PHRASE_WORDS) return done([{ mode: 'vlog', text: raw }]);

        // (4) Nhóm liền mạch ngắn: [Illus] -> mẫu Custom; chỉ [Icon] -> ảnh trần.
        if (!group.enumerated) {
            const illus = matchBoldAsset(raw, assets, { minRatio, tags: ['illus'] });
            if (illus) return done([{ mode: 'template', variant: 'illus', text: raw, asset: illus.asset, info: illus.info, ratio: illus.ratio }]);
            const icon = matchBoldAsset(raw, assets, { minRatio, tags: ['icon'] });
            if (icon) return done([{ mode: 'image', text: raw, asset: icon.asset, info: icon.info, ratio: icon.ratio }]);
        }

        // (5) Còn lại -> chữ thường.
        return done([{ mode: 'text', text: raw }]);
    }

    /**
     * Toàn bộ nhóm của kịch bản -> danh sách VIỆC PHẢI DỰNG, đã áp luật gộp câu (mục 0).
     * @returns {{builds:Array<{groups:number[], units:Array}>, fallbackIndex:number}}
     *   builds[].groups — chỉ số nhóm trong `groups` mà khối này phủ (2 phần tử = Zoom Title)
     */
    function planBoldGroups(groups, assets, options = {}) {
        const list = Array.isArray(groups) ? groups : [];
        let fallbackIndex = Number.isFinite(Number(options.fallbackIndex)) ? Math.floor(Number(options.fallbackIndex)) : 0;
        const builds = [];
        const merged = new Set();

        /* (0) CÂU có ĐÚNG HAI nhóm -> một mẫu "Zoom Title". Đúng hai chứ không phải "từ hai
           trở lên": ba nhóm mà mẫu chỉ có hai ô chữ thì nhóm thứ ba biến mất không dấu vết.
           Nhóm logo được miễn — logo là ảnh thương hiệu, nhét vào ô chữ là mất nó.
           HAI ĐIỀU KIỆN THÊM (người dùng chốt 2026-09-16):
             · không nhóm nào bị dấu "," chia thành cụm nhỏ — đó là câu LIỆT KÊ, phải lên
               mẫu Custom từng mục (luật 2), nhồi vào hai ô chữ là mất mục;
             · chữ KHÔNG-in-đậm xen giữa hai nhóm không được chỉ là "và"/"hoặc"/"hay" — hai
               vế nối bằng từ nối là hai ý ngang hàng, không phải cặp tiêu đề + dòng phụ. */
        const byLine = new Map();
        list.forEach((g, i) => {
            if (isLogoGroup(g, assets)) return;
            const key = g.lineIndex;
            if (!byLine.has(key)) byLine.set(key, []);
            byLine.get(key).push(i);
        });
        for (const indices of byLine.values()) {
            if (indices.length !== 2) continue;
            const [a, b] = indices.map((i) => list[i]);
            if (hasCommaParts(a.text) || hasCommaParts(b.text)) continue;
            if (isConjunctionGap(b.gapBefore)) continue;
            builds.push({
                groups: indices.slice(),
                units: [{ mode: 'zoom', text: `${a.text} ${b.text}`, texts: [a.text, b.text] }],
            });
            indices.forEach((i) => merged.add(i));
        }

        list.forEach((group, i) => {
            if (merged.has(i)) return;
            const plan = planBoldGroup(group, assets, { ...options, fallbackIndex });
            fallbackIndex = plan.fallbackIndex;
            builds.push({ groups: [i], units: plan.units });
        });

        // Theo đúng thứ tự kịch bản — khối Zoom Title đứng ở chỗ nhóm ĐẦU của nó.
        builds.sort((x, y) => x.groups[0] - y.groups[0]);
        return { builds, fallbackIndex };
    }

    // Chỉ số dòng CÓ NỘI DUNG đầu tiên của kịch bản — dòng này là CÂU HOOK.
    function firstContentLineIndex(cleanText) {
        const lines = String(cleanText || '').split('\n');
        for (let i = 0; i < lines.length; i += 1) {
            if (lines[i].trim()) return i;
        }
        return 0;
    }

    /**
     * Từ khoá = ghi chú /*...*\/ trong kịch bản .md. Mỗi ghi chú nằm CÙNG DÒNG với câu
     * thoại tương ứng, nên dòng chứa nó chính là khoảng thời gian đối tượng xuất hiện.
     * Ghi chú của DÒNG ĐẦU TIÊN (hoặc nội dung bắt đầu bằng "CÂU HOOK"/"HOOK") được gắn
     * `isHook: true` — KHÔNG dùng để so khớp asset, chỉ ghi nhớ cho tính năng sau.
     * @param {{notes?:Array}} metadata — currentScriptMetadata
     * @param {string} cleanText — kịch bản chuẩn đã bỏ ghi chú (đúng bản đang dùng để khớp)
     * @returns {Array<{text:string, order:number, lineIndex:number, lineText:string, lineStart:number, lineEnd:number, isHook:boolean}>}
     */
    function keywordsFromScript(metadata, cleanText) {
        const text = String(cleanText || '');
        const notes = (metadata && Array.isArray(metadata.notes)) ? metadata.notes : [];
        const hookLine = firstContentLineIndex(text);
        const out = [];
        notes.forEach((note, index) => {
            const value = String((note && note.text) || '').trim();
            if (!value) return;
            const offset = clamp(Number(note && note.clean_insert_offset) || 0, 0, text.length);
            const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
            let lineEnd = text.indexOf('\n', offset);
            if (lineEnd < 0) lineEnd = text.length;
            const lineText = text.slice(lineStart, lineEnd).trim();
            if (!lineText) return;
            const lineIndex = text.slice(0, lineStart).split('\n').length - 1;
            out.push({
                text: value,
                order: index,
                lineIndex,
                lineText,
                lineStart,
                lineEnd,
                isHook: lineIndex === hookLine || /^(cau)?hook/.test(normalizeWord(value)),
            });
        });
        // Theo đúng thứ tự xuất hiện trong kịch bản (parser đã duyệt tuần tự, nhưng
        // sắp lại cho chắc vì pipeline khớp thời gian chạy bằng con trỏ tiến dần).
        out.sort((a, b) => (a.lineStart - b.lineStart) || (a.order - b.order));
        return out;
    }

    // [Vid]: phủ kín khung hình dự án (cover-fit) — không để lọt nền, giữ đúng tỉ lệ gốc.
    function coverScalePercent(assetW, assetH, seqW, seqH) {
        const w = Number(assetW) > 0 ? Number(assetW) : 0;
        const h = Number(assetH) > 0 ? Number(assetH) : 0;
        if (!w || !h) return 100;
        return Math.ceil(Math.max(Number(seqW) / w, Number(seqH) / h) * 1000) / 10;
    }

    /**
     * [Icon]/[Illus]: GIỮ NGUYÊN 100% kích thước gốc, CHỈ đổi vị trí sao cho nằm ở nửa khung
     * ĐỐI DIỆN mặt người. Kích thước chỉ là dữ liệu đầu vào để tính vị trí, không bị sửa.
     *
     * @param {object} input
     *   assetH          — chiều cao gốc (px); assetW nhận cho đủ bộ nhưng không dùng vì
     *                     đối tượng luôn căn giữa theo chiều ngang
     *   seqW, seqH      — kích thước Sequence
     *   safe            — {top,bottom,left,right} lưới an toàn (px, theo khung Sequence)
     *   faceBand        — {top,bottom} vùng mặt người trên màn hình sau Auto-Reframe (null nếu không rõ)
     *   blocked         — [{top,bottom}] các box đã đặt trùng thời gian (text Magic Fill, icon trước đó)
     * @returns {{scale:number, positionX:number, positionY:number, rect:{top:number,bottom:number}}}
     */
    function insetPlacement(input) {
        const seqW = Number(input.seqW) || 1920;
        const seqH = Number(input.seqH) || 1080;
        const safe = input.safe || { top: 0, bottom: seqH, left: 0, right: seqW };
        const gap = seqH * INSET_GAP_RATIO;
        const assetH = Number(input.assetH) > 0 ? Number(input.assetH) : seqH * 0.3;
        const face = input.faceBand;

        // 1) Nửa khung đối diện mặt: mặt ở nửa TRÊN -> băng DƯỚI mặt, và ngược lại.
        //    Không có dữ liệu mặt -> mặc định băng DƯỚI (đối xứng với text Magic Fill,
        //    vốn neo cạnh TRÊN khi thiếu dữ liệu mặt).
        let bandTop = safe.top;
        let bandBottom = safe.bottom;
        const hasFace = !!face && Number.isFinite(face.top) && Number.isFinite(face.bottom);
        // PHÍA ĐẶT ĐỐI TƯỢNG phải suy từ CHÍNH VỊ TRÍ MẶT, không được suy ngược từ mép băng:
        // băng còn bị các text box thu hẹp, mặt ở nửa DƯỚI mà bandTop bị text box đẩy xuống
        // thì suy ngược sẽ ra "đặt phía dưới" -> ném đối tượng đúng vào mặt (đã mắc).
        const belowFace = hasFace ? ((face.top + face.bottom) / 2 <= seqH / 2) : true;
        if (hasFace) {
            if (belowFace) bandTop = Math.max(bandTop, face.bottom + gap);
            else bandBottom = Math.min(bandBottom, face.top - gap);
        } else {
            bandTop = Math.max(bandTop, seqH / 2 + gap);
        }

        // 2) Tránh các box đã đặt trùng thời gian: đẩy băng vào trong theo phía của box.
        const blocked = Array.isArray(input.blocked) ? input.blocked : [];
        for (const rect of blocked) {
            const top = Number(rect && rect.top);
            const bottom = Number(rect && rect.bottom);
            if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue;
            if (bottom <= bandTop || top >= bandBottom) continue; // không giao băng
            const rectCenter = (top + bottom) / 2;
            if (rectCenter <= (bandTop + bandBottom) / 2) bandTop = Math.max(bandTop, bottom + gap);
            else bandBottom = Math.min(bandBottom, top - gap);
        }

        // 3) KHÔNG BAO GIỜ ĐỔI SCALE (người dùng chốt): đối tượng giữ nguyên 100% kích thước
        //    gốc, chỉ dịch chuyển vị trí. Kích thước chỉ dùng để TÍNH vị trí né mặt.
        const drawH = assetH;
        const bandH = Math.max(0, bandBottom - bandTop);

        // 4) Chọn vị trí theo thứ tự ưu tiên:
        //    (a) vừa băng trống  -> đặt GIỮA BĂNG (đẹp nhất, không chạm mặt lẫn box khác);
        //    (b) không vừa -> dán SÁT RANH GIỚI MẶT về phía băng: đủ để không đè mặt mà vẫn
        //        gọn trong khung (đẩy ra sát đáy/đỉnh khung chỉ làm ảnh dính mép, xấu hơn);
        //    (c) sát ranh giới mặt mà vẫn lòi khỏi khung -> hết cách tránh mặt, dán vào
        //        CẠNH KHUNG phía xa mặt nhất để che mặt ít nhất có thể.
        const faceTopLimit = hasFace ? Number(face.top) - gap : null;
        const faceBottomLimit = hasFace ? Number(face.bottom) + gap : null;
        const clearsFace = (center) => !hasFace || (belowFace
            ? (center - drawH / 2) >= faceBottomLimit - 0.5
            : (center + drawH / 2) <= faceTopLimit + 0.5);
        const insideFrame = (center) => (center - drawH / 2) >= -0.5 && (center + drawH / 2) <= seqH + 0.5;
        let centerY;
        if (bandH >= drawH) {
            centerY = (bandTop + bandBottom) / 2;
        } else {
            // Dán vào cạnh XA của băng trống: giữ được cả né mặt lẫn né box đã đặt khi băng
            // chỉ hụt một chút.
            const farAnchor = belowFace ? bandBottom - drawH / 2 : bandTop + drawH / 2;
            // Sát ranh giới mặt: bỏ ràng buộc box đã đặt, chỉ cốt không đè MẶT.
            const hugFace = hasFace
                ? (belowFace ? faceBottomLimit + drawH / 2 : faceTopLimit - drawH / 2)
                : (belowFace ? bandTop + drawH / 2 : bandBottom - drawH / 2);
            if (clearsFace(farAnchor) && insideFrame(farAnchor)) centerY = farAnchor;
            else if (insideFrame(hugFace)) centerY = hugFace;
            else centerY = belowFace ? seqH - drawH / 2 : drawH / 2; // hết cách tránh mặt
        }
        if (drawH <= seqH) centerY = clamp(centerY, drawH / 2, seqH - drawH / 2);
        else centerY = seqH / 2;                 // ảnh cao hơn cả khung: căn giữa khung

        // Ngang: căn giữa ô lưới an toàn (lưới không đối xứng nên khác giữa khung một chút)
        const centerX = (safe.left + safe.right) / 2;
        return {
            scale: 100,
            positionX: Math.round(centerX - seqW / 2),
            positionY: Math.round(centerY - seqH / 2),
            rect: { top: centerY - drawH / 2, bottom: centerY + drawH / 2 },
        };
    }

    return {
        KIND_COVER,
        KIND_INSET,
        KIND_AUDIO,
        NOTE_MATCH_MIN_RATIO,
        normalizeWord,
        tokenize,
        describeAssetName,
        splitNoteKeywords,
        noteMatchRatio,
        matchNoteAssets,
        BOLD_TEXT_IN_ANIMATIONS,
        BOLD_LONG_PHRASE_WORDS,
        boldTextInAnimation,
        splitBoldPhrase,
        boldJoinerKind,
        groupBoldRanges,
        matchBoldAsset,
        boldFallbackAssets,
        findLogoAsset,
        planBoldGroup,
        planBoldGroups,
        keywordsFromScript,
        coverScalePercent,
        insetPlacement,
    };
});
