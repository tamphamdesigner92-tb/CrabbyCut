#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>
"""XOÁ VẬT THỂ BẰNG AI — logo cố định VÀ vật thể chuyển động, vẽ lại nền bằng LaMa + lan truyền.

Chế độ 'ai' của tab Retouch > Xoá vật thể. Khác ba chế độ công thức (delogo/làm mờ/khảm chạy
được ngay trong preview và FFmpeg), AI quá nặng để chạy theo từng khung lúc xem/xuất, nên nó là
MỘT LƯỢT XỬ LÝ TRƯỚC: sidecar này đọc đúng đoạn nguồn cần dùng, vẽ lại vùng ở MỌI khung, và ghi
ra các MIẾNG VÁ PNG (chỉ cỡ vùng + viền mềm). Preview và xuất cùng dán các miếng vá ấy.

VÌ SAO KHÔNG CHỈ LÀ "CHẠY MÔ HÌNH TỪNG KHUNG" (cách của bản MI-GAN trước):
  Vẽ lại độc lập từng khung làm vùng xoá "sôi"/nháy (mỗi lượt GAN bịa chi tiết hơi khác) — trông
  còn tệ hơn delogo, dù từng khung riêng lẻ đẹp hơn. Và LaMa (đẹp hơn MI-GAN hẳn ở vùng lớn)
  tốn ~2 s/lượt trên CPU (M1 Pro) — chạy từng khung là không dùng được. Nên làm như các công cụ
  "content-aware fill" cho video: LAN TRUYỀN TRƯỚC, BỊA SAU.

  1. NỀN THẬT từ khung lân cận (±WINDOW khung): vật thể/máy quay di chuyển thì phần nền sau vùng
     xoá LỘ RA ở khung khác. Căn khung lân cận về khung hiện tại bằng chuyển động toàn cục (điểm
     đặc trưng + LK + RANSAC, ước lượng NGOÀI vùng xoá), lấy pixel thật ở khung GẦN nhất có nó,
     chỉnh độ sáng/màu theo VÀNH quanh vùng (khung sáng dần/tắt dần vẫn khớp).
  2. "TẤM NỀN" (plate): phần chưa từng lộ ra thì LaMa vẽ MỘT lần ở khung khoá, rồi các khung sau
     dùng lại tấm đó (căn theo chuyển động, chỉnh màu theo vành) — hết nháy, và cảnh tĩnh chỉ tốn
     một lượt mô hình. Vành quanh vùng lệch nhiều so với tấm (nền phía sau thật sự đổi) -> vẽ lại.
  3. Mẩu sót nhỏ (mép tấm nền khi máy lia) -> cv2.inpaint (Telea), không đáng một lượt LaMa.

VẬT THỂ CHUYỂN ĐỘNG: frontend gửi các MỐC khung (t, x, y, w, h) người dùng kéo quanh vật thể.
LƯỢT 1 đọc cả khung (thu nhỏ) và BÁM THEO vật thể bằng OpenCV CSRT: từ mỗi mốc chạy xuôi tới
mốc sau và ngược tới mốc trước, giữa hai mốc thì trộn tuyến tính hai kết quả (mốc nào gần thì
tin mốc đó) — người dùng sửa bám lệch bằng cách thêm mốc. LƯỢT 2 là phần lấp ở trên với vùng xoá
đổi theo từng khung. Miếng vá của vật thể có cỡ = hộp bao cả quãng di chuyển (vị trí dán cố định
-> sidecar xuất không phải đổi), ngoài vùng của khung đó thì alpha 0.

MÔ HÌNH: LaMa (Samsung AI, big-lama, Apache-2.0), bản ONNX fp32 512×512 của Carve/LaMa-ONNX.
208 MB, tải về ở lần đầu dùng. KHÔNG dùng CoreML: đo trên M1 Pro chậm hơn CPU 5 lần (10,7 s so
với 2,0 s/lượt) và làm tiến trình văng lúc thoát.

MỐC THỜI GIAN — ĐIỀU QUAN TRỌNG NHẤT CỦA FILE NÀY:
  Miếng vá của khung A dán lên khung B là lộ ngay một mảng lệch. Nên KHÔNG lấy mẫu lại theo fps
  cố định: đọc TỪNG khung thật của nguồn (`-fps_mode passthrough`) và ghi lại PTS thật của nó
  (`showinfo`). `times[i]` theo TRỤC XUẤT — trục mà `trim` của sidecar C++ thấy trên `[N:v]`.

Vào (JSON): source_path, still, start, end (giây trục xuất), frame_w/frame_h (khung mà toạ độ
tính theo), rects [{x,y,w,h}] (vùng cố định, pixel), objects [{keys:[{t,x,y,w,h}]}] (vật thể
chuyển động, t = giây trục xuất), out_dir, model_path, model_url, model_sha256.
Ra: out_dir/index.json + r{k}_{n:06d}.png + r{k}.ffconcat, và JSON kết quả ở output_path.
Thứ tự vùng k: các vùng cố định trước, rồi tới các vật thể.
"""
import bisect
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[1]
INDEX_VERSION = 2
MODEL_NAME = "lama-fp32"
ENGINE_NAME = "propagate-v1"
MODEL_LABEL = "LaMa (Xoá vật thể AI)"
MODEL_DOWNLOAD_ID = "logo_ai:lama"
MAX_RECTS = 4
MAX_OBJECTS = 4
DEBUG = os.environ.get("CRAB_LOGO_AI_DEBUG") == "1"

# Viền mềm của miếng vá (pixel, NGOÀI vùng): miếng vá mang cả dải ảnh gốc quanh vùng với alpha
# giảm dần về 0, để dán lên proxy LQ của preview không hằn thành một khung chữ nhật.
FEATHER_MIN = 4
FEATHER_MAX = 24
# Hộp đọc (pass 2) nới quanh mỗi vùng: đủ ngữ cảnh cho LaMa (khung vuông ~2,2 lần cạnh vùng)
# và cho phép ước lượng chuyển động quanh vùng.
CONTEXT_RATIO = 0.7
CONTEXT_MIN = 32
LAMA_CONTEXT = 2.2
# Lan truyền nền thật: số khung mỗi phía, trần bộ nhớ của bộ đệm khung.
WINDOW = 20
BUFFER_BYTES = 700 * 1024 * 1024
# Ảnh xám để ước lượng chuyển động / ảnh để bám vật thể: cạnh dài tối đa.
ANALYSIS_MAX = 480
# Nửa cửa sổ Lucas-Kanade (px ảnh xám thu nhỏ).
LK_HALF = 7
TRACK_MAX = 640
# Vật thể: nới hộp bám ra mỗi phía (tỉ lệ cạnh dài) — CSRT bám vào LÕI vật thể và trễ sau vật
# đang chạy (đo được lệch tới 10 px với vật 170 px), mép/bóng/tóc thường tràn ra ngoài hộp.
OBJECT_MARGIN = 0.15
OBJECT_MARGIN_MIN = 4
# Chuyển cảnh: sai khác xám trung bình (đã bù độ sáng) của phần KHÔNG xoá giữa hai khung liền
# nhau. Rung tay/nhiễu nén cho ~2–8; cắt cảnh thật > 30.
CUT_MAD = 28.0
# Tấm nền "cũ": vành quanh vùng lệch trung bình quá mức này so với tấm (đã bù màu) -> vẽ lại.
# Nhiễu nén của cảnh tĩnh ~1–2; một người đi ngang phía sau logo > 12.
STALE_MAD = 7.0
# Nguồn lân cận đã căn phải khớp khung hiện tại ở vành quanh vùng (sai khác xám trung bình, đã
# bù sáng) — lệch hơn là căn sai / thị sai (vật gần xa trôi khác nhau), dán vào là lộ mép kép.
ALIGN_MAD = 9.0
# Một khung lân cận chỉ được dùng khi nó lộ ra ít nhất chừng này phần còn thiếu (xem vòng tham lam).
CHUNK_RATIO = 0.2
# Nền thật (tổng các mảng) phải phủ ít nhất chừng này vùng xoá mới được giữ (xem "TẤT CẢ HOẶC KHÔNG").
PROP_MIN_COVER = 0.85
# ... hoặc khi độ sáng/màu quanh vùng đã lệch quá chừng này (0..255) so với tấm.
STALE_OFFSET = 40.0
# Vẽ lại tấm nền không dày hơn mỗi chừng này khung (cảnh động phía sau logo tĩnh).
MIN_REFRESH = 3
# Phần sót sau lan truyền nhỏ hơn chừng này (tỉ lệ vùng xoá, hoặc số pixel) -> Telea.
SMALL_FILL_RATIO = 0.02
SMALL_FILL_PX = 48
# Dùng lại file miếng vá của khung trước khi gần như trùng (cảnh tĩnh -> ít PNG, preview nhẹ).
REUSE_MEAN = 0.6
REUSE_MAX = 6


def emit(obj: Dict[str, Any]) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


_last_ratio = -1.0


# CHỈ phát tỉ lệ, không phát câu trạng thái: dòng có "message" bị backend đẩy thẳng lên thanh
# trạng thái mà không qua bản dịch. backend/logo-ai.js tự báo bằng câu đã dịch theo tỉ lệ này.
def emit_ratio(ratio: float) -> None:
    global _last_ratio
    r = max(0.0, min(1.0, float(ratio)))
    if r - _last_ratio < 0.004 and r < 1.0:
        return
    _last_ratio = r
    emit({"type": "progress", "ratio": round(r, 4)})


