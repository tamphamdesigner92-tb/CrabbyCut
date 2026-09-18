#!/usr/bin/env python3
import json
import math
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


PROJECT_ROOT = Path(__file__).resolve().parents[1]
AUTO_REFRAME_VERSION = 3
RETOUCH_TRACK_VERSION = 1
CAMERA_CUT_VERSION = 1
POSE_TRACK_VERSION = 1

# Chế độ pose_track (chỉ dùng cho "Chế độ Nhà phát triển" -> overlay Skeleton): lấy mẫu
# frame theo fps và xuất TOÀN BỘ 33 landmark BlazePose (khớp toàn thân + điểm mặt cơ bản
# nose/mắt/tai/miệng) dưới dạng chuẩn hoá 0..1; kèm face mesh chi tiết nếu FaceMesh nạp được.
POSE_TRACK_DEFAULTS = {
    "fps": 10.0,          # số mẫu/giây dọc theo clip
    "max_frames": 900,    # trần số frame mỗi clip (an toàn thời lượng dài)
    "include_face_mesh": True,
    "min_visibility": 0.30,  # ngưỡng visibility để coi landmark là "thấy được"
}

# Chế độ retouch_track: landmark mặt ở MỌI frame, làm nền cho tính năng Retouch.
# fps = 0 nghĩa là "theo fps thật của nguồn" (FrameStream sẽ nhận fps do backend truyền).
RETOUCH_DEFAULTS = {
    "fps": 30.0,
    # Cỡ ảnh đưa vào FaceMesh. Nó nội bộ chạy ở 192x192 nên >384 gần như không thêm độ
    # chính xác, mà băng thông pipe thì tỉ lệ với số pixel. Landmark chuẩn hoá 0..1 nên
    # map ngược về kích thước gốc không mất gì.
    "detect_width": 384,
    "max_frames": 20000,
    "max_faces": 4,
    # Hệ số EMA hai chiều khi làm mượt landmark theo thời gian (0 = tắt).
    "smooth_alpha": 0.45,
}

# ẢNH TĨNH: nguồn chỉ có MỘT khung, không có trục thời gian. Nhận diện theo đuôi file ở
# ĐÂY (nơi mở file) chứ không nhận cờ từ payload — thêm một cờ là thêm một chỗ để hai bên
# nói khác nhau. Backend đã có danh sách riêng của nó để quyết định CÓ CHO PHÉP hay không;
# đó là câu hỏi khác (an toàn), không phải câu hỏi này (đọc kiểu gì).
RETOUCH_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def is_still_image_source(path: str) -> bool:
    return Path(str(path or "")).suffix.lower() in RETOUCH_IMAGE_SUFFIXES

# Mặc định cho chế độ dò điểm đổi góc máy (detect_cuts).
# Chiến lược (v2): cắt cứng/đổi góc máy = GIÁN ĐOẠN THỜI GIAN (một frame nhảy đột ngột),
# KHÁC với chuyển động camera mượt (đổi đều theo nhiều frame). Vì vậy:
#  - Ứng viên = ĐỈNH NỔI BẬT của scene_score so với nền cục bộ (bắt được cả cắt CÙNG bối
#    cảnh — vd quay lại nhiều lần cùng vị trí — nơi scene_score tuyệt đối vẫn thấp).
#  - Xác minh = chênh lệch khung qua ranh giới cắt >> chuyển động 2 bên (prominence),
#    KHÔNG còn phụ thuộc "hậu cảnh phải đổi" (đổi góc cùng bối cảnh vẫn được nhận).
#  - min_segment chống cắt vụn: block con sau tách không ngắn hơn ngưỡng này.
CAMERA_CUT_DEFAULTS = {
    # --- Ứng viên từ scene_score (lavfi) ---
    "scene_floor": 0.06,          # sàn tuyệt đối 1 frame được xét là ứng viên (thấp -> bắt cắt cùng bối cảnh)
    "scene_prominence": 3.0,      # đỉnh phải >= trung vị nền cục bộ * bội số này
    "peak_baseline_window": 0.5,  # nửa cửa sổ (giây) lấy nền cục bộ quanh đỉnh
    "edge_guard": 0.25,           # không nhận cắt sát mép block (giây)
    "merge_window": 0.40,         # gộp đỉnh gần nhau (giây), giữ đỉnh mạnh nhất
    "max_cuts": 20,               # trần ứng viên/block trước khi lọc min-segment
    # --- Xác minh gián đoạn thời gian ---
    "verify_step": 0.045,         # bước lấy mẫu quanh điểm cắt (giây) ~ 1-1.5 frame @30fps
    "cut_abs_min": 6.0,           # chênh xám tuyệt đối tối thiểu (0-255) qua ranh giới cắt
    "cut_prominence": 2.2,        # chênh qua ranh giới >= chuyển động 2 bên * bội số này
    # --- Chống cắt vụn ---
    "min_segment": 3.0,           # độ dài tối thiểu mỗi block con sau khi tách (giây)
    # --- Khoá cũ (giữ để tương thích payload/tùy chọn cũ; không còn dùng trong logic v2) ---
    "scene_threshold": 0.30,
    "verify_delta": 0.18,
    "bg_diff_threshold": 10.0,
    "min_background_ratio": 0.12,
}


def emit_progress(message: str) -> None:
    print(json.dumps({"type": "progress", "message": message}, ensure_ascii=False), flush=True)


def json_safe(value: Any) -> Any:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): json_safe(nested) for key, nested in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


def write_output(path: str, payload: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(json_safe(payload), f, ensure_ascii=False, allow_nan=False)


def load_payload(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def finite_number(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) else fallback


def parse_rotation_degrees(value: Any) -> Optional[float]:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def render_dimensions(coded_width: Optional[int], coded_height: Optional[int], rotation: Optional[float]) -> Dict[str, Optional[int]]:
    if not coded_width or not coded_height:
        return {"width": coded_width, "height": coded_height}
    rounded = int(round(rotation or 0.0)) % 360
    if rounded in (90, 270):
        return {"width": coded_height, "height": coded_width}
    return {"width": coded_width, "height": coded_height}


def ffprobe_video_size(video_path: str) -> Dict[str, Any]:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height:stream_tags=rotate:stream_side_data=rotation",
                "-of",
                "json",
                video_path,
            ],
            cwd=str(PROJECT_ROOT),
            text=True,
            capture_output=True,
            timeout=5,
            check=True,
        )
        stream = (json.loads(result.stdout or "{}").get("streams") or [{}])[0]
        coded_width = int(stream.get("width") or 0)
        coded_height = int(stream.get("height") or 0)
        rotation = parse_rotation_degrees((stream.get("tags") or {}).get("rotate"))
        if rotation is None:
            for side_data in stream.get("side_data_list") or []:
                rotation = parse_rotation_degrees(side_data.get("rotation"))
                if rotation is not None:
                    break
        display = render_dimensions(
            coded_width if coded_width > 0 else None,
            coded_height if coded_height > 0 else None,
            rotation,
        )
        return {
            "width": display["width"],
            "height": display["height"],
            "render_width": display["width"],
            "render_height": display["height"],
            "coded_width": coded_width if coded_width > 0 else None,
            "coded_height": coded_height if coded_height > 0 else None,
            "rotation": rotation if rotation is not None else 0.0,
        }
    except Exception:
        return {
            "width": None,
            "height": None,
            "render_width": None,
            "render_height": None,
            "coded_width": None,
            "coded_height": None,
            "rotation": 0.0,
        }


