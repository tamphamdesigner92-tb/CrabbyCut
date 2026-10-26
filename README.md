# CrabbyCut

**Script-driven video editor for Windows. Free and open source (GPL-3.0).**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3%20or%20later-blue.svg)](LICENSE)

[Tiếng Việt](README.vi.md)

Give CrabbyCut a **script** and your **raw footage**. It transcribes the speech with AI,
matches every spoken line to a line in your script, picks the best take when you recorded a
line several times, and lays out a timeline in script order. From there you keep editing like
in any other editor: overlay lanes, text, transitions, color, subtitles, export.

> **Status:** in active development. **The packaged installer is Windows x64 only.** Running
> from source works on Windows and **macOS** (Apple Silicon for transcription).

> **Language note:** the interface is available in English, Vietnamese and Simplified
> Chinese (Settings › General › Interface language). Script matching and Magic Fill
> currently transcribe in **Vietnamese** by default; Auto Subtitle lets you pick Vietnamese,
> English, Chinese, Japanese, Korean or auto-detect.

---

## Contents

- [Features](#features)
- [System requirements](#system-requirements)
- [Install](#install)
- [Run from source](#run-from-source)
- [macOS notes](#macos-notes)
- [Add your own assets](#add-your-own-assets)
- [Where your data lives](#where-your-data-lives)
- [Support the project](#support-the-project)
- [License](#license)

---

## Features

| Area | What it does |
|---|---|
| **Script-driven cut** | Whisper transcription, line-by-line matching against your script, automatic best-take selection, timeline built in script order |
| **Editing** | Multi-lane timeline (video, text, shapes, audio), inspector, keyframes, CapCut-style handles, frame-accurate preview |
| **Magic Fill** | Places B-roll, icons and text templates from your library based on notes in the script |
| **Auto-Reframe** | Tracks people and faces with MediaPipe and reframes the shot when you change aspect ratio |
| **Retouch** | Face smoothing and adjustments driven by a landmark mesh |
| **Color** | Built-in LUTs, import your own `.cube`, per-band HSL, auto color balance |
| **Audio** | Noise reduction, level mixing, real waveforms on the timeline, rule-based auto SFX |
| **Subtitles** | Auto-generated subtitles aligned to the timeline, `.srt` export |
| **Export** | FFmpeg-based, frame-accurate, HDR sources tone-mapped to SDR |
| **Claude control (MCP)** | Optional: let Claude read and edit the timeline of the running app — see [`mcp/README.md`](mcp/README.md) |

---

## System requirements

| | Windows installer | Run from source |
|---|---|---|
| **OS** | Windows 10/11 **64-bit** | Windows 10/11 64-bit, or macOS (see [macOS notes](#macos-notes)) |
| **Free disk** | 6 GB or more for the runtime, plus the Whisper model (1–3 GB) and your projects | Same, plus `node_modules` and the Python venv |
| **GPU** | Optional. An NVIDIA GPU makes transcription much faster (CUDA via CTranslate2) | Same on Windows; Apple Silicon on macOS |
| **Network** | Needed for setup and the first use of each AI feature | Needed for the first `npm start` |
| **Admin rights** | Not needed (per-user install) | Not needed |

Running from source also needs Node.js 20+, Python 3.9–3.12, a C++ toolchain and FFmpeg —
see [Run from source](#run-from-source).

---

## Install

1. Download `CrabbyCut-Setup-<version>.exe` from
   [Releases](https://github.com/tamphamdesigner92-tb/CrabbyCut/releases).
2. Run it. Windows SmartScreen may warn about an unrecognized app because the installer is
   not code-signed: click **More info › Run anyway**.

The installer is **per-user** (`%LOCALAPPDATA%\Programs\CrabbyCut`) and needs no admin rights.
Setup takes about **15 seconds**: it checks your machine (NVIDIA GPU, FFmpeg, Visual C++
Runtime, disk space) and prepares a bundled Python 3.12 and FFmpeg.

### AI libraries download on first use

Editing, preview and export do not need Python, so you can start working right away. Each AI
package downloads only the first time you use the feature that needs it:

| Package | Downloads when you first use | Size |
|---|---|---|
| `asr` | **Transcribe** | ~350 MB (~770 MB with an NVIDIA GPU) |
| `script` | **Filter video by script / Sort by reference script** | ~450 MB |
| `vision` | **Auto-Reframe / Retouch** | ~400 MB |

Progress shows inside the app, and an interrupted download resumes where it stopped. The
Whisper model itself (1–3 GB) is installed separately from inside the app.

---

## Run from source

| | Windows | macOS |
|---|---|---|
| **Node.js** | 20+ | 20+ |
| **Python** | 3.9–3.12 from [python.org](https://www.python.org/downloads/) | 3.9–3.12 — `brew install python@3.12` |
| **C++ toolchain** | Visual Studio 2022 with *Desktop development with C++* | Xcode Command Line Tools — `xcode-select --install` |
| **FFmpeg** on `PATH` | `winget install Gyan.FFmpeg` | `brew install ffmpeg` |

Two traps worth knowing before you install:

- **Don't use Python 3.13+.** MediaPipe has no wheels for it yet. `pip install` still reports
  success but silently skips `mediapipe` and `opencv-contrib-python`, and Auto-Reframe fails
  later with `No module named 'cv2'`. `npm run setup` and `npm run preflight` catch this.
- **FFmpeg needs the `zscale` filter** for HDR tone-mapping. Some builds (gyan.dev
  *essentials*, some Homebrew builds) lack it. Only HDR clips are affected; `npm run setup`
  tells you whether your build has it.

```bash
git clone https://github.com/tamphamdesigner92-tb/CrabbyCut.git
cd CrabbyCut
npm start
```

`npm start` checks what is missing and installs it (Node modules, native addon, C++ sidecar,
Python venv). The first run takes 5–20 minutes because of `torch` and Whisper; later runs
start in well under a second. Run `npm run setup` to see the full status table.

Useful variants:

```bash
npm run setup                    # same checks, full status table
npm run setup -- --skip-python   # build the native parts only, skip the heavy download
CRAB_SKIP_PYTHON=1 npm start     # open the app now, set up AI features later
```

Developer details (architecture, packaging, tests) live in the Vietnamese
[README](README.vi.md),
[`docs/APP_STRUCTURE.md`](docs/APP_STRUCTURE.md) and
[`docs/APP_INTERNALS.md`](docs/APP_INTERNALS.md).

---

## macOS notes

- **There is no macOS installer yet.** On a Mac, run CrabbyCut from source with `npm start`.
- **Transcription needs Apple Silicon (M1 or later).** On macOS the app always uses
  [`mlx_whisper`](https://pypi.org/project/mlx-whisper/) with the
  `mlx-community/whisper-large-v3-turbo` model, running on Metal. MLX has no Intel builds, so on
  an **Intel Mac** transcription (and the script matching built on it) is not
  available yet. Editing, Auto-Reframe, Retouch and export still work.
- **If the preview is blank or WebGL fails**, the Electron binary's signature may have broken
  during `npm install`. `npm start` re-signs it ad hoc (`fix:electron-sign`), so run the app
  with `npm start` rather than `npx electron .`.
- When running from source, settings, the asset library and caches stay **inside the project
  folder**.

---

## Add your own assets

CrabbyCut ships **without** music, sound effects, B-roll or icons: stock licenses almost
never allow redistributing the original files. Copy your own files into the library folder:

| You are using | Library folder |
|---|---|
| Windows installer | `%LOCALAPPDATA%\CrabbyCut\library` |
| Running from source | `library` inside the project folder |

Put files directly inside `Video`, `Elements`, `Music` or `SFXs` (no subfolders, or they won't
show in the Library panel). For Magic Fill to pick a file, start its name with a tag in square
brackets: `[Vid]`, `[Icon]`, `[Illus]`, `[SFXs]` or `[Mus]`, for example
`[Vid] Happy kids - 1.mp4`. Full naming rules (Vietnamese):
[`docs/QUY_UOC_DAT_TEN_TAI_NGUYEN.md`](docs/QUY_UOC_DAT_TEN_TAI_NGUYEN.md).

> Don't copy assets into the install folder (`%LOCALAPPDATA%\Programs\CrabbyCut`): the
> auto-updater wipes it.

---

## Where your data lives

With the Windows installer, **nothing of yours lives in the install folder**:

| What | Where |
|---|---|
| The app | `%LOCALAPPDATA%\Programs\CrabbyCut` |
| Settings, library, reports, caches | `%LOCALAPPDATA%\CrabbyCut` |
| Python runtime + FFmpeg | `%LOCALAPPDATA%\CrabbyCut\runtime` |
| Whisper models | `%LOCALAPPDATA%\AI Video Auto Cutter\asr_models` |

Uninstalling **asks** before it removes the AI runtime, so you can keep it and skip the
download next time.

---

## Support the project

CrabbyCut is free. If it saves you editing time, you can
[buy me a coffee](https://buymeacoffee.com/tampham.92) or use the **Sponsor** button on GitHub.

---

## License

Copyright © 2026 Tam Pham — <tampham.designer92@gmail.com>

CrabbyCut is free software: you can redistribute it and/or modify it under the terms of the
**GNU General Public License** as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version. See [`LICENSE`](LICENSE).

It is distributed in the hope that it will be useful, but **without any warranty**; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

- **Why not GPLv2:** several dependencies (`torch`, `mediapipe`, `opencv-contrib-python`,
  `huggingface-hub`, `requests`, `tokenizers`, `jax`, `jaxlib`) are Apache-2.0, which is not
  compatible with GPLv2. The FFmpeg build the installer uses is also GPLv3.
- **NVIDIA CUDA exception:** an additional permission under GPLv3 §7 covers NVIDIA's CUDA
  libraries — see [`LICENSE-EXCEPTION.md`](LICENSE-EXCEPTION.md). CrabbyCut does not
  redistribute them; `pip` downloads them on your machine, and only when an NVIDIA GPU is found.
- **FFmpeg:** CrabbyCut does not link FFmpeg. It runs `ffmpeg` and `ffprobe` as separate
  processes. The installer downloads a pinned, SHA-256-checked FFmpeg 8.1.1 build with CUDA
  filters (GPL-3.0-or-later); build scripts and patches are in
  [ffmpeg-for-CrabbyCut](https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut).
- **Media is not covered by this license.** Fonts in `static/fonts/google/` keep their own
  licenses (OFL-1.1, Apache-2.0, UFL-1.0 — see
  [`FONTS_MANIFEST.md`](static/fonts/google/FONTS_MANIFEST.md)). Assets you add to `library/`
  keep theirs.

Full third-party credits: [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
