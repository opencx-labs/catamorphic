import { RUNNER_PROTOCOL_VERSION } from "@catamorphic/agent-protocol/runner";

/**
 * The protocol a worker states on every call (ADR 0196): the runner
 * protocol its sandboxes run, since the control plane drives their
 * runners through it.
 */
export const WORKER_PROTOCOL_HEADER = "work-protocol";

/** The protocol this control plane speaks, and the oldest it still drives. */
export const WORKER_PROTOCOL = {
  server: RUNNER_PROTOCOL_VERSION,
  minimum: RUNNER_PROTOCOL_VERSION,
} as const;

/** What a control plane answers a worker it cannot drive, with status 426. */
export interface UpgradeRequiredAnswer {
  error: string;
  code: "upgrade_required";
  serverProtocol: number;
  minimum: number;
}

/**
 * Whether a worker stating `stated` can be driven here; when not, the 426
 * answer naming which side to update.
 */
export function workerProtocolRefusal(
  stated: string | string[] | undefined,
): UpgradeRequiredAnswer | undefined {
  const raw = Array.isArray(stated) ? stated[0] : stated;
  const version = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
  if (
    version !== undefined &&
    version >= WORKER_PROTOCOL.minimum &&
    version <= WORKER_PROTOCOL.server
  )
    return undefined;
  const newer = version !== undefined && version > WORKER_PROTOCOL.server;
  return {
    error: newer
      ? `This worker speaks protocol ${version}, newer than the control plane's ${WORKER_PROTOCOL.server}. Update the control plane, or run the worker of its release.`
      : `This worker speaks protocol ${version ?? "unknown"}; the control plane needs at least ${WORKER_PROTOCOL.minimum}. Update the worker to the control plane's release.`,
    code: "upgrade_required",
    serverProtocol: WORKER_PROTOCOL.server,
    minimum: WORKER_PROTOCOL.minimum,
  };
}

/** What a worker says when the control plane answered 426. */
export function upgradeMessage(input: {
  own: number;
  serverProtocol: number;
  minimum: number;
}): string {
  return input.own > input.serverProtocol
    ? `The control plane speaks protocol ${input.serverProtocol} and this worker ${input.own}: update the control plane, or run the worker of its release. Retrying in a few minutes.`
    : `The control plane needs protocol ${input.minimum} or later and this worker speaks ${input.own}: update this worker to the control plane's release. Retrying in a few minutes.`;
}
