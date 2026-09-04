import { classifyElementBackground } from "../lib/theme-engine";

/** Already-dark widgets: excluded from the page filter with a plain counter-invert. */
export const DARK_ISLAND_CLASS = "darkmoon-island-dark";
/** Raster-background-image containers: excluded with the dimmed media filter. */
export const MEDIA_ISLAND_CLASS = "darkmoon-island-media";

const ISLAND_CLASSES = [DARK_ISLAND_CLASS, MEDIA_ISLAND_CLASS];

// Not rendered / not worth classifying — descending into them wastes a
// getComputedStyle call for no visual payoff.
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "TITLE", "TEMPLATE", "NOSCRIPT", "HEAD"]);

/**
 * Hard ceiling on elements visited per scan so a pathological page (huge
 * DOM) can't turn island detection into a layout-thrashing stall — elements
 * past this cap simply keep whatever the page-level filter gives them, same
 * as before this feature existed.
 */
export const MAX_ELEMENTS_PER_SCAN = 20000;

// Elements we've marked, tracked directly rather than re-queried from the
// DOM on cleanup — a marked element can lose its class from under us (e.g. a
// framework re-render overwriting `className` wholesale), so a `document
// .querySelectorAll('.darkmoon-island-*')` sweep on stop wouldn't find it
// anyway; the set is the source of truth for "what did we touch."
const markedElements = new Set<Element>();

function isIsland(el: Element): boolean {
  return ISLAND_CLASSES.some((cls) => el.classList.contains(cls));
}

/**
 * Islands are meant to be small, self-contained widgets (a chat box, a code
 * block, a hero photo) — not page-level wrappers. A dark or background-image
 * classification on something covering most of the page is far more likely
 * a root/app-shell container (a loading-state background later covered by
 * real content, say) than a genuine widget. Marking it would stop the scan
 * from descending any further into it (see scanForIslands), silently
 * disabling media dimming for every image on the page — an app root wrapping
 * the whole document is exactly the shape of element that would otherwise
 * get caught here. The page-level `isAlreadyDark` check (already run before
 * any of this) is what's supposed to handle "the whole page is actually
 * dark" — this is just a backstop against that heuristic escaping its scope.
 */
const MAX_ISLAND_AREA_FRACTION = 0.5;

function isTooLargeToBeIsland(el: Element): boolean {
  const page = document.documentElement;
  const pageArea = page.scrollWidth * page.scrollHeight;
  if (pageArea <= 0) return false;
  const rect = el.getBoundingClientRect();
  return (rect.width * rect.height) / pageArea > MAX_ISLAND_AREA_FRACTION;
}

/**
 * Classifies one element and, if it's an island, marks it. Returns whether
 * the element is (now, or already was) an island — callers use this to
 * decide whether to keep descending.
 */
function classifyAndMark(el: Element): boolean {
  if (isIsland(el)) return true;
  const style = getComputedStyle(el);
  const kind = classifyElementBackground({
    backgroundColor: style.backgroundColor,
    backgroundImage: style.backgroundImage,
  });
  if (kind === null) return false;
  // Bounding-rect check comes after the (cheap) color check and is only
  // paid by the rare element that already looks like a candidate island —
  // getBoundingClientRect forces layout, so doing it for every scanned
  // element regardless of outcome would be needlessly expensive.
  if (isTooLargeToBeIsland(el)) return false;
  el.classList.add(kind === "dark" ? DARK_ISLAND_CLASS : MEDIA_ISLAND_CLASS);
  markedElements.add(el);
  return true;
}

/**
 * Walks `root`'s subtree looking for elements to exclude from the page-wide
 * invert filter. Stops descending as soon as it marks an element: everything
 * inside an island already renders with true colors for free (its filter
 * cancels the page filter — see buildInjectedCss's island override rules),
 * so re-classifying descendants would cancel it a second time and re-invert
 * them.
 */
export function scanForIslands(root: Node, remainingBudget = MAX_ELEMENTS_PER_SCAN): number {
  let remaining = remainingBudget;
  if (remaining <= 0) return remaining;

  if (root.nodeType === Node.ELEMENT_NODE) {
    const el = root as Element;
    if (!SKIP_TAGS.has(el.tagName)) {
      remaining -= 1;
      if (classifyAndMark(el)) return remaining;
    }
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (remaining <= 0) return NodeFilter.FILTER_REJECT;
      const el = node as Element;
      if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
      remaining -= 1;
      return classifyAndMark(el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) {
    // acceptNode already did the classification work for each visited node.
  }
  return remaining;
}

// Without a timeout, requestIdleCallback can be starved indefinitely on a
// continuously busy page (a chat app, an infinite-scroll feed) — MDN
// explicitly warns about this. A bound ensures island detection still runs,
// just possibly interrupting other work, instead of being deferred forever.
const IDLE_SCAN_TIMEOUT_MS = 1000;

function runIdle(work: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(work, { timeout: IDLE_SCAN_TIMEOUT_MS });
  } else {
    setTimeout(work, 0);
  }
}

let observer: MutationObserver | null = null;
let pendingNodes: Node[] = [];
let scanScheduled = false;

function flushPendingScan(): void {
  scanScheduled = false;
  const nodes = pendingNodes;
  pendingNodes = [];
  let budget = MAX_ELEMENTS_PER_SCAN;
  for (const node of nodes) {
    budget = scanForIslands(node, budget);
    if (budget <= 0) break;
  }
}

function scheduleScan(nodes: Iterable<Node>): void {
  // Plain push(...nodes) can blow V8's call-argument limit (~65k) when a
  // single bulk DOM operation (replaceChildren/innerHTML on a huge list)
  // reports tens of thousands of addedNodes in one MutationRecord.
  for (const node of nodes) pendingNodes.push(node);
  if (scanScheduled) return;
  scanScheduled = true;
  runIdle(flushPendingScan);
}

/**
 * Scans the current document once (idle-scheduled) and starts observing for
 * changes that could newly qualify (or disqualify) an element as an island —
 * covers content that renders after the initial paint (SPA hydration, lazy
 * sections, infinite scroll) that a one-shot scan would miss entirely, and
 * `class` reassignment on elements already in the DOM (e.g. a framework
 * re-render overwriting a widget's className to add/drop a dark-theme
 * class). Deliberately not watching `style`: inline style mutation is the
 * common vehicle for JS-driven animation (transform/opacity every frame),
 * and reclassifying on every one of those would be a real cost for a case
 * (inline-style theming) that's rare in practice.
 *
 * Runs from document_start on a cached repeat visit, so `<body>` may not
 * exist yet — nothing to scan up front in that case, but the observer below
 * (attached to <html>, which always exists) will pick up everything as it's
 * parsed in.
 */
export function startIslandWatch(): void {
  if (document.body) scheduleScan([document.body]);

  observer?.disconnect();
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) scheduleScan(mutation.addedNodes);
      if (mutation.type === "attributes") scheduleScan([mutation.target]);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
}

/** Undoes startIslandWatch: stops observing and strips every mark it made. */
export function stopIslandWatch(): void {
  observer?.disconnect();
  observer = null;
  pendingNodes = [];
  scanScheduled = false;
  for (const el of markedElements) {
    el.classList.remove(DARK_ISLAND_CLASS, MEDIA_ISLAND_CLASS);
  }
  markedElements.clear();
}
