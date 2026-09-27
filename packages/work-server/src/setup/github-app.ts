import { createHash, randomBytes } from "node:crypto";
import {
  type CatamorphicCore,
  type CredentialVault,
  type Identity,
  UndeclaredSecretError,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import {
  buildGithubAppManifest,
  convertGithubAppManifest,
  type GithubAppRegistration,
  type GithubConnectionProvider,
  githubAppManifestForm,
} from "@catamorphic/server-sdk";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Kysely } from "kysely";
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

type RegistrationInput = z.infer<typeof StartInput>;

const StoredInput = StartInput;
const StoredApp = z.object({
  appId: z.string(),
  slug: z.string(),
  name: z.string(),
  owner: z.string().nullable(),
  htmlUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  webhookSecret: z.string().nullable(),
  privateKey: z.string(),
});

const TTL_MS = 60 * 60 * 1000;

function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/**
 * Registrations in progress, in the database so any replica continues one
 * (the link's state is stored only as its hash). Each browser leg claims
 * its step with one conditional update, so it runs once; the App's
 * credentials between creation and installation are sealed in the vault.
 */
function registrationStore(args: {
  db: Kysely<DB>;
  vault: CredentialVault;
  tenantId: string;
  now: () => number;
}) {
  const { db, vault, tenantId } = args;
  const at = () => new Date(args.now());
  const dropApp = async (ref: string | null) => {
    if (ref) await vault.delete({ tenantId, ref: { id: ref } }).catch(() => {});
  };
  /** Move `state` from one step to the next; null when it is not there. */
  const claim = async (
    state: string,
    from: "pending" | "created",
    to: "converting" | "installing",
  ) =>
    db
      .updateTable("work_github_app_registrations")
      .set({ status: to })
      .where("state_hash", "=", stateHash(state))
      .where("tenant_id", "=", tenantId)
      .where("status", "=", from)
      .where("expires_at", ">", at())
      .returning(["input", "app_ref"])
      .executeTakeFirst();
  return {
    async start(input: RegistrationInput): Promise<{
      state: string;
      expiresAt: Date;
    }> {
      const expired = await db
        .deleteFrom("work_github_app_registrations")
        .where("tenant_id", "=", tenantId)
        .where("expires_at", "<=", at())
        .returning("app_ref")
        .execute();
      for (const row of expired) await dropApp(row.app_ref);
      const state = randomBytes(24).toString("base64url");
      const expiresAt = new Date(args.now() + TTL_MS);
      await db
        .insertInto("work_github_app_registrations")
        .values({
          state_hash: stateHash(state),
          tenant_id: tenantId,
          input: JSON.stringify(input),
          expires_at: expiresAt,
        })
        .execute();
      return { state, expiresAt };
    },
    /** A registration still waiting for GitHub to create its App. */
    async pending(state: string): Promise<RegistrationInput | undefined> {
      const row = await db
        .selectFrom("work_github_app_registrations")
        .select("input")
        .where("state_hash", "=", stateHash(state))
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "pending")
        .where("expires_at", ">", at())
        .executeTakeFirst();
      return row ? StoredInput.parse(row.input) : undefined;
    },
    /** Claim the one conversion of GitHub's code into the App. */
    async claimCreation(state: string): Promise<boolean> {
      return Boolean(await claim(state, "pending", "converting"));
    },
    async created(state: string, app: GithubAppRegistration): Promise<void> {
      const ref = await vault.put({
        tenantId,
        material: new TextEncoder().encode(JSON.stringify(app)),
      });
      await db
        .updateTable("work_github_app_registrations")
        .set({ status: "created", app_slug: app.slug, app_ref: ref.id })
        .where("state_hash", "=", stateHash(state))
        .where("tenant_id", "=", tenantId)
        .execute();
    },
    /** Claim the installation step: the App and what was asked for. */
    async claimInstallation(state: string): Promise<
      | {
          input: RegistrationInput;
          app: GithubAppRegistration;
        }
      | undefined
    > {
      const row = await claim(state, "created", "installing");
      if (!row?.app_ref) return undefined;
      const ref = { id: row.app_ref };
      const app = await vault.withMaterial({
        tenantId,
        ref,
        use: (material) =>
          StoredApp.parse(JSON.parse(new TextDecoder().decode(material))),
      });
      return { input: StoredInput.parse(row.input), app };
    },
    /** Let the person try installing again. */
    async release(state: string): Promise<void> {
      await db
        .updateTable("work_github_app_registrations")
        .set({ status: "created" })
        .where("state_hash", "=", stateHash(state))
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "installing")
        .execute();
    },
    /** Forget a registration and its sealed App credentials. */
    async finish(state: string): Promise<void> {
      const rows = await db
        .deleteFrom("work_github_app_registrations")
        .where("state_hash", "=", stateHash(state))
        .where("tenant_id", "=", tenantId)
        .returning("app_ref")
        .execute();
      for (const row of rows) await dropApp(row.app_ref);
    },
  };
}

