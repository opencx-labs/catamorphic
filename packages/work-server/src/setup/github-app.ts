import { randomBytes } from "node:crypto";
import {
  type CatamorphicCore,
  type Identity,
  UndeclaredSecretError,
} from "@catamorphic/core";
import {
  buildGithubAppManifest,
  convertGithubAppManifest,
  type GithubAppRegistration,
  type GithubConnectionProvider,
  githubAppManifestForm,
} from "@catamorphic/server-sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyWorkOperatorSecret } from "./operator-access.js";

/** What issue #107 asks of the Work GitHub App. */
export const WORK_GITHUB_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  checks: "write",
  issues: "write",
  metadata: "read",
  members: "read",
} as const;

export const WORK_GITHUB_APP_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_suite",
  "check_run",
  "push",
] as const;

/** The project secret the GitHub trigger library verifies deliveries with. */
export const GITHUB_WEBHOOK_SECRET = "GITHUB_WEBHOOK_SECRET";

const StartInput = z.strictObject({
  /** App name shown on GitHub; unique across GitHub. */
  name: z.string().trim().min(1).max(34),
  /** Register under this organization instead of the signed-in account. */
  organization: z
    .string()
    .regex(/^[\w.-]+$/)
    .optional(),
  /** Point the App's webhook at this project's `github` webhook URL. */
  projectId: z.string().uuid().optional(),
  /** The service connection the App becomes. Default `github`. */
  connection: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/)
    .default("github"),
  /** Allow installation on other accounts. Default false. */
  public: z.boolean().default(false),
});

interface PendingRegistration {
  input: z.infer<typeof StartInput>;
  expiresAt: number;
  app?: GithubAppRegistration;
}

const TTL_MS = 60 * 60 * 1000;

/**
 * Register a GitHub App from a manifest and connect it as a service
 * connection (ADR 0177). The operator starts it on the loopback listener and
 * opens the returned one-time URL in a browser on this machine: the page
 * posts the manifest to GitHub, GitHub returns here with a code that becomes
 * the App's credentials, the operator installs the App, and the installation
 * becomes the `github` service connection. The App's webhook points at a
 * project's `github` webhook URL when a project is named, with its secret
 * stored as that project's `GITHUB_WEBHOOK_SECRET`.
 */
