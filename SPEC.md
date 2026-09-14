# ryuxik.io revamp — build spec

Single source of truth for the rebuild. All agents follow this exactly. Full rationale lives in the
published plan (research: 20-site survey of world-class photographer portfolios, 2026 booking
landscape, stack comparison). This file is the contract.

## What this is

A photography portfolio + booking site for Ryu (github: ryuxik), strongest in creative portraiture,
replacing a dead 2018 Angular app. Editorial presentation in front, service-tier booking one level
down. Static Astro 7 site deployed to Cloudflare Pages. Running cost target: $0/mo.

## Hard rules

- Work ONLY in `/Users/ryuxik/Desktop/personalSite` on branch `revamp`.
- Astro 7, `output: 'static'`. No React/Vue/etc. — zero framework runtime. Islands are plain
  vanilla `<script>` in Astro components.
- No Tailwind. One global stylesheet (`src/styles/global.css`) with the tokens below + scoped
  component styles where needed.
- No runtime font/CDN dependencies except the Cal.com embed script (unavoidable, lazy-loaded).
  Fonts self-hosted via `@fontsource-variable/newsreader` and `@fontsource-variable/archivo`.
- Single theme: warm paper light. NO dark mode (deliberate — none of the top-tier photography
  sites ship one; skin tones are the reason). Paint all colors explicitly.
- **Stream images bypass `astro:assets` entirely** — the masters are HDR gain-map JPEGs and
  `getImage()`/`<Picture>` strip the gain map. They are pre-encoded into `public/photos/` by
  `scripts/photo-meta.mjs` and rendered as hand-written `<picture>` markup; see § HDR pipeline.
  Never lazy-load the LCP image. Everything that is *not* a stream photograph (OG cards, any
  future non-stream image) may still go through `astro:assets`.
- `npm run build` must pass cleanly (this includes `astro check` — strict TS) before an agent
  reports done. Do not leave the build broken for the next agent.
- Placeholder user data is always marked `TODO(ryu):` in a comment or visibly in copy.
- Commit nothing; the coordinator handles git.

## Design tokens ("F5 · Spiky" redesign, owner-directed 2026-08-26)

Santiago rejected the original bone/sepia + Newsreader system ("old man") in favor of
an art-cyber direction for creative portraiture: ink-dark ground, acid accent,
Bricolage Grotesque voice, Geist Mono apparatus. Token NAMES were kept so every
component continued to work — `--paper` is now the dark ground and `--serif` is now
the display grotesque. The full candidate study lives in the "Ryuxik Type Study"
artifact. Mirror any token change into public/gallery/gallery.css and
public/admin/admin.css (Worker-rendered pages restate them).

```css
:root {
  --paper:     #101014;  /* page ground — ink dark; HDR burns brightest here */
  --ink:       #EFEFED;  /* near-white text */
  --ink-soft:  #B6B6BC;  /* secondary text */
  --ink-faint: #83838B;  /* captions, datelines — 5.2:1 on --paper */
  --line:      #232330;  /* hairlines, borders */
  --card:      #17171C;  /* raised surfaces */
  --accent:    #D8FF3D;  /* links, active nav, CTAs — acid */
}
```

Type:
- Voice (display + body): `"Bricolage Grotesque Variable"` (opsz auto-switches
  display/text; display rules add weight ~740–800, `"wdth" 87`, letter-spacing
  ≈ −0.02em). Body 1.02rem/1.62 weight 420. No italics anywhere.
- Apparatus (nav, captions, labels, buttons, tables, EXIF): `"Geist Mono Variable"`,
  small sizes, uppercase where labeled, letter-spacing 0.07em (mono is already wide).
- Wordmark: site name in the voice face, weight 800, wdth 87, tight (−0.015em) — no
  tracking-spread caps.
- Buttons: acid ground, #101014 text. Running text max-width 66ch. Headings
  `text-wrap: balance`.

