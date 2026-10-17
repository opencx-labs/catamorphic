import { chipBoard } from "../lib/chip-board.js";
import {
  capabilitiesOf,
  childrenOf,
  pageOf,
  type SectionSource,
} from "./contract.js";

/**
 * `work:chips` (ADR 0239): the chips Work gives the chat a request names,
 * as that chat publishes them. One parent's chips at a time, like any
 * source: the roots, or the chips inside a group. Its actions are the
 * chat's own (a ✕ forgets a pull request or closes a tab).
 */
export function chipsSource(): SectionSource {
  const source: SectionSource = {
    title: "Chips",
    empty: "No chips yet.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId, cursor, session }) =>
      pageOf(
        childrenOf(
          (session && chipBoard.read(session.id)?.rows) || [],
          parentId,
        ),
        cursor,
        1000,
      ),
    subscribe: (publish, { session }) =>
      session
        ? chipBoard.subscribe({
            sessionId: session.id,
            listener: () => publish({ type: "invalidate", quiet: true }),
          })
        : () => {},
    action: async ({ itemId, action, values, session }) => {
      const chips = session ? chipBoard.read(session.id) : undefined;
      if (!chips) throw new Error("This chat is not open here.");
      return chips.act({ itemId, action, ...(values ? { values } : {}) });
    },
  };
  return source;
}
