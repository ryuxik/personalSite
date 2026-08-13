#!/usr/bin/env node
/**
 * scripts/convert-masters.mjs — AVIF HDR master → gain-map JPEG master.
 *
 * Runs FIRST in the `generate` chain, before photo-meta.mjs, so that by the time
 * the ladder generator walks the shoot folders every master it can see is a JPEG.
 *
 * WHY THIS STEP EXISTS
 * --------------------
 * Our delivery format is the gain-map JPEG (ISO 21496-1): an authored SDR base
 * image plus a gain map, in the one container sharp/libvips can both read *and*
 * write. sharp cannot see a gain map inside an AVIF at all — a plain decode
 * yields the SDR base (or a tone map of the HDR) and silently drops the HDR
 * half. So an AVIF master is transcoded to a gain-map JPEG once, here, and the
 * existing pipeline takes over unchanged.
 *
 * TWO MASTER SHAPES, TWO MODES
 * ----------------------------
 * Which one you get depends on what Lightroom's HDR export writes:
 *
 *   AVIF mode   <stem>.avif carries its own gain map (an authored SDR base +
 *               map in one file). Everything needed is inside the one file:
 *               unpack it and repack it as a JPEG.
 *
 *   PAIR mode   <stem>.avif is a single PQ HDR rendition with NO gain map, and
 *               <stem>.sdr.jpg beside it is the SDR photograph the photographer
 *               graded. The gain map does not exist yet — it is *computed* from
 *               the two intents by libultrahdr, which is exactly what a gain map
 *               is: the per-pixel ratio between an SDR rendition and an HDR one.
 *
 * PAIR MODE IS THE ONE IN USE. Lightroom 9.5's HDR AVIF export writes a bare PQ
 * rendition (CICP 12/16, XMP `crs:HDREditMode=1`) with no gain map, and offers
 * no setting that adds one. The SDR half therefore has to come from a second
 * export of the same photograph. AVIF mode is kept for the day that changes.
 *
 * (If the JPEG export on your Lightroom writes a gain map directly — check with
 * `node scripts/check-hdr.mjs ~/exports` — then neither mode is needed: that
 * JPEG *is* the master. Drop it in as `<stem>.jpg` and this script stays quiet.)
 *
 * THE ONE RULE: DO NOT RE-TONE-MAP
 * --------------------------------
 * The SDR base is a photograph the photographer graded. It is NOT a fallback to
 * be regenerated. Both modes hand `ultrahdr_app` the authored SDR as a
 * *compressed JPEG*, which it copies into the output container byte-for-byte —
 * measured base RMSE against the input is 0.0000 in both modes, max |delta| 0.
 * (sharp's withGainMap() would tone map a new base and come out ~42% darker; it
 * is never used here, or anywhere.)
 *
 * PAIR MODE, STEP BY STEP — and why each step is the way it is
 * ------------------------------------------------------------
 *   1. `avifdec master.avif hdr.png` — 16-bit PNG, PQ-coded, source primaries.
 *      avifgainmaputil is not involved: there is no gain map to extract.
 *
 *   2. Read that PNG with **`sharp(png).toColourspace('rgb16').raw({depth:'ushort'})`**.
 *      The `toColourspace('rgb16')` is load-bearing and its absence is silent:
 *      sharp's default pipeline interpretation is 8-bit sRGB, so `raw({depth:
 *      'ushort'})` on its own hands back `value >> 8` widened into a ushort —
 *      a 10-bit master quietly becomes 8-bit, and every highlight ratio the gain
 *      map is computed from is wrong. Verified against a from-scratch zlib PNG
 *      decode: with the cast, exact; without it, off by a factor of 256.
 *
 *   3. Bring the HDR intent into the SDR base's colour primaries (measured from
 *      the base's ICC). libultrahdr will only write a gain map that applies in
 *      the *base's* colour space when both intents declare the same gamut; when
 *      they differ it sets `useBaseColorSpace=0`, and then libvips refuses the
 *      file outright ("gainmap image is expected to contain alternate image
 *      color space in the form of ICC") — so the whole ladder would fail. It is
 *      also more accurate to convert honestly than to mislabel: measured
 *      per-channel PQ PSNR against the true reference is 41.19 dB converted vs
 *      39.99 dB mislabelled.
 *
 *   4. Pack to **RGBA1010102**, the format `-a 5` expects: one little-endian
 *      uint32 per pixel, red in bits 0–9, green in 10–19, blue in 20–29, alpha
 *      (always 3 = opaque) in 30–31. Values are PQ *code* values, not nits.
 *
 *   5. `ultrahdr_app -m 0` with the raw HDR intent and the compressed SDR JPEG
 *      (encoding scenario 3). Flags that matter, all of them verified:
 *
 *        -t 2         HDR transfer is PQ. Wrong here = wrong gain map.
 *        -C n / -c n  HDR / SDR gamut. libultrahdr cross-checks `-c` against the
 *                     SDR JPEG's ICC and refuses a mismatch, so this is asserted
 *                     rather than assumed. Both are set from that ICC (step 3).
 *        -L <peak>    Target display peak, in nits. This is the flag that decides
 *                     whether the photograph renders as authored on real screens:
 *                     it sets `hdrCapacityMax = L / 203`, the headroom at which a
 *                     display applies the *whole* map. libultrahdr's default for
 *                     PQ is 10000 nits → capacity 49.26 (5.62 stops), so a normal
 *                     1.5-stop laptop would apply barely a quarter of the map and
 *                     the photo would render flat. So `-L` is set to the master's
 *                     own measured peak luminance. It changes only the metadata,
 *                     not the signal — verified: L = 10000/1000/424 give
 *                     byte-identical images and three different capacities.
 *        -M 1         Multi-channel gain map (libultrahdr's default). Measured
 *                     +1.24 dB per-channel over single-channel on real frames;
 *                     single-channel is slightly better on luminance alone but
 *                     loses highlight colour, which is the point of the format.
 *        -s 1 -Q 95   Gain map at full resolution, quality 95. See § SIZE below.
 *        -D 1         "best quality" preset.
 *
 * Both modes then check the result with sharp before installing it: a file whose
 * gain map libvips cannot see would silently produce a flat SDR ladder.
 *
 * SIZE
 * ----
 * The gain map is not free: it is a second image, and at these settings it costs
 * +70% to +190% on top of the plain SDR JPEG depending on how much of the frame
 * is above SDR white. Measured on two real frames, against the same frames'
 * Lightroom-authored gain-map JPEGs; `-s` is the map's downsample factor and
 * "PQ PSNR" is against the PQ AVIF, in the perceptually-uniform PQ domain:
 *
 *                      1707×2560 portrait      2560×1707 landscape
 *   -s 1 -Q 95         +71%   42.9 dB          +187%  58.7 dB   ← this script
 *   -s 1 -Q 90         +40%   40.3 dB          +116%  57.1 dB
 *   -s 2 -Q 95         +30%   38.5 dB           +67%  49.6 dB
 *   -s 4 -Q 95          +8%   38.2 dB           +16%  47.6 dB
 *   Lightroom's own    +61%   38.8 dB           +67%  (n/a)
 *
 * Full resolution is kept because this is the *master* every ladder rung is
 * resized from, and it beats Lightroom's own fidelity on every frame measured.
 * `GAINMAP_DOWNSAMPLE = 2` is the one-line change that trades that margin for
 * Lightroom's file sizes, if the repo ever needs the bytes back.
 *
 * METADATA MAPPING — ISO 21496-1 → libultrahdr  (AVIF mode only)
 * --------------------------------------------------------------
 * The two formats carry the same quantities in different units. ISO 21496-1
 * stores the gain limits and headrooms as **log2**; libultrahdr's config file
 * wants them **linear**. Getting this wrong does not fail loudly — it ships a
 * wrong HDR rendition — so it is exp2() on exactly four fields and identity on
 * the rest:
 *
 *   Gain Map Min        (log2) → --minContentBoost     2^x
 *   Gain Map Max        (log2) → --maxContentBoost     2^x
 *   Base headroom       (log2) → --hdrCapacityMin      2^x
 *   Alternate headroom  (log2) → --hdrCapacityMax      2^x
 *   Gain Map Gamma             → --gamma               as-is
 *   Base Offset                → --offsetSdr           as-is
 *   Alternate Offset           → --offsetHdr           as-is
 *   Use Base Color Space       → --useBaseColorSpace   True→1 / False→0
 *
 * ISO 21496-1 stores each of those per channel (R/G/B); libultrahdr's config has
 * one value per field. Every writer we have seen emits three identical channels;
 * if they ever differ this script refuses the file rather than silently keeping
 * the red channel's number for all three.
 *
 * FOLDER CONVENTION
 * -----------------
 *   <stem>.avif      HDR master out of Lightroom            gitignored
 *   <stem>.sdr.jpg   authored SDR master out of Lightroom   gitignored
 *   <stem>.jpg       the gain-map JPEG this script writes    COMMITTED
 *
 * Both inputs are masters and both are gitignored: they are re-exportable from
 * the catalogue, and the derived `.jpg` already *contains* the `.sdr.jpg` — its
 * primary image is those bytes verbatim — so committing both would store the
 * same photograph twice. The derived `.jpg` is committed so that CI and a fresh
 * clone never need libavif or libultrahdr.
 *
 * `photo-meta.mjs` skips `*.sdr.jpg` (and `.avif`) when it walks a shoot folder,
 * or every HDR photograph would appear twice in the stream — once properly and
 * once as its own flat SDR half.
 *
 * INCREMENTAL
 * -----------
 * Same stamp style as photo-meta: an entry is reused when the mtime+size of
 * *both* inputs match the cached stamp AND the .jpg they produced is still on
 * disk with the mtime+size it had when written. A master whose .jpg is simply
 * newer than its inputs (the fresh-clone case, where the .jpg is committed and
 * the stamp file is not) is also left alone.
 *
 * EXTERNAL TOOLS
 * --------------
 * avifdec + avifgainmaputil (brew libavif) and ultrahdr_app (brew libultrahdr).
 * Only the tools the pending work actually needs are required — pair mode never
 * calls avifgainmaputil. When they are missing the script warns and skips rather
 * than failing: the converted .jpg masters are committed, so CI never needs any
 * of this. See `TOOLS` below for the install lines the warning prints.
 */
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOOTS_DIR = resolve(ROOT, 'src/content/shoots');
const STAMPS = resolve(ROOT, 'src/generated/converted-masters.json');

