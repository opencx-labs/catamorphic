import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { useOnParse } from "../use-on-parse.js";

const SAMPLE_GRAPH = {
  name: "demo",
  capabilities: {
    persistedContinuations: true,
    batchProcessing: true,
    cancellation: true,
  },
  displayName: null,
  description: null,
  filePath: "workflows/demo.ts",
  trigger: { parameters: [] },
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      label: "start",
      metadata: {},
      sourceRange: {
        start: 0,
        end: 10,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 10,
      },
    },
    {
      id: "step-1",
      type: "step",
      label: "step1",
      metadata: {},
      sourceRange: {
        start: 11,
        end: 20,
        startLine: 2,
        startColumn: 1,
        endLine: 2,
        endColumn: 10,
      },
    },
    {
      id: "return",
      type: "return",
      label: "end",
      metadata: {},
      sourceRange: {
        start: 21,
        end: 30,
        startLine: 3,
        startColumn: 1,
        endLine: 3,
        endColumn: 10,
      },
    },
  ],
  edges: [
    {
      id: "e1",
      source: "trigger",
      target: "step-1",
      type: "sequential",
    },
  ],
  sourceCode: "",
} as const;

describe("useOnParse", () => {
  it("merges live source into files and returns a layouted graph", async () => {
    let captured: unknown = null;
    server.use(
      http.post(apiUrl("/api/playground/parse"), async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json(SAMPLE_GRAPH);
      }),
    );

    const files = {
      "workflows/demo.ts": "export async function demo() { /* old */ }",
      "workflows/other.ts": "export const other = 1;",
    };

    const { result } = renderHookWithProviders(() =>
      useOnParse({
        files,
        workflowName: "demo",
        preferredFilePath: "workflows/demo.ts",
      }),
    );

    const output = await result.current(
      "export async function demo() { /* new */ }",
    );

    expect(captured).toEqual({
      files: {
        "workflows/demo.ts": "export async function demo() { /* new */ }",
        "workflows/other.ts": "export const other = 1;",
      },
      workflowName: "demo",
      preferredFilePath: "workflows/demo.ts",
    });

    expect(output).not.toBeNull();
    expect(output?.graph.name).toBe("demo");
    // `layoutGraph` decorates nodes with `position` + `width` + `height` — we
    // just assert the shape survives without inlining dagre's specific math.
    expect(output?.layoutedNodes).toHaveLength(SAMPLE_GRAPH.nodes.length);
    for (const node of output?.layoutedNodes ?? []) {
      expect(node.position).toEqual(
        expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
        }),
      );
      expect(typeof node.width).toBe("number");
      expect(typeof node.height).toBe("number");
    }
    expect(output?.layoutedEdges).toEqual(SAMPLE_GRAPH.edges);
  });

  it("returns null when the server reports no parse (null body)", async () => {
    server.use(
      http.post(apiUrl("/api/playground/parse"), () => HttpResponse.json(null)),
    );

    const { result } = renderHookWithProviders(() =>
      useOnParse({
        files: { "workflows/demo.ts": "" },
        workflowName: "demo",
        preferredFilePath: "workflows/demo.ts",
      }),
    );

    await expect(result.current("")).resolves.toBeNull();
  });

  it("swallows transient parse errors and returns null", async () => {
    server.use(
      http.post(apiUrl("/api/playground/parse"), () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    const { result } = renderHookWithProviders(() =>
      useOnParse({
        files: {},
        workflowName: "demo",
      }),
    );

    await expect(result.current("not real code")).resolves.toBeNull();
  });

  it("returns a stable callback across renders when inputs are unchanged", async () => {
    server.use(
      http.post(apiUrl("/api/playground/parse"), () =>
        HttpResponse.json(SAMPLE_GRAPH),
      ),
    );

    const { result, rerender } = renderHookWithProviders(
      ({ files }: { files: Record<string, string> }) =>
        useOnParse({
          files,
          workflowName: "demo",
          preferredFilePath: "workflows/demo.ts",
        }),
      { initialProps: { files: { "workflows/demo.ts": "v1" } } },
    );

    const first = result.current;
    // File map changes on every keystroke in the host — identity must hold.
    rerender({ files: { "workflows/demo.ts": "v2" } });
    expect(result.current).toBe(first);
  });

  it("picks up the latest `files` ref when invoked after a rerender", async () => {
    let lastRequest: { files: Record<string, string> } | null = null;
    server.use(
      http.post(apiUrl("/api/playground/parse"), async ({ request }) => {
        lastRequest = (await request.json()) as {
          files: Record<string, string>;
        };
        return HttpResponse.json(SAMPLE_GRAPH);
      }),
    );

    const { result, rerender } = renderHookWithProviders(
      ({ files }: { files: Record<string, string> }) =>
        useOnParse({
          files,
          workflowName: "demo",
          preferredFilePath: "workflows/demo.ts",
        }),
      {
        initialProps: {
          files: { "workflows/demo.ts": "v1", "workflows/helper.ts": "old" },
        },
      },
    );

    rerender({
      files: { "workflows/demo.ts": "v2", "workflows/helper.ts": "new" },
    });

    await result.current("final");

    await waitFor(() => expect(lastRequest).not.toBeNull());
    expect(lastRequest?.files).toEqual({
      "workflows/demo.ts": "final",
      "workflows/helper.ts": "new",
    });
  });
});
