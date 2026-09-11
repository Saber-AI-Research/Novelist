# homebrew-novelist

Homebrew tap for [Novelist](https://github.com/Saber-AI-Research/Novelist) — a
lightweight WYSIWYG Markdown desktop writing app for novelists.

## Install

```sh
brew tap saber-ai-research/novelist
brew install --cask novelist
```

Or in one line:

```sh
brew install --cask saber-ai-research/novelist/novelist
```

Recent Homebrew versions ask you to trust a third-party tap before installing
from it. Accept the prompt, or trust it up front with
`brew trust saber-ai-research/novelist`.

## Gatekeeper

Novelist is currently shipped **ad-hoc signed** — there is no Apple Developer ID
signature or notarization yet. macOS would otherwise refuse to launch the copy
Homebrew stages ("Novelist is damaged and can't be opened"), so the cask clears
the quarantine flag in a `postflight` block. That block goes away once the
release pipeline signs and notarizes the app.

## Update

```sh
brew update
brew upgrade --cask novelist
```

The app also self-updates via the Tauri updater plugin, so `brew upgrade` is
optional once installed.

## Uninstall

```sh
brew uninstall --cask novelist
brew untap saber-ai-research/novelist
```

To wipe local state as well:

```sh
brew uninstall --cask --zap novelist
```

## Architectures

The cask publishes both Apple Silicon (`aarch64`) and Intel (`x64`) DMGs
produced by the [Novelist release pipeline][release].

The `Casks/novelist.rb` file in this repo is updated automatically by the
[`bump-homebrew.yml`][workflow] workflow in the main Novelist repo, which runs
when a GitHub release is *published* (tag builds stop at a draft, and a draft is
not a valid cask source). Manual edits will be overwritten on the next release.

The same workflow can be re-run by hand from the Actions tab, and the cask can
be rendered locally with `scripts/bump-homebrew-cask.sh` in the main repo.

[release]: https://github.com/Saber-AI-Research/Novelist/releases
[workflow]: https://github.com/Saber-AI-Research/Novelist/blob/main/.github/workflows/bump-homebrew.yml
