import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { useEnvironments } from "../use-environments.js";

describe("useEnvironments", () => {
  it("sends workload and agent policy context", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      http.get(apiUrl("/api/projects/p1/environments"), ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({
          items: [
            {
              name: "company",
              label: "Company",
              available: true,
              compatible: true,
              preferred: true,
              allowed: true,
              reasons: [],
            },
          ],
          defaultEnvironment: "company",
        });
      }),
    );
    const { result } = renderHookWithProviders(() =>
      useEnvironments("p1", { workload: "agent", agentId: "brain" }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(query?.get("workload")).toBe("agent");
    expect(query?.get("agentId")).toBe("brain");
    expect(result.current.data?.items[0]?.name).toBe("company");
  });

  it("does not issue a request without a project", () => {
    const { result } = renderHookWithProviders(() =>
      useEnvironments(undefined, { workload: "workflow" }),
    );
    expect(result.current.fetchStatus).toBe("idle");
  });
});