Layout: centered column max-width 720px for text pages; the Overview stream is a single column of
images max-width 1100px, edge-to-edge on mobile. Generous whitespace; hairline rules only where
they separate real sections. Motion: at most a subtle fade-up on stream images via
IntersectionObserver, respecting `prefers-reduced-motion`. Nothing else animates.

## Site map & nav

Header: wordmark left (links home), nav right: `Overview · Sessions · Information`
(uppercase grotesque, letterspaced; active page in --accent). Mobile: nav collapses under a text
label "Menu" (no hamburger icon) — `<details>`-based, styled, no JS required.
Footer: `© 2026 Ryuxik · Instagram` one line, --ink-faint.

Pages:
- `/` — Overview: curated stream
- `/sessions` — the working page (tracks, tiers, booking, FAQ, prep, form)
- `/information` — bio + contact
- 404 page: minimal, wordmark + "Nothing here. → Overview"

## src/config.ts (all user-tunable strings in ONE place)

```ts
export const SITE = {
  name: "RYUXIK",                        // TODO(ryu): confirm brand name vs real name
  url: "https://ryuxik.io",
  title: "Ryuxik — Photographer",
  description: "Creative portraiture and photography sessions. Book time with me.",
  email: "hello@ryuxik.io",              // TODO(ryu): confirm address
  instagram: "https://instagram.com/ryuxik",  // TODO(ryu): confirm handle
  city: "",                              // TODO(ryu): city served — needed for ProfessionalService JSON-LD
  calConsult: "ryuxik/intro-call",       // TODO(ryu): create on cal.com
  calHeadshots: "ryuxik/headshots",      // TODO(ryu): create on cal.com, attach Stripe retainer
  formEndpoint: "",                      // TODO(ryu): e.g. Formspree URL; empty = form hidden, email shown
};
```

## Content model (owned by Agent B)

```
src/content/shoots/<slug>/
  index.md        # frontmatter below, body optional (1-2 sentence note, usually empty)
  001.jpg …       # images, filename order = display order
```

Frontmatter (zod schema in `src/content.config.ts`):
```yaml
title: "Oaxaca portraits"     # required
subject: "Marisol A."         # who/what — drives the caption
context: personal             # 'commissioned' | 'personal'  (required)
client: ""                    # optional — "for {client}" in caption when present
date: 2026-03-14              # required — caption shows "Mar '26"
location: "Oaxaca, MX"        # optional
genre: portraiture            # 'portraiture' | 'street' | 'landscape' | 'events' | 'other'
cover: ./001.jpg              # required — plain string path, not image()
featured: 10                  # sort weight desc within same-date; default 0
```

**`cover` is a `z.string()`, deliberately not astro:assets' `image()`.** Nothing consumes it as an
`ImageMetadata`: the stream serves the pre-encoded ladder (§ HDR pipeline) and `scripts/og-images.mjs`
reads the file off disk with its own frontmatter parser. `image()` therefore bought no type safety
and made Astro emit a full-size, unreferenced copy of every cover into `dist/_astro/` — at ~90
masters, hundreds of megabytes of dead weight in every deploy. The cost of the plain string is that
a typo'd path no longer fails the build; og-images falls back to the first image in the folder.

Caption format on the stream: `{subject}{client ? ` for ${client}` : ""} · {Mon 'YY}` — grotesque,
small, --ink-faint. Genre appears in a per-shoot label ONLY in the optional list view, never as nav.

Stream order: featured desc (the stream is a curated sequence — the opener is an editorial choice), then date desc for ties and unweighted shoots.

`scripts/photo-meta.mjs` (prebuild, wired as `predev` + `prebuild`): walks shoots folders, and for
every image emits into `src/generated/photo-meta.json`: width/height, `isHDR`, the delivery
`ladder` (see § HDR pipeline), thumbhash (base64 data-URI PNG via `thumbhash` + sharp raw), average
hex color, EXIF (camera, lens, focal, aperture, shutter, iso — when present). Renders as: thumbhash
data-URI as the img's CSS background while loading. Script must be incremental (skip files whose
mtime+size match the cache *and* whose ladder files are all present) and safe when folders are
empty. `src/lib/photos.ts` exposes typed helpers to read collection + meta together; it is the
source of truth for which images exist, since an image with no ladder cannot be rendered.

