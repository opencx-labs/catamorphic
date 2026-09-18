---
name: announcement-video
description: Create or refine short product announcement, changelog, launch, and What's New videos with the real desktop app UI. Use for requests for a Linear-style product film, animated feature demo, widget opening or streaming footage, annotation walkthrough, cinematic UI motion, or edits to an existing announcement cut. Use for Work and Catamorphic films that need readable pacing, faithful product footage, and a polished result.
---

# Product announcement videos

Make the product understandable through motion. Start from the actual interface and a clear action sequence; polish that sequence into a short film.

For still images, capture the real app and apply the same product-fidelity and safe-data checks.

## Carry forward the brief

Read the current conversation and existing project before asking questions. Preserve accepted decisions across revisions. A user saying “faster” does not erase an earlier request for a readable opening. A user changing one caption does not ask for a new visual direction.

When the brief is incomplete, use these defaults and state them briefly while starting work:

| Decision | Default |
| --- | --- |
| Purpose | Product website hero or short feature announcement |
| Length | 10 to 25 seconds; about 24 seconds for a multi-step demo |
| Sound | Silent, with no music or voiceover |
| Look | The accepted product palette, neutral surroundings, clear product separation |
| Motion | Continuous product-led camera moves and connected actions |
| Captions | Bottom-left, short, medium-gray, no backing panel |
| Deliverables | Editable source, local preview, and a playable MP4 |

For a brief-only or storyboard-only request, deliver that planning artifact and leave capture, rendering, and validation marked pending.

Explicit user instructions override these defaults. Resolve ordinary choices yourself; ask only for missing inputs that would change the result and cannot be found in the repository or conversation. Avoid repeated approval rounds for reversible drafts.

Use [references/brief-template.md](references/brief-template.md) to record a compact brief, shot timings, source evidence, and accepted corrections in the film project. Read [references/product-film-example.md](references/product-film-example.md) for the reusable composition example and its review lessons. Treat that example as historical evidence, not a current feature or version specification.

## 1. Verify the product and reference

- Read the target feature's source, configuration, release changes, and existing docs. For desktop work, read `apps/desktop/AGENTS.md`, the current design language, and the relevant UI implementation. Verify current availability before writing claims.
- Launch the real UI with safe demo data. Prefer real components with controlled data when a complete backend is unavailable. Explain the preview setup; never present invented UI or a simulated backend response as a verified production behavior.
- Capture the actual states needed for the film: closed launcher, open widget, floating layout, streaming response, annotation tools, and attachment confirmation when relevant. Choose the states that prove this release's benefit.
- Inspect referenced videos when supplied. Record what to borrow: composition, depth, pacing, camera path, transitions, and pauses. If a reference cannot be opened, say so and work from the accessible evidence; do not claim to have watched it.
- Locate the official logo in the brand or website repository (for Work, inspect its website; for Catamorphic, use `site/assets/logo.svg`). Use the exact asset and correct light/dark variant. Do not redraw the wordmark from memory.
- Keep tokens, private URLs, customer identities, and sensitive dashboard content out of captures. Use an approved demo state, not blur as a substitute for choosing safe source material.

## 2. Design a readable action sequence

Show one main benefit and two or three supporting actions. Convert internal changes into visible outcomes; leave infrastructure, model names, and library choices out of the film's copy.

A useful 24-second structure is:

| Time | Purpose |
| --- | --- |
| 0 to 3 s | Establish the real host page and product; give the viewer time to orient |
| 3 to 8 s | Open the launcher and transition into the floating experience |
| 8 to 13 s | Show a response streaming and hold long enough to understand it |
| 13 to 20 s | Demonstrate the distinctive interaction, such as draw → note → attach |
| 20 to 24 s | Resolve the motion and hold a short benefit-led outro |

Adapt the sequence to the feature. Faster energy comes from shorter travel and decisive transitions, while the meaningful UI states still get time to read. Keep the first three seconds calm enough to understand the product. Do not cram the complete changelog into the film.

