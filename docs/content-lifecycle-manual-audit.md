# Company brain and content lifecycle walkthrough

Work in progress, 2026-09-13. This records observed behavior and outstanding
verification. All application testing uses manual Computer Use. Builds, lint,
and typechecks are static validation, not substitutes for the walkthrough.

## Demo and roles

Private repository: [catamorphic-demo-brain](https://github.com/m-tabaza/catamorphic-demo-brain).
The builder has repository write access and reviews as m-tabaza. The company
service opens proposals as tabaza-opencx so the human can review its work.
Demo Builder and Demo CSM have separate ordinary company accounts. The CSM role
can read the playbooks and propose changes, but has no builder permissions.

The first walkthrough used separate desktop profiles. This correctly exercised
company membership, but was not a completely isolated device simulation: the
GitHub App connection is desktop-wide and appeared in the CSM profile's repository
import picker. A second desktop instance with fresh application data, no imported
credentials and no local agent completed the independent CSM walkthrough. Do not
equate profiles with separate people or use the first profile test as evidence
of credential isolation. The clean instance is the evidence for that case.

## Verified manually

- Builder created an invitation and explicitly chose Customer Success. Invite
  stays disabled until a role is selected. CSM signed in and joined using the
  invitation link, with no local-agent setup wizard or GitHub step on that path.
- Generated invitations include the project name. Pasting the latest real link
  into the fresh desktop showed Demo Company Brain and a human-readable
  demo-company-brain local folder before sign-in.
- Builder assistant created a playbook and then submitted
  [proposal 1](https://github.com/m-tabaza/catamorphic-demo-brain/pull/1).
  The first attempt lacked a proposal capability; the stock host now projects
  the existing project.propose_change capability. A real follow-up discovered
  and successfully called it.
- Builder read proposal 1, approved it and applied it through the app. CSM
  downloaded the accepted playbook into the local project folder.
- CSM edited that local Markdown file using the rich editor and submitted only
  that file from its top status popover. Saving happened before proposing.
  [Proposal 2](https://github.com/m-tabaza/catamorphic-demo-brain/pull/2) appeared
  in the Proposals sidebar. No GitHub sign-in was invoked by the proposal path.
- CSM posted a discussion comment. Builder requested clarification through
  Request changes. CSM read that review and replied in the app. Builder read
  the reply, approved the revision and applied it. This tested a clarification
  loop, not updating an existing proposal's source revision.
- CSM downloaded proposal 2: the UI reported one pulled file, the pending-local
  change indicator cleared, and the accepted text appeared in the rich editor.
  File status showed Saved on this device and the unchanged local path. Show in
  Finder selected the actual file, whose Finder preview contained the accepted
  text. No worktree or folder transfer was involved.
- CSM review omitted Approve and Apply controls. Company review omitted branch
  names, and CSM discussion omitted GitHub links it could not use.
- Review contents remained visible during request-changes and approval refresh.
- Applied proposal 1 reopened after a full app restart. Its status showed
  Applied to project and exposed no approval/apply controls. The prior open-list
  authorization bug is fixed by the scoped individual-proposal read API.
- A remote personal-note request originally wrote into a server sandbox and
  misleadingly described that as local. Updated host guidance was checked with
  a new real agent turn: it attempted capability discovery, returned the note
  in chat, and explicitly said it had not saved the file on the device. Automatic
  device delivery remains missing.
- Fresh-desktop sign-in cancellation closed the authorization tab and returned
  to Join with the original invitation intact and an actionable cancellation
  message. Retry opened a new authorization attempt.

- On the clean desktop, CSM joined through the ordinary invitation with only
  company authentication, edited the playbook, and submitted
  [proposal 3](https://github.com/m-tabaza/catamorphic-demo-brain/pull/3), clarifying
  that the recap target is internal guidance. No GitHub or local agent setup was
  used. Builder read the exact one-line diff, marked it reviewed, approved it and
  applied it. CSM saw Applied to project, then downloaded one accepted file into
  the same folder; the pending-change indicator cleared.
- The proposal completion dialog now uses plain proposal language and View
  proposal opened the app review directly. Empty assignees, requested reviewers,
  and CI sections no longer clutter a company proposal. Existing checks remain
  visible as Project checks.
- A real five-minute sign-in attempt expired with its invitation preserved and
  an actionable retry message. The test window temporarily showed stale pixels
  and accessibility frames; resizing repainted it and retry displayed Sign-in
  help. The next password sign-in completed and closed the authorization page.
  This does not establish that native passkeys work or resolve the rendering
  stall's cause.

- A real local Codex turn created meeting-prep.md in the existing personal
  namespace, opened it, and showed Saved on this device and Local only with
  the actual path in the top status popover. The agent reported no worktree,
  commit or publication. The document title bar now omits the internal personal
  namespace/profile ID; the actual path remains available in file status.
- Explicit worktree creation and repeated creation returned the same assignment.
  Renaming its folder in Finder stopped the next turn with a recovery message.
  After restoring it, an actual `pwd` exposed a Codex adapter bug: execution
  remained in the primary folder despite the assignment. The adapter now sends
  the live checkout on each turn. Real `pwd` results verified both directions
  in the same loaded conversation, plus restored-folder retry. Chat status now
  shows the folder and Use project folder, sharing the agent action's assignment
  lock and isolation policy. The manual UI action preserved the worktree;
  explicit creation reused it again. Ordinary note creation stayed local.
- After the development server changed ports, builder and both CSM copies
  rejoined through the normal connection UI without moving their files.
  Existing-folder copy now says Local folder. Network failures preserve the
  link and offer a plain-language retry. Rejoining invalidates project and
  authority caches so old connection failures do not remain in the sidebar.
  The isolated CSM reproduced that stale failure, then rejoined with the fix:
  the failed Workflows section disappeared without a manual retry. Its accepted
  playbook remained open in the original folder. Download/Upload button icons
  were also aligned with their labels and checked visually at the normal width.

## Supporting implementation

- Files use the same top-chrome resource inspector as Chat: status, actual
  location, Save, Show in Finder, Propose and Publish. New personal files use
  the existing profile-local namespace and are excluded from project sync and
  proposals. The local scanner does not follow symlinks or another profile.
- The company host reads/comments on proposals using its service credential,
  narrowed by every changed file's document scope, including previous rename
  paths. Builder actions require builder membership, an explicitly connected
  personal GitHub CLI identity, matching repository and the reviewed head SHA.
- Reading a single proposal verifies the head around the diff fetch and works
  after closure/application. The open sidebar remains an inbox.
- Published GitHub synchronization now fetches accepted changes only. It cannot
  push unreviewed working-copy changes to GitHub or automatically merge them
  into the published branch. Non-fast-forward internal origin updates preserve
  existing work and return divergence.
- Ordinary document edits stay in the current folder. Managed session worktrees
  are reused. A missing assigned folder stops work rather than silently moving
  edits into the primary checkout.
- Scoped built-in assistant resolution, member file visibility, proposal sidebar
  gates, profile project ownership and unnecessary local-agent onboarding were
  corrected based on the walkthrough.

## Sign-in and passkeys

Embedded GitHub passkey sign-in previously stalled. Import currently brings
passwords/bookmarks in the onboarding flow, not passkeys. Settings' separate
bookmark import remains bookmarks-only. No imported-passkey claim is made.

The authorization inspector keeps the original sign-in attempt active, has a
bounded lifetime and cancellation, and reveals Continue in your browser under
passkey trouble as a last resort. Earlier in this task the user completed
GitHub verification in Chrome and the desktop connection completed.
Native embedded passkey success is still unverified and is not claimed fixed.

[Electron's platform-passkey documentation](https://github.com/electron/electron/blob/main/docs/api/app.md#appconfigurewebauthnoptions-macos)
requires signing, an embedded provisioning profile, and an associated domain
whose AASA lists the app. That does not provide arbitrary third-party sites'
existing passkeys simply by toggling an Electron setting. Native passkeys and
credential-provider integration need a separate supported design.

## Remaining work and larger decisions

1. The accepted GitHub revision can take up to the server’s one-minute polling
   interval to reach the project. An immediate Download updates can therefore
   report Up to date while the review already says Applied. Provide an explicit
   publication refresh or distinguish this propagation state.
2. Device-local file delivery from the company agent. A concrete proposed design
   is in [device-local-output-design.md](device-local-output-design.md); approval
   is pending for the host-injectable desktop delivery bridge.
3. Edit and resubmit the same proposal after source changes, with explicit
   out-of-date approval state. The tested feedback loop used a clarification.
4. Worktree creation, reuse, actual execution in both directions, missing-folder
   failure and restoration/retry passed manually. Chat status retained the
   assignment while the folder was missing. Additional harness and concurrent
   session coverage remain; the real execution checks used Codex.
5. Repeat the latest browser fallback and investigate the intermittent stale
   rendering after sign-in. Local Codex stayed in Preparing agent while downloading an already-installed
   binary. The installed dependency lookup was corrected to follow the
   SDK/CLI/platform package chain with canonical package paths. The next manual
   retry started the installed binary within seconds, with no duplicate Codex
   download. Visible
   first-use download progress remains a separate onboarding improvement.
6. A first-use layout pass should address the command palette appearing under
   floating chat and sign-in pages
   retained in normal browser history. These were not redesigned in this pass.
7. The review should show the actual member's display name, rather than the
   service account plus an opaque member ID. This needs host identity presentation,
   not an invented core user directory. A proposal history browser also remains.
8. Local changes that already have an open proposal still look unproposed until
   application/download. Existing proposals need an association to the exact
   local file version before this can be represented accurately.
9. The development runner changes ports on restart, making saved company links
   stale. Its server watcher can also restart before the previous worker lease
   expires. These development issues interrupted the walkthrough; neither was
   disguised as successful product behavior.

## Static validation

Root lint passed (1464 files). Root typecheck passed (54 tasks, including all
workspace consumers), as did root script typecheck. GitHub, core, Fastify,
API-client and UI builds passed; OpenAPI and generated types were regenerated.
The public desktop runner rebuilt and launched the updated native app. Earlier
root build completed 29 tasks. The latest renderer changes passed the focused desktop typecheck; the focused
lint pass and git diff whitespace checks also passed. No automated suite or merge gate was run, honoring the
requested manual method. Obsolete assertions were updated but not executed.
No implementation changes have been committed or pushed.
