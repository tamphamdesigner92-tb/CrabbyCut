#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>
"""XOÁ LOGO BẰNG AI — vẽ lại nền phía sau logo bằng mô hình inpainting MI-GAN.

Chế độ 'ai' của tab Retouch > Xoá logo. Khác ba chế độ kia (delogo/làm mờ/khảm là công thức
pixel chạy được ngay trong preview và trong FFmpeg), AI quá nặng để chạy theo từng khung lúc
xem/xuất, nên nó là MỘT LƯỢT XỬ LÝ TRƯỚC: sidecar này đọc đúng đoạn nguồn cần dùng, vẽ lại
vùng logo ở MỌI khung, và ghi ra các MIẾNG VÁ PNG nhỏ (chỉ cỡ vùng + viền mềm). Preview và
xuất cùng dán các miếng vá ấy -> hai bên thấy đúng một kết quả.

MÔ HÌNH: MI-GAN (Picsart AI Research, giấy phép MIT), bản ONNX "pipeline v2" nhận ảnh uint8
cỡ bất kỳ + mặt nạ, tự cắt quanh lỗ và chạy ở 512px. 28 MB, tải về ở lần đầu dùng.
Đo trên máy dev (CPU, onnxruntime 1.29): 0,27 s/khung/vùng; LaMa cho chất lượng tương đương
trên logo nhưng 1,07 s/khung và nặng 208 MB — với video (30 khung mỗi giây) thì MI-GAN là
lựa chọn duy nhất dùng được trên CPU.

MỐC THỜI GIAN — ĐIỀU QUAN TRỌNG NHẤT CỦA FILE NÀY:
  Miếng vá của khung A mà dán lên khung B (nền đã trôi đi) là lộ ngay một mảng lệch. Nên
  KHÔNG lấy mẫu lại theo fps cố định như retouch_track: đọc TỪNG khung thật của nguồn
  (`-fps_mode passthrough`) và ghi lại PTS thật của nó (`showinfo`). `times[i]` theo TRỤC
  XUẤT — trục mà `trim` của sidecar C++ nhìn thấy trên `[N:v]` (ffmpeg dời mốc về đầu file
  bằng start_time của container) — nên nguồn VFR (quay điện thoại) vẫn khớp từng khung.

CẢNH ĐỨNG YÊN: vẽ lại độc lập từng khung làm vùng nền tĩnh "sôi" lăn tăn (mỗi lượt GAN bịa
ra chi tiết hơi khác). Nên so VÀNH ngữ cảnh quanh vùng với khung đã vẽ gần nhất: gần như
không đổi -> DÙNG LẠI miếng vá cũ. Vừa hết nháy, vừa bỏ được phần lớn lượt suy luận trên
cảnh tĩnh (index ghi số lượt đã vẽ / đã dùng lại).

Vào (JSON): source_path, still, start, end (giây trục xuất), frame_w/frame_h (khung mà rects
tính theo), rects [{x,y,w,h}] (pixel), out_dir, model_path, model_url, model_sha256.
Ra: out_dir/index.json + r{k}_{n:06d}.png + r{k}.ffconcat, và JSON kết quả ở output_path.
"""
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
INDEX_VERSION = 1
MODEL_NAME = "migan-pipeline-v2"
MODEL_LABEL = "MI-GAN (Xoá logo AI)"
MODEL_DOWNLOAD_ID = "logo_ai:migan"

