import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/sw.ts", "src/content.ts", "src/reader.ts", "src/popup.ts"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  logLevel: "info",
});

cpSync("static", "dist", { recursive: true });
cpSync("icons", "dist/icons", { recursive: true });
