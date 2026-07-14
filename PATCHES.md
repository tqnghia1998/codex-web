# PATCHES

This repo used to carry a `patches/*.patch` directory applied onto extracted upstream
assets. That flow was removed because exact-file patching against minified bundles was
fragile across Codex Desktop upgrades.

Current rule:
- do **not** bring back the old patch runner
- keep required upstream edits as direct rewrites in `scripts/prepare_asar`
- keep browser-owned behavior in normal source files like `src/browser/shim.ts` and
  `src/browser/routes.ts`

This file is the ledger of every historical patch file, what it originally did, where
that behavior lives now, and what to inspect when upstream changes.

## Current owners by area

- `scripts/prepare_asar`
  - HTML rewrites
  - preload bootstrap rewrites
  - memory-router boot rewrites
  - local-file URL helper rewrite
  - app-host bootstrap rewrites
  - Sentry / noisy logger rewrites
- `src/browser/shim.ts`
  - Electron shim state
  - sidebar behavior
  - renderer IPC bridge
  - workspace-root dialog integration
- `src/browser/routes.ts`
  - browser URL ↔ memory-route mapping
  - share/receive prompt mapping
  - route-level title mapping
- `src/browser/files.ts`
  - browser file picker
  - upload bridge to `/__backend/upload`
- `src/server/main.ts`
  - `/@fs/` static serving
  - upload endpoint
  - IPC websocket bridge

## Patch ledger

| Historical patch file | Original purpose | Status now | Current source of truth / what to update |
|---|---|---|---|
| `webview-remove-csp.patch` | Remove desktop CSP from `webview/index.html` so the app can run in a normal browser. | kept | `scripts/prepare_asar` HTML rewrite. If upstream changes, inspect `scratch/asar/webview/index.html`. |
| `webview-preload.patch` | Inject `preload.js` into the webview HTML / startup path. | kept | `scripts/prepare_asar` HTML injection + `index-*.js` bootstrap rewrite. Inspect `webview/index.html` and `webview/assets/index-*.js`. |
| `webview-style.patch` | Force `--spacing-token-safe-header-left: 0px` to fix browser header spacing. | kept | `scripts/prepare_asar` HTML style injection. Inspect `webview/index.html`. |
| `webview-favicon.patch` | Add favicon link. | kept | `scripts/prepare_asar` HTML injection. Inspect `webview/index.html`. |
| `webview-pwa.patch` | Add manifest link for browser install/share behavior. | kept | `scripts/prepare_asar` HTML injection. Inspect `webview/index.html` and `assets/manifest.json`. |
| `webview-initial-route.patch` | Seed upstream memory-router entries from browser URL and hook navigation updates back out. Also patched initial sidebar state in older bundle shapes. | kept + moved | `scripts/prepare_asar` owns the upstream memory-router rewrite. `src/browser/routes.ts` and `src/browser/shim.ts` own browser URL mapping and history sync. |
| `webview-thread-title.patch` | Update `document.title` from the active thread. | moved | `src/browser/routes.ts` + `src/browser/shim.ts`. If titles regress, inspect route mapping/title update logic before patching upstream again. |
| `webview-electron-shim-close-sidebar.patch` | Expose a `closeSidebar` hook to the shim so mobile navigation can collapse the sidebar. | moved | `src/browser/shim.ts`. Upstream patch no longer needed. |
| `webview-app-host-services.patch` | Make upstream app-host bootstrap use shim services instead of desktop-only wiring. | kept + moved | `scripts/prepare_asar` owns the bootstrap rewrite. `src/browser/shim.ts` owns the actual service objects. |
| `webview-use-atfs-for-local-files.patch` | Rewrite local-file URLs so browser mode uses `/@fs/...` instead of `app://fs...`. Needed for pasted/attached local files and inline previews. | kept | `scripts/prepare_asar` now rewrites the local-file URL helper directly. Related runtime pieces live in `src/server/main.ts` (`/@fs/`) and `src/browser/files.ts` (upload bridge). |
| `webview-prompt-search-param.patch` | Read `?prompt=...` from browser URL and prefill the composer. | watch | Main behavior now lives in `src/browser/routes.ts`. If prompt-prefill regresses, revisit upstream composer bootstrap/injection points. |
| `webview-prosemirror-inputmode.patch` | Mobile editor hack: avoid soft-keyboard autofocus until real interaction. | watch / dropped | No current direct rewrite. Revive only if touch/mobile editor behavior regresses again. |
| `sentry-disable-shell.patch` | Disable Sentry in the upstream shell/main bundle. | kept | `scripts/prepare_asar`. Inspect `scratch/asar/.vite/build/main-*.js` and related shell bundles if upstream changes. |
| `sentry-disable-webview.patch` | Disable Sentry in the renderer/webview bundle. | kept | `scripts/prepare_asar`. Inspect `scratch/asar/webview/assets/*.js` if upstream changes. |
| `webview-artifacts-pane.patch` | Force-enable the artifacts pane feature gate. | dropped | Historical workaround only. No current source of truth. Re-add only if a real product regression requires it. |
| `webview-statsig-override-adapter.patch` | Inject a Statsig override adapter from the shim to control feature gates. | dropped | Historical workaround only. If gate behavior regresses, inspect current Statsig wiring before reviving. |
| `webview-model-list-auth-gate.patch` | Relax model-list auth gating / return data earlier to avoid slow model loading. | dropped | Historical workaround only. Upstream shape changed. |
| `webview-app-logo-disable.patch` | Disable app/logo prefetching and return no app logos. | dropped | Historical perf/stability workaround only. |
| `webview-coalesce-read-requests.patch` | Deduplicate repeated app-server read requests like `model/list`, `plugin/list`, `thread/list`. | reverted | Historical experiment that was explicitly reverted. |