/**
 * Register a GitHub App from a manifest and connect it as a service
 * connection (ADR 0177). The operator starts it on the loopback listener and
 * hands a person the returned one-time link on the public origin: the page
 * posts the manifest to GitHub, GitHub returns with a code that becomes the
 * App's credentials, the person installs the App, and the installation
 * becomes the `github` service connection. The App's webhook points at a
 * project's `github` webhook URL when a project is named, with its secret
 * stored as that project's `GITHUB_WEBHOOK_SECRET` (a `use: "webhook"` secret
 * the trigger library declares: it verifies deliveries, never reaches a run).
 */
export function registerGithubAppSetup(args: {
  /** Loopback operator listener: starts a registration. */
  operatorApp: FastifyInstance;
  /** Public listener: the browser legs, authorized by the one-time state. */
  publicApp: FastifyInstance;
  operatorSecret: string;
  operatorIdentity: Identity;
  core: () => CatamorphicCore;
  provider: GithubConnectionProvider;
  /** The public origin, for the webhook and OAuth callback URLs. */
  publicBase: string;
  /** Where registrations in progress live, for every replica. */
  db: Kysely<DB>;
  /** Seals the App's credentials until its installation is connected. */
  vault: CredentialVault;
  now?: () => number;
}): void {
  const now = args.now ?? Date.now;
  const identity = args.operatorIdentity;
  const base = "/_work/github/app";
  const registrations = registrationStore({
    db: args.db,
    vault: args.vault,
    tenantId: identity.tenantId,
    now,
  });

  args.operatorApp.post(
    "/_work/operator/github/app",
    async (request, reply) => {
      const authorization = request.headers.authorization;
      if (
        !verifyWorkOperatorSecret(
          Array.isArray(authorization) ? authorization[0] : authorization,
          args.operatorSecret,
        )
      )
        return reply
          .status(401)
          .send({ error: "Operator credential required" });
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
      const { state, expiresAt } = await registrations.start(input.data);
      return reply.status(201).send({
        url: `${args.publicBase}${base}/${state}`,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  // The browser legs carry no operator credential: the unguessable,
  // one-hour state in the path is the bearer, issued to the operator.
  const Params = z.object({ state: z.string().min(20) });

  args.publicApp.get(`${base}/:state`, async (request, reply) => {
    const params = Params.safeParse(request.params);
    const input = params.success
      ? await registrations.pending(params.data.state)
      : undefined;
    if (!params.success || !input) return expired(reply);
    const state = params.data.state;
    const webhookUrl = input.projectId
      ? `${args.publicBase}/api${await args.core().webhooks.endpointPath({
          identity,
          projectId: input.projectId,
          name: "github",
        })}`
      : undefined;
    const here = `${args.publicBase}${base}/${state}`;
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
        body: `<p>Continue on GitHub to create <strong>${escapeHtml(
          input.name,
        )}</strong>${input.organization ? ` for ${escapeHtml(input.organization)}` : ""}.</p>
<form id="manifest" method="post" action="${escapeHtml(form.action)}">
<input type="hidden" name="manifest" value="${escapeHtml(form.fields.manifest)}">
<button type="submit">Continue on GitHub</button>
</form>
<script>document.getElementById("manifest").submit();</script>`,
      }),
    );
  });

  args.publicApp.get(`${base}/:state/created`, async (request, reply) => {
    const params = Params.safeParse(request.params);
    const query = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .safeParse(request.query);
    if (
      !params.success ||
      !query.success ||
      query.data.state !== params.data.state ||
      // One conversion per link: a replayed return finds nothing to claim.
      !(await registrations.claimCreation(params.data.state))
    )
      return expired(reply);
    const state = params.data.state;
    let app: GithubAppRegistration;
    try {
      app = await convertGithubAppManifest({
        code: query.data.code,
        fetch: args.provider.api.fetch,
        apiBaseUrl: args.provider.api.baseUrl,
      });
      await registrations.created(state, app);
    } catch (error) {
      await registrations.finish(state);
      return reply
        .status(502)
        .type("text/html; charset=utf-8")
        .send(
          page({
            title: "GitHub did not return the App",
            body: `<p>${escapeHtml(error instanceof Error ? error.message : "The conversion failed")}. Start again from the operator API.</p>`,
          }),
        );
    }
    return reply.redirect(
      `${args.provider.api.webBaseUrl}/apps/${encodeURIComponent(
        app.slug,
      )}/installations/new?state=${encodeURIComponent(state)}`,
    );
  });

  args.publicApp.get(`${base}/:state/installed`, async (request, reply) => {
    const params = Params.safeParse(request.params);
    const query = z
      .object({ installation_id: z.coerce.number().int().positive() })
      .safeParse(request.query);
    const claimed =
      params.success && query.success
        ? await registrations.claimInstallation(params.data.state)
        : undefined;
    if (!params.success || !query.success || !claimed) return expired(reply);
    const state = params.data.state;
    const { app, input } = claimed;
    const core = args.core();
    const connections = core.connections;
    if (!connections) {
      await registrations.release(state);
      return reply
        .status(503)
        .send({ error: "Connections are not configured" });
    }
    const name = input.connection;
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
      // The App exists; installing again may still connect it.
      await registrations.release(state);
      return reply
        .status(502)
        .type("text/html; charset=utf-8")
        .send(
          page({
            title: "The App could not be connected",
            body: `<p>${escapeHtml(error instanceof Error ? error.message : "Connecting failed")}</p>`,
          }),
        );
    }
    await registrations.finish(state);
    const secretNote = await storeWebhookSecret({
      core,
      identity,
      projectId: input.projectId,
      secret: app.webhookSecret,
    });
    return reply.type("text/html; charset=utf-8").send(
      page({
        title: "GitHub is connected",
        body: `<p><strong>${escapeHtml(app.name)}</strong> is installed and connected as the <code>${escapeHtml(
          name,
        )}</code> service connection. Bind it in <code>.work/project.json</code> to give agents and workflows GitHub, and sync and pull requests use it now.</p>${secretNote}${oauthNote(app)}`,
      }),
    );
  });
}

/**
 * The App's OAuth client, shown once: members sign in with their own GitHub
 * accounts through it (the server's `hooks.github.oauth`, the desktop's
 * device flow). Work keeps no copy; GitHub can issue a new client secret.
 */
function oauthNote(app: GithubAppRegistration): string {
  return `<p>For members to connect their own GitHub accounts, configure this App's OAuth client (<code>hooks.github.oauth</code>). It is shown only now:</p><pre>clientId: ${escapeHtml(
    app.clientId,
  )}\nclientSecret: ${escapeHtml(app.clientSecret)}</pre>`;
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
    return `<p>The project does not declare <code>${GITHUB_WEBHOOK_SECRET}</code> yet. Declare it with the GitHub trigger library, then set it to this value, shown only now:</p><pre>${escapeHtml(
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(
    args.title,
  )}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}pre{white-space:pre-wrap;word-break:break-all}</style></head><body><h1>${escapeHtml(
    args.title,
  )}</h1>${args.body}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
