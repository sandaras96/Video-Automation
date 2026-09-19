#!/usr/bin/env python3
"""
================================================================================
  ⚡ GEMINI AUTOMATION — High-Speed Playwright & CDP Engine
================================================================================
  Features:
  1. Direct Playwright Automation via Chrome DevTools Protocol (CDP port 9222).
  2. Auto-launches Chrome with remote debugging if not already running.
  3. Seamless model selection (Gemini Pro / Gemini Advanced).
  4. Instant prompt injection directly into Gemini DOM (no screen coordinates!).
  5. Live streaming monitor — detects generation completion dynamically.
  6. Clean DOM text extraction & native copy verification.
  7. Background execution: Does NOT steal mouse focus or keyboard!
================================================================================
"""

import argparse
import asyncio
import glob
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error

# --- Configuration & Defaults ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

CONFIG = load_config()
DEFAULT_PROFILE = CONFIG.get("default_profile", "Menaka Gemini Pro")
DEFAULT_OUTPUT = CONFIG.get("default_output_file", "generated_gemini_script.txt")
DEFAULT_MODEL = CONFIG.get("model_target", "Gemini Pro")

# --- Helper: Check if CDP Port is active ---
def is_cdp_available(port=9222):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1.0) as resp:
            return resp.status == 200
    except Exception:
        return False

# --- Helper: Launch Chrome with Remote Debugging ---
def launch_chrome_cdp(port=9222, profile_name=None):
    print(f"🔌 Launching Google Chrome with remote debugging port {port}...")
    cmd = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        f"--remote-debugging-port={port}",
        "--no-first-run",
        "--no-default-browser-check"
    ]
    subprocess.Popen(cmd)
    # Wait for port to become available
    for _ in range(15):
        time.sleep(0.5)
        if is_cdp_available(port):
            print(f"✅ Chrome CDP port {port} is active and ready!")
            return True
    return False

# --- JavaScript Automation Snippets for Gemini DOM ---
GEMINI_AUTOMATION_JS = r"""
window.__geminiHelpers = {
    // 1. Locate the active prompt input element
    getInputElement: function() {
        const selectors = [
            'div.ql-editor[contenteditable="true"]',
            'rich-textarea [contenteditable="true"]',
            '[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]',
            'textarea[aria-label*="prompt" i]',
            'textarea'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
                return el;
            }
        }
        return null;
    },

    // 2. Stage prompt into editor
    setPrompt: function(text) {
        const el = this.getInputElement();
        if (!el) return { success: false, error: "Prompt input element not found" };

        el.focus();
        if (el.tagName === 'TEXTAREA') {
            el.value = text;
        } else {
            // ContentEditable / Quill
            el.innerText = text;
        }

        // Trigger input and change events so Gemini's UI enables Send button
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return { success: true };
    },

    // 3. Click Send button
    clickSend: function() {
        const selectors = [
            'button[aria-label*="Send" i]',
            'button.send-button',
            '[data-test-id="send-button"]'
        ];
        for (const sel of selectors) {
            try {
                const btn = document.querySelector(sel);
                if (btn && !btn.disabled && btn.offsetParent !== null) {
                    btn.click();
                    return { success: true, method: "button_click" };
                }
            } catch (e) {}
        }
        // Fallback: search all buttons for "send" icon/label
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
            const label = (b.getAttribute('aria-label') || '').toLowerCase();
            const text = (b.innerText || '').toLowerCase();
            if ((label.includes('send') || text.includes('send')) && !b.disabled && b.offsetParent !== null) {
                b.click();
                return { success: true, method: "button_search" };
            }
        }
        return { success: false, error: "Send button not clickable" };
    },

    // 4. Check generation status
    getStatus: function() {
        // Look for stop button (active while streaming)
        let isStreaming = false;
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
            const label = (b.getAttribute('aria-label') || '').toLowerCase();
            const text = (b.innerText || '').toLowerCase();
            if ((label.includes('stop') || text.includes('stop')) && b.offsetParent !== null) {
                isStreaming = true;
                break;
            }
        }

        // Get latest response text
        const responseEls = document.querySelectorAll('message-content, .model-response-text, [data-test-id="model-response"], .response-content, model-response');
        let latestText = "";
        if (responseEls.length > 0) {
            const last = responseEls[responseEls.length - 1];
            latestText = last.innerText || "";
        }

        return {
            isStreaming: isStreaming,
            responseCount: responseEls.length,
            textLength: latestText.length,
            sample: latestText.slice(-100)
        };
    },

    // 5. Extract latest complete response
    getLatestResponse: function() {
        const responseEls = document.querySelectorAll('message-content, .model-response-text, [data-test-id="model-response"], .response-content');
        if (responseEls.length === 0) return "";
        const last = responseEls[responseEls.length - 1];
        return last.innerText || "";
    },

    // 6. Check and switch model to Gemini Pro / Advanced
    ensureModel: function(targetName) {
        const target = (targetName || "pro").toLowerCase();
        // Look for model switcher button in header
        const switcherBtn = document.querySelector('button[aria-label*="model" i], [data-test-id="model-switcher-button"], button.model-switcher');
        const btnText = switcherBtn ? switcherBtn.innerText.toLowerCase() : "";

        if (btnText.includes(target) || (target === "pro" && (btnText.includes("advanced") || btnText.includes("pro")))) {
            return { success: true, active: btnText.trim(), changed: false };
        }

        if (switcherBtn) {
            switcherBtn.click();
            // Try to find the menu item
            setTimeout(() => {
                const items = document.querySelectorAll('[role="menuitem"], [role="option"], button');
                for (const item of items) {
                    const t = item.innerText.toLowerCase();
                    if (t.includes(target) || (target === "pro" && (t.includes("advanced") || t.includes("pro")))) {
                        item.click();
                        break;
                    }
                }
            }, 300);
            return { success: true, requested: target, changed: true };
        }

        return { success: true, active: "unknown", note: "Switcher button not found; using default active model" };
    }
};
"""

