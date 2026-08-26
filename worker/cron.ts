/**
 * Daily lifecycle pass (wrangler.jsonc triggers.crons). Deletion fails safe in
 * BOTH directions (review § R2):
 *
 *   too-early direction — nothing is ever hard-deleted directly. Expiry moves
 *   bytes to trash/<gid>/… and stamps purge_after = +7 days; a cron misfire
 *   costs a copy operation, not a client's photographs. The Lightroom / Grain
 *   Studio masters on the Mac are the backstop of last resort regardless.
 *
 *   failed-to-delete direction — a reconciliation pass diffs R2 prefixes
 *   against live DB rows and emails about orphans instead of trusting that
 *   deletes "must have worked".
 *
 * Never R2 lifecycle rules: their fixed object age fights the Extend button.
 * All emails go to the photographer only (v1 collects no client address).
 */

import { ensureSchema, logEvent, type GalleryRow } from './lib/db';
import { emailPhotographer } from './lib/email';
import { esc } from './lib/html';

const GRACE_DAYS = 7;
const DAY = 86_400_000;

async function listAll(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const r = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    keys.push(...r.objects.map((o) => o.key));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return keys;
}

/** Move a gallery's bytes to trash/ and mark it deleted. Idempotent. */
export async function trashGallery(env: Env, gallery: GalleryRow): Promise<void> {
  const keys = await listAll(env, `galleries/${gallery.id}/`);
  for (const key of keys) {
    const object = await env.MEDIA.get(key);
    if (object) await env.MEDIA.put(`trash/${key}`, object.body);
    await env.MEDIA.delete(key);
  }
  const purgeAfter = new Date(Date.now() + GRACE_DAYS * DAY).toISOString();
  await env.DB.prepare(
    "UPDATE galleries SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?), purge_after = COALESCE(purge_after, ?) WHERE id = ?"
  )
    .bind(new Date().toISOString(), purgeAfter, gallery.id)
    .run();
  await logEvent(env.DB, gallery.id, 'trashed', `${keys.length} objects, purge after ${purgeAfter}`);
}

export async function runCron(env: Env): Promise<void> {
  await ensureSchema(env.DB);
  const now = new Date();
  const nowIso = now.toISOString();
  const db = env.DB;

  // ---- expiry warnings (photographer only; one-click extend link) ----------
  const warnable = await db
    .prepare("SELECT * FROM galleries WHERE status = 'live'")
    .all<GalleryRow>();
  for (const g of warnable.results) {
    const msLeft = new Date(g.expiry_at).getTime() - now.getTime();
    const daysLeft = Math.ceil(msLeft / DAY);
    const admin = `${env.PUBLIC_ORIGIN ?? ''}/admin/g/${g.id}`;
    if (msLeft > 0 && daysLeft <= 14 && !g.warn14_sent) {
      await emailPhotographer(
        env,
        `Selects — ${g.title} expires in ${daysLeft} day(s)`,
        `<p><strong>${esc(g.title)}</strong> auto-deletes on ${esc(g.expiry_at.slice(0, 10))}.
         Every image byte will be purged (the record and threads survive).</p>
         <p><a href="${admin}">Extend +30 days / download the archive</a></p>`
      );
      await db.prepare('UPDATE galleries SET warn14_sent = 1 WHERE id = ?').bind(g.id).run();
    }
    if (msLeft > 0 && daysLeft <= 3 && !g.warn3_sent) {
      await emailPhotographer(
        env,
        `Selects — ${g.title} expires in ${daysLeft} day(s) (final notice)`,
        `<p>Final notice for <strong>${esc(g.title)}</strong>.</p><p><a href="${admin}">Extend or let it go</a></p>`
      );
      await db.prepare('UPDATE galleries SET warn3_sent = 1 WHERE id = ?').bind(g.id).run();
    }
  }

  // ---- expiry: live + past expiry → trash (grace starts) -------------------
  const dead = await db
    .prepare("SELECT * FROM galleries WHERE status = 'live' AND expiry_at < ?")
    .bind(nowIso)
    .all<GalleryRow>();
  for (const g of dead.results) await trashGallery(env, g);

  // ---- purge: trash past its grace ----------------------------------------
  const purgeable = await db
    .prepare("SELECT * FROM galleries WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after < ?")
    .bind(nowIso)
    .all<GalleryRow>();
  for (const g of purgeable.results) {
    const keys = await listAll(env, `trash/galleries/${g.id}/`);
    for (const key of keys) await env.MEDIA.delete(key);
    await db.prepare('UPDATE galleries SET purge_after = NULL WHERE id = ?').bind(g.id).run();
    await logEvent(db, g.id, 'purged', `${keys.length} objects`);
  }

  // ---- reconciliation: storage the DB does not know about ------------------
  const live = await db.prepare('SELECT id FROM galleries').all<{ id: number }>();
  const known = new Set(live.results.map((r) => String(r.id)));
  const prefixes = new Set<string>();
  for (const key of await listAll(env, 'galleries/')) {
    const gid = key.split('/')[1];
    if (gid && !known.has(gid)) prefixes.add(gid);
  }
  if (prefixes.size > 0) {
    await emailPhotographer(
      env,
      `Selects — reconciliation found ${prefixes.size} orphaned gallery prefix(es)`,
      `<p>R2 holds bytes for gallery id(s) the database has no row for:
       <strong>${esc([...prefixes].join(', '))}</strong>. Nothing was touched —
       inspect and delete by hand.</p>`
    );
  }

  // ---- comment digest ------------------------------------------------------
  const fresh = await db
    .prepare(
      `SELECT c.id, c.author, c.body, p.stem AS stem, g.title AS title, g.id AS gid
         FROM comments c JOIN photos p ON p.id = c.photo_id JOIN galleries g ON g.id = p.gallery_id
        WHERE c.notified = 0 AND c.by_owner = 0 ORDER BY g.id, c.created_at`
    )
    .all<{ id: number; author: string; body: string; stem: string; title: string; gid: number }>();
  if (fresh.results.length > 0) {
    const lines = fresh.results
      .map(
        (c) =>
          `<li><strong>${esc(c.title)}</strong> · ${esc(c.stem)} — ${esc(c.author)}: ${esc(c.body.slice(0, 300))}</li>`
      )
      .join('');
    await emailPhotographer(
      env,
      `Selects — ${fresh.results.length} new comment(s)`,
      `<ul>${lines}</ul><p><a href="${env.PUBLIC_ORIGIN ?? ''}/admin">Open admin</a></p>`
    );
    for (const c of fresh.results)
      await db.prepare('UPDATE comments SET notified = 1 WHERE id = ?').bind(c.id).run();
  }
}
