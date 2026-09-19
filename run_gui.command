#!/usr/bin/env bash
# ==============================================================================
#   🎬 ULTRA STUDIO — Local Web GUI Launcher
#   Double-clickable launcher for Automated YouTube Video Pipeline Studio
# ==============================================================================
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

clear
echo "========================================================================"
echo "    🚀 STARTING ULTRA VIDEO PIPELINE STUDIO WEB GUI                   "
echo "========================================================================"
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: python3 is not installed or not in PATH."
    read -p "Press [Enter] to exit..."
    exit 1
fi

PORT=5050

# Check if server is already running on PORT
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "ℹ️ Studio server is already running on port $PORT."
else
    echo "🌐 Launching Studio Web Server on http://localhost:$PORT..."
    python3 "$DIR/server.py" $PORT &
    SERVER_PID=$!
    sleep 1.2
fi

echo "🚀 Opening Ultra Studio in your browser..."
# Try Google Chrome first, fallback to open default browser
if [ -d "/Applications/Google Chrome.app" ]; then
    open -a "Google Chrome" "http://localhost:$PORT"
else
    open "http://localhost:$PORT"
fi

echo ""
echo "========================================================================"
echo "✅ ULTRA STUDIO IS RUNNING!"
echo "   URL: http://localhost:$PORT"
echo "   Close this terminal window or press Ctrl+C to stop the server."
echo "========================================================================"
echo ""

# Wait for server process if we launched it in background
if [ ! -z "$SERVER_PID" ]; then
    wait $SERVER_PID
else
    # Keep terminal open if already running
    while true; do
        sleep 60
    done
fi
