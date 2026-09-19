#!/usr/bin/env python3
"""
================================================================================
  🎬 ULTRA VIDEO SYNC — Hybrid Audio-Visual 1080P Video Exporter
  Synchronizes 2.5D Infographic Images & 3D Video Clips with Speech Narration
================================================================================
  Features:
  1. Hybrid Media Timeline (MP4 Videos + JPG Images):
     - Automatically detects 3D medical animation videos and 2.5D infographic images.
     - Maps the 7 Google Flow video clips to the 1-minute visual hook (scenes 1-7).
     - Dynamically time-stretches video clips (setpts) to match exact sentence durations.
  2. Zero-Drift Multi-Chunk Synchronization:
     - Maps audio chunks (chunk_001.wav to chunk_013.wav) to the 57 narration pairs.
     - Hard resets timing at every chunk boundary to eliminate cumulative drift.
  3. Acoustic Silence / Breath-Pause Snapping:
     - Scans PCM audio waveforms to find natural pauses between sentences (RMS minimums).
     - Snaps cuts directly to silences so visual transitions never occur mid-word.
  4. Broadcast-Grade Lossless Segment Concatenation:
     - Normalizes all media into uniform 1080p 30fps H.264 transport streams (.ts)
       using Apple Silicon hardware acceleration (h264_videotoolbox).
     - Losslessly stitches all segments and merges master studio voiceover audio.
================================================================================
"""

import argparse
import glob
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import wave

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_IMAGES_DIR = os.path.expanduser("~/Downloads/project 1")
DEFAULT_AUDIO_WAV = os.path.join(BASE_DIR, "final_voiceover.wav")
DEFAULT_AUDIO_MP3 = os.path.join(BASE_DIR, "final_voiceover.mp3")
DEFAULT_CHUNKS_DIR = os.path.join(BASE_DIR, "audio_chunks")
DEFAULT_SCRIPT_FILE = os.path.join(BASE_DIR, "narration_only.txt")
DEFAULT_OUTPUT_FILE = os.path.join(BASE_DIR, "final_video_1080p.mp4")

# --- Media Duration Inspection ---
def get_media_duration(file_path):
    """Returns the duration of a video or audio file in seconds via ffprobe."""
    try:
        cmd = [
            "ffprobe", "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            file_path
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return float(res.stdout.strip())
    except Exception:
        return 8.0  # Safe fallback for Google Flow clips

# --- Sentence Extraction & Parsing ---
def extract_raw_sentences_from_text(text):
    """Splits raw text into clean, protected sentences."""
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("=")]
    clean_text = " ".join(lines)

    abbrevs = [
        "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "vs.", "e.g.", "i.e.", "U.S.",
        "No.", "vol.", "etc.", "approx.", "al.", "min.", "sec.", "meds.", "BP."
    ]
    protected = clean_text
    for i, a in enumerate(abbrevs):
        protected = protected.replace(a, f"__ABBR_{i}__")

    split_pattern = r'(?<=[.!?])\s+(?=[A-Z0-9\"\'“‘])|(?<=[.!?][\"\'”’])\s+(?=[A-Z0-9\"\'“‘])'
    raw_splits = re.split(split_pattern, protected)

    sentences = []
    for s in raw_splits:
        for i, a in enumerate(abbrevs):
            s = s.replace(f"__ABBR_{i}__", a)
        s = s.strip()
        s = re.sub(r"^\s*[-—–]\s*", "", s)
        if s and len(s) > 3:
            sentences.append(s)

    return sentences

def extract_raw_sentences(script_path):
    """Loads clean sentences from narration_only.txt or script file."""
    if not os.path.exists(script_path):
        raise FileNotFoundError(f"Script file '{script_path}' not found.")

    with open(script_path, "r", encoding="utf-8") as f:
        text = f.read()

    return extract_raw_sentences_from_text(text)

# --- Acoustic Waveform Analysis ---
def find_nearest_silence_in_wav(wav_path, target_time, search_window=1.2):
    """
    Scans PCM WAV samples around target_time within search_window (seconds).
    Finds the exact timestamp with minimum RMS energy (natural breath pause).
    """
    try:
        with wave.open(wav_path, 'r') as w:
            rate = w.getframerate()
            nframes = w.getnframes()
            sampwidth = w.getsampwidth()
            nchannels = w.getnchannels()
            raw = w.readframes(nframes)

        if sampwidth == 2:
            fmt = f"<{nframes * nchannels}h"
            samples = struct.unpack(fmt, raw)
            if nchannels > 1:
                samples = samples[::nchannels]
        else:
            return target_time

        win_size = int(rate * 0.05)  # 50ms window
        step = int(rate * 0.02)      # 20ms step
        min_idx = max(0, int((target_time - search_window) * rate))
        max_idx = min(len(samples) - win_size, int((target_time + search_window) * rate))

        if min_idx >= max_idx:
            return target_time

        best_time = target_time
        min_rms = float("inf")

        for i in range(min_idx, max_idx, step):
            win = samples[i:i+win_size]
            rms = math.sqrt(sum(s*s for s in win) / float(win_size))
            if rms < min_rms:
                min_rms = rms
                best_time = (i + win_size / 2.0) / float(rate)

        return best_time
    except Exception:
        return target_time

