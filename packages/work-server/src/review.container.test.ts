import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pinnedClaudeCodeVersion } from "@catamorphic/claude-code/testing";
import { DockerClient, dockerEndpoint } from "@catamorphic/container";
import type { Identity } from "@catamorphic/core";
import { cacheVolumeKey, SEPARATE_HARNESS } from "@catamorphic/sandbox";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "./execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "./server.js";
import {
  createTestDatabase,
  enrollMachine,
  registryPack,
  testServerOptions,
} from "./test-support.js";
import {
  type GithubActor,
  type GithubStandIn,
  type StandInRepository,
  startGithubStandIn,
} from "./testing/github-stand-in.js";
import {
  type ReviewModel,
  type ReviewStep,
  startReviewModel,
} from "./testing/review-model.js";
import { startTlsFront, type TlsFront } from "./testing/tls-front.js";

/**
 * The `pull-request-reviews` recipe end to end, the way production runs
 * it: a Work server on Postgres reached over HTTPS; projects made from the
 * pack's files with commands apart from the agent (ADR 0332) and the
 * read-only pnpm cache (ADR 0334), plus the `github-polling` pack, which
 * records GitHub's events as project events (ADR 0326); one container
 * machine under gVisor, enrolled as a review pool machine is; GitHub and
 * the model as stand-ins on loopback. The real workflows review and
 * publish:
 *
 * - `acme/web` runs the pack as it ships: the built-in reviewer on the
 *   control plane on the server's own model, its tools in the review
 *   sandbox's command container. A review, its publication, a push, and
 *   the next review and publication.
 * - `acme/api` runs the pack with its reviewer made Claude Code, as a team
 *   may: the real CLI in the sandbox's agent container as its own user, on
 *   the review Environment's model binding through the gateway. One review
 *   and its publication.
 *
 * Needs WORK_TEST_CONTAINER=1, a Docker daemon with a `runsc` runtime
 * registered with --host-uds=open and --net-raw, DATABASE_URL, `git` and
 * `openssl`, and the network for the images and packages the review image
 * and the change's install fetch (CI's `container` job, or
 * packages/container/scripts/test-in-docker.sh --suite review). Nothing
 * reaches the real GitHub or a model provider.
 */
const enabled =
  process.env.WORK_TEST_CONTAINER === "1" && Boolean(process.env.DATABASE_URL);
const MINUTES = 60_000;
/** The machine's default image, pinned as CI pins it. */
const SANDBOX_IMAGE =
  "oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a";
const MODEL = "claude-sonnet-5-5";
/** The one key either path reaches the stand-in model with. */
const MODEL_KEY = `sk-ant-stand-in-${randomBytes(12).toString("hex")}`;
const WEBHOOK_SECRET = `whsec-${randomBytes(12).toString("hex")}`;
/** A server on Postgres names its secrets (every replica shares them). */
const SERVER_SECRET = randomBytes(32).toString("hex");
const OPERATOR_SECRET = randomBytes(32).toString("hex");
const VAULT_KEY = randomBytes(32).toString("base64");
const { privateKey: APP_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const setup: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "work-setup-agent",
};
const ADA: GithubActor = { login: "ada", id: 11, type: "User" };
const GRACE: GithubActor = { login: "grace", id: 12, type: "User" };
const SHIPPED = "acme/web";
const CLAUDE_CODE = "acme/api";
const FIXTURE = fileURLToPath(
  new URL("./__fixtures__/review-repository/", import.meta.url),
);
/** What the probe the pull request plants prints. */
const PROBE = /^WORK-PROBE (\{.*\})$/m;

const execute = promisify(execFile);
const git = async (cwd: string, args: readonly string[]) =>
  (await execute("git", ["-C", cwd, ...args])).stdout.trim();
const author = ["-c", "user.name=Ada", "-c", "user.email=ada@example.test"];
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/** A fixture folder's files by their repository paths. */
function filesOf(folder: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else
        files[path.relative(path.join(FIXTURE, folder), file)] =
          fs.readFileSync(file, "utf8");
    }
  };
  walk(path.join(FIXTURE, folder));
  return files;
}

/**
 * The review and polling packs' files for `repository`, installed as their
 * docs say: the packs' Environments merged, the repository named in every
 * trigger and constant, and the `prod` and `slack` bindings this
 * organization has not set up left out. The image also trusts the test's
 * own CA, as a production image trusts the public chain.
 */
function reviewPack(input: {
  repository: string;
  ca: string;
}): Record<string, string> {
  const named = (files: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(files).map(([file, content]) => [
        file,
        content
          .replaceAll("acme/web", input.repository)
          .replaceAll("acme-web", input.repository.replace("/", "-")),
      ]),
    );
  const pack = named(registryPack("pull-request-reviews"));
  const polling = named(registryPack("github-polling"));
  const manifest = JSON.parse(pack[".work/project.json"] ?? "{}");
  const review = manifest.environments.review;
  expect(review.commands).toEqual({ separate: true, connections: ["git"] });
  expect(review.caches.pnpm.path).toBe("~/.cache/work/pnpm-store");
  delete review.connections.prod;
  delete review.connections.slack;
  manifest.environments["github-poller"] = JSON.parse(
    polling[".work/project.json"] ?? "{}",
  ).environments["github-poller"];
  const image = pack[".work/images/review.Dockerfile"] ?? "";
  return {
    ...polling,
    ...pack,
    ".work/project.json": JSON.stringify(manifest, null, 2),
    ".work/images/review.Dockerfile": [
      image.trimEnd(),
      `RUN printf '%s\\n' ${input.ca
        .trim()
        .split("\n")
        .map((line) => `'${line}'`)
        .join(
          " ",
        )} > /usr/local/share/ca-certificates/work-test-ca.crt && update-ca-certificates`,
      "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/work-test-ca.crt",
      "",
    ].join("\n"),
  };
}

