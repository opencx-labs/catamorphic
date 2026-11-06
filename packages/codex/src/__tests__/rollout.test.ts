import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonValue } from "@catamorphic/agent-protocol";
import type { AttemptHost } from "@catamorphic/agent-protocol/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeLines, RolloutMirror } from "../rollout.js";

/** A host that only stores native state, recording each append. */
function storingHost(appends: JsonValue[][]): AttemptHost {
  const unused = () => Promise.reject(new Error("Not used by the mirror"));
  return {
    emit: () => {},
    callTool: unused,
    authorize: unused,
    request: unused,
    nativeState: {
      append: async ({ entries }) => {
        appends.push(entries);
      },
      load: async () => null,
      subpaths: async () => [],
    },
    signal: new AbortController().signal,
  };
}

describe("rollout mirror", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-rollout-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("stores a line whose characters were split between polls whole", async () => {
    const file = path.join(directory, "rollout.jsonl");
    const line = JSON.stringify({ type: "message", text: "héllo 界 🎉" });
    const bytes = Buffer.from(`${line}\n`, "utf8");
    // Cut inside the four-byte emoji, so the first poll ends mid-character.
    const cut = bytes.indexOf(Buffer.from("🎉", "utf8")) + 2;
    await writeFile(file, bytes.subarray(0, cut));
    const appends: JsonValue[][] = [];
    const mirror = new RolloutMirror({
      file,
      host: storingHost(appends),
      offset: 0,
    });
    await mirror.poll();
    expect(appends).toEqual([]);
    await appendFile(file, bytes.subarray(cut));
    await mirror.poll();
    expect(appends).toEqual([[JSON.parse(line)]]);
    // A later line follows from where the last complete one ended.
    await appendFile(file, '{"type":"done"}\n');
    await mirror.poll();
    expect(appends).toEqual([[JSON.parse(line)], [{ type: "done" }]]);
  });

  it("decodes only complete lines, split on the newline byte", () => {
    const bytes = Buffer.from("界\n🎉", "utf8");
    expect(completeLines(bytes.subarray(0, 2))).toBeUndefined();
    expect(completeLines(bytes.subarray(0, 6))?.toString("utf8")).toBe("界\n");
  });
});
