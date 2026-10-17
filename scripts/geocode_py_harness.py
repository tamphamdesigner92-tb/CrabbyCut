# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>
"""GeoCode — chạy mã Python của người dùng, ghi khung RGBA thô ra STDOUT.

electron/geocode-renderer.js nối stdout này thẳng vào stdin ffmpeg (-f rawvideo -pix_fmt rgba),
nên stdout CHỈ được chứa byte khung: print() của người dùng bị chuyển sang stderr (pane hiện
nó như log). Mỗi khung đúng width*height*4 byte, alpha THẲNG (không nhân trước).

Mã người dùng khai một trong hai thứ:
  def frame(t, width, height): ...   -> gọi cho từng khung (t = giây; ảnh tĩnh: một lần, t=0)
  image = ...                        -> một hình cho mọi khung
Giá trị nhận: PIL.Image, mảng numpy HxWx3 / HxWx4 (uint8, hoặc float 0..1), hoặc Figure của
matplotlib. Sai cỡ thì co về đúng width x height (báo một lần).
Biến có sẵn khi chạy mã: width, height, fps, duration, frames.
"""
import argparse
import inspect
import io
import sys
import traceback


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--code', required=True)
    ap.add_argument('--width', type=int, required=True)
    ap.add_argument('--height', type=int, required=True)
    ap.add_argument('--frames', type=int, required=True)
    ap.add_argument('--fps', type=float, default=30.0)
    ap.add_argument('--kind', default='image')
    ap.add_argument('--bg', default='transparent')
    ap.add_argument('--start', type=float, default=0.0)
    args = ap.parse_args()

    out = sys.stdout.buffer
    # Từ đây mọi print() (của người dùng lẫn của ta) đi stderr — stdout chỉ còn byte khung.
    sys.stdout = sys.stderr

    try:
        from PIL import Image
    except ImportError:
        sys.stderr.write('Thiếu thư viện Pillow: python -m pip install pillow\n')
        return 2

    width, height = args.width, args.height
    duration = args.frames / args.fps if args.kind == 'video' else 0.0
    namespace = {
        '__name__': '__geocode__',
        'width': width,
        'height': height,
        'fps': args.fps,
        'duration': duration,
        'frames': args.frames,
    }
    with open(args.code, 'r', encoding='utf-8') as fh:
        source = fh.read()
    try:
        exec(compile(source, 'geocode.py', 'exec'), namespace)
    except Exception:
        traceback.print_exc()
        return 1

    frame_fn = namespace.get('frame')
    if not callable(frame_fn) and namespace.get('image') is None:
        sys.stderr.write('GeoCode: hãy khai báo def frame(t, width, height) hoặc biến image\n')
        return 1

    n_params = 3
    if callable(frame_fn):
        try:
            params = [p for p in inspect.signature(frame_fn).parameters.values()
                      if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
            has_var = any(p.kind == p.VAR_POSITIONAL for p in inspect.signature(frame_fn).parameters.values())
            n_params = 3 if has_var else max(0, min(3, len(params)))
        except (TypeError, ValueError):
            n_params = 3

    bg = None
    if args.bg and args.bg != 'transparent':
        h = args.bg.lstrip('#')
        bg = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)

    warned = {'size': False}

    def to_rgba(value):
        if value is None:
            raise ValueError('frame() trả về None')
        if isinstance(value, Image.Image):
            img = value
        elif hasattr(value, 'savefig') and hasattr(value, 'canvas'):
            # Figure của matplotlib: vẽ ra PNG trong bộ nhớ (giữ nền trong suốt nếu có).
            buf = io.BytesIO()
            value.savefig(buf, format='png', transparent=bg is None)
            buf.seek(0)
            img = Image.open(buf)
            img.load()
        elif hasattr(value, 'shape') and hasattr(value, 'dtype'):
            import numpy as np
            arr = np.asarray(value)
            if arr.dtype.kind == 'f':
                arr = (np.clip(arr, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
            elif arr.dtype != np.uint8:
                arr = np.clip(arr, 0, 255).astype(np.uint8)
            if arr.ndim == 2:
                img = Image.fromarray(arr, 'L')
            elif arr.ndim == 3 and arr.shape[2] in (3, 4):
                img = Image.fromarray(np.ascontiguousarray(arr), 'RGBA' if arr.shape[2] == 4 else 'RGB')
            else:
                raise ValueError(f'mảng numpy phải là HxW, HxWx3 hoặc HxWx4 (nhận {arr.shape})')
        else:
            raise ValueError(f'kiểu kết quả không hỗ trợ: {type(value).__name__} (cần PIL.Image, numpy hoặc Figure)')
        img = img.convert('RGBA')
        if img.size != (width, height):
            if not warned['size']:
                sys.stderr.write(f'GeoCode: khung cỡ {img.size[0]}x{img.size[1]}, co về {width}x{height}\n')
                warned['size'] = True
            img = img.resize((width, height), Image.LANCZOS)
        if bg is not None:
            base = Image.new('RGBA', (width, height), bg)
            base.alpha_composite(img)
            img = base
        return img.tobytes()

    static = namespace.get('image')
    static_bytes = None
    try:
        for i in range(args.frames):
            t = args.start + (i / args.fps if args.kind == 'video' else 0.0)
            if callable(frame_fn):
                call_args = (t, width, height)[:n_params]
                data = to_rgba(frame_fn(*call_args))
            else:
                if static_bytes is None:
                    static_bytes = to_rgba(static)
                data = static_bytes
            out.write(data)
            out.flush()
            # Thả object hình sớm: chuỗi 4K dài giữ hết trong RAM là hết bộ nhớ.
            data = None
    except BrokenPipeError:
        return 3
    except Exception:
        traceback.print_exc()
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
