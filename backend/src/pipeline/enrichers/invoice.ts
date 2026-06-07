/**
 * `invoice` — deterministic invoice / receipt enricher (ROADMAP Phase 4).
 *
 * Extracts the payment-relevant facts an invoice or receipt carries in its body
 * text — Norwegian **KID**, **IBAN**, Norwegian **account number** (kontonummer),
 * the **amount** to pay, and the **due date** (forfallsdato) — by deterministic
 * regex + **check-digit validation**. No LLM (Phase 5), no PDF-text extraction
 * (deferred): body text/HTML only.
 *
 * Classification: `search` (passive-by-default, ARCHITECTURE §14 / the ROADMAP
 * anti-chore guardrail). The extracted facts feed the search index + provenance and
 * the future Purchase Object / Evidence Locker — surfaced in-message ("what's the
 * KID for this bill"), NOT a notification stream and NOT a payment chore. Because it
 * is `search`-kind it runs on ALL tiers (old receipts stay searchable) and emits NO
 * proposals — an operational "this bill is due" reminder would be a separate
 * opt-in, Tier-0-gated enricher (not built here), so a years-deep backfill can never
 * fire a stale "pay this now" nudge.
 *
 * False-positive discipline (the explicit ROADMAP gripe that `package` "lacks a
 * digit check"): every numeric identifier is **checksum-validated** before it is
 * trusted — KID by MOD-10 (Luhn) *or* MOD-11, IBAN by MOD-97, the account number by
 * the Norwegian MOD-11. Bare digit runs that fail their check are discarded, so an
 * order number or phone number is never mistaken for a KID/account. Norwegian +
 * English labels and number/date formats are both handled.
 */
import type { Enricher, EnricherContext, EnricherResult } from '../types.js';

/** A monetary amount parsed from the body. */
export interface InvoiceAmount {
  /** Numeric value in major units (e.g. 1234.56). */
  value: number;
  /** ISO-ish currency code (NOK/USD/EUR/…); best-effort from symbol/word. */
  currency: string;
  /** The original substring it was parsed from (provenance). */
  raw: string;
}

/** The normalised invoice/receipt facts for one message (one bill per mail). */
export interface InvoiceFacts {
  /** Validated KID payment references (MOD-10 or MOD-11), deduped. */
  kids: string[];
  /** Validated IBANs (MOD-97), normalised uppercase, no spaces, deduped. */
  ibans: string[];
  /** Validated Norwegian account numbers (11-digit MOD-11), formatted dddd.dd.ddddd. */
  accounts: string[];
  /** Best amount to pay, when derivable (nearest a total label, else the largest). */
  amount: InvoiceAmount | null;
  /** Due date as ISO 8601 (YYYY-MM-DD), when a labelled date is present. */
  dueDate: string | null;
}

// --- Check-digit validators -------------------------------------------------------------

/** MOD-10 (Luhn) over a digit string, control digit included. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * MOD-11 over a digit string: the last digit is the control, the preceding digits
 * are weighted right-to-left by the repeating sequence 2,3,4,5,6,7. Used for both KID
 * (the issuer may pick MOD-10 or MOD-11) and the 11-digit Norwegian account number.
 */
function mod11Valid(digits: string): boolean {
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 2; i >= 0; i--) {
    sum += (digits.charCodeAt(i) - 48) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  const control = remainder === 0 ? 0 : 11 - remainder;
  if (control === 10) return false; // not representable as a single digit
  return control === digits.charCodeAt(digits.length - 1) - 48;
}

/** A KID is valid if its check digit satisfies MOD-10 *or* MOD-11 (issuer's choice). */
function kidValid(digits: string): boolean {
  if (digits.length < 2 || digits.length > 25) return false;
  return luhnValid(digits) || mod11Valid(digits);
}

/** MOD-97 IBAN validation (ISO 13616): rearrange, letters→numbers, remainder === 1. */
function ibanValid(normalised: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(normalised)) return false;
  if (normalised.length < 15 || normalised.length > 34) return false;
  const rearranged = normalised.slice(4) + normalised.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const chunk = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (let i = 0; i < chunk.length; i++) {
      remainder = (remainder * 10 + (chunk.charCodeAt(i) - 48)) % 97;
    }
  }
  return remainder === 1;
}

// --- Text helpers -----------------------------------------------------------------------

/** Coarse gate marker so non-invoice mail skips the work entirely (NO + EN). */
const HINT =
  /faktura|invoice|kvittering|receipt|\bkid\b|kidnummer|forfallsdato|forfall|betalingsfrist|due\s*date|amount\s*due|å\s*betale|beløp|\biban\b|kontonummer|kontonr|order\s*confirmation|ordrebekreftelse/i;

