(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AutoReframeGeometry = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const DEFAULT_CONFIG = Object.freeze({
        // MẶT Ở NỬA TRÊN NGUỒN: neo theo CẰM chứ không theo tâm mặt (người dùng chốt
        // 2026-08-04) — đặt CẰM cách đường ngang GIỮA khung dự án 2%H và LÊN TRÊN đường giữa.
        // Đây là TỈ LỆ CẰM trên màn hình (0.5−0.02=0.48). Việc quy đổi cằm -> tâm mặt (trừ
        // nửa CHIỀU CAO MẶT ĐÃ PHÓNG THẬT) làm trong faceTargetBandPx, nên chỗ này KHÔNG phụ
        // thuộc cỡ mặt/scale. Min = cằm cao nhất cho phép (không quá cao), Max = cằm thấp
        // nhất (cho chìm thêm khi cần giữ thân trong khung).
        upperSourceChinTargetRatio: 0.48,
        upperSourceChinMinRatio: 0.45,
        upperSourceChinMaxRatio: 0.56,
        lowerSourceFaceTargetYRatio: 0.50,
        lowerSourceFaceTargetMinYRatio: 0.44,
        lowerSourceFaceTargetMaxYRatio: 0.56,
        faceHeightRatio: 0.16,
        minFaceHeightRatio: 0.10,
        maxFaceHeightRatio: 0.24,
        bodyTargetYRatio: 0.56,
        bodySafeMinYRatio: 0.42,
        bodySafeMaxYRatio: 0.70,
        faceVisibilityMarginRatio: 0.08,
        faceVisibilityMinMarginPx: 24,
        faceVisibilityMaxMarginPx: 96,
        maxScalePercent: 800,
        minScalePercent: 1,
        // Trần phóng của Auto-Reframe, tính THEO BỘI SỐ của mức vừa đủ phủ khung
        // (không phải % tuyệt đối): dự án cùng tỉ lệ nguồn -> sàn 100% -> trần 160%;
        // dựng dọc 1080x1920 từ nguồn 1920x1080 -> sàn 178% -> trần 285%.
        // Nếu là % tuyệt đối thì mọi dự án đổi tỉ lệ đều vỡ ràng buộc "không lọt nền".
        maxAutoZoomRatio: 1.6,
        // Lưới an toàn — PHẢI trùng SAFE_ZONE_INSETS của index.html (lưới người dùng nhìn
        // thấy). Tâm mặt bị kẹp vào lưới này, không chỉ vào dải mục tiêu.
        safeInsetTop: 0.10,
        safeInsetBottom: 0.20,
        safeInsetLeft: 0.06,
        safeInsetRight: 0.10,
        // Sai số bố cục (px khung dự án, quy theo chiều cao) mà ta CHẤP NHẬN để đổi lấy
        // việc phóng ít hơn: phóng thêm mà chỉ bớt được ngần này thì không đáng cắt hình.
        layoutErrorToleranceRatio: 0.02,
        // Cân giữa "giữ đúng bố cục từng block" và "khớp vị trí người tại điểm cắt".
        // Nghiêng về khớp cắt (2:1) vì giật khung tại điểm cắt dễ thấy hơn nhiều so với
        // lệch tâm vài chục px. Đặt junctionMatchWeight = 0 là quay về hành vi cũ.
        junctionCompositionWeight: 1,
        junctionMatchWeight: 2,
        // Mốc bố cục khi có dữ liệu 2 đầu block:
        //   'travel-mid' = căn giữa ĐIỂM GIỮA đường đi của người trong block (đầu+cuối)/2.
        //   'head'       = căn giữa theo khung ĐẦU (hành vi trước khi có dữ liệu khung cuối).
        // 'travel-mid' tốt hơn cho đúng mục tiêu "người luôn ở giữa": với một transform
        // TĨNH, sai số trung bình trong block nhỏ nhất khi lấy giữa đường đi, không phải
        // khi ghim vào một đầu. Nó cũng làm hai vế của điểm cắt bớt chọi nhau.
        junctionAnchor: 'travel-mid',
    });

    function normalizeConfig(config = DEFAULT_CONFIG) {
        return { ...DEFAULT_CONFIG, ...(config || {}) };
    }

    function finiteOrNull(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function positiveOrFallback(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    function clamp(value, minValue, maxValue) {
        return Math.max(minValue, Math.min(maxValue, value));
    }

    function roundTransformNumber(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return 0;
        return Math.round(parsed * 10) / 10;
    }

    function sourceSize(meta, payload) {
        const payloadW = positiveOrFallback(payload?.source_width, payload?.width || 1920);
        const payloadH = positiveOrFallback(payload?.source_height, payload?.height || 1080);
        const sourceW = positiveOrFallback(
            meta?.source_width,
            meta?.coordinate_space === 'render' ? positiveOrFallback(meta?.frame_width, payloadW) : payloadW,
        );
        const sourceH = positiveOrFallback(
            meta?.source_height,
            meta?.coordinate_space === 'render' ? positiveOrFallback(meta?.frame_height, payloadH) : payloadH,
        );
        return { sourceW, sourceH };
    }

    function coverageRange(sequenceSize, scaledSize) {
        if (scaledSize <= sequenceSize) return { min: 0, max: 0 };
        return {
            min: (sequenceSize - scaledSize) / 2,
            max: (scaledSize - sequenceSize) / 2,
        };
    }

    function intersectRanges(first, second) {
        if (!first || !second) return null;
        const min = Math.max(first.min, second.min);
        const max = Math.min(first.max, second.max);
        return min <= max ? { min, max } : null;
    }

    function clampToRange(value, range) {
        return clamp(value, range.min, range.max);
    }

    function getScaledRect(transform, sourceW, sourceH, seqW, seqH) {
        const scaleRatio = positiveOrFallback(transform?.scale, 100) / 100;
        const scaledW = sourceW * scaleRatio;
        const scaledH = sourceH * scaleRatio;
        const positionX = Number(transform?.position_x) || 0;
        const positionY = Number(transform?.position_y) || 0;
        const left = ((seqW - scaledW) / 2) + positionX;
        const top = ((seqH - scaledH) / 2) + positionY;
        return {
            left,
            top,
            right: left + scaledW,
            bottom: top + scaledH,
            width: scaledW,
            height: scaledH,
            centerX: left + (scaledW / 2),
            centerY: top + (scaledH / 2),
        };
    }

    function hasFullCoverage(rect, seqW, seqH, tolerance = 0.01) {
        return !!rect
            && rect.left <= tolerance
            && rect.top <= tolerance
            && rect.right >= seqW - tolerance
            && rect.bottom >= seqH - tolerance;
    }

    function coverageAudit(transform, sourceW, sourceH, seqW, seqH, tolerance = 0.01) {
        const rect = getScaledRect(transform, sourceW, sourceH, seqW, seqH);
        return {
            covered: hasFullCoverage(rect, seqW, seqH, tolerance),
            rect,
        };
    }

    function minCoverScalePercent(sourceW, sourceH, seqW, seqH, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const scaleRatio = Math.max(seqW / Math.max(1, sourceW), seqH / Math.max(1, sourceH));
        return clamp(
            Math.ceil((scaleRatio * 100) - 0.0001),
            cfg.minScalePercent,
            cfg.maxScalePercent,
        );
    }

    function ensureCoverageByScale(transform, sourceW, sourceH, seqW, seqH, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const next = { ...(transform || {}) };
        const minScale = minCoverScalePercent(sourceW, sourceH, seqW, seqH, cfg);
        next.scale = clamp(
            Math.max(positiveOrFallback(next.scale, 100), minScale),
            cfg.minScalePercent,
            cfg.maxScalePercent,
        );
        return next;
    }

    function clampTransformToCoverage(transform, sourceW, sourceH, seqW, seqH, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const next = ensureCoverageByScale(transform, sourceW, sourceH, seqW, seqH, cfg);
        const scaleRatio = next.scale / 100;
        const scaledW = sourceW * scaleRatio;
        const scaledH = sourceH * scaleRatio;
        const xRange = coverageRange(seqW, scaledW);
        const yRange = coverageRange(seqH, scaledH);
        next.position_x = clamp(Number(next.position_x) || 0, xRange.min, xRange.max);
        next.position_y = clamp(Number(next.position_y) || 0, yRange.min, yRange.max);
        return next;
    }

    function finalizeCoverageTransform(transform, sourceW, sourceH, seqW, seqH, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        let next = {
            ...(transform || {}),
            scale: roundTransformNumber(positiveOrFallback(transform?.scale, 100)),
        };
        for (let attempt = 0; attempt < 5; attempt += 1) {
            next = clampTransformToCoverage(next, sourceW, sourceH, seqW, seqH, cfg);
            next = {
                position_x: roundTransformNumber(next.position_x),
                position_y: roundTransformNumber(next.position_y),
                scale: roundTransformNumber(next.scale),
            };
            next = clampTransformToCoverage(next, sourceW, sourceH, seqW, seqH, cfg);
            const audit = coverageAudit(next, sourceW, sourceH, seqW, seqH);
            if (audit.covered || next.scale >= cfg.maxScalePercent) return next;
            next.scale = Math.min(cfg.maxScalePercent, Math.ceil(next.scale) + 1);
        }
        return clampTransformToCoverage(next, sourceW, sourceH, seqW, seqH, cfg);
    }

    function pointScreenPosition(sourceX, sourceY, transform, sourceW, sourceH, seqW, seqH) {
        const scaleRatio = positiveOrFallback(transform?.scale, 100) / 100;
        return {
            x: (seqW / 2) + (Number(transform?.position_x) || 0) + ((sourceX - (sourceW / 2)) * scaleRatio),
            y: (seqH / 2) + (Number(transform?.position_y) || 0) + ((sourceY - (sourceH / 2)) * scaleRatio),
        };
    }

    function offsetForSourcePointY(sourceY, targetY, scaleRatio, sourceH, seqH) {
        return targetY - (seqH / 2) - ((sourceY - (sourceH / 2)) * scaleRatio);
    }

    function offsetForSourcePointX(sourceX, targetX, scaleRatio, sourceW, seqW) {
        return targetX - (seqW / 2) - ((sourceX - (sourceW / 2)) * scaleRatio);
    }

    function bodySafeOffsetRange(bodyY, scaleRatio, sourceH, seqH, config) {
        const minY = seqH * config.bodySafeMinYRatio;
        const maxY = seqH * config.bodySafeMaxYRatio;
        return {
            min: offsetForSourcePointY(bodyY, minY, scaleRatio, sourceH, seqH),
            max: offsetForSourcePointY(bodyY, maxY, scaleRatio, sourceH, seqH),
        };
    }

    // Mốc/biên dọc cho MẶT trên khung dự án, dưới dạng TỈ LỆ của chiều cao khung.
    //   - Mặt ở nửa TRÊN nguồn: các tỉ lệ này là của CẰM (chinBased) — quy đổi sang tâm mặt
    //     (trừ nửa chiều cao mặt đã phóng) làm ở faceTargetBandPx nơi biết scale thật.
    //   - Mặt ở nửa DƯỚI nguồn: giữ nguyên cách cũ — tỉ lệ của TÂM MẶT.
    function faceCenterTargetRatios(meta, sourceH, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const faceY = finiteOrNull(meta?.face_center_y);
        const isLowerSourceFace = faceY !== null && faceY > sourceH / 2;
        if (isLowerSourceFace) {
            return {
                target: cfg.lowerSourceFaceTargetYRatio,
                minRatio: cfg.lowerSourceFaceTargetMinYRatio,
                maxRatio: cfg.lowerSourceFaceTargetMaxYRatio,
                isLowerSourceFace: true,
                chinBased: false,
            };
        }
        return {
            target: cfg.upperSourceChinTargetRatio,
            minRatio: cfg.upperSourceChinMinRatio,
            maxRatio: cfg.upperSourceChinMaxRatio,
            isLowerSourceFace: false,
            chinBased: true,
        };
    }

    function faceCenterTargetOffsetRange(meta, scaleRatio, sourceH, seqH, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const faceY = finiteOrNull(meta?.face_center_y);
        if (faceY === null) return null;
        const ratios = faceCenterTargetRatios(meta, sourceH, cfg);
        // Dải mục tiêu đã GIAO với lưới an toàn -> tâm mặt không bao giờ rơi ra ngoài lưới.
        const band = faceTargetBandPx(meta, sourceH, seqH, cfg, scaleRatio);
        return {
            min: offsetForSourcePointY(faceY, band.minY, scaleRatio, sourceH, seqH),
            max: offsetForSourcePointY(faceY, band.maxY, scaleRatio, sourceH, seqH),
            ...ratios,
        };
    }

    function faceVisibilityMargin(seqH, config) {
        return clamp(
            seqH * config.faceVisibilityMarginRatio,
            config.faceVisibilityMinMarginPx,
            Math.min(config.faceVisibilityMaxMarginPx, Math.max(0, seqH / 2 - 1)),
        );
    }

    function faceVisibleOffsetRange(meta, scaleRatio, sourceH, seqH, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const faceY = finiteOrNull(meta?.face_center_y);
        const faceHeight = finiteOrNull(meta?.face_height);
        if (faceY === null || !faceHeight || faceHeight <= 1) return null;
        const halfFace = faceHeight / 2;
        const sourceTop = faceY - halfFace;
        const sourceBottom = faceY + halfFace;
        const margin = faceVisibilityMargin(seqH, cfg);
        return {
            min: margin - (seqH / 2) - ((sourceTop - (sourceH / 2)) * scaleRatio),
            max: (seqH - margin) - (seqH / 2) - ((sourceBottom - (sourceH / 2)) * scaleRatio),
            margin,
            sourceTop,
            sourceBottom,
        };
    }

    function faceVisibilityAudit(meta, transform, sourceW, sourceH, seqW, seqH, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const faceY = finiteOrNull(meta?.face_center_y);
        const faceHeight = finiteOrNull(meta?.face_height);
        if (faceY === null || !faceHeight || faceHeight <= 1) {
            return { available: false, visible: true };
        }
        const scaleRatio = positiveOrFallback(transform?.scale, 100) / 100;
        const halfFace = faceHeight / 2;
        const top = pointScreenPosition(sourceW / 2, faceY - halfFace, transform, sourceW, sourceH, seqW, seqH).y;
        const bottom = pointScreenPosition(sourceW / 2, faceY + halfFace, transform, sourceW, sourceH, seqW, seqH).y;
        const margin = faceVisibilityMargin(seqH, cfg);
        return {
            available: true,
            visible: top >= margin - 0.01 && bottom <= seqH - margin + 0.01,
            top,
            bottom,
            margin,
            scaledFaceHeight: faceHeight * scaleRatio,
        };
    }

    function bestCoverageOffsetForRange(preferredOffset, coverage, targetRange) {
        if (!targetRange) return clampToRange(preferredOffset, coverage);
        const overlap = intersectRanges(coverage, targetRange);
        if (overlap) return clampToRange(preferredOffset, overlap);
        if (targetRange.max < coverage.min) return coverage.min;
        if (targetRange.min > coverage.max) return coverage.max;
        return clampToRange(preferredOffset, coverage);
    }

    function preferFaceCenterTargetRange(primaryRange, fallbackRange, targetRange) {
        return intersectRanges(primaryRange, targetRange)
            || intersectRanges(fallbackRange, targetRange)
            || primaryRange
            || fallbackRange;
    }

    function sourceFaceHasUsefulPadding(meta, sourceH) {
        const faceY = finiteOrNull(meta?.face_center_y);
        const faceHeight = finiteOrNull(meta?.face_height);
        if (faceY === null || !faceHeight || faceHeight <= 1) return false;
        const halfFace = faceHeight / 2;
        return faceY - halfFace > 1 && faceY + halfFace < sourceH - 1;
    }

    function ensureFaceVisibilityByScale(transform, meta, sourceW, sourceH, seqW, seqH, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        let next = ensureCoverageByScale(transform, sourceW, sourceH, seqW, seqH, cfg);
        if (!sourceFaceHasUsefulPadding(meta, sourceH)) return next;
        for (let scale = Math.ceil(next.scale); scale <= cfg.maxScalePercent; scale += 1) {
            const scaleRatio = scale / 100;
            const coverage = coverageRange(seqH, sourceH * scaleRatio);
            const faceRange = faceVisibleOffsetRange(meta, scaleRatio, sourceH, seqH, cfg);
            if (intersectRanges(coverage, faceRange)) {
                next.scale = scale;
                return next;
            }
        }
        return next;
    }

    /* ------------------------------------------------------------------------
     * CHỌN SCALE THEO BỐ CỤC (layoutScalePercent)
     *
     * Ràng buộc "không lọt nền" khoá position vào khoảng ±(nguồn*scale - khung)/2.
     * Ở mức phóng vừa đủ phủ khung, khoảng đó bằng 0 theo trục nào mà tỉ lệ trùng nhau
     * -> KHÔNG dịch được -> người không thể về giữa, mặt không thể lên đúng mốc dọc.
     * Đây chính là lý do dự án cùng tỉ lệ với nguồn gần như không được căn khung.
     *
     * Vì vậy phải PHÓNG THÊM để lấy dư địa dịch. Điều kiện đủ để đưa một điểm nguồn
     * `p` (trên trục dài `srcSize`) về đúng vị trí `target` của khung `seqSize`:
     *      scale >= target / p        (đủ hình phía trước điểm đó)
     *      scale >= (seqSize - target) / (srcSize - p)   (đủ hình phía sau)
     * -> scaleToPlacePoint(). Điểm rẻ nhất trong một DẢI mục tiêu nằm ở chỗ hai vế bằng
     * nhau (target = seqSize * p / srcSize), kẹp vào dải.
     *
     * Không dùng thẳng công thức trên làm scale vì có trường hợp KHÔNG BAO GIỜ đạt được
     * (mặt sát mép nguồn) — lúc đó phóng hết cỡ cũng vô ích mà lại cắt mất hình. Nên
     * quét scale từ sàn tới trần, chấm điểm SAI SỐ bố cục thực tế, rồi lấy scale NHỎ NHẤT
     * có sai số gần mức tốt nhất (trong layoutErrorToleranceRatio) -> phóng đúng mức cần.
     * ---------------------------------------------------------------------- */

    // Scale (%) nhỏ nhất để đặt điểm nguồn `srcPos` vào đúng `targetPos` mà không lọt nền.
    // Trả Infinity khi điểm nằm sát mép nguồn (không đời nào đạt được).
    function scaleToPlacePoint(srcPos, srcSize, targetPos, seqSize) {
        const before = Number(srcPos);
        const after = Number(srcSize) - before;
        if (!(before > 0) || !(after > 0)) return Infinity;
        return Math.max(targetPos / before, (seqSize - targetPos) / after) * 100;
    }

    // Trần phóng của Auto-Reframe = sàn phủ khung × maxAutoZoomRatio.
    function autoZoomScaleCap(sourceW, sourceH, seqW, seqH, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const floor = minCoverScalePercent(sourceW, sourceH, seqW, seqH, cfg);
        return clamp(Math.ceil(floor * cfg.maxAutoZoomRatio), floor, cfg.maxScalePercent);
    }

    // Dải Y hợp lệ của TÂM MẶT trên khung dự án: giao của dải mục tiêu theo cấu hình
    // với lưới an toàn (trừ nửa chiều cao mặt để cả khuôn mặt nằm trong lưới).
    // scaleRatio (tuỳ chọn) để trừ NỬA CHIỀU CAO MẶT đã phóng: yêu cầu là cả KHUÔN MẶT
    // nằm trong lưới, không phải chỉ mỗi tâm mặt — cảnh cận mặt rất to sẽ lòi ra khỏi
    // lưới nếu chỉ kẹp tâm. Mặt to hơn cả lưới -> dồn về giữa lưới (tốt nhất có thể).
    function faceTargetBandPx(meta, sourceH, seqH, config = DEFAULT_CONFIG, scaleRatio = null) {
        const cfg = normalizeConfig(config);
        const ratios = faceCenterTargetRatios(meta, sourceH, cfg);
        const faceHeight = finiteOrNull(meta?.face_height);
        const halfFace = (scaleRatio && faceHeight && faceHeight > 1)
            ? (faceHeight * scaleRatio) / 2
            : 0;
        // QUY ĐỔI CẰM -> TÂM MẶT cho mặt nửa trên: mốc/biên là của CẰM, mà cả pipeline làm
        // việc theo TÂM MẶT, nên dịch xuống nửa chiều cao mặt. Dùng nửa cao mặt ĐÃ PHÓNG khi
        // biết scale (lúc đặt vị trí -> cằm CHÍNH XÁC ở 0.55H dù mặt to hay nhỏ); khi KHÔNG
        // biết scale (lúc quét chọn scale) dùng cỡ tham chiếu faceHeightRatio để dải ĐỘC LẬP
        // với scale — nếu không sẽ thành vòng phản hồi trong vòng quét (xem layoutErrorAtScale).
        const chinShift = ratios.chinBased
            ? (halfFace || (seqH * cfg.faceHeightRatio) / 2)
            : 0;
        let minY = seqH * ratios.minRatio - chinShift;
        let maxY = seqH * ratios.maxRatio - chinShift;
        const targetCenter = seqH * ratios.target - chinShift;
        const safeTop = seqH * cfg.safeInsetTop + halfFace;
        const safeBottom = seqH * (1 - cfg.safeInsetBottom) - halfFace;
        if (safeTop < safeBottom) {
            minY = Math.max(minY, safeTop);
            maxY = Math.min(maxY, safeBottom);
            if (minY > maxY) {
                const mid = clamp(targetCenter, safeTop, safeBottom);
                minY = mid;
                maxY = mid;
            }
        } else {
            const mid = (safeTop + safeBottom) / 2;
            minY = mid;
            maxY = mid;
        }
        return { minY, maxY, target: clamp(targetCenter, minY, maxY) };
    }

    // Sai số bố cục tại một mức scale: lệch tâm ngang của thân + lệch mốc dọc của mặt,
    // ĐO SAU KHI đã kẹp position vào vùng không lọt nền (tức sai số THẬT sẽ nhìn thấy).
    function layoutErrorAtScale(meta, payload, scalePercent, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const seqW = positiveOrFallback(payload?.width, 1920);
        const seqH = positiveOrFallback(payload?.height, 1080);
        const { sourceW, sourceH } = sourceSize(meta || {}, payload || {});
        const scaleRatio = scalePercent / 100;
        const bodyX = finiteOrNull(meta?.body_center_x) ?? finiteOrNull(meta?.face_center_x);
        const faceY = finiteOrNull(meta?.face_center_y);

        let error = 0;
        if (bodyX !== null) {
            const xCoverage = coverageRange(seqW, sourceW * scaleRatio);
            const wanted = offsetForSourcePointX(bodyX, seqW / 2, scaleRatio, sourceW, seqW);
            error += Math.abs(wanted - clampToRange(wanted, xCoverage));
        }
        if (faceY !== null) {
            const yCoverage = coverageRange(seqH, sourceH * scaleRatio);
            // CỐ Ý không truyền scaleRatio: dải ở đây phải ĐỘC LẬP với scale. Nếu trừ nửa
            // chiều cao mặt (đại lượng lớn dần theo scale) thì dải co lại đúng lúc ta đang
            // tăng scale để với tới nó -> vòng phản hồi, scan chạy lên tới trần vô nghĩa.
            // Ràng buộc "cả khuôn mặt trong lưới" áp ở bước đặt position, khi scale đã chốt.
            const band = faceTargetBandPx(meta, sourceH, seqH, cfg);
            const wantedMin = offsetForSourcePointY(faceY, band.minY, scaleRatio, sourceH, seqH);
            const wantedMax = offsetForSourcePointY(faceY, band.maxY, scaleRatio, sourceH, seqH);
            const lo = Math.min(wantedMin, wantedMax);
            const hi = Math.max(wantedMin, wantedMax);
            const reachable = intersectRanges(yCoverage, { min: lo, max: hi });
            if (!reachable) {
                const nearest = clampToRange((lo + hi) / 2, yCoverage);
                error += Math.min(Math.abs(nearest - lo), Math.abs(nearest - hi));
            }
        }
        return error;
    }

    /* Sàn/trần scale THẬT của một block.
     *   sàn  = phủ kín khung, và đủ để KHUÔN MẶT nằm trọn trong khung. Mặt lọt ra ngoài
     *          khung là lỗi nặng hơn nhiều so với cắt hình quá tay, nên sàn luôn thắng trần.
     *   trần = mức "trung dung" × maxAutoZoomRatio, trong đó mức trung dung là scale mà
     *          Auto-Reframe dù sao cũng phải dùng: phủ khung + mặt nằm trong khung + mặt
     *          đạt cỡ tham chiếu faceHeightRatio.
     *
     * Vì sao trần KHÔNG tính từ riêng sàn phủ khung: cảnh quay xa có mặt rất nhỏ trong
     * nguồn thì việc phóng lên cho mặt đủ to là mục đích chính của tính năng, không phải
     * "cắt quá tay" — lấy trần từ sàn phủ sẽ chặn mất chính việc đó.
     * Mức tham chiếu dùng faceHeightRatio (hằng số) chứ KHÔNG dùng cỡ mặt chung đã đàm
     * phán giữa các block: cỡ chung lại được tính từ trần -> vòng lặp phụ thuộc.
     */
    function scaleBounds(meta, payload, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const seqW = positiveOrFallback(payload?.width, 1920);
        const seqH = positiveOrFallback(payload?.height, 1080);
        const { sourceW, sourceH } = sourceSize(meta || {}, payload || {});
        const coverFloor = minCoverScalePercent(sourceW, sourceH, seqW, seqH, cfg);
        // Mặt phải nằm trọn trong khung ở CẢ HAI đầu block: nếu chỉ xét khung đầu thì block
        // nào người tiến lại gần về cuối sẽ bị cắt mất mặt ở đoạn cuối.
        const visibilityFloor = [meta, meta?.tail].reduce((acc, sample) => {
            if (!sample) return acc;
            const visible = ensureFaceVisibilityByScale(
                { position_x: 0, position_y: 0, scale: coverFloor },
                sample, sourceW, sourceH, seqW, seqH, cfg,
            );
            return Math.max(acc, positiveOrFallback(visible?.scale, coverFloor));
        }, coverFloor);
        const floor = clamp(Math.max(coverFloor, visibilityFloor),
            cfg.minScalePercent, cfg.maxScalePercent);
        const faceHeight = finiteOrNull(meta?.face_height);
        const refFaceScale = faceHeight && faceHeight > 1
            ? ((seqH * cfg.faceHeightRatio) / faceHeight) * 100
            : 0;
        const neutral = Math.max(floor, refFaceScale);
        const cap = clamp(Math.max(Math.ceil(neutral * cfg.maxAutoZoomRatio), floor),
            cfg.minScalePercent, cfg.maxScalePercent);
        return { floor, cap, neutral };
    }

    // Scale bố cục của MỘT block: nhỏ nhất trong [sàn, trần] mà sai số bố cục
    // không tệ hơn mức tốt nhất quá layoutErrorToleranceRatio × chiều cao khung.
    function layoutScalePercent(meta, payload, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const seqH = positiveOrFallback(payload?.height, 1080);
        const { floor, cap } = scaleBounds(meta, payload, cfg);
        if (cap <= floor) return floor;

        let bestError = Infinity;
        const errors = [];
        for (let scale = floor; scale <= cap; scale += 1) {
            const error = layoutErrorAtScale(meta, payload, scale, cfg);
            errors.push({ scale, error });
            if (error < bestError) bestError = error;
        }
        const tolerance = seqH * cfg.layoutErrorToleranceRatio;
        for (const entry of errors) {
            if (entry.error <= bestError + tolerance) return entry.scale;
        }
        return floor;
    }

    /* ------------------------------------------------------------------------
     * CỠ MẶT CHUNG (computeTargetFaceHeight)
     *
     * Yêu cầu: mặt ở mọi block to bằng nhau. Scale của một block chỉ được phép ĐI LÊN từ
     * scale bố cục của nó (đi xuống là lọt nền / sai bố cục), nên cỡ mặt chung khả thi
     * nhỏ nhất = LỚN NHẤT trong các "cỡ mặt tại scale bố cục" của từng block.
     * Trước đây lấy TRUNG VỊ -> block có mặt to trong nguồn không tài nào thu nhỏ xuống
     * tới trung vị, kết quả là mặt vẫn chênh nhau (đo được 320px vs 481px).
     * Vẫn kẹp sàn ở faceHeightRatio để cảnh quay toàn thân không cho mặt bé tí.
     * ---------------------------------------------------------------------- */
    function computeTargetFaceHeight(items, payload, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const desired = payload.height * cfg.faceHeightRatio;
        let largest = 0;
        for (const item of (Array.isArray(items) ? items : [])) {
            const meta = item?.auto_reframe || item;
            const faceHeight = finiteOrNull(meta?.face_height);
            if (!faceHeight || faceHeight <= 1) continue;
            const bounds = scaleBounds(meta, payload, cfg);
            const scale = layoutScalePercent(meta, payload, cfg);
            // Cỡ mặt chung phải nằm trong tầm với của MỌI block: không đòi cao hơn trần
            // phóng của block này, cũng không thấp hơn cỡ nó buộc phải có ở scale bố cục.
            largest = Math.max(largest, Math.min(faceHeight * (scale / 100), faceHeight * (bounds.cap / 100)));
        }
        if (largest <= 0) return desired;
        return Math.max(desired, largest);
    }

    function calculateTransform(meta, payload, targetFaceHeight, currentTransform = {}, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const seqW = positiveOrFallback(payload?.width, 1920);
        const seqH = positiveOrFallback(payload?.height, 1080);
        const { sourceW, sourceH } = sourceSize(meta || {}, payload || {});
        const faceHeight = finiteOrNull(meta?.face_height);
        const faceScale = faceHeight && faceHeight > 1
            ? targetFaceHeight / faceHeight
            : 0;
        // Scale = lớn nhất của (scale bố cục cần để căn giữa/đúng mốc dọc) và (scale cần
        // để mặt đạt cỡ chung), KẸP trong [sàn, trần] của block -> vừa bám bố cục vừa
        // đồng đều cỡ mặt, mà không cắt hình quá tay.
        const bounds = scaleBounds(meta, payload, cfg);
        const layoutScale = layoutScalePercent(meta, payload, cfg);
        const wantedScale = Math.max(layoutScale, Math.ceil(faceScale * 100 - 0.0001) || 0);
        let transform = {
            position_x: Number(currentTransform?.position_x) || 0,
            position_y: Number(currentTransform?.position_y) || 0,
            scale: clamp(wantedScale, bounds.floor, bounds.cap),
        };

        const scaleRatio = transform.scale / 100;
        const bodyX = finiteOrNull(meta?.body_center_x) ?? finiteOrNull(meta?.face_center_x) ?? (sourceW / 2);
        const bodyY = finiteOrNull(meta?.body_center_y);
        const faceY = finiteOrNull(meta?.face_center_y);

        transform.position_x = offsetForSourcePointX(bodyX, seqW / 2, scaleRatio, sourceW, seqW);

        const yCoverage = coverageRange(seqH, sourceH * scaleRatio);
        const faceRange = faceVisibleOffsetRange(meta, scaleRatio, sourceH, seqH, cfg);
        const faceCoverageRange = intersectRanges(yCoverage, faceRange);
        const faceCenterRange = faceCenterTargetOffsetRange(meta, scaleRatio, sourceH, seqH, cfg);
        if (bodyY !== null) {
            const bodyTarget = seqH * cfg.bodyTargetYRatio;
            const bodyTargetOffset = offsetForSourcePointY(bodyY, bodyTarget, scaleRatio, sourceH, seqH);
            const bodyRange = bodySafeOffsetRange(bodyY, scaleRatio, sourceH, seqH, cfg);
            const bodyCoverageRange = intersectRanges(yCoverage, bodyRange);
            const visibilityBodyRange = faceCoverageRange
                ? (intersectRanges(faceCoverageRange, bodyRange) || faceCoverageRange)
                : bodyCoverageRange;
            const allowedRange = faceY !== null
                ? preferFaceCenterTargetRange(visibilityBodyRange, faceCoverageRange || yCoverage, faceCenterRange)
                : visibilityBodyRange;
            const bodySafeOffset = bodyCoverageRange
                ? clampToRange(bodyTargetOffset, bodyCoverageRange)
                : clampToRange(bodyTargetOffset, yCoverage);

            if (faceY !== null) {
                const faceTarget = faceTargetBandPx(meta, sourceH, seqH, cfg, scaleRatio).target;
                const faceOffset = offsetForSourcePointY(faceY, faceTarget, scaleRatio, sourceH, seqH);
                transform.position_y = allowedRange
                    ? clampToRange(faceOffset, allowedRange)
                    : bestCoverageOffsetForRange(faceOffset, yCoverage, faceRange);
            } else {
                transform.position_y = allowedRange
                    ? clampToRange(bodySafeOffset, allowedRange)
                    : bestCoverageOffsetForRange(bodySafeOffset, yCoverage, faceRange);
            }
        } else if (faceY !== null) {
            // Không có dữ liệu thân -> đặt theo MẶT: dùng chính mốc của faceTargetBandPx (đã
            // quy đổi cằm cho mặt nửa trên, giữ tâm mặt cho mặt nửa dưới).
            const faceOnlyTarget = faceTargetBandPx(meta, sourceH, seqH, cfg, scaleRatio).target;
            const faceOnlyOffset = offsetForSourcePointY(faceY, faceOnlyTarget, scaleRatio, sourceH, seqH);
            const allowedRange = preferFaceCenterTargetRange(faceCoverageRange, yCoverage, faceCenterRange);
            transform.position_y = allowedRange
                ? clampToRange(faceOnlyOffset, allowedRange)
                : bestCoverageOffsetForRange(faceOnlyOffset, yCoverage, faceRange);
        } else {
            transform.position_y = 0;
        }

        transform = finalizeCoverageTransform(transform, sourceW, sourceH, seqW, seqH, cfg);
        transform = nudgeFaceIntoSafeZone(transform, meta, sourceH, seqH, cfg);
        transform = finalizeCoverageTransform(transform, sourceW, sourceH, seqW, seqH, cfg);

        return {
            position_x: roundTransformNumber(transform.position_x),
            position_y: roundTransformNumber(transform.position_y),
            scale: roundTransformNumber(transform.scale),
        };
    }

    // Rà cuối: nếu CẢ khuôn mặt vừa lưới an toàn thì đẩy position_y vào cho vừa (vẫn nằm
    // trong vùng không lọt nền). Chuỗi ưu tiên ở calculateTransform có lúc phải BUÔNG ràng
    // buộc mặt khi nó chọi với body-safe/coverage; đây là lần chỉnh cuối, chỉ đụng position
    // nên không kéo theo phóng thêm. Mặt to hơn cả lưới -> chịu, để nguyên.
    function nudgeFaceIntoSafeZone(transform, meta, sourceH, seqH, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const faceY = finiteOrNull(meta?.face_center_y);
        const faceHeight = finiteOrNull(meta?.face_height);
        if (faceY === null || !faceHeight || faceHeight <= 1) return transform;
        const scaleRatio = positiveOrFallback(transform?.scale, 100) / 100;
        const scaledFace = faceHeight * scaleRatio;
        const safeTop = seqH * cfg.safeInsetTop;
        const safeBottom = seqH * (1 - cfg.safeInsetBottom);
        if (safeBottom - safeTop < scaledFace) return transform;
        const half = scaledFace / 2;
        const first = offsetForSourcePointY(faceY, safeTop + half, scaleRatio, sourceH, seqH);
        const second = offsetForSourcePointY(faceY, safeBottom - half, scaleRatio, sourceH, seqH);
        const wanted = { min: Math.min(first, second), max: Math.max(first, second) };
        const allowed = intersectRanges(coverageRange(seqH, sourceH * scaleRatio), wanted);
        if (!allowed) return transform;
        return { ...transform, position_y: clampToRange(Number(transform.position_y) || 0, allowed) };
    }

    /* =====================================================================
     * KHỚP VỊ TRÍ NGƯỜI TẠI ĐIỂM CẮT (junction continuity)
     *
     * Vấn đề: mỗi block dùng MỘT transform tĩnh. Trong block, người di chuyển nên mặt
     * trôi dần (mượt, không sao). Nhưng TẠI ĐIỂM CẮT, mặt nhảy từ chỗ nó trôi tới ở cuối
     * block N sang chỗ transform của block N+1 đặt nó -> cảm giác giật khung.
     *
     * Cách giải: dịch position của các block sao cho
     *     vị trí mặt ở KHUNG CUỐI block N  ==  vị trí mặt ở KHUNG ĐẦU block N+1
     * (toạ độ trên khung dự án). Vì position vào công thức một cách TUYẾN TÍNH, đây là
     * bài toán bình phương tối thiểu 1 chiều theo từng trục, có ràng buộc hộp:
     *
     *   E = Σ wc·(p_i − b_i)²  +  Σ wj·((p_i + aT_i) − (p_{i+1} + aH_{i+1}))²
     *
     *   b_i  = position mà bộ giải TỪNG BLOCK (calculateTransform) đã chọn — tức đã gói
     *          sẵn toàn bộ ràng buộc bố cục cũ. Dùng nó làm mốc "kéo về" nên KHÔNG phải
     *          dựng lại chuỗi ưu tiên, và tắt tính năng này là quay về đúng hành vi cũ.
     *   aH_i = (điểm mặt khung ĐẦU − nguồn/2)·scale_i     (đóng góp của mẫu vào vị trí)
     *   aT_i = (điểm mặt khung CUỐI − nguồn/2)·scale_i
     *
     * Giải bằng Gauss-Seidel có KẸP HỘP mỗi bước: hộp = vùng không lọt nền ∩ vùng giữ mặt
     * trong khung ∩ vùng giữ mặt trong lưới an toàn. Nhờ kẹp trong vòng lặp, ràng buộc
     * CỨNG không bao giờ bị vi phạm dù nghiệm tối ưu có nằm ngoài.
     * ===================================================================== */

    // Điểm được "khớp" trên mỗi trục: trục ngang lấy tâm THÂN (như bộ giải cũ), trục dọc
    // lấy tâm MẶT (mắt người bám theo mặt). Thiếu thì lùi dần sang field còn lại.
    function junctionPoint(sample, axis, sourceW, sourceH) {
        if (!sample) return null;
        if (axis === 'x') {
            return finiteOrNull(sample.body_center_x)
                ?? finiteOrNull(sample.face_center_x);
        }
        return finiteOrNull(sample.face_center_y)
            ?? finiteOrNull(sample.body_center_y);
    }

    // Hộp giá trị position hợp lệ của một block trên một trục.
    function positionBoxForAxis(meta, payload, scalePercent, axis, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const seqW = positiveOrFallback(payload?.width, 1920);
        const seqH = positiveOrFallback(payload?.height, 1080);
        const { sourceW, sourceH } = sourceSize(meta || {}, payload || {});
        const scaleRatio = positiveOrFallback(scalePercent, 100) / 100;
        if (axis === 'x') {
            const coverage = coverageRange(seqW, sourceW * scaleRatio);
            const faceX = finiteOrNull(meta?.face_center_x) ?? finiteOrNull(meta?.body_center_x);
            if (faceX === null) return coverage;
            // Tâm mặt phải nằm trong lưới an toàn theo trục ngang.
            const first = offsetForSourcePointX(faceX, seqW * cfg.safeInsetLeft, scaleRatio, sourceW, seqW);
            const second = offsetForSourcePointX(faceX, seqW * (1 - cfg.safeInsetRight), scaleRatio, sourceW, seqW);
            const safe = { min: Math.min(first, second), max: Math.max(first, second) };
            return intersectRanges(coverage, safe) || coverage;
        }
        const coverage = coverageRange(seqH, sourceH * scaleRatio);
        let box = coverage;
        const visible = faceVisibleOffsetRange(meta, scaleRatio, sourceH, seqH, cfg);
        box = intersectRanges(box, visible) || box;
        const faceY = finiteOrNull(meta?.face_center_y);
        const faceHeight = finiteOrNull(meta?.face_height);
        if (faceY !== null && faceHeight && faceHeight > 1) {
            const half = (faceHeight * scaleRatio) / 2;
            const safeTop = seqH * cfg.safeInsetTop + half;
            const safeBottom = seqH * (1 - cfg.safeInsetBottom) - half;
            if (safeTop <= safeBottom) {
                const first = offsetForSourcePointY(faceY, safeTop, scaleRatio, sourceH, seqH);
                const second = offsetForSourcePointY(faceY, safeBottom, scaleRatio, sourceH, seqH);
                const safe = { min: Math.min(first, second), max: Math.max(first, second) };
                box = intersectRanges(box, safe) || box;
            }
        }
        return box;
    }

    // Vị trí (trên khung dự án) của điểm được khớp, tại một đầu block.
    function junctionScreenPos(entry, axis, which) {
        if (!entry || !entry.point || entry.point[which] === null) return null;
        const seqSize = axis === 'x' ? entry.seqW : entry.seqH;
        const srcSize = axis === 'x' ? entry.sourceW : entry.sourceH;
        return (seqSize / 2) + entry.position + ((entry.point[which] - (srcSize / 2)) * entry.scaleRatio);
    }

    /* Giải cả chuỗi block. `entries` = [{ meta, transform, fixed }] theo ĐÚNG thứ tự phát.
     *   - meta.tail : mẫu khung cuối (sidecar v3). Thiếu -> dùng lại mẫu khung đầu.
     *   - fixed=true: block người dùng đã chỉnh tay -> position GIỮ NGUYÊN, chỉ làm mốc neo.
     * Trả về [{position_x, position_y, scale}] cùng chỉ số với entries (null nếu bỏ qua).
     */
    function solveJunctionContinuity(entries, payload, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const list = Array.isArray(entries) ? entries : [];
        const seqW = positiveOrFallback(payload?.width, 1920);
        const seqH = positiveOrFallback(payload?.height, 1080);
        const wc = Math.max(0.0001, cfg.junctionCompositionWeight);
        const wj = Math.max(0, cfg.junctionMatchWeight);

        const nodes = list.map((entry) => {
            const meta = entry?.meta || null;
            const transform = entry?.transform || null;
            if (!meta || !transform) return null;
            const { sourceW, sourceH } = sourceSize(meta, payload);
            const scaleRatio = positiveOrFallback(transform.scale, 100) / 100;
            const head = meta;
            const tail = meta.tail && meta.tail.detected === true ? meta.tail : meta;
            const usable = meta.detected === true;
            return {
                fixed: entry.fixed === true,
                usable,
                seqW, seqH, sourceW, sourceH, scaleRatio,
                meta, transform,
                scalePercent: positiveOrFallback(transform.scale, 100),
                point: {
                    x: { head: junctionPoint(head, 'x', sourceW, sourceH), tail: junctionPoint(tail, 'x', sourceW, sourceH) },
                    y: { head: junctionPoint(head, 'y', sourceW, sourceH), tail: junctionPoint(tail, 'y', sourceW, sourceH) },
                },
            };
        });

        ['x', 'y'].forEach((axis) => {
            const field = axis === 'x' ? 'position_x' : 'position_y';
            const seqSize = axis === 'x' ? seqW : seqH;
            const state = nodes.map((node) => {
                if (!node) return null;
                const baseline = Number(node.transform[field]) || 0;
                const box = positionBoxForAxis(node.meta, payload, node.scalePercent, axis, cfg);
                const srcSize = axis === 'x' ? node.sourceW : node.sourceH;
                const pts = node.point[axis];
                const aHead = pts.head === null ? null : (pts.head - (srcSize / 2)) * node.scaleRatio;
                const aTail = pts.tail === null ? null : (pts.tail - (srcSize / 2)) * node.scaleRatio;
                // `baseline` từ bộ giải từng block ghim điểm ở khung ĐẦU vào mốc bố cục:
                //     baseline = mốc − seq/2 − aHead.
                // Muốn ghim ĐIỂM GIỮA đường đi thay vào đó thì chỉ cần dịch một lượng
                // (aHead − aTail)/2 — không phải dựng lại chuỗi ưu tiên bố cục nào cả.
                const anchored = (cfg.junctionAnchor === 'travel-mid' && aHead !== null && aTail !== null)
                    ? baseline + ((aHead - aTail) / 2)
                    : baseline;
                return {
                    node,
                    baseline: clampToRange(anchored, box),
                    box,
                    p: clampToRange(anchored, box),
                    aHead,
                    aTail,
                };
            });

            // Cạnh nối: chỉ giữa 2 block LIỀN KỀ mà cả hai đều có điểm để khớp.
            const linkable = (i) => {
                const a = state[i];
                const b = state[i + 1];
                return !!(a && b && a.node.usable && b.node.usable && a.aTail !== null && b.aHead !== null);
            };

            for (let sweep = 0; sweep < 60; sweep += 1) {
                const forward = sweep % 2 === 0;
                for (let step = 0; step < state.length; step += 1) {
                    const i = forward ? step : state.length - 1 - step;
                    const cur = state[i];
                    if (!cur || cur.node.fixed) continue;
                    const hasNext = linkable(i);
                    const hasPrev = i > 0 && linkable(i - 1);
                    if (!hasNext && !hasPrev) {
                        cur.p = clampToRange(cur.baseline, cur.box);
                        continue;
                    }
                    let numerator = wc * cur.baseline;
                    let denominator = wc;
                    if (hasNext) {
                        const nxt = state[i + 1];
                        numerator += wj * (nxt.p + nxt.aHead - cur.aTail);
                        denominator += wj;
                    }
                    if (hasPrev) {
                        const prv = state[i - 1];
                        numerator += wj * (prv.p + prv.aTail - cur.aHead);
                        denominator += wj;
                    }
                    cur.p = clampToRange(numerator / denominator, cur.box);
                }
            }

            state.forEach((entry) => {
                if (!entry || entry.node.fixed) return;
                entry.node.transform = { ...entry.node.transform, [field]: entry.p };
                entry.node.position = entry.p;
            });
            // Lưu lại để đo sai số khớp sau khi giải (dùng cho báo trạng thái).
            nodes.forEach((node, i) => {
                if (!node || !state[i]) return;
                node[`solved_${axis}`] = state[i];
            });
        });

        return nodes.map((node) => {
            if (!node) return null;
            const { sourceW, sourceH } = sourceSize(node.meta, payload);
            const finalized = finalizeCoverageTransform(node.transform, sourceW, sourceH, seqW, seqH, cfg);
            return {
                position_x: roundTransformNumber(finalized.position_x),
                position_y: roundTransformNumber(finalized.position_y),
                scale: roundTransformNumber(finalized.scale),
            };
        });
    }

    /* Sai số khớp tại từng điểm cắt, tính TỪ transform cuối cùng — dùng để báo cho người
     * dùng và để test đo được. Trả [{index, dx, dy, distance}] cho mỗi cặp block liền kề
     * mà cả hai đều nhận diện được người. */
    function junctionMismatches(entries, payload, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const list = Array.isArray(entries) ? entries : [];
        const seqW = positiveOrFallback(payload?.width, 1920);
        const seqH = positiveOrFallback(payload?.height, 1080);
        const build = (entry) => {
            const meta = entry?.meta;
            const transform = entry?.transform;
            if (!meta || !transform || meta.detected !== true) return null;
            const { sourceW, sourceH } = sourceSize(meta, payload);
            const tail = meta.tail && meta.tail.detected === true ? meta.tail : meta;
            return {
                seqW, seqH, sourceW, sourceH,
                scaleRatio: positiveOrFallback(transform.scale, 100) / 100,
                position_x: Number(transform.position_x) || 0,
                position_y: Number(transform.position_y) || 0,
                headX: junctionPoint(meta, 'x', sourceW, sourceH),
                headY: junctionPoint(meta, 'y', sourceW, sourceH),
                tailX: junctionPoint(tail, 'x', sourceW, sourceH),
                tailY: junctionPoint(tail, 'y', sourceW, sourceH),
            };
        };
        const out = [];
        for (let i = 0; i < list.length - 1; i += 1) {
            const a = build(list[i]);
            const b = build(list[i + 1]);
            if (!a || !b) continue;
            if (a.tailX === null || b.headX === null || a.tailY === null || b.headY === null) continue;
            const ax = (a.seqW / 2) + a.position_x + ((a.tailX - (a.sourceW / 2)) * a.scaleRatio);
            const bx = (b.seqW / 2) + b.position_x + ((b.headX - (b.sourceW / 2)) * b.scaleRatio);
            const ay = (a.seqH / 2) + a.position_y + ((a.tailY - (a.sourceH / 2)) * a.scaleRatio);
            const by = (b.seqH / 2) + b.position_y + ((b.headY - (b.sourceH / 2)) * b.scaleRatio);
            const dx = bx - ax;
            const dy = by - ay;
            out.push({ index: i, dx, dy, distance: Math.hypot(dx, dy) });
        }
        return out;
    }

    function calculateDefaultCoverTransform(payload, config = DEFAULT_CONFIG) {
        const cfg = normalizeConfig(config);
        const seqW = positiveOrFallback(payload?.width, 1920);
        const seqH = positiveOrFallback(payload?.height, 1080);
        const sourceW = positiveOrFallback(payload?.source_width, seqW);
        const sourceH = positiveOrFallback(payload?.source_height, seqH);
        const transform = finalizeCoverageTransform({
            position_x: 0,
            position_y: 0,
            scale: minCoverScalePercent(sourceW, sourceH, seqW, seqH, cfg),
        }, sourceW, sourceH, seqW, seqH, cfg);
        return {
            position_x: roundTransformNumber(transform.position_x),
            position_y: roundTransformNumber(transform.position_y),
            scale: roundTransformNumber(transform.scale),
        };
    }

    return {
        DEFAULT_CONFIG,
        autoZoomScaleCap,
        calculateDefaultCoverTransform,
        calculateTransform,
        faceTargetBandPx,
        junctionMismatches,
        layoutScalePercent,
        positionBoxForAxis,
        scaleToPlacePoint,
        solveJunctionContinuity,
        clampTransformToCoverage,
        computeTargetFaceHeight,
        coverageAudit,
        ensureFaceVisibilityByScale,
        ensureCoverageByScale,
        faceCenterTargetOffsetRange,
        faceCenterTargetRatios,
        faceVisibilityAudit,
        faceVisibleOffsetRange,
        getScaledRect,
        hasFullCoverage,
        minCoverScalePercent,
        pointScreenPosition,
        sourceSize,
    };
});
