# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Desktop app built with Electron; the UI is HTML/CSS, so web design rules apply. Windows first.)

## Stack

Electron desktop app with real ffmpeg bundled. Auto-updates through GitHub Releases, same pattern as the owner's Snag app (electron-builder NSIS installer + electron-updater).

## Users

The owner and their friends, plus anyone they share the installer with. People who need a quick edit, not an editing suite: drop a few clips in, cut the bad parts, join them, save. First-time use must be obvious without a tutorial.

## Product Purpose

A video editor simpler than Adobe Premiere. Drag in multiple clips, trim them, put them in order, merge them, and save one new clip. Success: a person who has never opened it gets from "files on my desktop" to "saved video" without help.

## Positioning

Premiere-grade output control with a one-screen workflow: one timeline, trim handles, order, export. Real ffmpeg means any common format opens and exports fast, including lossless.

## Capabilities and Constraints

- Import: drag and drop several clips at once (mp4, mov, mkv, webm, avi, and other ffmpeg-readable formats), or a file picker.
- Edit: trim each clip's in/out, reorder clips, split at the playhead, remove clips, preview the whole sequence.
- Export: user picks the container/format and the quality of everything (resolution, frame rate, video quality/bitrate, audio quality). A lossless / highest-quality path must exist, and so must heavy compression.
- Updates: friends install once and get updates automatically.
- Working name "Quickcut"; final name undecided.

## Brand Commitments

None yet. Name is a working name.

## Evidence on Hand

No users, reviews, or claims. Do not invent any.

## Product Principles

1. One screen. Every core action is visible; nothing hides in nested menus.
2. Fast by default. Lossless cuts when possible; preview is instant.
3. Full control on export, plain words for it ("Smaller file" ↔ "Best quality").
4. Never lose work: nothing touches the source files.
