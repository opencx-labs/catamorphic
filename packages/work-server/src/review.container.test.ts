import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
  registryPackDependencies,
  testServerOptions,
} from "./test-support.js";
import {
  type GithubActor,
  type GithubStandIn,
  type StandInRepository,
  startGithubStandIn,
} from "./testing/github-stand-in.js";
import {
  reviewImageTrusting,
  reviewImageWithClaudeCode,
} from "./testing/review-images.js";
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
 * publish: the check shows each review in progress from before its turn
 * starts, every finding posts inline while its turn still works, and the
 * verdict completes the same check (ADR 0337); the machine reports its
 * disk, and admission places the fill and the reviews within its floor
 * (ADR 0336).
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
/** The server's own model key, which the built-in reviewer runs on. */
const SERVER_MODEL_KEY = `sk-ant-server-${randomBytes(12).toString("hex")}`;
/** The model connection's key, which Claude Code reaches through the gateway. */
const CONNECTION_MODEL_KEY = `sk-ant-connection-${randomBytes(12).toString("hex")}`;
/**
 * What the probe's own model requests say (`test/probe.js`); it never
 * prints it, so a model call carrying it came from the probe.
 */
const PROBE_MARK = "a key this pull request found";
/**
 * Every wait ends by then, with where things stand: CI passes a time
 * measured from its job's start (`WORK_TEST_REVIEW_DEADLINE`, epoch
 * milliseconds), so a cold run reports before the job's timeout however
 * long the steps before this test took; otherwise 45 minutes from now
 * (`WORK_TEST_REVIEW_MINUTES`).
 */
const DEADLINE = Math.min(
  Date.now() + Number(process.env.WORK_TEST_REVIEW_MINUTES ?? 45) * 60_000,
  Number(process.env.WORK_TEST_REVIEW_DEADLINE ?? Number.POSITIVE_INFINITY),
);
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
const MIB = 1024 * 1024;
/**
 * The review machine's disk floor and the review cache's size, set as a
 * team sizes them to its machines (ADR 0336): admission keeps the floor
 * free and a fill reserves its cache's whole size, so the pack's 16 GiB
 * cache and the default floor (10% of the disk) would make this test
 * depend on how much free disk the machine running it has.
 */
