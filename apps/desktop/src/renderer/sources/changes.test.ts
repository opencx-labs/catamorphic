// @vitest-environment jsdom
import { createApiClient } from "@catamorphic/api-client";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { GitOverview } from "../../shared/git.js";
import { gitSource } from "./changes.js";
import type { WorkSourceDeps } from "./deps.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  watch: undefined as ((snapshot: unknown) => void) | undefined,
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    gitOverview: (...args: unknown[]) => mocks.read(...args),
    watchGitOverview: (_input: unknown, listener: (s: unknown) => void) => {
      mocks.watch = listener;
      return () => {
        mocks.watch = undefined;
      };
    },
  },
}));
afterEach(() => {
  mocks.read.mockReset();
  mocks.watch = undefined;
});

const tree = (files: string[]): GitOverview => ({
  available: true,
  worktrees: [
    {
      path: "/repo",
      branch: "main",
      isMain: true,
      isCurrent: true,
      loaded: true,
      changes: files.map((path) => ({
        path,
        kind: "added" as const,
        mode: "untracked" as const,
      })),
      branchChanges: [],
    },
  ],
});

function deps(): WorkSourceDeps {
  return {
    projectId: "p",
    apiClient: createApiClient({ baseUrl: "http://test", fetch: vi.fn() }),
    queryClient: new QueryClient(),
    writesProgram: true,
    remote: false,
    host: () => {
      throw new Error("unused");
    },
    onWindowChange: () => () => {},
  };
}

it("lists a checkout's files as its watch saw them, and follows every change it sees", async () => {
  const signal = new AbortController().signal;
  const source = gitSource(deps());
  // Read before the watch began: a file the watch may never see.
  mocks.read.mockResolvedValue(tree(["early.txt"]));
  expect(
    (await source.load({ parentId: "/repo", signal })).items.map(
      (row) => row.label,
    ),
  ).toEqual(["early.txt"]);
  const publish = vi.fn();
  const stop = source.subscribe?.(publish, {
    branches: () => [null, "/repo"],
    branchSize: () => 0,
    fail: () => {},
  });
  // Its first snapshot reads the list again, from what it saw.
  mocks.watch?.(tree([]));
  expect(publish).toHaveBeenCalledWith({
    type: "invalidate",
    parentId: "/repo",
    quiet: true,
  });
  expect(
    (await source.load({ parentId: "/repo", signal })).items.map(
      (row) => row.label,
    ),
  ).toEqual([]);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  stop?.();
});
