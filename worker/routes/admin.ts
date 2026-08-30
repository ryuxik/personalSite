/**
 * /admin + /api/admin/* — the photographer's surface. Single operator.
 *
 * Auth, two layers: in production Cloudflare Access sits in front of /admin*
 * and /api/admin* at the edge (no login code of consequence here — the whole
 * point). Underneath, this Worker requires SELECTS_ADMIN_TOKEN: the ingest
 * CLI sends it as a Bearer header; a browser session is bootstrapped by
 * POSTing the token to /admin/session (a form on the locked page — the token
 * NEVER travels in a URL, which would persist it in history and edge logs).
 * The session cookie stores an HMAC-derived value, not the raw secret, and
 * every comparison is timing-safe (review findings).
 *
 * The upload endpoint is the ingest CLI's target: one PUT per file, metadata
 * in query params, body streamed into R2 and then VERIFIED against the
 * declared byte count (a truncated PUT would otherwise desynchronize zip
 * offsets downstream). Bytes are canonical once verified — nothing after
 * ingest ever rewrites them.
 */

import {
  ensureSchema,
  galleryById,
  galleryBySlug,
  galleryPhotos,
  currentAssets,
  logEvent,
  type GalleryRow,
  type PhotoRow,
  type AssetRow,
} from '../lib/db';
import { newAccessKey, slugify, keyEquals } from '../lib/keys';
import { esc, page, json } from '../lib/html';
import { markDeleted } from '../cron';
import { crc32 as crc32Of, hasIsoGainMap } from '../lib/bytes';
// Pure-JS EXIF parsing (works on HEIC and JPEG) — the GPS gate now lives in
// the WORKER so browser ingest is held to the same standard as the CLI.
import ExifReader from 'exifreader';
import { verifyAccessJwt } from '../lib/access';

/** Fixed kinds plus l<width>/a<width> ladder rungs — widths are dynamic since
 * a narrow master contributes its own width as the top rung (photo-meta rule). */
const FIXED_KINDS = new Set(['original', 'instagram', 'rednote', 'preview']);
const RUNG_KIND = /^[la]\d{3,4}$/;
const validKind = (kind: string) => FIXED_KINDS.has(kind) || RUNG_KIND.test(kind);

const ADMIN_COOKIE = 'selects_admin';
const COOKIE_CONTEXT = 'selects-admin-cookie-v1';

/** The cookie carries HMAC(token, context), not the token — a captured cookie
 * is not the CLI bearer, and rotating the secret invalidates every session. */
async function derivedCookieValue(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(COOKIE_CONTEXT));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function authed(request: Request, env: Env): Promise<boolean> {
  // A verified Cloudflare Access login (signature, issuer, audience, expiry,
  // AND the photographer's email) is an admin session by itself — no second
  // login. The token paths below remain for the CLI and as the fallback.
  if (await verifyAccessJwt(env, request.headers.get('Cf-Access-Jwt-Assertion'))) return true;
  const token = env.SELECTS_ADMIN_TOKEN;
  if (!token) return false; // no token configured → admin is closed, not open
  const header = request.headers.get('Authorization') ?? '';
  if (header.startsWith('Bearer ') && keyEquals(header.slice(7), token)) return true;
  const cookies = request.headers.get('Cookie') ?? '';
  const expected = await derivedCookieValue(token);
  for (const part of cookies.split(/;\s*/)) {
    if (part.startsWith(`${ADMIN_COOKIE}=`) && keyEquals(part.slice(ADMIN_COOKIE.length + 1), expected))
      return true;
  }
  return false;
}

function lockedPage(status: number, message = ''): Response {
  const body = page(
    'Selects admin',
    '<link rel="stylesheet" href="/admin/admin.css">',
    `<main class="admin" style="max-width:26rem">
  <header class="ahead"><h1>Selects</h1><p class="ahead__sub">admin</p></header>
  <section class="panel">
    ${message ? `<p style="color:var(--warn)">${esc(message)}</p>` : ''}
    <form method="POST" action="/admin/session">
      <label>Admin token <input type="password" name="token" autocomplete="current-password" required></label>
      <button class="btn" type="submit">Start session</button>
    </form>
    <p class="muted">Behind Cloudflare Access in production; this token is the same
    secret the ingest CLI uses.</p>
  </section>
</main>`
  );
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
  });
}

