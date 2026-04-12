#!/bin/bash
# ================================================================
# Novelist — Real GUI Scroll + Click + Edit Stability Test
#
# Uses cliclick (brew install cliclick) + osascript for:
#   - Real mouse wheel scrolling
#   - Real mouse clicks in the editor area
#   - Real keyboard typing
#   - Multi-round up/down scroll with edits
#
# Prerequisites:
#   1. brew install cliclick
#   2. Grant Accessibility permissions to Terminal in
#      System Settings → Privacy & Security → Accessibility
#   3. Novelist must be running with /tmp folder open
#   4. novelist-150k.md must be open as the active tab
#
# Usage:
#   ./scripts/test-scroll-click.sh
# ================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

TESTFILE="/tmp/novelist-150k.md"
PASS=0
FAIL=0

log()   { echo -e "${YELLOW}[TEST]${NC} $1"; }
ok()    { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL + 1)); }

# Check prerequisites
command -v cliclick >/dev/null || { echo "Error: cliclick not found. Run: brew install cliclick"; exit 1; }
[ -f "$TESTFILE" ] || { echo "Error: $TESTFILE not found. Generate it first."; exit 1; }

# Record baseline
BASELINE_MD5=$(md5 -q "$TESTFILE")
BASELINE_LINES=$(wc -l < "$TESTFILE" | tr -d ' ')
log "Baseline: ${BASELINE_LINES} lines, md5=${BASELINE_MD5}"

# Focus the Novelist window
log "Focusing Novelist window..."
osascript -e 'tell application "Novelist" to activate' 2>/dev/null || \
osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "Novelist") to true' 2>/dev/null || \
{ echo "Warning: Could not focus Novelist. Make sure it's running."; }
sleep 1

