# Plugin Marketplace & Registry Design

> Design document for Novelist plugin ecosystem: in-app marketplace, plugin registry repository, and project homepage.
>
> **Status, 2026-11-03:** proposal retained for unfinished in-app marketplace
> work. Current App code lists, enables, reloads and scaffolds local plugins;
> it has no registry fetch/install/uninstall commands, Browse tab or
> `novelist://install-plugin/` handler. The command signatures and URI below
> are proposed interfaces, not working installation instructions. Registry and
> homepage bootstrap sections are historical; their owning repositories define
> the current implementation. Runtime and author contracts live in
> [plugin-system.md](plugin-system.md) and
> [Creating Plugins](../references/creating-plugins.md).

---

## Overview

The Novelist plugin ecosystem consists of three parts:

1. **Plugin Registry Repo** (`Novelist-marketplace`) — GitHub repository serving as the source of truth for all published plugins
2. **In-App Marketplace** — browse, search, install, and update plugins from within Novelist
3. **Project Homepage** — public-facing website for plugin discovery and documentation

---

## Part 2: Plugin Registry & In-App Marketplace

### 2.1 Registry Repository (`Saber-AI-Research/Novelist-marketplace`)

A public GitHub repository that acts as the plugin registry. Inspired by Obsidian's `obsidian-releases` repo and Raycast's extension store. The repository stores **metadata only** — plugin code and binaries are hosted on each plugin author's own GitHub repository as Release assets.

#### Repository Structure

```
Novelist-marketplace/
├── registry.json              # Master index of all plugins (generated, DO NOT EDIT)
├── plugins/
│   ├── word-frequency/
│   │   ├── manifest.toml      # Plugin metadata (same format as in-app)
│   │   ├── README.md           # Plugin documentation
│   │   └── icon.png            # Plugin icon (128x128, optional)
│   ├── pomodoro-timer/
│   │   ├── manifest.toml
│   │   └── README.md
│   └── ...
├── categories.json             # Plugin category definitions (10 categories with CJK names)
├── CONTRIBUTING.md             # Guide for plugin authors
├── scripts/
│   ├── validate.ts             # CI: validate manifest + fetch & validate ZIP from author's release
│   ├── build-registry.ts       # CI: rebuild registry.json + fetch download counts
│   └── shared/                 # Shared utilities
└── .github/
    ├── workflows/
    │   ├── validate-pr.yml     # Auto-validate plugin submissions
    │   ├── publish.yml         # Rebuild registry.json on merge + trigger homepage
    │   └── update-counts.yml   # Daily cron: update download counts via GitHub API
    └── PULL_REQUEST_TEMPLATE.md # Review checklist
```

#### Plugin Distribution

Plugin ZIPs are hosted as **GitHub Release assets on the plugin author's own repository**, not stored in this git repo. This avoids git history bloat, `raw.githubusercontent.com` rate limiting, and meaningless binary diffs.

Download URLs follow the pattern:
```
https://github.com/<author>/<plugin-repo>/releases/download/v<version>/<plugin-id>-<version>.zip
```

#### `registry.json` Format

```json
{
  "version": 1,
  "updated_at": "2025-01-15T10:30:00Z",
  "plugins": [
    {
      "id": "word-frequency",
      "name": "Word Frequency",
      "version": "1.1.0",
      "description": "Analyze word frequency in your document",
      "author": "alice",
      "author_url": "https://github.com/alice",
      "repo": "https://github.com/alice/novelist-word-frequency",
      "permissions": ["read"],
      "category": "analysis",
      "tags": ["words", "statistics"],
      "icon": "plugins/word-frequency/icon.png",
      "downloads": 1234,
      "min_novelist_version": "0.1.0",
      "created_at": "2024-12-01T00:00:00Z",
      "updated_at": "2025-01-10T00:00:00Z",
      "download_url": "https://github.com/alice/novelist-word-frequency/releases/download/v1.1.0/word-frequency-1.1.0.zip",
      "changelog_url": "https://github.com/alice/novelist-word-frequency/releases/tag/v1.1.0",
      "screenshots": []
    }
  ]
}
```

#### `categories.json`

