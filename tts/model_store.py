#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>
"""Kho model của "Lồng tiếng": biết engine nào cần những file nào, tải về lần đầu và BÁO TIẾN
TRÌNH TẢI theo byte để thanh trạng thái hiện được "Đang tải … 45% (600 MB / 1,3 GB)".

VÌ SAO KHÔNG ĐỂ THƯ VIỆN TỰ TẢI (như F5-TTS/VieNeu vẫn làm khi nhận repo id):
  · nó tải vào ~/.cache/huggingface — ngoài tầm mục "Bộ nhớ đệm" của app, người dùng không
    biết mấy GB đó nằm đâu;
  · nó không báo tiến trình cho ai cả: lượt lồng tiếng đầu tiên đứng im 10-30 phút ở "Đang nạp
    model" và người dùng tưởng app treo. Đây là lý do có tệp này.
Nên mọi file model được tải TRƯỚC, vào `CRAB_TTS_MODEL_DIR/<khoá>/`, rồi đưa ĐƯỜNG DẪN local cho
thư viện.

VÌ SAO ĐO TIẾN TRÌNH BẰNG DUNG LƯỢNG THƯ MỤC chứ không móc vào tqdm của huggingface_hub:
đường tải hf_xet (mặc định từ hub 0.32) không đi qua tqdm_class truyền vào, còn đường HTTP cũ
thì có — móc vào tqdm là đúng với máy này, sai với máy kia. Đếm byte đang nằm trên đĩa (kể cả
tệp `.incomplete` trong `.cache/huggingface/download/`) đúng với MỌI đường tải.

AI HUB (kho model dùng chung, chỉ có trên máy tác giả — xem CrabbyCut_Private): nếu CLI `aihub`
có mặt VÀ model đã nằm sẵn trong kho của nó thì dùng luôn, không tải lần hai. Không bao giờ nhờ
AI Hub tải — máy người dùng không có nó, và đường tải phải là một.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

MARKER = ".crab-model.json"

# TẮT ĐƯỜNG TẢI hf_xet — đo thật (Vi-F5-TTS 1,35 GB): với xet, ~20 giây đầu KHÔNG một byte nào
# xuất hiện trong thư mục đích (xet gom mảnh vào cache riêng ~/.cache/huggingface/xet rồi mới
# ghép tệp), sau đó nhảy thẳng 0% -> 50% -> xong. Thanh tiến trình đứng im 20 giây là đúng thứ
# người dùng đã phàn nàn. Đường HTTP thường ghi dần vào tệp `.incomplete` nên thanh chạy đều.
# Phải đặt TRƯỚC khi huggingface_hub được import lần đầu (nó đọc cờ lúc import).
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

# Mỗi khoá là MỘT repo HuggingFace. `files` = danh sách file cần (None = cả repo trừ `ignore`).
MODELS: Dict[str, dict] = {
    "f5-vi": {
        "label": "Vi-F5-TTS",
        "repo": "danhtran2mind/Vi-F5-TTS",
        # pruning_model.pt (1,35 GB) CHỈ có trọng số EMA — đúng thứ suy luận cần. model_last.pt
        # 5,4 GB mang thêm trạng thái optimizer của lúc huấn luyện, tải về là phí 4 GB.
        # (Đã kiểm: torch.load -> {'ema_model_state_dict': 364 tensor}.)
        "files": ["Vi_F5_TTS_ckpts/pruning_model.pt", "vocab.txt"],
    },
    "vocos": {
        "label": "Vocos vocoder",
        "repo": "charactr/vocos-mel-24khz",
        "files": ["config.yaml", "pytorch_model.bin"],
    },
    "vieneu-tts": {
        "label": "VieNeu-TTS v2",
        "repo": "pnnbao-ump/VieNeu-TTS-v2",
        # Bỏ bản .gguf (189 MB): đường GGUF cần llama-cpp-python — xem VieNeuEngine ở server.py.
        "files": [
            "added_tokens.json", "config.json", "generation_config.json", "merges.txt",
            "model.safetensors", "special_tokens_map.json", "tokenizer.json",
            "tokenizer_config.json", "vocab.json", "voices.json",
        ],
        "aihub": "vieneu-tts",
    },
    "neucodec-onnx": {
        "label": "NeuCodec decoder",
        # Repo gốc bật `gated: auto` từ 26/08/2026: không đăng nhập + đồng ý điều khoản là 401.
        # Model là Apache-2.0 nên được phân phối lại -> tải từ mirror công khai trước, repo gốc
        # chỉ còn là đường cuối (cho máy có token đã được duyệt). Xem docs/SUA_LOI_TAI_NEUCODEC_GATED.md.
        "repo": "neuphonic/neucodec-onnx-decoder-int8",
        "mirrors": [
            "aoiandroid/neuphonic-neucodec-onnx-decoder-int8-mirror",
        ],
        # Hash LFS mà chính repo gốc công bố (HfApi.model_info(files_metadata=True)), đã đối
        # chiếu với bản tải từ repo gốc 09/10/2026. Mirror do người khác giữ -> hash là thứ
        # bảo đảm file không bị tráo.
        "sha256": {"model.onnx": "3ddd9e56396e6029e0e948ac0255c89c803f981f23dcf4c154f50820bd74a6b3"},
        "files": ["model.onnx"],
        "aihub": "neucodec-onnx",
    },
    "voxcpm2-8bit": {
        "label": "VoxCPM2 (MLX 8-bit)",
        "repo": "mlx-community/VoxCPM2-8bit",
        "files": None,
        "ignore": [".gitattributes", "README.md"],
        "aihub": "voxcpm2-8bit",
    },
}


def model_root() -> Path:
    raw = os.environ.get("CRAB_TTS_MODEL_DIR", "").strip()
    if raw:
        return Path(raw)
    if sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "CrabbyCut" / "tts_models"
    return Path.home() / ".crabbycut" / "tts_models"


def local_dir(key: str) -> Path:
    return model_root() / key


# ── Trạng thái tải (đọc bởi GET /health -> backend -> thanh trạng thái) ────────

_downloads: Dict[str, dict] = {}
_downloads_lock = threading.Lock()
_key_locks: Dict[str, threading.Lock] = {key: threading.Lock() for key in MODELS}


def downloads_snapshot() -> List[dict]:
    with _downloads_lock:
        return [dict(item) for item in _downloads.values()]


def _set_download(key: str, **values) -> None:
    with _downloads_lock:
        item = _downloads.setdefault(key, {"id": f"tts:{key}", "key": key, "label": MODELS[key]["label"]})
        item.update(values)


# ── Đã có sẵn chưa ───────────────────────────────────────────────────────────

def _read_marker(folder: Path) -> Optional[dict]:
    try:
        return json.loads((folder / MARKER).read_text(encoding="utf-8"))
    except Exception:
        return None


def _complete_in(folder: Path, files: List[str]) -> bool:
    return all((folder / name).is_file() and (folder / name).stat().st_size > 0 for name in files)


def resolve_local(key: str) -> Optional[Path]:
    """Đường dẫn model nếu ĐÃ tải đủ (hoặc có sẵn trong AI Hub), ngược lại None. Không tải gì."""
    spec = MODELS[key]
    folder = local_dir(key)
    marker = _read_marker(folder)
    if marker and _complete_in(folder, list(marker.get("files", {}).keys()) or spec["files"] or []):
        return folder
    hub = _aihub_existing(key)
    if hub is not None:
        return hub
    return None


def is_ready(key: str) -> bool:
    return resolve_local(key) is not None


# ── AI Hub: CHỈ dùng lại thứ đã có ────────────────────────────────────────────

def _aihub_cli() -> str:
    override = os.environ.get("CRAB_AIHUB_CLI", "").strip()
    if override and Path(override).is_file():
        return override
    base = Path.home() / ".aihub" / "bin"
    names = ["aihub.exe", "aihub.cmd", "aihub.bat"] if sys.platform == "win32" else ["aihub"]
    for name in names:
        if (base / name).is_file():
            return str(base / name)
    return shutil.which("aihub") or ""


_aihub_cache: Dict[str, Optional[Path]] = {}


def _aihub_existing(key: str) -> Optional[Path]:
    name = MODELS[key].get("aihub")
    if not name or os.environ.get("CRAB_TTS_NO_AIHUB") == "1":
        return None
    if key in _aihub_cache:
        return _aihub_cache[key]
    found: Optional[Path] = None
    cli = _aihub_cli()
    if cli:
        try:
            done = subprocess.run(
                [cli, "path", name], capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            lines = [line.strip() for line in (done.stdout or "").splitlines() if line.strip()]
            candidate = Path(lines[-1]) if done.returncode == 0 and lines else None
            files = MODELS[key]["files"]
            if candidate and candidate.is_dir() and (files is None or _complete_in(candidate, files)):
                found = candidate
        except Exception:
            found = None
    _aihub_cache[key] = found
    return found


# ── Tải ──────────────────────────────────────────────────────────────────────

def _folder_bytes(folder: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(folder):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def _sources(spec: dict) -> List[str]:
    """Các repo để thử, theo thứ tự: mirror trước, repo gốc sau cùng."""
    return [*(spec.get("mirrors") or []), spec["repo"]]


def _token_for(spec: dict, repo: str):
    # Mirror là repo công khai: KHÔNG gửi token. Token cũ hết hạn/bị thu hồi trên máy người dùng
    # sẽ làm hỏng cả lượt tải vốn không cần đăng nhập (tương đương HF_HUB_DISABLE_IMPLICIT_TOKEN,
    # nhưng theo từng lượt gọi — cờ môi trường chỉ được đọc một lần lúc import hub).
    return False if repo != spec["repo"] else None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _remote_files(spec: dict, repo: str) -> Dict[str, int]:
    """{đường dẫn trong repo: số byte} của những file cần tải."""
    from huggingface_hub import HfApi

    wanted = spec["files"]
    ignore = set(spec.get("ignore") or [])
    sizes: Dict[str, int] = {}
    for entry in HfApi().list_repo_tree(repo, recursive=True, token=_token_for(spec, repo)):
        path = getattr(entry, "path", "")
        size = getattr(entry, "size", None)
        if size is None:   # thư mục
            continue
        if wanted is not None and path not in wanted:
            continue
        if wanted is None and path in ignore:
            continue
        sizes[path] = int(size)
    missing = [name for name in (wanted or []) if name not in sizes]
    if missing:
        raise RuntimeError(f"Repo {repo} không còn tệp: {', '.join(missing)}")
    return sizes


def ensure(key: str, on_progress: Optional[Callable[[dict], None]] = None) -> Path:
    """Trả thư mục model; chưa có thì tải (chặn tới khi xong). An toàn khi gọi song song."""
    if key not in MODELS:
        raise RuntimeError(f"Không biết model '{key}'")
    ready = resolve_local(key)
    if ready is not None:
        return ready
    with _key_locks[key]:
        ready = resolve_local(key)   # luồng khác vừa tải xong trong lúc mình chờ khoá
        if ready is not None:
            return ready
        return _download(key, on_progress)


def _download(key: str, on_progress: Optional[Callable[[dict], None]]) -> Path:
    spec = MODELS[key]
    folder = local_dir(key)
    folder.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    _set_download(key, state="preparing", downloaded=0, total=0, started_at=time.time(),
                  finished_at=None, error="")
    failures: List[str] = []
    last_exc: Optional[Exception] = None
    # Nguồn hỏng (401, 404, mất mạng, sai hash) -> ghi lại rồi thử nguồn kế; chỉ báo lỗi khi
    # MỌI nguồn đều hỏng.
    for repo in _sources(spec):
        try:
            sizes = _download_from(key, repo, folder, on_progress)
        except Exception as exc:
            last_exc = exc
            failures.append(f"{repo}: {str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__}")
            continue
        (folder / MARKER).write_text(json.dumps({
            "repo": repo, "files": sizes, "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        shutil.rmtree(folder / ".cache", ignore_errors=True)   # siêu dữ liệu tải của hub
        _set_download(key, state="done", downloaded=sum(sizes.values()), finished_at=time.time())
        return folder
    message = _friendly_error(spec, last_exc or RuntimeError("không có nguồn tải"), failures)
    _set_download(key, state="error", error=message, finished_at=time.time())
    raise RuntimeError(message) from last_exc


def _download_from(key: str, repo: str, folder: Path,
                   on_progress: Optional[Callable[[dict], None]]) -> Dict[str, int]:
    """Tải đủ file của `key` từ một repo vào `folder`, kiểm SHA256 nếu spec có. Trả {file: byte}."""
    from huggingface_hub import hf_hub_download

    spec = MODELS[key]
    token = _token_for(spec, repo)
    sizes = _remote_files(spec, repo)
    total = sum(sizes.values())
    baseline = _folder_bytes(folder)   # phần đã tải của lượt trước bị ngắt — hub tải tiếp
    _set_download(key, state="downloading", total=total, downloaded=min(total, baseline))
    stop = threading.Event()

    def watch() -> None:
        while not stop.wait(0.5):
            current = min(total, _folder_bytes(folder))
            _set_download(key, downloaded=current)
            if on_progress:
                on_progress({"key": key, "downloaded": current, "total": total})

    watcher = threading.Thread(target=watch, name=f"watch-{key}", daemon=True)
    watcher.start()
    try:
        # Tệp lớn nhất sau cùng: tệp nhỏ xong ngay nên thanh nhích ngay từ đầu, người dùng
        # thấy nó CHẠY thay vì đứng ở 0% suốt lúc tải tệp 1 GB đầu tiên.
        for name in sorted(sizes, key=lambda n: sizes[n]):
            hf_hub_download(repo, name, local_dir=str(folder), token=token)
    finally:
        stop.set()
        watcher.join(timeout=2)
    for name, expected in (spec.get("sha256") or {}).items():
        path = folder / name
        actual = _sha256(path) if path.is_file() else ""
        if actual.lower() != expected.lower():
            # Xoá cả file lẫn siêu dữ liệu tải: để nguyên thì nguồn kế (cùng etag) tưởng đã có
            # file và bỏ qua không tải lại.
            path.unlink(missing_ok=True)
            shutil.rmtree(folder / ".cache", ignore_errors=True)
            raise RuntimeError(f"Sai SHA256 ở {name} (nhận {actual[:12] or 'không có file'}…, "
                               f"cần {expected[:12]}…) — đã xoá file")
    return sizes


def _friendly_error(spec: dict, exc: Exception, failures: Optional[List[str]] = None) -> str:
    text = " | ".join(failures) if failures else str(exc)
    low = text.lower()
    if "no space" in low or "errno 28" in low:
        return f"Không đủ dung lượng đĩa để tải {spec['label']} vào {model_root()}."
    refused = any(word in low for word in ("gated", "restricted", "401", "403", "404", "sha256",
                                          "not found", "không còn tệp"))
    if not refused and any(word in low for word in ("connection", "timed out", "timeout",
                                                    "name resolution", "offline")):
        return f"Không tải được {spec['label']}: mất kết nối mạng tới huggingface.co. ({text[-200:]})"
    if refused or len(_sources(spec)) > 1:
        # KHÔNG khuyên "hf auth login": người dùng cuối không làm được, và mỗi máy lại phải làm
        # lại từ đầu. Sửa đúng là ở phía app (thêm/đổi mirror) -> bảo họ cập nhật.
        return (f"Không tải được {spec['label']} từ mọi nguồn. Hãy cập nhật CrabbyCut lên bản mới "
                f"nhất hoặc báo cho tác giả. ({text[-200:]})")
    return f"Tải {spec['label']} thất bại: {text[-300:]}"


def status(keys: List[str]) -> List[dict]:
    """Trạng thái từng model (đã có / dung lượng) cho giao diện — không tải, không gọi mạng."""
    out = []
    for key in keys:
        path = resolve_local(key)
        out.append({"key": key, "label": MODELS[key]["label"], "ready": path is not None,
                    "path": str(path) if path else "", "repo": MODELS[key]["repo"]})
    return out
