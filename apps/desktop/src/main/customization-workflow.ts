import type { CatamorphicCore, Identity } from "@catamorphic/core";
import { z } from "zod";
import type { SidebarSourceWorkCall } from "../shared/sidebar-source.js";
import {
  assertCustomizationRunAccess,
  privateWorkflowAddress,
} from "./customization-address.js";
/** The live source and isolated eval use the same workflow authority and dispatch. */
export async function customizationWorkflowCall({
  core,
  identity,
  projectId,
  workflows,
  call,
}: {
  core: Pick<CatamorphicCore, "runs" | "privateWorkflows">;
  identity: Identity;
  projectId: string;
  workflows: readonly string[];
  call: Extract<SidebarSourceWorkCall, { op: "call" | "start" | "poll-run" }>;
}): Promise<unknown> {
  if (call.op === "call" || call.op === "start") {
    if (!workflows.includes(call.workflow))
      throw new Error("This package cannot call that workflow.");
    const privateSource = privateWorkflowAddress(call.workflow);
    const privateRun = privateSource
      ? await core.privateWorkflows.run({
          identity,
          projectId,
          ...privateSource,
          input: z.json().parse(call.input ?? {}),
        })
      : null;
    const request = {
      identity,
      projectId,
      workflowName: call.workflow,
      input: z.json().parse(call.input ?? {}),
    };
    if (call.op === "start") {
      const run = privateRun ?? (await core.runs.triggerProduction(request));
      return { runId: run.id };
    }
    const outcome = privateRun
      ? await core.runs.driveInline({
          tenantId: identity.tenantId,
          runId: privateRun.id,
          deadline: Date.now() + 100_000,
        })
      : await core.runs.call({ ...request, budgetMs: 100_000 });
    if (outcome.status === "failed")
      throw new Error(outcome.error ?? "The workflow failed.");
    if (outcome.status === "suspended")
      throw new Error(
        `The workflow is waiting (run ${outcome.runId}). Use start() and its run handle for durable work.`,
      );
    return outcome.output;
  }
  if (call.op === "poll-run") {
    const run = await core.runs.get({ identity, runId: call.runId });
    if (run.projectId !== projectId)
      throw new Error("This package cannot read that workflow run.");
    assertCustomizationRunAccess({
      workflows,
      workflowName: run.workflowName,
      retained: await core.runs.retainedSource({
        identity,
        runId: call.runId,
      }),
    });
    return {
      runId: run.id,
      status: run.status,
      output: run.result,
      error: run.error,
    };
  }
  throw Error("Unsupported workflow operation.");
}