def clamp(value: float, min_value: float, max_value: float) -> float:
    return max(min_value, min(max_value, value))


def _dedupe_times(raw: List[float], lo: float, hi: float) -> List[float]:
    times: List[float] = []
    for value in raw:
        clipped = max(lo, min(hi, value))
        if all(abs(clipped - existing) > 0.05 for existing in times):
            times.append(clipped)
    return times


def unique_candidate_times(start: float, end: float) -> List[float]:
    duration = max(0.0, end - start)
    end_guard = max(start, end - 0.05)
    raw = [start]
    if duration > 0.35:
        raw.append(min(end_guard, start + 1.0))
    if duration > 0.15:
        raw.append(start + (duration * 0.5))
    return _dedupe_times(raw, 0.0, end_guard) or [max(0.0, start)]


# Mốc lấy mẫu KHUNG ĐẦU block: đúng frame đầu trước, không thấy người thì nhích vào
# một chút (vẫn thuộc nửa đầu block) rồi mới tới giữa block.
def head_candidate_times(start: float, end: float) -> List[float]:
    duration = max(0.0, end - start)
    end_guard = max(start, end - 0.05)
    raw = [start]
    if duration > 0.3:
        raw.append(start + min(0.5, duration * 0.15))
    if duration > 0.6:
        raw.append(start + (duration * 0.35))
    return _dedupe_times(raw, 0.0, end_guard) or [max(0.0, start)]


# Mốc lấy mẫu KHUNG CUỐI block: lùi 0.05s khỏi mép (frame cuối thường đã sang clip sau
# do sai số làm tròn), không thấy người thì lùi thêm về phía giữa block.
def tail_candidate_times(start: float, end: float) -> List[float]:
    duration = max(0.0, end - start)
    last = max(start, end - 0.05)
    raw = [last]
    if duration > 0.3:
        raw.append(last - min(0.5, duration * 0.15))
    if duration > 0.6:
        raw.append(last - (duration * 0.35))
    return _dedupe_times(raw, 0.0, last) or [last]


