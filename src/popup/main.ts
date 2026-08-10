import { ensureChromeEnv } from "../lib/chrome-env";

ensureChromeEnv();

import { normalizeDomain } from "../lib/domain";
import {
  addToIgnoreList,
  getSettings,
  onSettingsChanged,
  removeFromIgnoreList,
  setDomainOverride,
  setSettings,
} from "../lib/storage";
import type { DarkmoonMessage } from "../lib/messages";
import type { Mode } from "../lib/types";

const globalModeButtons = document.querySelectorAll<HTMLButtonElement>('[data-role="global-mode"] button');
const domainEl = document.querySelector<HTMLElement>('[data-role="domain"]')!;
const overrideSelect = document.querySelector<HTMLSelectElement>('[data-role="site-override"]')!;
const ignoreToggle = document.querySelector<HTMLInputElement>('[data-role="ignore-toggle"]')!;
const recalcButton = document.querySelector<HTMLButtonElement>('[data-role="recalculate"]')!;
const openOptionsButton = document.querySelector<HTMLButtonElement>('[data-role="open-options"]')!;

let currentDomain: string | null = null;

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function domainFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

function renderGlobalMode(mode: Mode): void {
  globalModeButtons.forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.value === mode));
  });
}

function renderSite(ignoreList: string[], domainOverrides: Record<string, Mode>): void {
  if (!currentDomain) {
    domainEl.textContent = "No active site";
    overrideSelect.disabled = true;
    ignoreToggle.disabled = true;
    recalcButton.disabled = true;
    return;
  }

  domainEl.textContent = currentDomain;
  overrideSelect.disabled = false;
  ignoreToggle.disabled = false;
  recalcButton.disabled = false;
  overrideSelect.value = domainOverrides[currentDomain] ?? "default";
  ignoreToggle.checked = ignoreList.includes(currentDomain);
}

async function refresh(): Promise<void> {
  const settings = await getSettings();
  renderGlobalMode(settings.globalMode);
  renderSite(settings.ignoreList, settings.domainOverrides);
}

globalModeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    void setSettings({ globalMode: btn.dataset.value as Mode });
  });
});

overrideSelect.addEventListener("change", () => {
  if (!currentDomain) return;
  const value = overrideSelect.value;
  void setDomainOverride(currentDomain, value === "default" ? null : (value as Mode));
});

ignoreToggle.addEventListener("change", () => {
  if (!currentDomain) return;
  if (ignoreToggle.checked) {
    void addToIgnoreList(currentDomain);
  } else {
    void removeFromIgnoreList(currentDomain);
  }
});

recalcButton.addEventListener("click", () => {
  void (async () => {
    const tab = await getActiveTab();
    if (tab?.id === undefined) return;
    await chrome.tabs.sendMessage(tab.id, { type: "darkmoon/recalculate" } satisfies DarkmoonMessage);
    window.close();
  })();
});

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

onSettingsChanged(() => void refresh());

void (async () => {
  const tab = await getActiveTab();
  currentDomain = domainFromUrl(tab?.url);
  await refresh();
})();
