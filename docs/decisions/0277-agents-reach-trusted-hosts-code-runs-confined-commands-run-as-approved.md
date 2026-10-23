# 0277 — What agents write reaches only trusted hosts, project code runs confined, and commands run as approved

- **Status:** Accepted (amends 0045, 0140, 0148, 0176, 0234, 0239, 0241)
- **Date:** 2026-10-21

## Context

Agents read pages, mail, pull requests and documents other people wrote, and
whatever they read can instruct them. Work then renders or runs much of what
agents write. A chat reply holding `![](https://host/?d=…)` loaded that image
on sight, from any agent's chat, sandboxed and remote ones included; an https
icon on a row or chip did the same, and a row's link fetched its site's
favicon. Sidebar, palette and chips modules ran with every file, the network,
Work's environment and the loopback API, so their `collections` and
`workflows` grants bound only modules that chose to honor them. A committed
module, Claude Code hook or automation ran for whoever opened the checkout.
Workflows run in microVMs, with open egress by default. Apps (0036, 0148) and
Chrome extensions (0203) already had the model the rest lacked: confined
code, declared access, and the person asked when access grows.

## Decision

**What agents write reaches only hosts the chat trusts.** Opening a link or
loading an image sends its whole address to its host, and an agent chose the
address. A row's or chip's icon is a Lucide name, a `data:` image, or an icon
this profile's tabs showed, which main serves. An image in a chat reply loads
only from a trusted host; from any other it names the host, with Show (this
once) and Always show. A web link a chat opens (a reply's, a step's, an
agent's chip) to an untrusted host asks first, showing the whole address;
Always open trusts the host. One list serves both: Work's (hosts where only
the host sees requests and nothing sends a visitor onward: GitHub's,
Wikimedia's, MDN, this machine), the approved published program's `trustedHosts`
in `.work/project.json`, and the person's own, kept in their signed approvals.
The project's published list is trusted automatically by every member, with
no per-person re-approval. Local drafts and checkpoint commits grant no host
trust. A project without a published list contributes no shared hosts; reads
never fall back to its working file or `HEAD`.
Files, notes, pull request comments and theme pictures load as before.

**Project code Work runs by itself is confined and declares what it
reaches.** This covers source modules, apps (sidebar widgets and session apps
included), workflows, watchers and automations. One shape,
`catamorphic.access` in the nearest `package.json` from the code up to the
project root (0148's, grown): `lists` (Work's lists it reads and acts on),
`workflows` it calls, `hosts` it reaches (`api.linear.app`, `*.example.com`,
`localhost:11434`), `connections` whose HTTP APIs it calls through the gateway
(0212), which adds the key on the way, `reads` outside the project, `writes`
it makes, and `sessions`. Nothing else leaves: no inherited environment, no
network or DNS but declared hosts, no reads outside the project, no writes but
declared ones, no system services, never Work's own servers. A source module
runs in Bun under a macOS
Seatbelt profile whose only network is a proxy in main admitting its hosts;
apps keep their opaque-origin iframe, with `connect-src` from their hosts;
workflows keep microVMs, a run's egress being its program's hosts within its
Environment's policy, closed when neither names any. The layout only places
code: a section's `collections` and `workflows` are gone, and a module several
sections show has one access.

File grants bind resolved filesystem destinations, including the existing
ancestors of new files, before they are compared or signed. Parent traversal
is rejected, and launch refuses a destination that changed since approval.
The proxy resolves each admitted name once, checks every returned address
against Work's protected listeners and other module proxies, then connects
to the checked IP. A different DNS answer cannot change that connection.

**Commands that run as the person run only as approved.** Claude Code project
hooks and settings that run commands, ACP agent commands, MCP stdio servers
and terminal macros cannot be confined, because they are the person's own
tools. Work runs the exact content the person approved and asks again when it
changes. Nothing starts because a file appeared in a checkout, a pull or a sync.

**One approval.** People approve what code reaches, never edits. Each profile
keeps what its person approved for each piece of code (project, path, and its
access or content hash), signed with a key in Work's keychain item, so writing
the file grants nothing. Equal or narrower access runs without asking, however
the code changed. Wider access waits in place, with Work's words listing only
what is new ("Your chats · api.linear.app") and the chat that changed it when a
checkpoint names one. Code someone else committed asks the first time. A
published app or deployment on a server is its builder's approval, as in 0148.
Resources (0266) lists each with what it reaches, and revokes it. 0148's app
approvals and definition consent move into this record; extensions keep 0203.

Considered: alerting on every workspace edit (edits come from agents, Git,
teammates and editors; a change to code with full authority says nothing about
what it reaches; frequent alerts teach people to approve without reading);
reading code to find its reach (unsound); microVMs for source modules (file
watching across the mount, and their start-up cost in a sidebar); an allowlist
proxy without Seatbelt (code that ignores the proxy goes around it).
For images and links, also considered: trusting addresses already seen in the
chat (the agent writes its own tool calls, so one `echo`, file or issue
launders an address it composed) and loading when the agent read no secret
(secrets are more than keys, the agent knows things it did not read in the
chat, and a reshaped secret passes any scanner).

## Consequences

The target closes implicit requests to untrusted hosts from agent-written
content and limits project code to its approved reach. Confined modules lose
what lives outside the project:
keys from the shell environment (use a connection), command-line tools that
read the home folder or keychain (`gh`, `aws`: use a connection or a
workflow), and redirect targets they did not declare. Workflows that call APIs
declare their hosts. Confinement is macOS's; Linux needs bubblewrap or Landlock
before the desktop ships there. A full-access local agent can still send data
out during its own turn; the same proxy can confine agents' shells later.

This change delivers desktop chat link and image gates, safe row and chip
icons, confined source modules, and signed module and app approvals. Workflow
egress, content approvals for hooks, ACP commands and macros, module gateway
connections, the approvals management screen and mobile link prompts remain
follow-up implementation of the target above.
