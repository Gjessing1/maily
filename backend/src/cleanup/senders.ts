/**
 * Sender grouping key for the cleanup slices. Grouping purely by domain breaks down on
 * the big consumer providers — "gmail.com" is not a sender, it's thousands of unrelated
 * people — so the key is the **full address for freemail/consumer domains** and the
 * domain otherwise (a corporate/bulk domain genuinely is one sender). One SQL expression
 * shared by the preview, drill-down and execute paths so a group label always round-trips
 * (`scope.domain` on execute is compared against this same expression), plus a TS mirror
 * for the JS-side paths.
 */
import { sql, type SQL } from 'drizzle-orm';

/**
 * Consumer providers matched by their **first DNS label**, covering country variants
 * (hotmail.no, yahoo.co.uk, live.se, …) without enumerating TLDs. Only distinctive labels
 * belong here — a generic label like `mail` would swallow corporate bulk subdomains
 * (mail.epicgames.com). A false positive is harmless (finer, per-address grouping);
 * a false negative just falls back to domain grouping.
 */
const FREEMAIL_LABELS = [
  'gmail',
  'googlemail',
  'hotmail',
  'outlook',
  'live',
  'yahoo',
  'ymail',
  'icloud',
  'protonmail',
  'gmx',
] as const;

/** Consumer providers matched by exact domain (no meaningful country variants). */
const FREEMAIL_EXACT = [
  'me.com',
  'mac.com',
  'aol.com',
  'msn.com',
  'mail.ru',
  'proton.me',
  'pm.me',
  'web.de',
  'fastmail.com',
  'fastmail.fm',
  'mailbox.org',
  'zohomail.com',
  'yandex.ru',
  'yandex.com',
  // Norwegian consumer ISP mail.
  'online.no',
  'getmail.no',
  'start.no',
  'epost.no',
] as const;

const EXACT_SET: ReadonlySet<string> = new Set(FREEMAIL_EXACT);
const LABEL_SET: ReadonlySet<string> = new Set(FREEMAIL_LABELS);

/** True when the (lowercased) domain is a consumer provider — group by full address. */
export function isFreemailDomain(domain: string): boolean {
  if (EXACT_SET.has(domain)) return true;
  const dot = domain.indexOf('.');
  return dot > 0 && LABEL_SET.has(domain.slice(0, dot));
}

/**
 * The grouping key of a sender address: '(unknown)' when missing/domain-less, the full
 * lowercased address for freemail domains, else the lowercased domain. Must agree with
 * {@link SENDER_KEY} — both feed the same equality checks across preview/drill/execute.
 */
export function senderKeyOf(address: string | null | undefined): string {
  if (!address) return '(unknown)';
  const at = address.indexOf('@');
  if (at < 0) return '(unknown)';
  const domain = address.slice(at + 1).toLowerCase();
  return isFreemailDomain(domain) ? address.toLowerCase() : domain;
}

const inList = (items: readonly string[]): SQL =>
  sql.join(
    items.map((i) => sql`${i}`),
    sql`, `,
  );

/** `m.from_address`'s lowercased domain part (callers guarantee an '@' is present). */
const DOMAIN_SQL = sql.raw(`lower(substr(m.from_address, instr(m.from_address, '@') + 1))`);

/**
 * SQL twin of {@link senderKeyOf}, against a `messages m` alias. The label check takes the
 * domain's first label via `substr(domain, 1, instr(domain, '.') - 1)` — for a dot-less
 * domain `instr` is 0, the length is negative and SQLite yields '', which matches nothing.
 */
export const SENDER_KEY: SQL = sql`CASE
  WHEN m.from_address IS NULL OR instr(m.from_address, '@') = 0 THEN '(unknown)'
  WHEN ${DOMAIN_SQL} IN (${inList(FREEMAIL_EXACT)})
    OR substr(${DOMAIN_SQL}, 1, instr(${DOMAIN_SQL}, '.') - 1) IN (${inList(FREEMAIL_LABELS)})
    THEN lower(m.from_address)
  ELSE ${DOMAIN_SQL}
END`;