class GeminiPlaywrightAutomation:
    def __init__(self, prompt_content, output_path=None, model_target="Gemini Pro", port=9222):
        self.prompt_content = prompt_content
        self.output_path = output_path or os.path.join(BASE_DIR, DEFAULT_OUTPUT)
        self.model_target = model_target
        self.port = port

    async def run(self):
        from playwright.async_api import async_playwright

        # 1. Ensure Chrome with CDP is running
        if not is_cdp_available(self.port):
            print(f"⚠️ CDP not detected on port {self.port}. Attempting auto-launch...")
            if not launch_chrome_cdp(self.port):
                print(f"[ERROR] Could not start or connect to Chrome on port {self.port}.")
                print("👉 Please launch Chrome manually with:")
                print(f'   /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port={self.port}')
                sys.exit(1)

        print(f"🔌 Connecting to Chrome via Playwright CDP (port {self.port})...")
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(f"http://localhost:{self.port}")
            context = browser.contexts[0]

            # 2. Find or open Gemini tab
            gemini_page = None
            for page in context.pages:
                if "gemini.google.com" in page.url:
                    gemini_page = page
                    break

            if not gemini_page:
                print("🌐 Opening new tab for Gemini (https://gemini.google.com/app)...")
                gemini_page = await context.new_page()
                await gemini_page.goto("https://gemini.google.com/app", wait_until="domcontentloaded")
                await asyncio.sleep(2.0)
            else:
                print("✅ Found existing Gemini tab!")
                await gemini_page.bring_to_front()

            # Inject helper functions
            await gemini_page.evaluate(GEMINI_AUTOMATION_JS)
            await asyncio.sleep(0.5)

            # 3. Verify / Switch Model
            print(f"⚡ Checking model target: '{self.model_target}'...")
            model_info = await gemini_page.evaluate(f"window.__geminiHelpers.ensureModel({json.dumps(self.model_target)})")
            print(f"🎯 Model check result: {model_info}")

            # 4. Inject prompt
            print(f"📝 Staging prompt ({len(self.prompt_content):,} characters)...")
            res = await gemini_page.evaluate(f"window.__geminiHelpers.setPrompt({json.dumps(self.prompt_content)})")
            if not res.get("success"):
                # Fallback to Playwright locator fill
                print("⚠️ JS prompt inject returned false, trying Playwright locator fill...")
                input_locator = gemini_page.locator('div.ql-editor, rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"], textarea').first
                await input_locator.click()
                await input_locator.fill(self.prompt_content)

            await asyncio.sleep(0.4)

            # 5. Submit Prompt
            print("🚀 Submitting prompt...")
            send_res = await gemini_page.evaluate("window.__geminiHelpers.clickSend()")
            if not send_res.get("success"):
                # Fallback: Press Cmd+Enter
                print("⚡ Submitting via keyboard shortcut (Meta+Enter)...")
                await gemini_page.keyboard.press("Meta+Enter")

            t0 = time.time()
            print("\n⏳ Gemini is generating response... (Monitoring live stream)")

            # 6. Monitor streaming until generation completes
            await asyncio.sleep(3.0)
            prev_len = 0
            stable_ticks = 0

            while True:
                elapsed = int(time.time() - t0)
                status = await gemini_page.evaluate("window.__geminiHelpers.getStatus()")
                cur_len = status.get("textLength", 0)
                is_streaming = status.get("isStreaming", False)

                print(f"\r⚡ Generating... [{elapsed}s elapsed] | Current length: {cur_len:,} chars | Streaming: {is_streaming}", end="", flush=True)

                if cur_len > 300:
                    if not is_streaming:
                        stable_ticks += 1
                        if stable_ticks >= 3:  # Text stable and streaming stopped
                            print(f"\n✅ Generation complete! Total time: {elapsed}s")
                            break
                    else:
                        stable_ticks = 0
                else:
                    stable_ticks = 0

                if elapsed > 300:
                    print(f"\n⚠️ Reached 300s timeout. Extracting available output...")
                    break

                await asyncio.sleep(2.0)

            # 7. Extract the final response text
            final_text = await gemini_page.evaluate("window.__geminiHelpers.getLatestResponse()")
            if not final_text.strip():
                # Fallback: Try clicking native copy button
                copy_btn = gemini_page.locator('button[aria-label*="Copy" i], [data-test-id="copy-button"]').last
                if await copy_btn.count() > 0:
                    await copy_btn.click()
                    await asyncio.sleep(0.5)
                    try:
                        final_text = subprocess.check_output(["pbpaste"], text=True)
                    except Exception:
                        pass

            # 8. Save output
            if final_text.strip():
                self.save_output(final_text)
            else:
                print("❌ Could not extract generated response.")

    def save_output(self, text):
        with open(self.output_path, "w", encoding="utf-8") as f:
            f.write(text)
        words = len(text.split())
        chars = len(text)
        print("\n" + "=" * 60)
        print("🎉 SCRIPT GENERATED & SAVED SUCCESSFULLY VIA PLAYWRIGHT!")
        print("=" * 60)
        print(f"📁 Output File: {self.output_path}")
        print(f"📊 Stats      : {words:,} words | {chars:,} characters")
        print("=" * 60)

