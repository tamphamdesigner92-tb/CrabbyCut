# CrabbyCut

**Script-driven video editor for Windows. Free and open source (GPL-3.0).**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3%20or%20later-blue.svg)](LICENSE)

[Tiếng Việt](README.md)

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
- [Install](#install)
- [Run from source](#run-from-source)
- [Add your own assets](#add-your-own-assets)
- [Support the project](#support-the-project)

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

## Install

1. Download `CrabbyCut Setup <version>.exe` from
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

You need Windows 10/11 64-bit and at least 6 GB of free disk space. An NVIDIA GPU is optional
but makes transcription much faster.

---

## Run from source

You need Node.js 20+, Python **3.9–3.12** (not 3.13+, MediaPipe has no wheels for it), a C++
toolchain (Visual Studio 2022 with *Desktop development with C++* on Windows, Xcode Command
Line Tools on macOS) and FFmpeg on your `PATH`.

```bash
git clone https://github.com/tamphamdesigner92-tb/CrabbyCut.git
cd CrabbyCut
npm start
```

`npm start` checks what is missing and installs it (Node modules, native addon, C++ sidecar,
Python venv). The first run takes 5–20 minutes because of `torch` and Whisper; later runs
start in well under a second. Run `npm run setup` to see the full status table.

Developer details live in the Vietnamese [README](README.md),
[`docs/APP_STRUCTURE.md`](docs/APP_STRUCTURE.md) and
[`docs/APP_INTERNALS.md`](docs/APP_INTERNALS.md).

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

## Support the project

CrabbyCut is free. If it saves you editing time, you can
[buy me a coffee](https://buymeacoffee.com/tampham.92) or use the **Sponsor** button on GitHub.

---

Copyright © 2026 Tam Pham. Licensed under the
[GNU General Public License v3.0 or later](LICENSE).
