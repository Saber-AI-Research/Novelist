# Mobile Deployment, Accounts and Support

Last updated: 2026-10-28

How Novelist's iOS and Android builds are produced, signed, distributed and
supported. Product scope and architecture live in
[../exec-plans/active/2026-10-28-mobile-platform.md](../exec-plans/active/2026-10-28-mobile-platform.md);
the self-hosted sync server runbook lives in
[../selfhost/nextcloud/README.md](../selfhost/nextcloud/README.md).

**Status.** The scripts and workflows below exist and their local checks were
exercised (argument/environment validation, `actionlint`, `docker compose
config`). No signed iOS build, TestFlight upload, Beta App Review result or
signed release APK has been produced yet: each needs the external credentials
listed in [Pending external prerequisites](#pending-external-prerequisites).
Nothing in this document claims that Apple has approved, or will approve, a
build.

## Distribution model

| | iOS / iPadOS | Android |
|---|---|---|
| Channel | TestFlight only (no App Store release), for stable and beta tags | Signed APK on the GitHub release: the stable release of a `vX.Y.Z` tag, or a mobile-only prerelease for a `vX.Y.Z-beta.N` tag (no Google Play, no other store) |
| Identifier | `com.novelist.app` | `com.novelist.app` |
| Minimum OS | iOS / iPadOS 16.0 | Android 8.0 (API 26); target API 36 |
| Devices | iPhone and iPad (`TARGETED_DEVICE_FAMILY = 1,2`), arm64 + Metal | Phones and tablets with `arm64-v8a` or `x86_64`; 32-bit-only (`armeabi-v7a`) devices cannot install |
| Orientation | iPhone: portrait + both landscapes; iPad: all four | Follows the device; the activity is resizable (split screen, freeform windows) |
| Editing | Full editor on phone and tablet | Full editor on phone and tablet |
| Plugins | Bundled plugins only | Bundled plugins + marketplace |
| Updates | TestFlight app; each build expires after 90 days | Install the newer APK over the old one |

The desktop app keeps `com.novelist.desktop`, its updater and `latest.json`.
Mobile builds never write `latest.json`.

## Two separate kinds of accounts

| | Deployment accounts | Writer (user) accounts |
|---|---|---|
| Who | Novelist maintainers | Each person who syncs their manuscripts |
| What | Apple Developer Program team, App Store Connect, GitHub repository environment secrets, the Android release keystore | A WebDAV login on a server the writer (or their admin) runs, for example a Nextcloud user with one app password per device |
| Where stored | GitHub environment `mobile-release`, the maintainers' password manager, offline backups | On the device only: iOS Keychain (`ThisDeviceOnly`, never synced), Android Keystore-encrypted app-private storage (`allowBackup=false`) |
| Never | in the repo, in app builds, in logs | in the repo, in CI, in project files, in sync data |

There is no Novelist account service: Novelist does not run a login server and
never sees writers' credentials. A writer's sync access is revoked on their
WebDAV server (see the Nextcloud runbook), not by Novelist.

## Toolchain and commands

All entry points are `scripts/mobile.mjs` (run `node scripts/mobile.mjs --help`).

| Command | Purpose | Secrets |
|---|---|---|
| `pnpm mobile:<android\|ios>:doctor` | Validate SDK/NDK/JDK/libclang or Xcode/SDKs/simulator runtime and Rust targets; list which release inputs are set (names only) | none |
| `pnpm mobile:<android\|ios>:init` | `rustup target add` for the platform, verify the committed native project (`ios init --regenerate-xcodeproj` reruns xcodegen on `core/gen/apple/project.yml`) | none |
| `pnpm mobile:<android\|ios>:dev [-- <device/flags>]` | `tauri <platform> dev` with the validated environment | none |
| `pnpm mobile:<android\|ios>:check` | `cargo clippy --locked --lib -D warnings`, one cargo run per target (Tauri plugin build scripts share an output directory, so concurrent targets collide): `aarch64-linux-android` then `x86_64-linux-android`, or `aarch64-apple-ios` then `aarch64-apple-ios-sim`; default features only, never `--all-features` (that pulls the macOS-only `e2e-testing` stack) | none |
| `pnpm mobile:android:build` | Universal debug APK, debug-signed, both ABIs by default (`-- --target aarch64` for one ABI; the ABI check follows the selection); `--release` gives an unsigned release APK; `--skip-frontend` reuses a current `dist/` | removed from the child environment |
| `pnpm mobile:ios:build` | Simulator `.app` (`aarch64-sim`), not code signed; `--release` for the release profile; `--skip-frontend` reuses a current `dist/` | removed from the child environment |
| `pnpm mobile:android:publish` | Signed universal release APK, verified with `apksigner`, `aapt2`, `zipalign` and `llvm-readelf` | Android signing |
| `pnpm mobile:android:verify -- --apk <path>` | Check an existing APK: package, `minSdkVersion`, ABIs (`--target` narrows), 16 KiB page alignment, signer (must be `ANDROID_SIGNING_CERT_SHA256` when set) | none |
| `pnpm mobile:ios:publish` | App Store Connect export (IPA), manual signing, verified with `codesign` | iOS signing |
| `pnpm mobile:ios:upload` | Upload the published IPA with `xcrun altool --upload-package` | App Store Connect API key |
| `pnpm mobile:webdav:conformance -- --url <URL>` | Check a sync server against what Novelist needs | the writer's own login, from env or a hidden prompt |

Requirements:

- **Android:** `ANDROID_HOME` (SDK with `platforms;android-36`, build-tools
  35.0.0/36.0.0, NDK), `JAVA_HOME` with JDK 17+, libclang for rquickjs's
  bindgen (Xcode Command Line Tools on macOS, `libclang-dev` on Linux, or
  `LIBCLANG_PATH`). The script derives the NDK compiler and
  `BINDGEN_EXTRA_CLANG_ARGS_<target>=--sysroot=<ndk sysroot>` variables.
- **NDK pin:** tauri-cli 2.10.1 ignores `NDK_HOME` and builds with the
  lexicographically newest directory in `$ANDROID_HOME/ndk`. The scripts fail
  when `NDK_HOME` disagrees with that choice. CI installs NDK
  `27.2.12479018` and deletes the runner's other NDKs (`android ci-sdk`).
- **16 KiB pages:** Android 15+ devices may run with 16 KiB memory pages and
  refuse native libraries aligned for 4 KiB. `.cargo/config.toml` links both
  Android targets with `-Wl,-z,max-page-size=16384` (still loadable on 4 KiB
  devices back to API 26). tauri-cli adds its own Android link flags through
  `CARGO_TARGET_<TRIPLE>_RUSTFLAGS`, which Cargo merges with the config file;
  `RUSTFLAGS` or `CARGO_ENCODED_RUSTFLAGS` would replace both, so the scripts
  refuse to run when either is set. Every `build`, `publish` and `verify`
  checks the APK with `zipalign -c -P 16 4` and requires every `PT_LOAD`
  segment of every bundled `.so` to be aligned to at least 0x4000
  (`llvm-readelf -lW`), for debug, unsigned and signed APKs alike.
- **iOS:** macOS with full Xcode (Command Line Tools are not enough), the iOS
  platform and a simulator runtime (`xcodebuild -downloadPlatform iOS`).
  App Store Connect only accepts uploads built with Xcode 26 or later
  (since 2026-04-28), so `publish` and `upload` refuse older Xcode.
- `tauri ios build` rewrites tracked files under `core/gen/apple` (bundle id,
  team, signing style, merged `Info.plist`). The scripts warn when that
  happens; never commit a team ID or signing identity from a local publish.

Outputs: release artifacts go to `core/target/mobile-release/`
(`Novelist_<version>_<build>_android-universal.apk`,
`Novelist_<version>_<build>_ios.ipa`, each with a `.sha256`). Debug and
simulator builds stay in `core/gen/android/app/build/outputs/apk/universal/`
and `core/gen/apple/build/arm64-sim/`.

## Build number policy

- One counter, `MOBILE_BUILD_NUMBER`, numbers every mobile build: it becomes
  the Android `versionCode` (Gradle reads the environment variable) and the
  iOS `CFBundleVersion` (passed as `bundle.iOS.bundleVersion`).
- Valid values are integers 1..2147483647 (Android `versionCode` is a signed
  32-bit integer); the scripts reject anything else.
- It must only grow. Android refuses to install a lower `versionCode` over a
  higher one; App Store Connect refuses a `CFBundleVersion` it has already seen
  for the version.
- CI uses the workflow input `build_number` when given, otherwise
  `MOBILE_BUILD_NUMBER_BASE + github.run_number` (repository variable, default
  0). Re-running a run reuses its number, so a re-run after a successful
  upload is rejected by App Store Connect instead of shipping a duplicate.
  If the workflow is ever recreated or renamed (its run number restarts at 1),
  raise `MOBILE_BUILD_NUMBER_BASE` above the highest number already shipped.
  Never lower it.
- The marketing version stays the app version (`0.6.1` today:
  `CFBundleShortVersionString`, Android `versionName`); it is not bumped by
  mobile builds.
- The app version has one source, `[package].version` in `core/Cargo.toml`
  (`core/Cargo.lock` mirrors it). `node scripts/app-version.mjs` prints it and
  fails when `package.json` or a `core/tauri*.conf.json` declares a
  `version`. Tauri's runtime and desktop bundler fall back to Cargo.toml, but
  tauri-cli's mobile commands do not, so `scripts/mobile.mjs` passes it to
  every `tauri android|ios` build and dev run as `--config {"version": …}`.
- `--build-number` on `tauri ios build` is deliberately not used: it appends
  the number to the app version (`0.6.1.N`), and App Store Connect rejects a
  four-component `CFBundleVersion`.

## CI

### Mobile CI (`.github/workflows/mobile-ci.yml`)

Runs on pull requests that touch app, core, plugin, build or mobile-script
files, and manually. No secrets.

- **Android** (`ubuntu-24.04`): pin SDK/NDK, `android doctor`, clippy for both
  ABIs, universal debug APK, then `aapt2`/`apksigner`/`zipalign`/`llvm-readelf`
  checks (package, `minSdkVersion` 26, both ABIs present, valid signature,
  16 KiB page alignment). Manual runs upload the debug APK as a 7-day artifact.
- **iOS** (`macos-26`, Xcode 26.6 selected explicitly): `ios doctor`, clippy
  for device and simulator targets, unsigned simulator app, then `Info.plist`
  checks (bundle id, iOS 16.0 minimum, iPhone + iPad family).

### Mobile Release (`.github/workflows/mobile-release.yml`)

Two channels, each with exactly one publisher of its GitHub release:

```
stable  tag vX.Y.Z ──▶ Release (desktop) ──success──▶ Mobile Release
                       creates the draft release       ├─ resolve: tag ⇄ commit ⇄ version, build number
                       and latest.json                 ├─ android: sign → apksigner verify → artifact
                                                       │     └─ attach-apk: upload to the existing release
                                                       └─ ios: sign → verify → TestFlight upload

beta    tag vX.Y.Z-beta.N ──▶ Mobile Release (Release ignores prerelease tags)
                              ├─ resolve, android, ios: as above
                              └─ attach-apk: create or reuse the draft prerelease, upload the APK
```

- **Triggers:** completion of the `Release` workflow for a pushed stable tag
  (`workflow_run`, only when it succeeded); a pushed `v*-beta.*` tag; or
  manual dispatch with an existing tag of either kind, an optional build
  number, a platform choice, and switches for attaching the APK and uploading
  to TestFlight.
- **Stable (`vX.Y.Z`):** `release.yml` runs only for tags without a `-`
  suffix and stays the only creator of stable releases and the only writer of
  `latest.json`. `attach-apk` requires that release to exist (fails otherwise)
  and requires it not to be a prerelease. The commit's app version must be
  `X.Y.Z`.
- **Beta (`vX.Y.Z-beta.N`, N ≥ 1, no leading zeros):** no desktop build, no
  `latest.json`. `attach-apk` creates the release itself when missing
  (`gh release create --verify-tag --draft --prerelease --latest=false`: it
  never creates a tag) or reuses an existing one, which must be a prerelease.
  A maintainer publishes the draft. GitHub never marks a prerelease as the
  latest release, so the desktop updater URL
  (`releases/latest/download/latest.json`) keeps pointing at the newest stable
  release, and the Homebrew bump workflow skips prereleases.
- **Versions for a beta tag:** the commit's app version (`core/Cargo.toml`,
  read with `node scripts/app-version.mjs`) must be either the tag's full version
  (`X.Y.Z-beta.N`) or its numeric core (`X.Y.Z`); anything else fails. The
  iOS marketing version (`CFBundleShortVersionString`) is always the numeric
  core `X.Y.Z`, because App Store Connect accepts only three integers there
  (tauri-cli strips the suffix); the Android `versionName` is the app version.
  Testers tell beta builds apart by the build number.
