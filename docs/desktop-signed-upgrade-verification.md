# Signed desktop upgrade verification

The automated suite tests update state, explicit consent, a download remembered
across launches, preparation timeouts, late native callbacks, handing working
agents back at a restart (ADR 0246), and shutdown failure paths. It does
not prove that macOS installs a signed release and reopens the user's workspace.

## Remaining release check

Use a separate macOS login account or disposable macOS VM. A temporary
`CATAMORPHIC_E2E_DATA_DIR` alone is insufficient isolation: the updater's native
relauncher may not preserve the starting process's environment. Do not use the
regular account's `/Applications/Catamorphic.app` or its existing database.

1. In the isolated account, install the signed desktop alpha.2 build and choose
   Preview. Keep a second unrelated project to detect an accidental selection reset.
2. Create and select a local project. Create two chats, open a Markdown document,
   and arrange browser/editor tabs and the window. Record the selected project,
   chat titles/transcripts, tabs, window bounds, app version, and data directory.
3. Let the app find alpha.3 automatically. Confirm detection alone does not
   download or restart. Explicitly download it, then quit and reopen Work:
   the alert offers Restart to update, not Download update.
4. Start a long agent turn and a foreground terminal command. Confirm Restart
   to update stays enabled and says working agents pick up where they left off.
   Click it and let the signed update complete.
5. Verify the reopened process runs alpha.3 from the isolated installation. Verify
   the selected project, chat content, tabs, and window state against the record,
   that the agent's turn ended interrupted and the agent continued it, and that
   the terminal command ended. Quit and reopen once more; verify the same data
   and no startup errors.
6. Repeat with a remote-linked project when an isolated server is available.
   Verify the connection and selected project survive and remote sessions remain
   accessible. Do not substitute a personal server or copy credentialed configs.

Record platform/architecture, source and destination versions, signed/notarized
artifact checksums, the observed installation path, screenshots, and any failure.
The immutable `desktop-v0.1.0-alpha.3` release must not be moved or replaced.

As of this change, real signed installation/relaunch remains unverified. Prior
work verified publication, signing, checksums, the Preview feed, and download;
those are separate evidence from this installation check.
