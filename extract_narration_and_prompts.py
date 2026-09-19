#!/usr/bin/env python3
"""
Medical Script Narration & 2.5D Infographic Prompt Generator
------------------------------------------------------------
1. Extracts clean, pure narration from the generated YouTube script.
2. Splits narration into natural, complete sentences (handling quotes & abbreviations).
3. Groups sentences into exact 2-sentence pairs.
4. Generates bespoke 2.5D Infographic Medical Illustration prompts
   for every 2-sentence block, optimized for Midjourney, Flux, and DALL-E.
5. Produces three ready-to-use output files:
   - narration_with_illustrations.txt : Narration interleaved with 2.5D image prompts.
   - image_prompts.txt                : Standalone, numbered list of 2.5D image prompts.
   - narration_only.txt               : Pure voiceover text ready for TTS / recording.
"""

import argparse
import os
import random
import re
import sys

def extract_raw_narration(text):
    """Isolates the actual spoken narration body from markdown headings, B-roll, and metadata."""
    # Find script section if markdown headings exist
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

        # Skip timestamp / section headers like **[0:00–0:30] COLD OPEN HOOK** or Block headers
        if re.match(r"^\*{0,2}\[?\d+:\d+.*?\]?\*{0,2}$", line, re.IGNORECASE):
            continue
        if re.match(r"^\*{0,2}BLOCK\s*\d+.*?\*{0,2}$", line, re.IGNORECASE):
            continue
        if re.match(r"^\*{0,2}THE\s*OPEN\s*LOOP.*?\*{0,2}$", line, re.IGNORECASE):
            continue
        if re.match(r"^\*{0,2}COLD\s*OPEN.*?\*{0,2}$", line, re.IGNORECASE):
            continue

        # Skip standalone B-Roll cues [B-ROLL: ...]
        if re.match(r"^\[(?:B-ROLL|VISUAL|CUE).*?\]$", line, re.IGNORECASE):
            continue

        # Handle CTA labels like *CTA 1 (20%):* - keep the spoken text
        line = re.sub(r"^\*?CTA\s*\d+.*?:\*?\s*", "", line, flags=re.IGNORECASE)

        # Remove speaker identifiers: **NARRATOR:**, NARRATOR:, HOST:, etc.
        line = re.sub(r"^\*{0,2}(NARRATOR|HOST|SPEAKER|VOICEOVER|DOCTOR)\s*:\*{0,2}\s*", "", line, flags=re.IGNORECASE)

        # Remove inline B-Roll brackets inside sentences
        line = re.sub(r"\[(?:B-ROLL|VISUAL|CUE|VERIFY).*?\]", "", line, flags=re.IGNORECASE)

        # Strip remaining markdown formatting (*, **, _, `)
        line = re.sub(r"\*{1,3}(.*?)\*{1,3}", r"\1", line)
        line = re.sub(r"_{1,3}(.*?)_{1,3}", r"\1", line)
        line = re.sub(r"`(.*?)`", r"\1", line)

        # Clean multiple spaces
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            cleaned_paragraphs.append(line)

    return cleaned_paragraphs

def split_into_sentences(paragraphs):
    """Splits paragraphs into clean, distinct sentences with abbreviation & quotation protection."""
    full_text = " ".join(paragraphs)

    abbrevs = [
        "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "vs.", "e.g.", "i.e.", "U.S.",
        "No.", "vol.", "etc.", "approx.", "al.", "min.", "sec.", "meds.", "BP."
    ]
    protected = full_text
    for i, a in enumerate(abbrevs):
        protected = protected.replace(a, f"__ABBR_{i}__")

    # Split on sentence terminals (. ! ?) with or without trailing quotes followed by whitespace and capital letter
    split_pattern = r'(?<=[.!?])\s+(?=[A-Z0-9\"\'“‘])|(?<=[.!?][\"\'”’])\s+(?=[A-Z0-9\"\'“‘])'
    raw_splits = re.split(split_pattern, protected)

    sentences = []
    for s in raw_splits:
        for i, a in enumerate(abbrevs):
            s = s.replace(f"__ABBR_{i}__", a)
        s = s.strip()
        # Clean stray quotes and leading dashes
        s = re.sub(r"^\s*[-—–]\s*", "", s)
        if s and len(s) > 3:
            sentences.append(s)

    return sentences

STYLE_VARIANTS = [
    "2.5D inforgraphic medical animation style",
    "2.5D medical animation style",
    "2.5D simplified inforgraphic medical animation style"
]

def generate_25d_illustration_prompt(sentence_pair, index, total, chosen_style=None):
    """
    Takes two sentences from the script and appends a randomized 2.5D medical animation style at the end:
      1. 2.5D inforgraphic medical animation style
      2. 2.5D medical animation style
      3. 2.5D simplified inforgraphic medical animation style
    """
    pair_text = " ".join(sentence_pair).strip()
    cleaned_text = pair_text.rstrip(".?! ")

    if chosen_style is None:
        chosen_style = random.choice(STYLE_VARIANTS)

    prompt = f"{cleaned_text}, {chosen_style}"
    return prompt, chosen_style

