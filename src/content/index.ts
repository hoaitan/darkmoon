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
import {
  DARK_ISLAND_CLASS,
  MEDIA_ISLAND_CLASS,
  MEDIA_NESTED_ISLAND_CLASS,
  startIslandWatch,
  stopIslandWatch,
} from "./islands";
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

/**
 * Appended to every selector below to win CSS specificity fights against a
 * host page's own `!important` rules on the same elements — real sites
 * routinely ship `!important` on classed img/media rules (e.g. a blur-up
 * loading-transition effect), and a plain type selector like `img` loses
 * that fight even with `!important` on our side too: when both sides are
 * `!important`, specificity (not `!important`-ness or source order) is the
 * tiebreaker, and a single class selector (0,1,0) already outranks a bare
 * type selector (0,0,1). `:not(#<id>)` on an id no real page uses adds
 * id-level specificity (1,0,0) without changing which elements match —
 * that beats any realistic combination of classes an author's rule could
 * use, short of that rule also using an id itself.
 */
const SPECIFICITY_BOOST = ":not(#darkmoon-specificity-boost)";

function buildInjectedCss(filterCSS: string): string {
  const mediaFilter = mediaFilterCSS(MEDIA_DIM_BRIGHTNESS_PERCENT);
  const mediaSelector = MEDIA_TAGS.map((tag) => `${tag}${SPECIFICITY_BOOST}`).join(", ");
  const overrideSelectorFor = (classes: string[]): string =>
    classes.flatMap((cls) => MEDIA_TAGS.map((tag) => `.${cls} ${tag}${SPECIFICITY_BOOST}`)).join(",\n");
  // A dark island applies no dim of its own (just a plain counter-invert),
  // so nested media needs its own single dim. A media/media-nested island
  // already applies the dim as part of its own filter, so nested media
  // inside *that* needs none of its own — see the comment below for why
  // both forms of nesting still land on exactly one dim overall.
  const darkIslandMediaOverride = overrideSelectorFor([DARK_ISLAND_CLASS]);
  const dimmedIslandMediaOverride = overrideSelectorFor([MEDIA_ISLAND_CLASS, MEDIA_NESTED_ISLAND_CLASS]);

  // The filter goes on <body>, not <html>. They're normally equivalent (body
  // fills the viewport too) but aren't always: some real sites (e.g. a
  // classic <body><center><table>-based layout, seen on news.ycombinator.com)
  // leave <html>/<body> without an explicit background of their own and size
  // <body> to its (narrower) content instead of the full viewport — and in
  // that shape, a `filter` on <html> was observed to leave the margin beyond
  // <body> painted as the browser's plain unfiltered white canvas instead of
  // inverting it, even though <html>'s own computed background/filter were
  // both correct. <body> doesn't have that gap. (This does mean the
  // notification host, mounted on <html> so it works even before <body>
  // exists, sits outside the filtered subtree now — see notification.ts.)
  //
  // No explicit background-color override here: `filter` transforms
  // everything the element paints, including its own background-color, so
  // setting one here would get inverted right along with the filter and
  // produce the wrong result. Letting the page's real background (default
  // white if unset) run through the filter is what makes it come out dark.
  //
  // The island rules below counter-invert already-dark widgets and
  // raster-background-image containers found by islands.ts, so blanket
  // inversion doesn't blow them out — see classifyElementBackground's doc
  // comment for why. `.darkmoon-island-media-nested` is the same idea one
  // level deeper: a background-image container *inside* an already-
  // cancelled zone (say, a photo panel inside a dark-themed app shell)
  // doesn't need — and mustn't get — a second counter-invert layered on
  // top of the one already in effect, just the dim; see islands.ts's
  // `classify` for the full reasoning.
  //
  // The two override blocks below give nested img/video/etc exactly one
  // dim no matter which kind of island it's inside: composed with the
  // *two* invert layers that cancel around it (its island ancestor's, and
  // body's), a dark island's plain counter-invert (no dim) needs the
  // override to supply the one dim itself, while a media island's filter
  // already *is* a dim, so the override there must supply none of its own
  // — supplying a second dim in that case would double it up.
  return `body { filter: ${filterCSS} !important; }
${mediaSelector} { filter: ${mediaFilter} !important; }
.${DARK_ISLAND_CLASS}${SPECIFICITY_BOOST} { filter: ${counterInvertFilterCSS()} !important; }
.${MEDIA_ISLAND_CLASS}${SPECIFICITY_BOOST} { filter: ${mediaFilter} !important; }
.${MEDIA_NESTED_ISLAND_CLASS}${SPECIFICITY_BOOST} { filter: brightness(${MEDIA_DIM_BRIGHTNESS_PERCENT}%) !important; }
${darkIslandMediaOverride} { filter: brightness(${MEDIA_DIM_BRIGHTNESS_PERCENT}%) !important; }
${dimmedIslandMediaOverride} { filter: none !important; }`;
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
