# Work desktop film: runbook

Step by step for the homepage film. [work-demo.md](work-demo.md) explains why each
step exists. The scripts are in [`scripts/work-demo/`](../scripts/work-demo/).

## Film folder

Copy `scripts/work-demo/` (with its `demo/` project: the Lisbon offsite plan,
team and budget) into a film folder outside the repository. The scripts write
`raw-<take>/` frames, `markers-<take>.jsonl`, `pointer-<take>.jsonl`,
`edit.json` and the renders next to themselves. A take at full rate runs to
several GB at 2560x1600; the agent's waits are kept sparse. Each scene is one
`node scenes.mjs <scene>` (`seed`, `prep`, `open`, `belem`, `light`,
`workflow`, `app`, `use`), so a failing scene can be rehearsed alone, and
`node poke.mjs '<js>'` (or `node poke.mjs <file.js>`) runs a one-off against the
window with the same helpers. Generated apps run in their own frame target;
`node frame.mjs '<js>'` evaluates an expression there.

`render.py` and `make-edit.py` need Pillow (`python3 -m venv .venv &&
.venv/bin/pip install pillow`) and `ffmpeg`. Probe scripts that open the
desktop's PGlite must run from inside `apps/desktop/` (bun installs the newest
PGlite for a script elsewhere): copy a database directory to the scratchpad
first and query the copy.

## Environment, once per session

1. `caffeinate -dims &` so the Mac never sleeps mid-take.
2. `CATAMORPHIC_DEV_INSTANCE=work-film bun run dev:desktop` from the
   repository: a dedicated profile under `~/.catamorphic/dev/work-film`. Export
   `CDP_PORT` from the `CDP:` line it prints. `reset.sh` writes the profile
   theme under `$DESKTOP_DATA` (default
   `~/.catamorphic/dev/work-film/desktop`); export it for another instance.
3. Start the local registry: `sh infra/local-registry/publish.sh` (verdaccio on
   every interface, the user-project packages published). `new-project.sh`
   writes the Mac's LAN address (`ipconfig getifaddr en0`) into each demo
   project's `.work/bunfig.toml`.
4. Choose an agent: "Use your Claude Code setup". Set its instructions in the
   agent settings (see work-demo.md, The set) and the profile's name.
5. Sidebar: in the profile's `workspace.js`, `hideEmpty: true` on bookmarks
   and `itemOverrides` hiding `.work` and `.claude` in Files.
6. Lock out the person's connectors: `node lockdown.mjs` writes
   `demo/.claude/settings.json`, denying every claude.ai connector and user MCP
   server in `~/.claude.json` and turning the user's plugins off. Never commit
   the generated file. Check it once in a scratch project: ask the agent to run
   tool search for each connector name and call nothing; every search must come
   back empty. Run it again when the person connects something new.

Framing is part of `prep`, which every take runs: it reads the display's pixel
ratio and sizes the window for a 1280x800 layout (Retina: a 1280x800 window,
captured at 2560x1600; 1x: 1680x1050 with `devWindow("zoom", 1.3125)`,
captured at 1680x1050). Its last line prints `w`, `h` and `dpr`; check them.

## Take

1. `./reset.sh lisbon-<n>`: unlinks the last demo project, creates a new one
   from `demo/`, switches the window to it, adds the "Lisbon guide" bookmark,
   sets the profile back to dark, seeds three real chats, closes their bubbles,
   clears the palette history and prepares the opening (only `Plan.md`,
   pointer parked).
2. `./take.sh <name>` records and runs `open`, `belem`, `light`, `workflow`,
   `app`, `use`. The agent takes about a minute for the plan and two to six for
   the app. `use` stops the take if the app shows an error or never shows
   Friday.
3. Look at the result before editing: the guide on Belém and three stops in
   Friday's plan, the window light, the workflow's graph, the app loaded with
   the forecast and a stop joined. Read failed app calls from a database copy
   (`workflow_runs.error`). Retake rather than splice when any of these fails.

## Edit, render, install

1. `.venv/bin/python make-edit.py <take>` writes `edit.json` (segments, the
   dissolves at the time cuts, a short final hold, the size of the take's
   frames) and `work-desktop-film.vtt`. It stops on a missing marker; read
   `markers-<take>.jsonl` to see where the take went wrong.
2. `.venv/bin/python render.py --stills 1` writes a frame a second to
   `stills/`; look at both sides of every cut and at the pointer.
3. `.venv/bin/python render.py` renders `work-desktop-film.mp4` (the take's
   size, 60 fps, H.264, no audio) and `work-desktop-poster.jpg` (the last
   frame). Check with `ffprobe` and `ffmpeg -v error -i work-desktop-film.mp4 -f null -`.
4. `./install-site.sh <website checkout>` copies the three files into
   `site/assets/`, sets every `?v=` to the first 8 characters of the MP4's md5,
   sets the video's `width`/`height`, and runs the site checks. Update the
   website README's "Desktop film" section. Commit and publish only with the
   person's authorization.
