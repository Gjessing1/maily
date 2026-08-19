/**
 * Which senders are worth offering as a contact (ROADMAP §A2).
 *
 * The offer is only useful for addresses a person might actually want in their address
 * book. Most unknown senders in a real mailbox are machines — receipts, newsletters,
 * password resets — and prompting on those turns a one-click convenience into exactly the
 * backlog the anti-chore stance rules out. So the reader asks this first, and stays silent
 * for anything that identifies itself as automated.
 *
 * Deliberately conservative: it only filters on the address's own self-description (a
 * no-reply-style local part, or a role mailbox nobody files as a person). A real human at
 * an unusual address is never suppressed — a missed prompt costs nothing, since the sender
 * avatar still quick-creates the contact on demand.
 */

/**
 * Local parts that announce the address is not a person. Matched on the local part with
 * separators stripped, so `no-reply`, `no_reply`, `noreply` and `No.Reply` all collapse
 * to the same token.
 */
const MACHINE_LOCAL_PARTS = new Set([
  'noreply',
  'donotreply',
  'dontreply',
  'nevereply',
  'bounce',
  'bounces',
  'mailerdaemon',
  'postmaster',
  'notification',
  'notifications',
  'notify',
  'automailer',
  'autoreply',
  'autoresponder',
  'unsubscribe',
  'newsletter',
  'newsletters',
  'mailer',
  'noreplyalerts',
]);

/** Prefixes that mark a machine address even when a campaign id follows. */
const MACHINE_PREFIXES = ['noreply', 'donotreply', 'dontreply', 'bounce', 'mailerdaemon'];

/** Strip the separators senders vary on, so one token covers every spelling. */
function foldLocalPart(local: string): string {
  return local.toLowerCase().replace(/[.\-_+]/g, '');
}

/**
 * Should the reader offer to file this sender? False for a blank/malformed address and
 * for anything that names itself automated. Case- and separator-insensitive.
 */
export function isPromptableSender(address: string | null | undefined): boolean {
  const addr = address?.trim().toLowerCase() ?? '';
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return false; // blank or not an address
  if (!addr.slice(at + 1).includes('.')) return false; // no real domain to file

  const local = foldLocalPart(addr.slice(0, at));
  if (MACHINE_LOCAL_PARTS.has(local)) return false;
  return !MACHINE_PREFIXES.some((prefix) => local.startsWith(prefix));
}
