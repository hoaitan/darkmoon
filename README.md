# Darkmoon 🌙

A Chrome extension (Manifest V3) that darkens any website on the fly, using an adaptive CSS-filter
theme engine — Original / Dark / Auto modes, per-domain overrides, an on-page notification, and
settings synced across devices via `chrome.storage.sync`.

This repo currently ships **Phase 1: the core extension**. Community theme lists and
AI-generated themes are separate, later phases — see the product plan attached to the Darkmoon
epic in Retask for the full architecture and roadmap.

## How it works

- **Background service worker** (`src/background`) — owns settings reads/writes to
  `chrome.storage.sync`, keeps the toolbar badge in sync, and performs the actual `chrome.scripting.insertCSS`/`removeCSS`
  calls on behalf of content scripts (a privileged API content scripts can't call directly).
- **Content script** (`src/content`) — runs on every page at `document_start`: resolves the
  effective mode (domain override → global mode → device `prefers-color-scheme`), samples the
  page's background lightness on first visit, computes/caches an invert+hue-rotate filter, and
  renders the bottom-right notification inside a Shadow DOM root.

  One sampled flag governs the whole document. A page is either already dark or it isn't, and
  every element follows that one decision — there is no per-element classification. The only
  per-tag rule is mechanical: a CSS `filter` on `<body>` transforms everything inside it and
  cannot be opted out of, so elements that paint their own pixels (`img`, `video`, `canvas`,
  `svg image`) get the filter cancelled back off them. On a page that is already dark there is
  no filter to cancel, so those tags get a plain brightness dim instead — enough to stop photos
  glaring against a dark page. Two known trade-offs of keeping it to one flag: an already-dark
  widget on a light page inverts along with the page, and a photo painted via CSS
  `background-image` renders inverted (no selector can reach it without per-element scanning).
- **Toolbar popup** (`src/popup`) — global mode switch, per-site override/ignore, recalculate.
- **Options page** (`src/options`) — global mode, brightness/contrast/sepia sliders, and
  per-site override/ignore-list management.
- **Shared lib** (`src/lib`) — the pure theme-engine and mode-resolution functions, the
  typed `chrome.storage` wrapper, and the mock `chrome` API used by `yarn dev:mocks`.

## Quick start

```sh
yarn install
yarn build
```

Then load it unpacked: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `dist/`.

For the full script reference, the unpacked-extension reload workflow, and the UI screenshot
rule for PRs, see [CONTRIBUTING.md](./CONTRIBUTING.md). The short version:

- `yarn dev` — watch-builds the real extension into `dist/`
- `yarn dev:mocks` — opens the popup in a plain browser tab against seeded mock data, for fast
  UI iteration without the unpacked-extension reload loop
- `yarn test` — unit tests for the pure filter-calculation/mode-resolution logic
- `yarn capture` — loads the built extension in Playwright across a fixture site set, verifies
  filter/notification/Ignore behavior end-to-end, and writes before/after screenshots
- `yarn verify` — typecheck + lint + test + build, everything CI checks

## Tooling

TypeScript, yarn, ESLint + Prettier, Vite (popup/options pages) + esbuild (background/content
scripts) via `scripts/build.mjs`, Vitest, and Playwright.

## Icon

The moon-on-dark-background icon (`src/assets/icons/icon.svg`) is a hand-drawn crescent in the
style of Material Symbols' `dark_mode`/`bedtime` glyphs, rasterized to the sizes Chrome needs via
`yarn icons` (uses `sharp`).