def emit_download(state: str, downloaded: int = 0, total: int = 0, error: str = "") -> None:
    emit({"type": "download", "id": MODEL_DOWNLOAD_ID, "label": MODEL_LABEL, "state": state,
          "downloaded": int(downloaded), "total": int(total), "error": error})


def write_output(path: str, payload: Dict[str, Any]) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------------------
# MÔ HÌNH
# ---------------------------------------------------------------------------------------

def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_model(model_path: Path, url: str, sha256: str) -> Path:
    """Tải model về ở lần đầu (có thanh tiến trình ở thanh trạng thái). File tải dở nằm ở
    `.part` và chỉ đổi tên khi băm khớp — tắt app giữa chừng không để lại model hỏng."""
    if model_path.is_file() and model_path.stat().st_size > 1_000_000:
        return model_path
    if not url:
        raise RuntimeError("Thiếu model LaMa và không có địa chỉ tải.")
    model_path.parent.mkdir(parents=True, exist_ok=True)
    part = model_path.with_suffix(model_path.suffix + ".part")
    emit_download("downloading", 0, 0)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "CrabbyCut"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(part, "wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            got = 0
            last = 0.0
            while True:
                chunk = resp.read(1 << 18)
                if not chunk:
                    break
                out.write(chunk)
                got += len(chunk)
                now = time.time()
                if now - last > 0.4:
                    emit_download("downloading", got, total)
                    last = now
        if sha256 and sha256_of(part).lower() != sha256.lower():
            raise RuntimeError("Model tải về bị hỏng (mã băm không khớp) — hãy thử lại.")
        os.replace(part, model_path)
        emit_download("done", got, total or got)
    except Exception as exc:
        try:
            part.unlink()
        except OSError:
            pass
        emit_download("error", error=str(exc))
        raise RuntimeError(f"Không tải được model LaMa: {exc}") from exc
    return model_path


def perf_threads() -> int:
    """Số lõi HIỆU NĂNG trên Apple silicon (lõi tiết kiệm chỉ làm chậm cả nhóm luồng): đo trên
    M1 Pro 8 luồng = 1,97 s/lượt, mặc định (10) = 2,26 s. Máy khác: để onnxruntime tự chọn."""
    if sys.platform != "darwin":
        return 0
    try:
        out = subprocess.run(["sysctl", "-n", "hw.perflevel0.physicalcpu"], capture_output=True, text=True)
        return max(0, int(out.stdout.strip() or 0))
    except Exception:
        return 0


def open_session(model_path: Path):
    import onnxruntime as ort

    available = set(ort.get_available_providers())
    # GPU nếu bản onnxruntime đang cài có (CUDA / DirectML), không thì CPU. CoreML cố ý KHÔNG
    # dùng (chậm hơn CPU 5 lần với LaMa, xem đầu file). Tạo phiên với EP GPU có thể hỏng -> CPU.
    preferred = [p for p in ("CUDAExecutionProvider", "DmlExecutionProvider") if p in available]
    so = ort.SessionOptions()
    so.log_severity_level = 3
    threads = perf_threads()
    if threads:
        so.intra_op_num_threads = threads
    if preferred:
        try:
            sess = ort.InferenceSession(str(model_path), so, providers=[*preferred, "CPUExecutionProvider"])
            return sess, sess.get_providers()[0]
        except Exception:
            pass
    sess = ort.InferenceSession(str(model_path), so, providers=["CPUExecutionProvider"])
    return sess, "CPUExecutionProvider"


class LamaInpainter:
    """LaMa ONNX: vào ảnh 512×512 RGB float 0..1 + mặt nạ (1 = lỗ), ra RGB 0..255. Ảnh cỡ bất
    kỳ: đệm phản chiếu thành hình VUÔNG (co giãn lệch tỉ lệ làm méo kết cấu) rồi co về 512."""

    SIZE = 512

    def __init__(self, model_path: Path) -> None:
        import numpy as np

        self.np = np
        self.model_path = model_path
        self.sess, self.provider = open_session(model_path)

    def _infer(self, image, mask):
        try:
            return self.sess.run(None, {"image": image, "mask": mask})[0]
        except Exception:
            if self.provider == "CPUExecutionProvider":
                raise
            # EP GPU chết giữa chừng (hết VRAM, driver) -> làm tiếp bằng CPU.
            import onnxruntime as ort
            self.sess = ort.InferenceSession(str(self.model_path), providers=["CPUExecutionProvider"])
            self.provider = "CPUExecutionProvider"
            return self.sess.run(None, {"image": image, "mask": mask})[0]

    def run(self, rgb, hole):
        """rgb: HxWx3 uint8, hole: HxW bool (True = vẽ lại). Trả ảnh DỰ ĐOÁN THÔ HxWx3 uint8 — cả
        phần đã biết (mô hình dựng lại nó): caller đo độ lệch màu của mô hình trên vành quanh lỗ."""
        import cv2

        np = self.np
        h, w = hole.shape
        side = max(h, w)
        pad_b, pad_r = side - h, side - w
        img = cv2.copyMakeBorder(rgb, 0, pad_b, 0, pad_r, cv2.BORDER_REFLECT_101) if (pad_b or pad_r) else rgb
        msk = hole.astype(np.uint8) * 255
        if pad_b or pad_r:
            msk = cv2.copyMakeBorder(msk, 0, pad_b, 0, pad_r, cv2.BORDER_CONSTANT, value=0)
        S = self.SIZE
        interp = cv2.INTER_AREA if side > S else cv2.INTER_CUBIC
        small = cv2.resize(img, (S, S), interpolation=interp)
        # Co mặt nạ bằng AREA rồi lấy > 0: pixel nào CHẠM lỗ đều thành lỗ — mép logo không lọt.
        m = (cv2.resize(msk, (S, S), interpolation=cv2.INTER_AREA) > 0).astype(np.float32)
        x = small.astype(np.float32).transpose(2, 0, 1)[None] / 255.0
        x = x * (1.0 - m[None, None])
        out = self._infer(np.ascontiguousarray(x), np.ascontiguousarray(m[None, None]))
        out = np.clip(out[0].transpose(1, 2, 0), 0, 255).astype(np.uint8)
        return np.ascontiguousarray(cv2.resize(out, (side, side), interpolation=cv2.INTER_CUBIC)[:h, :w])


class FakeInpainter:
    """CHỈ CHO TEST (CRAB_LOGO_AI_FAKE=1): lấp lỗ bằng màu TRUNG BÌNH của phần đã biết. Không cần
    tải model, mà vẫn chốt được điều quan trọng nhất của đường xuất: miếng vá của khung i phải
    rơi đúng vào khung i (nguồn đổi màu mỗi khung -> lệch một khung là lộ)."""

    provider = "fake"

    def run(self, rgb, hole):
        import numpy as np

        out = rgb.copy()  # dự đoán thô: phần đã biết giữ nguyên
        known = rgb[~hole]
        out[hole] = known.mean(axis=0).round().astype(np.uint8) if len(known) else 0
        return out


# ---------------------------------------------------------------------------------------
# HÌNH HỌC
# ---------------------------------------------------------------------------------------

def clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def expand(rect: Dict[str, int], pad: int, W: int, H: int) -> Dict[str, int]:
    x0 = clamp(rect["x"] - pad, 0, W)
    y0 = clamp(rect["y"] - pad, 0, H)
    x1 = clamp(rect["x"] + rect["w"] + pad, 0, W)
    y1 = clamp(rect["y"] + rect["h"] + pad, 0, H)
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


def union(boxes: List[Dict[str, int]]) -> Dict[str, int]:
    x0 = min(b["x"] for b in boxes)
    y0 = min(b["y"] for b in boxes)
    x1 = max(b["x"] + b["w"] for b in boxes)
    y1 = max(b["y"] + b["h"] for b in boxes)
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


def feather_of(w: int, h: int) -> int:
    return clamp(int(round(min(w, h) * 0.15)), FEATHER_MIN, FEATHER_MAX)


def context_pad(w: int, h: int) -> int:
    return max(CONTEXT_MIN, int(round(max(w, h) * CONTEXT_RATIO)))


def scaled_box(r: Dict[str, Any], kx: float, ky: float, W: int, H: int) -> Optional[Dict[str, int]]:
    x = clamp(int(round(float(r.get("x", 0)) * kx)), 0, W - 2)
    y = clamp(int(round(float(r.get("y", 0)) * ky)), 0, H - 2)
    w = clamp(int(round(float(r.get("w", 0)) * kx)), 2, W - x)
    h = clamp(int(round(float(r.get("h", 0)) * ky)), 2, H - y)
    if w < 6 or h < 6:
        return None
    return {"x": x, "y": y, "w": w, "h": h}


def feather_alpha(np, box: Dict[str, int], rect: Dict[str, int], feather: int):
    """Alpha cỡ `box`: 255 trong `rect`, giảm TUYẾN TÍNH theo khoảng cách ra ngoài `rect`, 0 khi
    quá `feather` (và ngoài hẳn — miếng vá vật thể lớn hơn vùng của từng khung)."""
    f = max(1, feather)
    xs = np.arange(box["x"], box["x"] + box["w"], dtype=np.float32)
    ys = np.arange(box["y"], box["y"] + box["h"], dtype=np.float32)
    dx = np.maximum(np.maximum(rect["x"] - xs, xs - (rect["x"] + rect["w"] - 1)), 0)
    dy = np.maximum(np.maximum(rect["y"] - ys, ys - (rect["y"] + rect["h"] - 1)), 0)
    d = np.sqrt(dy[:, None] ** 2 + dx[None, :] ** 2)
    return np.clip(255.0 * (1.0 - d / (f + 1)), 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------------------
# ĐỌC NGUỒN
# ---------------------------------------------------------------------------------------

def probe(path: str) -> Dict[str, Any]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,pix_fmt,color_space:stream_side_data=rotation:format=start_time",
         "-of", "json", path],
        capture_output=True, text=True, cwd=str(PROJECT_ROOT))
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe không đọc được nguồn: {out.stderr.strip()[:300]}")
    data = json.loads(out.stdout or "{}")
    st = (data.get("streams") or [{}])[0]
    w = int(st.get("width") or 0)
    h = int(st.get("height") or 0)
    # CÙNG luật với MediaColorUntagged (native/sidecar/core_process.cpp): nguồn YUV HD không
    # gắn nhãn ma trận thì bản xuất gắn bt709 ở đầu chuỗi. Miếng vá phải đổi YUV -> RGB bằng
    # ĐÚNG ma trận đó, không thì dán lại vào luồng xuất là cả miếng lệch màu.
    pix_fmt = str(st.get("pix_fmt") or "")
    space = str(st.get("color_space") or "")
    untagged = (pix_fmt.startswith("yuv") and not pix_fmt.startswith("yuvj")
                and space in ("", "unknown") and h >= 720)
    rot = 0
    for sd in st.get("side_data_list") or []:
        if "rotation" in sd:
            try:
                rot = int(round(float(sd["rotation"])))
            except (TypeError, ValueError):
                rot = 0
    # ffmpeg tự xoay khi giải mã -> khung ra có cạnh đổi chỗ với nguồn xoay 90/270.
    if abs(rot) % 180 == 90:
        w, h = h, w
    try:
        fmt_start = float((data.get("format") or {}).get("start_time") or 0.0)
    except (TypeError, ValueError):
        fmt_start = 0.0
    if not math.isfinite(fmt_start):
        fmt_start = 0.0
    return {"width": w, "height": h, "format_start": fmt_start, "untagged": untagged}


