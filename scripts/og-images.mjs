#!/usr/bin/env node
/**
 * scripts/og-images.mjs — social card generator. Owned by Agent D.
 * Runs at `predev` / `prebuild`, after scripts/photo-meta.mjs (see package.json § generate).
 *
 * Emits 1200×630 JPEGs → public/og/{home,sessions,information}.jpg
 *
 *   with photos: the leading stream cover (date desc, then featured desc), cropped
 *                to 1.91:1, darkened with a top→bottom gradient, wordmark overlaid.
 *                Distinct covers per page when the collection has enough shoots.
 *   no photos:   wordmark in --ink on a --paper ground. Same composition, no image.
 *
 * Three properties this script is built around:
 *
 *  1. NO FONT DEPENDENCY. The wordmark is drawn as stroked vector letterforms, not
 *     SVG <text>. librsvg inside sharp resolves fonts through fontconfig, and a CI
 *     container (Cloudflare Pages) has a different font set than a Mac — <text> would
 *     silently render in a fallback face, or as blank boxes. Vectors render byte-identically
 *     everywhere. (If SITE.name ever contains a letter this file has no glyph for, it
 *     degrades to <text> with a generic stack rather than dropping characters.)
 *  2. DETERMINISTIC. Same inputs → same bytes. No timestamps, no randomness.
 *  3. INCREMENTAL. A manifest keyed on a signature of (recipe version, brand strings,
 *     source path + mtime + size) skips work when nothing changed. Second run is a no-op.
 *
 * Never throws the build: on any failure it warns, tries the photo-free fallback, and
 * exits 0. A missing OG image degrades a Slack unfurl; it must not cost a deploy.
 */
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOOTS_DIR = resolve(ROOT, 'src/content/shoots');
const OUT_DIR = resolve(ROOT, 'public/og');
const MANIFEST = resolve(ROOT, 'node_modules/.cache/og-images/manifest.json');

/** Bump when the composition changes, so cached outputs are invalidated. */
const RECIPE = 5;

const WIDTH = 1200;
const HEIGHT = 630;

const PAPER = '#F1EEE5';
const INK = '#33291E';
const SHADE = '#0F0B07';

const IMAGE_EXT = /\.(jpe?g|png|webp|tiff?)$/i;
/**
 * Masters, not deliverables: `<stem>.avif` and `<stem>.sdr.jpg` are the two
 * halves scripts/convert-masters.mjs turns into the `<stem>.jpg` beside them.
 * Neither is a publishable frame — and `.avif` sorts *before* `.jpg`, so
 * without this the automatic cover pick would land on the master every time
 * (and libvips cannot even open a tiled Lightroom AVIF).
 */
const MASTER_ONLY = /(\.sdr\.jpe?g|\.avif)$/i;

/* ---------------------------------------------------------------- config ---- */

/**
 * Read the handful of strings we need out of src/config.ts.
 *
 * Deliberately a regex and not an import: config.ts is TypeScript, this is a plain
 * node script run before any bundler exists, and Node 22.13 cannot import .ts without
 * a flag. The fields are simple string literals; if that ever stops being true, the
 * defaults below keep the script working.
 */
async function readSiteConfig() {
  const fallback = { name: 'RYUXIK', title: 'Ryuxik — Photographer' };
  try {
    const source = await readFile(resolve(ROOT, 'src/config.ts'), 'utf8');
    const field = (key) => {
      const match = source.match(new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]*)["'\`]`));
      return match ? match[1] : undefined;
    };
    return {
      name: field('name') || fallback.name,
      title: field('title') || fallback.title,
    };
  } catch {
    return fallback;
  }
}

/* ----------------------------------------------------------- frontmatter ---- */

/**
 * Minimal top-level YAML frontmatter reader — enough for the five scalar fields this
 * script cares about (date, featured, cover, subject, title). Not a YAML parser and
 * does not pretend to be: Agent B's zod schema is the real validator, this just needs
 * to pick a cover image and sort by it.
 */
function parseFrontmatter(markdown) {
  const match = markdown.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const data = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('#') || /^\s/.test(line)) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    data[kv[1]] = value;
  }
  return data;
}

