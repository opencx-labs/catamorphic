import { useEffect, useState } from "react";
import { z } from "zod";
import { desktopApi } from "../lib/desktop-api.js";
import {
  ElicitationModal,
  type PendingElicitation,
} from "./elicitation-modal.js";
import {
  type PendingToolPermission,
  ToolPermissionModal,
} from "./tool-permission-modal.js";

const permissionSchema = z.object({
  server: z.string(),
  tool: z.string(),
  description: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  annotations: z
    .object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
    })
    .optional(),
});
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

/** Native presentation participates in the same one-recipient consent routing. */
export function DockDialogs({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const [permissions, setPermissions] = useState<PendingToolPermission[]>([]);
  const [elicitation, setElicitation] = useState<PendingElicitation | null>(
    null,
  );
  useEffect(
    () =>
      desktopApi.onBridgeRequest(({ id, method, params }) => {
        const label =
          typeof params.label === "string" ? params.label : undefined;
        if (method === "toolPermissionCancel") {
          setPermissions((items) =>
            items.filter((item) => item.askId !== params.askId),
          );
          return;
        }
        if (method === "toolPermission") {
          const parsed = permissionSchema.safeParse(params.request);
          if (!parsed.success) {
            desktopApi.bridgeRespond({ id, result: { decision: "deny" } });
            return;
          }
          setPermissions((items) => [
            ...items,
            {
              id: String(id),
              askId: id,
              label,
              request: parsed.data,
              resolve: (result) => {
                setPermissions((items) =>
                  items.filter((item) => item.askId !== id),
                );
                desktopApi.bridgeRespond({ id, result });
              },
            },
          ]);
          return;
        }
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
    onOpenChange(Boolean(permissions.length || elicitation));
  }, [permissions.length, elicitation, onOpenChange]);
  return (
    <div className="pointer-events-auto">
      <ToolPermissionModal
        pending={permissions[0] ?? null}
        queued={Math.max(0, permissions.length - 1)}
      />
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