export async function handleAdmin(request: Request, env: Env, path: string[]): Promise<Response> {
  // The admin UI's own static files live under /admin/* which run_worker_first
  // routes here — hand anything file-shaped straight back to the asset layer
  // (they are public css/js; Access gates them in production).
  if (path[0] === 'admin' && path.length >= 2 && /\.[a-z0-9]+$/i.test(path[path.length - 1]))
    return env.ASSETS.fetch(request);

  // Session bootstrap: POST form, never a query string.
  if (path[0] === 'admin' && path[1] === 'session' && request.method === 'POST') {
    const token = env.SELECTS_ADMIN_TOKEN;
    const form = await request.formData().catch(() => null);
    const supplied = String(form?.get('token') ?? '');
    if (!token || !supplied || !keyEquals(supplied, token)) return lockedPage(403, 'That token is not right.');
    return new Response(null, {
      status: 303,
      headers: {
        Location: '/admin',
        'Set-Cookie': `${ADMIN_COOKIE}=${await derivedCookieValue(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
      },
    });
  }

  if (!(await authed(request, env))) {
    return path[0] === 'admin' ? lockedPage(401) : json({ error: 'unauthorized' }, 401);
  }
  await ensureSchema(env.DB); // after auth: anonymous probes never touch D1

  if (path[0] === 'admin') {
    if (path.length === 1) return adminHome();
    if (path[1] === 'g' && path[2]) return adminGallery(env, Number(path[2]));
    return json({ error: 'not found' }, 404);
  }

  // /api/admin/*
  const rest = path.slice(2);
  const method = request.method;

  if (rest[0] === 'galleries' && rest.length === 1 && method === 'POST') return createGallery(request, env);
  if (rest[0] === 'galleries' && rest.length === 1 && method === 'GET') return listGalleries(env);
  if (rest[0] === 'galleries' && rest[1]) {
    const galleryId = Number(rest[1]);
    if (!Number.isInteger(galleryId)) return json({ error: 'bad id' }, 400);
    const gallery = await galleryById(env.DB, galleryId);
    if (!gallery) return json({ error: 'unknown gallery' }, 404);
    if (rest.length === 2 && method === 'GET') return galleryState(env, gallery);
    if (rest.length === 2 && method === 'PATCH') return patchGallery(request, env, gallery);
    if (rest.length === 2 && method === 'DELETE') return deleteGallery(request, env, gallery);
    if (rest[2] === 'upload' && method === 'PUT') return upload(request, env, gallery);
    if (rest[2] === 'media' && rest[3] && rest[4] && method === 'GET')
      return adminMedia(env, gallery, rest[3], rest[4]);
    if (rest[2] === 'photos' && rest[3] && method === 'DELETE') return removePhoto(env, gallery, rest[3]);
  }
  if (rest[0] === 'comments' && rest[1] && rest[2] === 'reply' && method === 'POST')
    return replyComment(request, env, Number(rest[1]));
  if (rest[0] === 'comments' && rest[1] && rest[2] === 'resolve' && method === 'POST')
    return resolveComment(env, Number(rest[1]));
  return json({ error: 'not found' }, 404);
}

/* --------------------------------------------------------------- mutations */

async function createGallery(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body?.title) return json({ error: 'title required' }, 400);
  const slug = slugify(String(body.slug ?? body.title));
  const existing = await galleryBySlug(env.DB, slug);
  if (existing) return json({ gallery: existing, existed: true });
  const days = Number(body.expiry_days ?? 60);
  const expiry = new Date(Date.now() + days * 86_400_000).toISOString();
  const key = newAccessKey();
  const r = await env.DB.prepare(
    `INSERT INTO galleries (slug, title, client_name, n_marks, access_key, expiry_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(slug, String(body.title), String(body.client ?? ''), Number(body.n ?? 3), key, expiry)
    .run();
  const gallery = await galleryById(env.DB, r.meta.last_row_id);
  await logEvent(env.DB, gallery!.id, 'created', slug);
  return json({ gallery, existed: false });
}

async function patchGallery(request: Request, env: Env, gallery: GalleryRow): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const db = env.DB;
  if (typeof body.title === 'string' && body.title.trim()) {
    await db.prepare('UPDATE galleries SET title = ? WHERE id = ?')
      .bind(body.title.trim().slice(0, 120), gallery.id).run();
    await logEvent(db, gallery.id, 'renamed', body.title.trim().slice(0, 120));
  }
  if (typeof body.client === 'string') {
    await db.prepare('UPDATE galleries SET client_name = ? WHERE id = ?')
      .bind(body.client.trim().slice(0, 120), gallery.id).run();
  }
  if (typeof body.slug === 'string' && body.slug.trim()) {
    // Personalized URLs track the shoot name (original requirement): changing
    // the slug moves the gallery to a new link — the old one dies instantly,
    // same revocation semantics as a key rotation.
    const newSlug = slugify(body.slug);
    if (newSlug !== gallery.slug) {
      const clash = await galleryBySlug(env.DB, newSlug);
      if (clash) return json({ error: `the link name "${newSlug}" is already used by another gallery` }, 409);
      await db.prepare('UPDATE galleries SET slug = ? WHERE id = ?').bind(newSlug, gallery.id).run();
      await logEvent(db, gallery.id, 'slug-changed', `${gallery.slug} → ${newSlug} (old link dead)`);
    }
  }
  if (body.status === 'live' || body.status === 'draft') {
    if (gallery.status === 'deleted') {
      // Logical deletion makes restore-within-grace a real feature — but a
      // stale purge_after must never survive the flip (it would collapse the
      // next deletion's grace to zero — review finding), and a purged gallery
      // has no bytes left to restore.
      if (!gallery.purge_after)
        return json({ error: 'already purged — the bytes are gone; re-ingest instead' }, 409);
      await db
        .prepare('UPDATE galleries SET status = ?, deleted_at = NULL, purge_after = NULL WHERE id = ?')
        .bind(body.status, gallery.id)
        .run();
      await logEvent(db, gallery.id, 'restored', `to ${body.status} within grace`);
    } else {
      await db.prepare('UPDATE galleries SET status = ? WHERE id = ?').bind(body.status, gallery.id).run();
      await logEvent(db, gallery.id, `status-${body.status}`);
    }
  }
  if (body.rotate === true) {
    await db
      .prepare('UPDATE galleries SET access_key = ?, key_version = key_version + 1 WHERE id = ?')
      .bind(newAccessKey(), gallery.id)
      .run();
    await logEvent(db, gallery.id, 'key-rotated');
  }
  if (typeof body.extend_days === 'number') {
    const next = new Date(
      Math.max(Date.now(), new Date(gallery.expiry_at).getTime()) + body.extend_days * 86_400_000
    ).toISOString();
    await db
      .prepare('UPDATE galleries SET expiry_at = ?, warn14_sent = 0, warn3_sent = 0 WHERE id = ?')
      .bind(next, gallery.id)
      .run();
    await logEvent(db, gallery.id, 'extended', `to ${next}`);
  }
  if (typeof body.n === 'number' && body.n > 0) {
    await db.prepare('UPDATE galleries SET n_marks = ? WHERE id = ?').bind(body.n, gallery.id).run();
  }
  if (body.reopen === true) {
    await db.prepare("UPDATE galleries SET marks_state = 'open' WHERE id = ?").bind(gallery.id).run();
    await logEvent(db, gallery.id, 'marks-reopened');
  }
  return json({ gallery: await galleryById(db, gallery.id) });
}

/** Typed-confirm delete: LOGICAL — tombstone now, bytes purged by cron after
 * the 7-day grace (same path expiry takes). Nothing is hard-deleted here. */
async function deleteGallery(request: Request, env: Env, gallery: GalleryRow): Promise<Response> {
  const confirm = new URL(request.url).searchParams.get('confirm');
  if (confirm !== gallery.slug) return json({ error: 'confirm with ?confirm=<slug>' }, 400);
  await markDeleted(env, gallery);
  return json({ ok: true });
}

/** Photo removal is soft: hidden from every surface immediately, bytes purged
 * by cron after the grace, rows (and the client's comments) kept as records. */
async function removePhoto(env: Env, gallery: GalleryRow, photoId: string): Promise<Response> {
  const pid = Number(photoId);
  if (!Number.isInteger(pid)) return json({ error: 'bad id' }, 400);
  const photo = await env.DB.prepare('SELECT * FROM photos WHERE id = ? AND gallery_id = ?')
    .bind(pid, gallery.id)
    .first<PhotoRow>();
  if (!photo) return json({ error: 'unknown photo' }, 404);
  await env.DB.prepare('UPDATE photos SET removed = 1, removed_at = ?, marked = 0 WHERE id = ?')
    .bind(new Date().toISOString(), photo.id)
    .run();
  await logEvent(env.DB, gallery.id, 'photo-removed', `${photo.stem} (bytes purge after grace)`);
  return json({ ok: true });
}

/**
 * PUT /api/admin/galleries/:id/upload?stem=001&kind=original&bytes=…&crc32=…
 *   &content_type=…&filename=…[&width=…&height=…&is_hdr=1&thumbhash=…&color=…]
 *   [&new_version=1]
 * Streams the body into R2, VERIFIES the stored size against the declared
 * bytes (deleting the object on mismatch), and upserts the photo + asset
 * rows. `new_version=1` on an original bumps the photo's version — the polish
 * loop: marks, threads and the "updated" chip all hang off that bump.
 */
async function upload(request: Request, env: Env, gallery: GalleryRow): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const stem = (q.get('stem') ?? '').slice(0, 120);
  const kind = q.get('kind') ?? '';
  const bytes = Number(q.get('bytes'));
  const crc32 = Number(q.get('crc32'));
  const contentType = q.get('content_type') ?? 'application/octet-stream';
  // filename lands in Content-Disposition and zip entry names — strip path
  // separators, quotes, and anything below space (review finding).
  const rawName = q.get('filename') ?? `${stem}-${kind}`;
  let filename = '';
  for (const ch of rawName) {
    if (ch >= ' ' && !'\\/"'.includes(ch)) filename += ch;
  }
  filename = filename.slice(0, 120) || `${stem}-${kind}`;
  const color = q.get('color') ?? '';
  const thumbhash = q.get('thumbhash') ?? '';
  if (!stem || !validKind(kind) || !Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(crc32))
    return json({ error: 'stem, kind, bytes, crc32 required' }, 400);
  // color/thumbhash are interpolated into a style attribute on the client
  // page — validate shape here AND escape at render (defense in depth).
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) return json({ error: 'color must be #rrggbb' }, 400);
  if (thumbhash && !/^data:image\/png;base64,[A-Za-z0-9+/=]{1,12000}$/.test(thumbhash))
    return json({ error: 'thumbhash must be a png data URI' }, 400);
  if (!request.body) return json({ error: 'empty body' }, 400);

  // Buffer for verification (largest masters are ~50MB; isolate limit 128MB).
  if (bytes > 120 * 1024 * 1024) return json({ error: 'file too large' }, 413);
  const payload = new Uint8Array(await request.arrayBuffer());
  if (payload.byteLength !== bytes)
    return json({ error: `size mismatch: declared ${bytes}, received ${payload.byteLength}` }, 400);
  if (crc32Of(payload) !== (crc32 >>> 0))
    return json({ error: 'crc mismatch — upload corrupted in transit' }, 400);

  // GPS gate, fail-closed (server-side so EVERY ingest path is covered):
  // refusing is recoverable; publishing a client's location is not.
  const gpsGated = ['original', 'instagram', 'rednote', 'preview'].includes(kind);
  if (gpsGated && q.get('allow_gps') !== '1') {
    let verdict = 'unreadable';
    try {
      const tags = ExifReader.load(payload.buffer as ArrayBuffer);
      verdict = Object.keys(tags).some((k) =>
        /^GPS(Latitude|Longitude|Position|DestLatitude|DestLongitude|Altitude)$/i.test(k)
      ) ? 'gps' : 'clean';
    } catch {
      verdict = 'unreadable';
    }
    if (verdict !== 'clean')
      return json({
        error: verdict === 'gps'
          ? `${kind} carries GPS metadata — re-export without location, or pass allow_gps=1`
          : `${kind} metadata unreadable, so GPS cannot be ruled out (gate fails closed) — pass allow_gps=1 to override`,
      }, 422);
  }

  // Gain-map gate: the preview and every jpg rung must carry the ISO 21496-1
  // map (else Chrome shows SDR) — unless the shoot is declared SDR.
  const hdrGated = kind === 'preview' || /^l\d+$/.test(kind);
  if (hdrGated && q.get('sdr') !== '1' && q.get('is_hdr') !== '0' && !hasIsoGainMap(payload))
    return json({ error: `${kind} has no ISO 21496-1 gain map — Chrome would render SDR. Pass sdr=1 only for a genuinely SDR shoot.` }, 422);

  let photo = await env.DB.prepare('SELECT * FROM photos WHERE gallery_id = ? AND stem = ?')
    .bind(gallery.id, stem)
    .first<PhotoRow>();

  if (!photo) {
    const r = await env.DB.prepare(
      `INSERT INTO photos (gallery_id, stem, position, width, height, is_hdr, thumbhash, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        gallery.id,
        stem,
        Number(q.get('position') ?? 0),
        Number(q.get('width')) || null,
        Number(q.get('height')) || null,
        q.get('is_hdr') === '0' ? 0 : 1,
        thumbhash,
        color || '#1a1614'
      )
      .run();
    photo = (await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(r.meta.last_row_id).first<PhotoRow>())!;
    await logEvent(env.DB, gallery.id, 'photo-added', stem);
  } else if (kind === 'original' && q.get('new_version') === '1') {
    await env.DB.prepare(
      'UPDATE photos SET version = version + 1, replaced_at = ?, removed = 0, removed_at = NULL WHERE id = ?'
    )
      .bind(new Date().toISOString(), photo.id)
      .run();
    photo = (await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(photo.id).first<PhotoRow>())!;
    await logEvent(env.DB, gallery.id, 'photo-version', `${stem} → v${photo.version}`);
  }

  // preview-derived metadata refresh (any upload may carry it)
  if (q.get('width') && q.get('height')) {
    await env.DB.prepare(
      'UPDATE photos SET width = ?, height = ?, is_hdr = ?, thumbhash = ?, color = ? WHERE id = ?'
    )
      .bind(
        Number(q.get('width')),
        Number(q.get('height')),
        q.get('is_hdr') === '0' ? 0 : 1,
        thumbhash || photo.thumbhash,
        color || photo.color,
        photo.id
      )
      .run();
  }

  const r2Key = `galleries/${gallery.id}/${photo.id}/v${photo.version}/${kind}`;
  // The buffer was already size- and CRC-verified above; store it verbatim.
  await env.MEDIA.put(r2Key, payload, { httpMetadata: { contentType } });
  await env.DB.prepare(
    `INSERT INTO assets (photo_id, kind, version, r2_key, bytes, crc32, content_type, width, height, filename)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (photo_id, kind, version) DO UPDATE SET
       r2_key = excluded.r2_key, bytes = excluded.bytes, crc32 = excluded.crc32,
       content_type = excluded.content_type, width = excluded.width,
       height = excluded.height, filename = excluded.filename`
  )
    .bind(
      photo.id,
      kind,
      photo.version,
      r2Key,
      bytes,
      crc32 >>> 0,
      contentType,
      Number(q.get('asset_width')) || null,
      Number(q.get('asset_height')) || null,
      filename
    )
    .run();
  return json({ ok: true, photo_id: photo.id, version: photo.version, r2_key: r2Key });
}

/** Matrix thumbnails: the admin page must never depend on the client
 * capability URL (drafts hide it — review finding), so it gets its own
 * authed media route. */
async function adminMedia(env: Env, gallery: GalleryRow, photoId: string, kind: string): Promise<Response> {
  const pid = Number(photoId);
  if (!Number.isInteger(pid) || !validKind(kind)) return json({ error: 'bad request' }, 400);
  const photo = await env.DB.prepare('SELECT * FROM photos WHERE id = ? AND gallery_id = ?')
    .bind(pid, gallery.id)
    .first<PhotoRow>();
  if (!photo) return json({ error: 'unknown photo' }, 404);
  const asset = await env.DB.prepare('SELECT * FROM assets WHERE photo_id = ? AND kind = ? AND version = ?')
    .bind(photo.id, kind, photo.version)
    .first<AssetRow>();
  if (!asset || !asset.r2_key) return json({ error: 'no asset' }, 404);
  const object = await env.MEDIA.get(asset.r2_key);
  if (!object) return json({ error: 'missing object' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': asset.content_type,
      'Content-Length': String(object.size),
      'Cache-Control': 'private, max-age=300',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function replyComment(request: Request, env: Env, commentId: number): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { body?: string } | null;
  const text = String(body?.body ?? '').trim();
  if (!text) return json({ error: 'empty' }, 400);
  const parent = await env.DB.prepare('SELECT photo_id FROM comments WHERE id = ?')
    .bind(commentId)
    .first<{ photo_id: number }>();
  if (!parent) return json({ error: 'unknown comment' }, 404);
  await env.DB.prepare(
    "INSERT INTO comments (photo_id, author, by_owner, body, notified) VALUES (?, 'Santiago', 1, ?, 1)"
  )
    .bind(parent.photo_id, text)
    .run();
  return json({ ok: true });
}

async function resolveComment(env: Env, commentId: number): Promise<Response> {
  await env.DB.prepare('UPDATE comments SET resolved = 1 WHERE id = ?').bind(commentId).run();
  return json({ ok: true });
}

/* ------------------------------------------------------------------ reads */

async function listGalleries(env: Env): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT g.*,
            (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id AND p.removed = 0) AS photo_count,
            (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id AND p.marked = 1 AND p.removed = 0) AS marked_count
       FROM galleries g ORDER BY g.created_at DESC`
  ).all();
  return json({ galleries: r.results });
}

async function galleryState(env: Env, gallery: GalleryRow): Promise<Response> {
  const photos = await galleryPhotos(env.DB, gallery.id);
  const assets = await currentAssets(env.DB, gallery.id);
  const comments = await env.DB.prepare(
    `SELECT c.*, p.stem AS stem FROM comments c JOIN photos p ON p.id = c.photo_id
      WHERE p.gallery_id = ? ORDER BY c.created_at DESC`
  )
    .bind(gallery.id)
    .all();
  return json({
    gallery,
    photos: photos.map((p) => ({
      ...p,
      assets: Object.fromEntries(
        [...assets.entries()]
          .filter(([k]) => k.startsWith(`${p.id}/`))
          // crc32 rides along so the ingest CLI's unchanged/heal check is
          // content-true, not byte-length-only (review finding)
          .map(([k, a]) => [k.split('/')[1], { bytes: a.bytes, crc32: a.crc32, filename: a.filename }])
      ),
    })),
    comments: comments.results,
  });
}

/* --------------------------------------------------------------- admin ui */

const ADMIN_HEAD = `<link rel="stylesheet" href="/admin/admin.css">`;

function adminShell(title: string, body: string): Response {
  return new Response(page(title, ADMIN_HEAD, body), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
  });
}

function adminHome(): Response {
  return adminShell(
    'Selects admin',
    `<main class="admin" data-view="home">
  <header class="ahead"><h1>Selects</h1><p class="ahead__sub">private client galleries · ryuxik.io</p></header>
  <section id="create" class="panel">
    <h2>New gallery</h2>
    <form id="create-form">
      <label>Title <input name="title" required placeholder="Atelier Mora — spring lookbook"></label>
      <label>Client <input name="client" placeholder="Nadia R."></label>
      <label>Marks (N) <input name="n" type="number" value="3" min="1" max="50"></label>
      <label>Expires in <input name="expiry_days" type="number" value="60" min="1"> days</label>
      <button class="btn" type="submit">Create</button>
    </form>
  </section>
  <section id="galleries" class="panel"><h2>Galleries</h2><div id="list">Loading…</div></section>
</main>
<script type="module" src="/admin/admin.js"></script>`
  );
}

async function adminGallery(env: Env, id: number): Promise<Response> {
  if (!Number.isInteger(id)) return json({ error: 'bad id' }, 400);
  const gallery = await galleryById(env.DB, id);
  if (!gallery) return json({ error: 'unknown gallery' }, 404);
  return adminShell(
    `${gallery.title} · Selects admin`,
    `<main class="admin" data-view="gallery" data-id="${id}">
  <header class="ahead">
    <p><a href="/admin">← all galleries</a></p>
    <h1>${esc(gallery.title)}</h1>
    <p class="ahead__sub" id="summary"></p>
    <div id="rename-slot"></div>
  </header>
  <section class="panel" id="share"><h2>Share</h2><div id="share-body"></div></section>
  <section class="panel" id="ingest"><h2>Add photos</h2><div id="ingest-body"></div></section>
  <section class="panel" id="matrix"><h2>Photos</h2><div id="matrix-body">Loading…</div></section>
  <section class="panel" id="threads"><h2>Feedback</h2><div id="threads-body"></div></section>
  <section class="panel" id="lifecycle"><h2>Lifecycle</h2><div id="lifecycle-body"></div></section>
</main>
<script type="module" src="/admin/admin.js"></script>`
  );
}
