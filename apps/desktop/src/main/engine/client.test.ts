import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRoot } from "../server/project-roots.js";
import type { EngineEvents, EngineHello } from "./api.js";
import { type OperationTree, serveChannel } from "./channel.js";
import { connectEngine, engineInfo } from "./client.js";

const closers: Array<() => void> = [];
const unheard: unknown[] = [];
const onUnheard = (reason: unknown) => unheard.push(reason);
process.on("unhandledRejection", onUnheard);
afterEach(() => {
  for (const close of closers.splice(0)) close();
  vi.restoreAllMocks();
  unheard.length = 0;
});

const turn = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An engine a test answers for: the channel, the copy of project folders
 * and what the main process tells are real; only the server is missing.
 */
async function connect(
  operations: OperationTree = {},
  roots: ProjectRoot[] = [],
) {
  const { port1, port2 } = new MessageChannel();
  closers.push(() => {
    port1.close();
    port2.close();
  });
  const asked: string[] = [];
  const noted =
    (name: string, answer: (...args: never[]) => unknown = () => undefined) =>
    (...args: never[]) => {
      asked.push(name);
      return answer(...args);
    };
  const table = new Map(roots.map((root) => [root.projectId, root]));
  let emit: ReturnType<typeof serveChannel<EngineEvents, EngineHello>>["emit"] =
    () => {};
  const change = (root: ProjectRoot) => {
    if (root.rootPath === null) table.delete(root.projectId);
    else table.set(root.projectId, root);
    emit("projectRootChanged", root);
  };
  const api: OperationTree = {
    hasCodingAgent: noted("hasCodingAgent", () => true),
    suspendExecution: noted("suspendExecution"),
    resumeExecution: noted("resumeExecution"),
    syncSessionMailboxes: noted("syncSessionMailboxes"),
    refreshExternalSessions: noted("refreshExternalSessions"),
    shutdown: noted("shutdown"),
    projectRoots: {
      register: noted(
        "projectRoots.register",
        async (input: { rootPath: string }) => {
          change({
            projectId: "new",
            rootPath: input.rootPath,
            automaticCheckpoints: true,
          });
          return { id: "new", name: "New", reopened: false };
        },
      ),
      set: noted(
        "projectRoots.set",
        async (projectId: string, rootPath: string) =>
          change({ projectId, rootPath, automaticCheckpoints: false }),
      ),
      delete: noted("projectRoots.delete", async (projectId: string) =>
        change({ projectId, rootPath: null, automaticCheckpoints: false }),
      ),
    },
    agentRegistry: {},
    signInRecovery: {
      signedIn: noted("signInRecovery.signedIn"),
      failed: noted("signInRecovery.failed"),
      left: noted("signInRecovery.left"),
      returned: noted("signInRecovery.returned"),
      probe: noted("signInRecovery.probe"),
    },
    triggers: { onTerminalIdle: noted("triggers.onTerminalIdle") },
    personalEnvironment: {
      view: noted("personalEnvironment.view"),
      syncNow: noted("personalEnvironment.syncNow"),
      nudge: noted("personalEnvironment.nudge"),
    },
    customizationProcesses: {
      recoverProfile: noted("customizationProcesses.recoverProfile"),
      inspect: noted("customizationProcesses.inspect", () => []),
      stopByProcessId: noted("customizationProcesses.stopByProcessId"),
      release: noted("customizationProcesses.release"),
      viewClosed: noted("customizationProcesses.viewClosed"),
    },
    customizationHost: noted("customizationHost"),
    mcpAppViews: {
      open: noted("mcpAppViews.open"),
      call: noted("mcpAppViews.call"),
      document: noted("mcpAppViews.document"),
      close: noted("mcpAppViews.close"),
      closeOwner: noted("mcpAppViews.closeOwner"),
    },
    ...operations,
  };
  const served = serveChannel<EngineEvents, EngineHello>({
    port: port2,
    api,
    hello: {
      url: "http://127.0.0.1:4100",
      apiToken: "token-of-this-launch",
      githubKind: "github",
      projectRoots: [...table.values()],
    },
  });
  emit = served.emit;
  let lose: (error: Error) => void = () => {};
  const lostWith: Error[] = [];
  let stops = 0;
  const engine = await connectEngine({
    port: port1,
    lost: (listener) => {
      lose = listener;
    },
    stop: () => {
      stops += 1;
      port1.close();
      port2.close();
    },
    onLost: (error) => lostWith.push(error),
  });
  return {
    engine,
    emit,
    asked,
    lose: (error: Error) => lose(error),
    lostWith,
    stops: () => stops,
  };
}

