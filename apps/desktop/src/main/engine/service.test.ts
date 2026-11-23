import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageChannel } from "node:worker_threads";
import {
  ConnectionUnavailableError,
  ProjectNotFoundError,
} from "@catamorphic/core";
import { GithubApiError } from "@catamorphic/github";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { codeHostAccessDenied } from "../code-host-fallback.js";
import { CredentialStorageError } from "../credential-encryption.js";
import type { EmbeddedServer } from "../server/boot.js";
import { ProjectRootsStore } from "../server/project-roots.js";
import type { EngineEvents, EngineHello } from "./api.js";
import { isNamedError, serveChannel } from "./channel.js";
import { connectEngine } from "./client.js";
import { engineService } from "./service.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * The engine's service over a real channel, in front of a server whose
 * project folders are the real store on a real database and whose other
 * members a test supplies. What the main process sees is what it will see
 * of an engine in a process of its own.
 */
async function connect(members: Record<string, unknown> = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "engine-"));
  cleanups.push(() => fs.rm(temporary, { recursive: true, force: true }));
  const database = new PGlite();
  cleanups.push(() => database.close());
  const projectRoots = new ProjectRootsStore(database);
  await projectRoots.init();

  const projects = new Map<string, { id: string; name: string }>();
  const created: unknown[] = [];
  const imported: unknown[] = [];
  const hostCalls: Array<{
    viewId?: string;
    viewSignal?: AbortSignal;
    call: { op: string };
  }> = [];
  const released: Array<{ viewId?: string; viewSignal?: AbortSignal }> = [];
  const listening = () => () => {};
  const server = {
    url: "http://127.0.0.1:4100",
    apiToken: "token",
    hasCodingAgent: true,
    github: { kind: "github" },
    projectRoots,
    onSessionsChanged: listening,
    personalEnvironment: { subscribe: listening },
    agentRegistry: { onHarnessDownloadProgress: listening },
    customizationProcesses: {
      start: async (owner: (typeof hostCalls)[number]) => {
        hostCalls.push({ ...owner, call: { op: "process-start" } });
        return { processId: "p1" };
      },
      list: async (owner: (typeof hostCalls)[number]) => {
        hostCalls.push({ ...owner, call: { op: "process-list" } });
        return [];
      },
      release: async (owner: (typeof released)[number]) => {
        released.push(owner);
      },
      inspect: () => [],
    },
    catamorphic: {
      core: {
        projects: {
          get: async (_identity: unknown, id: string) => {
            const project = projects.get(id);
            if (!project) throw new ProjectNotFoundError(id);
            return project;
          },
          create: async (
            _identity: unknown,
            input: { id: string; name: string },
          ) => {
            created.push(input);
            if (input.name === "Refused") throw new Error("No room");
            const project = { id: input.id, name: input.name };
            projects.set(input.id, project);
            return project;
          },
        },
        codeHosts: {
          importRepository: async (input: { id: string; fullName: string }) => {
            imported.push(input);
            const project = { id: input.id, name: input.fullName };
            projects.set(input.id, project);
            return project;
          },
          repository: async () => ({}),
        },
        agentSessions: {
          get: async (
            _identity: unknown,
            projectId: string,
            sessionId: string,
          ) => ({
            id: sessionId,
            projectId,
            status: "active",
            agentId: "agent",
            running: false,
            title: "A chat",
            // Megabytes in a long chat: never the main process's to carry.
            snapshot: {
              sequence: 1,
              items: [
                {
                  id: "m1",
                  kind: "user_message",
                  position: 0,
                  text: "hello",
                  status: "completed",
                },
              ],
              requests: [],
              turns: [],
            },
            turn: null,
            queued: [],
          }),
        },
      },
    },
    ...members,
  };

  let emit: ReturnType<typeof serveChannel<EngineEvents, EngineHello>>["emit"] =
    () => {};
  const service = engineService({
    // A server as far as the service reaches into it.
    server: server as unknown as EmbeddedServer,
    emit: (name, payload) => emit(name, payload),
  });
  const { port1, port2 } = new MessageChannel();
  cleanups.push(() => {
    service.dispose();
    port1.close();
    port2.close();
  });
  const served = serveChannel<EngineEvents, EngineHello>({
    port: port2,
    api: service.api,
    hello: service.hello,
  });
  emit = served.emit;
  const engine = await connectEngine({
    port: port1,
    lost: () => {},
    stop: () => {},
  });
  return {
    engine,
    projectRoots,
    temporary,
    created,
    imported,
    hostCalls,
    released,
  };
}

