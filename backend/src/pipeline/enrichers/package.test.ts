/**
 * `package` enricher coverage (ROADMAP Phase 4). Pure unit tests over the enricher's
 * `run` — no DB, no pipeline wiring (the framework's queue/persist path is covered by
 * pipeline.test.ts). We pin the two deterministic extraction routes (JSON-LD
 * ParcelDelivery + carrier-anchored regex), the false-positive discipline (ambiguous
 * all-digit carriers need a keyword), dedup precedence, and the cheap `applies` gate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { packageEnricher, type PackageShipment } from './package.js';

/** Minimal PipelineMessage stub — only the body fields the enricher reads. */
function msg(fields: {
  bodyText?: string | null;
  bodyHtml?: string | null;
}): Parameters<typeof packageEnricher.run>[0]['message'] {
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
    bodyCalendar: null,
    inReplyTo: null,
    references: null,
    sentAt: null,
    receivedAt: null,
    sourcePath: null,
  };
}

function run(fields: { bodyText?: string | null; bodyHtml?: string | null }): PackageShipment[] {
  const out = packageEnricher.run({ message: msg(fields), tier: 0 });
  // run is synchronous here (no awaited IO) but the contract allows a promise.
  assert.ok(!(out instanceof Promise), 'package.run should be synchronous');
  return (out.result as { shipments: PackageShipment[] }).shipments;
}

test('package: classification is passive search-kind with no proposals', () => {
  assert.equal(packageEnricher.kind, 'search');
  const out = packageEnricher.run({
    message: msg({ bodyText: 'Tracking number 1Z999AA10123456784' }),
    tier: 0,
  });
  assert.ok(!(out instanceof Promise));
  assert.equal(out.proposals, undefined, 'package must not emit operational proposals');
});

test('package: JSON-LD ParcelDelivery is authoritative (carrier, url, ETA)', () => {
  const html = `<html><body>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'ParcelDelivery',
      trackingNumber: 'TN-LD-1',
      trackingUrl: 'https://carrier.example/track/TN-LD-1',
      expectedArrivalUntil: '2026-06-10',
      carrier: { '@type': 'Organization', name: 'Acme Express' },
    })}</script>
  </body></html>`;
  const ships = run({ bodyHtml: html });
  assert.equal(ships.length, 1);
  assert.deepEqual(ships[0], {
    carrier: 'Acme Express',
    trackingNumber: 'TN-LD-1',
    trackingUrl: 'https://carrier.example/track/TN-LD-1',
    estimatedDelivery: '2026-06-10',
    source: 'jsonld',
  });
});

