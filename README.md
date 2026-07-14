# codex-web

A browser frontend for Codex Desktop, running locally on macOS.

## Requirements

- macOS with Codex Desktop installed
- Node.js and npm
- Codex CLI installed and signed in

## Setup

`npm run setup` extracts the installed Codex Desktop app, applies the browser
patches, and builds the frontend. It reads
`/Applications/ChatGPT.app/Contents/Resources/app.asar` by default.

```bash
npm install
npm run setup
```

Set `CODEX_APP_DIR` when the app is installed elsewhere:

```bash
CODEX_APP_DIR="/Applications/Codex.app" npm run setup
```

Sign in to the CLI before starting the server:

```bash
codex login --device-auth
```

## Run

```bash
npm run run
```

The server listens on `127.0.0.1:8214`. Change the port with:

```bash
npm run run -- --port 9000
```

To build a runnable `dist/` folder:

```bash
npm run build
node dist/codex-web.js --port 9000
```

The build now writes everything needed into `dist/`:

- `dist/codex-web.js`
- `dist/server.cjs`
- `dist/asar/`
- `dist/node_modules/`

Keep that folder together when you copy or deploy it. You can still override
the bundled app files with an existing extracted app:

```bash
CODEX_ASAR_DIR=/absolute/path/to/scratch/asar node dist/codex-web.js --port 9000
```

Set `CODEX_CLI_PATH` too if you want a specific Codex CLI binary.

Run a quick smoke check against the built `dist/` server with:

```bash
npm run smoke
```

It starts `dist/codex-web.js` on a random localhost port and checks `/`,
`/assets/preload.js`, `/?folder=...`, file upload, and the IPC websocket.

Open <http://127.0.0.1:8214>. To start with a folder selected, URL-encode its
path:

```text
http://127.0.0.1:8214/?folder=%2FUsers%2Fme%2FDocuments
```

## Updating Codex Desktop

Update Codex Desktop first, then regenerate the build:

```bash
rm -rf scratch scratch-backup
CODEX_APP_DIR="/Applications/ChatGPT.app" DEV=1 npm run setup
mv scratch scratch-backup
```

Run `npm run setup` again after the update. It extracts the new `app.asar`,
applies every patch in `patches/`, and rebuilds the browser assets.

If an upstream update changes bundle names or code, inspect failed patches and
update the corresponding patch files. Use strict mode to make any failed patch
stop the build:

```bash
PATCH_STRICT=1 npm run setup
```

Validate the result by starting the server and opening the browser UI.

## Security

The server has no authentication. Keep it bound to `127.0.0.1` unless you put
an authenticated, encrypted proxy in front of it. Anyone who can access the UI
may run commands and read or modify resources available to the server process.
