import type { FilterSettings } from "./types";

export interface RGB {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parses the `rgb()`/`rgba()` strings returned by getComputedStyle(). */
export function parseCssColor(value: string): RGB | null {
  const match = value.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (!match?.[1]) return null;

  const parts = match[1].split(",").map((part) => parseFloat(part.trim()));
  const [r, g, b, a = 1] = parts;
  if (r === undefined || g === undefined || b === undefined) return null;
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;

  return { r, g, b, a };
}

/** Perceptual lightness in [0, 1]. Cheap, fixed-cost — not a full color-space conversion. */
export function relativeLightness({ r, g, b }: RGB): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * A page counts as "already dark" below this lightness — matches the
 * background a `prefers-color-scheme: dark` site typically ships (e.g. #1a1a1a).
 */
export const ALREADY_DARK_LIGHTNESS_THRESHOLD = 0.3;

export function isAlreadyDark(lightness: number): boolean {
  return lightness <= ALREADY_DARK_LIGHTNESS_THRESHOLD;
}

export interface FilterResult {
  isAlreadyDark: boolean;
  /** CSS `filter` value to apply to the page root. Empty when already dark. */
  filterCSS: string;
}

/**
 * Adaptive CSS Filter engine: invert the whole page, then hue-rotate back so
 * hues read correctly, then apply the user's brightness/contrast/sepia taste.
 */
export function calculateFilter(lightness: number, settings: FilterSettings): FilterResult {
  if (isAlreadyDark(lightness)) {
    return { isAlreadyDark: true, filterCSS: "" };
  }

  const { brightness, contrast, sepia } = settings;
  const filterCSS = `invert(1) hue-rotate(180deg) brightness(${brightness}%) contrast(${contrast}%) sepia(${sepia}%)`;
  return { isAlreadyDark: false, filterCSS };
}

/**
 * Applied to MEDIA_TAGS so double-inverting cancels out and media renders
 * with its original colors against the inverted page.
 */
export function counterInvertFilterCSS(): string {
  return "invert(1) hue-rotate(180deg)";
}

/**
 * Same double-invert cancellation as counterInvertFilterCSS, but knocks
 * brightness down first so photos and video don't sit at full brightness
 * (glaring, "can't see the image normally") against an otherwise darkened
 * page.
 *
 * Order is load-bearing: brightness has to run *before* invert/hue-rotate,
 * not after. Composed with the page-level invert+hue-rotate filter, a
 * leading brightness(B%) works out to a plain `x * B` on the original
 * color — a real dim. Appended at the end instead, the same composition
 * works out to `1 - B*(1-x)`, which lifts shadows toward gray rather than
 * pulling highlights down: the opposite of "less light".
 */
export function mediaFilterCSS(dimBrightnessPercent: number): string {
  return `brightness(${dimBrightnessPercent}%) ${counterInvertFilterCSS()}`;
}

/** Default dim applied to media/background-images — enough to cut glare without looking washed out. */
export const MEDIA_DIM_BRIGHTNESS_PERCENT = 90;

/**
 * Tags that paint their own pixels and therefore need the page filter
 * cancelled on them. Deliberately excludes `picture`: a <picture> is only a
 * wrapper for <source>s plus a mandatory <img>, so listing both matched the
 * same photo twice and stacked two counter-inverts on top of the page's one
 * — three inversions, which is odd, so the photo rendered as a negative.
 * Nothing may be added here that can contain another entry.
 */
export const MEDIA_TAGS = ["img", "video", "canvas", "svg image"];

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

/**
 * Plain (unfiltered) fallback for whichever of <html>/<body> ends up
 * supplying the CSS canvas-background propagation — see the long comment on
 * the returned rule in buildInjectedCss for the full mechanism. Matches
 * what a filtered plain-white page already lands on (`invert(white)` is
 * black), so it reads as a continuation of the normal filtered look rather
 * than a visibly different fallback color.
 */
const CANVAS_FALLBACK_BACKGROUND = "#000";

export interface InjectedCssInput {
  /** The page-level filter from calculateFilter. Unused when isAlreadyDark. */
  filterCSS: string;
  /** The one site-wide decision: did we sample this document as already dark? */
  isAlreadyDark: boolean;
  dimBrightnessPercent?: number;
}

/**
 * The entire stylesheet Darkmoon injects into a document, derived from one
 * site-wide flag. There is deliberately no per-element classification here:
 * every element in the document is governed by `isAlreadyDark`, and the only
 * per-tag distinction is the mechanical one below — an element that paints
 * its own pixels needs the page filter undone on it, because a CSS `filter`
 * on <body> transforms everything inside it and cannot be opted out of.
 */
export function buildInjectedCss({
  filterCSS,
  isAlreadyDark,
  dimBrightnessPercent = MEDIA_DIM_BRIGHTNESS_PERCENT,
}: InjectedCssInput): string {
  const mediaSelector = MEDIA_TAGS.map((tag) => `${tag}${SPECIFICITY_BOOST}`).join(", ");

  // Already-dark page: we apply no page filter, so there is nothing to
  // cancel and a counter-invert here would actively break these images.
  // All they want is the glare taken off — brightness alone, no invert, no
  // hue-rotate. Iframes get nothing: each one runs this same content script
  // and dims its own images, so dimming the <iframe> element too would
  // double it up.
  if (isAlreadyDark) {
    return `${mediaSelector} { filter: brightness(${dimBrightnessPercent}%) !important; }`;
  }

  // The filter goes on <body>, not <html> — see the <html> background-color
  // rule below for why <body> specifically, they're a package deal.
  //
  // No explicit background-color on the filtered <body> rule itself:
  // `filter` transforms everything the element paints, including its own
  // background-color, so setting one here would get inverted right along
  // with the filter and produce the wrong result. Letting the page's real
  // background (default white if unset) run through the filter is what
  // makes it come out dark.
  //
  // <html> DOES get an explicit background-color — deliberately with no
  // filter of its own. This isn't decorative: per the CSS canvas-background
  // rule (an element's declared background propagates to fill the whole
  // viewport when the element above it in the html>body chain has none of
  // its own), whichever of <html>/<body> ends up supplying that propagated
  // canvas fill has that specific paint operation happen on a separate
  // layer that no element's `filter` ever reaches — confirmed by checking
  // computed styles against actual rendered pixels: `<html>`'s own
  // background/filter (or <body>'s) can read back exactly as declared while
  // the pixels themselves still show the page's un-inverted original color,
  // in the gaps beyond whatever content actually painted something (a
  // sparse page, one narrower than the viewport like
  // news.ycombinator.com's centered table, or just the ordinary gaps
  // between a header/card/etc and the page's own background — this isn't
  // an edge case, it's most pages). Two things fix it together: (1) an
  // explicit background-color on <html> takes it out of "has none of its
  // own" — the propagation precondition — so <body>'s own background-color
  // stops being commandeered for canvas duty and instead paints normally
  // as part of <body>'s own box, which the filter *does* reach; (2) using
  // an already-dark, unfiltered color for <html>'s means that whatever
  // canvas-propagation gap remains regardless (there's always a first
  // element in the chain, and Chromium's propagation rule always exempts
  // whichever one it lands on from filtering) comes out looking right
  // anyway — filtering it would have been redundant, not required.
  //
  // Iframes (ad slots, embeds, trackers) get this script injected into them
  // too — manifest.json sets all_frames: true — so each one already darkens
  // its own document independently and correctly. But the <iframe> element
  // is *also* a replaced element inside this document, so this page's own
  // filter composites over its already-correct rendering one more time,
  // same as it would for an unhandled <img>: a plain counter-invert on the
  // tag itself (no dim — the frame's own content already handled that)
  // cancels it back out.
  return `html { background-color: ${CANVAS_FALLBACK_BACKGROUND} !important; }
body { filter: ${filterCSS} !important; }
${mediaSelector} { filter: ${mediaFilterCSS(dimBrightnessPercent)} !important; }
iframe${SPECIFICITY_BOOST} { filter: ${counterInvertFilterCSS()} !important; }`;
}