## HDR pipeline

The masters are **HDR gain-map JPEGs** (ISO 21496-1): an authored SDR base image plus an attached
gain map. Chrome 137+/Edge and Safari 26+ apply the map and render true HDR; every other browser
ignores it and shows the SDR base, which is a real photograph the photographer graded — not a
fallback. Firefox never does HDR. That is fine and needs no code.

**Why not `astro:assets`.** Every astro:assets derivative drops the gain map, so the stream is
pre-encoded instead. `scripts/photo-meta.mjs` writes, per image, widths `[900, 1400, 2048]` (never
upscaling; a master narrower than 2048 contributes its own width as the top rung):

```
public/photos/<slug>/<stem>-<w>.jpg    quality 82 — HDR gain-map JPEG (plain JPEG for an SDR master)
public/photos/<slug>/<stem>-<w>.avif   quality 55 — SDR, for displays that get the SDR rendition anyway
```

**sharp rules, non-negotiable.** `sharp(src).keepGainMap().resize({width}).jpeg({quality:82})`
resizes base and gain map in lockstep and preserves the authored SDR base. `keepGainMap` is
experimental: the chain stays *exactly* resize + jpeg, nothing else (which is why an HDR master
must arrive with its EXIF rotation already baked into the pixels — the generator refuses one that
is not upright). **Never `withGainMap()`** — it regenerates the SDR base by tone mapping and comes
out about 42% darker than what was authored. The AVIF rung is encoded from a plain `sharp(src)`
read, which yields that same authored SDR base. Detection is `'gainMap' in await sharp(src).metadata()`.

**The `<picture>` pattern** (`src/components/StreamFigure.astro`) — source order is load-bearing:

```html
<picture>
  <source media="(dynamic-range: high)" type="image/jpeg" srcset="…900w, …1400w, …2048w" sizes="…">
  <source type="image/avif" srcset="… same widths …" sizes="…">
  <img src="<mid-size jpg>" width height alt loading decoding>
</picture>
```

`<picture>` knows nothing about HDR — it matches MIME types — but it evaluates `media` before
`type`. Without the media-gated JPEG first, an HDR-capable Chrome takes the smaller AVIF and
renders the photo SDR. SDR masters use identical markup (the first source is just a plain JPEG
ladder); one code path is worth the harmless duplication.

**Safari caveat.** Safari 26.0–26.3 silently drops an HDR `<img>` to SDR when CSS
opacity/transform/transitions apply to it *or to any ancestor*. So the fade-up reveal is skipped
entirely on HDR-capable displays — `src/pages/index.astro` returns early on
`matchMedia('(dynamic-range: high)')`, and `will-change` is only hinted once the reveal is armed.
Animating the wrapper instead would not help: ancestor opacity affects the image.

**Serving.** The ladder must reach the browser byte-for-byte. No transforming CDN or image service
may sit in front of it (they re-encode and strip gain maps); `public/photos/` is static output,
gitignored, rebuilt from the masters. Validate any real export with `node scripts/check-hdr.mjs
<file|dir>` before trusting it.

### AVIF masters — `scripts/convert-masters.mjs`

Lightroom's HDR **JPEG** export already writes the gain map, so the usual master needs no
conversion at all: it drops straight into a shoot folder as `<stem>.jpg`. Its HDR **AVIF** export
does not — Lightroom 9.5 writes a single PQ rendition (CICP 12/16, `crs:HDREditMode=1` in the XMP)
with no gain map and no setting that adds one. And sharp cannot read a gain map out of an AVIF
regardless: its uhdr support is JPEG-in/JPEG-out, and a plain decode silently drops the HDR half.

