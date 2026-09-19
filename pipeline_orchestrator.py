#!/usr/bin/env python3
"""
================================================================================
  🎬 ULTRA PIPELINE ORCHESTRATOR — Automated Video Studio Engine
  Coordinates: Gemini Script -> Extraction -> TTS Audio -> Omni Hook Videos ->
               Flow 1K/2K Images -> 1080P Audio-Visual Sync
================================================================================
"""

import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from queue import Queue

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PROJECTS_DIR = os.path.join(BASE_DIR, "projects")
os.makedirs(DEFAULT_PROJECTS_DIR, exist_ok=True)

STEPS = [
    {
        "id": "1_gemini_script",
        "name": "Gemini Pro Script",
        "desc": "Inject topic into master prompt & generate 2,500+ word script",
        "icon": "📝"
    },
    {
        "id": "2_extract_prompts",
        "name": "Extract Prompts & Narration",
        "desc": "Parse clean voiceover & generate 2.5D illustration and hook prompts",
        "icon": "✂️"
    },
    {
        "id": "3_generate_audio",
        "name": "Gemini TTS Audio",
        "desc": "Synthesize voiceover chunks (Leda) & stitch to master WAV/MP3",
        "icon": "🎙️"
    },
    {
        "id": "4_hook_videos",
        "name": "Omni Flash Hook Videos",
        "desc": "Generate dynamic 1-minute visual hook videos (Clips 1-7)",
        "icon": "🎥"
    },
    {
        "id": "5_flow_images",
        "name": "Flow 1K/2K Images",
        "desc": "Generate remaining 2.5D infographic illustrations in 1K/2K quality",
        "icon": "🖼️"
    },
    {
        "id": "6_video_sync",
        "name": "1080P Master Sync",
        "desc": "Acoustic breath-pause snapping & hardware-accelerated 1080p render",
        "icon": "🎬"
    }
]

def sanitize_filename(name):
    clean = re.sub(r'[\\/*?:"<>|]', '', name).strip()
    clean = re.sub(r'\s+', '_', clean)
    return clean[:50]

