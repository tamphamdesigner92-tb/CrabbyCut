// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

#include <cstdlib>
#include <algorithm>
#include <clocale>
#include <cstdint>
#include <cstdio>
#include <cmath>
#include <cstring>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <regex>
#include <sstream>
#include <string>
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

int RunIn(const std::vector<std::string>& args, const fs::path& workingDir) {
  const std::string line = CommandLine(args);
#ifdef _WIN32
  if (line.size() <= kWindowsCommandLineLimit) {
    std::wstring wide = WidenForProcess(line);
    if (!wide.empty()) {
      // CreateProcessW ĐƯỢC PHÉP sửa tại chỗ bộ đệm dòng lệnh -> phải là bộ đệm ghi được.
      std::vector<wchar_t> buffer(wide.begin(), wide.end());
      buffer.push_back(L'\0');
      const std::wstring wideDir = workingDir.empty() ? std::wstring() : WidenForProcess(workingDir.string());
      STARTUPINFOW si;
      ZeroMemory(&si, sizeof(si));
      si.cb = sizeof(si);
      PROCESS_INFORMATION pi;
      ZeroMemory(&pi, sizeof(pi));
      if (CreateProcessW(nullptr, buffer.data(), nullptr, nullptr, TRUE, 0, nullptr,
                         wideDir.empty() ? nullptr : wideDir.c_str(), &si, &pi)) {
        WaitForSingleObject(pi.hProcess, INFINITE);
        DWORD exitCode = 1;
        GetExitCodeProcess(pi.hProcess, &exitCode);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        return static_cast<int>(exitCode);
      }
    }
  } else {
    /* Vượt cả trần của CreateProcess. Nói THẲNG ra nguyên nhân: rơi về std::system() ở đây
     * chỉ đổi một thông báo khó hiểu này lấy một thông báo khó hiểu khác. */
    Emit("error", "Dòng lệnh ffmpeg dài " + std::to_string(line.size())
                  + " ký tự, vượt trần " + std::to_string(kWindowsCommandLineLimit)
                  + " của Windows. Dự án có quá nhiều lớp phủ (phụ đề/ảnh) cho một lượt render.", 7);
    return 7;
  }
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
  std::string adjustLutAPath;
  std::string adjustLutBPath;
  std::string adjustLutMixExpr;
};

struct ExportSettings {
  std::string resolution = "source";
  int width = 0;
  int height = 0;
  std::string fps = "source";
  std::string renderFps = "30";
  std::string codec = "h264";
  std::string quality = "high";
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
};

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

