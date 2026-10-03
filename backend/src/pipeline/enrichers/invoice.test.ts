/**
 * `invoice` enricher coverage (ARCHITECTURE §14). Pure unit tests over the enricher's
 * `run` — no DB, no pipeline wiring (the framework's queue/persist path is covered by
 * pipeline.test.ts). We pin the invoice-vs-receipt classification and the document
 * attachments it picks (the cases are shaped after real mail: a signature's account
 * number, a hosting footer's IBAN, link-only bills, form "kvitteringer"), the
 * checksum-validated identifier extraction (KID MOD-10 / MOD-11, IBAN MOD-97, the
 * Norwegian MOD-11 account number), the bilingual amount / due-date parsing, that it
 * stays passive (search-kind, no proposals), and the cheap `applies` gate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { invoiceEnricher, type InvoiceFacts } from './invoice.js';
import type { PipelineAttachment, PipelineMessage } from '../types.js';

interface Fields {
  subject?: string | null;
  fromAddress?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  attachments?: PipelineAttachment[];
}

/**
 * Minimal PipelineMessage stub — only the fields the enricher reads. The subject
 * defaults to an invoice's so the extraction tests below run on a classified message.
 */
function msg(fields: Fields): PipelineMessage {
  return {
    id: 'm1',
    accountId: 'a1',
    threadId: null,
    subject: fields.subject === undefined ? 'Faktura 1001 fra Rørlegger AS' : fields.subject,
    fromName: null,
    fromAddress: fields.fromAddress ?? 'faktura@example.no',
    to: [],
    cc: [],
    snippet: null,
    bodyText: fields.bodyText ?? null,
    bodyHtml: fields.bodyHtml ?? null,
    bodyCalendar: null,
    inReplyTo: null,
    references: null,
    sentAt: null,
    receivedAt: null,
    sourcePath: null,
    attachments: fields.attachments ?? [],
  };
}

function run(fields: Fields): InvoiceFacts | null {
  const m = msg(fields);
  if (invoiceEnricher.applies && !invoiceEnricher.applies(m)) return null;
  const out = invoiceEnricher.run({ message: m, tier: 0 });
  assert.ok(!(out instanceof Promise), 'invoice.run should be synchronous');
  return (out.result as { invoice: InvoiceFacts | null }).invoice;
}

function pdf(id: string, filename: string | null): PipelineAttachment {
  return { id, filename, mimeType: 'application/pdf', sizeBytes: 40_000 };
}

// --- Classification ---------------------------------------------------------------------

test('invoice: a signature account number in a conversation is not a bill', () => {
  // The sender's own kontonummer under every mail they write (and quoted in replies).
  const inv = run({
    subject: '10 pakker hundemat',
    bodyText: 'Hei, jeg vil gjerne bestille 10 pakker.\n\nMvh Lars\nKonto 1234.56.78903',
  });
  assert.equal(inv, null);
});

test('invoice: a footer IBAN under a login mail is not a bill', () => {
  const inv = run({
    subject: 'Your login data!',
    bodyText:
      'Here are your login details. Bank: IBAN GB82 WEST 1234 5698 7654 32. Invoice queries: billing@',
  });
  assert.equal(inv, null);
});

test('invoice: a bill with KID, account and amount is an invoice with its identifiers', () => {
  const inv = run({
    subject: 'Faktura fra Teknikkdeler',
    bodyText:
      'Å betale: 398,00 kr. Kontonummer 1234.56.78903. KID: 1234567897. Forfallsdato 02.10.2026',
  });
  assert.equal(inv?.kind, 'invoice');
  assert.deepEqual(inv?.kids, ['1234567897']);
  assert.deepEqual(inv?.accounts, ['1234.56.78903']);
  assert.equal(inv?.dueDate, '2026-10-02');
});

test('invoice: a payment reminder is an invoice', () => {
  const inv = run({
    subject: 'Upcoming due date for Flowtech',
    bodyText: 'Your payment of 469,00 kr is due soon.',
  });
  assert.equal(inv?.kind, 'invoice');
});

test('invoice: a link-only bill counts when the body opens by saying so', () => {
  // Tripletex / Walley style: no sum in the body, just a link to the invoice.
  const inv = run({
    subject: 'Faktura nummer 327 fra BKA Elektro AS',
    bodyText:
      'Du har mottatt en faktura fra BKA Elektro AS. Fakturaen kan hentes via denne lenken.',
  });
  assert.equal(inv?.kind, 'invoice');
});

