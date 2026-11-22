import { createHash } from "node:crypto";
import type { ScopedClient } from "@catamorphic/server-sdk";
import type { MachinesHook } from "@catamorphic/work-server";
import { z } from "zod";

interface Workflow {
  name: string;
  enablementId: string;
}

export interface WorkflowMachinesConfig {
  /** The host's scoped SDK client, authorized to use the selected enablements. */
  client: Pick<ScopedClient, "runs">;
  projectId: string;
  create: Workflow;
  destroy: Workflow;
  lifecycle?: { stop: Workflow; start: Workflow };
}

const Pending = z.strictObject({ pending: z.literal(true) });
const Create = z.union([
  z.strictObject({ ref: z.string().min(1) }),
  Pending,
  z.strictObject({ refused: z.string().min(1) }),
]);
const Done = z.strictObject({ done: z.boolean() });
const Start = z.union([Done, z.strictObject({ gone: z.literal(true) })]);

/** Run the infrastructure verbs through a project's consented workflows. */
export function workflowMachines(
  config: WorkflowMachinesConfig,
): Pick<MachinesHook, "create" | "destroy" | "stop" | "start"> {
  async function result<T>(args: {
    verb: string;
    workflow: Workflow;
    key: string;
    input: unknown;
    schema: z.ZodType<T>;
    complete: (answer: T) => boolean;
  }): Promise<T | undefined> {
    const { client, projectId } = config;
    const workflowName = args.workflow.name;
    const correlationKey = `machines:${args.verb}:${args.key}`;
    const {
      items: [latest],
    } = await client.runs.list({
      projectId,
      workflowName,
      correlationKey,
      limit: 1,
    });
    if (latest?.status === "completed") {
      const answer = args.schema.parse(latest.result);
      if (args.complete(answer)) return answer;
    } else if (
      latest &&
      latest.status !== "failed" &&
      latest.status !== "canceled"
    ) {
      return undefined;
    }

    // Every attempt has one delivery key even if the host or SDK client
    // stops after enrollment. A completed pending reply starts one more
    // attempt with the same cloud input and platform idempotency key.
    await client.runs.triggerWithEnablement({
      projectId,
      workflowName,
      enablementId: args.workflow.enablementId,
      input: z.json().parse(args.input),
      correlationKey,
      deliveryKey: `${correlationKey}:${latest?.id ?? "first"}`,
    });
    if (latest?.status === "failed")
      throw new Error(`Workflow ${workflowName} failed (run ${latest.id})`);
    return undefined;
  }

  function targetKey(target: {
    name: string;
    idempotencyKey: string | null;
    requestedAt: string;
  }) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          target.name,
          target.idempotencyKey,
          target.requestedAt,
        ]),
      )
      .digest("hex");
  }

  const lifecycle = config.lifecycle;
  return {
    create: async (input) =>
      (await result({
        verb: "create",
        workflow: config.create,
        key: input.enrollment.idempotencyKey,
        input,
        schema: Create,
        complete: (answer) => !("pending" in answer),
      })) ?? { pending: true },
    destroy: async (input) =>
      (await result({
        verb: "destroy",
        workflow: config.destroy,
        key: targetKey(input),
        input,
        schema: Done,
        complete: (answer) => answer.done,
      })) ?? { done: false },
    ...(lifecycle
      ? {
          stop: async (input) =>
            (await result({
              verb: "stop",
              workflow: lifecycle.stop,
              key: targetKey(input),
              input,
              schema: Done,
              complete: (answer) => answer.done,
            })) ?? { done: false },
          start: async (input) =>
            (await result({
              verb: "start",
              workflow: lifecycle.start,
              key: targetKey(input),
              input,
              schema: Start,
              complete: (answer) => "gone" in answer || answer.done,
            })) ?? { done: false },
        }
      : {}),
  };
}
