import { describe, expect, it } from "vitest";
import { defineHttpApiConnectionProvider } from "./http-connection-provider.js";

const KEY = new TextEncoder().encode("sk-live-secret");

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
