# Changelog

Each version has one entry. Beta versions remain listed until that version is
released to stable, when its label changes to Stable. Older entries are kept.

## 1.3.0 · Stable — 22 November 2026

### New features

- Generated term previews now aim to add information beyond the surrounding text.
- **Redo terms** keeps terms you marked manually and regenerates previews for
  both manual and automatic marks. With automatic previews off, only manually
  marked terms get fresh previews.

### Fixes

- Term preview cards fit their longest rendered line instead of leaving an empty
  strip beside the text.
- Selecting a sidebar group leaves the camera still if every member is visible.
  Otherwise it centers the group in the visible canvas, excluding the sidebar.
  It never zooms in and only zooms out when the group cannot fit.

## 1.2.3 · Stable — 22 November 2026

### New features

- WASD camera panning is twice as fast.
  - Diagonal movement remains normalized to the same speed as horizontal or
    vertical movement. Mouse and touchpad controls and Q/E zoom are unchanged.

## 1.2.2 · Stable — 16 November 2026

### Fixes

- Node navigation keeps the current zoom when the node and its panels fit.
  - Focusing a node, following a linked term, expanding bullets, starting the
    reading ruler and returning to a parent no longer force zoom down to 100%.
  - When more room is needed, the camera zooms out only enough to fit the content.
- Opening a node's right-side panel preserves zoom and vertical reading position,
  including above 100% zoom.
- Explicit Fit node to screen and group fits still use a 100% zoom ceiling.
  The camera settings description now distinguishes fits from ordinary navigation.

## 1.2.1 · Stable — 15 November 2026

### New features

- Mark term in the text-selection toolbar makes the selected occurrence clickable
  and requests a preview for that term only. It sits between Web search and Explore.
- Preview requests for manually marked terms run independently and retain completed
  results when more terms are marked. Explicit requests also work with automatic
  previews turned off. Marking is undoable and is disabled during node generation
  and term marking, while preview generation can continue in the background.

### Fixes

- Saving bold text containing terms keeps formatting balanced. Existing affected
  explanations render without exposed bold markers or bold extending into later text.
- Explore and selected-text follow-ups from Markdown text nodes retain source
  highlights, relation outlines, hover previews and navigation to their child nodes.
  Older saved Markdown relations can also reveal their original source version.

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