class PersonDetector:
    def __init__(self) -> None:
        self.cv2 = None
        self.mp = None
        self.pose = None
        self.face_detection = None
        self.face_cascade = None
        self.face_mesh = None            # nạp lười trong pose_track (ensure_face_mesh)
        self._face_mesh_failed = False
        self.np = None
        self.import_errors: Dict[str, str] = {}

        try:
            import cv2  # type: ignore

            self.cv2 = cv2
        except Exception as exc:
            self.import_errors["cv2"] = str(exc)

        try:
            import numpy as np  # type: ignore

            self.np = np
        except Exception as exc:
            self.import_errors["numpy"] = str(exc)

        try:
            import mediapipe as mp  # type: ignore

            self.mp = mp
        except Exception as exc:
            self.import_errors["mediapipe"] = str(exc)

        if self.cv2 is not None and self.mp is not None:
            try:
                self.pose = self.mp.solutions.pose.Pose(
                    static_image_mode=True,
                    model_complexity=1,
                    enable_segmentation=False,
                    min_detection_confidence=0.45,
                )
                self.face_detection = self.mp.solutions.face_detection.FaceDetection(
                    model_selection=1,
                    min_detection_confidence=0.45,
                )
            except Exception as exc:
                self.import_errors["mediapipe_runtime"] = str(exc)
                self.pose = None
                self.face_detection = None

        if self.cv2 is not None:
            try:
                cascade_path = str(Path(self.cv2.data.haarcascades) / "haarcascade_frontalface_default.xml")
                cascade = self.cv2.CascadeClassifier(cascade_path)
                if not cascade.empty():
                    self.face_cascade = cascade
            except Exception as exc:
                self.import_errors["opencv_haar"] = str(exc)

    def ready(self) -> bool:
        return self.cv2 is not None and (
            self.pose is not None or self.face_detection is not None or self.face_cascade is not None
        )

    def close(self) -> None:
        for resource in (self.pose, self.face_detection, getattr(self, "face_mesh", None),
                         getattr(self, "_face_mesh_multi", None)):
            try:
                if resource is not None:
                    resource.close()
            except Exception:
                pass

    def capture_frame(self, video_path: str, seconds: float) -> Optional[Any]:
        if self.cv2 is None:
            return None
        if self.np is not None:
            try:
                result = subprocess.run(
                    [
                        "ffmpeg",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-ss",
                        f"{max(0.0, seconds):.6f}",
                        "-i",
                        video_path,
                        "-frames:v",
                        "1",
                        "-f",
                        "image2pipe",
                        "-vcodec",
                        "png",
                        "-",
                    ],
                    cwd=str(PROJECT_ROOT),
                    capture_output=True,
                    timeout=15,
                    check=True,
                )
                if result.stdout:
                    encoded = self.np.frombuffer(result.stdout, dtype=self.np.uint8)
                    frame = self.cv2.imdecode(encoded, self.cv2.IMREAD_COLOR)
                    if frame is not None:
                        return frame
            except Exception as exc:
                self.import_errors.setdefault("ffmpeg_capture", str(exc))

        capture = self.cv2.VideoCapture(video_path)
        try:
            capture.set(self.cv2.CAP_PROP_POS_MSEC, max(0.0, seconds) * 1000.0)
            ok, frame = capture.read()
            if ok and frame is not None:
                return frame
            return None
        finally:
            capture.release()

    def detect(self, frame: Any) -> Optional[Dict[str, Any]]:
        if frame is None or self.cv2 is None:
            return None
        height, width = frame.shape[:2]
        detections: List[Dict[str, Any]] = []
        if self.pose is not None or self.face_detection is not None:
            detections.append(self.detect_mediapipe(frame, width, height))
        if self.face_cascade is not None:
            detections.append(self.detect_opencv_face(frame, width, height))
        detections = [item for item in detections if item and item.get("detected")]
        if not detections:
            return None
        detections.sort(key=lambda item: (item.get("score") or 0.0, 1 if item.get("face_height") else 0), reverse=True)
        return detections[0]

    def detect_mediapipe(self, frame: Any, width: int, height: int) -> Dict[str, Any]:
        rgb = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2RGB)
        body_center_x: Optional[float] = None
        body_center_y: Optional[float] = None
        body_height: Optional[float] = None
        body_box: Optional[Dict[str, float]] = None
        face_center_y: Optional[float] = None
        face_height: Optional[float] = None
        face_center_x: Optional[float] = None
        detection_confidence = "none"
        score = 0.0

        if self.pose is not None:
            pose_result = self.pose.process(rgb)
            landmarks = getattr(getattr(pose_result, "pose_landmarks", None), "landmark", None)
            if landmarks:
                body_indices = [11, 12, 13, 14, 23, 24]
                body_points = [
                    (landmarks[idx].x * width, landmarks[idx].y * height, landmarks[idx].visibility)
                    for idx in body_indices
                    if idx < len(landmarks) and landmarks[idx].visibility >= 0.30
                ]
                if body_points:
                    total_weight = sum(max(0.1, point[2]) for point in body_points)
                    body_center_x = sum(point[0] * max(0.1, point[2]) for point in body_points) / max(0.1, total_weight)
                    body_center_y = sum(point[1] * max(0.1, point[2]) for point in body_points) / max(0.1, total_weight)
                    xs = [point[0] for point in body_points]
                    ys = [point[1] for point in body_points]
                    body_box = {
                        "x_min": max(0.0, min(xs)),
                        "y_min": max(0.0, min(ys)),
                        "x_max": min(float(width), max(xs)),
                        "y_max": min(float(height), max(ys)),
                    }
                    body_height = max(1.0, body_box["y_max"] - body_box["y_min"])
                    detection_confidence = "pose_body"
                    score += 0.45

                face_indices = [0, 2, 5, 7, 8, 9, 10]
                face_points = [
                    (landmarks[idx].x * width, landmarks[idx].y * height)
                    for idx in face_indices
                    if idx < len(landmarks) and landmarks[idx].visibility >= 0.25
                ]
                if len(face_points) >= 3:
                    xs = [point[0] for point in face_points]
                    ys = [point[1] for point in face_points]
                    face_center_x = sum(xs) / len(xs)
                    face_center_y = sum(ys) / len(ys)
                    face_height = max(18.0, (max(ys) - min(ys)) * 2.7, (max(xs) - min(xs)) * 1.9)
                    score += 0.25

        if self.face_detection is not None:
            face_result = self.face_detection.process(rgb)
            faces = getattr(face_result, "detections", None) or []
            best_face = None
            best_area = 0.0
            for detection in faces:
                bbox = detection.location_data.relative_bounding_box
                x = clamp(bbox.xmin, 0.0, 1.0)
                y = clamp(bbox.ymin, 0.0, 1.0)
                w = clamp(bbox.width, 0.0, 1.0)
                h = clamp(bbox.height, 0.0, 1.0)
                area = w * h
                if area > best_area:
                    best_area = area
                    best_face = (x, y, w, h, detection.score[0] if detection.score else 0.0)
            if best_face:
                x, y, w, h, face_score = best_face
                face_center_x = (x + w / 2.0) * width
                face_center_y = (y + h / 2.0) * height
                face_height = max(1.0, h * height)
                if body_center_x is None:
                    body_center_x = face_center_x
                if detection_confidence == "none":
                    detection_confidence = "face_only"
                score += 0.35 + max(0.0, min(0.2, face_score * 0.2))

        if body_center_x is None and face_center_x is not None:
            body_center_x = face_center_x
        if detection_confidence == "none" and face_center_x is not None:
            detection_confidence = "face_only"

        return {
            "detected": body_center_x is not None or face_center_y is not None,
            "detector": "mediapipe",
            "body_center_x": body_center_x,
            "body_center_y": body_center_y,
            "body_height": body_height,
            "body_box": body_box,
            "face_center_x": face_center_x,
            "face_center_y": face_center_y,
            "face_height": face_height,
            "detection_confidence": detection_confidence,
            "score": score,
        }

    def detect_opencv_face(self, frame: Any, width: int, height: int) -> Dict[str, Any]:
        gray = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2GRAY)
        faces = self.face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=4,
            minSize=(max(24, width // 30), max(24, height // 30)),
        )
        if len(faces) == 0:
            return {"detected": False, "detector": "opencv_haar", "score": 0.0}
        x, y, w, h = max(faces, key=lambda rect: rect[2] * rect[3])
        return {
            "detected": True,
            "detector": "opencv_haar",
            "body_center_x": float(x + w / 2.0),
            "body_center_y": None,
            "body_height": None,
            "body_box": None,
            "face_center_x": float(x + w / 2.0),
            "face_center_y": float(y + h / 2.0),
            "face_height": float(h),
            "detection_confidence": "face_only",
            "score": 0.45,
        }

    # ---- POSE TRACK (overlay Skeleton, chế độ Nhà phát triển) --------------------------
    def ensure_face_mesh(self) -> Any:
        # Nạp FaceMesh khi cần (không bắt buộc — thiếu thì vẫn có pose + điểm mặt cơ bản).
        if getattr(self, "face_mesh", None) is not None:
            return self.face_mesh
        if getattr(self, "_face_mesh_failed", False) or self.mp is None:
            return None
        try:
            self.face_mesh = self.mp.solutions.face_mesh.FaceMesh(
                static_image_mode=True,
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=0.4,
            )
        except Exception as exc:
            self._face_mesh_failed = True
            self.import_errors.setdefault("face_mesh", str(exc))
            self.face_mesh = None
        return self.face_mesh

    def ensure_face_mesh_multi(self, max_faces: int) -> Any:
        """FaceMesh riêng cho Retouch: NHIỀU mặt + chế độ VIDEO.

        KHÁC `ensure_face_mesh` (dùng cho skeleton overlay) ở hai điểm bắt buộc:
          - `max_num_faces = max_faces`: ô chọn "Single person / nhiều người" cần nhiều mặt.
          - `static_image_mode=False`: chế độ VIDEO cho MediaPipe theo vết mặt giữa các
            frame -> vừa nhanh hơn nhiều (không dò lại từ đầu mỗi frame) vừa đỡ rung.
            Chỉ đúng khi frame được đưa vào THEO THỨ TỰ THỜI GIAN — FrameStream bảo đảm
            điều đó; đừng dùng instance này cho việc lấy mẫu nhảy cóc.
        """
        cached = getattr(self, "_face_mesh_multi", None)
        if cached is not None and getattr(self, "_face_mesh_multi_n", 0) >= max_faces:
            return cached
        if self.mp is None:
            return None
        try:
            mesh = self.mp.solutions.face_mesh.FaceMesh(
                static_image_mode=False,
                max_num_faces=max(1, int(max_faces)),
                refine_landmarks=True,
                min_detection_confidence=0.4,
                min_tracking_confidence=0.4,
            )
        except Exception as exc:
            self.import_errors.setdefault("face_mesh_multi", str(exc))
            return None
        self._face_mesh_multi = mesh
        self._face_mesh_multi_n = max(1, int(max_faces))
        return mesh

    def face_landmarks_multi(self, rgb_frame: Any, max_faces: int = 4) -> Optional[List[List[List[float]]]]:
        """Trả về [[ [x,y], ... ] * 478 ] cho TỪNG mặt, chuẩn hoá 0..1. None nếu không thấy.

        Ảnh vào đã là RGB (FrameStream xuất rgb24) -> KHÔNG cvtColor lần nữa.
        Đây là lỗi rất dễ mắc: đưa BGR vào MediaPipe thì nó vẫn ra landmark, chỉ kém
        chính xác một cách âm thầm.
        """
        mesh = self.ensure_face_mesh_multi(max_faces)
        if mesh is None or rgb_frame is None:
            return None
        try:
            result = mesh.process(rgb_frame)
        except Exception as exc:
            self.import_errors.setdefault("face_mesh_multi_process", str(exc))
            return None
        faces = getattr(result, "multi_face_landmarks", None) or []
        if not faces:
            return None
        return [[[round(float(lm.x), 5), round(float(lm.y), 5)] for lm in f.landmark] for f in faces]

    def ensure_face_mesh_still(self, max_faces: int) -> Any:
        """FaceMesh cho ẢNH TĨNH: nhiều mặt + `static_image_mode=True`.

        PHẢI LÀ INSTANCE RIÊNG, không dùng lại `_face_mesh_multi`. Hai lý do, cả hai đều
        đủ để hỏng:
          - `_face_mesh_multi` chạy chế độ VIDEO: nó THEO VẾT mặt giữa các lần gọi. Đưa
            một ảnh rời vào giữa chừng là vừa nhận diện kém (không có vết để bám) vừa
            LÀM BẨN trạng thái theo vết của clip video đang xử lý cùng lượt.
          - Ảnh tĩnh chỉ có một lần dò duy nhất nên phải dò ĐẦY ĐỦ, không có frame sau để
            sửa sai; `static_image_mode=True` chính là chế độ đó.
        """
        cached = getattr(self, "_face_mesh_still", None)
        if cached is not None and getattr(self, "_face_mesh_still_n", 0) >= max_faces:
            return cached
        if self.mp is None:
            return None
        try:
            mesh = self.mp.solutions.face_mesh.FaceMesh(
                static_image_mode=True,
                max_num_faces=max(1, int(max_faces)),
                refine_landmarks=True,
                min_detection_confidence=0.4,
            )
        except Exception as exc:
            self.import_errors.setdefault("face_mesh_still", str(exc))
            return None
        self._face_mesh_still = mesh
        self._face_mesh_still_n = max(1, int(max_faces))
        return mesh

    def face_landmarks_still(self, rgb_frame: Any, max_faces: int = 4) -> Optional[List[List[List[float]]]]:
        """Như `face_landmarks_multi` nhưng dùng bộ dò chế độ ẢNH. Ảnh vào đã là RGB."""
        mesh = self.ensure_face_mesh_still(max_faces)
        if mesh is None or rgb_frame is None:
            return None
        try:
            result = mesh.process(rgb_frame)
        except Exception as exc:
            self.import_errors.setdefault("face_mesh_still_process", str(exc))
            return None
        faces = getattr(result, "multi_face_landmarks", None) or []
        if not faces:
            return None
        return [[[round(float(lm.x), 5), round(float(lm.y), 5)] for lm in f.landmark] for f in faces]

    def track_landmarks(self, frame: Any, include_face_mesh: bool = True) -> Dict[str, Any]:
        # Trả về landmark CHUẨN HOÁ 0..1 (theo khung hình), KHÔNG nhân width/height, để
        # frontend tự map sang toạ độ hiển thị. pose = [[x,y,visibility]*33]; face = mesh
        # chi tiết nếu có. Rỗng (None) nếu không thấy người ở frame đó.
        if frame is None or self.cv2 is None:
            return {"pose": None, "face": None}
        rgb = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2RGB)
        pose_out: Optional[List[List[float]]] = None
        face_out: Optional[List[List[float]]] = None

        if self.pose is not None:
            try:
                result = self.pose.process(rgb)
                landmarks = getattr(getattr(result, "pose_landmarks", None), "landmark", None)
                if landmarks:
                    pose_out = [
                        [
                            round(float(lm.x), 4),
                            round(float(lm.y), 4),
                            round(float(getattr(lm, "visibility", 1.0)), 3),
                        ]
                        for lm in landmarks
                    ]
            except Exception as exc:
                self.import_errors.setdefault("pose_track", str(exc))

        if include_face_mesh:
            mesh = self.ensure_face_mesh()
            if mesh is not None:
                try:
                    fm = mesh.process(rgb)
                    faces = getattr(fm, "multi_face_landmarks", None) or []
                    if faces:
                        face_out = [
                            [round(float(lm.x), 4), round(float(lm.y), 4)]
                            for lm in faces[0].landmark
                        ]
                except Exception as exc:
                    self.import_errors.setdefault("face_mesh_process", str(exc))

        return {"pose": pose_out, "face": face_out}


