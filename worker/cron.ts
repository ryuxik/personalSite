/**
 * Daily lifecycle pass (wrangler.jsonc triggers.crons). Deletion fails safe in
 * BOTH directions (review §R2), and the design is LOGICAL deletion:
 *
 *   too-early direction — expiry never touches R2. It flips the gallery to
 *   `deleted` (every /g surface tombstones instantly — server-side revocation
 *   is immediate) and stamps purge_after = +7 days. The bytes sit untouched
 *   through the grace window, so a misfire costs nothing and an "undo" is a
 *   row update. This replaced an earlier copy-to-trash/ scheme that spent
 *   3 subrequests per object and would have blown the Workers subrequest cap
 *   on a real ~900-object gallery (review finding). The Grain Studio masters
 *   on the Mac remain the backstop of last resort regardless.
 *
 *   failed-to-delete direction — a reconciliation pass diffs R2 prefixes
 *   against DB rows and emails about orphans instead of trusting deletes.
 *
 * Every stage runs in its own try/catch: one Resend outage must never block
 * the deletion stages behind it. Notification flags commit ONLY when the
 * email was actually accepted (emailPhotographer returns false on no-op or
 * failure) — otherwise a fresh deploy without RESEND_API_KEY would burn every
 * flag and silently lose the notifications forever.
 *
 * Never R2 lifecycle rules: their fixed object age fights the Extend button.
 * Emails go to the photographer only (v1 collects no client address).
 */

import { ensureSchema, logEvent, type GalleryRow } from './lib/db';
import { emailPhotographer } from './lib/email';
import { esc } from './lib/html';

const GRACE_DAYS = 7;
const DAY = 86_400_000;
const DELETE_BATCH = 1000; // R2 delete() accepts up to 1000 keys per call
const DIGEST_CAP = 80;     // a comment-spam run must not become a megabyte email

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

async function deleteKeys(env: Env, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    await env.MEDIA.delete(keys.slice(i, i + DELETE_BATCH));
  }
}

/** Logical delete: tombstone now, purge bytes after the grace. Idempotent.
 * Used by the cron for expiry and by admin's typed-confirm delete. */
export async function markDeleted(env: Env, gallery: GalleryRow): Promise<void> {
  const purgeAfter = new Date(Date.now() + GRACE_DAYS * DAY).toISOString();
  await env.DB.prepare(
    "UPDATE galleries SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?), purge_after = COALESCE(purge_after, ?) WHERE id = ?"
  )
    .bind(new Date().toISOString(), purgeAfter, gallery.id)
    .run();
  await logEvent(env.DB, gallery.id, 'deleted', `grace until ${purgeAfter}`);
}

type Stage = [name: string, run: () => Promise<void>];

