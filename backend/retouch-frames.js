'use strict';
/* =====================================================================
 * KHUNG NGUỒN CHO BƯỚC DỰNG RETOUCH KHI XUẤT — nhánh 1B của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md
 *
 * Renderer dựng miếng vá Retouch bằng đúng hàm của preview, nên cần khung nguồn ở từng mốc thời
 * gian của lưới xuất. Trước đây nó TUA thẻ <video> tới từng mốc: mỗi lần tua trình duyệt giải mã
 * lại từ khung khoá gần nhất. Đo 2026-10-01 trên "Yêu Con 1" (DJI HEVC 10-bit 1728×3072 59,94 fps,
 * GOP 0,5 s): 81 ms/khung (tua 35 ms + chờ GPU giải mã xong 45 ms), chạy song song 2–4 thẻ video
 * không nhanh hơn (bộ giải mã đã bão hoà) — riêng phần này là 24 trong 31–42 s vẽ trước của dự án.
 * Ở đây ffmpeg giải mã TUẦN TỰ đoạn cần (mỗi khung một lần): 159 khung mất ~3 s (~19 ms/khung).
 *
 * Phụ lợi: miếng vá nay lấy điểm ảnh từ CÙNG bộ giải mã với phần khung quanh nó (sidecar), hết
 * khoản lệch ~2/255 giữa giải mã của Chromium và của ffmpeg mà mép mềm phải che (AppendFeatherAlpha).
 *
 * CHỌN KHUNG: mốc `t` (giây, trục mà renderer dùng — cũng là trục của timeline) lấy khung CUỐI có
 * PTS ≤ đích, như thẻ <video> hiện khung chứa `t`. Đích theo đúng quy ước của sidecar:
 *   - lane chính (temp_input.mp4): PTS tuyệt đối = t + start_time của LUỒNG HÌNH (bản nối có edit
 *     list, hình bắt đầu ở 0,021 s — xem ExportSettings::videoStart trong core_process.cpp);
 *   - tệp asset (lớp phủ): PTS tuyệt đối = t + start_time của TỆP (ffmpeg mặc định trừ mốc này,
 *     và sidecar trim lớp phủ theo trục đã trừ).
 * MÀU: cùng quy tắc với sidecar (UntaggedColorFix) — YUV không nhãn cao ≥ 720 coi là BT.709; dải
 * theo nhãn (yuvj/pc = full). Nguồn HDR (PQ/HLG) KHÔNG phục vụ (415): trình duyệt tự ánh xạ tông
 * HDR -> SDR khi vẽ, còn ffmpeg ở đây thì không — renderer quay về đường tua.
 *
 * Phản hồi: application/octet-stream = N khung RGBA liên tiếp, mỗi khung W×H×4 byte, theo ĐÚNG thứ tự
 * `times` (mốc trùng nhau -> khung lặp lại). Header X-Frame-Width / X-Frame-Height / X-Frame-Count.
 * Env tắt (renderer tự quay về đường tua): CRAB_RETOUCH_FRAMES=0.
 * ================================================================== */
const { spawn, spawnSync } = require('child_process');

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);
const MAX_TIMES = 20000;
// Phần chờ gửi tối đa trước khi dừng ffmpeg (xem writeFrame): ~25 khung miếng vá cỡ 800×800 RGBA.
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const PTS_EPSILON = 1e-4;
// Tua trước đích đầu tiên một đoạn: -ss vào rơi về khung khoá trước mốc rồi giải mã tới mốc.
const SEEK_LEAD_SECONDS = 2.0;

function parseRotation(stream) {
  const fromTag = Number(stream?.tags?.rotate);
  if (Number.isFinite(fromTag) && fromTag) return fromTag;
  for (const side of (stream?.side_data_list || [])) {
    const r = Number(side?.rotation);
    if (Number.isFinite(r) && r) return r;
  }
  return 0;
}

