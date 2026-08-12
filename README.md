# ryuxik.io

Photography portfolio and booking site for Ryu — creative portraiture in front, service-tier
booking one level down. Static site, no client-side framework, $0/mo to run.

Replaces the 2018 Angular app that used to live here. The full build contract is [`SPEC.md`](./SPEC.md).

```
/              Overview — the curated photo stream
/sessions      Tracks, tiers, Cal.com booking, testimonials, FAQ, prep, inquiry form
/information   Bio + contact
```

## Stack

| Piece      | Choice                                                                        |
| ---------- | ----------------------------------------------------------------------------- |
| Framework  | [Astro 7](https://astro.build), `output: 'static'` — zero framework runtime    |
| Styling    | One global stylesheet + scoped component styles. No Tailwind.                  |
| Type       | Self-hosted `@fontsource-variable/newsreader` + `archivo`. No font CDN.        |
| Images     | `astro:assets` (AVIF + WebP, widths 480/800/1200/1600)                         |
| Content    | Astro content collections — a `shoots` collection of folders on disk           |
| Booking    | Cal.com inline embed, lazy-injected on scroll                                  |
| Hosting    | Cloudflare Pages (static)                                                      |
| Theme      | Single warm-paper light theme. **No dark mode** — deliberate; skin tones.      |

Interactive bits are plain vanilla `<script>` inside `.astro` components. There is no React,
no Vue, no hydration.

## Local development

Requires **Node 22.19 or newer** (a transitive `undici@8` sets that floor; see
[`docs/LAUNCH.md`](./docs/LAUNCH.md) for the Cloudflare `NODE_VERSION` pin).

```sh
npm install
npm run dev        # → http://localhost:4321
```

| Command              | Does                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| `npm run dev`        | Dev server. Runs `generate` first via `predev`.                          |
| `npm run build`      | `astro check` (strict TS) then `astro build` → `dist/`. Must pass clean.  |
| `npm run preview`    | Serve the built `dist/` locally.                                         |
| `npm run generate`   | `photo-meta` then `og-images` — both prebuild steps, in order.           |
| `npm run photo-meta` | Walks the shoots folders → `src/generated/photo-meta.json` (dimensions, thumbhash, average color, EXIF). Incremental. |
| `npm run og-images`  | Composes 1200×630 social cards → `public/og/{home,sessions,information}.jpg`. Incremental. |

Both generated directories (`src/generated/`, `public/og/`) are gitignored and rebuilt from
source on every install — never edit them by hand.

## Add a shoot

Four lines, then drop in the photos:

```sh
mkdir -p src/content/shoots/my-shoot                 # 1. folder name = URL slug
cp ~/exports/*.jpg src/content/shoots/my-shoot/      # 2. name them 001.jpg, 002.jpg … (filename order = display order)
$EDITOR src/content/shoots/my-shoot/index.md         # 3. frontmatter below
npm run dev                                          # 4. metadata + OG card regenerate automatically
```

`index.md`:

```yaml
---
title: "Oaxaca portraits"      # required
subject: "Marisol A."          # required — drives the caption
context: personal              # required — 'commissioned' | 'personal'
client: ""                     # optional — renders as "for {client}" in the caption
date: 2026-03-14               # required — caption shows "Mar '26"; sorts the stream
location: "Oaxaca, MX"         # optional
genre: portraiture             # 'portraiture' | 'street' | 'landscape' | 'events' | 'other'
cover: ./001.jpg               # required
featured: 10                   # sort weight within the same date; default 0
---
```

The body is optional — one or two sentences at most, usually empty.

Stream order is **date descending, then `featured` descending**. Captions render as
`{subject} for {client} · Mon 'YY`. The schema lives in `src/content.config.ts`; a bad
value fails `npm run build` with a readable zod error rather than shipping.

## Configuration

Every user-tunable string is in **`src/config.ts`** — one file, no hunting.

| Key            | What it drives                                                                        |
| -------------- | -------------------------------------------------------------------------------------- |
| `name`         | Wordmark, `og:site_name`, JSON-LD `Person.name`, OG card lettering                     |
| `url`          | Canonicals, sitemaps, absolute OG image URLs                                           |
| `title`        | Default `<title>` (home page uses it bare)                                             |
| `description`  | Default meta + `og:description`                                                        |
| `email`        | The large mailto link on /information, JSON-LD, and the Cal-embed fallback             |
| `instagram`    | Footer link, /information link, JSON-LD `sameAs`                                        |
| `city`         | `ProfessionalService` address + `areaServed`. **Empty = both omitted cleanly**, never a blank address |
| `calConsult`   | `data-cal-link` for the free consult embed                                              |
| `calHeadshots` | `data-cal-link` for the self-serve session embed                                        |
| `formEndpoint` | Inquiry form POST target. **Empty = the form is hidden and a mailto block shows instead** |

Design tokens (colors, type stacks, spacing scale) live at the top of `src/styles/global.css`.
Change a hex there and it propagates everywhere, including the generated OG cards.

## SEO

- `<Seo />` (`src/components/Seo.astro`) goes in BaseLayout's `head` slot and emits title,
  description, canonical, Open Graph and Twitter tags. BaseLayout's fallback tags switch off
  automatically when that slot is filled, so nothing is ever emitted twice.
- JSON-LD: `PersonJsonLd.astro` on /information, `SessionsJsonLd.astro`
  (`ProfessionalService` + one `Service` per tier) on /sessions.
- Sitemaps: `/sitemap-index.xml` from `@astrojs/sitemap`, plus `/image-sitemap.xml`
  (`src/pages/image-sitemap.xml.ts`) listing every stream photo with its caption.
  `public/robots.txt` points at both.
- OG cards are generated, not designed by hand: `scripts/og-images.mjs` crops the leading
  stream cover to 1200×630, darkens it, and overlays the wordmark as **vector letterforms**
  (no SVG `<text>`, so it cannot depend on which fonts a build container happens to have).
  With no photos in the collection it falls back to the wordmark on paper.

## Layout

```
src/
  components/     Seo, JSON-LD, Cal embed, form, stream pieces
  content/shoots/ one folder per shoot (see "Add a shoot")
  generated/      photo-meta.json — generated, gitignored
  layouts/        BaseLayout.astro — the shell: head slot, header, nav, footer
  lib/            typed helpers over the collection + generated metadata
  pages/          index, sessions, information, 404, image-sitemap.xml.ts
  styles/         global.css — tokens first, then everything else
scripts/          photo-meta.mjs, og-images.mjs, make-placeholders.mjs
docs/             LAUNCH.md, dns-snapshot-2026-08-12.txt
public/           favicon, robots.txt, og/ (generated)
```

## Deploy

Cloudflare Pages, build command `npm run build`, output directory `dist`.

Full step-by-step — Cal.com event types, Stripe retainer, form endpoint options, the Pages
setup, the Squarespace Domains nameserver move, post-launch verification, and shutting down the
old App Engine app — is in **[`docs/LAUNCH.md`](./docs/LAUNCH.md)**.

## Placeholders

Anything Ryu still has to supply is marked `TODO(ryu):` — in a comment, or visibly in the copy
where shipping it silently would be a lie. Find every one:

```sh
grep -rn "TODO(ryu)" --exclude-dir=node_modules --exclude-dir=dist .
```

The checklist at the end of `docs/LAUNCH.md` walks through them.
