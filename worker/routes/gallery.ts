/**
 * /g/* — the client-facing gallery surface.
 *
 * URL shape: /g/<slug>-<key>          the page (capability URL — link = credential)
 *            …/m/<kv>/<pid>/<kind>    media (key-versioned; rotation kills old paths)
 *            …/dl/<pid>/<kind>        single download (attachment)
 *            …/zip/<scope>/<kind>     streamed zip (scope: all | marked)
 *            …/api/mark|finalize|comment|comments
 *
 * Design contract (SPEC.md § Client galleries, plan § 4): photographs lead and
 * chrome recedes; the preview ladder is the portfolio's exact <picture>
 * pattern (media-first HDR JPEG, then AVIF); every deliverable byte is served
 * verbatim from R2 — this file never transcodes anything.
 */

import {
  ensureSchema,
  galleryBySlug,
  galleryPhotos,
  currentAssets,
  logEvent,
  type GalleryRow,
  type PhotoRow,
  type AssetRow,
} from '../lib/db';
import { parseSlugKey, keyEquals } from '../lib/keys';
import { esc, page, json, notFoundTombstone, GALLERY_HEADERS } from '../lib/html';
import { streamZip, zipTooLarge, zipTotalSize, type ZipEntry } from '../lib/zip';
import { emailPhotographer } from '../lib/email';

const LADDER = [900, 1400, 2048] as const;
const DELIVERABLES = ['original', 'instagram', 'rednote'] as const;
const MEDIA_CACHE = 'public, max-age=3600'; // = the key-rotation SLA

interface GalleryContext {
  gallery: GalleryRow;
  base: string; // "/g/<slug>-<key>"
}

function expired(g: GalleryRow, now: Date): boolean {
  return now.toISOString() > g.expiry_at;
}

/** Resolve + authorize a /g request. Wrong slug, wrong key, deleted and
 * expired all collapse into the same tombstone — reveal nothing. */
async function resolve(env: Env, segment: string): Promise<GalleryContext | Response> {
  const parsed = parseSlugKey(segment);
  if (!parsed) return notFoundTombstone();
  await ensureSchema(env.DB);
  const gallery = await galleryBySlug(env.DB, parsed.slug);
  if (!gallery || !keyEquals(gallery.access_key, parsed.key)) return notFoundTombstone();
  if (gallery.status === 'deleted' || expired(gallery, new Date())) return notFoundTombstone();
  return { gallery, base: `/g/${gallery.slug}-${gallery.access_key}` };
}

export async function handleGallery(request: Request, env: Env, path: string[]): Promise<Response> {
  // path: ['g', '<slug>-<key>', ...rest]
  const ctx = await resolve(env, path[1] ?? '');
  if (ctx instanceof Response) return ctx;
  const { gallery } = ctx;
  const rest = path.slice(2);

  if (rest.length === 0) {
    if (gallery.status === 'draft') return draftPage(gallery);
    return galleryPage(env, ctx);
  }
  if (rest[0] === 'm' && rest.length === 4) return serveMedia(env, ctx, rest[1], rest[2], rest[3], false);
  if (rest[0] === 'dl' && rest.length === 3)
    return serveMedia(env, ctx, String(gallery.key_version), rest[1], rest[2], true);
  if (rest[0] === 'zip' && rest.length === 3) return serveZip(env, ctx, rest[1], rest[2]);
  if (rest[0] === 'api') return handleApi(request, env, ctx, rest.slice(1));
  return notFoundTombstone();
}

/* ------------------------------------------------------------------ media */

