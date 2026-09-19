/**
 * POST /api/e — the site's first-party funnel beacon (SPEC.md § Site analytics).
 *
 * The public pages batch a handful of events (src/scripts/track.ts) and
 * sendBeacon them here. This is an unauthenticated write endpoint, so it is
 * deliberately narrow: same-origin only, 8 KB cap, a closed event vocabulary,
 * short sanitized strings, a per-session sequence ceiling and a per-IP rate
 * limit. The IP is the rate-limit key and nothing else — it is never stored,
 * and neither is the raw user agent (reduced to a browser/device class here).
 *
 * Always answers 204 immediately; the D1 write rides ctx.waitUntil so a
 * visitor never waits on analytics, and a rejected payload looks identical to
 * an accepted one.
 */

import { ensureSchema } from '../lib/db';

const MAX_BODY = 8192;
const MAX_BATCH = 50;
const MAX_SEQ = 500; // per-session event ceiling
const MAX_T = 6 * 60 * 60 * 1000;

/** The whole vocabulary. Anything else is dropped, not stored. */
export const EVENT_NAMES = new Set(['pv', 'engaged', 'view', 'click', 'faq', 'cal', 'scroll', 'exit', 'perf']);

const ID = /^[a-z0-9]{16,32}$/;
const BOT_UA = /bot|crawl|spider|headless|lighthouse|pagespeed|preview|monitor|curl|wget|python|node-fetch/i;

interface RawEvent {
  q?: unknown;
  t?: unknown;
  p?: unknown;
  n?: unknown;
  d?: unknown;
  v?: unknown;
}

interface RawBatch {
  sid?: unknown;
  vid?: unknown;
  now?: unknown;
  s?: { lp?: unknown; tag?: unknown; utm?: unknown; ref?: unknown; n?: unknown; build?: unknown; internal?: unknown };
  e?: unknown;
}

const NO_CONTENT = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

/** Source tags, utm values, build ids: lowercase slug characters only. */
const slug = (value: unknown, max: number): string =>
  str(value, max * 2)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, max);

/** Event detail: a short machine label (`cta:lost`, `failed:no-mount`), never free text. */
const label = (value: unknown): string => str(value, 96).replace(/[^A-Za-z0-9_:.\-/#]/g, '').slice(0, 64);

/**
 * Public page paths only. Client galleries are capability URLs — the link IS
 * the credential — so nothing under /g, /admin or /api is ever written down,
 * and neither is a query string or a path that doesn't look like one of ours.
 */
export function cleanPath(value: unknown): string {
  const path = str(value, 128).split(/[?#]/)[0];
  if (!/^\/[a-z0-9/_-]{0,63}$/.test(path)) return '/other';
  if (/^\/(g|admin|api)(\/|$)/.test(path)) return '/other';
  return path.endsWith('/') ? path : `${path}/`;
}

export function classifyBrowser(ua: string): string {
  if (/Instagram/i.test(ua)) return 'ig-inapp';
  if (/xhsdiscover|xiaohongshu|discover\/\d/i.test(ua)) return 'xhs-inapp';
  if (/MicroMessenger/i.test(ua)) return 'wechat';
  if (/FBAN|FBAV|FB_IAB/.test(ua)) return 'fb-inapp';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox|FxiOS/.test(ua)) return 'firefox';
  if (/Chrome|CriOS/.test(ua)) return 'chrome';
  if (/Safari/.test(ua)) return 'safari';
  return 'other';
}

export function classifyDevice(ua: string): string {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|Android/i.test(ua)) return 'mobile';
  return 'desktop';
}

function classifyReferrer(host: string, selfHost: string): string {
  if (!host || host === selfHost || host === `www.${selfHost}`) return '';
  if (/(^|\.)instagram\.com$/.test(host)) return 'ig';
  if (/(^|\.)(xiaohongshu\.com|xhslink\.com)$/.test(host)) return 'xhs';
  if (/(^|\.)(google|bing|duckduckgo|baidu|yahoo|ecosia)\./.test(host)) return 'search';
  if (/(^|\.)(facebook\.com|fb\.me)$/.test(host)) return 'fb';
  if (/(^|\.)(t\.co|twitter\.com|x\.com)$/.test(host)) return 'x';
  if (/(^|\.)cal\.com$/.test(host)) return 'cal';
  return host.slice(0, 40);
}

const TAG_ALIASES: Record<string, string> = { instagram: 'ig', rednote: 'xhs', xiaohongshu: 'xhs', red: 'xhs' };

/** A deliberate tag beats utm beats the referrer beats an in-app user agent. */
export function resolveSource(tag: string, utm: string, refHost: string, browser: string, selfHost: string): string {
  const tagged = tag || utm;
  if (tagged) return TAG_ALIASES[tagged] ?? tagged;
  const referred = classifyReferrer(refHost, selfHost);
  if (referred) return referred;
  if (browser === 'ig-inapp') return 'ig';
  if (browser === 'xhs-inapp') return 'xhs';
  if (browser === 'wechat') return 'wechat';
  return 'direct';
}

export async function handleTrack(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });

  // Same-origin only. Browsers send Origin on a same-origin POST; when one
  // doesn't, Sec-Fetch-Site has to vouch for it. Anything else is not our page.
  const self = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin ? origin !== self.origin : request.headers.get('Sec-Fetch-Site') !== 'same-origin') return NO_CONTENT();

  const ua = request.headers.get('User-Agent') ?? '';
  if (!ua || BOT_UA.test(ua)) return NO_CONTENT();

  if (env.TRACK_LIMIT) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.TRACK_LIMIT.limit({ key: ip });
    if (!success) return NO_CONTENT();
  }

  const body = await request.text().catch(() => '');
  if (!body || body.length > MAX_BODY) return NO_CONTENT();

  let batch: RawBatch;
  try {
    batch = JSON.parse(body) as RawBatch;
  } catch {
    return NO_CONTENT();
  }
  if (!batch || typeof batch !== 'object') return NO_CONTENT();

  const country = str((request as unknown as { cf?: { country?: unknown } }).cf?.country, 2);
  ctx.waitUntil(
    store(env, batch, ua, country, self.hostname).catch((error) =>
      console.log('track error:', (error as Error).message)
    )
  );
  return NO_CONTENT();
}

