import { randomUUID } from "node:crypto";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { RecordedEvent } from "@catamorphic/workflow";
import type { Kysely } from "kysely";
import { z } from "zod";
import { hasProjectPermission, type Identity } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type {
  CapabilityProviderRuntime,
  HostCallContext,
} from "./capability-providers.js";
import type { ProjectEventsService } from "./project-events-service.js";
import { requireAttemptTime } from "./run-abortable.js";
import type { TriggersService } from "./triggers-service.js";

/** The host calls on a project's events (ADR 0326). */
export const EVENTS_CAPABILITY = "catamorphic.events";

/** The most events one `record` call carries. */
export const MAX_RECORDED_EVENTS = 100;

/** The only host kind a project kind may build on to be recorded. */
const RECORDABLE_ROOT = "webhook";

const RecordSchema = z.strictObject({
  events: z
    .array(
      z.strictObject({
        kind: z.string().min(1).max(200),
        id: z.string().min(1).max(200),
        payload: z.record(z.string(), z.json()),
        occurredAt: z.iso.datetime({ offset: true }).optional(),
      }),
    )
    .min(1)
    .max(MAX_RECORDED_EVENTS),
});

/** A recorded event its kind would not deliver, or a kind it may not record. */
export class RecordedEventRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordedEventRefusedError";
  }
}

const tracer = getTracer("@catamorphic/core");

/**
 * `host["catamorphic.events"]` (ADR 0326): a workflow that declared
 * `events:write` records events of the project's own trigger kinds, and
 * they dispatch exactly like webhook deliveries. Each is checked against
 * its kind at the run's revision, bounded like a webhook body, stored once
 * per `(kind, id)`, and stamped with its `origin` and the run's causation,
 * so the recording workflow is never started by its own events.
 */
