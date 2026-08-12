import { describe, expect, it } from "vitest";
import { normalizeDomain } from "./domain";

describe("normalizeDomain", () => {
  it("lowercases and strips a leading www.", () => {
    expect(normalizeDomain("WWW.Example.COM")).toBe("example.com");
  });

  it("leaves non-www hosts unchanged apart from casing", () => {
    expect(normalizeDomain("Docs.Example.com")).toBe("docs.example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeDomain("  example.com  ")).toBe("example.com");
  });
});
