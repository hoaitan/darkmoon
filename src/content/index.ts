import { normalizeDomain } from "../lib/domain";
import { isDomainIgnored, resolveEffectiveMode } from "../lib/mode-resolution";
import {
  addToIgnoreList,
  clearCacheEntry,
  getCacheEntry,
  getSettings,
  onSettingsChanged,
  setCacheEntry,
  setDomainOverride,
} from "../lib/storage";
import {
  calculateFilter,
  counterInvertFilterCSS,
  MEDIA_DIM_BRIGHTNESS_PERCENT,
  mediaFilterCSS,
  parseCssColor,
  relativeLightness,
} from "../lib/theme-engine";
import type { DarkmoonMessage, DarkmoonResponse } from "../lib/messages";
import type { Mode } from "../lib/types";
import { DARK_ISLAND_CLASS, MEDIA_ISLAND_CLASS, startIslandWatch, stopIslandWatch } from "./islands";
import { removeNotification, showNotification } from "./notification";

const domain = normalizeDomain(location.hostname);

let appliedCss: string | null = null;

/**
 * Upper bound on how long a first-visit sample waits on in-flight
 * stylesheets. Bounded rather than open-ended: some sites (e.g. github.com's
 * theme switcher) register a <link rel="stylesheet"> per selectable theme up
 * front but only ever give the active one a real `href`, leaving the rest
 * inert forever — those are filtered out below since they'll never fetch,
 * but this timeout is a second line of defense for any other link that
 * stalls or never fires load/error for reasons we haven't seen yet.
 */
const STYLESHEET_LOAD_TIMEOUT_MS = 2000;

/**
 * <body> existing isn't enough on its own: sites that ship their background
 * via an external stylesheet (common on docs frameworks like Astro/Starlight)
 * can have that <link> still in flight when <body> appears in the DOM, so a
 * sample taken right away reads the page's un-styled default (transparent)
 * instead of its real background — misclassifying an already-dark page as
 * light and inverting it. Wait for any stylesheet present at that point to
 * finish loading (or fail) before trusting a computed style read.
 *
 * Only links with a real `href` count as "in flight" — a <link
 * rel="stylesheet"> with no href (or an empty one) has nothing to fetch and
 * will never dispatch load or error, so waiting on it would hang forever.
 */
function whenStylesheetsLoaded(): Promise<void> {
  const pending = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).filter(
    (link) => !link.sheet && link.href,
  );
  if (pending.length === 0) return Promise.resolve();

  const allLoaded = new Promise<void>((resolve) => {
    let remaining = pending.length;
    const settle = (): void => {
      remaining -= 1;
      if (remaining <= 0) resolve();
    };
    for (const link of pending) {
      link.addEventListener("load", settle, { once: true });
      link.addEventListener("error", settle, { once: true });
    }
  });
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, STYLESHEET_LOAD_TIMEOUT_MS));

  return Promise.race([allLoaded, timeout]);
}

/**
 * Runs at document_start, before <body> parses — getComputedStyle on an
 * element that doesn't exist yet always reads as transparent, so a
 * first-visit lightness sample has to wait for the body to exist. Cached
 * (repeat-visit) filters skip this wait entirely to minimize flash-of-light.
 */
async function whenBodyReady(): Promise<void> {
  if (!document.body) {
    await new Promise<void>((resolve) => {
      document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
    });
  }
  await whenStylesheetsLoaded();
}

function samplePageLightness(): number {
  const candidates = [document.documentElement, document.body].filter((el): el is HTMLElement => el != null);
  for (const el of candidates) {
    const rgb = parseCssColor(getComputedStyle(el).backgroundColor);
    if (rgb && rgb.a > 0) return relativeLightness(rgb);
  }
  // No explicit background on html/body — the browser default is white.
  return 1;
}

// Single source of truth for the media tags the counter-invert/dim
// treatment applies to — reused for both the plain rule and the
// island-nested override rule so the two can't silently drift apart.
const MEDIA_TAGS = ["img", "video", "canvas", "picture", "svg image"];

