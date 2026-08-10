/**
 * The content script computes filter CSS (it needs DOM access to sample
 * page lightness) but only the background service worker holds the
 * "scripting" privilege needed to inject it via chrome.scripting.insertCSS —
 * a browser-privileged injection path that page CSP can't block, unlike a
 * plain `<style>` tag. These messages bridge that gap.
 */
export type DarkmoonMessage =
  | { type: "darkmoon/apply-css"; css: string }
  | { type: "darkmoon/remove-css"; css: string }
  | { type: "darkmoon/recalculate" };

export interface DarkmoonResponse {
  ok: boolean;
  error?: string;
}
