#!/bin/bash
# ==============================================================================
# Ultra Video Sync — 1080P Audio-Visual Video Exporter Launcher
# Double-clickable macOS launcher for synchronizing Flow images with audio
# ==============================================================================

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

# Text Styling
BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
MAGENTA='\033[0;35m'
RED='\033[0;31m'
NC='\033[0m' # No Color

clear
echo -e "${CYAN}${BOLD}"
echo "================================================================================"
echo "          🎬 ULTRA VIDEO SYNC — 1080P AUDIO-VISUAL VIDEO EXPORTER               "
echo "================================================================================"
echo -e "${NC}"
echo -e "Directory: ${DIR}\n"

# Verify ffmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
    echo -e "${RED}❌ Error: ffmpeg is not installed or not in PATH.${NC}"
    echo "Please install ffmpeg using: brew install ffmpeg"
    read -p "Press [Enter] to exit..."
    exit 1
fi

# Verify python3 is installed
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Error: python3 is not installed or not in PATH.${NC}"
    read -p "Press [Enter] to exit..."
    exit 1
fi

echo -e "${YELLOW}Please choose an action:${NC}"
echo -e "  ${BOLD}[1]${NC} 🚀 ${GREEN}Full 1080P Render${NC} (All 57 Images + Full 9m 43s Audio)"
echo -e "  ${BOLD}[2]${NC} ⚡ ${CYAN}Quick Test Render${NC} (First 1-Minute Hook / 7 Images)"
echo -e "  ${BOLD}[3]${NC} 📊 ${MAGENTA}Preview Timeline Table${NC} (Check Image Timing & Sentences without rendering)"
echo -e "  ${BOLD}[4]${NC} 🚪 Exit"
echo ""
read -p "Select option [1-4] (default: 1): " choice

choice=${choice:-1}

case "$choice" in
    1)
        echo -e "\n${GREEN}🚀 Starting Full 1080P Render...${NC}\n"
        python3 automate_video_sync.py --output final_video_1080p.mp4
        ;;
    2)
        echo -e "\n${CYAN}⚡ Starting 1-Minute Hook Test Render...${NC}\n"
        python3 automate_video_sync.py --test-hook --output scratch/test_hook_1080p.mp4
        ;;
    3)
        echo -e "\n${MAGENTA}📊 Generating Timeline Preview...${NC}\n"
        python3 automate_video_sync.py --preview-timeline
        ;;
    4)
        echo -e "\nExiting."
        exit 0
        ;;
    *)
        echo -e "\n${RED}Invalid option selected.${NC}"
        ;;
esac

echo ""
echo -e "${GREEN}================================================================================${NC}"
echo -e "${GREEN}Done! You can find the rendered video in this folder or in ~/Downloads/${NC}"
echo -e "${GREEN}================================================================================${NC}"
echo ""
read -p "Press [Enter] to close this window..."
