# Security

Last updated: 2026-04-25

Novelist is a local desktop app, so the main security concerns are file
safety, plugin isolation, update integrity, sync boundaries, and command
surface discipline.

## Current Posture

- Filesystem access goes through Rust Tauri commands, not direct frontend
  filesystem APIs.
- IPC bindings are typed and generated through tauri-specta.
- Plugins run in a QuickJS sandbox with explicit permission tiers.
- Export is delegated to an external Pandoc binary.
- Pandoc export accepts only fixed format arguments plus an exact backend-created,
  owner-only HTML stylesheet path; arbitrary filters, engines, response files,
  positional arguments, and output overrides are rejected in Rust.
- Project export enumerates and reads Markdown through a no-follow directory
  capability retained for the complete scan/read pass. Symlink entries and paths
  outside the project are rejected, dirty tabs are saved first, and file count,
  depth, path bytes, and aggregate input are bounded.
- Markdown image destinations are parsed before conversion. Network, absolute,
  encoded traversal, and ambiguous resource paths are rejected. Safe
  percent-encoded CJK filenames are decoded before capability-confined reads. Local
  raster images are read no-follow through retained directory capabilities,
  signature-checked, bounded, and rewritten to data URIs; raw HTML/TeX/YAML
  metadata and non-variable theme CSS are disabled.
- Pandoc writes inside a private temporary output directory, enforces a 1 GiB
  output cap, and atomically replaces
  the selected destination only after successful conversion; a destination
  that aliases any source file is rejected.
- Pandoc discovery accepts native executables rather than Windows batch scripts,
  and diagnostics redact quoted as well as unquoted credential forms.
- Updater support exists through Tauri's updater plugin.
- Tag release actions are commit-pinned, dependency installs are frozen/locked,
  platform builders create drafts, and public release requires every build gate.
- The WebDAV cloud account (one per device, from an existing provider; no
  Novelist account service) stores its app password in the platform vault:
  iOS Keychain (`AfterFirstUnlockThisDeviceOnly`, not synchronizable) or an
  Android Keystore AES-GCM key, with no plaintext fallback on mobile. Desktop
  keeps it in an owner-only (`0700` folder, `0600` file) app-data file that is
  **not encrypted at rest**, the same level as per-project WebDAV settings.
  The vault record binds the password to the URL and user it was entered for;
  it is released only for exactly that pair and never returned over IPC.
  Connecting validates the URL (https, or http to loopback only; no embedded
  credentials, query or fragment) and authenticates before storing anything;
  redirects are refused rather than followed. Remote project listings, identity
  cards, `project.toml` and file downloads are size- and count-bounded, and a
  listing href escaping its folder rejects the whole listing. See
  `docs/design-docs/file-lifecycle.md` (Cloud account).

## Rules For New Work

- Do not add HTTP API calls or AI model integrations to the desktop kernel.
- Do not grant plugins filesystem or network access without a product and
  security review.
- Validate paths at Rust command boundaries.
- Preserve atomic writes for user content and project metadata.
- Keep secrets out of project files, logs, and generated docs.
- Bound and redact AI provider, stream, and context-resolution diagnostics
  before store mutation, rendering, project-session persistence,
  or transcript export. A failed pre-send prompt remains owned by its source
  project/session for explicit retry and must never surface in a destination
  session after a project or session switch.
- Treat WebDAV and future sync integrations as untrusted network surfaces.

## Review Checklist

- Does the change introduce a new command, file operation, plugin permission,
  external process, updater behavior, or network path?
- Is the command covered by Rust tests or E2E tests?
- Does the frontend rely on generated bindings rather than hand-written IPC?
- Can an untrusted plugin reach files, shell, network, or project settings?
- Are errors explicit and recoverable for the writer?