/**
 * The same with its reviewer as Claude Code: the agent on the `review`
 * Environment's `anthropic` model binding, and the CLI the pinned Agent
 * SDK drives added to the image.
 */
function claudeCodeReviewPack(
  files: Record<string, string>,
): Record<string, string> {
  const manifest = JSON.parse(files[".work/project.json"] ?? "{}");
  manifest.environments.review.connections.anthropic = {
    provider: "anthropic",
    principal: "service",
    service: "anthropic",
    model: { allow: [MODEL] },
  };
  const reviewer = JSON.parse(files[".work/agents/reviewer.json"] ?? "{}");
  expect(reviewer.kind).toBe("builtin");
  reviewer.kind = "claude-code";
  reviewer.model = MODEL;
  reviewer.credentials = { source: "connection", connection: "anthropic" };
  // A layer of its own on the shipped image's, which the machine reuses.
  const image = files[".work/images/review.Dockerfile"] ?? "";
  const withCli = `${image}RUN npm install --global @anthropic-ai/claude-code@${pinnedClaudeCodeVersion()}\n`;
  return {
    ...files,
    ".work/project.json": JSON.stringify(manifest, null, 2),
    ".work/agents/reviewer.json": JSON.stringify(reviewer, null, 2),
    ".work/images/review.Dockerfile": withCli,
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface DockerMount {
  Type?: string;
  Name?: string;
  Destination?: string;
  RW?: boolean;
}

/** What a look inside the review sandbox found while its harness waited. */
interface Inspection {
  command: { name: string; hostname: string; mounts: DockerMount[] };
  /** The command container's mounts table. */
  commandMounts: string;
  setupLog: string;
  cacheProvenance: string;
  /** Claude Code's processes in the command container: none. */
  harnessBesideCommands: string[];
  /** Where the harness runs in the sandbox (Claude Code only). */
  agent?: {
    name: string;
    hostname: string;
    mounts: DockerMount[];
    mountsTable: string;
    harness: Array<{ uid: string; gid: string; groups: string }>;
    /** Hashes of the attempt's model grants. */
    grantHashes: string[];
    /** The hash of the key the CLI reaches its loopback model endpoint with. */
    loopbackKeyHash: string;
  };
}

/** One project reviewing one repository. */
interface Reviewed {
  repository: string;
  github: StandInRepository;
  projectId: string;
  /** The project's published main, GitHub's main too. */
  mainHead: string;
  /** The author's working copy. */
  work: string;
  /** The pull request's heads, oldest first. */
  heads: string[];
  chatKey: string;
}

describe.skipIf(!enabled)(
  "reviewing pull requests on a container machine, end to end",
  () => {
    const docker = new DockerClient(dockerEndpoint(process.env.DOCKER_HOST));
    let database: Awaited<ReturnType<typeof createTestDatabase>>;
    let root = "";
    let server: WorkServer;
    let github: GithubStandIn;
    let model: ReviewModel;
    let front: TlsFront | undefined;
    let machine: Awaited<ReturnType<typeof enrollMachine>> | undefined;
    const projectIds = new Map<string, string>();
    const projects = new Map<string, Reviewed>();
    const inspections = new Map<string, Inspection>();
    const lookFailures: string[] = [];
    let clock = Date.now();

    const db = () => server.catamorphic.core.db;
    const reviewed = (repository: string): Reviewed => {
      const found = projects.get(repository);
      if (!found) throw new Error(`${repository} has no project yet`);
      return found;
    };
    const reviewChat = (project: Reviewed) =>
      db()
        .selectFrom("agent_sessions")
        .select([
          "id",
          "status",
          "external_user_id",
          "environment_name",
          "workspace",
          "placement",
          "sandbox_id",
        ])
        .where("project_id", "=", project.projectId)
        .where("chat_key", "=", project.chatKey)
        .executeTakeFirst();
    const runsOf = (projectId: string, workflowName: string) =>
      db()
        .selectFrom("workflow_runs")
        .select(["id", "status", "error", "environment_name", "created_at"])
        .where("project_id", "=", projectId)
        .where("workflow_name", "=", workflowName)
        .orderBy("created_at", "asc")
        .execute();

    /** What a timed-out wait reports: where every part of the path stands. */
    const state = async () => ({
      runs: await db()
        .selectFrom("workflow_runs")
        .select(["project_id", "workflow_name", "status", "error"])
        .execute(),
      fills: await db()
        .selectFrom("environment_cache_fills")
        .select(["project_id", "status", "error", "generation", "commit_sha"])
        .execute(),
      chats: await db()
        .selectFrom("agent_sessions")
        .select(["chat_key", "status", "workspace", "sandbox_id"])
        .where("chat_key", "is not", null)
        .execute(),
      turns: await db()
        .selectFrom("agent_turns")
        .select(["session_id", "status", "error"])
        .execute(),
      attempts: await db()
        .selectFrom("agent_turn_attempts")
        .select(["status", "reason", "error"])
        .execute(),
      allocations: await db()
        .selectFrom("execution_allocations")
        .select(["environment_name", "status", "release_reason"])
        .execute(),
      looks: lookFailures,
      github: github.calls
        .slice(-15)
        .map((call) => `${call.method} ${call.path} ${call.status}`),
      model: [SHIPPED, CLAUDE_CODE].map((repository) =>
        model.turnsOf(`${repository}#1`),
      ),
      machine: machine?.log.slice(-20),
    });

    async function waitFor<T>(
      what: string,
      probe: () => Promise<T | undefined> | T | undefined,
      timeoutMs: number,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      const started = Date.now();
      console.log(`[review] waiting for ${what}`);
      for (;;) {
        const value = await probe();
        if (value !== undefined) {
          console.log(
            `[review] ${what}: ${Math.round((Date.now() - started) / 1000)}s`,
          );
          return value;
        }
        if (Date.now() > deadline)
          throw new Error(
            `Timed out waiting for ${what}: ${JSON.stringify(await state(), null, 2)}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    /**
     * Fire a project's named schedule workflows now, as their schedules
     * would: Work's own schedule dispatch, on a clock moved to when the
     * last of them is due. Resolves once each one's new run completed.
     */
    async function fire(projectId: string, workflowNames: readonly string[]) {
      const core = server.catamorphic.core;
      await core.schedules.tick({ identity: setup, projectId });
      const bindings = await db()
        .selectFrom("schedule_bindings as binding")
        .innerJoin(
          "workflow_enablement_triggers as activation",
          "activation.id",
          "binding.activation_id",
        )
        .innerJoin(
          "workflow_enablements as enablement",
          "enablement.id",
          "activation.enablement_id",
        )
        .select(["enablement.workflow_name", "binding.next_fire_at"])
        .where("enablement.project_id", "=", projectId)
        .where("enablement.workflow_name", "in", [...workflowNames])
        .execute();
      expect(bindings.map((binding) => binding.workflow_name).sort()).toEqual(
        [...workflowNames].sort(),
      );
      const before = new Map<string, Set<string>>();
      for (const name of workflowNames)
        before.set(
          name,
          new Set((await runsOf(projectId, name)).map((run) => run.id)),
        );
      clock = Math.max(
        clock + 1_000,
        ...bindings.map((binding) =>
          new Date(binding.next_fire_at ?? 0).getTime(),
        ),
      );
      await core.schedules.tick({
        identity: setup,
        projectId,
        now: new Date(clock),
      });
      return Promise.all(
        workflowNames.map((name) =>
          waitFor(
            `the scheduled run of ${name} to complete`,
            async () => {
              const run = (await runsOf(projectId, name)).find(
                (entry) => !before.get(name)?.has(entry.id),
              );
              if (run?.status === "failed")
                throw new Error(`${name} failed: ${JSON.stringify(run.error)}`);
              return run?.status === "completed" ? run : undefined;
            },
            5 * MINUTES,
          ),
        ),
      );
    }

    /** The pull request's head after its author's next push of `folder`. */
    async function push(
      project: Reviewed,
      folder: string,
      message: string,
    ): Promise<string> {
      for (const [file, content] of Object.entries(filesOf(folder))) {
        const target = path.join(project.work, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      await git(project.work, ["add", "-A"]);
      await git(project.work, [...author, "commit", "-q", "-m", message]);
      await git(project.work, [
        "push",
        "-q",
        "--force",
        "origin",
        "HEAD:refs/pull/1/head",
      ]);
      const head = await git(project.work, ["rev-parse", "HEAD"]);
      project.heads.push(head);
      return head;
    }

    /** A pull request's opening, which the project's poller records. */
    async function openPullRequest(project: Reviewed) {
      const head = await push(
        project,
        "pull-1",
        "Skip order lines without an amount",
      );
      await project.github.openPullRequest({
        number: 1,
        title: "Skip order lines without an amount",
        body: "Lines without an amount no longer make the total NaN.",
        headRef: "totals",
        author: ADA,
        reviewers: [GRACE],
      });
      await fire(project.projectId, ["pollGithub"]);
      return head;
    }

    /** The poster's runs of a project, once none is still queued or running. */
    const settledPosts = async (project: Reviewed, count: number) =>
      waitFor(
        `${count} postReviews runs of ${project.repository} to finish`,
        async () => {
          const runs = await runsOf(project.projectId, "postReviews");
          const failed = runs.find((run) => run.status === "failed");
          if (failed)
            throw new Error(
              `postReviews failed: ${JSON.stringify(failed.error)}`,
            );
          return runs.length >= count &&
            runs.every((run) => run.status === "completed")
            ? runs
            : undefined;
        },
        5 * MINUTES,
      );

    const exec = async (container: string, script: string, user: string) =>
      (
        await docker.exec({
          container,
          cmd: ["sh", "-c", script],
          user,
        })
      ).stdout;
    const inspected = async (container: string) => {
      const found = await docker.inspectContainer(container);
      const config = found?.Config;
      const mounts = found?.Mounts;
      return {
        hostname:
          config && typeof config === "object" && "Hostname" in config
            ? String(config.Hostname)
            : "",
        mounts: (Array.isArray(mounts) ? mounts : []) as DockerMount[],
      };
    };
    /** A container's processes running Claude Code, with who they run as. */
    const claudeProcesses = async (container: string) =>
      (
        await exec(
          container,
          `for p in /proc/[0-9]*; do [ -r "$p/status" ] || continue; printf '%s|%s|%s|%s|%s\\n' "\${p#/proc/}" "$(awk '/^Uid:/{print $2}' "$p/status")" "$(awk '/^Gid:/{print $2}' "$p/status")" "$(awk '/^Groups:/{$1=""; print}' "$p/status")" "$(tr '\\0' ' ' < "$p/cmdline")"; done`,
          "0",
        )
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [pid = "", uid = "", gid = "", groups = "", argv = ""] =
            line.split("|");
          return { pid, uid, gid, groups: groups.trim(), argv: argv.trim() };
        })
        .filter((entry) =>
          /^(?:\S*\/)?claude(?:\.exe)?$/.test(entry.argv.split(" ")[0] ?? ""),
        );

    /**
     * The machine's container for a chat's sandbox: Work records the id
     * the machine gave it beside its own.
     */
    async function commandContainerOf(project: Reviewed): Promise<string> {
      const chat = await reviewChat(project);
      const sandbox = await db()
        .selectFrom("project_sandboxes")
        .select("provider_id")
        .where("id", "=", chat?.sandbox_id ?? "")
        .executeTakeFirst();
      const provider = sandbox?.provider_id ?? "";
      const containers = await docker.listContainers({
        label: ["work.sandbox=1"],
      });
      return (
        containers
          .flatMap((container) =>
            Array.isArray(container.Names) ? container.Names : [],
          )
          .map((name) => String(name).replace(/^\//, ""))
          .find((name) => provider !== "" && provider.endsWith(name)) ?? ""
      );
    }

    /**
     * A look inside a chat's review sandbox while its harness waits on the
     * model: which container runs what, as whom, with which mounts.
     */
    async function inspectSandbox(project: Reviewed): Promise<Inspection> {
      const command = await commandContainerOf(project);
      expect(command, "the chat's command container").not.toBe("");
      const commandSide = await inspected(command);
      const cache = commandSide.mounts.find((mount) =>
        mount.Destination?.endsWith("/.cache/work/pnpm-store"),
      );
      const look: Inspection = {
        command: { name: command, ...commandSide },
        commandMounts: await exec(command, "cat /proc/mounts", "0"),
        setupLog: await exec(
          command,
          "cat /workspace/.work-session/setup.log",
          "0",
        ),
        cacheProvenance: cache?.Destination
          ? await exec(
              command,
              `cat '${cache.Destination}/.work-cache.json'`,
              "0",
            )
          : "",
        harnessBesideCommands: (await claudeProcesses(command)).map(
          (entry) => entry.argv,
        ),
      };
      if (project.repository !== CLAUDE_CODE) return look;
      const agent = `${command}-agent`;
      const harness = await claudeProcesses(agent);
      const loopbackKey =
        (
          await exec(
            agent,
            harness
              .map(
                (entry) =>
                  `tr '\\0' '\\n' < /proc/${entry.pid}/environ | sed -n 's/^ANTHROPIC_API_KEY=//p'`,
              )
              .join("; "),
            // Its own user: root there holds no capability to read
            // another user's process.
            `${SEPARATE_HARNESS.uid}:${SEPARATE_HARNESS.gid}`,
          )
        )
          .split("\n")
          .find(Boolean) ?? "";
      const grants = await exec(
        agent,
        "find / \\( -path /proc -o -path /sys \\) -prune -o -type f -path '*model-grants*' -print 2>/dev/null | while read -r f; do cat \"$f\"; echo; done",
        "0",
      );
      return {
        ...look,
        agent: {
          name: agent,
          ...(await inspected(agent)),
          mountsTable: await exec(agent, "cat /proc/mounts", "0"),
          harness: harness.map(({ uid, gid, groups }) => ({
            uid,
            gid,
            groups,
          })),
          // Each grant file holds one grant (ADR 0293).
          grantHashes: grants
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map(hash),
          loopbackKeyHash: loopbackKey ? hash(loopbackKey) : "",
        },
      };
    }
    const repositoryOf = (step: ReviewStep) =>
      [SHIPPED, CLAUDE_CODE].find((repository) =>
        step.prompt.includes(`${repository}#1`),
      ) ?? "";
    const inspection = (repository: string, turn: number) => {
      const found = inspections.get(`${repository}#${turn}`);
      if (!found)
        throw new Error(
          `${repository}'s turn ${turn} was not seen: ${lookFailures.join("; ")}`,
        );
      return found;
    };

    /** The project's newest succeeded cache fill. */
    const filled = (projectId: string) =>
      db()
        .selectFrom("environment_cache_fills")
        .select(["generation", "commit_sha"])
        .where("project_id", "=", projectId)
        .where("status", "=", "succeeded")
        .orderBy("generation", "desc")
        .executeTakeFirstOrThrow();

    /**
     * A project for `repository`, set up as production sets one up: the
     * repository attached, the packs deployed on main beside the
     * application, GitHub's main at the published main, the workflows on,
     * the poller's baseline taken, and the review cache filled from main on
     * the review machine.
     */
    async function setUpProject(input: {
      repository: string;
      files: Record<string, string>;
    }): Promise<Reviewed> {
      const core = server.catamorphic.core;
      const standIn = github.repository(input.repository);
      const project = { id: projectIds.get(input.repository) ?? "" };
      await core.db
        .updateTable("projects")
        .set({
          remote_url: `${github.url}/${input.repository}.git`,
          remote_branch: "main",
          default_branch: "main",
          remote_ownership: "attached",
        })
        .where("id", "=", project.id)
        .execute();
      const deployed = await core.deployment.deploy(
        SERVER_TENANT_ID,
        project.id,
        setup.externalUserId,
        {
          message: "Review pull requests",
          files: {
            ...filesOf("main"),
            ...input.files,
            ".work/package.json": JSON.stringify({
              name: "acme-work",
              private: true,
              workspaces: ["workflows"],
            }),
            ".work/workflows/package.json": JSON.stringify({
              name: "@acme/workflows",
              private: true,
              type: "module",
              dependencies: {
                "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
              },
            }),
          },
        },
      );
      expect(deployed.status, JSON.stringify(deployed)).toBe("deployed");
      const mainHead = deployed.commitSha ?? "";
      // GitHub's main is the project's published main, as after a sync:
      // read from Work's own origin through an ephemeral checkout.
      const published = await core.projectManager.openEphemeral({
        tenantId: SERVER_TENANT_ID,
        projectId: project.id,
      });
      try {
        await git(standIn.gitDirectory, [
          "fetch",
          "-q",
          published.repoPath,
          "+refs/heads/*:refs/work/*",
        ]);
        await git(standIn.gitDirectory, [
          "update-ref",
          "refs/heads/main",
          mainHead,
        ]);
      } finally {
        await published.dispose();
      }
      const work = path.join(root, "authors", input.repository);
      fs.mkdirSync(path.dirname(work), { recursive: true });
      await execute("git", ["clone", "-q", standIn.gitDirectory, work]);
      await git(work, ["checkout", "-q", "-b", "totals"]);
      expect(await git(work, ["rev-parse", "HEAD"])).toBe(mainHead);

      await core.secrets?.upsert({
        identity: setup,
        projectId: project.id,
        name: "GITHUB_WEBHOOK_SECRET",
        value: WEBHOOK_SECRET,
      });
      for (const [workflowName, environment] of [
        ["reviewPullRequests", undefined],
        ["answerReviewComments", undefined],
        ["closePullRequestChats", undefined],
        ["fillReviewCache", undefined],
        ["postReviews", "github-poster"],
        ["pollGithub", "github-poller"],
      ] as const) {
        const request = {
          identity: setup,
          projectId: project.id,
          workflowName,
          // The poller writes its cursor in the project store, which a
          // project automation cannot: its principal holds no documents
          // (ADR 0158), and a workflow declares no documents to consent
          // to. Until it can, it runs as the member who turned it on.
          owner:
            workflowName === "pollGithub"
              ? {
                  type: "member" as const,
                  externalUserId: setup.externalUserId,
                }
              : { type: "project" as const },
          ...(environment ? { environment } : {}),
        };
        const preview = await core.workflowEnablements.preview(request);
        await core.workflowEnablements.create({
          ...request,
          consentDigest: preview.consentDigest,
        });
      }

      // The schedules' first runs: the poller's baseline (it remembers the
      // repository as it is and records nothing), and a fill of the review
      // cache from main, on the review machine.
      await fire(project.id, ["fillReviewCache", "pollGithub"]);
      const fill = await waitFor(
        `${input.repository}'s review cache fill on the review machine`,
        async () => {
          const fills = await db()
            .selectFrom("environment_cache_fills")
            .selectAll()
            .where("project_id", "=", project.id)
            .execute();
          const failed = fills.find((entry) => entry.status === "failed");
          if (failed) throw new Error(`The fill failed: ${failed.error}`);
          return fills.find((entry) => entry.status === "succeeded");
        },
        25 * MINUTES,
      );
      expect(fill).toMatchObject({
        environment_name: "review",
        cache_name: "pnpm",
        commit_sha: mainHead,
        check_sandbox_id: null,
      });
      const entry: Reviewed = {
        repository: input.repository,
        github: standIn,
        projectId: project.id,
        mainHead,
        work,
        heads: [],
        chatKey: `pr-${input.repository}-1`,
      };
      projects.set(input.repository, entry);
      return entry;
    }

    /**
     * What every review shows: its chat in `review` on the review machine
     * at the head; the cache filled from the published main, mounted read
     * only in the command container, and what setup installed from there;
     * the tests run in the command container at the head; and the probe
     * the pull request planted reaching nothing.
     */
    async function expectReviewed(
      project: Reviewed,
      turn: number,
      head: string,
    ) {
      const chat = await reviewChat(project);
      expect(chat).toMatchObject({
        status: "active",
        external_user_id: "catamorphic:project",
        environment_name: "review",
        workspace: { ref: "refs/pull/1/head", commit: head },
      });
      expect(JSON.stringify(chat?.placement)).toContain("worker.review-1");

      const look = inspection(project.repository, turn);
      const fill = await filled(project.projectId);
      const volume = `work-volume-${cacheVolumeKey({
        projectId: project.projectId,
        environment: "review",
        name: "pnpm",
        generation: Number(fill.generation),
      })}`;
      expect(
        look.command.mounts.find((mount) => mount.Name === volume),
      ).toMatchObject({ Type: "volume", RW: false });
      expect(JSON.parse(look.cacheProvenance)).toMatchObject({
        cache: "pnpm",
        environment: "review",
        commit: project.mainHead,
        generation: Number(fill.generation),
      });
      // Setup ran in the command container: its writable store is an
      // overlay over the cache there, and it installed main's package
      // from the cache, fetching nothing.
      expect(look.commandMounts).toMatch(/ \S*\/pnpm\/store overlay /);
      expect(look.setupLog).toMatch(/reused 1, downloaded 0/);
      // No harness runs beside the change's code.
      expect(look.harnessBesideCommands).toEqual([]);

      const reviewTurn = model.turnsOf(`${project.repository}#1`)[turn - 1];
      const output = reviewTurn?.commandOutput ?? "";
      expect(output).toContain(head);
      expect(output).toContain(look.command.hostname);
      expect(output).toContain("tests passed");
      expect(reviewTurn?.readOutput).toContain("isNumber(line.amount)");
      expect(reviewTurn?.submitAnswer).toMatch(/Recorded the review result/);

      // The probe found the gateway and tried what it could read there;
      // every try was refused, none reached the model, and nothing it
      // read was the server's model key.
      const probed = JSON.parse(PROBE.exec(output)?.[1] ?? "null");
      expect(probed, output).not.toBeNull();
      expect(probed.gateways.length).toBeGreaterThan(0);
      expect(probed.attempts).toBeGreaterThan(0);
      expect(
        Object.keys(probed.statuses).filter((status) => status.startsWith("2")),
      ).toEqual([]);
      expect(probed.candidates).not.toContain(hash(MODEL_KEY));
      expect(
        model.requests.filter((request) =>
          JSON.stringify(request.body.metadata ?? null).includes("work-probe"),
        ),
      ).toEqual([]);
      return { look, probed };
    }

    /** One check run and one review on the commit, by the App. */
    function expectPublishedOnce(
      project: Reviewed,
      commit: string,
      verdict: { conclusion: string; state: string },
    ) {
      expect(
        project.github.checkRuns.filter((run) => run.head_sha === commit),
      ).toMatchObject([
        {
          name: "Work review",
          status: "completed",
          conclusion: verdict.conclusion,
          app: { slug: "work-acme" },
        },
      ]);
      const reviews = project.github.reviews.filter(
        (entry) => entry.commit_id === commit,
      );
      expect(reviews).toMatchObject([
        {
          state: verdict.state,
          user: github.bot,
          comments: [
            {
              path: "src/total.js",
              side: "RIGHT",
              line: expect.any(Number),
            },
          ],
        },
      ]);
    }

    beforeAll(async () => {
      database = await createTestDatabase("review_container");
      root = fs.mkdtempSync(path.join(os.tmpdir(), "work-rc-"));
      // Sandboxes reach the control plane at its public URL through their
      // egress proxy, which refuses this machine's loopback: HTTPS at an
      // address of this machine, as in production. The worker calls it
      // on loopback.
      const hostIp =
        Object.values(os.networkInterfaces())
          .flat()
          .find((entry) => entry?.family === "IPv4" && !entry.internal)
          ?.address ?? "";
      if (!hostIp) throw new Error("This machine has no external IPv4 address");
      github = await startGithubStandIn({
        repositories: [SHIPPED, CLAUDE_CODE],
        gitRoot: path.join(root, "github"),
        app: {
          id: "123",
          slug: "work-acme",
          installationId: 77,
          privateKey: APP_KEY,
        },
      });
      model = await startReviewModel({
        command: "git rev-parse HEAD && hostname && pnpm test",
        read: "src/total.js",
        onTurnStart: async (step) => {
          const repository = repositoryOf(step);
          try {
            inspections.set(
              `${repository}#${step.turn}`,
              await inspectSandbox(reviewed(repository)),
            );
          } catch (error) {
            // Kept for the assertion that reads the look, which then says
            // why there is none.
            lookFailures.push(
              `${repository || step.prompt.slice(0, 80)}#${step.turn}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
        review: (step) => {
          const project = reviewed(repositoryOf(step));
          const reviewedCommit =
            /\b[0-9a-f]{40}\b/.exec(step.commandOutput)?.[0] ?? "";
          const line =
            fs
              .readFileSync(path.join(project.work, "src", "total.js"), "utf8")
              .split("\n")
              .findIndex((text) => text.includes("isNumber(")) + 1;
          return step.turn === 1
            ? {
                reviewedCommit,
                verdict: "REQUEST_CHANGES",
                score: 3,
                summary:
                  "One blocking issue: a string amount is counted, so a total can mix units.",
                checkSummary:
                  "Ran the tests (they pass) and read src/total.js at the head.",
                comments: [
                  {
                    path: "src/total.js",
                    line,
                    body: 'is-number accepts numeric strings, so an amount of "3" is added as 3.',
                  },
                ],
              }
            : {
                reviewedCommit,
                verdict: "COMMENT",
                score: 4,
                summary: "The total is in cents now; nothing blocks.",
                checkSummary:
                  "Ran the tests at the new head (they pass) and read src/total.js.",
                comments: [
                  {
                    path: "src/total.js",
                    line,
                    body: "Rounding each line before summing keeps cents exact.",
                  },
                ],
              };
        },
      });
      const gatewayFile = path.join(root, "gateway.json");
      fs.writeFileSync(
        gatewayFile,
        JSON.stringify({
          connections: [
            {
              type: "model",
              kind: "anthropic",
              displayName: "Anthropic",
              api: "anthropic",
              baseUrl: model.url,
            },
          ],
        }),
      );
      const port = await freePort();
      front = await startTlsFront({
        host: hostIp,
        upstreamPort: port,
        directory: path.join(root, "tls"),
      });
      // The server's own model, which the built-in reviewer runs on: its
      // provider reads the API's address from the host's environment.
      process.env.ANTHROPIC_BASE_URL = `${model.url}/v1`;
      server = await createWorkServer({
        ...testServerOptions({
          dataDir: path.join(root, "control-plane"),
          publicBases: [front.url, `http://127.0.0.1:${port}`],
          env: {
            DATABASE_URL: database.url,
            WORK_SECRET: SERVER_SECRET,
            WORK_OPERATOR_SECRET: OPERATOR_SECRET,
            WORK_VAULT_KEY: VAULT_KEY,
            ANTHROPIC_API_KEY: MODEL_KEY,
            WORK_MODEL: MODEL,
            WORK_CONTROL_PLANE_WORKLOADS: "workflow",
            WORK_GATEWAY_CONFIG: gatewayFile,
            PATH: process.env.PATH,
          },
        }),
        hooks: {
          github: {
            apiBaseUrl: github.url,
            webBaseUrl: github.url,
            fetch: github.fetch,
          },
        },
      });
      await server.app.listen({ port, host: "127.0.0.1" });
      const connections = server.catamorphic.core.connections;
      if (!connections) throw new Error("Connections are required");
      // The organization's GitHub App, and a model key for reviewers that
      // run in the sandbox, as service connections an administrator
      // authorized once.
      for (const [name, providerKind, callback] of [
        [
          "github",
          "github",
          { appId: "123", privateKey: APP_KEY, installationId: "77" },
        ],
        ["anthropic", "anthropic", { apiKey: MODEL_KEY }],
      ] as const) {
        const created = await connections.createService({
          identity: setup,
          name,
          providerKind,
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
          callback,
        });
      }
      // The two projects, and a review pool machine opened to them: the
      // container backend under gVisor, enrolled through the operator
      // route as an operator would.
      for (const repository of [SHIPPED, CLAUDE_CODE])
        projectIds.set(
          repository,
          (
            await server.catamorphic.core.projects.create(setup, {
              name: repository,
            })
          ).id,
        );
      machine = await enrollMachine({
        server,
        operatorSecret: OPERATOR_SECRET,
        controlPlaneUrl: `http://127.0.0.1:${port}`,
        name: "review-1",
        labels: { pool: "review" },
        access: { projects: [...projectIds.values()] },
        dataDir: path.join(root, "review-1"),
        execution: executionSettingsFromEnv({
          WORK_SANDBOX: "container",
          WORK_CONTAINER_RUNTIME: "runsc",
          WORK_SANDBOX_IMAGE: SANDBOX_IMAGE,
          WORK_MAX_WORKSPACES: "4",
          PATH: process.env.PATH,
          ...(process.env.DOCKER_HOST
            ? { DOCKER_HOST: process.env.DOCKER_HOST }
            : {}),
        }),
      });
    }, 15 * MINUTES);

    afterAll(async () => {
      await machine?.stop();
      await server?.shutdown();
      delete process.env.ANTHROPIC_BASE_URL;
      await front?.close();
      await github?.close();
      await model?.close();
      // What the machine made: its sandboxes.
      for (const container of await docker
        .listContainers({ label: ["work.sandbox"] })
        .catch(() => []))
        if (typeof container.Id === "string")
          await docker.removeContainer(container.Id).catch(() => {});
      await database?.drop();
      if (root) {
        const writable = (directory: string) => {
          fs.chmodSync(directory, 0o700);
          for (const entry of fs.readdirSync(directory, {
            withFileTypes: true,
          }))
            if (entry.isDirectory()) writable(path.join(directory, entry.name));
        };
        try {
          writable(root);
        } catch {
          // Removed below as far as it can be.
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 10 * MINUTES);

    describe("the pack as it ships: the built-in reviewer", () => {
      beforeAll(async () => {
        await setUpProject({
          repository: SHIPPED,
          files: reviewPack({ repository: SHIPPED, ca: front?.ca ?? "" }),
        });
      }, 30 * MINUTES);

      it(
        "reviews an opened pull request in the command container and publishes it once",
        async () => {
          const project = reviewed(SHIPPED);
          const head = await openPullRequest(project);
          await waitFor(
            "the first head's review on GitHub",
            () =>
              project.github.reviews.find((entry) => entry.commit_id === head),
            20 * MINUTES,
          );
          const posts = await settledPosts(project, 1);
          expect(
            posts.every((run) => run.environment_name === "github-poster"),
          ).toBe(true);
          await expectReviewed(project, 1, head);
          // The reviewer ran on the control plane, on the server's model.
          for (const request of model.requests)
            expect(request.headers?.["x-api-key"]).toBe(MODEL_KEY);
          expectPublishedOnce(project, head, {
            conclusion: "failure",
            state: "CHANGES_REQUESTED",
          });
          for (const write of project.github.writes())
            expect(write.credential).toBe("installation");
          expect(
            project.github
              .writes()
              .map((write) => `${write.method} ${write.path}`)
              .sort(),
          ).toEqual([
            `POST /repos/${SHIPPED}/check-runs`,
            `POST /repos/${SHIPPED}/pulls/1/reviews`,
          ]);
        },
        30 * MINUTES,
      );

      it(
        "moves the same chat to a pushed head and publishes its review",
        async () => {
          const project = reviewed(SHIPPED);
          const before = (await reviewChat(project))?.id;
          const previous = project.heads.at(-1) ?? "";
          const head = await push(project, "pull-2", "Total in cents");
          await project.github.pushed({ number: 1 });
          // The poller records `synchronize`; the chat moves to the new head.
          await fire(project.projectId, ["pollGithub"]);
          await waitFor(
            "the pushed head's review on GitHub",
            () =>
              project.github.reviews.find((entry) => entry.commit_id === head),
            20 * MINUTES,
          );
          await settledPosts(project, 2);
          expect((await reviewChat(project))?.id).toBe(before);
          const delivered = await db()
            .selectFrom("agent_items")
            .select("text")
            .where("session_id", "=", before ?? "")
            .where("kind", "=", "inbound_message")
            .orderBy("position", "desc")
            .executeTakeFirstOrThrow();
          expect(delivered.text).toContain(
            `New commits since your last review (${previous}..${head})`,
          );
          await expectReviewed(project, 2, head);
          // Each head carries its own check run and review, once.
          expectPublishedOnce(project, previous, {
            conclusion: "failure",
            state: "CHANGES_REQUESTED",
          });
          expectPublishedOnce(project, head, {
            conclusion: "success",
            state: "COMMENTED",
          });
        },
        30 * MINUTES,
      );

      it(
        "closing the pull request closes the chat and releases its sandbox",
        async () => {
          const project = reviewed(SHIPPED);
          const chat = await reviewChat(project);
          const container = await commandContainerOf(project);
          expect(container).not.toBe("");
          project.github.close({ number: 1 });
          // The poller records `closed`; closePullRequestChats closes the chat.
          await fire(project.projectId, ["pollGithub"]);
          await waitFor(
            "the review chat to close",
            async () =>
              (await reviewChat(project))?.status === "closed"
                ? true
                : undefined,
            5 * MINUTES,
          );
          await waitFor(
            "the review sandbox's containers to be gone",
            async () =>
              (await docker.inspectContainer(container)) === undefined &&
              (await docker.inspectContainer(`${container}-agent`)) ===
                undefined
                ? true
                : undefined,
            5 * MINUTES,
          );
          const allocation = await db()
            .selectFrom("agent_sessions")
            .innerJoin(
              "execution_allocations",
              "execution_allocations.id",
              "agent_sessions.allocation_id",
            )
            .select("execution_allocations.status")
            .where("agent_sessions.id", "=", chat?.id ?? "")
            .executeTakeFirstOrThrow();
          expect(allocation.status).toBe("released");
          // Closing posts nothing.
          expect(
            project.github
              .writes()
              .map((write) => `${write.method} ${write.path}`)
              .sort(),
          ).toEqual([
            `POST /repos/${SHIPPED}/check-runs`,
            `POST /repos/${SHIPPED}/check-runs`,
            `POST /repos/${SHIPPED}/pulls/1/reviews`,
            `POST /repos/${SHIPPED}/pulls/1/reviews`,
          ]);
        },
        15 * MINUTES,
      );
    });

    describe("the reviewer made Claude Code", () => {
      beforeAll(async () => {
        await setUpProject({
          repository: CLAUDE_CODE,
          files: claudeCodeReviewPack(
            reviewPack({ repository: CLAUDE_CODE, ca: front?.ca ?? "" }),
          ),
        });
      }, 30 * MINUTES);

      it(
        "runs the CLI in the agent container as its own user, its commands in the command container, and publishes once",
        async () => {
          const project = reviewed(CLAUDE_CODE);
          const asked = model.requests.length;
          const head = await openPullRequest(project);
          await waitFor(
            "the Claude Code review on GitHub",
            () =>
              project.github.reviews.find((entry) => entry.commit_id === head),
            20 * MINUTES,
          );
          await settledPosts(project, 1);
          const { look, probed } = await expectReviewed(project, 1, head);
          const agent = look.agent;
          if (!agent) throw new Error("The agent container was not inspected");

          // The harness: Claude Code in the agent container, as its own
          // user with no other group; the cache and setup's store are not
          // there, and the tests did not run there.
          expect(agent.harness.length).toBeGreaterThan(0);
          for (const process of agent.harness) {
            expect(process).toMatchObject({
              uid: String(SEPARATE_HARNESS.uid),
              gid: String(SEPARATE_HARNESS.gid),
            });
            expect(
              process.groups
                .split(/\s+/)
                .filter(Boolean)
                .every((group) => group === String(SEPARATE_HARNESS.gid)),
            ).toBe(true);
          }
          expect(
            agent.mounts.some((mount) =>
              mount.Name?.startsWith("work-volume-cache-"),
            ),
          ).toBe(false);
          expect(agent.mountsTable).not.toMatch(/pnpm\/store/);
          const output =
            model.turnsOf(`${CLAUDE_CODE}#1`)[0]?.commandOutput ?? "";
          expect(output).not.toContain(agent.hostname);

          // Nothing the pull request's code reached held the attempt's model
          // grant or the CLI's loopback key.
          expect(agent.grantHashes.length).toBeGreaterThan(0);
          expect(agent.loopbackKeyHash).not.toBe("");
          for (const secret of [...agent.grantHashes, agent.loopbackKeyHash])
            expect(probed.candidates).not.toContain(secret);
          // Its model calls came through the gateway, which alone holds the
          // organization's key.
          const calls = model.requests.slice(asked);
          expect(calls.length).toBeGreaterThan(0);
          for (const request of calls)
            expect(request.headers?.["x-api-key"]).toBe(MODEL_KEY);

          expectPublishedOnce(project, head, {
            conclusion: "failure",
            state: "CHANGES_REQUESTED",
          });
        },
        30 * MINUTES,
      );
    });
  },
);
