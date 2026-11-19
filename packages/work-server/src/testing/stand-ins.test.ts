import { execFile } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type GithubStandIn, startGithubStandIn } from "./github-stand-in.js";
import { type ReviewModel, startReviewModel } from "./review-model.js";

const execute = promisify(execFile);
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const other = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

/** A GitHub App JWT, as the App's own key signs it. */
function appJwt(key: string, issuer = "123"): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 600, iss: issuer })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(key).toString("base64url")}`;
}

describe("the stand-in GitHub", () => {
  let root = "";
  let github: GithubStandIn | undefined;
  afterEach(async () => {
    await github?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("mints installation tokens for the App's own JWT, serves the repository behind them, and records every call", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-gh-"));
    github = await startGithubStandIn({
      repositories: ["acme/web", "acme/api"],
      gitRoot: path.join(root, "github"),
      app: { id: "123", slug: "work-acme", installationId: 77, privateKey },
    });
    const web = github.repository("acme/web");
    const api = (pathname: string, token: string, init?: RequestInit) =>
      fetch(`${github?.url}${pathname}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init?.headers },
      });
    // Only the App's key signs for the App, and only for its id.
    for (const forged of [appJwt(other), appJwt(privateKey, "999")])
      expect(
        (
          await api("/app/installations/77/access_tokens", forged, {
            method: "POST",
          })
        ).status,
      ).toBe(401);
    const minted = await api(
      "/app/installations/77/access_tokens",
      appJwt(privateKey),
      { method: "POST" },
    );
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    expect(github.tokens.has(token)).toBe(true);
    expect((await api("/repos/acme/web/pulls/1", "ghs_other")).status).toBe(
      401,
    );

    // A pull request whose head and files come from the repository.
    const work = path.join(root, "author");
    const git = (args: string[]) =>
      execute("git", [
        "-C",
        work,
        "-c",
        "user.name=Ada",
        "-c",
        "user.email=ada@example.test",
        ...args,
      ]);
    fs.mkdirSync(work);
    await git(["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(work, "a.txt"), "one\n");
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "one"]);
    await git(["push", "-q", web.gitDirectory, "main"]);
    fs.writeFileSync(path.join(work, "a.txt"), "one\ntwo\n");
    await git(["commit", "-q", "-am", "two"]);
    await git(["push", "-q", web.gitDirectory, "HEAD:refs/pull/1/head"]);
    const ada = { login: "ada", id: 1, type: "User" as const };
    const pull = await web.openPullRequest({
      number: 1,
      title: "Two",
      body: "Adds two.",
      headRef: "two",
      author: ada,
    });
    const files = await (
      await api("/repos/acme/web/pulls/1/files", token)
    ).json();
    expect(files).toMatchObject([
      {
        filename: "a.txt",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: expect.stringMatching(/^@@ .* @@\n one\n\+two$/),
      },
    ]);
    const listed = await (
      await api("/repos/acme/web/pulls?state=all&per_page=20&page=1", token)
    ).json();
    expect(listed).toMatchObject([
      { number: 1, head: { sha: pull.head.sha }, base: { sha: pull.base.sha } },
    ]);

    // Git over smart HTTP takes the minted token and nothing else.
    const clone = (credential: string, into: string) =>
      execute("git", [
        "clone",
        "-q",
        `${github?.url.replace("://", `://x-access-token:${credential}@`)}/acme/web.git`,
        path.join(root, into),
      ]);
    await expect(clone("ghs_other", "refused")).rejects.toThrow();
    await clone(token, "cloned");
    expect(fs.readFileSync(path.join(root, "cloned", "a.txt"), "utf8")).toBe(
      "one\n",
    );

    // What the App writes is recorded and listed back.
    const check = await api("/repos/acme/web/check-runs", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Work review",
        head_sha: pull.head.sha,
        external_id: "work-review:t:check",
        status: "completed",
        conclusion: "success",
      }),
    });
    expect(check.status).toBe(201);
    const runs = await (
      await api(
        `/repos/acme/web/commits/${pull.head.sha}/check-runs?filter=all&per_page=100&page=1&check_name=Work%20review`,
        token,
      )
    ).json();
    expect(runs).toMatchObject({
      total_count: 1,
      check_runs: [{ app: { slug: "work-acme" }, conclusion: "success" }],
    });
    expect(
      github
        .writes()
        .map((call) => `${call.method} ${call.path} ${call.status}`),
    ).toEqual([
      "POST /app/installations/77/access_tokens 401",
      "POST /app/installations/77/access_tokens 401",
      "POST /app/installations/77/access_tokens 201",
      "POST /repos/acme/web/check-runs 201",
    ]);
    expect(web.checkRuns).toHaveLength(1);
    expect(github.repository("acme/api").checkRuns).toEqual([]);
    expect((await api("/repos/acme/api/pulls/1", token)).status).toBe(404);
    expect((await api("/repos/acme/other/pulls", token)).status).toBe(404);
    // A push is refused unless the test accepts pushes, and is a write.
    fs.writeFileSync(path.join(root, "cloned", "b.txt"), "pushed\n");
    await execute("git", ["-C", path.join(root, "cloned"), "add", "-A"]);
    await execute("git", [
      "-C",
      path.join(root, "cloned"),
      "-c",
      "user.name=Ada",
      "-c",
      "user.email=ada@example.test",
      "commit",
      "-q",
      "-m",
      "pushed",
    ]);
    await expect(
      execute("git", [
        "-C",
        path.join(root, "cloned"),
        "push",
        "-q",
        "origin",
        "HEAD:refs/heads/work",
      ]),
    ).rejects.toThrow();
    expect(
      web.writes().map((call) => `${call.method} ${call.path} ${call.status}`),
    ).toEqual([
      "POST /repos/acme/web/check-runs 201",
      // Git asks without its credentials first.
      "GET /acme/web.git/info/refs 401",
      "GET /acme/web.git/info/refs 403",
    ]);
    // A review keeps what it was sent: no commit is no commit.
    const posted = await api("/repos/acme/web/pulls/1/reviews", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "COMMENT", body: "No commit named" }),
    });
    expect(posted.status).toBe(200);
    expect(web.reviews.at(-1)?.commit_id).toBeNull();
    // A body it cannot parse is answered, as GitHub answers it.
    const unparsed = await api("/repos/acme/web/check-runs", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(unparsed.status).toBe(400);
    // A run in progress is read and rewritten by id, as the review's
    // progress is (ADR 0337); a conclusion completes it.
    const started = (await (
      await api("/repos/acme/web/check-runs", token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Work review",
          head_sha: pull.head.sha,
          external_id: "work-review:1:progress:e",
          status: "in_progress",
          output: { title: "Waiting to start", summary: "Queued" },
        }),
      })
    ).json()) as { id: number };
    const patch = (body: object) =>
      api(`/repos/acme/web/check-runs/${started.id}`, token, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (await patch({ output: { title: "Reviewing", summary: "At work" } }))
        .status,
    ).toBe(200);
    expect(
      await (
        await api(`/repos/acme/web/check-runs/${started.id}`, token)
      ).json(),
    ).toMatchObject({
      status: "in_progress",
      conclusion: null,
      external_id: "work-review:1:progress:e",
      output: { title: "Reviewing" },
    });
    await patch({
      conclusion: "failure",
      output: { title: "Changes requested", summary: "One finding" },
    });
    expect(web.checkRuns.at(-1)).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { title: "Changes requested" },
    });
    expect((await api("/repos/acme/web/check-runs/1", token)).status).toBe(404);
    // A pull request's commits, oldest first: those its head adds to main.
    expect(
      await (await api("/repos/acme/web/pulls/1/commits", token)).json(),
    ).toEqual([{ sha: pull.head.sha }]);
    // Its fetch reaches it and nothing else.
    await expect(github.fetch("https://api.github.com/zen")).rejects.toThrow(
      "refused",
    );
  });
});

