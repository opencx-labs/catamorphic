# Work desktop film: runbook

Step by step for the homepage film. [work-demo.md](work-demo.md) explains why each
step exists. The scripts are in [`scripts/work-demo/`](../scripts/work-demo/).

## Film folder

Copy `scripts/work-demo/` into a film folder outside the repository. The scripts
write `raw/` frames, `start.json`, `markers.jsonl`, `edit.json` and the renders
next to themselves, and raw frames run to gigabytes. Each scene is one
`node film.mjs <scene>` (`viewport`, `prep`, `browser`, `chat1`, `theme`, `chat2`,
`app`, `pickup`, `reset`), so a failing scene can be rehearsed alone.

Known script quirks:

- `render.py` loads `Inter.ttf` from the folder above the scripts even though it
  draws no text; put a copy there. It needs Pillow (a venv is fine) and `ffmpeg`.
- `delprobe.mjs` must run from inside the repository, never from the film folder:
  copy it into `apps/desktop/` (which depends on the desktop's PGlite version),
  run it, and delete the copy. Outside a project bun installs the newest PGlite.
- `delprobe.mjs` keeps the five seeded chats of the current demo project by
  title; edit its `keep` list for a different project.

## Environment, once per session

1. `caffeinate -dims &` so the Mac never sleeps mid-take.
2. `bun run dev:desktop` from the repository. Export `CDP_PORT` from the `CDP:`
   line it prints, and note its `Desktop data:` directory.
3. Start the local registry from `infra/local-registry` with
   `bunx --bun verdaccio --config config.yaml --listen http://0.0.0.0:4873`.
   Point the demo project's `.catamorphic/bunfig.toml` at the Mac's current LAN
   address (`ipconfig getifaddr en0`) and commit that file in the demo project.
4. Sign Claude Code in on the dev desktop (`agentAuthHealth` reports `ok`), set the
   profile theme to Work Dark, and install the work bookmark set.

## Reset the set

1. Stop this worktree's dev runner (Ctrl+C in its terminal). Do not `pkill` by
   pattern: other worktrees may be running their own.
2. `DESKTOP_DB=<Desktop data>/data/db PROJECT_ID=<id> bun delprobe.mjs` (from
   `apps/desktop/`, see above) deletes every chat in the project except the
   seeded ones and lists app rows. Delete app rows too; no app may be listed yet.
3. Demo project: `git reset --hard <base>`, then remove
   `.catamorphic/{node_modules,apps,workflows,contracts,scripts,package.json,bun.lock,personal,app-data}`
   so only `bunfig.toml`, `project.json` and `skills/` remain.
4. Profile: delete `<Desktop data>/profiles/<profile id>/sidebar-projects/<project id>.js`
   and `settings-projects/<project id>.json` (the agent's layers from the last take).
5. Start the desktop, export the new `CDP_PORT`, and run `node film.mjs prep`: dock
   in the window, app approvals cleared, tabs closed, `Launch plan.md` opened from
   the Files section and the section folded, a stray New Tab closed, the editor
   focused at its heading, pointer parked.
6. Run `node close-bubbles.mjs` if the dock shows bubbles from deleted chats.
7. Screenshot (`node cdp.mjs shot open.png`) and compare with the previous take's
   opening frame: bookmark order, tabs, caret, no tooltips.

## Record

- `./take.sh` sets a 1280x800 viewport, records, and runs `browser`, `chat1`,
  `theme`, `chat2`, `app`. Two real agent turns and a build take seven to eight
  minutes. Watch markers arrive in `markers.jsonl`. If `agent working` times out,
  stop, reset, and fix the cause before another take.
- Then rename the take: `raw` to `raw-main`, `markers.jsonl` to `markers-main.jsonl`.
- Warm the app for the pickup: click `[data-testid=app-access-allow]` by JS, wait
  for the iframe, read its text through the frame target to confirm data renders,
  then `catamorphicDesktop.setPrefs({ appAccessApprovals: [] })` so the card returns.
- `./take-pickup.sh` records about 17 seconds: chat to its bubble, consent card,
  allow, the app, then Cmd+Shift+click on the bubble to open the chat beside it.
  Rename to `raw-pickup` and `markers-pickup.jsonl`.
- To re-take only the opening, `./take-browser.sh` records the browser scene into
  `raw-browser`; add segments with `source='browser'` in `make-edit.py`. The window
  must match the main take's cut frame exactly (bookmark order, caret, no tooltips).

## Edit, render, install

1. `python3 make-edit.py` turns markers into `edit.json`.
2. `python3 make-vtt.py` writes the WebVTT track from the segment descriptions.
3. `python3 render.py` renders `work-desktop-film.mp4` (1920x1200, 60 fps, LANCZOS
   from 1280x800, no captions) and `work-desktop-poster.jpg`.
   `python3 render.py --stills` writes a review frame every 5 seconds.
4. Check the cuts: extract frames on both sides of every segment boundary and look
   at them. Compare a splice point pixel for pixel.
5. Install in the work.software repository: copy the MP4, VTT and poster into
   `site/assets/`, set the `?v=` hash on every reference to the first 8 characters
   of the MP4's md5, run `python3 scripts/check_site.py`. Commit and publish only
   with the user's authorization.
