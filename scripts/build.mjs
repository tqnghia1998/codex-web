import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/server/main.ts"],
  outfile: "dist/codex-web.js",
  platform: "node",
  format: "cjs",
  packages: "bundle",
  sourcemap: false,
  banner: {
    js: `var require = typeof globalThis.require === "function"
  ? globalThis.require
  : process.getBuiltinModule?.("node:module")?.createRequire(process.argv[1]);
if (typeof require !== "function") {
  throw new Error("codex-web needs Node with require() or process.getBuiltinModule().");
}`,
  },
});
