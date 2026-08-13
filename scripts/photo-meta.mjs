#!/usr/bin/env node
/**
 * scripts/photo-meta.mjs — sidecar metadata AND the delivery ladders for the
 * Overview stream. Wired as `predev` + `prebuild` via the `generate` npm script.
 *
 * WHY THIS SCRIPT OWNS THE LADDER (and astro:assets does not)
 * ----------------------------------------------------------
 * The masters are HDR gain-map JPEGs (ISO 21496-1): an SDR base image plus an
 * attached gain map that HDR-capable browsers apply to reconstruct the HDR
 * rendition. astro:assets / getImage() strip that gain map — every derivative
 * comes out flat SDR. So the stream bypasses astro:assets entirely: this script
 * pre-generates a static ladder into public/photos/ and StreamFigure.astro
 * hand-rolls the <picture> markup against it.
 *
 * WHAT IT WRITES
 * --------------
 * public/photos/<slug>/<stem>-<w>.jpg    HDR gain-map JPEG (or plain JPEG for an
 *                                        SDR master), quality 82
 * public/photos/<slug>/<stem>-<w>.avif   SDR AVIF, quality 55
 *
 * and, into src/generated/photo-meta.json, per image:
 *   width / height        intrinsic pixels of the master
 *   isHDR                 master carries a gain map
 *   ladder                [{ w, h, jpg, avif }, …] ascending, public URL paths
 *   thumbhash             base64 PNG data-URI, painted as the img's CSS
 *                         background while the real file loads
 *   color                 average colour as #rrggbb (background fallback)
 *   exif                  camera / lens / focalLength / aperture / shutter / iso,
 *                         only the keys actually present in the file
 *
 * THE TWO ENCODES ARE NOT THE SAME PIPELINE
 * -----------------------------------------
 * JPEG, HDR master:  sharp(src).keepGainMap().resize({width}).jpeg({quality:82})
 *   keepGainMap() resizes base + gain map in lockstep and preserves the SDR base
 *   the photographer authored. The chain must stay exactly resize + jpeg —
 *   keepGainMap is experimental and other operations are unsupported with it.
 *   NEVER withGainMap(): that regenerates the SDR base by tone mapping and comes
 *   out ~42% darker than what was authored.
 * AVIF: plain sharp(src) — reading without keepGainMap yields the authored SDR
 *   base, which is exactly the right source for the SDR AVIF rung.
 *
 * INCREMENTAL
 * -----------
 * An entry is reused when the file's mtime + size match the cached `source`
 * stamp AND every ladder file it names still exists. A matching stamp with a
 * missing ladder file re-encodes only the ladder, not the thumbhash. Entries and
 * ladder files for deleted sources are pruned. Output keys are sorted at every
 * level, so identical inputs always produce byte-identical JSON.
 *
 * Safe when src/content/shoots is missing or empty: it writes an empty map,
 * prunes public/photos, and exits 0 rather than breaking dev/build.
 *
 * Keys are POSIX-style paths relative to src/content/shoots, e.g.
 * "oaxaca-portraits/001.jpg" — src/lib/photos.ts looks entries up by that key.
 */
import { access, mkdir, readdir, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ExifReader from 'exifreader';
import { rgbaToThumbHash, thumbHashToRGBA } from 'thumbhash';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOOTS_DIR = resolve(ROOT, 'src/content/shoots');
const OUT = resolve(ROOT, 'src/generated/photo-meta.json');
const PHOTOS_DIR = resolve(ROOT, 'public/photos');

/** Bump when the entry shape or the ladder policy changes — old caches are dropped. */
const VERSION = 2;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);
// thumbhash accepts at most 100×100 pixels of input.
const THUMB_MAX = 100;

/** Delivery ladder. Sized for the 1100px stream column at 1×/2×. */
const LADDER_WIDTHS = [900, 1400, 2048];
const JPEG_QUALITY = 82;
const AVIF_QUALITY = 55;

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

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Which rungs this master can fill. Never upscales. When the master is narrower
 * than the top rung its own width becomes the top rung, so a small source still
 * gets delivered at full resolution — but only when that is meaningfully wider
 * than the rung below it (no 1400 + 1450 pair).
 */
