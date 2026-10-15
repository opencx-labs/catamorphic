import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ImportedTranscript } from "@catamorphic/agent-protocol";
import { ClaudeCodeTranscriptReader } from "@catamorphic/claude-code";
import { CodexRolloutReader } from "@catamorphic/codex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExternalSessionImporter,
  type ExternalSessionImporterDeps,
} from "./external-sessions.js";

/*
 * Imports from Claude Code's and Codex's own stores (ADR 0233), against
 * temporary homes: what turns it on, what is skipped, and that a growing
 * file sends only what changed.
 */

const ENABLED_AT = new Date(Date.UTC(2026, 9, 15, 12, 0, 0));
const after = (second: number) =>
  new Date(ENABLED_AT.getTime() + second * 1_000).toISOString();

interface Imported {
  projectId: string;
  transcript: ImportedTranscript;
  agentId: string | null;
  contentSha256: string;
  native?: { offset: number; entries: unknown[] };
}

describe("ExternalSessionImporter", () => {
  let dir: string;
  let homes: { claude: string; codex: string };
  let projectRoot: string;
  let importers: Partial<Record<"claude-code" | "codex", string>>;
  let imports: Imported[];
  let outcome: "created" | "updated" | "unchanged" | "own" | "taken_over";
  let importer: ExternalSessionImporter;

  const build = (overrides: Partial<ExternalSessionImporterDeps> = {}) =>
    new ExternalSessionImporter({
      homes,
      stateFile: path.join(dir, "external-session-imports.json"),
      profiles: () => [
        {
          id: "profile-1",
          importers,
          projectIds: ["project-1"],
        },
      ],
      projectRoot: (id) => (id === "project-1" ? projectRoot : undefined),
      readers: {
        "claude-code": () => new ClaudeCodeTranscriptReader(),
        codex: () => new CodexRolloutReader(),
      },
      importTranscript: async (input) => {
        imports.push(input);
        return { outcome };
      },
      mainCheckout: async (cwd) =>
        cwd.startsWith(path.join(dir, "elsewhere")) ? projectRoot : undefined,
      now: () => ENABLED_AT,
      ...overrides,
    });

  const claudeLines = (cwd: string, prompts: string[], start = 1) =>
    prompts.flatMap((text, index) => [
      JSON.stringify({
        type: "user",
        isSidechain: false,
        sessionId: "11111111-1111-4111-8111-111111111111",
        cwd,
        uuid: `00000000-0000-4000-8000-0000000000${String(index * 2 + 10)}`,
        timestamp: after(start + index * 10),
        message: { role: "user", content: text },
      }),
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        sessionId: "11111111-1111-4111-8111-111111111111",
        cwd,
        uuid: `00000000-0000-4000-8000-0000000000${String(index * 2 + 11)}`,
        timestamp: after(start + index * 10 + 1),
        message: {
          id: `msg_${index}`,
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: `Answer ${index}` }],
          stop_reason: "end_turn",
        },
      }),
    ]);

  const writeClaude = async (lines: string[], name = "session.jsonl") => {
    const folder = path.join(homes.claude, "projects", "-work-web");
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, name);
    await fs.writeFile(file, `${lines.join("\n")}\n`);
    return file;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "external-sessions-"));
    homes = {
      claude: path.join(dir, "claude-home"),
      codex: path.join(dir, "codex-home"),
    };
    projectRoot = path.join(dir, "web");
    await fs.mkdir(projectRoot, { recursive: true });
    importers = {};
    imports = [];
    outcome = "created";
    importer = build();
  });

  afterEach(async () => {
    importer.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("imports nothing while off, and only sessions started after it was turned on", async () => {
    await writeClaude(claudeLines(projectRoot, ["Before"], -60), "old.jsonl");
    importer.refresh();
    await importer.idle();
    expect(imports).toEqual([]);

    importers = { "claude-code": "claude-code-agent" };
    importer.refresh();
    await importer.idle();
    // The old session started before importing was on: no backfill.
    expect(imports).toEqual([]);
    const state = JSON.parse(
      await fs.readFile(
        path.join(dir, "external-session-imports.json"),
        "utf8",
      ),
    );
    expect(state).toEqual({
      "profile-1": { "claude-code": ENABLED_AT.toISOString() },
    });

    await writeClaude(claudeLines(projectRoot, ["Why does it fail?"]));
    importer.refresh();
    await importer.idle();
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      projectId: "project-1",
      agentId: "claude-code-agent",
      transcript: { harness: "claude-code", cwd: projectRoot },
    });
    expect(
      imports[0]?.transcript.turns.map((turn) => turn.input?.text),
    ).toEqual(["Why does it fail?"]);
  });

  it("sends only the turns that changed as the file grows", async () => {
    importers = { "claude-code": "claude-code-agent", codex: "codex-agent" };
    const file = await writeClaude(claudeLines(projectRoot, ["One"]));
    importer.refresh();
    await importer.idle();
    expect(imports).toHaveLength(1);
    const first = imports[0]?.contentSha256;

    await fs.appendFile(
      file,
      `${claudeLines(projectRoot, ["One", "Two"]).slice(2).join("\n")}\n`,
    );
    importer.refresh();
    await importer.idle();
    expect(imports).toHaveLength(2);
    expect(
      imports[1]?.transcript.turns.map((turn) => turn.input?.text),
    ).toEqual(["Two"]);
    expect(imports[1]?.contentSha256).not.toBe(first);

    // Nothing new: nothing sent.
    importer.refresh();
    await importer.idle();
    expect(imports).toHaveLength(2);
  });

  it("finds the project of a worktree elsewhere, and skips folders of no project", async () => {
    importers = { "claude-code": "claude-code-agent" };
    await writeClaude(
      claudeLines(path.join(dir, "elsewhere", "feature"), ["In a worktree"]),
      "worktree.jsonl",
    );
    await writeClaude(
      claudeLines(path.join(dir, "unrelated"), ["Somewhere else"]),
      "unrelated.jsonl",
    );
    importer.refresh();
    await importer.idle();
    expect(
      imports.map((item) => item.transcript.turns[0]?.input?.text),
    ).toEqual(["In a worktree"]);
  });

  it("sends Claude Code's records once each, and stops once Work continued the chat", async () => {
    importers = { "claude-code": "claude-code-agent" };
    const file = await writeClaude(claudeLines(projectRoot, ["One"]));
    importer.refresh();
    await importer.idle();
    expect(imports[0]?.native).toMatchObject({ offset: 0 });
    expect(imports[0]?.native?.entries).toHaveLength(2);

    await fs.appendFile(
      file,
      `${claudeLines(projectRoot, ["One", "Two"]).slice(2).join("\n")}\n`,
    );
    importer.refresh();
    await importer.idle();
    expect(imports[1]?.native).toMatchObject({ offset: 2 });
    expect(imports[1]?.native?.entries).toHaveLength(2);

    // Continued in Work: what the CLI writes later is not read into it.
    outcome = "taken_over";
    await fs.appendFile(
      file,
      `${claudeLines(projectRoot, ["One", "Two", "Three"]).slice(4).join("\n")}\n`,
    );
    importer.refresh();
    await importer.idle();
    expect(imports).toHaveLength(3);
    await fs.appendFile(
      file,
      `${claudeLines(projectRoot, ["One", "Two", "Three", "Four"]).slice(6).join("\n")}\n`,
    );
    importer.refresh();
    await importer.idle();
    expect(imports).toHaveLength(3);
  });

  it("stops reading a session Work itself ran", async () => {
    importers = { "claude-code": "claude-code-agent" };
    outcome = "own";
    const file = await writeClaude(claudeLines(projectRoot, ["Mine"]));
    importer.refresh();
    await importer.idle();
    expect(imports).toHaveLength(1);
    await fs.appendFile(
      file,
      `${claudeLines(projectRoot, ["Mine", "More"]).slice(2).join("\n")}\n`,
    );
    importer.refresh();
    await importer.idle();
    expect(imports).toHaveLength(1);
  });

  it("reads Codex threads, skipping Codex Desktop's copies of Claude Code chats", async () => {
    importers = { codex: "codex-agent" };
    const folder = path.join(homes.codex, "sessions", "2026", "10", "15");
    await fs.mkdir(folder, { recursive: true });
    const rollout = (thread: string) =>
      [
        {
          type: "session_meta",
          payload: { id: thread, cwd: projectRoot, timestamp: after(1) },
        },
        { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: "t1",
            item: {
              type: "UserMessage",
              id: `u-${thread}`,
              content: [{ type: "text", text: thread }],
            },
          },
        },
        {
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "t1" },
        },
      ]
        .map((record) => JSON.stringify({ timestamp: after(2), ...record }))
        .join("\n");
    const own = "01a0d5ac-8636-7032-b6a9-267d2bd70d1b";
    const copied = "01a13c4b-362c-7742-b42d-f2681db167c4";
    for (const thread of [own, copied])
      await fs.writeFile(
        path.join(folder, `rollout-2026-10-15T12-00-01-${thread}.jsonl`),
        `${rollout(thread)}\n`,
      );
    await fs.writeFile(
      path.join(homes.codex, "external_agent_session_imports.json"),
      JSON.stringify({ records: [{ imported_thread_id: copied }] }),
    );
    importer.refresh();
    await importer.idle();
    expect(imports.map((item) => item.transcript.nativeSessionId)).toEqual([
      own,
    ]);
    expect(imports[0]?.agentId).toBe("codex-agent");
  });

  it("forgets when a tool was turned on once it is turned off", async () => {
    importers = { "claude-code": "claude-code-agent", codex: "codex-agent" };
    importer.refresh();
    importers = { codex: "codex-agent" };
    importer.refresh();
    const state = JSON.parse(
      await fs.readFile(
        path.join(dir, "external-session-imports.json"),
        "utf8",
      ),
    );
    expect(state).toEqual({
      "profile-1": { codex: ENABLED_AT.toISOString() },
    });
  });
});
