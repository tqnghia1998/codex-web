# AGENTS.md

## What this repo is

`codex-web` runs the Codex Desktop app UI in a normal browser on macOS.

It works by:
1. extracting the installed Codex Desktop `app.asar`
2. rewriting a small set of upstream assets in `scratch/asar`
3. serving the extracted webview over Fastify
4. shimming enough Electron APIs for the upstream main bundle to boot
5. bridging renderer `ipcRenderer` traffic to the server over WebSocket

Do not treat this like a normal greenfield web app. Most behavior is inherited from upstream bundled assets.

---

## Files that matter most

### Build / packaging
- `scripts/prepare_asar` — extracts upstream app and applies all required rewrites
- `scripts/build.mjs` — creates `dist/`, bundles server, tars `scratch/asar`, tars runtime node modules, writes the launcher wrapper
- `scripts/smoke.mjs` — end-to-end smoke test for the built app

### Browser shim
- `src/browser/shim.ts` — renderer-side Electron shim, IPC bridge client, route sync, sidebar behavior, workspace picker bridge
- `src/browser/routes.ts` — browser URL ↔ memory-router mapping
- `src/browser/files.ts` — browser file picker + upload bridge
- `src/browser/workspace-root-dialog.tsx` — local directory picker UI
- `vite.browser.config.ts` — builds `src/browser/shim.ts` into the extracted webview assets as `preload.js`

### Server / Electron shim
- `src/server/main.ts` — Fastify server, static serving, upload endpoint, IPC WebSocket bridge, upstream main bundle startup
- `src/server/module.ts` — module alias hook entry
- `src/server/electron/index.ts` — fake Electron module used by upstream main-process code

### Docs
- `README.md` — user-facing setup/run/build instructions
- `ARCHITECTURE.md` — short architecture note
- `PATCHES.md` — full upstream patch/rewrite ledger and upgrade checklist
- `AGENTS.md` — this file; AI-facing repo rules and logic inventory

---

## Ground truth rules for future edits

1. **Do not edit `dist/` to fix behavior.**
   - `dist/` is generated.
   - Fix the source in `scripts/build.mjs`, `scripts/prepare_asar`, `src/browser/*`, or `src/server/*`.

2. **Do not reintroduce patch files.**
   - The old `patches/*.patch` flow was removed because it was brittle across Codex upgrades.
   - Keep rewrites in `scripts/prepare_asar` as direct Python/string/regex transforms.

3. **Prefer marker- or regex-based rewrites over exact minified names.**
   - Upstream bundle filenames and symbol names drift often.
   - Matching `index-*.js`, `main-*.js`, semantic snippets, or HTML markers is safer than exact filenames/functions.

4. **Use `DEV=1 npm run setup` when upstream changes break rewrites.**
   - That prettifies `scratch/asar` for inspection.
   - Then update the matching rewrite in `scripts/prepare_asar`.

5. **If build/runtime breaks around `better-sqlite3`, fix `scripts/build.mjs`, not the built wrapper.**
   - The dist wrapper is generated from `scripts/build.mjs`.

6. **Keep the rewrite surface small.**
   - If a behavior already exists in `src/browser/shim.ts` or server code, delete the upstream patch instead of duplicating it.

---

## Commands that matter

- Install/build extracted assets:
  - `npm install`
  - `npm run setup`
- Build distributable output:
  - `npm run build`
- Run locally:
  - `npm run run`
- Smoke test built output:
  - `npm run smoke`
- Inspect upstream after a Codex upgrade:
  - `rm -rf scratch scratch-backup`
  - `CODEX_APP_DIR="/Applications/ChatGPT.app" DEV=1 npm run setup`

---

## Environment variables

- `CODEX_APP_DIR`
  - installed Codex/ChatGPT `.app` location
  - default: `/Applications/ChatGPT.app`
- `CODEX_ASAR_DIR`
  - override extracted patched app directory at runtime
- `CODEX_CLI_PATH`
  - Codex CLI binary path
- `CODEX_VENDOR_NODE_MODULES_DIR`
  - runtime vendor tree used by the generated launcher
- `DEV`
  - when set during `npm run setup`, prettifies extracted upstream code for inspection

---

## Runtime flow

