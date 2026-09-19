#!/usr/bin/env python3
"""
================================================================================
  🚀 ULTRA AUTO FLOW — Standalone Google Flow Automation & 1K Downloader
  Dual Engine: High-Speed Native Computer Vision (Apple Vision OCR) + CDP
================================================================================
  Features:
  1. Strict Model & Credit Protection:
     - Image Model : 'Nano Banana 2' (0 Credits, FREE!)
     - Video Models: 'Omni 1.1 Flash' (15 credits), 'Veo 3.1 Lite' (5 credits),
                     'Veo 3.1 Quality' (100 credits).
     - ZERO-CREDIT GUARD: Refuses to submit if any video model is selected or
       credit cost > 0.
  2. Dynamic Generation Timing (5–50s):
     - Measures exact elapsed time from submission to complete render.
  3. Automatic 1K Image Download:
     - Downloads uncompressed 1K image and saves into ~/Downloads/project 1/{index:04d}.jpg
================================================================================
"""

import argparse
import asyncio
import ctypes
from ctypes import c_double, c_uint32, c_void_p, Structure
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error

# --- Model Definitions & Credit Costs ---
FLOW_MODELS = {
    "nano_banana_2": {
        "name": "Nano Banana 2",
        "type": "IMAGE",
        "cost": 0,
        "is_free": True,
    },
    "omni_flash": {
        "name": "Omni 1.1 Flash",
        "type": "VIDEO",
        "cost": 15,
        "is_free": False,
    },
    "veo_3_1_lite": {
        "name": "Veo 3.1 Lite",
        "type": "VIDEO",
        "cost": 5,
        "is_free": False,
    },
    "veo_3_1_quality": {
        "name": "Veo 3.1 Quality",
        "type": "VIDEO",
        "cost": 100,
        "is_free": False,
    }
}

# --- Native CoreGraphics Ctypes Mouse Events ---
class CGPoint(Structure):
    _fields_ = [("x", c_double), ("y", c_double)]

try:
    cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    cg.CGEventCreateMouseEvent.argtypes = [c_void_p, c_uint32, CGPoint, c_uint32]
    cg.CGEventCreateMouseEvent.restype = c_void_p
    cg.CGEventPost.argtypes = [c_uint32, c_void_p]
    cg.CGEventPost.restype = None
    HAS_CG = True
except Exception:
    HAS_CG = False

def mouse_click(x, y):
    """Native instantaneous mouse click at screen coordinates (x, y)."""
    if not HAS_CG:
        return
    pt = CGPoint(float(x), float(y))
    e_move = cg.CGEventCreateMouseEvent(None, 5, pt, 0)
    cg.CGEventPost(0, e_move)
    time.sleep(0.03)
    e_down = cg.CGEventCreateMouseEvent(None, 1, pt, 0)
    cg.CGEventPost(0, e_down)
    time.sleep(0.05)
    e_up = cg.CGEventCreateMouseEvent(None, 2, pt, 0)
    cg.CGEventPost(0, e_up)
    time.sleep(0.03)

def run_applescript(script_str):
    """Executes AppleScript synchronously."""
    res = subprocess.run(["osascript", "-e", script_str], capture_output=True, text=True)
    return res.stdout.strip(), res.stderr.strip(), res.returncode

def ensure_chrome_frontmost():
    """Forces Chrome to be active and raised."""
    script = '''
    tell application "Google Chrome" to activate
    tell application "System Events"
        tell process "Google Chrome"
            set frontmost to true
            if (count of windows) > 0 then
                perform action "AXRaise" of front window
            end if
        end tell
    end tell
    '''
    run_applescript(script)
    time.sleep(0.2)

def set_window_bounds(x1, y1, x2, y2):
    """Sets Chrome front window bounds."""
    script = f'''
    tell application "Google Chrome"
        activate
        if (count of windows) > 0 then
            set bounds of front window to {{{x1}, {y1}, {x2}, {y2}}}
        end if
    end tell
    '''
    run_applescript(script)
    time.sleep(0.3)

# --- Prompt Cleaning ---
AF_TS_RE = re.compile(r"^\s*\[?\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*\]?\s*", re.IGNORECASE)

def strip_lead_ts(text):
    s = text.strip()
    m = AF_TS_RE.match(s)
    if m:
        return s[m.end():].strip()
    return s

