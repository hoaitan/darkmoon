// Regenerates the PNG icon set from src/assets/icons/icon.svg.
// Run with `yarn icons` whenever the source SVG changes; the PNGs are
// committed to the repo so this does not run as part of the normal build.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const ICONS_DIR = path.join(ROOT, "src/assets/icons");
const SIZES = [16, 32, 48, 128];

async function main() {
  const svg = await readFile(path.join(ICONS_DIR, "icon.svg"));

  await Promise.all(
    SIZES.map(async (size) => {
      const png = await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
      const outPath = path.join(ICONS_DIR, `icon-${size}.png`);
      await writeFile(outPath, png);
      console.log(`wrote ${path.relative(ROOT, outPath)}`);
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
