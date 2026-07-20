# Image Hosting

Status: implemented contract
Last updated: 2026-07-17
Target version: v0.2.4

## Goal

Writers should be able to upload images embedded in a Markdown document
to a configured image host (Qiniu, Aliyun OSS, Amazon S3, Cloudflare R2,
imgur, sm.ms, or a minimal custom HTTP endpoint), so that the document
can be shared or published without local-only image links.

This spec covers image hosting only. Publishing pipelines (Ghost, WordPress
self-hosted, WordPress.com, and Medium) are a separate feature with
[their own spec](2026-05-06-publish.md).

## Non-Goals

- Image preprocessing: no compression, resizing, or format conversion.
  Files upload byte-identical.
- Image-host plugins: providers are built-in only. The plugin contract
  for third-party hosts is not in scope.
- Concurrent batch uploads: sequential, one image at a time.
- Re-upload migration tools: there is no "move all images to a different
  host" feature.
- Automatic retry: a failed upload requires manual retry from the same
  context menu or palette command.

## Providers

Seven user-visible options (six built-in providers plus a minimal
Custom escape hatch). Cloudflare R2 reuses the S3 implementation, so
there are five distinct provider Rust modules plus Custom. Each
provider is a self-contained Rust function — no shared trait, no
generic HTTP recipe engine.

| Provider | Auth | API surface |
|---|---|---|
| Qiniu | AK + SK + bucket + domain | Upload token + multipart POST to upload endpoint |
| Aliyun OSS | AccessKeyId + AccessKeySecret + bucket + endpoint + optional custom domain | Signed PUT |
| Amazon S3 | AccessKeyId + SecretAccessKey + bucket + region + optional endpoint + optional path prefix + optional custom domain | SigV4 PUT |
| Cloudflare R2 | (Same shape as S3 with `endpoint` set to R2 URL) | SigV4 PUT |
| imgur | Client ID | Multipart POST `https://api.imgur.com/3/image` |
| sm.ms | Optional API token | Multipart POST `https://sm.ms/api/v2/upload` |
| Custom | POST URL + optional bearer token | Multipart POST, `file=` field, response URL at `url` or `data.url` |

R2 reuses the S3 implementation; the settings UI presents R2 as a
preset that fills in the Cloudflare R2 endpoint pattern.

## Configuration

A user can configure any number of hosts. One is marked the **active
host**. Per-project settings can override which host is active, but
secrets and other host configuration live only at the global tier.

```
Global settings file:
  image_hosts:
    hosts: [HostConfig, ...]      // user-named; carries credentials
    active_host_id: string?
    auto_on_paste: bool            // default false

Per-project settings overlay:
  image_hosts:
    active_host_id: string?       // override only
    // hosts[] and credentials are ignored at the project tier
```

Credentials are stored plaintext in the global settings JSON. This
choice is deliberate; the operating system's disk encryption is the
trust boundary. To prevent accidental git commits, no credential field
is ever written to per-project settings files.

## User Behaviors

### Configuring hosts (Settings → Image Hosts)

- The user sees a list of configured hosts and an "Add Host" action.
- "Add Host" opens a provider picker matching screenshot 4 of the
  v0.2.4 design conversation: Qiniu, Aliyun OSS, Amazon S3, Cloudflare
  R2, imgur, sm.ms, Custom.
- Each provider has its own form with only the fields that provider
  needs.
- A "Set as Active" radio in the list determines the default host.
- A toggle "Upload images automatically when pasted" controls
  auto-on-paste behavior. Default: off.
- A "Test" button on each host attempts a 1×1 PNG upload and reports
  pass/fail with the actual error message.

### Uploading a single image (default flow)

- Right-click a rendered image → "Upload to host" appears in the image
  context menu (existing menu in `app/lib/editor/wysiwyg.ts`).
- The file is read, sent to the active host, and on success the
  Markdown source is rewritten in place: `![alt](./local.png)` becomes
  `![alt](https://cdn.example.com/2026/05/06/a1b2c3d4-local.png)`.
- The local file is left untouched.
- A toast confirms success: "Uploaded to {host name}".
- On failure, a toast displays the error, and the Markdown is unchanged
  so the user can retry.

### Uploading every local image in a document

- Command palette entry: "Image Host: Upload all local images in this
  document".
