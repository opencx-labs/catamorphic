import { describe, expect, it } from "vitest";
import {
  buildGithubAppManifest,
  convertGithubAppManifest,
  DEFAULT_GITHUB_APP_PERMISSIONS,
  githubAppManifestForm,
} from "../manifest.js";
import { revokeUserToken } from "../oauth.js";
import {
  githubRestRequest,
  githubRestUrl,
  repositoryFromRestPath,
} from "../rest.js";
import { GithubApiError } from "../types.js";

describe("GitHub App manifest flow", () => {
  it("builds a private manifest with events only when a webhook is set", () => {
    const quiet = buildGithubAppManifest({
      name: "Acme Work",
      url: "https://work.acme.test",
      redirectUrl: "https://work.acme.test/github/app/created",
    });
    expect(quiet).toEqual({
      name: "Acme Work",
      url: "https://work.acme.test",
      redirect_url: "https://work.acme.test/github/app/created",
      public: false,
      default_permissions: { ...DEFAULT_GITHUB_APP_PERMISSIONS },
      default_events: [],
    });
    const hooked = buildGithubAppManifest({
      name: "Acme Work",
      url: "https://work.acme.test",
      redirectUrl: "https://work.acme.test/github/app/created",
      callbackUrls: ["https://work.acme.test/api/connections/callback"],
      webhookUrl: "https://work.acme.test/api/webhooks/github",
      permissions: { metadata: "read", contents: "read" },
      events: ["push"],
    });
    expect(hooked.hook_attributes).toEqual({
      url: "https://work.acme.test/api/webhooks/github",
      active: true,
    });
    expect(hooked.default_events).toEqual(["push"]);
    expect(hooked.callback_urls).toEqual([
      "https://work.acme.test/api/connections/callback",
    ]);
  });

  it("posts the manifest to the user's or organization's app settings", () => {
    const manifest = buildGithubAppManifest({
      name: "Acme Work",
      url: "https://work.acme.test",
      redirectUrl: "https://work.acme.test/cb",
    });
    expect(githubAppManifestForm({ manifest, state: "s1" }).action).toBe(
      "https://github.com/settings/apps/new?state=s1",
    );
    const form = githubAppManifestForm({
      manifest,
      state: "s2",
      organization: "acme",
      webBaseUrl: "https://ghe.acme.test/",
    });
    expect(form.action).toBe(
      "https://ghe.acme.test/organizations/acme/settings/apps/new?state=s2",
    );
    expect(JSON.parse(form.fields.manifest)).toEqual(manifest);
    expect(() =>
      githubAppManifestForm({ manifest, state: "s", organization: "a/b" }),
    ).toThrow();
  });

  it("converts the returned code into app credentials", async () => {
    const calls: string[] = [];
    const registration = await convertGithubAppManifest({
      code: "abc123",
      fetch: (async (url: unknown, init?: RequestInit) => {
        calls.push(`${init?.method} ${String(url)}`);
        return Response.json(
          {
            id: 42,
            slug: "acme-work",
            name: "Acme Work",
            owner: { login: "acme" },
            html_url: "https://github.com/apps/acme-work",
            client_id: "Iv23acme",
            client_secret: "secret",
            webhook_secret: "hook",
            pem: "-----BEGIN RSA PRIVATE KEY-----",
          },
          { status: 201 },
        );
      }) as typeof fetch,
    });
    expect(calls).toEqual([
      "POST https://api.github.com/app-manifests/abc123/conversions",
    ]);
    expect(registration).toEqual({
      appId: "42",
      slug: "acme-work",
      name: "Acme Work",
      owner: "acme",
      htmlUrl: "https://github.com/apps/acme-work",
      clientId: "Iv23acme",
      clientSecret: "secret",
      webhookSecret: "hook",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----",
    });
    await expect(
      convertGithubAppManifest({ code: "../x", fetch: fetch }),
    ).rejects.toThrow(GithubApiError);
  });
});