### Setup/build flow
1. `scripts/prepare_asar` extracts the installed upstream `app.asar` into `scratch/asar`
2. assets from `assets/` are copied into `scratch/asar/webview/`
3. required upstream rewrites are applied in-place
4. Vite builds `src/browser/shim.ts` to `scratch/asar/webview/assets/preload.js`
5. TypeScript builds the server code
6. `scripts/build.mjs` bundles the server into `dist/server.cjs`
7. `scripts/build.mjs` archives:
   - `scratch/asar` → `dist/asar.tgz`
   - `better-sqlite3` dependency tree → `dist/runtime-node-modules.tgz`
8. `scripts/build.mjs` generates `dist/codex-web.js`

### Runtime flow
1. `dist/codex-web.js` extracts `asar.tgz` and runtime node modules to temp caches
2. it probes `better-sqlite3`
3. if the native binary mismatches the current runtime ABI, it runs `npm rebuild better-sqlite3`
4. when running under Electron, rebuild uses Electron-targeted args:
   - `--runtime=electron`
   - `--target=${process.versions.electron}`
   - `--disturl=https://electronjs.org/headers`
5. server starts from `dist/server.cjs`
6. server serves `scratch/asar/webview` assets and boots the upstream main bundle from `scratch/asar/.vite/build/main-*.js`

---

## Critical runtime logic

### 1) better-sqlite3 runtime handling

This is easy to break.

Important facts:
- native modules are cached in temp, not inside repo state
- vendor cache key is runtime-specific
- cache key includes runtime kind + ABI
  - Node: `node-${process.versions.node}-abi-${process.versions.modules}`
  - Electron: `electron-${process.versions.electron}-abi-${process.versions.modules}`
- this prevents reusing a Node-built binary under Electron, or vice versa

If this regresses, inspect `scripts/build.mjs` first.

### 2) Browser routing is not normal browser routing

Upstream UI uses an in-memory router. Browser URL sync is custom.

Implemented in:
- `src/browser/routes.ts`
- `src/browser/shim.ts`
- one upstream rewrite in `scripts/prepare_asar` to seed initial entries and notify navigation changes

Current behavior:
- `/thread/:id` maps to memory route `/local/:id`
- `/` with `?folder=/path` maps to `/projects?projectId=/path`
- `/share/receive?...` gets collapsed into `/?prompt=...` then browser URL is rewritten back to `/`
- memory navigation updates browser history through `onMemoryNavigationChanged`
- some routes update `document.title`

If routing regresses after a Codex upgrade, inspect:
- initial route rewrite in `scripts/prepare_asar`
- `src/browser/routes.ts`
- `src/browser/shim.ts`

### 3) Sidebar behavior on mobile is shim-owned

Important facts:
- `initialSidebarState` is computed in `src/browser/shim.ts` from `(max-width: 768px)`
- the shim closes the sidebar on mobile when navigating to certain routes
- old upstream patch-file logic for `closeSidebar` was removed; this behavior now lives in the shim path

### 4) IPC bridge design

The browser does not have real Electron IPC.

Instead:
- renderer shim opens WebSocket `ws(s)://host/__backend/ipc`
- renderer sends `ipc-renderer-send` / `ipc-renderer-invoke`
- server stores handlers on global `__codexElectronIpcBridge`
- fake Electron `ipcMain` in `src/server/electron/index.ts` dispatches through that bridge
- server replies over the same WebSocket

Related direct bridges:
- file upload: `POST /__backend/upload`
- workspace directory listing requests

If IPC regresses, inspect both:
- `src/browser/shim.ts`
- `src/server/electron/index.ts`

### 5) File picker path

Upstream renderer asks Electron to pick local files. In browser mode we fake it.

Flow:
- browser shim intercepts local file picker requests
- `src/browser/files.ts` opens a real `<input type="file">`
- selected files are uploaded to `POST /__backend/upload`
- server writes uploads to a temp dir and returns paths
- upstream code receives those temp paths as if Electron had returned them
- pasted browser-only files also route through `src/browser/files.ts` via a `chrome.runtime.sendMessage` shim that stages chunked uploads and returns a temp path on finalize

### 6) Workspace picker path

Workspace root browsing is also browser-owned.

Flow:
- renderer asks for directory entries
- server reads local filesystem and returns sorted entries
- `src/browser/workspace-root-dialog.tsx` renders the picker UI

Sorting rules in `src/server/main.ts`:
- directories before files
- non-hidden before hidden
- then lexical name sort

---

## Upstream rewrite inventory with labels

These labels are the current truth.

