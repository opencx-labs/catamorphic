# A first brain on one machine

The shortest path from nothing to a Work brain an MCP client can connect
to and run work on, last verified end to end on 2026-09-25. Use it when the person wants
"a brain on this machine" and nothing exists yet. Adapt to what is present
(read [Work server](stock-server.md) first). Never print the operator
secret or a password.

## 1. Run the Work server image

Every Work release publishes a multi-architecture `work-server` image to the
GitHub Container Registry of the repository owner that publishes the Work
releases and Homebrew tap (see the repository README). Pull an exact version
for anything durable; `alpha` follows every release and `latest` follows
Stable releases. Without registry access, build the same image from a
checkout:

```bash
docker build -f apps/server/Dockerfile -t work-server .
docker run -d --name work-brain -v work-brain-data:/data -p 4700:4700 \
  -e ANTHROPIC_API_KEY=... work-server
curl -s http://127.0.0.1:4700/healthz
```

One of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` gives
the brain's agent a model; `WORK_FAKE_AGENT=1` runs a deterministic
echo agent for a dry run. Everything lives in the `/data` volume. Boot logs
print the API, docs, sign-in and setup locations, never a credential.

`WORK_PUBLIC_URL` must be HTTPS unless it is a loopback address; a
loopback default of `http://127.0.0.1:4700` is fine for a first brain on one
machine.

## 2. Provision the project and the first person

The setup listener is bound to loopback inside the container (port 4701),
so run these from inside it. The image has bun and git, not curl; `bun -e`
with `fetch` is the request tool. The operator secret is
`/data/operator-secret` (owner-only) unless the deployment sets
`WORK_OPERATOR_SECRET`. Read it into a variable; do not echo it.

Project with two roles and invitation-only admission. `admin` is for the
owner: every agent, workflow, and app plus every project permission (`"*"`).
`member` is the admission default: it chats with the project's agents and
nothing more, so a later invitation never hands out administration.
`environments: ["default"]` is what lets a role run agents on the server
itself; permissions alone grant no execution.

```bash
docker exec work-brain bun -e '
const secret = require("fs").readFileSync("/data/operator-secret", "utf8").trim();
const r = await fetch("http://127.0.0.1:4701/_work/operator/projects", {
  method: "POST",
  headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
  body: JSON.stringify({
    name: "Company brain",
    roles: [
      { slug: "admin", definition: { version: 1, name: "Admin", agents: ["*"], workflows: ["*"], apps: ["*"], permissions: ["*"], environments: ["default"] } },
      { slug: "member", definition: { version: 1, name: "Member", agents: ["*"], environments: ["default"] } },
    ],
    admission: { mode: "invitation_only", defaultRole: "member" },
  }),
});
console.log(r.status, await r.text());'
```

The response carries the project id. Then the first person, the owner, bound
to `admin` (local username and password; offer a configured OAuth provider
first when one exists):

```bash
docker exec work-brain bun -e '
const secret = require("fs").readFileSync("/data/operator-secret", "utf8").trim();
const r = await fetch("http://127.0.0.1:4701/_work/operator/users", {
  method: "POST",
  headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
  body: JSON.stringify({
    username: "USERNAME", name: "Full Name", password: "PASSWORD",
    memberships: [{ projectId: "PROJECT_ID", roles: ["admin"] }],
  }),
});
console.log(r.status, await r.text());'
```

Ask the person for the username and password rather than inventing them,
and pass them without writing them into shell history or a file.

## 3. Verify sign-in and connect an MCP client

- Sign-in page: `http://127.0.0.1:4700/login` (local form when local auth is
  on; provider buttons when providers are configured).
- The project's MCP door is `http://127.0.0.1:4700/api/projects/PROJECT_ID/mcp`
  (stateless Streamable HTTP). Unauthenticated requests answer 401 with
  `WWW-Authenticate: Bearer resource_metadata=…/.well-known/oauth-protected-resource`;
  clients discover the authorization server from there, register
  dynamically, and use authorization code with PKCE. The person signs in on
  the server's login page during that flow. Access tokens identify the
  person; project roles authorize each call.
- Claude Code: `claude mcp add --transport http work-brain http://127.0.0.1:4700/api/projects/PROJECT_ID/mcp`,
  then `/mcp` to sign in. Other MCP clients: add the same URL as a remote
  (HTTP) server.
- `initialize` returns instructions naming the tools this person has, and
  `project_overview` shows their roles, agents, Environments, workflows, and
  apps. An admin sees the whole builder's loop: `program_write`,
  `program_check`, `program_deploy`, `workflow_run`, and `run_details`, plus
  documents, skills, `ask_agent`, shares, and one tool per deployed
  `ai.tool-call` workflow.

## 4. Run a first workload

Prove the brain works before handing it over. From the connected client, as
the admin:

1. `ask_agent` with `agent: "assistant"` and a short message; the reply
   proves agents run (on a worker when the server runs agents only there).
2. Ask the client to add a small workflow with an `ai.tool-call` trigger,
   following the project's `catamorphic-projects` and `writing-workflows`
   skills, then `program_check`, `program_deploy`, and `workflow_run` it.
   The workflow then appears as its own tool.

[Working from your own agent](members-over-mcp.md) covers the loop and each
role's tools.

## 5. Hand over

Report the project id, the sign-in address, and the MCP URL. Invitations for
more people are created by a signed-in member holding `memberships:write`
through `POST /api/projects/PROJECT_ID/admission/invitations`; they are
credential-free locators that desktop, PWA and MCP clients redeem after
signing in. Ongoing configuration (roles, agents, sidebar, starting actions)
is project code under `.catamorphic/`, changed through ordinary review.

## Gotchas

- Build the image with the repository's Dockerfile as is: it installs with
  `--ignore-scripts` because a pinned helper package would otherwise try to
  run npm, and the image has only bun.
- The image has no `curl`; send setup requests with `bun -e` inside the
  container.
- The login and OAuth consent forms are browser pages and expect an `Origin`
  header. Scripts that drive them (tests, not people) must send one. The
  token endpoint accepts requests without it, as MCP clients send them.
