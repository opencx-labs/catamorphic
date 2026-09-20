# Work desktop film: the take, step by step

The scripts live in [`scripts/work-demo/`](../scripts/work-demo/) (a snapshot
of the working copy in `~/Desktop/work-product-film/activity-demo/`, which
also holds the raw frames). Run them from a directory that has `raw-*` frame
folders beside them; every scene is one `node film.mjs <scene>` so a failing
scene can be rehearsed alone. Read `work-demo.md` first: it holds the lessons
each step below exists for.

## Environment, once per session

1. `caffeinate -dims &` so the Mac never sleeps mid-take.
2. The dev desktop, started from the repo with `bun run dev:desktop`. Its
   debugging port is the `DevTools listening on ws://127.0.0.1:<port>` line
   in the log; export it as `CDP_PORT`. With a debugging port the desktop
   keeps rendering while another window covers it (`main/index.ts`), so
   never steal focus from the person to film.
3. The local package registry (`infra/local-registry`): `bunx --bun verdaccio
   --config config.yaml --listen http://0.0.0.0:4873`, and the demo project's
   `.catamorphic/bunfig.toml` pointing at the Mac's current LAN address
   (`ipconfig getifaddr en0`); commit that file in the demo project.
4. Claude Code signed in on the dev desktop (`agentAuthHealth` reports `ok`),
   the profile theme on Work Dark, the bookmarks bar a work set.

## Reset the set (app stopped for the database steps)

1. Stop the desktop (`pkill -f scripts/dev.ts`, the Electron process).
2. `DESKTOP_DB=<data dir>/desktop/data/db PROJECT_ID=<id> bun delprobe.mjs`:
   deletes every chat in the project except the seeded five and reports app
   rows (delete those too if any exist; the app must not be listed yet).
3. Demo project: `git reset --hard <base>`; remove `.catamorphic/{node_modules,
   apps,workflows,contracts,scripts,package.json,bun.lock,personal,app-data}`
   so only `bunfig.toml`, `project.json` and `skills/` remain.
4. Profile: delete `profiles/<id>/sidebar-projects/<project>.js` and
   `settings-projects/<project>.json` (the agent's layers from the last take).
5. Start the desktop, export the new `CDP_PORT`, then
   `node film.mjs prep`: dock in the window, answers forgotten, tabs closed,
   Launch plan.md opened from the Files section and the section folded, a
   stray New Tab closed, the editor focused at its heading, pointer parked.
6. `node close-bubbles.mjs` if the dock pill shows bubbles: deleted chats
   leave their bubbles, and each mounts a status trigger.
7. Screenshot and compare with the previous take's opening frame: bookmark
   order, tabs, caret, no tooltips.

## Record

- `./take.sh`: viewport 1280x800, screencast at the display rate, then
  `browser`, `chat1`, `theme`, `chat2`, `app`. Two real agent turns and a
  build; expect seven to eight minutes. Markers land in `markers.jsonl`,
  relative to `start.json`. Watch them arrive; if `agent working` times out,
  stop everything, reset, and fix the cause before trying again.
- The `app` scene cannot allow the app (the floating chat covers the card).
  After the take: allow once by JS (`[data-testid=app-access-allow]`), wait
  for the iframe, read its text through the frame target to confirm data
  renders, then `catamorphicDesktop.setPrefs({ appAccessApprovals: [] })`
  so the card is back.
- `./take-pickup.sh`: chat to its bubble, card, allow, app, ⌘⇧-click the
  bubble so the chat opens beside the app. Seventeen seconds.
- Keep takes: `raw-main` + `markers-main.jsonl`, `raw-pickup` +
  `markers-pickup.jsonl`. A single scene can be re-taken and spliced
  (`take-browser.sh`, a third source in `make-edit.py`) when the window
  matches the main take's frame at the cut exactly.

## Edit, render, install

1. `python3 make-edit.py`: markers to `edit.json`. Agent waits are never fast
   forwarded: `working()` shows the send settle, cuts to the assistant
   working, holds ~4 s, then the landing.
2. `python3 make-vtt.py` (visual descriptions, kept with the film).
3. `render.py` needs Pillow (a venv is fine): 1920x1200 at 60 fps, LANCZOS
   from the 1280x800 frames, no captions or labels.
4. Check the cuts: extract frames either side of every segment boundary and
   look at them; check the splice point pixel for pixel when a scene was
   re-taken.
5. Install: copy `work-desktop-film.mp4`, `.vtt` and the poster into the
   website's `site/assets/`, bump the `?v=` hash on every reference (first 8
   of the mp4's md5), run `scripts/check_site.py`, commit.
