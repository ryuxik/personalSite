/**
 * src/lib/photos.ts — the one place the Overview stream is assembled.
 *
 * Joins three sources:
 *   1. the `shoots` content collection (frontmatter, see src/content.config.ts)
 *   2. the images sitting next to each index.md, imported through
 *      `import.meta.glob` so astro:assets can optimise them
 *   3. src/generated/photo-meta.json, written by scripts/photo-meta.mjs
 *      (dimensions, thumbhash, average colour, EXIF)
 *
 * Every meta lookup degrades gracefully: if photo-meta.json is empty — a fresh
 * clone before `npm run generate`, say — dimensions fall back to the intrinsic
 * values astro:assets already knows and the thumbhash is simply absent.
 */
import { getCollection, type CollectionEntry } from 'astro:content';
import type { ImageMetadata } from 'astro';
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

export interface PhotoMeta {
  width: number;
  height: number;
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

/** One frame in the stream: the optimisable source plus its sidecar metadata. */
export interface StreamImage {
  /** "<slug>/<file>", e.g. "oaxaca-portraits/001.jpg" — the photo-meta key. */
  key: string;
  /** Bare filename; filename order is display order. */
  file: string;
  /** Pass straight to <Image>/<Picture> `src`. */
  src: ImageMetadata;
  width: number;
  height: number;
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

const SHOOTS_ROOT = '/src/content/shoots/';

/**
 * Eager glob so the whole stream is resolvable synchronously at build time.
 * The pattern must stay a literal — Vite reads it statically.
 */
const IMAGE_MODULES = import.meta.glob<{ default: ImageMetadata }>(
  '/src/content/shoots/*/*.{jpg,jpeg,png,JPG,JPEG,PNG}',
  { eager: true },
);

/** slug -> [{ file, src }, …] in filename order. */
const IMAGES_BY_SLUG: Map<string, { file: string; src: ImageMetadata }[]> = (() => {
  const map = new Map<string, { file: string; src: ImageMetadata }[]>();

  for (const [path, mod] of Object.entries(IMAGE_MODULES)) {
    const relative = path.startsWith(SHOOTS_ROOT) ? path.slice(SHOOTS_ROOT.length) : path;
    const slash = relative.indexOf('/');
    if (slash < 0) continue;

    const slug = relative.slice(0, slash);
    const file = relative.slice(slash + 1);
    // Only direct children — no nested folders of outtakes.
    if (file.includes('/')) continue;

    const list = map.get(slug);
    if (list) list.push({ file, src: mod.default });
    else map.set(slug, [{ file, src: mod.default }]);
  }

  for (const list of map.values()) {
    list.sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true }));
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

/** A shoot's images in filename order, joined with their generated metadata. */
export function getShootImages(shoot: Shoot): StreamImage[] {
  const files = IMAGES_BY_SLUG.get(shoot.id) ?? [];

  return files.map(({ file, src }, index) => {
    const key = `${shoot.id}/${file}`;
    const meta = META[key];

    return {
      key,
      file,
      src,
      width: meta?.width ?? src.width,
      height: meta?.height ?? src.height,
      color: meta?.color ?? 'transparent',
      thumbhash: meta?.thumbhash,
      exif: meta?.exif,
      alt: altFor(shoot, index, files.length),
    };
  });
}

/** Sidecar metadata for one image, by "<slug>/<file>" key. */
export function getPhotoMeta(key: string): PhotoMeta | undefined {
  return META[key];
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
