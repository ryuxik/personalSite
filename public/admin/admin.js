/* Selects admin behaviour (ES module). Talks to /api/admin/* with the session
 * cookie set by POST /admin/session (Cloudflare Access fronts everything in
 * production). Browser ingest (2026-08-26): pairs a Grain Studio web-set
 * folder, verifies against server state, and PUTs to the same upload API the
 * CLI uses — the GPS and gain-map gates live in the Worker, so both paths are
 * held to the same standard. */
import { rgbaToThumbHash, thumbHashToDataURL } from '/admin/vendor/thumbhash.js';

const $ = (s, el) => (el || document).querySelector(s);
const view = $('.admin').dataset.view;
const esc = (s) => { const d = document.createElement('span'); d.textContent = s ?? ''; return d.innerHTML; };
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
const api = (path, opts = {}) =>
  fetch(`/api/admin/${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.status);
    return data;
  });

/* Only the photographer ever loads this file (Cloudflare Access), so loading
 * it marks this browser's visits to the public site as internal — they stay
 * out of the funnel (SPEC.md § Site analytics; src/scripts/track.ts reads it). */
try { localStorage.setItem('fx_internal', '1'); } catch { /* storage blocked */ }

/* ---- byte helpers (mirror worker/lib/bytes.ts) -------------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const ISO = 'urn:iso:std:iso:ts:21496:-1';
const hasIsoGainMap = (bytes) => {
  const limit = Math.min(bytes.length, 262144);
  outer: for (let i = 0; i <= limit - ISO.length; i++) {
    for (let j = 0; j < ISO.length; j++) if (bytes[i + j] !== ISO.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
};

/* ------------------------------------------------------------- home */
if (view === 'home') {
  const list = $('#list');
  const paint = (galleries) => {
    list.innerHTML = galleries.length === 0
      ? '<p class="muted">No galleries yet — create one above, then add photos on its page.</p>'
      : galleries.map((g) => `
        <div class="gcard">
          <a href="/admin/g/${g.id}">${esc(g.title)}</a>
          <span class="chip ${g.status}">${g.status}</span>
          ${g.marks_state === 'submitted' ? '<span class="chip submitted">marks in</span>' : ''}
          ${g.open_notes > 0 ? `<span class="chip notes">${g.open_notes} to answer</span>` : ''}
          <span class="meta">${g.photo_count} photo(s) · ${g.marked_count}/${g.n_marks} marked · until ${g.expiry_at.slice(0, 10)}</span>
        </div>`).join('');
  };
  api('galleries').then((r) => paint(r.galleries)).catch((e) => (list.textContent = `Failed: ${e.message}`));
  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const r = await api('galleries', { method: 'POST', body: {
      title: f.get('title'), client: f.get('client'),
      n: Number(f.get('n')), expiry_days: Number(f.get('expiry_days')),
    }});
    if (r.existed) {
      // A slug collision must never silently merge two clients' shoots.
      const open = confirm(
        `A gallery "${r.gallery.slug}" already exists` +
        (r.gallery.client_name ? ` (client: ${r.gallery.client_name})` : '') +
        `.\n\nOK opens the EXISTING gallery. Cancel to pick a different title/slug.`);
      if (!open) return;
    }
    location.href = `/admin/g/${r.gallery.id}`;
  });
} else if (view === 'gallery') {

/* ---------------------------------------------------------- gallery */
const id = $('.admin').dataset.id;
const SHOWN = ['original', 'instagram', 'rednote', 'preview'];

/* ladder rungs, numerically (a string sort puts l1400 before l900) */
const rungWidths = (p) => Object.keys(p.assets ?? {})
  .filter((k) => /^l\d+$/.test(k)).map((k) => Number(k.slice(1))).sort((a, b) => a - b);
const thumbSrc = (p, mediaBase) => { const w = rungWidths(p); return w.length ? mediaBase(p, `l${w[0]}`) : ''; };
const viewSrc = (p, mediaBase) => {
  const w = rungWidths(p);
  if (!w.length) return '';
  return mediaBase(p, `l${w.find((x) => x >= 1200) ?? w[w.length - 1]}`);
};
/* D1 stamps 'YYYY-MM-DD HH:MM:SS' in UTC */
const stampToDate = (sql) => new Date(sql.replace(' ', 'T') + (/[Z+]/.test(sql.slice(10)) ? '' : 'Z'));
const ago = (sql) => {
  const m = Math.round((Date.now() - stampToDate(sql).getTime()) / 60000);
  if (!Number.isFinite(m)) return sql.slice(0, 10);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  return sql.slice(0, 10);
};
const whenLocal = (sql) => stampToDate(sql).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/* Notes pane state — survives load() re-renders so a reply never loses your
 * place, and the coverage table can jump straight to a photo. */
let notesState = null;      // { g, photos, comments, mediaBase, rows, byPhoto }
let selectedPhotoId = null;
let notesFilter = 'notes';  // 'notes' | 'all'
let focusComposerNext = false;
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

async function load() {
  const { gallery: g, photos, comments } = await api(`galleries/${id}`);
  const link = `${location.origin}/g/${g.slug}-${g.access_key}`;

  // The H1 is server-rendered; without this a successful rename looks like a
  // no-op until a hard reload.
  document.querySelector('.ahead h1').textContent = g.title;
  document.title = `${g.title} · Selects admin`;

  $('#summary').innerHTML = `<span class="chip ${g.status}">${g.status}</span>
    ${g.marks_state === 'submitted' ? '<span class="chip submitted">marks in</span>' : ''}
    ${photos.length} photo(s) · mark ${g.n_marks} · until ${g.expiry_at.slice(0, 10)}
    ${g.client_name ? ` · client: ${esc(g.client_name)}` : ''}
    <button class="linklike" id="rename">rename…</button>`;

  // Inline rename form. Never prompt()/confirm() chains here: Chrome throttles
  // stacked native dialogs ("prevent this page from creating additional
  // dialogs"), and a suppressed dialog returns null instantly — the whole
  // rename silently did nothing. A form can't be suppressed and reports
  // errors in place.
  const slugOf = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
  const slot = $('#rename-slot');
  slot.innerHTML = '';
  $('#rename').addEventListener('click', () => {
    if (slot.firstElementChild) { slot.innerHTML = ''; return; }
    slot.innerHTML = `
      <form class="rename-form">
        <label>Title (what the client sees)
          <input name="title" required maxlength="120" value="${escAttr(g.title)}"></label>
        <label>Client name (optional)
          <input name="client" maxlength="120" value="${escAttr(g.client_name || '')}"></label>
        <label class="chk rename-form__move" hidden>
          <input type="checkbox" name="move">
          <span>Move the link to match → <b class="url" data-preview></b><br>
            <span class="muted">the current link stops working the moment you save</span></span></label>
        <p class="rename-form__row">
          <button class="btn" type="submit">Save</button>
          <button class="btn btn--quiet" type="button" data-cancel>Cancel</button>
          <span class="muted" data-msg></span></p>
      </form>`;
    const form = slot.firstElementChild;
    const els = form.elements;
    const moveRow = form.querySelector('.rename-form__move');
    const msg = form.querySelector('[data-msg]');
    let typed = false;
    const syncMove = () => {
      const s = slugOf(els.title.value);
      const wasHidden = moveRow.hidden;
      moveRow.hidden = !s || s === g.slug;
      // Opt-in when the mismatch predates this edit; auto-check the moment
      // the user types a new name (that is what rename means to them).
      if (typed && wasHidden && !moveRow.hidden) els.move.checked = true;
      form.querySelector('[data-preview]').textContent = `${location.host}/g/${s || g.slug}-${g.access_key}`;
    };
    syncMove();
    els.title.addEventListener('input', () => { typed = true; syncMove(); });
    form.querySelector('[data-cancel]').onclick = () => (slot.innerHTML = '');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const title = els.title.value.trim();
      const wantMove = !moveRow.hidden && els.move.checked;
      msg.textContent = 'Saving…';
      try {
        await api(`galleries/${id}`, { method: 'PATCH', body: {
          ...(title ? { title } : {}),
          client: els.client.value,
          ...(wantMove ? { slug: title } : {}),
        } });
        load();
      } catch (err) { msg.textContent = err.message; }
    };
    els.title.focus();
  });

  /* share */
  $('#share-body').innerHTML = `
    <div class="share-row">
      <span class="url">${location.host}/g/<b>${esc(g.slug)}</b>-${g.access_key}</span>
      <button class="btn" id="copy-link">Copy link</button>
      <button class="btn--quiet btn" id="toggle-status">${
        g.status === 'deleted' ? (g.purge_after ? 'Restore (within grace)' : 'Purged — re-ingest')
        : g.status === 'live' ? 'Back to draft' : 'Go live'}</button>
      <button class="btn--quiet btn" id="rotate">Rotate link</button>
    </div>
    <p class="muted">Rotating kills every old copy of the link (old cached image URLs die within the hour).</p>`;
  $('#copy-link').addEventListener('click', async (e) => {
    await navigator.clipboard.writeText(link);
    e.target.textContent = 'Copied';
    setTimeout(() => (e.target.textContent = 'Copy link'), 1200);
  });
  $('#toggle-status').addEventListener('click', async () => {
    if (g.status === 'deleted' && !g.purge_after) return alert('This gallery was purged — its bytes are gone. Re-ingest to rebuild it.');
    try {
      await api(`galleries/${id}`, { method: 'PATCH', body: { status: g.status === 'live' ? 'draft' : 'live' } });
    } catch (e) { alert(e.message); }
    load();
  });
  $('#rotate').addEventListener('click', async () => {
    if (!confirm('Rotate the link? Every previously shared copy stops working.')) return;
    await api(`galleries/${id}`, { method: 'PATCH', body: { rotate: true } });
    load();
  });

  /* browser ingest — drop a Grain Studio web-set folder */
  renderIngest(g, photos);

  /* coverage matrix — thumbnails come through the AUTHED media route, so
     they work on drafts (the capability URL now hides draft media) */
  const mediaBase = (p, kind) => `/api/admin/galleries/${g.id}/media/${p.id}/${kind}`;
  const markedPhotos = photos.filter((p) => p.marked);
  const vetoedPhotos = photos.filter((p) => p.vetoed);
  const tally = new Map();
  for (const c of comments) {
    const t = tally.get(c.photo_id) ?? { n: 0, open: 0 };
    t.n++;
    if (!c.by_owner && !c.resolved) t.open++;
    tally.set(c.photo_id, t);
  }
  $('#matrix-body').innerHTML = `
    <p class="sel-line">${g.marks_state === 'submitted'
      ? `Selection submitted ${esc((g.marks_submitted_at || '').slice(0, 10))}${g.marks_note ? ` — <em>${esc(g.marks_note)}</em>` : ''}`
      : `<span class="muted">Selection in progress — ${markedPhotos.length}/${g.n_marks} marked, not finalized yet.</span>`}</p>
    <div class="life-row">
      <button class="btn--quiet btn" id="copy-stems" ${markedPhotos.length ? '' : 'disabled'}>Copy marked</button>
      <button class="btn--quiet btn" id="copy-vetoes" ${vetoedPhotos.length ? '' : 'disabled'}>Copy do-not-post</button>
      ${g.marks_state === 'submitted' ? '<button class="btn--quiet btn" id="reopen">Reopen selections</button>' : ''}
    </div>
    <div class="table-scroll"><table class="matrix">
    <thead><tr><th></th><th>Photo</th>${SHOWN.map((k) => `<th>${k}</th>`).join('')}<th>Ladder</th><th>Marked</th><th>No post</th><th>Notes</th><th>State</th></tr></thead>
    <tbody>${photos.map((p) => {
      const cell = (k) => p.assets[k]
        ? `<td class="ok">✓ ${fmtBytes(p.assets[k].bytes)}</td>`
        : '<td class="miss">—</td>';
      const rungKeys = Object.keys(p.assets).filter((k) => /^l\d+$/.test(k));
      const rungs = rungKeys.length;
      const missing = SHOWN.filter((k) => !p.assets[k]);
      return `<tr>
        <td>${rungKeys.length ? `<img class="thumb" src="${thumbSrc(p, mediaBase)}" alt="" loading="lazy">` : '<span class="thumb"></span>'}</td>
        <td>${esc(p.stem)}${p.version > 1 ? ` <span class="muted">v${p.version}</span>` : ''}</td>
        ${SHOWN.map(cell).join('')}
        <td class="${rungs > 0 ? 'ok' : 'miss'}">${rungs} rung${rungs === 1 ? '' : 's'}</td>
        <td class="${p.marked ? 'cell-mark' : 'miss'}"${p.marked ? ` title="marked by ${escAttr(p.marked_by)} · ${escAttr((p.marked_at || '').slice(0, 10))}"` : ''}>${p.marked ? '★' : '—'}</td>
        <td class="${p.vetoed ? 'cell-veto' : 'miss'}"${p.vetoed ? ` title="held back by ${escAttr(p.vetoed_by)} · ${escAttr((p.vetoed_at || '').slice(0, 10))}"` : ''}>${p.vetoed ? '✕' : '—'}</td>
        <td class="cell-notes">${(() => {
          const t = tally.get(p.id);
          if (!t) return `<button class="notes-jump quiet" data-jump="${p.id}" title="Leave a note on this photo">—</button>`;
          return `<button class="notes-jump${t.open ? ' open' : ''}" data-jump="${p.id}" title="${t.open ? `${t.open} awaiting a reply` : `${t.n} note${t.n === 1 ? '' : 's'}, all addressed`}">${t.open ? `${t.open} open` : t.n}</button>`;
        })()}</td>
        <td class="${missing.filter((k) => k !== 'instagram').length ? 'miss' : 'ok'}">${missing.length ? 'missing ' + missing.join(', ') : 'ready'}</td>
      </tr>`;
    }).join('')}</tbody></table></div>
    <p class="muted">Add or update photos above, or with the ingest CLI — a changed original bumps its
    version and shows the client an “updated” chip; marks and threads survive.
    ★ = marked for polish · ✕ = do not post on social.</p>`;
  $('#copy-stems')?.addEventListener('click', () =>
    navigator.clipboard.writeText(markedPhotos.map((p) => p.stem).join('\n')));
  $('#copy-vetoes')?.addEventListener('click', () =>
    navigator.clipboard.writeText(vetoedPhotos.map((p) => p.stem).join('\n')));
  $('#reopen')?.addEventListener('click', async () => {
    await api(`galleries/${id}`, { method: 'PATCH', body: { reopen: true } });
    load();
  });
  $('#matrix-body').onclick = (e) => {  // property assignment: load() re-runs
    const jump = e.target.closest('[data-jump]');
    if (!jump) return;
    const pid = Number(jump.dataset.jump);
    if (!notesState?.byPhoto.has(pid)) notesFilter = 'all';
    selectedPhotoId = pid;
    focusComposerNext = !notesState?.byPhoto.has(pid);
    renderNotes();
    $('#notes').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /* notes — the photo-centric review pane (renderNotes below) */
  notesState = { g, photos, comments, mediaBase };
  renderNotes();

  /* lifecycle */
  $('#lifecycle-body').innerHTML = `
    <div class="life-row">
      <span>Expires <strong>${g.expiry_at.slice(0, 10)}</strong></span>
      <button class="btn--quiet btn" id="extend">Extend +30 days</button>
      <a class="btn--quiet btn" style="text-decoration:none" href="/g/${g.slug}-${g.access_key}/zip/all/original">Archive zip (originals)</a>
      <button class="btn--danger btn" id="delete">Delete gallery…</button>
    </div>
    <p class="muted">Deletion tombstones instantly; bytes purge after a 7-day grace (restore is one
    click inside it). Titles, threads and the mark list survive as records. Masters live in Grain
    Studio regardless.</p>`;
  $('#extend').addEventListener('click', async () => {
    await api(`galleries/${id}`, { method: 'PATCH', body: { extend_days: 30 } });
    load();
  });
  $('#delete').addEventListener('click', async () => {
    const typed = prompt(`Type the slug (${g.slug}) to move this gallery's bytes to trash:`);
    if (typed !== g.slug) return;
    await fetch(`/api/admin/galleries/${id}?confirm=${encodeURIComponent(typed)}`, { method: 'DELETE' });
    location.href = '/admin';
  });
}

