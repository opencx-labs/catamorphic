import {
  PERSONAL_ENVIRONMENT_PATH,
  PERSONAL_ENVIRONMENT_STATUS_PATH,
  PERSONAL_FILE_MAX_BYTES,
  PERSONAL_FILES_MAX,
} from "../personal-environment-config.js";

/**
 * Host-tier skill (ADR 0184): how the member, and agents on their behalf,
 * bring their own sign-ins and private files into their sessions on a
 * linked Work server.
 */
export const REMOTE_ENVIRONMENT_SKILL = `---
name: remote-environment
title: Remote environment
description: Bring the person's own Claude Code and Codex sign-ins and private files (such as .env or apps/api/.env.local) into their sessions on the project's Work server. Use when they ask to include, remove or check files or logins for remote sessions, or when a remote session lacks a file or sign-in that exists on their computer.
---

# Remote environment

A project linked to a Work server can run the person's chats on the server
instead of this computer. Their remote environment is what Work on this
computer sends there for them: their own Claude Code and Codex sign-ins, so
they never sign in again on the server, and files the repository does not
contain, such as \`.env\`.

## The config file

\`${PERSONAL_ENVIRONMENT_PATH}\` in the project folder, private to this
person. It lives in the personal folder Git ignores, so it is never committed
or pushed, and neither are the files it lists.

\`\`\`json
{
  "logins": ["claude-code", "codex"],
  "files": [".env", "apps/api/.env.local"]
}
\`\`\`

- \`logins\`: which of the person's sign-ins on this computer to send. Allowed
  values are \`"claude-code"\` and \`"codex"\`. Without the file (or without
  the key), both are sent when they are signed in here. \`[]\` sends none.
- \`files\`: paths relative to the project folder, forward slashes, no
  \`..\`, nothing inside \`.git\`. At most ${PERSONAL_FILES_MAX} files of up to
  ${PERSONAL_FILE_MAX_BYTES / 1024} KB each. Work reads their current contents
  from this computer and sends them again whenever they change.
- Only those two keys. Anything else makes the file invalid and nothing is
  sent until it is fixed.

Edit the file with ordinary file tools: read it first (a missing file means
the defaults above), change only what was asked, keep valid JSON, and write
the whole object. Work notices the change within a second and sends it. Never
copy a file's secret values into chat, a commit, or another file, and never
list a file that the repository already tracks: the server refuses tracked
paths rather than overwrite them. To change a tracked file on the server,
change it in the repository instead.

## Who receives it

The files and sign-ins reach only this person's own sessions on the server,
never a project chat, an automation, or another member's session. The server
also requires an Environment that allows personal credentials. Environments
live in \`.work/project.json\`; add \`"personalCredentials": true\` to the one
the person's remote sessions use:

\`\`\`json
{
  "environments": {
    "dev": {
      "workloads": ["agent"],
      "personalCredentials": true
    }
  }
}
\`\`\`

Changing \`.work/project.json\` changes shared project source, unlike the
personal config. In a repository Work did not create, commit it on a work/
branch and open a pull request with create_pull_request; in a company brain,
propose it for review. Say that a reviewer must accept it before it applies.
The server also decides whether a machine may hold personal credentials: a
per-session microVM, or a machine that serves only this person.

## Checking status

\`${PERSONAL_ENVIRONMENT_STATUS_PATH}\` is written by Work after each check, with
no secrets: \`server\` is \`allowed\`, or \`not-allowed\` when no Environment
allows personal credentials; each login says whether it is signed in here,
its expiry, and whether the server holds a copy; each file says whether it
was sent or why not (\`problem\`, such as a missing file). \`error\` and
\`configError\` explain failures. No status file means the project is not
linked, the server does not support this yet, or Work has not checked yet.
The person can also open "Remote environment settings" from the command
palette, or Remote environment in the sidebar's Server section, to see the
same and send now.

A sign-in that expires is refreshed by the Claude Code or Codex app on this
computer and sent again while Work is open. If a remote session says the
sign-in expired, ask the person to open Work on their computer. Never ask for
passwords, tokens or API keys in chat, and never sign in on the server.

## Example: include apps/api/.env.local in my remote environment

1. Check that \`apps/api/.env.local\` exists in the project folder and that
   Git does not track it (\`git ls-files --error-unmatch apps/api/.env.local\`
   should fail). Do not print its contents.
2. Read \`${PERSONAL_ENVIRONMENT_PATH}\`. If it is missing, start from
   \`{ "logins": ["claude-code", "codex"], "files": [] }\`.
3. Add \`"apps/api/.env.local"\` to \`files\` (once) and write the file.
4. After a few seconds, read \`${PERSONAL_ENVIRONMENT_STATUS_PATH}\`. If the file
   shows as sent, tell the person their next remote turn has it. If
   \`server\` is \`not-allowed\`, explain that an Environment needs
   \`"personalCredentials": true\` and offer to propose that change.

Removing a file or a login is the same edit in reverse; Work sends the
smaller set and later turns no longer receive it.
`;