- The command iterates Image nodes in the syntax tree, skips ones
  already pointing at remote URLs, uploads each sequentially, and on
  completion replaces all successful URLs in a single CodeMirror
  transaction.
- Partial failure is allowed: successes are replaced, failures are
  reported in a summary toast ("5/8 uploaded, 3 failed").

### Auto-on-paste / auto-on-drop

- When the global toggle is on and an active host exists, pasting or
  dragging an external image into the editor performs the upload after
  the existing local-write step.
- The local file under `<doc-dir>/.assets/` is created as today; it is
  retained even after the URL is rewritten.
- Failure is silent except for a single toast; the local link remains
  in the document.

### Remote object key (for hosts where the client picks the key)

`{yyyy}/{mm}/{dd}/{8-char-blake3}-{sanitized-name}.{ext}`

- The `{sanitized-name}` is ASCII-only after stripping diacritics; CJK
  is replaced with `image`.
- Maximum total length 200 chars to stay under typical bucket key
  limits.
- For S3-compatible providers, the configured `path_prefix` is
  prepended.

### Errors the user can see

- Network failure (DNS / TCP / TLS / 30 s timeout): "Could not reach
  {host}. Check your connection."
- Authentication failure (401/403): "{host} rejected the request.
  Verify your credentials in Settings → Image Hosts."
- Quota / rate limit (429 or provider-specific): "Upload quota
  exceeded for {host}."
- File too large (imgur >10 MB, sm.ms >5 MB): "Image is {x} MB; {host}
  allows up to {y} MB."
- Server error (5xx): "{host} returned an error: {message}".
- Unparseable response: "Upload finished but the response did not
  contain a URL."
- Bad config (missing bucket, etc.): "{provider} configuration is
  incomplete."

In every case the document Markdown is unchanged.

## Acceptance Criteria

- A user with valid Qiniu / Aliyun OSS / S3 / R2 / imgur / sm.ms
  credentials can configure a host, set it active, and upload an image
  via the image context menu.
- A Custom host configured to a sm.ms-compatible endpoint with a
  bearer token uploads successfully.
- A per-project settings file can switch the active host without
  containing any credentials.
- Auto-on-paste, when enabled, uploads pasted images and replaces the
  Markdown source within 5 seconds on a typical broadband connection.
- The document's Markdown is never corrupted by an upload failure.
- The local file referenced by the original Markdown link is never
  deleted by this feature.
- Local file reads use Rust-owned, per-window directory capabilities registered
  by the project watcher/open-file lifecycle. The webview supplies only the
  document base and relative reference. Absolute references, parent traversal,
  unregistered bases, cross-window scope reuse, symlink components, and detected
  directory replacement fail before bytes are hashed or sent to an image host.
- The "Upload all local images in this document" palette command
  succeeds on all images, partially fails gracefully when some uploads
  fail, and never modifies images already pointing at remote URLs.
- Settings-stored secrets do not appear in any file inside the user's
  project directory.

## Test Harness

- **Rust unit tests** (`core/src/services/image_host/*.rs`): one file
  per provider, using `wiremock` to stub upstream HTTP. Cases cover
  success, 401, 403, 5xx, malformed JSON, and timeout. Each case
  asserts the exact error variant produced.
- **Naming-key generator tests** (`core/src/services/image_host/naming.rs`):
  pure unit tests on filename sanitization, length cap, and date
  determinism (clock injected).
- **Frontend unit tests** (`tests/unit/services/image-host.test.ts`):
  mocked `invoke`, verifies provider-command routing, per-project
  override resolution, scoped project/single-file read arguments,
  single-image URL replacement range, and batch partial-failure handling.
- **Confined read tests** (`core/src/commands/image_host.rs`): exercise nested
  CJK/space filenames plus traversal, absolute paths, symlink root/file/parent,
  pre/post-verification directory swaps, replaced roots, owner isolation, and
  revocation against an external sentinel.
- No dedicated browser E2E or `live-host-tests` Cargo feature currently ships.
  Settings/editor integration and live-provider verification remain manual.

## Known gaps

- Browser E2E coverage for image-host settings and editor workflows is not
  present. Rust provider tests and frontend service tests are the automated
  coverage; live providers are verified manually with private credentials.
- `app/lib/ipc/commands.ts` is generated by tauri-specta and must never be
  maintained manually.