/** Bump when the chain or the entry shape changes — old stamps are dropped. */
const VERSION = 2;

/** The authored SDR half of a pair. photo-meta.mjs excludes the same suffix. */
const SDR_SUFFIX = '.sdr.jpg';

/** Quality for the SDR base. AVIF mode re-encodes the base once, here, and never again. */
const BASE_QUALITY = 95;
const GAINMAP_QUALITY = 95;
/** Gain map downsample factor for pair mode: 1 = same resolution as the image. */
const GAINMAP_DOWNSAMPLE = 1;

/** SDR diffuse white, in nits. The reference every headroom in the format is measured against. */
const SDR_WHITE_NITS = 203;

/**
 * Each tool, the binary name, the env var that overrides it, and how to get it.
 * ultrahdr_app is last because it is the one with a caveat worth printing.
 */
const TOOLS = {
  avifdec: {
    env: 'AVIFDEC',
    install: 'brew install libavif',
  },
  avifgainmaputil: {
    env: 'AVIFGAINMAPUTIL',
    install: 'brew install libavif',
  },
  ultrahdr_app: {
    env: 'ULTRAHDR_APP',
    install: 'brew install libultrahdr',
  },
};

/* --- helpers ------------------------------------------------------------ */

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/** mtime+size stamp, the same shape photo-meta uses. */
async function stampOf(path) {
  const info = await stat(path);
  return { mtimeMs: Math.round(info.mtimeMs), size: info.size };
}