describe("the engine's service", () => {
  it("offers only the operations it names", async () => {
    const { engine } = await connect();
    expect(Object.keys(engine.sessionCheckouts).sort()).toEqual([
      "assigned",
      "bringToProjectFolder",
      "detail",
      "discard",
      "plan",
      "resolve",
      "worktreesAvailable",
    ]);
    // Core's own chat reads carry snapshots: the main process has `chats`.
    expect(Object.keys(engine.catamorphic.core.agentSessions).sort()).toEqual([
      "archiveSubsessionsOnAgent",
      "close",
      "command",
      "interrupt",
    ]);
    expect(Object.keys(engine.catamorphic.core.projects).sort()).toEqual([
      "commitAll",
      "delete",
      "get",
      "listFiles",
    ]);
  });

  describe("registering a folder", () => {
    it("creates the project in the engine, and the main process's copy has its folder when it resumes", async () => {
      const { engine, projectRoots, temporary, created } = await connect();
      const rootPath = path.join(temporary, "new");
      const project = await engine.projectRoots.register({
        rootPath,
        existing: false,
        create: { kind: "project", name: "New", empty: true },
      });
      expect(project).toMatchObject({ name: "New", reopened: false });
      expect(created).toEqual([
        { id: project.id, name: "New", rootPath, empty: true },
      ]);
      // The store's row, and the copy of it, without another message.
      expect(projectRoots.getSync(project.id)).toBe(rootPath);
      expect(engine.projectRoots.getSync(project.id)).toBe(rootPath);
      expect(engine.projectRoots.checkpointsEnabled(project.id)).toBe(true);
      expect(engine.projectRoots.checkpointsEnabled(project.id)).toBe(
        projectRoots.checkpointsEnabled(project.id),
      );
    });

    it("reopens a folder that already is a project, and says so", async () => {
      const { engine, temporary, created } = await connect();
      const rootPath = path.join(temporary, "again");
      const first = await engine.projectRoots.register({
        rootPath,
        existing: false,
        create: { kind: "project", name: "First" },
      });
      await fs.mkdir(rootPath, { recursive: true });
      const second = await engine.projectRoots.register({
        rootPath,
        existing: false,
        create: { kind: "project", name: "Second" },
      });
      // Whether its profile may have it is the main process's to say.
      expect(second).toEqual({ id: first.id, name: "First", reopened: true });
      expect(created).toHaveLength(1);
    });

    it("takes a registration back when its project could not be created", async () => {
      const { engine, projectRoots, temporary } = await connect();
      const rootPath = path.join(temporary, "refused");
      await expect(
        engine.projectRoots.register({
          rootPath,
          existing: false,
          create: { kind: "project", name: "Refused" },
        }),
      ).rejects.toThrow("No room");
      expect(projectRoots.entries()).toEqual([]);
      // Registered, then taken back: the copy saw both and ends without it.
      expect(engine.projectRoots.getSync("anything")).toBeUndefined();
      await expect(fs.stat(rootPath)).rejects.toThrow();
    });

    it("imports a repository without checkpoints of its own", async () => {
      const { engine, temporary, imported } = await connect();
      const rootPath = path.join(temporary, "repository");
      const project = await engine.projectRoots.register({
        rootPath,
        existing: false,
        automaticCheckpoints: false,
        create: { kind: "repository", fullName: "work/app", name: "App" },
      });
      expect(imported).toEqual([
        {
          identity: expect.any(Object),
          provider: "github",
          id: project.id,
          fullName: "work/app",
          name: "App",
          rootPath,
        },
      ]);
      expect(engine.projectRoots.checkpointsEnabled(project.id)).toBe(false);
    });

    it("moves and removes a folder under the copy", async () => {
      const { engine } = await connect();
      await engine.projectRoots.set(
        "5d0c7a55-2d0a-4f0b-9a55-2c3b8a8a0001",
        "/work/moved",
      );
      expect(
        engine.projectRoots.getSync("5d0c7a55-2d0a-4f0b-9a55-2c3b8a8a0001"),
      ).toBe("/work/moved");
      await engine.projectRoots.delete("5d0c7a55-2d0a-4f0b-9a55-2c3b8a8a0001");
      expect(
        engine.projectRoots.getSync("5d0c7a55-2d0a-4f0b-9a55-2c3b8a8a0001"),
      ).toBeUndefined();
    });
  });

  it("answers a chat as its row, and as voice reads it, never as its snapshot", async () => {
    const { engine } = await connect();
    const chat = await engine.chats.get("project", "session");
    expect(chat).toMatchObject({
      id: "session",
      status: "active",
      agentId: "agent",
      running: false,
    });
    expect(chat).not.toHaveProperty("snapshot");
    expect(chat).not.toHaveProperty("turn");
    const voice = await engine.chats.voice("project", "session");
    expect(voice.session).not.toHaveProperty("snapshot");
    expect(voice.chat).toEqual({
      messages: [{ id: "m1", role: "user", text: "hello", writing: false }],
      busy: false,
      questions: [],
    });
  });

  it("carries the errors the main process tells apart, by name", async () => {
    const failures = [
      new GithubApiError(404, "Not Found"),
      new ConnectionUnavailableError("github", "Connection expired"),
      new CredentialStorageError("The keychain is locked"),
    ];
    const { engine } = await connect({
      sessionMoveEligibility: async () => {
        throw failures.shift();
      },
    });
    const next = () =>
      engine.sessionMoveEligibility("p", "s").catch((cause: unknown) => cause);
    const notFound = await next();
    expect(codeHostAccessDenied(notFound)).toBe(true);
    expect(notFound).toMatchObject({ status: 404 });
    expect(codeHostAccessDenied(await next())).toBe(true);
    const locked = await next();
    expect(isNamedError(locked, "CredentialStorageError")).toBe(true);
    expect(locked).toMatchObject({ message: "The keychain is locked" });
    const missing = await engine.catamorphic.core.projects
      .get({ tenantId: "t", externalUserId: "u" }, "gone")
      .catch((cause: unknown) => cause);
    expect(isNamedError(missing, "ProjectNotFoundError")).toBe(true);
    // A failure of another kind stays one.
    expect(codeHostAccessDenied(missing)).toBe(false);
  });

  describe("a source view's lease", () => {
    const call = (view: AbortController, op: "process-list") => ({
      profileId: "profile",
      projectId: "project",
      modulePath: "/work/project/source.js",
      viewId: "view-1",
      viewSignal: view.signal,
      subject: "subject",
      access: { permissions: ["processes"] },
      workflows: [],
      call: { op },
    });

    it("is one signal in the engine for the view's life, aborted when the view closes", async () => {
      const { engine, hostCalls, released } = await connect();
      const view = new AbortController();
      await engine.customizationHost(call(view, "process-list"));
      await engine.customizationHost(call(view, "process-list"));
      const [first, second] = hostCalls;
      expect(first?.viewId).toBe("view-1");
      // The manager compares leases by their signal: one per view.
      expect(first?.viewSignal).toBeInstanceOf(AbortSignal);
      expect(second?.viewSignal).toBe(first?.viewSignal);
      expect(first?.viewSignal?.aborted).toBe(false);

      view.abort();
      await engine.customizationHost(call(view, "process-list"));
      // Told as the view closed, and again with the call that followed.
      expect(first?.viewSignal?.aborted).toBe(true);
      expect(hostCalls[2]?.viewSignal).toBe(first?.viewSignal);

      await engine.customizationProcesses.release({
        profileId: "profile",
        projectId: "project",
        modulePath: "/work/project/source.js",
        viewId: "view-1",
        viewSignal: view.signal,
      });
      expect(released[0]?.viewSignal).toBe(first?.viewSignal);

      // Released: a call that still arrives for it holds an ended lease.
      await engine.customizationHost(call(view, "process-list"));
      expect(hostCalls[3]?.viewSignal).not.toBe(first?.viewSignal);
      expect(hostCalls[3]?.viewSignal?.aborted).toBe(true);
    });

    it("ends a lease the engine has not met when its view was closed first", async () => {
      const { engine, hostCalls } = await connect();
      const view = new AbortController();
      view.abort();
      await engine.customizationHost(call(view, "process-list"));
      expect(hostCalls[0]?.viewSignal?.aborted).toBe(true);
    });
  });
});
