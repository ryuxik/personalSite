/**
 * /admin + /api/admin/* — the photographer's surface. Single operator.
 *
 * Auth, two layers (plan § 5, review): in production Cloudflare Access sits
 * in front of /admin* and /api/admin* at the edge (no login code here — the
 * whole point). This Worker additionally requires the SELECTS_ADMIN_TOKEN
 * bearer (the ingest CLI's credential, and the belt-and-suspenders for a
 * misconfigured Access). Browser sessions bootstrap via /admin?token=… once,
 * which sets an HttpOnly cookie.
 *
 * The upload endpoint is the ingest CLI's target: one PUT per file, metadata
 * in query params, body streamed straight into R2. Bytes are canonical the
 * moment they land — nothing downstream ever rewrites them.
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
} from '../lib/db';
import { newAccessKey, slugify } from '../lib/keys';
import { esc, page, json } from '../lib/html';

const KINDS = new Set([
  'original', 'instagram', 'rednote', 'preview',
  'l900', 'l1400', 'l2048', 'a900', 'a1400', 'a2048',
]);
const ADMIN_COOKIE = 'selects_admin';

function authed(request: Request, env: Env): boolean {
  const token = env.SELECTS_ADMIN_TOKEN;
  if (!token) return false; // no token configured → admin is closed, not open
  const header = request.headers.get('Authorization') ?? '';
  if (header === `Bearer ${token}`) return true;
  const cookies = request.headers.get('Cookie') ?? '';
  return cookies.split(/;\s*/).includes(`${ADMIN_COOKIE}=${token}`);
}

export async function handleAdmin(request: Request, env: Env, path: string[]): Promise<Response> {
  await ensureSchema(env.DB);
  const url = new URL(request.url);

  // one-time browser bootstrap: /admin?token=… → cookie → clean URL
  if (path[0] === 'admin' && url.searchParams.get('token')) {
    if (url.searchParams.get('token') === env.SELECTS_ADMIN_TOKEN) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: url.pathname,
          'Set-Cookie': `${ADMIN_COOKIE}=${env.SELECTS_ADMIN_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
        },
      });
    }
    return new Response('Bad token.', { status: 403 });
  }

  if (!authed(request, env)) {
    return path[0] === 'admin'
      ? new Response(page('Selects admin', '', '<main style="font-family:sans-serif;max-width:32rem;margin:20vh auto"><h1>Selects admin</h1><p>Locked. Open <code>/admin?token=…</code> with the admin token once to start a session (behind Cloudflare Access in production).</p></main>'), {
          status: 401,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' },
        })
      : json({ error: 'unauthorized' }, 401);
  }

  if (path[0] === 'admin') {
    if (path.length === 1) return adminHome(env);
    if (path[1] === 'g' && path[2]) return adminGallery(env, Number(path[2]));
    return json({ error: 'not found' }, 404);
  }

  // /api/admin/*
  const rest = path.slice(2);
  const method = request.method;

  if (rest[0] === 'galleries' && rest.length === 1 && method === 'POST') return createGallery(request, env);
  if (rest[0] === 'galleries' && rest.length === 1 && method === 'GET') return listGalleries(env);
  if (rest[0] === 'galleries' && rest[1]) {
    const gallery = await galleryById(env.DB, Number(rest[1]));
    if (!gallery) return json({ error: 'unknown gallery' }, 404);
    if (rest.length === 2 && method === 'GET') return galleryState(env, gallery);
    if (rest.length === 2 && method === 'PATCH') return patchGallery(request, env, gallery);
    if (rest.length === 2 && method === 'DELETE') return deleteGallery(request, env, gallery);
    if (rest[2] === 'upload' && method === 'PUT') return upload(request, env, gallery);
    if (rest[2] === 'photos' && rest[3] && method === 'DELETE') return deletePhoto(env, gallery, rest[3]);
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
  if (body.status === 'live' || body.status === 'draft') {
    await db.prepare('UPDATE galleries SET status = ? WHERE id = ?').bind(body.status, gallery.id).run();
    await logEvent(db, gallery.id, `status-${body.status}`);
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

/** Early delete (admin, typed-confirm client-side): same trash-grace path the
 * cron uses — bytes move to trash/, purge happens after the 7-day grace. */
async function deleteGallery(request: Request, env: Env, gallery: GalleryRow): Promise<Response> {
  const confirm = new URL(request.url).searchParams.get('confirm');
  if (confirm !== gallery.slug) return json({ error: 'confirm with ?confirm=<slug>' }, 400);
  const { trashGallery } = await import('../cron');
  await trashGallery(env, gallery);
  return json({ ok: true });
}

async function deletePhoto(env: Env, gallery: GalleryRow, photoId: string): Promise<Response> {
  const photo = await env.DB.prepare('SELECT * FROM photos WHERE id = ? AND gallery_id = ?')
    .bind(Number(photoId), gallery.id)
    .first<PhotoRow>();
  if (!photo) return json({ error: 'unknown photo' }, 404);
  const assets = await env.DB.prepare('SELECT r2_key FROM assets WHERE photo_id = ?')
    .bind(photo.id)
    .all<{ r2_key: string }>();
  for (const a of assets.results) await env.MEDIA.delete(a.r2_key);
  await env.DB.prepare('DELETE FROM assets WHERE photo_id = ?').bind(photo.id).run();
  await env.DB.prepare('DELETE FROM comments WHERE photo_id = ?').bind(photo.id).run();
  await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photo.id).run();
  await logEvent(env.DB, gallery.id, 'photo-removed', photo.stem);
  return json({ ok: true });
}

/**
 * PUT /api/admin/galleries/:id/upload?stem=001&kind=original&bytes=…&crc32=…
 *   &content_type=…&filename=…[&width=…&height=…&is_hdr=1&thumbhash=…&color=…]
 *   [&new_version=1]
 * Streams the body into R2 and upserts the photo + asset rows. `new_version=1`
 * on an original bumps the photo's version — the polish loop: marks, threads
 * and the "updated" chip all hang off that bump.
 */
async function upload(request: Request, env: Env, gallery: GalleryRow): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const stem = q.get('stem') ?? '';
  const kind = q.get('kind') ?? '';
  const bytes = Number(q.get('bytes'));
  const crc32 = Number(q.get('crc32'));
  const contentType = q.get('content_type') ?? 'application/octet-stream';
  const filename = q.get('filename') ?? `${stem}-${kind}`;
  if (!stem || !KINDS.has(kind) || !Number.isFinite(bytes) || !Number.isFinite(crc32))
    return json({ error: 'stem, kind, bytes, crc32 required' }, 400);
  if (!request.body) return json({ error: 'empty body' }, 400);

  let photo = await env.DB.prepare('SELECT * FROM photos WHERE gallery_id = ? AND stem = ?')
    .bind(gallery.id, stem)
    .first<PhotoRow>();

  if (!photo) {
    const r = await env.DB.prepare(
      `INSERT INTO photos (gallery_id, stem, position, width, height, is_hdr, thumbhash, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        gallery.id, stem, Number(q.get('position') ?? 0),
        Number(q.get('width')) || null, Number(q.get('height')) || null,
        q.get('is_hdr') === '0' ? 0 : 1, q.get('thumbhash') ?? '', q.get('color') ?? '#1a1614'
      )
      .run();
    photo = (await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(r.meta.last_row_id).first<PhotoRow>())!;
    await logEvent(env.DB, gallery.id, 'photo-added', stem);
  } else if (kind === 'original' && q.get('new_version') === '1') {
    await env.DB.prepare('UPDATE photos SET version = version + 1, replaced_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), photo.id)
      .run();
    photo = (await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(photo.id).first<PhotoRow>())!;
    await logEvent(env.DB, gallery.id, 'photo-version', `${stem} → v${photo.version}`);
  }

  // preview-derived metadata refresh (any upload may carry it)
  if (q.get('width') && q.get('height')) {
    await env.DB.prepare('UPDATE photos SET width = ?, height = ?, is_hdr = ?, thumbhash = ?, color = ? WHERE id = ?')
      .bind(
        Number(q.get('width')), Number(q.get('height')),
        q.get('is_hdr') === '0' ? 0 : 1,
        q.get('thumbhash') || photo.thumbhash, q.get('color') || photo.color, photo.id
      )
      .run();
  }

  const r2Key = `galleries/${gallery.id}/${photo.id}/v${photo.version}/${kind}`;
  await env.MEDIA.put(r2Key, request.body, { httpMetadata: { contentType } });
  await env.DB.prepare(
    `INSERT INTO assets (photo_id, kind, version, r2_key, bytes, crc32, content_type, width, height, filename)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (photo_id, kind, version) DO UPDATE SET
       r2_key = excluded.r2_key, bytes = excluded.bytes, crc32 = excluded.crc32,
       content_type = excluded.content_type, width = excluded.width,
       height = excluded.height, filename = excluded.filename`
  )
    .bind(
      photo.id, kind, photo.version, r2Key, bytes, crc32, contentType,
      Number(q.get('asset_width')) || null, Number(q.get('asset_height')) || null, filename
    )
    .run();
  return json({ ok: true, photo_id: photo.id, version: photo.version, r2_key: r2Key });
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
            (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id) AS photo_count,
            (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id AND p.marked = 1) AS marked_count
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
          .map(([k, a]) => [k.split('/')[1], { bytes: a.bytes, filename: a.filename }])
      ),
    })),
    comments: comments.results,
  });
}

