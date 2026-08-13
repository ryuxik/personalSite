#!/usr/bin/env node
/**
 * scripts/check-hdr.mjs — does this file actually carry an HDR gain map?
 *
 *   node scripts/check-hdr.mjs ~/Desktop/portfolio-picks/DSC_1234.jpg
 *   node scripts/check-hdr.mjs ~/Desktop/portfolio-picks      # table for a folder
 *   node scripts/check-hdr.mjs public/photos                  # audit the built ladder
 *
 * Two independent readings, because they fail in different ways:
 *
 *   1. sharp/libvips metadata — the same `'gainMap' in metadata` test that
 *      scripts/photo-meta.mjs uses to decide HDR vs SDR. This is the one that
 *      matters for the build.
 *   2. A byte-level walk of the JPEG marker segments: every APPn segment and its
 *      identifier string, the MPF (Multi-Picture Format) index that points at the
 *      appended gain-map image, that second image's own dimensions and markers,
 *      and the hdrgm:* fields in the XMP packet.
 *
 * Reading 2 is what tells you *why* reading 1 said no — a Lightroom export with
 * "HDR Output" off has no MPF index at all, while one that was re-saved by a
 * stripping tool often still has the XMP but no second image.
 *
 * Exit code is 0 for a readable file (HDR or not) and 1 only when nothing could
 * be read, so this is safe to use in a shell pipeline.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import sharp from 'sharp';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.avif', '.webp', '.heic', '.heif', '.tif', '.tiff']);
const JPEG_EXT = new Set(['.jpg', '.jpeg']);

/* --- JPEG marker walk --------------------------------------------------- */

const APP_NAMES = {
  0xc0: 'SOF0', 0xc1: 'SOF1', 0xc2: 'SOF2', 0xc3: 'SOF3',
  0xc4: 'DHT', 0xc9: 'SOF9', 0xca: 'SOF10', 0xcc: 'DAC',
  0xdb: 'DQT', 0xdd: 'DRI', 0xda: 'SOS', 0xfe: 'COM',
};

const markerName = (marker) =>
  marker >= 0xe0 && marker <= 0xef ? `APP${marker - 0xe0}` : (APP_NAMES[marker] ?? `0x${marker.toString(16)}`);

const isSof = (marker) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** Leading NUL-terminated ASCII identifier of a segment body ("Exif", "MPF", …). */
function identifier(body) {
  const end = Math.min(body.length, 64);
  let text = '';
  for (let i = 0; i < end; i += 1) {
    const byte = body[i];
    if (byte === 0x00) break;
    if (byte < 0x20 || byte > 0x7e) return text; // binary — stop, keep what we have
    text += String.fromCharCode(byte);
  }
  return text;
}

/**
 * Walk one JPEG's marker segments starting at `start`. Stops at SOS (entropy
 * data follows, and the MPF index tells us where the next image begins anyway).
 */
function walkJpeg(buffer, start = 0) {
  if (buffer.length < start + 4 || buffer.readUInt16BE(start) !== 0xffd8) return null;

  const segments = [];
  let size = null;
  let offset = start + 2;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1; // padding / resync
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // standalone marker, no length
      continue;
    }
    if (marker === 0xd9) break; // EOI

    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;

    const body = buffer.subarray(offset + 4, offset + 2 + length);
    segments.push({ marker, name: markerName(marker), at: offset, length, body, id: identifier(body) });

    if (isSof(marker) && body.length >= 5) {
      size = { height: body.readUInt16BE(1), width: body.readUInt16BE(3) };
    }
    if (marker === 0xda) break; // SOS — scan data from here

    offset += 2 + length;
  }

  return { segments, size };
}

/**
 * The MPF index: how many images are concatenated into this file and where each
 * one starts. An HDR gain-map JPEG is exactly this — primary image plus the gain
 * map appended as a second JPEG.
 */
function parseMpf(segment) {
  // body = "MPF\0" then a TIFF header; all offsets are relative to that header.
  const tiff = segment.body.subarray(4);
  if (tiff.length < 8) return null;

  const little = tiff.readUInt16BE(0) === 0x4949;
  const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 0x002a) return null;

  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;

  const count = u16(ifd);
  let images = null;
  let entriesAt = null;

  for (let i = 0; i < count; i += 1) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > tiff.length) break;
    const tag = u16(at);
    const size = u32(at + 4);
    const value = u32(at + 8);
    if (tag === 0xb001) images = value; // NumberOfImages
    if (tag === 0xb002) entriesAt = { offset: value, bytes: size }; // MPEntry
  }

  const entries = [];
  if (entriesAt) {
    const total = Math.floor(entriesAt.bytes / 16);
    for (let i = 0; i < total; i += 1) {
      const at = entriesAt.offset + i * 16;
      if (at + 16 > tiff.length) break;
      entries.push({
        attribute: u32(at),
        size: u32(at + 4),
        // 0 means "this image starts at the file's SOI"; anything else is
        // relative to the first byte of the MP header (the TIFF header).
        offset: u32(at + 8),
      });
    }
  }

  // Absolute file offset of the TIFF header, so entry offsets can be resolved.
  return { images: images ?? entries.length, entries, headerAt: segment.at + 4 + 4 };
}