/* ================= notes: photo-centric review ================= */

/* The unit of feedback is the PHOTO (that is how the client writes it), so
 * the pane is a strip of photos with their threads folded in, and one photo
 * open at a time: picture, thread, reply. Selection and the strip's scroll
 * survive re-renders; arrows / J K walk the strip, R writes, ⌘↩ sends. */
function renderNotes() {
  const { g, photos, comments, mediaBase } = notesState;
  const body = $('#notes-body');
  const byPhoto = new Map();
  for (const c of [...comments].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id))
    (byPhoto.get(c.photo_id) ?? byPhoto.set(c.photo_id, []).get(c.photo_id)).push(c);
  const rows = photos.map((p) => {
    const thread = byPhoto.get(p.id) ?? [];
    const open = thread.filter((c) => !c.by_owner && !c.resolved).length;
    return { p, thread, open, last: thread[thread.length - 1] ?? null };
  });
  const lastAt = (r) => r.last?.created_at ?? '';
  const shown = (notesFilter === 'all' ? rows : rows.filter((r) => r.thread.length)).sort((a, b) =>
    (b.open > 0) - (a.open > 0)
    || (lastAt(b) > lastAt(a) ? 1 : lastAt(b) < lastAt(a) ? -1 : 0)
    || a.p.stem.localeCompare(b.p.stem));
  Object.assign(notesState, { rows, byPhoto, shown });

  const noted = rows.filter((r) => r.thread.length);
  const needReply = noted.filter((r) => r.open).length;
  if (!shown.some((r) => r.p.id === selectedPhotoId)) selectedPhotoId = shown[0]?.p.id ?? null;
  const cur = shown.find((r) => r.p.id === selectedPhotoId);

  const stripScroll = $('.strip', body)?.scrollTop ?? 0;
  const stat = !photos.length ? 'Add photos first — notes arrive once the client starts writing.'
    : !noted.length ? 'No client notes yet.'
    : `${noted.length} photo${noted.length === 1 ? '' : 's'} with notes · ${needReply
        ? `<b>${needReply} need${needReply === 1 ? 's' : ''} a reply</b>` : 'all addressed'}`;
  body.innerHTML = `
    <div class="review__head">
      <p class="review__stat">${stat}</p>
      ${photos.length ? `<div class="seg" role="tablist" aria-label="Which photos">
        <button role="tab" data-filter="notes" class="${notesFilter === 'notes' ? 'on' : ''}" aria-selected="${notesFilter === 'notes'}">With notes</button>
        <button role="tab" data-filter="all" class="${notesFilter === 'all' ? 'on' : ''}" aria-selected="${notesFilter === 'all'}">All photos</button>
      </div>` : ''}
    </div>
    ${!cur ? (photos.length ? `<p class="muted review__empty">Nothing here yet. <button class="linklike" data-filter="all">Open a photo to leave the first note</button> — the client sees it in that photo's thread.</p>` : '')
    : `<div class="review">
      <ol class="strip" role="listbox" aria-label="Photos">${shown.map(({ p, thread, open, last }) => `
        <li class="strip__item${p.id === selectedPhotoId ? ' is-selected' : ''}${open ? ' has-open' : ''}" role="option"
            aria-selected="${p.id === selectedPhotoId}" tabindex="${p.id === selectedPhotoId ? 0 : -1}" data-pid="${p.id}">
          <img class="strip__thumb" src="${thumbSrc(p, mediaBase)}" alt="" loading="lazy" decoding="async" style="background:${escAttr(p.color)}">
          <span class="strip__meta">
            <span class="strip__stem">${esc(p.stem)}${p.marked ? ' <i class="mk" title="marked for polish">★</i>' : ''}${p.vetoed ? ' <i class="vt" title="do not post">✕</i>' : ''}</span>
            <span class="strip__line">${last ? `${last.by_owner ? 'You' : esc(last.author)} · ${esc(last.body)}` : 'no notes'}</span>
          </span>
          ${thread.length ? `<span class="strip__count${open ? ' open' : ''}" title="${open ? `${open} awaiting a reply` : `${thread.length} note${thread.length === 1 ? '' : 's'}`}">${open || thread.length}</span>` : ''}
        </li>`).join('')}</ol>
      ${detailHtml(cur)}
    </div>`}`;
  const strip = $('.strip', body);
  if (strip) {
    strip.scrollTop = stripScroll;
    $('.strip__item.is-selected', strip)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  if (focusComposerNext) { focusComposerNext = false; $('.composer textarea', body)?.focus(); }

  body.onclick = async (e) => {
    const filter = e.target.closest('[data-filter]');
    if (filter) { notesFilter = filter.dataset.filter; renderNotes(); return; }
    const item = e.target.closest('.strip__item');
    if (item) { selectPhoto(Number(item.dataset.pid)); return; }
    const op = e.target.closest('[data-op]');
    if (!op) return;
    op.disabled = true;
    try {
      if (op.dataset.op === 'toggle') {
        const c = comments.find((x) => x.id === Number(op.closest('li').dataset.cid));
        await api(`comments/${c.id}/resolve`, { method: 'POST', body: { resolved: !c.resolved } });
      } else if (op.dataset.op === 'address-all') {
        await api(`galleries/${g.id}/photos/${selectedPhotoId}/resolve`, { method: 'POST', body: { resolved: true } });
      }
      await load();
    } catch (err) { op.disabled = false; alert(err.message); }
  };
  body.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const ta = form.elements.body;
    const text = ta.value.trim();
    if (!text) return ta.focus();
    const err = $('.composer__err', form);
    err.hidden = true;
    ta.disabled = true;
    form.querySelector('[type="submit"]').disabled = true;
    try {
      await api(`galleries/${g.id}/photos/${form.dataset.pid}/reply`, { method: 'POST', body: { body: text } });
      focusComposerNext = true;
      await load();
    } catch (e2) {
      err.textContent = `Couldn't send — ${e2.message}`;
      err.hidden = false;
      ta.disabled = false;
      form.querySelector('[type="submit"]').disabled = false;
      ta.focus();
    }
  };
  body.oninput = (e) => {
    if (!e.target.matches('.composer textarea')) return;
    e.target.form.querySelector('[type="submit"]').disabled = !e.target.value.trim();
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 224)}px`;
  };
}

function detailHtml({ p, thread, open }) {
  const { g, mediaBase } = notesState;
  const w = p.width || 3, h = p.height || 2;
  const lastClient = [...thread].reverse().find((c) => !c.by_owner);
  const name = lastClient?.author || g.client_name || 'the client';
  const placeholder = thread.length ? `Reply to ${name} — it lands in this photo's thread` : `Leave ${name} a note on this photo`;
  return `<section class="detail" data-pid="${p.id}" aria-live="polite">
    <figure class="detail__fig" style="--ar:${(w / h).toFixed(4)};aspect-ratio:${w}/${h};width:min(100%, calc(62vh * var(--ar)));background-color:${escAttr(p.color)}${p.thumbhash ? `;background-image:url(${escAttr(p.thumbhash)})` : ''}">
      ${viewSrc(p, mediaBase) ? `<img class="detail__img" src="${viewSrc(p, mediaBase)}" alt="" decoding="async" onload="this.classList.add('is-loaded')">` : ''}
    </figure>
    <header class="detail__head">
      <h3 class="detail__stem">${esc(p.stem)}${p.version > 1 ? ` <span class="muted">v${p.version}</span>` : ''}</h3>
      <div class="detail__chips">
        ${p.marked ? `<span class="chip mark" title="by ${escAttr(p.marked_by)} · ${escAttr((p.marked_at || '').slice(0, 10))}">★ marked</span>` : ''}
        ${p.vetoed ? `<span class="chip veto" title="by ${escAttr(p.vetoed_by)} · ${escAttr((p.vetoed_at || '').slice(0, 10))}">✕ do not post</span>` : ''}
        ${open ? `<button class="btn btn--quiet btn--sm" data-op="address-all" title="Mark every open note on this photo addressed (A)">${open === 1 ? 'Mark addressed' : `Mark all ${open} addressed`}</button>`
          : thread.some((c) => !c.by_owner) ? '<span class="chip done">addressed</span>' : ''}
      </div>
    </header>
    <ul class="thread thread--review">${thread.length ? thread.map((c) => `
      <li class="${c.by_owner ? 'mine' : ''}${!c.by_owner && c.resolved ? ' resolved' : ''}" data-cid="${c.id}">
        <p class="who"><span class="${c.by_owner ? 'owner' : ''}">${c.by_owner ? 'Santiago' : esc(c.author)}</span>
          <time datetime="${escAttr(c.created_at)}" title="${escAttr(whenLocal(c.created_at))}">${ago(c.created_at)}</time>
          ${c.by_owner ? '' : `<button class="tick" data-op="toggle" aria-pressed="${!!c.resolved}" title="${c.resolved ? 'Reopen this note' : 'Mark this note addressed'}">${c.resolved ? 'addressed ✓' : 'mark addressed'}</button>`}</p>
        <p class="what">${esc(c.body)}</p>
      </li>`).join('') : '<li class="thread__empty"><p class="what muted">No notes on this photo yet.</p></li>'}</ul>
    <form class="composer" data-pid="${p.id}">
      <textarea name="body" rows="2" maxlength="4000" placeholder="${escAttr(placeholder)}" aria-label="Reply"></textarea>
      <p class="composer__err muted" hidden></p>
      <div class="composer__row">
        <span class="muted composer__hint">${MOD}↩ sends · ↑ ↓ move between photos · R to write</span>
        <button class="btn" type="submit" disabled>${thread.length ? 'Reply' : 'Send note'}</button>
      </div>
    </form>
  </section>`;
}

