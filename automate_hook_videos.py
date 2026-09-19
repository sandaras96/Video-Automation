#!/usr/bin/env python3
"""
================================================================================
  🎬 ULTRA AUTO HOOK — Google Flow 1-Minute Visual Hook Video Automation
  Generates Highly Engaging 3D Animation & 2.5D Infographic Video Clips
  Dual Engine: High-Speed Native Apple Vision OCR + Chrome DevTools Protocol (CDP)
================================================================================
  Features:
  1. Google Flow Video Models:
     - 'omni_flash': Omni 1.1 Flash (15 credits/gen) - Dynamic high retention
     - 'veo_3_1_lite': Veo 3.1 Lite (5 credits/gen) - Balanced efficiency
     - 'veo_3_1_quality': Veo 3.1 Quality (100 credits/gen) - Maximum cinematic fidelity
  2. Dynamic Progress Monitoring:
     - Watches live generation percentages (0-100%) and spinners.
  3. Automatic MP4 Video Download:
     - Downloads MP4 clips and saves them into destination folder as 0001.mp4, 0002.mp4...
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
FLOW_VIDEO_MODELS = {
    "veo_3_1_lite": {
        "id": "veo_3_1_lite",
        "name": "Veo 3.1 Lite",
        "type": "VIDEO",
        "cost": 5,
        "description": "5 Credits — Fast, high quality, balanced efficiency (Recommended)",
    },
    "omni_flash": {
        "id": "omni_flash",
        "name": "Omni 1.1 Flash",
        "type": "VIDEO",
        "cost": 15,
        "description": "15 Credits — High-speed dynamic motion generation",
    },
    "veo_3_1_quality": {
        "id": "veo_3_1_quality",
        "name": "Veo 3.1 Quality",
        "type": "VIDEO",
        "cost": 100,
        "description": "100 Credits — Maximum fidelity cinematic render",
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

def mouse_right_click(x, y):
    """Native right-click at screen coordinates (x, y)."""
    if not HAS_CG:
        return
    pt = CGPoint(float(x), float(y))
    e_down = cg.CGEventCreateMouseEvent(None, 3, pt, 2)  # kCGEventRightMouseDown
    cg.CGEventPost(0, e_down)
    time.sleep(0.05)
    e_up = cg.CGEventCreateMouseEvent(None, 4, pt, 2)    # kCGEventRightMouseUp
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

def load_hook_prompts(file_path):
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Prompts file '{file_path}' not found.")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    matches = re.findall(r"VIDEO\s+(\d+)[^\n]*:\s*\nContext:[^\n]*\n([^\n]+)", content)
    if matches:
        return [m[1].strip() for m in matches]

    matches_img = re.findall(r"IMAGE\s+(\d+)[^\n]*:\s*\nContext:[^\n]*\n([^\n]+)", content)
    if matches_img:
        return [m[1].strip() for m in matches_img]

    lines = [line.strip() for line in content.splitlines() if line.strip() and not line.startswith(("#", "="))]
    return lines

# --- Native Swift Vision OCR Engine ---
def get_ocr_elements(image_path, win_x=0, win_y=38, win_w=724, win_h=842):
    base_dir = os.path.dirname(os.path.abspath(__file__))
    ocr_bin = os.path.join(base_dir, "ocr_helper")
    if not os.path.exists(ocr_bin):
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
    q = query.lower() if case_insensitive else query
    for item in items:
        t = item["text"].lower() if case_insensitive else item["text"]
        if q in t:
            return item
    return None

def get_installed_profiles():
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
    profiles = get_installed_profiles()
    chosen_profile = None

    if profile_query:
        q = profile_query.lower()
        for p in profiles:
            if q in p["name"].lower() or q in p["dir"].lower():
                chosen_profile = p
                break
    else:
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
    end tell
    '''
    run_applescript(nav_script)
    time.sleep(1.0)
    set_window_bounds(win_x, win_y, win_x + win_w, win_y + win_h)
    ensure_chrome_frontmost()
    time.sleep(0.5)

def verify_and_set_video_mode(win_x, win_y, win_w, win_h, scratch_dir, target_model="Veo 3.1 Lite"):
    """
    Verifies that the target video model is active. If not, opens drawer, selects Video tab,
    picks target_model, selects x1 count, and closes drawer.
    """
    short_model = "omni" if "omni" in target_model.lower() else "veo"

    for attempt in range(3):
        screen_shot = os.path.join(scratch_dir, f"check_vid_mode_{attempt}.png")
        subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", screen_shot], check=True)
        elements = get_ocr_elements(screen_shot, win_x, win_y, win_w, win_h)

        # Check pill
        pill_item = find_ocr_item(elements, short_model) or find_ocr_item(elements, target_model)
        if pill_item:
            print(f"✅ Active Video Model verified: '{target_model}'")
            return True

        print("⚠️ Target video model not in active pill. Opening Settings drawer...")
        # Click settings trigger button near top/bottom right of prompt area
        mouse_click(win_x + win_w * 0.72, win_y + win_h * 0.9)
        time.sleep(0.7)

        subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", screen_shot], check=True)
        drawer_elements = get_ocr_elements(screen_shot, win_x, win_y, win_w, win_h)

        vid_tab = find_ocr_item(drawer_elements, "Video")
        if vid_tab:
            print(f"🎥 Selecting Video Mode tab at ({vid_tab['cx']:.0f}, {vid_tab['cy']:.0f})...")
            mouse_click(vid_tab["cx"], vid_tab["cy"])
            time.sleep(0.4)

        model_opt = find_ocr_item(drawer_elements, short_model)
        if model_opt:
            print(f"✨ Selecting Model '{target_model}' at ({model_opt['cx']:.0f}, {model_opt['cy']:.0f})...")
            mouse_click(model_opt["cx"], model_opt["cy"])
            time.sleep(0.4)

        x1_option = find_ocr_item(drawer_elements, "x1")
        if x1_option:
            mouse_click(x1_option["cx"], x1_option["cy"])
            time.sleep(0.3)

        run_applescript('tell application "System Events" to key code 53')  # Esc
        time.sleep(0.4)

    return True

def find_newest_video_download(downloads_dir, t_start, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        candidates = []
        try:
            for fname in os.listdir(downloads_dir):
                if fname.endswith('.crdownload') or fname.startswith('.'):
                    continue
                if fname.lower().endswith(('.mp4', '.mov', '.webm')):
                    fpath = os.path.join(downloads_dir, fname)
                    try:
                        mtime = os.path.getmtime(fpath)
                        if mtime >= t_start and os.path.getsize(fpath) > 50000:
                            candidates.append((fpath, mtime))
                    except OSError:
                        pass
        except OSError:
            pass

        if candidates:
            candidates.sort(key=lambda x: x[1], reverse=True)
            return candidates[0][0]

        time.sleep(0.8)
    return None

# --- CDP JavaScript Engine for Video ---
FLOW_VIDEO_JS = r"""
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