# --- Intelligent Timeline Builder with Video & Image Support ---
def build_synchronized_timeline(chunks_dir, images_dir, script_sentences=None, enable_pause_snapping=True):
    """
    Constructs an exact millisecond-accurate timeline mapping each 2-sentence narration pair
    to its corresponding media asset (MP4 video or JPG image), snapping transition points to speech pauses.
    """
    txt_chunks = sorted(glob.glob(os.path.join(chunks_dir, "chunk_*.txt")))
    wav_chunks = sorted(glob.glob(os.path.join(chunks_dir, "chunk_*.wav")))

    if not txt_chunks or not wav_chunks or len(txt_chunks) != len(wav_chunks):
        raise RuntimeError(f"Found mismatched chunk files in '{chunks_dir}' (txt: {len(txt_chunks)}, wav: {len(wav_chunks)})")

    # Discover and map available MP4 video clips
    available_mp4s = sorted(list(set(
        glob.glob(os.path.join(images_dir, "*.mp4")) +
        glob.glob(os.path.join(images_dir, "visual_hooks", "*.mp4")) +
        glob.glob(os.path.join(images_dir, "media", "*.mp4")) +
        glob.glob(os.path.expanduser("~/Downloads/visual_hooks/*.mp4"))
    )))
    video_slot_map = {}

    # 1. Check for numbered video files (e.g. 0001.mp4 -> slot 1)
    for mp4_file in available_mp4s:
        base = os.path.basename(mp4_file)
        m = re.match(r"^(\d{1,4})\.mp4$", base, re.IGNORECASE)
        if m:
            slot_num = int(m.group(1))
            video_slot_map[slot_num] = mp4_file

    # 2. Semantic keyword mapping for the 7 Google Flow hook video clips
    HOOK_KEYWORDS = {
        1: ["vascular", "arter", "pill", "heart"],
        2: ["clock", "pupil", "light_sca"],
        3: ["cataract_patient", "blurry", "cloud"],
        4: ["patient_medication", "eye_exam", "doctor"],
        5: ["light_converging", "retina"],
        6: ["translucent", "skin", "renew", "cells"],
        7: ["comparing", "healthy_and_cataract"],
    }

    for slot_idx, kws in HOOK_KEYWORDS.items():
        if slot_idx not in video_slot_map:
            for mp4_file in available_mp4s:
                base_lower = os.path.basename(mp4_file).lower()
                if any(kw in base_lower for kw in kws):
                    video_slot_map[slot_idx] = mp4_file
                    break

    timeline = []
    sent_offset = 0
    current_time_offset = 0.0

    for c_idx, (txt_file, wav_file) in enumerate(zip(txt_chunks, wav_chunks), start=1):
        with open(txt_file, "r", encoding="utf-8") as f:
            c_text = f.read().strip()

        c_sents = extract_raw_sentences_from_text(c_text)
        if not c_sents:
            c_sents = [c_text]

        with wave.open(wav_file, 'r') as w:
            chunk_duration = w.getnframes() / float(w.getframerate())

        # Group chunk sentences into pairs
        num_pairs = max(1, len(c_sents) // 2)
        words_per_pair = []
        for p in range(num_pairs):
            pair = c_sents[p*2 : (p+1)*2]
            words_per_pair.append(max(1, len(" ".join(pair).split())))

        total_chunk_words = sum(words_per_pair)

        # Proportional initial durations
        durations = [(w / float(total_chunk_words)) * chunk_duration for w in words_per_pair]

        # Calculate cut points inside this chunk
        cut_points = []
        accum = 0.0
        for d in durations[:-1]:
            accum += d
            cut_points.append(accum)

        # Snap internal cut points to acoustic breath pauses (silence)
        if enable_pause_snapping and len(cut_points) > 0:
            snapped_cuts = []
            for cp in cut_points:
                snapped_cp = find_nearest_silence_in_wav(wav_file, cp, search_window=1.1)
                snapped_cuts.append(snapped_cp)

            new_durations = []
            prev = 0.0
            for sc in snapped_cuts:
                sc_clamped = max(prev + 1.0, min(chunk_duration - 1.0, sc))
                new_durations.append(sc_clamped - prev)
                prev = sc_clamped
            new_durations.append(chunk_duration - prev)
            durations = new_durations

        # Build timeline entries for this chunk
        for p in range(num_pairs):
            slot_idx = len(timeline) + 1
            dur = durations[p]

            # Determine whether this slot uses a video or an image
            target_image_name = f"{slot_idx:04d}.jpg"
            image_path = os.path.join(images_dir, target_image_name)

            if slot_idx in video_slot_map and os.path.exists(video_slot_map[slot_idx]):
                media_type = "video"
                media_path = video_slot_map[slot_idx]
                exists = True
            else:
                media_type = "image"
                if os.path.exists(image_path):
                    media_path = image_path
                    exists = True
                else:
                    available_jpgs = sorted(glob.glob(os.path.join(images_dir, "*.jpg")))
                    if available_jpgs:
                        media_path = available_jpgs[min(slot_idx - 1, len(available_jpgs) - 1)]
                        exists = False
                    else:
                        raise FileNotFoundError(f"No JPG images found in '{images_dir}'")

            s_start = sent_offset + p*2 + 1
            s_end = sent_offset + min((p+1)*2, len(c_sents))

            timeline.append({
                "index": slot_idx,
                "chunk": c_idx,
                "sentences": f"{s_start}-{s_end}",
                "words": words_per_pair[p],
                "duration": dur,
                "start_time": current_time_offset,
                "end_time": current_time_offset + dur,
                "media_type": media_type,
                "media_path": media_path,
                "image_path": media_path,
                "original_exists": exists
            })
            current_time_offset += dur

        sent_offset += len(c_sents)

    return timeline

# --- Video Rendering Engine (ffmpeg Hybrid Multi-Segment) ---
def render_video_1080p(timeline, audio_path, output_path, resolution="1920x1080", fps=30):
    """
    Renders 1080p MP4 video by normalizing videos and images into uniform .ts chunks,
    then losslessly concatenating them with the master audio track.
    """
    scratch_dir = os.path.join(BASE_DIR, "scratch")
    segments_dir = os.path.join(scratch_dir, "segments")
    os.makedirs(segments_dir, exist_ok=True)

    # Clean old segment files
    for old_file in glob.glob(os.path.join(segments_dir, "seg_*.*")) + glob.glob(os.path.join(segments_dir, "img_script_*.*")):
        try:
            os.remove(old_file)
        except Exception:
            pass

    total_duration = sum(item["duration"] for item in timeline)
    video_slots_count = sum(1 for it in timeline if it["media_type"] == "video")
    image_slots_count = len(timeline) - video_slots_count

    print(f"\n🎬 Initializing 1080P Hybrid Video Export to: {os.path.basename(output_path)}")
    print(f"📊 Timeline Composition: {video_slots_count} Dynamic Videos + {image_slots_count} Infographic Images")
    print(f"⚙️ Specs: 1920x1080 | 30.0 fps | 6,500 kbps H.264 | 256 kbps AAC Audio")
    print(f"⏱️ Total Video Length: {int(total_duration//60)}m {int(total_duration%60):02d}s ({total_duration:.1f}s)")
    print("-" * 76)

    # Detect hardware acceleration encoder
    encoder = "h264_videotoolbox"
    check_hw = subprocess.run(["ffmpeg", "-encoders"], capture_output=True, text=True)
    if "h264_videotoolbox" not in check_hw.stdout:
        encoder = "libx264"
        print("⚠️ VideoToolbox hardware encoder not found. Falling back to libx264...")
    else:
        print("🚀 Using Apple Silicon VideoToolbox Hardware Acceleration (h264_videotoolbox)!")

    # Format resolution
    w, h = resolution.replace("x", ":").split(":")
    base_vf = f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h},fps={fps},format=yuv420p"

    # Partition timeline into contiguous homogeneous segments
    segments = []
    current_img_seg = None

    for item in timeline:
        if item["media_type"] == "video":
            current_img_seg = None
            segments.append({"type": "video", "items": [item]})
        else:
            if current_img_seg is not None:
                current_img_seg["items"].append(item)
            else:
                current_img_seg = {"type": "image", "items": [item]}
                segments.append(current_img_seg)

    print(f"🧩 Timeline partitioned into {len(segments)} seamless segments.")

    t0 = time.time()
    segment_files = []

    for s_idx, seg in enumerate(segments, start=1):
        seg_dur = sum(it["duration"] for it in seg["items"])
        seg_out = os.path.join(segments_dir, f"seg_{s_idx:04d}.ts")

        if seg["type"] == "video":
            item = seg["items"][0]
            v_name = os.path.basename(item["media_path"])
            orig_dur = get_media_duration(item["media_path"])
            pts_factor = item["duration"] / max(0.1, orig_dur)

            print(f"⏳ [{s_idx}/{len(segments)}] Rendering 3D Video Clip #{item['index']:02d} ({seg_dur:.2f}s, speed: {1.0/pts_factor:.2f}x): {v_name[:35]}...")
            v_vf = f"setpts={pts_factor:.6f}*PTS,{base_vf}"

            cmd = [
                "ffmpeg", "-y",
                "-i", item["media_path"],
                "-vf", v_vf,
                "-t", f"{item['duration']:.4f}",
                "-r", str(fps),
                "-c:v", encoder,
                "-b:v", "6500k",
                "-an",
                seg_out
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode != 0:
                raise RuntimeError(f"Failed to encode video segment #{s_idx}:\n{res.stderr[-1000:]}")
            segment_files.append(seg_out)

        else:
            # Image group segment
            item_count = len(seg["items"])
            idx_range = f"#{seg['items'][0]['index']:02d}-#{seg['items'][-1]['index']:02d}"
            print(f"⏳ [{s_idx}/{len(segments)}] Rendering 2.5D Infographic Image Block ({item_count} slides, {seg_dur:.1f}s, {idx_range})...")

            img_script = os.path.join(segments_dir, f"img_script_{s_idx:04d}.txt")
            with open(img_script, "w", encoding="utf-8") as f:
                for it in seg["items"]:
                    f.write(f"file '{it['media_path']}'\n")
                    f.write(f"duration {it['duration']:.4f}\n")
                if seg["items"]:
                    f.write(f"file '{seg['items'][-1]['media_path']}'\n")

            cmd = [
                "ffmpeg", "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", img_script,
                "-vf", base_vf,
                "-t", f"{seg_dur:.4f}",
                "-r", str(fps),
                "-c:v", encoder,
                "-b:v", "6500k",
                "-an",
                "-progress", "pipe:1",
                seg_out
            ]

            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
            curr_pos = "00:00:00"
            curr_spd = "1.0x"
            for line in process.stdout:
                line = line.strip()
                if line.startswith("out_time="):
                    curr_pos = line.split("=", 1)[1].split(".")[0]
                elif line.startswith("speed="):
                    curr_spd = line.split("=", 1)[1]
                elif line.startswith("progress="):
                    print(f"\r   Rendering images progress... Time: {curr_pos} / Speed: {curr_spd}", end="", flush=True)

            retcode = process.wait()
            print()
            if retcode != 0:
                err_text = process.stderr.read()
                raise RuntimeError(f"Failed to encode image segment #{s_idx}:\n{err_text[-1000:]}")
            segment_files.append(seg_out)

    # Master Concat: join all segments losslessly and merge master voiceover track
    print("\n🔗 Stitching all segments and merging master voiceover audio...")
    master_concat_txt = os.path.join(segments_dir, "master_concat.txt")
    with open(master_concat_txt, "w", encoding="utf-8") as f:
        for sf in segment_files:
            f.write(f"file '{sf}'\n")

    master_cmd = [
        "ffmpeg", "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", master_concat_txt,
        "-i", audio_path,
        "-t", f"{total_duration:.3f}",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "256k",
        "-ar", "48000",
        "-movflags", "+faststart",
        output_path
    ]

    res = subprocess.run(master_cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Master concatenation failed:\n{res.stderr[-1500:]}")

    render_time = time.time() - t0
    file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\n🎉 1080P HYBRID VIDEO RENDER COMPLETE in {render_time:.1f}s! ({total_duration / max(0.1, render_time):.1f}x realtime speed)")
    print(f"📁 Output File : {output_path} ({file_size_mb:.1f} MB)")

    # Also copy to ~/Downloads for quick user access
    user_dl_copy = os.path.expanduser("~/Downloads/final_video_1080p.mp4")
    try:
        shutil.copyfile(output_path, user_dl_copy)
        print(f"📋 Copied to   : {user_dl_copy}")
    except Exception:
        pass

    return output_path

# --- Timeline Inspection Display ---
def print_timeline_table(timeline):
    """Prints a formatted ASCII breakdown of the synchronized video timeline."""
    print("\n" + "=" * 90)
    print("  📊 SYNCHRONIZED TIMELINE BREAKDOWN (HYBRID VIDEOS & INFOGRAPHIC IMAGES)")
    print("=" * 90)
    print(f"{'#':<5} | {'Type':<8} | {'Chunk':<6} | {'Sentences':<10} | {'Duration':<9} | {'Timestamp Range':<17} | {'Media Asset'}")
    print("-" * 90)

    for item in timeline:
        type_badge = "🎥 Video" if item["media_type"] == "video" else "🖼️ Image"
        time_range = f"{item['start_time']:.1f}s -> {item['end_time']:.1f}s"
        dur_str = f"{item['duration']:.2f}s"
        asset_name = os.path.basename(item["media_path"])
        if len(asset_name) > 30:
            asset_name = asset_name[:27] + "..."
        print(f"#{item['index']:04d} | {type_badge:<8} | {item['chunk']:<6} | {item['sentences']:<10} | {dur_str:<9} | {time_range:<17} | {asset_name}")

    total_time = sum(i["duration"] for i in timeline)
    v_count = sum(1 for i in timeline if i["media_type"] == "video")
    img_count = len(timeline) - v_count
    mins = int(total_time // 60)
    secs = int(total_time % 60)
    print("-" * 90)
    print(f"Total: {len(timeline)} scenes ({v_count} Videos, {img_count} Images) | Duration: {mins}m {secs:02d}s ({total_time:.2f}s)")
    print("=" * 90 + "\n")

# --- Main CLI ---
def main():
    parser = argparse.ArgumentParser(description="Ultra Video Sync: Synchronize Flow Images & Videos with Narration Audio into 1080P Video.")
    parser.add_argument("--images-dir", type=str, default=DEFAULT_IMAGES_DIR, help="Path to project 1 folder containing images and videos")
    parser.add_argument("--audio", type=str, default=None, help="Path to master voiceover audio file (.wav or .mp3)")
    parser.add_argument("--chunks-dir", type=str, default=DEFAULT_CHUNKS_DIR, help="Path to audio_chunks directory")
    parser.add_argument("--script", type=str, default=DEFAULT_SCRIPT_FILE, help="Path to narration script")
    parser.add_argument("--output", type=str, default=DEFAULT_OUTPUT_FILE, help="Destination 1080p MP4 file path")
    parser.add_argument("--preview-timeline", action="store_true", help="Print timeline table and exit without rendering")
    parser.add_argument("--test-hook", action="store_true", help="Render only the 1-minute visual hook (~77s) for rapid testing")
    parser.add_argument("--no-snap", action="store_true", help="Disable acoustic breath-pause snapping")
    args = parser.parse_args()

    # Determine master audio
    audio_path = args.audio
    if not audio_path:
        if os.path.exists(DEFAULT_AUDIO_WAV):
            audio_path = DEFAULT_AUDIO_WAV
        elif os.path.exists(DEFAULT_AUDIO_MP3):
            audio_path = DEFAULT_AUDIO_MP3
        else:
            raise FileNotFoundError("Could not find master voiceover file ('final_voiceover.wav' or 'final_voiceover.mp3').")

    print("\n" + "=" * 76)
    print("  🎬 ULTRA VIDEO SYNC — 1080P HYBRID AUDIO-VISUAL EXPORTER            ")
    print("=" * 76)
    print(f"📁 Media Source  : {args.images_dir}")
    print(f"🎙️ Audio Master  : {os.path.basename(audio_path)}")
    print(f"📦 Chunks Source : {args.chunks_dir}")
    print(f"📄 Narration     : {os.path.basename(args.script)}")
    print(f"🎯 Output Target : {os.path.basename(args.output)}")
    print("=" * 76)

    # 1. Parse sentences
    sentences = extract_raw_sentences(args.script)
    print(f"📖 Loaded {len(sentences)} spoken sentences from script.")

    # 2. Build timeline
    print("🔍 Building acoustic-synchronized timeline from audio chunks & media files...")
    timeline = build_synchronized_timeline(
        chunks_dir=args.chunks_dir,
        images_dir=args.images_dir,
        script_sentences=sentences,
        enable_pause_snapping=not args.no_snap
    )

    # Handle test-hook mode (first 7 items, ~1 minute)
    if args.test_hook:
        timeline = timeline[:7]
        print(f"⚡ [TEST HOOK MODE] Rendering first {len(timeline)} scenes (Visual Hook, ~77s)...")

    # If preview only
    if args.preview_timeline:
        print_timeline_table(timeline)
        return

    # Print summary table
    print_timeline_table(timeline)

    # 3. Render 1080P Video
    render_video_1080p(
        timeline=timeline,
        audio_path=audio_path,
        output_path=args.output,
        resolution="1920x1080",
        fps=30
    )

if __name__ == "__main__":
    main()
