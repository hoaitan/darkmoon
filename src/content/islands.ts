import { classifyElementBackground } from "../lib/theme-engine";

/** Already-dark widgets: excluded from the page filter with a plain counter-invert. */
export const DARK_ISLAND_CLASS = "darkmoon-island-dark";
/** Raster-background-image containers, first one found on a light page: counter-inverted and dimmed. */
export const MEDIA_ISLAND_CLASS = "darkmoon-island-media";
/** A background-image container found *inside* an already-cancelled zone: needs only the dim, not another cancel. */
export const MEDIA_NESTED_ISLAND_CLASS = "darkmoon-island-media-nested";

export const ALL_ISLAND_CLASSES = [DARK_ISLAND_CLASS, MEDIA_ISLAND_CLASS, MEDIA_NESTED_ISLAND_CLASS];

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

/**
 * `"normal"`: still subject to the page-level invert filter, same as
 * anything outside an island.
 * `"cancelled"`: an ancestor's own filter has already cancelled the page
 * filter for this subtree (its content renders at its true colors for
 * free) — entering this state once means never needing to leave it: a
 * dim-only filter (the only thing a nested media element gets) doesn't
 * invert anything, so it can't change that back.
 */
type Zone = "normal" | "cancelled";

/**
 * Classifies one element against its current zone and marks it if needed.
 * Returns the zone its children should be scanned in.
 *
 * The critical rule this encodes: within a zone that's already cancelled,
 * a *dark* classification needs no marking at all (the content already
 * renders true-colored — marking it too would cancel a second time and
 * flip it back to inverted), while a *media* classification still gets a
 * dim, just without another counter-invert layered on top of the one
 * that's already in effect.
 */
function classify(el: Element, zone: Zone): Zone {
  const style = getComputedStyle(el);
  const kind = classifyElementBackground({
    backgroundColor: style.backgroundColor,
    backgroundImage: style.backgroundImage,
  });

  if (zone === "normal") {
    if (kind === "dark") {
      el.classList.add(DARK_ISLAND_CLASS);
      markedElements.add(el);
      return "cancelled";
    }
    if (kind === "media") {
      el.classList.add(MEDIA_ISLAND_CLASS);
      markedElements.add(el);
      return "cancelled";
    }
    return "normal";
  }

  // zone === "cancelled": already true-colored. A dark background here is
  // already correct as-is. A media background still wants dimming, but via
  // the nested (dim-only, no counter-invert) treatment.
  if (kind === "media") {
    el.classList.add(MEDIA_NESTED_ISLAND_CLASS);
    markedElements.add(el);
  }
  return "cancelled";
}

/**
 * The zone a freshly-scanned root should start in: whatever its nearest
 * already-marked ancestor (if any) put it in. Needed for incremental scans
 * (new content appended inside an already-cancelled container, or a
 * mutated element being re-evaluated in place) — those don't start fresh
 * at the document root, so "normal" would be the wrong default whenever
 * the real ancestor chain says otherwise.
 */
function startingZone(el: Element): Zone {
  return el.closest(`.${ALL_ISLAND_CLASSES.join(", .")}`) ? "cancelled" : "normal";
}

/**
 * Walks `root`'s subtree, classifying every element against the zone it's
 * actually in. Always keeps descending — even into a freshly-marked
 * element's children — because a container being dark or having a
 * background-image doesn't mean its own descendants are done being
 * classified; it only changes *how* they get classified (see `classify`).
 */
export function scanForIslands(root: Node, remainingBudget = MAX_ELEMENTS_PER_SCAN): number {
  let remaining = remainingBudget;
  if (remaining <= 0 || root.nodeType !== Node.ELEMENT_NODE) return remaining;

  const walk = (el: Element, zone: Zone): void => {
    if (remaining <= 0 || SKIP_TAGS.has(el.tagName)) return;
    remaining -= 1;
    const childZone = classify(el, zone);
    for (const child of el.children) {
      walk(child, childZone);
    }
  };

  walk(root as Element, startingZone(root as Element));
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
    el.classList.remove(...ALL_ISLAND_CLASSES);
  }
  markedElements.clear();
}