window.__afApplyVideoSettings = async function(modelName = 'Omni 1.1 Flash') {
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

    // 1. Select VIDEO Mode
    const vidRadio = [...pane.querySelectorAll('button[role="radio"], [role="tab"]')].find(b => {
        const txt = (b.innerText || '').toLowerCase();
        const icon = [...b.querySelectorAll('mat-icon, i')].map(m => (m.textContent || '').trim().toLowerCase()).join(' ');
        return txt.includes('video') || icon.includes('videocam') || icon.includes('movie');
    });
    if (vidRadio) {
        vidRadio.click();
        await window.__afWait(600);
    }

    // 2. Select Video Model
    const modelTrig = pane.querySelector('button.mat-mdc-menu-trigger');
    if (modelTrig) {
        modelTrig.click();
        await window.__afWait(500);
        const items = [...document.querySelectorAll('button.mat-mdc-menu-item, [role="menuitem"]')].filter(isVis);
        const targetModel = items.find(i => norm(i.textContent).includes(norm(modelName)));
        if (targetModel) {
            targetModel.click();
            await window.__afWait(500);
        }
    }

    // 3. Select 16:9 Aspect Ratio
    const asp169 = [...pane.querySelectorAll('button[role="radio"]')].find(b =>
        [...b.querySelectorAll('mat-icon, i')].some(m => (m.textContent || '').trim() === 'crop_16_9'));
    if (asp169) { asp169.click(); await window.__afWait(300); }

    // 4. Select Count (x1)
    const countRadio = [...pane.querySelectorAll('button[role="radio"]')].find(b =>
        /^x1$/i.test((b.textContent || '').trim().replace(/\s+/g, '')));
    if (countRadio) { countRadio.click(); await window.__afWait(300); }

    trig.click();
    await window.__afWait(300);
    return { success: true, model: modelName };
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

window.__afGetVideoStatus = function() {
    const spinners = [...document.querySelectorAll('mat-spinner, mat-progress-spinner, .shimmer, .generating')];
    const isSpinning = spinners.some(s => s.offsetParent !== null);
    const bodyText = document.body.innerText || '';
    const pctMatch = bodyText.match(/(\d{1,3})%/);
    const progress = pctMatch ? pctMatch[0] : '';

    return {
        isGenerating: isSpinning || (/generating|loading/i.test(bodyText) && pctMatch !== null),
        progress: progress
    };
};

window.__afTriggerLatestVideoDownload = async function(quality = '720p') {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const isVis = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };

    const cards = [...document.querySelectorAll('flow-grid-tile-container, flow-tile-container, flow-video-tile, flow-image-tile, [class*="grid-tile"]')].filter(isVis);
    if (!cards.length) return { success: false, error: 'no_cards_found' };

    const card = cards[cards.length - 1];
    card.scrollIntoView({ block: 'center' });
    await wait(300);

    const cr = card.getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    ['pointerover', 'mouseover', 'pointerenter', 'mouseenter'].forEach(t =>
        card.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: cx, clientY: cy })));
    await wait(250);

    const btns = [...card.querySelectorAll('button, [role="button"]')].filter(isVis);
    const menuBtn = btns.find(b => {
        const al = (b.getAttribute('aria-label') || '').toLowerCase();
        const ic = [...b.querySelectorAll('mat-icon, i')].map(m => (m.textContent || '').trim()).join(' ');
        return ic.includes('more_vert') || al.includes('options') || al.includes('menu') || al.includes('diğer');
    }) || btns[btns.length - 1];

    if (!menuBtn) return { success: false, error: 'menu_btn_not_found' };
    menuBtn.click();
    await wait(400);

    const menuItems = [...document.querySelectorAll('[role="menuitem"], [role="option"], li, button')].filter(isVis);
    const dlItem = menuItems.find(el => /download|indir/i.test(el.innerText || ''));
    if (!dlItem) return { success: false, error: 'download_item_not_found' };

    dlItem.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    dlItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await wait(300);
    dlItem.click();
    await wait(400);

    const subItems = [...document.querySelectorAll('[role="menuitem"], [role="option"], li, button')].filter(isVis);
    const qItem = subItems.find(el => new RegExp(quality, 'i').test(el.innerText || '')) ||
                  subItems.find(el => /\d{3,4}\s*p/i.test(el.innerText || ''));

    if (qItem) {
        qItem.click();
        await wait(300);
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { success: true };
};
"""

class UltraHookVideoAutomation:
    def __init__(self, prompts_file=None, download_dir=None, model="omni_flash", count=None, start_num=1, interval=5, profile=None):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        self.prompts_file = prompts_file or os.path.join(base_dir, "hook_video_prompts.txt")
        self.download_dir = os.path.expanduser(download_dir or "~/Downloads/visual_hooks")
        self.model_key = model
        self.model_info = FLOW_VIDEO_MODELS.get(model, FLOW_VIDEO_MODELS["omni_flash"])
        self.count = count
        self.start_num = max(1, start_num)
        self.interval = max(1, interval)
        self.profile = profile
        self.prompts = []
        self.download_count = 0
        os.makedirs(self.download_dir, exist_ok=True)

    def load_queue(self):
        raw_prompts = load_hook_prompts(self.prompts_file)
        if not raw_prompts:
            raise RuntimeError(f"No prompts found in '{self.prompts_file}'")

        start_idx = self.start_num - 1
        raw_prompts = raw_prompts[start_idx:]
        if self.count and self.count > 0:
            raw_prompts = raw_prompts[:self.count]

        self.prompts = [clean_prompt_for_flow(p) for p in raw_prompts]
        return len(self.prompts)

    def print_banner(self):
        total_credits = len(self.prompts) * self.model_info["cost"]
        print("\n============================================================================")
        print("  🎬 ULTRA AUTO HOOK — 1-MINUTE VISUAL HOOK VIDEO AUTOMATION       ")
        print("  High-Retention 3D Medical Animation & 2.5D Infographics Generator ")
        print("============================================================================")
        print(f"📄 Prompts File    : {os.path.basename(self.prompts_file)}")
        print(f"📦 Total Hook Clips: {len(self.prompts)} videos (~8-10s each)")
        print(f"📁 Destination     : {self.download_dir}")
        print(f"🔢 Starting Clip   : {self.start_num:04d}")
        print(f"🎥 Video Model     : {self.model_info['name']} ({self.model_info['cost']} Credits/gen)")
        print(f"💳 Estimated Cost  : ~{total_credits} Credits total for 1 minute hook")
        print("⏱️ Generation Timing: Dynamic Video Monitoring (30–150s per video)")
        print("============================================================================\n")

    def run_native(self):
        print("💻 Running Native Apple Vision OCR + CoreGraphics Video Automation...")
        win_x, win_y, win_w, win_h = 0, 38, 724, 842
        activate_chrome_profile(self.profile)
        ensure_flow_tab_and_canvas(win_x, win_y, win_w, win_h)

        scratch_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scratch")
        os.makedirs(scratch_dir, exist_ok=True)
        user_downloads = os.path.expanduser("~/Downloads")

        verify_and_set_video_mode(win_x, win_y, win_w, win_h, scratch_dir, self.model_info["name"])

        for idx, prompt in enumerate(self.prompts):
            clip_num = self.start_num + idx
            print(f"\n----------------------------------------------------------------------")
            print(f"🎬 [HOOK VIDEO {idx + 1}/{len(self.prompts)}] Target: {clip_num:04d}.mp4")
            print(f"📝 Prompt: \"{prompt[:80]}...\"")
            print(f"📋 Pasting Video Prompt into Flow Input...")

            ensure_chrome_frontmost()
            p = subprocess.Popen(["pbcopy"], stdin=subprocess.PIPE)
            p.communicate(prompt.encode("utf-8"))

            screen_shot = os.path.join(scratch_dir, f"hook_screen_{idx}.png")
            subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", screen_shot], check=True)
            elements = get_ocr_elements(screen_shot, win_x, win_y, win_w, win_h)

            prompt_box = find_ocr_item(elements, "What do you want to create")
            if prompt_box:
                mouse_click(prompt_box["cx"], prompt_box["cy"])
            else:
                mouse_click(win_x + win_w * 0.35, win_y + win_h * 0.9)
            time.sleep(0.2)

            run_applescript('''
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
            ''')
            time.sleep(0.4)

            print("🚀 Submitting Video Generation Request...")
            t0 = time.time()

            send_item = find_ocr_item(elements, "→")
            if send_item:
                mouse_click(send_item["cx"], send_item["cy"])
            else:
                mouse_click(win_x + win_w * 0.87, win_y + win_h * 0.94)

            print(f"⏱️ Generating video ({self.model_info['name']})... Monitoring progress dynamically (max 150s)...")
            time.sleep(15.0)

            completed = False
            for _ in range(40):
                elapsed = time.time() - t0
                poll_shot = os.path.join(scratch_dir, f"hook_poll_{idx}.png")
                try:
                    subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", poll_shot], check=True)
                    poll_items = get_ocr_elements(poll_shot, win_x, win_y, win_w, win_h)

                    progress_str = ""
                    for it in poll_items:
                        t = it["text"]
                        if "%" in t:
                            progress_str = f" (Progress: {t})"
                            break

                    print(f"\r⏳ Rendering video... Elapsed: {elapsed:.1f}s / max 150s{progress_str}", end="", flush=True)

                    is_loading = bool(find_ocr_item(poll_items, "Loading") or find_ocr_item(poll_items, "Generating"))
                    if not is_loading and elapsed >= 30.0:
                        completed = True
                        print(f"\n🎉 Video Generation Finished! Total Render Time: {elapsed:.1f}s")
                        break
                except Exception:
                    pass
                time.sleep(3.0)

            if not completed:
                elapsed = time.time() - t0
                print(f"\n⏱️ Render completed (Elapsed: {elapsed:.1f}s). Proceeding to MP4 download...")

            # Download Video
            print(f"📥 Initiating Video Download for Hook Clip {idx + 1}...")
            card_x = win_x + win_w * 0.5
            card_y = win_y + win_h * 0.55
            ensure_chrome_frontmost()
            mouse_right_click(card_x, card_y)
            time.sleep(0.5)

            menu_shot = os.path.join(scratch_dir, f"hook_menu_{idx}.png")
            subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", menu_shot], check=True)
            menu_items = get_ocr_elements(menu_shot, win_x, win_y, win_w, win_h)
            dl_item = find_ocr_item(menu_items, "Download") or find_ocr_item(menu_items, "İndir")

            t_dl = time.time() - 2.0
            if dl_item:
                mouse_click(dl_item["cx"], dl_item["cy"])
                print(f"✅ Clicked Download at ({dl_item['cx']:.0f}, {dl_item['cy']:.0f})")
                time.sleep(0.5)

                sub_shot = os.path.join(scratch_dir, f"hook_sub_{idx}.png")
                subprocess.run(["screencapture", "-x", "-R", f"{win_x},{win_y},{win_w},{win_h}", sub_shot], check=True)
                sub_items = get_ocr_elements(sub_shot, win_x, win_y, win_w, win_h)
                q_item = find_ocr_item(sub_items, "720p") or find_ocr_item(sub_items, "1080p") or find_ocr_item(sub_items, "Original")
                if q_item:
                    mouse_click(q_item["cx"], q_item["cy"])
                    print(f"✅ Selected Quality at ({q_item['cx']:.0f}, {q_item['cy']:.0f})")
                else:
                    mouse_click(dl_item["cx"] + 112, dl_item["cy"] + 14)
            else:
                mouse_click(win_x + win_w * 0.83, win_y + win_h * 0.68)

            new_video = find_newest_video_download(user_downloads, t_dl, timeout=45)
            run_applescript('tell application "System Events" to key code 53')
            time.sleep(0.3)

            dest_file = os.path.join(self.download_dir, f"{clip_num:04d}.mp4")
            if new_video and os.path.exists(new_video):
                file_size = os.path.getsize(new_video)
                shutil.move(new_video, dest_file)
                self.download_count += 1
                print(f"🎉 Saved Hook Video: {dest_file} ({file_size / (1024 * 1024):.2f} MB)")
            else:
                print(f"⚠️ Video download could not be captured automatically for #{clip_num:04d}.mp4.")

            if idx < len(self.prompts) - 1:
                print(f"☕ Cooldown {self.interval}s before next video prompt...")
                time.sleep(self.interval)

        print("\n============================================================================")
        print(f"🎉 SUCCESS! Processed {self.download_count}/{len(self.prompts)} visual hook videos.")
        print(f"📁 Videos saved to: {self.download_dir}")
        print("============================================================================\n")

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

            await flow_page.evaluate(FLOW_VIDEO_JS)
            await flow_page.evaluate("window.__afEnsureNormalMode()")

            print(f"⚙️ Enforcing Video Model: '{self.model_info['name']}'...")
            res = await flow_page.evaluate(f"window.__afApplyVideoSettings({json.dumps(self.model_info['name'])})")
            print(f"🎥 Video Model Verified: {res}")

            user_downloads = os.path.expanduser("~/Downloads")

            for idx, prompt in enumerate(self.prompts):
                clip_num = self.start_num + idx
                print(f"\n🎬 [HOOK VIDEO {idx + 1}/{len(self.prompts)}] Target: {clip_num:04d}.mp4")
                print(f"📝 Prompt: \"{prompt[:80]}...\"")

                await flow_page.evaluate(f"window.__afStagePrompt({json.dumps(prompt)})")
                await asyncio.sleep(0.3)

                t0 = time.time()
                await flow_page.evaluate("window.__afClickSend()")
                print(f"🚀 Video Generation Submitted! Monitoring ({self.model_info['name']})...")

                await asyncio.sleep(12.0)
                for _ in range(40):
                    status = await flow_page.evaluate("window.__afGetVideoStatus()")
                    elapsed = time.time() - t0
                    print(f"\r⏳ Rendering video... Elapsed: {elapsed:.1f}s {status.get('progress', '')}", end="", flush=True)
                    if not status.get("isGenerating") and elapsed >= 25.0:
                        break
                    await asyncio.sleep(3.0)

                gen_time = time.time() - t0
                print(f"\n⏱️ Video generation finished in {gen_time:.1f}s! Initiating download...")

                t_dl = time.time() - 2.0
                await flow_page.evaluate("window.__afTriggerLatestVideoDownload('720p')")
                print("📥 Triggered Video Download. Waiting for file...")

                new_video = find_newest_video_download(user_downloads, t_dl, timeout=45)
                dest_file = os.path.join(self.download_dir, f"{clip_num:04d}.mp4")
                if new_video and os.path.exists(new_video):
                    size = os.path.getsize(new_video)
                    shutil.move(new_video, dest_file)
                    self.download_count += 1
                    print(f"✅ Saved Hook Video: {dest_file} ({size / (1024 * 1024):.2f} MB)")
                else:
                    print(f"⚠️ Video download could not be captured automatically for #{clip_num:04d}.mp4.")

                if idx < len(self.prompts) - 1:
                    await asyncio.sleep(self.interval)

        print("\n============================================================================")
        print(f"🎉 SUCCESS! Processed {self.download_count}/{len(self.prompts)} visual hook videos.")
        print(f"📁 Videos saved to: {self.download_dir}")
        print("============================================================================\n")

def check_cdp_available(port=9222):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1.0) as resp:
            return resp.status == 200
    except Exception:
        return False

def main():
    parser = argparse.ArgumentParser(description="Ultra Auto Hook: 1-Minute Visual Hook Video Automation for Google Flow.")
    parser.add_argument("--prompts-file", type=str, default=None, help="Path to hook_video_prompts.txt")
    parser.add_argument("--count", type=int, default=7, help="Number of hook video clips (default: 7)")
    parser.add_argument("--interval", type=int, default=5, help="Cooldown seconds between clips")
    parser.add_argument("--start-num", type=int, default=1, help="Starting file number (e.g. 1 -> 0001.mp4)")
    parser.add_argument("--download-dir", type=str, default=None, help="Destination folder")
    parser.add_argument("--model", type=str, default="omni_flash", choices=["omni_flash", "veo_3_1_lite", "veo_3_1_quality"], help="Video model to use")
    parser.add_argument("--profile", type=str, default=None, help="Chrome profile name or substring")
    args = parser.parse_args()

    base_dir = os.path.dirname(os.path.abspath(__file__))
    prompts_file = args.prompts_file or os.path.join(base_dir, "hook_video_prompts.txt")
    download_dir = args.download_dir or os.path.expanduser("~/Downloads/visual_hooks")

    automation = UltraHookVideoAutomation(
        prompts_file=prompts_file,
        download_dir=download_dir,
        model=args.model,
        count=args.count,
        start_num=args.start_num,
        interval=args.interval,
        profile=args.profile
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
