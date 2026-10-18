import { describe, expect, it } from "vitest";
import {
  connectionNamespace,
  documentsCalls,
  hostNamespace,
} from "../context-calls.js";

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

describe("calls that carry state (ADR 0260)", () => {
  it("records { state } beside every kind of call, and nothing without it", () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the untyped proxies the runtime hands workflows
    const host = hostNamespace([]) as Record<string, any>;
    // biome-ignore lint/suspicious/noExplicitAny: as above
    const connections = connectionNamespace([]) as Record<string, any>;
    expect(host.acme.crm.lookup({ id: "c1" }, { state: { turn: 1 } })).toEqual({
      __catamorphicDurableTransition: "host_call",
      capability: "acme.crm",
      fn: "lookup",
      args: { id: "c1" },
      statePresent: true,
      state: { turn: 1 },
    });
    expect(
      connections.github.get({ path: "/repos/a/b" }, { state: null }),
    ).toEqual({
      __catamorphicDurableTransition: "connection_call",
      alias: "github",
      action: "get",
      args: { path: "/repos/a/b" },
      statePresent: true,
      state: null,
    });
    expect(connections.slack.chat.postMessage({ text: "x" })).toEqual({
      __catamorphicDurableTransition: "connection_call",
      alias: "slack",
      action: "chat.postMessage",
      args: { text: "x" },
    });
    expect(
      documentsCalls().read?.({ path: "docs/a.md" }, { state: ["a"] }),
    ).toMatchObject({ fn: "read", statePresent: true, state: ["a"] });
  });

  it("refuses a second argument that is not { state }", () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the untyped proxy
    const connections = connectionNamespace([]) as Record<string, any>;
    for (const options of [null, 1, [], {}, { stat: 1 }, { state: 1, x: 2 }])
      expect(
        () => connections.github.get({ path: "/x" }, options),
        JSON.stringify(options),
      ).toThrow(/second argument is \{ state \}/);
  });
});
