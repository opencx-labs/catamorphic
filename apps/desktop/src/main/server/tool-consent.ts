import type { ToolPermissionHandler, TurnOptions } from "@catamorphic/sandbox";

/** Consent uses the owning session's durable question and explicit choices. */
export async function askToolConsent({
  askQuestion,
  request,
  signal,
}: {
  askQuestion: NonNullable<TurnOptions["askQuestion"]>;
  request: Parameters<ToolPermissionHandler>[0];
  signal?: AbortSignal;
}): Promise<Awaited<ReturnType<ToolPermissionHandler>>> {
  const native = request.server === "codex";
  const action = native
    ? request.tool.includes("commandExecution")
      ? "run this command"
      : request.tool.includes("fileChange")
        ? "apply these file changes"
        : "use the requested access"
    : request.tool.replaceAll("_", " ");
  const command =
    native && typeof request.input.command === "string"
      ? request.input.command.slice(0, 1200)
      : undefined;
  const description = request.description?.trim();
  const question = [
    `May I ${action}${native ? "" : ` using ${request.server}`}?`,
    description && description !== "Codex requests permission"
      ? description
      : undefined,
    command,
    request.annotations?.destructiveHint
      ? "This action may change or delete data."
      : request.annotations?.readOnlyHint
        ? "This action only reads data."
        : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  const answer = await askQuestion({
    requestId: `permission:${crypto.randomUUID()}`,
    blocking: true,
    signal,
    questions: [
      {
        header: "Permission",
        question,
        multiSelect: false,
        options: [
          { label: "Allow once", description: "Allow this request only." },
          ...(native
            ? []
            : [
                {
                  label: "Always allow",
                  description: `Allow this tool on ${request.server}. You can change this in Connections.`,
                },
              ]),
          { label: "Deny", description: "Do not run this action." },
        ],
      },
    ],
  });
  if (signal?.aborted) return { decision: "deny" };
  if (answer === "Allow once") return { decision: "allow" };
  if (!native && answer === "Always allow")
    return { decision: "allow", remember: "always" };
  return { decision: "deny" };
}
