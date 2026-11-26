import type { DB } from "@catamorphic/db";
import {
  advertiseCheckout,
  openCheckoutSource,
  type ProjectManager,
  serveCheckout,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, sql } from "kysely";
import { hashBearer, randomBearer } from "./connections-service.js";
import {
  type GitGatewayResponse,
  grantFromAuthorization,
  gunzip,
} from "./git-gateway.js";

const tracer = getTracer("@catamorphic/core");
const encoder = new TextEncoder();

/*
 * A workspace's base over Git (ADR 0353). Work serves the commit a
 * workspace stands on from its session's copy, which holds it, at
 * `<gateway>/checkout/<id>`, to whoever presents the checkout's token:
 * the sandbox that is being given its base, for as long as that takes.
 * The remote holds that commit and its tree and nothing else, so the
 * token grants exactly what its holder is being handed, and it is revoked
 * when the checkout ends.
 */

/** How long a checkout may be fetched unless its issuer says otherwise. */
const DEFAULT_TTL_SECONDS = 15 * 60;
/** The longest any checkout stays fetchable. */
export const MAX_CHECKOUT_TTL_SECONDS = 4 * 60 * 60;

/** One checkout as its issuer holds it. */
export interface IssuedCheckout {
  id: string;
  /** Presented as a bearer; never stored. */
  token: string;
}

/** One smart HTTP request for a checkout. */
export interface CheckoutRequest {
  /** The checkout the path names. */
  id: string;
  operation: "advertise" | "upload-pack";
  /** The `Authorization` header as sent. */
  authorization: string | undefined;
  headers: Readonly<Record<string, string | undefined>>;
  body?: AsyncIterable<Uint8Array>;
}

class CheckoutRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CheckoutRefusal";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id no checkout has: a malformed one is looked up as this. */
const NO_CHECKOUT = "00000000-0000-0000-0000-000000000000";

/** What a fetch without a live checkout's token is told, through Git. */
const ENDED =
  "This checkout has ended. Work serves a workspace's base only while its checkout command runs: what a filtered or sparse checkout left out has to be fetched by that command (`checkout.command` of the Environment in .work/project.json).";

export class WorkspaceCheckoutsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: { projectManager: ProjectManager },
  ) {}

  /** Let one commit of a session's copy be fetched. */
  async issue(args: {
    tenantId: string;
    projectId: string;
    /** The session whose copy holds the commit (ADR 0322). */
    sessionId: string;
    commit: string;
    ttlSeconds?: number;
  }): Promise<IssuedCheckout> {
    const token = randomBearer();
    const ttl = Math.min(
      Math.max(1, args.ttlSeconds ?? DEFAULT_TTL_SECONDS),
      MAX_CHECKOUT_TTL_SECONDS,
    );
    // What ended a while ago is of no use to anyone.
    await this.db
      .deleteFrom("workspace_checkouts")
      .where("expires_at", "<", sql<Date>`now() - interval '1 day'`)
      .execute();
    const row = await this.db
      .insertInto("workspace_checkouts")
      .values({
        tenant_id: args.tenantId,
        project_id: args.projectId,
        session_id: args.sessionId,
        commit_sha: args.commit,
        token_hash: hashBearer(token),
        expires_at: sql<Date>`now() + make_interval(secs => ${ttl})`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { id: row.id, token };
  }

  /** End a checkout: its token stops working at once. Safe to repeat. */
  async revoke(args: { id: string }): Promise<void> {
    await this.db
      .updateTable("workspace_checkouts")
      .set({ revoked_at: sql<Date>`now()` })
      .where("id", "=", args.id)
      .where("revoked_at", "is", null)
      .execute();
  }

  /** Answer one smart HTTP request, or say why not. */
  async handle(request: CheckoutRequest): Promise<GitGatewayResponse> {
    try {
      return await withSpan(
        {
          tracer,
          name: "gateway.checkout",
          attributes: { "catamorphic.git.operation": request.operation },
        },
        () => this.serve(request),
      );
    } catch (error) {
      return refusal(error);
    }
  }

  private async serve(request: CheckoutRequest): Promise<GitGatewayResponse> {
    const token = grantFromAuthorization(request.authorization);
    const checkout = await this.db
      .selectFrom("workspace_checkouts")
      .select(["tenant_id", "project_id", "session_id", "commit_sha"])
      .where("id", "=", UUID.test(request.id) ? request.id : NO_CHECKOUT)
      .where("token_hash", "=", hashBearer(token ?? ""))
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    // 403, never 401: nobody signs in to a checkout, and Git shows the
    // person a 403's text where a 401 only asks them for a username.
    if (!token || !checkout) throw new CheckoutRefusal(403, ENDED);
    if (request.operation === "upload-pack" && !request.body)
      throw new CheckoutRefusal(400, "A request body is required");
    const repo = await this.deps.projectManager.openSession({
      tenantId: checkout.tenant_id,
      projectId: checkout.project_id,
      sessionId: checkout.session_id,
    });
    const source = await openCheckoutSource({
      repoPath: repo.repoPath,
      commit: checkout.commit_sha,
    }).catch(async (error: unknown) => {
      await repo.dispose();
      throw error;
    });
    const release = async () => {
      await source.dispose().catch(() => {});
      await repo.dispose().catch(() => {});
    };
    const body = request.body;
    const answer =
      request.operation === "advertise" || !body
        ? advertiseCheckout({ directory: source.directory })
        : serveCheckout({
            directory: source.directory,
            request: /gzip/i.test(request.headers["content-encoding"] ?? "")
              ? gunzip(body)
              : body,
          });
    return {
      status: 200,
      headers: {
        "content-type":
          request.operation === "advertise"
            ? "application/x-git-upload-pack-advertisement"
            : "application/x-git-upload-pack-result",
        "cache-control": "no-cache",
      },
      // The source lives exactly as long as its answer is being read.
      body: (async function* () {
        try {
          yield* answer;
        } finally {
          await release();
        }
      })(),
    };
  }
}

function refusal(error: unknown): GitGatewayResponse {
  const status = error instanceof CheckoutRefusal ? error.status : 502;
  if (!(error instanceof CheckoutRefusal))
    console.warn("[catamorphic] A checkout request failed", {
      errorType: error instanceof Error ? error.name : "Error",
    });
  return {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
    },
    body: encoder.encode(
      `${error instanceof CheckoutRefusal ? error.message : "Work could not serve this checkout"}\n`,
    ),
  };
}

/** The smart HTTP operation a checkout path names, and the checkout. */
export function checkoutTarget(input: {
  method: "GET" | "POST";
  /** The path below `<gateway>/checkout/`. */
  path: string;
  service: string | undefined;
}): { id: string; operation: CheckoutRequest["operation"] } | null {
  const path = input.path.replace(/^\/+|\/+$/g, "");
  const [id, ...rest] = path.split("/");
  const tail = rest.join("/");
  if (!id) return null;
  if (
    input.method === "GET" &&
    tail === "info/refs" &&
    input.service === "git-upload-pack"
  )
    return { id, operation: "advertise" };
  if (input.method === "POST" && tail === "git-upload-pack")
    return { id, operation: "upload-pack" };
  return null;
}