async function serveMedia(
  env: Env,
  ctx: GalleryContext,
  kv: string,
  pid: string,
  kind: string,
  download: boolean
): Promise<Response> {
  const { gallery } = ctx;
  if (Number(kv) !== gallery.key_version) return notFoundTombstone();
  const photo = await env.DB.prepare('SELECT * FROM photos WHERE id = ? AND gallery_id = ?')
    .bind(Number(pid), gallery.id)
    .first<PhotoRow>();
  if (!photo) return notFoundTombstone();
  const asset = await env.DB.prepare('SELECT * FROM assets WHERE photo_id = ? AND kind = ? AND version = ?')
    .bind(photo.id, kind, photo.version)
    .first<AssetRow>();
  if (!asset) return notFoundTombstone();
  const object = await env.MEDIA.get(asset.r2_key);
  if (!object) return notFoundTombstone();
  const headers: Record<string, string> = {
    'Content-Type': asset.content_type,
    'Content-Length': String(asset.bytes),
    'Cache-Control': MEDIA_CACHE,
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${asset.filename}"`;
  // Bytes pass through VERBATIM — no transformation between R2 and the wire.
  return new Response(object.body, { headers });
}

/* -------------------------------------------------------------------- zip */

async function serveZip(env: Env, ctx: GalleryContext, scope: string, kind: string): Promise<Response> {
  const { gallery } = ctx;
  if (!['all', 'marked'].includes(scope) || !(DELIVERABLES as readonly string[]).includes(kind))
    return notFoundTombstone();
  const photos = (await galleryPhotos(env.DB, gallery.id)).filter(
    (p) => scope === 'all' || p.marked === 1
  );
  const assets = await currentAssets(env.DB, gallery.id);
  const entries: ZipEntry[] = [];
  for (const photo of photos) {
    const asset = assets.get(`${photo.id}/${kind}`);
    if (!asset) continue; // matrix gap: that size simply is not in the zip
    entries.push({
      name: `${gallery.slug}/${asset.filename}`,
      bytes: asset.bytes,
      crc32: asset.crc32,
      open: async () => {
        const object = await env.MEDIA.get(asset.r2_key);
        if (!object) throw new Error(`R2 object missing: ${asset.r2_key}`);
        return object.body;
      },
    });
  }
  if (entries.length === 0) return json({ error: 'nothing to download for that selection' }, 404);
  const guard = zipTooLarge(entries);
  if (guard) return json({ error: guard }, 400);
  await logEvent(env.DB, gallery.id, 'zip', `${scope}/${kind} × ${entries.length}`);
  return new Response(streamZip(entries, new Date()), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(zipTotalSize(entries)),
      'Content-Disposition': `attachment; filename="${gallery.slug}-${kind}-${scope}.zip"`,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

/* -------------------------------------------------------------- client api */

async function handleApi(request: Request, env: Env, ctx: GalleryContext, rest: string[]): Promise<Response> {
  const { gallery } = ctx;
  const action = rest[0];

  if (action === 'comments' && request.method === 'GET') {
    const stem = new URL(request.url).searchParams.get('photo') ?? '';
    const photo = await photoByStem(env, gallery.id, stem);
    if (!photo) return json({ error: 'unknown photo' }, 404);
    const r = await env.DB.prepare(
      'SELECT author, by_owner, body, created_at FROM comments WHERE photo_id = ? ORDER BY created_at'
    )
      .bind(photo.id)
      .all();
    return json({ comments: r.results });
  }

  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: 'bad json' }, 400);
  const viewer = String(body.viewer ?? '').trim().slice(0, 40) || 'Guest';

  if (action === 'mark') {
    if (gallery.marks_state !== 'open')
      return json({ error: 'locked', message: 'Selections are locked — leave a comment and Santiago can reopen them.' }, 409);
    const photo = await photoByStem(env, gallery.id, String(body.stem ?? ''));
    if (!photo) return json({ error: 'unknown photo' }, 404);
    const on = Boolean(body.on);
    if (on && photo.marked !== 1) {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE gallery_id = ? AND marked = 1')
        .bind(gallery.id)
        .first<{ n: number }>();
      if ((row?.n ?? 0) >= gallery.n_marks)
        return json(
          { error: 'cap', message: `You've marked ${gallery.n_marks} of ${gallery.n_marks} — remove one to swap.` },
          409
        );
    }
    await env.DB.prepare('UPDATE photos SET marked = ?, marked_by = ?, marked_at = ? WHERE id = ?')
      .bind(on ? 1 : 0, on ? viewer : '', on ? new Date().toISOString() : null, photo.id)
      .run();
    return json(await markState(env, gallery));
  }

  if (action === 'finalize') {
    if (gallery.marks_state !== 'open') return json({ error: 'locked' }, 409);
    const note = String(body.note ?? '').slice(0, 2000);
    await env.DB.prepare(
      "UPDATE galleries SET marks_state = 'submitted', marks_note = ?, marks_submitted_at = ? WHERE id = ?"
    )
      .bind(note, new Date().toISOString(), gallery.id)
      .run();
    await logEvent(env.DB, gallery.id, 'marks-submitted', `by ${viewer}`);
    const marked = await env.DB.prepare(
      'SELECT stem FROM photos WHERE gallery_id = ? AND marked = 1 ORDER BY position, stem'
    )
      .bind(gallery.id)
      .all<{ stem: string }>();
    const stems = marked.results.map((r) => r.stem).join(', ');
    await emailPhotographer(
      env,
      `Selects — ${gallery.title}: marks are in`,
      `<p><strong>${esc(viewer)}</strong> sent ${marked.results.length} mark(s) for polish on
       <strong>${esc(gallery.title)}</strong>: ${esc(stems)}.</p>
       ${note ? `<p>Note: ${esc(note)}</p>` : ''}
       <p><a href="${env.PUBLIC_ORIGIN ?? ''}/admin/g/${gallery.id}">Open in admin</a></p>`
    );
    return json({ ok: true, marks_state: 'submitted' });
  }

  if (action === 'comment') {
    const photo = await photoByStem(env, gallery.id, String(body.stem ?? ''));
    if (!photo) return json({ error: 'unknown photo' }, 404);
    const text = String(body.body ?? '').trim().slice(0, 4000);
    if (!text) return json({ error: 'empty' }, 400);
    await env.DB.prepare('INSERT INTO comments (photo_id, author, by_owner, body) VALUES (?, ?, 0, ?)')
      .bind(photo.id, viewer, text)
      .run();
    return json({ ok: true, author: viewer, body: text, created_at: new Date().toISOString() });
  }

  return json({ error: 'unknown action' }, 404);
}

async function photoByStem(env: Env, galleryId: number, stem: string): Promise<PhotoRow | null> {
  return env.DB.prepare('SELECT * FROM photos WHERE gallery_id = ? AND stem = ?')
    .bind(galleryId, stem)
    .first<PhotoRow>();
}

async function markState(env: Env, gallery: GalleryRow): Promise<Record<string, unknown>> {
  const r = await env.DB.prepare(
    'SELECT stem FROM photos WHERE gallery_id = ? AND marked = 1 ORDER BY position, stem'
  )
    .bind(gallery.id)
    .all<{ stem: string }>();
  return { marked: r.results.map((x) => x.stem), cap: gallery.n_marks, marks_state: gallery.marks_state };
}

/* ------------------------------------------------------------------- pages */

function draftPage(gallery: GalleryRow): Response {
  const body = page(
    gallery.title,
    '<link rel="stylesheet" href="/gallery/gallery.css">',
    `<main class="tombstone">
  <p class="tombstone__mark">Ryuxik Photography</p>
  <h1>${esc(gallery.title)}</h1>
  <p>This gallery isn't quite ready — Santiago is still preparing your
  photographs. Keep this link; it will open the moment the gallery goes live.</p>
</main>`
  );
  return new Response(body, { headers: GALLERY_HEADERS });
}

function monthDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

async function galleryPage(env: Env, ctx: GalleryContext): Promise<Response> {
  const { gallery, base } = ctx;
  const photos = await galleryPhotos(env.DB, gallery.id);
  const assets = await currentAssets(env.DB, gallery.id);
  const counts = await env.DB.prepare(
    `SELECT p.stem AS stem, COUNT(c.id) AS n FROM comments c JOIN photos p ON p.id = c.photo_id
      WHERE p.gallery_id = ? GROUP BY p.stem`
  )
    .bind(gallery.id)
    .all<{ stem: string; n: number }>();
  const commentCount = new Map(counts.results.map((r) => [r.stem, r.n]));

  const media = (photo: PhotoRow, kind: string) => `${base}/m/${gallery.key_version}/${photo.id}/${kind}`;
  const SIZES = '(min-width: 1100px) 1036px, (min-width: 640px) calc(100vw - 4rem), 100vw';

  const state = {
    title: gallery.title,
    client: gallery.client_name,
    cap: gallery.n_marks,
    marksState: gallery.marks_state,
    expiry: gallery.expiry_at,
    base,
    photos: photos.map((p) => ({
      stem: p.stem,
      w: p.width,
      h: p.height,
      hdr: p.is_hdr === 1,
      version: p.version,
      replacedAt: p.replaced_at,
      marked: p.marked === 1,
      comments: commentCount.get(p.stem) ?? 0,
      // download menu lists only what exists — a matrix gap simply is not offered
      downloads: DELIVERABLES.flatMap((kind) => {
        const a = assets.get(`${p.id}/${kind}`);
        return a ? [{ kind, bytes: a.bytes, href: `${base}/dl/${p.id}/${kind}` }] : [];
      }),
    })),
  };

  const figures = photos
    .map((p, i) => {
      const rungs = LADDER.filter((w) => assets.has(`${p.id}/l${w}`));
      if (rungs.length === 0) return '';
      const jpgSrcset = rungs.map((w) => `${media(p, `l${w}`)} ${w}w`).join(', ');
      const avifRungs = LADDER.filter((w) => assets.has(`${p.id}/a${w}`));
      const avifSrcset = avifRungs.map((w) => `${media(p, `a${w}`)} ${w}w`).join(', ');
      const fallbackW = rungs.includes(1400) ? 1400 : rungs[rungs.length - 1];
      const scale = p.width && p.height ? p.height / p.width : 1;
      const style = [
        `aspect-ratio: ${p.width ?? 3} / ${p.height ?? 2}`,
        `background-color: ${p.color}`,
        p.thumbhash ? `background-image: url("${p.thumbhash}")` : null,
      ]
        .filter(Boolean)
        .join('; ');
      const updated = p.version > 1 ? `<span class="frame__updated">updated</span>` : '';
      return `<figure class="frame" data-stem="${esc(p.stem)}" style="${style}">
  <picture class="frame__picture">
    <source media="(dynamic-range: high)" type="image/jpeg" srcset="${jpgSrcset}" sizes="${SIZES}">
    ${avifSrcset ? `<source type="image/avif" srcset="${avifSrcset}" sizes="${SIZES}">` : ''}
    <img src="${media(p, `l${fallbackW}`)}" width="${fallbackW}" height="${Math.round(fallbackW * scale)}"
         alt="${esc(gallery.title)} — frame ${esc(p.stem)}"
         loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async">
  </picture>
  ${updated}
  <div class="frame__actions">
    <button class="act act--mark" data-act="mark" aria-label="Mark for polish"><span class="ring"></span></button>
    <button class="act act--comment" data-act="comment" aria-label="Comment">✎<span class="act__count"></span></button>
    <button class="act act--dl" data-act="download" aria-label="Download">↓</button>
  </div>
</figure>`;
    })
    .join('\n');

  const contract = [
    `${photos.length} photograph${photos.length === 1 ? '' : 's'}`,
    `mark ${gallery.n_marks} for polish`,
    `available until ${monthDay(gallery.expiry_at)}`,
  ].join(' · ');

  const body = `
<header class="ghead">
  <p class="ghead__mark">Ryuxik Photography</p>
  <h1 class="ghead__title">${esc(gallery.title)}</h1>
  <p class="ghead__contract">${esc(contract)}</p>
</header>
<div class="banner" id="banner" hidden></div>
<main class="stream" id="stream">
${figures}
</main>
<footer class="gfoot">
  <p>Photographs by Santiago · <a href="mailto:ryuxik@gmail.com">ryuxik@gmail.com</a></p>
</footer>

<div class="tray" id="tray" hidden>
  <span class="tray__count" id="tray-count"></span>
  <span class="tray__spacer"></span>
  <button class="tray__dl" id="tray-dl">Download</button>
  <button class="tray__finalize" id="tray-finalize">Finalize →</button>
</div>

<div class="sheet" id="sheet" hidden>
  <div class="sheet__panel" role="dialog" aria-modal="true">
    <div class="sheet__body" id="sheet-body"></div>
  </div>
</div>

<div class="lightbox" id="lightbox" hidden></div>

<script id="gallery-state" type="application/json">${JSON.stringify(state).replaceAll('<', '\\u003c')}</script>
<script src="/gallery/gallery.js" defer></script>`;

  const html = page(
    gallery.title,
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=Newsreader:ital,opsz,wght@1,6..72,400..600&display=swap">
<link rel="stylesheet" href="/gallery/gallery.css">`,
    body
  );
  return new Response(html, { headers: GALLERY_HEADERS });
}
