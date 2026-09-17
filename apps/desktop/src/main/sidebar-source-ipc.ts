import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, ipcMain } from "electron";
import { z } from "zod";
import { sidebarSections } from "../shared/sidebar.js";
import type { WindowProfileRegistry } from "./index.js";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";
import { sanitizeSidebarSourcePage } from "./sidebar-config.js";
import { SidebarSourceRuntime } from "./sidebar-source-runtime.js";

const identity = z.object({
  projectId: z.string().min(1),
  sectionId: z.string().min(1),
});
const requestSchema = identity
  .extend({
    requestId: z.string().min(1),
    method: z.enum(["load", "action"]),
    parentId: z.string().nullable().optional(),
    cursor: z.string().optional(),
    itemId: z.string().optional(),
    action: z.string().optional(),
  })
  .refine(
    (request) =>
      request.method !== "action" ||
      (request.itemId !== undefined && Boolean(request.action)),
    "Source actions require an item id and action name.",
  );
/** Only the desktop renderer can select sources from its owning profile's layout. */
export function registerSidebarSources(deps: {
  windows: WindowProfileRegistry;
  profiles: ProfilesStore;
  config: ProfileConfigManager;
  rootFor: (projectId: string) => Promise<string | null>;
  executable: () => Promise<string>;
}) {
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
  const requests = new Map<
    string,
    { runtime?: SidebarSourceRuntime; cancelled: boolean }
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
    const resolved = deps.config.resolveSidebar(profileId, {
      id: input.projectId,
      rootPath: root,
    });
    const section = sidebarSections(resolved.config).find(
      (item) => item.id === input.sectionId,
    );
    const module = section?.source?.module;
    if (!module) throw new Error("This section has no executable source.");
    const modulePath = path.resolve(root, module);
    const key = JSON.stringify([profileId, input.projectId, modulePath]);
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = new SidebarSourceRuntime({
        modulePath,
        projectRoot: root,
        workerPath: materializeWorker(),
        executable: deps.executable,
      });
      runtimes.set(key, runtime);
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
    return runtime;
  };
  ipcMain.handle(
    "catamorphic:sidebar-source-request",
    async (event, raw: unknown) => {
      const input = requestSchema.parse(raw);
      const key = keyFor(event.sender.id, input.requestId);
      const request: { runtime?: SidebarSourceRuntime; cancelled: boolean } = {
        cancelled: false,
      };
      requests.set(key, request);
      try {
        const runtime = await resolve(event, input);
        if (request.cancelled || event.sender.isDestroyed())
          throw new Error("Sidebar request cancelled.");
        request.runtime = runtime;
        const result = await runtime.request({ ...input, requestId: key });
        if (request.cancelled || event.sender.isDestroyed())
          throw new Error("Sidebar request cancelled.");
        return input.method === "load"
          ? sanitizeSidebarSourcePage(result)
          : null;
      } finally {
        requests.delete(key);
      }
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
    "catamorphic:sidebar-source-subscribe",
    async (event, raw: unknown) => {
      const input = identity.extend({ leaseId: z.string().min(1) }).parse(raw);
      const key = keyFor(event.sender.id, input.leaseId);
      // Install a placeholder before async lookup so an immediate release wins.
      leases.get(key)?.();
      const placeholder = () => {};
      leases.set(key, placeholder);
      try {
        const runtime = await resolve(event, input);
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
    for (const runtime of runtimes.values()) runtime.dispose();
    runtimes.clear();
    for (const suffix of ["request", "cancel", "subscribe", "unsubscribe"])
      ipcMain.removeHandler(`catamorphic:sidebar-source-${suffix}`);
  };
}
