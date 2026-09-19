#!/usr/bin/env python3
"""
High-Speed Google Gemini Automation Workflow
--------------------------------------------
Optimized for instant execution without slow DOM tree traversals.
1. Brings/opens target Chrome profile window.
2. Navigates to Gemini and verifies Gemini Pro model.
3. Injects prompt and instantly submits via Cmd+Return.
4. Streams response with a clean live countdown timer.
5. Copies full markdown output via native Copy button.
6. Writes output directly to text file in current folder.
"""

import argparse
import ctypes
from ctypes import c_double, c_uint32, c_void_p, Structure
import glob
import json
import os
import subprocess
import sys
import time

# --- Native CoreGraphics Ctypes Mouse Events (Zero Dependencies) ---
class CGPoint(Structure):
    _fields_ = [("x", c_double), ("y", c_double)]

try:
    cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    cg.CGEventCreateMouseEvent.argtypes = [c_void_p, c_uint32, CGPoint, c_uint32]
    cg.CGEventCreateMouseEvent.restype = c_void_p
    cg.CGEventPost.argtypes = [c_uint32, c_void_p]
    cg.CGEventPost.restype = None
except Exception as e:
    print(f"[ERROR] Failed to load CoreGraphics: {e}")
    sys.exit(1)

def mouse_click(x, y):
    """Instant mouse click at screen coordinates (x, y)."""
    pt = CGPoint(float(x), float(y))
    e_move = cg.CGEventCreateMouseEvent(None, 5, pt, 0)
    cg.CGEventPost(0, e_move)
    time.sleep(0.02)
    e_down = cg.CGEventCreateMouseEvent(None, 1, pt, 0)
    cg.CGEventPost(0, e_down)
    time.sleep(0.04)
    e_up = cg.CGEventCreateMouseEvent(None, 2, pt, 0)
    cg.CGEventPost(0, e_up)
    time.sleep(0.03)

def run_applescript(script_str):
    """Executes AppleScript quickly."""
    res = subprocess.run(["osascript", "-e", script_str], capture_output=True, text=True)
    return res.stdout.strip(), res.stderr.strip(), res.returncode

