#!/usr/bin/env python3
"""Test đường tải model của "Lồng tiếng" (tts/model_store.py) khi repo gốc bị khoá (gated):
thử mirror trước, kiểm SHA256, nguồn hỏng thì sang nguồn kế, câu báo lỗi không còn bảo người
dùng chạy `hf auth login`. Xem docs/SUA_LOI_TAI_NEUCODEC_GATED.md.

Không gọi mạng: `huggingface_hub` được thay bằng bản giả, mỗi "repo" là một dict {file: bytes}.
    npm run test:tts-model-store
"""
import hashlib
import os
import sys
import tempfile
import types
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "tts"))

failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        failures.append(label)


# ── huggingface_hub giả ──────────────────────────────────────────────────────

class GatedRepoError(Exception):
    pass


REPOS = {}      # repo -> {file: bytes}; repo vắng mặt = 404
GATED = set()   # repo cần token
CALLS = []      # (hàm, repo, token)


class _Entry:
    def __init__(self, path, size):
        self.path, self.size = path, size


def _guard(repo, token, fn):
    CALLS.append((fn, repo, token))
    if repo not in REPOS:
        raise RuntimeError(f"404 Client Error: Repository Not Found for url .../{repo}")
    if repo in GATED and token is False:
        raise GatedRepoError(f"401 Client Error. Cannot access gated repo for url .../{repo}")


class HfApi:
    def list_repo_tree(self, repo, recursive=True, token=None):
        _guard(repo, token, "list_repo_tree")
        return [_Entry(name, len(data)) for name, data in REPOS[repo].items()]


def hf_hub_download(repo, name, local_dir, token=None):
    _guard(repo, token, "hf_hub_download")
    target = Path(local_dir) / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(REPOS[repo][name])
    return str(target)


fake = types.ModuleType("huggingface_hub")
fake.HfApi = HfApi
fake.hf_hub_download = hf_hub_download
sys.modules["huggingface_hub"] = fake

tmp = tempfile.mkdtemp(prefix="crab-tts-models-")
os.environ["CRAB_TTS_MODEL_DIR"] = tmp
os.environ["CRAB_TTS_NO_AIHUB"] = "1"

import model_store as store  # noqa: E402

GOOD = b"onnx-that-dung" * 1000
BAD = b"onnx-bi-trao" * 1000
SPEC = store.MODELS["neucodec-onnx"]
ORIGIN = SPEC["repo"]


def setup(mirrors, repos, gated=(), sha=None):
    """Đặt lại thế giới giả + xoá thư mục model, gắn mirror/hash cho spec."""
    import shutil
    REPOS.clear()
    REPOS.update(repos)
    GATED.clear()
    GATED.update(gated)
    CALLS.clear()
    SPEC["mirrors"] = list(mirrors)
    SPEC["sha256"] = {"model.onnx": sha or hashlib.sha256(GOOD).hexdigest()}
    store._downloads.clear()
    shutil.rmtree(store.local_dir("neucodec-onnx"), ignore_errors=True)


def marker():
    return store._read_marker(store.local_dir("neucodec-onnx")) or {}


print("tts/model_store: tải NeuCodec khi repo gốc bị khoá")

# 0. Cấu hình thật: có mirror, có hash 64 ký tự hex, repo gốc vẫn là nguồn cuối.
real_sha = SPEC["sha256"]["model.onnx"]
check("cấu hình thật có mirror + SHA256",
      SPEC.get("mirrors") and len(real_sha) == 64 and store._sources(SPEC)[-1] == ORIGIN)

# 1. Máy sạch, chưa đăng nhập: mirror tải được, KHÔNG gửi token cho mirror.
setup(["mirror/a"], {"mirror/a": {"model.onnx": GOOD}, ORIGIN: {"model.onnx": GOOD}}, gated=[ORIGIN])
path = store.ensure("neucodec-onnx")
check("tải từ mirror", (path / "model.onnx").read_bytes() == GOOD)
check("marker ghi repo thực sự đã dùng", marker().get("repo") == "mirror/a", marker())
check("không gửi token cho mirror", all(tok is False for _fn, repo, tok in CALLS if repo == "mirror/a"), CALLS)
check("không đụng repo gốc", not any(repo == ORIGIN for _fn, repo, _tok in CALLS))
check("trạng thái done", store.downloads_snapshot()[0]["state"] == "done")

