import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineHttpApiConnectionProvider } from "./http-connection-provider.js";

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
