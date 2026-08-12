#!/usr/bin/env node
/**
 * scripts/photo-meta.mjs — image sidecar metadata for the Overview stream.
 * Wired as `predev` + `prebuild` via the `generate` npm script.
 *
 * Walks src/content/shoots/<slug>/ and, for every jpg/jpeg/png, records into
 * src/generated/photo-meta.json:
 *   width / height        intrinsic pixels (EXIF orientation applied)
 *   thumbhash             base64 PNG data-URI, painted as the img's CSS
 *                         background while the real file loads
 *   color                 average colour as #rrggbb (background fallback)
 *   exif                  camera / lens / focalLength / aperture / shutter / iso,
 *                         only the keys actually present in the file
 *
 * Incremental: an entry is reused when the file's mtime + size match the cached
 * `source` stamp, so a warm run costs one stat() per image. Entries for deleted
 * files are pruned. Output keys are sorted at every level, so identical inputs
 * always produce byte-identical JSON (no churn, cheap diffs).
 *
 * Safe when src/content/shoots is missing or empty: it writes an empty map and
 * exits 0 rather than breaking dev/build.
 *
 * Keys are POSIX-style paths relative to src/content/shoots, e.g.
 * "oaxaca-portraits/001.jpg" — src/lib/photos.ts looks entries up by that key.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ExifReader from 'exifreader';
import { rgbaToThumbHash, thumbHashToRGBA } from 'thumbhash';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOOTS_DIR = resolve(ROOT, 'src/content/shoots');
const OUT = resolve(ROOT, 'src/generated/photo-meta.json');

const VERSION = 1;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);
// thumbhash accepts at most 100×100 pixels of input.
const THUMB_MAX = 100;

/* --- helpers ------------------------------------------------------------ */

async function readCache() {
  try {
    const parsed = JSON.parse(await readFile(OUT, 'utf8'));
    // A cache from an older layout is simply dropped and rebuilt.
    if (parsed?.version === VERSION && parsed.photos && typeof parsed.photos === 'object') {
      return parsed.photos;
    }
  } catch {
    /* missing or corrupt cache — rebuild from scratch */
  }
  return {};
}

/** All image files under src/content/shoots/<slug>/, sorted by key. */
async function findImages() {
  let slugs;
  try {
    slugs = await readdir(SHOOTS_DIR, { withFileTypes: true });
  } catch {
    return []; // no shoots directory yet
  }

  const found = [];
  for (const slug of slugs.filter((entry) => entry.isDirectory()).sort(byName)) {
    const dir = join(SHOOTS_DIR, slug.name);
    let files;
    try {
      files = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files.filter((entry) => entry.isFile()).sort(byName)) {
      if (!IMAGE_EXT.has(extname(file.name).toLowerCase())) continue;
      found.push({ key: `${slug.name}/${file.name}`, path: join(dir, file.name) });
    }
  }
  return found;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const hex = (r, g, b) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** Base64 PNG data-URI of the thumbhash for `buffer`. */
async function thumbhashDataUri(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate() // bake in EXIF orientation
    .resize(THUMB_MAX, THUMB_MAX, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hash = rgbaToThumbHash(info.width, info.height, data);
  const { w, h, rgba } = thumbHashToRGBA(hash);
  const png = await sharp(Buffer.from(rgba), { raw: { width: w, height: h, channels: 4 } })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();

  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * The camera fields the caption/credit layer might ever want. Everything is
 * optional — most web-exported JPEGs have been stripped, and the placeholders
 * have no EXIF at all.
 */
function readExif(buffer) {
  let tags;
  try {
    tags = ExifReader.load(buffer);
  } catch {
    return undefined; // no metadata block at all
  }

  const text = (tag) => {
    const value = tag?.description ?? (Array.isArray(tag?.value) ? tag.value[0] : tag?.value);
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed && trimmed !== 'Undefined' ? trimmed : undefined;
  };

  const make = text(tags.Make);
  const model = text(tags.Model);
  // "SONY" + "SONY ILCE-7M4" should not become "SONY SONY ILCE-7M4".
  const camera = model && make && !model.toUpperCase().startsWith(make.toUpperCase())
    ? `${make} ${model}`
    : (model ?? make);

  const shutterRaw = text(tags.ExposureTime);
  const isoRaw = text(tags.ISOSpeedRatings) ?? text(tags.PhotographicSensitivity);
  const iso = isoRaw !== undefined && Number.isFinite(Number(isoRaw)) ? Number(isoRaw) : undefined;

  const exif = {
    camera,
    lens: text(tags.LensModel) ?? text(tags.Lens) ?? text(tags.LensSpecification),
    focalLength: text(tags.FocalLength),
    aperture: text(tags.FNumber) ?? text(tags.ApertureValue),
    shutter: shutterRaw ? (shutterRaw.includes('s') ? shutterRaw : `${shutterRaw} s`) : undefined,
    iso,
  };

  // Drop empty keys so the JSON stays small and diffs stay meaningful.
  const cleaned = Object.fromEntries(Object.entries(exif).filter(([, v]) => v !== undefined));
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

async function describe(path, stamp) {
  const buffer = await readFile(path);
  const metadata = await sharp(buffer).metadata();

  // Orientations 5–8 are rotated a quarter turn; report the displayed dimensions.
  const rotated = (metadata.orientation ?? 1) >= 5;
  const width = (rotated ? metadata.height : metadata.width) ?? 0;
  const height = (rotated ? metadata.width : metadata.height) ?? 0;

  const stats = await sharp(buffer).stats();
  const [r, g, b] = stats.channels;

  const entry = {
    width,
    height,
    color: hex(r?.mean ?? 0, g?.mean ?? 0, b?.mean ?? 0),
    thumbhash: await thumbhashDataUri(buffer),
    source: stamp,
  };

  const exif = readExif(buffer);
  if (exif) entry.exif = exif;
  return entry;
}

/** Stable key order at every level so the file never churns. */
function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableSort(value[key])]),
    );
  }
  return value;
}

/* --- main --------------------------------------------------------------- */

async function main() {
  const cache = await readCache();
  const images = await findImages();

  const photos = {};
  let fresh = 0;
  let reused = 0;
  const failures = [];

  for (const { key, path } of images) {
    let stamp;
    try {
      const info = await stat(path);
      stamp = { mtimeMs: Math.round(info.mtimeMs), size: info.size };
    } catch {
      continue; // vanished between readdir and stat
    }

    const cached = cache[key];
    if (
      cached?.source &&
      cached.source.mtimeMs === stamp.mtimeMs &&
      cached.source.size === stamp.size &&
      typeof cached.thumbhash === 'string' &&
      typeof cached.width === 'number'
    ) {
      photos[key] = cached;
      reused += 1;
      continue;
    }

    try {
      photos[key] = await describe(path, stamp);
      fresh += 1;
    } catch (error) {
      // One unreadable file must not take the build down.
      failures.push(`${key}: ${error?.message ?? error}`);
    }
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(stableSort({ version: VERSION, photos }), null, 2)}\n`, 'utf8');

  const pruned = Object.keys(cache).filter((key) => !(key in photos)).length;
  console.log(
    `[photo-meta] ${images.length} image(s): ${fresh} processed, ${reused} cached` +
      `${pruned ? `, ${pruned} pruned` : ''} -> src/generated/photo-meta.json`,
  );
  for (const failure of failures) console.warn('[photo-meta] skipped —', failure);
}

main().catch((error) => {
  console.error('[photo-meta] failed —', error?.stack ?? error);
  process.exit(1);
});