// Thông tin cần để giải mã + chọn khung. null = không đọc được luồng hình.
function probeFrameSource(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,pix_fmt,start_time,color_space,color_transfer,color_range:stream_tags=rotate'
    + ':stream_side_data=rotation:format=start_time', '-of', 'json', file],
  { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.status !== 0) return null;
  let payload;
  try { payload = JSON.parse(r.stdout || '{}'); } catch (_) { return null; }
  const s = Array.isArray(payload.streams) ? payload.streams[0] : null;
  const codedW = Number(s?.width);
  const codedH = Number(s?.height);
  if (!(codedW > 0 && codedH > 0)) return null;
  const rotation = ((Math.round(parseRotation(s) / 90) * 90) % 360 + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  const pixFmt = String(s?.pix_fmt || '');
  const space = String(s?.color_space || '');
  const untagged = !space || space === 'unknown';
  let matrix = 'bt601';
  if (space === 'bt709' || (untagged && codedH >= 720 && pixFmt.startsWith('yuv') && !pixFmt.startsWith('yuvj'))) matrix = 'bt709';
  else if (space === 'bt2020nc' || space === 'bt2020c') matrix = 'bt2020';
  else if (space === 'fcc') matrix = 'fcc';
  else if (space === 'smpte240m') matrix = 'smpte240m';
  const full = pixFmt.startsWith('yuvj') || s?.color_range === 'pc';
  const videoStart = Number(s?.start_time);
  const formatStart = Number(payload?.format?.start_time);
  return {
    width: swap ? codedH : codedW,
    height: swap ? codedW : codedH,
    matrix,
    range: full ? 'full' : 'tv',
    hdr: HDR_TRANSFERS.has(String(s?.color_transfer || '')),
    videoStart: Number.isFinite(videoStart) ? videoStart : 0,
    formatStart: Number.isFinite(formatStart) ? formatStart : 0,
  };
}

/* Đích PTS tuyệt đối cho từng mốc. `mainLane` = temp_input.mp4 (xem khối chú thích đầu tệp). */
function frameTargets(times, info, mainLane) {
  const base = mainLane ? info.videoStart : info.formatStart;
  return times.map((t) => Math.max(0, Number(t) || 0) + base);
}

/* Chọn khung theo luồng: gọi `feed(pts, frame)` cho từng khung giải mã theo thứ tự, rồi `finish()`;
 * `emit(frame, index)` được gọi cho từng mốc theo thứ tự `targets` (phải không giảm). Tách riêng để
 * test được quy tắc chọn mà không cần ffmpeg. */
function createFrameSelector(targets, emit) {
  let i = 0;
  let prev = null;
  return {
    feed(pts, frame) {
      while (i < targets.length && pts > targets[i] + PTS_EPSILON) {
        // Mốc nằm trước khung đầu tiên (đầu tệp) -> dùng khung đầu tiên, như <video> ở t = 0.
        emit(prev || frame, i);
        i += 1;
      }
      prev = frame;
    },
    finish() {
      // Hết tệp: các mốc còn lại lấy khung cuối (như <video> tua quá cuối).
      while (i < targets.length && prev) { emit(prev, i); i += 1; }
      return i;
    },
    get emitted() { return i; },
  };
}

/* Vùng cắt (renderer gửi toạ độ CHUẨN HOÁ 0..1 {x0,y0,x1,y1} theo khung đã xoay) -> pixel chẵn, thêm
 * lề 8 px, kẹp trong khung. null = cả khung (không gửi, sai, hoặc gần như trọn khung). */
const CROP_MARGIN_PX = 8;
function cropRegion(raw, width, height) {
  if (!raw || typeof raw !== 'object') return null;
  const n = (v) => Math.max(0, Math.min(1, Number(v)));
  const x0n = n(raw.x0), y0n = n(raw.y0), x1n = n(raw.x1), y1n = n(raw.y1);
  if (![x0n, y0n, x1n, y1n].every(Number.isFinite) || !(x1n > x0n && y1n > y0n)) return null;
  const x = Math.max(0, Math.floor(x0n * width) - CROP_MARGIN_PX) & ~1;
  const y = Math.max(0, Math.floor(y0n * height) - CROP_MARGIN_PX) & ~1;
  const x1 = Math.min(width, Math.ceil(x1n * width) + CROP_MARGIN_PX);
  const y1 = Math.min(height, Math.ceil(y1n * height) + CROP_MARGIN_PX);
  const w = Math.min(width - x, (x1 - x + 1) & ~1) & ~1;
  const h = Math.min(height - y, (y1 - y + 1) & ~1) & ~1;
  if (w < 16 || h < 16 || w * h > 0.8 * width * height) return null;
  return { x, y, w, h };
}