test('invoice: a subject word with nothing behind it is not enough', () => {
  assert.equal(run({ subject: 'God Jul fra oss', bodyText: 'Riktig god jul!' }), null);
  assert.equal(
    run({ subject: 'Spørsmål om faktura', bodyText: 'Hei, når kommer den?' }),
    null,
    'a question mentioning an invoice, with no sum, document or lead',
  );
});

test('invoice: a receipt is a receipt, and its KID is not a bill to pay', () => {
  const inv = run({
    subject: 'Kvittering fra Kollekted By AS kr 510,00',
    bodyText: 'Takk for handelen. Totalt kr 510,00. KID 1234567897',
  });
  assert.equal(inv?.kind, 'receipt');
});

test('invoice: naming both invoice and receipt means paid — a receipt', () => {
  const both = { bodyText: 'Totalt kr 399,00' };
  assert.equal(run({ ...both, subject: 'Faktura / Kvittering fra Maximum.no' })?.kind, 'receipt');
  assert.equal(run({ ...both, subject: 'Payment Received for Invoice 51722' })?.kind, 'receipt');
});

test('invoice: a body that opens as a receipt, with a sum, is one whatever the subject', () => {
  const inv = run({
    subject: 'Your Tuesday evening trip',
    bodyText: "Here's your receipt. Total $12.40. Thanks for riding.",
  });
  assert.equal(inv?.kind, 'receipt');
});

test('invoice: a labelled KID with a sum is a bill even with no invoice wording', () => {
  const inv = run({ subject: 'Kontingent 2026', bodyText: 'KID: 1234567897. Beløp kr 650,00' });
  assert.equal(inv?.kind, 'invoice');
});

test('invoice: form and library "kvitteringer" are not receipts', () => {
  const body = { bodyText: 'Vi har mottatt din søknad. Gebyr kr 350.' };
  assert.equal(run({ ...body, subject: 'Kvittering på mottatt søknad' }), null);
  assert.equal(run({ ...body, subject: 'Kvittering på innsendt skjema' }), null);
  assert.equal(
    run({ subject: 'Kvittering', fromAddress: 'automat@asker.folkebibl.no', bodyText: 'Lån kr 0' }),
    null,
  );
});

test('invoice: a reply about a bill needs the bill itself attached', () => {
  const chat = { subject: 'Re: Faktura 41198', bodyText: 'Takk, betaler i morgen. 500 kr ok?' };
  assert.equal(run(chat), null);
  const withDoc = run({ ...chat, attachments: [pdf('a1', 'Faktura #1002.pdf')] });
  assert.equal(withDoc?.kind, 'invoice');
  assert.deepEqual(withDoc?.documents, [{ attachmentId: 'a1', kind: 'invoice' }]);
});

test('invoice: an order confirmation with a total (or its order PDF) is a receipt', () => {
  const total = run({
    subject: 'Ordrebekreftelse #257588',
    bodyText: 'Takk for handelen! Varer kr 70,00. Frakt kr 19,00. Totalt kr 89,00',
  });
  assert.equal(total?.kind, 'receipt');
  const withPdf = run({
    subject: 'Ordrebekreftelse 2118736748',
    bodyText: 'Se vedlegg.',
    attachments: [pdf('a1', 'Order confirmation.pdf'), pdf('a2', 'Angrerettskjema.pdf')],
  });
  assert.equal(withPdf?.kind, 'receipt');
  assert.deepEqual(withPdf?.documents, [{ attachmentId: 'a1', kind: 'receipt' }]);
  // "We got your order" with no total and no document stays out.
  assert.equal(run({ subject: 'Vi har mottatt din bestilling', bodyText: 'Takk!' }), null);
  assert.equal(run({ subject: 'Takk for bestillingen!', bodyText: 'Vi sender snart.' }), null);
});

// --- Documents --------------------------------------------------------------------------

test('invoice: an attachment named as an invoice makes the message one, and is the document', () => {
  const inv = run({
    subject: 'Your Cult Pens order has been dispatched',
    bodyText: 'Your parcel is on its way.',
    attachments: [
      pdf('a1', 'Invoice 295080 (emailed 2017-08-29).pdf'),
      pdf('a2', 'Returns form.pdf'),
    ],
  });
  assert.equal(inv?.kind, 'invoice');
  assert.deepEqual(inv?.documents, [{ attachmentId: 'a1', kind: 'invoice' }]);
});

