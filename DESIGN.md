---
name: Quickcut
description: A one-screen video editor in a calibrated grading-suite room, where the footage is the only colour on screen.
colors:
  ink-black: "#141414"
  chrome-grey: "#1b1b1b"
  panel-grey: "#202020"
  raised-grey: "#292929"
  hover-grey: "#333333"
  track-well: "#171717"
  viewer-black: "#000000"
  hairline: "#ffffff10"
  hairline-strong: "#ffffff1d"
  text-primary: "#dedede"
  text-secondary: "#a3a3a3"
  text-tertiary: "#8c8c8c"
  playhead-orange: "#f0803c"
  playhead-orange-ink: "#1a0b03"
  export-orange: "#e6692c"
  export-orange-hover: "#f59a62"
  selection-white: "#f2f2f2"
  slate-video: "#4f6f93"
  teal-sound: "#3e8270"
  wave-video: "#b5cbe4"
  wave-sound: "#99dac7"
  danger-red: "#ff6b6b"
  ok-green: "#3ddc97"
  light-bg: "#e6e6e6"
  light-chrome: "#f3f3f3"
  light-panel: "#fafafa"
  light-raised: "#ffffff"
  light-hover: "#ebebeb"
  light-track-well: "#ececec"
  light-hairline: "#00000014"
  light-hairline-strong: "#00000026"
  light-text-primary: "#1c1c1c"
  light-text-secondary: "#4d4d4d"
  light-text-tertiary: "#686868"
  light-accent: "#b5470f"
  light-playhead: "#e0621f"
  light-export-orange-hover: "#f08a52"
  light-wave-sound: "#24594c"
  light-danger-red: "#c62828"
  light-ok-green: "#1e8a5a"
typography:
  display:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
  timecode:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.01em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  control:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.2
  number-small:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1
    fontFeature: "tnum"
rounded:
  clip: "3px"
  control: "4px"
  viewer: "7px"
  dialog: "10px"
  pill: "99px"
spacing:
  hair: "4px"
  tight: "6px"
  base: "8px"
  inset: "14px"
  dialog: "20px"
components:
  button:
    backgroundColor: "{colors.raised-grey}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "34px"
  button-hover:
    backgroundColor: "{colors.hover-grey}"
  button-primary:
    backgroundColor: "{colors.export-orange}"
    textColor: "{colors.playhead-orange-ink}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "34px"
  button-primary-hover:
    backgroundColor: "{colors.export-orange-hover}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "30px"
  button-quiet-hover:
    backgroundColor: "{colors.raised-grey}"
    textColor: "{colors.text-primary}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.control}"
    size: "34px"
  segment:
    backgroundColor: "{colors.raised-grey}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "34px"
  segment-selected:
    backgroundColor: "{colors.playhead-orange}"
    textColor: "{colors.playhead-orange-ink}"
  field:
    backgroundColor: "{colors.ink-black}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "34px"
  clip-label-video:
    backgroundColor: "{colors.slate-video}"
    textColor: "#ffffff"
    height: "20px"
    padding: "0 9px"
  clip-label-sound:
    backgroundColor: "{colors.teal-sound}"
    textColor: "#ffffff"
    height: "20px"
    padding: "0 9px"
  dialog:
    backgroundColor: "{colors.panel-grey}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.dialog}"
    width: "640px"
  tooltip:
    backgroundColor: "{colors.hover-grey}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "8px 11px"
---

# Design System: Quickcut

## Overview

**Creative North Star: "The Grading Suite"**

Quickcut is built like a colour-grading room: calibrated neutral greys on every surface so the footage is the only colour on screen. The chrome steps from near-black to slightly lighter greys, back to front, and never takes a hue of its own. Two muted clip colours tell video from sound at a glance. One orange marks the things that matter right now: where you are (the playhead), what you picked (pressed choices) and the one action that finishes the job (Export).

The room is flat. The user asked for no effects, so there are no shadows, gradients, glows, inner highlights or press animations. Buttons are flat fills with a hairline edge that change colour on hover. Overlays sit apart through a hairline border and a one-step lighter grey. Density is that of a desktop tool: 34px controls, 14px gutters, everything on one screen. Numbers and timecode use tabular figures so frame counts never jitter.

Light mode is the same system on light neutral greys. Every role keeps its job; only the values change.

**Key Characteristics:**
- Neutral greys only on chrome; colour belongs to the footage, the clips and the one orange.
- Strictly flat: hairlines and tonal steps do the separating, never shadows.
- Fixed one-screen layout: top bar, viewer, transport, clip bar, overview bar, ruler, video track, audio track.
- Segoe UI Variable throughout; the Display cut with tabular figures for every number.
- Frame-exact timecode in MM:SS:FF, set big in the transport.

## Colors

Calibrated neutral greys, two muted media colours and one orange, used sparingly.

