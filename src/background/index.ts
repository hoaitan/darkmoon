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
//
// The content script runs in every frame (manifest.json's all_frames: true —
// otherwise an ad/tracker iframe's own images would never get the
// counter-invert/dim treatment and would render fully color-inverted, since
// the top page's filter still visually composites over embedded frames
// regardless), so each request must target the SPECIFIC frame it came from.
// chrome.scripting.insertCSS defaults target.frameIds to [0] (the top frame
// only) when omitted — passing just { tabId } here would silently insert
// every frame's CSS into the top frame instead of its own.
chrome.runtime.onMessage.addListener(
  (message: DarkmoonMessage, sender, sendResponse: (response: DarkmoonResponse) => void) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, error: "message had no sender tab" });
      return false;
    }
    const target = sender.frameId === undefined ? { tabId } : { tabId, frameIds: [sender.frameId] };

    if (message.type === "darkmoon/apply-css") {
      chrome.scripting
        .insertCSS({ target, css: message.css })
        .then(() => sendResponse({ ok: true }))
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (message.type === "darkmoon/remove-css") {
      chrome.scripting
        .removeCSS({ target, css: message.css })
        .then(() => sendResponse({ ok: true }))
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    return false;
  },
);
