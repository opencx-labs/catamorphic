import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineHttpApiConnectionProvider,
  type HttpApiConnectionOptions,
} from "./http-connection-provider.js";

const KEY = new TextEncoder().encode("sk-live-secret");
const CONNECTION = { id: "connection", revision: 1 };

function provider(overrides: { paths?: string[] } = {}) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const api = defineHttpApiConnectionProvider({
    kind: "billing",
    displayName: "Billing",
    baseUrl: "https://api.billing.test/v1",
    ...overrides,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ ok: true, echo: url });
    },
  });
  return { api, requests };
}

describe("brokered HTTP API connections (ADR 0162)", () => {
  it("collects an API key through a secret form field and grants every method", async () => {
    const { api } = provider();
    const begun = await api.beginAuthorization?.({
      tenantId: "t",
      projectId: "p",
      externalUserId: "u",
      principal: "service",
      redirectUri: "https://work.test/cb",
      state: "s",
    });
    expect(begun?.challenge).toEqual({
      kind: "form",
      fields: [
        { name: "apiKey", label: "API key", secret: true, required: true },
      ],
    });
    const result = await api.completeAuthorization?.({
      tenantId: "t",
      projectId: "p",
      externalUserId: "u",
      principal: "service",
      callback: { apiKey: "  sk-live-secret " },
    });
    expect(new TextDecoder().decode(result?.material)).toBe("sk-live-secret");
    expect(result?.capabilities).toEqual([
      "get",
      "post",
      "put",
      "patch",
      "delete",
    ]);
  });

  it("adds the key for the configured origin only and returns the response", async () => {
    const { api, requests } = provider();
    const output = await api.invoke({
      material: KEY,
      action: "post",
      input: {
        path: "/invoices",
        query: { expand: "lines" },
        body: { amount: 10 },
      },
      capabilities: ["post"],
      connection: CONNECTION,
    });
    expect(requests[0]?.url).toBe(
      "https://api.billing.test/v1/invoices?expand=lines",
    );
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-live-secret");
    expect(requests[0]?.init.redirect).toBe("manual");
    expect(output).toMatchObject({ status: 200, body: { ok: true } });
    expect(JSON.stringify(output)).not.toContain("sk-live-secret");
  });

  it("offers code in sandboxes its base URL, paths and key headers (ADR 0211)", () => {
    const { api } = provider({ paths: ["/invoices"] });
    expect(api.http?.baseUrl).toBe("https://api.billing.test/v1");
    expect(api.http?.paths).toEqual(["/invoices"]);
    expect(api.http?.headers({ material: KEY })).toEqual({
      authorization: "Bearer sk-live-secret",
    });
    const custom = defineHttpApiConnectionProvider({
      kind: "events",
      displayName: "Events",
      baseUrl: "https://events.test/",
      auth: { header: "X-Api-Key" },
    });
    expect(custom.http?.baseUrl).toBe("https://events.test");
    expect(custom.http?.headers({ material: KEY })).toEqual({
      "x-api-key": "sk-live-secret",
    });
    // Named operations keep code to them: no route for any method or path.
    const named = defineHttpApiConnectionProvider({
      kind: "slack",
      displayName: "Slack",
      baseUrl: "https://slack.test/api",
      actions: [
        { name: "chat.postMessage", method: "post", path: "/chat.postMessage" },
      ],
    });
    expect(named.http).toBeUndefined();
  });

  it("sends a user:password key as HTTP Basic, for the agent's calls and code's", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const logs = defineHttpApiConnectionProvider({
      kind: "logs",
      displayName: "Logs",
      baseUrl: "https://logs.test:8443",
      auth: { basic: true },
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response("1\n", {
          headers: { "content-type": "text/plain" },
        });
      },
    });
    const begun = await logs.beginAuthorization?.({
      tenantId: "t",
      projectId: "p",
      externalUserId: "u",
      principal: "service",
      redirectUri: "https://work.test/cb",
      state: "s",
    });
    expect(begun?.challenge).toMatchObject({
      fields: [
        { name: "apiKey", label: "User and password, as user:password" },
      ],
    });
    const complete = (apiKey: string) =>
      logs.completeAuthorization?.({
        tenantId: "t",
        externalUserId: "u",
        principal: "service",
        callback: { apiKey },
      });
    await expect(complete("only-a-password")).rejects.toThrow("user:password");
    await expect(complete(":no-user")).rejects.toThrow("user:password");
    const stored = await complete("reader:pa:ss");
    const material = stored?.material ?? new Uint8Array();
    const basic = `Basic ${Buffer.from("reader:pa:ss").toString("base64")}`;
    expect(logs.http?.headers({ material })).toEqual({ authorization: basic });
    await logs.invoke({
      material,
      action: "get",
      input: { path: "/", query: { query: "SELECT 1" } },
      capabilities: ["get"],
      connection: CONNECTION,
    });
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe(
      basic,
    );
  });

  it("refuses paths, origins, and headers that could move the key elsewhere", async () => {
    const { api, requests } = provider({ paths: ["/invoices"] });
    const call = (input: Record<string, unknown>) =>
      api.invoke({
        material: KEY,
        action: "get",
        input: JSON.parse(JSON.stringify(input)),
        capabilities: ["get"],
        connection: CONNECTION,
      });
    await expect(call({ path: "/customers" })).rejects.toThrow("allowed paths");
    await expect(call({ path: "/invoices/../admin" })).rejects.toThrow("..");
    await expect(
      call({ path: "/invoices/%2e%2e/%2E%2e/admin" }),
    ).rejects.toThrow("encoded");
    // Path parameters a servlet container strips before resolving dots.
    for (const path of [
      "/invoices/.;/admin",
      "/invoices/..;/admin",
      "/invoices/%2e%2e%3b/admin",
    ])
      await expect(call({ path }), path).rejects.toThrow("dot segments");
    await expect(call({ path: "//evil.test/invoices" })).rejects.toThrow();
    await expect(
      call({ path: "/invoices", headers: { Authorization: "Bearer x" } }),
    ).rejects.toThrow("set by the gateway");
    await expect(
      call({ path: "/invoices", headers: { Host: "evil.test" } }),
    ).rejects.toThrow("set by the gateway");
    expect(requests).toHaveLength(0);
    await expect(call({ path: "/invoices/42" })).resolves.toMatchObject({
      status: 200,
    });
  });

  it("reads a body larger than one call in ranges, on whole characters", async () => {
    // 5 MiB of diff text with multi-byte characters straddling part ends.
    const line = "+ const café = 'ünïcødé';\n";
    const diff = line.repeat(
      Math.ceil((5 * 1024 * 1024) / new TextEncoder().encode(line).length),
    );
    const total = new TextEncoder().encode(diff).byteLength;
    const fetched: string[] = [];
    const api = defineHttpApiConnectionProvider({
      kind: "github",
      displayName: "GitHub",
      baseUrl: "https://api.github.test",
      maxResponseBytes: 1024 * 1024,
      fetch: async (url) => {
        fetched.push(url);
        return new Response(diff, {
          headers: { "content-type": "text/x-diff" },
        });
      },
    });
    const get = async (range?: { offset: number; length?: number }) =>
      z
        .object({
          status: z.number(),
          body: z.string(),
          truncated: z.literal(true).optional(),
          range: z
            .object({
              offset: z.number(),
              length: z.number(),
              nextOffset: z.number().optional(),
              totalBytes: z.number().optional(),
            })
            .optional(),
        })
        .parse(
          await api.invoke({
            material: KEY,
            action: "get",
            input: {
              path: "/repos/acme/app/pulls/7",
              ...(range ? { range } : {}),
            },
            capabilities: ["get"],
            connection: CONNECTION,
          }),
        );
    const parts: string[] = [];
    let next: number | undefined = 0;
    let first = true;
    while (next !== undefined) {
      const part = await get(first ? undefined : { offset: next });
      first = false;
      expect(part.range?.totalBytes).toBe(total);
      expect(part.range?.length).toBeLessThanOrEqual(1024 * 1024);
      expect(part.body).not.toContain("�");
      parts.push(part.body);
      next = part.range?.nextOffset;
      if (next !== undefined) expect(part.truncated).toBe(true);
    }
    expect(parts.length).toBeGreaterThanOrEqual(5);
    expect(parts.join("")).toBe(diff);
    // A short explicit range, and a range past the end.
    const small = await get({ offset: 0, length: 10 });
    expect(small.body).toBe(diff.slice(0, 10));
    const past = await get({ offset: total + 5 });
    expect(past).toMatchObject({
      body: "",
      range: { length: 0, totalBytes: total },
    });
    // A small body still comes back whole and parsed.
    const { api: small2 } = provider();
    await expect(
      small2.invoke({
        material: KEY,
        action: "get",
        input: { path: "/invoices" },
        capabilities: ["get"],
        connection: CONNECTION,
      }),
    ).resolves.not.toHaveProperty("range");
    await expect(
      small2.invoke({
        material: KEY,
        action: "post",
        input: { path: "/invoices", range: { offset: 0 } },
        capabilities: ["post"],
        connection: CONNECTION,
      }),
    ).rejects.toThrow("Only GET");
  });

  it("named actions make each operation its own capability (ADR 0179)", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const slack = defineHttpApiConnectionProvider({
      kind: "slack",
      displayName: "Slack",
      baseUrl: "https://slack.test/api",
      actions: [
        {
          name: "conversations.replies",
          method: "get",
          path: "/conversations.replies",
          description: "Read a thread",
        },
        { name: "chat.postMessage", method: "post", path: "/chat.postMessage" },
      ],
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({ ok: true });
      },
    });
    const authorized = await slack.completeAuthorization?.({
      tenantId: "t",
      externalUserId: "u",
      principal: "service",
      callback: { apiKey: "xoxb-bot" },
    });
    expect(authorized?.capabilities).toEqual([
      "conversations.replies",
      "chat.postMessage",
    ]);
    const listed = await slack.listActions?.({
      material: KEY,
      capabilities: ["chat.postMessage"],
    });
    expect(listed?.map((action) => action.name)).toEqual(["chat.postMessage"]);
    expect(listed?.[0]?.inputSchema).toMatchObject({
      properties: { body: {} },
      additionalProperties: false,
    });
    expect(listed?.[0]?.inputSchema).not.toHaveProperty("properties.path");
    expect(listed?.[0]?.annotations).toEqual({ readOnlyHint: false });

    const call = (action: string, input: Record<string, unknown>) =>
      slack.invoke({
        material: new TextEncoder().encode("xoxb-bot"),
        action,
        input: JSON.parse(JSON.stringify(input)),
        capabilities: ["conversations.replies", "chat.postMessage"],
        connection: CONNECTION,
      });
    await call("chat.postMessage", {
      body: { channel: "C1", thread_ts: "1.2", text: "Done" },
    });
    await call("conversations.replies", {
      query: { channel: "C1", ts: "1.2" },
    });
    expect(requests.map(({ url, init }) => [init.method, url])).toEqual([
      ["POST", "https://slack.test/api/chat.postMessage"],
      ["GET", "https://slack.test/api/conversations.replies?channel=C1&ts=1.2"],
    ]);
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer xoxb-bot");
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(requests[0]?.init.body).toBe(
      JSON.stringify({ channel: "C1", thread_ts: "1.2", text: "Done" }),
    );

    // The path is the action's; generic methods are not offered.
    await expect(
      call("chat.postMessage", { path: "/admin.users.remove", body: {} }),
    ).rejects.toThrow("path is fixed");
    await expect(call("post", { path: "/chat.postMessage" })).rejects.toThrow(
      "Unknown action",
    );
    expect(requests).toHaveLength(2);
  });

  it("counts a named action as read-only by its declared method (ADR 0176)", () => {
    const slack = defineHttpApiConnectionProvider({
      kind: "slack",
      displayName: "Slack",
      baseUrl: "https://slack.test/api",
      actions: [
        {
          name: "conversations.history",
          method: "get",
          path: "/conversations.history",
        },
        // Named like a read, but it writes.
        { name: "get", method: "post", path: "/chat.postMessage" },
      ],
    });
    expect(slack.readOnly?.("conversations.history")).toBe(true);
    expect(slack.readOnly?.("get")).toBe(false);
    expect(slack.readOnly?.("unknown")).toBe(false);
    const generic = provider().api;
    expect(generic.readOnly?.("get")).toBe(true);
    expect(generic.readOnly?.("post")).toBe(false);
  });

  it("refuses malformed named actions", () => {
    const define = (overrides: Partial<HttpApiConnectionOptions>) => () =>
      defineHttpApiConnectionProvider({
        kind: "slack",
        displayName: "Slack",
        baseUrl: "https://slack.test/api",
        ...overrides,
      });
    const post = { name: "chat.postMessage", method: "post" as const };
    expect(
      define({
        paths: ["/chat.postMessage"],
        actions: [{ ...post, path: "/chat.postMessage" }],
      }),
    ).toThrow("either actions or paths");
    expect(
      define({
        actions: [
          { ...post, path: "/chat.postMessage" },
          { ...post, path: "/chat.update" },
        ],
      }),
    ).toThrow("duplicate");
    expect(define({ actions: [{ ...post, path: "/a/../b" }] })).toThrow(
      "plain path",
    );
    expect(define({ actions: [{ ...post, path: "/a?b=c" }] })).toThrow(
      "plain path",
    );
    expect(
      define({ actions: [{ ...post, name: "has space", path: "/a" }] }),
    ).toThrow("invalid action name");
  });

  it("requires HTTPS for remote APIs", () => {
    expect(() =>
      defineHttpApiConnectionProvider({
        kind: "plain",
        displayName: "Plain",
        baseUrl: "http://api.example.test",
      }),
    ).toThrow("HTTPS");
  });
});
