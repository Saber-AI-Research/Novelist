#!/usr/bin/env bash
# ── Create a styled DMG with custom background ──────────────────────
# Inspired by Miaoyan's DMG packaging approach.
# Usage: scripts/create-dmg.sh [path/to/Novelist.app] [output.dmg]
#
set -euo pipefail

APP="${1:-src-tauri/target/release/bundle/macos/Novelist.app}"
OUTPUT="${2:-src-tauri/target/release/bundle/dmg/Novelist.dmg}"
BACKGROUND="design/dmg-background.png"
BACKGROUND_RETINA="design/dmg-background@2x.png"

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT")"

# Verify app exists
if [ ! -d "$APP" ]; then
  echo "Error: App bundle not found at $APP" >&2
  exit 1
fi

echo "Creating styled DMG..."
echo "  App: $APP"
echo "  Output: $OUTPUT"

# ── Step 1: Create staging directory ──
STAGING=$(mktemp -d)
cleanup() {
  echo "Cleaning up staging directory..."
  rm -rf "$STAGING"
  # Detach any leftover mounts
  mount | grep "$STAGING" | awk '{print $1}' | while read -r dev; do
    hdiutil detach "$dev" -force 2>/dev/null || true
  done
}
trap cleanup EXIT

# Copy app and create Applications symlink
cp -R "$APP" "$STAGING/Novelist.app"
ln -s /Applications "$STAGING/Applications"

# Copy background images to hidden .background directory
mkdir -p "$STAGING/.background"
if [ -f "$BACKGROUND_RETINA" ]; then
  cp "$BACKGROUND_RETINA" "$STAGING/.background/background@2x.png"
fi
if [ -f "$BACKGROUND" ]; then
  cp "$BACKGROUND" "$STAGING/.background/background.png"
fi

# ── Step 2: Create read-write DMG ──
VOLNAME="Novelist"
RW_DMG="${OUTPUT%.dmg}_rw.dmg"

echo "Creating read-write DMG..."
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGING" \
  -ov -format UDRW "$RW_DMG"

# ── Step 3: Attach and configure Finder layout ──
echo "Configuring DMG layout..."
MOUNT=$(hdiutil attach "$RW_DMG" -readwrite -noverify -noautoopen | \
  grep "/Volumes/$VOLNAME" | awk '{print $1}')
MOUNT_POINT="/Volumes/$VOLNAME"

sleep 2

# Configure Finder window via AppleScript
# Window bounds: {left, top, right, bottom} → 680x420 logical (matches background)
# Icon positions: app on left (~190, 245), Applications on right (~500, 245)
osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOLNAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {100, 100, 780, 520}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 120
    set text size of viewOptions to 14
    set background picture of viewOptions to file ".background:background.png"
    set position of item "Novelist.app" of container window to {190, 245}
    set position of item "Applications" of container window to {500, 245}
    close
    open
    update without registering applications
    delay 2
  end tell
end tell
APPLESCRIPT

# ── Step 4: Detach and compress ──
echo "Detaching..."
hdiutil detach "$MOUNT" -force

sleep 2

echo "Compressing DMG..."
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$OUTPUT"

# Clean up read-write DMG
rm -f "$RW_DMG"

echo "DMG created successfully: $OUTPUT"
ls -lh "$OUTPUT"
