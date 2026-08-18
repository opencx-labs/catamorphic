import { describe, expect, it } from "vitest";
import { documentsCalls, hostNamespace } from "../context-calls.js";

describe("host call transitions (ADR 0055)", () => {
  it("context.host.<ns...>.<fn>(args) builds a host_call for the dotted capability", () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the untyped proxy the runtime hands workflows
    const host = hostNamespace([]) as Record<string, any>;
    expect(host.acme.crm.lookupCustomer({ id: "c1" })).toEqual({
      __catamorphicDurableTransition: "host_call",
      capability: "acme.crm",
      fn: "lookupCustomer",
      args: { id: "c1" },
    });
    expect(host.mail.send()).toEqual({
      __catamorphicDurableTransition: "host_call",
      capability: "mail",
      fn: "send",
      args: undefined,
    });
    // A bare function name has no capability to route to.
    expect(() => host.lookup({})).toThrow(/capability namespace/);
  });

  it("context.documents.* routes to the built-in documents capability", () => {
    const documents = documentsCalls();
    expect(Object.keys(documents).sort()).toEqual([
      "delete",
      "history",
      "list",
      "read",
      "search",
      "write",
    ]);
    expect(documents.read?.({ path: "docs/handbook.md" })).toEqual({
      __catamorphicDurableTransition: "host_call",
      capability: "catamorphic.documents",
      fn: "read",
      args: { path: "docs/handbook.md" },
    });
  });
});
