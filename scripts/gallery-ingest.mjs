#!/usr/bin/env node
/**
 * scripts/gallery-ingest.mjs — local ingest for Selects client galleries.
 *
 *   node scripts/gallery-ingest.mjs <folder> --gallery <slug> [options]
 *
 *   <folder>            a Grain Studio output folder (or any folder using its
 *                       naming): <stem>-grain.heic     original master
 *                                <stem>-instagram.heic Instagram 3:4
 *                                <stem>-rednote.heic   RedNote 3:4
 *                                <stem>-web.jpg        preview master (REQUIRED)
 *                       Bare <stem>.heic is accepted as the original too.
 *   --gallery <slug>    target gallery (created on first use)
 *   --title "…"         title when creating (default: slug, title-cased)
 *   --client "…"        client display name when creating
 *   --n <3>             mark allowance when creating
 *   --expiry-days <60>  expiry when creating
 *   --api <url>         Worker origin (default http://127.0.0.1:8787)
 *   --replace           re-upload stems whose ORIGINAL changed, as NEW
 *                       VERSIONS — the polish loop: marks + threads survive,
 *                       the client sees an "updated" chip
 *   --sdr               accept previews without a gain map (SDR shoot)
 *   --allow-gps         upload files that carry (or have unreadable) GPS
 *                       metadata — the gate FAILS CLOSED by default: refusing
 *                       is recoverable, leaking a client's location is not
 *   --live              set the gallery live after a clean ingest
 *
 * Auth: SELECTS_ADMIN_TOKEN env var (the same bearer the admin API takes).
 *
 * Re-running is safe and healing: a stem whose content already matches the
 * server (bytes AND crc32) is skipped; if some assets are missing at the
 * current version (a previous run died mid-upload), only the gaps are
 * uploaded — no version bump, no spurious "updated" chip. --replace bumps a
 * version ONLY when the original's content actually changed.
 *
 * WHY LOCAL (SPEC.md § Client galleries): nothing server-side can decode HEIC
 * HDR, and the preview ladder derivation (sharp keepGainMap — the portfolio's
 * exact chain) plus thumbhash + CRC32 all run in seconds on the Mac. The
 * server only ever stores and streams verified verbatim bytes.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import ExifReader from 'exifreader';
import { rgbaToThumbHash, thumbHashToRGBA } from 'thumbhash';

const LADDER = [900, 1400, 2048];
const JPEG_QUALITY = 82;   // = scripts/photo-meta.mjs
const AVIF_QUALITY = 55;

/** photo-meta.mjs's ladder rule: never upscale, and a master narrower than
 * the top rung contributes its own width as the top rung (with the same 1.05
 * guard against a near-duplicate). Guarantees at least one rung, so a photo
 * can never be counted-but-invisible (review finding). */
function ladderWidths(sourceWidth) {
  const widths = LADDER.filter((w) => w <= sourceWidth);
  const top = widths[widths.length - 1];
  if (sourceWidth < LADDER[LADDER.length - 1] && (!top || sourceWidth > top * 1.05))
    widths.push(sourceWidth);
  return widths;
}

