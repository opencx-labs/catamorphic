import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type { EnvironmentRuntimeBinding } from "@catamorphic/sandbox";
import {
  cleanupTestResources,
  TestSandboxes,
} from "@catamorphic/sandbox/testing";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { PullRequestSummary } from "../services/code-host.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import {
  NothingToProposeError,
  PullRequestsService,
  PullRequestUnavailableError,
} from "../services/pull-requests-service.js";
import { SessionWorkspaces } from "../services/session-workspaces.js";
import { fakeCodeHost } from "./code-host-fixture.js";
import { RecordingAdapter } from "./recording-adapter.js";

const ownedSandboxes = new TestSandboxes();

/**
 * Every server chat stands on a branch (ADR 0342), end to end with real
 * sandboxes: a chat that names no ref starts on the default branch of the
 * project's repository, or on the project's own main; its agent's branch,
 * commits and uncommitted changes come back after its workspace was given
 * back; its pull request is its own commits (ADR 0343); and base moves
 * keep or discard its commits as asked.
 */

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (
    await execFileAsync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Upstream",
      "-c",
      "user.email=upstream@example.test",
      ...args,
    ])
  ).stdout.trim();

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_session_branches";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalUserId: "ada",
};
const AGENT_GIT = "git -c user.name=Agent -c user.email=agent@example.test";

