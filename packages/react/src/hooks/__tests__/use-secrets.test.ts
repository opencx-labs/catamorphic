import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { useDeleteProjectSecret } from "../use-delete-project-secret.js";
import { useProjectSecrets } from "../use-project-secrets.js";
import { useUpsertProjectSecret } from "../use-upsert-project-secret.js";

const SECRET = {
  name: "OPENAI_API_KEY",
  hasValue: true,
  updatedAt: new Date().toISOString(),
};

describe("useProjectSecrets", () => {
  it("returns secrets list", async () => {
    server.use(
      http.get(apiUrl("/api/projects/p1/secrets"), () =>
        HttpResponse.json([SECRET]),
      ),
    );
    const { result } = renderHookWithProviders(() => useProjectSecrets("p1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.name).toBe(SECRET.name);
  });

  it("maps 503 to sandbox_unavailable", async () => {
    server.use(
      http.get(apiUrl("/api/projects/p1/secrets"), () =>
        HttpResponse.json({ error: "down" }, { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useProjectSecrets("p1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe("sandbox_unavailable");
  });
});

describe("useUpsertProjectSecret / useDeleteProjectSecret", () => {
  it("upserts a secret", async () => {
    server.use(
      http.put(apiUrl(`/api/projects/p1/secrets/${SECRET.name}`), () =>
        HttpResponse.json(SECRET),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useUpsertProjectSecret("p1"),
    );
    const out = await result.current.mutateAsync({
      name: SECRET.name,
      value: "v",
    });
    expect(out.name).toBe(SECRET.name);
  });

  it("maps 400 on upsert to validation", async () => {
    server.use(
      http.put(apiUrl(`/api/projects/p1/secrets/${SECRET.name}`), () =>
        HttpResponse.json({ error: "bad" }, { status: 400 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useUpsertProjectSecret("p1"),
    );
    await expect(
      result.current.mutateAsync({ name: SECRET.name, value: "v" }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("deletes a secret", async () => {
    server.use(
      http.delete(apiUrl(`/api/projects/p1/secrets/${SECRET.name}`), () =>
        HttpResponse.json({ deleted: true }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useDeleteProjectSecret("p1"),
    );
    const out = await result.current.mutateAsync({ name: SECRET.name });
    expect(out.deleted).toBe(true);
  });

  it("maps delete 503", async () => {
    server.use(
      http.delete(apiUrl(`/api/projects/p1/secrets/${SECRET.name}`), () =>
        HttpResponse.json({ error: "down" }, { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useDeleteProjectSecret("p1"),
    );
    await expect(
      result.current.mutateAsync({ name: SECRET.name }),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
  });
});
