/**
 * `invoice` — deterministic invoice / receipt enricher (ARCHITECTURE §14).
 *
 * Extracts the payment-relevant facts an invoice or receipt carries in its body
 * text — Norwegian **KID**, **IBAN**, Norwegian **account number** (kontonummer),
 * the **amount** to pay, and the **due date** (forfallsdato) — by deterministic
 * regex + **check-digit validation**. No LLM, no PDF-text extraction
 * (deferred): body text/HTML, subject and attachment *names* only.
 *
 * It first decides what the message **is** — an `invoice` (a bill, its reminder, a
 * credit note) or a `receipt` (proof of payment) — and which attachments are that
 * document; only a message that is one keeps its identifiers (see Classification
 * below). Anything else yields `invoice: null`.
 *
 * Classification: `search` (passive-by-default, ARCHITECTURE §14 / the
 * anti-chore guardrail). The extracted facts are read through `pipeline/facts-read.ts`
 * by the reader's payment card ("what's the KID for this bill"), the `is:invoice` /
 * `is:receipt` / `is:bill` / `has:kid` search operators, and the read-only billing
 * export (`pipeline/billing-export.ts`) — NOT a notification stream and NOT a payment
 * chore. Because it
 * is `search`-kind it runs on ALL tiers (old receipts stay searchable) and emits NO
 * proposals — an operational "this bill is due" reminder would be a separate
 * opt-in, Tier-0-gated enricher (not built here), so a years-deep backfill can never
 * fire a stale "pay this now" nudge.
 *
 * False-positive discipline (the original gripe that `package` "lacked a
 * digit check"): every numeric identifier is **checksum-validated** before it is
 * trusted — KID by MOD-10 (Luhn) *or* MOD-11, IBAN by MOD-97, the account number by
 * the Norwegian MOD-11. Bare digit runs that fail their check are discarded, so an
 * order number or phone number is never mistaken for a KID/account. Norwegian +
 * English labels and number/date formats are both handled.
 */
import type { BillingKind } from '@maily/shared';
import type {
  Enricher,
  EnricherContext,
  EnricherResult,
  PipelineAttachment,
  PipelineMessage,
} from '../types.js';

/** A monetary amount parsed from the body. */
export interface InvoiceAmount {
  /** Numeric value in major units (e.g. 1234.56). */
  value: number;
  /** ISO-ish currency code (NOK/USD/EUR/…); best-effort from symbol/word. */
  currency: string;
  /** The original substring it was parsed from (provenance). */
  raw: string;
}

/** An attachment that is the invoice or receipt document itself. */
export interface BillingDocument {
  attachmentId: string;
  kind: BillingKind;
}

/** The normalised invoice/receipt facts for one message (one bill per mail). */
export interface InvoiceFacts {
  /** What the message is: a bill (or its reminder / credit note), or proof of payment. */
  kind: BillingKind;
  /** Attachments that are the invoice/receipt document, by name or as a bill's sole PDF. */
  documents: BillingDocument[];
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
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
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
    // "Totalt å betale 0,00" on an already-settled line is not the bill's figure.
    if (h.value > 0 && TOTAL_LABEL.test(before)) {
      best = h;
      break;
    }
  }
  if (!best) best = hits.reduce((a, b) => (b.value > a.value ? b : a));
  return { value: best.value, currency: best.currency, raw: best.raw };
}