/* Re-paint only the open photo: the strip keeps its scroll and its images. */
function selectPhoto(pid) {
  if (!notesState) return;
  const row = notesState.shown.find((r) => r.p.id === pid);
  if (!row) return;
  selectedPhotoId = pid;
  const body = $('#notes-body');
  for (const el of body.querySelectorAll('.strip__item')) {
    const on = Number(el.dataset.pid) === pid;
    el.classList.toggle('is-selected', on);
    el.setAttribute('aria-selected', String(on));
    el.tabIndex = on ? 0 : -1;
    if (on) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  $('.detail', body).outerHTML = detailHtml(row);
}

/* Keyboard, only while the pane is on screen — the arrows still scroll the
 * page everywhere else. */
document.onkeydown = (e) => {
  if (!notesState || e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
  if (typing) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const rect = $('#notes').getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > innerHeight) return;
  const items = [...document.querySelectorAll('#notes-body .strip__item')];
  if (!items.length) return;
  const i = items.findIndex((el) => Number(el.dataset.pid) === selectedPhotoId);
  const go = (n) => { e.preventDefault(); selectPhoto(Number(items[Math.max(0, Math.min(items.length - 1, n))].dataset.pid)); };
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'j') go(i + 1);
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'k') go(i - 1);
  else if (e.key === 'r' || e.key === 'Enter') { e.preventDefault(); $('#notes-body .composer textarea')?.focus(); }
  else if (e.key === 'a') $('#notes-body [data-op="address-all"]')?.click();
};
document.addEventListener('keydown', (e) => {
  // ⌘↩ / Ctrl↩ sends from the composer (the handler above yields while typing)
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && e.target.matches?.('.composer textarea'))
    { e.preventDefault(); e.target.form.requestSubmit(); }
});