class FrameStream:
    """Đọc frame TUẦN TỰ từ MỘT tiến trình ffmpeg (rawvideo qua pipe).

    VÌ SAO CẦN: `PersonDetector.capture_frame()` spawn MỘT ffmpeg cho MỖI frame
    (seek + giải mã PNG). Đo trên máy dev: **123 ms/frame** — chấp nhận được khi chỉ
    lấy vài mốc (Auto-Reframe lấy khung đầu/cuối), nhưng Retouch cần landmark ở MỌI
    frame: video 5 phút @30fps = 9000 frame = **18,5 phút** chỉ để trích ảnh.
    Đọc tuần tự qua một pipe rawvideo: **1,2 ms/frame** -> 9000 frame còn **11 giây**.
    Nhanh hơn ~100 lần, đo bằng chính đoạn mã này.

    HẠ CỠ NGAY TRONG FFMPEG (`scale`), không hạ ở Python: MediaPipe FaceMesh nội bộ
    chạy ở 192x192 nên đưa ảnh lớn hơn ~384px không thêm độ chính xác, mà băng thông
    pipe thì tỉ lệ với số pixel. Landmark trả về đã CHUẨN HOÁ 0..1 nên map ngược về
    kích thước gốc được, không mất gì.

    KHÔNG dùng `-ss` cho từng frame: seek lại là mất hết cái lợi. Seek MỘT lần tới
    `start` rồi đọc thẳng.
    """

    def __init__(self, video_path: str, start: float, end: float, fps: float, width: int) -> None:
        self.video_path = str(video_path)
        self.width = max(64, int(width))
        self.fps = max(0.1, float(fps))
        self.start = max(0.0, float(start))
        self.duration = max(0.0, float(end) - self.start)
        self.height = 0
        self.proc: Optional[Any] = None
        self._frame_bytes = 0

    def open(self, probe_height_for: Optional[Dict[str, Any]] = None) -> bool:
        # Chiều cao suy từ tỉ lệ nguồn; ffmpeg tự làm tròn về số CHẴN (-2).
        src = probe_height_for or {}
        sw = finite_number(src.get("width"), 0.0)
        sh = finite_number(src.get("height"), 0.0)
        if sw > 0 and sh > 0:
            self.height = max(2, int(round(self.width * sh / sw / 2)) * 2)
        else:
            self.height = max(2, int(round(self.width * 16 / 9 / 2)) * 2)
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-ss", f"{self.start:.6f}",
            "-i", self.video_path,
            "-t", f"{max(0.05, self.duration):.6f}",
            # fps trước scale: bỏ frame thừa TRƯỚC khi tốn công co giãn.
            "-vf", f"fps={self.fps},scale={self.width}:{self.height}",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ]
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                         cwd=str(PROJECT_ROOT))
        except Exception:
            self.proc = None
            return False
        self._frame_bytes = self.width * self.height * 3
        return True

    def frames(self):
        """Sinh (index, mảng RGB HxWx3). Người gọi tự quy index -> giây."""
        if self.proc is None or self.proc.stdout is None:
            return
        index = 0
        while True:
            buf = self.proc.stdout.read(self._frame_bytes)
            if not buf or len(buf) < self._frame_bytes:
                break
            yield index, buf
            index += 1

    def close(self) -> None:
        if self.proc is None:
            return
        try:
            if self.proc.stdout:
                self.proc.stdout.close()
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.proc = None



