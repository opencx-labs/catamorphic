import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCodexModels } from "../models.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function executable(body: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-models-"));
  directories.push(dir);
  const file = path.join(dir, "codex");
  await writeFile(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return file;
}

describe("Codex model discovery", () => {
  it("initializes, reads every catalog page and maps visible model effort options", async () => {
    const binary = await executable(`
      const readline = require('node:readline');
      let initialized = false;
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialized') { initialized = true; return; }
        if (message.method === 'initialize') { console.log(JSON.stringify({id: message.id, result: {}})); return; }
        if (!initialized || message.method !== 'model/list' || process.argv[2] !== 'app-server' || process.env.TEST_ACCOUNT !== 'selected') process.exit(1);
        const page = message.params.cursor ? {data: [{model: 'second', displayName: 'Second', supportedReasoningEfforts: []}], nextCursor: null} : {data: [{model: 'first', displayName: 'First', supportedReasoningEfforts: [{reasoningEffort: 'high'}, {reasoningEffort: 'unknown'}]}, {model: 'hidden', hidden: true}], nextCursor: 'page-2'};
        console.log(JSON.stringify({method: 'notification', params: {}}));
        console.log(JSON.stringify({id: message.id, result: page}));
      });
    `);
    expect(
      await listCodexModels({
        executable: binary,
        env: { TEST_ACCOUNT: "selected" },
      }),
    ).toEqual([
      {
        id: "first",
        name: "First",
        supportsEffort: true,
        supportedEffortLevels: ["high"],
      },
      {
        id: "second",
        name: "Second",
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    ]);
  });
  it("bounds a silent executable", async () => {
    const binary = await executable("setInterval(() => {}, 1000)");
    await expect(
      listCodexModels({ executable: binary, timeoutMs: 100 }),
    ).rejects.toThrow("timed out");
  });
  it("reports startup failure", async () => {
    await expect(
      listCodexModels({ executable: "/nonexistent/codex", timeoutMs: 1000 }),
    ).rejects.toThrow();
  });
});
