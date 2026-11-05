// S-05 · Mưa trên phố đêm (lofi 2D, lặp liền mạch) — GeoCode JavaScript canvas
// Khung 1080×1920, video 10 s, 30 fps, loop: true; block kéo dài 26 s (giây 2 → 28) bằng block_duration.
// Lặp liền mạch: MỌI chu kỳ đều chia hết LOOP = 10 s (mưa rơi đúng số vòng nguyên, đèn nhấp nháy 2 s/5 s,
// gợn nước 1 s). Khung t = 0 và t = 10 giống hệt nhau. Ngẫu nhiên có seed cố định.
// Nền là chủ ý (lớp nền). Mưa có thể tách ra lớp riêng trong suốt nếu muốn chỉnh độ dày mưa bằng opacity.

const LOOP = 10;
const RAIN_DENSITY = 260;        // số hạt mưa ← dễ vá: "mưa nặng hạt hơn"

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(1107);
// Toà nhà: 2 lớp xa/gần
const BUILD = [0, 1].map((layer) => {
  const out = []; let x = -40;
  while (x < 1120) {
    const w = 120 + R() * 140, h = (layer ? 380 : 620) + R() * (layer ? 300 : 360);
    const wins = [];
    for (let wy = 40; wy < h - 60; wy += 58) for (let wx = 22; wx < w - 30; wx += 44)
      if (R() < 0.22) wins.push({ x: wx, y: wy, blink: R() < 0.12 ? (R() < 0.5 ? 2 : 5) : 0, ph: R(), warm: R() < 0.7 });
    out.push({ x, w, h, wins }); x += w + 6 + R() * 20;
  }
  return out;
});
// Hạt mưa: mỗi hạt rơi đúng `laps` vòng trong LOOP giây → lặp khít
const DROPS = Array.from({ length: 400 }, () => ({ x: R(), ph: R(), laps: 6 + Math.floor(R() * 6), len: 30 + R() * 40, a: 0.25 + R() * 0.45 }));
const RIPPLES = Array.from({ length: 26 }, () => ({ x: R(), y: R(), ph: R() }));
const SIGN = { x: 0.62, y: 0.47, text: 'CRABBY CAFE' };

function draw(ctx, t, W, H) {
  const street = H * 0.70;
  const sky = ctx.createLinearGradient(0, 0, 0, street);
  sky.addColorStop(0, '#0b0d1f'); sky.addColorStop(1, '#2a2348');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, street);

  BUILD.forEach((layer, li) => {
    for (const b of layer) {
      const top = street - b.h;
      ctx.fillStyle = li ? '#151627' : '#1d1c35';     // đặt lại mỗi toà: cửa sổ vừa đổi fillStyle
      ctx.fillRect(b.x, top, b.w, b.h);
      for (const w of b.wins) {
        let on = 1;
        if (w.blink) on = ((t / w.blink + w.ph) % 1) < 0.85 ? 1 : 0.15;
        ctx.fillStyle = w.warm ? `rgba(255,190,110,${(0.55 * on).toFixed(3)})` : `rgba(140,180,255,${(0.4 * on).toFixed(3)})`;
        ctx.fillRect(b.x + w.x, top + w.y, 22, 30);
      }
    }
  });

  // Biển hiệu neon, nhấp nháy nhẹ chu kỳ 2 s
  const flick = 0.8 + 0.2 * Math.sin(2 * Math.PI * t / 2);
  ctx.save();
  ctx.font = '800 64px Inter, Arial, sans-serif'; ctx.textAlign = 'center';
  ctx.shadowColor = '#ff4d6d'; ctx.shadowBlur = 40 * flick;
  ctx.fillStyle = `rgba(255,120,150,${flick.toFixed(3)})`;
  ctx.fillText(SIGN.text, SIGN.x * W, SIGN.y * H);
  ctx.restore();

  // Mặt đường ướt + phản chiếu biển hiệu
  const road = ctx.createLinearGradient(0, street, 0, H);
  road.addColorStop(0, '#1a1830'); road.addColorStop(1, '#09090f');
  ctx.fillStyle = road; ctx.fillRect(0, street, W, H - street);
  const rx = SIGN.x * W, ry = street + 170;           // vệt phản chiếu mờ dần, không dùng ctx.filter
  const refl = ctx.createRadialGradient(rx, ry, 10, rx, ry, 260);
  refl.addColorStop(0, `rgba(255,111,142,${(0.45 * flick).toFixed(3)})`); refl.addColorStop(1, 'rgba(255,111,142,0)');
  ctx.save(); ctx.translate(rx, ry); ctx.scale(1, 0.55); ctx.translate(-rx, -ry);
  ctx.fillStyle = refl; ctx.fillRect(rx - 260, ry - 260, 520, 520); ctx.restore();
  // gợn nước: chu kỳ 1 s
  ctx.strokeStyle = 'rgba(200,210,255,0.35)'; ctx.lineWidth = 2;
  for (const r of RIPPLES) {
    const k = (t + r.ph) % 1;
    ctx.globalAlpha = 1 - k;
    ctx.beginPath(); ctx.ellipse(r.x * W, street + 40 + r.y * (H - street - 80), 6 + 40 * k, (6 + 40 * k) * 0.3, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Mưa: y = ((ph + laps·t/LOOP) mod 1) → lặp khít sau LOOP giây
  ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (let i = 0; i < Math.min(RAIN_DENSITY, DROPS.length); i++) {
    const d = DROPS[i];
    const y = ((d.ph + d.laps * t / LOOP) % 1) * (H + 200) - 100;
    const x = d.x * W * 1.25 - y * 0.12;   // rải rộng hơn khung để mưa xiên vẫn phủ mép phải
    ctx.strokeStyle = `rgba(190,205,255,${d.a.toFixed(3)})`;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - d.len * 0.12, y + d.len); ctx.stroke();
  }
}
