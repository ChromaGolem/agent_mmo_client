#!/bin/bash
cd "$(dirname "$0")"

# --- Load .env defaults if it exists ---
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

# --- Command-line args override .env ---
[ -n "$1" ] && export GAME_USER="$1"
[ -n "$2" ] && export GAME_PASS="$2"
[ -n "$3" ] && export GAME_SERVER="$3"

# --- If still missing credentials, prompt and save ---
if [ -z "$GAME_USER" ] || [ -z "$GAME_PASS" ]; then
    echo "=== Agent MMO — New Hero ==="
    echo ""
    [ -z "$GAME_USER" ] && read -p "Choose a username: " GAME_USER
    [ -z "$GAME_PASS" ] && read -s -p "Choose a password: " GAME_PASS
    echo ""

    export GAME_USER GAME_PASS
fi

# --- Server URL from config (checked into repo) ---
export GAME_SERVER="${GAME_SERVER:-$(python3 -c "import json; print(json.load(open('server_config.json'))['server'])")}"

# --- Save credentials only (not server URL) ---
cat > .env << EOF
GAME_USER=$GAME_USER
GAME_PASS=$GAME_PASS
EOF

# --- Check if server is reachable ---
# Extract host from WebSocket URL for health check
HEALTH_URL=$(echo "$GAME_SERVER" | sed 's|^ws://|http://|;s|^wss://|https://|')
if ! curl -s "${HEALTH_URL}/health" > /dev/null 2>&1; then
    echo "Game server not reachable at $GAME_SERVER"
    echo "For local dev: GAME_SERVER=ws://localhost:2567 ./play.sh"
    exit 1
fi

# --- Install bridge dependencies if needed ---
if [ ! -d "bridge/node_modules" ]; then
    echo "Installing bridge dependencies..."
    (cd bridge && npm install)
fi

# --- Launch Claude Code with hero prompt, channels, and HUD ---
STATUSLINE_PATH="$(pwd)/statusline.sh"

claude "Call check_self to see your current state, then greet me." \
    --append-system-prompt-file prompts/hero_system.md \
    --dangerously-load-development-channels server:agent_mmo \
    --settings "{\"statusLine\":{\"type\":\"command\",\"command\":\"$STATUSLINE_PATH\"}}"