const DISK_FLOOR_MB = 256;
const REVIEW_CACHE_MB = 512;
const MACHINE_ID = "worker.review-1";
/** What the check says while a review is under way (ADR 0337). */
const PHASES = ["Waiting to start", "Preparing the workspace", "Reviewing"];
/** A finding's marker, which its inline comment ends with. */
const findingMarker = (commit: string, id: string) =>
  `<!-- work-review:${commit}:finding:${id} -->`;

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
 * trigger and constant, the `prod` and `slack` bindings this organization
 * has not set up left out, and the review cache sized to the machine. The
 * image also trusts the test's own CA, as a production image trusts the
 * public chain.
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
  expect(review.caches.pnpm.sizeMb).toBe(16384);
  review.caches.pnpm.sizeMb = REVIEW_CACHE_MB;
  delete review.connections.prod;
  delete review.connections.slack;
  manifest.environments["github-poller"] = JSON.parse(
    polling[".work/project.json"] ?? "{}",
  ).environments["github-poller"];
  return {
    ...polling,
    ...pack,
    ".work/project.json": JSON.stringify(manifest, null, 2),
    ".work/images/review.Dockerfile": reviewImageTrusting({
      dockerfile: pack[".work/images/review.Dockerfile"] ?? "",
      ca: input.ca,
    }),
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
  return {
    ...files,
    ".work/project.json": JSON.stringify(manifest, null, 2),
    ".work/agents/reviewer.json": JSON.stringify(reviewer, null, 2),
    ".work/images/review.Dockerfile": reviewImageWithClaudeCode(
      files[".work/images/review.Dockerfile"] ?? "",
    ),
  };
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
    /** The head's check runs as each turn's first model call found them. */
    const progressAtStart = new Map<
      string,
      Array<{ status: string; title: unknown }>
    >();
    /**
     * Each turn's first finding on GitHub while the turn still worked: the
     * turn's status then, and whether the verdict was posted yet.
     */
    const midTurn = new Map<
      string,
      { turnStatuses: string[]; verdictPosted: boolean }
    >();
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
        .select([
          "id",
          "status",
          "error",
          "environment_name",
          "created_at",
          "delivery_key",
        ])
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
      progressAtStart: Object.fromEntries(progressAtStart),
      midTurn: Object.fromEntries(midTurn),
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
      const deadline = Math.min(Date.now() + timeoutMs, DEADLINE);
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
     * last of them is due. Resolves once the run of each one's due
     * occurrence (its delivery key, `<activation>:<when>`) completed,
     * whichever tick started it: the server's own ticker runs too.
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
        .select([
          "enablement.workflow_name",
          "binding.activation_id",
          "binding.next_fire_at",
        ])
        .where("enablement.project_id", "=", projectId)
        .where("enablement.workflow_name", "in", [...workflowNames])
        .execute();
      expect(bindings.map((binding) => binding.workflow_name).sort()).toEqual(
        [...workflowNames].sort(),
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
        bindings.map((binding) => {
          const key = `${binding.activation_id}:${new Date(binding.next_fire_at ?? 0).toISOString()}`;
          return waitFor(
            `the scheduled run of ${binding.workflow_name} to complete`,
            async () => {
              const run = (await runsOf(projectId, binding.workflow_name)).find(
                (entry) => entry.delivery_key === key,
              );
              if (run?.status === "failed")
                throw new Error(
                  `${binding.workflow_name} failed: ${JSON.stringify(run.error)}`,
                );
              return run?.status === "completed" ? run : undefined;
            },
            5 * MINUTES,
          );
        }),
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

    /** The App's "Work review" runs on a commit, with what each says. */
    const runsOn = (project: Reviewed, commit: string) =>
      project.github.checkRuns
        .filter((run) => run.head_sha === commit && run.name === "Work review")
        .map((run) => ({
          ...run,
          title: JSON.parse(JSON.stringify(run.output ?? {})).title as unknown,
        }));
    /** The review that carries a turn's verdict: stamped by its turn. */
    const verdictReview = (project: Reviewed, commit: string) =>
      project.github.reviews.find(
        (entry) =>
          entry.commit_id === commit &&
          /<!-- work-review:[0-9a-f-]{36}:review -->$/.test(entry.body),
      );
    /** What a project wrote to GitHub, a check run's id left out. */
    const writeKinds = (project: Reviewed) =>
      project.github
        .writes()
        .map(
          (write) =>
            `${write.method} ${write.path.replace(/\/check-runs\/\d+$/, "/check-runs/:id")}`,
        );
    const operatorMachines = async () =>
      (
        await server.operatorApp.inject({
          method: "GET",
          url: "/_work/operator/machines",
          headers: { authorization: `Bearer ${OPERATOR_SECRET}` },
        })
      ).json() as {
        machines: Array<{
          id: string;
          descriptor: {
            capabilities: string[];
            resources: { storageMb?: number };
          };
          disk?: {
            totalBytes: number;
            freeBytes: number;
            floorBytes: number;
            criticalBytes: number;
          };
          diskFresh: boolean;
          acceptingWork: boolean;
        }>;
      };

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
                // The packs' own, as their install steps add them.
                ...Object.fromEntries(
                  ["pull-request-reviews", "github-polling"]
                    .flatMap(registryPackDependencies)
                    .map((pinned) => {
                      const at = pinned.lastIndexOf("@");
                      return [pinned.slice(0, at), pinned.slice(at + 1)];
                    }),
                ),
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
          owner: { type: "project" as const },
          ...(environment ? { environment } : {}),
        };
        const preview = await core.workflowEnablements.preview(request);
        // Only the poller keeps state in the project store: its cursor, in
        // the folder it declares and its consent lists (ADR 0335).
        const documents =
          workflowName === "pollGithub"
            ? [{ path: "store/github-polling/", access: "write" }]
            : [];
        expect(preview.documents).toEqual(documents);
        const created = await core.workflowEnablements.create({
          ...request,
          consentDigest: preview.consentDigest,
        });
        expect(created).toMatchObject({
          owner: { type: "project" },
          documents,
        });
      }

      // The schedules' first runs: the poller's baseline (it remembers the
      // repository as it is and records nothing), and a fill of the review
      // cache from main, on the review machine.
      await fire(project.id, ["fillReviewCache", "pollGithub"]);
      // The baseline ran as the project, which holds the poller's folder
      // and nothing else of the store, and kept its cursor there.
      const cursor = await core.documents.read({
        identity: setup,
        projectId: project.id,
        path: `store/github-polling/${input.repository.replace("/", "-")}.json`,
      });
      expect(JSON.parse(cursor.text ?? "{}")).toMatchObject({
        repository: input.repository,
      });
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
      // Each finding was recorded as it was submitted, a resubmission
      // too, and then the review, which lists none (ADR 0337).
      expect(reviewTurn?.findings?.length).toBeGreaterThan(0);
      for (const finding of reviewTurn?.findings ?? [])
        expect(finding.answer).toMatch(/Recorded the finding result/);
      expect(reviewTurn?.submitted).not.toHaveProperty("comments");
      expect(reviewTurn?.submitAnswer).toMatch(/Recorded the review result/);

      // The probe found the gateway and tried everything it read as a key
      // there, through the egress proxy and TLS: the gateway refused every
      // try, none reached the model, and nothing it read was either model
      // key.
      const probed = JSON.parse(PROBE.exec(output)?.[1] ?? "null");
      expect(probed, output).not.toBeNull();
      expect(probed.gateways.length).toBeGreaterThan(0);
      expect(probed.attempts).toBeGreaterThan(0);
      expect(probed.skipped).toBe(0);
      expect(
        Object.keys(probed.statuses).filter(
          (status) => status !== "401" && status !== "403",
        ),
        JSON.stringify(probed.statuses),
      ).toEqual([]);
      for (const key of [SERVER_MODEL_KEY, CONNECTION_MODEL_KEY])
        expect(probed.candidates).not.toContain(hash(key));
      expect(
        model.requests.filter((request) =>
          JSON.stringify(request.body).includes(PROBE_MARK),
        ),
      ).toEqual([]);
      return { look, probed };
    }

    /**
     * Once a project's work has settled: no run of it still queued or
     * running and no turn of its chat still working, so a late duplicate
     * publication would have been made by now.
     */
    async function settle(project: Reviewed) {
      const chat = await reviewChat(project);
      await waitFor(
        `${project.repository}'s runs and turns to settle`,
        async () => {
          const failed = (await runsOf(project.projectId, "postReviews")).find(
            (run) => run.status === "failed",
          );
          if (failed)
            throw new Error(
              `postReviews failed: ${JSON.stringify(failed.error)}`,
            );
          const runs = await db()
            .selectFrom("workflow_runs")
            .select("status")
            .where("project_id", "=", project.projectId)
            .where("status", "not in", ["completed", "failed", "canceled"])
            .execute();
          const turns = await db()
            .selectFrom("agent_turns")
            .select("status")
            .where("session_id", "=", chat?.id ?? "")
            .where("status", "in", ["queued", "preparing", "running"])
            .execute();
          return runs.length === 0 && turns.length === 0 ? true : undefined;
        },
        5 * MINUTES,
      );
    }

    /** Git pushes, or starts of them, to a repository: none, ever. */
    const pushesTo = (repository: string) =>
      github.calls.filter(
        (call) =>
          call.path.startsWith(`/${repository}.git/`) &&
          (call.path.endsWith("/git-receive-pack") ||
            call.query.service === "git-receive-pack"),
      );

    /**
     * What a head's review published, by the App: one check run, shown in
     * progress and completed by the verdict, saying only what the review
     * was doing until then; each finding once, inline, in a review of its
     * own; and one review with the verdict that repeats none of them
     * (ADR 0337).
     */
    function expectPublished(
      project: Reviewed,
      commit: string,
      verdict: { conclusion: string; state: string; findings: string[] },
    ) {
      const [run, ...others] = runsOn(project, commit);
      expect(others).toEqual([]);
      expect(run).toMatchObject({
        status: "completed",
        conclusion: verdict.conclusion,
        app: { slug: "work-acme" },
        external_id: expect.stringMatching(/^work-review:1:progress:/),
      });
      const writes = project.github.writes();
      expect(
        writes.filter(
          (write) =>
            write.method === "POST" &&
            write.path.endsWith("/check-runs") &&
            JSON.stringify(write.body).includes(commit),
        ),
      ).toMatchObject([
        {
          body: {
            name: "Work review",
            head_sha: commit,
            status: "in_progress",
          },
        },
      ]);
      const updates = writes.filter(
        (write) =>
          write.method === "PATCH" &&
          write.path.endsWith(`/check-runs/${run?.id}`),
      );
      expect(updates.at(-1)?.body).toMatchObject({
        status: "completed",
        conclusion: verdict.conclusion,
      });
      // Until then it said what the review was doing, only moving forward.
      const [created] = writes.filter(
        (write) =>
          write.method === "POST" &&
          write.path.endsWith("/check-runs") &&
          JSON.stringify(write.body).includes(commit),
      );
      for (const update of updates.slice(0, -1))
        expect(update.body).not.toHaveProperty("conclusion");
      const said = [created, ...updates.slice(0, -1)].map((write) =>
        PHASES.indexOf(JSON.parse(JSON.stringify(write?.body)).output?.title),
      );
      expect(said.every((phase) => phase >= 0)).toBe(true);
      expect(said).toEqual([...said].sort((left, right) => left - right));
      // Every review names the commit it is for.
      expect(
        project.github.reviews.filter(
          (entry) => !project.heads.includes(entry.commit_id ?? ""),
        ),
      ).toEqual([]);
      const reviews = project.github.reviews.filter(
        (entry) => entry.commit_id === commit,
      );
      const verdictOne = verdictReview(project, commit);
      expect(
        reviews.filter((entry) => entry !== verdictOne),
        "the findings' own reviews",
      ).toMatchObject(
        verdict.findings.map((id) => ({
          state: "COMMENTED",
          user: github.bot,
          body: findingMarker(commit, id),
          comments: [
            {
              path: "src/total.js",
              side: "RIGHT",
              line: expect.any(Number),
              body: expect.stringMatching(
                new RegExp(`${findingMarker(commit, id)}$`),
              ),
            },
          ],
        })),
      );
      for (const id of verdict.findings)
        expect(
          project.github.reviewComments.filter((comment) =>
            comment.body.endsWith(findingMarker(commit, id)),
          ),
          `${id} posted once`,
        ).toHaveLength(1);
      expect(verdictOne).toMatchObject({
        state: verdict.state,
        user: github.bot,
        comments: [],
      });
      expect(verdictOne?.body).not.toContain(":finding:");
    }

    /**
     * A head's progress before its turn ran: by the turn's first model call
     * its check run was in progress, and it was made saying the review
     * waited or was being prepared (its new sandbox, checkout and setup
     * take far longer than a publication).
     */
    function expectProgressBeforeStart(
      project: Reviewed,
      commit: string,
      turn: number,
    ) {
      expect(
        progressAtStart.get(`${project.repository}#${turn}`),
        lookFailures.join("; "),
      ).toEqual([{ status: "in_progress", title: expect.any(String) }]);
      const [created] = project.github
        .writes()
        .filter(
          (write) =>
            write.method === "POST" &&
            write.path.endsWith("/check-runs") &&
            JSON.stringify(write.body).includes(commit),
        );
      expect(JSON.parse(JSON.stringify(created?.body)).output?.title).toMatch(
        /^(?:Waiting to start|Preparing the workspace)$/,
      );
    }

    /** A turn's first finding was on GitHub while the turn still worked. */
    function expectFindingMidTurn(repository: string, turn: number) {
      expect(
        midTurn.get(`${repository}#${turn}`),
        lookFailures.join("; "),
      ).toEqual({ turnStatuses: ["running"], verdictPosted: false });
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
      /** The line the change's fix is on, in the author's working copy. */
      const fixLine = (project: Reviewed) =>
        fs
          .readFileSync(path.join(project.work, "src", "total.js"), "utf8")
          .split("\n")
          .findIndex((text) => text.includes("isNumber(")) + 1;
      const reviewedCommitOf = (commandOutput: string) =>
        /\b[0-9a-f]{40}\b/.exec(commandOutput)?.[0] ?? "";
      model = await startReviewModel({
        command: "git rev-parse HEAD && hostname && pnpm test",
        read: "src/total.js",
        onTurnStart: async (step) => {
          const repository = repositoryOf(step);
          const key = `${repository}#${step.turn}`;
          try {
            const project = reviewed(repository);
            const head = project.heads.at(-1) ?? "";
            // What the head's check said before this first model call.
            progressAtStart.set(
              key,
              runsOn(project, head).map(({ status, title }) => ({
                status,
                title,
              })),
            );
            inspections.set(key, await inspectSandbox(project));
            // While the turn works, its check says so.
            await waitFor(
              `${key}'s check to say it is reviewing`,
              () =>
                runsOn(project, head).find(
                  (run) =>
                    run.status === "in_progress" && run.title === "Reviewing",
                ),
              3 * MINUTES,
            );
          } catch (error) {
            // Kept for the assertion that reads the look, which then says
            // why there is none.
            lookFailures.push(
              `${repository || step.prompt.slice(0, 80)}#${step.turn}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
        // One verified problem a turn, submitted again after it posted: a
        // resubmission posts nothing (ADR 0337).
        findings: (step) => {
          const project = reviewed(repositoryOf(step));
          const finding =
            step.turn === 1
              ? {
                  id: "string-amount",
                  path: "src/total.js",
                  line: fixLine(project),
                  severity: "blocking",
                  title: "A numeric string is counted",
                  body: 'is-number accepts numeric strings, so an amount of "3" is added as 3.',
                }
              : {
                  id: "rounding",
                  path: "src/total.js",
                  line: fixLine(project),
                  severity: "minor",
                  title: "Rounding each line",
                  body: "Rounding each line before summing keeps cents exact.",
                };
          return step.turn === 1 ? [finding, finding] : [finding];
        },
        onFinding: async (step) => {
          if (step.index > 0) return;
          const repository = repositoryOf(step);
          const key = `${repository}#${step.turn}`;
          try {
            const project = reviewed(repository);
            const commit =
              reviewedCommitOf(
                model.turnsOf(`${repository}#1`)[step.turn - 1]
                  ?.commandOutput ?? "",
              ) ||
              (project.heads.at(-1) ?? "");
            const marker = findingMarker(commit, String(step.finding.id));
            // The poster posts it while this turn waits on its next step.
            await waitFor(
              `${key}'s finding inline on GitHub`,
              () =>
                project.github.reviewComments.find((comment) =>
                  comment.body.endsWith(marker),
                ),
              3 * MINUTES,
            );
            const chat = await reviewChat(project);
            const turns = await db()
              .selectFrom("agent_turns")
              .select("status")
              .where("session_id", "=", chat?.id ?? "")
              .where("status", "in", ["queued", "preparing", "running"])
              .execute();
            midTurn.set(key, {
              turnStatuses: turns.map((turn) => turn.status),
              verdictPosted: verdictReview(project, commit) !== undefined,
            });
          } catch (error) {
            lookFailures.push(
              `${key} finding: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
        // The review carries the verdict alone: its findings are posted.
        review: (step) => {
          const reviewedCommit = reviewedCommitOf(step.commandOutput);
          return step.turn === 1
            ? {
                reviewedCommit,
                verdict: "REQUEST_CHANGES",
                score: 3,
                summary:
                  "One blocking issue: a string amount is counted, so a total can mix units.",
                checkSummary:
                  "Ran the tests (they pass) and read src/total.js at the head.",
              }
            : {
                reviewedCommit,
                verdict: "COMMENT",
                score: 4,
                summary: "The total is in cents now; nothing blocks.",
                checkSummary:
                  "Ran the tests at the new head (they pass) and read src/total.js.",
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
      // The server listens on a port it is given; the front reads it then.
      const listening = { port: 0 };
      front = await startTlsFront({
        host: hostIp,
        upstreamPort: () => listening.port,
        directory: path.join(root, "tls"),
        // CI keeps the CA with the review images it built, which trust it.
        ...(process.env.WORK_TEST_REVIEW_CACHE
          ? { caDirectory: path.join(process.env.WORK_TEST_REVIEW_CACHE, "ca") }
          : {}),
      });
      // The server's own model, which the built-in reviewer runs on: its
      // provider reads the API's address from the host's environment.
      process.env.ANTHROPIC_BASE_URL = `${model.url}/v1`;
      server = await createWorkServer({
        ...testServerOptions({
          dataDir: path.join(root, "control-plane"),
          publicBases: [front.url],
          env: {
            DATABASE_URL: database.url,
            WORK_SECRET: SERVER_SECRET,
            WORK_OPERATOR_SECRET: OPERATOR_SECRET,
            WORK_VAULT_KEY: VAULT_KEY,
            ANTHROPIC_API_KEY: SERVER_MODEL_KEY,
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
      await server.app.listen({ port: 0, host: "127.0.0.1" });
      const address = server.app.server.address();
      listening.port =
        typeof address === "object" && address ? address.port : 0;
      const port = listening.port;
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
        ["anthropic", "anthropic", { apiKey: CONNECTION_MODEL_KEY }],
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
          WORK_DISK_FLOOR_MB: String(DISK_FLOOR_MB),
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
      // What this run's machine made, and nothing else on the daemon: its
      // containers, then its volumes (caches included). Its images stay
      // for the next run.
      const ownerHash = createHash("sha256")
        .update(path.resolve(path.join(root, "review-1", "container")))
        .digest("hex")
        .slice(0, 16);
      const owner = `work.sandbox.owner=${ownerHash}`;
      // The review images this run's machine built, which CI keeps for the
      // next run: only those, never another test's images on the daemon.
      if (process.env.WORK_TEST_REVIEW_CACHE) {
        const built = (
          await docker
            .listImages({ reference: "work.local/images" })
            .catch(() => [])
        ).flatMap((image) => {
          const labels = image.Labels;
          const tags = image.RepoTags;
          return labels &&
            typeof labels === "object" &&
            "work.sandbox.owner" in labels &&
            labels["work.sandbox.owner"] === ownerHash &&
            Array.isArray(tags)
            ? tags.filter(
                (tag): tag is string =>
                  typeof tag === "string" &&
                  tag.startsWith("work.local/images:"),
              )
            : [];
        });
        fs.mkdirSync(process.env.WORK_TEST_REVIEW_CACHE, { recursive: true });
        fs.writeFileSync(
          path.join(process.env.WORK_TEST_REVIEW_CACHE, "images.txt"),
          built.map((tag) => `${tag}\n`).join(""),
        );
      }
      for (const container of await docker
        .listContainers({ label: [owner] })
        .catch(() => []))
        if (typeof container.Id === "string")
          await docker.removeContainer(container.Id).catch(() => {});
      for (const volume of await docker
        .listVolumes({ label: [owner] })
        .catch(() => []))
        if (typeof volume.Name === "string")
          await docker.removeVolume(volume.Name).catch(() => {});
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
          const asked = model.requests.length;
          const head = await openPullRequest(project);
          await waitFor(
            "the first head's verdict on GitHub",
            () => verdictReview(project, head),
            20 * MINUTES,
          );
          const posts = await settledPosts(project, 1);
          expect(
            posts.every((run) => run.environment_name === "github-poster"),
          ).toBe(true);
          await expectReviewed(project, 1, head);
          // The reviewer ran on the control plane, on the server's model.
          const calls = model.requests.slice(asked);
          expect(calls.length).toBeGreaterThan(0);
          for (const request of calls)
            expect(request.headers?.["x-api-key"]).toBe(SERVER_MODEL_KEY);
          await settle(project);
          // The check was in progress before the turn's first model call
          // (its new sandbox, checkout and setup take far longer than a
          // publication), the finding was inline while the turn worked,
          // and the verdict completed the same check.
          expectProgressBeforeStart(project, head, 1);
          expectFindingMidTurn(SHIPPED, 1);
          expectPublished(project, head, {
            conclusion: "failure",
            state: "CHANGES_REQUESTED",
            findings: ["string-amount"],
          });
          expect(pushesTo(SHIPPED)).toEqual([]);
          for (const write of project.github.writes())
            expect(write.credential).toBe("installation");
          const kinds = writeKinds(project);
          expect([...new Set(kinds)].sort()).toEqual([
            `PATCH /repos/${SHIPPED}/check-runs/:id`,
            `POST /repos/${SHIPPED}/check-runs`,
            `POST /repos/${SHIPPED}/pulls/1/reviews`,
          ]);
          expect(
            kinds.filter((kind) => kind.startsWith("POST")).sort(),
          ).toEqual([
            `POST /repos/${SHIPPED}/check-runs`,
            `POST /repos/${SHIPPED}/pulls/1/reviews`,
            `POST /repos/${SHIPPED}/pulls/1/reviews`,
          ]);

          // The machine reports its disk, and admission placed the fill and
          // the review within it (ADR 0336): the fill reserved its cache's
          // size; the review's Environment asks for no storage.
          const listed = (await operatorMachines()).machines.find(
            (entry) => entry.id === MACHINE_ID,
          );
          expect(listed).toMatchObject({
            diskFresh: true,
            acceptingWork: true,
            disk: { floorBytes: DISK_FLOOR_MB * MIB },
          });
          const disk = listed?.disk;
          if (!disk) throw new Error("The review machine reports no disk");
          expect(disk.freeBytes).toBeGreaterThan(disk.floorBytes);
          expect(disk.criticalBytes).toBeLessThanOrEqual(disk.floorBytes);
          expect(listed?.descriptor.capabilities).toContain("disk");
          expect(listed?.descriptor.resources.storageMb).toBe(
            Math.floor((disk.totalBytes - disk.floorBytes) / MIB),
          );
          const fillAllocation = await db()
            .selectFrom("environment_cache_fills as fill")
            .innerJoin(
              "execution_allocations as allocation",
              "allocation.id",
              "fill.allocation_id",
            )
            .select([
              "allocation.worker_node_id",
              "allocation.reserved_storage_mb",
            ])
            .where("fill.project_id", "=", project.projectId)
            .where("fill.status", "=", "succeeded")
            .executeTakeFirstOrThrow();
          expect(fillAllocation).toEqual({
            worker_node_id: MACHINE_ID,
            reserved_storage_mb: REVIEW_CACHE_MB,
          });
          const chatAllocation = await db()
            .selectFrom("agent_sessions")
            .innerJoin(
              "execution_allocations as allocation",
              "allocation.id",
              "agent_sessions.allocation_id",
            )
            .select([
              "allocation.worker_node_id",
              "allocation.reserved_storage_mb",
              "allocation.status",
            ])
            .where("agent_sessions.project_id", "=", project.projectId)
            .where("agent_sessions.chat_key", "=", project.chatKey)
            .executeTakeFirstOrThrow();
          expect(chatAllocation).toMatchObject({
            worker_node_id: MACHINE_ID,
            reserved_storage_mb: 0,
          });
        },
        30 * MINUTES,
      );

      it(
        "moves the same chat to a pushed head and publishes its review",
        async () => {
          const project = reviewed(SHIPPED);
          const asked = model.requests.length;
          const before = (await reviewChat(project))?.id;
          const previous = project.heads.at(-1) ?? "";
          const head = await push(project, "pull-2", "Total in cents");
          await project.github.pushed({ number: 1 });
          // The poller records `synchronize`; the chat moves to the new head.
          await fire(project.projectId, ["pollGithub"]);
          await waitFor(
            "the pushed head's verdict on GitHub",
            () => verdictReview(project, head),
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
          for (const request of model.requests.slice(asked))
            expect(request.headers?.["x-api-key"]).toBe(SERVER_MODEL_KEY);
          await settle(project);
          // Each head carries its own check run, findings and review, once;
          // the new head's check was in progress while its turn worked.
          expectFindingMidTurn(SHIPPED, 2);
          expectPublished(project, previous, {
            conclusion: "failure",
            state: "CHANGES_REQUESTED",
            findings: ["string-amount"],
          });
          expectPublished(project, head, {
            conclusion: "success",
            state: "COMMENTED",
            findings: ["rounding"],
          });
          expect(pushesTo(SHIPPED)).toEqual([]);
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
          const written = project.github.writes().length;
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
          // Closing posts nothing: no check of the head is in progress.
          await settle(project);
          expect(project.github.writes().slice(written)).toEqual([]);
          expect(
            writeKinds(project).filter((kind) => kind.startsWith("POST")),
          ).toHaveLength(6);
          expect(pushesTo(SHIPPED)).toEqual([]);
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
            "the Claude Code review's verdict on GitHub",
            () => verdictReview(project, head),
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
          // Its model calls came only through the gateway, which alone
          // holds the model connection's key: never the server's own.
          const calls = model.requests.slice(asked);
          expect(calls.length).toBeGreaterThan(0);
          for (const request of calls)
            expect(request.headers?.["x-api-key"]).toBe(CONNECTION_MODEL_KEY);

          // Published once, and still once when everything has settled.
          const published = {
            conclusion: "failure",
            state: "CHANGES_REQUESTED",
            findings: ["string-amount"],
          };
          expectPublished(project, head, published);
          await settle(project);
          expectProgressBeforeStart(project, head, 1);
          expectFindingMidTurn(CLAUDE_CODE, 1);
          expectPublished(project, head, published);
          expect(
            writeKinds(project)
              .filter((kind) => kind.startsWith("POST"))
              .sort(),
          ).toEqual([
            `POST /repos/${CLAUDE_CODE}/check-runs`,
            `POST /repos/${CLAUDE_CODE}/pulls/1/reviews`,
            `POST /repos/${CLAUDE_CODE}/pulls/1/reviews`,
          ]);
          expect(pushesTo(CLAUDE_CODE)).toEqual([]);
        },
        30 * MINUTES,
      );
    });
  },
);