- **Immutable tags:** the tag must point at the checked-out commit, at the
  commit of the triggering event, and still at the built commit when the APK
  is attached. Moving a tag fails the run.
- `attach-apk` never replaces an asset with the same name: a re-run after a
  successful attach fails instead of overwriting.
- The signing jobs use the GitHub environment `mobile-release`. Add required
  reviewers to it to gate every signed build behind an approval.
- Secrets reach only the steps that use them. The keystore is written to
  `$RUNNER_TEMP` with mode 0600 and deleted in an `always()` step. On macOS,
  tauri-cli imports the certificate into a temporary keychain; the script
  removes new keychains, new provisioning profiles and the API key directory
  on every exit path, and an `always()` step repeats that cleanup after a
  killed or cancelled job.

### Cutting a mobile beta

1. Pick the commit and the tag. With the app version unchanged (`0.6.1`),
   the only valid beta tags are `v0.6.1-beta.N`; to label the beta as the
   next version, first commit the version bump:
   `node scripts/app-version.mjs bump X.Y.Z` (or `X.Y.Z-beta.N`). It changes
   only `core/Cargo.toml` and the workspace entry of `core/Cargo.lock`
   (`cargo update --workspace --offline`, no dependency upgrades) and restores
   both files if anything else would change.
2. `git tag -a v0.6.1-beta.1 -m "Mobile beta 1" <commit> && git push origin v0.6.1-beta.1`.
   Never move or reuse a pushed tag; use the next `-beta.N` instead.