# 2. Đã có model từ trước (có marker): không tải lại, không gọi mạng.
CALLS.clear()
store.ensure("neucodec-onnx")
check("model có sẵn -> không tải lại", CALLS == [], CALLS)

# 3. Mirror 1 mất (404) -> sang mirror 2.
setup(["mirror/mat", "mirror/b"], {"mirror/b": {"model.onnx": GOOD}, ORIGIN: {"model.onnx": GOOD}}, gated=[ORIGIN])
store.ensure("neucodec-onnx")
check("mirror 404 -> sang mirror kế", marker().get("repo") == "mirror/b", marker())

# 4. Mirror bị tráo file: sai hash -> xoá file, sang repo gốc (máy có token đã duyệt).
setup(["mirror/trao"], {"mirror/trao": {"model.onnx": BAD}, ORIGIN: {"model.onnx": GOOD}}, gated=[ORIGIN])
store.ensure("neucodec-onnx")
check("sai hash -> dùng repo gốc", marker().get("repo") == ORIGIN, marker())
check("file cuối cùng là file đúng", (store.local_dir("neucodec-onnx") / "model.onnx").read_bytes() == GOOD)
check("repo gốc được gọi với token ngầm", any(repo == ORIGIN and tok is None for _fn, repo, tok in CALLS))

# 5. Sai hash ở mọi nguồn: từ chối file, báo lỗi, không để lại file sai.
setup(["mirror/trao"], {"mirror/trao": {"model.onnx": BAD}, ORIGIN: {"model.onnx": BAD}}, gated=[])
try:
    store.ensure("neucodec-onnx")
    check("sai hash ở mọi nguồn -> báo lỗi", False)
except RuntimeError as exc:
    msg = str(exc)
    check("sai hash ở mọi nguồn -> báo lỗi", "từ mọi nguồn" in msg, msg)
    check("không còn file sai trên đĩa", not (store.local_dir("neucodec-onnx") / "model.onnx").exists())
    check("không đánh dấu là đã có", not store.is_ready("neucodec-onnx"))

# 6. Mirror mất + repo gốc khoá (máy chưa đăng nhập): câu báo lỗi mới, không có `hf auth login`.
setup(["mirror/mat"], {ORIGIN: {"model.onnx": GOOD}}, gated=[ORIGIN])
_orig_token_for = store._token_for
store._token_for = lambda spec, repo: False   # giả lập máy không có token
try:
    store.ensure("neucodec-onnx")
    check("mirror mất + gốc khoá -> báo lỗi", False)
except RuntimeError as exc:
    msg = str(exc)
    check("câu báo lỗi mới", "từ mọi nguồn" in msg and "cập nhật CrabbyCut" in msg, msg)
    check("không còn khuyên `hf auth login`", "hf auth login" not in msg, msg)
    check("giữ đuôi kỹ thuật để tra lỗi", "401" in msg and "404" in msg, msg)
    snap = store.downloads_snapshot()[0]
    check("trạng thái error mang cùng câu", snap["state"] == "error" and snap["error"] == msg, snap)
finally:
    store._token_for = _orig_token_for

# 7. Mất mạng ở mọi nguồn -> câu "mất kết nối", không phải "cập nhật app".
msg = store._friendly_error(SPEC, RuntimeError("x"), ["a: ConnectionError timed out", "b: Connection refused"])
check("mất mạng -> báo mất kết nối", "mất kết nối mạng" in msg, msg)

# 8. Model không có mirror vẫn chạy đường cũ (một nguồn, token ngầm).
check("model khác: nguồn duy nhất là repo", store._sources(store.MODELS["vocos"]) == ["charactr/vocos-mel-24khz"])
check("model khác: token ngầm", store._token_for(store.MODELS["vocos"], "charactr/vocos-mel-24khz") is None)

import shutil  # noqa: E402
shutil.rmtree(tmp, ignore_errors=True)

if failures:
    print(f"\n{len(failures)} FAIL")
    sys.exit(1)
print("\nOK")
