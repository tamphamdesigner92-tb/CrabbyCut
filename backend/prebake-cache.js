'use strict';

/* BỘ NHỚ ĐỆM KHUNG VẼ TRƯỚC CHO LƯỢT XUẤT LẠI (mục 25 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md).
 *
 * Cache render (1.13) đã cho sidecar dùng lại batch hình khi không có gì đổi, nhưng trước khi
 * gửi lệnh xuất, renderer còn DỰNG LẠI mọi chuỗi khung "vẽ trước" ở mỗi lượt xuất: miếng vá
 * Retouch (Yêu Con: 2 khối, 294 khung, 16,5 s) và chuỗi khung chữ/ảnh động. Cùng đầu vào thì ra
 * cùng khung, nên lượt sau chỉ cần hỏi "khoá này đã có chưa" rồi gửi khoá thay cho khung.
 *
 * AI LÀM GÌ:
 *   - RENDERER tính khoá (SHA-256 hex) từ MỌI thứ ảnh hưởng tới điểm ảnh của chuỗi khung: dữ
 *     liệu block, sequence, fps, mã cache khuôn mặt, VÂN TAY MÃ NGUỒN (băm các script đang chạy —
 *     sửa mã là cache tự mất hiệu lực, không phải nhớ tăng số phiên bản), trình duyệt + GPU.
 *   - BACKEND cộng thêm DANH TÍNH TỆP NGUỒN (đường dẫn + cỡ + mtime + 3 mẩu nội dung) — renderer
 *     không đọc được tệp nguồn, mà thiếu nó thì hai dự án khác nguồn cùng khoá.
 *   - Mỗi mục là một thư mục `<tên>/frame_%04d.<jpg|png>` + `meta.json` (ghi CUỐI, thư mục tạm rồi
 *     đổi tên: thấy meta.json là mục đã đủ khung). Đường dẫn + mtime của khung đứng yên giữa các
 *     lượt, nên `file_ids.tsv` của cache render trúng ngay, sidecar không phải băm lại khung.
 *
 * Bật/tắt chung với cache render (Cài đặt › Xuất video › "Dùng lại phần đã render khi xuất lại"),
 * dọn chung với "Bản render để xuất lại" ở Cài đặt › Bộ nhớ đệm. Hạn 30 ngày + trần dung lượng,
 * bỏ mục lâu không dùng nhất trước (dọn lúc khởi động). */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT = 'prebake-v1';
const KEY_RE = /^[0-9a-f]{64}$/;
const NAME_RE = /^[0-9a-f]{40}$/;
const EXT_RE = /^\.(jpg|png)$/;
const SAMPLE_BYTES = 64 * 1024;
// Lượt hỏi trúng giữ mục khỏi bị dọn tay trong lúc renderer còn đang chuẩn bị lượt xuất.
const HOLD_MS = 10 * 60 * 1000;

