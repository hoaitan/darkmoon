import { describe, expect, it } from "vitest";
import {
  ALREADY_DARK_LIGHTNESS_THRESHOLD,
  calculateFilter,
  classifyElementBackground,
  counterInvertFilterCSS,
  isAlreadyDark,
  mediaFilterCSS,
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

describe("mediaFilterCSS", () => {
  it("puts brightness before invert/hue-rotate, not after", () => {
    // Order is load-bearing, not stylistic: composed with the page-level
    // invert+hue-rotate on <html>, "brightness(B%) invert(1) hue-rotate(180deg)"
    // works out to a clean `x * B` on the original color (a real dim), while
    // putting brightness *after* the invert/hue-rotate pair works out to
    // `1 - B*(1-x)` instead — that lifts shadows toward gray rather than
    // pulling highlights down, which is the opposite of "less light".
    expect(mediaFilterCSS(90)).toBe("brightness(90%) invert(1) hue-rotate(180deg)");
  });

  it("is a no-op dim at 100%, equivalent to the plain counter-invert", () => {
    expect(mediaFilterCSS(100)).toBe(`brightness(100%) ${counterInvertFilterCSS()}`);
  });
});

describe("classifyElementBackground", () => {
  it("classifies an opaque, below-threshold background as an already-dark island", () => {
    expect(classifyElementBackground({ backgroundColor: "rgb(20, 20, 20)", backgroundImage: "none" })).toBe("dark");
  });

  it("does not classify a light background as dark", () => {
    expect(classifyElementBackground({ backgroundColor: "rgb(240, 240, 240)", backgroundImage: "none" })).toBeNull();
  });

  it("ignores a transparent dark-looking color — nothing was actually painted", () => {
    expect(classifyElementBackground({ backgroundColor: "rgba(20, 20, 20, 0)", backgroundImage: "none" })).toBeNull();
  });

  it("ignores a low-alpha dark tint — a shadow/hover wash, not an opaque dark surface", () => {
    expect(classifyElementBackground({ backgroundColor: "rgba(20, 20, 20, 0.2)", backgroundImage: "none" })).toBeNull();
  });

  it("classifies a majority-opaque dark background (e.g. a modal backdrop) as dark", () => {
    expect(classifyElementBackground({ backgroundColor: "rgba(20, 20, 20, 0.5)", backgroundImage: "none" })).toBe(
      "dark",
    );
  });

  it("classifies a raster background-image as a media island", () => {
    expect(
      classifyElementBackground({
        backgroundColor: "rgba(0, 0, 0, 0)",
        backgroundImage: 'url("https://example.com/hero.jpg")',
      }),
    ).toBe("media");
  });

  it("does not classify a gradient-only background-image as media", () => {
    expect(
      classifyElementBackground({
        backgroundColor: "rgba(0, 0, 0, 0)",
        backgroundImage: "linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))",
      }),
    ).toBeNull();
  });

  it("prefers the dark classification when both a dark background and an image are present", () => {
    expect(
      classifyElementBackground({
        backgroundColor: "rgb(10, 10, 10)",
        backgroundImage: 'url("https://example.com/texture.png")',
      }),
    ).toBe("dark");
  });

  it("returns null for an unstyled element (no color, no image)", () => {
    expect(classifyElementBackground({ backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none" })).toBeNull();
  });
});
