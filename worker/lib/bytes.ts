/**
 * Byte-level helpers for upload verification — pure JS so the WORKER can
 * enforce what the ingest CLI used to enforce only client-side (2026-08-26:
 * added for the browser ingest path; gates now protect BOTH paths centrally).
 */

/** CRC-32 (IEEE), table-based. ~100ms on a 25MB master — cheap insurance
 * that the declared checksum matches what actually landed. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ISO_MARKER = 'urn:iso:std:iso:ts:21496:-1';

/** Does this JPEG carry an ISO 21496-1 gain map? (Marker lives in an APP2
 * segment near the head — scanning the first 256KB is sufficient and cheap.) */
export function hasIsoGainMap(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 262144);
  const needle = ISO_MARKER;
  outer: for (let i = 0; i <= limit - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}