function httpFail(res, status, message) {
  if (!res.headersSent) res.status(status).json({ error: message });
  else res.destroy();
}

/* Handler Express cho POST /api/retouch/frames. `resolveSource(raw)` = cổng an toàn của Retouch
 * (rỗng -> temp_input.mp4). */
function createRetouchFramesHandler({ resolveSource, ffmpegBin = 'ffmpeg', logStatus = () => {} }) {
  return async function retouchFramesHandler(req, res) {
    if (process.env.CRAB_RETOUCH_FRAMES === '0') return httpFail(res, 503, 'retouch frames disabled');
    const rawSource = req.body?.source_path;
    const mainLane = !String(rawSource || '').trim();
    const file = resolveSource(rawSource);
    if (!file) return httpFail(res, 400, 'Nguồn không hợp lệ hoặc nằm ngoài thư mục dự án.');
    const times = Array.isArray(req.body?.times) ? req.body.times.map(Number) : [];
    if (!times.length || times.length > MAX_TIMES || times.some((t) => !Number.isFinite(t))) {
      return httpFail(res, 400, 'Danh sách mốc thời gian không hợp lệ.');
    }
    for (let k = 1; k < times.length; k++) {
      if (times[k] < times[k - 1]) return httpFail(res, 400, 'Mốc thời gian phải không giảm.');
    }
    const info = probeFrameSource(file);
    if (!info) return httpFail(res, 422, 'Không đọc được luồng hình của nguồn.');
    if (info.hdr) return httpFail(res, 415, 'Nguồn HDR: renderer tự dựng (cần ánh xạ tông).');

    const targets = frameTargets(times, info, mainLane);
    const crop = cropRegion(req.body?.crop, info.width, info.height);
    const outW = crop ? crop.w : info.width;
    const outH = crop ? crop.h : info.height;
    const frameBytes = outW * outH * 4;
    // `-ss` của input tính từ mốc ĐẦU TỆP (ffmpeg tự cộng start_time của tệp), còn đích là PTS
    // tuyệt đối (`-copyts` giữ nguyên PTS) -> trừ start_time của tệp trước khi đưa vào -ss.
    const seekFrom = Math.max(0, targets[0] - info.formatStart - SEEK_LEAD_SECONDS);
    const span = targets[targets.length - 1] - info.formatStart - seekFrom + 1.0;
    /* `-hwaccel auto`: giải mã bằng GPU nếu có (khung tải về RAM, phần cắt/đổi màu vẫn ở CPU), tự
     * rơi về CPU nếu không. Đứng một mình thì nhanh ngang giải mã CPU, nhưng trong lượt xuất thật
     * renderer đang chạy Retouch cùng lúc — giải mã CPU giành CPU với nó. */
    const hw = process.env.CRAB_RETOUCH_FRAMES_HW === '0' ? [] : ['-hwaccel', 'auto'];
    const args = ['-hide_banner', '-nostdin', '-v', 'info', '-copyts', ...hw,
      '-ss', seekFrom.toFixed(6), '-t', span.toFixed(6), '-i', file,
      '-an', '-sn', '-dn',
      // Cắt TRƯỚC khi đổi sang RGBA (toạ độ chẵn nên mẫu màu 4:2:0 không lệch).
      '-vf', `${crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : ''}`
        + `scale=in_color_matrix=${info.matrix}:in_range=${info.range},format=rgba,showinfo`,
      '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'];
    const proc = spawn(ffmpegBin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Frame-Width', String(outW));
    res.setHeader('X-Frame-Height', String(outH));
    res.setHeader('X-Frame-Count', String(times.length));
    res.setHeader('X-Source-Width', String(info.width));
    res.setHeader('X-Source-Height', String(info.height));
    res.setHeader('X-Crop-X', String(crop ? crop.x : 0));
    res.setHeader('X-Crop-Y', String(crop ? crop.y : 0));

    // Client bỏ ngang (đóng kết nối trước khi xong) -> dừng ffmpeg. Nghe trên RESPONSE: `close` của
    // request bắn ngay khi body đã đọc xong (Node ≥ 16) — nghe ở đó là giết ffmpeg từ đầu (đã mắc).
    let aborted = false;
    res.on('close', () => { if (!res.writableEnded) { aborted = true; proc.kill('SIGKILL'); } });
    /* Cho ffmpeg giải mã TRƯỚC trong lúc renderer xử lý khung hiện tại: chỉ dừng nó khi phần chờ gửi
     * vượt MAX_BUFFERED_BYTES. Dừng theo backpressure thường của res.write (16 KB) thì mỗi khung
     * ffmpeg đứng chờ renderer xử lý xong mới giải mã tiếp — giải mã và xử lý chạy NỐI TIẾP (đo trên
     * "Yêu Con 1": phần dựng khung chỉ 28,3 -> 22,7 s thay vì gần mức giải mã). */
    let paused = false;
    const writeFrame = (frame) => {
      if (aborted) return;
      res.write(frame);
      if (!paused && res.writableLength > MAX_BUFFERED_BYTES) {
        paused = true;
        proc.stdout.pause();
        res.once('drain', () => { paused = false; proc.stdout.resume(); });
      }
    };
    const selector = createFrameSelector(targets, (frame) => writeFrame(frame));

    // PTS của từng khung đọc từ showinfo (stderr); khung đọc từ stdout. Ghép theo thứ tự.
    const ptsQueue = [];
    const frameQueue = [];
    const drain = () => {
      while (ptsQueue.length && frameQueue.length) selector.feed(ptsQueue.shift(), frameQueue.shift());
    };
    let errText = '';
    let stderrBuf = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      let nl;
      while ((nl = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line.includes('Parsed_showinfo')) {
          const m = /pts_time:\s*(-?[\d.]+)/.exec(line);
          if (m) ptsQueue.push(Number(m[1]));
        } else if (/error|invalid/i.test(line)) {
          errText = (errText + line + '\n').slice(-2000);
        }
      }
      drain();
    });
    /* Gom các mẩu stdout (~64 KB) vào danh sách, đủ MỘT khung mới chép một lần. KHÔNG Buffer.concat
     * phần đang gom với từng mẩu: khung 1728×3072 RGBA = 21 MB, nối như vậy là chép đi chép lại
     * hàng GB mỗi khung — đã mắc: 2,8 s/khung, bước dựng Retouch của "Yêu Con 1" lên 832 s. */
    const parts = [];
    let partsLen = 0;
    proc.stdout.on('data', (chunk) => {
      parts.push(chunk);
      partsLen += chunk.length;
      while (partsLen >= frameBytes) {
        const frame = Buffer.allocUnsafe(frameBytes);
        let off = 0;
        while (off < frameBytes) {
          const head = parts[0];
          const take = Math.min(head.length, frameBytes - off);
          head.copy(frame, off, 0, take);
          off += take;
          if (take === head.length) parts.shift();
          else parts[0] = head.subarray(take);
        }
        partsLen -= frameBytes;
        frameQueue.push(frame);
      }
      drain();
    });
    proc.on('error', (error) => httpFail(res, 500, `ffmpeg: ${error.message}`));
    proc.on('close', (code) => {
      if (aborted) return;
      drain();
      const sent = selector.finish();
      if (code !== 0 || sent < times.length) {
        logStatus(`[retouch-frames] ffmpeg ${code}, ${sent}/${times.length} khung: ${errText.trim().slice(-300)}`);
        if (!res.headersSent || sent === 0) return httpFail(res, 500, 'Không giải mã được đủ khung.');
        res.destroy();   // renderer thấy thiếu khung -> tua phần còn lại
        return;
      }
      res.end();
    });
  };
}

module.exports = { createRetouchFramesHandler, createFrameSelector, frameTargets, probeFrameSource, cropRegion };