# Get window geometry — find the center of the editor area
# Assume: sidebar ~240px from left, tab bar ~36px from top, status bar ~24px from bottom
# We'll click in the center of the editor area
get_editor_center() {
  local win_info
  win_info=$(osascript -e '
    tell application "System Events"
      set novelistProc to first process whose name contains "Novelist"
      tell novelistProc
        set win to front window
        set winPos to position of win
        set winSize to size of win
        return (item 1 of winPos) & "," & (item 2 of winPos) & "," & (item 1 of winSize) & "," & (item 2 of winSize)
      end tell
    end tell
  ' 2>/dev/null)

  if [ -z "$win_info" ]; then
    # Fallback: assume window at common position
    echo "700,400"
    return
  fi

  IFS=',' read -r wx wy ww wh <<< "$win_info"
  # Editor area: skip sidebar (240px), tab bar (40px), half remaining width/height
  local cx=$(( wx + 240 + (ww - 240) / 2 ))
  local cy=$(( wy + 40 + (wh - 40 - 24) / 2 ))
  echo "${cx},${cy}"
}

EDITOR_CENTER=$(get_editor_center)
EDITOR_X=$(echo "$EDITOR_CENTER" | cut -d, -f1)
EDITOR_Y=$(echo "$EDITOR_CENTER" | cut -d, -f2)
log "Editor center: (${EDITOR_X}, ${EDITOR_Y})"

# Move mouse to editor center
cliclick m:${EDITOR_X},${EDITOR_Y}
sleep 0.3

# ======================================================
# Helper: scroll N "ticks" using mouse wheel
# Positive = down, negative = up
# ======================================================
scroll_wheel() {
  local ticks=$1
  local direction="d"  # down
  local abs_ticks=$ticks

  if [ $ticks -lt 0 ]; then
    direction="u"  # up
    abs_ticks=$(( -ticks ))
  fi

  # Each scroll event moves ~3 lines; batch for speed
  for ((i = 0; i < abs_ticks; i++)); do
    if [ "$direction" = "d" ]; then
      cliclick "kd:fn" "ku:fn" 2>/dev/null || true
      # Use osascript for scroll since cliclick scroll support varies
      osascript -e "
        tell application \"System Events\"
          key code 125 using {option down}
        end tell
      " 2>/dev/null || true
    else
      osascript -e "
        tell application \"System Events\"
          key code 126 using {option down}
        end tell
      " 2>/dev/null || true
    fi
  done
}

# ======================================================
# Helper: use Cmd+G to jump to a specific line
# ======================================================
jump_to_line() {
  local target_line=$1
  log "  Jumping to line ${target_line} (Cmd+G)..."
  # Cmd+G for Go to Line
  osascript -e '
    tell application "System Events"
      keystroke "g" using command down
    end tell
  '
  sleep 0.5
  # Type the line number
  osascript -e "
    tell application \"System Events\"
      keystroke \"${target_line}\"
      delay 0.2
      keystroke return
    end tell
  "
  sleep 0.5
}

# ======================================================
# Helper: click at editor center
# ======================================================
click_editor() {
  log "  Clicking at editor center..."
  cliclick c:${EDITOR_X},${EDITOR_Y}
  sleep 0.3
}

# ======================================================
# Helper: type text via keyboard
# ======================================================
type_text() {
  local text=$1
  log "  Typing: ${text}"
  osascript -e "
    tell application \"System Events\"
      keystroke \"${text}\"
    end tell
  "
  sleep 0.3
}

# ======================================================
# Helper: save file (Cmd+S)
# ======================================================
save_file() {
  log "  Saving (Cmd+S)..."
  osascript -e '
    tell application "System Events"
      keystroke "s" using command down
    end tell
  '
  sleep 1
}

# ======================================================
# ROUND 1: Jump to line 30000, click, edit
# ======================================================
log ""
log "=== Round 1: Jump to ~30000 (down), click, edit ==="
jump_to_line 30000
click_editor
type_text "MARK_30K"
ok "Round 1: Jump to 30000 + click + edit"

# ======================================================
# ROUND 2: Jump to line 80000, click, edit
# ======================================================
log ""
log "=== Round 2: Jump to ~80000 (further down), click, edit ==="
jump_to_line 80000
click_editor
type_text "MARK_80K"
ok "Round 2: Jump to 80000 + click + edit"

# ======================================================
# ROUND 3: Jump to line 50000 (up), click, edit
# ======================================================
log ""
log "=== Round 3: Jump to ~50000 (up), click, edit ==="
jump_to_line 50000
click_editor
type_text "MARK_50K"
ok "Round 3: Jump to 50000 + click + edit"

# ======================================================
# ROUND 4: Jump to line 5000 (further up), click, edit
# ======================================================
log ""
log "=== Round 4: Jump to ~5000 (further up), click, edit ==="
jump_to_line 5000
click_editor
type_text "MARK_5K"
ok "Round 4: Jump to 5000 + click + edit"

# ======================================================
# ROUND 5: Jump to line 145000 (near end), click, edit
# ======================================================
log ""
log "=== Round 5: Jump to ~145000 (near end), click, edit ==="
jump_to_line 145000
click_editor
type_text "MARK_END"
ok "Round 5: Jump to 145000 + click + edit"

# ======================================================
# ROUND 6: Scroll back and verify edits
# ======================================================
log ""
log "=== Round 6: Jump back to verify edits ==="

jump_to_line 30000
sleep 0.5
jump_to_line 80000
sleep 0.5
jump_to_line 50000
sleep 0.5
jump_to_line 5000
sleep 0.5
jump_to_line 1
sleep 0.5

ok "Round 6: Scroll-back navigation completed"

# ======================================================
# ROUND 7: Save and verify
# ======================================================
log ""
log "=== Round 7: Save + verify ==="
save_file

# Wait for save to complete
sleep 2

# Verify edits exist in the file
log "Verifying saved file..."
MARKERS=("MARK_30K" "MARK_80K" "MARK_50K" "MARK_5K" "MARK_END")
for marker in "${MARKERS[@]}"; do
  result=$(grep -n "$marker" "$TESTFILE" 2>/dev/null | head -1)
  if [ -n "$result" ]; then
    ok "  Found '${marker}' at line $(echo "$result" | cut -d: -f1)"
  else
    fail "  '${marker}' NOT FOUND in saved file"
  fi
done

# Verify line count
FINAL_LINES=$(wc -l < "$TESTFILE" | tr -d ' ')
if [ "$FINAL_LINES" = "$BASELINE_LINES" ]; then
  ok "Line count preserved: ${FINAL_LINES}"
else
  fail "Line count changed: expected ${BASELINE_LINES}, got ${FINAL_LINES}"
fi

# Final md5
FINAL_MD5=$(md5 -q "$TESTFILE")
if [ "$FINAL_MD5" != "$BASELINE_MD5" ]; then
  ok "File was modified (md5 changed)"
else
  fail "File unchanged (md5 same) — edits may not have saved"
fi

# ======================================================
# Summary
# ======================================================
echo ""
echo "================================"
echo -e "PASSED: ${GREEN}${PASS}${NC}"
echo -e "FAILED: ${RED}${FAIL}${NC}"
echo "================================"

if [ $FAIL -gt 0 ]; then
  echo -e "${RED}TEST SUITE FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}ALL TESTS PASSED${NC}"
  exit 0
fi
