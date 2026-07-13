import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/server/main.ts"],
  outfile: "dist/codex-web.js",
  platform: "node",
  format: "cjs",
  packages: "bundle",
  sourcemap: false,
});
