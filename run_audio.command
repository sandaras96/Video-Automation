#!/usr/bin/env bash
# ==============================================================================
#   Double-clickable macOS Launcher for Ultra Audio Generator
#   Gemini TTS Leda + 2-Minute Anti-Degradation Chunking + ffmpeg Stitching
# ==============================================================================
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

clear
echo "========================================================================"
echo "    🎙️ ULTRA AUDIO GENERATOR — GEMINI TTS VOICEOVER AUTOMATION        "
echo "    Voice: Leda | Model: Gemini 2.5 TTS | 1-Minute Anti-Degradation Chunks"
echo "========================================================================"
echo ""
echo "Select execution mode:"
echo "  [1] ⚡ Generate Full Voiceover via Gemini 2.5 TTS (Leda, 1-Minute Chunks)"
echo "  [2] 📄 Export Script into 1-Minute Text Chunks (for AI Studio web tabs)"
echo "  [3] 🎵 Stitch Downloaded Audio Chunks into final_voiceover.mp3 (ffmpeg)"
echo "  [4] ⚡ Generate Full Voiceover via Gemini Flash 3 TTS (Leda, 1-Minute Chunks)"
echo "  [5] 🔑 Set / Update Gemini API Key in config.json"
echo "  [6] 🌐 Open Google AI Studio Speech Generator in Chrome"
echo "  [7] ❌ Exit"
echo ""
read -p "Enter choice [1-7] (default: 1): " choice
choice=${choice:-1}

case $choice in
    1)
        echo ""
        python3 "$DIR/automate_audio.py" --model "gemini-2.5-flash-preview-tts" --words-per-chunk 140 "$@"
        ;;
    2)
        echo ""
        echo "📝 Exporting narration into clean 1-minute chunks..."
        python3 "$DIR/automate_audio.py" --export-only --words-per-chunk 140 "$@"
        open "$DIR/audio_chunks"
        ;;
    3)
        echo ""
        echo "🎵 Stitching audio chunks into final_voiceover.mp3..."
        python3 "$DIR/automate_audio.py" --stitch-only "$@"
        ;;
    4)
        echo ""
        python3 "$DIR/automate_audio.py" --model "gemini-3.1-flash-tts-preview" --words-per-chunk 140 "$@"
        ;;
    5)
        echo ""
        python3 "$DIR/automate_audio.py" --list-keys
        echo "💡 Tip: You can paste 4-5 free API keys separated by commas or spaces!"
        echo "   Get free keys at: https://aistudio.google.com/app/apikey (select 'Create key in new project')"
        echo ""
        echo "Options:"
        echo "  [A] Add new API key(s) to pool"
        echo "  [C] Clear all stored keys"
        echo "  [B] Back to main menu"
        read -p "Select [A/C/B] (default: A): " key_action
        key_action=${key_action:-A}
        case $key_action in
            [Aa]*)
                echo ""
                read -p "Paste your API key(s): " user_keys
                if [ -n "$user_keys" ]; then
                    python3 "$DIR/automate_audio.py" --add-key "$user_keys"
                else
                    echo "No keys entered."
                fi
                ;;
            [Cc]*)
                python3 "$DIR/automate_audio.py" --clear-keys
                ;;
            *)
                echo "Returning to main menu."
                ;;
        esac
        ;;
    6)
        echo ""
        echo "🌐 Opening Google AI Studio Speech Generator..."
        osascript -e 'tell application "Google Chrome" to open location "https://aistudio.google.com/generate-speech?model=gemini-3.1-flash-tts-preview"'
        ;;
    7)
        echo "Goodbye!"
        exit 0
        ;;
    *)
        echo "Invalid selection. Running Option [1]..."
        python3 "$DIR/automate_audio.py" --model "gemini-2.5-flash-preview-tts" --words-per-chunk 140 "$@"
        ;;
esac

EXIT_CODE=$?
echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "========================================================================"
    echo "✅ Completed successfully!"
    echo "========================================================================"
else
    echo "⚠️ Process finished with status code $EXIT_CODE."
fi

if [ -t 0 ]; then
    echo ""
    read -n 1 -s -r -p "Press any key to exit..."
    echo ""
fi
