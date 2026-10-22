/**
 * SUBSEQUENCE (NEST) — PHẦN TÍNH TOÁN THUẦN
 * ========================================
 * Mô hình theo Premiere Pro: một Subsequence là MỘT "tài sản sequence" trong dự án, và block
 * trên timeline cha chỉ là một INSTANCE trỏ vào nó. Nhiều block cùng trỏ một tài sản thì sửa
 * bên trong một lần, mọi chỗ đổi theo (Premiere: nested sequence nằm trong Project panel).
 *
 * VÌ SAO LÀ TÀI SẢN `media_video` chứ không phải một loại block mới:
 *   Block Subsequence phải trim, kéo, đổi tốc độ, âm lượng, keyframe, hoạt ảnh In/Out, màu,
 *   mặt nạ… y hệt một block video. Mọi đường đó (timeline, Inspector, export) đã đi theo
 *   cặp `item.type === 'media'` + `asset.type === 'media_video'`. Cho nó đúng cặp đó là
 *   hưởng trọn mà không phải rẽ nhánh ở hàng chục chỗ; chỉ những chỗ CẦN tệp thật
 *   (preview, export, proxy, retouch…) mới phải biết đây là Subsequence.
 *
 * Tài sản Subsequence:
 *   { id, type: 'media_video', item_type: 'media', source: 'nest', name, duration,
 *     width, height, has_audio, url: '', path: '', thumbnail_url: '',
 *     nest: { tracks: [...], items: [...] } }   // cùng schema editingTracks/editingItems
 *
 * Nội dung nằm NGAY TRONG tài sản nên editingAssets (đã có trong undo + .crab) mang luôn nó.
 *
 * Module thuần, không đụng DOM, UMD để test bằng Node (giống clip-speed.js / main-lane.js).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.NestSequence = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const NEST_SOURCE = 'nest';
    const MIN_DURATION = 0.2;
    // Lồng quá sâu gần như chắc chắn là vòng tham chiếu (A chứa B chứa A) — chặn để không treo.
    const MAX_DEPTH = 16;

    function isNestAsset(asset) {
        return !!(asset && asset.source === NEST_SOURCE && asset.nest && typeof asset.nest === 'object');
    }

    function num(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function deepClone(value) {
        return JSON.parse(JSON.stringify(value == null ? null : value));
    }

    function rateOf(block) {
        const r = num(block && block.speed && block.speed.rate, 1);
        return r > 0 ? r : 1;
    }

    function itemEnd(item) {
        return num(item.timeline_start) + num(item.duration);
    }

    /* Độ dài một sequence = đuôi xa nhất của nội dung (giống overlayTimelineEnd ở runtime). */
    function contentDuration(content) {
        const items = Array.isArray(content && content.items) ? content.items : [];
        let end = 0;
        items.forEach((item) => { end = Math.max(end, itemEnd(item)); });
        return Math.max(MIN_DURATION, end);
    }

    function assetMap(assets) {
        if (assets instanceof Map) return assets;
        return new Map((Array.isArray(assets) ? assets : []).map((a) => [String(a && a.id), a]));
    }

    /* Mọi item trong một danh sách + mọi item nằm sâu trong các Subsequence nó trỏ tới.
     * Mỗi tài sản Subsequence chỉ duyệt MỘT lần (instance dùng chung không bị đếm lặp, vòng
     * tham chiếu không treo). Dùng cho những chỗ cần "mọi asset đang được dùng" — mở dự án,
     * relink, dọn tệp — vì item lồng bên trong vẫn là người dùng asset thật. */
    function collectDeepItems(items, assets) {
        const byId = assetMap(assets);
        const out = [];
        const seen = new Set();
        const walk = (list, depth) => {
            if (!Array.isArray(list) || depth > MAX_DEPTH) return;
            list.forEach((item) => {
                if (!item) return;
                out.push(item);
                const asset = byId.get(String(item.asset_id));
                if (isNestAsset(asset) && !seen.has(asset.id)) {
                    seen.add(asset.id);
                    walk(asset.nest.items, depth + 1);
                }
            });
        };
        walk(items, 0);
        return out;
    }

    // id các tài sản Subsequence đang được dùng (trực tiếp hoặc lồng sâu) bởi `items`.
    function referencedNestIds(items, assets) {
        const byId = assetMap(assets);
        const ids = new Set();
        collectDeepItems(items, byId).forEach((item) => {
            const asset = byId.get(String(item.asset_id));
            if (isNestAsset(asset)) ids.add(asset.id);
        });
        return ids;
    }

    /* `true` nếu tài sản `nestId` (trực tiếp hoặc lồng sâu) chứa `targetId` — dùng để chặn
     * đặt một Subsequence vào chính nó (kéo instance của A vào trong A). */
    function nestContains(nestId, targetId, assets) {
        const byId = assetMap(assets);
        const asset = byId.get(String(nestId));
        if (!isNestAsset(asset)) return false;
        if (String(nestId) === String(targetId)) return true;
        return referencedNestIds(asset.nest.items, byId).has(String(targetId));
    }

    function contentHasAudio(content, assets, depth = 0) {
        if (depth > MAX_DEPTH) return false;
        const byId = assetMap(assets);
        const items = Array.isArray(content && content.items) ? content.items : [];
        return items.some((item) => {
            if (!item) return false;
            if (item.type === 'audio') return true;
            if (item.type !== 'media') return false;
            const asset = byId.get(String(item.asset_id));
            if (isNestAsset(asset)) return contentHasAudio(asset.nest, byId, depth + 1);
            return !!(asset && asset.has_audio);
        });
    }

    /* GIỜ BÊN TRONG Subsequence ứng với một mốc trên timeline cha.
     * Cùng công thức với block video: nguồn = source_start + (t − timeline_start) × rate. */
    function childTimeAt(nestItem, parentTime) {
        return num(nestItem.source_start) + (num(parentTime) - num(nestItem.timeline_start)) * rateOf(nestItem);
    }

    /* KẾ HOẠCH GÓI: từ các block được chọn (overlay) dựng nội dung cho Subsequence.
     *   - t0 = mốc bắt đầu sớm nhất -> mọi block dời về gốc 0 bên trong;
     *   - mỗi lane có block được chọn sinh MỘT lane bên trong, giữ đúng thứ tự trên-dưới;
     *   - chuyển cảnh chỉ giữ khi cả hai block của điểm cắt cùng được gói (nó gắn vào block
     *     bên trái và trỏ tới block kề bên phải cùng lane).
     * `extraEnd`: đuôi của phần lane chính cũng được gói (giây, đã tính từ t0), nếu có.
     * Trả { t0, duration, tracks, items } — id lane mới do `newTrackId(type)` sinh. */
    function planNest(selectedItems, parentTracks, newTrackId, options = {}) {
        const items = (Array.isArray(selectedItems) ? selectedItems : []).filter(Boolean);
        const t0 = options.t0 != null
            ? num(options.t0)
            : items.reduce((m, it) => Math.min(m, num(it.timeline_start)), Infinity);
        const start = Number.isFinite(t0) ? t0 : 0;
        const usedTrackIds = new Set(items.map((it) => String(it.track_id)));
        const tracks = (Array.isArray(parentTracks) ? parentTracks : [])
            .filter((t) => t && t.type !== 'main' && usedTrackIds.has(String(t.id)))
            .slice()
            .sort((a, b) => num(a.order) - num(b.order));
        const trackIdMap = new Map();
        const outTracks = tracks.map((t, index) => {
            const copy = deepClone(t);
            copy.id = newTrackId(t.type);
            copy.order = index;
            copy.locked = false;
            trackIdMap.set(String(t.id), copy.id);
            return copy;
        });
        const movedIds = new Set(items.map((it) => String(it.id)));
        const outItems = items.map((it) => {
            const copy = deepClone(it);
            copy.timeline_start = Math.max(0, num(it.timeline_start) - start);
            copy.track_id = trackIdMap.get(String(it.track_id)) || copy.track_id;
            delete copy.magic_fill_review;
            return copy;
        });
        // Chuyển cảnh: giữ khi block kề bên phải (cùng lane, nối liền) cũng nằm trong gói.
        outItems.forEach((copy) => {
            if (!copy.transition) return;
            const partner = outItems.find((other) => other !== copy
                && other.track_id === copy.track_id
                && Math.abs(num(other.timeline_start) - itemEnd(copy)) < 0.02);
            if (!partner) delete copy.transition;
        });
        let end = outItems.reduce((m, it) => Math.max(m, itemEnd(it)), 0);
        if (options.extraEnd != null) end = Math.max(end, num(options.extraEnd));
        return {
            t0: start,
            duration: Math.max(MIN_DURATION, end),
            tracks: outTracks,
            items: outItems,
            movedIds,
            trackIdMap,
        };
    }

    /* Block ở timeline cha còn giữ chuyển cảnh trỏ sang một block vừa bị gói đi -> bỏ, vì
     * điểm cắt đó không còn tồn tại trên timeline cha. */
    function dropDanglingTransitions(parentItems, movedIds) {
        (Array.isArray(parentItems) ? parentItems : []).forEach((it) => {
            if (!it || !it.transition || movedIds.has(String(it.id))) return;
            const end = itemEnd(it);
            const stillHasPartner = parentItems.some((other) => other !== it
                && !movedIds.has(String(other.id))
                && other.track_id === it.track_id
                && Math.abs(num(other.timeline_start) - end) < 0.02);
            if (!stillHasPartner) delete it.transition;
        });
    }

    /* KẾ HOẠCH BUNG (Un-nest): đưa nội dung Subsequence trở lại timeline cha, đúng khung thời
     * gian instance đang hiện (phần bị trim ở hai đầu bị cắt đi, giống Premiere "Restore
     * Unnested"). Chỉ làm được khi instance chạy tốc độ 1× — bung một Subsequence tua nhanh
     * là phải đổi tốc độ của từng block con, không còn khớp hình như trước.
     * `advancesSource(item)` cho biết block nào cắt mép trái thì phải dời điểm nguồn.
     * Trả null nếu không bung được. */
    function planUnnest(nestItem, content, advancesSource) {
        if (Math.abs(rateOf(nestItem) - 1) > 1e-6) return null;
        const winStart = num(nestItem.source_start);
        const winEnd = winStart + num(nestItem.duration);
        const base = num(nestItem.timeline_start);
        const out = [];
        (Array.isArray(content && content.items) ? content.items : []).forEach((child) => {
            const cs = num(child.timeline_start);
            const ce = itemEnd(child);
            if (ce <= winStart + 1e-6 || cs >= winEnd - 1e-6) return;
            const ns = Math.max(cs, winStart);
            const ne = Math.min(ce, winEnd);
            if (ne - ns < 0.05) return;
            const copy = deepClone(child);
            const cutLeft = ns - cs;
            if (cutLeft > 1e-6 && advancesSource && advancesSource(child)) {
                copy.source_start = Math.max(0, num(child.source_start)) + cutLeft * rateOf(child);
            }
            if (cutLeft > 1e-6 || ne < ce - 1e-6) delete copy.transition;
            copy.timeline_start = base + (ns - winStart);
            copy.duration = ne - ns;
            out.push({ item: copy, sourceTrackId: String(child.track_id) });
        });
        return out;
    }

    /* Bản sao ĐỘC LẬP của nội dung: id lane + id block mới, để sửa bản này không đụng bản kia.
     * Subsequence lồng bên trong vẫn được DÙNG CHUNG (giống Premiere: nhân bản sequence không
     * nhân bản các sequence con của nó). */
    function cloneContent(content, newTrackId, newItemId) {
        const copy = deepClone(content || { tracks: [], items: [] });
        const map = new Map();
        copy.tracks = (copy.tracks || []).map((t) => {
            if (t.type === 'main') return t;
            const id = newTrackId(t.type);
            map.set(String(t.id), id);
            return { ...t, id };
        });
        copy.items = (copy.items || []).map((it) => ({
            ...it,
            id: newItemId(),
            track_id: map.get(String(it.track_id)) || it.track_id,
        }));
        return copy;
    }

    /* Tên tiếp theo chưa dùng: "Subsequence 1", "Subsequence 2"… */
    function nextNestName(assets, base = 'Subsequence') {
        const names = new Set((Array.isArray(assets) ? assets : [])
            .filter(isNestAsset).map((a) => String(a.name || '')));
        for (let n = 1; n < 10000; n += 1) {
            const name = `${base} ${n}`;
            if (!names.has(name)) return name;
        }
        return `${base} ${Date.now()}`;
    }

    return {
        NEST_SOURCE,
        MAX_DEPTH,
        isNestAsset,
        contentDuration,
        collectDeepItems,
        referencedNestIds,
        nestContains,
        contentHasAudio,
        childTimeAt,
        planNest,
        dropDanglingTransitions,
        planUnnest,
        cloneContent,
        nextNestName,
    };
});
