# Work desktop film: story and lessons

What the Work homepage film shows, and the lessons behind each step of the
[runbook](work-demo-runbook.md). Read the current desktop contracts before
capture; this is the accepted direction for the homepage film, not a script
every announcement must follow.

## The current story

"Lisbon offsite": Sam plans a three-day team offsite with an open Friday
afternoon. The demo project holds `Plan.md` (days, times, a to-do list),
`Team.md` and `Budget.md`, plus a project bookmark to Wikivoyage's Lisbon
guide. Each beat is the next thing the plan needs, and together they show the
browser, tiles, the palette, an agent driving a page and editing a document,
customizing by asking, a workflow and an app (scenes in
`scripts/work-demo/scenes.mjs`):

1. **open**: hold on the plan; from the palette (Cmd+P, "lisbon", ⌘⇧↵ side)
   the guide opens beside it; scroll it once.
2. **belem**: a floating chat from the dock: "Open Belém in this guide and
   fill Friday afternoon with three things we can walk between." The agent
   navigates the guide in its tile and writes three timed stops into the open
   plan, ticking its to-do.
3. **light**: "Switch Work to light mode." The whole window turns light.
4. **workflow**: "Add a workflow to this project that checks Friday's forecast
   every morning and posts it here." It appears in the sidebar and opens in a
   tab; Sam opens the graph (schedule, forecast check, message to the chat).
5. **app** and **use**: "Make the team an app with the plan and Friday's
   forecast, where people can join activities." From the palette Sam opens it
   beside the workflow, picks a name, sees Friday's live forecast and joins a
   stop.

About 100 s; the asks take most of it. Each chat opens on the agent's last
answer for a moment, so the replies are part of the film. The guide
(Wikivoyage) and the forecast (Open-Meteo, no key) are real; the team, hotel
and plan are fictional.

Earlier stories, and why they were replaced: a sidebar section, a theme and an
app about your own chats (about the app itself); a meetup whose two to-dos an
agent finished (real work, but no browser, tiles, theme or workflow, which the
homepage must show).

## Principles that came from review

