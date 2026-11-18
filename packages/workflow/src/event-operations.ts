import type { TriggerKindName, TriggerKinds, TriggerPayload } from "./index.js";
import type { TransitionCall } from "./workflow.js";

/**
 * Kinds a workflow may record (ADR 0326): the project's own kinds over the
 * `webhook` host kind. The host refuses every other kind.
 */
export type RecordableTriggerKind = Exclude<
  {
    [Kind in TriggerKindName]: TriggerKinds[Kind] extends {
      payload: { source: "webhook" };
    }
      ? Kind
      : never;
  }[TriggerKindName],
  "webhook"
>;

type WithoutHostFields<Payload> = Payload extends object
  ? Omit<Payload, "origin" | "causation">
  : never;

/** What one recorded event of `Kind` carries; the host sets the rest. */
export interface RecordedEventInput<Kind extends TriggerKindName> {
  kind: Kind;
  /**
   * Stable for the change it describes (`pull_request:42:synchronize:<sha>`):
   * recording an id the project already has for this kind is a no-op.
   */
  id: string;
  /**
   * The event's `payload` as the kind's own events carry it, for a webhook
   * kind `{ name, headers, query, contentType, body }`. The host adds
   * `origin` and `causation`.
   */
  payload: WithoutHostFields<
    TriggerPayload<Kind> extends { payload: infer Inner } ? Inner : never
  >;
  /** When it happened, ISO 8601. Default: when it is recorded. */
  occurredAt?: string;
}

/** One recorded event, or the one the project already had for its id. */
export interface RecordedEvent {
  kind: string;
  id: string;
  /** The stored project event. */
  eventId: string;
  /** False when the project already had this id. */
  created: boolean;
  occurredAt: string;
  receivedAt: string;
}

/**
 * The project's events (ADR 0326), caller-bound like every host call. A run
 * records only when its workflow declared `events:write`. Recorded events
 * start the workflows bound to their kind exactly as a webhook delivery
 * would, never the recording workflow itself.
 */
export interface EventHostOperations {
  /** Record up to 100 events; each is checked against its kind first. */
  record: TransitionCall<
    {
      events: Array<
        {
          [Kind in RecordableTriggerKind]: RecordedEventInput<Kind>;
        }[RecordableTriggerKind]
      >;
    },
    { events: RecordedEvent[] }
  >;
}
