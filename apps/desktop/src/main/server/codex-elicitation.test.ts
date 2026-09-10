import { expect, it, vi } from "vitest";
import type { WorkspaceBridge } from "../agent-bridge.js";
import { createCodexElicitation } from "./codex-elicitation.js";

const request = {
  serverName: "computer",
  mode: "form",
  message: "Allow Calculator?",
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    connector_id: "computer-use",
    tool_params: { app: "com.apple.calculator" },
    persist: ["session", "always"],
    riskLevel: "low",
  },
};
it("remembers explicit app consent only for the same server, app, risk and native session", async () => {
  const elicit = vi.fn<WorkspaceBridge["elicit"]>(async () => ({
    action: "accept",
    content: { catamorphic_remember_app: true },
  }));
  const handler = createCodexElicitation({ elicit });
  expect(await handler(request)).toEqual({ action: "accept", content: {} });
  await handler({
    ...request,
    _meta: { ...request._meta, tool_name: "click" },
  });
  expect(elicit).toHaveBeenCalledTimes(1);
  expect(elicit.mock.calls[0]?.[1]).toHaveProperty(
    "fields",
    expect.arrayContaining([
      expect.objectContaining({ type: "boolean", default: false }),
    ]),
  );
  await handler({ ...request, serverName: "another" });
  await handler({ ...request, _meta: { ...request._meta, riskLevel: "high" } });
  await handler({
    ...request,
    _meta: { ...request._meta, tool_params: { app: "com.apple.finder" } },
  });
  await createCodexElicitation({ elicit })(request);
  expect(elicit).toHaveBeenCalledTimes(5);
});
it("does not remember once-only, cancelled, or arbitrary MCP form answers", async () => {
  const abort = new AbortController();
  const elicit = vi.fn<WorkspaceBridge["elicit"]>(async () => ({
    action: "accept",
    content: {},
  }));
  const handler = createCodexElicitation({ elicit });
  await handler(request);
  await handler(request);
  expect(elicit).toHaveBeenCalledTimes(2);
  elicit.mockImplementationOnce(async () => {
    abort.abort();
    return { action: "accept", content: { catamorphic_remember_app: true } };
  });
  expect(await handler(request, abort.signal)).toEqual({ action: "cancel" });
  await handler(request);
  expect(elicit).toHaveBeenCalledTimes(4);
  const form = {
    ...request,
    requestedSchema: {
      type: "object",
      properties: { name: { type: "string" } },
    },
  };
  await handler(form);
  await handler(form);
  expect(elicit).toHaveBeenCalledTimes(6);
});
