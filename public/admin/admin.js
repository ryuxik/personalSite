/* Selects admin behaviour. Talks to /api/admin/* with the session cookie set
 * by /admin?token=… (Cloudflare Access fronts everything in production). */
(() => {
  'use strict';
  const $ = (s, el) => (el || document).querySelector(s);
  const view = $('.admin').dataset.view;
  const esc = (s) => { const d = document.createElement('span'); d.textContent = s ?? ''; return d.innerHTML; };
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

  /* ------------------------------------------------------------- home */
  if (view === 'home') {
    const list = $('#list');
    const paint = (galleries) => {
      list.innerHTML = galleries.length === 0
        ? '<p class="muted">No galleries yet — ingest one: <code>node scripts/gallery-ingest.mjs &lt;folder&gt; --gallery &lt;slug&gt;</code></p>'
        : galleries.map((g) => `
          <div class="gcard">
            <a href="/admin/g/${g.id}">${esc(g.title)}</a>
            <span class="chip ${g.status}">${g.status}</span>
            ${g.marks_state === 'submitted' ? '<span class="chip submitted">marks in</span>' : ''}
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
      location.href = `/admin/g/${r.gallery.id}`;
    });
    return;
  }

  /* ---------------------------------------------------------- gallery */
  const id = $('.admin').dataset.id;
  const SHOWN = ['original', 'instagram', 'rednote', 'preview'];

  async function load() {
    const { gallery: g, photos, comments } = await api(`galleries/${id}`);
    const link = `${location.origin}/g/${g.slug}-${g.access_key}`;

    $('#summary').innerHTML = `<span class="chip ${g.status}">${g.status}</span>
      ${g.marks_state === 'submitted' ? '<span class="chip submitted">marks in</span>' : ''}
      ${photos.length} photo(s) · mark ${g.n_marks} · until ${g.expiry_at.slice(0, 10)}`;

    /* share */
    $('#share-body').innerHTML = `
      <div class="share-row">
        <span class="url">${location.host}/g/<b>${esc(g.slug)}</b>-${g.access_key}</span>
        <button class="btn" id="copy-link">Copy link</button>
        <button class="btn--quiet btn" id="toggle-status">${g.status === 'live' ? 'Back to draft' : 'Go live'}</button>
        <button class="btn--quiet btn" id="rotate">Rotate link</button>
      </div>
      <p class="muted">Rotating kills every old copy of the link (old cached image URLs die within the hour).</p>`;
    $('#copy-link').addEventListener('click', async (e) => {
      await navigator.clipboard.writeText(link);
      e.target.textContent = 'Copied';
      setTimeout(() => (e.target.textContent = 'Copy link'), 1200);
    });
    $('#toggle-status').addEventListener('click', async () => {
      await api(`galleries/${id}`, { method: 'PATCH', body: { status: g.status === 'live' ? 'draft' : 'live' } });
      load();
    });
    $('#rotate').addEventListener('click', async () => {
      if (!confirm('Rotate the link? Every previously shared copy stops working.')) return;
      await api(`galleries/${id}`, { method: 'PATCH', body: { rotate: true } });
      load();
    });

    /* coverage matrix */
    const mediaBase = (p, kind) => `/g/${g.slug}-${g.access_key}/m/${g.key_version}/${p.id}/${kind}`;
    $('#matrix-body').innerHTML = `<div class="table-scroll"><table class="matrix">
      <thead><tr><th></th><th>Photo</th>${SHOWN.map((k) => `<th>${k}</th>`).join('')}<th>Ladder</th><th>State</th></tr></thead>
      <tbody>${photos.map((p) => {
        const cell = (k) => p.assets[k]
          ? `<td class="ok">✓ ${fmtBytes(p.assets[k].bytes)}</td>`
          : '<td class="miss">—</td>';
        const rungs = ['l900', 'l1400', 'l2048'].filter((k) => p.assets[k]).length;
        const missing = SHOWN.filter((k) => !p.assets[k]);
        return `<tr>
          <td>${p.assets.l900 ? `<img class="thumb" src="${mediaBase(p, 'l900')}" alt="">` : '<span class="thumb"></span>'}</td>
          <td>${p.marked ? '<span class="mark">●</span> ' : ''}${esc(p.stem)}${p.version > 1 ? ` <span class="muted">v${p.version}</span>` : ''}</td>
          ${SHOWN.map(cell).join('')}
          <td class="${rungs === 3 ? 'ok' : 'miss'}">${rungs}/3</td>
          <td class="${missing.length ? 'miss' : 'ok'}">${missing.length ? 'missing ' + missing.join(', ') : 'ready'}</td>
        </tr>`;
      }).join('')}</tbody></table></div>
      <p class="muted">Add or update photos with the ingest CLI — re-ingesting an original bumps its
      version and shows the client an “updated” chip; marks and threads survive.</p>`;

    /* marks */
    const markedPhotos = photos.filter((p) => p.marked);
    $('#marks-body').innerHTML = `
      ${g.marks_state === 'submitted'
        ? `<p>Submitted ${esc((g.marks_submitted_at || '').slice(0, 10))}${g.marks_note ? ` — note: <em>${esc(g.marks_note)}</em>` : ''}</p>`
        : '<p class="muted">In progress — the client has not finalized yet.</p>'}
      <p>${markedPhotos.length === 0 ? '<span class="muted">Nothing marked yet.</span>' : markedPhotos.map((p) => esc(p.stem)).join(', ')}</p>
      <div class="life-row">
        <button class="btn--quiet btn" id="copy-stems" ${markedPhotos.length ? '' : 'disabled'}>Copy filenames</button>
        ${g.marks_state === 'submitted' ? '<button class="btn--quiet btn" id="reopen">Reopen selections</button>' : ''}
      </div>`;
    $('#copy-stems')?.addEventListener('click', () =>
      navigator.clipboard.writeText(markedPhotos.map((p) => p.stem).join('\n')));
    $('#reopen')?.addEventListener('click', async () => {
      await api(`galleries/${id}`, { method: 'PATCH', body: { reopen: true } });
      load();
    });

    /* threads */
    $('#threads-body').innerHTML = comments.length === 0
      ? '<p class="muted">No client notes yet.</p>'
      : `<ul class="thread">${comments.map((c) => `
          <li class="${c.resolved ? 'resolved' : ''}" data-cid="${c.id}">
            <p class="who"><span class="stem">${esc(c.stem)}</span> · ${c.by_owner ? 'Santiago' : esc(c.author)} · ${c.created_at.slice(0, 16).replace('T', ' ')}</p>
            <p class="what">${esc(c.body)}</p>
            ${c.by_owner ? '' : `<div class="ops">
              <button data-op="reply">Reply</button>
              ${c.resolved ? '' : '<button data-op="resolve">Mark addressed</button>'}
            </div>`}
          </li>`).join('')}</ul>`;
    $('#threads-body').addEventListener('click', async (e) => {
      const op = e.target.dataset?.op;
      if (!op) return;
      const cid = e.target.closest('li').dataset.cid;
      if (op === 'resolve') { await api(`comments/${cid}/resolve`, { method: 'POST' }); load(); }
      if (op === 'reply') {
        const body = prompt('Reply (the client sees this in the photo’s thread):');
        if (body) { await api(`comments/${cid}/reply`, { method: 'POST', body: { body } }); load(); }
      }
    });

    /* lifecycle */
    $('#lifecycle-body').innerHTML = `
      <div class="life-row">
        <span>Expires <strong>${g.expiry_at.slice(0, 10)}</strong></span>
        <button class="btn--quiet btn" id="extend">Extend +30 days</button>
        <a class="btn--quiet btn" style="text-decoration:none" href="/g/${g.slug}-${g.access_key}/zip/all/original">Archive zip (originals)</a>
        <button class="btn--danger btn" id="delete">Delete gallery…</button>
      </div>
      <p class="muted">Deletion moves every image byte to a 7-day trash grace, then purges.
      Titles, threads and the mark list survive as records. Masters live in Grain Studio regardless.</p>`;
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

  load().catch((e) => ($('#matrix-body').textContent = `Failed to load: ${e.message}`));
})();
