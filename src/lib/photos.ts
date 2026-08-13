/**
 * src/lib/photos.ts — the one place the Overview stream is assembled.
 *
 * Joins two sources:
 *   1. the `shoots` content collection (frontmatter, see src/content.config.ts)
 *   2. src/generated/photo-meta.json, written by scripts/photo-meta.mjs
 *      (dimensions, HDR flag, delivery ladder, thumbhash, average colour, EXIF)
 *
 * NOTE — no astro:assets here, on purpose. The masters are HDR gain-map JPEGs
 * and getImage()/<Picture> strip the gain map, so every stream frame is served
 * from the static ladder in public/photos/ that photo-meta.mjs pre-generates.
 * That makes photo-meta.json the source of truth for *which* images exist: an
 * image with no ladder cannot be rendered, so it is not part of the stream.
 *
 * Consequence: `npm run photo-meta` (which `predev`/`prebuild` run for you) must
 * have run at least once, or the stream is empty rather than broken.
 */
import { getCollection, type CollectionEntry } from 'astro:content';
import photoMetaFile from '../generated/photo-meta.json';

export type Shoot = CollectionEntry<'shoots'>;

export interface PhotoExif {
  camera?: string;
  lens?: string;
  focalLength?: string;
  aperture?: string;
  shutter?: string;
  iso?: number;
}

/** One rung of the delivery ladder. Paths are site-absolute public URLs. */
export interface PhotoRung {
  /** Rendered pixel width — the `w` descriptor in the srcset. */
  w: number;
  h: number;
  /** HDR gain-map JPEG for an HDR master; a plain JPEG for an SDR one. */
  jpg: string;
  /** SDR AVIF, for displays and browsers that get the SDR rendition anyway. */
  avif: string;
}

export interface PhotoMeta {
  width: number;
  height: number;
  /** Master carries an ISO 21496-1 gain map, so the jpg rungs are HDR. */
  isHDR: boolean;
  /** Ascending by width; never empty for an image that made it into the file. */
  ladder: PhotoRung[];
  /** Average colour, "#rrggbb" — the background under the thumbhash. */
  color: string;
  /** base64 PNG data-URI, painted as a CSS background while the file loads. */
  thumbhash: string;
  exif?: PhotoExif;
  /** mtime + size stamp used by the generator's incremental cache. */
  source?: { mtimeMs: number; size: number };
}

interface PhotoMetaFile {
  version: number;
  photos: Record<string, PhotoMeta>;
}

/**
 * The JSON is generated, so its literal shape swings between "empty" and "full"
 * depending on whether the prebuild step has run. Casting once here keeps that
 * churn out of every call site.
 */
const META: Record<string, PhotoMeta> = (photoMetaFile as unknown as PhotoMetaFile).photos ?? {};

/** One frame in the stream: the ladder plus its sidecar metadata. */
export interface StreamImage {
  /** "<slug>/<file>", e.g. "oaxaca-portraits/001.jpg" — the photo-meta key. */
  key: string;
  /** Bare filename; filename order is display order. */
  file: string;
  /** Intrinsic size of the master — drives the aspect-ratio box. */
  width: number;
  height: number;
  isHDR: boolean;
  ladder: PhotoRung[];
  color: string;
  thumbhash?: string;
  exif?: PhotoExif;
  alt: string;
}

/** One shoot as the stream renders it. */
export interface StreamEntry {
  shoot: Shoot;
  images: StreamImage[];
  /** "Marisol A. for Atelier Mora · Mar '26" */
  caption: string;
}

/** slug -> ["001.jpg", "002.jpg", …] in filename order, from the generated meta. */
const FILES_BY_SLUG: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();

  for (const key of Object.keys(META)) {
    const slash = key.indexOf('/');
    if (slash < 0) continue;

    const slug = key.slice(0, slash);
    const file = key.slice(slash + 1);
    // Only direct children — no nested folders of outtakes.
    if (file.includes('/')) continue;

    const list = map.get(slug);
    if (list) list.push(file);
    else map.set(slug, [file]);
  }

  for (const list of map.values()) {
    list.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }

  return map;
})();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Mar '26". Read in UTC: `date: 2026-03-01` parses to UTC midnight, which is
 * still February in any negative-offset timezone.
 */
