# Work desktop film: story and lessons

What the Work homepage film shows, and the lessons behind each step of the
[runbook](work-demo-runbook.md). Read the current desktop contracts before
capture; this is the accepted direction for the homepage film, not a script
every announcement must follow.

## The current story

A person shapes their workspace, then has it build a tool, all in one chat
(scenes in `scripts/work-demo/film.mjs`):

1. **browser**: open a page from a project bookmark, collapse the sidebar, and
   skim it with two scroll flicks.
2. **chat1**: open a chat and ask for a Launch section at the top of the sidebar
   with the project's four docs. Bring the sidebar back to watch it land.
3. **theme**: ask for light mode, a calmer accent and a softer font. Minimize the
   chat and collapse the dock so the change lands on a clean window; the bubble
   signals when it is done.
4. **chat2**: open the chat beside the page and ask for a small app showing what
   you have been working on (chats by day, which are open, what each was about).
5. **app** and the pickup: the app is listed, Work asks once before it reads your
   chats, the app shows real data, and the chat returns beside it with
   Cmd+Shift+click on its bubble.

Framing: the 1280x800 window fills the frame at 1.5x (1920x1200, 60 fps), no
captions. The earlier browse, ask, build, use story remains a valid shape for a
different brief: browse a page, ask about it in a floating chat, expand it with
Cmd+Shift+M, ask for a small app, then use the app.

## Principles that came from review

| Rejected | Instead |
| --- | --- |
| Chat text was an unsent draft | Send, show the answer, follow up with a result |
| Chats resized aimlessly | Each layout change serves the next action |
| Instant typing hid the palette animation | Type at human pace, hold on mode changes |
| A controls tour with no payoff | Use the generated app for a concrete action |
| No browser context before the question | Browse and scroll before asking |
| Setup copy on the website | Keep the demo caption and "About this film" section removed |
| A spliced result implied behavior the app lacks | Film only what the product does; a search mode searches, it does not navigate |

Do not imply page awareness the agent does not have: give it the context it needs.

## Capture and pacing

- Typing: about 70 to 130 ms per character with short word pauses and a longer
  pause after a mode change. Never paste whole prompts or speed typing in the edit.
- Scroll like a hand: one 160 px wheel event reads as a jump. A flick is about 40
  ticks at 16 ms with an eased, shrinking delta (`flick()` in film.mjs).
- Record a continuous screencast (`Page.startScreencast`) with timestamps; stills
  cannot show transitions. Keep the start and end of every transition.
- Render at 60 fps: the screencast delivers at the display rate, so 30 fps drops
  half the frames. A still window sends only a few frames a second; that alone is
  not a stall.
- Agent waits are cut, never fast-forwarded: the send settles at 1x, the edit cuts
  to the assistant working, holds, then shows the landing (`working()` in
  make-edit.py). Say so in the brief.
- With attention-gated lurking the chat stays open through the landing, so the
  reply streams while the change arrives.

## Driving the desktop

- The desktop can have two page targets: the workspace and the detached dock
  (`?surface=dock`). The scripts pick the page without `surface=`. Return the dock
  to the window (`catamorphicDesktop.dockDetach(false)`) so floating chats are in frame.
- CDP key events go to whatever has focus. After browsing, focus sits in the page's
  webview and app shortcuts do not fire. Click the visible control a person would
  use; it also reads better on film.
- Typing a URL in the new-tab palette can select a matching bookmark. Open a
  specific page from a project bookmark with a real click.
- Sidebar rows are found by text; click their `[data-tree-primary]` child.
- Wait on a section's title (`/^Launch/`), never on any text: the chat row reads
  "Add a Launch section..." the moment the prompt is sent.
- Read every `session-inspector-trigger`, not the first visible one: minimized
  bubbles and rows mount their own. `chatWorking` is "any visible trigger says
  Working"; `chatIdle` is "one says Ready and none says Working".
- Project themes wrap the workspace in a `.size-full[data-theme]` element;
  `document.documentElement` keeps the profile theme. Wait on the workspace scope.
- With a debugging port the desktop keeps rendering while covered
  (`disable-backgrounding-occluded-windows` in `apps/desktop/src/main/index.ts`),
  so a take survives the person using their Mac. Never steal focus with
  `osascript`: the person is at the Mac.

## The set

- Theme: film on Work Dark unless the film is about themes; the website is dark.
- Bookmarks bar: replace a dev profile's imported bookmarks with a work set in
  `<Desktop data>/bookmarks.json` (`pinnedByProfile` tiles, `libraryByProfile`
  rows, each with a `faviconUrl` so nothing shows a globe). Edit it with the app
  stopped, since the store rewrites the file. Keep a backup of the original.
- Seed realistic history through the normal chat before filming: short real turns,
  minimized so the strip shows their bubbles.
- Delete, never archive, earlier takes' chats: an app that lists sessions shows
  archived ones too. Deleting chats in the database leaves their dock bubbles,
  and each mounts a status trigger; close them before filming.
- Pointer: park it over the page after every sidebar click, or a row keeps its
  tooltip. After collapsing the sidebar, leave through the address bar before
  parking, or the tab that slides under the pointer opens its hover card.
- The main take cannot allow the app (the floating chat covers the consent card).
  The pickup does it. Before the pickup, allow once by JS to warm the app, confirm
  it renders data, then clear `appAccessApprovals` so the card is back.
- An app may fail on first open for reasons the take cannot show (once, a page
  size above the host's limit). Warm it before the pickup, read the error from a
  database copy, and fix the demo project in a commit first.

## Build path traps

Each of these cost a take. Check them in the rehearsal.

- **Registry:** project workspaces install `@catamorphic/*` from the local
  verdaccio registry ([infra/local-registry](../../../../infra/local-registry/README.md)).
  Bump and publish changed packages or agents build against the old kit. Build
  sandboxes are microVMs where `localhost` is the VM, so the demo project's
  `.catamorphic/bunfig.toml` names the Mac's LAN address. The address changes with
  the network: compare it with `ipconfig getifaddr en0` before any take that builds.
- **Seeds:** seeded skills are written when a project is created. After changing
  them, refresh the demo project's `.catamorphic/skills` from `SEED_SKILLS`.
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
- **Sleep:** run `caffeinate -dims` for the whole session. A take recorded while
  the Mac slept produced 27 minutes of wall time, 235 frames and a dead app runtime.
