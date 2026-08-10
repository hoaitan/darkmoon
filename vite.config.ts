import { defineConfig } from "vite";

// Two different things use Vite here:
//  - `vite --mode mock` (yarn dev:mocks) runs the plain dev server and
//    serves src/popup/index.html / src/options/index.html directly — no
//    extra config needed, defaults are enough.
//  - scripts/build.mjs calls Vite's build() API programmatically (with its
//    own inline config) to bundle those same pages for the real extension.
export default defineConfig({});
