export type Mode = "light" | "dark" | "auto";

export interface FilterSettings {
  /** CSS filter brightness(), percent. 100 = unchanged. */
  brightness: number;
  /** CSS filter contrast(), percent. 100 = unchanged. */
  contrast: number;
  /** CSS filter sepia(), percent. 0 = none. */
  sepia: number;
}

/** Synced via chrome.storage.sync — small, meaningful across the user's devices. */
export interface Settings {
  globalMode: Mode;
  filterSettings: FilterSettings;
  ignoreList: string[];
  domainOverrides: Record<string, Mode>;
}

export interface ThemeCacheEntry {
  filterCSS: string;
  isAlreadyDark: boolean;
  computedAt: number;
}

/** Stored in chrome.storage.local — per-device, disposable, recomputable. */
export type ThemeCache = Record<string, ThemeCacheEntry>;

export const DEFAULT_FILTER_SETTINGS: FilterSettings = {
  brightness: 100,
  contrast: 100,
  sepia: 0,
};

export const DEFAULT_SETTINGS: Settings = {
  globalMode: "auto",
  filterSettings: DEFAULT_FILTER_SETTINGS,
  ignoreList: [],
  domainOverrides: {},
};
