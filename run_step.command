#!/usr/bin/env bash
# Double-clickable macOS launcher for Gemini Pro Automation Step
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "============================================================"
echo "    🚀 Starting Gemini Pro Script Automation Step          "
echo "============================================================"
echo ""

# Run Python automation script
python3 "$DIR/automate_gemini.py" "$@"

EXIT_CODE=$?
echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Successfully completed! Press any key or close this window."
else
    echo "⚠️ Process finished with code $EXIT_CODE."
fi

# Pause if opened by double-click in Terminal
if [ -t 0 ]; then
    read -n 1 -s -r -p "Press any key to exit..."
    echo ""
fi