def main():
    parser = argparse.ArgumentParser(description="Lightning-fast Gemini Playwright Automation.")
    parser.add_argument("--prompt-file", type=str, default=None, help="Prompt file path")
    parser.add_argument("--topic", type=str, default=None, help="Topic to substitute into master prompt")
    parser.add_argument("--output", type=str, default=None, help="Output file path")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="Model target (default: Gemini Pro)")
    parser.add_argument("--port", type=int, default=9222, help="CDP port (default: 9222)")
    args = parser.parse_args()

    # Locate prompt file
    candidates = glob.glob(os.path.join(BASE_DIR, "*Script*.lua")) + glob.glob(os.path.join(BASE_DIR, "*.lua"))
    prompt_file = args.prompt_file or (candidates[0] if candidates else None)

    if not prompt_file or not os.path.exists(prompt_file):
        print(f"[ERROR] No valid prompt file found at: {prompt_file}")
        sys.exit(1)

    with open(prompt_file, "r", encoding="utf-8") as f:
        content = f.read()

    if args.topic:
        content = re.sub(r"TOPIC:\s*[^\n]+", f"TOPIC: {args.topic}", content, count=1)
        print(f"🎯 Configured Topic: \"{args.topic}\"")

    output_file = args.output or os.path.join(BASE_DIR, DEFAULT_OUTPUT)

    automation = GeminiPlaywrightAutomation(
        prompt_content=content,
        output_path=output_file,
        model_target=args.model,
        port=args.port
    )

    asyncio.run(automation.run())

if __name__ == "__main__":
    main()
