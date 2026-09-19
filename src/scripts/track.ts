/**
 * First-party funnel tracker (SPEC.md § Site analytics). Loaded once, from
 * BaseLayout. Batches a closed vocabulary of events and sendBeacons them to
 * the site's own Worker at /api/e — no cookies, no third party, no PII.
 *
 * Instrumentation is declarative, so it is greppable and adding a signal is
 * adding an attribute:
 *   data-ev="cta:lost"      on a clickable  → `click`  detail cta:lost
 *   data-ev-view="book"     on a section    → `view`   detail book, once it has
 *                                             held the middle of the viewport 1s
 * Links need no attribute: mailto, outbound and internal clicks are labelled
 * from their href. <details class="faq"> openings report as `faq`.
 * Inline islands (CalEmbed) report through the window.fxq queue:
 *   (window.fxq = window.fxq || []).push(['cal', 'ready', 1180])
 *
 * Identity: `sid` lives in sessionStorage (30 min idle starts a new one);
 * `vid` is a random id in localStorage so a return visit days later is
 * recognisable — skipped entirely under Global Privacy Control / Do Not Track.
 * Times are sent relative to the session start, so the visitor's clock never
 * matters. Everything is wrapped so that analytics can never break a page.
 */

declare const __SITE_BUILD__: string;

type Queued = { q: number; t: number; p: string; n: string; d: string; v: number | null };
type Dims = { lp: string; tag: string; utm: string; ref: string; n: number; build: string; internal: 0 | 1 };
type Session = { id: string; t0: number; last: number; seq: number; engaged: boolean; dims: Dims };

const ENDPOINT = '/api/e';
const IDLE_MS = 30 * 60 * 1000;
const FLUSH_MS = 2500;
const DWELL_MS = 1000;
const S_KEY = 'fx_s';
const V_KEY = 'fx_v';
const INTERNAL_KEY = 'fx_internal';
const DEBUG_KEY = 'fx_debug';

const read = (store: () => Storage, key: string): string | null => {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
};
const write = (store: () => Storage, key: string, value: string): void => {
  try {
    store().setItem(key, value);
  } catch {
    /* private mode / storage blocked: the session just lives in memory */
  }
};
const local = () => window.localStorage;
const session = () => window.sessionStorage;

const randomId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let id = '';
  for (const byte of bytes) id += (byte % 36).toString(36);
  return id;
};

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