def read_still_rgb(image_path: str, width: int, source_size: Dict[str, Any]) -> Optional[Any]:
    """Đọc MỘT khung RGB từ ảnh tĩnh, đã hạ cỡ về `width` — đối xứng với FrameStream.

    Đi qua ffmpeg (không qua PIL/cv2) vì đó là thứ dự án chắc chắn có, và vì phép hạ cỡ
    phải CÙNG bộ lọc với đường video: landmark chuẩn hoá 0..1 nên khác bộ lọc chỉ lệch
    dưới một pixel, nhưng dùng chung thì khỏi phải nghĩ.
    """
    sw = finite_number(source_size.get("width"), 0.0)
    sh = finite_number(source_size.get("height"), 0.0)
    if sw > 0 and sh > 0:
        height = max(2, int(round(width * sh / sw / 2)) * 2)
    else:
        height = max(2, int(round(width * 16 / 9 / 2)) * 2)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", str(image_path),
        "-frames:v", "1",
        "-vf", f"scale={width}:{height}",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(PROJECT_ROOT), stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=30)
    except Exception:
        return None
    need = width * height * 3
    if proc.returncode != 0 or len(proc.stdout) < need:
        return None
    return (proc.stdout[:need], width, height)


def track_retouch_still(
    detector: PersonDetector,
    image_path: str,
    clip: Dict[str, Any],
    source_size: Dict[str, Any],
    options: Dict[str, Any],
) -> Dict[str, Any]:
    """Landmark cho ẢNH TĨNH: đúng MỘT khung, giữ nguyên hình dạng kết quả của video.

    Trả về cùng bộ trường như `track_retouch_clip` (`fps`, `frame_count`, `frames`) để
    frontend không phải rẽ nhánh khi đọc — nó chỉ cần kẹp chỉ số khung về 0 (`still`).
    KHÔNG làm mượt: `smooth_face_series` là phép theo THỜI GIAN, với một khung thì nó
    không có gì để trung bình, gọi vào chỉ thêm một đường mã để sai.
    """
    index = clip.get("index")
    start = finite_number(clip.get("start"), 0.0)
    end = finite_number(clip.get("end"), 0.0)
    fps = clamp(finite_number(options.get("fps"), RETOUCH_DEFAULTS["fps"]), 1.0, 60.0)
    width = int(clamp(finite_number(options.get("detect_width"), RETOUCH_DEFAULTS["detect_width"]), 128, 1024))
    max_faces = int(clamp(finite_number(options.get("max_faces"), RETOUCH_DEFAULTS["max_faces"]), 1, 8))

    base = {"index": index, "start": start, "end": end, "fps": fps, "still": True}
    read = read_still_rgb(image_path, width, source_size)
    if read is None:
        return {**base, "frame_count": 0, "detected_frames": 0, "frames": [],
                "error": "không đọc được ảnh"}
    buf, w, h = read
    faces: Optional[List[List[List[float]]]] = None
    np = detector.np
    if np is not None and detector.mp is not None:
        arr = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3)
        faces = detector.face_landmarks_still(arr, max_faces)
    return {
        **base,
        "frame_count": 1,
        "detected_frames": 1 if faces else 0,
        "frames": [faces],
    }


def track_retouch_clip(
    detector: PersonDetector,
    video_path: str,
    clip: Dict[str, Any],
    source_size: Dict[str, Any],
    options: Dict[str, Any],
) -> Dict[str, Any]:
    """Landmark mặt ở MỌI frame của một clip — dữ liệu nền cho Retouch.

    KHÁC `track_clip` (chế độ pose_track) ở ba điểm, và cả ba đều bắt buộc với Retouch:
      1. Đọc qua `FrameStream` (một pipe) thay vì một ffmpeg mỗi frame — xem FrameStream.
      2. Lấy mẫu ở fps THẬT của clip, không phải 10fps: retouch bám mặt từng frame, hụt
         frame là mặt "nhảy".
      3. Có LÀM MƯỢT theo thời gian (xem smooth_face_series) — MediaPipe chạy từng frame
         độc lập nên landmark rung nhẹ; rung đó vào phép biến dạng hình học là thấy rõ.
    """
    index = clip.get("index")
    start = finite_number(clip.get("start"), 0.0)
    end = finite_number(clip.get("end"), 0.0)
    fps = clamp(finite_number(options.get("fps"), RETOUCH_DEFAULTS["fps"]), 1.0, 60.0)
    width = int(clamp(finite_number(options.get("detect_width"), RETOUCH_DEFAULTS["detect_width"]), 128, 1024))
    max_frames = int(clamp(finite_number(options.get("max_frames"), RETOUCH_DEFAULTS["max_frames"]), 1, 200000))
    max_faces = int(clamp(finite_number(options.get("max_faces"), RETOUCH_DEFAULTS["max_faces"]), 1, 8))

    stream = FrameStream(video_path, start, end, fps, width)
    if not stream.open(source_size):
        return {"index": index, "start": start, "end": end, "fps": fps,
                "frame_count": 0, "detected_frames": 0, "faces": [], "error": "không mở được luồng frame"}

    np = detector.np
    frames: List[Optional[List[List[List[float]]]]] = []
    detected = 0
    try:
        for i, buf in stream.frames():
            if i >= max_frames:
                break
            faces_here: Optional[List[List[List[float]]]] = None
            if np is not None and detector.mp is not None:
                arr = np.frombuffer(buf, dtype=np.uint8).reshape(stream.height, stream.width, 3)
                faces_here = detector.face_landmarks_multi(arr, max_faces)
            if faces_here:
                detected += 1
            frames.append(faces_here)
    finally:
        stream.close()

    smoothed = smooth_face_series(frames, float(options.get("smooth_alpha", RETOUCH_DEFAULTS["smooth_alpha"])))
    return {
        "index": index,
        "start": start,
        "end": end,
        "fps": fps,
        "frame_count": len(frames),
        "detected_frames": detected,
        # frames[i] = danh sách mặt; mỗi mặt = [[x,y], ...] chuẩn hoá 0..1.
        # null = frame đó không thấy mặt nào (frontend giữ nguyên khung, không retouch).
        "frames": smoothed,
    }