export async function runCron(env: Env): Promise<void> {
  await ensureSchema(env.DB);
  const now = new Date();
  const nowIso = now.toISOString();
  const db = env.DB;
  const admin = (id: number) => `${env.PUBLIC_ORIGIN ?? ''}/admin/g/${id}`;

  const stages: Stage[] = [
    // ---- expiry warnings (photographer only; flags commit on delivery) ----
    ['warnings', async () => {
      const rows = await db
        .prepare("SELECT * FROM galleries WHERE status IN ('live', 'draft') AND expiry_at > ?")
        .bind(nowIso)
        .all<GalleryRow>();
      for (const g of rows.results) {
        const daysLeft = Math.ceil((new Date(g.expiry_at).getTime() - now.getTime()) / DAY);
        if (daysLeft <= 14 && !g.warn14_sent) {
          const sent = await emailPhotographer(
            env,
            `Selects — ${g.title} expires in ${daysLeft} day(s)`,
            `<p><strong>${esc(g.title)}</strong> (${g.status}) auto-deletes on ${esc(g.expiry_at.slice(0, 10))}.
             Every image byte will be purged after a ${GRACE_DAYS}-day grace (the record and threads survive).</p>
             <p><a href="${admin(g.id)}">Extend +30 days / download the archive</a></p>`
          );
          if (sent) await db.prepare('UPDATE galleries SET warn14_sent = 1 WHERE id = ?').bind(g.id).run();
        }
        if (daysLeft <= 3 && !g.warn3_sent) {
          const sent = await emailPhotographer(
            env,
            `Selects — ${g.title} expires in ${daysLeft} day(s) (final notice)`,
            `<p>Final notice for <strong>${esc(g.title)}</strong>.</p><p><a href="${admin(g.id)}">Extend or let it go</a></p>`
          );
          if (sent) await db.prepare('UPDATE galleries SET warn3_sent = 1 WHERE id = ?').bind(g.id).run();
        }
      }
    }],

    // ---- expiry: BOTH live and draft galleries (a never-launched shoot must
    // not become a permanent-retention loophole — review finding) ------------
    ['expiry', async () => {
      const dead = await db
        .prepare("SELECT * FROM galleries WHERE status IN ('live', 'draft') AND expiry_at < ?")
        .bind(nowIso)
        .all<GalleryRow>();
      for (const g of dead.results) await markDeleted(env, g);
    }],

    // ---- purge: deleted galleries past their grace --------------------------
    ['purge-galleries', async () => {
      const purgeable = await db
        .prepare("SELECT * FROM galleries WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after < ?")
        .bind(nowIso)
        .all<GalleryRow>();
      for (const g of purgeable.results) {
        const keys = await listAll(env, `galleries/${g.id}/`);
        await deleteKeys(env, keys);
        await db.prepare('UPDATE galleries SET purge_after = NULL WHERE id = ?').bind(g.id).run();
        await logEvent(db, g.id, 'purged', `${keys.length} objects`);
      }
    }],

    // ---- purge: soft-removed photos past their grace ------------------------
    ['purge-photos', async () => {
      const cutoff = new Date(now.getTime() - GRACE_DAYS * DAY).toISOString();
      const rows = await db
        .prepare(
          `SELECT p.id AS pid, p.gallery_id AS gid FROM photos p
             JOIN galleries g ON g.id = p.gallery_id
            WHERE p.removed = 1 AND p.removed_at < ? AND g.status != 'deleted'
              AND EXISTS (SELECT 1 FROM assets a WHERE a.photo_id = p.id AND a.r2_key != '')`
        )
        .bind(cutoff)
        .all<{ pid: number; gid: number }>();
      for (const r of rows.results) {
        const keys = await listAll(env, `galleries/${r.gid}/${r.pid}/`);
        await deleteKeys(env, keys);
        await db.prepare("UPDATE assets SET r2_key = '' WHERE photo_id = ?").bind(r.pid).run();
        await logEvent(db, r.gid, 'photo-purged', `photo ${r.pid}, ${keys.length} objects`);
      }
    }],

    // ---- reconciliation: bytes that should not exist -------------------------
    // Two orphan classes (a rows-only check was dead code, since gallery rows
    // are never deleted — review finding): (a) prefixes with NO row at all,
    // (b) bytes for galleries the purge pass claims to have emptied
    // (status='deleted' with purge_after already cleared).
    ['reconciliation', async () => {
      const rows = await db
        .prepare('SELECT id, status, purge_after FROM galleries')
        .all<{ id: number; status: string; purge_after: string | null }>();
      const byId = new Map(rows.results.map((r) => [String(r.id), r]));
      const orphans = new Set<string>();
      for (const key of await listAll(env, 'galleries/')) {
        const gid = key.split('/')[1];
        if (!gid) continue;
        const row = byId.get(gid);
        if (!row) orphans.add(`${gid} (no record)`);
        else if (row.status === 'deleted' && !row.purge_after) orphans.add(`${gid} (purge incomplete)`);
      }
      if (orphans.size > 0) {
        await emailPhotographer(
          env,
          `Selects — reconciliation found ${orphans.size} orphaned gallery prefix(es)`,
          `<p>R2 holds bytes for gallery id(s) the database has no row for:
           <strong>${esc([...orphans].join(', '))}</strong>. Nothing was touched —
           inspect and delete by hand.</p>`
        );
      }
    }],

    // ---- comment digest (capped; unsent stay unflagged for the next run) ----
    ['digest', async () => {
      const fresh = await db
        .prepare(
          `SELECT c.id, c.author, c.body, p.stem AS stem, g.title AS title
             FROM comments c JOIN photos p ON p.id = c.photo_id JOIN galleries g ON g.id = p.gallery_id
            WHERE c.notified = 0 AND c.by_owner = 0 ORDER BY c.created_at LIMIT ?`
        )
        .bind(DIGEST_CAP + 1)
        .all<{ id: number; author: string; body: string; stem: string; title: string }>();
      if (fresh.results.length === 0) return;
      const shown = fresh.results.slice(0, DIGEST_CAP);
      const more = fresh.results.length > DIGEST_CAP;
      const lines = shown
        .map((c) => `<li><strong>${esc(c.title)}</strong> · ${esc(c.stem)} — ${esc(c.author)}: ${esc(c.body.slice(0, 300))}</li>`)
        .join('');
      const sent = await emailPhotographer(
        env,
        `Selects — ${shown.length}${more ? '+' : ''} new comment(s)`,
        `<ul>${lines}</ul>${more ? '<p>…and more — see admin.</p>' : ''}<p><a href="${env.PUBLIC_ORIGIN ?? ''}/admin">Open admin</a></p>`
      );
      if (sent) {
        for (const c of shown) await db.prepare('UPDATE comments SET notified = 1 WHERE id = ?').bind(c.id).run();
      }
    }],
  ];

  for (const [name, run] of stages) {
    try {
      await run();
    } catch (error) {
      // One stage's failure must never block the stages behind it.
      console.log(`cron stage ${name} failed:`, (error as Error).stack ?? String(error));
    }
  }
}
