// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

#include <napi.h>

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

/* Addon C++ của CrabbyCut — CHỈ còn hai việc: trích đỉnh sóng âm và chốt timeline.
 *
 * Trước đây tệp này còn chứa một bản cài đặt SONG SONG của cả pipeline so khớp kịch
 * bản (filterTimeline: tách câu, Needleman-Wunsch, chọn take, gộp hàng…), bật bằng
 * biến môi trường MATCHING_ENGINE=cpp. Bản đó dừng ở 2026-05 trong khi bản Python đi
 * tiếp rất xa, và nguy hiểm ở chỗ nó ÂM THẦM chạy một thuật toán đã được chứng minh
 * là sai: lối chọn take theo cửa sổ quanh mỏ neo Needleman-Wunsch chỉ đạt 37,5% trên
 * dự án có đọc lại cả kịch bản, so với 100% của bản hiện tại. Giữ hai bản không thể
 * đồng bộ nghĩa là mỗi cải tiến phải làm hai lần bằng hai ngôn ngữ — mà thực tế thì
 * lần thứ hai không bao giờ được làm.
 *
 * Bộ so khớp nay chỉ có MỘT bản, ở core_logic.py. Xem docs/APP_INTERNALS.md mục
 * "Phase 7". */

namespace {

struct Row {
  int scriptIndex = -1;
  int chunkIndex = -1;
  double start = 0.0;
  double end = 0.0;
  std::string scriptText;
  std::string matchedText;
  double loudness = 0.0;
  double similarity = 0.0;
  double tokenCoverage = 0.0;
  double score = 0.0;
  bool isClauseRecovery = false;
  std::vector<int> mergedScriptIndices;
};

std::string Trim(const std::string& input) {
  size_t first = 0;
  while (first < input.size() && std::isspace(static_cast<unsigned char>(input[first]))) first++;
  size_t last = input.size();
  while (last > first && std::isspace(static_cast<unsigned char>(input[last - 1]))) last--;
  return input.substr(first, last - first);
}

double NapiNumber(const Napi::Object& obj, const char* key, double fallback = 0.0) {
  Napi::Value value = obj.Get(key);
  if (!value.IsNumber()) return fallback;
  return value.As<Napi::Number>().DoubleValue();
}

int NapiInt(const Napi::Object& obj, const char* key, int fallback = 0) {
  Napi::Value value = obj.Get(key);
  if (!value.IsNumber()) return fallback;
  return value.As<Napi::Number>().Int32Value();
}

std::string NapiString(const Napi::Object& obj, const char* key, const std::string& fallback = "") {
  Napi::Value value = obj.Get(key);
  if (!value.IsString()) return fallback;
  return value.As<Napi::String>().Utf8Value();
}

std::string SecondsToTimecode(double seconds, int fps = 25) {
  int totalFrames = std::max(0, static_cast<int>(std::round(seconds * fps)));
  int hh = totalFrames / (3600 * fps);
  int mm = (totalFrames % (3600 * fps)) / (60 * fps);
  int ss = (totalFrames % (60 * fps)) / fps;
  int ff = totalFrames % fps;
  std::ostringstream out;
  out << std::setfill('0') << std::setw(2) << hh << ":"
      << std::setw(2) << mm << ":" << std::setw(2) << ss << ":"
      << std::setw(2) << ff;
  return out.str();
}

std::string EscapeXml(const std::string& text) {
  std::string out;
  for (char ch : text) {
    switch (ch) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\'': out += "&apos;"; break;
      default: out.push_back(ch); break;
    }
  }
  return out;
}

std::string BuildEdl(const std::vector<Row>& timeline, const std::string& title = "AUTO_CUT", int fps = 25) {
  std::ostringstream out;
  out << "TITLE: " << title << "\nFCM: NON-DROP FRAME\n\n";
  double recordCursor = 0.0;
  int eventNumber = 1;
  for (const auto& item : timeline) {
    const double duration = std::max(0.0, item.end - item.start);
    if (duration < 0.05) continue;
    const double recIn = recordCursor;
    const double recOut = recIn + duration;
    out << std::setfill('0') << std::setw(3) << eventNumber << "  AX       V     C        "
        << SecondsToTimecode(item.start, fps) << " " << SecondsToTimecode(item.end, fps) << " "
        << SecondsToTimecode(recIn, fps) << " " << SecondsToTimecode(recOut, fps) << "\n";
    out << "* FROM CLIP NAME: Script line " << (item.scriptIndex + 1) << "\n";
    out << "* COMMENT: " << item.scriptText << "\n";
    recordCursor = recOut;
    eventNumber++;
  }
  return Trim(out.str()) + "\n";
}

std::string BuildTimelineXml(const std::vector<Row>& timeline) {
  std::ostringstream out;
  out << "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<timeline>\n";
  for (const auto& item : timeline) {
    out << "  <clip script_index=\"" << (item.scriptIndex + 1)
        << "\" start=\"" << std::fixed << std::setprecision(3) << item.start
        << "\" end=\"" << item.end
        << "\" score=\"" << item.score << "\">\n";
    out << "    <script_text>" << EscapeXml(item.scriptText) << "</script_text>\n";
    out << "    <matched_text>" << EscapeXml(item.matchedText) << "</matched_text>\n";
    out << "  </clip>\n";
  }
  out << "</timeline>\n";
  return out.str();
}