test('package: ParcelDelivery nested under an Order orderDelivery is found', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Order',
    orderDelivery: {
      '@type': 'ParcelDelivery',
      trackingNumber: 'NESTED-1',
      provider: { '@type': 'Organization', name: 'PostNord' },
    },
  })}</script>`;
  const ships = run({ bodyHtml: html });
  assert.equal(ships.length, 1);
  const [s] = ships;
  assert.ok(s);
  assert.equal(s.trackingNumber, 'NESTED-1');
  assert.equal(s.carrier, 'PostNord');
});

test('package: distinctive UPS + UPU/S10 patterns match without a keyword', () => {
  const ships = run({
    bodyText: 'Your shipment 1Z999AA10123456784 and postal item RR123456785NO are on the way.',
  });
  const carriers = ships.map((s) => s.carrier).sort();
  assert.deepEqual(carriers, ['Postal', 'UPS']);
  const ups = ships.find((s) => s.carrier === 'UPS');
  assert.equal(ups?.trackingUrl, 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
});

test('package: ambiguous all-digit carriers need their keyword', () => {
  const number = '123456789012'; // 12 digits — FedEx-shaped but ambiguous
  // No carrier keyword → no match (must not treat a random 12-digit number as tracking).
  assert.equal(run({ bodyText: `Order ref ${number}, thanks for shopping.` }).length, 0);
  // With the keyword present → matched and attributed to FedEx.
  const ships = run({ bodyText: `Your FedEx shipment ${number} is out for delivery.` });
  assert.equal(ships.length, 1);
  const [s] = ships;
  assert.ok(s);
  assert.equal(s.carrier, 'FedEx');
  assert.equal(s.trackingNumber, number);
});

test('package: a JSON-LD hit wins over a regex hit for the same number', () => {
  const tn = '1Z999AA10123456784';
  const html = `<p>UPS ${tn}</p><script type="application/ld+json">${JSON.stringify({
    '@type': 'ParcelDelivery',
    trackingNumber: tn,
    carrier: { name: 'UPS' },
    trackingUrl: 'https://ups.example/authoritative',
  })}</script>`;
  const ships = run({ bodyHtml: html });
  assert.equal(ships.length, 1, 'same number must collapse to one shipment');
  const [s] = ships;
  assert.ok(s);
  assert.equal(s.source, 'jsonld');
  assert.equal(s.trackingUrl, 'https://ups.example/authoritative');
});

test('package: S10 with a bad check digit is rejected (digit check)', () => {
  // RR123456785NO is valid (check digit 5); flip it to 0 and it must be dropped.
  assert.equal(run({ bodyText: 'Postal item RR123456780NO is on the way.' }).length, 0);
  assert.equal(run({ bodyText: 'Postal item RR123456785NO is on the way.' }).length, 1);
});

test('package: UPS with a bad check digit is rejected (digit check)', () => {
  // 1Z999AA10123456784 is valid (check digit 4); flip it to 0 and it must be dropped.
  assert.equal(run({ bodyText: 'Your shipment 1Z999AA10123456780.' }).length, 0);
  assert.equal(run({ bodyText: 'Your shipment 1Z999AA10123456784.' }).length, 1);
});

test('package: S10 is re-attributed to the Nordic carrier named in the body', () => {
  // Valid S10 (check digit 5) + "PostNord" in the copy → labelled PostNord, not Postal.
  const ships = run({ bodyText: 'Your PostNord parcel CC123456785SE is on its way.' });
  assert.equal(ships.length, 1);
  const [s] = ships;
  assert.ok(s);
  assert.equal(s.carrier, 'PostNord');
  assert.equal(s.trackingUrl, 'https://tracking.postnord.com/no/?id=CC123456785SE');
});

test('package: Norwegian carrier numbers are lifted from the tracking-page link', () => {
  const bring = run({
    bodyHtml: '<a href="https://tracking.bring.com/tracking/TESTNUM12345">Spor pakken</a>',
  });
  assert.equal(bring.length, 1);
  assert.equal(bring[0]?.carrier, 'Posten/Bring');
  assert.equal(bring[0]?.trackingNumber, 'TESTNUM12345');

  // Query-string id, with the &amp; entity HTML hrefs carry decoded first.
  const postnord = run({
    bodyHtml: '<a href="https://tracking.postnord.com/no/?type=parcel&amp;id=99887766554433">x</a>',
  });
  assert.equal(postnord.length, 1);
  assert.equal(postnord[0]?.carrier, 'PostNord');
  assert.equal(postnord[0]?.trackingNumber, '99887766554433');

  const helthjem = run({ bodyText: 'Track: https://helthjem.no/sporing/HJ12345678' });
  assert.equal(helthjem.length, 1);
  assert.equal(helthjem[0]?.carrier, 'Helthjem');
  assert.equal(helthjem[0]?.trackingUrl, 'https://helthjem.no/sporing/HJ12345678');
});

test('package: a carrier homepage link with no tracking token is ignored', () => {
  assert.equal(
    run({ bodyHtml: '<a href="https://www.posten.no/">Posten</a> Tracking number coming soon.' })
      .length,
    0,
  );
});

test('package: applies gate skips mail with no tracking marker', () => {
  assert.equal(packageEnricher.applies?.(msg({ bodyText: 'Lunch on Friday?' })), false);
  assert.equal(
    packageEnricher.applies?.(msg({ bodyText: 'Your tracking number is below.' })),
    true,
  );
});

test('package: malformed JSON-LD block is tolerated, regex still runs', () => {
  const html = `<script type="application/ld+json">{ not valid json </script>
    <p>Tracking 1Z999AA10123456784</p>`;
  const ships = run({ bodyHtml: html });
  assert.equal(ships.length, 1);
  const [s] = ships;
  assert.ok(s);
  assert.equal(s.carrier, 'UPS');
});