def get_installed_profiles():
    """Reads Chrome Local State to get all profiles."""
    local_state_path = os.path.expanduser("~/Library/Application Support/Google/Chrome/Local State")
    profiles = []
    if os.path.exists(local_state_path):
        try:
            with open(local_state_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            info_cache = data.get("profile", {}).get("info_cache", {})
            for pdir, details in info_cache.items():
                name = details.get("name", pdir)
                email = details.get("user_name", "")
                profiles.append({"dir": pdir, "name": name, "email": email})
        except Exception:
            pass
    return profiles

def activate_chrome_profile(profile_query=None):
    """Fast profile switcher that ensures Chrome is active and frontmost."""
    profiles = get_installed_profiles()
    chosen_profile = None

    if profile_query:
        q = profile_query.lower()
        for p in profiles:
            if q in p["name"].lower() or q in p["dir"].lower():
                chosen_profile = p
                break
    else:
        # Check config
        config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
        saved = None
        if os.path.exists(config_path):
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    saved = json.load(f).get("default_profile")
            except Exception:
                pass
        if saved:
            for p in profiles:
                if saved.lower() in p["name"].lower():
                    chosen_profile = p
                    break
        if not chosen_profile:
            for p in profiles:
                if "gemini" in p["name"].lower() or "pro" in p["name"].lower():
                    chosen_profile = p
                    break
        if not chosen_profile and profiles:
            chosen_profile = profiles[0]

    profile_name = chosen_profile["name"] if chosen_profile else "Menaka Gemini Pro"
    print(f"🚀 Using Profile: '{profile_name}'")

    # 1. Activate Chrome and switch profile via menu
    switch_script = f'''
    tell application "Google Chrome" to activate
    tell application "System Events"
        tell process "Google Chrome"
            set frontmost to true
            tell menu "Profiles" of menu bar item "Profiles" of menu bar 1
                repeat with m in (name of every menu item)
                    if m is not missing value and m contains "{profile_name}" then
                        click menu item m
                        exit repeat
                    end if
                end repeat
            end tell
        end tell
    end tell
    '''
    run_applescript(switch_script)
    time.sleep(0.6)

    # 2. Focus or navigate to Gemini
    nav_script = '''
    tell application "Google Chrome"
        activate
        set found to false
        repeat with w in windows
            repeat with t in tabs of w
                if URL of t contains "gemini.google.com" then
                    set index of w to 1
                    set found to true
                    exit repeat
                end if
            end repeat
            if found then exit repeat
        end repeat
        if not found then
            if (count of windows) is 0 then make new window
            set URL of active tab of front window to "https://gemini.google.com/app"
        end if
    end tell
    '''
    run_applescript(nav_script)
    time.sleep(0.8)
    return chosen_profile

def ensure_gemini_pro():
    """Fast check and switch for Gemini Pro model."""
    print("⚡ Checking model...")
    # Get front window bounds
    bounds_script = 'tell application "Google Chrome" to return bounds of front window'
    out, _, _ = run_applescript(bounds_script)
    try:
        x1, y1, x2, y2 = [int(n.strip()) for n in out.split(",")]
    except Exception:
        x1, y1, x2, y2 = 44, 38, 768, 881

    # Mode picker center is at top-left of page content
    picker_x = x1 + 140
    picker_y = y1 + 115
    pro_x = x1 + 180
    pro_y = y1 + 285

    # Check if already Pro
    check_script = '''
    tell application "System Events"
        tell process "Google Chrome"
            set w to front window
            repeat with elem in (UI elements of w)
                try
                    if (description of elem) contains "Gemini Pro" then return "PRO"
                end try
            end repeat
            return "CHECK"
        end tell
    end tell
    '''
    out, _, _ = run_applescript(check_script)
    if out == "PRO":
        print("✅ Gemini Pro is active.")
        return

    # Click picker and select Pro
    mouse_click(picker_x, picker_y)
    time.sleep(0.4)
    mouse_click(pro_x, pro_y)
    time.sleep(0.4)
    print("✅ Selected Gemini Pro.")

def inject_and_send_prompt(prompt_content):
    """Puts prompt into clipboard, pastes, and immediately submits via Cmd+Return."""
    print("⚡ Pasting prompt and submitting...")
    # 1. Put prompt into clipboard
    p = subprocess.Popen(["pbcopy"], stdin=subprocess.PIPE)
    p.communicate(prompt_content.encode("utf-8"))

    # 2. Get window bounds to find input box
    out, _, _ = run_applescript('tell application "Google Chrome" to return bounds of front window')
    try:
        x1, y1, x2, y2 = [int(n.strip()) for n in out.split(",")]
    except Exception:
        x1, y1, x2, y2 = 44, 38, 768, 881

    input_x = (x1 + x2) // 2
    input_y = y2 - 60

    # 3. Click input box
    mouse_click(input_x, input_y)
    time.sleep(0.2)

    # 4. Paste (Cmd+V) and Submit (Cmd+Return)
    submit_script = '''
    tell application "Google Chrome" to activate
    tell application "System Events"
        tell process "Google Chrome"
            set frontmost to true
            keystroke "v" using command down
            delay 0.4
            keystroke return using command down
        end tell
    end tell
    '''
    run_applescript(submit_script)
    print("🚀 Prompt submitted instantly!")

def wait_and_copy_response(timeout=240):
    """Monitors generation completion and copies the answer using verified coordinates."""
    print("\n⏳ Gemini Pro is generating your deep-dive script...")
    print("ℹ️ Note: 2,500+ word YouTube scripts typically take ~75-90s for Google AI to generate.")
    start_time = time.time()
    
    # Get window bounds for coordinate math
    out, _, _ = run_applescript('tell application "Google Chrome" to return bounds of front window')
    try:
        x1, y1, x2, y2 = [int(n.strip()) for n in out.split(",")]
    except Exception:
        x1, y1, x2, y2 = 44, 38, 768, 881

    # First wait at least 35 seconds before attempting copies
    while time.time() - start_time < timeout:
        elapsed = int(time.time() - start_time)
        print(f"\r⚡ Generating script with Gemini Pro... [{elapsed}s elapsed] (streaming ~2,500 words)", end="", flush=True)

        # Start checking for completion once reasonable generation time has passed (> 40s)
        if elapsed >= 40 and elapsed % 5 == 0:
            # Clear clipboard
            subprocess.run(["pbcopy"], input=b"")

            # Activate & Raise Chrome
            run_applescript('''
            tell application "Google Chrome" to activate
            tell application "System Events"
                tell process "Google Chrome"
                    set frontmost to true
                    perform action "AXRaise" of front window
                end tell
            end tell
            ''')
            time.sleep(0.15)

            # Focus chat pane and scroll down to bottom
            mouse_click(x1 + 250, y1 + 300)
            time.sleep(0.1)
            run_applescript('''
            tell application "System Events"
                tell process "Google Chrome"
                    key code 125 using command down
                    delay 0.1
                    key code 125 using command down
                end tell
            end tell
            ''')
            time.sleep(0.25)

            # Click native Copy button at verified coordinates: (x1 + 226, y2 - 205)
            copy_x = x1 + 226
            copy_y = y2 - 205
            mouse_click(copy_x, copy_y)
            time.sleep(0.4)

            try:
                clip = subprocess.check_output(["pbpaste"], text=True)
                if len(clip.strip()) > 800:
                    print(f"\n✅ AI generation finished and copied in {elapsed}s!")
                    return clip
            except Exception:
                pass

        time.sleep(1.0)

    # Final attempt if timeout reached
    copy_x = x1 + 226
    copy_y = y2 - 205
    mouse_click(copy_x, copy_y)
    time.sleep(0.5)
    return subprocess.check_output(["pbpaste"], text=True)

def save_output(text, out_path=None):
    """Saves text to output file in workspace."""
    if not out_path:
        out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "generated_gemini_script.txt")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(text)
    words = len(text.split())
    chars = len(text)
    print("\n" + "=" * 55)
    print("🎉 SCRIPT GENERATED & SAVED IN SECONDS!")
    print("=" * 55)
    print(f"📁 Output File: {out_path}")
    print(f"📊 Stats      : {words:,} words | {chars:,} characters")
    print("=" * 55)