/** hdrgm:* / HDR-ish fields out of an XMP packet, plus the namespaces present. */
function readXmp(segments) {
  const packets = segments
    .filter((segment) => segment.marker === 0xe1 && segment.id.startsWith('http://ns.adobe.com/x'))
    .map((segment) => segment.body.toString('latin1'));
  if (packets.length === 0) return null;

  const text = packets.join('\n');
  const fields = [...text.matchAll(/\b(hdrgm:[A-Za-z]+)\s*=\s*"([^"]*)"/g)].map(
    ([, key, value]) => `${key}="${value}"`,
  );
  // Some writers use elements rather than attributes.
  const elements = [...text.matchAll(/<(hdrgm:[A-Za-z]+)>([^<]*)</g)].map(
    ([, key, value]) => `${key}=${value.trim()}`,
  );
  const namespaces = [...new Set([...text.matchAll(/xmlns:([A-Za-z0-9_]+)="([^"]+)"/g)].map(([, ns]) => ns))];

  return { fields: [...fields, ...elements], namespaces, hasGainMapNs: /hdr-gain-map/.test(text) };
}

/* --- one file ----------------------------------------------------------- */

async function inspect(path) {
  const buffer = await readFile(path);
  const report = { path, bytes: buffer.length };

  try {
    const metadata = await sharp(buffer).metadata();
    report.sharp = metadata;
    report.isHDR = 'gainMap' in metadata;
    report.gainMap = metadata.gainMap;

    // The map is handed back as an encoded image; its resolution is often half
    // the base's, and it must scale with the base through the ladder.
    if (Buffer.isBuffer(metadata.gainMap?.image)) {
      try {
        const map = await sharp(metadata.gainMap.image).metadata();
        report.mapSize = { width: map.width, height: map.height };
      } catch {
        /* not separately decodable — the MPF walk below still reports it */
      }
    }
  } catch (error) {
    report.sharpError = error?.message ?? String(error);
    report.isHDR = false;
  }

  if (JPEG_EXT.has(extname(path).toLowerCase())) {
    const primary = walkJpeg(buffer, 0);
    if (primary) {
      report.primary = primary;
      report.xmp = readXmp(primary.segments);

      const mpfSegment = primary.segments.find((segment) => segment.marker === 0xe2 && segment.id === 'MPF');
      if (mpfSegment) {
        const mpf = parseMpf(mpfSegment);
        report.mpf = mpf;

        // Every image after the first — for a gain-map JPEG that is the map itself.
        report.extra = (mpf?.entries ?? []).slice(1).map((entry) => {
          const at = mpf.headerAt + entry.offset;
          const walk = walkJpeg(buffer, at);
          return { at, bytes: entry.size, size: walk?.size, segments: walk?.segments ?? [] };
        });
      }

      report.isoMarker = primary.segments.some((segment) => segment.id.includes('iso:ts:21496'))
        ? 'primary'
        : (report.extra ?? []).some((extra) => extra.segments.some((segment) => segment.id.includes('iso:ts:21496')))
          ? 'gain map image'
          : null;
    }
  }

  return report;
}

/* --- output ------------------------------------------------------------- */

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

function printOne(report) {
  const meta = report.sharp ?? {};
  console.log(`\n${report.path}`);
  console.log(`  file       ${kb(report.bytes)}`);

  if (report.sharpError) {
    console.log(`  sharp      UNREADABLE — ${report.sharpError}`);
  } else {
    console.log(
      `  sharp      ${meta.format} ${meta.width}×${meta.height}, ${meta.space}, ${meta.channels}ch, ` +
        `orientation ${meta.orientation ?? 1}, icc ${meta.hasProfile ? 'yes' : 'no'}` +
        `${meta.chromaSubsampling ? `, ${meta.chromaSubsampling}` : ''}`,
    );
  }

  console.log(`  GAIN MAP   ${report.isHDR ? 'PRESENT — sharp reports HDR' : 'absent — this file is SDR'}`);
  if (report.gainMap && typeof report.gainMap === 'object') {
    // The field carries the map as a raw buffer — summarise it, never dump it.
    const fields = Object.entries(report.gainMap).map(([key, value]) =>
      Buffer.isBuffer(value) ? `${key}=<${value.length} B>` : `${key}=${JSON.stringify(value)}`,
    );
    console.log(`  sharp map  ${fields.join(', ')}`);
    if (report.mapSize) console.log(`  map pixels ${report.mapSize.width}×${report.mapSize.height}`);
  }

  if (report.primary) {
    const apps = report.primary.segments
      .filter((segment) => segment.marker >= 0xe0 && segment.marker <= 0xef)
      .map((segment) => `${segment.name}${segment.id ? ` "${segment.id}"` : ''} (${segment.length} B)`);
    console.log(`  segments   ${apps.length ? apps.join(', ') : 'none'}`);
    if (report.primary.size) {
      console.log(`  SOF        ${report.primary.size.width}×${report.primary.size.height}`);
    }
  }

  if (report.mpf) {
    console.log(`  MPF        ${report.mpf.images} image(s) in the container`);
    report.mpf.entries.forEach((entry, index) => {
      console.log(
        `             [${index}] ${kb(entry.size)} @ +${entry.offset}` +
          `${index === 0 ? ' (primary)' : ''} attr 0x${entry.attribute.toString(16)}`,
      );
    });
  } else if (report.primary) {
    console.log('  MPF        none — no appended image, so no gain map');
  }

  for (const [index, extra] of (report.extra ?? []).entries()) {
    const ids = extra.segments
      .filter((segment) => segment.marker >= 0xe0 && segment.marker <= 0xef)
      .map((segment) => `${segment.name}${segment.id ? ` "${segment.id}"` : ''}`);
    console.log(
      `  image ${index + 2}    ${extra.size ? `${extra.size.width}×${extra.size.height}` : 'unparsed'}` +
        ` at byte ${extra.at}, ${kb(extra.bytes)}${ids.length ? ` — ${ids.join(', ')}` : ''}`,
    );
  }

  if (report.isoMarker) {
    console.log(`  ISO 21496  marker found in the ${report.isoMarker}`);
  } else if (report.primary) {
    console.log('  ISO 21496  no urn:iso:std:iso:ts:21496:-1 marker');
  }

  if (report.xmp) {
    console.log(`  XMP        ns: ${report.xmp.namespaces.join(', ') || 'none'}`);
    if (report.xmp.fields.length) console.log(`             ${report.xmp.fields.join('  ')}`);
    if (!report.xmp.hasGainMapNs) console.log('             (no hdr-gain-map namespace)');
  } else if (report.primary) {
    console.log('  XMP        none');
  }
}

function printTable(reports) {
  const rows = reports.map((report) => ({
    file: report.label,
    size: report.sharp ? `${report.sharp.width}×${report.sharp.height}` : '—',
    hdr: report.isHDR ? 'HDR' : 'sdr',
    map: (() => {
      const size = report.mapSize ?? report.extra?.[0]?.size;
      return size ? `${size.width}×${size.height}` : '—';
    })(),
    mpf: report.mpf ? String(report.mpf.images) : '—',
    iso: report.isoMarker ? 'yes' : '—',
    bytes: kb(report.bytes),
  }));

  const columns = ['file', 'size', 'hdr', 'map', 'mpf', 'iso', 'bytes'];
  const width = Object.fromEntries(
    columns.map((column) => [column, Math.max(column.length, ...rows.map((row) => row[column].length))]),
  );
  const line = (row) => columns.map((column) => String(row[column]).padEnd(width[column])).join('  ');

  console.log(line(Object.fromEntries(columns.map((column) => [column, column.toUpperCase()]))));
  console.log(columns.map((column) => '-'.repeat(width[column])).join('  '));
  for (const row of rows) console.log(line(row));

  const hdr = reports.filter((report) => report.isHDR).length;
  console.log(`\n${reports.length} image(s): ${hdr} with a gain map, ${reports.length - hdr} SDR.`);
}

/* --- main --------------------------------------------------------------- */

async function collect(dir) {
  const found = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && IMAGE_EXT.has(extname(entry.name).toLowerCase())) found.push(path);
    }
  }
  await visit(dir);
  return found;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/check-hdr.mjs <file|directory>');
    process.exit(1);
  }

  const path = resolve(process.cwd(), target);
  let info;
  try {
    info = await stat(path);
  } catch {
    console.error(`check-hdr: no such file or directory — ${path}`);
    process.exit(1);
  }

  if (info.isFile()) {
    printOne(await inspect(path));
    return;
  }

  const files = await collect(path);
  if (files.length === 0) {
    console.log(`check-hdr: no images under ${path}`);
    return;
  }

  const reports = [];
  for (const file of files) {
    try {
      const report = await inspect(file);
      report.label = relative(path, file) || basename(file);
      reports.push(report);
    } catch (error) {
      console.warn(`check-hdr: skipped ${file} — ${error?.message ?? error}`);
    }
  }

  if (reports.length === 0) process.exit(1);
  printTable(reports);
}

main().catch((error) => {
  console.error('check-hdr: failed —', error?.stack ?? error);
  process.exit(1);
});