def smooth_face_series(
    frames: List[Optional[List[List[List[float]]]]],
    alpha: float,
) -> List[Optional[List[List[List[float]]]]]:
    """Làm mượt landmark theo THỜI GIAN bằng EMA hai chiều.

    VÌ SAO CẦN: FaceMesh chạy từng frame độc lập (`static_image_mode`), landmark rung
    ±1-2 px giữa các frame kề nhau dù mặt đứng yên. Rung đó đi vào phép BIẾN DẠNG HÌNH
    HỌC thì mép mặt "sôi" — lỗi kinh điển của retouch video làm ẩu.

    HAI CHIỀU (xuôi rồi ngược, lấy trung bình) thay vì EMA một chiều: EMA một chiều gây
    TRỄ PHA — mặt bám sau chuyển động thật, quay đầu nhanh là thấy ngay. Chạy hai chiều
    rồi trung bình thì độ trễ triệt tiêu.

    CHỈ làm mượt trong ĐOẠN LIÊN TỤC có mặt: bắc cầu qua chỗ mất dấu là kéo landmark
    của mặt cũ sang cảnh mới.
    """
    a = clamp(finite_number(alpha, 0.5), 0.0, 1.0)
    if a <= 0.0 or not frames:
        return frames
    n = len(frames)
    out: List[Optional[List[List[List[float]]]]] = [None] * n
    i = 0
    while i < n:
        if frames[i] is None:
            i += 1
            continue
        j = i
        while j < n and frames[j] is not None:
            j += 1
        seg = frames[i:j]
        # Số mặt có thể đổi giữa các frame -> chỉ làm mượt khi số mặt ỔN ĐỊNH trong
        # đoạn; đổi số mặt thì để nguyên (an toàn hơn là ghép nhầm mặt A với mặt B).
        counts = {len(f) for f in seg if f is not None}
        if len(counts) == 1 and seg:
            k = counts.pop()
            fwd = [[[list(p) for p in face] for face in seg[0]]]
            for idx in range(1, len(seg)):
                prev, cur = fwd[-1], seg[idx]
                fwd.append([[[cur[f][p][0] * (1 - a) + prev[f][p][0] * a,
                              cur[f][p][1] * (1 - a) + prev[f][p][1] * a]
                             for p in range(len(cur[f]))] for f in range(k)])
            bwd = [None] * len(seg)
            bwd[-1] = [[list(p) for p in face] for face in seg[-1]]
            for idx in range(len(seg) - 2, -1, -1):
                nxt, cur = bwd[idx + 1], seg[idx]
                bwd[idx] = [[[cur[f][p][0] * (1 - a) + nxt[f][p][0] * a,
                              cur[f][p][1] * (1 - a) + nxt[f][p][1] * a]
                             for p in range(len(cur[f]))] for f in range(k)]
            for idx in range(len(seg)):
                out[i + idx] = [[[round((fwd[idx][f][p][0] + bwd[idx][f][p][0]) / 2, 5),
                                  round((fwd[idx][f][p][1] + bwd[idx][f][p][1]) / 2, 5)]
                                 for p in range(len(seg[idx][f]))] for f in range(k)]
        else:
            for idx in range(len(seg)):
                out[i + idx] = seg[idx]
        i = j
    return out


def analyze_clip(detector: PersonDetector, video_path: str, clip: Dict[str, Any], source_size: Dict[str, Any]) -> Dict[str, Any]:
    index = int(finite_number(clip.get("index"), 0))
    start = max(0.0, finite_number(clip.get("start"), 0.0))
    end = max(start, finite_number(clip.get("end"), start))
    source_width = source_size.get("render_width") or source_size.get("width")
    source_height = source_size.get("render_height") or source_size.get("height")
    base = {
        "auto_reframe_version": AUTO_REFRAME_VERSION,
        "coordinate_space": "render",
        "index": index,
        "start": start,
        "end": end,
        "detected": False,
        "status": "no_person",
        "source_width": source_width,
        "source_height": source_height,
        "coded_width": source_size.get("coded_width"),
        "coded_height": source_size.get("coded_height"),
        "source_rotation": source_size.get("rotation"),
    }

    if not detector.ready():
        return {
            **base,
            "status": "detector_unavailable",
            "reason": "Cần cài opencv-contrib-python và MediaPipe để nhận diện người/khuôn mặt.",
        }

    # Lấy mẫu HAI ĐẦU block. Khung đầu quyết định bố cục của block (như trước); khung cuối
    # dùng để KHỚP với khung đầu của block kế tiếp -> không giật khung tại điểm cắt.
    head = sample_person_at(detector, video_path, head_candidate_times(start, end))
    tail = sample_person_at(detector, video_path, tail_candidate_times(start, end))

    if head is None and tail is None:
        return base
    # Chỉ dò được một đầu -> dùng nó cho cả hai (vẫn tốt hơn là bỏ hẳn thông tin).
    if head is None:
        head = tail
    if tail is None:
        tail = head

    return {
        **base,
        **head,
        "detected": True,
        "status": "ready",
        "source_width": source_width or head.get("frame_width"),
        "source_height": source_height or head.get("frame_height"),
        # `tail` là mẫu ở khung CUỐI block. Cố ý để riêng thay vì trộn vào gốc: mọi code
        # hình học cũ đọc field gốc = mẫu khung ĐẦU nên không đổi hành vi, phần khớp điểm
        # cắt chỉ cần thêm mà không phải sửa chỗ nào khác.
        "tail": tail,
    }


# Dò người tại danh sách mốc thời gian, trả mẫu ĐẦU TIÊN tìm được (None nếu không thấy).
def sample_person_at(detector: PersonDetector, video_path: str, times: List[float]) -> Optional[Dict[str, Any]]:
    for sample_time in times:
        frame = detector.capture_frame(video_path, sample_time)
        if frame is None:
            continue
        frame_height, frame_width = frame.shape[:2]
        detected = detector.detect(frame)
        if detected:
            return {
                **detected,
                "detected": True,
                "sample_time": sample_time,
                "frame_width": frame_width,
                "frame_height": frame_height,
            }
    return None


# ---------------- Dò điểm đổi góc máy (camera-cut detection) ----------------
# Nguyên tắc: KHÔNG dựa vào vị trí mặt người. Bước 1 dùng ffmpeg scene_score
# (thay đổi toàn khung hình) tìm ứng viên cắt cứng; bước 2 xác minh bằng cách
# CHE vùng người (pose/face box) rồi so sánh phần môi trường/hậu cảnh
# trước-sau điểm cắt — chỉ hậu cảnh đổi mới coi là đổi góc máy.

def cut_option(options: Dict[str, Any], key: str) -> float:
    return finite_number((options or {}).get(key), CAMERA_CUT_DEFAULTS[key])


