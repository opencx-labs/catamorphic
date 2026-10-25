import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SESSION_METADATA_LIMITS } from "@catamorphic/agent-protocol";
import { app, ipcMain } from "electron";
import { z } from "zod";
import {
  accessBeyond,
  accessText,
  type CodeAccess,
  isEmptyAccess,
  type ModuleAccessRequest,
} from "../shared/code-access.js";
import { isHostAction, SOURCE_ACTION_PATTERN } from "../shared/sidebar.js";
import {
  type SidebarSourceWorkCall,
  sidebarSourceEffect,
} from "../shared/sidebar-source.js";
import {
  sanitizeSidebarSourceItem,
  sanitizeSidebarSourcePage,
} from "../shared/source-rows.js";
import {
  CHIPS_OWNER_ID,
  executableSource,
} from "../shared/workspace-config.js";
import type { CodeApprovals } from "./code-approvals.js";
import type { WindowProfileRegistry } from "./index.js";
import { describeModuleAccess, readModuleAccess } from "./module-access.js";
import { launchConfinedModule } from "./module-sandbox.js";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";
import { SidebarSourceRuntime } from "./sidebar-source-runtime.js";

const identity = z.object({
  projectId: z.string().min(1),
  sectionId: z.string().min(1),
});
const valuesSchema = z
  .record(z.string().max(40), z.string().max(8192))
  .refine((values) => Object.keys(values).length <= 4, "At most four values.");
const requestSchema = identity
  .extend({
    requestId: z.string().min(1),
    method: z.enum(["load", "action", "move", "drop", "reveal"]),
    parentId: z.string().max(4096).nullable().optional(),
    cursor: z.string().max(4096).optional(),
    query: z.string().max(4096).optional(),
    itemId: z.string().max(4096).optional(),
    action: z.string().max(80).optional(),
    values: valuesSchema.optional(),
    beforeId: z.string().max(4096).optional(),
    payload: z
      .object({
        kind: z.string().min(1).max(40),
        label: z.string().max(1000),
        url: z.string().max(8192).optional(),
      })
      .optional(),
    url: z.string().max(4096).optional(),
    after: z.unknown().optional(),
    // A session-scoped section's chat (ADR 0226), as the renderer holds it.
    session: z
      .object({
        id: z.string().min(1),
        title: z.string().nullable(),
        metadata: z
          .record(z.string(), z.json())
          .refine(
            (metadata) =>
              JSON.stringify(metadata).length <=
              SESSION_METADATA_LIMITS.totalBytes,
            "Session metadata is too large.",
          ),
      })
      .optional(),
  })
  .refine(
    (request) =>
      request.method !== "action" ||
      (request.itemId !== undefined && Boolean(request.action)),
    "Source actions require an item id and action name.",
  )
  .refine(
    (request) => request.method !== "move" || Boolean(request.itemId),
    "Moving a row requires its item id.",
  )
  .refine(
    (request) => request.method !== "drop" || request.payload !== undefined,
    "Dropping into a source requires a payload.",
  )
  .refine(
    (request) => request.method !== "reveal" || Boolean(request.url),
    "Revealing a row requires its target.",
  );
const workCallSchema: z.ZodType<SidebarSourceWorkCall> = z.discriminatedUnion(
  "op",
  [
    z.object({
      op: z.literal("read"),
      source: z.string().min(1).max(80),
      parentId: z.string().max(4096).nullable().optional(),
      cursor: z.string().max(4096).optional(),
    }),
    z.object({
      op: z.literal("execute"),
      source: z.string().min(1).max(80),
      itemId: z.string().max(4096),
      // Work's verbs or a source's own name (ADR 0234); never run:.
      action: z
        .string()
        .min(1)
        .max(80)
        .refine(
          (action) =>
            isHostAction(action) || SOURCE_ACTION_PATTERN.test(action),
          "That is not an action name.",
        ),
      values: valuesSchema.optional(),
    }),
    z.object({
      op: z.literal("call"),
      workflow: z.string().min(1).max(200),
      input: z.unknown().optional(),
    }),
  ],
);
const workResultSchema = z.object({
  callId: z.string().min(1),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().optional(),
});
/**
 * A module's request of Work, held to the access its process started with
 * (ADR 0277): a list it names in `lists`, a workflow in `workflows`.
 * Throws what to fix.
 */
