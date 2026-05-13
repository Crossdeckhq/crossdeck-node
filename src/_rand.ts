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
