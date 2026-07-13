# Upgrading

Codex Web uses the Codex Desktop installation on the host. To upgrade the
embedded UI, update Codex Desktop locally first, then regenerate `scratch/`.

## Back up the current build

```bash
rm -rf scratch scratch-backup
CODEX_APP_DIR="/Applications/ChatGPT.app" DEV=1 npm run setup
mv scratch scratch-backup
```

Set `CODEX_APP_DIR` when Codex Desktop is installed elsewhere.

## Port patches to the new app

Install or update Codex Desktop, then inspect the existing patches in
`patches/` against the new app. Apply any required changes to `scratch/` and
regenerate the corresponding patches with `diff`; do not write patch files by
hand.

The patch pipeline is defined in `scripts/prepare_asar`. It extracts
`Contents/Resources/app.asar`, copies the browser assets, formats patched files,
and applies every patch in `patches/`.

## Upgrade the Codex CLI

The CLI is separate from Codex Desktop. Check the installed or configured CLI
version with:

```bash
codex --version
```

## Validate

Build from the installed app:

```bash
CODEX_APP_DIR="/Applications/ChatGPT.app" npm run setup
```

Then start the server and open <http://127.0.0.1:8214>:

```bash
npm run run
```

Check the browser console and watch for dialogs or requests that remain stuck
loading.
