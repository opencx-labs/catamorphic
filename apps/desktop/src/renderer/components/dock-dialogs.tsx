import { useEffect, useState } from "react";
import { z } from "zod";
import { desktopApi } from "../lib/desktop-api.js";
import {
  ElicitationModal,
  type PendingElicitation,
} from "./elicitation-modal.js";

const elicitationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("url"), message: z.string(), url: z.string() }),
  z.object({
    mode: z.literal("form"),
    message: z.string(),
    fields: z.array(
      z.object({
        name: z.string(),
        type: z.enum(["string", "number", "integer", "boolean", "enum"]),
        title: z.string().optional(),
        description: z.string().optional(),
        required: z.boolean(),
        format: z.string().optional(),
        default: z.union([z.string(), z.number(), z.boolean()]).optional(),
        options: z
          .array(z.object({ value: z.string(), label: z.string() }))
          .optional(),
        multiSelect: z.boolean().optional(),
      }),
    ),
  }),
]);

/** A connector's native sign-in or form request, in the detached dock. */
export function DockDialogs({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const [elicitation, setElicitation] = useState<PendingElicitation | null>(
    null,
  );
  useEffect(
    () =>
      desktopApi.onBridgeRequest(({ id, method, params }) => {
        const label =
          typeof params.label === "string" ? params.label : undefined;
        if (method === "elicit") {
          const parsed = elicitationSchema.safeParse(params.request);
          if (!parsed.success) {
            desktopApi.bridgeRespond({ id, result: { action: "decline" } });
            return;
          }
          setElicitation({
            id: String(id),
            label,
            request: parsed.data,
            resolve: (result) => {
              setElicitation(null);
              desktopApi.bridgeRespond({ id, result });
            },
          });
          return;
        }
        desktopApi.bridgeRespond({ id, result: null });
      }),
    [],
  );
  useEffect(() => {
    onOpenChange(Boolean(elicitation));
  }, [elicitation, onOpenChange]);
  return (
    <div className="pointer-events-auto">
      <ElicitationModal
        pending={elicitation}
        onOpenUrl={(url) => {
          void desktopApi.dockSnapshot().then((snapshot) => {
            const chat =
              snapshot.chats.find(
                (item) => item.entry.localId === snapshot.activeChatId,
              ) ??
              snapshot.chats.find(
                (item) => item.projectId === snapshot.activeProjectId,
              );
            if (chat)
              void desktopApi.dockCommand({
                projectId: chat.projectId,
                localId: chat.entry.localId,
                event: {
                  kind: "link",
                  url,
                  modifiers: "replace",
                },
              });
          });
        }}
      />
    </div>
  );
}
