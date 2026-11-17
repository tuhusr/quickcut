// ffmpeg / ffprobe work: probing clips, thumbnails, preview proxies, export.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const unpacked = (p) => p.replace('app.asar', 'app.asar.unpacked');
const FFMPEG = unpacked(require('ffmpeg-static'));
const FFPROBE = unpacked(require('ffprobe-static').path);

const WORK = path.join(os.tmpdir(), 'quickcut');
fs.mkdirSync(WORK, { recursive: true });

const keyFor = (file, extra = '') => {
  let st = { size: 0, mtimeMs: 0 };
  try { st = fs.statSync(file); } catch {}
  return crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${extra}`).digest('hex').slice(0, 16);
};

function run(bin, args, { onStdout, onStderr } = {}) {
  const child = spawn(bin, args, { windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; onStdout && onStdout(d.toString()); });
  child.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); onStderr && onStderr(d.toString()); });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else {
        const e = new Error(lastLines(err) || `exited with code ${code}`);
        e.code = code;
        e.killed = child.killed;
        reject(e);
      }
    });
  });
  return { child, done };
}

const lastLines = (s, n = 4) => s.trim().split(/\r?\n/).slice(-n).join('\n');

const fpsOf = (r) => {
  if (!r || r === '0/0') return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a;
};

async function probe(file) {
  const { done } = run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(await done);
  const v = info.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = info.streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new Error('No video or audio found in this file.');
  let rotation = 0;
  if (v) {
    const sd = (v.side_data_list || []).find((d) => d.rotation !== undefined);
    rotation = sd ? Number(sd.rotation) : Number((v.tags && v.tags.rotate) || 0);
  }
  let width = v ? v.width : 0;
  let height = v ? v.height : 0;
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const duration = Number(info.format.duration) || Number(v && v.duration) || Number(a && a.duration) || 0;
  return {
    path: file,
    name: path.basename(file),
    size: Number(info.format.size) || 0,
    duration,
    hasVideo: !!v,
    hasAudio: !!a,
    width,
    height,
    fps: v ? fpsOf(v.avg_frame_rate) || fpsOf(v.r_frame_rate) : 0,
    vcodec: v ? v.codec_name : null,
    acodec: a ? a.codec_name : null,
    pixFmt: v ? v.pix_fmt : null,
    sampleRate: a ? Number(a.sample_rate) : 0,
    channels: a ? a.channels : 0,
    vbitrate: v ? Number(v.bit_rate) || 0 : 0,
    bitrate: Number(info.format.bit_rate) || 0,
    format: info.format.format_name,
    rotation,
    vProfile: v ? v.profile || null : null,
    vLevel: v ? v.level || null : null,
    rFrameRate: v ? v.r_frame_rate : null,
    timeBase: v ? v.time_base : null,
    colorRange: v ? v.color_range || null : null,
    colorSpace: v ? v.color_space || null : null,
    colorPrimaries: v ? v.color_primaries || null : null,
    colorTrc: v ? v.color_transfer || null : null,
  };
}

// Video packet times of the first stream (from packet flags: no decoding, fast).
// kfs = keyframe times, pts = every frame time, both sorted.
const kfCache = new Map();
async function keyframes(file) {
  const k = keyFor(file, 'kf');
  if (kfCache.has(k)) return kfCache.get(k);
  const { done } = run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file]);
  const out = await done;
  const kfs = [];
  const pts = [];
  out.split(/\r?\n/).forEach((line) => {
    const [t, flags] = line.split(',');
    if (!flags || t === 'N/A') return;
    pts.push(Number(t));
    if (flags.includes('K')) kfs.push(Number(t));
  });
  kfs.sort((a, b) => a - b);
  pts.sort((a, b) => a - b);
  const res = { kfs, pts };
  kfCache.set(k, res);
  return res;
}

// A strip of small frames across the clip, for the timeline: evenly spaced (about two a second,
// at most 600) and each one taken at a known time, so the strip can place it exactly.
// Returns { rate, files } where files[n] shows the source at n / rate seconds.
async function thumbs(file, duration, height = 72) {
  const count = Math.round(Math.min(600, Math.max(8, duration * 2)));
  const rate = count / Math.max(duration, 0.001);
  const dir = path.join(WORK, `s-${keyFor(file, `${count}-${height}`)}`);
  const index = path.join(dir, 'index.json');
  try { return JSON.parse(fs.readFileSync(index, 'utf8')); } catch {}
  fs.mkdirSync(dir, { recursive: true });
  // One decode pass with the fps filter: frame n is the source frame nearest n / rate.
  await run(FFMPEG, ['-v', 'error', '-y', '-i', file, '-map', '0:v:0', '-an', '-sn',
    '-vf', `fps=${rate.toFixed(6)}:round=near,scale=-2:${height}:flags=bilinear`, '-q:v', '6', path.join(dir, '%04d.jpg')]).done;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f));
  const res = { rate, files };
  fs.writeFileSync(index, JSON.stringify(res));
  return res;
}

// Exact frames for a zoomed-in strip: one picture per requested time, cached per frame.
async function frames(file, times, height = 72) {
  const dir = path.join(WORK, `f-${keyFor(file, String(height))}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  const jobs = times.map((t) => async () => {
    const f = path.join(dir, `${Math.round(t * 1000)}.jpg`);
    if (!fs.existsSync(f)) {
      await run(FFMPEG, ['-v', 'error', '-y', '-ss', Math.max(0, t - 0.002).toFixed(6), '-i', file, '-map', '0:v:0', '-frames:v', '1',
        '-vf', `scale=-2:${height}:flags=bilinear`, '-q:v', '5', f]).done.catch(() => null);
    }
    if (fs.existsSync(f)) out[t] = f;
  });
  let next = 0;
  const lane = async () => { while (next < jobs.length) await jobs[next++](); };
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, lane));
  return out;
}

