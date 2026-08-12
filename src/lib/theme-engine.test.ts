import { describe, expect, it } from "vitest";
import {
  ALREADY_DARK_LIGHTNESS_THRESHOLD,
  calculateFilter,
  counterInvertFilterCSS,
  isAlreadyDark,
  parseCssColor,
  relativeLightness,
} from "./theme-engine";
import { DEFAULT_FILTER_SETTINGS } from "./types";

describe("parseCssColor", () => {
  it("parses rgb() strings", () => {
    expect(parseCssColor("rgb(255, 255, 255)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("parses rgba() strings including alpha", () => {
    expect(parseCssColor("rgba(26, 26, 26, 0.5)")).toEqual({ r: 26, g: 26, b: 26, a: 0.5 });
  });

  it("returns null for transparent / unparseable values", () => {
    expect(parseCssColor("transparent")).toBeNull();
    expect(parseCssColor("not-a-color")).toBeNull();
  });
});

describe("relativeLightness", () => {
  it("returns 1 for white", () => {
    expect(relativeLightness({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1);
  });

  it("returns 0 for black", () => {
    expect(relativeLightness({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
  });

  it("weights green highest, blue lowest (perceptual luma)", () => {
    const green = relativeLightness({ r: 0, g: 255, b: 0, a: 1 });
    const blue = relativeLightness({ r: 0, g: 0, b: 255, a: 1 });
    expect(green).toBeGreaterThan(blue);
  });
});

describe("isAlreadyDark", () => {
  it("is true at and below the threshold", () => {
    expect(isAlreadyDark(ALREADY_DARK_LIGHTNESS_THRESHOLD)).toBe(true);
    expect(isAlreadyDark(0)).toBe(true);
  });

  it("is false above the threshold", () => {
    expect(isAlreadyDark(ALREADY_DARK_LIGHTNESS_THRESHOLD + 0.01)).toBe(false);
    expect(isAlreadyDark(1)).toBe(false);
  });
});

describe("calculateFilter", () => {
  it("skips filtering for already-dark pages", () => {
    const result = calculateFilter(0.1, DEFAULT_FILTER_SETTINGS);
    expect(result).toEqual({ isAlreadyDark: true, filterCSS: "" });
  });

  it("builds an invert + hue-rotate filter for light pages using the given settings", () => {
    const result = calculateFilter(1, { brightness: 90, contrast: 120, sepia: 10 });
    expect(result.isAlreadyDark).toBe(false);
    expect(result.filterCSS).toBe("invert(1) hue-rotate(180deg) brightness(90%) contrast(120%) sepia(10%)");
  });
});

describe("counterInvertFilterCSS", () => {
  it("double-inverts to cancel the page-level filter for media elements", () => {
    expect(counterInvertFilterCSS()).toBe("invert(1) hue-rotate(180deg)");
  });
});
