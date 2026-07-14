import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const serverBuild = await build({
  bundle: true,
  entryPoints: ["src/server/main.ts"],
  platform: "node",
  format: "cjs",
  packages: "bundle",
  sourcemap: false,
  write: false,
});

const serverSource = serverBuild.outputFiles[0]?.text;
if (!serverSource) {
  throw new Error("failed to build server bundle");
}

fs.mkdirSync("dist", { recursive: true });

const archivePath = path.join("dist", "codex-web.asar.tgz");
execFileSync("tar", ["-czf", archivePath, "-C", "scratch", "asar"]);
const archiveBuffer = fs.readFileSync(archivePath);
fs.rmSync(archivePath, { force: true });

const buildHash = createHash("sha256")
  .update(serverSource)
  .update(archiveBuffer)
  .digest("hex")
  .slice(0, 16);

const requireShim = `var require = typeof globalThis.require === "function"
  ? globalThis.require
  : process.getBuiltinModule?.("node:module")?.createRequire(process.argv[1]);
if (typeof require !== "function") {
  throw new Error("codex-web needs Node with require() or process.getBuiltinModule().");
}`;

const wrapperSource = `#!/usr/bin/env node
${requireShim}
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const buildHash = ${JSON.stringify(buildHash)};
const serverSource = ${JSON.stringify(serverSource)};
const archiveBase64 = ${JSON.stringify(archiveBuffer.toString("base64"))};

const cacheRoot = path.join(os.tmpdir(), "codex-web-bundle-" + buildHash);
const serverPath = path.join(cacheRoot, "server.cjs");
const embeddedAsarRoot = path.join(cacheRoot, "asar");
const resolvedAsarRoot = process.env.CODEX_ASAR_DIR || embeddedAsarRoot;

fs.mkdirSync(cacheRoot, { recursive: true });
if (!fs.existsSync(serverPath)) {
  fs.writeFileSync(serverPath, serverSource);
}

if (!process.env.CODEX_ASAR_DIR && !fs.existsSync(path.join(embeddedAsarRoot, "package.json"))) {
  const archivePath = path.join(cacheRoot, "asar.tgz");
  fs.rmSync(embeddedAsarRoot, { recursive: true, force: true });
  fs.writeFileSync(archivePath, Buffer.from(archiveBase64, "base64"));
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", cacheRoot]);
  } catch (error) {
    throw new Error(
      "Failed to extract embedded Codex assets with tar. " +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

process.env.CODEX_ASAR_DIR = resolvedAsarRoot;

const child = spawn(process.execPath, [serverPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
`;

fs.writeFileSync("dist/codex-web.js", wrapperSource);
fs.chmodSync("dist/codex-web.js", 0o755);
