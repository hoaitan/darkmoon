/**
 * Normalizes a hostname to the domain key used for ignoreList/domainOverrides/
 * themeCache, so `www.example.com` and `example.com` share one entry.
 */
export function normalizeDomain(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}
