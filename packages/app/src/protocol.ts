/**
 * postMessage protocol between an app bundle (guest) and the host-side
 * broker in `@catamorphic/ui`'s `AppMount`. The guest holds no credentials:
 * every message is re-authorized server-side against the app version's frozen
 * workflow set, so this protocol is a transport, not a trust boundary.
 */

export const APP_PROTOCOL_VERSION = 1;

export type GuestToHostMessage =
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      kind: "call";
      callId: string;
      workflowName: string;
      /** "invoke" waits for the terminal result; "start" returns the run id. */
      mode: "invoke" | "start";
      input: unknown;
    }
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      kind: "poll-run";
      callId: string;
      runId: string;
    }
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      kind: "resize";
      height: number;
    };

export type HostToGuestMessage =
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      kind: "result";
      callId: string;
      ok: true;
      value: unknown;
    }
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      kind: "result";
      callId: string;
      ok: false;
      error: { message: string; code: AppCallErrorCode };
    }
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      kind: "context";
      context: AppContext;
    };

export type AppCallErrorCode =
  | "denied"
  | "workflow_failed"
  | "not_serializable"
  | "timeout"
  | "internal";

/**
 * Mount-time snapshot the host provides. Everything richer is one workflow
 * call away — deliberately minimal so the host never has to keep it fresh.
 */
export interface AppContext {
  tenantId: string;
  user: { id: string; name?: string };
  /** Host-defined extras (current record id, locale, theme, ...). */
  host?: Record<string, unknown>;
}

export interface RunSnapshot {
  runId: string;
  status:
    | "pending"
    | "running"
    | "waiting"
    | "paused"
    | "canceling"
    | "completed"
    | "failed"
    | "canceled";
  output: unknown;
  error: string | null;
  /** Batch progress counts when the workflow has batch scopes. */
  progress?: {
    discovered: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
}

export function isGuestMessage(value: unknown): value is GuestToHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { catamorphicApp?: unknown }).catamorphicApp ===
      APP_PROTOCOL_VERSION &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

export function isHostMessage(value: unknown): value is HostToGuestMessage {
  return isGuestMessage(value as GuestToHostMessage);
}

export class AppCallError extends Error {
  constructor(
    readonly code: AppCallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppCallError";
  }
}