/* --------------------------------------------------------------- admin ui */

const ADMIN_HEAD = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=Newsreader:ital,opsz,wght@1,6..72,400..600&display=swap">
<link rel="stylesheet" href="/admin/admin.css">`;

function adminShell(title: string, body: string): Response {
  return new Response(page(title, ADMIN_HEAD, body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' },
  });
}

async function adminHome(env: Env): Promise<Response> {
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
      <button type="submit">Create</button>
    </form>
  </section>
  <section id="galleries" class="panel"><h2>Galleries</h2><div id="list">Loading…</div></section>
</main>
<script src="/admin/admin.js" defer></script>`
  );
}

async function adminGallery(env: Env, id: number): Promise<Response> {
  const gallery = await galleryById(env.DB, id);
  if (!gallery) return json({ error: 'unknown gallery' }, 404);
  return adminShell(
    `${gallery.title} · Selects admin`,
    `<main class="admin" data-view="gallery" data-id="${id}">
  <header class="ahead">
    <p><a href="/admin">← all galleries</a></p>
    <h1>${esc(gallery.title)}</h1>
    <p class="ahead__sub" id="summary"></p>
  </header>
  <section class="panel" id="share"><h2>Share</h2><div id="share-body"></div></section>
  <section class="panel" id="matrix"><h2>Coverage</h2><div id="matrix-body">Loading…</div></section>
  <section class="panel" id="marks"><h2>Marks</h2><div id="marks-body"></div></section>
  <section class="panel" id="threads"><h2>Feedback</h2><div id="threads-body"></div></section>
  <section class="panel" id="lifecycle"><h2>Lifecycle</h2><div id="lifecycle-body"></div></section>
</main>
<script src="/admin/admin.js" defer></script>`
  );
}