So an AVIF master is converted to a gain-map JPEG **once**, by `scripts/convert-masters.mjs`, which
runs first in the `generate` chain:

```
convert-masters  →  photo-meta  →  og-images
```

It scans `src/content/shoots/*/` and writes `<stem>.jpg` beside each master, skipping work whose
output is already current (mtime+size stamps for *both* inputs, in
`src/generated/converted-masters.json`, the same style photo-meta uses).

**Folder convention.** A shoot folder holds at most three files per photograph:

| File | What | Git |
| ---- | ---- | --- |
| `<stem>.avif` | HDR master, Lightroom "HDR Output" → AVIF | ignored |
| `<stem>.sdr.jpg` | the authored SDR master of the same frame | ignored |
| `<stem>.jpg` | the gain-map JPEG the site builds from | **committed** |

Both masters are gitignored: they are re-exportable from the catalogue, and the committed `.jpg`
already *contains* the `.sdr.jpg` — its primary image is those bytes verbatim — so committing both
would store the same photograph twice. Committing the derived `.jpg` is what lets CI and a fresh
clone build with neither libavif nor libultrahdr installed. `photo-meta`'s `IMAGE_EXT` excludes
`.avif` and its scan excludes `*.sdr.jpg`, so it only ever sees the converted JPEG — otherwise
every HDR photograph would appear twice in the stream, once properly and once as its own flat SDR
half. `og-images` excludes both for the same reason when it auto-picks a shoot cover.

**Two modes.** Which one runs depends on whether the `.avif` carries a gain map:

*PAIR mode* (what Lightroom 9.5 needs) — `<stem>.avif` is a bare PQ rendition and `<stem>.sdr.jpg`
is the graded SDR. libultrahdr computes the gain map from the two intents, which is exactly what a
gain map is: the per-pixel ratio between an SDR rendition and an HDR one.

| Step | Tool | Note |
| ---- | ---- | ---- |
| decode the HDR intent | `avifdec` → 16-bit PNG | PQ-coded, source primaries |
| read it | sharp **`.toColourspace('rgb16')`**`.raw({depth:'ushort'})` | the cast is load-bearing — see below |
| match gamuts | 3×3 matrix into the SDR base's primaries | else libultrahdr sets `useBaseColorSpace=0` and libvips refuses the file |
| pack | RGBA1010102 | little-endian uint32, R bits 0–9, G 10–19, B 20–29, A 30–31 |
| assemble | `ultrahdr_app -m 0` (scenario 3) | raw HDR intent + **compressed** SDR JPEG |

`-t 2 -C n -c n -a 5 -M 1 -s 1 -Q 95 -D 1 -L <peak>`. Three of those are the ones that go wrong
quietly:

- **`.toColourspace('rgb16')`.** sharp's default pipeline interpretation is 8-bit sRGB, so
  `raw({depth:'ushort'})` alone returns `value >> 8` widened into a ushort — the 10-bit master
  becomes 8-bit and every highlight ratio is wrong. Verified against a from-scratch zlib PNG decode.