def process_script(input_path, out_interleaved, out_prompts, out_narration):
    """Processes script into 2-sentence pairs and generates all outputs."""
    if not os.path.exists(input_path):
        print(f"[ERROR] Input file not found: {input_path}")
        sys.exit(1)

    with open(input_path, "r", encoding="utf-8") as f:
        content = f.read()

    paragraphs = extract_raw_narration(content)
    sentences = split_into_sentences(paragraphs)

    if not sentences:
        print("[ERROR] No narration sentences extracted.")
        sys.exit(1)

    print(f"📖 Extracted {len(sentences)} total narration sentences.")

    # Group into pairs
    pairs = []
    for i in range(0, len(sentences), 2):
        chunk = sentences[i : i + 2]
        pairs.append(chunk)

    total_pairs = len(pairs)
    print(f"🎨 Generating {total_pairs} 2.5D Medical Animation prompts (1 per 2 sentences)...")

    interleaved_blocks = []
    standalone_prompts = []
    narration_only_blocks = []

    for idx, pair in enumerate(pairs, start=1):
        pair_text = " ".join(pair)
        prompt, style_name = generate_25d_illustration_prompt(pair, idx, total_pairs)

        # 1. Interleaved format
        interleaved_entry = (
            f"[{idx}/{total_pairs}] NARRATION:\n"
            f'"{pair_text}"\n\n'
            f"🖼️ [{style_name.upper()} {idx}]:\n"
            f"Prompt: {prompt}\n"
            f"{'-' * 80}\n"
        )
        interleaved_blocks.append(interleaved_entry)

        # 2. Standalone prompts format
        prompt_entry = (
            f"IMAGE {idx} (Sentences {idx*2-1}-{min(idx*2, len(sentences))} - {style_name.upper()}):\n"
            f"Context: {pair_text[:90]}...\n"
            f"{prompt}\n"
        )
        standalone_prompts.append(prompt_entry)

        # 3. Narration only
        narration_only_blocks.append(pair_text)

    # Write interleaved file
    with open(out_interleaved, "w", encoding="utf-8") as f:
        f.write("=" * 80 + "\n")
        f.write("🎬 YOUTUBE SCRIPT NARRATION WITH 2.5D INFOGRAPHIC MEDICAL ILLUSTRATIONS\n")
        f.write("   (Arranged every 2 sentences for visual pacing)\n")
        f.write("=" * 80 + "\n\n")
        f.write("\n".join(interleaved_blocks))

    # Write standalone prompts file
    with open(out_prompts, "w", encoding="utf-8") as f:
        f.write("=" * 80 + "\n")
        f.write("🎨 2.5D INFOGRAPHIC MEDICAL ILLUSTRATION PROMPTS (MIDJOURNEY / FLUX / DALL-E)\n")
        f.write(f"   Total Prompts: {total_pairs} (1 image every 2 spoken sentences)\n")
        f.write("=" * 80 + "\n\n")
        f.write("\n\n".join(standalone_prompts))

    # Write narration only file
    with open(out_narration, "w", encoding="utf-8") as f:
        f.write("=" * 80 + "\n")
        f.write("🎙️ PURE VOICEOVER NARRATION SCRIPT (CLEAN VOICE TRACK)\n")
        f.write("=" * 80 + "\n\n")
        f.write("\n\n".join(narration_only_blocks))

    print("\n" + "=" * 60)
    print("🎉 NARRATION & 2.5D MEDICAL ILLUSTRATIONS GENERATED!")
    print("=" * 60)
    print(f"📁 1. Interleaved Script  : {out_interleaved}")
    print(f"📁 2. Image Prompts Only  : {out_prompts}")
    print(f"📁 3. Clean Voice Track   : {out_narration}")
    print(f"📊 Stats: {len(sentences)} sentences | {total_pairs} bespoke 2.5D image prompts")
    print("=" * 60)

def main():
    parser = argparse.ArgumentParser(
        description="Extract narration and generate 2.5D infographic medical illustration prompts every 2 sentences."
    )
    parser.add_argument(
        "--input", "-i",
        default="generated_gemini_script.txt",
        help="Input script file path (default: generated_gemini_script.txt)"
    )
    parser.add_argument(
        "--output-interleaved", "-oi",
        default="narration_with_illustrations.txt",
        help="Output interleaved script with prompts"
    )
    parser.add_argument(
        "--output-prompts", "-op",
        default="image_prompts.txt",
        help="Output standalone image prompts"
    )
    parser.add_argument(
        "--output-narration", "-on",
        default="narration_only.txt",
        help="Output pure voiceover text"
    )

    args = parser.parse_args()
    script_dir = os.path.dirname(os.path.abspath(__file__))

    inp = os.path.join(script_dir, args.input) if not os.path.isabs(args.input) else args.input
    out_int = os.path.join(script_dir, args.output_interleaved) if not os.path.isabs(args.output_interleaved) else args.output_interleaved
    out_p = os.path.join(script_dir, args.output_prompts) if not os.path.isabs(args.output_prompts) else args.output_prompts
    out_n = os.path.join(script_dir, args.output_narration) if not os.path.isabs(args.output_narration) else args.output_narration

    process_script(inp, out_int, out_p, out_n)

if __name__ == "__main__":
    main()
