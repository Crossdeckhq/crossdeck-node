/**
 * Cryptographically-random short IDs used across the SDK — event IDs,
 * batch IDs, internal correlation. Same alphabet (`0-9a-z`) and shape
 * (`<prefix>_<base32-ts><rand>`) as `@cross-deck/web`'s
 * `identity.ts:randomChars` so events emitted by the Node SDK look
 * identical to web SDK events in the warehouse.
 *
 * Node 18+ exposes `globalThis.crypto.getRandomValues` natively. If the
 * runtime is older (which the package.json `engines` field forbids,
 * but a sloppy host might run anyway), we fall back to `Math.random`.
 * The fallback is safe here because ID entropy doesn't need to resist
 * offline brute force — it needs to be unique-with-overwhelming-probability
 * across one process lifetime.
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function randomChars(count: number): string {
  const out: string[] = [];
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoApi?.getRandomValues) {
    const buf = new Uint8Array(count);
    cryptoApi.getRandomValues(buf);
    for (let i = 0; i < count; i++) {
      out.push(ALPHABET[buf[i]! % ALPHABET.length] ?? "0");
    }
  } else {
    for (let i = 0; i < count; i++) {
      out.push(ALPHABET[Math.floor(Math.random() * ALPHABET.length)] ?? "0");
    }
  }
  return out.join("");
}

/**
 * Mint a prefixed ID like `evt_<base32-ts><rand>` / `batch_<base32-ts><rand>`.
 * Sortable (timestamp-prefixed) and log-friendly. Stripe / Segment use the
 * same shape.
 */
export function mintId(prefix: string, randLen = 10): string {
  return `${prefix}_${Date.now().toString(36)}${randomChars(randLen)}`;
}

/**
 * Derive a STABLE id from fixed inputs — same inputs, same id, for the life
 * of the service.
 *
 * Exists because a server's analytics identity must not be random. A random
 * per-process id is correct on a long-lived box and catastrophic on
 * serverless, where every cold start is a fresh process: one customer's
 * Firebase Functions minted 10,589 distinct identities in 30 days, each one
 * creating its own visitor record, and the dashboard counted every cold start
 * as a separate person. The identity we actually want is "this service", and
 * a service does not change when a container recycles.
 *
 * FNV-1a, two passes at different offsets for a wider value, base36. Chosen
 * for being synchronous and dependency-free: `crypto.subtle.digest` is async
 * and cannot run in a constructor, and `node:crypto` is unavailable on edge
 * runtimes this SDK is expected to work in. Collision resistance is not a
 * security property here — the value is already namespaced by appId.
 */
export function stableId(prefix: string, parts: readonly string[]): string {
  const input = parts.join("\u0000");
  const pass = (offset: number): number => {
    let h = offset;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const a = pass(0x811c9dc5).toString(36).padStart(7, "0");
  const b = pass(0x9e3779b1).toString(36).padStart(7, "0");
  return `${prefix}_${a}${b}`;
}
