#!/usr/bin/env python3
"""
================================================================================
  🎬 1-MINUTE VISUAL HOOK VIDEO PROMPT GENERATOR
  3D Animation & 2.5D Medical Infographics for Google Flow Video Generation
================================================================================
Generates ultra-engaging, cinematic video prompts tailored for the first 1 minute
of YouTube narration (Cold Open Hook + Open Loops).
Optimized for Google Flow Video Models (Veo 3.1 Lite, Omni 1.1 Flash, Veo 3.1 Quality).
Outputs:
  - hook_video_prompts.txt (Ready for Google Flow Video Automation)
================================================================================
"""

import argparse
import os
import re
import sys

def extract_raw_narration(text):
    """Isolates spoken narration from headings, markdown cues, and B-roll notes."""
    script_match = re.search(
        r"(?:\*\*\d+\.\s*SCRIPT.*?\*\*|#+\s*SCRIPT)(.*?)(?:\n---|\n\*\*\d+\.\s*SOURCES|\n#+\s*SOURCES|\Z)",
        text,
        re.DOTALL | re.IGNORECASE,
    )
    raw = script_match.group(1) if script_match else text

    lines = raw.split("\n")
    cleaned_paragraphs = []

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Skip headers / markers
        if re.match(r"^\*{0,2}\[?\d+:\d+.*?\]?\*{0,2}$", line, re.IGNORECASE):
            continue
        if re.match(r"^\*{0,2}BLOCK\s*\d+.*?\*{0,2}$", line, re.IGNORECASE):
            continue
        if re.match(r"^\*{0,2}(?:THE\s*)?OPEN\s*LOOP.*?\*{0,2}$", line, re.IGNORECASE):
            continue
        if re.match(r"^\*{0,2}COLD\s*OPEN.*?\*{0,2}$", line, re.IGNORECASE):
            continue

        # Skip standalone B-Roll cues
        if re.match(r"^\[(?:B-ROLL|VISUAL|CUE).*?\]$", line, re.IGNORECASE):
            continue

        # Remove CTA labels
        line = re.sub(r"^\*?CTA\s*\d+.*?:\*?\s*", "", line, flags=re.IGNORECASE)

        # Remove speaker identifiers
        line = re.sub(r"^\*{0,2}(NARRATOR|HOST|SPEAKER|VOICEOVER|DOCTOR)\s*:\*{0,2}\s*", "", line, flags=re.IGNORECASE)

        # Remove inline B-Roll brackets
        line = re.sub(r"\[(?:B-ROLL|VISUAL|CUE|VERIFY).*?\]", "", line, flags=re.IGNORECASE)

        # Strip markdown formatting
        line = re.sub(r"\*{1,3}(.*?)\*{1,3}", r"\1", line)
        line = re.sub(r"_{1,3}(.*?)_{1,3}", r"\1", line)
        line = re.sub(r"`(.*?)`", r"\1", line)

        line = re.sub(r"\s+", " ", line).strip()
        if line:
            cleaned_paragraphs.append(line)

    return cleaned_paragraphs

def split_into_sentences(paragraphs):
    """Splits text into clean sentences with abbreviation protection."""
    full_text = " ".join(paragraphs)
    abbrevs = [
        "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "vs.", "e.g.", "i.e.", "U.S.",
        "No.", "vol.", "etc.", "approx.", "al.", "min.", "sec.", "meds.", "BP."
    ]
    protected = full_text
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

