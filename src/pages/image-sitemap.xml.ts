import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { getPhotoKeys, getPhotoMeta } from '../lib/photos';
import { SITE } from '../config';

/**
 * /image-sitemap.xml — Google image sitemap. Owned by Agent D (SPEC.md § Information page + SEO).
 *
 * Complements @astrojs/sitemap (which emits /sitemap-index.xml for pages only).
 * Both are advertised in public/robots.txt.
 *
 * WHY THE LADDER URLS AND NOT getImage()
 * --------------------------------------
 * This used to call getImage() and list the fingerprinted /_astro/… derivative, because
 * that URL was not knowable from source. It no longer applies: the stream bypasses
 * astro:assets entirely (gain maps do not survive it — SPEC.md § HDR pipeline) and is
 * served from the static ladder scripts/photo-meta.mjs writes into public/photos/. Those
 * paths are stable across builds, which is what an image sitemap wants — a fingerprinted
 * URL changes on every re-encode and throws away whatever crawl history it had.
 *
 * WHICH IMAGES
 * ------------
 * Every image in every shoot folder — the whole stream, not just covers — at its widest
 * rung (the JPEG, since that is the canonical rendition; the AVIF is a same-image
 * alternative and listing both would be duplicate entries). Discovered through the
 * generated photo metadata, which is the same source the stream renders from, so the
 * sitemap can never point at a file the build did not emit.
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
const PAGES = ['/', '/diary/', '/sessions/', '/information/'] as const;

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

async function streamImages(): Promise<{ loc: string; title: string; section: string }[]> {
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

  const entries: { loc: string; title: string; section: string }[] = [];

  for (const shoot of ordered) {
    const title = caption(shoot.data);
    const section = shoot.data.section;

    for (const key of getPhotoKeys(shoot.id)) {
      // Widest rung: the largest rendition that actually exists for this master.
      const widest = getPhotoMeta(key)?.ladder?.at(-1);
      if (!widest) {
        console.warn('[image-sitemap] no ladder for', key, '— run `npm run photo-meta`');
        continue;
      }
      entries.push({ loc: absolute(widest.jpg), title, section });
    }
  }

  return entries;
}

export const GET: APIRoute = async () => {
  const images = await streamImages();

  // Images live on the page whose stream renders them.
  const byPage: Record<string, { loc: string; title: string; section?: string }[]> = {
    '/': images.filter((image) => image.section === 'overview'),
    '/diary/': images.filter((image) => image.section === 'diary'),
    '/sessions/': [],
    '/information/': [],
  };

  const urls = PAGES.map((page) => {
    const blocks = (byPage[page] ?? [])
      .map(
        (image) =>
          `    <image:image>\n` +
          `      <image:loc>${escapeXml(image.loc)}</image:loc>\n` +
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