function createPrebakeCache({ dir, allowed, enabled, resolveSource, salt, ttlMs, maxBytes, log }) {
  const say = typeof log === 'function' ? log : () => {};
  let holdUntil = 0;
  // Chuỗi môi trường phía backend (bản ffmpeg) — tính một lần cho cả tiến trình.
  let saltValue = null;
  const saltText = () => {
    if (saltValue === null) saltValue = typeof salt === 'function' ? String(salt() || '') : '';
    return saltValue;
  };

  function active() {
    return Boolean(allowed) && Boolean(enabled());
  }

  /* Danh tính tệp nguồn. `undefined`/`null` = chuỗi khung không đọc tệp nào (chữ, hình) -> '-'.
   * Nguồn không hợp lệ / không đọc được -> null (không dùng cache). */
  function sourceStamp(sourcePath) {
    if (sourcePath === undefined || sourcePath === null) return '-';
    const resolved = resolveSource(sourcePath);
    if (!resolved) return null;
    let st;
    try { st = fs.statSync(resolved); } catch (_) { return null; }
    if (!st.isFile()) return null;
    const h = crypto.createHash('sha256');
    h.update(`${path.resolve(resolved)}|${st.size}|${Math.floor(st.mtimeMs)}|`);
    let fd = null;
    try {
      fd = fs.openSync(resolved, 'r');
      const offsets = [0, Math.max(0, Math.floor(st.size / 2) - SAMPLE_BYTES / 2), Math.max(0, st.size - SAMPLE_BYTES)];
      const buf = Buffer.alloc(Math.min(SAMPLE_BYTES, st.size));
      for (const off of offsets) {
        const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, off) : 0;
        h.update(buf.subarray(0, n));
      }
    } catch (_) {
      return null;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* bỏ qua */ } }
    }
    return h.digest('hex');
  }

  // Tên thư mục của mục cache = băm(khoá renderer + danh tính nguồn); null = không cache được.
  function entryName(key, sourcePath) {
    const k = String(key || '');
    if (!KEY_RE.test(k)) return null;
    const stamp = sourceStamp(sourcePath);
    if (!stamp) return null;
    return crypto.createHash('sha256').update(`${FORMAT}|${k}|${stamp}|${saltText()}`).digest('hex').slice(0, 40);
  }

  function framePath(entryDir, ext, k) {
    return path.join(entryDir, `frame_${String(k).padStart(4, '0')}${ext}`);
  }

  // meta.json của mục ĐỦ khung, hoặc null.
  function readEntry(name) {
    if (!allowed || !NAME_RE.test(String(name || ''))) return null;
    const entryDir = path.join(dir, name);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(entryDir, 'meta.json'), 'utf8')); } catch (_) { return null; }
    const count = Number(meta?.frame_count);
    if (meta?.format !== FORMAT || !Number.isInteger(count) || count < 2 || !EXT_RE.test(String(meta.ext || ''))) return null;
    // Khung cuối còn đó = mục chưa bị ai dọn dở (khung ghi trước meta, nên thiếu khung đầu là bất thường).
    if (!fs.existsSync(framePath(entryDir, meta.ext, 0)) || !fs.existsSync(framePath(entryDir, meta.ext, count - 1))) return null;
    return { ...meta, pattern: path.join(entryDir, `frame_%04d${meta.ext}`) };
  }

  function touch(name) {
    const now = new Date();
    try { fs.utimesSync(path.join(dir, name, 'meta.json'), now, now); } catch (_) { /* chỉ mất thứ tự LRU */ }
  }

  /* Renderer hỏi trước khi dựng. Trả `enabled` để renderer biết có nên gửi khoá kèm khung (để
   * backend cất) hay không. */
  function lookup(key, sourcePath) {
    if (!active()) return { enabled: false, hit: false };
    const name = entryName(key, sourcePath);
    if (!name) return { enabled: true, hit: false, cacheable: false };
    const meta = readEntry(name);
    if (!meta) return { enabled: true, hit: false, cacheable: true };
    touch(name);
    holdUntil = Date.now() + HOLD_MS;
    const { pattern: _p, format: _f, ...publicMeta } = meta;
    return { enabled: true, hit: true, cacheable: true, meta: publicMeta };
  }

  /* Cất các khung đã ghi xong (`files` theo đúng thứ tự khung) thành mục `name`. Liên kết cứng
   * (cùng ổ với temp_uploads) hoặc chép. Trả meta của mục (kể cả khi tiến trình khác đã cất trước),
   * hoặc null nếu không cất được — lỗi cất KHÔNG được làm hỏng lượt xuất. */
  function storeFiles(name, files, meta) {
    if (!active() || !NAME_RE.test(String(name || '')) || !Array.isArray(files) || files.length < 2) return null;
    const ext = path.extname(files[0]).toLowerCase();
    if (!EXT_RE.test(ext) || files.some((f) => path.extname(f).toLowerCase() !== ext)) return null;
    const existing = readEntry(name);
    if (existing) { touch(name); return existing; }
    const finalDir = path.join(dir, name);
    const staging = path.join(dir, `${name}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.mkdirSync(staging, { recursive: true });
      files.forEach((src, k) => {
        const dest = framePath(staging, ext, k);
        try { fs.linkSync(src, dest); } catch (_) { fs.copyFileSync(src, dest); }
      });
      fs.writeFileSync(path.join(staging, 'meta.json'), JSON.stringify({
        ...(meta && typeof meta === 'object' ? meta : {}),
        format: FORMAT,
        ext,
        frame_count: files.length,
        stored_at: new Date().toISOString(),
      }));
      fs.rmSync(finalDir, { recursive: true, force: true });   // mục hỏng (thiếu meta) bị thay
      fs.renameSync(staging, finalDir);
      return readEntry(name);
    } catch (error) {
      say(`[prebake] không cất được mục ${name}: ${error.message}`);
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* bỏ qua */ }
      return readEntry(name);   // tiến trình khác vừa cất xong thì vẫn dùng được
    }
  }

  // Đang có renderer vừa hỏi trúng và chưa xuất xong -> đừng cho dọn tay.
  function held() {
    return Date.now() < holdUntil;
  }

  function release() {
    holdUntil = 0;
  }

  // Dọn: thư mục tạm bỏ dở, mục quá hạn, rồi tới trần dung lượng (cũ nhất trước).
  function prune() {
    if (!allowed) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    const now = Date.now();
    const entries = [];
    for (const name of names) {
      const p = path.join(dir, name);
      if (name.includes('.tmp-')) {
        try { if (now - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* bỏ qua */ }
        continue;
      }
      let used = 0;
      try { used = fs.statSync(path.join(p, 'meta.json')).mtimeMs; } catch (_) { used = 0; }
      if (!used || now - used > ttlMs) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* bỏ qua */ }
        continue;
      }
      let bytes = 0;
      try { for (const f of fs.readdirSync(p)) bytes += fs.statSync(path.join(p, f)).size; } catch (_) { /* bỏ qua */ }
      entries.push({ p, used, bytes });
    }
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    entries.sort((a, b) => a.used - b.used);
    for (const e of entries) {
      if (total <= maxBytes) break;
      try { fs.rmSync(e.p, { recursive: true, force: true }); total -= e.bytes; } catch (_) { /* bỏ qua */ }
    }
  }

  return { active, entryName, lookup, readEntry, storeFiles, held, release, prune, sourceStamp };
}

module.exports = { createPrebakeCache, PREBAKE_FORMAT: FORMAT };
