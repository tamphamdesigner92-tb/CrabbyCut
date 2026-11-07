// S-03 · Hệ Mặt Trời trong 30 giây — GeoCode JavaScript canvas
// Khung 1080×1920, video 30 s, 30 fps; chạy cả 30 s, thẻ câu lệnh và thẻ cuối nằm đè lên (buổi dựng 7/11).
// 8 hành tinh quay quanh Mặt Trời; tên hiện dần theo thứ tự, mỗi tên cách nhau 2,5 s.
// Quỹ đạo không theo tỉ lệ thật (để vừa khung dọc); chu kỳ quay giữ đúng THỨ TỰ nhanh → chậm.
// Quy tắc vàng: góc = góc đầu + 2π·t/chu kỳ; sao nền có seed; nền đen là chủ ý (lớp nền).
// Muốn đổi tên sang tiếng Anh/Trung: crabbycut_update_geocode replace mảng NAMES.

const NAMES = ['Sao Thủy', 'Sao Kim', 'Trái Đất', 'Sao Hỏa', 'Sao Mộc', 'Sao Thổ', 'Sao Thiên Vương', 'Sao Hải Vương'];
const LABEL_START = 4, LABEL_GAP = 2.5;   // tên đầu ở giây 4 (sau thẻ câu lệnh), tên cuối ở giây 21,5
const PLANETS = [
  { r: 6,  color: '#b9b2a8', orbit: 120, period: 3   },
  { r: 11, color: '#e8c27a', orbit: 165, period: 5   },
  { r: 12, color: '#4fb3ff', orbit: 215, period: 7   },
  { r: 9,  color: '#e2553c', orbit: 262, period: 10  },
  { r: 34, color: '#d9a066', orbit: 335, period: 16  },
  { r: 28, color: '#e8d08e', orbit: 410, period: 22  , ring: true },
  { r: 19, color: '#8fe0e6', orbit: 470, period: 30  },
  { r: 18, color: '#4a6cff', orbit: 515, period: 38  },
];
const SQUASH = 1.15;  // bán trục dọc = orbit × SQUASH (buổi dựng 7/11: thay TILT×2.2 để quỹ đạo ngoài vừa khung)
const LABEL_MARGIN = 160;  // tên hành tinh kẹp x trong [160, W−160], sát mép bị cắt

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(8);
const STARS = Array.from({ length: 260 }, () => ({ x: R(), y: R(), r: 0.6 + R() * 1.8, ph: R() }));
const START = PLANETS.map(() => R() * Math.PI * 2);

function draw(ctx, t, W, H) {
  ctx.fillStyle = '#05060d'; ctx.fillRect(0, 0, W, H);
  for (const s of STARS) {
    ctx.globalAlpha = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (t / 3 + s.ph)));
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  const cx = W / 2, cy = H * 0.43;
  // Quỹ đạo
  ctx.strokeStyle = 'rgba(215,221,229,0.18)'; ctx.lineWidth = 2;
  for (const p of PLANETS) { ctx.beginPath(); ctx.ellipse(cx, cy, p.orbit, p.orbit * SQUASH, 0, 0, Math.PI * 2); ctx.stroke(); }

  // Tính vị trí; vẽ hành tinh phía sau Mặt Trời trước, phía trước sau
  const pos = PLANETS.map((p, i) => {
    const a = START[i] + 2 * Math.PI * t / p.period;
    return { p, i, x: cx + Math.cos(a) * p.orbit, y: cy + Math.sin(a) * p.orbit * SQUASH, front: Math.sin(a) > 0 };
  });
  const drawPlanet = ({ p, x, y }) => {
    if (p.ring) { ctx.strokeStyle = 'rgba(232,208,142,0.8)'; ctx.lineWidth = 5; ctx.beginPath(); ctx.ellipse(x, y, p.r * 2, p.r * 0.6, -0.3, 0, Math.PI * 2); ctx.stroke(); }
    const g = ctx.createRadialGradient(x - p.r * 0.4, y - p.r * 0.4, p.r * 0.2, x, y, p.r);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, p.color); g.addColorStop(1, '#111');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.fill();
  };
  pos.filter((q) => !q.front).forEach(drawPlanet);
  const sg = ctx.createRadialGradient(cx, cy, 20, cx, cy, 170);
  sg.addColorStop(0, '#fff6d8'); sg.addColorStop(0.35, '#ffb020'); sg.addColorStop(1, 'rgba(255,120,0,0)');
  ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(cx, cy, 170, 0, Math.PI * 2); ctx.fill();
  pos.filter((q) => q.front).forEach(drawPlanet);

  // Tên hiện dần: hành tinh i xuất hiện ở LABEL_START + i·LABEL_GAP, mờ vào trong 0,6 s
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.font = '600 34px Inter, Arial, sans-serif';
  for (const q of pos) {
    const k = Math.max(0, Math.min(1, (t - LABEL_START - q.i * LABEL_GAP) / 0.6));
    if (k <= 0) continue;
    ctx.globalAlpha = k;
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 6;
    const lx = Math.max(LABEL_MARGIN, Math.min(W - LABEL_MARGIN, q.x));
    ctx.strokeText(NAMES[q.i], lx, q.y - q.p.r - 12); ctx.fillText(NAMES[q.i], lx, q.y - q.p.r - 12);
  }
  ctx.globalAlpha = 1;

  // Danh sách thứ tự ở dưới, sáng dần theo tên đã hiện
  ctx.textAlign = 'left'; ctx.font = '700 40px Inter, Arial, sans-serif';
  NAMES.forEach((n, i) => {
    const on = t >= LABEL_START + i * LABEL_GAP;
    ctx.fillStyle = on ? PLANETS[i].color : 'rgba(255,255,255,0.18)';
    const col = i % 2, row = Math.floor(i / 2);
    ctx.fillText(`${i + 1}. ${n}`, 110 + col * 470, H * 0.80 + row * 64);
  });
}