def generate_cinematic_hook_video_prompt(sentence_pair, index, total):
    """
    Generates a high-retention 3D animation / 2.5D medical infographic VIDEO prompt
    with cinematic camera direction and physical simulation dynamics.
    """
    text = " ".join(sentence_pair).lower()

    # Core high-end video aesthetic tokens
    video_style = (
        "cinematic 3D animation and 2.5D medical infographic motion graphic, "
        "isometric cutaway perspective, semi-translucent anatomical layers, soft ambient occlusion, "
        "frosted glass shaders, volumetric studio rim lighting, clinical color palette with deep slate navy background, "
        "glowing cyan fluid pathways, and warm amber accents, Octane render 3D animation, photorealistic medical render, "
        "ultra-smooth 60fps motion, clean composition, zero text, no typography, no labels, no watermark"
    )

    if "tiny pill" in text or "swallow" in text or ("blood pressure" in text and "heart" in text and index <= 2):
        camera_and_action = (
            "Cinematic macro slow push-in camera shot. A glowing translucent pharmaceutical capsule dissolves in slow motion, "
            "releasing glowing cyan and gold bio-active micro-particles into a pulsing 3D coronary artery. "
            "Biometric pressure wave pulses animate along the vascular walls with volumetric light rays and fluid particle simulation."
        )
    elif "clock" in text or ("speeding up" in text and "eye" in text) or "paradox" in text:
        camera_and_action = (
            "Smooth orbital 3D camera tracking shot around an anatomical cross-section of a human eye in 2.5D isometric cutaway. "
            "Inside the ciliary body and crystalline lens, intricate glowing mechanical clockwork gears smoothly turn and accelerate, "
            "casting dynamic amber and cyan volumetric light shadows, with subtle fluid currents swirling around the iris symbolizing accelerated biological time."
        )
    elif "arteries" in text and ("cloudy" in text or "cataracts" in text or "paradox" in text or "vision" in text):
        camera_and_action = (
            "Cinematic split-screen 3D medical motion graphic animation with slow tracking camera. "
            "On the left, glowing clear arterial vessels pulse with smooth red blood cell flow and cyan pressure indicators; "
            "on the right, a translucent 3D human eye lens gradually clouds over in real time with swirling milky amber opacification, "
            "connected by oscillating glowing fluid fibers with volumetric ray-traced lighting."
        )
    elif ("hypertension" in text or "classes" in text or "medication" in text) and ("offenders" in text or "connection" in text or "doctor" in text):
        camera_and_action = (
            "Cinematic crane-down camera shot revealing a holographic 3D comparative pharmaceutical pathway. "
            "Glowing 3D molecular models of ACE inhibitors, ARBs, and diuretic compounds rotate smoothly in mid-air "
            "above an illuminated glass consultation surface, interacting with glowing neural and ocular transmission pathways beside an anatomical eye model with volumetric lighting."
        )
    elif "habit" in text or "smoking" in text or "sunlight" in text or "worse" in text:
        camera_and_action = (
            "Dramatic cinematic 3D macro zoom-in camera into the anterior chamber of a translucent 3D human eye. "
            "Intense angled golden ultraviolet light beams strike the corneal surface, triggering dynamic bursts of glowing "
            "free-radical particle sparks and oxidative stress ripples across the crystalline lens proteins, with fluid particle physics simulation and volumetric god rays."
        )
    elif "protect" in text or "reverse" in text or "15 minutes" in text or "over 40" in text:
        camera_and_action = (
            "Cinematic 3D medical animation of ocular and cardiovascular protection with smooth sweeping camera glide. "
            "A translucent crystalline antioxidant shield actively forms over the ocular lens cross-section, "
            "repelling harmful oxidative particles with radiant cyan and emerald energy waves while vascular fluid flows harmoniously in the background."
        )
    elif "subscribe" in text or "myth" in text or "channel" in text:
        camera_and_action = (
            "High-energy 3D isometric medical motion graphic with dynamic rotating camera around a futuristic holographic health hub. "
            "An anatomical heart model and an anatomical eye model pulse in synchronization, connected by glowing high-speed "
            "fiber-optic data streams and interactive biometric rings expanding outwards in smooth waves with deep slate navy ambience."
        )
    else:
        # High-engagement fallback
        camera_and_action = (
            f"Cinematic 3D medical animation with smooth slow-motion camera movement. "
            f"Translucent human ocular and cardiovascular structures interact with glowing microscopic fluid pathways, "
            f"illuminating physiological cellular exchange and dynamic bio-mechanics with volumetric rim lighting."
        )

    return f"{camera_and_action} {video_style}"

def build_hook_prompts(input_file=None, output_file=None, num_pairs=7):
    """
    Extracts first 1 minute of narration and creates bespoke video prompts.
    """
    base_dir = os.path.dirname(os.path.abspath(__file__))

    if not input_file:
        for candidate in ["generated_gemini_script.txt", "narration_only.txt", "narration_with_illustrations.txt"]:
            cand_path = os.path.join(base_dir, candidate)
            if os.path.exists(cand_path):
                input_file = cand_path
                break

    if not input_file or not os.path.exists(input_file):
        raise FileNotFoundError("Could not find script file to extract hook narration from.")

    if not output_file:
        output_file = os.path.join(base_dir, "hook_video_prompts.txt")

    print(f"📖 Reading narration from: {os.path.basename(input_file)}")
    with open(input_file, "r", encoding="utf-8") as f:
        content = f.read()

    paragraphs = extract_raw_narration(content)
    sentences = split_into_sentences(paragraphs)

    # First 1 minute is approx. num_pairs * 2 sentences (~14 sentences)
    hook_sentences = sentences[:num_pairs * 2]
    sentence_pairs = []
    for i in range(0, len(hook_sentences), 2):
        pair = hook_sentences[i:i+2]
        if pair:
            sentence_pairs.append(pair)

    print(f"⏱️ Extracted {len(sentence_pairs)} sentence blocks for the 1-minute visual hook.")

    prompts = []
    lines = [
        "=" * 80,
        "🎬 1-MINUTE VISUAL HOOK VIDEO PROMPTS (GOOGLE FLOW: VEO / OMNI)",
        f"   Total Hook Videos: {len(sentence_pairs)} (~8-10 seconds per clip)",
        "   Style: 3D Medical Animation + 2.5D Isometric Infographic Motion Graphics",
        "=" * 80,
        ""
    ]

    for idx, pair in enumerate(sentence_pairs, start=1):
        context_text = " ".join(pair)
        prompt_text = generate_cinematic_hook_video_prompt(pair, idx, len(sentence_pairs))
        prompts.append(prompt_text)

        lines.append(f"VIDEO {idx} (Sentences {(idx-1)*2+1}-{idx*2}):")
        lines.append(f"Context: {context_text[:95]}...")
        lines.append(prompt_text)
        lines.append("")
        lines.append("")

    with open(output_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"✅ Generated {len(prompts)} visual hook video prompts in: {os.path.basename(output_file)}")
    return prompts

def main():
    parser = argparse.ArgumentParser(description="Generate 1-minute visual hook video prompts for Google Flow.")
    parser.add_argument("--input", type=str, default=None, help="Path to script or narration file")
    parser.add_argument("--output", type=str, default=None, help="Output prompts file path")
    parser.add_argument("--clips", type=int, default=7, help="Number of hook video clips (default: 7)")
    args = parser.parse_args()

    build_hook_prompts(input_file=args.input, output_file=args.output, num_pairs=args.clips)

if __name__ == "__main__":
    main()
