import type { APIRoute } from 'astro';
import { getImage } from 'astro:assets';
import { getCollection } from 'astro:content';
import { SITE } from '../config';

/**
 * /image-sitemap.xml — Google image sitemap. Owned by Agent D (SPEC.md § Information page + SEO).
 *
 * Complements @astrojs/sitemap (which emits /sitemap-index.xml for pages only).
 * Both are advertised in public/robots.txt.
 *
 * WHY getImage() AND NOT A HAND-WRITTEN PATH
 * ------------------------------------------
 * astro:assets fingerprints every derivative (/_astro/001.CxK3p_1600.webp), so the
 * final URL is not knowable from source. Chasing it with string templates would rot
 * the first time a file changes. getImage() runs inside the endpoint at build time and
 * returns the same URL the build actually emits, so the sitemap can never point at a
 * 404. It also *creates* the derivative, which means every URL here is guaranteed to
 * exist in dist/ even if no page happens to render that exact variant.
 *
 * WHICH IMAGES
 * ------------
 * Every image in every shoot folder — the whole stream, not just covers — discovered
 * with import.meta.glob rather than through src/lib/photos.ts, so this endpoint has no
 * build-order dependency on Agent B's helpers and degrades to "no images" instead of
 * failing when the collection is empty or mid-write.
 *
 * OG cards (public/og/*.jpg) are deliberately NOT listed. An image sitemap describes
 * images that appear *on* the page; the OG cards never render in the document, they are
 * already declared in <meta property="og:image">, and listing them would put three
 * near-identical wordmark cards into image search. When the shoots collection is empty
 * this file therefore emits three bare <url> entries and no <image:image> blocks at all.
 *
 * Titles use the stream caption format from SPEC: "{subject} for {client} · Mon 'YY".
 */

export const prerender = true;

/** Site-relative page URLs, trailing slash to match what @astrojs/sitemap emits. */
const PAGES = ['/', '/sessions/', '/information/'] as const;

/**
 * Widest step of the configured breakpoints. Clamped to each image's intrinsic width at use
 * so a portrait frame is never upscaled into a bigger, worse file just for the sitemap —
 * and so the requested transform is more likely to be one the page already emitted.
 */
const SITEMAP_IMAGE_WIDTH = 1600;

type ShootImage = { file: string; image: ImageMetadata };

const imageModules = import.meta.glob<{ default: ImageMetadata }>(
  '../content/shoots/*/*.{jpg,jpeg,JPG,JPEG,png,PNG,webp,avif}',
  { eager: true },
);

/** Group globbed files by shoot slug; filename order is display order (SPEC § Content model). */
function groupBySlug(): Map<string, ShootImage[]> {
  const bySlug = new Map<string, ShootImage[]>();

  for (const [path, mod] of Object.entries(imageModules)) {
    const match = path.match(/\/shoots\/([^/]+)\/([^/]+)$/);
    if (!match) continue;
    const [, slug, file] = match;
    const list = bySlug.get(slug) ?? [];
    list.push({ file, image: mod.default });
    bySlug.set(slug, list);
  }

  for (const list of bySlug.values()) {
    list.sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true }));
  }

  return bySlug;
}

/** "{subject} for {client} · Mar '26" — the stream caption, verbatim. */
function caption(data: { subject: string; client?: string; date: Date }): string {
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(data.date);
  const year = String(data.date.getUTCFullYear()).slice(-2);
  const client = data.client ? ` for ${data.client}` : '';
  return `${data.subject}${client} · ${month} '${year}`;
}

const escapeXml = (value: string): string =>
  value.replace(
    /[<>&"']/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] ?? char,
  );

const absolute = (path: string): string => new URL(path, SITE.url).href;

async function streamImages(): Promise<{ loc: string; title: string }[]> {
  let shoots;
  try {
    shoots = await getCollection('shoots');
  } catch (error) {
    // Empty or mid-write collection must not fail the build; the sitemap just has no images.
    console.warn('[image-sitemap] shoots collection unavailable —', (error as Error)?.message ?? error);
    return [];
  }

  // Stream order: date desc, then featured desc.
  const ordered = [...shoots].sort(
    (a, b) =>
      b.data.date.getTime() - a.data.date.getTime() ||
      b.data.featured - a.data.featured ||
      a.id.localeCompare(b.id),
  );

  const bySlug = groupBySlug();
  const entries: { loc: string; title: string }[] = [];

  for (const shoot of ordered) {
    const title = caption(shoot.data);
    const files = bySlug.get(shoot.id) ?? [{ file: 'cover', image: shoot.data.cover }];

    for (const { image } of files) {
      try {
        const width = Math.min(SITEMAP_IMAGE_WIDTH, image.width || SITEMAP_IMAGE_WIDTH);
        const built = await getImage({ src: image, width, format: 'webp' });
        entries.push({ loc: absolute(built.src), title });
      } catch (error) {
        console.warn('[image-sitemap] skipped an image —', (error as Error)?.message ?? error);
      }
    }
  }

  return entries;
}

export const GET: APIRoute = async () => {
  const images = await streamImages();

  // Every stream image belongs to the Overview page; the other two pages carry no photos.
  const byPage: Record<string, { loc: string; title: string }[]> = {
    '/': images,
    '/sessions/': [],
    '/information/': [],
  };

  const urls = PAGES.map((page) => {
    const blocks = (byPage[page] ?? [])
      .map(
        (image) =>
          `    <image:image>\n` +
          `      <image:loc>${escapeXml(image.loc)}</image:loc>\n` +
          `      <image:title>${escapeXml(image.title)}</image:title>\n` +
          `    </image:image>`,
      )
      .join('\n');

    return `  <url>\n    <loc>${escapeXml(absolute(page))}</loc>${blocks ? `\n${blocks}` : ''}\n  </url>`;
  }).join('\n');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    `${urls}\n` +
    `</urlset>\n`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