describe("every server chat stands on a branch (ADRs 0342, 0343)", () => {
  let tmpDir: string;
  let seed: string;
  let remote: string;
  let linked: string;
  let unlinked: string;
  let unreachable: string;
  let projectManager: ProjectManager;
  let sessions: AgentSessionsService;
  let machine: LocalProcessSandboxProvider;
  let pulls: PullRequestSummary[];
  const allocations = new ExecutionAllocationsService(db);
  /** What the agent does in its checkout this turn, and what it printed. */
  let script = "true";
  let printed = "";
  /** Run inside the turn, after the script: what a tool call would do. */
  let during: ((sessionId: string) => Promise<void>) | undefined;
  const adapter = new RecordingAdapter({
    before: async (attempt) => {
      const result = await machine.executeCommand(
        await sandboxOf(attempt.sessionId),
        script,
        { cwd: "/workspace/project" },
      );
      printed = result.result.trim();
      if (result.exitCode !== 0)
        throw new Error(`The agent's commands failed: ${printed}`);
      await during?.(attempt.sessionId);
    },
  });

  const sandboxOf = async (sessionId: string) =>
    (
      await db
        .selectFrom("agent_sessions")
        .innerJoin(
          "project_sandboxes",
          "project_sandboxes.id",
          "agent_sessions.sandbox_id",
        )
        .select("project_sandboxes.provider_id")
        .where("agent_sessions.id", "=", sessionId)
        .executeTakeFirstOrThrow()
    ).provider_id;
  const rowOf = (sessionId: string) =>
    db
      .selectFrom("agent_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();

  /** One turn: the agent runs `commands` in its checkout. */
  const turn = async (input: {
    projectId: string;
    sessionId: string;
    commands: string;
    during?: (sessionId: string) => Promise<void>;
  }) => {
    script = input.commands;
    during = input.during;
    try {
      const result = await sessions.sendMessage(
        identity,
        input.projectId,
        input.sessionId,
        "work",
      );
      expect(result.turn.status).toBe("completed");
      return { printed, told: adapter.lastInput() ?? "" };
    } finally {
      during = undefined;
    }
  };
  /** Give the chat's workspace back, as an idle one is. */
  const release = async (sessionId: string) => {
    const before = await sandboxOf(sessionId);
    const { allocation_id } = await rowOf(sessionId);
    await allocations.release({
      identity,
      allocationId: allocation_id ?? "",
      reason: "idle",
    });
    return before;
  };
  const upstream = async (file: string, content: string, message: string) => {
    await fs.writeFile(path.join(seed, file), content);
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "-q", "-m", message]);
    return git(seed, ["rev-parse", "HEAD"]);
  };
  const remoteTip = (ref: string) => git(remote, ["rev-parse", ref]);
  /** Prints the checkout: its branch, HEAD, log, then its status. */
  const STATE = [
    "git branch --show-current",
    "git rev-parse HEAD",
    "git log --format=%s",
    "echo @status",
    "git status --porcelain -uall",
  ].join(" && ");
  /** `STATE`, then whatever `more` prints. */
  const stateAnd = (more: string) => `${STATE} && echo @more && ${more}`;
  /** What `STATE` printed, and the lines after it. */
  const state = (output: string) => {
    const lines = output.split("\n");
    const statusAt = lines.indexOf("@status");
    const moreAt = lines.indexOf("@more");
    const [branch = "", commit = "", ...log] = lines.slice(0, statusAt);
    return {
      checkout: {
        branch,
        commit,
        log,
        status: lines
          .slice(statusAt + 1, moreAt < 0 ? undefined : moreAt)
          .filter(Boolean)
          .sort(),
      },
      more: moreAt < 0 ? [] : lines.slice(moreAt + 1),
    };
  };

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-branches-"));
    // The project's repository, as it existed before Work: two commits on
    // its default branch, and a pull request's head.
    seed = path.join(tmpDir, "seed");
    await fs.mkdir(seed);
    await git(seed, ["init", "-q", "-b", "trunk"]);
    await upstream("README.md", "one\n", "First");
    await upstream("README.md", "two\n", "Second");
    remote = path.join(tmpDir, "remote.git");
    await execFileAsync("git", ["clone", "-q", "--bare", seed, remote]);
    await git(seed, ["remote", "add", "origin", remote]);

    projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
      new FsRemoteBackend(path.join(tmpDir, "origins")),
    );
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    linked = (await projects.create(identity, { name: "Linked" })).id;
    unlinked = (await projects.create(identity, { name: "Unlinked" })).id;
    unreachable = (await projects.create(identity, { name: "Unreachable" })).id;
    await db
      .updateTable("projects")
      .set({
        remote_url: remote,
        remote_ownership: "attached",
        default_branch: "trunk",
      })
      .where("id", "=", linked)
      .execute();
    await db
      .updateTable("projects")
      .set({
        remote_url: path.join(tmpDir, "gone.git"),
        remote_ownership: "attached",
        default_branch: "trunk",
      })
      .where("id", "=", unreachable)
      .execute();

    machine = ownedSandboxes.track(
      new LocalProcessSandboxProvider({ root: path.join(tmpDir, "machine") }),
    );
    const binding: EnvironmentRuntimeBinding = {
      descriptor: {
        id: "machine",
        label: "Machine",
        trust: "managed",
        isolation: "sandbox",
        workloads: ["agent"],
        agentTopologies: ["controller"],
        capabilities: [],
        resources: {},
      },
      sandboxProvider: machine,
    };
    const agent: RegisteredCodingAgent = {
      id: "coder",
      harness: { placement: "host", adapter },
      topology: "controller",
    };
    // A code host over the repository that keeps the pull requests it opened.
    const forge = fakeCodeHost({ db, projectManager, remoteBase: tmpDir });
    pulls = [];
    forge.host.createPullRequest = vi.fn(async (input) => {
      const pull: PullRequestSummary = {
        number: pulls.length + 1,
        title: input.title,
        url: `https://forge.test/pull/${pulls.length + 1}`,
        author: "work",
        head: input.head,
        base: input.base,
        draft: false,
        updatedAt: new Date(0).toISOString(),
      };
      pulls.push(pull);
      return { url: pull.url, number: pull.number };
    });
    forge.host.listPullRequests = vi.fn(async () => pulls);
    await forge.connectPersonal(identity, "ada-token");
    const pullRequests = new PullRequestsService(forge.codeHosts);
    sessions = new AgentSessionsService(db, {
      hostId: "session-branches-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        {
          get: ({ allocationBindingId }) =>
            !allocationBindingId || allocationBindingId === "machine"
              ? binding
              : undefined,
        },
      ),
      executionAllocations: allocations,
      codingAgents: {
        defaultAgentId: () => agent.id,
        get: (id) => (id === agent.id ? agent : undefined),
        list: () => [agent],
      },
      workspaces: new SessionWorkspaces({
        projectManager,
        origin: async ({ projectId }) => {
          const row = await db
            .selectFrom("projects")
            .select(["remote_url", "default_branch"])
            .where("id", "=", projectId)
            .executeTakeFirst();
          return row?.remote_url
            ? { url: row.remote_url, branch: row.default_branch ?? "main" }
            : null;
        },
      }),
      pullRequests,
    });
    pullRequests.bindChats({
      record: (input) => sessions.recordPullRequest(input),
    });
  }, 60_000);

  afterAll(async () => {
    await cleanupTestResources(
      [
        () => sessions?.stopLocalTurns(),
        () => ownedSandboxes.cleanup(),
        () => db.destroy(),
      ],
      () => fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 }),
    );
  });

  it("starts a chat that names no ref on the repository's default branch, with its real commits", async () => {
    const tip = await remoteTip("trunk");
    const chat = await sessions.create(identity, linked, {});
    expect((await rowOf(chat.id)).workspace).toEqual({
      ref: "trunk",
      commit: tip,
    });
    const first = await turn({
      projectId: linked,
      sessionId: chat.id,
      commands: stateAnd("git remote get-url origin && cat README.md"),
    });
    expect(state(first.printed)).toEqual({
      checkout: {
        branch: `work/${chat.id.replaceAll("-", "").slice(0, 8)}`,
        // The repository's own commit, not one Work made up.
        commit: tip,
        log: ["Second"],
        status: [],
      },
      more: [remote, "two"],
    });
    expect(first.told).not.toContain("[Workspace]");
  }, 60_000);

  it("starts a chat on the project's own main when it has no repository", async () => {
    const main = await projectManager.mainCommit({
      tenantId: identity.tenantId,
      projectId: unlinked,
    });
    const chat = await sessions.create(identity, unlinked, {});
    expect((await rowOf(chat.id)).workspace).toEqual({
      ref: "main",
      commit: main,
      source: "origin",
    });
    const first = await turn({
      projectId: unlinked,
      sessionId: chat.id,
      commands: stateAnd("(git remote | wc -l | tr -d ' ')"),
    });
    expect(state(first.printed)).toMatchObject({
      checkout: {
        branch: `work/${chat.id.replaceAll("-", "").slice(0, 8)}`,
        commit: main,
        status: [],
      },
      // Nothing to fetch from, and nowhere to open a pull request.
      more: ["0"],
    });
    await expect(
      sessions.createPullRequest(identity, unlinked, chat.id, { title: "x" }),
    ).rejects.toBeInstanceOf(NothingToProposeError);
    await turn({
      projectId: unlinked,
      sessionId: chat.id,
      commands: `echo x > x.txt && git add x.txt && ${AGENT_GIT} commit -q -m x`,
    });
    const refused = sessions.createPullRequest(identity, unlinked, chat.id, {
      title: "x",
    });
    await expect(refused).rejects.toBeInstanceOf(PullRequestUnavailableError);
    await expect(refused).rejects.toThrow(
      "This project is not connected to a repository, so there is nowhere to open a pull request. The branch is saved with this chat.",
    );
  }, 60_000);

  it("falls back to the project's own main when the repository cannot be reached, and tells the agent once", async () => {
    const main = await projectManager.mainCommit({
      tenantId: identity.tenantId,
      projectId: unreachable,
    });
    const chat = await sessions.create(identity, unreachable, {});
    expect((await rowOf(chat.id)).workspace).toMatchObject({
      ref: "main",
      commit: main,
      source: "origin",
    });
    const first = await turn({
      projectId: unreachable,
      sessionId: chat.id,
      commands: "git rev-parse HEAD",
    });
    expect(first.printed).toBe(main);
    expect(first.told).toContain(
      "[Workspace] The project's repository could not be reached when this chat started",
    );
    expect(first.told).toContain("and not on trunk");
    expect(first.told).not.toMatch(/[–—]/);
    const second = await turn({
      projectId: unreachable,
      sessionId: chat.id,
      commands: "true",
    });
    expect(second.told).not.toContain("could not be reached");
  }, 60_000);

  it("gives a branch, its commits and uncommitted work back after the workspace was released", async () => {
    const chat = await sessions.create(identity, linked, {});
    const worked = await turn({
      projectId: linked,
      sessionId: chat.id,
      commands: [
        "set -e",
        "git checkout -q -b feature/x",
        "echo committed > committed.txt",
        "git add committed.txt",
        `${AGENT_GIT} commit -q -m 'Agent commit'`,
        // Staged, untracked, deleted, binary, executable, a link.
        "echo staged > staged.txt && git add staged.txt",
        "echo untracked > untracked.txt",
        "rm README.md",
        "printf '\\000\\377\\001\\376' > data.bin",
        "printf '#!/bin/sh\\necho hi\\n' > run.sh && chmod 755 run.sh",
        "ln -s committed.txt link",
        STATE,
      ].join("\n"),
    });
    const before = state(worked.printed).checkout;
    expect(before.branch).toBe("feature/x");
    expect(before.log).toEqual(["Agent commit", "Second"]);

    const first = await release(chat.id);
    const restored = await turn({
      projectId: linked,
      sessionId: chat.id,
      commands: stateAnd(
        "od -An -tx1 data.bin | tr -d ' \\n' && echo && readlink link && test -x run.sh && echo executable && test ! -x untracked.txt && echo plain",
      ),
    });
    expect(await sandboxOf(chat.id)).not.toBe(first);
    expect(state(restored.printed)).toEqual({
      checkout: {
        branch: "feature/x",
        commit: before.commit,
        log: ["Agent commit", "Second"],
        // What was staged comes back unstaged: untracked.
        status: [
          " D README.md",
          "?? data.bin",
          "?? link",
          "?? run.sh",
          "?? staged.txt",
          "?? untracked.txt",
        ],
      },
      more: ["00ff01fe", "committed.txt", "executable", "plain"],
    });
    // The session's ref is its own: the agent's history holds no checkpoint.
    const checkpoints = await projectManager.sessionWork({
      tenantId: identity.tenantId,
      projectId: linked,
      sessionId: chat.id,
      base: await remoteTip("trunk"),
    });
    expect(checkpoints).toMatchObject({
      head: before.commit,
      branch: "feature/x",
    });
    expect(checkpoints.checkpoint).not.toBe(before.commit);
  }, 90_000);

  it("gives an open chat that has no base one before its next turn, its saved files uncommitted on it", async () => {
    const chat = await sessions.create(identity, linked, {});
    await turn({
      projectId: linked,
      sessionId: chat.id,
      commands: "echo kept > kept.txt",
    });
    await release(chat.id);
    // A chat from before every chat stood on a branch: no base recorded.
    await db
      .updateTable("agent_sessions")
      .set({ workspace: null })
      .where("id", "=", chat.id)
      .execute();
    const tip = await remoteTip("trunk");
    const next = await turn({
      projectId: linked,
      sessionId: chat.id,
      commands: stateAnd("cat kept.txt"),
    });
    expect((await rowOf(chat.id)).workspace).toEqual({
      ref: "trunk",
      commit: tip,
    });
    expect(state(next.printed)).toEqual({
      checkout: {
        branch: `work/${chat.id.replaceAll("-", "").slice(0, 8)}`,
        commit: tip,
        log: ["Second"],
        status: ["?? kept.txt"],
      },
      more: ["kept"],
    });
  }, 60_000);

  it("opens a pull request from the agent's own commits while its sandbox runs, updates it, replaces it after a rebase and never overwrites anyone else", async () => {
    const chat = await sessions.create(identity, linked, {});
    const short = chat.id.replaceAll("-", "").slice(0, 8);
    let opened: Awaited<ReturnType<AgentSessionsService["createPullRequest"]>>;
    const open = (title = "Add a feature") =>
      sessions.createPullRequest(identity, linked, chat.id, { title });

    // Called in the turn, as the tool is: the commit was made a moment
    // ago and no turn has saved it yet.
    const committed = await turn({
      projectId: linked,
      sessionId: chat.id,
      commands: [
        "set -e",
        "git checkout -q -b feature/pr",
        "echo one > one.txt && git add one.txt",
        `${AGENT_GIT} commit -q -m 'One'`,
        "echo draft > draft.txt",
        "git rev-parse HEAD",
      ].join("\n"),
      during: async () => {
        opened = await open();
      },
    });
    const head = committed.printed;
    opened = opened!;
    expect(opened).toMatchObject({
      url: "https://forge.test/pull/1",
      number: 1,
      branch: `work/feature-pr-${short}`,
      commit: head,
      base: "trunk",
      created: true,
      // Named, and not pushed.
      uncommitted: ["draft.txt"],
    });
    expect(opened.note).toContain("draft.txt");
    // The pushed head is the agent's HEAD: its commit, not a checkpoint.
    expect(await remoteTip(`refs/heads/${opened.branch}`)).toBe(head);
    expect(await git(remote, ["log", "--format=%an %s", opened.branch])).toBe(
      "Agent One\nUpstream Second\nUpstream First",
    );
    expect(
      await git(remote, ["ls-tree", "-r", "--name-only", opened.branch]),
    ).toBe("README.md\none.txt");
    // The chat records it by itself.
    expect(
      await sessions.metadata({
        identity,
        projectId: linked,
        sessionId: chat.id,
      }),
    ).toEqual({
      pull_requests: [
        {
          url: "https://forge.test/pull/1",
          number: 1,
          title: "Add a feature",
          state: "open",
        },
      ],
    });

    // More commits, between turns: the same pull request, moved forward.
    const more = await turn({
      projectId: linked,
      sessionId: chat.id,
      commands: `echo two > two.txt && git add two.txt && ${AGENT_GIT} commit -q -m Two && git rev-parse HEAD`,
    });
    const updated = await open("Another title");
    expect(updated).toMatchObject({
      number: 1,
      url: opened.url,
      branch: opened.branch,
      commit: more.printed,
      created: false,
    });
    expect(await remoteTip(`refs/heads/${opened.branch}`)).toBe(more.printed);
    expect(pulls).toHaveLength(1);
    expect(
      (
        await sessions.metadata({
          identity,
          projectId: linked,
          sessionId: chat.id,
        })
      ).pull_requests,
    ).toHaveLength(1);

    // What it pushed survives its workspace being given back.
    await release(chat.id);

    // A rebase rewrites its commits: its own branch is replaced.
    const rebased = await turn({
      projectId: linked,
      sessionId: chat.id,
      commands: `${AGENT_GIT} commit -q --amend -m 'Two, reworded' && git rev-parse HEAD`,
    });
    expect(await open()).toMatchObject({ number: 1, created: false });
    expect(await remoteTip(`refs/heads/${opened.branch}`)).toBe(
      rebased.printed,
    );

    // Someone else pushes there; the chat's next rewrite is refused.
    const theirs = path.join(tmpDir, "theirs");
    await execFileAsync("git", ["clone", "-q", remote, theirs]);
    await git(theirs, ["checkout", "-q", opened.branch]);
    await fs.writeFile(path.join(theirs, "theirs.txt"), "theirs\n");
    await git(theirs, ["add", "-A"]);
    await git(theirs, ["commit", "-q", "-m", "Theirs"]);
    await git(theirs, ["push", "-q", "origin", opened.branch]);
    const pushedByThem = await remoteTip(`refs/heads/${opened.branch}`);
    await turn({
      projectId: linked,
      sessionId: chat.id,
      commands: `${AGENT_GIT} commit -q --amend -m 'Two, reworded again'`,
    });
    await expect(open()).rejects.toThrow(/someone else pushed to this branch/);
    expect(await remoteTip(`refs/heads/${opened.branch}`)).toBe(pushedByThem);
    // The repository's own branch was never touched.
    expect(await remoteTip("trunk")).toBe(
      await git(seed, ["rev-parse", "HEAD"]),
    );
  }, 120_000);

  it("resets a review chat to each push, and keeps an agent's commits through a rebase", async () => {
    // A pull request's head, as a code host publishes it.
    await git(seed, ["checkout", "-q", "-b", "topic"]);
    const firstHead = await upstream("topic.txt", "one\n", "Topic one");
    await git(seed, ["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
    const review = await sessions.create(identity, linked, {
      workspace: { ref: "refs/pull/7/head", update: "reset" },
    });
    const reviewed = await turn({
      projectId: linked,
      sessionId: review.id,
      commands: `echo notes > notes.txt && git add notes.txt && ${AGENT_GIT} commit -q -m 'Review notes' && echo scratch > scratch.txt && git rev-parse HEAD~1`,
    });
    expect(reviewed.printed).toBe(firstHead);

    const secondHead = await upstream("topic.txt", "two\n", "Topic two");
    await git(seed, ["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
    await sessions.requestWorkspace(identity, linked, review.id, {
      ref: "refs/pull/7/head",
      update: "reset",
    });
    const reset = await turn({
      projectId: linked,
      sessionId: review.id,
      commands: STATE,
    });
    expect(reset.told).toContain("was reset to the new base");
    expect(state(reset.printed).checkout).toMatchObject({
      commit: secondHead,
      log: ["Topic two"],
      status: [],
    });
    await git(seed, ["checkout", "-q", "trunk"]);

    // A chat on the default branch, with a commit and an uncommitted file.
    const chat = await sessions.create(identity, linked, {});
    await turn({
      projectId: linked,
      sessionId: chat.id,
      commands: `git checkout -q -b feature/keep && echo mine > mine.txt && git add mine.txt && ${AGENT_GIT} commit -q -m 'Agent commit' && echo wip > wip.txt`,
    });
    const third = await upstream("upstream.txt", "three\n", "Third");
    await git(seed, ["push", "-q", "origin", "trunk"]);
    await sessions.requestWorkspace(identity, linked, chat.id, {
      ref: "trunk",
    });
    const moved = await turn({
      projectId: linked,
      sessionId: chat.id,
      commands: stateAnd("git rev-parse HEAD~1 && cat wip.txt upstream.txt"),
    });
    expect(moved.told).toContain("Your commits were rebased onto it");
    expect(state(moved.printed)).toMatchObject({
      checkout: {
        branch: "feature/keep",
        // Its commit, replayed on the new base; its file, still uncommitted.
        log: ["Agent commit", "Third"],
        status: ["?? wip.txt"],
      },
      more: [third, "wip", "three"],
    });
    expect((await rowOf(chat.id)).workspace).toEqual({
      ref: "trunk",
      commit: third,
    });
  }, 120_000);
});
