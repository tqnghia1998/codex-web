#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPath = path.join(rootDir, "dist/codex-web.js");
const START_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 10_000;

function fail(message) {
  throw new Error(message);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function trimLogs(logs) {
  return logs.trim().split(/\r?\n/).slice(-40).join("\n");
}

async function waitForServer(url, child, getLogs) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(
        `server exited early with code ${child.exitCode} signal ${child.signalCode}\n${trimLogs(getLogs())}`,
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  fail(`server did not start within ${START_TIMEOUT_MS}ms\n${trimLogs(getLogs())}`);
}

async function fetchText(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  return { response, text };
}

async function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeoutId = setTimeout(() => {
      socket.terminate();
      reject(new Error(`websocket timeout: ${url}`));
    }, STEP_TIMEOUT_MS);

    socket.once("open", () => {
      clearTimeout(timeoutId);
      socket.close();
      resolve(undefined);
    });

    socket.once("error", (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

async function main() {
  if (!(await fileExists(entryPath))) {
    fail(`missing ${path.relative(rootDir, entryPath)}; run npm run build first`);
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let logs = "";
  const child = spawn(process.execPath, [entryPath, "--port", String(port)], {
    cwd: rootDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const appendLogs = (chunk) => {
    logs = `${logs}${String(chunk)}`;
    if (logs.length > 20_000) {
      logs = logs.slice(-20_000);
    }
  };

  child.stdout?.on("data", appendLogs);
  child.stderr?.on("data", appendLogs);

  try {
    await waitForServer(`${baseUrl}/`, child, () => logs);

    const root = await fetchText(`${baseUrl}/`);
    if (!root.response.ok) {
      fail(`GET / returned ${root.response.status}`);
    }
    if (!root.response.headers.get("content-type")?.includes("text/html")) {
      fail(`GET / returned unexpected content-type: ${root.response.headers.get("content-type")}`);
    }
    if (!root.text.includes("<html")) {
      fail("GET / did not return html");
    }

    const preload = await fetch(`${baseUrl}/assets/preload.js`);
    if (!preload.ok) {
      fail(`GET /assets/preload.js returned ${preload.status}`);
    }
    const preloadType = preload.headers.get("content-type") || "";
    if (!preloadType.includes("javascript")) {
      fail(`GET /assets/preload.js returned unexpected content-type: ${preloadType}`);
    }
    if (preload.headers.get("access-control-allow-origin") !== "*") {
      fail("GET /assets/preload.js missing Access-Control-Allow-Origin: *");
    }
    await preload.arrayBuffer();

    const folder = encodeURIComponent("/tmp/codex-smoke");
    const deepLink = await fetchText(`${baseUrl}/?folder=${folder}`);
    if (!deepLink.response.ok) {
      fail(`GET /?folder=... returned ${deepLink.response.status}`);
    }
    if (!deepLink.text.includes("<html")) {
      fail("GET /?folder=... did not return html");
    }

    const form = new FormData();
    form.append(
      "files",
      new Blob(["codex smoke upload\n"], { type: "text/plain" }),
      "smoke.txt",
    );
    const upload = await fetch(`${baseUrl}/__backend/upload`, {
      method: "POST",
      body: form,
    });
    if (!upload.ok) {
      fail(`POST /__backend/upload returned ${upload.status}`);
    }
    const uploadJson = await upload.json();
    if (!Array.isArray(uploadJson.files) || uploadJson.files.length !== 1) {
      fail("POST /__backend/upload returned unexpected payload");
    }

    await openWebSocket(`ws://127.0.0.1:${port}/__backend/ipc`);

    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(
        `server exited during smoke test with code ${child.exitCode} signal ${child.signalCode}\n${trimLogs(logs)}`,
      );
    }

    console.log(`smoke ok: ${baseUrl}`);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
