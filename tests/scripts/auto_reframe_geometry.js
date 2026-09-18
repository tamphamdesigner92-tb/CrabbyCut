const assert = require('assert');
const path = require('path');

const geometry = require(path.join(__dirname, '..', '..', 'static', 'js', 'auto-reframe-geometry.js'));

function assertCoverage(label, transform, meta, payload) {
  const { sourceW, sourceH } = geometry.sourceSize(meta || {}, payload);
  const rect = geometry.getScaledRect(transform, sourceW, sourceH, payload.width, payload.height);
  const audit = geometry.coverageAudit(transform, sourceW, sourceH, payload.width, payload.height);
  assert.ok(audit.covered, `${label} does not cover sequence: ${JSON.stringify({ transform, rect, payload })}`);
  return { rect, sourceW, sourceH };
}

function calculate(label, meta, payload, targetFaceHeight = payload.height * 0.16) {
  const transform = geometry.calculateTransform(meta, payload, targetFaceHeight, {}, geometry.DEFAULT_CONFIG);
  assertCoverage(label, transform, meta, payload);
  return transform;
}

function assertBodyCenterX(label, transform, meta, payload, tolerancePx = 2) {
  const { sourceW, sourceH } = geometry.sourceSize(meta, payload);
  const body = geometry.pointScreenPosition(
    meta.body_center_x,
    meta.body_center_y || payload.source_height / 2,
    transform,
    sourceW,
    sourceH,
    payload.width,
    payload.height,
  );
  assert.ok(Math.abs(body.x - payload.width / 2) <= tolerancePx, `${label} body x is not centered: ${body.x}`);
  return body;
}

function assertBodySafeY(label, body, payload) {
  const minY = payload.height * geometry.DEFAULT_CONFIG.bodySafeMinYRatio;
  const maxY = payload.height * geometry.DEFAULT_CONFIG.bodySafeMaxYRatio;
  assert.ok(body.y >= minY - 1 && body.y <= maxY + 1, `${label} body y is outside safe range: ${body.y}`);
}

function assertFaceVisible(label, transform, meta, payload) {
  const { sourceW, sourceH } = geometry.sourceSize(meta, payload);
  const audit = geometry.faceVisibilityAudit(meta, transform, sourceW, sourceH, payload.width, payload.height, geometry.DEFAULT_CONFIG);
  assert.ok(audit.available, `${label} face audit is not available`);
  assert.ok(audit.visible, `${label} face is not visible: ${JSON.stringify({ transform, audit, payload })}`);
  return audit;
}

// Mặt ở nửa TRÊN nguồn giờ neo theo CẰM (người dùng chốt 2026-08-04): cằm phải nằm trong
// dải cằm [upperSourceChinMinRatio, upperSourceChinMaxRatio]×H, quanh mốc 0.55H. Kiểm điểm
// CẰM = face_center_y + face_height/2 trên màn hình.
function assertChinInTargetBand(label, transform, meta, payload) {
  const { sourceW, sourceH } = geometry.sourceSize(meta, payload);
  const chin = geometry.pointScreenPosition(
    meta.face_center_x || sourceW / 2,
    meta.face_center_y + (meta.face_height || 0) / 2,
    transform,
    sourceW,
    sourceH,
    payload.width,
    payload.height,
  );
  const minY = payload.height * geometry.DEFAULT_CONFIG.upperSourceChinMinRatio;
  const maxY = payload.height * geometry.DEFAULT_CONFIG.upperSourceChinMaxRatio;
  assert.ok(
    chin.y >= minY - 1 && chin.y <= maxY + 1,
    `${label} chin is outside target band: ${JSON.stringify({ chin, minY, maxY, transform })}`,
  );
  return chin;
}

function assertFaceCenterInMiddleBand(label, transform, meta, payload) {
  const { sourceW, sourceH } = geometry.sourceSize(meta, payload);
  const face = geometry.pointScreenPosition(
    meta.face_center_x || sourceW / 2,
    meta.face_center_y,
    transform,
    sourceW,
    sourceH,
    payload.width,
    payload.height,
  );
  const minY = payload.height * geometry.DEFAULT_CONFIG.lowerSourceFaceTargetMinYRatio;
  const maxY = payload.height * geometry.DEFAULT_CONFIG.lowerSourceFaceTargetMaxYRatio;
  assert.ok(
    face.y >= minY - 1 && face.y <= maxY + 1,
    `${label} lower-source face center is outside middle band: ${JSON.stringify({ face, minY, maxY, transform })}`,
  );
  return face;
}

