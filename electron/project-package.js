// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* ĐÓNG GÓI DỰ ÁN — "Collect Files and Copy to New Location" của Premiere Pro.
 *
 * VẤN ĐỀ. Tệp .crab chỉ GHI ĐƯỜNG DẪN TUYỆT ĐỐI tới video nguồn, không chứa media. Chép
 * mỗi tệp .crab sang máy khác / ổ khác là mở lên mất link toàn bộ, phải re-link tay từng
 * file. Người dùng cần một thao tác "gói cả dự án lại rồi mang đi".
 *
 * CÁCH LÀM, ĐÚNG KHUÔN PREMIERE:
 *   - Đóng gói là một HÀNH ĐỘNG RIÊNG (menu "Đóng gói dự án…"), KHÔNG phải việc âm thầm
 *     xảy ra ở mỗi lần Lưu. Lưu vẫn nhẹ như cũ.
 *   - CHÉP, KHÔNG DI CHUYỂN. Footage gốc nằm nguyên chỗ người dùng đã tổ chức (Premiere gọi
 *     là "Collect Files and COPY"). Di chuyển là cướp file khỏi những dự án khác đang dùng
 *     chung bộ footage đó, và không hoàn tác được.
 *   - Gói ra một THƯ MỤC tự chứa: <Đích>/<Tên dự án>/ gồm <Tên dự án>.crab + Media/ (tư liệu
 *     của người dùng) + Library/ (tài nguyên thư viện dự án đang dùng: Video, Elements, Music,
 *     SFXs, LUT — xem khối "TÀI NGUYÊN THƯ VIỆN" bên dưới).
 *   - Đường dẫn trong bản .crab đã gói được ghi TƯƠNG ĐỐI so với chính nó, nên mở ở bất kỳ
 *     đâu cũng đúng (xem resolvePayloadPaths — main.js gọi lúc đọc tệp).
 *
 * VÌ SAO NẰM Ở ELECTRON MAIN: renderer chạy trong sandbox (contextIsolation) nên không có
 * fs/path. Toàn bộ việc chép file + viết lại đường dẫn phải xong TRƯỚC khi payload rời main.
 *
 * Factory hoá (cùng khuôn electron/recent-projects.js) để test chạy được bằng node thuần,
 * không cần dựng cả Electron.
 */
const fs = require('fs');
const path = require('path');

const MEDIA_DIR_NAME = 'Media';

/* ===== TỆP PHỤ ĐỀ .srt =====================================================
 * TÁCH RIÊNG khỏi eachPathSite() một cách CÓ CHỦ Ý. eachPathSite là danh sách MEDIA, và mọi
 * thứ nằm trong đó đều bị collectMediaPaths chép vào `Media/` rồi đổi tên cho khỏi trùng.
 * Tệp .srt không phải media: nó là BẢN XUẤT của timeline, và giao ước của nó (xem
 * `subtitle-save-srt` ở main.js) là nằm CẠNH tệp .crab, mang ĐÚNG tên .crab — nhờ vậy lần
 * ghi sau đè lên bản cũ thay vì rải ra một đống .srt mồ côi. Ném nó vào Media/ là phá đúng
 * giao ước đó.
 */
function subtitleStateOf(payload) {
  const state = payload?.project?.history?.editingState?.subtitleState;
  return (state && typeof state === 'object') ? state : null;
}

/* ===== TỆP ĐI KÈM DỰ ÁN (sidecar) ==========================================
 * Một dự án gồm nhiều hơn tệp .crab: phụ đề "<Tên>.srt" và bản proxy xem trước
 * "<Tên>.proxy.mp4". Cả hai theo CÙNG MỘT giao ước: nằm cạnh .crab, mang đúng tên .crab.
 *
 * Giao ước đó không phải để cho gọn — nó là thứ khiến ta SUY RA được vị trí mới mà không
 * phải hỏi người dùng khi họ kéo tệp .crab sang thư mục khác, và khiến lần ghi sau ĐÈ lên
 * bản cũ thay vì rải ra một đống tệp mồ côi. Vì vậy chỉ có MỘT hàm dựng tên, dùng cho cả
 * chiều ghi lẫn chiều tìm. */
const SIDECAR_SUBTITLE = '.srt';
const SIDECAR_PREVIEW_PROXY = '.proxy.mp4';

function projectSidecarPath(crabFilePath, suffix) {
  const dir = path.dirname(crabFilePath);
  const base = path.basename(crabFilePath).replace(/\.crab$/i, '');
  return path.join(dir, `${base}${suffix}`);
}

