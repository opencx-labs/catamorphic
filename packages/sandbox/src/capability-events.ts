import type { AgentEvent } from "./types.js";

/** Present the operation, not its transport, in activity and MCP App references. */
export function capabilityEventPresenter() {
  const calls = new Map<string, { toolName: string; toolInput: unknown }>();
  return (event: AgentEvent): AgentEvent => {
    if (event.type !== "tool_call") return event;
    const input = event.toolInput;
    if (
      event.toolName?.endsWith("invoke_capability") &&
      input !== null &&
      typeof input === "object" &&
      "name" in input &&
      typeof input.name === "string"
    ) {
      const name = input.name;
      const connection = /^connections\.([^.]+)\.(.+)$/.exec(name);
      let connectionTool = connection?.[2] ?? "";
      try {
        connectionTool = decodeURIComponent(connectionTool);
      } catch {
        /* Preserve malformed external names as data. */
      }
      const operation = {
        toolName: connection
          ? `${connection[1]}/${connectionTool}`
          : name.replace(/^(workspace|project)\./, ""),
        toolInput: "input" in input ? input.input : {},
      };
      if (event.toolUseId) calls.set(event.toolUseId, operation);
      return { ...event, ...operation };
    }
    const operation = event.toolUseId ? calls.get(event.toolUseId) : undefined;
    return operation ? { ...event, ...operation } : event;
  };
}
