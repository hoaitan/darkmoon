import { describe, expect, it } from "vitest";
import { migrateStoredSettings } from "./storage";
import { DEFAULT_SETTINGS, type Settings } from "./types";

function storedAs(patch: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe("migrateStoredSettings", () => {
  it('renames a stored global mode of "light" to "original"', () => {
    // Settings live in chrome.storage.sync and survive extension updates, so
    // anyone who picked Light in an older build still has that exact string
    // on disk after this rename.
    const migrated = migrateStoredSettings(storedAs({ globalMode: "light" as never }));
    expect(migrated.globalMode).toBe("original");
  });

  it('renames stored per-domain overrides of "light" too', () => {
    const migrated = migrateStoredSettings(
      storedAs({ domainOverrides: { "a.com": "light" as never, "b.com": "dark", "c.com": "auto" } }),
    );
    expect(migrated.domainOverrides).toEqual({ "a.com": "original", "b.com": "dark", "c.com": "auto" });
  });

  it("leaves current mode names untouched", () => {
    const settings = storedAs({ globalMode: "auto", domainOverrides: { "a.com": "original" } });
    expect(migrateStoredSettings(settings)).toEqual(settings);
  });

  it("is idempotent — migrating twice is the same as once", () => {
    const once = migrateStoredSettings(storedAs({ globalMode: "light" as never }));
    expect(migrateStoredSettings(once)).toEqual(once);
  });

  it("preserves the settings it has no opinion about", () => {
    const settings = storedAs({
      globalMode: "light" as never,
      ignoreList: ["example.com"],
      filterSettings: { brightness: 90, contrast: 120, sepia: 10 },
    });
    const migrated = migrateStoredSettings(settings);
    expect(migrated.ignoreList).toEqual(["example.com"]);
    expect(migrated.filterSettings).toEqual({ brightness: 90, contrast: 120, sepia: 10 });
  });

  it("tolerates a missing domainOverrides map", () => {
    const migrated = migrateStoredSettings(storedAs({ domainOverrides: undefined as never }));
    expect(migrated.domainOverrides).toEqual({});
  });
});
