#!/bin/bash
# Game HUD status line for Claude Code
# Reads game state from /tmp/agent_mmo_<user>.json (written by bridge after check_self)

input=$(cat)

# Get game user from env or fallback
GAME_USER="${GAME_USER:-unknown}"
STATE_FILE="/tmp/agent_mmo_${GAME_USER}.json"

# ANSI colors
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'
CYAN='\033[36m'
MAGENTA='\033[35m'
WHITE='\033[37m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Default values
NAME="?"
HP=0
MAX_HP=0
GOLD=0
WEAPON="?"
ARMOR="?"
LOCATION="?"
LEVEL=0
XP=0
CONDITIONS=""

# Read state file if it exists
if [ -f "$STATE_FILE" ]; then
  NAME=$(jq -r '.name // "?"' "$STATE_FILE" 2>/dev/null)
  HP=$(jq -r '.hp // 0' "$STATE_FILE" 2>/dev/null)
  MAX_HP=$(jq -r '.maxHp // 0' "$STATE_FILE" 2>/dev/null)
  GOLD=$(jq -r '.gold // 0' "$STATE_FILE" 2>/dev/null)
  WEAPON=$(jq -r '.weapon // "?"' "$STATE_FILE" 2>/dev/null)
  ARMOR=$(jq -r '.armor // "?"' "$STATE_FILE" 2>/dev/null)
  LOCATION=$(jq -r '.location // "?"' "$STATE_FILE" 2>/dev/null)
  LEVEL=$(jq -r '.level // 0' "$STATE_FILE" 2>/dev/null)
  XP=$(jq -r '.xp // 0' "$STATE_FILE" 2>/dev/null)
  CONDITIONS=$(jq -r '.conditions // ""' "$STATE_FILE" 2>/dev/null)
fi

# HP color based on percentage
if [ "$MAX_HP" -gt 0 ]; then
  HP_PCT=$((HP * 100 / MAX_HP))
else
  HP_PCT=0
fi

if [ "$HP_PCT" -le 25 ]; then
  HP_COLOR="$RED"
elif [ "$HP_PCT" -le 50 ]; then
  HP_COLOR="$YELLOW"
else
  HP_COLOR="$GREEN"
fi

# HP bar
if [ "$MAX_HP" -gt 0 ]; then
  HP_FILLED=$((HP_PCT / 10))
  HP_EMPTY=$((10 - HP_FILLED))
  printf -v HP_BAR_FILL "%${HP_FILLED}s" && HP_BAR_FILL="${HP_BAR_FILL// /█}"
  printf -v HP_BAR_EMPTY "%${HP_EMPTY}s" && HP_BAR_EMPTY="${HP_BAR_EMPTY// /░}"
  HP_BAR="${HP_BAR_FILL}${HP_BAR_EMPTY}"
else
  HP_BAR="░░░░░░░░░░"
fi

# Conditions indicator
COND_STR=""
if [ -n "$CONDITIONS" ] && [ "$CONDITIONS" != "" ] && [ "$CONDITIONS" != "none" ]; then
  COND_STR=" ${RED}☠ ${CONDITIONS}${RESET}"
fi

# Context from Claude Code input
CONTEXT_PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' 2>/dev/null | cut -d. -f1)

# Output
printf '%b' "${BOLD}${CYAN}${NAME}${RESET} ${DIM}Lv${LEVEL}${RESET}  ${HP_COLOR}${HP_BAR}${RESET} ${HP_COLOR}❤ ${HP}/${MAX_HP}${RESET}${COND_STR}  ${YELLOW}💰 ${GOLD}g${RESET}  ${WHITE}⚔ ${WEAPON}${RESET}  ${DIM}🛡 ${ARMOR}${RESET}  ${MAGENTA}📍 ${LOCATION}${RESET}"
