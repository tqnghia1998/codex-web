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
const distAsarDir = path.join(distDir, "asar");
const distNodeModulesDir = path.join(distDir, "node_modules");

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

fs.cpSync(path.resolve("scratch/asar"), distAsarDir, { recursive: true });
for (const packageRoot of runtimePackageRoots) {
  const relativePackageRoot = path.relative(path.resolve("node_modules"), packageRoot);
  fs.cpSync(packageRoot, path.join(distNodeModulesDir, relativePackageRoot), {
    recursive: true,
  });
}

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
const path = require("node:path");

const distRoot = path.dirname(fs.realpathSync(process.argv[1]));
const serverPath = path.join(distRoot, "server.cjs");
const bundledAsarRoot = path.join(distRoot, "asar");
const bundledNodeModulesRoot = path.join(distRoot, "node_modules");

process.env.CODEX_ASAR_DIR = process.env.CODEX_ASAR_DIR || bundledAsarRoot;
process.env.NODE_PATH = process.env.NODE_PATH
  ? bundledNodeModulesRoot + path.delimiter + process.env.NODE_PATH
  : bundledNodeModulesRoot;
require("node:module").Module._initPaths();
require(serverPath);
`;

fs.writeFileSync(path.join(distDir, "codex-web.js"), wrapperSource);
fs.chmodSync(path.join(distDir, "codex-web.js"), 0o755);
