import { counterInvertFilterCSS } from "../lib/theme-engine";
import type { Mode } from "../lib/types";

export interface NotificationCallbacks {
  onModeSelect: (mode: Mode | null) => void;
  onIgnore: () => void;
}

const HOST_ID = "darkmoon-notification-host";
const AUTO_DISMISS_MS = 6000;

let dismissTimer: ReturnType<typeof setTimeout> | undefined;

// `all: initial` on :host resets inherited CSS properties (font, color,
// line-height, ...) that would otherwise cascade in from the host page's
// computed style through the shadow boundary — Shadow DOM isolates
// selectors, not inheritance, so without this the card would silently
// pick up the page's font/colors.
//
// .card's own `filter` counter-inverts Darkmoon's page-wide invert filter
// on <html> (Shadow DOM isolates selectors, not composited paint effects,
// so without this the card would render with its own colors flipped) — the
// same trick used for img/video/canvas in content/index.ts. It's deliberately
// on .card and not the shadow host: `filter` makes an element a new
// containing block for `position: fixed` descendants, and putting it on the
// host would hijack .card's own fixed positioning relative to the viewport.
function buildStyles(): string {
  return `
  :host { all: initial; }
  .card {
    all: initial;
    filter: ${counterInvertFilterCSS()};
    box-sizing: border-box;
    position: fixed;
    bottom: 12px;
    right: 12px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 260px;
    padding: 12px 14px;
    border-radius: 12px;
    background: #1b1f3b;
    color: #f4efe1;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    animation: darkmoon-in 160ms ease-out;
  }
  @keyframes darkmoon-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .row { display: flex; align-items: center; gap: 8px; }
  .title { flex: 1; }
  .title strong { color: #fff; }
  .close {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
    color: #9a97c9;
    font-size: 16px;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .close:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
  .controls { justify-content: space-between; }
  select {
    all: revert;
    font: inherit;
    color: inherit;
    background: #2d2b55;
    border: 1px solid #423f78;
    border-radius: 6px;
    padding: 4px 6px;
  }
  .ignore {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
    font: inherit;
    color: #f4efe1;
    background: #2d2b55;
    border: 1px solid #423f78;
    border-radius: 6px;
    padding: 4px 8px;
    white-space: nowrap;
  }
  .ignore:hover { background: #383668; }
`;
}

function escapeHtml(value: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (ch) => map[ch] ?? ch);
}

function template(domain: string, currentOverride: Mode | undefined, globalMode: Mode): string {
  const value = currentOverride ?? "default";
  const option = (v: string, label: string) =>
    `<option value="${v}" ${v === value ? "selected" : ""}>${label}</option>`;

  return `
    <div class="card" role="status" data-role="card">
      <div class="row">
        <span aria-hidden="true">🌙</span>
        <span class="title">Darkened <strong>${escapeHtml(domain)}</strong></span>
        <button class="close" data-role="close" aria-label="Dismiss">&times;</button>
      </div>
      <div class="row controls">
        <select data-role="mode-select" aria-label="Mode for this site">
          ${option("default", `Default (${globalMode})`)}
          ${option("light", "Light")}
          ${option("dark", "Dark")}
          ${option("auto", "Auto")}
        </select>
        <button class="ignore" data-role="ignore">Ignore site</button>
      </div>
    </div>
  `;
}

function resetDismissTimer(): void {
  clearTimeout(dismissTimer);
  dismissTimer = setTimeout(removeNotification, AUTO_DISMISS_MS);
}

export function removeNotification(): void {
  clearTimeout(dismissTimer);
  document.getElementById(HOST_ID)?.remove();
}

export function showNotification(
  domain: string,
  currentOverride: Mode | undefined,
  globalMode: Mode,
  callbacks: NotificationCallbacks,
): void {
  removeNotification();

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${buildStyles()}</style>${template(domain, currentOverride, globalMode)}`;
  document.documentElement.appendChild(host);

  const card = shadow.querySelector<HTMLElement>('[data-role="card"]');
  card?.addEventListener("mouseenter", () => clearTimeout(dismissTimer));
  card?.addEventListener("mouseleave", resetDismissTimer);

  shadow.querySelector('[data-role="close"]')?.addEventListener("click", removeNotification);

  shadow.querySelector('[data-role="ignore"]')?.addEventListener("click", () => {
    callbacks.onIgnore();
    removeNotification();
  });

  const select = shadow.querySelector<HTMLSelectElement>('[data-role="mode-select"]');
  select?.addEventListener("change", () => {
    const raw = select.value;
    callbacks.onModeSelect(raw === "default" ? null : (raw as Mode));
    resetDismissTimer();
  });

  resetDismissTimer();
}
