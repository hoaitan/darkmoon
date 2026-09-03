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
 * Applied to img/video/canvas/picture so double-inverting cancels out and
 * media renders with its original colors against the inverted page.
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
 * not after. Composed with the page's own invert+hue-rotate on <html>, a
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

export type BackgroundIslandKind = "dark" | "media";

export interface ElementBackground {
  backgroundColor: string;
  backgroundImage: string;
}

/**
 * Minimum opacity for a background color to count as an already-dark
 * island. A low-alpha tint (a shadow wash, a hover overlay) is dominated by
 * whatever sits behind it rather than being its own dark surface — treating
 * it as opaque would exempt its whole subtree from inversion (scanForIslands
 * stops descending into a marked element) and leave a stray light patch on
 * an otherwise-dark page.
 */
const MIN_ISLAND_ALPHA = 0.5;

/**
 * Decides whether an element should be excluded ("island"ed) from the
 * page-wide invert filter:
 *  - it's already dark on its own (a widget with its own dark theme —
 *    inverting it on top would blow it out to a harsh light color), or
 *  - it paints a photo via CSS `background-image` (the img/video/canvas/
 *    picture selector in buildInjectedCss only catches replaced elements,
 *    not backgrounds, so these would otherwise render fully color-inverted).
 * A dark background wins when both are present — an already-dark widget's
 * own background image is part of its intended (non-inverted) look, so it
 * gets the plain counter-invert treatment rather than the extra media dim.
 */
export function classifyElementBackground({
  backgroundColor,
  backgroundImage,
}: ElementBackground): BackgroundIslandKind | null {
  const rgb = parseCssColor(backgroundColor);
  if (rgb && rgb.a >= MIN_ISLAND_ALPHA && isAlreadyDark(relativeLightness(rgb))) {
    return "dark";
  }
  if (backgroundImage !== "none" && backgroundImage.includes("url(")) {
    return "media";
  }
  return null;
}
