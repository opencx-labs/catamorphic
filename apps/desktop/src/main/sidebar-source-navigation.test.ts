import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  root: "",
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => host.root },
  safeStorage: {},
  ipcMain: {},
}));
vi.mock("./shell-ipc.js", () => ({
  shellIpcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      host.handlers.set(name, handler),
    on: () => {},
    removeHandler: (name: string) => host.handlers.delete(name),
    removeListener: () => {},
  },
}));

const { CodeApprovals } = await import("./code-approvals.js");
const { ProfileConfigManager } = await import("./profile-config.js");
const { ProfilesStore } = await import("./profiles.js");
const { resolveDataPaths } = await import("./server/paths.js");
const { registerSidebarSources } = await import("./sidebar-source-ipc.js");
const { SidebarSourceRuntime } = await import("./sidebar-source-runtime.js");
const { projectWorkspaceFile } = await import("./workspace-config.js");

it("releases outgoing-document subscriptions and lookups through navigation commit", async () => {
  host.root = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-navigation-"));
  const paths = resolveDataPaths();
  const profiles = new ProfilesStore(paths.profilesFile);
  const config = new ProfileConfigManager(paths, profiles);
  const workspace = projectWorkspaceFile(host.root);
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  fs.writeFileSync(
    workspace,
    `module.exports={sidebars:{left:[{id:'probe',title:'Probe',sections:[{id:'probe',title:'Probe',source:'.work/probe.ts'}]}],right:[]}};`,
  );
  fs.writeFileSync(
    path.join(host.root, ".work", "probe.ts"),
    "export default {load(){return {items:[]}}};",
  );
  const approvals = new CodeApprovals({
    dir: host.root,
    keyring: {
      available: async () => false,
      encrypt: async () => Buffer.alloc(0),
      decrypt: async () => "",
    },
  });
  const lookup = { resolve: (_root: string) => {} };
  const root = new Promise<string>((resolve) => {
    lookup.resolve = resolve;
  });
  const rootFor = vi.fn(() => root);
  const release = vi.fn();
  const subscribe = vi
    .spyOn(SidebarSourceRuntime.prototype, "subscribe")
    .mockReturnValue(release);
  const sender = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const { dispose } = registerSidebarSources({
    windows: {
      profileFor: () => profiles.defaultProfile().id,
      windowsFor: () => [],
      assign: () => {},
      attach: () => {},
      openWindow: () => {},
    },
    profiles,
    config,
    rootFor,
    toolchain: async () => ({}),
    approvals: () => approvals,
    scratchRoot: path.join(host.root, "scratch"),
  });
  try {
    const handle = host.handlers.get("catamorphic:sidebar-source-subscribe");
    if (!handle) throw new Error("Missing subscription handler");
    const pending = handle(
      { sender },
      { projectId: "project", sectionId: "probe", leaseId: "old" },
    );
    expect(rootFor).toHaveBeenCalledOnce();
    sender.emit(
      "did-start-navigation",
      {},
      "work-internal://shell",
      false,
      true,
    );
    lookup.resolve(host.root);
    await pending;
    expect(subscribe).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    // The outgoing document can still send during unload, after start-time
    // cleanup but before commit. Release an already-installed late lease.
    await handle(
      { sender },
      { projectId: "project", sectionId: "probe", leaseId: "late-old" },
    );
    expect(subscribe).toHaveBeenCalledOnce();
    sender.emit("did-navigate", {}, "work-internal://shell");
    expect(release).toHaveBeenCalledOnce();
    // A late old lookup can instead remain pending across commit. Clearing
    // its placeholder must prevent it installing a listener afterwards.
    let resolveLate!: (root: string) => void;
    rootFor.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
    );
    sender.emit(
      "did-start-navigation",
      {},
      "work-internal://shell",
      false,
      true,
    );
    const late = handle(
      { sender },
      { projectId: "project", sectionId: "probe", leaseId: "late-lookup" },
    );
    sender.emit("did-navigate", {}, "work-internal://shell");
    resolveLate(host.root);
    await late;
    expect(subscribe).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    // The new document can subscribe, and only its own main-frame
    // navigation releases that new listener.
    await handle(
      { sender },
      { projectId: "project", sectionId: "probe", leaseId: "new" },
    );
    expect(subscribe).toHaveBeenCalledTimes(2);
    sender.emit("did-start-navigation", {}, "frame", false, false);
    expect(release).toHaveBeenCalledOnce();
    sender.emit(
      "did-start-navigation",
      {},
      "work-internal://shell#anchor",
      true,
      true,
    );
    expect(release).toHaveBeenCalledOnce();
    sender.emit(
      "did-start-navigation",
      {},
      "work-internal://shell",
      false,
      true,
    );
    expect(release).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
    subscribe.mockRestore();
    config.dispose();
    host.handlers.clear();
    fs.rmSync(host.root, { recursive: true, force: true });
  }
});