/* Bản proxy xem trước lưu kèm dự án. Trong payload chỉ có DANH TÍNH, KHÔNG có đường dẫn:
 * đường dẫn được suy ra từ chỗ đặt tệp .crab (xem projectSidecarPath). Nhờ vậy chép cả thư
 * mục dự án đi đâu cũng đúng, và không có cảnh payload ghi một đường dẫn mà lượt chép tệp
 * sau đó lại thất bại. Danh tính do backend cấp — xem previewProxyIdentity ở server.js. */
function previewProxyOf(payload) {
  const media = payload?.media;
  if (!media || typeof media !== 'object') return null;
  const entry = media.preview_proxy;
  return (entry && typeof entry === 'object' && entry.identity) ? entry : null;
}

/* BOM UTF-8 + CRLF — MỘT chỗ viết duy nhất, dùng cho cả lượt Lưu thường lẫn lượt Đóng gói.
 * BOM: nhiều trình phát (và Notepad của Windows) đọc .srt không BOM thành mojibake với tiếng
 * Việt, và với tiếng Trung/Nhật/Hàn thì hỏng nặng hơn nữa; mọi trình đọc .srt hiện đại đều bỏ
 * qua BOM nên thêm là an toàn. CRLF: chuẩn SubRip dùng CRLF, tệp chỉ-LF bị vài công cụ Windows
 * cũ hiện thành MỘT dòng dài — vẫn phát được nhưng người dùng mở ra tưởng hỏng.
 * Chuẩn hoá từ \n để không đẻ ra \r\r\n nếu chuỗi vào đã có CRLF sẵn. */
function writeSrtTo(filePath, content, writeFile = fs.writeFileSync) {
  const crlf = String(content == null ? '' : content).replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
  writeFile(filePath, `﻿${crlf}`, 'utf8');
  return filePath;
}

/* MỌI CHỖ trong payload có chứa đường dẫn file trên máy. Thiếu một chỗ là mở bản đã gói
 * lên vẫn còn một nhánh trỏ về máy cũ — và nhánh đó chỉ lộ ra khi người dùng thao tác đúng
 * vào nó (vd thêm video vào lane chính đọc source_path của clip). Đây là danh sách DUY NHẤT,
 * dùng chung cho cả chiều gói (tuyệt đối -> tương đối) lẫn chiều mở (tương đối -> tuyệt đối). */
function eachPathSite(payload, visit) {
  const media = payload?.media || {};
  (media.sources || []).forEach((entry) => {
    if (entry?.path) entry.path = visit(entry.path);
  });
  (media.editingAssets || []).forEach((entry) => {
    if (entry?.source_path) entry.source_path = visit(entry.source_path);
  });
  if (Array.isArray(media.main_lane_concat)) {
    media.main_lane_concat = media.main_lane_concat.map((p) => (p ? visit(p) : p));
  }
  const history = payload?.project?.history || {};
  (history.latestTimeline || []).forEach((row) => {
    if (row?.source_path) row.source_path = visit(row.source_path);
  });
  (history.projectVideoLibrary || []).forEach((item) => {
    if (item?.source_path) item.source_path = visit(item.source_path);
  });
  return payload;
}

/* CHỖ CÓ ĐƯỜNG DẪN NHƯNG **KHÔNG** ĐƯỢC QUYẾT ĐỊNH VIỆC CHÉP FILE.
 *
 * Đây là những bản SAO CHIẾU của một đường dẫn mà eachPathSite() ở trên đã lo: chúng phải
 * được viết lại y hệt, nhưng KHÔNG được đi vào collectMediaPaths(). Hai lý do tách ra:
 *
 *   · `main_lane_segments` là bảng đoạn của CHÍNH bộ nguồn trong `main_lane_concat` — thêm
 *     vào danh sách chép là chép lặp và (tệ hơn) uniqueName() có thể đặt cho nó một tên
 *     khác với tên mà `main_lane_concat` đã nhận;
 *   · `editingState.editingAssets[]` chứa CẢ asset của thư viện dựng sẵn (source:'library',
 *     nằm trong thư mục library/ của ứng dụng). Chúng CŨNG đi cùng gói, nhưng bằng một đường
 *     KHÁC HẲN: vào `Library/` theo đúng `rel_path`, không vào `Media/` — vì uniqueName() ở
 *     Media/ đổi tên để khỏi trùng, mà `rel_path` lại chính là khoá dùng để nhận ra "máy đích
 *     đã có sẵn tài nguyên này rồi". Xem khối "TÀI NGUYÊN THƯ VIỆN" bên dưới.
 *
 * BỎ SÓT CHỖ NÀY LÀ HỎNG NẶNG, KHÔNG PHẢI HỎNG NHẸ (đo trên dự án thật 2026-09-14):
 * `main_lane_segments[].source_path` không được viết lại -> mở bản đã gói thì bảng đoạn CŨ
 * mang đường dẫn máy cũ, còn bảng đoạn MỚI (backend vừa nối) mang đường dẫn trong gói.
 * `rebaseRows()` ghép hai bảng theo `source_path`, không khớp một dòng nào -> `continue` cho
 * TỪNG clip -> lane chính RỖNG TRẮNG. Và vì timeline không còn độ dài, mọi block phụ đề dồn
 * hết về mốc 0. Không một dòng lỗi nào được in ra. */
