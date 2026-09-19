#!/usr/bin/env bash
# ==============================================================================
#   🎬 ULTRA AUTO HOOK — 1-Minute Visual Hook Video Automation Launcher
#   Google Flow: Veo 3.1 Lite / Omni 1.1 Flash (3D Animation & 2.5D Infographics)
# ==============================================================================
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

clear
echo "========================================================================"
echo "    🎬 ULTRA AUTO HOOK — 1-MINUTE VISUAL HOOK VIDEO AUTOMATION         "
echo "    3D Medical Animation & 2.5D Infographics Generator for Google Flow  "
echo "========================================================================"
echo ""
echo "Select execution mode:"
echo "  [1] 🌟 Full 1-Minute Hook Generation (All 7 Clips with Veo 3.1 Lite - 5 credits/gen)"
echo "  [2] ⚡ High-Speed Omni Flash Mode (All 7 Clips with Omni 1.1 Flash - 15 credits/gen)"
echo "  [3] 🎯 Custom Batch Run (Choose clip count, model, interval)"
echo "  [4] 🔄 Resume from Clip Number (e.g. continue from clip 3)"
echo "  [5] ⚡ Quick Test Run (1 Hook Video Clip + Download Verification)"
echo "  [6] 🔌 Launch/Restart Chrome with CDP Port 9222 (Enables Direct Mode)"
echo "  [7] 📝 Re-generate / Preview 1-Minute Hook Video Prompts"
echo "  [8] ❌ Exit"
echo ""
read -p "Enter choice [1-8] (default: 1): " choice
choice=${choice:-1}

case $choice in
    1)
        echo ""
        echo "🌟 Starting 1-Minute Hook Generation (Veo 3.1 Lite)..."
        python3 "$DIR/automate_hook_videos.py" --model veo_3_1_lite --interval 5 "$@"
        ;;
    2)
        echo ""
        echo "⚡ Starting 1-Minute Hook Generation (Omni 1.1 Flash)..."
        python3 "$DIR/automate_hook_videos.py" --model omni_flash --interval 5 "$@"
        ;;
    3)
        echo ""
        read -p "Enter number of clips to generate [default: 7]: " clip_count
        clip_count=${clip_count:-7}
        echo "Choose Model:"
        echo "  [1] Veo 3.1 Lite (5 credits/gen - Recommended)"
        echo "  [2] Omni 1.1 Flash (15 credits/gen)"
        echo "  [3] Veo 3.1 Quality (100 credits/gen)"
        read -p "Enter model choice [1-3] (default: 1): " mchoice
        mchoice=${mchoice:-1}
        case $mchoice in
            2) selected_model="omni_flash" ;;
            3) selected_model="veo_3_1_quality" ;;
            *) selected_model="veo_3_1_lite" ;;
        esac
        read -p "Enter interval seconds between generations [default: 5]: " clip_interval
        clip_interval=${clip_interval:-5}
        echo ""
        echo "🚀 Starting Custom Queue (${clip_count} clips, Model: ${selected_model}, ${clip_interval}s interval)..."
        python3 "$DIR/automate_hook_videos.py" --count "$clip_count" --model "$selected_model" --interval "$clip_interval" "$@"
        ;;
    4)
        echo ""
        read -p "Enter starting clip number [e.g. 3]: " start_num
        start_num=${start_num:-1}
        read -p "Enter number of clips to run [press Enter for all remaining]: " clip_count
        read -p "Enter cooldown seconds between generations [default: 5]: " clip_interval
        clip_interval=${clip_interval:-5}
        echo ""
        if [ -z "$clip_count" ]; then
            python3 "$DIR/automate_hook_videos.py" --start-num "$start_num" --interval "$clip_interval" "$@"
        else
            python3 "$DIR/automate_hook_videos.py" --start-num "$start_num" --count "$clip_count" --interval "$clip_interval" "$@"
        fi
        ;;
    5)
        echo ""
        echo "⚡ Running Quick Test (1 Video Clip + Download Verification)..."
        python3 "$DIR/automate_hook_videos.py" --count 1 --model veo_3_1_lite --interval 5 "$@"
        ;;
    6)
        echo ""
        echo "🔌 Launching Chrome with Remote Debugging Port 9222..."
        /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 &
        sleep 2
        echo "✅ Chrome launched with CDP support! You can now run Option [1], [2], [3], or [5]."
        ;;
    7)
        echo ""
        echo "📝 Re-generating 1-Minute Hook Video Prompts from script..."
        python3 "$DIR/generate_hook_prompts.py"
        echo ""
        echo "📄 Prompts updated in hook_video_prompts.txt!"
        ;;
    8)
        echo "Goodbye!"
        exit 0
        ;;
    *)
        echo "Invalid selection. Running Default (Option 1)..."
        python3 "$DIR/automate_hook_videos.py" --model veo_3_1_lite --interval 5 "$@"
        ;;
esac

EXIT_CODE=$?
echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "========================================================================"
    echo "✅ Successfully completed! Videos stored in: ~/Downloads/visual_hooks/"
    echo "========================================================================"
else
    echo "⚠️ Automation finished with status code $EXIT_CODE."
fi

if [ -t 0 ]; then
    echo ""
    read -n 1 -s -r -p "Press any key to exit..."
    echo ""
fi
