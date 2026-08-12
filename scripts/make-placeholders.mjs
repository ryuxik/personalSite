#!/usr/bin/env node
/**
 * scripts/make-placeholders.mjs — one-shot placeholder content generator.
 *
 * Writes 3 shoots × 3–4 frames into src/content/shoots/<slug>/, each frame a
 * 4:5 portrait JPEG (1280×1600, 1600px long side) built from a muted warm
 * gradient in a hue family unique to the shoot, plus a vignette, film grain and
 * a centred "PLACEHOLDER" wordmark. Frontmatter matches the zod schema in
 * src/content.config.ts; every body carries a visible `TODO(ryu)` marker.
 *
 * Everything is deterministic (seeded PRNG), so re-running produces byte-identical
 * frames and no git churn.
 *
 * Usage:
 *   node scripts/make-placeholders.mjs           # write missing files only
 *   node scripts/make-placeholders.mjs --force   # overwrite images + index.md
 *
 * This script is NOT wired into predev/prebuild — it is run by hand and its
 * output is committed as ordinary content. Delete a shoot folder to drop it.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOOTS_DIR = resolve(ROOT, 'src/content/shoots');

const WIDTH = 1280; // 4:5 portrait, 1600px on the long side
const HEIGHT = 1600;
const FORCE = process.argv.includes('--force');

/* --- shoots ------------------------------------------------------------- */

/**
 * `hue` is the family centre in HSL degrees; the three shoots are deliberately
 * far apart on the wheel (clay / rose / amber) so the stream reads as three
 * different bodies of work rather than one gradient repeated.
 */
const SHOOTS = [
  {
    slug: 'oaxaca-portraits',
    frames: 4,
    hue: 16, // terracotta / clay
    sat: 26,
    light: 55,
    frontmatter: {
      title: 'Oaxaca portraits',
      subject: 'Marisol A.',
      context: 'personal',
      date: '2026-03-14',
      location: 'Oaxaca, MX',
      genre: 'portraiture',
      featured: 20,
    },
  },
  {
    slug: 'atelier-mora-lookbook',
    frames: 3,
    hue: 340, // dusty rose
    sat: 18,
    light: 58,
    frontmatter: {
      title: 'Atelier Mora — spring lookbook',
      subject: 'Nadia R.',
      context: 'commissioned',
      client: 'Atelier Mora',
      date: '2025-11-02',
      location: 'Mexico City, MX',
      genre: 'portraiture',
      featured: 10,
    },
  },
  {
    slug: 'night-market-lines',
    frames: 4,
    hue: 34, // amber / bronze
    sat: 26,
    light: 46,
    frontmatter: {
      title: 'Night market lines',
      subject: 'Calle Juárez',
      context: 'personal',
      date: '2025-06-21',
      location: 'Puebla, MX',
      genre: 'street',
      featured: 0,
    },
  },
];

const BODY = [
  'TODO(ryu): replace with real work.',
  '',
  'These frames are generated placeholders (`node scripts/make-placeholders.mjs`),',
  'not photographs. Drop real images into this folder as `001.jpg`, `002.jpg`, …',
  '(filename order is display order) and rewrite the frontmatter above.',
].join('\n');

/* --- helpers ------------------------------------------------------------ */

/** Deterministic PRNG so repeated runs emit identical bytes. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** HSL (h deg, s %, l %) -> #rrggbb. */
function hsl(h, s, l) {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.min(100, Math.max(0, s)) / 100;
  const ll = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  const seg = Math.floor(hh / 60) % 6;
  const rgb = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg];
  const hex = rgb.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0'));
  return `#${hex.join('')}`;
}

/** Uniform film grain as a raw RGBA buffer, centred on 128 for `overlay` blending. */
function grainBuffer(width, height, seed) {
  const rand = mulberry32(seed);
  const buf = Buffer.allocUnsafe(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    // ±13 around neutral: overlay(base, 128) is the identity, so this reads as texture.
    const v = 128 + Math.round((rand() - 0.5) * 26);
    const o = i * 4;
    buf[o] = v;
    buf[o + 1] = v;
    buf[o + 2] = v;
    buf[o + 3] = 255;
  }
  return buf;
}

