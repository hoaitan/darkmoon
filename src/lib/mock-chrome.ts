import type { Settings } from "./types";

/**
 * A minimal in-browser stand-in for the `chrome` global, used only by
 * `yarn dev:mocks`. It backs chrome.storage with localStorage (so state
 * survives reloads) and seeds it with sample data, so popup.html/options.html
 * can be opened directly in a normal browser tab — no unpacked-extension
 * reload loop required while iterating on UI.
 */

type AreaName = "sync" | "local";
type StorageArea = Record<string, unknown>;
type ChangeSet = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type ChangeListener = (changes: ChangeSet, areaName: AreaName) => void;

const STORAGE_PREFIX = "darkmoon-mock:";

const MOCK_SETTINGS: Settings = {
  globalMode: "dark",
  filterSettings: { brightness: 100, contrast: 110, sepia: 8 },
  ignoreList: ["news.ycombinator.com"],
  domainOverrides: { "github.com": "light" },
};

const MOCK_THEME_CACHE = {
  "example.com": {
    filterCSS: "invert(1) hue-rotate(180deg) brightness(100%) contrast(110%) sepia(8%)",
    isAlreadyDark: false,
    computedAt: Date.now(),
  },
};

export const MOCK_ACTIVE_TAB = {
  id: 1,
  url: "https://example.com/",
  active: true,
  windowId: 1,
};

function loadArea(area: AreaName): StorageArea {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + area);
    return raw ? (JSON.parse(raw) as StorageArea) : {};
  } catch {
    return {};
  }
}

function saveArea(area: AreaName, data: StorageArea): void {
  localStorage.setItem(STORAGE_PREFIX + area, JSON.stringify(data));
}

function seedIfEmpty(): void {
  if (localStorage.getItem(STORAGE_PREFIX + "sync") === null) {
    saveArea("sync", { ...MOCK_SETTINGS });
  }
  if (localStorage.getItem(STORAGE_PREFIX + "local") === null) {
    saveArea("local", { themeCache: MOCK_THEME_CACHE });
  }
}

function makeStorageArea(area: AreaName, listeners: Set<ChangeListener>) {
  function emit(changes: ChangeSet): void {
    for (const listener of listeners) listener(changes, area);
  }

  return {
    get(query?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
      const data = loadArea(area);
      if (query == null) return Promise.resolve({ ...data });

      if (typeof query === "string") {
        return Promise.resolve({ [query]: data[query] });
      }
      if (Array.isArray(query)) {
        const result: Record<string, unknown> = {};
        for (const key of query) result[key] = data[key];
        return Promise.resolve(result);
      }
      const result: Record<string, unknown> = {};
      for (const [key, fallback] of Object.entries(query)) {
        result[key] = key in data ? data[key] : fallback;
      }
      return Promise.resolve(result);
    },

    set(items: Record<string, unknown>): Promise<void> {
      const data = loadArea(area);
      const changes: ChangeSet = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = value;
      }
      saveArea(area, data);
      emit(changes);
      return Promise.resolve();
    },

    remove(keys: string | string[]): Promise<void> {
      const data = loadArea(area);
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: ChangeSet = {};
      for (const key of list) {
        changes[key] = { oldValue: data[key] };
        delete data[key];
      }
      saveArea(area, data);
      emit(changes);
      return Promise.resolve();
    },
  };
}

export function installMockChrome(): void {
  if (typeof window === "undefined") return;
  if ((window as unknown as { chrome?: { __darkmoonMock?: boolean } }).chrome?.__darkmoonMock) return;

  seedIfEmpty();

  const listeners = new Set<ChangeListener>();

  const mockChrome = {
    __darkmoonMock: true,
    storage: {
      sync: makeStorageArea("sync", listeners),
      local: makeStorageArea("local", listeners),
      onChanged: {
        addListener: (fn: ChangeListener) => listeners.add(fn),
        removeListener: (fn: ChangeListener) => listeners.delete(fn),
      },
    },
    runtime: {
      sendMessage: (message: unknown) => {
        console.info("[darkmoon mock] runtime.sendMessage", message);
        return Promise.resolve({ ok: true });
      },
      onMessage: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
    tabs: {
      query: () => Promise.resolve([MOCK_ACTIVE_TAB]),
      sendMessage: (tabId: number, message: unknown) => {
        console.info("[darkmoon mock] tabs.sendMessage", tabId, message);
        return Promise.resolve({ ok: true });
      },
    },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
      setIcon: () => Promise.resolve(),
    },
  };

  (window as unknown as { chrome: typeof mockChrome }).chrome = mockChrome;
  console.info(
    "[darkmoon] mock chrome API installed (yarn dev:mocks) — seeded data lives in localStorage, see src/lib/mock-chrome.ts",
  );
}
