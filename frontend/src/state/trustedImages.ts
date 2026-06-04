/**
 * Trusted image senders: domains whose remote images load automatically even when
 * "Block remote images" is on. Trust is keyed on the exact From host (e.g.
 * "notifications.github.com"), not a registrable root, so trusting one sender never
 * silently covers unrelated subdomains.
 */
import { getPrefs, setPref } from './prefs';

/** Lowercased host part of an email address, or null if there isn't one. */
export function senderDomain(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain || null;
}

/** Whether this sender's domain is on the trusted list. */
export function isImageDomainTrusted(
  address: string | null | undefined,
  trusted: string[],
): boolean {
  const d = senderDomain(address);
  return d !== null && trusted.includes(d);
}

/** Add a domain to the trusted list (no-op if already present). */
export function trustImageDomain(domain: string): void {
  const list = getPrefs().trustedImageDomains;
  if (!list.includes(domain)) setPref('trustedImageDomains', [...list, domain]);
}

/** Remove a domain from the trusted list. */
export function untrustImageDomain(domain: string): void {
  setPref(
    'trustedImageDomains',
    getPrefs().trustedImageDomains.filter((d) => d !== domain),
  );
}
