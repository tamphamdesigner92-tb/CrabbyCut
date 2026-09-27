#!/usr/bin/env node
/* BẢN FFMPEG GHIM CHO BỘ CÀI — NGUỒN SỰ THẬT DUY NHẤT.
 *
 * VÌ SAO PHẢI GHIM (hai hồi quy thật, đo 2026-09-27 trên BtbN `latest` N-126889):
 *   1. FFmpeg master XOÁ `-filter_complex_script` (commit 07407fff61, có trong 9.0) ->
 *      "Unrecognized option", mọi lượt export chết. (Mã nay đã chuyển sang `-/filter_complex`,
 *      nhưng một bản `latest` không ghim thì lần sau lại có thể xoá thứ khác.)
 *   2. BtbN master/n9.0/n8.1 dựng với nv-codec-headers 13.1 -> NVENC đòi driver >= 610.
 *      GTX 9xx/10xx dừng ở nhánh driver R580, nên mất hẳn NVENC và export tụt về CPU.
 * Trước đây bộ cài tải `ffmpeg-master-latest` và chỉ kiểm `-version`, nên máy cài mới nhận
 * đúng bản hỏng mà không ai biết.
 *
 * VÌ SAO BẢN NÀY: Gyan 8.1.1 full_build, gói `-shared` (101 MB, nhẹ hơn 2,5 lần bản tĩnh):
 *   - có đủ filter CrabbyCut dùng: zscale, libplacebo, lut3d, scale_cuda, drawtext,
 *     sendcmd, tpad, xfade (bản "essentials" của gyan.dev THIẾU libplacebo — đừng đổi sang);
 *   - NVENC chạy trên GTX 1060 driver 582.28; hwaccel cuda/d3d11va/qsv/amf đều có;
 *   - `-shared` = ffmpeg/ffprobe dùng chung các DLL nằm cạnh exe trong `bin/`. Windows nạp
 *     DLL từ thư mục của exe trước, nên chép nguyên `bin/` là đủ.
 *
 * ĐỔI BẢN GHIM: sửa cả bốn trường, tự tính SHA-256 của file tải về và so với digest GitHub
 * công bố (API releases), chạy lại toàn bộ test export trên bản mới. `id` đổi thì
 * `verifyRuntimeQuick()` coi bản đã cài là lỗi thời và cửa sổ thiết lập tải bản mới — các
 * thư viện AI đã cài KHÔNG bị tải lại.
 */
'use strict';

const FFMPEG_PIN = {
  id: 'gyan-8.1.1-full_build-shared',
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-full_build-shared.zip',
  fileName: 'ffmpeg-8.1.1-full_build-shared.zip',
  // Tự tính 2026-09-27, khớp digest GitHub công bố cho asset này.
  sha256: '4296b396bdfd5fbc3dfc75ab4c8703354a56963232d65c4182993543df2d2f45',
  sizeBytes: 101083228,
  // Dòng đầu của `ffmpeg -version` phải bắt đầu bằng chuỗi này (kiểm sau khi giải nén).
  versionPrefix: 'ffmpeg version 8.1.1-full_build-www.gyan.dev',
};

module.exports = { FFMPEG_PIN };