export function parseWorkCall(
  raw: unknown,
  access: CodeAccess,
  owner?: string,
): SidebarSourceWorkCall {
  const call = workCallSchema.parse(raw);
  if (call.op === "call") {
    if (!(access.workflows ?? []).includes(call.workflow))
      throw new Error(
        `This module's access does not include the workflow ${call.workflow} (add it to workflows in catamorphic.access).`,
      );
    return call;
  }
  // A chips module reads its chat's chips, in the window that shows them.
  if (owner === CHIPS_OWNER_ID && call.source !== CHIPS_OWNER_ID)
    throw new Error(
      `A chips module reads its chat's chips only, not Work's ${call.source} list.`,
    );
  if (!(access.lists ?? []).includes(call.source))
    throw new Error(
      `This module's access does not include Work's ${call.source} list (add it to lists in catamorphic.access).`,
    );
  return call;
}

/** How long Work may take to answer a module (a workflow call included). */
const WORK_TIMEOUT_MS = 120_000;

/** Only the desktop renderer can select sources from its owning profile's layout. */
export function registerSidebarSources(deps: {
  windows: WindowProfileRegistry;
  profiles: ProfilesStore;
  config: ProfileConfigManager;
  rootFor: (projectId: string) => Promise<string | null>;
  /** Work's Bun toolchain environment: PATH entries and CATAMORPHIC_BUN. */
  toolchain: () => Promise<Record<string, string>>;
  /** The profile's record of what the person approved code to reach. */
  approvals: (profileId: string) => CodeApprovals;
  /** Where modules keep a home and a temp folder of their own. */
  scratchRoot: string;
  /** A throwaway E2E profile where Work cannot confine modules (Linux CI). */
  unconfined?: boolean;
  /** Work's own loopback servers, which no module reaches. */
  blocked?: (host: string, port: number) => boolean;
}) {
  /** The access each module's running process was started with. */
  const started = new WeakMap<SidebarSourceRuntime, CodeAccess>();
  const runtimes = new Map<string, SidebarSourceRuntime>();
  let workerPath: string | undefined;
  const materializeWorker = () => {
    if (workerPath) return workerPath;
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "sidebar-source-worker.js"),
    );
    const dir = path.join(app.getPath("userData"), "sidebar-runtime");
    fs.mkdirSync(dir, { recursive: true });
    workerPath = path.join(
      dir,
      `${createHash("sha256").update(source).digest("hex").slice(0, 16)}.mjs`,
    );
    fs.writeFileSync(workerPath, source);
    return workerPath;
  };
  const leases = new Map<string, () => void>();
  /** In-flight requests, by `${sender}:${requestId}`: who asked, for what. */
  const requests = new Map<
    string,
    {
      runtime?: SidebarSourceRuntime;
      cancelled: boolean;
      sender?: Electron.WebContents;
      projectId?: string;
      sectionId?: string;
      /** The chat the request serves, which Work's chat lists read. */
      sessionId?: string;
    }
  >();
  /** Work calls waiting on a window's answer. */
  const workCalls = new Map<
    string,
    {
      sender: number;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const attached = new Set<number>();
  const keyFor = (sender: number, id: string) => `${sender}:${id}`;
  const cleanup = (sender: number) => {
    for (const [key, release] of leases)
      if (key.startsWith(`${sender}:`)) {
        release();
        leases.delete(key);
      }
    for (const [key, request] of requests)
      if (key.startsWith(`${sender}:`)) {
        request.cancelled = true;
        request.runtime?.cancel(key);
        requests.delete(key);
      }
    for (const [id, call] of workCalls)
      if (call.sender === sender) {
        clearTimeout(call.timer);
        workCalls.delete(id);
        call.reject(new Error("The window that asked is gone."));
      }
  };
  /**
   * A module asking Work for something (ADR 0234): only while it serves a
   * request, only what its access names (ADR 0277), answered by the window
   * that asked, which reads Work's lists as it does for its own sections.
   */
  const answerWork = async (
    owner: SidebarSourceRuntime,
    requestKey: string,
    raw: unknown,
  ): Promise<unknown> => {
    const request = requests.get(requestKey);
    const sender = request?.sender;
    // Only for a request this module's own runtime is serving: a module
    // shared by several sections cannot borrow a sibling's grants.
    if (
      !request ||
      request.runtime !== owner ||
      !sender ||
      sender.isDestroyed()
    )
      throw new Error(
        "work is available while a source loads or acts, not in subscribe.",
      );
    const call = parseWorkCall(
      raw,
      started.get(owner) ?? {},
      request.sectionId,
    );
    const callId = crypto.randomUUID();
    const value = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        workCalls.delete(callId);
        reject(new Error("Work took too long to answer."));
      }, WORK_TIMEOUT_MS);
      workCalls.set(callId, { sender: sender.id, resolve, reject, timer });
      sender.send("catamorphic:sidebar-source-work", {
        callId,
        projectId: request.projectId,
        sectionId: request.sectionId,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        call,
      });
    });
    return call.op === "read" ? sanitizeSidebarSourcePage(value) : value;
  };
  const resolve = async (
    event: Electron.IpcMainInvokeEvent,
    input: z.infer<typeof identity>,
  ) => {
    const profileId = deps.windows.profileFor(event.sender);
    if (deps.profiles.profileForProject(input.projectId).id !== profileId)
      throw new Error("This project belongs to another profile.");
    if (
      deps.config.forProfile(profileId).remoteProjects.inspect(input.projectId)
    )
      throw new Error("Executable sidebar sources run only in local projects.");
    const root = await deps.rootFor(input.projectId);
    if (!root)
      throw new Error(
        "Executable sidebar sources need a local project folder.",
      );
    const resolved = deps.config.resolveWorkspace(profileId, {
      id: input.projectId,
      rootPath: root,
    });
    // Sections and palette modes share one id namespace (ADR 0186).
    const source = executableSource(resolved.config, input.sectionId);
    if (!source) throw new Error("This section has no executable source.");
    const modulePath = path.resolve(root, source.module);
    // What it reaches is declared beside it and approved by the person
    // (ADR 0277); read on every request, so an edit asks again at once.
    const declared = readModuleAccess({ modulePath, projectRoot: root });
    const module = path.relative(root, modulePath);
    const subject = `module:${input.projectId}:${module}`;
    const approvals = deps.approvals(profileId);
    // A module that declares nothing needs no answer, and no keychain.
    const beyond = isEmptyAccess(declared.access)
      ? {}
      : accessBeyond(await approvals.approved(subject), declared.access);
    const ask: ModuleAccessRequest | null = isEmptyAccess(beyond)
      ? null
      : {
          module,
          beyond: describeModuleAccess({ access: beyond, projectRoot: root }),
          all: describeModuleAccess({
            access: declared.access,
            projectRoot: root,
          }),
          network: Boolean(declared.access.hosts?.length),
          fingerprint: accessText(declared.access),
        };
    const key = JSON.stringify([profileId, input.projectId, modulePath]);
    let runtime = runtimes.get(key);
    if (!runtime) {
      const created: SidebarSourceRuntime = new SidebarSourceRuntime({
        modulePath,
        projectRoot: root,
        ...(declared.file ? { watchFiles: [declared.file] } : {}),
        // Each start reads the declaration again and runs only what the
        // person approved, confined to exactly that.
        launch: async () => {
          const current = readModuleAccess({ modulePath, projectRoot: root });
          if (
            !isEmptyAccess(current.access) &&
            !isEmptyAccess(
              accessBeyond(await approvals.approved(subject), current.access),
            )
          )
            throw new Error(
              "This module wants more access than you allowed. Allow it in its section.",
            );
          const toolchain = await deps.toolchain();
          started.set(created, current.access);
          return launchConfinedModule({
            executable: toolchain.CATAMORPHIC_BUN ?? "bun",
            workerPath: materializeWorker(),
            modulePath,
            projectRoot: root,
            access: current.access,
            toolchain,
            scratchRoot: deps.scratchRoot,
            scope: key,
            unconfined: deps.unconfined === true,
            ...(deps.blocked ? { blocked: deps.blocked } : {}),
          });
        },
        work: (requestKey, call) => answerWork(created, requestKey, call),
      });
      runtime = created;
      runtimes.set(key, created);
    }
    const senderId = event.sender.id;
    if (!attached.has(senderId)) {
      attached.add(senderId);
      event.sender.once("destroyed", () => {
        cleanup(senderId);
        attached.delete(senderId);
      });
      event.sender.on(
        "did-start-navigation",
        (_event, _url, _inPlace, mainFrame) => {
          if (mainFrame) cleanup(senderId);
        },
      );
    }
    return { runtime, profileId, subject, declared, ask };
  };
  ipcMain.handle(
    "catamorphic:sidebar-source-request",
    async (event, raw: unknown) => {
      const input = requestSchema.parse(raw);
      const key = keyFor(event.sender.id, input.requestId);
      const request: {
        runtime?: SidebarSourceRuntime;
        cancelled: boolean;
        sender?: Electron.WebContents;
        projectId?: string;
        sectionId?: string;
        sessionId?: string;
      } = { cancelled: false };
      requests.set(key, request);
      try {
        const { runtime, ask } = await resolve(event, input);
        if (request.cancelled || event.sender.isDestroyed())
          throw new Error("Sidebar request cancelled.");
        // A module wanting more than the person allowed does not run: its
        // section shows the request instead of rows.
        if (ask) {
          if (input.method === "load") return { items: [], access: ask };
          throw new Error(
            "This module wants more access than you allowed. Allow it in its section.",
          );
        }
        Object.assign(request, {
          runtime,
          sender: event.sender,
          projectId: input.projectId,
          sectionId: input.sectionId,
          sessionId: input.session?.id,
        });
        const { after, ...rest } = input;
        const result = await runtime.request({
          ...rest,
          // The last loaded row a reveal compares with, checked like any row.
          ...(after === undefined
            ? {}
            : { after: sanitizeSidebarSourceItem(after) }),
          requestId: key,
        });
        if (request.cancelled || event.sender.isDestroyed())
          throw new Error("Sidebar request cancelled.");
        // The page carries what the module can do so the tree knows which
        // drags to accept before any drop happens.
        if (input.method === "load")
          return {
            ...sanitizeSidebarSourcePage(result),
            capabilities: runtime.capabilities,
          };
        if (input.method === "reveal")
          return result === null || result === undefined
            ? null
            : sanitizeSidebarSourceItem(result);
        if (input.method === "action")
          return sidebarSourceEffect(result) ?? null;
        return null;
      } finally {
        requests.delete(key);
      }
    },
  );
  // The person allowed what the module's section showed them (ADR 0277).
  ipcMain.handle(
    "catamorphic:sidebar-source-allow",
    async (event, raw: unknown) => {
      // Work's own windows only; a page in a tab never approves anything.
      if (event.sender.getType() !== "window")
        throw new Error("Only Work can allow a module's access.");
      const input = identity
        .extend({ fingerprint: z.string().max(64 * 1024) })
        .parse(raw);
      const { runtime, profileId, subject, declared } = await resolve(
        event,
        input,
      );
      if (accessText(declared.access) !== input.fingerprint)
        throw new Error(
          "This module's access changed while you looked at it. Check it again.",
        );
      await deps.approvals(profileId).approve(subject, declared.access);
      runtime.reload();
    },
  );
  ipcMain.handle("catamorphic:sidebar-source-cancel", (event, id: string) => {
    const key = keyFor(event.sender.id, id);
    const request = requests.get(key);
    if (request) {
      request.cancelled = true;
      request.runtime?.cancel(key);
    }
  });
  ipcMain.handle(
    "catamorphic:sidebar-source-work-result",
    (event, raw: unknown) => {
      const result = workResultSchema.parse(raw);
      const call = workCalls.get(result.callId);
      // Only the window it was sent to answers it.
      if (!call || call.sender !== event.sender.id) return;
      workCalls.delete(result.callId);
      clearTimeout(call.timer);
      if (result.ok) call.resolve(result.value);
      else call.reject(new Error(result.error ?? "Work could not answer."));
    },
  );
  ipcMain.handle(
    "catamorphic:sidebar-source-subscribe",
    async (event, raw: unknown) => {
      const input = identity.extend({ leaseId: z.string().min(1) }).parse(raw);
      const key = keyFor(event.sender.id, input.leaseId);
      // Install a placeholder before async lookup so an immediate release wins.
      leases.get(key)?.();
      const placeholder = () => {};
      leases.set(key, placeholder);
      try {
        const { runtime } = await resolve(event, input);
        if (leases.get(key) !== placeholder || event.sender.isDestroyed())
          return;
        leases.set(
          key,
          runtime.subscribe((error) => {
            if (!event.sender.isDestroyed())
              event.sender.send("catamorphic:sidebar-source-changed", {
                leaseId: input.leaseId,
                error,
              });
          }),
        );
      } catch (cause) {
        if (leases.get(key) === placeholder) leases.delete(key);
        throw cause;
      }
    },
  );
  ipcMain.handle(
    "catamorphic:sidebar-source-unsubscribe",
    (event, id: string) => {
      const key = keyFor(event.sender.id, id);
      leases.get(key)?.();
      leases.delete(key);
    },
  );
  return () => {
    for (const release of leases.values()) release();
    leases.clear();
    for (const call of workCalls.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Sidebar sources were closed."));
    }
    workCalls.clear();
    for (const runtime of runtimes.values()) runtime.dispose();
    runtimes.clear();
    for (const suffix of [
      "request",
      "allow",
      "cancel",
      "subscribe",
      "unsubscribe",
      "work-result",
    ])
      ipcMain.removeHandler(`catamorphic:sidebar-source-${suffix}`);
  };
}
