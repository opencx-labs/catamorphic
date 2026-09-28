/**
 * A member's own sign-ins and private files in their sessions (ADR 0184),
 * as an agent in such a session sees them. Host-tier, so every project's
 * sessions read it without seeded templates.
 */
export const PERSONAL_ENVIRONMENT_SKILL = `---
name: personal-environment
title: Personal environment
description: Where this session's own sign-ins and private files (such as .env) come from, and how the person adds, removes or checks them. Use when a file the repository does not contain is missing here, when the person asks to include a file such as apps/api/.env.local in their sessions, or when a Claude Code or Codex sign-in expired.
---

# Personal environment

A member's own sessions in an Environment that allows personal credentials
receive what Work on the member's computer sends: their Claude Code and Codex
sign-ins, so nobody signs in again here, and private files the repository
does not contain, such as \`.env\`. Those files sit at their paths in this
workspace, and Git ignores them here: never commit, push, propose, copy or
print them, and never put their values in a message.

## Adding or removing a file

The list lives on the person's computer, in their local copy of the project:
\`.work/personal/environment.json\`, a private file Git never commits.

\`\`\`json
{
  "logins": ["claude-code", "codex"],
  "files": [".env", "apps/api/.env.local"]
}
\`\`\`

\`files\` are paths relative to the project folder; \`logins\` defaults to
both sign-ins when absent. Work on their computer notices the change within
a second, sends the files, and the next turn here has them. Edits to that
path in this workspace change nothing: this is a copy of the project, not
their folder.

- An agent running in the person's local Work chats edits the file
  directly: read it, add or remove the path once, write valid JSON.
- From a session like this one, when a turn needs a file now, ask the
  person to attach it to their message, then write it to its path in this
  workspace and add that path to \`.git/info/exclude\` so nothing commits
  it. For later sessions, suggest they add it under **Remote environment**
  in the Server section of Work (Add files), or give them the exact change
  to the file above.

A listed file the repository already tracks, or one whose path goes
through a symbolic link, is left alone rather than overwritten; change
tracked files in the repository instead.

## When something is missing

- A missing private file: check \`git ls-files --error-unmatch <path>\`
  fails (untracked), then ask the person to attach it or add it as above.
- A sign-in that expired: Work on the person's computer refreshes it and
  sends it again while it is open. Ask them to open Work; never ask for
  passwords, tokens or keys.
- Nothing arrives at all: the Environment needs \`"personalCredentials":
  true\` in \`.work/project.json\` (a reviewed project change), and only the
  person's own chats receive it, for their own messages: never project
  chats, automations, or messages someone else sent.
`;