/** Shoots sorted the way the stream sorts them: date desc, then featured desc. */
async function collectCovers() {
  let entries;
  try {
    entries = await readdir(SHOOTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const shoots = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(SHOOTS_DIR, entry.name);

    let markdown;
    try {
      markdown = await readFile(join(dir, 'index.md'), 'utf8');
    } catch {
      continue; // no index.md yet — Agent B may still be writing this folder
    }

    const data = parseFrontmatter(markdown);
    const cover = await resolveCover(dir, data.cover);
    if (!cover) continue;

    const parsedDate = data.date ? Date.parse(data.date) : Number.NaN;
    shoots.push({
      slug: entry.name,
      cover,
      date: Number.isNaN(parsedDate) ? 0 : parsedDate,
      featured: Number.parseFloat(data.featured ?? '0') || 0,
    });
  }

  shoots.sort((a, b) => b.date - a.date || b.featured - a.featured || a.slug.localeCompare(b.slug));
  return shoots.map((shoot) => shoot.cover);
}

/** Frontmatter cover if it exists on disk, else the first image in the folder. */
async function resolveCover(dir, coverField) {
  if (coverField) {
    const candidate = resolve(dir, coverField);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // fall through to the directory scan
    }
  }

  try {
    const files = (await readdir(dir))
      .filter((name) => IMAGE_EXT.test(name) && !MASTER_ONLY.test(name))
      .sort();
    return files.length > 0 ? join(dir, files[0]) : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- wordmark ---- */

/**
 * Stroked letterforms on a 100-unit cap-height grid, drawn inset by half the stroke
 * width so nothing clips. `w` is the advance width. Uniform stroke weight = grotesque.
 */
const STROKE = 11;
const CAP = 100;
const TRACKING = 46; // ≈ 0.34em at a 140-unit em — matches --tracking-wordmark

const GLYPHS = {
  R: {
    w: 62,
    d: ['M5.5,5.5 V94.5', 'M5.5,5.5 H34 A22.25,22.25 0 0 1 34,50 H5.5', 'M30,50 L56.5,94.5'],
  },
  Y: { w: 64, d: ['M5.5,5.5 L32,50 L58.5,5.5', 'M32,50 V94.5'] },
  U: { w: 62, d: ['M5.5,5.5 V64 A25.5,25.5 0 0 0 56.5,64 V5.5'] },
  X: { w: 64, d: ['M5.5,5.5 L58.5,94.5', 'M58.5,5.5 L5.5,94.5'] },
  I: { w: 11, d: ['M5.5,5.5 V94.5'] },
  // The leg starts exactly on the arm's centreline (x=24 → y=36.9) so the join is clean.
  K: { w: 60, d: ['M5.5,5.5 V94.5', 'M53,5.5 L10,52', 'M24,36.9 L54.5,94.5'] },
  O: { w: 66, d: ['M5.5,28.5 A27.5,27.5 0 0 1 60.5,28.5 V71.5 A27.5,27.5 0 0 1 5.5,71.5 Z'] },
  S: {
    w: 60,
    d: [
      'M54.5,22 A22,22 0 1 0 27.5,44 A22,22 0 1 1 5.5,72 A22,22 0 0 0 27.5,94.5 A22,22 0 0 0 49.5,72',
    ],
  },
  ' ': { w: 34, d: [] },
};

const hasAllGlyphs = (text) => [...text].every((char) => GLYPHS[char] !== undefined);

const naturalWidth = (text) =>
  [...text].reduce((sum, char) => sum + GLYPHS[char].w, 0) + Math.max(0, text.length - 1) * TRACKING;

/**
 * @returns {string} an <svg> group placing `text` centred on (centerX) with the given
 *   drawn width, cap height derived from the same scale.
 */
function wordmarkSvg(text, { centerX, centerY, targetWidth, color }) {
  if (!hasAllGlyphs(text)) {
    // Degrade rather than drop letters. Font resolution is environment-dependent here.
    const size = Math.round(targetWidth / (text.length * 0.78 || 1));
    return `<text x="${centerX}" y="${centerY + size * 0.36}" fill="${color}" text-anchor="middle" font-family="Archivo, Helvetica, Arial, DejaVu Sans, sans-serif" font-size="${size}" font-weight="500" letter-spacing="${(size * 0.34).toFixed(2)}">${escapeXml(text)}</text>`;
  }

  const scale = targetWidth / naturalWidth(text);
  const originX = centerX - targetWidth / 2;
  const originY = centerY - (CAP * scale) / 2;

  let cursor = 0;
  const letters = [...text].map((char) => {
    const glyph = GLYPHS[char];
    const paths = glyph.d.map((d) => `<path d="${d}"/>`).join('');
    const group = paths ? `<g transform="translate(${cursor},0)">${paths}</g>` : '';
    cursor += glyph.w + TRACKING;
    return group;
  });

  return (
    `<g transform="translate(${originX.toFixed(2)},${originY.toFixed(2)}) scale(${scale.toFixed(5)})" ` +
    `fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="butt" stroke-linejoin="miter">` +
    `${letters.join('')}</g>`
  );
}

const escapeXml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char],
  );