async function store(env: Env, batch: RawBatch, ua: string, country: string, selfHost: string): Promise<void> {
  const sid = str(batch.sid, 32);
  if (!ID.test(sid)) return;
  const vid = ID.test(str(batch.vid, 32)) ? str(batch.vid, 32) : null;
  if (!Array.isArray(batch.e)) return;

  const events: { seq: number; t: number; path: string; name: string; detail: string; v: number | null }[] = [];
  for (const raw of (batch.e as RawEvent[]).slice(0, MAX_BATCH)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = str(raw.n, 16);
    const seq = Number(raw.q);
    const t = Number(raw.t);
    if (!EVENT_NAMES.has(name)) continue;
    if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_SEQ) continue;
    if (!Number.isFinite(t) || t < 0) continue;
    const v = typeof raw.v === 'number' && Number.isFinite(raw.v) ? raw.v : null;
    events.push({ seq, t: Math.min(Math.round(t), MAX_T), path: cleanPath(raw.p), name, detail: label(raw.d), v });
  }
  if (events.length === 0) return;

  await ensureSchema(env.DB);

  const dims = batch.s && typeof batch.s === 'object' ? batch.s : {};
  const browser = classifyBrowser(ua);
  const tag = slug(dims.tag, 24);
  const utm = slug(dims.utm, 24);
  const refHost = str(dims.ref, 80).toLowerCase().replace(/[^a-z0-9.-]/g, '');
  const source = resolveSource(tag, utm, refHost, browser, selfHost);
  const internal = dims.internal === 1 || tag === 'me' ? 1 : 0;

  // The client reports how far into the session it is at send time, so the
  // session start is the server's clock minus that offset — the visitor's
  // own clock never enters the database.
  const offset = Math.min(Math.max(Number(batch.now) || 0, 0), MAX_T);
  const startedAt = new Date(Date.now() - offset).toISOString().slice(0, 19).replace('T', ' ');

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO site_sessions
         (sid, vid, started_at, landing_path, source, source_raw, visit_n,
          ref_host, country, device, browser, build, internal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      sid,
      vid,
      startedAt,
      cleanPath(dims.lp),
      source,
      tag || utm,
      Math.min(Math.max(Math.round(Number(dims.n)) || 1, 1), 9999),
      refHost === selfHost ? '' : refHost,
      country,
      classifyDevice(ua),
      browser,
      slug(dims.build, 16),
      internal
    ),
  ];
  for (const event of events) {
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO site_events (sid, seq, t_ms, path, name, detail, v) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(sid, event.seq, event.t, event.path, event.name, event.detail, event.v)
    );
  }
  if (events.some((event) => event.name === 'engaged'))
    statements.push(env.DB.prepare('UPDATE site_sessions SET human = 1 WHERE sid = ?').bind(sid));
  if (internal)
    statements.push(env.DB.prepare('UPDATE site_sessions SET internal = 1 WHERE sid = ?').bind(sid));

  await env.DB.batch(statements);
}
