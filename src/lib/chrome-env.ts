import { installMockChrome } from "./mock-chrome";

/**
 * Call before touching any chrome.* API from popup/options code. Only
 * `yarn dev:mocks` (vite --mode mock) installs the mock chrome global; a
 * normal build/dev-watch run or the real extension leaves window.chrome
 * untouched.
 */
export function ensureChromeEnv(): void {
  if (import.meta.env.MODE === "mock") {
    installMockChrome();
  }
}
