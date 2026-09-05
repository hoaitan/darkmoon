import { DEFAULT_SETTINGS, type Mode, type Settings, type ThemeCache, type ThemeCacheEntry } from "./types";

const SYNC_KEYS = ["globalMode", "filterSettings", "ignoreList", "domainOverrides"] as const;

let quotaWarningLogged = false;

function warnStorageFailure(context: string, err: unknown): void {
  // chrome.storage.sync has a small quota; if it's ever exceeded we keep
  // running on in-memory/last-known state instead of throwing, and only log
  // once so a bad domain doesn't spam the console on every page load.
  if (quotaWarningLogged) return;
  quotaWarningLogged = true;
  console.warn(`[darkmoon] ${context} — continuing without persisting`, err);
}

/**
 * Mode names this extension used to write, mapped to what they're called
 * now. `"light"` became `"original"` when the mode stopped being "a light
 * theme" and became "do nothing at all".
 */
const LEGACY_MODE_NAMES: Record<string, Mode> = { light: "original" };

function currentModeName(mode: Mode): Mode {
  return LEGACY_MODE_NAMES[mode] ?? mode;
}

/**
 * Settings live in chrome.storage.sync and survive extension updates, so a
 * user who picked the old mode still has its old string on disk. Renaming it
 * on read (rather than rewriting storage on every load) is enough: the value
 * is idempotent, and the next write of either field persists the new name
 * anyway. Without this the stale name matches no branch in
 * resolveEffectiveMode and the page ends up unfiltered by accident rather
 * than by choice.
 */
export function migrateStoredSettings(stored: Settings): Settings {
  const domainOverrides: Record<string, Mode> = {};
  for (const [domain, mode] of Object.entries(stored.domainOverrides ?? {})) {
    domainOverrides[domain] = currentModeName(mode);
  }
  return { ...stored, globalMode: currentModeName(stored.globalMode), domainOverrides };
}

export async function getSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    return migrateStoredSettings(stored as Settings);
  } catch (err) {
    warnStorageFailure("chrome.storage.sync read failed", err);
    return DEFAULT_SETTINGS;
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  try {
    await chrome.storage.sync.set(patch);
  } catch (err) {
    warnStorageFailure("chrome.storage.sync write failed (likely quota)", err);
  }
}

export function onSettingsChanged(callback: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: chrome.storage.AreaName) => {
    if (areaName !== "sync") return;
    if (!SYNC_KEYS.some((key) => key in changes)) return;
    void getSettings().then(callback);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

async function readCache(): Promise<ThemeCache> {
  const store = await chrome.storage.local.get("themeCache");
  return (store.themeCache as ThemeCache | undefined) ?? {};
}

export async function getCacheEntry(domain: string): Promise<ThemeCacheEntry | undefined> {
  const cache = await readCache();
  return cache[domain];
}

export async function setCacheEntry(domain: string, entry: ThemeCacheEntry): Promise<void> {
  const cache = await readCache();
  cache[domain] = entry;
  await chrome.storage.local.set({ themeCache: cache });
}

export async function clearCacheEntry(domain: string): Promise<void> {
  const cache = await readCache();
  if (!(domain in cache)) return;
  delete cache[domain];
  await chrome.storage.local.set({ themeCache: cache });
}

export async function clearAllCacheEntries(): Promise<void> {
  await chrome.storage.local.remove("themeCache");
}

export async function addToIgnoreList(domain: string): Promise<void> {
  const settings = await getSettings();
  if (settings.ignoreList.includes(domain)) return;
  await setSettings({ ignoreList: [...settings.ignoreList, domain] });
}

export async function removeFromIgnoreList(domain: string): Promise<void> {
  const settings = await getSettings();
  await setSettings({ ignoreList: settings.ignoreList.filter((d) => d !== domain) });
}

export async function setDomainOverride(domain: string, mode: Mode | null): Promise<void> {
  const settings = await getSettings();
  const domainOverrides = { ...settings.domainOverrides };
  if (mode === null) {
    delete domainOverrides[domain];
  } else {
    domainOverrides[domain] = mode;
  }
  await setSettings({ domainOverrides });
}
