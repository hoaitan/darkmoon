import type { Mode } from "./types";

export interface ResolveModeInput {
  globalMode: Mode;
  domainOverride: Mode | undefined;
  /** `matchMedia("(prefers-color-scheme: dark)").matches` */
  prefersDark: boolean;
}

export type ResolvedAction = "original" | "dark";

/**
 * effective mode = domainOverrides[domain] ?? globalMode; auto resolves
 * against the device's color-scheme preference.
 */
export function resolveEffectiveMode({ globalMode, domainOverride, prefersDark }: ResolveModeInput): ResolvedAction {
  const mode = domainOverride ?? globalMode;
  if (mode === "auto") {
    return prefersDark ? "dark" : "original";
  }
  return mode;
}

export function isDomainIgnored(domain: string, ignoreList: string[]): boolean {
  return ignoreList.includes(domain);
}
