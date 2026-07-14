import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
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

const distDir = path.resolve("dist");
const stagedAsarRoot = path.resolve("scratch/asar");

function resolveElectronMainEntry(asarRoot) {
  const buildDirectory = path.join(asarRoot, ".vite/build");
  const matches = fs.readdirSync(buildDirectory).filter((name) =>
    /^main-.+\.js$/.test(name),
  );

  if (matches.length === 0) {
    throw new Error(`no main bundle found in ${buildDirectory}`);
  }

  if (matches.length > 1) {
    throw new Error(`multiple main bundles found in ${buildDirectory}`);
  }

  return path.join(buildDirectory, matches[0]);
}

function assertStagedNativeModules(asarRoot) {
  const mainEntryPath = resolveElectronMainEntry(asarRoot);
  try {
    createRequire(mainEntryPath).resolve("better-sqlite3");
  } catch (error) {
    throw new Error(
      [
        `staged app cannot resolve better-sqlite3 from ${mainEntryPath}.`,
        "Run npm run setup, or point CODEX_ASAR_DIR at a prepared scratch/asar directory.",
        error instanceof Error ? error.message : String(error),
      ].join(" "),
    );
  }
}

assertStagedNativeModules(stagedAsarRoot);

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const asarArchivePath = path.join(distDir, "asar.tgz");
execFileSync("tar", ["-czf", asarArchivePath, "-C", "scratch", "asar"]);
const asarArchiveHash = createHash("sha256")
  .update(fs.readFileSync(asarArchivePath))
  .digest("hex")
  .slice(0, 16);

fs.writeFileSync(path.join(distDir, "server.cjs"), serverSource);

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
const { execFileSync } = require("node:child_process");

const distRoot = path.dirname(fs.realpathSync(process.argv[1]));
const serverPath = path.join(distRoot, "server.cjs");
const bundledAsarArchivePath = path.join(distRoot, "asar.tgz");
const asarCacheRoot = path.join(os.tmpdir(), "codex-web-asar-${asarArchiveHash}");
const extractedAsarRoot = path.join(asarCacheRoot, "asar");

if (!fs.existsSync(path.join(extractedAsarRoot, "package.json"))) {
  fs.rmSync(asarCacheRoot, { recursive: true, force: true });
  fs.mkdirSync(asarCacheRoot, { recursive: true });
  execFileSync("tar", ["-xzf", bundledAsarArchivePath, "-C", asarCacheRoot], {
    stdio: "inherit",
  });
}

process.env.CODEX_ASAR_DIR = process.env.CODEX_ASAR_DIR || extractedAsarRoot;
require(serverPath);
`;

fs.writeFileSync(path.join(distDir, "codex-web.js"), wrapperSource);
fs.chmodSync(path.join(distDir, "codex-web.js"), 0o755);
