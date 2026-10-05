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
(an `Origin` or a `Sec-Fetch-*` header) without the token gets 403, except
a CORS preflight, which clears nothing on its own, and a connection
authorization's return to the person's own browser. Local programs that
are not browsers (agent harnesses, the phone's proxy, scripts the person
runs) send neither and pass as before: they already run as the person. A
`Host` other than the loopback address is refused, which ends DNS
rebinding.

**Preview origins serve only their own pages.** A preview's loopback origin
refuses requests from another site (a foreign `Origin`, or `Sec-Fetch-Site`
other than `same-origin` and `none`) and drops a dev server's
`Access-Control-*` headers, so no other page reads it.

Considered: an allowlist of origins (the packaged renderer's origin is
`null`, which any sandboxed frame can also send) and a bearer every caller
must present (every local program would need it, and none of them is the
threat).

## Consequences

A web page cannot use the desktop's API or a preview, in any browser.
Clients that are not the app's windows and do send browser headers must be
given the token by the main process. A preview cannot receive a cross-site
form post, such as an identity provider's `form_post` callback.
