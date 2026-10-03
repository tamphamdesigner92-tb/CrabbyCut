// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

#include <cstdlib>
#include <algorithm>
#include <chrono>
#include <clocale>
#include <cstdint>
#include <cstdio>
#include <cmath>
#include <cstring>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <iomanip>
#include <iostream>
#include <map>
#include <numeric>
#include <regex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
/* NOMINMAX PHẢI ĐẶT TRƯỚC <windows.h>. Không có nó, windows.h định nghĩa `min`/`max` thành
 * MACRO, và mọi `std::min(a, b)` trong tệp này biến thành `std::(a, b)` — lỗi cú pháp ở
 * những dòng chẳng liên quan gì tới Windows (đã đo: 11 lỗi biên dịch rải từ dòng 2406 tới
 * 2752). WIN32_LEAN_AND_MEAN cắt bớt phần lớn header con không dùng tới. */
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
// CommandLineToArgvW — xem khối "ĐƯỜNG DẪN CÓ DẤU" ngay trước main().
#include <shellapi.h>
#ifdef _MSC_VER
/* scripts/build_sidecar.js gọi `cl` trần, không truyền thư viện nào. Không có dòng này thì
 * link hỏng với LNK2019 __imp_CommandLineToArgvW. (MinGW tự link shell32.) */
#pragma comment(lib, "shell32.lib")
#endif
#else
#include <sys/wait.h>
#endif

namespace fs = std::filesystem;

namespace {

std::string EscapeJson(const std::string& text) {
  std::string out;
  for (char ch : text) {
    switch (ch) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out.push_back(ch); break;
    }
  }
  return out;
}

void Emit(const std::string& type, const std::string& message, int code = 0, const std::string& path = "") {
  std::cout << "{\"type\":\"" << EscapeJson(type) << "\",\"message\":\"" << EscapeJson(message) << "\"";
  if (code != 0) std::cout << ",\"code\":" << code;
  if (!path.empty()) std::cout << ",\"path\":\"" << EscapeJson(path) << "\"";
  std::cout << "}" << std::endl;
}

std::string QuoteArg(const std::string& arg) {
#ifdef _WIN32
  std::string out = "\"";
  for (char ch : arg) {
    if (ch == '"') out += "\\\"";
    else out.push_back(ch);
  }
  out += "\"";
  return out;
#else
  std::string out = "'";
  for (char ch : arg) {
    if (ch == '\'') out += "'\\''";
    else out.push_back(ch);
  }
  out += "'";
  return out;
#endif
}

std::string CommandLine(const std::vector<std::string>& args) {
  std::ostringstream cmd;
  for (size_t i = 0; i < args.size(); i++) {
    if (i > 0) cmd << " ";
    cmd << QuoteArg(args[i]);
  }
  return cmd.str();
}

/* ĐƯỜNG DẪN NẰM BÊN TRONG FILTERGRAPH (`lut3d=file='…'`, `movie='…'`) — KHÁC hẳn
 * đường dẫn đi qua `-i` (chỗ đó chỉ là tham số dòng lệnh, không cần gì). Bộ phân tích
 * filtergraph cắt tham số theo dấu `:`, và dấu nháy đơn KHÔNG che được `:` của Ổ ĐĨA trên
 * Windows: `lut3d=file='C:/a/b.cube':interp=trilinear` -> "No option name near
 * '/a/b.cube:interp=…'" -> mọi LUT màu và mặt nạ ảnh chết. Phải ESCAPE `:` thành `\:`
 * NGAY TRONG cặp nháy đơn. Đổi `\\` thành `/` trước (ffmpeg nhận `/` trên Windows) để
 * không phải escape gấp đôi. */
std::string FilterPath(const std::string& path) {
  std::string out;
  out.reserve(path.size() + 8);
  for (char ch : path) {
    if (ch == '\\') out.push_back('/');
    else if (ch == ':') out += "\\:";
    /* Nháy đơn thì BỎ HẲN, không escape: bên trong một đoạn đã nháy đơn, ffmpeg
     * KHÔNG hiểu `\'` — nó đóng đoạn nháy luôn. Cùng cách xử lý với filterPath()
     * ở static/js/color-adjust.js (tên tệp có nháy đơn là ngoại lệ cực hiếm; thà
     * mở sai tên và báo lỗi rõ ràng còn hơn làm vỡ cả filtergraph). */
    else if (ch == '\'') continue;
    else out.push_back(ch);
  }
  return out;
}

/* WINDOWS: `std::system`/`_popen` chạy qua `cmd.exe /c <chuỗi>`, mà cmd.exe có luật riêng
 * (xem `cmd /?`): nếu chuỗi BẮT ĐẦU bằng dấu ngoặc kép và có NHIỀU HƠN hai dấu ngoặc kép,
 * nó XOÁ ký tự đầu và ký tự cuối rồi mới phân tích. Chuỗi của ta luôn là
 * `"ffmpeg.exe" "-i" "a.mp4" …` (nhiều ngoặc kép) nên bị bóp thành
 * `ffmpeg.exe" "-i" "a.mp4` -> "The filename, directory name, or volume label syntax is
 * incorrect." và MỌI lệnh ffmpeg (export/peaks/thumbnail) chết trên Windows.
 * Cách chốt: BỌC THÊM một cấp ngoặc kép bên ngoài — cmd.exe xoá đúng cấp vừa thêm, phần
 * bên trong còn nguyên vẹn. Không dùng được trên POSIX (shell coi `"` là ký tự thường). */
std::string ShellCommandLine(const std::string& commandLine) {
#ifdef _WIN32
  return "\"" + commandLine + "\"";
#else
  return commandLine;
#endif
}

/* ===== CHẠY MỘT LỆNH — VÌ SAO KHÔNG DÙNG std::system() TRÊN WINDOWS =============
 *
 * `std::system()` trên Windows chạy qua `cmd.exe /c "…"`, mà cmd.exe có TRẦN 8.191 KÝ TỰ
 * cho cả dòng lệnh. CreateProcess thì cho tới 32.767. Khoảng cách 4 lần đó là ranh giới
 * giữa "export chạy" và "export chết".
 *
 * ĐÃ TRẢ GIÁ (2026-09-14, dự án thật 131 phụ đề): mỗi overlay ảnh là một
 * `-loop 1 -t <d> -i "<đường dẫn tuyệt đối ~98 ký tự>"` trên dòng lệnh, và khi có overlay
 * thì export KHÔNG chia batch (xem CommandExportVideo) nên tất cả nằm trên MỘT lệnh:
 *     131 × ~125 ký tự ≈ 16.400  ->  vượt 8.191 của cmd.exe
 * cmd.exe trả về "The command line is too long." và người dùng chỉ thấy toast
 * "ffmpeg batch export failed". Ngưỡng gãy rơi vào khoảng 65 overlay — tức là một video
 * chừng 8 phút có phụ đề tự động là đã chạm.
 *
 * Bỏ cmd.exe còn được thêm một thứ: dòng lệnh không còn đi qua bộ phân tích của shell, nên
 * `&`, `^`, `%`, `!` trong tên tệp của người dùng không bị diễn giải thành cú pháp shell.
 *
 * CÒN LƯỚI AN TOÀN: CreateProcessW tìm chương trình theo PATH nhưng KHÔNG áp dụng PATHEXT
 * như cmd.exe (nó chỉ thêm ".exe"). Máy nào cài ffmpeg dưới dạng `.cmd`/`.bat` shim thì
 * CreateProcessW không khởi chạy được — lúc đó rơi về `std::system()` như cũ. Rơi về chỉ
 * xảy ra khi KHÔNG KHỞI CHẠY ĐƯỢC, không phải khi lệnh chạy rồi trả mã lỗi. */
#ifdef _WIN32
// Trần thật của CreateProcessW là 32.767 ký tự KỂ CẢ ký tự kết thúc chuỗi.
constexpr size_t kWindowsCommandLineLimit = 32766;

std::wstring WidenForProcess(const std::string& text) {
  if (text.empty()) return std::wstring();
  const int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
  if (size <= 0) return std::wstring();
  std::wstring out(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), size);
  return out;
}
#endif

#ifdef _WIN32
/* Khởi chạy một tiến trình KHÔNG chờ (lượt xuất song song, mục 1.8) — trả handle tiến trình, hoặc
 * nullptr: `immediateCode` = 7 khi dòng lệnh vượt trần của Windows (đã báo lỗi), 0 khi
 * CreateProcessW hỏng (RunIn lùi về std::system như trước). */
HANDLE SpawnIn(const std::vector<std::string>& args, const fs::path& workingDir, int& immediateCode) {
  immediateCode = 0;
  const std::string line = CommandLine(args);
  if (line.size() > kWindowsCommandLineLimit) {
    /* Vượt cả trần của CreateProcess. Nói THẲNG ra nguyên nhân: rơi về std::system() ở đây
     * chỉ đổi một thông báo khó hiểu này lấy một thông báo khó hiểu khác. */
    Emit("error", "Dòng lệnh ffmpeg dài " + std::to_string(line.size())
                  + " ký tự, vượt trần " + std::to_string(kWindowsCommandLineLimit)
                  + " của Windows. Dự án có quá nhiều lớp phủ (phụ đề/ảnh) cho một lượt render.", 7);
    immediateCode = 7;
    return nullptr;
  }
  std::wstring wide = WidenForProcess(line);
  if (wide.empty()) return nullptr;
  // CreateProcessW ĐƯỢC PHÉP sửa tại chỗ bộ đệm dòng lệnh -> phải là bộ đệm ghi được.
  std::vector<wchar_t> buffer(wide.begin(), wide.end());
  buffer.push_back(L'\0');
  const std::wstring wideDir = workingDir.empty() ? std::wstring() : WidenForProcess(workingDir.string());
  STARTUPINFOW si;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi;
  ZeroMemory(&pi, sizeof(pi));
  if (!CreateProcessW(nullptr, buffer.data(), nullptr, nullptr, TRUE, 0, nullptr,
                      wideDir.empty() ? nullptr : wideDir.c_str(), &si, &pi)) {
    return nullptr;
  }
  CloseHandle(pi.hThread);
  return pi.hProcess;
}
#endif

int RunIn(const std::vector<std::string>& args, const fs::path& workingDir) {
  const std::string line = CommandLine(args);
#ifdef _WIN32
  int immediateCode = 0;
  if (HANDLE process = SpawnIn(args, workingDir, immediateCode)) {
    WaitForSingleObject(process, INFINITE);
    DWORD exitCode = 1;
    GetExitCodeProcess(process, &exitCode);
    CloseHandle(process);
    return static_cast<int>(exitCode);
  }
  if (immediateCode != 0) return immediateCode;
#endif
  const int status = std::system(ShellCommandLine(line).c_str());
#ifdef _WIN32
  return status;
#else
  if (status == -1) return 1;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return status;
#endif
}

int Run(const std::vector<std::string>& args) {
  return RunIn(args, fs::path());
}

/* Chạy một lệnh dò, BỎ HẾT đầu ra, trả mã thoát (dò GPU/NVDEC của mục 1.21: chỉ cần biết chạy
 * được hay không — CommandOutput không trả mã thoát, mà ffmpeg sập thì không in gì). Quá
 * `timeoutMs` (driver treo) thì giết tiến trình và coi như hỏng. */
int RunQuiet(const std::vector<std::string>& args, unsigned timeoutMs = 20000) {
#ifdef _WIN32
  const std::wstring wide = WidenForProcess(CommandLine(args));
  if (wide.empty()) return -1;
  std::vector<wchar_t> buffer(wide.begin(), wide.end());
  buffer.push_back(L'\0');
  SECURITY_ATTRIBUTES sa;
  ZeroMemory(&sa, sizeof(sa));
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                           OPEN_EXISTING, 0, nullptr);
  STARTUPINFOW si;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  if (nul != INVALID_HANDLE_VALUE) {
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = nul;
    si.hStdOutput = nul;
    si.hStdError = nul;
  }
  PROCESS_INFORMATION pi;
  ZeroMemory(&pi, sizeof(pi));
  const BOOL started = CreateProcessW(nullptr, buffer.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                                      nullptr, nullptr, &si, &pi);
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
  if (!started) return -1;
  CloseHandle(pi.hThread);
  if (WaitForSingleObject(pi.hProcess, timeoutMs) != WAIT_OBJECT_0) {
    TerminateProcess(pi.hProcess, 1);
    WaitForSingleObject(pi.hProcess, 2000);
    CloseHandle(pi.hProcess);
    return -1;
  }
  DWORD exitCode = 1;
  GetExitCodeProcess(pi.hProcess, &exitCode);
  CloseHandle(pi.hProcess);
  return static_cast<int>(exitCode);
#else
  (void)timeoutMs;
  const int status = std::system((CommandLine(args) + " >/dev/null 2>&1").c_str());
  if (status == -1) return -1;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 1;
#endif
}

std::string CommandOutput(const std::vector<std::string>& args) {
  const std::string cmd = ShellCommandLine(CommandLine(args) + " 2>&1");
#ifdef _WIN32
  FILE* pipe = _popen(cmd.c_str(), "r");
#else
  FILE* pipe = popen(cmd.c_str(), "r");
#endif
  if (!pipe) return "";
  std::string output;
  char buffer[4096];
  while (fgets(buffer, sizeof(buffer), pipe)) {
    output += buffer;
  }
#ifdef _WIN32
  _pclose(pipe);
#else
  pclose(pipe);
#endif
  return output;
}

std::string ConcatListPathEscape(const std::string& path) {
  std::string out;
  for (char ch : path) {
    if (ch == '\'') out += "'\\''";
    else out.push_back(ch);
  }
  return out;
}

bool WriteConcatList(const fs::path& listPath, const std::vector<std::string>& files) {
  std::ofstream out(listPath);
  if (!out) return false;
  for (const auto& file : files) {
    out << "file '" << ConcatListPathEscape(fs::absolute(file).string()) << "'\n";
  }
  return true;
}

std::string AudioFilterForMode(const std::string& mode) {
  if (mode == "fast") return "highpass=f=200,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11";
  if (mode == "hq") return "highpass=f=120,lowpass=f=7500,afftdn=nf=-28,anlmdn=s=0.0003,dynaudnorm=f=250:g=15,loudnorm=I=-18:TP=-1.5:LRA=11";
  return "highpass=f=80,lowpass=f=7600,afftdn=nf=-22,anlmdn=s=0.0002,dynaudnorm=f=250:g=12,loudnorm=I=-16:TP=-1:LRA=11";
}

/* ---------------------------------------------------------------------------
 * TỐC ĐỘ BLOCK — chuỗi filter audio giữ (hoặc không giữ) cao độ.
 *
 * BẪY: `atempo` của FFmpeg CHỈ nhận 0.5 <= tempo <= 2.0. Ngoài dải đó phải NỐI CHUỖI
 * nhiều tầng cho tích bằng đúng tốc độ mong muốn (4.0x -> atempo=2,atempo=2;
 * 0.25x -> atempo=0.5,atempo=0.5). Truyền thẳng atempo=4.0 thì FFmpeg từ chối cả
 * filter graph và bản xuất hỏng, không phải chỉ sai tiếng.
 * ------------------------------------------------------------------------- */
std::string FormatFilterNumber(double value) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(6) << value;
  std::string text = out.str();
  // Bỏ số 0 thừa cho chuỗi filter dễ đọc khi soi log.
  const size_t dot = text.find('.');
  if (dot != std::string::npos) {
    size_t last = text.find_last_not_of('0');
    if (last == dot) last = dot - 1;
    text.erase(last + 1);
  }
  return text;
}

std::string BuildAtempoFilter(double rate) {
  if (!(rate > 0.0) || std::abs(rate - 1.0) < 1e-4) return "";
  std::string result;
  double remaining = rate;
  const auto append = [&result](const std::string& part) {
    if (!result.empty()) result += ",";
    result += part;
  };
  while (remaining > 2.0) { append("atempo=2.0"); remaining /= 2.0; }
  while (remaining < 0.5) { append("atempo=0.5"); remaining /= 0.5; }
  append("atempo=" + FormatFilterNumber(remaining));
  return result;
}

/* Không giữ cao độ = kéo dãn kiểu "băng cassette": đổi luôn tần số lấy mẫu rồi đưa về
 * lại 48k. `aresample` bắt buộc, nếu không sample rate của nhánh này khác các nhánh
 * khác và `concat`/`amix` từ chối ghép. */
std::string BuildSpeedAudioFilter(double rate, bool pitchCorrect) {
  if (!(rate > 0.0) || std::abs(rate - 1.0) < 1e-4) return "";
  if (pitchCorrect) return BuildAtempoFilter(rate);
  std::ostringstream out;
  out << "asetrate=48000*" << FormatFilterNumber(rate) << ",aresample=48000";
  return out.str();
}

/* =====================================================================
 * FILE NỐI PHẢI BẮT ĐẦU Ở PTS 0 — HỢP ĐỒNG VỚI TOÀN BỘ PHẦN CÒN LẠI CỦA APP
 *
 * `concatSegmentTable` (backend) dựng bảng đoạn bằng cách CỘNG DỒN thời lượng các nguồn,
 * tức mốc của mọi block là giờ 0-BASED. Nhưng concat demuxer + `-c copy` sinh ra một file
 * mà LUỒNG HÌNH bắt đầu ở PTS > 0, còn luồng tiếng vẫn ở 0.
 *
 * ĐO THẬT (2026-09-09, dự án `Test_lech fps_ver 2.crab`, 2 nguồn đã chuẩn hoá — mỗi nguồn
 * TỰ NÓ đều start_time = 0 ở cả hình lẫn tiếng):
 *     temp_input.mp4   video start_pts = 1260 (=0.021s @1/60000),  audio start_pts = 0
 * 0.021s = 1.26 khung ở 59.94fps, và nó phá HAI chỗ cùng lúc:
 *
 *   1. XUẤT VIDEO. `trim=start=5.538867` (mốc block 2) nhả ra khung PTS 5.543183 — KHUNG
 *      CUỐI CỦA CẢNH TRƯỚC, vì 6.mp4 mới bắt đầu ở PTS 5.559867. Block 2 vẽ khung đó bằng
 *      hình học của CHÍNH NÓ -> file xuất có 1 khung "ảnh cảnh trước, khổ cảnh sau" tại MỖI
 *      điểm nối. Đã thấy ở cả bản 30fps (khung 166) và 59.94fps (khung 332).
 *
 *   2. PREVIEW. Chromium KHÔNG bỏ mốc lệch này đi — nó CỘNG vào timeline của thẻ <video>:
 *      đo được `duration` = 43.626917 + 0.021. Nên `video.currentTime = 5.538867` (đầu block
 *      2) vẫn hiện khung cuối của cảnh trước, trong khi hình học đã là của block 2.
 *      Bản proxy LQ lại thừa hưởng một mốc lệch KHÁC (0.016) -> LQ và HQ đổi cảnh ở hai
 *      thời điểm cách nhau đúng một khung. Đo trong Chromium: ở ct=5.55555 thì LQ đã sang
 *      6.mp4 còn HQ vẫn còn DJI.
 *      VÌ SAO LỖI CHỈ LỘ Ở FPS CAO. Mốc block là 5.538867 (giờ 0-based) nhưng ảnh chỉ đổi ở
 *      currentTime 5.559867 (= mốc + 0.021). CỬA SỔ LỆCH vì thế rộng đúng 0.021s: playhead
 *      rơi vào (5.538867, 5.559867) là hình học đã sang block sau mà ảnh còn của block
 *      trước. Playhead thì bám LƯỚI KHUNG CỦA SEQUENCE (roundTimeToFrame):
 *        - 30fps    : lưới cách nhau 0.0333s, RỘNG HƠN cửa sổ 0.021s — và hai mốc kề nó
 *                     (5.5333 và 5.5667) nằm HAI BÊN cửa sổ. Không mốc nào lọt vào -> sạch.
 *        - 59.94fps : lưới cách nhau 0.0167s, HẸP HƠN cửa sổ -> luôn có mốc lọt vào
 *                     (5.5389 và 5.5556 đều nằm trong) -> lộ lỗi.
 *      Đúng như người dùng báo: 30fps preview sạch, 59.94 preview lỗi.
 *
 * CÁCH SỬA: chuẩn hoá NGAY TẠI ĐÂY, chứ không đi bù mốc lệch ở từng nơi tiêu thụ. Bù ở nơi
 * tiêu thụ là phải sửa cả đường xuất LẪN toàn bộ phần quy đổi thời gian của renderer, mà
 * renderer còn phải biết đang nạp LQ hay HQ vì hai file lệch khác nhau — đúng loại state
 * song song sinh lỗi lệch pha. Chốt một HỢP ĐỒNG duy nhất "file nối bắt đầu ở 0" thì mọi
 * phía sau (bảng đoạn, trim khi xuất, currentTime của <video>, proxy) tự khớp.
 *
 * CHỈ DỊCH LUỒNG HÌNH, giữ nguyên luồng tiếng: trước khi nối, mỗi bản chuẩn hoá đều có
 * hình và tiếng CÙNG bắt đầu ở 0, nên 0.021 kia là lệch tiếng-hình do chính bước nối tạo
 * ra. Dịch hình về 0 là TRẢ LẠI đúng đồng bộ ban đầu, không phải phá nó. Đã đo: sau khi
 * dịch, luồng tiếng giữ nguyên 2045 gói / duration 43.640208 y như trước.
 *
 * Đây là remux `-c copy` nên không mã hoá lại gì, và chỉ chạy khi mốc lệch KHÁC 0.
 * ĐÃ KIỂM sau khi sửa: proxy dựng từ bản đã chuẩn hoá tự ra start_time = 0 (mốc lệch của
 * proxy vốn là thừa hưởng, không phải do nó sinh ra) -> không cần xử lý riêng cho proxy.
 * ================================================================== */
/* Định nghĩa thật nằm dưới, cạnh các hàm dò media / định dạng số khác; khai trước để hàm
 * này (ở trên chúng trong file) gọi được mà không phải xáo trộn thứ tự — cùng khuôn với
 * khai báo trước của HasFfmpegFilter bên dưới. */
double MediaStreamStartTime(const std::string& input, const std::string& streamSpec);
std::string FixedSeconds(double value);

bool RestampVideoStartToZero(const std::string& path) {
  const double videoStart = MediaStreamStartTime(path, "v:0");
  // Dưới nửa millisecond thì coi như đã ở 0: remux thêm một lượt chẳng đổi được gì.
  if (!(videoStart > 0.0005)) return true;
  const fs::path target(path);
  const fs::path tmp = target.parent_path() / (target.stem().string() + ".restamp.mp4");
  Emit("progress", "Chuẩn hoá mốc thời gian file nối (hình lệch +"
                   + FixedSeconds(videoStart) + "s)...");
  /* HAI LẦN CÙNG MỘT INPUT: chỉ input thứ nhất bị `-itsoffset` nên chỉ luồng HÌNH bị dịch,
   * còn tiếng lấy từ input thứ hai (không dịch). `-output_ts_offset` không dùng được ở đây
   * vì nó dịch CẢ HAI luồng, tức lại kéo tiếng lệch đi đúng chừng ấy.
   * `-map 1:a:0?` có dấu `?`: dự án mà KHÔNG nguồn nào có tiếng thì file nối không có luồng
   * tiếng nào, thiếu dấu này là lệnh chết. `-dn -sn` bỏ luồng data/timecode — đường xuất chỉ
   * đọc [0:v] và [0:a], mà một track tmcd còn mang theo mốc cũ thì chỉ gây nhiễu. */
  const int code = Run({
    "ffmpeg", "-y", "-v", "error", "-nostdin",
    "-itsoffset", "-" + FixedSeconds(videoStart), "-i", path,
    "-i", path,
    "-map", "0:v:0", "-map", "1:a:0?",
    "-c", "copy", "-dn", "-sn",
    "-movflags", "+faststart",
    tmp.string(),
  });
  if (code != 0) {
    // KHÔNG coi là lỗi chết: file nối vẫn dùng được, chỉ là điểm nối lệch một khung như
    // trước bản sửa. Thà vậy còn hơn chặn cả lượt nhập dự án.
    Emit("progress", "Không chuẩn hoá được mốc thời gian file nối — vẫn dùng bản vừa nối.");
    std::error_code ec;
    fs::remove(tmp, ec);
    return false;
  }
  std::error_code ec;
  fs::remove(target, ec);
  fs::rename(tmp, target, ec);
  if (ec) {
    Emit("progress", "Không thay được file nối đã chuẩn hoá mốc thời gian.");
    fs::remove(tmp, ec);
    return false;
  }
  return true;
}

int CommandConcat(int argc, char** argv) {
  if (argc < 4) {
    Emit("error", "concat expects output and at least one input", 2);
    return 2;
  }
  const std::string output = argv[2];
  std::vector<std::string> inputs;
  for (int i = 3; i < argc; i++) inputs.emplace_back(argv[i]);
  fs::create_directories(fs::path(output).parent_path());
  fs::path listPath = fs::path(output).parent_path() / "concat_list_native.txt";
  if (!WriteConcatList(listPath, inputs)) {
    Emit("error", "cannot write ffmpeg concat list", 3);
    return 3;
  }
  Emit("progress", "Đang nối các file video lại với nhau...");
  int code = Run({"ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listPath.string(), "-c", "copy", output});
  fs::remove(listPath);
  if (code != 0) {
    Emit("error", "ffmpeg concat failed", code);
    return code;
  }
  // HỢP ĐỒNG "file nối bắt đầu ở PTS 0" — xem khối chú thích của hàm này.
  RestampVideoStartToZero(output);
  Emit("result", "concat complete", 0, output);
  return 0;
}

/* --- THUMBNAIL CỦA NGUỒN HDR PHẢI ĐƯỢC NÉN DẢI SÁNG ---
 *
 * Cùng một gốc lỗi với preview (xem sourceIsHdr trong backend/server.js): trích thẳng một
 * frame từ nguồn HLG/PQ rồi lưu JPEG là chép nguyên tín hiệu HDR vào một ảnh SDR — thẻ trong
 * panh "Tệp phương tiện" sáng cháy y như preview trước khi sửa.
 *
 * Ở đây dùng zscale (CPU) chứ không phải libplacebo như đường nhập nguồn: thumbnail chỉ có
 * MỘT frame nên tốc độ không đáng bàn (đo 0,35s so với 0,25s), mà đổi lại là không kéo phụ
 * thuộc Vulkan vào một lệnh chạy hàng trăm lượt khi người dùng cuộn panel.
 *
 * `zscale` cần libzimg. Build ffmpeg nào thiếu nó thì bỏ hẳn khâu tonemap: thumbnail cháy
 * vẫn hơn thumbnail KHÔNG CÓ (bên gọi coi lỗi là "không trích được" và hiện ô giữ chỗ). */
// Định nghĩa thật nằm dưới, cạnh các hàm dò khả năng khác của ffmpeg; khai trước để lệnh
// thumbnail (ở trên chúng trong file này) gọi được mà không phải xáo trộn thứ tự.
bool HasFfmpegFilter(const std::string& filter);

bool SourceIsHdr(const std::string& input) {
  const std::string csv = CommandOutput({
    "ffprobe", "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=color_transfer,color_primaries",
    "-of", "csv=p=0",
    input,
  });
  // HLG (điện thoại quay HDR) và PQ (HDR10/Dolby Vision) đều phải nén dải; bt2020 trơ trọi
  // thì gam rộng vẫn lệch màu trên đường sRGB. Giữ ĐÚNG bộ điều kiện của backend.
  return csv.find("arib-std-b67") != std::string::npos
      || csv.find("smpte2084") != std::string::npos
      || csv.find("bt2020") != std::string::npos;
}

int CommandThumbnail(int argc, char** argv) {
  if (argc < 5) {
    Emit("error", "thumbnail expects input output seek_seconds", 2);
    return 2;
  }
  const std::string input = argv[2];
  const std::string output = argv[3];
  const std::string seek = argv[4];
  fs::create_directories(fs::path(output).parent_path());
  std::string filter = "scale=320:-2";
  if (SourceIsHdr(input) && HasFfmpegFilter("zscale")) {
    filter = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,"
             "zscale=t=bt709:m=bt709:r=tv,format=yuv420p," + filter;
  }
  int code = Run({"ffmpeg", "-y", "-ss", seek, "-i", input, "-frames:v", "1", "-vf", filter, "-q:v", "4", output});
  if (code != 0) {
    Emit("error", "ffmpeg thumbnail failed", code);
    return code;
  }
  Emit("result", "thumbnail complete", 0, output);
  return 0;
}

/* ---------------------------------------------------------------------------
 * audio-peaks: sinh FILE PEAK NHỊ PHÂN (.pk) để timeline vẽ sóng âm THẬT.
 *
 * Thay cho đường cũ (lệnh decode-audio-pcm + addon extractAudioPeaks, ĐÃ BỎ 2026-07-27):
 * đường cũ chỉ cho 3000 peak/toàn video (quá thô khi zoom) và bắt Node nạp toàn bộ
 * PCM (hàng chục MB) vào RAM. Ở đây gom bucket ngay trong C++, đọc raw theo khối,
 * chỉ ghi ra file nhỏ (2 byte/peak) -> Node/JS chỉ việc đọc & vẽ.
 *
 * ĐỘ PHÂN GIẢI: PEAK_RATE_HZ / PEAK_BUCKET_SAMPLES = 24000/32 = 750 peak/giây
 * (≈1.5 KB/giây) — cao hơn zoom tối đa của timeline (~600 px/giây) nên mỗi cột
 * pixel luôn có ít nhất 1 peak thật, không phải nội suy.
 *
 * ĐỊNH DẠNG (little-endian, khớp DataView phía frontend):
 *   header 32B: 'CRWV' | u16 version | u16 headerSize | u32 sampleRate
 *               | u16 bucketSamples | u16 flags (bit0 = KHÔNG có audio)
 *               | f64 duration(giây) | u32 peakCount | u32 reserved
 *   body: peakCount × [u8 peakAbs, u8 rms]   (0..255 = biên độ 0..1 tuyến tính)
 * File luôn ghi ra .tmp rồi rename -> người đọc không bao giờ thấy file dở.
 * ------------------------------------------------------------------------- */
constexpr int PEAK_FORMAT_VERSION = 1;
constexpr int PEAK_HEADER_SIZE = 32;
constexpr int PEAK_RATE_HZ = 24000;
constexpr int PEAK_BUCKET_SAMPLES = 32;

void PutU16(std::vector<unsigned char>& out, size_t offset, uint16_t value) {
  out[offset] = static_cast<unsigned char>(value & 0xFF);
  out[offset + 1] = static_cast<unsigned char>((value >> 8) & 0xFF);
}
void PutU32(std::vector<unsigned char>& out, size_t offset, uint32_t value) {
  for (int i = 0; i < 4; i++) out[offset + i] = static_cast<unsigned char>((value >> (8 * i)) & 0xFF);
}
void PutF64(std::vector<unsigned char>& out, size_t offset, double value) {
  uint64_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  for (int i = 0; i < 8; i++) out[offset + i] = static_cast<unsigned char>((bits >> (8 * i)) & 0xFF);
}

bool WritePeakFile(const fs::path& output, uint16_t flags, double duration,
                   const std::vector<unsigned char>& body) {
  std::vector<unsigned char> header(PEAK_HEADER_SIZE, 0);
  header[0] = 'C'; header[1] = 'R'; header[2] = 'W'; header[3] = 'V';
  PutU16(header, 4, static_cast<uint16_t>(PEAK_FORMAT_VERSION));
  PutU16(header, 6, static_cast<uint16_t>(PEAK_HEADER_SIZE));
  PutU32(header, 8, static_cast<uint32_t>(PEAK_RATE_HZ));
  PutU16(header, 12, static_cast<uint16_t>(PEAK_BUCKET_SAMPLES));
  PutU16(header, 14, flags);
  PutF64(header, 16, duration);
  PutU32(header, 24, static_cast<uint32_t>(body.size() / 2));
  PutU32(header, 28, 0);
  const fs::path tmp = fs::path(output).string() + ".tmp";
  {
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out.write(reinterpret_cast<const char*>(header.data()), static_cast<std::streamsize>(header.size()));
    if (!body.empty()) out.write(reinterpret_cast<const char*>(body.data()), static_cast<std::streamsize>(body.size()));
    if (!out) return false;
  }
  std::error_code ec;
  fs::rename(tmp, output, ec);
  if (ec) {
    fs::remove(output, ec);
    fs::rename(tmp, output, ec);
  }
  return !ec;
}

bool HasAudioStream(const std::string& input) {
  const std::string out = CommandOutput({"ffprobe", "-v", "error", "-select_streams", "a:0",
                                         "-show_entries", "stream=index", "-of", "csv=p=0", input});
  for (char ch : out) {
    if (std::isdigit(static_cast<unsigned char>(ch))) return true;
  }
  return false;
}

int CommandAudioPeaks(int argc, char** argv) {
  if (argc < 4) {
    Emit("error", "audio-peaks expects input output", 2);
    return 2;
  }
  const std::string input = argv[2];
  const fs::path output = argv[3];
  // parent_path() rỗng khi output là tên file tương đối -> create_directories("") ném lỗi.
  if (!output.parent_path().empty()) fs::create_directories(output.parent_path());

  // Không có audio stream -> vẫn ghi file peak RỖNG kèm cờ no_audio (frontend biết
  // để KHÔNG vẽ gì, và không phải hỏi lại server mỗi lần render).
  if (!HasAudioStream(input)) {
    if (!WritePeakFile(output, 0x1, 0.0, {})) {
      Emit("error", "không ghi được file peak (no-audio)", 1);
      return 1;
    }
    Emit("result", "audio-peaks: nguồn không có audio stream", 0, output.string());
    return 0;
  }

  Emit("progress", "Đang phân tích sóng âm...");
  const fs::path rawPath = fs::path(output).string() + ".raw";
  // -loglevel error: job này chạy NGẦM (song song ASR) nên không được spam log ffmpeg.
  const int code = Run({"ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", input,
                        "-vn", "-ac", "1", "-ar", std::to_string(PEAK_RATE_HZ), "-f", "s16le",
                        "-acodec", "pcm_s16le", rawPath.string()});
  std::error_code ec;
  if (code != 0) {
    fs::remove(rawPath, ec);
    Emit("error", "ffmpeg audio decode failed", code);
    return code;
  }

  std::ifstream raw(rawPath, std::ios::binary);
  if (!raw) {
    fs::remove(rawPath, ec);
    Emit("error", "không đọc được PCM tạm", 1);
    return 1;
  }
  std::vector<unsigned char> body;
  {
    const std::uintmax_t rawSize = fs::file_size(rawPath, ec);
    if (!ec) body.reserve(static_cast<size_t>((rawSize / 2 / PEAK_BUCKET_SAMPLES + 2) * 2));
  }
  std::vector<int16_t> chunk(PEAK_BUCKET_SAMPLES * 2048);
  uint64_t totalSamples = 0;
  int bucketFilled = 0;         // số sample đã gom cho bucket đang mở
  int bucketPeak = 0;           // |max| của bucket (đơn vị int16)
  double bucketSquares = 0.0;   // tổng bình phương (để tính RMS)
  const auto flushBucket = [&]() {
    if (bucketFilled <= 0) return;
    const double peak = std::min(1.0, static_cast<double>(bucketPeak) / 32768.0);
    const double rms = std::min(1.0, std::sqrt(bucketSquares / static_cast<double>(bucketFilled)) / 32768.0);
    body.push_back(static_cast<unsigned char>(std::lround(peak * 255.0)));
    body.push_back(static_cast<unsigned char>(std::lround(rms * 255.0)));
    bucketFilled = 0; bucketPeak = 0; bucketSquares = 0.0;
  };
  while (raw) {
    raw.read(reinterpret_cast<char*>(chunk.data()),
             static_cast<std::streamsize>(chunk.size() * sizeof(int16_t)));
    const std::streamsize bytesRead = raw.gcount();
    if (bytesRead <= 0) break;
    const size_t sampleCount = static_cast<size_t>(bytesRead) / sizeof(int16_t);
    for (size_t i = 0; i < sampleCount; i++) {
      const int value = chunk[i];
      const int magnitude = value < 0 ? -value : value;
      if (magnitude > bucketPeak) bucketPeak = magnitude;
      bucketSquares += static_cast<double>(value) * static_cast<double>(value);
      if (++bucketFilled >= PEAK_BUCKET_SAMPLES) flushBucket();
    }
    totalSamples += sampleCount;
  }
  raw.close();
  flushBucket();  // bucket cuối (lẻ) vẫn được ghi -> không mất đuôi sóng
  fs::remove(rawPath, ec);

  const double duration = static_cast<double>(totalSamples) / static_cast<double>(PEAK_RATE_HZ);
  if (!WritePeakFile(output, 0x0, duration, body)) {
    Emit("error", "không ghi được file peak", 1);
    return 1;
  }
  std::ostringstream done;
  done << "audio-peaks xong: " << (body.size() / 2) << " peak / "
       << std::fixed << std::setprecision(2) << duration << "s";
  Emit("result", done.str(), 0, output.string());
  return 0;
}

int CommandPreprocessAudio(int argc, char** argv) {
  if (argc < 5) {
    Emit("error", "preprocess-audio expects input output mode", 2);
    return 2;
  }
  const std::string input = argv[2];
  const std::string output = argv[3];
  const std::string mode = argv[4];
  fs::create_directories(fs::path(output).parent_path());
  Emit("progress", "Đang xử lý âm thanh...");
  int code = Run({"ffmpeg", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-af", AudioFilterForMode(mode), output});
  if (code != 0) {
    Emit("error", "ffmpeg audio preprocess failed", code);
    return code;
  }
  Emit("result", "audio preprocess complete", 0, output);
  return 0;
}

/* LỚP ĐIỀU CHỈNH THỨ k >= 1 khi nhiều lớp XẾP CHỒNG trên cùng một block (2026-09-25).
 * Lớp thứ 0 vẫn nằm ở các field adjustLayer… / adjLayer… cũ của block; các lớp phía TRÊN nó
 * nằm ở đây, theo đúng thứ tự áp (dưới -> trên). Cùng ý nghĩa từng field với lớp 0 — xem
 * ColorAdjustChain. Backend phát chúng thành `adj_layer<k>_*` + `adj_layer_count`
 * (normalizeAdjustLayerFields). Trước đây chỉ có MỘT lớp: lớp dưới của hai lớp chồng nhau
 * (vd. LUT có keyframe cường độ nằm dưới một LUT tĩnh) mất trắng trong bản xuất. */
struct ExtraAdjustLayer {
  std::string filters;
  std::string eqContrastExpr;
  std::string eqBrightnessExpr;
  std::string eqSaturationExpr;
  std::string filtersPost;
  std::string lutAPath;
  std::string lutBPath;
  std::string lutMixExpr;
};

struct ExportInterval {
  int index = 0;
  int scriptIndex = -1;
  double start = 0.0;
  double end = 0.0;
  double positionX = 0.0;
  double positionY = 0.0;
  double scale = 100.0;
  /* HỆ SỐ VỪA KHUNG — "scale 100% = thấy TRỌN ảnh" (theo CapCut), giống hệt preview.
   *
   * Khung của temp_input.mp4 là KHUNG BAO của mọi nguồn, nên một block có thể chỉ chiếm
   * một phần khung (phần còn lại là viền đen ta chèn để nối được). `fitScale` là hệ số quy
   * "pixel khung nối -> pixel sequence" ở scale 100%, do backend tính bằng
   * MainLane.fitScale — CÙNG hàm mà preview dùng, nên xem sao thì xuất ra vậy.
   *
   * TÁCH KHỎI `scale` chứ không nhân sẵn: `scale` là dữ liệu người dùng (hiện trên panel,
   * có thể keyframe), nhân sẵn là ghi số dẫn xuất lên số gốc. Hai số được nhân ở đúng khâu
   * dựng filter, cả nhánh tĩnh lẫn nhánh keyframe/hoạt ảnh.
   * 1.0 = khung nối vẽ theo đúng số pixel của nó (hành vi trước 2026-09-09, và cũng là ca
   * nguồn cùng khổ sequence). */
  double fitScale = 1.0;
  double rotation = 0.0;
  double opacity = 100.0;
  bool flipX = false;
  bool flipY = false;
  double audioVolume = 100.0;
  // KHỬ TIẾNG ỒN: chuỗi filter audio ("highpass=f=90,afftdn=nr=17.6:nf=-28") do backend
  // sinh từ static/js/audio-denoise.js — cùng bảng quy đổi mà preview dùng. Rỗng =
  // không khử ồn. Chèn NGAY SAU atrim và TRƯỚC volume: lọc trên tiếng NHƯ ĐÃ THU, rồi
  // mới tới mức âm lượng người dùng đặt — đảo lại thì kéo Volume là đổi luôn kết quả
  // khử ồn, còn preview thì không (bên đó gain nằm cuối chuỗi Web Audio).
  std::string audioDenoiseFilter;
  /* TỐC ĐỘ BLOCK (xem static/js/clip-speed.js). `speedRate` là hệ số phát: 2.0 = nhanh
   * gấp đôi -> block chiếm NỬA chỗ trên timeline. Mọi phép quy đổi giờ nguồn <-> giờ
   * sequence trong file này đều đi qua nó. `speedPitchCorrect` = giữ cao độ giọng nói
   * (chuỗi atempo) hay cho méo giọng (asetrate). */
  double speedRate = 1.0;
  bool speedPitchCorrect = true;
  // Hoạt ảnh clip lane chính (video): biểu thức FFmpeg theo thời gian; clip render
  // trong segment 0-based nên LOCALT = t (start 0). Rỗng = không có hoạt ảnh.
  std::string animXExpr;
  std::string animYExpr;
  // Thu phóng (HỆ SỐ NHÂN, 1 = nguyên cỡ) + xoay (ĐỘ, cộng thêm) của hoạt ảnh. Rỗng =
  // hiệu ứng không phóng/xoay -> KHÔNG chèn filter tương ứng (xem AppendKfTransformFilters).
  std::string animSxExpr;
  std::string animSyExpr;
  std::string animRotExpr;
  double animInStart = 0.0;
  double animInDur = 0.0;
  double animOutStart = 0.0;
  double animOutDur = 0.0;
  // KEYFRAME: biểu thức FFmpeg theo thời gian (LOCALT), đơn vị native (px / % / độ).
  // Rỗng = field đó không keyframe (dùng transform tĩnh). Áp THAY cho giá trị tĩnh.
  std::string kfXExpr;
  std::string kfYExpr;
  std::string kfScaleExpr;
  std::string kfRotExpr;
  std::string kfOpacityExpr;
  // Keyframe ÂM LƯỢNG: đi vào CHUỖI TIẾNG (filter `volume`), không phải chuỗi hình.
  // Đơn vị GAIN TUYẾN TÍNH (1.0 = 0 dB). Rỗng = dùng audioVolume tĩnh.
  std::string kfVolumeExpr;
  // ĐIỀU CHỈNH MÀU (panel "Điều chỉnh"): chuỗi filter FFmpeg đã ghép sẵn
  // (eq / colorbalance / curves / lut3d) do frontend sinh và backend đã lọc ký tự.
  // Rỗng = không chỉnh màu. Xem AppendColorAdjustFilters.
  std::string adjustFilters;
  // MẶT NẠ: ảnh XÁM (PNG) giới hạn phạm vi chỉnh màu, do frontend bake và backend ghi
  // ra đĩa. Rỗng = chỉnh toàn khung.
  std::string adjustMaskPath;
  // MẶT NẠ CẮT HÌNH của block (tab Video) — KHÁC adjustMaskPath (mặt nạ đó chỉ giới hạn
  // phạm vi chỉnh màu). Xem AppendVideoMaskFilter.
  std::string videoMaskPath;
  // XOÁ LOGO (tab Retouch > Xoá logo): chế độ + các hình chữ nhật PIXEL trên stream nguồn,
  // "x:y:w:h:p|..." do backend dựng lại từ số đã kẹp. Rỗng = không xoá. Xem AppendLogoRemovalFilters.
  std::string logoMode;
  std::string logoRects;
  // XOÁ LOGO BẰNG AI: thư mục một lượt của backend/logo-ai.js (r{k}.ffconcat + miếng vá PNG),
  // vị trí miếng vá "x:y|..." (pixel stream nguồn) và PTS nguồn của khung ĐẦU lượt đó.
  // Có dir thì thay cho logoMode/logoRects. Xem AppendLogoAiFilters.
  std::string logoAiDir;
  std::string logoAiRects;
  double logoAiT0 = 0.0;
  // KEYFRAME thông số màu: biểu thức theo thời gian cho `eq` (token LOCALT). Có giá trị
  // thì chuỗi adjustFilters KHÔNG chứa eq nữa — xem AppendColorAdjustEq.
  std::string adjEqContrastExpr;
  std::string adjEqBrightnessExpr;
  std::string adjEqSaturationExpr;
  // KEYFRAME CƯỜNG ĐỘ LUT: `lut3d` không có tham số trộn và không đổi file được lúc chạy,
  // nên tầng LUT phải tách thành 2 nhánh rồi `blend` pha theo thời gian. Khi có 3 field
  // này thì adjustFilters là nửa TRƯỚC tầng LUT và adjustFiltersPost là nửa SAU.
  // Xem ColorAdjustLutBlend.
  std::string adjustFiltersPost;
  // LỚP ĐIỀU CHỈNH (adjustment layer) — chuỗi màu THỨ HAI, áp SAU chuỗi của chính
  // block và NGOÀI nhánh mặt nạ của nó (mặt nạ là của block, không phải của lớp).
  // Cổng thời gian `enable=` đã do frontend gắn sẵn vào từng filter.
  std::string adjustLayerFilters;
  // Keyframe của LỚP (cùng ý nghĩa với các field adjEq*/adjustLut*/adjustFiltersPost của
  // chuỗi block, nhưng cho chuỗi THỨ HAI). Xem LayerColorChain.
  std::string adjLayerEqContrastExpr;
  std::string adjLayerEqBrightnessExpr;
  std::string adjLayerEqSaturationExpr;
  std::string adjustLayerFiltersPost;
  std::string adjustLayerLutAPath;
  std::string adjustLayerLutBPath;
  std::string adjustLayerLutMixExpr;
  std::vector<ExtraAdjustLayer> extraAdjustLayers;   // lớp 1..n-1, xem ExtraAdjustLayer
  // Video overlay KHÔNG gắn nhãn ma trận màu (xem MediaColorUntagged). Chỉ overlay dùng.
  bool colorUntagged = false;
  std::string adjustLutAPath;
  std::string adjustLutBPath;
  std::string adjustLutMixExpr;
  // SỐ KHUNG mà block này CHIẾM trong bản xuất, chốt trên LƯỚI KHUNG của CẢ timeline
  // (xem BuildTimelineFrameGrid). 0 = chưa tính -> rơi về độ dài theo giây như trước.
  long long renderFrames = 0;
};

struct ExportOverlay {
  int index = 0;
  std::string id;
  std::string type;
  std::string assetType;
  std::string assetPath;
  double timelineStart = 0.0;
  double duration = 0.0;
  double sourceStart = 0.0;
  double positionX = 0.0;
  double positionY = 0.0;
  double scale = 100.0;
  // HỆ SỐ VỪA KHUNG của block media (renderer tính, backend chuyển): "scale 100%" của media overlay
  // = vừa khung như lane chính (xem ExportInterval::fitScale). Ảnh chữ/hình khối, payload cũ: 1.
  double fitScale = 1.0;
  double rotation = 0.0;
  double opacity = 100.0;
  bool flipX = false;
  bool flipY = false;
  double volume = 100.0;
  bool muted = false;
  bool hasAudio = false;
  // KHỬ TIẾNG ỒN (xem ExportInterval::audioDenoiseFilter).
  std::string audioDenoiseFilter;
  // TỐC ĐỘ BLOCK (xem ExportInterval::speedRate). Với overlay, `duration` là thời gian
  // TIMELINE nên độ dài NGUỒN cần lấy = duration × speedRate.
  double speedRate = 1.0;
  bool speedPitchCorrect = true;
  /* LÀM MỀM MÉP (miếng vá Retouch): bề rộng dải chuyển alpha, tính bằng pixel của CHÍNH
   * miếng vá. 0 = mép cứng như cũ. Xem AppendFeatherAlpha để biết vì sao cần. */
  int featherPx = 0;
  std::string text;
  std::string fontFamily = "Inter";
  std::string fontFile;
  int fontSize = 64;
  std::string color = "#ffffff";
  std::string align = "center";
  // Chuỗi frame PNG (asset_type "text_image_seq"): fps + số frame của sequence
  double seqFps = 30.0;
  int frameCount = 0;
  int assetInputIndex = -1;
  // Hoạt ảnh VIDEO overlay (biểu thức FFmpeg theo thời gian; token LOCALT = t - start):
  // dịch chuyển qua overlay x/y, thu phóng qua scale, xoay qua rotate, opacity qua fade.
  // Rỗng = không có hoạt ảnh video (riêng 3 kênh sx/sy/rot: hiệu ứng không dùng kênh đó).
  std::string animXExpr;
  std::string animYExpr;
  std::string animSxExpr;
  std::string animSyExpr;
  std::string animRotExpr;
  double animInStart = 0.0;
  double animInDur = 0.0;
  double animOutStart = 0.0;
  double animOutDur = 0.0;
  // KEYFRAME (xem ExportInterval): biểu thức theo LOCALT, đơn vị native, áp THAY tĩnh.
  std::string kfXExpr;
  std::string kfYExpr;
  std::string kfScaleExpr;
  std::string kfRotExpr;
  std::string kfOpacityExpr;
  // Keyframe ÂM LƯỢNG (xem ExportInterval::kfVolumeExpr).
  std::string kfVolumeExpr;
  // ĐIỀU CHỈNH MÀU (xem ExportInterval::adjustFilters / adjustMaskPath).
  std::string adjustFilters;
  std::string adjustMaskPath;
  // MẶT NẠ CẮT HÌNH của block (tab Video) — KHÁC adjustMaskPath (mặt nạ đó chỉ giới hạn
  // phạm vi chỉnh màu). Xem AppendVideoMaskFilter.
  std::string videoMaskPath;
  // XOÁ LOGO (tab Retouch > Xoá logo): chế độ + các hình chữ nhật PIXEL trên stream nguồn,
  // "x:y:w:h:p|..." do backend dựng lại từ số đã kẹp. Rỗng = không xoá. Xem AppendLogoRemovalFilters.
  std::string logoMode;
  std::string logoRects;
  // XOÁ LOGO BẰNG AI: thư mục một lượt của backend/logo-ai.js (r{k}.ffconcat + miếng vá PNG),
  // vị trí miếng vá "x:y|..." (pixel stream nguồn) và PTS nguồn của khung ĐẦU lượt đó.
  // Có dir thì thay cho logoMode/logoRects. Xem AppendLogoAiFilters.
  std::string logoAiDir;
  std::string logoAiRects;
  double logoAiT0 = 0.0;
  std::string adjEqContrastExpr;
  std::string adjEqBrightnessExpr;
  std::string adjEqSaturationExpr;
  // KEYFRAME CƯỜNG ĐỘ LUT: `lut3d` không có tham số trộn và không đổi file được lúc chạy,
  // nên tầng LUT phải tách thành 2 nhánh rồi `blend` pha theo thời gian. Khi có 3 field
  // này thì adjustFilters là nửa TRƯỚC tầng LUT và adjustFiltersPost là nửa SAU.
  // Xem ColorAdjustLutBlend.
  std::string adjustFiltersPost;
  // LỚP ĐIỀU CHỈNH (adjustment layer) — chuỗi màu THỨ HAI, áp SAU chuỗi của chính
  // block và NGOÀI nhánh mặt nạ của nó (mặt nạ là của block, không phải của lớp).
  // Cổng thời gian `enable=` đã do frontend gắn sẵn vào từng filter.
  std::string adjustLayerFilters;
  // Keyframe của LỚP (cùng ý nghĩa với các field adjEq*/adjustLut*/adjustFiltersPost của
  // chuỗi block, nhưng cho chuỗi THỨ HAI). Xem LayerColorChain.
  std::string adjLayerEqContrastExpr;
  std::string adjLayerEqBrightnessExpr;
  std::string adjLayerEqSaturationExpr;
  std::string adjustLayerFiltersPost;
  std::string adjustLayerLutAPath;
  std::string adjustLayerLutBPath;
  std::string adjustLayerLutMixExpr;
  std::vector<ExtraAdjustLayer> extraAdjustLayers;   // lớp 1..n-1, xem ExtraAdjustLayer
  // Video overlay KHÔNG gắn nhãn ma trận màu (xem MediaColorUntagged). Chỉ overlay dùng.
  bool colorUntagged = false;
  std::string adjustLutAPath;
  std::string adjustLutBPath;
  std::string adjustLutMixExpr;
  // Video lớp phủ giải mã được bằng NVDEC ra thẳng khung CUDA (đồ thị GPU, mục 1.21 — NvdecDecodes).
  bool gpuNvdec = false;
};

struct ExportSettings {
  std::string resolution = "source";
  int width = 0;
  int height = 0;
  std::string fps = "source";
  std::string renderFps = "30";
  std::string codec = "h264";
  std::string quality = "high";
  /* Ô "Bitrate" kiểu CapCut (mục 1.20, người dùng chốt 2026-10-01) — thay ô "Chất lượng".
   *   lower / recommended / higher: CHẤT LƯỢNG CỐ ĐỊNH có TRẦN (NVENC `-cq`, CPU CRF). Trần = bitrate
   *     cố định cũ của Cân bằng / Cao / 2×Cao, nên bản xuất không bao giờ to hơn bản cũ cùng mức;
   *     nguồn dễ nén (phim AV1 2 Mbps) thì nhỏ hẳn đi.
   *   custom: bitrate trung bình người dùng nhập (`rateMbps`), đỉnh ×1,5.
   * Payload cũ không có `rate_mode` thì suy từ `quality` (RateModeFromQuality). */
  std::string rateMode = "recommended";
  double rateMbps = 0.0;
  std::string audioBitrate = "192k";
  double mainAudioVolume = 100.0;
  /* ============ TRỤC THỜI GIAN THẬT CỦA FILE NGUỒN ============
   *
   * `trim`/`atrim` so mốc với PTS THẬT của khung trong đồ hình filter, còn `item.start/end`
   * là giờ TIMELINE (0-based, do concatSegmentTable dựng bằng cách cộng dồn thời lượng các
   * nguồn). Hai trục đó KHÔNG trùng nhau: `temp_input.mp4` do concat demuxer sinh ra có
   * edit list, nên luồng hình bắt đầu ở PTS > 0.
   *
   * ĐO THẬT trên dự án người dùng (2026-09-09, `Test_lech fps_ver 2.crab`):
   *     temp_input.mp4   video start_time = 0.021000   (start_pts 1260 @ 1/60000)
   *                      audio start_time = 0.000000
   *     khung 0 của file  -> PTS 0.021
   *     trim=start=5.538867 -> khung ĐẦU TIÊN ra là PTS 5.543183 = khung 331 = KHUNG CUỐI
   *                            CỦA DJI, trong khi 6.mp4 mới bắt đầu ở PTS 5.559867 (khung 332)
   * Hệ quả: block 2 hút vào ĐÚNG MỘT khung của block trước, và nó được vẽ bằng hình học của
   * block 2 -> file xuất ra có 1 khung "ảnh cảnh trước, khổ cảnh sau" tại MỖI điểm nối.
   * 0.021s = 1.26 khung ở 59.94fps, nên luôn lẻ ra đúng một khung. Đã thấy ở CẢ hai bản
   * xuất của người dùng (30fps: khung 166; 59.94fps: khung 332) — bản 59.94 chỉ khó thấy hơn
   * vì khung lỗi ngắn hơn một nửa.
   *
   * `videoStart`/`audioStart` được đo bằng ffprobe cho TỪNG luồng (ở đây audio = 0 nên
   * không đổi gì; đo riêng để nguồn nào lệch cả hai luồng vẫn đúng).
   * `sourceFps` là nhịp khung của CHÍNH file nguồn — cần vì mốc cắt phải lùi NỬA KHUNG
   * NGUỒN, không phải nửa khung xuất: ở bản xuất 30fps từ nguồn 59.94, nửa khung xuất bằng
   * gần một khung nguồn và sẽ hút thêm khung khác vào. */
  double videoStart = 0.0;
  double audioStart = 0.0;
  double sourceFps = 0.0;
  // Nguồn chính KHÔNG gắn nhãn ma trận màu -> chuỗi clip gắn bt709 trước khi đổi sang RGB.
  // Xem MediaColorUntagged.
  bool sourceColorUntagged = false;
  // Được phép seek vào giữa nguồn chính theo từng batch (xem BatchSeekSeconds/SourceSeekSafe).
  bool seekSafe = false;
  // Đường nhanh YUV cho clip lane chính (mục 1.3, xem MainLaneFastPlan). Đo MỘT lần ở
  // ProbeMainSourceForFastPath: cỡ khung nguồn, ma trận có phải BT.709 không, vị trí mẫu màu.
  bool fastPathSource = false;
  int sourceWidth = 0;
  int sourceHeight = 0;
  int sourceChromaH = 128;   // vị trí mẫu màu, đơn vị 1/256 điểm ảnh luma (như scale in_h_chr_pos)
  int sourceChromaV = 128;
  std::string sourcePixFmt;   // pix_fmt luồng hình nguồn (đồ thị GPU: định dạng tải lên, GpuUploadFormat)
  /* CỠ BẢN XUẤT KHÁC CỠ SEQUENCE (mục 1.12, ô "Độ phân giải" của hộp thoại xuất). Đồ thị vẫn
   * dựng ở cỡ sequence (`width`/`height`); đuôi đồ thị co phần hình về content* rồi đệm đen cho
   * đủ output* (content = output thì không đệm). Backend tính các số này (exportOutputFrame);
   * 0 = xuất đúng cỡ sequence. Xem OutputColorFilters. */
  int outputWidth = 0;
  int outputHeight = 0;
  int contentWidth = 0;
  int contentHeight = 0;
  // Hệ số sequence -> phần hình mà backend dùng để tính content* (0 = payload cũ, không có).
  double outputScale = 0.0;
  // Đồ thị đã dựng ở cỡ phần hình (pha 2, xem ApplyOutputScaleToPayload): `width`/`height` lúc
  // này là content*, đuôi đồ thị chỉ còn đệm đen.
  bool builtAtOutputScale = false;
  /* Thiết bị render (mục 1.21, Cài đặt › Xuất video — người dùng chốt 2026-10-02): "auto" (mặc
   * định = GPU khi máy có GPU dùng được), "gpu", "cpu". Xem GpuRenderWanted. */
  std::string renderDevice = "auto";
};

bool OutputResized(const ExportSettings& settings) {
  return settings.outputWidth > 0 && settings.outputHeight > 0
      && settings.contentWidth > 0 && settings.contentHeight > 0;
}

struct EncoderPlan {
  std::string mode = "cpu";
  std::string videoEncoder;
  bool hardware = false;
};

std::string ReadFileText(const std::string& path) {
  /* Mở qua fs::path chứ KHÔNG qua std::string: ifstream(std::string) đi xuống fopen() của
   * CRT (chuyển mã theo locale), còn ifstream(fs::path) mở bằng API wide của Windows. Tệp
   * timeline JSON nằm trong %LOCALAPPDATA%\CrabbyCut — đường dẫn mang tên người dùng, có
   * dấu là hỏng. Xem khối "ĐƯỜNG DẪN CÓ DẤU" trước main(). */
  // Ngoặc NHỌN: `ifstream in(fs::path(path))` bị C++ đọc thành KHAI BÁO HÀM (most vexing parse).
  std::ifstream in{fs::path(path)};
  std::stringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

bool IsAllowed(const std::string& value, const std::vector<std::string>& allowed) {
  return std::find(allowed.begin(), allowed.end(), value) != allowed.end();
}

std::string FfmpegEncoders() {
  static const std::string encoders = CommandOutput({"ffmpeg", "-hide_banner", "-encoders"});
  return encoders;
}

std::string FfmpegFilters() {
  static const std::string filters = CommandOutput({"ffmpeg", "-hide_banner", "-filters"});
  return filters;
}

bool HasFfmpegEncoder(const std::string& encoder) {
  return FfmpegEncoders().find(encoder) != std::string::npos;
}

bool HasFfmpegFilter(const std::string& filter) {
  return FfmpegFilters().find(filter) != std::string::npos;
}

bool HardwareExportEnabled() {
  const char* env = std::getenv("FFMPEG_EXPORT_HW");
  if (!env) return true;
  std::string value = env;
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return !(value == "0" || value == "false" || value == "off" || value == "cpu");
}

/* ===== ĐỒ THỊ GPU (mục 1.21 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md) =====
 *
 * Bản ffmpeg riêng của CrabbyCut có bộ lọc CUDA `crabgeo_cuda` (cắt + co + đổi màu + đặt vào
 * khung) và `crabblend_cuda` (trộn lớp phủ). Máy có NVENC + bản ffmpeg đó thì batch nào mọi
 * clip/lớp phủ đều có bản GPU (BatchGpuEligible) được dựng thành đồ thị GPU: khung ở trên GPU từ
 * lúc giải mã (NVDEC) hoặc tải lên tới lúc NVENC mã hoá. Batch còn lại đi đồ thị CPU như cũ, trong
 * cùng một lượt xuất (cùng NVENC nên ghép `-c copy` được). Đồ thị GPU lỗi -> chạy lại batch đó
 * bằng đồ thị CPU (RunExportJobs).
 * Người dùng chốt 2026-10-02: Cài đặt › Xuất video "Render bằng: GPU / CPU", mặc định GPU khi máy
 * dùng được — payload mang `render_device` ("auto"/"gpu"/"cpu"). Env CRABBYCUT_EXPORT_GPU=0|1 ép
 * tắt/bật (A/B, test). */
bool GpuRenderWanted(const ExportSettings& settings) {
  if (const char* env = std::getenv("CRABBYCUT_EXPORT_GPU")) {
    const std::string value = env;
    if (value == "0" || value == "false" || value == "off") return false;
    if (value == "1" || value == "true" || value == "on") return true;
  }
  return settings.renderDevice != "cpu";
}

/* ffmpeg có hai bộ lọc CUDA của CrabbyCut VÀ chạy thật được trọn chuỗi tải lên -> crabgeo ->
 * NVENC (máy có thể có bản ffmpeg riêng mà không có GPU NVIDIA, hoặc driver quá cũ). ~0,4 s, chạy
 * song song với các phép dò khác ở đầu lượt xuất. Thử cả `sync=1` (GpuOutputFilters): bản build cũ
 * chưa có tuỳ chọn đó thì coi như không dùng được. */
bool GpuRenderAvailable(const std::string& nvencEncoder) {
  if (!HasFfmpegFilter("crabgeo_cuda") || !HasFfmpegFilter("crabblend_cuda")) return false;
  return RunQuiet({"ffmpeg", "-hide_banner", "-v", "error", "-nostdin",
                   "-init_hw_device", "cuda=cu", "-filter_hw_device", "cu",
                   "-f", "lavfi", "-i", "color=c=black:s=256x256:r=25:d=0.2",
                   "-vf", "format=yuv420p,hwupload,crabgeo_cuda=w=128:h=128:ow=256:oh=256:x=64:y=64:passthrough=0:sync=1",
                   "-c:v", nvencEncoder, "-f", "null", "-"}) == 0;
}

/* DÒ GỘP cho nguồn chính: giải mã hai khung bằng NVDEC -> crabgeo -> NVENC trong MỘT tiến trình.
 * Mỗi lệnh dò tốn ~0,5 s khởi tạo CUDA/NVENC, chạy song song thì tranh nhau (Test.crab: khâu dò
 * 0,4 -> 1,4 s với hai lệnh riêng). Đúng thì vừa "GPU dùng được" vừa "NVDEC giải mã được nguồn";
 * sai thì nơi gọi dò riêng GpuRenderAvailable. Khung ra cố định 640×360 (co ≤ 12 lần với nguồn 8K,
 * đủ lớn cho cỡ tối thiểu của NVENC với nguồn nhỏ).
 * `-xerror` + `-t 2` ở input: NVDEC không giải mã được codec (AV1 trên GTX 10xx) thì bộ giải mã báo
 * lỗi ở TỪNG gói mà ffmpeg vẫn đọc tiếp — trước đây lệnh dò đọc hết nguồn tới khi chạm thời gian chờ
 * 20 s (phim 4K AV1 640 MB: khâu dò 20,8 s). Nay thoát ngay ở lỗi đầu (~0,3 s). */
bool GpuRenderAvailableWithNvdec(const std::string& nvencEncoder, const std::string& source) {
  if (!HasFfmpegFilter("crabgeo_cuda") || !HasFfmpegFilter("crabblend_cuda")) return false;
  return RunQuiet({"ffmpeg", "-hide_banner", "-v", "error", "-nostdin", "-xerror",
                   "-init_hw_device", "cuda=cu", "-filter_hw_device", "cu",
                   "-hwaccel", "cuda", "-hwaccel_device", "cu", "-hwaccel_output_format", "cuda",
                   "-t", "2", "-i", source, "-frames:v", "2", "-an", "-sn", "-dn",
                   "-vf", "crabgeo_cuda=w=640:h=360:passthrough=0:sync=1",
                   "-c:v", nvencEncoder, "-f", "null", "-"}) == 0;
}

/* crabgeo_cuda có LUT 3D (`lut`/`lut2`/`mix`, bản n8.1.1-crabbycut.2 trở đi): clip/lớp phủ chỉ có
 * tầng màu là LUT (lớp Điều chỉnh, HSL + LUT đã bake) đi được đồ thị GPU — xem BlockGpuLut. */
// -1 = chưa biết (dò bằng lệnh); 0/1 = lấy từ cache dò GPU của lượt trước (xem GpuProbeCache).
static int g_gpuLutKnown = -1;

bool GpuLutAvailable() {
  if (g_gpuLutKnown >= 0) return g_gpuLutKnown == 1;
  static const bool has = CommandOutput({"ffmpeg", "-hide_banner", "-h", "filter=crabgeo_cuda"}).find("lut2") != std::string::npos;
  return has;
}

/* KẾT QUẢ DÒ GPU LƯU GIỮA CÁC LẦN XUẤT (mục 1.21). Mỗi lượt xuất là một tiến trình sidecar mới, mà
 * phép dò (khởi tạo CUDA + NVENC, giải mã thử NVDEC nguồn chính và từng video lớp phủ, hỏi crabgeo
 * có LUT) tốn ~0,8 s — Test.crab: khâu dò 0,4 -> 1,2 s khi bật GPU, trên lượt xuất ~11 s. Kết quả
 * lưu ở `<temp dự án>/gpu_probe_cache.txt`, dùng lại khi KHOÁ trùng và chưa quá 3 ngày. Khoá: dấu
 * vân tay bản ffmpeg (FNV-1a của danh sách filter + encoder), tên NVENC, đường dẫn + cỡ + mốc sửa
 * của nguồn và từng video lớp phủ được dò. Driver/GPU đổi mà khoá không đổi: batch GPU lỗi thì
 * RunExportJobs chạy lại bằng đồ thị CPU (như mọi lỗi GPU) và XOÁ cache — lượt sau dò lại. */
struct GpuProbeResult {
  int main = 0;                    // 0 = không dùng được GPU, 1 = GPU được nhưng NVDEC không giải mã được nguồn, 2 = cả hai
  bool lut = false;                // crabgeo_cuda có LUT
  std::vector<bool> overlayNvdec;  // theo thứ tự danh sách video lớp phủ được dò
  bool cached = false;
};

const char* const kGpuProbeCacheName = "gpu_probe_cache.txt";
constexpr long long kGpuProbeCacheMaxAgeSeconds = 3LL * 24 * 3600;

std::uint64_t Fnv1a64(const std::string& text) {
  std::uint64_t h = 1469598103934665603ULL;
  for (unsigned char ch : text) {
    h ^= ch;
    h *= 1099511628211ULL;
  }
  return h;
}

std::string FileStamp(const std::string& path) {
  std::error_code ec;
  const std::uintmax_t size = fs::file_size(path, ec);
  if (ec) return path + "|?";
  const auto mtime = fs::last_write_time(path, ec);
  return path + "|" + std::to_string(size) + "|" + (ec ? std::string("?") : std::to_string(mtime.time_since_epoch().count()));
}

std::string GpuProbeKey(const std::string& nvenc, const std::string& source, const std::vector<std::string>& overlayVideos) {
  std::ostringstream key;
  key << "v1|" << std::hex << Fnv1a64(FfmpegFilters() + "\n" + FfmpegEncoders()) << std::dec << "|" << nvenc
      << "|" << FileStamp(source);
  for (const std::string& path : overlayVideos) key << "|" << FileStamp(path);
  std::string out = key.str();
  std::replace(out.begin(), out.end(), '\n', ' ');
  return out;
}

long long UnixNowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

bool ReadGpuProbeCache(const fs::path& file, const std::string& key, size_t overlayCount, GpuProbeResult& out) {
  std::ifstream in(file);
  if (!in) return false;
  std::string line;
  std::string cachedKey;
  long long time = 0;
  GpuProbeResult r;
  bool haveMain = false;
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const size_t tab = line.find('\t');
    if (tab == std::string::npos) continue;
    const std::string name = line.substr(0, tab);
    const std::string value = line.substr(tab + 1);
    if (name == "key") cachedKey = value;
    else if (name == "time") time = std::atoll(value.c_str());
    else if (name == "main") { r.main = std::atoi(value.c_str()); haveMain = true; }
    else if (name == "lut") r.lut = value == "1";
    else if (name == "ov") r.overlayNvdec.push_back(value == "1");
  }
  const long long age = UnixNowSeconds() - time;
  if (cachedKey != key || !haveMain || r.main < 0 || r.main > 2 || age < 0 || age > kGpuProbeCacheMaxAgeSeconds
      || r.overlayNvdec.size() != overlayCount) return false;
  r.cached = true;
  out = r;
  return true;
}

void WriteGpuProbeCache(const fs::path& file, const std::string& key, const GpuProbeResult& r) {
  std::ofstream outFile(file, std::ios::trunc);
  if (!outFile) return;
  outFile << "key\t" << key << "\n" << "time\t" << UnixNowSeconds() << "\n"
          << "main\t" << r.main << "\n" << "lut\t" << (r.lut ? 1 : 0) << "\n";
  for (bool nvdec : r.overlayNvdec) outFile << "ov\t" << (nvdec ? 1 : 0) << "\n";
}

/* Tệp giải mã được bằng NVDEC ra thẳng khung CUDA. NVDEC không giải mã được (AV1 trên GTX 10xx,
 * H.264 10-bit, 4:2:2…) thì `-hwaccel cuda` lặng lẽ lùi về giải mã CPU, khung ra ở RAM và
 * `crabgeo_cuda` (chỉ nhận khung CUDA) không nối được -> lệnh lỗi. Chỉ thử hai khung đầu. Co một
 * nửa chứ không co về cỡ tí hon: crabgeo chỉ co tối đa ~15 lần (bảng lọc ≤ 64 tap, xem
 * kGpuMinScale) — `w=16` trên nguồn 4K là lỗi của phép thử chứ không phải của NVDEC.
 * `-xerror` + `-t 2`: xem GpuRenderAvailableWithNvdec (codec NVDEC không hỗ trợ -> thoát ngay). */
bool NvdecDecodes(const std::string& path) {
  return RunQuiet({"ffmpeg", "-hide_banner", "-v", "error", "-nostdin", "-xerror",
                   "-init_hw_device", "cuda=cu", "-filter_hw_device", "cu",
                   "-hwaccel", "cuda", "-hwaccel_device", "cu", "-hwaccel_output_format", "cuda",
                   "-t", "2", "-i", path, "-frames:v", "2", "-an", "-sn", "-dn",
                   "-vf", "crabgeo_cuda=w=trunc(iw/4)*2:h=trunc(ih/4)*2", "-f", "null", "-"}) == 0;
}

/* Định dạng tải khung giải mã CPU lên GPU (`format=<…>,hwupload`) cho từng pix_fmt nguồn,
 * trong số định dạng crabgeo_cuda nhận. Rỗng = không có đường rẻ (4:2:2, RGB, có alpha…) -> clip
 * đi đồ thị CPU. 10/12-bit 4:2:0 đổi sang p010 (chỉ dồn lại hai mặt phẳng màu, giữ 10 bit).
 * TẢI LÊN BẰNG `hwupload`, KHÔNG BẰNG `hwupload_cuda` (sửa 2026-10-03): hwupload_cuda bỏ qua
 * -filter_hw_device và TỰ TẠO một ngữ cảnh CUDA mới cho mỗi lần xuất hiện (~0,25 s + bộ nhớ GPU mỗi
 * cái) — mỗi ảnh/chuỗi lớp phủ, mỗi dải đen đệm của clip, nguồn chính đều có một cái. Phim 4K AV1
 * có 48 phụ đề mỗi batch: 48 hwupload_cuda tốn 13,2 s so với 1,3 s bằng hwupload (dùng thiết bị
 * `cu` của lệnh, chung với crabgeo/crabblend/NVENC). */
std::string GpuUploadFormat(const std::string& pixFmt) {
  if (pixFmt == "yuv420p" || pixFmt == "yuvj420p") return "yuv420p";
  if (pixFmt == "nv12") return "nv12";
  if (pixFmt == "yuv420p10le" || pixFmt == "yuv420p12le" || pixFmt == "p010le") return "p010le";
  if (pixFmt == "yuv444p" || pixFmt == "yuvj444p") return "yuv444p";
  return "";
}

/* ---------------------------------------------------------------------------
 * ĐO THỜI GIAN EXPORT — Bước 0.1 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md.
 *
 * LUÔN BẬT, gần như không tốn gì: mỗi lượt ffmpeg của ExportBatch được bấm giờ, và cuối lượt
 * export sidecar phát một sự kiện `timing` (JSON nằm trong `message`) để backend ghi vào báo
 * cáo dự án. Trước đây báo cáo chỉ có MỘT con số tổng (dự án phụ đề 39 phút: 2.964,7 s), không
 * biết batch nào chậm, cũng không biết sidecar mất bao lâu dò nguồn trước khi render.
 * `source_to` của từng lượt cho thấy lượt đó phải giải mã nguồn TỪ GIÂY 0 tới đâu — batch chưa
 * seek (mục 1.1), nên batch sau luôn đắt hơn batch trước.
 *
 * `CRABBYCUT_EXPORT_BENCH=1` (CHỈ khi đo) ghi thêm vào `<temp>/export_bench/`:
 *   <nhãn>.cmd.json      dòng lệnh ffmpeg đúng từng tham số + cwd, để bộ đo
 *                        (tests/scripts/bench_export.js) chạy lại biến thể `-f null` (tách
 *                        phần encode) và biến thể chỉ giải mã;
 *   export_filter_batch_*.txt   filter script, GIỮ LẠI thay vì xoá sau khi chạy;
 *   <nhãn>.log           log mức INFO qua FFREPORT, có dòng `bench: utime=… rtime=…` của
 *                        `-benchmark`. stderr vẫn `-v error` như thường;
 *   <nhãn>.progress.txt  `-progress`: frame/fps/speed theo thời gian — lộ ra quãng ffmpeg đứng
 *                        giải mã suông trước khi tới khung đầu tiên của batch;
 *   <nhãn>.graphs.json   `-print_graphs_file` (FFmpeg ≥ 8.0): định dạng thương lượng giữa các
 *                        filter và bộ chuyển đổi tự chèn;
 *   timing.json          cùng nội dung với sự kiện `timing`.
 * Mọi đường dẫn trong các cờ trên là TƯƠNG ĐỐI theo cwd = tempDir (xem ExportBatch): FFREPORT
 * tách khoá bằng `:` và coi `\` là ký tự thoát, nên `C:\…` phải thoát hai lớp; đường dẫn
 * tương đối không có ký tự nào phải thoát, kể cả khi tên người dùng có dấu.
 * ------------------------------------------------------------------------- */
using ExportClock = std::chrono::steady_clock;

double MsSince(ExportClock::time_point start) {
  return std::chrono::duration<double, std::milli>(ExportClock::now() - start).count();
}

struct ExportRunTiming {
  std::string label;
  std::string mode;
  size_t intervals = 0;
  size_t overlays = 0;
  double sourceFrom = 0.0;
  double sourceTo = 0.0;
  double sequenceDuration = 0.0;
  double seekTo = 0.0;   // 0 = không seek (giải mã nguồn từ giây 0)
  size_t fastClips = 0;  // số clip lane chính đi đường nhanh YUV (mục 1.3)
  size_t sourceRanges = 0;  // số input nguồn riêng theo dải (mục 1.1); 0 = mọi clip đọc [0:v]
  double runMs = 0.0;
  int exitCode = 0;
  bool cpuRetry = false;
  bool gpu = false;           // lượt chạy bằng đồ thị GPU (mục 1.21)
  bool gpuFallback = false;   // đồ thị GPU lỗi -> chạy lại bằng đồ thị CPU
};

struct ExportTimingLog {
  ExportClock::time_point started = ExportClock::now();
  double probeMs = 0.0;
  double planMs = 0.0;
  double concatMs = 0.0;
  // Cỡ khung mà đồ thị dựng ("WxH"); khác cỡ sequence khi dựng ở cỡ xuất (mục 1.12 pha 2).
  std::string graphSize;
  size_t workers = 1;   // số lượt ffmpeg hình chạy cùng lúc (mục 1.8)
  // "gpu" / "cpu" — thiết bị render của lượt xuất (mục 1.21); "gpu" khi ít nhất một batch đi GPU.
  std::string render = "cpu";
  // Kết quả dò GPU lấy từ cache của lượt trước (ReadGpuProbeCache) thay vì chạy lệnh dò.
  bool gpuProbeCached = false;
  std::vector<ExportRunTiming> runs;
};

ExportTimingLog g_exportTiming;
fs::path g_exportBenchDir;   // rỗng = CRABBYCUT_EXPORT_BENCH đang tắt

bool ExportBenchRequested() {
  const char* env = std::getenv("CRABBYCUT_EXPORT_BENCH");
  if (!env || !*env) return false;
  const std::string value = env;
  return !(value == "0" || value == "false" || value == "off");
}

bool FfmpegHasPrintGraphs() {
  static const bool has = CommandOutput({"ffmpeg", "-hide_banner", "-h", "long"}).find("-print_graphs_file") != std::string::npos;
  return has;
}

/* Biến môi trường cho ffmpeg CON (CreateProcessW/std::system đều thừa hưởng môi trường của
 * sidecar). Rỗng = xoá. Gọi cả hai API trên Windows: CreateProcessW đọc khối môi trường của
 * hệ điều hành, std::system (đường lùi) đọc bản của CRT. */
void SetChildEnv(const char* name, const std::string& value) {
#ifdef _WIN32
  const std::wstring wideName = WidenForProcess(name);
  SetEnvironmentVariableW(wideName.c_str(), value.empty() ? nullptr : WidenForProcess(value).c_str());
  _putenv_s(name, value.c_str());
#else
  if (value.empty()) unsetenv(name);
  else setenv(name, value.c_str(), 1);
#endif
}

void WriteBenchCommand(const std::string& label, const std::vector<std::string>& cmd, const fs::path& cwd) {
  std::ofstream out(g_exportBenchDir / (label + ".cmd.json"));
  out << "{\"cwd\":\"" << EscapeJson(cwd.string()) << "\",\"args\":[";
  for (size_t i = 0; i < cmd.size(); i++) {
    if (i > 0) out << ",";
    out << "\"" << EscapeJson(cmd[i]) << "\"";
  }
  out << "]}\n";
}

std::string ExportTimingJson(const std::string& encoder) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(1)
      << "{\"total_ms\":" << MsSince(g_exportTiming.started)
      << ",\"probe_ms\":" << g_exportTiming.probeMs
      << ",\"plan_ms\":" << g_exportTiming.planMs
      << ",\"concat_ms\":" << g_exportTiming.concatMs
      << ",\"encoder\":\"" << EscapeJson(encoder) << "\""
      << ",\"bench\":" << (g_exportBenchDir.empty() ? "false" : "true")
      << ",\"graph_size\":\"" << EscapeJson(g_exportTiming.graphSize) << "\""
      << ",\"workers\":" << g_exportTiming.workers
      << ",\"render\":\"" << g_exportTiming.render << "\""
      << ",\"gpu_probe_cached\":" << (g_exportTiming.gpuProbeCached ? "true" : "false")
      << ",\"runs\":[";
  for (size_t i = 0; i < g_exportTiming.runs.size(); i++) {
    const ExportRunTiming& run = g_exportTiming.runs[i];
    if (i > 0) out << ",";
    out << "{\"label\":\"" << EscapeJson(run.label) << "\",\"mode\":\"" << run.mode << "\""
        << ",\"intervals\":" << run.intervals << ",\"overlays\":" << run.overlays
        << std::setprecision(3)
        << ",\"source_from\":" << run.sourceFrom << ",\"source_to\":" << run.sourceTo
        << ",\"sequence_duration\":" << run.sequenceDuration
        << ",\"seek_to\":" << run.seekTo
        << ",\"fast_clips\":" << run.fastClips
        << ",\"source_ranges\":" << run.sourceRanges
        << std::setprecision(1)
        << ",\"run_ms\":" << run.runMs << ",\"exit\":" << run.exitCode
        << ",\"cpu_retry\":" << (run.cpuRetry ? "true" : "false")
        << ",\"gpu\":" << (run.gpu ? "true" : "false")
        << ",\"gpu_fallback\":" << (run.gpuFallback ? "true" : "false") << "}";
  }
  out << "]}";
  return out.str();
}

void EmitExportTiming(const std::string& encoder) {
  const std::string json = ExportTimingJson(encoder);
  if (!g_exportBenchDir.empty()) {
    std::ofstream file(g_exportBenchDir / "timing.json");
    file << json << "\n";
  }
  Emit("timing", json);
}

std::string CpuVideoEncoder(const std::string& codec) {
  if (codec == "hevc") return "libx265";
  if (codec == "prores") return "prores_ks";
  return "libx264";
}

EncoderPlan CpuEncoderPlan(const ExportSettings& settings) {
  EncoderPlan plan;
  plan.mode = "cpu";
  plan.videoEncoder = CpuVideoEncoder(settings.codec);
  plan.hardware = false;
  return plan;
}

EncoderPlan SelectEncoderPlan(const ExportSettings& settings) {
  EncoderPlan cpu = CpuEncoderPlan(settings);
  if (!HardwareExportEnabled()) return cpu;

  if (settings.codec == "prores") {
#ifdef __APPLE__
    if (HasFfmpegEncoder("prores_videotoolbox")) {
      return {"videotoolbox", "prores_videotoolbox", true};
    }
#endif
    return cpu;
  }

  const std::string prefix = settings.codec == "hevc" ? "hevc" : "h264";
#ifdef __APPLE__
  const std::string vt = prefix + "_videotoolbox";
  if (HasFfmpegEncoder(vt)) return {"videotoolbox", vt, true};
#endif
#ifdef _WIN32
  const std::string nvenc = prefix + "_nvenc";
  const std::string qsv = prefix + "_qsv";
  const std::string amf = prefix + "_amf";
  if (HasFfmpegEncoder(nvenc)) return {"nvenc", nvenc, true};
  if (HasFfmpegEncoder(qsv)) return {"qsv", qsv, true};
  if (HasFfmpegEncoder(amf)) return {"amf", amf, true};
#endif
  return cpu;
}

std::string QualityPreset(const ExportSettings& settings) {
  if (settings.quality == "small") return "ultrafast";
  return "veryfast";
}

int ClampInt(int value, int minValue, int maxValue) {
  return std::max(minValue, std::min(maxValue, value));
}

double ClampDouble(double value, double minValue, double maxValue) {
  return std::max(minValue, std::min(maxValue, value));
}

/* Ô "Bitrate" (ExportSettings::rateMode). Payload cũ chỉ có `quality`: Cao -> Khuyến nghị (cùng trần),
 * Cân bằng -> Thấp hơn (cùng trần), Tệp nhỏ -> Thấp hơn. */
const double kRateMbpsMin = 0.5;
const double kRateMbpsMax = 400.0;

std::string RateModeFromQuality(const std::string& quality) {
  if (quality == "balanced" || quality == "small") return "lower";
  return "recommended";
}

bool RateIsCustom(const ExportSettings& settings) {
  return settings.rateMode == "custom" && settings.rateMbps >= kRateMbpsMin && settings.rateMbps <= kRateMbpsMax;
}

/* Mức chất lượng cố định của từng mức. NVENC `-cq` (đo VMAF trên 4.320 khung 4K, mục 1.20:
 * 19 kém bitrate cố định cũ 0,1 điểm mà nhỏ hơn 29%); CPU là CRF của libx264/libx265 — Khuyến nghị
 * giữ CRF 18 như trước. */
int RateHardwareCq(const ExportSettings& settings) {
  if (settings.rateMode == "lower") return 23;
  if (settings.rateMode == "higher") return 16;
  return 19;
}

std::string RateCpuCrf(const ExportSettings& settings) {
  if (settings.rateMode == "lower") return "23";
  if (settings.rateMode == "higher") return "16";
  return "18";
}

/* Bitrate cho encoder phần cứng, kbps: TRẦN của các mức chất lượng (bitrate cố định cũ của cùng mức,
 * "Cao hơn" gấp đôi Cao), hoặc bitrate TRUNG BÌNH người dùng nhập ở "Tùy chỉnh" (không nhân theo cỡ
 * khung — người dùng đã chọn con số). Các mức theo khung THẬT SỰ được mã hoá (cỡ xuất ở mục 1.12). */
int RateKbps(const ExportSettings& settings) {
  if (RateIsCustom(settings)) {
    return static_cast<int>(std::round(settings.rateMbps * 1000.0));
  }
  const int width = OutputResized(settings) ? settings.outputWidth : (settings.width > 0 ? settings.width : 1920);
  const int height = OutputResized(settings) ? settings.outputHeight : (settings.height > 0 ? settings.height : 1080);
  const double pixels = static_cast<double>(std::max(1, width * height));
  const double scale = pixels / (1920.0 * 1080.0);
  const bool hevc = settings.codec == "hevc";
  int baseKbps = hevc ? 11000 : 13000;
  if (settings.rateMode == "lower") baseKbps = hevc ? 7000 : 8500;
  if (settings.rateMode == "higher") baseKbps = hevc ? 22000 : 26000;
  return ClampInt(static_cast<int>(std::round(baseKbps * scale)), 2500, 80000);
}

std::string KbpsArg(long long kbps) {
  return std::to_string(kbps) + "k";
}

std::string BitrateForHardware(const ExportSettings& settings) {
  return KbpsArg(RateKbps(settings));
}

std::string PreviewBitrate() {
  return "6000k";
}

std::string ExtractStringField(const std::string& text, const std::string& key, const std::string& fallback = "") {
  std::regex pattern("\\\"" + key + "\\\"\\s*:\\s*\\\"([^\\\"]*)\\\"");
  std::smatch match;
  if (std::regex_search(text, match, pattern)) return match[1].str();
  return fallback;
}

std::string JsonUnescape(const std::string& value) {
  std::string out;
  bool escaped = false;
  for (char ch : value) {
    if (escaped) {
      switch (ch) {
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case '\\': out.push_back('\\'); break;
        case '"': out.push_back('"'); break;
        default: out.push_back(ch); break;
      }
      escaped = false;
      continue;
    }
    if (ch == '\\') {
      escaped = true;
    } else {
      out.push_back(ch);
    }
  }
  return out;
}

std::string ExtractJsonStringField(const std::string& text, const std::string& key, const std::string& fallback = "") {
  const std::string needle = "\"" + key + "\"";
  size_t keyPos = 0;
  size_t colon = std::string::npos;
  while (true) {
    keyPos = text.find(needle, keyPos);
    if (keyPos == std::string::npos) return fallback;
    size_t cursor = keyPos + needle.size();
    while (cursor < text.size() && std::isspace(static_cast<unsigned char>(text[cursor]))) cursor++;
    if (cursor < text.size() && text[cursor] == ':') {
      colon = cursor;
      break;
    }
    keyPos += needle.size();
  }
  size_t quote = text.find('"', colon + 1);
  if (quote == std::string::npos) return fallback;
  std::string raw;
  bool escaped = false;
  for (size_t i = quote + 1; i < text.size(); i++) {
    const char ch = text[i];
    if (escaped) {
      raw.push_back('\\');
      raw.push_back(ch);
      escaped = false;
      continue;
    }
    if (ch == '\\') {
      escaped = true;
      continue;
    }
    if (ch == '"') return JsonUnescape(raw);
    raw.push_back(ch);
  }
  return fallback;
}

bool ExtractBoolField(const std::string& text, const std::string& key, bool fallback = false) {
  std::regex pattern("\"" + key + R"("\s*:\s*(true|false))");
  std::smatch match;
  if (!std::regex_search(text, match, pattern)) return fallback;
  return match[1].str() == "true";
}

int ExtractIntField(const std::string& text, const std::string& key, int fallback = 0) {
  std::regex pattern("\"" + key + R"("\s*:\s*(-?\d+))");
  std::smatch match;
  if (std::regex_search(text, match, pattern)) return std::stoi(match[1].str());
  return fallback;
}

bool ExtractDoubleField(const std::string& text, const std::string& key, double& out) {
  std::regex pattern("\"" + key + R"("\s*:\s*(-?\d+(?:\.\d+)?))");
  std::smatch match;
  if (!std::regex_search(text, match, pattern)) return false;
  out = std::stod(match[1].str());
  return std::isfinite(out);
}

double ExtractDoubleFieldOr(const std::string& text, const std::string& key, double fallback) {
  double value = fallback;
  if (!ExtractDoubleField(text, key, value)) return fallback;
  return value;
}

bool ExtractArrayContent(const std::string& text, const std::string& key, std::string& content) {
  size_t start = std::string::npos;
  if (!key.empty()) {
    const size_t keyPos = text.find("\"" + key + "\"");
    if (keyPos != std::string::npos) start = text.find('[', keyPos);
  } else {
    start = text.find('[');
  }
  if (start == std::string::npos) return false;

  bool inString = false;
  bool escaped = false;
  int depth = 0;
  for (size_t i = start; i < text.size(); i++) {
    const char ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch == '\\') escaped = true;
      else if (ch == '"') inString = false;
      continue;
    }
    if (ch == '"') {
      inString = true;
      continue;
    }
    if (ch == '[') depth++;
    if (ch == ']') {
      depth--;
      if (depth == 0) {
        content = text.substr(start + 1, i - start - 1);
        return true;
      }
    }
  }
  return false;
}

std::vector<std::string> ExtractTopLevelObjects(const std::string& arrayContent) {
  std::vector<std::string> objects;
  bool inString = false;
  bool escaped = false;
  int depth = 0;
  size_t objectStart = std::string::npos;
  for (size_t i = 0; i < arrayContent.size(); i++) {
    const char ch = arrayContent[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch == '\\') escaped = true;
      else if (ch == '"') inString = false;
      continue;
    }
    if (ch == '"') {
      inString = true;
      continue;
    }
    if (ch == '{') {
      if (depth == 0) objectStart = i;
      depth++;
    } else if (ch == '}') {
      depth--;
      if (depth == 0 && objectStart != std::string::npos) {
        objects.push_back(arrayContent.substr(objectStart, i - objectStart + 1));
        objectStart = std::string::npos;
      }
    }
  }
  return objects;
}

void ApplyResolutionPreset(ExportSettings& settings) {
  if (settings.resolution == "web_1080p") settings.resolution = "p1080";
  if (settings.resolution == "mobile") settings.resolution = "p720";
  if (settings.width > 0 && settings.height > 0) return;
  if (settings.resolution == "p720") { settings.width = 1280; settings.height = 720; }
  else if (settings.resolution == "p1080") { settings.width = 1920; settings.height = 1080; }
  else if (settings.resolution == "p1440") { settings.width = 2560; settings.height = 1440; }
  else if (settings.resolution == "p2160") { settings.width = 3840; settings.height = 2160; }
  else if (settings.resolution == "vertical_720") { settings.width = 720; settings.height = 1280; }
  else if (settings.resolution == "vertical_1080") { settings.width = 1080; settings.height = 1920; }
  else if (settings.resolution == "vertical_1440") { settings.width = 1440; settings.height = 2560; }
  else if (settings.resolution == "vertical_2160") { settings.width = 2160; settings.height = 3840; }
  else if (settings.resolution == "square_1080") { settings.width = 1080; settings.height = 1080; }
  else { settings.resolution = "source"; settings.width = 0; settings.height = 0; }
}

// "30" | "29.97" | "60000/1001" -> số. PHẢI khớp `parseFpsValue` ở backend/server.js:
// backend dùng nó để chốt mốc overlay vào lưới khung (`snapT`), sidecar dùng nó để chốt
// số khung của từng block. Hai bên lệch nhau là overlay trôi khỏi hình.
double ParseFpsValue(const std::string& raw) {
  try {
    const auto slash = raw.find('/');
    if (slash != std::string::npos) {
      const double num = std::stod(raw.substr(0, slash));
      const double den = std::stod(raw.substr(slash + 1));
      if (!std::isfinite(num) || !std::isfinite(den) || den <= 0.0) return 0.0;
      return num / den;
    }
    const double value = std::stod(raw);
    return (std::isfinite(value) && value > 0.0) ? value : 0.0;
  } catch (...) {
    return 0.0;
  }
}

/* Mốc BẮT ĐẦU thật của một luồng trong file (giây). Xem khối chú thích ở
 * ExportSettings::videoStart để biết vì sao con số này không thể coi là 0.
 * Không đọc được -> 0.0, tức giữ đúng hành vi trước bản sửa. */
double MediaStreamStartTime(const std::string& input, const std::string& streamSpec) {
  const std::string text = CommandOutput({
    "ffprobe", "-v", "error",
    "-select_streams", streamSpec,
    "-show_entries", "stream=start_time",
    "-of", "csv=p=0",
    input,
  });
  try {
    const double value = std::stod(text);
    // Kẹp: một mốc âm hoặc quá lớn gần như chắc là dữ liệu rác, và cộng nó vào mọi mốc cắt
    // thì hỏng cả bản xuất. Edit list thực tế chỉ cỡ vài chục ms.
    if (!std::isfinite(value) || value < 0.0 || value > 10.0) return 0.0;
    return value;
  } catch (...) {
    return 0.0;
  }
}

/* NGUỒN VIDEO HD KHÔNG GẮN NHÃN MA TRẬN MÀU -> phải đọc theo BT.709 cho khớp preview.
 *
 * Nguồn thiếu `color_space` (màn hình quay lại, file qua trình nén/tải xuống, vài app điện
 * thoại) thì mỗi bên TỰ ĐOÁN ma trận YUV -> RGB, và hai bên đoán khác nhau:
 *   - FFmpeg (bản xuất): LUÔN BT.601 (swscale SWS_CS_DEFAULT).
 *   - Chromium (preview): theo CHIỀU CAO — ĐÃ ĐO trong chính app (2026-09-25), cùng một khung
 *     YUV đỏ cam: cao >= 720 -> 221,84,38 (BT.709), cao < 720 -> 208,72,41 (BT.601).
 *     960x720 / 700x1000 / 720x1280 / 1080x1920 ra 709; 960x718 / 1280x540 / 1024x576 /
 *     640x480 ra 601 — tức là xét CHIỀU CAO, không xét bề rộng.
 * => chỉ nguồn HD (cao >= 720) là lệch: bản xuất ra màu 601 trong khi người dùng xem 709.
 * Chuỗi của nguồn đó được `setparams` gắn bt709 ở ĐẦU (UntaggedColorFix). Nguồn SD giữ mặc
 * định 601 của FFmpeg vì nó đã khớp Chromium. Nguồn ĐÃ có nhãn giữ nguyên. yuvj* (JPEG, full
 * range) và RGB/xám không có câu hỏi ma trận kiểu này -> bỏ qua. */
bool MediaColorUntagged(const std::string& input) {
  static std::map<std::string, bool> cache;
  const auto hit = cache.find(input);
  if (hit != cache.end()) return hit->second;
  // key=value thay vì csv: csv in theo thứ tự NỘI BỘ của ffprobe, không theo -show_entries.
  const std::string text = CommandOutput({
    "ffprobe", "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=pix_fmt,color_space,height",
    "-of", "default=nw=1",
    input,
  });
  std::string pixFmt, space;
  long height = 0;
  std::istringstream lines(text);
  std::string line;
  while (std::getline(lines, line)) {
    while (!line.empty() && std::isspace(static_cast<unsigned char>(line.back()))) line.pop_back();
    const size_t eq = line.find('=');
    if (eq == std::string::npos) continue;
    const std::string key = line.substr(0, eq);
    const std::string value = line.substr(eq + 1);
    if (key == "pix_fmt") pixFmt = value;
    else if (key == "color_space") space = value;
    else if (key == "height") { try { height = std::stol(value); } catch (...) { height = 0; } }
  }
  const bool yuv = pixFmt.rfind("yuv", 0) == 0 && pixFmt.rfind("yuvj", 0) != 0;
  const bool untagged = yuv && (space.empty() || space == "unknown") && height >= 720;
  cache[input] = untagged;
  return untagged;
}

std::string UntaggedColorFix(bool untagged) {
  return untagged ? "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709," : "";
}

/* ===== ĐƯỜNG NHANH YUV CHO CLIP LANE CHÍNH (mục 1.3, docs/KE_HOACH_TOI_UU_EXPORT_WIN.md) =====
 *
 * Đường cũ của mỗi clip: `color` đen cỡ sequence (RGBA) + clip đổi sang RGBA + `overlay` + đổi về
 * yuv420p. Tức MỌI khung phim đi YUV -> RGBA -> YUV ở cỡ sequence, kể cả clip 100% nằm giữa
 * khung — nơi kết quả chính là khung nguồn. Đo 2026-09-29 (batch 4K của dự án phụ đề, -f null):
 * riêng lane chính 67 khung/s theo đường cũ, 180 khung/s theo đường nhanh (sát trần giải mã AV1).
 *
 * Đường nhanh: `scale` (cỡ cố định) -> `crop` phần tràn khung -> `pad` phần thiếu -> yuv420p.
 * Ba điểm phải giữ cho bản xuất KHÔNG xê dịch so với đường cũ:
 *  1. MA TRẬN MÀU: swscale đi thẳng YUV -> YUV KHÔNG đổi ma trận (đo: nguồn gắn nhãn BT.601 ra y
 *     hệt từng bit), còn đường cũ đổi đúng vì YUV -> RGB đọc ma trận của khung. Nên chỉ dùng khi
 *     nguồn là BT.709 (hoặc HD không nhãn, đã được UntaggedColorFix gán BT.709). Dải màu thì
 *     swscale có đổi (pc -> tv), nên yuvj/pc vẫn đi được.
 *     Nhãn dò theo LUỒNG (ffprobe), không theo từng khung: file nối mà đổi ma trận giữa chừng
 *     (xem "Khám phá Hạ Long" ở ExportBatch) sẽ ra màu lệch ở đoạn đổi. Backend đã chặn phần lớn:
 *     nguồn khác nhãn thì chuẩn hoá trước khi nối (probeConcatStreamSignature có color_space,
 *     color_range, pix_fmt). Còn lại là một file tự đổi SPS giữa chừng — chưa gặp.
 *  2. TOẠ ĐỘ LẺ: đường cũ đặt clip ở trunc((W-w)/2+posX) — số nguyên bất kỳ, vì overlay chạy ở
 *     RGBA. Ở 4:2:0, cắt lệch một số lẻ điểm ảnh làm mẫu màu lệch nửa mẫu (crop `exact=1` cắt
 *     mặt phẳng màu ở x>>1). Chữa: cho chính `scale` lấy mẫu màu dời một điểm ảnh luma
 *     (`out_h/v_chr_pos` = vị trí nguồn + 256), để sau phép cắt lẻ mẫu màu về đúng chỗ. Đo trên
 *     clip 4K phóng 101% (mép cắt dọc lẻ 9 px): U/V so bản chuẩn 60,5/58,4 dB khi không chữa,
 *     65,5/64,9 dB khi chữa; đường cũ 54,8/53,9 dB.
 *     ĐỆM ở toạ độ lẻ (clip nhỏ hơn khung) và clip GIỮ NGUYÊN CỠ bị cắt lẻ (swscale chép thẳng,
 *     BỎ QUA chr_pos) thì đặt clip ở 4:4:4 rồi hạ về 4:2:0 — xem MainLaneFastPlan.
 *  3. SỐ KHUNG: nền `color` là thứ đang chốt đúng renderFrames khung (overlay chạy tới input dài
 *     nhất, clip ngắn thì lặp khung cuối). Thay bằng `tpad` clone (clip ngắn) + `concat` với một
 *     dải đen (clip không ra khung nào) rồi `trim=end_frame` — xem WriteClipVideoFilters.
 *  4. CHỈNH MÀU: clip có chuỗi màu co giãn + đặt vị trí ở RGB rồi đổi sang YUV một lần — đúng
 *     phép tính của đường cũ (kẹp gam RGB như preview), chỉ bỏ nền + overlay. Xem MainLaneFastPlan.
 * Ngoài đường nhanh: keyframe, hoạt ảnh, xoay, độ mờ < 100%, mặt nạ video, lật (hflip ở 4:2:0
 * đổi vị trí mẫu màu), nguồn xoay, nguồn không BT.709. Env tắt: CRABBYCUT_EXPORT_FASTPATH=0. */
bool MainLaneFastPathEnabled() {
  const char* env = std::getenv("CRABBYCUT_EXPORT_FASTPATH");
  if (!env) return true;
  const std::string value = env;
  return !(value == "0" || value == "false" || value == "off");
}

// Vị trí mẫu màu theo chroma_location của ffprobe, đơn vị như `in_h_chr_pos` của scale.
// Không ghi -> "center", đúng như swscale tự hiểu (ff_sws_chroma_pos).
void ChromaLocationPos(const std::string& loc, int& h, int& v) {
  h = 128;
  v = 128;
  if (loc == "left") { h = 0; v = 128; }
  else if (loc == "topleft") { h = 0; v = 0; }
  else if (loc == "top") { h = 128; v = 0; }
  else if (loc == "bottomleft") { h = 0; v = 256; }
  else if (loc == "bottom") { h = 128; v = 256; }
}

void ProbeMainSourceForFastPath(const std::string& source, ExportSettings& settings) {
  settings.fastPathSource = false;
  if (!MainLaneFastPathEnabled()) return;
  const std::string text = CommandOutput({
    "ffprobe", "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,pix_fmt,color_space,chroma_location"
                     ":stream_tags=rotate:stream_side_data=rotation",
    "-of", "default=nw=1",
    source,
  });
  std::string pixFmt, space, chromaLoc;
  long width = 0, height = 0;
  bool rotated = false;
  std::istringstream lines(text);
  std::string line;
  while (std::getline(lines, line)) {
    while (!line.empty() && std::isspace(static_cast<unsigned char>(line.back()))) line.pop_back();
    const size_t eq = line.find('=');
    if (eq == std::string::npos) continue;
    const std::string key = line.substr(0, eq);
    const std::string value = line.substr(eq + 1);
    if (key == "pix_fmt") pixFmt = value;
    else if (key == "color_space") space = value;
    else if (key == "chroma_location") chromaLoc = value;
    else if (key == "width") { try { width = std::stol(value); } catch (...) { width = 0; } }
    else if (key == "height") { try { height = std::stol(value); } catch (...) { height = 0; } }
    else if (key.find("rotat") != std::string::npos) {
      double deg = 0.0;
      try { deg = std::stod(value); } catch (...) { deg = 0.0; }
      if (std::abs(deg) > 0.5) rotated = true;
    }
  }
  // yuva*: đường cũ dựng alpha của nguồn lên nền đen, đường nhanh thì bỏ alpha -> không đi.
  const bool yuv = pixFmt.rfind("yuv", 0) == 0 && pixFmt.rfind("yuva", 0) != 0;
  const bool bt709 = space == "bt709" || settings.sourceColorUntagged;
  // Cỡ nguồn ghi cả khi không đi đường nhanh: số dải nguồn (MaxSourceRanges) cũng cần nó.
  settings.sourceWidth = width > 0 ? static_cast<int>(width) : 0;
  settings.sourceHeight = height > 0 ? static_cast<int>(height) : 0;
  settings.sourcePixFmt = pixFmt;
  if (!yuv || !bt709 || rotated || width <= 0 || height <= 0) return;
  ChromaLocationPos(chromaLoc, settings.sourceChromaH, settings.sourceChromaV);
  settings.fastPathSource = true;
}

// Nhịp khung của CHÍNH file nguồn (avg_frame_rate). 0.0 nếu không đọc được.
double MediaStreamFps(const std::string& input) {
  const std::string text = CommandOutput({
    "ffprobe", "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=avg_frame_rate",
    "-of", "csv=p=0",
    input,
  });
  std::string trimmed;
  for (const char c : text) {
    if (!std::isspace(static_cast<unsigned char>(c))) trimmed.push_back(c);
  }
  const double value = ParseFpsValue(trimmed);
  return (value > 0.0 && value <= 480.0) ? value : 0.0;
}

/* =====================================================================
 * LƯỚI KHUNG HÌNH CỦA TIMELINE — vì sao số khung mỗi block phải chốt TỪ ĐẦU
 *
 * Trước đây mỗi block chỉ khai độ dài theo GIÂY (`color=...:d=<duration>`), và bộ lọc
 * `fps` phát ra CEIL(duration × fps) khung. Mốc bắt đầu thật của block thứ i trong bản
 * xuất vì thế là TỔNG DỒN CÁC CEIL, trong khi frontend đặt overlay theo TỔNG DỒN SỐ
 * THỰC (backend chỉ làm tròn từng mốc một qua `snapT`). Hai lưới trôi ra xa nhau, mỗi
 * block thêm tới gần 1 khung.
 *
 * ĐO ĐƯỢC trên dự án thật (14 block, 30fps): 44.622s nội dung ra 1346 khung = 44.867s,
 * lệch 7.04 khung ở block cuối. Hậu quả THẤY ĐƯỢC: cửa sổ `enable` của miếng vá Retouch
 * bắt đầu SỚM hơn block của chính nó -> miếng vá của block N+1 bị dán lên những khung
 * CUỐI của block N. Vì mỗi block có transform Auto-Reframe riêng, miếng vá lạc chỗ hiện
 * nguyên thành MỘT HÌNH CHỮ NHẬT lệch khung quanh khuôn mặt (đã dựng lại được chính xác
 * khung f159 của bản xuất 2026-08-06). Kèm theo: những khung cuối mỗi block MẤT retouch.
 *
 * CÁCH CHỮA: chốt số khung của từng block trên lưới `round(mốc_tích_luỹ × fps)` — ĐÚNG
 * cái lưới mà `snapT` của backend dùng để đặt overlay. Sai số làm tròn vì thế không còn
 * CỘNG DỒN: biên mỗi block khớp tuyệt đối với mốc overlay, dư địa chỉ còn dưới nửa khung
 * BÊN TRONG một block.
 *
 * Tính MỘT LẦN cho CẢ timeline (không phải theo batch): khi không có overlay, sidecar
 * chia intervals thành nhiều batch rồi concat — tính theo batch là lưới lại lệch ở mối
 * nối giữa các batch.
 * ================================================================== */
/* Độ dài của một block TRÊN TIMELINE (giây). Đây là đại lượng mà lưới khung, mốc
 * overlay và `concat` đều đi theo — KHÔNG phải độ dài đoạn nguồn. */
double IntervalSequenceDuration(const ExportInterval& item) {
  const double raw = std::max(0.0, item.end - item.start);
  const double rate = item.speedRate > 0.0 ? item.speedRate : 1.0;
  return raw / rate;
}

void BuildTimelineFrameGrid(std::vector<ExportInterval>& intervals, const std::string& renderFps) {
  const double fps = ParseFpsValue(renderFps);
  if (!(fps > 0.0)) return;
  double cumulative = 0.0;
  long long placed = 0;
  for (auto& item : intervals) {
    cumulative += IntervalSequenceDuration(item);
    const long long boundary = std::llround(cumulative * fps);
    // Kẹp tối thiểu 1 khung rồi cộng dồn theo SỐ ĐÃ ĐẶT (không nhảy thẳng về `boundary`)
    // để một block bị kẹp không đẩy mọi block sau nó lệch theo.
    item.renderFrames = std::max<long long>(1, boundary - placed);
    placed += item.renderFrames;
  }
}

std::vector<ExtraAdjustLayer> ReadExtraAdjustLayers(const std::string& obj) {
  std::vector<ExtraAdjustLayer> out;
  const int count = static_cast<int>(ExtractDoubleFieldOr(obj, "adj_layer_count", 1.0));
  for (int k = 1; k < std::min(count, 8); k++) {
    const std::string p = "adj_layer" + std::to_string(k) + "_";
    ExtraAdjustLayer layer;
    layer.filters = ExtractJsonStringField(obj, p + "filters", "");
    layer.eqContrastExpr = ExtractJsonStringField(obj, p + "eq_contrast_expr", "");
    layer.eqBrightnessExpr = ExtractJsonStringField(obj, p + "eq_brightness_expr", "");
    layer.eqSaturationExpr = ExtractJsonStringField(obj, p + "eq_saturation_expr", "");
    layer.filtersPost = ExtractJsonStringField(obj, p + "filters_post", "");
    layer.lutAPath = ExtractJsonStringField(obj, p + "lut_a_path", "");
    layer.lutBPath = ExtractJsonStringField(obj, p + "lut_b_path", "");
    layer.lutMixExpr = ExtractJsonStringField(obj, p + "lut_mix_expr", "");
    out.push_back(layer);
  }
  return out;
}

/* Chuỗi màu có thứ biến thiên theo thời gian bên trong: token LOCALT (lớp Điều chỉnh phủ một phần
 * block, "Viền mờ dần" có keyframe…) hoặc `sendcmd` (keyframe colorbalance/curves/làm mờ đi qua file
 * lệnh theo giờ CỤC BỘ của block — backend nối nó vào đầu chuỗi). Cắt đôi block như vậy thì nửa sau
 * chạy lại giờ cục bộ từ 0. Trước 2026-10-01 chỉ dò LOCALT, và lớp phủ không dò chuỗi của chính nó
 * (mục 1.7, test:export-batch-time-varying). */
bool ColorChainTimeVarying(const std::string& chain) {
  return chain.find("LOCALT") != std::string::npos || chain.find("sendcmd") != std::string::npos;
}

bool ExtraAdjustLayersTimeVarying(const std::vector<ExtraAdjustLayer>& layers) {
  for (const auto& layer : layers) {
    if (ColorChainTimeVarying(layer.filters) || ColorChainTimeVarying(layer.filtersPost)
        || !layer.eqContrastExpr.empty() || !layer.eqBrightnessExpr.empty()
        || !layer.eqSaturationExpr.empty() || !layer.lutMixExpr.empty()) {
      return true;
    }
  }
  return false;
}

bool ReadExportPayload(
  const std::string& path,
  const std::string& cliPreset,
  const std::string& cliFps,
  std::vector<ExportInterval>& intervals,
  std::vector<ExportOverlay>& overlays,
  ExportSettings& settings,
  std::string& error
) {
  const std::string text = ReadFileText(path);
  settings.resolution = ExtractStringField(text, "resolution", cliPreset.empty() ? "source" : cliPreset);
  settings.width = ExtractIntField(text, "width", 0);
  settings.height = ExtractIntField(text, "height", 0);
  settings.fps = ExtractStringField(text, "fps", cliFps.empty() ? "source" : cliFps);
  settings.renderFps = ExtractStringField(text, "render_fps", settings.fps == "source" ? "30" : settings.fps);
  settings.codec = ExtractStringField(text, "codec", "h264");
  settings.quality = ExtractStringField(text, "quality", "high");
  settings.audioBitrate = ExtractStringField(text, "audio_bitrate", "192k");
  settings.mainAudioVolume = ClampDouble(ExtractDoubleFieldOr(text, "main_audio_volume", 100.0), 0.0, 1000.0);
  ApplyResolutionPreset(settings);
  {
    // Cỡ xuất (mục 1.12): số chẵn 16..7680, phần hình nằm gọn trong khung xuất; sai thì bỏ qua.
    const auto evenIn = [](int v) { return v >= 16 && v <= 7680 && v % 2 == 0; };
    const int ow = ExtractIntField(text, "output_width", 0);
    const int oh = ExtractIntField(text, "output_height", 0);
    const int cw = ExtractIntField(text, "output_content_width", ow);
    const int ch = ExtractIntField(text, "output_content_height", oh);
    if (evenIn(ow) && evenIn(oh) && evenIn(cw) && evenIn(ch) && cw <= ow && ch <= oh
        && !(ow == settings.width && oh == settings.height && cw == ow && ch == oh)) {
      settings.outputWidth = ow;
      settings.outputHeight = oh;
      settings.contentWidth = cw;
      settings.contentHeight = ch;
      settings.outputScale = ClampDouble(ExtractDoubleFieldOr(text, "output_scale", 0.0), 0.0, 64.0);
    }
  }

  /* DANH SÁCH NHỊP KHUNG PHẢI PHỦ CẢ NTSC. Trùng EXPORT_FPS_VALUES (backend/server.js) và
   * PREVIEW_FPS_CHOICES (index.html) — ba danh sách này lệch nhau là lỗi im lặng: lựa chọn
   * của người dùng bị âm thầm hạ về "source" ở đúng cái tầng lệch. */
  if (!IsAllowed(settings.fps, {"source", "23.976", "24", "25", "29.97", "30", "50", "59.94", "60"})) {
    settings.fps = "source";
  }
  /* `renderFps` là NHỊP KHUNG THẬT của bản xuất — nó đi thẳng vào `-r` và vào lưới khung
   * (BuildTimelineFrameGrid). KHÔNG kiểm theo danh sách cố định: backend gửi xuống dạng phân
   * số đúng ("60000/1001" cho 59.94, xem canonicalFpsText), mà mọi danh sách cố định sẽ từ
   * chối đúng những giá trị chuẩn xác nhất. Kiểm bằng cách PARSE: ra số dương trong dải
   * fps thực tế thì nhận, không thì về 30. */
  {
    const double parsed = ParseFpsValue(settings.renderFps);
    if (!(parsed > 0.0) || parsed > 240.0) settings.renderFps = "30";
  }
  if (!IsAllowed(settings.codec, {"h264", "hevc", "prores"})) settings.codec = "h264";
  if (!IsAllowed(settings.quality, {"small", "balanced", "high"})) settings.quality = "high";
  settings.rateMode = ExtractStringField(text, "rate_mode", "");
  settings.rateMbps = ExtractDoubleFieldOr(text, "rate_mbps", 0.0);
  if (!IsAllowed(settings.rateMode, {"lower", "recommended", "higher", "custom"})) {
    settings.rateMode = RateModeFromQuality(settings.quality);
  }
  if (settings.rateMode == "custom" && !(settings.rateMbps >= kRateMbpsMin && settings.rateMbps <= kRateMbpsMax)) {
    settings.rateMode = "recommended";
  }
  if (!IsAllowed(settings.audioBitrate, {"128k", "192k", "320k"})) settings.audioBitrate = "192k";
  settings.renderDevice = ExtractStringField(text, "render_device", "auto");
  if (!IsAllowed(settings.renderDevice, {"auto", "gpu", "cpu"})) settings.renderDevice = "auto";

  std::string arrayContent;
  if (!ExtractArrayContent(text, "intervals", arrayContent) && !ExtractArrayContent(text, "", arrayContent)) {
    error = "cannot find export intervals array";
    return false;
  }

  const auto objects = ExtractTopLevelObjects(arrayContent);
  for (size_t i = 0; i < objects.size(); i++) {
    double start = 0.0;
    double finish = 0.0;
    if (!ExtractDoubleField(objects[i], "start", start) || !ExtractDoubleField(objects[i], "end", finish)) {
      error = "interval #" + std::to_string(i + 1) + " is missing numeric start/end";
      return false;
    }
    if (!std::isfinite(start) || !std::isfinite(finish) || finish - start < 0.05) {
      error = "interval #" + std::to_string(i + 1) + " has invalid duration";
      return false;
    }
    ExportInterval item;
    item.index = ExtractIntField(objects[i], "index", static_cast<int>(i));
    item.scriptIndex = ExtractIntField(objects[i], "script_index", -1);
    item.start = std::max(0.0, start);
    item.end = finish;
    item.positionX = ExtractDoubleFieldOr(objects[i], "position_x", 0.0);
    item.positionY = ExtractDoubleFieldOr(objects[i], "position_y", 0.0);
    item.scale = ClampDouble(ExtractDoubleFieldOr(objects[i], "scale", 100.0), 1.0, 800.0);
    /* Kẹp RỘNG (0.001–64), chỉ để payload hỏng không thành filter phóng 1000×. Kẹp chặt là
     * tự tay làm preview và bản xuất lệch nhau: preview KHÔNG kẹp con số này, và một nguồn
     * nhỏ trong sequence 4K cho hệ số vượt 8 một cách hoàn toàn hợp lệ. */
    item.fitScale = ClampDouble(ExtractDoubleFieldOr(objects[i], "fit_scale", 1.0), 0.001, 64.0);
    item.rotation = ExtractDoubleFieldOr(objects[i], "rotation", 0.0);
    item.opacity = ClampInt(static_cast<int>(std::round(ExtractDoubleFieldOr(objects[i], "opacity", 100.0))), 0, 100);
    item.flipX = ExtractBoolField(objects[i], "flip_x", false);
    item.flipY = ExtractBoolField(objects[i], "flip_y", false);
    item.audioVolume = ClampDouble(ExtractDoubleFieldOr(objects[i], "audio_volume", settings.mainAudioVolume), 0.0, 1000.0);
    item.audioDenoiseFilter = ExtractJsonStringField(objects[i], "audio_denoise_filter", "");
    item.speedRate = ClampDouble(ExtractDoubleFieldOr(objects[i], "speed_rate", 1.0), 0.1, 100.0);
    item.speedPitchCorrect = ExtractBoolField(objects[i], "speed_pitch_correct", true);
    item.animXExpr = ExtractJsonStringField(objects[i], "anim_x_expr", "");
    item.animYExpr = ExtractJsonStringField(objects[i], "anim_y_expr", "");
    item.animSxExpr = ExtractJsonStringField(objects[i], "anim_sx_expr", "");
    item.animSyExpr = ExtractJsonStringField(objects[i], "anim_sy_expr", "");
    item.animRotExpr = ExtractJsonStringField(objects[i], "anim_rot_expr", "");
    item.animInStart = std::max(0.0, ExtractDoubleFieldOr(objects[i], "anim_in_start", 0.0));
    item.animInDur = std::max(0.0, ExtractDoubleFieldOr(objects[i], "anim_in_dur", 0.0));
    item.animOutStart = std::max(0.0, ExtractDoubleFieldOr(objects[i], "anim_out_start", 0.0));
    item.animOutDur = std::max(0.0, ExtractDoubleFieldOr(objects[i], "anim_out_dur", 0.0));
    item.kfXExpr = ExtractJsonStringField(objects[i], "kf_x_expr", "");
    item.kfYExpr = ExtractJsonStringField(objects[i], "kf_y_expr", "");
    item.kfScaleExpr = ExtractJsonStringField(objects[i], "kf_scale_expr", "");
    item.kfRotExpr = ExtractJsonStringField(objects[i], "kf_rot_expr", "");
    item.kfOpacityExpr = ExtractJsonStringField(objects[i], "kf_opacity_expr", "");
    item.kfVolumeExpr = ExtractJsonStringField(objects[i], "kf_volume_expr", "");
    item.adjustFilters = ExtractJsonStringField(objects[i], "adj_filters", "");
    item.adjustMaskPath = ExtractJsonStringField(objects[i], "adj_mask_path", "");
    item.videoMaskPath = ExtractJsonStringField(objects[i], "video_mask_path", "");
    item.logoMode = ExtractJsonStringField(objects[i], "logo_mode", "");
    item.logoRects = ExtractJsonStringField(objects[i], "logo_rects", "");
    item.logoAiDir = ExtractJsonStringField(objects[i], "logo_ai_dir", "");
    item.logoAiRects = ExtractJsonStringField(objects[i], "logo_ai_rects", "");
    item.logoAiT0 = std::max(0.0, ExtractDoubleFieldOr(objects[i], "logo_ai_t0", 0.0));
    item.adjEqContrastExpr = ExtractJsonStringField(objects[i], "adj_eq_contrast_expr", "");
    item.adjEqBrightnessExpr = ExtractJsonStringField(objects[i], "adj_eq_brightness_expr", "");
    item.adjEqSaturationExpr = ExtractJsonStringField(objects[i], "adj_eq_saturation_expr", "");
    item.adjustFiltersPost = ExtractJsonStringField(objects[i], "adj_filters_post", "");
    item.adjustLayerFilters = ExtractJsonStringField(objects[i], "adj_layer_filters", "");
    item.adjLayerEqContrastExpr = ExtractJsonStringField(objects[i], "adj_layer_eq_contrast_expr", "");
    item.adjLayerEqBrightnessExpr = ExtractJsonStringField(objects[i], "adj_layer_eq_brightness_expr", "");
    item.adjLayerEqSaturationExpr = ExtractJsonStringField(objects[i], "adj_layer_eq_saturation_expr", "");
    item.adjustLayerFiltersPost = ExtractJsonStringField(objects[i], "adj_layer_filters_post", "");
    item.adjustLayerLutAPath = ExtractJsonStringField(objects[i], "adj_layer_lut_a_path", "");
    item.adjustLayerLutBPath = ExtractJsonStringField(objects[i], "adj_layer_lut_b_path", "");
    item.adjustLayerLutMixExpr = ExtractJsonStringField(objects[i], "adj_layer_lut_mix_expr", "");
    item.extraAdjustLayers = ReadExtraAdjustLayers(objects[i]);
    item.adjustLutAPath = ExtractJsonStringField(objects[i], "adj_lut_a_path", "");
    item.adjustLutBPath = ExtractJsonStringField(objects[i], "adj_lut_b_path", "");
    item.adjustLutMixExpr = ExtractJsonStringField(objects[i], "adj_lut_mix_expr", "");
    intervals.push_back(item);
  }
  if (intervals.empty()) {
    error = "Timeline rỗng. Không có đoạn nào để xuất video.";
    return false;
  }
  BuildTimelineFrameGrid(intervals, settings.renderFps);

  std::string overlaysContent;
  if (ExtractArrayContent(text, "overlays", overlaysContent)) {
    const auto overlayObjects = ExtractTopLevelObjects(overlaysContent);
    for (size_t i = 0; i < overlayObjects.size(); i++) {
      ExportOverlay overlay;
      overlay.index = ExtractIntField(overlayObjects[i], "index", static_cast<int>(i));
      overlay.id = ExtractJsonStringField(overlayObjects[i], "id", "overlay_" + std::to_string(i));
      overlay.type = ExtractJsonStringField(overlayObjects[i], "type", "");
      overlay.assetType = ExtractJsonStringField(overlayObjects[i], "asset_type", "");
      overlay.assetPath = ExtractJsonStringField(overlayObjects[i], "asset_path", "");
      overlay.timelineStart = std::max(0.0, ExtractDoubleFieldOr(overlayObjects[i], "timeline_start", 0.0));
      overlay.duration = std::max(0.0, ExtractDoubleFieldOr(overlayObjects[i], "duration", 0.0));
      overlay.sourceStart = std::max(0.0, ExtractDoubleFieldOr(overlayObjects[i], "source_start", 0.0));
      overlay.positionX = ExtractDoubleFieldOr(overlayObjects[i], "position_x", 0.0);
      overlay.positionY = ExtractDoubleFieldOr(overlayObjects[i], "position_y", 0.0);
      overlay.scale = ClampDouble(ExtractDoubleFieldOr(overlayObjects[i], "scale", 100.0), 1.0, 800.0);
      overlay.fitScale = ClampDouble(ExtractDoubleFieldOr(overlayObjects[i], "fit_scale", 1.0), 0.001, 64.0);
      overlay.rotation = ExtractDoubleFieldOr(overlayObjects[i], "rotation", 0.0);
      overlay.opacity = ClampDouble(ExtractDoubleFieldOr(overlayObjects[i], "opacity", 100.0), 0.0, 100.0);
      overlay.flipX = ExtractBoolField(overlayObjects[i], "flip_x", false);
      overlay.flipY = ExtractBoolField(overlayObjects[i], "flip_y", false);
      overlay.volume = ClampDouble(ExtractDoubleFieldOr(overlayObjects[i], "volume", 100.0), 0.0, 1000.0);
      overlay.muted = ExtractBoolField(overlayObjects[i], "muted", false);
      overlay.hasAudio = ExtractBoolField(overlayObjects[i], "has_audio", false);
      overlay.audioDenoiseFilter = ExtractJsonStringField(overlayObjects[i], "audio_denoise_filter", "");
      overlay.speedRate = ClampDouble(ExtractDoubleFieldOr(overlayObjects[i], "speed_rate", 1.0), 0.1, 100.0);
      overlay.speedPitchCorrect = ExtractBoolField(overlayObjects[i], "speed_pitch_correct", true);
      overlay.featherPx = ClampInt(ExtractIntField(overlayObjects[i], "feather_px", 0), 0, 256);
      overlay.text = ExtractJsonStringField(overlayObjects[i], "text", "");
      overlay.fontFamily = ExtractJsonStringField(overlayObjects[i], "font_family", "Inter");
      overlay.fontFile = ExtractJsonStringField(overlayObjects[i], "font_file", "");
      overlay.fontSize = ClampInt(ExtractIntField(overlayObjects[i], "font_size", 64), 8, 400);
      overlay.color = ExtractJsonStringField(overlayObjects[i], "color", "#ffffff");
      overlay.align = ExtractJsonStringField(overlayObjects[i], "align", "center");
      overlay.seqFps = ClampDouble(ExtractDoubleFieldOr(overlayObjects[i], "seq_fps", 30.0), 1.0, 120.0);
      overlay.frameCount = ClampInt(ExtractIntField(overlayObjects[i], "frame_count", 0), 0, 1000);
      overlay.animXExpr = ExtractJsonStringField(overlayObjects[i], "anim_x_expr", "");
      overlay.animYExpr = ExtractJsonStringField(overlayObjects[i], "anim_y_expr", "");
      overlay.animSxExpr = ExtractJsonStringField(overlayObjects[i], "anim_sx_expr", "");
      overlay.animSyExpr = ExtractJsonStringField(overlayObjects[i], "anim_sy_expr", "");
      overlay.animRotExpr = ExtractJsonStringField(overlayObjects[i], "anim_rot_expr", "");
      overlay.animInStart = std::max(0.0, ExtractDoubleFieldOr(overlayObjects[i], "anim_in_start", 0.0));
      overlay.animInDur = std::max(0.0, ExtractDoubleFieldOr(overlayObjects[i], "anim_in_dur", 0.0));
      overlay.animOutStart = std::max(0.0, ExtractDoubleFieldOr(overlayObjects[i], "anim_out_start", 0.0));
      overlay.animOutDur = std::max(0.0, ExtractDoubleFieldOr(overlayObjects[i], "anim_out_dur", 0.0));
      overlay.kfXExpr = ExtractJsonStringField(overlayObjects[i], "kf_x_expr", "");
      overlay.kfYExpr = ExtractJsonStringField(overlayObjects[i], "kf_y_expr", "");
      overlay.kfScaleExpr = ExtractJsonStringField(overlayObjects[i], "kf_scale_expr", "");
      overlay.kfRotExpr = ExtractJsonStringField(overlayObjects[i], "kf_rot_expr", "");
      overlay.kfOpacityExpr = ExtractJsonStringField(overlayObjects[i], "kf_opacity_expr", "");
      overlay.kfVolumeExpr = ExtractJsonStringField(overlayObjects[i], "kf_volume_expr", "");
      overlay.adjustFilters = ExtractJsonStringField(overlayObjects[i], "adj_filters", "");
      overlay.adjustMaskPath = ExtractJsonStringField(overlayObjects[i], "adj_mask_path", "");
      overlay.videoMaskPath = ExtractJsonStringField(overlayObjects[i], "video_mask_path", "");
      overlay.logoMode = ExtractJsonStringField(overlayObjects[i], "logo_mode", "");
      overlay.logoRects = ExtractJsonStringField(overlayObjects[i], "logo_rects", "");
      overlay.logoAiDir = ExtractJsonStringField(overlayObjects[i], "logo_ai_dir", "");
      overlay.logoAiRects = ExtractJsonStringField(overlayObjects[i], "logo_ai_rects", "");
      overlay.logoAiT0 = std::max(0.0, ExtractDoubleFieldOr(overlayObjects[i], "logo_ai_t0", 0.0));
      overlay.adjEqContrastExpr = ExtractJsonStringField(overlayObjects[i], "adj_eq_contrast_expr", "");
      overlay.adjEqBrightnessExpr = ExtractJsonStringField(overlayObjects[i], "adj_eq_brightness_expr", "");
      overlay.adjEqSaturationExpr = ExtractJsonStringField(overlayObjects[i], "adj_eq_saturation_expr", "");
      overlay.adjustFiltersPost = ExtractJsonStringField(overlayObjects[i], "adj_filters_post", "");
      overlay.adjustLayerFilters = ExtractJsonStringField(overlayObjects[i], "adj_layer_filters", "");
      overlay.adjLayerEqContrastExpr = ExtractJsonStringField(overlayObjects[i], "adj_layer_eq_contrast_expr", "");
      overlay.adjLayerEqBrightnessExpr = ExtractJsonStringField(overlayObjects[i], "adj_layer_eq_brightness_expr", "");
      overlay.adjLayerEqSaturationExpr = ExtractJsonStringField(overlayObjects[i], "adj_layer_eq_saturation_expr", "");
      overlay.adjustLayerFiltersPost = ExtractJsonStringField(overlayObjects[i], "adj_layer_filters_post", "");
      overlay.adjustLayerLutAPath = ExtractJsonStringField(overlayObjects[i], "adj_layer_lut_a_path", "");
      overlay.adjustLayerLutBPath = ExtractJsonStringField(overlayObjects[i], "adj_layer_lut_b_path", "");
      overlay.adjustLayerLutMixExpr = ExtractJsonStringField(overlayObjects[i], "adj_layer_lut_mix_expr", "");
      overlay.extraAdjustLayers = ReadExtraAdjustLayers(overlayObjects[i]);
      overlay.adjustLutAPath = ExtractJsonStringField(overlayObjects[i], "adj_lut_a_path", "");
      overlay.adjustLutBPath = ExtractJsonStringField(overlayObjects[i], "adj_lut_b_path", "");
      overlay.adjustLutMixExpr = ExtractJsonStringField(overlayObjects[i], "adj_lut_mix_expr", "");
      if (overlay.duration >= 0.05 && (overlay.type == "text" || !overlay.assetPath.empty())) {
        overlays.push_back(overlay);
      }
    }
  }
  return true;
}

std::string FixedSeconds(double value) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(6) << value;
  return out.str();
}

std::string Join(const std::vector<std::string>& values, const std::string& separator) {
  std::ostringstream out;
  for (size_t i = 0; i < values.size(); i++) {
    if (i > 0) out << separator;
    out << values[i];
  }
  return out.str();
}

std::string BuildVideoFilter(const ExportSettings& settings) {
  std::vector<std::string> filters;
  if (settings.fps != "source") filters.push_back("fps=" + settings.fps);
  if (settings.width > 0 && settings.height > 0) {
    const std::string w = std::to_string(settings.width);
    const std::string h = std::to_string(settings.height);
    filters.push_back("scale=" + w + ":" + h + ":force_original_aspect_ratio=decrease");
    filters.push_back("pad=" + w + ":" + h + ":(ow-iw)/2:(oh-ih)/2:color=black");
  }
  filters.push_back("setsar=1");
  filters.push_back(settings.codec == "prores" ? "format=yuv422p10le" : "format=yuv420p");
  return Join(filters, ",");
}

std::string FfmpegDouble(double value) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(6) << value;
  return out.str();
}

std::string ClipPixelFormat(const ExportSettings& settings) {
  return settings.codec == "prores" ? "format=yuv422p10le" : "format=yuv420p";
}

/* MÀU ĐẦU RA CỦA BẢN XUẤT: LUÔN BT.709, dải LIMITED (tv), gắn đủ nhãn.
 *
 * LỖI ĐÃ GẶP (2026-09-25, dự án thật "Yêu Con 1"): chỉ cần MỘT ảnh JPG làm lớp phủ (logo,
 * ảnh Magic Fill) là bản xuất thành `yuvj420p · pc · bt470bg` — full range + ma trận BT.601
 * kiểu ảnh JPEG — trong khi nguồn là `yuv420p10le · tv · bt709`. FFmpeg bản mới THƯƠNG LƯỢNG
 * dải/ma trận màu cho cả đồ hình, và `overlay format=auto` kéo luồng chính theo thuộc tính của
 * ảnh. `format=yuv420p` KHÔNG chặn được: từ FFmpeg 7.1 dải màu là thuộc tính RIÊNG, không còn
 * nằm trong tên pix_fmt.
 * Điểm ảnh vẫn đúng NẾU trình phát đọc nhãn, nhưng nhiều trình phát (KMPlayer, trình phát mặc
 * định của nhiều máy, một số nền tảng) BỎ QUA nhãn range/matrix -> tương phản gắt hơn, sắc lệch
 * đi: người dùng thấy "màu bản xuất khác hẳn preview". PNG không gây ra (đã đo), JPG thì có.
 * Chuyển TƯỜNG MINH về bt709/tv ở cuối đồ hình (swscale đọc thuộc tính từng khung nên phép
 * chuyển luôn đúng, kể cả khi luồng phía trước bị kéo sang pc/bt470bg), rồi `setparams` gắn
 * primaries/transfer — trước đây hai nhãn này ra `unknown` ngay cả ở ca bình thường. */
std::string OutputColorFilters(const ExportSettings& settings) {
  /* Cỡ xuất khác cỡ sequence (mục 1.12, pha 1): co cả khung đã dựng về cỡ phần hình ngay ở phép
   * đổi màu cuối (một lượt swscale), lanczos như các bộ dựng phim khi thu nhỏ; phần hình nhỏ hơn
   * khung xuất thì đệm đen hai bên, toạ độ chẵn cho 4:2:0. Pha 2 (ApplyOutputScaleToPayload, đang
   * sau env) dựng thẳng đồ thị ở cỡ phần hình khi co nhỏ, ở đây chỉ còn bước đệm. */
  if (OutputResized(settings)) {
    // Pha 2: đồ thị đã ở cỡ phần hình (ApplyOutputScaleToPayload) — chỉ đổi màu, không co nữa.
    std::string out = settings.builtAtOutputScale
      ? "scale=out_color_matrix=bt709:out_range=tv," + ClipPixelFormat(settings)
      : "scale=w=" + std::to_string(settings.contentWidth) + ":h=" + std::to_string(settings.contentHeight)
        + ":flags=lanczos:out_color_matrix=bt709:out_range=tv," + ClipPixelFormat(settings);
    if (settings.contentWidth != settings.outputWidth || settings.contentHeight != settings.outputHeight) {
      const int x = ((settings.outputWidth - settings.contentWidth) / 2) & ~1;
      const int y = ((settings.outputHeight - settings.contentHeight) / 2) & ~1;
      out += ",pad=w=" + std::to_string(settings.outputWidth) + ":h=" + std::to_string(settings.outputHeight)
        + ":x=" + std::to_string(x) + ":y=" + std::to_string(y) + ":color=black";
    }
    return out + ",setsar=1,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";
  }
  return "scale=out_color_matrix=bt709:out_range=tv," + ClipPixelFormat(settings)
    + ",setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";
}

/* ĐUÔI ĐỒ THỊ GPU (mục 1.21) — bản GPU của OutputColorFilters. Khung tới đây từ nhiều vùng nhớ
 * CUDA (mỗi crabgeo/crabblend một vùng), mà NVENC chỉ đăng ký khung của MỘT vùng ("Could not
 * register an input HW frame") -> crabgeo `passthrough=0` chép về vùng nhớ riêng của nó, kiêm luôn
 * đổi bt709/tv + yuv420p và phép đệm đen của 1.12 (đồ thị dựng ở cỡ phần hình — pha 2). Đồ thị
 * cần co ở đuôi (pha 1: phóng to, lanczos) thì không đi GPU (BatchGpuEligible).
 * `sync=1` (mặc định của crabgeo/crabblend bản 2026-10-02, ghi rõ để phép dò GpuRenderAvailable loại
 * bản build cũ): chờ GPU xong khung rồi mới đưa đi. Bản đầu để GPU chạy không đồng bộ thì bản xuất
 * có khung RÁCH/lệch thời gian — NVENC đọc khung khi kernel chép chưa xong (hàng 0–671 của khung cũ),
 * lớp phủ chữ hiện khung cũ hơn 6 hoặc mới hơn 2 — nhiều nhất khi 3 lượt chạy song song (Bin Tom).
 * Chờ ở mọi bộ lọc CUDA + lúc tải lên thì sạch mà không chậm hơn (mỗi việc GPU chỉ vài ms). */
std::string GpuOutputFilters(const ExportSettings& settings) {
  std::string out = "crabgeo_cuda=format=yuv420p:passthrough=0:sync=1";
  if (OutputResized(settings)
      && (settings.contentWidth != settings.outputWidth || settings.contentHeight != settings.outputHeight)) {
    const int x = ((settings.outputWidth - settings.contentWidth) / 2) & ~1;
    const int y = ((settings.outputHeight - settings.contentHeight) / 2) & ~1;
    out += ":ow=" + std::to_string(settings.outputWidth) + ":oh=" + std::to_string(settings.outputHeight)
         + ":x=" + std::to_string(x) + ":y=" + std::to_string(y);
  }
  // CHỈ CHO TEST (tests/scripts/export_gpu.js): làm hỏng đồ thị GPU để kiểm đường lùi về đồ thị CPU.
  if (const char* env = std::getenv("CRABBYCUT_EXPORT_GPU_TEST_FAIL")) {
    if (std::string(env) == "1") out += ":crabbycut_test_fail=1";
  }
  return out + ",setsar=1,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";
}

// Thay token LOCALT (thời gian cục bộ) bằng (<timeVar> - start). timeVar khác nhau theo
// filter: scale/rotate/overlay dùng 't' (PTS giây); geq dùng 'T'. overlay: start tuyệt đối;
// clip lane chính: start 0.
std::string SubstituteLocalTimeVar(const std::string& expr, double start, const std::string& timeVar) {
  const std::string token = "LOCALT";
  const std::string local = "(" + timeVar + "-" + FfmpegDouble(start) + ")";
  std::string out;
  size_t prev = 0, pos;
  while ((pos = expr.find(token, prev)) != std::string::npos) {
    out += expr.substr(prev, pos - prev);
    out += local;
    prev = pos + token.size();
  }
  out += expr.substr(prev);
  return out;
}

std::string SubstituteLocalTime(const std::string& expr, double start) {
  return SubstituteLocalTimeVar(expr, start, "t");
}

// Đoạn `volume=` của một chuỗi tiếng. Có keyframe âm lượng thì phát BIỂU THỨC theo thời
// gian (`eval=frame` — mặc định của filter volume là eval=once, tính đúng một lần lúc khởi
// tạo nên biểu thức sẽ đứng im ở giá trị t=0).
// LOCALT quy về `t` với start = 0: chỗ gọi nằm SAU `asetpts=PTS-STARTPTS` (và sau atempo
// của Tốc độ) nhưng TRƯỚC `adelay`, nên `t` của luồng đúng bằng giờ cục bộ của block.
std::string BuildVolumeFilter(double volumePercent, const std::string& kfVolumeExpr) {
  if (!kfVolumeExpr.empty()) {
    return "volume='" + SubstituteLocalTimeVar(kfVolumeExpr, 0.0, "t") + "':eval=frame";
  }
  return "volume=" + FfmpegDouble(ClampDouble(volumePercent / 100.0, 0.0, 10.0));
}

// Có ít nhất 1 field keyframe -> dùng nhánh biến đổi theo thời gian thay cho tĩnh.
bool HasKeyframeExpr(const std::string& sx, const std::string& sr, const std::string& so,
                     const std::string& px, const std::string& py) {
  return !sx.empty() || !sr.empty() || !so.empty() || !px.empty() || !py.empty();
}

/* Hoạt ảnh In/Out có tác động HÌNH HỌC (thu phóng / xoay) -> phải đi nhánh biến đổi theo
 * thời gian y như keyframe. Hiệu ứng chỉ mờ/trượt thì KHÔNG: chúng xong bằng `fade` +
 * overlay x/y, giữ đường xuất rẻ (không rotate, không scale=eval=frame). */
bool HasAnimGeomExpr(const std::string& sx, const std::string& sy, const std::string& rot) {
  return !sx.empty() || !sy.empty() || !rot.empty();
}

// File lệnh phụ của filter script đang ghi (lutmix_*.cmd, kfop_*.cmd): nằm cạnh script, số thứ tự
// chạy suốt tiến trình nên mỗi file một tên.
static fs::path g_filterAuxDir;   // thư mục của filter script đang ghi (xem WriteFilterScript)
static int g_filterAuxSeq = 0;

/* ĐỘ MỜ CÓ KEYFRAME (mục 1.6 của docs/KE_HOACH_TOI_UU_EXPORT_WIN.md).
 *
 * Trước đây: `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(op/100,0,1)*alpha(X,Y)'` — geq tính bốn
 * biểu thức cho TỪNG ĐIỂM ẢNH của từng khung. Đo trên Test.crab (block 150% của nguồn 1366×720 ->
 * ~2050×1080, 200 khung): ~215 ms/khung, 43 trong 55,6 s của cả lượt xuất.
 * Nay: `colorchannelmixer` chỉ còn hệ số `aa` (alpha ra = aa × alpha vào; tuỳ chọn có cờ T nên đổi
 * được lúc chạy), và `sendcmd` cờ [expr] tính độ mờ MỘT LẦN mỗi khung rồi gửi vào — cùng khuôn
 * ColorAdjustLutBlend: sendcmd đứng TRƯỚC filter nhận lệnh, lệnh nằm trong FILE (dấu phẩy của biểu
 * thức), biến thời gian là T. Không ghi được file -> giữ geq cũ (thà chậm còn hơn mất keyframe).
 * Env tắt (A/B, test so với cách cũ): CRABBYCUT_EXPORT_KFOP=0. */
bool KfOpacityMixerEnabled() {
  const char* env = std::getenv("CRABBYCUT_EXPORT_KFOP");
  return !(env && std::string(env) == "0");
}

std::string KfOpacityFilter(const std::string& kfOpacityExpr, double start) {
  const std::string op = SubstituteLocalTimeVar(kfOpacityExpr, start, "T");
  const std::string geq = ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip((" + op + ")/100,0,1)*alpha(X,Y)'";
  if (!KfOpacityMixerEnabled()) return geq;
  const std::string tag = "kfop" + std::to_string(++g_filterAuxSeq);
  const fs::path dir = g_filterAuxDir.empty() ? fs::temp_directory_path() : g_filterAuxDir;
  const fs::path cmdPath = dir / (tag + ".cmd");
  {
    std::ofstream cmd{cmdPath};
    if (!cmd) return geq;
    cmd << "0.0-1000000.0 [expr] colorchannelmixer@" << tag << " aa 'clip((" << op << ")/100,0,1)';\n";
  }
  /* `format=gbrap` TRƯỚC colorchannelmixer: geq chỉ nhận RGB tách mặt phẳng nên ffmpeg vẫn tự đổi
   * sang gbrap ở đây, và `overlay=format=auto` phía sau theo đó kéo LUỒNG CHÍNH qua gbrap. Để
   * colorchannelmixer chạy ở rgba thì overlay kéo luồng chính qua rgba — swscale đi đường yuv420p
   * -> rgba nhanh mà kém chính xác, áp cho MỌI khung của cả batch: đo trên Test.crab, so bản chuẩn
   * 45,5 dB tụt còn 41,6 dB (bộ so 0.3 đánh trượt). Giữ gbrap = giữ nguyên đồ thị quanh nó. */
  return ",format=gbrap,sendcmd=f='" + FilterPath(cmdPath.string()) + "',colorchannelmixer@" + tag + "=aa=1";
}

// Nối chuỗi filter biến đổi theo thời gian (rotate -> scale -> opacity) cho 1 stream đã ở
// format=rgba (gọi ngay sau format=rgba/flip). start = mốc trừ LOCALT. Thứ tự rotate
// TRƯỚC scale để canvas rotate = đường chéo nguồn (hằng) không bị xén khi scale biến thiên.
// Field rỗng -> dùng giá trị tĩnh tương ứng. Biểu thức bọc trong ' ' nên dấu phẩy literal.
//
// HAI NGUỒN biến thiên đi CHUNG hàm này và CHỒNG lên nhau chứ không loại trừ nhau — đúng
// như preview (keyframe cho ra transform hiệu dụng, hoạt ảnh áp delta LÊN TRÊN, xem
// effectiveTransformAt):
//   - kf*   : keyframe, THAY THẾ giá trị tĩnh (scale đơn vị %, xoay đơn vị độ)
//   - anim* : hoạt ảnh In/Out, là HỆ SỐ NHÂN (scale) và SỐ CỘNG (xoay, độ)
//   - fitScale: HỆ SỐ VỪA KHUNG của block lane chính (xem ExportInterval::fitScale). Nhân
//     vào scale HIỆU DỤNG, tức nó áp cho CẢ giá trị tĩnh lẫn biểu thức keyframe — bỏ sót
//     nhánh keyframe là clip có keyframe scale sẽ nhảy cỡ ngay khung đầu. Overlay không đi
//     qua phép này nên để mặc định 1.0.
void AppendKfTransformFilters(
  std::ofstream& script, double start,
  const std::string& kfScaleExpr, const std::string& kfRotExpr, const std::string& kfOpacityExpr,
  double staticScale, double staticRotDeg, double staticOpacity,
  const std::string& animSxExpr = "", const std::string& animSyExpr = "",
  const std::string& animRotExpr = "", double fitScale = 1.0
) {
  const bool needRotate = !kfRotExpr.empty() || !animRotExpr.empty() || std::abs(staticRotDeg) > 1e-6;
  if (needRotate) {
    // Gộp ở ĐƠN VỊ ĐỘ rồi đổi sang radian MỘT lần — trộn hai đơn vị trong cùng biểu thức
    // là chỗ rất dễ sai mà chỉ lộ ra khi có đủ cả xoay tĩnh lẫn hoạt ảnh xoay.
    std::string deg = kfRotExpr.empty()
      ? "(" + FfmpegDouble(staticRotDeg) + ")"
      : "(" + SubstituteLocalTime(kfRotExpr, start) + ")";
    if (!animRotExpr.empty()) {
      deg = "((" + deg + ")+(" + SubstituteLocalTime(animRotExpr, start) + "))";
    }
    // Hằng độ->radian viết thẳng đủ chữ số: FfmpegDouble chỉ in 6 số thập phân, mà ở đây
    // nó là HỆ SỐ nhân với góc (tới 180) nên chữ số bị cắt sẽ thành sai số góc thấy được.
    script << ",rotate='(" << deg << ")*0.01745329251994"
           << "':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=black@0";
  }
  const double fit = (fitScale > 0.0) ? fitScale : 1.0;
  const std::string sf = kfScaleExpr.empty()
    ? "(" + FfmpegDouble(std::max(0.01, (staticScale / 100.0) * fit)) + ")"
    : "((" + SubstituteLocalTime(kfScaleExpr, start) + ")/100*" + FfmpegDouble(fit) + ")";
  // Hai trục tách nhau vì hoạt ảnh có hiệu ứng KHÔNG ĐẲNG HƯỚNG (lật: chỉ co trục X)
  const std::string sfx = animSxExpr.empty()
    ? sf : "((" + sf + ")*(" + SubstituteLocalTime(animSxExpr, start) + "))";
  const std::string sfy = animSyExpr.empty()
    ? sf : "((" + sf + ")*(" + SubstituteLocalTime(animSyExpr, start) + "))";
  script << ",scale=w='max(2,ceil(iw*(" << sfx << ")/2)*2)':h='max(2,ceil(ih*(" << sfy << ")/2)*2)'";
  // đánh giá lại w/h mỗi frame -> scale động
  if (!kfScaleExpr.empty() || !animSxExpr.empty() || !animSyExpr.empty()) script << ":eval=frame";
  if (!kfOpacityExpr.empty()) {
    // opacity biến thiên: nhân alpha sẵn có với độ mờ của khung (xem KfOpacityFilter).
    script << KfOpacityFilter(kfOpacityExpr, start);
  } else if (staticOpacity < 0.999) {
    script << ",colorchannelmixer=aa=" << FfmpegDouble(staticOpacity);
  }
}

// Biểu thức vị trí tâm-offset (px) cho overlay x/y ở nhánh keyframe: kf (theo thời gian)
// hoặc hằng tĩnh.
std::string KfOverlayPos(const std::string& kfPosExpr, double start, double staticPos) {
  return kfPosExpr.empty()
    ? "(" + FfmpegDouble(staticPos) + ")"
    : "(" + SubstituteLocalTime(kfPosExpr, start) + ")";
}

// ĐIỀU CHỈNH MÀU — chèn chuỗi filter của panel "Điều chỉnh" (eq / colorbalance /
// curves / lut3d, do static/js/color-adjust.js sinh).
//
// VỊ TRÍ CHÈN LÀ QUAN TRỌNG, phải gọi ngay sau trim/fps và TRƯỚC `format=rgba`:
//   - `eq` chỉ nhận pixel format YUV. Đặt sau format=rgba thì FFmpeg buộc phải chèn
//     rgba -> yuv -> rgba quanh nó, và vòng đó LÀM MẤT kênh alpha mà rotate/opacity
//     phía sau đang cần (clip xoay sẽ lộ nền đen ở 4 góc).
//   - Chỉnh màu là thao tác trên NGUỒN, phải xong trước khi biến đổi hình học, giống
//     thứ tự mà preview áp shader (trên texture nguồn) rồi mới transform sprite.
//
// MẶT NẠ (adj_mask_path): giới hạn phạm vi chỉnh màu. Cách dựng — tách dòng thành 2
// nhánh, chỉnh màu một nhánh, gắn mặt nạ vào ALPHA của nhánh đó rồi phủ lên nhánh gốc.
// Tương đương mix(gốc, đã chỉnh, mặt nạ).
//
// BA ĐIỂM ĐÃ CÂN NHẮC RỒI MỚI CHỌN, đừng đổi mà không đo lại:
//  1. Mặt nạ nạp bằng `movie=` chứ KHÔNG thêm `-i`: thêm input thì phải đánh số lại toàn
//     bộ overlay.assetInputIndex (đang cộng dồn trong CommandExportVideo) — rủi ro cao mà
//     chẳng được gì. Đã kiểm `movie=...:loop=0,setpts=N/FRAME_RATE/TB`: mặt nạ giữ đúng
//     suốt 40 frame, không lệch PTS.
//  2. KHÔNG dùng `geq` để sinh mặt nạ trong graph: biểu thức SDF (chữ nhật bo góc, xoay,
//     feather) dài vài KB và geq đánh giá biểu thức TỪNG PIXEL -> chậm không dùng được.
//  3. Nhân alpha bằng `blend=multiply` chứ không alphamerge thẳng: overlay ảnh/video có
//     thể ĐÃ có alpha riêng, alphamerge sẽ GHI ĐÈ và vùng vốn trong suốt bỗng đục trong
//     phạm vi mặt nạ. Nhân thì nguồn đục (alpha=255) cho ra đúng mặt nạ, còn nguồn có
//     alpha thì giữ nguyên phần trong suốt -> một đường mã đúng cho cả hai.
//
// Gọi hàm này khi đang ở GIỮA một câu lệnh filter (vừa ghi xong một filter, chưa có nhãn
// ra). Nhánh có mặt nạ tự đóng câu và mở câu mới, kết thúc bằng `null` để đoạn sau của
// caller (bắt đầu bằng dấu phẩy) nối vào được.
// KEYFRAME thông số màu: dựng `eq` với BIỂU THỨC theo thời gian.
//
// `eq` là filter màu DUY NHẤT của FFmpeg nhận biểu thức (đã kiểm: brightness='t*0.2' cho
// Y ramp 147->246 khi có eval=frame). Bắt buộc `eval=frame`, thiếu là biểu thức chỉ được
// tính MỘT LẦN lúc khởi tạo và thông số đứng im cả clip.
// start = mốc trừ khỏi LOCALT: 0 cho clip lane chính (đã setpts 0-based), timeline_start
// cho overlay (setpts giữ mốc tuyệt đối).
// Trả về CHUỖI filter (không ghi thẳng) để caller ghép vào TRƯỚC chuỗi tĩnh rồi mới đưa
// cả khối vào bộ bọc mặt nạ — nếu ghi thẳng ra script thì eq sẽ nằm NGOÀI mặt nạ và phần
// keyframe áp toàn khung, sai ý người dùng.
std::string ColorAdjustEqFilter(double start,
                                const std::string& contrastExpr, const std::string& brightnessExpr,
                                const std::string& saturationExpr) {
  if (contrastExpr.empty() && brightnessExpr.empty() && saturationExpr.empty()) return "";
  std::ostringstream out;
  out << "eq=";
  bool first = true;
  const auto put = [&](const char* name, const std::string& expr, const char* fallback) {
    if (!first) out << ":";
    first = false;
    out << name << "='";
    if (expr.empty()) out << fallback;
    else out << SubstituteLocalTime(expr, start);
    out << "'";
  };
  put("contrast", contrastExpr, "1");
  put("brightness", brightnessExpr, "0");
  put("saturation", saturationExpr, "1");
  // eval=frame là BẮT BUỘC: thiếu thì biểu thức chỉ được tính một lần lúc khởi tạo và
  // thông số đứng im cả clip.
  out << ":eval=frame";
  return out.str();
}

// KEYFRAME CƯỜNG ĐỘ LUT — đoạn graph pha giữa HAI nhánh lut3d.
//
// `lut3d` KHÔNG có tham số trộn, và `lut3d(file)` không đổi được file lúc chạy, nên đây là
// đường DUY NHẤT: tách dòng thành 2 nhánh, nhánh A áp cube "chỉ HSL", nhánh B áp cube
// "HSL + LUT hết mức", rồi `blend=all_expr` pha theo T.
//
// ĐÃ ĐO (đừng đoán lại):
//  - `blend=all_expr` NHẬN biến T (giây) và pha mượt: nguồn xám 192 ra 193→209→226 khi mix
//    đi 0→1. Trong FILTER SCRIPT, dấu phẩy trong biểu thức KHÔNG cần escape miễn là bọc
//    trong nháy đơn (đã kiểm bằng file script thật).
//  - `blend` mặc định `shortest=false` nên nó chờ input DÀI NHẤT — ở đây hai nhánh cùng
//    sinh từ `split` nên độ dài bằng nhau, không có nguy cơ treo như khi ghép với
//    `movie=...:loop=0` (xem chú thích mặt nạ ở trên).
//  - Biến thời gian của `blend` là T (chữ HOA), không phải `t` như eq/rotate/overlay.
//
// Trả về đoạn chuỗi để nối vào GIỮA chuỗi filter, kết thúc bằng `null` để phần sau (bắt
// đầu bằng dấu phẩy) nối vào được — cùng quy ước với bộ bọc mặt nạ.
//
// KHÔNG DÙNG `blend=all_expr` NỮA (sửa 2026-09-25, người dùng báo "render treo rất lâu"):
// all_expr tính biểu thức CHO TỪNG ĐIỂM ẢNH của từng mặt phẳng. ĐO trên 1080x1920: 82 ms/khung
// chỉ riêng bước trộn; dự án 2 clip 6s có lớp Điều chỉnh mang LUT + keyframe cường độ mất
// 59,8 s để xuất — tức ~10 s cho mỗi giây phim, còn thanh trạng thái thì đứng yên ở "Đang
// render batch 1/1" nên người dùng tưởng treo.
// Nay: `blend` chế độ normal với `all_opacity` (tuỳ chọn có cờ T — đổi được lúc chạy), và
// `sendcmd` cờ [expr] tính độ trộn MỘT LẦN mỗi khung rồi gửi vào. normal + opacity = B*op +
// A*(1-op) khi input đầu là B — đúng công thức cũ. Đo: 4,9 s -> 0,54 s cho 60 khung (kể cả mã
// hoá), dốc 0 -> 1 khớp biểu thức.
//  - sendcmd đứng TRƯỚC split (tức trước blend): lệnh tới blend TRƯỚC khung mà nó áp cho —
//    đặt sau blend là trễ một khung.
//  - Lệnh phải nằm trong FILE (`sendcmd=f=`): viết thẳng `c='…'` thì dấu phẩy của biểu thức
//    đụng cú pháp tách lệnh của sendcmd, escape qua hai tầng (graph + sendcmd) không qua được.
//  - Biến thời gian của sendcmd [expr] là T (giây của khung), giống blend cũ.
//  - g_filterAuxDir / g_filterAuxSeq: khai báo ở trên AppendKfTransformFilters (độ mờ keyframe
//    dùng cùng cơ chế file lệnh).
/* LUT CHẠY FLOAT (đo 2026-10-03 trên "Yêu Con", nguồn DJI HEVC 10-bit). lut3d nhận định dạng theo
 * bộ lọc ĐỨNG SAU nó, mà sau chuỗi màu luôn là `format=rgb24`/`format=rgba` -> nguồn 10-bit bị hạ
 * về RGB 8-bit TRƯỚC khi qua LUT (LUT có độ dốc lớn khuếch đại bậc lượng tử hoá thành vệt dải màu).
 * So một bản dựng float: LUT tĩnh 39,4 dB -> 49,3 dB khi chạy float. Chèn `format` float ngay trước
 * lut3d (và trước nhánh trộn hai LUT): một LUT không tốn thêm CPU (60 khung 1080×1920: 5,9 CPU-giây
 * cả hai cách), hai LUT + blend +20% phần LUT, thời gian thực không đổi. Danh sách hai định dạng:
 * nguồn có alpha (ảnh PNG lớp phủ) đi gbrapf32le, không thì gbrpf32le — ép một định dạng không alpha
 * là mất alpha. Env tắt (A/B): CRABBYCUT_EXPORT_LUTF32=0. */
bool LutFloatEnabled() {
  const char* env = std::getenv("CRABBYCUT_EXPORT_LUTF32");
  return !(env && std::string(env) == "0");
}

const char* const kLutFloatFormat = "format=gbrpf32le|gbrapf32le";

// Chèn kLutFloatFormat trước mỗi `lut3d=` đứng đầu một filter của chuỗi (đầu chuỗi hoặc sau dấu phẩy).
std::string WithFloatLut(const std::string& chain) {
  if (!LutFloatEnabled()) return chain;
  std::string out;
  size_t from = 0;
  for (size_t at = chain.find("lut3d="); at != std::string::npos; at = chain.find("lut3d=", at + 6)) {
    if (at != 0 && chain[at - 1] != ',') continue;
    out.append(chain, from, at - from);
    out += kLutFloatFormat;
    out += ",";
    from = at;
  }
  out.append(chain, from, std::string::npos);
  return out;
}

std::string ColorAdjustLutBlend(double start, const std::string& aPath, const std::string& bPath,
                                const std::string& mixExpr, const std::string& tag) {
  if (aPath.empty() || bPath.empty() || mixExpr.empty()) return "";
  const std::string mix = SubstituteLocalTimeVar(mixExpr, start, "T");
  const fs::path dir = g_filterAuxDir.empty() ? fs::temp_directory_path() : g_filterAuxDir;
  const fs::path cmdPath = dir / ("lutmix_" + tag + std::to_string(++g_filterAuxSeq) + ".cmd");
  {
    std::ofstream cmd{cmdPath};
    if (!cmd) return "";   // không ghi được -> bỏ tầng trộn (thà thiếu LUT động còn hơn hỏng graph)
    /* KẸP TRẦN 0.99999 — LỖI CỦA FFMPEG (đã đo trên build N-123955): `all_opacity` gửi qua
     * LỆNH lúc chạy mà ĐÚNG BẰNG 1 thì blend ra nhánh DƯỚI (như opacity 0), trong khi đặt tĩnh
     * `all_opacity=1` thì đúng, và 0.9999 cũng đúng. Keyframe cường độ 100% cho mix = 1 tròn,
     * nên cả quãng GIỮ 100% (vd. trước keyframe đầu 100% ở giây 5) mất trắng LUT trong bản
     * xuất (người dùng báo 2026-09-25). 0.99999 lệch < 0.003/255 — không thấy được. */
    cmd << "0.0-1000000.0 [expr] blend@" << tag << "lm all_opacity 'min(" << mix << ",0.99999)';\n";
  }
  std::ostringstream out;
  out << "sendcmd=f='" << FilterPath(cmdPath.string()) << "',";
  if (LutFloatEnabled()) out << kLutFloatFormat << ",";   // hai nhánh lut3d + blend chạy float
  out << "split[" << tag << "la][" << tag << "lb];\n";
  out << "[" << tag << "la]lut3d=file='" << FilterPath(aPath) << "':interp=trilinear[" << tag << "la2];\n";
  out << "[" << tag << "lb]lut3d=file='" << FilterPath(bPath) << "':interp=trilinear[" << tag << "lb2];\n";
  out << "[" << tag << "lb2][" << tag << "la2]blend@" << tag << "lm=all_mode=normal:all_opacity=0[" << tag << "lm];\n";
  out << "[" << tag << "lm]null";
  return out.str();
}

// Ghép eq-keyframe (nếu có) vào TRƯỚC chuỗi filter tĩnh, và chèn đoạn 2 nhánh của cường độ
// LUT vào ĐÚNG CHỖ giữa nửa trước / nửa sau của chuỗi (backend đã tách sẵn tại vị trí tầng
// LUT). Thứ tự tầng LUT là thứ tự của preview — nối vào cuối là sai (đo được 88/255).
std::string ColorAdjustChain(double start, const std::string& staticFilters,
                             const std::string& contrastExpr, const std::string& brightnessExpr,
                             const std::string& saturationExpr,
                             const std::string& postFilters = "",
                             const std::string& lutAPath = "", const std::string& lutBPath = "",
                             const std::string& lutMixExpr = "", const std::string& tag = "adj_") {
  const std::string eqFilter = ColorAdjustEqFilter(start, contrastExpr, brightnessExpr, saturationExpr);
  const std::string lutBlend = ColorAdjustLutBlend(start, lutAPath, lutBPath, lutMixExpr, tag);
  // Chuỗi TĨNH cũng phải thay token LOCALT: từ khi "Viền mờ dần" keyframe được, frontend nhúng
  // biểu thức thời gian ngay trong `vignette=angle='...':eval=frame` — tức là trong chính chuỗi
  // này, không đi qua field riêng như eq. Token chỉ xuất hiện ở đúng những biểu thức đó nên
  // thay ở đây là an toàn, và mọi filter nhận biểu thức về sau tự dùng được, không cần field mới.
  const std::string staticSubbed = WithFloatLut(SubstituteLocalTime(staticFilters, start));
  const std::string postSubbed = WithFloatLut(SubstituteLocalTime(postFilters, start));
  std::string out;
  const auto add = [&out](const std::string& piece) {
    if (piece.empty()) return;
    if (!out.empty()) out += ",";
    out += piece;
  };
  add(eqFilter);
  add(staticSubbed);
  add(lutBlend);
  // Nửa sau chỉ có nghĩa khi có đoạn 2 nhánh ở giữa (backend chỉ tách chuỗi trong ca đó).
  if (!lutBlend.empty()) add(postSubbed);
  return out;
}

void AppendColorAdjustFilters(std::ostream& script, const std::string& filters,
                              const std::string& maskPath, const std::string& tag) {
  if (filters.empty()) return;
  if (maskPath.empty()) {
    script << "," << filters;
    return;
  }
  const std::string safeMask = FilterPath(maskPath);
  script << ",split[" << tag << "b][" << tag << "f];\n";
  script << "[" << tag << "f]" << filters << ",format=rgba,split[" << tag << "c][" << tag << "e];\n";
  script << "[" << tag << "e]alphaextract[" << tag << "a];\n";
  // KHÔNG dùng `loop=0`: `blend` mặc định `shortest=false` nên nó chờ input DÀI NHẤT, mà
  // movie lặp vô hạn thì graph KHÔNG BAO GIỜ kết thúc -> ffmpeg treo mãi (đã mắc). Để
  // movie ra ĐÚNG 1 frame rồi dựa vào `repeatlast` (mặc định true) của framesync để lặp
  // lại frame cuối của luồng phụ — đúng lối chèn logo tĩnh quen dùng. Đã kiểm: graph tự
  // kết thúc, ra đủ 50/50 frame, mặt nạ giữ nguyên ở mọi frame.
  script << "movie='" << safeMask << "',format=gray[" << tag << "m];\n";
  script << "[" << tag << "a][" << tag << "m]blend=all_mode=multiply[" << tag << "am];\n";
  script << "[" << tag << "c][" << tag << "am]alphamerge[" << tag << "k];\n";
  script << "[" << tag << "b][" << tag << "k]overlay=0:0:format=auto[" << tag << "o];\n";
  script << "[" << tag << "o]null";
}

// Nối chuỗi màu của các lớp 1..n-1 SAU lớp 0, đúng thứ tự áp. Tag riêng từng lớp: tag đặt tên
// nhãn nhánh (split/lut3d/blend@…) — trùng tag giữa hai lớp là hỏng cả filtergraph.
void AppendExtraAdjustLayers(std::ostream& script, double start,
                             const std::vector<ExtraAdjustLayer>& layers, const std::string& tagBase) {
  for (size_t k = 0; k < layers.size(); k++) {
    const auto& layer = layers[k];
    const std::string tag = tagBase + "k" + std::to_string(k + 1) + "_";
    AppendColorAdjustFilters(script,
                             ColorAdjustChain(start, layer.filters, layer.eqContrastExpr,
                                              layer.eqBrightnessExpr, layer.eqSaturationExpr,
                                              layer.filtersPost, layer.lutAPath, layer.lutBPath,
                                              layer.lutMixExpr, tag),
                             "", "");
  }
}

/* MÀU THEO TỪNG ĐIỂM ẢNH ÁP SAU BƯỚC CO NHỎ (đo 2026-09-30 trên dự án thật "Yêu Con 1").
 *
 * Chuỗi màu vốn chạy ở cỡ NGUỒN, trước bước co về cỡ hiển thị. Nguồn DJI 1728×3072 10-bit trên
 * sequence 1080×1920, một lớp Điều chỉnh có keyframe cường độ LUT (2×lut3d + blend) tốn ~75 ms
 * mỗi khung: 85 s trong 118,5 s phần hình của cả lượt. Co trước rồi mới áp màu: xem số ở
 * docs/KE_HOACH_TOI_UU_EXPORT_WIN.md (mục 1.19).
 *
 * Đổi thứ tự chỉ đúng với phép tính TỪNG ĐIỂM ẢNH: eq, colorbalance, curves, lut3d, trộn blend,
 * vignette (theo toạ độ TƯƠNG ĐỐI của khung). Giá trị ra của một điểm chỉ phụ thuộc chính nó,
 * nên co trước hay sau chỉ khác ở mép chi tiết (phép co trộn các điểm TRƯỚC hay SAU khi đổi màu).
 * Hiệu ứng theo LÂN CẬN (unsharp, avgblur, noise) có bán kính tính bằng điểm ảnh của khung mà
 * frontend khai (ColorAdjust.ffmpegFilters, frameHeight) -> giữ chỗ cũ, cả mọi tầng TRƯỚC nó
 * (thứ tự áp không được đảo). Mặt nạ màu theo toạ độ nguồn -> tầng có mặt nạ cũng giữ chỗ cũ.
 * Tên bộ lọc được dò bằng chuỗi con: đường dẫn lỡ chứa "noise" thì chỉ là đi đường cũ.
 *
 * Preview (Pixi) áp filter ở cỡ HIỂN THỊ, và Adjustment Layer của Premiere/CapCut áp lên khung
 * đã dựng ở cỡ sequence, nên thứ tự mới còn gần hai chuẩn đó hơn. Chỉ dời khi phép co làm NHỎ
 * khung (phóng to thì áp trước mới rẻ) — phía gọi quyết định. */
bool ColorChainIsPointwise(const std::string& chain) {
  for (const char* spatial : {"unsharp", "avgblur", "gblur", "boxblur", "noise", "movie="}) {
    if (chain.find(spatial) != std::string::npos) return false;
  }
  return true;
}

// Env tắt (A/B, test so với thứ tự cũ): CRABBYCUT_EXPORT_COLOR_AFTER_SCALE=0.
bool ColorAfterScaleEnabled() {
  const char* env = std::getenv("CRABBYCUT_EXPORT_COLOR_AFTER_SCALE");
  return !(env && std::string(env) == "0");
}

struct ColorStage {
  std::string chain;   // kết quả của ColorAdjustChain (rỗng = tầng không làm gì)
  std::string mask;    // mặt nạ màu của tầng (chỉ tầng của chính block có)
  std::string tag;
};

struct SplitColorStages {
  std::string pre;    // phải chạy ở cỡ nguồn, đúng chỗ cũ
  std::string post;   // chạy sau bước co nhỏ
};

/* Chia các tầng màu (theo ĐÚNG thứ tự áp) thành phần trước / sau bước co. Phần sau luôn là một
 * ĐUÔI của danh sách: tầng cuối cùng không dời được giữ lại chính nó và mọi tầng trước nó. */
SplitColorStages SplitColorStagesForScale(const std::vector<ColorStage>& stages, bool allowPost) {
  size_t firstPost = stages.size();
  if (allowPost && ColorAfterScaleEnabled()) {
    firstPost = 0;
    for (size_t k = 0; k < stages.size(); k++) {
      const ColorStage& stage = stages[k];
      if (stage.chain.empty()) continue;
      if (!stage.mask.empty() || !ColorChainIsPointwise(stage.chain)) firstPost = k + 1;
    }
  }
  std::ostringstream pre;
  std::ostringstream post;
  for (size_t k = 0; k < stages.size(); k++) {
    AppendColorAdjustFilters(k < firstPost ? pre : post, stages[k].chain, stages[k].mask, stages[k].tag);
  }
  return {pre.str(), post.str()};
}

/* Các tầng màu của một block theo thứ tự áp: chuỗi của chính block (có thể kèm mặt nạ), lớp
 * Điều chỉnh 0 (gọi với mặt nạ RỖNG — xem WriteClipVideoFilters), rồi các lớp 1..n-1. Gọi
 * ColorAdjustChain theo đúng thứ tự cũ: nó ghi file lệnh sendcmd có số thứ tự. */
template <typename Block>
std::vector<ColorStage> BlockColorStages(const Block& b, double start, const std::string& ownTag,
                                         const std::string& layerTag) {
  std::vector<ColorStage> stages;
  stages.push_back({ColorAdjustChain(start, b.adjustFilters, b.adjEqContrastExpr, b.adjEqBrightnessExpr,
                                     b.adjEqSaturationExpr, b.adjustFiltersPost, b.adjustLutAPath,
                                     b.adjustLutBPath, b.adjustLutMixExpr, ownTag),
                    b.adjustMaskPath, ownTag});
  stages.push_back({ColorAdjustChain(start, b.adjustLayerFilters, b.adjLayerEqContrastExpr,
                                     b.adjLayerEqBrightnessExpr, b.adjLayerEqSaturationExpr,
                                     b.adjustLayerFiltersPost, b.adjustLayerLutAPath,
                                     b.adjustLayerLutBPath, b.adjustLayerLutMixExpr, layerTag),
                    "", ""});
  for (size_t k = 0; k < b.extraAdjustLayers.size(); k++) {
    const auto& layer = b.extraAdjustLayers[k];
    const std::string tag = layerTag + "k" + std::to_string(k + 1) + "_";
    stages.push_back({ColorAdjustChain(start, layer.filters, layer.eqContrastExpr, layer.eqBrightnessExpr,
                                       layer.eqSaturationExpr, layer.filtersPost, layer.lutAPath,
                                       layer.lutBPath, layer.lutMixExpr, tag),
                      "", ""});
  }
  return stages;
}


/* XOÁ LOGO của block — chạy TRƯỚC mọi chuỗi màu, ở kích thước NGUỒN (trước scale/xoay),
 * đúng thứ tự preview: xoá logo sửa ẢNH GỐC, grade/LUT là lớp áp lên kết quả đó.
 *
 * `rectsSpec` = "x:y:w:h:p|..." (pixel nguyên, backend dựng lại từ số đã kẹp). Công thức
 * pixel của cả ba chế độ nằm ở static/js/logo-removal.js — preview chạy bản JS của đúng
 * các phép dưới đây:
 *   delogo   -> filter `delogo` (nối thẳng, không nhánh).
 *   blur     -> crop vùng, `boxblur` power 2, overlay lại đúng chỗ.
 *   pixelate -> crop vùng, `scale` area xuống n ô, `scale` neighbor lên lại, overlay.
 * `delogo` là filter GPL — bản FFmpeg build LGPL không có nó. Thiếu thì rơi về làm mờ
 * thay vì để cả lần xuất đổ vì "No such filter".
 * Kết thúc bằng `null` (nếu có nhánh) để đoạn sau của caller nối tiếp được bằng dấu phẩy. */
struct LogoRect {
  int x = 0;
  int y = 0;
  int w = 0;
  int h = 0;
  int p = 0;
};

std::vector<LogoRect> ParseLogoRects(const std::string& spec) {
  std::vector<LogoRect> out;
  std::stringstream all(spec);
  std::string part;
  while (std::getline(all, part, '|')) {
    int v[5] = {0, 0, 0, 0, 0};
    int count = 0;
    std::stringstream one(part);
    std::string num;
    while (count < 5 && std::getline(one, num, ':')) {
      char* end = nullptr;
      const long parsed = std::strtol(num.c_str(), &end, 10);
      if (end == num.c_str()) break;
      v[count++] = static_cast<int>(parsed);
    }
    if (count != 5) continue;
    LogoRect r;
    r.x = std::max(0, v[0]);
    r.y = std::max(0, v[1]);
    r.w = v[2];
    r.h = v[3];
    r.p = std::max(0, v[4]);
    if (r.w < 6 || r.h < 6) continue;
    out.push_back(r);
    if (out.size() >= 4) break;
  }
  return out;
}

void AppendLogoRemovalFilters(std::ofstream& script, const std::string& mode,
                              const std::string& rectsSpec, const std::string& tag) {
  const std::vector<LogoRect> rects = ParseLogoRects(rectsSpec);
  if (rects.empty()) return;
  std::string m = (mode == "blur" || mode == "pixelate") ? mode : "delogo";
  if (m == "delogo" && !HasFfmpegFilter("delogo")) m = "blur";
  if (m == "delogo") {
    for (const auto& r : rects) {
      script << ",delogo=x=" << r.x << ":y=" << r.y << ":w=" << r.w << ":h=" << r.h;
    }
    return;
  }
  for (size_t k = 0; k < rects.size(); k++) {
    const auto& r = rects[k];
    const std::string t = tag + std::to_string(k);
    script << ",split[" << t << "b][" << t << "f];\n";
    // yuva444p: mọi mặt phẳng CÙNG độ phân giải -> cùng một bán kính/ô cho cả sáng lẫn màu,
    // đúng như bản JS chạy trên RGB. Để nguồn 4:2:0 thì màu mờ gấp đôi sáng (đo được lệch
    // 11/255 so với preview). Giữ alpha (overlay PNG) nhưng KHÔNG làm mờ nó.
    script << "[" << t << "f]crop=" << r.w << ":" << r.h << ":" << r.x << ":" << r.y << ",format=yuva444p";
    if (m == "pixelate") {
      const int block = std::max(2, r.p);
      const int nx = std::max(1, static_cast<int>(std::lround(static_cast<double>(r.w) / block)));
      const int ny = std::max(1, static_cast<int>(std::lround(static_cast<double>(r.h) / block)));
      script << ",scale=" << nx << ":" << ny << ":flags=area"
             << ",scale=" << r.w << ":" << r.h << ":flags=neighbor";
    } else {
      // boxblur từ chối cả graph khi bán kính > nửa cạnh ngắn của mặt phẳng. Frontend đã
      // kẹp p ≤ cạnh ngắn/4; kẹp lại ở đây cho chắc.
      const int cap = std::max(1, std::min(r.w, r.h) / 4);
      const int radius = std::max(1, std::min(r.p, cap));
      script << ",boxblur=luma_radius=" << radius << ":luma_power=2"
             << ":chroma_radius=" << radius << ":chroma_power=2:alpha_radius=0";
    }
    script << "[" << t << "p];\n";
    script << "[" << t << "b][" << t << "p]overlay=" << r.x << ":" << r.y << ":format=auto[" << t << "o];\n";
    script << "[" << t << "o]null";
  }
}

/* XOÁ LOGO BẰNG AI: dán các miếng vá đã vẽ sẵn (asr/logo_inpaint_sidecar.py) lên luồng nguồn.
 *
 * Mỗi vùng là MỘT chuỗi PNG theo đúng PTS của từng khung nguồn, đóng gói bằng `r{k}.ffconcat`
 * (concat demuxer: mỗi ảnh hiện đúng tới khung sau, nguồn VFR vẫn đúng). Nạp bằng `movie=`
 * như mặt nạ (xem AppendVideoMaskFilter) để khỏi đánh số lại input của overlay.
 *
 * KHỚP TỪNG KHUNG — lý do có tham số `timing`: concat ra PTS bắt đầu từ 0, `setpts=+t0` đưa nó
 * về ĐÚNG trục PTS nguồn của `[N:v]`, rồi đi qua CHÍNH chuỗi trim/setpts/tốc độ/fps mà nhánh
 * clip vừa đi (caller truyền nguyên chuỗi đó). Hai luồng cùng PTS vào cùng bộ lọc thì cùng
 * khung ra — kể cả phép lùi nửa khung nguồn ở mép cắt và `fps=` lấy mẫu lại.
 * `safe=0` vì danh sách khai `option framerate 90000` cho từng ảnh (timebase mịn — mặc định
 * 1/25 của PNG làm tròn mọi mốc về lưới 25fps và lệch khung khi đổi tốc độ). Danh sách do
 * chính sidecar Python sinh ra trong cache của backend, tên file tương đối.
 * `eof_action=pass`: lượt AI ngắn hơn đoạn cần (không nên xảy ra — frontend chờ đủ trước khi
 * xuất) thì lộ ảnh gốc, KHÔNG lặp mãi miếng vá cuối lên nền đã trôi đi.
 * Kết thúc bằng `null` như AppendLogoRemovalFilters. */
void AppendLogoAiFilters(std::ofstream& script, const std::string& dir, const std::string& rectsSpec,
                         double t0, const std::string& timing, const std::string& tag) {
  if (dir.empty()) return;
  std::stringstream all(rectsSpec);
  std::string part;
  int k = 0;
  while (k < 4 && std::getline(all, part, '|')) {
    const size_t colon = part.find(':');
    if (colon == std::string::npos) { k++; continue; }
    const long x = std::strtol(part.c_str(), nullptr, 10);
    const long y = std::strtol(part.c_str() + colon + 1, nullptr, 10);
    const std::string list = FilterPath((fs::path(dir) / ("r" + std::to_string(k) + ".ffconcat")).string());
    const std::string t = tag + std::to_string(k);
    script << ",null[" << t << "b];\n";
    script << "movie='" << list << "':format_name=concat:format_opts='safe=0'"
           << ",setpts=PTS+" << FfmpegDouble(t0) << "/TB," << timing << ",format=rgba[" << t << "p];\n";
    script << "[" << t << "b][" << t << "p]overlay=" << std::max(0L, x) << ":" << std::max(0L, y)
           << ":eof_action=pass:format=auto[" << t << "o];\n";
    script << "[" << t << "o]null";
    k++;
  }
}

/* MẶT NẠ CẮT HÌNH của block: nhân mặt nạ vào ALPHA của luồng.
 *
 * ĐƠN GIẢN HƠN AppendColorAdjustFilters vì không phải phủ lại lên nhánh gốc — mặt nạ kia
 * giữ nguyên hình và chỉ giới hạn PHẠM VI chỉnh màu, còn mặt nạ này CẮT hình: ngoài vùng
 * phải trong suốt để lộ lớp nằm dưới.
 *
 * GIỮ NGUYÊN 3 quyết định đã cân nhắc ở mặt nạ chỉnh màu, đừng đổi mà không đo lại:
 *  1. Nạp mặt nạ bằng `movie=` chứ KHÔNG thêm `-i`: thêm input thì phải đánh số lại toàn
 *     bộ overlay.assetInputIndex đang cộng dồn trong CommandExportVideo.
 *  2. KHÔNG `loop=0`: `blend` mặc định `shortest=false` nên chờ input DÀI NHẤT, mà movie
 *     lặp vô hạn thì graph KHÔNG BAO GIỜ kết thúc -> ffmpeg treo. Để movie ra đúng 1 frame
 *     rồi dựa vào `repeatlast` của framesync để lặp lại frame cuối.
 *  3. Nhân alpha bằng `blend=all_mode=multiply` chứ không `alphamerge` thẳng: overlay
 *     ảnh/video có thể ĐÃ có alpha riêng, alphamerge sẽ GHI ĐÈ và vùng vốn trong suốt bỗng
 *     đục trong phạm vi mặt nạ. Nhân thì nguồn đục cho ra đúng mặt nạ, còn nguồn có alpha
 *     thì giữ nguyên phần trong suốt -> MỘT đường mã đúng cho cả hai.
 *
 * VỊ TRÍ GỌI: TRƯỚC bước `scale` — mặt nạ sống trong KHÔNG GIAN NGUỒN (nó nhân vào ảnh
 * trước mọi biến đổi hình học), và ảnh mặt nạ được bake ở ĐÚNG kích thước stream tại đây
 * vì `blend=multiply` đòi hai ảnh cùng kích thước.
 * Kết thúc bằng `null` để đoạn sau của caller (bắt đầu bằng dấu phẩy) nối vào được.
 */
void AppendVideoMaskFilter(std::ofstream& script, const std::string& maskPath,
                           const std::string& tag) {
  if (maskPath.empty()) return;
  const std::string safeMask = FilterPath(maskPath);
  script << ",format=rgba,split[" << tag << "vc][" << tag << "ve];\n";
  script << "[" << tag << "ve]alphaextract[" << tag << "va];\n";
  script << "movie='" << safeMask << "',format=gray[" << tag << "vm];\n";
  script << "[" << tag << "va][" << tag << "vm]blend=all_mode=multiply[" << tag << "vam];\n";
  script << "[" << tag << "vc][" << tag << "vam]alphamerge[" << tag << "vk];\n";
  script << "[" << tag << "vk]null";
}

/* Kế hoạch đường nhanh của một clip (xem khối chú thích ở MainLaneFastPathEnabled). `ok` = false
 * -> clip đi đường cũ. `geometry` nối ngay sau chuỗi màu của clip, bắt đầu bằng dấu phẩy. */
struct MainLaneFast {
  bool ok = false;
  std::string geometry;
  /* Chỉ nhánh RGB (clip có chỉnh màu): `geometry` = `scale` + `place`. Tầng màu theo từng điểm
   * ảnh chen vào GIỮA hai phần khi phép co làm nhỏ khung (`shrinks`) — xem ColorChainIsPointwise. */
  std::string scale;
  std::string place;
  bool shrinks = false;
  /* Cắt trước khi phóng to (mục 1.4, PreCropPlanAxis): đứng ngay sau xoá logo, TRƯỚC chuỗi màu
   * (chỉ cắt khi mọi tầng màu theo từng điểm ảnh) — `geometry` đã tính theo vùng cắt này. */
  std::string preCrop;
};

// Số clip của lượt đang ghi đi đường nhanh — ghi vào số đo (ExportRunTiming::fastClips).
static int g_fastClipCount = 0;

// Input mang hình của từng clip trong lượt đang ghi (chỉ số tính từ đầu batch). Rỗng = mọi clip
// đọc [0:v]. ExportBatch điền trước khi ghi filter script — xem PlanSourceRanges.
static std::vector<int> g_clipVideoInput;

/* ĐANG GHI BẢN ĐỒ THỊ GPU (mục 1.21, xem PrepareExportBatch). Các hàm ghi clip/lớp phủ/đuôi đồ
 * thị đổi sang bộ lọc CUDA của bản ffmpeg riêng: crabgeo_cuda (cắt + co + đổi màu + đặt vào
 * khung), crabblend_cuda (trộn lớp phủ, trùng từng bit với overlay=format=yuv420). Chỉ bật khi
 * BatchGpuEligible đã chắc mọi clip/lớp phủ của batch có bản GPU. `g_gpuMainNvdec`: nguồn chính
 * giải mã bằng NVDEC ra thẳng khung CUDA; sai thì giải mã CPU rồi `hwupload` sau `trim`. */
static bool g_gpuGraph = false;
static bool g_gpuMainNvdec = false;

// Clip/lớp phủ có chuỗi màu nào (của chính nó, lớp Điều chỉnh, các lớp thêm) — xem MainLaneFastPlan.
template <typename Block>
bool BlockHasColorAdjust(const Block& item) {
  return !item.adjustFilters.empty() || !item.adjustFiltersPost.empty() || !item.adjustMaskPath.empty()
      || !item.adjEqContrastExpr.empty() || !item.adjEqBrightnessExpr.empty() || !item.adjEqSaturationExpr.empty()
      || !item.adjustLutMixExpr.empty()
      || !item.adjustLayerFilters.empty() || !item.adjustLayerFiltersPost.empty()
      || !item.adjLayerEqContrastExpr.empty() || !item.adjLayerEqBrightnessExpr.empty()
      || !item.adjLayerEqSaturationExpr.empty() || !item.adjustLayerLutMixExpr.empty()
      || !item.extraAdjustLayers.empty();
}

bool IntervalHasColorAdjust(const ExportInterval& item) {
  return BlockHasColorAdjust(item);
}

/* TẦNG MÀU -> tuỳ chọn LUT của crabgeo_cuda (đồ thị GPU, mục 1.21; cần GpuLutAvailable).
 * Mọi phép màu TĨNH theo từng điểm ảnh của block — eq (số), colorbalance, curves, lut3d (HSL + LUT đã
 * bake ở frontend), qua mọi tầng (của chính block, lớp Điều chỉnh, các lớp thêm), đúng thứ tự áp — gộp
 * thành MỘT LUT: một lut3d đơn lẻ thì dùng thẳng tệp của nó, còn lại BAKE (BakeColorLut) — cho ảnh Hald
 * đồng nhất chạy qua chính chuỗi filter CPU đó rồi đọc ra .cube. Thêm được:
 *  - một tầng keyframe cường độ LUT (ColorAdjustLutBlend: 2 cube + biểu thức) ĐỨNG CUỐI: các phép tĩnh
 *    trước nó bake vào cả hai cube -> `lut=A':lut2=B':mix=<biểu thức>` (trộn sau LUT nên đúng như CPU:
 *    phép trước -> split -> hai lut3d -> blend). Phép đứng SAU tầng trộn thì không gộp được;
 *  - `:enable='…'` CHUNG cho mọi filter (lớp Điều chỉnh chỉ phủ một phần block) -> `mix=<enable>`
 *    (crabgeo: gốc + (LUT − gốc)·mix, mix 0/1 = tắt/bật).
 * Không đạt (block đi đồ thị CPU): keyframe thông số màu (eq theo biểu thức, filter có nhãn `@` mà
 * sendcmd trỏ tới), mặt nạ màu, hiệu ứng không gian (unsharp/blur/noise/vignette), enable khác nhau.
 * `ok` = đạt (kể cả khi không có tầng màu nào: `any` = false). Biểu thức theo thời gian thay LOCALT bằng
 * (t − start), như đường CPU (crabgeo tính `mix` theo mốc khung của chính nó). */
struct GpuLutSpec {
  bool ok = true;
  bool any = false;
  std::string lut;    // đã thoát cho filter script (FilterPath)
  std::string lut2;
  std::string mix;
};

// Thư mục ghi LUT bake (thư mục tạm của dự án) — CommandExportVideo đặt; rỗng = không bake được.
static fs::path g_gpuLutBakeDir;

/* Tách chuỗi filter theo dấu phẩy ở cấp ngoài cùng: trong nháy đơn mọi ký tự là chữ (cả `,` và `\`),
 * ngoài nháy `\` thoát ký tự sau — như av_get_token của lavfi. */
std::vector<std::string> SplitFilterChain(const std::string& chain) {
  std::vector<std::string> out;
  std::string cur;
  bool quoted = false;
  for (size_t i = 0; i < chain.size(); i++) {
    const char ch = chain[i];
    if (!quoted && ch == '\\' && i + 1 < chain.size()) {
      cur += ch;
      cur += chain[++i];
      continue;
    }
    if (ch == '\'') quoted = !quoted;
    if (ch == ',' && !quoted) {
      if (!cur.empty()) out.push_back(cur);
      cur.clear();
      continue;
    }
    cur += ch;
  }
  if (!cur.empty()) out.push_back(cur);
  return out;
}

/* Filter màu tĩnh theo từng điểm ảnh, bake được: eq / colorbalance / curves / lut3d, KHÔNG nhãn `@`
 * (nhãn = có lệnh sendcmd keyframe trỏ tới), không biểu thức thời gian. `:enable='…'` ở cuối tách ra. */
bool BakeableColorFilter(const std::string& filter, std::string& core, std::string& enable) {
  core = filter;
  enable.clear();
  const std::string en = ":enable='";
  const size_t at = filter.rfind(en);
  if (at != std::string::npos && filter.size() > at + en.size() && filter.back() == '\'') {
    enable = filter.substr(at + en.size(), filter.size() - at - en.size() - 1);
    core = filter.substr(0, at);
    if (enable.empty() || enable.find('\'') != std::string::npos) return false;
  }
  const std::string name = core.substr(0, core.find('='));
  if (name != "eq" && name != "colorbalance" && name != "curves" && name != "lut3d") return false;
  if (core.find("LOCALT") != std::string::npos) return false;
  // eq từ frontend chỉ có số; có nháy/eval là biểu thức theo thời gian (ColorAdjustEqFilter).
  if (name == "eq" && (core.find('\'') != std::string::npos || core.find("eval") != std::string::npos)) return false;
  return true;
}

/* BAKE chuỗi màu tĩnh thành LUT 3D cho crabgeo_cuda (lưới 33³, thứ tự r nhanh nhất như .cube).
 * Lưới RGB đồng nhất 16-bit do sidecar tự dựng — ảnh gbrp16le N²×N, điểm (x, y) = ô r = x % N,
 * g = x / N, b = y (haldclutsrc chỉ ra rgb24: làm tròn lưới về 8-bit) — chạy qua CHÍNH chuỗi filter
 * của đường CPU trong một lượt ffmpeg. Có `eq` (chỉ chạy trên YUV 8-bit) thì đổi lưới sang YUV
 * bt709/tv trước — đúng miền nguồn mà eq thấy ở đường CPU — các bước đổi sau đó theo nhãn khung.
 * Đo 2026-10-03 trên nguồn DJI 10-bit, chuỗi eq + colorbalance + curves: GPU so CPU 46,9 dB; so bản
 * chuẩn của bộ so 0.3 thì 39,2 dB so với CPU 40,7 — bản chuẩn chạy eq 8-bit TRÊN TỪNG ĐIỂM ẢNH nên
 * mang đúng bậc làm tròn của đường CPU, LUT nào cũng không tái tạo được (đã thử: áp bảng eq đo được
 * bằng nội suy 38,9; eq trên lưới rgb24 của haldclutsrc 39,5). Không có eq: GPU hơn CPU ~5 dB.
 * Tên tệp theo băm của chuỗi (đường dẫn cube của backend đã mang băm nội dung) -> dùng lại qua các
 * lượt xuất. Lỗi -> "" (block đi đồ thị CPU). */
constexpr int kBakeLutSize = 33;

std::string BakeColorLut(const std::string& chain) {
  static std::map<std::string, std::string> memo;
  if (g_gpuLutBakeDir.empty()) return "";
  const auto known = memo.find(chain);
  if (known != memo.end()) return known->second;
  std::error_code ec;
  fs::create_directories(g_gpuLutBakeDir, ec);
  char stemBuf[48];
  std::snprintf(stemBuf, sizeof(stemBuf), "gpu_bake_%016llx", static_cast<unsigned long long>(Fnv1a64("v2|" + chain)));
  const std::string stem = stemBuf;
  const fs::path cube = g_gpuLutBakeDir / (stem + ".cube");
  if (fs::exists(cube, ec)) return memo[chain] = cube.string();

  const int n = kBakeLutSize;
  const size_t cells = static_cast<size_t>(n) * n * n;
  const fs::path in = g_gpuLutBakeDir / (stem + ".in.raw");
  const fs::path out = g_gpuLutBakeDir / (stem + ".out.raw");
  const fs::path graph = g_gpuLutBakeDir / (stem + ".txt");
  {
    std::vector<std::uint16_t> planes(cells * 3);   // gbrp: G, B, R
    size_t i = 0;
    for (int b = 0; b < n; b++) {
      for (int g = 0; g < n; g++) {
        for (int r = 0; r < n; r++, i++) {
          const auto q = [n](int v) { return static_cast<std::uint16_t>(std::lround(v * 65535.0 / (n - 1))); };
          planes[i] = q(g);
          planes[cells + i] = q(b);
          planes[2 * cells + i] = q(r);
        }
      }
    }
    bool hasEq = false;
    for (const std::string& f : SplitFilterChain(chain)) hasEq = hasEq || f.compare(0, 3, "eq=") == 0;
    std::ofstream fin(in, std::ios::binary | std::ios::trunc);
    fin.write(reinterpret_cast<const char*>(planes.data()), static_cast<std::streamsize>(planes.size() * 2));
    std::ofstream g(graph, std::ios::trunc);
    if (hasEq) g << "scale=out_color_matrix=bt709:out_range=tv,format=yuv444p16le,";
    g << chain << ",format=gbrp16le";
    if (!fin || !g) return memo[chain] = "";
  }
  const std::string size = std::to_string(n * n) + "x" + std::to_string(n);
  const int code = RunQuiet({"ffmpeg", "-hide_banner", "-v", "error", "-nostdin", "-y", "-f", "rawvideo",
                             "-pix_fmt", "gbrp16le", "-s", size, "-i", in.string(), "-/vf", graph.string(),
                             "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gbrp16le", out.string()}, 30000);
  std::vector<std::uint16_t> planes;
  if (code == 0) {
    std::ifstream f(out, std::ios::binary);
    planes.resize(cells * 3);
    f.read(reinterpret_cast<char*>(planes.data()), static_cast<std::streamsize>(planes.size() * 2));
    if (!f || f.gcount() != static_cast<std::streamsize>(planes.size() * 2)) planes.clear();
  }
  fs::remove(in, ec);
  fs::remove(out, ec);
  fs::remove(graph, ec);
  if (planes.empty()) return memo[chain] = "";

  const fs::path part = g_gpuLutBakeDir / (stem + ".cube.part");
  {
    std::ofstream f(part, std::ios::trunc);
    f << "TITLE \"CrabbyCut GPU bake\"\nLUT_3D_SIZE " << n << "\n";
    char line[64];
    for (size_t i = 0; i < cells; i++) {
      std::snprintf(line, sizeof(line), "%.6f %.6f %.6f\n", planes[2 * cells + i] / 65535.0,
                    planes[i] / 65535.0, planes[cells + i] / 65535.0);
      f << line;
    }
    if (!f) return memo[chain] = "";
  }
  fs::rename(part, cube, ec);
  if (ec) return memo[chain] = "";
  return memo[chain] = cube.string();
}

// `lut3d=file='<đường dẫn đã thoát>':interp=trilinear[:enable='<biểu thức>']` — đúng dạng backend sinh.
bool ParseStaticLut(const std::string& chain, std::string& path, std::string& enable) {
  const std::string head = "lut3d=file='";
  const std::string interp = ":interp=trilinear";
  if (chain.compare(0, head.size(), head) != 0) return false;
  const size_t close = chain.find('\'', head.size());
  if (close == std::string::npos) return false;
  path = chain.substr(head.size(), close - head.size());
  std::string rest = chain.substr(close + 1);
  if (rest.compare(0, interp.size(), interp) != 0) return false;
  rest = rest.substr(interp.size());
  enable.clear();
  if (rest.empty()) return !path.empty();
  const std::string en = ":enable='";
  if (rest.compare(0, en.size(), en) != 0 || rest.back() != '\'' || rest.size() <= en.size() + 1) return false;
  enable = rest.substr(en.size(), rest.size() - en.size() - 1);
  return !path.empty() && enable.find('\'') == std::string::npos;
}

// Một tầng màu của block (các trường giống ColorAdjustChain).
struct GpuColorStage {
  const std::string* filters;
  const std::string* post;
  const std::string* lutA;
  const std::string* lutB;
  const std::string* mix;
  bool eqExpr;
  bool mask;
};

/* Gom các tầng (đúng thứ tự áp) thành GpuLutSpec — xem khối chú thích ở GpuLutSpec. `bake` = false: chỉ
 * xét có đạt không, không chạy ffmpeg (nhưng một tầng cần bake vẫn tính là đạt). */
GpuLutSpec GpuLutFromStages(const std::vector<GpuColorStage>& stages, double start, bool bake) {
  GpuLutSpec spec;
  std::vector<std::string> pre;   // phép tĩnh (đã bỏ enable) trước tầng trộn LUT / toàn bộ nếu không có
  std::string enable;
  size_t withEnable = 0;
  const GpuColorStage* mixStage = nullptr;
  for (const GpuColorStage& st : stages) {
    if (st.filters->empty() && st.post->empty() && st.lutA->empty() && st.lutB->empty() && st.mix->empty()
        && !st.eqExpr && !st.mask) continue;
    spec.any = true;
    const bool isMix = !st.lutA->empty() && !st.lutB->empty() && !st.mix->empty();
    // Keyframe thông số màu, mặt nạ màu, nửa sau tầng trộn LUT, phép đứng SAU tầng trộn: không gộp được.
    if (st.eqExpr || st.mask || !st.post->empty() || mixStage || (!isMix && !st.mix->empty())) {
      spec.ok = false;
      return spec;
    }
    for (const std::string& f : SplitFilterChain(*st.filters)) {
      std::string core;
      std::string en;
      if (!BakeableColorFilter(f, core, en)) {
        spec.ok = false;
        return spec;
      }
      if (!en.empty()) {
        if (withEnable > 0 && en != enable) {
          spec.ok = false;
          return spec;
        }
        enable = en;
        withEnable++;
      }
      pre.push_back(core);
    }
    if (isMix) mixStage = &st;
  }
  if (!spec.any) return spec;
  // enable phải phủ MỌI phép (một hàm thời gian duy nhất), và không đi cùng tầng trộn LUT.
  if (withEnable > 0 && (withEnable != pre.size() || mixStage)) {
    spec.ok = false;
    return spec;
  }
  std::string chain;
  for (const std::string& f : pre) chain += (chain.empty() ? "" : ",") + f;
  const auto bakeOrFail = [&](const std::string& c, std::string& out) {
    if (!bake) {
      out = "?";
      return true;
    }
    const std::string path = BakeColorLut(c);
    if (path.empty()) return false;
    out = FilterPath(path);
    return true;
  };
  if (mixStage) {
    if (chain.empty()) {
      spec.lut = FilterPath(*mixStage->lutA);
      spec.lut2 = FilterPath(*mixStage->lutB);
    } else {
      const auto lutOf = [&](const std::string& p) { return chain + ",lut3d=file='" + FilterPath(p) + "':interp=trilinear"; };
      if (!bakeOrFail(lutOf(*mixStage->lutA), spec.lut) || !bakeOrFail(lutOf(*mixStage->lutB), spec.lut2)) {
        spec.ok = false;
        return spec;
      }
    }
    spec.mix = SubstituteLocalTimeVar(*mixStage->mix, start, "t");
    return spec;
  }
  std::string path;
  std::string unusedEnable;
  if (pre.size() == 1 && ParseStaticLut(pre[0], path, unusedEnable)) {
    spec.lut = path;   // một lut3d đơn lẻ: tệp của chính nó
  } else if (!bakeOrFail(chain, spec.lut)) {
    spec.ok = false;
    return spec;
  }
  if (withEnable > 0) spec.mix = SubstituteLocalTimeVar(enable, start, "t");
  return spec;
}

template <typename Block>
GpuLutSpec BlockGpuLut(const Block& b, double start, bool bake = true) {
  std::vector<GpuColorStage> stages;
  stages.push_back({&b.adjustFilters, &b.adjustFiltersPost, &b.adjustLutAPath, &b.adjustLutBPath, &b.adjustLutMixExpr,
                    !b.adjEqContrastExpr.empty() || !b.adjEqBrightnessExpr.empty() || !b.adjEqSaturationExpr.empty(),
                    !b.adjustMaskPath.empty()});
  stages.push_back({&b.adjustLayerFilters, &b.adjustLayerFiltersPost, &b.adjustLayerLutAPath, &b.adjustLayerLutBPath,
                    &b.adjustLayerLutMixExpr,
                    !b.adjLayerEqContrastExpr.empty() || !b.adjLayerEqBrightnessExpr.empty()
                      || !b.adjLayerEqSaturationExpr.empty(),
                    false});
  for (const auto& layer : b.extraAdjustLayers) {
    stages.push_back({&layer.filters, &layer.filtersPost, &layer.lutAPath, &layer.lutBPath, &layer.lutMixExpr,
                      !layer.eqContrastExpr.empty() || !layer.eqBrightnessExpr.empty() || !layer.eqSaturationExpr.empty(),
                      false});
  }
  return GpuLutFromStages(stages, start, bake);
}

// Tuỳ chọn LUT nối vào sau tham số của crabgeo_cuda (rỗng khi block không có tầng màu).
std::string GpuLutOptions(const GpuLutSpec& spec) {
  if (!spec.ok || !spec.any) return "";
  std::string out = ":lut='" + spec.lut + "'";
  if (!spec.lut2.empty()) out += ":lut2='" + spec.lut2 + "'";
  if (!spec.mix.empty()) out += ":mix='" + spec.mix + "'";
  return out;
}

// Tầng màu của block có bản GPU (không có tầng màu, hoặc chỉ là LUT và bản ffmpeg có LUT trong crabgeo).
template <typename Block>
bool BlockColorGpuReady(const Block& b) {
  if (!BlockHasColorAdjust(b)) return true;
  if (!GpuLutAvailable()) return false;
  // Bake ngay ở đây (có cache): bake lỗi thì block đi CPU thay vì đồ thị GPU hỏng.
  const GpuLutSpec spec = BlockGpuLut(b, 0.0);
  return spec.ok && spec.any;
}

/* ===== CẮT TRƯỚC KHI PHÓNG TO (mục 1.4, docs/KE_HOACH_TOI_UU_EXPORT_WIN.md) =====
 *
 * Clip phóng to thì đường nhanh co CẢ khung nguồn lên rồi mới cắt lấy cửa sổ sequence. Test.crab:
 * nguồn 1366×720 nằm giữa khung chuẩn hoá 3840×2160 (viền đen), clip 108% -> mỗi khung co lên
 * 5830×3280 (19 triệu điểm ảnh) để giữ lại 1920×1080; cắt trước: 14,6 -> 11,1 s cả lượt xuất.
 *
 * Cắt trước làm đổi vị trí lấy mẫu của swscale, trừ khi vùng cắt nằm trên LƯỚI TỈ LỆ RÚT GỌN:
 * w/iw = p/q (tối giản), vùng cắt bắt đầu ở bội của q và dài bội của q -> phép co vùng cắt có
 * đúng tỉ lệ cũ (bước lấy mẫu xInc của swscale tính từ cùng một phân số) và mốc của nó trùng một
 * điểm ảnh nguyên của ảnh co cũ (c0·p/q). Bội của 2q để mẫu màu 4:2:0 (nửa độ phân giải) cũng
 * trùng lưới. Chừa lề kPreCropMargin điểm ảnh nguồn cho nhân nội suy (bicubic lấy 2 điểm mỗi bên,
 * mặt phẳng màu ở nửa độ phân giải). Phép đặt vị trí phía sau giữ nguyên: ảnh co của vùng cắt là
 * một mảnh của ảnh co cũ, đặt ở vị trí cũ + mốc của mảnh. Env tắt: CRABBYCUT_EXPORT_PRECROP=0. */
const int kPreCropMargin = 8;
const double kPreCropMinZoom = 1.3;

bool PreCropEnabled() {
  const char* env = std::getenv("CRABBYCUT_EXPORT_PRECROP");
  return !(env && std::string(env) == "0");
}

struct PreCropAxis {
  int start = 0;       // mốc cắt trên nguồn
  int len = 0;         // độ dài cắt trên nguồn
  int scaledLen = 0;   // độ dài sau co giãn (= len·p/q, chẵn)
  int scaledOff = 0;   // mốc của mảnh trong ảnh co cũ (= start·p/q)
};

/* Một chiều: nguồn dài `in`, co thành `out`, đặt ở `pos` trong khung dài `seq`. false = không cắt
 * được gì đáng kể (hoặc không ra số chẵn) -> giữ đường cũ cho chiều này. */
bool PreCropPlanAxis(int in, int out, int pos, int seq, PreCropAxis& r) {
  if (in <= 0 || out <= 0) return false;
  const long long g = std::gcd(static_cast<long long>(out), static_cast<long long>(in));
  const long long p = out / g;
  const long long q = in / g;
  const long long grid = 2 * q;
  // Phần ảnh co lọt vào khung, theo toạ độ của ảnh co.
  const int v0 = std::max(0, -pos);
  const int v1 = std::min(out, seq - pos);
  if (v1 - v0 < 2) return false;
  const double ratio = static_cast<double>(in) / out;
  const long long i0 = std::max(0LL, static_cast<long long>(std::floor(v0 * ratio)) - kPreCropMargin);
  const long long i1 = std::min(static_cast<long long>(in), static_cast<long long>(std::ceil(v1 * ratio)) + kPreCropMargin);
  const long long c0 = (i0 / grid) * grid;
  const long long c1 = std::min(static_cast<long long>(in), ((i1 + grid - 1) / grid) * grid);
  const long long len = c1 - c0;
  if (len <= 0 || len >= in || len % q != 0) return false;
  const long long scaledLen = len * p / q;
  if (scaledLen % 2 != 0 || scaledLen < 2) return false;
  r.start = static_cast<int>(c0);
  r.len = static_cast<int>(len);
  r.scaledLen = static_cast<int>(scaledLen);
  r.scaledOff = static_cast<int>(c0 * p / q);
  return true;
}

// Mọi tầng màu của clip theo từng điểm ảnh, không mặt nạ -> cắt trước chúng cũng không đổi kết quả.
bool IntervalColorPointwise(const ExportInterval& item) {
  if (!item.adjustMaskPath.empty()) return false;
  for (const std::string* chain : {&item.adjustFilters, &item.adjustFiltersPost,
                                   &item.adjustLayerFilters, &item.adjustLayerFiltersPost}) {
    if (!ColorChainIsPointwise(*chain)) return false;
  }
  for (const auto& layer : item.extraAdjustLayers) {
    if (!ColorChainIsPointwise(layer.filters) || !ColorChainIsPointwise(layer.filtersPost)) return false;
  }
  return true;
}

MainLaneFast MainLaneFastPlan(const ExportInterval& item, const ExportSettings& settings,
                              bool dynamicClip, double scaleValue, double opacityValue) {
  MainLaneFast plan;
  if (!settings.fastPathSource || dynamicClip) return plan;
  if (item.renderFrames <= 0 || !(ParseFpsValue(settings.renderFps) > 0.0)) return plan;
  if (std::abs(item.rotation) > 1e-6 || opacityValue < 0.999) return plan;
  if (item.flipX || item.flipY || !item.videoMaskPath.empty()) return plan;
  const int seqW = settings.width > 0 ? settings.width : 1920;
  const int seqH = settings.height > 0 ? settings.height : 1080;
  const int iw = settings.sourceWidth;
  const int ih = settings.sourceHeight;
  if (iw <= 0 || ih <= 0) return plan;

  /* CÙNG PHÉP TÍNH với đường cũ, trên CÙNG con số đã in ra filter script (6 chữ số): cỡ
   * `max(2,ceil(iw*s/2)*2)` và toạ độ `(W-w)/2+posX` mà overlay RGBA cắt về số nguyên bằng (int). */
  const double s = std::stod(FfmpegDouble(scaleValue));
  // Cỡ + vị trí của ẢNH ĐEM ĐẶT vào khung. Cắt trước (mục 1.4) thì đổi thành mảnh của ảnh co.
  int w = static_cast<int>(std::max(2.0, std::ceil(iw * s / 2) * 2));
  int h = static_cast<int>(std::max(2.0, std::ceil(ih * s / 2) * 2));
  int x = static_cast<int>((seqW - w) / 2.0 + std::stod(FfmpegDouble(item.positionX)));
  int y = static_cast<int>((seqH - h) / 2.0 + std::stod(FfmpegDouble(item.positionY)));
  int inW = iw;   // cỡ đi vào phép co (vùng cắt trước, nếu có)
  int inH = ih;
  const bool chromaSubV = settings.codec != "prores";   // yuv420p; ProRes là yuv422p10le

  /* Một chiều. ĐỆM TRƯỚC, CẮT SAU: clip (cỡ luôn chẵn) được đệm vào khung `len` ở vị trí `ox`,
   * rồi cắt cửa sổ sequence từ `wx`. Không làm ngược lại (cắt phần thấy được rồi mới đệm): phần
   * thấy được có thể rộng lẻ, mà `pad` làm tròn bề rộng ĐẦU VÀO xuống số chẵn -> mất một cột ở
   * mép clip (đã mắc: clip 75% cắt lẻ bên trái, mép phải hụt 1 px). */
  struct Axis {
    int ox = 0, wx = 0, len = 0;
    bool oddCrop = false, oddPad = false;
  };
  const auto axis = [](int size, int seq, int pos, bool subsampled, Axis& out) {
    out.ox = std::max(0, pos);
    out.wx = std::max(0, -pos);
    out.len = std::max(out.ox + size, out.wx + seq);
    if (out.len % 2) out.len += 1;   // `pad` cũng làm tròn cỡ RA xuống số chẵn
    out.oddCrop = subsampled && (out.wx % 2) != 0;
    out.oddPad = subsampled && (out.ox % 2) != 0;
    // Phần clip nằm trong khung phải có ít nhất 2 điểm ảnh, không thì để đường cũ lo.
    return std::min(out.ox + size, out.wx + seq) - std::max(out.ox, out.wx) >= 2;
  };
  /* CLIP CÓ CHỈNH MÀU -> co giãn + đặt vị trí ở RGB, đổi sang YUV một lần ở cuối. Tức là ĐÚNG
   * phép tính của đường cũ, chỉ bỏ nền `color` + overlay RGBA:
   *  - curves/lut3d/colorbalance… ra RGB; để swscale vừa đổi RGB -> YUV vừa co giãn thì nó đổi
   *    TRƯỚC rồi mới co giãn, nên chỗ vọt/kẹp ở cạnh khác đường cũ (đo trên testsrc2 + curves,
   *    luma so bản chuẩn 47,8 dB so với 54,4 dB khi co giãn ở RGB);
   *  - chuỗi màu YUV (eq tăng bão hoà) thì đường cũ kẹp gam RGB ngay sau nó, giống preview
   *    (WebGL áp màu trên RGB). Giữ YUV nguyên vẹn là bản xuất khác preview ở vùng rất bão hoà.
   * RGB không hạ mẫu màu nên toạ độ lẻ nào cũng đúng. */
  const bool rgbRoute = IntervalHasColorAdjust(item);
  if (PreCropEnabled() && s >= kPreCropMinZoom && (!rgbRoute || IntervalColorPointwise(item))) {
    PreCropAxis cx, cy;
    const bool okX = PreCropPlanAxis(iw, w, x, seqW, cx);
    const bool okY = PreCropPlanAxis(ih, h, y, seqH, cy);
    // Mỗi chiều cắt được thì cắt; chiều nào không thì giữ trọn chiều đó. Chỉ đáng khi bớt ≥ 25%.
    const int cw = okX ? cx.len : iw, ch = okY ? cy.len : ih;
    if ((okX || okY) && static_cast<double>(cw) * ch <= 0.75 * static_cast<double>(iw) * ih) {
      const int c0x = okX ? cx.start : 0, c0y = okY ? cy.start : 0;
      plan.preCrop = ",crop=w=" + std::to_string(cw) + ":h=" + std::to_string(ch)
                   + ":x=" + std::to_string(c0x) + ":y=" + std::to_string(c0y) + ":exact=1";
      if (okX) { w = cx.scaledLen; x += cx.scaledOff; }
      if (okY) { h = cy.scaledLen; y += cy.scaledOff; }
      inW = cw;
      inH = ch;
    }
  }
  Axis ax, ay;
  if (!axis(w, seqW, x, !rgbRoute, ax) || !axis(h, seqH, y, chromaSubV && !rgbRoute, ay)) return plan;
  if (rgbRoute) {
    std::ostringstream g;
    // Co ở định dạng NGUỒN; tầng màu dời ra sau phép co (nếu có) chạy ngay đây, rồi mới về RGB.
    plan.scale = ",scale=w=" + std::to_string(w) + ":h=" + std::to_string(h);
    plan.shrinks = static_cast<long long>(w) * h < static_cast<long long>(inW) * inH;
    g << ",format=rgb24";
    if (ax.len != w || ay.len != h || ax.ox != 0 || ay.ox != 0) {
      g << ",pad=width=" << ax.len << ":height=" << ay.len
        << ":x=" << ax.ox << ":y=" << ay.ox << ":color=black";
    }
    if (ax.wx != 0 || ay.wx != 0 || ax.len != seqW || ay.len != seqH) {
      g << ",crop=w=" << seqW << ":h=" << seqH << ":x=" << ax.wx << ":y=" << ay.wx;
    }
    g << ",scale=out_color_matrix=bt709:out_range=tv";
    plan.ok = true;
    plan.place = g.str();
    plan.geometry = plan.scale + plan.place;
    return plan;
  }
  /* Hai cách xử lý toạ độ lẻ:
   *  - CẮT lẻ mà clip tràn kín khung theo chiều đó: `scale` dời mẫu màu 1 điểm ảnh luma
   *    (chr_pos + 256) để sau `crop exact` mẫu màu về đúng chỗ. Rẻ, ở nguyên 4:2:0.
   *  - ĐỆM lẻ, cắt lẻ mà mép clip nằm trong khung, và clip GIỮ NGUYÊN CỠ bị cắt lẻ: đặt clip ở 4:4:4 rồi mới hạ
   *    về 4:2:0. Với phép đệm, mẫu màu ở mép clip giáp nền đen phải là trung bình (đen, cột đầu
   *    của clip) — đường cũ ghép RGBA rồi hạ mẫu nên ra đúng vậy, còn mẫu đã dời thì lấy trọn
   *    màu đen: đo (clip 80%, đệm lẻ cả hai chiều) kênh U so bản chuẩn 30,2 dB theo mẹo dời,
   *    32,3 dB theo đường cũ. Clip giữ nguyên cỡ thì swscale chép thẳng và BỎ QUA chr_pos (đo:
   *    hai bản y hệt). Ở 4:4:4 mọi toạ độ đều đúng; chỉ không đi vòng qua RGB như đường cũ. */
  const bool sameSize = w == inW && h == inH;
  /* Cắt lẻ mà clip KHÔNG phủ kín khung theo chiều đó: mép xa của clip (giáp nền đen) rơi vào
   * cột lẻ -> cùng chuyện mép như phép đệm lẻ (đo: clip 75% cắt lẻ trái, kênh V 32,6 so với
   * 33,3 dB của đường cũ). Mẹo dời mẫu màu chỉ dùng khi clip tràn kín khung. */
  const bool edgeInsideX = ax.oddCrop && ax.ox + w < ax.wx + seqW;
  const bool edgeInsideY = ay.oddCrop && ay.ox + h < ay.wx + seqH;
  const bool full444 = ax.oddPad || ay.oddPad || edgeInsideX || edgeInsideY
                       || ((ax.oddCrop || ay.oddCrop) && sameSize);
  const bool shiftH = !full444 && ax.oddCrop;
  const bool shiftV = !full444 && ay.oddCrop;

  std::ostringstream g;
  g << ",scale=w=" << w << ":h=" << h << ":out_color_matrix=bt709:out_range=tv";
  if (shiftH) {
    g << ":in_h_chr_pos=" << settings.sourceChromaH << ":out_h_chr_pos=" << (settings.sourceChromaH + 256);
  }
  if (shiftV) {
    g << ":in_v_chr_pos=" << settings.sourceChromaV << ":out_v_chr_pos=" << (settings.sourceChromaV + 256);
  }
  if (full444) g << (settings.codec == "prores" ? ",format=yuv444p10le" : ",format=yuv444p");
  if (ax.len != w || ay.len != h || ax.ox != 0 || ay.ox != 0) {
    g << ",pad=width=" << ax.len << ":height=" << ay.len
      << ":x=" << ax.ox << ":y=" << ay.ox << ":color=black";
  }
  if (ax.wx != 0 || ay.wx != 0 || ax.len != seqW || ay.len != seqH) {
    g << ",crop=w=" << seqW << ":h=" << seqH << ":x=" << ax.wx << ":y=" << ay.wx << ":exact=1";
  }
  plan.ok = true;
  plan.geometry = g.str();
  return plan;
}

void WriteClipVideoFilters(
  std::ofstream& script,
  const ExportInterval& item,
  size_t localIndex,
  const ExportSettings& settings
) {
  const bool clipHasAnim = !item.animXExpr.empty();
  const int seqW = settings.width > 0 ? settings.width : 1920;
  const int seqH = settings.height > 0 ? settings.height : 1080;
  // Độ dài SEQUENCE (đã chia tốc độ) — dùng làm dự phòng khi chưa có lưới khung.
  const double duration = std::max(0.05, IntervalSequenceDuration(item));
  /* SCALE HIỆU DỤNG = scale của người dùng × HỆ SỐ VỪA KHUNG (xem ExportInterval::fitScale).
   * Đây là chỗ duy nhất trong nhánh TĨNH mà hai số gặp nhau; nhánh keyframe/hoạt ảnh nhân ở
   * AppendKfTransformFilters. Bỏ sót một trong hai nhánh là clip đổi cỡ ngay khi có keyframe. */
  const double fitScale = (item.fitScale > 0.0) ? item.fitScale : 1.0;
  const double scaleValue = std::max(0.01, (item.scale / 100.0) * fitScale);
  const double opacityValue = std::max(0.0, std::min(1.0, item.opacity / 100.0));
  const double rotationRad = item.rotation * 3.14159265358979323846 / 180.0;
  const std::string idx = std::to_string(localIndex);

  // ĐỘ DÀI SEGMENT ĐO BẰNG KHUNG, KHÔNG BẰNG GIÂY (xem BuildTimelineFrameGrid).
  // Nền `color` phát khung khi t < d, nên d = renderFrames/fps cho ĐÚNG renderFrames
  // khung (đo lại từng ca: 60/99/72/165 khung đều khớp) — mốc rơi đúng biên khung nên
  // không có ca nhập nhằng dấu phẩy động.
  //
  // PHẢI LÀ ĐÚNG renderFrames/fps, KHÔNG được trừ bớt: `concat` dời segment sau đi một
  // đoạn bằng ĐỘ DÀI KHAI BÁO của segment trước, mà cửa sổ `enable` của overlay lại tính
  // bằng GIÂY. Bản sửa đầu trừ nửa khung cho "chắc ăn" -> mỗi segment lùi 1/(2·fps) giây,
  // dồn 3 block là overlay mất khung đầu (đo được: marker vào từ f215 thay vì f214) —
  // đúng loại lỗi mà cả khối này sinh ra để dẹp, chỉ đổi dấu.
  const double renderFpsValue = ParseFpsValue(settings.renderFps);
  const double baseDuration = (item.renderFrames > 0 && renderFpsValue > 0.0)
    ? static_cast<double>(item.renderFrames) / renderFpsValue
    : duration;

  // KEYFRAME clip lane chính (0-based -> start=0). Có keyframe -> scale/rotate/opacity
  // biến thiên theo thời gian (AppendKfTransformFilters) thay cho tĩnh; vị trí lấy theo kf.
  const bool clipKf = HasKeyframeExpr(item.kfScaleExpr, item.kfRotExpr, item.kfOpacityExpr,
                                      item.kfXExpr, item.kfYExpr);
  // Hoạt ảnh có thu phóng/xoay cũng cần chính nhánh đó -> gộp thành MỘT cờ, dùng cho cả
  // việc bỏ bước scale tĩnh phía trước format=rgba (nếu không thì scale HAI lần).
  const bool clipDynTransform = clipKf
    || HasAnimGeomExpr(item.animSxExpr, item.animSyExpr, item.animRotExpr);
  // Đường nhanh YUV (mục 1.3): không nền `color`, không RGBA, không overlay.
  const MainLaneFast fast = MainLaneFastPlan(item, settings, clipKf || clipDynTransform || clipHasAnim,
                                             scaleValue, opacityValue);

  if (!fast.ok) {
    script << "color=c=black:s=" << seqW << "x" << seqH
           << ":d=" << FixedSeconds(baseDuration)
           << ":r=" << settings.renderFps << "[base" << idx << "];\n";
  }

  /* CỬA SỔ CẮT PHẢI ĐỔI SANG TRỤC THỜI GIAN CỦA FILE NGUỒN, VÀ CẮT Ở GIỮA HAI KHUNG.
   *
   * Hai phép sửa, cả hai đều cần (xem khối chú thích ở ExportSettings::videoStart):
   *   (1) `+ settings.videoStart` — `item.start/end` là giờ TIMELINE (0-based), còn `trim`
   *       so với PTS THẬT, mà temp_input.mp4 bắt đầu ở PTS 0.021 (edit list của concat
   *       demuxer). Thiếu bước này thì mỗi block hút vào ĐÚNG MỘT khung của block trước và
   *       vẽ nó bằng hình học của mình -> đúng 1 khung lỗi tại MỖI điểm nối.
   *   (2) `- 0.5/sourceFps` — lùi NỬA KHUNG NGUỒN ở CẢ HAI đầu, để mốc cắt luôn rơi vào
   *       GIỮA hai khung. Mép giữa hai block liền nhau có `block[i].end == block[i+1].start`
   *       và mốc đó trùng ĐÚNG pts của một khung: lệch 1e-7 do dấu phẩy động là khung ấy
   *       lật vào hoặc ra khỏi segment. Đo trên dự án thật: khung 332 ở PTS 5.5388666… so
   *       với mốc 5.538867 — cách nhau 3.3e-7 giây.
   *       PHẢI là nửa khung NGUỒN, không phải nửa khung XUẤT: bản xuất 30fps từ nguồn
   *       59.94fps thì nửa khung xuất (16.7ms) ≈ một khung nguồn, tức lại hút thêm khung.
   *
   * Không đo được nhịp nguồn -> chỉ áp (1). Thà lùi về hành vi cũ ở phần chống dấu phẩy
   * động còn hơn dịch cửa sổ đi một lượng bịa ra. */
  double trimStart = item.start + settings.videoStart;
  double trimEnd = item.end + settings.videoStart;
  if (settings.sourceFps > 0.0) {
    const double halfFrame = 0.5 / settings.sourceFps;
    trimStart -= halfFrame;
    trimEnd -= halfFrame;
  }
  trimStart = std::max(0.0, trimStart);
  // Input mang hình của clip này: 0, hoặc input riêng của dải nguồn chứa nó (xem PlanSourceRanges).
  const int videoInput = localIndex < g_clipVideoInput.size() ? g_clipVideoInput[localIndex] : 0;
  // Chuỗi THỜI GIAN của nhánh clip dựng thành chuỗi riêng: Xoá logo AI phải cho luồng miếng
  // vá đi qua ĐÚNG chuỗi này (xem AppendLogoAiFilters).
  std::ostringstream timing;
  timing << "trim=start=" << FixedSeconds(trimStart) << ":end=" << FixedSeconds(trimEnd)
         << ",setpts=PTS-STARTPTS";
  // TỐC ĐỘ: nén/dãn trục thời gian TRƯỚC bước `fps=` — sau `fps=` thì khung đã bị
  // resample về lưới renderFps rồi, đổi PTS lúc đó là lặp/bỏ khung không đều.
  if (std::abs(item.speedRate - 1.0) >= 1e-4) {
    timing << ",setpts=PTS/" << FormatFilterNumber(item.speedRate);
  }
  timing
         // Chuẩn hoá nguồn về đúng lưới renderFps: nguồn VFR/lệch fps mà overlay
         // lên base CFR sẽ bị lặp/bỏ frame không đều (giật) ở khâu resample ngầm
         << ",fps=" << settings.renderFps;
  // KẸP CẢ NHÁNH CLIP vào đúng renderFrames — nền `color` KHÔNG đủ để chốt độ dài.
  // `overlay` đồng bộ theo framesync và chạy tới input DÀI NHẤT, không dừng ở input
  // thứ nhất (đo được: base 55 khung + clip 56 khung -> ra 56 khung). Mà số khung
  // nhánh clip nhả ra phụ thuộc mốc thời gian THẬT của khung nguồn (nguồn 59.94fps
  // resample về 30), nên nó lúc bằng lúc hơn — chính chỗ này làm hai block trong dự án
  // thật dài thêm 1 khung và đẩy lệch mọi block phía sau.
  // Ngược lại, clip NGẮN hơn thì nền giữ đủ độ dài và overlay lặp khung cuối.
  if (item.renderFrames > 0) {
    timing << ",trim=end_frame=" << item.renderFrames;
  }
  // Đồ thị GPU: nguồn không nhãn được crabgeo đọc theo bt709 (`in_matrix`) thay cho setparams.
  const bool gpuClip = fast.ok && g_gpuGraph;
  script << "[" << videoInput << ":v]" << (gpuClip ? std::string() : UntaggedColorFix(settings.sourceColorUntagged))
         << timing.str();
  if (!item.logoAiDir.empty()) {
    AppendLogoAiFilters(script, item.logoAiDir, item.logoAiRects, item.logoAiT0, timing.str(), "logoaic" + idx + "_");
  } else {
    AppendLogoRemovalFilters(script, item.logoMode, item.logoRects, "logoc" + idx + "_");
  }
  if (gpuClip) {
    /* ĐỒ THỊ GPU (mục 1.21): clip không xoá logo, tầng màu rỗng hoặc chỉ là LUT (BatchGpuEligible).
     * Một crabgeo_cuda thay cả hình học đường nhanh — co nguyên khung nguồn về w×h rồi đặt ở (x, y)
     * trên khung sequence, mẫu màu tính đúng vị trí nên không cần mẹo dời chroma / 4:4:4 / cắt
     * trước như đường CPU (bộ lọc chỉ lấy mẫu phần thấy được). Cỡ + vị trí CÙNG phép tính với
     * MainLaneFastPlan. LUT (BlockGpuLut) áp lên nội dung SAU phép co — như "màu sau khi co" của
     * đường CPU (mục 1.19), tính float từ khung nguồn 10-bit chứ không qua RGB 8-bit. Nguồn giải mã
     * CPU: tải lên sau `trim` (chỉ khung được dùng), trước `tpad` (khung nhân bản ở đuôi là khung
     * GPU, không tải lại). */
    const double s = std::stod(FfmpegDouble(scaleValue));
    const int gw = static_cast<int>(std::max(2.0, std::ceil(settings.sourceWidth * s / 2) * 2));
    const int gh = static_cast<int>(std::max(2.0, std::ceil(settings.sourceHeight * s / 2) * 2));
    const int gx = static_cast<int>((seqW - gw) / 2.0 + std::stod(FfmpegDouble(item.positionX)));
    const int gy = static_cast<int>((seqH - gh) / 2.0 + std::stod(FfmpegDouble(item.positionY)));
    if (!g_gpuMainNvdec) script << ",format=" << GpuUploadFormat(settings.sourcePixFmt) << ",hwupload";
    script << ",tpad=stop=-1:stop_mode=clone,crabgeo_cuda=w=" << gw << ":h=" << gh
           << ":ow=" << seqW << ":oh=" << seqH << ":x=" << gx << ":y=" << gy << ":format=yuv420p";
    if (settings.sourceColorUntagged) script << ":in_matrix=bt709";
    script << GpuLutOptions(BlockGpuLut(item, 0.0)) << ",setsar=1[fc" << idx << "];\n";
    script << "color=c=black:s=" << seqW << "x" << seqH
           << ":d=" << FixedSeconds(baseDuration)
           << ":r=" << settings.renderFps << ",format=yuv420p,hwupload[fk" << idx << "];\n";
    script << "[fc" << idx << "][fk" << idx << "]concat=n=2:v=1:a=0,trim=end_frame=" << item.renderFrames
           << "[v" << idx << "];\n";
    g_fastClipCount++;
    return;
  }
  // Clip lane chính đã setpts 0-based -> LOCALT trừ mốc 0.
  // Lớp Điều chỉnh là tầng THỨ HAI, mặt nạ RỖNG: nó nối sau nhánh mặt nạ của chính block (đã
  // đóng ở tầng đầu), đúng như preview áp lượt 2 lên TOÀN khung. Dựng qua ColorAdjustChain như
  // chuỗi block -> có đủ keyframe eq + trộn cường độ LUT. Tầng theo từng điểm ảnh ở ĐUÔI danh
  // sách chạy sau phép co khi phép co làm nhỏ khung (xem ColorChainIsPointwise).
  const bool colorAfterScale = fast.ok
    ? (fast.shrinks && !fast.scale.empty())
    : (!clipDynTransform && item.videoMaskPath.empty() && scaleValue < 1.0);
  const SplitColorStages color = SplitColorStagesForScale(
    BlockColorStages(item, 0.0, "adjc" + idx + "_", "adjl" + idx + "_"), colorAfterScale);
  if (fast.ok) script << fast.preCrop;
  script << color.pre;
  if (fast.ok) {
    /* Chốt đúng renderFrames khung — việc nền `color` + overlay của đường cũ vẫn làm:
     *  - clip ngắn hơn: `tpad` clone lặp khung cuối MÃI, nên `concat` không bao giờ sang đoạn 2;
     *  - clip không nhả khung nào (mốc cắt ngoài nguồn): tpad hết ngay, `concat` sang dải đen.
     *    `tpad=stop_mode=add` KHÔNG làm được việc này: đầu vào rỗng thì nó cũng không ra khung
     *    nào (đã thử, Gyan 8.1.1) — lúc đó mọi clip phía sau bị xô sớm lên.
     * Dải đen chỉ được kéo khung khi `concat` thật sự sang nó, nên ca thường không tốn gì.
     * `tpad` đứng TRƯỚC hình học (sau chuỗi màu — chuỗi màu có thể theo thời gian): để nhân bản
     * khung cuối, tpad giữ một tham chiếu tới MỌI khung đi qua, nên khung nó nhả ra "không ghi
     * được" và `overlay` đầu tiên phía sau phải chép nguyên khung trước khi trộn. Đứng trước
     * `scale` thì khung ra khỏi scale là bộ đệm mới. Hình học là phép cố định nên nhân bản trước
     * hay sau nó cho ra y hệt (đo: md5 trùng trên 4.320 khung 4K). Đo batch 180 s 4K, 70 phụ đề,
     * `-f null`: 33,2 -> 28,1 s.
     * Có tầng màu chạy sau phép co thì tpad đứng SAU tầng đó (vẫn trước bước đổi định dạng,
     * nên khung ra vẫn là bộ đệm mới): khung nhân bản giữ nguyên màu của khung cuối như cũ. */
    if (color.post.empty()) {
      script << ",tpad=stop=-1:stop_mode=clone" << fast.geometry;
    } else {
      script << fast.scale << color.post << ",tpad=stop=-1:stop_mode=clone" << fast.place;
    }
    script << ",setsar=1," << ClipPixelFormat(settings) << "[fc" << idx << "];\n";
    script << "color=c=black:s=" << seqW << "x" << seqH
           << ":d=" << FixedSeconds(baseDuration)
           << ":r=" << settings.renderFps << "[fk" << idx << "];\n";
    script << "[fc" << idx << "][fk" << idx << "]concat=n=2:v=1:a=0,trim=end_frame=" << item.renderFrames
           << "[v" << idx << "];\n";
    g_fastClipCount++;
    return;
  }
  AppendVideoMaskFilter(script, item.videoMaskPath, "vmc" + idx + "_");
  if (!clipDynTransform) {
    script << ",scale=max(2\\,ceil(iw*" << FfmpegDouble(scaleValue) << "/2)*2)"
           << ":max(2\\,ceil(ih*" << FfmpegDouble(scaleValue) << "/2)*2)";
  }
  script << color.post << ",format=rgba";
  if (item.flipX) {
    script << ",hflip";
  }
  if (item.flipY) {
    script << ",vflip";
  }

  if (clipDynTransform) {
    AppendKfTransformFilters(script, 0.0, item.kfScaleExpr, item.kfRotExpr, item.kfOpacityExpr,
                             item.scale, item.rotation, opacityValue,
                             item.animSxExpr, item.animSyExpr, item.animRotExpr, fitScale);
  } else {
    if (std::abs(rotationRad) > 0.000001) {
      const std::string angle = FfmpegDouble(rotationRad);
      script << ",rotate=" << angle << ":ow=rotw(" << angle << "):oh=roth(" << angle << "):c=black@0";
    }
    if (opacityValue < 0.999) {
      script << ",colorchannelmixer=aa=" << FfmpegDouble(opacityValue);
    }
  }
  // Hoạt ảnh clip lane chính: opacity In/Out qua fade (mốc = thời gian 0-based của clip).
  if (clipHasAnim) {
    if (item.animInDur > 0.001) {
      script << ",fade=t=in:st=" << FfmpegDouble(item.animInStart)
             << ":d=" << FfmpegDouble(item.animInDur) << ":alpha=1";
    }
    if (item.animOutDur > 0.001) {
      script << ",fade=t=out:st=" << FfmpegDouble(item.animOutStart)
             << ":d=" << FfmpegDouble(item.animOutDur) << ":alpha=1";
    }
  }
  script << "[clip" << idx << "];\n";

  // Vùng lộ ra khi clip dịch/thu nhỏ = nền đen (color=c=black) -> "nền xanh nhấp nháy"
  // của preview KHÔNG đi vào export. Vị trí = tâm + posX/Y + offset(t) khi có hoạt ảnh/kf.
  script << "[base" << idx << "][clip" << idx << "]overlay=";
  if (clipKf || clipHasAnim) {
    const std::string xPos = clipKf ? KfOverlayPos(item.kfXExpr, 0.0, item.positionX)
                                    : ("(" + FfmpegDouble(item.positionX) + ")");
    const std::string yPos = clipKf ? KfOverlayPos(item.kfYExpr, 0.0, item.positionY)
                                    : ("(" + FfmpegDouble(item.positionY) + ")");
    const std::string xoff = clipHasAnim ? ("+(" + SubstituteLocalTime(item.animXExpr, 0.0) + ")") : "";
    const std::string yoff = clipHasAnim ? ("+(" + SubstituteLocalTime(item.animYExpr, 0.0) + ")") : "";
    script << "x='(" << seqW << "-w)/2+" << xPos << xoff << "'"
           << ":y='(" << seqH << "-h)/2+" << yPos << yoff << "'";
  } else {
    script << "x=(" << seqW << "-w)/2" << (item.positionX >= 0 ? "+" : "") << FfmpegDouble(item.positionX)
           << ":y=(" << seqH << "-h)/2" << (item.positionY >= 0 ? "+" : "") << FfmpegDouble(item.positionY);
  }
  script << ":format=auto,setsar=1," << ClipPixelFormat(settings) << "[v" << idx << "];\n";
}

bool OverlayNeedsInput(const ExportOverlay& overlay) {
  return overlay.type != "text" && !overlay.assetPath.empty();
}

bool OverlayIsImageLike(const ExportOverlay& overlay) {
  return overlay.assetType == "media_image" || overlay.assetType == "text_image" || overlay.assetType == "shape_image";
}

// Chuỗi frame PNG của hoạt ảnh (image2 sequence) cho text/shape/ảnh: input dùng
// -framerate, KHÔNG -loop/-t; filter bỏ trim vì độ dài sequence đã đúng bằng cửa sổ
// hoạt ảnh. "text_image_seq" giữ để tương thích payload cũ; "image_seq" là tên chung.
bool OverlayIsImageSequence(const ExportOverlay& overlay) {
  return overlay.assetType == "image_seq" || overlay.assetType == "text_image_seq";
}

bool OverlayIsVisual(const ExportOverlay& overlay) {
  return overlay.type == "media" || overlay.type == "text";
}

bool OverlayHasAudio(const ExportOverlay& overlay) {
  return (overlay.type == "audio" || (overlay.type == "media" && overlay.hasAudio)) && !overlay.muted && OverlayNeedsInput(overlay);
}

bool TextOverlaySupported() {
  return HasFfmpegFilter("drawtext");
}

std::string FilterEscapeText(const std::string& text) {
  std::string out;
  for (char ch : text) {
    switch (ch) {
      case '\\': out += "\\\\"; break;
      case '\'': out += "\\'"; break;
      case ':': out += "\\:"; break;
      case '\n': out += "\\n"; break;
      case '\r': break;
      default: out.push_back(ch); break;
    }
  }
  return out;
}

std::string HexColorForDrawText(std::string color) {
  if (color.size() == 7 && color[0] == '#') return "0x" + color.substr(1);
  return "0xffffff";
}

/* MỐC MỞ CỬA SỔ `enable` LÙI NỬA KHUNG — đối xứng với `seqEndTrim` ở đầu kia.
 *
 * `between(t, start, end)` so `t` của khung nền với một CON SỐ IN RA 6 CHỮ SỐ. `t` thì
 * do `concat` cộng dồn độ dài từng segment (bản thân chúng cũng là số in ra 6 chữ số),
 * nên khung ĐẦU TIÊN của một block có thể rơi thấp hơn `start` vài phần 1e-16 — đủ để
 * `between` trả 0 và overlay MẤT ĐÚNG KHUNG ĐẦU của block. Đo được: marker vào từ f215
 * thay vì f214, dù `concat` in ra t = 7.133333 khớp từng chữ số với `start`.
 *
 * Nới nửa khung KHÔNG thể kéo overlay sang khung trước: khung đó cách một khung TRÒN,
 * xa gấp đôi khoảng nới. Và với chuỗi khung thì khung nội dung đầu tiên vẫn nằm ở đúng
 * `start`, nên nới cửa sổ không đổi thứ được vẽ — chỉ thôi vứt mất nó.
 */
// Video/ảnh tĩnh lớp phủ đặt sớm chừng này (giây) để ca "hoà" với khung nền luôn rơi đúng phía —
// xem writeSetpts ở WriteVisualOverlayFilter.
constexpr double kOverlayTieEpsilon = 1e-4;

double OverlayEnableStart(double start, const ExportSettings& settings) {
  const double fps = ParseFpsValue(settings.renderFps);
  if (!(fps > 0.0)) return start;
  return std::max(0.0, start - 0.5 / fps);
}

/* ===== CHIA LƯỢT XUẤT THEO THỜI GIAN KHI DỰ ÁN CÓ LỚP PHỦ ======================
 *
 * VÌ SAO PHẢI CHIA (đo thật, không suy đoán). Mọi lớp phủ được nối thành MỘT chuỗi
 * `overlay` duy nhất: [mainv] -> ov0 -> ov1 -> … Mỗi khung hình đầu ra phải đi qua TOÀN BỘ
 * chuỗi, kể cả những lớp phủ đang tắt. Đo trên video 30s 720p, mỗi lớp phủ hiện 0,8s:
 *     50 lớp phủ -> 1,3s (x23,7 realtime)
 *    131 lớp phủ -> 1,5s (x20,3)
 *    300 lớp phủ -> 3,5s (x8,7)
 *    600 lớp phủ -> 13,8s (x2,2)
 *   1200 lớp phủ -> dòng lệnh 73.911 ký tự, vượt cả trần 32.766 của CreateProcess
 * Chi phí đi theo (số khung × số lớp phủ). Ngoại suy cho video 3 GIỜ với ~1.500 phụ đề:
 * 324.000 khung × 1.500 ≈ 486 triệu lượt -> khoảng 3,5 GIỜ chỉ để duyệt chuỗi, chưa tính
 * encode. Gỡ trần dòng lệnh KHÔNG cứu được ca này; phải cắt chuỗi ngắn lại.
 *
 * Chia theo THỜI GIAN (không phải theo clip): một dự án phụ đề điển hình chỉ có ĐÚNG MỘT
 * clip dài trên lane chính (dự án đo được: 1 interval, 964s, 131 phụ đề), nên cách chia
 * theo số interval sẵn có không cắt được gì.
 *
 * CẮT Ở ĐÂU MỚI AN TOÀN — ba điều kiện, thiếu một là hình/hiệu ứng sai:
 *   1. đúng BIÊN KHUNG (xem BuildTimelineFrameGrid): cắt giữa khung là lệch lưới khung;
 *   2. không cắt vào giữa một clip CÓ hoạt ảnh/keyframe: biểu thức của clip neo theo thời
 *      gian CỤC BỘ của clip, cắt đôi là nửa sau chạy lại hiệu ứng từ đầu;
 *   3. không cắt qua một lớp phủ CÓ hoạt ảnh/keyframe: cùng lý do.
 * Lớp phủ TĨNH (ảnh phụ đề, hình khối, watermark) nằm vắt qua mốc cắt thì CẮT ĐƯỢC — nội
 * dung nó không đổi theo thời gian nên xén đầu/đuôi cho vừa batch là tương đương hệt.
 * Không tìm được mốc an toàn thì batch dài thêm; xấu nhất là quay về đúng hành vi cũ.
 */
constexpr double kOverlayBatchTargetSeconds = 180.0;
// Dưới ngưỡng này thì chia batch chỉ tổ tốn thêm lượt spawn ffmpeg mà không lợi gì.
constexpr double kOverlayBatchMinTotalSeconds = 240.0;
// Dò xa nhất bao nhiêu để tìm một mốc cắt an toàn trước khi bỏ cuộc (xem vòng dò bên dưới).
constexpr double kOverlayBatchScanSeconds = 90.0;
/* Batch ngắn nhất khi chia để chạy SONG SONG (mục 1.8): mỗi lượt ffmpeg tốn ~0,5–1 s khởi động
 * (dò, mở bộ giải mã, seek về keyframe trước mốc, Defender quét PNG lần đầu). */
constexpr double kParallelMinBatchSeconds = 8.0;
// Lớp phủ tĩnh bị xén ở cuối batch kéo dài thêm chừng này qua mép (xem OverlaysForBatch).
constexpr double kBatchOverlayTailSeconds = 1.0;

bool HasAnyExpr(std::initializer_list<const std::string*> exprs) {
  for (const auto* expr : exprs) {
    if (expr && !expr->empty()) return true;
  }
  return false;
}

// Clip có thuộc tính biến thiên theo thời gian -> KHÔNG được cắt đôi.
bool IntervalIsTimeVarying(const ExportInterval& item) {
  /* Chuỗi màu có biểu thức / lệnh theo thời gian bên trong (ColorChainTimeVarying): lớp Điều
   * chỉnh phủ MỘT PHẦN block (`enable='between(LOCALT,..)'`), keyframe màu qua sendcmd… Cắt
   * đôi block như vậy là nửa sau chạy lại từ t=0 và cửa sổ thời gian rơi sai chỗ. */
  if (ColorChainTimeVarying(item.adjustLayerFilters) || ColorChainTimeVarying(item.adjustFilters)
      || ColorChainTimeVarying(item.adjustFiltersPost) || ColorChainTimeVarying(item.adjustLayerFiltersPost)
      || ExtraAdjustLayersTimeVarying(item.extraAdjustLayers)) {
    return true;
  }
  return HasAnyExpr({&item.animXExpr, &item.animYExpr, &item.animSxExpr, &item.animSyExpr,
                     &item.animRotExpr, &item.kfXExpr, &item.kfYExpr, &item.kfScaleExpr,
                     &item.kfRotExpr, &item.kfOpacityExpr, &item.kfVolumeExpr,
                     &item.adjEqContrastExpr, &item.adjEqBrightnessExpr, &item.adjEqSaturationExpr,
                     &item.adjustLutMixExpr, &item.adjLayerEqContrastExpr, &item.adjLayerEqBrightnessExpr,
                     &item.adjLayerEqSaturationExpr, &item.adjustLayerLutMixExpr});
}

/* Lớp phủ có thuộc tính biến thiên theo thời gian -> không được cắt qua nó.
 * Chuỗi khung hoạt ảnh (`image_sequence`) cũng tính là biến thiên: nội dung nó ĐỔI theo
 * khung, xén đầu là lệch pha cả chuỗi. */
bool OverlayIsTimeVarying(const ExportOverlay& overlay) {
  if (OverlayIsImageSequence(overlay)) return true;
  if (!OverlayIsImageLike(overlay)) return true;      // video/audio: có trục thời gian riêng
  if (overlay.animInDur > 0.001 || overlay.animOutDur > 0.001) return true;
  // Chuỗi màu CỦA CHÍNH lớp phủ cũng có thể mang LOCALT / sendcmd (xem ColorChainTimeVarying).
  if (ColorChainTimeVarying(overlay.adjustFilters) || ColorChainTimeVarying(overlay.adjustFiltersPost)) return true;
  if (!overlay.adjustLayerFilters.empty() || !overlay.adjLayerEqContrastExpr.empty()
      || !overlay.adjLayerEqBrightnessExpr.empty() || !overlay.adjLayerEqSaturationExpr.empty()
      || !overlay.adjustLayerLutMixExpr.empty() || !overlay.extraAdjustLayers.empty()) return true;
  return HasAnyExpr({&overlay.animXExpr, &overlay.animYExpr, &overlay.animSxExpr,
                     &overlay.animSyExpr, &overlay.animRotExpr, &overlay.kfXExpr,
                     &overlay.kfYExpr, &overlay.kfScaleExpr, &overlay.kfRotExpr,
                     &overlay.kfOpacityExpr, &overlay.kfVolumeExpr, &overlay.adjustLutMixExpr,
                     &overlay.adjEqContrastExpr, &overlay.adjEqBrightnessExpr,
                     &overlay.adjEqSaturationExpr});
}

double SequenceDuration(const std::vector<ExportInterval>& intervals, size_t offset, size_t count) {
  double duration = 0.0;
  for (size_t i = 0; i < count; i++) {
    const auto& item = intervals[offset + i];
    duration += IntervalSequenceDuration(item);
  }
  return duration;
}

/* Một lượt render: danh sách clip ĐÃ CẮT cho vừa cửa sổ, và mốc bắt đầu của cửa sổ đó trên
 * trục sequence. `sequenceStart` là thứ dùng để dời lớp phủ về gốc toạ độ của batch. */
struct OverlayBatch {
  std::vector<ExportInterval> intervals;
  double sequenceStart = 0.0;
  double sequenceDuration = 0.0;
};

/* Cắt một clip tại khung thứ `frame` (tính từ đầu clip). Trả về nửa sau; `item` bị rút lại
 * thành nửa trước. Cắt theo KHUNG chứ không theo giây: tổng `renderFrames` của hai nửa bằng
 * đúng số cũ, nên lưới khung của cả lượt xuất không xê dịch một khung nào. */
ExportInterval SplitIntervalAtFrame(ExportInterval& item, long long frame, double fps) {
  ExportInterval tail = item;
  const double sourceSpan = (static_cast<double>(frame) / fps) * item.speedRate;
  const double cut = item.start + sourceSpan;
  item.end = cut;
  item.renderFrames = frame;
  tail.start = cut;
  tail.renderFrames -= frame;
  return tail;
}

/* Lớp phủ có chạm vào cửa sổ [from, to] không. Nới hai đầu nửa khung: cửa sổ `enable` của
 * lớp phủ cũng được nới như vậy (xem OverlayEnableStart), bỏ sót là mất một khung đầu. */
bool OverlayTouchesWindow(const ExportOverlay& overlay, double from, double to, double fps) {
  const double pad = (fps > 0.0) ? (1.0 / fps) : 0.04;
  const double start = overlay.timelineStart - pad;
  const double end = overlay.timelineStart + std::max(0.05, overlay.duration) + pad;
  return end > from && start < to;
}

// Lớp phủ nằm VẮT QUA mốc `at` (không phải chỉ chạm đúng hai đầu).
bool OverlayStraddles(const ExportOverlay& overlay, double at, double fps) {
  const double pad = (fps > 0.0) ? (1.0 / fps) : 0.04;
  return (overlay.timelineStart - pad) < at
      && (overlay.timelineStart + std::max(0.05, overlay.duration) + pad) > at;
}

/* Chia cả lượt xuất thành các cửa sổ thời gian cắt được AN TOÀN (ba điều kiện ở khối chú
 * thích đầu mục). Trả về một phần tử duy nhất = không cắt được chỗ nào, nơi gọi chạy y như
 * bản cũ. */
std::vector<OverlayBatch> PlanOverlayBatches(
  const std::vector<ExportInterval>& intervals,
  const std::vector<ExportOverlay>& overlays,
  const ExportSettings& settings,
  double targetSeconds = kOverlayBatchTargetSeconds,
  double minTotalSeconds = kOverlayBatchMinTotalSeconds,
  bool splitInsideClips = true
) {
  std::vector<OverlayBatch> batches;
  const double fps = ParseFpsValue(settings.renderFps);
  const double total = SequenceDuration(intervals, 0, intervals.size());
  OverlayBatch single;
  single.intervals = intervals;
  single.sequenceStart = 0.0;
  single.sequenceDuration = total;
  if (!(fps > 0.0) || total < minTotalSeconds) return {single};

  OverlayBatch current;
  current.sequenceStart = 0.0;
  double cursor = 0.0;              // mốc sequence của đầu clip đang xét
  double batchStart = 0.0;

  /* ĐỘ DÀI THẬT CỦA MỘT ĐOẠN KHI GHÉP LÀ renderFrames/fps, KHÔNG PHẢI (end-start)/speed.
   * Hai số lệch nhau tới nửa khung mỗi đoạn (xem BuildTimelineFrameGrid), và `concat` dời
   * đoạn sau đi đúng ĐỘ DÀI KHAI BÁO của đoạn trước. Lấy nhầm số ở đây thì `sequenceStart`
   * của batch trôi dần so với thực tế, mà `sequenceStart` chính là số dùng để dời phụ đề về
   * gốc toạ độ batch — tức mọi phụ đề từ batch thứ hai trở đi lệch giờ, càng về cuối càng
   * lệch. Dự án một clip không lộ ra; dự án lọc theo kịch bản (hàng chục clip) thì lộ. */
  auto placedSeconds = [&](const ExportInterval& item) {
    return (item.renderFrames > 0) ? (static_cast<double>(item.renderFrames) / fps)
                                   : IntervalSequenceDuration(item);
  };

  /* Lọc TRƯỚC những lớp phủ biến thiên. Chỉ chúng mới chặn được một mốc cắt, mà
     OverlayIsTimeVarying() phải so hàng chục chuỗi — gọi nó lại cho từng khung ứng viên,
     cho từng lớp phủ, là hàng trăm triệu phép so vô ích trên dự án dài. */
  std::vector<const ExportOverlay*> blocking;
  for (const auto& overlay : overlays) {
    /* Chỉ lớp phủ CÓ HÌNH chặn mốc cắt: batch chỉ dựng hình (FilterScriptMode::VideoOnly), tiếng
     * là MỘT lượt liền cho cả phim. Trước đây lớp nhạc nền phủ cả bài ("Yêu Con 1": 0–37,8 s)
     * chặn mọi mốc cắt, nên dự án không chia được batch nào. */
    if (OverlayIsVisual(overlay) && OverlayIsTimeVarying(overlay)) blocking.push_back(&overlay);
  }
  auto safeToCutAt = [&](double at) {
    for (const auto* overlay : blocking) {
      if (OverlayStraddles(*overlay, at, fps)) return false;
    }
    return true;
  };
  auto closeBatch = [&](double at) {
    current.sequenceStart = batchStart;
    current.sequenceDuration = at - batchStart;
    batches.push_back(std::move(current));
    current = OverlayBatch();
    batchStart = at;
  };

  for (const auto& source : intervals) {
    ExportInterval item = source;
    double itemStart = cursor;
    cursor += placedSeconds(source);

    /* Cắt BÊN TRONG một clip chỉ được phép khi clip đó không có hiệu ứng biến thiên. Vòng
     * lặp: chừng nào clip hiện tại còn vắt qua mốc cắt mong muốn thì xén một khúc ra. */
    while (splitInsideClips && !IntervalIsTimeVarying(item) && item.renderFrames > 1) {
      const double want = batchStart + targetSeconds;
      const double itemEnd = itemStart + (static_cast<double>(item.renderFrames) / fps);
      if (want >= itemEnd) break;                       // mốc mong muốn nằm sau clip này
      long long frame = std::llround((want - itemStart) * fps);
      /* Dò tới trước tìm biên khung KHÔNG cắt qua lớp phủ biến thiên nào, nhưng CHỈ TRONG
         MỘT CỬA SỔ. Quét hết clip là trường hợp xấu 324.000 khung (phim 3 giờ) × số lớp phủ
         chặn — tốn hàng chục giây mà kết cục vẫn là không tìm được. Quá cửa sổ thì coi như
         chỗ này không cắt được: batch dài thêm, chậm hơn nhưng vẫn đúng. */
      const long long limit = std::min<long long>(item.renderFrames - 1,
                                                  frame + std::llround(kOverlayBatchScanSeconds * fps));
      long long chosen = -1;
      for (long long f = std::max<long long>(1, frame); f <= limit; f += 1) {
        if (safeToCutAt(itemStart + static_cast<double>(f) / fps)) { chosen = f; break; }
      }
      if (chosen < 0) break;                            // không còn chỗ an toàn trong clip này
      ExportInterval tail = SplitIntervalAtFrame(item, chosen, fps);
      current.intervals.push_back(item);
      closeBatch(itemStart + static_cast<double>(chosen) / fps);
      itemStart += static_cast<double>(chosen) / fps;
      item = tail;
    }
    current.intervals.push_back(item);
    // Biên giữa hai clip cũng là một mốc cắt hợp lệ, nếu batch đã đủ dài và mốc đó an toàn.
    if (cursor - batchStart >= targetSeconds && safeToCutAt(cursor)
        && cursor < total - 0.5) {
      closeBatch(cursor);
    }
  }
  // `cursor` là tổng ĐÃ TÍNH THEO KHUNG (xem placedSeconds) — dùng nó chứ không dùng
  // `total`, để mốc đóng batch cuối khớp với độ dài thật của bản ghép.
  if (!current.intervals.empty()) closeBatch(cursor);
  if (batches.size() <= 1) return {single};
  return batches;
}

/* Lớp phủ của một batch: chỉ những cái chạm vào cửa sổ, đã DỜI về gốc toạ độ của batch và
 * đánh SỐ INPUT LẠI theo batch (filtergraph tham chiếu input bằng chỉ số, không bằng tên).
 *
 * Lớp phủ TĨNH vắt qua hai đầu thì xén cho vừa cửa sổ — nội dung không đổi theo thời gian
 * nên xén là tương đương hệt. Lớp phủ BIẾN THIÊN không bao giờ rơi vào đây: PlanOverlayBatches
 * đã không đặt mốc cắt qua chúng. */
std::vector<ExportOverlay> OverlaysForBatch(
  const std::vector<ExportOverlay>& overlays,
  const OverlayBatch& batch,
  const ExportSettings& settings
) {
  const double fps = ParseFpsValue(settings.renderFps);
  const double from = batch.sequenceStart;
  const double to = batch.sequenceStart + batch.sequenceDuration;
  std::vector<ExportOverlay> out;
  int nextInput = 0;
  for (const auto& source : overlays) {
    // Batch chỉ dựng hình: lớp phủ chỉ-tiếng đi lượt tiếng (OverlaysForAudioPass), không nạp ở đây.
    if (!OverlayIsVisual(source)) continue;
    if (!OverlayTouchesWindow(source, from, to, fps)) continue;
    ExportOverlay overlay = source;
    const double start = overlay.timelineStart - from;
    const double end = start + std::max(0.05, overlay.duration);
    const double clippedStart = std::max(0.0, start);
    const double clippedEnd = std::min(batch.sequenceDuration, end);
    if (clippedEnd - clippedStart < 1e-6) continue;
    overlay.timelineStart = clippedStart;
    overlay.duration = clippedEnd - clippedStart;
    /* Xén ở CUỐI batch thì cho dài dư qua mép (nội dung tĩnh nên vô hại; batch hết thì thôi).
     * Xén khít mép là mất khung nền CUỐI của batch: luồng ảnh chạy theo nhịp của chính nó (PNG
     * 25 khung/s), khung ảnh cuối ở mép − 1/25 s, sau đó framesync coi lớp phủ đã hết
     * (eof_action=pass) — khung nền ở mép − 1/30 s mất lớp phủ, bản một lượt thì không
     * (tests/scripts/export_parallel.js: khung 419 của mốc cắt 14 s). */
    if (end > batch.sequenceDuration + 1e-6) overlay.duration += kBatchOverlayTailSeconds;
    if (OverlayNeedsInput(overlay)) overlay.assetInputIndex = nextInput++;
    out.push_back(overlay);
  }
  return out;
}

/* Lớp phủ cho lượt render CHỈ-TIẾNG: chỉ những cái thật sự có tiếng, đánh số input lại.
 *
 * ĐÃ TRẢ GIÁ: bản đầu truyền NGUYÊN bộ lớp phủ vào lượt chỉ-tiếng. `OverlayNeedsInput()`
 * trả true cho MỌI lớp phủ không phải text có đường dẫn — tức là cả ảnh phụ đề — nên lượt
 * ấy nạp đủ 720 ảnh PNG bằng `-i`, vừa vô nghĩa (không ảnh nào có rãnh tiếng) vừa đẩy dòng
 * lệnh vượt trần y như lỗi ban đầu. Đo được: 10 phút phim chạy tốt, 30 phút trở lên hỏng
 * sạch — mà thông báo lỗi lại chỉ vào lượt render tiếng, không chỉ vào lớp phủ. */
std::vector<ExportOverlay> OverlaysForAudioPass(const std::vector<ExportOverlay>& overlays) {
  std::vector<ExportOverlay> out;
  int nextInput = 0;
  for (const auto& source : overlays) {
    if (!OverlayHasAudio(source)) continue;
    ExportOverlay overlay = source;
    overlay.assetInputIndex = nextInput++;
    out.push_back(overlay);
  }
  return out;
}

void WriteTextOverlayFilter(
  std::ofstream& script,
  const ExportOverlay& overlay,
  const std::string& inputLabel,
  const std::string& outputLabel,
  const ExportSettings& settings
) {
  const int seqW = settings.width > 0 ? settings.width : 1920;
  const int seqH = settings.height > 0 ? settings.height : 1080;
  const double opacity = ClampDouble(overlay.opacity / 100.0, 0.0, 1.0);
  const double start = overlay.timelineStart;
  const double end = overlay.timelineStart + overlay.duration;
  script << inputLabel << "drawtext=";
  if (!overlay.fontFile.empty() && fs::exists(overlay.fontFile)) {
    script << "fontfile='" << FilterEscapeText(overlay.fontFile) << "':";
  }
  script << "text='" << FilterEscapeText(overlay.text)
         << "':fontsize=" << overlay.fontSize
         << ":fontcolor=" << HexColorForDrawText(overlay.color) << "@" << FfmpegDouble(opacity)
         << ":x=(" << seqW << "-text_w)/2" << (overlay.positionX >= 0 ? "+" : "") << FfmpegDouble(overlay.positionX)
         << ":y=(" << seqH << "-text_h)/2" << (overlay.positionY >= 0 ? "+" : "") << FfmpegDouble(overlay.positionY)
         << ":enable='between(t," << FfmpegDouble(OverlayEnableStart(start, settings)) << "," << FfmpegDouble(end) << ")'"
         << outputLabel << ";\n";
}

/* ---------------------------------------------------------------------------
 * LÀM MỀM MÉP MIẾNG VÁ (feather).
 *
 * VÌ SAO CẦN: miếng vá Retouch là pixel do TRÌNH DUYỆT giải mã (thẻ <video> -> canvas),
 * còn phần khung quanh nó là pixel do FFMPEG giải mã CÙNG file đó. Hai bộ giải mã cho
 * kết quả lệch nhau một chút — đo trên nguồn thật của người dùng (1080x1920, bt709/tv,
 * `-c copy` nên không phải do mã hoá lại): trung bình khung LỆCH +2.28 / +1.78 / +2.12
 * trên R/G/B, và lệch ĐỀU trên khắp khung (64/64 ô lưới đều +2.1..+2.4). Ramp xám thuần
 * thì hai bên khớp tuyệt đối, nên đây là khác biệt ở đường chroma/ma trận của bộ giải mã
 * chứ không phải ở dải hay gamma.
 *
 * 2/255 vốn không nhìn ra, NHƯNG chuỗi chỉnh màu khuếch đại nó: với bộ LUT + tương phản
 * + "whites" mà dự án thật đang dùng, độ dốc vùng sáng > 1 nên bậc nhảy tại mép miếng vá
 * đủ để mắt bắt được thành MỘT HÌNH CHỮ NHẬT quanh khuôn mặt.
 *
 * VÌ SAO CHỮA BẰNG MÉP MỀM CHỨ KHÔNG BẰNG BÙ MÀU: sai lệch đến từ bộ giải mã của
 * Chromium — đổi theo phiên bản, theo máy, theo việc có giải mã phần cứng hay không.
 * Bù một hằng số đo hôm nay là sai vào hôm khác. Mép mềm thì KHÔNG phụ thuộc nguyên
 * nhân: bậc nhảy bao nhiêu cũng bị trải ra thành dốc thoải và mắt không thấy mép. Nó
 * đồng thời che luôn phần lệch do JPEG và do thứ tự "phóng rồi LUT" vs "LUT rồi phóng".
 *
 * Alpha = khoảng cách tới mép gần nhất / featherPx, kẹp về [0,1]. Chỉ đụng kênh ALPHA;
 * R/G/B đi qua nguyên vẹn.
 *
 * DỐC MÉP TÍNH MỘT LẦN (mục 1.6): trước đây `geq` tính bốn biểu thức cho TỪNG điểm ảnh của TỪNG
 * khung (r/g/b chỉ là chép lại), dù dốc mép không đổi theo thời gian — cỡ khung ở đây cố định
 * (sau phép co tĩnh, trước mọi biến đổi theo thời gian). Nay: tách một khung, `geq` vẽ dốc mép
 * lên KHUNG ĐÓ (một lần), rồi `blend=multiply` nhân vào alpha của mọi khung — nhánh dốc chỉ có
 * một khung nên framesync lặp lại khung cuối của nó (repeatlast), đúng lối mặt nạ màu ở
 * AppendColorAdjustFilters. Đo trên "Yêu Con 1" (2 miếng vá ~510×490, 294 khung): ~5 s.
 * Ở gbrap như geq cũ (geq chỉ nhận RGB tách mặt phẳng): đổi định dạng ra là đổi luôn đường
 * chuyển đổi của các filter phía sau (xem KfOpacityFilter). Env tắt: CRABBYCUT_EXPORT_FEATHER1=0.
 * ------------------------------------------------------------------------- */
void AppendFeatherAlpha(std::ofstream& script, int featherPx) {
  if (featherPx <= 0) return;
  const std::string f = std::to_string(featherPx);
  const char* env = std::getenv("CRABBYCUT_EXPORT_FEATHER1");
  if (env && std::string(env) == "0") {
    // Dấu nháy đơn đã bảo vệ dấu phẩy bên trong biểu thức — đừng escape thêm.
    script << ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'"
           << ":a='alpha(X,Y)*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/" << f << ")'";
    return;
  }
  const std::string t = "fth" + std::to_string(++g_filterAuxSeq) + "_";
  script << ",format=gbrap,split[" << t << "s][" << t << "m];\n";
  script << "[" << t << "m]trim=end_frame=1,alphaextract"
         << ",geq=lum='255*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/" << f << ")'[" << t << "r];\n";
  script << "[" << t << "s]split[" << t << "c][" << t << "x];\n";
  script << "[" << t << "x]alphaextract[" << t << "a];\n";
  script << "[" << t << "a][" << t << "r]blend=all_mode=multiply[" << t << "am];\n";
  script << "[" << t << "c][" << t << "am]alphamerge[" << t << "k];\n";
  script << "[" << t << "k]null";
}

/* ===== GHÉP LỚP PHỦ Ở YUV (mục 1.5, docs/KE_HOACH_TOI_UU_EXPORT_WIN.md) =====
 *
 * `overlay=format=auto` với lớp phủ RGBA kéo CẢ luồng chính sang RGBA (log: yuv420p -> rgba):
 * mỗi khung 4K là 33 MB RGBA đi qua cả chuỗi lớp phủ bằng mã C, rồi mới đổi về yuv420p ở cuối.
 * Nay lớp phủ vẫn dựng ở RGBA (feather, độ mờ, lật… nhận RGBA), đổi sang yuva420p bằng ma trận
 * BT.709/tv NÓI RÕ — cùng ma trận mà luồng chính đang mang ở liên kết này (FFmpeg 8 thương
 * lượng không gian màu theo liên kết, và `overlay` ép mọi đầu vào về chung một không gian) —
 * rồi `overlay=format=yuv420` (có SIMD SSE4.1). Luồng chính ở yuv420p suốt chuỗi.
 *
 * TOẠ ĐỘ LẺ: ở yuv420 `overlay` làm tròn x/y XUỐNG số chẵn (normalize_xy), còn RGBA đặt được ở
 * mọi số nguyên. Giữ đúng vị trí bằng cách đệm lớp phủ 1 px TRONG SUỐT ở mép trái/trên khi toạ
 * độ lẻ (`pad`, tính theo chính `iw` của lớp phủ), rồi đặt ở toạ độ chẵn ngay trước đó. Toạ độ
 * cũ = trunc((W−w)/2 + dx) — đúng phép cắt mà `overlay` RGBA đang làm ((int) về phía 0).
 *
 * CHỈ lớp phủ đứng yên và không xoay: vị trí theo keyframe/hoạt ảnh đổi từng khung, mà phần đệm
 * chẵn/lẻ chốt một lần lúc cấu hình; xoay làm bề rộng thành lẻ. Lớp phủ đó vẫn ghép RGBA như cũ,
 * kèm một phép đổi về yuv420p BT.709 NGAY sau nó để phần còn lại của chuỗi ở YUV.
 * ProRes (yuv422p10) giữ đường cũ.
 *
 * BẬT MẶC ĐỊNH (người dùng chốt 2026-09-29), tắt bằng CRABBYCUT_EXPORT_YUVCOMP=0. Bản xuất gần bản
 * chuẩn hơn hẳn (Bin Tom 52,5 so với 40,3 dB) nên lệch khỏi bản cũ quá ngưỡng "PSNR mới/cũ ≥ 45 dB"
 * cũ — người dùng chọn nới ngưỡng đó cho trường hợp này (xem mục 1.5 của kế hoạch).
 * MÀU Ở MÉP: đổi thẳng RGBA -> yuva420p lấy trung bình màu của khối 2×2 GỒM CẢ điểm ảnh trong suốt
 * (màu đen) -> mép chữ màu bị pha loãng (chữ vàng: U 41,6 so với 46,1 dB của đường cũ). Đã chữa
 * bằng AlphaWeightedYuva420 (44,8 dB). `alpha=premultiplied` của overlay làm luma tệ hơn
 * (39,3 dB). */
bool YuvCompositeEnabled(const ExportSettings& settings) {
  if (settings.codec == "prores") return false;
  const char* env = std::getenv("CRABBYCUT_EXPORT_YUVCOMP");
  if (!env) return true;
  const std::string value = env;
  return !(value == "0" || value == "false" || value == "off");
}

/* MÀU Ở MÉP KHI HẠ LỚP PHỦ CÓ ALPHA XUỐNG 4:2:0 (mục 1.5).
 *
 * `overlay` ở yuv420 trộn mẫu màu theo alpha TRUNG BÌNH của khối 2×2: kết quả = Ā·U + (1−Ā)·nền.
 * Muốn bằng đường cũ (ghép RGBA ở cỡ đầy đủ rồi mới hạ mẫu) thì U của lớp phủ phải là trung bình
 * CÓ TRỌNG SỐ ALPHA của khối: Σ aᵢUᵢ / Σ aᵢ. Phép đổi thẳng RGBA -> yuva420p thì lấy trung bình
 * THƯỜNG, gồm cả điểm ảnh trong suốt (canvas lưu chúng là đen) -> mép chữ màu bị pha loãng hai lần.
 * Chuỗi dưới tính đúng trọng số: premultiply -> thu nửa cỡ (hộp 2×2) -> unpremultiply, ở 16-bit để
 * vùng đục không lệch 1 mức (premultiply 8-bit nhân (U−128)·a >> 8, tức ×255/256), rồi ghép với
 * luma + alpha đầy đủ bằng `mergeplanes`. Đo (chữ vàng khử răng cưa trên nền xanh đậm, so bản
 * chuẩn): kênh U 41,6 dB -> 44,8 dB (đường cũ 46,1; phần còn lệch là nhân hạ mẫu hộp 2×2 so với
 * nhân của swscale). Luma và V như cũ. Lớp phủ VIDEO đục hoàn toàn thì không cần. */
// Env tắt riêng cho phép chữa màu mép (A/B): CRABBYCUT_EXPORT_ALPHACHROMA=0.
bool AlphaChromaEnabled() {
  const char* env = std::getenv("CRABBYCUT_EXPORT_ALPHACHROMA");
  if (!env) return true;
  const std::string value = env;
  return !(value == "0" || value == "false" || value == "off");
}

std::string AlphaWeightedYuva420(const std::string& tag) {
  const std::string p = tag + "yp";
  const std::string q = tag + "yq";
  const std::string p8 = tag + "y8";
  const std::string c8 = tag + "yc";
  return ",split[" + p + "][" + q + "];\n"
    "[" + p + "]scale=out_color_matrix=bt709:out_range=tv,format=yuva444p[" + p8 + "];\n"
    "[" + q + "]scale=out_color_matrix=bt709:out_range=tv,format=yuva444p16le,premultiply=inplace=1"
    ",scale=w=iw/2:h=ih/2:flags=area,unpremultiply=inplace=1,scale=sws_dither=none,format=yuva444p[" + c8 + "];\n"
    "[" + p8 + "][" + c8 + "]mergeplanes=map0s=0:map0p=0:map1s=1:map1p=1:map2s=1:map2p=2:map3s=0:map3p=3"
    ":format=yuva420p";
}

/* ẢNH TĨNH XỬ LÝ MỘT LẦN (mục 1.5; cùng ý với 1.7b). Env tắt: CRABBYCUT_EXPORT_STILL1=0.
 *
 * `-loop 1 -i ảnh.png` cho 25 khung/giây, và MỖI khung đi lại đủ: giải mã PNG, scale, format,
 * pad, đổi màu… cho một tấm ảnh không hề đổi. Nay input chỉ ra đúng MỘT khung, chuỗi xử lý chạy
 * một lần, rồi `loop=loop=-1:size=1` lặp khung đã xử lý (chỉ tăng tham chiếu, không chép), và
 * trim/setpts dời ra sau đó. Đã kiểm: dãy PTS ra y hệt `-loop 1` (34/34 khung).
 * Chỉ cho ảnh tĩnh THẬT: không hoạt ảnh/keyframe/lớp Điều chỉnh (OverlayIsTimeVarying), không
 * chuỗi màu (biểu thức có thể mang LOCALT), không mặt nạ video (`movie=` + blend). */
bool StillOnceEnabled() {
  const char* env = std::getenv("CRABBYCUT_EXPORT_STILL1");
  if (!env) return true;
  const std::string value = env;
  return !(value == "0" || value == "false" || value == "off");
}

bool OverlayStillOnce(const ExportOverlay& overlay) {
  return StillOnceEnabled() && OverlayIsImageLike(overlay) && !OverlayIsImageSequence(overlay)
      && !OverlayIsTimeVarying(overlay)
      && overlay.adjustFilters.empty() && overlay.adjustFiltersPost.empty()
      && overlay.adjustMaskPath.empty() && overlay.videoMaskPath.empty();
}

/* GIỮ KHUNG CUỐI CỦA CHUỖI KHUNG HOẠT ẢNH BẰNG KHUNG NHÂN BẢN, KHÔNG BẰNG eof_action=repeat.
 *
 * Chuỗi PNG của item hoạt ảnh phủ trọn cửa sổ In→Hold→Out, nhưng `setpts=…+start/TB` cắt phần lẻ
 * (D2TS) nên cả chuỗi có thể sớm lên gần một khung và hết TRƯỚC mép cửa sổ 1–3 khung nền (nay chuỗi
 * đặt đúng sớm ¼ khung trên timebase µs, xem writeSetpts ở WriteVisualOverlayFilter; K dưới đây tính
 * cho trường hợp sớm một khung nên vẫn dư). Trước
 * đây giữ khung cuối bằng `eof_action=repeat` — đúng hình, nhưng đắt: đo 2026-09-30 trên "Bin Tom"
 * (17 chuỗi, 1.043 khung): cả lượt 14,8 s so với 11,0–11,3 s khi `pass`; luồng filter 8,6 so với
 * 4,2 CPU-giây, kể cả khi thay khung PNG bằng ảnh 16×16 — tức là phí của khung sườn chứ không phải
 * của phép trộn. `pass` trơn thì mất đúng 10 khung ở mép cửa sổ (426–427, 697–698, …).
 * Cách mới: nối K khung nhân bản khung cuối (`tpad clone`, chỉ tăng tham chiếu) rồi `pass`. K đủ
 * để chuỗi còn khung tới hết cửa sổ: mép cửa sổ ≤ start + duration − 0,5/fps, chuỗi (đã sớm tối đa
 * một khung) có N + K khung -> K > duration·fps + 0,5 − N; cộng 1 khung dư. Khung nhân bản quá
 * cửa sổ bị `enable` che như với repeat. Không biết N (payload cũ) thì giữ repeat.
 * Env tắt: CRABBYCUT_EXPORT_SEQPASS=0. */
int SequenceTailFrames(const ExportOverlay& overlay) {
  if (!OverlayIsImageSequence(overlay) || overlay.frameCount <= 0 || !(overlay.seqFps > 0.0)) return 0;
  const char* env = std::getenv("CRABBYCUT_EXPORT_SEQPASS");
  if (env) {
    const std::string value = env;
    if (value == "0" || value == "false" || value == "off") return 0;
  }
  const double needed = overlay.duration * overlay.seqFps + 0.5 - static_cast<double>(overlay.frameCount);
  return std::max(1, static_cast<int>(std::ceil(needed)) + 1);
}

/* MỐC THỜI GIAN CỦA LỚP PHỦ — dùng chung cho đồ thị CPU (WriteVisualOverlayFilter) và GPU
 * (WriteVisualOverlayFilterGpu, mục 1.21). Nén/dãn trục thời gian TRƯỚC khi dời về mốc tuyệt đối
 * trên sequence: chia cả biểu thức đã cộng `start` thì mốc bắt đầu của overlay cũng bị chia theo
 * và lớp lệch chỗ. */
/* CHUỖI KHUNG (chữ/hình động) đặt sớm ¼ khung xuất, trên timebase µs (mục 1.8). Hai lỗi cũ:
 *  - `setpts=…+start/TB` CẮT phần lẻ (D2TS), mà chuỗi nạp bằng `-framerate` có timebase 1/fps —
 *    mốc đầu bị cắt về SỐ KHUNG nguyên. "Bin Tom" (29,99926 khung/s): chữ ở 20,067 s -> 601,995
 *    khung -> 601, sớm một khung, khung 0 rơi trước cửa sổ `enable` (mất khung đầu hoạt ảnh); cùng
 *    chữ ở batch bắt đầu 14,365 s -> 171,06 -> 171 + 431 = 602 — bản chia batch khác bản một lượt.
 *  - chuỗi được bake ĐÚNG nhịp xuất nên khung k trùng mốc khung nền S+k, một ca "hoà" mà framesync
 *    phân xử bằng làm tròn µs của hai phía: timebase của `-framerate 29.999261` không đúng hệt
 *    1218000/40601 của lưới xuất -> lệch 1 µs là chữ trễ một khung, tuỳ chỗ cắt batch.
 * Sớm ¼ khung thì khung k nằm hẳn giữa hai khung nền và luôn hiện ở đúng khung S+k. Cửa sổ
 * `enable` (mở sớm ½ khung) và khung đuôi (SequenceTailFrames, tính dư một khung) không đổi.
 * Video/ảnh tĩnh: cắt phần lẻ như cũ (mốc ra luôn ≤ start — làm tròn lên thì khung ảnh tĩnh 1/25 s
 * đầu tiên có thể trễ hơn khung nền đầu cửa sổ). VIDEO sớm thêm kOverlayTieEpsilon: video CÙNG nhịp
 * xuất đặt đúng lưới cũng "hoà" ở mọi khung, và ca ở khung CUỐI cửa sổ (khung video cuối trùng mốc
 * khung nền) đổi phe theo làm tròn µs — test:export-parallel, khung 1019. 0,1 ms lớn hơn hẳn sai số
 * làm tròn (~1 µs) mà nhỏ hơn hẳn khoảng cách khung khi nhịp khác nhau (25 trên 30: ≥ 6,7 ms), nên
 * chỉ ca "hoà" đổi — về đúng phía. KHÔNG cho ảnh tĩnh: timebase 1/25 nên (8 − 0,0001) × 25 bị cắt
 * về 199 — cả ảnh sớm 40 ms, hết sớm 40 ms, mất khung nền cuối cửa sổ; nội dung không đổi nên ca
 * "hoà" của ảnh tĩnh không hiện ra gì. */
void WriteOverlaySetpts(std::ostream& out, const ExportOverlay& overlay, const ExportSettings& settings) {
  const double start = overlay.timelineStart;
  const double setptsStart = (!OverlayIsImageLike(overlay) && !OverlayIsImageSequence(overlay))
    ? start - kOverlayTieEpsilon : start;
  const double renderFpsForSeq = ParseFpsValue(settings.renderFps);
  if (OverlayIsImageSequence(overlay) && renderFpsForSeq > 0.0) {
    out << "settb=AVTB,setpts=PTS-STARTPTS+round(" << FfmpegDouble(start - 0.25 / renderFpsForSeq) << "/TB)";
    return;
  }
  if (std::abs(overlay.speedRate - 1.0) >= 1e-4 && !OverlayIsImageSequence(overlay)) {
    out << "setpts=(PTS-STARTPTS)/" << FormatFilterNumber(overlay.speedRate)
        << "+" << FfmpegDouble(setptsStart) << "/TB";
  } else {
    out << "setpts=PTS-STARTPTS+" << FfmpegDouble(setptsStart) << "/TB";
  }
}

/* Chuỗi THỜI GIAN của lớp phủ (trim + setpts). Ảnh tĩnh xử lý một lần: rỗng — trim/setpts dời ra
 * sau `loop` ở cuối chuỗi (xem OverlayStillOnce). */
std::string OverlayTimingChain(const ExportOverlay& overlay, const ExportSettings& settings) {
  if (OverlayStillOnce(overlay)) return "";
  std::ostringstream timing;
  if (OverlayIsImageSequence(overlay)) {
    // Sequence hữu hạn đã đúng độ dài cửa sổ hoạt ảnh — không trim;
    // sau frame cuối overlay tự biến mất nhờ eof_action=pass
  } else if (!OverlayIsImageLike(overlay)) {
    // Độ dài NGUỒN = độ dài timeline × tốc độ (xem WriteOverlayAudioFilter).
    const double videoSourceSpan = overlay.duration * (overlay.speedRate > 0.0 ? overlay.speedRate : 1.0);
    timing << "trim=start=" << FixedSeconds(overlay.sourceStart) << ":duration=" << FixedSeconds(videoSourceSpan) << ",";
    /* Xoá logo AI: luồng miếng vá đi qua CHÍNH chuỗi này (AppendLogoAiFilters) nhưng có timebase
     * riêng (concat 1/90000) — `(start − kOverlayTieEpsilon)/TB` cắt phần lẻ khác nhau trên hai
     * timebase (video 1/15360: 0,9999 -> 0,99987 s; miếng vá: 0,9999 s), miếng vá trễ hơn khung nền
     * một chút và `overlay` lấy miếng vá của khung TRƯỚC (test:logo-ai đỏ từ 83b8307). Cùng
     * timebase µs thì hai luồng ra cùng PTS. */
    if (!overlay.logoAiDir.empty()) timing << "settb=AVTB,";
  } else {
    timing << "trim=duration=" << FixedSeconds(overlay.duration) << ",";
  }
  WriteOverlaySetpts(timing, overlay, settings);
  return timing.str();
}

// Cách lớp phủ đi trên đồ thị GPU — xem OverlayGpuModeFor.
enum class OverlayGpu { None, Native, CpuYuv, CpuCanvas };

/* `gpu` (đồ thị GPU, xem OverlayGpuModeFor): CpuYuv = chuỗi CPU này tới yuva420p rồi tải lên +
 * crabblend; CpuCanvas = ghép RGBA lên khung trong suốt rồi tải lên + crabblend. None = đồ thị CPU. */
void WriteVisualOverlayFilter(
  std::ofstream& script,
  const ExportOverlay& overlay,
  const std::string& inputLabel,
  const std::string& outputLabel,
  const ExportSettings& settings,
  OverlayGpu gpu = OverlayGpu::None
) {
  // VIDEO overlay có hoạt ảnh: opacity qua fade, dịch chuyển qua overlay x/y theo t,
  // thu phóng/xoay qua nhánh AppendKfTransformFilters (khi hiệu ứng có dùng hai kênh đó).
  const bool hasVideoAnim = !overlay.animXExpr.empty();
  const int inputIndex = 1 + overlay.assetInputIndex;
  const int seqW = settings.width > 0 ? settings.width : 1920;
  const int seqH = settings.height > 0 ? settings.height : 1080;
  // SCALE HIỆU DỤNG = scale của người dùng × hệ số vừa khung (xem ExportOverlay::fitScale), như lane chính.
  const double overlayFit = (overlay.fitScale > 0.0) ? overlay.fitScale : 1.0;
  const double scaleValue = std::max(0.01, (overlay.scale / 100.0) * overlayFit);
  const double opacityValue = ClampDouble(overlay.opacity / 100.0, 0.0, 1.0);
  const double rotationRad = overlay.rotation * 3.14159265358979323846 / 180.0;
  const std::string id = std::to_string(overlay.index);
  const double start = overlay.timelineStart;
  // Sequence hoạt ảnh: mốc cuối trừ NỬA FRAME — between() bao gồm cả 2 đầu nên
  // frame nền rơi đúng ranh giới sẽ vẽ lặp frame cuối (eof_action=repeat) thêm
  // 1 frame nữa; ở ranh giới In->Hold bị Hold che, còn ở CUỐI Out thì lộ nguyên
  // thành "bóng ma" nhấp nháy. Trừ nửa frame để mỗi ranh giới chỉ 1 overlay vẽ.
  const double seqEndTrim = OverlayIsImageSequence(overlay) && overlay.seqFps > 1.0
    ? 0.5 / overlay.seqFps
    : 0.0;
  const double end = overlay.timelineStart + std::max(0.05, overlay.duration - seqEndTrim);

  // Mốc thời gian dùng chung với đồ thị GPU — xem WriteOverlaySetpts / OverlayTimingChain.
  const auto writeSetpts = [&](std::ostream& out) { WriteOverlaySetpts(out, overlay, settings); };
  // Ảnh tĩnh xử lý MỘT lần: trim/setpts dời ra sau `loop` ở cuối chuỗi (xem OverlayStillOnce).
  const bool stillOnce = OverlayStillOnce(overlay);

  script << "[" << inputIndex << ":v]" << UntaggedColorFix(overlay.colorUntagged);
  // Chuỗi THỜI GIAN của overlay (trim + setpts), giữ riêng cho Xoá logo AI (xem AppendLogoAiFilters).
  std::ostringstream timing;
  timing << OverlayTimingChain(overlay, settings);
  // KEYFRAME overlay (start tuyệt đối -> LOCALT = t-start). Có keyframe -> scale/rotate/
  // opacity biến thiên theo thời gian; vị trí lấy theo kf (cộng thêm offset hoạt ảnh nếu có).
  const bool overlayKf = HasKeyframeExpr(overlay.kfScaleExpr, overlay.kfRotExpr, overlay.kfOpacityExpr,
                                         overlay.kfXExpr, overlay.kfYExpr);
  // Hoạt ảnh có thu phóng/xoay dùng CHUNG nhánh biến đổi theo thời gian với keyframe
  // (xem WriteClipVideoFilters — cùng lý do, cùng cách gộp cờ).
  const bool overlayDynTransform = overlayKf
    || HasAnimGeomExpr(overlay.animSxExpr, overlay.animSyExpr, overlay.animRotExpr);

  // Ảnh tĩnh một lần: `null` (setpts ở cuối chuỗi); loại khác: trim + setpts của `timing`.
  script << (stillOnce ? std::string("null") : timing.str());
  // Xoá logo ngay sau setpts (ảnh tĩnh một lần: xoá MỘT lần), trước chuỗi màu. AI chỉ cho overlay
  // VIDEO: ảnh tĩnh/chuỗi khung đã bake xoá logo ở frontend.
  if (!overlay.logoAiDir.empty() && !OverlayIsImageLike(overlay) && !OverlayIsImageSequence(overlay)) {
    AppendLogoAiFilters(script, overlay.logoAiDir, overlay.logoAiRects, overlay.logoAiT0, timing.str(), "logoaio" + id + "_");
  } else {
    AppendLogoRemovalFilters(script, overlay.logoMode, overlay.logoRects, "logoo" + id + "_");
  }
  // Overlay giữ mốc tuyệt đối sau setpts -> LOCALT trừ timeline_start.
  // Tầng màu của chính block, rồi lớp Điều chỉnh — xem ghi chú ở WriteClipVideoFilters (cùng cách
  // chia tầng trước / sau phép co).
  const SplitColorStages color = SplitColorStagesForScale(
    BlockColorStages(overlay, start, "adjo" + id + "_", "adjlo" + id + "_"),
    !overlayDynTransform && overlay.videoMaskPath.empty() && scaleValue < 1.0);
  script << color.pre;
  AppendVideoMaskFilter(script, overlay.videoMaskPath, "vmo" + id + "_");
  if (!overlayDynTransform) {
    script << ",scale=max(2\\,ceil(iw*" << FfmpegDouble(scaleValue) << "/2)*2)"
           << ":max(2\\,ceil(ih*" << FfmpegDouble(scaleValue) << "/2)*2)";
  }
  script << color.post << ",format=rgba";
  AppendFeatherAlpha(script, overlay.featherPx);
  if (overlay.flipX) {
    script << ",hflip";
  }
  if (overlay.flipY) {
    script << ",vflip";
  }
  if (overlayDynTransform) {
    AppendKfTransformFilters(script, start, overlay.kfScaleExpr, overlay.kfRotExpr, overlay.kfOpacityExpr,
                             overlay.scale, overlay.rotation, opacityValue,
                             overlay.animSxExpr, overlay.animSyExpr, overlay.animRotExpr, overlayFit);
  } else {
    if (std::abs(rotationRad) > 0.000001) {
      const std::string angle = FfmpegDouble(rotationRad);
      script << ",rotate=" << angle << ":ow=rotw(" << angle << "):oh=roth(" << angle << "):c=black@0";
    }
    if (opacityValue < 0.999) {
      script << ",colorchannelmixer=aa=" << FfmpegDouble(opacityValue);
    }
  }
  // Hoạt ảnh video: opacity In/Out qua fade alpha (mốc tuyệt đối = start + cục bộ).
  if (hasVideoAnim) {
    if (overlay.animInDur > 0.001) {
      script << ",fade=t=in:st=" << FfmpegDouble(start + overlay.animInStart)
             << ":d=" << FfmpegDouble(overlay.animInDur) << ":alpha=1";
    }
    if (overlay.animOutDur > 0.001) {
      script << ",fade=t=out:st=" << FfmpegDouble(start + overlay.animOutStart)
             << ":d=" << FfmpegDouble(overlay.animOutDur) << ":alpha=1";
    }
  }
  // Ghép ở YUV (xem YuvCompositeEnabled). `yuvStatic` = lớp phủ đứng yên, không xoay.
  const bool yuvChain = YuvCompositeEnabled(settings);
  const bool yuvStatic = yuvChain && !overlayKf && !hasVideoAnim && !overlayDynTransform
                         && std::abs(rotationRad) <= 0.000001;
  const std::string posX = "(" + FfmpegDouble(overlay.positionX) + ")";
  const std::string posY = "(" + FfmpegDouble(overlay.positionY) + ")";
  if (yuvStatic) {
    // Đệm 1 px trong suốt ở mép trái/trên khi toạ độ gốc lẻ; `iw`/`ih` lúc này là cỡ lớp phủ
    // mà nhánh RGBA cũ dùng làm `w`/`h`. Bề rộng dựng từ scale luôn chẵn nên iw+4 vẫn chẵn.
    // +4 chứ không +2: ở CỘT/HÀNG MẪU MÀU CUỐI của lớp phủ, `overlay` yuv420 chỉ lấy alpha của
    // điểm ảnh đầu cặp (vf_overlay: nhánh `k+1 < src_wp` sai ở mẫu cuối) chứ không lấy trung bình.
    // Với mẫu màu có trọng số alpha, cặp cuối (đục, đệm trong suốt) thành màu đặc -> tràn 1 cột
    // màu sang phải (đo: hộp đỏ ở toạ độ lẻ). Đệm dư để cặp cuối luôn trong suốt hẳn.
    script << ",pad=w=iw+4:h=ih+4"
           << ":x='mod(trunc((" << seqW << "-iw)/2+" << posX << "),2)'"
           << ":y='mod(trunc((" << seqH << "-ih)/2+" << posY << "),2)'"
           << ":color=black@0";
    /* Ảnh tĩnh (có alpha): mẫu màu theo trung bình có trọng số alpha (xem AlphaWeightedYuva420)
     * — chạy MỘT lần nhờ OverlayStillOnce nên gần như miễn phí. CHUỖI KHUNG (chữ động) thì đổi
     * thẳng: chuỗi chữa màu 16-bit chạy lại ở từng khung. Đo 2026-09-29 trên Bin Tom (17 chuỗi
     * khung chữ): áp cho cả chuỗi khung thì xuất 29–31 s -> 33–35 s (+13%) mà so bản chuẩn gần
     * như không đổi (52,50 -> 52,53 dB). Video lớp phủ đục hoàn toàn nên cũng đổi thẳng. */
    if (stillOnce && AlphaChromaEnabled()) script << AlphaWeightedYuva420("ov" + id);
    else script << ",scale=out_color_matrix=bt709:out_range=tv,format=yuva420p";
    // Đồ thị GPU: tải lên TRƯỚC loop/tpad — khung lặp lại chỉ là tham chiếu tới khung GPU đã tải.
    if (gpu == OverlayGpu::CpuYuv) script << ",hwupload";
  }
  if (stillOnce) {
    script << ",loop=loop=-1:size=1,trim=duration=" << FixedSeconds(overlay.duration) << ",";
    writeSetpts(script);
  }
  // Chuỗi khung: nối khung nhân bản ở đuôi thay cho eof_action=repeat (xem SequenceTailFrames).
  const int seqTail = SequenceTailFrames(overlay);
  if (seqTail > 0) script << ",tpad=stop=" << seqTail << ":stop_mode=clone";
  script << "[ov" << id << "];\n";

  if (gpu == OverlayGpu::CpuCanvas) {
    /* Khung trong suốt cỡ sequence ĐÚNG lưới khung của luồng chính (setpts dời số khung nguyên trên
     * timebase 1/r), phủ từ một khung trước cửa sổ `enable` tới hai khung sau mép cuối — lớp phủ ghép
     * lên nó y như ghép lên luồng chính ở đường CPU (cùng mốc, cùng `t` cho x/y/enable).
     * `overlay=format=rgb` lên nền alpha 0: vf_overlay bù alpha nền (UNPREMULTIPLY_ALPHA) nên màu
     * ra đúng màu lớp phủ, alpha ra đúng alpha lớp phủ — khung ra là RGBA "thẳng" như crabblend cần. */
    const double fps = ParseFpsValue(settings.renderFps);
    long long n0 = 0;
    double span = end + 1.0;
    if (fps > 0.0) {
      n0 = std::max(0LL, static_cast<long long>(std::floor(OverlayEnableStart(start, settings) * fps)) - 1);
      const long long n1 = static_cast<long long>(std::ceil(end * fps)) + 2;
      span = static_cast<double>(std::max(1LL, n1 - n0)) / fps;
    }
    script << "color=c=black@0:s=" << seqW << "x" << seqH << ":r=" << settings.renderFps
           << ":d=" << FixedSeconds(span) << ",format=rgba,setpts=PTS+" << n0 << "[cv" << id << "];\n";
    script << "[cv" << id << "][ov" << id << "]overlay=";
  } else {
    script << inputLabel << "[ov" << id << "]" << (gpu == OverlayGpu::CpuYuv ? "crabblend_cuda=" : "overlay=");
  }
  if (yuvStatic) {
    // `w`/`h` ở đây là cỡ ĐÃ ĐỆM (+4). Toạ độ gốc trunc(...) trừ đi phần đệm trái/trên -> chẵn.
    const std::string bx = "trunc((" + std::to_string(seqW) + "-(w-4))/2+" + posX + ")";
    const std::string by = "trunc((" + std::to_string(seqH) + "-(h-4))/2+" + posY + ")";
    script << "x='" << bx << "-mod(" << bx << ",2)':y='" << by << "-mod(" << by << ",2)'";
  } else if (overlayKf || hasVideoAnim) {
    // Vị trí = tâm + kf/tĩnh + offset(t) hoạt ảnh. Bọc nháy đơn vì biểu thức có dấu phẩy.
    const std::string xPos = overlayKf ? KfOverlayPos(overlay.kfXExpr, start, overlay.positionX)
                                       : ("(" + FfmpegDouble(overlay.positionX) + ")");
    const std::string yPos = overlayKf ? KfOverlayPos(overlay.kfYExpr, start, overlay.positionY)
                                       : ("(" + FfmpegDouble(overlay.positionY) + ")");
    const std::string xoff = hasVideoAnim ? ("+(" + SubstituteLocalTime(overlay.animXExpr, start) + ")") : "";
    const std::string yoff = hasVideoAnim ? ("+(" + SubstituteLocalTime(overlay.animYExpr, start) + ")") : "";
    script << "x='(" << seqW << "-w)/2+" << xPos << xoff << "'"
           << ":y='(" << seqH << "-h)/2+" << yPos << yoff << "'";
  } else {
    script << "x=(" << seqW << "-w)/2"
           << (overlay.positionX >= 0 ? "+" : "") << FfmpegDouble(overlay.positionX)
           << ":y=(" << seqH << "-h)/2"
           << (overlay.positionY >= 0 ? "+" : "") << FfmpegDouble(overlay.positionY);
  }
  script << ":enable='between(t," << FfmpegDouble(OverlayEnableStart(start, settings)) << "," << FfmpegDouble(end) << ")'"
         // Sequence hoạt ảnh: GIỮ frame cuối sau EOF — nếu pass mà chuỗi hết sớm, text
         // biến mất 1–3 frame ở cuối cửa sổ gây "nháy"; enable window vẫn gate hiển thị.
         // Nay giữ bằng các khung nhân bản ở đuôi chuỗi (SequenceTailFrames) + pass; chỉ
         // khi không biết số khung mới dùng repeat (đắt, xem SequenceTailFrames).
         << ":eof_action=" << ((OverlayIsImageSequence(overlay) && seqTail == 0) ? "repeat" : "pass");
  // crabblend (CpuYuv) không có tuỳ chọn format: nó chỉ trộn yuva420p lên yuv420p, trùng từng bit
  // với overlay=format=yuv420.
  if (gpu == OverlayGpu::CpuCanvas) script << ":format=rgb";
  else if (gpu != OverlayGpu::CpuYuv) script << ":format=" << (yuvStatic ? "yuv420" : "auto");
  if (gpu == OverlayGpu::CpuCanvas) {
    /* Ghép xong thì dời khung trong suốt SỚM 1 ms trước khi trộn: mốc khung luồng chính ở chỗ trộn
     * đã qua timebase µs của các bộ trộn trước (6,666666 s cho khung 200), mốc n/r đúng thì muộn hơn
     * 1 µs và crabblend lấy khung trong suốt TRƯỚC đó — đo trên "Yêu Con": chuỗi khung có keyframe cỡ
     * hiện chậm một khung ở 2/3 số khung đầu và cuối cửa sổ (28 dB so với CPU). Dời TRƯỚC khi ghép thì
     * sai chỗ khác: ảnh/video lớp phủ chỉ sớm 0,1 ms (kOverlayTieEpsilon) nên khung đầu bị bỏ. */
    script << ",settb=AVTB,setpts=PTS-round(0.001/TB)";
    script << ",hwupload,crabgeo_cuda=format=yuva420p:bg=transparent:alpha_chroma=1:passthrough=0[ovu" << id << "];\n";
    script << inputLabel << "[ovu" << id << "]crabblend_cuda=x=0:y=0:eof_action=pass";
  } else if (yuvChain && !yuvStatic) {
    // Lớp phủ động trong chuỗi YUV: ghép RGBA như cũ rồi về ngay yuv420p BT.709/tv, để lớp sau
    // (và cả phần còn lại của chuỗi) không phải kéo luồng chính qua RGBA.
    script << ",scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";
  }
  script << outputLabel << ";\n";
}

/* LỚP PHỦ TRÊN ĐỒ THỊ GPU (mục 1.21). Chỉ cho lớp phủ "yuvStatic" của đường CPU — đứng yên, không
 * xoay/keyframe hình học/hoạt ảnh/mặt nạ/mép mềm/lật, màu chỉ là LUT (OverlayGpuNative); keyframe ĐỘ
 * MỜ thì đi biểu thức `opacity` của crabblend (đường CPU ghép lớp đó ở RGBA). Cùng phép tính với nhánh
 * yuvStatic của WriteVisualOverlayFilter: cỡ `max(2,ceil(iw*s/2)*2)`, đệm 4 điểm ảnh trong suốt ở
 * toạ độ `mod(...,2)`, toạ độ trộn chẵn, cùng cửa sổ `enable`/`eof_action`/khung đuôi. Khác ở:
 *  - scale + format=rgba + pad + đổi bt709 + yuva420p gộp vào MỘT crabgeo_cuda; ảnh/chuỗi khung
 *    giải mã CPU (PNG) rồi tải lên dạng RGBA, video giải mã NVDEC ra thẳng khung CUDA;
 *  - ảnh tĩnh: màu mép theo trọng số alpha ngay trong crabgeo (alpha_chroma) thay cho chuỗi
 *    premultiply/area/unpremultiply/mergeplanes của AlphaWeightedYuva420;
 *  - độ mờ tĩnh < 1 đi vào crabblend_cuda (opacity) thay cho colorchannelmixer. */
void WriteVisualOverlayFilterGpu(
  std::ofstream& script,
  const ExportOverlay& overlay,
  const std::string& inputLabel,
  const std::string& outputLabel,
  const ExportSettings& settings
) {
  const int inputIndex = 1 + overlay.assetInputIndex;
  const int seqW = settings.width > 0 ? settings.width : 1920;
  const int seqH = settings.height > 0 ? settings.height : 1080;
  const double overlayFit = (overlay.fitScale > 0.0) ? overlay.fitScale : 1.0;
  const double scaleValue = std::max(0.01, (overlay.scale / 100.0) * overlayFit);
  const double opacityValue = ClampDouble(overlay.opacity / 100.0, 0.0, 1.0);
  const std::string id = std::to_string(overlay.index);
  const double start = overlay.timelineStart;
  const double seqEndTrim = OverlayIsImageSequence(overlay) && overlay.seqFps > 1.0 ? 0.5 / overlay.seqFps : 0.0;
  const double end = overlay.timelineStart + std::max(0.05, overlay.duration - seqEndTrim);
  const bool stillOnce = OverlayStillOnce(overlay);
  const bool image = OverlayIsImageLike(overlay) || OverlayIsImageSequence(overlay);
  const std::string S = FfmpegDouble(scaleValue);
  const std::string posX = "(" + FfmpegDouble(overlay.positionX) + ")";
  const std::string posY = "(" + FfmpegDouble(overlay.positionY) + ")";

  script << "[" << inputIndex << ":v]" << (stillOnce ? std::string("null") : OverlayTimingChain(overlay, settings));
  /* Ảnh/chuỗi khung (PNG, JPG): đổi RGBA ở CPU rồi tải lên. Video NVDEC không giải mã được: tải
   * lên dạng yuva420p — giữ alpha nếu nguồn có (ProRes 4444…); đường CPU cũng hạ về RGBA 8-bit. */
  if (image) script << ",format=rgba,hwupload";
  else if (!overlay.gpuNvdec) script << ",format=yuva420p,hwupload";
  // `w`/`h` của crabgeo = cỡ ảnh nội dung đã co (chính là `iw`/`ih` của `pad` ở đường CPU).
  script << ",crabgeo_cuda=w='max(2,ceil(iw*" << S << "/2)*2)':h='max(2,ceil(ih*" << S << "/2)*2)'"
         << ":ow=w+4:oh=h+4"
         << ":x='mod(trunc((" << seqW << "-w)/2+" << posX << "),2)'"
         << ":y='mod(trunc((" << seqH << "-h)/2+" << posY << "),2)'"
         << ":format=yuva420p:bg=transparent";
  // Video không gắn nhãn ma trận: đọc theo bt709 như UntaggedColorFix của đường CPU.
  if (!image && overlay.colorUntagged) script << ":in_matrix=bt709";
  if (stillOnce && AlphaChromaEnabled()) script << ":alpha_chroma=1";
  // LUT (lớp Điều chỉnh / HSL + LUT): mốc thời gian tuyệt đối sau setpts -> LOCALT = t − start.
  script << GpuLutOptions(BlockGpuLut(overlay, start));
  if (stillOnce) {
    script << ",loop=loop=-1:size=1,trim=duration=" << FixedSeconds(overlay.duration) << ",";
    WriteOverlaySetpts(script, overlay, settings);
  }
  const int seqTail = SequenceTailFrames(overlay);
  if (seqTail > 0) script << ",tpad=stop=" << seqTail << ":stop_mode=clone";
  script << "[ov" << id << "];\n";

  const std::string bx = "trunc((" + std::to_string(seqW) + "-(w-4))/2+" + posX + ")";
  const std::string by = "trunc((" + std::to_string(seqH) + "-(h-4))/2+" + posY + ")";
  script << inputLabel << "[ov" << id << "]crabblend_cuda="
         << "x='" << bx << "-mod(" << bx << ",2)':y='" << by << "-mod(" << by << ",2)'"
         << ":enable='between(t," << FfmpegDouble(OverlayEnableStart(start, settings)) << "," << FfmpegDouble(end) << ")'"
         << ":eof_action=" << ((OverlayIsImageSequence(overlay) && seqTail == 0) ? "repeat" : "pass");
  if (!overlay.kfOpacityExpr.empty()) {
    /* Keyframe độ mờ (đơn vị %, LOCALT = t − start) THAY giá trị tĩnh — như KfOpacityFilter của
     * đường CPU (ở đó sendcmd tính theo mốc khung lớp phủ, ở đây theo mốc khung nền: lớp phủ khác
     * nhịp xuất thì lệch dưới một khung về thời gian của đường cong độ mờ). */
    script << ":opacity='clip((" << SubstituteLocalTimeVar(overlay.kfOpacityExpr, start, "t") << ")/100,0,1)'";
  } else if (opacityValue < 0.999) {
    script << ":opacity=" << FfmpegDouble(opacityValue);
  }
  script << outputLabel << ";\n";
}

/* BATCH ĐI ĐỒ THỊ GPU ĐƯỢC KHÔNG (mục 1.21). Bộ lọc CUDA hiện có hình học tĩnh + LUT (crabgeo) và
 * phép trộn có độ mờ (crabblend): clip phải đi đường nhanh YUV của CPU (MainLaneFastPlan), không xoá
 * logo, tầng màu rỗng hoặc chỉ là LUT (BlockGpuLut); lớp phủ nào cũng đi được (OverlayGpuModeFor —
 * chưa có bản GPU thì dựng bằng CPU rồi tải lên), trừ text. Một clip không đạt là CẢ batch đi đồ
 * thị CPU (giải mã NVDEC ra khung CUDA cho cả input, chưa có đường tải xuống giữa đồ thị).
 * crabgeo co nhỏ tối đa ~15,7 lần mỗi mặt phẳng (bicubic: ceil(4·tỉ lệ)+1 ≤ 64 tap). Mặt phẳng màu
 * của nguồn RGBA (ảnh) co gấp đôi mặt phẳng sáng khi ra 4:2:0 -> ảnh chỉ tới ~7,8 lần. */
const double kGpuMinScale = 1.0 / 15.0;
const double kGpuMinScaleRgba = 2.0 / 15.0;

bool ClipGpuEligible(const ExportInterval& item, const ExportSettings& settings) {
  if (!BlockColorGpuReady(item) || !item.logoAiDir.empty() || !item.logoRects.empty()) return false;
  if (!g_gpuMainNvdec && GpuUploadFormat(settings.sourcePixFmt).empty()) return false;
  // Cùng các cờ mà WriteClipVideoFilters đưa vào MainLaneFastPlan.
  const bool dynamicClip = HasKeyframeExpr(item.kfScaleExpr, item.kfRotExpr, item.kfOpacityExpr, item.kfXExpr, item.kfYExpr)
    || HasAnimGeomExpr(item.animSxExpr, item.animSyExpr, item.animRotExpr) || !item.animXExpr.empty();
  const double fitScale = (item.fitScale > 0.0) ? item.fitScale : 1.0;
  const double scaleValue = std::max(0.01, (item.scale / 100.0) * fitScale);
  const double opacityValue = std::max(0.0, std::min(1.0, item.opacity / 100.0));
  if (scaleValue < kGpuMinScale) return false;
  return MainLaneFastPlan(item, settings, dynamicClip, scaleValue, opacityValue).ok;
}

/* Lớp phủ có bản GPU riêng (WriteVisualOverlayFilterGpu): đứng yên, không xoay/lật/mép mềm/mặt nạ/
 * xoá logo, tầng màu rỗng hoặc chỉ là LUT. Keyframe ĐỘ MỜ một mình thì được: crabblend nhận biểu thức
 * `opacity` theo `t`. Keyframe vị trí/cỡ/xoay, hoạt ảnh -> không (đi OverlayGpu::CpuCanvas). */
bool OverlayGpuNative(const ExportOverlay& overlay, const ExportSettings& settings) {
  if (!YuvCompositeEnabled(settings) || overlay.type == "text") return false;
  const double overlayFit = (overlay.fitScale > 0.0) ? overlay.fitScale : 1.0;
  const double scaleValue = std::max(0.01, (overlay.scale / 100.0) * overlayFit);
  const bool image = OverlayIsImageLike(overlay) || OverlayIsImageSequence(overlay);
  if (scaleValue < (image ? kGpuMinScaleRgba : kGpuMinScale)) return false;
  if (HasKeyframeExpr(overlay.kfScaleExpr, overlay.kfRotExpr, "", overlay.kfXExpr, overlay.kfYExpr)
      || HasAnimGeomExpr(overlay.animSxExpr, overlay.animSyExpr, overlay.animRotExpr) || !overlay.animXExpr.empty()
      || overlay.animInDur > 0.001 || overlay.animOutDur > 0.001) return false;
  if (std::abs(overlay.rotation) > 1e-6 || overlay.flipX || overlay.flipY || overlay.featherPx > 0) return false;
  if (!overlay.videoMaskPath.empty() || !BlockColorGpuReady(overlay)) return false;
  // Ảnh tĩnh xử lý một lần: crabgeo chạy trên khung duy nhất (mốc 0) -> LUT có `mix` theo thời gian sai.
  if (BlockHasColorAdjust(overlay) && OverlayStillOnce(overlay)) return false;
  return overlay.logoAiDir.empty() && overlay.logoRects.empty();
}

/* Lớp phủ "yuvStatic" của đường CPU (WriteVisualOverlayFilter): chuỗi riêng của lớp phủ ra yuva420p
 * đã đệm, trộn bằng `overlay=format=yuv420` ở toạ độ chẵn. */
bool OverlayYuvStatic(const ExportOverlay& overlay, const ExportSettings& settings) {
  const bool overlayKf = HasKeyframeExpr(overlay.kfScaleExpr, overlay.kfRotExpr, overlay.kfOpacityExpr,
                                         overlay.kfXExpr, overlay.kfYExpr);
  return YuvCompositeEnabled(settings) && !overlayKf && overlay.animXExpr.empty()
      && !HasAnimGeomExpr(overlay.animSxExpr, overlay.animSyExpr, overlay.animRotExpr)
      && std::abs(overlay.rotation) <= 1e-6;
}

/* LỚP PHỦ TRÊN ĐỒ THỊ GPU — bốn cách (WriteFilterScript):
 *  Native    bản GPU riêng (WriteVisualOverlayFilterGpu): crabgeo + crabblend.
 *  CpuYuv    lớp phủ yuvStatic chưa có bản GPU (mép mềm, chuỗi màu, mặt nạ, lật, xoá logo…): CHÍNH
 *            chuỗi CPU của nó (giải mã + xử lý ở cỡ lớp phủ, thường nhỏ) tới yuva420p đã đệm, rồi
 *            `hwupload` và crabblend thay `overlay=format=yuv420` — trùng từng bit với CPU.
 *  CpuCanvas lớp phủ động (keyframe vị trí/cỡ/xoay, hoạt ảnh): đường CPU ghép RGBA lên luồng chính ở
 *            toạ độ/cỡ đổi theo khung. Ở đây ghép RGBA lên một khung TRONG SUỐT cỡ sequence (chỉ trong
 *            cửa sổ của lớp phủ), tải lên, crabgeo đổi yuva420p (màu mép theo trọng số alpha), rồi
 *            crabblend ở (0, 0) — luồng chính không phải đi vòng YUV -> RGB -> YUV như đường CPU.
 *  None      text (drawtext) -> cả batch đi đồ thị CPU.
 * Trước đây (phiên 10) mọi lớp phủ không Native kéo cả batch về CPU — dự án "Yêu Con" có 2 miếng vá
 * Retouch mép mềm + một chuỗi khung có keyframe cỡ nên batch 45 s của nó không bao giờ đi GPU.
 * (enum OverlayGpu khai ở trên WriteVisualOverlayFilter.) */
OverlayGpu OverlayGpuModeFor(const ExportOverlay& overlay, const ExportSettings& settings) {
  if (!YuvCompositeEnabled(settings) || overlay.type == "text") return OverlayGpu::None;
  if (OverlayGpuNative(overlay, settings)) return OverlayGpu::Native;
  return OverlayYuvStatic(overlay, settings) ? OverlayGpu::CpuYuv : OverlayGpu::CpuCanvas;
}

// Lượt xuất này dựng đồ thị GPU cho batch đạt — CommandExportVideo đặt sau các phép dò.
static bool g_gpuRender = false;

bool BatchGpuEligible(const std::vector<ExportInterval>& intervals, size_t offset, size_t count,
                      const std::vector<ExportOverlay>& overlays, const ExportSettings& settings) {
  if (!g_gpuRender || count == 0) return false;
  if (OutputResized(settings) && !settings.builtAtOutputScale) return false;
  for (size_t i = 0; i < count; i++) {
    if (!ClipGpuEligible(intervals[offset + i], settings)) return false;
  }
  // Cùng phép lọc lớp phủ với WriteFilterScript (lớp nào bị bỏ qua ở đó thì không tính).
  for (const auto& overlay : overlays) {
    if (!OverlayIsVisual(overlay)) continue;
    if (overlay.type != "text" && overlay.assetInputIndex < 0) continue;
    if (overlay.type == "text" && !TextOverlaySupported()) continue;
    if (OverlayGpuModeFor(overlay, settings) == OverlayGpu::None) return false;
  }
  return true;
}

void WriteOverlayAudioFilter(std::ofstream& script, const ExportOverlay& overlay, std::vector<std::string>& audioLabels) {
  const int inputIndex = 1 + overlay.assetInputIndex;
  const std::string id = std::to_string(overlay.index);
  const int delayMs = std::max(0, static_cast<int>(std::round(overlay.timelineStart * 1000.0)));
  // `overlay.duration` là thời gian TIMELINE -> đoạn NGUỒN cần lấy dài gấp `speedRate`.
  const double sourceSpan = overlay.duration * (overlay.speedRate > 0.0 ? overlay.speedRate : 1.0);
  script << "[" << inputIndex << ":a]atrim=start=" << FixedSeconds(overlay.sourceStart)
         << ":duration=" << FixedSeconds(sourceSpan)
         << ",asetpts=PTS-STARTPTS";
  if (!overlay.audioDenoiseFilter.empty()) script << "," << overlay.audioDenoiseFilter;
  const std::string overlayTempo = BuildSpeedAudioFilter(overlay.speedRate, overlay.speedPitchCorrect);
  if (!overlayTempo.empty()) script << "," << overlayTempo;
  script << "," << BuildVolumeFilter(overlay.volume, overlay.kfVolumeExpr)
         << ",adelay=" << delayMs << "|" << delayMs
         << ",aresample=48000[aov" << id << "];\n";
  audioLabels.push_back("[aov" + id + "]");
}

void AppendCpuEncoderArgs(std::vector<std::string>& cmd, const ExportSettings& settings) {
  if (settings.codec == "prores") {
    cmd.insert(cmd.end(), {"-c:v", "prores_ks", "-profile:v", "3", "-c:a", "pcm_s16le"});
    return;
  }
  const std::string preset = QualityPreset(settings);
  cmd.insert(cmd.end(), {"-c:v", settings.codec == "hevc" ? "libx265" : "libx264", "-preset", preset});
  if (RateIsCustom(settings)) {
    // "Tùy chỉnh": bitrate trung bình người dùng nhập, đỉnh ×1,5 (bộ đệm 2 giây của đỉnh).
    const long long kbps = RateKbps(settings);
    cmd.insert(cmd.end(), {"-b:v", KbpsArg(kbps), "-maxrate", KbpsArg(kbps * 3 / 2), "-bufsize", KbpsArg(kbps * 3)});
  } else {
    // Các mức chất lượng: CRF không trần — đúng hành vi CPU trước giờ (Khuyến nghị = CRF 18 cũ).
    cmd.insert(cmd.end(), {"-crf", RateCpuCrf(settings)});
  }
  if (settings.codec == "hevc") cmd.insert(cmd.end(), {"-tag:v", "hvc1"});
  cmd.insert(cmd.end(), {"-c:a", "aac", "-b:a", settings.audioBitrate});
}

void AppendHardwareEncoderArgs(std::vector<std::string>& cmd, const ExportSettings& settings, const EncoderPlan& plan) {
  if (settings.codec == "prores") {
    cmd.insert(cmd.end(), {"-c:v", plan.videoEncoder, "-profile:v", "3", "-prio_speed", "1", "-c:a", "pcm_s16le"});
    return;
  }

  const std::string bitrate = BitrateForHardware(settings);
  if (plan.mode == "videotoolbox") {
    cmd.insert(cmd.end(), {"-c:v", plan.videoEncoder, "-b:v", bitrate, "-realtime", "1", "-prio_speed", "1"});
  } else if (plan.mode == "nvenc") {
    /* `-preset fast` = p1 + tune hq (md5 trùng khi thử trên cùng khung). Mức chất lượng: VBR đích 0
     * + `-cq` + trần `-maxrate` — cảnh khó chạm trần thì như bitrate cố định cũ, cảnh dễ thì nhỏ
     * hẳn. Đo (mục 1.20): tốc độ như nhau ở mọi mức; phim AV1 4K 39,1 -> 27,7 Mbps ở cq 19. */
    const long long kbps = RateKbps(settings);
    cmd.insert(cmd.end(), {"-c:v", plan.videoEncoder, "-preset", "fast", "-rc", "vbr"});
    if (RateIsCustom(settings)) {
      cmd.insert(cmd.end(), {"-b:v", KbpsArg(kbps), "-maxrate", KbpsArg(kbps * 3 / 2), "-bufsize", KbpsArg(kbps * 3)});
    } else {
      cmd.insert(cmd.end(), {"-cq", std::to_string(RateHardwareCq(settings)), "-b:v", "0",
                             "-maxrate", KbpsArg(kbps), "-bufsize", KbpsArg(kbps * 2)});
    }
  } else if (plan.mode == "qsv") {
    /* QSV/AMF/VideoToolbox: chưa có máy để đo chế độ chất lượng của chúng -> giữ bitrate cố định như
     * trước, với con số của mức đã chọn (trần của mức chất lượng = bitrate cố định cũ cùng mức). */
    cmd.insert(cmd.end(), {"-c:v", plan.videoEncoder, "-preset", "veryfast", "-b:v", bitrate});
  } else if (plan.mode == "amf") {
    cmd.insert(cmd.end(), {"-c:v", plan.videoEncoder, "-quality", "speed", "-b:v", bitrate});
  } else {
    AppendCpuEncoderArgs(cmd, settings);
    return;
  }

  if (settings.codec == "hevc") {
    cmd.insert(cmd.end(), {"-tag:v", "hvc1"});
  }
  cmd.insert(cmd.end(), {"-c:a", "aac", "-b:a", settings.audioBitrate});
}

void AppendEncoderArgs(std::vector<std::string>& cmd, const ExportSettings& settings, const EncoderPlan& plan) {
  if (plan.hardware) {
    AppendHardwareEncoderArgs(cmd, settings, plan);
  } else {
    AppendCpuEncoderArgs(cmd, settings);
  }
  // Ép output CFR đúng renderFps: không có -r/-fps_mode thì ffmpeg tự đoán từ
  // stream đầu vào (VFR/lệch pha) -> frame animation bị lặp/bỏ không đều (giật)
  cmd.insert(cmd.end(), {"-r", settings.renderFps, "-fps_mode", "cfr"});
  // Nhãn màu ở tầng bitstream/container, khớp OutputColorFilters (xem chú thích ở đó).
  cmd.insert(cmd.end(), {"-colorspace", "bt709", "-color_primaries", "bt709",
                         "-color_trc", "bt709", "-color_range", "tv"});

  /* KHOẢNG CÁCH KHUNG I = 1 GIÂY. Thiếu `-g` thì encoder dùng mặc định của nó: x264 và
   * NVENC đều là 250 KHUNG, tức 4,17 giây ở 60fps.
   *
   * VÌ SAO QUAN TRỌNG: bản xuất của CrabbyCut thường được NHẬP LẠI vào CrabbyCut (dựng
   * tiếp, cắt lại). Mà mọi đường xem trước ở đây đều TUA liên tục — Preview Cuts tua ở mép
   * mỗi chunk, Editing tua ở mép mỗi clip — và giá một lệnh tua là số khung phải giải mã
   * lại từ khung I gần nhất. Đo trên tệp thật do chính app xuất
   * (`..._Cuted.mp4`, h264_nvenc, 1080×1920@59,94, GOP 4,17s): mỗi lệnh tua phải dựng lại
   * tới 250 khung, so với ~30 khung của nguồn máy quay (DJI, GOP 0,5s).
   *
   * 1 giây cũng nằm trong khuyến nghị của các nền tảng (YouTube/Meta muốn <= 2 giây), nên
   * đổi này không làm hỏng bản giao nộp; phần bitrate trả thêm chỉ vài phần trăm.
   * KHÔNG đặt `-sc_threshold 0`: để encoder chèn thêm khung I ở chỗ đổi cảnh vẫn tốt hơn. */
  const double fpsValue = ParseFpsValue(settings.renderFps);
  const long gop = (fpsValue > 0.0) ? std::lround(fpsValue) : 30;
  cmd.insert(cmd.end(), {"-g", std::to_string(gop > 0 ? gop : 30)});
}

/* Lượt render này dựng luồng nào.
 *
 * TIẾNG CHẠY MỘT LƯỢT LIỀN MẠCH CHO CẢ PHIM, CHỈ HÌNH MỚI CHIA BATCH. Đo được: nối hai đoạn
 * AAC bằng `-c copy` làm tổng thời lượng dài thêm 23ms mỗi mối ghép (priming + padding của
 * AAC — 10,000s thành 10,023s trên phép thử hai đoạn 5s). Video 3 giờ chia 60 batch là gần
 * 1,4 giây trôi dồn, kèm một chỗ ngắt tiếng nghe được ở MỖI mối. Hình thì `-c copy` nối
 * chính xác từng khung nên chia bao nhiêu cũng không mất gì.
 * Vì vậy: mỗi batch = VideoOnly, cộng ĐÚNG MỘT lượt AudioOnly, ghép lại ở cuối. */
enum class FilterScriptMode { Full, VideoOnly, AudioOnly };

bool WriteFilterScript(
  const fs::path& scriptPath,
  const std::vector<ExportInterval>& intervals,
  size_t offset,
  size_t count,
  const ExportSettings& settings,
  const std::vector<ExportOverlay>& overlays,
  FilterScriptMode mode = FilterScriptMode::Full
) {
  const bool wantVideo = mode != FilterScriptMode::AudioOnly;
  const bool wantAudio = mode != FilterScriptMode::VideoOnly;
  std::ofstream script(scriptPath);
  if (!script) return false;
  g_filterAuxDir = scriptPath.parent_path();   // file lệnh phụ (lutmix_*.cmd) nằm cạnh script
  g_fastClipCount = 0;
  const double renderFpsValue = ParseFpsValue(settings.renderFps);
  /* LƯỢT CHỈ-TIẾNG NỐI KÈM ĐOẠN HÌNH GIẢ (mục 1.8). Ở lượt có hình, `concat` nối hình CÙNG tiếng
   * (`v=1:a=1`): mỗi đoạn dài bằng luồng dài hơn, tiếng ngắn hơn hình thì được đệm lặng tới cuối
   * đoạn hình. Nối tiếng một mình thì các đoạn nối theo đúng số mẫu — lệch dưới một mẫu mỗi đoạn,
   * dồn qua 20 đoạn ("Bin Tom") là bản xuất chia batch khác bản một lượt ở từng mẫu tiếng. Đoạn
   * hình giả 16×16, đúng nhịp + đúng số khung của đoạn thật, cho `concat` cùng mốc cuối đoạn (nó
   * lấy mốc khung cuối × n/(n−1)) nên tiếng ra y hệt; hình giả đổ vào nullsink. */
  bool dummyVideo = !wantVideo && wantAudio && renderFpsValue > 0.0 && count > 0;
  for (size_t i = 0; dummyVideo && i < count; i++) {
    if (intervals[offset + i].renderFrames <= 0) dummyVideo = false;
  }
  for (size_t i = 0; i < count; i++) {
    const auto& item = intervals[offset + i];
    if (wantVideo) WriteClipVideoFilters(script, item, i, settings);
    if (dummyVideo) {
      script << "color=c=black:s=16x16:r=" << settings.renderFps
             << ":d=" << FixedSeconds(static_cast<double>(item.renderFrames + 1) / renderFpsValue)
             << ",trim=end_frame=" << item.renderFrames << "[dv" << i << "];\n";
    }
    if (!wantAudio) continue;
    // Tiếng cắt theo ĐÚNG số khung của hình (xem BuildTimelineFrameGrid). Cắt theo giây
    // trong khi hình đi theo khung thì mỗi segment lệch nhau tới một khung, và `concat`
    // bù phần thiếu bằng KHOẢNG LẶNG — nghe ra tiếng ngắt quãng ở từng mối nối.
    // renderFrames đếm khung SEQUENCE -> quy về giờ NGUỒN bằng cách nhân tốc độ, rồi
    // chuỗi atempo bên dưới nén đúng chừng đó về lại renderFrames/fps.
    const double audioEnd = (item.renderFrames > 0 && renderFpsValue > 0.0)
      ? item.start + (static_cast<double>(item.renderFrames) / renderFpsValue) * item.speedRate
      : item.end;
    /* Tiếng cũng phải đổi sang trục thời gian của file nguồn, bằng mốc bắt đầu của CHÍNH
     * luồng tiếng — KHÔNG dùng chung `videoStart`. Trên temp_input.mp4 đo được video 0.021
     * còn audio 0.000: lấy mốc của hình mà cắt tiếng là lệch tiếng 21ms ở mọi block.
     * Không lùi nửa khung ở đây: "khung" của tiếng là gói 1024 mẫu AAC, không liên quan gì
     * tới lưới khung hình. */
    script << "[0:a]atrim=start=" << FixedSeconds(item.start + settings.audioStart)
           << ":end=" << FixedSeconds(audioEnd + settings.audioStart)
           << ",asetpts=PTS-STARTPTS";
    // Khử tiếng ồn TỪNG BLOCK: afftdn bám sàn nhiễu theo thời gian, mà mỗi block có thể
    // là một lần thu khác nhau -> chạy trên đoạn đã atrim là mỗi block tự bám nền của
    // chính nó. Chạy trên cả file trước khi cắt thì block ồn kéo lệch block sạch.
    if (!item.audioDenoiseFilter.empty()) script << "," << item.audioDenoiseFilter;
    // TỐC ĐỘ sau KHỬ ỒN: bộ khử nhiễu làm việc trên tiếng như đã thu, chưa bị kéo dãn.
    const std::string clipTempo = BuildSpeedAudioFilter(item.speedRate, item.speedPitchCorrect);
    if (!clipTempo.empty()) script << "," << clipTempo;
    script << "," << BuildVolumeFilter(item.audioVolume, item.kfVolumeExpr)
           << ",aresample=48000[a" << i << "];\n";
  }
  for (size_t i = 0; i < count; i++) {
    if (wantVideo) script << "[v" << i << "]";
    if (dummyVideo) script << "[dv" << i << "]";
    if (wantAudio) script << "[a" << i << "]";
  }
  const std::string concatSpec = std::string("concat=n=") + std::to_string(count)
    + ":v=" + (wantVideo || dummyVideo ? "1" : "0") + ":a=" + (wantAudio ? "1" : "0");
  if (overlays.empty()) {
    if (wantVideo) {
      script << concatSpec << "[vcat]" << (wantAudio ? "[a]" : "") << ";\n";
      script << "[vcat]" << (g_gpuGraph ? GpuOutputFilters(settings) : OutputColorFilters(settings)) << "[v]\n";
    } else if (dummyVideo) {
      script << concatSpec << "[dvcat][a];\n[dvcat]nullsink\n";
    } else {
      script << concatSpec << (wantAudio ? "[a]" : "") << "\n";
    }
    return true;
  }

  if (wantVideo) {
    script << concatSpec << "[mainv]" << (wantAudio ? "[maina]" : "") << ";\n";
  } else if (dummyVideo) {
    script << concatSpec << "[dvcat][maina];\n[dvcat]nullsink;\n";
  } else {
    script << concatSpec << "[maina];\n";
  }

  std::string currentVideo = "[mainv]";
  size_t visualIndex = 0;
  for (const auto& overlay : overlays) {
    if (!wantVideo) break;
    if (!OverlayIsVisual(overlay)) continue;
    if (overlay.type != "text" && overlay.assetInputIndex < 0) continue;
    if (overlay.type == "text" && !TextOverlaySupported()) continue;
    const std::string outputLabel = "[vov" + std::to_string(visualIndex++) + "]";
    if (overlay.type == "text") {
      WriteTextOverlayFilter(script, overlay, currentVideo, outputLabel, settings);
    } else if (g_gpuGraph) {
      const OverlayGpu mode = OverlayGpuModeFor(overlay, settings);
      if (mode == OverlayGpu::Native) WriteVisualOverlayFilterGpu(script, overlay, currentVideo, outputLabel, settings);
      else WriteVisualOverlayFilter(script, overlay, currentVideo, outputLabel, settings, mode);
    } else {
      WriteVisualOverlayFilter(script, overlay, currentVideo, outputLabel, settings);
    }
    currentVideo = outputLabel;
  }
  if (wantVideo) {
    script << currentVideo << (g_gpuGraph ? GpuOutputFilters(settings) : "setsar=1," + OutputColorFilters(settings))
           << "[v];\n";
  }
  if (!wantAudio) return true;

  std::vector<std::string> audioLabels;
  audioLabels.push_back("[maina]");
  for (const auto& overlay : overlays) {
    if (!OverlayHasAudio(overlay) || overlay.assetInputIndex < 0) continue;
    WriteOverlayAudioFilter(script, overlay, audioLabels);
  }
  if (audioLabels.size() == 1) {
    script << audioLabels[0] << "anull[a]\n";
  } else {
    for (const auto& label : audioLabels) script << label;
    // normalize=0 là BẮT BUỘC (đã sửa 2026-08-15). Mặc định của amix là normalize=1: nó
    // CHIA MỌI ĐẦU VÀO cho số luồng, nên thêm block audio là dìm luôn cả lời thoại —
    // 7 luồng = −20·log10(7) ≈ −17 dB trên mọi thứ. Đo trên 7 luồng: RMS −34.4 dB với
    // normalize=1 so với −17.5 dB khi tắt (lane chính một mình là −21.1 dB).
    // Preview cộng thẳng các GainNode ở âm lượng đã đặt, KHÔNG chia, nên chỉ normalize=0
    // mới cho preview ≙ bản xuất. Âm lượng từng block đã do người dùng/ASE đặt (SFX −6 dB,
    // nhạc nền −13 dB) — chia thêm lần nữa là phủ nhận chính các con số đó.
    // dropout_transition giữ 0: nó chỉ có tác dụng khi normalize=1, để đây cho rõ ý.
    script << "amix=inputs=" << audioLabels.size()
           << ":duration=first:dropout_transition=0:normalize=0,aresample=48000[a]\n";
  }
  return true;
}

/* Đường dẫn NGẮN NHẤT còn trỏ đúng tệp, khi ffmpeg chạy với thư mục làm việc = `baseDir`.
 *
 * VÌ SAO ĐÁNG: mọi ảnh do renderer bake ra (phụ đề, hình khối, chuỗi khung hoạt ảnh) đều
 * nằm trong temp_uploads, và đường dẫn tuyệt đối tới đó dài ~98 ký tự trong khi phần đuôi
 * thật sự phân biệt chỉ ~28. Nhân với hàng trăm overlay, phần tiền tố lặp lại ấy là thứ
 * đẩy dòng lệnh vượt trần của Windows (xem khối chú thích ở RunIn).
 * Tệp NẰM NGOÀI baseDir (media người dùng liên kết từ thư mục khác) giữ nguyên tuyệt đối. */
std::string ShortInputPath(const std::string& absolutePath, const fs::path& baseDir) {
  if (baseDir.empty() || absolutePath.empty()) return absolutePath;
  std::error_code ec;
  const fs::path relative = fs::relative(fs::path(absolutePath), baseDir, ec);
  if (ec || relative.empty()) return absolutePath;
  const std::string text = relative.string();
  // `..` leo ra ngoài baseDir thì chẳng ngắn hơn bao nhiêu mà lại khó đọc khi gỡ lỗi.
  if (text.rfind("..", 0) == 0) return absolutePath;
  return text.size() < absolutePath.size() ? text : absolutePath;
}

/* ===== SEEK THEO BATCH (mục 1.1 bước đầu, docs/KE_HOACH_TOI_UU_EXPORT_WIN.md) =====
 *
 * Mỗi batch mở `temp_input.mp4` bằng `-i` KHÔNG seek, nên ffmpeg giải mã từ giây 0 tới mốc cuối
 * mà batch cần — batch thứ k trả lại toàn bộ phần của k−1 batch trước. Đo 2026-09-28 (dự án
 * phụ đề 4K AV1, bản cắt 300 s, 2 batch): batch 2 giải mã 0..300 s mất 29 s trong khi chỉ cần
 * 120 s cuối; với bản 39 phút (13 batch) tổng giải mã ~6,9× số khung thật sự dùng.
 *
 * Cách chữa KHÔNG đổi một mốc thời gian nào: `-itsoffset S -ss S -i`. Không có -copyts thì
 * ffmpeg_demux.c đặt ts_offset = itsoffset − (S + start_time) = −start_time, ĐÚNG bằng khi
 * không seek, nên PTS mọi khung giữ nguyên từng bit và mọi `trim`/`atrim` trong filter script
 * dùng lại y nguyên. Trim mà -ss tự chèn là `start=0` (trim_start_us = 0 khi không copyts), chỉ
 * bỏ khung pts < 0 — tức không bỏ gì; các khung dư giữa keyframe và S bị chính `trim` của
 * clip loại như hôm nay.
 *
 * S = mốc cắt SỚM NHẤT của batch − kBatchSeekMarginSeconds. Lề 1 s để một khung nguồn lệch dấu
 * phẩy động không bao giờ lọt ra trước S; tốn thêm tối đa 1 s giải mã mỗi batch. S dưới
 * kBatchSeekMinSeconds thì không seek (lợi không đáng). Tắt: CRABBYCUT_EXPORT_SEEK=0.
 *
 * CHỈ BATCH CHỈ-HÌNH (FilterScriptMode::VideoOnly) — đúng loại batch của dự án có lớp phủ dài,
 * nơi cấp số cộng này ăn ~27 phút. Batch có tiếng thì KHÔNG seek: bộ giải mã AAC mang trạng
 * thái theo số gói đã giải mã (bộ sinh nhiễu PNS), nên giải mã từ giữa file cho mẫu float khác
 * — đo 2026-09-28: cùng `atrim=12.25:13`, giải mã từ 0 và từ `-ss 11.25` khác nhau ở hầu hết
 * mẫu, sau encode lệch tối đa 1 LSB. Không nghe được, nhưng tiếng hôm nay khớp từng bit giữa
 * các lượt xuất và không có lý do gì để đổi điều đó. Đo xong: hình khớp từng khung (framemd5). */
constexpr double kBatchSeekMarginSeconds = 1.0;
constexpr double kBatchSeekMinSeconds = 5.0;

bool BatchSeekEnabled() {
  const char* env = std::getenv("CRABBYCUT_EXPORT_SEEK");
  if (!env) return true;
  const std::string value = env;
  return !(value == "0" || value == "false" || value == "off");
}

/* Seek vào GIỮA bản nối có an toàn không. Bản nối `-c copy` từ nhiều nguồn khác extradata
 * (SPS/PPS…) mang nhiều sample description; demuxer mp4 báo chỗ đổi bằng side data
 * "New Extradata" trên gói. Có chỗ đổi thì không seek — giải mã từ 0 như cũ, chậm mà chắc.
 * Một nguồn, hoặc bản nối đã chuẩn hoá (cùng một cấu hình x264), thì không có chỗ đổi nào.
 * Chỉ đọc header gói (không giải mã) nên rẻ: ~1 s cho 56.757 gói của nguồn AV1 39 phút. */
bool SourceSeekSafe(const std::string& source) {
  const std::string out = CommandOutput({
    "ffprobe", "-v", "error", "-select_streams", "v:0",
    "-show_entries", "packet_side_data=side_data_type", "-of", "csv=p=0", source
  });
  return out.find("New Extradata") == std::string::npos;
}

double BatchSeekSeconds(const std::vector<ExportInterval>& intervals, size_t offset, size_t count,
                        const ExportSettings& settings, FilterScriptMode mode) {
  if (!settings.seekSafe || count == 0 || mode != FilterScriptMode::VideoOnly) return 0.0;
  double earliest = 0.0;
  for (size_t i = 0; i < count; i++) {
    const ExportInterval& item = intervals[offset + i];
    const double cut = item.start + settings.videoStart;
    earliest = i == 0 ? cut : std::min(earliest, cut);
  }
  const double seekTo = earliest - kBatchSeekMarginSeconds;
  return seekTo >= kBatchSeekMinSeconds ? seekTo : 0.0;
}

/* ===== MỖI DẢI NGUỒN MỘT INPUT (mục 1.1, docs/KE_HOACH_TOI_UU_EXPORT_WIN.md) =====
 *
 * Mọi clip lane chính đọc CÙNG một [0:v]: bộ giải mã chạy một mạch từ đầu tới mốc cuối mà batch
 * cần, và MỖI khung được phát tới đủ N nhánh `trim` rồi phần lớn bị vứt. Dự án cắt theo kịch bản
 * (clip rải khắp nguồn) trả giá nặng nhất. Đo 2026-09-30 trên "Bin Tom - Tap 3" (20 clip, dùng
 * 76,6 s trên dải nguồn 9,96 → 265 s, H.264 1080×1920): 19–21 s -> 16,1–16,5 s khi gom thành 12
 * dải, CPU 95 -> 67 CPU-giây, bản xuất trùng framemd5 2.297/2.297 khung; RAM 1,53 -> 1,68 GB.
 *
 * Cách làm y như seek theo batch (xem khối chú thích ở trên): mỗi dải là một input
 * `-itsoffset S -ss S -i nguồn`, PTS giữ nguyên nên `trim` của từng clip dùng nguyên. Dải = các
 * cửa sổ `trim` (tính y như WriteClipVideoFilters) xếp theo mốc nguồn, gộp khi cách nhau dưới
 * kRangeMergeGapSeconds; quá MaxSourceRanges thì gộp hai dải có khe nhỏ nhất. Mọi bộ giải mã
 * khởi động cùng lúc (đồ hình chỉ cấu hình khi mọi input đã có khung), nên số dải giảm theo độ
 * phân giải nguồn. Lượt tiếng không dùng dải: tiếng vẫn giải mã từ 0 trên input 0 (xem lý do AAC
 * ở trên). Batch chỉ-hình thì dải đầu dùng luôn input 0 — một dải là đúng seek theo batch cũ.
 * Chỉ khi seek an toàn (SourceSeekSafe). Tắt: CRABBYCUT_EXPORT_RANGES=0. */
constexpr double kRangeMergeGapSeconds = 2.0;

bool SourceRangesEnabled() {
  const char* env = std::getenv("CRABBYCUT_EXPORT_RANGES");
  if (!env) return true;
  const std::string value = env;
  return !(value == "0" || value == "false" || value == "off");
}

// 12 dải ở ≤ 1080p, 6 ở 4K (giảm theo căn bậc hai số điểm ảnh); chưa đo được cỡ nguồn thì 6.
size_t MaxSourceRanges(const ExportSettings& settings) {
  if (settings.sourceWidth <= 0 || settings.sourceHeight <= 0) return 6;
  const double pixels = static_cast<double>(settings.sourceWidth) * settings.sourceHeight;
  const long n = std::lround(12.0 * std::sqrt((1920.0 * 1080.0) / std::max(1.0, pixels)));
  return static_cast<size_t>(std::max(4L, std::min(12L, n)));
}

struct SourceRangePlan {
  std::vector<double> seekTo;     // mỗi dải một mốc seek (0 = không seek)
  std::vector<size_t> clipRange;  // clip (chỉ số trong batch) -> dải
  bool inputZeroIsRange = false;  // dải 0 dùng luôn input 0 (batch chỉ-hình)
  bool active() const { return !seekTo.empty(); }
};

SourceRangePlan PlanSourceRanges(const std::vector<ExportInterval>& intervals, size_t offset, size_t count,
                                 const ExportSettings& settings, FilterScriptMode mode) {
  SourceRangePlan plan;
  if (!SourceRangesEnabled() || !BatchSeekEnabled() || !settings.seekSafe || count == 0
      || mode == FilterScriptMode::AudioOnly) {
    return plan;
  }
  struct Group { double from; double to; std::vector<size_t> clips; };
  std::vector<Group> wins;
  const double half = settings.sourceFps > 0.0 ? 0.5 / settings.sourceFps : 0.0;
  for (size_t i = 0; i < count; i++) {
    const ExportInterval& item = intervals[offset + i];
    const double from = std::max(0.0, item.start + settings.videoStart - half);
    const double to = std::max(from, item.end + settings.videoStart - half);
    wins.push_back({from, to, {i}});
  }
  std::stable_sort(wins.begin(), wins.end(), [](const Group& a, const Group& b) { return a.from < b.from; });
  std::vector<Group> groups;
  for (auto& w : wins) {
    if (!groups.empty() && w.from - groups.back().to < kRangeMergeGapSeconds) {
      groups.back().to = std::max(groups.back().to, w.to);
      groups.back().clips.push_back(w.clips.front());
    } else {
      groups.push_back(w);
    }
  }
  const size_t maxRanges = MaxSourceRanges(settings);
  while (groups.size() > maxRanges) {
    size_t best = 0;
    for (size_t i = 1; i + 1 < groups.size(); i++) {
      if (groups[i + 1].from - groups[i].to < groups[best + 1].from - groups[best].to) best = i;
    }
    groups[best].to = std::max(groups[best].to, groups[best + 1].to);
    groups[best].clips.insert(groups[best].clips.end(), groups[best + 1].clips.begin(), groups[best + 1].clips.end());
    groups.erase(groups.begin() + static_cast<long>(best) + 1);
  }
  plan.inputZeroIsRange = mode == FilterScriptMode::VideoOnly;
  plan.clipRange.assign(count, 0);
  for (size_t k = 0; k < groups.size(); k++) {
    const double seek = groups[k].from - kBatchSeekMarginSeconds;
    plan.seekTo.push_back(seek >= kBatchSeekMinSeconds ? seek : 0.0);
    for (size_t clip : groups[k].clips) plan.clipRange[clip] = k;
  }
  // Batch có tiếng, một dải, không seek = đúng [0:v] như cũ: giữ nguyên lệnh.
  if (!plan.inputZeroIsRange && groups.size() == 1 && plan.seekTo[0] <= 0.0) return SourceRangePlan();
  return plan;
}

// Cờ giải mã NVDEC ra thẳng khung CUDA cho một input của đồ thị GPU (thiết bị `cu`, xem PrepareExportBatch).
void AppendNvdecInputArgs(std::vector<std::string>& cmd) {
  cmd.insert(cmd.end(), {"-hwaccel", "cuda", "-hwaccel_device", "cu", "-hwaccel_output_format", "cuda"});
}

void AppendOverlayInputArgs(
  std::vector<std::string>& cmd,
  const std::vector<ExportOverlay>& overlays,
  double sequenceDuration,
  const fs::path& baseDir,
  const ExportSettings& settings,
  bool gpuGraph = false
) {
  for (const auto& overlay : overlays) {
    if (!OverlayNeedsInput(overlay)) continue;
    const std::string assetPath = ShortInputPath(overlay.assetPath, baseDir);
    if (OverlayIsImageSequence(overlay)) {
      cmd.insert(cmd.end(), {
        "-framerate", FfmpegDouble(overlay.seqFps),
        "-start_number", "0",
        "-i", assetPath
      });
    } else if (OverlayStillOnce(overlay)) {
      // Một khung duy nhất; `loop` trong filter lặp lại khung đã xử lý (xem OverlayStillOnce).
      cmd.insert(cmd.end(), {"-i", assetPath});
    } else if (OverlayIsImageLike(overlay)) {
      // Dư 1 s: lớp phủ tĩnh xén ở cuối batch dài quá mép batch (xem OverlaysForBatch).
      cmd.insert(cmd.end(), {
        "-loop", "1",
        "-t", FixedSeconds(std::max(0.05, sequenceDuration + kBatchOverlayTailSeconds)),
        "-i", assetPath
      });
    } else {
      /* `-reinit_filter:v 0` — CÙNG LÝ DO với input lane chính (xem ExportBatch), và ở đây
       * thiếu nó thì không chỉ chớp đen mà TREO VĨNH VIỄN.
       * Video mà luồng hình của chính nó đổi pix_fmt/color_range/colorspace giữa chừng (bản
       * nối `-c copy` nhiều nguồn: `yuv420p/tv/bt709` -> `yuvj420p/pc/bt470bg` tại chỗ nối)
       * làm fftools dựng lại CẢ filtergraph ngay giữa lượt. Lane chính `concat` từ 3 clip trở
       * lên + lớp phủ vắt qua chỗ đổi đó = ffmpeg đứng im, 0% CPU, không lỗi, không thoát.
       * Tái hiện 2026-09-27 trên BtbN N-123955, Gyan 8.1.1 và BtbN master; có cờ thì xong
       * trong vài giây. Màu đoạn sau chỗ đổi vẫn đúng: `scale`/bộ chuyển định dạng tự đọc
       * thuộc tính màu của TỪNG khung.
       * Chỉ luồng HÌNH (`:v`): với tiếng, buffersrc từ chối hẳn khung đổi thông số (EINVAL)
       * khi không được dựng lại, nên tiếng giữ hành vi cũ.
       * Test: tests/scripts/export_concat_video_overlay.js. */
      cmd.insert(cmd.end(), {"-reinit_filter:v", "0"});
      // NVDEC chỉ cho lớp phủ có bản GPU riêng: CpuYuv/CpuCanvas xử lý khung ở CPU.
      if (gpuGraph && overlay.gpuNvdec && OverlayGpuModeFor(overlay, settings) == OverlayGpu::Native) {
        AppendNvdecInputArgs(cmd);
      }
      cmd.insert(cmd.end(), {"-i", assetPath});
    }
  }
}

/* Map luồng theo chế độ. `-vn`/`-an` là BẮT BUỘC chứ không thừa: ở chế độ VideoOnly
 * filtergraph không có nhãn [a] nào, mà ffmpeg vẫn TỰ NHẶT rãnh tiếng của input 0 nếu không
 * cấm — bản xuất ra có tiếng CHƯA qua bộ lọc (sai âm lượng, chưa khử ồn, thiếu tiếng của
 * lớp phủ). Hỏng kiểu đó phải nghe mới biết, nhìn không thấy.
 *
 * `-/filter_complex <file>` (có từ FFmpeg 7.0), KHÔNG dùng `-filter_complex_script`: FFmpeg
 * master đã XOÁ hẳn tùy chọn đó (commit 07407fff61, có trong 9.0). Bộ cài cũ tải BtbN
 * `latest` nên máy cài mới nhận đúng bản đã xoá và mọi lượt export chết với "Unrecognized
 * option". Tiền tố `/` đọc giá trị từ file qua avio nên đường dẫn Unicode vẫn an toàn. */
void AppendStreamMapArgs(std::vector<std::string>& cmd, const fs::path& scriptPath, FilterScriptMode mode) {
  cmd.insert(cmd.end(), {"-/filter_complex", scriptPath.string()});
  if (mode != FilterScriptMode::AudioOnly) cmd.insert(cmd.end(), {"-map", "[v]"});
  else cmd.push_back("-vn");
  if (mode != FilterScriptMode::VideoOnly) cmd.insert(cmd.end(), {"-map", "[a]"});
  else cmd.push_back("-an");
  cmd.insert(cmd.end(), {"-sn", "-dn"});
}

void AppendEncoderArgsForMode(std::vector<std::string>& cmd, const ExportSettings& settings,
                              const EncoderPlan& plan, FilterScriptMode mode) {
  if (mode == FilterScriptMode::AudioOnly) {
    /* Không có luồng hình -> mọi tham số encoder hình (kể cả -r/-fps_mode/-g) đều vô nghĩa,
       và `-r` trên một lượt chỉ-tiếng làm ffmpeg cảnh báo rồi bỏ qua. */
    if (settings.codec == "prores") cmd.insert(cmd.end(), {"-c:a", "pcm_s16le"});
    else cmd.insert(cmd.end(), {"-c:a", "aac", "-b:a", settings.audioBitrate});
    return;
  }
  AppendEncoderArgs(cmd, settings, plan);
}

/* MỘT LƯỢT FFMPEG ĐÃ CHUẨN BỊ, CHƯA CHẠY (mục 1.8). PrepareExportBatch ghi filter script và dựng
 * sẵn mọi thứ của dòng lệnh trừ bộ mã hoá; `buildCmd(plan, nhãn)` ghép nốt phần bộ mã hoá — lỗi
 * phần cứng thì dựng lại với plan CPU. Tách hai bước để nhiều batch chạy SONG SONG được: bước
 * chuẩn bị đụng biến toàn cục (g_clipVideoInput, g_filterAuxSeq, g_fastClipCount) nên chạy tuần
 * tự ở luồng chính; bước chạy chỉ là tiến trình ffmpeg (xem RunBatchJobs). */
struct BatchJob {
  ExportRunTiming timing;
  fs::path scriptPath;
  fs::path tempDir;
  bool video = true;   // false = lượt chỉ-tiếng: không phụ thuộc bộ mã hoá hình
  std::string progressText;   // "batch 2/4 (7 đoạn)" — dòng tiến độ lúc khởi chạy
  std::function<std::vector<std::string>(const EncoderPlan&, const std::string&)> buildCmd;
  /* ĐỒ THỊ GPU (mục 1.21): batch đạt BatchGpuEligible thì `buildCmd` chạy bản GPU (`gpuScriptPath`);
   * bản CPU (`scriptPath`, `buildCmdCpu`) luôn được ghi sẵn để chạy lại khi lượt GPU lỗi hoặc khi
   * bộ mã hoá lùi về CPU (libx264 không nhận khung CUDA) — xem UseCpuGraph. */
  bool gpu = false;
  fs::path gpuScriptPath;
  std::function<std::vector<std::string>(const EncoderPlan&, const std::string&)> buildCmdCpu;
};

void UseCpuGraph(BatchJob& job) {
  if (!job.gpu) return;
  job.gpu = false;
  job.timing.gpu = false;
  job.buildCmd = job.buildCmdCpu;
}

bool PrepareExportBatch(
  BatchJob& job,
  const std::string& source,
  const std::string& output,
  const fs::path& tempDir,
  const std::vector<ExportInterval>& intervals,
  size_t offset,
  size_t count,
  size_t batchIndex,
  size_t batchCount,
  const ExportSettings& settings,
  const std::vector<ExportOverlay>& overlays,
  FilterScriptMode mode = FilterScriptMode::Full
) {
  fs::create_directories(fs::path(output).parent_path());
  const fs::path scriptPath = tempDir / ("export_filter_batch_" + std::to_string(batchIndex) + ".txt");
  /* Dải nguồn (mục 1.1, xem PlanSourceRanges): input thêm đứng SAU input lớp phủ, nên chỉ số
   * lớp phủ (1 + assetInputIndex) giữ nguyên. Phải biết trước khi ghi filter script. */
  const SourceRangePlan ranges = PlanSourceRanges(intervals, offset, count, settings, mode);
  int overlayInputs = 0;
  for (const auto& overlay : overlays) {
    if (OverlayNeedsInput(overlay)) overlayInputs++;
  }
  const size_t firstExtraRange = ranges.inputZeroIsRange ? 1 : 0;
  g_clipVideoInput.clear();
  for (size_t i = 0; ranges.active() && i < count; i++) {
    const size_t k = ranges.clipRange[i];
    g_clipVideoInput.push_back(k < firstExtraRange ? 0 : 1 + overlayInputs + static_cast<int>(k - firstExtraRange));
  }
  const bool scriptOk = WriteFilterScript(scriptPath, intervals, offset, count, settings, overlays, mode);
  /* Bản GPU của cùng batch (cùng dải nguồn, cùng chỉ số input) — xem BatchJob. Ghi lỗi thì thôi,
   * batch đi bản CPU. */
  bool gpu = false;
  const fs::path gpuScriptPath = tempDir / ("export_filter_batch_" + std::to_string(batchIndex) + "_gpu.txt");
  if (scriptOk && mode != FilterScriptMode::AudioOnly && BatchGpuEligible(intervals, offset, count, overlays, settings)) {
    g_gpuGraph = true;
    gpu = WriteFilterScript(gpuScriptPath, intervals, offset, count, settings, overlays, mode);
    g_gpuGraph = false;
  }
  g_clipVideoInput.clear();
  if (!scriptOk) {
    Emit("error", "cannot write ffmpeg filter script", 6);
    return false;
  }

  /* `-reinit_filter 0` — ĐÂY LÀ THỨ DẸP CHỚP ĐEN Ở ĐIỂM NỐI CẢNH.
   * (Port từ nhánh CrabbyCut_v2.0.0, commit 6dd4f6d — đã đo ở đó, xem số liệu bên dưới.)
   *
   * Mặc định, khi một khung giải mã ra có `format` / `color_range` / `colorspace` khác với
   * tham số mà buffersrc đang giữ, ffmpeg DỰNG LẠI TOÀN BỘ đồ hình filter
   * (ffmpeg_filter.c, `need_reinit`). Dựng lại thì MỌI FILTER NGUỒN chạy lại từ pts 0 —
   * nghĩa là mỗi `color=c=black:d=…` phát lại NGUYÊN dải nền đen của nó một lần nữa.
   * Những khung đen trùng mốc đó rơi vào `concat`, và `-fps_mode cfr` ở encoder chọn đúng
   * một khung cho mỗi ô thời gian -> lọt ra thành khung đen.
   *
   * Vì sao nguồn không đồng nhất: `CommandConcat` nối bằng concat demuxer `-c copy`. Bộ
   * nguồn nào đã đồng dạng sẵn thì backend BỎ HẲN bước chuẩn hoá (xem
   * normalizeSourcesForConcat) — lúc đó mỗi shot giữ nguyên thuộc tính màu của chính nó.
   *
   * ĐÃ ĐO trên dự án thật (`Khám phá Hạ Long`, 18 cảnh): temp_input.mp4 đổi thuộc tính
   * giữa chừng ĐÚNG 5 lần (yuv420p·tv·bt709 <-> yuvj420p·pc·bt470bg) tại khung
   * 280/641/719/815/919 -> đúng 5 mốc chớp đen. Cùng kịch bản filter, cùng 1080x1920:
   *     không cờ  -> 1886 khung, 5 vùng đen
   *     có cờ     -> 1884 khung, 0 vùng đen
   *
   * MÀU KHÔNG ĐỔI: đã đo YAVG nguồn vs bản xuất ở cả vùng `tv` lẫn `pc`, có cờ và không cờ
   * lệch nhau <= 0.5/255. Các filter `scale`/`format` phía sau tự cấu hình lại swscale theo
   * thuộc tính của TỪNG khung nên phép chuyển màu vẫn đúng.
   * ĐỔI ĐỘ PHÂN GIẢI giữa chừng cũng an toàn — đã thử 320x240 -> 640x480: đúng số khung,
   * không khung hỏng, không vùng đen. */
  // Seek theo batch: xem khối chú thích ở BatchSeekSeconds — PTS không đổi nên filter script
  // viết ở trên dùng nguyên được.
  const double seekTo = ranges.inputZeroIsRange ? ranges.seekTo[0]
                                                : BatchSeekSeconds(intervals, offset, count, settings, mode);
  ExportRunTiming& timing = job.timing;
  timing = ExportRunTiming{};
  timing.seekTo = seekTo;
  timing.fastClips = static_cast<size_t>(g_fastClipCount);
  timing.sourceRanges = ranges.seekTo.size();
  timing.mode = mode == FilterScriptMode::AudioOnly ? "audio"
              : (mode == FilterScriptMode::VideoOnly ? "video" : "full");
  timing.label = mode == FilterScriptMode::AudioOnly
    ? std::string("audio")
    : "batch_" + std::to_string(10000 + static_cast<int>(batchIndex)).substr(1);
  timing.intervals = count;
  timing.overlays = overlays.size();
  timing.sequenceDuration = SequenceDuration(intervals, offset, count);
  for (size_t i = 0; i < count; i++) {
    const ExportInterval& item = intervals[offset + i];
    timing.sourceFrom = i == 0 ? item.start : std::min(timing.sourceFrom, item.start);
    timing.sourceTo = std::max(timing.sourceTo, item.end);
  }
  job.scriptPath = scriptPath;
  job.tempDir = tempDir;
  job.video = mode != FilterScriptMode::AudioOnly;
  job.progressText = "batch " + std::to_string(batchIndex + 1) + "/" + std::to_string(batchCount)
                   + " (" + std::to_string(count) + " đoạn)";
  /* CHẠY VỚI THƯ MỤC LÀM VIỆC = tempDir. Đây là thứ làm cho đường dẫn tương đối ở
     AppendOverlayInputArgs trỏ đúng tệp. `source`, `output` và tệp kịch bản filter vẫn
     tuyệt đối nên không phụ thuộc vào cwd; đường dẫn NẰM TRONG kịch bản filter (LUT, mặt nạ)
     cũng tuyệt đối — xem FilterPath. Dựng lệnh là bản sao toàn bộ dữ liệu cần (lambda giữ
     theo giá trị): lớp phủ của batch là biến tạm ở nơi gọi. */
  const double sequenceDuration = timing.sequenceDuration;
  /* Đồ thị GPU: thiết bị CUDA `cu` khởi tạo một lần cho cả lệnh (bộ lọc dùng qua -filter_hw_device,
   * NVDEC qua -hwaccel_device) để mọi khung chung một ngữ cảnh CUDA với NVENC. */
  const bool nvdecMain = g_gpuMainNvdec;
  const auto makeBuildCmd = [=](bool gpuGraph) {
    const fs::path graphPath = gpuGraph ? gpuScriptPath : scriptPath;
    const bool nvdec = gpuGraph && nvdecMain;
    return [=](const EncoderPlan& plan, const std::string& runLabel) {
      std::vector<std::string> cmd = {"ffmpeg", "-y", "-hide_banner", "-v", "error", "-nostdin"};
      if (gpuGraph) cmd.insert(cmd.end(), {"-init_hw_device", "cuda=cu", "-filter_hw_device", "cu"});
      cmd.insert(cmd.end(), {"-reinit_filter", "0"});   // PHẢI đứng TRƯỚC -i: đây là tuỳ chọn của INPUT
      if (seekTo > 0.0) {
        cmd.insert(cmd.end(), {"-itsoffset", FixedSeconds(seekTo), "-ss", FixedSeconds(seekTo)});
      }
      if (nvdec) AppendNvdecInputArgs(cmd);
      cmd.insert(cmd.end(), {"-i", source});
      AppendOverlayInputArgs(cmd, overlays, sequenceDuration, tempDir, settings, gpuGraph);
      for (size_t k = firstExtraRange; k < ranges.seekTo.size(); k++) {
        cmd.insert(cmd.end(), {"-reinit_filter", "0"});
        if (ranges.seekTo[k] > 0.0) {
          cmd.insert(cmd.end(), {"-itsoffset", FixedSeconds(ranges.seekTo[k]), "-ss", FixedSeconds(ranges.seekTo[k])});
        }
        if (nvdec) AppendNvdecInputArgs(cmd);
        cmd.insert(cmd.end(), {"-i", source});
      }
      AppendStreamMapArgs(cmd, graphPath, mode);
      AppendEncoderArgsForMode(cmd, settings, plan, mode);
      if (!g_exportBenchDir.empty()) {
        const std::string rel = "export_bench/" + runLabel;
        cmd.insert(cmd.end(), {"-benchmark", "-progress", rel + ".progress.txt"});
        if (FfmpegHasPrintGraphs()) cmd.insert(cmd.end(), {"-print_graphs_file", rel + ".graphs.json"});
      }
      /* `+faststart` chỉ cho tệp CUỐI (một batch ghi thẳng ra đích). Batch trung gian và lượt
       * tiếng chỉ là đầu vào của bước ghép: dời `moov` lên đầu là đọc + ghi lại cả tệp lần hai
       * cho không ai dùng (đo: ~0,6 s mỗi batch 4K 180 s). */
      if (batchCount <= 1) cmd.insert(cmd.end(), {"-movflags", "+faststart"});
      cmd.push_back(output);
      return cmd;
    };
  };
  job.buildCmdCpu = makeBuildCmd(false);
  job.gpu = gpu;
  job.timing.gpu = gpu;
  job.gpuScriptPath = gpu ? gpuScriptPath : fs::path();
  if (gpu) job.buildCmd = makeBuildCmd(true);
  else job.buildCmd = job.buildCmdCpu;
  return true;
}

// Dòng lệnh của một lần chạy job: ghi cmd.json + bật FFREPORT khi đo (CRABBYCUT_EXPORT_BENCH).
// FFREPORT là biến môi trường của TIẾN TRÌNH CON, chốt lúc khởi chạy — đặt ngay trước mỗi lần
// spawn ở luồng chính là đủ, kể cả khi các ffmpeg khác đang chạy.
std::vector<std::string> JobCommandForRun(const BatchJob& job, const EncoderPlan& plan, const std::string& runLabel) {
  std::vector<std::string> cmd = job.buildCmd(plan, runLabel);
  if (!g_exportBenchDir.empty()) {
    WriteBenchCommand(runLabel, cmd, job.tempDir);
    SetChildEnv("FFREPORT", "file=export_bench/" + runLabel + ".log:level=32");
  }
  return cmd;
}

/* SỐ LƯỢT FFMPEG CHẠY SONG SONG (mục 1.8). Đồ thị của một lượt có chuỗi lớp phủ chạy trên MỘT
 * luồng filter: Bin Tom (20 clip, 19 lớp phủ) chỉ dùng 40–55% của 16 luồng CPU. Đo cả lượt xuất
 * (phát lại, Ryzen 7 2700X 16 luồng), 1 / 2 / 3 / 4 lượt hình cùng lúc: Bin Tom 20,7 / 15,0 /
 * 14,1 / 13,8 s; Test.crab 13,5 / 11,4 / 11,0 s; "Yêu Con 1" 60 / 52 / 52 s (chỉ cắt được một
 * mốc); phim 4K AV1 300 s đã bão hoà CPU nên không đổi (67 / 67 / 66 s). Mặc định: 1 lượt hình
 * cho mỗi 4 luồng CPU, tối đa 3; bớt khi RAM ít — mỗi lượt giữ khung của nhiều bộ giải mã (dải
 * nguồn mục 1.1) và của chuỗi lớp phủ: ~1,5 GB ở ≤ 1080p, ~3 GB ở 4K.
 * Env: CRABBYCUT_EXPORT_PARALLEL=N (0/1 = tắt, chạy nối tiếp như trước). */
size_t ExportParallelWorkers(const ExportSettings& settings) {
  if (const char* env = std::getenv("CRABBYCUT_EXPORT_PARALLEL")) {
    if (*env) return static_cast<size_t>(std::max(1, std::min(8, std::atoi(env))));
  }
  const unsigned threads = std::max(1u, std::thread::hardware_concurrency());
  size_t workers = std::max<size_t>(1, std::min<size_t>(3, threads / 4));
#ifdef _WIN32
  MEMORYSTATUSEX mem;
  mem.dwLength = sizeof(mem);
  if (GlobalMemoryStatusEx(&mem)) {
    const double totalGb = static_cast<double>(mem.ullTotalPhys) / (1024.0 * 1024.0 * 1024.0);
    const double pixels = static_cast<double>(std::max(1, settings.width)) * std::max(1, settings.height);
    const double perWorkerGb = pixels > 1920.0 * 1080.0 * 1.5 ? 3.0 : 1.5;
    workers = std::min(workers, std::max<size_t>(1, static_cast<size_t>(totalGb * 0.5 / perWorkerGb)));
  }
#else
  (void)settings;
  workers = 1;   // chưa có đường spawn không chờ cho macOS/Linux (xem RunBatchJobs)
#endif
  return workers;
}

/* Chạy các job, tối đa `concurrency` tiến trình cùng lúc (Windows: CreateProcessW không chờ +
 * WaitForMultipleObjects; nơi khác: nối tiếp). Job lỗi được báo trong `codes`, không dừng job
 * khác — nơi gọi quyết định chạy lại. */
std::vector<int> RunBatchJobs(std::vector<BatchJob*>& jobs, const EncoderPlan& plan, size_t concurrency,
                              const std::string& labelSuffix) {
  std::vector<int> codes(jobs.size(), 0);
  concurrency = std::max<size_t>(1, concurrency);
#ifdef _WIN32
  struct Active { size_t index; HANDLE process; ExportClock::time_point started; };
  std::vector<Active> active;
  size_t next = 0;
  while (next < jobs.size() || !active.empty()) {
    while (next < jobs.size() && active.size() < concurrency) {
      BatchJob& job = *jobs[next];
      const std::string runLabel = job.timing.label + labelSuffix;
      const std::vector<std::string> cmd = JobCommandForRun(job, plan, runLabel);
      Emit("progress", "Đang render " + job.progressText
                       + (concurrency > 1 ? " — " + std::to_string(active.size() + 1) + " lượt chạy cùng lúc" : "") + "...");
      int immediate = 0;
      const auto started = ExportClock::now();
      HANDLE process = SpawnIn(cmd, job.tempDir, immediate);
      if (process) {
        active.push_back({next, process, started});
      } else if (immediate != 0) {
        codes[next] = immediate;
      } else {
        // CreateProcessW hỏng: chạy chờ như RunIn (lùi về std::system).
        codes[next] = RunIn(cmd, job.tempDir);
        job.timing.runMs += MsSince(started);
      }
      if (!g_exportBenchDir.empty()) SetChildEnv("FFREPORT", "");
      next++;
    }
    if (active.empty()) continue;
    std::vector<HANDLE> handles;
    for (const auto& a : active) handles.push_back(a.process);
    const DWORD waited = WaitForMultipleObjects(static_cast<DWORD>(handles.size()), handles.data(), FALSE, INFINITE);
    if (waited < WAIT_OBJECT_0 || waited >= WAIT_OBJECT_0 + handles.size()) {
      // Không chờ được (không nên xảy ra): chờ lần lượt cho chắc.
      for (const auto& a : active) WaitForSingleObject(a.process, INFINITE);
    }
    for (size_t i = 0; i < active.size();) {
      if (WaitForSingleObject(active[i].process, 0) != WAIT_OBJECT_0) { i++; continue; }
      DWORD exitCode = 1;
      GetExitCodeProcess(active[i].process, &exitCode);
      CloseHandle(active[i].process);
      codes[active[i].index] = static_cast<int>(exitCode);
      jobs[active[i].index]->timing.runMs += MsSince(active[i].started);
      active.erase(active.begin() + static_cast<std::ptrdiff_t>(i));
    }
  }
#else
  (void)concurrency;
  for (size_t i = 0; i < jobs.size(); i++) {
    BatchJob& job = *jobs[i];
    Emit("progress", "Đang render " + job.progressText + "...");
    const std::vector<std::string> cmd = JobCommandForRun(job, plan, job.timing.label + labelSuffix);
    const auto started = ExportClock::now();
    codes[i] = RunIn(cmd, job.tempDir);
    job.timing.runMs += MsSince(started);
    if (!g_exportBenchDir.empty()) SetChildEnv("FFREPORT", "");
  }
#endif
  return codes;
}

/* Chạy cả bộ job, tối đa `concurrency` tiến trình cùng lúc, rồi xử lý lỗi:
 *  - job hình lỗi khi dùng bộ mã hoá PHẦN CỨNG:
 *      chạy song song -> chạy lại từng cái MỘT bằng chính bộ mã hoá đó trước (lỗi có thể chỉ vì
 *      nhiều phiên NVENC cùng lúc — GeForce có trần số phiên, dùng chung với OBS/ShadowPlay);
 *      vẫn lỗi (hoặc chạy nối tiếp) -> chạy lại MỌI job hình của bộ bằng CPU. Không ghép lẫn
 *      batch NVENC với batch libx264: ghép `-c copy` giữ SPS/PPS của batch đầu.
 *  - lỗi khác, hoặc lỗi cả khi đã ở CPU: trả mã lỗi.
 * Ghi timing của mọi job vào g_exportTiming theo thứ tự job; xoá filter script khi không đo. */
int RunExportJobs(std::vector<BatchJob>& jobs, EncoderPlan& plan, size_t concurrency, const ExportSettings& settings) {
  // Lượt tiếng khởi chạy TRƯỚC: nó nhẹ và chạy suốt, xong sớm thì nhường chỗ cho batch hình.
  std::vector<size_t> order;
  for (size_t i = 0; i < jobs.size(); i++) if (!jobs[i].video) order.push_back(i);
  for (size_t i = 0; i < jobs.size(); i++) if (jobs[i].video) order.push_back(i);
  std::vector<BatchJob*> all;
  for (size_t i : order) all.push_back(&jobs[i]);
  const std::vector<int> ordered = RunBatchJobs(all, plan, concurrency, "");
  std::vector<int> codes(jobs.size(), 0);
  for (size_t k = 0; k < order.size(); k++) codes[order[k]] = ordered[k];
  /* Đồ thị GPU lỗi (mục 1.21): chạy lại CHÍNH batch đó bằng đồ thị CPU, cùng bộ mã hoá, TRƯỚC logic
   * lùi bộ mã hoá bên dưới — lỗi thường ở NVDEC/bộ lọc CUDA chứ không ở NVENC. Vẫn lỗi thì rơi vào
   * logic cũ như mọi batch CPU. */
  std::vector<size_t> gpuFailed;
  for (size_t i = 0; i < jobs.size(); i++) {
    if (codes[i] != 0 && jobs[i].gpu) gpuFailed.push_back(i);
  }
  if (!gpuFailed.empty()) {
    Emit("progress", "Đồ thị GPU lỗi ở " + std::to_string(gpuFailed.size()) + " lượt — chạy lại bằng CPU...");
    // Kết quả dò GPU đã lưu có thể đã cũ (driver/GPU đổi) -> lượt sau dò lại (xem GpuProbeResult).
    std::error_code cacheEc;
    fs::remove(jobs[gpuFailed.front()].tempDir / kGpuProbeCacheName, cacheEc);
    std::vector<BatchJob*> retry;
    for (size_t i : gpuFailed) {
      UseCpuGraph(jobs[i]);
      jobs[i].timing.gpuFallback = true;
      retry.push_back(&jobs[i]);
    }
    const std::vector<int> again = RunBatchJobs(retry, plan, concurrency, "_gpufb");
    for (size_t k = 0; k < retry.size(); k++) codes[gpuFailed[k]] = again[k];
  }
  int failure = 0;
  std::vector<size_t> hardwareFailed;
  for (size_t i = 0; i < jobs.size(); i++) {
    if (codes[i] == 0) continue;
    if (jobs[i].video && plan.hardware) hardwareFailed.push_back(i);
    else failure = codes[i];
  }
  if (!failure && !hardwareFailed.empty()) {
    bool needCpu = true;
    if (concurrency > 1) {
      Emit("progress", "Encoder phần cứng " + plan.videoEncoder + " lỗi ở " + std::to_string(hardwareFailed.size())
                       + " lượt chạy cùng lúc — chạy lại lần lượt...");
      std::vector<BatchJob*> retry;
      for (size_t i : hardwareFailed) retry.push_back(&jobs[i]);
      const std::vector<int> again = RunBatchJobs(retry, plan, 1, "_retry");
      needCpu = false;
      for (size_t k = 0; k < retry.size(); k++) {
        codes[hardwareFailed[k]] = again[k];
        if (again[k] != 0) needCpu = true;
      }
    }
    if (needCpu) {
      Emit("progress", "Encoder phần cứng " + plan.videoEncoder + " lỗi, chuyển batch export sang CPU...");
      plan = CpuEncoderPlan(settings);
      std::vector<BatchJob*> videoJobs;
      std::vector<size_t> videoIndex;
      for (size_t i = 0; i < jobs.size(); i++) {
        if (!jobs[i].video) continue;
        jobs[i].timing.cpuRetry = true;
        UseCpuGraph(jobs[i]);   // libx264/libx265 không nhận khung CUDA
        videoJobs.push_back(&jobs[i]);
        videoIndex.push_back(i);
      }
      const std::vector<int> cpu = RunBatchJobs(videoJobs, plan, concurrency, "_cpu");
      for (size_t k = 0; k < videoJobs.size(); k++) {
        codes[videoIndex[k]] = cpu[k];
        if (cpu[k] != 0) failure = cpu[k];
      }
    }
  }
  for (size_t i = 0; i < jobs.size(); i++) {
    jobs[i].timing.exitCode = codes[i];
    if (jobs[i].gpu && codes[i] == 0) g_exportTiming.render = "gpu";
    g_exportTiming.runs.push_back(jobs[i].timing);
  }
  if (failure != 0) {
    Emit("error", "ffmpeg batch export failed", failure);
    return failure;
  }
  if (g_exportBenchDir.empty()) {
    for (const auto& job : jobs) {
      std::error_code ec;
      fs::remove(job.scriptPath, ec);
      if (!job.gpuScriptPath.empty()) fs::remove(job.gpuScriptPath, ec);
    }
  }
  return 0;
}

// Một batch, chạy ngay (nối tiếp) — mọi đường xuất không song song.
int ExportBatch(
  const std::string& source,
  const std::string& output,
  const fs::path& tempDir,
  const std::vector<ExportInterval>& intervals,
  size_t offset,
  size_t count,
  size_t batchIndex,
  size_t batchCount,
  const ExportSettings& settings,
  EncoderPlan& plan,
  const std::vector<ExportOverlay>& overlays,
  FilterScriptMode mode = FilterScriptMode::Full
) {
  std::vector<BatchJob> jobs(1);
  if (!PrepareExportBatch(jobs[0], source, output, tempDir, intervals, offset, count, batchIndex, batchCount,
                          settings, overlays, mode)) {
    return 6;
  }
  return RunExportJobs(jobs, plan, 1, settings);
}

/* Xoá thư mục batch trung gian. Lỗi thì bỏ qua (Defender/trình xem file có thể đang giữ một
 * file): lượt xuất sau vẫn remove_all trước khi dùng, như trước đây. */
void RemoveExportBatches(const fs::path& batchDir) {
  std::error_code ec;
  fs::remove_all(batchDir, ec);
}

/* CHỖ DÀNH SẴN CHO `moov` Ở ĐẦU TỆP (`-moov_size`, bước ghép cuối của lượt xuất nhiều batch).
 * `+faststart` ghi xong cả tệp rồi mới dời `moov` lên đầu, tức đọc + ghi lại TOÀN BỘ tệp lần hai
 * (bản 39 phút 4K: 11,5 GB). Dành sẵn chỗ thì `moov` ghi thẳng vào đó, phần dư thành hộp `free`.
 * Ước DƯ theo số mẫu: mỗi mẫu tốn tối đa ~36 byte trong bảng mẫu (stsz 4 + co64 8 + stsc 12 +
 * ctts 8 + stss 4); tiếng tính như AAC 96 kHz (1024 mẫu/gói) cho chắc. Thiếu thì ffmpeg báo
 * "reserved_moov_size is too small" và nơi gọi ghép lại bằng `+faststart`. Chỉ dùng cho lượt xuất
 * nhiều batch (≥ kOverlayBatchMinTotalSeconds), nên phần dư không đáng kể so với cỡ tệp. */
int MoovReserveBytes(double seconds, double fps) {
  const double videoSamples = std::max(0.0, seconds) * std::max(1.0, fps);
  const double audioSamples = std::max(0.0, seconds) * (96000.0 / 1024.0);
  const double bytes = 262144.0 + 40.0 * (videoSamples + audioSamples);
  return static_cast<int>(std::min(bytes, 1.0e9));
}

EncoderPlan SelectPreviewPlan() {
  ExportSettings settings;
  settings.codec = "h264";
  settings.resolution = "p720";
  settings.width = 1280;
  settings.height = 720;
  settings.quality = "small";
  return SelectEncoderPlan(settings);
}

void AppendPreviewEncoderArgs(std::vector<std::string>& cmd, const EncoderPlan& plan) {
  if (plan.hardware) {
    if (plan.mode == "videotoolbox") {
      cmd.insert(cmd.end(), {"-c:v", plan.videoEncoder, "-b:v", PreviewBitrate(), "-realtime", "1", "-prio_speed", "1"});
    } else if (plan.mode == "nvenc") {
      cmd.insert(cmd.end(), {"-c:v", plan.videoEncoder, "-preset", "fast", "-b:v", PreviewBitrate()});
    } else if (plan.mode == "qsv") {
      cmd.insert(cmd.end(), {"-c:v", plan.videoEncoder, "-preset", "veryfast", "-b:v", PreviewBitrate()});
    } else if (plan.mode == "amf") {
      cmd.insert(cmd.end(), {"-c:v", plan.videoEncoder, "-quality", "speed", "-b:v", PreviewBitrate()});
    } else {
      cmd.insert(cmd.end(), {"-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p"});
    }
  } else {
    cmd.insert(cmd.end(), {"-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p"});
  }
  /* ALL-INTRA (`-g 1`) LÀ CÓ CHỦ Ý — đừng "tối ưu" nó thành GOP thường. ĐÃ THỬ VÀ HỎNG.
   *
   * Lập luận nghe rất xuôi: `-g 1` khiến mọi khung là khung I, bitrate gần gấp đôi và bộ
   * giải mã phải làm một lượt giải mã nội khung đầy đủ cho từng khung. Đổi sang `-g 30`
   * trên nguồn mẫu giảm 249 khung I xuống 9 và bitrate 3,40 -> 1,81 Mbps. Nghe như thắng.
   *
   * ĐO TRÊN MÁY THẬT (2026-09-06) THÌ NGƯỢC LẠI — khung GIẢI MÃ mỗi giây, proxy 30fps:
   *     -g 1  ->  63 fps   (2,1× nhịp khung tệp)
   *     -g 30 ->  77-87 fps (2,6-2,9×)   ← TỆ HƠN
   * và tỉ lệ rớt khung tăng từ ~20% lên 20-27%, kèm "↑ ĐANG TỆ DẦN".
   *
   * VÌ SAO: Xem trước bản cắt tua 2-4 lần MỖI GIÂY. Chi phí một lệnh tua là số khung phải
   * giải mã lại từ khung I gần nhất:
   *     -g 1  -> 1 khung mỗi lệnh tua      => +2..4 khung/giây
   *     -g 30 -> tối đa 30 khung mỗi lệnh  => +60..120 khung/giây
   * Tiết kiệm được ở phần phát tuần tự không bù nổi phần trả thêm ở mỗi lệnh tua. Với khối
   * lượng tua này, all-intra là lựa chọn ĐÚNG.
   *
   * Bài học chung: bitrate thấp hơn và ít khung I hơn KHÔNG đồng nghĩa giải mã nhẹ hơn khi
   * đường chạy có nhiều lệnh tua. Muốn đổi thì phải đo `Khung giải mã` trên HUD (F9), đừng
   * suy từ dung lượng tệp.
   *
   * `-bf 0`: không B-frame -> thứ tự giải mã trùng thứ tự hiển thị, tua chính xác, độ trễ
   * thấp. Cái này không đánh đổi gì đáng kể. */
  cmd.insert(cmd.end(), {"-g", "1", "-bf", "0", "-c:a", "aac", "-b:a", "128k", "-ac", "2"});
}

std::vector<std::string> BuildPreviewProxyCommand(
  const std::string& input,
  const std::string& output,
  const EncoderPlan& plan
) {
  /* Cùng lý do như ở ExportBatch: proxy đọc chính `temp_input.mp4` — file có thể KHÔNG đồng
   * nhất thuộc tính giữa chừng — và dựng lại đồ hình filter giữa đường làm hỏng cả số khung
   * lẫn nội dung. Với proxy thì hậu quả là mấy khung ĐẦU của cảnh sau mang hình của cảnh
   * TRƯỚC: preview vẽ hình đó bằng transform của block sau -> đúng hiện tượng "giật hình ở
   * điểm chuyển cảnh" người dùng báo 2026-09-09. */
  std::vector<std::string> cmd = {"ffmpeg", "-y", "-hide_banner", "-v", "error", "-nostdin",
                                  "-reinit_filter", "0"};
  const bool useVideoToolboxScale = plan.mode == "videotoolbox" && HasFfmpegFilter("scale_vt");
  if (useVideoToolboxScale) {
    cmd.insert(cmd.end(), {"-init_hw_device", "videotoolbox=vt", "-filter_hw_device", "vt"});
  }
  /* BỀ RỘNG PHẢI CHIA HẾT CHO 16, không chỉ chẵn.
   *
   * `scale=-2` chỉ đảm bảo số CHẴN. Nguồn dọc 1728×3072 vì thế ra proxy rộng 406px —
   * chẵn, nhưng không chia hết cho 4/8/16. Bộ giải mã phần cứng (NVDEC/D3D11/QSV) làm
   * việc theo macroblock 16×16; bề rộng không căn hàng buộc chúng phải thêm bước bù hàng,
   * và ở một số driver là rơi hẳn về giải mã phần mềm.
   *
   * Vì sao nghi chỗ này: đo trên máy người dùng 2026-09-06, proxy 406×720 (0,29 MP) rớt
   * 10-30% khung trong khi bản GỐC 1728×3072 (5,31 MP — nặng gấp 18 lần, và CẢ HAI chiều
   * đều chia hết cho 16) chỉ rớt 0-6%. Bản nhỏ hơn lại tệ hơn hẳn — độ phân giải không
   * giải thích được, căn hàng thì có thể.
   *
   * ⚠️ CHƯA KIỂM CHỨNG ĐƯỢC bằng số liệu: vấn đề chỉ lộ ra ở tầng hợp thành của cửa sổ
   * THẬT, mà môi trường đo tự động (pane ẩn) không dựng được tầng đó — 4 biến thể proxy
   * đều giải mã như nhau ở đó. Đây là bản sửa theo đúng thông lệ, chưa phải theo số đo.
   *
   * ⚠️ NHÁNH VIDEOTOOLBOX (macOS) CỐ Ý GIỮ NGUYÊN `-2`: không có máy macOS để kiểm chứng
   * `scale_vt` có nhận cú pháp `-16` hay không. Sai ở đó thì proxy hỏng hẳn trên Mac, đắt
   * hơn nhiều so với cái được. Ai có máy Mac hãy đổi nốt và ghi lại kết quả đo. */
  cmd.insert(cmd.end(), {
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-vf", useVideoToolboxScale
      ? "format=nv12,hwupload,scale_vt=w=if(gt(ih\\,720)\\,-2\\,iw):h=if(gt(ih\\,720)\\,720\\,ih)"
      : "scale=w=if(gt(ih\\,720)\\,-16\\,iw):h=if(gt(ih\\,720)\\,720\\,ih),setsar=1,format=yuv420p",
    "-sn", "-dn"
  });
  AppendPreviewEncoderArgs(cmd, plan);
  cmd.insert(cmd.end(), {"-movflags", "+faststart", output});
  return cmd;
}

int CommandPreviewProxy(int argc, char** argv) {
  if (argc < 4) {
    Emit("error", "preview-proxy expects input output", 2);
    return 2;
  }
  const std::string input = argv[2];
  const std::string output = argv[3];
  fs::create_directories(fs::path(output).parent_path());
  EncoderPlan plan = SelectPreviewPlan();
  Emit("progress", "Đang tạo proxy preview bằng " + plan.videoEncoder + (plan.hardware ? " (hardware)..." : " (CPU)..."));
  int code = Run(BuildPreviewProxyCommand(input, output, plan));
  if (code != 0 && plan.hardware) {
    Emit("progress", "Encoder phần cứng preview lỗi, chuyển proxy sang CPU...");
    ExportSettings cpuSettings;
    cpuSettings.codec = "h264";
    plan = CpuEncoderPlan(cpuSettings);
    code = Run(BuildPreviewProxyCommand(input, output, plan));
  }
  if (code != 0) {
    Emit("error", "ffmpeg preview proxy failed", code);
    return code;
  }
  Emit("result", "preview proxy complete", 0, output);
  return 0;
}

/* ===== ĐỒ THỊ DỰNG Ở CỠ XUẤT (mục 1.12 pha 2) =====
 *
 * Pha 1 dựng cả đồ thị ở cỡ sequence rồi co ở đuôi (OutputColorFilters): xuất 1080p từ sequence
 * 4K là ghép lane chính, đổi màu, trộn mọi lớp phủ trên khung 4K cho một bản ra chỉ bằng 1/4 số
 * điểm ảnh — rồi thêm một lượt lanczos 4K -> 1080p trên luồng filter. Đo bản cắt 300 s 4K (100
 * phụ đề): xuất 1080p theo pha 1 CHẬM HƠN xuất đúng cỡ 4K (75,7 so với 70,0 s).
 *
 * Nay khi cỡ xuất NHỎ hơn sequence, dựng đồ thị thẳng ở cỡ phần hình (content*): cả cảnh co đều
 * quanh tâm khung theo hệ số s của backend (`output_scale`, exportOutputFrame). Mọi số đo theo
 * ĐIỂM ẢNH SEQUENCE nhân s:
 *   - scale hiệu dụng, qua `fitScale` — nên áp cho cả nhánh keyframe scale (AppendKfTransformFilters
 *     nhân fitScale vào biểu thức);
 *   - vị trí tĩnh, biểu thức vị trí keyframe và độ dời của hoạt ảnh (đơn vị px);
 *   - cỡ chữ drawtext, bề rộng mép mềm (tính trên lớp phủ ĐÃ co).
 * Không đổi: số đo theo điểm ảnh NGUỒN (xoá logo, mặt nạ, bán kính làm mờ — đều đứng trước phép
 * co), hệ số nhân của hoạt ảnh, góc xoay, độ mờ. PNG chữ vẫn bake ở mật độ sequence; chuỗi của lớp
 * phủ co nó (ảnh tĩnh: một lần).
 *
 * fitScale nhân thêm (1 − 2e-6): hệ số in ra 6 chữ số thập phân (FfmpegDouble), và với s = 2/3
 * (1080p -> 720p) "0.666667" làm 1920 điểm ảnh thành 1280,0006 -> ceil(·/2)*2 = 1282, clip vừa
 * khung tràn 2 px. Hụt đi một chút thì mọi tích đáng lẽ là số chẵn tròn ra đúng số đó (ở 7680 px
 * hụt 0,015 px), còn tích không tròn thì ceil cho như cũ.
 * Phóng to (cỡ xuất lớn hơn sequence) giữ cách pha 1.
 *
 * BẬT MẶC ĐỊNH (người dùng chốt 2026-10-02) — tắt bằng CRABBYCUT_EXPORT_OUTSCALE=0. Đo: 4K -> 1080p (bản cắt
 * 300 s, 100 phụ đề) 81,5 -> 67,5 s (−17%); Test.crab 1080p -> 720p 17,0 -> 13,1 s (−23%); Bin Tom
 * 1080×1920 -> 720×1280 25,1 -> 22,7 s (−10%). Bộ so 0.3 trên Test.crab: (b) ĐẠT (mới/cũ 49,9 dB,
 * VMAF 97,6, khung tệ nhất 40,1) nhưng (a) TRƯỢT: so bản chuẩn 45,49 -> 42,86 dB. Bản chuẩn dựng từ
 * CHÍNH đồ thị pha 1 (dựng ở cỡ sequence ở độ chính xác cao rồi co lanczos), nên cách nào lấy mẫu
 * khác thứ tự đều "xa" nó hơn — chỗ lệch nhiều nhất là clip 4K ở 107%: pha 1 co hai lần (0,535 rồi
 * 2/3), pha 2 co một lần (0,357). Co bằng lanczos thay bicubic không thu hẹp (42,39 dB). Người dùng
 * chốt miễn tiêu chí (a) cho mục này vì (b) đạt (xem mục 1.12 của kế hoạch). */
bool OutputScaleEnabled() {
  const char* env = std::getenv("CRABBYCUT_EXPORT_OUTSCALE");
  return !(env && std::string(env) == "0");
}

bool ApplyOutputScaleToPayload(ExportSettings& settings, std::vector<ExportInterval>& intervals,
                               std::vector<ExportOverlay>& overlays) {
  if (!OutputResized(settings) || !OutputScaleEnabled() || settings.width <= 0 || settings.height <= 0) return false;
  const double s = settings.outputScale;
  if (!(s > 0.0 && s < 0.999)) return false;
  // Phần hình phải đúng là khung sequence nhân s (lệch do làm tròn chẵn ≤ 1 px; bị kẹp trần thì
  // không còn là phép co đều -> giữ pha 1).
  if (std::abs(settings.width * s - settings.contentWidth) > 2.0
      || std::abs(settings.height * s - settings.contentHeight) > 2.0) return false;
  std::ostringstream factorText;
  factorText << std::setprecision(12) << s;
  const std::string factor = factorText.str();
  const auto scaledExpr = [&](std::string& expr) {
    if (!expr.empty()) expr = "((" + expr + ")*" + factor + ")";
  };
  const double fitFactor = s * (1.0 - 2e-6);
  for (auto& item : intervals) {
    item.fitScale *= fitFactor;
    item.positionX *= s;
    item.positionY *= s;
    scaledExpr(item.kfXExpr);
    scaledExpr(item.kfYExpr);
    scaledExpr(item.animXExpr);
    scaledExpr(item.animYExpr);
  }
  for (auto& overlay : overlays) {
    overlay.fitScale *= fitFactor;
    overlay.positionX *= s;
    overlay.positionY *= s;
    scaledExpr(overlay.kfXExpr);
    scaledExpr(overlay.kfYExpr);
    scaledExpr(overlay.animXExpr);
    scaledExpr(overlay.animYExpr);
    if (overlay.featherPx > 0) overlay.featherPx = std::max(1, static_cast<int>(std::lround(overlay.featherPx * s)));
    overlay.fontSize = std::max(1, static_cast<int>(std::lround(overlay.fontSize * s)));
  }
  settings.width = settings.contentWidth;
  settings.height = settings.contentHeight;
  settings.builtAtOutputScale = true;
  return true;
}

int CommandExportVideo(int argc, char** argv) {
  if (argc < 8) {
    Emit("error", "export-video expects source output timeline_json_file temp_dir preset fps", 2);
    return 2;
  }
  const std::string source = argv[2];
  const std::string output = argv[3];
  const std::string timelineFile = argv[4];
  const fs::path tempDir = argv[5];
  std::string preset = argv[6];
  std::string fps = argv[7];
  g_exportTiming = ExportTimingLog{};
  g_exportBenchDir.clear();
  if (ExportBenchRequested()) {
    g_exportBenchDir = tempDir / "export_bench";
    std::error_code ec;
    fs::remove_all(g_exportBenchDir, ec);
    fs::create_directories(g_exportBenchDir, ec);
    Emit("progress", "CRABBYCUT_EXPORT_BENCH: ghi dòng lệnh + log ffmpeg vào " + g_exportBenchDir.string());
  }

  std::vector<ExportInterval> intervals;
  std::vector<ExportOverlay> overlays;
  ExportSettings settings;
  std::string payloadError;
  if (!ReadExportPayload(timelineFile, preset, fps, intervals, overlays, settings, payloadError)) {
    Emit("error", payloadError, 4);
    return 4;
  }
  if (ApplyOutputScaleToPayload(settings, intervals, overlays)) {
    Emit("progress", "Dựng đồ thị ở cỡ xuất " + std::to_string(settings.width) + "x" + std::to_string(settings.height)
                     + " (hệ số " + FfmpegDouble(settings.outputScale) + ").");
  }
  g_exportTiming.graphSize = std::to_string(settings.width) + "x" + std::to_string(settings.height);
  /* ĐO TRỤC THỜI GIAN CỦA FILE NGUỒN — MỘT LẦN cho cả lượt export.
   * Xem khối chú thích ở ExportSettings::videoStart: mọi mốc `trim`/`atrim` phải cộng thêm
   * mốc bắt đầu thật của luồng, nếu không mỗi điểm nối lẻ ra một khung của cảnh trước. */
  /* Các lần dò nguồn độc lập nhau chạy SONG SONG: mỗi lần là một tiến trình ffprobe (~120 ms
   * khởi động trên Windows), gọi nối tiếp cả lượt dò mất 1,8 s trên Bin Tom. Chỉ những hàm không
   * có trạng thái chung (CommandOutput dùng biến cục bộ); MediaColorUntagged có cache tĩnh nên
   * chạy ở luồng này, cùng lúc với các lần dò kia. */
  auto videoStartProbe = std::async(std::launch::async, [&source]() { return MediaStreamStartTime(source, "v:0"); });
  auto audioStartProbe = std::async(std::launch::async, [&source]() { return MediaStreamStartTime(source, "a:0"); });
  auto fpsProbe = std::async(std::launch::async, [&source]() { return MediaStreamFps(source); });
  // Seek vào giữa nguồn có an toàn không (seek theo batch + dải nguồn mục 1.1): chỉ đọc header gói.
  auto seekSafeProbe = std::async(std::launch::async, [&source]() {
    return BatchSeekEnabled() ? SourceSeekSafe(source) : false;
  });
  /* ĐỒ THỊ GPU (mục 1.21, xem GpuRenderWanted): dò cùng lúc với các phép dò trên — bản ffmpeg có bộ
   * lọc CUDA của CrabbyCut và chạy được chuỗi CUDA -> NVENC; nguồn chính và từng video lớp phủ có
   * giải mã được bằng NVDEC không. Bản ffmpeg thường (không có crabgeo_cuda) thì không chạy lệnh dò
   * nào. Video lớp phủ: tối đa kGpuOverlayProbes tệp khác nhau, còn lại giải mã CPU rồi tải lên. */
  g_gpuRender = false;
  g_gpuMainNvdec = false;
  g_gpuGraph = false;
  const bool gpuWanted = GpuRenderWanted(settings) && settings.codec != "prores";
  const std::string nvencName = std::string(settings.codec == "hevc" ? "hevc" : "h264") + "_nvenc";
  const auto crabFilters = [gpuWanted]() { return gpuWanted && HasFfmpegFilter("crabgeo_cuda"); };
  const size_t kGpuOverlayProbes = 8;
  std::vector<std::string> overlayVideoPaths;
  for (const auto& overlay : overlays) {
    if (overlay.type != "media" || overlay.assetPath.empty() || OverlayIsImageLike(overlay)
        || OverlayIsImageSequence(overlay)) continue;
    if (std::find(overlayVideoPaths.begin(), overlayVideoPaths.end(), overlay.assetPath) != overlayVideoPaths.end()) continue;
    if (overlayVideoPaths.size() >= kGpuOverlayProbes) break;
    overlayVideoPaths.push_back(overlay.assetPath);
  }
  /* Cả khâu dò GPU trong MỘT luồng song song: cache của lượt trước (GpuProbeResult) trùng khoá thì
   * dùng luôn, không thì dò (NVDEC từng video lớp phủ chạy song song với phép dò nguồn chính) rồi
   * ghi cache. Env CRABBYCUT_EXPORT_GPU_PROBE_CACHE=0: luôn dò. */
  g_gpuLutKnown = -1;
  g_gpuLutBakeDir = tempDir / "gpu_color_luts";   // LUT bake của chuỗi màu tĩnh (BakeColorLut)
  const fs::path gpuCacheFile = tempDir / kGpuProbeCacheName;
  const char* cacheEnv = std::getenv("CRABBYCUT_EXPORT_GPU_PROBE_CACHE");
  const bool gpuCacheOn = !(cacheEnv && std::string(cacheEnv) == "0");
  auto gpuProbe = std::async(std::launch::async, [crabFilters, nvencName, &source, overlayVideoPaths, gpuCacheFile, gpuCacheOn]() {
    GpuProbeResult r;
    r.overlayNvdec.assign(overlayVideoPaths.size(), false);
    if (!crabFilters() || !HasFfmpegEncoder(nvencName)) return r;
    const std::string key = GpuProbeKey(nvencName, source, overlayVideoPaths);
    if (gpuCacheOn && ReadGpuProbeCache(gpuCacheFile, key, overlayVideoPaths.size(), r)) return r;
    std::vector<std::future<bool>> overlayNvdec;
    for (const std::string& path : overlayVideoPaths) {
      overlayNvdec.push_back(std::async(std::launch::async, [path]() { return NvdecDecodes(path); }));
    }
    r.lut = GpuLutAvailable();
    r.main = GpuRenderAvailableWithNvdec(nvencName, source) ? 2 : (GpuRenderAvailable(nvencName) ? 1 : 0);
    for (size_t k = 0; k < overlayNvdec.size(); k++) r.overlayNvdec[k] = overlayNvdec[k].get();
    if (gpuCacheOn) WriteGpuProbeCache(gpuCacheFile, key, r);
    return r;
  });
  settings.sourceColorUntagged = MediaColorUntagged(source);
  settings.videoStart = videoStartProbe.get();
  settings.audioStart = audioStartProbe.get();
  settings.sourceFps = fpsProbe.get();
  if (settings.sourceColorUntagged) {
    Emit("progress", "Nguồn không gắn nhãn màu — đọc theo BT.709 cho khớp preview.");
  }
  // Sau MediaColorUntagged: nguồn HD không nhãn được gán BT.709 nên cũng đi đường nhanh được.
  ProbeMainSourceForFastPath(source, settings);
  for (auto& overlay : overlays) {
    if (overlay.type == "media" && !overlay.assetPath.empty()
        && !OverlayIsImageLike(overlay) && !OverlayIsImageSequence(overlay)) {
      overlay.colorUntagged = MediaColorUntagged(overlay.assetPath);
    }
  }
  if (settings.videoStart > 0.0 || settings.audioStart > 0.0) {
    Emit("progress", "Nguồn lệch mốc thời gian (video +"
                     + FixedSeconds(settings.videoStart) + "s, audio +"
                     + FixedSeconds(settings.audioStart) + "s) — đã bù vào mốc cắt.");
  }
  int nextOverlayInput = 0;
  for (auto& overlay : overlays) {
    if (OverlayNeedsInput(overlay)) overlay.assetInputIndex = nextOverlayInput++;
  }
  EncoderPlan plan = SelectEncoderPlan(settings);
  Emit("progress", "Export encoder: " + plan.videoEncoder + (plan.hardware ? " (hardware)" : " (CPU)"));
  if (std::any_of(overlays.begin(), overlays.end(), [](const ExportOverlay& overlay) { return overlay.type == "text"; })
      && !TextOverlaySupported()) {
    Emit("progress", "FFmpeg hiện tại không có drawtext; text overlay sẽ bị bỏ qua khi export.");
  }
  // Kết quả dò GPU (chạy song song từ đầu lượt, xem gpuProbe). Đồ thị GPU chỉ đi cùng NVENC.
  const GpuProbeResult gpuProbed = gpuProbe.get();
  g_exportTiming.gpuProbeCached = gpuProbed.cached;
  if (gpuProbed.cached) g_gpuLutKnown = gpuProbed.lut ? 1 : 0;
  g_gpuRender = gpuProbed.main > 0 && plan.mode == "nvenc";
  g_gpuMainNvdec = gpuProbed.main == 2 && g_gpuRender;
  for (size_t k = 0; k < overlayVideoPaths.size(); k++) {
    const bool nvdec = gpuProbed.overlayNvdec[k] && g_gpuRender;
    for (auto& overlay : overlays) {
      if (overlay.assetPath == overlayVideoPaths[k]) overlay.gpuNvdec = nvdec;
    }
  }
  if (g_gpuRender) {
    Emit("progress", std::string("Render bằng GPU (bộ lọc CUDA + NVENC") + (g_gpuMainNvdec ? ", giải mã NVDEC" : "")
                     + ") — batch có hiệu ứng chưa có bản GPU vẫn render bằng CPU.");
  } else if (crabFilters()) {
    Emit("progress", "GPU không dùng được cho lượt này — render bằng CPU.");
  }
  // Kết quả dò seek (chạy song song từ đầu lượt, xem seekSafeProbe).
  settings.seekSafe = seekSafeProbe.get();
  if (BatchSeekEnabled()) {
    if (!settings.seekSafe) {
      Emit("progress", "Video nguồn là bản nối nhiều cấu hình mã hoá — không seek theo batch/dải.");
    }
  }
  g_exportTiming.probeMs = MsSince(g_exportTiming.started);

  if (!overlays.empty()) {
    /* DỰ ÁN CÓ LỚP PHỦ — chia theo THỜI GIAN nếu cắt được (xem PlanOverlayBatches).
     * Không chia được thì `batches` có đúng một phần tử và mọi thứ chạy y như bản cũ. */
    const auto planStarted = ExportClock::now();
    /* SONG SONG (mục 1.8, xem ExportParallelWorkers): dự án NGẮN hơn ngưỡng chia batch theo độ
     * dài vẫn được chia thành 2 batch cho mỗi tiến trình (tối thiểu kParallelMinBatchSeconds mỗi
     * batch) để chạy cùng lúc; batch nhiều hơn tiến trình để san tải — lớp phủ thường dồn ở một
     * đoạn (Bin Tom: 15/19 lớp phủ ở 27 s đầu). Dự án dài giữ batch 180 s, chạy song song. */
    const size_t workers = ExportParallelWorkers(settings);
    const double totalSeconds = SequenceDuration(intervals, 0, intervals.size());
    double batchTarget = kOverlayBatchTargetSeconds;
    double batchMinTotal = kOverlayBatchMinTotalSeconds;
    /* Chỉ cắt ở BIÊN CLIP: cắt giữa clip là nửa sau khởi động lại `fps` từ khung nguồn đầu tiên của
     * nó — nguồn khác nhịp bản xuất (30 -> 25) thì chọn khung nguồn lệch pha (Test.crab: khung tệ
     * nhất 13 dB so với bản một lượt). Dự án dài vẫn cắt giữa clip như trước (phim một clip). */
    bool splitInsideClips = true;
    if (workers > 1 && totalSeconds < kOverlayBatchMinTotalSeconds
        && totalSeconds >= 2.0 * kParallelMinBatchSeconds) {
      const double pieces = std::min(2.0 * static_cast<double>(workers), std::floor(totalSeconds / kParallelMinBatchSeconds));
      batchTarget = totalSeconds / pieces;
      batchMinTotal = 0.0;
      splitInsideClips = false;
    }
    const std::vector<OverlayBatch> batches = PlanOverlayBatches(intervals, overlays, settings, batchTarget, batchMinTotal,
                                                                 splitInsideClips);
    g_exportTiming.planMs = MsSince(planStarted);
    if (batches.size() <= 1) {
      int code = ExportBatch(source, output, tempDir, intervals, 0, intervals.size(), 0, 1, settings, plan, overlays);
      if (code != 0) return code;
      EmitExportTiming(plan.videoEncoder);
      Emit("result", "export complete", 0, output);
      return 0;
    }

    fs::path batchDir = tempDir / "export_batches";
    fs::remove_all(batchDir);
    fs::create_directories(batchDir);
    const std::string ext = settings.codec == "prores" ? ".mov" : ".mp4";
    g_exportTiming.workers = workers;
    Emit("progress", "Chia " + std::to_string(batches.size()) + " lượt render theo thời gian"
                     + (workers > 1 ? ", chạy " + std::to_string(workers) + " lượt hình cùng lúc" : std::string())
                     + "...");

    /* Ghi MỌI filter script trước (tuần tự — xem BatchJob), rồi mới chạy. */
    std::vector<BatchJob> jobs(batches.size() + 1);
    std::vector<std::string> batchPaths;
    for (size_t i = 0; i < batches.size(); i++) {
      const OverlayBatch& batch = batches[i];
      const std::vector<ExportOverlay> batchOverlays = OverlaysForBatch(overlays, batch, settings);
      fs::path batchPath = batchDir / ("batch_" + std::to_string(10000 + static_cast<int>(i)).substr(1) + ext);
      if (!PrepareExportBatch(jobs[i], source, batchPath.string(), tempDir, batch.intervals, 0, batch.intervals.size(),
                              i, batches.size(), settings, batchOverlays, FilterScriptMode::VideoOnly)) {
        return 6;
      }
      batchPaths.push_back(batchPath.string());
    }

    /* TIẾNG: ĐÚNG MỘT LƯỢT cho cả phim, trên TOÀN BỘ intervals gốc (không phải bản đã cắt).
     * Xem khối chú thích ở FilterScriptMode — nối tiếng theo batch là mỗi mối ghép dài thêm
     * 23ms và nghe rõ chỗ ngắt. Lớp phủ lọc còn những cái CÓ TIẾNG và đánh số input lại
     * (xem OverlaysForAudioPass): nạp cả ảnh phụ đề vào lượt này là nổ dòng lệnh. */
    /* Đuôi theo CODEC TIẾNG, không phải theo thói quen: ProRes đi kèm `pcm_s16le` (xem
     * AppendEncoderArgsForMode), mà container mp4/m4a không chứa PCM — ffmpeg từ chối ngay
     * ở khâu mux. `.mov` chứa được cả hai. */
    fs::path audioPath = batchDir / (settings.codec == "prores" ? "audio.mov" : "audio.m4a");
    if (!PrepareExportBatch(jobs.back(), source, audioPath.string(), tempDir, intervals, 0, intervals.size(),
                            batches.size(), batches.size() + 1, settings,
                            OverlaysForAudioPass(overlays), FilterScriptMode::AudioOnly)) {
      return 6;
    }
    jobs.back().progressText = "tiếng (một lượt liền mạch cho cả phim)";
    // Lượt tiếng nhẹ (bộ mã hoá AAC một luồng) — chạy kèm, không chiếm chỗ của một lượt hình.
    {
      const int code = RunExportJobs(jobs, plan, workers > 1 ? workers + 1 : 1, settings);
      if (code != 0) return code;
    }

    fs::path concatList = tempDir / "concat_export_batches_native.txt";
    if (!WriteConcatList(concatList, batchPaths)) {
      Emit("error", "cannot write export concat list", 5);
      return 5;
    }
    fs::create_directories(fs::path(output).parent_path());
    Emit("progress", "Đang ghép " + std::to_string(batchPaths.size()) + " lượt hình với tiếng...");
    /* Hình `-c copy` (nối chính xác từng khung), tiếng cũng `-c copy` (đã encode một lượt ở
     * trên). KHÔNG `-shortest`: tiếng thường hết trước hình vài µs (29,97 khung/s, 42 s: tiếng
     * 42,008625 s, hình 42,008633 s) và `-shortest` cắt luôn KHUNG HÌNH CUỐI — bản xuất nhiều batch
     * mất khung cuối phim. Lượt một batch giữ nguyên độ dài cả hai luồng; lượt tiếng riêng nay ra
     * đúng tiếng của lượt đó (đoạn hình giả, xem WriteFilterScript), nên ghép giữ nguyên là trùng.
     * `moov` ở đầu tệp bằng CHỖ DÀNH SẴN (xem MoovReserveBytes) thay cho `+faststart`; ffmpeg báo
     * thiếu chỗ thì ghép lại theo cách cũ. ProRes (.mov, tiếng PCM) giữ `+faststart`. */
    const auto concatStarted = ExportClock::now();
    const auto finalMux = [&](bool reserveMoov) {
      std::vector<std::string> cmd = {
        "ffmpeg", "-y", "-v", "error", "-nostdin",
        "-f", "concat", "-safe", "0", "-i", concatList.string(),
        "-i", audioPath.string(),
        "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
      };
      if (reserveMoov) {
        cmd.insert(cmd.end(), {"-moov_size", std::to_string(MoovReserveBytes(
          SequenceDuration(intervals, 0, intervals.size()), ParseFpsValue(settings.renderFps)))});
      } else {
        cmd.insert(cmd.end(), {"-movflags", "+faststart"});
      }
      cmd.push_back(output);
      return RunIn(cmd, tempDir);
    };
    const bool reserveMoov = settings.codec != "prores";
    int code = finalMux(reserveMoov);
    if (code != 0 && reserveMoov) {
      Emit("progress", "Chỗ dành cho mục lục video không đủ — ghép lại theo cách cũ...");
      code = finalMux(false);
    }
    g_exportTiming.concatMs = MsSince(concatStarted);
    fs::remove(concatList);
    if (code != 0) {
      Emit("error", "ffmpeg final concat failed", code);
      return code;
    }
    /* Dọn các batch trung gian NGAY khi đã ghép xong: chúng to bằng chính bản xuất (dự án
     * phụ đề 4K 39 phút: ~11,5 GB) và trước đây nằm lại trong thư mục tạm tới lượt xuất sau. */
    RemoveExportBatches(batchDir);
    EmitExportTiming(plan.videoEncoder);
    Emit("result", "export complete", 0, output);
    return 0;
  }

  const size_t batchSize = 80;
  const size_t batchCount = (intervals.size() + batchSize - 1) / batchSize;
  fs::path batchDir = tempDir / "export_batches";
  fs::remove_all(batchDir);
  fs::create_directories(batchDir);

  if (batchCount <= 1) {
    int code = ExportBatch(source, output, tempDir, intervals, 0, intervals.size(), 0, 1, settings, plan, overlays);
    if (code != 0) return code;
    EmitExportTiming(plan.videoEncoder);
    Emit("result", "export complete", 0, output);
    return 0;
  }

  std::vector<std::string> batchPaths;
  const std::string ext = settings.codec == "prores" ? ".mov" : ".mp4";
  for (size_t batch = 0; batch < batchCount; batch++) {
    const size_t offset = batch * batchSize;
    const size_t count = std::min(batchSize, intervals.size() - offset);
    fs::path batchPath = batchDir / ("batch_" + std::to_string(10000 + static_cast<int>(batch)).substr(1) + ext);
    int code = ExportBatch(source, batchPath.string(), tempDir, intervals, offset, count, batch, batchCount, settings, plan, overlays);
    if (code != 0) return code;
    batchPaths.push_back(batchPath.string());
  }

  fs::path concatList = tempDir / "concat_export_batches_native.txt";
  if (!WriteConcatList(concatList, batchPaths)) {
    Emit("error", "cannot write export concat list", 5);
    return 5;
  }
  fs::create_directories(fs::path(output).parent_path());
  const auto concatStarted = ExportClock::now();
  int code = Run({"ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concatList.string(), "-c", "copy", output});
  g_exportTiming.concatMs = MsSince(concatStarted);
  fs::remove(concatList);
  if (code != 0) {
    Emit("error", "ffmpeg final concat failed", code);
    return code;
  }
  RemoveExportBatches(batchDir);   // xem chỗ gọi ở nhánh có lớp phủ
  EmitExportTiming(plan.videoEncoder);
  Emit("result", "export complete", 0, output);
  return 0;
}

int CommandWhisperCpp(int argc, char** argv) {
  if (argc < 5) {
    Emit("error", "transcribe-whispercpp expects audio_wav model_path output_json", 2);
    return 2;
  }
  const char* binEnv = std::getenv("WHISPER_CPP_BIN");
  if (!binEnv || std::string(binEnv).empty()) {
    Emit("error", "WHISPER_CPP_BIN is not set; cannot run Windows whisper.cpp sidecar", 20);
    return 20;
  }
  const std::string audio = argv[2];
  const std::string model = argv[3];
  const std::string outputJson = argv[4];
  fs::path outputBase = fs::path(outputJson);
  outputBase.replace_extension("");
  int code = Run({binEnv, "-m", model, "-f", audio, "-l", "vi", "-oj", "-of", outputBase.string()});
  if (code != 0) {
    Emit("error", "whisper.cpp failed", code);
    return code;
  }
  Emit("result", "whisper.cpp complete", 0, outputJson);
  return 0;
}

void PrintUsage() {
  std::cout
    << "core_process commands:\n"
    << "  concat <output> <input...>\n"
    << "  thumbnail <input> <output> <seek_seconds>\n"
    << "  audio-peaks <input> <output.pk>\n"
    << "  preprocess-audio <input> <output> <mode>\n"
    << "  preview-proxy <input> <output>\n"
    << "  export-video <source> <output> <timeline_json_file> <temp_dir> <preset> <fps>\n"
    << "  transcribe-whispercpp <audio_wav> <model_path> <output_json>\n";
}

#ifdef _WIN32
/* ĐƯỜNG DẪN CÓ DẤU — VÌ SAO KHÔNG ĐƯỢC DÙNG `argv` CỦA WINDOWS.
 *
 * Windows dựng `argv` của main() bằng cách chuyển dòng lệnh UTF-16 sang trang mã ANSI của
 * máy (GetACP()). Ký tự nào trang mã đó KHÔNG có thì CRT thay bằng dấu `?`. Máy Việt Nam
 * thường chạy ACP 1252: tên người dùng "Hòa Nguyễn" đi qua argv thành "Hòa Nguy?n" — mà `?`
 * là ký tự CẤM trong tên tệp Windows, nên thao tác đầu tiên chạm tới đường dẫn đó chết với
 * lỗi 123 ERROR_INVALID_NAME:
 *     create_directories: The filename, directory name, or volume label syntax is incorrect.:
 *     "C:\Users\Hòa Nguy?n\AppData\Local\CrabbyCut\temp_uploads"
 * Backend Node truyền đường dẫn HOÀN TOÀN ĐÚNG (spawn đi thẳng vào CreateProcessW dạng
 * UTF-16); chỗ mất chữ nằm ở phía nhận này. Máy có tên người dùng thuần ASCII không bao giờ
 * thấy lỗi — nên lỗi chỉ lộ ra khi cài sang máy khác.
 *
 * Lấy lại dòng lệnh GỐC dạng UTF-16 rồi tự chuyển sang UTF-8: không mất ký tự nào, và phần
 * còn lại của tệp vẫn làm việc với std::string như cũ. Đây đúng là cách ffmpeg tự xử lý
 * (fftools/cmdutils.c: prepare_app_arguments), nên đường dẫn ta đưa sang ffmpeg khớp luôn.
 *
 * ĐI KÈM BẮT BUỘC — setlocale(LC_CTYPE, ".UTF8") ở đầu main(): std::filesystem quy đổi
 * std::string <-> đường dẫn thật bằng trang mã của LC_CTYPE (MSVC: __std_fs_code_page).
 * Để nguyên trang mã ANSI thì chuỗi UTF-8 vừa dựng lại bị hiểu sai một lần nữa —
 * "Hòa" thành "HÃ²a" — và ta chỉ đổi một lỗi khó hiểu này lấy một lỗi khó hiểu khác.
 * KHÔNG dùng LC_ALL: nó kéo theo LC_NUMERIC của máy, và ở locale dùng dấu phẩy thập phân
 * thì mọi tham số số ta ghi vào filter ffmpeg ("scale=1920:1080", "1.5") sẽ ra dấu phẩy. */
std::string Utf8FromWide(const wchar_t* text) {
  if (!text || !*text) return std::string();
  const int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return std::string();
  std::string out(static_cast<size_t>(size - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), size, nullptr, nullptr);
  return out;
}
#endif

}  // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
  std::setlocale(LC_CTYPE, ".UTF8");
  /* Phải sống tới hết main(): argv trỏ thẳng vào bộ đệm của hai vector này. */
  std::vector<std::string> utf8Args;
  std::vector<char*> utf8Argv;
  int wideCount = 0;
  wchar_t** wideArgv = CommandLineToArgvW(GetCommandLineW(), &wideCount);
  if (wideArgv) {
    utf8Args.reserve(static_cast<size_t>(wideCount));
    for (int i = 0; i < wideCount; i++) utf8Args.push_back(Utf8FromWide(wideArgv[i]));
    LocalFree(wideArgv);
    utf8Argv.reserve(utf8Args.size() + 1);
    for (std::string& arg : utf8Args) utf8Argv.push_back(arg.data());
    utf8Argv.push_back(nullptr);
    argc = wideCount;
    argv = utf8Argv.data();
  }
  /* wideArgv == nullptr (hết bộ nhớ) thì rơi về argv của CRT: đường dẫn có dấu vẫn hỏng
   * như trước, nhưng đó là hỏng CŨ, không phải hỏng thêm. */
#endif
  if (argc < 2) {
    PrintUsage();
    return 1;
  }
  const std::string command = argv[1];
  try {
    if (command == "concat") return CommandConcat(argc, argv);
    if (command == "thumbnail") return CommandThumbnail(argc, argv);
    if (command == "audio-peaks") return CommandAudioPeaks(argc, argv);
    if (command == "preprocess-audio") return CommandPreprocessAudio(argc, argv);
    if (command == "preview-proxy") return CommandPreviewProxy(argc, argv);
    if (command == "export-video") return CommandExportVideo(argc, argv);
    if (command == "transcribe-whispercpp") return CommandWhisperCpp(argc, argv);
    if (command == "--help" || command == "help") {
      PrintUsage();
      return 0;
    }
    Emit("error", "unknown command: " + command, 1);
    return 1;
  } catch (const std::exception& e) {
    Emit("error", e.what(), 99);
    return 99;
  }
}
