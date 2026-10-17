import { useCatamorphic } from "@catamorphic/react";
import { useEffect } from "react";
import { CHIPS_OWNER_ID } from "../../shared/workspace-config.js";
import { chipsSource } from "../sources/chips.js";
import { runRowAction } from "../sources/run.js";
import { callProjectWorkflow } from "../sources/workflow-call.js";
import { chipBoard } from "./chip-board.js";
import { desktopApi } from "./desktop-api.js";

/**
 * Answer a chips module's requests of Work (ADR 0239) in the window that
 * shows its chat: the chat's own chips (`work.read`, `work.execute` with
 * source "chips"), and the project workflows its grant names. Main checked
 * the grants and sends each call only to the window whose chips asked.
 */
export function useAnswerChipsWork() {
  const { apiClient } = useCatamorphic();
  useEffect(() => {
    const chips = chipsSource();
    return desktopApi.onSidebarSourceWork(
      ({ callId, projectId, sectionId, sessionId, call }) => {
        if (sectionId !== CHIPS_OWNER_ID) return;
        const signal = new AbortController().signal;
        const session = sessionId
          ? { id: sessionId, title: null, metadata: {} }
          : undefined;
        const answer = async (): Promise<unknown> => {
          if (call.op === "call")
            return callProjectWorkflow({
              apiClient,
              projectId,
              workflow: call.workflow,
              input: call.input,
            });
          if (call.source !== CHIPS_OWNER_ID)
            throw new Error("A chips module reads its chat's chips only.");
          if (call.op === "read")
            return chips.load({
              parentId: call.parentId ?? null,
              cursor: call.cursor,
              signal,
              ...(session ? { session } : {}),
            });
          const chat = sessionId ? chipBoard.read(sessionId) : undefined;
          const row = chat?.rows.find((chip) => chip.id === call.itemId);
          if (!chat || !row) throw new Error("This chip is no longer here.");
          await runRowAction({
            source: chips,
            row,
            itemId: call.itemId,
            action: call.action,
            ...(call.values ? { values: call.values } : {}),
            ...(session ? { session } : {}),
            signal,
            open: chat.open,
          });
          return null;
        };
        void answer().then(
          (value) =>
            void desktopApi.sidebarSourceWorkResult({
              callId,
              ok: true,
              value,
            }),
          (cause: unknown) =>
            void desktopApi.sidebarSourceWorkResult({
              callId,
              ok: false,
              error: cause instanceof Error ? cause.message : String(cause),
            }),
        );
      },
    );
  }, [apiClient]);
}
