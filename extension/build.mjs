import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(repositoryRoot, "dist", "extension");

if (!outputDirectory.startsWith(path.join(repositoryRoot, "dist") + path.sep)) {
  throw new Error("Refusing to clean an extension output outside dist");
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  absWorkingDir: repositoryRoot,
  entryPoints: {
    background: "extension/src/background.ts",
    content: "extension/src/content.ts",
    "main-world": "extension/src/main-world.ts",
    popup: "extension/src/popup.ts"
  },
  outdir: outputDirectory,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  charset: "utf8"
});

await cp(path.join(repositoryRoot, "extension", "manifest.json"), path.join(outputDirectory, "manifest.json"));
await cp(path.join(repositoryRoot, "extension", "popup.html"), path.join(outputDirectory, "popup.html"));
