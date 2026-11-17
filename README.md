# Quickcut

A quick, simple video editor for Windows. Drop clips in, trim them, put them in order, save one new video.

## Get it

Download `Quickcut-Setup-<version>.exe` from [Releases](https://github.com/tuhusr/quickcut/releases/latest) and run it. Installed copies update themselves.

## What it does

- Drag in videos and audio (MP4, MOV, MKV, WebM, AVI, MP3, WAV and more)
- Trim by pulling clip edges or typing exact times; split at the playhead; drag to reorder
- Per-clip volume, mute, fade in / fade out
- Shapes: original, 16:9, 9:16, 1:1, 4:5 (fit with bars, or fill by cropping)
- Export to MP4, MOV, MKV, WebM, GIF, MP3 or WAV with full control over codec, resolution, frame rate and quality, from lossless to tiny
- **Keep original video quality** (smart cut): frame-exact cuts that copy your footage untouched and rebuild only the frames around each cut
- Save and reopen projects (`.qcut`); the last edit is autosaved

Your original files are never changed.

## Develop

```bash
npm install
npm start
```

`npm run dist` builds the installer into `dist\`. `npm run release` builds and publishes a GitHub release (raise `version` in `package.json` first, and commit).

Video work is done by [FFmpeg](https://ffmpeg.org) (bundled via `ffmpeg-static` / `ffprobe-static`).