export function registerGithubAppSetup(args: {
  app: FastifyInstance;
  operatorSecret: string;
  operatorIdentity: Identity;
  core: () => CatamorphicCore;
  provider: GithubConnectionProvider;
  /** The public origin, for the webhook and OAuth callback URLs. */
  publicBase: string;
  now?: () => number;
}): void {
  const pending = new Map<string, PendingRegistration>();
  const now = args.now ?? Date.now;
  const identity = args.operatorIdentity;
  const base = "/_work/operator/github/app";
  const origin = (request: FastifyRequest) =>
    `${request.protocol}://${request.host}`;
  const take = (state: string): PendingRegistration | undefined => {
    for (const [key, entry] of pending)
      if (entry.expiresAt <= now()) pending.delete(key);
    return pending.get(state);
  };

  args.app.post(base, async (request, reply) => {
    const authorization = request.headers.authorization;
    if (
      !verifyWorkOperatorSecret(
        Array.isArray(authorization) ? authorization[0] : authorization,
        args.operatorSecret,
      )
    )
      return reply.status(401).send({ error: "Operator credential required" });
    const input = StartInput.safeParse(request.body ?? {});
    if (!input.success)
      return reply.status(400).send({
        error: input.error.issues[0]?.message ?? "Invalid input",
      });
    if (input.data.projectId) {
      const project = await args
        .core()
        .projects.get(identity, input.data.projectId)
        .catch(() => undefined);
      if (!project)
        return reply.status(404).send({ error: "Project not found" });
    }
    const state = randomBytes(24).toString("base64url");
    const expiresAt = now() + TTL_MS;
    pending.set(state, { input: input.data, expiresAt });
    return reply.status(201).send({
      url: `${origin(request)}${base}/${state}`,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  });

  // The browser legs carry no operator credential: the unguessable,
  // one-hour state in the path is the bearer, issued to the operator.
  const Params = z.object({ state: z.string().min(20) });

  args.app.get(`${base}/:state`, async (request, reply) => {
    const params = Params.safeParse(request.params);
    const entry = params.success ? take(params.data.state) : undefined;
    if (!params.success || !entry) return expired(reply);
    const state = params.data.state;
    const { input } = entry;
    const webhookUrl = input.projectId
      ? `${args.publicBase}/api${await args.core().webhooks.endpointPath({
          identity,
          projectId: input.projectId,
          name: "github",
        })}`
      : undefined;
    const here = `${origin(request)}${base}/${state}`;
    const manifest = buildGithubAppManifest({
      name: input.name,
      url: args.publicBase,
      description:
        "Work: projects, agents, and automations for this organization.",
      redirectUrl: `${here}/created`,
      setupUrl: `${here}/installed`,
      callbackUrls: [
        `${args.publicBase}/api/connection-authorizations/callback`,
      ],
      ...(webhookUrl ? { webhookUrl } : {}),
      public: input.public,
      permissions: WORK_GITHUB_APP_PERMISSIONS,
      events: WORK_GITHUB_APP_EVENTS,
    });
    const form = githubAppManifestForm({
      manifest,
      state,
      ...(input.organization ? { organization: input.organization } : {}),
      webBaseUrl: args.provider.api.webBaseUrl,
    });
    return reply.type("text/html; charset=utf-8").send(
      page({
        title: "Register the GitHub App",
        body: `<p>Continue on GitHub to create <strong>${escape(
          input.name,
        )}</strong>${input.organization ? ` for ${escape(input.organization)}` : ""}.</p>
<form id="manifest" method="post" action="${escape(form.action)}">
<input type="hidden" name="manifest" value="${escape(form.fields.manifest)}">
<button type="submit">Continue on GitHub</button>
</form>
<script>document.getElementById("manifest").submit();</script>`,
      }),
    );
  });

  args.app.get(`${base}/:state/created`, async (request, reply) => {
    const params = Params.safeParse(request.params);
    const query = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .safeParse(request.query);
    const entry = params.success ? take(params.data.state) : undefined;
    if (
      !params.success ||
      !entry ||
      !query.success ||
      query.data.state !== params.data.state
    )
      return expired(reply);
    try {
      entry.app = await convertGithubAppManifest({
        code: query.data.code,
        fetch: args.provider.api.fetch,
        apiBaseUrl: args.provider.api.baseUrl,
      });
    } catch (error) {
      return reply
        .status(502)
        .type("text/html; charset=utf-8")
        .send(
          page({
            title: "GitHub did not return the App",
            body: `<p>${escape(error instanceof Error ? error.message : "The conversion failed")}. Start again from the operator API.</p>`,
          }),
        );
    }
    return reply.redirect(
      `${args.provider.api.webBaseUrl}/apps/${encodeURIComponent(
        entry.app.slug,
      )}/installations/new?state=${encodeURIComponent(params.data.state)}`,
    );
  });

  args.app.get(`${base}/:state/installed`, async (request, reply) => {
    const params = Params.safeParse(request.params);
    const query = z
      .object({ installation_id: z.coerce.number().int().positive() })
      .safeParse(request.query);
    const entry = params.success ? take(params.data.state) : undefined;
    const app = entry?.app;
    if (!params.success || !entry || !app || !query.success)
      return expired(reply);
    const core = args.core();
    const connections = core.connections;
    if (!connections)
      return reply
        .status(503)
        .send({ error: "Connections are not configured" });
    const name = entry.input.connection;
    try {
      const existing = (await connections.listServices({ identity })).find(
        (connection) =>
          connection.name === name &&
          connection.principalKind === "tenant_service",
      );
      const connection =
        existing ??
        (await connections.createService({
          identity,
          name,
          providerKind: args.provider.kind,
          principalKind: "tenant_service",
          label: `${app.name} (GitHub App)`,
        }));
      if (connection.providerKind !== args.provider.kind)
        throw new Error(
          `The service connection '${name}' belongs to another provider`,
        );
      const started = await connections.beginServiceAuthorization({
        identity,
        connectionId: connection.id,
        redirectUri: `${args.publicBase}/api/connection-authorizations/callback`,
      });
      await connections.completeAuthorization({
        identity,
        state: started.authorizationId,
        callback: {
          appId: app.appId,
          privateKey: app.privateKey,
          installationId: String(query.data.installation_id),
        },
      });
    } catch (error) {
      return reply
        .status(502)
        .type("text/html; charset=utf-8")
        .send(
          page({
            title: "The App could not be connected",
            body: `<p>${escape(error instanceof Error ? error.message : "Connecting failed")}</p>`,
          }),
        );
    }
    pending.delete(params.data.state);
    const secretNote = await storeWebhookSecret({
      core,
      identity,
      projectId: entry.input.projectId,
      secret: app.webhookSecret,
    });
    return reply.type("text/html; charset=utf-8").send(
      page({
        title: "GitHub is connected",
        body: `<p><strong>${escape(app.name)}</strong> is installed and connected as the <code>${escape(
          name,
        )}</code> service connection. Bind it in <code>.work/project.json</code> to give agents and workflows GitHub, and sync and pull requests use it now.</p>${secretNote}`,
      }),
    );
  });
}

/**
 * Store the App's webhook secret as the project's GITHUB_WEBHOOK_SECRET.
 * A project that does not declare it yet gets the value once, to set after
 * its trigger library lands.
 */
async function storeWebhookSecret(args: {
  core: CatamorphicCore;
  identity: Identity;
  projectId: string | undefined;
  secret: string | null;
}): Promise<string> {
  if (!args.projectId || !args.secret) return "";
  try {
    if (!args.core.secrets)
      throw new UndeclaredSecretError(GITHUB_WEBHOOK_SECRET);
    await args.core.secrets.upsert({
      identity: args.identity,
      projectId: args.projectId,
      name: GITHUB_WEBHOOK_SECRET,
      value: args.secret,
    });
    return `<p>The webhook secret is stored as the project's <code>${GITHUB_WEBHOOK_SECRET}</code>.</p>`;
  } catch (error) {
    if (!(error instanceof UndeclaredSecretError)) throw error;
    return `<p>The project does not declare <code>${GITHUB_WEBHOOK_SECRET}</code> yet. Declare it with the GitHub trigger library, then set it to this value, shown only now:</p><pre>${escape(
      args.secret,
    )}</pre>`;
  }
}

function expired(reply: FastifyReply): FastifyReply {
  return reply
    .status(404)
    .type("text/html; charset=utf-8")
    .send(
      page({
        title: "This link has expired",
        body: "<p>Start the GitHub App registration again from the operator API.</p>",
      }),
    );
}

function page(args: { title: string; body: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(
    args.title,
  )}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}pre{white-space:pre-wrap;word-break:break-all}</style></head><body><h1>${escape(
    args.title,
  )}</h1>${args.body}</body></html>`;
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