/* ================= browser ingest ================= */

function pairFiles(files) {
  const sets = new Map();
  const at = (stem) => sets.get(stem) ?? sets.set(stem, { rungJpg: {}, rungAvif: {} }).get(stem);
  for (const f of files) {
    const name = f.name.toLowerCase();
    let m;
    if ((m = name.match(/^(.+)-grain\.heic$/))) at(m[1]).original = f;
    else if ((m = name.match(/^(.+)-instagram\.heic$/))) at(m[1]).instagram = f;
    else if ((m = name.match(/^(.+)-rednote\.heic$/))) at(m[1]).rednote = f;
    else if ((m = name.match(/^(.+)-web\.jpe?g$/))) at(m[1]).preview = f;
    else if ((m = name.match(/^(.+)-w(\d+)\.jpe?g$/))) at(m[1]).rungJpg[Number(m[2])] = f;
    else if ((m = name.match(/^(.+)-w(\d+)\.avif$/))) at(m[1]).rungAvif[Number(m[2])] = f;
    else if ((m = name.match(/^(.+)\.heic$/))) { if (!at(m[1]).original) at(m[1]).original = f; }
  }
  return sets;
}

function renderIngest(g, photos) {
  const body = $('#ingest-body');
  body.innerHTML = `
    <div class="drop" id="drop">
      <p><strong>Drop a Grain Studio export folder here</strong> — masters, RedNote/Instagram, and the
      Web set (tick “Web preview” in Grain Studio; it now writes the ladder too).</p>
      <div class="life-row">
        <button class="btn--quiet btn" id="pick-folder">Choose folder…</button>
        <button class="btn--quiet btn" id="pick-files">Choose files…</button>
        <label class="chk"><input type="checkbox" id="ing-sdr"> SDR shoot</label>
        <label class="chk"><input type="checkbox" id="ing-gps"> Allow GPS</label>
      </div>
    </div>
    <div id="ing-status" class="muted"></div>
    <input type="file" id="f-folder" webkitdirectory multiple hidden>
    <input type="file" id="f-files" multiple hidden>`;
  const status = $('#ing-status');
  const start = (files) => runIngest(g, photos, [...files], status).catch((e) => {
    status.innerHTML += `<p class="miss">Ingest stopped: ${esc(e.message)}</p>`;
  });
  $('#pick-folder').addEventListener('click', () => $('#f-folder').click());
  $('#pick-files').addEventListener('click', () => $('#f-files').click());
  $('#f-folder').addEventListener('change', (e) => e.target.files.length && start(e.target.files));
  $('#f-files').addEventListener('change', (e) => e.target.files.length && start(e.target.files));
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files.length) start(e.dataTransfer.files);
  });
}