class PipelineOrchestrator:
    _instance = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super(PipelineOrchestrator, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self, base_projects_dir=None):
        if getattr(self, "_initialized", False):
            return
        self.base_projects_dir = os.path.expanduser(base_projects_dir or DEFAULT_PROJECTS_DIR)
        os.makedirs(self.base_projects_dir, exist_ok=True)
        self.queue = []
        self.active_project_id = None
        self.current_process = None
        self.is_running = False
        self.listeners = []
        self.lock = threading.Lock()
        self.worker_thread = None
        self._load_existing_projects()
        self._initialized = True

    def _load_existing_projects(self):
        """Loads projects from the base directory."""
        if not os.path.exists(self.base_projects_dir):
            return
        for item in sorted(os.listdir(self.base_projects_dir)):
            pdir = os.path.join(self.base_projects_dir, item)
            meta_file = os.path.join(pdir, "project.json")
            if os.path.isdir(pdir) and os.path.exists(meta_file):
                try:
                    with open(meta_file, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                        # Re-verify output files
                        self._refresh_project_outputs(meta)
                        self.queue.append(meta)
                except Exception:
                    pass

    def _refresh_project_outputs(self, proj):
        pdir = proj.get("project_dir", "")
        if not os.path.exists(pdir):
            return

        outputs = proj.setdefault("output_files", {})
        outputs["script"] = os.path.join(pdir, "generated_gemini_script.txt") if os.path.exists(os.path.join(pdir, "generated_gemini_script.txt")) else None
        outputs["narration"] = os.path.join(pdir, "narration_only.txt") if os.path.exists(os.path.join(pdir, "narration_only.txt")) else None
        outputs["image_prompts"] = os.path.join(pdir, "image_prompts.txt") if os.path.exists(os.path.join(pdir, "image_prompts.txt")) else None
        outputs["hook_prompts"] = os.path.join(pdir, "hook_video_prompts.txt") if os.path.exists(os.path.join(pdir, "hook_video_prompts.txt")) else None
        outputs["audio_wav"] = os.path.join(pdir, "final_voiceover.wav") if os.path.exists(os.path.join(pdir, "final_voiceover.wav")) else None
        outputs["audio_mp3"] = os.path.join(pdir, "final_voiceover.mp3") if os.path.exists(os.path.join(pdir, "final_voiceover.mp3")) else None
        outputs["final_video"] = os.path.join(pdir, "final_video_1080p.mp4") if os.path.exists(os.path.join(pdir, "final_video_1080p.mp4")) else None

        # Count media files
        mp4s = glob.glob(os.path.join(pdir, "*.mp4"))
        # Exclude final_video_1080p
        hook_vids = [m for m in mp4s if not m.endswith("final_video_1080p.mp4")]
        jpgs = glob.glob(os.path.join(pdir, "*.jpg"))
        outputs["hook_videos_count"] = len(hook_vids)
        outputs["images_count"] = len(jpgs)

    def subscribe(self, listener_queue):
        with self.lock:
            self.listeners.append(listener_queue)

    def unsubscribe(self, listener_queue):
        with self.lock:
            if listener_queue in self.listeners:
                self.listeners.remove(listener_queue)

    def broadcast(self, event_type, data):
        payload = {
            "type": event_type,
            "data": data,
            "timestamp": datetime.datetime.now().isoformat()
        }
        with self.lock:
            for l in list(self.listeners):
                try:
                    l.put_nowait(payload)
                except Exception:
                    pass

    def log(self, project_id, text, level="info"):
        timestamp = datetime.datetime.now().strftime("%H:%M:%S")
        entry = {"time": timestamp, "text": text, "level": level}
        with self.lock:
            for p in self.queue:
                if p["id"] == project_id:
                    p.setdefault("logs", []).append(entry)
                    # Limit memory logs
                    if len(p["logs"]) > 2000:
                        p["logs"] = p["logs"][-1500:]
                    self._save_project(p)
                    break
        self.broadcast("log", {"project_id": project_id, **entry})
        print(f"[{timestamp}] [{level.upper()}] {text}")

    def _save_project(self, proj):
        pdir = proj.get("project_dir")
        if pdir and os.path.exists(pdir):
            meta_file = os.path.join(pdir, "project.json")
            try:
                with open(meta_file, "w", encoding="utf-8") as f:
                    json.dump(proj, f, indent=2)
            except Exception:
                pass

    def get_project(self, project_id):
        with self.lock:
            for p in self.queue:
                if p["id"] == project_id:
                    self._refresh_project_outputs(p)
                    return p
        return None

    def get_all_projects(self):
        with self.lock:
            for p in self.queue:
                self._refresh_project_outputs(p)
            return list(self.queue)

    def create_project(self, topic, custom_dir=None, settings=None):
        topic = topic.strip()
        if not topic:
            raise ValueError("Topic cannot be empty")

        now_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_title = sanitize_filename(topic)
        project_id = f"proj_{now_str}_{safe_title[:25]}"

        if custom_dir:
            project_dir = os.path.expanduser(custom_dir)
        else:
            project_dir = os.path.join(self.base_projects_dir, f"{now_str}_{safe_title}")

        os.makedirs(project_dir, exist_ok=True)

        default_settings = {
            "resolution": "2k",
            "hook_enabled": True,
            "hook_model": "omni_flash",
            "hook_count": 7,
            "voice": "Leda",
            "tts_model": "gemini-2.5-flash-preview-tts",
            "profile": None
        }
        if settings:
            default_settings.update(settings)

        step_progress = {}
        for s in STEPS:
            step_progress[s["id"]] = {"status": "pending", "message": "Queued", "percent": 0}

        project = {
            "id": project_id,
            "title": topic,
            "topic": topic,
            "project_dir": project_dir,
            "status": "QUEUED",
            "created_at": datetime.datetime.now().isoformat(),
            "started_at": None,
            "completed_at": None,
            "settings": default_settings,
            "current_step": None,
            "step_progress": step_progress,
            "output_files": {},
            "logs": []
        }

        self._refresh_project_outputs(project)
        self._save_project(project)

        with self.lock:
            self.queue.append(project)

        self.broadcast("project_created", project)
        return project

    def create_batch(self, topics_list, custom_dir=None, settings=None):
        created = []
        for t in topics_list:
            clean = t.strip()
            if clean:
                created.append(self.create_project(clean, custom_dir=custom_dir, settings=settings))
        return created

    def delete_project(self, project_id, delete_files=False):
        with self.lock:
            proj = None
            for i, p in enumerate(self.queue):
                if p["id"] == project_id:
                    proj = self.queue.pop(i)
                    break

        if proj and delete_files and os.path.exists(proj["project_dir"]):
            try:
                shutil.rmtree(proj["project_dir"])
            except Exception as e:
                print(f"Error removing project dir: {e}")

        self.broadcast("project_deleted", {"project_id": project_id})
        return True

    def run_subcommand(self, project_id, cmd, step_id, cwd=None):
        self.log(project_id, f"🚀 Executing: {' '.join(cmd)}")
        p = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=cwd or BASE_DIR
        )
        self.current_process = p

        for line in p.stdout:
            clean_line = line.rstrip()
            if clean_line:
                self.log(project_id, clean_line)

        retcode = p.wait()
        self.current_process = None
        if retcode != 0:
            raise RuntimeError(f"Step failed with exit code {retcode}")
        return True

    def run_project_pipeline(self, project_id):
        proj = self.get_project(project_id)
        if not proj:
            return

        proj["status"] = "RUNNING"
        proj["started_at"] = proj.get("started_at") or datetime.datetime.now().isoformat()
        self.active_project_id = project_id
        self._save_project(proj)
        self.broadcast("project_status", proj)

        pdir = proj["project_dir"]
        topic = proj["topic"]
        settings = proj["settings"]
        hook_enabled = settings.get("hook_enabled", True)
        resolution = settings.get("resolution", "2k")
        hook_model = settings.get("hook_model", "omni_flash")
        voice = settings.get("voice", "Leda")

        try:
            # -------------------------------------------------------------
            # STEP 1: Gemini Pro Script Generation
            # -------------------------------------------------------------
            script_file = os.path.join(pdir, "generated_gemini_script.txt")
            if not os.path.exists(script_file) or os.path.getsize(script_file) < 500:
                self._update_step(proj, "1_gemini_script", "running", "Generating full script with Gemini Pro...", 10)
                cmd = [
                    sys.executable,
                    os.path.join(BASE_DIR, "automate_gemini.py"),
                    "--topic", topic,
                    "--output", script_file
                ]
                if settings.get("profile"):
                    cmd.extend(["--profile", settings["profile"]])
                self.run_subcommand(project_id, cmd, "1_gemini_script")
                self._update_step(proj, "1_gemini_script", "done", "Script generated & saved", 100)
            else:
                self.log(project_id, "ℹ️ Script already generated. Skipping Step 1.")
                self._update_step(proj, "1_gemini_script", "done", "Already exists", 100)

            # -------------------------------------------------------------
            # STEP 2: Extract Narration, 2.5D Prompts, and Hook Prompts
            # -------------------------------------------------------------
            narration_file = os.path.join(pdir, "narration_only.txt")
            prompts_file = os.path.join(pdir, "image_prompts.txt")
            hook_file = os.path.join(pdir, "hook_video_prompts.txt")

            if not os.path.exists(narration_file) or not os.path.exists(prompts_file):
                self._update_step(proj, "2_extract_prompts", "running", "Extracting narration & 2.5D illustration prompts...", 30)
                cmd_ext = [
                    sys.executable,
                    os.path.join(BASE_DIR, "extract_narration_and_prompts.py"),
                    "--input", script_file,
                    "--output-interleaved", os.path.join(pdir, "narration_with_illustrations.txt"),
                    "--output-prompts", prompts_file,
                    "--output-narration", narration_file
                ]
                self.run_subcommand(project_id, cmd_ext, "2_extract_prompts")

            if hook_enabled and not os.path.exists(hook_file):
                self.log(project_id, "🎬 Generating 1-minute visual hook video prompts...")
                cmd_hook = [
                    sys.executable,
                    os.path.join(BASE_DIR, "generate_hook_prompts.py"),
                    "--input", narration_file,
                    "--output", hook_file,
                    "--clips", str(settings.get("hook_count", 7))
                ]
                self.run_subcommand(project_id, cmd_hook, "2_extract_prompts")

            self._update_step(proj, "2_extract_prompts", "done", "Prompts and narration extracted", 100)

            # -------------------------------------------------------------
            # STEP 3: Voiceover Audio Generation via Gemini TTS
            # -------------------------------------------------------------
            audio_wav = os.path.join(pdir, "final_voiceover.wav")
            audio_mp3 = os.path.join(pdir, "final_voiceover.mp3")
            chunks_dir = os.path.join(pdir, "audio_chunks")
            os.makedirs(chunks_dir, exist_ok=True)

            if not os.path.exists(audio_wav) or os.path.getsize(audio_wav) < 10000:
                self._update_step(proj, "3_generate_audio", "running", f"Synthesizing Gemini TTS voiceover ({voice})...", 50)
                cmd_audio = [
                    sys.executable,
                    os.path.join(BASE_DIR, "automate_audio.py"),
                    "--script", narration_file,
                    "--output-dir", chunks_dir,
                    "--output-wav", audio_wav,
                    "--output-mp3", audio_mp3,
                    "--voice", voice
                ]
                self.run_subcommand(project_id, cmd_audio, "3_generate_audio")
                self._update_step(proj, "3_generate_audio", "done", "Voiceover synthesized & stitched", 100)
            else:
                self.log(project_id, "ℹ️ Master voiceover audio already exists. Skipping Step 3.")
                self._update_step(proj, "3_generate_audio", "done", "Already exists", 100)

            # -------------------------------------------------------------
            # STEP 4: 1-Minute Visual Hook Videos with Omni 1.1 Flash
            # -------------------------------------------------------------
            hook_count = settings.get("hook_count", 7)
            if hook_enabled:
                self._update_step(proj, "4_hook_videos", "running", f"Generating {hook_count} Hook Videos ({hook_model})...", 65)
                # Check how many hook videos already exist
                existing_mp4s = sorted(glob.glob(os.path.join(pdir, "000[1-7].mp4")))
                if len(existing_mp4s) < hook_count:
                    cmd_hook_vid = [
                        sys.executable,
                        os.path.join(BASE_DIR, "automate_hook_videos.py"),
                        "--prompts-file", hook_file,
                        "--download-dir", pdir,
                        "--model", hook_model,
                        "--count", str(hook_count),
                        "--interval", "5"
                    ]
                    if settings.get("profile"):
                        cmd_hook_vid.extend(["--profile", settings["profile"]])
                    self.run_subcommand(project_id, cmd_hook_vid, "4_hook_videos")
                self._update_step(proj, "4_hook_videos", "done", f"{hook_count} Hook videos generated", 100)
            else:
                self._update_step(proj, "4_hook_videos", "done", "Skipped (Disabled in settings)", 100)

            # -------------------------------------------------------------
            # STEP 5: Google Flow Image Generation (1K / 2K Nano Banana 2)
            # -------------------------------------------------------------
            self._update_step(proj, "5_flow_images", "running", f"Generating illustrations ({resolution.upper()})...", 80)
            start_num = (hook_count + 1) if hook_enabled else 1
            cmd_images = [
                sys.executable,
                os.path.join(BASE_DIR, "automate_flow.py"),
                "--prompts-file", prompts_file,
                "--download-dir", pdir,
                "--start-num", str(start_num),
                "--resolution", resolution,
                "--interval", "5"
            ]
            if settings.get("profile"):
                cmd_images.extend(["--profile", settings["profile"]])

            self.run_subcommand(project_id, cmd_images, "5_flow_images")
            self._update_step(proj, "5_flow_images", "done", f"Images generated in {resolution.upper()}", 100)

            # -------------------------------------------------------------
            # STEP 6: Master 1080P Audio-Visual Video Sync
            # -------------------------------------------------------------
            final_video = os.path.join(pdir, "final_video_1080p.mp4")
            self._update_step(proj, "6_video_sync", "running", "Rendering 1080p synchronized video...", 90)
            cmd_sync = [
                sys.executable,
                os.path.join(BASE_DIR, "automate_video_sync.py"),
                "--images-dir", pdir,
                "--audio", audio_wav,
                "--chunks-dir", chunks_dir,
                "--script", narration_file,
                "--output", final_video
            ]
            self.run_subcommand(project_id, cmd_sync, "6_video_sync")
            self._update_step(proj, "6_video_sync", "done", "Final 1080p video complete!", 100)

            # Success
            proj["status"] = "COMPLETED"
            proj["completed_at"] = datetime.datetime.now().isoformat()
            self._refresh_project_outputs(proj)
            self._save_project(proj)
            self.broadcast("project_status", proj)
            self.log(project_id, f"🎉 Project completed successfully! Output: {final_video}")

        except Exception as e:
            proj["status"] = "FAILED"
            self._save_project(proj)
            self.broadcast("project_status", proj)
            self.log(project_id, f"❌ Pipeline failed: {str(e)}", level="error")
        finally:
            self.active_project_id = None
            self.is_running = False

    def _update_step(self, proj, step_id, status, message, percent):
        proj["current_step"] = step_id
        if step_id in proj["step_progress"]:
            proj["step_progress"][step_id]["status"] = status
            proj["step_progress"][step_id]["message"] = message
            proj["step_progress"][step_id]["percent"] = percent
        self._save_project(proj)
        self.broadcast("step_update", {
            "project_id": proj["id"],
            "step_id": step_id,
            "status": status,
            "message": message,
            "percent": percent
        })

    def start_worker(self):
        if self.worker_thread and self.worker_thread.is_alive():
            return

        def _worker_loop():
            while True:
                next_proj = None
                with self.lock:
                    for p in self.queue:
                        if p["status"] == "QUEUED":
                            next_proj = p
                            break

                if next_proj:
                    self.is_running = True
                    self.run_project_pipeline(next_proj["id"])
                else:
                    self.is_running = False
                    time.sleep(1.0)

        self.worker_thread = threading.Thread(target=_worker_loop, daemon=True)
        self.worker_thread.start()

    def cancel_active_run(self):
        if self.current_process:
            try:
                self.current_process.terminate()
                self.current_process.kill()
            except Exception:
                pass
        if self.active_project_id:
            proj = self.get_project(self.active_project_id)
            if proj:
                proj["status"] = "PAUSED"
                self._save_project(proj)
                self.broadcast("project_status", proj)
                self.log(self.active_project_id, "⏹️ Pipeline stopped by user.", level="warn")
        self.active_project_id = None
        self.is_running = False

# Global Singleton
orchestrator = PipelineOrchestrator()

if __name__ == "__main__":
    print(f"Ultra Pipeline Orchestrator Initialized. Base Dir: {orchestrator.base_projects_dir}")
    print(f"Existing Projects Loaded: {len(orchestrator.queue)}")
