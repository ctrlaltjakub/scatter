# Changelog

Each version has one entry. Beta versions remain listed until that version is
released to stable, when its label changes to Stable. Older entries are kept.

## 1.1.1 · Beta — 14 November 2026

### Fixes

- Editing only a node title no longer regenerates term previews or retries
  failed preview requests. Existing previews remain available, and requests
  already in progress finish without restarting.
- Title-only edits in the full-window editor retain previews and the node's
  generation language. Body edits still invalidate previews normally.
- Term previews follow the language of the actual source explanation, including
  translated nodes, instead of the language selector or saved generation language.
  Use Redo terms once to refresh previews saved under the previous language rule.

## 1.1.0 · Stable — 14 November 2026

### New features

- Export projects as Obsidian canvases with linked Markdown notes, stored media,
  sources, chats and standalone interactive HTML files. Cards retain their
  positions, sizes and colors; arrows retain their direction and color.
- Gemini 4 Hydrogen is the recommended main model in quick setup. Existing
  setups switch only when main-model updates are enabled and the provider offers it.
- Open the public changelog from the landing-page toolbar or the version in Settings.

### Fixes

- Obsidian canvas cards find their notes in nested project folders and standalone vaults.
- Backup import and export buttons align and wrap within narrower settings panels.

## 1.0.0 · Stable — 8 November 2026

### New features

- First 1.0 release, with a support link and landing-page navigation in Settings.
- GPT Image 2.6 Sunburst is the recommended image model.

## 0.1.0 · Stable — 26 October 2026

### Initial public version

- Published the app's source with separate beta and stable deployment identities,
  isolated cloud synchronization and publication safeguards.
