# Launch checklist — ryuxik.io

Everything between "the build passes locally" and "the old Angular app is switched off."
Work top to bottom; steps 5–7 are the only ones that touch live DNS, and they are ordered so
the site is already serving before anything points at it.

Nothing here needs an account you already have. Steps 1 and 3 create the two you don't.

---

## 1. Cal.com — account and the two event types

The page hardcodes nothing; both embeds read their `data-cal-link` from `src/config.ts`. The
slugs below must match those values **exactly**, or the embed renders Cal's "event not found".

1. Sign up at [cal.com](https://cal.com) and claim the username **`ryuxik`** during onboarding.
   Both config values start with it (`ryuxik/intro-call`, `ryuxik/headshots`). If the username is
   taken, pick another and update `calConsult` + `calHeadshots` in `src/config.ts` to match.
2. Connect a calendar (Google/Apple/Outlook) so Cal can read your real availability. Skipping
   this is the #1 cause of double-bookings.
3. Set your **Availability** schedule — the hours you will actually shoot, not the hours you are awake.
4. **Event type 1 — the free consult.**
   - Title: `Intro call` → check that the URL slug lands on **`intro-call`** (edit it if Cal
     generates `intro-call-1` or similar).
   - Duration: **20 minutes**. Location: Cal Video or phone.
   - Price: none. This one is deliberately free — it is the top of the creative-project track.
5. **Event type 2 — the self-serve session.**
   - Title: `Headshots` → slug must be **`headshots`**.
   - Duration: your real headshot block (60–90 min is typical). TODO(ryu): decide.
   - Location: your studio address or "to be confirmed".
6. **Stripe retainer on the headshots event only.**
   - Cal.com → **Apps** → **Stripe** → Install → connect (or create) your Stripe account.
   - Open the `Headshots` event type → **Apps** tab → enable Stripe → set the **retainer**
     amount, not the full session fee. Cal charges this at booking time; you invoice the
     balance after delivery.
   - The FAQ copy on /sessions says **non-refundable retainer** with a **48-hour reschedule
     window**. Make the Stripe description and your Cal cancellation policy say the same thing,
     or the page is writing cheques your booking flow does not honour.
   - Test in Stripe **test mode** first (step 8), then flip to live keys.
7. **Buffers and lead times** — on both event types, **Limits** tab:
   - Before/after event buffer: **30 minutes** (travel, setup, teardown).
   - Minimum notice: **48 hours** on `headshots` (matches the reschedule window), **4 hours**
     on `intro-call` (a call is cheap to take).
   - Future booking limit: rolling **60 days**, so your calendar can't get mortgaged a year out.
   - Optional: cap `headshots` at 1–2 bookings/day so you don't book three shoots back to back.

> The embeds lazy-load on scroll and show a styled fallback ("Email {email} and I'll reply
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
| HDR                  | **HDR Output** checked, **Maximize Compatibility** checked — this pair is what writes the ISO 21496-1 gain map |
| Quality              | **95**                                                                 |
| Resize to fit        | **Long edge 2560 px**                                                  |
| Color space          | sRGB (Display P3 also fine)                                             |
| Metadata             | keep                                                                    |
| Rotation             | baked into the pixels — an HDR master relying on an EXIF orientation tag is refused by the build |

**Author the SDR preview sliders per image.** One file carries both renditions; the SDR preview is
what Firefox, older Safari, and every SDR display will see. Left at the default it is an
unreviewed photograph with your name on it.

Check every export before it goes into a shoot folder:

```sh
node scripts/check-hdr.mjs ~/Desktop/portfolio-picks
# GAIN MAP column must read HDR on every row; MPF 2 and ISO yes confirm it at the byte level
```

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
      (`Person`) and `/sessions` (`ProfessionalService` + three `Service` nodes). Zero errors.
      A warning about missing `address`/`priceRange` is expected while `SITE.city` and the tier
      prices are placeholders — those are omitted on purpose, not broken.
- [ ] Both Cal embeds load on `/sessions`. Then block `cal.com` in devtools and reload: the
      fallback email block must appear, never an empty box.
- [ ] Book a real test slot on each event type. Confirm the calendar invite, the confirmation
      email, and — for `headshots` — the Stripe charge. Refund it and cancel the booking.
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
- [ ] `src/pages/sessions.astro` — tier names, prices and deliverable counts
      ("starting at $TODO"); the two testimonial blockquotes (real quote, name, role, photo);
      the turnaround windows in the FAQ; the travel radius answer.
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
- [ ] `src/config.ts` → `calConsult` / `calHeadshots` — must match the step-1 slugs.
- [ ] `src/config.ts` → `formEndpoint` — empty until you pick an option in step 2.

### Non-blocking — quality and polish

- [ ] `src/components/Seo.astro` — add `twitter:creator` once the X/Twitter handle is confirmed.
- [ ] `src/components/SessionsJsonLd.astro` — add `offers` (price + currency) per tier and
      `priceRange` on the business node **only after** the prices on the page are real. Schema
      that disagrees with the page is worse than schema that is silent.
- [ ] `src/components/PersonJsonLd.astro` — pass an explicit `name` if the credited name differs
      from the brand.
- [ ] `src/lib/photos.ts` — real per-frame alt text once the placeholders are gone.