function main() {
  {
    const payload = { width: 654, height: 1162, source_width: 1114, source_height: 2010 };
    const meta = {
      auto_reframe_version: 2,
      coordinate_space: 'render',
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      source_width: 1114,
      source_height: 2010,
      body_center_x: 557,
      body_center_y: 1480,
      face_center_x: 557,
      face_center_y: 1360,
      face_height: 170,
    };
    const transform = calculate('portrait lower-face', meta, payload);
    const body = assertBodyCenterX('portrait lower-face', transform, meta, payload);
    assert.ok(body.y >= -payload.height && body.y <= payload.height * 2, `body should remain near visible area: ${body.y}`);
    assertFaceVisible('portrait lower-face', transform, meta, payload);
    assertFaceCenterInMiddleBand('portrait lower-face', transform, meta, payload);
  }

  {
    const payload = { width: 654, height: 1162, source_width: 1114, source_height: 2010 };
    const meta = {
      auto_reframe_version: 2,
      coordinate_space: 'render',
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      source_width: 1114,
      source_height: 2010,
      body_center_x: 557,
      body_center_y: 840,
      face_center_x: 557,
      face_center_y: 620,
      face_height: 170,
    };
    const transform = calculate('portrait upper-face', meta, payload);
    const body = assertBodyCenterX('portrait upper-face', transform, meta, payload);
    assertBodySafeY('portrait upper-face', body, payload);
  }

  {
    const payload = { width: 654, height: 1162, source_width: 1114, source_height: 2010 };
    const meta = {
      auto_reframe_version: 2,
      coordinate_space: 'render',
      detected: true,
      status: 'ready',
      frame_width: 2010,
      frame_height: 1114,
      source_width: 1114,
      source_height: 2010,
      body_center_x: 557,
      body_center_y: 1480,
      face_center_x: 557,
      face_center_y: 1360,
      face_height: 170,
    };
    const transform = calculate('swapped detector frame uses render source size', meta, payload);
    const { sourceW, sourceH } = geometry.sourceSize(meta, payload);
    assert.strictEqual(sourceW, 1114);
    assert.strictEqual(sourceH, 2010);
    const body = assertBodyCenterX('swapped detector frame uses render source size', transform, meta, payload);
    assert.ok(body.y >= -payload.height && body.y <= payload.height * 2, `body should remain near visible area: ${body.y}`);
    assertFaceVisible('swapped detector frame uses render source size', transform, meta, payload);
    assertFaceCenterInMiddleBand('swapped detector frame uses render source size', transform, meta, payload);
  }

  {
    const payload = { width: 1080, height: 1920, source_width: 1920, source_height: 1080 };
    const meta = {
      detected: true,
      status: 'ready',
      frame_width: 1920,
      frame_height: 1080,
      body_center_x: 960,
      body_center_y: 560,
      face_center_x: 960,
      face_center_y: 360,
      face_height: 120,
    };
    const transform = calculate('landscape to portrait', meta, payload);
    assertBodyCenterX('landscape to portrait', transform, meta, payload);
  }

  {
    const payload = { width: 1080, height: 1080, source_width: 1114, source_height: 2010 };
    const meta = {
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      body_center_x: 557,
      body_center_y: 1450,
      face_center_x: 557,
      face_center_y: 1280,
      face_height: 160,
    };
    const transform = calculate('portrait to square', meta, payload);
    assertBodyCenterX('portrait to square', transform, meta, payload);
  }

  {
    const payload = { width: 2010, height: 1114, source_width: 1114, source_height: 2010 };
    const meta = {
      auto_reframe_version: 2,
      coordinate_space: 'render',
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      source_width: 1114,
      source_height: 2010,
      body_center_x: 557,
      body_center_y: 1480,
      face_center_x: 557,
      face_center_y: 1360,
      face_height: 170,
    };
    const transform = calculate('portrait source to landscape sequence lower-face', meta, payload);
    const body = assertBodyCenterX('portrait source to landscape sequence lower-face', transform, meta, payload);
    assert.ok(body.y >= -payload.height && body.y <= payload.height * 2, `body should remain near visible area: ${body.y}`);
    assertFaceVisible('portrait source to landscape sequence lower-face', transform, meta, payload);
    assertFaceCenterInMiddleBand('portrait source to landscape sequence lower-face', transform, meta, payload);
  }

  {
    const payload = { width: 2010, height: 1114, source_width: 1114, source_height: 2010 };
    const meta = {
      auto_reframe_version: 2,
      coordinate_space: 'render',
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      source_width: 1114,
      source_height: 2010,
      body_center_x: 557,
      body_center_y: 800,
      face_center_x: 557,
      face_center_y: 1900,
      face_height: 170,
    };
    const transform = calculate('face visibility wins over body safe y', meta, payload);
    assertFaceVisible('face visibility wins over body safe y', transform, meta, payload);
  }

  {
    const payload = { width: 2010, height: 1114, source_width: 1114, source_height: 2010 };
    const meta = {
      auto_reframe_version: 2,
      coordinate_space: 'render',
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      source_width: 1114,
      source_height: 2010,
      body_center_x: 557,
      body_center_y: 800,
      face_center_x: 557,
      face_center_y: 1360,
      face_height: 170,
    };
    const transform = calculate('face target band wins over body safe when possible', meta, payload);
    assertFaceVisible('face target band wins over body safe when possible', transform, meta, payload);
    assertFaceCenterInMiddleBand('face target band wins over body safe when possible', transform, meta, payload);
  }

  {
    const payload = { width: 2010, height: 1114, source_width: 1114, source_height: 2010 };
    const meta = {
      auto_reframe_version: 2,
      coordinate_space: 'render',
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      source_width: 1114,
      source_height: 2010,
      body_center_x: 557,
      body_center_y: 780,
      face_center_x: 557,
      face_center_y: 620,
      face_height: 170,
    };
    const transform = calculate('upper-source face anchors chin ~5% below middle', meta, payload);
    assertFaceVisible('upper-source face anchors chin ~5% below middle', transform, meta, payload);
    assertChinInTargetBand('upper-source face anchors chin ~5% below middle', transform, meta, payload);
  }

  {
    const payload = { width: 2010, height: 1114, source_width: 1114, source_height: 2010 };
    const meta = {
      auto_reframe_version: 2,
      coordinate_space: 'render',
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      source_width: 1114,
      source_height: 2010,
      face_center_x: 557,
      face_center_y: 1900,
      face_height: 170,
    };
    const transform = calculate('face-only portrait source to landscape sequence', meta, payload);
    assertFaceVisible('face-only portrait source to landscape sequence', transform, meta, payload);
  }

  {
    const payload = { width: 2010, height: 1114, source_width: 1114, source_height: 2010 };
    const meta = {
      auto_reframe_version: 2,
      coordinate_space: 'render',
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      source_width: 1114,
      source_height: 2010,
      face_center_x: 557,
      face_center_y: 1360,
      face_height: 170,
    };
    const transform = calculate('face-only target band when possible', meta, payload);
    assertFaceVisible('face-only target band when possible', transform, meta, payload);
    assertFaceCenterInMiddleBand('face-only target band when possible', transform, meta, payload);
  }

  {
    const payload = { width: 2010, height: 1114, source_width: 1114, source_height: 2010 };
    const meta = {
      auto_reframe_version: 2,
      coordinate_space: 'render',
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      source_width: 1114,
      source_height: 2010,
      face_center_x: 557,
      face_center_y: 2000,
      face_height: 220,
    };
    const transform = calculate('source-clipped face best effort no background leak', meta, payload);
    const audit = assertCoverage('source-clipped face best effort no background leak', transform, meta, payload);
    assert.ok(audit.rect.top <= 0 && audit.rect.bottom >= payload.height, 'coverage should still be absolute');
  }

  {
    const payload = { width: 1080, height: 1920, source_width: 1114, source_height: 2010 };
    for (const [label, bodyX] of [['person left', 260], ['person right', 860]]) {
      const meta = {
        detected: true,
        status: 'ready',
        frame_width: 1114,
        frame_height: 2010,
        body_center_x: bodyX,
        body_center_y: 1260,
        face_center_x: bodyX,
        face_center_y: 1050,
        face_height: 150,
      };
      const transform = calculate(label, meta, payload);
      const body = assertBodyCenterX(label, transform, meta, payload, 25);
      assertBodySafeY(label, body, payload);
    }
  }

  {
    const payload = { width: 654, height: 1162, source_width: 1114, source_height: 2010 };
    const meta = {
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      face_center_x: 600,
      face_center_y: 1460,
      face_height: 180,
    };
    const transform = calculate('face-only lower-face', meta, payload);
    assertCoverage('face-only lower-face', transform, meta, payload);
  }

  {
    const payload = { width: 1080, height: 1920, source_width: 1920, source_height: 1080 };
    const transform = geometry.calculateDefaultCoverTransform(payload, geometry.DEFAULT_CONFIG);
    assertCoverage('no person default cover', transform, {}, payload);
  }

  {
    const meta = {
      auto_reframe_version: 2,
      coordinate_space: 'render',
      detected: true,
      status: 'ready',
      frame_width: 1114,
      frame_height: 2010,
      source_width: 1114,
      source_height: 2010,
      body_center_x: 557,
      body_center_y: 1480,
      face_center_x: 557,
      face_center_y: 1360,
      face_height: 170,
    };
    const portrait = { width: 654, height: 1162, source_width: 1114, source_height: 2010 };
    const square = { width: 1080, height: 1080, source_width: 1114, source_height: 2010 };
    const landscape = { width: 2010, height: 1114, source_width: 1114, source_height: 2010 };
    const portraitTransform = calculate('sequence resize portrait', meta, portrait);
    const squareTransform = calculate('sequence resize square', meta, square);
    const landscapeTransform = calculate('sequence resize landscape', meta, landscape);
    assert.notDeepStrictEqual(portraitTransform, squareTransform, 'sequence resize should recalculate transform');
    assert.notDeepStrictEqual(portraitTransform, landscapeTransform, 'landscape sequence resize should recalculate transform');
    assertFaceVisible('sequence resize landscape', landscapeTransform, meta, landscape);
    assertFaceCenterInMiddleBand('sequence resize landscape', landscapeTransform, meta, landscape);
  }

  // ---- KHỚP VỊ TRÍ NGƯỜI TẠI ĐIỂM CẮT (mẫu khung đầu + khung cuối mỗi block) ----
  // Bất biến cần giữ: giải chuỗi phải LÀM GIẢM sai số tại điểm cắt, KHÔNG đổi scale (đổi
  // là cỡ mặt lại lệch), KHÔNG lọt nền, và block người dùng chỉnh tay phải giữ nguyên.
  {
    const payload = { width: 1080, height: 1920, source_width: 1920, source_height: 1080 };
    const block = (headX, headY, headFaceH, tailX, tailY, tailFaceH) => ({
      coordinate_space: 'render', source_width: 1920, source_height: 1080,
      detected: true, status: 'ready',
      body_center_x: headX, body_center_y: Math.min(1079, headY + headFaceH * 2),
      face_center_x: headX, face_center_y: headY, face_height: headFaceH,
      tail: {
        detected: true,
        body_center_x: tailX, body_center_y: Math.min(1079, tailY + tailFaceH * 2),
        face_center_x: tailX, face_center_y: tailY, face_height: tailFaceH,
      },
    });
    const metas = [
      block(880, 300, 159, 1010, 305, 160),
      block(1030, 308, 158, 900, 300, 157),
      block(905, 302, 160, 1020, 306, 159),
      block(1015, 305, 158, 890, 300, 158),
    ];
    const targetFaceHeight = geometry.computeTargetFaceHeight(metas.map((m) => ({ auto_reframe: m })), payload);
    const baseline = metas.map((m) => geometry.calculateTransform(m, payload, targetFaceHeight, {}, geometry.DEFAULT_CONFIG));
    const worst = (list) => (list.length ? Math.max(...list.map((j) => j.distance)) : 0);
    const before = worst(geometry.junctionMismatches(
      metas.map((m, i) => ({ meta: m, transform: baseline[i] })), payload, geometry.DEFAULT_CONFIG));

    const solved = geometry.solveJunctionContinuity(
      metas.map((m, i) => ({ meta: m, transform: { ...baseline[i] }, fixed: false })),
      payload, geometry.DEFAULT_CONFIG);
    const after = worst(geometry.junctionMismatches(
      metas.map((m, i) => ({ meta: m, transform: solved[i] })), payload, geometry.DEFAULT_CONFIG));

    assert.ok(after < before, `junction solve should reduce mismatch: ${before} -> ${after}`);
    assert.ok(after <= payload.width * 0.03, `junction mismatch should be under 3% of width: ${after}`);
    solved.forEach((transform, i) => {
      assert.strictEqual(transform.scale, baseline[i].scale, `junction solve must not change scale of block ${i}`);
      assertCoverage(`junction block ${i}`, transform, metas[i], payload);
      assertFaceVisible(`junction block ${i}`, transform, metas[i], payload);
    });

    // Thiếu mẫu khung cuối (sidecar cũ / không dò được) -> vẫn ra transform hợp lệ.
    const noTail = metas.map((m) => ({ ...m, tail: null }));
    const solvedNoTail = geometry.solveJunctionContinuity(
      noTail.map((m, i) => ({ meta: m, transform: { ...baseline[i] }, fixed: false })),
      payload, geometry.DEFAULT_CONFIG);
    solvedNoTail.forEach((transform, i) => {
      assertCoverage(`junction no-tail block ${i}`, transform, noTail[i], payload);
    });

    // Block đã chỉnh tay = mốc neo: position giữ nguyên tuyệt đối.
    const anchored = { ...baseline[2], position_x: 300, position_y: 50 };
    const withAnchor = geometry.solveJunctionContinuity(
      metas.map((m, i) => ({ meta: m, transform: i === 2 ? { ...anchored } : { ...baseline[i] }, fixed: i === 2 })),
      payload, geometry.DEFAULT_CONFIG);
    assert.strictEqual(withAnchor[2].position_x, 300, 'fixed block must keep position_x');
    assert.strictEqual(withAnchor[2].position_y, 50, 'fixed block must keep position_y');
  }

  console.log('auto reframe geometry ok');
}

main();
