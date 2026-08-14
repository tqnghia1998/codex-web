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

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

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
const runtimePackageArchiveHash = createHash("sha256")
  .update(fs.readFileSync(runtimePackageArchivePath))
  .digest("hex")
  .slice(0, 16);

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
const bundledRuntimeNodeModulesArchivePath = path.join(distRoot, "runtime-node-modules.tgz");
const asarCacheRoot = path.join(os.tmpdir(), "codex-web-asar-${asarArchiveHash}");
const extractedAsarRoot = path.join(asarCacheRoot, "asar");
const runtimeCacheKey = process.versions.electron
  ? \`electron-\${process.versions.electron}-abi-\${process.versions.modules}\`
  : \`node-\${process.versions.node}-abi-\${process.versions.modules}\`;
const vendorCacheRoot = path.join(
  os.tmpdir(),
  \`codex-web-vendor-${runtimePackageArchiveHash}-\${runtimeCacheKey}\`,
);
const bundledNodeModulesRoot = path.join(vendorCacheRoot, "node_modules");
const bundledBetterSqlitePackageDir = path.join(bundledNodeModulesRoot, "better-sqlite3");
const bundledBetterSqlitePackageJson = path.join(bundledBetterSqlitePackageDir, "package.json");

function probeBetterSqlite3() {
  const Database = require(bundledBetterSqlitePackageDir);
  const db = new Database(":memory:");
  db.close();
}

function extractArchive(archivePath, destinationRoot) {
  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(destinationRoot, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", destinationRoot], {
    stdio: "inherit",
  });
}

function runNpm(args) {
  if (process.env.npm_execpath) {
    execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      stdio: "inherit",
    });
    return;
  }

  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    stdio: "inherit",
  });
}

function buildBetterSqliteRebuildArgs() {
  const args = [
    "rebuild",
    "better-sqlite3",
    "--foreground-scripts",
    "--dangerously-allow-all-scripts",
    "--prefix",
    vendorCacheRoot,
    "--loglevel=error",
  ];

  if (process.versions.electron) {
    args.push(
      "--runtime=electron",
      \`--target=\${process.versions.electron}\`,
      "--disturl=https://electronjs.org/headers",
    );
  }

  return args;
}

function ensureBetterSqlite3Binary() {
  try {
    probeBetterSqlite3();
    return;
  } catch (firstError) {
    fs.writeFileSync(
      path.join(vendorCacheRoot, "package.json"),
      JSON.stringify({ private: true }, null, 2) + "\\n",
    );
    runNpm(buildBetterSqliteRebuildArgs());
    try {
      probeBetterSqlite3();
      return;
    } catch (secondError) {
      throw new Error(
        [
          "Failed to prepare better-sqlite3 for the current Node runtime.",
          secondError instanceof Error ? secondError.stack || secondError.message : String(secondError),
          "Initial load error:",
          firstError instanceof Error ? firstError.stack || firstError.message : String(firstError),
        ].join("\\n\\n"),
      );
    }
  }
}

if (!fs.existsSync(path.join(extractedAsarRoot, "package.json"))) {
  extractArchive(bundledAsarArchivePath, asarCacheRoot);
}

if (!fs.existsSync(bundledBetterSqlitePackageJson)) {
  fs.mkdirSync(bundledNodeModulesRoot, { recursive: true });
  execFileSync("tar", ["-xzf", bundledRuntimeNodeModulesArchivePath, "-C", bundledNodeModulesRoot], {
    stdio: "inherit",
  });
}

ensureBetterSqlite3Binary();
process.env.CODEX_ASAR_DIR = process.env.CODEX_ASAR_DIR || extractedAsarRoot;
process.env.CODEX_VENDOR_NODE_MODULES_DIR = bundledNodeModulesRoot;
require(serverPath);
`;

fs.writeFileSync(path.join(distDir, "codex-web.js"), wrapperSource);
fs.chmodSync(path.join(distDir, "codex-web.js"), 0o755);
