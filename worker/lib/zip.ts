/**
 * Streaming STORE-mode zip for gallery downloads.
 *
 * HEIC and JPEG do not compress, so every entry is STORE (method 0) and the
 * only real CPU in a zip is the CRC32 over every byte — which we refuse to
 * spend: the ingest CLI computed each file's CRC32 once, on the Mac, and it
 * lives in D1 (assets.crc32). The Worker writes headers from the database and
 * interleaves R2 body streams. Consequences (review § R4): no async
 * "preparing your download" machinery, near-zero CPU, flat memory — and
 * because sizes are known up front, an exact Content-Length so the browser
 * shows real progress on a 700 MB zip.
 *
 * Plain zip32: local headers carry size + CRC (no data descriptors), UTF-8
 * names flagged. Guard rails: ≤ 3.8 GB total, ≤ 60 000 entries — a v1 gallery
 * is ~90 photos, far inside both.
 */

export interface ZipEntry {
  name: string;
  bytes: number;
  crc32: number; // unsigned
  open(): Promise<ReadableStream<Uint8Array>>;
}

const LOCAL_OVERHEAD = 30;
const CENTRAL_OVERHEAD = 46;
const EOCD = 22;
const ZIP_MAX_BYTES = 3.8 * 1024 ** 3;
const ZIP_MAX_ENTRIES = 60_000;

const enc = new TextEncoder();

export function zipTotalSize(entries: ZipEntry[]): number {
  let total = EOCD;
  for (const e of entries) {
    const n = enc.encode(e.name).length;
    total += LOCAL_OVERHEAD + n + e.bytes + CENTRAL_OVERHEAD + n;
  }
  return total;
}

export function zipTooLarge(entries: ZipEntry[]): string | null {
  if (entries.length > ZIP_MAX_ENTRIES) return `too many files (${entries.length})`;
  const total = zipTotalSize(entries);
  if (total > ZIP_MAX_BYTES) return `zip would be ${(total / 1024 ** 3).toFixed(1)} GB — over the 3.8 GB cap`;
  return null;
}

/* DOS date/time from a JS Date — zips have no better clock. */
function dosDateTime(d: Date): { date: number; time: number } {
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

function u16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function u32(v: number): number[] { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

const FLAG_UTF8 = 0x0800;

export function streamZip(entries: ZipEntry[], now: Date): ReadableStream<Uint8Array> {
  const { date, time } = dosDateTime(now);
  let index = 0;
  let offset = 0;
  const central: number[] = [];
  let bodyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Drain the current entry's body first.
      if (bodyReader) {
        const { done, value } = await bodyReader.read();
        if (!done && value) {
          offset += value.length;
          controller.enqueue(value);
          return;
        }
        bodyReader = null;
      }
      if (index < entries.length) {
        const e = entries[index++];
        const name = enc.encode(e.name);
        const header = new Uint8Array([
          ...u32(0x04034b50), ...u16(20), ...u16(FLAG_UTF8), ...u16(0), // STORE
          ...u16(time), ...u16(date), ...u32(e.crc32 >>> 0),
          ...u32(e.bytes), ...u32(e.bytes), ...u16(name.length), ...u16(0),
          ...name,
        ]);
        central.push(
          ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(FLAG_UTF8), ...u16(0),
          ...u16(time), ...u16(date), ...u32(e.crc32 >>> 0),
          ...u32(e.bytes), ...u32(e.bytes), ...u16(name.length), ...u16(0), ...u16(0),
          ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
          ...name
        );
        offset += header.length;
        controller.enqueue(header);
        bodyReader = (await e.open()).getReader();
        return;
      }
      if (!finished) {
        finished = true;
        const dir = new Uint8Array(central);
        const eocd = new Uint8Array([
          ...u32(0x06054b50), ...u16(0), ...u16(0),
          ...u16(entries.length), ...u16(entries.length),
          ...u32(dir.length), ...u32(offset), ...u16(0),
        ]);
        controller.enqueue(dir);
        controller.enqueue(eocd);
        controller.close();
      }
    },
    cancel() {
      bodyReader?.cancel().catch(() => {});
    },
  });
}