```json
[
  { "id": "analysis",     "name": "Analysis",      "name_zh": "分析",     "icon": "chart" },
  { "id": "formatting",   "name": "Formatting",    "name_zh": "格式",     "icon": "type" },
  { "id": "export",       "name": "Export",         "name_zh": "导出",     "icon": "download" },
  { "id": "productivity", "name": "Productivity",   "name_zh": "效率",     "icon": "zap" },
  { "id": "ui",           "name": "Interface",      "name_zh": "界面",     "icon": "layout" },
  { "id": "language",     "name": "Language",        "name_zh": "语言",     "icon": "globe" },
  { "id": "writing",      "name": "Writing Aids",   "name_zh": "写作辅助", "icon": "pen-tool" },
  { "id": "publishing",   "name": "Publishing",     "name_zh": "出版",     "icon": "book-open" },
  { "id": "theme",        "name": "Themes",         "name_zh": "主题",     "icon": "palette" },
  { "id": "other",        "name": "Other",          "name_zh": "其他",     "icon": "puzzle" }
]
```

#### Plugin Submission Flow

1. Author develops plugin in their own GitHub repository
2. Author creates a GitHub Release on their repo with the plugin ZIP as a release asset
   - ZIP naming: `<plugin-id>-<version>.zip` (e.g., `word-frequency-1.1.0.zip`)
3. Author creates a PR to `Novelist-marketplace` repo with:
   - `plugins/<id>/manifest.toml`
   - `plugins/<id>/README.md`
   - `plugins/<id>/icon.png` (optional, 128x128)
4. CI validates:
   - Manifest schema correctness
   - Plugin ID uniqueness and kebab-case format
   - GitHub Release exists at the declared `repo` + `version`
   - ZIP fetched from Release contains required files (`manifest.toml`, `index.js` or `index.html`)
   - Manifest inside ZIP matches submitted `manifest.toml`
   - ZIP size < 5MB
   - No `eval()`, `Function()`, path traversal patterns in JS
5. Maintainer reviews and merges
6. CI rebuilds `registry.json` and triggers homepage rebuild via `repository_dispatch`

#### Plugin ZIP Structure (hosted on author's GitHub Release)

```
word-frequency-1.1.0.zip
├── manifest.toml
├── index.js
└── (optional: index.html, assets/)
```

### 2.2 In-App Marketplace UI

#### Settings > Plugins Tab Redesign

The Plugins section gets two sub-tabs:

```
┌─────────────────────────────────────────────┐
│  Plugins                                    │
│  ┌──────────┐ ┌──────────┐                  │
│  │ Installed │ │  Browse  │                  │
│  └──────────┘ └──────────┘                  │
│                                             │
│  [Installed Tab]                            │
│  ── Built-in ──                             │
│  ┌─────────────────────────────────────┐    │
│  │ 🗺 Mindmap            v1.0.0  [◯] │    │
│  │ Auto-generated mindmap from headings│    │
│  │ Novelist Team · read, ui            │    │
│  └─────────────────────────────────────┘    │
│  ┌─────────────────────────────────────┐    │
│  │ 🎨 Canvas Editor      v1.0.0  [◯] │    │
│  │ Visual canvas for .canvas files     │    │
│  │ Novelist Team · read, write, ui     │    │
│  └─────────────────────────────────────┘    │
│  ── Community ──                            │
│  ┌─────────────────────────────────────┐    │
│  │ 📊 Word Frequency     v1.1.0  [●] │    │
│  │ Analyze word frequency              │    │
│  │ alice · read         [Uninstall]    │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  [Browse Tab]                               │
│  ┌─────────────────────────────────┐        │
│  │ 🔍 Search plugins...           │        │
│  └─────────────────────────────────┘        │
│  Categories: All | Analysis | Format | ...  │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ ⏱ Pomodoro Timer      v1.0.0      │    │
│  │ Writing timer with break reminders  │    │
│  │ bob · productivity    [Install]     │    │
│  └─────────────────────────────────────┘    │
│  ┌─────────────────────────────────────┐    │
│  │ 🔤 Sentence Counter   v2.0.0      │    │
│  │ Count sentences and paragraphs      │    │
│  │ carol · analysis      [Install]     │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

#### Rust Backend Commands (New)

```rust
// Fetch registry.json from GitHub (cached locally for 1 hour)
fetch_plugin_registry() -> Result<PluginRegistry, AppError>

// Download and install a plugin from the registry
install_plugin(plugin_id: String, version: String) -> Result<(), AppError>

// Remove a community plugin (not builtin)
uninstall_plugin(plugin_id: String) -> Result<(), AppError>

