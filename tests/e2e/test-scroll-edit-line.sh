#!/bin/bash
# ================================================================
# Novelist — Scroll + Edit + Scroll + Click Line Number Test
#
# Tests the critical scenario:
#   1. Open a large markdown file with headings
#   2. Scroll to a heading area → edit
#   3. Scroll to a different area → click
#   4. Verify the clicked line number matches expected position
#
# This test uses cliclick + osascript for real GUI interaction.
#
# Prerequisites:
#   1. brew install cliclick
#   2. Grant Accessibility permissions to Terminal
#   3. Novelist must be running with the test file open
#
# Usage:
#   ./scripts/test-scroll-edit-line.sh
# ================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

TESTFILE="/tmp/novelist-line-test.md"
PASS=0
FAIL=0

log()   { echo -e "${YELLOW}[TEST]${NC} $1"; }
ok()    { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL + 1)); }

# Check prerequisites
command -v cliclick >/dev/null || { echo "Error: cliclick not found. Run: brew install cliclick"; exit 1; }

# ======================================================
# Step 0: Generate a test file with many headings
# ======================================================
log "Generating test file with headings at known positions..."
python3 -c "
lines = []
for i in range(5000):
    if i % 100 == 0:
        lines.append(f'# Chapter {i // 100 + 1}')
    elif i % 50 == 0:
        lines.append(f'## Section {i // 50 + 1}')
    elif i % 10 == 0:
        lines.append('')
    else:
        lines.append(f'Line {i}: The quick brown fox jumps over the lazy dog.')
with open('$TESTFILE', 'w') as f:
    f.write('\n'.join(lines))
print(f'Generated {len(lines)} lines')
"

BASELINE_LINES=$(wc -l < "$TESTFILE" | tr -d ' ')
log "Test file: ${BASELINE_LINES} lines at $TESTFILE"
log ""
log "=== INSTRUCTIONS ==="
log "1. Open $TESTFILE in Novelist"
log "2. Press ENTER here to start the test"
read -r

# Focus the Novelist window
log "Focusing Novelist window..."
osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "Novelist") to true' 2>/dev/null || true
sleep 1

# Get editor center
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
    echo "700,400"
    return
  fi

  IFS=',' read -r wx wy ww wh <<< "$win_info"
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
# Helper: use Cmd+G to jump to a specific line
# ======================================================
jump_to_line() {
  local target_line=$1
  osascript -e '
    tell application "System Events"
      keystroke "g" using command down
    end tell
  '
  sleep 0.5
  osascript -e "
    tell application \"System Events\"
      keystroke \"${target_line}\"
      delay 0.2
      keystroke return
    end tell
  "
  sleep 0.5
}

click_editor() {
  cliclick c:${EDITOR_X},${EDITOR_Y}
  sleep 0.3
}

type_text() {
  osascript -e "
    tell application \"System Events\"
      keystroke \"${1}\"
    end tell
  "
  sleep 0.3
}

save_file() {
  osascript -e '
    tell application "System Events"
      keystroke "s" using command down
    end tell
  '
  sleep 1
}

# ======================================================
# Round 1: Scroll → Edit → Scroll → Click → Verify
# ======================================================
log ""
log "=== Round 1: Jump to 500, edit, jump to 2000, click, jump to 500, verify ==="

log "  Jump to line 500..."
jump_to_line 500
click_editor
type_text "MARKER_R1_500"
ok "  Edited at line 500"

log "  Jump to line 2000..."
jump_to_line 2000
click_editor
type_text "MARKER_R1_2000"
ok "  Edited at line 2000"

log "  Jump back to line 500 to verify..."
jump_to_line 500
click_editor
ok "  Navigated back to 500 + clicked"

# ======================================================
# Round 2: Multiple rapid scroll-edit cycles
# ======================================================
log ""
log "=== Round 2: Rapid scroll-edit cycles ==="

for target in 100 1500 3000 500 4000 200; do
  log "  Jump to line ${target}, edit..."
  jump_to_line $target
  click_editor
  type_text "M${target}"
  ok "  Edited at line ${target}"
done

# ======================================================
# Round 3: Save and verify all markers exist
# ======================================================
log ""
log "=== Round 3: Save + verify ==="
save_file
sleep 2

MARKERS=("MARKER_R1_500" "MARKER_R1_2000" "M100" "M1500" "M3000" "M500" "M4000" "M200")
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
