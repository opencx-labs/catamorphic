# Work desktop demo recipe

Read current desktop interaction contracts before capture. This sequence is the accepted direction for the Work website film, not a mandatory script for every feature announcement.

## One useful story

The viewer is exploring Work and wants to turn an idea into something usable.

1. Establish the browser inside Work, with enough sidebar visible to understand the workspace. Open the Work page through the palette. Show web mode deliberately and pause on its transition. Check its actual navigation contract: a search mode may issue a search rather than navigate directly to a URL. Never splice the result to imply behavior the product does not have.
2. Scroll a little to read the page. The scroll gives context for the question rather than filling time.
3. Use the palette to create a floating chat. Type a concise question about Work, send it, and show the useful answer. Include the actual page or project context the agent needs; do not imply automatic page awareness that was not verified.
4. Expand that same conversation with the current keyboard shortcut. At the time of this film, Cmd+Shift+M opens a floating chat as a tab. Verify it against the running app. Expansion creates room for the next task.
5. Send a follow-up asking for a small relevant app, such as a launch checklist based on the discussion. Show actual creation activity and the real result. The user allows speeding up this build interval; show a restrained “Build sped up” label and preserve elapsed time in the capture manifest.
6. Open and use the created app. For a checklist, complete an item and show progress change. Pop the conversation out or minimize it only if doing so makes room to use the app or compare it with the source page. End on the accomplished task.

Prefer short, naturally connected prompts over a feature inventory. Keep the answer concise enough to read. Do not force this complete story into a 24-second cut.

## Capture and pacing

- Use a dedicated development worktree/profile and safe prepared project content. Keep other running sessions undisturbed. Existing CLI authentication may be used through the app's normal local-auth setting; do not copy credentials into the demo project.
- Use computer use for the visible actions. Setup APIs can prepare the safe project or window before capture. Record the real app, including embedded browser surfaces, using an appropriate capture tool.
- Human typing is visible behavior: start around 70 to 130 ms per character, with short word pauses and longer pauses after mode activation. Adjust after watching normal-speed playback. Do not paste complete prompts or accelerate typing in the edit.
- Record continuous animation frames and source timestamps. A sequence of still screenshots cannot demonstrate palette or chat transitions. Retain the beginning and end of each transition; do not cut across its easing.
- Speed up generation waits only. Keep navigation, scrolling, typing, sending, keyboard expansion, and app interaction at 1x. Preserve an editable cut map with source intervals, speed factors, and any omissions.
- Keep browser tab hover cards, debugging chrome, permission setup, and unrelated profiles out of the planned take. Preflight authentication and a small real preview build before recording. A successful chat reply alone does not verify app creation. If the product agent uses computer use to verify its app, let it finish before driving the same window yourself. Do not fabricate a successful outcome if the run fails.

## Review lessons from this film

| Rejected result | Required correction |
| --- | --- |
| Chat text was only an unsent draft | Show send, response, and a follow-up with a result. |
| Chats expanded and shrank aimlessly | Tie each layout change to the user's next action. |
| Instant typing hid palette animation | Type at human pace and hold on mode transitions. |
| A controls tour had no payoff | Use the generated app to complete a concrete action. |
| The film omitted browser context | Browse and scroll before asking about the page. |
| Setup copy cluttered the website | Keep the removed caption and “About this film” section removed. |

For the current website, the homepage title is `Work`; secondary titles use `Work · Page`. Preserve these and the accepted visual design when replacing media. Deliver the playable film, editable capture/render source, a concise verification record, and the local preview. Website publishing is a separate action requiring existing authorization.

## Driving the desktop from a script (2026-09-19 film)

Lessons from the "shape the app, then have it build a tool" film, which
replaced the browse → ask → build → use cut on the homepage:

- The desktop can have two page targets: the workspace window and the
  detached chat dock (`?surface=dock`). Capture and drive the workspace
  window explicitly (filter the target by URL); return the dock to the window
  for filming so floating chats render in the captured frame.
