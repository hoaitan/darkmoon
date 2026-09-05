// Cross-site verification pass + PR screenshot capture (DAR-14).
//
// Loads the *actual built extension* into a persistent Chromium context
// (not a simulated filter), visits a representative fixture set, and:
//  - screenshots each site before/after Darkmoon runs
//  - asserts the filter/no-op decision matches expectations per fixture
//  - exercises the notification + Ignore flow end-to-end
//
// Run via `yarn capture`. Every UI/UX PR should re-run this and attach the
// resulting playwright/screenshots/*.png — see CONTRIBUTING.md.
import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { decodePng, getPixel, pixelLightness } from "./png-pixel";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const FIXTURES_DIR = path.join(ROOT, "playwright/fixtures");
const OUT_DIR = path.join(ROOT, "playwright/screenshots");
const PROFILE_DIR = path.join(ROOT, ".playwright-profile");

interface Fixture {
  name: string;
  file: string;
  /** Whether Darkmoon is expected to darken this page. */
  expectDarkened: boolean;
  /** Fixture-specific assertions beyond the generic filter/notification checks. */
  extraChecks?: (page: Page) => Promise<void>;
}

const FIXTURES: Fixture[] = [
  {
    // DAR-17: a real pixel check, not just a computed-style one — see
    // pixelLightnessAt's doc comment. (5, 650) is well below this fixture's
    // short content and clear of the bottom-right notification: a "gap"
    // relying on the page's own background rather than any specific
    // element's, exactly the region the canvas-background-propagation bug
    // left un-inverted despite <body>'s own filter reading back correct.
    name: "light-site",
    file: "light-site.html",
    expectDarkened: true,
    extraChecks: async (page) => {
      const lightness = await pixelLightnessAt(page, 5, 650);
      check(
        "background in the empty gap below the content is actually dark, not just declared as such",
        lightness < 60,
      );
    },
  },
  { name: "spa-like", file: "spa-like.html", expectDarkened: true },
  { name: "docs-site", file: "docs-site.html", expectDarkened: true },
  {
    // DAR-18: an already-dark site keeps its own colors — no page filter — but
    // its photos now get a brightness dim so they don't glare against it.
    // Brightness only: there is no page filter to cancel, so an invert here
    // would turn every photo into a negative.
    name: "already-dark-site",
    file: "already-dark-site.html",
    expectDarkened: false,
    extraChecks: async (page) => {
      const photoFilter = await page.evaluate(
        () => getComputedStyle(document.querySelector(".dark-photo") as Element).filter,
      );
      check("photo on an already-dark page is dimmed", photoFilter.includes("brightness"));
      check("photo on an already-dark page is not inverted", !photoFilter.includes("invert"));
      check("photo on an already-dark page is not hue-rotated", !photoFilter.includes("hue-rotate"));

      const bodyFilter = await page.evaluate(() => getComputedStyle(document.body).filter);
      check("already-dark page itself is left completely alone", bodyFilter === "none");
    },
  },
  {
    name: "already-dark-external-css-site",
    file: "already-dark-external-css-site.html",
    expectDarkened: false,
  },
  {
    name: "already-dark-inert-stylesheet-site",
    file: "already-dark-inert-stylesheet-site.html",
    expectDarkened: false,
  },
  {
    // DAR-18: an already-dark embedded widget on an otherwise light page is
    // now inverted along with everything else and comes out light. Knowingly
    // accepted: one flag governs the whole document, and exempting a widget
    // requires the per-element classification that flag replaced. Kept as a
    // fixture so the screenshot records what it looks like.
    name: "already-dark-widget-site",
    file: "already-dark-widget-site.html",
    expectDarkened: true,
    extraChecks: async (page) => {
      const widgetFilter = await page.evaluate(
        () => getComputedStyle(document.querySelector(".widget") as Element).filter,
      );
      check("embedded dark widget gets no filter of its own — the page filter governs it", widgetFilter === "none");
    },
  },
  {
    // DAR-18: every <img> on a darkened page gets exactly one counter-invert,
    // however it is wrapped. A <picture> parent used to add a second one.
    name: "images-site",
    file: "images-site.html",
    expectDarkened: true,
    extraChecks: async (page) => {
      const filters = await page.evaluate(() =>
        [".standalone-photo", ".hero-photo", ".picture-photo"].map((sel) => ({
          sel,
          filter: getComputedStyle(document.querySelector(sel) as Element).filter,
        })),
      );
      for (const { sel, filter } of filters) {
        check(`${sel} gets its own dimmed counter-invert filter`, filter.includes("invert"));
        check(`${sel} is inverted exactly once, not stacked`, (filter.match(/invert\(/g) ?? []).length === 1);
      }

      // The <picture> wrapper itself must contribute nothing — it paints no
      // pixels of its own, and filtering it double-inverts the <img> inside.
      const pictureFilter = await page.evaluate(
        () => getComputedStyle(document.querySelector("picture") as Element).filter,
      );
      check("<picture> wrapper gets no filter of its own", pictureFilter === "none");

      // Knowingly accepted with island removal: a CSS background-image is not
      // a replaced element, so no blanket selector can reach it and it renders
      // color-inverted. Asserted so the regression is deliberate, not silent.
      const heroBackgroundFilter = await page.evaluate(
        () => getComputedStyle(document.querySelector(".hero") as Element).filter,
      );
      check("background-image container is knowingly left to the page filter", heroBackgroundFilter === "none");
    },
  },
  {
    // DAR-18: a root app-shell wrapper with its own opaque dark background
    // (common in real SPAs — see abc.net.au). html/body are still light, so
    // the site-wide flag says "light" and the wrapper inverts with everything
    // else. Nothing special happens to it or to the photo inside, which is the
    // point: no per-element decision is made anywhere on the page.
    name: "full-page-dark-wrapper-site",
    file: "full-page-dark-wrapper-site.html",
    expectDarkened: true,
    extraChecks: async (page) => {
      const wrapperFilter = await page.evaluate(
        () => getComputedStyle(document.querySelector("#app-wrapper") as Element).filter,
      );
      check("app-shell wrapper gets no filter of its own", wrapperFilter === "none");

      const photoFilter = await page.evaluate(
        () => getComputedStyle(document.querySelector(".photo") as Element).filter,
      );
      check("photo inside the wrapper gets one counter-invert", (photoFilter.match(/invert\(/g) ?? []).length === 1);
    },
  },
  {
    // DAR-17: a classic <body><center><table>-based layout (news.ycombinator
    // .com) where html/body never paint a background of their own. The
    // margin beyond the (narrower-than-viewport) centered table used to
    // stay the browser's plain unfiltered white canvas — a real rendering
    // gap (the CSS canvas-background-propagation paint layer) that
    // getComputedStyle alone can't see, since it read back correct the
    // whole time; only an actual pixel check catches it. See
    // buildInjectedCss's comment in src/content/index.ts for the fix.
    name: "narrow-centered-table-site",
    file: "narrow-centered-table-site.html",
    expectDarkened: true,
    extraChecks: async (page) => {
      // The table is 500px wide, centered in a 1280px viewport — (20, 50)
      // is well inside the left margin beyond it, at a height the table
      // itself spans.
      const lightness = await pixelLightnessAt(page, 20, 50);
      check("the margin beyond the centered table is actually dark, not the unfiltered canvas", lightness < 60);
    },
  },
  {
    // DAR-17: real news sites are full of ad/tracker iframes. The content
    // script only ran in the top frame before this fixture existed —
    // manifest.json now sets all_frames: true so it runs inside every
    // frame too, otherwise an iframe's own images render fully color-
    // inverted with no correction at all (the top page's filter still
    // visually composites over embedded frames regardless of whether
    // anything is running inside them to counter it). This same-origin
    // iframe stands in for that case — cross-origin ad iframes work the
    // same way given <all_urls> host permissions, which this project can't
    // easily fixture (would need a real second origin).
    name: "iframe-embed-site",
    file: "iframe-embed-site.html",
    expectDarkened: true,
    extraChecks: async (page) => {
      await page.waitForTimeout(500); // iframe's own content script + css application
      const frame = page.frames().find((f) => f.url().includes("iframe-embed-content.html"));
      if (!frame) {
        check("found the embedded iframe's own frame", false);
        return;
      }

      // The iframe's own document is just a normal page from its own point
      // of view — its .iframe-photo getting the standard dimmed-media
      // filter (already covered by images-site's assertions) means its
      // *internal* rendering is self-consistently correct on its own.
      // What's specific to this fixture is the <iframe> tag itself, as seen
      // from the PARENT page: it's a replaced element the parent's own
      // filter composites over, so it needs the same counter-invert
      // treatment as an unhandled <img> would — checked from the parent,
      // not from inside the frame (the frame's own filter string will
      // always mention "invert" as part of its own normal media rule,
      // which doesn't say anything about the final composited result).
      const iframeElementFilter = await page.evaluate(
        () => getComputedStyle(document.querySelector("iframe") as Element).filter,
      );
      check("the <iframe> element itself is counter-inverted from the parent's side", iframeElementFilter !== "none");
      check(
        "the <iframe> counter-invert has no dim of its own (the frame dims its own content already)",
        !iframeElementFilter.includes("brightness"),
      );

      const notificationInFrame = await frame.evaluate(
        () => document.getElementById("darkmoon-notification-host") !== null,
      );
      check("no duplicate notification created inside the iframe", !notificationInFrame);
    },
  },
];

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

interface FixtureServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Chrome content scripts don't inject into file:// pages by default even
 * with <all_urls> in the manifest — file access needs a separate,
 * non-scriptable opt-in per extension. Serving fixtures over local HTTP
 * sidesteps that entirely and is a closer match to real websites anyway.
 */
/**
 * Real docs sites (Astro/Starlight, etc.) ship their dark background via an
 * external stylesheet fetched over the network, not an inline <style> block —
 * see already-dark-external-css-site.html. Delaying .css responses here
 * reproduces that fetch latency deterministically instead of relying on
 * incidental localhost timing.
 */
const CSS_RESPONSE_DELAY_MS = 150;

async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const requestPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    const filePath = path.join(FIXTURES_DIR, requestPath);
    if (!filePath.startsWith(FIXTURES_DIR)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      const isCss = filePath.endsWith(".css");
      const respond = (): void => {
        const contentType = isCss ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
        res.writeHead(200, { "Content-Type": contentType }).end(data);
      };
      if (isCss) {
        setTimeout(respond, CSS_RESPONSE_DELAY_MS);
      } else {
        respond();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function pageFilter(page: Page): Promise<string> {
  // The page-wide filter lives on <body>, not <html> — see buildInjectedCss.
  return page.evaluate(() => getComputedStyle(document.body).filter);
}

async function notificationHostCount(page: Page): Promise<number> {
  return page.locator("#darkmoon-notification-host").count();
}

/**
 * Reads the ACTUAL rendered pixel at (x, y), not a computed-style value —
 * see png-pixel.ts's doc comment for why this matters: DAR-17 found a real
 * gap between the two (the CSS canvas-background-propagation paint layer),
 * where computed style read back correct while the pixels themselves still
 * showed the page's un-inverted original color.
 */
async function pixelLightnessAt(page: Page, x: number, y: number): Promise<number> {
  const buf = await page.screenshot();
  const img = decodePng(buf);
  return pixelLightness(getPixel(img, x, y));
}

async function clickIgnoreInNotification(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.getElementById("darkmoon-notification-host");
    const button = host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-role="ignore"]');
    button?.click();
  });
}

function getExtensionId(context: BrowserContext): string {
  const worker = context.serviceWorkers()[0];
  const match = worker?.url().match(/^chrome-extension:\/\/([^/]+)\//);
  if (!match?.[1]) throw new Error("could not determine extension id — background service worker not registered");
  return match[1];
}

/**
 * The theme cache is keyed by domain, and every fixture here is served from
 * 127.0.0.1 (macOS sandboxes can't bind extra loopback aliases without
 * sudo, so distinct per-fixture hostnames aren't available) — so without
 * this, whichever fixture loads first would poison the cache for the rest.
 * Real distinct websites wouldn't need this; it's purely a test fixture.
 */
async function clearThemeCache(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.evaluate(() => chrome.storage.local.remove("themeCache"));
  await page.close();
}

/**
 * A page that never finishes background-sampling (e.g. stuck waiting on a
 * stylesheet link that will never fire load/error) never writes a cache
 * entry — it also never applies a filter, which looks identical to a
 * correctly-detected already-dark no-op from `pageFilter()` alone. This
 * distinguishes the two: no entry means detection hung, not that it succeeded.
 */
async function themeCacheHasEntry(context: BrowserContext, extensionId: string, domain: string): Promise<boolean> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const hasEntry = await page.evaluate(async (d) => {
    const store = (await chrome.storage.local.get("themeCache")) as { themeCache?: Record<string, unknown> };
    return Boolean(store.themeCache?.[d]);
  }, domain);
  await page.close();
  return hasEntry;
}

function buildExtension(): void {
  console.log("[darkmoon] building extension for verification…");
  execSync("node scripts/build.mjs", { cwd: ROOT, stdio: "inherit" });
}

async function withPlainContext(fn: (context: BrowserContext) => Promise<void>): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ colorScheme: "dark" });
  try {
    await fn(context);
  } finally {
    await browser.close();
  }
}

