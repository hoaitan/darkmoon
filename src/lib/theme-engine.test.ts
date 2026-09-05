import { describe, expect, it } from "vitest";
import {
  ALREADY_DARK_LIGHTNESS_THRESHOLD,
  buildInjectedCss,
  calculateFilter,
  counterInvertFilterCSS,
  isAlreadyDark,
  MEDIA_DIM_BRIGHTNESS_PERCENT,
  MEDIA_TAGS,
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
    // invert+hue-rotate on <body>, "brightness(B%) invert(1) hue-rotate(180deg)"
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

describe("MEDIA_TAGS", () => {
  it("excludes <picture>, which always wraps the <img> already in the list", () => {
    // A <picture> is nothing but a wrapper for <source>s plus a mandatory
    // <img>, so listing both matched the same photo twice and stacked two
    // counter-inverts on top of the page's one — three inversions, which is
    // odd, so the image rendered as a negative. Real case: 14 of
    // abc.net.au's 119 images.
    expect(MEDIA_TAGS).not.toContain("picture");
  });

  it("lists no tag that can contain another tag in the list", () => {
    // The invariant the <picture> bug violated. Anything here that can wrap
    // another entry double-applies the media filter to the same pixels.
    const canContainOtherElements = new Set(["picture", "object", "video", "audio", "svg"]);
    const offenders = MEDIA_TAGS.filter((tag) => canContainOtherElements.has(tag) && tag !== "svg image");
    expect(offenders).toEqual(["video"]);
    // <video> stays: its only legal element children are <source>/<track>,
    // neither of which this list matches.
  });
});

describe("buildInjectedCss", () => {
  const PAGE_FILTER = "invert(1) hue-rotate(180deg) brightness(100%) contrast(100%) sepia(0%)";
  const lightPageCss = (): string => buildInjectedCss({ filterCSS: PAGE_FILTER, isAlreadyDark: false });
  const darkPageCss = (): string => buildInjectedCss({ filterCSS: "", isAlreadyDark: true });

  describe("on a light page it darkens", () => {
    it("puts the page filter on <body>, never on <html>", () => {
      // <html> carries the canvas-background propagation paint, which no
      // element's filter reaches — see the rule's comment for the full
      // mechanism.
      expect(lightPageCss()).toContain(`body { filter: ${PAGE_FILTER} !important; }`);
      expect(lightPageCss()).not.toContain(`html { filter:`);
    });

    it("gives <html> an unfiltered dark background so canvas gaps aren't left white", () => {
      expect(lightPageCss()).toContain("html { background-color: #000 !important; }");
    });

    it("counter-inverts and dims every media tag", () => {
      const css = lightPageCss();
      for (const tag of MEDIA_TAGS) {
        expect(css).toContain(`${tag}:not(#darkmoon-specificity-boost)`);
      }
      expect(css).toContain(`filter: ${mediaFilterCSS(MEDIA_DIM_BRIGHTNESS_PERCENT)} !important;`);
    });

    it("counter-inverts iframes without dimming them", () => {
      // The frame runs this same content script and already dimmed its own
      // images; dimming the <iframe> element too would double it up.
      expect(lightPageCss()).toContain(
        `iframe:not(#darkmoon-specificity-boost) { filter: ${counterInvertFilterCSS()} !important; }`,
      );
    });
  });

  describe("on an already-dark page it leaves alone", () => {
    it("dims media with brightness only — no invert, no hue-rotate", () => {
      // There's no page-level filter to cancel here, so the counter-invert
      // that a light page needs would actively break these images.
      const css = darkPageCss();
      expect(css).toContain(`filter: brightness(${MEDIA_DIM_BRIGHTNESS_PERCENT}%) !important;`);
      expect(css).not.toContain("invert(");
      expect(css).not.toContain("hue-rotate(");
    });

    it("dims every media tag", () => {
      const css = darkPageCss();
      for (const tag of MEDIA_TAGS) {
        expect(css).toContain(`${tag}:not(#darkmoon-specificity-boost)`);
      }
    });

    it("touches neither <html> nor <body>", () => {
      expect(darkPageCss()).not.toContain("html {");
      expect(darkPageCss()).not.toContain("body {");
    });

    it("leaves iframes alone — their own document dims its own images", () => {
      expect(darkPageCss()).not.toContain("iframe");
    });
  });

  it("honours a custom dim percentage on both branches", () => {
    expect(buildInjectedCss({ filterCSS: PAGE_FILTER, isAlreadyDark: false, dimBrightnessPercent: 70 })).toContain(
      "brightness(70%) invert(1) hue-rotate(180deg)",
    );
    expect(buildInjectedCss({ filterCSS: "", isAlreadyDark: true, dimBrightnessPercent: 70 })).toContain(
      "filter: brightness(70%) !important;",
    );
  });
});
