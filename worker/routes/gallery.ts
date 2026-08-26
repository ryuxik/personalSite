/**
 * /g/* — the client-facing gallery surface.
 *
 * URL shape: /g/<slug>-<key>          the page (capability URL — link = credential)
 *            …/m/<kv>/<pid>/<kind>    media (key-versioned; rotation kills old paths)
 *            …/dl/<pid>/<kind>        single download (deliverables ONLY)
 *            …/zip/<scope>/<kind>     streamed zip (scope: all | marked)
 *            …/api/mark|finalize|comment|comments
 *
 * Design contract (SPEC.md § Client galleries, plan § 4): photographs lead and
 * chrome recedes; the preview ladder is the portfolio's exact <picture>
 * pattern (media-first HDR JPEG, then AVIF); every deliverable byte is served
 * verbatim from R2 — this file never transcodes anything.
 *
 * Status gating (review finding): `draft` hides EVERYTHING except the soft
 * "not yet ready" shell — media, downloads, zips and the API all tombstone,
 * so "Back to draft" genuinely conceals a gallery from an already-shared
 * link. The admin matrix uses its own authed media route instead.
 *
 * Caching (review finding): Workers responses are NOT edge-cached unless the
 * Cache API is used — which we deliberately don't: media is
 * `Cache-Control: private` (a client's unreleased photographs have no
 * business in a shared cache), so server-side revocation — rotation, draft,
 * expiry, deletion — is INSTANT for every new request, and the only residue
 * is the legitimate viewer's own browser cache (≤1h).
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

const DELIVERABLES = ['original', 'instagram', 'rednote'] as const;
const MEDIA_CACHE = 'private, max-age=3600'; // browser-only; never shared caches
const MAX_API_BODY = 16 * 1024; // a mark/comment payload has no business being bigger
const MAX_COMMENTS_PER_PHOTO = 200; // abuse bound — a real thread is dozens
const MAX_COMMENTS_PER_GALLERY = 2000;

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

  // Draft conceals everything but the shell (review finding).
  if (gallery.status === 'draft') {
    return rest.length === 0 ? draftPage(gallery) : notFoundTombstone();
  }

  if (rest.length === 0) return galleryPage(env, ctx);
  if (rest[0] === 'm' && rest.length === 4) return serveMedia(env, ctx, rest[1], rest[2], rest[3], false);
  if (rest[0] === 'dl' && rest.length === 3) {
    // Deliverables only: the preview JPEG and the ladder are never offered
    // for download (SPEC hard rule — review finding).
    if (!(DELIVERABLES as readonly string[]).includes(rest[2])) return notFoundTombstone();
    return serveMedia(env, ctx, String(gallery.key_version), rest[1], rest[2], true);
  }
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
  const kvNum = Number(kv);
  const pidNum = Number(pid);
  // Integer guards: a NaN would reach D1 as a type error → 500, breaking the
  // uniform-tombstone contract (review finding).
  if (!Number.isInteger(kvNum) || !Number.isInteger(pidNum)) return notFoundTombstone();
  if (kvNum !== gallery.key_version) return notFoundTombstone();
  // One JOIN instead of two round trips; removed photos never serve.
  const asset = await env.DB.prepare(
    `SELECT a.* FROM assets a
       JOIN photos p ON p.id = a.photo_id
      WHERE p.id = ? AND p.gallery_id = ? AND p.removed = 0
        AND a.kind = ? AND a.version = p.version`
  )
    .bind(pidNum, gallery.id, kind)
    .first<AssetRow>();
  if (!asset || !asset.r2_key) return notFoundTombstone();
  const object = await env.MEDIA.get(asset.r2_key);
  if (!object) return notFoundTombstone();
  if (object.size !== asset.bytes)
    console.log(`size drift: ${asset.r2_key} stored ${object.size} vs recorded ${asset.bytes}`);
  const headers: Record<string, string> = {
    'Content-Type': asset.content_type,
    'Content-Length': String(object.size), // R2 truth, not the DB row
    'Cache-Control': MEDIA_CACHE,
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
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
    if (!asset || !asset.r2_key) continue; // matrix gap: that size simply is not in the zip
    entries.push({
      name: `${gallery.slug}/${asset.filename}`,
      bytes: asset.bytes,
      crc32: asset.crc32,
      open: async () => {
        const object = await env.MEDIA.get(asset.r2_key);
        if (!object) throw new Error(`R2 object missing: ${asset.r2_key}`);
        // The zip's headers and offsets are precomputed from DB sizes — a
        // drifted object would silently corrupt every later entry. Refuse
        // loudly instead (review finding).
        if (object.size !== asset.bytes)
          throw new Error(`size drift on ${asset.r2_key}: ${object.size} vs ${asset.bytes}`);
        return object.body;
      },
    });
  }
  if (entries.length === 0) return json({ error: 'nothing to download for that selection' }, 404);
  const guard = zipTooLarge(entries);
  if (guard) return json({ error: guard }, 400);
  await logEvent(env.DB, gallery.id, 'zip', `${scope}/${kind} × ${entries.length}`);
  const total = zipTotalSize(entries);
  // FixedLengthStream is the only way a hand-rolled stream body gets an
  // honored Content-Length (exact download progress on a 700 MB zip).
  const fixed = new FixedLengthStream(total);
  streamZip(entries, new Date())
    .pipeTo(fixed.writable)
    .catch((error) => console.log('zip stream failed:', String(error)));
  return new Response(fixed.readable, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(total),
      'Content-Disposition': `attachment; filename="${gallery.slug}-${kind}-${scope}.zip"`,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
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
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_API_BODY) return json({ error: 'payload too large' }, 413);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: 'bad json' }, 400);
  const viewer = String(body.viewer ?? '').trim().slice(0, 40) || 'Guest';

  if (action === 'mark') {
    if (gallery.marks_state !== 'open')
      return json({ error: 'locked', message: 'Selections are locked — leave a comment and Santiago can reopen them.' }, 409);
    const photo = await photoByStem(env, gallery.id, String(body.stem ?? ''));
    if (!photo) return json({ error: 'unknown photo' }, 404);
    const on = Boolean(body.on);
    if (on) {
      // Atomic cap: check-then-write raced under concurrent viewers (the mark
      // set is shared), so the cap lives inside one conditional UPDATE.
      const r = await env.DB.prepare(
        `UPDATE photos SET marked = 1, marked_by = ?, marked_at = ?
          WHERE id = ? AND removed = 0
            AND (SELECT COUNT(*) FROM photos WHERE gallery_id = ? AND marked = 1 AND id != ?) < ?`
      )
        .bind(viewer, new Date().toISOString(), photo.id, gallery.id, photo.id, gallery.n_marks)
        .run();
      if (r.meta.changes === 0 && photo.marked !== 1)
        return json(
          { error: 'cap', message: `You've marked ${gallery.n_marks} of ${gallery.n_marks} — remove one to swap.` },
          409
        );
    } else {
      await env.DB.prepare("UPDATE photos SET marked = 0, marked_by = '', marked_at = NULL WHERE id = ?")
        .bind(photo.id)
        .run();
    }
    return json(await markState(env, gallery));
  }

  if (action === 'finalize') {
    const note = String(body.note ?? '').slice(0, 2000);
    // Atomic: refuses double-finalize races, and an empty mark set (review finding).
    const r = await env.DB.prepare(
      `UPDATE galleries SET marks_state = 'submitted', marks_note = ?, marks_submitted_at = ?
        WHERE id = ? AND marks_state = 'open'
          AND (SELECT COUNT(*) FROM photos WHERE gallery_id = ? AND marked = 1 AND removed = 0) > 0`
    )
      .bind(note, new Date().toISOString(), gallery.id, gallery.id)
      .run();
    if (r.meta.changes === 0)
      return json({ error: gallery.marks_state === 'open' ? 'empty' : 'locked' }, 409);
    await logEvent(env.DB, gallery.id, 'marks-submitted', `by ${viewer}`);
    const marked = await env.DB.prepare(
      'SELECT stem FROM photos WHERE gallery_id = ? AND marked = 1 AND removed = 0 ORDER BY stem'
    )
      .bind(gallery.id)
      .all<{ stem: string }>();
    const stems = marked.results.map((x) => x.stem).join(', ');
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
    // Abuse bounds: a capability link is unauthenticated — cap thread growth
    // so a spam run cannot flood D1 or the digest email (review finding).
    const counts = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM comments WHERE photo_id = ?) AS on_photo,
              (SELECT COUNT(*) FROM comments c JOIN photos p ON p.id = c.photo_id WHERE p.gallery_id = ?) AS on_gallery`
    )
      .bind(photo.id, gallery.id)
      .first<{ on_photo: number; on_gallery: number }>();
    if ((counts?.on_photo ?? 0) >= MAX_COMMENTS_PER_PHOTO || (counts?.on_gallery ?? 0) >= MAX_COMMENTS_PER_GALLERY)
      return json({ error: 'thread full', message: 'This thread is full — email Santiago directly.' }, 429);
    await env.DB.prepare('INSERT INTO comments (photo_id, author, by_owner, body) VALUES (?, ?, 0, ?)')
      .bind(photo.id, viewer, text)
      .run();
    return json({ ok: true, author: viewer, body: text, created_at: new Date().toISOString() });
  }

  return json({ error: 'unknown action' }, 404);
}

async function photoByStem(env: Env, galleryId: number, stem: string): Promise<PhotoRow | null> {
  return env.DB.prepare('SELECT * FROM photos WHERE gallery_id = ? AND stem = ? AND removed = 0')
    .bind(galleryId, stem)
    .first<PhotoRow>();
}

async function markState(env: Env, gallery: GalleryRow): Promise<Record<string, unknown>> {
  const r = await env.DB.prepare(
    'SELECT stem FROM photos WHERE gallery_id = ? AND marked = 1 AND removed = 0 ORDER BY stem'
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

  /** Ladder rung widths per photo, discovered from what actually exists —
   * widths are dynamic (a narrow master contributes its own width). */
  const rungWidths = (photo: PhotoRow, prefix: 'l' | 'a') =>
    [...assets.keys()]
      .filter((k) => k.startsWith(`${photo.id}/${prefix}`))
      .map((k) => Number(k.split('/')[1].slice(1)))
      .filter((w) => Number.isInteger(w))
      .sort((a, b) => a - b);

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
      const jpgRungs = rungWidths(p, 'l');
      if (jpgRungs.length === 0) return '';
      const avifRungs = rungWidths(p, 'a');
      const jpgSrcset = jpgRungs.map((w) => `${media(p, `l${w}`)} ${w}w`).join(', ');
      const avifSrcset = avifRungs.map((w) => `${media(p, `a${w}`)} ${w}w`).join(', ');
      const fallbackW = jpgRungs.includes(1400) ? 1400 : jpgRungs[jpgRungs.length - 1];
      const scale = p.width && p.height ? p.height / p.width : 1;
      // color/thumbhash are validated at upload AND escaped here — the style
      // attribute was the one unescaped interpolation on the page (review).
      const style = esc(
        [
          `aspect-ratio: ${p.width ?? 3} / ${p.height ?? 2}`,
          `background-color: ${p.color}`,
          p.thumbhash ? `background-image: url("${p.thumbhash}")` : null,
        ]
          .filter(Boolean)
          .join('; ')
      );
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
    <button class="act act--mark" data-act="mark">
      <span class="ring"></span><span class="when-off">Mark for polish</span><span class="when-on">Marked</span>
    </button>
    <button class="act act--comment" data-act="comment">✎ Note<span class="act__count"></span></button>
    <button class="act act--dl" data-act="download">↓ Download</button>
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

  const html = page(gallery.title, `<link rel="stylesheet" href="/gallery/gallery.css">`, body);
  return new Response(html, { headers: GALLERY_HEADERS });
}