/** Full-bleed overlay: darkening gradient (photo variant only) + wordmark + hairline. */
function overlaySvg(brand, { onPhoto }) {
  const color = onPhoto ? PAPER : INK;
  const centerY = Math.round(HEIGHT * 0.47);
  const targetWidth = Math.min(560, WIDTH - 240);
  const ruleWidth = 96;
  const ruleY = centerY + 108;

  const shade = onPhoto
    ? `<defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${SHADE}" stop-opacity="0.42"/>` +
      `<stop offset="0.55" stop-color="${SHADE}" stop-opacity="0.58"/>` +
      `<stop offset="1" stop-color="${SHADE}" stop-opacity="0.74"/>` +
      `</linearGradient></defs>` +
      `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#shade)"/>`
    : '';

  const mark = wordmarkSvg(brand, {
    centerX: WIDTH / 2,
    centerY,
    targetWidth,
    color,
  });

  const rule =
    `<rect x="${(WIDTH - ruleWidth) / 2}" y="${ruleY}" width="${ruleWidth}" height="2" ` +
    `fill="${color}" fill-opacity="${onPhoto ? 0.75 : 0.35}"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" ` +
    `viewBox="0 0 ${WIDTH} ${HEIGHT}">${shade}${mark}${rule}</svg>`
  );
}

/* --------------------------------------------------------------- compose ---- */

async function composePhoto(source, overlay, dest) {
  await sharp(source)
    .rotate() // honour EXIF orientation before cropping
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: sharp.strategy.attention })
    .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
    .jpeg({ quality: 82, chromaSubsampling: '4:4:4', progressive: true })
    .toFile(dest);
}

async function composeFallback(overlay, dest) {
  await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 3, background: PAPER },
  })
    .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4', progressive: true })
    .toFile(dest);
}

/* -------------------------------------------------------------- manifest ---- */

async function readManifest() {
  try {
    const parsed = JSON.parse(await readFile(MANIFEST, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

async function writeManifest(entries) {
  try {
    await mkdir(dirname(MANIFEST), { recursive: true });
    await writeFile(MANIFEST, `${JSON.stringify({ recipe: RECIPE, entries }, null, 2)}\n`, 'utf8');
  } catch (error) {
    // A cache we cannot write is a slow build, not a broken one.
    console.warn('[og-images] could not write manifest —', error?.message ?? error);
  }
}

const signature = (parts) => createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ main ---- */

const PAGES = ['home', 'sessions', 'information'];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const site = await readSiteConfig();
  const brand = site.name.toUpperCase();
  const covers = await collectCovers();
  const manifest = await readManifest();
  const previous = manifest.recipe === RECIPE ? manifest.entries : {};
  const next = {};

  let written = 0;
  let skipped = 0;

  for (const [index, page] of PAGES.entries()) {
    const dest = join(OUT_DIR, `${page}.jpg`);
    // Distinct cover per page when the collection is deep enough; wraps otherwise.
    const source = covers.length > 0 ? covers[index % covers.length] : null;

    let sourceStamp = null;
    if (source) {
      try {
        const info = await stat(source);
        sourceStamp = { path: source.slice(ROOT.length), mtimeMs: info.mtimeMs, size: info.size };
      } catch {
        sourceStamp = null;
      }
    }

    const sig = signature({ RECIPE, brand, page, source: sourceStamp });
    next[page] = sig;

    if (previous[page] === sig && (await exists(dest))) {
      skipped += 1;
      continue;
    }

    const onPhoto = Boolean(sourceStamp);
    const overlay = overlaySvg(brand, { onPhoto });

    try {
      if (onPhoto) {
        await composePhoto(source, overlay, dest);
      } else {
        await composeFallback(overlay, dest);
      }
      written += 1;
    } catch (error) {
      console.warn(`[og-images] ${page}: photo compose failed (${error?.message ?? error}) — using fallback.`);
      try {
        await composeFallback(overlaySvg(brand, { onPhoto: false }), dest);
        written += 1;
        next[page] = signature({ RECIPE, brand, page, source: null, degraded: true });
      } catch (fallbackError) {
        console.warn(`[og-images] ${page}: fallback failed too —`, fallbackError?.message ?? fallbackError);
        delete next[page];
      }
    }
  }

  await writeManifest(next);

  const mode = covers.length > 0 ? `${covers.length} shoot cover(s)` : 'no shoots — wordmark fallback';
  console.log(`[og-images] ${written} written, ${skipped} unchanged (${mode}) → public/og/`);
}

main().catch((error) => {
  console.warn('[og-images] non-fatal error —', error?.message ?? error);
  process.exit(0);
});
