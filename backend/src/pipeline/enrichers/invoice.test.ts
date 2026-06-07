/**
 * `invoice` enricher coverage (ROADMAP Phase 4). Pure unit tests over the enricher's
 * `run` — no DB, no pipeline wiring (the framework's queue/persist path is covered by
 * pipeline.test.ts). We pin the checksum-validated identifier extraction (KID MOD-10 /
 * MOD-11, IBAN MOD-97, the Norwegian MOD-11 account number), the bilingual amount /
 * due-date parsing, the false-positive discipline (bad check digits are dropped), that
 * it stays passive (search-kind, no proposals), and the cheap `applies` gate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { invoiceEnricher, type InvoiceFacts } from './invoice.js';

/** Minimal PipelineMessage stub — only the body fields the enricher reads. */
function msg(fields: {
  bodyText?: string | null;
  bodyHtml?: string | null;
}): Parameters<typeof invoiceEnricher.run>[0]['message'] {
  return {
    id: 'm1',
    accountId: 'a1',
    threadId: null,
    subject: null,
    fromName: null,
    fromAddress: null,
    to: [],
    cc: [],
    snippet: null,
    bodyText: fields.bodyText ?? null,
    bodyHtml: fields.bodyHtml ?? null,
    inReplyTo: null,
    references: null,
    sentAt: null,
    receivedAt: null,
    sourcePath: null,
  };
}

function run(fields: { bodyText?: string | null; bodyHtml?: string | null }): InvoiceFacts | null {
  const out = invoiceEnricher.run({ message: msg(fields), tier: 0 });
  assert.ok(!(out instanceof Promise), 'invoice.run should be synchronous');
  return (out.result as { invoice: InvoiceFacts | null }).invoice;
}

test('invoice: classification is passive search-kind with no proposals', () => {
  assert.equal(invoiceEnricher.kind, 'search');
  const out = invoiceEnricher.run({
    message: msg({ bodyText: 'Faktura — KID: 1234567897, å betale kr 100,00' }),
    tier: 0,
  });
  assert.ok(!(out instanceof Promise));
  assert.equal(out.proposals, undefined, 'invoice must not emit operational proposals');
});

test('invoice: valid KID (MOD-10/Luhn) is extracted', () => {
  // 123456789 + Luhn check digit 7 → 1234567897 passes MOD-10.
  const inv = run({ bodyText: 'Vennligst betal. KID-nummer: 1234567897. Takk.' });
  assert.deepEqual(inv?.kids, ['1234567897']);
});

test('invoice: valid KID (MOD-11) is extracted', () => {
  // 12345678 + MOD-11 control digit 5 → 123456785 passes MOD-11 (and not MOD-10).
  const inv = run({ bodyText: 'KID 123456785 for fakturaen din.' });
  assert.deepEqual(inv?.kids, ['123456785']);
});

test('invoice: a KID with a wrong check digit is rejected', () => {
  // 1234567890 fails both MOD-10 and MOD-11 → not a KID.
  const inv = run({ bodyText: 'Faktura KID 1234567890 here.' });
  assert.equal(inv, null);
});

test('invoice: KID requires its label (a bare valid-checksum number is ignored)', () => {
  // Same digits, no KID label and no other invoice marker → applies gate skips it.
  assert.equal(run({ bodyText: 'Reference 1234567897 thanks.' }), null);
});

test('invoice: valid IBAN (MOD-97) is normalised; spaces stripped', () => {
  // A known-valid IBAN, printed in groups of four.
  const inv = run({ bodyText: 'Invoice — pay to IBAN GB82 WEST 1234 5698 7654 32.' });
  assert.deepEqual(inv?.ibans, ['GB82WEST12345698765432']);
});

test('invoice: an IBAN with a broken checksum is rejected', () => {
  const inv = run({ bodyText: 'Invoice IBAN GB00WEST12345698765432 (bad checksum).' });
  assert.equal(inv?.ibans?.length ?? 0, 0);
});

test('invoice: Norwegian account number (dotted, MOD-11) is extracted + formatted', () => {
  // 12345678903 passes the MOD-11 account check; printed dotted.
  const inv = run({ bodyText: 'Faktura. Kontonummer 1234.56.78903 — beløp kr 50,00.' });
  assert.deepEqual(inv?.accounts, ['1234.56.78903']);
});

test('invoice: a bare 11-digit number needs an account keyword', () => {
  // Valid MOD-11 but no kontonr keyword and no dotted form → not trusted as an account.
  const inv = run({ bodyText: 'Faktura ref 12345678903, amount kr 50,00.' });
  assert.equal(inv?.accounts?.length ?? 0, 0);
});

test('invoice: Norwegian amount (1.234,56) parses to 1234.56 NOK', () => {
  const inv = run({ bodyText: 'Faktura. Å betale: kr 1.234,56 innen forfall.' });
  assert.equal(inv?.amount?.value, 1234.56);
  assert.equal(inv?.amount?.currency, 'NOK');
});

test('invoice: English amount ($1,234.56) parses to 1234.56 USD', () => {
  const inv = run({ bodyText: 'Receipt — total due $1,234.56 on this invoice.' });
  assert.equal(inv?.amount?.value, 1234.56);
  assert.equal(inv?.amount?.currency, 'USD');
});

test('invoice: the total-labelled amount wins over an incidental figure', () => {
  const inv = run({
    bodyText: 'Invoice. Shipping kr 99,00. Total to pay kr 1500,00. Thanks.',
  });
  assert.equal(inv?.amount?.value, 1500);
});

test('invoice: due date — Norwegian numeric (dd.mm.yyyy) → ISO', () => {
  const inv = run({ bodyText: 'Faktura. Forfallsdato: 15.06.2026. Beløp kr 100,00.' });
  assert.equal(inv?.dueDate, '2026-06-15');
});

test('invoice: due date — named month (NO + EN) → ISO', () => {
  assert.equal(run({ bodyText: 'Invoice. Due date: June 15, 2026.' })?.dueDate, '2026-06-15');
  assert.equal(run({ bodyText: 'Faktura. Forfall 15. juni 2026.' })?.dueDate, '2026-06-15');
});

test('invoice: an unlabelled date is not guessed as a due date', () => {
  // A date with no due/forfall label nearby → no dueDate (but amount still found).
  const inv = run({ bodyText: 'Faktura sendt 01.01.2026. Å betale kr 100,00.' });
  assert.equal(inv?.dueDate, null);
  assert.equal(inv?.amount?.value, 100);
});

test('invoice: HTML body is stripped and still extracted', () => {
  const html = '<html><body><p>Faktura</p><b>KID:</b> 1234567897<br>kr 100,00</body></html>';
  const inv = run({ bodyHtml: html });
  assert.deepEqual(inv?.kids, ['1234567897']);
  assert.equal(inv?.amount?.value, 100);
});

test('invoice: applies gate skips non-invoice mail', () => {
  assert.equal(invoiceEnricher.applies?.(msg({ bodyText: 'Lunch on Friday?' })), false);
  assert.equal(invoiceEnricher.applies?.(msg({ bodyText: 'Your faktura is attached.' })), true);
});

test('invoice: an invoice-marked mail with nothing extractable yields a null invoice', () => {
  const out = invoiceEnricher.run({
    message: msg({ bodyText: 'Your receipt is attached.' }),
    tier: 0,
  });
  assert.ok(!(out instanceof Promise));
  assert.equal((out.result as { invoice: InvoiceFacts | null }).invoice, null);
});