describe("the main process's engine", () => {
  it("knows where the API listens, and its token, from the engine's first words", async () => {
    const { engine } = await connect();
    expect(engine.url).toBe("http://127.0.0.1:4100");
    expect(engine.apiToken).toBe("token-of-this-launch");
    expect(engine.github.kind).toBe("github");
    await expect(engineInfo(engine)).resolves.toEqual({
      url: "http://127.0.0.1:4100",
      hasCodingAgent: true,
    });
    await expect(engineInfo(null)).resolves.toEqual({
      url: null,
      hasCodingAgent: false,
    });
  });

  describe("its copy of project folders", () => {
    it("is whole from the first moment, and read without asking the engine", async () => {
      const { engine, asked } = await connect({}, [
        { projectId: "a", rootPath: "/work/a", automaticCheckpoints: true },
        { projectId: "b", rootPath: "/work/b", automaticCheckpoints: false },
      ]);
      expect(engine.projectRoots.getSync("a")).toBe("/work/a");
      expect(engine.projectRoots.checkpointsEnabled("a")).toBe(true);
      expect(engine.projectRoots.checkpointsEnabled("b")).toBe(false);
      await expect(engine.projectRoots.get("b")).resolves.toBe("/work/b");
      await expect(engine.projectRoots.get("unknown")).resolves.toBeNull();
      expect(engine.projectRoots.getSync("unknown")).toBeUndefined();
      expect(engine.projectRoots.checkpointsEnabled("unknown")).toBe(false);
      // Opening a chat reads its folder dozens of times: none is a message.
      expect(asked).toEqual([]);
    });

    it("is current when the caller that changed a folder resumes", async () => {
      const { engine } = await connect();
      const project = await engine.projectRoots.register({
        rootPath: "/work/new",
        existing: false,
        create: { kind: "project", name: "New" },
      });
      // No turn of the loop in between: the change came before the answer.
      expect(engine.projectRoots.getSync(project.id)).toBe("/work/new");
      expect(engine.projectRoots.checkpointsEnabled(project.id)).toBe(true);

      await engine.projectRoots.set(project.id, "/work/moved");
      expect(engine.projectRoots.getSync(project.id)).toBe("/work/moved");
      expect(engine.projectRoots.checkpointsEnabled(project.id)).toBe(false);

      await engine.projectRoots.delete(project.id);
      expect(engine.projectRoots.getSync(project.id)).toBeUndefined();
      await expect(engine.projectRoots.get(project.id)).resolves.toBeNull();
    });

    it("follows a change the engine made by itself", async () => {
      const { engine, emit } = await connect();
      emit("projectRootChanged", {
        projectId: "synced",
        rootPath: "/work/synced",
        automaticCheckpoints: false,
      });
      await turn();
      expect(engine.projectRoots.getSync("synced")).toBe("/work/synced");
    });
  });

  describe("what the engine says happened", () => {
    it("reaches whoever listens, until they stop", async () => {
      const { engine, emit } = await connect();
      const heard: string[] = [];
      const stops = [
        engine.onSessionsChanged(() => heard.push("sessions")),
        engine.onGitChanged((projectId) => heard.push(`git:${projectId}`)),
        engine.personalEnvironment.subscribe(({ projectId }) =>
          heard.push(`environment:${projectId}`),
        ),
        engine.agentRegistry.onHarnessDownloadProgress(({ receivedBytes }) =>
          heard.push(`download:${receivedBytes}`),
        ),
      ];
      const say = () => {
        emit("sessionsChanged", {});
        emit("gitChanged", { projectId: "p" });
        emit("personalEnvironmentChanged", { profileId: "x", projectId: "p" });
        emit("harnessDownloadProgress", {
          harness: "claude-code",
          displayName: "Claude Code",
          receivedBytes: 5,
          totalBytes: 10,
        });
      };
      say();
      await turn();
      expect(heard).toEqual([
        "sessions",
        "git:p",
        "environment:p",
        "download:5",
      ]);
      for (const stop of stops) stop();
      say();
      await turn();
      expect(heard).toHaveLength(4);
    });

    it("says its database was lost, once, also to whoever listens afterwards", async () => {
      const { engine, emit } = await connect();
      const early: string[] = [];
      engine.onDatabaseLost((error) => early.push(error.message));
      emit("databaseLost", { message: "The database thread stopped" });
      emit("databaseLost", { message: "Again" });
      await turn();
      expect(early).toEqual(["The database thread stopped"]);
      // Lost while Work was still starting: the window layer hears it too.
      const late: string[] = [];
      engine.onDatabaseLost((error) => late.push(error.message));
      expect(late).toEqual(["The database thread stopped"]);
    });
  });

  describe("what it only tells the engine", () => {
    it("is sent at once and answers nothing", async () => {
      const { engine, asked } = await connect();
      expect(engine.suspendExecution()).toBeUndefined();
      engine.resumeExecution();
      engine.syncSessionMailboxes();
      engine.refreshExternalSessions();
      engine.signInRecovery.left();
      engine.signInRecovery.returned();
      engine.signInRecovery.probe();
      engine.signInRecovery.signedIn("agent");
      engine.personalEnvironment.nudge();
      engine.mcpAppViews.closeOwner(7);
      engine.mcpAppViews.close({ ownerId: 7, mountId: "m" });
      await turn();
      // In the order they were told: a close never overtakes what it follows.
      expect(asked).toEqual([
        "suspendExecution",
        "resumeExecution",
        "syncSessionMailboxes",
        "refreshExternalSessions",
        "signInRecovery.left",
        "signInRecovery.returned",
        "signInRecovery.probe",
        "signInRecovery.signedIn",
        "personalEnvironment.nudge",
        "mcpAppViews.closeOwner",
        "mcpAppViews.close",
      ]);
    });

    it("never becomes a rejection nobody hears: refused by the engine, after it is lost, or after it closed", async () => {
      const complaint = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { engine, lose } = await connect({
        suspendExecution: () => {
          throw new Error("The worker would not stop");
        },
      });
      engine.suspendExecution();
      await turn();
      // Said, since nobody else will hear it.
      expect(complaint).toHaveBeenCalledTimes(1);
      expect(String(complaint.mock.calls[0]?.[0])).toContain(
        "'suspendExecution': The worker would not stop",
      );

      lose(new Error("The engine stopped"));
      engine.suspendExecution();
      engine.signInRecovery.left();
      engine.mcpAppViews.closeOwner(1);
      await turn();
      expect(unheard).toEqual([]);
      // Nothing is left to tell an engine that is gone.
      expect(complaint).toHaveBeenCalledTimes(1);

      const closed = await connect();
      await closed.engine.shutdown();
      closed.engine.resumeExecution();
      closed.engine.syncSessionMailboxes();
      closed.engine.personalEnvironment.nudge();
      await turn();
      expect(unheard).toEqual([]);
      expect(complaint).toHaveBeenCalledTimes(1);
    });
  });

  describe("a source view's lease", () => {
    const owner = (signal: AbortSignal) => ({
      profileId: "profile",
      projectId: "project",
      modulePath: "/work/project/source.js",
      viewId: "view-1",
      viewSignal: signal,
    });
    const call = (signal: AbortSignal) => ({
      ...owner(signal),
      subject: "subject",
      access: { permissions: ["processes"] },
      workflows: [],
      call: { op: "process-list" as const },
    });

    it("crosses as its id, and its end is told once", async () => {
      const received: unknown[] = [];
      const { engine, asked } = await connect({
        customizationHost: (input: unknown) => {
          received.push(input);
          return "listed";
        },
      });
      const view = new AbortController();
      await expect(engine.customizationHost(call(view.signal))).resolves.toBe(
        "listed",
      );
      await engine.customizationHost(call(view.signal));
      // The signal stays where the view lives.
      expect(received[0]).toMatchObject({ viewId: "view-1" });
      expect(received[0]).not.toHaveProperty("viewSignal");
      expect(received[0]).not.toHaveProperty("viewClosed");

      view.abort();
      await turn();
      expect(
        asked.filter((name) => name === "customizationProcesses.viewClosed"),
      ).toEqual(["customizationProcesses.viewClosed"]);

      // Asked after its view ended: the engine is told with the call.
      await engine.customizationHost(call(view.signal));
      expect(received[2]).toMatchObject({ viewId: "view-1", viewClosed: true });
      await engine.customizationProcesses.release(owner(view.signal));
      expect(asked.at(-1)).toBe("customizationProcesses.release");
    });
  });

  describe("shutting down", () => {
    it("lets what was asked before it finish, then refuses what is asked after", async () => {
      let finish: (value: string) => void = () => {};
      const order: string[] = [];
      const { engine, stops } = await connect({
        sessionCheckouts: {
          resolve: () =>
            new Promise<string>((resolve) => {
              finish = resolve;
            }),
        },
        shutdown: async () => {
          order.push("shutdown began");
          // The server stops HTTP, core and harnesses, then the database
          // once its work is quiet: what is in flight is answered first.
          finish("/work/a");
          await turn();
          order.push("shutdown ended");
        },
      });
      const inFlight = engine.sessionCheckouts
        .resolve({ projectId: "a", sessionId: "s" })
        .then((path) => {
          order.push(`answered ${path}`);
          return path;
        });
      await turn();
      const shutdown = engine.shutdown();
      // Asked twice (Quit, then a signal): one request, one answer.
      expect(engine.shutdown()).toBe(shutdown);
      await shutdown;
      await expect(inFlight).resolves.toBe("/work/a");
      expect(order).toEqual([
        "shutdown began",
        "answered /work/a",
        "shutdown ended",
      ]);
      expect(stops()).toBe(1);
      await expect(
        engine.sessionCheckouts.resolve({ projectId: "a", sessionId: "s" }),
      ).rejects.toThrow("The engine is closed");
      await expect(engine.hasCodingAgent()).rejects.toThrow(
        "The engine is closed",
      );
      expect(unheard).toEqual([]);
    });

    it("fails a caller whose operation never settled, rather than leave it waiting", async () => {
      const { engine } = await connect({
        sessionCheckouts: { resolve: () => new Promise<string>(() => {}) },
      });
      const held = engine.sessionCheckouts.resolve({
        projectId: "a",
        sessionId: "s",
      });
      await turn();
      await engine.shutdown();
      await expect(held).rejects.toThrow("The engine is closed");
    });

    it("closes the channel and says so when the engine did not shut down cleanly", async () => {
      const { engine, stops } = await connect({
        shutdown: async () => {
          throw new AggregateError(
            [new Error("Could not close database")],
            "Desktop shutdown did not complete cleanly",
          );
        },
      });
      const failure = await engine.shutdown().catch((cause: unknown) => cause);
      expect(failure).toMatchObject({
        name: "AggregateError",
        message: "Desktop shutdown did not complete cleanly",
      });
      expect(stops()).toBe(1);
      await expect(engine.hasCodingAgent()).rejects.toThrow(
        "The engine is closed",
      );
    });
  });

  it("fails what waits when the engine is lost, and says so to its owner", async () => {
    const { engine, lose, lostWith } = await connect({
      sessionCheckouts: { resolve: () => new Promise<string>(() => {}) },
    });
    const waiting = engine.sessionCheckouts.resolve({
      projectId: "a",
      sessionId: "s",
    });
    lose(new Error("The engine stopped unexpectedly"));
    await expect(waiting).rejects.toThrow("The engine stopped unexpectedly");
    expect(lostWith.map((error) => error.message)).toEqual([
      "The engine stopped unexpectedly",
    ]);
    // Its last copy of the folders stays readable: windows still close.
    expect(engine.projectRoots.getSync("unknown")).toBeUndefined();
  });
});
