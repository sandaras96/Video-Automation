#!/usr/bin/env python3
"""
================================================================================
  🎬 GEMINI DIRECTOR BRAIN — Autonomous Executive AI Media Director
================================================================================
  Acts as the master creative brain controlling:
  1. Script Creation (Narrative arc, medical accuracy, retention psychology).
  2. Scene-by-Scene Visual Breakdown:
     - 1-Minute Hook: 7 dynamic 3D video prompts (Veo / Omni Flash).
     - Deep-Dive Body: Bespoke 2.5D infographic illustration prompts (Flow / Nano Banana).
  3. Voice Direction:
     - Natural breath pauses, pacing, and emotional tone per scene.
     - Intelligent paragraph-level chunking for Gemini TTS (Leda).
  4. Audio-Visual Sync Timeline:
     - Exports a precise scene timeline mapping each visual directly to its
       narration beat for lossless, beat-accurate video synchronization.
================================================================================
"""

import argparse
import glob
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

DEFAULT_MODELS = [
    "gemini-3.6-flash",
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview"
]

DIRECTOR_SYSTEM_PROMPT = """You are an elite YouTube Executive Creative Director, Medical Scriptwriter, and Audio-Visual Producer.
Your goal is to take a video topic and produce a complete, production-ready "Director's Blueprint" in valid JSON format.

The video structure must be:
1. A gripping 60-second visual hook composed of exactly 7 rapid, cinematic scenes (designed for 3D medical animation / Veo / Omni Flash).
2. A deep-dive educational body composed of clear, informative scenes (each paired with a bespoke 2.5D infographic illustration prompt).
3. A compelling conclusion with actionable health advice and call-to-action.

Each scene must contain:
- "scene_id": integer
- "section": "HOOK" or "BODY" or "CONCLUSION"
- "type": "VIDEO_3D" (for hook) or "IMAGE_2_5D" (for body/conclusion)
- "visual_prompt": detailed, vivid generation prompt (clinical, photorealistic, or clean 2.5D isometric style, no text on screen)
- "narration": natural, spoken conversational voiceover text for the narrator
- "voice_pacing": "dramatic", "normal", "empathetic", or "urgent"
- "estimated_seconds": float (estimated speech duration, ~2.5 words per second)

You must output ONLY valid, parsable JSON matching this structure:
{
  "title": "Compelling YouTube Video Title",
  "topic": "The given topic",
  "hook_scenes": [
    {
      "scene_id": 1,
      "section": "HOOK",
      "type": "VIDEO_3D",
      "visual_prompt": "Cinematic 3D medical animation of...",
      "narration": "Every single morning, millions of people...",
      "voice_pacing": "dramatic",
      "estimated_seconds": 8.5
    }
  ],
  "body_scenes": [
    {
      "scene_id": 8,
      "section": "BODY",
      "type": "IMAGE_2_5D",
      "visual_prompt": "Clean 2.5D medical illustration of...",
      "narration": "Sign number one is unexpected fluid retention...",
      "voice_pacing": "informative",
      "estimated_seconds": 12.0
    }
  ]
}
Do NOT wrap in markdown backticks or any preamble/postamble. Return ONLY pure JSON."""

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def get_api_keys():
    cfg = load_config()
    keys = cfg.get("gemini_api_keys", [])
    if not keys and cfg.get("gemini_api_key"):
        keys = [cfg.get("gemini_api_key")]
    return [k.strip() for k in keys if k and k.strip()]

