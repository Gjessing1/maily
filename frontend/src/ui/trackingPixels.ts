/**
 * Tracking-pixel detection for sender HTML.
 *
 * Marketing mail embeds a remote 1×1 image whose only job is to tell the sender the
 * message was opened (and when, from where, on what device). Dropping it is pure gain:
 * nothing visible is lost, the open is never reported, and a slow tracker host can't
 * hold up the reader's layout while the frame waits on it.
 *
 * The rules were tuned against a few thousand real messages:
 *  - A declared size of at most 1×1 (attribute or inline px style), or a zero
 *    dimension, catches nearly all of them: SendGrid, Mailchimp, HubSpot, Substack,
 *    GitHub, PayPal, Salesforce, Voyado... A 1×1 layout spacer goes with them, which
 *    costs at most a pixel.
 *  - A few providers hide the pixel with `display:none` and declare no size (Brevo),
 *    so known open-tracking endpoints are matched by URL too.
 *  - `display:none` on its own is NOT a signal: newsletters (selfh.st, for one) hide
 *    real thumbnails inline and reveal them from a media query.
 * Only remote images are candidates; data: and cid: images can't report anything.
 */

/** Open-tracking endpoints that serve nothing but a pixel. Path or host fragments. */
const OPEN_TRACKER_URLS: readonly RegExp[] = [
  /\/wf\/open\b/i, // SendGrid
  /\/track\/open\.php\b/i, // Mailchimp, Mandrill
  /\/mk\/op\//i, // Brevo (Sendinblue)
  /\/e\dt\/Cto\/|\.hubspotlinks\.com\/Cto\//, // HubSpot
  /\/open\.aspx\b/i, // Salesforce Marketing Cloud
  /^https?:\/\/eotrx\.substackcdn\.com\/open\b/i, // Substack
  /^https?:\/\/github\.com\/notifications\/beacon\//i, // GitHub
  /^https?:\/\/pixel\.wp\.com\//i, // WordPress / Jetpack
];

function isRemote(src: string): boolean {
  return /^\s*(?:https?:)?\/\//i.test(src);
}

/** A CSS length in px (or unitless, as HTML attributes are); null for %, em, auto... */
function pixels(value: string | null | undefined): number | null {
  if (value == null) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*(?:!\s*important)?\s*$/i.exec(value);
  return match ? Number(match[1]) : null;
}

/** The last declaration of `property` in an inline style attribute, if any. */
function styleValue(style: string, property: string): string | undefined {
  let found: string | undefined;
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    if (declaration.slice(0, colon).trim().toLowerCase() === property) {
      found = declaration.slice(colon + 1);
    }
  }
  return found;
}

/** The size the sender declared for an image; inline style wins over attributes. */
function declaredSize(img: Element, axis: 'width' | 'height'): number | null {
  const fromStyle = pixels(styleValue(img.getAttribute('style') ?? '', axis));
  return fromStyle ?? pixels(img.getAttribute(axis));
}

/** True if `img` is a remote open-tracking pixel rather than content. */
export function isTrackingPixel(img: Element): boolean {
  const src = img.getAttribute('src') ?? '';
  if (!isRemote(src)) return false;
  const width = declaredSize(img, 'width');
  const height = declaredSize(img, 'height');
  if (width === 0 || height === 0) return true;
  if (width !== null && height !== null && width <= 1 && height <= 1) return true;
  const url = src.trim();
  return OPEN_TRACKER_URLS.some((pattern) => pattern.test(url));
}

/** Remove every tracking pixel under `root`. Returns how many were dropped. */
export function removeTrackingPixels(root: ParentNode): number {
  let removed = 0;
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (isTrackingPixel(img)) {
      img.remove();
      removed++;
    }
  }
  return removed;
}
