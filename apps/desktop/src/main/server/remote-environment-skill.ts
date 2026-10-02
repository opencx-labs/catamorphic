import {
  PERSONAL_ENVIRONMENT_PATH,
  PERSONAL_ENVIRONMENT_STATUS_PATH,
  PERSONAL_FILE_MAX_BYTES,
  PERSONAL_FILES_MAX,
} from "../personal-environment-config.js";

/**
 * Host-tier skill (ADR 0184): how the member, and agents on their behalf,
 * bring their private files into their sessions on a linked Work server.
 * Sign-ins stay on the machine they were made on (ADR 0198).
 */
export const REMOTE_ENVIRONMENT_SKILL = `---
name: remote-environment
title: Remote environment
description: Bring the person's private files (such as .env or apps/api/.env.local) into their sessions on the project's Work server, and explain where their Claude Code and Codex sign-ins apply. Use when they ask to include, remove or check files for remote sessions, when a remote session lacks a file that exists on their computer, or when a remote session says it has no sign-in.
---

# Remote environment

A project linked to a Work server can run the person's chats on the server
instead of this computer. Their remote environment is what Work on this
computer sends there for them: files the repository does not contain, such
as \`.env\`. Their Claude Code and Codex sign-ins are never sent; see
"Sign-ins stay on their machine" below.

## The config file

\`${PERSONAL_ENVIRONMENT_PATH}\` in the project folder, private to this
person. It lives in the personal folder Git ignores, so it is never committed
or pushed, and neither are the files it lists.

\`\`\`json
{
  "files": [".env", "apps/api/.env.local"]
}
\`\`\`

- \`files\`: paths relative to the project folder, forward slashes, no
  \`..\`, nothing inside \`.git\`. At most ${PERSONAL_FILES_MAX} files of up to
  ${PERSONAL_FILE_MAX_BYTES / 1024} KB each. Work reads their current contents
  from this computer and sends them again whenever they change.
- Only that key. Anything else (including an old \`logins\` list) makes the
  file invalid and nothing is sent until it is fixed.

Edit the file with ordinary file tools: read it first (a missing file means
the defaults above), change only what was asked, keep valid JSON, and write
the whole object. Work notices the change within a second and sends it. Never
copy a file's secret values into chat, a commit, or another file, and never
list a file that the repository already tracks: sessions leave tracked
paths alone rather than overwrite them. To change a tracked file on the server,
change it in the repository instead.

## Who receives it

The files reach only this person's own sessions on the server,
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
the person shares it from the Server section: members who may publish the
project publish it at once, everyone else proposes it for a reviewer to
accept. The server also decides whether a machine may hold personal
credentials: a per-session microVM, or a machine that serves only this
person.

## Sign-ins stay on their machine

Work never reads, copies or sends a Claude Code or Codex sign-in. A sign-in
belongs to the machine it was made on, and an agent that uses the person's
own subscription runs only on a machine where they are signed in:

- **This machine** (below) uses the sign-in they already have here.
- On a worker, they sign in there themselves with the harness's own flow:
  \`work worker sign-in claude-code\` or \`work worker sign-in codex\`, run
  on that worker. The worker then reports that they are signed in, never the
  credential.

Anywhere else, agents use the project's model connections or the person's
own API key, stored as their personal connection. If a remote chat says
there is no sign-in for its owner, relay the fix it names: sign in on that
machine, or move the chat to one where they are signed in.

## Running on this computer, then moving to the server

A chat's **Run on** choice (the chat's status panel) picks its Environment.
An Environment with \`"device": "member"\` is **This machine**: the chat's
history stays on the server while its work runs here. The person connects
this computer once from the chat ("Connect this device"). To continue a
chat on the server, they pick a server Environment in that same control;
the chat keeps its history and its next turn runs there, on a machine
where they are signed in or with a key.

Claude Code and Codex run inside the chat's sandbox, so an Environment
they use must provide the \`claude\` or \`codex\` command: on This machine,
name a Dockerfile image that installs them (this computer builds it when
Docker or Podman is installed):

\`\`\`json
"laptop": {
  "device": "member",
  "workloads": ["agent"],
  "personalCredentials": true,
  "image": ".work/images/harness.Dockerfile"
}
\`\`\`

\`\`\`dockerfile
FROM node:22-bookworm
RUN apt-get update \\
  && apt-get install -y --no-install-recommends git ca-certificates \\
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex
\`\`\`

If an Environment is unavailable, the chat says why (for example that the
machine lacks the command or cannot build images); relay that reason.

## Checking status

\`${PERSONAL_ENVIRONMENT_STATUS_PATH}\` is written by Work after each check, with
no secrets: \`server\` is \`allowed\`, or \`not-allowed\` when no Environment
allows personal credentials; each file says whether it was sent or why not (\`problem\`, such as a missing file). \`error\` and
\`configError\` explain failures. No status file means the project is not
linked, the server does not support this yet, or Work has not checked yet.
The person can also open "Remote environment settings" from the command
palette, or Remote environment in the sidebar's Server section, to see the
same and send now.

Never ask for passwords, tokens or API keys in chat, and never copy a
sign-in from one machine to another.

## Example: include apps/api/.env.local in my remote environment

1. Check that \`apps/api/.env.local\` exists in the project folder and that
   Git does not track it (\`git ls-files --error-unmatch apps/api/.env.local\`
   should fail). Do not print its contents.
2. Read \`${PERSONAL_ENVIRONMENT_PATH}\`. If it is missing, start from
   \`{ "files": [] }\`.
3. Add \`"apps/api/.env.local"\` to \`files\` (once) and write the file.
4. After a few seconds, read \`${PERSONAL_ENVIRONMENT_STATUS_PATH}\`. If the file
   shows as sent, tell the person their next remote turn has it. If
   \`server\` is \`not-allowed\`, explain that an Environment needs
   \`"personalCredentials": true\` and offer to propose that change.

Removing a file is the same edit in reverse; Work sends the
smaller set and later turns no longer receive it.
`;