/* ----------------------------------------------------------------- args -- */
const args = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { flags.set(key, next); i++; }
    else flags.set(key, true);
  } else positional.push(args[i]);
}
const folder = positional[0];
const slug = flags.get('gallery');
if (!folder || !slug) {
  console.error('usage: node scripts/gallery-ingest.mjs <folder> --gallery <slug> [--title …] [--replace] [--live]');
  process.exit(2);
}
const API = (flags.get('api') ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.SELECTS_ADMIN_TOKEN;
if (!TOKEN) {
  console.error('SELECTS_ADMIN_TOKEN is not set — the same token the admin API takes.');
  process.exit(2);
}
const AUTH = { Authorization: `Bearer ${TOKEN}` };
// Optional: Cloudflare Access service token (Zero Trust → Service Auth) when
// /api/admin sits behind an Access app — set both or neither.
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  AUTH['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  AUTH['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}

/* ------------------------------------------------------------- gathering -- */
const dir = resolve(folder);
const names = (await readdir(dir)).filter((n) => !n.startsWith('.'));

/** stem → { original, instagram, rednote, preview } absolute paths */
const sets = new Map();
const put = (stem, kind, name) => {
  if (!sets.has(stem)) sets.set(stem, {});
  sets.get(stem)[kind] = join(dir, name);
};
for (const name of names) {
  const lower = name.toLowerCase();
  let m;
  if ((m = lower.match(/^(.+)-grain\.heic$/))) put(m[1], 'original', name);
  else if ((m = lower.match(/^(.+)-instagram\.heic$/))) put(m[1], 'instagram', name);
  else if ((m = lower.match(/^(.+)-rednote\.heic$/))) put(m[1], 'rednote', name);
  else if ((m = lower.match(/^(.+)-web\.jpe?g$/))) put(m[1], 'preview', name);
  else if ((m = lower.match(/^(.+)-w(\d+)\.jpe?g$/))) {
    if (!sets.has(m[1])) sets.set(m[1], {});
    (sets.get(m[1]).rungJpg ??= {})[Number(m[2])] = join(dir, name);
  } else if ((m = lower.match(/^(.+)-w(\d+)\.avif$/))) {
    if (!sets.has(m[1])) sets.set(m[1], {});
    (sets.get(m[1]).rungAvif ??= {})[Number(m[2])] = join(dir, name);
  }
  else if ((m = lower.match(/^(.+)\.heic$/))) { if (!sets.get(m[1])?.original) put(m[1], 'original', name); }
}
if (sets.size === 0) {
  console.error(`nothing ingestable in ${dir} — expected <stem>-grain.heic / <stem>-web.jpg etc.`);
  process.exit(1);
}
const stems = [...sets.keys()].sort();
console.log(`${stems.length} photo(s) in ${dir}: ${stems.join(', ')}`);

/* ------------------------------------------------------------------ gates -- */
const problems = [];

/** FAIL-CLOSED GPS check (review finding): 'gps' when location tags are
 * present, 'unreadable' when the metadata cannot be parsed at all — both
 * refuse by default, because an unread location tag is still a location. */
function gpsStatus(buffer) {
  try {
    const tags = ExifReader.load(buffer);
    const hit = Object.keys(tags).some(
      (k) => /^GPS(Latitude|Longitude|Position|DestLatitude|DestLongitude|Altitude)$/i.test(k)
    );
    return hit ? 'gps' : 'clean';
  } catch {
    return 'unreadable';
  }
}

for (const stem of stems) {
  const set = sets.get(stem);
  if (!set.preview) problems.push(`${stem}: no -web.jpg preview master — enable the "Web preview" row in Grain Studio`);
  if (!set.original) problems.push(`${stem}: no original (-grain.heic)`);
  for (const kind of ['original', 'instagram', 'rednote', 'preview']) {
    if (!set[kind]) continue;
    const status = gpsStatus(await readFile(set[kind]));
    if (status !== 'clean' && !flags.get('allow-gps')) {
      problems.push(
        status === 'gps'
          ? `${stem}: ${kind} carries GPS metadata — re-export without location, or pass --allow-gps`
          : `${stem}: ${kind} metadata is unreadable, so GPS cannot be ruled out (the gate fails closed) — pass --allow-gps to override`
      );
    }
  }
  if (set.preview) {
    set.previewBuffer = await readFile(set.preview);
    const meta = await sharp(set.previewBuffer).metadata();
    set.isHdr = 'gainMap' in meta && Boolean(meta.gainMap);
    const orientation = meta.orientation ?? 1;
    // photo-meta's non-negotiable: keepGainMap cannot rotate, so an HDR
    // preview must arrive upright (else JPEG rungs ship sideways while their
    // AVIF twins rotate — review finding).
    if (set.isHdr && orientation !== 1)
      problems.push(`${stem}: HDR preview has EXIF orientation ${orientation} — keepGainMap cannot rotate; re-export with rotation baked in`);
    const swapped = orientation >= 5; // 90°-family: displayed dims are transposed
    set.width = swapped ? meta.height : meta.width;
    set.height = swapped ? meta.width : meta.height;
    if (!set.isHdr && !flags.get('sdr'))
      problems.push(`${stem}: preview has NO gain map — Chrome would show SDR. Pass --sdr only if this shoot is genuinely SDR.`);
  }
}
if (problems.length > 0) {
  console.error('\nREFUSING to ingest:\n  ' + problems.join('\n  '));
  process.exit(1);
}

/* ---------------------------------------------------------------- gallery -- */
async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, { ...options, headers: { ...AUTH, ...(options.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${body.error ?? ''}`);
  return body;
}

const titleCase = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const created = await api('/api/admin/galleries', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: flags.get('title') ?? titleCase(slug),
    slug,
    client: flags.get('client') ?? '',
    n: Number(flags.get('n') ?? 3),
    expiry_days: Number(flags.get('expiry-days') ?? 60),
  }),
});
const gallery = created.gallery;
console.log(created.existed ? `gallery "${gallery.slug}" (#${gallery.id}) exists` : `created gallery "${gallery.slug}" (#${gallery.id})`);

const serverState = await api(`/api/admin/galleries/${gallery.id}`);
const serverPhotos = new Map(serverState.photos.map((p) => [p.stem, p]));

/* ----------------------------------------------------------------- upload -- */
const CT = { heic: 'image/heic', jpg: 'image/jpeg', avif: 'image/avif' };
const crcOf = (buffer) => crc32(buffer) >>> 0;
/** Content-true match against the server's asset record (review finding: a
 * byte-length-only check let a same-size re-edit read as "unchanged"). */
const matches = (asset, buffer) =>
  Boolean(asset) && asset.bytes === buffer.length && (asset.crc32 >>> 0) === crcOf(buffer);

async function uploadBuffer(stem, kind, buffer, contentType, filename, extra = {}) {
  const params = new URLSearchParams({
    stem, kind,
    bytes: String(buffer.length),
    crc32: String(crcOf(buffer)),
    content_type: contentType,
    filename,
    ...(flags.get('sdr') ? { sdr: '1' } : {}),
    ...(flags.get('allow-gps') ? { allow_gps: '1' } : {}),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
  });
  await api(`/api/admin/galleries/${gallery.id}/upload?${params}`, { method: 'PUT', body: buffer });
}

/** Base64 palette-PNG data URI — photo-meta.mjs's encoding (~0.5KB), not the
 * thumbhash reference's uncompressed PNG (~5.6KB × 90 photos of page weight). */
async function thumbhashDataUri(previewBuffer) {
  const { data, info } = await sharp(previewBuffer)
    .rotate()
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hash = rgbaToThumbHash(info.width, info.height, data);
  const decoded = thumbHashToRGBA(hash);
  const png = await sharp(Buffer.from(decoded.rgba), {
    raw: { width: decoded.w, height: decoded.h, channels: 4 },
  })
    .png({ palette: true })
    .toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

async function averageColor(previewBuffer) {
  const { data } = await sharp(previewBuffer).resize(1, 1, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true });
  return `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Derive one ladder rung pair from the preview. The HDR chain is the
 * portfolio's exact non-negotiable: keepGainMap + resize + jpeg, NOTHING
 * else; AVIF from a plain rotated read (= the authored SDR base). */
async function deriveRungs(set, width) {
  // SDR sources can carry non-sRGB primaries (a Rec.2020 SDR TIFF taught us
  // this the hard way) — the profile must survive every rung. The HDR chain
  // stays EXACTLY keepGainMap+resize+jpeg per SPEC; its output already
  // carries an ICC from libultrahdr.
  const input = set.isHdr
    ? sharp(set.previewBuffer).keepGainMap()
    : sharp(set.previewBuffer).rotate().keepIccProfile();
  const jpg = await input.resize({ width }).jpeg({ quality: JPEG_QUALITY }).toBuffer({ resolveWithObject: true });
  const avif = await sharp(set.previewBuffer).rotate().keepIccProfile().resize({ width }).avif({ quality: AVIF_QUALITY }).toBuffer({ resolveWithObject: true });
  return { jpg, avif };
}

let uploadedPhotos = 0;
for (const stem of stems) {
  const set = sets.get(stem);
  const server = serverPhotos.get(stem);
  const originalBuffer = await readFile(set.original);
  const t0 = Date.now();

  const meta = {
    width: set.width,
    height: set.height,
    is_hdr: set.isHdr ? 1 : 0,
    thumbhash: await thumbhashDataUri(set.previewBuffer),
    color: await averageColor(set.previewBuffer),
  };
  // Grain Studio's web set ships the rungs pre-authored (encoded from the
  // master pixels — better than any resize here); derive only for folders
  // from older exports.
  const authoredWidths = set.rungJpg ? Object.keys(set.rungJpg).map(Number).sort((a, b) => a - b) : null;
  const widths = authoredWidths ?? ladderWidths(set.width);

  let newVersion = false;
  let heal = false;
  if (server) {
    if (matches(server.assets?.original, originalBuffer)) {
      heal = true; // same content — only fill gaps, never bump
    } else if (!flags.get('replace')) {
      console.log(`  ${stem}: original differs from the server copy — skipped (pass --replace to publish it as v${server.version + 1})`);
      continue;
    } else {
      newVersion = true;
    }
  }

  const work = []; // [kind, buffer, contentType, filename, extra]
  const need = (kind, buffer) => !heal || !matches(server?.assets?.[kind], buffer);

  if (!heal || newVersion || !server?.assets?.original)
    work.push(['original', originalBuffer, CT.heic, `${stem}.heic`, newVersion ? { new_version: 1 } : {}]);
  if (set.instagram) {
    const b = await readFile(set.instagram);
    if (need('instagram', b)) work.push(['instagram', b, CT.heic, `${stem}-instagram.heic`, {}]);
  }
  if (set.rednote) {
    const b = await readFile(set.rednote);
    if (need('rednote', b)) work.push(['rednote', b, CT.heic, `${stem}-rednote.heic`, {}]);
  }
  const previewChanged = !heal || !matches(server?.assets?.preview, set.previewBuffer);
  if (previewChanged) work.push(['preview', set.previewBuffer, CT.jpg, `${stem}-web.jpg`, {}]);
  for (const width of widths) {
    if (authoredWidths) {
      const jb = await readFile(set.rungJpg[width]);
      if (need(`l${width}`, jb)) work.push([`l${width}`, jb, CT.jpg, `${stem}-${width}.jpg`, {}]);
      if (set.rungAvif?.[width]) {
        const ab = await readFile(set.rungAvif[width]);
        if (need(`a${width}`, ab)) work.push([`a${width}`, ab, CT.avif, `${stem}-${width}.avif`, {}]);
      }
    } else if (previewChanged || !server?.assets?.[`l${width}`] || !server?.assets?.[`a${width}`]) {
      const { jpg, avif } = await deriveRungs(set, width);
      work.push([`l${width}`, jpg.data, CT.jpg, `${stem}-${width}.jpg`, { asset_width: jpg.info.width, asset_height: jpg.info.height }]);
      work.push([`a${width}`, avif.data, CT.avif, `${stem}-${width}.avif`, { asset_width: avif.info.width, asset_height: avif.info.height }]);
    }
  }

  if (heal && work.length === 0) {
    console.log(`  ${stem}: up to date`);
    continue;
  }
  for (const [kind, buffer, ct, filename, extra] of work) {
    await uploadBuffer(stem, kind, buffer, ct, filename, { ...meta, ...extra });
  }
  uploadedPhotos++;
  const label = newVersion ? `v${server.version + 1} ` : heal ? `healed ${work.length} asset(s) ` : '';
  console.log(`  ${stem}: ${label}uploaded (${((Date.now() - t0) / 1000).toFixed(1)}s, crc ${crcOf(originalBuffer).toString(16)})`);
}

/* ---------------------------------------------------------------- summary -- */
const finalState = await api(`/api/admin/galleries/${gallery.id}`);
console.log('\ncoverage:');
console.log('  photo        original  instagram  rednote  preview  ladder');
for (const p of finalState.photos) {
  const has = (k) => (p.assets?.[k] ? '   ✓    ' : '   —    ');
  const rungs = Object.keys(p.assets ?? {}).filter((k) => /^l\d+$/.test(k)).length;
  console.log(`  ${p.stem.padEnd(12)}${has('original')}${has('instagram')} ${has('rednote')}${has('preview')}  ${rungs} rung(s)`);
}

if (flags.get('live') && gallery.status !== 'live') {
  await api(`/api/admin/galleries/${gallery.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'live' }),
  });
  console.log('\ngallery is LIVE');
}
console.log(`\nshare link: ${API}/g/${gallery.slug}-${gallery.access_key}`);
console.log(`admin:      ${API}/admin/g/${gallery.id}`);
