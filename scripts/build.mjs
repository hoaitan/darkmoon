#!/usr/bin/env node
// Builds the unpacked extension into dist/. Background and content scripts
// must ship as single files with no runtime imports (MV3 content scripts
// can't use ES modules the way extension pages can), so they're bundled
// with esbuild directly; popup.html/options.html are normal multi-page Vite
// apps. --watch rebuilds both on change for loading dist/ as an unpacked
// extension in chrome://extensions.
import { context as esbuildContext, build as esbuildBuild } from "esbuild";
import { build as viteBuild } from "vite";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const WATCH = process.argv.includes("--watch");

const PAGES = [
  { entry: "src/popup/index.html", out: "popup.html" },
  { entry: "src/options/index.html", out: "options.html" },
];

async function clean() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
}

function esbuildOptions(entry, outfile, format) {
  return {
    entryPoints: [path.join(ROOT, entry)],
    outfile: path.join(DIST, outfile),
    bundle: true,
    sourcemap: true,
    target: "chrome111",
    format,
    logLevel: "info",
  };
}

async function buildScript(entry, outfile, format) {
  const options = esbuildOptions(entry, outfile, format);
  if (!WATCH) {
    await esbuildBuild(options);
    return;
  }
  const ctx = await esbuildContext(options);
  await ctx.watch();
}

async function flattenPageOutput() {
  for (const { entry, out } of PAGES) {
    const from = path.join(DIST, entry);
    const to = path.join(DIST, out);
    try {
      await rename(from, to);
    } catch (err) {
      console.warn(`[darkmoon] could not flatten ${entry} → ${out}:`, err.message);
    }
  }
  await rm(path.join(DIST, "src"), { recursive: true, force: true });
}

async function copyManifestAndIcons() {
  await cp(path.join(ROOT, "manifest.json"), path.join(DIST, "manifest.json"));
  const iconsOutDir = path.join(DIST, "icons");
  await mkdir(iconsOutDir, { recursive: true });
  const iconsSrcDir = path.join(ROOT, "src/assets/icons");
  const files = await readdir(iconsSrcDir);
  await Promise.all(
    files.filter((f) => f.endsWith(".png")).map((f) => cp(path.join(iconsSrcDir, f), path.join(iconsOutDir, f))),
  );
}

function viteInlineConfig() {
  return {
    root: ROOT,
    configFile: false,
    logLevel: "info",
    build: {
      outDir: "dist",
      emptyOutDir: false,
      sourcemap: true,
      rollupOptions: {
        input: Object.fromEntries(
          PAGES.map(({ entry }) => [path.basename(path.dirname(entry)), path.join(ROOT, entry)]),
        ),
      },
      watch: WATCH ? {} : null,
    },
  };
}

async function buildPages() {
  if (!WATCH) {
    await viteBuild(viteInlineConfig());
    await flattenPageOutput();
    return;
  }

  const watcher = await viteBuild(viteInlineConfig());
  watcher.on("event", (event) => {
    if (event.code === "END") void flattenPageOutput();
    if (event.code === "ERROR") console.error("[darkmoon] vite watch error:", event.error);
  });
}

async function main() {
  await clean();
  await Promise.all([
    buildScript("src/background/index.ts", "background.js", "esm"),
    buildScript("src/content/index.ts", "content.js", "iife"),
    buildPages(),
  ]);
  await copyManifestAndIcons();

  if (WATCH) {
    console.log(
      "\n[darkmoon] watching for changes — load the unpacked dist/ folder via chrome://extensions and reload the extension after each rebuild.\n",
    );
  } else {
    console.log("[darkmoon] build complete → dist/");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
