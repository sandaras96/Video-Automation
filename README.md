# 🎬 Ultra Studio — Video Automation Pipeline

An automated, high-retention long-form YouTube video production studio and pipeline. Coordinates AI script generation, structured prompt extraction, Gemini TTS voiceover synthesis, dynamic Omni Flash visual hook generation, 1K/2K infographic illustration rendering via Google Flow, and hardware-accelerated 1080p audio-visual timeline synchronization.

---

## 🌟 Key Features

- **📝 Gemini Pro Script Generation**: Generates 2,500+ word retention-optimized scripts following a proven retention architecture (Cold Open Hook, Open Loops, Value Blocks, Myth-Busters, and Emotional Stakes).
- **✂️ Narration & Prompt Extraction**: Automatically splits voiceover text from 2.5D infographic illustration prompts and dynamic hook video prompts.
- **🎙️ Lossless Gemini TTS Audio**: Synthesizes high-fidelity voiceover chunks using Gemini TTS personas (`Leda`, `Aoede`, `Zephyr`, `Orpheus`) with sentence-snapping to prevent audio degradation.
- **🎥 1-Minute Dynamic Visual Hooks**: Automates 7 cinematic 3D animation clips (Cold Open + Open Loops) using Omni Flash.
- **🖼️ 1K/2K Flow Infographics**: Renders high-resolution 2.5D clean vector-style medical/educational illustrations via Google Flow.
- **🎬 Hardware-Accelerated 1080p Master Sync**: Intelligently aligns visual clips to voiceover cadence, acoustic breath pauses, and exports a master 1080p 60fps MP4.
- **🌐 Interactive Web Studio GUI**: Modern glassmorphic dark-theme dashboard featuring:
  - Real-time pipeline progress & SSE live log streaming.
  - Native macOS Finder folder picker & in-app folder creator.
  - Single topic and batch queue processing.
  - Integrated media inspector for video, audio, visuals gallery, and scripts.

---

## 🚀 Quick Start

### 1. Prerequisites
- **macOS** (with Apple Silicon or Intel)
- **Python 3.9+**
- **Node.js / npm** (optional, for `npm run dev`)
- **FFmpeg** (`brew install ffmpeg`)
- **Google Chrome** (for Flow & Omni automation with CDP remote debugging)

### 2. Setup Configuration
Copy `config.example.json` to `config.json` and insert your Gemini API key(s):
```bash
cp config.example.json config.json
```
Edit `config.json`:
```json
{
  "default_profile": "Menaka Gemini Pro",
  "tts_voice": "Leda",
  "tts_model": "gemini-2.5-flash-preview-tts",
  "gemini_api_key": "YOUR_GEMINI_API_KEY",
  "gemini_api_keys": [
    "YOUR_GEMINI_API_KEY_1",
    "YOUR_GEMINI_API_KEY_2"
  ]
}
```

### 3. Launch the Web Studio
You can start the studio using any of the following methods:

- **Double-click**: `run_gui.command` in Finder (starts server and opens your browser)
- **Using npm**:
  ```bash
  npm run dev
  ```
- **Using Python**:
  ```bash
  python3 server.py
  ```

Open your browser to: **[http://localhost:5050](http://localhost:5050)**

---

## 📁 Pipeline Workflow

```
Video Topic
    │
    ▼
1. Gemini Pro Script ─────────► 2,500+ word retention script
    │
    ▼
2. Extraction ────────────────► Clean narration + Visual prompts
    │
    ├─────────────────────────┬─────────────────────────┐
    ▼                         ▼                         ▼
3. Gemini TTS Audio     4. Omni Flash Hooks       5. Flow 1K/2K Images
 (Lossless voiceover)   (7 dynamic 3D clips)     (2.5D illustrations)
    │                         │                         │
    └─────────────────────────┼─────────────────────────┘
                              ▼
                   6. 1080p Master Sync & Render
                              │
                              ▼
                     final_video_1080p.mp4
```

---

## 🛠️ Tech Stack

- **Backend**: Python 3, `ThreadingHTTPServer`, Server-Sent Events (SSE), AppleScript (`osascript`)
- **Frontend**: Vanilla HTML5, Modern CSS Glassmorphism, Vanilla JavaScript
- **Video / Audio Processing**: FFmpeg (hardware-accelerated H.264 / ProRes)
- **OCR Helper**: Swift Vision framework native binary
- **AI Models**: Google Gemini Pro, Gemini 2.5 Flash Preview TTS, Omni Flash, Google Flow

---

## 📄 License

MIT License.
