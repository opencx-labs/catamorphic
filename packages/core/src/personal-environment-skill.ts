/**
 * What a session's workspace receives beyond the repository, as an agent
 * there sees it: the project's secrets as environment variables (ADR
 * 0205), a member's own private files (ADR 0184), and where sign-ins come
 * from (ADR 0199). Host-tier, so every project's sessions read it without
 * seeded templates.
 */
export const PERSONAL_ENVIRONMENT_SKILL = `---
name: personal-environment
title: Personal environment
description: Where this workspace's environment variables (project secrets) and private files (such as .env) come from, who can set them, and how to explain one that is missing. Use when a key or variable the work needs is not set, when a file the repository does not contain is missing here, when the person asks to add their own key or file to their sessions, or when a Claude Code or Codex sign-in is in question.
---

# Personal environment

A workspace on the Work server receives two things the repository does not
hold: the project's **secrets**, as environment variables, and a member's own
**private files**, such as \`.env\`. Never commit, push, propose, copy or print
either, and never put a value in a message, a file or a command's output: Work
replaces delivered values with \`[secret NAME]\` in what it records, but the
person's terminal and the files you write are not masked.

## Secrets: environment variables

An Environment in \`.work/project.json\` lists the secrets its workspaces
receive, by name:

\`\`\`json
{
  "secrets": {
    "CLICKHOUSE_API_KEY": { "description": "Your ClickHouse key" }
  },
  "environments": {
    "dev": { "workloads": ["agent"], "secrets": ["CLICKHOUSE_API_KEY", "SENTRY_DSN"] }
  }
}
\`\`\`

A name is declared under \`"secrets"\` (or by \`defineSecrets\` in workflow code,
or by a plugin) and listed on each Environment that should have it. Changing
either is a reviewed project change.

Each listed secret holds a **shared value** and may hold **one value per
member**, such as a key issued to every engineer:

- In a member's own chat, their own value, else the shared one. They arrive
  only for turns that answer that member's own messages, and only on a
  machine that isolates them (a sandboxed machine, one only they use, or
  their own computer).
- In a project chat, the shared value, on a machine that isolates the
  project's work.
- Workflow runs get shared values, as always.

They are set in this workspace's shells and the agent's own process, and
setup scripts and terminals load them too. A command that needs them in a
shell started some other way can load the session's file:
\`. ../.work-session/env/secrets.sh\` from the project folder.

### When a variable is missing

Work tells you at the start of a turn which listed secrets have no value
here and why. Explain it to the person in those terms, and never ask them to
paste a value into the chat:

- **No value for them**: they set their own under **Secrets** in Work (the
  Server section of a project linked to the server), or ask someone who
  manages the project's secrets to set it for them or set a shared value.
  An onboarding workflow may set it for them too.
- **Not declared**: the Environment lists a name nothing declares; add it
  under \`"secrets"\` in \`.work/project.json\`.
- **Not given to this turn**: someone other than the chat's owner wrote the
  message, or the machine runs other people's work as plain processes. The
  owner can send the message themselves, or the project can place the
  Environment on a sandboxed machine.

A value that grants access to a company system (a database, an internal
API) belongs in a gateway connection instead, which keeps the credential out
of every sandbox.

## Private files

A member's own sessions in an Environment with \`"personalCredentials": true\`
receive files the repository does not contain, such as \`.env\`, listed on the
person's computer in their local copy of the project:
\`.work/personal/environment.json\`, a private file Git never commits.

\`\`\`json
{
  "files": [".env", "apps/api/.env.local"]
}
\`\`\`

Paths are relative to the project folder. Work on their computer sends the
files when the list or a file changes, and the next turn here has them, at
their paths, ignored by Git. Edits to that path in this workspace change
nothing: this is a copy of the project, not their folder.

- An agent running in the person's local Work chats edits the file
  directly: read it, add or remove the path once, write valid JSON.
- From a session like this one, when a turn needs a file now, ask the person
  to attach it to their message, then write it to its path here and add that
  path to \`.git/info/exclude\`. For later sessions, suggest **Remote
  environment** in the Server section of Work (Add files), or give them the
  exact change to the file above.

A listed file the repository tracks, or one whose path goes through a
symbolic link, is left alone rather than overwritten. Files arrive only in
the person's own chats, for their own messages: never in project chats,
automations, or turns answering someone else's message.

## Sign-ins

Claude Code and Codex subscriptions are never sent anywhere. A chat that runs
on one runs only on a machine where its owner signed in to it themselves,
such as their own computer connected to the project. If a sign-in expired,
ask them to sign in again on that machine; never ask for passwords, tokens
or keys.
`;
