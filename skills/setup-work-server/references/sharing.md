# Sharing with people outside the company

Use this when a Work server should give customers or partners a sign-in link
to specific material: a pilot tracker app, a status document, a folder of
deliverables (ADR 0165). They sign in, see exactly what was shared with them,
and never reach the brain itself.

## 1. A sign-in for guests

Add a provider with `"audience": "guests"` to the sign-in configuration. It is
offered only on share links:

```json
{
  "id": "customers",
  "label": "Your account",
  "discoveryUrl": "https://accounts.example.com/.well-known/openid-configuration",
  "clientId": "…",
  "clientSecret": "…",
  "audience": "guests"
}
```

Use the company's own product accounts if they speak OpenID Connect, or a
general provider such as Google or Microsoft (register the redirect URI
`<WORK_PUBLIC_URL>/api/auth/oauth2/callback/<id>`). The provider must return a
verified email; shares match on it. Guests never become members, never receive
API tokens, and never see agents or project files beyond their shares.

## 2. Keep each customer's material together

Organize by customer inside the brain: `customers/acme/…` documents and an
`acme-pilot` app. Create a separate project only when a customer needs its own
agents, workflows, or secrets.

## 3. Create a share

A member with `publications:write` calls
`POST /api/projects/:projectId/shares` with their bearer token:

```json
{
  "kind": "folder",
  "target": "customers/acme",
  "title": "Acme pilot",
  "audience": { "emails": ["dana@acme.com"], "domains": ["acme.com"] },
  "expiresAt": "2026-12-31T00:00:00Z"
}
```

`kind` is `document` (one file), `folder` (everything under a path), or `app`
(a published app by name). An app share names the `environment` its
workflows run in, which the creator must be allowed to use. The response's
`url` is the link to send. `GET` lists a project's shares; `DELETE
/api/projects/:projectId/shares/:shareId` withdraws one at once.

## 4. Verify

Open the link in a private window: it asks the person to sign in, then shows
the material. Sign in as someone outside the audience and confirm the link is
not available. Withdraw the share and confirm the page stops working.

Shared apps cannot use member connections, and markdown renders without raw
HTML. Keep anything sensitive out of shared folders; everything under a shared
folder is visible to its audience, including files added later.