Napi::Array MergedIndicesToNapi(Napi::Env env, const std::vector<int>& indices) {
  Napi::Array arr = Napi::Array::New(env, indices.size());
  for (size_t i = 0; i < indices.size(); i++) arr.Set(i, Napi::Number::New(env, indices[i]));
  return arr;
}

Napi::Object RowToObject(Napi::Env env, const Row& row) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("script_index", row.scriptIndex);
  obj.Set("chunk_index", row.chunkIndex);
  obj.Set("start", row.start);
  obj.Set("end", row.end);
  obj.Set("script_text", row.scriptText);
  obj.Set("matched_text", row.matchedText);
  obj.Set("text", row.matchedText);
  obj.Set("loudness_dBFS", row.loudness);
  obj.Set("similarity", row.similarity);
  obj.Set("token_coverage", row.tokenCoverage);
  obj.Set("score", row.score);
  obj.Set("merged_script_indices", MergedIndicesToNapi(env, row.mergedScriptIndices));
  if (row.isClauseRecovery) obj.Set("is_clause_recovery", true);
  return obj;
}

Napi::Array RowsToArray(Napi::Env env, const std::vector<Row>& rows) {
  Napi::Array arr = Napi::Array::New(env, rows.size());
  for (size_t i = 0; i < rows.size(); i++) arr.Set(i, RowToObject(env, rows[i]));
  return arr;
}

std::vector<Row> ReadRowsFromSelectedChunks(const Napi::Value& value) {
  std::vector<Row> rows;
  if (!value.IsArray()) return rows;
  Napi::Array arr = value.As<Napi::Array>();
  int currentScriptIdx = 0;
  for (uint32_t i = 0; i < arr.Length(); i++) {
    Napi::Value itemValue = arr.Get(i);
    if (!itemValue.IsObject()) continue;
    Napi::Object obj = itemValue.As<Napi::Object>();
    Row row;
    row.scriptIndex = NapiInt(obj, "script_index", -1);
    if (row.scriptIndex != -1) currentScriptIdx = row.scriptIndex;
    else row.scriptIndex = currentScriptIdx;
    row.chunkIndex = NapiInt(obj, "chunk_index", -1);
    row.start = NapiNumber(obj, "start", 0.0);
    row.end = NapiNumber(obj, "end", row.start);
    row.scriptText = NapiString(obj, "script_text", "");
    row.matchedText = NapiString(obj, "matched_text", NapiString(obj, "text", ""));
    row.loudness = NapiNumber(obj, "loudness_dBFS", 0.0);
    row.similarity = NapiNumber(obj, "similarity", 1.0);
    row.tokenCoverage = NapiNumber(obj, "token_coverage", 1.0);
    row.score = NapiNumber(obj, "score", 1.0);
    row.mergedScriptIndices = {row.scriptIndex};
    rows.push_back(row);
  }
  return rows;
}

Napi::Value ExtractAudioPeaks(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "extractAudioPeaks expects a TypedArray").ThrowAsJavaScriptException();
    return env.Null();
  }
  int numPeaks = 3000;
  if (info.Length() > 1 && info[1].IsObject()) {
    Napi::Object options = info[1].As<Napi::Object>();
    numPeaks = std::max(1, NapiInt(options, "numPeaks", 3000));
  }

  Napi::TypedArray typed = info[0].As<Napi::TypedArray>();
  std::vector<float> values;
  values.reserve(typed.ElementLength());
  if (typed.TypedArrayType() == napi_int16_array) {
    auto arr = info[0].As<Napi::Int16Array>();
    for (size_t i = 0; i < arr.ElementLength(); i++) values.push_back(static_cast<float>(std::abs(arr[i])) / 32768.0f);
  } else if (typed.TypedArrayType() == napi_float32_array) {
    auto arr = info[0].As<Napi::Float32Array>();
    for (size_t i = 0; i < arr.ElementLength(); i++) values.push_back(std::fabs(arr[i]));
  } else {
    Napi::TypeError::New(env, "extractAudioPeaks supports Int16Array or Float32Array").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Float32Array out = Napi::Float32Array::New(env, numPeaks);
  if (values.empty()) {
    for (int i = 0; i < numPeaks; i++) out[i] = 0.0f;
    return out;
  }
  const size_t samplesPerChunk = std::max<size_t>(1, values.size() / static_cast<size_t>(numPeaks));
  for (int i = 0; i < numPeaks; i++) {
    const size_t start = static_cast<size_t>(i) * samplesPerChunk;
    const size_t end = std::min(values.size(), start + samplesPerChunk);
    float peak = 0.0f;
    if (start < values.size()) {
      for (size_t j = start; j < end; j++) peak = std::max(peak, values[j]);
    }
    out[i] = std::min(1.0f, std::sqrt(peak));
  }
  return out;
}

Napi::Value FinalizeTimeline(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "finalizeTimeline expects an input object").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object input = info[0].As<Napi::Object>();
  std::vector<Row> rows = ReadRowsFromSelectedChunks(input.Get("selected_chunks"));
  Napi::Object result = Napi::Object::New(env);
  result.Set("timeline_script_order", RowsToArray(env, rows));
  result.Set("edl", BuildEdl(rows, "USER_CUT"));
  result.Set("timeline_xml", BuildTimelineXml(rows));
  return result;
}

}  // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("extractAudioPeaks", Napi::Function::New(env, ExtractAudioPeaks));
  exports.Set("finalizeTimeline", Napi::Function::New(env, FinalizeTimeline));
  return exports;
}

NODE_API_MODULE(core_c, Init)