def call_gemini_director(topic, model=None):
    keys = get_api_keys()
    if not keys:
        raise RuntimeError("No Gemini API keys found in config.json")

    models = [model] if model else DEFAULT_MODELS

    user_prompt = f"""Generate the complete Director's Blueprint for a high-retention YouTube video on the topic:
"{topic}"

Requirements:
- Hook: Exactly 7 scenes (3D cinematic medical animations, 60 seconds total speech).
- Body: At least 25-40 detailed educational scenes breaking down the signs, mechanisms, and prevention in depth.
- Visual prompts must be highly specific, professional, and ready for image/video generation tools.
- Return ONLY the JSON object."""

    payload = {
        "systemInstruction": {
            "parts": [{"text": DIRECTOR_SYSTEM_PROMPT}]
        },
        "contents": [
            {
                "parts": [{"text": user_prompt}]
            }
        ],
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json"
        }
    }

    data_bytes = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    last_error = None

    for cur_model in models:
        for idx, key in enumerate(keys):
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{cur_model}:generateContent?key={key}"
            req = urllib.request.Request(url, data=data_bytes, headers=headers, method="POST")

            try:
                masked = f"{key[:8]}...{key[-4:]}"
                print(f"🧠 [DIRECTOR BRAIN] Directing video with [{cur_model}] via Key {idx + 1}/{len(keys)} ({masked})...")
                t0 = time.time()

                with urllib.request.urlopen(req, timeout=180) as resp:
                    res_json = json.loads(resp.read().decode("utf-8"))

                candidates = res_json.get("candidates", [])
                if not candidates:
                    raise ValueError(f"No candidates returned: {res_json}")

                raw_text = candidates[0]["content"]["parts"][0]["text"].strip()
                # Clean up any potential code fence wrappers
                raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text, flags=re.MULTILINE)
                raw_text = re.sub(r"\s*```$", "", raw_text, flags=re.MULTILINE).strip()

                blueprint = json.loads(raw_text)
                elapsed = time.time() - t0

                hook_count = len(blueprint.get("hook_scenes", []))
                body_count = len(blueprint.get("body_scenes", []))
                print(f"🎬 [DIRECTOR BRAIN] Blueprint generated in {elapsed:.1f}s! ({hook_count} Hook Clips, {body_count} Body Scenes)")
                return blueprint

            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8")
                last_error = f"HTTP {e.code}: {err_body[:300]}"
                print(f"⚠️ Key {idx + 1} ({cur_model}) error: {last_error}")
                if e.code in (429, 503):
                    continue
                elif e.code == 404:
                    break
            except Exception as e:
                last_error = str(e)
                print(f"⚠️ Error: {last_error}")
                continue

    raise RuntimeError(f"Gemini Director Brain failed on all keys/models. Last error: {last_error}")

