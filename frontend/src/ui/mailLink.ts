/**
 * Routing for links a sender put inside a message body.
 *
 * The message frame is sandboxed (see MailBody) without `allow-top-navigation`, so an
 * anchor inside it can never navigate on its own: a browser rescues it through
 * `<base target="_blank">` + `allow-popups`, but the Android WebView creates no popup
 * window at all (Capacitor leaves `setSupportMultipleWindows` off), so the sandbox
 * blocks the fallback same-frame navigation and the tap silently does nothing. The app
 * document therefore intercepts clicks inside the frame and routes them itself, which
 * also lets `mailto:` open OUR composer instead of a foreign mail app.
 */

/** A compose-worthy `mailto:` broken into its parts (RFC 6068). */
export interface MailtoLink {
  kind: 'compose';
  to: string[];
  cc: string[];
  subject?: string;
  body?: string;
}

export type MailLink =
  /** A web destination — hand to the browser / the Android system browser. */
  | { kind: 'external'; url: string }
  /** A `mailto:` we answer ourselves, with the composer. */
  | MailtoLink
  /** A scheme only the platform can serve (`tel:`, `sms:`, …). */
  | { kind: 'platform'; url: string }
  /** An in-document jump (`#anchor`) — the frame scrolls itself, don't interfere. */
  | { kind: 'fragment' }
  /** Nothing we will ever follow: `javascript:`, `data:`, `blob:`, unparseable. */
  | { kind: 'blocked' };

/** Schemes worth handing to the OS: the host app turns them into an Intent. */
const PLATFORM_SCHEMES = new Set(['tel:', 'sms:', 'smsto:', 'geo:', 'callto:']);

/** Percent-decode one mailto token, tolerating malformed escapes (`%zz`). */
function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function addressList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((address) => decode(address).trim())
    .filter(Boolean);
}

/**
 * Split a `mailto:` into composer fields. Recipients come from the path AND from
 * `?to=`, which some senders use exclusively; `cc` is merged the same way. `bcc` is
 * deliberately dropped — the composer has no blind-copy field, and silently promoting
 * a bcc to cc would disclose the address.
 */
export function parseMailto(href: string): MailtoLink {
  // `new URL('mailto:…')` keeps the address list in `pathname`, percent-encoded.
  let path = '';
  let params = new URLSearchParams();
  try {
    const url = new URL(href);
    path = url.pathname;
    params = url.searchParams;
  } catch {
    // Malformed enough that URL rejects it: keep whatever precedes the query.
    const raw = href.replace(/^mailto:/i, '');
    const [addresses, query = ''] = raw.split('?');
    path = addresses ?? '';
    params = new URLSearchParams(query);
  }
  const subject = params.get('subject') ?? undefined;
  const body = params.get('body') ?? undefined;
  return {
    kind: 'compose',
    to: [...addressList(path), ...addressList(params.get('to'))],
    cc: addressList(params.get('cc')),
    ...(subject ? { subject } : {}),
    ...(body ? { body } : {}),
  };
}

/**
 * Decide what a clicked message link means. `resolved` is the anchor's absolute
 * `href` (as the DOM resolves it); `raw` is the unresolved attribute, which is the
 * only way to tell an in-document `#anchor` from a link to our own app URL — inside
 * an srcdoc frame both resolve against the app document.
 */
export function classifyMailLink(resolved: string, raw?: string | null): MailLink {
  if (raw != null && raw.trim().startsWith('#')) return { kind: 'fragment' };
  let protocol: string;
  try {
    protocol = new URL(resolved).protocol.toLowerCase();
  } catch {
    return { kind: 'blocked' };
  }
  if (protocol === 'http:' || protocol === 'https:') return { kind: 'external', url: resolved };
  if (protocol === 'mailto:') return parseMailto(resolved);
  if (PLATFORM_SCHEMES.has(protocol)) return { kind: 'platform', url: resolved };
  return { kind: 'blocked' };
}

/** The three ways a message link can leave the reader. */
export interface MailLinkHandlers {
  /** Open a web address outside the message (new tab / system browser). */
  openExternal: (url: string) => void;
  /** Start a new message to a `mailto:` target. */
  openCompose: (link: MailtoLink) => void;
  /** Let the OS take a non-web scheme (dialer, SMS app, …). */
  openPlatform: (url: string) => void;
}

/** Anything with `closest` is close enough to an Element — the click originates in
 * another realm (the iframe), where `instanceof Element` is always false. */
function closestAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  const node = target as (Node & { closest?: (s: string) => Element | null }) | null;
  const from = typeof node?.closest === 'function' ? node : (node?.parentElement ?? null);
  return (from?.closest?.('a[href]') as HTMLAnchorElement | null) ?? null;
}

/**
 * A `click` listener for a message document: routes anchor clicks through the given
 * handlers and cancels the frame's own (impossible) navigation. Modified clicks are
 * left alone so the browser's own "open in new tab/window/download" still applies.
 */
export function createMailLinkClickHandler(handlers: MailLinkHandlers) {
  return (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = closestAnchor(event.target);
    if (!anchor) return;
    const link = classifyMailLink(anchor.href, anchor.getAttribute('href'));
    if (link.kind === 'fragment') return;
    event.preventDefault();
    if (link.kind === 'external') handlers.openExternal(link.url);
    else if (link.kind === 'compose') handlers.openCompose(link);
    else if (link.kind === 'platform') handlers.openPlatform(link.url);
  };
}
