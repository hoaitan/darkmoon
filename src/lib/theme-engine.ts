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