PTS_RE = re.compile(r"\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.eE+-]+)")
SIZE_RE = re.compile(r"\bs:(\d+)x(\d+)")


class FrameReader:
    """Đọc TỪNG khung thật trong [start, end] (trục xuất), đã cắt về hộp `crop` (và thu về
    `out_size` nếu có), kèm PTS.

    `-copyts` + `-ss` (tua nhanh tới gần mốc) rồi `trim` theo trục THÔ = trục xuất +
    start_time của container: tua chỉ để khỏi giải mã từ đầu file, còn chọn khung là việc của
    `trim` trên PTS thật — không phụ thuộc độ chính xác của phép tua. `showinfo` in PTS của
    ĐÚNG các khung đi ra pipe, theo đúng thứ tự. Hai lượt đọc cùng tham số -> cùng dãy khung."""

    def __init__(self, path: str, start: float, end: float, fmt_start: float, crop: Dict[str, int],
                 untagged: bool = False, out_size: Optional[Tuple[int, int]] = None) -> None:
        self.crop = crop
        self.out_w, self.out_h = out_size or (crop["w"], crop["h"])
        raw0 = start + fmt_start
        raw1 = end + fmt_start
        seek = max(0.0, raw0 - 1.0)
        fix = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709," if untagged else ""
        scale = f",scale={self.out_w}:{self.out_h}:flags=area" if out_size else ""
        vf = (f"{fix}trim=start={raw0:.6f}:end={raw1:.6f},"
              f"crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']}{scale},showinfo")
        cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "info",
               "-copyts", "-ss", f"{seek:.6f}", "-i", path, "-map", "0:v:0",
               "-vf", vf, "-fps_mode", "passthrough", "-an", "-sn", "-dn",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        self.fmt_start = fmt_start
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(PROJECT_ROOT))
        self.times: List[float] = []
        self.err_tail: List[str] = []
        self.bad_size = ""
        self._cv = threading.Condition()
        self._done = False
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw in iter(self.proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace")
            m = PTS_RE.search(line) if "showinfo" in line else None
            if m:
                size = SIZE_RE.search(line)
                if size and (int(size.group(1)), int(size.group(2))) != (self.out_w, self.out_h):
                    self.bad_size = f"{size.group(1)}x{size.group(2)}"
                with self._cv:
                    self.times.append(float(m.group(2)) - self.fmt_start)
                    self._cv.notify_all()
            elif line.strip():
                self.err_tail = (self.err_tail + [line.strip()])[-8:]
        with self._cv:
            self._done = True
            self._cv.notify_all()

    def frames(self):
        n = self.out_w * self.out_h * 3
        assert self.proc.stdout is not None
        i = 0
        while True:
            buf = self.proc.stdout.read(n)
            if not buf or len(buf) < n:
                break
            # showinfo ghi log TRƯỚC khi khung ra tới encoder -> PTS của khung i luôn có sẵn
            # hoặc sắp có; chờ ngắn cho chắc thứ tự.
            with self._cv:
                while len(self.times) <= i and not self._done:
                    self._cv.wait(timeout=2.0)
                t = self.times[i] if len(self.times) > i else None
            if t is None:
                raise RuntimeError("Không đọc được mốc thời gian khung từ ffmpeg.")
            if self.bad_size:
                raise RuntimeError(f"ffmpeg trả khung {self.bad_size}, khác hộp đã xin "
                                   f"{self.out_w}x{self.out_h}.")
            yield t, buf
            i += 1

    def close(self) -> int:
        try:
            if self.proc.stdout:
                self.proc.stdout.close()
        except Exception:
            pass
        try:
            return self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
            return -1


def read_still(path: str) -> Tuple[Any, Any]:
    """Ảnh tĩnh -> (RGB HxWx3, alpha HxW hoặc None). Qua ffmpeg như đường video (cùng
    phép xoay EXIF, cùng cách đổi màu)."""
    import numpy as np

    info = probe(path)
    W, H = info["width"], info["height"]
    out = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
                         capture_output=True, cwd=str(PROJECT_ROOT))
    if out.returncode != 0 or len(out.stdout) < W * H * 4:
        raise RuntimeError("Không đọc được ảnh nguồn.")
    arr = np.frombuffer(out.stdout[:W * H * 4], np.uint8).reshape(H, W, 4)
    alpha = arr[:, :, 3]
    return arr[:, :, :3].copy(), (alpha.copy() if alpha.min() < 255 else None)


def even_box(b: Dict[str, int], W: int, H: int) -> Dict[str, int]:
    """CHẴN cả gốc lẫn cạnh: nguồn 4:2:0 thì `crop` lẻ bị ffmpeg tự làm tròn cạnh, và mỗi khung
    đọc từ pipe lệch đi vài byte -> ảnh trượt dần và mất khung cuối (đã gặp)."""
    x0 = b["x"] - b["x"] % 2
    y0 = b["y"] - b["y"] % 2
    x1 = min(W - W % 2, b["x"] + b["w"] + (b["x"] + b["w"]) % 2)
    y1 = min(H - H % 2, b["y"] + b["h"] + (b["y"] + b["h"]) % 2)
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


# ---------------------------------------------------------------------------------------
# BÁM THEO VẬT THỂ (lượt 1)
# ---------------------------------------------------------------------------------------

def make_tracker(cv2):
    for name in ("TrackerCSRT_create", "legacy.TrackerCSRT_create", "TrackerMIL_create"):
        obj = cv2
        try:
            for part in name.split("."):
                obj = getattr(obj, part)
            return obj()
        except Exception:
            continue
    raise RuntimeError("OpenCV thiếu bộ bám vật thể (cần opencv-contrib-python).")