# Viền mềm của miếng vá (pixel, NGOÀI vùng): miếng vá mang cả dải ảnh gốc quanh vùng với
# alpha giảm dần về 0, để dán lên proxy LQ của preview không hằn thành một khung chữ nhật.
FEATHER_MIN = 4
FEATHER_MAX = 24
# Ngữ cảnh đưa vào mô hình quanh vùng, theo cạnh DÀI của vùng. Ít quá thì mô hình không đủ
# nền để đoán; nhiều quá thì pipeline (tự co về 512) làm lỗ bé lại và mất chi tiết.
CONTEXT_RATIO = 0.6
CONTEXT_MIN = 24
# Ngưỡng dùng lại miếng vá: sai khác trung bình (0..255) của VÀNH ngữ cảnh so với khung đã
# vẽ gần nhất. Nhiễu nén của nguồn đứng yên đo được ~0,6–1,2; chuyển động chậm nhất nhìn thấy
# được là > 3.
REUSE_MAD = 2.2
# Dùng lại liên tục quá lâu thì nền trôi chậm (máy quay lia rất chậm) tích dần thành lệch mà
# từng bước đều dưới ngưỡng -> buộc vẽ lại sau chừng này khung.
REUSE_MAX_RUN = 90


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
        raise RuntimeError("Thiếu model MI-GAN và không có địa chỉ tải.")
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
        raise RuntimeError(f"Không tải được model MI-GAN: {exc}") from exc
    return model_path


def open_session(model_path: Path):
    import onnxruntime as ort

    available = set(ort.get_available_providers())
    # GPU nếu bản onnxruntime đang cài có (CUDA / DirectML / CoreML), không thì CPU. Tạo
    # phiên với EP GPU có thể hỏng với mô hình hình dạng động -> rơi về CPU chứ không dừng.
    preferred = [p for p in ("CUDAExecutionProvider", "DmlExecutionProvider", "CoreMLExecutionProvider")
                 if p in available]
    so = ort.SessionOptions()
    so.log_severity_level = 3
    if preferred:
        try:
            sess = ort.InferenceSession(str(model_path), so, providers=[*preferred, "CPUExecutionProvider"])
            return sess, sess.get_providers()[0]
        except Exception:
            pass
    sess = ort.InferenceSession(str(model_path), so, providers=["CPUExecutionProvider"])
    return sess, "CPUExecutionProvider"


class Inpainter:
    def __init__(self, model_path: Path) -> None:
        import numpy as np

        self.np = np
        self.model_path = model_path
        self.sess, self.provider = open_session(model_path)

    def run(self, rgb, hole):
        """rgb: HxWx3 uint8, hole: HxW bool (True = vẽ lại). Trả HxWx3 uint8."""
        np = self.np
        image = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None])
        # Quy ước của pipeline MI-GAN: 255 = pixel ĐÃ BIẾT, 0 = lỗ.
        mask = np.where(hole, 0, 255).astype(np.uint8)[None, None]
        try:
            out = self.sess.run(None, {"image": image, "mask": mask})[0]
        except Exception:
            if self.provider == "CPUExecutionProvider":
                raise
            # EP GPU chết giữa chừng (hết VRAM, driver) -> làm tiếp bằng CPU.
            import onnxruntime as ort
            self.sess = ort.InferenceSession(str(self.model_path), providers=["CPUExecutionProvider"])
            self.provider = "CPUExecutionProvider"
            out = self.sess.run(None, {"image": image, "mask": mask})[0]
        return out[0].transpose(1, 2, 0)


class FakeInpainter:
    """CHỈ CHO TEST (CRAB_LOGO_AI_FAKE=1): lấp lỗ bằng màu TRUNG BÌNH của phần đã biết trong
    khung đó. Không cần tải model, mà vẫn chốt được điều quan trọng nhất của đường xuất: miếng
    vá của khung i phải rơi đúng vào khung i (nguồn đổi màu mỗi khung -> lệch một khung là lộ)."""

    provider = "fake"

    def run(self, rgb, hole):
        import numpy as np

        out = rgb.copy()
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