For annotations, show the mark being drawn, the selected target, the note when useful, and the resulting screenshot attachment. A still image of annotation controls does not demonstrate the interaction. Keep the drawing toolbar clear of the assistant widget throughout the shot.

## 3. Build depth through composition

Choose a toolchain appropriate to the source project: GSAP/Hyperframes for a seekable DOM timeline, Remotion for frame-based compositions, or an existing equivalent. Reuse a working renderer before adding another. Inspect unfamiliar packages and scripts before running them; do not execute an upstream setup command just because a reference recommends it.

- Use a deterministic timeline that can seek to an exact time or frame. Wait for fonts and assets before rendering. Drive simulated streaming from the timeline so every render shows the same sequence.
- Move between related product states in one spatial composition. Avoid a succession of unrelated title cards or screenshots that reads as slides.
- Use restrained perspective, parallax, occlusion, and soft shadows to separate host page, widget, and annotation. “More depth” means a clearer relationship between these layers, not extra spins, extreme tilt, blur, or flashes.
- Keep the product sharper and more distinct than its surroundings. For an all-light film, separate white surfaces with tonal differences and shadows rather than switching to a dark background halfway through.
- Crop captures to their meaningful UI bounds. Remove accidental white screenshot gutters, browser chrome, and redundant framing while preserving actual product borders and controls.
- Keep text readable during camera movement. Slow or settle the camera for important messages; avoid transforming live UI so far that labels become distorted.
- Inspect collision-prone frames: opening widget, floating transition, annotation toolbar, selected target, attachment, and exit. Put captions in a separate safe area that stays clear across the entire camera move.

## 4. Finish copy and captions

Write brief, concrete benefits in the product's voice. Follow `docs/DESIGN-LANGUAGE.md`. Use the user's accepted outro verbatim. Do not reuse a feature-specific outro for unrelated launches.

Keep captions bottom-left by default. At 1920×1080, approximately 34 px, weight 450 to 500, and a medium gray near `#555d67` are a starting point, not a universal specification. Check against the actual shot and the smaller embedded player. Improve readability through placement and surrounding composition as well as type size. Avoid oversized black captions, pills, background panels, or centering unless requested.

Do not add an in-film “What's new” label by default; the containing announcement already supplies that context. This does not remove the dashboard's What's New heading.

## 5. Preview, revise, and verify

Render a playable draft early. Show it in the app or browser with useful seeking and replay controls. Review the full motion as well as representative frames: isolated screenshots cannot reveal rushed timing or collisions between frames.

Before delivery:

- Watch the opening, each key action, transitions, and the complete outro at normal speed.
- Check the film at full resolution and at the intended modal/card size. Confirm captions and important UI remain readable.
- Check every captured state against the real UI, especially opening, floating, streaming, drawing, and attachment behavior. Clearly identify illustrative timing or controlled demo data.
- Inspect boundaries around screenshots, annotation toolbar/widget overlap, safe areas, contrast, clipping, font loading, and logo proportions.
- Inspect export metadata for dimensions, frame rate, duration, and audio tracks. For the default deliverable, use a broadly playable H.264 MP4 at 1920×1080, 30 fps, yuv420p, with fast-start playback and no audio track. Follow explicitly requested formats instead.
- Decode the full export to catch corrupt or missing frames. Report only checks actually run.

For a narrow correction, change that aspect, preserve accepted work, then inspect the affected frames and adjacent transitions. Keep a short revision record so rejected treatments do not return. The final handoff should point to the approved video, editable source, and preview, with any material limitations.

## 6. Integrate where requested

For a website hero, use a sharp poster from the actual footage, an accessible play/pause control, inline muted playback, and a static fallback for reduced motion. Keep the initial page load light. Clearly identify prepared demo data and edited timing without cluttering the film itself.

For a release announcement, keep related setup details in the same entry and place each action beside the feature it supports. Confirm real destinations and keep external links external.

Keep temporary render projects and raw captures out of the product PR unless requested. Commit intended media, product changes, and the reusable skill. Preserve editable source and a capture manifest in a local film project and link them in the handoff. Follow existing authorization for worktrees, commits, and PR updates; do not merge merely to finish a video.
