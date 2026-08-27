/* Selects — client gallery behaviour. Vanilla JS, no build step: this file is
 * served verbatim from public/. State arrives inline from the Worker render
 * (#gallery-state); every mutation goes through …/api/* on the same
 * capability URL. Comment posts that fail show a visible retry — never a
 * silent queue (review § 4). */
(() => {
  'use strict';
  const state = JSON.parse(document.getElementById('gallery-state').textContent);
  const photos = new Map(state.photos.map((p) => [p.stem, p]));
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];

  /* ---------------------------------------------------------- viewer chip */
  const VIEWER_KEY = 'selects-viewer';
  let viewer = '';
  try { viewer = localStorage.getItem(VIEWER_KEY) || ''; } catch (e) { /* private mode */ }

  const api = (action, body) =>
    fetch(`${state.base}/api/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, viewer }),
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(data.message || data.error || 'failed'), { data });
      return data;
    });

  /* --------------------------------------------------------------- sheet */
  const sheet = $('#sheet');
  const sheetBody = $('#sheet-body');
  function openSheet(html) { sheetBody.innerHTML = html; sheet.hidden = false; }
  function closeSheet() { sheet.hidden = true; sheetBody.innerHTML = ''; }
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheet(); closeLightbox(); } });

  function askName(then) {
    if (viewer) return then();
    openSheet(`
      <h2>Viewing as</h2>
      <p>Just a name, so Santiago knows who marked and commented. No account, no email.</p>
      <label>Your name<input type="text" id="viewer-name" autocomplete="name" maxlength="40"></label>
      <div class="sheet__row"><button class="btn btn--primary" id="viewer-save">Continue</button></div>`);
    $('#viewer-name').focus();
    $('#viewer-save').addEventListener('click', () => {
      const name = $('#viewer-name').value.trim();
      if (!name) return $('#viewer-name').focus();
      viewer = name;
      try { localStorage.setItem(VIEWER_KEY, name); } catch (e) { /* fine */ }
      closeSheet();
      then();
    });
  }

  /* --------------------------------------------------------------- marks */
  let marked = state.photos.filter((p) => p.marked).map((p) => p.stem);
  let marksState = state.marksState;
  const tray = $('#tray');
  const trayCount = $('#tray-count');
  const finalizeBtn = $('#tray-finalize');

  function paintMarks() {
    banner();
    $$('.frame').forEach((f) => {
      const on = marked.includes(f.dataset.stem);
      f.classList.toggle('marked', on);
      f.querySelector('[data-act="mark"]')?.setAttribute('aria-pressed', String(on));
    });
    tray.hidden = false;
    trayCount.textContent =
      marksState === 'submitted'
        ? `${marked.length} sent for polish`
        : `${marked.length} / ${state.cap} marked for polish`;
    finalizeBtn.hidden = marksState === 'submitted';
    finalizeBtn.disabled = marked.length === 0;
  }

  function toggleMark(stem) {
    if (marksState === 'submitted') {
      return openSheet(`<h2>Selections are locked</h2>
        <p>Your marks are with Santiago. Need a change? Leave a comment on the
        photo and he can reopen them.</p>
        <div class="sheet__row"><button class="btn btn--quiet" onclick="document.getElementById('sheet').hidden=true">Close</button></div>`);
    }
    askName(async () => {
      const on = !marked.includes(stem);
      try {
        const r = await api('mark', { stem, on });
        marked = r.marked;
        paintMarks();
      } catch (err) {
        openSheet(`<h2>${on ? 'That makes ' + (state.cap + 1) : 'Hm'}</h2>
          <p>${err.message}</p>
          <div class="sheet__row"><button class="btn btn--quiet" id="sheet-ok">Close</button></div>`);
        $('#sheet-ok').addEventListener('click', closeSheet);
      }
    });
  }

  finalizeBtn.addEventListener('click', () => {
    if (marked.length === 0) return;
    askName(() => {
      const thumbs = marked
        .map((stem) => {
          const img = $(`.frame[data-stem="${CSS.escape(stem)}"] img`);
          return img ? `<img src="${img.currentSrc || img.src}" alt="${esc(stem)}">` : '';
        })
        .join('');
      openSheet(`
        <h2>Send ${marked.length} for polish</h2>
        <div class="review-grid">${thumbs}</div>
        <p>Santiago will polish these frames; the finished versions land back
        in this gallery marked “updated”. Your selection locks once sent.</p>
        <label>How should they feel? A sentence or two of direction.
          <textarea id="finalize-note" maxlength="2000" placeholder="e.g. Warmer overall, brighten my face a little, keep my skin natural — and please don’t remove my freckles."></textarea></label>
        <div class="starters" id="note-starters">
          <button type="button">Warmer, golden tones</button>
          <button type="button">Cooler, moodier tones</button>
          <button type="button">Keep the colors natural</button>
          <button type="button">Brighten my face a touch</button>
          <button type="button">Natural skin — keep texture, clear temporary blemishes</button>
          <button type="button">Smoother, more polished skin</button>
          <button type="button">Tidy flyaway hairs and distractions</button>
        </div>
        <p class="starters__hint">Tap a phrase to start a line, then make it yours — “warmer,
          brighter on my face, natural skin” is plenty. Say what should stay untouched
          (freckles, a scar you love), and feel free to name a photo of yours to match.</p>
        <div class="sheet__row">
          <button class="btn btn--quiet" id="finalize-cancel">Not yet</button>
          <button class="btn btn--primary" id="finalize-send" disabled>Send to Santiago</button>
        </div>`);
      const noteEl = $('#finalize-note');
      const sendEl = $('#finalize-send');
      noteEl.addEventListener('input', () => (sendEl.disabled = noteEl.value.trim().length < 4));
      $('#note-starters').addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        noteEl.value = (noteEl.value.trim() ? noteEl.value.replace(/\s*$/, '\n') : '') + b.textContent + '. ';
        noteEl.dispatchEvent(new Event('input'));
        noteEl.focus();
      });
      $('#finalize-cancel').addEventListener('click', closeSheet);
      $('#finalize-send').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          await api('finalize', { note: noteEl.value.trim() });
          marksState = 'submitted';
          paintMarks();
          openSheet(`<h2>Sent.</h2><p>Santiago has your ${marked.length} mark${marked.length === 1 ? '' : 's'}.
            Polished versions will appear right here — keep the link.</p>
            <div class="sheet__row"><button class="btn btn--primary" id="sheet-ok">Done</button></div>`);
          $('#sheet-ok').addEventListener('click', closeSheet);
        } catch (err) {
          e.target.disabled = false;
          alert(err.message);
        }
      });
    });
  });

  /* ------------------------------------------------------------- comments */
  function paintCommentCounts() {
    $$('.frame').forEach((f) => {
      const p = photos.get(f.dataset.stem);
      $('.act__count', f).textContent = p && p.comments > 0 ? String(p.comments) : '';
    });
  }

  function openComments(stem) {
    askName(async () => {
      openSheet(`<h2>Notes on ${esc(stem)}</h2>
        <ul class="thread" id="thread"><li><p class="what">Loading…</p></li></ul>
        <label>Ask for an edit or leave a note — Santiago reads these.
          <textarea id="comment-body" maxlength="4000" placeholder="e.g. Brighten my face here · remove the person behind me · soften the line under my eyes"></textarea></label>
        <p class="comment-error" id="comment-error" hidden></p>
        <div class="sheet__row">
          <button class="btn btn--quiet" id="comment-close">Close</button>
          <button class="btn btn--primary" id="comment-send">Send</button>
        </div>`);
      $('#comment-close').addEventListener('click', closeSheet);
      const thread = $('#thread');
      const render = (items) => {
        thread.innerHTML =
          items.length === 0
            ? '<li><p class="what" style="color:var(--ink-faint)">No notes yet.</p></li>'
            : items
                .map(
                  (c) => `<li><p class="who${c.by_owner ? ' owner' : ''}">${c.by_owner ? 'Santiago' : esc(c.author)}</p>
                          <p class="what">${esc(c.body)}</p></li>`
                )
                .join('');
      };
      try {
        const r = await fetch(`${state.base}/api/comments?photo=${encodeURIComponent(stem)}`);
        render((await r.json()).comments || []);
      } catch (e) { render([]); }
      $('#comment-send').addEventListener('click', async () => {
        const box = $('#comment-body');
        const body = box.value.trim();
        if (!body) return box.focus();
        const err = $('#comment-error');
        err.hidden = true;
        $('#comment-send').disabled = true;
        try {
          await api('comment', { stem, body });
          const p = photos.get(stem);
          if (p) p.comments += 1;
          paintCommentCounts();
          box.value = '';
          const li = document.createElement('li');
          li.innerHTML = `<p class="who">${esc(viewer)}</p><p class="what">${esc(body)}</p>`;
          thread.appendChild(li);
        } catch (e) {
          err.textContent = "Couldn't send — check your connection and try again.";
          err.hidden = false;
        } finally {
          $('#comment-send').disabled = false;
        }
      });
    });
  }

  /* ------------------------------------------------------------ downloads */
  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
  const KIND_LABEL = { original: 'Original · HEIC', instagram: 'Instagram · 3:4', rednote: 'RedNote · 3:4' };

  function openDownloads(stem) {
    const p = photos.get(stem);
    if (!p || p.downloads.length === 0) return;
    openSheet(`<h2>Download ${esc(stem)}</h2>
      <ul class="dl-list">${p.downloads
        .map((d) => `<li><a href="${d.href}"><span>${KIND_LABEL[d.kind] || d.kind}</span><span class="size">${fmtBytes(d.bytes)}</span></a></li>`)
        .join('')}</ul>
      <p style="margin-top:1rem">On iPhone: open the photo, then long-press → Add to Photos.
      Downloads land in Files otherwise.</p>
      <div class="sheet__row"><button class="btn btn--quiet" id="dl-close">Close</button></div>`);
    $('#dl-close').addEventListener('click', closeSheet);
  }

  $('#tray-dl').addEventListener('click', () => {
    const zip = (scope, kind) => `${state.base}/zip/${scope}/${kind}`;
    const markedRow = (kind) =>
      marked.length > 0
        ? `<li><a href="${zip('marked', kind)}"><span>Marked only · ${KIND_LABEL[kind]}</span><span class="size">${marked.length} file${marked.length === 1 ? '' : 's'}</span></a></li>`
        : '';
    openSheet(`<h2>Download everything</h2>
      <ul class="dl-list">
        ${['original', 'instagram', 'rednote']
          .map((kind) => `<li><a href="${zip('all', kind)}"><span>All photos · ${KIND_LABEL[kind]}</span><span class="size">zip</span></a></li>${markedRow(kind)}`)
          .join('')}
      </ul>
      <p style="margin-top:1rem">Zips start immediately and can be large — a desktop
      is the comfortable place for them.</p>
      <div class="sheet__row"><button class="btn btn--quiet" id="dl-close">Close</button></div>`);
    $('#dl-close').addEventListener('click', closeSheet);
  });

  /* ------------------------------------------------------------- lightbox */
  const lightbox = $('#lightbox');
  const order = state.photos.map((p) => p.stem);
  let lbIndex = -1;
  function openLightbox(stem) {
    lbIndex = order.indexOf(stem);
    if (lbIndex < 0) return;
    renderLightbox();
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function renderLightbox() {
    const stem = order[lbIndex];
    const pic = $(`.frame[data-stem="${CSS.escape(stem)}"] picture`);
    if (!pic) return;
    const isMarked = marked.includes(stem);
    lightbox.innerHTML = `${pic.outerHTML}
      <button class="lightbox__nav lightbox__nav--prev" aria-label="Previous"></button>
      <button class="lightbox__nav lightbox__nav--next" aria-label="Next"></button>
      <button class="lightbox__close" aria-label="Close">×</button>
      <div class="lightbox__bar">
        <button class="act${isMarked ? ' is-marked' : ''}" data-lb="mark">
          <span class="ring"></span>${isMarked ? 'Marked' : 'Mark for polish'}
        </button>
        <button class="act" data-lb="comment">✎ Note</button>
        <button class="act" data-lb="download">↓ Download</button>
      </div>`;
    const img = $('img', lightbox);
    img.loading = 'eager';
    img.sizes = '100vw';
    $$('source', lightbox).forEach((s) => { s.sizes = '100vw'; });
    $('.lightbox__nav--prev', lightbox).addEventListener('click', () => step(-1));
    $('.lightbox__nav--next', lightbox).addEventListener('click', () => step(1));
    $('.lightbox__close', lightbox).addEventListener('click', closeLightbox);
    $('[data-lb="mark"]', lightbox).addEventListener('click', () => {
      toggleMarkFromLightbox(stem);
    });
    $('[data-lb="comment"]', lightbox).addEventListener('click', () => {
      closeLightbox();
      openComments(stem);
    });
    $('[data-lb="download"]', lightbox).addEventListener('click', () => {
      closeLightbox();
      openDownloads(stem);
    });
  }
  function toggleMarkFromLightbox(stem) {
    if (marksState === 'submitted') { closeLightbox(); return toggleMark(stem); }
    askName(async () => {
      const on = !marked.includes(stem);
      try {
        const r = await api('mark', { stem, on });
        marked = r.marked;
        paintMarks();
        renderLightbox(); // refresh the bar's marked state
      } catch (err) {
        closeLightbox();
        openSheet(`<h2>All ${state.cap} marked</h2><p>${err.message}</p>
          <div class="sheet__row"><button class="btn btn--quiet" id="sheet-ok">Close</button></div>`);
        $('#sheet-ok').addEventListener('click', closeSheet);
      }
    });
  }
  function step(d) { lbIndex = (lbIndex + d + order.length) % order.length; renderLightbox(); }
  function closeLightbox() {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    lightbox.innerHTML = '';
    document.body.style.overflow = '';
  }
  document.addEventListener('keydown', (e) => {
    if (lightbox.hidden) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
  let touchX = null;
  lightbox.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 48) step(dx < 0 ? 1 : -1);
    touchX = null;
  }, { passive: true });

  /* --------------------------------------------------------------- expiry */
  function banner() {
    const el = $('#banner');
    const msLeft = new Date(state.expiry) - Date.now();
    const days = Math.ceil(msLeft / 86400000);
    const until = new Date(state.expiry).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    el.hidden = false;
    el.classList.toggle('urgent', days <= 7);
    if (marksState === 'open' && marked.length === 0) {
      // guidance until the first mark lands — the single most-missed action
      el.textContent = `Tap “Mark for polish” under your favorite frames — choose up to ${state.cap}. Available until ${until}.`;
    } else if (days <= 7) {
      el.textContent = `This gallery closes in ${days} day${days === 1 ? '' : 's'} — download what you want to keep.`;
    } else {
      el.textContent = `Available until ${until}.`;
    }
  }
  banner();

  /* ---------------------------------------------------------------- wire */
  function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

  $$('.frame').forEach((f) => {
    const stem = f.dataset.stem;
    $('.act--mark', f).addEventListener('click', () => toggleMark(stem));
    $('.act--comment', f).addEventListener('click', () => openComments(stem));
    $('.act--dl', f).addEventListener('click', () => openDownloads(stem));
    $('picture', f).addEventListener('click', () => openLightbox(stem));
  });

  paintMarks();
  paintCommentCounts();
})();