function eachMirrorPathSite(payload, visit) {
  const media = payload?.media || {};
  (media.main_lane_segments || []).forEach((seg) => {
    if (seg?.source_path) seg.source_path = visit(seg.source_path);
  });
  /* `editingAssets[].path` CỐ Ý không đụng tới: nó trỏ vào temp_uploads/editing_assets/ —
     thư mục RUNTIME bị /api/reset-project xoá sạch ở mỗi lượt mở dự án, và được dựng lại bởi
     reimportEditingAssets(). Viết nó thành tương đối là trỏ vào một tệp không có trong gói. */
  (payload?.project?.history?.editingState?.editingAssets || []).forEach((asset) => {
    if (asset?.source_path) asset.source_path = visit(asset.source_path);
  });
  return payload;
}

// Đường dẫn tuyệt đối DUY NHẤT của mọi media dự án đang dùng (đã khử trùng lặp).
function collectMediaPaths(payload) {
  const seen = new Set();
  eachPathSite(JSON.parse(JSON.stringify(payload || {})), (p) => {
    const value = String(p || '');
    if (value && path.isAbsolute(value)) seen.add(value);
    return value;
  });
  return Array.from(seen);
}

function sanitizeFolderName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'CrabbyCut Project';
}

/* Tên file trong Media/: giữ nguyên tên gốc để người dùng còn nhận ra clip của mình. Hai
 * file TRÙNG TÊN ở hai thư mục khác nhau (rất thường gặp: DJI/GoPro đánh số lại mỗi thẻ nhớ)
 * thì thêm hậu tố — không thì file sau đè file trước và dự án mất một cảnh. */
