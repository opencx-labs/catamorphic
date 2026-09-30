import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RemoteDocumentEntry } from "@catamorphic/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishProgramFromFolder } from "./remote-sync.js";

const COMMIT = "c".repeat(40);
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-publish-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeServer(input: { commit?: string; content: string }) {
  const entry: RemoteDocumentEntry = {
    path: ".work/workflows/greet.ts",
    source: "program",
    contentType: "text/plain",
    size: -1,
    digest: "git:1",
    ...(input.commit ? { commit: input.commit } : {}),
  };
  const publishProgram = vi.fn(async () => ({
    status: "conflict" as const,
    commitSha: COMMIT,
    remoteSha: "d".repeat(40),
    conflicts: [
      { path: entry.path, base: "base", ours: "mine", theirs: "theirs" },
    ],
  }));
  return {
    publishProgram,
    client: {
      list: async () => [entry],
      readBytes: async () => ({
        bytes: new TextEncoder().encode(input.content),
        entry,
      }),
      write: async () => ({
        ok: false as const,
        conflict: true as const,
        currentVersion: 0,
      }),
      delete: async () => ({ ok: false as const, notFound: true as const }),
      history: async () => [],
      publishProgram,
    },
  };
}

it("publishes with the commit the folder downloaded as its base (ADR 0191)", async () => {
  const server = fakeServer({ commit: COMMIT, content: "published" });
  const result = await publishProgramFromFolder({
    root,
    client: server.client,
    message: "Greet",
    paths: [".work/workflows/greet.ts"],
    readChanges: () => [{ path: ".work/workflows/greet.ts", content: "mine" }],
  });
  expect(server.publishProgram).toHaveBeenCalledWith({
    message: "Greet",
    files: { ".work/workflows/greet.ts": "mine" },
    base: COMMIT,
  });
  // A change that landed in between comes back as a conflict to show.
  expect(result.status).toBe("conflict");
  expect(result.conflicts.map((entry) => entry.path)).toEqual([
    ".work/workflows/greet.ts",
  ]);
});

it("publishes without a base when the server names no commit", async () => {
  const server = fakeServer({ content: "published" });
  await publishProgramFromFolder({
    root,
    client: server.client,
    message: "Greet",
    paths: [".work/workflows/greet.ts"],
    readChanges: () => [{ path: ".work/workflows/greet.ts", content: "mine" }],
  });
  expect(server.publishProgram).toHaveBeenCalledWith({
    message: "Greet",
    files: { ".work/workflows/greet.ts": "mine" },
  });
});