/** True when a non-zero amount sits right after a total label ("Totalt kr 1 299,00"). */
function hasLabelledTotal(text: string): boolean {
  for (const m of text.matchAll(AMOUNT_RE)) {
    const value = parseNumber(m[2] ?? m[3] ?? '');
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    if (value && TOTAL_LABEL.test(before)) return true;
  }
  return false;
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

// --- Classification ---------------------------------------------------------------------
//
// A checksum-valid number is not a bill: a signature carries the sender's own account
// number, a hosting provider's footer prints its IBAN under every login mail, and a
// customer-service thread passes a refund account back and forth. So the identifiers
// above are kept only once the message itself reads as an invoice or a receipt: the
// subject says so and the body backs it up, an attachment is named as one, a body lead
// says so, or a labelled KID sits next to an amount or a due date.

/** A bill (to pay, or a reminder of one) — and credit notes, which settle one. */
const INVOICE_WORDS = String.raw`faktura(?!nett)|(?<![a-z])invoice|rechnung|kreditnota|credit\s*note|betalingsp[åa]minnelse|betalingsvarsel|purring|inkassovarsel|payment\s+reminder|betalingsinformasjon|payment\s+information|due\s+date|late\s+fee|purregebyr|missed\s+(?:your\s+)?payment|request\s+for\s+payment|payment\s+request|betalingsforesp[øo]rsel|manglende\s+(?:inn)?betaling|payment\s+(?:is\s+)?(?:due|overdue|missing)|ubetalt|unpaid`;
/** Proof that something was paid. */
const RECEIPT_WORDS = String.raw`kvittering|receipt|quittung|betalings?bekreftelse|payment\s+(?:received|confirmation|confirmed|sent)|(?:betaling|betalingen|innbetaling)\s+(?:er\s+)?(?:mottatt|registrert|bekreftet)|mottatt\s+(?:din\s+)?betaling|received\s+(?:from\s+)?your\s+payment|bekreftelse\s+(?:p[åa]\s+)?betaling|takk\s+for\s+(?:din\s+)?betaling|thank\s+you\s+for\s+your\s+payment|you\s+sent\s+a\s+payment|got\s+your\b.{0,40}\bpayment|payment\b.{0,40}\bsuccessful`;

/**
 * An order confirmation — the purchase record. Counted as a receipt once it shows what
 * was paid (a labelled total) or carries the order as a PDF; a bare "we got your order"
 * stays out.
 */
const ORDER_WORDS =
  /ordrebekreftelse|ordrebekræftelse|order\s+confirm|bestillingsbekreftelse|bekreftelse\s+p[åa]\s+(?:bestilling|ordre)|bestillingsoversikt|bestilling\s+registrert|takk\s+for\s+(?:din\s+|at\s+du\s+)?(?:bestilling|ordre|handelen|kj[øo]pet)|thanks?\s+(?:you\s+)?for\s+your\s+(?:order|purchase)|kj[øo]psbekreftelse|purchase\s+confirmation/i;

/**
 * Named as a receipt (or a reminder), but not about money: a form or application
 * received, an exam hand-in, a read receipt, an expiring card, a payslip.
 */
const NOT_BILLING =
  /acknowledge?ment\s+receipt|read\s+receipt|lesebekreftelse|skjema|s[øo]knad|henvendelse|innsynskrav|kvittering\s+for:\s|mottakskvittering|request\s+received|submission|registreringen\s+er|eksamen|nabovarsel|bakgrunnssjekk|bibliote[kc]|library|betalingskort|payment\s+(?:card|method)|l[øo]nnsslipp|payslip/i;
/** Senders whose "kvittering" / "purring" is a loan, not a purchase: libraries. */
const NOT_BILLING_SENDER = /bibliote[kc]|folkebibl|library|bibsok|bibsys/i;

/** `Re:` / `SV:` / `AW:` — a conversation about a bill, not the bill itself. */
const REPLY_PREFIX = /^\s*(?:re|sv|aw|antw)\s*:/i;

/** Lead-of-body phrasings for a message whose subject doesn't say what it is. */
const INVOICE_LEAD =
  /(?:ny|din|vedlagt|vedlagte)\s+faktura|(?:mottatt|received)\s+(?:en|an)\s+(?:faktura|invoice)|your\s+(?:new\s+|latest\s+)?invoice|invoice\s+(?:is\s+)?attached|attached\s+(?:is\s+)?(?:your\s+)?invoice|fakturanummer|fakturanr|invoice\s+(?:number|no\.?|#)/i;
const RECEIPT_LEAD =
  /here(?:'|’)?s\s+your\s+receipt|this\s+is\s+your\s+receipt|your\s+receipt|din\s+kvittering|kvittering\s+for\s+(?:ditt|din|kj[øo]p)|payment\s+receipt|takk\s+for\s+(?:din\s+)?betaling|thanks?\s+(?:you\s+)?for\s+your\s+payment|we(?:'|’)?ve\s+received\s+your\s+payment|vi\s+har\s+mottatt\s+(?:din\s+)?betaling/i;
/** How far into the body a lead phrase counts (past it is footer / small print). */
const LEAD_CHARS = 1500;

/** Attachment names that are the invoice / receipt document. */
const INVOICE_FILE = /faktura|invoice|rechnung|kreditnota|credit[\s_-]*note/i;
const RECEIPT_FILE = /kvittering|receipt|quittung/i;
/** PDFs that ride along with a bill but aren't it: terms, return forms, labels, tickets. */
const NOT_DOCUMENT_FILE =
  /angre|vilk[åa]r|terms|agb|withdrawal|retur|policy|betingelser|avtale|agreement|label|etikett|billett|ticket|boarding|manual|guide|brosjyre|katalog/i;
/** Formats an invoice or receipt actually comes in (not a signature, calendar or vCard). */
const DOCUMENT_FILE_TYPE = /\.(?:pdf|xml|html?|jpe?g|png|heic)$/i;
const DOCUMENT_MIME = /pdf|xml|html|^image\//i;

const isPdf = (a: PipelineAttachment): boolean =>
  /pdf/i.test(a.mimeType ?? '') || /\.pdf$/i.test(a.filename ?? '');

/**
 * Which kind a phrase names. Naming both ("Faktura / Kvittering", "Payment received for
 * invoice 51722") is a paid bill, so a receipt.
 */
function kindIn(s: string, invoice: RegExp, receipt: RegExp): BillingKind | null {
  if (receipt.test(s)) return 'receipt';
  return invoice.test(s) ? 'invoice' : null;
}

const INVOICE_SUBJECT = new RegExp(INVOICE_WORDS, 'i');
const RECEIPT_SUBJECT = new RegExp(RECEIPT_WORDS, 'i');
/** Either vocabulary, for a body lead that seconds what the subject says. */
const LEAD_INVOICE = new RegExp(`${INVOICE_WORDS}|${INVOICE_LEAD.source}`, 'i');
const LEAD_RECEIPT = new RegExp(`${RECEIPT_WORDS}|${RECEIPT_LEAD.source}`, 'i');

/** The attachments that are the invoice/receipt, by their own names. */
function namedDocuments(attachments: PipelineAttachment[]): BillingDocument[] {
  const out: BillingDocument[] = [];
  for (const a of attachments) {
    const name = a.filename ?? '';
    if (!name) continue;
    if (!DOCUMENT_FILE_TYPE.test(name) && !DOCUMENT_MIME.test(a.mimeType ?? '')) continue;
    const kind = kindIn(name, INVOICE_FILE, RECEIPT_FILE);
    if (kind && !NOT_BILLING.test(name)) out.push({ attachmentId: a.id, kind });
  }
  return out;
}

/**
 * The one PDF on a message already known to be a bill is that bill, whatever it's called
 * (`223630010407.pdf`, `Vedlegg_2603.pdf`), once the PDFs that ride along (terms, a
 * return form) are set aside. Two or more candidates left: no guess.
 */
function soleDocument(attachments: PipelineAttachment[], kind: BillingKind): BillingDocument[] {
  const pdfs = attachments.filter((a) => isPdf(a) && !NOT_DOCUMENT_FILE.test(a.filename ?? ''));
  return pdfs.length === 1 ? [{ attachmentId: pdfs[0]!.id, kind }] : [];
}

/** Invoice when every named document is one; a receipt anywhere means it was paid. */
function kindOfDocuments(docs: BillingDocument[]): BillingKind | null {
  if (docs.length === 0) return null;
  return docs.some((d) => d.kind === 'receipt') ? 'receipt' : 'invoice';
}

/** What the message is, from its subject, attachments and body, or null for neither. */
function classify(
  subject: string,
  from: string,
  text: string,
  docs: BillingDocument[],
  facts: Omit<InvoiceFacts, 'kind' | 'documents'>,
  attachments: PipelineAttachment[],
): BillingKind | null {
  const hasPdf = attachments.some(isPdf);
  if (NOT_BILLING.test(subject) || NOT_BILLING_SENDER.test(from)) return null;
  const reply = REPLY_PREFIX.test(subject);
  const hasId = facts.kids.length > 0 || facts.accounts.length > 0 || facts.ibans.length > 0;

  // A named document is the strongest signal there is — even on a reply, it's attached.
  const docKind = kindOfDocuments(docs);

  // The subject names it, and the body carries something a bill has.
  // Or the body opens by saying so too — a bill that only links to itself ("Fakturaen kan
  // hentes via denne lenken") carries no sum to back it with.
  const lead = text.slice(0, LEAD_CHARS);
  const subjectKind = kindIn(subject, INVOICE_SUBJECT, RECEIPT_SUBJECT);
  if (subjectKind) {
    const backed = reply
      ? facts.kids.length > 0 || docKind !== null
      : facts.amount !== null ||
        facts.dueDate !== null ||
        hasId ||
        hasPdf ||
        kindIn(lead, LEAD_INVOICE, LEAD_RECEIPT) !== null;
    if (backed) return subjectKind;
  }
  if (docKind) return docKind;
  if (reply) return null;

  // The body opens by saying what it is, and there's a sum.
  const leadKind = kindIn(lead, INVOICE_LEAD, RECEIPT_LEAD);
  if (leadKind && (facts.amount !== null || facts.kids.length > 0)) return leadKind;

  // An order confirmation that shows what was paid, or carries the order itself.
  if (
    ORDER_WORDS.test(subject) &&
    (hasLabelledTotal(text) || soleDocument(attachments, 'receipt').length > 0)
  ) {
    return 'receipt';
  }

  // A labelled, check-digit-valid KID with a sum or a due date is a bill by itself.
  if (facts.kids.length > 0 && (facts.amount !== null || facts.dueDate !== null)) return 'invoice';
  return null;
}

/**
 * The body to read: the text part, unless it's a stub standing in for the HTML ("To view
 * the message, please use an HTML compatible email viewer!") — then the HTML, stripped.
 */
function bodyOf({ bodyText, bodyHtml }: PipelineMessage): string {
  const text = bodyText?.trim() ?? '';
  if (!bodyHtml) return text;
  const html = stripHtml(bodyHtml);
  // A real text part is about as long as the HTML's text; a stub is short and much shorter.
  const stub = text.length < 200 || text.length * 2 < html.length;
  return stub && html.length > text.length ? html : text;
}

// --- Enricher ---------------------------------------------------------------------------

/** Every fact for one message, or null when it is neither an invoice nor a receipt. */
export function extractInvoice(message: PipelineMessage): InvoiceFacts | null {
  const text = bodyOf(message);
  const subject = message.subject ?? '';
  const attachments = message.attachments;
  const facts = {
    kids: extractKids(text),
    ibans: extractIbans(text),
    accounts: extractAccounts(text),
    amount: extractAmount(text),
    dueDate: extractDueDate(text),
  };
  const named = namedDocuments(attachments);
  const from = message.fromAddress ?? '';
  const kind = classify(subject, from, text, named, facts, attachments);
  if (!kind) return null;
  const documents = named.length > 0 ? named : soleDocument(attachments, kind);
  return { kind, documents, ...facts };
}

/** Cheap gate: some marker of a bill in the subject, an attachment name or the body. */
const GATE = new RegExp(`${HINT.source}|${INVOICE_WORDS}|${RECEIPT_WORDS}`, 'i');

export const invoiceEnricher: Enricher = {
  name: 'invoice',
  // v2: classifies invoice vs receipt and gates the identifiers on it; finds documents.
  version: 2,
  kind: 'search',
  applies(message) {
    return Boolean(
      (message.subject && GATE.test(message.subject)) ||
      message.attachments.some((a) => a.filename && GATE.test(a.filename)) ||
      (message.bodyText && GATE.test(message.bodyText)) ||
      (message.bodyHtml && GATE.test(message.bodyHtml)),
    );
  },
  run(ctx: EnricherContext): EnricherResult {
    return { result: { invoice: extractInvoice(ctx.message) } };
  },
};