function uniqueName(basename, used) {
  const ext = path.extname(basename);
  const stem = path.basename(basename, ext);
  let candidate = basename;
  let index = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem} (${index})${ext}`;
    index += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/* ===== TÀI NGUYÊN THƯ VIỆN (library/: Video, Elements, Music, SFXs, luts) ==============
 *
 * VẤN ĐỀ. Asset thư viện KHÔNG được ghi theo đường dẫn tương đối như media của dự án — nó
 * được ghi theo `rel_path` trong library/ (vd "SFXs/[SFXs] Click-Mouse.MP3") và phát qua URL
 * công khai `/library/...` do backend static-serve. Giao ước đó chỉ đúng khi máy nào cũng có
 * ĐÚNG bộ thư viện ấy. Thực tế không phải vậy: thư viện được bổ sung dần, máy đồng nghiệp
 * chạy bản cũ hơn -> mở bản đã gói lên thì block overlay/nhạc/SFX im lặng không có nguồn,
 * LUT không được áp, và KHÔNG MỘT DÒNG LỖI NÀO được in ra (ensureLutLoaded chỉ `return false`,
 * <video> chỉ nhận 404). Đây chính là kiểu hỏng-âm-thầm mà đóng gói sinh ra để triệt.
 *
 * CÁCH LÀM. Gói thêm thư mục `Library/` GIỮ NGUYÊN cấu trúc thư mục con của library/, rồi
 * lúc MỞ thì KHÔI PHỤC ngược: tệp nào máy đích chưa có thì chép từ gói vào library/ của máy
 * đó. Chép vào library/ chứ không trỏ thẳng vào gói vì hai lẽ:
 *   · URL `/library/<rel>` là thứ DUY NHẤT preview/export/bake đọc được — backend chỉ
 *     static-serve library/ và temp_uploads/, không serve thư mục gói;
 *   · LUT thì trong payload CHỈ CÓ `adjustments.lut.id`, không có đường dẫn nào để viết lại
 *     — muốn nó sống lại thì `library/luts/<id>.cube` phải CÓ THẬT trên máy đích.
 * Đổi lại, máy đích được bổ sung đúng những tài nguyên dự án cần — cũng là điều người dùng
 * mong đợi khi nhận một gói dự án.
 *
 * KHÔNG ném vào `Media/`: Media/ là footage của NGƯỜI DÙNG, tên bị uniqueName() đổi cho khỏi
 * trùng và đường dẫn được viết lại thành tương đối. Tài nguyên thư viện phải giữ NGUYÊN VẸN
 * `rel_path` của nó, vì rel_path chính là khoá để nhận ra "máy này đã có sẵn rồi" (và để
 * Magic Fill khỏi nạp trùng). Trộn hai thứ vào một chỗ là mất khoá đó.
 */
const LIBRARY_DIR_NAME = 'Library';   // tên thư mục TRONG GÓI (library/ của máy nằm ngoài)
const LIBRARY_LUT_SUBDIR = 'luts';    // PHẢI khớp LUT_DIR ở backend/server.js

/* Tách đường dẫn tương đối thành các đoạn AN TOÀN. `null` = không dùng được: rỗng, hoặc có
 * `..` (một .crab do người khác gửi tới là dữ liệu KHÔNG TIN ĐƯỢC — `..` trong rel_path là
 * đường ghi đè file bất kỳ ngoài library/ lúc khôi phục). */
function safeRelSegments(rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return null;
  return parts;
}

function decodeUrlSegment(segment) {
  try { return decodeURIComponent(segment); } catch (_) { return segment; }
}

/* `rel_path` của một asset thư viện, chuẩn hoá về dấu `/`. Chuỗi rỗng = không phải asset
 * thư viện (hoặc không suy ra được vị trí trong library/ -> coi như không phải, đừng đoán).
 * Dự án đời cũ chưa có `rel_path` thì suy từ URL công khai `/library/<rel>` — cùng một thông
 * tin, chỉ khác dạng mã hoá. */
function libraryRelPathOf(asset) {
  if (!asset || typeof asset !== 'object' || asset.source !== 'library') return '';
  const direct = safeRelSegments(asset.rel_path);
  if (direct) return direct.join('/');
  const match = String(asset.url || '').split('?')[0].match(/^\/library\/(.+)$/);
  if (!match) return '';
  const fromUrl = safeRelSegments(match[1].split('/').map(decodeUrlSegment).join('/'));
  return fromUrl ? fromUrl.join('/') : '';
}

/* MỌI asset thư viện trong payload. Chỉ có MỘT chỗ chứa chúng: `editingState.editingAssets`.
 * `media.editingAssets` (bảng kê để verify + nạp lại lúc mở) CỐ TÌNH không có chúng — nó chỉ
 * nhận asset có `source_path`, mà asset thư viện thì không có (xem collectProjectPayload ở
 * index.html). Chính vì vậy chúng không đi qua đường re-link sẵn có và cần đường riêng này. */
function eachLibraryAsset(payload, visit) {
  (payload?.project?.history?.editingState?.editingAssets || []).forEach((asset) => {
    const rel = libraryRelPathOf(asset);
    if (rel) visit(asset, rel);
  });
}

/* Đường dẫn .cube trong library/ của một LUT id. `null` = id không dùng làm tên tệp được
 * (có dấu phân cách / `..`) -> bỏ qua thay vì dựng một đường dẫn leo ra ngoài luts/. */
function lutRelPath(lutId) {
  const id = String(lutId || '').trim();
  if (!id || /[\\/]/.test(id) || id === '.' || id === '..') return null;
  return `${LIBRARY_LUT_SUBDIR}/${id}.cube`;
}

/* MỌI LUT mà dự án đang dùng. Khác media, LUT KHÔNG có trường đường dẫn nào trong payload —
 * block chỉ giữ `adjustments.lut.id` rồi tra vào danh mục của máy đang chạy. Nên ở đây phải
 * QUÉT CẢ payload tìm hình dạng `{ lut: { id } }`: id ấy nằm rải ở block overlay, clip lane
 * chính, lớp Điều chỉnh, preset hiệu ứng… và danh sách "những chỗ có thể chứa" thì mỗi tính
 * năng mới lại dài thêm. Quét theo HÌNH DẠNG là cách duy nhất không bỏ sót âm thầm. */
function collectLutIds(payload) {
  const ids = new Set();
  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 32) return;
    if (Array.isArray(node)) { node.forEach((entry) => walk(entry, depth + 1)); return; }
    const lut = node.lut;
    if (lut && typeof lut === 'object' && typeof lut.id === 'string' && lut.id.trim()) {
      ids.add(lut.id.trim());
    }
    Object.keys(node).forEach((key) => walk(node[key], depth + 1));
  })(payload, 0);
  return Array.from(ids);
}

// Mọi tài nguyên thư viện dự án đang dùng, theo rel_path trong library/ (đã khử trùng lặp).
function collectLibraryRefs(payload) {
  const seen = new Set();
  const out = [];
  const add = (rel) => {
    if (!rel) return;
    const key = rel.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(rel);
  };
  eachLibraryAsset(payload, (_asset, rel) => add(rel));
  collectLutIds(payload).forEach((id) => add(lutRelPath(id)));
  return out;
}

/* library/ ĐANG DÙNG. Mặc định trỏ đúng thư mục thật (main.js require thẳng module này,
 * không truyền gì) — test thì dựng một thư viện giả để không đụng thư viện thật.
 *
 * PHẢI KHỚP LIBRARY_DIR CỦA BACKEND, nếu không thì gói dự án sẽ đi tìm tài nguyên ở một
 * thư mục khác thư mục mà người dùng thấy trong panel Thư viện — và hỏng đó IM LẶNG: mọi
 * tệp rơi vào `missing`, gói xuất ra vẫn "thành công" nhưng thiếu toàn bộ media.
 * Ở bản đóng gói, thư viện nằm NGOÀI thư mục cài (thư mục cài bị xoá sạch mỗi lần cập
 * nhật); chạy từ mã nguồn thì vẫn là library/ của dự án.
 *
 * HÀM chứ không phải hằng: `CRAB_USER_DATA_DIR` được đặt trong lúc main.js khởi động, mà
 * module này có thể đã được require xong từ trước. Một hằng lượng giá lúc nạp sẽ chốt nhầm
 * đường dẫn cũ, và lỗi đó phụ thuộc thứ tự require — kiểu lỗi không ai truy ra được. */
function defaultLibraryDir() {
  return process.env.CRAB_USER_DATA_DIR
    ? path.join(path.resolve(process.env.CRAB_USER_DATA_DIR), 'library')
    : path.join(__dirname, '..', 'library');
}

function createProjectPackager({
  copyFile = fs.copyFileSync,
  writeFile = fs.writeFileSync,
  libraryDir = null,
} = {}) {
  const libraryRoot = String(libraryDir || defaultLibraryDir());

  /* Chép tài nguyên thư viện vào `<gói>/Library/<rel>`, GIỮ NGUYÊN tên và cấu trúc thư mục
   * con. Tệp không còn trong library/ của máy đang gói -> báo ra ở `missing`, không làm hỏng
   * cả lượt gói (đúng chính sách của media). */
  function collectLibraryFiles(payload, projectDir) {
    const copied = [];
    const missing = [];
    let bytes = 0;
    for (const rel of collectLibraryRefs(payload)) {
      const segments = rel.split('/');
      const source = path.join(libraryRoot, ...segments);
      let stat = null;
      try { stat = fs.statSync(source); } catch (_) { stat = null; }
      if (!stat || !stat.isFile()) { missing.push(rel); continue; }
      const target = path.join(projectDir, LIBRARY_DIR_NAME, ...segments);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      copyFile(source, target);
      copied.push(rel);
      bytes += stat.size;
    }
    return { copied, missing, bytes };
  }

  /* Khôi phục tài nguyên thư viện lúc MỞ, và gắn lại `path` cho asset thư viện.
   *
   * `path` của asset thư viện là đường dẫn TUYỆT ĐỐI vào library/ của máy ĐÃ LƯU dự án —
   * máy khác cài ứng dụng ở chỗ khác là nó trỏ vào hư vô, và backend chặn ngay ở cổng vào
   * (resolveAudioSourcePath chỉ nhận đường dẫn nằm trong library/ hoặc temp_uploads/ của
   * CHÍNH máy đang chạy) -> mất sóng âm, mất trích khung. Nên nó được DỰNG LẠI ở đây từ
   * rel_path, chứ không phải được lưu rồi mang đi.
   *
   * Chạy cho MỌI tệp .crab, không riêng bản đã gói: một tệp .crab thường chép sang máy khác
   * cũng cần đúng việc này, và với máy đã có sẵn thư viện thì nó là đủ. */
  function restoreLibraryAssets(payload, crabFilePath, exists, report) {
    const packDir = path.join(path.dirname(crabFilePath), LIBRARY_DIR_NAME);
    let changed = false;
    const settled = new Map();   // rel -> đường dẫn thật ('' = không có)
    // Trả về đường dẫn thật trong library/ của máy này, hoặc '' nếu không có và không khôi phục được.
    const ensureLocal = (rel) => {
      if (settled.has(rel)) return settled.get(rel);
      const result = resolveOne(rel);
      settled.set(rel, result);
      return result;
    };
    const resolveOne = (rel) => {
      const segments = rel.split('/');
      const local = path.join(libraryRoot, ...segments);
      if (exists(local)) return local;
      const packed = path.join(packDir, ...segments);
      if (!exists(packed)) { report.missing.push(rel); return ''; }
      try {
        fs.mkdirSync(path.dirname(local), { recursive: true });
        copyFile(packed, local);
        report.restored.push(rel);
        return local;
      } catch (error) {
        /* library/ chỉ-đọc (bản cài đặt ở Program Files chẳng hạn) -> KHÔNG ném lỗi làm hỏng
         * lượt mở. Dự án vẫn mở được, chỉ thiếu đúng tài nguyên này; báo ra để người dùng biết
         * vì sao một block im lặng, thay vì để họ tự đoán. */
        report.failed.push(rel);
        return '';
      }
    };
    eachLibraryAsset(payload, (asset, rel) => {
      const local = ensureLocal(rel);
      if (!local || asset.path === local) return;
      asset.path = local;
      changed = true;
    });
    /* LUT: không có gì trong payload để viết lại — chỉ cần `library/luts/<id>.cube` CÓ THẬT
     * thì danh mục màu của máy đích tự liệt kê nó ra và ensureLutLoaded() nạp được. */
    collectLutIds(payload).forEach((id) => {
      const rel = lutRelPath(id);
      if (rel) ensureLocal(rel);
    });
    return changed;
  }

  /* Gói payload + media vào <destDir>/<projectName>/.
   *
   * Trả { projectDir, crabPath, copied, missing, bytes, libraryCopied, libraryMissing }.
   * `missing` là những file không còn
   * trên đĩa: KHÔNG làm hỏng cả lượt gói (dự án 50 clip mà thiếu 1 vẫn đáng gói), đường dẫn
   * của chúng giữ nguyên TUYỆT ĐỐI — viết lại thành tương đối là trỏ vào một chỗ chưa từng
   * có file, biến "thiếu file, re-link được" thành "hỏng hẳn". */
  function packageProject({ payloadJson, destDir, projectName, subtitleSrt = '', previewProxyPath = '' }) {
    const payload = JSON.parse(payloadJson);
    const folder = sanitizeFolderName(projectName);
    const projectDir = path.join(destDir, folder);
    const mediaDir = path.join(projectDir, MEDIA_DIR_NAME);
    fs.mkdirSync(mediaDir, { recursive: true });

    const used = new Set();
    const mapping = new Map();     // path tuyệt đối -> path tương đối trong gói
    const missing = [];
    let bytes = 0;

    for (const absolute of collectMediaPaths(payload)) {
      let stat = null;
      try { stat = fs.statSync(absolute); } catch (_) { stat = null; }
      if (!stat || !stat.isFile()) { missing.push(absolute); continue; }
      const name = uniqueName(path.basename(absolute), used);
      copyFile(absolute, path.join(mediaDir, name));
      mapping.set(absolute, `${MEDIA_DIR_NAME}/${name}`);
      bytes += stat.size;
    }

    const remap = (p) => mapping.get(String(p || '')) || p;
    eachPathSite(payload, remap);
    eachMirrorPathSite(payload, remap);   // bản sao chiếu của chính những đường dẫn trên

    /* TÀI NGUYÊN THƯ VIỆN đi cùng gói (xem khối "TÀI NGUYÊN THƯ VIỆN" ở đầu tệp). Chép vào
     * `Library/` theo đúng rel_path, KHÔNG vào `Media/`. */
    const library = collectLibraryFiles(payload, projectDir);
    bytes += library.bytes;
    const packedLibrary = new Set(library.copied.map((rel) => rel.toLowerCase()));
    eachLibraryAsset(payload, (asset, rel) => {
      /* `path` tuyệt đối của máy đang gói KHÔNG có nghĩa gì ở máy khác — nó được dựng lại từ
       * rel_path lúc mở (restoreLibraryAssets). Chỉ xoá khi tài nguyên ĐÃ THỰC SỰ nằm trong
       * gói; không gói được thì giữ nguyên, đúng chính sách của media ("thiếu file nhưng còn
       * re-link được" vẫn hơn "trỏ vào chỗ chưa từng có file"). */
      if (packedLibrary.has(rel.toLowerCase())) delete asset.path;
    });

    const crabPath = path.join(projectDir, `${folder}.crab`);

    /* PHỤ ĐỀ ĐI CÙNG GÓI. Nội dung .srt do renderer DỰNG LẠI từ chính block đang có trên
     * timeline rồi truyền xuống đây — KHÔNG chép tệp .srt cũ trên đĩa. Hai lý do:
     *   · tệp cũ có thể đã CŨ hơn timeline (người dùng sửa chữ / kéo mốc phụ đề rồi bấm
     *     "Đóng gói" mà chưa Lưu) — chép nó là gói một bản phụ đề lệch với video;
     *   · tệp cũ có thể không còn trên đĩa (dự án chép từ máy khác sang), mà phụ đề thì vẫn
     *     nằm nguyên trong .crab — chép-hay-không lẽ ra không được quyết định số phận nó.
     * Tên tệp bám theo tên gói (`<Tên gói>.srt` cạnh `<Tên gói>.crab`) để lượt Lưu tiếp theo
     * sau khi mở bản đã gói ghi ĐÈ lên đúng tệp này, không đẻ thêm bản thứ hai.
     *
     * Đường dẫn ghi TƯƠNG ĐỐI như mọi thứ khác trong gói -> mang gói đi đâu cũng đúng
     * (resolvePayloadPaths giải lại lúc mở). */
    const subtitleState = subtitleStateOf(payload);
    let srtPath = null;
    if (subtitleState) {
      const text = String(subtitleSrt || '');
      if (text.trim()) {
        srtPath = writeSrtTo(path.join(projectDir, `${folder}.srt`), text, writeFile);
        subtitleState.srt_path = `${folder}.srt`;
      } else {
        /* Không có phụ đề để ghi -> XOÁ đường dẫn thay vì giữ đường dẫn tuyệt đối của máy cũ.
         * Khác chính sách của media (media thiếu thì giữ tuyệt đối để còn re-link được) vì
         * .srt KHÔNG phải tư liệu gốc: nó dựng lại được từ timeline ở lượt Lưu kế tiếp. Giữ
         * lại một đường dẫn chết chỉ để panel hiện ra một dòng "Tệp phụ đề:" trỏ vào hư vô. */
        delete subtitleState.srt_path;
      }
    }

    /* BẢN PROXY XEM TRƯỚC đi cùng gói. Mở bản đã gói thì backend nhận lại nó thay vì encode
     * lại từ đầu — với video 16 phút 1440p đó là vài phút mỗi lần mở.
     *
     * CHÉP TỆP, chứ không dựng lại như .srt: proxy là kết quả encode hàng phút, không phải
     * thứ sinh ra từ payload trong một nhịp. Đổi lại phải chấp nhận nó có thể đã cũ — nên
     * DANH TÍNH trong payload mới là thứ quyết định: mở lên, backend so danh tính ấy với
     * file nối nó vừa dựng, lệch một byte là bỏ proxy và encode lại (xem tryAdoptPreviewProxy).
     * Chép nhầm một bản cũ vì thế chỉ tốn dung lượng gói, không bao giờ sai hình. */
    const proxyEntry = previewProxyOf(payload);
    let proxyPath = null;
    if (proxyEntry) {
      delete proxyEntry.path;   // trong gói, đường dẫn luôn suy từ chỗ đặt .crab
      const source = String(previewProxyPath || '');
      let ok = false;
      try { ok = !!source && fs.statSync(source).isFile(); } catch (_) { ok = false; }
      if (ok) {
        proxyPath = projectSidecarPath(crabPath, SIDECAR_PREVIEW_PROXY);
        copyFile(source, proxyPath);
      } else {
        // Không có tệp proxy để gói -> bỏ luôn danh tính, đừng hứa một thứ không có trong gói.
        delete payload.media.preview_proxy;
      }
    }

    return {
      payloadJson: JSON.stringify(payload),
      projectDir,
      crabPath,
      srtPath,
      proxyPath,
      copied: mapping.size,
      missing,
      bytes,
      libraryCopied: library.copied,
      libraryMissing: library.missing,
    };
  }

  /* Chiều ngược lại, gọi lúc ĐỌC tệp .crab: đường dẫn tương đối được giải về tuyệt đối theo
   * thư mục chứa chính tệp đó. Nhờ vậy renderer luôn chỉ thấy đường dẫn tuyệt đối như xưa —
   * không một dòng nào ở index.html phải biết đến chuyện đóng gói. */
  function resolvePayloadPaths(payloadJson, crabFilePath, { exists = fs.existsSync, library = null } = {}) {
    const baseDir = path.dirname(crabFilePath);
    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (_) {
      return payloadJson;   // tệp hỏng thì để đường đọc sẵn có báo lỗi, đừng nuốt mất
    }
    let changed = false;
    const toAbsolute = (p) => {
      const value = String(p || '');
      if (!value || path.isAbsolute(value)) return value;
      changed = true;
      return path.resolve(baseDir, value);
    };
    eachPathSite(payload, toAbsolute);
    eachMirrorPathSite(payload, toAbsolute);
    /* `library` là SỔ BÁO CÁO cho người gọi (đã khôi phục gì / còn thiếu gì) — main.js đưa
     * xuống renderer để hiện một dòng thông báo. Không truyền cũng chạy: việc khôi phục vẫn
     * làm, chỉ không ai đọc kết quả. */
    const report = library || { restored: [], missing: [], failed: [] };
    if (restoreLibraryAssets(payload, crabFilePath, exists, report)) changed = true;
    if (resolveSubtitlePath(payload, crabFilePath, exists)) changed = true;
    if (resolvePreviewProxyPath(payload, crabFilePath, exists)) changed = true;
    return changed ? JSON.stringify(payload) : payloadJson;
  }

  /* RE-LINK TỆP .srt. Trả true nếu có sửa. Ba nước, theo đúng thứ tự:
   *
   *   1. Đường dẫn TƯƠNG ĐỐI (bản đã đóng gói) -> giải theo thư mục chứa .crab. Giống hệt
   *      cách media được giải ở trên.
   *   2. Đường dẫn TUYỆT ĐỐI nhưng tệp KHÔNG CÒN ở đó — trường hợp thường gặp nhất: người
   *      dùng kéo tệp .crab sang thư mục khác trong Explorer, hoặc chép dự án sang máy khác.
   *      Tìm "<tên .crab>.srt" NGAY CẠNH tệp .crab; có thì nhận. Đây chính là chỗ mà media
   *      phải bật hộp thoại re-link hỏi người dùng, còn .srt thì không cần hỏi: giao ước đặt
   *      tên (.srt cùng tên, cùng thư mục với .crab) đủ để suy ra không mơ hồ.
   *   3. Không tìm thấy gì -> XOÁ khoá. Phụ đề vẫn còn nguyên trong .crab (chúng là block
   *      text thật), nên lượt Lưu kế tiếp sẽ ghi lại .srt. Giữ một đường dẫn chết chỉ để
   *      panel hiện "Tệp phụ đề: D:\MayCu\..." là nói dối người dùng.
   */
  function resolveSubtitlePath(payload, crabFilePath, exists) {
    const state = subtitleStateOf(payload);
    const raw = String(state?.srt_path || '');
    if (!state || !raw) return false;
    const baseDir = path.dirname(crabFilePath);
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
    if (exists(resolved)) {
      if (resolved === raw) return false;
      state.srt_path = resolved;
      return true;
    }
    const beside = projectSidecarPath(crabFilePath, SIDECAR_SUBTITLE);
    if (exists(beside)) { state.srt_path = beside; return true; }
    delete state.srt_path;
    return true;
  }

  /* Gắn đường dẫn THẬT của bản proxy vào payload, suy từ chỗ đặt tệp .crab. Payload chỉ
   * mang danh tính; đường dẫn sinh ra ở đây và chỉ khi tệp CÓ THẬT — thiếu tệp thì bỏ hẳn
   * khoá để backend không phải phân biệt "không có proxy" với "có mà trỏ vào hư vô". */
  function resolvePreviewProxyPath(payload, crabFilePath, exists) {
    const entry = previewProxyOf(payload);
    if (!entry) return false;
    const beside = projectSidecarPath(crabFilePath, SIDECAR_PREVIEW_PROXY);
    if (exists(beside)) {
      if (entry.path === beside) return false;
      entry.path = beside;
      return true;
    }
    if (!('path' in entry)) return false;
    delete entry.path;
    return true;
  }

  return {
    packageProject, resolvePayloadPaths, collectMediaPaths, subtitleStateOf, writeSrtTo, MEDIA_DIR_NAME,
    eachPathSite, eachMirrorPathSite, previewProxyOf, projectSidecarPath,
    SIDECAR_SUBTITLE, SIDECAR_PREVIEW_PROXY,
    collectLibraryRefs, collectLutIds, libraryRelPathOf, LIBRARY_DIR_NAME,
  };
}

module.exports = {
  createProjectPackager,
  ...createProjectPackager(),
};