- **`-C` / `-c` (gamut).** They must agree, or libultrahdr writes `useBaseColorSpace=0` and libvips
  then refuses the file outright ("gainmap image is expected to contain alternate image color space
  in the form of ICC"), taking the whole ladder down. So the HDR intent is converted into the SDR
  base's primaries (read from its ICC) rather than mislabelled — also 1.2 dB more accurate.
  libultrahdr cross-checks `-c` against that ICC and refuses a mismatch, so it cannot go unnoticed.
- **`-L` (target display peak, nits).** Sets `hdrCapacityMax = L / 203` — the display headroom at
  which the *whole* map gets applied. libultrahdr's PQ default is 10000 nits → 5.62 stops, so a
  1.5-stop laptop would apply a quarter of the map and the photograph would render flat. It is set
  to the master's own measured peak luminance. It moves only the metadata, not the signal.

*AVIF mode* (kept for the day Lightroom writes gain-map AVIFs) — everything is inside the one file:
`avifgainmaputil printmetadata` + `extractgainmap`, `avifdec` for the authored base, sharp to
re-encode the map as JPEG at q95 **4:4:4** (it is not a photograph; subsampling doubles its error),
and `ultrahdr_app -m 0` scenario 4 to copy both compressed images in verbatim.

**Both modes preserve the SDR base exactly.** It goes to `ultrahdr_app` as a compressed JPEG and is
copied into the output container without being decoded, re-tone-mapped or re-encoded — measured
base RMSE 0.0000, max |delta| 0. As everywhere else in this pipeline: **never `withGainMap()`**.

**Metadata mapping, ISO 21496-1 → libultrahdr** (AVIF mode only). The formats carry the same
quantities in different units — ISO stores gains and headrooms as log2, libultrahdr's config wants
them linear. Wrong values here do not fail, they just ship a wrong HDR rendition:

| `printmetadata` field | config key | transform |
| --------------------- | ---------- | --------- |
| Gain Map Min | `--minContentBoost` | `2^x` |
| Gain Map Max | `--maxContentBoost` | `2^x` |
| Base headroom | `--hdrCapacityMin` | `2^x` |
| Alternate headroom | `--hdrCapacityMax` | `2^x` |
| Gain Map Gamma | `--gamma` | as-is |
| Base Offset | `--offsetSdr` | as-is |
| Alternate Offset | `--offsetHdr` | as-is |
| Use Base Color Space | `--useBaseColorSpace` | True→1 / False→0 |

ISO stores each per channel (R/G/B) where libultrahdr has one slot; the script refuses a file whose
channels disagree rather than quietly keeping red's value for all three.

**Partial folders are normal.** An `.avif` with no `.sdr.jpg` yet logs "awaiting SDR export" and
the run continues — exports arrive in batches. A `.sdr.jpg` with no `.avif` is reported as a note.
A size mismatch between the two halves is a hard error naming both.

**Tooling is optional at build time.** `brew install libavif libultrahdr`. Only the tools the
pending work actually needs are required — pair mode never calls `avifgainmaputil`, and its absence
downgrades to "assume no gain map" rather than stopping the run. When the load-bearing ones are
absent the script warns, skips, and exits 0.

Two caveats worth knowing before the first real export:

- **8192px cap.** The Homebrew `libultrahdr` bottle is compiled with `UHDR_MAX_DIMENSION=8192`. A
  master exported at the documented 2560px long edge is far under it, but a full-resolution export
  off a 61MP body (9504×6336) is not, and the script says so with the fix. Lifting it means
  building libultrahdr from source with `-DUHDR_MAX_DIMENSION=16384` and pointing `$ULTRAHDR_APP`
  at the result.
- **No AVIF support in the bottle.** libultrahdr 2.0.x *can* decode gain-map AVIF directly
  (`UHDR_ENABLE_HEIF`), which would collapse this whole chain into one command — but the option
  needs a libheif patched for the ISO 21496-1 gain map API, which Homebrew's is not, so the bottle
  silently omits it. Re-evaluate when that lands upstream.

**Measured**, pair mode vs the same frames' Lightroom-authored gain-map JPEGs, comparing each
file's decoded HDR rendition against the PQ AVIF (PQ domain, perceptually uniform):

| Frame | this script | Lightroom | content peak |
| ----- | ----------- | --------- | ------------ |
| 1707×2560 | 42.9 dB, capacity 1.06 st | 38.8 dB, 1.44 st | 424 nits (1.06 st) |
| 2560×1707 | 58.7 dB, capacity 1.71 st | 50.2 dB, 2.30 st | 663 nits (1.71 st) |
| 2560×2560 | 53.2 dB, capacity 2.58 st | 49.0 dB, 2.30 st | 1212 nits (2.58 st) |

`crs:HDRMaxValue` in the XMP is **not** the content's peak — it reads `+2.30` on all three, because
it is the edit's headroom ceiling. Lightroom clamps its own `hdrCapacityMax` to it (visibly, on the
2.58-stop frame); this script uses each master's measured peak instead.