def main():
    parser = argparse.ArgumentParser(description="Lightning-fast Gemini Pro Automation.")
    parser.add_argument("--profile", type=str, default=None, help="Profile name or substring")
    parser.add_argument("--prompt-file", type=str, default=None, help="Prompt file path")
    parser.add_argument("--topic", type=str, default=None, help="YouTube video topic to insert into master prompt")
    parser.add_argument("--output", type=str, default=None, help="Output file path")
    args = parser.parse_args()

    # Find prompt file
    current_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = glob.glob(os.path.join(current_dir, "*Script*.lua")) + glob.glob(os.path.join(current_dir, "*.lua"))
    prompt_file = args.prompt_file or (candidates[0] if candidates else None)

    if not prompt_file:
        print("[ERROR] No prompt file found.")
        sys.exit(1)

    with open(prompt_file, "r", encoding="utf-8") as f:
        content = f.read()

    if args.topic:
        # Dynamically substitute topic in master prompt
        content = re.sub(r"TOPIC:\s*[^\n]+", f"TOPIC: {args.topic}", content, count=1)
        print(f"🎯 Configured YouTube Topic: \"{args.topic}\"")

    # 1. Activate Chrome Profile
    activate_chrome_profile(args.profile)

    # 2. Ensure Gemini Pro
    ensure_gemini_pro()

    # 3. Inject and Send via Cmd+Return
    inject_and_send_prompt(content)

    # 4. Wait & Copy
    res = wait_and_copy_response()
    if res.strip():
        save_output(res, args.output)
    else:
        print("⚠️ Could not copy response automatically. Please check Chrome window.")

if __name__ == "__main__":
    main()