def track_objects(cv2, np, source, start, end, info, W, H, objects_px, progress):
    """Đọc cả khung (thu nhỏ) một lượt, bám theo từng vật thể từ các mốc của nó.
    Trả (times, tracks[o][i] = {x,y,w,h} pixel khung giải mã, lost[o] = số khung mất dấu)."""
    s = min(1.0, TRACK_MAX / max(W, H))
    sw = max(2, int(round(W * s / 2)) * 2)
    sh = max(2, int(round(H * s / 2)) * 2)
    full = {"x": 0, "y": 0, "w": W - W % 2, "h": H - H % 2}
    kx, ky = sw / full["w"], sh / full["h"]
    reader = FrameReader(source, start, end, info["format_start"], full, info["untagged"], (sw, sh))
    jpgs: List[Any] = []
    times: List[float] = []
    span = max(0.05, end - start)
    try:
        for t, buf in reader.frames():
            rgb = np.frombuffer(buf, np.uint8).reshape(sh, sw, 3)
            ok, enc = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
            jpgs.append(enc)
            times.append(round(t, 6))
            progress(0.1 * (t - start) / span)
    finally:
        reader.close()
    n = len(times)
    if not n:
        raise RuntimeError("Không đọc được khung nào để bám vật thể.")
    decoded: Dict[int, Any] = {}

    def frame(i):
        # Giải mã lười + giữ vài khung gần nhất (bám xuôi/ngược lần lượt đi qua cùng khung).
        if i not in decoded:
            if len(decoded) > 8:
                decoded.pop(next(iter(decoded)))
            decoded[i] = cv2.imdecode(jpgs[i], cv2.IMREAD_COLOR)
        return decoded[i]

    def idx_of(t):
        j = bisect.bisect_left(times, t)
        if j <= 0:
            return 0
        if j >= n:
            return n - 1
        return j if abs(times[j] - t) < abs(times[j - 1] - t) else j - 1

    total_steps = max(1, sum(2 * n for _ in objects_px))
    steps = [0]

    def run(i0, box, i_end, step):
        tr = make_tracker(cv2)
        bx = clamp(int(round(box[0])), 0, sw - 3)
        by = clamp(int(round(box[1])), 0, sh - 3)
        b0 = (bx, by, clamp(int(round(box[2])), 2, sw - bx), clamp(int(round(box[3])), 2, sh - by))
        tr.init(frame(i0), b0)
        out = {}
        last = tuple(float(v) for v in b0)
        i = i0 + step
        while (step > 0 and i <= i_end) or (step < 0 and i >= i_end):
            ok, b = tr.update(frame(i))
            if ok and b[2] > 2 and b[3] > 2:
                last = tuple(float(v) for v in b)
                out[i] = (last, False)
            else:
                out[i] = (last, True)
            steps[0] += 1
            progress(0.1 + 0.2 * min(1.0, steps[0] / total_steps))
            i += step
        return out

    tracks = []
    lost_counts = []
    for obj in objects_px:
        keys: Dict[int, Tuple[float, float, float, float]] = {}
        for k in obj:
            keys[idx_of(k["t"])] = (k["x"] * kx, k["y"] * ky, k["w"] * kx, k["h"] * ky)
        order = sorted(keys)
        boxes: List[Optional[Tuple[float, float, float, float]]] = [None] * n
        lost = [False] * n
        for i in order:
            boxes[i] = keys[i]
        if order[0] > 0:
            for i, (b, l) in run(order[0], keys[order[0]], 0, -1).items():
                boxes[i], lost[i] = b, l
        for a, b in zip(order, order[1:]):
            if b - a <= 1:
                continue
            fw = run(a, keys[a], b - 1, 1)
            bw = run(b, keys[b], a + 1, -1)
            for i in range(a + 1, b):
                w = (i - a) / (b - a)
                fb, fl = fw[i]
                bb, bl = bw[i]
                boxes[i] = tuple((1 - w) * p + w * q for p, q in zip(fb, bb))
                lost[i] = fl and bl
        if order[-1] < n - 1:
            for i, (b, l) in run(order[-1], keys[order[-1]], n - 1, 1).items():
                boxes[i], lost[i] = b, l
        track = []
        for b in boxes:
            x, y, w, h = b  # type: ignore[misc]
            track.append({"x": x / kx, "y": y / ky, "w": w / kx, "h": h / ky})
        tracks.append(track)
        lost_counts.append(int(sum(lost)))
    return times, tracks, lost_counts


def hole_box(b: Dict[str, float], W: int, H: int) -> Dict[str, int]:
    """Hộp bám -> vùng xoá: nới OBJECT_MARGIN mỗi phía, pixel nguyên, kẹp trong khung."""
    m = max(OBJECT_MARGIN_MIN, max(b["w"], b["h"]) * OBJECT_MARGIN)
    x0 = clamp(int(math.floor(b["x"] - m)), 0, W - 2)
    y0 = clamp(int(math.floor(b["y"] - m)), 0, H - 2)
    x1 = clamp(int(math.ceil(b["x"] + b["w"] + m)), x0 + 2, W)
    y1 = clamp(int(math.ceil(b["y"] + b["h"] + m)), y0 + 2, H)
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


# ---------------------------------------------------------------------------------------
# LẤP VÙNG (lượt 2)
# ---------------------------------------------------------------------------------------

def mask_bbox(np, m) -> Optional[Tuple[int, int, int, int]]:
    ys = np.flatnonzero(m.any(axis=1))
    if not len(ys):
        return None
    xs = np.flatnonzero(m.any(axis=0))
    return int(xs[0]), int(ys[0]), int(xs[-1] - xs[0] + 1), int(ys[-1] - ys[0] + 1)


def grow_bbox(bb, pad, W, H):
    x, y, w, h = bb
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(W, x + w + pad), min(H, y + h + pad)
    return x0, y0, x1 - x0, y1 - y0


def translate(np, x, y):
    return np.array([[1, 0, x], [0, 1, y], [0, 0, 1]], np.float64)


def warp_into(cv2, np, src, M, bb, nearest=False, border=0):
    """dst(u,v) = src(M · (u + bb.x, v + bb.y)) cỡ bb — M: toạ độ khung ĐANG XỬ LÝ -> khung nguồn."""
    x, y, w, h = bb
    A = M @ translate(np, x, y)
    flags = (cv2.INTER_NEAREST if nearest else cv2.INTER_LINEAR) | cv2.WARP_INVERSE_MAP
    if abs(A[2, 0]) < 1e-12 and abs(A[2, 1]) < 1e-12:
        return cv2.warpAffine(src, A[:2], (w, h), flags=flags, borderMode=cv2.BORDER_CONSTANT, borderValue=border)
    return cv2.warpPerspective(src, A, (w, h), flags=flags, borderMode=cv2.BORDER_CONSTANT, borderValue=border)


def is_identity(np, M) -> bool:
    return bool(np.array_equal(M, np.eye(3)))


def ring_offset(np, cur, warped, ring):
    """Độ lệch màu (theo kênh) giữa khung hiện tại và nguồn đã căn, đo trên VÀNH quanh vùng.
    Trung vị cho chắc với vài pixel lệch (vật khác lướt qua vành) — không kẹp biên độ: khung đổi
    sáng hẳn (nguồn test đổi màu mỗi khung tới ~200) vẫn phải bù đủ. |lệch| < 0,75 -> 0: cảnh
    tĩnh cho đúng từng byte của tấm nền, để khung liền nhau dùng lại được cùng file."""
    if ring.sum() < 20:
        return None
    d = cur[ring].astype(np.float32) - warped[ring].astype(np.float32)
    off = np.median(d, axis=0)
    off[np.abs(off) < 0.75] = 0
    return off


def offset_field(cv2, np, cur, warped, ring, off):
    """Độ lệch màu THAY ĐỔI THEO VỊ TRÍ (nội suy mượt từ các pixel vành — tích chập chuẩn hoá),
    thay cho một hằng số cho cả mảng: vùng nằm trên dải sáng chuyển dần (quầng đèn) mà bù một
    hằng số là lộ mép chữ nhật giữa các mảng lấy từ nguồn khác nhau (đã gặp). Xa vành quá thì
    rơi dần về độ lệch trung vị `off`. None khi không cần bù (cảnh tĩnh: giữ nguyên từng byte)."""
    if off is None:
        return None
    h, w = ring.shape
    d = cur.astype(np.float32) - warped.astype(np.float32)
    wgt = ring.astype(np.float32)
    sigma = max(6.0, 0.3 * max(h, w))
    num = cv2.GaussianBlur(d * wgt[..., None], (0, 0), sigma)
    den = cv2.GaussianBlur(wgt, (0, 0), sigma)
    field = num / np.maximum(den, 1e-6)[..., None]
    a = np.clip(den / 0.02, 0, 1)[..., None]
    field = a * field + (1 - a) * off[None, None, :]
    if not np.any(off) and float(np.max(np.abs(field[ring]))) < 1.0:
        return None
    return field


def paste(np, out, bb, sel, warped, off):
    """Dán warped[sel] vào out (hộp bb), cộng độ lệch màu: None, vector 3 kênh, hoặc trường HxWx3."""
    x, y, w, h = bb
    region = out[y:y + h, x:x + w]
    vals = warped[sel].astype(np.float32)
    if off is not None:
        vals = vals + (off[sel] if off.ndim == 3 else off)
    region[sel] = np.clip(np.round(vals), 0, 255).astype(np.uint8)


def fill_context(cv2, np, painter, img, missing, known=None):
    """LaMa trên khung VUÔNG quanh phần còn thiếu (ngữ cảnh ~LAMA_CONTEXT lần cạnh), tại chỗ.
    Kết quả được BÙ MÀU theo vành quanh lỗ (so dự đoán thô của mô hình với ảnh thật ở đó): LaMa
    hay lệch sáng/lệch màu trên mảng chuyển sắc mượt (quầng đèn) -> dán thô là lộ một khối sáng
    hơn hẳn xung quanh (đã gặp). `known` = pixel tin được làm vành (mặc định: ngoài lỗ)."""
    bb = mask_bbox(np, missing)
    if bb is None:
        return
    x, y, w, h = bb
    H, W = missing.shape
    side = max(w, h)
    S = int(max(side * LAMA_CONTEXT, side + 64))
    cw, ch = min(S, W), min(S, H)
    cx0 = clamp(x + w // 2 - cw // 2, 0, W - cw)
    cy0 = clamp(y + h // 2 - ch // 2, 0, H - ch)
    crop = np.ascontiguousarray(img[cy0:cy0 + ch, cx0:cx0 + cw])
    hole = missing[cy0:cy0 + ch, cx0:cx0 + cw]
    raw = painter.run(crop, hole)
    kn = ~hole if known is None else (known[cy0:cy0 + ch, cx0:cx0 + cw] & ~hole)
    ring = cv2.dilate(hole.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))).astype(bool) & kn
    off = ring_offset(np, crop, raw, ring)
    paste(np, img, (cx0, cy0, cw, ch), hole, raw, offset_field(cv2, np, crop, raw, ring, off))


