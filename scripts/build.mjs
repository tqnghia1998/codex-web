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

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const buildRequire = createRequire(import.meta.url);

function collectPackageTree(packageName, seen = new Set()) {
  const packageJsonPath = buildRequire.resolve(`${packageName}/package.json`);
  if (seen.has(packageJsonPath)) {
    return [];
  }
  seen.add(packageJsonPath);

  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const dependencies = Object.keys(packageJson.dependencies ?? {});

  return [
    packageRoot,
    ...dependencies.flatMap((dependencyName) =>
      collectPackageTree(dependencyName, seen),
    ),
  ];
}

const runtimePackageRoots = collectPackageTree("better-sqlite3");
const runtimePackageArchiveEntries = runtimePackageRoots.map((packageRoot) =>
  path.relative(path.resolve("node_modules"), packageRoot),
);
const runtimePackageArchivePath = path.join(distDir, "runtime-node-modules.tgz");
execFileSync("tar", [
  "-chzf",
  runtimePackageArchivePath,
  "-C",
  "node_modules",
  ...runtimePackageArchiveEntries,
]);
const runtimePackageArchiveBuffer = fs.readFileSync(runtimePackageArchivePath);
fs.rmSync(runtimePackageArchivePath, { force: true });
const runtimePackageArchiveHash = createHash("sha256")
  .update(runtimePackageArchiveBuffer)
  .digest("hex")
  .slice(0, 16);

const asarArchivePath = path.join(distDir, "asar.tgz");
execFileSync("tar", ["-czf", asarArchivePath, "-C", "scratch", "asar"]);
const asarArchiveBuffer = fs.readFileSync(asarArchivePath);
fs.rmSync(asarArchivePath, { force: true });
const asarArchiveHash = createHash("sha256")
  .update(asarArchiveBuffer)
  .digest("hex")
  .slice(0, 16);

fs.writeFileSync(path.join(distDir, "server.cjs"), serverSource);
fs.writeFileSync(
  path.join(distDir, "vendor.cjs"),
  `module.exports = ${JSON.stringify({
    hash: runtimePackageArchiveHash,
    archiveBase64: runtimePackageArchiveBuffer.toString("base64"),
  })};\n`,
);
fs.writeFileSync(
  path.join(distDir, "asar.cjs"),
  `module.exports = ${JSON.stringify({
    hash: asarArchiveHash,
    archiveBase64: asarArchiveBuffer.toString("base64"),
  })};\n`,
);

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
const asar = require(path.join(distRoot, "asar.cjs"));
const vendor = require(path.join(distRoot, "vendor.cjs"));
const asarCacheRoot = path.join(os.tmpdir(), "codex-web-asar-" + asar.hash);
const extractedAsarRoot = path.join(asarCacheRoot, "asar");
const vendorCacheRoot = path.join(os.tmpdir(), "codex-web-vendor-" + vendor.hash);
const bundledNodeModulesRoot = path.join(vendorCacheRoot, "node_modules");
const bundledBetterSqlitePackageJson = path.join(
  bundledNodeModulesRoot,
  "better-sqlite3",
  "package.json",
);

if (!fs.existsSync(path.join(extractedAsarRoot, "package.json"))) {
  const archivePath = path.join(asarCacheRoot, "asar.tgz");
  fs.rmSync(asarCacheRoot, { recursive: true, force: true });
  fs.mkdirSync(asarCacheRoot, { recursive: true });
  fs.writeFileSync(archivePath, Buffer.from(asar.archiveBase64, "base64"));
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", asarCacheRoot], {
      stdio: "inherit",
    });
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

if (!fs.existsSync(bundledBetterSqlitePackageJson)) {
  const archivePath = path.join(vendorCacheRoot, "runtime-node-modules.tgz");
  fs.rmSync(vendorCacheRoot, { recursive: true, force: true });
  fs.mkdirSync(bundledNodeModulesRoot, { recursive: true });
  fs.writeFileSync(archivePath, Buffer.from(vendor.archiveBase64, "base64"));
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", bundledNodeModulesRoot], {
      stdio: "inherit",
    });
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

process.env.CODEX_ASAR_DIR = process.env.CODEX_ASAR_DIR || extractedAsarRoot;
process.env.NODE_PATH = process.env.NODE_PATH
  ? bundledNodeModulesRoot + path.delimiter + process.env.NODE_PATH
  : bundledNodeModulesRoot;
require("node:module").Module._initPaths();
require(serverPath);
`;

fs.writeFileSync(path.join(distDir, "codex-web.js"), wrapperSource);
fs.chmodSync(path.join(distDir, "codex-web.js"), 0o755);