export function formatMonthYear(date: Date): string {
  const month = MONTHS[date.getUTCMonth()] ?? '';
  const year = String(date.getUTCFullYear() % 100).padStart(2, '0');
  return `${month} '${year}`;
}

/**
 * The stream caption, per SPEC.md § Content model:
 *   `{subject}{client ? ` for ${client}` : ""} · {Mon 'YY}`
 */
export function formatCaption(shoot: Shoot): string {
  const { subject, client, date } = shoot.data;
  const credit = client ? `${subject} for ${client}` : subject;
  return `${credit} · ${formatMonthYear(date)}`;
}

/** Stream order: date desc, then featured desc, then slug for a stable tail. */
function compareShoots(a: Shoot, b: Shoot): number {
  const byDate = b.data.date.getTime() - a.data.date.getTime();
  if (byDate !== 0) return byDate;

  const byFeatured = b.data.featured - a.data.featured;
  if (byFeatured !== 0) return byFeatured;

  return a.id.localeCompare(b.id);
}

/** All shoots, already in stream order. */
export async function getShoots(): Promise<Shoot[]> {
  const shoots = await getCollection('shoots');
  return [...shoots].sort(compareShoots);
}

/**
 * TODO(ryu): real alt text per frame once the placeholders are replaced —
 * describe what is in the photograph, not just who it is of. Until then this
 * derives something honest and unique from the frontmatter.
 */
function altFor(shoot: Shoot, index: number, total: number): string {
  const { subject, title, location } = shoot.data;
  const where = location ? `, ${location}` : '';
  const frame = total > 1 ? ` — frame ${index + 1} of ${total}` : '';
  return `${subject} — ${title}${where}${frame}`;
}

/**
 * The rung a plain <img src> should point at: the largest one at or below
 * `target`, so the no-srcset fallback is a sensible middle size rather than the
 * 2048 master. Falls back to the smallest rung for a very small image.
 */
export function fallbackRung(ladder: PhotoRung[], target = 1400): PhotoRung | undefined {
  if (ladder.length === 0) return undefined;
  const under = ladder.filter((rung) => rung.w <= target);
  return under.length > 0 ? under[under.length - 1] : ladder[0];
}

/** `srcset` for one format of a ladder: "/photos/a/001-900.jpg 900w, …". */
export function srcsetFor(ladder: PhotoRung[], format: 'jpg' | 'avif'): string {
  return ladder.map((rung) => `${rung[format]} ${rung.w}w`).join(', ');
}

/**
 * A shoot's images in filename order, joined with their generated metadata.
 * Images without a usable ladder are dropped: there is nothing to render.
 */
export function getShootImages(shoot: Shoot): StreamImage[] {
  const files = FILES_BY_SLUG.get(shoot.id) ?? [];

  return files
    .map((file, index): StreamImage | undefined => {
      const key = `${shoot.id}/${file}`;
      const meta = META[key];
      if (!meta || !Array.isArray(meta.ladder) || meta.ladder.length === 0) return undefined;

      return {
        key,
        file,
        width: meta.width,
        height: meta.height,
        isHDR: meta.isHDR === true,
        ladder: meta.ladder,
        color: meta.color ?? 'transparent',
        thumbhash: meta.thumbhash,
        exif: meta.exif,
        alt: altFor(shoot, index, files.length),
      };
    })
    .filter((image): image is StreamImage => image !== undefined);
}

/** Sidecar metadata for one image, by "<slug>/<file>" key. */
export function getPhotoMeta(key: string): PhotoMeta | undefined {
  return META[key];
}

/** Every "<slug>/<file>" key the generator knows about, in filename order. */
export function getPhotoKeys(slug: string): string[] {
  return (FILES_BY_SLUG.get(slug) ?? []).map((file) => `${slug}/${file}`);
}

/**
 * The whole stream, ready to render: shoots in order, each with its images and
 * its single caption line. Shoots with no images yet are dropped rather than
 * rendered as a bare caption.
 */
export async function getStream(): Promise<StreamEntry[]> {
  const shoots = await getShoots();

  return shoots
    .map((shoot) => ({
      shoot,
      images: getShootImages(shoot),
      caption: formatCaption(shoot),
    }))
    .filter((entry) => entry.images.length > 0);
}