std::string BitrateForHardware(const ExportSettings& settings) {
  const int width = settings.width > 0 ? settings.width : 1920;
  const int height = settings.height > 0 ? settings.height : 1080;
  const double pixels = static_cast<double>(std::max(1, width * height));
  const double scale = pixels / (1920.0 * 1080.0);
  int baseKbps = 9000;
  if (settings.codec == "hevc") {
    baseKbps = settings.quality == "small" ? 4500 : (settings.quality == "balanced" ? 7000 : 11000);
  } else {
    baseKbps = settings.quality == "small" ? 5500 : (settings.quality == "balanced" ? 8500 : 13000);
  }
  const int kbps = ClampInt(static_cast<int>(std::round(baseKbps * scale)), 2500, 80000);
  return std::to_string(kbps) + "k";
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
  if (!IsAllowed(settings.audioBitrate, {"128k", "192k", "320k"})) settings.audioBitrate = "192k";

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
    item.adjEqContrastExpr = ExtractJsonStringField(objects[i], "adj_eq_contrast_expr", "");
    item.adjEqBrightnessExpr = ExtractJsonStringField(objects[i], "adj_eq_brightness_expr", "");
    item.adjEqSaturationExpr = ExtractJsonStringField(objects[i], "adj_eq_saturation_expr", "");
    item.adjustFiltersPost = ExtractJsonStringField(objects[i], "adj_filters_post", "");
    item.adjustLayerFilters = ExtractJsonStringField(objects[i], "adj_layer_filters", "");
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
      overlay.adjEqContrastExpr = ExtractJsonStringField(overlayObjects[i], "adj_eq_contrast_expr", "");
      overlay.adjEqBrightnessExpr = ExtractJsonStringField(overlayObjects[i], "adj_eq_brightness_expr", "");
      overlay.adjEqSaturationExpr = ExtractJsonStringField(overlayObjects[i], "adj_eq_saturation_expr", "");
      overlay.adjustFiltersPost = ExtractJsonStringField(overlayObjects[i], "adj_filters_post", "");
      overlay.adjustLayerFilters = ExtractJsonStringField(overlayObjects[i], "adj_layer_filters", "");
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
  return "scale=out_color_matrix=bt709:out_range=tv," + ClipPixelFormat(settings)
    + ",setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";
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
    // opacity biến thiên: geq nhân alpha sẵn có (0..1 * alpha gốc). geq dùng biến thời gian T.
    const std::string op = SubstituteLocalTimeVar(kfOpacityExpr, start, "T");
    script << ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip((" << op << ")/100,0,1)*alpha(X,Y)'";
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
std::string ColorAdjustLutBlend(double start, const std::string& aPath, const std::string& bPath,
                                const std::string& mixExpr, const std::string& tag) {
  if (aPath.empty() || bPath.empty() || mixExpr.empty()) return "";
  const std::string mix = "(" + SubstituteLocalTimeVar(mixExpr, start, "T") + ")";
  std::ostringstream out;
  out << "split[" << tag << "la][" << tag << "lb];\n";
  out << "[" << tag << "la]lut3d=file='" << FilterPath(aPath) << "':interp=trilinear[" << tag << "la2];\n";
  out << "[" << tag << "lb]lut3d=file='" << FilterPath(bPath) << "':interp=trilinear[" << tag << "lb2];\n";
  out << "[" << tag << "la2][" << tag << "lb2]blend=all_expr='A*(1-" << mix << ")+B*" << mix
      << "'[" << tag << "lm];\n";
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
  const std::string staticSubbed = SubstituteLocalTime(staticFilters, start);
  const std::string postSubbed = SubstituteLocalTime(postFilters, start);
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

void AppendColorAdjustFilters(std::ofstream& script, const std::string& filters,
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

  script << "color=c=black:s=" << seqW << "x" << seqH
         << ":d=" << FixedSeconds(baseDuration)
         << ":r=" << settings.renderFps << "[base" << idx << "];\n";

  // KEYFRAME clip lane chính (0-based -> start=0). Có keyframe -> scale/rotate/opacity
  // biến thiên theo thời gian (AppendKfTransformFilters) thay cho tĩnh; vị trí lấy theo kf.
  const bool clipKf = HasKeyframeExpr(item.kfScaleExpr, item.kfRotExpr, item.kfOpacityExpr,
                                      item.kfXExpr, item.kfYExpr);
  // Hoạt ảnh có thu phóng/xoay cũng cần chính nhánh đó -> gộp thành MỘT cờ, dùng cho cả
  // việc bỏ bước scale tĩnh phía trước format=rgba (nếu không thì scale HAI lần).
  const bool clipDynTransform = clipKf
    || HasAnimGeomExpr(item.animSxExpr, item.animSyExpr, item.animRotExpr);

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
  script << "[0:v]trim=start=" << FixedSeconds(trimStart) << ":end=" << FixedSeconds(trimEnd)
         << ",setpts=PTS-STARTPTS";
  // TỐC ĐỘ: nén/dãn trục thời gian TRƯỚC bước `fps=` — sau `fps=` thì khung đã bị
  // resample về lưới renderFps rồi, đổi PTS lúc đó là lặp/bỏ khung không đều.
  if (std::abs(item.speedRate - 1.0) >= 1e-4) {
    script << ",setpts=PTS/" << FormatFilterNumber(item.speedRate);
  }
  script
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
    script << ",trim=end_frame=" << item.renderFrames;
  }
  // Clip lane chính đã setpts 0-based -> LOCALT trừ mốc 0.
  AppendColorAdjustFilters(script,
                           ColorAdjustChain(0.0, item.adjustFilters, item.adjEqContrastExpr,
                                            item.adjEqBrightnessExpr, item.adjEqSaturationExpr,
                                            item.adjustFiltersPost, item.adjustLutAPath,
                                            item.adjustLutBPath, item.adjustLutMixExpr,
                                            "adjc" + idx + "_"),
                           item.adjustMaskPath, "adjc" + idx + "_");
  // Lớp Điều chỉnh: gọi LẦN HAI với mặt nạ RỖNG. Nhờ vậy nó nối vào chuỗi hiện tại
  // (sau nhánh mặt nạ đã đóng ở lời gọi trên), đúng như preview áp lượt 2 lên TOÀN khung.
  AppendColorAdjustFilters(script, SubstituteLocalTime(item.adjustLayerFilters, 0.0), "", "");
  AppendVideoMaskFilter(script, item.videoMaskPath, "vmc" + idx + "_");
  if (!clipDynTransform) {
    script << ",scale=max(2\\,ceil(iw*" << FfmpegDouble(scaleValue) << "/2)*2)"
           << ":max(2\\,ceil(ih*" << FfmpegDouble(scaleValue) << "/2)*2)";
  }
  script << ",format=rgba";
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

bool HasAnyExpr(std::initializer_list<const std::string*> exprs) {
  for (const auto* expr : exprs) {
    if (expr && !expr->empty()) return true;
  }
  return false;
}

// Clip có thuộc tính biến thiên theo thời gian -> KHÔNG được cắt đôi.
bool IntervalIsTimeVarying(const ExportInterval& item) {
  /* Chuỗi màu chứa token LOCALT = có biểu thức theo thời gian bên trong: lớp Điều chỉnh
   * phủ MỘT PHẦN block (`enable='between(LOCALT,..)'`), "Viền mờ dần" có keyframe… Cắt đôi
   * block như vậy là nửa sau chạy lại từ t=0 và cửa sổ thời gian rơi sai chỗ. */
  const auto hasLocalT = [](const std::string& s) { return s.find("LOCALT") != std::string::npos; };
  if (hasLocalT(item.adjustLayerFilters) || hasLocalT(item.adjustFilters)
      || hasLocalT(item.adjustFiltersPost)) {
    return true;
  }
  return HasAnyExpr({&item.animXExpr, &item.animYExpr, &item.animSxExpr, &item.animSyExpr,
                     &item.animRotExpr, &item.kfXExpr, &item.kfYExpr, &item.kfScaleExpr,
                     &item.kfRotExpr, &item.kfOpacityExpr, &item.kfVolumeExpr,
                     &item.adjEqContrastExpr, &item.adjEqBrightnessExpr, &item.adjEqSaturationExpr,
                     &item.adjustLutMixExpr});
}

/* Lớp phủ có thuộc tính biến thiên theo thời gian -> không được cắt qua nó.
 * Chuỗi khung hoạt ảnh (`image_sequence`) cũng tính là biến thiên: nội dung nó ĐỔI theo
 * khung, xén đầu là lệch pha cả chuỗi. */
bool OverlayIsTimeVarying(const ExportOverlay& overlay) {
  if (OverlayIsImageSequence(overlay)) return true;
  if (!OverlayIsImageLike(overlay)) return true;      // video/audio: có trục thời gian riêng
  if (overlay.animInDur > 0.001 || overlay.animOutDur > 0.001) return true;
  if (!overlay.adjustLayerFilters.empty()) return true;
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
  const ExportSettings& settings
) {
  std::vector<OverlayBatch> batches;
  const double fps = ParseFpsValue(settings.renderFps);
  const double total = SequenceDuration(intervals, 0, intervals.size());
  OverlayBatch single;
  single.intervals = intervals;
  single.sequenceStart = 0.0;
  single.sequenceDuration = total;
  if (!(fps > 0.0) || total < kOverlayBatchMinTotalSeconds) return {single};

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
    if (OverlayIsTimeVarying(overlay)) blocking.push_back(&overlay);
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
    while (!IntervalIsTimeVarying(item) && item.renderFrames > 1) {
      const double want = batchStart + kOverlayBatchTargetSeconds;
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
    if (cursor - batchStart >= kOverlayBatchTargetSeconds && safeToCutAt(cursor)
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
    if (!OverlayTouchesWindow(source, from, to, fps)) continue;
    ExportOverlay overlay = source;
    const double start = overlay.timelineStart - from;
    const double end = start + std::max(0.05, overlay.duration);
    const double clippedStart = std::max(0.0, start);
    const double clippedEnd = std::min(batch.sequenceDuration, end);
    if (clippedEnd - clippedStart < 1e-6) continue;
    overlay.timelineStart = clippedStart;
    overlay.duration = clippedEnd - clippedStart;
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
 * ------------------------------------------------------------------------- */
void AppendFeatherAlpha(std::ofstream& script, int featherPx) {
  if (featherPx <= 0) return;
  const std::string f = std::to_string(featherPx);
  // Dấu nháy đơn đã bảo vệ dấu phẩy bên trong biểu thức — cùng quy ước với geq của
  // nhánh keyframe opacity ngay phía trên, đừng escape thêm.
  script << ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'"
         << ":a='alpha(X,Y)*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/" << f << ")'";
}

void WriteVisualOverlayFilter(
  std::ofstream& script,
  const ExportOverlay& overlay,
  const std::string& inputLabel,
  const std::string& outputLabel,
  const ExportSettings& settings
) {
  // VIDEO overlay có hoạt ảnh: opacity qua fade, dịch chuyển qua overlay x/y theo t,
  // thu phóng/xoay qua nhánh AppendKfTransformFilters (khi hiệu ứng có dùng hai kênh đó).
  const bool hasVideoAnim = !overlay.animXExpr.empty();
  const int inputIndex = 1 + overlay.assetInputIndex;
  const int seqW = settings.width > 0 ? settings.width : 1920;
  const int seqH = settings.height > 0 ? settings.height : 1080;
  const double scaleValue = std::max(0.01, overlay.scale / 100.0);
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

  script << "[" << inputIndex << ":v]";
  if (OverlayIsImageSequence(overlay)) {
    // Sequence hữu hạn đã đúng độ dài cửa sổ hoạt ảnh — không trim;
    // sau frame cuối overlay tự biến mất nhờ eof_action=pass
  } else if (!OverlayIsImageLike(overlay)) {
    // Độ dài NGUỒN = độ dài timeline × tốc độ (xem WriteOverlayAudioFilter).
    const double videoSourceSpan = overlay.duration * (overlay.speedRate > 0.0 ? overlay.speedRate : 1.0);
    script << "trim=start=" << FixedSeconds(overlay.sourceStart) << ":duration=" << FixedSeconds(videoSourceSpan) << ",";
  } else {
    script << "trim=duration=" << FixedSeconds(overlay.duration) << ",";
  }
  // KEYFRAME overlay (start tuyệt đối -> LOCALT = t-start). Có keyframe -> scale/rotate/
  // opacity biến thiên theo thời gian; vị trí lấy theo kf (cộng thêm offset hoạt ảnh nếu có).
  const bool overlayKf = HasKeyframeExpr(overlay.kfScaleExpr, overlay.kfRotExpr, overlay.kfOpacityExpr,
                                         overlay.kfXExpr, overlay.kfYExpr);
  // Hoạt ảnh có thu phóng/xoay dùng CHUNG nhánh biến đổi theo thời gian với keyframe
  // (xem WriteClipVideoFilters — cùng lý do, cùng cách gộp cờ).
  const bool overlayDynTransform = overlayKf
    || HasAnimGeomExpr(overlay.animSxExpr, overlay.animSyExpr, overlay.animRotExpr);

  // Nén/dãn trục thời gian TRƯỚC khi dời về mốc tuyệt đối trên sequence: chia cả biểu
  // thức đã cộng `start` thì mốc bắt đầu của overlay cũng bị chia theo và lớp lệch chỗ.
  if (std::abs(overlay.speedRate - 1.0) >= 1e-4 && !OverlayIsImageSequence(overlay)) {
    script << "setpts=(PTS-STARTPTS)/" << FormatFilterNumber(overlay.speedRate)
           << "+" << FfmpegDouble(start) << "/TB";
  } else {
    script << "setpts=PTS-STARTPTS+" << FfmpegDouble(start) << "/TB";
  }
  // Overlay giữ mốc tuyệt đối sau setpts -> LOCALT trừ timeline_start.
  AppendColorAdjustFilters(script,
                           ColorAdjustChain(start, overlay.adjustFilters, overlay.adjEqContrastExpr,
                                            overlay.adjEqBrightnessExpr, overlay.adjEqSaturationExpr,
                                            overlay.adjustFiltersPost, overlay.adjustLutAPath,
                                            overlay.adjustLutBPath, overlay.adjustLutMixExpr,
                                            "adjo" + id + "_"),
                           overlay.adjustMaskPath, "adjo" + id + "_");
  // Lớp Điều chỉnh — xem ghi chú ở WriteClipVideoFilters.
  AppendColorAdjustFilters(script, SubstituteLocalTime(overlay.adjustLayerFilters, start), "", "");
  AppendVideoMaskFilter(script, overlay.videoMaskPath, "vmo" + id + "_");
  if (!overlayDynTransform) {
    script << ",scale=max(2\\,ceil(iw*" << FfmpegDouble(scaleValue) << "/2)*2)"
           << ":max(2\\,ceil(ih*" << FfmpegDouble(scaleValue) << "/2)*2)";
  }
  script << ",format=rgba";
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
                             overlay.animSxExpr, overlay.animSyExpr, overlay.animRotExpr);
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
  script << "[ov" << id << "];\n";

  script << inputLabel << "[ov" << id << "]overlay=";
  if (overlayKf || hasVideoAnim) {
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
         // Sequence hoạt ảnh: GIỮ frame cuối sau EOF (repeat) — nếu pass, text sẽ
         // biến mất đúng 1 frame tại ranh giới sequence->hold gây "nháy"; enable
         // window vẫn gate hiển thị đúng đoạn nên repeat không làm dư hình
         << ":eof_action=" << (OverlayIsImageSequence(overlay) ? "repeat" : "pass")
         << ":format=auto" << outputLabel << ";\n";
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
  const std::string crf = settings.quality == "small" ? "28" : (settings.quality == "balanced" ? "23" : "18");
  const std::string preset = QualityPreset(settings);
  if (settings.codec == "hevc") {
    cmd.insert(cmd.end(), {"-c:v", "libx265", "-preset", preset, "-crf", crf, "-tag:v", "hvc1"});
  } else {
    cmd.insert(cmd.end(), {"-c:v", "libx264", "-preset", preset, "-crf", crf});
  }
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
    cmd.insert(cmd.end(), {"-c:v", plan.videoEncoder, "-preset", "fast", "-b:v", bitrate});
  } else if (plan.mode == "qsv") {
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
  const double renderFpsValue = ParseFpsValue(settings.renderFps);
  for (size_t i = 0; i < count; i++) {
    const auto& item = intervals[offset + i];
    if (wantVideo) WriteClipVideoFilters(script, item, i, settings);
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
    if (wantAudio) script << "[a" << i << "]";
  }
  const std::string concatSpec = std::string("concat=n=") + std::to_string(count)
    + ":v=" + (wantVideo ? "1" : "0") + ":a=" + (wantAudio ? "1" : "0");
  if (overlays.empty()) {
    if (wantVideo) {
      script << concatSpec << "[vcat]" << (wantAudio ? "[a]" : "") << ";\n";
      script << "[vcat]" << OutputColorFilters(settings) << "[v]\n";
    } else {
      script << concatSpec << (wantAudio ? "[a]" : "") << "\n";
    }
    return true;
  }

  script << concatSpec << (wantVideo ? "[mainv]" : "") << (wantAudio ? "[maina]" : "") << ";\n";

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
    } else {
      WriteVisualOverlayFilter(script, overlay, currentVideo, outputLabel, settings);
    }
    currentVideo = outputLabel;
  }
  if (wantVideo) script << currentVideo << "setsar=1," << OutputColorFilters(settings) << "[v];\n";
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

void AppendOverlayInputArgs(
  std::vector<std::string>& cmd,
  const std::vector<ExportOverlay>& overlays,
  double sequenceDuration,
  const fs::path& baseDir
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
    } else if (OverlayIsImageLike(overlay)) {
      cmd.insert(cmd.end(), {
        "-loop", "1",
        "-t", FixedSeconds(std::max(0.05, sequenceDuration)),
        "-i", assetPath
      });
    } else {
      cmd.insert(cmd.end(), {"-i", assetPath});
    }
  }
}

/* Map luồng theo chế độ. `-vn`/`-an` là BẮT BUỘC chứ không thừa: ở chế độ VideoOnly
 * filtergraph không có nhãn [a] nào, mà ffmpeg vẫn TỰ NHẶT rãnh tiếng của input 0 nếu không
 * cấm — bản xuất ra có tiếng CHƯA qua bộ lọc (sai âm lượng, chưa khử ồn, thiếu tiếng của
 * lớp phủ). Hỏng kiểu đó phải nghe mới biết, nhìn không thấy. */
void AppendStreamMapArgs(std::vector<std::string>& cmd, const fs::path& scriptPath, FilterScriptMode mode) {
  cmd.insert(cmd.end(), {"-filter_complex_script", scriptPath.string()});
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
  fs::create_directories(fs::path(output).parent_path());
  fs::path scriptPath = tempDir / ("export_filter_batch_" + std::to_string(batchIndex) + ".txt");
  if (!WriteFilterScript(scriptPath, intervals, offset, count, settings, overlays, mode)) {
    Emit("error", "cannot write ffmpeg filter script", 6);
    return 6;
  }

  Emit("progress", "Đang render batch " + std::to_string(batchIndex + 1) + "/" + std::to_string(batchCount)
                   + " (" + std::to_string(count) + " đoạn)...");
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
  const std::vector<std::string> baseCmd = {
    "ffmpeg", "-y", "-hide_banner", "-v", "error", "-nostdin",
    "-reinit_filter", "0",   // PHẢI đứng TRƯỚC -i: đây là tuỳ chọn của INPUT
    "-i", source
  };
  std::vector<std::string> cmd = baseCmd;
  AppendOverlayInputArgs(cmd, overlays, SequenceDuration(intervals, offset, count), tempDir);
  AppendStreamMapArgs(cmd, scriptPath, mode);
  AppendEncoderArgsForMode(cmd, settings, plan, mode);
  cmd.insert(cmd.end(), {"-movflags", "+faststart", output});
  /* CHẠY VỚI THƯ MỤC LÀM VIỆC = tempDir. Đây là thứ làm cho đường dẫn tương đối ở
     AppendOverlayInputArgs trỏ đúng tệp. `source`, `output` và tệp kịch bản filter vẫn
     tuyệt đối nên không phụ thuộc vào cwd; đường dẫn NẰM TRONG kịch bản filter (LUT, mặt nạ)
     cũng tuyệt đối — xem FilterPath. */
  int code = RunIn(cmd, tempDir);
  if (code != 0 && plan.hardware) {
    Emit("progress", "Encoder phần cứng " + plan.videoEncoder + " lỗi, chuyển batch export sang CPU...");
    plan = CpuEncoderPlan(settings);
    cmd = baseCmd;
    AppendOverlayInputArgs(cmd, overlays, SequenceDuration(intervals, offset, count), tempDir);
    AppendStreamMapArgs(cmd, scriptPath, mode);
    AppendEncoderArgsForMode(cmd, settings, plan, mode);
    cmd.insert(cmd.end(), {"-movflags", "+faststart", output});
    code = RunIn(cmd, tempDir);
  }
  if (code != 0) {
    Emit("error", "ffmpeg batch export failed", code);
    return code;
  }
  fs::remove(scriptPath);
  return 0;
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

  std::vector<ExportInterval> intervals;
  std::vector<ExportOverlay> overlays;
  ExportSettings settings;
  std::string payloadError;
  if (!ReadExportPayload(timelineFile, preset, fps, intervals, overlays, settings, payloadError)) {
    Emit("error", payloadError, 4);
    return 4;
  }
  /* ĐO TRỤC THỜI GIAN CỦA FILE NGUỒN — MỘT LẦN cho cả lượt export.
   * Xem khối chú thích ở ExportSettings::videoStart: mọi mốc `trim`/`atrim` phải cộng thêm
   * mốc bắt đầu thật của luồng, nếu không mỗi điểm nối lẻ ra một khung của cảnh trước. */
  settings.videoStart = MediaStreamStartTime(source, "v:0");
  settings.audioStart = MediaStreamStartTime(source, "a:0");
  settings.sourceFps = MediaStreamFps(source);
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

  if (!overlays.empty()) {
    /* DỰ ÁN CÓ LỚP PHỦ — chia theo THỜI GIAN nếu cắt được (xem PlanOverlayBatches).
     * Không chia được thì `batches` có đúng một phần tử và mọi thứ chạy y như bản cũ. */
    const std::vector<OverlayBatch> batches = PlanOverlayBatches(intervals, overlays, settings);
    if (batches.size() <= 1) {
      int code = ExportBatch(source, output, tempDir, intervals, 0, intervals.size(), 0, 1, settings, plan, overlays);
      if (code != 0) return code;
      Emit("result", "export complete", 0, output);
      return 0;
    }

    fs::path batchDir = tempDir / "export_batches";
    fs::remove_all(batchDir);
    fs::create_directories(batchDir);
    const std::string ext = settings.codec == "prores" ? ".mov" : ".mp4";
    Emit("progress", "Chia " + std::to_string(batches.size()) + " lượt render theo thời gian "
                     + "(giữ chuỗi lớp phủ ngắn để render không chậm dần theo độ dài phim)...");

    std::vector<std::string> batchPaths;
    for (size_t i = 0; i < batches.size(); i++) {
      const OverlayBatch& batch = batches[i];
      const std::vector<ExportOverlay> batchOverlays = OverlaysForBatch(overlays, batch, settings);
      fs::path batchPath = batchDir / ("batch_" + std::to_string(10000 + static_cast<int>(i)).substr(1) + ext);
      int code = ExportBatch(source, batchPath.string(), tempDir, batch.intervals, 0, batch.intervals.size(),
                             i, batches.size(), settings, plan, batchOverlays, FilterScriptMode::VideoOnly);
      if (code != 0) return code;
      batchPaths.push_back(batchPath.string());
    }

    /* TIẾNG: ĐÚNG MỘT LƯỢT cho cả phim, trên TOÀN BỘ intervals gốc (không phải bản đã cắt).
     * Xem khối chú thích ở FilterScriptMode — nối tiếng theo batch là mỗi mối ghép dài thêm
     * 23ms và nghe rõ chỗ ngắt. Lớp phủ lọc còn những cái CÓ TIẾNG và đánh số input lại
     * (xem OverlaysForAudioPass): nạp cả ảnh phụ đề vào lượt này là nổ dòng lệnh. */
    Emit("progress", "Đang render tiếng (một lượt liền mạch cho cả phim)...");
    /* Đuôi theo CODEC TIẾNG, không phải theo thói quen: ProRes đi kèm `pcm_s16le` (xem
     * AppendEncoderArgsForMode), mà container mp4/m4a không chứa PCM — ffmpeg từ chối ngay
     * ở khâu mux. `.mov` chứa được cả hai. */
    fs::path audioPath = batchDir / (settings.codec == "prores" ? "audio.mov" : "audio.m4a");
    {
      EncoderPlan audioPlan = plan;
      int code = ExportBatch(source, audioPath.string(), tempDir, intervals, 0, intervals.size(),
                             batches.size(), batches.size() + 1, settings, audioPlan,
                             OverlaysForAudioPass(overlays), FilterScriptMode::AudioOnly);
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
     * trên). `-shortest` phòng khi hai luồng lệch nhau vài mili giây ở khung cuối. */
    int code = RunIn({
      "ffmpeg", "-y", "-v", "error", "-nostdin",
      "-f", "concat", "-safe", "0", "-i", concatList.string(),
      "-i", audioPath.string(),
      "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest",
      "-movflags", "+faststart", output,
    }, tempDir);
    fs::remove(concatList);
    if (code != 0) {
      Emit("error", "ffmpeg final concat failed", code);
      return code;
    }
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
  int code = Run({"ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concatList.string(), "-c", "copy", output});
  fs::remove(concatList);
  if (code != 0) {
    Emit("error", "ffmpeg final concat failed", code);
    return code;
  }
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
