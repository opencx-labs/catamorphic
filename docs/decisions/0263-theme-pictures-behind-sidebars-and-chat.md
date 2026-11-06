# 0263 — A theme can put a picture behind the sidebars and the chat

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

People personalize Work through `theme.json`: a preset, color tokens and font
stacks. They also ask for a picture behind their sidebars or chat, fading into
the surface so the controls stay readable. Colors alone can't do that, and the
theme has no other way to change how a surface looks.

## Decision

The theme gains an optional `backgrounds` object keyed by surface (`left`,
`right`, `chat`). Each entry names an https `image`, the `position` where it
stays visible (`top`, `center`, `bottom`), and `opacity`, `blur` and
`pixelate` within fixed ranges. It layers like fonts: a higher scope replaces a
surface's entry whole, and a new preset selection keeps it.

The renderer draws the picture on a canvas behind the surface's content, at
1/`pixelate` of the surface's size and scaled up without smoothing, then
blurs it and masks it with a gradient from `position` into the surface's own
color. The picture fades in once loaded.

Alternatives considered:

- **Arbitrary CSS in the theme.** It's the most flexible, but it breaks
  whenever markup changes and lets a shared project file restyle the app in
  ways nobody reviews. The theme stays data with validated ranges.
- **Local file paths.** The window's CSP allows only `self`, `data:` and https
  images. Reading files into data URLs means sizing and watching them, so it
  waits for a real need. https covers hosted pictures today.
- **A WebGL shader for pixelation.** Drawing on a canvas at reduced
  resolution looks the same for a static picture, costs one small draw per
  resize and needs no GPU context per surface.

## Consequences

- Theme files, Settings saves and project layers carry `backgrounds` through
  unchanged. Validation names the bad field when a value is out of range.
- Surfaces that draw a backdrop isolate a stacking context so the picture sits
  between their background and their content.
- Follow-ups: a Settings control, local images (data URLs read by main), and
  more surfaces (the content area, the tab strip) if asked for.
