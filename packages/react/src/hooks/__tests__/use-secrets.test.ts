import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { useDeleteProjectSecret } from "../use-delete-project-secret.js";
import {
  useDeleteMemberSecret,
  useSetMemberSecret,
} from "../use-member-secret.js";
import { useProjectSecrets } from "../use-project-secrets.js";
import { useUpsertProjectSecret } from "../use-upsert-project-secret.js";

const SECRET = {
  name: "OPENAI_API_KEY",
  required: true,
  source: "project",
  environments: ["dev"],
  shared: true,
  updatedAt: new Date().toISOString(),
  setBy: "ada",
  own: false,
  ownUpdatedAt: null,
  members: [],
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

describe("members' own values (ADR 0205)", () => {
  it("sets the caller's own value at members/me", async () => {
    let body: unknown;
    server.use(
      http.put(
        apiUrl(`/api/projects/p1/secrets/${SECRET.name}/members/me`),
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({
            name: SECRET.name,
            member: "ada",
            updatedAt: new Date().toISOString(),
          });
        },
      ),
    );
    const { result } = renderHookWithProviders(() => useSetMemberSecret("p1"));
    const out = await result.current.mutateAsync({
      name: SECRET.name,
      member: "me",
      value: "sk-own",
    });
    expect(out.member).toBe("ada");
    expect(body).toEqual({ value: "sk-own" });
  });

  it("clears another member's value", async () => {
    server.use(
      http.delete(
        apiUrl(`/api/projects/p1/secrets/${SECRET.name}/members/bob`),
        () => HttpResponse.json({ deleted: true }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useDeleteMemberSecret("p1"),
    );
    const out = await result.current.mutateAsync({
      name: SECRET.name,
      member: "bob",
    });
    expect(out.deleted).toBe(true);
  });

  it("maps a member who is not in the project to not_found", async () => {
    server.use(
      http.put(
        apiUrl(`/api/projects/p1/secrets/${SECRET.name}/members/eve`),
        () =>
          HttpResponse.json({ error: "eve is not a member" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useSetMemberSecret("p1"));
    await expect(
      result.current.mutateAsync({
        name: SECRET.name,
        member: "eve",
        value: "x",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
