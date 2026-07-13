# codex-web

a browser frontend for codex desktop, running on a machine you control.

https://github.com/user-attachments/assets/0a33cbd8-741c-412c-9e75-46dfe9324596

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of agents to your local computer, where your
files, credentials, and tools already live.

codex-web brings Codex Desktop to a local browser while keeping the backend on
the same Mac. agents keep running after the browser closes, and you can
reconnect from any browser on that machine.

this project aims to be as thin a wrapper as possible to ensure upstream changes
to the codex desktop app can be integrated quickly.

## usage

`codex-web` serves the browser client and hosts the desktop-side bridge. by
default, it listens on `127.0.0.1:8214`.

it will use `codex` from `PATH` if available, or `CODEX_CLI_PATH` if you set
it.

The build uses the installed Codex Desktop app as its source. By default it
expects `/Applications/ChatGPT.app` and reads only
`Contents/Resources/app.asar`; the installed app itself is not started.

```bash
npm install && npm run setup
npm run run
```

Set `CODEX_APP_DIR` when the app is installed elsewhere:

```bash
CODEX_APP_DIR="/Applications/Codex.app" npm install && \
  CODEX_APP_DIR="/Applications/Codex.app" npm run setup
npm run run
```

Then open <http://127.0.0.1:8214> in a browser. To open a folder directly, URL-encode
its path:

```text
http://127.0.0.1:8214/?folder=%2FUsers%2Fme%2FCode%2Fproject
```

### sign in

ensure the codex cli on the host machine is signed in before starting the
server.

```bash
codex login --device-auth
```

## security

The server binds to `127.0.0.1` and has no authentication. Do not expose it
through a network proxy.

Someone with access to the web UI may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

## features

- runs locally on macOS
- reachable from a local browser
- thin wrapper, so updates should land fast
- working today:
  - subagents
  - inline images
  - editor sidepanel
  - transcription

## roadmap

some parts of the desktop experience are not wired up yet:

- browser panel support, likely rebuilt around iframes
- terminal support
- git worker integration
- whatever else people find and file issues for

## issues welcome

if something is broken, missing, or rough around the edges, please file an
issue.

using `codex-web` in an interesting way? post about it on x and tag me
[@0xcaff](https://x.com/0xcaff).

using this at a company and need something more tailored? email me and we can
talk.