| Rejected | Instead |
| --- | --- |
| Chat text was an unsent draft | Send, show the answer, follow up with a result |
| Chats resized aimlessly | Each layout change serves the next action |
| Instant typing hid the palette animation | Type at human pace, hold on mode changes |
| A controls tour with no payoff | Use the generated app for a concrete action |
| Asks about the app itself (sidebar, theme, its own chats) | Every ask advances the person's own plan |
| A single task that left out the browser, tiles, theme and workflows | One goal whose next steps happen to need each of them |
| A random reference page (Wikipedia) | A page that belongs to the story (the city's travel guide) |
| 1x capture upscaled, soft text | Capture at the window's physical size (below) |
| Clicks with no visible pointer | Draw the pointer from the logged input |
| Palette rows showing `.work/personal/<id>/…` paths | Clear history after seeding; keep the project name out of seed titles |
| Setup copy on the website | Keep the demo caption and "About this film" section removed |
| A spliced result implied behavior the app lacks | Film only what the product does; a search mode searches, it does not navigate |

Do not imply page awareness the agent does not have: give it the context it needs.

## Capture and pacing

- Frame for the display the window is on (`prep` does it): on Retina a
  1280x800 window screencasts at 2560x1600; on a 1x display a 1680x1050 window
  zoomed by 1.3125 (`catamorphicDesktop.devWindow("zoom", 1.3125)`, dev builds
  only) lays out at 1280x800 and screencasts at 1680x1050. Device-metrics
  emulation does not help: the screencast still arrives at the window's size,
  and a `Page.captureScreenshot` loop at 2x manages about 16 fps. The person
  may plug a display in or out between takes; never splice takes of different
  sizes.
- Typing: about 40 to 80 ms per character with short word pauses. Never paste
  whole prompts or speed typing in the edit. Short asks keep the film short.
- Pointer: CDP input draws no cursor. `lib.mjs` logs every move and press to
  `pointer.jsonl`; `render.py` draws the macOS arrow with a faint press ring,
  hidden while typing. Moves glide on an eased, slightly curved path.
- **Never move the pointer over a page that is attaching or navigating.**
  Input over a webview mid-load is never acknowledged and the CDP call hangs
  (`cdp.mjs` times out after 20 s). Wait for the page to finish loading before
  hovering it, and while an agent may drive a tile, rest the pointer over the
  chat or another tile.
- Scroll like a hand: a flick is many 16 ms wheel ticks with an eased delta.
- Record a continuous screencast with timestamps. While the agent works, a
  `sparse.flag` keeps four frames a second; full rate resumes when the wait ends.
- Cuts only where time passes: the agent's work, a page's load and the app's
  first load, each bridged by a 0.3 to 0.45 s dissolve. Never fast-forward. A
  longer dissolve ghosts the sidebar's text as its sections change.

## The set

- A fresh project per take (`reset.sh`): `createProject` writes the seeds,
  `demo/` is copied in and committed, the previous project is unlinked with
  `deleteProject` (its chats and apps go with it), the bookmark is added, the
  profile theme is set back to dark (`profiles/<id>/theme.json`), three real
  seed turns run, then the palette history is cleared.
- **Lock out the person's own connectors first.** "Use your Claude Code setup"
  runs Claude Code on the person's login, with every claude.ai connector
  (Gmail, Calendar, Drive, Slack, HubSpot, ...), user MCP servers and plugins.
  A seed that said "draft a reminder email" created real Gmail drafts.
  `lockdown.mjs` writes the demo project's `.claude/settings.json`, denying each
  of them and turning user plugins off; verify in a scratch project that tool
  search finds none of them. `ENABLE_CLAUDEAI_MCP_SERVERS` does not help: turbo's
  strict environment drops it, and as a settings `env` it does not stop the
  servers. Keep seed prompts local and keep the project's name out of them.
- Sidebar: `hideEmpty` on bookmarks; hide `.work` and `.claude` in Files with
  `itemOverrides`. Rename the profile to the story's person.
- The agent's instructions (profile agent settings, not visible on screen):
  short plain replies, save without asking, tick to-dos as they finish and read
  the document back, and build the data an app needs into it (see below).
- Delete, never archive, earlier takes' chats when an app lists sessions.

## Agent and app variance

What took retakes, so check it in the rehearsal:

- Words choose where a workflow lives. "Tell me here if it might rain" made a
  chat-owned watcher with no graph to show; "Add a workflow to this project
  that…" made a project workflow that opens in a tab. A project workflow is
  not on until the person chooses Automatic, Publish and Enable for me, and
  the agent says so.
- App workflows run as the app: `documents.read` is refused and the
  deployment snapshot has no root files, while the agent's own test runs as
  itself and passes. Three of six builds failed until the instructions said so.
- Asked to open and check its app, the agent asks the person to click the tab:
  it opens in the background, and a background app tab does not load.
- Agents sometimes tick one to-do and report both.
- Generated UI varies: pick the palette row by its text, find a button by the
  row's text (names carry badges), clear search with Cmd+A through
  `commands: ["selectAll"]`, wait for real data (a guest's name, "Friday"),
  and scroll a row to the middle before pressing it.
- The open editor shows an agent's change when the turn settles (the project's
  git-changed broadcast), not mid-turn.

## Driving the desktop

- Pick the workspace page target (no `surface=`, not `chrome-extension:`).
- CDP key events go to whatever has focus. Click the visible control a person
  would use; it also reads better on film.
- The palette opens with Cmd+P (modifier 4); ⌘⇧↵ (modifiers 12) opens the
  highlighted row beside the current tab, which is how the film tiles.
- Tabs are `[data-tab-orientation] > [data-point-key]`; step rows carry
  `data-step-kind`; the dock's New chat is the lowest visible `New chat` button.
- Sidebar rows are found by text; click their `[data-tree-primary]` child.
- Read every `session-inspector-trigger`, not the first visible one.
- With a debugging port the desktop keeps rendering while covered, so a take
  survives the person using their Mac. Never steal focus with `osascript`.

## Build path traps

Each of these cost a take. Check them in the rehearsal.

- **Registry:** project workspaces install `@catamorphic/*` from the local
  verdaccio registry ([infra/local-registry](../../../../infra/local-registry/README.md)).
  Bump and publish changed packages or agents build against the old kit. Build
  sandboxes are microVMs where `localhost` is the VM, so the demo project's
  `.work/bunfig.toml` names the Mac's LAN address. The address changes with
  the network: compare it with `ipconfig getifaddr en0` before any take that builds.
- **Seeds:** seeded skills are written when a project is created. After changing
  them, refresh the demo project's `.work/skills` from `SEED_SKILLS`.
- **Database:** a dev database that predates a rewritten migration fails at runtime
  (the app list returned 500). Recover it into a clean database rather than
  resetting a profile you care about.
- **Sandbox runtime:** `bun run dev:desktop` passes the microsandbox SDK's bundled
  `msb` as `MSB_PATH` and sets `CATAMORPHIC_SANDBOX_HOST_NETWORK=1`. Any probe
  script must use the same versions: run it from inside the repository, because
  bun auto-installs the newest SDK for a script outside a project, and a newer
  runtime can migrate a shared database the desktop then refuses.
- **Reused sandboxes:** a project's build sandbox is created once
  (`project_sandboxes`). After changing sandbox network or runtime settings, forget
  the project's row and `msb remove` the sandbox.
- **Apps must build:** the building-apps seed ends with the host `build_app` call
  and an `app:<name>` link; an app that was only compiled locally shows "no
  successful build yet".
- **Electron binary:** a fresh worktree after an Electron bump can lack the
  binary (`Error: Electron uninstall`); run the electron package's `install.js`.
- **Sleep:** run `caffeinate -dims` for the whole session. A take recorded while
  the Mac slept produced 27 minutes of wall time, 235 frames and a dead app runtime.
