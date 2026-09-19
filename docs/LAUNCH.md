# Launch checklist — ryuxik.io

Everything between "the build passes locally" and "the old Angular app is switched off."
Work top to bottom; steps 5–7 are the only ones that touch live DNS, and they are ordered so
the site is already serving before anything points at it.

Nothing here needs an account you already have. Steps 1 and 3 create the two you don't.

---

## 1. Cal.com — account and the one event type

The page hardcodes nothing; the embed reads its `data-cal-link` from `src/config.ts`. The slug
below must match that value **exactly**, or the embed renders Cal's "event not found".

1. Sign up at [cal.com](https://cal.com) and claim the username **`ryuxik`** during onboarding.
   The config value starts with it (`ryuxik/cinematic-portrait`). If the username is taken, pick
   another and update `calSession` in `src/config.ts` to match.
2. Connect a calendar (Google/Apple/Outlook) so Cal can read your real availability. Skipping
   this is the #1 cause of double-bookings.
3. Set your **Availability** schedule — the hours you will actually shoot, not the hours you are awake.
4. **The event type — the session.**
   - Title: `Cinematic Portrait Session` → check that the URL slug lands on
     **`cinematic-portrait`** (edit it if Cal generates something longer).
   - Duration: **120 minutes**. The page promises two hours.
   - Location: "to be confirmed". Every session is on location, and the planning call settles where.
5. **Stripe deposit on the event.**
   - Cal.com → **Apps** → **Stripe** → Install → connect (or create) your Stripe account.
   - Open the event type → **Apps** tab → enable Stripe → set the amount to the **$150 deposit**,
     not the full session fee. Cal charges this at booking time; the balance is due on the day
     of the shoot.
   - The copy on /sessions says: the $150 deposit comes off the total, reschedules are free with
     48 hours notice, cancellations a week or more out are refunded in full, inside a week the
     deposit stays as credit, and same-day cancellations and no-shows forfeit it. Make the Stripe
     description and your Cal cancellation policy say the same thing, or the page is writing
     cheques your booking flow does not honour.
   - Test in Stripe **test mode** first (step 8), then flip to live keys.
6. **Buffers and lead times** — **Limits** tab:
   - Before/after event buffer: **30 minutes** (travel, setup, teardown).
   - Minimum notice: **48 hours** (matches the reschedule window).
   - Future booking limit: rolling **60 days**, so your calendar can't get mortgaged a year out.
   - Optional: cap at 1–2 bookings/day so you don't book three shoots back to back.

> The embed lazy-loads on scroll and shows a styled fallback ("Email {email} and I'll reply
> within 24h") if Cal is blocked or slow. Nothing breaks if this step is delayed — the page just
> shows the fallback. Ship without it if you must.

---

## 2. Inquiry form endpoint — pick one

`SITE.formEndpoint` is empty right now, which is a supported state: the form hides itself and a
mailto block shows instead. The site can launch exactly like that. When you want the form:

### Option A — Formspree (free tier)

Set `formEndpoint` to the Formspree URL (`https://formspree.io/f/xxxxxxxx`) and redeploy. Done.

- **For:** zero code, zero infrastructure, built-in spam filtering, submissions archived in
  their dashboard, works with the honeypot field the form already has.
- **Against:** **50 submissions/month** on the free tier and a third party stores your leads.
  A plain (non-AJAX) POST lands the visitor on a Formspree thank-you page, not on ryuxik.io.
- **Verdict:** correct choice unless you expect real volume. Start here.

### Option B — Cloudflare Pages Function + Resend

Add a top-level `functions/api/inquiry.ts` (Pages compiles it alongside the static `dist/`; no
Astro adapter needed, the site stays `output: 'static'`), have it POST to
[Resend](https://resend.com), and set `formEndpoint` to `/api/inquiry`.

- **For:** same origin so the visitor never leaves the site, no submission cap, no third party
  holding the data, and the email arrives from your own domain.
- **Against:** you own spam handling (add a Cloudflare Turnstile widget), you own error states,
  and Resend requires **verifying the domain — which means adding DNS TXT + DKIM records**. Note
  that the zone currently has none (see step 6); this option is the one thing that would change that.
- **Verdict:** move here if Formspree's cap or its thank-you page starts to bite.

Either way, keep the honeypot field and the "I reply within 24 hours" line honest.

---

## Photos — HDR masters, and how they must be served

Unnumbered on purpose: this one is not a step, it is a set of constraints that decide whether the
site ships true HDR or quietly ships flat SDR. Read it before the first deploy with real work.

### Export spec (Lightroom Classic / Lightroom)

| Setting              | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| Image format         | **JPEG**                                                               |
| HDR                  | **HDR Output** checked                                                 |
| Quality              | **90–95**                                                              |
| Resize to fit        | **Long edge 2560 px**                                                  |
| Color space          | sRGB (Display P3 also fine)                                             |
| Metadata             | keep                                                                    |
| Rotation             | baked into the pixels — an HDR master relying on an EXIF orientation tag is refused by the build |

**HDR Output + JPEG is the whole recipe.** Lightroom 9.5 writes the ISO 21496-1 gain map into that
JPEG by itself — there is no "Maximize Compatibility" checkbox to find, and earlier drafts of this
document calling for one were wrong (it is a Photoshop setting). Verified across 38 exports: MPF
index with 2 images, ISO 21496-1 marker, `hdrgm:Version="1.0"` in the XMP, on every single one.
Those JPEGs **are** the masters — copy them into the shoot folder as `<stem>.jpg` and nothing else
has to happen.

**Author the SDR preview sliders per image.** One file carries both renditions; the SDR preview is
what Firefox, older Safari, and every SDR display will see. Left at the default it is an
unreviewed photograph with your name on it.

Check every export before it goes into a shoot folder:

```sh
node scripts/check-hdr.mjs ~/Desktop/portfolio-picks
# GAIN MAP column must read HDR on every row; MPF 2 and ISO yes confirm it at the byte level
```

### If the masters come out as AVIF

Lightroom's HDR **AVIF** export behaves differently: it writes a single PQ rendition (CICP 12/16)
with **no gain map**, and no export setting adds one. AVIF is also not the delivery format — sharp
can only read a gain map out of a JPEG. So an AVIF master needs a second, SDR export of the same
photographs to pair with, and `scripts/convert-masters.mjs` (first in `npm run generate`) computes
the gain map from the two and writes the `.jpg` master.

The second export: **same catalogue, same edits, same 2560px long edge**, JPEG, quality 90–95,
sRGB or Display P3, rotation baked in. Same dimensions is not a nicety — a gain map is a per-pixel
ratio, and the converter refuses a pair that disagrees rather than resampling.

Name the halves so the converter can find them, and let it write the third file:

```
src/content/shoots/<slug>/001.avif      HDR master     gitignored
src/content/shoots/<slug>/001.sdr.jpg   SDR master     gitignored
src/content/shoots/<slug>/001.jpg       ← generated, and committed
```

```sh
npm run generate                                       # pairs → 001.jpg
node scripts/check-hdr.mjs src/content/shoots/<slug>   # every .jpg row must read HDR
git add src/content/shoots/<slug>                      # picks up only the .jpg
```

The SDR master is copied into the output container byte-for-byte — measured base RMSE 0.0000, max
|delta| 0 — so the photograph you graded is literally the one that ships. The converter never
synthesises an SDR base by tone mapping, which is the one thing this pipeline never does.

One-time setup on the machine that adds masters, and nowhere else:

```sh
brew install libavif libultrahdr
```

CI does not need either package: the converted `.jpg` masters are committed, and the script warns
and skips rather than failing when the tools are absent.

**`check-hdr` cannot read an AVIF's gain map** — sharp/libvips only parse gain maps in JPEG, so an
AVIF master shows as `sdr` in the table no matter what it contains. That is a limitation of the
checker, not a verdict on the file. The `.jpg` rows are the ones that matter; to inspect an AVIF
directly, use libavif:

```sh
avifdec --info master.avif                      # Transfer Char. 16 = PQ, Gain map: Absent
avifgainmaputil printmetadata master.avif       # errors when there is genuinely no gain map
```

Failure modes the converter reports by name:

- **Half a pair.** An `.avif` whose `.sdr.jpg` has not been exported yet logs "awaiting SDR export"
  and the run continues — the folder can fill up in batches. A `.sdr.jpg` with no `.avif` is a
  note: an SDR export alone cannot become a gain-map JPEG (rename it to `<stem>.jpg` if you meant
  to publish it as a plain SDR photograph).
- **Size mismatch between the halves.** Hard error, naming both sizes. Re-export.
- **Master wider than 8192px.** Homebrew's `libultrahdr` is compiled with an 8192×8192 ceiling, so
  a full-resolution 61MP export (9504×6336) is rejected. Exporting at the documented 2560px long
  edge avoids it entirely; the alternative is rebuilding libultrahdr from source with
  `-DUHDR_MAX_DIMENSION=16384` and pointing `$ULTRAHDR_APP` at the binary.

### No transforming CDN or image service in front. Ever.

`public/photos/` must be served **byte-for-byte as static files**. Cloudflare Polish, Mirage,
Image Resizing / Images, any "automatic image optimization" toggle, and every third-party image
CDN re-encode what they proxy — and re-encoding drops the gain map. The photographs stay valid and
still look fine, which is exactly why this fails silently: nothing errors, the HDR just quietly
stops happening.

- Cloudflare dashboard → **Speed → Optimization → Image Optimization**: Polish **off**, Mirage
  **off**. (Both are off by default on the Free plan — confirm rather than assume.)
- Do not put the site behind an image proxy, and do not enable Images transformations on this zone.
- Re-verify after any dashboard change: `curl -sI https://ryuxik.io/photos/<slug>/<file>-2048.jpg`
  should return `content-type: image/jpeg` and **no** `cf-polished` header. Then download it and
  run `node scripts/check-hdr.mjs` on the downloaded copy — that is the only test that proves the
  bytes survived the wire.

### Build time — the AVIF ladder is the slow part

Every image is encoded 3 widths × 2 formats, and AVIF is roughly ten times slower than JPEG. The
generator prints a per-image line and a total (`jpeg …s, avif …s`) so this stays measurable. With
11 placeholder images it is a few seconds; with ~90 real 2560px masters expect the first cold build
to run into **many minutes**, and Cloudflare's build container is slower than a laptop and has a
build-time limit. The cache is keyed on mtime + size, and `public/photos/` is gitignored, so **a CI
build is always a cold build** — it re-encodes everything, every time.

If that becomes painful, the supported alternative is to build locally and deploy the output
directly:

```sh
npm run build
npx wrangler pages deploy dist --project-name=<your-pages-project>
```

Same artifact, no build container, and the incremental cache on your machine means only new
photographs are ever encoded. The trade is that deploys are no longer automatic on `git push` —
so decide deliberately, and keep the Git integration connected either way for preview builds.

---

## 3. Cloudflare Pages — connect the repo

1. Merge `revamp` into the production branch and push.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
   Authorise GitHub, pick the repo, set the production branch.
3. Build settings:
   | Field                | Value           |
   | -------------------- | --------------- |
   | Framework preset     | Astro           |
   | Build command        | `npm run build` |
   | Build output directory | `dist`        |
   | Root directory       | `/`             |
4. **Environment variables → add `NODE_VERSION` = `22.19.0`, for Production *and* Preview.**
   This is not optional. Local development runs Node 22.13.1, but a transitive `undici@8`
   declares `engines.node >= 22.19`; on a build image with an older default Node the install
   fails or — worse — warns and then breaks at runtime. Pin it explicitly.
5. **Save and Deploy.** Watch the log: `npm run build` runs `astro check` (strict TS) before
   `astro build`, and the `prebuild` hook regenerates the photo metadata, the whole
   `public/photos/` HDR ladder, and the OG cards. All three generated directories are gitignored,
   so this must succeed on a clean checkout — if it doesn't, the failure is real, not
   environmental. Expect the photo step to dominate the build time; see § Photos.
6. Open the `*.pages.dev` URL and click through all four pages **before** touching DNS.

---

## 4. Custom domain — add it BEFORE the nameserver switch

Order matters. Adding the domain to Cloudflare first means that the moment nameservers cut over,
the site is already there. Reverse the order and you get a window of downtime plus a failed cert.

1. Pages project → **Custom domains** → **Set up a domain** → enter `ryuxik.io`.
2. Cloudflare will notice the zone is not on its account and walk you through **adding the site**
   (Free plan is enough). It scans the existing zone and imports what it finds.
3. Review the imported records against [`dns-snapshot-2026-08-12.txt`](./dns-snapshot-2026-08-12.txt).
   **Delete** the four App Engine `A` records, the four `AAAA` records, and the `www` CNAME to
   `ghs.googlehosted.com` — every one of them points at the app you are retiring.
4. Add `www.ryuxik.io` as a second custom domain (or a redirect rule `www → apex`). Pick one and
   be consistent: the canonical URLs the site emits are apex, no `www`.
5. Cloudflare shows you **two assigned nameservers** (e.g. `xxx.ns.cloudflare.com`). Copy them.
   Do not proceed until you have them.

---

## 5. Squarespace Domains — change the nameservers

`ryuxik.io` was a Google Domains registration; those moved to Squarespace Domains. The zone is
currently served by Google Cloud DNS (`ns-cloud-c1…c4.googledomains.com`).

1. Sign in to [Squarespace Domains](https://account.squarespace.com/domains) → `ryuxik.io` → **DNS**.
2. **Nameservers** → switch from the Squarespace/Google defaults to **Use custom nameservers**.
3. Replace all existing entries with the two Cloudflare nameservers from step 4.5. Save.
4. Propagation is usually under an hour, occasionally up to 48. Cloudflare emails you when the
   zone goes **Active**; the Pages custom domain flips to **Active** shortly after and Universal
   SSL issues automatically.

**Nothing else needs migrating.** The snapshot shows the zone has **no MX records and no TXT
records** — no mail, no SPF/DKIM/DMARC, no domain-verification tokens. The only live records were
the App Engine A/AAAA set and the `www` CNAME, all replaced in step 4.3. This is as clean a move
as DNS gets. Keep the snapshot file in the repo as the rollback record.

---

## 6. Post-launch verification

Run this list once the zone is Active. Anything that fails here is cheaper to fix now than after
Google has crawled it.

- [ ] `https://ryuxik.io` loads; `https://www.ryuxik.io` reaches the same site (or redirects).
- [ ] Valid HTTPS certificate, no mixed-content warnings in the console.
- [ ] All four pages render: `/`, `/sessions`, `/information`, and a bogus path → the 404 page
      (wordmark, "Nothing here.", `→ Overview`, and `<meta name="robots" content="noindex, follow">`).
- [ ] `/robots.txt`, `/sitemap-index.xml`, `/image-sitemap.xml` each return 200. The image
      sitemap's `<image:loc>` values are stable `/photos/<slug>/<file>-<w>.jpg` URLs — open one and
      confirm it is a real image, not a 404.
- [ ] HDR survived the wire: download one `/photos/…` JPEG from the live site and run
      `node scripts/check-hdr.mjs` on it. `GAIN MAP: PRESENT` means the CDN is not transforming
      images (see § Photos). Then open `/` in Chrome 137+ or Safari 26+ on an HDR display — the
      photographs should visibly gain highlight range over what Firefox shows.
- [ ] `/og/home.jpg`, `/og/sessions.jpg`, `/og/information.jpg` are 1200×630 and show the
      wordmark. Paste a page URL into [opengraph.xyz](https://www.opengraph.xyz) and check the
      unfurl; then paste it into Slack and iMessage, which cache aggressively — get it right
      before you share the link anywhere.
- [ ] Exactly one `<title>`, one canonical, one meta description per page. View source and count.
- [ ] Canonicals are absolute, apex-domain, and match the sitemap's trailing-slash form.
- [ ] [Rich Results Test](https://search.google.com/test/rich-results) on `/information`
      (`Person`) and `/sessions` (`LocalBusiness` + one `Service` node). Zero errors.
- [ ] The Cal embed loads on `/sessions`. Then block `cal.com` in devtools and reload: the
      fallback email block must appear, never an empty box.
- [ ] Book a real test slot. Confirm the calendar invite, the confirmation email, and the
      Stripe deposit. Refund it and cancel the booking.
- [ ] If the inquiry form is live: submit it once and confirm the message arrives.
- [ ] Lighthouse mobile on `/`: LCP under 2.5s, CLS near zero. Exactly one image on the page is
      `loading="eager" fetchpriority="high" decoding="sync"` — the first frame, never lazy. Check
      the network waterfall.
- [ ] Google Search Console → add `ryuxik.io` as a **domain property** (DNS TXT verification,
      now trivial since Cloudflare holds the zone) → submit **both** sitemaps.
- [ ] Optional: same in Bing Webmaster Tools, which will import from Search Console.

---

## 7. Decommission the old stack

Wait about a week after launch — long enough to be sure you don't need to roll back.

1. **App Engine.** Google Cloud console → App Engine → **Settings** → **Disable application**.
   App Engine apps cannot be deleted individually; disabling stops all serving and billing. If
   nothing else lives in the project, **delete the whole project** instead — that is the only
   complete cleanup.
2. **Cloud DNS.** Delete the `ryuxik.io` managed zone. Remove the record sets first (the `SOA`
   and `NS` records delete with the zone). Confirm no other zone or resource references it.
3. **Billing.** Check the GCP billing report a full cycle later and confirm the line items are
   gone. A forgotten managed zone is a few cents a month forever.
4. Keep [`dns-snapshot-2026-08-12.txt`](./dns-snapshot-2026-08-12.txt) committed. It is the only
   record of what the zone looked like before the move.

---

## 8. The `TODO(ryu)` sweep

Every placeholder in the codebase is marked the same way, on purpose. Regenerate the live list
any time:

```sh
grep -rn "TODO(ryu)" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .
```

Snapshot at the time of writing, grouped by what it costs you to leave it:

### Blocking — visible placeholder text a visitor would read

- [ ] `src/pages/information.astro` — five inline spans in the bio: **origin**, **training**,
      **one credential**, **where the work appears**, **city**. They render as visible
      `TODO(ryu)` chips on the live page. This is the single highest-priority item.
- [ ] `src/pages/sessions.astro` — confirm every number in the `SESSION` const (price, gallery
      size, retouch count, turnaround) and the travel radius answer. Testimonials stay off the
      page until real quotes exist.
- [ ] `src/components/InquiryForm.astro` — the "I reply within 24 hours" window (twice).
- [ ] `src/content/shoots/*/index.md` — all three shoots are generated placeholders whose bodies
      say so. Replace the folders with real work (see README § Add a shoot) and delete
      `scripts/make-placeholders.mjs` once you never need it again.

### Blocking — configuration that changes behaviour

- [ ] `src/config.ts` → `name` — brand name vs. real name. Drives the wordmark, the OG card
      lettering and JSON-LD `Person.name`.
- [ ] `src/config.ts` → `email` — appears as the large serif link on /information, in JSON-LD,
      and in the Cal fallback.
- [ ] `src/config.ts` → `instagram` — footer, /information, JSON-LD `sameAs`.
- [ ] `src/config.ts` → `city` — while empty, `ProfessionalService` ships with **no** `address`
      and **no** `areaServed`. That is deliberate and clean, but it costs you local SEO. Filling
      it in is the cheapest ranking win on this list.
- [ ] `src/config.ts` → `calSession` — must match the step-1 slug.
- [ ] `src/config.ts` → `formEndpoint` — empty until you pick an option in step 2.

### Non-blocking — quality and polish

- [ ] `src/components/Seo.astro` — add `twitter:creator` once the X/Twitter handle is confirmed.
- [ ] `src/components/SessionsJsonLd.astro` — keep the service name, price and description in
      step with the `SESSION` const in sessions.astro. Schema that disagrees with the page is
      worse than schema that is silent.
- [ ] `src/components/PersonJsonLd.astro` — pass an explicit `name` if the credited name differs
      from the brand.
- [ ] `src/lib/photos.ts` — real per-frame alt text once the placeholders are gone.

## Selects — client galleries: provisioning & deploy

**Merge order warning:** once the `selects` branch is merged, `wrangler deploy`
validates the R2 bucket and D1 database bindings — merging BEFORE steps 1–2 below
blocks every site deploy (including unrelated typo fixes) until they run.

One-time, in this order (needs the Cloudflare account + Resend):

1. `npx wrangler r2 bucket create selects-media`
2. `npx wrangler d1 create selects-db` → paste the `database_id` into wrangler.jsonc.
3. `npx wrangler secret put SELECTS_ADMIN_TOKEN` — generate something long
   (`openssl rand -hex 24`); the same value goes in your shell env as
   `SELECTS_ADMIN_TOKEN` for the ingest CLI.
4. Email (optional, photographer-only) — CLOUDFLARE-NATIVE, no vendor: dashboard →
   ryuxik.io zone → **Email → Email Routing → enable** (it adds MX/TXT to the apex —
   this supersedes § 5's "no MX" stance, and gives you inbound hello@ryuxik.io
   forwarding as a bonus), then add **ryuxik@gmail.com as a destination address** and
   click its verification email. The worker's `send_email` binding (NOTIFY in
   wrangler.jsonc) then delivers from selects@ryuxik.io for free. Until Routing is
   enabled, sends fail over to Resend if RESEND_API_KEY is set, else log as no-ops —
   and notification flags only commit on an accepted send, so nothing is lost while
   this step waits. Resend (`mail.ryuxik.io` + secret) remains the fallback for the
   day native limits pinch. After enabling, send yourself a test (post a comment on a
   test gallery; the daily digest at 06:17 UTC delivers it) and check it lands in the
   Gmail inbox, not spam.
5. Cloudflare Access (Zero Trust → Applications): self-hosted app for
   `ryuxik.io/admin*`, allow only your identity — DONE 2026-08-26 (team
   lucky-star-0196). Covering `ryuxik.io/api/admin*` too blocks the ingest CLI's
   bearer at the edge; SETTLED 2026-08-26: the app
   covers both paths with an identity policy (browser) plus a **Service Auth**
   policy for the `selects-ingest` token; the CLI reads CF_ACCESS_CLIENT_ID /
   CF_ACCESS_CLIENT_SECRET from the shell (~/.zshrc) and sends the headers
   automatically. The workers.dev route is DISABLED in wrangler.jsonc
   (`workers_dev: false`) so the zone's Access cannot be sidestepped. Rotating the
   service token: Zero Trust → Access controls → Service credentials → ⋯ → Rotate
   secret, then update ~/.zshrc.
6. `npm run gallery:deploy` (= build + `wrangler deploy`). The D1 schema applies
   itself on first touch. The daily cron (06:17 UTC) is in wrangler.jsonc.
7. Cache rule sanity: gallery media sets its own `Cache-Control: max-age=3600` —
   rotation's 1-hour SLA depends on nothing overriding it (no "cache everything"
   page rules on /g/*). Polish/Mirage stay off zone-wide (§ 1) — they would re-encode
   gallery media exactly like portfolio media.

Per shoot, after Grain Studio (Master + Instagram + RedNote + **Web preview** rows):

    SELECTS_ADMIN_TOKEN=… node scripts/gallery-ingest.mjs ~/shoots/atelier-out \
      --gallery atelier-mora --title "Atelier Mora — spring lookbook" \
      --client "Nadia R." --n 3 --api https://ryuxik.io --live

Copy the printed share link, send it to the client, done. Local dev of the whole
surface: `npm run gallery:dev` (+ `.dev.vars` with SELECTS_ADMIN_TOKEN), ingest with
`--api http://127.0.0.1:8787`. Polish round: re-export the marked stems, re-run
ingest with `--replace`. Verify HDR end to end after ANY pipeline change:
`node scripts/check-hdr.mjs` on a downloaded ladder rung must say PRESENT.
