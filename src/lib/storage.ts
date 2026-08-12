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

export async function getSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    return stored as Settings;
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