describe("brokered REST requests", () => {
  it("keeps paths on the API and finds the repository they address", () => {
    expect(
      githubRestUrl({ path: "repos/o/r/pulls", query: { state: "all" } }),
    ).toBe("https://api.github.com/repos/o/r/pulls?state=all");
    expect(
      githubRestUrl({
        path: "/repos/o/r",
        apiBaseUrl: "https://ghe.acme.test/api/v3",
      }),
    ).toBe("https://ghe.acme.test/api/v3/repos/o/r");
    for (const path of [
      "/repos/../user",
      "/%2e%2e/user",
      "//evil.test/x",
      "/user?x=1",
      "\\user",
    ]) {
      expect(() => githubRestUrl({ path })).toThrow();
    }
    expect(repositoryFromRestPath("/repos/octo/hello/pulls/1")).toEqual({
      owner: "octo",
      name: "hello",
    });
    expect(repositoryFromRestPath("/repos/octo/hello")).toEqual({
      owner: "octo",
      name: "hello",
    });
    expect(repositoryFromRestPath("/user/repos")).toBeNull();
  });

  it("sends the token, never follows redirects, and parses JSON", async () => {
    const seen: RequestInit[] = [];
    const response = await githubRestRequest({
      token: "ghs_x",
      method: "POST",
      path: "/repos/o/r/issues",
      body: { title: "t" },
      fetch: (async (_url: unknown, init?: RequestInit) => {
        seen.push(init ?? {});
        return Response.json({ number: 1 }, { status: 201 });
      }) as typeof fetch,
    });
    expect(response).toEqual({
      status: 201,
      contentType: "application/json",
      body: { number: 1 },
      totalBytes: 12,
    });
    const headers = new Headers(seen[0]?.headers);
    expect(headers.get("authorization")).toBe("Bearer ghs_x");
    expect(seen[0]?.redirect).toBe("manual");
    expect(seen[0]?.body).toBe('{"title":"t"}');
    await expect(
      githubRestRequest({
        token: "t",
        method: "GET",
        path: "/x",
        accept: "text/html",
      }),
    ).rejects.toThrow(/media type/);
  });

  it("reads large bodies in ranges without splitting characters", async () => {
    const text = `${"a".repeat(9)}é${"b".repeat(10)}`; // é is two bytes.
    const read = (offset?: number) =>
      githubRestRequest({
        token: "t",
        method: "GET",
        path: "/repos/o/r/pulls/1",
        accept: "application/vnd.github.diff",
        maxResponseBytes: 10,
        ...(offset !== undefined ? { offset } : {}),
        fetch: (async () =>
          new Response(text, {
            headers: { "content-type": "text/plain" },
          })) as typeof fetch,
      });
    const first = await read();
    expect(first).toMatchObject({
      body: "a".repeat(9),
      truncated: true,
      nextOffset: 9,
      totalBytes: 21,
    });
    const second = await read(first.nextOffset);
    expect(second).toMatchObject({ body: `é${"b".repeat(8)}`, nextOffset: 19 });
    const last = await read(second.nextOffset);
    expect(last.body).toBe("bb");
    expect(last.truncated).toBeUndefined();
  });
});

describe("revokeUserToken", () => {
  it("authenticates as the OAuth client and tolerates already-revoked tokens", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(null, { status: seen.length === 1 ? 204 : 404 });
    }) as typeof fetch;
    const app = { clientId: "Iv1", clientSecret: "shh" };
    await revokeUserToken({ app, accessToken: "ghu_1", fetch: fetchImpl });
    await revokeUserToken({ app, accessToken: "ghu_1", fetch: fetchImpl });
    expect(seen[0]?.url).toBe("https://api.github.com/applications/Iv1/token");
    expect(new Headers(seen[0]?.init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("Iv1:shh").toString("base64")}`,
    );
    expect(seen[0]?.init?.body).toBe('{"access_token":"ghu_1"}');
    await expect(
      revokeUserToken({ app: { clientId: "Iv1" }, accessToken: "x" }),
    ).rejects.toThrow(/client secret/);
  });
});