3. Approve the `mobile-release` environment if it has reviewers. The run
   uploads the IPA to TestFlight and creates the draft prerelease with the
   signed APK and its `.sha256`.
4. Check the draft's assets and notes, then publish it. In App Store Connect,
   add the processed build to the internal group, and to the external group
   (with the public link) once it passes TestFlight App Review.

A failed run can be retried with manual dispatch on the same tag; the build
number then comes from the new run (or the `build_number` input), so it stays
unique.

### Secrets and variables

Create the environment in GitHub → Settings → Environments → `mobile-release`.
Pipe values into `gh` so they never appear on a command line, for example
`base64 -i novelist-release.p12 | gh secret set ANDROID_KEYSTORE_BASE64 --env mobile-release`.

| Name | Kind | Value |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | env secret | Base64 of the release keystore (PKCS#12) |
| `ANDROID_KEYSTORE_PASSWORD` | env secret | Keystore password |
| `ANDROID_KEY_ALIAS` | env secret | Key alias |
| `ANDROID_KEY_PASSWORD` | env secret | Key password (same as the store password for PKCS#12) |
| `ANDROID_SIGNING_CERT_SHA256` | env variable | Public SHA-256 fingerprint of the release certificate; publishing refuses any other key |
| `IOS_CERTIFICATE` | env secret | Base64 of the Apple Distribution `.p12` (certificate + private key) |
| `IOS_CERTIFICATE_PASSWORD` | env secret | `.p12` export password |
| `IOS_MOBILE_PROVISION` | env secret | Base64 of the App Store Connect provisioning profile for `com.novelist.app` |
| `APPLE_DEVELOPMENT_TEAM` | env variable | 10-character Team ID |
| `ASC_API_KEY_ID` | env secret | App Store Connect team API key ID |
| `ASC_API_ISSUER_ID` | env secret | Issuer ID shown above the team keys table |
| `ASC_API_PRIVATE_KEY` | env secret | Full contents of `AuthKey_<KEY_ID>.p8` |
| `ASC_APP_APPLE_ID` | env variable | Numeric Apple ID of the app record (App Information page) |
| `MOBILE_BUILD_NUMBER_BASE` | repository variable | Optional offset for the build number (default 0) |

Do not define `APPLE_API_KEY`, `APPLE_API_ISSUER` or `APPLE_API_KEY_PATH`:
they switch tauri-cli to API-key automatic signing, which `ios publish`
refuses. Before signing, `ios publish` checks that the certificate opens with
its password, is an Apple Distribution certificate of `APPLE_DEVELOPMENT_TEAM`
and is not expired, and that the profile is an unexpired App Store profile for
`<team>.com.novelist.app` that lists that certificate.

## Apple Developer Program and TestFlight

### Enrollment and team

1. Enroll in the Apple Developer Program (annual fee). An organization needs a
   D-U-N-S number and the legal authority to bind it; an individual
   enrollment publishes under the person's legal name. The enrolling person
   becomes the **Account Holder** (signs agreements, transfers ownership).
2. Accept the current agreements in App Store Connect → Business. Free
   TestFlight distribution does not need the Paid Apps agreement.
3. Invite maintainers in App Store Connect → Users and Access with the least
   role that works: **Admin** for whoever manages certificates, profiles and
   API keys; **App Manager** for whoever manages TestFlight groups, test
   information and Beta App Review submissions (App Store Connect help lists
   Account Holder, Admin and App Manager for these); **Developer** is enough
   to upload builds. Check Apple's role permission table before granting.
4. Record the Team ID (Membership details) as `APPLE_DEVELOPMENT_TEAM`.

### Identifier, app record, certificate, profile

1. Certificates, Identifiers & Profiles → Identifiers → **+** → App IDs → App:
   explicit Bundle ID `com.novelist.app`. No extra capabilities are needed
   (no push, iCloud or associated domains).
2. App Store Connect → Apps → **+** → New App: platform iOS, a name that is
   unique on the App Store (it only labels the TestFlight listing), primary
   language, bundle ID `com.novelist.app`, a SKU. Copy its **Apple ID** from
   App Information as `ASC_APP_APPLE_ID`.
3. Create a certificate signing request (Keychain Access → Certificate
   Assistant → Request a Certificate From a Certificate Authority, saved to
   disk), then Certificates → **+** → **Apple Distribution**, upload the CSR
   and download the certificate. Open it so Keychain Access pairs it with the
   private key, then export both as a `.p12` with a strong password
   (`IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD`). If you assemble the `.p12`
   with OpenSSL 3, pass `-legacy` so macOS `security` can import it.
4. Profiles → **+** → Distribution → **App Store Connect** → App ID
   `com.novelist.app` → the distribution certificate → download the
   `.mobileprovision` (`IOS_MOBILE_PROVISION`).
5. Users and Access → Integrations → App Store Connect API → **Team Keys** →
   generate a key (Developer access suffices for uploads; App Manager if the
   key should also manage testers). Download `AuthKey_<KEY_ID>.p8` once; it
   cannot be downloaded again. Store key ID, issuer ID and file contents as the
   `ASC_*` secrets.

### Renewal and revocation

- Apple Distribution certificates last one year and the profile expires with
  its certificate. Before expiry (the publish preflight warns 30 days ahead):
  create a new certificate, regenerate the App Store profile with it, update
  `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD` and `IOS_MOBILE_PROVISION`.
- Revoke a certificate only when its private key may be compromised, then
  replace it as above. Revoking blocks new signing with it; check Apple's
  certificate documentation for the effect on builds already in TestFlight
  before revoking.
- Rotate or revoke the API key in Users and Access → Integrations when a
  maintainer leaves or the key may have leaked, then update the `ASC_*`
  secrets.
- The team can hold only a limited number of distribution certificates; delete
  ones nobody uses.

### Per-device testing

- **Simulator:** `pnpm mobile:ios:build` or `pnpm mobile:ios:dev` needs no
  Apple account.
- **Own devices via Xcode:** `pnpm mobile:ios:dev -- <device name>` needs a
  development certificate, the device registered under Devices, and a
  development profile (Xcode can manage these with the team's Apple ID).
  Registered devices count against Apple's yearly per-team limit.
- **Everyone else:** TestFlight. No device registration is needed.

### TestFlight

- **Internal testing:** up to 100 team members with an App Store Connect role;
  builds are available after processing, without review.
- **External testing:** up to 10,000 testers per app, by email or a **public
  link** on an external group. A build must pass **TestFlight App Review**
  before external testers get it; the first build of a version gets a full
  review and later builds of the same version may not. Only one build per
  version can be in review at a time, and at most six builds can be submitted
  per 24 hours.
- **Test Information** (TestFlight → Test Information): beta app description,
  feedback email (the support address testers reply to), contact information,
  a **privacy policy URL**, and review notes. Tell reviewers that no sign-in is
  needed: projects are local, and sync is optional and uses a server the
  writer configures.
- **Builds expire 90 days** after upload. Upload a new build before testers'
  builds expire; the public link keeps working for new builds added to the
  group.
- **Export compliance:** `Info.plist` sets `ITSAppUsesNonExemptEncryption =
  false` (the app only uses HTTPS and OS-provided storage encryption). This is
  the publisher's declaration; revisit it before adding other cryptography.
- **Privacy manifest:** `PrivacyInfo.xcprivacy` declares the required-reason
  APIs (file timestamps `C617.1`, system boot time `35F9.1`, the app's own
  UserDefaults `CA92.1`), no tracking and no data collected by the
  developer. `ios publish` refuses an IPA without it.
- **Privacy policy content:** Novelist has no analytics and no developer
  backend. Text leaves the device only to services the writer configures:
  their WebDAV server (sync), AI Talk endpoints, image hosts and translation
  services. The policy must say so.
- After `ios upload` succeeds, App Store Connect still processes the build;
  processing errors arrive by email to the team. The script reports only that
  `altool` accepted the upload.

## Android release signing

No Google Play Console account is needed; the APK is signed with a
self-managed key and attached to the GitHub release.

### Create the release key (once)

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore novelist-release.p12 \
  -alias novelist -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Novelist"
keytool -list -v -keystore novelist-release.p12 -alias novelist | grep 'SHA256:'
```

`keytool` prompts for the passwords. The `SHA256:` line is
`ANDROID_SIGNING_CERT_SHA256`; publish it in the release notes so users can
check a download with `apksigner verify --print-certs`.

### Backup and rotation

- Every future update must be signed with this key. If it is lost, no
  installed copy can be upgraded: users would have to export their projects,
  uninstall and install again.
- Keep at least two offline, encrypted copies in separate places (for example
  the maintainers' password manager and an encrypted drive in a safe), along
  with the alias, both passwords and the fingerprint. The GitHub secret is not
  a backup: secrets cannot be read back.
- If the key leaks, attackers can sign APKs that install over Novelist.
  Remove the GitHub secrets, tell users, and plan a rotation: APK Signature
  Scheme v3 key rotation (`apksigner rotate` + `--lineage`) is honoured only
  on Android 9+; Android 8.x devices keep checking the original key. The
  release pipeline signs with a single key today, so a rotation needs a
  pipeline change and its own review.

### Install and upgrade (users)

1. Download `Novelist_<version>_<build>_android-universal.apk` and its
   `.sha256` from the GitHub release; check `shasum -a 256 -c` or compare the
   hash.
2. Allow the browser or file manager to install it: Settings → Apps → Special
   app access → **Install unknown apps** → allow for that app (Android 8+ asks
   per source; the prompt appears on first install).
3. To update, install the newer APK over the installed one. Android keeps the
   app's data when the package name and signing certificate match and the
   `versionCode` is not lower.
4. Debug APKs (local or CI artifacts) are signed with per-machine debug keys.
   Android cannot replace them with a release APK, or vice versa, without an
   uninstall, which deletes all local data. Testers should export or sync
   first.

## Data safety and recovery (users)

- **Where data lives:** projects are stored in the app's project library. On
  iOS that is `Documents/Projects`, visible in the Files app (On My
  iPhone/iPad → Novelist → Projects); settings, credentials and sync state stay
  in private app data. On Android everything is app-private.
- **Uninstalling deletes local projects.** iOS deletes the app container;
  Android deletes app data and, with `allowBackup=false`, keeps no cloud
  backup. Before uninstalling, switching between debug and release builds, or
  resetting a device: export each project (Export Project as .zip → share
  sheet) or confirm the last sync finished without errors.
- **Offline:** writing never needs the network. Changes stay on the device and
  sync on the next successful sync.
- **Conflicts:** when a file changed on both sides since the last common
  version, sync leaves both copies untouched and reports a conflict. The
  writer chooses keep this device's copy, keep the server's copy, or keep both;
  the replaced side is first copied to a private `conflicts/` folder in the
  app's data. Nextcloud also keeps older versions and deleted files
  server-side (Files → Versions, Deleted files).
- **Moving to a new device:** install Novelist, connect the cloud account, then
  Library → Download from Cloud; or import a `.zip` export.
- **Credentials:** the app password is stored only on the device. Disconnecting
  the cloud account deletes it there and turns sync off; it deletes no local or
  remote files. A lost device is cut off by revoking its app password on the
  server.

### Security of synced data

Sync uses HTTPS (cleartext `http://` is refused except for loopback
development hosts, and redirects are never followed). HTTPS protects data in
transit only. The WebDAV server stores manuscripts as plain files: its
operators, anyone with access to its disks or backups, and a compromised server
can read them. Nextcloud server-side encryption keeps the keys on the same
server and does not change this. Novelist sync is **not end-to-end encrypted**.
Writers who cannot trust the server operator should run their own server or
keep projects local and export them manually.

## Sync server requirements

Novelist only syncs safely with a WebDAV server that:

- answers `PROPFIND` (Depth 0 and 1) at the exact URL, over HTTPS, without
  redirects, and creates collections with `MKCOL`;
- reports a **strong** `getetag` for every file, and changes it whenever the
  bytes change, including a same-length rewrite within the same second;
- refuses `PUT` with `If-None-Match: *` on an existing file, and `PUT` or
  `DELETE` with a stale `If-Match`, with 412 Precondition Failed.

A server that keeps an ETag after a change, or deletes on a stale
`If-Match`, lets one device overwrite or delete another device's edits
without a conflict. `pnpm mobile:webdav:conformance` checks all of the above
and must pass (exit 0) before writers use a server. Results observed on
2026-10-28:

| Server | Result |
|---|---|
| Apache 2.4.66 `mod_dav_fs` (macOS system httpd, local) | Passes. Warnings: no ETag on the `PUT` response, and `getetag` is weak for about a second after a write, so a sync started right after an upload defers replacing or deleting that file to the next sync. |
| WsgiDAV 4.4, stock configuration (local) | **Fails, unsupported.** Three required checks failed, including: a quick same-length rewrite kept the same strong `getetag`, and `DELETE` with a stale `If-Match` returned 204 and deleted the file. |
| Nextcloud 34 (`docs/selfhost/nextcloud/`) | Not run yet. |

## Support runbook

| Symptom | Likely cause | Action |
|---|---|---|
| "Connect" fails with 401 | Wrong login, or 2FA enabled and the account password was used | Use the login name (not the display name) and an app password |
| Connect fails mentioning a redirect | URL is not the final WebDAV address (http→https, missing path or trailing slash) | Enter `https://<host>/remote.php/dav/files/<login>/` exactly |
| TLS error on Android only | Server sends an incomplete certificate chain | Serve the full chain (Let's Encrypt `fullchain.pem`) |
| "WebDAV PUT returned 507" | Quota exhausted | Raise the quota or free space on the server |
| "WebDAV … returned 423" | Server-side file lock still held | Retry; check the server's background jobs and Redis |
| Conflict reported | Edited on two devices between syncs | Resolve per file in the app; earlier versions remain on the server |
| "Sync identity conflict" | The remote folder belongs to a different project | Do not overwrite; link the correct project or download it from the cloud |
| APK "App not installed" | Different signing key or lower `versionCode` | Use the official release APK; export, uninstall, reinstall if switching from a debug build |
| TestFlight build missing | Expired after 90 days, still processing, or awaiting Beta App Review | Check the build status in App Store Connect; upload a new build |

For server-side checks run `pnpm mobile:webdav:conformance -- --url
<WebDAV URL>` with the writer's login (it asks for the password without
echoing). Ask users for app version, build number, OS version and the error
text; never ask them to send passwords, app passwords or project files.

## Pending external prerequisites

Nothing below exists yet; each item needs a person with the relevant account.

- [ ] Apple Developer Program membership and team roles; Team ID recorded.
- [ ] Explicit App ID `com.novelist.app`; App Store Connect app record (name,
      SKU, Apple ID).
- [ ] Apple Distribution certificate (`.p12`) and App Store Connect
      provisioning profile; App Store Connect team API key.
- [ ] Hosted privacy policy URL and a monitored support/feedback email for
      TestFlight Test Information.
- [ ] GitHub environment `mobile-release` with the secrets and variables above
      (optionally with required reviewers).
- [ ] Android release keystore generated, backed up offline twice,
      fingerprint published.
- [ ] First run of Mobile Release (signed APK attached, TestFlight upload),
      internal testing, then Beta App Review for external testing. No result of
      these steps is known until they run.
- [ ] Desktop betas, if ever wanted: `release.yml` deliberately ignores
      prerelease tags today, so a beta tag ships mobile builds only.
- [ ] Optional: a Nextcloud server for writers, deployed from
      `docs/selfhost/nextcloud/` and checked with the conformance test.