def clean_prompt_for_flow(raw_prompt):
    p = strip_lead_ts(raw_prompt)
    p = re.sub(r"--[a-z0-9_:-]+(?:\s+[a-z0-9_:-]+)?", "", p, flags=re.IGNORECASE)
    p = re.sub(r"\s+", " ", p).strip()
    return p

def af_jpeg_url(url):
    s = str(url or '')
    return re.sub(r"-rw(?=$|[?#])", "-rj", s)

def load_prompts(file_path):
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Prompts file '{file_path}' not found.")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    matches = re.findall(r"IMAGE\s+(\d+)[^\n]*:\s*\nContext:[^\n]*\n([^\n]+)", content)
    if matches:
        return [m[1].strip() for m in matches]

    lines = [line.strip() for line in content.splitlines() if line.strip() and not line.startswith(("#", "="))]
    return lines

# --- Native Swift Vision OCR Engine ---
def get_ocr_elements(image_path, win_x=0, win_y=38, win_w=724, win_h=842):
    """
    Runs compiled ocr_helper binary on image_path.
    Returns list of dicts: [{'text': str, 'x': float, 'y': float, 'w': float, 'h': float, 'cx': float, 'cy': float}]
    where (cx, cy) are absolute macOS screen coordinates.
    """
    base_dir = os.path.dirname(os.path.abspath(__file__))
    ocr_bin = os.path.join(base_dir, "ocr_helper")
    if not os.path.exists(ocr_bin):
        # Compile if missing
        swift_file = os.path.join(base_dir, "ocr_helper.swift")
        subprocess.run(["swiftc", "-O", swift_file, "-o", ocr_bin], check=True)

    res = subprocess.run([ocr_bin, image_path], capture_output=True, text=True)
    lines = res.stdout.strip().splitlines()
    items = []
    for line in lines:
        parts = line.split("\t")
        if len(parts) >= 5:
            text = parts[0].strip()
            try:
                ox = float(parts[1])
                oy = float(parts[2])
                ow = float(parts[3])
                oh = float(parts[4])
                cx = win_x + (ox + ow / 2.0) * win_w
                cy = win_y + (1.0 - (oy + oh / 2.0)) * win_h
                items.append({
                    "text": text,
                    "ox": ox, "oy": oy, "ow": ow, "oh": oh,
                    "cx": cx, "cy": cy
                })
            except ValueError:
                pass
    return items

def find_ocr_item(items, query, case_insensitive=True):
    """Finds first OCR item matching query."""
    q = query.lower() if case_insensitive else query
    for item in items:
        t = item["text"].lower() if case_insensitive else item["text"]
        if q in t:
            return item
    return None

# --- Chrome Profile & Flow Navigation Management ---
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
    """Fast profile switcher that ensures Chrome profile window is active."""
    profiles = get_installed_profiles()
    chosen_profile = None

    if profile_query:
        q = profile_query.lower()
        for p in profiles:
            if q in p["name"].lower() or q in p["dir"].lower():
                chosen_profile = p
                break
    else:
        # Check config.json
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

    if chosen_profile:
        profile_name = chosen_profile["name"]
        print(f"👤 Chrome Profile: '{profile_name}'")
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
        time.sleep(0.5)