async function withExtensionContext(fn: (context: BrowserContext) => Promise<void>): Promise<void> {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    // Playwright's `headless: true` maps Chromium to a mode that silently
    // no-ops --load-extension. The documented workaround is `headless:
    // false` (so Playwright doesn't intervene) combined with an explicit
    // `--headless=new` arg, which Chromium's new headless mode does support
    // for extensions and needs no real display/window server.
    headless: false,
    colorScheme: "dark",
    args: ["--headless=new", `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--no-first-run"],
  });
  try {
    // Give the service worker a moment to install before the first fixture navigates.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fn(context);
  } finally {
    await context.close();
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  buildExtension();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const fixtureServer = await startFixtureServer();
  const fixtureUrl = (file: string): string => `${fixtureServer.baseUrl}/${file}`;

  try {
    console.log("\n[darkmoon] capturing 'before' screenshots (no extension)…");
    await withPlainContext(async (context) => {
      for (const fixture of FIXTURES) {
        const page = await context.newPage();
        await page.goto(fixtureUrl(fixture.file));
        await page.screenshot({ path: path.join(OUT_DIR, `${fixture.name}-before.png`) });
        await page.close();
      }
    });

    console.log(
      "\n[darkmoon] capturing 'after' screenshots + assertions (extension loaded, prefers-color-scheme: dark)…",
    );
    await withExtensionContext(async (context) => {
      const extensionId = getExtensionId(context);

      for (const fixture of FIXTURES) {
        console.log(`\n${fixture.name}:`);
        await clearThemeCache(context, extensionId);
        const page = await context.newPage();
        await page.goto(fixtureUrl(fixture.file));
        // Content script + one storage round-trip; generous but bounded wait.
        await page.waitForTimeout(400);

        const filter = await pageFilter(page);
        const notified = (await notificationHostCount(page)) > 0;

        check("detection completed (didn't hang)", await themeCacheHasEntry(context, extensionId, "127.0.0.1"));

        if (fixture.expectDarkened) {
          check("page filter was applied", filter !== "none");
          check("notification was shown", notified);
        } else {
          check("page filter was skipped (already dark)", filter === "none");
          check("no notification shown for a no-op", !notified);
        }

        await fixture.extraChecks?.(page);

        await page.screenshot({ path: path.join(OUT_DIR, `${fixture.name}-after.png`) });
        await page.close();
      }

      console.log("\nignore flow (light-site):");
      await clearThemeCache(context, extensionId);
      const page = await context.newPage();
      await page.goto(fixtureUrl("light-site.html"));
      await page.waitForTimeout(400);
      check("notification present before ignoring", (await notificationHostCount(page)) > 0);

      await clickIgnoreInNotification(page);
      await page.waitForTimeout(300);
      check("filter removed immediately after Ignore", (await pageFilter(page)) === "none");
      await page.screenshot({ path: path.join(OUT_DIR, "light-site-after-ignore.png") });

      await page.reload();
      await page.waitForTimeout(400);
      check("stays un-themed on reload after being ignored", (await pageFilter(page)) === "none");
      check("no notification on an ignored domain", (await notificationHostCount(page)) === 0);
      await page.close();
    });
  } finally {
    await fixtureServer.close();
  }

  console.log(`\n[darkmoon] screenshots written to ${path.relative(ROOT, OUT_DIR)}/`);

  if (failures > 0) {
    console.error(`\n[darkmoon] ${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\n[darkmoon] all checks passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