function start(): void {
  // Production host only. `localStorage.fx_debug = 1` opts a dev origin in.
  const siteHost = new URL(import.meta.env.SITE ?? location.origin).hostname;
  const host = location.hostname;
  if (host !== siteHost && host !== `www.${siteHost}` && read(local, DEBUG_KEY) !== '1') return;
  if (navigator.webdriver) return;

  const pagePath = document.documentElement.dataset.fxPath || location.pathname;
  const queue: Queued[] = [];
  let flushTimer = 0;

  /* ---- who and from where ------------------------------------------------ */
  const params = new URLSearchParams(location.search);
  const tag = (params.get('s') ?? '').slice(0, 48);
  const utm = (params.get('utm_source') ?? '').slice(0, 48);
  if (tag) {
    // Read once, then take it out of the address bar: a link copied to a
    // friend must not carry somebody else's source with it.
    params.delete('s');
    const query = params.toString();
    try {
      history.replaceState(history.state, '', location.pathname + (query ? `?${query}` : '') + location.hash);
    } catch {
      /* cosmetic only */
    }
  }
  if (tag === 'me') write(local, INTERNAL_KEY, '1'); // ryuxik.io/?s=me marks this browser as the photographer's

  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; connection?: { effectiveType?: string } };
  const optedOut = nav.globalPrivacyControl === true || navigator.doNotTrack === '1';

  let state: Session | null = null;
  try {
    state = JSON.parse(read(session, S_KEY) ?? 'null') as Session | null;
  } catch {
    state = null;
  }

  function referrerHost(): string {
    try {
      return document.referrer ? new URL(document.referrer).hostname : '';
    } catch {
      return '';
    }
  }

  function newSession(refHost: string): Session {
    let visits = 1;
    if (!optedOut) {
      try {
        const known = JSON.parse(read(local, V_KEY) ?? 'null') as { id: string; n: number } | null;
        const visitor = known && typeof known.id === 'string' ? known : { id: randomId(), n: 0 };
        visitor.n += 1;
        visits = visitor.n;
        write(local, V_KEY, JSON.stringify(visitor));
      } catch {
        /* no visitor id this time */
      }
    }
    const now = Date.now();
    return {
      id: randomId(),
      t0: now,
      last: now,
      seq: 0,
      engaged: false,
      dims: { lp: pagePath, tag, utm, ref: refHost, n: visits, build: __SITE_BUILD__, internal: 0 },
    };
  }

  const stale = (s: Session) => Date.now() - s.last > IDLE_MS;
  // A different deliberate tag (or utm_source) mid-session is a new arrival,
  // not a continuation.
  const campaign = tag || utm;
  if (!state || typeof state.id !== 'string' || stale(state) || (campaign && campaign !== (state.dims.tag || state.dims.utm)))
    state = newSession(referrerHost());

  const visitorId = (): string | undefined => {
    if (optedOut) return undefined;
    try {
      return (JSON.parse(read(local, V_KEY) ?? 'null') as { id?: string } | null)?.id;
    } catch {
      return undefined;
    }
  };

  /* ---- queue + transport -------------------------------------------------- */
  function flush(): void {
    window.clearTimeout(flushTimer);
    flushTimer = 0;
    if (!state || queue.length === 0) return;
    const body = JSON.stringify({
      sid: state.id,
      vid: visitorId(),
      now: Date.now() - state.t0,
      s: { ...state.dims, internal: read(local, INTERNAL_KEY) === '1' ? 1 : 0 },
      e: queue.splice(0, queue.length),
    });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, body)) return;
      void fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {});
    } catch {
      /* dropped — analytics never throws into the page */
    }
  }

  function track(name: string, detail = '', value: number | null = null, urgent = false): void {
    if (!state) return;
    if (stale(state)) {
      // The tab sat idle past the session window: this is a new visit.
      flush();
      state = newSession('');
      push('pv', '', null);
    }
    push(name, detail, value);
    if (urgent) flush();
    else if (!flushTimer) flushTimer = window.setTimeout(flush, FLUSH_MS);
  }

  function push(name: string, detail: string, value: number | null): void {
    if (!state) return;
    const now = Date.now();
    queue.push({ q: state.seq, t: now - state.t0, p: pagePath, n: name, d: detail, v: value });
    state.seq += 1;
    state.last = now;
    write(session, S_KEY, JSON.stringify(state));
  }

  /* ---- signals ------------------------------------------------------------ */
  track('pv', '', null, true);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) track('pv', 'bfcache', null, true);
  });

  // Human = a trusted input event. Programmatic scrolling (screenshot bots,
  // link previewers) never produces one.
  let lcp = 0;
  let lcpFinal = false;
  const inputs = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const;
  const onInput = (event: Event) => {
    if (!event.isTrusted || !state) return;
    for (const type of inputs) window.removeEventListener(type, onInput, true);
    lcpFinal = true; // LCP is a load metric: whatever paints after the first input is not it
    if (state.engaged) return;
    state.engaged = true;
    track('engaged');
  };
  for (const type of inputs) window.addEventListener(type, onInput, { capture: true, passive: true });

  // Scroll depth, as milestones so a lost exit beacon costs nothing.
  const milestones = [25, 50, 75, 100];
  let scrollQueued = false;
  window.addEventListener(
    'scroll',
    () => {
      if (scrollQueued || milestones.length === 0) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        const height = document.documentElement.scrollHeight;
        if (height <= 0) return;
        const depth = ((window.scrollY + window.innerHeight) / height) * 100;
        while (milestones.length > 0 && depth >= milestones[0] - 0.5) {
          const mark = milestones.shift() ?? 0;
          track('scroll', String(mark), mark);
        }
      });
    },
    { passive: true }
  );

  // Sections: "seen" means it held the middle of the viewport for a second.
  let lastSection = '';
  if ('IntersectionObserver' in window) {
    const timers = new Map<Element, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          window.clearTimeout(timers.get(el));
          if (!entry.isIntersecting) continue;
          timers.set(
            el,
            window.setTimeout(() => {
              observer.unobserve(el);
              lastSection = el.dataset.evView ?? '';
              track('view', lastSection);
            }, DWELL_MS)
          );
        }
      },
      { rootMargin: '-45% 0px -45% 0px' }
    );
    for (const el of document.querySelectorAll('[data-ev-view]')) observer.observe(el);
  }

  // Clicks. data-ev wins; bare links are labelled from where they go.
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const marked = target?.closest<HTMLElement>('[data-ev]');
      if (marked) return track('click', marked.dataset.ev ?? '', null, true);
      const link = target?.closest<HTMLAnchorElement>('a[href]');
      if (!link) return;
      const href = link.getAttribute('href') ?? '';
      if (href.startsWith('mailto:')) return track('click', 'mailto', null, true);
      if (href.startsWith('#')) return track('click', `to:${href}`, null, true);
      try {
        const url = new URL(link.href);
        if (url.host !== location.host) return track('click', `out:${url.hostname.replace(/^www\./, '')}`, null, true);
        track('click', `to:${url.pathname}${url.hash}`, null, true);
      } catch {
        /* unparseable href: not worth a row */
      }
    },
    true
  );

  // FAQ openings — which objections are live. `toggle` doesn't bubble: capture.
  document.addEventListener(
    'toggle',
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLDetailsElement) || !el.open || !el.classList.contains('faq')) return;
      track('faq', slugify(el.querySelector('summary')?.textContent ?? ''));
    },
    true
  );

  // LCP: the HDR frames are heavy, and a slow first paint in an in-app
  // browser on cellular is a bounce nobody would otherwise see.
  let perfSent = false;
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const latest = entries[entries.length - 1];
      if (latest && !lcpFinal) lcp = latest.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    /* Safari < 26: no LCP entry type */
  }

  // Leaving (or backgrounding): where they were, and for how long.
  let visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;
  let visibleMs = 0;
  let exitAt = -1;
  let exitSection = '';
  const onHidden = () => {
    if (visibleSince) visibleMs += Date.now() - visibleSince;
    visibleSince = 0;
    if (!perfSent && lcp > 0) {
      perfSent = true;
      track('perf', nav.connection?.effectiveType ?? '', Math.round(lcp));
    }
    const seconds = Math.round(visibleMs / 1000);
    if (exitAt < 0 || seconds - exitAt >= 5 || lastSection !== exitSection) {
      exitAt = seconds;
      exitSection = lastSection;
      track('exit', lastSection, seconds);
    }
    flush();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onHidden();
    else visibleSince = Date.now();
  });
  window.addEventListener('pagehide', onHidden);

  // Inline islands queue before this module runs; drain, then go live.
  type Hook = [string, string?, number?];
  const hooks = window as Window & { fxq?: Hook[] | { push: (hook: Hook) => void } };
  const report = (hook: Hook) => track(hook[0], hook[1] ?? '', hook[2] ?? null, true);
  if (Array.isArray(hooks.fxq)) for (const hook of hooks.fxq) report(hook);
  hooks.fxq = { push: report };
}

try {
  const doc = document as Document & { prerendering?: boolean };
  if (doc.prerendering) document.addEventListener('prerenderingchange', start, { once: true });
  else start();
} catch {
  /* analytics never breaks the page */
}