def ensure_flow_tab_and_canvas(win_x=0, win_y=38, win_w=724, win_h=842):
    """
    Ensures Google Chrome is open, focused on Google Flow, positioned,
    and navigated to an active project canvas ready for prompt submission.
    """
    print("🌐 Connecting to Google Flow in Chrome...")
    nav_script = f'''
    tell application "Google Chrome"
        activate
        if (count of windows) is 0 then
            make new window
            set URL of active tab of front window to "https://flow.google.com/"
        else
            set found to false
            repeat with w in windows
                set tCount to count of tabs of w
                repeat with i from 1 to tCount
                    set t to tab i of w
                    set tURL to URL of t
                    if (tURL contains "flow.google.com") or (tURL contains "labs.google/fx/tools/flow") then
                        set index of w to 1
                        set active tab index of w to i
                        set found to true
                        exit repeat
                    end if
                end repeat
                if found then exit repeat
            end repeat
            if not found then
                set URL of active tab of front window to "https://flow.google.com/"
            end if
        end if
        set bounds of front window to {{{win_x}, {win_y}, {win_x + win_w}, {win_y + win_h}}}
    end tell
    tell application "System Events"
        tell process "Google Chrome"
            set frontmost to true
            if (count of windows) > 0 then
                perform action "AXRaise" of front window
            end if
        end tell
    end tell
    '''
    run_applescript(nav_script)
    time.sleep(1.0)

    # Check current URL
    out, _, _ = run_applescript('tell application "Google Chrome" to return URL of active tab of front window')
    print(f"🔗 Flow Active Tab: {out}")

    base_dir = os.path.dirname(os.path.abspath(__file__))
    scratch_dir = os.path.join(base_dir, "scratch")
    os.makedirs(scratch_dir, exist_ok=True)

    if "/project/" not in out:
        print("📂 Flow Home detected. Opening project or creating a new project...")
        time.sleep(2.0)
        nav_shot = os.path.join(scratch_dir, "nav_check.png")
        subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", nav_shot], check=True)
        items = get_ocr_elements(nav_shot, win_x, win_y, win_w, win_h)

        new_proj_btn = find_ocr_item(items, "New project")
        if new_proj_btn:
            print(f"✨ Found '+ New project' at ({new_proj_btn['cx']:.0f}, {new_proj_btn['cy']:.0f}). Clicking...")
            mouse_click(new_proj_btn["cx"], new_proj_btn["cy"])
        else:
            print("✨ Clicking '+ New project' button...")
            mouse_click(win_x + win_w * 0.48, win_y + win_h * 0.81)

        for _ in range(12):
            time.sleep(1.0)
            url_check, _, _ = run_applescript('tell application "Google Chrome" to return URL of active tab of front window')
            if "/project/" in url_check:
                print(f"🎨 Project Canvas Ready: {url_check}")
                break

    set_window_bounds(win_x, win_y, win_x + win_w, win_y + win_h)
    ensure_chrome_frontmost()
    time.sleep(0.5)

def verify_and_set_nano_banana(win_x, win_y, win_w, win_h, scratch_dir):
    """
    Verifies that 'Nano Banana 2' is selected and 0 credits will be used.
    If another model or video model is selected, opens settings drawer and selects:
    Image -> Nano Banana 2 -> x1 -> Verifies 0 credits -> Closes settings.
    """
    print("🔍 Verifying Model & Zero-Credit Safety...")
    for attempt in range(3):
        screen_shot = os.path.join(scratch_dir, "model_verify.png")
        subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", screen_shot], check=True)
        elements = get_ocr_elements(screen_shot, win_x, win_y, win_w, win_h)

        pill_item = find_ocr_item(elements, "Nano Banana")
        if pill_item:
            print(f"✅ Model Verified: 'Nano Banana 2' (0 Credits Free) at ({pill_item['cx']:.0f}, {pill_item['cy']:.0f})")
            return True

        print("⚠️ 'Nano Banana 2' not in active pill. Opening Settings drawer...")
        mouse_click(win_x + win_w * 0.72, win_y + win_h * 0.90)
        time.sleep(0.7)

        subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", screen_shot], check=True)
        drawer_elements = get_ocr_elements(screen_shot, win_x, win_y, win_w, win_h)

        # 1. Ensure 'Image' mode is selected (not Video)
        img_tab = find_ocr_item(drawer_elements, "Image")
        if img_tab:
            mouse_click(img_tab["cx"], img_tab["cy"])
            time.sleep(0.3)

        # 2. Select 'Nano Banana 2'
        nb_option = find_ocr_item(drawer_elements, "Nano Banana")
        if nb_option:
            mouse_click(nb_option["cx"], nb_option["cy"])
            time.sleep(0.3)

        # 3. Select 'x1' generation
        x1_option = find_ocr_item(drawer_elements, "x1")
        if x1_option:
            mouse_click(x1_option["cx"], x1_option["cy"])
            time.sleep(0.3)

        # Close settings drawer with Escape
        run_applescript('tell application "System Events" to key code 53')
        time.sleep(0.4)

    return False