export function eventsCapability(deps: {
  db: Kysely<DB>;
  /** Read per call: the services are constructed after the registry. */
  events: () => ProjectEventsService;
  triggers: () => TriggersService;
  /** The host's webhook body limit, which bounds each payload too. */
  maxPayloadBytes: () => number;
  authorize(context: HostCallContext): Promise<Identity>;
}): CapabilityProviderRuntime {
  return {
    name: EVENTS_CAPABILITY,
    description:
      "Record events of the project's own trigger kinds, which start the workflows bound to them as a webhook delivery would",
    calls: {
      record: (context, args) =>
        withSpan(
          {
            tracer,
            name: "project.event.record",
            attributes: {
              "catamorphic.project.id": context.projectId,
              "catamorphic.run.id": context.runId,
              "catamorphic.workflow.name": context.workflowName,
            },
          },
          async (span) => {
            const parsed = RecordSchema.safeParse(args ?? {});
            if (!parsed.success)
              throw new RecordedEventRefusedError(
                `${EVENTS_CAPABILITY}.record: ${parsed.error.issues
                  .map((issue) =>
                    issue.path.length > 0
                      ? `${issue.path.join(".")}: ${issue.message}`
                      : issue.message,
                  )
                  .join("; ")}`,
              );
            const identity = await deps.authorize(context);
            if (
              !hasProjectPermission(identity, context.projectId, "events:write")
            )
              throw new AccessDeniedError(
                "Recording events needs events:write: declare it in the workflow's permissions",
              );
            const run = await deps.db
              .selectFrom("workflow_runs as run")
              .leftJoin(
                "workflow_enablements as enablement",
                "enablement.id",
                "run.workflow_enablement_id",
              )
              .leftJoin(
                "deployment_artifacts as artifact",
                "artifact.id",
                "run.deployment_artifact_id",
              )
              .select([
                "run.input",
                "run.workflow_enablement_id",
                "enablement.commit_sha as enablement_commit_sha",
                "enablement.remote_branch",
                "artifact.commit_sha as artifact_commit_sha",
              ])
              .where("run.id", "=", context.runId)
              .where("run.project_id", "=", context.projectId)
              .executeTakeFirstOrThrow();
            const commitSha =
              run.enablement_commit_sha ?? run.artifact_commit_sha;
            if (!commitSha)
              throw new RecordedEventRefusedError(
                "This run has no deployed revision whose trigger kinds it could record",
              );
            const kinds = new Map(
              (
                await deps.triggers().projectKindsAtCommit({
                  identity,
                  projectId: context.projectId,
                  commitSha,
                  remoteBranch: run.remote_branch ?? "main",
                })
              ).map((kind) => [kind.name, kind]),
            );
            const enablementId = run.workflow_enablement_id;
            // The run's own chain, then this enablement: the dispatcher
            // never delivers an event to an enablement already in it.
            const causation = [
              ...causationOf(run.input),
              ...(enablementId ? [enablementId] : []),
            ];
            const origin = {
              type: "workflow",
              workflowName: context.workflowName,
              runId: context.runId,
              ...(enablementId ? { enablementId } : {}),
            };
            const receivedAt = new Date().toISOString();
            const limit = deps.maxPayloadBytes();
            // Check every event before recording any.
            const prepared = parsed.data.events.map((event, index) => {
              const label = `events[${index}] (${event.kind} ${event.id})`;
              if (deps.triggers().isHostKind(event.kind))
                throw new RecordedEventRefusedError(
                  `${label}: '${event.kind}' is a host kind; a workflow records only the project's own kinds`,
                );
              const kind = kinds.get(event.kind);
              if (!kind)
                throw new RecordedEventRefusedError(
                  `${label}: '${event.kind}' is not a trigger kind of this project at the revision this run executes`,
                );
              if (kind.kind !== RECORDABLE_ROOT)
                throw new RecordedEventRefusedError(
                  `${label}: '${event.kind}' builds on '${kind.kind}'; only kinds over '${RECORDABLE_ROOT}' can be recorded`,
                );
              // A webhook that verifies its senders fires only on signed
              // requests unless the project opted its kind in.
              if (verifies(kind.config) && !kind.recordable)
                throw new RecordedEventRefusedError(
                  `${label}: only signed requests fire '${event.kind}', because its webhook declares verify; add recordable: true to the kind to let workflows record its events`,
                );
              const payload: JsonObject = {
                ...event.payload,
                origin,
                causation,
              };
              const bytes = Buffer.byteLength(JSON.stringify(payload));
              if (bytes > limit)
                throw new RecordedEventRefusedError(
                  `${label}: the payload is ${bytes} bytes; the limit is ${limit}`,
                );
              // Webhook delivery ids are `<name>:<delivery>`, and a webhook
              // name never holds '/', so these never meet one.
              const externalId = `recorded/${event.kind}/${event.id}`;
              const occurredAt = event.occurredAt
                ? new Date(event.occurredAt).toISOString()
                : receivedAt;
              const errors = deps.triggers().recordedEventErrors({
                kind,
                event: {
                  id: randomUUID(),
                  sequence: 0,
                  projectId: context.projectId,
                  source: kind.kind,
                  kind: kind.kind,
                  externalId,
                  occurredAt,
                  receivedAt,
                  payload,
                },
              });
              if (errors.length > 0)
                throw new RecordedEventRefusedError(
                  `${label} is not a '${event.kind}' event: ${errors.join("; ")}`,
                );
              return {
                event,
                root: kind.kind,
                externalId,
                occurredAt,
                payload,
              };
            });
            const recorded: RecordedEvent[] = [];
            for (const item of prepared) {
              requireAttemptTime(context);
              const { event, created } = await deps.events().append({
                projectId: context.projectId,
                source: item.root,
                kind: item.root,
                externalId: item.externalId,
                occurredAt: item.occurredAt,
                payload: item.payload,
              });
              recorded.push({
                kind: item.event.kind,
                id: item.event.id,
                eventId: event.id,
                created,
                occurredAt: event.occurredAt,
                receivedAt: event.receivedAt,
              });
            }
            span.setAttribute(
              "catamorphic.event.recorded_count",
              recorded.filter((event) => event.created).length,
            );
            return { events: recorded };
          },
        ),
    },
  };
}

/** Whether a webhook binding's config checks its senders. */
function verifies(config: Json): boolean {
  return (
    config !== null &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    config.verify !== undefined &&
    config.verify !== null
  );
}

/** The causation a run's triggering event carried (ADR 0219). */
function causationOf(input: Json | null): string[] {
  const event =
    input && typeof input === "object" && !Array.isArray(input)
      ? input.payload
      : null;
  return event &&
    typeof event === "object" &&
    !Array.isArray(event) &&
    Array.isArray(event.causation)
    ? event.causation.filter((id): id is string => typeof id === "string")
    : [];
}
