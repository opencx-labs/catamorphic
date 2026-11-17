import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  hostRunnerStateDirectory,
  removeTemporaryRunnerState,
} from "../services/sessions/runner-channels.js";

/**
 * Where an in-process runner keeps a chat's state (ADR 0321): host storage
 * it names, or a private temporary folder of this process, never shared.
 */

const posix = process.platform !== "win32";
const made: string[] = [];
const mode = async (folder: string) => (await stat(folder)).mode & 0o777;

afterAll(async () => {
  await Promise.all(
    made.map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe("host runner state", () => {
  it("refuses a session id that cannot name a folder, and a relative host folder", async () => {
    await expect(
      hostRunnerStateDirectory({ named: undefined, sessionId: ".." }),
    ).rejects.toThrow("This session id cannot name a folder.");
    await expect(
      hostRunnerStateDirectory({ named: "state/chat", sessionId: "chat-1" }),
    ).rejects.toThrow("must be an absolute path");
  });

  it.skipIf(!posix)(
    "makes a folder the host names private, even one already there",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "named-state-"));
      made.push(root);
      const named = path.join(root, "project-1", "chat-1");
      await mkdir(named, { recursive: true, mode: 0o755 });
      await chmod(named, 0o755);
      await expect(
        hostRunnerStateDirectory({ named, sessionId: "chat-1" }),
      ).resolves.toBe(named);
      expect(await mode(named)).toBe(0o700);
    },
  );

  it.skipIf(!posix)(
    "keeps each chat's state in one private temporary folder, made anew when someone replaced it",
    async () => {
      const first = await hostRunnerStateDirectory({
        named: undefined,
        sessionId: "chat-a",
      });
      const root = path.dirname(first);
      made.push(root);
      expect(path.basename(root)).toMatch(/^catamorphic-agent-state-/);
      expect(await mode(root)).toBe(0o700);
      expect(await mode(first)).toBe(0o700);
      await expect(
        hostRunnerStateDirectory({ named: undefined, sessionId: "chat-a" }),
      ).resolves.toBe(first);

      // Gone (a temp cleaner) and back as a folder anyone can write to.
      await rm(root, { recursive: true, force: true });
      await mkdir(root, { mode: 0o777 });
      await chmod(root, 0o777);
      const next = await hostRunnerStateDirectory({
        named: undefined,
        sessionId: "chat-b",
      });
      made.push(path.dirname(next));
      expect(path.dirname(next)).not.toBe(root);
      expect(await mode(path.dirname(next))).toBe(0o700);
    },
  );

  it("drops a resting chat's temporary state and nothing else", async () => {
    const kept = await hostRunnerStateDirectory({
      named: undefined,
      sessionId: "chat-kept",
    });
    const dropped = await hostRunnerStateDirectory({
      named: undefined,
      sessionId: "chat-dropped",
    });
    made.push(path.dirname(kept));
    await removeTemporaryRunnerState({ sessionId: "chat-dropped" });
    await expect(stat(dropped)).rejects.toThrow();
    expect((await stat(kept)).isDirectory()).toBe(true);
    await expect(
      removeTemporaryRunnerState({ sessionId: "../escape" }),
    ).resolves.toBeUndefined();
  });
});
