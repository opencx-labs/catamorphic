# @catamorphic/github

GitHub mechanics for Catamorphic hosts: GitHub App authentication, user
OAuth, a REST client, and the brokered REST request the `github` connection
provider uses. The package holds no credentials and has no dependency on the
framework; hosts and `@catamorphic/server-sdk` pass credentials in per call.

## GitHub App authentication

A GitHub App is the organization's identity on GitHub: its private key signs
short-lived app JWTs, and app JWTs mint installation access tokens.

```ts
import { GithubAppAuth } from "@catamorphic/github";

const auth = new GithubAppAuth(); // { fetch?, apiBaseUrl?, now?, refreshSkewMs? }
const app = { appId: "12345", privateKey: pem };

// Null when the app is not installed on that account.
const installation = await auth.findInstallation({ app, owner: "acme" });
const { token, expiresAt } = await auth.installationToken({
  app,
  installationId: 77, // or installation.id
  repositories: ["website"],          // names, without the owner
  permissions: { contents: "read" },  // a subset of the installation's
});
```

- `createGithubAppJwt({ appId, privateKey, now? })` signs RS256 with
  `node:crypto`: issued 60 seconds in the past, expiring 9 minutes from now
  (GitHub's limit is 10), with the app ID (or client ID) as issuer.
- `installationToken` caches tokens per app key, installation, repositories,
  and permissions, shares one mint between concurrent callers, and mints
  again five minutes before expiry. The private key is part of the cache
  key, so material naming another app's ID with a different key never
  receives its tokens. Failures are not cached.
- `listInstallations`, `installation`, and `findInstallation({ owner,
  repository? })` discover where the app is installed.
- `revokeCachedTokens({ app })` revokes and forgets an app's cached tokens.

GitHub Enterprise Server: pass `apiBaseUrl: "https://HOST/api/v3"`.

## Registering an app (manifest flow)

For "Register your own app", a host builds a manifest, has the
administrator's browser POST it to GitHub, and converts the code GitHub
returns into the app's credentials:

```ts
const manifest = buildGithubAppManifest({
  name: "Acme Work",
  url: "https://work.acme.com",
  redirectUrl: "https://work.acme.com/github/app/created",
  callbackUrls: ["https://work.acme.com/api/connections/callback"],
  webhookUrl: "https://work.acme.com/api/webhooks/github", // optional
});
const form = githubAppManifestForm({ manifest, state, organization: "acme" });
// Render <form method="post" action={form.action}> with a hidden
// `manifest` field, check `state` on the redirect, then:
const registration = await convertGithubAppManifest({ code });
```

`registration` carries the app ID, slug, OAuth client ID and secret, webhook
secret, and PEM private key. GitHub returns them once; store them in the
vault immediately. `DEFAULT_GITHUB_APP_PERMISSIONS` asks for metadata read
and contents, pull requests, issues, and checks write.

## User OAuth

`requestDeviceCode`, `pollDeviceToken`, `buildAuthorizeUrl`, `exchangeCode`,
`refreshAccessToken`, and `revokeUserToken` implement user-to-server tokens
(device and web flow) for people who want actions attributed to themselves.

## Brokered REST

`githubRestRequest({ token, method, path, query?, body?, accept?, offset? })`
keeps the path below the API base (refusing `.` and `..` segments, `//`,
encoded separators, and queries in the path), never follows redirects, and returns large bodies in
byte ranges (`truncated`, `nextOffset`) split on UTF-8 boundaries.
`repositoryFromRestPath` finds the repository a path addresses so a minted
token can be narrowed to it.

## The `github` connection provider

`defineGithubConnectionProvider` lives in `@catamorphic/server-sdk`, which
depends on both this package and the framework's `ConnectionProvider`
contract (ADR 0162):

```ts
import { defineGithubConnectionProvider } from "@catamorphic/server-sdk";

const github = defineGithubConnectionProvider({
  oauth: { clientId, clientSecret }, // member connections; optional
  // kind, displayName, apiBaseUrl, webBaseUrl, maxResponseBytes, timeoutMs
});
const service = await github.authorizeApp({ appId, privateKey, owner: "acme" });
```

- **Service principal**: the App installation. `authorizeApp` checks the key,
  finds the installation, and returns the vault material. Authorizing a
  service connection asks the administrator for the same fields through a
  form challenge (the provider receives `principal: "service"`). Each call
  mints an installation token narrowed to the repository (and, for typed
  actions, the permissions) it needs.
- **Member principal**: the person's user-to-server token through the web
  flow (with a client secret) or the device flow, refreshed by `refresh`
  and revoked by `revoke`. A 401 marks the authorization expired.
- **Actions**: `get`, `post`, `put`, `patch`, `delete` on the REST API, plus
  `pull_request_files`, `create_review` (with inline comments),
  `create_check_run`, `update_check_run`, and `issue_comment`. Capabilities
  narrow them, so a role may grant `get` alone. Every action reaches only
  the repositories the broker passes as `repositories` (the binding's
  `git.repositories`, else the project's linked remote, as for Git); REST
  paths outside `/repos/{owner}/{name}` (GraphQL, search, organizations) are
  refused unless named in `unscopedRestPaths`. A `get` mints the
  installation's permissions at read level. Writes never touch the default
  branch: contents writes must name another branch, and refs and merges
  aimed at it are refused.
- **Git** (ADR 0175): `git.credentials({ material, remoteUrl, access })`
  returns HTTP credentials for one repository under `git.remoteBaseUrls`:
  an installation token with `contents: read` or `write` (username
  `x-access-token`), or the member's token. Only the control plane calls it;
  credentials never reach sandboxes.

## The GitHub code host

`githubCodeHost(github)` (ADR 0177) adds pull requests (open, list, read,
discussion, comment, files, review, merge) and repositories (list, read,
create) on top of the provider. Register both, and core's remote sync,
proposals, repository import, and publishing act through the caller's own
`github` connection or the organization's `github` service connection:

```ts
createCatamorphic({
  connectionProviders: [github],
  codeHosts: [githubCodeHost(github)],
  // ...
});
```

`authorizeUser({ tokens })` turns a token set a host obtained itself (the
`gh` CLI's, for example) into member material, and `accessToken` mints one
call's token for host code on the control plane, such as the desktop's
GitHub event poller.
