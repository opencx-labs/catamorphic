import type { OptimisticAgentMessage } from "../hooks/use-agent-chat.js";
import type { CatamorphicError } from "./errors.js";

/** Local delivery only. Execution and the inbox belong to the server. */
export interface ChatDeliveryState {
  scope: object;
  pending: string[];
  retrying: boolean;
  error: CatamorphicError | null;
  optimistic: OptimisticAgentMessage[];
  failed: OptimisticAgentMessage[];
}
export const initialChatDelivery = (scope: object): ChatDeliveryState => ({
  scope,
  pending: [],
  retrying: false,
  error: null,
  optimistic: [],
  failed: [],
});
export type ChatDeliveryEvent =
  | { type: "reset"; scope: object }
  | { type: "start"; scope: object; message: OptimisticAgentMessage }
  | { type: "accepted"; scope: object; id: string; messageId: string }
  | { type: "settled"; scope: object; id: string; accepted: boolean }
  | { type: "persisted"; scope: object; ids: ReadonlySet<string> }
  | { type: "error"; scope: object; error: CatamorphicError | null }
  | { type: "retry"; scope: object; active: boolean }
  | { type: "dismiss-failed"; scope: object; id: string };

export function chatDeliveryReducer(
  state: ChatDeliveryState,
  event: ChatDeliveryEvent,
): ChatDeliveryState {
  if (event.type === "reset") return initialChatDelivery(event.scope);
  if (event.scope !== state.scope) return state;
  switch (event.type) {
    case "start":
      if (state.pending.includes(event.message.id)) return state;
      return {
        ...state,
        error: null,
        pending: [...state.pending, event.message.id],
        optimistic: [...state.optimistic, event.message],
        failed: state.failed.filter((item) => item.id !== event.message.id),
      };
    case "accepted":
      return {
        ...state,
        optimistic: state.optimistic.map((item) =>
          item.id === event.id ? { ...item, id: event.messageId } : item,
        ),
      };
    case "settled": {
      if (!state.pending.includes(event.id)) return state;
      const failed = state.optimistic.find((item) => item.id === event.id);
      return {
        ...state,
        pending: state.pending.filter((id) => id !== event.id),
        optimistic: event.accepted
          ? state.optimistic
          : state.optimistic.filter((item) => item.id !== event.id),
        failed:
          !event.accepted && failed ? [...state.failed, failed] : state.failed,
      };
    }
    case "persisted": {
      const optimistic = state.optimistic.filter(
        (item) => !event.ids.has(item.id),
      );
      const failed = state.failed.filter((item) => !event.ids.has(item.id));
      return optimistic.length === state.optimistic.length &&
        failed.length === state.failed.length
        ? state
        : { ...state, optimistic, failed };
    }
    case "error":
      return { ...state, error: event.error };
    case "retry":
      return {
        ...state,
        retrying: event.active,
        ...(event.active ? { error: null } : {}),
      };
    case "dismiss-failed":
      return {
        ...state,
        failed: state.failed.filter((item) => item.id !== event.id),
      };
  }
}
