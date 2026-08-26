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
} else {

/* ---------------------------------------------------------- gallery */
const id = $('.admin').dataset.id;
const SHOWN = ['original', 'instagram', 'rednote', 'preview'];

async function load() {
  const { gallery: g, photos, comments } = await api(`galleries/${id}`);
  const link = `${location.origin}/g/${g.slug}-${g.access_key}`;

  $('#summary').innerHTML = `<span class="chip ${g.status}">${g.status}</span>
    ${g.marks_state === 'submitted' ? '<span class="chip submitted">marks in</span>' : ''}
    ${photos.length} photo(s) · mark ${g.n_marks} · until ${g.expiry_at.slice(0, 10)}
    ${g.client_name ? ` · client: ${esc(g.client_name)}` : ''}
    <button class="linklike" id="rename">rename…</button>`;
  $('#rename').addEventListener('click', async () => {
    const title = prompt('Gallery title (what the client sees):', g.title);
    if (title === null) return;
    const client = prompt('Client name (optional):', g.client_name || '');
    await api(`galleries/${id}`, { method: 'PATCH', body: { ...(title.trim() ? { title } : {}), ...(client !== null ? { client } : {}) } });
    load();
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
  $('#matrix-body').innerHTML = `<div class="table-scroll"><table class="matrix">
    <thead><tr><th></th><th>Photo</th>${SHOWN.map((k) => `<th>${k}</th>`).join('')}<th>Ladder</th><th>State</th></tr></thead>
    <tbody>${photos.map((p) => {
      const cell = (k) => p.assets[k]
        ? `<td class="ok">✓ ${fmtBytes(p.assets[k].bytes)}</td>`
        : '<td class="miss">—</td>';
      const rungKeys = Object.keys(p.assets).filter((k) => /^l\d+$/.test(k));
      const rungs = rungKeys.length;
      const missing = SHOWN.filter((k) => !p.assets[k]);
      return `<tr>
        <td>${rungKeys.length ? `<img class="thumb" src="${mediaBase(p, rungKeys.sort()[0])}" alt="">` : '<span class="thumb"></span>'}</td>
        <td>${p.marked ? '<span class="mark">●</span> ' : ''}${esc(p.stem)}${p.version > 1 ? ` <span class="muted">v${p.version}</span>` : ''}</td>
        ${SHOWN.map(cell).join('')}
        <td class="${rungs > 0 ? 'ok' : 'miss'}">${rungs} rung${rungs === 1 ? '' : 's'}</td>
        <td class="${missing.filter((k) => k !== 'instagram').length ? 'miss' : 'ok'}">${missing.length ? 'missing ' + missing.join(', ') : 'ready'}</td>
      </tr>`;
    }).join('')}</tbody></table></div>
    <p class="muted">Add or update photos above, or with the ingest CLI — a changed original bumps its
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
  $('#threads-body').onclick = async (e) => {  // property assignment: re-running load() must not stack handlers
    const op = e.target.dataset?.op;
    if (!op) return;
    const cid = e.target.closest('li').dataset.cid;
    if (op === 'resolve') { await api(`comments/${cid}/resolve`, { method: 'POST' }); load(); }
    if (op === 'reply') {
      const body = prompt('Reply (the client sees this in the photo’s thread):');
      if (body) { await api(`comments/${cid}/reply`, { method: 'POST', body: { body } }); load(); }
    }
  };

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