- Real CDP key events go to whatever has focus. After browsing, focus sits in
  the page's webview and app shortcuts such as Cmd+N do not fire. Click the
  visible control a person would use (the sidebar's New chat button) instead
  of relying on shortcuts, and it also reads better on film.
- Typing a URL into the new-tab palette can select a matching bookmark
  rather than navigate. Open pages from a project bookmark with a real click
  when the film needs a specific page.
- Sidebar rows carry no accessible name beyond their text; find them by text
  and click their `[data-tree-primary]` child.
- Seed realistic history through the normal chat before filming: real turns,
  short prompts, minimized afterwards so the strip shows their bubbles.
- Keep a `film.mjs` with one command per scene so a failing scene can be
  rehearsed alone; log markers relative to `start.json` for the edit.

- Rehearse the exact build path once before recording. Three things broke
  a take that only a full run reveals: the dev database predated a rewritten
  migration (the app list returned 500 until the column was added), project
  workspaces install `@catamorphic/*` from the local verdaccio registry (bump
  and publish the packages or agents build against old kit and types), and
  seeded skills are written at project creation only (refresh the demo
  project's `.catamorphic/skills` from `SEED_SKILLS` after changing them).
- Project themes wrap the workspace (`ProjectTheme` renders a `.size-full`
  element with `data-theme`); `document.documentElement` keeps the profile
  theme. Wait on the workspace scope, not the root.
- Reset between takes: remove the personal `sidebar-projects/<id>.js` and
  `settings-projects/<id>.json` layers, archive the take's chat, close tabs,
  delete the agent's `.catamorphic` workspace and its app rows, return the
  dock to the window (`catamorphicDesktop.dockDetach(false)`).
- The Work assistant used to repeat the harness's "MCP server needs
  authorization" notice in replies (user-level CLI plugins leak into local
  agents); the workspace prompt now tells it those are host notices.
- Host builds run in microVM sandboxes. A registry on `localhost` is the
  VM's own loopback there; the desktop's dev plan sets
  `CATAMORPHIC_SANDBOX_HOST_NETWORK=1` (turbo passes it through) so sandboxes
  get the `private` and `host` network profiles, the registry listens on all
  interfaces under bun's runtime (the macOS firewall admits bun, not node),
  and the demo project's `.catamorphic/bunfig.toml` addresses the registry by
  the Mac's LAN IP so the lockfile's tarball URLs resolve from both sides.
- Agents compile apps locally unless told otherwise; the building-apps seed
  now ends with the host `build_app` call and an `app:<name>` link, because
  "no successful build yet" is what the person sees otherwise.
- The desktop and any probe script must run the same msb binary: the SDK's
  bundled one migrated the shared sandbox database and the developer's older
  `~/.microsandbox/bin/msb` (which the desktop fell back to) then refused it.
  The dev plan now passes the SDK's binary as `MSB_PATH`.
- A project's build sandbox is created once and reused (`project_sandboxes`);
  a sandbox created before a network or runtime change keeps its old
  configuration. After changing sandbox settings, forget the project's row
  and `msb remove` the sandbox so the next build creates a fresh one.
- Probe scripts must live inside the repo: bun auto-installs the latest SDK
  for a script outside any project, and that newer binary can migrate a
  shared database the desktop's version then refuses.
- Park the pointer over the page after every sidebar click. A pointer left
  on a row keeps its tooltip open, and rows that shift under it (a new
  section pushes the list down) open their tooltip too; a reset done by
  right-click leaves the row's hover card in the first frames.
- Wait on a section's title (`/^Launch/`), never on any text: the chat row
  reads "Add a Launch section…" the moment the prompt is sent. A file's
  mtime marks its last write, not the first, so it cannot date the landing.
- Film on the default theme (Work Dark) unless the film is about themes; a
  dev profile on another preset, or a first ask that switches the project
  to light, clashes with the dark website the film sits on.
- Delete, don't archive, earlier takes' chats: an app that lists sessions
  shows archived ones too, and nine identical rows give the take away.
