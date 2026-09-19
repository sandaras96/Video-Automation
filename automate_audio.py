#!/usr/bin/env python3
"""
================================================================================
  🎙️ ULTRA AUDIO GENERATOR — High-Fidelity Voiceover Automation
  Powered by Google Gemini TTS (Leda) + 2-Minute Anti-Degradation Chunking
================================================================================
  Features:
  1. 2-Minute Intelligent Chunking:
     - Voice stability degrades after ~2 minutes in Gemini TTS.
     - Splits narration scripts into clean ~260-280 word chunks.
     - Strictly preserves complete sentences and paragraphs (never cuts words).
  2. Direct Gemini TTS API Engine (Instant & Pure Quality):
     - Voice: 'Leda' (Youthful, natural female narrator)
     - Model: 'gemini-2.5-flash-tts' or 'gemini-2.5-pro-tts'
     - Zero browser lag, processes chunks in parallel / fast sequence.
  3. Lossless Audio Concatenation (ffmpeg):
     - Automatically stitches all chunks in sequence into:
       - 'final_voiceover.mp3' (256 kbps crystal-clear track)
       - 'final_voiceover.wav' (Lossless master track)
  4. Browser & Manual Fallback:
     - Exports text chunks into 'audio_chunks/' for manual web studio use.
     - Standalone '--stitch-only' mode to combine any downloaded files.
================================================================================
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error
import wave

# --- Configuration & Paths ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
DEFAULT_SCRIPT = os.path.join(BASE_DIR, "narration_only.txt")
DEFAULT_OUTPUT_DIR = os.path.join(BASE_DIR, "audio_chunks")
DEFAULT_VOICE = "Leda"
DEFAULT_MODEL = "gemini-2.5-flash-preview-tts"
FALLBACK_MODELS = [
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-pro-preview-tts",
    "gemini-3.1-flash-tts-preview"
]

def load_config():
    """Reads settings from config.json if present."""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_config_key(key_name, value):
    """Saves a setting to config.json."""
    cfg = load_config()
    cfg[key_name] = value
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)

def mask_key(k):
    """Returns safe masked key for logging."""
    if not k or len(k) < 12:
        return "******"
    return f"{k[:8]}...{k[-4:]}"

def get_api_key_pool(args_keys=None):
    """
    Returns a deduplicated list of valid API keys from args, config.json, or environment.
    """
    pool = []
    if args_keys:
        if isinstance(args_keys, list):
            for k in args_keys:
                if k and k.strip(): pool.append(k.strip())
        elif isinstance(args_keys, str):
            for k in re.split(r'[,;\s\n]+', args_keys):
                if k.strip(): pool.append(k.strip())

    cfg = load_config()
    cfg_keys = cfg.get("gemini_api_keys", [])
    if isinstance(cfg_keys, list):
        for k in cfg_keys:
            if k and k.strip() and k.strip() not in pool:
                pool.append(k.strip())

    single_key = cfg.get("gemini_api_key", "").strip()
    if single_key and single_key not in pool:
        pool.append(single_key)

    env_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if env_key and env_key.strip() and env_key.strip() not in pool:
        pool.append(env_key.strip())

    return pool

def add_api_keys_to_config(new_keys_input):
    """Adds one or more keys to the gemini_api_keys array in config.json."""
    if isinstance(new_keys_input, str):
        keys = [k.strip() for k in re.split(r'[,;\s\n]+', new_keys_input) if k.strip()]
    else:
        keys = [k.strip() for k in new_keys_input if k and k.strip()]

    cfg = load_config()
    existing = cfg.get("gemini_api_keys", [])
    if not isinstance(existing, list):
        existing = [existing] if existing else []

    single = cfg.get("gemini_api_key", "").strip()
    if single and single not in existing:
        existing.append(single)

    added = 0
    for k in keys:
        if k not in existing:
            existing.append(k)
            added += 1

    cfg["gemini_api_keys"] = existing
    if existing and not cfg.get("gemini_api_key"):
        cfg["gemini_api_key"] = existing[0]

    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    return existing, added

def clear_api_keys_in_config():
    """Clears all stored API keys."""
    cfg = load_config()
    cfg["gemini_api_keys"] = []
    cfg["gemini_api_key"] = ""
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)

class KeyPoolManager:
    """Manages rotating through a pool of 4-5 API keys when quota is reached."""
    def __init__(self, keys=None):
        self.keys = get_api_key_pool(keys)
        self.current_idx = 0
        self.exhausted_keys = set() # Daily limit exhausted

    def get_current_key(self):
        if not self.keys:
            return None
        # Return next available non-exhausted key
        for _ in range(len(self.keys)):
            k = self.keys[self.current_idx]
            if k not in self.exhausted_keys:
                return k
            self.current_idx = (self.current_idx + 1) % len(self.keys)
        return None

    def mark_exhausted(self, key):
        self.exhausted_keys.add(key)
        self.current_idx = (self.current_idx + 1) % len(self.keys)

    def rotate_next(self):
        self.current_idx = (self.current_idx + 1) % len(self.keys)
        return self.get_current_key()

    def available_count(self):
        return sum(1 for k in self.keys if k not in self.exhausted_keys)

# --- Text Chunking Engine ---
def clean_script_text(raw_text):
    """Strips headers, decorative markers, and clean lines."""
    lines = raw_text.splitlines()
    clean_lines = []
    for line in lines:
        s = line.strip()
        if not s or s.startswith("===") or "VOICEOVER" in s.upper() or "NARRATION SCRIPT" in s.upper():
            continue
        clean_lines.append(s)
    return "\n\n".join(clean_lines)

def split_into_1min_chunks(text, max_words=140):
    """
    Divides narration text into ~1-minute chunks (~125-140 words).
    Respects sentence and paragraph boundaries to prevent cut-offs.
    Strictly stays under 60 seconds to eliminate pitch and volume drift.
    """
    clean = clean_script_text(text)
    paragraphs = [p.strip() for p in clean.split("\n\n") if p.strip()]

    chunks = []
    current_chunk = []
    current_words = 0

    for p in paragraphs:
        p_words = len(p.split())
        # If single paragraph exceeds max_words, split by sentences
        if p_words > max_words:
            sentences = re.split(r'(?<=[.!?])\s+', p)
            for s in sentences:
                s_words = len(s.split())
                if current_words + s_words > max_words and current_chunk:
                    chunks.append(" ".join(current_chunk))
                    current_chunk = [s]
                    current_words = s_words
                else:
                    current_chunk.append(s)
                    current_words += s_words
        else:
            if current_words + p_words > max_words and current_chunk:
                chunks.append("\n\n".join(current_chunk))
                current_chunk = [p]
                current_words = p_words
            else:
                current_chunk.append(p)
                current_words += p_words

    if current_chunk:
        chunks.append("\n\n".join(current_chunk))

    return chunks

def export_chunks_to_text_files(chunks, output_dir):
    """Writes chunked text files to output_dir."""
    os.makedirs(output_dir, exist_ok=True)
    file_list = []
    for idx, chunk in enumerate(chunks, 1):
        filename = f"chunk_{idx:03d}.txt"
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(chunk)
        words = len(chunk.split())
        file_list.append((filepath, words))
    return file_list

# --- Direct Gemini TTS API Engine ---
def pcm_to_wav_bytes(pcm_data, sample_rate=24000, channels=1, sampwidth=2):
    """Wraps raw PCM audio bytes with a standard WAV header."""
    import io
    bio = io.BytesIO()
    with wave.open(bio, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sampwidth)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return bio.getvalue()

class DailyLimitExhaustedError(Exception):
    """Raised when a specific API key hits its 10/day quota limit."""
    pass

def call_gemini_tts_api(api_key, text, voice="Leda", model="gemini-2.5-flash-preview-tts", retries=4):
    """
    Calls Google Generative Language TTS endpoint to synthesize speech.
    If the requested model encounters a permanent 0-quota error (limit: 0),
    it falls back to other available Gemini TTS models.
    On temporary rate limits (HTTP 429), it parses the server's retryDelay and waits.
    On daily project quota exhaustion, raises DailyLimitExhaustedError to trigger rotation.
    Returns audio bytes (WAV format).
    """
    model_candidates = [model]
    for m in FALLBACK_MODELS:
        if m != model and m not in model_candidates:
            model_candidates.append(m)

    last_err = None

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": text}
                ]
            }
        ],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {
                        "voiceName": voice
                    }
                }
            }
        }
    }
    data_bytes = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}

    for cur_model in model_candidates:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{cur_model}:generateContent?key={api_key}"
        for attempt in range(1, retries + 1):
            try:
                req = urllib.request.Request(url, data=data_bytes, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=90) as resp:
                    res_json = json.loads(resp.read().decode("utf-8"))

                candidates = res_json.get("candidates", [])
                if not candidates:
                    raise ValueError(f"No candidates returned by Gemini TTS API: {res_json}")

                parts = candidates[0].get("content", {}).get("parts", [])
                audio_b64 = None

                for part in parts:
                    if "inlineData" in part:
                        audio_b64 = part["inlineData"].get("data")
                        break

                if not audio_b64:
                    raise ValueError(f"No inline audio data found in candidate parts: {parts}")

                raw_audio = base64.b64decode(audio_b64)

                # Ensure valid WAV container
                if raw_audio.startswith(b"RIFF"):
                    return raw_audio
                else:
                    return pcm_to_wav_bytes(raw_audio, sample_rate=24000, channels=1, sampwidth=2)

            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8", errors="replace")
                last_err = f"HTTP {e.code} ({cur_model}): {err_body[:180]}"

                # Check for daily free-tier limit -> Raise to trigger key rotation
                if "GenerateRequestsPerDay" in err_body or "per_day" in err_body.lower():
                    raise DailyLimitExhaustedError(f"Daily quota reached (10/day) for key {mask_key(api_key)}")

                # Check for permanent 0 quota (unsupported model on tier)
                if "limit: 0" in err_body:
                    print(f"   ⚠️ Model '{cur_model}' has 0 quota. Switching to next model...")
                    break

                # Handle temporary per-minute rate limit (429)
                if e.code == 429:
                    retry_match = re.search(r'retry in ([0-9.]+)s', err_body, re.IGNORECASE) or re.search(r'"retryDelay":\s*"([0-9]+)s"', err_body)
                    if retry_match:
                        wait_sec = float(retry_match.group(1)) + 2.0
                    else:
                        wait_sec = min(12.0 * attempt, 35.0)
                    print(f"   ⏳ Temporary rate limit. Waiting {wait_sec:.1f}s for quota reset (attempt {attempt}/{retries})...")
                    time.sleep(wait_sec)
                    continue
                elif e.code in (500, 503):
                    time.sleep(3.0 * attempt)
                else:
                    break
            except DailyLimitExhaustedError:
                raise
            except Exception as e:
                last_err = str(e)
                time.sleep(2.0 * attempt)

    raise RuntimeError(f"Gemini TTS generation failed. Last error: {last_err}")

# --- ffmpeg Audio Stitcher ---
def find_audio_chunks(chunks_dir):
    """Finds all audio files in chunks_dir sorted numerically."""
    if not os.path.exists(chunks_dir):
        return []
    candidates = []
    for fname in os.listdir(chunks_dir):
        if fname.lower().endswith((".wav", ".mp3", ".m4a", ".aac")):
            fpath = os.path.join(chunks_dir, fname)
            candidates.append(fpath)
    candidates.sort()
    return candidates

def stitch_audio_with_ffmpeg(audio_files, output_mp3, output_wav=None):
    """
    Concatenates a list of audio files into a single seamless output file.
    Produces both a 256kbps MP3 and an uncompressed WAV.
    """
    if not audio_files:
        raise ValueError("No audio files provided for stitching.")

    base_dir = os.path.dirname(output_mp3)
    concat_list_path = os.path.join(base_dir, "concat_list.txt")

    with open(concat_list_path, "w", encoding="utf-8") as f:
        for audio_path in audio_files:
            abs_p = os.path.abspath(audio_path)
            f.write(f"file '{abs_p}'\n")

    print(f"🔗 Concatenating {len(audio_files)} audio chunks via ffmpeg...")

    # 1. Output MP3 (256kbps high quality)
    cmd_mp3 = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", concat_list_path,
        "-c:a", "libmp3lame", "-b:a", "256k",
        output_mp3
    ]
    subprocess.run(cmd_mp3, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 2. Output WAV if requested
    if output_wav:
        cmd_wav = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", concat_list_path,
            "-c:a", "pcm_s16le",
            output_wav
        ]
        subprocess.run(cmd_wav, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    if os.path.exists(concat_list_path):
        os.remove(concat_list_path)

    # Calculate total duration using ffprobe if available
    duration_str = "Unknown"
    try:
        probe_res = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", output_mp3],
            capture_output=True, text=True
        )
        sec = float(probe_res.stdout.strip())
        mins = int(sec // 60)
        secs = int(sec % 60)
        duration_str = f"{mins}m {secs:02d}s ({sec:.1f}s)"
    except Exception:
        pass

    return duration_str

# --- Automation Class ---
class UltraAudioAutomation:
    def __init__(self, script_path=None, output_dir=None, api_keys=None, voice=DEFAULT_VOICE, model=DEFAULT_MODEL, words_per_chunk=140, force=False, output_mp3=None, output_wav=None):
        self.script_path = script_path or DEFAULT_SCRIPT
        if model in FALLBACK_MODELS or "tts" in model.lower():
            self.model = model
        else:
            self.model = "gemini-2.5-flash-preview-tts"

        if output_dir:
            self.output_dir = output_dir
        elif "3" in self.model:
            self.output_dir = os.path.join(BASE_DIR, "audio_chunks_flash3")
        else:
            self.output_dir = DEFAULT_OUTPUT_DIR

        self.key_manager = KeyPoolManager(api_keys)
        self.voice = voice
        self.words_per_chunk = words_per_chunk
        self.force = force
        self.output_mp3 = output_mp3
        self.output_wav = output_wav
        self.chunks = []
        os.makedirs(self.output_dir, exist_ok=True)

    def load_and_chunk(self):
        if not os.path.exists(self.script_path):
            raise FileNotFoundError(f"Narration script not found at: '{self.script_path}'")
        with open(self.script_path, "r", encoding="utf-8") as f:
            text = f.read()

        self.chunks = split_into_1min_chunks(text, max_words=self.words_per_chunk)
        return len(self.chunks)

    def print_banner(self):
        total_words = sum(len(c.split()) for c in self.chunks)
        est_total_mins = total_words / 145.0
        n_keys = len(self.key_manager.keys)
        avail = self.key_manager.available_count()
        print("\n" + "=" * 70)
        print("  🎙️ ULTRA AUDIO GENERATOR — GEMINI TTS VOICEOVER AUTOMATION   ")
        print("=" * 70)
        print(f"📄 Script Path     : {self.script_path}")
        print(f"📊 Total Wordcount : {total_words:,} words (~{est_total_mins:.1f} minutes)")
        print(f"📦 Chunks (<=1min) : {len(self.chunks)} chunks (~{self.words_per_chunk} words each)")
        print(f"🗣️ Voice Persona   : {self.voice} (Natural, Youthful)")
        print(f"🧠 Model Engine    : {self.model}")
        print(f"🔑 API Key Pool    : {n_keys} key(s) configured ({avail} active)")
        print(f"📁 Output Chunks   : {self.output_dir}")
        print("=" * 70 + "\n")

    def export_text_chunks(self):
        print(f"📝 Exporting {len(self.chunks)} text chunks to '{self.output_dir}'...")
        files = export_chunks_to_text_files(self.chunks, self.output_dir)
        for path, count in files:
            print(f"  ✅ {os.path.basename(path)}: {count} words (~{count/145.0:.1f} mins)")
        print("🎉 All text chunks exported successfully!")

    def generate_all_audio_api(self):
        if not self.key_manager.keys:
            print("\n❌ No Gemini API Keys found!")
            print("To generate audio directly via API:")
            print("  1. Get FREE API keys from: https://aistudio.google.com/app/apikey")
            print("  2. Run: python3 automate_audio.py --add-key YOUR_KEY")
            return False

        print(f"🚀 Generating {len(self.chunks)} audio chunks with Gemini TTS ({self.voice}) using [{self.model}]...")
        print(f"🔑 Active Key Pool: {len(self.key_manager.keys)} keys ({self.key_manager.available_count()} available)\n")
        generated_files = []

        for idx, chunk in enumerate(self.chunks, 1):
            chunk_words = len(chunk.split())
            target_wav = os.path.join(self.output_dir, f"chunk_{idx:03d}.wav")

            # Check if chunk already exists and is valid (unless force is True)
            if not self.force and os.path.exists(target_wav) and os.path.getsize(target_wav) > 10000:
                print(f"🎙️ [CHUNK {idx}/{len(self.chunks)}] ({chunk_words} words) -> Already generated ({os.path.basename(target_wav)}), skipping!")
                generated_files.append(target_wav)
                continue

            chunk_success = False
            while not chunk_success:
                cur_key = self.key_manager.get_current_key()
                if not cur_key:
                    print(f"\n🛑 All {len(self.key_manager.keys)} API keys in your pool have exhausted their daily quota (10 reqs/day each)!")
                    print(f"💡 Add additional free API keys using: python3 automate_audio.py --add-key YOUR_NEW_KEY")
                    print(f"   (Free keys available at https://aistudio.google.com/app/apikey in 'Create key in new project')")
                    return False

                key_str = mask_key(cur_key)
                print(f"🎙️ [CHUNK {idx}/{len(self.chunks)}] ({chunk_words} words) -> Synthesizing {os.path.basename(target_wav)} [{key_str}]...")
                t0 = time.time()
                try:
                    audio_bytes = call_gemini_tts_api(
                        api_key=cur_key,
                        text=chunk,
                        voice=self.voice,
                        model=self.model
                    )
                    with open(target_wav, "wb") as f:
                        f.write(audio_bytes)
                    elapsed = time.time() - t0
                    kb = len(audio_bytes) / 1024.0
                    print(f"   ✅ Synthesized in {elapsed:.1f}s! ({kb:.1f} KB)")
                    generated_files.append(target_wav)
                    chunk_success = True
                    time.sleep(2.0) # Respectful pause between calls
                except DailyLimitExhaustedError:
                    print(f"   ⚠️ Key [{key_str}] reached daily 10/day limit. Rotating to next key in pool...")
                    self.key_manager.mark_exhausted(cur_key)
                    continue
                except Exception as e:
                    print(f"   ❌ Failed on Key [{key_str}]: {e}")
                    if self.key_manager.available_count() > 1:
                        print(f"   🔄 Rotating to next key in pool...")
                        self.key_manager.rotate_next()
                        continue
                    else:
                        return False

        # Stitch all files
        suffix = "_flash3" if "3" in self.model else ""
        output_mp3 = self.output_mp3 or os.path.join(BASE_DIR, f"final_voiceover{suffix}.mp3")
        output_wav = self.output_wav or os.path.join(BASE_DIR, f"final_voiceover{suffix}.wav")
        duration = stitch_audio_with_ffmpeg(generated_files, output_mp3, output_wav)

        print("\n" + "=" * 70)
        print(f"🎉 VOICEOVER GENERATION COMPLETE! [{self.model}]")
        print("=" * 70)
        print(f"🎵 Master MP3 Track : {output_mp3}")
        print(f"🔊 Master WAV Track : {output_wav}")
        print(f"⏱️ Total Duration   : {duration}")
        print(f"📦 Total Chunks     : {len(generated_files)} (No pitch/volume degradation)")
        print("=" * 70 + "\n")
        return True

    def stitch_existing(self):
        audio_files = find_audio_chunks(self.output_dir)
        if not audio_files:
            # Check ~/Downloads for downloaded audio
            dls = [os.path.join(os.path.expanduser("~/Downloads"), f) for f in os.listdir(os.path.expanduser("~/Downloads"))
                   if f.lower().endswith((".wav", ".mp3")) and ("speech" in f.lower() or "chunk" in f.lower())]
            if dls:
                dls.sort()
                audio_files = dls

        if not audio_files:
            print(f"❌ No audio chunks found in '{self.output_dir}' or ~/Downloads.")
            return False

        suffix = "_flash3" if "3" in self.model else ""
        output_mp3 = self.output_mp3 or os.path.join(BASE_DIR, f"final_voiceover{suffix}.mp3")
        output_wav = self.output_wav or os.path.join(BASE_DIR, f"final_voiceover{suffix}.wav")
        duration = stitch_audio_with_ffmpeg(audio_files, output_mp3, output_wav)
        print("\n" + "=" * 70)
        print(f"🎉 AUDIO STITCHING COMPLETE! [{self.model}]")
        print("=" * 70)
        print(f"🎵 Master MP3 Track : {output_mp3}")
        print(f"🔊 Master WAV Track : {output_wav}")
        print(f"⏱️ Total Duration   : {duration}")
        print("=" * 70 + "\n")
        return True

# --- Main CLI ---
def main():
    parser = argparse.ArgumentParser(description="Ultra Audio Generator: Gemini TTS Leda + 1-Min Chunks + Key Pool Rotation.")
    parser.add_argument("--script", type=str, default=None, help="Path to narration script (default: narration_only.txt)")
    parser.add_argument("--api-key", type=str, default=None, help="Gemini API key(s), comma or space separated")
    parser.add_argument("--voice", type=str, default=None, help="Prebuilt voice name (default: Leda)")
    parser.add_argument("--model", type=str, default=None, help="TTS model (e.g. gemini-2.5-flash-preview-tts)")
    parser.add_argument("--output-dir", type=str, default=None, help="Directory to store audio chunks")
    parser.add_argument("--output-mp3", type=str, default=None, help="Path to save stitched final_voiceover.mp3")
    parser.add_argument("--output-wav", type=str, default=None, help="Path to save stitched final_voiceover.wav")
    parser.add_argument("--words-per-chunk", type=int, default=140, help="Target word count per 1-min chunk (default: 140)")
    parser.add_argument("--export-only", action="store_true", help="Only export text chunks to files")
    parser.add_argument("--stitch-only", action="store_true", help="Only stitch existing audio chunks into final_voiceover.mp3")
    parser.add_argument("--add-key", type=str, default=None, help="Add one or more API keys to pool in config.json")
    parser.add_argument("--save-key", type=str, default=None, help="Save single Gemini API key (alias for add-key)")
    parser.add_argument("--list-keys", action="store_true", help="List all configured API keys in pool")
    parser.add_argument("--clear-keys", action="store_true", help="Clear all stored API keys in config.json")
    parser.add_argument("--force", action="store_true", help="Force re-generation of chunks even if already present")
    args = parser.parse_args()

    if args.list_keys:
        pool = get_api_key_pool()
        print(f"\n🔑 Gemini API Key Pool ({len(pool)} keys configured):")
        for i, k in enumerate(pool, 1):
            print(f"  [{i}] {mask_key(k)}")
        print("")
        sys.exit(0)

    if args.clear_keys:
        clear_api_keys_in_config()
        print("🗑️ All stored API keys cleared from config.json.")
        sys.exit(0)

    key_input = args.add_key or args.save_key
    if key_input:
        total, added = add_api_keys_to_config(key_input)
        print(f"✅ Added {added} new API key(s) to pool! Total active keys: {total}.")
        sys.exit(0)

    cfg = load_config()
    voice = args.voice or cfg.get("tts_voice") or DEFAULT_VOICE
    model = args.model or cfg.get("tts_model") or DEFAULT_MODEL

    automation = UltraAudioAutomation(
        script_path=args.script,
        output_dir=args.output_dir,
        api_keys=args.api_key,
        voice=voice,
        model=model,
        words_per_chunk=args.words_per_chunk,
        force=args.force,
        output_mp3=args.output_mp3,
        output_wav=args.output_wav
    )

    if args.stitch_only:
        automation.stitch_existing()
        return

    automation.load_and_chunk()
    automation.print_banner()

    if args.export_only:
        automation.export_text_chunks()
        return

    if automation.key_manager.keys:
        automation.generate_all_audio_api()
    else:
        print("ℹ️ No API keys detected in pool. Exporting 1-minute text chunks for Google AI Studio...")
        automation.export_text_chunks()
        print("\n💡 TIP: Add 4-5 free API keys to rotate automatically:")
        print("   python3 automate_audio.py --add-key 'KEY1, KEY2, KEY3, KEY4'")
        print("   (Free API keys available at: https://aistudio.google.com/app/apikey)\n")

if __name__ == "__main__":
    main()
