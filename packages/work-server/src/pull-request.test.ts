import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Identity } from "@catamorphic/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "./server.js";
import { say, testServerOptions } from "./test-support.js";
import {
  type GithubStandIn,
  type StandInRepository,
  startGithubStandIn,
} from "./testing/github-stand-in.js";

/**
 * One pull request tool (ADR 0345), end to end on a Work server: a chat
 * that names no ref stands on the default branch of the project's GitHub
 * repository (ADR 0344), its agent commits in its sandbox and calls
 * `project.create_pull_request` through capability discovery, and the
 * control plane pushes those commits with the organization's GitHub App
 * and opens the pull request. GitHub is the stand-in on loopback, so every
 * write that reached it is asserted.
 */

const execute = promisify(execFile);
const git = async (cwd: string, args: readonly string[]) =>
  (
    await execute("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Ada",
      "-c",
      "user.email=ada@example.test",
      ...args,
    ])
  ).stdout.trim();
const { privateKey: APP_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const setup: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "work-setup-agent",
};
const AGENT_GIT = "git -c user.name=Agent -c user.email=agent@example.test";

describe("an agent's pull request on a Work server (ADRs 0344, 0345)", () => {
  let root: string;
  let github: GithubStandIn;
  let web: StandInRepository;
  let server: WorkServer;
  let projectId: string;
  let sessionId: string;
  let main: string;

  const tip = (ref: string) =>
    execute("git", ["--git-dir", web.gitDirectory, "rev-parse", ref]).then(
      (result) => result.stdout.trim(),
    );
  /**
   * One turn of the chat's agent: shell steps, then Work's own tools. Its
   * reply, or what a tool refused with when `refused` expects that.
   */
  const turn = async (steps: readonly string[], refused = false) => {
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("The server runs no chats");
    const reply = await say({
      sessions,
      identity: setup,
      projectId,
      sessionId,
      text: steps.join(" ;; "),
    });
    expect(reply.turn.status, reply.content).toBe(
      refused ? "failed" : "completed",
    );
    return reply.content;
  };
  const pullRequest = (title: string) =>
    `tool invoke_capability ${JSON.stringify({
      name: "project.create_pull_request",
      input: { title, body: "What changed and why." },
    })}`;
  /** The commit a `run git rev-parse HEAD` step printed. */
  const headIn = (content: string) =>
    /exit=0\n([0-9a-f]{40})/.exec(content)?.[1] ?? "";

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-pull-request-"));
    github = await startGithubStandIn({
      repositories: ["acme/web"],
      gitRoot: path.join(root, "github"),
      app: {
        id: "123",
        slug: "work-acme",
        installationId: 77,
        privateKey: APP_KEY,
      },
      pushes: true,
    });
    web = github.repository("acme/web");
    // The repository as it existed before Work: two commits on main.
    const author = path.join(root, "author");
    fs.mkdirSync(author);
    await git(author, ["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(author, "README.md"), "one\n");
    await git(author, ["add", "-A"]);
    await git(author, ["commit", "-q", "-m", "First"]);
    fs.writeFileSync(path.join(author, "README.md"), "two\n");
    await git(author, ["commit", "-q", "-am", "Second"]);
    await git(author, ["push", "-q", web.gitDirectory, "main"]);
    main = await tip("refs/heads/main");

    server = await createWorkServer({
      ...testServerOptions({
        dataDir: path.join(root, "server"),
        env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
      }),
      hooks: {
        github: {
          apiBaseUrl: github.url,
          webBaseUrl: github.url,
          fetch: github.fetch,
        },
      },
    });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const core = server.catamorphic.core;
    const connections = core.connections;
    if (!connections) throw new Error("Connections are required");
    // The organization's GitHub App, authorized once by an administrator.
    const created = await connections.createService({
      identity: setup,
      name: "github",
      providerKind: "github",
      principalKind: "tenant_service",
    });
    const started = await connections.beginServiceAuthorization({
      identity: setup,
      connectionId: created.id,
      redirectUri: `http://127.0.0.1:${port}/api/connection-authorizations/callback`,
    });
    await connections.completeAuthorization({
      identity: setup,
      state: started.authorizationId,
      callback: { appId: "123", privateKey: APP_KEY, installationId: "77" },
    });
    projectId = (await core.projects.create(setup, { name: "acme/web" })).id;
    await core.db
      .updateTable("projects")
      .set({
        remote_url: `${github.url}/acme/web.git`,
        remote_branch: "main",
        default_branch: "main",
        remote_ownership: "attached",
      })
      .where("id", "=", projectId)
      .execute();
    const sessions = core.agentSessions;
    if (!sessions) throw new Error("The server runs no chats");
    sessionId = (await sessions.create(setup, projectId, {})).id;
  }, 120_000);

  afterAll(async () => {
    await server?.shutdown();
    await github?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }, 60_000);

  it("stands the chat on the repository's default branch and offers one pull request tool", async () => {
    const short = sessionId.replaceAll("-", "").slice(0, 8);
    const content = await turn([
      "run git rev-parse HEAD && git branch --show-current && git log --format=%s && cat README.md",
      `tool discover_capabilities ${JSON.stringify({ query: "pull request propose change" })}`,
    ]);
    // GitHub's own commit, on the chat's own branch.
    expect(content).toContain(`exit=0\n${main}\nwork/${short}\nSecond\ntwo`);
    expect(content).toContain("project.create_pull_request");
    // A chat has a workspace: files are not handed to propose_change.
    expect(content).not.toContain("propose_change");
    // Starting a chat only read the repository.
    expect(web.writes()).toEqual([]);
  }, 120_000);

  it("pushes the agent's commits as the chat's own branch, opens the pull request and records it on the chat", async () => {
    const short = sessionId.replaceAll("-", "").slice(0, 8);
    const branch = `work/feature-x-${short}`;
    const content = await turn([
      [
        "run git checkout -q -b feature/x",
        "echo one > one.txt",
        "git add one.txt",
        `${AGENT_GIT} commit -q -m One`,
        "echo draft > draft.txt",
        "git rev-parse HEAD",
      ].join(" && "),
      pullRequest("Add one"),
    ]);
    const head = headIn(content);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    // The pushed head is the agent's HEAD: its commit, its authorship.
    expect(await tip(`refs/heads/${branch}`)).toBe(head);
    expect(
      (
        await execute("git", [
          "--git-dir",
          web.gitDirectory,
          "log",
          "--format=%an %s",
          branch,
        ])
      ).stdout.trim(),
    ).toBe("Agent One\nAda Second\nAda First");
    // The pull request exists, against the branch the chat started from.
    expect([...web.pulls.values()]).toMatchObject([
      {
        number: 1,
        title: "Add one",
        body: "What changed and why.",
        state: "open",
        head: { ref: branch, sha: head },
        base: { ref: "main", sha: main },
      },
    ]);
    expect(content).toContain(`${github.url}/acme/web/pull/1`);
    // What is not committed is named, and was not pushed.
    expect(content).toContain("draft.txt");
    expect(
      (
        await execute("git", [
          "--git-dir",
          web.gitDirectory,
          "ls-tree",
          "-r",
          "--name-only",
          branch,
        ])
      ).stdout.trim(),
    ).toBe("README.md\none.txt");
    // Recorded on the chat without the agent writing it.
    const sessions = server.catamorphic.core.agentSessions;
    expect(
      await sessions?.metadata({ identity: setup, projectId, sessionId }),
    ).toEqual({
      pull_requests: [
        {
          url: `${github.url}/acme/web/pull/1`,
          number: 1,
          title: "Add one",
          state: "open",
        },
      ],
    });
    // One push and one pull request reached GitHub: nothing else.
    const writes = web.writes();
    expect(writes.filter((call) => call.credential === "git").length).toBe(
      writes.length - 1,
    );
    expect(
      writes.filter(
        (call) => call.method === "POST" && call.path.endsWith("/pulls"),
      ),
    ).toHaveLength(1);
    expect(await tip("refs/heads/main")).toBe(main);
  }, 120_000);

  it("updates the same pull request, replaces the chat's own branch after a rebase, and refuses to overwrite anyone else's push", async () => {
    const short = sessionId.replaceAll("-", "").slice(0, 8);
    const branch = `work/feature-x-${short}`;
    const sessions = server.catamorphic.core.agentSessions;

    // More commits: the same pull request, its branch moved forward.
    const second = headIn(
      await turn([
        `run echo two > two.txt && git add two.txt && ${AGENT_GIT} commit -q -m Two && git rev-parse HEAD`,
        pullRequest("Another title"),
      ]),
    );
    expect(await tip(`refs/heads/${branch}`)).toBe(second);
    expect(web.pulls.size).toBe(1);
    expect(
      (await sessions?.metadata({ identity: setup, projectId, sessionId }))
        ?.pull_requests,
    ).toHaveLength(1);

    // A rebase rewrote its commits: its own branch is replaced.
    const rebased = headIn(
      await turn([
        `run ${AGENT_GIT} commit -q --amend -m 'Two, reworded' && git rev-parse HEAD`,
        pullRequest("Add one"),
      ]),
    );
    expect(rebased).not.toBe(second);
    expect(await tip(`refs/heads/${branch}`)).toBe(rebased);
    expect(web.pulls.size).toBe(1);

    // A person pushes to the branch; the chat's next rewrite is refused
    // and their commit stays.
    const theirs = path.join(root, "theirs");
    await execute("git", ["clone", "-q", web.gitDirectory, theirs]);
    await git(theirs, ["checkout", "-q", branch]);
    fs.writeFileSync(path.join(theirs, "theirs.txt"), "theirs\n");
    await git(theirs, ["add", "-A"]);
    await git(theirs, ["commit", "-q", "-m", "Theirs"]);
    await git(theirs, ["push", "-q", "origin", branch]);
    const pushedByThem = await tip(`refs/heads/${branch}`);
    const refused = await turn(
      [
        `run ${AGENT_GIT} commit -q --amend -m 'Two, reworded again' && git rev-parse HEAD`,
        pullRequest("Add one"),
      ],
      true,
    );
    expect(refused).toContain("someone else pushed to this branch");
    expect(await tip(`refs/heads/${branch}`)).toBe(pushedByThem);
    expect(web.pulls.size).toBe(1);
    // The repository's own branch was never written.
    expect(await tip("refs/heads/main")).toBe(main);
  }, 180_000);
});