/** Very light HTML→text strip for the regex routes (markup-free, entity-decoded). */
function stripHtml(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Push a value into a deduped accumulator preserving first-seen order. */
function pushUnique(out: string[], value: string): void {
  if (!out.includes(value)) out.push(value);
}

// --- KID --------------------------------------------------------------------------------

/** KID anchored on its label (`KID`, `KID-nummer`, `KIDnr`): digits, checksum-gated. */
const KID_RE = /\bKID(?:[-\s]?(?:nummer|nr))?\b\.?\s*:?\s*([\d][\d\s]{0,30}\d|\d)/gi;

function extractKids(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(KID_RE)) {
    const digits = (m[1] ?? '').replace(/\D/g, '');
    if (kidValid(digits)) pushUnique(out, digits);
  }
  return out;
}

// --- IBAN -------------------------------------------------------------------------------

// IBANs print either run-together or in space-separated groups of four (the space can
// fall right after the country/check digits), so allow an optional space before every
// BBAN char and let the MOD-97 check reject anything that isn't a real IBAN.
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;

function extractIbans(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IBAN_RE)) {
    const norm = m[0].replace(/\s+/g, '').toUpperCase();
    if (ibanValid(norm)) pushUnique(out, norm);
  }
  return out;
}

// --- Norwegian account number -----------------------------------------------------------

// Distinctive printed form dddd.dd.ddddd (dots or spaces); the MOD-11 check is the filter.
const ACCOUNT_DOTTED_RE = /\b(\d{4})[.\s](\d{2})[.\s](\d{5})\b/g;
// Bare 11-digit run — ambiguous (org/phone numbers), so only trusted near a keyword.
const ACCOUNT_PLAIN_RE = /\b(\d{11})\b/g;
const ACCOUNT_KEYWORD = /kontonummer|kontonr|konto|account\s*(?:no|number|nr)/i;

/** Format an 11-digit account number canonically as dddd.dd.ddddd. */
function formatAccount(digits: string): string {
  return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`;
}

function extractAccounts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ACCOUNT_DOTTED_RE)) {
    const digits = m[1]! + m[2]! + m[3]!;
    if (mod11Valid(digits)) pushUnique(out, formatAccount(digits));
  }
  if (ACCOUNT_KEYWORD.test(text)) {
    for (const m of text.matchAll(ACCOUNT_PLAIN_RE)) {
      const digits = m[1]!;
      if (mod11Valid(digits)) pushUnique(out, formatAccount(digits));
    }
  }
  return out;
}

// --- Amount -----------------------------------------------------------------------------

/** Currency symbol/word → ISO-ish code. `kr` defaults to NOK (Norwegian context). */
const CURRENCY: Record<string, string> = {
  kr: 'NOK',
  nok: 'NOK',
  sek: 'SEK',
  dkk: 'DKK',
  usd: 'USD',
  eur: 'EUR',
  gbp: 'GBP',
  chf: 'CHF',
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
};
const CUR_WORD = 'kr|nok|sek|dkk|usd|eur|gbp|chf|\\$|€|£';
// A "money-shaped" number, ordered most-specific first: grouped-with-decimal
// (1.234,56), plain-with-decimal (1500,00 / 12.34), grouped integer (1 234), then a
// bare integer capped at 7 digits. The cap + decimal/grouping requirement is what
// stops a long bare id (a KID, account or order number) sitting next to `kr` from
// being read as an amount.
const NUM = '\\d{1,3}(?:[ .,]\\d{3})+[.,]\\d{2}|\\d+[.,]\\d{2}|\\d{1,3}(?:[ .,]\\d{3})+|\\d{1,7}';
// Currency before the number, or after it; the digit-only boundary guards keep the
// number from starting/ending mid-run of a longer digit string (a KID/account/order
// number next to `kr`) while still allowing trailing sentence punctuation.
const AMOUNT_RE = new RegExp(
  `(?:(${CUR_WORD})\\s*((?:${NUM}))(?!\\d)|(?<!\\d)((?:${NUM}))\\s*(${CUR_WORD}))`,
  'gi',
);
// A "this is the total" label, used to prefer the primary amount over incidental ones.
const TOTAL_LABEL =
  /total|å\s*betale|amount\s*due|sum|beløp\s*(?:å\s*betale)?|to\s*pay|grand\s*total/i;

/**
 * Parse a printed number into a numeric value, tolerating both Norwegian (`1.234,56`)
 * and English (`1,234.56`) grouping. The decimal separator is the last `.`/`,` when
 * it is followed by exactly two digits; otherwise both are treated as grouping.
 */
function parseNumber(s: string): number | null {
  let t = s.replace(/[^\d.,]/g, '');
  if (!t) return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  let dec: string | null = null;
  if (lastComma >= 0 && lastDot >= 0) {
    dec = lastComma > lastDot ? ',' : '.';
  } else if (lastComma >= 0) {
    dec = /,\d{2}$/.test(t) ? ',' : null;
  } else if (lastDot >= 0) {
    dec = /\.\d{2}$/.test(t) ? '.' : null;
  }
  if (dec) {
    const group = dec === ',' ? '.' : ',';
    t = t.split(group).join('').replace(dec, '.');
  } else {
    t = t.replace(/[.,]/g, '');
  }
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

interface AmountHit extends InvoiceAmount {
  index: number;
}

function extractAmount(text: string): InvoiceAmount | null {
  const hits: AmountHit[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const curTok = (m[1] ?? m[4] ?? '').toLowerCase();
    const numTok = m[2] ?? m[3] ?? '';
    const value = parseNumber(numTok);
    if (value === null) continue;
    const currency = CURRENCY[curTok] ?? curTok.toUpperCase();
    hits.push({ value, currency, raw: m[0].trim(), index: m.index ?? 0 });
  }
  if (hits.length === 0) return null;

  // Prefer an amount sitting just after a total/"å betale" label (the bill's headline
  // figure); fall back to the largest value when no label is nearby.
  let best: AmountHit | null = null;
  for (const h of hits) {
    const before = text.slice(Math.max(0, h.index - 40), h.index);
    if (TOTAL_LABEL.test(before)) {
      best = h;
      break;
    }
  }
  if (!best) best = hits.reduce((a, b) => (b.value > a.value ? b : a));
  return { value: best.value, currency: best.currency, raw: best.raw };
}

// --- Due date ---------------------------------------------------------------------------

const DUE_LABEL =
  /forfallsdato|forfall|betalingsfrist|due\s*date|payment\s*due|pay(?:able)?\s*(?:by|before)|betal(?:es)?\s*(?:innen|før)/i;

/** NO + EN month-name → 1-based month index (3-letter prefix match). */
const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  mai: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  okt: 10,
  nov: 11,
  dec: 12,
  des: 12,
};

const pad = (n: number): string => String(n).padStart(2, '0');
const fullYear = (y: number): number => (y < 100 ? 2000 + y : y);

/** Validate a y/m/d triple and emit ISO, or null when out of range. */
function toIso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${fullYear(y)}-${pad(mo)}-${pad(d)}`;
}