Placeholders: `scripts/make-placeholders.mjs` (run once, committed output) generates 3 shoots ×
3–4 images each, portrait 4:5, 1600px long side, muted warm gradient + film-grain noise + big
centered "PLACEHOLDER" text via sharp SVG composite. Distinct hues per shoot. Realistic frontmatter
with `TODO(ryu): replace with real work` in the body.

## Sessions page (owned by Agent C)

Order top→bottom:
1. One-line intro (serif, quiet).
2. Two track cards side by side (stack on mobile):
   - "Creative portraiture — Start a project": short pitch, "Custom projects — let's talk",
     button scrolls to consult embed.
   - "Headshots & standard sessions — Book now": pitch, button scrolls to booking embed.
3. Investment: 3 tier cards (grotesque data, serif names). Names/prices are placeholders:
   e.g. Headshot Session / Portrait Session / Half-day — each "starting at $TODO", 3-4 bullet
   deliverables, turnaround. Visible `TODO(ryu)` in copy is fine at this stage. Below tiers, one
   line: custom/editorial work is quoted after a consult.
4. Booking: two `<CalEmbed>` sections with headings — free 20-min consult (calConsult) and
   self-serve session (calHeadshots). CalEmbed.astro: container div + official Cal inline embed
   snippet, injected only when scrolled near (IntersectionObserver), `data-cal-link` from config.
   Until Cal loads (or if it fails), the container shows a styled fallback: "Email {email} and
   I'll reply within 24h." Never a blank box.
5. Testimonials: 2 `<blockquote>` slots directly beside/above the booking CTAs — placeholder
   text clearly marked `TODO(ryu): real quote, name, role, photo`.
6. FAQ: 6 `<details>`/`<summary>` items (turnaround, usage rights, travel, weather, rescheduling,
   what to wear pointer). Write real, sensible default answers; retainer language:
   "non-refundable retainer" + 48-hour reschedule window.
7. Prep guide: short "Before your session" list.
8. Inquiry form (only if formEndpoint set, else a mailto block): exactly 5 fields — name, email,
   session type (select), date window (text), message. POST to formEndpoint. Honeypot field.
   Styled to tokens. Below it: "I reply within 24 hours." — TODO(ryu) confirm window.

## Information page + SEO (owned by Agent D)

Information: one third-person bio paragraph (placeholder, TODO-marked, structured origin → training
→ one credential → where work appears), plain email as a large serif link, Instagram. Nothing else.

SEO/meta (in BaseLayout via a `<Seo>` component):
- title/description per page, canonical, OG + twitter tags. OG images: `scripts/og-images.mjs`
  (prebuild, after photo-meta) composes 1200×630 JPEGs per page with sharp: cover image (first
  stream cover) darkened + wordmark text SVG overlay → `public/og/{page}.jpg`.
- JSON-LD: `Person` (site-wide), `ProfessionalService` + one `Service` per session type on
  /sessions (omit address cleanly while SITE.city is empty).
- `@astrojs/sitemap` in astro.config; plus `src/pages/image-sitemap.xml.ts` emitting page entries
  with `<image:image>` (loc, title=caption) for every stream image. robots.txt pointing at both.
- README.md: rewrite for the new stack (what it is, dev commands, how to add a shoot in 4 lines,
  config reference). docs/LAUNCH.md: step-by-step launch checklist — Cal.com event types + Stripe
  retainer setup, Formspree (or CF function) options, Cloudflare Pages connect (build `npm run build`,
  output `dist`), nameserver move at Squarespace Domains (note: DNS snapshot in docs/, zone has NO
  MX/TXT — clean move), verify, decommission App Engine app + Cloud DNS zone.

## Ownership map (do not touch files outside your lane)

