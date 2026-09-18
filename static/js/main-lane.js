/* LANE CHÍNH DỰNG TAY — phần tính toán thuần (không DOM, không fetch).
 *
 * BỐI CẢNH. Lane chính của Editing không phải một danh sách clip sửa được: nó được SUY RA
 * từ `latestTimeline`, mà mỗi row của mảng đó là một cặp {start,end} trong TIMEBASE của
 * `temp_uploads/temp_input.mp4` — file do backend nối tất cả video nguồn lại. Trước đây chỉ
 * có luồng bóc băng sinh ra mảng này. Nay người dùng mở dự án trống rồi tự thêm video, nên
 * phải tự dựng lấy: nối video (KHÔNG chạy ASR) rồi tính xem mỗi video chiếm đoạn nào.
 *
 * VÌ SAO TÁCH RA FILE RIÊNG. Toàn bộ rủi ro của tính năng nằm ở số học mốc thời gian: lệch
 * một chút là overlay dán sai khung hình mà không có lỗi nào báo. Tách khỏi DOM thì test
 * bằng node thuần được (tests/scripts/main_lane_rows.js), không phải mở app bấm tay.
 *
 * QUY ƯỚC. "segment" = một video nguồn chiếm đoạn [start, end) trong file đã nối.
 * "row" = một clip trên lane chính; nhiều row có thể nằm trong cùng một segment (người dùng
 * cắt bằng dao) và row có thể bị xoá. Vì thế segment và row là HAI thứ khác nhau, không
 * suy ngược 1-1 được.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.MainLane = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    // Dưới ngưỡng này thì backend từ chối ("Timeline item #N có thời lượng quá ngắn hoặc
    // end <= start", xem normalizeExportIntervals) — chặn ngay từ đây để export không chết
    // ở phút cuối vì một đoạn rác dài 10ms.
    const MIN_CLIP_SEC = 0.05;
    // Sai số cho phép khi dò xem một mốc thuộc segment nào. Thời lượng đến từ ffprobe nên
    // luôn có phần lẻ; so sánh bằng dấu bằng chính xác là hỏng.
    const EPS = 1e-6;

    function num(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    /* ===================== KHỔ HÌNH CỦA LANE CHÍNH =====================
     *
     * BỐI CẢNH. Lane chính chạy trên MỘT file đã nối, mà `ffmpeg -f concat` đòi mọi đoạn
     * cùng khổ hình — nguồn khác khổ nhau thì phải chèn viền cho đủ khổ chung. Viền đó nằm
     * TRONG khung hình, nên nếu không ai ghi lại "ảnh thật chiếm phần nào của khung" thì:
     *   - khung transform trên preview bao cả viền chứ không bao ảnh (kéo/co giãn lệch);
     *   - và không có cách nào bỏ viền đi ở khâu sau.
     * Ba hàm dưới là HỢP ĐỒNG DUY NHẤT về khổ hình giữa ba phía: backend (dựng file nối),
     * preview (vẽ sprite + khung chọn) và export (filtergraph của sidecar). Để mỗi phía tự
     * tính lại là sớm muộn cũng lệch, mà lệch khổ hình thì bản xuất ra sai im lặng.
     *
     * QUY ƯỚC ĐƠN VỊ:
     *   - `frame`   : khổ của file đã nối (temp_input.mp4), đơn vị pixel.
     *   - `content` : hình chữ nhật ảnh THẬT trong khung đó, đơn vị pixel CỦA KHUNG NỐI.
     *   - `fitScale`: số pixel SEQUENCE trên mỗi pixel khung nối, ở scale 100%.
     */

    // Cạnh CHẴN, tối thiểu 2: yuv420p không nhận cạnh lẻ. Làm tròn XUỐNG để không bao giờ
    // phải phóng nguồn lên (phóng lên là tự tay làm mờ ảnh).
    function evenSize(value) {
        const n = Math.floor(num(value, 0));
        if (!(n >= 2)) return 0;
        return n - (n % 2);
    }

    /* KHUNG BAO của mọi nguồn: rộng = max(rộng), cao = max(cao).
     *
     * VÌ SAO KHÔNG LẤY KHỔ CỦA NGUỒN ĐẦU TIÊN (bản trước làm vậy): nguồn nào lớn hơn hoặc
     * khác khổ nguồn đầu đều bị THU NHỎ ngay lúc nạp — clip ngang 1920×1080 trong dự án dọc
     * 1080×1920 chỉ còn 1080×607, mất 68% pixel và mất VĨNH VIỄN. Người dùng co giãn clip đó
     * lên cho tràn khung là thấy mờ hẳn so với CapCut. Khung bao thì KHÔNG nguồn nào bị thu
     * nhỏ (hệ số vừa-khung luôn = 1), đổi lại khung to hơn nên chuẩn hoá/nối/proxy tốn hơn ở
     * dự án lệch khổ. Dự án mà mọi nguồn cùng khổ: khung bao ĐÚNG BẰNG khổ đó, không đổi gì.
     */
    function concatFrameSize(sizes) {
        let width = 0;
        let height = 0;
        for (const size of (sizes || [])) {
            const w = evenSize(size?.width);
            const h = evenSize(size?.height);
            if (!w || !h) continue;   // probe hụt -> bỏ, thà thiếu một nguồn còn hơn lệch cả khung
            if (w > width) width = w;
            if (h > height) height = h;
        }
        return (width && height) ? { width, height } : null;
    }

    /* Vùng ảnh thật của một nguồn trong khung nối, ĐẶT GIỮA.
     *
     * Cỡ ảnh = khổ nguồn làm chẵn xuống, KẸP trong khung (khung bao thì không bao giờ phải
     * kẹp, nhưng hàm vẫn phải đúng cho khung do người khác đưa vào). Lề chia đôi và luôn
     * CHẴN vì cả hai cạnh đều chẵn -> `pad` nhận số nguyên, không có ca làm tròn nhập nhằng.
     */
    function contentRectIn(frame, sourceWidth, sourceHeight) {
        const rawFrameW = Math.floor(num(frame?.width, 0));
        const rawFrameH = Math.floor(num(frame?.height, 0));
        /* NGUỒN VỪA KHÍT KHUNG -> KHÔNG có viền, kể cả khi cạnh lẻ.
         * Ca này không hiếm chút nào: mọi nguồn cùng khổ thì bước chuẩn hoá bị BỎ QUA hẳn
         * (xem normalizeSourcesForConcat) nên khung nối chính là khổ nguồn, chưa qua tay
         * `scale`/`pad` nào. Không chốt ở đây thì nguồn cạnh lẻ (1081×1920) bị báo vùng ảnh
         * 1080 rộng trong khung 1081 — lệch 1 pixel ở MỌI khâu phía sau. */
        if (rawFrameW > 0 && rawFrameW === Math.floor(num(sourceWidth, -1))
            && rawFrameH > 0 && rawFrameH === Math.floor(num(sourceHeight, -1))) {
            return { x: 0, y: 0, width: rawFrameW, height: rawFrameH };
        }
        const frameW = evenSize(rawFrameW);
        const frameH = evenSize(rawFrameH);
        const srcW = evenSize(sourceWidth);
        const srcH = evenSize(sourceHeight);
        if (!frameW || !frameH) return null;
        if (!srcW || !srcH) return { x: 0, y: 0, width: frameW, height: frameH };
        // Hệ số ≤ 1: chỉ thu nhỏ khi nguồn không lọt khung, tuyệt đối không phóng lên.
        const factor = Math.min(1, frameW / srcW, frameH / srcH);
        const width = Math.min(frameW, Math.max(2, evenSize(Math.round(srcW * factor))));
        const height = Math.min(frameH, Math.max(2, evenSize(Math.round(srcH * factor))));
        /* LỀ PHẢI CHẴN, không chỉ nguyên: yuv420p lấy mẫu màu theo khối 2×2, `pad` với lề lẻ
         * là đẩy kênh màu lệch nửa khối so với kênh sáng. Cả hai cạnh đều chẵn nên hiệu chia
         * đôi vốn đã nguyên; làm chẵn xuống thêm một bước là hết ca lẻ. */
        return {
            x: evenSize((frameW - width) / 2),
            y: evenSize((frameH - height) / 2),
            width,
            height,
        };
    }

    /* Hệ số VỪA KHUNG ở scale 100% — số pixel sequence trên mỗi pixel khung nối.
     *
     * ĐÂY LÀ ĐỊNH NGHĨA CỦA "scale 100%" cho block lane chính, và nó theo CapCut: clip khác
     * khổ với dự án thì VỪA KHUNG (contain) ở 100%, tức thấy trọn ảnh, phần trống là nền
     * canvas — muốn tràn khung thì tự co giãn lên.
     * Bản trước vẽ clip theo ĐÚNG SỐ PIXEL nguồn trên canvas, nên nguồn to hơn canvas bị cắt
     * còn nguồn nhỏ hơn thì lọt giữa — hai hành vi khác nhau cho cùng một thao tác.
     * Dự án mà nguồn cùng khổ với sequence: hệ số = 1, không đổi gì so với bản trước.
     */
    function fitScale(content, sequenceWidth, sequenceHeight) {
        const cw = num(content?.width, 0);
        const ch = num(content?.height, 0);
        const seqW = num(sequenceWidth, 0);
        const seqH = num(sequenceHeight, 0);
        if (!(cw > 0) || !(ch > 0) || !(seqW > 0) || !(seqH > 0)) return 1;
        return Math.min(seqW / cw, seqH / ch);
    }

    /* Cỡ mà ảnh thật chiếm TRÊN CANVAS ở scale 100%, đơn vị pixel SEQUENCE.
     * Đây là "cỡ gốc" mà khung transform và auto-reframe phải dùng: cả hai đều hiểu
     * `scale`/`position` theo hệ toạ độ sequence. */
    function clipBaseSize(content, sequenceWidth, sequenceHeight) {
        const f = fitScale(content, sequenceWidth, sequenceHeight);
        return {
            width: Math.max(1, num(content?.width, 0) * f),
            height: Math.max(1, num(content?.height, 0) * f),
        };
    }

    /* Bảng segment từ thời lượng từng nguồn, cộng dồn theo ĐÚNG THỨ TỰ NỐI.
     * entries: [{ source_path, name, duration }] — thứ tự phải khớp `source_paths` gửi cho
     * /api/project/reingest kèm preserve_order:true, nếu không bảng này mô tả sai file thật. */
    function segmentTableFromDurations(entries) {
        const out = [];
        let cursor = 0;
        for (const entry of (entries || [])) {
            const duration = num(entry?.duration, 0);
            if (duration <= 0) continue;   // probe hụt -> bỏ, thà thiếu một đoạn còn hơn lệch cả bảng
            const start = cursor;
            cursor += duration;
            out.push({
                source_path: String(entry?.source_path || ''),
                name: String(entry?.name || '') || String(entry?.source_path || '').split(/[\\/]/).pop() || 'Clip',
                start,
                end: cursor,
                duration,
            });
        }
        return out;
    }

    /* Row lane chính cho từng segment. Shape phải đủ cho CẢ hai phía:
     *   - backend normalizeExportIntervals: bắt buộc start/end hữu hạn, end-start >= 0.05;
     *   - frontend renderWordLevelTranscript('FINAL') + nhãn block: text/sub_segments.
     * `source_path` là trường THÊM so với row do luồng lọc sinh ra — nhờ nó mà suy ngược
     * được danh sách nối (concatSourcesFromRows) thay vì phải giữ một mảng state song song. */
    function rowsFromSegments(segments, startIndex = 0) {
        const out = [];
        for (const seg of (segments || [])) {
            const start = num(seg?.start, 0);
            const end = num(seg?.end, 0);
            if (end - start < MIN_CLIP_SEC) continue;
            out.push({
                start,
                end,
                text: String(seg?.name || 'Clip'),
                matched_text: String(seg?.name || 'Clip'),
                script_index: -1,
                chunk_index: startIndex + out.length,
                sub_segments: [],
                source_path: String(seg?.source_path || ''),
                loudness_dBFS: 0,
                similarity: 1,
                token_coverage: 1,
                score: 1,
                merged_script_indices: [-1],
                is_selected: true,
            });
        }
        return out;
    }

    /* Dời row sang bảng segment MỚI sau khi nối lại.
     *
     * Đường hạnh phúc (chỉ thêm video vào cuối) cho delta = 0 ở mọi row — nghĩa là hàm này
     * không làm gì cả. Nó tồn tại cho hai ca còn lại:
     *   - nối lại làm biên trôi vài ms (nguồn phải chuẩn hoá lại, vd .webm);
     *   - một nguồn bị bỏ khỏi lane chính -> row của nó phải biến mất, row sau dịch lên.
     *
     * Dò theo VỊ TRÍ chứ không theo source_path của row: row do người dùng cắt vẫn nằm
     * trong segment cũ nên vị trí mới là dấu hiệu đáng tin nhất. Trùng path thì khớp theo
     * lần xuất hiện thứ k (cùng một file thêm hai lần là hai đoạn khác nhau). */
    function rebaseRows(rows, oldSegments, newSegments) {
        const olds = Array.isArray(oldSegments) ? oldSegments : [];
        const news = Array.isArray(newSegments) ? newSegments : [];
        // Chỉ số lần xuất hiện của mỗi path, tính riêng cho hai bảng.
        const occurrence = (list) => {
            const seen = new Map();
            return list.map((seg) => {
                const k = seen.get(seg.source_path) || 0;
                seen.set(seg.source_path, k + 1);
                return k;
            });
        };
        const oldOcc = occurrence(olds);
        const newOcc = occurrence(news);

        const out = [];
        for (const row of (rows || [])) {
            const start = num(row?.start, 0);
            const end = num(row?.end, 0);
            let idx = -1;
            for (let i = 0; i < olds.length; i += 1) {
                if (olds[i].start <= start + EPS) idx = i; else break;
            }
            if (idx < 0) { out.push(row); continue; }   // dữ liệu lạ -> giữ nguyên, không đoán
            const target = news.findIndex((seg, j) => seg.source_path === olds[idx].source_path && newOcc[j] === oldOcc[idx]);
            if (target < 0) continue;                   // nguồn đã rời khỏi lane chính -> bỏ row
            const delta = news[target].start - olds[idx].start;
            const nextStart = start + delta;
            const nextEnd = Math.min(end + delta, news[target].end);
            if (nextEnd - nextStart < MIN_CLIP_SEC) continue;
            out.push({ ...row, start: nextStart, end: nextEnd });
        }
        return out;
    }

    /* ===================== GIỚI HẠN TRIM CỦA MỘT CLIP LANE CHÍNH =====================
     *
     * "HẾT PHIM" CỦA CLIP LÀ HẾT ĐOẠN CỦA NÓ, KHÔNG PHẢI HẾT FILE NỐI. Lane chính chạy trên
     * MỘT file temp_input.mp4 gồm nhiều video nối lại, nên mốc chặn đúng của một clip là hai
     * biên của đoạn thuộc về nguồn nó đang chiếu.
     *
     * LỖI ĐÃ GÂY RA KHI THIẾU CHỖ CHẶN NÀY (người dùng báo 2026-09-13): mép phải kẹp theo
     * thời lượng CẢ file nối, mép trái kẹp về 0 — kéo dài block của video A là nó chiếu tiếp
     * sang footage của video B nằm ngay sau trong file nối. Thấy rõ nhất sau khi XOÁ block B
     * khỏi lane chính: xoá block KHÔNG nối lại file (đúng, vì nối lại rất đắt và media vẫn còn
     * trong panel Tệp phương tiện), nên B vẫn nằm trong temp_input.mp4 và A kéo được tới 20s.
     *
     * Premiere Pro và CapCut đều chặn cứng tay cầm ở mép media: kéo quá là con trỏ chạy tiếp
     * còn block đứng yên. Đây là chỗ chặn đó.
     */

    /* Đoạn (nguồn) mà một mốc giờ nguồn đang rơi vào.
     * Dò theo VỊ TRÍ chứ không theo source_path của row: cùng một file thêm hai lần là hai
     * đoạn khác nhau, còn row do người dùng cắt bằng dao thì không mang mốc biên nào. */
    function segmentAt(segments, sourceTime) {
        const list = Array.isArray(segments) ? segments : [];
        const time = num(sourceTime, 0);
        let found = null;
        for (const seg of list) {
            if (num(seg?.start, 0) <= time + EPS) found = seg; else break;
        }
        return found;
    }

    /* Clip "thò đuôi đoạn trước": phần nằm trong đoạn của mốc BẮT ĐẦU phải vừa chiếm
       dưới ngần này của clip, vừa ngắn hơn ngần kia — khi đó mốc bắt đầu chỉ là sai số,
       không phải chủ ý. Hai ngưỡng CÙNG phải đạt, xem segmentForRange để biết vì sao. */
    const STRADDLE_TAIL_RATIO = 0.1;
    const STRADDLE_TAIL_SEC = 0.5;

    /* Đoạn (nguồn) mà một KHOẢNG [start, end) THUỘC VỀ.
     *
     * Mặc định vẫn là đoạn chứa mốc BẮT ĐẦU (`segmentAt`) — đó là ý người dùng khi họ kéo
     * tay cầm: clip của video A kéo dài quá mép thì vẫn là clip của A, phải cắt phần thừa
     * (lỗi 2026-09-13). Chỉ ĐỔI sang đoạn chồng lấn nhiều nhất khi clip mới chỉ THÒ ĐUÔI
     * vào đoạn của mốc bắt đầu một mẩu không đáng kể so với chính nó.
     *
     * VÌ SAO cần ngoại lệ đó (mất clip thật, dự án "Yêu Con 1 - Test ver 2", người dùng báo
     * 2026-09-16): bước khớp kịch bản cắt clip theo mốc PHIÊN ÂM của file nối, mà phiên âm
     * không biết ranh giới nguồn nằm đâu. Một câu thoại bắt đầu sớm hơn ranh giới 0,086s
     * rồi chạy trọn 6,71s trong video KẾ TIẾP vẫn bị coi là clip của video TRƯỚC, và bị kẹp
     * mép phải về hết video đó: 6,8s teo còn 0,08s — vẫn dài hơn MIN_CLIP_SEC nên không bị
     * bỏ, chỉ lặng lẽ thành mảnh vụn không ai thấy. Theo phần chồng lấn thì nó thuộc video
     * kế tiếp và chỉ mất 0,086s ở mép trái.
     *
     * VÌ SAO phải kèm ngưỡng chứ không lấy thẳng đoạn chồng lấn nhiều nhất: clip video A
     * (5s) bị kéo tay cầm thành 15s thì phần nằm ở video B (9s) LỚN HƠN phần ở A (6s) —
     * lấy theo chồng lấn là clip nhảy hẳn sang B, đúng bằng lỗi 2026-09-13 mà chỗ này sinh
     * ra để chặn. Ở đó phần thuộc A chiếm 40% clip nên không phải "thò đuôi"; ở ca trên chỉ
     * 1,3%. Ranh giới giữa hai ca là ngưỡng bên trên.
     *
     * Khoảng rỗng / không hợp lệ -> rơi về `segmentAt` (hành vi cũ). */
    function segmentForRange(segments, sourceStart, sourceEnd) {
        const list = Array.isArray(segments) ? segments : [];
        if (!list.length) return null;
        const start = num(sourceStart, 0);
        const end = num(sourceEnd, start);
        const head = segmentAt(list, start);
        if (!head || !(end > start + EPS)) return head;
        const tail = Math.min(end, num(head.end, 0)) - start;   // phần clip nằm trong `head`
        const span = end - start;
        if (!(tail < span * STRADDLE_TAIL_RATIO) || !(tail < STRADDLE_TAIL_SEC)) return head;
        let best = head;
        let bestOverlap = tail;
        for (const seg of list) {
            const overlap = Math.min(end, num(seg?.end, 0)) - Math.max(start, num(seg?.start, 0));
            if (overlap > bestOverlap + EPS) { bestOverlap = overlap; best = seg; }
        }
        return best;
    }

    /* Hai biên trim của clip đang đứng ở `sourceTime`.
     * KHÔNG có bảng đoạn (dự án cũ, hoặc bộ đệm bị dọn giữa chừng) -> trả [0, fallbackEnd],
     * tức đúng hành vi trước đây: thà rộng còn hơn chặn nhầm một clip hợp lệ. */
    function sourceLimitsFor(segments, sourceTime, fallbackEnd = Infinity) {
        const seg = segmentAt(segments, sourceTime);
        if (!seg) return { start: 0, end: num(fallbackEnd, Infinity) };
        return { start: num(seg.start, 0), end: num(seg.end, 0) };
    }

    /* Kéo mọi row về trong đoạn của nó.
     *
     * Dùng cho DỰ ÁN ĐÃ LỠ TRÀN trước khi có chỗ chặn ở trên: mốc tràn nằm trong .crab nên
     * mở lại là preview vẫn chiếu nhầm cảnh cho tới khi người dùng vô tình đụng vào tay cầm.
     * Gọi SAU khi đã có bảng đoạn THẬT của file nối hiện tại (mở dự án + mỗi lượt nối lại).
     *
     * Cắt xong mà ngắn hơn MIN_CLIP_SEC thì BỎ row: backend từ chối đoạn ngắn như vậy lúc
     * export ("thời lượng quá ngắn"), giữ lại chỉ để chết ở phút cuối.
     * Trả kèm `fixed` để nơi gọi báo cho người dùng biết lane chính vừa bị sửa. */
    function clampRowsToSegments(rows, segments) {
        const list = Array.isArray(rows) ? rows : [];
        const segs = Array.isArray(segments) ? segments : [];
        if (!segs.length) return { rows: list.slice(), fixed: 0 };
        const out = [];
        let fixed = 0;
        for (const row of list) {
            const start = num(row?.start, 0);
            const end = num(row?.end, 0);
            /* Đoạn "nhà" của clip = đoạn CHỒNG LẤN NHIỀU NHẤT, không phải đoạn chứa mốc bắt
               đầu — xem segmentForRange để biết vì sao (clip vắt qua ranh giới). */
            const home = segmentForRange(segs, start, end);
            const limits = home
                ? { start: num(home.start, 0), end: num(home.end, 0) }
                : sourceLimitsFor(segs, start);
            const maxStart = Math.max(limits.start, limits.end - MIN_CLIP_SEC);
            const nextStart = Math.min(Math.max(start, limits.start), maxStart);
            const nextEnd = Math.min(Math.max(end, nextStart + MIN_CLIP_SEC), limits.end);
            if (Math.abs(nextStart - start) <= EPS && Math.abs(nextEnd - end) <= EPS) {
                out.push(row);
                continue;
            }
            fixed += 1;
            if (nextEnd - nextStart < MIN_CLIP_SEC) continue;
            out.push({ ...row, start: nextStart, end: nextEnd });
        }
        return { rows: out, fixed };
    }
    /* Danh sách nguồn để nối, SUY RA từ chính lane chính.
     *
     * Đây là điểm chống lệch trạng thái quan trọng nhất của tính năng: danh sách nối KHÔNG
     * phải một mảng state riêng phải nhớ đồng bộ. `latestTimeline` đã nằm trong
     * captureFullState() nên undo/redo và file .crab tự lo giúp — giữ thêm một mảng song
     * song là chắc chắn có ngày hai bên lệch nhau.
     *
     * Row do luồng LỌC sinh ra không có source_path; gặp row như vậy thì trả null để người
     * gọi rơi về bộ nhớ đệm của lần nối gần nhất. */
    function concatSourcesFromRows(rows) {
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) return [];
        const out = [];
        const seen = new Set();
        for (const row of list) {
            const p = String(row?.source_path || '');
            if (!p) return null;
            if (seen.has(p)) continue;
            seen.add(p);
            out.push(p);
        }
        return out;
    }

    return {
        MIN_CLIP_SEC,
        segmentTableFromDurations,
        rowsFromSegments,
        rebaseRows,
        concatSourcesFromRows,
        segmentAt,
        segmentForRange,
        sourceLimitsFor,
        clampRowsToSegments,
        evenSize,
        concatFrameSize,
        contentRectIn,
        fitScale,
        clipBaseSize,
    };
});
