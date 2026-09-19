/**
 * /api/admin/insights — the read side of the site funnel (SPEC.md § Site
 * analytics). Mounted under handleAdmin, so auth and ensureSchema have already
 * happened by the time anything here runs.
 *
 * Traffic is small, so this is built to be READ, not charted: a funnel of
 * "got at least this far" counts, and a journal of individual sessions. One
 * row per session comes out of SQL with its flags; the rollups are done here
 * in JS, where the definitions are easy to read and to change.
 */

import { json } from '../lib/html';

interface SessionFlags {
  sid: string;
  started_at: string;
  landing_path: string;
  source: string;
  first_source: string | null;
  visit_n: number;
  country: string;
  device: string;
  browser: string;
  build: string;
  human: number;
  n_events: number;
  dur_ms: number;
  n_pages: number;
  n_shoots: number;
  last_path: string | null;
  last_view: string | null;
  f_sessions: number | null;
  f_offer: number | null;
  f_book: number | null;
  f_cal_ready: number | null;
  f_cal_failed: number | null;
  f_cal_used: number | null;
  f_booked: number | null;
  f_mailto: number | null;
}

/** Deepest first. Reaching a step implies every step above it — a visitor who
 * deep-links to /sessions/#book never scrolls past the offer, but they
 * certainly got that far. That keeps the funnel monotone and honest. */
