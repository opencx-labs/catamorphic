import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentStateDirectory, removeAgentState } from "./agent-state.js";

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-state-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("agent state", () => {
  it("keeps each chat's state in host storage and drops it with its project", async () => {
    const agentStateDir = await temp();
    const directory = agentStateDirectory({
      agentStateDir,
      projectId: "project-1",
      sessionId: "session-1",
    });
    expect(path.relative(agentStateDir, directory)).toBe(
      path.join("project-1", "session-1"),
    );
    const other = agentStateDirectory({
      agentStateDir,
      projectId: "project-2",
      sessionId: "session-2",
    });
    for (const folder of [directory, other]) {
      await mkdir(path.join(folder, "attachments"), { recursive: true });
      await writeFile(path.join(folder, "attachments", "shot.png"), "png");
    }
    await removeAgentState({ agentStateDir, projectId: "project-1" });
    await expect(stat(directory)).rejects.toThrow();
    expect((await stat(other)).isDirectory()).toBe(true);
  });

  it("rejects ids that would leave the state directory", async () => {
    const agentStateDir = await temp();
    expect(() =>
      agentStateDirectory({
        agentStateDir,
        projectId: "..",
        sessionId: "session-1",
      }),
    ).toThrow("Invalid project");
    expect(() =>
      agentStateDirectory({
        agentStateDir,
        projectId: "project-1",
        sessionId: "../escape",
      }),
    ).toThrow("Invalid session");
    await expect(
      removeAgentState({ agentStateDir, projectId: "../outside" }),
    ).rejects.toThrow("Invalid project");
  });
});
