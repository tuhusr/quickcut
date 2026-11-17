/* Quickcut editor: import → trim / order / split → export. */
(() => {
  const qc = window.qc;
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const video = $('video');
  paintIcons();

  /* ---------- helpers ---------- */

  const PAD = 24;           // timeline side padding (px)
  const MIN_LEN = 0.1;      // shortest clip (s)
  const SNAP_PX = 8;
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  function fmtTC(t) {
    t = Math.max(0, t || 0);
    const cs = Math.floor((t * 100) % 100);
    const s = Math.floor(t) % 60;
    const m = Math.floor(t / 60) % 60;
    const h = Math.floor(t / 3600);
    const p = (n) => String(n).padStart(2, '0');
    return (h ? `${h}:${p(m)}` : p(m)) + `:${p(s)}.${p(cs)}`;
  }
  function fmtShort(t) {
    t = Math.max(0, t || 0);
    if (t < 60) return `${t.toFixed(1)}s`;
    const m = Math.floor(t / 60);
    const s = Math.round(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function parseTC(str) {
    str = String(str).trim();
    if (!str) return NaN;
    if (!/^[\d:.]+$/.test(str)) return NaN;
    const parts = str.split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return NaN;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  const fmtBytes = (b) => {
    if (!b || b < 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
    return `${b < 10 && i > 1 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
  };

  function toast(msg, { error = false, ms = 4200 } = {}) {
    const t = $('toast');
    t.className = 'toast' + (error ? ' err' : '');
    t.innerHTML = `<svg data-icon="${error ? 'alert' : 'check'}"></svg><span>${esc(msg)}</span>`;
    paintIcons(t);
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, ms);
  }

  /* ---------- state ---------- */

  const media = new Map(); // id → { id, path, name, info, thumbs, playPath, status, error, proxyP, addedAt }
  const S = {
    clips: [],            // { id, mediaId, in, out, volume, muted }
    selected: null,
    playhead: 0,
    playing: false,
    zoom: 60,             // px per second
    snap: store.get('qc.snap', true),
    shape: 'orig',
    fit: 'fit',
  };
  let projectFile = null;
  let dirty = false;
  let past = [];
  let future = [];

  const snapshot = () => JSON.stringify({ clips: S.clips, selected: S.selected });
  function commit() {
    past.push(snapshot());
    if (past.length > 200) past.shift();
    future = [];
    markDirty();
  }
  function markDirty() {
    dirty = true;
    clearTimeout(markDirty.t);
    markDirty.t = setTimeout(() => { if (S.clips.length) qc.autosaveWrite(serialize()); }, 800);
  }
  function restore(snap) {
    const o = JSON.parse(snap);
    S.clips = o.clips;
    S.selected = o.selected;
    render();
    seekTo(S.playhead);
  }
  function undo() { if (!past.length) return; future.push(snapshot()); restore(past.pop()); markDirty(); }
  function redo() { if (!future.length) return; past.push(snapshot()); restore(future.pop()); markDirty(); }

  const len = (c) => c.out - c.in;
  const total = () => S.clips.reduce((t, c) => t + len(c), 0);
  const starts = () => { let t = 0; return S.clips.map((c) => { const s = t; t += len(c); return s; }); };
  const clipById = (id) => S.clips.find((c) => c.id === id);
  const selectedClip = () => clipById(S.selected);
  const fpsOf = (c) => (c && media.get(c.mediaId).info.fps) || 30;

  function locate(t) {
    const st = starts();
    for (let i = 0; i < S.clips.length; i++) {
      if (t < st[i] + len(S.clips[i]) - 1e-6) return { i, local: S.clips[i].in + Math.max(0, t - st[i]), start: st[i] };
    }
    const i = S.clips.length - 1;
    return i < 0 ? null : { i, local: S.clips[i].out, start: st[i], end: true };
  }

  /* ---------- import ---------- */

  const PLAYABLE_V = ['h264', 'vp8', 'vp9', 'av1'];
  const PLAYABLE_A = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'alac'];

  async function importPaths(paths) {
    if (!paths || !paths.length) return;
    const proj = paths.find((p) => /\.qcut$/i.test(p));
    if (proj) { openProject(proj); return; }
    const jobs = paths.map((p) => loadMedia(p));
    const added = (await Promise.all(jobs)).filter(Boolean);
    if (!added.length) { renderBin(); return; }
    commit();
    const wasEmpty = !S.clips.length;
    added.forEach((m) => S.clips.push({ id: uid(), mediaId: m.id, in: 0, out: m.info.duration, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 }));
    if (wasEmpty) { fitZoom(); S.selected = null; }
    render();
    if (wasEmpty) seekTo(0);
    toast(added.length === 1 ? `Added ${added[0].name}` : `Added ${added.length} clips`);
  }

  // Reads one file into the clip list. Resolves to the media, or null when it can't be read.
  function loadMedia(p, id = uid(), quiet = false) {
    return (async () => {
      const m = { id, path: p, name: p.split(/[\\/]/).pop(), info: null, thumbs: [], playPath: p, status: 'probing', addedAt: Date.now() };
      media.set(id, m);
      renderBin();
      try {
        m.info = await qc.probe(p);
      } catch (e) {
        m.status = 'error';
        m.error = (await qc.exists(p)) ? 'Can’t read this file' : 'File missing';
        renderBin();
        if (!quiet) toast(`${m.name}: this file isn’t a video or audio file Quickcut can read.`, { error: true });
        return null;
      }
      m.status = 'ready';
      const i = m.info;
      const needsProxy = (i.hasVideo && !PLAYABLE_V.includes(i.vcodec)) || (!i.hasVideo && i.hasAudio && !PLAYABLE_A.includes(i.acodec)) ||
        (i.hasVideo && i.hasAudio && !PLAYABLE_A.includes(i.acodec));
      if (needsProxy) makeProxy(m);
      if (i.hasVideo) {
        qc.thumbs(p, i.duration, Math.max(8, Math.min(60, Math.round(i.duration * 2)))).then((t) => {
          m.thumbs = t;
          m.addedAt = Date.now();
          renderBin();
          renderTimeline(true);
        }).catch(() => {});
      }
      if (i.hasAudio) {
        qc.waveform(p, i.duration).then((u) => { m.wave = u; renderTimeline(true); }).catch(() => {});
      }
      return m;
    })();
  }

  /* ---------- projects ---------- */

  function serialize() {
    const used = [...media.values()].filter((m) => m.status !== 'error');
    return JSON.stringify({
      app: 'quickcut', version: 1, name: $('editName').value || 'Untitled edit',
      shape: S.shape, fit: S.fit,
      media: used.map((m) => ({ id: m.id, path: m.path })),
      clips: S.clips.map(({ id, mediaId, in: i, out, volume, muted, fadeIn, fadeOut }) => ({ id, mediaId, in: i, out, volume, muted, fadeIn, fadeOut })),
    }, null, 1);
  }

  async function saveProject(saveAs = false) {
    if (!S.clips.length) return;
    const file = await qc.saveProject(serialize(), projectFile, saveAs);
    if (!file) return;
    projectFile = file;
    dirty = false;
    toast(`Saved ${file.split(/[\\/]/).pop()}`);
  }

  async function loadProjectJSON(json, file) {
    let o;
    try { o = JSON.parse(json); } catch { toast('That project file is damaged and can’t be opened.', { error: true }); return; }
    if (!o || o.app !== 'quickcut') { toast('That isn’t a Quickcut project.', { error: true }); return; }
    pause();
    media.clear();
    clipEls.forEach((el) => el.remove());
    clipEls.clear();
    loadedPath = null;
    video.removeAttribute('src');
    video.load();
    past = []; future = [];
    S.clips = []; S.selected = null; S.playhead = 0;
    $('editName').value = o.name || 'Untitled edit';
    S.shape = o.shape || 'orig';
    S.fit = o.fit || 'fit';
    render();
    const loaded = await Promise.all((o.media || []).map((m) => loadMedia(m.path, m.id, true)));
    const ok = new Set(loaded.filter(Boolean).map((m) => m.id));
    S.clips = (o.clips || []).filter((c) => ok.has(c.mediaId)).map((c) => ({ fadeIn: 0, fadeOut: 0, volume: 1, muted: false, ...c }));
    const missing = (o.media || []).length - ok.size;
    projectFile = file || null;
    dirty = false;
    fitZoom();
    render();
    seekTo(0);
    toast(missing ? `Opened. ${missing} file${missing > 1 ? 's are' : ' is'} missing, so ${missing > 1 ? 'their' : 'its'} clips were left out.` : `Opened ${o.name || 'project'}`, { error: !!missing, ms: 6000 });
  }

  async function openProject(file) {
    if (dirty && S.clips.length && !confirm('Open another project? Unsaved changes to this edit will be lost.')) return;
    const r = await qc.openProject(file);
    if (r) loadProjectJSON(r.json, r.file);
  }

  function makeProxy(m) {
    if (m.proxyP) return m.proxyP;
    m.proxying = 0;
    renderViewerNote();
    m.proxyP = qc.proxy(m.path).then((out) => {
      m.playPath = out;
      m.proxying = null;
      renderViewerNote();
      if (currentMediaId === m.id) { loadedPath = null; seekTo(S.playhead); }
      return out;
    }).catch(() => {
      m.proxying = null;
      m.previewFailed = true;
      renderViewerNote();
    });
    return m.proxyP;
  }
  qc.onProxyProgress(({ file, p }) => {
    media.forEach((m) => { if (m.path === file && m.proxying !== null && m.proxying !== undefined) m.proxying = p; });
    renderViewerNote();
  });

  function addMediaToTimeline(id, index = S.clips.length) {
    const m = media.get(id);
    if (!m || m.status !== 'ready') return;
    commit();
    const c = { id: uid(), mediaId: id, in: 0, out: m.info.duration, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 };
    S.clips.splice(index, 0, c);
    S.selected = c.id;
    render();
    seekTo(starts()[index]);
  }

  /* ---------- playback ---------- */

  let loadedPath = null;
  let currentMediaId = null;
  let currentIdx = -1;
  let pendingSeek = null;
  let wantPlay = false;

  function loadAt(idx, local, play) {
    const c = S.clips[idx];
    if (!c) return;
    const m = media.get(c.mediaId);
    currentIdx = idx;
    currentMediaId = m.id;
    video.volume = clamp(c.volume, 0, 1);
    video.muted = c.muted;
    const waitingProxy = m.proxying !== null && m.proxying !== undefined && m.playPath === m.path;
    if (waitingProxy) { video.removeAttribute('src'); loadedPath = null; video.load(); wantPlay = false; return; }
    if (loadedPath !== m.playPath) {
      loadedPath = m.playPath;
      pendingSeek = local;
      wantPlay = play;
      video.src = qc.mediaUrl(m.playPath);
    } else {
      if (Math.abs(video.currentTime - local) > 0.001) video.currentTime = local;
      if (play && video.paused) video.play().catch(() => {});
    }
  }

  video.addEventListener('loadedmetadata', () => {
    if (pendingSeek !== null) { video.currentTime = pendingSeek; pendingSeek = null; }
    if (wantPlay) { video.play().catch(() => {}); wantPlay = false; }
  });
  video.addEventListener('error', () => {
    const m = media.get(currentMediaId);
    if (!m) return;
    if (m.playPath === m.path) makeProxy(m);
  });

  function seekTo(t) {
    S.playhead = clamp(t, 0, total());
    const loc = locate(S.playhead);
    if (loc) loadAt(loc.i, loc.local, S.playing);
    renderPlayhead();
  }

  function play() {
    if (!S.clips.length) return;
    if (S.playhead >= total() - 0.02) S.playhead = 0;
    S.playing = true;
    const loc = locate(S.playhead);
    loadAt(loc.i, loc.local, true);
    renderPlayState();
    requestAnimationFrame(tick);
  }
  function pause() {
    S.playing = false;
    video.pause();
    renderPlayState();
  }
  const togglePlay = () => (S.playing ? pause() : play());

  function tick() {
    if (!S.playing) return;
    const c = S.clips[currentIdx];
    if (!c) { pause(); return; }
    const st = starts();
    const vt = loadedPath ? video.currentTime : null;
    if (vt !== null && !video.seeking && pendingSeek === null) {
      if (vt >= c.out - 0.015 || video.ended) {
        if (currentIdx + 1 < S.clips.length) {
          const n = S.clips[currentIdx + 1];
          S.playhead = st[currentIdx + 1];
          loadAt(currentIdx + 1, n.in, true);
        } else {
          S.playhead = total();
          pause();
        }
      } else if (vt >= c.in - 0.05) {
        S.playhead = st[currentIdx] + (vt - c.in);
      }
    }
    renderPlayhead();
    followPlayhead();
    requestAnimationFrame(tick);
  }

  function step(dir, big = false) {
    if (S.playing) pause();
    const d = big ? 1 : 1 / fpsOf(S.clips[locate(S.playhead)?.i]);
    seekTo(S.playhead + dir * d);
    followPlayhead();
  }

  /* ---------- edits ---------- */

  function split() {
    const loc = locate(S.playhead);
    if (!loc || loc.end) return;
    const c = S.clips[loc.i];
    if (loc.local - c.in < MIN_LEN || c.out - loc.local < MIN_LEN) { toast('Move the playhead further inside the clip to split it.'); return; }
    commit();
    const b = { ...c, id: uid(), in: loc.local };
    c.out = loc.local;
    S.clips.splice(loc.i + 1, 0, b);
    S.selected = b.id;
    render();
  }

  function removeSelected() {
    const i = S.clips.findIndex((c) => c.id === S.selected);
    if (i < 0) return;
    commit();
    S.clips.splice(i, 1);
    S.selected = S.clips[i] ? S.clips[i].id : S.clips[i - 1] ? S.clips[i - 1].id : null;
    if (!S.clips.length) { pause(); video.removeAttribute('src'); loadedPath = null; video.load(); }
    render();
    seekTo(Math.min(S.playhead, total()));
  }

  function setInOut(which) {
    const c = selectedClip();
    const loc = locate(S.playhead);
    if (!c || !loc || S.clips[loc.i].id !== c.id) { toast('Put the playhead over the selected clip first.'); return; }
    commit();
    if (which === 'in' && c.out - loc.local >= MIN_LEN) c.in = loc.local;
    if (which === 'out' && loc.local - c.in >= MIN_LEN) c.out = loc.local;
    render();
    seekTo(starts()[S.clips.indexOf(c)] + (which === 'in' ? 0 : len(c) - 0.001));
  }

  /* ---------- render ---------- */

  function render() {
    app.dataset.empty = S.clips.length || media.size ? 'false' : 'true';
    $('trackEmpty').hidden = S.clips.length > 0;
    renderBin();
    renderTimeline();
    renderInspector();
    renderPlayhead();
    renderPlayState();
    $('undoBtn').disabled = !past.length;
    $('redoBtn').disabled = !future.length;
    $('exportBtn').disabled = !S.clips.length;
    $('saveProjBtn').disabled = !S.clips.length;
    renderShape();
    $('splitBtn').disabled = !S.clips.length;
    $('deleteBtn').disabled = !S.selected;
  }

  function renderPlayState() {
    const b = $('playBtn');
    const svg = b.querySelector('svg');
    svg.setAttribute('data-icon', S.playing ? 'pause' : 'play');
    paintIcons(b);
    b.setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
    b.title = S.playing ? 'Pause (Space)' : 'Play (Space)';
  }

  function renderBin() {
    const list = $('binList');
    const items = [...media.values()];
    $('binCount').textContent = items.length ? items.length : '';
    $('binDrop').classList.toggle('compact', items.length > 0);
    list.innerHTML = items.map((m) => {
      const i = m.info;
      const thumb = m.thumbs[Math.floor(m.thumbs.length / 3)] || '';
      const sub = m.status === 'error' ? m.error : m.status === 'probing' ? 'Reading…' :
        [i.hasVideo ? `${i.width}×${i.height}` : 'Audio', i.hasVideo && i.fps ? `${Math.round(i.fps * 100) / 100} fps` : ''].filter(Boolean).join(' · ');
      const fresh = Date.now() - m.addedAt < 1500 && m.thumbs.length ? ' develop' : '';
      return `<div class="bin-item${m.status !== 'ready' ? ' loading' : ''}${fresh}" role="listitem" draggable="${m.status === 'ready'}" data-media="${m.id}" title="${esc(m.path)}">
        <div class="bin-thumb" style="${thumb ? `background-image:url('${thumb}')` : ''}">${!thumb && i && !i.hasVideo ? '<svg data-icon="audio"></svg>' : ''}${i ? `<span class="dur">${fmtShort(i.duration)}</span>` : ''}</div>
        <div class="bin-meta"><div class="bin-name">${esc(m.name)}</div><div class="bin-sub${m.status === 'error' ? ' err' : ''}">${esc(sub)}</div></div>
        ${m.status === 'ready' ? `<button class="icon-btn sm bin-add" data-add="${m.id}" aria-label="Add ${esc(m.name)} to the end of the timeline" title="Add to timeline"><svg data-icon="plus"></svg></button>` : '<span></span>'}
      </div>`;
    }).join('');
    paintIcons(list);
  }

  const clipEls = new Map();
  function renderTimeline(forceFrames = false) {
    const track = $('track');
    const scroll = $('tlScroll');
    const T = total();
    const width = Math.max(scroll.clientWidth, T * S.zoom + PAD * 2 + 240);
    $('tlInner').style.width = `${width}px`;
    const st = starts();
    const seen = new Set();
    S.clips.forEach((c, i) => {
      seen.add(c.id);
      let el = clipEls.get(c.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'clip';
        el.dataset.id = c.id;
        el.innerHTML = '<div class="clip-frames"></div><div class="clip-wave"></div><div class="clip-fade in"></div><div class="clip-fade out"></div><div class="clip-label"><span class="nm"></span><span class="du"></span></div><div class="handle l" data-h="l" aria-hidden="true"></div><div class="handle r" data-h="r" aria-hidden="true"></div>';
        track.appendChild(el);
        clipEls.set(c.id, el);
      }
      const m = media.get(c.mediaId);
      const x = PAD + st[i] * S.zoom + (c._dx || 0);
      const w = Math.max(4, len(c) * S.zoom - (c._dx || 0));
      el.style.left = `${x}px`;
      el.style.width = `${w}px`;
      el.classList.toggle('selected', c.id === S.selected);
      el.classList.toggle('narrow', w < 110);
      el.classList.toggle('develop', m.thumbs.length > 0 && Date.now() - m.addedAt < 1700);
      el.querySelector('.nm').textContent = m.name.replace(/\.[^.]+$/, '');
      el.querySelector('.du').textContent = fmtShort(len(c));
      el.title = `${m.name} · ${fmtTC(c.in)} → ${fmtTC(c.out)}`;
      let mute = el.querySelector('.clip-muted');
      if (c.muted && !mute) { el.insertAdjacentHTML('beforeend', '<span class="clip-muted" title="Muted"><svg data-icon="volumeOff"></svg></span>'); paintIcons(el); }
      if (!c.muted && mute) mute.remove();
      drawFrames(el, c, m, w, forceFrames);
      el.classList.toggle('audio-only', !m.info.hasVideo);
      const wave = el.querySelector('.clip-wave');
      if (m.wave) {
        wave.style.backgroundImage = `url('${m.wave}')`;
        wave.style.backgroundSize = `${m.info.duration * S.zoom}px 100%`;
        wave.style.backgroundPosition = `${-(c.in * S.zoom + (c._dx || 0))}px 0`;
      }
      el.querySelector('.clip-fade.in').style.width = `${Math.min(w, (c.fadeIn || 0) * S.zoom)}px`;
      el.querySelector('.clip-fade.out').style.width = `${Math.min(w, (c.fadeOut || 0) * S.zoom)}px`;
    });
    clipEls.forEach((el, id) => { if (!seen.has(id)) { el.remove(); clipEls.delete(id); } });
    renderRuler();
    $('timelineMeta').textContent = S.clips.length ? `${S.clips.length} clip${S.clips.length > 1 ? 's' : ''} · ${fmtTC(T)}` : '';
  }

  function drawFrames(el, c, m, w, force) {
    const box = el.querySelector('.clip-frames');
    const h = box.clientHeight || 80;
    const key = `${c.in.toFixed(3)}|${c.out.toFixed(3)}|${S.zoom}|${w}|${h}|${m.thumbs.length}|${c._dx || 0}`;
    if (!force && box.dataset.key === key) return;
    box.dataset.key = key;
    if (!m.info.hasVideo) {
      box.innerHTML = m.wave ? '' : '<div class="clip-audio"><svg data-icon="audio"></svg></div>';
      paintIcons(box);
      return;
    }
    if (!m.thumbs.length) { box.innerHTML = ''; return; }
    const aspect = m.info.width && m.info.height ? m.info.width / m.info.height : 16 / 9;
    const fw = Math.max(24, h * aspect);
    const n = Math.min(240, Math.ceil(w / fw));
    const shownIn = c.in + (c._dx || 0) / S.zoom;
    let html = '';
    for (let k = 0; k < n; k++) {
      const t = shownIn + ((k + 0.5) * fw) / S.zoom;
      const idx = clamp(Math.floor((t / m.info.duration) * m.thumbs.length), 0, m.thumbs.length - 1);
      html += `<img src="${m.thumbs[idx]}" style="width:${fw}px" alt="" draggable="false">`;
    }
    box.innerHTML = html;
  }

  const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  function renderRuler() {
    const ruler = $('ruler');
    const scroll = $('tlScroll');
    const major = STEPS.find((s) => s * S.zoom >= 90) || 3600;
    const minorDiv = major >= 60 ? 6 : major === 15 || major === 30 ? 3 : major === 2 || major === 0.2 ? 4 : 5;
    const minor = major / minorDiv;
    $('track').style.setProperty('--grid', `${major * S.zoom}px`);
    const from = Math.max(0, (scroll.scrollLeft - PAD) / S.zoom - major);
    const to = (scroll.scrollLeft + scroll.clientWidth) / S.zoom + major;
    let html = '';
    for (let k = Math.floor(from / minor); k * minor <= to; k++) {
      const t = Math.round(k * minor * 1000) / 1000;
      const x = PAD + t * S.zoom;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      html += `<i class="tick${isMajor ? ' major' : ''}" style="left:${x}px"></i>`;
      if (isMajor) html += `<span class="lbl" style="left:${x}px">${major < 1 ? fmtTC(t).replace(/^00:/, '') : fmtTC(t).replace(/\.\d+$/, '')}</span>`;
    }
    ruler.innerHTML = html;
  }

  let lastTC = '';
  function renderTC(el, str, roll) {
    if (el.dataset.v === str) return;
    const prev = el.dataset.v || '';
    el.dataset.v = str;
    if (el.children.length !== str.length) el.innerHTML = [...str].map((ch) => `<span class="${/\d/.test(ch) ? 'd' : 'p'}">${ch}</span>`).join('');
    [...str].forEach((ch, i) => {
      const span = el.children[i];
      if (span.textContent !== ch) {
        span.textContent = ch;
        span.className = /\d/.test(ch) ? 'd' : 'p';
        // centiseconds change every frame while playing; only the slower digits roll
        if (roll && prev.length === str.length && !(S.playing && i >= str.length - 2)) {
          span.classList.remove('roll'); void span.offsetWidth; span.classList.add('roll');
        }
      }
    });
  }

  function fadeLevel(c, local) {
    let k = 1;
    if (c.fadeIn > 0) k = Math.min(k, (local - c.in) / c.fadeIn);
    if (c.fadeOut > 0) k = Math.min(k, (c.out - local) / c.fadeOut);
    return clamp(k, 0, 1);
  }
  function applyFade() {
    const loc = locate(S.playhead);
    if (!loc) { video.style.opacity = 1; return; }
    const c = S.clips[loc.i];
    const k = fadeLevel(c, loc.local);
    video.style.opacity = k;
    if (S.clips[currentIdx] === c) video.volume = clamp(c.volume * k, 0, 1);
  }

  function renderPlayhead() {
    applyFade();
    $('playhead').style.left = `${PAD + S.playhead * S.zoom}px`;
    renderTC($('tcNow'), fmtTC(S.playhead), true);
    const tt = fmtTC(total());
    if (tt !== lastTC) { renderTC($('tcTotal'), tt, false); lastTC = tt; }
  }

  function followPlayhead() {
    const scroll = $('tlScroll');
    const x = PAD + S.playhead * S.zoom;
    if (x > scroll.scrollLeft + scroll.clientWidth - 60) scroll.scrollLeft = x - 120;
    else if (x < scroll.scrollLeft + 20) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth + 120);
  }

  const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };
  function renderShape() {
    const sel = $('shapeSel');
    if (sel.value !== S.shape) sel.value = S.shape;
    const fb = $('fitBtn2');
    fb.hidden = S.shape === 'orig';
    fb.setAttribute('aria-pressed', String(S.fit === 'fill'));
    const viewer = $('viewer');
    const frame = $('frame');
    const first = S.clips[0] && media.get(S.clips[0].mediaId).info;
    const ar = ASPECTS[S.shape] || (first && first.width && first.height ? first.width / first.height : 0);
    viewer.classList.toggle('shaped', S.shape !== 'orig');
    frame.classList.toggle('fill', S.shape !== 'orig' && S.fit === 'fill');
    if (!ar) { frame.style.width = '100%'; frame.style.height = '100%'; return; }
    const vw = viewer.clientWidth;
    const vh = viewer.clientHeight;
    const w = Math.min(vw, vh * ar);
    frame.style.width = `${w}px`;
    frame.style.height = `${w / ar}px`;
  }
  $('shapeSel').addEventListener('change', (e) => { commitShape({ shape: e.target.value }); });
  $('fitBtn2').addEventListener('click', () => commitShape({ fit: S.fit === 'fill' ? 'fit' : 'fill' }));
  function commitShape(patch) { Object.assign(S, patch); markDirty(); renderShape(); }
  new ResizeObserver(() => renderShape()).observe($('viewer'));

  function renderViewerNote() {
    const note = $('viewerNote');
    const loc = locate(S.playhead);
    const m = loc && media.get(S.clips[loc.i].mediaId);
    if (m && m.proxying !== null && m.proxying !== undefined && m.playPath === m.path) {
      note.hidden = false;
      note.textContent = `Preparing preview of ${m.name}… ${Math.round((m.proxying || 0) * 100)}%`;
    } else if (m && m.previewFailed) {
      note.hidden = false;
      note.textContent = `Can’t preview ${m.name}, but it will still export.`;
    } else note.hidden = true;
  }

  /* ---------- inspector ---------- */

  const fadeOpts = (v) => [[0, 'None'], [0.25, '0.25 s'], [0.5, '0.5 s'], [1, '1 s'], [2, '2 s'], [3, '3 s']]
    .map(([n, l]) => `<option value="${n}"${Math.abs((v || 0) - n) < 0.001 ? ' selected' : ''}>${l}</option>`).join('');

  function renderInspector() {
    const box = $('inspector');
    const keys = `<div class="insp-section"><h2 style="margin-bottom:12px">Shortcuts</h2><div class="keys">
      <kbd>Space</kbd><span>Play / pause</span>
      <kbd>S</kbd><span>Split at playhead</span>
      <kbd>I</kbd><span>Trim start to playhead</span>
      <kbd>O</kbd><span>Trim end to playhead</span>
      <kbd>Del</kbd><span>Remove clip</span>
      <kbd>← →</kbd><span>One frame (Shift: 1 s)</span>
      <kbd>Ctrl Z</kbd><span>Undo</span>
      <kbd>Ctrl S</kbd><span>Save project</span>
      <kbd>Ctrl E</kbd><span>Export</span></div></div>`;
    const c = selectedClip();
    if (!c) {
      if (!S.clips.length) {
        box.innerHTML = `<div class="insp-section"><h2 style="margin-bottom:10px">How it works</h2><p class="insp-lead">Drop clips in. They line up on the timeline in the order you add them. Drag a clip to move it, pull its edges to trim, press S to cut it in two. Export saves one new video; your originals stay untouched.</p></div>${keys}`;
      } else {
        const first = media.get(S.clips[0].mediaId).info;
        box.innerHTML = `<div class="insp-section"><div class="insp-title">${esc($('editName').value || 'Untitled edit')}</div><div class="insp-sub">Click a clip to trim or adjust it.</div></div>
          <div class="insp-section"><dl class="stat-grid">
            <dt>Length</dt><dd>${fmtTC(total())}</dd>
            <dt>Clips</dt><dd>${S.clips.length}</dd>
            ${first.hasVideo ? `<dt>Size</dt><dd>${first.width}×${first.height}</dd><dt>Frame rate</dt><dd>${Math.round(first.fps * 100) / 100}</dd>` : ''}
          </dl></div>${keys}`;
      }
      return;
    }
    const m = media.get(c.mediaId);
    const i = m.info;
    const vol = Math.round(c.volume * 100);
    box.innerHTML = `
      <div class="insp-section"><div class="insp-title">${esc(m.name)}</div><div class="insp-sub" title="${esc(m.path)}">${esc(m.path)}</div></div>
      <div class="insp-section" style="display:grid;gap:12px">
        <div class="field-row">
          <label class="field"><span>Start</span><input type="text" id="fIn" value="${fmtTC(c.in)}" spellcheck="false"></label>
          <label class="field"><span>End</span><input type="text" id="fOut" value="${fmtTC(c.out)}" spellcheck="false"></label>
        </div>
        <dl class="stat-grid"><dt>Length</dt><dd>${fmtTC(len(c))}</dd><dt>Original</dt><dd>${fmtTC(i.duration)}</dd></dl>
      </div>
      <div class="insp-section" style="display:grid;gap:10px">
        <div class="group-label" style="margin:0">Volume</div>
        <div class="vol">
          <button class="icon-btn sm" id="fMute" aria-pressed="${c.muted}" aria-label="${c.muted ? 'Unmute' : 'Mute'}" title="${c.muted ? 'Unmute' : 'Mute'}" ${i.hasAudio ? '' : 'disabled'}><svg data-icon="${c.muted || !i.hasAudio ? 'volumeOff' : 'volume'}"></svg></button>
          <input type="range" id="fVol" min="0" max="200" step="1" value="${vol}" style="--fill:${vol / 2}%" aria-label="Volume" ${i.hasAudio && !c.muted ? '' : 'disabled'}>
          <output id="fVolOut">${i.hasAudio ? `${vol}%` : 'None'}</output>
        </div>
      </div>
      <div class="insp-section" style="display:grid;gap:10px">
        <div class="group-label" style="margin:0">Fade</div>
        <div class="field-row fades">
          <label class="field"><span>In (from black)</span><select id="fFadeIn">${fadeOpts(c.fadeIn)}</select></label>
          <label class="field"><span>Out (to black)</span><select id="fFadeOut">${fadeOpts(c.fadeOut)}</select></label>
        </div>
      </div>
      <div class="insp-section insp-actions">
        <button class="btn btn-quiet" id="fSplit"><svg data-icon="scissors"></svg><span>Split at playhead</span></button>
        <button class="btn btn-quiet" id="fRemove"><svg data-icon="trash"></svg><span>Remove from timeline</span></button>
      </div>
      <div class="insp-section"><dl class="stat-grid">
        ${i.hasVideo ? `<dt>Size</dt><dd>${i.width}×${i.height}</dd><dt>Frame rate</dt><dd>${Math.round(i.fps * 100) / 100}</dd><dt>Video</dt><dd>${esc((i.vcodec || '').toUpperCase())}</dd>` : ''}
        <dt>Audio</dt><dd>${i.hasAudio ? esc((i.acodec || '').toUpperCase()) : 'None'}</dd>
        <dt>File</dt><dd>${fmtBytes(i.size)}</dd>
      </dl></div>`;
    paintIcons(box);

    const bindTC = (id, which) => {
      const inp = $(id);
      const apply = () => {
        const v = parseTC(inp.value);
        const ok = !Number.isNaN(v) && (which === 'in' ? v >= 0 && v <= c.out - MIN_LEN : v >= c.in + MIN_LEN && v <= i.duration + 0.001);
        if (!ok) { inp.classList.add('invalid'); toast(which === 'in' ? `Start must be between 00:00.00 and ${fmtTC(c.out - MIN_LEN)}.` : `End must be between ${fmtTC(c.in + MIN_LEN)} and ${fmtTC(i.duration)}.`, { error: true }); return; }
        commit();
        c[which] = Math.min(v, i.duration);
        render();
        seekTo(starts()[S.clips.indexOf(c)]);
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); inp.blur(); } if (e.key === 'Escape') { inp.value = fmtTC(c[which]); inp.blur(); } });
      inp.addEventListener('change', apply);
      inp.addEventListener('input', () => inp.classList.remove('invalid'));
    };
    bindTC('fIn', 'in');
    bindTC('fOut', 'out');
    const volIn = $('fVol');
    let volCommitted = false;
    volIn.addEventListener('input', () => {
      if (!volCommitted) { commit(); volCommitted = true; }
      c.volume = Number(volIn.value) / 100;
      volIn.style.setProperty('--fill', `${volIn.value / 2}%`);
      $('fVolOut').textContent = `${volIn.value}%`;
      if (currentIdx >= 0 && S.clips[currentIdx] === c) video.volume = clamp(c.volume, 0, 1);
    });
    volIn.addEventListener('change', () => { volCommitted = false; });
    $('fMute').addEventListener('click', () => { commit(); c.muted = !c.muted; if (S.clips[currentIdx] === c) video.muted = c.muted; render(); });
    const bindFade = (id, key) => $(id).addEventListener('change', (e) => {
      commit();
      c[key] = Math.min(Number(e.target.value), len(c) / 2);
      render();
    });
    bindFade('fFadeIn', 'fadeIn');
    bindFade('fFadeOut', 'fadeOut');
    $('fSplit').addEventListener('click', split);
    $('fRemove').addEventListener('click', removeSelected);
  }

  $('editName').addEventListener('input', () => { if (!S.selected) renderInspector(); });

  /* ---------- zoom ---------- */

  const ZMIN = 2;
  const ZMAX = 500;
  const zoomToRange = (z) => (Math.log(z / ZMIN) / Math.log(ZMAX / ZMIN)) * 100;
  const rangeToZoom = (v) => ZMIN * Math.pow(ZMAX / ZMIN, v / 100);
  function setZoom(z, anchorX) {
    const scroll = $('tlScroll');
    const ax = anchorX ?? PAD + S.playhead * S.zoom - scroll.scrollLeft;
    const tAt = (scroll.scrollLeft + ax - PAD) / S.zoom;
    S.zoom = clamp(z, ZMIN, ZMAX);
    const r = $('zoomRange');
    r.value = zoomToRange(S.zoom);
    r.style.setProperty('--fill', `${r.value}%`);
    renderTimeline();
    scroll.scrollLeft = PAD + tAt * S.zoom - ax;
    renderRuler();
    renderPlayhead();
  }
  function fitZoom() {
    const w = $('tlScroll').clientWidth - PAD * 2 - 40;
    const T = total() || 30;
    S.zoom = clamp(w / T, ZMIN, ZMAX);
    const r = $('zoomRange');
    r.value = zoomToRange(S.zoom);
    r.style.setProperty('--fill', `${r.value}%`);
    $('tlScroll').scrollLeft = 0;
    renderTimeline();
    renderPlayhead();
  }
  $('zoomRange').addEventListener('input', (e) => setZoom(rangeToZoom(Number(e.target.value))));
  $('zoomIn').addEventListener('click', () => setZoom(S.zoom * 1.5));
  $('zoomOut').addEventListener('click', () => setZoom(S.zoom / 1.5));
  $('fitBtn').addEventListener('click', fitZoom);
  $('tlScroll').addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const rect = $('tlScroll').getBoundingClientRect();
      setZoom(S.zoom * Math.pow(1.0018, -e.deltaY), e.clientX - rect.left);
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      $('tlScroll').scrollLeft += e.deltaY;
    }
  }, { passive: false });
  $('tlScroll').addEventListener('scroll', () => renderRuler());
  window.addEventListener('resize', () => renderTimeline(true));

  /* ---------- timeline pointer interactions ---------- */

  const tlX = (e) => e.clientX - $('tlInner').getBoundingClientRect().left;
  const timeAt = (e) => clamp((tlX(e) - PAD) / S.zoom, 0, total());

  const tip = document.createElement('div');
  tip.className = 'drag-tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  const showTip = (e, text) => { tip.hidden = false; tip.textContent = text; tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY - 34}px`; };

  function scrub(e) {
    const wasPlaying = S.playing;
    if (wasPlaying) pause();
    seekTo(timeAt(e));
    const move = (ev) => seekTo(timeAt(ev));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  $('ruler').addEventListener('pointerdown', (e) => { e.preventDefault(); scrub(e); });
  document.querySelector('.playhead-cap').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); scrub(e); });

  $('track').addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const clipEl = e.target.closest('.clip');
    if (!clipEl) { S.selected = null; render(); scrub(e); return; }
    e.preventDefault();
    const c = clipById(clipEl.dataset.id);
    const h = e.target.dataset.h;
    if (h) return startTrim(e, c, h);
    startMove(e, c, clipEl);
  });

  function startTrim(e, c, side) {
    if (S.playing) pause();
    S.selected = c.id;
    const m = media.get(c.mediaId);
    const before = snapshot();
    const o = { in: c.in, out: c.out };
    const x0 = e.clientX;
    const idx = S.clips.indexOf(c);
    const clipStart = starts()[idx];
    render();
    document.body.style.cursor = 'ew-resize';
    const move = (ev) => {
      const dt = (ev.clientX - x0) / S.zoom;
      const snapT = (seqT) => {
        if (!S.snap) return seqT;
        const targets = [S.playhead];
        for (const t of targets) if (Math.abs(t - seqT) * S.zoom < SNAP_PX) return t;
        return seqT;
      };
      if (side === 'l') {
        let ni = clamp(o.in + dt, 0, o.out - MIN_LEN);
        ni = clamp(o.in + snapT(clipStart + (ni - o.in)) - clipStart, 0, o.out - MIN_LEN);
        if (S.snap && Math.abs(ni) * S.zoom < SNAP_PX) ni = 0;
        c.in = ni;
        c._dx = (ni - o.in) * S.zoom; // left edge follows the cursor; gap closes on release
        c.in = o.in;
        c._pendingIn = ni;
        showTip(ev, `Start ${fmtTC(ni)}`);
        seekPreview(ni);
      } else {
        let no = clamp(o.out + dt, o.in + MIN_LEN, m.info.duration);
        no = clamp(o.in + snapT(clipStart + (no - o.in)) - clipStart, o.in + MIN_LEN, m.info.duration);
        if (S.snap && Math.abs(m.info.duration - no) * S.zoom < SNAP_PX) no = m.info.duration;
        c.out = no;
        showTip(ev, `End ${fmtTC(no)} · ${fmtShort(no - o.in)}`);
        seekPreview(no - 0.001);
      }
      renderTimeline();
    };
    const seekPreview = (local) => { loadAt(idx, local, false); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      tip.hidden = true;
      if (c._pendingIn !== undefined) { c.in = c._pendingIn; delete c._pendingIn; }
      delete c._dx;
      if (c.in !== o.in || c.out !== o.out) { past.push(before); future = []; }
      render();
      seekTo(side === 'l' ? starts()[idx] : starts()[idx] + len(c) - 0.001);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startMove(e, c, el) {
    const x0 = e.clientX;
    let dragging = false;
    let ghost = null;
    let target = -1;
    const fromIdx = S.clips.indexOf(c);
    if (S.selected !== c.id) { S.selected = c.id; render(); }
    const move = (ev) => {
      if (!dragging && Math.abs(ev.clientX - x0) < 4) return;
      if (!dragging) {
        dragging = true;
        if (S.playing) pause();
        el.classList.add('dragging');
        ghost = el.cloneNode(true);
        ghost.classList.remove('dragging');
        ghost.classList.add('ghost');
        ghost.style.width = `${Math.min(el.offsetWidth, 260)}px`;
        document.body.appendChild(ghost);
        document.body.style.cursor = 'grabbing';
      }
      const r = $('track').getBoundingClientRect();
      ghost.style.left = `${ev.clientX - 30}px`;
      ghost.style.top = `${r.top + 14}px`;
      ghost.style.height = `${el.offsetHeight}px`;
      const t = (tlX(ev) - PAD) / S.zoom;
      const st = starts();
      target = S.clips.length;
      for (let i = 0; i < S.clips.length; i++) if (t < st[i] + len(S.clips[i]) / 2) { target = i; break; }
      const mark = $('insertMark');
      const markT = target < S.clips.length ? st[target] : total();
      const noop = target === fromIdx || target === fromIdx + 1;
      mark.hidden = noop;
      mark.style.left = `${PAD + markT * S.zoom}px`;
      autoScroll(ev);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      $('insertMark').hidden = true;
      if (ghost) ghost.remove();
      el.classList.remove('dragging');
      if (!dragging) {
        // A plain click selects the clip and parks the playhead where you clicked.
        seekTo(timeAt(e));
        return;
      }
      if (target >= 0 && target !== fromIdx && target !== fromIdx + 1) {
        commit();
        S.clips.splice(fromIdx, 1);
        S.clips.splice(target > fromIdx ? target - 1 : target, 0, c);
        render();
        seekTo(starts()[S.clips.indexOf(c)]);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function autoScroll(ev) {
    const s = $('tlScroll');
    const r = s.getBoundingClientRect();
    if (ev.clientX > r.right - 40) s.scrollLeft += 18;
    else if (ev.clientX < r.left + 40) s.scrollLeft -= 18;
  }

  /* ---------- bin interactions ---------- */

  $('binList').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) addMediaToTimeline(add.dataset.add);
  });
  $('binList').addEventListener('dblclick', (e) => {
    const it = e.target.closest('.bin-item');
    if (it && !e.target.closest('[data-add]')) addMediaToTimeline(it.dataset.media);
  });
  $('binList').addEventListener('dragstart', (e) => {
    const it = e.target.closest('.bin-item');
    if (!it) return;
    e.dataTransfer.setData('text/qc-media', it.dataset.media);
    e.dataTransfer.effectAllowed = 'copy';
  });

  /* ---------- file drop ---------- */

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if ([...(e.dataTransfer?.types || [])].includes('text/qc-media')) {
      e.dataTransfer.dropEffect = 'copy';
      const overTrack = e.target.closest && e.target.closest('.timeline');
      const mark = $('insertMark');
      if (overTrack) {
        const t = (tlX(e) - PAD) / S.zoom;
        const st = starts();
        let idx = S.clips.length;
        for (let i = 0; i < S.clips.length; i++) if (t < st[i] + len(S.clips[i]) / 2) { idx = i; break; }
        mark.hidden = false;
        mark.style.left = `${PAD + (idx < S.clips.length ? st[idx] : total()) * S.zoom}px`;
        mark.dataset.idx = idx;
      } else mark.hidden = true;
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    const mid = e.dataTransfer.getData('text/qc-media');
    const mark = $('insertMark');
    if (mid) {
      const idx = mark.hidden ? null : Number(mark.dataset.idx);
      mark.hidden = true;
      if (idx !== null) addMediaToTimeline(mid, idx);
      return;
    }
    const paths = [...e.dataTransfer.files].map((f) => qc.pathFor(f)).filter(Boolean);
    importPaths(paths);
  });

  const choose = async () => importPaths(await qc.openFiles());
  $('addBtn').addEventListener('click', choose);
  $('binDrop').addEventListener('click', choose);
  $('chooseBtn').addEventListener('click', choose);

  /* ---------- buttons & keys ---------- */

  $('playBtn').addEventListener('click', togglePlay);
  $('toStartBtn').addEventListener('click', () => { pause(); seekTo(0); followPlayhead(); });
  $('toEndBtn').addEventListener('click', () => { pause(); seekTo(total()); followPlayhead(); });
  $('prevFrameBtn').addEventListener('click', () => step(-1));
  $('nextFrameBtn').addEventListener('click', () => step(1));
  $('splitBtn').addEventListener('click', split);
  $('deleteBtn').addEventListener('click', removeSelected);
  $('openProjBtn').addEventListener('click', () => openProject());
  $('saveProjBtn').addEventListener('click', () => saveProject());
  $('editName').addEventListener('change', markDirty);
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('snapBtn').setAttribute('aria-pressed', String(S.snap));
  $('snapBtn').addEventListener('click', () => { S.snap = !S.snap; store.set('qc.snap', S.snap); $('snapBtn').setAttribute('aria-pressed', String(S.snap)); });
  $('exportBtn').addEventListener('click', () => openExport());
  video.addEventListener('click', togglePlay);

  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' && !['range', 'checkbox', 'radio'].includes(e.target.type) || tag === 'select' || tag === 'textarea';
    if ($('exportDlg').open) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); if (S.clips.length) openExport(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); e.shiftKey ? openProject() : choose(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(e.shiftKey); return; }
    if (typing || mod) return;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 's': case 'S': e.preventDefault(); split(); break;
      case 'i': case 'I': setInOut('in'); break;
      case 'o': case 'O': setInOut('out'); break;
      case 'Delete': case 'Backspace': e.preventDefault(); removeSelected(); break;
      case 'ArrowLeft': e.preventDefault(); step(-1, e.shiftKey); break;
      case 'ArrowRight': e.preventDefault(); step(1, e.shiftKey); break;
      case 'Home': e.preventDefault(); pause(); seekTo(0); followPlayhead(); break;
      case 'End': e.preventDefault(); pause(); seekTo(total()); followPlayhead(); break;
      case '+': case '=': setZoom(S.zoom * 1.5); break;
      case '-': case '_': setZoom(S.zoom / 1.5); break;
      case 'Escape': S.selected = null; render(); break;
      default:
    }
  });

  /* ---------- export ---------- */

  const FORMATS = {
    mp4: { label: 'MP4', video: ['h264', 'h265', 'av1'], audio: ['aac', 'alac', 'mp3', 'opus'], note: 'Plays everywhere: phones, the web, every editor.' },
    mov: { label: 'MOV', video: ['h264', 'h265', 'prores'], audio: ['aac', 'alac', 'pcm'], note: 'Apple and pro editing. Pick ProRes for a high-quality editing master.' },
    mkv: { label: 'MKV', video: ['h264', 'h265', 'av1', 'vp9', 'ffv1'], audio: ['aac', 'flac', 'opus', 'mp3', 'pcm'], note: 'Holds anything. FFV1 + FLAC is true lossless, at big file sizes.' },
    webm: { label: 'WebM', video: ['vp9', 'av1'], audio: ['opus'], note: 'Made for websites and browsers.' },
    gif: { label: 'GIF', video: ['gif'], audio: [], note: 'Silent, looping image. Files get big fast, so keep it short.' },
    mp3: { label: 'MP3', video: [], audio: ['mp3'], note: 'Audio only.' },
    wav: { label: 'WAV', video: [], audio: ['pcm'], note: 'Audio only, uncompressed.' },
  };
  const VCODEC = { h264: 'H.264 (plays anywhere)', h265: 'H.265 (smaller)', av1: 'AV1 (smallest)', vp9: 'VP9', prores: 'Apple ProRes', ffv1: 'FFV1 (lossless)' };
  const ACODEC = { aac: 'AAC', alac: 'ALAC (lossless)', mp3: 'MP3', opus: 'Opus', flac: 'FLAC (lossless)', pcm: 'PCM (uncompressed)' };
  const LOSSLESS_A = ['alac', 'flac', 'pcm'];
  const PRESETS = [
    { id: 'lossless', label: 'Lossless', q: 100, ab: 320 },
    { id: 'high', label: 'High', q: 82, ab: 256 },
    { id: 'balanced', label: 'Balanced', q: 62, ab: 192 },
    { id: 'small', label: 'Small file', q: 38, ab: 128 },
  ];
  const qualityName = (q) => (q >= 100 ? 'Lossless' : q >= 85 ? 'Very high' : q >= 70 ? 'High' : q >= 50 ? 'Good' : q >= 30 ? 'Low' : 'Very low');

  let X = Object.assign({
    format: 'mp4', vcodec: 'h264', acodec: 'aac', abitrate: 192, quality: 82, resolution: 0, fps: 0,
    speed: 'balanced', mute: false, copy: false, gifWidth: 480, gifFps: 15,
  }, store.get('qc.export', {}));
  let phase = 'settings';
  let exportResult = null;
  let exportError = null;
  let exportStarted = 0;

  const segments = () => S.clips.map((c) => ({ path: media.get(c.mediaId).path, in: c.in, out: c.out, volume: c.volume, muted: c.muted, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 }));
  const infos = () => { const o = {}; S.clips.forEach((c) => { const m = media.get(c.mediaId); o[m.path] = m.info; }); return o; };

  async function normalize() {
    const f = FORMATS[X.format];
    if (f.video.length && !f.video.includes(X.vcodec)) X.vcodec = f.video[0];
    if (f.audio.length && !f.audio.includes(X.acodec)) X.acodec = f.audio[0];
    X.copyAvailable = await qc.canSmartCut(segments(), infos(), { ...X, shape: S.shape, fit: S.fit, copy: true });
  }

  async function openExport() {
    if (!S.clips.length) return;
    pause();
    phase = 'settings';
    exportResult = null;
    exportError = null;
    await normalize();
    renderExport();
    const d = $('exportDlg');
    if (!d.open) d.showModal();
  }

  function renderExport() {
    const d = $('exportDlg');
    const first = media.get(S.clips[0].mediaId).info;
    const f = FORMATS[X.format];
    const isGif = X.format === 'gif';
    const hasV = f.video.length > 0;
    const hasA = f.audio.length > 0;
    const anyAudio = S.clips.some((c) => media.get(c.mediaId).info.hasAudio);

    if (phase === 'progress') {
      const done = phase === 'progress' ? (exportProgress * 100) : 0;
      d.innerHTML = `<div class="dlg-head"><h2 id="exportTitle">Exporting</h2></div>
        <div class="dlg-body"><div class="progress">
          <div class="progress-num" id="pNum">${Math.floor(done)}%</div>
          <div class="bar"><i id="pBar" style="transform:scaleX(${done / 100})"></i></div>
          <div class="progress-sub" id="pSub">Saving ${esc(exportTarget.split(/[\\/]/).pop())}</div>
        </div></div>
        <div class="dlg-foot"><span class="grow"></span><button class="btn" id="xCancel">Cancel export</button></div>`;
      $('xCancel').addEventListener('click', () => qc.cancelExport());
      return;
    }
    if (phase === 'done') {
      d.innerHTML = `<div class="dlg-head"><h2 id="exportTitle">Saved</h2><button class="icon-btn" id="xClose" aria-label="Close"><svg data-icon="x"></svg></button></div>
        <div class="dlg-body"><div class="done">
          <div class="done-icon"><svg data-icon="check"></svg></div>
          <div class="done-name">${esc(exportResult.path.split(/[\\/]/).pop())}</div>
          <div class="progress-sub">${fmtBytes(exportResult.size)} · ${fmtTC(total())} · ${esc(exportResult.path)}</div>
        </div></div>
        <div class="dlg-foot"><span class="grow"></span>
          <button class="btn" id="xReveal"><svg data-icon="folder"></svg><span>Show in folder</span></button>
          <button class="btn" id="xOpen"><svg data-icon="play"></svg><span>Play it</span></button>
          <button class="btn btn-primary" id="xDone">Done</button></div>`;
      paintIcons(d);
      $('xClose').addEventListener('click', () => d.close());
      $('xDone').addEventListener('click', () => d.close());
      $('xReveal').addEventListener('click', () => qc.reveal(exportResult.path));
      $('xOpen').addEventListener('click', () => qc.openFile(exportResult.path));
      return;
    }

    const srcShort = Math.min(first.width, first.height);
    const resOpts = [[0, first.hasVideo ? `Original (${first.width}×${first.height})` : 'Original'], [2160, '4K (2160p)'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p']]
      .filter(([v]) => !v || v !== srcShort);
    const fpsOpts = [[0, `Original (${Math.round(first.fps * 100) / 100 || 30})`], [60, '60'], [50, '50'], [30, '30'], [25, '25'], [24, '24'], [15, '15']];
    const losslessA = LOSSLESS_A.includes(X.acodec);
    const locked = X.copy && X.copyAvailable ? ' disabled-block' : '';
    const opt = (list, val) => list.map(([v, l]) => `<option value="${v}"${String(v) === String(val) ? ' selected' : ''}>${esc(l)}</option>`).join('');
    const qShown = X.vcodec === 'ffv1' ? 100 : X.quality;

    d.innerHTML = `<div class="dlg-head"><h2 id="exportTitle">Export</h2><button class="icon-btn" id="xClose" aria-label="Close"><svg data-icon="x"></svg></button></div>
      <div class="dlg-body">
        <div>
          <div class="group-label">Format</div>
          <div class="seg" id="xFmt">${Object.entries(FORMATS).map(([k, v]) => `<button type="button" data-v="${k}" aria-pressed="${k === X.format}">${v.label}</button>`).join('')}</div>
          <div class="fmt-note">${esc(f.note)}</div>
        </div>
        ${X.copyAvailable ? `<label class="check instant"><input type="checkbox" id="xCopy" ${X.copy ? 'checked' : ''}><span>Keep original video quality<small>Copies your footage untouched and only rebuilds the few frames around each cut. Exact cuts, much faster, same picture.</small></span></label>` : ''}
        <div class="quality${locked}">
          <div class="group-label">Quality <em>${hasV && !isGif ? esc(qualityName(qShown)) : ''}</em></div>
          <div class="seg" id="xPreset">${PRESETS.map((p) => `<button type="button" data-v="${p.id}" aria-pressed="${hasV && !isGif ? Math.round(X.quality) === p.q : X.abitrate === p.ab && !losslessA === (p.q !== 100)}">${p.label}</button>`).join('')}</div>
          ${hasV && !isGif ? `<div class="quality-row"><span>Smaller file</span><input type="range" id="xQ" min="0" max="100" value="${qShown}" style="--fill:${qShown}%" aria-label="Video quality" ${X.vcodec === 'ffv1' ? 'disabled' : ''}><span>Best quality</span></div>` : ''}
        </div>
        <div class="adv">
          ${hasV && !isGif ? `<label class="field${locked}"><span>Video codec</span><select id="xV">${opt(f.video.map((v) => [v, VCODEC[v]]), X.vcodec)}</select></label>` : ''}
          ${hasV ? `<label class="field${locked}"><span>Resolution</span><select id="xRes">${isGif ? opt([[320, '320 px wide'], [480, '480 px wide'], [640, '640 px wide'], [800, '800 px wide'], [1080, '1080 px wide']], X.gifWidth) : opt(resOpts, X.resolution)}</select></label>` : ''}
          ${hasV ? `<label class="field${locked}"><span>Frame rate</span><select id="xFps">${isGif ? opt([[10, '10'], [15, '15'], [20, '20'], [25, '25']], X.gifFps) : opt(fpsOpts, X.fps)}</select></label>` : ''}
          ${hasV && !isGif ? `<label class="field${locked}"><span>Encode speed</span><select id="xSpeed">${opt([['fast', 'Faster'], ['balanced', 'Balanced'], ['small', 'Smaller file (slower)']], X.speed)}</select></label>` : ''}
          ${hasA ? `<label class="field"><span>Audio</span><select id="xA" ${X.mute && hasV ? 'disabled' : ''}>${opt(f.audio.map((a) => [a, ACODEC[a]]), X.acodec)}</select></label>` : ''}
          ${hasA ? `<label class="field"><span>Audio quality</span><select id="xAb" ${losslessA || (X.mute && hasV) ? 'disabled' : ''}>${losslessA ? '<option>Lossless</option>' : opt([[320, '320 kbps'], [256, '256 kbps'], [192, '192 kbps'], [128, '128 kbps'], [96, '96 kbps'], [64, '64 kbps']], X.abitrate)}</select></label>` : ''}
        </div>
        ${hasV && hasA && anyAudio ? `<label class="check"><input type="checkbox" id="xMute" ${X.mute ? 'checked' : ''}><span>Remove all audio</span></label>` : ''}
        ${!anyAudio && !hasV ? `<div class="err-box" style="font-family:inherit">None of your clips have sound, so there’s nothing to save as audio.</div>` : ''}
        ${exportError ? `<div class="err-box">${esc(exportError)}</div>` : ''}
      </div>
      <div class="dlg-foot"><span class="grow" id="xEst">Estimating…</span>
        <button class="btn" id="xCancel">Cancel</button>
        <button class="btn btn-primary" id="xSave" ${!anyAudio && !hasV ? 'disabled' : ''}><svg data-icon="export"></svg><span>Save…</span></button></div>`;
    paintIcons(d);

    const set = async (patch) => { Object.assign(X, patch); await normalize(); store.set('qc.export', X); renderExport(); };
    $('xClose').addEventListener('click', () => d.close());
    $('xCancel').addEventListener('click', () => d.close());
    d.querySelectorAll('#xFmt button').forEach((b) => b.addEventListener('click', () => set({ format: b.dataset.v })));
    d.querySelectorAll('#xPreset button').forEach((b) => b.addEventListener('click', () => {
      const p = PRESETS.find((x) => x.id === b.dataset.v);
      const patch = { quality: p.q, abitrate: p.ab };
      if (p.q === 100) {
        const la = f.audio.find((a) => LOSSLESS_A.includes(a));
        if (la) patch.acodec = la;
        patch.speed = 'fast';
      } else {
        if (LOSSLESS_A.includes(X.acodec)) patch.acodec = f.audio.find((a) => !LOSSLESS_A.includes(a)) || X.acodec;
        if (X.vcodec === 'ffv1') patch.vcodec = f.video[0];
      }
      set(patch);
    }));
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on('xQ', 'input', (e) => { X.quality = Number(e.target.value); e.target.style.setProperty('--fill', `${X.quality}%`); d.querySelector('.quality .group-label em').textContent = qualityName(X.quality); estimate(); });
    on('xQ', 'change', () => set({}));
    on('xV', 'change', (e) => set({ vcodec: e.target.value }));
    on('xRes', 'change', (e) => set(isGif ? { gifWidth: Number(e.target.value) } : { resolution: Number(e.target.value) }));
    on('xFps', 'change', (e) => set(isGif ? { gifFps: Number(e.target.value) } : { fps: Number(e.target.value) }));
    on('xSpeed', 'change', (e) => set({ speed: e.target.value }));
    on('xA', 'change', (e) => set({ acodec: e.target.value }));
    on('xAb', 'change', (e) => set({ abitrate: Number(e.target.value) }));
    on('xMute', 'change', (e) => set({ mute: e.target.checked }));
    on('xCopy', 'change', (e) => set({ copy: e.target.checked }));
    $('xSave').addEventListener('click', startExport);
    if (!d.contains(document.activeElement) || document.activeElement === d) $('xSave').focus();
    estimate();
  }

  let estTimer = null;
  function estimate() {
    clearTimeout(estTimer);
    estTimer = setTimeout(async () => {
      const el = $('xEst');
      if (!el) return;
      const f = FORMATS[X.format];
      const first = media.get(S.clips[0].mediaId).info;
      let dims = '';
      if (f.video.length && first.hasVideo) {
        let w = first.width; let h = first.height;
        const target = X.format === 'gif' ? 0 : X.resolution;
        const A = ASPECTS[S.shape];
        if (A) { if (A > w / h) h = w / A; else w = h * A; }
        if (target && !X.copy) { const s = target / Math.min(w, h); w *= s; h *= s; }
        if (X.format === 'gif') { const s = Math.min(1, X.gifWidth / Math.max(w, h)); w *= s; h *= s; }
        dims = ` · ${Math.round(w / 2) * 2}×${Math.round(h / 2) * 2}`;
      }
      try {
        const bytes = await qc.estimate(segments(), infos(), { ...X, shape: S.shape, fit: S.fit, copy: X.copy && X.copyAvailable });
        el.innerHTML = `<b>≈ ${fmtBytes(bytes)}</b>${fmtTC(total())}${dims}`;
      } catch { el.textContent = `${fmtTC(total())}${dims}`; }
    }, 60);
  }

  let exportProgress = 0;
  let exportTarget = '';
  async function startExport() {
    const ext = X.format;
    const name = ($('editName').value || 'Untitled edit').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Untitled edit';
    const out = await qc.savePath(name, ext);
    if (!out) return;
    const segs = segments();
    if (segs.some((s) => s.path.toLowerCase() === out.toLowerCase())) { exportError = 'Pick a different file name: that would overwrite one of your clips.'; renderExport(); return; }
    exportTarget = out;
    exportProgress = 0;
    exportError = null;
    exportStarted = Date.now();
    phase = 'progress';
    renderExport();
    const off = qc.onExportProgress((p) => {
      exportProgress = p;
      const n = $('pNum'); const b = $('pBar'); const sub = $('pSub');
      if (n) n.textContent = `${Math.floor(p * 100)}%`;
      if (b) b.style.transform = `scaleX(${p})`;
      if (sub) sub.textContent = `Saving ${exportTarget.split(/[\\/]/).pop()} · ${fmtTC(p * total())} of ${fmtTC(total())}`;
    });
    try {
      exportResult = await qc.exportVideo(segs, infos(), { ...X, shape: S.shape, fit: S.fit, copy: X.copy && X.copyAvailable }, out);
      phase = 'done';
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error invoking remote method 'export': (Error: )?/, '');
      phase = 'settings';
      if (/cancel/i.test(msg)) { exportError = null; toast('Export cancelled.'); }
      else exportError = `Export failed. Try a different format or codec.\n\n${msg}`;
    } finally {
      off();
    }
    renderExport();
  }

  $('exportDlg').addEventListener('cancel', (e) => { if (phase === 'progress') e.preventDefault(); });

  /* ---------- updates ---------- */

  qc.onUpdate((u) => {
    const pill = $('updatePill');
    if (u.state === 'downloading') { pill.hidden = false; pill.innerHTML = `<svg data-icon="update"></svg>Updating ${Math.round((u.percent || 0) * 100)}%`; }
    else if (u.state === 'ready') { pill.hidden = false; pill.innerHTML = `<svg data-icon="update"></svg>Update ready <button id="restartBtn">Restart</button>`; }
    else pill.hidden = true;
    paintIcons(pill);
    const r = document.getElementById('restartBtn');
    if (r) r.addEventListener('click', () => qc.installUpdate());
  });

  /* ---------- boot ---------- */

  qc.autosaveRead().then((json) => {
    if (!json || S.clips.length) return;
    try {
      const o = JSON.parse(json);
      if (!o.clips || !o.clips.length) return;
      const b = $('restoreBtn');
      b.hidden = false;
      b.querySelector('span').textContent = `Restore last edit (${o.clips.length} clip${o.clips.length > 1 ? 's' : ''})`;
      b.addEventListener('click', () => { b.hidden = true; loadProjectJSON(json, null); });
    } catch {}
  });
  window.addEventListener('beforeunload', () => { if (S.clips.length) qc.autosaveWrite(serialize()); });

  qc.onOpenPaths((paths) => importPaths(paths));

  window.__qcImport = importPaths;
  window.__qcOpenJSON = loadProjectJSON;
  window.__qcSerialize = serialize;
  window.__qcState = S;
  render();
})();
