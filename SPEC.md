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

## Design tokens (from the approved plan)

```css
:root {
  --paper:     #F1EEE5;  /* page ground — warm bone */
  --ink:       #33291E;  /* warm near-black text */
  --ink-soft:  #6E5D4A;  /* secondary text */
  --ink-faint: #94846F;  /* captions, datelines */
  --line:      #DAD3C4;  /* hairlines, borders */
  --card:      #EAE6DA;  /* raised surfaces */
  --accent:    #7A4A2B;  /* links, active nav, CTAs — deep sepia */
}
```

Type:
- Serif (display + body): `"Newsreader Variable", Georgia, serif` — editorial monograph voice.
  H1 clamp(1.9rem→2.5rem) weight 400; body 1.04rem/1.72.
- Grotesque (nav, captions, labels, buttons, tables): `"Archivo Variable", Helvetica, Arial, sans-serif`,
  small sizes, uppercase with letter-spacing 0.14–0.18em for labels/nav.
- Wordmark: RYUXIK, grotesque, letter-spacing 0.34em, uppercase.
- Running text max-width 66ch. Headings `text-wrap: balance`.

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
cover: ./001.jpg              # required, image() schema
featured: 10                  # sort weight desc within same-date; default 0
```

Caption format on the stream: `{subject}{client ? ` for ${client}` : ""} · {Mon 'YY}` — grotesque,
small, --ink-faint. Genre appears in a per-shoot label ONLY in the optional list view, never as nav.

Stream order: date desc, then featured desc. Creative portraiture leads naturally via dates/weights.

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
