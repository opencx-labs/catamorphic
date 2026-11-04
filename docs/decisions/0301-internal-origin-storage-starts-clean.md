# 0301 - Internal-origin storage starts clean

- **Status:** Accepted
- **Date:** 2026-11-02
- **Supersedes:** Legacy local-storage import in 0300

## Context

Alpha.33 disables extra file-protocol privileges. Its startup migration still
loads a file-origin page from ASAR, which fails before any window opens. Even
an ordinary disk page cannot read the old local storage with those privileges
disabled. Development tests did not exercise the distributed fuses.

## Decision

Remove the legacy storage migration. The user accepts this breaking alpha
change: the secure internal origin starts with its own local UI storage. Old
drafts and interface preferences are not imported automatically. Their source
remains on disk. Projects, chat history and the application database are not
reset or migrated by this change.

Keep every production fuse and normal renderer security setting unchanged.
Do not ship a temporary security exception, a LevelDB parser, or another
compatibility path. Recovery notes remain minimal; an agent can inspect the
source to recover specific old values if the person requests it.

## Consequences

Alpha.36 removes the startup failure and the obsolete migration page and tests.
The release job launches the actual signed app against fresh and seeded legacy
profiles, requires a visible window and successful server boot, and verifies
normal quit and retained new-origin drafts after restart. File-origin values
must remain untouched and absent from the new origin.
