---
name: announcement-video
description: Use when planning, capturing, editing, revising, or installing a Work or Catamorphic product film or product still from the real desktop app, such as the work.software homepage film, a launch demo, or a feature walkthrough. Covers the brief, the scripted CDP capture of the dev desktop, the edit and render, and installing the film on the website.
---

# Product films

Show useful work getting done in the real desktop app. Give the viewer a goal,
show the actions that advance it, and end on a visible result. Work is the product
brand; Catamorphic is the embeddable framework. Follow
[docs/DESIGN-LANGUAGE.md](../../../docs/DESIGN-LANGUAGE.md) for voice.

Stills follow the same rules for real UI and safe data.

For a Work desktop film, read [references/work-demo.md](references/work-demo.md)
before storyboarding, then follow [references/work-demo-runbook.md](references/work-demo-runbook.md)
with the scripts in [scripts/work-demo/](scripts/work-demo/). Record the brief in
the film project with [references/brief-template.md](references/brief-template.md).
[references/product-film-example.md](references/product-film-example.md) has
review lessons for short single-feature films.

## Carry the brief forward

Read the conversation and the existing film project before asking anything.
Accepted decisions survive revisions: "faster" does not cancel an earlier request
for a readable opening, and a caption change is not a request for a new look.

Defaults when the brief is silent (say which you used):

| Decision | Default |
|---|---|
| Purpose | Homepage film or short feature announcement |
| Length | What the story needs: about 45 to 75 s for a multi-step story, shorter for one feature |
| Sound | Silent |
| Look | Default Work Dark theme, the real window filling the frame |
| Captions | None burned in; a WebVTT track describing what happens |
| Export | H.264 MP4, yuv420p, fast start, no audio; size and rate follow the capture (Work film: 1920x1200 at 60 fps from a 1280x800 window) |
| Deliverables | Editable source, a local preview, the MP4, a poster, the VTT |

Explicit user instructions override these. Decide ordinary choices yourself and
ask only for inputs that change the result and cannot be found. For a brief or
storyboard request, deliver that and mark capture, render and checks as pending.

## 1. Verify the product first

- Read the feature's source, `apps/desktop/AGENTS.md` and the relevant contract
  before writing any claim. Check that the feature exists in the build you film.
- Film the real app with a prepared, non-sensitive demo project. When the film
  shows an agent answering or building, send the real messages and capture the
  real result. An unsent draft, a test-harness echo or an injected transcript is
  not a demo. A simulated response needs an explicitly illustrative brief and a
  clear label.
- Rehearse the whole take once with the same data, agents and build services
  before recording. Failures only a full run reveals cost a take each; see the
  build-path traps in [work-demo.md](references/work-demo.md#build-path-traps).
- Use the official logo, never a redraw: Work's are `site/assets/logo-dark.svg`
  and `logo-light.svg` in the website repository (opencx-labs/work-software);
  Catamorphic's is [site/assets/logo.svg](../../../site/assets/logo.svg) here.
- If a reference video is supplied, note what to borrow (pacing, camera path,
  pauses). If you cannot open it, say so.
- Keep tokens, private URLs, customer names and personal bookmarks out of frame by
  choosing safe material, not by blurring.

## 2. Design a readable sequence

- One main benefit, with each action following from the last. A layout change
  (expanding a chat, minimizing it, opening it beside a page) must serve the next
  action. Never cycle sizes to show off animation.
- Show outcomes, not infrastructure: no model names or library choices in the film.
- Hold the first meaningful frame long enough to orient (about 3 s).
- Type at a human pace and keep real transitions (palette, chat, sidebar, scroll)
  at normal speed. Agent and build waits may be cut or shortened; say so in the
  brief, and in the film when the user asks for a label.
- Do not cram a changelog into one film.

## 3. Composition

The current Work film is the window itself, full frame, no captions. When a brief
asks for a composed film instead (the window over a background, camera moves):

- Use a deterministic, seekable timeline built on timestamped real footage and an
  explicit cut list. Reuse a working renderer before adding a tool, and read any
  unfamiliar package or setup script before running it.
- Keep one spatial composition rather than a run of unrelated cards. Separate
  layers with restrained shadow and tone, not spins, blur or flashes.
- Crop to real UI bounds, keep text readable while the camera moves, and keep
  captions in a safe area clear of the whole motion path. If captions are used:
  short, bottom-left, medium gray, no backing panel.

## 4. Review and deliver

Render a playable draft early and review it at normal speed, not only as stills.
Before delivery:

- Watch the opening, every key action, each cut and the ending. Messages visibly
  send, useful answers arrive, and any generated app works when used.
- Check the film at full size and at the size the page embeds it.
- Look at frames on both sides of every cut; check for tooltips, hover cards,
  clipping and stray chrome.
- Inspect metadata (`ffprobe`: size, rate, duration, no audio) and decode the whole
  file (`ffmpeg -v error -i film.mp4 -f null -`). Report only checks you ran.

For a narrow correction, change only that aspect, then recheck the affected frames
and adjacent cuts. Keep a short revision log so rejected treatments do not return.

## 5. Install where requested

- **Website:** the work.software repository's `DESIGN.md` owns how the film plays
  (silent, looped, hover pause, poster for reduced motion). Replace
  `site/assets/work-desktop-film.mp4`, `.vtt` and `work-desktop-poster.jpg`, bump
  the `?v=` hash on every reference (first 8 characters of the MP4's md5), and run
  `python3 scripts/check_site.py`. Keep accepted page copy; do not add an
  explanatory video section or a demo disclaimer.
- **Release notes:** place each action beside the feature it supports and keep
  external links external.
- Keep raw captures and render scratch out of product PRs. Commit, push or publish
  only with the user's authorization, and never merge just to finish a film.
