/* =============================================================================
 * SCRIPT REORDER — sắp xếp timeline theo KỊCH BẢN CHUẨN (CrabbyCut)
 *
 * BỐI CẢNH
 * Ở giai đoạn Timeline (step3) `latestTimeline` nằm theo THỨ TỰ THỜI GIAN của video,
 * không theo thứ tự kịch bản: `#btnApplyAndReorder` gửi `globalMappedChunks` (dựng dọc
 * trục thời gian) tới /api/finalize-timeline, mà FinalizeTimeline trong native addon
 * trả lại nguyên thứ tự đầu vào dưới cái tên gây nhầm `timeline_script_order` — nó
 * KHÔNG sort (native/addon/src/core_c.cpp:241). Câu Hook quay ở giữa video là người
 * dùng phải kéo-thả sắp lại tay từng block.
 *
 * FILE NÀY CHỈ GIỮ LOGIC THUẦN (không DOM, không fetch) của ba việc quanh quan hệ
 * kịch bản <-> timeline:
 *   1. TÁCH CÂU kịch bản — phải là bộ DUY NHẤT. Số hiệu câu (script_index) là khoá liên
 *      kết giữa kịch bản và mọi thứ backend trả về; JS và Python tách câu lệch nhau một
 *      chút là mọi liên kết trỏ nhầm câu — IM LẶNG, không lỗi nào bắn ra. Đưa ra file UMD
 *      thì tests/scripts/matching_pipeline.py require() được đúng bản đang chạy, thay vì
 *      moi mã JS ra khỏi index.html bằng regex.
 *   2. LUẬT SẮP XẾP + tóm tắt kế hoạch.
 *   3. GỘP MẨU LIỀN KỀ khi chốt từ Match Script sang Timeline.
 *
 * ĐÃ GỠ (2026-08-22) — `validateLabels` và cả tầng chấm điểm văn bản bằng JS đi kèm.
 * Chúng phục vụ một thiết kế ĐÃ ĐƯỢC CHỨNG MINH LÀ SAI: "tin nhãn script_index có sẵn
 * trên block khi kiểm chứng được". Đo trên dự án thật, nhãn ở step3 vô giá trị vì
 * ReadRowsFromSelectedChunks (core_c.cpp:172-174) ĐIỀN TRƯỢT nhãn của block trước cho
 * block không có nhãn (biến đếm khởi tạo 0), nên -1 gần như không xuất hiện; còn
 * `item.text` thì bị nhân 2-3 lần. Nay tính năng BÓC BĂNG LẠI các khoảng trên timeline
 * để lấy dòng từ thật rồi so khớp toàn bộ ở backend (core_logic.align_blocks_to_script)
 * — một đường duy nhất, không có nhánh nào tin dữ liệu cũ. Giữ lại đống hàm chấm điểm
 * chết ở đây chỉ là để ngỏ cửa cho ai đó nối lại đúng cái bẫy ấy.
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ScriptReorder = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* --- Tách câu -------------------------------------------------------- */

    // Đánh dấu đầu mục kịch bản ("1." "2)" "-" "•"). Bắt buộc có khoảng trắng hoặc hết
    // dòng ngay sau, để không xén nhầm câu mở đầu bằng số như "1,7g/100ml".
    const LIST_MARKER_RE = /^(?:\d+[.)]|[-–—•*])(?=\s|$)\s*/;
    // Ký tự vô hình: tệp .md xuất từ Word/Google Docs hay dính U+FEFF ở đầu. Python loại
    // cả U+200B; trim() của JS coi U+FEFF là khoảng trắng nhưng KHÔNG coi U+200B là, nên
    // phải loại tường minh ở đây, nếu không hai bên đánh số câu khác nhau.
    const INVISIBLE_RE = /[﻿​]/g;

    // Bỏ khoảng trắng và gạch/bullet ở hai đầu — đối chiếu str.strip(" \t-•") của Python.
    function trimSentenceEdges(text) {
        return String(text).replace(/^[\s\-•]+/, '').replace(/[\s\-•]+$/, '');
    }

    /* Tách MỘT khối văn bản thành các câu.
     *
     * Ranh giới câu = XUỐNG DÒNG hoặc dấu kết thúc câu (. ! ?). Xử lý xuống dòng TRƯỚC
     * rồi mới chuẩn hoá khoảng trắng trong từng dòng: gộp mọi khoảng trắng ngay từ đầu
     * thì nhánh tách theo "\n+" thành mã chết, và hai dòng kịch bản mà dòng trên không
     * có dấu chấm bị dán thành một câu.
     *
     * KHÔNG lọc câu ngắn (câu "Đúng vậy." bị vứt là toàn bộ số hiệu phía sau lệch một).
     * KHÔNG cắt vụn theo dấu phẩy.
     */
    function splitScriptPieces(block) {
        const pieces = [];
        const source = String(block == null ? '' : block).replace(INVISIBLE_RE, '');
        for (const line of source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n+/)) {
            const cleaned = line.replace(/[ \t]+/g, ' ').trim().replace(LIST_MARKER_RE, '');
            if (!cleaned) continue;
            for (const part of cleaned.split(/(?<=[.!?])\s+/)) {
                const trimmed = trimSentenceEdges(part);
                if (trimmed) pieces.push(trimmed);
            }
        }
        return pieces;
    }

    /* Tách TOÀN BỘ kịch bản thành mảng câu phẳng — chỉ số trong mảng CHÍNH LÀ
     * script_index mà backend dùng. Tách theo /\n+/ nên việc renderer chia paragraph
     * bằng /\n{2,}/ trước rồi gọi splitScriptPieces() cho ra đúng dãy này. */
    function splitScriptSentences(text) {
        return splitScriptPieces(text);
    }

    /* --- Gộp mẩu liền kề khi chốt sang Timeline -------------------------- */

    /* Ở màn "Rà soát so khớp kịch bản" (step2), một vùng nói liên tục thường bị chẻ thành
     * NHIỀU mẩu cạnh nhau: _build_mapped_chunks cắt chunk TẠI BIÊN HÀNG, nên hai câu kịch
     * bản đọc liền một hơi thành hai mẩu chia đúng một mốc. Tick cả hai rồi chốt thì
     * timeline nhận hai block, và giữa chúng là một điểm cắt vô cớ ngay giữa dòng nói.
     *
     * Nên khi chốt sang Timeline: các mẩu ĐẶT SÁT CẠNH NHAU gộp thành MỘT block. Mẩu cách
     * nhau (có quãng lặng hoặc có mẩu chưa tick chen giữa) thì để riêng — đó mới là chỗ
     * người dùng chủ ý bỏ đi một đoạn.
     *
     * DUNG SAI 0,021s không phải con số tuỳ ý: đúng bằng ngưỡng mà _build_mapped_chunks
     * dùng để gộp hai mẩu cùng chủ (`abs(previous.end - piece.start) <= 0.021`), và nó nằm
     * trên ngưỡng 0,02s mà hàm đó dùng để BỎ mẩu vụn do làm tròn. Nhờ vậy hai mẩu chỉ cách
     * nhau một mảnh vụn đã bị bỏ vẫn được coi là liền kề, còn một mẩu chưa tick thật sự
     * (luôn dài hơn 0,02s) thì chặn việc gộp lại.
     *
     * Giữ script_index của mẩu ĐẦU TIÊN theo thời gian và dồn cả cụm vào
     * merged_script_indices — cùng quy ước với _merge_close_or_overlapping_rows của pipeline
     * (`cur["script_index"] = deduped_indices[0]`), để mọi chỗ đọc nhãn hiểu như nhau.
     */
    const ADJACENT_MERGE_SEC = 0.021;

    function chunkIndices(chunk) {
        const listed = Array.isArray(chunk?.merged_script_indices) ? chunk.merged_script_indices : [];
        const source = listed.length ? listed : [chunk?.script_index];
        const out = [];
        for (const value of source) {
            const index = Number(value);
            if (Number.isInteger(index) && index >= 0 && !out.includes(index)) out.push(index);
        }
        return out;
    }

    function joinText(a, b) {
        return [String(a || '').trim(), String(b || '').trim()].filter(Boolean).join(' ');
    }

    // Trung bình có TRỌNG SỐ THEO THỜI LƯỢNG. Lấy trung bình trần thì một mẩu 0,3 giây kéo
    // điểm của cả block 8 giây; các trường này là thứ modal xem trước bày ra nên phải trung thực.
    function weightedMean(valueA, durationA, valueB, durationB) {
        const a = Number(valueA);
        const b = Number(valueB);
        const total = Math.max(0, durationA) + Math.max(0, durationB);
        if (!Number.isFinite(a)) return Number.isFinite(b) ? b : 0;
        if (!Number.isFinite(b)) return a;
        if (total <= 0) return a;
        return (a * Math.max(0, durationA) + b * Math.max(0, durationB)) / total;
    }

    function mergeAdjacentChunks(chunks, options) {
        const tolerance = Number.isFinite(options?.toleranceSec) ? options.toleranceSec : ADJACENT_MERGE_SEC;
        const sorted = (Array.isArray(chunks) ? chunks : [])
            .filter((chunk) => chunk && Number.isFinite(Number(chunk.start)) && Number.isFinite(Number(chunk.end)))
            .slice()
            .sort((a, b) => Number(a.start) - Number(b.start) || Number(a.end) - Number(b.end));

        const merged = [];
        for (const chunk of sorted) {
            const previous = merged[merged.length - 1];
            if (previous && Number(chunk.start) - Number(previous.end) <= tolerance) {
                const previousDuration = Number(previous.end) - Number(previous.start);
                const chunkDuration = Number(chunk.end) - Number(chunk.start);
                previous.similarity = weightedMean(previous.similarity, previousDuration, chunk.similarity, chunkDuration);
                previous.token_coverage = weightedMean(previous.token_coverage, previousDuration, chunk.token_coverage, chunkDuration);
                previous.score = weightedMean(previous.score, previousDuration, chunk.score, chunkDuration);
                previous.loudness_dBFS = weightedMean(previous.loudness_dBFS, previousDuration, chunk.loudness_dBFS, chunkDuration);
                // end lấy MAX: hai mẩu có thể chồng nhau chút do snap biên từ, lúc đó lấy
                // end của mẩu sau là làm block NGẮN đi.
                previous.end = Math.max(Number(previous.end), Number(chunk.end));
                previous.text = joinText(previous.text, chunk.text);
                previous.matched_text = joinText(previous.matched_text, chunk.matched_text);
                previous.script_text = joinText(previous.script_text, chunk.script_text);
                for (const index of chunkIndices(chunk)) {
                    if (!previous.merged_script_indices.includes(index)) previous.merged_script_indices.push(index);
                }
                continue;
            }
            const indices = chunkIndices(chunk);
            merged.push({
                ...chunk,
                start: Number(chunk.start),
                end: Number(chunk.end),
                merged_script_indices: indices,
                script_index: indices.length ? indices[0] : Number(chunk.script_index),
            });
        }
        return merged;
    }

    /* --- Luật sắp xếp --------------------------------------------------- */

    const UNMATCHED_SCRIPT_INDEX = -1;

    /* Sắp các mảnh theo (scriptIndex, start), SORT ỔN ĐỊNH.
     *
     * Mảnh không khớp câu nào (scriptIndex < 0) bị dồn về CUỐI và giữ nguyên thứ tự cũ
     * giữa chúng — quyết định của người dùng: giữ dữ liệu, không tự xoá.
     * Nhiều mảnh cùng một scriptIndex (câu bị đọc lại nhiều lần mà cả mấy lần đều đang
     * nằm trên timeline) thì đứng LIỀN NHAU đúng vị trí câu đó, sắp theo thời gian.
     */
    function orderPieces(pieces) {
        const rows = (Array.isArray(pieces) ? pieces : []).map((piece, seq) => ({ piece, seq }));
        rows.sort((a, b) => {
            const ai = Number(a.piece.scriptIndex);
            const bi = Number(b.piece.scriptIndex);
            const aMissing = !Number.isInteger(ai) || ai < 0;
            const bMissing = !Number.isInteger(bi) || bi < 0;
            if (aMissing !== bMissing) return aMissing ? 1 : -1;
            if (!aMissing && ai !== bi) return ai - bi;
            if (!aMissing) {
                const as = Number(a.piece.start);
                const bs = Number(b.piece.start);
                if (Number.isFinite(as) && Number.isFinite(bs) && as !== bs) return as - bs;
            }
            return a.seq - b.seq;      // ổn định: giữ thứ tự cũ khi bằng điểm
        });
        return rows.map((row) => row.piece);
    }

    /* Đếm các cảnh báo cần bày ra modal xem trước. Thuần dữ liệu để test được. */
    function summarizePlan(pieces, sentenceCount, blockCount) {
        const perSentence = new Map();
        let unmatched = 0;
        for (const piece of (Array.isArray(pieces) ? pieces : [])) {
            const idx = Number(piece.scriptIndex);
            if (!Number.isInteger(idx) || idx < 0) { unmatched += 1; continue; }
            perSentence.set(idx, (perSentence.get(idx) || 0) + 1);
        }
        const duplicateSentences = [];
        perSentence.forEach((count, idx) => { if (count > 1) duplicateSentences.push({ scriptIndex: idx, count }); });
        duplicateSentences.sort((a, b) => a.scriptIndex - b.scriptIndex);

        const missingSentences = [];
        for (let i = 0; i < Number(sentenceCount || 0); i += 1) {
            if (!perSentence.has(i)) missingSentences.push(i);
        }
        const splitBlocks = new Map();
        for (const piece of (Array.isArray(pieces) ? pieces : [])) {
            const bi = Number(piece.blockIndex);
            if (!Number.isInteger(bi)) continue;
            splitBlocks.set(bi, (splitBlocks.get(bi) || 0) + 1);
        }
        const splitCount = Array.from(splitBlocks.values()).filter((n) => n > 1).length;

        return {
            blockCount: Number(blockCount || 0),
            pieceCount: Array.isArray(pieces) ? pieces.length : 0,
            sentenceCount: Number(sentenceCount || 0),
            matchedSentenceCount: perSentence.size,
            unmatchedPieceCount: unmatched,
            splitBlockCount: splitCount,
            duplicateSentences,
            missingSentences,
        };
    }

    return {
        UNMATCHED_SCRIPT_INDEX,
        ADJACENT_MERGE_SEC,
        // tách câu — MỘT bộ duy nhất, đối chiếu split_sentences() của Python
        splitScriptSentences,
        splitScriptPieces,
        // gộp mẩu liền kề ở bước chốt Match Script -> Timeline
        mergeAdjacentChunks,
        // kế hoạch sắp xếp
        orderPieces,
        summarizePlan,
    };
});