const sameStamp = (a, b) => {
  if (a === null && b === null) return true;
  return Boolean(a) && Boolean(b) && a.mtimeMs === b.mtimeMs && a.size === b.size;
};

/** Resolve a tool to an absolute path (or its bare name), or null when absent. */
async function findTool(name) {
  const override = process.env[TOOLS[name].env];
  if (override) return (await exists(override)) ? override : null;

  try {
    const { stdout } = await run('which', [name]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readStamps() {
  try {
    const parsed = JSON.parse(await readFile(STAMPS, 'utf8'));
    if (parsed?.version === VERSION && parsed.masters && typeof parsed.masters === 'object') {
      return parsed.masters;
    }
  } catch {
    /* missing or corrupt — reconvert */
  }
  return {};
}

/**
 * Every master under src/content/shoots/<slug>/, keyed by stem, sorted.
 * A stem is a master when it has a `.avif`; a lone `.sdr.jpg` is reported too,
 * because it is almost always a half-finished copy rather than a deliberate act.
 */
async function findMasters() {
  let slugs;
  try {
    slugs = await readdir(SHOOTS_DIR, { withFileTypes: true });
  } catch {
    return [];
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

    const stems = new Map();
    const at = (stem) => {
      if (!stems.has(stem)) {
        stems.set(stem, {
          key: `${slug.name}/${stem}`,
          stem,
          avif: null,
          sdr: null,
          jpg: join(dir, `${stem}.jpg`),
        });
      }
      return stems.get(stem);
    };

    for (const file of files.filter((entry) => entry.isFile()).sort(byName)) {
      const name = file.name;
      if (name.toLowerCase().endsWith(SDR_SUFFIX)) {
        at(name.slice(0, name.length - SDR_SUFFIX.length)).sdr = join(dir, name);
      } else if (extname(name).toLowerCase() === '.avif') {
        at(name.slice(0, name.length - extname(name).length)).avif = join(dir, name);
      }
    }

    for (const stem of [...stems.keys()].sort()) found.push(stems.get(stem));
  }
  return found;
}

/* --- colour -------------------------------------------------------------- */

/**
 * CICP colour primaries → the name, libultrahdr's `-C`/`-c` gamut code, and the
 * linear RGB→XYZ (D65) matrix. Only the three a camera raw pipeline ever emits.
 */
const PRIMARIES = {
  1: {
    name: 'BT.709 / sRGB',
    gamut: 0,
    toXyz: [
      [0.4123908, 0.3575843, 0.1804808],
      [0.2126390, 0.7151687, 0.0721923],
      [0.0193308, 0.1191948, 0.9505322],
    ],
  },
  9: {
    name: 'BT.2020',
    gamut: 2,
    toXyz: [
      [0.6369580, 0.1446169, 0.1688810],
      [0.2627002, 0.6779981, 0.0593017],
      [0.0000000, 0.0280727, 1.0609851],
    ],
  },
  12: {
    name: 'Display P3',
    gamut: 1,
    toXyz: [
      [0.4865709, 0.2656677, 0.1982173],
      [0.2289746, 0.6917385, 0.0792869],
      [0.0000000, 0.0451134, 1.0439444],
    ],
  },
};
// DCI-P3 (CICP 11) shares Display P3's primaries; only the white point differs,
// and Lightroom never writes it for a display-referred export.
PRIMARIES[11] = PRIMARIES[12];

function matInverse(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error('singular colour matrix');
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

const matMul = (x, y) =>
  x.map((row) => y[0].map((_, col) => row[0] * y[0][col] + row[1] * y[1][col] + row[2] * y[2][col]));

/* --- PQ (SMPTE ST 2084) -------------------------------------------------- */

const PQ_M1 = 1305 / 8192;
const PQ_M2 = 2523 / 32;
const PQ_C1 = 107 / 128;
const PQ_C2 = 2413 / 128;
const PQ_C3 = 2392 / 128;

/** PQ code value in [0,1] → absolute luminance in nits. */
function pqToNits(value) {
  const p = Math.pow(Math.max(value, 0), 1 / PQ_M2);
  return 10000 * Math.pow(Math.max(p - PQ_C1, 0) / (PQ_C2 - PQ_C3 * p), 1 / PQ_M1);
}

/** Absolute luminance in nits → PQ code value in [0,1]. */
function nitsToPq(nits) {
  const p = Math.pow(Math.min(Math.max(nits, 0), 10000) / 10000, PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2 * p) / (1 + PQ_C3 * p), PQ_M2);
}

/** 10-bit codes are the only ones a PQ AVIF from Lightroom carries — LUT them. */
const PQ_NITS = new Float64Array(1024);
for (let code = 0; code < 1024; code += 1) PQ_NITS[code] = pqToNits(code / 1023);

/* --- reading the AVIF ---------------------------------------------------- */

/**
 * `avifgainmaputil printmetadata` output → the ISO 21496-1 fields, in log2 where
 * the format stores log2. Returns null when the file simply has no gain map,
 * which is the normal case for a Lightroom 9.5 HDR export (that is pair mode's
 * cue), and throws only when the tool failed for some other reason.
 */
async function readGainMapMetadata(tools, avif) {
  let stdout;
  try {
    ({ stdout } = await run(tools.avifgainmaputil, ['printmetadata', avif]));
  } catch (error) {
    const text = `${error?.stdout ?? ''}${error?.stderr ?? ''}`;
    if (/does not contain a gain map/i.test(text)) return null;
    throw new Error(`avifgainmaputil printmetadata failed — ${text.trim() || error?.message}`);
  }

  // Lines look like:
  //   * Gain Map Min:  R 3.56067 (as fraction: …) G 3.56067 (…) B 3.56067 (…)
  //   * Base headroom: 0 (as fraction: 0/1)
  const scalar = (label) => {
    const match = stdout.match(new RegExp(`\\*\\s*${label}\\s*:\\s*(-?[\\d.]+)`, 'i'));
    return match ? Number(match[1]) : undefined;
  };

  /** A per-channel field. All three must agree — libultrahdr's config has one slot. */
  const perChannel = (label) => {
    const line = stdout.match(new RegExp(`\\*\\s*${label}\\s*:(.*)`, 'i'))?.[1];
    if (!line) return undefined;
    const channels = [...line.matchAll(/\b[RGB]\s+(-?[\d.]+)/g)].map((match) => Number(match[1]));
    if (channels.length === 0) return undefined;
    if (channels.some((value) => Math.abs(value - channels[0]) > 1e-6)) {
      throw new Error(
        `per-channel ${label} differs across R/G/B (${channels.join(', ')}) — libultrahdr's ` +
          'metadata config carries one value per field and cannot express that',
      );
    }
    return channels[0];
  };

  const metadata = {
    gainMapMinLog2: perChannel('Gain Map Min'),
    gainMapMaxLog2: perChannel('Gain Map Max'),
    gamma: perChannel('Gain Map Gamma'),
    offsetSdr: perChannel('Base Offset'),
    offsetHdr: perChannel('Alternate Offset'),
    baseHeadroomLog2: scalar('Base headroom'),
    alternateHeadroomLog2: scalar('Alternate headroom'),
    useBaseColorSpace: /Use Base Color Space\s*:\s*True/i.test(stdout),
  };

  for (const [field, value] of Object.entries(metadata)) {
    if (value === undefined) {
      throw new Error(`could not read "${field}" from avifgainmaputil printmetadata output`);
    }
  }
  return metadata;
}

/** Dimensions, CICP signalling, and the alternate image's primaries when there is one. */
async function readImageInfo(tools, avif) {
  const { stdout } = await run(tools.avifdec, ['--info', avif]).catch((error) => ({
    stdout: `${error?.stdout ?? ''}${error?.stderr ?? ''}`,
  }));

  const resolution = stdout.match(/\*\s*Resolution\s*:\s*(\d+)x(\d+)/i);
  const primaries = stdout.match(/\*\s*Color Primaries\s*:\s*(\d+)/i);
  const transfer = stdout.match(/\*\s*Transfer Char\.?\s*:\s*(\d+)/i);
  // The nested "Alternate image:" block, when the file has a gain map.
  const alternate = stdout.split(/\*\s*Alternate image\s*:/i)[1];
  const altPrimaries = alternate?.match(/\*\s*Color Primaries\s*:\s*(\d+)/i);

  return {
    width: resolution ? Number(resolution[1]) : undefined,
    height: resolution ? Number(resolution[2]) : undefined,
    primaries: primaries ? Number(primaries[1]) : undefined,
    transfer: transfer ? Number(transfer[1]) : undefined,
    alternatePrimaries: altPrimaries ? Number(altPrimaries[1]) : undefined,
  };
}

/* --- reading the SDR half ------------------------------------------------ */

/**
 * Which primaries the authored SDR JPEG is in, read from its ICC red colorant
 * (sRGB's is at x≈0.436, Display P3's at x≈0.515 — nothing else is close). A
 * JPEG with no ICC is sRGB by every convention that matters here.
 *
 * This is not a guess that can go unnoticed: libultrahdr cross-checks the `-c`
 * it is given against this same ICC and refuses the encode on a mismatch.
 */
async function readSdrPrimaries(sdr) {
  const { icc } = await sharp(sdr).metadata();
  if (!icc || icc.length < 132) return 1;

  const count = icc.readUInt32BE(128);
  for (let index = 0; index < count; index += 1) {
    const entry = 132 + index * 12;
    if (entry + 12 > icc.length) break;
    if (icc.subarray(entry, entry + 4).toString('ascii') !== 'rXYZ') continue;
    const offset = icc.readUInt32BE(entry + 4);
    if (offset + 12 > icc.length) break;
    const redX = icc.readInt32BE(offset + 8) / 65536;
    return redX > 0.47 ? 12 : 1;
  }
  return 1;
}

/**
 * The PQ HDR rendition, as the RGBA1010102 buffer `ultrahdr_app -a 5` wants,
 * expressed in `targetPrimaries`.
 *
 * Layout: one little-endian uint32 per pixel — red in bits 0–9, green in 10–19,
 * blue in 20–29, alpha 30–31 (always 3, opaque). The values are PQ code values.
 *
 * Also returns the peak luminance, which is what `-L` gets: it is the headroom
 * at which the photograph is meant to be seen whole.
 */
async function decodeHdrIntent(tools, avif, info, targetPrimaries, work) {
  const source = PRIMARIES[info.primaries];
  const target = PRIMARIES[targetPrimaries];
  if (!source) {
    throw new Error(
      `HDR master has colour primaries ${info.primaries}, which this script has no matrix for ` +
        '(it knows BT.709, Display P3 and BT.2020). Re-export in Display P3 or sRGB',
    );
  }
  if (info.transfer !== 16) {
    throw new Error(
      `HDR master's transfer characteristic is ${info.transfer}, not 16 (PQ). Pair mode's ` +
        'luminance maths is PQ-specific — re-export the HDR AVIF as PQ, which is what ' +
        "Lightroom's HDR export writes by default",
    );
  }

  const png = join(work, 'hdr.png');
  await run(tools.avifdec, [avif, png], { maxBuffer: 1 << 28 });

  // toColourspace('rgb16') is REQUIRED — see the header. Without it sharp
  // interprets the pipeline as 8-bit sRGB and silently returns value >> 8.
  const { data, info: raw } = await sharp(png, { unlimited: true })
    .toColourspace('rgb16')
    .raw({ depth: 'ushort' })
    .toBuffer({ resolveWithObject: true });
  const samples = new Uint16Array(data.buffer, data.byteOffset, data.length / 2);

  const width = raw.width;
  const height = raw.height;
  const pixels = width * height;
  const words = new Uint32Array(pixels);

  const convert = source === target ? null : matMul(matInverse(target.toXyz), source.toXyz);
  const [lumR, lumG, lumB] = target.toXyz[1];
  let peakNits = 0;

  for (let index = 0; index < pixels; index += 1) {
    const base = index * raw.channels;
    // avifdec scales the 10-bit source across the full 16-bit range; rounding
    // back recovers the original codes exactly.
    let r = PQ_NITS[Math.round((samples[base] / 65535) * 1023)];
    let g = PQ_NITS[Math.round((samples[base + 1] / 65535) * 1023)];
    let b = PQ_NITS[Math.round((samples[base + 2] / 65535) * 1023)];

    if (convert) {
      const cr = convert[0][0] * r + convert[0][1] * g + convert[0][2] * b;
      const cg = convert[1][0] * r + convert[1][1] * g + convert[1][2] * b;
      const cb = convert[2][0] * r + convert[2][1] * g + convert[2][2] * b;
      // Colours outside the target gamut clip. The delivered rendition is in the
      // base's space either way, so this loses nothing the container could keep.
      r = Math.min(Math.max(cr, 0), 10000);
      g = Math.min(Math.max(cg, 0), 10000);
      b = Math.min(Math.max(cb, 0), 10000);
    }

    const luminance = lumR * r + lumG * g + lumB * b;
    if (luminance > peakNits) peakNits = luminance;

    const codeR = convert ? Math.round(nitsToPq(r) * 1023) : Math.round((samples[base] / 65535) * 1023);
    const codeG = convert ? Math.round(nitsToPq(g) * 1023) : Math.round((samples[base + 1] / 65535) * 1023);
    const codeB = convert ? Math.round(nitsToPq(b) * 1023) : Math.round((samples[base + 2] / 65535) * 1023);
    words[index] = (codeR | (codeG << 10) | (codeB << 20) | (3 << 30)) >>> 0;
  }

  return {
    buffer: Buffer.from(words.buffer, words.byteOffset, words.byteLength),
    width,
    height,
    peakNits,
    converted: Boolean(convert),
    sourceName: source.name,
    targetName: target.name,
  };
}

/* --- writing the JPEG ---------------------------------------------------- */

/** The libultrahdr metadata config file — see the mapping table in the header. */
function metadataConfig(metadata) {
  const exp2 = (value) => Math.pow(2, value).toFixed(6);
  const plain = (value) => value.toFixed(6);

  return (
    [
      `--maxContentBoost ${exp2(metadata.gainMapMaxLog2)}`,
      `--minContentBoost ${exp2(metadata.gainMapMinLog2)}`,
      `--gamma ${plain(metadata.gamma)}`,
      `--offsetSdr ${plain(metadata.offsetSdr)}`,
      `--offsetHdr ${plain(metadata.offsetHdr)}`,
      `--hdrCapacityMin ${exp2(metadata.baseHeadroomLog2)}`,
      `--hdrCapacityMax ${exp2(metadata.alternateHeadroomLog2)}`,
      `--useBaseColorSpace ${metadata.useBaseColorSpace ? 1 : 0}`,
    ].join('\n') + '\n'
  );
}

/**
 * CICP colour primaries → the ICC profile sharp can attach. Only consulted when
 * useBaseColorSpace is false, where libultrahdr requires the gain map JPEG to
 * name the alternate image's colour space with an embedded ICC.
 */
function iccForPrimaries(primaries) {
  if (primaries === 1) return 'srgb'; // BT.709 / sRGB
  if (primaries === 11 || primaries === 12) return 'p3'; // DCI-P3 / Display P3
  return null;
}

/**
 * ultrahdr_app reports most failures on stdout and still exits 0, so the only
 * reliable success test is whether the output file appeared. Everything it might
 * say that we can act on is turned into an actionable error here.
 */
async function assemble(tools, args, out, info) {
  const result = await run(tools.ultrahdr_app, args, { maxBuffer: 1 << 26 }).catch((error) => ({
    stdout: `${error?.stdout ?? ''}${error?.stderr ?? ''}`,
  }));

  if (await exists(out)) return;

  const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (/max width|max supported/i.test(stdout)) {
    throw new Error(
      `master is ${info.width}×${info.height}, larger than the 8192×8192 this ultrahdr_app was ` +
        'built for. Either export the master at the documented 2560px long edge, or rebuild ' +
        'libultrahdr with a higher cap:\n' +
        '        cmake -S . -B build -DUHDR_MAX_DIMENSION=16384 && cmake --build build\n' +
        '        then point ULTRAHDR_APP at build/ultrahdr_app',
    );
  }
  if (/color gamut .* does not match/i.test(stdout)) {
    throw new Error(
      `libultrahdr rejected the SDR master's declared colour gamut — ${stdout.trim()}. The SDR ` +
        'JPEG carries an ICC this script did not recognise; export it as sRGB or Display P3',
    );
  }
  throw new Error(`ultrahdr_app produced no output — ${stdout.trim() || 'no diagnostics'}`);
}

/**
 * The result must survive what photo-meta is about to do to it, which is a
 * stricter test than "sharp can see a gain map". A file whose gain map applies
 * in the alternate image's colour space reads fine here and then throws inside
 * `keepGainMap().resize()` — "gainmap image is expected to contain alternate
 * image color space in the form of ICC" — so the ladder, not the conversion, is
 * where it would surface. A 64px rehearsal costs milliseconds and moves that
 * failure back to the file that caused it.
 */
async function install(out, master) {
  const check = await sharp(out).metadata();
  if (!('gainMap' in check)) {
    throw new Error('assembled JPEG has no gain map that sharp can read — refusing to install it');
  }

  const rehearsal = await sharp(out)
    .keepGainMap()
    .resize({ width: 64 })
    .jpeg()
    .toBuffer()
    .catch((error) => {
      throw new Error(
        `the gain map does not survive the resize photo-meta will do (sharp: ${error.message}) — ` +
          'refusing to install a master whose ladder would fail',
      );
    });
  if (!('gainMap' in (await sharp(rehearsal).metadata()))) {
    throw new Error('the gain map is dropped by a keepGainMap() resize — refusing to install it');
  }

  await copyFile(out, master.jpg);
  const written = await stat(master.jpg);
  return { width: check.width, height: check.height, bytes: written.size };
}

/**
 * AVIF mode. avifdec hands back the authored base exactly as stored,
 * avifgainmaputil hands back the map, and ultrahdr_app copies both compressed
 * images into the output container verbatim (encoding scenario 4).
 */
async function convertFromAvif(tools, master, metadata, info, work) {
  const base = join(work, 'base.jpg');
  const gainMapPng = join(work, 'gainmap.png');
  const gainMapJpg = join(work, 'gainmap.jpg');
  const config = join(work, 'metadata.cfg');
  const out = join(work, 'out.jpg');

  await run(tools.avifdec, [master.avif, base, '-q', String(BASE_QUALITY)], { maxBuffer: 1 << 28 });
  await run(tools.avifgainmaputil, ['extractgainmap', master.avif, gainMapPng], { maxBuffer: 1 << 28 });

  // 4:4:4: the map is not a photograph, and chroma subsampling doubles its error.
  let encoder = sharp(gainMapPng).jpeg({ quality: GAINMAP_QUALITY, chromaSubsampling: '4:4:4' });
  if (!metadata.useBaseColorSpace) {
    const icc = iccForPrimaries(info.alternatePrimaries);
    if (!icc) {
      throw new Error(
        `the gain map is applied in the alternate image's colour space (colour primaries ` +
          `${info.alternatePrimaries ?? 'unknown'}), which needs an ICC profile this script ` +
          'cannot synthesise. Re-export with the base and HDR renditions in the same colour ' +
          'space (sRGB or Display P3) so the gain map applies in the base space',
      );
    }
    encoder = sharp(gainMapPng)
      .withIccProfile(icc)
      .jpeg({ quality: GAINMAP_QUALITY, chromaSubsampling: '4:4:4' });
  }
  const gainMapInfo = await encoder.toFile(gainMapJpg);
  await writeFile(config, metadataConfig(metadata), 'utf8');

  await assemble(tools, ['-m', '0', '-i', base, '-g', gainMapJpg, '-f', config, '-z', out], out, info);
  return { ...(await install(out, master)), gainMap: `${gainMapInfo.width}×${gainMapInfo.height}` };
}

/**
 * PAIR mode. The gain map is computed by libultrahdr from the two authored
 * intents (encoding scenario 3); the SDR JPEG goes into the container as-is.
 */
async function convertFromPair(tools, master, info, work) {
  const sdrMeta = await sharp(master.sdr).metadata();
  if (sdrMeta.width !== info.width || sdrMeta.height !== info.height) {
    throw new Error(
      `the two halves of this master disagree on size — ${master.stem}.avif is ` +
        `${info.width}×${info.height} but ${master.stem}${SDR_SUFFIX} is ` +
        `${sdrMeta.width}×${sdrMeta.height}. Re-export both at the same dimensions; a gain map ` +
        'is a per-pixel ratio and cannot be computed across two different rasters',
    );
  }
  // The tag does not survive the encode and keepGainMap() rules out the rotate()
  // that would bake it in, so photo-meta refuses a rotated HDR master downstream.
  // Saying so here names the file that has to be re-exported.
  if ((sdrMeta.orientation ?? 1) !== 1) {
    throw new Error(
      `EXIF orientation ${sdrMeta.orientation} on ${master.stem}${SDR_SUFFIX} — re-export with the ` +
        'rotation baked into the pixels (keepGainMap cannot be combined with rotate)',
    );
  }

  const targetPrimaries = await readSdrPrimaries(master.sdr);
  const hdr = await decodeHdrIntent(tools, master.avif, info, targetPrimaries, work);

  // hdrCapacityMax = L / 203 must come out strictly above hdrCapacityMin (1.0),
  // and a master whose brightest pixel is at or below SDR white has no HDR in it.
  if (hdr.peakNits <= SDR_WHITE_NITS * 1.02) {
    throw new Error(
      `the HDR master's peak luminance is ${hdr.peakNits.toFixed(0)} nits, at or below SDR white ` +
        `(${SDR_WHITE_NITS} nits) — there is no headroom to encode. Check that the AVIF really is ` +
        'the HDR export and not an SDR one saved as PQ',
    );
  }
  const targetPeak = Math.min(Math.round(hdr.peakNits), 10000);

  const hdrRaw = join(work, 'hdr.rgba1010102');
  const out = join(work, 'out.jpg');
  await writeFile(hdrRaw, hdr.buffer);

  const gamut = String(PRIMARIES[targetPrimaries].gamut);
  await assemble(
    tools,
    [
      '-m', '0',
      '-p', hdrRaw, '-a', '5', '-w', String(hdr.width), '-h', String(hdr.height),
      '-i', master.sdr,
      '-c', gamut, '-C', gamut, '-t', '2',
      '-L', String(targetPeak),
      '-s', String(GAINMAP_DOWNSAMPLE), '-M', '1', '-Q', String(GAINMAP_QUALITY), '-D', '1',
      '-z', out,
    ],
    out,
    info,
  );

  const installed = await install(out, master);
  return {
    ...installed,
    gainMap: `${Math.round(hdr.width / GAINMAP_DOWNSAMPLE)}×${Math.round(hdr.height / GAINMAP_DOWNSAMPLE)}`,
    detail:
      `peak ${targetPeak} nits (${(Math.log2(targetPeak / SDR_WHITE_NITS)).toFixed(2)} stops), ` +
      `${hdr.converted ? `${hdr.sourceName}→${hdr.targetName}` : hdr.targetName}`,
  };
}

/**
 * One master. Returns a short description of what was produced, or mode
 * 'awaiting' for the bare HDR AVIF whose SDR half has not been exported yet —
 * which is a normal state, not a failure: the exports land in batches and the
 * rest of the folder still has to build.
 */
async function convert(tools, master, work) {
  // Cheapest question first (a metadata read, no decode), so that a folder full
  // of masters still waiting for their SDR halves costs nothing per build.
  const metadata = tools.avifgainmaputil ? await readGainMapMetadata(tools, master.avif) : null;
  if (!metadata && !master.sdr) return { mode: 'awaiting' };

  const info = await readImageInfo(tools, master.avif);
  if (metadata) return { mode: 'avif', ...(await convertFromAvif(tools, master, metadata, info, work)) };
  return { mode: 'pair', ...(await convertFromPair(tools, master, info, work)) };
}

/* --- planning ------------------------------------------------------------ */

/**
 * What, if anything, each master needs. Deciding this up front is what lets the
 * tool check ask only for the tools the pending work actually uses, and what
 * turns "no SDR half yet" into a note rather than a failure — the exports arrive
 * in batches, and a half-delivered folder must still build.
 */
async function planFor(master, stamps) {
  if (!master.avif) {
    return {
      action: 'note',
      message:
        `${master.stem}${SDR_SUFFIX} has no ${master.stem}.avif beside it. An SDR export alone ` +
        'cannot become a gain-map JPEG: either add the HDR AVIF, or rename it to ' +
        `${master.stem}.jpg to publish it as the plain SDR photograph it is`,
    };
  }

  let source;
  try {
    source = await stampOf(master.avif);
  } catch {
    return { action: 'skip' }; // vanished between readdir and stat
  }
  const sdr = master.sdr ? await stampOf(master.sdr).catch(() => null) : null;
  const cached = stamps[master.key];
  const jpgThere = await exists(master.jpg);

  if (jpgThere && sameStamp(cached?.source, source) && sameStamp(cached?.sdr ?? null, sdr)) {
    const output = await stampOf(master.jpg).catch(() => null);
    if (sameStamp(cached?.output, output)) return { action: 'reuse', entry: cached };
  }

  // Fresh clone: the .jpg is committed, the stamp file is not. A .jpg at least as
  // new as both its inputs is taken as already converted.
  if (jpgThere && !cached) {
    const output = await stat(master.jpg).catch(() => null);
    const newest = Math.max(source.mtimeMs, sdr?.mtimeMs ?? 0);
    if (output && output.mtimeMs >= newest) {
      return {
        action: 'reuse',
        entry: { source, sdr, output: { mtimeMs: Math.round(output.mtimeMs), size: output.size } },
      };
    }
  }

  return { action: 'convert', source, sdr };
}

/* --- main --------------------------------------------------------------- */

async function main() {
  const started = Date.now();
  const masters = await findMasters();

  if (masters.length === 0) {
    // Silent on the common path: most runs have no AVIF masters at all.
    return;
  }

  const stamps = await readStamps();
  const plans = new Map();
  let pending = 0;
  for (const master of masters) {
    const plan = await planFor(master, stamps);
    plans.set(master.key, plan);
    if (plan.action === 'convert') pending += 1;
  }

  const notes = masters
    .filter((master) => plans.get(master.key).action === 'note')
    .map((master) => plans.get(master.key).message);

  const tools = {};
  const missing = [];
  if (pending > 0) {
    for (const name of Object.keys(TOOLS)) {
      const path = await findTool(name);
      if (path) tools[name] = path;
      else missing.push(name);
    }
  }

  // avifgainmaputil is only needed to *detect and unpack* a gain-map AVIF. Pair
  // mode never calls it, so its absence downgrades to "assume no gain map"
  // rather than stopping the run; avifdec and ultrahdr_app are load-bearing.
  const blocking = missing.filter((name) => name !== 'avifgainmaputil');
  if (pending > 0 && blocking.length > 0) {
    const installs = [...new Set(blocking.map((name) => TOOLS[name].install))];
    console.warn(
      `[convert-masters] ${pending} master(s) need conversion but skipping — ` +
        `missing ${blocking.join(', ')}.`,
    );
    for (const install of installs) console.warn(`[convert-masters]   ${install}`);
    console.warn(
      '[convert-masters] The converted .jpg masters are committed, so this is only a problem on ' +
        'the machine that adds new masters.',
    );
    return;
  }
  if (pending > 0 && missing.includes('avifgainmaputil')) {
    console.warn(
      '[convert-masters] avifgainmaputil not found — assuming every .avif is a bare HDR rendition ' +
        `and pairing it with its ${SDR_SUFFIX}. ${TOOLS.avifgainmaputil.install}`,
    );
  }

  const next = {};
  let converted = 0;
  let reused = 0;
  let awaiting = 0;
  const failures = [];

  for (const [index, master] of masters.entries()) {
    const plan = plans.get(master.key);
    if (plan.action === 'skip' || plan.action === 'note') continue;
    if (plan.action === 'reuse') {
      next[master.key] = plan.entry;
      reused += 1;
      continue;
    }

    const work = await mkdtemp(join(tmpdir(), 'convert-masters-'));
    const fileStarted = Date.now();
    try {
      const result = await convert(tools, master, work);

      if (result.mode === 'awaiting') {
        awaiting += 1;
        const already = (await exists(master.jpg)) && 'gainMap' in (await sharp(master.jpg).metadata());
        console.log(
          `[convert-masters] ${master.key} — ${already
            ? `${master.stem}.jpg is already a gain-map JPEG master; the .avif is redundant and can be deleted`
            : `awaiting SDR export (${master.stem}${SDR_SUFFIX})`}`,
        );
        continue;
      }

      next[master.key] = { source: plan.source, sdr: plan.sdr, output: await stampOf(master.jpg) };
      converted += 1;
      console.log(
        `[convert-masters] ${index + 1}/${masters.length} ${master.key} — ${result.mode} mode, ` +
          `${result.width}×${result.height}, gain map ${result.gainMap}, ` +
          `${mb(result.bytes)}${result.detail ? `, ${result.detail}` : ''}, ` +
          `${seconds(Date.now() - fileStarted)}`,
      );
    } catch (error) {
      failures.push(`${master.key}: ${error?.message ?? error}`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  await mkdir(dirname(STAMPS), { recursive: true });
  const sorted = Object.fromEntries(Object.keys(next).sort().map((key) => [key, next[key]]));
  await writeFile(STAMPS, `${JSON.stringify({ version: VERSION, masters: sorted }, null, 2)}\n`, 'utf8');

  console.log(
    `[convert-masters] ${masters.length} master(s): ${converted} converted, ${reused} already current` +
      `${awaiting ? `, ${awaiting} awaiting an SDR half` : ''}` +
      `${failures.length ? `, ${failures.length} failed` : ''} — ${seconds(Date.now() - started)}`,
  );
  for (const note of notes) console.warn('[convert-masters] NOTE —', note);
  for (const failure of failures) console.warn('[convert-masters] FAILED —', failure);
  if (failures.length > 0) {
    console.warn(
      '[convert-masters] A master that fails here produces no .jpg, so photo-meta will not see it ' +
        'and it will not appear on the site.',
    );
  }
}

main().catch((error) => {
  console.error('[convert-masters] failed —', error?.stack ?? error);
  process.exit(1);
});
