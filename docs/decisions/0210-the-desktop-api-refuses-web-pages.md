# 0210 — The desktop's loopback API refuses web pages

- **Status:** Accepted
- **Date:** 2026-10-06
- **Refines:** 0055, 0060, 0208

## Context

The desktop's embedded server answers every request on its loopback port as
the person at this computer (ADR 0055), with permissive CORS. Any web page
in any browser on the machine could find that port and use it: start agent
turns, read projects, and, through a remote project's routes, reach the
company server with the member's credentials. Terminals into remote
workspaces (ADR 0208) made that a remote shell.

## Decision

**The app's own windows carry a token.** Each run of the desktop draws a
random token. The main process adds it, as `x-work-desktop-token`, to every
request the app's windows (the default session) send to the embedded API,
and to no other port. Browser tabs use their profiles' sessions and never
receive it.

**Browser requests without it are refused.** A request a browser stamped
(an `Origin` or a `Sec-Fetch-Site` header, which browsers send with every
request to a loopback address) without the token gets 403, except a CORS
preflight, which clears nothing on its own, and a connection
authorization's return to the person's own browser. Local programs that
are not browsers (agent harnesses, scripts the person runs, code in a
local sandbox) send neither and pass as before: they already run as the
person. Node's own `fetch` sends `Sec-Fetch-Mode` alone, which marks no
browser. The main process's own callers (the phone's proxy, the
workflow-tools probe) send the token anyway. A `Host` other than the
loopback address is refused, which ends DNS rebinding.

**Previews serve only their own pages.** Each preview has a loopback host
of its own, `p-<id>.localhost` (the same across restarts), so its cookies
are its alone: cookies ignore ports, so on `127.0.0.1` every preview and
the person's own local servers would share one jar. A preview answers only
its own host and refuses every request from another site, a plain
cross-site link included (a foreign `Origin`, or `Sec-Fetch-Site` other
than `same-origin` and `none`); it forwards cookies only with its own
requests and drops a dev server's `Access-Control-*` headers, so no other
page reads it. Neither previews nor the remote proxy pass the token,
forwarding headers or the member's bearer on, except as the authorization
the server needs.

Considered: an allowlist of origins (the packaged renderer's origin is
`null`, which any sandboxed frame can also send) and a bearer every caller
must present (every local program would need it, and none of them is the
threat).

## Consequences

A web page cannot use the desktop's API or a preview, in any browser.
Clients that are not the app's windows and do send browser headers must be
given the token by the main process. A preview opens from the app, never
from another site's link, and cannot receive a cross-site form post, such
as an identity provider's `form_post` callback.

The token reaches every frame inside the app's windows, since they share
its session: MCP App views and app frames could reach the API before this
decision and still can. That remains a known limit.
