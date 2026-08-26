/**
 * HTML plumbing for Worker-rendered pages. The gallery is a private annex of
 * ryuxik.io — same tokens, same typefaces — but it is rendered here, not by
 * Astro, so the shell links the static /gallery/*.css|js assets (public/,
 * copied verbatim into dist/) instead of anything fingerprinted.
 *
 * Every /g/* response is invisible by construction: X-Robots-Tag noindex,
 * Referrer-Policy no-referrer, and nothing in the site ever links in
 * (SPEC.md § Client galleries).
 */

export function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export const GALLERY_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function page(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // SPEC: EVERY /g response is invisible by construction — the API JSON
      // (client names, comment bodies) included, not just pages.
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export function notFoundTombstone(): Response {
  // Expired, revoked and never-existed all resolve to the SAME page — a
  // capability URL must not confirm which of those it was.
  const body = page(
    'Gallery unavailable',
    '<link rel="stylesheet" href="/gallery/gallery.css">',
    `<main class="tombstone">
  <p class="tombstone__mark">Ryuxik Photography</p>
  <h1>This gallery is no longer available.</h1>
  <p>Galleries are shared for a limited time. If you were expecting to find
  your photographs here, write to <a href="mailto:ryuxik@gmail.com">ryuxik@gmail.com</a>
  and Santiago will sort it out.</p>
</main>`
  );
  return new Response(body, { status: 404, headers: GALLERY_HEADERS });
}
