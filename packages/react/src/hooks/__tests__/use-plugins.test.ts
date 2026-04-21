import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { useAttachPlugin } from "../use-attach-plugin.js";
import { useDetachPlugin } from "../use-detach-plugin.js";
import { usePluginCatalog } from "../use-plugin-catalog.js";
import { useProjectPlugins } from "../use-project-plugins.js";

const PLUGIN = {
  packageName: "@catamorphic/example-plugin",
  version: "1.0.0",
  source: "npm" as const,
  displayName: "Example",
  description: "An example plugin",
  secrets: [],
};

describe("usePluginCatalog", () => {
  it("returns the catalog", async () => {
    server.use(
      http.get(apiUrl("/api/plugins/catalog"), () =>
        HttpResponse.json([PLUGIN]),
      ),
    );
    const { result } = renderHookWithProviders(() => usePluginCatalog());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.packageName).toBe(PLUGIN.packageName);
  });

  it("maps 503 to sandbox_unavailable", async () => {
    server.use(
      http.get(apiUrl("/api/plugins/catalog"), () =>
        HttpResponse.json({ error: "down" }, { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() => usePluginCatalog());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe("sandbox_unavailable");
  });
});

describe("useProjectPlugins", () => {
  it("returns attached plugins", async () => {
    server.use(
      http.get(apiUrl("/api/projects/p1/plugins"), () =>
        HttpResponse.json([
          {
            ...PLUGIN,
            attachedAt: new Date().toISOString(),
            secretStatus: [],
          },
        ]),
      ),
    );
    const { result } = renderHookWithProviders(() => useProjectPlugins("p1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it("maps 503 errors", async () => {
    server.use(
      http.get(apiUrl("/api/projects/p1/plugins"), () =>
        HttpResponse.json({ error: "down" }, { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useProjectPlugins("p1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe("sandbox_unavailable");
  });
});

describe("useAttachPlugin / useDetachPlugin", () => {
  it("attaches a plugin", async () => {
    server.use(
      http.post(apiUrl("/api/projects/p1/plugins"), () =>
        HttpResponse.json(
          { ...PLUGIN, attachedAt: new Date().toISOString(), secretStatus: [] },
          { status: 201 },
        ),
      ),
    );
    const { result } = renderHookWithProviders(() => useAttachPlugin("p1"));
    const out = await result.current.mutateAsync({
      packageName: PLUGIN.packageName,
    });
    expect(out.packageName).toBe(PLUGIN.packageName);
  });

  it("maps 404 on attach to not_found", async () => {
    server.use(
      http.post(apiUrl("/api/projects/p1/plugins"), () =>
        HttpResponse.json({ error: "missing" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useAttachPlugin("p1"));
    await expect(
      result.current.mutateAsync({ packageName: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("detaches a plugin", async () => {
    server.use(
      http.delete(apiUrl("/api/projects/p1/plugins/some-pkg"), () =>
        HttpResponse.json({ detached: true }),
      ),
    );
    const { result } = renderHookWithProviders(() => useDetachPlugin("p1"));
    const out = await result.current.mutateAsync({ packageName: "some-pkg" });
    expect(out.detached).toBe(true);
  });

  it("maps detach 404", async () => {
    server.use(
      http.delete(apiUrl("/api/projects/p1/plugins/some-pkg"), () =>
        HttpResponse.json({ error: "missing" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useDetachPlugin("p1"));
    await expect(
      result.current.mutateAsync({ packageName: "some-pkg" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
