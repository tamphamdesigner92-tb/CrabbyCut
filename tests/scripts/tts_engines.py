"""Test sổ engine của tts/server.py (v1.1.17) — không nạp model nào.

  1. Mỗi môi trường chỉ mở engine của mình (CRAB_TTS_ENV): Windows/Linux đặt Qwen3-TTS và Chatterbox
     ở môi trường riêng, Mac để cả năm engine ở môi trường chính (mlx-audio).
  2. Qwen3Engine.configure chọn checkpoint theo chế độ, chặn nhân bản thiếu giọng mẫu và chặn thiết
     kế giọng trên máy không đủ sức.
  3. Chatterbox chặn ngôn ngữ không có trong danh sách 23 thứ tiếng.

Chạy: npm run test:tts-engines   (cần python của .venv-tts — có fastapi)
"""
import importlib
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tts"))
failures = []

# server.py dựng app FastAPI lúc import. Môi trường chạy test (.venv chính, CI) không có fastapi —
# test chỉ đọc sổ engine nên dựng một bản giả đủ cho các decorator.
try:
    import fastapi  # noqa: F401
except ImportError:
    import types

    class _App:
        def __init__(self, *a, **k):
            pass

        def __getattr__(self, _name):
            return lambda *a, **k: (lambda fn: fn)

    fake = types.ModuleType("fastapi")
    fake.FastAPI = _App
    fake.Body = lambda *a, **k: None
    fake.HTTPException = type("HTTPException", (Exception,), {})
    responses = types.ModuleType("fastapi.responses")
    responses.JSONResponse = object
    sys.modules["fastapi"] = fake
    sys.modules["fastapi.responses"] = responses


def check(label, condition, detail=""):
    print(f"  {'ok' if condition else 'FAIL'}   {label}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


def load_server(env_id):
    os.environ["CRAB_TTS_ENV"] = env_id
    if "server" in sys.modules:
        return importlib.reload(sys.modules["server"])
    return importlib.import_module("server")


print("engine theo môi trường")
main = load_server("main")
expected_main = {"vieneu3", "vieneu", "voxcpm"} | ({"qwen3", "chatterbox"} if sys.platform == "darwin" else set())
check("môi trường chính", set(main.ENGINES) == expected_main, sorted(main.ENGINES))
if sys.platform != "darwin":
    check("môi trường qwen chỉ có Qwen3-TTS", set(load_server("qwen").ENGINES) == {"qwen3"})
    check("môi trường chatterbox chỉ có Chatterbox", set(load_server("chatterbox").ENGINES) == {"chatterbox"})

print("Qwen3-TTS")
srv = load_server("main")
qwen = srv.Qwen3Engine()
qwen.configure({"engine_options": {"mode": "custom"}})
check("giọng có sẵn -> checkpoint CustomVoice", qwen.models[0].startswith("qwen3-0.6b-custom"), qwen.models)
qwen.configure({"engine_options": {"mode": "clone"}, "ref_audio": "C:/x.wav"})
check("nhân bản -> checkpoint Base", qwen.models[0].startswith("qwen3-0.6b-base"), qwen.models)
qwen.configure({"ref_audio": "C:/x.wav"})
check("không ghi chế độ mà có giọng mẫu -> nhân bản", qwen.models[0].startswith("qwen3-0.6b-base"))
try:
    qwen.configure({"engine_options": {"mode": "clone"}})
    check("nhân bản thiếu giọng mẫu bị chặn", False)
except srv.UserError:
    check("nhân bản thiếu giọng mẫu bị chặn", True)
ok, _reason = qwen.design_available()
try:
    qwen.configure({"engine_options": {"mode": "design"}})
    check("thiết kế giọng theo đúng sức máy", ok, "máy đủ sức mà vẫn bị chặn")
except srv.UserError:
    check("thiết kế giọng theo đúng sức máy", not ok, "máy không đủ sức mà vẫn cho chạy")
try:
    qwen.configure({"engine_options": {"mode": "lạ"}})
    check("chế độ lạ bị chặn", False)
except srv.UserError:
    check("chế độ lạ bị chặn", True)
info = srv.engine_info(qwen)
check("engine_info có ngôn ngữ + chế độ", len(info.get("languages", [])) == 11 and len(info.get("modes", [])) == 3, info.keys())

print("Chatterbox")
cb = srv.ChatterboxEngine()
check("23 ngôn ngữ, không có tiếng Việt", len(cb.LANGUAGES) == 23 and "vi" not in {c for c, _ in cb.LANGUAGES})
cb._model = object()   # giả đã nạp để _synth_once đi tới khâu kiểm ngôn ngữ, không nạp model thật
try:
    cb._synth_once("Xin chào", {"engine_options": {"language": "vi"}}, None)
    check("ngôn ngữ ngoài danh sách bị chặn", False)
except srv.UserError:
    check("ngôn ngữ ngoài danh sách bị chặn", True)
except Exception as exc:  # noqa: BLE001
    check("ngôn ngữ ngoài danh sách bị chặn", False, repr(exc))

if failures:
    print(f"\n{len(failures)} lỗi")
    sys.exit(1)
print("\nTất cả đều qua.")