function gradientSvg({ hue, sat, light, index }) {
  // Each frame drifts a little through the family so the set is varied but coherent.
  // The drift alternates sign so a four-frame shoot never walks out of its hue family.
  const h = hue + (index % 2 === 0 ? 1 : -1) * index * 4;
  const s = sat - index * 1.5;
  const l = light + (index % 2 === 0 ? 3 : -4);
  const a = hsl(h + 6, s + 4, l + 11);
  const b = hsl(h, s, l);
  const c = hsl(h - 10, s - 5, l - 15);
  const angle = 18 + index * 9;
  const rad = (angle * Math.PI) / 180;
  const x2 = (0.5 + Math.cos(rad) * 0.5).toFixed(4);
  const y2 = (0.5 + Math.sin(rad) * 0.5).toFixed(4);
  const x1 = (0.5 - Math.cos(rad) * 0.5).toFixed(4);
  const y1 = (0.5 - Math.sin(rad) * 0.5).toFixed(4);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
      <stop offset="0" stop-color="${a}"/>
      <stop offset="0.52" stop-color="${b}"/>
      <stop offset="1" stop-color="${c}"/>
    </linearGradient>
    <radialGradient id="v" cx="0.5" cy="0.42" r="0.78">
      <stop offset="0.5" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.3"/>
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#v)"/>
</svg>`;
}

function textSvg({ slug, frameLabel }) {
  const font = "'Helvetica Neue', Helvetica, Arial, sans-serif";
  const cx = WIDTH / 2;
  // text-anchor="middle" measures the trailing letter-space too; pull back half of it.
  const trackWord = 18;
  const trackSub = 7;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <g fill="#FFF4E6" font-family="${font}" text-anchor="middle">
    <text x="${cx - trackWord / 2}" y="${HEIGHT / 2}" font-size="104" font-weight="600"
          letter-spacing="${trackWord}" fill-opacity="0.86">PLACEHOLDER</text>
    <text x="${cx - trackSub / 2}" y="${HEIGHT / 2 + 62}" font-size="30" font-weight="400"
          letter-spacing="${trackSub}" fill-opacity="0.62">${slug} · ${frameLabel}</text>
  </g>
  <rect x="${cx - 90}" y="${HEIGHT / 2 - 142}" width="180" height="2" fill="#FFF4E6" fill-opacity="0.45"/>
</svg>`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function yaml(frontmatter) {
  // Hand-rolled so key order stays exactly as written above (readable diffs).
  const quote = (v) => `"${String(v).replace(/"/g, '\\"')}"`;
  const lines = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'date') lines.push(`${key}: ${value}`); // unquoted -> parsed as a date
    else if (typeof value === 'number') lines.push(`${key}: ${value}`);
    else lines.push(`${key}: ${quote(value)}`);
  }
  return lines.join('\n');
}

/* --- main --------------------------------------------------------------- */

async function makeFrame(shoot, index) {
  const frameLabel = String(index + 1).padStart(3, '0');
  const base = await sharp(Buffer.from(gradientSvg({ ...shoot, index }))).png().toBuffer();
  const seed = shoot.hue * 1000 + index;

  return sharp(base)
    .composite([
      {
        input: grainBuffer(WIDTH, HEIGHT, seed),
        raw: { width: WIDTH, height: HEIGHT, channels: 4 },
        blend: 'overlay',
      },
      { input: Buffer.from(textSvg({ slug: shoot.slug, frameLabel })), blend: 'over' },
    ])
    .jpeg({ quality: 85, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();
}

async function main() {
  let written = 0;
  let skipped = 0;

  for (const shoot of SHOOTS) {
    const dir = join(SHOOTS_DIR, shoot.slug);
    await mkdir(dir, { recursive: true });

    for (let i = 0; i < shoot.frames; i += 1) {
      const file = join(dir, `${String(i + 1).padStart(3, '0')}.jpg`);
      if (!FORCE && (await exists(file))) {
        skipped += 1;
        continue;
      }
      await writeFile(file, await makeFrame(shoot, i));
      written += 1;
    }

    const indexPath = join(dir, 'index.md');
    if (FORCE || !(await exists(indexPath))) {
      const front = { ...shoot.frontmatter, cover: './001.jpg' };
      await writeFile(indexPath, `---\n${yaml(front)}\n---\n\n${BODY}\n`, 'utf8');
      written += 1;
    } else {
      skipped += 1;
    }

    console.log(`[placeholders] ${shoot.slug}: ${shoot.frames} frames`);
  }

  console.log(
    `[placeholders] done — ${written} file(s) written, ${skipped} left alone${FORCE ? '' : ' (pass --force to overwrite)'}.`,
  );
}

main().catch((error) => {
  console.error('[placeholders] failed —', error?.stack ?? error);
  process.exit(1);
});