### [KEPT] still required and currently implemented in `scripts/prepare_asar`

- **remove CSP from `webview/index.html`**
  - browser mode needs a looser execution model than upstream desktop CSP
- **inject favicon + manifest + base tag + preload script + header-left style into `webview/index.html`**
  - replaces old `webview-favicon`, `webview-pwa`, `webview-style`, and part of `webview-remove-csp`
- **patch `index-*.js` bootstrap to load `preload.js`**
  - ensures shim runs before upstream app startup
- **patch initial memory-router entries + navigation callback**
  - required for browser URL ↔ memory router sync
- **patch project-root selection fallback**
  - rewrite: `ge=x?null:P?.hostId==null&&P?.projectId!=null?P.projectId:O??Te("~")`
  - preserves selected project behavior for folder-backed startup
- **patch app-host services bootstrap**
  - uses `window.__ELECTRON_SHIM__.services` when present instead of requiring upstream desktop wiring
- **patch folder-filtered project groups**
  - filters/sorts project groups using `window.__ELECTRON_SHIM__.folderFilterProjectId`
- **patch local-file URL helper**
  - rewrites browser local-file URLs to stay on `/@fs/...` instead of `app://fs...`
  - required for pasted/attached local files and inline local previews
- **disable Sentry in shell bundle(s)**
- **disable Sentry in webview bundle(s)**
- **disable appshot global hotkey service**
  - browser mode cannot host the macOS bare-modifier helper used by shortcuts such as `DoubleCommand`
  - appshot UI actions remain available

### [MOVED] behavior still matters, but source-of-truth is now regular source code, not upstream patch files

- **close sidebar behavior**
  - source of truth: `src/browser/shim.ts`
- **initial sidebar state**
  - source of truth: `src/browser/shim.ts`
- **browser title sync for known routes**
  - source of truth: `src/browser/routes.ts` + `src/browser/shim.ts`
- **folder URL to project selection mapping**
  - source of truth: `src/browser/routes.ts` + `src/browser/shim.ts`
- **share/receive prompt mapping**
  - source of truth: `src/browser/routes.ts`
- **requestUserInputAutoResolution no-op services**
  - source of truth: `src/browser/shim.ts`

### [DROPPED] old patch existed, but current direct evidence says it is stale or unneeded

- **`webview-thread-title.patch`**
  - old target vanished
  - route-level title sync already exists in shim-owned code
- **`webview-electron-shim-close-sidebar.patch`**
  - superseded by shim-owned sidebar logic
- **`webview-prosemirror-inputmode.patch`**
  - old `inputmode:none` mobile hack target disappeared from current upstream bundle

### [WATCH] could matter later; only revive if a real regression is observed

- **`webview-prompt-search-param.patch`**
  - old injection site disappeared
  - share/receive prompt mapping still exists on our side, but if prompt prefill stops reaching the composer, revisit this behavior
- **extra title-sync behavior beyond known route mapping**
  - if upstream changes where titles are derived, a new targeted rewrite may be needed
- **mobile editor/input quirks**
  - if touch/pointer editing regresses, revisit the old ProseMirror input-mode idea

---

## When a Codex upgrade breaks build or runtime

Use this order:
1. run `CODEX_APP_DIR="/Applications/ChatGPT.app" DEV=1 npm run setup`
2. inspect `scratch/asar/webview/index.html`
3. inspect matching `scratch/asar/webview/assets/*.js`
4. inspect `scratch/asar/.vite/build/main-*.js` and `worker.js`
5. update the smallest rewrite in `scripts/prepare_asar`
6. if runtime-native loading broke, inspect `scripts/build.mjs`
7. validate with:
   - `npm run build`
   - `npm run smoke`

Do not start by editing docs or generated dist output.

---

For the complete historical ledger of every old `patches/*.patch` file, current owner, and what to inspect after an upstream update, see `PATCHES.md`.

## Things an AI should not forget

- This repo is **upgrade-fragile by nature** because it rides on upstream minified bundles.
- `scripts/prepare_asar` is the highest-risk file after Codex upgrades.
- `scripts/build.mjs` is the highest-risk file for native runtime/ABI bugs.
- Prefer deleting obsolete compatibility code over preserving dead patches.
- If a behavior already works via `src/browser/shim.ts`, do not patch upstream just to duplicate it.
- `npm run smoke` is the cheap check; run it after nontrivial runtime/build changes.
