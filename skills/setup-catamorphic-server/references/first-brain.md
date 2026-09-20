# A first brain on one machine

The shortest honest path from nothing to a Work brain an MCP client can
connect to, verified end to end on 2026-09-20. Use it when the person wants
"a brain on this machine" and nothing exists yet. Adapt to what is present
(read [Stock server](stock-server.md) first); never print the operator
secret or a password.

## 1. Build and run the stock image

From a checkout of the repository:

```bash
docker build -f apps/server/Dockerfile -t catamorphic-server .
docker run -d --name work-brain -v work-brain-data:/data -p 4700:4700 \
  -e ANTHROPIC_API_KEY=... catamorphic-server
curl -s http://127.0.0.1:4700/healthz
```

One of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` gives
the brain's agent a model; `CATAMORPHIC_FAKE_AGENT=1` runs a deterministic
echo agent for a dry run. Everything lives in the `/data` volume. Boot logs
print the API, docs, sign-in and setup locations, never a credential.

`CATAMORPHIC_PUBLIC_URL` must be HTTPS unless it is a loopback address; a
loopback default of `http://127.0.0.1:4700` is fine for a first brain on one
machine.

## 2. Provision the project and the first person

The setup listener is bound to loopback inside the container (port 4701),
so run these from inside it. The image has bun and git, not curl; `bun -e`
with `fetch` is the request tool. The operator secret is
`/data/operator-secret` (owner-only). Read it into a variable; do not echo it.

Project with one explicit role and invitation-only admission. `environments:
["local"]` is what lets the role run agents on the server itself; builder
status alone grants no execution.

```bash
docker exec work-brain bun -e '
const secret = require("fs").readFileSync("/data/operator-secret", "utf8").trim();
const r = await fetch("http://127.0.0.1:4701/_catamorphic/operator/projects", {
  method: "POST",
  headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
  body: JSON.stringify({
    name: "Company brain",
    roles: [{ slug: "member", definition: { version: 1, name: "Member", builder: true, environments: ["local"] } }],
    admission: { mode: "invitation_only", defaultRole: "member" },
  }),
});
console.log(r.status, await r.text());'
```

The response carries the project id. Then the first ordinary user, bound to
that role (local username and password; offer a configured OAuth provider
first when one exists):

```bash
docker exec work-brain bun -e '
const secret = require("fs").readFileSync("/data/operator-secret", "utf8").trim();
const r = await fetch("http://127.0.0.1:4701/_catamorphic/operator/users", {
  method: "POST",
  headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
  body: JSON.stringify({
    username: "USERNAME", name: "Full Name", password: "PASSWORD",
    memberships: [{ projectId: "PROJECT_ID", roles: ["member"] }],
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
- `tools/list` after sign-in returns the project's documents, sessions,
  skills, publication and `ask_agent` tools, plus one tool per AI-callable
  workflow the project declares.

## 4. Hand over

Report the project id, the sign-in address, and the MCP URL. Invitations for
more people are created with the signed-in user's own identity through
`POST /api/projects/PROJECT_ID/admission/invitations`; they are
credential-free locators that desktop, PWA and MCP clients redeem after
signing in. Ongoing configuration (roles, agents, sidebar, starting actions)
is project code under `.catamorphic/`, changed through ordinary review.

## What went wrong on the first run, so it does not again

- The image build failed before any Work code ran: a pinned `node` helper
  package tried to run npm during `bun install`. The Dockerfile now installs
  with `--ignore-scripts`; every build in the image runs under bun.
- `curl` is not in the image; requests to the loopback setup listener go
  through `bun -e` inside the container.
- The login form and the OAuth consent form are browser pages: they expect
  an `Origin` header. Scripts that drive them (a test, not a person) must
  send one; the token endpoint itself accepts requests without it, as MCP
  clients send them.