// Check for plugin updates
check_plugin_updates() -> Result<Vec<PluginUpdateInfo>, AppError>
```

#### Registry Caching

- On first "Browse" tab open, fetch `registry.json` from the Novelist-marketplace repo (via GitHub raw URL for the JSON metadata)
- Cache to `~/.novelist/cache/registry.json` with a `fetched_at` timestamp
- Re-fetch if cache is older than 1 hour
- Show stale data immediately while fetching in background

#### Install Flow

1. User clicks "Install" on a plugin
2. Backend downloads the ZIP from `download_url`
3. Validates ZIP structure (must contain `manifest.toml`)
4. Extracts to `~/.novelist/plugins/<id>/`
5. Plugin appears in "Installed" tab (disabled by default)
6. User enables it via toggle

#### Update Flow

1. On app launch or manual check, compare installed versions with registry
2. Show update badge on plugins with newer versions
3. User clicks "Update" → downloads new ZIP, replaces old files
4. If plugin was enabled, re-load it

#### Deep Link (`novelist://`)

Register a custom URI scheme so external sources (website, GitHub README) can trigger in-app install:

```
novelist://install-plugin/word-frequency
```

This triggers the app to:
1. Open Settings > Plugins > Browse tab
2. Show the plugin details
3. Start the install flow

Register in `tauri.conf.json`:
```json
{
  "app": {
    "security": {
      "dangerousRemoteUrlAccess": [
        { "url": "novelist://*" }
      ]
    }
  }
}
```

The website's "Install in Novelist" button simply links to this URI. If the app is not installed, the link does nothing (browser ignores unknown schemes). The website should detect this and fall back to showing manual install instructions.

---

## Part 3: Project Homepage

### 3.1 Website Purpose

A public website serving as:
- Novelist product landing page
- Plugin discovery and documentation browser
- Developer documentation for plugin authors
- Download page for the app itself

### 3.2 Recommended Tech Stack

| Component | Technology | Reason |
|-----------|-----------|--------|
| Framework | Astro | Static site, fast, Astro islands for interactivity |
| Styling | Tailwind CSS | Utility-first, responsive, tree-shaken |
| Hosting | GitHub Pages | Free, integrated with repo |
| Plugin data | Built from `registry.json` | Single source of truth |
| Domain | novelist.dev | Short, memorable, HTTPS enforced |

### 3.2.1 Visual Design

Typora-inspired minimalist single-page scroll for the landing page. See `Novelist-homepage/docs/homepage-design.md` for full visual specification including:
- Full-viewport hero with autoplay video loop and `<!-- -->` Markdown-comment motif
- Split-layout feature sections with video clips
- Interactive hotspot slider for writing features
- Dark background "Open Source" section with GitHub metrics
- 5-column dark footer

### 3.3 Site Structure

```
novelist.dev/
├── /                     # Landing page — hero, features, download links
├── /download             # Platform-specific download links
├── /docs/                # Documentation hub
│   ├── /docs/getting-started
│   ├── /docs/keyboard-shortcuts
│   ├── /docs/creating-themes
│   └── /docs/creating-plugins
├── /plugins/             # Plugin marketplace (web version)
│   ├── /plugins/         # Browse all plugins with search & categories
│   └── /plugins/<id>     # Individual plugin page
└── /blog/                # Release notes, tutorials (optional)
```

### 3.4 Plugin Page Layout

Each plugin gets a dedicated page at `/plugins/<id>`:

```
┌─────────────────────────────────────────────┐
│  novelist.dev/plugins/word-frequency        │
│                                             │
│  ┌────┐  Word Frequency  v1.1.0             │
│  │icon│  by alice                           │
│  └────┘  ★★★★☆ (42 ratings)                │
│          1,234 downloads                    │
│                                             │
│  [Install in Novelist*]  [View Source]      │
│                                             │
│  ─── About ───                              │
│  Analyze word frequency in your document.   │
│  Shows the most used words with counts and  │
│  highlights overused words.                 │
│                                             │
│  ─── Permissions ───                        │
│  • read — Access document content           │
│                                             │
│  ─── Changelog ───                          │
│  v1.1.0 — Added highlighting support        │
│  v1.0.0 — Initial release                   │
│                                             │
│  ─── Screenshots ───                        │
│  [screenshot1] [screenshot2]                │
└─────────────────────────────────────────────┘
```

### 3.5 "Install in Novelist" Button

Plugin pages include an "Install in Novelist" button that uses the `novelist://` deep link (defined in Part 2). If the app is not installed, the page should:
- Detect the failed scheme navigation (via timeout)
- Show a fallback message: "Download Novelist first" with a link to `/download`
- Additionally display manual install instructions (copy plugin to `~/.novelist/plugins/`)