def export_director_blueprint(blueprint, project_dir):
    """
    Exports the Director's Blueprint into both structured JSON and backward-compatible
    files so all pipeline scripts (TTS audio, Flow, Veo, video sync) can consume them seamlessly.
    """
    os.makedirs(project_dir, exist_ok=True)

    # 1. Save master Blueprint JSON
    blueprint_path = os.path.join(project_dir, "director_blueprint.json")
    with open(blueprint_path, "w", encoding="utf-8") as f:
        json.dump(blueprint, f, indent=2)
    print(f"📄 Saved Director Blueprint: {blueprint_path}")

    all_scenes = blueprint.get("hook_scenes", []) + blueprint.get("body_scenes", [])

    # 2. Export clean narration track (narration_only.txt)
    narration_lines = [s["narration"].strip() for s in all_scenes if s.get("narration")]
    narration_path = os.path.join(project_dir, "narration_only.txt")
    with open(narration_path, "w", encoding="utf-8") as f:
        f.write("\n\n".join(narration_lines))
    print(f"🎙️ Exported Narration Track: {narration_path} ({len(narration_lines)} scenes)")

    # 3. Export Hook Video Prompts (hook_video_prompts.txt)
    hook_prompts = [s["visual_prompt"].strip() for s in blueprint.get("hook_scenes", []) if s.get("visual_prompt")]
    hook_path = os.path.join(project_dir, "hook_video_prompts.txt")
    with open(hook_path, "w", encoding="utf-8") as f:
        for idx, p in enumerate(hook_prompts, 1):
            f.write(f"HOOK CLIP {idx}: {p}\n\n")
    print(f"🎥 Exported Hook Video Prompts: {hook_path} ({len(hook_prompts)} clips)")

    # 4. Export 2.5D Image Prompts (image_prompts.txt)
    image_prompts = [s["visual_prompt"].strip() for s in blueprint.get("body_scenes", []) if s.get("visual_prompt")]
    image_path = os.path.join(project_dir, "image_prompts.txt")
    with open(image_path, "w", encoding="utf-8") as f:
        for idx, p in enumerate(image_prompts, 1):
            f.write(f"IMAGE {idx:04d}: {p}\n\n")
    print(f"🖼️ Exported Illustration Prompts: {image_path} ({len(image_prompts)} illustrations)")

    # 5. Export Interleaved Narration & Prompts (narration_with_illustrations.txt)
    interleaved_path = os.path.join(project_dir, "narration_with_illustrations.txt")
    with open(interleaved_path, "w", encoding="utf-8") as f:
        for s in all_scenes:
            f.write(f"[{s.get('type', 'SCENE')} #{s.get('scene_id', 0)} - {s.get('voice_pacing', 'normal')}]\n")
            f.write(f"PROMPT: {s.get('visual_prompt', '')}\n")
            f.write(f"NARRATION: {s.get('narration', '')}\n\n")

    # 6. Export Full Script (generated_gemini_script.txt)
    script_path = os.path.join(project_dir, "generated_gemini_script.txt")
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(f"# {blueprint.get('title', 'Video Script')}\n\n")
        f.write("## 1-MINUTE VISUAL HOOK\n\n")
        for s in blueprint.get("hook_scenes", []):
            f.write(f"**Clip {s.get('scene_id')}:** {s.get('narration')}\n\n")
        f.write("## DEEP DIVE\n\n")
        for s in blueprint.get("body_scenes", []):
            f.write(f"**Scene {s.get('scene_id')}:** {s.get('narration')}\n\n")
    print(f"📝 Exported Full Script: {script_path}")

    # 7. Export Sync Timeline for automate_video_sync.py
    timeline_path = os.path.join(project_dir, "scene_timeline.json")
    timeline = []
    cumulative_time = 0.0
    for s in all_scenes:
        est = float(s.get("estimated_seconds", 8.0))
        timeline.append({
            "scene_id": s.get("scene_id"),
            "type": s.get("type"),
            "start_time": round(cumulative_time, 2),
            "end_time": round(cumulative_time + est, 2),
            "duration": round(est, 2),
            "narration": s.get("narration")
        })
        cumulative_time += est

    with open(timeline_path, "w", encoding="utf-8") as f:
        json.dump({"total_duration": round(cumulative_time, 2), "scenes": timeline}, f, indent=2)
    print(f"⏱️ Exported Sync Timeline: {timeline_path}")

    return blueprint

def main():
    parser = argparse.ArgumentParser(description="Gemini Director Brain.")
    parser.add_argument("--topic", type=str, required=True, help="YouTube video topic")
    parser.add_argument("--project-dir", type=str, default=None, help="Output project directory")
    parser.add_argument("--model", type=str, default=None, help="Gemini model override")
    args = parser.parse_args()

    project_dir = os.path.expanduser(args.project_dir or os.path.join(BASE_DIR, "projects", "active_project"))

    print("=" * 70)
    print("🎬 LAUNCHING GEMINI DIRECTOR BRAIN")
    print(f"🎯 Topic      : {args.topic}")
    print(f"📁 Project Dir: {project_dir}")
    print("=" * 70)

    blueprint = call_gemini_director(args.topic, model=args.model)
    export_director_blueprint(blueprint, project_dir)

    print("\n" + "=" * 70)
    print("🎉 DIRECTOR'S BLUEPRINT SUCCESSFULLY CREATED & SYNCHRONIZED!")
    print("=" * 70)

if __name__ == "__main__":
    main()
