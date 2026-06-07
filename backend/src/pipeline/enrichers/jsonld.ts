/**
 * Shared JSON-LD (schema.org microdata) parsing helpers for deterministic enrichers.
 *
 * Many transactional senders embed `<script type="application/ld+json">` blocks in
 * their HTML mail (the same markup Gmail reads for trip highlights / package cards).
 * Both the `travel` and `package` enrichers extract from these, so the block
 * collection + the small typed accessors live here, once.
 *
 * Node-shape-specific readers (a flight's airport pair, a parcel's carrier) stay in
 * their own enricher — this module only handles the generic plumbing: pull the
 * blocks, tolerate malformed JSON, flatten `@graph`/array wrappers, and read string /
 * `@type` fields safely.
 */
import * as cheerio from 'cheerio';

export type JsonValue = unknown;
export type JsonObject = Record<string, JsonValue>;

export function isObject(v: JsonValue): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read a string-ish field (numbers coerced), trimmed; null when absent/empty. */
export function str(obj: JsonObject, key: string): string | null {
  const v = obj[key];
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

/** schema.org `@type` may be a string or an array of strings. */
export function typesOf(obj: JsonObject): string[] {
  const t = obj['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

/** Flatten an object / array / `@graph` into the node list (recursively). */
export function pushNodes(value: JsonValue, out: JsonObject[]): void {
  if (Array.isArray(value)) {
    for (const v of value) pushNodes(v, out);
    return;
  }
  if (!isObject(value)) return;
  out.push(value);
  const graph = value['@graph'];
  if (Array.isArray(graph)) for (const v of graph) pushNodes(v, out);
}

/**
 * Collect every JSON-LD object embedded in the HTML. Each `<script>` block may hold a
 * single object, an array, or a `{ "@graph": [...] }` wrapper; we flatten them all into
 * one flat list of candidate nodes. Malformed JSON in one block is skipped, not fatal.
 */
export function collectJsonLdNodes(html: string): JsonObject[] {
  const $ = cheerio.load(html);
  const nodes: JsonObject[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).text();
    if (!raw.trim()) return;
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // tolerate one broken block; others may still parse
    }
    pushNodes(parsed, nodes);
  });
  return nodes;
}