test('invoice: a receipt attachment beside an invoice one means it was paid', () => {
  const inv = run({
    subject: 'Your order',
    bodyText: 'Thanks!',
    attachments: [pdf('a1', 'Invoice-4F2.pdf'), pdf('a2', 'Receipt-2231.pdf')],
  });
  assert.equal(inv?.kind, 'receipt');
  assert.deepEqual(inv?.documents, [
    { attachmentId: 'a1', kind: 'invoice' },
    { attachmentId: 'a2', kind: 'receipt' },
  ]);
});

test('invoice: the sole PDF of a bill is its document, whatever its name', () => {
  const inv = run({
    bodyText: 'Vedlagt. Beløp kr 1 309,00',
    attachments: [pdf('a1', '2236300.pdf')],
  });
  assert.deepEqual(inv?.documents, [{ attachmentId: 'a1', kind: 'invoice' }]);
});

test('invoice: no guess among riders or several unnamed PDFs', () => {
  const body = { bodyText: 'Beløp kr 100,00' };
  assert.deepEqual(
    run({ ...body, attachments: [pdf('a1', 'Angrerettskjema.pdf')] })?.documents,
    [],
  );
  assert.deepEqual(
    run({ ...body, attachments: [pdf('a1', '1.pdf'), pdf('a2', '2.pdf')] })?.documents,
    [],
  );
  // Riders set aside, the one PDF left is the bill.
  assert.deepEqual(
    run({ ...body, attachments: [pdf('a1', 'EN_AGB.pdf'), pdf('a2', '4711.pdf')] })?.documents,
    [{ attachmentId: 'a2', kind: 'invoice' }],
  );
});

test('invoice: a named document must be a document format', () => {
  const inv = run({
    subject: 'Your order',
    bodyText: 'Thanks!',
    attachments: [{ id: 'a1', filename: 'invoice.ics', mimeType: 'text/calendar', sizeBytes: 900 }],
  });
  assert.equal(inv, null);
});

// --- Identifiers, amounts, dates --------------------------------------------------------

test('invoice: classification is a passive search-kind extractor', () => {
  assert.equal(invoiceEnricher.kind, 'search');
  const out = invoiceEnricher.run({
    message: msg({ bodyText: 'Faktura — KID: 1234567897, å betale kr 100,00' }),
    tier: 0,
  });
  assert.ok(!(out instanceof Promise));
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
  const inv = run({ bodyText: 'Faktura KID 1234567890, kr 100,00.' });
  assert.deepEqual(inv?.kids, []);
});

test('invoice: KID requires its label (a bare valid-checksum number is ignored)', () => {
  const inv = run({ bodyText: 'Reference 1234567897, kr 100,00.' });
  assert.deepEqual(inv?.kids, []);
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

test('invoice: a stub text part defers to the HTML body', () => {
  const inv = run({
    subject: 'Kvittering: Ecotrail Oslo 2024',
    bodyText: 'To view the message, please use an HTML compatible email viewer!',
    bodyHtml:
      '<p>Takk for påmeldingen til Ecotrail Oslo 2024.</p><p>Totalt betalt: kr 1 095,00</p>',
  });
  assert.equal(inv?.kind, 'receipt');
  assert.equal(inv?.amount?.value, 1095);
});

test('invoice: numeric HTML entities are decoded before amounts are read', () => {
  const inv = run({ bodyHtml: '<p>Din kvittering</p><td>Totalbeløp</td><td>NOK&#160;227,00</td>' });
  assert.equal(inv?.amount?.value, 227);
});

test('invoice: a zero total line does not win over the real one', () => {
  const inv = run({ bodyText: 'Totalt å betale kr 0,00 (forskudd). Total kr 450,00.' });
  assert.equal(inv?.amount?.value, 450);
});

test('invoice: applies gate reads subject, attachment names and body', () => {
  const gate = (f: Fields) => invoiceEnricher.applies?.(msg(f));
  assert.equal(gate({ subject: 'Lunch?', bodyText: 'Friday?' }), false);
  assert.equal(gate({ subject: 'Lunch?', bodyText: 'Your faktura is attached.' }), true);
  assert.equal(gate({ subject: 'Din kvittering', bodyText: 'Hei' }), true);
  assert.equal(
    gate({ subject: 'Hei', bodyText: 'Hei', attachments: [pdf('a1', 'receipt.pdf')] }),
    true,
  );
});

test('invoice: an invoice-marked mail that is neither yields a null invoice', () => {
  const out = invoiceEnricher.run({
    message: msg({ subject: 'Hello', bodyText: 'Your receipt is attached.' }),
    tier: 0,
  });
  assert.ok(!(out instanceof Promise));
  assert.equal((out.result as { invoice: InvoiceFacts | null }).invoice, null);
});
