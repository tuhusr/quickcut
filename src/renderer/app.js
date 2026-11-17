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

  // The edit runs at the first video clip's frame rate. The playhead, cuts and timecode all live
  // on that frame grid, so what you see is exactly the frame that gets cut and exported.
  let FPS = 30;
  const frameDur = () => 1 / FPS;
  const snapFrame = (t) => Math.round(t * FPS) / FPS;
  const floorFrame = (t) => Math.floor(t * FPS + 1e-6) / FPS;
  const srcFps = (m) => (m && m.info && m.info.fps) || FPS;
  const snapSrc = (t, m) => { const f = srcFps(m); return Math.round(t * f) / f; };
  const wholeFrames = (d, m) => { const f = srcFps(m); return Math.floor(d * f + 1e-3) / f; };

  // MM:SS:FF (H:MM:SS:FF past an hour); FF counts frames inside the second.
  function fmtTC(t, withFrames = true) {
    t = Math.max(0, t || 0) + 1e-7;
    const whole = Math.floor(t);
    const ff = Math.min(Math.ceil(FPS) - 1, Math.floor((t - whole) * FPS + 1e-6));
    const s = whole % 60;
    const m = Math.floor(whole / 60) % 60;
    const h = Math.floor(whole / 3600);
    const p = (n) => String(n).padStart(2, '0');
    return (h ? `${h}:${p(m)}` : p(m)) + `:${p(s)}` + (withFrames ? `:${p(ff)}` : '');
  }
  function fmtShort(t) {
    t = Math.max(0, t || 0);
    if (t < 60) return `${t.toFixed(1)}s`;
    const m = Math.floor(t / 60);
    const s = Math.round(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  // Reads MM:SS:FF (frames last), or plain seconds such as 83.5 or 1:23.5.
  function parseTC(str) {
    str = String(str).trim();
    if (!str) return NaN;
    if (!/^[\d:.]+$/.test(str)) return NaN;
    const parts = str.split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return NaN;
    if (!str.includes('.') && parts.length >= 3) {
      const ff = parts.pop();
      if (ff >= Math.ceil(FPS)) return NaN;
      return parts.reduce((acc, n) => acc * 60 + n, 0) + ff / FPS;
    }
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
    clips: [],            // video track, back to back: { id, mediaId, in, out, volume, muted, fadeIn, fadeOut }
    audio: [],            // audio track, placed freely: { id, mediaId, start, in, out, volume, muted, fadeIn, fadeOut }
    selected: null,
    playhead: 0,
    playing: false,
    zoom: 60,             // px per second
    shape: 'orig',
    fit: 'fit',
  };
  let projectFile = null;
  let dirty = false;
  let past = [];
  let future = [];

  const snapshot = () => JSON.stringify({ clips: S.clips, audio: S.audio, selected: S.selected });
  function commit() {
    past.push(snapshot());
    if (past.length > 200) past.shift();
    future = [];
    markDirty();
  }
  function markDirty() {
    dirty = true;
    clearTimeout(markDirty.t);
    markDirty.t = setTimeout(() => { if (hasContent()) qc.autosaveWrite(serialize()); }, 800);
  }
  function restore(snap) {
    const o = JSON.parse(snap);
    S.clips = o.clips;
    S.audio = o.audio || [];
    S.selected = o.selected;
    render();
    seekTo(S.playhead);
  }
  function undo() { if (!past.length) return; future.push(snapshot()); restore(past.pop()); markDirty(); }
  function redo() { if (!future.length) return; past.push(snapshot()); restore(future.pop()); markDirty(); }

  const len = (c) => c.out - c.in;
  const vTotal = () => S.clips.reduce((t, c) => t + len(c), 0);              // end of the video track
  const audioEnd = () => S.audio.reduce((t, c) => Math.max(t, c.start + len(c)), 0);
  const total = () => Math.max(vTotal(), audioEnd());                       // length of the whole edit
  const hasContent = () => S.clips.length > 0 || S.audio.length > 0;
  const starts = () => { let t = 0; return S.clips.map((c) => { const s = t; t += len(c); return s; }); };
  const isAudioClip = (c) => S.audio.includes(c);
  const clipById = (id) => S.clips.find((c) => c.id === id) || S.audio.find((c) => c.id === id);
  const selectedClip = () => clipById(S.selected);

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

  async function importPaths(paths, audioAt = null) {
    if (!paths || !paths.length) return;
    const proj = paths.find((p) => /\.qcut$/i.test(p));
    if (proj) { openProject(proj); return; }
    toast(paths.length === 1 ? 'Adding clip…' : `Adding ${paths.length} clips…`, { ms: 60000 });
    const jobs = paths.map((p) => loadMedia(p));
    const added = (await Promise.all(jobs)).filter(Boolean);
    if (!added.length) return;
    commit();
    const wasEmpty = !hasContent();
    let at = audioAt ?? audioEnd();
    added.forEach((m) => {
      const base = { id: uid(), mediaId: m.id, in: 0, out: wholeFrames(m.info.duration, m), volume: 1, muted: false, fadeIn: 0, fadeOut: 0 };
      // Video files go on the video track (their own sound stays with them); sound-only files go on the audio track.
      if (m.info.hasVideo) S.clips.push(base);
      else { S.audio.push({ ...base, start: snapFrame(at) }); at = snapFrame(at) + len(base); }
    });
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
      try {
        m.info = await qc.probe(p);
      } catch (e) {
        m.status = 'error';
        m.error = (await qc.exists(p)) ? 'Can’t read this file' : 'File missing';
        if (!quiet) toast(`${m.name}: this file isn’t a video or audio file Quickcut can read.`, { error: true });
        return null;
      }
      m.status = 'ready';
      const i = m.info;
      const needsProxy = (i.hasVideo && !PLAYABLE_V.includes(i.vcodec)) || (!i.hasVideo && i.hasAudio && !PLAYABLE_A.includes(i.acodec)) ||
        (i.hasVideo && i.hasAudio && !PLAYABLE_A.includes(i.acodec));
      if (needsProxy) makeProxy(m);
      if (i.hasVideo) {
        m.exact = new Map();
        qc.thumbs(p, i.duration).then((t) => {
          m.thumbs = t.urls;
          m.thumbRate = t.rate;
          m.addedAt = Date.now();
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
      audio: S.audio.map(({ id, mediaId, start, in: i, out, volume, muted, fadeIn, fadeOut }) => ({ id, mediaId, start, in: i, out, volume, muted, fadeIn, fadeOut })),
    }, null, 1);
  }

  async function saveProject(saveAs = false) {
    if (!hasContent()) return;
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
    resetWorkspace(o.name, o.shape, o.fit);
    const loaded = await Promise.all((o.media || []).map((m) => loadMedia(m.path, m.id, true)));
    const ok = new Set(loaded.filter(Boolean).map((m) => m.id));
    const norm = (c) => ({ fadeIn: 0, fadeOut: 0, volume: 1, muted: false, ...c });
    S.clips = (o.clips || []).filter((c) => ok.has(c.mediaId)).map(norm);
    S.audio = (o.audio || []).filter((c) => ok.has(c.mediaId)).map((c) => ({ start: 0, ...norm(c) }));
    const missing = (o.media || []).length - ok.size;
    projectFile = file || null;
    dirty = false;
    fitZoom();
    render();
    seekTo(0);
    toast(missing ? `Opened. ${missing} file${missing > 1 ? 's are' : ' is'} missing, so ${missing > 1 ? 'their' : 'its'} clips were left out.` : `Opened ${o.name || 'project'}`, { error: !!missing, ms: 6000 });
  }

  // Empties the editor. Media files on disk are never touched.
  function resetWorkspace(name = 'Untitled edit', shape = 'orig', fit = 'fit') {
    pause();
    media.clear();
    clipEls.forEach((el) => el.remove());
    clipEls.clear();
    audioEls.forEach((el) => { el.pause(); el.removeAttribute('src'); });
    audioEls.clear();
    loadedPath = null;
    video.removeAttribute('src');
    video.load();
    past = []; future = [];
    S.clips = []; S.audio = []; S.selected = null; S.playhead = 0;
    $('editName').value = name;
    S.shape = shape;
    S.fit = fit;
    projectFile = null;
    dirty = false;
    render();
  }

  function newEdit() {
    if (!hasContent()) return;
    if (dirty && !confirm('Start a new edit? Changes to this one that you haven’t saved as a project will be lost. Your video files are not affected.')) return;
    resetWorkspace();
    $('restoreBtn').hidden = true;
    toast('New edit');
  }

  async function openProject(file) {
    if (dirty && hasContent() && !confirm('Open another project? Unsaved changes to this edit will be lost.')) return;
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
      S.audio.forEach((c) => { if (c.mediaId === m.id) { const el = audioEls.get(c.id); if (el) { el.src = qc.mediaUrl(out); el.dataset.src = out; } } });
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

  /* ---------- playback ---------- */

  let loadedPath = null;
  let currentMediaId = null;
  let currentIdx = -1;
  let pendingSeek = null;
  let wantPlay = false;
  let queuedSeek = null;

  // Aim a fifth of a frame inside the wanted frame: the decoder can't round to its neighbour.
  const frameTarget = (local, m) => local + 0.2 / srcFps(m);
  // While a seek is in flight only the newest target is kept, so fast scrubbing never lags behind.
  function setVideoTime(t) {
    if (video.seeking) { queuedSeek = t; return; }
    video.currentTime = t;
  }
  video.addEventListener('seeked', () => {
    if (queuedSeek === null) return;
    const q = queuedSeek;
    queuedSeek = null;
    if (Math.abs(video.currentTime - q) > 1e-4) video.currentTime = q;
  });

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
    const target = play ? local : frameTarget(local, m);
    if (loadedPath !== m.playPath) {
      loadedPath = m.playPath;
      pendingSeek = target;
      queuedSeek = null;
      wantPlay = play;
      video.src = qc.mediaUrl(m.playPath);
    } else {
      if (Math.abs(video.currentTime - target) > 0.001) setVideoTime(target);
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

  let clockBase = null; // set while the playhead is past the end of the video track
  const inVideo = () => S.clips.length && S.playhead < vTotal() - 1e-6;

  function seekTo(t) {
    S.playhead = clamp(snapFrame(t), 0, total());
    if (inVideo()) {
      clockBase = null;
      const loc = locate(S.playhead);
      loadAt(loc.i, loc.local, S.playing);
    } else {
      if (!video.paused) video.pause();
      if (S.playing) clockBase = performance.now() - S.playhead * 1000;
      const loc = locate(S.playhead); // park the last frame (shown black past the end)
      if (loc) loadAt(loc.i, loc.local, false);
    }
    syncAudio(true);
    renderPlayhead();
  }

  function play() {
    if (!hasContent()) return;
    if (S.playhead >= total() - 0.02) S.playhead = 0;
    S.playing = true;
    if (inVideo()) {
      clockBase = null;
      const loc = locate(S.playhead);
      loadAt(loc.i, loc.local, true);
    } else clockBase = performance.now() - S.playhead * 1000;
    syncAudio(true);
    renderPlayState();
    requestAnimationFrame(tick);
  }
  function pause() {
    const was = S.playing;
    S.playing = false;
    video.pause();
    clockBase = null;
    // Stop on a whole frame, showing exactly that frame.
    if (was) { S.playhead = floorFrame(S.playhead); const loc = inVideo() && locate(S.playhead); if (loc) loadAt(loc.i, loc.local, false); }
    syncAudio(true);
    renderPlayState();
  }
  const togglePlay = () => (S.playing ? pause() : play());

  function tick() {
    if (!S.playing) return;
    if (clockBase !== null) {
      S.playhead = (performance.now() - clockBase) / 1000;
      if (S.playhead >= total()) { S.playhead = total(); pause(); }
      syncAudio();
      renderPlayhead();
      followPlayhead();
      requestAnimationFrame(tick);
      return;
    }
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
        } else if (audioEnd() > vTotal()) {
          // The video track is done but music carries on: keep time with the clock.
          S.playhead = vTotal();
          video.pause();
          clockBase = performance.now() - S.playhead * 1000;
        } else {
          S.playhead = total();
          pause();
        }
      } else if (vt >= c.in - 0.05) {
        S.playhead = st[currentIdx] + (vt - c.in);
      }
    }
    syncAudio();
    renderPlayhead();
    followPlayhead();
    requestAnimationFrame(tick);
  }

  // One <audio> per audio-track clip, started, stopped and nudged to follow the playhead.
  const audioEls = new Map();
  function syncAudio(hard = false) {
    S.audio.forEach((c) => {
      const m = media.get(c.mediaId);
      let el = audioEls.get(c.id);
      if (!el) {
        el = new Audio();
        el.preload = 'auto';
        audioEls.set(c.id, el);
      }
      if (el.dataset.src !== m.playPath) { el.src = qc.mediaUrl(m.playPath); el.dataset.src = m.playPath; }
      const local = c.in + (S.playhead - c.start);
      const on = S.playing && S.playhead >= c.start - 0.01 && local < c.out - 0.01;
      if (!on) { if (!el.paused) el.pause(); return; }
      el.muted = c.muted;
      el.volume = clamp(c.volume * fadeLevel(c, local), 0, 1);
      if (hard || el.paused || Math.abs(el.currentTime - local) > 0.25) el.currentTime = local;
      if (el.paused) el.play().catch(() => {});
    });
    audioEls.forEach((el, id) => { if (!S.audio.some((c) => c.id === id)) { el.pause(); audioEls.delete(id); } });
  }

  function step(dir, big = false) {
    if (S.playing) pause();
    seekTo(snapFrame(S.playhead) + dir * (big ? 1 : frameDur()));
    followPlayhead();
  }

  /* ---------- edits ---------- */

  // The audio clip under the playhead, preferring the selected one.
  function audioAtPlayhead() {
    const hit = (c) => S.playhead > c.start + MIN_LEN && S.playhead < c.start + len(c) - MIN_LEN;
    const sel = S.audio.find((c) => c.id === S.selected);
    return sel && hit(sel) ? sel : null;
  }

  function split() {
    const ac = audioAtPlayhead();
    if (ac) {
      commit();
      const cutAt = ac.in + (S.playhead - ac.start);
      const b = { ...ac, id: uid(), in: cutAt, start: S.playhead };
      ac.out = cutAt;
      S.audio.splice(S.audio.indexOf(ac) + 1, 0, b);
      S.selected = b.id;
      render();
      return;
    }
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
    const ai = S.audio.findIndex((c) => c.id === S.selected);
    if (ai >= 0) {
      commit();
      S.audio.splice(ai, 1);
      S.selected = null;
      render();
      seekTo(Math.min(S.playhead, total()));
      return;
    }
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
    const sel = selectedClip();
    if (sel && isAudioClip(sel)) {
      const local = sel.in + (S.playhead - sel.start);
      if (local <= sel.in - 1e-6 || local >= sel.out + 1e-6) { toast('Put the playhead over the selected clip first.'); return; }
      commit();
      if (which === 'in' && sel.out - local >= MIN_LEN) { sel.start = S.playhead; sel.in = local; }
      if (which === 'out' && local - sel.in >= MIN_LEN) sel.out = local;
      render();
      return;
    }
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
    FPS = S.clips[0] ? srcFps(media.get(S.clips[0].mediaId)) : 30;
    app.dataset.empty = hasContent() || media.size ? 'false' : 'true';
    $('trackEmpty').hidden = S.clips.length > 0;
    $('atrackEmpty').hidden = S.audio.length > 0;
    renderTimeline();
    renderClipBar();
    renderPlayhead();
    renderPlayState();
    $('undoBtn').disabled = !past.length;
    $('redoBtn').disabled = !future.length;
    $('exportBtn').disabled = !hasContent();
    $('saveProjBtn').disabled = !hasContent();
    $('newBtn').disabled = !hasContent();
    renderShape();
  }

  function renderPlayState() {
    const b = $('playBtn');
    const svg = b.querySelector('svg');
    svg.setAttribute('data-icon', S.playing ? 'pause' : 'play');
    paintIcons(b);
    b.setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
    b.dataset.tip = S.playing ? 'Pause (Space)' : 'Play (Space)';
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
      el.querySelector('.nm').textContent = m.name.replace(/\.[^.]+$/, '');
      el.querySelector('.du').textContent = fmtShort(len(c));
      let mute = el.querySelector('.clip-muted');
      if (c.muted && !mute) { el.insertAdjacentHTML('beforeend', '<span class="clip-muted" title="Muted"><svg data-icon="volumeOff"></svg></span>'); paintIcons(el); }
      if (!c.muted && mute) mute.remove();
      drawFrames(el, c, m, w, forceFrames);
      el.classList.toggle('audio-only', !m.info.hasVideo);
      const wave = el.querySelector('.clip-wave');
      if (m.wave) {
        wave.style.maskImage = `url('${m.wave}')`;
        wave.style.maskSize = `${m.info.duration * S.zoom}px 100%`;
        wave.style.maskPosition = `${-(c.in * S.zoom + (c._dx || 0))}px 0`;
      }
      el.querySelector('.clip-fade.in').style.width = `${Math.min(w, (c.fadeIn || 0) * S.zoom)}px`;
      el.querySelector('.clip-fade.out').style.width = `${Math.min(w, (c.fadeOut || 0) * S.zoom)}px`;
    });
    S.audio.forEach((c) => {
      seen.add(c.id);
      let el = clipEls.get(c.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'clip aclip';
        el.dataset.id = c.id;
        el.innerHTML = '<div class="clip-wave"></div><div class="clip-fade in"></div><div class="clip-fade out"></div><div class="clip-label"><span class="nm"></span><span class="du"></span></div><div class="handle l" data-h="l" aria-hidden="true"></div><div class="handle r" data-h="r" aria-hidden="true"></div>';
        $('atrack').appendChild(el);
        clipEls.set(c.id, el);
      }
      const m = media.get(c.mediaId);
      const w = Math.max(4, len(c) * S.zoom);
      el.style.left = `${PAD + c.start * S.zoom}px`;
      el.style.width = `${w}px`;
      el.classList.toggle('selected', c.id === S.selected);
      el.classList.toggle('narrow', w < 110);
      el.querySelector('.nm').textContent = m.name.replace(/\.[^.]+$/, '');
      el.querySelector('.du').textContent = fmtShort(len(c));
      let mute = el.querySelector('.clip-muted');
      if (c.muted && !mute) { el.insertAdjacentHTML('beforeend', '<span class="clip-muted" title="Muted"><svg data-icon="volumeOff"></svg></span>'); paintIcons(el); }
      if (!c.muted && mute) mute.remove();
      const wave = el.querySelector('.clip-wave');
      if (m.wave) {
        wave.style.maskImage = `url('${m.wave}')`;
        wave.style.maskSize = `${m.info.duration * S.zoom}px 100%`;
        wave.style.maskPosition = `${-(c.in * S.zoom)}px 0`;
      }
      el.querySelector('.clip-fade.in').style.width = `${Math.min(w, (c.fadeIn || 0) * S.zoom)}px`;
      el.querySelector('.clip-fade.out').style.width = `${Math.min(w, (c.fadeOut || 0) * S.zoom)}px`;
    });
    clipEls.forEach((el, id) => { if (!seen.has(id)) { el.remove(); clipEls.delete(id); } });
    renderRuler();
    const meta = document.getElementById('cbMeta');
    if (meta) meta.textContent = summary();
  }

  function summary() {
    const n = S.clips.length + S.audio.length;
    return `${n} clip${n === 1 ? '' : 's'} · ${fmtTC(total())}`;
  }

  // Pictures inside a video clip. Zoomed out: an evenly spaced strip, each picture the nearest
  // sample to the moment at its left edge. Zoomed in past ~18 px a frame: one picture per frame,
  // fetched exactly. Only what's on screen is drawn.
  function drawFrames(el, c, m, w, force) {
    const box = el.querySelector('.clip-frames');
    if (!m.info.hasVideo) {
      if (box.dataset.key !== 'audio') { box.dataset.key = 'audio'; box.innerHTML = m.wave ? '' : '<div class="clip-audio"><svg data-icon="audio"></svg></div>'; paintIcons(box); }
      return;
    }
    if (!m.thumbs.length) { box.innerHTML = ''; box.dataset.key = ''; return; }
    const h = box.clientHeight || 80;
    const scroll = $('tlScroll');
    const x0 = parseFloat(el.style.left) || 0;
    const visL = Math.max(0, scroll.scrollLeft - x0 - 40);
    const visR = Math.min(w, scroll.scrollLeft + scroll.clientWidth - x0 + 40);
    const key = `${c.in.toFixed(4)}|${c.out.toFixed(4)}|${S.zoom}|${w}|${h}|${m.thumbs.length}|${m.exact.size}|${c._dx || 0}|${Math.round(visL / 50)}|${Math.round(visR / 50)}`;
    if (!force && box.dataset.key === key) return;
    box.dataset.key = key;
    if (visR <= visL) { box.innerHTML = ''; return; }
    const f = srcFps(m);
    const shownIn = c.in + (c._dx || 0) / S.zoom;
    const framePx = S.zoom / f;
    const base = (t) => m.thumbs[clamp(Math.round(t * m.thumbRate), 0, m.thumbs.length - 1)];
    const want = [];
    const pic = (t) => {
      const ex = m.exact.get(Math.round(t * 1000));
      if (ex) return ex;
      want.push(t);
      return base(t);
    };
    let html = '';
    if (framePx >= 18) {
      const n0 = Math.max(Math.ceil(shownIn * f - 1e-6), Math.floor((shownIn + visL / S.zoom) * f));
      const n1 = Math.min(Math.ceil(c.out * f - 1e-6) - 1, Math.ceil((shownIn + visR / S.zoom) * f));
      for (let n = n0; n <= n1; n++) {
        const t = n / f;
        const x = (t - shownIn) * S.zoom;
        html += `<img src="${pic(t)}" style="left:${x.toFixed(2)}px;width:${framePx.toFixed(2)}px" alt="" draggable="false">`;
      }
    } else {
      const aspect = m.info.width && m.info.height ? m.info.width / m.info.height : 16 / 9;
      const fw = Math.max(24, h * aspect);
      const needExact = fw / S.zoom < 1 / m.thumbRate;
      for (let k = Math.floor(visL / fw); k * fw < visR; k++) {
        const t = Math.floor((shownIn + (k * fw) / S.zoom) * f + 1e-6) / f;
        html += `<img src="${needExact ? pic(t) : base(t)}" style="left:${k * fw}px;width:${fw}px" alt="" draggable="false">`;
      }
    }
    box.innerHTML = html;
    if (want.length) requestFrames(m, want);
  }

  // Exact frames for the zoomed-in strip, fetched in the background a screenful at a time.
  function requestFrames(m, times) {
    m.wanted = m.wanted || new Set();
    times.forEach((t) => { if (!m.exact.has(Math.round(t * 1000))) m.wanted.add(t); });
    clearTimeout(m.frameTimer);
    m.frameTimer = setTimeout(async () => {
      const batch = [...m.wanted].slice(0, 48);
      m.wanted.clear();
      if (!batch.length) return;
      try {
        const got = await qc.frames(m.path, batch);
        Object.entries(got).forEach(([t, url]) => m.exact.set(Math.round(Number(t) * 1000), url));
        renderTimeline(true);
      } catch {}
    }, 120);
  }

  const SEC_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  function renderRuler() {
    const ruler = $('ruler');
    const scroll = $('tlScroll');
    const fpx = S.zoom / FPS; // pixels per frame
    // Major step: whole frames when zoomed right in, seconds otherwise.
    let major = null;
    let frameLabels = false;
    for (const n of [1, 2, 5, 10]) if (n * fpx >= 64 && n < FPS) { major = n / FPS; frameLabels = true; break; }
    if (!major) major = SEC_STEPS.find((s) => s * S.zoom >= 90) || 3600;
    let minor;
    if (frameLabels || (major === 1 && fpx >= 7)) minor = 1 / FPS;
    else minor = major / (major >= 60 ? 6 : major === 15 || major === 30 ? 3 : major === 2 ? 4 : 5);
    $('track').style.setProperty('--grid', `${major * S.zoom}px`);
    $('atrack').style.setProperty('--grid', `${major * S.zoom}px`);
    const from = Math.max(0, (scroll.scrollLeft - PAD) / S.zoom - major);
    const to = (scroll.scrollLeft + scroll.clientWidth) / S.zoom + major;
    let html = '';
    // Frame ticks sit on frame boundaries; second ticks on whole seconds.
    const unit = minor === 1 / FPS ? 1 / FPS : minor;
    for (let k = Math.floor(from / unit); k * unit <= to; k++) {
      const t = minor === 1 / FPS ? k / FPS : Math.round(k * unit * 1e6) / 1e6;
      const x = PAD + t * S.zoom;
      const isMajor = frameLabels ? k % Math.round(major * FPS) === 0 : Math.abs(t / major - Math.round(t / major)) < 1e-6 && Math.abs(t - Math.round(t)) < 1e-6;
      html += `<i class="tick${isMajor ? ' major' : ''}" style="left:${x.toFixed(2)}px"></i>`;
      if (isMajor) html += `<span class="lbl" style="left:${x.toFixed(2)}px">${fmtTC(t, frameLabels)}</span>`;
    }
    ruler.innerHTML = html;
    // Keep the empty-lane hints in view however far the timeline is zoomed or scrolled.
    ['trackEmpty', 'atrackEmpty'].forEach((id) => { const e = $(id); e.style.left = `${scroll.scrollLeft + PAD}px`; e.style.width = `${Math.max(0, scroll.clientWidth - PAD * 2)}px`; });
    renderOverview();
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
    if (S.clips.length && S.playhead >= vTotal() - 1e-6 && total() > vTotal()) { video.style.opacity = 0; return; }
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
    const ovPh = document.querySelector('#overview .ov-ph');
    if (ovPh) ovPh.style.left = `${(S.playhead / Math.max(total(), 0.001)) * $('overview').clientWidth}px`;
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

  const fadeOpts = (v) => [[0, 'Off'], [0.25, '¼ s'], [0.5, '½ s'], [1, '1 s'], [2, '2 s'], [3, '3 s']]
    .map(([n, l]) => `<option value="${n}"${Math.abs((v || 0) - n) < 0.001 ? ' selected' : ''}>${l}</option>`).join('');

  const info = (text) => `<span class="info" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(text)}"><svg data-icon="info"></svg></span>`;
  const zoomTools = () => `<div class="zoom">
      <button class="icon-btn sm" data-z="out" aria-label="Zoom out" data-tip="Zoom out (−)"><svg data-icon="zoomOut"></svg></button>
      <input type="range" id="zoomRange" min="0" max="1000" value="${zoomToRange(S.zoom)}" style="--fill:${zoomToRange(S.zoom) / 10}%" aria-label="Timeline zoom">
      <button class="icon-btn sm" data-z="in" aria-label="Zoom in" data-tip="Zoom in (+). Zoom all the way to see single frames."><svg data-icon="zoomIn"></svg></button>
      ${selectedClip() ? '<button class="btn btn-quiet btn-sm" data-z="sel" data-tip="Zoom to the selected clip (Z)">Clip</button>' : ''}
      <button class="btn btn-quiet btn-sm" data-z="fit" data-tip="Show the whole edit (\\)">Fit</button>
      ${info('Zoom with the slider, the mouse wheel over the ruler or the bar above it, or Ctrl + wheel anywhere. In the bar above the ruler, drag the bright window to move along the edit and pull its edges to zoom.')}
    </div>`;

  // One bar above the timeline: the selected clip's controls, or the edit's summary.
  function renderClipBar() {
    const box = $('clipBar');
    box.dataset.kind = selectedClip() && isAudioClip(selectedClip()) ? 'audio' : 'video';
    if (box.contains(document.activeElement) && document.activeElement.matches('input[type=text]')) return;
    const c = selectedClip();
    const splitBtn = `<button class="btn btn-quiet btn-sm" id="fSplit" data-tip="Cut the clip in two at the playhead (S)"><svg data-icon="scissors"></svg><span>Split</span></button>`;
    if (!c) {
      box.innerHTML = `<span class="cb-meta" id="cbMeta">${summary()}</span>
        <span class="cb-hint">Click a clip to trim or adjust it</span>
        <div class="cb-end">${splitBtn}${zoomTools()}</div>`;
    } else {
      const m = media.get(c.mediaId);
      const i = m.info;
      const vol = Math.round(c.volume * 100);
      box.innerHTML = `
        <div class="cb-name" title="${esc(m.path)}">${esc(m.name.replace(/\.[^.]+$/, ''))}</div>
        <div class="cb-group">
          <label class="cb-field"><span>Start</span><input type="text" id="fIn" value="${fmtTC(c.in)}" spellcheck="false" aria-label="Start time"></label>
          <label class="cb-field"><span>End</span><input type="text" id="fOut" value="${fmtTC(c.out)}" spellcheck="false" aria-label="End time"></label>
          ${info('Where this clip starts and ends inside its original file. Type a time, drag the clip’s edges, or press I / O to use the playhead.')}
        </div>
        <div class="cb-group">
          <button class="icon-btn sm" id="fMute" aria-pressed="${c.muted}" aria-label="${c.muted ? 'Unmute' : 'Mute'}" data-tip="${!i.hasAudio ? 'This clip has no sound' : c.muted ? 'Unmute' : 'Mute'}" ${i.hasAudio ? '' : 'disabled'}><svg data-icon="${c.muted || !i.hasAudio ? 'volumeOff' : 'volume'}"></svg></button>
          <input type="range" id="fVol" min="0" max="200" step="1" value="${vol}" style="--fill:${vol / 2}%" aria-label="Volume" ${i.hasAudio && !c.muted ? '' : 'disabled'}>
          <output id="fVolOut">${i.hasAudio ? `${vol}%` : '—'}</output>
        </div>
        <div class="cb-group">
          <label class="cb-field"><span>Fade in</span><select id="fFadeIn">${fadeOpts(c.fadeIn)}</select></label>
          <label class="cb-field"><span>out</span><select id="fFadeOut">${fadeOpts(c.fadeOut)}</select></label>
          ${info('Fades the picture and sound in from black at the start, or out to black at the end.')}
        </div>
        <div class="cb-end">
          ${splitBtn}
          <button class="btn btn-quiet btn-sm" id="fRemove" data-tip="Take this clip out of the edit (Delete)"><svg data-icon="trash"></svg><span>Remove</span></button>
          ${zoomTools()}
        </div>`;
    }
    paintIcons(box);
    $('fSplit').addEventListener('click', split);
    if (!c) return;
    const i = media.get(c.mediaId).info;

    const bindTC = (id, which) => {
      const inp = $(id);
      const apply = () => {
        const v = parseTC(inp.value);
        const ok = !Number.isNaN(v) && (which === 'in' ? v >= 0 && v <= c.out - MIN_LEN : v >= c.in + MIN_LEN && v <= i.duration + 0.001);
        if (!ok) { inp.classList.add('invalid'); toast(which === 'in' ? `Start must be between 00:00.00 and ${fmtTC(c.out - MIN_LEN)}.` : `End must be between ${fmtTC(c.in + MIN_LEN)} and ${fmtTC(i.duration)}.`, { error: true }); return; }
        commit();
        c[which] = Math.min(isAudioClip(c) ? snapFrame(v) : snapSrc(v, media.get(c.mediaId)), i.duration);
        inp.blur();
        render();
        seekTo(isAudioClip(c) ? c.start : starts()[S.clips.indexOf(c)]);
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } if (e.key === 'Escape') { inp.value = fmtTC(c[which]); inp.blur(); } });
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
    $('fRemove').addEventListener('click', removeSelected);
  }

  $('clipBar').addEventListener('click', (e) => {
    const z = e.target.closest('[data-z]');
    if (!z) return;
    if (z.dataset.z === 'in') setZoom(S.zoom * 1.6);
    else if (z.dataset.z === 'out') setZoom(S.zoom / 1.6);
    else if (z.dataset.z === 'sel') zoomToSelection();
    else fitZoom();
  });
  $('clipBar').addEventListener('input', (e) => { if (e.target.id === 'zoomRange') setZoom(rangeToZoom(Number(e.target.value))); });

  /* ---------- zoom ---------- */

  // Zoom runs from the whole edit on screen down to about 160 px per frame.
  const zMin = () => Math.min(2, (($('tlScroll').clientWidth || 800) - PAD * 2) / Math.max(total(), 1));
  const zMax = () => FPS * 160;
  const zoomToRange = (z) => (Math.log(z / zMin()) / Math.log(zMax() / zMin())) * 1000;
  const rangeToZoom = (v) => zMin() * Math.pow(zMax() / zMin(), v / 1000);
  function setZoom(z, anchorX) {
    const scroll = $('tlScroll');
    const ax = anchorX ?? PAD + S.playhead * S.zoom - scroll.scrollLeft;
    const tAt = (scroll.scrollLeft + ax - PAD) / S.zoom;
    S.zoom = clamp(z, zMin(), zMax());
    renderTimeline();
    scroll.scrollLeft = PAD + tAt * S.zoom - ax;
    renderRuler();
    renderPlayhead();
    syncZoomUI();
  }
  // Show exactly the time range [a, b].
  function zoomToRange2(a, b) {
    const scroll = $('tlScroll');
    S.zoom = clamp((scroll.clientWidth - PAD * 2) / Math.max(b - a, 1 / FPS), zMin(), zMax());
    renderTimeline();
    scroll.scrollLeft = PAD + a * S.zoom - PAD;
    renderRuler();
    renderPlayhead();
    syncZoomUI();
  }
  function fitZoom() {
    zoomToRange2(0, total() || 30);
    $('tlScroll').scrollLeft = 0;
    renderRuler();
  }
  function zoomToSelection() {
    const c = selectedClip();
    if (!c) return;
    const s = isAudioClip(c) ? c.start : starts()[S.clips.indexOf(c)];
    const pad = len(c) * 0.04;
    zoomToRange2(Math.max(0, s - pad), s + len(c) + pad);
  }
  function syncZoomUI() {
    const r = document.getElementById('zoomRange');
    if (r) { r.value = zoomToRange(S.zoom); r.style.setProperty('--fill', `${r.value / 10}%`); }
    renderOverview();
  }

  // Overview bar (like Audition's): the whole edit in miniature with a window for what's on
  // screen. Drag the window to move, pull its edges to zoom, click anywhere to jump there.
  function renderOverview() {
    const ov = $('overview');
    const W = ov.clientWidth;
    const T = Math.max(total(), 0.001);
    const scroll = $('tlScroll');
    const k = W / T;
    const a0 = clamp((scroll.scrollLeft - PAD) / S.zoom, 0, T);
    const a1 = clamp((scroll.scrollLeft + scroll.clientWidth - PAD) / S.zoom, 0, T);
    const st = starts();
    let html = '';
    S.clips.forEach((c, i) => { html += `<i class="ov-v${c.id === S.selected ? ' sel' : ''}" style="left:${st[i] * k}px;width:${Math.max(1, len(c) * k - 1)}px"></i>`; });
    S.audio.forEach((c) => { html += `<i class="ov-a${c.id === S.selected ? ' sel' : ''}" style="left:${c.start * k}px;width:${Math.max(1, len(c) * k - 1)}px"></i>`; });
    html += `<b class="ov-ph" style="left:${S.playhead * k}px"></b>`;
    html += `<div class="ov-win" style="left:${a0 * k}px;width:${Math.max(6, (a1 - a0) * k)}px"><span class="ov-h l"></span><span class="ov-h r"></span></div>`;
    ov.innerHTML = html;
  }
  $('overview').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !hasContent()) return;
    e.preventDefault();
    const ov = $('overview');
    const scroll = $('tlScroll');
    const rect = ov.getBoundingClientRect();
    const T = Math.max(total(), 0.001);
    const tAtX = (x) => clamp(((x - rect.left) / rect.width) * T, 0, T);
    const span = () => (scroll.clientWidth - PAD * 2) / S.zoom;
    const a0 = (scroll.scrollLeft) / S.zoom;
    const a1 = a0 + span();
    const handle = e.target.classList.contains('ov-h') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
    const inWin = e.target.closest('.ov-win');
    const t0 = tAtX(e.clientX);
    const grab = t0 - a0;
    if (!handle && !inWin) scroll.scrollLeft = (t0 - span() / 2) * S.zoom; // jump there, then drag
    const move = (ev) => {
      const t = tAtX(ev.clientX);
      if (handle === 'l') zoomToRange2(Math.min(t, a1 - 1 / FPS), a1);
      else if (handle === 'r') zoomToRange2(a0, Math.max(t, a0 + 1 / FPS));
      else scroll.scrollLeft = (t - (inWin ? grab : span() / 2)) * S.zoom;
      renderRuler();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    renderRuler();
  });

  // Mouse wheel: over the ruler or overview it zooms around the pointer (as in Audition);
  // over the tracks it scrolls, and zooms with Ctrl or Alt held.
  const wheelZoom = (e, el) => {
    e.preventDefault();
    const rect = $('tlScroll').getBoundingClientRect();
    const ax = el === 'overview'
      ? PAD + ((e.clientX - $('overview').getBoundingClientRect().left) / $('overview').clientWidth) * total() * S.zoom - $('tlScroll').scrollLeft
      : e.clientX - rect.left;
    setZoom(S.zoom * Math.pow(1.0022, -e.deltaY), ax);
  };
  $('overview').addEventListener('wheel', (e) => wheelZoom(e, 'overview'), { passive: false });
  $('tlScroll').addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.altKey || e.target.closest('#ruler')) {
      wheelZoom(e, 'tracks');
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      $('tlScroll').scrollLeft += e.deltaY;
    }
  }, { passive: false });
  $('tlScroll').addEventListener('scroll', () => { renderRuler(); renderTimeline(); });
  window.addEventListener('resize', () => { renderTimeline(true); renderRuler(); });

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

  $('atrack').addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const clipEl = e.target.closest('.clip');
    if (!clipEl) { S.selected = null; render(); scrub(e); return; }
    e.preventDefault();
    const c = clipById(clipEl.dataset.id);
    startAudioDrag(e, c, e.target.dataset.h || 'move');
  });

  // Snap a time to the playhead, the start, and every clip edge on both tracks.
  function snapTime(t, ignore) {
    const targets = [0, S.playhead, ...starts(), vTotal()];
    S.audio.forEach((c) => { if (c !== ignore) targets.push(c.start, c.start + len(c)); });
    let best = t;
    let bestD = SNAP_PX / S.zoom;
    targets.forEach((x) => { const d = Math.abs(x - t); if (d < bestD) { bestD = d; best = x; } });
    return best;
  }

  // Audio clips sit anywhere in time: drag the body to move, the edges to trim.
  function startAudioDrag(e, c, mode) {
    if (S.playing) pause();
    const m = media.get(c.mediaId);
    const before = snapshot();
    const o = { start: c.start, in: c.in, out: c.out };
    const x0 = e.clientX;
    let moved = false;
    if (S.selected !== c.id) { S.selected = c.id; render(); }
    document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';
    const move = (ev) => {
      const dt = (ev.clientX - x0) / S.zoom;
      if (!moved && Math.abs(ev.clientX - x0) < 4) return;
      moved = true;
      if (mode === 'move') {
        let s = Math.max(0, o.start + dt);
        const sEnd = snapTime(s + len(c), c) - len(c);
        const sStart = snapTime(s, c);
        s = sStart !== s ? sStart : sEnd !== s ? Math.max(0, sEnd) : s;
        c.start = snapFrame(s);
        showTip(ev, `Starts at ${fmtTC(c.start)}`);
      } else if (mode === 'l') {
        // Trimming the front: the clip's end stays put, its start and in-point move together.
        let ni = clamp(o.in + dt, Math.max(0, o.in - o.start), o.out - MIN_LEN);
        const snapped = snapTime(o.start + (ni - o.in), c);
        ni = clamp(o.in + (snapped - o.start), Math.max(0, o.in - o.start), o.out - MIN_LEN);
        ni = o.in + (snapFrame(o.start + (ni - o.in)) - o.start);
        c.in = ni;
        c.start = o.start + (ni - o.in);
        showTip(ev, `Start ${fmtTC(ni)}`);
      } else {
        let no = clamp(o.out + dt, o.in + MIN_LEN, m.info.duration);
        const snapped = snapTime(o.start + (no - o.in), c);
        no = clamp(o.in + (snapFrame(snapped) - o.start), o.in + MIN_LEN, m.info.duration);
        c.out = no;
        showTip(ev, `End ${fmtTC(no)} · ${fmtShort(no - o.in)}`);
      }
      renderTimeline();
      autoScroll(ev);
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      tip.hidden = true;
      if (!moved) { seekTo(clamp((tlX(ev) - PAD) / S.zoom, 0, total())); return; }
      if (c.start !== o.start || c.in !== o.in || c.out !== o.out) { past.push(before); future = []; markDirty(); }
      render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

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
        const targets = [S.playhead];
        for (const t of targets) if (Math.abs(t - seqT) * S.zoom < SNAP_PX) return t;
        return seqT;
      };
      if (side === 'l') {
        let ni = clamp(o.in + dt, 0, o.out - MIN_LEN);
        ni = clamp(o.in + snapT(clipStart + (ni - o.in)) - clipStart, 0, o.out - MIN_LEN);
        if (Math.abs(ni) * S.zoom < SNAP_PX) ni = 0;
        ni = snapSrc(ni, m);
        c.in = ni;
        c._dx = (ni - o.in) * S.zoom; // left edge follows the cursor; gap closes on release
        c.in = o.in;
        c._pendingIn = ni;
        showTip(ev, `Start ${fmtTC(ni)}`);
        seekPreview(ni);
      } else {
        let no = clamp(o.out + dt, o.in + MIN_LEN, m.info.duration);
        no = clamp(o.in + snapT(clipStart + (no - o.in)) - clipStart, o.in + MIN_LEN, m.info.duration);
        if (Math.abs(m.info.duration - no) * S.zoom < SNAP_PX) no = m.info.duration;
        no = Math.min(snapSrc(no, m), wholeFrames(m.info.duration, m));
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
      const markT = target < S.clips.length ? st[target] : vTotal();
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

  /* ---------- file drop ---------- */

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    const paths = [...e.dataTransfer.files].map((f) => qc.pathFor(f)).filter(Boolean);
    // Sound dropped onto the audio lane lands where it was dropped.
    const lane = $('atrack').getBoundingClientRect();
    const onLane = e.clientY >= lane.top && e.clientY <= lane.bottom && e.clientX >= lane.left && e.clientX <= lane.right;
    importPaths(paths, onLane ? Math.max(0, snapTime((tlX(e) - PAD) / S.zoom)) : null);
  });

  const choose = async () => importPaths(await qc.openFiles());
  $('addBtn').addEventListener('click', choose);
  $('chooseBtn').addEventListener('click', choose);

  /* ---------- buttons & keys ---------- */

  $('playBtn').addEventListener('click', togglePlay);
  $('prevFrameBtn').addEventListener('click', () => step(-1));
  $('nextFrameBtn').addEventListener('click', () => step(1));
  $('newBtn').addEventListener('click', newEdit);
  $('openProjBtn').addEventListener('click', () => openProject());
  $('saveProjBtn').addEventListener('click', () => saveProject());
  $('editName').addEventListener('change', markDirty);
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('exportBtn').addEventListener('click', () => openExport());
  video.addEventListener('click', togglePlay);

  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' && !['range', 'checkbox', 'radio'].includes(e.target.type) || tag === 'select' || tag === 'textarea';
    if ($('exportDlg').open) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); if (hasContent()) openExport(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); e.shiftKey ? openProject() : choose(); return; }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newEdit(); return; }
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
      case '+': case '=': setZoom(S.zoom * 1.6); break;
      case '-': case '_': setZoom(S.zoom / 1.6); break;
      case '\\': fitZoom(); break;
      case 'z': case 'Z': zoomToSelection(); break;
      case 'Escape': S.selected = null; render(); break;
      default:
    }
  });

  /* ---------- timeline height (drag the line above it) ---------- */

  const setTlHeight = (h) => {
    const v = clamp(h, 200, Math.round(window.innerHeight * 0.72));
    app.style.setProperty('--tl-h', `${v}px`);
    return v;
  };
  setTlHeight(store.get('qc.tlh', Math.max(300, Math.round(window.innerHeight * 0.4))));
  $('splitter').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = $('splitter').nextElementSibling.getBoundingClientRect().height;
    document.body.style.cursor = 'ns-resize';
    const move = (ev) => { setTlHeight(h0 - (ev.clientY - y0)); renderTimeline(true); renderShape(); };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      store.set('qc.tlh', setTlHeight(h0 - (ev.clientY - y0)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  $('splitter').addEventListener('dblclick', () => { store.set('qc.tlh', setTlHeight(Math.round(window.innerHeight * 0.4))); renderTimeline(true); });

  /* ---------- hover hints ---------- */

  const hint = $('tip');
  let hintFor = null;
  function showHint(el) {
    hintFor = el;
    // A modal dialog sits in the top layer; the hint has to live inside it to show above it.
    const host = el.closest('dialog') || document.body;
    if (hint.parentNode !== host) host.appendChild(hint);
    const tpl = el.dataset.tipHtml && document.getElementById(`${el.dataset.tipHtml}Tip`);
    if (tpl) hint.innerHTML = tpl.innerHTML; else hint.textContent = el.dataset.tip;
    hint.classList.toggle('wide', !!tpl || hint.textContent.length > 60);
    hint.hidden = false;
    const r = el.getBoundingClientRect();
    const h = hint.getBoundingClientRect();
    const below = r.bottom + 8 + h.height < window.innerHeight;
    hint.style.top = `${below ? r.bottom + 8 : r.top - h.height - 8}px`;
    hint.style.left = `${clamp(r.left + r.width / 2 - h.width / 2, 8, window.innerWidth - h.width - 8)}px`;
  }
  function hideHint() { hintFor = null; hint.hidden = true; }
  const hintTarget = (e) => e.target.closest && e.target.closest('[data-tip],[data-tip-html]');
  document.addEventListener('pointerover', (e) => { const el = hintTarget(e); if (el && el !== hintFor && !el.disabled) showHint(el); else if (!el && hintFor) hideHint(); });
  document.addEventListener('pointerdown', hideHint);
  document.addEventListener('focusin', (e) => { const el = hintTarget(e); if (el && e.target.matches(':focus-visible')) showHint(el); });
  document.addEventListener('focusout', hideHint);
  window.addEventListener('blur', hideHint);

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
    { id: 'lossless', label: 'Best (lossless)', q: 100, ab: 320 },
    { id: 'high', label: 'High', q: 82, ab: 256 },
    { id: 'balanced', label: 'Balanced', q: 62, ab: 192 },
    { id: 'small', label: 'Small file', q: 38, ab: 128 },
  ];
  const qualityName = (q) => (q >= 100 ? 'Lossless' : q >= 85 ? 'Very high' : q >= 70 ? 'High' : q >= 50 ? 'Good' : q >= 30 ? 'Low' : 'Very low');

  let X = Object.assign({
    format: 'mp4', vcodec: 'h264', acodec: 'aac', abitrate: 192, quality: 82, resolution: 0, fps: 0,
    speed: 'balanced', mute: false, copy: true, gifWidth: 480, gifFps: 15, more: false,
  }, store.get('qc.export', {}));
  let phase = 'settings';
  let exportResult = null;
  let exportError = null;
  let exportStarted = 0;

  const NO_VIDEO = { hasVideo: false, hasAudio: false, width: 0, height: 0, fps: 0 };
  const segments = () => S.clips.map((c) => ({ path: media.get(c.mediaId).path, in: c.in, out: c.out, volume: c.volume, muted: c.muted, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 }));
  const infos = () => { const o = {}; [...S.clips, ...S.audio].forEach((c) => { const m = media.get(c.mediaId); o[m.path] = m.info; }); return o; };
  const audioTrack = () => S.audio.map((c) => ({ path: media.get(c.mediaId).path, start: c.start, in: c.in, out: c.out, volume: c.volume, muted: c.muted, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 }));
  const exportSettings = (extra = {}) => ({ ...X, shape: S.shape, fit: S.fit, audioTrack: audioTrack(), ...extra });

  async function normalize() {
    const f = FORMATS[X.format];
    if (f.video.length && !f.video.includes(X.vcodec)) X.vcodec = f.video[0];
    if (f.audio.length && !f.audio.includes(X.acodec)) X.acodec = f.audio[0];
    X.copyAvailable = await qc.canSmartCut(segments(), infos(), exportSettings({ copy: true }));
  }

  async function openExport() {
    if (!hasContent()) return;
    // Only sound on the timeline: offer the audio formats.
    if (!S.clips.length && FORMATS[X.format].video.length) X.format = 'mp3';
    pause();
    phase = 'settings';
    exportResult = null;
    exportError = null;
    await normalize();
    renderExport();
    const d = $('exportDlg');
    if (!d.open) { d.showModal(); $('xSave').focus(); }
  }

  function renderExport() {
    const d = $('exportDlg');
    const first = S.clips[0] ? media.get(S.clips[0].mediaId).info : NO_VIDEO;
    const f = FORMATS[X.format];
    const isGif = X.format === 'gif';
    const hasV = f.video.length > 0;
    const hasA = f.audio.length > 0;
    const anyAudio = S.audio.length > 0 || S.clips.some((c) => media.get(c.mediaId).info.hasAudio);

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

    const smartOn = X.copy && X.copyAvailable;
    d.innerHTML = `<div class="dlg-head"><h2 id="exportTitle">Export</h2><button class="icon-btn" id="xClose" aria-label="Close"><svg data-icon="x"></svg></button></div>
      <div class="dlg-body">
        <div>
          <div class="group-label">Format ${info(f.note)}</div>
          <div class="seg" id="xFmt">${Object.entries(FORMATS).map(([k, v]) => `<button type="button" data-v="${k}" aria-pressed="${k === X.format}"${v.video.length && !S.clips.length ? ' disabled data-tip="Add a video clip to save a video"' : ''}>${v.label}</button>`).join('')}</div>
        </div>
        ${X.copyAvailable ? `<label class="check"><input type="checkbox" id="xCopy" ${X.copy ? 'checked' : ''}><span>Keep original video quality</span>${info('Copies your footage untouched and only rebuilds the few frames around each cut. Exact cuts, faster, same picture. Turn it off to change the size, frame rate or file size.')}</label>` : ''}
        <div class="${smartOn && hasV ? 'disabled-block' : ''}">
          <div class="group-label">Quality ${info('Best keeps every detail but makes very big files. Small file is good for sending in a chat. High suits most things.')}</div>
          <div class="seg" id="xPreset">${PRESETS.map((p) => `<button type="button" data-v="${p.id}" aria-pressed="${hasV && !isGif ? Math.round(X.quality) === p.q : X.abitrate === p.ab && !losslessA === (p.q !== 100)}">${p.label}</button>`).join('')}</div>
        </div>
        <details class="more" id="xMore" ${X.more ? 'open' : ''}>
          <summary>More options</summary>
          <div class="more-body">
            ${hasV && !isGif ? `<div class="quality-row${locked}"><span>Smaller file</span><input type="range" id="xQ" min="0" max="100" value="${qShown}" style="--fill:${qShown}%" aria-label="Video quality" ${X.vcodec === 'ffv1' ? 'disabled' : ''}><span>Best quality</span><output id="xQName">${esc(qualityName(qShown))}</output></div>` : ''}
            <div class="adv">
              ${hasV && !isGif ? `<label class="field${locked}"><span>Video codec</span><select id="xV">${opt(f.video.map((v) => [v, VCODEC[v]]), X.vcodec)}</select></label>` : ''}
              ${hasV ? `<label class="field${locked}"><span>Resolution</span><select id="xRes">${isGif ? opt([[320, '320 px wide'], [480, '480 px wide'], [640, '640 px wide'], [800, '800 px wide'], [1080, '1080 px wide']], X.gifWidth) : opt(resOpts, X.resolution)}</select></label>` : ''}
              ${hasV ? `<label class="field${locked}"><span>Frame rate</span><select id="xFps">${isGif ? opt([[10, '10'], [15, '15'], [20, '20'], [25, '25']], X.gifFps) : opt(fpsOpts, X.fps)}</select></label>` : ''}
              ${hasV && !isGif ? `<label class="field${locked}"><span>Speed ${info(speedHelp())}</span><select id="xSpeed">${opt([['fast', GPU && GPU[X.vcodec] ? `Fastest (${GPU.name} card)` : 'Fastest'], ['balanced', 'Balanced'], ['small', 'Smallest file (slow)']], X.speed)}</select></label>` : ''}
              ${hasA ? `<label class="field"><span>Audio</span><select id="xA" ${X.mute && hasV ? 'disabled' : ''}>${opt(f.audio.map((x) => [x, ACODEC[x]]), X.acodec)}</select></label>` : ''}
              ${hasA ? `<label class="field"><span>Audio quality</span><select id="xAb" ${losslessA || (X.mute && hasV) ? 'disabled' : ''}>${losslessA ? '<option>Lossless</option>' : opt([[320, '320 kbps'], [256, '256 kbps'], [192, '192 kbps'], [128, '128 kbps'], [96, '96 kbps'], [64, '64 kbps']], X.abitrate)}</select></label>` : ''}
            </div>
            ${hasV && hasA && anyAudio ? `<label class="check"><input type="checkbox" id="xMute" ${X.mute ? 'checked' : ''}><span>Remove all sound</span></label>` : ''}
          </div>
        </details>
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
    on('xQ', 'input', (e) => { X.quality = Number(e.target.value); e.target.style.setProperty('--fill', `${X.quality}%`); $('xQName').textContent = qualityName(X.quality); estimate(); });
    on('xMore', 'toggle', (e) => { X.more = e.target.open; store.set('qc.export', X); });
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
    estimate();
  }

  // Graphics-card encoders found on this PC ({ h264, h265, av1, name }), filled in at startup.
  let GPU = null;
  qc.gpuInfo().then((g) => { GPU = g; }).catch(() => {});
  function speedHelp() {
    const card = GPU && GPU.name ? `your ${GPU.name} graphics card` : 'your graphics card when it has a video encoder';
    return `Fastest uses ${card}: much quicker, slightly bigger file. Balanced is the best mix${GPU && (GPU.h265 || GPU.av1) ? ' (H.265 and AV1 still use the card)' : ''}. Smallest file squeezes harder and takes longer.`;
  }

  let estTimer = null;
  function estimate() {
    clearTimeout(estTimer);
    estTimer = setTimeout(async () => {
      const el = $('xEst');
      if (!el) return;
      const f = FORMATS[X.format];
      const first = S.clips[0] ? media.get(S.clips[0].mediaId).info : NO_VIDEO;
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
        const bytes = await qc.estimate(segments(), infos(), exportSettings({ copy: X.copy && X.copyAvailable }));
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
      exportResult = await qc.exportVideo(segs, infos(), exportSettings({ copy: X.copy && X.copyAvailable }), out);
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

  let lastUpdate = null;
  function renderUpdate(u) {
    if (!u) return;
    lastUpdate = u;
    // the top-bar pill: only while something is actually happening
    const pill = $('updatePill');
    if (u.state === 'downloading') { pill.hidden = false; pill.innerHTML = `<svg data-icon="update"></svg>Updating ${Math.round((u.percent || 0) * 100)}%`; }
    else if (u.state === 'ready') { pill.hidden = false; pill.innerHTML = `<svg data-icon="update"></svg>Update ready <button id="restartBtn">Restart</button>`; }
    else pill.hidden = true;
    paintIcons(pill);
    const r = document.getElementById('restartBtn');
    if (r) r.addEventListener('click', () => qc.installUpdate());
    // the settings panel
    const status = $('setStatus');
    const btn = $('checkBtn');
    const label = btn.querySelector('span');
    const text = {
      idle: 'Quickcut checks by itself when it opens and every few hours.',
      checking: 'Checking for updates…',
      current: 'You’re on the newest version.',
      downloading: `Downloading version ${u.version || ''}… ${Math.round((u.percent || 0) * 100)}%`,
      ready: `Version ${u.version || ''} is ready. Restart Quickcut to finish updating.`,
      error: u.error || 'Couldn’t check for updates right now.',
      dev: 'Updates only work in the installed app, not this test copy.',
    }[u.state] || '';
    status.textContent = text;
    status.dataset.state = u.state;
    label.textContent = u.state === 'ready' ? 'Restart to update' : u.state === 'error' ? 'Try again' : 'Check for updates';
    btn.classList.toggle('btn-primary', u.state === 'ready');
    btn.disabled = u.state === 'checking' || u.state === 'downloading';
  }
  qc.onUpdate(renderUpdate);

  /* ---------- boot ---------- */

  qc.autosaveRead().then((json) => {
    if (!json || hasContent()) return;
    try {
      const o = JSON.parse(json);
      if (!(o.clips || []).length && !(o.audio || []).length) return;
      const b = $('restoreBtn');
      b.hidden = false;
      const n = (o.clips || []).length + (o.audio || []).length;
      b.querySelector('span').textContent = `Restore last edit (${n} clip${n > 1 ? 's' : ''})`;
      b.addEventListener('click', () => { b.hidden = true; loadProjectJSON(json, null); });
    } catch {}
  });
  window.addEventListener('beforeunload', () => { if (hasContent()) qc.autosaveWrite(serialize()); });

  qc.onOpenPaths((paths) => importPaths(paths));

  // Dark or light, remembered per machine. Dark is the default: footage reads truest on it.
  function setMode(mode) {
    document.documentElement.dataset.mode = mode;
    store.set('qc.mode', mode);
    $('modeSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    renderTimeline(true);
  }
  $('modeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
  setMode(store.get('qc.mode', 'dark'));

  /* ---------- settings panel (gear in the top bar) ---------- */

  const settings = $('settings');
  const settingsBtn = $('settingsBtn');
  function openSettings(open) {
    settings.hidden = !open;
    settingsBtn.setAttribute('aria-expanded', String(open));
    settingsBtn.classList.toggle('on', open);
    if (open) {
      const r = settingsBtn.getBoundingClientRect();
      settings.style.top = `${r.bottom + 8}px`;
      settings.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
      hideHint();
      qc.updateState().then(renderUpdate);
    }
  }
  settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); openSettings(settings.hidden); });
  document.addEventListener('pointerdown', (e) => { if (!settings.hidden && !settings.contains(e.target) && !settingsBtn.contains(e.target)) openSettings(false); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settings.hidden) { openSettings(false); settingsBtn.focus(); } }, true);
  qc.version().then((v) => { $('setVersion').textContent = `Version ${v}`; });
  $('checkBtn').addEventListener('click', () => {
    const u = lastUpdate;
    if (u && u.state === 'ready') { qc.installUpdate(); return; }
    qc.checkUpdates().then(renderUpdate);
  });

  window.__qcSetTheme = setMode;
  window.__qcRenderUpdate = renderUpdate;
  window.__qcImport = importPaths;
  window.__qcSeek = seekTo;
  window.__qcMediaThumbRate = (id) => media.get(id).thumbRate;
  window.__qcMedia = (id) => media.get(id);
  window.__qcOpenJSON = loadProjectJSON;
  window.__qcSerialize = serialize;
  window.__qcState = S;
  render();
})();
