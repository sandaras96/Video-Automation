#!/usr/bin/env bash
# Double-clickable macOS launcher for Narration & 2.5D Image Prompt Generator
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "============================================================"
echo "    🎨 Extract Narration & Generate 2.5D Image Prompts     "
echo "============================================================"
echo ""

python3 "$DIR/extract_narration_and_prompts.py" "$@"

EXIT_CODE=$?
echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Successfully completed! Files created in folder:"
    echo "   - narration_with_illustrations.txt"
    echo "   - image_prompts.txt"
    echo "   - narration_only.txt"
else
    echo "⚠️ Process finished with error code $EXIT_CODE."
fi

if [ -t 0 ]; then
    read -n 1 -s -r -p "Press any key to exit..."
    echo ""
fi
