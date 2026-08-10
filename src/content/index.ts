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
import { calculateFilter, counterInvertFilterCSS, parseCssColor, relativeLightness } from "../lib/theme-engine";
import type { DarkmoonMessage, DarkmoonResponse } from "../lib/messages";
import type { Mode } from "../lib/types";
import { removeNotification, showNotification } from "./notification";

const domain = normalizeDomain(location.hostname);

let appliedCss: string | null = null;

/**
 * Runs at document_start, before <body> parses — getComputedStyle on an
 * element that doesn't exist yet always reads as transparent, so a
 * first-visit lightness sample has to wait for the body to exist. Cached
 * (repeat-visit) filters skip this wait entirely to minimize flash-of-light.
 */
function whenBodyReady(): Promise<void> {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
  });
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

function buildInjectedCss(filterCSS: string): string {
  // No explicit background-color override here: `filter` transforms
  // everything the element paints, including its own background-color, so
  // setting one here would get inverted right along with the filter and
  // produce the wrong result. Letting the page's real background (default
  // white if unset) run through the filter is what makes it come out dark.
  return `html { filter: ${filterCSS} !important; }
img, video, canvas, picture, svg image { filter: ${counterInvertFilterCSS()} !important; }`;
}

async function applyCss(css: string): Promise<void> {
  if (appliedCss === css) return;
  const response = (await chrome.runtime.sendMessage({ type: "darkmoon/apply-css", css } satisfies DarkmoonMessage)) as
    DarkmoonResponse | undefined;
  if (response?.ok) appliedCss = css;
}

async function removeCss(): Promise<void> {
  if (!appliedCss) return;
  const css = appliedCss;
  appliedCss = null;
  await chrome.runtime.sendMessage({ type: "darkmoon/remove-css", css } satisfies DarkmoonMessage);
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
