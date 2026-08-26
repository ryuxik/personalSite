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
 *   --replace           re-upload stems that already exist as NEW VERSIONS —
 *                       the polish loop: marks + threads survive, the client
 *                       sees an "updated" chip
 *   --sdr               accept previews without a gain map (SDR shoot)
 *   --allow-gps         upload files that carry GPS EXIF (default: refuse —
 *                       stripping would rewrite bytes, and bytes are canonical;
 *                       re-export without location instead)
 *   --live              set the gallery live after a clean ingest
 *
 * Auth: SELECTS_ADMIN_TOKEN env var (the same bearer the admin API takes).
 *
 * WHY LOCAL (SPEC.md § Client galleries): nothing server-side can decode HEIC
 * HDR, and the preview ladder derivation (sharp keepGainMap — the portfolio's
 * exact chain) plus thumbhash + CRC32 all run in seconds on the Mac. The
 * server only ever stores and streams verbatim bytes.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import ExifReader from 'exifreader';
import { rgbaToThumbHash } from 'thumbhash';

const LADDER = [900, 1400, 2048];
const JPEG_QUALITY = 82;   // = scripts/photo-meta.mjs
const AVIF_QUALITY = 55;

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
  else if ((m = lower.match(/^(.+)\.heic$/))) { if (!sets.get(m[1])?.original) put(m[1], 'original', name); }
}
// normalize Grain Studio stems: "colors-grain" family shares stem "colors"
if (sets.size === 0) {
  console.error(`nothing ingestable in ${dir} — expected <stem>-grain.heic / <stem>-web.jpg etc.`);
  process.exit(1);
}
const stems = [...sets.keys()].sort();
console.log(`${stems.length} photo(s) in ${dir}: ${stems.join(', ')}`);

/* ------------------------------------------------------------------ gates -- */
const problems = [];
async function hasGps(path) {
  try {
    const tags = ExifReader.load(await readFile(path));
    return Boolean(tags.GPSLatitude || tags.GPSLongitude);
  } catch {
    return false; // unreadable EXIF ≠ GPS
  }
}
for (const stem of stems) {
  const set = sets.get(stem);
  if (!set.preview) problems.push(`${stem}: no -web.jpg preview master — enable the "Web preview" row in Grain Studio`);
  if (!set.original) problems.push(`${stem}: no original (-grain.heic)`);
  for (const kind of ['original', 'instagram', 'rednote', 'preview']) {
    if (set[kind] && (await hasGps(set[kind])) && !flags.get('allow-gps'))
      problems.push(`${stem}: ${kind} carries GPS EXIF — re-export without location, or pass --allow-gps`);
  }
  if (set.preview) {
    const meta = await sharp(set.preview).metadata();
    set.isHdr = 'gainMap' in meta && Boolean(meta.gainMap);
    set.width = meta.width;
    set.height = meta.height;
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
const uploaded = [];

async function uploadBuffer(stem, kind, buffer, contentType, filename, extra = {}) {
  const params = new URLSearchParams({
    stem, kind,
    bytes: String(buffer.length),
    crc32: String(crc32(buffer) >>> 0),
    content_type: contentType,
    filename,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
  });
  await api(`/api/admin/galleries/${gallery.id}/upload?${params}`, { method: 'PUT', body: buffer });
  uploaded.push(`${stem}/${kind}`);
}

async function thumbhashDataUri(previewBuffer) {
  const { data, info } = await sharp(previewBuffer)
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hash = rgbaToThumbHash(info.width, info.height, data);
  const png = await import('thumbhash').then((m) => m.thumbHashToDataURL(hash));
  return png;
}

async function averageColor(previewBuffer) {
  const { data } = await sharp(previewBuffer).resize(1, 1, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true });
  return `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

let position = 0;
for (const stem of stems) {
  const set = sets.get(stem);
  const existing = serverPhotos.get(stem);
  const originalBuffer = await readFile(set.original);
  const originalCrc = crc32(originalBuffer) >>> 0;

  let newVersion = false;
  if (existing) {
    const serverOriginal = existing.assets?.original;
    const unchanged = serverOriginal && serverOriginal.bytes === originalBuffer.length;
    if (unchanged && !flags.get('replace')) {
      console.log(`  ${stem}: already ingested — skipped (use --replace to push a new version)`);
      position++;
      continue;
    }
    if (!flags.get('replace')) {
      console.log(`  ${stem}: differs from the server copy — skipped (pass --replace to upload as v${existing.version + 1})`);
      position++;
      continue;
    }
    newVersion = true;
  }

  const t0 = Date.now();
  const previewBuffer = await readFile(set.preview);
  const meta = {
    position,
    width: set.width,
    height: set.height,
    is_hdr: set.isHdr ? 1 : 0,
    thumbhash: await thumbhashDataUri(previewBuffer),
    color: await averageColor(previewBuffer),
  };

  // original first — it owns the version bump
  await uploadBuffer(stem, 'original', originalBuffer, CT.heic, `${stem}.heic`,
    { ...meta, ...(newVersion ? { new_version: 1 } : {}) });
  if (set.instagram)
    await uploadBuffer(stem, 'instagram', await readFile(set.instagram), CT.heic, `${stem}-instagram.heic`, meta);
  if (set.rednote)
    await uploadBuffer(stem, 'rednote', await readFile(set.rednote), CT.heic, `${stem}-rednote.heic`, meta);
  await uploadBuffer(stem, 'preview', previewBuffer, CT.jpg, `${stem}-web.jpg`, meta);

  // the ladder — the portfolio's exact chain (photo-meta.mjs): keepGainMap for
  // real gain-map masters, resize + jpeg ONLY; AVIF from a plain read (= the
  // authored SDR base).
  for (const width of LADDER.filter((w) => w <= set.width)) {
    const input = set.isHdr ? sharp(previewBuffer).keepGainMap() : sharp(previewBuffer).rotate();
    const jpg = await input.resize({ width }).jpeg({ quality: JPEG_QUALITY }).toBuffer({ resolveWithObject: true });
    await uploadBuffer(stem, `l${width}`, jpg.data, CT.jpg, `${stem}-${width}.jpg`,
      { ...meta, asset_width: jpg.info.width, asset_height: jpg.info.height });
    const avif = await sharp(previewBuffer).rotate().resize({ width }).avif({ quality: AVIF_QUALITY }).toBuffer({ resolveWithObject: true });
    await uploadBuffer(stem, `a${width}`, avif.data, CT.avif, `${stem}-${width}.avif`,
      { ...meta, asset_width: avif.info.width, asset_height: avif.info.height });
  }
  console.log(`  ${stem}: ${newVersion ? `v${existing.version + 1} ` : ''}uploaded (${((Date.now() - t0) / 1000).toFixed(1)}s, crc ${originalCrc.toString(16)})`);
  position++;
}

/* ---------------------------------------------------------------- summary -- */
const finalState = await api(`/api/admin/galleries/${gallery.id}`);
console.log('\ncoverage:');
console.log('  photo        original  instagram  rednote  preview  ladder');
for (const p of finalState.photos) {
  const has = (k) => (p.assets?.[k] ? '   ✓    ' : '   —    ');
  const rungs = ['l900', 'l1400', 'l2048'].filter((k) => p.assets?.[k]).length;
  console.log(`  ${p.stem.padEnd(12)}${has('original')}${has('instagram')} ${has('rednote')}${has('preview')}  ${rungs}/3`);
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