const STEPS = [
  { key: 'booked', label: 'Booked', flag: 'f_booked' },
  { key: 'cal_used', label: 'Used the calendar', flag: 'f_cal_used' },
  { key: 'cal_ready', label: 'Calendar loaded', flag: 'f_cal_ready' },
  { key: 'book', label: 'Reached booking', flag: 'f_book' },
  { key: 'offer', label: 'Saw the offer', flag: 'f_offer' },
  { key: 'sessions', label: 'Opened /sessions', flag: 'f_sessions' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

function depth(row: SessionFlags): number {
  // Index into STEPS of the deepest step reached; STEPS.length = none.
  for (let i = 0; i < STEPS.length; i++) {
    // Cal mounts first and can report its error seconds later (CalEmbed's
    // "late failure"), so a mount that ended in `failed` never counts as loaded.
    if (STEPS[i].key === 'cal_ready' && row.f_cal_failed) continue;
    if (row[STEPS[i].flag]) return i;
  }
  return STEPS.length;
}

const reached = (row: SessionFlags, key: StepKey): boolean => depth(row) <= STEPS.findIndex((step) => step.key === key);

function funnel(rows: SessionFlags[]): { key: string; label: string; n: number }[] {
  const humans = rows.filter((row) => row.human);
  const counts = new Map<StepKey, number>();
  for (const step of STEPS) counts.set(step.key, 0);
  for (const row of humans) {
    for (let i = depth(row); i < STEPS.length; i++) counts.set(STEPS[i].key, (counts.get(STEPS[i].key) ?? 0) + 1);
  }
  return [
    { key: 'landed', label: 'Landed', n: rows.length },
    { key: 'engaged', label: 'Engaged', n: humans.length },
    ...[...STEPS].reverse().map((step) => ({ key: step.key, label: step.label, n: counts.get(step.key) ?? 0 })),
  ];
}

async function sessionRows(
  db: D1Database,
  fromDays: number,
  toDays: number,
  internal: number,
  source: string,
  device: string
): Promise<SessionFlags[]> {
  const filters = ["s.started_at >= datetime('now', ?)", "s.started_at < datetime('now', ?)", 's.internal = ?'];
  const binds: unknown[] = [`-${fromDays} days`, `-${toDays} days`, internal];
  if (source) {
    filters.push('s.source = ?');
    binds.push(source);
  }
  if (device) {
    filters.push('s.device = ?');
    binds.push(device);
  }
  const result = await db
    .prepare(
      `SELECT s.sid, s.started_at, s.landing_path, s.source, s.visit_n, s.country, s.device, s.browser, s.build, s.human,
              (SELECT s2.source FROM site_sessions s2 WHERE s2.vid = s.vid ORDER BY s2.started_at LIMIT 1) AS first_source,
              (SELECT e2.path   FROM site_events e2 WHERE e2.sid = s.sid ORDER BY e2.seq DESC LIMIT 1) AS last_path,
              (SELECT e3.detail FROM site_events e3
                WHERE e3.sid = s.sid AND e3.name = 'view'
                  AND e3.path = (SELECT e4.path FROM site_events e4 WHERE e4.sid = s.sid ORDER BY e4.seq DESC LIMIT 1)
                ORDER BY e3.seq DESC LIMIT 1) AS last_view,
              COUNT(e.id) AS n_events,
              COALESCE(MAX(e.t_ms), 0) AS dur_ms,
              COUNT(DISTINCT CASE WHEN e.name = 'pv' THEN e.path END) AS n_pages,
              COALESCE(SUM(e.name = 'view' AND e.detail LIKE 'shoot:%'), 0) AS n_shoots,
              MAX(e.name = 'pv'   AND e.path = '/sessions/')   AS f_sessions,
              MAX(e.name = 'view' AND e.detail = 'offer')      AS f_offer,
              MAX(e.name = 'view' AND e.detail = 'book')       AS f_book,
              MAX(e.name = 'cal'  AND e.detail = 'ready')      AS f_cal_ready,
              MAX(e.name = 'cal'  AND e.detail LIKE 'failed%') AS f_cal_failed,
              MAX(e.name = 'cal'  AND e.detail LIKE 'step:%')  AS f_cal_used,
              MAX(e.name = 'cal'  AND e.detail = 'booked')     AS f_booked,
              MAX(e.name = 'click' AND e.detail = 'mailto')    AS f_mailto
         FROM site_sessions s
         LEFT JOIN site_events e ON e.sid = s.sid
        WHERE ${filters.join(' AND ')}
        GROUP BY s.sid
        ORDER BY s.started_at DESC`
    )
    .bind(...binds)
    .all<SessionFlags>();
  return result.results;
}

export async function insightsOverview(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const days = Math.min(Math.max(Number(params.get('days')) || 30, 1), 400);
  const internal = params.get('internal') === '1' ? 1 : 0;
  const source = (params.get('source') ?? '').replace(/[^a-z0-9_.-]/g, '').slice(0, 40);
  const device = (params.get('device') ?? '').replace(/[^a-z]/g, '').slice(0, 10);

  const [rows, prior, reach, calReady, filterValues] = await Promise.all([
    sessionRows(env.DB, days, 0, internal, source, device),
    sessionRows(env.DB, days * 2, days, internal, source, device),
    // Every labelled signal, as "how many engaged sessions did this at least
    // once" — FAQ openings, shoots seen, CTA clicks, scroll depth, cal states.
    env.DB.prepare(
      `SELECT e.path, e.name, e.detail, COUNT(DISTINCT e.sid) AS n
         FROM site_events e JOIN site_sessions s ON s.sid = e.sid
        WHERE s.started_at >= datetime('now', ?) AND s.internal = ? AND s.human = 1
          AND e.name IN ('view', 'click', 'faq', 'cal', 'scroll')
          ${source ? 'AND s.source = ?' : ''} ${device ? 'AND s.device = ?' : ''}
        GROUP BY e.path, e.name, e.detail
        ORDER BY n DESC`
    )
      .bind(...[`-${days} days`, internal, ...(source ? [source] : []), ...(device ? [device] : [])])
      .all<{ path: string; name: string; detail: string; n: number }>(),
    env.DB.prepare(
      `SELECT e.v AS ms, s.browser, s.country
         FROM site_events e JOIN site_sessions s ON s.sid = e.sid
        WHERE s.started_at >= datetime('now', ?) AND s.internal = ?
          AND e.name = 'cal' AND e.detail = 'ready' AND e.v IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM site_events f WHERE f.sid = e.sid AND f.name = 'cal' AND f.detail LIKE 'failed%')`
    )
      .bind(`-${days} days`, internal)
      .all<{ ms: number; browser: string; country: string }>(),
    env.DB.prepare(
      `SELECT DISTINCT source FROM site_sessions WHERE started_at >= datetime('now', '-400 days') ORDER BY source`
    ).all<{ source: string }>(),
  ]);

  // Sources: the same "got at least this far" rule, per source.
  const bySource = new Map<string, { source: string; landed: number; engaged: number; sessions: number; book: number; cal_used: number; booked: number }>();
  for (const row of rows) {
    const entry = bySource.get(row.source) ?? { source: row.source, landed: 0, engaged: 0, sessions: 0, book: 0, cal_used: 0, booked: 0 };
    entry.landed += 1;
    if (row.human) {
      entry.engaged += 1;
      if (reached(row, 'sessions')) entry.sessions += 1;
      if (reached(row, 'book')) entry.book += 1;
      if (reached(row, 'cal_used')) entry.cal_used += 1;
      if (reached(row, 'booked')) entry.booked += 1;
    }
    bySource.set(row.source, entry);
  }

  // Where engaged sessions that did NOT book came to rest.
  const ends = new Map<string, number>();
  for (const row of rows) {
    if (!row.human || row.f_booked) continue;
    const key = `${row.last_path ?? row.landing_path}|${row.last_view ?? ''}`;
    ends.set(key, (ends.get(key) ?? 0) + 1);
  }

  const readyTimes = calReady.results.map((r) => r.ms).sort((a, b) => a - b);
  const calFailed = rows.filter((row) => row.f_cal_failed);

  return json({
    days,
    funnel: funnel(rows),
    prior: funnel(prior),
    sources: [...bySource.values()].sort((a, b) => b.landed - a.landed),
    ends: [...ends.entries()]
      .map(([key, n]) => ({ path: key.split('|')[0], section: key.split('|')[1], n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 12),
    reach: reach.results,
    cal: {
      ready: readyTimes.length,
      median_ms: readyTimes.length ? readyTimes[Math.floor(readyTimes.length / 2)] : null,
      failed: calFailed.map((row) => ({ sid: row.sid, browser: row.browser, country: row.country, device: row.device })),
    },
    filters: { sources: filterValues.results.map((r) => r.source) },
    sessions: rows.slice(0, 150),
  });
}

export async function insightsSession(env: Env, sid: string): Promise<Response> {
  if (!/^[a-z0-9]{16,32}$/.test(sid)) return json({ error: 'bad id' }, 400);
  const events = await env.DB.prepare(
    'SELECT seq, t_ms, path, name, detail, v FROM site_events WHERE sid = ? ORDER BY seq'
  )
    .bind(sid)
    .all<{ seq: number; t_ms: number; path: string; name: string; detail: string; v: number | null }>();
  return json({ events: events.results });
}
