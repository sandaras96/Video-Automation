#!/usr/bin/env python3
"""
================================================================================
  🌐 ULTRA VIDEO STUDIO SERVER — Local Web Application Backend
  Provides REST APIs, SSE Real-Time Logs, Media Streaming, and System Health
  Runs on: http://localhost:5050
================================================================================
"""

import datetime
import glob
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from queue import Empty, Queue

from pipeline_orchestrator import orchestrator, STEPS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
PORT = 5050

def get_system_status():
    cdp_active = False
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=0.8) as resp:
            cdp_active = (resp.status == 200)
    except Exception:
        cdp_active = False

    ffmpeg_installed = shutil.which("ffmpeg") is not None

    keys_count = 0
    default_profile = "Menaka Gemini Pro"
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                keys_count = len(data.get("gemini_api_keys", []))
                if not keys_count and data.get("gemini_api_key"):
                    keys_count = 1
                default_profile = data.get("default_profile", default_profile)
        except Exception:
            pass

    return {
        "cdp_port_9222": cdp_active,
        "ffmpeg_installed": ffmpeg_installed,
        "api_keys_count": keys_count,
        "default_profile": default_profile,
        "is_pipeline_running": orchestrator.is_running,
        "active_project_id": orchestrator.active_project_id
    }

class StudioAPIHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def log_message(self, format, *args):
        # Silence verbose standard http request logs
        return

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/status":
            return self.send_json(get_system_status())

        if path == "/api/steps":
            return self.send_json(STEPS)

        if path == "/api/projects":
            return self.send_json(orchestrator.get_all_projects())

        if path.startswith("/api/projects/"):
            proj_id = path.split("/")[3]
            proj = orchestrator.get_project(proj_id)
            if proj:
                return self.send_json(proj)
            return self.send_json({"error": "Project not found"}, status=404)

        if path == "/api/config":
            cfg = {}
            if os.path.exists(CONFIG_FILE):
                try:
                    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                        cfg = json.load(f)
                except Exception:
                    pass
            return self.send_json(cfg)

        if path == "/api/folders":
            projects_dir = orchestrator.base_projects_dir
            folders = []
            if os.path.exists(projects_dir):
                for entry in sorted(os.listdir(projects_dir)):
                    full_p = os.path.join(projects_dir, entry)
                    if os.path.isdir(full_p) and not entry.startswith("."):
                        try:
                            mtime = os.path.getmtime(full_p)
                            folders.append({
                                "name": entry,
                                "path": full_p,
                                "mtime": mtime,
                                "mtime_str": datetime.datetime.fromtimestamp(mtime).strftime("%b %d, %H:%M")
                            })
                        except Exception:
                            folders.append({"name": entry, "path": full_p, "mtime": 0, "mtime_str": ""})
            folders.sort(key=lambda x: x.get("mtime", 0), reverse=True)
            return self.send_json({
                "base_dir": BASE_DIR,
                "projects_dir": projects_dir,
                "folders": folders
            })

        if path == "/api/stream":
            return self.handle_sse_stream()

        if path.startswith("/api/media/"):
            return self.handle_media_stream(path)

        # Fallback to static web files
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            payload = {}

        if path == "/api/projects/create":
            topic = payload.get("topic", "").strip()
            bulk_topics = payload.get("bulk_topics", [])
            custom_dir = payload.get("custom_dir", "").strip() or None
            settings = payload.get("settings", {})

            if bulk_topics and isinstance(bulk_topics, list):
                created = orchestrator.create_batch(bulk_topics, custom_dir=custom_dir, settings=settings)
                if payload.get("auto_start", False):
                    orchestrator.start_worker()
                return self.send_json({"success": True, "created": created})

            if not topic:
                return self.send_json({"error": "Topic is required"}, status=400)

            project = orchestrator.create_project(topic, custom_dir=custom_dir, settings=settings)
            if payload.get("auto_start", False):
                orchestrator.start_worker()
            return self.send_json({"success": True, "project": project})

        if path.startswith("/api/projects/") and path.endswith("/run"):
            proj_id = path.split("/")[3]
            proj = orchestrator.get_project(proj_id)
            if not proj:
                return self.send_json({"error": "Project not found"}, status=404)

            proj["status"] = "QUEUED"
            orchestrator._save_project(proj)
            orchestrator.start_worker()
            return self.send_json({"success": True, "message": "Pipeline queued"})

        if path.startswith("/api/projects/") and path.endswith("/delete"):
            proj_id = path.split("/")[3]
            del_files = payload.get("delete_files", False)
            orchestrator.delete_project(proj_id, delete_files=del_files)
            return self.send_json({"success": True})

        if path == "/api/cancel":
            orchestrator.cancel_active_run()
            return self.send_json({"success": True, "message": "Pipeline stopped"})

        if path == "/api/system/launch-chrome":
            # Launch Chrome with CDP port 9222 and dedicated user-data-dir required by modern Chrome
            chrome_data_dir = os.path.expanduser("~/Library/Application Support/Google/Chrome-Automation")
            subprocess.Popen([
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "--remote-debugging-port=9222",
                f"--user-data-dir={chrome_data_dir}",
                "--no-first-run",
                "--no-default-browser-check"
            ])
            time.sleep(1.5)
            return self.send_json({"success": True, "status": get_system_status()})

        if path == "/api/open-folder":
            folder_path = payload.get("path")
            if folder_path and os.path.exists(folder_path):
                subprocess.run(["open", folder_path])
                return self.send_json({"success": True})
            return self.send_json({"error": "Folder not found"}, status=404)

        if path == "/api/folders/create":
            name = payload.get("name", "").strip()
            if not name:
                return self.send_json({"error": "Folder name is required"}, status=400)
            safe_name = re.sub(r'[\\/*?:"<>|]', '', name).strip()
            if not safe_name:
                return self.send_json({"error": "Invalid folder name"}, status=400)
            parent_dir = payload.get("parent_dir", "").strip()
            if not parent_dir or not os.path.exists(parent_dir):
                parent_dir = orchestrator.base_projects_dir
            new_dir = os.path.join(parent_dir, safe_name)
            try:
                os.makedirs(new_dir, exist_ok=True)
                return self.send_json({
                    "success": True,
                    "name": safe_name,
                    "path": new_dir
                })
            except Exception as e:
                return self.send_json({"error": f"Failed to create folder: {str(e)}"}, status=500)

        if path == "/api/browse-folder":
            initial_dir = payload.get("initial_dir", "").strip()
            if not initial_dir or not os.path.exists(initial_dir):
                initial_dir = orchestrator.base_projects_dir
            if not os.path.exists(initial_dir):
                initial_dir = BASE_DIR
            safe_initial = initial_dir.replace('\\', '\\\\').replace('"', '\\"')
            script = f'''
            tell application "System Events"
                activate
            end tell
            try
                set defaultPath to POSIX file "{safe_initial}"
                set chosenFolder to choose folder with prompt "Select or Create Project Folder:" default location defaultPath
                return POSIX path of chosenFolder
            on error number -128
                return "CANCELED"
            end try
            '''
            try:
                res = subprocess.run(["osascript", "-e", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
                output = res.stdout.strip()
                if output == "CANCELED" or not output:
                    return self.send_json({"canceled": True})
                if output.endswith("/"):
                    output = output[:-1]
                return self.send_json({"success": True, "path": output})
            except subprocess.TimeoutExpired:
                return self.send_json({"error": "Folder selection timed out"}, status=408)
            except Exception as e:
                return self.send_json({"error": str(e)}, status=500)

        if path == "/api/config":
            if os.path.exists(CONFIG_FILE):
                try:
                    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                        cfg = json.load(f)
                except Exception:
                    cfg = {}
            else:
                cfg = {}

            for k, v in payload.items():
                cfg[k] = v

            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)

            return self.send_json({"success": True, "config": cfg})

        return self.send_json({"error": "Endpoint not found"}, status=404)

    def handle_sse_stream(self):
        """Server-Sent Events stream for real-time logs and progress."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        q = Queue()
        orchestrator.subscribe(q)

        # Initial handshake event
        init_data = json.dumps({"type": "init", "projects": orchestrator.get_all_projects()})
        try:
            self.wfile.write(f"data: {init_data}\n\n".encode("utf-8"))
            self.wfile.flush()
        except Exception:
            orchestrator.unsubscribe(q)
            return

        try:
            while True:
                try:
                    event = q.get(timeout=20.0)
                    line = f"data: {json.dumps(event)}\n\n"
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()
                except Empty:
                    # Heartbeat comment to keep connection alive
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            orchestrator.unsubscribe(q)

    def handle_media_stream(self, path):
        """Streams project media (videos, audio, images) with HTTP Range support for seeking."""
        # URL format: /api/media/{project_id}/{filename}
        parts = path.split("/")
        if len(parts) < 5:
            return self.send_json({"error": "Invalid media path"}, status=400)

        proj_id = parts[3]
        filename = urllib.parse.unquote("/".join(parts[4:]))

        proj = orchestrator.get_project(proj_id)
        if not proj:
            return self.send_json({"error": "Project not found"}, status=404)

        pdir = proj["project_dir"]
        file_path = os.path.join(pdir, filename)

        if not os.path.exists(file_path) or not os.path.isfile(file_path):
            return self.send_json({"error": "File not found"}, status=404)

        mime_type, _ = mimetypes.guess_type(file_path)
        if not mime_type:
            if file_path.endswith(".mp4"):
                mime_type = "video/mp4"
            elif file_path.endswith(".wav"):
                mime_type = "audio/wav"
            elif file_path.endswith(".mp3"):
                mime_type = "audio/mpeg"
            elif file_path.endswith(".jpg") or file_path.endswith(".jpeg"):
                mime_type = "image/jpeg"
            else:
                mime_type = "application/octet-stream"

        file_size = os.path.getsize(file_path)
        range_header = self.headers.get("Range")

        if range_header:
            # Parse Range: bytes=start-end
            m = re.match(r"bytes=(\d+)-(\d*)", range_header)
            if m:
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else file_size - 1
                end = min(end, file_size - 1)
                length = end - start + 1

                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self.send_header("Content-Type", mime_type)
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()

                with open(file_path, "rb") as f:
                    f.seek(start)
                    chunk_size = 64 * 1024
                    bytes_left = length
                    while bytes_left > 0:
                        read_bytes = min(bytes_left, chunk_size)
                        data = f.read(read_bytes)
                        if not data:
                            break
                        self.wfile.write(data)
                        bytes_left -= len(data)
                return

        # Full file response
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(file_size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        with open(file_path, "rb") as f:
            shutil.copyfileobj(f, self.wfile)

def start_server(port=PORT):
    os.makedirs(WEB_DIR, exist_ok=True)
    server_address = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(server_address, StudioAPIHandler)
    print(f"\n" + "=" * 70)
    print(f"🚀 ULTRA VIDEO PIPELINE STUDIO RUNNING LOCALLY")
    print(f"=" * 70)
    print(f"🌐 Dashboard URL : http://localhost:{port}")
    print(f"📁 Workspace     : {BASE_DIR}")
    print(f"📂 Projects Dir  : {orchestrator.base_projects_dir}")
    print(f"=" * 70 + "\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 Shutting down server...")
        httpd.server_close()

if __name__ == "__main__":
    p = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    start_server(p)