class Frame:
    __slots__ = ("t", "rgb", "gray", "hole", "ok", "valid_small", "holes")

    def __init__(self, t, rgb, gray, hole, ok, valid_small, holes):
        self.t = t
        self.ok = ok                  # uint8 255 = pixel THẬT dùng làm nguồn được (xa vùng xoá 2px)
        self.rgb = rgb
        self.gray = gray              # xám thu nhỏ (ước lượng chuyển động)
        self.hole = hole              # bool, cỡ hộp đọc: pixel thuộc MỌI vùng xoá của khung này
        self.valid_small = valid_small
        self.holes = holes            # [{x,y,w,h} theo toạ độ hộp đọc] — mỗi vùng một cái


def estimate_motion(cv2, np, a: Frame, b: Frame, scale: float):
    """Chuyển động toàn cục a -> b (CHỈ DỜI — xem local_motion) trên phần KHÔNG xoá, và cờ
    chuyển cảnh. Trả (M 3×3 theo pixel hộp đọc cỡ gốc, cut). Chỉ dùng để phát hiện chuyển cảnh
    và làm đường lùi khi quanh vùng không đủ điểm: bản similarity trước đây xích qua 20 khung là
    trôi tới phóng 10% + xoay 9° (đã gặp), dán nguồn lân cận lệch hẳn."""
    I = np.eye(3)
    both = a.valid_small & b.valid_small
    if both.sum() < 64:
        return I, False
    ga = a.gray.astype(np.float32)
    gb = b.gray.astype(np.float32)
    hh, ww = a.gray.shape
    pts = roi_features(cv2, np, a, (0, 0, ww, hh))
    M = local_motion(cv2, np, a, b, pts, scale)
    if M is None:
        M = I
    # Chuyển cảnh: sau khi căn, phần không xoá vẫn khác hẳn.
    tx, ty = M[0, 2] * scale, M[1, 2] * scale
    wa = cv2.warpAffine(ga, np.float32([[1, 0, tx], [0, 1, ty]]), (ww, hh), flags=cv2.INTER_LINEAR,
                        borderMode=cv2.BORDER_CONSTANT, borderValue=-1)
    m = both & (wa >= 0)
    if m.sum() < 64:
        return M, False
    d = gb[m] - wa[m]
    return M, float(np.mean(np.abs(d - np.median(d)))) > CUT_MAD


def roi_features(cv2, np, a: Frame, roi):
    """Điểm đặc trưng của khung a trong hộp roi (toạ độ ảnh xám thu nhỏ), NGOÀI vùng xoá."""
    x, y, w, h = roi
    # Cách vùng xoá ít nhất nửa cửa sổ LK: điểm sát vật thể có cửa sổ trùm lên vật -> LK bám
    # theo VẬT chứ không theo nền (đo được: độ dời trung vị = đúng vận tốc của vật).
    far = cv2.erode(a.valid_small.astype(np.uint8), np.ones((2 * LK_HALF + 1, 2 * LK_HALF + 1), np.uint8))
    m = np.zeros(a.gray.shape, np.uint8)
    m[y:y + h, x:x + w] = far[y:y + h, x:x + w] * 255
    return cv2.goodFeaturesToTrack(a.gray, 200, 0.01, 4, mask=m)


def local_motion(cv2, np, a: Frame, b: Frame, pts, scale: float):
    """Chuyển động a -> b của NỀN QUANH MỘT VÙNG (điểm `pts` của roi_features), không phải của
    cả hộp đọc: hộp đọc của vật thể to cỡ cả khung, mà trong đó người/vật tiền cảnh chuyển động
    riêng -> "chuyển động toàn cục" là của tiền cảnh (đo được: 7,5 px/khung trong khi máy quay
    chỉ trôi 1–2 px). Theo dõi xuôi + ngược (LK), bỏ điểm không quay về chỗ cũ. None = không đủ
    điểm tin được (vùng phẳng) — caller dùng chuyển động toàn cục."""
    if pts is None or len(pts) < 8:
        return None
    p1, st, _ = cv2.calcOpticalFlowPyrLK(a.gray, b.gray, pts, None, winSize=(2 * LK_HALF + 1, 2 * LK_HALF + 1), maxLevel=4)
    if p1 is None:
        return None
    p0r, st2, _ = cv2.calcOpticalFlowPyrLK(b.gray, a.gray, p1, None, winSize=(2 * LK_HALF + 1, 2 * LK_HALF + 1), maxLevel=4)
    p = pts.reshape(-1, 2)
    q = p1.reshape(-1, 2)
    fb = np.linalg.norm(p0r.reshape(-1, 2) - p, axis=1)
    hh, ww = b.gray.shape
    ok = (st.reshape(-1) == 1) & (st2.reshape(-1) == 1) & (fb < 0.7)
    ok &= (q[:, 0] >= 0) & (q[:, 1] >= 0) & (q[:, 0] < ww - 1) & (q[:, 1] < hh - 1)
    if ok.sum() < 8:
        return None
    qi = np.round(q[ok]).astype(int)
    idx = np.flatnonzero(ok)[b.valid_small[qi[:, 1], qi[:, 0]]]
    if len(idx) < 8:
        return None
    # CHỈ DỜI (không xoay/phóng): vùng quanh một lỗ nhỏ, điểm dồn cục -> khớp similarity bị
    # "bịa" xoay 1,8° + phóng 1,2% quanh gốc hộp đọc, thành lệch 30 px ở chỗ lỗ (đo được: sai
    # khác vành 4,8 so với 1,3 khi không dời gì). Trung vị độ dời của điểm tốt là đủ và bền.
    dxy = np.median(q[idx] - p[idx], axis=0) / scale
    # Độ tản (px ảnh THU NHỎ): điểm không cùng chuyển động (vật khác, thị sai) -> không tin.
    spread = np.median(np.abs(q[idx] - p[idx] - dxy * scale), axis=0)
    if float(np.max(spread)) > 1.5:
        return None
    if abs(dxy[0]) < 0.15 and abs(dxy[1]) < 0.15:
        return np.eye(3)
    return translate(np, float(dxy[0]), float(dxy[1]))
    return M


