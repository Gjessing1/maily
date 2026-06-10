/**
 * Cleanup keyword sets — English + Norwegian (ROADMAP Phase 6 "Master archive & Cleanup
 * Dashboard"). maily is bilingual, so every set carries both languages.
 *
 * Two roles:
 *  - PROTECTED_KEYWORDS — the HARD safety filter. Financial, legal/contract,
 *    account/security and medical/identity mail is *never* delete-eligible and never
 *    appears in a delete preset (ROADMAP "Risk & safety filters — HARD RULES"). Used to
 *    exclude these messages from every destructive slice.
 *  - COLD_KEEP_KEYWORDS — value markers (invoice/tax/contract …). A message carrying one
 *    is NOT a cold-storage-prune candidate even if old. A deliberate subset of the
 *    protected financial/legal terms (the cold heuristic from the roadmap:
 *    "older than N years AND body lacks invoice/tax/contract").
 *
 * Kept as plain arrays so they are reusable, unit-testable, and compile into both an
 * FTS5 MATCH expression (set-based slice queries) and a JS predicate (per-message check).
 * Matching is diacritic-insensitive at the FTS layer (the index uses
 * `remove_diacritics 2`), so e.g. `vilkar` still matches `vilkår`.
 */

/** Financial: invoices, receipts, payments, tax. */
const FINANCIAL = [
  'invoice',
  'receipt',
  'payment',
  'tax',
  'vat',
  'refund',
  'faktura',
  'kvittering',
  'betaling',
  'skatt',
  'mva',
  'regning',
  'kid',
  'refusjon',
];

/** Legal / contractual. */
const LEGAL = ['contract', 'agreement', 'terms', 'kontrakt', 'avtale', 'vilkår'];

/** Account & security (password resets, 2FA, login verification). */
const SECURITY = [
  'password',
  'security',
  'verify',
  'verification',
  'otp',
  'account',
  'passord',
  'sikkerhet',
  'verifiser',
  'innlogging',
  'konto',
  'engangskode',
];

/** Medical / identity. */
const MEDICAL = [
  'health',
  'medical',
  'prescription',
  'patient',
  'passport',
  'helse',
  'lege',
  'resept',
  'pasient',
  'personnummer',
  'fødselsnummer',
];

/**
 * The HARD safety filter set — protected categories union. Mail matching any of these
 * is excluded from every delete-eligible slice. De-duplicated.
 */
export const PROTECTED_KEYWORDS: string[] = [
  ...new Set([...FINANCIAL, ...LEGAL, ...SECURITY, ...MEDICAL]),
];

/**
 * Newsletter / bulk-mail markers — the deterministic "this is a mailing list blast"
 * heuristic for the newsletters cleanup slice. A message whose body carries an
 * unsubscribe affordance is almost always bulk mail; false positives are tolerable
 * because the slice only *suggests* (the HARD safety gate still applies on top, and
 * every deletion is user-confirmed). Phrases are allowed — they compile to FTS5
 * prefix-phrases (`"meld deg av"*`).
 */
export const NEWSLETTER_KEYWORDS: string[] = [
  'unsubscribe',
  'newsletter',
  'avmeld',
  'nyhetsbrev',
  'meld deg av',
];

/**
 * Cold-storage "keep" markers — the value terms from the roadmap's cold heuristic
 * (invoice / tax / contract). An old message carrying one of these is kept, not pruned.
 */
export const COLD_KEEP_KEYWORDS: string[] = [
  'invoice',
  'faktura',
  'tax',
  'skatt',
  'mva',
  'contract',
  'kontrakt',
  'avtale',
];
