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
| Images     | **True HDR** gain-map JPEG + SDR AVIF ladder, pre-encoded to `public/photos/`  |
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
| `npm run generate`   | `convert-masters` → `photo-meta` → `og-images` — the prebuild steps, in order. |
| `npm run convert-masters` | Turns any HDR master in a shoot folder that is not already a gain-map JPEG into one. No-op (and silent) when there are none. Incremental. |
| `npm run photo-meta` | Walks the shoots folders → `src/generated/photo-meta.json` (dimensions, HDR flag, ladder, thumbhash, average color, EXIF) **and** the `public/photos/` delivery ladder. Incremental. |
| `npm run og-images`  | Composes 1200×630 social cards → `public/og/{home,sessions,information}.jpg`. Incremental. |

`node scripts/check-hdr.mjs <file\|dir>` is a one-off inspector, not part of the build: it reports
whether a JPEG really carries a gain map (sharp metadata plus a byte-level MPF/ISO 21496-1 scan).
Run it on a fresh Lightroom export before dropping it into a shoot folder.

All three generated directories (`src/generated/`, `public/og/`, `public/photos/`) are gitignored
and rebuilt from source — never edit them by hand.

## Add a shoot

Four lines, then drop in the photos:

```sh
mkdir -p src/content/shoots/my-shoot                 # 1. folder name = URL slug
cp ~/exports/*.jpg src/content/shoots/my-shoot/      # 2. name them 001.jpg, 002.jpg … (filename order = display order)
$EDITOR src/content/shoots/my-shoot/index.md         # 3. frontmatter below
npm run dev                                          # 4. metadata + OG card regenerate automatically
```

Step 2 assumes the JPEGs already carry their gain maps, which is what Lightroom's HDR JPEG export
writes — check with `check-hdr` before copying. If instead the HDR came out as **AVIF**, the shoot
folder takes a *pair* per photograph and `npm run generate` builds the `.jpg` master from it:

```
001.avif      HDR master (Lightroom "HDR Output", AVIF)     gitignored
001.sdr.jpg   the SDR master of the same photograph          gitignored
001.jpg       ← written by convert-masters, and committed
```

See [Masters exported as AVIF](#masters-exported-as-avif). Either way it is the `.jpg` that is
committed and the `.jpg` that the site builds from.

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

### Export the masters as HDR

The site delivers **true HDR**. The masters must be gain-map JPEGs (ISO 21496-1) — one file that
carries an authored SDR image *and* the HDR gain map, so HDR displays get HDR and everything else
gets the SDR photograph you graded. Export from Lightroom Classic / Lightroom:

| Setting              | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| Image format         | **JPEG**                                                               |
| HDR                  | **HDR Output** checked                                                 |
| Quality              | **90–95**                                                              |
| Resize to fit        | **Long edge 2560 px**                                                  |
| Color space          | sRGB (Display P3 is fine too; the gain map carries the HDR part)        |
| Metadata             | keep — EXIF drives the optional camera line                             |

**HDR Output + JPEG is the whole recipe.** Lightroom 9.5 writes the ISO 21496-1 gain map into that
JPEG on its own; there is no "Maximize Compatibility" checkbox to find (that is a Photoshop
setting, and older notes calling for it here were wrong). Verified on 38 exports: every one came
out with an MPF index, a second image, and `hdrgm:Version="1.0"` in its XMP. **AVIF is the
exception** — Lightroom's HDR AVIF export writes a bare PQ rendition with no gain map, which is why
it needs a second SDR export to pair with (below).

Author the **SDR preview sliders per image** (Lightroom's SDR tab under the HDR panel). That
preview *is* what most of the internet sees; shipping the default is shipping an unreviewed
photograph. Export with the rotation baked in — an HDR master that still relies on an EXIF
orientation tag is refused by the generator, because gain maps and rotation cannot be combined in
one sharp pass.

Verify before committing:

```sh
node scripts/check-hdr.mjs ~/exports          # GAIN MAP: PRESENT on every row
```

SDR masters still work — they just get a plain JPEG + AVIF ladder through the same code path.

### Masters exported as AVIF

An AVIF master is not the delivery format — sharp can only read a gain map out of a JPEG — so
`scripts/convert-masters.mjs` transcodes it, running at the head of the `generate` chain
(`convert-masters → photo-meta → og-images`).

Lightroom's HDR AVIF is a **single PQ rendition with no gain map**, so the SDR half has to come
from a second export of the same photographs: same catalogue, same edits, **same 2560px long
edge**, JPEG quality 90–95, sRGB or Display P3. Copy both halves in, naming the SDR one
`<stem>.sdr.jpg`:

```sh
cp ~/exports/hdr/001.avif    src/content/shoots/my-shoot/001.avif
cp ~/exports/sdr/001.jpg     src/content/shoots/my-shoot/001.sdr.jpg
npm run generate                                     # each pair becomes the 001.jpg master
node scripts/check-hdr.mjs src/content/shoots/my-shoot   # GAIN MAP: PRESENT on every .jpg
git add src/content/shoots/my-shoot                  # commits the .jpg; both masters are gitignored
```

`convert-masters` computes the gain map from the two intents — a gain map *is* the per-pixel ratio
between an SDR rendition and an HDR one — and copies the SDR JPEG into the output container
byte-for-byte. Measured base RMSE 0.0000, max |delta| 0, on every frame tested: what you graded is
literally what ships, never a tone map of the HDR.

The halves must match in size; a mismatch is a hard error naming both. An `.avif` whose
`.sdr.jpg` has not been exported yet is *not* an error — the run says "awaiting SDR export" and
carries on, so a folder can fill up in batches. A gain-map AVIF (should Lightroom ever write one)
is still handled the old way, from the one file, and needs no SDR half.

It needs two Homebrew packages, once, on the machine that adds the masters:

```sh
brew install libavif libultrahdr
```

Without them the script warns and skips instead of failing, which is deliberate: the converted
`.jpg` masters are committed, so CI and any other machine build fine with neither installed.

Two things that will bite on a first real export:

- **Export at the documented 2560px long edge.** The Homebrew `libultrahdr` is built with an
  8192×8192 ceiling, so a full-resolution 61MP export (9504×6336) is refused. The script prints the
  fix — rebuild libultrahdr with `-DUHDR_MAX_DIMENSION=16384` and point `$ULTRAHDR_APP` at it — but
  resizing on export is the easier answer and is what the spec asks for anyway.
- **Export both halves at the same size, from the same edits.** The gain map is a per-pixel ratio;
  two different rasters cannot produce one. The script refuses the pair rather than resampling, and
  it will never invent an SDR base by tone mapping the HDR — that is the one rule of this pipeline.
- **`check-hdr` cannot read an AVIF's gain map** and shows every `.avif` as `sdr`. That is a
  limitation of the checker (libvips only parses gain maps in JPEG), not a verdict on the file. The
  rows that matter are the `.jpg` ones.

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
scripts/          convert-masters.mjs, photo-meta.mjs, og-images.mjs, make-placeholders.mjs, check-hdr.mjs
docs/             LAUNCH.md, dns-snapshot-2026-08-12.txt
public/           favicon, robots.txt, og/ (generated), photos/ (generated ladder)
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
