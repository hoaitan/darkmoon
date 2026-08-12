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
}

const FIXTURES: Fixture[] = [
  { name: "light-site", file: "light-site.html", expectDarkened: true },
  { name: "spa-like", file: "spa-like.html", expectDarkened: true },
  { name: "docs-site", file: "docs-site.html", expectDarkened: true },
  { name: "already-dark-site", file: "already-dark-site.html", expectDarkened: false },
  {
    name: "already-dark-external-css-site",
    file: "already-dark-external-css-site.html",
    expectDarkened: false,
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
  return page.evaluate(() => getComputedStyle(document.documentElement).filter);
}

async function notificationHostCount(page: Page): Promise<number> {
  return page.locator("#darkmoon-notification-host").count();
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

        if (fixture.expectDarkened) {
          check("page filter was applied", filter !== "none");
          check("notification was shown", notified);
        } else {
          check("page filter was skipped (already dark)", filter === "none");
          check("no notification shown for a no-op", !notified);
        }

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
