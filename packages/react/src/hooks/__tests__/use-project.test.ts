import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CatamorphicError } from "../../lib/errors.js";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { useProject } from "../use-project.js";

describe("useProject", () => {
  afterEach(() => server.resetHandlers());

  it("returns the project on happy path", async () => {
    const project = {
      id: "proj_123",
      name: "Test",
      storageType: "managed" as const,
      remoteUrl: null,
      defaultBranch: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      workflows: [],
      files: [],
    };
    server.use(
      http.get(apiUrl("/api/projects/proj_123"), () =>
        HttpResponse.json(project),
      ),
    );

    const { result } = renderHookWithProviders(() => useProject("proj_123"));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(project);
  });

  it("maps 404 into CatamorphicError with code=not_found", async () => {
    server.use(
      http.get(apiUrl("/api/projects/missing"), () =>
        HttpResponse.json({ error: "Not Found" }, { status: 404 }),
      ),
    );

    const { result } = renderHookWithProviders(() => useProject("missing"));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(CatamorphicError);
    expect(result.current.error?.code).toBe("not_found");
    expect(result.current.error?.status).toBe(404);
  });
});