## Upgrade checklist by patch family

### 1. HTML bootstrap rewrites
Inspect:
- `scratch/asar/webview/index.html`

Look for:
- CSP meta tag
- `<!-- PROD_BASE_TAG_HERE -->`
- `<!-- PROD_CSP_TAG_HERE -->`
- `<title>Codex</title>`

If any marker moves, fix the smallest matching rewrite in `scripts/prepare_asar`.

### 2. Preload startup rewrite
Inspect:
- `scratch/asar/webview/assets/index-*.js`

Look for the startup expression that loads the app before our shim. Update only the
smallest bootstrap rewrite needed to ensure `preload.js` runs first.

### 3. Memory-router / route sync rewrite
Inspect:
- `scratch/asar/webview/assets/*.js`
- `src/browser/routes.ts`
- `src/browser/shim.ts`

Look for:
- initial memory-router entries
- navigation callback hook
- browser history updates
- `/thread/:id`, `?folder=...`, and `/share/receive?...` behavior

### 4. Local-file URL behavior
Inspect:
- `scratch/asar/webview/assets/*.js` for `app://fs` and `/@fs`
- `src/server/main.ts` for `/@fs/` static serving
- `src/browser/files.ts` for upload handling

Symptom of breakage:
- pasted local images/files fail to preview
- attached local files resolve to `app://fs...` URLs in the browser

### 5. App-host bootstrap
Inspect:
- `scratch/asar/webview/assets/*.js`
- `src/browser/shim.ts`

Look for the upstream async bootstrap that waits for desktop services and keep the
shim short-circuit in place.

### 6. Sidebar/title/prompt behavior
Inspect:
- `src/browser/shim.ts`
- `src/browser/routes.ts`

These are intentionally owned by normal source code now, not upstream patches.
Prefer changing these files before patching upstream again.

### 7. Sentry / noisy log suppression
Inspect:
- `scratch/asar/.vite/build/main-*.js`
- `scratch/asar/.vite/build/src-*.js`
- `scratch/asar/webview/assets/*.js`

These rewrites are minified-shape-sensitive. If they break, update the smallest
regex/string match in `scripts/prepare_asar`.

## Fast path when upstream updates break us

1. `rm -rf scratch scratch-backup`
2. `CODEX_APP_DIR="/Applications/ChatGPT.app" DEV=1 npm run setup`
3. inspect the affected upstream files in `scratch/asar`
4. update the smallest rewrite in `scripts/prepare_asar` or the matching shim/route file
5. validate with:
   - `npm run build`
   - `npm run smoke`