async function runIngest(g, serverPhotos, files, status) {
  const sets = pairFiles(files);
  if (sets.size === 0) { status.textContent = 'Nothing ingestable — expected <stem>-grain.heic / -web.jpg / -w900.jpg…'; return; }
  const stems = [...sets.keys()].sort();
  const server = new Map(serverPhotos.map((p) => [p.stem, p]));
  const sdr = $('#ing-sdr').checked;
  const allowGps = $('#ing-gps').checked;

  // pre-flight: what does each stem need?
  const problems = [];
  for (const stem of stems) {
    const s = sets.get(stem);
    if (!s.original) problems.push(`${stem}: no original (-grain.heic)`);
    if (!s.preview) problems.push(`${stem}: no -web.jpg — tick “Web preview” in Grain Studio`);
    if (Object.keys(s.rungJpg).length === 0)
      problems.push(`${stem}: no ladder rungs (-w900.jpg…) — re-run Grain Studio with the updated Web set`);
  }
  if (problems.length) {
    status.innerHTML = `<p class="miss">Refusing to ingest:</p><ul>${problems.map((p) => `<li class="miss">${esc(p)}</li>`).join('')}</ul>`;
    return;
  }

  // detect replacements up front — one honest confirm, not 24 surprises
  const matches = (asset, bytes, crc) => asset && asset.bytes === bytes && (asset.crc32 >>> 0) === crc;
  const plans = [];
  status.textContent = 'Reading files…';
  for (const stem of stems) {
    const s = sets.get(stem);
    const originalBuf = new Uint8Array(await s.original.arrayBuffer());
    const originalCrc = crc32(originalBuf);
    const existing = server.get(stem);
    let mode = 'new';
    if (existing) {
      mode = matches(existing.assets?.original, originalBuf.length, originalCrc) ? 'heal' : 'replace';
    }
    plans.push({ stem, s, originalBuf, originalCrc, existing, mode });
  }
  const replacing = plans.filter((p) => p.mode === 'replace');
  if (replacing.length &&
      !confirm(`${replacing.length} photo(s) differ from the gallery (${replacing.map((p) => p.stem).join(', ')}).\n\nUpload as NEW VERSIONS? Clients see an “updated” chip; marks and threads survive.`))
    return;

  const put = (stem, kind, bytes, contentType, filename, extra, onProgress) => new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      stem, kind, bytes: String(bytes.length), crc32: String(crc32(bytes)),
      content_type: contentType, filename,
      ...(sdr ? { sdr: '1' } : {}), ...(allowGps ? { allow_gps: '1' } : {}),
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
    });
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/admin/galleries/${g.id}/upload?${params}`);
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let msg = xhr.status;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(bytes);
  });

  const CT = { heic: 'image/heic', jpg: 'image/jpeg', avif: 'image/avif' };
  let done = 0;
  const errors = [];
  for (const plan of plans) {
    const { stem, s, originalBuf, existing, mode } = plan;
    status.innerHTML = `<p>Uploading <strong>${esc(stem)}</strong> (${++done}/${plans.length}) <span id="pct"></span></p>`;
    const pct = $('#pct');
    const track = (frac) => (pct.textContent = `${Math.round(frac * 100)}%`);
    try {
      const previewBuf = new Uint8Array(await s.preview.arrayBuffer());
      const bitmap = await createImageBitmap(s.preview);
      const canvas = document.createElement('canvas');
      const scale = 100 / Math.max(bitmap.width, bitmap.height);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx2 = canvas.getContext('2d');
      ctx2.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const rgba = ctx2.getImageData(0, 0, canvas.width, canvas.height);
      const thumbhash = thumbHashToDataURL(rgbaToThumbHash(rgba.width, rgba.height, rgba.data));
      const one = document.createElement('canvas');
      one.width = one.height = 1;
      one.getContext('2d').drawImage(bitmap, 0, 0, 1, 1);
      const px = one.getContext('2d').getImageData(0, 0, 1, 1).data;
      const color = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      const isHdr = sdr ? 0 : (hasIsoGainMap(previewBuf) ? 1 : 0);
      const meta = { width: bitmap.width, height: bitmap.height, is_hdr: isHdr, thumbhash, color };
      bitmap.close();

      const need = (kind, bytes) => mode !== 'heal' || !matches(existing?.assets?.[kind], bytes.length, crc32(bytes));
      const work = [];
      if (mode !== 'heal' || !existing?.assets?.original)
        work.push(['original', originalBuf, CT.heic, `${stem}.heic`, mode === 'replace' ? { new_version: 1 } : {}]);
      for (const [kind, file, ct, suffix] of [
        ['instagram', s.instagram, CT.heic, '-instagram.heic'],
        ['rednote', s.rednote, CT.heic, '-rednote.heic'],
      ]) {
        if (!file) continue;
        const buf = new Uint8Array(await file.arrayBuffer());
        if (need(kind, buf)) work.push([kind, buf, ct, `${stem}${suffix}`, {}]);
      }
      if (need('preview', previewBuf)) work.push(['preview', previewBuf, CT.jpg, `${stem}-web.jpg`, {}]);
      for (const w of Object.keys(s.rungJpg).map(Number).sort((a, b) => a - b)) {
        const jb = new Uint8Array(await s.rungJpg[w].arrayBuffer());
        if (need(`l${w}`, jb)) work.push([`l${w}`, jb, CT.jpg, `${stem}-${w}.jpg`, {}]);
        if (s.rungAvif[w]) {
          const ab = new Uint8Array(await s.rungAvif[w].arrayBuffer());
          if (need(`a${w}`, ab)) work.push([`a${w}`, ab, CT.avif, `${stem}-${w}.avif`, {}]);
        }
      }
      if (work.length === 0) { continue; }
      let i = 0;
      for (const [kind, bytes, ct, filename, extra] of work) {
        i++;
        await put(stem, kind, bytes, ct, filename, { ...meta, ...extra },
          (f) => track((i - 1 + f) / work.length));
      }
    } catch (e) {
      errors.push(`${stem}: ${e.message}`);
    }
  }
  status.innerHTML = errors.length
    ? `<p class="miss">Finished with ${errors.length} problem(s):</p><ul>${errors.map((e) => `<li class="miss">${esc(e)}</li>`).join('')}</ul>`
    : `<p class="ok">Done — ${plans.length} photo(s) up to date.</p>`;
  load();
}

load().catch((e) => ($('#matrix-body').textContent = `Failed to load: ${e.message}`));
}


/* ================= insights: the public site's funnel ================= */
if (view === 'insights') {
  const state = { days: 30, source: '', device: '', internal: false, bounces: false };
  const pct = (n, of) => (of > 0 ? Math.round((n / of) * 100) + '%' : '—');
  const dur = (ms) => {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  };
  // D1 datetimes are UTC without a zone marker.
  const when = (utc) =>
    new Date(utc.replace(' ', 'T') + 'Z').toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const paintFilters = (data) => {
    const opt = (value, label, current) => `<option value="${escAttr(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
    $('#ins-filters-body').innerHTML = `
      <div class="ins-filters">
        <label>Range <select name="days">${[7, 30, 90, 365].map((d) => opt(String(d), `${d} days`, String(state.days))).join('')}</select></label>
        <label>Source <select name="source">${opt('', 'all', state.source)}${data.filters.sources.map((x) => opt(x, x, state.source)).join('')}</select></label>
        <label>Device <select name="device">${['', 'mobile', 'tablet', 'desktop'].map((d) => opt(d, d || 'all', state.device)).join('')}</select></label>
        <label class="ins-check"><input type="checkbox" name="bounces"${state.bounces ? ' checked' : ''}> show bounces</label>
        <label class="ins-check"><input type="checkbox" name="internal"${state.internal ? ' checked' : ''}> my own visits</label>
      </div>`;
    $('#ins-filters-body').onchange = (event) => {
      const el = event.target;
      if (el.name === 'days') state.days = Number(el.value);
      else if (el.type === 'checkbox') state[el.name] = el.checked;
      else state[el.name] = el.value;
      load();
    };
  };

  const paintFunnel = (data) => {
    const top = data.funnel[0].n;
    const engaged = data.funnel[1].n;
    if (top === 0) {
      $('#ins-funnel').innerHTML = '<p class="muted">No sessions in this range yet. Visit the site from another browser (or tick “my own visits”) to see data arrive.</p>';
      return;
    }
    $('#ins-funnel').innerHTML = `<div class="table-scroll"><table class="matrix ins-funnel">
      <tr><th>Step</th><th>Sessions</th><th></th><th>of previous</th><th>of engaged</th><th>prior ${data.days}d</th></tr>
      ${data.funnel.map((step, i) => {
        const prev = i === 0 ? null : data.funnel[i - 1].n;
        const before = data.prior[i].n;
        const delta = step.n - before;
        return `<tr>
          <td>${esc(step.label)}</td>
          <td><b>${step.n}</b></td>
          <td class="ins-bar"><span style="width:${top ? Math.max((step.n / top) * 100, step.n ? 1.5 : 0) : 0}%"></span></td>
          <td>${prev === null ? '' : pct(step.n, prev)}</td>
          <td>${i < 2 ? '' : pct(step.n, engaged)}</td>
          <td class="${delta > 0 ? 'ok' : delta < 0 ? 'miss' : ''}">${before}${delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}</td>
        </tr>`;
      }).join('')}
    </table></div>
    <p class="muted">Engaged = a real tap, key or wheel event; everything below it counts engaged sessions only. Each step means “got at least this far”.</p>`;
  };

  const story = (s) => {
    const bits = [];
    if (s.n_shoots) bits.push(`${s.n_shoots} shoot${s.n_shoots === 1 ? '' : 's'}`);
    if (s.f_sessions) bits.push('/sessions');
    if (s.f_offer) bits.push('offer');
    if (s.f_book) bits.push('booking');
    if (s.f_cal_failed) bits.push('<span class="miss">cal failed</span>');
    else if (s.f_cal_ready) bits.push('cal ready');
    if (s.f_cal_used) bits.push('used cal');
    if (s.f_booked) bits.push('<span class="ok">booked</span>');
    if (s.f_mailto) bits.push('<span class="mark">emailed</span>');
    return bits.join(' → ') || (s.human ? 'looked, left' : 'bounce');
  };

  const paintJournal = (data) => {
    const rows = data.sessions.filter((s) => state.bounces || s.human);
    if (rows.length === 0) {
      $('#ins-journal').innerHTML = '<p class="muted">No engaged sessions in this range.</p>';
      return;
    }
    $('#ins-journal').innerHTML = `<ul class="thread ins-journal">${rows.map((s) => `
      <li data-sid="${escAttr(s.sid)}"${s.human ? '' : ' class="resolved"'}>
        <button class="ins-line" type="button">
          <span class="who">${esc(when(s.started_at))} · <span class="stem">${esc(s.source)}</span>${s.visit_n > 1 ? ` · visit ${s.visit_n}${s.first_source && s.first_source !== s.source ? ` (first: ${esc(s.first_source)})` : ''}` : ''} · ${esc(s.device)} ${esc(s.browser)}${s.country ? ' · ' + esc(s.country) : ''} · ${dur(s.dur_ms)}</span>
          <span class="ins-story">${esc(s.landing_path)} → ${story(s)}</span>
        </button>
        <div class="ins-timeline" hidden></div>
      </li>`).join('')}</ul>`;
    $('#ins-journal').onclick = async (event) => {
      const li = event.target.closest('li[data-sid]');
      if (!li || !event.target.closest('.ins-line')) return;
      const box = $('.ins-timeline', li);
      box.hidden = !box.hidden;
      if (box.hidden || box.dataset.loaded) return;
      box.dataset.loaded = '1';
      box.textContent = 'Loading…';
      try {
        const { events } = await api(`insights/${li.dataset.sid}`);
        box.innerHTML = `<table class="matrix">${events.map((e) => `<tr>
          <td>${dur(e.t_ms)}</td><td>${esc(e.path)}</td><td><b>${esc(e.name)}</b></td>
          <td>${esc(e.detail)}</td><td>${e.v === null ? '' : esc(String(Math.round(e.v)))}</td></tr>`).join('')}</table>`;
      } catch (error) {
        box.textContent = `Could not load: ${error.message}`;
      }
    };
  };

  const paintSources = (data) => {
    $('#ins-sources').innerHTML = data.sources.length === 0 ? '<p class="muted">—</p>' : `<div class="table-scroll"><table class="matrix">
      <tr><th>Source</th><th>Landed</th><th>Engaged</th><th>/sessions</th><th>Booking</th><th>Used cal</th><th>Booked</th></tr>
      ${data.sources.map((r) => `<tr><td class="mark">${esc(r.source)}</td><td>${r.landed}</td><td>${r.engaged} <span class="muted">${pct(r.engaged, r.landed)}</span></td>
        <td>${r.sessions} <span class="muted">${pct(r.sessions, r.engaged)}</span></td><td>${r.book}</td><td>${r.cal_used}</td><td>${r.booked}</td></tr>`).join('')}
    </table></div>
    <p class="muted">Tag your links: <b>ryuxik.io/?s=ig</b>, <b>?s=xhs</b>, <b>?s=ig-story</b>. The tag is read once and removed from the address bar.</p>`;
  };

  const paintEnds = (data) => {
    $('#ins-ends').innerHTML = data.ends.length === 0 ? '<p class="muted">—</p>' : `<table class="matrix">
      <tr><th>Last page</th><th>Last thing seen</th><th>Sessions</th></tr>
      ${data.ends.map((r) => `<tr><td>${esc(r.path)}</td><td>${esc(r.section || 'top of page')}</td><td>${r.n}</td></tr>`).join('')}
    </table><p class="muted">Engaged sessions that did not book, by where they came to rest.</p>`;
  };

  const paintCal = (data) => {
    const failed = data.cal.failed;
    $('#ins-cal').innerHTML = `<p>${data.cal.ready} loaded${data.cal.median_ms === null ? '' : ` · median ${(data.cal.median_ms / 1000).toFixed(1)}s`} ·
      <span class="${failed.length ? 'miss' : 'ok'}">${failed.length} failed</span></p>
      ${failed.length ? `<table class="matrix"><tr><th>Browser</th><th>Device</th><th>Country</th></tr>${failed.map((f) => `<tr><td>${esc(f.browser)}</td><td>${esc(f.device)}</td><td>${esc(f.country)}</td></tr>`).join('')}</table>` : ''}`;
  };

  const paintReach = (data) => {
    const groups = [
      ['FAQ opened', (r) => r.name === 'faq'],
      ['Shoots seen (home)', (r) => r.name === 'view' && r.detail.startsWith('shoot:')],
      ['Clicks', (r) => r.name === 'click'],
      ['Scroll depth', (r) => r.name === 'scroll'],
    ];
    $('#ins-reach').innerHTML = `<div class="ins-grid">${groups.map(([title, test]) => {
      const rows = data.reach.filter(test).slice(0, 14);
      return `<div><h3 class="ins-h3">${title}</h3>${rows.length === 0 ? '<p class="muted">—</p>' : `<table class="matrix">${rows.map((r) =>
        `<tr><td>${esc(r.detail.replace(/^shoot:/, ''))}${r.name === 'scroll' ? '%' : ''} <span class="muted">${esc(r.path)}</span></td><td>${r.n}</td></tr>`).join('')}</table>`}</div>`;
    }).join('')}</div><p class="muted">Engaged sessions that did each thing at least once.</p>`;
  };

  const load = async () => {
    const query = new URLSearchParams({ days: String(state.days), source: state.source, device: state.device, internal: state.internal ? '1' : '0' });
    try {
      const data = await api(`insights?${query}`);
      paintFilters(data);
      paintFunnel(data);
      paintJournal(data);
      paintSources(data);
      paintEnds(data);
      paintCal(data);
      paintReach(data);
    } catch (error) {
      $('#ins-funnel').textContent = `Could not load insights: ${error.message}`;
    }
  };
  load();
}
