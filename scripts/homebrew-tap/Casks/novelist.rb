cask "novelist" do
  arch arm: "aarch64", intel: "x64"

  version "0.4.1"
  sha256 arm:   "8ef1a4a32b019ebb9fe17c79043ee0ad13ddc0dc8d867e4cd4d2eace46213f13",
         intel: "578ffa03996cb8472f99962f5b889ab372b7801f8e8064b7ac509c0139cff091"

  url "https://github.com/Saber-AI-Research/Novelist/releases/download/v#{version}/Novelist_#{version}_#{arch}.dmg",
      verified: "github.com/Saber-AI-Research/Novelist/"
  name "Novelist"
  desc "Lightweight WYSIWYG Markdown desktop writing app for novelists"
  homepage "https://github.com/Saber-AI-Research/Novelist"

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
  # quarantine flag is what makes `brew install --cask` usable at all here.
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
