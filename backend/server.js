// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const multer = require('multer');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

/* FFMPEG CỦA BẢN CÀI ĐẶT PHẢI VÀO PATH TRƯỚC KHI CÓ LỆNH NÀO CHẠY.
 *
 * Toàn bộ tệp này (và cả C++ sidecar, vì nó thừa kế env của backend) gọi `ffmpeg`/`ffprobe`
 * bằng TÊN TRẦN. Trên máy dev điều đó chạy được vì người phát triển đã tự cài ffmpeg vào
 * PATH; trên máy người dùng cuối thì không. Bộ cài (scripts/setup_runtime.js) tải một bản
 * ffmpeg riêng về thư mục runtime, và đây là chỗ duy nhất nối nó vào — nối ở đây thay vì ở
 * electron/main.js để `npm run backend:dev` cũng được hưởng.
 *
 * NỐI VÀO ĐẦU PATH: bản riêng của ứng dụng được kiểm là có đủ filter (`zscale`,
 * `libplacebo`), còn bản ngẫu nhiên trên máy người dùng thì không có gì bảo đảm. Khi bộ
 * cài đã quyết định dùng chính ffmpeg của máy thì thư mục này không tồn tại và đoạn dưới
 * không làm gì cả. */
try {
  const runtimeFfmpegDir = require(path.join(PROJECT_ROOT, 'scripts', 'runtime_paths.js')).ffmpegDir();
  if (fs.existsSync(runtimeFfmpegDir)) {
    const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (!current.some((entry) => entry.toLowerCase() === runtimeFfmpegDir.toLowerCase())) {
      process.env.PATH = [runtimeFfmpegDir, ...current].join(path.delimiter);
    }
  }
} catch (error) {
  console.error('[backend] Không nối được FFmpeg của bản cài vào PATH:', error.message);
}

/* GỐC DỮ LIỆU NGƯỜI DÙNG — KHÔNG ĐƯỢC NẰM TRONG THƯ MỤC CÀI ĐẶT.
 *
 * Trình gỡ cài đặt do electron-builder sinh ra, ở nhánh CẬP NHẬT, dời toàn bộ $INSTDIR
 * sang thư mục tạm rồi `RMDir /r $INSTDIR` — không chừa ngoại lệ nào (xem
 * node_modules/app-builder-lib/templates/nsis/uninstaller.nsh). Nên mọi thứ của NGƯỜI DÙNG
 * để trong thư mục cài đặt sẽ mất sạch ở lần tự cập nhật đầu tiên: cài đặt ứng dụng, thư
 * viện tài nguyên họ tự thêm, báo cáo dự án, cache bóc băng (tốn hàng chục phút để dựng
 * lại), và cả dữ liệu làm việc của dự án đang mở.
 *
 * `CRAB_USER_DATA_DIR` do electron/main.js đặt, và CHỈ khi `app.isPackaged`. Không có biến
 * đó nghĩa là đang chạy TỪ MÃ NGUỒN — giữ nguyên các thư mục trong thư mục dự án, nếu không
 * thì `npm start` đột ngột không thấy thư viện mà người phát triển đang dùng, và `npm test`
 * ghi vào hồ sơ người dùng thật. */
const USER_DATA_ROOT = process.env.CRAB_USER_DATA_DIR
  ? path.resolve(process.env.CRAB_USER_DATA_DIR)
  : PROJECT_ROOT;

// CRAB_TEMP_DIR: chỉ dùng cho TEST. Test export phải xoá sạch thư mục tạm trước khi chạy,
// mà thư mục tạm mặc định đang giữ temp_input.mp4 + nguồn của DỰ ÁN ĐANG MỞ (hàng trăm MB) —
// chạy test là mất dữ liệu người dùng. Cho test trỏ sang thư mục riêng.
const TEMP_DIR = process.env.CRAB_TEMP_DIR
  ? path.resolve(process.env.CRAB_TEMP_DIR)
  : path.join(USER_DATA_ROOT, 'temp_uploads');
const THUMBNAIL_DIR = path.join(TEMP_DIR, 'thumbnails');
const EDITING_ASSET_DIR = path.join(TEMP_DIR, 'editing_assets');
const GENERATED_TEXT_ASSET_DIR = path.join(EDITING_ASSET_DIR, 'generated_text');
const PREVIEW_PROXY_NAME = 'preview_proxy.mp4';
const ASR_CACHE_DIR = path.join(USER_DATA_ROOT, 'asr_cache');
const ASR_CACHE_VERSION = 'asr-platform-runtime-v2';
const STATIC_DIR = path.join(PROJECT_ROOT, 'static');
const EDITING_FONT_DIR = path.join(STATIC_DIR, 'fonts', 'google');
const REPORTS_DIR = path.join(USER_DATA_ROOT, 'reports');
const LIBRARY_DIR = path.join(USER_DATA_ROOT, 'library');
// LUT màu: bộ dựng sẵn (sinh bởi scripts/generate_preset_luts.js) + .cube người dùng
// nhập vào, đặt CÙNG một chỗ để /library đã static-serve sẵn là frontend fetch được.
const LUT_DIR = path.join(LIBRARY_DIR, 'luts');
// .cube do frontend BAKE (HSL 8 dải ∘ LUT người dùng) cho từng block khi export.
// Nằm trong temp_uploads vì là dữ liệu của một lần xuất, không phải tài sản dự án.
const COLOR_LUT_BAKE_DIR = path.join(TEMP_DIR, 'color_luts');
// Cache landmark khuôn mặt cho Retouch (xem retouchCachePath). Đặt trong TEMP_DIR nên
// được dọn cùng dữ liệu tạm của dự án.
const RETOUCH_CACHE_DIR = path.join(TEMP_DIR, 'retouch_faces');
// Mặt nạ (ảnh xám PNG) do frontend bake cho panel Điều chỉnh, dùng ở khâu export.
const COLOR_MASK_DIR = path.join(TEMP_DIR, 'color_masks');
// Chỗ trống của lut3d trong chuỗi filter màu (PHẢI khớp ColorAdjust.LUT3D_SLOT). Frontend
// đánh dấu ĐÚNG VỊ TRÍ cần chèn, backend mới biết đường dẫn file .cube để thay vào.
const COLOR_LUT3D_SLOT = '__LUT3D__';
// Cache sóng âm (.pk) — xem khối "SÓNG ÂM THẬT" bên dưới. Đặt NGOÀI temp_uploads để
// asset thư viện không mất cache mỗi lần tạo dự án mới.
const PEAKS_CACHE_DIR = path.join(USER_DATA_ROOT, 'peaks_cache');
const PEAKS_FORMAT_VERSION = 1;          // PHẢI khớp version trong header .pk của sidecar
const PEAKS_MAX_PARALLEL_JOBS = 2;       // không giành hết CPU với ASR/export
const PEAKS_MAX_ATTEMPTS = 2;            // hỏng 2 lần thì thôi (tránh poll vô hạn)
const PEAKS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/* Cache PROXY LQ của asset overlay — xem khối "PROXY LQ CHO ASSET OVERLAY" bên dưới.
 * Cùng lý do đặt ngoài temp_uploads như peaks_cache: asset thư viện dùng lại qua nhiều dự
 * án, không được mất proxy mỗi lần tạo dự án mới. */
const PROXY_CACHE_DIR = path.join(USER_DATA_ROOT, 'proxy_cache');
const PROXY_FORMAT_VERSION = 1;          // tăng khi ĐỔI cách mã hoá proxy -> khoá cũ hết hiệu lực
const PROXY_MAX_PARALLEL_JOBS = 1;       // job nền: MỘT tại một thời điểm, xem pumpAssetProxyQueue
const PROXY_MAX_ATTEMPTS = 2;            // hỏng 2 lần thì thôi (tránh poll vô hạn)
const PROXY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/* BỘ NHỚ ĐỆM FILE ĐÃ NỐI (media cache kiểu Premiere) — xem concatCacheLookup().
 * Cùng lý do đặt NGOÀI temp_uploads như hai cache trên: /api/reset-project xoá sạch
 * temp_uploads ngay trước khi mở dự án, nên thứ gì nằm trong đó thì mở lại là mất. */
// CRAB_CONCAT_CACHE_DIR: chỉ dùng cho TEST, cùng lý do với CRAB_TEMP_DIR ở trên — mỗi mục
// cache là một file vài trăm MB, để test ghi vào cache thật là làm phình bộ nhớ đệm của
// người dùng bằng dữ liệu của fixture.
const CONCAT_CACHE_DIR = process.env.CRAB_CONCAT_CACHE_DIR
  ? path.resolve(process.env.CRAB_CONCAT_CACHE_DIR)
  : path.join(USER_DATA_ROOT, 'concat_cache');
/* Tăng khi ĐỔI cách nối -> khoá cũ hết hiệu lực.
 * v2 (2026-09-08): bản v1 có thể đã nối bằng bản chuẩn hoá của MỘT FILE KHÁC (xem khối chú
 * thích ở normalizeVideoForConcat) — mọi mục cache sinh ra trước bản sửa đều đáng ngờ.
 * v3 (2026-09-09): khổ khung nối đổi từ "khổ nguồn đầu tiên" sang KHUNG BAO của mọi nguồn
 * (xem concatTargetSize), và bảng đoạn nay mang thêm vùng ảnh thật (`content`). Mục cache
 * cũ vừa sai khổ vừa thiếu trường — dùng lại là preview vẽ khung transform sai chỗ.
 * v4 (2026-09-09): nhịp khung file nối đổi từ ghi cứng 30 sang nhịp CAO NHẤT của bộ nguồn
 * (xem concatTargetFps). Mọi mục cache cũ là bản đã LƯỢC KHUNG — dùng lại thì bản sửa
 * không có tác dụng gì, mà không có dấu hiệu nào để người dùng biết.
 * v5 (2026-09-09): file nối nay được chuẩn hoá về PTS 0 (RestampVideoStartToZero trong
 * sidecar). Mục cache cũ có luồng hình bắt đầu ở PTS > 0 — đúng thứ gây lệch MỘT KHUNG ở
 * điểm nối, cả khi xuất lẫn khi xem trước. Dùng lại là bản sửa không có tác dụng. */
const CONCAT_CACHE_VERSION = 5;
const CONCAT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LIBRARY_CATEGORIES = { video: 'Video', elements: 'Elements', sfxs: 'SFXs', music: 'Music' };
// Cài đặt ứng dụng (bảng Cài đặt trong Menu). Đặt ở gốc dự án — KHÔNG phải dữ liệu runtime
// như temp_uploads/peaks_cache — để cấu hình đi theo thư mục dự án và sao lưu được.
const SETTINGS_DIR = path.join(USER_DATA_ROOT, 'settings');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'app_settings.json');
const PROGRESS_FILE = path.join(USER_DATA_ROOT, 'progress.txt');
const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
// .svg nằm ở đây vì lúc NHẬP nó được vẽ ra PNG (xem /api/editing-assets/rasterize) — từ
// sau bước đó nó là ảnh raster như mọi ảnh khác. KHÔNG thêm .ai/.eps: Chromium không vẽ
// được nên không rasterize được, mà ffmpeg cũng không giải mã được -> thẻ hỏng + export lỗi.
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);
const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac']);
/* Ảnh mà ffmpeg giải mã được — dùng cho đường PROXY/THUMBNAIL ảnh. `.svg` bị loại CÓ CHỦ Ý:
 * lúc nhập nó đã được Chromium vẽ ra PNG (xem /api/editing-assets/rasterize) nhưng đuôi file
 * có thể vẫn là .svg, và ffmpeg không giải mã SVG — đưa vào là job proxy hỏng im lặng. SVG
 * cũng là vector, nhẹ, không có gì để thu nhỏ.
 * TRÙNG GIÁ TRỊ với RETOUCH_IMAGE_EXTENSIONS ngay bên dưới nhưng CỐ Ý tách: hai danh sách trả
 * lời hai câu hỏi khác nhau ("ảnh nào Retouch nhận" vs "ảnh nào thu nhỏ được"), nên chúng phải
 * đổi được độc lập. Gộp lại là một ngày nào đó sửa một bên rồi vỡ bên kia. */
const RASTER_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
/* Cạnh dài tối đa của PROXY ẢNH dùng cho preview. Chọn 1920 vì đó là trần mà khung xem trước
 * có thể hiển thị ở mức 100%; muốn nét hơn thì bấm HQ, y hệt proxy video.
 * ĐO ĐƯỢC trên ảnh máy ảnh thật (xem docs/APP_INTERNALS.md): 6240×3512 = 21,9 MP tốn 84 MB
 * RGBA sau giải mã và 1,12 ms raster mỗi lượt vẽ; bản 1,5 MP tốn 6 MB và 0,01 ms. */
const IMAGE_PROXY_MAX_EDGE = 1920;
// Cạnh dài của thumbnail ảnh trong panel Tệp phương tiện (thẻ chỉ rộng ~60px).
const IMAGE_THUMB_MAX_EDGE = 320;
/* Định dạng CÓ THỂ mang kênh trong suốt. Bản dẫn xuất (proxy/thumbnail) của chúng phải là
 * .png: trước đây mọi proxy ảnh đều ghi ra .jpg, mà JPEG không có alpha nên sticker/logo PNG
 * nền trong hiện NỀN ĐEN trên preview ở chế độ LQ — bản xuất thì vẫn đúng vì nó đọc file gốc.
 * JPEG nguồn giữ .jpg (nhỏ hơn nhiều, và vốn không có gì trong suốt để mất). */
const ALPHA_IMAGE_EXTENSIONS = new Set(['.png', '.webp']);

function imageDerivativeExt(filePath) {
  return ALPHA_IMAGE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase()) ? 'png' : 'jpg';
}
/* RETOUCH đọc file bằng ffmpeg TRỰC TIẾP (sidecar auto_reframe), nên danh sách của nó
 * phải là ẢNH RASTER — KHÔNG dùng lại ALLOWED_IMAGE_EXTENSIONS. `.svg` nằm trong danh
 * sách kia là hợp lý cho đường NHẬP asset (Chromium vẽ ra PNG ngay lúc nhập, xem
 * /api/editing-assets/rasterize), nhưng ở đây KHÔNG có bước rasterize nào: ffmpeg không
 * có bộ giải mã SVG -> `no decoder found for: svg` ở tận khâu track, tức lỗi lộ ra muộn
 * và trông như lỗi nhận diện mặt. Chặn ngay ở cổng vào cho đúng chỗ. */
const RETOUCH_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ALLOWED_EDITING_ASSET_EXTENSIONS = new Set([
  ...ALLOWED_VIDEO_EXTENSIONS,
  ...ALLOWED_IMAGE_EXTENSIONS,
  ...ALLOWED_AUDIO_EXTENSIONS,
]);
// Mỗi family: thư mục riêng, file Regular dùng làm fallback (text export là PNG nên không bắt buộc).
const EDITING_FONT_FILES = new Map([
  ['Archivo', 'Archivo/Archivo_400Regular.ttf'],
  ['Archivo Black', 'ArchivoBlack/ArchivoBlack_400Regular.ttf'],
  ['Arimo', 'Arimo/Arimo_400Regular.ttf'],
  ['Barlow', 'Barlow/Barlow_400Regular.ttf'],
  ['Bebas Neue', 'BebasNeue/BebasNeue_400Regular.ttf'],
  ['Bricolage Grotesque', 'BricolageGrotesque/BricolageGrotesque_400Regular.ttf'],
  ['DM Sans', 'DMSans/DMSans_400Regular.ttf'],
  ['Figtree', 'Figtree/Figtree_400Regular.ttf'],
  ['Fira Sans', 'FiraSans/FiraSans_400Regular.ttf'],
  ['Fjalla One', 'FjallaOne/FjallaOne_400Regular.ttf'],
  ['Heebo', 'Heebo/Heebo_400Regular.ttf'],
  ['IBM Plex Sans', 'IBMPlexSans/IBMPlexSans_400Regular.ttf'],
  ['Inter', 'Inter/Inter_400Regular.ttf'],
  ['Jost', 'Jost/Jost_400Regular.ttf'],
  ['Kanit', 'Kanit/Kanit_400Regular.ttf'],
  ['Karla', 'Karla/Karla_400Regular.ttf'],
  ['Lato', 'Lato/Lato_400Regular.ttf'],
  ['Libre Baskerville', 'LibreBaskerville/LibreBaskerville_400Regular.ttf'],
  ['Lora', 'Lora/Lora_400Regular.ttf'],
  ['Manrope', 'Manrope/Manrope_400Regular.ttf'],
  ['Merriweather', 'Merriweather/Merriweather_400Regular.ttf'],
  ['Montserrat', 'Montserrat/Montserrat_400Regular.ttf'],
  ['Mulish', 'Mulish/Mulish_400Regular.ttf'],
  ['Noto Sans', 'NotoSans/NotoSans_400Regular.ttf'],
  /* Ba font CJK là bản BIẾN THIÊN (một file, trục wght 100–900) — xem EDITING_FONTS ở
     editing-runtime.js. Bảng này chỉ phục vụ nhánh drawtext của ffmpeg, mà nhánh đó không
     bao giờ chạm tới block text: renderer luôn gửi kèm `rendered_text_png` nên overlay đã
     thành ảnh trước khi tới đây (xem materializeRenderedTextPng). Vẫn khai để
     normalizeEditingFontFamily không âm thầm hạ ba family này xuống 'Inter' trong metadata. */
  ['Noto Sans SC', 'NotoSansSC/NotoSansSC_Variable.ttf'],
  ['Noto Sans JP', 'NotoSansJP/NotoSansJP_Variable.ttf'],
  ['Noto Sans KR', 'NotoSansKR/NotoSansKR_Variable.ttf'],
  ['Noto Serif', 'NotoSerif/NotoSerif_400Regular.ttf'],
  ['Nunito', 'Nunito/Nunito_400Regular.ttf'],
  ['Nunito Sans', 'NunitoSans/NunitoSans_400Regular.ttf'],
  ['Open Sans', 'OpenSans/OpenSans_400Regular.ttf'],
  ['Oswald', 'Oswald/Oswald_400Regular.ttf'],
  ['Outfit', 'Outfit/Outfit_400Regular.ttf'],
  ['PT Sans', 'PTSans/PTSans_400Regular.ttf'],
  ['PT Serif', 'PTSerif/PTSerif_400Regular.ttf'],
  ['Playfair Display', 'PlayfairDisplay/PlayfairDisplay_400Regular.ttf'],
  ['Plus Jakarta Sans', 'PlusJakartaSans/PlusJakartaSans_400Regular.ttf'],
  ['Poppins', 'Poppins/Poppins_400Regular.ttf'],
  ['Prompt', 'Prompt/Prompt_400Regular.ttf'],
  ['Quicksand', 'Quicksand/Quicksand_400Regular.ttf'],
  ['Raleway', 'Raleway/Raleway_400Regular.ttf'],
  ['Roboto', 'Roboto/Roboto_400Regular.ttf'],
  ['Roboto Condensed', 'RobotoCondensed/RobotoCondensed_400Regular.ttf'],
  ['Roboto Mono', 'RobotoMono/RobotoMono_400Regular.ttf'],
  ['Roboto Slab', 'RobotoSlab/RobotoSlab_400Regular.ttf'],
  ['Rubik', 'Rubik/Rubik_400Regular.ttf'],
  ['Saira', 'Saira/Saira_400Regular.ttf'],
  ['Share Tech', 'ShareTech/ShareTech_400Regular.ttf'],
  ['Smooch Sans', 'SmoochSans/SmoochSans_400Regular.ttf'],
  ['Source Sans 3', 'SourceSans3/SourceSans3_400Regular.ttf'],
  ['Titillium Web', 'TitilliumWeb/TitilliumWeb_400Regular.ttf'],
  ['Ubuntu', 'Ubuntu/Ubuntu_400Regular.ttf'],
  ['Work Sans', 'WorkSans/WorkSans_400Regular.ttf'],
]);
/* CỔNG MẶC ĐỊNH 17219, KHÔNG PHẢI 8000 (đổi 2026-09-10).
 * 8000 là cổng mặc định của quá nhiều thứ khác (python -m http.server, Django, FastAPI,
 * uvicorn…) — trên chính máy dev đã đụng "Dynamic AI Learning Hub" (`python backend.py`).
 * Đụng cổng ở đây KHÔNG chỉ là "không khởi động được": xem checkBackendHealth() của
 * electron/main.js — CrabbyCut từng coi bất kỳ ai trả lời trên cổng đó là backend của
 * mình rồi nạp thẳng giao diện của app lạ.
 * 17219 = 0x4343 ("CC"): nằm ngoài dải 3000-9000 mà mọi công cụ dev chen nhau, và vẫn
 * dưới dải cổng động của Windows (bắt đầu ở 49152) nên không bị hệ điều hành mượn tạm.
 * Đổi được bằng biến môi trường BACKEND_PORT. */
const DEFAULT_BACKEND_PORT = 17219;
const PORT = Number(process.env.BACKEND_PORT || DEFAULT_BACKEND_PORT);
const HOST = process.env.BACKEND_HOST || '127.0.0.1';
const WINDOWS_ASR_ENGINE = 'faster_whisper';
const WINDOWS_ASR_ROLLBACK_ENGINE = 'whisper.cpp';
/* MỘT MODEL DUY NHẤT trên Windows: Large v3 Turbo (khớp macOS, nơi core_logic.py ghim
 * mlx-community/whisper-large-v3-turbo). Distil Large v3 đã bỏ hẳn.
 * `min_vram_mb: 0` là CÓ Ý — Turbo là lựa chọn duy nhất nên phải chạy được ở mọi cấu hình,
 * không GPU thì rơi về CPU/int8. Bảng này phải KHỚP MODEL_CONFIGS của
 * asr/windows_faster_whisper_sidecar.py; nó chỉ dùng cho đường suy giảm (khi không gọi
 * được sidecar), còn số liệu thật luôn lấy từ sidecar. */
const WINDOWS_ASR_DEFAULT_MODEL = 'large-v3-turbo';
const WINDOWS_ASR_MODELS = new Map([
  ['large-v3-turbo', {
    id: 'large-v3-turbo',
    label: 'Large v3 Turbo',
    min_vram_mb: 0,
    default: true,
  }],
]);
const activeChildProcesses = new Set();
/* Tiến trình con đang ĐỌC temp_input.mp4 (job sóng âm + job proxy LQ của lane chính).
 *
 * VÌ SAO PHẢI THEO DÕI RIÊNG: hai job này chạy NỀN sau mỗi lượt nạp và có thể kéo dài hàng
 * phút với dự án nặng. Lượt nạp KẾ TIẾP (mở dự án khác, thêm video vào lane chính) phải ghi
 * đè chính file chúng đang đọc — trên Windows đó là EPERM, và cả lượt nạp chết giữa chừng
 * (đo được trong tests/scripts/main_lane_concat_offsets.js). Kết quả của chúng lúc đó đằng
 * nào cũng vô nghĩa (file sắp có nội dung khác) nên dừng là đúng, không mất gì. */
const mainVideoReaders = new Set();
let httpServer = null;
let shuttingDown = false;
let previewProxyGeneration = 0;
// Chỉ cho MỘT lượt xuất video chạy tại một thời điểm (xem /api/export-video).
let exportInFlight = false;

const previewProxyState = {
  status: 'idle',
  preview_video_url: null,
  path: null,
  size_bytes: null,
  size_human: null,
  duration_ms: null,
  queued_at: null,
  started_at: null,
  ready_at: null,
  error: null,
  // Danh tính của BẢN NỐI mà proxy này được dựng ra từ đó (xem previewProxyIdentity).
  identity: null,
};

let core = null;
try {
  core = require(path.join(PROJECT_ROOT, 'native', 'addon'));
} catch (error) {
  console.error('[backend] Cannot load native addon:', error.message);
}

/* KHỬ TIẾNG ỒN: backend dựng chuỗi filter FFmpeg từ CHÍNH module mà preview dùng, nên
 * hai bên không thể lệch bảng quy đổi. Cố ý KHÔNG cho frontend gửi thẳng chuỗi filter
 * (khác với color_adjust, nơi chuỗi buộc phải sinh ở frontend vì phụ thuộc LUT/keyframe):
 * ở đây chỉ có 3 con số qua dây, nên không có bề mặt chèn filter lạ nào cả. */
const AudioDenoise = require(path.join(STATIC_DIR, 'js', 'audio-denoise.js'));
/* TỐC ĐỘ BLOCK: cùng lý do như trên — chuẩn hoá bằng CHÍNH module mà frontend dùng để
 * tính bề rộng block, nếu không thì timeline và bản xuất hiểu `rate` khác nhau. Sidecar
 * nhận SỐ (rate + pitch_correct) rồi tự dựng setpts/atempo, xem BuildAtempoFilter. */
const ClipSpeed = require(path.join(STATIC_DIR, 'js', 'clip-speed.js'));
/* CÀI ĐẶT ỨNG DỤNG: cùng lý do — `normalize()` của module này là chốt chặn duy nhất, chạy
 * ở CẢ hai đầu. Frontend chuẩn hoá trước khi gửi, backend chuẩn hoá lại trước khi ghi đĩa,
 * nên file settings/app_settings.json không thể chứa cấu hình sai dù ai ghi vào nó. */
const AppSettings = require(path.join(STATIC_DIR, 'js', 'app-settings.js'));
/* LUT MÀU: chỉ cần `filterPath` — cách escape đường dẫn bên trong filtergraph phải
 * GIỐNG HỆT frontend, nếu không thì chuỗi filter do hai bên ghép lại tự chọi nhau. */
const ColorAdjust = require(path.join(STATIC_DIR, 'js', 'color-adjust.js'));
/* KHỔ HÌNH LANE CHÍNH: khung nối + vùng ảnh thật + hệ số vừa-khung. Cùng lý do như trên,
 * và ở đây còn gắt hơn: ba phía (file nối do backend dựng, sprite preview, filtergraph
 * export) phải dùng ĐÚNG MỘT phép tính, lệch một pixel là bản xuất ra sai im lặng. */
const MainLane = require(path.join(STATIC_DIR, 'js', 'main-lane.js'));
const subtitleJobs = require('./subtitle-jobs.js');
/* PYTHON SIDECAR: cùng lý do — phép chọn interpreter và env UTF-8 nằm ở MỘT chỗ
 * (scripts/python_command.js), dùng chung với npm script lẫn test. Trước đây mỗi
 * chỗ tự chép một bản và mỗi bản thiếu một mảnh khác nhau. */
const { pythonCommand, pythonEnv } = require(path.join(PROJECT_ROOT, 'scripts', 'python_command.js'));

const projectMetrics = {
  sources: null,
  transcribe: null,
  export: null,
  errors: [],
  activity: false,
  reportWritten: false,
  lastReportPath: null,
};

function ensureCore() {
  if (!core) {
    throw new Error('Native addon core_c.node chưa build. Chạy npm run build:addon.');
  }
  return core;
}

function setStatus(message) {
  /* progress.txt chỉ là file trạng thái THAM KHẢO (do /api/status đọc lại, và chính chỗ đọc
   * đó đã bọc try/catch sẵn). Trên Windows một lần ghi có thể trượt vì TRANH CHẤP MỞ FILE:
   * errno UNKNOWN/-4094 = sharing violation — Defender đang quét file, hoặc nhiều backend
   * cùng ghi một file trong repo (mỗi test của `npm test` dựng một backend riêng).
   * Bản cũ ghi KHÔNG bọc lỗi, nên một lần trượt là NÉM ra giữa request và GIẾT LUÔN tiến
   * trình backend — mất cả phiên làm việc chỉ vì không ghi nổi một dòng chữ trạng thái.
   * Đã gặp thật: `npm test` đỏ ngẫu nhiên ở một test khác nhau mỗi lần chạy.
   * Mất một lần cập nhật trạng thái thì chấp nhận được; chết backend thì không. */
  try {
    fs.writeFileSync(PROGRESS_FILE, message, 'utf8');
  } catch (error) {
    console.warn(`[status] không ghi được progress.txt: ${error.code || error.message}`);
  }
  console.log(message);
}

/* AUTO SUBTITLE: tiêm phụ thuộc thay vì để module job require ngược server.js (require
 * vòng tròn). `transcribe` là điểm nối DUY NHẤT tới ASR, nên job không phải biết gì về
 * engine / cache / nền tảng. `trackChild`/`untrackChild` nối vào chính sổ tiến trình con
 * của server để lượt tắt backend (shutdown -> killActiveChildren) dọn được cả ffmpeg của
 * job đang chạy dở. */
subtitleJobs.init({
  tempDir: TEMP_DIR,
  setStatus,
  trackChild: (child) => activeChildProcesses.add(child),
  untrackChild: (child) => activeChildProcesses.delete(child),
  resolveSourcePath: (raw) => resolveSubtitleSourcePath(raw),
  transcribe: (audioPath, opts) => transcribeSubtitleMix(audioPath, opts),
});

function ensureDirs() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
  fs.mkdirSync(EDITING_ASSET_DIR, { recursive: true });
  fs.mkdirSync(ASR_CACHE_DIR, { recursive: true });
  fs.mkdirSync(STATIC_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  fs.mkdirSync(PEAKS_CACHE_DIR, { recursive: true });
  fs.mkdirSync(PROXY_CACHE_DIR, { recursive: true });
  fs.mkdirSync(CONCAT_CACHE_DIR, { recursive: true });
  fs.mkdirSync(LUT_DIR, { recursive: true });
  fs.mkdirSync(COLOR_LUT_BAKE_DIR, { recursive: true });
  fs.mkdirSync(COLOR_MASK_DIR, { recursive: true });
  Object.values(LIBRARY_CATEGORIES).forEach((sub) => fs.mkdirSync(path.join(LIBRARY_DIR, sub), { recursive: true }));
  seedPresetLuts();
}

/* CHÉP BỘ LUT DỰNG SẴN TỪ THƯ MỤC CÀI ĐẶT SANG THƯ VIỆN CỦA NGƯỜI DÙNG.
 *
 * VÌ SAO PHẢI CHÉP: `library/luts/` là thư mục HỖN HỢP — vừa chứa 22 preset do
 * scripts/generate_preset_luts.js của dự án sinh ra (tài sản của ứng dụng, đi kèm bản cài),
 * vừa chứa `.cube` do người dùng tự nhập (xem /api/color-luts/import, nó ghi thẳng vào
 * LUT_DIR). Hai loại đó có vòng đời ngược nhau:
 *   - preset phải ĐI THEO bản cài, để bản mới mang thêm preset mới;
 *   - LUT người dùng nhập phải SỐNG QUA cập nhật.
 * Vì thư mục cài đặt bị xoá sạch mỗi lần cập nhật, LUT_DIR buộc phải nằm ở phía người
 * dùng — và preset được gieo sang đó ở mỗi lần khởi động.
 *
 * CHỈ CHÉP TỆP CHƯA CÓ. Ghi đè thì người dùng sửa một preset xong là mất sửa đổi ở lần mở
 * sau. Đổi lại: xoá một preset thì lần mở sau nó quay lại — chấp nhận được, vì đó là tài
 * nguyên dựng sẵn chứ không phải dữ liệu của họ. */
function seedPresetLuts() {
  const shipped = path.join(PROJECT_ROOT, 'library', 'luts');
  if (path.resolve(shipped) === path.resolve(LUT_DIR)) return;   // chạy từ mã nguồn
  let names;
  try { names = fs.readdirSync(shipped); } catch (_) { return; } // bản cài không kèm preset
  for (const name of names) {
    const target = path.join(LUT_DIR, name);
    if (fs.existsSync(target)) continue;
    try {
      fs.copyFileSync(path.join(shipped, name), target);
    } catch (error) {
      console.warn(`[library] không gieo được preset LUT ${name}: ${error.message}`);
    }
  }
}

/* Dung lượng + số tệp của một thư mục cache. Duyệt đệ quy nhưng các thư mục này chỉ có
 * 1–2 tầng nên không cần giới hạn độ sâu. Thư mục chưa tồn tại -> 0, không ném lỗi. */
function dirUsage(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    entries.forEach((entry) => {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); return; }
      try { bytes += fs.statSync(full).size; files += 1; } catch (_) { /* bỏ qua */ }
    });
  };
  walk(dir);
  // KHÔNG dùng formatBytes(): hàm đó chỉ hiển thị GB trở lên (dành cho dung lượng video
  // nguồn), nên cache 17 MB sẽ hiện "0.0 GB". Ở đây cần thang đủ từ KB.
  return { bytes, files, human: humanBytes(bytes) };
}

function humanBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = value / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/* ---- CÀI ĐẶT ỨNG DỤNG: đọc/ghi settings/app_settings.json ----
 * File hỏng/thiếu/không đọc được đều rơi về mặc định thay vì ném lỗi: cấu hình là thứ phụ,
 * không được phép làm app không mở lên được. */
function readAppSettings() {
  try {
    return AppSettings.normalize(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch (_) {
    return AppSettings.defaults();
  }
}

// Ghi NGUYÊN TỬ (tmp -> rename) như cách sidecar ghi file .pk: mất điện giữa chừng thì
// file cũ còn nguyên, không sinh ra file JSON cụt làm hỏng cấu hình.
function writeAppSettings(raw) {
  const normalized = AppSettings.normalize(raw);
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
  return normalized;
}

// Dọn thư mục chứa PNG sequence hoạt ảnh text đã render (In→Hold→Out). Các phiên
// export có thể để lại rất nhiều frame tạm; gọi lúc khởi động (xoá dấu vết phiên
// trước) và lúc tắt server (dọn phiên hiện tại). An toàn nếu thư mục chưa tồn tại.
function cleanGeneratedTextAssets() {
  try {
    if (fs.existsSync(GENERATED_TEXT_ASSET_DIR)) {
      fs.rmSync(GENERATED_TEXT_ASSET_DIR, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn('[backend] cleanGeneratedTextAssets error:', error?.message || error);
  }
}

function normalizeAsrEngine(value) {
  if (process.platform === 'win32') {
    if (windowsWhisperCppRollbackEnabled()) return WINDOWS_ASR_ROLLBACK_ENGINE;
    void value;
    return WINDOWS_ASR_ENGINE;
  }
  void value;
  return 'mlx_whisper';
}

function windowsWhisperCppRollbackEnabled() {
  return String(process.env.WINDOWS_ASR_ENGINE || '').trim().toLowerCase().replace(/[-\s]+/g, '_') === 'whisper_cpp';
}

function normalizeWindowsAsrModel(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (WINDOWS_ASR_MODELS.has(raw)) return raw;
  /* MỌI thứ khác — kể cả các tên cũ của Distil ('distil', 'distil-large-v3') — quy về model
   * duy nhất. Dự án .crab cũ và settings đã lưu còn mang tên Distil, nên phải nhận chứ
   * không được từ chối, nếu không thì mở dự án cũ lên là chết bóc băng.
   * Đối xứng với normalize_model_id() ở sidecar. */
  return WINDOWS_ASR_DEFAULT_MODEL;
}

function windowsAsrModelRoot() {
  if (process.env.WINDOWS_ASR_MODEL_DIR) return path.resolve(process.env.WINDOWS_ASR_MODEL_DIR);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'AI Video Auto Cutter', 'asr_models');
  }
  return path.join(PROJECT_ROOT, 'asr_models', 'windows');
}

function windowsAsrSidecarPath() {
  return path.join(PROJECT_ROOT, 'asr', 'windows_faster_whisper_sidecar.py');
}

function tempJsonPath(prefix) {
  return path.join(TEMP_DIR, `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}.json`);
}

function cleanInlineText(value, maxLength = 500) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function finiteNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanMetadataText(value, maxLength = 1000) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .slice(0, maxLength);
}

function cleanScriptMarkerItem(item, type) {
  if (!item || typeof item !== 'object') return null;
  const rawStart = finiteNumberOrNull(item.raw_start);
  const rawEnd = finiteNumberOrNull(item.raw_end);
  const line = finiteNumberOrNull(item.line);
  const column = finiteNumberOrNull(item.column);
  const cleaned = {
    text: cleanMetadataText(item.text, 1000),
    raw_start: rawStart,
    raw_end: rawEnd,
    line,
    column,
  };
  if (type === 'note') {
    cleaned.clean_insert_offset = finiteNumberOrNull(item.clean_insert_offset);
  } else {
    cleaned.clean_start = finiteNumberOrNull(item.clean_start);
    cleaned.clean_end = finiteNumberOrNull(item.clean_end);
  }
  return cleaned;
}

function parseScriptMetadata(value) {
  if (value === undefined || value === null || value === '') return null;
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const notes = (Array.isArray(raw.notes) ? raw.notes : [])
    .slice(0, 1000)
    .map((item) => cleanScriptMarkerItem(item, 'note'))
    .filter(Boolean);
  const boldRanges = (Array.isArray(raw.bold_ranges) ? raw.bold_ranges : [])
    .slice(0, 1000)
    .map((item) => cleanScriptMarkerItem(item, 'bold'))
    .filter(Boolean);
  return {
    source_type: cleanInlineText(raw.source_type || '', 50),
    source_name: cleanInlineText(raw.source_name || '', 255),
    raw_sha1: cleanInlineText(raw.raw_sha1 || '', 64),
    clean_sha1: cleanInlineText(raw.clean_sha1 || '', 64),
    stale: raw.stale === true,
    notes,
    bold_ranges: boldRanges,
  };
}

function summarizeScriptMetadata(metadata) {
  if (!metadata) return null;
  return {
    source_type: metadata.source_type || null,
    source_name: metadata.source_name || null,
    stale: metadata.stale === true,
    note_count: Array.isArray(metadata.notes) ? metadata.notes.length : 0,
    bold_range_count: Array.isArray(metadata.bold_ranges) ? metadata.bold_ranges.length : 0,
  };
}

function parseClientStartedAtMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function sha1Text(value) {
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex');
}

function elapsedMs(startedAtMs) {
  return Math.max(0, Date.now() - startedAtMs);
}

function isoNow() {
  return new Date().toISOString();
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return 'Chưa có dữ liệu';
  const seconds = value / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} giây (${Math.round(value)} ms)`;
}

function formatSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return 'Chưa có dữ liệu';
  const hh = Math.floor(value / 3600);
  const mm = Math.floor((value % 3600) / 60);
  const ss = value % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${ss.toFixed(3).padStart(6, '0')} (${value.toFixed(3)} giây)`;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return 'Không xác định';
  const units = ['B', 'GB', 'TB'];
  const gb = value / (1024 ** 3);
  if (gb < 1024) return `${gb.toFixed(1)} GB`;
  return `${(gb / 1024).toFixed(2)} ${units[2]}`;
}

/* Chạy một lệnh CHỈ để biết nó có chạy nổi hay không (dò khả năng của ffmpeg trên máy
 * này). Không dùng commandText được: nó trả '' cho CẢ lệnh thành công mà im lặng LẪN lệnh
 * chết, mà đây đúng là trường hợp lệnh thành công thì không in gì. */
function commandSucceeds(command, args, timeout = 20000) {
  try {
    execFileSync(command, args, { timeout, stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function commandText(command, args, timeout = 2500) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return '';
  }
}

function mediaDurationSeconds(filePath) {
  const text = commandText('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], 5000);
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/* ĐỘ DÀI CỦA MỘT ĐOẠN TRONG FILE NỐI, ĐO BẰNG LUỒNG HÌNH — KHÔNG BẰNG CONTAINER.
 *
 * `format=duration` là MAX của mọi luồng. Rãnh tiếng AAC gần như luôn dài hơn rãnh hình một
 * chút (gói cuối đệm cho đủ 1024 mẫu), nên container dài hơn hình. Nhưng concat demuxer xếp
 * HÌNH của file sau ngay sau khung cuối của file trước, tức theo độ dài HÌNH. Cộng dồn theo
 * container thì bảng đoạn khai mốc MUỘN hơn chỗ ảnh thật đổi -> phần đuôi của block trước
 * rơi vào ảnh của block sau: đúng lỗi "1 khung lẫn cảnh" ở điểm nối.
 *
 * ĐO ĐƯỢC (tests/scripts/seam_frame_accuracy.js): nguồn 71 khung @60000/1001 (=1.184517s)
 * kèm tiếng 1.2s -> container 1.207s. Bảng đoạn cũ khai mốc 1.207 trong khi ảnh đổi ở
 * 1.184517 — lệch 1.35 khung. (Nguồn của người dùng tình cờ có tiếng NGẮN hơn hình nên
 * không lộ, nhưng cùng một lỗi.)
 *
 * Ưu tiên SỐ KHUNG / NHỊP KHUNG: mọi bản chuẩn hoá nay cùng một nhịp khung
 * (concatTargetFps), nên cộng dồn số khung là phép cộng SỐ NGUYÊN — không trôi dù bao nhiêu
 * đoạn. Thiếu nb_frames thì lùi về duration của LUỒNG HÌNH, rồi mới tới container. */
function mediaVideoSegmentSeconds(filePath) {
  const text = commandText('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_frames,avg_frame_rate,duration',
    '-of', 'json',
    filePath,
  ], 5000);
  try {
    const stream = (JSON.parse(text || '{}').streams || [])[0] || {};
    const frames = Number(stream.nb_frames);
    const rate = parseFfprobeRate(stream.avg_frame_rate);
    if (Number.isFinite(frames) && frames > 0 && rate?.value > 0) return frames / rate.value;
    const streamDuration = Number(stream.duration);
    if (Number.isFinite(streamDuration) && streamDuration > 0) return streamDuration;
  } catch (_) { /* rơi về container bên dưới */ }
  return mediaDurationSeconds(filePath);
}

function parseFfprobeRate(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '0/0') return null;
  const [numRaw, denRaw] = raw.split('/');
  const num = Number(numRaw);
  const den = Number(denRaw || 1);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) return null;
  return {
    text: den === 1 ? String(Math.round(num)) : `${num}/${den}`,
    value: num / den,
  };
}

function parseFfprobeRotation(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function displayDimensionsForRotation(width, height, rotation) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return { width: null, height: null };
  }
  const normalized = ((Math.round(rotation || 0) % 360) + 360) % 360;
  if (normalized === 90 || normalized === 270) {
    return { width: height, height: width };
  }
  return { width, height };
}

function mediaVideoInfo(filePath) {
  const text = commandText('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate:stream_tags=rotate:stream_side_data=rotation',
    '-of', 'json',
    filePath,
  ], 5000);
  try {
    const payload = JSON.parse(text || '{}');
    const stream = Array.isArray(payload.streams) ? payload.streams[0] : null;
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    let rotation = parseFfprobeRotation(stream?.tags?.rotate);
    if (rotation === null) {
      for (const sideData of (stream?.side_data_list || [])) {
        rotation = parseFfprobeRotation(sideData?.rotation);
        if (rotation !== null) break;
      }
    }
    const display = displayDimensionsForRotation(width, height, rotation || 0);
    const fps = parseFfprobeRate(stream?.avg_frame_rate);
    return {
      width: display.width,
      height: display.height,
      coded_width: Number.isFinite(width) && width > 0 ? width : null,
      coded_height: Number.isFinite(height) && height > 0 ? height : null,
      rotation: rotation || 0,
      fps: fps?.text || null,
      fps_value: fps?.value || null,
    };
  } catch (_) {
    return { width: null, height: null, fps: null, fps_value: null };
  }
}

function mediaHasAudio(filePath) {
  const text = commandText('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    filePath,
  ], 3000);
  return !!String(text || '').trim();
}

function publicTempUrl(filePath) {
  const rel = path.relative(TEMP_DIR, filePath).split(path.sep).map(encodeURIComponent).join('/');
  return `/temp_uploads/${rel}`;
}

// Địa chỉ phát file NGUỒN (nằm ngoài thư mục dự án). Khai một chỗ vì cả payload asset,
// listing thư viện video lẫn route đều dùng — lệch nhau một ký tự là thẻ trắng trơn.
function sourceFileUrl(filePath) {
  return `/api/source-file?path=${encodeURIComponent(path.resolve(filePath))}`;
}

function sourceThumbUrl(filePath) {
  return `/api/source-thumb?path=${encodeURIComponent(path.resolve(filePath))}`;
}

function safeAssetName(originalName, usedNames) {
  const raw = String(originalName || '').replace(/\\/g, '/');
  const parsed = path.parse(path.basename(raw) || 'asset');
  const ext = parsed.ext || '';
  let candidate = `${parsed.name || 'asset'}${ext}`;
  let suffix = 1;
  while (usedNames.has(candidate) || fs.existsSync(path.join(EDITING_ASSET_DIR, candidate))) {
    candidate = `${parsed.name || 'asset'}_${suffix}${ext}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

/* Mô tả một file thành asset Editing.
 *
 * HAI KIỂU ĐỊA CHỈ:
 *   - COPY (mặc định): file đã nằm trong temp_uploads/editing_assets -> URL tĩnh
 *     /temp_uploads/... do express.static phục vụ.
 *   - LINK (`external: true`): file nằm ở thư mục của người dùng, KHÔNG chép. Chép cả
 *     một thư mục footage là nhân đôi hàng chục GB, nên asset kiểu này trỏ thẳng vào
 *     nguồn qua /api/source-file (có danh sách trắng, xem registerSourceAccess).
 *
 * `lazyProbe` bỏ qua ffprobe + trích thumbnail: nạp cả một cây thư mục thì hai việc đó
 * nhân với số file là treo request. Thiếu số đo thì frontend hỏi /api/media-probe đúng
 * lúc cần (kéo xuống timeline), còn thumbnail đi qua /api/source-thumb khi thẻ lọt tầm nhìn.
 */
async function editingAssetPayload(filePath, preferredKind = '', options = {}) {
  const { external = false, lazyProbe = false, groupPath = null } = options;
  const stat = fs.statSync(filePath);
  const kind = editingAssetKindForPath(filePath);
  const probe = !lazyProbe;
  const videoInfo = (probe && (kind === 'media_video' || kind === 'media_image'))
    ? mediaVideoInfo(filePath)
    : { width: null, height: null, fps: '', fps_value: null };
  const duration = (probe && kind !== 'media_image') ? mediaDurationSeconds(filePath) : null;
  const hasAudio = kind === 'media_video' || kind === 'audio'
    ? (probe ? mediaHasAudio(filePath) : true)
    : false;
  const publicUrl = external
    ? sourceFileUrl(filePath)
    : `${publicTempUrl(filePath)}?v=${Math.trunc(stat.mtimeMs)}`;
  let thumbnailUrl = '';
  if (kind === 'media_video') {
    thumbnailUrl = lazyProbe
      ? sourceThumbUrl(filePath)
      : (await createOrGetThumbnail(filePath) || '');
  } else if (kind === 'media_image') {
    thumbnailUrl = await imageThumbnailUrlFor(filePath, publicUrl, { lazyProbe });
  }
  const payload = {
    id: sha1Text(`${filePath}|${stat.size}|${stat.mtimeMs}`).slice(0, 16),
    type: kind,
    item_type: preferredKind === 'audio' ? 'audio' : editingItemTypeForAssetKind(kind),
    name: path.basename(filePath),
    path: filePath,
    url: publicUrl,
    thumbnail_url: thumbnailUrl,
    size_bytes: stat.size,
    size_human: formatBytes(stat.size),
    width: videoInfo.width,
    height: videoInfo.height,
    duration,
    has_audio: hasAudio,
  };
  if (external) payload.linked = true;
  if (groupPath) payload.group_path = groupPath;
  return payload;
}

// Đường dẫn endpoint thumbnail thư viện — khai một chỗ vì cả listing lẫn route dùng.
const API_PREFIX_LIBRARY_THUMB = '/api/library/thumb';

function libraryCategoryDir(category) {
  const sub = LIBRARY_CATEGORIES[String(category || '').toLowerCase()];
  if (!sub) return null;
  return path.join(LIBRARY_DIR, sub);
}

function publicLibraryUrl(category, fileName) {
  const sub = LIBRARY_CATEGORIES[String(category || '').toLowerCase()] || '';
  return `/library/${encodeURIComponent(sub)}/${encodeURIComponent(fileName)}`;
}

// URL công khai cho asset nằm ở BẤT KỲ độ sâu nào trong library/ (Magic Fill quét đệ quy).
function publicLibraryUrlForRelPath(relPath) {
  const parts = String(relPath || '').split(path.sep).filter(Boolean);
  return `/library/${parts.map(encodeURIComponent).join('/')}`;
}

// Đường dẫn tuyệt đối AN TOÀN từ đường dẫn tương đối trong library/ (chặn ../ thoát thư mục).
function resolveLibraryRelPath(relPath) {
  const raw = String(relPath || '').replace(/^[/\\]+/, '');
  if (!raw) return null;
  const abs = path.resolve(LIBRARY_DIR, raw.split(/[\\/]+/).join(path.sep));
  if (abs !== LIBRARY_DIR && !abs.startsWith(LIBRARY_DIR + path.sep)) return null;
  return abs;
}

// Quét ĐỆ QUY library/ lấy mọi asset dựng được (ảnh/video/audio). Bỏ thư mục luts
// (file .cube không phải asset timeline) và mọi file/thư mục ẩn.
function walkLibraryAssets(dir = LIBRARY_DIR, depth = 0) {
  if (depth > 6) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === LUT_DIR) continue;
      out.push(...walkLibraryAssets(full, depth + 1));
      continue;
    }
    if (!entry.isFile() || !isSupportedEditingAssetFile(full)) continue;
    const rel = path.relative(LIBRARY_DIR, full);
    out.push({
      name: entry.name,
      rel_path: rel.split(path.sep).join('/'),
      folder: path.dirname(rel).split(path.sep).join('/'),
      url: publicLibraryUrlForRelPath(rel),
      type: editingAssetKindForPath(full),
    });
  }
  return out;
}

// Category (tab panel Thư viện) suy ngược từ thư mục CẤP 1 của file trong library/.
function libraryCategoryForPath(filePath) {
  const rel = path.relative(LIBRARY_DIR, filePath);
  const top = rel.split(path.sep)[0] || '';
  const entry = Object.entries(LIBRARY_CATEGORIES).find(([, sub]) => sub.toLowerCase() === top.toLowerCase());
  return entry ? entry[0] : '';
}

// Asset thư viện được THAM CHIẾU trực tiếp (không copy vào temp); path trỏ file gốc trong library/.
async function libraryAssetPayload(filePath, category) {
  const stat = fs.statSync(filePath);
  const kind = editingAssetKindForPath(filePath);
  const videoInfo = (kind === 'media_video' || kind === 'media_image')
    ? mediaVideoInfo(filePath)
    : { width: null, height: null };
  const duration = kind === 'media_image' ? null : mediaDurationSeconds(filePath);
  const hasAudio = (kind === 'media_video' || kind === 'audio') ? mediaHasAudio(filePath) : false;
  // URL theo ĐƯỜNG DẪN TƯƠNG ĐỐI (không chỉ tên file) để asset nằm trong thư mục con
  // của library/ — Magic Fill quét đệ quy — vẫn trỏ đúng file đã static-serve.
  const publicUrl = publicLibraryUrlForRelPath(path.relative(LIBRARY_DIR, filePath));
  let thumbnailUrl = '';
  if (kind === 'media_video') {
    thumbnailUrl = await createOrGetThumbnail(filePath) || '';
  } else if (kind === 'media_image') {
    thumbnailUrl = await imageThumbnailUrlFor(filePath, publicUrl);
  }
  return {
    id: sha1Text(`lib|${filePath}|${stat.size}|${stat.mtimeMs}`).slice(0, 16),
    type: kind,
    item_type: editingItemTypeForAssetKind(kind),
    name: path.basename(filePath),
    path: filePath,
    url: publicUrl,
    thumbnail_url: thumbnailUrl,
    size_bytes: stat.size,
    size_human: formatBytes(stat.size),
    width: videoInfo.width,
    height: videoInfo.height,
    duration,
    has_audio: hasAudio,
    source: 'library',
    category: String(category || '').toLowerCase() || libraryCategoryForPath(filePath),
    rel_path: path.relative(LIBRARY_DIR, filePath).split(path.sep).join('/'),
  };
}

function collectSourceMetrics(savedFiles) {
  const files = (Array.isArray(savedFiles) ? savedFiles : []).map((file, index) => {
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(file.path).size;
    } catch (_) {
      sizeBytes = 0;
    }
    const durationSec = mediaDurationSeconds(file.path);
    const videoInfo = mediaVideoInfo(file.path);
    return {
      index: index + 1,
      name: String(file.name || path.basename(file.path || `source_${index + 1}`)),
      path: String(file.path || ''),
      size_bytes: sizeBytes,
      size_human: formatBytes(sizeBytes),
      duration_sec: durationSec,
      duration_human: formatSeconds(durationSec),
      width: videoInfo.width,
      height: videoInfo.height,
      fps: videoInfo.fps,
      fps_value: videoInfo.fps_value,
    };
  });
  const totalSizeBytes = files.reduce((sum, file) => sum + (Number(file.size_bytes) || 0), 0);
  const totalDurationSec = files.reduce((sum, file) => sum + (Number(file.duration_sec) || 0), 0);
  return {
    file_count: files.length,
    total_size_bytes: totalSizeBytes,
    total_size_human: formatBytes(totalSizeBytes),
    total_duration_sec: totalDurationSec,
    total_duration_human: formatSeconds(totalDurationSec),
    files,
  };
}

function resetPreviewProxyState(status = 'idle') {
  previewProxyGeneration += 1;
  previewProxyState.status = status;
  previewProxyState.preview_video_url = null;
  previewProxyState.path = null;
  previewProxyState.size_bytes = null;
  previewProxyState.size_human = null;
  previewProxyState.duration_ms = null;
  previewProxyState.queued_at = status === 'queued' ? isoNow() : null;
  previewProxyState.started_at = null;
  previewProxyState.ready_at = null;
  previewProxyState.error = null;
  previewProxyState.identity = null;
  return previewProxyGeneration;
}

/* ===== DANH TÍNH CỦA BẢN PROXY XEM TRƯỚC =======================================
 * Proxy được dựng từ `temp_input.mp4` — FILE NỐI, mà file đó được dựng LẠI ở mỗi lượt mở
 * dự án. Muốn dùng lại một proxy đã lưu kèm dự án thì phải CHỨNG MINH ĐƯỢC nó thuộc về
 * đúng bản nối đang có, nếu không khung xem trước chiếu một phim và bản xuất ra một phim
 * khác — lệch im lặng, đúng loại lỗi tệ nhất ở đây.
 *
 * Danh tính lấy TỪ CHÍNH file nối, không phải từ danh sách nguồn: bốn số dưới đây là hệ quả
 * của mọi thứ tạo ra nó (bộ nguồn, thứ tự nối, phiên bản ffmpeg, luật chuẩn hoá). Đổi bất cứ
 * khâu nào trong đó thì `size_bytes` gần như chắc chắn đổi theo. Không băm nội dung: file
 * nối cỡ vài trăm MB tới vài GB, băm nó ở mỗi lượt mở là đánh đổi sai chỗ.
 *
 * `version` để ép hết hiệu lực khi ĐỔI cách encode proxy — proxy cũ vẫn khớp file nối nhưng
 * không còn là thứ bản mới muốn dựng ra. */
const PREVIEW_PROXY_IDENTITY_VERSION = 1;

function previewProxyIdentityFor(concatPath) {
  let stat = null;
  try { stat = fs.statSync(concatPath); } catch (_) { return null; }
  if (!stat || stat.size <= 0) return null;
  const info = mediaVideoInfo(concatPath);
  const duration = mediaDurationSeconds(concatPath);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return {
    version: PREVIEW_PROXY_IDENTITY_VERSION,
    concat_version: CONCAT_CACHE_VERSION,
    size_bytes: stat.size,
    duration_ms: Math.round(duration * 1000),
    width: Number(info?.width) || 0,
    height: Number(info?.height) || 0,
  };
}

function previewProxyIdentity() {
  return previewProxyIdentityFor(path.join(TEMP_DIR, 'temp_input.mp4'));
}

/* So KHỚP TUYỆT ĐỐI cả sáu trường. Cố ý không có dung sai nào: mục đích của hàm này là
 * "chắc chắn cùng một file nối", mà dung sai thì biến nó thành "chắc là gần giống". Lệch =
 * dựng lại proxy, tốn vài phút chứ không sai hình. */
function previewProxyIdentityMatches(a, b) {
  if (!a || !b) return false;
  return ['version', 'concat_version', 'size_bytes', 'duration_ms', 'width', 'height']
    .every((key) => Number(a[key]) === Number(b[key]));
}

function previewProxyPublicState() {
  return jsonSafe({
    status: previewProxyState.status,
    // Để renderer gửi kèm lúc Lưu/Đóng gói — xem tryAdoptPreviewProxy.
    identity: previewProxyState.identity || null,
    preview_video_url: previewProxyState.preview_video_url,
    path: previewProxyState.path,
    size_bytes: previewProxyState.size_bytes,
    size_human: previewProxyState.size_human,
    duration_ms: previewProxyState.duration_ms,
    queued_at: previewProxyState.queued_at,
    started_at: previewProxyState.started_at,
    ready_at: previewProxyState.ready_at,
    error: previewProxyState.error,
  });
}

function sysctlValue(name) {
  if (process.platform !== 'darwin') return '';
  return commandText('sysctl', ['-n', name], 1500);
}

function collectNvidiaGpuInfo() {
  const text = commandText('nvidia-smi', [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits',
  ], 3000);
  if (!text) return { gpu: '', vram: '', max_vram_mb: null, cuda: false };
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const gpus = [];
  const vramValues = [];
  let maxVramMb = null;
  for (const row of rows) {
    const parts = row.split(',').map((part) => part.trim());
    if (parts.length < 2) continue;
    const name = parts.slice(0, -1).join(', ') || parts[0];
    const vramMb = Number(parts[parts.length - 1]);
    gpus.push(name);
    if (Number.isFinite(vramMb) && vramMb > 0) {
      maxVramMb = Math.max(maxVramMb || 0, vramMb);
      vramValues.push(`${Math.round(vramMb)} MB`);
    }
  }
  return {
    gpu: gpus.length ? [...new Set(gpus)].join(', ') : '',
    vram: vramValues.length ? [...new Set(vramValues)].join(', ') : '',
    max_vram_mb: maxVramMb,
    cuda: gpus.length > 0,
  };
}

function collectGpuInfo() {
  const isMacArm = process.platform === 'darwin' && process.arch === 'arm64';
  if (process.platform === 'darwin') {
    const displayInfo = commandText('system_profiler', ['SPDisplaysDataType'], 5000);
    const gpuNames = [...displayInfo.matchAll(/Chipset Model:\s*(.+)/g)].map((m) => m[1].trim());
    const vramValues = [...displayInfo.matchAll(/VRAM[^:]*:\s*(.+)/g)].map((m) => m[1].trim());
    return {
      gpu: gpuNames.length ? [...new Set(gpuNames)].join(', ') : (isMacArm ? `Apple M-Series GPU (${process.arch})` : 'Không xác định'),
      vram: vramValues.length ? [...new Set(vramValues)].join(', ') : (isMacArm ? 'Unified memory/shared GPU memory' : 'Không xác định'),
      device: isMacArm ? 'GPU (MLX/Metal)' : 'CPU',
    };
  }
  if (process.platform === 'win32') {
    const nvidia = collectNvidiaGpuInfo();
    return {
      gpu: nvidia.gpu || 'Windows GPU (xem Device Manager)',
      vram: nvidia.vram || 'Không xác định',
      device: nvidia.cuda ? 'CUDA/GPU nếu CTranslate2 hỗ trợ' : 'CPU',
      vram_mb: nvidia.max_vram_mb,
      cuda: nvidia.cuda,
    };
  }
  return {
    gpu: 'Không xác định',
    vram: 'Không xác định',
    device: 'CPU',
  };
}

function collectHardwareInfo() {
  const gpuInfo = collectGpuInfo();
  const cpu = os.cpus()?.[0]?.model || 'Không xác định';
  const osName = process.platform === 'win32'
    ? `Windows ${os.release()}`
    : (process.platform === 'darwin' ? `macOS ${os.release()}` : `${os.type()} ${os.release()}`);
  return {
    os: osName,
    model: sysctlValue('hw.model') || os.hostname() || 'Không xác định',
    cpu,
    gpu: gpuInfo.gpu,
    ram: formatBytes(os.totalmem()),
    vram: gpuInfo.vram,
    vram_mb: gpuInfo.vram_mb || null,
    cuda: !!gpuInfo.cuda,
    device: gpuInfo.device,
    arch: `${process.platform}/${process.arch}`,
  };
}

function reportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function reportReasonText(reason) {
  if (reason === 'export_success') return 'Export video thành công';
  if (reason === 'new_project') return 'Tạo dự án mới';
  return String(reason || 'Hoàn thành project');
}

function reportValue(value) {
  if (value === undefined || value === null || value === '') return 'Chưa có dữ liệu';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'Chưa có dữ liệu';
  if (typeof value === 'object') return JSON.stringify(jsonSafe(value)).replace(/\t/g, ' ').replace(/\r?\n/g, '\\n');
  return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, '\\n');
}

function reportLine(depth, key, value) {
  return `${'\t'.repeat(depth)}[${key}]\t${reportValue(value)}`;
}

function reportTag(depth, tag, attrs = {}) {
  const suffix = Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${reportValue(value).replace(/"/g, '&quot;')}"`)
    .join('');
  return `${'\t'.repeat(depth)}<${tag}${suffix}>`;
}

function reportEndTag(depth, tag) {
  return `${'\t'.repeat(depth)}</${tag}>`;
}

async function writeProjectReport(reason) {
  ensureDirs();
  const hardware = collectHardwareInfo();
  const reportPath = path.join(REPORTS_DIR, `report_project_${reportTimestamp()}.txt`);
  const sources = projectMetrics.sources || collectSourceMetrics([]);
  const transcribe = projectMetrics.transcribe;
  const render = projectMetrics.export;
  const errors = Array.isArray(projectMetrics.errors) ? projectMetrics.errors : [];
  const lines = [
    reportTag(0, 'PROJECT_REPORT'),
    reportLine(1, 'schema_version', 2),
    reportLine(1, 'reason', reportReasonText(reason)),
    reportLine(1, 'created_at', new Date().toISOString()),
    reportLine(1, 'created_at_local', new Date().toLocaleString('vi-VN')),
    reportLine(1, 'report_file', path.basename(reportPath)),
    '',
    reportTag(1, 'HARDWARE'),
    reportLine(2, 'os', hardware.os),
    reportLine(2, 'model', hardware.model),
    reportLine(2, 'cpu', hardware.cpu),
    reportLine(2, 'gpu', hardware.gpu),
    reportLine(2, 'ram', hardware.ram),
    reportLine(2, 'vram', hardware.vram),
    reportLine(2, 'vram_mb', hardware.vram_mb),
    reportLine(2, 'cuda', hardware.cuda),
    reportLine(2, 'device', hardware.device),
    reportLine(2, 'arch', hardware.arch),
    reportEndTag(1, 'HARDWARE'),
    '',
    reportTag(1, 'RAW_VIDEOS'),
    reportLine(2, 'file_count', sources.file_count),
    reportLine(2, 'total_duration_sec', sources.total_duration_sec),
    reportLine(2, 'total_duration_human', sources.total_duration_human),
    reportLine(2, 'total_size_bytes', sources.total_size_bytes),
    reportLine(2, 'total_size_human', sources.total_size_human),
  ];
  for (const file of sources.files || []) {
    lines.push(reportTag(2, 'FILE', { index: file.index }));
    lines.push(reportLine(3, 'name', file.name));
    lines.push(reportLine(3, 'path', file.path));
    lines.push(reportLine(3, 'duration_sec', file.duration_sec));
    lines.push(reportLine(3, 'duration_human', file.duration_human));
    lines.push(reportLine(3, 'size_bytes', file.size_bytes));
    lines.push(reportLine(3, 'size_human', file.size_human));
    lines.push(reportEndTag(2, 'FILE'));
  }
  lines.push(reportEndTag(1, 'RAW_VIDEOS'));
  lines.push('');
  lines.push(reportTag(1, 'ASR'));
  lines.push(reportLine(2, 'status', transcribe?.status));
  lines.push(reportLine(2, 'requested_engine', transcribe?.requested_engine));
  lines.push(reportLine(2, 'actual_engine', transcribe?.engine));
  lines.push(reportLine(2, 'asr_model', transcribe?.asr_model));
  lines.push(reportLine(2, 'mode', transcribe?.mode));
  lines.push(reportLine(2, 'backend_mode', transcribe?.transcribe_mode_used));
  lines.push(reportLine(2, 'duration_ms', transcribe?.duration_ms));
  lines.push(reportLine(2, 'duration_human', formatDuration(transcribe?.duration_ms)));
  lines.push(reportLine(2, 'server_duration_ms', transcribe?.server_duration_ms));
  lines.push(reportLine(2, 'response_duration_ms', transcribe?.response_duration_ms));
  lines.push(reportLine(2, 'concat_duration_ms', transcribe?.diagnostics?.concat_duration_ms));
  lines.push(reportLine(2, 'audio_preprocess_duration_ms', transcribe?.diagnostics?.audio_preprocess_duration_ms));
  lines.push(reportLine(2, 'vad_duration_ms', transcribe?.diagnostics?.vad_duration_ms));
  lines.push(reportLine(2, 'mlx_transcribe_duration_ms', transcribe?.diagnostics?.mlx_transcribe_duration_ms));
  lines.push(reportLine(2, 'windows_asr_model', transcribe?.diagnostics?.windows_asr_model));
  lines.push(reportLine(2, 'windows_asr_device', transcribe?.diagnostics?.windows_asr_device));
  lines.push(reportLine(2, 'windows_asr_compute_type', transcribe?.diagnostics?.windows_asr_compute_type));
  lines.push(reportLine(2, 'windows_asr_batch_size', transcribe?.diagnostics?.windows_asr_batch_size));
  lines.push(reportLine(2, 'windows_asr_initial_batch_size', transcribe?.diagnostics?.windows_asr_initial_batch_size));
  lines.push(reportLine(2, 'windows_asr_batch_attempts', Array.isArray(transcribe?.diagnostics?.windows_asr_batch_attempts) ? transcribe.diagnostics.windows_asr_batch_attempts.join(',') : transcribe?.diagnostics?.windows_asr_batch_attempts));
  lines.push(reportLine(2, 'windows_asr_vad_filter', transcribe?.diagnostics?.windows_asr_vad_filter ?? transcribe?.diagnostics?.vad_filter));
  lines.push(reportLine(2, 'windows_asr_vad_backend', transcribe?.diagnostics?.windows_asr_vad_backend));
  lines.push(reportLine(2, 'windows_asr_vram_mb', transcribe?.diagnostics?.windows_asr_vram_mb));
  lines.push(reportLine(2, 'windows_asr_cuda_ready', transcribe?.diagnostics?.windows_asr_cuda_ready));
  lines.push(reportLine(2, 'windows_asr_model_load_duration_ms', transcribe?.diagnostics?.windows_asr_model_load_duration_ms));
  // SỐ LẦN NẠP MODEL = số lần đã phải thử lại batch. >1 nghĩa là có lỗi CUDA ở lần trước;
  // đây chính là con số làm lộ ngay việc retry, thứ mà bản cũ vừa báo sai nguyên nhân
  // ("thiếu VRAM") vừa treo ở lần thử thứ hai.
  lines.push(reportLine(2, 'windows_asr_model_loads', transcribe?.diagnostics?.windows_asr_model_loads));
  lines.push(reportLine(2, 'windows_asr_transcribe_duration_ms', transcribe?.diagnostics?.windows_asr_transcribe_duration_ms));
  lines.push(reportLine(2, 'postprocess_duration_ms', transcribe?.diagnostics?.postprocess_duration_ms));
  lines.push(reportLine(2, 'asr_cache_hit', transcribe?.diagnostics?.asr_cache_hit));
  lines.push(reportLine(2, 'asr_cache_key', transcribe?.diagnostics?.asr_cache_key));
  lines.push(reportLine(2, 'asr_cache_write_error', transcribe?.diagnostics?.asr_cache_write_error));
  lines.push(reportLine(2, 'script_metadata_source_type', transcribe?.diagnostics?.script_metadata?.source_type));
  lines.push(reportLine(2, 'script_metadata_source_name', transcribe?.diagnostics?.script_metadata?.source_name));
  lines.push(reportLine(2, 'script_metadata_stale', transcribe?.diagnostics?.script_metadata?.stale));
  lines.push(reportLine(2, 'script_note_count', transcribe?.diagnostics?.script_metadata?.note_count));
  lines.push(reportLine(2, 'script_bold_range_count', transcribe?.diagnostics?.script_metadata?.bold_range_count));
  lines.push(reportLine(2, 'started_at', transcribe?.started_at));
  lines.push(reportLine(2, 'ended_at', transcribe?.ended_at));
  lines.push(reportLine(2, 'segment_count', Number.isFinite(transcribe?.segment_count) ? transcribe.segment_count : null));
  lines.push(reportLine(2, 'source_count', Number.isFinite(transcribe?.source_count) ? transcribe.source_count : sources.file_count));
  lines.push(reportLine(2, 'vad_chunk_count', transcribe?.diagnostics?.vad_chunk_count));
  lines.push(reportLine(2, 'raw_asr_segment_count', transcribe?.diagnostics?.raw_asr_segment_count));
  lines.push(reportLine(2, 'aligned_segment_count', transcribe?.diagnostics?.aligned_segment_count));
  lines.push(reportLine(2, 'final_segment_count', transcribe?.diagnostics?.final_segment_count));
  lines.push(reportLine(2, 'used_full_audio_fallback', transcribe?.diagnostics?.used_full_audio_fallback));
  lines.push(reportLine(2, 'manual_vad', transcribe?.diagnostics?.manual_vad));
  lines.push(reportLine(2, 'preview_proxy_path', transcribe?.preview_proxy?.path));
  lines.push(reportLine(2, 'preview_proxy_status', transcribe?.preview_proxy?.status));
  lines.push(reportLine(2, 'preview_proxy_size', transcribe?.preview_proxy?.size_human));
  lines.push(reportLine(2, 'preview_proxy_duration_ms', transcribe?.preview_proxy?.duration_ms));
  lines.push(reportLine(2, 'preview_proxy_queued_at', transcribe?.preview_proxy?.queued_at));
  lines.push(reportLine(2, 'preview_proxy_started_at', transcribe?.preview_proxy?.started_at));
  lines.push(reportLine(2, 'preview_proxy_ready_at', transcribe?.preview_proxy?.ready_at));
  lines.push(reportEndTag(1, 'ASR'));
  lines.push('');
  lines.push(reportTag(1, 'EXPORT'));
  lines.push(reportLine(2, 'status', render?.status));
  lines.push(reportLine(2, 'resolution', render?.resolution || render?.preset));
  lines.push(reportLine(2, 'fps', render?.fps));
  lines.push(reportLine(2, 'codec', render?.codec));
  lines.push(reportLine(2, 'quality', render?.quality));
  lines.push(reportLine(2, 'encoder', render?.encoder));
  lines.push(reportLine(2, 'audio_bitrate', render?.audio_bitrate));
  lines.push(reportLine(2, 'interval_count', render?.interval_count));
  lines.push(reportLine(2, 'duration_ms', render?.duration_ms));
  lines.push(reportLine(2, 'duration_human', formatDuration(render?.duration_ms)));
  lines.push(reportLine(2, 'output_path', render?.output_path));
  lines.push(reportEndTag(1, 'EXPORT'));
  lines.push('');
  lines.push(reportTag(1, 'ERRORS'));
  lines.push(reportLine(2, 'count', errors.length));
  if (!errors.length) {
    lines.push(reportLine(2, 'summary', 'Không ghi nhận lỗi trong project.'));
  } else {
    errors.forEach((item, index) => {
      lines.push(reportTag(2, 'ERROR', { index: index + 1 }));
      lines.push(reportLine(3, 'time', item.time));
      lines.push(reportLine(3, 'stage', item.stage || 'unknown'));
      lines.push(reportLine(3, 'where', item.where || 'unknown'));
      lines.push(reportLine(3, 'message', item.message || 'Không rõ lỗi'));
      lines.push(reportLine(3, 'engine', item.engine));
      lines.push(reportLine(3, 'export_settings', item.export_settings));
      lines.push(reportLine(3, 'command', item.command));
      lines.push(reportLine(3, 'exit_code', item.exit_code));
      lines.push(reportLine(3, 'stderr', item.stderr));
      lines.push(reportEndTag(2, 'ERROR'));
    });
  }
  lines.push(reportEndTag(1, 'ERRORS'));
  lines.push(reportEndTag(0, 'PROJECT_REPORT'));
  await fsp.writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
  projectMetrics.lastReportPath = reportPath;
  projectMetrics.reportWritten = true;
  return reportPath;
}

function hasProjectActivity() {
  return !!(
    projectMetrics.activity ||
    projectMetrics.sources ||
    projectMetrics.transcribe ||
    projectMetrics.export ||
    (Array.isArray(projectMetrics.errors) && projectMetrics.errors.length)
  );
}

function recordProjectError(stage, error, context = {}) {
  const message = String(error?.message || error || 'Không rõ lỗi');
  const entry = {
    time: new Date().toLocaleString('vi-VN'),
    stage,
    where: context.where || context.endpoint || context.command || 'backend',
    message,
  };
  if (context.engine) entry.engine = context.engine;
  if (context.exportSettings) entry.export_settings = JSON.stringify(context.exportSettings);
  if (context.command || error?.command) entry.command = context.command || error.command;
  if (error?.exitCode !== undefined) entry.exit_code = error.exitCode;
  if (error?.stderr) entry.stderr = cleanInlineText(error.stderr, 1200);
  if (error?.sidecarPayload) entry.sidecar_payload = cleanInlineText(JSON.stringify(error.sidecarPayload), 1200);
  projectMetrics.errors.push(entry);
  projectMetrics.activity = true;
  if (stage === 'transcribe' && projectMetrics.transcribe && !projectMetrics.transcribe.engine) {
    projectMetrics.transcribe.status = 'failed';
    projectMetrics.transcribe.error = message;
    projectMetrics.transcribe.ended_at = new Date().toISOString();
    if (Number.isFinite(projectMetrics.transcribe._started_at_ms)) {
      projectMetrics.transcribe.duration_ms = Math.max(0, Date.now() - projectMetrics.transcribe._started_at_ms);
    }
  }
}

function isSupportedVideoFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && ALLOWED_VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  } catch (_) {
    return false;
  }
}

function isSupportedEditingAssetFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && ALLOWED_EDITING_ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  } catch (_) {
    return false;
  }
}

function isSupportedEditingAssetUpload(file) {
  try {
    return fs.statSync(file.path).isFile()
      && ALLOWED_EDITING_ASSET_EXTENSIONS.has(path.extname(file.originalname || '').toLowerCase());
  } catch (_) {
    return false;
  }
}

function editingAssetKindForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ALLOWED_AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (ALLOWED_IMAGE_EXTENSIONS.has(ext)) return 'media_image';
  if (ALLOWED_VIDEO_EXTENSIONS.has(ext)) return 'media_video';
  return 'media';
}

function editingItemTypeForAssetKind(kind) {
  if (kind === 'audio') return 'audio';
  return 'media';
}

/* Danh sách video PHẲNG để đưa vào khâu xử lý (nối, bóc băng). Chỉ đọc CẤP GỐC của thư mục.
 *
 * `preserveOrder` GIỮ NGUYÊN THỨ TỰ `sourcePaths` do người gọi đưa xuống, thay vì sắp theo
 * tên file. Vì sao cần: thứ tự nối quyết định mốc thời gian của TỪNG đoạn trong
 * temp_input.mp4, mà lane chính của Editing lại trỏ vào các mốc đó. Người dùng thêm
 * "a.mp4" sau khi đã dựng trên "z.mp4" — sắp theo tên là a nhảy lên đầu, mọi clip lane
 * chính và mọi overlay lệch chỗ mà KHÔNG có lỗi nào báo.
 *
 * Mặc định vẫn là SẮP THEO TÊN: hai người gọi cũ (mở lại dự án .crab, /api/transcribe-local)
 * dựa vào thứ tự đó, đổi mặc định là đổi thứ tự nối của mọi dự án đang có.
 */
function collectVideosFromSourcePaths(sourcePaths, { preserveOrder = false } = {}) {
  const seen = new Set();
  const collected = [];
  for (const raw of sourcePaths || []) {
    if (!raw) continue;
    const resolved = path.resolve(String(raw));
    if (!fs.existsSync(resolved)) continue;
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const children = fs.readdirSync(resolved)
        .map((name) => path.join(resolved, name))
        .filter(isSupportedVideoFile)
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { sensitivity: 'base' }));
      for (const child of children) {
        const real = fs.realpathSync(child);
        if (!seen.has(real)) {
          seen.add(real);
          collected.push(real);
        }
      }
    } else if (isSupportedVideoFile(resolved)) {
      const real = fs.realpathSync(resolved);
      if (!seen.has(real)) {
        seen.add(real);
        collected.push(real);
      }
    }
  }
  // Trong MỘT thư mục thì vẫn sắp theo tên ở trên (tất định); chỗ này mới là chỗ trộn lẫn
  // các mục người dùng nhập vào với nhau — đúng chỗ phải giữ nguyên khi preserveOrder.
  if (!preserveOrder) {
    collected.sort((a, b) => {
      const byName = path.basename(a).localeCompare(path.basename(b), undefined, { sensitivity: 'base' });
      return byName || a.localeCompare(b);
    });
  }
  return collected;
}

/* ---- CÂY THƯ MỤC NGUỒN (panel "Tệp phương tiện") ----
 *
 * `collectVideosFromSourcePaths` ở trên trả DANH SÁCH PHẲNG và chỉ đọc CẤP GỐC của thư
 * mục — nó phục vụ khâu XỬ LÝ (nối video, bóc băng) nên phải giữ nguyên hành vi. Phần
 * dưới đây phục vụ khâu HIỂN THỊ: quét ĐỆ QUY và giữ lại đường dẫn thư mục tương đối
 * (`group_path`) để panel dựng được cây thư mục bấm vào mở ra như app dựng phim.
 *
 * Đắt hay rẻ là mấu chốt: quét đệ quy có thể ra hàng trăm file, nên hàm này TUYỆT ĐỐI
 * không ffprobe và không trích thumbnail (xem /api/video-sources/scan) — hai việc đó
 * làm lười qua /api/media-probe và /api/source-thumb khi thẻ lọt tầm nhìn.
 */
const SOURCE_TREE_MAX_DEPTH = 8;
const SOURCE_TREE_MAX_FILES = 4000;

function collectMediaTreeFromSourcePaths(sourcePaths, { accept = isSupportedVideoFile } = {}) {
  const seen = new Set();
  const collected = [];
  const pushFile = (filePath, groupPath) => {
    if (collected.length >= SOURCE_TREE_MAX_FILES) return;
    let real;
    try { real = fs.realpathSync(filePath); } catch (_) { return; }
    if (seen.has(real)) return;
    seen.add(real);
    collected.push({ path: real, group_path: groupPath });
  };
  const walkDir = (dir, groupPath, depth) => {
    if (depth > SOURCE_TREE_MAX_DEPTH || collected.length >= SOURCE_TREE_MAX_FILES) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const files = entries.filter((e) => !e.isDirectory() && !e.name.startsWith('.')).sort(byName);
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).sort(byName);
    for (const entry of files) {
      const filePath = path.join(dir, entry.name);
      if (accept(filePath)) pushFile(filePath, groupPath);
    }
    for (const entry of dirs) {
      walkDir(path.join(dir, entry.name), [...groupPath, entry.name], depth + 1);
    }
  };
  for (const raw of sourcePaths || []) {
    if (!raw) continue;
    const resolved = path.resolve(String(raw));
    if (!fs.existsSync(resolved)) continue;
    if (fs.statSync(resolved).isDirectory()) walkDir(resolved, [path.basename(resolved)], 1);
    else if (accept(resolved)) pushFile(resolved, []);
  }
  return collected;
}

/* Danh sách trắng đường dẫn được PHÁT ra ngoài (/api/source-file, /api/source-thumb).
 * File nguồn của người dùng nằm rải rác ngoài thư mục dự án nên `express.static` không
 * với tới; mở một route đọc path tuỳ ý thì thành lỗ hổng đọc file. Cách chốt: chỉ phát
 * những gì phiên làm việc ĐÃ ĐĂNG KÝ — thư mục người dùng tự thêm vào panel, hoặc file
 * lẻ họ chọn. Bộ nhớ, không ghi đĩa: mở lại dự án thì /api/video-sources/scan đăng ký lại. */
const sourceAccessRoots = new Set();
const sourceAccessFiles = new Set();

function registerSourceAccess(rawPath) {
  if (!rawPath) return;
  const resolved = path.resolve(String(rawPath));
  if (!fs.existsSync(resolved)) return;
  if (fs.statSync(resolved).isDirectory()) sourceAccessRoots.add(resolved);
  else sourceAccessFiles.add(resolved);
}

function isSourceAccessAllowed(rawPath) {
  if (!rawPath) return false;
  let resolved = path.resolve(String(rawPath));
  try { resolved = fs.realpathSync(resolved); } catch (_) { return false; }
  if (sourceAccessFiles.has(resolved)) return true;
  for (const root of sourceAccessRoots) {
    let realRoot = root;
    try { realRoot = fs.realpathSync(root); } catch (_) { /* thư mục đã bị xoá */ }
    const rel = path.relative(realRoot, resolved);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

function thumbnailCacheKey(videoPath) {
  const stat = fs.statSync(videoPath);
  return crypto
    .createHash('sha1')
    .update(`${path.resolve(videoPath)}|${stat.mtimeNs || Math.trunc(stat.mtimeMs * 1e6)}|${stat.size}`)
    .digest('hex')
    .slice(0, 24);
}

function sidecarPath() {
  const exe = process.platform === 'win32' ? 'core_process.exe' : 'core_process';
  return path.join(PROJECT_ROOT, 'native', 'sidecar', 'build', exe);
}

function parseNdjsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function runSidecar(args, options = {}) {
  const binary = sidecarPath();
  if (!fs.existsSync(binary)) {
    throw new Error(`C++ sidecar chưa build: ${binary}. Chạy npm run build:sidecar.`);
  }
  const command = [binary, ...args].join(' ');

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildProcesses.add(child);
    if (options.readsMainVideo) mainVideoReaders.add(child);
    /* JOB NỀN (`lowPriority`) — hạ ưu tiên tiến trình con để nó KHÔNG giành CPU với luồng
     * dựng hình của Electron. Trên Windows tiến trình mới thừa hưởng priority class của cha,
     * nên ffmpeg mà sidecar sinh ra cũng xuống theo.
     * ⚠️ Đây là BEST-EFFORT, không phải bảo đảm: sidecar có thể đã sinh ffmpeg xong trước khi
     * dòng này chạy (đua vài ms), và priority của CPU không hề chặn được phần GIẢI MÃ /
     * MÃ HOÁ trên GPU — mà đó mới là thứ tranh chấp với preview. Chốt chặn thật là CỔNG
     * "đang phát" (xem backgroundJobsBusyUntil), dòng này chỉ để giảm nhiễu lúc máy rảnh. */
    if (options.lowPriority && child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}
    }
    const stdoutLines = [];
    const stderr = [];

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        stdoutLines.push(line);
        const evt = parseNdjsonLine(line);
        if (evt?.message && (evt.type === 'progress' || evt.type === 'result')) {
          if (options.forwardStatus !== false) setStatus(evt.message);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr.push(chunk.toString('utf8'));
      process.stderr.write(`[core_process:err] ${chunk}`);
    });

    child.on('error', (error) => {
      activeChildProcesses.delete(child);
      mainVideoReaders.delete(child);
      reject(error);
    });
    child.on('exit', (code) => {
      activeChildProcesses.delete(child);
      mainVideoReaders.delete(child);
      if (code === 0) {
        resolve(stdoutLines.map(parseNdjsonLine).filter(Boolean));
        return;
      }
      const lastEvent = stdoutLines.map(parseNdjsonLine).filter(Boolean).pop();
      const error = new Error(lastEvent?.message || stderr.join('').trim() || `core_process exited with code ${code}`);
      error.exitCode = code;
      error.stderr = stderr.join('').trim();
      error.command = command;
      error.sidecarPayload = lastEvent;
      reject(error);
    });
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildProcesses.add(child);
    const stderr = [];
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk.toString('utf8'));
      if (options.echoStderr) process.stderr.write(`[${command}:err] ${chunk}`);
    });
    child.on('error', (error) => {
      activeChildProcesses.delete(child);
      reject(error);
    });
    child.on('exit', (code) => {
      activeChildProcesses.delete(child);
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(stderr.join('').trim() || `${command} exited with code ${code}`);
      error.exitCode = code;
      error.stderr = stderr.join('').trim();
      error.command = [command, ...args].join(' ');
      reject(error);
    });
  });
}

async function createOrGetThumbnail(videoPath) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
  const key = thumbnailCacheKey(videoPath);
  /* Nguồn HDR nay được sidecar tonemap trước khi trích frame (xem CommandThumbnail). Dấu
   * `_sdr` trong TÊN để những thumbnail cháy đã cache từ bản trước không bị dùng lại — khoá
   * cũ chỉ băm path+mtime+size nên nó không hề biết cách trích đã đổi. */
  const thumbName = `${key}${sourceIsHdr(videoPath) ? '_sdr' : ''}.jpg`;
  const thumbPath = path.join(THUMBNAIL_DIR, thumbName);
  if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
    return `/temp_uploads/thumbnails/${thumbName}`;
  }
  try {
    await runSidecar(['thumbnail', videoPath, thumbPath, '0.500'], { forwardStatus: false });
  } catch (_) {
    try {
      await runSidecar(['thumbnail', videoPath, thumbPath, '0.000'], { forwardStatus: false });
    } catch (_) {
      return null;
    }
  }
  return fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0
    ? `/temp_uploads/thumbnails/${thumbName}`
    : null;
}

function safeUploadName(originalName, usedNames) {
  const raw = String(originalName || '').replace(/\\/g, '/');
  const parsed = path.parse(path.basename(raw) || 'input_video.mp4');
  let candidate = `${parsed.name || 'input_video'}${parsed.ext || '.mp4'}`;
  let suffix = 1;
  while (usedNames.has(candidate)) {
    candidate = `${parsed.name || 'input_video'}_${suffix}${parsed.ext || '.mp4'}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureDirs();
    cb(null, TEMP_DIR);
  },
  filename: (req, file, cb) => {
    req._usedUploadNames = req._usedUploadNames || new Set();
    cb(null, safeUploadName(file.originalname, req._usedUploadNames));
  },
});
// fieldSize mặc định của multer là 1MB — editing_json chứa chuỗi frame hoạt ảnh
// text (base64) có thể tới hàng chục MB, không nâng limit là export chết ngay
const upload = multer({ storage: uploadStorage, limits: { fieldSize: 256 * 1024 * 1024 } });

// Chuỗi khung vùng CHUYỂN CẢNH đi riêng thành các phần file nhị phân của multipart, KHÔNG
// nằm trong editing_json: một khung 1080×1920 nén JPEG ~0.4MB (PNG ~9.5MB) và một dự án
// Magic Fill điền chuyển cảnh cho cả sequence có thể tới vài trăm khung — nhét vào JSON là
// vượt trần chuỗi của V8 ở frontend trước khi request kịp gửi đi.
// Ghi thẳng vào thư mục riêng với ĐÚNG tên frontend đặt để materialize chỉ cần rename.
const TRANSITION_FRAME_UPLOAD_DIR = path.join(TEMP_DIR, 'transition_frames_upload');
const TRANSITION_FRAME_LIMIT = 8000;
function safeTransitionFrameName(name) {
  return String(name || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120) || 'frame.png';
}
const transitionFrameUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(TRANSITION_FRAME_UPLOAD_DIR, { recursive: true });
      cb(null, TRANSITION_FRAME_UPLOAD_DIR);
    },
    filename: (_req, file, cb) => cb(null, safeTransitionFrameName(file.originalname)),
  }),
  limits: {
    fieldSize: 256 * 1024 * 1024,
    files: TRANSITION_FRAME_LIMIT,
    fileSize: 64 * 1024 * 1024,   // 1 khung đơn lẻ không bao giờ tới mức này
  },
});

/* Chép nguồn vào temp_uploads — BỎ QUA file đã chép và còn y nguyên.
 *
 * VÌ SAO: lane chính nối lại CẢ BỘ mỗi lần thêm một video (concat chỉ dựng file mới từ
 * đầu). Bản trước chép lại toàn bộ nguồn mỗi lượt, nên thêm clip thứ 15 là chép lại cả 15
 * file — với footage vài GB thì phần lớn thời gian chờ nằm ở đây, mà 14 file trong đó
 * byte-for-byte không đổi. Nay chỉ chép file MỚI hoặc file đã đổi.
 *
 * SO SÁNH BẰNG size + mtime, không đọc nội dung: đọc để băm cũng tốn đúng lượng I/O mà ta
 * đang muốn tránh. Lệch một trong hai -> chép lại; không đọc được stat -> chép lại. Luôn
 * nghiêng về phía chép, vì dùng nhầm bản cũ là phim sai mà không có lỗi nào báo.
 *
 * TÊN FILE ỔN ĐỊNH: safeUploadName() cấp tên theo THỨ TỰ, mà nguồn mới luôn nối vào CUỐI
 * (xem rebuildMainLane) nên tên của các nguồn cũ không đổi giữa hai lượt — điều kiện để
 * bộ nhớ đệm này trúng. Đổi thứ tự nguồn thì tên lệch và mọi file bị chép lại: vẫn ĐÚNG,
 * chỉ chậm bằng bản cũ. */
async function copyLocalSourcesToTemp(resolvedSources) {
  const usedNames = new Set();
  const saved = [];
  let reused = 0;
  for (const source of resolvedSources) {
    const candidate = safeUploadName(path.basename(source), usedNames);
    const dst = path.join(TEMP_DIR, candidate);
    if (tempCopyIsFresh(source, dst)) reused += 1;
    else await fsp.copyFile(source, dst);
    saved.push({ name: candidate, path: dst });
  }
  if (reused) console.log(`[reingest] dùng lại ${reused}/${resolvedSources.length} bản chép trong temp_uploads`);
  return saved;
}

function tempCopyIsFresh(sourcePath, tempPath) {
  try {
    const src = fs.statSync(sourcePath);
    const dst = fs.statSync(tempPath);
    if (src.size !== dst.size) return false;
    // copyFile KHÔNG giữ mtime -> bản chép luôn MỚI HƠN nguồn. Nguồn mới hơn bản chép
    // nghĩa là file gốc đã bị sửa sau lần chép -> phải chép lại.
    return Math.trunc(dst.mtimeMs) >= Math.trunc(src.mtimeMs);
  } catch (_) {
    return false;
  }
}

/* --- NGUỒN HDR PHẢI ĐƯỢC HẠ VỀ SDR NGAY KHI NHẬP ---
 *
 * Đo thật trên IMG_0826 (1).MOV (iPhone: HEVC Main 10, HLG/BT.2020, kèm Dolby Vision
 * profile 8.4) ngày 2026-09-07: preview của CrabbyCut sáng cháy — 65,7% pixel có luma > 235,
 * trong khi CapCut mở CÙNG file chỉ 4,0%. Dựng lại bằng ffmpeg "giải HLG rồi đưa thẳng sang
 * BT.709 không nén dải" cho ra 74,1% — khớp, nên cơ chế đã rõ: Chromium GIẢI được đường
 * truyền HLG nhưng không nén dải sáng, đỉnh 1000 nit bị cắt cụt ở mức trắng SDR.
 *
 * VÌ SAO SỬA Ở ĐÂY chứ không ở proxy hay trong shader PixiJS:
 *  - Trong shader thì đã muộn: 2/3 khung bị cắt cụt TRƯỚC khi frame vào texture qua
 *    texImage2D, mất rồi thì không hạ sáng lại được.
 *  - Ở proxy thì chỉ LQ đúng màu; preview HQ (đang là mặc định) và file export vẫn sai.
 *  - Ở đây là chỗ DUY NHẤT mà mọi khâu sau đều thừa hưởng: HQ, LQ, export, ảnh bake, snapshot.
 *
 * GIÁ PHẢI TRẢ: nhập một file HDR nay tốn thêm một lượt mã hoá lại — đo được 16s cho 30s
 * nguồn 1080×1920, tức ~3,8 phút cho clip 7 phút — và bản chuẩn hoá chiếm chỗ trên đĩa
 * (~105 MB cho clip đó). Đổi lại: màu đúng ở mọi khâu và GIỐNG NHAU trên Windows/macOS, vì
 * không còn phụ thuộc vào việc Chromium xử lý HDR thế nào. Cũng mất đường xuất bản HDR —
 * dự án này chưa có tính năng đó.
 *
 * Dolby Vision: file iPhone dạng này là profile 8 với bl_signal_compatibility_id=4, tức lớp
 * nền TỰ NÓ đã là HLG hợp lệ. Bỏ lớp RPU đi và tonemap từ lớp nền là đúng, không phải xấp xỉ. */
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);

/* Hai đường tonemap, cùng đích BT.709 full-range SDR:
 *  - PLACEBO (GPU, Vulkan): khớp CapCut sát nhất trong các ứng viên đã đo — luma trung bình
 *    166,5 so với 162,7 của CapCut, tương phản 45,9 so với 49,4 — và nhanh gần 2× (9s so với
 *    16s cho 30s nguồn). Cần Vulkan nên KHÔNG chắc có ở mọi máy; vì thế mới phải dò.
 *  - ZSCALE (CPU, libzimg): dự bị, chạy ở đâu cũng được. Nhạt hơn một chút (luma 179,5, tương
 *    phản 42,8) nhưng vẫn đúng dải, hơn hẳn cảnh cắt cụt hiện tại. */
const HDR_TONEMAP_PLACEBO = 'format=yuv420p10,hwupload,libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709:tonemapping=bt.2446a:format=yuv420p,hwdownload,format=yuv420p';
const HDR_TONEMAP_ZSCALE = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/* KHUNG I DÀY CHO MỌI TỆP SẼ ĐƯỢC XEM TRƯỚC.
 *
 * Thiếu `-g` thì libx264 dùng mặc định 250 KHUNG — 8,3 giây ở 30fps, 4,2 giây ở 60fps. Mà
 * các tệp dựng ở đây đi thẳng vào đường xem trước (`temp_input.mp4` qua concat, hoặc asset
 * SDR của Editing), và MỌI đường xem trước ở CrabbyCut đều TUA liên tục: Preview Cuts tua ở
 * mép mỗi chunk, Editing tua ở mép mỗi clip. Giá một lệnh tua = số khung phải giải mã lại từ
 * khung I gần nhất, nên GOP dài biến mỗi mối nối thành một cú khựng.
 *
 * Đo trên nguồn thật của dự án người dùng: GOP 250 khung -> tua trung vị 131ms; CÙNG tệp
 * mã hoá lại ở GOP 28 khung -> 29,8ms. Đây là tệp TẠM nên vài phần trăm dung lượng thêm
 * không đáng kể. 30 khung cho <= 1,25 giây ở mọi nhịp khung thường gặp. */
const PREVIEW_FRIENDLY_GOP_ARGS = ['-g', '30'];

const hdrColorCache = new Map();
let vulkanTonemapProbe = null;

function sourceColorInfo(filePath) {
  let cacheKey = '';
  try {
    const stat = fs.statSync(filePath);
    cacheKey = `${filePath}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
    const hit = hdrColorCache.get(cacheKey);
    if (hit !== undefined) return hit;
  } catch (_) { cacheKey = ''; }
  const csv = commandText('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=color_transfer,color_primaries',
    '-of', 'csv=p=0',
    filePath,
  ], 5000);
  const [transfer = '', primaries = ''] = String(csv).split(',').map((part) => part.trim().toLowerCase());
  const info = { transfer, primaries };
  if (cacheKey) {
    if (hdrColorCache.size > 512) hdrColorCache.clear();
    hdrColorCache.set(cacheKey, info);
  }
  return info;
}

/* MA TRẬN MÀU mà PREVIEW (Chromium) dùng cho một nguồn video KHÔNG gắn nhãn color_space.
 * ĐÃ ĐO trong app (2026-09-25): Chromium đoán theo CHIỀU CAO — cao >= 720 -> BT.709, thấp hơn
 * -> BT.601; FFmpeg thì luôn BT.601. Trả '' khi nguồn ĐÃ có nhãn (hoặc không phải YUV giới
 * hạn: yuvj, RGB, xám không có câu hỏi này), 'bt709' hoặc 'smpte170m' khi thiếu nhãn.
 * Cùng quy tắc với MediaColorUntagged ở sidecar. */
const untaggedMatrixCache = new Map();
function untaggedPreviewMatrix(filePath) {
  let cacheKey = '';
  try {
    const stat = fs.statSync(filePath);
    cacheKey = `${filePath}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
    if (untaggedMatrixCache.has(cacheKey)) return untaggedMatrixCache.get(cacheKey);
  } catch (_) { cacheKey = ''; }
  const text = commandText('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=pix_fmt,color_space,height',
    '-of', 'default=nw=1',
    filePath,
  ], 5000);
  const fields = {};
  String(text).split(/\r?\n/).forEach((line) => {
    const at = line.indexOf('=');
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim().toLowerCase();
  });
  const pixFmt = fields.pix_fmt || '';
  const space = fields.color_space || '';
  const height = Number(fields.height) || 0;
  const yuv = pixFmt.startsWith('yuv') && !pixFmt.startsWith('yuvj');
  const untagged = yuv && (!space || space === 'unknown');
  const matrix = untagged ? (height >= 720 ? 'bt709' : 'smpte170m') : '';
  if (cacheKey) {
    if (untaggedMatrixCache.size > 512) untaggedMatrixCache.clear();
    untaggedMatrixCache.set(cacheKey, matrix);
  }
  return matrix;
}

function sourceIsHdr(filePath) {
  const { transfer, primaries } = sourceColorInfo(filePath);
  // HLG (điện thoại quay HDR) và PQ (HDR10 / Dolby Vision) đều phải nén dải trước khi hiển thị.
  if (HDR_TRANSFERS.has(transfer)) return true;
  /* Có nguồn chỉ ghi primaries mà bỏ trống transfer. BT.2020 là gam rộng: hiển thị nguyên xi
   * trên đường sRGB thì màu bị lệch (dù không cháy như HLG), nên vẫn phải đi qua đây. */
  return primaries === 'bt2020';
}

/* Dò MỘT LẦN mỗi lần chạy server: build ffmpeg của máy này có tonemap được bằng Vulkan không.
 * Dò bằng một khung 64×64 nên rẻ; kết quả nhớ lại vì câu trả lời không đổi giữa các lượt. */
function vulkanTonemapUsable() {
  if (vulkanTonemapProbe !== null) return vulkanTonemapProbe;
  vulkanTonemapProbe = commandSucceeds('ffmpeg', [
    '-hide_banner', '-v', 'error',
    '-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
    '-vf', HDR_TONEMAP_PLACEBO,
    '-frames:v', '1', '-f', 'null', '-',
  ]);
  console.log(`[hdr] tonemap bằng Vulkan/libplacebo: ${vulkanTonemapProbe ? 'dùng được' : 'không có, quay về zscale CPU'}`);
  return vulkanTonemapProbe;
}

function shouldNormalizeForConcat(filePath) {
  return path.extname(filePath).toLowerCase() === '.webm' || sourceIsHdr(filePath);
}

/* CHỮ KÝ LUỒNG của một file, dùng để quyết định có phải mã hoá lại trước khi nối không.
 *
 * `ffmpeg -f concat -c copy` KHÔNG kiểm tra tính tương thích: đưa vào hai file khác codec /
 * khác fps / một bên có tiếng một bên không, nó vẫn TRẢ VỀ 0 và sinh ra file hỏng — các
 * khung của clip sau bị nhồi vào mốc thời gian của clip trước ("Non-monotonic DTS"), kết
 * quả là phim NGẮN HƠN tổng nguồn và mất hẳn một đoạn. Đo thật trên 2 clip trong library/:
 * 35.2s + 12.0s ra file 35.2s, mất trắng 12 giây mà không có lỗi nào báo.
 *
 * Vì thế phải tự so trước. Lấy đúng những thuộc tính mà concat demuxer đòi khớp. */
/* Bộ nhớ đệm chữ ký, khoá theo path + size + mtime.
 * Nối lại lane chính là việc lặp đi lặp lại (mỗi lần thêm một video là nối lại CẢ BỘ), mà
 * mỗi lượt trước đây tốn 2 lần ffprobe cho TỪNG file — 15 nguồn là 30 tiến trình con chạy
 * TUẦN TỰ trước khi ffmpeg bắt đầu. File không đổi thì chữ ký không thể đổi, nên đo lại là
 * phí. Khoá có size+mtime nên file bị thay nội dung vẫn được probe lại. */
const concatSignatureCache = new Map();

function concatStreamSignature(filePath) {
  let cacheKey = '';
  try {
    const stat = fs.statSync(filePath);
    cacheKey = `${filePath}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
    const hit = concatSignatureCache.get(cacheKey);
    if (hit !== undefined) return hit;
  } catch (_) { cacheKey = ''; }
  const signature = probeConcatStreamSignature(filePath);
  if (cacheKey) {
    // Trần đơn giản: dự án dài có thể đi qua hàng trăm file, không để Map phình vô hạn.
    if (concatSignatureCache.size > 512) concatSignatureCache.clear();
    concatSignatureCache.set(cacheKey, signature);
  }
  return signature;
}

function probeConcatStreamSignature(filePath) {
  const video = commandText('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate,color_space,color_range',
    '-of', 'csv=p=0',
    filePath,
  ], 5000);
  /* NHÃN MÀU cũng thuộc chữ ký: nối `-c copy` một nguồn có nhãn với một nguồn HD thiếu nhãn
   * cho ra temp_input.mp4 đổi ma trận giữa chừng, mà sidecar chỉ dò nhãn một lần cho cả file
   * (MediaColorUntagged) -> một nhóm đoạn ra sai màu so với preview. Khác nhãn thì chuẩn hoá,
   * và bước chuẩn hoá gắn nhãn tường minh (xem untaggedPreviewMatrix). */
  /* KÍCH THƯỚC HIỂN THỊ (đã tính hướng quay) là một phần của chữ ký.
   * `stream=width,height` là kích thước MÃ HOÁ: một clip dọc quay bằng điện thoại có thể
   * được mã hoá 1920×1080 kèm cờ xoay 90°. Hai file "cùng 1920×1080" theo chữ ký cũ nhưng
   * một cái hiển thị dọc, một cái ngang -> nối lại là file đổi khổ giữa chừng mà không ai
   * biết, và ffmpeg lúc export sẽ dựng lại đồ thị filter ở đúng chỗ đó (xem concatTargetSize). */
  const info = mediaVideoInfo(filePath);
  const display = `${info?.width || 0}x${info?.height || 0}`;
  const audio = commandText('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels',
    '-of', 'csv=p=0',
    filePath,
  ], 5000);
  return `${video.trim()}|${audio.trim()}|${display}`;
}

/* KHỔ HÌNH ĐÍCH của một lượt nối = KHUNG BAO của mọi nguồn (max rộng × max cao).
 *
 * VÌ SAO PHẢI ÉP CHUNG MỘT KHỔ (người dùng báo 2026-09-09): nối một clip dọc 1080×1920 với
 * một clip ngang 1920×1080 cho ra temp_input.mp4 ĐỔI KHỔ GIỮA CHỪNG. Preview vẫn xem được,
 * nhưng lúc export thì ffmpeg phải DỰNG LẠI đồ thị filter ngay tại chỗ đổi khổ
 * ("Reconfiguring filter graph because video parameters changed"), và bộ lọc `concat` đang
 * gom các đoạn bị gãy theo — file xuất ra CHỈ CÒN ĐOẠN ĐẦU, không một lỗi nào được báo.
 *
 * VÌ SAO KHUNG BAO CHỨ KHÔNG PHẢI KHỔ CỦA NGUỒN ĐẦU TIÊN (đổi 2026-09-09, bản trước lấy
 * nguồn đầu): mọi nguồn khác khổ nguồn đầu đều bị THU NHỎ ngay lúc nạp — clip ngang
 * 1920×1080 trong dự án dọc 1080×1920 chỉ còn 1080×607, mất 68% pixel và mất VĨNH VIỄN, nên
 * người dùng co giãn clip đó lên cho tràn khung là thấy mờ hẳn. Khung bao thì không nguồn
 * nào bị thu nhỏ. Đổi lại khung to hơn ở dự án lệch khổ (1080×1920 + 1920×1080 -> 1920×1920)
 * nên chuẩn hoá/nối/proxy tốn hơn; dự án mà mọi nguồn cùng khổ thì khung bao ĐÚNG BẰNG khổ
 * đó, không đổi gì so với trước.
 *
 * KHỔ SEQUENCE KHÔNG CÒN SUY TỪ ĐÂY. Trước đây hai thứ trùng nhau nên frontend lấy khổ thẻ
 * <video> làm mặc định Sequence; nay khung nối có thể là khung bao (vuông) nên mặc định
 * Sequence phải lấy VÙNG ẢNH của nguồn đầu (segment[0].content), xem `concatSegmentTable`. */
function concatTargetSize(savedFiles) {
  const sizes = (savedFiles || []).map((file) => {
    const info = mediaVideoInfo(file?.path || '');
    return { width: Number(info?.width), height: Number(info?.height) };
  });
  return MainLane.concatFrameSize(sizes);
}

/* ============ NHỊP KHUNG CỦA FILE NỐI = NHỊP CAO NHẤT TRONG BỘ NGUỒN ============
 *
 * concat demuxer không nối được hai nhịp khung khác nhau, nên bản chuẩn hoá buộc phải ép
 * MỌI nguồn về cùng MỘT nhịp. Câu hỏi là: nhịp nào?
 *
 * BẢN TRƯỚC GHI CỨNG `-r 30`, và đó là một lỗi mất dữ liệu KHÔNG AI THẤY. Đo trên dự án
 * người dùng gửi 2026-09-09 (`Test_lech fps_ver 2.crab`):
 *     DJI_…0143_D.MP4   nguồn 1728×3072 @ 60000/1001, 332 khung
 *     temp_input.mp4    nối ra 1920×3072 @ 30/1  ->  đoạn đó còn 168 khung
 * Một nửa số khung của nguồn bị ném đi NGAY LÚC NHẬP, trước khi preview hay render kịp
 * chạy. Người dùng chọn xuất 59.94 thì nhận được một file khai 59.94 trong header nhưng
 * chuyển động vẫn là 30 fps đã lược — con số đúng, chất lượng sai.
 *
 * CÁCH LÀM (theo đúng CapCut/Premiere). Cả hai KHÔNG dựng file trung gian nào: mỗi nguồn
 * giữ nguyên decoder riêng, project giữ MỘT nhịp khung, và với mỗi khung xuất ra engine
 * hỏi từng clip lấy khung gần mốc đó nhất — tức việc QUY NHỊP xảy ra ở khâu RENDER, không
 * ở khâu nhập. Lane chính ở đây buộc phải có file nối, nên bản dịch sát nhất là: file nối
 * đóng vai "mezzanine" ở nhịp CAO NHẤT (không ném khung của bất kỳ nguồn nào), rồi bước
 * `-r`/`fps=` của export mới quy về timebase sequence — đúng chỗ Premiere làm.
 *
 * Lợi thêm: đổi fps sequence KHÔNG cần nhập lại lane chính, vì file nối không phụ thuộc
 * vào lựa chọn đó.
 *
 * CHI PHÍ (đo thật, 2 nguồn của dự án trên, libx264 veryfast crf20):
 *     -r 30          19.3s mã hoá, 18.9 MB
 *     -r 60000/1001  28.5s mã hoá, 20.7 MB     (+48% thời gian, +9% dung lượng)
 * Đổi lấy việc không mất khung nào thì xứng — và bản nối có cache nên chỉ trả giá một lần.
 *
 * TRẦN 60: hộp thoại Xuất cũng chặn ở 60 (xem effectiveFps trong index.html), nên nối ở
 * 120 chỉ để rồi hạ xuống là mã hoá gấp đôi cho một thứ không đường nào ra tới file cuối.
 * Nguồn slow-motion 120/240fps vì thế vẫn bị hạ — cố ý, và là hành vi CŨ, không phải mới. */
const CONCAT_FPS_CEILING = 60;

function concatTargetFps(savedFiles) {
  let best = 0;
  for (const file of (savedFiles || [])) {
    const value = Number(mediaVideoInfo(file?.path || '')?.fps_value);
    if (Number.isFinite(value) && value > best) best = value;
  }
  if (!(best > 0)) return '30';
  /* Trả về dạng VĂN BẢN của chính nguồn cao nhất, không phải số đã làm tròn: nguồn NTSC
   * cho "60000/1001" và đó là thứ phải đi vào `-r`, chứ không phải "59.94" (xem
   * canonicalFpsText). Vượt trần thì kẹp về đúng con số trần. */
  if (best > CONCAT_FPS_CEILING + 0.01) return String(CONCAT_FPS_CEILING);
  let text = '30';
  for (const file of (savedFiles || [])) {
    const info = mediaVideoInfo(file?.path || '');
    if (Math.abs(Number(info?.fps_value) - best) < 1e-6 && info?.fps) { text = String(info.fps); break; }
  }
  return canonicalFpsText(text, '30');
}

/* Chuỗi filter đưa một nguồn về ĐÚNG khổ đích: đặt ảnh vào giữa khung, phần còn lại là viền
 * đen. `setsar=1` để nguồn anamorphic không kéo méo sau khi ghép.
 *
 * SỐ ĐO VIẾT THẲNG, KHÔNG DÙNG `force_original_aspect_ratio`/`(ow-iw)/2`: vùng ảnh thật phải
 * được GHI LẠI vào bảng đoạn (preview vẽ khung transform theo nó, export crop theo nó), nên
 * backend buộc phải BIẾT chính xác ffmpeg đặt ảnh ở đâu. Để ffmpeg tự quyết thì luật làm
 * tròn của nó là thứ ta phải đoán — mà đoán lệch một pixel ở đây thì không ai thấy cho tới
 * lúc xem bản xuất ra. Cả hai đi qua MainLane.contentRectIn nên không có đường nào lệch. */
function concatFitFilter(target, sourcePath) {
  if (!target) return '';
  const info = mediaVideoInfo(sourcePath || '');
  const rect = MainLane.contentRectIn(target, info?.width, info?.height);
  if (!rect) return '';
  const parts = [];
  // Nguồn cạnh lẻ / không lọt khung -> co về đúng cỡ vùng ảnh. Vừa khít thì bỏ hẳn bước
  // này: một lượt swscale vô ích trên cả bộ nguồn là chi phí thật, không phải làm đẹp.
  if (rect.width !== Number(info?.width) || rect.height !== Number(info?.height)) {
    parts.push(`scale=w=${rect.width}:h=${rect.height}`);
  }
  if (rect.width !== target.width || rect.height !== target.height) {
    parts.push(`pad=${target.width}:${target.height}:${rect.x}:${rect.y}:color=black`);
  }
  parts.push('setsar=1');
  return parts.join(',');
}

/* Chuẩn hoá 1 nguồn — DÙNG LẠI bản đã mã hoá nếu còn hợp lệ.
 *
 * VÌ SAO ĐÁNG: đây mới là chỗ tốn thời gian thật của "thêm video vào lane chính", không
 * phải phép chép file. Nguồn khác định dạng nhau (rất thường gặp: máy quay khác nhau, hoặc
 * clip có tiếng lẫn clip câm) thì MỌI nguồn đều bị libx264 mã hoá lại, và lane chính nối
 * lại cả bộ mỗi lần thêm một clip -> thêm clip thứ 6 là mã hoá lại đủ 6. Đo thật trên 6
 * clip trong library/ (48.8 MB): 11.5s mỗi lượt, trong đó 5 clip không hề đổi.
 *
 * ĐIỀU KIỆN DÙNG LẠI: bản ra còn đó, khác rỗng, và MỚI HƠN nguồn (nguồn là bản chép trong
 * temp_uploads, mà copyLocalSourcesToTemp nay giữ nguyên bản cũ nên mtime của nó đứng yên
 * giữa các lượt — chính điều đó làm bộ đệm này trúng).
 * `withAudio` NẰM TRONG TÊN FILE chứ không so ở ngoài: cờ đó đổi (thêm một clip câm vào bộ
 * toàn clip có tiếng) là bản cũ sai số luồng, mà sai số luồng thì concat sinh file hỏng
 * KHÔNG báo lỗi. Cho vào tên là không có đường nào lẫn được.
 * `force` (lượt thử lại sau khi concat hỏng) bỏ qua đệm: lúc đó đang đi đường cứu hộ, mã
 * hoá lại từ đầu vài giây còn hơn dùng lại một bản có thể chính là thủ phạm. */
async function normalizeVideoForConcat(file, index, { withAudio = true, force = false, forceFps = true, target = null, targetFps = '' } = {}) {
  const normalizedDir = path.join(TEMP_DIR, 'normalized_sources');
  fs.mkdirSync(normalizedDir, { recursive: true });
  const isHdr = sourceIsHdr(file.path);
  /* Cờ HDR NẰM TRONG TÊN FILE, cùng lý do như `withAudio`: máy nào đã nhập file này trước khi
   * có bước tonemap thì trên đĩa đang có một bản chuẩn hoá SAI MÀU nhưng vẫn "mới hơn nguồn",
   * và bộ đệm sẽ vui vẻ dùng lại nó. Đổi tên là không có đường nào lẫn được. */
  /* Khổ đích NẰM TRONG TÊN FILE, cùng lý do như `withAudio` và cờ HDR: cùng một nguồn có
   * thể phải chuẩn hoá về hai khổ khác nhau ở hai dự án, và dùng nhầm bản của khổ kia là
   * lại ra file nối đổi khổ giữa chừng. */
  const fit = concatFitFilter(target, file.path);
  const sizeTag = fit ? `_${target.width}x${target.height}` : '';
  /* NHỊP KHUNG NẰM TRONG TÊN FILE, cùng lý do như `withAudio` / cờ HDR / khổ đích: trên đĩa
   * có thể còn bản chuẩn hoá @30 từ trước lúc sửa (2026-09-09), và bản đó "mới hơn nguồn"
   * nên điều kiện dùng lại sẽ vui vẻ nhận nó — file nối lại về đúng 30 fps đã lược khung,
   * y như lỗi vừa sửa, mà không có gì báo. Đưa vào tên là không có đường nào lẫn được. */
  const fpsTag = (forceFps && targetFps) ? `_r${String(targetFps).replace('/', '-')}` : '';
  /* Ma trận GẮN THÊM cho nguồn thiếu nhãn cũng nằm trong tên file: bản chuẩn hoá cũ (trước
   * 2026-09-25) của nguồn đó KHÔNG có nhãn, mà vẫn "mới hơn nguồn" nên sẽ bị dùng lại. */
  const untaggedMatrix = isHdr ? '' : untaggedPreviewMatrix(file.path);
  const matrixTag = untaggedMatrix ? (untaggedMatrix === 'bt709' ? '_m709' : '_m601') : '';
  const suffix = `${withAudio ? '' : '_na'}${isHdr ? '_sdr' : ''}${sizeTag}${fpsTag}${matrixTag}`;
  /* TÊN BẢN CHUẨN HOÁ PHẢI KHOÁ THEO CHÍNH FILE NGUỒN, KHÔNG THEO VỊ TRÍ TRONG DANH SÁCH.
   *
   * LỖI ĐÃ TRẢ GIÁ (người dùng báo 2026-09-08). Bản trước đặt tên là `source_014.mp4` — tức
   * "nguồn thứ 14". Bỏ 7.mp4 khỏi lane chính rồi thêm 8.mp4 vào cuối: 8.mp4 cũng thành
   * "nguồn thứ 14", gặp đúng file cũ, và điều kiện dùng lại chỉ hỏi "bản ra có MỚI HƠN nguồn
   * không" — bản chuẩn hoá của 7.mp4 vừa tạo hôm nay đương nhiên mới hơn 8.mp4 quay tuần
   * trước. Thế là temp_input.mp4 được nối bằng HÌNH CỦA 7.mp4 nhưng mọi thứ trong app đều
   * tin đoạn đó là 8.mp4: playhead đứng trên block 8.mp4 mà preview chiếu 7.mp4, và bảng
   * đoạn đo được 16,267s (đúng thời lượng 7.mp4) cho một clip 13,2s.
   *
   * Băm theo (tên file | size | mtime) của bản chép trong temp_uploads: file khác thì tên
   * khác — không còn đường nào lẫn. Tiện thể còn CHẶT hơn về bộ đệm: đổi thứ tự lane chính
   * trước đây làm hỏng bộ đệm của mọi nguồn từ vị trí bị đổi trở đi (tên đổi theo vị trí),
   * nay đổi thứ tự không phải mã hoá lại gì cả. */
  let identity = path.basename(file.path);
  try {
    const stat = fs.statSync(file.path);
    identity = `${identity}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
  } catch (_) { /* không stat được thì băm theo tên, freshness check vẫn gác phía sau */ }
  const key = crypto.createHash('sha1').update(identity).digest('hex').slice(0, 16);
  const output = path.join(normalizedDir, `source_${key}${suffix}.mp4`);
  if (!force && normalizedCopyIsFresh(file.path, output)) {
    return { name: path.basename(output), path: output, original_path: file.path, reused: true };
  }
  setStatus(isHdr
    ? `Nguồn ${index + 1} là HDR — đang hạ về SDR để màu hiển thị đúng...`
    : `Đang chuẩn hóa video nguồn ${index + 1} để dựng timeline...`);
  // Clip KHÔNG có tiếng phải được cấp một rãnh tiếng CÂM, nếu không bản chuẩn hoá vẫn lệch
  // số luồng với clip có tiếng và concat lại hỏng đúng như cũ. `-shortest` cắt rãnh câm
  // theo độ dài hình.
  const hasAudio = mediaHasAudio(file.path);
  const buildArgs = (tonemapChain) => {
    const args = ['-y', '-hide_banner', '-v', 'error'];
    // `-init_hw_device` là tuỳ chọn toàn cục: phải đứng TRƯỚC `-i`, không phải sau.
    if (tonemapChain === HDR_TONEMAP_PLACEBO) args.push('-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk');
    args.push('-i', file.path);
    if (withAudio && !hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    args.push('-map', '0:v:0');
    if (withAudio) args.push('-map', hasAudio ? '0:a:0' : '1:a:0');
    // Tonemap (nếu có) chạy TRƯỚC bước đưa về khổ đích: hạ HDR rồi mới co/pad, ngược lại là
    // co ở dải sáng chưa nén.
    /* NGUỒN THIẾU NHÃN MA TRẬN: gắn TƯỜNG MINH đúng ma trận mà preview đã dùng để hiển thị nó
     * (theo chiều cao của CHÍNH nguồn). Không gắn thì bản chuẩn hoá vẫn thiếu nhãn, mà bước
     * `fit` có thể đổi chiều cao (vd. 1280x540 -> khung bao 1920x1920) làm Chromium đổi cách
     * đoán — cùng điểm ảnh bỗng hiện khác màu. Có nhãn rồi thì preview và bản xuất đọc như nhau. */
    const tagFix = (!tonemapChain && untaggedMatrix)
      ? `setparams=colorspace=${untaggedMatrix}:color_primaries=${untaggedMatrix === 'bt709' ? 'bt709' : 'smpte170m'}:color_trc=bt709`
      : '';
    const chain = [tagFix, tonemapChain, fit].filter(Boolean).join(',');
    if (chain) args.push('-vf', chain);
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      ...PREVIEW_FRIENDLY_GOP_ARGS,   // xem chú thích của hằng số
    );
    /* Ép cùng nhịp khung vì concat demuxer không nối được 2 fps khác nhau. NHƯNG chỉ khi thật
     * có nhiều nguồn để nối: một nguồn HDR đơn lẻ nay cũng đi qua đây, và ép nó về 30 sẽ ném
     * đi một nửa số khung của clip 60fps — mất khung mà không ai yêu cầu.
     * NHỊP ĐÍCH = nhịp CAO NHẤT của bộ nguồn (xem concatTargetFps), KHÔNG còn ghi cứng 30. */
    if (forceFps) args.push('-r', canonicalFpsText(targetFps, '30'));
    if (withAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
    if (withAudio && !hasAudio) args.push('-shortest');
    // Gắn nhãn cho ĐÚNG cái vừa ghi ra. Thiếu bước này thì file 8-bit vẫn mang nhãn HLG/BT.2020
    // của nguồn — "HDR giả" mà mọi player sẽ diễn giải sai y như lỗi ban đầu.
    if (tonemapChain) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    else if (untaggedMatrix) {  // (tính ở đầu hàm, cùng lúc với tên file)
      args.push('-color_primaries', untaggedMatrix === 'bt709' ? 'bt709' : 'smpte170m',
        '-color_trc', 'bt709', '-colorspace', untaggedMatrix, '-color_range', 'tv');
    }
    args.push('-movflags', '+faststart', output);
    return args;
  };

  if (!isHdr) {
    await runProcess('ffmpeg', buildArgs(''));
    return { name: path.basename(output), path: output, original_path: file.path, reused: false };
  }
  await runTonemapWithFallback(buildArgs, () => setStatus(`Nguồn ${index + 1}: tonemap GPU lỗi, đang làm lại bằng CPU...`));
  return { name: path.basename(output), path: output, original_path: file.path, reused: false };
}

/* Chạy một lệnh tonemap, tự tụt về CPU nếu đường GPU chết.
 *
 * `buildArgs(chain)` phải dựng lại TOÀN BỘ lệnh từ chuỗi filter được đưa: nhánh Vulkan còn
 * cần thêm `-init_hw_device` ở đầu lệnh, không chỉ đổi mỗi `-vf`.
 *
 * Dò được Vulkan mà chạy thật vẫn chết (hết VRAM, driver treo giữa file dài...) thì hạ cờ
 * luôn, để các nguồn sau trong cùng lượt nhập không lặp lại cùng một cú chết. Không có nhánh
 * cứu hộ nào cho zscale — nó chết thì lỗi phải nổi lên, vì bản duy nhất còn lại là bản sai màu. */
async function runTonemapWithFallback(buildArgs, onFallback = null) {
  const usePlacebo = vulkanTonemapUsable();
  try {
    await runProcess('ffmpeg', buildArgs(usePlacebo ? HDR_TONEMAP_PLACEBO : HDR_TONEMAP_ZSCALE));
  } catch (error) {
    if (!usePlacebo) throw error;
    vulkanTonemapProbe = false;
    console.log(`[hdr] libplacebo lỗi giữa đường, chuyển sang zscale CPU: ${error.message}`);
    if (onFallback) onFallback(error);
    await runProcess('ffmpeg', buildArgs(HDR_TONEMAP_ZSCALE));
  }
}

/* --- BẢN SDR CỦA MỘT ASSET OVERLAY ---
 *
 * Lane chính đi qua normalizeVideoForConcat nên đã đúng màu; asset overlay thì KHÔNG có bước
 * nào tương đương: `/editing-assets/link` cố tình không chép và không probe (cả cây footage
 * hàng trăm file), nên một b-roll HDR kéo lên lane overlay vẫn cháy y như lỗi gốc — cháy trong
 * preview VÀ cháy trong file xuất, vì sidecar mở thẳng `asset_path`.
 *
 * Bản SDR nằm trong TEMP_DIR (không bao giờ ghi cạnh file nguồn của người dùng) và được dùng
 * cho CẢ preview lẫn export: một file, một lượt chờ, không có đường nào lệch màu giữa hai khâu.
 * Khoá theo path+size+mtime nên mỗi file chỉ phải dựng một lần; đổi nội dung file là ra khoá
 * khác. Đo trên clip HLG 1080×1920: ~1/3 thời lượng clip (12s clip -> 4s), tức b-roll thường
 * gặp là vài giây.
 *
 * KHÔNG ném lỗi ra ngoài: dựng hụt thì trả lại đường dẫn gốc — asset vẫn dùng được (chỉ sai
 * màu như trước) còn hơn làm sập cả lượt nhập hay cả lượt xuất vì một file.
 *
 * CHỖ ĐẶT FILE không phải chuyện tuỳ ý: phải nằm DƯỚI editing_assets/ vì lúc lưu .crab,
 * isTempEditingAssetRecord() (index.html) nhận asset của dự án bằng cách tìm chuỗi
 * "temp_uploads/editing_assets" trong url — đặt ra ngoài là asset không vào manifest và mở
 * lại dự án thì mất luôn block. Mỗi bản nằm trong thư mục con tên theo khoá, nhờ đó GIỮ ĐƯỢC
 * TÊN GỐC để panel không hiện một chuỗi băm, mà hai file trùng tên từ hai thư mục khác nhau
 * vẫn không đè nhau. Đuôi luôn .mp4 vì bản ra là H.264 — giữ .mov của nguồn là dán sai nhãn
 * container. (generated_text/ cũng là một thư mục con như vậy, xem GENERATED_TEXT_ASSET_DIR.) */
async function ensureSdrAsset(filePath, { label = '' } = {}) {
  const resolved = path.resolve(filePath);
  if (!sourceIsHdr(resolved)) return { path: resolved, tonemapped: false };
  let stat;
  try { stat = fs.statSync(resolved); } catch (_) { return { path: resolved, tonemapped: false }; }
  const key = sha1Text(`${resolved}|${stat.size}|${stat.mtimeMs}`).slice(0, 24);
  const dir = path.join(EDITING_ASSET_DIR, 'sdr', key);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(resolved, path.extname(resolved));
  const output = path.join(dir, `${base}.mp4`);
  if (fs.existsSync(output) && fs.statSync(output).size > 0) {
    return { path: output, tonemapped: true, reused: true };
  }
  /* MỘT lượt dựng cho mỗi file, dù có bao nhiêu bên hỏi cùng lúc. Bấm Xuất trong khi preview
   * đang dựng cùng asset đó là hai tiến trình ffmpeg ghi vào ĐÚNG một đường dẫn — file ra hỏng
   * mà không bên nào báo lỗi. Bên đến sau chờ chung kết quả của bên đầu. */
  const inflight = sdrAssetInflight.get(output);
  if (inflight) return inflight;
  const job = buildSdrAsset(resolved, output, label);
  sdrAssetInflight.set(output, job);
  try {
    return await job;
  } finally {
    sdrAssetInflight.delete(output);
  }
}

const sdrAssetInflight = new Map();

async function buildSdrAsset(resolved, output, label) {
  const name = label || path.basename(resolved);
  setStatus(`Asset "${name}" là HDR — đang hạ về SDR để màu hiển thị đúng...`);
  const hasAudio = mediaHasAudio(resolved);
  const buildArgs = (tonemapChain) => {
    const args = ['-y', '-hide_banner', '-v', 'error'];
    if (tonemapChain === HDR_TONEMAP_PLACEBO) args.push('-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk');
    args.push('-i', resolved, '-map', '0:v:0');
    if (hasAudio) args.push('-map', '0:a:0');
    args.push(
      '-vf', tonemapChain,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      ...PREVIEW_FRIENDLY_GOP_ARGS,   // xem chú thích của hằng số
    );
    // KHÔNG ép fps và KHÔNG ép độ phân giải: asset overlay không phải nối với ai, mà block
    // trên timeline đã dựng theo số đo của chính file này.
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
    args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    args.push('-movflags', '+faststart', output);
    return args;
  };
  try {
    await runTonemapWithFallback(buildArgs, () => setStatus(`Asset "${name}": tonemap GPU lỗi, đang làm lại bằng CPU...`));
  } catch (error) {
    await fsp.rm(output, { force: true }).catch(() => {});
    recordProjectError('sdr_asset', error, { path: resolved });
    console.log(`[hdr] không dựng được bản SDR cho "${name}", dùng nguyên bản HDR: ${error.message}`);
    return { path: resolved, tonemapped: false };
  }
  return { path: output, tonemapped: true, reused: false };
}

/* Thay đường dẫn asset HDR bằng bản SDR cho MỘT LƯỢT XUẤT.
 *
 * Vì sao vẫn cần dù preview đã đổi sang bản SDR: dự án mở lại từ .crab mang theo `path` đã lưu
 * (trỏ file HDR gốc), và người dùng có thể bấm Xuất mà chưa hề chạm vào block overlay nào —
 * lúc đó không có gì kích hoạt đường preview. File giao khách thì không được phép sai màu, nên
 * chốt lại ở đây. Asset đã có bản SDR từ trước thì bước này chỉ là một lần tra đĩa. */
async function sdrOverridesForEditingAssets(rawEditing) {
  const overrides = new Map();
  const raw = parseOptionalJsonObject(rawEditing);
  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  for (const asset of assets) {
    const assetPath = String(asset?.path || '');
    if (!assetPath) continue;
    if (editingAssetKindForPath(assetPath) !== 'media_video') continue;
    if (!fs.existsSync(assetPath)) continue;
    const sdr = await ensureSdrAsset(assetPath, { label: String(asset?.name || '') });
    if (sdr.tonemapped && sdr.path !== path.resolve(assetPath)) overrides.set(assetPath, sdr.path);
  }
  return overrides;
}

function normalizedCopyIsFresh(sourcePath, normalizedPath) {
  try {
    const out = fs.statSync(normalizedPath);
    if (out.size <= 0) return false;
    const src = fs.statSync(sourcePath);
    return Math.trunc(out.mtimeMs) >= Math.trunc(src.mtimeMs);
  } catch (_) {
    return false;
  }
}

async function normalizeSourcesForConcat(savedFiles, force = false) {
  // Một file thì không có gì để lệch với ai — bỏ qua cả bước probe.
  let needsNormalize = force || savedFiles.some((file) => shouldNormalizeForConcat(file.path));
  if (!needsNormalize && savedFiles.length > 1) {
    const signatures = savedFiles.map((file) => concatStreamSignature(file.path));
    needsNormalize = signatures.some((sig) => sig !== signatures[0]);
    if (needsNormalize) {
      setStatus('Video nguồn khác định dạng nhau — đang chuẩn hoá trước khi nối...');
    }
  }
  if (!needsNormalize) return savedFiles;
  // Có ÍT NHẤT một nguồn có tiếng thì mọi bản chuẩn hoá đều phải có rãnh tiếng (câm nếu
  // cần). Không nguồn nào có tiếng thì bỏ hẳn rãnh tiếng cho nhẹ.
  const withAudio = savedFiles.some((file) => mediaHasAudio(file.path));
  // Chỉ có một nguồn thì không có ai để khớp nhịp khung -> giữ fps gốc (xem normalizeVideoForConcat).
  const forceFps = savedFiles.length > 1;
  // Khổ hình chung cho CẢ lượt nối — chỉ cần khi thật sự có nhiều nguồn để ghép.
  const target = savedFiles.length > 1 ? concatTargetSize(savedFiles) : null;
  // Nhịp khung chung: nhịp CAO NHẤT trong bộ nguồn, để không nguồn nào bị lược khung ở khâu
  // nhập (xem concatTargetFps). Chỉ đo khi thật sự phải ép nhịp.
  const targetFps = forceFps ? concatTargetFps(savedFiles) : '';
  if (targetFps) console.log(`[reingest] nhịp khung file nối: ${targetFps}`);
  const normalized = [];
  let reused = 0;
  for (let i = 0; i < savedFiles.length; i += 1) {
    const out = await normalizeVideoForConcat(savedFiles[i], i, { withAudio, force, forceFps, target, targetFps });
    if (out.reused) reused += 1;
    normalized.push(out);
  }
  if (reused) console.log(`[reingest] dùng lại ${reused}/${savedFiles.length} bản chuẩn hoá`);
  return normalized;
}

/* =============================================================================
 * BỘ NHỚ ĐỆM FILE ĐÃ NỐI — "mở lại dự án phải nhanh"
 *
 * VẤN ĐỀ. Mở một tệp .crab là: xoá temp_uploads -> chép lại TỪNG video nguồn vào đó ->
 * chuẩn hoá nguồn nào khác định dạng (mã hoá lại) -> nối tất cả thành temp_input.mp4 ->
 * dựng sóng âm + proxy. Dự án thật của người dùng là 14 nguồn ~450MB: mỗi lần mở lại làm
 * đúng chừng ấy việc, dù KHÔNG có gì đổi kể từ lần lưu (báo cáo 2026-09-08: "thời gian mở
 * lại dự án rất lâu").
 *
 * CÁCH LÀM (đúng khuôn Media Cache của Premiere: dữ liệu dẫn xuất sống LÂU HƠN một phiên
 * làm việc và dùng lại được giữa các lần mở). Khoá = băm của DANH SÁCH NGUỒN THEO ĐÚNG THỨ
 * TỰ NỐI, mỗi nguồn kèm size + mtime — đổi thứ tự, thay một file, sửa nội dung một file
 * đều ra khoá khác. Trúng khoá thì KHÔNG chép, KHÔNG mã hoá, KHÔNG nối: chỉ tạo một liên
 * kết cứng (hard link) từ file trong cache sang temp_uploads/temp_input.mp4.
 *
 * CHÉP CHỨ KHÔNG HARD LINK. Hard link nhanh hơn (0 byte, 0 giây) và đã thử, nhưng nó làm
 * temp_input.mp4 và mục cache thành CÙNG MỘT file: lượt nối sau ghi đè temp_input.mp4 là
 * sửa luôn nội dung mục cache, và trên Windows lại còn EPERM khi job sóng âm/proxy đang đọc
 * file đó (đo được ngay trong tests/scripts/concat_cache.js). Một cú copy vẫn rẻ hơn hẳn
 * việc chép lại TỪNG nguồn + chuẩn hoá + nối lại, nên đổi lấy sự an toàn là xứng.
 *
 * GIỮ NGUYÊN mtime KHI CHÉP (utimes) — không phải chi tiết làm đẹp: peaks_cache và
 * proxy_cache khoá theo (path|size|mtime), và `video_version` gửi cho renderer cũng là
 * mtime. Giữ nguyên thì mở lại dự án cũ dùng lại được luôn cả .pk lẫn proxy LQ, và URL
 * preview không đổi nên trình duyệt cũng không phải tải lại.
 *
 * BẢNG ĐOẠN ĐI CÙNG (`<khoá>.json`): nó là hợp đồng giữa file nối và mọi clip trên lane
 * chính (xem concatSegmentTable). Trúng cache mà không có bảng thì phải ffprobe lại từng
 * nguồn — nên bảng được ghi cùng, và thiếu bảng thì coi như TRƯỢT cache.
 * ============================================================================= */
/* Dừng mọi job nền đang đọc temp_input.mp4 rồi ĐỢI chúng nhả file.
 *
 * SIGKILL chứ không SIGTERM: ffmpeg bắt SIGTERM để dọn dẹp, mà chỗ này cần file được nhả
 * NGAY. Bản ra của chúng là file tạm/đích sẽ bị ghi đè ngay sau đó nên không có gì để mất.
 * Vòng chờ ngắn: tiến trình đã chết thì Windows nhả handle gần như tức thì. */
async function stopMainVideoReaders() {
  /* Job sóng âm ĐANG XẾP HÀNG cũng phải bỏ, không chỉ job đang chạy: hàng đợi bơm bất đồng
   * bộ, nên một job của lượt trước có thể vừa kịp spawn NGAY SAU khi ta giết xong và lại
   * giữ file trong đúng lúc ta ghi đè. Nguồn lane chính sẽ được xếp hàng lại ngay sau khi
   * file mới xong, nên bỏ ở đây không mất gì. */
  const mainVideo = path.join(TEMP_DIR, 'temp_input.mp4');
  for (let i = peaksQueue.length - 1; i >= 0; i -= 1) {
    if (peaksQueue[i]?.source !== mainVideo) continue;
    const job = peaksQueue.splice(i, 1)[0];
    peaksJobs.delete(job.key);
  }
  if (!mainVideoReaders.size) return;
  for (const child of Array.from(mainVideoReaders)) {
    try { child.kill('SIGKILL'); } catch (_) { mainVideoReaders.delete(child); }
  }
  /* Đợi tiến trình con báo 'exit' rồi CHỜ THÊM một nhịp: trên Windows, handle của tiến
   * trình vừa chết không phải lúc nào cũng được nhả ngay khi 'exit' bắn. */
  for (let i = 0; i < 20 && mainVideoReaders.size; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
}

function concatCacheKey(resolvedSources) {
  const parts = (resolvedSources || []).map((filePath) => {
    let stat = null;
    try { stat = fs.statSync(filePath); } catch (_) { stat = null; }
    return `${filePath}|${stat ? stat.size : 0}|${stat ? Math.trunc(stat.mtimeMs) : 0}`;
  });
  return crypto.createHash('sha1')
    .update(`v${CONCAT_CACHE_VERSION}\n${parts.join('\n')}`)
    .digest('hex');
}

function concatCachePaths(key) {
  return {
    video: path.join(CONCAT_CACHE_DIR, `${key}.mp4`),
    meta: path.join(CONCAT_CACHE_DIR, `${key}.json`),
  };
}

function concatCacheLookup(key) {
  const { video, meta } = concatCachePaths(key);
  try {
    if (!fs.existsSync(video) || !fs.existsSync(meta)) return null;
    if (fs.statSync(video).size <= 0) return null;
    const data = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (!Array.isArray(data?.segments) || !data.segments.length) return null;
    return { video, segments: data.segments };
  } catch (_) {
    return null;
  }
}

/* Đặt mtime theo một mốc ms CHẴN.
 *
 * utimes nhận giây kiểu số thực, nên chép rồi "giữ nguyên mtime" bằng chính giá trị đọc
 * được vẫn lệch ~1ms sau một vòng làm tròn — mà peaks_cache/proxy_cache khoá theo mtime và
 * `video_version` CHÍNH LÀ mtime, nên lệch 1ms là trượt sạch cache và preview phải tải lại.
 * Chuẩn hoá về mốc chẵn rồi áp CÙNG MỘT phép cho cả bản gốc lẫn bản trong cache thì mọi lượt
 * chép sau đều ra đúng một giá trị. */
function applyMtimeMs(filePath, mtimeMs) {
  const seconds = Math.floor(mtimeMs) / 1000;
  try { fs.utimesSync(filePath, seconds, seconds); } catch (_) { /* không đặt được thì chỉ mất cache */ }
  return fs.statSync(filePath).mtimeMs;
}

function concatCacheStore(key, videoPath, segments) {
  try {
    if (!Array.isArray(segments) || !segments.length) return;
    fs.mkdirSync(CONCAT_CACHE_DIR, { recursive: true });
    const { video, meta } = concatCachePaths(key);
    fs.rmSync(video, { force: true });
    // Chuẩn hoá mtime của CẢ bản vừa nối lẫn bản trong cache về cùng một mốc: nhờ vậy lượt
    // mở lại sau này dựng ra file có mtime y hệt lượt nối đầu tiên -> sóng âm + proxy +
    // bộ đệm của trình duyệt đều dùng lại được.
    const canonical = applyMtimeMs(videoPath, fs.statSync(videoPath).mtimeMs);
    fs.copyFileSync(videoPath, video);
    applyMtimeMs(video, canonical);
    fs.writeFileSync(meta, JSON.stringify({ version: CONCAT_CACHE_VERSION, segments }), 'utf8');
  } catch (error) {
    console.log(`[concat-cache] không ghi được cache: ${error?.message || error}`);
  }
}

/* Đưa bản trong cache ra temp_uploads/temp_input.mp4.
 *
 * ĐANG ĐÚNG RỒI THÌ KHÔNG ĐỤNG VÀO. File đích có thể đang bị job sóng âm / job proxy đọc
 * (chúng chạy nền sau MỖI lượt nạp), mà trên Windows xoá/ghi đè file đang mở là EPERM — đo
 * được thật trong tests/scripts/main_lane_concat_offsets.js. Mà đúng lúc đó việc chép lại
 * cũng vô nghĩa: size + mtime trùng bản trong cache nghĩa là NỘI DUNG đã đúng (mtime của cả
 * hai đều do applyMtimeMs đặt về cùng một mốc). Bỏ qua là vừa nhanh vừa hết va chạm. */
function materializeConcatFromCache(cacheVideoPath, outputPath) {
  const cacheStat = fs.statSync(cacheVideoPath);
  try {
    const current = fs.statSync(outputPath);
    if (current.size === cacheStat.size && Math.trunc(current.mtimeMs) === Math.trunc(cacheStat.mtimeMs)) {
      return outputPath;
    }
  } catch (_) { /* chưa có file đích -> chép như thường */ }
  fs.rmSync(outputPath, { force: true, maxRetries: 5, retryDelay: 120 });
  fs.copyFileSync(cacheVideoPath, outputPath);
  applyMtimeMs(outputPath, cacheStat.mtimeMs);
  return outputPath;
}

/* Dọn cache bản đã nối: quá hạn HOẶC thuộc phiên bản cũ.
 * Mục của phiên bản cũ không bao giờ được đọc lại nữa (khoá đã đổi) nhưng mỗi mục là một
 * file vài trăm MB — bỏ đó chờ hết hạn 30 ngày là chiếm chỗ vô ích. Đọc version trong tệp
 * .json đi kèm; mục nào thiếu/lệch version thì xoá cả cặp .mp4 + .json. */
function pruneConcatCache() {
  try {
    if (!fs.existsSync(CONCAT_CACHE_DIR)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(CONCAT_CACHE_DIR)) {
      if (!name.endsWith('.json')) continue;
      const meta = path.join(CONCAT_CACHE_DIR, name);
      const video = meta.replace(/.json$/, '.mp4');
      let stale = (now - fs.statSync(meta).mtimeMs) > CONCAT_CACHE_TTL_MS;
      if (!stale) {
        try {
          stale = JSON.parse(fs.readFileSync(meta, 'utf8'))?.version !== CONCAT_CACHE_VERSION;
        } catch (_) { stale = true; }
      }
      if (stale) {
        fs.rmSync(meta, { force: true });
        fs.rmSync(video, { force: true });
      }
    }
    // Mục .mp4 mồ côi (mất tệp .json đi kèm) thì không tra được nữa -> xoá luôn.
    for (const name of fs.readdirSync(CONCAT_CACHE_DIR)) {
      if (!name.endsWith('.mp4')) continue;
      const video = path.join(CONCAT_CACHE_DIR, name);
      if (!fs.existsSync(video.replace(/.mp4$/, '.json'))) fs.rmSync(video, { force: true });
    }
  } catch (_) { /* dọn được thì tốt, không thì bỏ qua */ }
}

/* Trả { path, inputs }: `inputs` là những file THẬT SỰ đi vào concat, đúng thứ tự — bản
 * chuẩn hoá khi nguồn phải mã hoá lại, còn không thì chính bản chép trong temp_uploads.
 * Người gọi cần nó để đo BẢNG ĐOẠN (xem concatSegmentTable): đo trên file gốc là sai vài ms
 * với mọi nguồn phải chuẩn hoá, mà lệch một chút ở đoạn đầu là mọi mốc phía sau trôi theo. */
async function concatVideos(savedFiles) {
  if (!savedFiles.length) throw new Error('Không có video hợp lệ để nối.');
  const outputPath = path.join(TEMP_DIR, 'temp_input.mp4');
  /* Gỡ bản cũ trước cho sạch (sidecar ghi đè cũng được). KHÔNG để lỗi ở đây làm hỏng cả
   * lượt nối: trên Windows, job sóng âm/proxy đang đọc temp_input.mp4 là rm ném EPERM. */
  try { fs.rmSync(outputPath, { force: true, maxRetries: 3, retryDelay: 100 }); } catch (_) { /* để sidecar ghi đè */ }
  let concatInputs = await normalizeSourcesForConcat(savedFiles);
  try {
    await runSidecar(['concat', outputPath, ...concatInputs.map((f) => f.path)]);
  } catch (error) {
    if (concatInputs !== savedFiles) throw error;
    concatInputs = await normalizeSourcesForConcat(savedFiles, true);
    await runSidecar(['concat', outputPath, ...concatInputs.map((f) => f.path)]);
  }
  return { path: outputPath, inputs: concatInputs.map((f) => f.path) };
}

/* BẢNG ĐOẠN của temp_input.mp4: nguồn thứ i chiếm khoảng [start, end) trong file đã nối.
 *
 * VÌ SAO PHẢI DO BACKEND TRẢ VỀ. Đây là HỢP ĐỒNG giữa temp_input.mp4 và mọi clip trên lane
 * chính (clip lưu mốc theo timebase của file đó). Trước đây renderer tự đoán bảng này bằng
 * cách ffprobe các file GỐC rồi cộng dồn, và tự suy bảng CŨ từ danh sách nguồn hiện tại —
 * hai phép đoán đó sai ngay khi (a) một nguồn phải chuẩn hoá lại (thời lượng lệch vài ms),
 * hoặc (b) file đã nối chứa một nguồn mà lane chính không còn clip nào của nó. Sai mà KHÔNG
 * có lỗi nào báo: preview vẫn chạy, chỉ là chiếu nhầm cảnh (người dùng báo 2026-09-08 —
 * xoá một video rồi thêm video khác thì preview hiện đúng cái video vừa xoá).
 *
 * Ở đây thì không phải đoán: vừa nối xong nên biết chính xác file nào vào theo thứ tự nào.
 * resolvedSources[i] là ĐƯỜNG DẪN GỐC trên máy người dùng — renderer khoá mọi thứ theo nó,
 * không theo bản chép trong temp_uploads. */
/* VÙNG ẢNH THẬT ĐI CÙNG BẢNG ĐOẠN (thêm 2026-09-09). Khung nối là KHUNG BAO của mọi nguồn,
 * nên nguồn khác khổ được đặt giữa khung và phần còn lại là viền đen NẰM TRONG khung hình.
 * Mỗi đoạn vì thế phải khai luôn: khổ nguồn (`source_width/height`) và hình chữ nhật ảnh
 * thật trong khung nối (`content`). Thiếu hai trường này thì phía sau không có cách nào
 * phân biệt "viền do ta chèn" với "viền vốn có trong ảnh":
 *   - preview vẽ khung transform bao cả viền thay vì bao ảnh -> kéo/co giãn lệch;
 *   - export không biết đường crop viền đi.
 * Bảng đoạn ĐÃ được lưu vào .crab (`main_lane_segments`) và vào bộ đệm file nối, nên hai
 * trường này tự đi theo dự án — không phát sinh state song song nào. */
function concatSegmentTable(inputs, resolvedSources, concatPath) {
  const out = [];
  let cursor = 0;
  const frameInfo = mediaVideoInfo(concatPath || '');
  const frame = {
    width: Number(frameInfo?.width) || 0,
    height: Number(frameInfo?.height) || 0,
  };
  (inputs || []).forEach((filePath, index) => {
    // ĐỘ DÀI CỦA LUỒNG HÌNH, không phải của container — xem mediaVideoSegmentSeconds.
    const duration = mediaVideoSegmentSeconds(filePath);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const source = String((resolvedSources || [])[index] || '');
    const start = cursor;
    cursor += duration;
    /* Khổ ảnh thật hỏi NGUỒN GỐC, không hỏi `filePath`: filePath có thể là bản đã chuẩn hoá
     * — nó ĐÃ mang khung bao kèm viền, hỏi nó là mất đúng thông tin đang cần. */
    const srcInfo = mediaVideoInfo(source);
    const content = MainLane.contentRectIn(frame, srcInfo?.width, srcInfo?.height);
    out.push({
      source_path: source,
      name: path.basename(source) || `source_${index + 1}`,
      start,
      end: cursor,
      duration,
      source_width: Number(srcInfo?.width) || 0,
      source_height: Number(srcInfo?.height) || 0,
      content: content || null,
    });
  });
  return out;
}

/* `generation`: mã lượt của previewProxyState. KIỂM LẠI NGAY TRƯỚC KHI SPAWN, không chỉ ở
 * đầu job. Giữa hai mốc đó có một `await` (xoá bản proxy cũ), và đúng trong khe đó lượt nạp
 * kế tiếp có thể đã dừng mọi job đọc temp_input.mp4 để ghi đè nó — job này spawn sau lại giữ
 * file, và lượt nạp kia chết vì EPERM trên Windows. runSidecar spawn ĐỒNG BỘ ngay sau dòng
 * kiểm nên không còn khe nào lọt. */
async function createPreviewProxy(videoPath, generation) {
  const outputPath = path.join(TEMP_DIR, PREVIEW_PROXY_NAME);
  await fsp.rm(outputPath, { force: true });
  if (generation !== undefined && generation !== previewProxyGeneration) return null;
  await runSidecar(['preview-proxy', videoPath, outputPath], {
    forwardStatus: false,
    readsMainVideo: videoPath === path.join(TEMP_DIR, 'temp_input.mp4'),
  });
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 0) return null;
  const stat = fs.statSync(outputPath);
  return {
    path: outputPath,
    url: `/temp_uploads/${PREVIEW_PROXY_NAME}?v=${Math.trunc(stat.mtimeMs)}`,
    size_bytes: stat.size,
    size_human: formatBytes(stat.size),
  };
}

function cacheSourceDescriptors(savedFiles, resolvedSources) {
  const sourcePaths = Array.isArray(resolvedSources) && resolvedSources.length
    ? resolvedSources
    : (Array.isArray(savedFiles) ? savedFiles.map((file) => file.path) : []);
  return sourcePaths.map((source, index) => {
    const filePath = String(source || '');
    let stat = null;
    let realPath = filePath;
    try {
      realPath = fs.realpathSync(filePath);
      stat = fs.statSync(realPath);
    } catch (_) {
      stat = null;
    }
    return {
      index,
      path: realPath,
      name: path.basename(realPath || `source_${index + 1}`),
      size_bytes: stat ? stat.size : null,
      mtime_ms: stat ? Math.trunc(stat.mtimeMs) : null,
    };
  });
}

function buildAsrCacheKey({ savedFiles, resolvedSources, referenceScript, transcribeMode, requestedEngine, asrModel, runtime }) {
  const keyPayload = {
    version: ASR_CACHE_VERSION,
    platform: process.platform,
    arch: process.arch,
    engine: requestedEngine,
    asr_model: asrModel || null,
    runtime: runtime || null,
    transcribe_mode: transcribeMode || 'vi_smart',
    reference_script_sha1: sha1Text(referenceScript || ''),
    sources: cacheSourceDescriptors(savedFiles, resolvedSources),
  };
  return {
    key: sha1Text(JSON.stringify(keyPayload)),
    payload: keyPayload,
  };
}

function asrCachePath(cacheKey) {
  return path.join(ASR_CACHE_DIR, `${cacheKey}.json`);
}

async function readAsrCache(cacheKey) {
  const cachePath = asrCachePath(cacheKey);
  try {
    const payload = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
    if (payload?.version !== ASR_CACHE_VERSION || !payload?.result || !Array.isArray(payload.result.segments)) {
      return null;
    }
    return payload.result;
  } catch (_) {
    return null;
  }
}

async function writeAsrCache(cacheKey, keyPayload, result) {
  if (!result || !Array.isArray(result.segments)) return;
  ensureDirs();
  const cachePath = asrCachePath(cacheKey);
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(jsonSafe({
    version: ASR_CACHE_VERSION,
    created_at: isoNow(),
    key: keyPayload,
    result,
  })), 'utf8');
  await fsp.rename(tmpPath, cachePath);
}

/* DÙNG LẠI BẢN PROXY ĐÃ LƯU KÈM DỰ ÁN, thay vì encode lại từ đầu.
 *
 * Trả về public state nếu nhận được, `null` nếu không — nơi gọi rơi về queuePreviewProxy().
 * KHÔNG ném: đây là đường TỐI ƯU, hỏng ở đây chỉ được phép làm chậm, không được làm mở dự
 * án thất bại.
 *
 * BỐN CỬA, phải qua hết:
 *   1. tệp có thật, là .mp4, kích thước hợp lý;
 *   2. danh tính đi kèm KHỚP TUYỆT ĐỐI với file nối vừa dựng (xem previewProxyIdentity);
 *   3. DUNG LƯỢNG tệp proxy khớp ĐÚNG TỪNG BYTE con số đã ghi lúc lưu;
 *   4. thời lượng của chính tệp proxy khớp thời lượng file nối trong vòng nửa khung hình;
 *   5. chép được vào temp_uploads.
 *
 * VÌ SAO CẦN CẢ (3) LẪN (4) — đo được, không phải đề phòng suông. Bản đầu chỉ có (4) và một
 * tệp proxy BỊ CẮT CỤT (mô phỏng chép hụt qua mạng/USB) vẫn LỌT QUA: MP4 để `moov` ở đầu tệp
 * nên ffprobe vẫn đọc ra đủ 6,023s từ metadata dù phần dữ liệu đã mất. Thời lượng là thứ
 * KHAI BÁO trong tệp, không phải thứ đo từ dữ liệu thật. Dung lượng thì không nói dối được.
 * Ngược lại (3) không thay được (4): một tệp proxy hoàn chỉnh nhưng của bản nối khác có thể
 * tình cờ cùng dung lượng, và (4) bắt nó.
 * Trượt cửa nào cũng im lặng dựng lại — người dùng mất vài phút encode, không mất niềm tin
 * vào khung xem trước. */
function tryAdoptPreviewProxy(descriptor, concatPath) {
  const sourcePath = String(descriptor?.path || '');
  if (!sourcePath) return null;
  try {
    const resolved = path.resolve(sourcePath);
    if (path.extname(resolved).toLowerCase() !== '.mp4') return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0) return null;

    const current = previewProxyIdentityFor(concatPath);
    if (!previewProxyIdentityMatches(descriptor?.identity, current)) {
      setStatus('Bản proxy lưu kèm dự án không khớp video nguồn — đang dựng lại.');
      return null;
    }
    // Cửa 3: dung lượng phải khớp TỪNG BYTE con số đã ghi lúc lưu (xem khối chú thích trên).
    const expectedSize = Number(descriptor?.size_bytes);
    if (!Number.isFinite(expectedSize) || expectedSize <= 0 || stat.size !== expectedSize) {
      setStatus('Bản proxy lưu kèm dự án không còn nguyên vẹn — đang dựng lại.');
      return null;
    }
    const proxyDuration = mediaDurationSeconds(resolved);
    const concatDuration = (Number(current.duration_ms) || 0) / 1000;
    // Nửa khung ở 24fps ≈ 0,021s; nới lên 0,05s cho sai số làm tròn của ffprobe giữa hai
    // container khác nhau, vẫn chặt hơn một khung hình.
    if (!Number.isFinite(proxyDuration) || Math.abs(proxyDuration - concatDuration) > 0.05) return null;

    const outputPath = path.join(TEMP_DIR, PREVIEW_PROXY_NAME);
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    fs.rmSync(outputPath, { force: true });
    fs.copyFileSync(resolved, outputPath);
    const outStat = fs.statSync(outputPath);

    resetPreviewProxyState('ready');
    previewProxyState.preview_video_url = `/temp_uploads/${PREVIEW_PROXY_NAME}?v=${Math.trunc(outStat.mtimeMs)}`;
    previewProxyState.path = outputPath;
    previewProxyState.size_bytes = outStat.size;
    previewProxyState.size_human = formatBytes(outStat.size);
    previewProxyState.duration_ms = 0;     // không encode -> không có thời gian encode
    previewProxyState.ready_at = isoNow();
    previewProxyState.identity = current;
    setStatus('Đã dùng lại bản proxy lưu kèm dự án — không phải dựng lại.');
    return previewProxyPublicState();
  } catch (error) {
    recordProjectError('preview_proxy_adopt', error, { command: 'preview-proxy-adopt' });
    return null;
  }
}

function queuePreviewProxy(videoPath) {
  const generation = resetPreviewProxyState('queued');
  const queuedAtMs = Date.now();
  setImmediate(async () => {
    if (generation !== previewProxyGeneration) return;
    previewProxyState.status = 'running';
    previewProxyState.started_at = isoNow();
    const startedAtMs = Date.now();
    try {
      const proxy = await createPreviewProxy(videoPath, generation);
      if (generation !== previewProxyGeneration) return;   // lượt này đã lỗi thời -> bỏ im lặng
      if (!proxy) throw new Error('Không tạo được preview proxy.');
      // Danh tính của file nối mà proxy này vừa được dựng ra từ đó — renderer lưu nó vào
      // .crab để lượt mở sau chứng minh được proxy còn dùng được (xem tryAdoptPreviewProxy).
      previewProxyState.identity = previewProxyIdentityFor(videoPath);
      previewProxyState.status = 'ready';
      previewProxyState.preview_video_url = proxy.url;
      previewProxyState.path = proxy.path;
      previewProxyState.size_bytes = proxy.size_bytes;
      previewProxyState.size_human = proxy.size_human;
      previewProxyState.duration_ms = elapsedMs(startedAtMs);
      previewProxyState.ready_at = isoNow();
      if (projectMetrics.transcribe) {
        projectMetrics.transcribe.preview_proxy = previewProxyPublicState();
        projectMetrics.transcribe.diagnostics = {
          ...(projectMetrics.transcribe.diagnostics || {}),
          preview_proxy_queue_wait_ms: Math.max(0, startedAtMs - queuedAtMs),
          preview_proxy_duration_ms: previewProxyState.duration_ms,
        };
      }
    } catch (error) {
      if (generation !== previewProxyGeneration) return;
      previewProxyState.status = 'error';
      previewProxyState.duration_ms = elapsedMs(startedAtMs);
      previewProxyState.error = cleanInlineText(error?.message || error, 500);
      if (projectMetrics.transcribe) {
        projectMetrics.transcribe.preview_proxy = previewProxyPublicState();
      }
      recordProjectError('preview_proxy', error, { command: 'preview-proxy' });
    }
  });
  return previewProxyPublicState();
}

/* =============================================================================
 * SÓNG ÂM THẬT cho timeline Editing — cache file .pk + hàng đợi job nền
 *
 * Mục tiêu (yêu cầu người dùng): block trên timeline Editing phải vẽ ĐÚNG dữ liệu
 * âm thanh (như CapCut/Premiere) mà người dùng KHÔNG phải đợi load/tính toán.
 * Cách đạt: peak được sinh TRƯỚC (prewarm) bằng sidecar `audio-peaks` -> file .pk
 * nhị phân (750 peak/giây, 2 byte/peak) cache trên đĩa; frontend chỉ fetch & vẽ.
 *
 * PREWARM Ở ĐÂU: (1) nguồn lane chính (temp_input.mp4) kick NGAY SAU CONCAT, chạy
 * SONG SONG với ASR (ASR mất hàng chục giây -> tới lúc vào Editing peak đã sẵn);
 * (2) asset overlay kick lúc upload/import/thêm vào thư viện. Vì vậy request từ
 * frontend hầu như luôn gặp cache 200 ngay lập tức.
 *
 * CACHE: peaks_cache/<sha1(path|size|mtime|version)>.pk — nằm NGOÀI temp_uploads
 * để asset thư viện (dùng lại nhiều dự án) không bị xoá khi tạo dự án mới; key đã
 * gồm size+mtime nên tự invalidate khi file đổi và có thể cache HTTP vĩnh viễn.
 * Job chạy tối đa PEAKS_MAX_PARALLEL_JOBS để không giành CPU với ASR/export.
 * ========================================================================== */
const peaksJobs = new Map(); // cacheKey -> job state
const peaksQueue = [];
let peaksRunning = 0;

function audioPeaksCachePath(key) {
  return path.join(PEAKS_CACHE_DIR, `${key}.pk`);
}

// Đường dẫn nguồn hợp lệ (CHỐNG path traversal vì client truyền vào): chỉ nhận file
// trong temp_uploads/ hoặc library/, và chỉ đuôi đã đăng ký.
// Nhận cả đường dẫn tuyệt đối (asset.path) lẫn URL công khai (/temp_uploads, /library).
/* Tách ra từ resolveAudioSourcePath để proxy ẢNH dùng lại ĐÚNG MỘT bộ luật (thư mục hợp lệ +
 * whitelist đuôi) — chép luật ra chỗ thứ hai là sớm muộn hai bản lệch nhau, và lệch ở đây
 * nghĩa là một lỗ đọc file tuỳ ý. */
function resolveAllowedSourcePath(raw, allowedExtensions) {
  const value = String(raw || '').trim();
  if (!value) return null;
  let candidate = value;
  const urlMatch = value.match(/^\/(temp_uploads|library)\/(.*)$/);
  if (urlMatch) {
    const root = urlMatch[1] === 'library' ? LIBRARY_DIR : TEMP_DIR;
    const rel = urlMatch[2].split('?')[0].split('/').map((part) => {
      try { return decodeURIComponent(part); } catch (_) { return part; }
    });
    candidate = path.join(root, ...rel);
  }
  const resolved = path.resolve(candidate);
  // Ngoài 2 thư mục của ứng dụng, chấp nhận cả nguồn NGƯỜI DÙNG ĐÃ ĐĂNG KÝ (thư mục thêm
  // vào panel). Thiếu nhánh này thì block dựng từ asset link không có sóng âm — file nằm
  // ngoài temp_uploads nên bị chặn ngay từ đây, và lỗi im lặng ở chỗ hoàn toàn khác.
  const insideAllowedRoot = [TEMP_DIR, LIBRARY_DIR]
    .some((root) => resolved.startsWith(root + path.sep))
    || isSourceAccessAllowed(resolved);
  if (!insideAllowedRoot) return null;
  const ext = path.extname(resolved).toLowerCase();
  if (!allowedExtensions.has(ext)) return null;
  try {
    if (!fs.statSync(resolved).isFile()) return null;
  } catch (_) {
    return null;
  }
  return resolved;
}

function resolveAudioSourcePath(raw) {
  return resolveAllowedSourcePath(raw, new Set([...ALLOWED_AUDIO_EXTENSIONS, ...ALLOWED_VIDEO_EXTENSIONS]));
}

// Nguồn ẢNH raster hợp lệ — cùng cổng an toàn, khác danh sách đuôi.
function resolveImageSourcePath(raw) {
  return resolveAllowedSourcePath(raw, RASTER_IMAGE_EXTENSIONS);
}

function peaksJobPublicState(job) {
  if (!job) return null;
  return {
    key: job.key,
    status: job.status,
    error: job.error || null,
    duration_ms: job.durationMs || null,
  };
}

function pumpPeaksQueue() {
  while (peaksRunning < PEAKS_MAX_PARALLEL_JOBS && peaksQueue.length) {
    const job = peaksQueue.shift();
    peaksRunning += 1;
    job.status = 'running';
    const startedAtMs = Date.now();
    // forwardStatus:false — job nền KHÔNG được ghi đè dòng trạng thái của ASR/export.
    runSidecar(['audio-peaks', job.source, job.path], {
      forwardStatus: false,
      readsMainVideo: job.source === path.join(TEMP_DIR, 'temp_input.mp4'),
    })
      .then(() => {
        job.status = 'ready';
        job.durationMs = elapsedMs(startedAtMs);
      })
      .catch((error) => {
        job.status = 'error';
        job.durationMs = elapsedMs(startedAtMs);
        job.error = cleanInlineText(error?.message || error, 300);
        recordProjectError('audio_peaks', error, { command: 'audio-peaks', source: job.source });
      })
      .finally(() => {
        peaksRunning = Math.max(0, peaksRunning - 1);
        pumpPeaksQueue();
      });
  }
}

// Bảo đảm có file peak cho 1 nguồn. Trả state ĐỒNG BỘ (không await) để endpoint/prewarm
// không bao giờ chặn: 'ready' (đã có cache trên đĩa) | 'queued'/'running' | 'error'.
function queueAudioPeaks(rawPath) {
  const source = resolveAudioSourcePath(rawPath);
  if (!source) return null;
  let stat;
  try {
    stat = fs.statSync(source);
  } catch (_) {
    return null;
  }
  const key = sha1Text(`${source}|${stat.size}|${Math.trunc(stat.mtimeMs)}|v${PEAKS_FORMAT_VERSION}`).slice(0, 24);
  const target = audioPeaksCachePath(key);
  const existing = peaksJobs.get(key);
  const cachedOnDisk = fs.existsSync(target);
  if (existing) {
    if (existing.status === 'ready') {
      if (cachedOnDisk) return existing;
      existing.attempts = 0; // cache bị xoá ngoài luồng (prune/dọn tay) -> sinh lại, không kẹt 202
    } else if (existing.status === 'error') {
      if (existing.attempts >= PEAKS_MAX_ATTEMPTS) return existing;
    } else {
      return existing; // queued/running
    }
  } else if (cachedOnDisk) {
    const ready = { key, source, path: target, status: 'ready', error: null, attempts: 0 };
    peaksJobs.set(key, ready);
    return ready;
  }
  fs.mkdirSync(PEAKS_CACHE_DIR, { recursive: true });
  const job = existing || { key, source, path: target, attempts: 0 };
  job.status = 'queued';
  job.error = null;
  job.attempts = (job.attempts || 0) + 1;
  peaksJobs.set(key, job);
  peaksQueue.push(job);
  pumpPeaksQueue();
  return job;
}

// Prewarm nhiều asset cùng lúc (upload/import/library): bỏ qua thứ không có tiếng.
function prewarmAudioPeaksForAssets(assets) {
  for (const asset of (assets || [])) {
    if (!asset || asset.has_audio === false) continue;
    if (asset.type === 'media_image') continue;
    queueAudioPeaks(asset.path);
  }
}

// Dọn peak cũ lúc khởi động (cache dẫn xuất, mất là sinh lại được).
function prunePeaksCache() {
  try {
    if (!fs.existsSync(PEAKS_CACHE_DIR)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(PEAKS_CACHE_DIR)) {
      if (!name.endsWith('.pk') && !name.endsWith('.tmp') && !name.endsWith('.raw')) continue;
      const item = path.join(PEAKS_CACHE_DIR, name);
      const stat = fs.statSync(item);
      // .tmp/.raw = rác của job bị kill giữa đường -> xoá ngay.
      const expired = !name.endsWith('.pk') || (now - stat.mtimeMs) > PEAKS_CACHE_TTL_MS;
      if (expired) fs.rmSync(item, { force: true });
    }
  } catch (_) { /* cache dọn được thì tốt, không thì bỏ qua */ }
}

/* =============================================================================
 * PROXY LQ CHO ASSET OVERLAY — cache trên đĩa + hàng đợi job nền CÓ CỔNG
 *
 * VẤN ĐỀ: nút LQ/HQ chỉ đổi nguồn của LANE CHÍNH (`preview_proxy.mp4`). Asset overlay thì
 * preview đọc thẳng file gốc (`/api/source-file`), nên bật một b-roll 1920×1080@60fps lên
 * lane overlay là cộng thêm một bộ giải mã đầy đủ + một texture nữa mỗi khung, ngay bên
 * cạnh lane chính. Người dùng đo được: bật video overlay -> giật; tắt nó -> hết.
 *
 * CÁCH LÀM: mỗi asset video có một bản proxy LQ (cùng sidecar `preview-proxy` mà lane chính
 * dùng: cao tối đa 720, bề rộng chia hết cho 16, ALL-INTRA `-g 1` -> tua gần như miễn phí,
 * đúng thứ `syncMediaElement` cần vì nó tua overlay mỗi khi lệch > 0,22s). Proxy CHỈ dùng
 * cho PREVIEW. `asset.path` (thứ payload export đọc) KHÔNG bao giờ đổi — khác hẳn
 * `ensureSdrAsset`, nơi bản SDR cố tình thay cả path vì bản HDR gốc là SAI MÀU ở cả hai
 * khâu. Lẫn hai chuyện này là bản xuất ra 720p mà không ai yêu cầu.
 *
 * SINH TRƯỚC, KHÔNG BẮT NGƯỜI DÙNG ĐỢI: job kick ngay lúc asset vào panel "Tệp phương
 * tiện" (upload / import / link / thư viện), nên tới lúc kéo xuống timeline thì proxy
 * thường đã sẵn. Kéo xuống trước khi xong cũng không chặn gì: preview dùng bản gốc rồi tự
 * đổi sang proxy khi job xong.
 *
 * PHÂN PHỐI TẢI — ba tầng, vì một job encode chạy sai lúc còn tệ hơn không có proxy:
 *   1. MỘT job tại một thời điểm (PROXY_MAX_PARALLEL_JOBS = 1).
 *   2. Ưu tiên tiến trình BELOW_NORMAL (xem `lowPriority` trong runSidecar).
 *   3. CỔNG "ĐANG PHÁT": frontend gọi /api/background-jobs/gate khi bắt đầu phát; trong
 *      lúc đó hàng đợi KHÔNG mở job mới. Đây là tầng quan trọng nhất — proxy dùng NVENC,
 *      tức tranh chấp đúng bộ giải mã/mã hoá phần cứng mà preview đang cần, và ưu tiên CPU
 *      không che được chuyện đó. Cổng có HẠN DÙNG (ttl) do client gửi và tự hết hiệu lực:
 *      cửa sổ bị đóng giữa lúc phát cũng không kẹt hàng đợi vĩnh viễn.
 *
 * CACHE: proxy_cache/<sha1(path|size|mtime|version)>.mp4. Khoá có size+mtime nên file đổi
 * nội dung là ra khoá khác. Ghi vào `<key>.part.mp4` rồi mới `rename`: nhờ vậy "file tồn
 * tại" ĐỒNG NGHĨA "đã hoàn chỉnh", không có đường nào phát ra một mp4 bị cắt ngang của job
 * bị kill.
 * ========================================================================== */
const assetProxyJobs = new Map(); // cacheKey -> job state
const assetProxyQueue = [];
let assetProxyRunning = 0;
let assetProxyPumpTimer = null;
/* Mốc thời gian mà cổng job nền hết hiệu lực. Dùng MỐC chứ không dùng cờ boolean: cờ thì
 * cần một lời "tắt" mới mở lại được, mà lời đó có thể không bao giờ tới (đóng cửa sổ, tab
 * crash, đứt kết nối) và hàng đợi kẹt luôn. */
let backgroundJobsBusyUntil = 0;

function assetProxyCachePath(key, ext = 'mp4') {
  return path.join(PROXY_CACHE_DIR, `${key}.${ext}`);
}

/* THU NHỎ MỘT ẢNH — nền của proxy ảnh và thumbnail ảnh.
 *
 * Hộp đích là `min(iw,maxEdge)` × `min(ih,maxEdge)` chứ KHÔNG phải `maxEdge` cứng, rồi mới
 * `force_original_aspect_ratio=decrease` để giữ tỉ lệ. Viết `w=maxEdge:h=maxEdge` là ảnh
 * 800×600 bị PHÓNG TO thành 1920×1440 — `decrease` chỉ co hộp cho vừa tỉ lệ, nó không hề kẹp
 * theo kích thước nguồn. Phóng to là biến bản "tối ưu" thành phản tác dụng mà mọi con số vẫn
 * trông đẹp. Test khoá ca này.
 *
 * Chạy bằng runProcess ở NODE chứ không qua sidecar: lệnh `thumbnail` của sidecar đặt `-ss`
 * TRƯỚC `-i`, mà nguồn một khung thì không có gì để tua tới -> ffmpeg không encode được gì,
 * lại còn thoát 0 nên bên gọi tưởng thành công. */
async function scaleImageTo(source, dest, maxEdge) {
  const vf = `scale=w='min(iw,${maxEdge})':h='min(ih,${maxEdge})'`
    + ':force_original_aspect_ratio=decrease:flags=lanczos';
  /* Đích .png -> ép rgba để GIỮ kênh trong suốt (PNG bảng màu có tRNS hay WebP yuva đều về
   * một dạng chắc chắn còn alpha). Đích .jpg -> chất lượng q4 như cũ. */
  const encodeArgs = dest.toLowerCase().endsWith('.png') ? ['-pix_fmt', 'rgba'] : ['-q:v', '4'];
  await runProcess('ffmpeg', ['-v', 'error', '-y', '-i', source, '-vf', vf, ...encodeArgs, dest]);
  // ffmpeg trả 0 mà không ghi gì là ca THẬT (xem trên) — kiểm file, đừng tin mã thoát.
  const stat = fs.statSync(dest);
  if (!(stat.size > 0)) throw new Error('ảnh thu nhỏ rỗng');
}

/* Thumbnail ảnh cho panel Tệp phương tiện. Song song với createOrGetThumbnail của video,
 * cùng thư mục cache, khoá có hậu tố `_img` để không đụng khoá của video. */
async function createOrGetImageThumbnail(imagePath) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
  const thumbName = `${thumbnailCacheKey(imagePath)}_img.${imageDerivativeExt(imagePath)}`;
  const thumbPath = path.join(THUMBNAIL_DIR, thumbName);
  if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
    return `/temp_uploads/thumbnails/${thumbName}`;
  }
  try {
    await scaleImageTo(imagePath, thumbPath, IMAGE_THUMB_MAX_EDGE);
  } catch (error) {
    fs.rmSync(thumbPath, { force: true });
    recordProjectError('image_thumbnail', error, { source: imagePath });
    return '';
  }
  return `/temp_uploads/thumbnails/${thumbName}`;
}

/* THUMBNAIL CHO MỘT ASSET ẢNH — dùng chung bởi editingAssetPayload và libraryAssetPayload.
 *
 * Hai hàm đó trước đây cùng viết `thumbnailUrl = publicUrl`, tức panel hiển thị FILE GỐC.
 * Với ảnh máy ảnh 21-45 MP, mỗi thẻ ~60px bắt Chromium giải mã 102-207 ms và giữ 84-173 MB
 * RGBA; một dự án 6 ảnh ≈ 640 MB. Sức ép bộ nhớ đó khiến Chromium thu hồi cả bộ đệm media
 * nên preview rớt khung NGAY CẢ KHI ĐANG DỪNG (đo được 62,3% trong 10s, rAF tệ nhất 500 ms
 * với JS chỉ 1,7%). Số đo đầy đủ trong docs/APP_INTERNALS.md.
 *
 * Hạ kích thước phía trình duyệt KHÔNG cứu được: `createImageBitmap` kèm `resizeWidth` vẫn
 * tốn 114,8 ms so với 102,2 ms, vì JPEG phải giải mã đủ rồi mới thu nhỏ được. Bắt buộc phải
 * là FILE NHỎ SINH SẴN — đúng như video vẫn làm.
 *
 * Sinh hỏng thì lùi về file gốc: thà nặng còn hơn thẻ trống. */
async function imageThumbnailUrlFor(filePath, publicUrl, { lazyProbe = false } = {}) {
  if (!RASTER_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return publicUrl;   // .svg — vector, nhẹ, và ffmpeg không giải mã được
  }
  if (lazyProbe) return sourceThumbUrl(filePath);
  return (await createOrGetImageThumbnail(filePath)) || publicUrl;
}

function backgroundJobsPaused() {
  return Date.now() < backgroundJobsBusyUntil;
}

/* Cổng job nền. `ttlMs` do client gửi và bị kẹp lại ở đây — client nói "đang phát" thì phải
 * nhắc lại định kỳ, không được cấp một lệnh khoá vô thời hạn. */
function setBackgroundJobsBusy(busy, ttlMs) {
  if (!busy) {
    backgroundJobsBusyUntil = 0;
    pumpAssetProxyQueue();
    return { paused: false, resumes_in_ms: 0 };
  }
  const ttl = Math.max(1000, Math.min(60000, Number(ttlMs) || 15000));
  backgroundJobsBusyUntil = Date.now() + ttl;
  return { paused: true, resumes_in_ms: ttl };
}

// Nguồn VIDEO hợp lệ (dùng lại đúng danh sách trắng của sóng âm, xem resolveAudioSourcePath).
function resolveVideoSourcePath(raw) {
  const resolved = resolveAudioSourcePath(raw);
  if (!resolved) return null;
  return ALLOWED_VIDEO_EXTENSIONS.has(path.extname(resolved).toLowerCase()) ? resolved : null;
}

function assetProxyPublicState(job) {
  if (!job) return null;
  return {
    key: job.key,
    status: job.status,
    // URL chỉ có nghĩa khi đã 'ready' — trả sớm là frontend gán src vào file chưa tồn tại.
    url: job.status === 'ready' ? `/proxy_cache/${job.key}.${job.ext || 'mp4'}` : '',
    kind: job.kind || 'video',
    error: job.error || null,
    duration_ms: job.durationMs || null,
  };
}

function pumpAssetProxyQueue() {
  if (assetProxyPumpTimer) {
    clearTimeout(assetProxyPumpTimer);
    assetProxyPumpTimer = null;
  }
  if (backgroundJobsPaused()) {
    // Thử lại đúng lúc cổng hết hạn, để job không phải chờ một sự kiện nào khác đánh thức.
    const wait = Math.max(250, backgroundJobsBusyUntil - Date.now() + 50);
    assetProxyPumpTimer = setTimeout(pumpAssetProxyQueue, wait);
    return;
  }
  while (assetProxyRunning < PROXY_MAX_PARALLEL_JOBS && assetProxyQueue.length) {
    const job = assetProxyQueue.shift();
    assetProxyRunning += 1;
    job.status = 'running';
    const startedAtMs = Date.now();
    const ext = job.ext || 'mp4';
    const partPath = `${job.path.slice(0, -(ext.length + 1))}.part.${ext}`;
    /* ẢNH đi đường ffmpeg trực tiếp ở Node, VIDEO đi đường sidecar. Ảnh không cần sidecar:
     * không có encoder phần cứng nào để chọn, không có bậc dự bị nào để lùi, và lệnh
     * `thumbnail` của sidecar còn hỏng trên nguồn một khung (xem scaleImageTo).
     * forwardStatus:false — job nền KHÔNG được ghi đè dòng trạng thái của ASR/export. */
    const work = job.kind === 'image'
      ? scaleImageTo(job.source, partPath, IMAGE_PROXY_MAX_EDGE)
      : runSidecar(['preview-proxy', job.source, partPath], { forwardStatus: false, lowPriority: true });
    work
      .then(async () => {
        const stat = fs.statSync(partPath);
        if (!(stat.size > 0)) throw new Error('proxy rỗng');
        await fsp.rename(partPath, job.path);
        job.status = 'ready';
        job.durationMs = elapsedMs(startedAtMs);
      })
      .catch((error) => {
        fs.rmSync(partPath, { force: true });
        job.attempts = (job.attempts || 0) + 1;
        job.durationMs = elapsedMs(startedAtMs);
        if (job.attempts < PROXY_MAX_ATTEMPTS) {
          job.status = 'queued';
          assetProxyQueue.push(job);
          return;
        }
        job.status = 'error';
        job.error = cleanInlineText(error?.message || error, 300);
        recordProjectError('asset_proxy', error, {
          command: job.kind === 'image' ? 'image-proxy' : 'preview-proxy',
          source: job.source,
        });
      })
      .finally(() => {
        assetProxyRunning = Math.max(0, assetProxyRunning - 1);
        pumpAssetProxyQueue();
      });
  }
}

/* Bảo đảm có proxy LQ cho 1 asset video. Trả state ĐỒNG BỘ (không await) để endpoint và
 * prewarm không bao giờ chặn: 'ready' (đã có cache trên đĩa) | 'queued'/'running' | 'error'. */
function queueAssetProxy(rawPath) {
  /* Video TRƯỚC, ảnh sau — hai danh sách đuôi rời nhau nên thứ tự không đổi kết quả, nhưng
   * giữ video trước cho khớp với ca phổ biến nhất. */
  const videoSource = resolveVideoSourcePath(rawPath);
  const imageSource = videoSource ? null : resolveImageSourcePath(rawPath);
  const source = videoSource || imageSource;
  if (!source) return null;
  const kind = videoSource ? 'video' : 'image';
  const ext = kind === 'image' ? imageDerivativeExt(source) : 'mp4';
  let stat;
  try {
    stat = fs.statSync(source);
  } catch (_) {
    return null;
  }
  const key = sha1Text(`${source}|${stat.size}|${Math.trunc(stat.mtimeMs)}|v${PROXY_FORMAT_VERSION}`).slice(0, 24);
  const target = assetProxyCachePath(key, ext);
  const existing = assetProxyJobs.get(key);
  const cachedOnDisk = fs.existsSync(target);
  if (existing) {
    // Cache bị xoá ngoài luồng (dọn tay / prune) -> sinh lại, không kẹt ở 'ready' hay 202.
    if (existing.status === 'ready' && !cachedOnDisk) {
      existing.attempts = 0;
      existing.status = 'queued';
      assetProxyQueue.push(existing);
      pumpAssetProxyQueue();
    }
    return existing;
  }
  const job = {
    key, source, kind, ext, path: target, attempts: 0, error: null, durationMs: null,
    status: cachedOnDisk ? 'ready' : 'queued',
  };
  assetProxyJobs.set(key, job);
  if (job.status === 'ready') return job;
  fs.mkdirSync(PROXY_CACHE_DIR, { recursive: true });
  assetProxyQueue.push(job);
  pumpAssetProxyQueue();
  return job;
}

/* Prewarm nhiều asset cùng lúc (upload/import/link/thư viện). VIDEO VÀ ẢNH RASTER, không
 * chỉ video: ảnh máy ảnh 21-45 MP là nguồn giật nặng nhất đã đo được, và bỏ ảnh ra khỏi
 * đây là proxy ảnh chỉ được dựng khi người dùng kéo block xuống timeline — tức đúng lúc
 * họ đang chờ xem, thay vì đã có sẵn từ lúc nhập. Lọc thật sự nằm ở queueAssetProxy
 * (audio, .svg, đuôi lạ đều trả null), nên ở đây chỉ cần loại `audio` cho đỡ một vòng.
 *
 * CÓ TRẦN, và trần này là cố ý. `/api/editing-assets/link` nhận CẢ CÂY THƯ MỤC — hàng
 * trăm file b-roll là chuyện thường (chính vì thế nó còn bỏ qua ffprobe, xem `lazyProbe`).
 * Xếp hàng vài trăm lượt encode là biến "chạy ngầm cho đỡ chờ" thành nhiều giờ máy nóng
 * và vài GB proxy cho những clip người dùng còn chưa xem — đúng thứ phải tránh.
 *
 * Vượt trần thì KHÔNG mất gì: kéo block xuống timeline là `ensureAssetProbed` gọi
 * `ensureAssetProxy` và job được xếp ngay lúc đó. Trần chỉ làm yếu lời hứa "không phải
 * chờ một giây nào" ở những thư mục rất lớn, chứ không làm hỏng tính năng. */
const PROXY_PREWARM_MAX_PER_BATCH = 24;

function prewarmAssetProxiesForAssets(assets) {
  let queued = 0;
  for (const asset of (assets || [])) {
    if (queued >= PROXY_PREWARM_MAX_PER_BATCH) break;
    if (!asset || asset.type === 'audio') continue;
    const job = queueAssetProxy(asset.source_path || asset.path);
    // Cache hit KHÔNG tính vào trần: nó không tốn gì cả. Tính vào là lần nhập thứ hai của
    // cùng một thư mục lại "hết ngân sách" trước khi tới file thật sự cần dựng.
    if (job && job.status !== 'ready') queued += 1;
  }
  return queued;
}

// Dọn proxy cũ lúc khởi động (cache dẫn xuất, mất là sinh lại được).
function pruneAssetProxyCache() {
  try {
    if (!fs.existsSync(PROXY_CACHE_DIR)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(PROXY_CACHE_DIR)) {
      /* .jpg/.png CÓ MẶT Ở ĐÂY vì proxy ẢNH ghi ra .jpg (nguồn JPEG) hoặc .png (nguồn có thể
       * trong suốt, xem imageDerivativeExt). Bỏ sót đuôi nào là cache ảnh phình mãi mãi và rác
       * .part.* của job bị kill không ai dọn — TTL vẫn chạy đều cho video nên nhìn bên ngoài
       * mọi thứ vẫn có vẻ ổn. */
      if (!/\.(mp4|jpg|png)$/.test(name)) continue;
      const item = path.join(PROXY_CACHE_DIR, name);
      const stat = fs.statSync(item);
      // .part.* = rác của job bị kill giữa đường -> xoá ngay.
      const expired = /\.part\.(mp4|jpg|png)$/.test(name)
        || (now - stat.mtimeMs) > PROXY_CACHE_TTL_MS;
      if (expired) fs.rmSync(item, { force: true });
    }
  } catch (_) { /* cache dọn được thì tốt, không thì bỏ qua */ }
}

/* `options.onProgress(ratio)` — TIẾN ĐỘ THẬT của lượt bóc băng, 0..1 (Auto Subtitle vẽ
 * thanh từ đó). `options.onChild(child)` để người gọi giết được tiến trình khi bấm Huỷ.
 * Không truyền gì thì hàm chạy y như trước — mọi luồng cũ (Upload → Transcribe, Magic
 * Fill) không thêm một dòng stderr nào.
 *
 * HAI KÊNH, VÌ HAI NỀN TẢNG BÓC BĂNG BẰNG HAI THỨ KHÁC NHAU:
 *
 *   · WINDOWS (faster-whisper) — kênh NDJSON sẵn có trên stdout, nay mang thêm khoá
 *     `ratio`. Sidecar phát nó TỪ TRONG vòng lặp generator segment, lấy
 *     `segment.end / info.duration`: đó là số của chính bộ giải mã, chính xác hơn đọc
 *     thanh tqdm và không phụ thuộc vào cách tqdm vẽ chữ.
 *
 *   · macOS (mlx_whisper) — không có kênh nào ngoài thanh tqdm trên stderr, bật bằng
 *     biến môi trường CRAB_ASR_PROGRESS=1 (core_logic.py đọc, đặt `verbose=False`).
 *     CHỈ nhận thanh có đơn vị `frames/s` — đó là thanh giải mã của Whisper. Bắt theo
 *     "NN%|" chung chung thì thanh "Fetching 4 files: 100%" của huggingface_hub (kiểm
 *     tra model trong cache, xong tức thì) khớp NGAY dòng đầu và đẩy tiến trình lên
 *     100% TRƯỚC KHI bóc băng bắt đầu — đã đo được trên nhánh macOS.
 *     ⚠️ Nhánh này là bản Windows: đường macOS port sang cho khỏi lệch khi đồng bộ hai
 *     nhánh, NHƯNG chưa chạy thử được trên máy Mac.
 */
/* TẢI THƯ VIỆN AI Ở LẦN ĐẦU DÙNG, KHÔNG TẢI LÚC CÀI ĐẶT.
 *
 * Bước cài .exe chỉ dựng Python + FFmpeg (~200 MB). Toàn bộ thư viện AI — torch, whisper,
 * faster-whisper, ctranslate2, mediapipe, opencv, cuBLAS, cộng lại ~2,5 GB — được kéo về ở
 * lần ĐẦU TIÊN người dùng chạm vào đúng tính năng cần chúng. Lý do: dựng phim, cắt ghép,
 * xem trước và xuất video KHÔNG dùng Python một dòng nào, nên bắt người dùng chờ 2,5 GB
 * trước khi nhìn thấy ứng dụng lần đầu là bắt họ trả giá cho thứ có thể không bao giờ dùng.
 *
 * CHỈ ÁP DỤNG KHI ĐANG CHẠY BẰNG MÔI TRƯỜNG DO BỘ CÀI DỰNG. Chạy từ mã nguồn thì interpreter
 * là `.venv` của dự án, ở đó người phát triển tự `pip install` lấy — đụng vào là vừa vô ích
 * vừa nguy hiểm (manifest không tồn tại, và `installFeature()` sẽ ném vì không tìm thấy
 * python của runtime). Phép so sánh dưới đây là cách duy nhất phân biệt hai đường chạy. */
const featureInstallLocks = new Map();

function usingProvisionedRuntime() {
  try {
    const RuntimePaths = require(path.join(PROJECT_ROOT, 'scripts', 'runtime_paths.js'));
    return path.resolve(pythonCommand()) === path.resolve(RuntimePaths.runtimePython());
  } catch (_) {
    return false;
  }
}

async function ensureFeatureInstalled(featureId) {
  if (!featureId || !usingProvisionedRuntime()) return;

  const Setup = require(path.join(PROJECT_ROOT, 'scripts', 'setup_runtime.js'));
  if (Setup.featureInstalled(featureId)) return;

  /* MỘT LƯỢT CÀI MỖI NHÓM. Người dùng bấm Bóc băng hai lần liên tiếp (hoặc UI gọi song
   * song) thì hai tiến trình pip cùng ghi vào một site-packages — hỏng gói một cách ngẫu
   * nhiên và rất khó truy. Khoá theo nhóm, người đến sau chờ chung kết quả. */
  if (featureInstallLocks.has(featureId)) return featureInstallLocks.get(featureId);

  const task = (async () => {
    /* Tiến độ đi ra bằng `setStatus()` — kênh mà giao diện VỐN ĐÃ đọc (qua /api/status).
     * Nhờ vậy không phải sửa một dòng nào trong index.html: người dùng thấy "Đang tải
     * faster-whisper — 45 MB / 420 MB" ngay tại chỗ vẫn hiện thông báo tiến độ. */
    Setup.setEmitter((event) => {
      if (event?.type === 'progress' && event.message) setStatus(event.message);
    });
    try {
      await Setup.installFeature(featureId);
    } finally {
      Setup.setEmitter(null);
      featureInstallLocks.delete(featureId);
    }
  })();

  featureInstallLocks.set(featureId, task);
  return task;
}

async function runPythonSidecar(scriptPath, inputPath, outputPath, options = {}) {
  await ensureFeatureInstalled(options.feature);
  return spawnPythonSidecar(scriptPath, inputPath, outputPath, options);
}

function spawnPythonSidecar(scriptPath, inputPath, outputPath, options = {}) {
  const command = [pythonCommand(), scriptPath, inputPath, outputPath].join(' ');
  const wantProgress = typeof options.onProgress === 'function';
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand(), [scriptPath, inputPath, outputPath], {
      cwd: PROJECT_ROOT,
      env: {
        ...pythonEnv(),
        ...(wantProgress ? { CRAB_ASR_PROGRESS: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      /* Thiếu cái này thì MỖI lượt bóc băng nháy một cửa sổ console đen trước mặt người
         dùng: Windows cấp console mới cho tiến trình con của một app GUI (Electron). */
      windowsHide: true,
    });
    activeChildProcesses.add(child);
    if (typeof options.onChild === 'function') options.onChild(child);
    const stderr = [];
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const evt = parseNdjsonLine(line);
        if (wantProgress && evt && Number.isFinite(Number(evt.ratio))) {
          options.onProgress(Math.max(0, Math.min(1, Number(evt.ratio))));
        }
        if (evt?.message) setStatus(evt.message);
        else if (!evt) process.stdout.write(`[python] ${line}\n`);
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (wantProgress) {
        // tqdm ghi đè một dòng bằng \r nên một cụm chứa nhiều lần cập nhật: lấy cái CUỐI.
        const hits = [...text.matchAll(/(\d+)\/(\d+)\s*\[[^\]]*frames\/s/g)];
        if (hits.length) {
          const last = hits[hits.length - 1];
          const done = Number(last[1]);
          const total = Number(last[2]);
          if (Number.isFinite(done) && total > 0) options.onProgress(Math.max(0, Math.min(1, done / total)));
        }
      }
      stderr.push(text);
      process.stderr.write(`[asr:err] ${chunk}`);
    });
    child.on('error', (error) => {
      activeChildProcesses.delete(child);
      reject(error);
    });
    child.on('exit', async (code) => {
      activeChildProcesses.delete(child);
      try {
        const payload = JSON.parse(await fsp.readFile(outputPath, 'utf8'));
        if (code === 0 && payload.status !== 'error') resolve(payload);
        else {
          const error = new Error(payload.detail || stderr.join('').trim() || `Python sidecar exited with code ${code}`);
          error.exitCode = code;
          error.stderr = stderr.join('').trim();
          error.command = command;
          error.sidecarPayload = payload;
          reject(error);
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runPythonJson(args, timeout = 5000) {
  const result = spawnSync(pythonCommand(), args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: pythonEnv(),
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return {
      status: 'error',
      detail: result.stderr || result.stdout || `Python exited with code ${result.status}`,
    };
  }
  try {
    return JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).pop());
  } catch (error) {
    return { status: 'error', detail: error.message, stdout: result.stdout };
  }
}

async function runWindowsAsrSidecar(payload, prefix, options = {}) {
  ensureDirs();
  const inputPath = tempJsonPath(prefix);
  const outputPath = tempJsonPath(`${prefix}_output`);
  await fsp.writeFile(inputPath, JSON.stringify(jsonSafe({
    model_root: windowsAsrModelRoot(),
    ...payload,
  })), 'utf8');
  try {
    /* `probe` KHÔNG kéo theo lượt cài thư viện. Nó chạy mỗi lần giao diện mở bảng ASR chỉ
     * để hỏi "máy này chạy được model nào" — tải 420 MB vì một cú mở bảng là điều cuối cùng
     * người dùng mong đợi. Nó cũng đã có sẵn đường suy giảm êm (fallbackWindowsAsrModels-
     * Payload) khi thiếu gói, nên thiếu thư viện ở đây không làm hỏng gì.
     * Mọi hành động CHỦ ĐỘNG còn lại (cài model, bóc băng) thì có. */
    const feature = payload?.action === 'probe' ? null : 'asr';
    return await runPythonSidecar(windowsAsrSidecarPath(), inputPath, outputPath, { ...options, feature });
  } finally {
    await fsp.rm(inputPath, { force: true }).catch(() => {});
    await fsp.rm(outputPath, { force: true }).catch(() => {});
  }
}

function fallbackWindowsAsrModelsPayload(detail = '') {
  return {
    status: 'success',
    platform: process.platform,
    engine: process.platform === 'win32' ? WINDOWS_ASR_ENGINE : 'mlx_whisper',
    model_root: windowsAsrModelRoot(),
    selected_model: WINDOWS_ASR_DEFAULT_MODEL,
    detail: detail || null,
    imports: {
      faster_whisper: false,
      ctranslate2: false,
      huggingface_hub: false,
      supported_compute_types: { cpu: [], cuda: [] },
    },
    nvidia: {
      available: false,
      gpus: [],
      max_vram_mb: null,
      error: detail || 'not probed',
    },
    runtime: {
      device: 'cpu',
      compute_type: 'int8',
      batch_size: 1,
      vad_filter: true,
      vad_backend: 'silero',
      cuda_ready: false,
      vram_mb: null,
    },
    models: [...WINDOWS_ASR_MODELS.values()].map((model) => ({
      ...model,
      ready: false,
      // min_vram_mb 0 -> luôn eligible; không hard-code tên model như bản cũ
      // (bản cũ đặc cách "distil-large-v3", bỏ model đó là hỏng cả nhánh này).
      eligible: (model.min_vram_mb || 0) <= 0,
      available: false,
      reason: detail ? 'probe_failed' : 'model_not_setup',
      path: path.join(windowsAsrModelRoot(), model.id),
      runtime: {
        device: 'cpu',
        compute_type: 'int8',
        batch_size: 1,
        vad_filter: true,
        vad_backend: 'silero',
        cuda_ready: false,
        vram_mb: null,
      },
    })),
  };
}

async function collectWindowsAsrModels(selectedModel = WINDOWS_ASR_DEFAULT_MODEL) {
  if (process.platform !== 'win32') {
    const sidecarCheck = runPythonJson([windowsAsrSidecarPath(), '--check-imports']);
    return {
      status: 'success',
      platform: process.platform,
      engine: 'mlx_whisper',
      selected_model: null,
      mac_model: 'mlx-community/whisper-large-v3-turbo',
      windows_probe_available: sidecarCheck.status === 'success',
      windows_imports: sidecarCheck.status === 'success' ? sidecarCheck : null,
      models: [{
        id: 'mlx-whisper-large-v3-turbo',
        label: 'MLX Whisper Large v3 Turbo',
        ready: true,
        eligible: true,
        available: true,
        default: true,
      }],
    };
  }
  try {
    return await runWindowsAsrSidecar({
      action: 'probe',
      asr_model: normalizeWindowsAsrModel(selectedModel),
    }, 'windows_asr_probe');
  } catch (error) {
    return fallbackWindowsAsrModelsPayload(cleanInlineText(error?.message || error, 500));
  }
}

async function runMacAsr(videoPath, referenceScript, transcribeMode, asrEngine, options = {}) {
  const inputPath = path.join(TEMP_DIR, 'mac_asr_input.json');
  const outputPath = path.join(TEMP_DIR, 'mac_asr_output.json');
  await fsp.rm(outputPath, { force: true });
  await fsp.writeFile(inputPath, JSON.stringify({
    video_path: videoPath,
    audio_path: videoPath,
    reference_script: referenceScript,
    transcribe_mode: transcribeMode,
    asr_engine: normalizeAsrEngine(asrEngine),
  }), 'utf8');
  return runPythonSidecar(path.join(PROJECT_ROOT, 'asr', 'mac_mlx_sidecar.py'), inputPath, outputPath, { ...options, feature: 'asr_mac' });
}

function secondsFromWhisperTimestamp(value) {
  if (typeof value === 'number') return value / 1000;
  if (typeof value !== 'string') return 0;
  const parts = value.split(':').map((p) => Number(p.replace(',', '.')));
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  return Number(value) || 0;
}

function normalizeWhisperCppOutput(payload) {
  const transcription = Array.isArray(payload?.transcription) ? payload.transcription : [];
  const segments = transcription.map((item) => {
    const from = item?.timestamps?.from ?? item?.start ?? 0;
    const to = item?.timestamps?.to ?? item?.end ?? 0;
    return {
      start: secondsFromWhisperTimestamp(from),
      end: secondsFromWhisperTimestamp(to),
      text: String(item?.text || '').trim(),
      loudness_dBFS: 0,
      quality_decision: 'ACCEPT',
      quality_flags: [],
      words: [],
    };
  }).filter((seg) => seg.text && seg.end > seg.start);
  return {
    status: 'success',
    segments,
    has_hallucination: false,
    transcribe_mode_used: 'whisper.cpp',
    engine: 'whisper.cpp',
  };
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function jsonSafe(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = jsonSafe(nested);
    }
    return out;
  }
  return value;
}

function normalizeWordForSession(word, segStart, segEnd) {
  if (!word || typeof word !== 'object') return null;
  const text = String(word.word ?? word.text ?? '').trim();
  if (!text) return null;
  const start = finiteNumber(word.start, segStart);
  let end = finiteNumber(word.end, segEnd);
  if (end < start) end = start;
  return { word: text, start, end };
}

function normalizeSegmentForSession(seg) {
  const start = finiteNumber(seg?.start, 0);
  let end = finiteNumber(seg?.end, start);
  if (end < start) end = start;
  const words = Array.isArray(seg?.words)
    ? seg.words.map((word) => normalizeWordForSession(word, start, end)).filter(Boolean)
    : [];
  return {
    start,
    end,
    text: String(seg?.text || ''),
    words,
    loudness_dBFS: finiteNumber(seg?.loudness_dBFS, 0),
    quality_decision: seg?.quality_decision || 'ACCEPT',
    quality_flags: Array.isArray(seg?.quality_flags)
      ? seg.quality_flags.map((flag) => String(flag)).filter(Boolean)
      : [],
  };
}

function normalizeSegmentsForSession(segments) {
  return (Array.isArray(segments) ? segments : []).map(normalizeSegmentForSession);
}

async function runWindowsWhisperCpp(videoPath, transcribeMode) {
  const wavPath = path.join(TEMP_DIR, 'whisper_input.wav');
  await runSidecar(['preprocess-audio', videoPath, wavPath, transcribeMode || 'vi_smart']);
  const modelPath = process.env.WHISPER_CPP_MODEL;
  if (!modelPath) throw new Error('WHISPER_CPP_MODEL is not set.');
  const outputPath = path.join(TEMP_DIR, 'whispercpp_output.json');
  await runSidecar(['transcribe-whispercpp', wavPath, modelPath, outputPath]);
  return normalizeWhisperCppOutput(JSON.parse(await fsp.readFile(outputPath, 'utf8')));
}

async function runWindowsFasterWhisper(videoPath, referenceScript, transcribeMode, asrModel, options = {}) {
  const model = normalizeWindowsAsrModel(asrModel);
  return runWindowsAsrSidecar({
    action: 'transcribe',
    video_path: videoPath,
    audio_path: videoPath,
    reference_script: referenceScript,
    transcribe_mode: transcribeMode,
    asr_engine: WINDOWS_ASR_ENGINE,
    asr_model: model,
    /* Ngôn ngữ bóc băng. KHÔNG đặt = sidecar giữ nguyên mặc định "vi" của nó, nên bước
     * Transcribe và Magic Fill (hai nơi không truyền khoá này) chạy y như trước. Chỉ Auto
     * Subtitle truyền xuống, vì chỉ nó có menu chọn ngôn ngữ. */
    ...(options.language ? { language: options.language } : {}),
  }, 'windows_asr_transcribe', options);
}

/* `options` = { onProgress, onChild } — chỉ Auto Subtitle dùng (thanh tiến trình + nút Huỷ).
 * whisper.cpp (đường rollback của Windows) KHÔNG nối: nó chạy qua binary riêng, không đi
 * qua runPythonSidecar. Thiếu thì UI mất phần TRĂM chứ vẫn chạy và vẫn báo bằng chữ. */
async function transcribeVideo(videoPath, referenceScript, transcribeMode, asrEngine, asrModel, options = {}) {
  setStatus('Bắt đầu xử lý âm thanh... Đang khởi tạo mô hình ASR');
  if (process.platform === 'win32') {
    if (asrEngine === WINDOWS_ASR_ROLLBACK_ENGINE || windowsWhisperCppRollbackEnabled()) {
      return runWindowsWhisperCpp(videoPath, transcribeMode);
    }
    return runWindowsFasterWhisper(videoPath, referenceScript, transcribeMode, asrModel, options);
  }
  return runMacAsr(videoPath, referenceScript, transcribeMode, asrEngine, options);
}

/* =========================================================================
 * MAGIC FILL — BÓC BĂNG LẠI THEO TIMELINE ĐÃ CHỈNH SỬA
 * Nhận danh sách khoảng [start,end] (giây, theo video nguồn temp_input.mp4,
 * đúng thứ tự phát trên timeline Editing), tách + nối audio các khoảng đó
 * rồi chạy lại ASR word-level. Timestamp ASR trả về nằm trên trục audio đã
 * nối = trùng trục thời gian timeline Editing, nên Magic Fill khớp cụm bold
 * chính xác hơn dữ liệu bóc băng gốc (vốn tính trên toàn bộ video thô).
 * ======================================================================= */

function normalizeMagicFillIntervals(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const intervals = [];
  for (const item of list) {
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end - start < 0.05) continue; // khoảng quá ngắn: bỏ, tránh atrim rỗng
    intervals.push({ start: Math.max(0, start), end });
  }
  return intervals;
}

async function extractMagicFillAudio(sourceVideoPath, intervals, outputPath) {
  // atrim từng khoảng rồi concat. Filter dài (timeline nhiều clip) nên ghi ra
  // file và dùng -filter_complex_script để không vượt giới hạn độ dài đối số.
  const parts = intervals.map((iv, idx) => (
    `[0:a]atrim=start=${iv.start.toFixed(3)}:end=${iv.end.toFixed(3)},asetpts=PTS-STARTPTS[a${idx}]`
  ));
  const filter = `${parts.join(';')};${intervals.map((_, idx) => `[a${idx}]`).join('')}concat=n=${intervals.length}:v=0:a=1[out]`;
  const filterPath = path.join(TEMP_DIR, 'magic_fill_audio_filter.txt');
  await fsp.writeFile(filterPath, filter, 'utf8');
  await fsp.rm(outputPath, { force: true });
  await runProcess('ffmpeg', [
    '-y',
    '-hide_banner',
    '-v', 'error',
    '-i', sourceVideoPath,
    '-filter_complex_script', filterPath,
    '-map', '[out]',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    outputPath,
  ]);
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 0) {
    throw new Error('Không tách được audio timeline cho Magic Fill.');
  }
  return outputPath;
}

function buildMagicFillAsrCacheKey({ sourceVideoPath, intervals, referenceScript, transcribeMode, requestedEngine, asrModel, runtime }) {
  let stat = null;
  try { stat = fs.statSync(sourceVideoPath); } catch (_) { stat = null; }
  const keyPayload = {
    version: ASR_CACHE_VERSION,
    kind: 'magic_fill_range',
    platform: process.platform,
    arch: process.arch,
    engine: requestedEngine,
    asr_model: asrModel || null,
    runtime: runtime || null,
    transcribe_mode: transcribeMode || 'vi_smart',
    reference_script_sha1: sha1Text(referenceScript || ''),
    source: {
      path: sourceVideoPath,
      size_bytes: stat ? stat.size : null,
      mtime_ms: stat ? Math.trunc(stat.mtimeMs) : null,
    },
    // làm tròn ms để so khớp cache ổn định trước sai số float của timeline
    intervals: intervals.map((iv) => [Math.round(iv.start * 1000), Math.round(iv.end * 1000)]),
  };
  return { key: sha1Text(JSON.stringify(keyPayload)), payload: keyPayload };
}

async function transcribeMagicFillTimeline({ sourceVideoPath, intervals, referenceScript, transcribeMode, asrEngine, asrModel }) {
  const asrRequest = await resolveAsrRequest(asrEngine, asrModel);
  const cacheInfo = buildMagicFillAsrCacheKey({
    sourceVideoPath,
    intervals,
    referenceScript,
    transcribeMode,
    requestedEngine: asrRequest.requestedEngine,
    asrModel: asrRequest.asrModel,
    runtime: asrRequest.runtime,
  });
  let asrResult = await readAsrCache(cacheInfo.key);
  const cacheHit = !!asrResult;
  if (!asrResult) {
    setStatus('Magic Fill: đang tách audio theo timeline đã chỉnh sửa...');
    const audioPath = path.join(TEMP_DIR, 'magic_fill_audio.wav');
    await extractMagicFillAudio(sourceVideoPath, intervals, audioPath);
    setStatus('Magic Fill: đang bóc băng lại audio timeline (word-level)...');
    asrResult = await transcribeVideo(audioPath, referenceScript, transcribeMode, asrRequest.requestedEngine, asrRequest.asrModel);
    try {
      await writeAsrCache(cacheInfo.key, cacheInfo.payload, asrResult);
    } catch (_) { /* cache hỏng không được chặn kết quả */ }
  } else {
    setStatus('Magic Fill: dùng lại cache bóc băng timeline...');
  }
  const segments = normalizeSegmentsForSession(asrResult.segments);
  setStatus('Magic Fill: đã có dữ liệu word-level mới.');
  return {
    segments: jsonSafe(segments),
    intervals,
    engine: asrResult.engine || asrRequest.requestedEngine,
    cache_hit: cacheHit,
  };
}

/* =========================================================================
 * AUTO SUBTITLE — BÓC BĂNG BẢN TRỘN AUDIO CỦA TIMELINE
 *
 * Khác Magic Fill ở chỗ nguồn vào là một file WAV do backend/subtitle-jobs.js vừa trộn
 * (trục = trục TIMELINE, không phải trục file nguồn), nên ở đây chỉ còn hai việc: danh
 * sách trắng đường dẫn nguồn, và cache.
 *
 * CACHE KHOÁ THEO KẾ HOẠCH TRỘN, KHÔNG THEO FILE WAV. Bản trộn là hàm thuần của kế hoạch,
 * nhưng mtime của nó luôn mới nên khoá theo (size, mtime) như mọi cache khác thì KHÔNG BAO
 * GIỜ trúng. Khoá theo `plan_key` (đường dẫn + mốc làm tròn ms + tốc độ + âm lượng từng
 * mảnh) thì sửa một block trên timeline là cache trượt đúng lúc nó phải trượt.
 * ======================================================================= */

/* Danh sách trắng cho nguồn audio của Auto Subtitle — cùng luật với resolveRetouchSource:
 * request đến từ renderer nên KHÔNG được nhận đường dẫn tuỳ ý.
 *
 * WINDOWS: `fs.realpathSync` chuẩn hoá luôn hoa/thường và 8.3 short name (C:\PROGRA~1),
 * nên phép so tiền tố bên dưới không bị hai cách viết CÙNG một thư mục đánh lừa. Vẫn so
 * có phân biệt hoa/thường: hai đầu đều đã qua realpath nên chúng ra CÙNG một chuỗi.
 */
function resolveSubtitleSourcePath(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let resolved;
  try { resolved = fs.realpathSync(path.resolve(text)); } catch (_) { return null; }
  const inside = (dir) => {
    const base = path.resolve(dir) + path.sep;
    return (resolved + path.sep).startsWith(base);
  };
  if (inside(TEMP_DIR) || inside(LIBRARY_DIR)) return resolved;
  if (isSourceAccessAllowed(resolved)) return resolved;
  return null;
}

function buildSubtitleAsrCacheKey({ planKey, referenceScript, transcribeMode, requestedEngine, asrModel, runtime, language }) {
  const keyPayload = {
    version: ASR_CACHE_VERSION,
    kind: 'auto_subtitle_mix',
    platform: process.platform,
    arch: process.arch,
    engine: requestedEngine,
    asr_model: asrModel || null,
    runtime: runtime || null,
    transcribe_mode: transcribeMode || 'vi_smart',
    /* NGÔN NGỮ PHẢI NẰM TRONG KHOÁ CACHE. Cùng một timeline bóc băng bằng "vi" và bằng
     * "ja" ra hai kết quả hoàn toàn khác nhau; thiếu khoá này thì đổi ngôn ngữ ở menu rồi
     * bấm "Tạo lại phụ đề" sẽ TRÚNG cache của lượt trước và trả về nguyên bản tiếng cũ —
     * hỏng im lặng, trông y như model bóc sai. */
    language: language || 'vi',
    reference_script_sha1: sha1Text(referenceScript || ''),
    plan_sha1: sha1Text(String(planKey || '')),
  };
  return { key: sha1Text(JSON.stringify(keyPayload)), payload: keyPayload };
}

/* Ngôn ngữ hợp lệ cho Auto Subtitle. Whisper biết 99 thứ tiếng, danh sách này hẹp lại
 * đúng những thứ tiếng ứng dụng CÓ FONT VẼ ĐƯỢC (xem EDITING_FONTS ở editing-runtime.js).
 * Giữ ĐỒNG BỘ ba chỗ: đây, SUPPORTED_LANGUAGES ở asr/windows_faster_whisper_sidecar.py, và
 * LANGUAGES ở static/js/auto-subtitle.js. */
const SUBTITLE_LANGUAGES = new Set(['auto', 'vi', 'en', 'zh', 'ja', 'ko']);
function normalizeSubtitleLanguage(value) {
  const code = String(value || '').trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  return SUBTITLE_LANGUAGES.has(code) ? code : 'vi';
}

async function transcribeSubtitleMix(audioPath, {
  referenceScript, transcribeMode, asrEngine, asrModel, planKey, language, onProgress, onChild,
}) {
  const asrRequest = await resolveAsrRequest(asrEngine, asrModel);
  const cacheInfo = buildSubtitleAsrCacheKey({
    planKey,
    referenceScript,
    transcribeMode,
    requestedEngine: asrRequest.requestedEngine,
    asrModel: asrRequest.asrModel,
    runtime: asrRequest.runtime,
    language,
  });
  const cached = await readAsrCache(cacheInfo.key);
  if (cached) {
    setStatus('Auto Subtitle: dùng lại cache bóc băng.');
    return { ...cached, cache_hit: true };
  }
  const result = await transcribeVideo(
    audioPath, referenceScript, transcribeMode,
    asrRequest.requestedEngine, asrRequest.asrModel,
    { onProgress, onChild, language },
  );
  try { await writeAsrCache(cacheInfo.key, cacheInfo.payload, result); }
  catch (_) { /* cache hỏng không được chặn kết quả */ }
  return { ...result, cache_hit: false };
}

function formatSegmentsToText(segments) {
  return (segments || []).map((seg) => {
    const start = finiteNumber(seg.start, 0);
    const end = finiteNumber(seg.end, start);
    const loudness = finiteNumber(seg.loudness_dBFS, 0);
    return `[${start.toFixed(2)} - ${end.toFixed(2)} | ${loudness.toFixed(2)} dBFS] ${String(seg.text || '').trim()}`;
  }).join('\n');
}

function cleanSegmentsForClient(segments) {
  return (segments || []).map((seg) => ({
    start: finiteNumber(seg.start, 0),
    end: finiteNumber(seg.end, finiteNumber(seg.start, 0)),
    text: String(seg.text || ''),
    loudness_dBFS: finiteNumber(seg.loudness_dBFS, 0),
    quality_decision: seg.quality_decision || 'ACCEPT',
    quality_flags: Array.isArray(seg.quality_flags) ? seg.quality_flags : [],
  }));
}

/* Take mà người dùng tự chọn ở màn rà soát: {"3": 1} = câu 3 dùng take thứ 1.
 *
 * Ghim rồi CHẠY LẠI cả pipeline chứ không sửa tay một hàng trong kết quả cũ: đổi một
 * câu sang lượt đọc khác thì thưởng liên tục kéo theo cả cụm câu quanh nó, và ranh
 * giới lẫn bảng phân đoạn phải được dựng lại cho khớp. */
function parsePinnedTakes(raw) {
  if (!raw) return {};
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch (_) { return {}; }
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    const sentence = Number.parseInt(key, 10);
    const take = Number.parseInt(value, 10);
    if (Number.isInteger(sentence) && sentence >= 0 && Number.isInteger(take) && take >= 0) {
      out[String(sentence)] = take;
    }
  }
  return out;
}

async function runPythonReferenceFilter({ referenceScript, transcriptText, sessionPath, pinnedTakes }) {
  const inputPath = path.join(TEMP_DIR, 'python_filter_input.json');
  const outputPath = path.join(TEMP_DIR, 'python_filter_output.json');
  await fsp.rm(outputPath, { force: true });
  await fsp.writeFile(inputPath, JSON.stringify(jsonSafe({
    reference_script: referenceScript,
    transcript_text: transcriptText,
    session_file: sessionPath,
    pinned_takes: pinnedTakes || {},
  })), 'utf8');
  const result = await runPythonSidecar(path.join(PROJECT_ROOT, 'asr', 'python_filter_sidecar.py'), inputPath, outputPath, { feature: 'script' });
  const { status: _status, ...payload } = result;
  return payload;
}

/* MỘT bộ so khớp duy nhất: core_logic.py, chạy qua sidecar Python.
 *
 * Từng có nhánh MATCHING_ENGINE=cpp gọi sang bản cài đặt song song trong addon C++.
 * Bản đó dừng ở 2026-05 còn bản Python đi tiếp rất xa, nên biến môi trường ấy âm thầm
 * đổi hẳn thuật toán chọn take sang một bản đã được chứng minh là sai (37,5% so với
 * 100% trên dự án có đọc lại cả kịch bản). Đã gỡ ở Phase 7 — xem docs/APP_INTERNALS.md. */
async function runMatchingPipeline({ referenceScript, transcriptText, sessionPath, pinnedTakes }) {
  return runPythonReferenceFilter({ referenceScript, transcriptText, sessionPath, pinnedTakes });
}

/* Chuẩn hoá block do renderer gửi lên cho tính năng "Sắp xếp theo kịch bản".
 *
 * CHỈ nhận KHOẢNG THỜI GIAN. Trước đây nhận cả text + sub_segments của renderer, và đó là
 * một trong hai lỗi làm bản đầu sai hoàn toàn: ở step3, `item.text` bị nhân 2-3 lần (xem
 * _build_mapped_chunks trong core_logic.py) và `sub_segments` thì rỗng (đo trên dự án thật:
 * 0/27 mục có). Nay backend tự lấy mốc từng từ từ bản bóc băng cả video, nên renderer không
 * còn đường nào bơm dữ liệu hỏng vào bộ so khớp. */
function normalizeReorderBlocks(raw) {
  if (!Array.isArray(raw)) throw new Error('Danh sách block sắp xếp không hợp lệ.');
  return raw.map((item, position) => {
    const start = finiteNumber(item?.start, NaN);
    const end = finiteNumber(item?.end, NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`Block #${position + 1} thiếu start/end hợp lệ.`);
    }
    return {
      index: Number.isInteger(item?.index) ? item.index : position,
      start: Math.max(0, start),
      end,
    };
  });
}

/* ---------------------------------------------------------------------------
 * MỐC TỪNG TỪ CHO TÍNH NĂNG "SẮP XẾP TIMELINE THEO KỊCH BẢN"
 *
 * BÀI HỌC ĐẮT NHẤT của tính năng này: KHÔNG bóc băng lại audio đã NỐI các khoảng rời.
 * Bản đầu làm vậy (dùng lại /api/magic-fill/transcribe-range) và đo trên dự án thật:
 *   - nối 10 khoảng thành 64,78s audio -> ASR chỉ ra 157 từ, trong đó ~60 từ là ẢO GIÁC
 *     ("Hãy subscribe cho kênh Ghiền Mì Gõ Để không bỏ lỡ những video hấp dẫn"), và trọn
 *     7,1 giây đầu bị bỏ trắng.
 *   - cùng dự án, lấy mốc từ bản bóc băng CẢ VIDEO rồi cắt theo khoảng -> 243 từ, thật hết.
 * Kết quả so khớp: 7/17 câu (audio nối) so với 17/17 câu (cả video).
 * Nguyên nhân: mối ghép giữa hai khoảng rời là điểm gián đoạn giả, VAD chia cụm thoại sai
 * ở đó rồi Whisper lấp chỗ trống bằng câu mẫu quen tay. Magic Fill thoát được vì nó chạy
 * trên timeline LIỀN MẠCH của Editing và chỉ cần vị trí từ khoá gần đúng.
 *
 * Nên: nguồn mốc từ là bản bóc băng CẢ VIDEO (session_segments.json — chính bản mà bước
 * Transcribe đã ghi ra), cắt theo khoảng. Chỉ khi bản đó thiếu/không phủ nổi timeline mới
 * bóc băng lại cả video (một lần, có cache).
 * ------------------------------------------------------------------------- */

function flattenSessionWords(segments) {
  const words = [];
  for (const segment of (Array.isArray(segments) ? segments : [])) {
    for (const word of (Array.isArray(segment?.words) ? segment.words : [])) {
      const text = String(word?.word ?? word?.text ?? '').trim();
      const start = finiteNumber(word?.start, NaN);
      const end = finiteNumber(word?.end, NaN);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      words.push({ text, start, end, loudness_dBFS: finiteNumber(segment?.loudness_dBFS, 0) });
    }
  }
  words.sort((a, b) => a.start - b.start || a.end - b.end);
  return words;
}

/* Cắt dòng từ theo từng khoảng, lấy theo ĐIỂM GIỮA của từ — cùng luật với
 * buildSplitTimelineItems ở renderer, nếu không thì backend nói mảnh gồm từ 3..7 mà
 * renderer cắt ra lại thành từ 3..8. Hàm thuần, có test riêng.
 *
 * MỘT TỪ CHỈ THUỘC MỘT BLOCK. Hai block liền kề chia đúng một mốc (block.end của cái này
 * = block.start của cái kia) — chuyện thường gặp: _build_mapped_chunks cắt chunk tại biên
 * hàng, và chính tính năng này cắt block ra nhiều mảnh. Nếu để khoảng đóng ở cả hai đầu thì
 * từ nằm đúng mốc đó bị gán vào CẢ HAI block, nhân đôi trong đầu vào của bộ so khớp. Biên
 * thuộc block SỚM HƠN, khớp luật `midpoint <= splitTime -> nửa trái` của
 * buildSplitTimelineItems. Dung sai chỉ để bù sai số float, không phải để nới khoảng. */
function sliceWordsByBlocks(words, blocks) {
  const list = Array.isArray(words) ? words : [];
  const targets = (Array.isArray(blocks) ? blocks : []).map((block) => ({ block, picked: [] }));
  // Xét theo thứ tự THỜI GIAN, không theo thứ tự mảng: latestTimeline có thể đã bị sắp lại
  // ở lượt trước nên thứ tự mảng không còn là thứ tự thời gian.
  const byTime = targets.slice().sort((a, b) => a.block.start - b.block.start
    || a.block.end - b.block.end);
  for (const word of list) {
    const midpoint = (word.start + word.end) / 2;
    const owner = byTime.find((target) => midpoint >= target.block.start - 0.01
      && midpoint <= target.block.end + 0.01);
    if (owner) owner.picked.push(word);
  }
  return targets.map(({ block, picked }) => ({
    index: block.index,
    start: block.start,
    end: block.end,
    text: picked.map((word) => word.text).join(' '),
    loudness_dBFS: picked.length ? picked[0].loudness_dBFS : 0,
    sub_segments: picked.map((word) => ({
      text: word.text, start: word.start, end: word.end, loudness_dBFS: word.loudness_dBFS,
    })),
  }));
}

/* Bản bóc băng có dùng được cho timeline này không? Tiêu chí cố ý thô: mỗi block phải có
 * ít nhất một từ. Block trên timeline sinh ra từ lời nói đã khớp kịch bản, nên block
 * KHÔNG có từ nào nghĩa là dòng từ này thuộc video khác (mở lại dự án từ .crab, hoặc đã
 * ingest lại nguồn) — lúc đó bóc băng lại còn đúng hơn là so khớp trên dữ liệu lạc. */
function sessionWordsCoverBlocks(words, blocks) {
  if (!words.length || !blocks.length) return false;
  const sliced = sliceWordsByBlocks(words, blocks);
  const covered = sliced.filter((block) => block.sub_segments.length > 0).length;
  return covered === blocks.length;
}

function buildTimelineWordsCacheKey({ sourceVideoPath, referenceScript, transcribeMode, requestedEngine, asrModel, runtime }) {
  let stat = null;
  try { stat = fs.statSync(sourceVideoPath); } catch (_) { stat = null; }
  const keyPayload = {
    version: ASR_CACHE_VERSION,
    kind: 'timeline_words_full',
    platform: process.platform,
    arch: process.arch,
    engine: requestedEngine,
    asr_model: asrModel || null,
    runtime: runtime || null,
    transcribe_mode: transcribeMode || 'vi_smart',
    reference_script_sha1: sha1Text(referenceScript || ''),
    source: {
      path: sourceVideoPath,
      size_bytes: stat ? stat.size : null,
      mtime_ms: stat ? Math.trunc(stat.mtimeMs) : null,
    },
  };
  return { key: sha1Text(JSON.stringify(keyPayload)), payload: keyPayload };
}

/* Lấy dòng từ cho các block của timeline. Trả về {blocks, source, wordCount}. */
async function resolveTimelineWords({ blocks, referenceScript, transcribeMode, asrEngine, asrModel }) {
  const sessionPath = path.join(TEMP_DIR, 'session_segments.json');
  let sessionWords = [];
  if (fs.existsSync(sessionPath)) {
    try {
      sessionWords = flattenSessionWords(JSON.parse(await fsp.readFile(sessionPath, 'utf8')));
    } catch (_) {
      sessionWords = [];
    }
  }
  if (sessionWordsCoverBlocks(sessionWords, blocks)) {
    setStatus('Dùng lại mốc từng từ của bản bóc băng hiện có.');
    return { blocks: sliceWordsByBlocks(sessionWords, blocks), source: 'session', wordCount: sessionWords.length };
  }

  const sourceVideoPath = path.join(TEMP_DIR, 'temp_input.mp4');
  if (!fs.existsSync(sourceVideoPath)) {
    throw new Error('Không có mốc từng từ cho timeline này và cũng không tìm thấy video nguồn.'
      + ' Hãy chạy lại bước Bóc băng (hoặc mở lại dự án rồi ingest nguồn) trước khi sắp xếp.');
  }
  const asrRequest = await resolveAsrRequest(asrEngine, asrModel);
  const cacheInfo = buildTimelineWordsCacheKey({
    sourceVideoPath,
    referenceScript,
    transcribeMode,
    requestedEngine: asrRequest.requestedEngine,
    asrModel: asrRequest.asrModel,
    runtime: asrRequest.runtime,
  });
  let asrResult = await readAsrCache(cacheInfo.key);
  if (asrResult) {
    setStatus('Dùng lại cache bóc băng cả video để lấy mốc từng từ.');
  } else {
    setStatus('Đang bóc băng lại CẢ video để lấy mốc từng từ chính xác...');
    // CẢ video, không phải các khoảng đã nối — xem ghi chú đầu mục.
    asrResult = await transcribeVideo(sourceVideoPath, referenceScript, transcribeMode || 'vi_smart',
      asrRequest.requestedEngine, asrRequest.asrModel);
    try {
      await writeAsrCache(cacheInfo.key, cacheInfo.payload, asrResult);
    } catch (_) { /* cache hỏng không được chặn kết quả */ }
  }
  const segments = normalizeSegmentsForSession(asrResult.segments);
  try {
    await fsp.writeFile(sessionPath, JSON.stringify(jsonSafe(segments)), 'utf8');
  } catch (_) { /* không ghi được session thì vẫn dùng được kết quả trong lượt này */ }
  const words = flattenSessionWords(segments);
  if (!words.length) throw new Error('Bóc băng lại không ra từ nào có mốc thời gian.');
  return { blocks: sliceWordsByBlocks(words, blocks), source: 'retranscribed', wordCount: words.length };
}

async function runScriptReorder({ referenceScript, blocks }) {
  const inputPath = path.join(TEMP_DIR, 'python_reorder_input.json');
  const outputPath = path.join(TEMP_DIR, 'python_reorder_output.json');
  await fsp.rm(outputPath, { force: true });
  await fsp.writeFile(inputPath, JSON.stringify(jsonSafe({
    reference_script: referenceScript,
    blocks,
  })), 'utf8');
  const result = await runPythonSidecar(path.join(PROJECT_ROOT, 'asr', 'python_reorder_sidecar.py'), inputPath, outputPath, { feature: 'script' });
  const { status: _status, ...payload } = result;
  return payload;
}

function normalizeAutoReframeClips(timeline) {
  if (!Array.isArray(timeline)) {
    throw new Error('Dữ liệu timeline Auto-Reframe không hợp lệ.');
  }
  return timeline.map((item, index) => {
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`Auto-Reframe clip #${index + 1} thiếu start/end hợp lệ.`);
    }
    // Renderer có thể gửi kèm index gốc trong latestTimeline (khi chỉ gửi một phần clip).
    const providedIndex = Number(item?.index);
    return {
      index: Number.isInteger(providedIndex) && providedIndex >= 0 ? providedIndex : index,
      start: Math.max(0, start),
      end,
    };
  });
}

/* Đường dẫn cache landmark Retouch.
 *
 * KHOÁ GỒM CẢ mtime + size CỦA NGUỒN: thay video mà giữ nguyên tên file là chuyện
 * thường (dự án ghi đè `temp_input.mp4` mỗi lần ingest). Chỉ băm đường dẫn thì lần sau
 * dùng lại landmark của video CŨ — mặt nạ retouch dán sai chỗ hoàn toàn.
 * Tuỳ chọn cũng vào khoá vì đổi fps/detect_width là ra dữ liệu khác.
 * ĐƯỜNG DẪN cũng vào khoá: từ khi retouch chạy được cho media overlay thì nguồn không
 * còn chỉ là `temp_input.mp4` nữa, mà hai file khác nhau hoàn toàn có thể trùng
 * size+mtime (chép từ cùng một gốc).
 */
/* Đường dẫn nguồn cho /api/retouch/track, đã KIỂM AN TOÀN.
 *
 * Trả về đường dẫn tuyệt đối, hoặc null nếu không dùng được. Không truyền gì -> lane
 * chính (`temp_input.mp4`), giữ nguyên hành vi cũ.
 *
 * BA ĐIỀU KIỆN, thiếu một là từ chối:
 *   1. Nằm TRONG thư mục tạm của dự án hoặc thư viện. Chuỗi từ request đi thẳng vào
 *      tay sidecar để mở, nên không chặn là biến endpoint này thành cách đọc file tuỳ ý.
 *      So sánh sau khi `path.resolve` nên `..` không lách được.
 *   2. Là FILE video HOẶC ảnh tĩnh có đuôi được phép. Ảnh đi đường một-khung ở sidecar
 *      (`track_retouch_still`); tiếng và mọi thứ khác vẫn bị từ chối.
 *   3. Không phải liên kết tượng trưng trỏ ra ngoài (realpath rồi kiểm lại).
 */
function isSupportedRetouchSourceFile(filePath) {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
  } catch (_) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_VIDEO_EXTENSIONS.has(ext) || RETOUCH_IMAGE_EXTENSIONS.has(ext);
}

function resolveRetouchSource(raw) {
  const fallback = path.join(TEMP_DIR, 'temp_input.mp4');
  const text = String(raw || '').trim();
  if (!text) return fallback;
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(text));
  } catch (_) {
    return null;
  }
  const inside = (dir) => {
    const base = path.resolve(dir) + path.sep;
    return (resolved + path.sep).startsWith(base);
  };
  // Ngoài 2 thư mục của ứng dụng, chấp nhận nguồn NGƯỜI DÙNG ĐÃ ĐĂNG KÝ qua panel (thư
  // mục thêm vào "Tệp phương tiện"). Vẫn là danh sách trắng, không phải mở toang.
  if (!inside(TEMP_DIR) && !inside(LIBRARY_DIR) && !isSourceAccessAllowed(resolved)) return null;
  if (!isSupportedRetouchSourceFile(resolved)) return null;
  return resolved;
}

function retouchCachePath(videoPath, clips, options) {
  let stamp = '';
  try {
    const st = fs.statSync(videoPath);
    stamp = `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch (_) { stamp = 'nostat'; }
  const key = JSON.stringify({
    v: 2,
    src: path.resolve(String(videoPath || '')),
    stamp,
    clips: clips.map((c) => [Number(c.start) || 0, Number(c.end) || 0]),
    options: {
      fps: Number(options?.fps) || 0,
      detect_width: Number(options?.detect_width) || 0,
      max_faces: Number(options?.max_faces) || 0,
      smooth_alpha: Number(options?.smooth_alpha) || 0,
    },
  });
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
  return path.join(RETOUCH_CACHE_DIR, `face_${hash}.json`);
}

async function runAutoReframeAnalysis({ videoPath, clips, mode, options }) {
  const inputPath = tempJsonPath('auto_reframe_input');
  const outputPath = tempJsonPath('auto_reframe_output');
  await fsp.rm(outputPath, { force: true });
  try {
    await fsp.writeFile(inputPath, JSON.stringify(jsonSafe({
      video_path: videoPath,
      clips,
      ...(mode ? { mode } : {}),
      ...(options ? { options } : {}),
    })), 'utf8');
    const result = await runPythonSidecar(path.join(PROJECT_ROOT, 'asr', 'auto_reframe_sidecar.py'), inputPath, outputPath, { feature: 'vision' });
    const { status: _status, ...payload } = result;
    return payload;
  } finally {
    await fsp.rm(inputPath, { force: true }).catch(() => {});
    await fsp.rm(outputPath, { force: true }).catch(() => {});
  }
}

const EXPORT_RESOLUTIONS = {
  source: { width: null, height: null, label: 'Giữ kích thước nguồn' },
  p720: { width: 1280, height: 720, label: 'HD 720p' },
  p1080: { width: 1920, height: 1080, label: 'Full HD 1080p' },
  p1440: { width: 2560, height: 1440, label: 'QHD 1440p' },
  p2160: { width: 3840, height: 2160, label: 'UHD 4K' },
  vertical_720: { width: 720, height: 1280, label: 'Vertical 720x1280' },
  vertical_1080: { width: 1080, height: 1920, label: 'Vertical 1080x1920' },
  vertical_1440: { width: 1440, height: 2560, label: 'Vertical 2K 1440x2560' },
  vertical_2160: { width: 2160, height: 3840, label: 'Vertical 4K 2160x3840' },
  square_1080: { width: 1080, height: 1080, label: 'Square 1080x1080' },
};
/* NHỊP KHUNG XUẤT ĐƯỢC PHÉP — PHẢI TRÙNG danh sách PREVIEW_FPS_CHOICES ở index.html.
 *
 * LỖI ĐÃ TRẢ GIÁ (người dùng báo 2026-09-09). Thanh điều khiển preview cho chọn 23.976 /
 * 29.97 / 59.94, nhưng cả ô <select id="exportFps"> lẫn Set này chỉ biết 24/25/30/50/60.
 * Chọn 59.94 rồi xuất: `applySequenceFps` gán '59.94' vào một <select> KHÔNG có option đó
 * -> DOM âm thầm trả `value = ''` -> `|| 'source'` -> backend rơi về `source_fps`, mà
 * `source_fps` lúc đó đã bị video thứ hai (50fps) ghi đè. File xuất ra 50 fps trong khi
 * người dùng đang thấy "59.94 fps" trên thanh điều khiển. Không một dòng lỗi nào.
 * Hai danh sách lệch nhau là lỗi im lặng -> giữ chúng bằng nhau. */
const EXPORT_FPS_VALUES = new Set(['source', '23.976', '24', '25', '29.97', '30', '50', '59.94', '60']);
const EXPORT_CODEC_VALUES = new Set(['h264', 'hevc', 'prores']);
const EXPORT_QUALITY_VALUES = new Set(['small', 'balanced', 'high']);
const EXPORT_AUDIO_VALUES = new Set(['128k', '192k', '320k']);

function evenDimension(value, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < 16 || parsed > 7680) return fallback;
  return parsed % 2 === 0 ? parsed : parsed - 1;
}

function normalizeExportSettings(body = {}) {
  let raw = {};
  if (typeof body.export_settings === 'string' && body.export_settings.trim()) {
    try {
      raw = JSON.parse(body.export_settings);
    } catch (_) {
      throw new Error('export_settings không phải JSON hợp lệ.');
    }
  } else if (body.export_settings && typeof body.export_settings === 'object') {
    raw = body.export_settings;
  }

  let resolution = String(raw.resolution || body.export_preset || 'source').trim().toLowerCase();
  if (resolution === 'web_1080p') resolution = 'p1080';
  if (resolution === 'mobile') resolution = 'p720';
  if (!EXPORT_RESOLUTIONS[resolution] && resolution !== 'custom') resolution = 'source';

  let width = null;
  let height = null;
  if (resolution === 'custom') {
    width = evenDimension(raw.custom_width ?? raw.width, null);
    height = evenDimension(raw.custom_height ?? raw.height, null);
    if (!width || !height) {
      throw new Error('Kích thước custom không hợp lệ. Width/height phải từ 16 đến 7680 và là số chẵn.');
    }
  } else {
    width = EXPORT_RESOLUTIONS[resolution].width;
    height = EXPORT_RESOLUTIONS[resolution].height;
  }

  const fps = EXPORT_FPS_VALUES.has(String(raw.fps || body.export_fps || 'source'))
    ? String(raw.fps || body.export_fps || 'source')
    : 'source';
  const codec = EXPORT_CODEC_VALUES.has(String(raw.codec || 'h264')) ? String(raw.codec || 'h264') : 'h264';
  const quality = EXPORT_QUALITY_VALUES.has(String(raw.quality || 'high')) ? String(raw.quality || 'high') : 'high';
  const audioBitrate = EXPORT_AUDIO_VALUES.has(String(raw.audio_bitrate || '192k')) ? String(raw.audio_bitrate || '192k') : '192k';

  return {
    resolution,
    width,
    height,
    fps,
    codec,
    quality,
    audio_bitrate: audioBitrate,
  };
}

function parseOptionalJsonObject(value) {
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeSequenceSettings(rawSequence, exportSettings, sourceVideoPath) {
  const sourceInfo = mediaVideoInfo(sourceVideoPath);
  const raw = parseOptionalJsonObject(rawSequence);
  const fallbackWidth = exportSettings.width || sourceInfo.width || 1920;
  const fallbackHeight = exportSettings.height || sourceInfo.height || 1080;
  const width = evenDimension(raw.width, evenDimension(fallbackWidth, 1920));
  const height = evenDimension(raw.height, evenDimension(fallbackHeight, 1080));
  const sourceWidth = evenDimension(raw.source_width, sourceInfo.width || width);
  const sourceHeight = evenDimension(raw.source_height, sourceInfo.height || height);
  /* TIMEBASE CỦA SEQUENCE ĐI KÈM PAYLOAD, KHÔNG SUY LẠI TỪ NGUỒN.
   *
   * `fps` = nhịp khung người dùng chọn trên thanh điều khiển preview ('' = để tự theo
   * nguồn). Nó KHÁC `source_fps` (nhịp của nguồn đầu tiên) và phải thắng khi hai bên lệch.
   *
   * VÌ SAO KHÔNG ĐƯỢC ĐOÁN TỪ `sourceInfo`: `sourceVideoPath` ở đây là temp_input.mp4 —
   * bản ĐÃ NỐI, mà bản nối được chuẩn hoá về MỘT nhịp khung chung (xem
   * normalizeVideoForConcat). Probe nó ra là nhịp của file trung gian, không phải timebase
   * mà người dùng đang dựng trên đó. Đó chính là đường dẫn tới lỗi "chọn 59.94 mà xuất ra
   * 50 fps": không ai gửi con số người dùng chọn, nên backend đi đoán, và đoán sai. */
  return {
    width,
    height,
    preset: cleanInlineText(raw.preset || raw.mode || 'custom', 80),
    source_width: sourceWidth,
    source_height: sourceHeight,
    source_fps: cleanInlineText(raw.source_fps || sourceInfo.fps || '', 40),
    fps: parseFpsValue(raw.fps) > 0 ? cleanInlineText(raw.fps, 40) : '',
  };
}

function normalizeClipTransform(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const numberInRange = (field, fallback, min, max) => {
    const parsed = Number(raw[field]);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  };
  return {
    position_x: numberInRange('position_x', 0, -20000, 20000),
    position_y: numberInRange('position_y', 0, -20000, 20000),
    scale: numberInRange('scale', 100, 1, 800),
    rotation: numberInRange('rotation', 0, -3600, 3600),
    opacity: numberInRange('opacity', 100, 0, 100),
    flip_x: raw.flip_x === true,
    flip_y: raw.flip_y === true,
  };
}

// ============================ LUT MÀU: file & kiểm tra ============================

// id LUT đi thẳng vào tên file và vào tham số filtergraph -> chỉ cho chữ/số/_/-
function sanitizeLutId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

// Kiểm .cube ĐỦ để chắc chắn FFmpeg lut3d đọc được: có LUT_3D_SIZE hợp lệ và đúng
// size³ dòng dữ liệu. Không kiểm ở đây thì lỗi chỉ lộ ra lúc export (mất cả buổi render).
function validateCubeText(text) {
  const lines = String(text || '').split(/\r?\n/);
  let size = 0;
  let rows = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (upper.startsWith('LUT_1D_SIZE')) return { ok: false, error: 'đây là LUT 1D, cần LUT 3D' };
    if (upper.startsWith('TITLE') || upper.startsWith('DOMAIN_')) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 3 && parts.slice(0, 3).every((p) => Number.isFinite(Number(p)))) rows += 1;
  }
  if (!Number.isFinite(size) || size < 2 || size > 129) return { ok: false, error: 'thiếu hoặc sai LUT_3D_SIZE' };
  if (rows !== size ** 3) return { ok: false, error: `cần ${size ** 3} dòng dữ liệu, có ${rows}` };
  return { ok: true, size };
}

function listColorLuts() {
  let presets = [];
  try {
    presets = JSON.parse(fs.readFileSync(path.join(LUT_DIR, 'presets.json'), 'utf8'));
  } catch (_) { presets = []; }
  const presetIds = new Set(presets.map((p) => p.id));
  const out = presets
    .filter((p) => fs.existsSync(path.join(LUT_DIR, p.file)))
    // `cat` = nhóm hiển thị ở tab LUT bên trái (soft/bright/cine/mono). Preset cũ
    // chưa có trường này thì rơi về 'cine' để không bị rớt khỏi mọi nhóm.
    .map((p) => ({ id: p.id, name: p.name, cat: p.cat || 'cine', url: `/library/luts/${p.file}`, builtin: true }));
  let files = [];
  try { files = fs.readdirSync(LUT_DIR); } catch (_) { files = []; }
  files
    .filter((f) => f.toLowerCase().endsWith('.cube'))
    .map((f) => path.basename(f, '.cube'))
    .filter((id) => !presetIds.has(id))
    .sort()
    // .cube người dùng tự nhập -> nhóm riêng "Của tôi", luôn đứng cuối danh sách.
    .forEach((id) => out.push({ id, name: id, cat: 'user', url: `/library/luts/${id}.cube`, builtin: false }));
  return out;
}

// .cube do frontend bake cho MỘT block khi export -> ghi ra file để sidecar gọi lut3d.
// Tên file = sha1 nội dung: 2 block cùng thông số dùng chung 1 file, và ghi lại lần
// export sau cũng không sinh rác mới.
function materializeColorLutCube(text) {
  const check = validateCubeText(text);
  if (!check.ok) throw new Error(`LUT bake không hợp lệ: ${check.error}`);
  fs.mkdirSync(COLOR_LUT_BAKE_DIR, { recursive: true });
  fs.mkdirSync(COLOR_MASK_DIR, { recursive: true });
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
  const filePath = path.join(COLOR_LUT_BAKE_DIR, `bake_${hash}.cube`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, text);
  return filePath;
}

// Thông số Điều chỉnh màu từ frontend -> field phẳng adj_* cho sidecar.
//
// PHẲNG chứ KHÔNG lồng object: bộ đọc JSON của sidecar C++ tìm khoá bằng cách quét
// chuỗi trong phạm vi object, nên một object con tên "basic" chứa khoá "start" sẽ
// làm hỏng việc đọc start/end của interval. Tiền tố adj_ cũng tránh đụng tên sẵn có.
//
// `filters` là MẢNG CHUỖI filter do ColorAdjust.ffmpegFilters() sinh ở frontend (cùng
// module với shader preview) — backend chỉ whitelist ký tự rồi chuyển tiếp.
//
// Phần lut3d KHÔNG do frontend sinh: frontend chỉ gửi NỘI DUNG .cube đã bake — nó không
// biết đường dẫn trên máy chủ, và cũng không nên được quyền chỉ định file nào cho
// FFmpeg mở. Backend ghi file rồi tự nối `lut3d=file=...` vào cuối chuỗi.
/* LỚP ĐIỀU CHỈNH (adjustment layer) -> `adj_layer_filters`.
 *
 * VÌ SAO LÀ FIELD RIÊNG chứ không nối thẳng vào `adj_filters`: khi block có MẶT NẠ,
 * sidecar bọc `adj_filters` trong nhánh split/alphamerge của mặt nạ. Nối chuỗi của
 * lớp vào đó là lớp bị mặt nạ CỦA BLOCK cắt theo — sai, vì mặt nạ là của block chứ
 * không phải của lớp, và preview (áp toàn khung) sẽ lệch export. Field riêng cho
 * sidecar áp nó NGOÀI nhánh mặt nạ.
 *
 * Dùng lại y nguyên bộ chuẩn hoá của chuỗi chính (whitelist ký tự, ghép lut3d vào
 * chỗ trống) rồi chỉ đổi TÊN field — không viết lại bộ lọc ký tự lần thứ hai.
 */
/* LỚP ĐIỀU CHỈNH: cùng bộ chuẩn hoá với chuỗi màu của block, rồi ĐỔI TÊN mọi trường sang
 * `adj_layer_*` để sidecar dựng chuỗi thứ hai riêng (ColorAdjustChain với tag riêng).
 * Bản trước chỉ giữ `adj_filters` nên KEYFRAME của lớp mất im lặng: biểu thức `eq` (phơi
 * sáng/tương phản/bão hoà) và nhánh trộn cường độ LUT (2 cube + blend) đều bị vứt — lớp chỉ
 * có LUT với cường độ keyframe thì bản xuất không còn gì của lớp. */
function normalizeAdjustLayerFields(raw) {
  const base = normalizeColorAdjustFields(raw);
  // Mặt nạ của LỚP chưa hỗ trợ: chuỗi lớp nối ra NGOÀI nhánh mặt nạ của block. Bỏ có Ý THỨC.
  if (base.adj_mask_path) logStatus('[color-adjust] lớp Điều chỉnh: bỏ qua mặt nạ của lớp (chưa hỗ trợ).');
  const rename = {
    adj_filters: 'adj_layer_filters',
    adj_filters_post: 'adj_layer_filters_post',
    adj_eq_contrast_expr: 'adj_layer_eq_contrast_expr',
    adj_eq_brightness_expr: 'adj_layer_eq_brightness_expr',
    adj_eq_saturation_expr: 'adj_layer_eq_saturation_expr',
    adj_lut_a_path: 'adj_layer_lut_a_path',
    adj_lut_b_path: 'adj_layer_lut_b_path',
    adj_lut_mix_expr: 'adj_layer_lut_mix_expr',
  };
  const out = {};
  for (const [from, to] of Object.entries(rename)) {
    if (base[from]) out[to] = base[from];
  }
  return out;
}

function normalizeColorAdjustFields(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const filters = Array.isArray(raw.filters) ? raw.filters : [];
  // Chuỗi filter đi thẳng vào filter script -> chỉ cho tập ký tự của cú pháp filter,
  // KHÔNG có ; [ ] \ " (những ký tự có thể tách filter/label và chèn filter lạ).
  // `@` được phép: dùng để ĐẶT TÊN instance filter (`colorbalance@cb_c0`) cho `sendcmd`
  // trỏ tới. Ký tự này chỉ có nghĩa ngay sau tên filter nên không thể tách filter/label.
  const parts = filters
    .map((f) => String(f).replace(/[^0-9a-zA-Z_.,:=+\-*/() '@]/g, '').trim())
    .filter(Boolean);
  // KEYFRAME qua sendcmd: ghi file lệnh rồi nối `sendcmd` vào ĐẦU chuỗi. Phải đứng trước
  // colorbalance; đặt ở đầu là an toàn nhất vì sendcmd chỉ cho frame đi qua và phát lệnh
  // theo mốc thời gian.
  if (raw.sendcmd) {
    try {
      const cmdPath = materializeColorSendcmd(String(raw.sendcmd));
      parts.unshift(`sendcmd=f='${ColorAdjust.filterPath(cmdPath)}'`);
    } catch (error) {
      // Mất file lệnh -> keyframe đứng im ở giá trị tĩnh. Vẫn xuất được, chỉ là không
      // biến thiên; ghi log để truy được thay vì im lặng.
      logStatus(`[color-adjust] bỏ keyframe sendcmd của block: ${error.message}`);
    }
  }
  // lut3d THAY VÀO CHỖ TRỐNG `__LUT3D__` mà frontend đã đặt, KHÔNG nối vào cuối chuỗi:
  // thứ tự đúng là lut3d TRƯỚC nhóm hiệu ứng không gian (unsharp/avgblur/noise/vignette),
  // đúng như preview. Nối vào cuối là lut3d chạy SAU chúng — đo được lệch tới 88/255 khi
  // block có cả HSL/LUT lẫn hiệu ứng. Thứ tự vì thế chỉ nằm ở MỘT nơi: ColorAdjust.ffmpegFilters.
  // CƯỜNG ĐỘ LUT CÓ KEYFRAME (raw.lut_mix): không thay chỗ trống bằng một lut3d nữa mà
  // ghi 2 file .cube rồi để SIDECAR dựng đoạn graph `split -> 2×lut3d -> blend=all_expr`
  // (chỉ sidecar mới ghi được câu lệnh có nhãn). Chuỗi filter vì thế phải tách làm hai
  // nửa tại chỗ trống: nửa trước và nửa sau tầng LUT.
  let lutMix = null;
  if (raw.lut_mix && typeof raw.lut_mix === 'object') {
    const expr = sanitizeFfmpegExpr(raw.lut_mix.expr);
    if (expr) {
      try {
        lutMix = {
          a: materializeColorLutCube(String(raw.lut_mix.a || '')),
          b: materializeColorLutCube(String(raw.lut_mix.b || '')),
          expr,
        };
      } catch (error) {
        // Mất một trong hai cube -> quay về đường TĨNH (raw.cube) nếu có, chứ không dựng
        // graph nửa vời.
        logStatus(`[color-adjust] bỏ keyframe cường độ LUT của block: ${error.message}`);
        lutMix = null;
      }
    }
  }
  let lutFilter = '';
  if (raw.cube) {
    try {
      const lutPath = materializeColorLutCube(String(raw.cube));
      lutFilter = `lut3d=file='${ColorAdjust.filterPath(lutPath)}':interp=trilinear`;
    } catch (error) {
      // Thà mất riêng phần LUT còn hơn làm hỏng cả filtergraph -> vẫn giữ eq/curves.
      logStatus(`[color-adjust] bỏ qua LUT của block: ${error.message}`);
    }
  }
  // Không có chỗ trống mà vẫn có cube (payload cũ / bản frontend cũ) -> nối vào cuối như
  // trước để không mất hẳn phần LUT.
  const hasSlot = parts.some((f) => f.includes(COLOR_LUT3D_SLOT));
  if (lutFilter && !hasSlot) parts.push(lutFilter);
  // Đường 2 nhánh: tách chuỗi TẠI chỗ trống, phần sau đi vào field riêng.
  if (lutMix && hasSlot) {
    const at = parts.findIndex((f) => f.includes(COLOR_LUT3D_SLOT));
    const pre = parts.slice(0, at).join(',').slice(0, 20000);
    const post = parts.slice(at + 1).join(',').slice(0, 20000);
    const outMix = {
      adj_lut_a_path: lutMix.a,
      adj_lut_b_path: lutMix.b,
      adj_lut_mix_expr: lutMix.expr,
    };
    if (pre) outMix.adj_filters = pre;
    if (post) outMix.adj_filters_post = post;
    const eqExprMix = {};
    if (raw.eq_expr && typeof raw.eq_expr === 'object') {
      ['contrast', 'brightness', 'saturation'].forEach((k) => {
        const e = sanitizeFfmpegExpr(raw.eq_expr[k]);
        if (e) eqExprMix[`adj_eq_${k}_expr`] = e;
      });
    }
    if (raw.mask_png) {
      try {
        outMix.adj_mask_path = materializeColorMaskPng(String(raw.mask_png));
      } catch (error) {
        logStatus(`[color-adjust] bỏ chỉnh màu của block vì không ghi được mặt nạ: ${error.message}`);
        return {};
      }
    }
    return { ...eqExprMix, ...outMix };
  }
  const joined = parts.join(',');
  // Chỗ trống còn lại mà không có lut3d (bake lỗi / không có LUT) phải bị XOÁ HẲN cùng dấu
  // phẩy của nó, nếu không filtergraph có tên filter lạ và cả block hỏng.
  const safe = (lutFilter
    ? joined.split(COLOR_LUT3D_SLOT).join(lutFilter)
    : joined.replace(new RegExp(`,?${COLOR_LUT3D_SLOT},?`, 'g'), (m) => (m.startsWith(',') && m.endsWith(',') ? ',' : '')))
    .slice(0, 20000);
  // KEYFRAME thông số màu: biểu thức theo thời gian cho filter `eq` (token LOCALT, sidecar
  // tự thay bằng trục thời gian phù hợp). Whitelist bằng chính sanitizeFfmpegExpr đang
  // dùng cho keyframe transform.
  const eqExpr = {};
  if (raw.eq_expr && typeof raw.eq_expr === 'object') {
    ['contrast', 'brightness', 'saturation'].forEach((k) => {
      const e = sanitizeFfmpegExpr(raw.eq_expr[k]);
      if (e) eqExpr[`adj_eq_${k}_expr`] = e;
    });
  }
  const hasEqExpr = Object.keys(eqExpr).length > 0;
  if (!safe && !hasEqExpr) return {};
  const out = { ...eqExpr };
  if (safe) out.adj_filters = safe;
  // MẶT NẠ: ảnh XÁM do frontend bake (dataURL PNG). Ghi ra đĩa để sidecar nạp bằng
  // `movie=`. Tên = sha1 nội dung -> nhiều block cùng mặt nạ dùng chung một file, và
  // xuất lại lần sau không sinh rác mới.
  if (raw.mask_png) {
    try {
      out.adj_mask_path = materializeColorMaskPng(String(raw.mask_png));
    } catch (error) {
      // Mất mặt nạ thì chỉnh màu sẽ áp TOÀN KHUNG — khác ý người dùng, nên phải
      // bỏ luôn cả phần chỉnh màu của block đó thay vì xuất ra một hình sai.
      logStatus(`[color-adjust] bỏ chỉnh màu của block vì không ghi được mặt nạ: ${error.message}`);
      return {};
    }
  }
  return out;
}

// Nội dung file lệnh sendcmd -> file trên đĩa. Whitelist ký tự để không chèn được gì lạ
// vào (mỗi dòng chỉ gồm số, tên filter, tên tham số và dấu ; @ . -).
function materializeColorSendcmd(text) {
  // `'` và `/` là BẮT BUỘC kể từ khi có keyframe nhóm Độ sáng: lệnh của `curves` mang cả
  // chuỗi điểm điều khiển, dạng `0.5 curves@tone_c0 all '0/0 0.5/0.8 1/1';`. Vẫn KHÔNG cho
  // `[ ] \ "` và ký tự điều khiển — file này chỉ được là danh sách lệnh, không được biến
  // thành đường dẫn hay nhãn filter.
  const safe = String(text).replace(/[^0-9a-zA-Z_@.\-;\n '/]/g, '').trim();
  if (!safe) throw new Error('nội dung sendcmd rỗng sau khi lọc');
  if (safe.length > 8 * 1024 * 1024) throw new Error('file lệnh sendcmd quá lớn');
  fs.mkdirSync(COLOR_MASK_DIR, { recursive: true });
  const hash = crypto.createHash('sha1').update(safe).digest('hex').slice(0, 16);
  const filePath = path.join(COLOR_MASK_DIR, `cmd_${hash}.txt`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, `${safe}\n`);
  return filePath;
}

// dataURL PNG (ảnh xám mặt nạ) -> file trên đĩa. Trả về đường dẫn tuyệt đối.
function materializeColorMaskPng(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl).trim());
  if (!match) throw new Error('mask_png không phải dataURL PNG hợp lệ');
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > 32 * 1024 * 1024) throw new Error('mask_png rỗng hoặc quá lớn');
  fs.mkdirSync(COLOR_MASK_DIR, { recursive: true });
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
  const filePath = path.join(COLOR_MASK_DIR, `mask_${hash}.png`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
  return filePath;
}

/* MẶT NẠ CẮT HÌNH của block (tab Video) -> đường dẫn file cho sidecar.
 *
 * Dùng lại `materializeColorMaskPng` (tên = sha1 nội dung nên nhiều block cùng mặt nạ
 * chia chung một file, xuất lại không sinh rác). KHÁC mặt nạ chỉnh màu ở cách xử lý lỗi:
 * mất mặt nạ chỉnh màu thì bỏ phần chỉnh màu (block vẫn đúng hình, chỉ là chưa chỉnh);
 * mất mặt nạ CẮT HÌNH thì không có lựa chọn nào an toàn — xuất nguyên khối là sai hẳn
 * bố cục người dùng dựng. Nên NÉM LỖI để cả lần xuất dừng lại và người dùng biết.
 */
function normalizeVideoMaskFields(raw) {
  if (!raw) return {};
  try {
    return { video_mask_path: materializeColorMaskPng(String(raw)) };
  } catch (error) {
    throw new Error(`Không ghi được mặt nạ cắt hình của block: ${error.message}`);
  }
}

// Biểu thức keyframe -> FFmpeg do frontend sinh (chỉ số/hàm toán). Whitelist ký tự để
// không thể chèn ký tự phá cú pháp filtergraph (nháy, ; , [ ] : \). null nếu rỗng.
function sanitizeFfmpegExpr(value, maxLength = 8000) {
  const out = String(value ?? '').replace(/[^0-9a-zA-Z_.,+\-*/() ]/g, '').trim().slice(0, maxLength);
  return out || null;
}

/* Hoạt ảnh VIDEO (In/Out/Combo) -> anim_* cho sidecar. Đi cùng bộ lọc ký tự với keyframe
 * vì cả hai đổ thẳng vào filter script.
 * `anim_x_expr` LUÔN có khi item có hoạt ảnh (frontend gửi '0' nếu không dịch chuyển) —
 * sidecar dùng chính nó làm cờ "item này có hoạt ảnh" để bật cửa trập fade. Ba kênh
 * scale/xoay là TUỲ CHỌN: chỉ hiệu ứng thực sự phóng/xoay mới gửi, để hiệu ứng mờ/trượt
 * không phải trả giá cho filter rotate + scale=eval=frame. */
function normalizeAnimVideoExprFields(av) {
  const out = {};
  const x = sanitizeFfmpegExpr(av?.x_expr, 4000); if (x) out.anim_x_expr = x;
  const y = sanitizeFfmpegExpr(av?.y_expr, 4000); if (y) out.anim_y_expr = y;
  const sx = sanitizeFfmpegExpr(av?.scale_x_expr, 4000); if (sx) out.anim_sx_expr = sx;
  const sy = sanitizeFfmpegExpr(av?.scale_y_expr, 4000); if (sy) out.anim_sy_expr = sy;
  const r = sanitizeFfmpegExpr(av?.rot_expr, 4000); if (r) out.anim_rot_expr = r;
  return out;
}

// {x_expr,y_expr,scale_expr,rot_expr,opacity_expr,volume_expr} -> kf_* cho sidecar.
// {} nếu không có. volume_expr đi vào CHUỖI TIẾNG (filter `volume`, đơn vị gain tuyến
// tính) chứ không phải chuỗi hình — xem WriteOverlayAudioFilter ở core_process.cpp.
function normalizeKeyframeExprFields(kf) {
  if (!kf || typeof kf !== 'object') return {};
  const out = {};
  const x = sanitizeFfmpegExpr(kf.x_expr); if (x) out.kf_x_expr = x;
  const y = sanitizeFfmpegExpr(kf.y_expr); if (y) out.kf_y_expr = y;
  const s = sanitizeFfmpegExpr(kf.scale_expr); if (s) out.kf_scale_expr = s;
  const r = sanitizeFfmpegExpr(kf.rot_expr); if (r) out.kf_rot_expr = r;
  const o = sanitizeFfmpegExpr(kf.opacity_expr); if (o) out.kf_opacity_expr = o;
  const v = sanitizeFfmpegExpr(kf.volume_expr); if (v) out.kf_volume_expr = v;
  return out;
}

/* `{enabled, profile, amount}` -> chuỗi filter FFmpeg cho sidecar ('' = không khử ồn).
 * Vẫn lọc ký tự lần cuối dù chuỗi do chính backend sinh: đây là thứ đi thẳng vào filter
 * script, và một lỗi đánh máy trong bảng quy đổi không được phép biến thành filter lạ. */
function normalizeAudioDenoiseFilter(raw) {
  const filters = AudioDenoise.ffmpegFilters(raw);
  if (!filters.length) return '';
  return filters
    .map((f) => String(f).replace(/[^0-9a-zA-Z_.,:=+\-*/() ]/g, '').trim())
    .filter(Boolean)
    .join(',');
}

/* {rate, pitch_correct} -> field phẳng cho sidecar. Luôn ghi cả hai (kể cả 1.0x) để C++
 * không phải đoán mặc định. */
function normalizeSpeedFields(raw) {
  const speed = ClipSpeed.normalize(raw);
  return { speed_rate: speed.rate, speed_pitch_correct: speed.pitch_correct };
}

function normalizeAudioVolumePercent(value, fallback = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1000, parsed));
}

/* VÙNG ẢNH THẬT của một block lane chính, trong pixel KHUNG NỐI.
 *
 * Frontend gửi kèm theo từng row (`content`), lấy từ bảng đoạn mà chính backend đã trả về
 * lúc nối. Không có -> `null`, và sidecar hiểu là "cả khung là ảnh" (đúng hành vi bản trước:
 * dự án cũ, hoặc lane chính do luồng bóc băng sinh ra). */
function normalizeClipContentRect(raw) {
  const width = Number(raw?.width);
  const height = Number(raw?.height);
  if (!(width > 0) || !(height > 0)) return null;
  return {
    x: Math.max(0, Math.round(Number(raw?.x) || 0)),
    y: Math.max(0, Math.round(Number(raw?.y) || 0)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function normalizeExportIntervals(timeline, sequenceSettings = null) {
  if (!Array.isArray(timeline)) {
    throw new Error('Dữ liệu timeline không hợp lệ.');
  }
  const seqW = Number(sequenceSettings?.width) || 0;
  const seqH = Number(sequenceSettings?.height) || 0;
  return timeline.map((item, index) => {
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`Timeline item #${index + 1} thiếu start/end hợp lệ.`);
    }
    if (end <= start || (end - start) < 0.05) {
      throw new Error(`Timeline item #${index + 1} có thời lượng quá ngắn hoặc end <= start.`);
    }
    const transform = normalizeClipTransform(item?.transform);
    /* HỆ SỐ VỪA KHUNG — "scale 100% = thấy TRỌN ảnh" (theo CapCut), giống hệt preview.
     *
     * Vì sao phải là MỘT con số gửi cho sidecar chứ không nhân sẵn vào `scale`: `scale` là
     * DỮ LIỆU CỦA NGƯỜI DÙNG (hiện trên panel Thuộc tính, có thể có keyframe). Nhân sẵn vào
     * nó là ghi số dẫn xuất lên số gốc — mở lại dự án là scale đã bị đổi. Sidecar nhân hai
     * số ở khâu dựng filter, cả nhánh tĩnh lẫn nhánh keyframe/hoạt ảnh.
     *
     * Không có khổ sequence (đường gọi cũ) hoặc không có vùng ảnh -> 1.0, tức y hệt bản
     * trước: vẽ khung nối theo đúng số pixel của nó trên canvas. */
    const content = normalizeClipContentRect(item?.content);
    const fitScale = (content && seqW > 0 && seqH > 0)
      ? MainLane.fitScale(content, seqW, seqH)
      : 1;
    // Hoạt ảnh clip lane chính: biểu thức FFmpeg theo thời gian (opacity fade + dịch
    // chuyển + thu phóng + xoay). Clip render trong segment 0-based nên sidecar thay
    // LOCALT = t (start 0).
    const dur = end - start;
    const av = (item?.animation_video && typeof item.animation_video === 'object' && item.animation_video.x_expr)
      ? item.animation_video : null;
    const clampDur = (d) => Math.max(0, Math.min(dur, Number(d) || 0));
    const animFields = av ? {
      ...normalizeAnimVideoExprFields(av),
      anim_in_start: Math.max(0, Number(av.in_start) || 0),
      anim_in_dur: clampDur(av.in_dur),
      anim_out_start: Math.max(0, Number(av.out_start) || 0),
      anim_out_dur: clampDur(av.out_dur),
    } : {};
    return {
      index,
      start,
      end,
      text: cleanInlineText(item?.text || item?.matched_text || item?.script_text || '', 300),
      script_index: Number.isFinite(Number(item?.script_index)) ? Number(item.script_index) : -1,
      audio_volume: normalizeAudioVolumePercent(item?.audio_volume, normalizeAudioVolumePercent(item?.volume, 100)),
      audio_denoise_filter: normalizeAudioDenoiseFilter(item?.audio_denoise),
      ...normalizeSpeedFields(item?.speed),
      transform,
      content,
      fit_scale: fitScale,
      position_x: transform.position_x,
      position_y: transform.position_y,
      scale: transform.scale,
      rotation: transform.rotation,
      opacity: transform.opacity,
      flip_x: transform.flip_x,
      flip_y: transform.flip_y,
      ...animFields,
      ...normalizeKeyframeExprFields(item?.keyframe_expr),
      ...normalizeColorAdjustFields(item?.color_adjust),
      ...normalizeAdjustLayerFields(item?.color_adjust_layer),
      ...normalizeVideoMaskFields(item?.video_mask_png),
    };
  });
}

function timelineDurationFromIntervals(intervals) {
  // Độ dài SEQUENCE, không phải độ dài nguồn: block chạy 2x chỉ chiếm nửa chỗ trên
  // timeline. Con số này là mốc kẹp thời gian của mọi overlay, sai là overlay bị cắt.
  return (Array.isArray(intervals) ? intervals : [])
    .reduce((sum, item) => sum + ClipSpeed.sequenceDuration(
      Math.max(0, Number(item.end) - Number(item.start)), Number(item.speed_rate) || 1), 0);
}

function normalizeHexColor(value, fallback = '#ffffff') {
  const raw = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
}

function normalizeEditingFontFamily(value) {
  const raw = String(value || '').trim();
  return EDITING_FONT_FILES.has(raw) ? raw : 'Inter';
}

function editingFontFileForFamily(value) {
  const family = normalizeEditingFontFamily(value);
  const file = EDITING_FONT_FILES.get(family) || EDITING_FONT_FILES.get('Inter');
  const fontPath = path.join(EDITING_FONT_DIR, file);
  if (fs.existsSync(fontPath)) return fontPath;
  return path.join(EDITING_FONT_DIR, EDITING_FONT_FILES.get('Inter'));
}

function materializeRenderedTextPng(dataUrl, itemId, index) {
  const raw = String(dataUrl || '');
  const match = raw.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) return null;
  fs.mkdirSync(GENERATED_TEXT_ASSET_DIR, { recursive: true });
  const safeId = String(itemId || `text_${index}`)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 80) || `text_${index}`;
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
  const filePath = path.join(GENERATED_TEXT_ASSET_DIR, `${safeId}_${index}_${hash}.png`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
  return filePath;
}

// Ghi chuỗi frame PNG (base64) LIÊN TỤC của hoạt ảnh text ra thư mục
// frame_%04d.png cho ffmpeg image2. Phần tử `null` = "lặp frame trước" (đoạn hold
// tĩnh, frontend gộp lại để JSON gọn) -> dùng lại buffer trước, không giải mã lại.
// Trả null nếu dữ liệu không hợp lệ — caller sẽ rơi về overlay PNG tĩnh, không
// được làm hỏng export.
function materializeAnimationFrames(seqRender, itemId, index) {
  if (!seqRender || !Array.isArray(seqRender.frames) || seqRender.frames.length < 2) return null;
  const frames = seqRender.frames.slice(0, 3600);
  if (typeof frames[0] !== 'string') return null; // frame đầu bắt buộc có dữ liệu
  const safeId = String(itemId || `text_${index}`)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 80) || `text_${index}`;
  const buffers = [];
  const hashAll = crypto.createHash('sha1');
  let prev = null;
  for (const frame of frames) {
    if (frame === null || frame === undefined) {
      if (!prev) return null; // null không được đứng đầu chuỗi
      buffers.push(prev);
      hashAll.update(Buffer.from([0])); // đánh dấu "lặp" vào hash để phân biệt
      continue;
    }
    const match = String(frame).match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return null;
    const buffer = Buffer.from(match[2], 'base64');
    // Trần 24MB/khung: khung 1080×1920 nén PNG đo thật ~9.5MB nên trần 12MB cũ chặn oan
    // ngay ở khung sắc nét đầu/cuối vùng chuyển cảnh -> materialize trả null và cả đoạn
    // chuyển cảnh biến mất KHÔNG BÁO GÌ. Vượt trần thì phải nói ra, đừng im lặng.
    if (!buffer.length || buffer.length > 24 * 1024 * 1024) {
      console.warn(`[export] Khung hoạt ảnh quá lớn (${buffer.length} byte) ở item ${itemId} — bỏ chuỗi frame.`);
      return null;
    }
    buffers.push(buffer);
    prev = buffer;
    hashAll.update(buffer);
  }
  const hash = hashAll.digest('hex').slice(0, 12);
  const dir = path.join(GENERATED_TEXT_ASSET_DIR, `anim_${safeId}_${index}_${hash}`);
  fs.mkdirSync(dir, { recursive: true });
  buffers.forEach((buffer, k) => {
    const filePath = path.join(dir, `frame_${String(k).padStart(4, '0')}.png`);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
  });
  return { pattern: path.join(dir, 'frame_%04d.png'), frameCount: buffers.length };
}

// Chuỗi khung đến từ CÁC PHẦN FILE multipart (`seq.frame_files` = danh sách tên): chỉ cần
// ĐỔI TÊN file đã upload vào đúng thứ tự frame_%04d.<ext> — không copy, không giải mã base64.
// Đường này thay cho base64 nội tuyến ở mọi vùng chuyển cảnh (xem transitionFrameUpload).
// Trả null nếu thiếu file -> caller rơi về overlay tĩnh như mọi lỗi materialize khác.
function materializeAnimationFrameFiles(seqRender, uploadedByName, itemId, index) {
  const names = (seqRender && Array.isArray(seqRender.frame_files)) ? seqRender.frame_files : null;
  if (!names || names.length < 2 || names.length > 3600) return null;
  if (!uploadedByName || !uploadedByName.size) return null;
  const safeId = String(itemId || `text_${index}`)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 80) || `text_${index}`;
  const sources = [];
  let ext = '';
  for (const name of names) {
    const src = uploadedByName.get(String(name));
    if (!src || !fs.existsSync(src)) {
      console.warn(`[export] Thiếu khung "${name}" của item ${itemId} — bỏ chuỗi frame.`);
      return null;
    }
    const thisExt = path.extname(src).toLowerCase();
    if (!ext) ext = thisExt;
    else if (thisExt !== ext) return null;   // một chuỗi phải cùng định dạng cho image2
    sources.push(src);
  }
  if (!ext) return null;
  // Thư mục theo item + index (KHÔNG hash nội dung: hash phải đọc lại toàn bộ file, mà tên
  // đã đủ định danh vì mỗi lượt export dọn sạch thư mục trước khi ghi).
  const dir = path.join(GENERATED_TEXT_ASSET_DIR, `animf_${safeId}_${index}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  sources.forEach((src, k) => {
    fs.renameSync(src, path.join(dir, `frame_${String(k).padStart(4, '0')}${ext}`));
  });
  return { pattern: path.join(dir, `frame_%04d${ext}`), frameCount: sources.length };
}

// Xoá các khung upload còn sót (chuỗi bị bỏ vì lỗi materialize) để temp không phình mãi.
function cleanupTransitionFrameUploads() {
  try {
    if (!fs.existsSync(TRANSITION_FRAME_UPLOAD_DIR)) return;
    for (const name of fs.readdirSync(TRANSITION_FRAME_UPLOAD_DIR)) {
      fs.rmSync(path.join(TRANSITION_FRAME_UPLOAD_DIR, name), { force: true });
    }
  } catch (error) {
    console.warn('[export] Không dọn được khung chuyển cảnh tạm:', error?.message || error);
  }
}

// Parse chuỗi fps ("30", "29.97", "30000/1001") -> số; 0 nếu không hợp lệ
function parseFpsValue(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  if (s.includes('/')) {
    const [num, den] = s.split('/').map(Number);
    return (Number.isFinite(num) && Number.isFinite(den) && den > 0) ? num / den : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/* NTSC PHẢI ĐI BẰNG PHÂN SỐ ĐÚNG, KHÔNG PHẢI SỐ THẬP PHÂN LÀM TRÒN.
 *
 * "59.94" không phải nhịp khung NTSC — nhịp thật là 60000/1001 = 59.94005994...  Đưa
 * `-r 59.94` cho ffmpeg là đặt timebase 5994/100, và mọi mốc thời gian sau đó chạy trên
 * một lưới LỆCH so với nguồn: sai số 1e-6 mỗi khung, tức trôi ~1 khung sau mỗi 16 phút
 * phim. Premiere/Resolve đều lưu timebase dạng phân số vì lý do này.
 *
 * Đây là chỗ DUY NHẤT quy đổi: mọi đường (render_fps của export, `-r` của bản chuẩn hoá
 * nguồn) đều đi qua đây, nên hai bên không thể chọn hai cách làm tròn khác nhau.
 * Nhịp không phải NTSC (24/25/30/50/60) giữ nguyên dạng số nguyên — ffmpeg hiểu thẳng. */
const NTSC_EXACT_RATES = new Map([
  ['23.976', '24000/1001'],
  ['23.98', '24000/1001'],
  ['29.97', '30000/1001'],
  ['47.952', '48000/1001'],
  ['59.94', '60000/1001'],
]);

function canonicalFpsText(raw, fallback = '30') {
  const s = String(raw || '').trim();
  if (!s) return fallback;
  const exact = NTSC_EXACT_RATES.get(s);
  if (exact) return exact;
  // Đã là phân số hợp lệ -> giữ nguyên (nguồn NTSC do ffprobe trả về đúng dạng này).
  if (s.includes('/')) return parseFpsValue(s) > 0 ? s : fallback;
  /* KHÔNG "kéo gần về NTSC". Bản đầu có một vòng snap theo sai số (lệch < 0.05 thì coi là
   * NTSC) và nó SAI NGAY: |24 − 23.976| = 0.024 và |30 − 29.97| = 0.03, nên 24 fps bị kéo
   * xuống 24000/1001 và 30 fps xuống 30000/1001 — tests/scripts/export_smoke.js bắt được
   * (chờ `24/1`, nhận `24000/1001`). Chỉ nhận đúng những chuỗi trong bảng trên; giá trị lạ
   * thì đi nguyên, vì đoán hộ người dùng ở đây là đổi nhịp khung mà không ai yêu cầu. */
  return parseFpsValue(s) > 0 ? s : fallback;
}

// transitionFrameFiles: Map<tên phần file, đường dẫn đã upload> của lượt export hiện tại.
function normalizeEditingPayload(rawEditing, totalDuration, renderFpsValue = 0, transitionFrameFiles = null, assetPathOverrides = null) {
  /* Đổi đường dẫn asset sang bản đã hạ SDR (nếu có). Đặt ngay đầu hàm vì `path` của asset được
   * đọc ở hai chỗ cách xa nhau — danh sách `normalizedAssets` và `overlayAssetPath` của từng
   * item — mà cả hai đều phải trỏ CÙNG một file, nếu không preview và export lệch nhau. */
  const usePath = (value) => {
    const raw = String(value || '');
    const mapped = assetPathOverrides instanceof Map ? assetPathOverrides.get(raw) : null;
    return mapped || raw;
  };
  // Snap mốc thời gian vào lưới frame của video xuất: ranh giới các đoạn
  // In/Hold/Out rơi đúng giữa 2 frame -> không còn frame nhập nhằng tại mối nối
  const snapT = (t) => (renderFpsValue > 0 ? Math.round(t * renderFpsValue) / renderFpsValue : t);
  const raw = parseOptionalJsonObject(rawEditing);
  const tracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  const items = Array.isArray(raw.items) ? raw.items : [];
  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  const assetById = new Map(assets.map((asset) => [String(asset?.id || ''), asset]));
  const trackById = new Map(tracks.map((track) => [String(track?.id || ''), track]));
  const trackOrder = (trackId) => {
    const track = trackById.get(String(trackId || ''));
    return Number.isFinite(Number(track?.order)) ? Number(track.order) : 0;
  };
  const trackVisible = (trackId) => {
    const track = trackById.get(String(trackId || ''));
    return track?.visible !== false;
  };
  const trackMuted = (trackId) => {
    const track = trackById.get(String(trackId || ''));
    return track?.muted === true;
  };
  const mainTrack = tracks.find((track) => String(track?.id || '') === 'track_main' || String(track?.type || '') === 'main') || null;
  const mainAudioVolume = Math.max(0, Math.min(1000, Number.isFinite(Number(mainTrack?.volume)) ? Number(mainTrack.volume) : 100));
  const normalizedAssets = assets.map((asset) => ({
    id: cleanInlineText(asset?.id || '', 80),
    type: cleanInlineText(asset?.type || '', 40),
    name: cleanInlineText(asset?.name || '', 255),
    path: cleanInlineText(usePath(asset?.path), 2000),
    url: cleanInlineText(asset?.url || '', 2000),
    thumbnail_url: cleanInlineText(asset?.thumbnail_url || '', 2000),
    width: finiteNumberOrNull(asset?.width),
    height: finiteNumberOrNull(asset?.height),
    duration: finiteNumberOrNull(asset?.duration),
    has_audio: asset?.has_audio === true,
  }));

  const overlays = [];
  // index của overlay phải DUY NHẤT (sidecar dùng làm nhãn filter ffmpeg [ovN]);
  // dùng bộ đếm riêng thay cho index item để chắc chắn không trùng
  let overlayIndex = 0;
  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const type = String(item.type || '').trim().toLowerCase();
    if (type === 'vector') return;
    if (!['media', 'text', 'shape', 'audio'].includes(type)) return;
    const start = Math.max(0, Number(item.timeline_start));
    const duration = Math.max(0, Number(item.duration));
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration < 0.05 || start >= totalDuration) return;
    const clampedDuration = Math.min(duration, Math.max(0.05, totalDuration - start));
    const asset = assetById.get(String(item.asset_id || '')) || null;
    if (type !== 'text' && type !== 'shape' && !asset?.path) return;
    if ((type === 'media' || type === 'text' || type === 'shape') && !trackVisible(item.track_id)) return;
    const transform = normalizeClipTransform(item.transform);
    const style = item.style && typeof item.style === 'object' ? item.style : {};
    const fontFamily = normalizeEditingFontFamily(style.font_family);
    const textImagePath = type === 'text'
      ? materializeRenderedTextPng(item.rendered_text_png, item.id, index)
      : null;
    const shapeImagePath = type === 'shape'
      ? materializeRenderedTextPng(item.rendered_shape_png, item.id, index)
      : null;
    if (type === 'shape' && !shapeImagePath) return;
    const overlayType = textImagePath || shapeImagePath ? 'media' : type;
    const overlayAssetType = textImagePath ? 'text_image' : (shapeImagePath ? 'shape_image' : cleanInlineText(asset?.type || '', 40));
    const overlayAssetPath = textImagePath || shapeImagePath || cleanInlineText(usePath(asset?.path), 2000);
    const baseOverlay = {
      id: cleanInlineText(item.id || `overlay_${index}`, 120),
      type: overlayType,
      source_type: type,
      asset_type: overlayAssetType,
      asset_path: overlayAssetPath,
      track_id: cleanInlineText(item.track_id || '', 120),
      track_order: trackOrder(item.track_id),
      timeline_start: start,
      duration: clampedDuration,
      source_start: Math.max(0, Number(item.source_start) || 0),
      muted: item.muted === true || trackMuted(item.track_id),
      volume: Math.max(0, Math.min(1000, Number.isFinite(Number(item.volume)) ? Number(item.volume) : 100)),
      audio_denoise_filter: normalizeAudioDenoiseFilter(item.audio_denoise),
      ...normalizeSpeedFields(item.speed),
      // LÀM MỀM MÉP: chỉ miếng vá Retouch đặt field này (xem AppendFeatherAlpha ở sidecar).
      feather_px: Math.max(0, Math.min(256, Math.round(Number(item.feather_px) || 0))),
      has_audio: textImagePath || shapeImagePath ? false : asset?.has_audio === true,
      text: cleanMetadataText(item.text || '', 2000),
      font_family: fontFamily,
      font_file: editingFontFileForFamily(fontFamily),
      font_size: Math.max(8, Math.min(400, Number(style.font_size) || 64)),
      color: normalizeHexColor(style.color),
      align: cleanInlineText(style.align || 'center', 20),
      transform,
      position_x: transform.position_x,
      position_y: transform.position_y,
      scale: transform.scale,
      rotation: transform.rotation,
      opacity: transform.opacity,
      flip_x: transform.flip_x,
      flip_y: transform.flip_y,
    };

    // Đối tượng có hoạt ảnh (text/shape/ẢNH): composite PER-FRAME bằng MỘT chuỗi PNG
    // LIÊN TỤC (In→Hold→Out liền mạch) -> đúng 1 overlay, không còn khe ranh giới gây
    // nháy 1 frame. Áp cho mọi loại hình ảnh (asset_type 'image_seq'); video để giai
    // đoạn sau (frontend không sinh animation_render cho video). Materialize lỗi -> rơi
    // về overlay tĩnh (text/shape PNG hoặc ảnh gốc), export không vỡ vì animation.
    let animOverlay = null;
    const animRender = ((type === 'text' || type === 'shape' || type === 'media')
      && item.animation_render && typeof item.animation_render === 'object'
      && item.animation_render.seq && typeof item.animation_render.seq === 'object')
      ? item.animation_render : null;
    if (animRender) {
      const seqFps = Math.max(10, Math.min(60, Number(animRender.fps) || 30));
      const seq = animRender.seq;
      const localStart = Math.max(0, Number(seq.start) || 0);
      const localEnd = Math.min(clampedDuration, localStart + (Number(seq.duration) || 0));
      // Snap 2 mốc vào lưới frame xuất để overlay khớp frame nền
      const absStart = snapT(start + localStart);
      const absEnd = snapT(start + localEnd);
      if (absEnd - absStart >= 0.05) {
        // Hai nguồn khung: phần file multipart (vùng chuyển cảnh — nặng) hoặc base64 nội
        // tuyến (hoạt ảnh text/shape/ảnh — nhẹ, giữ nguyên đường cũ).
        const materialized = materializeAnimationFrameFiles(seq, transitionFrameFiles, item.id, index)
          || materializeAnimationFrames(seq, item.id, index);
        if (materialized) {
          animOverlay = {
            asset_type: 'image_seq', // chuỗi ảnh chung (text/shape/ảnh)
            asset_path: materialized.pattern,
            seq_fps: seqFps,
            frame_count: materialized.frameCount,
            timeline_start: absStart,
            duration: absEnd - absStart,
          };
        }
      }
    }

    // VIDEO có hoạt ảnh: KHÔNG bake PNG -> gắn biểu thức FFmpeg (opacity fade + dịch
    // chuyển overlay x/y + thu phóng + xoay theo thời gian) vào chính overlay video.
    // Biểu thức dùng token LOCALT (thời gian cục bộ từ đầu item); sidecar thay
    // LOCALT = (t - timeline_start).
    let animVideoFields = null;
    const av = (type === 'media' && !animOverlay && item.animation_video
      && typeof item.animation_video === 'object' && item.animation_video.x_expr)
      ? item.animation_video : null;
    if (av) {
      const clampDur = (d) => Math.max(0, Math.min(clampedDuration, Number(d) || 0));
      animVideoFields = {
        ...normalizeAnimVideoExprFields(av),
        anim_in_start: Math.max(0, Number(av.in_start) || 0),
        anim_in_dur: clampDur(av.in_dur),
        anim_out_start: Math.max(0, Number(av.out_start) || 0),
        anim_out_dur: clampDur(av.out_dur),
      };
    }

    // KEYFRAME: biểu thức FFmpeg theo thời gian, áp cho MỌI loại overlay (kể cả chuỗi
    // PNG hoạt ảnh image_seq) -> sidecar áp scale/vị trí/xoay/opacity biến thiên lên trên.
    const kfFields = normalizeKeyframeExprFields(item.keyframe_expr);
    // Điều chỉnh màu: mặc định KHÔNG áp cho chuỗi khung (image_seq). Item tổng hợp của
    // chuyển cảnh đã được frontend bake sẵn màu vào từng frame PNG — áp thêm ở đây là
    // chỉnh màu HAI LẦN trên đúng đoạn chuyển cảnh.
    //
    // NGOẠI LỆ, phải khai báo rõ: `animation_render.color_source === 'raw'` nghĩa là
    // frontend cố ý gửi khung CHƯA chỉnh màu. Miếng vá Retouch dùng đường này: nó là một
    // MẢNH của khung, nên phải chịu đúng bộ lọc ffmpeg đang chạy trên phần khung quanh
    // nó — chỉnh bằng canvas ở frontend rồi ghép vào là hai đường khác nhau, và chênh
    // lệch giữa chúng hiện thành một hình chữ nhật quanh khuôn mặt.
    const adjFields = {
      ...normalizeColorAdjustFields(item.color_adjust),
      ...normalizeAdjustLayerFields(item.color_adjust_layer),
    };
    // Mặt nạ cắt hình đi RIÊNG, không nằm trong adjFields: adjFields bị bỏ qua với chuỗi
    // khung đã bake màu (`seqWantsColor`), mà mặt nạ thì không liên quan tới chuyện đó.
    const maskFields = normalizeVideoMaskFields(item.video_mask_png);
    const seqWantsColor = !!animRender && animRender.color_source === 'raw';
    if (animOverlay) {
      overlays.push({
        ...baseOverlay,
        ...animOverlay,
        ...kfFields,
        ...(seqWantsColor ? adjFields : {}),
        ...maskFields,
        index: overlayIndex++,
        id: `${baseOverlay.id}_anim`,
      });
    } else {
      overlays.push({ ...baseOverlay, ...(animVideoFields || {}), ...kfFields, ...adjFields, ...maskFields, index: overlayIndex++ });
    }
  });
  const visualTypes = new Set(['media', 'text']);
  overlays.sort((a, b) => {
    const visualA = visualTypes.has(a.type);
    const visualB = visualTypes.has(b.type);
    if (visualA && visualB) return (b.track_order - a.track_order) || (a.index - b.index);
    if (visualA !== visualB) return visualA ? -1 : 1;
    return (a.track_order - b.track_order) || (a.index - b.index);
  });
  return {
    version: overlays.some((o) => o.asset_type === 'image_seq' || o.asset_type === 'text_image_seq') ? 5 : 4,
    tracks,
    items,
    assets: normalizedAssets,
    mainAudioVolume,
    overlays,
  };
}

function exportOutputName(settings) {
  return settings.codec === 'prores' ? 'final_cut.mov' : 'final_cut.mp4';
}

async function resolveAsrRequest(asrEngine, asrModel) {
  if (process.platform !== 'win32') {
    return {
      requestedEngine: normalizeAsrEngine(asrEngine),
      asrModel: null,
      runtime: null,
    };
  }
  const requestedEngine = normalizeAsrEngine(asrEngine);
  if (requestedEngine === WINDOWS_ASR_ROLLBACK_ENGINE) {
    return {
      requestedEngine,
      asrModel: null,
      runtime: { rollback: WINDOWS_ASR_ROLLBACK_ENGINE },
    };
  }
  const model = normalizeWindowsAsrModel(asrModel);
  const status = await collectWindowsAsrModels(model);
  const selected = (status.models || []).find((item) => item.id === model);
  return {
    requestedEngine: WINDOWS_ASR_ENGINE,
    asrModel: model,
    runtime: selected?.runtime || status.runtime || null,
    modelStatus: selected || null,
  };
}

async function handleTranscribeFromSavedFiles({ savedFiles, referenceScript, scriptMetadata, transcribeMode, asrEngine, asrModel, clientStartedAtMs, resolvedSources }) {
  const serverStartedAt = Date.now();
  const clientStartedAt = parseClientStartedAtMs(clientStartedAtMs) || serverStartedAt;
  const asrRequest = await resolveAsrRequest(asrEngine, asrModel);
  const requestedEngine = asrRequest.requestedEngine;
  const scriptMetadataSummary = summarizeScriptMetadata(scriptMetadata);
  resetPreviewProxyState('idle');
  projectMetrics.activity = true;
  projectMetrics.sources = collectSourceMetrics(savedFiles);
  projectMetrics.transcribe = {
    status: 'started',
    requested_engine: requestedEngine,
    engine: null,
    asr_model: asrRequest.asrModel,
    mode: transcribeMode || 'vi_smart',
    transcribe_mode_used: 'Chưa hoàn tất',
    duration_ms: null,
    server_duration_ms: null,
    response_duration_ms: null,
    started_at: new Date(clientStartedAt).toISOString(),
    ended_at: null,
    segment_count: null,
    source_count: savedFiles.length,
    script_metadata: scriptMetadata ? jsonSafe(scriptMetadata) : null,
    _started_at_ms: clientStartedAt,
  };
  setStatus('Đang nối các file video lại với nhau...');
  const concatStartedAt = Date.now();
  const concat = await concatVideos(savedFiles);
  const concatPath = concat.path;
  const concatDurationMs = elapsedMs(concatStartedAt);
  // Sóng âm thật cho lane chính: kick NGAY, chạy SONG SONG với ASR (không await) ->
  // tới lúc người dùng vào Editing thì file .pk đã sẵn, không phải đợi.
  queueAudioPeaks(concatPath);

  const cacheInfo = buildAsrCacheKey({
    savedFiles,
    resolvedSources,
    referenceScript,
    transcribeMode,
    requestedEngine,
    asrModel: asrRequest.asrModel,
    runtime: asrRequest.runtime,
  });
  const cacheLookupStartedAt = Date.now();
  let asrResult = await readAsrCache(cacheInfo.key);
  const cacheLookupMs = elapsedMs(cacheLookupStartedAt);
  const asrCacheHit = !!asrResult;
  let cacheWriteMs = null;
  let cacheWriteError = null;
  if (asrCacheHit) {
    setStatus('Đã tìm thấy cache bóc băng, đang dùng lại kết quả ASR...');
  } else {
    asrResult = await transcribeVideo(concatPath, referenceScript, transcribeMode, requestedEngine, asrRequest.asrModel);
    const cacheWriteStartedAt = Date.now();
    try {
      await writeAsrCache(cacheInfo.key, cacheInfo.payload, asrResult);
    } catch (error) {
      cacheWriteError = cleanInlineText(error?.message || error, 500);
    }
    cacheWriteMs = elapsedMs(cacheWriteStartedAt);
  }
  const segments = normalizeSegmentsForSession(asrResult.segments);
  const asrCompletedAt = Date.now();

  const sessionPath = path.join(TEMP_DIR, 'session_segments.json');
  await fsp.writeFile(sessionPath, JSON.stringify(jsonSafe(segments)), 'utf8');

  // (2026-07-27) BỎ bước sinh 3000-peak ở đây: sóng âm timeline giờ đọc file .pk
  // (750 peak/giây) đã prewarm SONG SONG với ASR ngay sau concat -> có sớm hơn, chính
  // xác hơn, và bỏ được một lần giải mã toàn bộ audio vốn chạy SAU ASR.
  setStatus('Hoàn tất bóc băng! Đang chuẩn bị dữ liệu trả về...');
  const stat = fs.statSync(concatPath);
  const engineUsed = asrResult.engine || requestedEngine;
  const modeUsed = asrResult.transcribe_mode_used || transcribeMode || 'vi_smart';
  const transcribeModeUsed = String(modeUsed).includes(String(engineUsed))
    ? String(modeUsed)
    : `${engineUsed} / ${modeUsed}`;
  const diagnostics = {
    ...jsonSafe(asrResult.diagnostics || {}),
    concat_duration_ms: concatDurationMs,
    asr_cache_hit: asrCacheHit,
    asr_cache_key: cacheInfo.key,
    asr_cache_lookup_ms: cacheLookupMs,
    asr_cache_write_ms: cacheWriteMs,
    asr_cache_write_error: cacheWriteError,
    script_metadata: scriptMetadataSummary,
  };
  const previewProxy = queuePreviewProxy(concatPath);
  const payload = {
    status: 'success',
    segments: cleanSegmentsForClient(segments),
    raw_text: formatSegmentsToText(segments),
    has_hallucination: !!asrResult.has_hallucination,
    transcribe_mode_used: transcribeModeUsed,
    asr_engine: engineUsed,
    asr_model: asrResult.asr_model || asrRequest.asrModel,
    asr_diagnostics: diagnostics,
    video_version: Math.trunc(stat.mtimeMs),
    preview_proxy_status: previewProxy,
  };
  if (resolvedSources) {
    payload.resolved_sources = resolvedSources;
    /* BẢNG ĐOẠN của ĐÚNG file vừa nối ở trên — cùng thứ backend trả cho /project/reingest.
     *
     * VÌ SAO luồng bóc băng cũng phải trả (người dùng báo 2026-09-16): timeline của luồng
     * này do bước khớp kịch bản sinh ra từ mốc PHIÊN ÂM, mà phiên âm không biết ranh giới
     * nguồn nằm đâu — một câu thoại vắt qua chỗ nối hai video là chuyện thường. Không có
     * bảng này thì renderer không có gì để nắn chúng, và clip lệch cứ nằm im trong .crab
     * cho tới lần MỞ LẠI dự án mới bị phát hiện (lúc đó đã muộn: bản trước gọt chúng còn
     * 0,08s). Chỉ trả khi biết đường dẫn GỐC: bảng khoá theo bản chép trong temp_uploads
     * là vô nghĩa với renderer. */
    payload.concat_segments = concatSegmentTable(concat.inputs, resolvedSources.map((s) => String(s)), concatPath);
  }
  projectMetrics.transcribe = {
    status: 'success',
    requested_engine: requestedEngine,
    engine: engineUsed,
    asr_model: asrResult.asr_model || asrRequest.asrModel,
    mode: transcribeMode || 'vi_smart',
    transcribe_mode_used: transcribeModeUsed,
    duration_ms: Math.max(0, asrCompletedAt - clientStartedAt),
    server_duration_ms: Math.max(0, asrCompletedAt - serverStartedAt),
    response_duration_ms: Math.max(0, Date.now() - clientStartedAt),
    started_at: new Date(clientStartedAt).toISOString(),
    ended_at: new Date(asrCompletedAt).toISOString(),
    segment_count: segments.length,
    source_count: savedFiles.length,
    script_metadata: scriptMetadata ? jsonSafe(scriptMetadata) : null,
    diagnostics,
    preview_proxy: jsonSafe(previewProxy),
  };
  return payload;
}

function httpError(res, statusCode, detail) {
  res.status(statusCode).json({ detail: String(detail?.message || detail) });
}

/* Xoá SẠCH temp_uploads cho dự án mới.
 *
 * MỖI MỤC MỘT LẦN THỬ RIÊNG, KHÔNG ĐỂ LỖI ĐẦU TIÊN CHẶN CẢ VÒNG LẶP. Bản trước gọi
 * fs.rmSync thẳng trong vòng for: trên Windows một file đang bị giữ (Explorer đang mở
 * thư mục và dựng thumbnail, ffmpeg vừa xong chưa nhả handle, thẻ <video> còn stream
 * temp_input.mp4) ném EBUSY/EPERM và ném luôn ra khỏi vòng lặp — mọi mục CÒN LẠI không
 * được xét, ensureDirs() cũng không chạy, và /api/reset-project trả 500 mà renderer bỏ
 * qua trong catch. Kết quả người dùng thấy: tạo dự án mới xong temp_uploads vẫn nguyên
 * video của dự án trước (báo cáo 2026-09-08).
 *
 * maxRetries: rmSync tự đợi và thử lại — phần lớn khoá trên Windows là nhất thời (handle
 * vừa được nhả). Mục nào vẫn không xoá được thì TRẢ VỀ để renderer nói cho người dùng
 * biết, thay vì im lặng mang dữ liệu dự án cũ sang dự án mới. */
async function resetProject() {
  resetPreviewProxyState('idle');
  const leftovers = [];
  if (fs.existsSync(TEMP_DIR)) {
    for (const name of fs.readdirSync(TEMP_DIR)) {
      const item = path.join(TEMP_DIR, name);
      try {
        fs.rmSync(item, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
      } catch (error) {
        leftovers.push({ name, error: String(error?.code || error?.message || error) });
      }
    }
  }
  ensureDirs();
  setStatus(leftovers.length
    ? `Đã dọn dữ liệu tạm, còn ${leftovers.length} mục đang bị chương trình khác giữ.`
    : 'Đã dọn dẹp dữ liệu tạm. Sẵn sàng cho dự án mới.');
  return leftovers;
}

function createApp() {
  ensureDirs();
  const app = express();
  app.use(express.json({ limit: '100mb' }));
  app.use('/temp_uploads', express.static(TEMP_DIR));
  app.use('/static', express.static(STATIC_DIR));
  // Trang kiểm chạy tay (tests/manual/*.html) + dữ liệu mẫu. Chỉ đọc, và chỉ hữu ích
  // khi chạy backend ở máy dev — xem tests/manual/retouch_shader_parity.html.
  app.use('/tests', express.static(path.join(PROJECT_ROOT, 'tests')));
  app.use('/library', express.static(LIBRARY_DIR));
  /* Proxy LQ của asset overlay. express.static hỗ trợ sẵn Range nên <video> tua được.
   * Tên file là băm của (path|size|mtime|version) nên nội dung BẤT BIẾN theo URL -> cache
   * vĩnh viễn được; file đổi thì ra tên khác. */
  app.use('/proxy_cache', express.static(PROXY_CACHE_DIR, {
    immutable: true,
    maxAge: '365d',
  }));

  app.get('/', async (_req, res) => {
    try {
      res.type('html').send(await fsp.readFile(path.join(PROJECT_ROOT, 'index.html'), 'utf8'));
    } catch (_) {
      res.status(404).type('html').send('<h1>Không tìm thấy file index.html</h1>');
    }
  });

  /* CHỮ KÝ NHẬN DẠNG (`app`/`pid`/`port`) đi kèm `message`: đây là thứ để
   * electron/main.js phân biệt BACKEND CỦA CHÍNH MÌNH với một tiến trình lạ đang giữ
   * cổng. Chỉ xem mã HTTP là không đủ — một app Express khác, hay proxy/captive-portal
   * của công ty, đều trả 200 (hoặc 404, cũng nằm trong khoảng được coi là "sống") cho
   * mọi đường dẫn. `message` giữ nguyên cho các chỗ đọc cũ. */
  app.get('/api/status', (_req, res) => {
    /* `export_in_flight` để tiến trình main biết CÓ ĐƯỢC PHÉP khởi động lại hay không.
     * Cài bản cập nhật là thoát app; thoát giữa một lượt xuất video là mất trắng lượt đó
     * (có thể đã chạy cả chục phút) và để lại tệp ra dở dang. Xem electron/updater.js. */
    const sig = { app: 'crabbycut', pid: process.pid, port: PORT, export_in_flight: exportInFlight };
    try {
      res.json({ ...sig, message: fs.readFileSync(PROGRESS_FILE, 'utf8') });
    } catch (_) {
      res.json({ ...sig, message: 'Hệ thống đang chuẩn bị...' });
    }
  });

  app.get('/api/hardware-info', (_req, res) => {
    res.json(collectHardwareInfo());
  });

  app.get('/api/asr-models', async (req, res) => {
    try {
      res.json(await collectWindowsAsrModels(req.query?.model || WINDOWS_ASR_DEFAULT_MODEL));
    } catch (error) {
      httpError(res, 500, error);
    }
  });

  app.post('/api/asr-models/setup', async (req, res) => {
    try {
      if (process.platform !== 'win32' && !process.env.WINDOWS_ASR_MODEL_DIR) {
        return httpError(res, 400, 'Windows ASR model setup chỉ dành cho môi trường Windows.');
      }
      const model = normalizeWindowsAsrModel(req.body?.model || req.body?.asr_model || WINDOWS_ASR_DEFAULT_MODEL);
      const setupResult = await runWindowsAsrSidecar({
        action: 'setup',
        asr_model: model,
        force: !!req.body?.force,
      }, 'windows_asr_setup');
      const models = await collectWindowsAsrModels(model);
      res.json({
        ...setupResult,
        models: models.models,
        runtime: models.runtime,
      });
    } catch (error) {
      httpError(res, 500, error);
    }
  });

  app.get('/api/preview-proxy-status', (_req, res) => {
    res.json(previewProxyPublicState());
  });

  /* Sóng âm THẬT cho timeline Editing (xem khối "SÓNG ÂM THẬT" phía trên).
   * Tham số: source=main (nguồn lane chính = temp_input.mp4) HOẶC path=<asset.path>
   * HOẶC url=</temp_uploads/...|/library/...>.
   * Trả 200 = file .pk nhị phân (bất biến theo key nên cache vĩnh viễn được),
   *      202 = đang sinh (frontend poll lại, KHÔNG chặn UI), 500 = job lỗi.
   * Gọi endpoint này cũng chính là "kick" job nếu chưa có cache. */
  app.get('/api/audio-peaks', (req, res) => {
    try {
      const requested = String(req.query.source || '') === 'main'
        ? path.join(TEMP_DIR, 'temp_input.mp4')
        : (req.query.path || req.query.url || '');
      const job = queueAudioPeaks(requested);
      if (!job) return httpError(res, 404, 'Không tìm thấy nguồn âm thanh hợp lệ.');
      if (job.status === 'ready' && fs.existsSync(job.path)) {
        res.set('Content-Type', 'application/octet-stream');
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.set('X-Peaks-Key', job.key);
        return res.sendFile(job.path);
      }
      if (job.status === 'error') {
        return res.status(500).json({ status: 'error', ...peaksJobPublicState(job) });
      }
      return res.status(202).json({ status: 'pending', ...peaksJobPublicState(job) });
    } catch (error) {
      httpError(res, 500, error);
    }
  });

  /* PROXY LQ của một asset overlay (xem khối "PROXY LQ CHO ASSET OVERLAY").
   * Gọi endpoint này cũng chính là "kick" job nếu chưa có cache.
   * Luôn trả 200 kèm `status` — KHÔNG dùng 202/500 như /api/audio-peaks: bên đó thân phản
   * hồi là file nhị phân nên mã trạng thái phải gánh cả nghĩa "chưa xong", còn ở đây thân
   * phản hồi là JSON, mà một job proxy hụt là chuyện BÌNH THƯỜNG (preview vẫn chạy bằng bản
   * gốc) — trả 500 cho nó là đẩy một lỗi không đáng vào console của người dùng. */
  app.post('/api/editing-assets/proxy', (req, res) => {
    try {
      const requested = String(req.body?.path || req.body?.url || '');
      const job = queueAssetProxy(requested);
      if (!job) return res.json({ status: 'unsupported', url: '' });
      /* `status` là TRẠNG THÁI JOB ('queued'|'running'|'ready'|'error'), không phải một
       * 'success' vô nghĩa: bên gọi cần biết đã có proxy chưa, chứ không cần biết request
       * có tới được server hay không (điều đó HTTP 200 đã nói). */
      res.json({ ...assetProxyPublicState(job), paused: backgroundJobsPaused() });
    } catch (error) {
      recordProjectError('asset_proxy_request', error, { endpoint: '/api/editing-assets/proxy' });
      httpError(res, 500, error);
    }
  });

  /* CỔNG JOB NỀN. Frontend gọi `{busy:true, ttl_ms}` khi bắt đầu phát và nhắc lại định kỳ,
   * `{busy:false}` khi dừng. Trong lúc cổng đóng, hàng đợi proxy không mở job mới.
   * `ttl_ms` bị kẹp [1s, 60s] ở setBackgroundJobsBusy: client phải nhắc lại, không được cấp
   * một lệnh khoá vô thời hạn — đóng cửa sổ giữa lúc phát thì cổng tự mở lại. */
  app.post('/api/background-jobs/gate', (req, res) => {
    const state = setBackgroundJobsBusy(req.body?.busy === true, req.body?.ttl_ms);
    res.json({ status: 'success', ...state });
  });

  app.post('/api/reset-project', async (_req, res) => {
    try {
      const shouldWriteReport = hasProjectActivity() && !projectMetrics.reportWritten;
      const reportPath = shouldWriteReport ? await writeProjectReport('new_project') : projectMetrics.lastReportPath;
      const leftovers = await resetProject();
      projectMetrics.sources = null;
      projectMetrics.transcribe = null;
      projectMetrics.export = null;
      projectMetrics.errors = [];
      projectMetrics.activity = false;
      projectMetrics.reportWritten = false;
      projectMetrics.lastReportPath = null;
      /* `leftovers` KHÔNG phải lỗi: dự án mới vẫn mở được. Nhưng phải nói ra — im lặng là
       * người dùng mang nguyên video của dự án trước sang dự án mới mà không biết. */
      res.json({ status: 'success', report_path: reportPath, leftovers });
    } catch (error) {
      httpError(res, 500, error);
    }
  });

  /* Nạp lại media dẫn xuất khi mở tệp .crab: copy nguồn, concat, peaks, proxy.
   * KHÔNG chạy lại ASR — segments word-level được phục hồi từ tệp dự án.
   *
   * `preserve_order`: nối đúng thứ tự `source_paths` thay vì sắp theo tên file. Dùng cho
   * lane chính dựng tay ở Editing — xem chú thích ở collectVideosFromSourcePaths. */
  app.post('/api/project/reingest', async (req, res) => {
    try {
      ensureDirs();
      const sourcePaths = Array.isArray(req.body?.source_paths) ? req.body.source_paths : [];
      if (!sourcePaths.length) return httpError(res, 400, 'Không có nguồn video để nạp lại.');
      const sessionSegments = Array.isArray(req.body?.session_segments) ? req.body.session_segments : null;
      const preserveOrder = req.body?.preserve_order === true;
      resetPreviewProxyState('idle');
      /* Job sóng âm/proxy của lượt nạp TRƯỚC còn đang đọc temp_input.mp4 mà ta sắp ghi đè —
       * dừng trước, nếu không cả lượt nạp này chết vì EPERM trên Windows. */
      await stopMainVideoReaders();
      projectMetrics.activity = true;
      const resolvedSources = collectVideosFromSourcePaths(sourcePaths, { preserveOrder });
      /* TRÚNG BỘ NHỚ ĐỆM = mở dự án gần như tức thì: không chép, không mã hoá, không nối.
       * Khoá tính trên nguồn GỐC (đường dẫn + size + mtime) theo đúng thứ tự nối. */
      const cacheKey = concatCacheKey(resolvedSources);
      const cached = concatCacheLookup(cacheKey);
      let concatPath;
      let segments;
      if (cached) {
        setStatus('Dùng lại bản đã nối của lần trước...');
        concatPath = materializeConcatFromCache(cached.video, path.join(TEMP_DIR, 'temp_input.mp4'));
        segments = cached.segments;
      } else {
        setStatus('Đang nạp lại dự án: sao chép video nguồn...');
        const savedFiles = await copyLocalSourcesToTemp(resolvedSources);
        setStatus('Đang nối các file video lại với nhau...');
        const concat = await concatVideos(savedFiles);
        concatPath = concat.path;
        segments = concatSegmentTable(concat.inputs, resolvedSources.map((s) => String(s)), concatPath);
        concatCacheStore(cacheKey, concatPath, segments);
      }
      queueAudioPeaks(concatPath); // sóng âm thật lane chính (job nền, xem /api/audio-peaks)
      if (sessionSegments) {
        await fsp.writeFile(path.join(TEMP_DIR, 'session_segments.json'), JSON.stringify(jsonSafe(sessionSegments)), 'utf8');
      }
      const stat = fs.statSync(concatPath);
      /* Bản proxy lưu kèm dự án (tệp "<Tên dự án>.proxy.mp4" cạnh .crab). Nhận được thì bỏ
       * hẳn lượt encode — với video 16 phút 1440p đó là vài phút mỗi lần mở dự án. Nhận và
       * dựng lại đi chung MỘT lượt gọi, không tách thành endpoint riêng: tách ra thì giữa
       * hai lượt gọi có một khoảng mà queuePreviewProxy đã chạy rồi và hai đường cùng ghi
       * vào temp_uploads/preview_proxy.mp4. */
      const previewProxy = tryAdoptPreviewProxy(req.body?.preview_proxy, concatPath)
        || queuePreviewProxy(concatPath);
      const frameInfo = mediaVideoInfo(concatPath);
      setStatus('Đã nạp lại dự án. Sẵn sàng tiếp tục chỉnh sửa.');
      res.json({
        status: 'success',
        video_version: Math.trunc(stat.mtimeMs),
        preview_proxy_status: previewProxy,
        // Bảng đoạn của ĐÚNG file vừa nối — renderer dựa hẳn vào đây thay vì tự đoán.
        segments,
        /* KHỔ KHUNG NỐI — PHẢI do backend trả về, KHÔNG suy từ `video.videoWidth`.
         * Thẻ <video> có thể đang nạp bản proxy LQ (nhỏ hơn nguồn), mà mọi phép quy đổi
         * "pixel khung nối -> pixel sequence" đều chia cho con số này: lấy cỡ proxy là
         * preview LQ và HQ vẽ ra hai khung hình khác nhau. */
        concat_frame: {
          width: Number(frameInfo?.width) || 0,
          height: Number(frameInfo?.height) || 0,
        },
      });
    } catch (error) {
      setStatus('Lỗi khi nạp lại dự án!');
      recordProjectError('project_reingest', error, { endpoint: '/api/project/reingest' });
      httpError(res, 500, error);
    }
  });

  /* Quét nguồn video cho panel "Tệp phương tiện" — ĐỆ QUY, giữ cây thư mục.
   *
   * KHÔNG ffprobe và KHÔNG trích thumbnail ở đây (bản trước làm cả hai cho TỪNG video):
   * một thư mục 100 clip là 100 lần ffprobe + 100 lần gọi sidecar chạy tuần tự ngay
   * trong request — thêm thư mục xong ngồi chờ nửa phút. Nay:
   *   - thumbnail: <img loading="lazy"> trỏ /api/source-thumb, chỉ thẻ lọt tầm nhìn mới trích;
   *   - kích thước/fps: /api/media-probe, frontend hỏi cho video đang cần (mặc định Sequence). */
  app.post('/api/video-sources/scan', async (req, res) => {
    try {
      const sourcePaths = req.body?.source_paths || [];
      if (!sourcePaths.length) return httpError(res, 400, 'Không có nguồn video đầu vào.');
      for (const raw of sourcePaths) registerSourceAccess(raw);
      const entries = collectMediaTreeFromSourcePaths(sourcePaths);
      const videos = entries.map((entry) => {
        const stat = fs.statSync(entry.path);
        return {
          name: path.basename(entry.path),
          source_path: entry.path,
          group_path: entry.group_path,
          size_bytes: stat.size,
          mtime: Math.trunc(stat.mtimeMs / 1000),
          width: null,
          height: null,
          fps: '',
          fps_value: null,
          thumbnail_url: sourceThumbUrl(entry.path),
        };
      });
      res.json({ status: 'success', videos });
    } catch (error) {
      httpError(res, 500, error);
    }
  });

  /* Số đo của MỘT file (ffprobe) — tách khỏi listing để listing luôn rẻ.
   * Dùng cho: mặc định Sequence theo video đầu tiên, và asset link lúc kéo xuống timeline. */
  app.post('/api/media-probe', (req, res) => {
    try {
      const filePath = path.resolve(String(req.body?.path || ''));
      if (!isSourceAccessAllowed(filePath)) return httpError(res, 403, 'Đường dẫn chưa được đăng ký.');
      if (!isSupportedEditingAssetFile(filePath)) return httpError(res, 404, 'Không tìm thấy file phương tiện.');
      const kind = editingAssetKindForPath(filePath);
      const info = kind === 'audio' ? { width: null, height: null, fps: '', fps_value: null } : mediaVideoInfo(filePath);
      res.json({
        status: 'success',
        path: filePath,
        width: info.width,
        height: info.height,
        fps: info.fps,
        fps_value: info.fps_value,
        duration: kind === 'media_image' ? null : mediaDurationSeconds(filePath),
        has_audio: kind === 'media_image' ? false : mediaHasAudio(filePath),
      });
    } catch (error) {
      httpError(res, 500, error);
    }
  });

  /* Asset LINK (không chép, không probe lúc nạp) hỏi ở đây khi thật sự sắp được dùng — đúng
   * lúc kéo block xuống timeline. Trả về đường dẫn/URL NÊN DÙNG: bản SDR nếu nguồn là HDR,
   * còn không thì chính nguồn. File không phải HDR chỉ tốn một lần ffprobe (đã có bộ đệm),
   * nên frontend gọi cho mọi asset video được. */
  app.post('/api/editing-assets/ensure-sdr', async (req, res) => {
    try {
      const filePath = path.resolve(String(req.body?.path || ''));
      /* Asset ĐÃ CHÉP nằm trong temp_uploads và không đi qua registerSourceAccess, nên chỉ
       * kiểm sourceAccess là chặn oan chúng: dự án cũ mở lại có thể còn asset HDR đã chép từ
       * trước bản sửa này, và đó đúng là trường hợp cần hạ SDR nhất. TEMP_DIR là thư mục của
       * chính dự án đang mở nên cho qua là an toàn. */
      const relToTemp = path.relative(TEMP_DIR, filePath);
      const insideTemp = !!relToTemp && !relToTemp.startsWith('..') && !path.isAbsolute(relToTemp);
      if (!insideTemp && !isSourceAccessAllowed(filePath)) return httpError(res, 403, 'Đường dẫn chưa được đăng ký.');
      if (!isSupportedEditingAssetFile(filePath)) return httpError(res, 404, 'Không tìm thấy file phương tiện.');
      if (editingAssetKindForPath(filePath) !== 'media_video') {
        return res.json({ status: 'success', path: filePath, url: '', tonemapped: false });
      }
      const result = await ensureSdrAsset(filePath);
      res.json({
        status: 'success',
        path: result.path,
        // Bản SDR nằm trong TEMP_DIR nên phát qua /temp_uploads; nguồn gốc thì giữ URL cũ của nó.
        url: result.tonemapped ? `${publicTempUrl(result.path)}?v=${Math.trunc(fs.statSync(result.path).mtimeMs)}` : '',
        tonemapped: result.tonemapped === true,
      });
    } catch (error) {
      recordProjectError('editing_asset_ensure_sdr', error, { endpoint: '/api/editing-assets/ensure-sdr' });
      httpError(res, 500, error);
    }
  });

  // Thumbnail LƯỜI cho file nguồn ngoài thư mục dự án (cùng khuôn /api/library/thumb):
  // trích lỗi -> 404 để <img> rơi về ô giữ chỗ, KHÔNG trả ảnh rỗng (trình duyệt sẽ cache
  // "thành công" và ô giữ chỗ không bao giờ hiện).
  app.get('/api/source-thumb', async (req, res) => {
    try {
      const filePath = path.resolve(String(req.query.path || ''));
      if (!isSourceAccessAllowed(filePath)) return httpError(res, 403, 'Đường dẫn chưa được đăng ký.');
      if (!isSupportedEditingAssetFile(filePath)) return httpError(res, 404, 'Không tìm thấy file phương tiện.');
      const assetKind = editingAssetKindForPath(filePath);
      const isRasterImage = assetKind === 'media_image'
        && RASTER_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
      if (assetKind !== 'media_video' && !isRasterImage) {
        return httpError(res, 400, 'Chỉ video và ảnh raster mới trích được thumbnail.');
      }
      const url = isRasterImage
        ? await createOrGetImageThumbnail(filePath)
        : await createOrGetThumbnail(filePath);
      if (!url) return httpError(res, 404, 'Không trích được thumbnail.');
      res.redirect(302, url);
    } catch (error) {
      recordProjectError('source_thumb', error, { endpoint: '/api/source-thumb' });
      httpError(res, 500, error);
    }
  });

  // Phát file nguồn tại chỗ (không chép). res.sendFile hỗ trợ sẵn Range nên <video> tua được.
  app.get('/api/source-file', (req, res) => {
    try {
      const filePath = path.resolve(String(req.query.path || ''));
      if (!isSourceAccessAllowed(filePath)) return httpError(res, 403, 'Đường dẫn chưa được đăng ký.');
      if (!isSupportedEditingAssetFile(filePath)) return httpError(res, 404, 'Không tìm thấy file phương tiện.');
      res.sendFile(filePath);
    } catch (error) {
      httpError(res, 500, error);
    }
  });

  /* Nguồn của LANE CHÍNH (temp_input.mp4) mô tả như một asset Editing.
   * Dùng cho "Alt + kéo block lane chính lên lane overlay": bản sao overlay chạy trên
   * CHÍNH file nguồn (không chép thêm file nào) nên chỉ cần path/url/kích thước.
   * id băm từ path+size+mtime -> đổi nguồn là ra asset khác, không dùng nhầm dữ liệu cũ. */
  app.get('/api/editing-assets/main-source', async (_req, res) => {
    try {
      const filePath = path.join(TEMP_DIR, 'temp_input.mp4');
      if (!fs.existsSync(filePath)) return httpError(res, 404, 'Chưa có nguồn lane chính.');
      const asset = await editingAssetPayload(filePath, 'media');
      res.json({ status: 'success', asset: { ...asset, source: 'main' } });
    } catch (error) {
      httpError(res, 500, error);
    }
  });

  app.post('/api/editing-assets/import-local', async (req, res) => {
    try {
      ensureDirs();
      const preferredKind = cleanInlineText(req.body?.kind || '', 40);
      const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
      const usedNames = new Set();
      const assets = [];
      for (const rawPath of paths) {
        const source = path.resolve(String(rawPath || ''));
        if (!isSupportedEditingAssetFile(source)) continue;
        const name = safeAssetName(path.basename(source), usedNames);
        /* Nguồn HDR: mã hoá lại THẲNG TỪ NGUỒN, bỏ hẳn phép chép. Chép trước rồi tonemap thì
         * vừa tốn một lượt ghi cả file (nguồn iPhone 7 phút là 493 MB) vừa làm bộ đệm vô dụng
         * — khoá băm theo path+mtime của BẢN CHÉP, mà mỗi lượt nhập lại sinh mtime mới. */
        const sdr = await ensureSdrAsset(source, { label: name });
        if (sdr.tonemapped) {
          assets.push({ ...(await editingAssetPayload(sdr.path, preferredKind)), source_path: source });
          continue;
        }
        const dest = path.join(EDITING_ASSET_DIR, name);
        await fsp.copyFile(source, dest);
        assets.push({ ...(await editingAssetPayload(dest, preferredKind)), source_path: source });
      }
      if (!assets.length) return httpError(res, 400, 'Không có asset Editing hợp lệ.');
      prewarmAudioPeaksForAssets(assets); // sóng âm thật: sinh trước khi người dùng kéo xuống timeline
      prewarmAssetProxiesForAssets(assets); // proxy LQ: sinh trước, xem khối "PROXY LQ CHO ASSET OVERLAY"
      projectMetrics.activity = true;
      res.json({ status: 'success', assets });
    } catch (error) {
      recordProjectError('editing_asset_import', error, { endpoint: '/api/editing-assets/import-local' });
      httpError(res, 500, error);
    }
  });

  /* LINK một thư mục (hoặc file) vào panel Editing — KHÔNG chép.
   *
   * Vì sao không dùng lại /api/editing-assets/import-local: hàm đó CHÉP từng file vào
   * temp_uploads/editing_assets, đúng cho vài file lẻ nhưng thêm một thư mục footage là
   * nhân đôi hàng chục GB và mỗi lần "Dự án mới" lại xoá sạch. Asset link trỏ thẳng vào
   * nguồn qua /api/source-file, giữ nguyên cây thư mục (`group_path`) để panel dựng lại.
   *
   * `lazyProbe` bật: cả cây có thể hàng trăm file, ffprobe từng cái là treo request.
   * Số đo lấy sau bằng /api/media-probe đúng lúc kéo block xuống timeline. */
  app.post('/api/editing-assets/link', async (req, res) => {
    try {
      const preferredKind = cleanInlineText(req.body?.kind || '', 40);
      const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
      if (!paths.length) return httpError(res, 400, 'Không có đường dẫn nào.');
      for (const raw of paths) registerSourceAccess(raw);
      const accept = preferredKind === 'audio'
        ? (p) => isSupportedEditingAssetFile(p) && editingAssetKindForPath(p) === 'audio'
        : (p) => isSupportedEditingAssetFile(p) && editingAssetKindForPath(p) !== 'audio';
      const entries = collectMediaTreeFromSourcePaths(paths, { accept });
      const assets = [];
      for (const entry of entries) {
        assets.push({
          ...(await editingAssetPayload(entry.path, preferredKind, {
            external: true,
            lazyProbe: true,
            groupPath: entry.group_path,
          })),
          source_path: entry.path,
        });
      }
      if (!assets.length) return httpError(res, 400, 'Không tìm thấy tệp phương tiện hợp lệ.');
      // Proxy LQ: sinh trước cho những file ĐẦU danh sách (có trần, xem
      // PROXY_PREWARM_MAX_PER_BATCH — link có thể là cả cây thư mục hàng trăm file).
      prewarmAssetProxiesForAssets(assets);
      projectMetrics.activity = true;
      res.json({ status: 'success', assets });
    } catch (error) {
      recordProjectError('editing_asset_link', error, { endpoint: '/api/editing-assets/link' });
      httpError(res, 500, error);
    }
  });

  app.post('/api/editing-assets/upload', upload.array('files'), async (req, res) => {
    try {
      ensureDirs();
      const preferredKind = cleanInlineText(req.body?.kind || '', 40);
      // Cây thư mục do frontend gửi kèm (chỉ dùng để HIỂN THỊ trong panel — file vẫn nằm
      // phẳng trong editing_assets). Phần tử thứ i ứng với file thứ i của form; multer giữ
      // nguyên thứ tự append nên chỉ số khớp trực tiếp.
      let groupPaths = [];
      try {
        const parsed = JSON.parse(req.body?.group_paths || '[]');
        if (Array.isArray(parsed)) groupPaths = parsed;
      } catch (_) { groupPaths = []; }
      const usedNames = new Set();
      const assets = [];
      const files = req.files || [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        if (!isSupportedEditingAssetUpload(file)) {
          await fsp.rm(file.path, { force: true }).catch(() => {});
          continue;
        }
        const name = safeAssetName(file.originalname || file.filename, usedNames);
        const dest = path.join(EDITING_ASSET_DIR, name);
        await fsp.rename(file.path, dest);
        const group = Array.isArray(groupPaths[i]) ? groupPaths[i].map((seg) => cleanInlineText(String(seg), 80)) : null;
        // Cùng lý do như /import-local: asset dùng bản SDR, bản HDR vừa nhận không còn ai đọc.
        const usable = await ensureSdrAsset(dest, { label: name });
        if (usable.tonemapped) await fsp.rm(dest, { force: true }).catch(() => {});
        assets.push(await editingAssetPayload(usable.path, preferredKind, { groupPath: group }));
      }
      if (!assets.length) return httpError(res, 400, 'Không có asset Editing hợp lệ.');
      prewarmAudioPeaksForAssets(assets); // sóng âm thật: sinh trước khi người dùng kéo xuống timeline
      prewarmAssetProxiesForAssets(assets); // proxy LQ: sinh trước, xem khối "PROXY LQ CHO ASSET OVERLAY"
      projectMetrics.activity = true;
      res.json({ status: 'success', assets });
    } catch (error) {
      recordProjectError('editing_asset_upload', error, { endpoint: '/api/editing-assets/upload' });
      httpError(res, 500, error);
    }
  });

  /* FILE VECTOR -> ẢNH RASTER.
   *
   * ffmpeg/ffprobe KHÔNG có bộ giải mã SVG: ffprobe trả về 0×0 (block dựng ra sai tỉ lệ,
   * rơi về khung mặc định 45%×25%) và export dừng ngay với "no decoder found for: svg".
   * Nói cách khác file vector không thể đi thẳng vào pipeline như .png/.jpg dù trình duyệt
   * vẫn vẽ được nó trong preview — đó là cái bẫy: preview có vẻ ổn, export thì chết.
   *
   * Chromium vẽ SVG tốt, nên VIỆC VẼ đặt ở frontend (canvas) rồi gửi PNG lên đây. Từ chỗ
   * này trở đi asset là một ảnh raster bình thường: số đo, thumbnail, preview và export đi
   * chung đúng một đường với .png, không nhánh riêng nào cho vector.
   *
   * `display_name` giữ tên .svg gốc để panel không hiện cái đuôi .png lạ mắt; `replace_path`
   * là bản .svg mà /import-local vừa chép vào — chép xong mới biết là vector nên dọn ở đây. */
  app.post('/api/editing-assets/rasterize', upload.single('file'), async (req, res) => {
    try {
      ensureDirs();
      const file = req.file;
      if (!file) return httpError(res, 400, 'Thiếu ảnh raster của file vector.');
      const displayName = cleanInlineText(req.body?.display_name || '', 255)
        || path.basename(file.originalname || 'vector.png');
      const name = safeAssetName(`${path.parse(displayName).name || 'vector'}.png`, new Set());
      const dest = path.join(EDITING_ASSET_DIR, name);
      await fsp.rename(file.path, dest);
      let groupPath = null;
      try {
        const parsed = JSON.parse(req.body?.group_path || 'null');
        if (Array.isArray(parsed)) groupPath = parsed.map((seg) => cleanInlineText(String(seg), 80));
      } catch (_) { groupPath = null; }
      const asset = await editingAssetPayload(dest, cleanInlineText(req.body?.kind || '', 40), { groupPath });
      asset.name = displayName;
      const sourcePath = cleanInlineText(req.body?.source_path || '', 2000);
      if (sourcePath) asset.source_path = sourcePath;
      // Dọn bản vector đã chép (chỉ trong thư mục asset của dự án — không đụng file người dùng).
      const stale = path.resolve(cleanInlineText(req.body?.replace_path || '', 2000));
      if (stale && stale !== dest && stale.startsWith(EDITING_ASSET_DIR + path.sep)) {
        await fsp.rm(stale, { force: true }).catch(() => {});
      }
      projectMetrics.activity = true;
      res.json({ status: 'success', asset });
    } catch (error) {
      recordProjectError('editing_asset_rasterize', error, { endpoint: '/api/editing-assets/rasterize' });
      httpError(res, 500, error);
    }
  });

  /* ---- CÀI ĐẶT ỨNG DỤNG ----
   * Ba route mỏng: đọc / ghi / khôi phục. Toàn bộ phần "hiểu" cấu hình nằm ở
   * AppSettings.normalize() dùng chung với frontend, nên ở đây không có luật nghiệp vụ
   * nào — thêm mục cài đặt mới KHÔNG phải sửa backend. */
  app.get('/api/settings', async (_req, res) => {
    try {
      res.json(readAppSettings());
    } catch (error) {
      recordProjectError('settings_read', error, { endpoint: '/api/settings' });
      httpError(res, 500, error);
    }
  });

  app.post('/api/settings', async (req, res) => {
    try {
      res.json(writeAppSettings(req.body));
    } catch (error) {
      recordProjectError('settings_write', error, { endpoint: '/api/settings' });
      httpError(res, 500, error);
    }
  });

  /* ---- BỘ NHỚ ĐỆM (Cài đặt → Bộ nhớ đệm) ----
   * Chỉ `peaks_cache` và `asr_cache` được DỌN: cả hai sinh lại được (peak dựng lại khi mở
   * Editing, ASR đọc lại từ nguồn). `temp_uploads` cố tình CHỈ ĐỌC — nó là dữ liệu làm việc
   * của dự án ĐANG MỞ (nguồn đã nhập, proxy, ảnh bake); dọn tay là giết dự án đang mở, và
   * đã có `/api/reset-project` lo việc đó đúng lúc. */
  const CACHE_TARGETS = {
    peaks: { dir: PEAKS_CACHE_DIR, label: 'Sóng âm (.pk)', clearable: true },
    proxy: { dir: PROXY_CACHE_DIR, label: 'Proxy LQ xem trước', clearable: true },
    asr: { dir: ASR_CACHE_DIR, label: 'Kết quả bóc băng', clearable: true },
    concat: { dir: CONCAT_CACHE_DIR, label: 'Bản đã nối của dự án', clearable: true },
    temp: { dir: TEMP_DIR, label: 'Dữ liệu dự án đang mở', clearable: false },
  };

  app.get('/api/cache/usage', async (_req, res) => {
    try {
      res.json({
        status: 'success',
        items: Object.entries(CACHE_TARGETS).map(([id, t]) => {
          const usage = dirUsage(t.dir);
          return { id, label: t.label, clearable: t.clearable, ...usage };
        }),
      });
    } catch (error) {
      recordProjectError('cache_usage', error, { endpoint: '/api/cache/usage' });
      httpError(res, 500, error);
    }
  });

  app.post('/api/cache/clear', async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const target = CACHE_TARGETS[id];
      if (!target) return httpError(res, 400, 'Bộ nhớ đệm không hợp lệ.');
      if (!target.clearable) return httpError(res, 400, `Không dọn được "${target.label}" — đây là dữ liệu của dự án đang mở.`);
      let removed = 0;
      let names = [];
      try { names = fs.readdirSync(target.dir); } catch (_) { names = []; }
      names.forEach((name) => {
        try { fs.rmSync(path.join(target.dir, name), { recursive: true, force: true }); removed += 1; } catch (_) { /* bỏ qua */ }
      });
      fs.mkdirSync(target.dir, { recursive: true });
      res.json({ status: 'success', id, removed, ...dirUsage(target.dir) });
    } catch (error) {
      recordProjectError('cache_clear', error, { endpoint: '/api/cache/clear' });
      httpError(res, 500, error);
    }
  });

  /* "Khôi phục mặc định" trả CÀI ĐẶT về mặc định nhưng GIỮ thư viện "Hiệu ứng chữ" người
   * dùng tự lưu: đó không phải một tuỳ chọn cấu hình mà là thiết kế do họ làm ra, mất là
   * mất hẳn. Người muốn dọn thư viện đã có nút xoá trên từng thẻ hiệu ứng. */
  app.post('/api/settings/reset', async (_req, res) => {
    try {
      const kept = readAppSettings().textEffects || [];
      try { fs.unlinkSync(SETTINGS_FILE); } catch (_) {}
      res.json(kept.length ? writeAppSettings({ ...AppSettings.defaults(), textEffects: kept }) : AppSettings.defaults());
    } catch (error) {
      recordProjectError('settings_reset', error, { endpoint: '/api/settings/reset' });
      httpError(res, 500, error);
    }
  });

  app.get('/api/library', async (req, res) => {
    try {
      ensureDirs();
      const category = String(req.query.category || '').toLowerCase();
      const dir = libraryCategoryDir(category);
      if (!dir) return httpError(res, 400, 'Category thư viện không hợp lệ.');
      let names = [];
      try { names = await fsp.readdir(dir); } catch (_) { names = []; }
      const items = names
        .filter((name) => !name.startsWith('.') && isSupportedEditingAssetFile(path.join(dir, name)))
        .sort((a, b) => a.localeCompare(b))
        .map((name) => {
          const kind = editingAssetKindForPath(path.join(dir, name));
          const url = publicLibraryUrl(category, name);
          // Video: KHÔNG trích khung ở đây. Listing phải rẻ (cùng lý do walkLibraryAssets
          // không ffprobe) — một thư mục vài chục video sẽ thành vài chục lần gọi sidecar
          // ngay trong request. Thay vào đó trỏ sang /api/library/thumb: <img loading="lazy">
          // chỉ gọi khi thẻ lọt vào tầm nhìn, và endpoint đó có cache đĩa.
          /* ẢNH RASTER đi cùng đường với video: trỏ sang /api/library/thumb chứ KHÔNG trả
             URL file gốc. Trả file gốc thì mỗi thẻ ~60px bắt Chromium giải mã nguyên ảnh —
             ảnh máy ảnh 45 MP tốn 173 MB RGBA một thẻ, và đó chính là nguyên nhân giật đã
             đo được. `.svg` vẫn dùng URL gốc: vector, nhẹ, mà ffmpeg không giải mã được. */
          const isRasterImage = kind === 'media_image'
            && RASTER_IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
          const thumb = (kind === 'media_video' || isRasterImage)
            ? `${API_PREFIX_LIBRARY_THUMB}?category=${encodeURIComponent(category)}&name=${encodeURIComponent(name)}`
            : (kind === 'media_image' ? url : '');
          return { name, url, type: kind, thumbnail_url: thumb };
        });
      res.json({ status: 'success', category, items });
    } catch (error) {
      recordProjectError('library_list', error, { endpoint: '/api/library' });
      httpError(res, 500, error);
    }
  });

  /* Thumbnail cho MỘT video trong library/ — trích lười, gọi tới đâu sinh tới đó.
   * createOrGetThumbnail() có cache đĩa (temp_uploads/thumbnails) nên lần sau chỉ là
   * một cú redirect. Video hỏng/không trích được -> 404 để <img> rơi về ô giữ chỗ
   * (KHÔNG trả ảnh rỗng: trình duyệt sẽ cache "thành công" và ô giữ chỗ không hiện). */
  app.get(API_PREFIX_LIBRARY_THUMB, async (req, res) => {
    try {
      ensureDirs();
      const category = String(req.query.category || '').toLowerCase();
      const dir = libraryCategoryDir(category);
      if (!dir) return httpError(res, 400, 'Category thư viện không hợp lệ.');
      // basename: chặn ../ leo ra ngoài thư mục category (cùng cách /api/library/add làm)
      const name = path.basename(String(req.query.name || ''));
      const filePath = path.join(dir, name);
      if (!name || !fs.existsSync(filePath) || !isSupportedEditingAssetFile(filePath)) {
        return httpError(res, 404, 'Không tìm thấy asset thư viện.');
      }
      const assetKind = editingAssetKindForPath(filePath);
      const isRasterImage = assetKind === 'media_image'
        && RASTER_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
      if (assetKind !== 'media_video' && !isRasterImage) {
        return httpError(res, 400, 'Chỉ video và ảnh raster mới trích được thumbnail.');
      }
      const url = isRasterImage
        ? await createOrGetImageThumbnail(filePath)
        : await createOrGetThumbnail(filePath);
      if (!url) return httpError(res, 404, 'Không trích được thumbnail.');
      res.redirect(302, url);
    } catch (error) {
      recordProjectError('library_thumb', error, { endpoint: API_PREFIX_LIBRARY_THUMB });
      httpError(res, 500, error);
    }
  });

  // Danh mục ĐỆ QUY toàn bộ library/ (mọi thư mục con) — Magic Fill dùng để dò tên
  // asset khớp với từ khoá trong kịch bản. Chỉ trả metadata rẻ tiền (không ffprobe);
  // kích thước/thời lượng lấy sau bằng /api/library/add khi đã chọn được file.
  app.get('/api/library/all', (_req, res) => {
    try {
      ensureDirs();
      res.json({ status: 'success', items: walkLibraryAssets() });
    } catch (error) {
      recordProjectError('library_list_all', error, { endpoint: '/api/library/all' });
      httpError(res, 500, error);
    }
  });

  // ======================= LUT MÀU (.cube) cho panel Điều chỉnh =======================
  //
  // GET  /api/color-luts          -> danh mục {id, name, url, builtin}
  // POST /api/color-luts/import   -> nhận 1 file .cube của người dùng, kiểm tính hợp lệ
  //                                  rồi lưu vào library/luts (đã được static-serve).
  //
  // Backend chỉ QUẢN LÝ FILE; toàn bộ phần toán nằm ở static/js/color-adjust.js để
  // preview và export không thể lệch nhau.
  app.get('/api/color-luts', (_req, res) => {
    try {
      ensureDirs();
      res.json({ status: 'success', luts: listColorLuts() });
    } catch (error) {
      recordProjectError('color_lut_list', error, { endpoint: '/api/color-luts' });
      httpError(res, 500, error);
    }
  });

  app.post('/api/color-luts/import', upload.array('files'), async (req, res) => {
    const uploaded = Array.isArray(req.files) ? req.files : [];
    try {
      ensureDirs();
      if (!uploaded.length) return httpError(res, 400, 'Chưa chọn file .cube nào.');
      const file = uploaded[0];
      if (path.extname(file.originalname).toLowerCase() !== '.cube') {
        return httpError(res, 400, 'Chỉ nhận file .cube (LUT 3D).');
      }
      const text = fs.readFileSync(file.path, 'utf8');
      const check = validateCubeText(text);
      if (!check.ok) return httpError(res, 400, `File .cube không hợp lệ: ${check.error}`);

      const base = sanitizeLutId(path.basename(file.originalname, '.cube')) || 'lut';
      let id = base;
      let suffix = 2;
      while (fs.existsSync(path.join(LUT_DIR, `${id}.cube`))) {
        id = `${base}_${suffix}`;
        suffix += 1;
      }
      fs.writeFileSync(path.join(LUT_DIR, `${id}.cube`), text);
      projectMetrics.activity = true;
      res.json({
        status: 'success',
        lut: { id, name: path.basename(file.originalname, '.cube'), url: `/library/luts/${id}.cube`, builtin: false },
      });
    } catch (error) {
      recordProjectError('color_lut_import', error, { endpoint: '/api/color-luts/import' });
      httpError(res, 500, error);
    } finally {
      // multer để file thô trong temp_uploads -> dọn ngay, bản chuẩn đã nằm ở library/luts
      uploaded.forEach((f) => { try { fs.unlinkSync(f.path); } catch (_) {} });
    }
  });

  app.post('/api/library/add', async (req, res) => {
    try {
      ensureDirs();
      // Dạng 2 (Magic Fill): body.paths[] = đường dẫn TƯƠNG ĐỐI trong library/ (kể cả
      // thư mục con). Trả payload đầy đủ (kích thước/thời lượng) để đặt vào timeline.
      const relPaths = Array.isArray(req.body?.paths) ? req.body.paths : null;
      if (relPaths) {
        const assets = [];
        for (const rel of relPaths.slice(0, 200)) {
          const filePath = resolveLibraryRelPath(rel);
          if (!filePath || !fs.existsSync(filePath) || !isSupportedEditingAssetFile(filePath)) continue;
          assets.push(await libraryAssetPayload(filePath, libraryCategoryForPath(filePath)));
        }
        if (!assets.length) return httpError(res, 404, 'Không tìm thấy asset thư viện.');
        prewarmAudioPeaksForAssets(assets);
        prewarmAssetProxiesForAssets(assets);
        projectMetrics.activity = true;
        return res.json({ status: 'success', assets });
      }
      const category = String(req.body?.category || '').toLowerCase();
      const dir = libraryCategoryDir(category);
      if (!dir) return httpError(res, 400, 'Category thư viện không hợp lệ.');
      const name = path.basename(String(req.body?.name || ''));
      const filePath = path.join(dir, name);
      if (!name || !fs.existsSync(filePath) || !isSupportedEditingAssetFile(filePath)) {
        return httpError(res, 404, 'Không tìm thấy asset thư viện.');
      }
      const asset = await libraryAssetPayload(filePath, category);
      prewarmAudioPeaksForAssets([asset]); // sóng âm thật cho asset thư viện
      prewarmAssetProxiesForAssets([asset]); // proxy LQ cho asset thư viện
      projectMetrics.activity = true;
      res.json({ status: 'success', assets: [asset] });
    } catch (error) {
      recordProjectError('library_add', error, { endpoint: '/api/library/add' });
      httpError(res, 500, error);
    }
  });

  app.post('/api/transcribe', upload.array('files'), async (req, res) => {
    const requestedEngine = normalizeAsrEngine(req.body?.asr_engine || 'mlx_whisper');
    try {
      const files = (req.files || []).map((file) => ({ name: file.filename, path: file.path }));
      if (!files.length) return httpError(res, 400, 'Không có nguồn video đầu vào.');
      setStatus('Đang tiếp nhận file video từ trình duyệt...');
      res.json(await handleTranscribeFromSavedFiles({
        savedFiles: files,
        referenceScript: req.body.reference_script || '',
        scriptMetadata: parseScriptMetadata(req.body.script_metadata),
        transcribeMode: req.body.transcribe_mode || 'vi_smart',
        asrEngine: requestedEngine,
        asrModel: req.body.asr_model,
        clientStartedAtMs: req.body.client_started_at_ms,
      }));
    } catch (error) {
      recordProjectError('transcribe', error, { endpoint: '/api/transcribe', engine: requestedEngine });
      setStatus('Lỗi hệ thống!');
      httpError(res, 500, error);
    }
  });

  app.post('/api/transcribe-local', async (req, res) => {
    const requestedEngine = normalizeAsrEngine(req.body?.asr_engine || 'mlx_whisper');
    try {
      const sourcePaths = req.body?.source_paths || [];
      if (!sourcePaths.length) return httpError(res, 400, 'Không có nguồn video đầu vào.');
      setStatus('Đang tiếp nhận file video từ desktop...');
      const resolvedSources = collectVideosFromSourcePaths(sourcePaths);
      if (!resolvedSources.length) return httpError(res, 400, 'Không tìm thấy video hợp lệ.');
      const savedFiles = await copyLocalSourcesToTemp(resolvedSources);
      res.json(await handleTranscribeFromSavedFiles({
        savedFiles,
        resolvedSources,
        referenceScript: req.body.reference_script || '',
        scriptMetadata: parseScriptMetadata(req.body.script_metadata),
        transcribeMode: req.body.transcribe_mode || 'vi_smart',
        asrEngine: requestedEngine,
        asrModel: req.body.asr_model,
        clientStartedAtMs: req.body.client_started_at_ms,
      }));
    } catch (error) {
      recordProjectError('transcribe', error, { endpoint: '/api/transcribe-local', engine: requestedEngine });
      setStatus('Lỗi hệ thống!');
      httpError(res, 500, error);
    }
  });

  app.post('/api/filter', upload.none(), async (req, res) => {
    try {
      setStatus('Đang chạy pipeline lọc transcript: tiền xử lý, so khớp mờ và chọn take cuối...');
      const sessionPath = path.join(TEMP_DIR, 'session_segments.json');
      const result = await runMatchingPipeline({
        referenceScript: req.body.reference_script || '',
        transcriptText: req.body.edited_transcript || '',
        sessionPath,
        pinnedTakes: parsePinnedTakes(req.body.pinned_takes),
      });
      const scriptMetadata = parseScriptMetadata(req.body.script_metadata);
      if (scriptMetadata && projectMetrics.transcribe) {
        projectMetrics.transcribe.script_metadata = jsonSafe(scriptMetadata);
        projectMetrics.transcribe.diagnostics = {
          ...(projectMetrics.transcribe.diagnostics || {}),
          script_metadata: summarizeScriptMetadata(scriptMetadata),
        };
      }
      setStatus('Đã hoàn tất lọc kịch bản và tạo timeline EDL/XML.');
      projectMetrics.activity = true;
      res.json({ status: 'success', ...result });
    } catch (error) {
      recordProjectError('filter', error, { endpoint: '/api/filter' });
      setStatus('Lỗi khi chạy pipeline lọc transcript!');
      httpError(res, 500, error);
    }
  });

  /* Sắp xếp timeline theo kịch bản chuẩn — chỉ GÁN NHÃN CÂU cho các block đang có,
   * không bóc băng lại, không chọn take. Người dùng đã chọn xong vùng nào giữ; việc còn
   * lại là nói xem mỗi block ứng với câu nào để renderer sắp lại và cắt nhỏ khi cần. */
  app.post('/api/reorder-by-script', async (req, res) => {
    try {
      const referenceScript = String(req.body?.reference_script || '');
      if (!referenceScript.trim()) return httpError(res, 400, 'Chưa có kịch bản chuẩn để sắp xếp theo!');
      let blocks;
      try {
        // Lỗi hình dạng payload là lỗi PHÍA GỌI -> 400, không trộn vào 500 của sidecar.
        blocks = normalizeReorderBlocks(req.body?.blocks);
      } catch (error) {
        return httpError(res, 400, error);
      }
      if (!blocks.length) return httpError(res, 400, 'Không có block nào để sắp xếp!');
      const sourced = await resolveTimelineWords({
        blocks,
        referenceScript,
        transcribeMode: req.body?.transcribe_mode || 'vi_smart',
        asrEngine: normalizeAsrEngine(req.body?.asr_engine || 'mlx_whisper'),
        asrModel: req.body?.asr_model,
      });
      setStatus(`Đang so khớp ${blocks.length} block với kịch bản chuẩn...`);
      const result = await runScriptReorder({ referenceScript, blocks: sourced.blocks });
      setStatus('Đã tính xong thứ tự theo kịch bản.');
      projectMetrics.activity = true;
      res.json({
        status: 'success',
        word_source: sourced.source,
        word_count: sourced.wordCount,
        ...result,
      });
    } catch (error) {
      recordProjectError('reorder-by-script', error, { endpoint: '/api/reorder-by-script' });
      setStatus('Lỗi khi so khớp thứ tự theo kịch bản!');
      httpError(res, 500, error);
    }
  });

  app.post('/api/finalize-timeline', async (req, res) => {
    try {
      const chunks = req.body?.selected_chunks || [];
      if (!chunks.length) return httpError(res, 400, 'Không có đoạn nào được chọn!');
      const result = ensureCore().finalizeTimeline({ selected_chunks: chunks });
      projectMetrics.activity = true;
      res.json({ status: 'success', ...result });
    } catch (error) {
      recordProjectError('finalize', error, { endpoint: '/api/finalize-timeline' });
      httpError(res, 500, error);
    }
  });

  app.post('/api/auto-reframe/analyze', async (req, res) => {
    try {
      const sourceVideoPath = path.join(TEMP_DIR, 'temp_input.mp4');
      if (!fs.existsSync(sourceVideoPath)) {
        return httpError(res, 400, 'Không tìm thấy video nguồn. Hãy chạy bước bóc băng trước.');
      }
      const rawTimeline = Array.isArray(req.body?.timeline)
        ? req.body.timeline
        : JSON.parse(req.body?.timeline_json || '[]');
      const clips = normalizeAutoReframeClips(rawTimeline);
      if (!clips.length) return httpError(res, 400, 'Timeline rỗng. Không có clip để Auto-Reframe.');
      setStatus('Đang nhận diện người/khuôn mặt cho Auto-Reframe Timeline...');
      const result = await runAutoReframeAnalysis({ videoPath: sourceVideoPath, clips });
      setStatus('Đã hoàn tất Auto-Reframe Timeline.');
      projectMetrics.activity = true;
      res.json({ status: 'success', ...result });
    } catch (error) {
      recordProjectError('auto_reframe', error, { endpoint: '/api/auto-reframe/analyze' });
      setStatus('Lỗi khi chạy Auto-Reframe Timeline!');
      httpError(res, 500, error);
    }
  });

  // Dò điểm đổi góc máy trong từng block timeline (scene-score + so sánh hậu cảnh).
  app.post('/api/auto-reframe/detect-cuts', async (req, res) => {
    try {
      const sourceVideoPath = path.join(TEMP_DIR, 'temp_input.mp4');
      if (!fs.existsSync(sourceVideoPath)) {
        return httpError(res, 400, 'Không tìm thấy video nguồn. Hãy chạy bước bóc băng trước.');
      }
      const rawTimeline = Array.isArray(req.body?.timeline)
        ? req.body.timeline
        : JSON.parse(req.body?.timeline_json || '[]');
      const clips = normalizeAutoReframeClips(rawTimeline);
      if (!clips.length) return httpError(res, 400, 'Timeline rỗng. Không có block để dò góc máy.');
      setStatus('Đang dò điểm đổi góc máy trong các block Timeline...');
      const result = await runAutoReframeAnalysis({
        videoPath: sourceVideoPath,
        clips,
        mode: 'detect_cuts',
        options: (req.body?.options && typeof req.body.options === 'object') ? req.body.options : undefined,
      });
      setStatus('Đã dò xong điểm đổi góc máy.');
      projectMetrics.activity = true;
      res.json({ status: 'success', ...result });
    } catch (error) {
      recordProjectError('auto_reframe_detect_cuts', error, { endpoint: '/api/auto-reframe/detect-cuts' });
      setStatus('Lỗi khi dò điểm đổi góc máy!');
      httpError(res, 500, error);
    }
  });

  // POSE TRACK (Chế độ Nhà phát triển -> overlay Skeleton): xuất landmark toàn thân + mặt
  // theo frame (chuẩn hoá 0..1) cho các block được yêu cầu. Chạy MediaPipe qua sidecar.
  /* Landmark khuôn mặt MỌI frame — dữ liệu nền cho Retouch.
   *
   * CACHE RA ĐĨA theo (đường dẫn nguồn + khoảng clip + tuỳ chọn), cùng lối `peaks_cache`
   * của sóng âm: phân tích cả clip tốn hàng chục giây, mà người dùng kéo slider Retouch
   * thì phải thấy ngay — không thể chạy lại MediaPipe mỗi lần.
   * Đo trên footage của dự án: 6 giây @30fps (1728x3072) = 4,4 giây phân tích, nhận diện
   * được mặt ở 180/180 frame.
   */
  app.post('/api/retouch/track', async (req, res) => {
    try {
      // NGUỒN: mặc định là lane chính (temp_input.mp4), nhưng nhận được đường dẫn asset
      // bất kỳ để media overlay cũng retouch được — VIDEO hoặc ẢNH TĨNH (ảnh đi đường
      // một-khung `track_retouch_still` ở sidecar).
      //
      // BẮT BUỘC KIỂM TRONG THƯ MỤC CHO PHÉP: `source_path` đến từ request, mà endpoint
      // này đưa thẳng đường dẫn cho sidecar mở. Không chặn thì nó thành một cách đọc file
      // tuỳ ý trên máy. Chỉ cho TEMP_DIR (asset đã nhập) và LIBRARY_DIR (thư viện).
      const sourceVideoPath = resolveRetouchSource(req.body?.source_path);
      if (!sourceVideoPath) {
        return httpError(res, 400, 'Nguồn cho Retouch không hợp lệ hoặc nằm ngoài thư mục dự án.');
      }
      if (!fs.existsSync(sourceVideoPath)) {
        return httpError(res, 400, 'Không tìm thấy nguồn cho Retouch. Hãy chạy bước bóc băng trước.');
      }
      const rawTimeline = Array.isArray(req.body?.timeline)
        ? req.body.timeline
        : JSON.parse(req.body?.timeline_json || '[]');
      const clips = normalizeAutoReframeClips(rawTimeline);
      if (!clips.length) return httpError(res, 400, 'Không có block để bám khuôn mặt.');
      const options = (req.body && typeof req.body.options === 'object') ? req.body.options : {};

      const cachePath = retouchCachePath(sourceVideoPath, clips, options);
      if (fs.existsSync(cachePath)) {
        // Trúng cache -> trả thẳng, KHÔNG chạm vào sidecar.
        return res.json({ status: 'success', cached: true, ...JSON.parse(fs.readFileSync(cachePath, 'utf8')) });
      }
      setStatus('Đang bám khuôn mặt cho Retouch...');
      const result = await runAutoReframeAnalysis({
        videoPath: sourceVideoPath,
        clips,
        mode: 'retouch_track',
        options,
      });
      try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(result));
      } catch (error) {
        // Ghi cache hỏng thì vẫn trả kết quả — chỉ mất phần tăng tốc lần sau.
        logStatus(`[retouch] không ghi được cache: ${error.message}`);
      }
      setStatus('Đã bám xong khuôn mặt cho Retouch.');
      projectMetrics.activity = true;
      res.json({ status: 'success', cached: false, ...result });
    } catch (error) {
      recordProjectError('retouch_track', error, { endpoint: '/api/retouch/track' });
      setStatus('Lỗi khi bám khuôn mặt cho Retouch!');
      httpError(res, 500, error);
    }
  });

  app.post('/api/pose/track', async (req, res) => {
    try {
      const sourceVideoPath = path.join(TEMP_DIR, 'temp_input.mp4');
      if (!fs.existsSync(sourceVideoPath)) {
        return httpError(res, 400, 'Không tìm thấy video nguồn. Hãy chạy bước bóc băng trước.');
      }
      const rawTimeline = Array.isArray(req.body?.timeline)
        ? req.body.timeline
        : JSON.parse(req.body?.timeline_json || '[]');
      const clips = normalizeAutoReframeClips(rawTimeline);
      if (!clips.length) return httpError(res, 400, 'Không có block để dựng skeleton.');
      setStatus('Đang dựng skeleton (nhận diện người) cho Editing...');
      const result = await runAutoReframeAnalysis({
        videoPath: sourceVideoPath,
        clips,
        mode: 'pose_track',
        options: (req.body?.options && typeof req.body.options === 'object') ? req.body.options : undefined,
      });
      setStatus('Đã dựng xong skeleton.');
      projectMetrics.activity = true;
      res.json({ status: 'success', ...result });
    } catch (error) {
      recordProjectError('pose_track', error, { endpoint: '/api/pose/track' });
      setStatus('Lỗi khi dựng skeleton!');
      httpError(res, 500, error);
    }
  });

  app.post('/api/magic-fill/transcribe-range', async (req, res) => {
    try {
      const sourceVideoPath = path.join(TEMP_DIR, 'temp_input.mp4');
      if (!fs.existsSync(sourceVideoPath)) {
        return httpError(res, 400, 'Không tìm thấy video nguồn. Hãy chạy bước bóc băng trước.');
      }
      const intervals = normalizeMagicFillIntervals(req.body?.intervals);
      if (!intervals.length) return httpError(res, 400, 'Timeline rỗng. Không có khoảng audio để bóc băng lại.');
      const result = await transcribeMagicFillTimeline({
        sourceVideoPath,
        intervals,
        referenceScript: req.body?.reference_script || '',
        transcribeMode: req.body?.transcribe_mode || 'vi_smart',
        asrEngine: normalizeAsrEngine(req.body?.asr_engine || 'mlx_whisper'),
        asrModel: req.body?.asr_model,
      });
      projectMetrics.activity = true;
      res.json({ status: 'success', ...result });
    } catch (error) {
      recordProjectError('magic_fill_asr', error, { endpoint: '/api/magic-fill/transcribe-range' });
      setStatus('Lỗi khi bóc băng lại audio cho Magic Fill!');
      httpError(res, 500, error);
    }
  });

  /* ===== AUTO SUBTITLE (tab Âm thanh) =====
   * Job NỀN: endpoint trả job_id ngay, panel poll `GET .../jobs/:id` để vẽ thanh tiến
   * trình. Bóc băng cả timeline mất hàng chục giây tới vài phút — giữ request mở suốt
   * quãng đó là mất luôn đường Huỷ và không báo được phần trăm. */
  app.post('/api/subtitles/transcribe', async (req, res) => {
    try {
      const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
      if (!entries.length) return httpError(res, 400, 'Timeline chưa có đoạn audio nào để tạo phụ đề.');
      const job = await subtitleJobs.create({
        entries,
        reference_script: req.body?.reference_script || '',
        transcribe_mode: req.body?.transcribe_mode || 'vi_smart',
        /* normalizeAsrEngine BỎ QUA giá trị gửi lên và trả engine CỦA NỀN TẢNG
           ('faster_whisper' trên Windows, 'whisper.cpp' nếu bật rollback). Panel vẫn gửi
           lựa chọn của người dùng để đường này giống hệt /api/transcribe, nhưng không có
           cách nào ép nhầm engine của nền tảng khác. */
        asr_engine: normalizeAsrEngine(req.body?.asr_engine),
        asr_model: req.body?.asr_model,
        /* Ngôn ngữ bóc băng, LỌC TRẮNG ngay tại cửa. Giá trị này đi thẳng vào tham số
           `language` của Whisper: mã lạ thì model không báo lỗi mà lặng lẽ DỊCH lời thoại
           sang thứ tiếng ấy, nên để lọt vào là hỏng kết quả chứ không phải hỏng request. */
        language: normalizeSubtitleLanguage(req.body?.language),
      });
      projectMetrics.activity = true;
      res.json({ status: 'success', ...subtitleJobs.publicJob(job) });
    } catch (error) {
      recordProjectError('auto_subtitle', error, { endpoint: '/api/subtitles/transcribe' });
      httpError(res, error?.statusCode || 500, error);
    }
  });

  app.get('/api/subtitles/jobs/:id', (req, res) => {
    const job = subtitleJobs.get(req.params.id);
    if (!job) return httpError(res, 404, 'Không tìm thấy job tạo phụ đề.');
    res.json({ status: 'success', ...subtitleJobs.publicJob(job) });
  });

  app.post('/api/subtitles/jobs/:id/cancel', (req, res) => {
    const job = subtitleJobs.cancel(req.params.id);
    if (!job) return httpError(res, 404, 'Không tìm thấy job tạo phụ đề.');
    res.json({ status: 'success', ...subtitleJobs.publicJob(job) });
  });

  app.post('/api/export-video', transitionFrameUpload.array('transition_frames', TRANSITION_FRAME_LIMIT), async (req, res) => {
    // KHOÁ MỘT LƯỢT XUẤT: mọi lượt xuất đều ghi vào CÙNG một đường dẫn
    // (TEMP_DIR/final_cut.mp4). Hai lượt chạy song song sẽ ghi đè nhau giữa lúc đang viết ->
    // file MP4 ra lỗi (đo thật: 29.6MB dữ liệu nhưng header khai 2.002s cho timeline 44.6s),
    // và cùng lúc 2 tiến trình ffmpeg còn giành CPU nên lượt nào cũng chậm gấp đôi.
    // Frontend đã có cờ chống bấm 2 lần, nhưng chốt ở đây mới chặn được mọi nguồn (2 cửa sổ,
    // gọi lại API, người dùng bấm khi bake đang chạy...).
    if (exportInFlight) {
      return httpError(res, 409, 'Đang xuất một video khác. Hãy đợi lượt hiện tại xong rồi thử lại.');
    }
    exportInFlight = true;
    // NHẢ KHOÁ khi RESPONSE ĐÓNG, không phải khi handler chạy xong: res.download() chỉ BẮT
    // ĐẦU stream file rồi trả về ngay, nhả khoá ở đó thì lượt xuất kế tiếp có thể ghi đè
    // final_cut.mp4 đúng lúc nó đang được tải về. 'close' bắn ở MỌI đường (thành công, lỗi,
    // client huỷ) nên khoá không bao giờ bị kẹt.
    let exportLockReleased = false;
    const releaseExportLock = () => {
      if (exportLockReleased) return;
      exportLockReleased = true;
      exportInFlight = false;
    };
    res.on('close', releaseExportLock);
    let exportSettingsForError = null;
    // Khung vùng chuyển cảnh đã được multer ghi ra đĩa trước khi vào handler; tra theo TÊN
    // mà frontend đặt (chính là tên trong seq.frame_files).
    const transitionFrameFiles = new Map(
      (Array.isArray(req.files) ? req.files : []).map((file) => [String(file.originalname || ''), file.path]),
    );
    try {
      setStatus('Đang chuẩn bị cắt video theo timeline đã lọc...');
      const sourceVideoPath = path.join(TEMP_DIR, 'temp_input.mp4');
      if (!fs.existsSync(sourceVideoPath)) {
        return httpError(res, 400, 'Không tìm thấy video nguồn. Hãy chạy bước bóc băng trước.');
      }
      const timeline = JSON.parse(req.body.timeline_json || '[]');
      const exportSettings = normalizeExportSettings(req.body);
      const exportRaw = typeof req.body.export_settings === 'string' && req.body.export_settings.trim()
        ? JSON.parse(req.body.export_settings)
        : (req.body.export_settings || {});
      const sequenceSettings = normalizeSequenceSettings(exportRaw.sequence || parseOptionalJsonObject(req.body.sequence_settings), exportSettings, sourceVideoPath);
      /* Khổ SEQUENCE phải biết TRƯỚC khi chuẩn hoá timeline (thứ tự này đổi 2026-09-09):
       * hệ số VỪA KHUNG của từng block = f(vùng ảnh của block, khổ sequence), mà nó nằm
       * trong payload gửi cho sidecar. Trước đây timeline được chuẩn hoá trước nên không có
       * đường nào biết khổ sequence. */
      const exportIntervals = normalizeExportIntervals(timeline, sequenceSettings);
      if (!exportIntervals.length) return httpError(res, 400, 'Timeline rỗng. Không có đoạn nào để xuất video.');
      exportSettings.width = sequenceSettings.width;
      exportSettings.height = sequenceSettings.height;
      exportSettings.resolution = 'sequence';
      /* "Giữ theo nguồn" ở hộp thoại Xuất = THEO TIMEBASE CỦA SEQUENCE, không phải theo
       * nhịp khung của file nguồn. Đúng như Premiere: ô Frame Rate của Export Settings mặc
       * định lấy timebase sequence, và nhịp của từng clip nguồn không liên quan.
       *
       * THỨ TỰ ƯU TIÊN LÀ PHẦN QUAN TRỌNG NHẤT Ở ĐÂY:
       *   1. `sequence.fps`   — con số NGƯỜI DÙNG chọn. Luôn thắng.
       *   2. `sequence.source_fps` — nhịp nguồn đầu tiên, dùng khi người dùng chưa chọn gì.
       *   3. '30'             — chốt chặn cuối.
       * Bản trước bỏ hẳn bậc (1) và đi thẳng vào (2). Lỗi lộ ra khi hai bậc đó khác nhau:
       * dự án 59.94 (DJI) thêm một clip 50fps -> `source_fps` thành '50' -> người dùng chọn
       * lại 59.94 trên thanh preview -> vẫn xuất ra 50 fps, vì lựa chọn đó không có đường
       * nào tới được dòng này. (Người dùng báo 2026-09-09, file `Test_lech fps.mp4`.) */
      exportSettings.render_fps = canonicalFpsText(
        exportSettings.fps === 'source'
          ? (sequenceSettings.fps || sequenceSettings.source_fps || '30')
          : exportSettings.fps,
        '30',
      );
      exportSettingsForError = exportSettings;
      // Chốt màu asset overlay TRƯỚC khi dựng payload: xem sdrOverridesForEditingAssets.
      const sdrAssetOverrides = await sdrOverridesForEditingAssets(req.body.editing_json || {});
      const editingPayload = normalizeEditingPayload(
        req.body.editing_json || {},
        timelineDurationFromIntervals(exportIntervals),
        parseFpsValue(exportSettings.render_fps),
        transitionFrameFiles,
        sdrAssetOverrides,
      );
      const timelineFile = path.join(TEMP_DIR, 'export_timeline.json');
      await fsp.writeFile(timelineFile, JSON.stringify(jsonSafe({
        version: editingPayload.overlays.length ? 4 : 3,
        sequence: sequenceSettings,
        intervals: exportIntervals,
        editingTracks: editingPayload.tracks,
        editingItems: editingPayload.items,
        assets: editingPayload.assets,
        main_audio_volume: editingPayload.mainAudioVolume,
        overlays: editingPayload.overlays,
        settings: exportSettings,
      })), 'utf8');
      const outputName = exportOutputName(exportSettings);
      const outputPath = path.join(TEMP_DIR, outputName);
      const renderStartedAt = parseClientStartedAtMs(req.body.client_started_at_ms) || Date.now();
      const serverRenderStartedAt = Date.now();
      const sidecarEvents = await runSidecar([
        'export-video',
        sourceVideoPath,
        outputPath,
        timelineFile,
        TEMP_DIR,
        exportSettings.resolution,
        exportSettings.fps,
      ]);
      /* CHỐT CHẶN: FILE XUẤT RA PHẢI DÀI ĐÚNG BẰNG TIMELINE.
       *
       * ffmpeg có thể kết thúc với mã 0 mà vẫn NUỐT MẤT phần cuối phim: chỉ cần nguồn đổi
       * thông số giữa chừng (khổ hình, pix_fmt...) là đồ thị filter bị dựng lại ngay tại chỗ
       * đó và bộ lọc `concat` gãy theo — người dùng nhận về một file "xuất thành công" chỉ
       * có đoạn đầu, không một lời cảnh báo nào (báo cáo 2026-09-09: timeline 71,7s ra file
       * 21,2s). Nguyên nhân cụ thể đó đã được sửa ở khâu chuẩn hoá (xem concatTargetSize),
       * nhưng cả LỚP lỗi này thì không thể chặn từ đó — nên đo lại ngay tại đây.
       *
       * Ngưỡng rộng tay (nửa giây hoặc 2%) vì lưới khung và phần đệm của bộ mã hoá luôn làm
       * lệch vài khung; chỉ báo lỗi khi THIẾU, dài hơn thì không có gì để mất. */
      const expectedDuration = timelineDurationFromIntervals(exportIntervals);
      const actualDuration = mediaDurationSeconds(outputPath);
      const allowedShortfall = Math.max(0.5, expectedDuration * 0.02);
      if (Number.isFinite(actualDuration) && expectedDuration > 0
        && actualDuration < expectedDuration - allowedShortfall) {
        throw new Error(
          `Video xuất ra bị thiếu: chỉ dài ${actualDuration.toFixed(2)}s trong khi timeline là `
          + `${expectedDuration.toFixed(2)}s. Nhiều khả năng các video nguồn khác thông số nhau `
          + 'nên bản nối bị đứt giữa chừng — hãy thử "Dự án mới" rồi thêm lại video, hoặc báo lỗi kèm tệp .crab.',
        );
      }
      const encoderEvent = sidecarEvents.find((evt) => String(evt?.message || '').startsWith('Export encoder:'));
      projectMetrics.export = {
        ...exportSettings,
        encoder: encoderEvent ? String(encoderEvent.message).replace(/^Export encoder:\s*/, '') : null,
        sequence: jsonSafe(sequenceSettings),
        interval_count: exportIntervals.length,
        overlay_count: editingPayload.overlays.length,
        duration_ms: Math.max(0, Date.now() - renderStartedAt),
        server_duration_ms: Math.max(0, Date.now() - serverRenderStartedAt),
        output_path: outputPath,
        ended_at: new Date().toISOString(),
      };
      projectMetrics.activity = true;
      const reportPath = await writeProjectReport('export_success');
      setStatus('Đã hoàn tất cắt dựng video.');
      res.setHeader('X-Project-Report-Path', reportPath);
      res.download(outputPath, outputName);
    } catch (error) {
      recordProjectError('export', error, { endpoint: '/api/export-video', exportSettings: exportSettingsForError });
      setStatus('Lỗi khi xuất video hoàn chỉnh!');
      httpError(res, 500, error);
    } finally {
      // Khung đã materialize thì đã được RENAME đi; đây là dọn phần còn sót (chuỗi bị bỏ).
      cleanupTransitionFrameUploads();
    }
  });

  return app;
}

function start() {
  cleanGeneratedTextAssets(); // dọn PNG sequence hoạt ảnh còn sót từ phiên trước
  prunePeaksCache();          // dọn cache sóng âm quá hạn + file .tmp/.raw của job bị kill
  pruneConcatCache();         // dọn bản đã nối quá hạn (mỗi mục là một file vài trăm MB)
  pruneAssetProxyCache();     // dọn proxy LQ quá hạn + file .part.mp4 của job bị kill
  const app = createApp();
  const server = http.createServer(app);
  httpServer = server;
  server.listen(PORT, HOST, () => {
    setStatus('Hệ thống đang chuẩn bị...');
    console.log(`[backend] listening on http://${HOST}:${PORT}`);
  });
  return server;
}

if (require.main === module) {
  start();
}

function killActiveChildren(signal = 'SIGTERM') {
  for (const child of Array.from(activeChildProcesses)) {
    if (!child || child.exitCode !== null || child.killed) {
      activeChildProcesses.delete(child);
      continue;
    }
    try {
      child.kill(signal);
    } catch (_) {
      activeChildProcesses.delete(child);
    }
  }
}

async function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  setStatus('Đang tắt backend và dọn tiến trình nền...');
  cleanGeneratedTextAssets(); // dọn PNG sequence hoạt ảnh của phiên hiện tại
  killActiveChildren('SIGTERM');
  const closeServer = httpServer
    ? new Promise((resolve) => httpServer.close(resolve))
    : Promise.resolve();
  await Promise.race([
    closeServer,
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (activeChildProcesses.size > 0) {
    killActiveChildren('SIGKILL');
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

if (require.main === module) {
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(() => process.exit(143));
  });
}

// normalizeColorAdjustFields xuất ra để TEST được trực tiếp: nó là nơi chuỗi filter màu bị
// cắt/ghép (chỗ trống lut3d, tách 2 nửa cho đường pha cường độ LUT), mà đi qua HTTP thì phải
// gọi /api/reset-project — API đó XOÁ SẠCH temp_uploads nên không chạy được ngoài worktree.
// `normalizeEditingPayload` xuất ra để test được HỢP ĐỒNG payload mà không phải dựng cả
// một lượt render (xem tests/scripts/retouch_export_pipeline.js).
module.exports = {
  createApp, start, normalizeColorAdjustFields, normalizeVideoMaskFields, normalizeEditingPayload,
  // Xuất ra để test kiểm được cổng an toàn của /api/retouch/track mà không phải chạy
  // MediaPipe: đường "cho phép" nếu kiểm qua HTTP là sẽ khởi động sidecar thật.
  resolveRetouchSource,
  // Xuất ra để test kiểm THỨ TỰ NỐI mà không phải chạy ffmpeg: đi qua /api/project/reingest
  // là kéo theo cả chép file + concat + peaks + proxy, không đo được riêng phần thứ tự.
  collectVideosFromSourcePaths,
  // Xuất ra để test khoá phép LẤY MỐC TỪNG TỪ của tính năng sắp xếp theo kịch bản: đi qua
  // HTTP là kéo theo cả bóc băng thật. Ba hàm này thuần, mà sai thì SAI IM LẶNG — luật
  // "lấy theo điểm giữa của từ" phải trùng buildSplitTimelineItems ở renderer, còn cổng
  // sessionWordsCoverBlocks là thứ quyết định có bóc băng lại hay không.
  flattenSessionWords, sliceWordsByBlocks, sessionWordsCoverBlocks,
};
