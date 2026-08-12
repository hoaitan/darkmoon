# Contributing to Darkmoon

## Setup

```sh
yarn install
```

## Scripts

| Script                              | What it does                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `yarn dev`                          | Watches and rebuilds the real extension into `dist/` — load it unpacked in `chrome://extensions`                                                                               |
| `yarn dev:mocks`                    | Opens the popup in a plain browser tab against seeded mock data — no extension reload loop, fastest way to iterate on UI                                                       |
| `yarn build`                        | Production build into `dist/`                                                                                                                                                  |
| `yarn typecheck`                    | `tsc --noEmit`                                                                                                                                                                 |
| `yarn lint` / `yarn lint:fix`       | ESLint                                                                                                                                                                         |
| `yarn format` / `yarn format:check` | Prettier                                                                                                                                                                       |
| `yarn test` / `yarn test:watch`     | Vitest unit tests                                                                                                                                                              |
| `yarn capture`                      | Builds the extension, loads it in Playwright across a fixture site set, asserts filter/notification behavior, and writes before/after screenshots to `playwright/screenshots/` |
| `yarn verify`                       | Everything CI checks: typecheck + lint + test + build                                                                                                                          |

## Loading the unpacked extension

1. `yarn build` (or `yarn dev` to keep rebuilding on change)
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`
3. After a `yarn dev` rebuild, click the reload icon on the extension card (Chrome doesn't auto-reload unpacked extensions)

## Screenshot rule for UI/UX PRs

**Any PR that changes something user-visible** — the popup, the options page, the on-page
notification, the filter/theme appearance, the icon — **must run `yarn capture` and attach the
relevant before/after images from `playwright/screenshots/` to the PR** (see the PR template).
This is what caught real rendering bugs during Phase 1 (a canvas-background/filter interaction,
and a `filter`-creates-containing-block issue with the notification's positioning) that would
have been easy to miss from code review alone — screenshots are the fast, cheap way to catch
that class of bug before merge.

PRs with no visible UI/UX change (background/storage logic, build tooling, docs) can skip the
screenshot section — just say so.

## Testing philosophy

- Pure logic (filter calculation, mode resolution, domain normalization) gets unit tests
  (`src/**/*.test.ts`, run via `yarn test`).
- Behavior that only makes sense with a real browser + real extension (content script injection,
  the notification, the Ignore flow, cross-site behavior) is covered by `yarn capture`, which
  loads the actual built `dist/` extension in Chromium via Playwright — not a simulation.
