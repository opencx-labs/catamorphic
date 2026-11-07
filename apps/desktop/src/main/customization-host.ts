import { createHash } from "node:crypto";
import { rowTargetAllowed } from "../shared/sidebar.js";
import { customizationStateKey } from "./customization-address.js";
import { customizationWorkflowCall } from "./customization-workflow.js";
import type { EmbeddedServer } from "./server/boot.js";
import { DESKTOP_TENANT_ID, DESKTOP_USER_ID } from "./server/identity.js";
import type { SourceHostCall } from "./sidebar-source-ipc.js";

/** Main owns identity and credentials; sources receive only authorized values. */
export function customizationHost(getServer: () => EmbeddedServer | null) {
  return async ({
    profileId,
    viewId,
    viewSignal,
    projectId,
    modulePath,
    subject,
    workflows,
    call,
  }: SourceHostCall): Promise<unknown> => {
    const server = getServer();
    if (!server) throw new Error("Work's project runtime is unavailable.");
    const identity = {
      tenantId: DESKTOP_TENANT_ID,
      externalUserId: DESKTOP_USER_ID,
    };
    const owner = { profileId, projectId, modulePath, viewId, viewSignal };
    const core = server.catamorphic.core;
    if (call.op === "call" || call.op === "start" || call.op === "poll-run")
      return customizationWorkflowCall({
        core,
        identity,
        projectId,
        workflows,
        call,
      });
    if (call.op === "state-read") {
      const address = customizationStateKey({ subject, key: call.key });
      const snapshot = await core.privateState.read({
        identity,
        projectId,
        key: address,
      });
      return { ...snapshot, key: call.key, address };
    }
    if (call.op === "state-write") {
      const address = customizationStateKey({ subject, key: call.key });
      const snapshot = await core.privateState.write({
        identity,
        projectId,
        key: address,
        value: call.value,
        ifVersion: call.ifVersion,
      });
      return { ...snapshot, key: call.key, address };
    }
    if (call.op === "state-delete")
      return core.privateState.delete({
        identity,
        projectId,
        key: customizationStateKey({ subject, key: call.key }),
        ifVersion: call.ifVersion,
      });
    if (call.op === "notify") {
      if (call.route && !rowTargetAllowed(call.route))
        throw new Error(
          "A notification can only open a safe workspace target.",
        );
      return core.notifications.notify({
        identity,
        projectId,
        title: call.title,
        body: call.body,
        route: call.route,
        idempotencyKey: createHash("sha256")
          .update(`${subject}\0${call.idempotencyKey}`)
          .digest("hex"),
      });
    }
    if (call.op === "process-start")
      return server.customizationProcesses.start(owner, call);
    if (call.op === "process-list")
      return server.customizationProcesses.list(owner);
    if (call.op === "process-read")
      return server.customizationProcesses.read(owner, call);
    if (call.op === "process-stop")
      return server.customizationProcesses.stop(owner, call);
    throw new Error("Unsupported customization operation.");
  };
}
