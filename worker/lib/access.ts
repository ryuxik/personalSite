/**
 * Cloudflare Access JWT verification (2026-08-26): when a request reaches the
 * Worker through the zone's Access app, it carries a signed
 * `Cf-Access-Jwt-Assertion`. Verifying it here lets the browser admin skip
 * the token form entirely — Access's email PIN IS the login — while keeping
 * the SELECTS_ADMIN_TOKEN layer as the CLI credential and the fallback for a
 * misconfigured Access. Full verification (RS256 signature against the team's
 * published keys, issuer, audience, expiry, and the email allowlist), never
 * mere header presence.
 */

interface AccessJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

let cachedKeys: { keys: AccessJwk[]; fetched: number } | null = null;
const KEYS_TTL_MS = 6 * 60 * 60 * 1000;

async function teamKeys(teamDomain: string): Promise<AccessJwk[]> {
  if (cachedKeys && Date.now() - cachedKeys.fetched < KEYS_TTL_MS) return cachedKeys.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs fetch ${res.status}`);
  const body = (await res.json()) as { keys?: AccessJwk[] };
  cachedKeys = { keys: body.keys ?? [], fetched: Date.now() };
  return cachedKeys.keys;
}

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** True only for a valid, unexpired Access JWT for OUR app, signed by the
 * team's keys, asserting an allow-listed email. Any failure → false. */
export async function verifyAccessJwt(env: Env, jwt: string | null): Promise<boolean> {
  try {
    if (!jwt || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
    const parts = jwt.split('.');
    if (parts.length !== 3) return false;
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as {
      alg?: string;
      kid?: string;
    };
    if (header.alg !== 'RS256' || !header.kid) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as {
      aud?: string | string[];
      iss?: string;
      exp?: number;
      email?: string;
    };
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return false;
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return false;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(env.ACCESS_AUD)) return false;
    const allowed = (env.PHOTOGRAPHER_EMAIL ?? '').toLowerCase();
    if (!allowed || (payload.email ?? '').toLowerCase() !== allowed) return false;

    const jwk = (await teamKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    return crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]).buffer as ArrayBuffer,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return false;
  }
}