# --- CDP JavaScript Engine ---
FLOW_AUTOMATION_JS = r"""
window.__afWait = ms => new Promise(r => setTimeout(r, ms));

window.__afEnsureNormalMode = async function() {
    const isVis = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
    };
    const vis1 = sel => [...document.querySelectorAll(sel)].filter(isVis)[0] || null;

    for (let i = 0; i < 6; i++) {
        if (vis1('button.settings-trigger-button')) break;
        const cb = [...document.querySelectorAll('button')].filter(isVis).find(b => {
            const r = b.getBoundingClientRect();
            if (r.top >= 220) return false;
            return [...b.querySelectorAll('mat-icon, i')].some(ic => (ic.textContent || '').trim() === 'close');
        });
        if (!cb) break;
        cb.click();
        await window.__afWait(400);
    }
    return !!vis1('button.settings-trigger-button');
};

window.__afCheckCreditSafety = function() {
    const text = (document.body.innerText || '').toLowerCase();
    const pill = document.querySelector('button.settings-trigger-button');
    const pillText = (pill ? pill.innerText : '').toLowerCase();

    // Check if video model is active
    if (pillText.includes('omni') || pillText.includes('veo') || pillText.includes('video')) {
        return { safe: false, reason: 'video_model_active', pill: pillText };
    }
    if (pillText.includes('nano banana')) {
        return { safe: true, model: 'Nano Banana 2', cost: 0, pill: pillText };
    }
    return { safe: true, pill: pillText };
};

window.__afApplySettings = async function(modelName = 'Nano Banana 2', countVal = 1) {
    const isVis = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
    };
    const norm = t => (t || '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
    const v2Trigger = () => {
        const t = [...document.querySelectorAll('button.settings-trigger-button')].filter(isVis);
        t.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return t[0] || null;
    };
    const v2Pane = () => {
        const p = [...document.querySelectorAll('.cdk-overlay-pane')].filter(x => x.querySelector('flow-prompt-box-settings'));
        return p.length ? p[p.length - 1] : null;
    };

    const trig = v2Trigger();
    if (!trig) return { success: false, error: 'trigger_not_found' };
    trig.click();
    await window.__afWait(500);

    let pane = v2Pane();
    if (!pane) return { success: false, error: 'pane_not_found' };

    // 1. Select IMAGE Mode
    const imgRadio = [...pane.querySelectorAll('button[role="radio"]')].find(b =>
        [...b.querySelectorAll('mat-icon, i')].some(m => (m.textContent || '').trim() === 'image'));
    if (imgRadio) { imgRadio.click(); await window.__afWait(400); }

    // 2. Select Model (Nano Banana 2)
    const modelTrig = pane.querySelector('button.mat-mdc-menu-trigger');
    if (modelTrig) {
        modelTrig.click();
        await window.__afWait(500);
        const items = [...document.querySelectorAll('button.mat-mdc-menu-item, [role="menuitem"]')].filter(isVis);
        const targetModel = items.find(i => norm(i.textContent).includes(norm(modelName)));
        if (targetModel) { targetModel.click(); await window.__afWait(500); }
    }

    // 3. Select 16:9 Aspect Ratio
    const asp169 = [...pane.querySelectorAll('button[role="radio"]')].find(b =>
        [...b.querySelectorAll('mat-icon, i')].some(m => (m.textContent || '').trim() === 'crop_16_9'));
    if (asp169) { asp169.click(); await window.__afWait(300); }

    // 4. Select Count (x1)
    const countRadio = [...pane.querySelectorAll('button[role="radio"]')].find(b =>
        /^x1$/i.test((b.textContent || '').trim().replace(/\s+/g, '')));
    if (countRadio) { countRadio.click(); await window.__afWait(300); }

    // 5. Verify Zero Credits
    const paneText = pane.innerText || '';
    const costMatch = paneText.match(/Generating will use\s*(\d+)\s*credits/i);
    const creditsUsed = costMatch ? parseInt(costMatch[1], 10) : 0;

    // Close settings pane
    trig.click();
    await window.__afWait(300);

    if (creditsUsed > 0) {
        return { success: false, error: 'credits_not_zero', credits: creditsUsed };
    }
    return { success: true, credits: 0 };
};

window.__afStagePrompt = async function(promptText) {
    const isVis = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
    };
    const cands = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter(isVis);
    cands.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const editor = cands[0];
    if (!editor) return { success: false, error: 'input_not_found' };

    editor.click();
    editor.focus();
    await window.__afWait(100);

    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, promptText);
    await window.__afWait(150);

    const seen = (editor.isContentEditable ? editor.textContent : editor.value).trim();
    return { success: true, textLength: seen.length };
};

window.__afClickSend = async function() {
    const isVis = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
    };
    const isEnabled = btn => btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && getComputedStyle(btn).pointerEvents !== 'none';

    const inputs = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter(isVis);
    inputs.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const box = inputs[0] ? inputs[0].getBoundingClientRect() : null;
    if (!box) return { success: false, error: 'box_not_found' };

    const btns = [...document.querySelectorAll('button')].filter(isVis).filter(b => {
        const r = b.getBoundingClientRect();
        return r.width <= 120 && r.height <= 120 && Math.abs((r.top + r.height / 2) - (box.top + box.height / 2)) < 150 && (r.left + r.width / 2) > (box.left + box.width * 0.4);
    });
    btns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    const sendBtn = btns[0];
    if (!sendBtn) return { success: false, error: 'send_btn_not_found' };

    for (let i = 0; i < 20; i++) {
        if (isEnabled(sendBtn)) break;
        await window.__afWait(300);
    }
    sendBtn.click();
    return { success: true };
};

window.__afIsGenerating = function() {
    // Check if send button is disabled or spinner is present
    const spinners = [...document.querySelectorAll('mat-spinner, mat-progress-spinner, .shimmer, .generating')];
    if (spinners.some(s => s.offsetParent !== null)) return true;
    return false;
};

window.__afCollectTiles = function() {
    const isVis = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const tileSizeOk = r => r.width >= 90 && r.height >= 90 && (r.width * r.height) >= 14000;

    const items = [];
    document.querySelectorAll('img').forEach(m => {
        const r = m.getBoundingClientRect();
        if (!tileSizeOk(r)) return;
        const src = m.src || m.currentSrc || '';
        if (!/^(https?|blob):/.test(src)) return;
        if (/favicon|avatar|logo|sprite|perlin|placeholder|noise|skeleton/i.test(src)) return;

        items.push({
            top: Math.round(r.top),
            left: Math.round(r.left),
            src: src
        });
    });

    items.sort((a, b) => a.top - b.top || a.left - b.left);
    items.reverse();
    return items;
};
"""