// Waveform picture of the whole file's audio; clips show their trimmed slice of it.
async function waveform(file, duration) {
  const w = Math.round(Math.min(16000, Math.max(800, duration * 60)));
  const out = path.join(WORK, `w-${keyFor(file, String(w))}.png`);
  if (fs.existsSync(out)) return out;
  await run(FFMPEG, ['-v', 'error', '-y', '-i', file, '-filter_complex',
    `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${w}x120:colors=#d9c4b4:scale=sqrt:draw=full[w]`, '-map', '[w]', '-frames:v', '1', out]).done;
  return out;
}

// Low-res H.264 copy for files Chromium can't play (mkv/hevc/avi...). Never used for export.
const proxies = new Map();
function proxy(file, onProgress) {
  const out = path.join(WORK, `p-${keyFor(file)}.mp4`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (proxies.has(out)) return proxies.get(out);
  const tmp = `${out}.part.mp4`;
  const p = (async () => {
    const info = await probe(file);
    const { done } = run(FFMPEG, ['-v', 'error', '-y', '-i', file,
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-vf', 'scale=-2:min(720\\,ih),format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '15',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp], {
      onStdout: (s) => {
        const m = /out_time_us=(\d+)/.exec(s);
        if (m && info.duration) onProgress && onProgress(Math.min(1, Number(m[1]) / 1e6 / info.duration));
      },
    });
    await done;
    fs.renameSync(tmp, out);
    return out;
  })().finally(() => proxies.delete(out));
  proxies.set(out, p);
  return p;
}

/* ---------------- Export ---------------- */

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Container → what it can hold.
const FORMATS = {
  mp4: { ext: 'mp4', video: ['h264', 'h265', 'av1'], audio: ['aac', 'alac', 'mp3', 'opus'] },
  mov: { ext: 'mov', video: ['h264', 'h265', 'prores'], audio: ['aac', 'alac', 'pcm'] },
  mkv: { ext: 'mkv', video: ['h264', 'h265', 'av1', 'vp9', 'ffv1'], audio: ['aac', 'flac', 'opus', 'mp3', 'pcm'] },
  webm: { ext: 'webm', video: ['vp9', 'av1'], audio: ['opus'] },
  gif: { ext: 'gif', video: ['gif'], audio: [] },
  mp3: { ext: 'mp3', video: [], audio: ['mp3'] },
  wav: { ext: 'wav', video: [], audio: ['pcm'] },
  flac: { ext: 'flac', video: [], audio: ['flac'] },
};

// Graphics-card encoders (NVIDIA NVENC, Intel Quick Sync, AMD AMF). Detected once, by a tiny
// real test encode with the exact arguments we'd use, so a driver that lists an encoder but
// can't run it never gets picked.
const GPU_ENCODERS = {
  h264: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
  h265: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf'],
  av1: ['av1_nvenc', 'av1_qsv', 'av1_amf'],
};

// crf is the CPU encoder's value for this quality. NVENC needs a higher number to land on the same
// picture quality (VMAF-matched against x264 / x265 / libaom on real footage).
const NV_OFFSET = { h264: 6, h265: 8, av1: 12 };
function gpuArgs(enc, codec, crf, speed) {
  const vendor = enc.split('_')[1];
  const tag = codec === 'h265' ? ['-tag:v', 'hvc1'] : [];
  if (vendor === 'nvenc') {
    const preset = { fast: 'p2', balanced: 'p5', small: 'p7' }[speed] || 'p5';
    const aq = codec === 'av1' ? ['-spatial-aq', '1'] : ['-spatial-aq', '1', '-temporal-aq', '1'];
    return ['-c:v', enc, '-preset', preset, '-tune', 'hq', '-rc', 'vbr', '-cq', String(Math.min(51, crf + NV_OFFSET[codec])), '-b:v', '0', ...aq, '-rc-lookahead', '20', '-pix_fmt', 'yuv420p', ...tag];
  }
  if (vendor === 'qsv') {
    const preset = { fast: 'veryfast', balanced: 'medium', small: 'slower' }[speed] || 'medium';
    return ['-c:v', enc, '-preset', preset, '-global_quality', String(crf + 3), '-pix_fmt', 'nv12', ...tag];
  }
  const quality = { fast: 'speed', balanced: 'balanced', small: 'quality' }[speed] || 'balanced';
  const qp = String(crf + 3);
  return ['-c:v', enc, '-quality', quality, '-rc', 'cqp', '-qp_i', qp, '-qp_p', qp, ...(codec === 'av1' ? [] : ['-qp_b', qp]), '-pix_fmt', 'nv12', ...tag];
}

let gpuProbe = null;
function detectGpu() {
  if (gpuProbe) return gpuProbe;
  gpuProbe = (async () => {
    const found = {};
    for (const [codec, list] of Object.entries(GPU_ENCODERS)) {
      for (const enc of list) {
        try {
          await run(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-t', '0.3', ...gpuArgs(enc, codec, 23, 'balanced'), '-f', 'null', '-']).done;
          found[codec] = enc;
          break;
        } catch {}
      }
    }
    return found;
  })();
  return gpuProbe;
}

const gpuName = (enc) => (!enc ? null : enc.includes('nvenc') ? 'NVIDIA' : enc.includes('qsv') ? 'Intel' : 'AMD');

// When the graphics card is worth it: always for H.265/AV1 (the CPU encoders are many times
// slower), and for H.264 only on "Fastest" (the CPU is as quick at a smaller size otherwise).
function pickGpu(codec, quality, speed, gpu) {
  if (!gpu || quality >= 100) return null;
  const enc = gpu[codec];
  if (!enc) return null;
  if (codec === 'h264') return speed === 'fast' ? enc : null;
  if (codec === 'av1') return enc;
  return speed === 'small' ? null : enc;
}

// Quality 0..100 (100 = lossless) → encoder args. `gpu` is the detectGpu() result (or null).
function videoArgs(codec, quality, speed, gpu) {
  const q = Math.max(0, Math.min(100, quality));
  const lossless = q >= 100;
  // x264/x265 presets: "faster" matches "medium" quality within a VMAF point at ~1.4× the speed.
  const preset = { fast: 'veryfast', balanced: 'faster', small: 'slow' }[speed] || 'faster';
  const hw = pickGpu(codec, q, speed, gpu);
  switch (codec) {
    case 'h264': {
      if (lossless) return ['-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0'];
      const crf = Math.round(40 - q * 0.26); // 100→14 … 0→40
      if (hw) return gpuArgs(hw, codec, crf, speed);
      return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p'];
    }
    case 'h265': {
      if (lossless) return ['-c:v', 'libx265', '-preset', 'veryfast', '-x265-params', 'lossless=1:log-level=error', '-tag:v', 'hvc1'];
      const crf = Math.round(42 - q * 0.26);
      if (hw) return gpuArgs(hw, codec, crf, speed);
      return ['-c:v', 'libx265', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'];
    }
    case 'av1': {
      const crf = lossless ? 0 : Math.round(55 - q * 0.35);
      if (hw) return gpuArgs(hw, codec, crf, speed);
      const cpu = { fast: '8', balanced: '6', small: '4' }[speed] || '6';
      return ['-c:v', 'libaom-av1', '-cpu-used', cpu, '-row-mt', '1', '-crf', String(crf), '-b:v', '0', ...(lossless ? ['-aom-params', 'lossless=1'] : ['-pix_fmt', 'yuv420p'])];
    }
    case 'vp9': {
      const dl = { fast: ['-deadline', 'realtime', '-cpu-used', '8'], balanced: ['-deadline', 'good', '-cpu-used', '4'], small: ['-deadline', 'good', '-cpu-used', '1'] }[speed];
      if (lossless) return ['-c:v', 'libvpx-vp9', '-lossless', '1', '-row-mt', '1', ...dl];
      const crf = Math.round(50 - q * 0.32);
      return ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p', ...dl];
    }
    case 'prores': {
      // 0 proxy · 1 LT · 2 standard · 3 HQ · 4 4444
      const profile = q >= 100 ? 4 : q >= 75 ? 3 : q >= 50 ? 2 : q >= 25 ? 1 : 0;
      return ['-c:v', 'prores_ks', '-profile:v', String(profile), '-pix_fmt', profile === 4 ? 'yuva444p10le' : 'yuv422p10le', '-vendor', 'apl0'];
    }
    case 'ffv1':
      return ['-c:v', 'ffv1', '-level', '3', '-g', '1', '-slicecrc', '1'];
    default:
      return [];
  }
}

function audioArgs(codec, kbps) {
  switch (codec) {
    case 'aac': return ['-c:a', 'aac', '-b:a', `${kbps}k`];
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`];
    case 'opus': return ['-c:a', 'libopus', '-b:a', `${Math.min(kbps, 510)}k`];
    case 'alac': return ['-c:a', 'alac'];
    case 'flac': return ['-c:a', 'flac'];
    case 'pcm': return ['-c:a', 'pcm_s16le'];
    default: return [];
  }
}

// Can every segment be joined without re-encoding? (same codec, size, fps, profile)
function canCopy(segments, infos) {
  if (!segments.length) return false;
  const first = infos[segments[0].path];
  if (!first || !first.hasVideo) return false;
  return segments.every((s) => {
    const i = infos[s.path];
    return i && i.hasVideo && i.vcodec === first.vcodec && i.width === first.width && i.height === first.height &&
      Math.abs(i.fps - first.fps) < 0.01 && i.pixFmt === first.pixFmt && i.vProfile === first.vProfile && i.rotation === first.rotation;
  });
}

// Smart cut: exact cuts that keep the original video. Only the frames between each cut
// and the next keyframe are re-encoded; everything else is copied bit for bit.
const SMART_CODECS = ['h264', 'hevc'];
function canSmartCut(segments, infos, settings) {
  if (!segments.length) return false;
  const first = infos[segments[0].path];
  return canCopy(segments, infos) && SMART_CODECS.includes(first.vcodec) && !first.rotation &&
    ['mp4', 'mov', 'mkv'].includes(settings.format) &&
    segments.every((s) => !(s.fadeIn > 0) && !(s.fadeOut > 0)) && (!settings.shape || settings.shape === 'orig') &&
    trackEnd(settings.audioTrack) <= segments.reduce((t, x) => t + (x.out - x.in), 0) + 0.001;
}

const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3 };

function outputSize(settings, infos, segments) {
  const first = infos[segments[0].path];
  let w = first.width || 1920;
  let h = first.height || 1080;
  const a = ASPECTS[settings.shape];
  if (a) {
    if (a > w / h) h = w / a; else w = h * a;
  }
  const target = Number(settings.resolution) || 0; // short side, 0 = source
  if (target) {
    const scale = target / Math.min(w, h);
    w *= scale; h *= scale;
  }
  if (settings.format === 'gif') {
    const max = Number(settings.gifWidth) || 480;
    const s = Math.min(1, max / Math.max(w, h));
    w *= s; h *= s;
  }
  return { w: even(w), h: even(h) };
}

const trackEnd = (track) => (track || []).reduce((t, c) => Math.max(t, c.start + (c.out - c.in)), 0);

// Mixes the audio track (clips placed anywhere in time) over the video track's own sound.
// `base` is the label of the video track's sound or null; inputs for the track start at `first`.
// Returns the label of a stream exactly `T` seconds long.
function mixAudioTrack(parts, base, track, infos, first, T) {
  const labels = base ? [base] : [];
  track.forEach((c, k) => {
    const d = c.out - c.in;
    const ms = Math.round(c.start * 1000);
    const lbl = `t${k}`;
    parts.push(audioChain(`${first + k}:a:0`, c, infos[c.path], d, `${lbl}pre`));
    parts.push(`[${lbl}pre]adelay=delays=${ms}:all=1[${lbl}]`);
    labels.push(`[${lbl}]`);
  });
  if (!labels.length) {
    parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${T.toFixed(3)}[amix]`);
    return '[amix]';
  }
  const mixed = labels.length > 1
    ? `${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,`
    : `${labels[0]}anull,`;
  parts.push(`${mixed}apad=whole_dur=${T.toFixed(3)},atrim=duration=${T.toFixed(3)},asetpts=PTS-STARTPTS[amix]`);
  return '[amix]';
}

// Per-segment audio chain: gain, fades, padded to the exact segment length.
function audioChain(label, s, info, d, out) {
  const vol = s.muted ? 0 : (s.volume ?? 1);
  const fades = [];
  if (s.fadeIn > 0) fades.push(`afade=t=in:st=0:d=${Math.min(s.fadeIn, d).toFixed(3)}`);
  if (s.fadeOut > 0) fades.push(`afade=t=out:st=${Math.max(0, d - s.fadeOut).toFixed(3)}:d=${Math.min(s.fadeOut, d).toFixed(3)}`);
  if (info.hasAudio && vol > 0) {
    const gain = Math.abs(vol - 1) > 0.001 ? `,volume=${vol.toFixed(3)}` : '';
    return `[${label}]aresample=48000:async=1,aformat=sample_rates=48000:channel_layouts=stereo${gain},atrim=duration=${d.toFixed(3)},apad=whole_dur=${d.toFixed(3)},asetpts=PTS-STARTPTS${fades.length ? ',' + fades.join(',') : ''}[${out}]`;
  }
  return `anullsrc=r=48000:cl=stereo,atrim=duration=${d.toFixed(3)}[${out}]`;
}

function buildExport(segments, infos, settings, outPath) {
  const fmt = FORMATS[settings.format];
  if (!fmt) throw new Error(`Unknown format ${settings.format}`);
  const track = settings.audioTrack || [];
  const vLen = segments.reduce((t, s) => t + (s.out - s.in), 0);
  const wantVideo = fmt.video.length > 0;
  const wantAudio = fmt.audio.length > 0 && !settings.mute;
  const audio = wantAudio && (segments.some((s) => infos[s.path].hasAudio) || track.length > 0);
  // GIFs have no sound, so the music can't make them longer.
  const total = audio ? Math.max(vLen, trackEnd(track)) : vLen;
  if (wantVideo && !segments.length) throw new Error('Add a video clip to save a video, or pick MP3 or WAV to save just the sound.');

  const { w, h } = wantVideo ? outputSize(settings, infos, segments) : { w: 0, h: 0 };
  const firstFps = segments.length ? infos[segments[0].path].fps || 30 : 30;
  const fps = settings.format === 'gif' ? Number(settings.gifFps) || 15 : Number(settings.fps) || Math.round(firstFps * 1000) / 1000;
  const fill = settings.fit === 'fill';

  const args = ['-hide_banner', '-v', 'error', '-y'];
  // ffmpeg's exact seek returns the first frame at or after -ss; start 1 ms early so a cut placed
  // on a frame's own timestamp begins on that frame, not the next one.
  segments.forEach((s) => {
    args.push('-ss', Math.max(0, s.in - 0.001).toFixed(6), '-t', (s.out - s.in).toFixed(6), '-i', s.path);
  });
  if (audio) track.forEach((c) => args.push('-ss', c.in.toFixed(3), '-t', (c.out - c.in).toFixed(3), '-i', c.path));

  const parts = [];
  const labels = [];
  segments.forEach((s, i) => {
    const info = infos[s.path];
    const d = s.out - s.in;
    if (wantVideo) {
      const fades = [];
      if (s.fadeIn > 0) fades.push(`fade=t=in:st=0:d=${Math.min(s.fadeIn, d).toFixed(3)}`);
      if (s.fadeOut > 0) fades.push(`fade=t=out:st=${Math.max(0, d - s.fadeOut).toFixed(3)}:d=${Math.min(s.fadeOut, d).toFixed(3)}`);
      const fit = fill
        ? `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`
        : `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
      if (info.hasVideo) {
        parts.push(`[${i}:v:0]${fit},setsar=1,fps=${fps},format=yuv420p,trim=duration=${d.toFixed(3)},setpts=PTS-STARTPTS${fades.length ? ',' + fades.join(',') : ''}[v${i}]`);
      } else {
        parts.push(`color=c=black:s=${w}x${h}:r=${fps}:d=${d.toFixed(3)},format=yuv420p[v${i}]`);
      }
      labels.push(`[v${i}]`);
    }
    if (audio) {
      parts.push(audioChain(`${i}:a:0`, s, info, d, `a${i}`));
      labels.push(`[a${i}]`);
    }
  });
  if (segments.length) {
    parts.push(`${labels.join('')}concat=n=${segments.length}:v=${wantVideo ? 1 : 0}:a=${audio ? 1 : 0}${wantVideo ? '[vseq]' : ''}${audio ? '[aseq]' : ''}`);
  }
  if (wantVideo) {
    // Music that runs on past the last video clip: hold black frames until it ends.
    const pad = total - vLen;
    parts.push(pad > 0.001 && settings.format !== 'gif' ? `[vseq]tpad=stop_mode=add:stop_duration=${pad.toFixed(3)}:color=black[vcat]` : '[vseq]null[vcat]');
  }
  if (audio) {
    const out = mixAudioTrack(parts, segments.length ? '[aseq]' : null, track, infos, segments.length, total);
    parts.push(`${out}anull[acat]`);
  }

  if (settings.format === 'gif') {
    parts.push('[vcat]split[g1][g2];[g1]palettegen=stats_mode=diff[pal];[g2][pal]paletteuse=dither=sierra2_4a[vout]');
  }
  const lossless = Number(settings.quality) >= 100;
  // yuv420p would throw away colour on a lossless export; keep full chroma.
  let graph = parts.join(';');
  if (lossless && wantVideo && settings.format !== 'gif') graph = graph.replace(/format=yuv420p/g, 'format=yuv444p');
  args.push('-filter_complex', graph);

  if (wantVideo) args.push('-map', settings.format === 'gif' ? '[vout]' : '[vcat]');
  if (audio) args.push('-map', '[acat]');

  if (wantVideo && settings.format !== 'gif') {
    let vargs = videoArgs(settings.vcodec, Number(settings.quality), settings.speed, settings.gpu === false ? null : settings._gpu);
    if (lossless) vargs = vargs.filter((a, i, arr) => a !== '-pix_fmt' && arr[i - 1] !== '-pix_fmt');
    args.push(...vargs);
    if (settings.vcodec === 'h264' && lossless) args.push('-pix_fmt', 'yuv444p');
  }
  if (settings.format === 'gif') args.push('-loop', '0');
  if (audio) args.push(...audioArgs(settings.acodec, Number(settings.abitrate) || 192), '-ar', '48000', '-ac', '2');
  if (settings.format === 'mp4' || settings.format === 'mov') args.push('-movflags', '+faststart');
  args.push(outPath);
  return { args, total };
}

/* ---- running jobs (one export at a time, cancellable) ---- */

const running = new Set(); // ffmpeg children of the export in progress
let exporting = false;
let cancelled = false;

// Runs one ffmpeg step; reports 0..1 of `dur` seconds of output through onP.
function step(args, dur, onP) {
  const job = run(FFMPEG, [...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', args[args.length - 1]], {
    onStdout: (s) => {
      const m = /out_time_us=(\d+)/g;
      let last = null; let x;
      while ((x = m.exec(s))) last = x;
      if (last && dur > 0) onP(Math.min(1, Number(last[1]) / 1e6 / dur));
    },
  });
  running.add(job.child);
  return job.done.finally(() => running.delete(job.child));
}

function smartParams(info) {
  const p = String(info.vProfile || '').toLowerCase();
  const args = [];
  if (info.vcodec === 'h264') {
    const profile = p.includes('baseline') ? 'baseline' : p.includes('main') ? 'main' : p.includes('4:4:4') ? 'high444' : p.includes('high 10') ? 'high10' : p.includes('4:2:2') ? 'high422' : 'high';
    args.push('-c:v', 'libx264', '-preset', 'faster', '-crf', '12', '-profile:v', profile);
    if (info.vLevel > 0) args.push('-level:v', (info.vLevel / 10).toFixed(1));
    args.push('-x264-params', 'repeat-headers=1');
  } else {
    args.push('-c:v', 'libx265', '-preset', 'faster', '-crf', '14', '-x265-params', 'log-level=error:repeat-headers=1');
    if (p.includes('10')) args.push('-profile:v', 'main10');
  }
  args.push('-pix_fmt', info.pixFmt || 'yuv420p');
  const known = (v) => v && v !== 'unknown';
  if (known(info.colorRange)) args.push('-color_range', info.colorRange);
  if (known(info.colorSpace)) args.push('-colorspace', info.colorSpace);
  if (known(info.colorPrimaries)) args.push('-color_primaries', info.colorPrimaries);
  if (known(info.colorTrc)) args.push('-color_trc', info.colorTrc);
  return args;
}

// Runs async jobs `limit` at a time; rejects on the first failure.
async function pool(jobs, limit) {
  let next = 0;
  const lane = async () => { while (next < jobs.length) await jobs[next++](); };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, lane));
}

async function smartExport(segments, infos, settings, outPath, onProgress) {
  const first = infos[segments[0].path];
  const bsf = first.vcodec === 'h264' ? 'h264_mp4toannexb' : 'hevc_mp4toannexb';
  const dir = path.join(WORK, `smart-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const total = segments.reduce((t, s) => t + (s.out - s.in), 0);
  const fmt = FORMATS[settings.format];
  const audio = fmt.audio.length > 0 && !settings.mute && (segments.some((s) => infos[s.path].hasAudio) || (settings.audioTrack || []).length > 0);

  // Plan every piece first so progress can be weighted (encoding costs far more than copying).
  const plan = [];
  // A frame belongs to a segment when in <= pts < out: the same rule ffmpeg's exact seek uses.
  const eps = 0.0005;
  for (const s of segments) {
    const { kfs, pts } = await keyframes(s.path);
    const count = (a, b) => pts.filter((t) => t >= a - eps && t < b - eps).length;
    const k1 = kfs.find((t) => t >= s.in - eps);
    const kL = [...kfs].reverse().find((t) => t < s.out - eps);
    const piece = (kind, from, to) => { const n = count(from, to); if (n > 0) plan.push({ kind, path: s.path, from, to, frames: n, info: infos[s.path] }); };
    if (k1 === undefined || kL === undefined || kL <= k1) piece('enc', s.in, s.out);
    else {
      // Re-encode up to the first keyframe, copy whole keyframe-to-keyframe runs, re-encode the tail.
      piece('enc', s.in, k1);
      piece('copy', k1, kL);
      piece('enc', kL, s.out);
    }
  }
  const cost = (p) => (p.to - p.from) * (p.kind === 'enc' ? 40 : 1);
  const tail = (audio ? total * 2 : 0) + total * 0.25;
  const all = plan.reduce((t, p) => t + cost(p), 0) + total * 0.25 + tail;
  let doneCost = 0;
  const report = (c) => onProgress(Math.min(0.995, (doneCost + c) / all));

  try {
    // Each piece is independent: run them side by side (a few at once), keep their order for the join.
    const files = plan.map((_, i) => path.join(dir, `p${String(i).padStart(4, '0')}.ts`));
    const partDone = plan.map(() => 0);
    const tick = () => report(partDone.reduce((t, x) => t + x, 0) - doneCost);
    const work = plan.map((p, i) => async () => {
      if (cancelled) throw new Error('cancelled');
      const dur = p.to - p.from;
      const common = ['-hide_banner', '-v', 'error', '-y'];
      const onP = (f) => { partDone[i] = cost(p) * f; tick(); };
      if (p.kind === 'enc') {
        await step([...common, '-ss', (p.from - eps).toFixed(6), '-i', p.path, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', String(p.frames),
          ...smartParams(p.info), '-fps_mode', 'passthrough', '-f', 'mpegts', files[i]], dur, onP);
      } else {
        // Seeking just past the keyframe lands exactly on it; a frame count (not a time) ends the copy exactly.
        await step([...common, '-ss', (p.from + 0.0005).toFixed(6), '-i', p.path, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', String(p.frames),
          '-c:v', 'copy', '-bsf:v', bsf, '-f', 'mpegts', files[i]], dur, onP);
      }
      partDone[i] = cost(p);
      tick();
    });
    await pool(work, Math.max(2, Math.min(4, Math.floor(os.cpus().length / 4))));
    doneCost = plan.reduce((t, p) => t + cost(p), 0);

    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    const video = path.join(dir, 'video.ts');
    await step(['-hide_banner', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'mpegts', video], total, (f) => report(total * 0.25 * f));
    doneCost += total * 0.25;

    // Final mux: copied video + audio rebuilt from the originals (exact cuts, volume honoured).
    const args = ['-hide_banner', '-v', 'error', '-y', '-fflags', '+genpts', '-i', video];
    if (audio) {
      const graph = [];
      const track = settings.audioTrack || [];
      segments.forEach((s) => args.push('-ss', s.in.toFixed(3), '-t', (s.out - s.in).toFixed(3), '-i', s.path));
      track.forEach((c) => args.push('-ss', c.in.toFixed(3), '-t', (c.out - c.in).toFixed(3), '-i', c.path));
      const labels = segments.map((s, i) => { graph.push(audioChain(`${i + 1}:a:0`, s, infos[s.path], s.out - s.in, `a${i}`)); return `[a${i}]`; });
      graph.push(`${labels.join('')}concat=n=${segments.length}:v=0:a=1[aseq]`);
      const mixed = mixAudioTrack(graph, '[aseq]', track, infos, segments.length + 1, total);
      args.push('-filter_complex', graph.join(';'), '-map', '0:v:0', '-map', mixed, ...audioArgs(settings.acodec, Number(settings.abitrate) || 192), '-ar', '48000', '-ac', '2');
    } else args.push('-map', '0:v:0');
    args.push('-c:v', 'copy');
    if (first.vcodec === 'hevc' && settings.format !== 'mkv') args.push('-tag:v', 'hvc1');
    if (settings.format === 'mp4' || settings.format === 'mov') args.push('-movflags', '+faststart');
    args.push(outPath);
    await step(args, total, (f) => report(tail * f));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function exportVideo(segments, infos, settings, outPath, onProgress) {
  if (exporting) throw new Error('An export is already running.');
  exporting = true;
  cancelled = false;
  const tmp = outPath + '.part' + path.extname(outPath); // ffmpeg picks the muxer from the extension
  try {
    if (settings.copy && canSmartCut(segments, infos, settings)) {
      await smartExport(segments, infos, settings, tmp, onProgress);
    } else {
      const gpu = settings.gpu === false ? null : await detectGpu();
      const { args, total } = buildExport(segments, infos, { ...settings, _gpu: gpu }, tmp);
      try {
        await step(args, total, (f) => onProgress(Math.min(0.999, f)));
      } catch (e) {
        // A graphics-card hiccup (driver, too many sessions): redo it on the CPU instead of failing.
        if (cancelled || !args.some((a) => /_(nvenc|qsv|amf)$/.test(a))) throw e;
        const cpu = buildExport(segments, infos, { ...settings, _gpu: null }, tmp);
        await step(cpu.args, cpu.total, (f) => onProgress(Math.min(0.999, f)));
      }
    }
    fs.renameSync(tmp, outPath);
    onProgress(1);
    return { path: outPath, size: fs.statSync(outPath).size };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (cancelled) { const c = new Error('Export cancelled.'); c.cancelled = true; throw c; }
    throw e;
  } finally {
    exporting = false;
  }
}

function cancelExport() {
  cancelled = true;
  running.forEach((c) => c.kill('SIGKILL'));
  return running.size > 0;
}

// Rough size estimate (bytes) so the export dialog can say "about 48 MB".
function estimateSize(segments, infos, settings) {
  const total = Math.max(segments.reduce((t, s) => t + (s.out - s.in), 0), trackEnd(settings.audioTrack));
  const fmt = FORMATS[settings.format];
  if (settings.copy) {
    return segments.reduce((t, s) => { const i = infos[s.path]; return t + (i.bitrate / 8) * (s.out - s.in); }, 0);
  }
  let vbps = 0;
  if (fmt.video.length && segments.length) {
    const { w, h } = outputSize(settings, infos, segments);
    const fps = settings.format === 'gif' ? Number(settings.gifFps) || 15 : Number(settings.fps) || infos[segments[0].path].fps || 30;
    const px = w * h * fps;
    const q = Number(settings.quality);
    // Bits per pixel of the sources: tells us how "busy" this footage is to encode.
    let bits = 0; let pxs = 0;
    segments.forEach((s) => {
      const i = infos[s.path];
      if (!i.hasVideo) return;
      const d = s.out - s.in;
      const vb = i.vbitrate || Math.max(0, i.bitrate - 160000);
      const srcEff = { hevc: 1.6, av1: 1.9, vp9: 1.5, h264: 1, mpeg4: 0.7 }[i.vcodec] || 1;
      bits += vb * srcEff * d;
      pxs += i.width * i.height * (i.fps || 30) * d;
    });
    const bpp = pxs ? clampN(bits / pxs, 0.02, 0.5) : 0.1;
    const codecEff = { h264: 1, h265: 0.6, av1: 0.5, vp9: 0.65 }[settings.vcodec] ?? 1;
    const videoShare = pxs ? segments.reduce((t, s) => t + (infos[s.path].hasVideo ? s.out - s.in : 0), 0) / total : 0;
    if (settings.format === 'gif') vbps = px * 2.4;
    else if (settings.vcodec === 'prores') vbps = px * [0.6, 1.3, 1.9, 2.8, 4.2][q >= 100 ? 4 : q >= 75 ? 3 : q >= 50 ? 2 : q >= 25 ? 1 : 0];
    else if (settings.vcodec === 'ffv1') vbps = px * 1.1;
    else if (q >= 100) vbps = px * 0.85 * codecEff;
    else vbps = px * bpp * Math.pow(2, (q - 80) / 13) * codecEff * Math.max(0.15, videoShare);
  }
  let abps = 0;
  if (fmt.audio.length && !settings.mute) {
    abps = ['flac', 'alac'].includes(settings.acodec) ? 900000 : settings.acodec === 'pcm' ? 1536000 : (Number(settings.abitrate) || 192) * 1000;
  }
  return ((vbps + abps) / 8) * total;
}

const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

module.exports = { detectGpu, gpuName, probe, thumbs, frames, waveform, proxy, keyframes, exportVideo, cancelExport, canCopy, canSmartCut, estimateSize, FORMATS, WORK };