def run_scene_scan(video_path: str, start: float, end: float) -> List[Tuple[float, float]]:
    duration = max(0.0, end - start)
    if duration <= 0.2:
        return []
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{max(0.0, start):.6f}",
            "-t",
            f"{duration:.6f}",
            "-i",
            video_path,
            "-vf",
            "scale=320:-2,select=gte(scene\\,0),metadata=print:file=-",
            "-an",
            "-f",
            "null",
            "-",
        ],
        cwd=str(PROJECT_ROOT),
        text=True,
        capture_output=True,
        timeout=max(120.0, duration * 3.0 + 30.0),
        check=True,
    )
    scores: List[Tuple[float, float]] = []
    current_pts: Optional[float] = None
    for line in (result.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("frame:"):
            match = re.search(r"pts_time:([0-9eE.+-]+)", line)
            current_pts = finite_number(match.group(1), -1.0) if match else None
            if current_pts is not None and current_pts < 0:
                current_pts = None
        elif line.startswith("lavfi.scene_score=") and current_pts is not None:
            score = finite_number(line.split("=", 1)[1], 0.0)
            scores.append((start + current_pts, score))
    return scores


def _local_median(values: List[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    m = len(ordered)
    return ordered[m // 2] if m % 2 else 0.5 * (ordered[m // 2 - 1] + ordered[m // 2])


def pick_cut_candidates(
    scores: List[Tuple[float, float]],
    start: float,
    end: float,
    options: Dict[str, Any],
) -> List[Tuple[float, float]]:
    # Ứng viên = ĐỈNH scene_score NỔI BẬT so với nền cục bộ (không dùng ngưỡng tuyệt đối
    # cứng). Cắt cùng bối cảnh (quay lại cùng vị trí) có scene_score thấp nhưng vẫn là 1
    # đỉnh nhọn so với các frame liền kề -> bắt được; chuyển động camera mượt không tạo
    # đỉnh nhọn nên bị loại.
    if not scores:
        return []
    floor = cut_option(options, "scene_floor")
    prominence = cut_option(options, "scene_prominence")
    base_win = cut_option(options, "peak_baseline_window")
    edge_guard = cut_option(options, "edge_guard")
    merge_window = cut_option(options, "merge_window")
    max_cuts = int(cut_option(options, "max_cuts"))

    times = [t for t, _ in scores]
    vals = [s for _, s in scores]
    n = len(scores)
    candidates: List[Tuple[float, float]] = []
    for i in range(n):
        t = times[i]
        s = vals[i]
        if s < floor:
            continue
        if not ((start + edge_guard) <= t <= (end - edge_guard)):
            continue
        # Cực đại cục bộ (nhọn hơn 2 hàng xóm liền kề)
        if (i > 0 and s < vals[i - 1]) or (i < n - 1 and s < vals[i + 1]):
            continue
        lo = t - base_win
        hi = t + base_win
        neigh = [vals[j] for j in range(n) if lo <= times[j] <= hi and j != i]
        baseline = _local_median(neigh)
        if s >= max(floor, baseline * prominence):
            candidates.append((t, s))

    candidates.sort(key=lambda item: item[0])
    merged: List[Tuple[float, float]] = []
    for time, score in candidates:
        if merged and time - merged[-1][0] <= merge_window:
            if score > merged[-1][1]:
                merged[-1] = (time, score)
        else:
            merged.append((time, score))
    if len(merged) > max_cuts:
        merged.sort(key=lambda item: -item[1])
        merged = merged[:max_cuts]
    merged.sort(key=lambda item: item[0])
    return merged


def person_exclusion_box(detection: Optional[Dict[str, Any]], width: int, height: int) -> Optional[Dict[str, float]]:
    if not detection or not detection.get("detected"):
        return None
    body_box = detection.get("body_box")
    if body_box:
        box_width = max(1.0, body_box["x_max"] - body_box["x_min"])
        box_height = max(1.0, body_box["y_max"] - body_box["y_min"])
        x_min = body_box["x_min"] - box_width * 0.35
        x_max = body_box["x_max"] + box_width * 0.35
        # Nới lên trên để che đầu, kéo xuống đáy khung vì thân người tiếp tục bên dưới hông.
        y_min = body_box["y_min"] - box_height * 0.6
        y_max = float(height)
    else:
        face_x = detection.get("face_center_x")
        face_y = detection.get("face_center_y")
        face_h = detection.get("face_height")
        if face_x is None or face_y is None or not face_h:
            return None
        x_min = face_x - face_h * 1.8
        x_max = face_x + face_h * 1.8
        y_min = face_y - face_h * 1.5
        y_max = float(height)
    return {
        "x_min": clamp(x_min, 0.0, float(width)),
        "x_max": clamp(x_max, 0.0, float(width)),
        "y_min": clamp(y_min, 0.0, float(height)),
        "y_max": clamp(y_max, 0.0, float(height)),
    }


def verify_camera_change(
    detector: "PersonDetector",
    video_path: str,
    cut_time: float,
    start: float,
    end: float,
    options: Dict[str, Any],
) -> Dict[str, Any]:
    # Xác minh CẮT bằng GIÁN ĐOẠN THỜI GIAN: lấy 5 mốc quanh điểm cắt, tính 4 chênh lệch
    # khung LIÊN TIẾP. Cắt cứng -> đúng 1 chênh (qua ranh giới) VỌT LÊN so với 3 chênh còn
    # lại (chuyển động 2 bên). Chuyển động camera mượt / vẫy tay -> 4 chênh xấp xỉ nhau ->
    # KHÔNG xác nhận. Cách này bắt được cả đổi góc CÙNG bối cảnh (không cần hậu cảnh đổi).
    verdict: Dict[str, Any] = {
        "time": cut_time,
        "verified": False,
        "confirmed": True,  # không xác minh được (thiếu cv2) thì tin bước đỉnh scene_score
        "cross_diff": None,
        "side_motion": None,
    }
    cv2 = detector.cv2
    np = detector.np
    if cv2 is None or np is None:
        return verdict

    step = cut_option(options, "verify_step")
    hi_bound = max(start, end - 0.02)
    offsets = [-2.0 * step, -1.0 * step, 0.0, 1.0 * step, 2.0 * step]
    grays: List[Any] = []
    size = (192, 108)
    for off in offsets:
        tt = min(max(start, cut_time + off), hi_bound)
        frame = detector.capture_frame(video_path, tt)
        if frame is None:
            return verdict
        grays.append(cv2.GaussianBlur(cv2.cvtColor(cv2.resize(frame, size), cv2.COLOR_BGR2GRAY), (5, 5), 0))

    # 4 chênh liên tiếp; ranh giới cắt = chênh lớn nhất trong 2 chênh GIỮA (bao quanh cut_time)
    diffs = [float(cv2.absdiff(grays[i], grays[i + 1]).mean()) for i in range(4)]
    cut_idx = 1 if diffs[1] >= diffs[2] else 2
    cross = diffs[cut_idx]
    side = [diffs[i] for i in range(4) if i != cut_idx]
    side_motion = max(side) if side else 0.0

    abs_min = cut_option(options, "cut_abs_min")
    prom = cut_option(options, "cut_prominence")
    confirmed = cross >= abs_min and cross >= side_motion * prom
    verdict.update({
        "verified": True,
        "cross_diff": cross,
        "side_motion": side_motion,
        "confirmed": bool(confirmed),
    })
    return verdict


def detect_cuts_for_clip(
    detector: "PersonDetector",
    video_path: str,
    clip: Dict[str, Any],
    options: Dict[str, Any],
) -> Dict[str, Any]:
    index = int(finite_number(clip.get("index"), 0))
    start = max(0.0, finite_number(clip.get("start"), 0.0))
    end = max(start, finite_number(clip.get("end"), start))
    base = {
        "camera_cut_version": CAMERA_CUT_VERSION,
        "index": index,
        "start": start,
        "end": end,
        "status": "ready",
        "cuts": [],
        "cut_times": [],
    }
    try:
        scores = run_scene_scan(video_path, start, end)
    except Exception as exc:
        return {**base, "status": "scan_failed", "reason": str(exc)}

    cuts: List[Dict[str, Any]] = []
    for time, score in pick_cut_candidates(scores, start, end, options):
        verdict = verify_camera_change(detector, video_path, time, start, end, options)
        verdict["scene_score"] = score
        cuts.append(verdict)

    # Chống cắt vụn: mọi block con sau tách phải >= min_segment. Khi hai điểm cắt quá gần
    # nhau, GIỮ ĐIỂM MẠNH HƠN (scene_score cao) — duyệt theo độ mạnh giảm dần, nhận điểm
    # nếu cách MỌI ranh giới đã nhận (gồm 2 mép block) >= min_segment.
    min_seg = cut_option(options, "min_segment")
    confirmed = [c for c in cuts if c.get("confirmed")]
    confirmed.sort(key=lambda c: -(finite_number(c.get("scene_score"), 0.0)))
    boundaries: List[float] = [start, end]
    for c in confirmed:
        t = c["time"]
        if all(abs(t - b) >= min_seg for b in boundaries):
            boundaries.append(t)
        else:
            c["dropped_reason"] = "min_segment"
    kept_times = sorted(b for b in boundaries if b not in (start, end))

    return {
        **base,
        "min_segment": min_seg,
        "cuts": cuts,
        "cut_times": kept_times,
    }


def track_clip(
    detector: PersonDetector,
    video_path: str,
    clip: Dict[str, Any],
    fps: float,
    max_frames: int,
    include_face_mesh: bool,
) -> Dict[str, Any]:
    # Lấy mẫu frame trong [start,end] ở tần số fps, chạy pose (+face mesh) mỗi mẫu.
    # t trong kết quả là GIÂY NGUỒN (khớp video.currentTime của clip lane main), landmark
    # chuẩn hoá 0..1. Frame không thấy người -> vẫn ghi {t, pose:null} để playhead biết
    # đoạn đó mất dấu (giúp dev thấy chỗ nhận diện hụt).
    start = finite_number(clip.get("start"), 0.0)
    end = finite_number(clip.get("end"), 0.0)
    duration = max(0.0, end - start)
    step = 1.0 / fps if fps > 0 else 0.1
    count = int(min(max_frames, max(1, math.floor(duration / step) + 1)))
    frames: List[Dict[str, Any]] = []
    detected_count = 0
    for i in range(count):
        t = start + i * step
        if t > end:
            break
        frame = detector.capture_frame(video_path, t)
        lm = detector.track_landmarks(frame, include_face_mesh=include_face_mesh)
        if lm.get("pose") or lm.get("face"):
            detected_count += 1
        frames.append({"t": round(float(t), 4), "pose": lm.get("pose"), "face": lm.get("face")})
    return {
        "index": clip.get("index"),
        "start": start,
        "end": end,
        "frame_count": len(frames),
        "detected_frames": detected_count,
        "frames": frames,
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: auto_reframe_sidecar.py <input.json> <output.json>", file=sys.stderr)
        return 2

    output_path = sys.argv[2]
    detector = PersonDetector()
    try:
        payload = load_payload(sys.argv[1])
        video_path = str(payload.get("video_path") or "")
        clips = payload.get("clips") or []
        if not video_path or not Path(video_path).exists():
            raise RuntimeError("Không tìm thấy video nguồn để phân tích Auto-Reframe.")
        if not isinstance(clips, list):
            raise RuntimeError("Danh sách clip Auto-Reframe không hợp lệ.")

        mode = str(payload.get("mode") or "analyze")
        if mode == "pose_track":
            options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
            fps = clamp(finite_number(options.get("fps"), POSE_TRACK_DEFAULTS["fps"]), 1.0, 30.0)
            max_frames = int(clamp(finite_number(options.get("max_frames"), POSE_TRACK_DEFAULTS["max_frames"]), 1, 5000))
            include_face_mesh = bool(options.get("include_face_mesh", POSE_TRACK_DEFAULTS["include_face_mesh"]))
            source_size = ffprobe_video_size(video_path)
            results = []
            for position, clip in enumerate(clips):
                emit_progress(f"Đang dựng skeleton block {position + 1}/{len(clips)}...")
                results.append(track_clip(detector, video_path, clip, fps, max_frames, include_face_mesh))
            write_output(output_path, {
                "pose_track_version": POSE_TRACK_VERSION,
                "coordinate_space": "normalized",
                "status": "success",
                "source": source_size,
                "fps": fps,
                "detector": {
                    "ready": detector.ready(),
                    "mediapipe": detector.mp is not None,
                    "pose": detector.pose is not None,
                    "face_mesh": getattr(detector, "face_mesh", None) is not None,
                    "errors": detector.import_errors,
                },
                "clips": results,
            })
            print(json.dumps({"type": "result", "message": "pose track complete", "path": output_path}, ensure_ascii=False), flush=True)
            return 0

        if mode == "retouch_track":
            options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
            source_size = ffprobe_video_size(video_path)
            still = is_still_image_source(video_path)
            results = []
            for position, clip in enumerate(clips):
                emit_progress(f"Đang bám khuôn mặt cho Retouch — block {position + 1}/{len(clips)}...")
                if still:
                    results.append(track_retouch_still(detector, video_path, clip, source_size, options))
                else:
                    results.append(track_retouch_clip(detector, video_path, clip, source_size, options))
            write_output(output_path, {
                "retouch_track_version": RETOUCH_TRACK_VERSION,
                "coordinate_space": "normalized",
                "status": "success",
                "source": source_size,
                "still": still,
                "landmark_count": 478,
                "detector": {
                    "ready": detector.ready(),
                    "mediapipe": detector.mp is not None,
                    "face_mesh_multi": getattr(detector, "_face_mesh_multi", None) is not None,
                    "face_mesh_still": getattr(detector, "_face_mesh_still", None) is not None,
                    "errors": detector.import_errors,
                },
                "clips": results,
            })
            print(json.dumps({"type": "result", "message": "retouch track complete", "path": output_path}, ensure_ascii=False), flush=True)
            return 0

        if mode == "detect_cuts":
            options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
            results = []
            for position, clip in enumerate(clips):
                emit_progress(f"Đang dò điểm đổi góc máy trong block {position + 1}/{len(clips)}...")
                results.append(detect_cuts_for_clip(detector, video_path, clip, options))
            write_output(output_path, {
                "camera_cut_version": CAMERA_CUT_VERSION,
                "status": "success",
                "detector": {
                    "ready": detector.ready(),
                    "opencv": detector.cv2 is not None,
                    "errors": detector.import_errors,
                },
                "clips": results,
            })
            print(json.dumps({"type": "result", "message": "camera cut detection complete", "path": output_path}, ensure_ascii=False), flush=True)
            return 0

        emit_progress("Đang quét khung đầu + khung cuối của các clip Timeline để căn khung...")
        source_size = ffprobe_video_size(video_path)
        results = [analyze_clip(detector, video_path, clip, source_size) for clip in clips]
        write_output(output_path, {
            "auto_reframe_version": AUTO_REFRAME_VERSION,
            "coordinate_space": "render",
            "status": "success",
            "source": source_size,
            "detector": {
                "ready": detector.ready(),
                "mediapipe": detector.mp is not None,
                "opencv": detector.cv2 is not None,
                "opencv_haar": detector.face_cascade is not None,
                "errors": detector.import_errors,
            },
            "clips": results,
        })
        print(json.dumps({"type": "result", "message": "auto reframe analysis complete", "path": output_path}, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:
        write_output(output_path, {"status": "error", "detail": str(exc)})
        print(json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False), flush=True)
        return 1
    finally:
        detector.close()


if __name__ == "__main__":
    sys.exit(main())
