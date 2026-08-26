/**
 * Capability keys and slug parsing for /g/<slug>-<key> URLs.
 *
 * The link IS the credential (SPEC.md § Client galleries): 16 chars of
 * Crockford-ish base32 = 80 bits. Entropy is free, so we take more than the
 * industry's usual ~50. Rotation bumps `key_version`, which is baked into
 * every media path — an old *edge-cached* media URL then dies at the cache
 * TTL (capped at one hour), which is the rotation SLA, stated not discovered.
 */

const ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789'; // no i/l/o/u/0/1 — read-aloud safe
export const KEY_LENGTH = 16;

export function newAccessKey(): string {
  const raw = new Uint8Array(KEY_LENGTH);
  crypto.getRandomValues(raw);
  let out = '';
  for (const byte of raw) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** `/g/atelier-mora-x7k2m9c4p3w8r2t6` → { slug: 'atelier-mora', key: '…' } */
export function parseSlugKey(segment: string): { slug: string; key: string } | null {
  if (segment.length < KEY_LENGTH + 2) return null;
  const key = segment.slice(-KEY_LENGTH);
  if (segment[segment.length - KEY_LENGTH - 1] !== '-') return null;
  if (![...key].every((c) => ALPHABET.includes(c))) return null;
  return { slug: segment.slice(0, -(KEY_LENGTH + 1)), key };
}

/** Constant-time-ish comparison; keys are same-length by construction. */
export function keyEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'gallery';
}
