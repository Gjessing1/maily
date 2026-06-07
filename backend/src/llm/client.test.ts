/**
 * Ollama client coverage (ROADMAP Phase 5 foundation). Pure unit tests over the HTTP client
 * with a mocked global `fetch` (node:test `mock`); no real Ollama and no DB. We pin:
 *  - request shape: URL, method, JSON body carry the configured model + prompt/system/format,
 *  - JSON-mode parsing via `generateJson`,
 *  - single-flight serialisation: two concurrent calls never overlap (the N150 CPU guard),
 *  - the timeout and unreachable failure paths surface a typed {@link LlmError}.
 *
 * `OLLAMA_URL` is set before the dynamic import so `env.ollama()` reports configured — same
 * "point env, then import" bootstrap the cleanup tests use for MAILY_DATA_DIR.
 */
import assert from 'node:assert/strict';
import test, { afterEach, before, mock } from 'node:test';

process.env.OLLAMA_URL = 'http://ollama.test:11434';
process.env.OLLAMA_MODEL = 'qwen2.5';
process.env.OLLAMA_TIMEOUT_MS = '50';

let client: typeof import('./client.js');
const realFetch = globalThis.fetch;

before(async () => {
  client = await import('./client.js');
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.reset();
});

/** Extract the [url, init] of the Nth call to a mocked fetch (typed; asserts it exists). */
function callArgs(fetchMock: ReturnType<typeof mock.fn>, n = 0): [string, RequestInit] {
  const call = fetchMock.mock.calls[n];
  assert.ok(call, `expected fetch call #${n}`);
  return call.arguments as unknown as [string, RequestInit];
}

/** Build a Response-like stub with an ok status and a JSON body. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

test('generate posts to /api/generate with model, prompt, system and stream:false', async () => {
  const fetchMock = mock.fn(async () => jsonResponse({ response: 'hei' }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const out = await client.generate({ prompt: 'Hallo', system: 'Be terse' });
  assert.equal(out, 'hei');

  assert.equal(fetchMock.mock.calls.length, 1);
  const [url, init] = callArgs(fetchMock);
  assert.equal(url, 'http://ollama.test:11434/api/generate');
  assert.equal(init.method, 'POST');
  const body = JSON.parse(init.body as string);
  assert.equal(body.model, 'qwen2.5');
  assert.equal(body.prompt, 'Hallo');
  assert.equal(body.system, 'Be terse');
  assert.equal(body.stream, false);
  assert.equal(body.format, undefined);
});

test('generateJson sets format:json and parses the JSON-mode body', async () => {
  const fetchMock = mock.fn(async () => jsonResponse({ response: '{"category":"tools"}' }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const out = await client.generateJson<{ category: string }>({ prompt: 'classify' });
  assert.deepEqual(out, { category: 'tools' });

  const body = JSON.parse(callArgs(fetchMock)[1].body as string);
  assert.equal(body.format, 'json');
});

test('generateJson throws a typed parse error on invalid JSON output', async () => {
  globalThis.fetch = mock.fn(async () => jsonResponse({ response: 'not json' })) as never;
  await assert.rejects(
    () => client.generateJson({ prompt: 'x' }),
    (e: unknown) => e instanceof client.LlmError && e.kind === 'parse',
  );
});

test('chat posts to /api/chat and returns message.content', async () => {
  const fetchMock = mock.fn(async () => jsonResponse({ message: { content: 'svar' } }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const out = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out, 'svar');
  assert.equal(callArgs(fetchMock)[0], 'http://ollama.test:11434/api/chat');
});

test('single-flight: concurrent generations never overlap', async () => {
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];

  // Each fetch holds the "connection" open briefly; if two ran at once, maxActive would hit 2.
  const fetchMock = mock.fn(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return jsonResponse({ response: 'ok' });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await Promise.all([
    client.generate({ prompt: 'a' }).then(() => order.push(1)),
    client.generate({ prompt: 'b' }).then(() => order.push(2)),
    client.generate({ prompt: 'c' }).then(() => order.push(3)),
  ]);

  assert.equal(maxActive, 1, 'at most one generation in flight at a time');
  assert.deepEqual(order, [1, 2, 3], 'tasks run in submission order');
  assert.equal(fetchMock.mock.calls.length, 3);
});

test('single-flight: a failed generation does not poison the queue', async () => {
  let call = 0;
  const fetchMock = mock.fn(async () => {
    call += 1;
    if (call === 1) throw new TypeError('fetch failed'); // unreachable on the first
    return jsonResponse({ response: 'recovered' });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const first = client.generate({ prompt: 'a' });
  const second = client.generate({ prompt: 'b' });

  await assert.rejects(first, (e: unknown) => e instanceof client.LlmError);
  assert.equal(await second, 'recovered', 'second call still runs after the first failed');
});

test('unreachable Ollama surfaces LlmError kind=unreachable', async () => {
  globalThis.fetch = mock.fn(async () => {
    throw new TypeError('fetch failed'); // node fetch ECONNREFUSED shape
  }) as never;

  await assert.rejects(
    () => client.generate({ prompt: 'x' }),
    (e: unknown) => e instanceof client.LlmError && e.kind === 'unreachable',
  );
});

test('a slow generation past timeoutMs surfaces LlmError kind=timeout', async () => {
  // OLLAMA_TIMEOUT_MS=50; this fetch respects the abort signal and never resolves in time.
  globalThis.fetch = mock.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  ) as never;

  await assert.rejects(
    () => client.generate({ prompt: 'x' }),
    (e: unknown) => e instanceof client.LlmError && e.kind === 'timeout',
  );
});

test('non-2xx response surfaces LlmError kind=http', async () => {
  globalThis.fetch = mock.fn(async () =>
    jsonResponse({ error: 'no such model' }, false, 404),
  ) as never;
  await assert.rejects(
    () => client.generate({ prompt: 'x' }),
    (e: unknown) => e instanceof client.LlmError && e.kind === 'http',
  );
});
