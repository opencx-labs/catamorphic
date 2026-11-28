import { PROJECT_DEPLOY_EVENT, PROJECT_EVENT_SOURCE } from "@catamorphic/core";
import { z } from "zod";
import { defineTriggerKind } from "./define-trigger-kind.js";

/**
 * The project's own events (ADR 0355): points in a project's lifecycle
 * where its workflows run, bound in their source like any trigger. Core
 * records them; a host registers the kinds so bindings validate.
 */

/**
 * `project.deploy`: a published revision is about to go live. Work records
 * it once per try of a revision, before the automations that follow `main`
 * move there, delivers it at that revision (the new commit's code, under
 * each automation's existing authority) and lets the revision go live only
 * once every run it started succeeded.
 */
const PROJECT_DEPLOY_KIND = defineTriggerKind({
  name: PROJECT_DEPLOY_EVENT,
  modes: ["async"],
  display: { label: "deploy", icon: "rocket" },
  description:
    "A published revision of this project is about to go live, and it waits for this workflow: Work records this event once per revision, before the automations that follow main move to it, and the revision goes live only once every run the event started has succeeded. input.payload.detail has commit (the revision) and previousCommit (the one that went live before it, or null). Use it to migrate what the new code needs. The run executes this workflow as the new revision declares it, under the authority its project automation was turned on with: a revision that changes what the workflow may use or what starts it needs consent first, and fails the deploy until it has it. A workflow hears it only while it is turned on as a project automation; several all run, and all must succeed. A run that fails, is canceled or runs past the deploy's time leaves every automation where it was, and the people who manage the project's automations are told why.",
  payload: z.object({
    id: z.string(),
    sequence: z.number(),
    projectId: z.string(),
    source: z.literal(PROJECT_EVENT_SOURCE),
    kind: z.literal(PROJECT_DEPLOY_EVENT),
    externalId: z.string(),
    occurredAt: z.string(),
    receivedAt: z.string(),
    payload: z.object({
      actor: z.record(z.string(), z.unknown()),
      causation: z.array(z.string()),
      detail: z.object({
        /** The published commit about to go live. */
        commit: z.string(),
        /** The commit that was live before it; null when none was. */
        previousCommit: z.string().nullable(),
      }),
    }),
  }),
  deliveryKey: (event) => event.id,
});

/** The project's own event kinds, for a host that runs workflows. */
export const PROJECT_TRIGGER_KINDS = [PROJECT_DEPLOY_KIND];
