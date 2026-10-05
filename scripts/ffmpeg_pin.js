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
 * VÌ SAO BẢN NÀY (từ 2026-10-03): bản CrabbyCut TỰ DỰNG — FFmpeg n8.1.1 + bộ lọc CUDA
 * `crabgeo_cuda`/`crabblend_cuda` để máy có GPU NVIDIA xuất video trên GPU (mục 1.21 của
 * docs/KE_HOACH_TOI_UU_EXPORT_WIN.md, "Xuất video bằng GPU" trong docs/APP_INTERNALS.md).
 * Kịch bản build + bản vá ở `sourceUrl`; README.txt trong zip ghi commit FFmpeg, mã băm bản vá
 * và phiên bản từng thư viện đi kèm. Gói `-shared` như bản Gyan 8.1.1 dùng trước đó:
 *   - có đủ filter CrabbyCut dùng: zscale, libplacebo, lut3d, scale_cuda, drawtext, sendcmd,
 *     tpad, xfade, crabgeo_cuda, crabblend_cuda (build.sh từ chối đóng gói nếu thiếu);
 *   - nv-codec-headers 12.2 (không phải 13.x): NVENC chạy trên GTX 1060 driver 582.28;
 *   - CUDA/NVENC/NVDEC/AMF/QSV nạp động; DLL nhập tĩnh chỉ là DLL của Windows (build.sh kiểm),
 *     kèm cả bộ nạp Vulkan vì libplacebo nhập tĩnh nó — máy không có driver Vulkan vẫn chạy được,
 *     chỉ tonemap HDR lùi về zscale;
 *   - `-shared` = ffmpeg/ffprobe dùng chung các DLL nằm cạnh exe trong `bin/`. Windows nạp
 *     DLL từ thư mục của exe trước, nên chép nguyên `bin/` là đủ.
 * Bản ghim trước: Gyan 8.1.1 full_build-shared (id `gyan-8.1.1-full_build-shared`) — muốn quay lại
 * thì lấy bốn trường cũ trong lịch sử git của tệp này.
 *
 * macOS (từ 2026-10-05): CÙNG nguồn FFmpeg n8.1.1 + bản vá, dựng bằng build-macos.sh của cùng repo
 * (Apple Silicon, macOS 11+, VideoToolbox thay CUDA; không libplacebo -> tonemap HDR đi zscale như
 * máy Windows không có Vulkan). Cùng chuỗi `ffmpeg -version`, nên mọi phép tính của CrabbyCut cho
 * cùng kết quả trên hai máy — ffmpeg Homebrew 8.1 thì không (docs/DONG_BO_WIN_MAC.md mục 5). Máy dev
 * và CI cài bằng `npm run ffmpeg:install` (scripts/install_ffmpeg.js).
 *
 * ĐỔI BẢN GHIM: sửa mọi trường (build.sh của repo nguồn in sẵn ở cuối bước package), tự tính
 * SHA-256 của file TẢI VỀ từ `url` và so với số build.sh in ra, chạy lại toàn bộ test export
 * trên bản mới. `id` đổi thì `verifyRuntimeQuick()` coi bản đã cài là lỗi thời và cửa sổ thiết
 * lập tải bản mới — các thư viện AI đã cài KHÔNG bị tải lại.
 */
'use strict';

const WIN32_PIN = {
  // .2 (2026-10-03): crabgeo_cuda có LUT 3D (lut/lut2/mix) — clip/lớp phủ có LUT xuất được trên GPU.
  id: 'n8.1.1-crabbycut.2-win64-gpl-shared',
  url: 'https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut/releases/download/n8.1.1-crabbycut.2/ffmpeg-n8.1.1-crabbycut.2-win64-gpl-shared.zip',
  fileName: 'ffmpeg-n8.1.1-crabbycut.2-win64-gpl-shared.zip',
  // build.sh tính lúc đóng gói (2026-10-03); đã so với file tải về từ `url`: khớp.
  sha256: '410ae0b571aa73957c97bd7c7a7ea18fd0245d6c477d9e7e9f27baf8e9b776e9',
  sizeBytes: 33504908,
  // Dòng đầu của `ffmpeg -version` phải bắt đầu bằng chuỗi này (kiểm sau khi giải nén).
  // Dấu cách cuối để `crabbycut.1` không khớp `crabbycut.10`.
  versionPrefix: 'ffmpeg version n8.1.1-crabbycut.2 ',
  // Mã nguồn tương ứng của bản dựng (kịch bản build + bản vá), dẫn trong THIRD-PARTY-NOTICES.md.
  sourceUrl: 'https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut/tree/n8.1.1-crabbycut.2',
};

const DARWIN_ARM64_PIN = {
  // build-macos.sh, 2026-10-05: cùng nguồn với WIN32_PIN; thư viện ngoài tĩnh, chỉ phụ thuộc macOS 11+.
  id: 'n8.1.1-crabbycut.2-macos-arm64-gpl-shared',
  url: 'https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut/releases/download/n8.1.1-crabbycut.2-macos/ffmpeg-n8.1.1-crabbycut.2-macos-arm64-gpl-shared.zip',
  fileName: 'ffmpeg-n8.1.1-crabbycut.2-macos-arm64-gpl-shared.zip',
  sha256: '37feb81dddebd272cb0dd7c9660db2aed3e84080f586587a01ee23849e808a95',
  sizeBytes: 16958858,
  versionPrefix: 'ffmpeg version n8.1.1-crabbycut.2 ',
  sourceUrl: 'https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut/tree/n8.1.1-crabbycut.2-macos',
};

/* Bản ghim theo `${process.platform}-${process.arch}`. Thiếu mục = nền tảng chưa có bản ghim
 * (Mac Intel): install_ffmpeg.js báo rõ thay vì cài nhầm bản của máy khác. */
const FFMPEG_PINS = {
  'win32-x64': WIN32_PIN,
  'darwin-arm64': DARWIN_ARM64_PIN,
};

function pinFor(platform = process.platform, arch = process.arch) {
  return FFMPEG_PINS[`${platform}-${arch}`] || null;
}

/* `FFMPEG_PIN` = bản của BỘ CÀI Windows (scripts/setup_runtime.js, runtime_paths.js,
 * THIRD-PARTY-NOTICES). Giữ tên cũ để bộ cài không đổi hành vi; mã chạy trên mọi nền tảng
 * dùng pinFor(). */
const FFMPEG_PIN = WIN32_PIN;

module.exports = { FFMPEG_PIN, FFMPEG_PINS, pinFor };
