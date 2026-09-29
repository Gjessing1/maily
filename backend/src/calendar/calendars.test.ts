/**
 * Calendar registry freshness: a calendar added or restored on the server must
 * become visible without a process restart (forced refresh), and a failed
 * rediscovery must not replace a good calendar set with the single-URL fallback.
 * `env.ts`/`db/client.ts` read `process.env` at import, so the env is set first and
 * everything is imported dynamically.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import type * as CalendarsNS from './calendars.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-calendars-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;
process.env.JWT_SECRET = 'test-secret';
process.env.MASTER_PASSWORD = 'test-master';
process.env.CALDAV_URL = 'https://dav.example.com/';
process.env.CALDAV_USER = 'lars';
process.env.CALDAV_PASSWORD = 'secret';

let calendars: typeof CalendarsNS;
const realFetch = globalThis.fetch;

/** What the fake Radicale currently serves; `null` makes every PROPFIND fail. */
let served: string[] | null = [];

function multistatus(names: string[]): string {
  const rows = names
    .map(
      (n) => `<D:response><D:href>/lars/${n}/</D:href><D:propstat><D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>${n}</D:displayname></D:prop></D:propstat></D:response>`,
    )
    .join('');
  return `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${rows}</D:multistatus>`;
}

before(async () => {
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    if (served === null) return new Response('down', { status: 503 });
    const headers = init?.headers as Record<string, string>;
    const body =
      headers.Depth === '0'
        ? `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response>
            <D:href>/</D:href><D:propstat><D:prop>
            <C:calendar-home-set><D:href>/lars/</D:href></C:calendar-home-set>
            </D:prop></D:propstat></D:response></D:multistatus>`
        : multistatus(served);
    return new Response(body, { status: 207 });
  }) as typeof fetch;
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  calendars = await import('./calendars.js');
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const names = () => calendars.getDiscovered().map((c) => c.displayName);

test('a forced refresh picks up a calendar restored on the server', async () => {
  served = ['Personal'];
  await calendars.ensureCalendarsDiscovered();
  assert.deepEqual(names(), ['Personal']);

  served = ['Personal', 'Restored'];
  await calendars.ensureCalendarsDiscovered(); // still fresh: cached
  assert.deepEqual(names(), ['Personal']);

  await calendars.refreshCalendars();
  assert.deepEqual(names(), ['Personal', 'Restored']);
});

test('a failed refresh keeps the last good calendar set', async () => {
  served = null;
  await calendars.refreshCalendars();
  assert.deepEqual(names(), ['Personal', 'Restored']);
  assert.equal(calendars.effectiveDefault(), 'https://dav.example.com/lars/Personal/');
});