function ladderWidths(sourceWidth) {
  const widths = LADDER_WIDTHS.filter((width) => width <= sourceWidth);
  const top = LADDER_WIDTHS[LADDER_WIDTHS.length - 1];

  if (sourceWidth < top) {
    const largest = widths[widths.length - 1];
    if (largest === undefined || sourceWidth > largest * 1.05) widths.push(sourceWidth);
  }
  return widths;
}

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

/** Everything that depends only on the master, not on the ladder. */
async function describe(buffer, metadata, stamp) {
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

const publicUrl = (slug, name) => `/photos/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`;

/** The inverse of publicUrl: "/photos/a/b-900.jpg" -> public/photos/a/b-900.jpg. */
const diskPath = (url) =>
  join(PHOTOS_DIR, ...url.replace(/^\/photos\//, '').split('/').map(decodeURIComponent));

/**
 * Encode every rung for one master. Returns the ladder plus the time spent in
 * each encoder, because AVIF is roughly an order of magnitude slower than JPEG
 * and that ratio is what decides whether this can run in CI.
 */
async function buildLadder(path, key, isHDR, sourceWidth) {
  const slash = key.indexOf('/');
  const slug = key.slice(0, slash);
  const file = key.slice(slash + 1);
  const stem = file.slice(0, file.length - extname(file).length);

  const dir = join(PHOTOS_DIR, slug);
  await mkdir(dir, { recursive: true });

  const ladder = [];
  let jpegMs = 0;
  let avifMs = 0;

  for (const width of ladderWidths(sourceWidth)) {
    const jpgName = `${stem}-${width}.jpg`;
    const avifName = `${stem}-${width}.avif`;

    // keepGainMap() only for real gain-map masters: it is experimental, and an
    // SDR master has nothing for it to carry. rotate() bakes in EXIF orientation
    // — safe and a no-op on an upright file, but not allowed alongside
    // keepGainMap, which is why an HDR master must already be upright (main()
    // refuses one that is not).
    const jpegStart = Date.now();
    const input = isHDR ? sharp(path).keepGainMap() : sharp(path).rotate();
    const info = await input.resize({ width }).jpeg({ quality: JPEG_QUALITY }).toFile(join(dir, jpgName));
    jpegMs += Date.now() - jpegStart;

    const avifStart = Date.now();
    await sharp(path).rotate().resize({ width }).avif({ quality: AVIF_QUALITY }).toFile(join(dir, avifName));
    avifMs += Date.now() - avifStart;

    // Trust the encoder's own report over arithmetic on the aspect ratio.
    ladder.push({
      w: info.width,
      h: info.height,
      jpg: publicUrl(slug, jpgName),
      avif: publicUrl(slug, avifName),
    });
  }

  return { ladder, jpegMs, avifMs };
}

/** A cached entry is only reusable if every file it promises is still on disk. */
async function ladderIntact(entry) {
  if (!Array.isArray(entry?.ladder) || entry.ladder.length === 0) return false;
  if (typeof entry.isHDR !== 'boolean') return false;

  for (const rung of entry.ladder) {
    if (typeof rung?.jpg !== 'string' || typeof rung?.avif !== 'string') return false;
    if (typeof rung.w !== 'number' || typeof rung.h !== 'number') return false;
    if (!(await exists(diskPath(rung.jpg))) || !(await exists(diskPath(rung.avif)))) return false;
  }
  return true;
}

/** Every file and directory under `dir`, deepest first. */
async function walk(dir) {
  const files = [];
  const dirs = [];

  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        dirs.push(path); // children pushed first — safe to rmdir in order
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await visit(dir);
  return { files, dirs };
}

/**
 * public/photos is generated output and nothing else writes there, so anything
 * the current run did not produce is stale: renamed files, deleted shoots, rungs
 * dropped because a master got smaller.
 */
async function pruneLadderFiles(photos) {
  const keep = new Set();
  for (const entry of Object.values(photos)) {
    for (const rung of entry.ladder ?? []) {
      keep.add(diskPath(rung.jpg));
      keep.add(diskPath(rung.avif));
    }
  }

  const { files, dirs } = await walk(PHOTOS_DIR);
  let removed = 0;

  for (const file of files) {
    if (keep.has(file)) continue;
    try {
      await unlink(file);
      removed += 1;
    } catch {
      /* already gone */
    }
  }

  for (const dir of dirs) {
    try {
      await rmdir(dir); // throws ENOTEMPTY when the shoot still has rungs
    } catch {
      /* keep it */
    }
  }

  return removed;
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
  const started = Date.now();
  const cache = await readCache();
  const images = await findImages();

  const photos = {};
  let fresh = 0;
  let reused = 0;
  let hdrCount = 0;
  let written = 0;
  let jpegMs = 0;
  let avifMs = 0;
  const failures = [];

  for (const [index, { key, path }] of images.entries()) {
    let stamp;
    try {
      const info = await stat(path);
      stamp = { mtimeMs: Math.round(info.mtimeMs), size: info.size };
    } catch {
      continue; // vanished between readdir and stat
    }

    const cached = cache[key];
    const stampMatches =
      cached?.source &&
      cached.source.mtimeMs === stamp.mtimeMs &&
      cached.source.size === stamp.size &&
      typeof cached.thumbhash === 'string' &&
      typeof cached.width === 'number';

    if (stampMatches && (await ladderIntact(cached))) {
      photos[key] = cached;
      if (cached.isHDR) hdrCount += 1;
      reused += 1;
      continue;
    }

    try {
      const buffer = await readFile(path);
      const metadata = await sharp(buffer).metadata();
      // The one true HDR test: libvips reports a gainMap field only for
      // gain-map JPEGs (ISO 21496-1 / Adobe HDR).
      const isHDR = 'gainMap' in metadata;

      // The orientation tag does not survive the encode, and keepGainMap() rules
      // out the rotate() that would bake it in — so an HDR master that is not
      // already upright would ship sideways in JPEG while its AVIF twin (which
      // the HEIF encoder auto-orients) came out portrait. Refuse it instead.
      // Lightroom's "Maximize Compatibility" JPEG export is always upright.
      if (isHDR && (metadata.orientation ?? 1) !== 1) {
        throw new Error(
          `EXIF orientation ${metadata.orientation} on an HDR master — re-export with the ` +
            'rotation baked into the pixels (keepGainMap cannot be combined with rotate)',
        );
      }

      const base = stampMatches ? cached : await describe(buffer, metadata, stamp);
      // Display width: for a rotated SDR master the ladder is built from the
      // upright image, so the rungs must be measured against that.
      const sourceWidth = base.width || metadata.width;
      const timed = await buildLadder(path, key, isHDR, sourceWidth);

      jpegMs += timed.jpegMs;
      avifMs += timed.avifMs;
      written += timed.ladder.length * 2;

      const entry = { ...base, isHDR, ladder: timed.ladder, source: stamp };
      photos[key] = entry;
      if (isHDR) hdrCount += 1;
      fresh += 1;

      console.log(
        `[photo-meta] ${index + 1}/${images.length} ${key} — ${isHDR ? 'HDR' : 'SDR'}, ` +
          `${timed.ladder.map((rung) => rung.w).join('/')}px, ` +
          `${seconds(timed.jpegMs + timed.avifMs)} (avif ${seconds(timed.avifMs)})`,
      );
    } catch (error) {
      // One unreadable file must not take the build down.
      failures.push(`${key}: ${error?.message ?? error}`);
    }
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(stableSort({ version: VERSION, photos }), null, 2)}\n`, 'utf8');

  const prunedFiles = await pruneLadderFiles(photos);
  const prunedEntries = Object.keys(cache).filter((key) => !(key in photos)).length;
  const total = Date.now() - started;

  console.log(
    `[photo-meta] ${images.length} image(s): ${fresh} processed, ${reused} cached` +
      `${hdrCount ? `, ${hdrCount} HDR` : ''}` +
      `${prunedEntries ? `, ${prunedEntries} entr(ies) pruned` : ''}` +
      `${prunedFiles ? `, ${prunedFiles} stale file(s) removed` : ''}` +
      ` -> src/generated/photo-meta.json + public/photos/`,
  );
  console.log(
    `[photo-meta] total ${seconds(total)} — ${written} ladder file(s): ` +
      `jpeg ${seconds(jpegMs)}, avif ${seconds(avifMs)}, other ${seconds(Math.max(0, total - jpegMs - avifMs))}`,
  );
  for (const failure of failures) console.warn('[photo-meta] skipped —', failure);
}

main().catch((error) => {
  console.error('[photo-meta] failed —', error?.stack ?? error);
  process.exit(1);
});
