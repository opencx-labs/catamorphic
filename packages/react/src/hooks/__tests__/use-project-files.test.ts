import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { useProjectFiles } from "../use-project-files.js";

describe("useProjectFiles", () => {
  it("refreshes a cached directory when a file surface mounts", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    let files = [{ path: "before.md", size: 1 }];
    let requests = 0;
    server.use(
      http.get(apiUrl("/api/projects/p1/files"), () => {
        requests += 1;
        return HttpResponse.json(files);
      }),
    );

    const first = renderHookWithProviders(() => useProjectFiles("p1"), {
      queryClient,
    });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(first.result.current.data).toEqual(files);
    first.unmount();

    files = [{ path: "after.md", size: 2 }];
    const second = renderHookWithProviders(() => useProjectFiles("p1"), {
      queryClient,
    });
    await waitFor(() =>
      expect(second.result.current.data).toEqual([
        { path: "after.md", size: 2 },
      ]),
    );
    expect(requests).toBe(2);
  });
});