### 3.6 Homepage Repository

The homepage lives in a separate repository: `Saber-AI-Research/Novelist-homepage`.

```
Novelist-homepage/
├── src/
│   ├── pages/
│   ├── components/
│   ├── layouts/
│   ├── content/
│   └── lib/
├── public/
├── scripts/
│   └── fetch-registry.ts   # Pull registry.json at build time (with cached fallback)
├── astro.config.mjs
├── tailwind.config.ts
└── package.json
```

### 3.7 Build Pipeline

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Novelist-       │ PR  │ CI: validate     │merge│ CI: rebuild      │
│ marketplace     │────▶│ manifest + fetch │────▶│ registry.json    │
│                 │     │ & validate ZIP   │     │ + fetch dl counts│
└─────────────────┘     └──────────────────┘     └──────┬───────────┘
                                                        │
                                                        │ repository_dispatch
                                                        ▼
                                                 ┌──────────────────┐
                                                 │ Novelist-homepage│
                                                 │ CI: fetch        │
                                                 │ registry.json    │
                                                 │ + rebuild site   │
                                                 └──────┬───────────┘
                                                        │
                                                        ▼
                                                 ┌──────────────────┐
                                                 │ GitHub Pages     │
                                                 │ novelist.dev     │
                                                 └──────────────────┘
```

Additionally, a **daily cron** (`update-counts.yml`) updates download counts in `registry.json` by querying the GitHub Releases API for each plugin.

---

## Implementation Priority

### Phase 1 (Done)
- [x] Extended plugin manifest with `description`, `author`, `icon`
- [x] Plugin enable/disable persistence (`plugin-settings.json`)
- [x] Built-in plugin auto-installation on first launch
- [x] Settings > Plugins UI with toggle switches and categories

### Phase 2 — Plugin Registry Repo
1. Create `Novelist-marketplace` GitHub repo
2. Set up `registry.json` schema and CI validation
3. Write `CONTRIBUTING.md` with submission guide
4. Seed with 2-3 example community plugins (word-frequency, pomodoro, etc.)

### Phase 3 — In-App Marketplace
1. Add `fetch_plugin_registry` Rust command with caching
2. Add `install_plugin` / `uninstall_plugin` commands
3. Build "Browse" sub-tab UI in Settings
4. Add update checking and notification
5. Register `novelist://` custom URI scheme for deep link install

### Phase 4 — Project Homepage
1. Bootstrap Astro + Tailwind CSS project in `Novelist-homepage/`
2. Build landing page, docs, and plugin browser
3. Plugin pages with "Install in Novelist" button (uses deep link from Phase 3)
4. CI pipeline: `Novelist-marketplace` merge → rebuild site → deploy

---

## Security Considerations

- **Sandboxing**: All plugins run in QuickJS sandbox with permission tiers. No native code execution.
- **Permission display**: Marketplace clearly shows required permissions before install.
- **Code review**: All submissions go through PR review before inclusion in registry.
- **ZIP validation**: CI checks for malicious patterns, size limits (5MB), required files.
- **Update integrity**: ZIPs downloaded from GitHub Releases CDN (HTTPS, CDN-backed, no rate limiting).
- **Builtin protection**: Built-in plugins cannot be uninstalled, only disabled.

---

## Reference: Similar Systems

| Feature | Obsidian | Raycast | Novelist (proposed) |
|---------|----------|---------|-------------------|
| Registry | `obsidian-releases` repo (5-field JSON) | Raycast Store API | `Novelist-marketplace` repo (metadata + generated registry.json) |
| Plugin hosting | Author's GitHub repo | Author's GitHub repo | Author's GitHub Releases |
| Submission | PR to releases repo | PR to extensions repo | PR to marketplace repo (metadata only) |
| Review | Manual + CI | Manual + CI | Manual + CI + automated security checks |
| Install | In-app download | In-app download | In-app download |
| Sandboxing | Electron (limited) | Node sandbox | QuickJS (strict) |
| Custom URI | `obsidian://` | `raycast://` | `novelist://` |
| Website | obsidian.md/plugins (basic SPA) | raycast.com/store | novelist.dev/plugins (Astro, full search/filter) |
| Download counts | External (ObsidianStats) | Built-in | GitHub Releases API + daily cron |
| Categories | None (community gap) | Built-in | 10 categories with CJK names |