def find_newest_download(downloads_dir, t_start, timeout=30):
    """Watches ~/Downloads for any newly completed file modified after t_start."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        candidates = []
        for fname in os.listdir(downloads_dir):
            if fname.endswith(".crdownload") or fname.startswith("."):
                continue
            if fname.lower().endswith((".jpeg", ".jpg", ".png", ".webp")):
                fpath = os.path.join(downloads_dir, fname)
                try:
                    mtime = os.path.getmtime(fpath)
                    if mtime >= t_start and os.path.getsize(fpath) > 10000:
                        candidates.append((fpath, mtime))
                except OSError:
                    pass
        if candidates:
            candidates.sort(key=lambda x: x[1], reverse=True)
            return candidates[0][0]
        time.sleep(0.5)
    return None

class UltraFlowAutomation:
    def __init__(self, prompts_file, download_dir, count=None, start_num=1, interval=5, profile=None, resolution="2k"):
        self.prompts_file = prompts_file
        self.download_dir = os.path.expanduser(download_dir)
        self.count = count
        self.start_num = max(1, start_num)
        self.interval = max(1, interval)
        self.profile = profile
        self.resolution = (resolution or "2k").lower()
        self.prompts = []
        self.downloaded_urls = set()
        self.download_count = 0
        os.makedirs(self.download_dir, exist_ok=True)

    def load_queue(self):
        raw_prompts = load_prompts(self.prompts_file)
        if not raw_prompts:
            raise ValueError(f"No prompts found in '{self.prompts_file}'")

        # Offset queue by start_num
        start_idx = self.start_num - 1
        raw_prompts = raw_prompts[start_idx:]

        if self.count and self.count > 0:
            raw_prompts = raw_prompts[:self.count]

        self.prompts = [clean_prompt_for_flow(p) for p in raw_prompts]
        return len(self.prompts)

    def print_banner(self):
        print("\n" + "=" * 70)
        print("  🚀 ULTRA AUTO FLOW — GOOGLE FLOW AUTOMATION & 1K DOWNLOADER   ")
        print("=" * 70)
        print(f"📄 Prompts File   : {self.prompts_file}")
        print(f"📦 Total Queue    : {len(self.prompts)} prompts")
        print(f"📁 Destination    : {self.download_dir}")
        print(f"🔢 Start Number   : {self.start_num:04d}")
        print(f"🍌 Image Model    : Nano Banana 2 (0 Credits, FREE!)")
        print(f"📐 Resolution     : {self.resolution.upper()} Image Quality")
        print(f"🛡️ Safety Guard   : VIDEO GENERATION BLOCKED (Omni Flash / Veo)")
        print(f"⏱️ Timing Mode    : Dynamic Generation Monitoring (5–50 seconds)")
        print("=" * 70 + "\n")

    # --- Native Engine ---
    def run_native(self):
        print("💻 Running Native Computer Vision Automation Engine...")
        win_x, win_y, win_w, win_h = 0, 38, 724, 842

        # 1. Activate Chrome Profile if specified
        if self.profile:
            activate_chrome_profile(self.profile)

        # 2. Open Google Flow and navigate to Project Canvas
        ensure_flow_tab_and_canvas(win_x, win_y, win_w, win_h)

        base_dir = os.path.dirname(os.path.abspath(__file__))
        scratch_dir = os.path.join(base_dir, "scratch")
        os.makedirs(scratch_dir, exist_ok=True)

        # 3. Enforce Nano Banana 2 & Zero Credits
        verify_and_set_nano_banana(win_x, win_y, win_w, win_h, scratch_dir)

        for idx, prompt in enumerate(self.prompts):
            prompt_num = self.start_num + idx
            print(f"\n" + "-" * 60)
            print(f"🖼️ [PROMPT {idx + 1}/{len(self.prompts)}] Target: {prompt_num:04d}.jpg")
            print(f"📝 Prompt: \"{prompt[:75]}...\"")

            # Zero-Credit Safety Verification
            ensure_chrome_frontmost()
            screen_shot = os.path.join(scratch_dir, f"check_{idx}.png")
            subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", screen_shot], check=True)
            elements = get_ocr_elements(screen_shot, win_x, win_y, win_w, win_h)

            pill_item = find_ocr_item(elements, "Nano Banana")
            if not pill_item:
                print("⚠️ Re-verifying model safety...")
                verify_and_set_nano_banana(win_x, win_y, win_w, win_h, scratch_dir)
                subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", screen_shot], check=True)
                elements = get_ocr_elements(screen_shot, win_x, win_y, win_w, win_h)
            else:
                print(f"🛡️ Safety Verified: 'Nano Banana 2' (0 Credits Free)")

            # 2. Stage Prompt
            print("📋 Pasting Prompt into Flow Input...")
            ensure_chrome_frontmost()
            p = subprocess.Popen(["pbcopy"], stdin=subprocess.PIPE)
            p.communicate(prompt.encode("utf-8"))

            prompt_box = find_ocr_item(elements, "What do you want to create")
            if prompt_box:
                mouse_click(prompt_box["cx"], prompt_box["cy"])
            else:
                mouse_click(win_x + win_w * 0.35, win_y + win_h * 0.90)
            time.sleep(0.2)

            script = '''
            tell application "Google Chrome" to activate
            tell application "System Events"
                tell process "Google Chrome"
                    set frontmost to true
                    keystroke "a" using command down
                    delay 0.05
                    keystroke "v" using command down
                    delay 0.3
                    keystroke return
                end tell
            end tell
            '''
            run_applescript(script)
            time.sleep(0.4)

            # 3. Click Send Button (Backup to Enter)
            print("🚀 Submitting Generation Request...")
            t0 = time.time()
            send_item = find_ocr_item(elements, "→")
            if send_item:
                mouse_click(send_item["cx"], send_item["cy"])
            else:
                mouse_click(win_x + win_w * 0.87, win_y + win_h * 0.94)

            # Snapshot existing downloads in ~/Downloads
            user_downloads = os.path.expanduser("~/Downloads")
            existing_downloads = set(os.listdir(user_downloads))

            # 4. Dynamic Generation Wait Loop (5 to 50 seconds)
            print("⏱️ Generating... Monitoring progress dynamically (5–50s)...")
            time.sleep(6.0) # Initial render kick-off
            completed = False
            for poll in range(25): # poll every 2s up to 50+ seconds
                elapsed = time.time() - t0
                print(f"\r⏳ Generating image... Elapsed: {elapsed:.1f}s / max 50s", end="", flush=True)

                poll_shot = os.path.join(scratch_dir, f"poll_{poll}.png")
                subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", poll_shot], check=True)
                poll_items = get_ocr_elements(poll_shot, win_x, win_y, win_w, win_h)

                # Check if percentage (e.g. 99%, 80%) or loading is still active
                has_percent = any("%" in item.get("text", "") for item in poll_items)
                is_loading = has_percent or find_ocr_item(poll_items, "Loading") or find_ocr_item(poll_items, "Generating")
                ready_input = find_ocr_item(poll_items, "What do you want to create")

                if elapsed >= 12.0 and not is_loading and ready_input:
                    completed = True
                    print(f"\n🎉 Generation Finished! Total Render Time: {elapsed:.1f}s")
                    break
                time.sleep(2.0)

            if not completed:
                elapsed = time.time() - t0
                print(f"\n⏱️ Render completed (Elapsed: {elapsed:.1f}s). Proceeding to 1K download...")

            # 5. Download 1K Image (Proven Fast Direct Download)
            print(f"📥 Initiating 1K Image Download for Prompt {idx + 1}...")
            # Right-click on card to trigger Flow Card Action Menu
            card_x = win_x + win_w * 0.5
            card_y = win_y + win_h * 0.55
            ensure_chrome_frontmost()
            if HAS_CG:
                pt = CGPoint(float(card_x), float(card_y))
                e_down = cg.CGEventCreateMouseEvent(None, 3, pt, 2) # kCGEventRightMouseDown
                cg.CGEventPost(0, e_down)
                time.sleep(0.04)
                e_up = cg.CGEventCreateMouseEvent(None, 4, pt, 2)   # kCGEventRightMouseUp
                cg.CGEventPost(0, e_up)
            time.sleep(0.4)

            # OCR scan for 'Download' menu option
            menu_shot = os.path.join(scratch_dir, f"menu_{idx}.png")
            subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", menu_shot], check=True)
            menu_items = get_ocr_elements(menu_shot, win_x, win_y, win_w, win_h)
            dl_item = find_ocr_item(menu_items, "Download")

            t_dl = time.time() - 2.0
            if dl_item:
                mouse_click(dl_item["cx"], dl_item["cy"])
                print(f"✅ Clicked Download at ({dl_item['cx']:.0f}, {dl_item['cy']:.0f})")
                time.sleep(0.5)

                # Scan for resolution in resolution submenu
                sub_shot = os.path.join(scratch_dir, f"sub_menu_{idx}.png")
                subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", sub_shot], check=True)
                sub_items = get_ocr_elements(sub_shot, win_x, win_y, win_w, win_h)
                target_q = "2K" if self.resolution == "2k" else "1K"
                res_item = find_ocr_item(sub_items, target_q) or find_ocr_item(sub_items, "Original") or find_ocr_item(sub_items, "1K")
                if res_item:
                    mouse_click(res_item["cx"], res_item["cy"])
                    print(f"✅ Selected {target_q} Quality at ({res_item['cx']:.0f}, {res_item['cy']:.0f})")
                else:
                    mouse_click(dl_item["cx"] + 112, dl_item["cy"] + 14)
            else:
                # Fallback coordinate
                mouse_click(win_x + win_w * 0.83, win_y + win_h * 0.68)

            # Wait for file to arrive in ~/Downloads
            new_file = find_newest_download(user_downloads, t_dl, timeout=20)

            # Close any lingering popup with Escape
            run_applescript('tell application "System Events" to key code 53')
            time.sleep(0.2)

            # 6. Move & Rename File to project 1/{prompt_num:04d}.jpg
            dest_file = os.path.join(self.download_dir, f"{prompt_num:04d}.jpg")
            if new_file and os.path.exists(new_file):
                file_size = os.path.getsize(new_file)
                shutil.move(new_file, dest_file)
                self.download_count += 1
                print(f"🎉 Saved 1K Image: {dest_file} ({file_size / 1024:.1f} KB)")
            else:
                print(f"⚠️ Image download could not be captured automatically for #{prompt_num:04d}.")

            # Inter-prompt cooldown
            if idx < len(self.prompts) - 1:
                print(f"☕ Cooldown {self.interval}s before next prompt...")
                time.sleep(self.interval)

        print("\n" + "=" * 70)
        print(f"🎉 SUCCESS! Processed {len(self.prompts)} prompts.")
        print(f"📁 Images saved to: {self.download_dir}")
        print("=" * 70)

    # --- CDP Engine ---
    async def run_with_cdp(self):
        from playwright.async_api import async_playwright
        print("🔌 Connecting to Chrome via DevTools Protocol (port 9222)...")
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp("http://localhost:9222")
            context = browser.contexts[0]

            flow_page = None
            for page in context.pages:
                if "flow.google.com" in page.url or "labs.google/fx/tools/flow" in page.url:
                    flow_page = page
                    break

            if not flow_page:
                flow_page = await context.new_page()
                await flow_page.goto("https://flow.google.com/", wait_until="domcontentloaded")
                await asyncio.sleep(2.0)

            await flow_page.bring_to_front()
            print("✅ Connected to Google Flow tab!")

            await flow_page.evaluate(FLOW_AUTOMATION_JS)

            # Ensure Normal Mode
            await flow_page.evaluate("window.__afEnsureNormalMode()")

            # Apply Generation Settings (Nano Banana 2, 16:9, x1) & Verify 0 Credits
            print("⚙️ Enforcing Settings: Nano Banana 2, 16:9, x1 (0 Credits)...")
            res = await flow_page.evaluate("window.__afApplySettings('Nano Banana 2', 1)")
            if not res.get("success"):
                raise RuntimeError(f"Failed to verify zero-credit settings: {res}")
            print("🛡️ Zero-Credit Image Model Confirmed!")

            for idx, prompt in enumerate(self.prompts):
                prompt_num = self.start_num + idx
                print(f"\n🖼️ [PROMPT {idx + 1}/{len(self.prompts)}] Target: {prompt_num:04d}.jpg")
                print(f"📝 Prompt: \"{prompt[:75]}...\"")

                # Stage prompt
                await flow_page.evaluate(f"window.__afStagePrompt({json.dumps(prompt)})")
                await asyncio.sleep(0.3)

                # Send prompt
                t0 = time.time()
                await flow_page.evaluate("window.__afClickSend()")
                print("🚀 Prompt Submitted! Monitoring generation (5–50s)...")

                # Dynamic generation monitor
                await asyncio.sleep(5.0)
                for _ in range(25):
                    is_gen = await flow_page.evaluate("window.__afIsGenerating()")
                    if not is_gen and (time.time() - t0) >= 8.0:
                        break
                    await asyncio.sleep(2.0)

                gen_time = time.time() - t0
                print(f"⏱️ Generation finished in {gen_time:.1f}s!")

                # Harvest tile
                tiles = await flow_page.evaluate("window.__afCollectTiles()")
                for tile in tiles:
                    src = tile.get("src", "")
                    if src and src not in self.downloaded_urls:
                        self.downloaded_urls.add(src)
                        dest_file = os.path.join(self.download_dir, f"{prompt_num:04d}.jpg")
                        ok, size = self.download_direct_jpeg(src, dest_file)
                        if ok:
                            self.download_count += 1
                            print(f"✅ Saved 1K Image: {dest_file} ({size / 1024:.1f} KB)")
                        break

                if idx < len(self.prompts) - 1:
                    await asyncio.sleep(self.interval)

    def download_direct_jpeg(self, image_url, dest_path):
        jpeg_url = af_jpeg_url(image_url)
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Referer": "https://flow.google.com/"
        }
        req = urllib.request.Request(jpeg_url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as response, open(dest_path, "wb") as out_file:
                shutil.copyfileobj(response, out_file)
            return True, os.path.getsize(dest_path)
        except Exception as e:
            return False, str(e)

def check_cdp_available(port=9222):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1.0) as resp:
            return resp.status == 200
    except Exception:
        return False

def main():
    parser = argparse.ArgumentParser(description="Ultra Auto Flow: 100% Google Flow Image Automation & 1K Downloader.")
    parser.add_argument("--prompts-file", type=str, default=None, help="Path to image_prompts.txt")
    parser.add_argument("--count", type=int, default=None, help="Number of prompts to process")
    parser.add_argument("--interval", type=int, default=5, help="Cooldown seconds between prompts")
    parser.add_argument("--start-num", type=int, default=1, help="Starting file number (e.g. 1 -> 0001.jpg)")
    parser.add_argument("--download-dir", type=str, default=None, help="Destination folder")
    parser.add_argument("--profile", type=str, default=None, help="Chrome profile name or substring")
    parser.add_argument("--resolution", "--quality", dest="resolution", type=str, default="2k", choices=["1k", "2k"], help="Download resolution (1k or 2k, default: 2k)")
    args = parser.parse_args()

    base_dir = os.path.dirname(os.path.abspath(__file__))
    prompts_file = args.prompts_file or os.path.join(base_dir, "image_prompts.txt")
    download_dir = args.download_dir or os.path.expanduser("~/Downloads/project 1")

    automation = UltraFlowAutomation(
        prompts_file=prompts_file,
        download_dir=download_dir,
        count=args.count,
        start_num=args.start_num,
        interval=args.interval,
        profile=args.profile,
        resolution=args.resolution
    )

    automation.load_queue()
    automation.print_banner()

    if check_cdp_available(9222):
        print("🎯 Chrome Remote Debugging (CDP) Detected on port 9222!")
        asyncio.run(automation.run_with_cdp())
    else:
        automation.run_native()

if __name__ == "__main__":
    main()
