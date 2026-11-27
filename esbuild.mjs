import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: { extension: "src/extension.ts", "cursor-hook": "src/cursorHook.ts" },
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outdir: "dist",
  external: ["vscode"],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: "info",
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
