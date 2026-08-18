#!/usr/bin/env bash
# Render Casks/novelist.rb for a published Novelist release.
#
# Downloads the Apple Silicon + Intel DMGs from the GitHub release, computes
# their SHA-256 digests, and writes the cask file. This is the single source of
# truth for the cask template: the `bump-homebrew.yml` workflow calls this same
# script, so CI and local runs can never drift apart.
#
# Usage:
#   scripts/bump-homebrew-cask.sh                       # latest published release -> in-repo copy
#   scripts/bump-homebrew-cask.sh 0.4.1                 # explicit version
#   scripts/bump-homebrew-cask.sh 0.4.1 --out ../tap    # write into a tap checkout
#
# The script only renders the file. Committing and pushing to
# Saber-AI-Research/homebrew-novelist is left to the caller (workflow step or
# maintainer), so a bad render never reaches users unreviewed.
set -euo pipefail

REPO="${NOVELIST_REPO:-Saber-AI-Research/Novelist}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT}/scripts/homebrew-tap"
VERSION=""

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --out) OUT_DIR="${2:?--out needs a directory}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs owner/name}"; shift 2 ;;
    -*) echo "Unknown flag: $1" >&2; usage 1 ;;
    *) VERSION="${1#v}"; shift ;;
  esac
done

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }

if [ -z "$VERSION" ]; then
  VERSION="$(gh release view --repo "$REPO" --json tagName -q '.tagName')"
  VERSION="${VERSION#v}"
  echo "Resolved latest published release: v${VERSION}"
fi

# A draft release is not a valid public cask source — its assets 404 for
# anyone without repo access, so brew would break for every user.
DRAFT="$(gh release view "v${VERSION}" --repo "$REPO" --json isDraft -q '.isDraft')"
if [ "$DRAFT" = "true" ]; then
  echo "Release v${VERSION} is still a draft; publish it before bumping the cask." >&2
  exit 1
fi

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ARM_DMG="${WORK}/Novelist_${VERSION}_aarch64.dmg"
INTEL_DMG="${WORK}/Novelist_${VERSION}_x64.dmg"

# Assets can lag a few seconds behind the publish event; retry briefly.
for attempt in 1 2 3 4 5 6; do
  gh release download "v${VERSION}" --repo "$REPO" --dir "$WORK" --clobber \
    --pattern "Novelist_${VERSION}_aarch64.dmg" \
    --pattern "Novelist_${VERSION}_x64.dmg" && break || true
  echo "DMGs not yet available (attempt ${attempt}); retrying in 15s..."
  sleep 15
done

if [ ! -s "$ARM_DMG" ] || [ ! -s "$INTEL_DMG" ]; then
  echo "Missing DMGs for v${VERSION}; cannot render the cask." >&2
  ls -la "$WORK" || true
  exit 1
fi

ARM_SHA="$(sha256_of "$ARM_DMG")"
INTEL_SHA="$(sha256_of "$INTEL_DMG")"

mkdir -p "${OUT_DIR}/Casks"
CASK="${OUT_DIR}/Casks/novelist.rb"

cat > "$CASK" <<EOF
cask "novelist" do
  arch arm: "aarch64", intel: "x64"

  version "${VERSION}"
  sha256 arm:   "${ARM_SHA}",
         intel: "${INTEL_SHA}"

  url "https://github.com/${REPO}/releases/download/v#{version}/Novelist_#{version}_#{arch}.dmg",
      verified: "github.com/${REPO}/"
  name "Novelist"
  desc "Lightweight WYSIWYG Markdown desktop writing app for novelists"
  homepage "https://github.com/${REPO}"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :big_sur

  app "Novelist.app"

  # Novelist ships ad-hoc signed — there is no Apple Developer ID signature or
  # notarization yet, so Gatekeeper refuses to launch the quarantined copy that
  # Homebrew stages ("Novelist is damaged and can't be opened"). Clearing the
  # quarantine flag is what makes \`brew install --cask\` usable at all here.
  # Delete this block once the release pipeline signs and notarizes the app.
  postflight do
    system_command "/usr/bin/xattr",
                   args:         ["-d", "-r", "com.apple.quarantine", "#{appdir}/Novelist.app"],
                   must_succeed: false
  end

  zap trash: [
    "~/.novelist",
    "~/Library/Application Support/com.novelist.desktop",
    "~/Library/Caches/com.novelist.desktop",
    "~/Library/Logs/com.novelist.desktop",
    "~/Library/Preferences/com.novelist.desktop.plist",
    "~/Library/Saved Application State/com.novelist.desktop.savedState",
  ]
end
EOF

echo "Wrote ${CASK}"
echo "  version = ${VERSION}"
echo "  arm     = ${ARM_SHA}"
echo "  intel   = ${INTEL_SHA}"