def process_video(cv2, np, painter, payload, stats):
    source = str(payload.get("source_path") or "")
    info = probe(source)
    W, H = info["width"], info["height"]
    if not (W > 0 and H > 0):
        raise RuntimeError("Không đọc được kích thước khung của nguồn.")
    frame_w = int(payload.get("frame_w") or 0) or W
    frame_h = int(payload.get("frame_h") or 0) or H
    kx, ky = W / frame_w, H / frame_h
    start = max(0.0, float(payload.get("start") or 0.0))
    end = max(start + 0.05, float(payload.get("end") or 0.0))

    statics = [b for b in (scaled_box(r, kx, ky, W, H) for r in (payload.get("rects") or [])[:MAX_RECTS]) if b]
    objects_px = []
    for obj in (payload.get("objects") or [])[:MAX_OBJECTS]:
        keys = []
        for k in (obj.get("keys") if isinstance(obj, dict) else None) or []:
            b = scaled_box(k, kx, ky, W, H)
            if b:
                keys.append({**b, "t": float(k.get("t") or 0.0)})
        if keys:
            objects_px.append(keys)
    if not statics and not objects_px:
        raise RuntimeError("Vùng xoá quá nhỏ hoặc nằm ngoài khung.")

    span = max(0.05, end - start)
    pass1 = 0.3 if objects_px else 0.0

    # ---- LƯỢT 1: bám vật thể (chỉ khi có vật thể) ----
    tracks: List[List[Dict[str, float]]] = []
    lost: List[int] = []
    times1: List[float] = []
    if objects_px:
        # Bám trên khoảng PHỦ CẢ các mốc: block bị cắt ngắn sau khi vẽ thì mốc có thể nằm ngoài
        # đoạn xử lý — bám từ đúng khung của mốc rồi mới cắt về đoạn, chứ không đặt hộp của mốc
        # vào khung đầu đoạn (vật đã đi chỗ khác từ lâu).
        key_ts = [k["t"] for keys in objects_px for k in keys]
        t0 = max(0.0, min(start, min(key_ts) - 0.05))
        t1 = max(end, max(key_ts) + 0.05)
        times1, tracks, lost = track_objects(cv2, np, source, t0, t1, info, W, H, objects_px,
                                             lambda r: emit_ratio(r))
    all_holes = [[hole_box(b, W, H) for b in tr] for tr in tracks]

    def track_index(t: float) -> int:
        j = bisect.bisect_left(times1, t)
        if j <= 0:
            return 0
        if j >= len(times1):
            return len(times1) - 1
        return j if abs(times1[j] - t) < abs(times1[j - 1] - t) else j - 1

    # Chỉ phần bám nằm TRONG đoạn xử lý mới quyết định hộp đọc / hộp miếng vá.
    if objects_px:
        lo = track_index(start)
        hi = track_index(end)
        obj_holes = [oh[lo:hi + 1] or oh[lo:lo + 1] for oh in all_holes]
    else:
        obj_holes = []

    def holes_at(t: float) -> List[Dict[str, int]]:
        hs = list(statics)
        if all_holes:
            j = track_index(t)
            for oh in all_holes:
                hs.append(oh[j])
        return hs

    # Hộp đọc: bao mọi vùng (mọi khung) + ngữ cảnh.
    ctx_boxes = [expand(b, context_pad(b["w"], b["h"]), W, H) for b in statics]
    for oh in obj_holes:
        ctx_boxes.append(expand(union(oh), context_pad(max(b["w"] for b in oh), max(b["h"] for b in oh)), W, H))
    R = even_box(union(ctx_boxes), W, H)
    Rw, Rh = R["w"], R["h"]

    # Hộp miếng vá của từng vùng (toạ độ hộp đọc) + viền mềm.
    feathers = [feather_of(b["w"], b["h"]) for b in statics]
    feathers += [feather_of(objects_px[o][0]["w"], objects_px[o][0]["h"]) for o in range(len(obj_holes))]
    n_reg = len(statics) + len(obj_holes)

    def to_r(b):
        return {"x": b["x"] - R["x"], "y": b["y"] - R["y"], "w": b["w"], "h": b["h"]}

    patch_boxes = []
    for k in range(n_reg):
        f = feathers[k]
        src = [statics[k]] if k < len(statics) else obj_holes[k - len(statics)]
        patch_boxes.append(expand(to_r(union([expand(b, f, W, H) for b in src])), 0, Rw, Rh))
    static_alpha = [feather_alpha(np, patch_boxes[k], to_r(statics[k]), feathers[k]) for k in range(len(statics))]

    a_scale = min(1.0, ANALYSIS_MAX / max(Rw, Rh))
    gw, gh = max(8, int(round(Rw * a_scale))), max(8, int(round(Rh * a_scale)))
    a_scale = gw / Rw
    win = int(clamp(BUFFER_BYTES // max(1, 2 * Rw * Rh * 4), 3, WINDOW))
    kernel3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    ring_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))

    def make_frame(i, t, buf) -> Frame:
        rgb = np.frombuffer(buf, np.uint8).reshape(Rh, Rw, 3).copy()
        hs = [to_r(b) for b in holes_at(t)]
        hole = np.zeros((Rh, Rw), bool)
        for b in hs:
            hole[max(0, b["y"]):b["y"] + b["h"], max(0, b["x"]):b["x"] + b["w"]] = True
        gray = cv2.resize(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), (gw, gh), interpolation=cv2.INTER_AREA)
        hs_small = cv2.resize(hole.astype(np.uint8), (gw, gh), interpolation=cv2.INTER_AREA) > 0
        valid_small = ~cv2.dilate(hs_small.astype(np.uint8), kernel3, iterations=2).astype(bool)
        ok = np.where(cv2.dilate(hole.astype(np.uint8), kernel3, iterations=2) > 0, 0, 255).astype(np.uint8)
        return Frame(t, rgb, gray, hole, ok, valid_small, hs)

    reader = FrameReader(source, start, end, info["format_start"], R, info["untagged"])
    it = reader.frames()
    frames: Dict[int, Frame] = {}
    Hc: Dict[int, Any] = {}      # i -> chuyển động khung i -> i+1
    cut: Dict[int, bool] = {}    # i -> có chuyển cảnh giữa i và i+1
    read_n = [0]
    eof = [False]

    def ensure(upto):
        while not eof[0] and read_n[0] <= upto:
            try:
                t, buf = next(it)
            except StopIteration:
                eof[0] = True
                break
            i = read_n[0]
            frames[i] = make_frame(i, t, buf)
            if i - 1 in frames:
                Hc[i - 1], cut[i - 1] = estimate_motion(cv2, np, frames[i - 1], frames[i], a_scale)
            read_n[0] += 1

    times: List[float] = []
    rect_frames: List[List[int]] = [[] for _ in range(n_reg)]
    last_patch: List[Optional[Tuple[Any, Any, int]]] = [None] * n_reg
    counters = [0] * n_reg
    # Tấm nền RIÊNG cho từng nhóm vùng (khoá = chỉ số vùng nhỏ nhất của nhóm): mỗi vùng ở một
    # chỗ khác của khung, có độ sáng, mức "cũ" và khung khoá riêng. Dùng chung một tấm là vùng
    # này làm vùng kia phải vẽ lại, và một độ lệch màu áp cho cả hai (đã gặp: logo nhỏ bị nhuộm
    # theo màu vành của vùng lớn).
    plates: Dict[int, Dict[str, Any]] = {}
    stale_n = 0
    dilate8 = cv2.getStructuringElement(cv2.MORPH_RECT, (17, 17))

    def groups_of(cur: Frame):
        """Gộp các vùng CHẠM nhau (nới 8px) thành nhóm; mỗi nhóm lấp như một lỗ."""
        n = len(cur.holes)
        parent = list(range(n))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        for a in range(n):
            for b in range(a + 1, n):
                A, B = cur.holes[a], cur.holes[b]
                if (A["x"] - 8 < B["x"] + B["w"] and B["x"] - 8 < A["x"] + A["w"]
                        and A["y"] - 8 < B["y"] + B["h"] and B["y"] - 8 < A["y"] + A["h"]):
                    parent[find(b)] = find(a)
        out: Dict[int, List[int]] = {}
        for a in range(n):
            out.setdefault(find(a), []).append(a)
        return [sorted(v) for v in out.values()]

    try:
        i = 0
        while True:
            ensure(i + win)
            cur = frames.get(i)
            if cur is None:
                break
            # Tấm nền đi theo chuyển động: M_{i->k} = M_{i-1->k} · M_{i->i-1}.
            if i > 0 and plates:
                if cut.get(i - 1):
                    plates.clear()
                else:
                    # Tạm theo chuyển động TOÀN CỤC; nhóm nào ước lượng được chuyển động CỤC BỘ
                    # quanh vùng của nó thì thay bằng số đó (xem vòng nhóm bên dưới).
                    inv = np.linalg.inv(Hc[i - 1])
                    for pl in plates.values():
                        pl["M_prev"] = pl["M"]
                        pl["M"] = pl["M"] @ inv
            out = cur.rgb.copy()
            real_i = cur.ok > 0
            dbg_src: List[str] = []

            # Chuỗi chuyển động tới mọi khung trong cửa sổ, dừng ở chuyển cảnh.
            cands = []
            M = np.eye(3)
            for j in range(i + 1, i + win + 1):
                if j not in frames or cut.get(j - 1, True):
                    break
                M = Hc[j - 1] @ M
                cands.append((j, M))
            M = np.eye(3)
            for j in range(i - 1, i - win - 1, -1):
                if j not in frames or cut.get(j, True):
                    break
                M = np.linalg.inv(Hc[j]) @ M
                cands.append((j, M))

            for grp in groups_of(cur):
                gid = grp[0]
                missing = np.zeros((Rh, Rw), bool)
                for k in grp:
                    b = cur.holes[k]
                    missing[max(0, b["y"]):b["y"] + b["h"], max(0, b["x"]):b["x"] + b["w"]] = True
                hole_area = int(missing.sum())
                bb = grow_bbox(mask_bbox(np, missing), 8, Rw, Rh)
                x, y, w, h = bb
                # Chuyển động CỤC BỘ quanh nhóm tới từng khung lân cận (rơi về toàn cục khi vùng
                # quanh phẳng quá, không đủ điểm).
                rp = max(24, int(0.75 * max(w, h)))
                rx0, ry0, rw0, rh0 = grow_bbox(bb, rp, Rw, Rh)
                roi = (int(rx0 * a_scale), int(ry0 * a_scale),
                       max(4, int(rw0 * a_scale)), max(4, int(rh0 * a_scale)))
                pts = roi_features(cv2, np, cur, roi)
                g_cands = []
                for j, Mg in cands:
                    Ml = local_motion(cv2, np, cur, frames[j], pts, a_scale)
                    g_cands.append((j, Mg if Ml is None else Ml))
                pl = plates.get(gid)
                if pl is not None and "M_prev" in pl and i - 1 in frames:
                    Ml = local_motion(cv2, np, cur, frames[i - 1], pts, a_scale)
                    if Ml is not None:
                        pl["M"] = pl["M_prev"] @ Ml
                if pl is not None:
                    pl.pop("M_prev", None)
                sub_real = real_i[y:y + h, x:x + w]
                sub_hole = missing[y:y + h, x:x + w].copy()
                g_now = [cv2.cvtColor(out[y:y + h, x:x + w], cv2.COLOR_RGB2GRAY).astype(np.float32)]

                def band():
                    """Vành (~6px) quanh phần còn thiếu của nhóm: pixel THẬT của khung i, hoặc pixel
                    của nhóm ĐÃ lấp ở lượt trước — mảng sau khớp với mảng trước ở chỗ giáp nhau,
                    không chỉ với ảnh gốc, nên các mảng từ nguồn khác nhau không lệch mép."""
                    m = missing[y:y + h, x:x + w]
                    return cv2.dilate(m.astype(np.uint8), ring_k).astype(bool) & ~m & (sub_real | sub_hole)

                def aligned(warped, ring):
                    """Nguồn đã căn có KHỚP khung i quanh vùng không (sai khác xám đã bù sáng)."""
                    dd = g_now[0][ring] - cv2.cvtColor(warped, cv2.COLOR_RGB2GRAY).astype(np.float32)[ring]
                    return float(np.mean(np.abs(dd - np.median(dd))))

                def pasted():
                    g_now[0] = cv2.cvtColor(out[y:y + h, x:x + w], cv2.COLOR_RGB2GRAY).astype(np.float32)

                # 1) NỀN THẬT từ khung lân cận — THAM LAM theo độ phủ: mỗi lượt lấy khung lộ
                #    ra NHIỀU nhất phần còn thiếu (ưu tiên khung gần khi ngang nhau). Máy quay
                #    trôi chậm thì mỗi khung chỉ lộ một dải mảnh; ghép hàng chục dải mỗi dải một
                #    sai số căn/màu là ra vệt sọc (đã gặp) -> dải dưới CHUNK_RATIO bị bỏ, để tấm
                #    nền (đồng nhất) lo. Nguồn lệch ở vành (thị sai, căn sai) cũng bị bỏ.
                tried = set()
                snap_out = out[y:y + h, x:x + w].copy()
                snap_miss = missing[y:y + h, x:x + w].copy()
                prop_px = 0
                for _round in range(6):
                    left = int(missing[y:y + h, x:x + w].sum())
                    if not left:
                        break
                    best = None
                    for j, Mj in g_cands:
                        if j in tried:
                            continue
                        valid = warp_into(cv2, np, frames[j].ok, Mj, bb, nearest=True) > 0
                        cnt = int((missing[y:y + h, x:x + w] & valid).sum())
                        score = cnt * (1.0 - 0.01 * abs(j - i))
                        if cnt and (best is None or score > best[0]):
                            best = (score, cnt, j, Mj, valid)
                    if best is None or (best[1] < CHUNK_RATIO * left and best[1] < left):
                        break
                    _, cnt, j, Mj, valid = best
                    tried.add(j)
                    # Tinh chỉnh độ dời ±2 px trên VÀNH (khớp trực tiếp pixel, chính xác hơn
                    # điểm đặc trưng ở ảnh thu nhỏ).
                    best_al = None
                    ring0 = band()
                    for ty in (-2, -1, 0, 1, 2):
                        for tx in (-2, -1, 0, 1, 2):
                            Mt = translate(np, tx, ty) @ Mj
                            v_t = warp_into(cv2, np, frames[j].ok, Mt, bb, nearest=True) > 0
                            r_t = ring0 & v_t
                            if r_t.sum() < 30:
                                continue
                            w_t = warp_into(cv2, np, frames[j].rgb, Mt, bb)
                            a_t = aligned(w_t, r_t)
                            if best_al is None or a_t < best_al[0]:
                                best_al = (a_t, Mt, v_t, w_t, r_t)
                    if best_al is None:
                        continue
                    al, Mj, valid, warped, ring = best_al
                    cnt = int((missing[y:y + h, x:x + w] & valid).sum())
                    if al > ALIGN_MAD:
                        continue
                    sel = missing[y:y + h, x:x + w] & valid
                    cur_sub = out[y:y + h, x:x + w]
                    paste(np, out, bb, sel, warped,
                          offset_field(cv2, np, cur_sub, warped, ring, ring_offset(np, cur_sub, warped, ring)))
                    missing[y:y + h, x:x + w] &= ~sel
                    pasted()
                    prop_px += cnt
                    if DEBUG:
                        dbg_src.append(f"g{gid}{j - i:+d}:{cnt}")

                # TẤT CẢ HOẶC KHÔNG: nền thật chỉ được giữ khi nó phủ gần hết vùng. Phủ một phần
                # thì mép giữa các mảng (nguồn khác nhau, sai số căn/màu khác nhau) thành những
                # đường chữ nhật mờ, và LaMa vẽ phần còn lại lại NỐI TIẾP đúng các đường đó thành
                # một ô vuông nhạt (đã gặp). Bỏ hẳn -> tấm nền / LaMa lấp cả vùng, liền một mảng.
                if prop_px and prop_px < PROP_MIN_COVER * hole_area:
                    out[y:y + h, x:x + w] = snap_out
                    missing[y:y + h, x:x + w] = snap_miss
                    pasted()
                    if DEBUG:
                        dbg_src.append(f"g{gid}prop-drop:{prop_px}/{hole_area}")
                else:
                    stats["propagated"] += prop_px

                # 2) TẤM NỀN của nhóm — phần chưa từng lộ ra.
                if missing[y:y + h, x:x + w].any() and pl is not None:
                    ones = np.full(pl["img"].shape[:2], 255, np.uint8)
                    inb = warp_into(cv2, np, ones, pl["M"], bb, nearest=True) > 0
                    warped = warp_into(cv2, np, pl["img"], pl["M"], bb)
                    preal = warp_into(cv2, np, pl["real"], pl["M"], bb, nearest=True) > 0
                    ring = band() & inb & preal
                    off = ring_offset(np, out[y:y + h, x:x + w], warped, ring)
                    # Tấm "cũ" khi vành quanh vùng lệch nhiều so với tấm — HOẶC không kiểm được
                    # (vành rơi vào phần tấm cũng do LaMa bịa ra: vật thể đã đi chỗ khác), vì dán
                    # một mảng bịa mà không đối chiếu được là lộ mảng lệch sáng/lệch nét (đã gặp).
                    # Khung khoá còn rất gần (< MIN_REFRESH) thì vẫn tin tấm.
                    # Độ sáng quanh vùng đổi mạnh (đèn flash, chuyển cảnh mà không bắt được) cũng
                    # là cũ: bù cộng một lượng lớn giữ được màu trung bình nhưng sai kết cấu.
                    stale = i - pl["k"] >= MIN_REFRESH and (off is None or ring.sum() < 30
                                                            or float(np.max(np.abs(off))) > STALE_OFFSET
                                                            or aligned(warped, ring) > STALE_MAD)
                    if not stale:
                        sel = missing[y:y + h, x:x + w] & inb
                        if sel.any():
                            paste(np, out, bb, sel, warped,
                                  offset_field(cv2, np, out[y:y + h, x:x + w], warped, ring, off))
                            missing[y:y + h, x:x + w] &= ~sel
                            if DEBUG:
                                dbg_src.append(f"g{gid}plate:{int(sel.sum())}")
                    else:
                        stale_n += 1

                # 3) Phần còn lại: mẩu nhỏ -> Telea; lớn -> LaMa, và khung này thành tấm nền mới.
                rest = int(missing[y:y + h, x:x + w].sum())
                if rest:
                    if rest <= max(SMALL_FILL_PX, SMALL_FILL_RATIO * hole_area):
                        tb = grow_bbox(mask_bbox(np, missing), 12, Rw, Rh)
                        tx, ty, tw, th = tb
                        sub = np.ascontiguousarray(out[ty:ty + th, tx:tx + tw])
                        m = missing[ty:ty + th, tx:tx + tw]
                        filled = cv2.inpaint(sub, m.astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
                        out[ty:ty + th, tx:tx + tw][m] = filled[m]
                        stats["telea"] += 1
                    else:
                        if DEBUG:
                            dbg_src.append(f"g{gid}lama:{rest}")
                        known = real_i.copy()
                        known[y:y + h, x:x + w] |= sub_hole & ~missing[y:y + h, x:x + w]
                        fill_context(cv2, np, painter, out, missing, known)
                        stats["inferred"] += 1
                        plates[gid] = {"img": out.copy(), "real": np.where(cur.hole, 0, 255).astype(np.uint8),
                                       "M": np.eye(3), "k": i}

            # VẬT THỂ: hoà dần từ ảnh gốc sang phần lấp trong 1/3 lề ngoài của hộp xoá. Lề đó
            # (OBJECT_MARGIN) là NỀN THẬT (vật nằm trong lõi), nên hoà ở đây xoá được bậc sáng
            # nhỏ giữa phần lấp và nền quanh nó thay vì để lộ một viền chữ nhật.
            for k in range(len(statics), n_reg):
                hb = cur.holes[k]
                mpx = max(OBJECT_MARGIN_MIN, max(hb["w"], hb["h"]) * OBJECT_MARGIN / (1 + 2 * OBJECT_MARGIN))
                f_in = max(2, int(mpx / 3))
                x0, y0 = max(0, hb["x"]), max(0, hb["y"])
                x1, y1 = min(Rw, hb["x"] + hb["w"]), min(Rh, hb["y"] + hb["h"])
                if x1 - x0 < 2 * f_in or y1 - y0 < 2 * f_in:
                    continue
                xs = np.arange(x0, x1, dtype=np.float32)
                ys = np.arange(y0, y1, dtype=np.float32)
                dx = np.minimum(xs - hb["x"] + 0.5, hb["x"] + hb["w"] - xs - 0.5)
                dy = np.minimum(ys - hb["y"] + 0.5, hb["y"] + hb["h"] - ys - 0.5)
                wgt = np.clip(np.minimum(dy[:, None], dx[None, :]) / f_in, 0, 1)[..., None]
                o = out[y0:y1, x0:x1].astype(np.float32)
                g = cur.rgb[y0:y1, x0:x1].astype(np.float32)
                out[y0:y1, x0:x1] = np.clip(np.round(g * (1 - wgt) + o * wgt), 0, 255).astype(np.uint8)

            # Miếng vá từng vùng.
            for k in range(n_reg):
                pb = patch_boxes[k]
                rgb = out[pb["y"]:pb["y"] + pb["h"], pb["x"]:pb["x"] + pb["w"]]
                if k < len(statics):
                    alpha = static_alpha[k]
                else:
                    alpha = feather_alpha(np, pb, cur.holes[k], feathers[k])
                rgb = np.where(alpha[:, :, None] > 0, rgb, 0).astype(np.uint8)
                prev = last_patch[k]
                if (prev is not None and np.array_equal(prev[1], alpha)
                        and np.mean(np.abs(prev[0].astype(np.int16) - rgb)) < REUSE_MEAN
                        and np.max(np.abs(prev[0].astype(np.int16) - rgb)) <= REUSE_MAX):
                    rect_frames[k].append(prev[2])
                    stats["reused"] += 1
                    continue
                n = counters[k]
                counters[k] += 1
                write_png(cv2, Path(payload["out_dir"]) / f"r{k}_{n:06d}.png", np.dstack([rgb, alpha]))
                last_patch[k] = (rgb.copy(), alpha, n)
                rect_frames[k].append(n)
            if DEBUG:
                M = Hc.get(i, np.eye(3))
                print(f"[dbg] i={i} t={cur.t:.3f} M=({M[0,2]:+.1f},{M[1,2]:+.1f},s={math.hypot(M[0,0],M[1,0]):.3f}) "
                      f"cut={cut.get(i)} src={dbg_src} plates={ {g: p['k'] for g, p in plates.items()} }",
                      file=sys.stderr, flush=True)
            times.append(round(cur.t, 6))
            emit_ratio(pass1 + (1 - pass1) * (cur.t - start) / span)
            # Bỏ khung đã ra khỏi cửa sổ lan truyền.
            frames.pop(i - win - 1, None)
            Hc.pop(i - win - 2, None)
            cut.pop(i - win - 2, None)
            i += 1
    finally:
        code = reader.close()
    if not times:
        detail = " | ".join(reader.err_tail[-3:])
        raise RuntimeError(f"Không đọc được khung nào trong đoạn nguồn (mã {code}). {detail}".strip())
    stats["stale_refresh"] = stale_n
    rect_out = []
    for k in range(n_reg):
        write_ffconcat(Path(payload["out_dir"]), k, times, rect_frames[k])
        pb = patch_boxes[k]
        box = {"x": pb["x"] + R["x"], "y": pb["y"] + R["y"], "w": pb["w"], "h": pb["h"]}
        if k < len(statics):
            rect_out.append({**statics[k], "kind": "logo", "box": box, "frames": rect_frames[k]})
        else:
            o = k - len(statics)
            per_frame = [all_holes[o][track_index(t)] for t in times]
            rect_out.append({**union(per_frame), "kind": "object", "box": box, "frames": rect_frames[k],
                             "track": [[b["x"], b["y"], b["w"], b["h"]] for b in per_frame],
                             # Hộp BÁM (chưa nới lề) từng khung — preview vẽ khung này cho người
                             # dùng kiểm tra bám đúng vật, và từ đó sửa bằng cách thêm mốc.
                             "core": [[round(c["x"], 1), round(c["y"], 1), round(c["w"], 1), round(c["h"], 1)]
                                      for c in (tracks[o][track_index(t)] for t in times)],
                             "lost": lost[o]})
    return {"W": W, "H": H, "start": start, "end": end, "times": times, "rects": rect_out}


def process_still(cv2, np, painter, payload, stats):
    rgb, alpha = read_still(str(payload.get("source_path") or ""))
    H, W = rgb.shape[:2]
    frame_w = int(payload.get("frame_w") or 0) or W
    frame_h = int(payload.get("frame_h") or 0) or H
    statics = [b for b in (scaled_box(r, W / frame_w, H / frame_h, W, H)
                           for r in (payload.get("rects") or [])[:MAX_RECTS]) if b]
    if not statics:
        raise RuntimeError("Vùng xoá quá nhỏ hoặc nằm ngoài ảnh.")
    out = rgb.copy()
    hole = np.zeros((H, W), bool)
    for b in statics:
        hole[b["y"]:b["y"] + b["h"], b["x"]:b["x"] + b["w"]] = True
    fill_context(cv2, np, painter, out, hole)
    stats["inferred"] += 1
    rect_out = []
    for k, b in enumerate(statics):
        f = feather_of(b["w"], b["h"])
        box = expand(b, f, W, H)
        a = feather_alpha(np, box, b, f)
        if alpha is not None:
            src_a = alpha[box["y"]:box["y"] + box["h"], box["x"]:box["x"] + box["w"]]
            a = ((a.astype(np.uint16) * src_a.astype(np.uint16)) // 255).astype(np.uint8)
        patch = out[box["y"]:box["y"] + box["h"], box["x"]:box["x"] + box["w"]]
        write_png(cv2, Path(payload["out_dir"]) / f"r{k}_{0:06d}.png", np.dstack([patch, a]))
        rect_out.append({**b, "kind": "logo", "box": box, "frames": [0]})
        emit_ratio((k + 1) / len(statics))
    return {"W": W, "H": H, "start": 0.0, "end": 0.0, "times": [0.0], "rects": rect_out}


def write_png(cv2, path: Path, rgba) -> None:
    ok = cv2.imwrite(str(path), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_PNG_COMPRESSION, 3])
    if not ok:
        raise RuntimeError(f"Không ghi được {path.name}")


def write_ffconcat(out_dir: Path, k: int, times: List[float], files: List[int]) -> None:
    """Danh sách cho concat demuxer: mỗi miếng vá hiện đúng tới khung sau (khung liền nhau
    dùng lại một miếng vá thì gộp thành một dòng). PTS ra = times[i] - times[0], đúng từng
    khung kể cả nguồn VFR. Dòng cuối lặp lại file: concat demuxer bỏ `duration` của dòng cuối.

    `option framerate 90000` sau MỖI file là bắt buộc: concat lấy timebase của file đầu, mà
    PNG qua image2 có timebase 1/25 -> mọi mốc bị làm tròn về lưới 25fps (đo được: ở tốc độ
    1.5x miếng vá lệch khung trên toàn đoạn). `option` chỉ được phép khi safe=0 — sidecar xuất
    mở danh sách với `format_opts='safe=0'` (xem AppendLogoAiFilters)."""
    if not times:
        return
    step = (times[-1] - times[0]) / max(1, len(times) - 1) if len(times) > 1 else 1 / 30
    lines = ["ffconcat version 1.0"]
    i = 0
    n = len(times)
    while i < n:
        j = i
        while j + 1 < n and files[j + 1] == files[i]:
            j += 1
        t_next = times[j + 1] if j + 1 < n else times[j] + max(step, 1e-3)
        lines.append(f"file 'r{k}_{files[i]:06d}.png'")
        lines.append("option framerate 90000")
        lines.append(f"duration {max(1e-4, t_next - times[i]):.6f}")
        i = j + 1
    lines.append(f"file 'r{k}_{files[-1]:06d}.png'")
    lines.append("option framerate 90000")
    (out_dir / f"r{k}.ffconcat").write_text("\n".join(lines) + "\n", encoding="utf-8")


def process(payload: Dict[str, Any]) -> Dict[str, Any]:
    import cv2
    import numpy as np

    source = str(payload.get("source_path") or "")
    out_dir = Path(str(payload.get("out_dir") or ""))
    if not source or not Path(source).is_file():
        raise RuntimeError("Không tìm thấy nguồn để xoá vật thể.")
    if not str(out_dir):
        raise RuntimeError("Thiếu thư mục kết quả.")
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {**payload, "out_dir": str(out_dir)}
    still = bool(payload.get("still"))

    if os.environ.get("CRAB_LOGO_AI_FAKE") == "1":
        painter: Any = FakeInpainter()
    else:
        model_path = ensure_model(Path(str(payload.get("model_path") or "")),
                                  str(payload.get("model_url") or ""), str(payload.get("model_sha256") or ""))
        painter = LamaInpainter(model_path)

    stats = {"inferred": 0, "reused": 0, "propagated": 0, "telea": 0}
    t_begin = time.time()
    res = (process_still if still else process_video)(cv2, np, painter, payload, stats)
    index = {
        "version": INDEX_VERSION,
        "model": MODEL_NAME,
        "engine": ENGINE_NAME,
        "provider": painter.provider,
        "still": still,
        "width": res["W"],
        "height": res["H"],
        "start": res["start"],
        "end": res["end"],
        "times": res["times"],
        "rects": res["rects"],
        "stats": {**stats, "seconds": round(time.time() - t_begin, 2)},
    }
    tmp = out_dir / "index.json.tmp"
    tmp.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, out_dir / "index.json")
    emit_ratio(1.0)
    return index


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: logo_inpaint_sidecar.py input.json output.json", file=sys.stderr)
        return 2
    output_path = sys.argv[2]
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            payload = json.load(f)
        index = process(payload)
        write_output(output_path, {"status": "success", "index": index})
        return 0
    except Exception as exc:  # noqa: BLE001 — mọi lỗi phải về backend thành JSON
        write_output(output_path, {"status": "error", "detail": str(exc)})
        emit({"type": "error", "message": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
