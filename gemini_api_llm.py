#!/usr/bin/env python3
"""
================================================================================
  🧠 GEMINI API LLM ENGINE — Direct High-Speed Script & Prompt Generation
================================================================================
  Features:
  1. Direct Google Generative Language API integration (zero browser required).
  2. Multi-key pool with automatic rotation and rate-limit retry.
  3. Uses ultra-fast modern Gemini models (gemini-3.6-flash, gemini-3.8-flash).
  4. Generates 2,500+ word YouTube scripts in seconds.
  5. Headless, 100% reliable, zero focus or coordinate dependencies.
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

# Primary and fallback models for text generation
DEFAULT_MODELS = [
    "gemini-3.6-flash",
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview"
]

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

def call_gemini_llm(prompt, model=None, temperature=0.7, max_tokens=8192):
    keys = get_api_keys()
    if not keys:
        raise RuntimeError("No Gemini API keys found in config.json")

    models = [model] if model else DEFAULT_MODELS

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt}
                ]
            }
        ],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens
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
                print(f"🚀 Generating with [{cur_model}] using Key {idx + 1}/{len(keys)} ({masked})...")
                t0 = time.time()

                with urllib.request.urlopen(req, timeout=120) as resp:
                    res_json = json.loads(resp.read().decode("utf-8"))

                candidates = res_json.get("candidates", [])
                if not candidates:
                    raise ValueError(f"No candidates returned: {res_json}")

                parts = candidates[0].get("content", {}).get("parts", [])
                if not parts:
                    raise ValueError(f"No text parts in candidate: {candidates[0]}")

                generated_text = parts[0].get("text", "")
                elapsed = time.time() - t0
                words = len(generated_text.split())
                print(f"✅ Generated {words:,} words in {elapsed:.1f}s via [{cur_model}]!")
                return generated_text

            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8")
                last_error = f"HTTP {e.code}: {err_body[:300]}"
                print(f"⚠️ Key {idx + 1} ({cur_model}) error: {last_error}")
                if e.code == 429:
                    # Rate limit - continue to next key immediately
                    continue
                elif e.code == 404:
                    # Model not available, try next model
                    break
            except Exception as e:
                last_error = str(e)
                print(f"⚠️ Request error: {last_error}")
                continue

    raise RuntimeError(f"All Gemini API keys and models failed. Last error: {last_error}")

def generate_script(topic, prompt_file=None, output_path=None, model=None):
    # Find master prompt template
    candidates = glob.glob(os.path.join(BASE_DIR, "*Script*.lua")) + glob.glob(os.path.join(BASE_DIR, "*.lua"))
    template_file = prompt_file or (candidates[0] if candidates else None)

    if not template_file or not os.path.exists(template_file):
        raise FileNotFoundError(f"Master prompt template not found at {template_file}")

    with open(template_file, "r", encoding="utf-8") as f:
        template = f.read()

    # Substitute topic
    prompt = re.sub(r"TOPIC:\s*[^\n]+", f"TOPIC: {topic}", template, count=1)
    print(f"🎯 Configured YouTube Topic: \"{topic}\"")

    text = call_gemini_llm(prompt, model=model)

    if output_path:
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"💾 Saved script to: {output_path}")

    return text

def main():
    parser = argparse.ArgumentParser(description="Direct Gemini API LLM Engine.")
    parser.add_argument("--topic", type=str, required=True, help="YouTube video topic")
    parser.add_argument("--prompt-file", type=str, default=None, help="Prompt template file")
    parser.add_argument("--output", type=str, default=None, help="Output script file path")
    parser.add_argument("--model", type=str, default=None, help="Gemini model name")
    args = parser.parse_args()

    generate_script(args.topic, prompt_file=args.prompt_file, output_path=args.output, model=args.model)

if __name__ == "__main__":
    main()