/** Extract the first date in a short window, trying ISO, numeric day-first, then named. */
function dateInWindow(win: string): string | null {
  // ISO yyyy-mm-dd
  const iso = win.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const r = toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (r) return r;
  }
  // Numeric day-first dd.mm.yyyy | dd/mm/yy (Norwegian/European convention)
  const num = win.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})\b/);
  if (num) {
    const r = toIso(Number(num[3]), Number(num[2]), Number(num[1]));
    if (r) return r;
  }
  // Named "15. juni 2026" / "15 June 2026"
  const dmy = win.match(/\b(\d{1,2})\.?\s*([A-Za-zæøåÆØÅ]{3,})\.?\s*(\d{4})\b/);
  if (dmy) {
    const mo = MONTHS[dmy[2]!.slice(0, 3).toLowerCase()];
    if (mo) {
      const r = toIso(Number(dmy[3]), mo, Number(dmy[1]));
      if (r) return r;
    }
  }
  // Named "June 15, 2026"
  const mdy = win.match(/\b([A-Za-zæøåÆØÅ]{3,})\.?\s*(\d{1,2}),?\s*(\d{4})\b/);
  if (mdy) {
    const mo = MONTHS[mdy[1]!.slice(0, 3).toLowerCase()];
    if (mo) {
      const r = toIso(Number(mdy[3]), mo, Number(mdy[2]));
      if (r) return r;
    }
  }
  return null;
}

/** Only a date *labelled* as a due date is returned — never a guessed bare date. */
function extractDueDate(text: string): string | null {
  const re = new RegExp(DUE_LABEL.source, 'gi');
  for (const m of text.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length;
    const win = text.slice(start, start + 40);
    const iso = dateInWindow(win);
    if (iso) return iso;
  }
  return null;
}

// --- Enricher ---------------------------------------------------------------------------

function extractInvoice(text: string): InvoiceFacts | null {
  const kids = extractKids(text);
  const ibans = extractIbans(text);
  const accounts = extractAccounts(text);
  const amount = extractAmount(text);
  const dueDate = extractDueDate(text);
  const hasAny = kids.length > 0 || ibans.length > 0 || accounts.length > 0 || amount || dueDate;
  if (!hasAny) return null;
  return { kids, ibans, accounts, amount, dueDate };
}

export const invoiceEnricher: Enricher = {
  name: 'invoice',
  version: 1,
  kind: 'search',
  // Cheap gate: skip mail with no invoice/receipt marker in either body part.
  applies(message) {
    return Boolean(
      (message.bodyText && HINT.test(message.bodyText)) ||
      (message.bodyHtml && HINT.test(message.bodyHtml)),
    );
  },
  run(ctx: EnricherContext): EnricherResult {
    const { bodyText, bodyHtml } = ctx.message;
    const text = bodyText?.trim() || (bodyHtml ? stripHtml(bodyHtml) : '');
    const invoice = text ? extractInvoice(text) : null;
    return { result: { invoice } };
  },
};
