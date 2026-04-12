#!/usr/bin/env bash
# Release benchmark: check dist/ and DMG sizes against thresholds.
# Run: pnpm build && bash tests/bench/bundle-size.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

DIST_MAX_KB=5120   # 5 MB
DMG_MAX_KB=15360   # 15 MB

echo "=== Bundle Size Benchmark ==="
echo ""

# Check dist/
if [ ! -d "dist" ]; then
  echo "FAIL: dist/ not found. Run 'pnpm build' first."
  exit 1
fi

DIST_KB=$(du -sk dist | awk '{print $1}')
echo "dist/ size: ${DIST_KB} KB (threshold: ${DIST_MAX_KB} KB)"
if [ "$DIST_KB" -gt "$DIST_MAX_KB" ]; then
  echo "  FAIL: exceeds threshold"
  exit 1
fi
echo "  PASS"

# Check DMG if present
DMG_PATH=$(find src-tauri/target/release/bundle/dmg -name "*.dmg" 2>/dev/null | head -1)
if [ -n "$DMG_PATH" ]; then
  DMG_KB=$(du -sk "$DMG_PATH" | awk '{print $1}')
  echo "DMG size: ${DMG_KB} KB (threshold: ${DMG_MAX_KB} KB)"
  if [ "$DMG_KB" -gt "$DMG_MAX_KB" ]; then
    echo "  FAIL: exceeds threshold"
    exit 1
  fi
  echo "  PASS"
else
  echo "DMG not found (skipping)"
fi

echo ""
echo "--- dist/ breakdown ---"
ls -lhS dist/assets/ 2>/dev/null | head -20
echo ""
echo "All size checks passed."
