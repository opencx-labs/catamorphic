/**
 * postMessage protocol between an app bundle (guest) and the host-side
 * broker in `@catamorphic/ui`'s `AppMount`. The guest holds no credentials:
 * every message is re-authorized server-side against the app version's frozen
 * workflow set, so this protocol is a transport, not a trust boundary.
 */

import type {
  CollectionChange,
  CollectionItem,
  CollectionPage,
} from "./collection.js";
import type { AppHostTheme } from "./theme.js";

export interface AppSurface {
  kind: string;
  key?: string;
  projectId?: string;
  sessionId?: string;
  path?: string;
  selection?: boolean;
}
export type AppContentState =
  | "loading"
  | "empty"
  | "ready"
  | "error"
  | "unavailable";
export interface AppCollectionItem extends CollectionItem {
  label: string;
  description?: string;
  icon?: string;
  badges?: string[];
  progress?: number;
  actions?: {
    id: string;
    label: string;
    icon?: string;
    disabledReason?: string;
  }[];
  data?: Record<string, unknown>;
}
export interface AppCollectionRequest {
  source: string;
  parentId?: string | null;
  cursor?: string;
}
/** Hosts explicitly inject authorized sources. No guest holds an API credential. */
export interface AppCollections {
  read: (
    request: AppCollectionRequest & { signal: AbortSignal },
  ) => Promise<CollectionPage<AppCollectionItem>>;
  execute: (request: {
    source: string;
    itemId: string;
    action: string;
    signal: AbortSignal;
  }) => Promise<void>;
  subscribe?: (request: {
    source: string;
    publish: (change: CollectionChange<AppCollectionItem>) => void;
  }) => () => void;
}

export const APP_PROTOCOL_VERSION = 1;

export type GuestToHostMessage =
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      kind: "content-state";
      state: AppContentState;
    }
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      kind: "collection";
      callId: string;
      operation: "read" | "action" | "subscribe" | "unsubscribe";
      source: string;
      parentId?: string | null;
      cursor?: string;
      itemId?: string;
      action?: string;
    }
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
    }
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      /**
       * Full localStorage snapshot from the guest runtime's persistent shim
       * (debounced; last write wins). The mount persists it per (app, user).
       */
      kind: "storage";
      data: Record<string, string>;
    };

export interface AppDisplay {
  mode: "full" | "compact";
  visible: boolean;
  surface?: AppSurface;
}

export type HostToGuestMessage =
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      kind: "collection-change";
      source: string;
      change: CollectionChange<AppCollectionItem>;
    }
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      kind: "display";
      display: AppDisplay;
    }
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
    }
  | {
      catamorphicApp: typeof APP_PROTOCOL_VERSION;
      kind: "theme";
      theme: AppHostTheme;
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