def plan_rects(raw_rects: List[Dict[str, Any]], frame_w: int, frame_h: int, W: int, H: int):
    """Quy vùng về pixel của khung GIẢI MÃ ĐƯỢC (thường trùng frame_w/frame_h; khác thì co
    theo tỉ lệ — ví dụ nguồn xoay mà frontend chưa biết cỡ sau xoay)."""
    kx = W / frame_w if frame_w > 0 else 1.0
    ky = H / frame_h if frame_h > 0 else 1.0
    plans = []
    for r in raw_rects[:4]:
        x = clamp(int(round(float(r.get("x", 0)) * kx)), 0, W - 2)
        y = clamp(int(round(float(r.get("y", 0)) * ky)), 0, H - 2)
        w = clamp(int(round(float(r.get("w", 0)) * kx)), 2, W - x)
        h = clamp(int(round(float(r.get("h", 0)) * ky)), 2, H - y)
        if w < 6 or h < 6:
            continue
        rect = {"x": x, "y": y, "w": w, "h": h}
        feather = clamp(int(round(min(w, h) * 0.15)), FEATHER_MIN, FEATHER_MAX)
        ctx_pad = max(CONTEXT_MIN, feather * 2, int(round(max(w, h) * CONTEXT_RATIO)))
        plans.append({
            "rect": rect,
            "box": expand(rect, feather, W, H),
            "ctx": expand(rect, ctx_pad, W, H),
            "feather": feather,
        })
    return plans


def feather_alpha(np, plan):
    """Alpha của miếng vá: 255 trong vùng, giảm TUYẾN TÍNH theo khoảng cách ra tới mép hộp."""
    box = plan["box"]
    rect = plan["rect"]
    f = max(1, plan["feather"])
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
    """Đọc TỪNG khung thật trong [start, end] (trục xuất), đã cắt về hộp `crop`, kèm PTS.

    `-copyts` + `-ss` (tua nhanh tới gần mốc) rồi `trim` theo trục THÔ = trục xuất +
    start_time của container: tua chỉ để khỏi giải mã từ đầu file, còn chọn khung là việc của
    `trim` trên PTS thật — không phụ thuộc độ chính xác của phép tua. `showinfo` in PTS của
    ĐÚNG các khung đi ra pipe, theo đúng thứ tự."""

    def __init__(self, path: str, start: float, end: float, fmt_start: float, crop: Dict[str, int],
                 untagged: bool = False) -> None:
        self.crop = crop
        raw0 = start + fmt_start
        raw1 = end + fmt_start
        seek = max(0.0, raw0 - 1.0)
        fix = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709," if untagged else ""
        vf = (f"{fix}trim=start={raw0:.6f}:end={raw1:.6f},"
              f"crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']},showinfo")
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
                if size and (int(size.group(1)), int(size.group(2))) != (self.crop["w"], self.crop["h"]):
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
        n = self.crop["w"] * self.crop["h"] * 3
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
                                   f"{self.crop['w']}x{self.crop['h']}.")
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


# ---------------------------------------------------------------------------------------
# XỬ LÝ
# ---------------------------------------------------------------------------------------

