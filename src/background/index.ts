import { getSettings, onSettingsChanged } from "../lib/storage";
import { DEFAULT_SETTINGS, type Mode } from "../lib/types";
import type { DarkmoonMessage, DarkmoonResponse } from "../lib/messages";

const BADGE_TEXT: Record<Mode, string> = { light: "L", dark: "D", auto: "" };
const BADGE_COLOR: Record<Mode, string> = { light: "#9CA3AF", dark: "#2D2B55", auto: "#4A9FEF" };

async function updateBadge(): Promise<void> {
  const settings = await getSettings();
  await chrome.action.setBadgeText({ text: BADGE_TEXT[settings.globalMode] });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR[settings.globalMode] });
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const stored = await chrome.storage.sync.get("globalMode");
    if (stored.globalMode === undefined) {
      await chrome.storage.sync.set(DEFAULT_SETTINGS);
    }
    await updateBadge();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void updateBadge();
});

onSettingsChanged(() => {
  void updateBadge();
});

// Content scripts sample page lightness and compute filter CSS themselves
// (they need DOM access) but can't call chrome.scripting directly, so they
// message the background worker to perform the privileged injection.
chrome.runtime.onMessage.addListener(
  (message: DarkmoonMessage, sender, sendResponse: (response: DarkmoonResponse) => void) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, error: "message had no sender tab" });
      return false;
    }

    if (message.type === "darkmoon/apply-css") {
      chrome.scripting
        .insertCSS({ target: { tabId }, css: message.css })
        .then(() => sendResponse({ ok: true }))
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (message.type === "darkmoon/remove-css") {
      chrome.scripting
        .removeCSS({ target: { tabId }, css: message.css })
        .then(() => sendResponse({ ok: true }))
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    return false;
  },
);
