import { describe, expect, it } from "vitest";
import { isDomainIgnored, resolveEffectiveMode } from "./mode-resolution";

describe("resolveEffectiveMode", () => {
  it("honors an explicit global mode regardless of device preference", () => {
    expect(resolveEffectiveMode({ globalMode: "dark", domainOverride: undefined, prefersDark: false })).toBe("dark");
    expect(resolveEffectiveMode({ globalMode: "original", domainOverride: undefined, prefersDark: true })).toBe(
      "original",
    );
  });

  it("resolves auto against the device color-scheme preference", () => {
    expect(resolveEffectiveMode({ globalMode: "auto", domainOverride: undefined, prefersDark: true })).toBe("dark");
    expect(resolveEffectiveMode({ globalMode: "auto", domainOverride: undefined, prefersDark: false })).toBe("original");
  });

  it("lets a domain override win over the global mode", () => {
    expect(resolveEffectiveMode({ globalMode: "original", domainOverride: "dark", prefersDark: false })).toBe("dark");
    expect(resolveEffectiveMode({ globalMode: "dark", domainOverride: "original", prefersDark: true })).toBe("original");
  });

  it("resolves a domain override of auto against device preference too", () => {
    expect(resolveEffectiveMode({ globalMode: "dark", domainOverride: "auto", prefersDark: false })).toBe("original");
  });
});

describe("isDomainIgnored", () => {
  it("is true only for domains present in the ignore list", () => {
    expect(isDomainIgnored("example.com", ["example.com", "foo.com"])).toBe(true);
    expect(isDomainIgnored("bar.com", ["example.com", "foo.com"])).toBe(false);
    expect(isDomainIgnored("example.com", [])).toBe(false);
  });
});