- Agent A (scaffold): package.json, astro.config.mjs, tsconfig, src/styles/global.css,
  src/layouts/BaseLayout.astro, header/footer/nav, src/config.ts, src/pages/{index,sessions,
  information,404}.astro as working stubs, src/content.config.ts (schema per spec),
  scripts/photo-meta.mjs + og-images.mjs as no-op stubs so build passes, .gitignore.
- Agent B (photos): scripts/photo-meta.mjs, scripts/make-placeholders.mjs, src/lib/photos.ts,
  src/generated/, src/content/shoots/*, src/pages/index.astro, stream components.
- Agent C (sessions): src/pages/sessions.astro, src/components/CalEmbed.astro, InquiryForm.astro,
  Testimonial.astro, Faq.astro.
- Agent D (info+seo): src/pages/information.astro, src/components/Seo.astro, JSON-LD components,
  scripts/og-images.mjs, src/pages/image-sitemap.xml.ts, robots.txt, README.md, docs/LAUNCH.md,
  404 content polish.
- Shared files (global.css, BaseLayout, config.ts, content.config.ts, package.json): Agent A owns;
  B/C/D may APPEND new CSS classes under a clearly-commented section for their page but must not
  edit existing rules. If something in a shared file blocks you, note it in your report instead of
  editing.

## Client galleries — "Selects" (Worker-rendered, private)

Full product plan + principal-engineer review: the Selects artifact (2026-08-26).
Private, per-client delivery galleries: HDR-true proofing, a mark-your-N-favorites-
for-polish loop, byte-exact HEIC downloads, auto-expiry. Never linked from the site,
never in sitemaps; every /g response carries `X-Robots-Tag: noindex` and
`Referrer-Policy: no-referrer`.

**Surfaces.** wrangler.jsonc gives the Worker `run_worker_first` on `/g/*`, `/api/*`,
`/admin*`; everything else stays static assets. Code: `worker/` (entry `index.ts`,
routes, `schema.sql` mirrored into `lib/db.ts`, STORE-zip writer, Resend client,
daily cron). Client assets: `public/gallery/`, `public/admin/` (site tokens restated —
the Worker renders outside the Astro build). Bindings: R2 `selects-media`,
D1 `selects-db`, daily cron. See docs/LAUNCH.md § Selects for provisioning.

**The link is the credential.** `/g/<slug>-<key>`, key = 16 base32 chars (80 bits,
rejection-sampled). Media rides key-versioned paths (`…/m/<kv>/…`) with
`Cache-Control: private, max-age=3600` — never shared caches, and Worker responses are
not edge-cached, so server-side revocation (rotation, draft, expiry, delete) is INSTANT
for new requests; the only residue is the legitimate viewer's own browser cache (≤1h).
Draft conceals everything except the "not yet ready" shell — media, downloads, zips and
the API all tombstone. Wrong key, expired, deleted and never-existed all resolve to one
identical tombstone. Clients have no accounts: a name chip (localStorage) attributes
marks and comments. Viewer names persist in the records (marks, threads, events) — an
erasure request means deleting those rows by hand.

**Two ingest paths, and the server never decodes an image.** Browser: the admin
gallery page has an Add Photos drop zone — pair a Grain Studio export folder in
the page, integrity (CRC32) and metadata computed client-side, files PUT to the
same upload API; Grain Studio's "Web preview" row now emits the full web set
(preview + `-w{width}.jpg` gain-map rungs with `.avif` twins), so nothing is
derived outside Grain Studio. CLI (`scripts/gallery-ingest.mjs` / the `deliver`
shell function): same protocol, uses authored rungs when present, still derives
them for pre-web-set folders; the faster choice for multi-GB shoots. The GPS
gate (fail-closed), gain-map gate, size and CRC verification all run IN THE
WORKER on every upload, so both paths are held to one standard.

**The historical constraint that shaped this:** Verified 2026-08-26:
nothing server-side turns HEIC HDR into a gain-map JPEG (sharp/libvips prebuilts have
no HEIC; libheif can't read Apple gain maps; Apple's ImageIO writes no ISO JPEG — and
toGainMapHDR -j emits the Apple scheme, which Chrome/sharp read as SDR). So Grain
Studio's "Web preview" row authors a 2560 ISO 21496-1 gain-map JPEG via libultrahdr
(`ultrahdr_app`, both intents BT.709 — libvips refuses to resize alternate-gamut maps
without their ICC), and `scripts/gallery-ingest.mjs` derives the 900/1400/2048
keepGainMap ladder + AVIF + thumbhash + CRC32 on the Mac and PUTs verbatim bytes to
the admin API. Gates: refuse a gain-map-less preview (unless --sdr), refuse GPS EXIF
(unless --allow-gps) — never strip, bytes are canonical. The preview JPEG is the ONE
JPEG in the system and is never downloadable; every deliverable is HEIC
(original / instagram 1080×1440 / rednote 1242×1656 — Grain Studio's checklist 1:1).

**Marks ("mark your N for polish", N default 3).** One shared set per gallery, hard
cap enforced atomically in SQL (concurrent viewers cannot exceed N), explicit finalize
(locks + emails Santiago; refuses an empty set), photographer reopen. Re-ingesting a
stem with --replace bumps its version ONLY when the original's content changed (bytes +
CRC32 against the server record); an unchanged re-run is a no-op and a partial earlier
run is healed gap-by-gap without a bump. Marks and threads survive; a MARKED photo
gets an "updated" chip (unmarked re-uploads are silent maintenance) — the
polish loop IS delivery. Display order is stem sort (filename
order = display order, same as the portfolio).

**Zips stream, nothing is "prepared".** STORE-mode (HEIC doesn't compress), CRC32s
from ingest, exact Content-Length, guard at 3.8 GB. Singles and zips serve R2 bytes
verbatim — the system never re-encodes a delivery file.

**Vetoes ("round 2" — social-media consent).** Per-photo "Don't post" toggle, available
alongside favorites picking and after marks submit (guided then by a round-2 banner).
Unlimited, never locks, editable for the gallery's life, audit-logged (`veto-added` /
`veto-removed` events with viewer name). Untouched frames are OK to post — the veto is
the exception list, surfaced in admin (Marks panel → Social vetoes, copyable).

**Lifecycle.** draft → live → (marks submitted → polishing via versions) → expiry.
Deletion is LOGICAL: expiry (of live AND draft galleries) or a typed-confirm delete
tombstones instantly and stamps `purge_after = +7 days`; the bytes are untouched until
the purge pass batch-deletes them — so "undo" is a one-click restore within the grace,
and no copy storm ever runs (an earlier trash/-prefix design would have blown the
Workers subrequest cap). Photo removal is soft the same way. Daily cron stages each run
isolated (one failure never blocks deletion): T−14/T−3 photographer emails whose flags
commit ONLY on Resend acceptance, expiry, the two purge passes, a reconciliation pass
(no-record prefixes AND purge-incomplete leftovers), and a capped comment digest.
Never R2 lifecycle rules (they'd fight the Extend button). The paper trail — titles,
threads, mark lists, events — survives as rows.

**Admin** (`/admin`, Cloudflare Access in production + SELECTS_ADMIN_TOKEN underneath):
browser sessions bootstrap by POSTing the token to `/admin/session` (never a query
string — that would persist the secret in history and edge logs); the cookie stores an
HMAC-derived value, all compares are timing-safe. Coverage matrix (thumbnails via an
authed admin media route, so drafts render), share panel with rotate, marks view with
Copy filenames + reopen, a photo-centric Notes pane (strip of noted photos → open photo + its thread + inline reply; per-note and per-photo "addressed", proactive notes on any photo, keyboard: ↑↓/J K, R, ⌘↩, A; the Photos table's Notes column jumps into it), extend / archive-zip /
typed-confirm delete / restore-within-grace. Uploads are verified against their
declared size after the R2 put. The ingest gates fail closed: no preview gain map,
unreadable metadata, GPS tags, or a non-upright HDR preview all refuse with an
explicit override flag.
