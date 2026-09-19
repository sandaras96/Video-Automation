#!/usr/bin/env bash
# ==============================================================================
#   Double-clickable macOS Launcher for Ultra Auto Flow
#   100% Google Flow Image Generation & Direct 1K Downloader
# ==============================================================================
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

clear
echo "========================================================================"
echo "    🚀 ULTRA AUTO FLOW — GOOGLE FLOW AUTOMATION & 1K DOWNLOADER        "
echo "    Ported 100% from ViralDNA Auto Flow Extension Engine               "
echo "========================================================================"
echo ""
echo "Select execution mode:"
echo "  [1] 🌟 Full Batch Run (All 57 Prompts from image_prompts.txt)"
echo "  [2] 🎯 Custom Batch Run (Specify prompt count and interval)"
echo "  [3] 🔄 Resume from Prompt Number (e.g. continue from prompt 6)"
echo "  [4] ⚡ Quick Test Run (1 Prompt + 1K Download Verification)"
echo "  [5] 🔌 Launch/Restart Chrome with CDP Port 9222 (Enables 100% Direct Mode)"
echo "  [6] 🧩 Open ViralDNA Auto Flow Extension Side Panel"
echo "  [7] ❌ Exit"
echo ""
read -p "Enter choice [1-7] (default: 1): " choice
choice=${choice:-1}

case $choice in
    1)
        echo ""
        echo "🚀 Starting Full Queue Automation..."
        python3 "$DIR/automate_flow.py" --interval 5 "$@"
        ;;
    2)
        echo ""
        read -p "Enter number of prompts to run [e.g. 5, 10, 20]: " prompt_count
        read -p "Enter interval seconds between generations [default 5]: " prompt_interval
        prompt_interval=${prompt_interval:-5}
        echo ""
        echo "🚀 Starting Custom Queue (${prompt_count} prompts, ${prompt_interval}s interval)..."
        python3 "$DIR/automate_flow.py" --count "$prompt_count" --interval "$prompt_interval" "$@"
        ;;
    3)
        echo ""
        read -p "Enter starting prompt number [e.g. 4]: " start_num
        read -p "Enter number of prompts to run [press Enter for all remaining]: " prompt_count
        read -p "Enter cooldown seconds between generations [default 5]: " prompt_interval
        prompt_interval=${prompt_interval:-5}
        echo ""
        if [ -z "$prompt_count" ]; then
            python3 "$DIR/automate_flow.py" --start-num "$start_num" --interval "$prompt_interval" "$@"
        else
            python3 "$DIR/automate_flow.py" --start-num "$start_num" --count "$prompt_count" --interval "$prompt_interval" "$@"
        fi
        ;;
    4)
        echo ""
        echo "⚡ Running Quick Test (1 Prompt + 1K Download)..."
        python3 "$DIR/automate_flow.py" --count 1 --interval 5 "$@"
        ;;
    5)
        echo ""
        echo "🔌 Launching Chrome with Remote Debugging Port 9222..."
        /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 &
        sleep 2
        echo "✅ Chrome launched with CDP support! You can now select Option [1], [2], or [3]."
        ;;
    6)
        echo ""
        echo "🧩 Opening ViralDNA Auto Flow Extension Side Panel..."
        osascript -e 'tell application "Google Chrome" to open location "chrome-extension://ofcjfaafnopakfhchdjcippkjdbcalap/sidepanel/sidepanel.html"'
        ;;
    7)
        echo "Goodbye!"
        exit 0
        ;;
    *)
        echo "Invalid selection. Running Full Batch (Option 1)..."
        python3 "$DIR/automate_flow.py" --interval 5 "$@"
        ;;
esac

EXIT_CODE=$?
echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "========================================================================"
    echo "✅ Successfully completed! Images stored in: ~/Downloads/project 1/"
    echo "========================================================================"
else
    echo "⚠️ Automation finished with status code $EXIT_CODE."
fi

if [ -t 0 ]; then
    echo ""
    read -n 1 -s -r -p "Press any key to exit..."
    echo ""
fi