describe("the review model", () => {
  let model: ReviewModel | undefined;
  afterEach(async () => {
    await model?.close();
  });

  const call = (
    messages: unknown[],
    tools = ["Bash", "Read", "mcp__workspace__submit_result"],
  ) =>
    fetch(`${model?.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        system: "Working directory: /workspace/project",
        tools: tools.map((name) => ({ name })),
        messages,
      }),
    }).then((response) => response.text());
  const eventsOf = (stream: string) =>
    stream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)));
  /** The text a streamed answer says. */
  const textOf = (stream: string) =>
    eventsOf(stream)
      .map((event) => event.delta?.text ?? "")
      .join("");
  /** The tool use a streamed answer makes, from its server-sent events. */
  const toolUse = (stream: string) => {
    const events = eventsOf(stream);
    const block = events.find(
      (event) => event.content_block?.type === "tool_use",
    )?.content_block;
    const json = events
      .map((event) => event.delta?.partial_json ?? "")
      .join("");
    return {
      block: block ?? null,
      input: json ? JSON.parse(json) : null,
    };
  };

  it("steps from the conversation it is sent: tests, a read, the review, the end", async () => {
    const started: number[] = [];
    model = await startReviewModel({
      command: "pnpm test",
      read: "src/total.js",
      onTurnStart: async ({ turn }) => {
        started.push(turn);
      },
      review: ({ turn, commandOutput }) => ({ turn, commandOutput }),
    });
    const prompt = { role: "user", content: "Review pull request 1" };
    const ran = toolUse(await call([prompt]));
    expect(ran.block).toMatchObject({ name: "Bash", id: "toolu_run_1" });
    expect(ran.input).toMatchObject({ command: "pnpm test" });
    // The same request again (a retry) asks for the same step.
    expect(toolUse(await call([prompt])).block).toMatchObject({
      id: "toolu_run_1",
    });
    const result = (id: string, text: string) => ({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: text }],
    });
    const history = [
      prompt,
      { role: "assistant", content: [] },
      result("toolu_run_1", "tests passed"),
    ];
    const read = toolUse(await call(history));
    expect(read.input).toEqual({
      file_path: "/workspace/project/src/total.js",
    });
    history.push(
      { role: "assistant", content: [] },
      result("toolu_read_1", "the file"),
    );
    const submitted = toolUse(await call(history));
    expect(submitted.block).toMatchObject({
      name: "mcp__workspace__submit_result",
    });
    expect(submitted.input).toEqual({
      name: "review",
      value: { turn: 1, commandOutput: "tests passed" },
    });
    history.push(
      { role: "assistant", content: [] },
      result("toolu_submit_1", "Recorded"),
    );
    expect(textOf(await call(history))).toBe("Submitted the review.");
    // The next message starts the second turn; side calls get text.
    history.push(
      { role: "assistant", content: [] },
      { role: "user", content: "New commits" },
    );
    expect(toolUse(await call(history)).block).toMatchObject({
      id: "toolu_run_2",
    });
    expect(textOf(await call([prompt], []))).toBe("Pull request review");
    expect(started).toEqual([1, 2]);
    expect(model.turnsOf("pull request 1")).toMatchObject([
      {
        commandOutput: "tests passed",
        readOutput: "the file",
        submitAnswer: "Recorded",
      },
      {},
    ]);
  });

  it("submits a turn's findings one by one before its review, waiting on each one's hook once", async () => {
    const noticed: string[] = [];
    model = await startReviewModel({
      command: "pnpm test",
      read: "src/total.js",
      findings: () => [{ id: "a" }, { id: "b" }],
      onFinding: async ({ index, finding, answer }) => {
        noticed.push(`${index} ${String(finding.id)} ${answer}`);
      },
      review: () => ({ verdict: "COMMENT" }),
    });
    const prompt = { role: "user", content: "Review pull request 1" };
    const result = (id: string, text: string) => ({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: text }],
    });
    const history: unknown[] = [
      prompt,
      { role: "assistant", content: [] },
      result("toolu_run_1", "tests passed"),
      { role: "assistant", content: [] },
      result("toolu_read_1", "the file"),
    ];
    expect(toolUse(await call(history))).toMatchObject({
      block: { id: "toolu_finding_1_0" },
      input: { name: "finding", value: { id: "a" } },
    });
    history.push(
      { role: "assistant", content: [] },
      result("toolu_finding_1_0", "Recorded a"),
    );
    expect(toolUse(await call(history))).toMatchObject({
      block: { id: "toolu_finding_1_1" },
      input: { name: "finding", value: { id: "b" } },
    });
    // A retried request asks for the same step and runs no hook again.
    expect(toolUse(await call(history)).block).toMatchObject({
      id: "toolu_finding_1_1",
    });
    history.push(
      { role: "assistant", content: [] },
      result("toolu_finding_1_1", "Recorded b"),
    );
    expect(toolUse(await call(history))).toMatchObject({
      block: { id: "toolu_submit_1" },
      input: { name: "review", value: { verdict: "COMMENT" } },
    });
    expect(noticed).toEqual(["0 a Recorded a", "1 b Recorded b"]);
    // A system message after a tool's answer (Claude Code's reminder that
    // the user has not heard from it) neither answers nor starts a turn.
    const reminded = [
      ...history,
      { role: "assistant", content: [] },
      result("toolu_submit_1", "Recorded the review"),
      { role: "system", content: "The user hasn't heard from you in a while." },
    ];
    expect(textOf(await call(reminded))).toBe("Submitted the review.");
    expect(model.turnsOf("pull request 1")).toMatchObject([
      {
        findings: [
          { value: { id: "a" }, answer: "Recorded a" },
          { value: { id: "b" }, answer: "Recorded b" },
        ],
        submitted: { verdict: "COMMENT" },
        submitAnswer: "Recorded the review",
      },
    ]);
    // Findings are no review: the next message is still the first turn's.
    history.push(
      { role: "assistant", content: [] },
      result("toolu_submit_1", "Recorded the review"),
      { role: "assistant", content: [] },
      { role: "user", content: "New commits" },
    );
    expect(toolUse(await call(history)).block).toMatchObject({
      id: "toolu_run_2",
    });
  });

  it("speaks the built-in agent's tools, and keeps each chat's turns apart", async () => {
    model = await startReviewModel({
      command: "pnpm test",
      read: "src/total.js",
      review: ({ prompt, turn }) => ({ prompt, turn }),
    });
    const tools = ["bash", "read", "write", "submit_result"];
    const prompt = { role: "user", content: "Review pull request acme/api#1" };
    expect(toolUse(await call([prompt], tools))).toMatchObject({
      block: { name: "bash", id: "toolu_run_1" },
      input: { command: "pnpm test" },
    });
    const result = (id: string, text: string) => ({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: [{ type: "text", text }],
        },
      ],
    });
    const history: unknown[] = [
      prompt,
      { role: "assistant", content: [] },
      result(
        "toolu_run_1",
        JSON.stringify({ exitCode: 0, output: "tests passed" }),
      ),
    ];
    expect(toolUse(await call(history, tools))).toMatchObject({
      block: { name: "read" },
      input: { path: "src/total.js" },
    });
    history.push(
      { role: "assistant", content: [] },
      result("toolu_read_1", "the file"),
    );
    expect(toolUse(await call(history, tools))).toMatchObject({
      block: { name: "submit_result" },
      input: {
        name: "review",
        value: { prompt: "Review pull request acme/api#1", turn: 1 },
      },
    });
    // Another chat starts at its own first turn.
    const other = { role: "user", content: "Review pull request acme/web#1" };
    expect(toolUse(await call([other], tools)).block).toMatchObject({
      id: "toolu_run_1",
    });
    expect(model.turnsOf("acme/api#1")).toMatchObject([
      { commandOutput: "tests passed", readOutput: "the file" },
    ]);
    expect(model.turnsOf("acme/web#1")).toEqual([{}]);
  });
});
