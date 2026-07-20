#!/usr/bin/env bash
set -euo pipefail

: "${NOVELIST_NATIVE_RUN_ROOT:?missing NOVELIST_NATIVE_RUN_ROOT}"
: "${NOVELIST_NATIVE_BUNDLE:?missing NOVELIST_NATIVE_BUNDLE}"
: "${NOVELIST_NATIVE_IDENTIFIER:?missing NOVELIST_NATIVE_IDENTIFIER}"
: "${NOVELIST_NATIVE_SUPERVISOR:?missing NOVELIST_NATIVE_SUPERVISOR}"

stage() {
  printf 'native_stage=%s state=%s at=%s\n' "$1" "$2" "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
}

if [[ "${1:-}" == "run" ]]; then
  shift
  cargo_args=()
  while (($# > 0)) && [[ "$1" != "--" ]]; do
    cargo_args+=("$1")
    shift
  done
  stage build begin
  if ! cargo build --locked "${cargo_args[@]}"; then
    stage build fail
    exit 65
  fi
  stage build pass
  target_dir="${CARGO_TARGET_DIR:-target}"
  binary="$target_dir/debug/novelist"
else
  binary="${1:?missing Tauri executable path}"
fi
canonical_run_root="$(cd "${NOVELIST_NATIVE_RUN_ROOT}" && pwd -P)"
bundle_parent="$(dirname "$NOVELIST_NATIVE_BUNDLE")"
bundle_name="$(basename "$NOVELIST_NATIVE_BUNDLE")"
if [[ "$bundle_name" == "." || "$bundle_name" == ".." ]]; then
  printf 'refusing invalid bundle basename: %s\n' "$NOVELIST_NATIVE_BUNDLE" >&2
  exit 64
fi
canonical_bundle_parent="$(cd "$bundle_parent" && pwd -P)"
bundle="$canonical_bundle_parent/$bundle_name"
case "$bundle" in
  "$canonical_run_root"/*) ;;
  *) printf 'refusing bundle outside run root: %s\n' "$NOVELIST_NATIVE_BUNDLE" >&2; exit 64 ;;
esac
contents="$bundle/Contents"
executable="$contents/MacOS/NovelistE2E"


stage bundle begin
rm -rf "$bundle"
mkdir -p "$contents/MacOS" "$contents/Resources"
if [[ ! -x "$binary" ]]; then
  printf 'built Tauri executable is missing: %s\n' "$binary" >&2
  exit 66
fi
cp "$binary" "$executable"
chmod 755 "$executable"

cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Novelist E2E</string>
  <key>CFBundleExecutable</key><string>NovelistE2E</string>
  <key>CFBundleIdentifier</key><string>${NOVELIST_NATIVE_IDENTIFIER}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Novelist E2E</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.3.2</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CSResourcesFileMapped</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSRequiresCarbon</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

/usr/bin/plutil -lint "$contents/Info.plist" >/dev/null
/usr/bin/codesign --force --sign - --timestamp=none "$bundle" >/dev/null
stage bundle pass
stage launch_services begin
exec "$NOVELIST_NATIVE_SUPERVISOR" "$bundle"