### Primary
- **Playhead Orange** (#f0803c dark / #b5470f light accent, #e0621f light playhead): the playhead line and cap, the overview playhead, pressed segments and toggles, slider fill, the insert mark, focus rings, text selection, input focus borders. Text on it is near-black ink (#1a0b03) in dark mode and white in light mode.
- **Export Orange** (#e6692c, hover #f59a62 dark / #f08a52 light): the main action only (Export, Save, Choose files), the export progress bar and the brand mark. Always with near-black ink (#1a0b03).

### Secondary
- **Slate Video** (#4f6f93): video clips. Full strength on the clip's name band; mixed into the clip body (72% toward near-black in dark, 74% toward white in light); its pale wave tint (#b5cbe4) draws the clip's sound.
- **Teal Sound** (#3e8270): sound clips, same treatment. Wave tint #99dac7 dark, #24594c light.

### Neutral
- **Ink Black** (#141414 / light #e6e6e6): app background, field wells, the overview bar.
- **Chrome Grey** (#1b1b1b / light #f3f3f3): top bar, timeline panel, ruler, dialog footer.
- **Panel Grey** (#202020 / light #fafafa): dialog body, the shape picker, the drop overlay card.
- **Raised Grey** (#292929 / light #ffffff): resting buttons, segments, the play button, kbd keys.
- **Hover Grey** (#333333 / light #ebebeb): button hover, tooltips, toasts, drag readouts.
- **Track Well** (#171717 / light #ececec): behind the tracks.
- **Viewer Black** (#000000): the viewer in both modes; footage is judged against true black.
- **Hairline** (#ffffff10 / light #00000014) and **Hairline Strong** (#ffffff1d / light #00000026): every divider, control edge and overlay border.
- **Text** primary #dedede, secondary #a3a3a3, tertiary #8c8c8c (light #1c1c1c, #4d4d4d, #686868).
- **Selection White** (#f2f2f2 / light #1c1c1c): the selected clip's outline and handles.
- **Status**: danger #ff6b6b (light #c62828) for invalid fields and error toasts; ok #3ddc97 (light #1e8a5a) for the done tick.

### Named Rules
**The Footage-Only Colour Rule.** Chrome surfaces are neutral grey with no hue. If a surface is not footage, a clip, the playhead or the main action, it is grey.

**The One Orange Rule.** Orange means "now, chosen, or finish": playhead, pressed choices, focus, the main action. Never use it for decoration, headings or secondary buttons.

**The Selection Is Neutral Rule.** A selected clip is outlined in Selection White (black in light mode), not orange. This keeps orange for the playhead, which often crosses the selected clip.

## Typography

**Display Font:** Segoe UI Variable Display (with Segoe UI, system-ui)
**Body Font:** Segoe UI Variable Text (with Segoe UI, system-ui)

**Character:** The native Windows family, used in its two optical cuts: Text for labels and controls, Display for titles and every number. Calm and familiar, so the footage carries the attention.

### Hierarchy
- **Display** (600, 44px, 1, tabular): the export progress percentage only.
- **Timecode** (600, 26px, 1, 0.01em, tabular): the current-time readout in the transport. Total time sits beside it at 16px/500 in tertiary text. Each digit sits in a fixed 0.58em cell so it never shifts.
- **Headline** (600, 22px, 1.2, -0.01em): the empty-viewer prompt.
- **Title** (600, 18px, -0.01em): dialog titles. Section heads inside the app are 13px/600.
- **Body** (400, 14px, 1.4): base UI text. Buttons are 600.
- **Control** (600, 13px): small buttons, segments, selects, toggles.
- **Label** (600, 12px): field and group labels, in secondary text, sentence case.
- **Number small** (500, 11.5px, tabular): ruler labels; clip durations use the same Display cut at 11.5px/600.

### Named Rules
**The Tabular Numbers Rule.** Every number that changes (timecode, durations, sizes, percentages, trim fields) is set in Segoe UI Variable Display with tabular figures.

**The Sentence Case Rule.** Labels are short sentence-case words. No uppercase tracking, no labels above headings.

## Layout

A fixed, one-screen desktop grid of four rows: a 52px top bar, the stage (viewer plus transport) taking the remaining space, a 7px splitter, and the timeline (320px by default, resizable by dragging the splitter, double-click to reset). Inside the timeline, top to bottom: the clip bar (min 52px, shows the selected clip's controls or the edit summary), the overview bar (26px, the whole edit with the visible window), the ruler (28px), the video track (1.5 parts, min 84px) and the audio track (1 part, min 64px). This order is fixed; new features fit into it rather than adding panels.

The transport is a three-column grid: frame-step and play on the left, timecode centred, shape tools on the right. The standard gutter is 14px around the viewer, transport and overview; the dialog uses 20px. Controls group with 4 to 8px gaps. A faint vertical time grid on the tracks follows the ruler's major ticks.

## Elevation & Depth

None. The system is flat by the user's explicit request. Depth is shown by tonal steps (ink black, chrome, panel, raised, hover grey) and hairline borders. Floating things (dialog, tooltips, toasts, drag readouts, the drop overlay) use a lighter grey and a Hairline Strong border; the dialog also dims the app behind it with a black scrim (#000000a6). Translucent black scrims are allowed only over footage: the fade wedges on clips, the viewer note and the mute badge.

### Named Rules
**The No Effects Rule.** No box-shadow, text-shadow, glow, decorative gradient, inner highlight, bevel or press animation anywhere. Buttons are a flat fill, a hairline edge and a colour change on hover. Hard-stop fills that carry data are not decoration and are allowed: the slider's filled track and the track time grid.

## Shapes

Small, even corners. Clips are 3px, controls and fields 4px, the viewer 7px, the export dialog 10px. Round shapes are reserved for a few things: the 42px play button and the slider thumb are circles; the update notice and the viewer note are pills (99px). Edges are 1px hairlines everywhere; dashed 1.5px hairlines mark empty drop targets on the tracks, and a 2px dashed orange border marks the full-window drop overlay. The playhead cap is a small pentagon pointer.

## Components

### Buttons
Flat and quiet; only the main action is orange.
- **Shape:** gentle corners (4px), 34px tall, 14px side padding, 8px icon gap, 600 weight.
- **Default:** Raised Grey fill, Hairline Strong edge, primary text. Hover moves one step lighter (Hover Grey).
- **Primary:** Export Orange fill and edge with near-black ink; hover moves to the lighter orange. One per view.
- **Quiet:** no fill, no edge, secondary text; hover gives a Raised Grey fill and primary text. Used for Split, Remove, Clip, Fit (30px small size, 13px).
- **Icon button:** 34px square (28px small), transparent, secondary-text icon; hover Raised Grey fill. The play button is a 42px circle with Raised Grey fill and hairline edge.
- **Focus:** 2px orange outline, 2px offset. **Disabled:** 40% opacity.
- **Motion:** colour transitions only, 120 to 150ms. Nothing moves or scales.

### Segments and toggles
- **Style:** a row of 34px buttons with Raised Grey fill, Hairline Strong edge, secondary text, 6px gaps.
- **Selected:** Playhead Orange fill and edge with orange ink. Toggles (Fill) are 30px, transparent until pressed.

### Inputs / Fields
- **Style:** 34px (30px in the clip bar), Ink Black well, Hairline Strong edge, 4px corners. Trim fields use tabular 14px/600 Display numbers.
- **Focus:** the edge turns orange; no glow.
- **Error:** the edge turns danger red.
- **Labels:** 12px/600 secondary text above the field.

### Sliders
4px track, orange fill up to the value then Hairline Strong; 14px round thumb. Focus puts the orange ring on the thumb.

### Export dialog
640px wide, Panel Grey, 10px corners, Hairline Strong border, no shadow, black scrim behind. Header 18px title; body in 18px-gapped groups with segment rows and a three-column grid of selects under "More options"; footer on Chrome Grey with a hairline top, the estimated size in 17px Display figures, then Cancel and the orange Save.

### Tooltips, toasts and keys
Hover Grey fill, Hairline Strong border, 4px corners, 12.5 to 13px text. Toasts carry a green tick or turn their border red on error. Keyboard keys are small Raised Grey chips with a hairline edge.

### Timeline clip (signature)
A 3px-cornered block with a full-strength 20px name band (white 11.5px/600 name, tabular duration at the right), the body tinted from the clip colour, thumbnails for video and a masked waveform in the clip's pale tint. Edges are the clip colour 30% toward black. Trim handles (12px) fade in on hover. Selected: a 1.5px Selection White outline and solid white handles. Fades are drawn as dark triangular wedges at the ends.

### Playhead
A 2px orange line through ruler and tracks with a pentagon cap you can drag; a matching 2px line on the overview bar. It is the strongest colour in the timeline by design.

## Do's and Don'ts

### Do:
- **Do** keep every chrome surface on the neutral grey steps (#141414, #1b1b1b, #202020, #292929, #333333 in dark).
- **Do** keep orange for the playhead, pressed choices, focus and the single main action.
- **Do** separate overlays with a Hairline Strong border and a lighter grey step.
- **Do** set every changing number in Segoe UI Variable Display with tabular figures; timecode is MM:SS:FF.
- **Do** colour video clips slate (#4f6f93) and sound clips teal (#3e8270), and nothing else in those hues.
- **Do** keep the layout order: top bar, viewer, transport, clip bar, overview bar, ruler, video track, audio track, with a resizable timeline.
- **Do** define every new colour as a token in both the dark and the light set.

### Don't:
- **Don't** use box-shadows, glows, decorative gradients, inner highlights, bevels or press animations. The user asked for no effects.
- **Don't** use saturated blue chrome or tinted greys; the room is neutral so footage reads true.
- **Don't** use orange for decoration, headings, secondary buttons or the selected-clip outline.
- **Don't** bring back a condensed display face; the user had it removed.
- **Don't** add panels, sidebars or nested menus; every core action stays on the one screen.