function buildInjectedCss(filterCSS: string): string {
  const mediaFilter = mediaFilterCSS(MEDIA_DIM_BRIGHTNESS_PERCENT);
  const mediaSelector = MEDIA_TAGS.join(", ");
  const islandMediaOverrideSelector = [DARK_ISLAND_CLASS, MEDIA_ISLAND_CLASS]
    .flatMap((cls) => MEDIA_TAGS.map((tag) => `.${cls} ${tag}`))
    .join(",\n");

  // No explicit background-color override here: `filter` transforms
  // everything the element paints, including its own background-color, so
  // setting one here would get inverted right along with the filter and
  // produce the wrong result. Letting the page's real background (default
  // white if unset) run through the filter is what makes it come out dark.
  //
  // The two island rules below (`.darkmoon-island-*`) counter-invert
  // already-dark widgets and raster-background-image containers found by
  // islands.ts, so blanket inversion doesn't blow them out — see
  // classifyElementBackground's doc comment for why. The final override
  // rule resets *their* nested img/video/etc back to `none`: those already
  // get true colors for free once their island ancestor's filter cancels
  // the page filter, so leaving the plain media rule active on them would
  // apply a second, unwanted cancellation and re-invert them.
  return `html { filter: ${filterCSS} !important; }
${mediaSelector} { filter: ${mediaFilter} !important; }
.${DARK_ISLAND_CLASS} { filter: ${counterInvertFilterCSS()} !important; }
.${MEDIA_ISLAND_CLASS} { filter: ${mediaFilter} !important; }
${islandMediaOverrideSelector} { filter: none !important; }`;
}

async function applyCss(css: string): Promise<void> {
  if (appliedCss === css) return;
  const response = (await chrome.runtime.sendMessage({ type: "darkmoon/apply-css", css } satisfies DarkmoonMessage)) as
    DarkmoonResponse | undefined;
  if (response?.ok) {
    appliedCss = css;
    startIslandWatch();
  }
}

async function removeCss(): Promise<void> {
  if (!appliedCss) {
    stopIslandWatch();
    return;
  }
  const css = appliedCss;
  appliedCss = null;
  // Wait for the filter CSS to actually be gone before stripping island
  // marks: island elements have no styling of their own without their
  // `.darkmoon-island-*` class (it's what opts them out of the page filter),
  // so unmarking them first would flash them fully inverted for the
  // duration of this round-trip to the background worker.
  await chrome.runtime.sendMessage({ type: "darkmoon/remove-css", css } satisfies DarkmoonMessage);
  stopIslandWatch();
}

async function run(options: { isInitial: boolean; forceRecalculate?: boolean }): Promise<void> {
  const settings = await getSettings();

  if (isDomainIgnored(domain, settings.ignoreList)) {
    await removeCss();
    removeNotification();
    return;
  }

  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const action = resolveEffectiveMode({
    globalMode: settings.globalMode,
    domainOverride: settings.domainOverrides[domain],
    prefersDark,
  });

  if (action === "light") {
    await removeCss();
    removeNotification();
    return;
  }

  if (options.forceRecalculate) {
    await clearCacheEntry(domain);
  }

  let cacheEntry = await getCacheEntry(domain);
  if (!cacheEntry) {
    await whenBodyReady();
    const lightness = samplePageLightness();
    const { isAlreadyDark, filterCSS } = calculateFilter(lightness, settings.filterSettings);
    cacheEntry = { filterCSS, isAlreadyDark, computedAt: Date.now() };
    await setCacheEntry(domain, cacheEntry);
  }

  if (cacheEntry.isAlreadyDark) {
    await removeCss();
    return;
  }

  await applyCss(buildInjectedCss(cacheEntry.filterCSS));

  if (options.isInitial) {
    showNotification(domain, settings.domainOverrides[domain], settings.globalMode, {
      onModeSelect: (mode: Mode | null) => void setDomainOverride(domain, mode),
      onIgnore: () => void addToIgnoreList(domain),
    });
  }
}

void run({ isInitial: true });

// React to settings changing from another context (popup/options/another
// tab) while this page stays open — reapply, but don't re-show the
// notification, which is a page-load event per the design.
onSettingsChanged(() => void run({ isInitial: false }));

chrome.runtime.onMessage.addListener(
  (message: DarkmoonMessage, _sender, sendResponse: (r: DarkmoonResponse) => void) => {
    if (message.type === "darkmoon/recalculate") {
      void run({ isInitial: true, forceRecalculate: true }).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  },
);