def ring_signature(np, cv2, ctx_rgb, plan):
    """Ảnh xám thu nhỏ của VÀNH ngữ cảnh (vùng logo bị tô 0) — thứ quyết định mô hình vẽ gì."""
    gray = cv2.cvtColor(ctx_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    c = plan["ctx"]
    r = plan["rect"]
    gray[r["y"] - c["y"]:r["y"] - c["y"] + r["h"], r["x"] - c["x"]:r["x"] - c["x"] + r["w"]] = 0
    scale = 64.0 / max(gray.shape)
    if scale < 1:
        gray = cv2.resize(gray, (max(4, int(gray.shape[1] * scale)), max(4, int(gray.shape[0] * scale))),
                          interpolation=cv2.INTER_AREA)
    return gray


def make_patch(np, frame_rgb, frame_alpha, offset: Tuple[int, int], plan, inpainted_ctx, alpha_mask):
    """Miếng vá RGBA cỡ `box`: ảnh gốc của khung + vùng logo thay bằng kết quả AI."""
    ox, oy = offset
    box, rect, ctx = plan["box"], plan["rect"], plan["ctx"]
    rgb = frame_rgb[box["y"] - oy:box["y"] - oy + box["h"], box["x"] - ox:box["x"] - ox + box["w"]].copy()
    ry, rx = rect["y"] - box["y"], rect["x"] - box["x"]
    cy, cx = rect["y"] - ctx["y"], rect["x"] - ctx["x"]
    rgb[ry:ry + rect["h"], rx:rx + rect["w"]] = inpainted_ctx[cy:cy + rect["h"], cx:cx + rect["w"]]
    a = alpha_mask
    if frame_alpha is not None:
        src_a = frame_alpha[box["y"] - oy:box["y"] - oy + box["h"], box["x"] - ox:box["x"] - ox + box["w"]]
        a = ((a.astype(np.uint16) * src_a.astype(np.uint16)) // 255).astype(np.uint8)
    return np.dstack([rgb, a])


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
        raise RuntimeError("Không tìm thấy nguồn để xoá logo.")
    if not str(out_dir):
        raise RuntimeError("Thiếu thư mục kết quả.")
    out_dir.mkdir(parents=True, exist_ok=True)
    still = bool(payload.get("still"))

    if os.environ.get("CRAB_LOGO_AI_FAKE") == "1":
        painter = FakeInpainter()
    else:
        model_path = ensure_model(Path(str(payload.get("model_path") or "")),
                                  str(payload.get("model_url") or ""), str(payload.get("model_sha256") or ""))
        painter = Inpainter(model_path)

    frame_w = int(payload.get("frame_w") or 0)
    frame_h = int(payload.get("frame_h") or 0)
    stats = {"inferred": 0, "reused": 0}
    t_begin = time.time()

    if still:
        rgb, alpha = read_still(source)
        H, W = rgb.shape[:2]
        plans = plan_rects(payload.get("rects") or [], frame_w or W, frame_h or H, W, H)
        if not plans:
            raise RuntimeError("Vùng logo quá nhỏ hoặc nằm ngoài ảnh.")
        rect_out = []
        for k, plan in enumerate(plans):
            c = plan["ctx"]
            crop = rgb[c["y"]:c["y"] + c["h"], c["x"]:c["x"] + c["w"]]
            hole = np.zeros(crop.shape[:2], bool)
            r = plan["rect"]
            hole[r["y"] - c["y"]:r["y"] - c["y"] + r["h"], r["x"] - c["x"]:r["x"] - c["x"] + r["w"]] = True
            painted = painter.run(np.ascontiguousarray(crop), hole)
            stats["inferred"] += 1
            write_png(cv2, out_dir / f"r{k}_{0:06d}.png",
                      make_patch(np, rgb, alpha, (0, 0), plan, painted, feather_alpha(np, plan)))
            rect_out.append({**plan["rect"], "box": plan["box"], "frames": [0]})
            emit_ratio((k + 1) / len(plans))
        times = [0.0]
    else:
        info = probe(source)
        W, H = info["width"], info["height"]
        if not (W > 0 and H > 0):
            raise RuntimeError("Không đọc được kích thước khung của nguồn.")
        plans = plan_rects(payload.get("rects") or [], frame_w or W, frame_h or H, W, H)
        if not plans:
            raise RuntimeError("Vùng logo quá nhỏ hoặc nằm ngoài khung.")
        start = max(0.0, float(payload.get("start") or 0.0))
        end = max(start + 0.05, float(payload.get("end") or 0.0))
        # Đọc MỘT hộp bao mọi ngữ cảnh: cắt ngay trong ffmpeg nên pipe chỉ chở phần cần.
        ux0 = min(p["ctx"]["x"] for p in plans)
        uy0 = min(p["ctx"]["y"] for p in plans)
        ux1 = max(p["ctx"]["x"] + p["ctx"]["w"] for p in plans)
        uy1 = max(p["ctx"]["y"] + p["ctx"]["h"] for p in plans)
        # CHẴN cả gốc lẫn cạnh: nguồn 4:2:0 thì `crop` lẻ bị ffmpeg tự làm tròn cạnh, và mỗi
        # khung đọc từ pipe lệch đi vài byte -> ảnh trượt dần và mất khung cuối (đã gặp).
        ux0 -= ux0 % 2
        uy0 -= uy0 % 2
        ux1 = min(W - W % 2, ux1 + ux1 % 2)
        uy1 = min(H - H % 2, uy1 + uy1 % 2)
        crop = {"x": ux0, "y": uy0, "w": ux1 - ux0, "h": uy1 - uy0}
        if any(p["ctx"]["x"] < ux0 or p["ctx"]["y"] < uy0 or p["ctx"]["x"] + p["ctx"]["w"] > ux1
               or p["ctx"]["y"] + p["ctx"]["h"] > uy1 for p in plans):
            # Khung lẻ cạnh: cột/hàng cuối rơi ra ngoài hộp chẵn -> co ngữ cảnh lại cho vừa.
            for p in plans:
                c = p["ctx"]
                x1 = min(c["x"] + c["w"], ux1)
                y1 = min(c["y"] + c["h"], uy1)
                c["x"], c["y"] = max(c["x"], ux0), max(c["y"], uy0)
                c["w"], c["h"] = x1 - c["x"], y1 - c["y"]
                for key in ("rect", "box"):
                    b = p[key]
                    bx1 = min(b["x"] + b["w"], ux1)
                    by1 = min(b["y"] + b["h"], uy1)
                    b["w"], b["h"] = bx1 - b["x"], by1 - b["y"]
        reader = FrameReader(source, start, end, info["format_start"], crop, info["untagged"])
        alphas = [feather_alpha(np, p) for p in plans]
        refs: List[Optional[Dict[str, Any]]] = [None] * len(plans)
        rect_frames: List[List[int]] = [[] for _ in plans]
        counters = [0] * len(plans)
        times: List[float] = []
        span = max(0.05, end - start)
        try:
            for t, buf in reader.frames():
                frame = np.frombuffer(buf, np.uint8).reshape(crop["h"], crop["w"], 3)
                for k, plan in enumerate(plans):
                    c = plan["ctx"]
                    ctx_rgb = frame[c["y"] - uy0:c["y"] - uy0 + c["h"], c["x"] - ux0:c["x"] - ux0 + c["w"]]
                    sig = ring_signature(np, cv2, ctx_rgb, plan)
                    ref = refs[k]
                    if (ref is not None and ref["run"] < REUSE_MAX_RUN
                            and float(np.mean(np.abs(sig - ref["sig"]))) < REUSE_MAD):
                        ref["run"] += 1
                        rect_frames[k].append(ref["file"])
                        stats["reused"] += 1
                        continue
                    hole = np.zeros(ctx_rgb.shape[:2], bool)
                    r = plan["rect"]
                    hole[r["y"] - c["y"]:r["y"] - c["y"] + r["h"], r["x"] - c["x"]:r["x"] - c["x"] + r["w"]] = True
                    painted = painter.run(np.ascontiguousarray(ctx_rgb), hole)
                    stats["inferred"] += 1
                    n = counters[k]
                    counters[k] += 1
                    write_png(cv2, out_dir / f"r{k}_{n:06d}.png",
                              make_patch(np, frame, None, (ux0, uy0), plan, painted, alphas[k]))
                    refs[k] = {"sig": sig, "file": n, "run": 0}
                    rect_frames[k].append(n)
                times.append(round(t, 6))
                emit_ratio((t - start) / span)
        finally:
            code = reader.close()
        if not times:
            detail = " | ".join(reader.err_tail[-3:])
            raise RuntimeError(f"Không đọc được khung nào trong đoạn nguồn (mã {code}). {detail}".strip())
        rect_out = []
        for k, plan in enumerate(plans):
            write_ffconcat(out_dir, k, times, rect_frames[k])
            rect_out.append({**plan["rect"], "box": plan["box"], "frames": rect_frames[k]})

    index = {
        "version": INDEX_VERSION,
        "model": MODEL_NAME,
        "provider": painter.provider,
        "still": still,
        "width": W,
        "height": H,
        "start": 0.0 if still else start,
        "end": 0.0 if still else end,
        "times": times,
        "rects": rect_out,
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
