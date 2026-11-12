import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  root: "",
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => host.root },
  ipcMain: {},
}));
vi.mock("./shell-ipc.js", () => ({
  shellIpcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      host.handlers.set(name, handler),
    removeHandler: (name: string) => host.handlers.delete(name),
  },
}));
vi.mock("./module-sandbox.js", () => ({
  launchConfinedModule: vi.fn(
    async (input: { workerPath: string; modulePath: string }) => ({
      command: "bun",
      args: [input.workerPath, input.modulePath],
      env: { PATH: process.env.PATH ?? "/bin:/usr/bin" },
      close: async () => {},
    }),
  ),
}));

const { createCodeApprovals, registerCodeApprovals } = await import(
  "./code-approvals.js"
);
const { desktopCustomizationProcesses } = await import(
  "./customization-processes-host.js"
);
const { accessText } = await import("../shared/code-access.js");
const { moduleAccessSubject, readModuleAccess } = await import(
  "./module-access.js"
);
const { launchConfinedModule } = await import("./module-sandbox.js");
const { ProfileConfigManager } = await import("./profile-config.js");
const { ProfilesStore } = await import("./profiles.js");
const { resolveDataPaths } = await import("./server/paths.js");
const { registerSidebarSources } = await import("./sidebar-source-ipc.js");
const { SidebarSourceRuntime } = await import("./sidebar-source-runtime.js");
const { registerTrustedHosts } = await import("./trusted-hosts.js");
const { projectWorkspaceFile } = await import("./workspace-config.js");

const keyring = {
  available: async () => true,
  encrypt: async (text: string) => Buffer.from(`sealed:${text}`),
  decrypt: async (data: Buffer) => {
    const text = data.toString();
    if (!text.startsWith("sealed:")) throw new Error("Not sealed here.");
    return text.slice(7);
  },
};
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  host.handlers.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function fixture() {
  host.root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-recovery-"));
  const root = host.root;
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const paths = resolveDataPaths();
  const profiles = new ProfilesStore(paths.profilesFile);
  const profileId = profiles.profileForProject("project").id;
  const config = new ProfileConfigManager(paths, profiles);
  cleanups.push(() => config.dispose());
  const workspace = projectWorkspaceFile(projectRoot);
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  fs.writeFileSync(
    workspace,
    `module.exports={sidebars:{left:[{id:'probe',title:'Probe',sections:[{id:'probe',title:'Probe',source:'.work/probe.ts'}]}],right:[]}};`,
  );
  const modulePath = path.join(projectRoot, ".work", "probe.ts");
  fs.writeFileSync(modulePath, "export default {load(){return {items:[]}}};");
  fs.writeFileSync(
    path.join(projectRoot, ".work", "package.json"),
    JSON.stringify({
      catamorphic: {
        access: { permissions: ["processes", "background"], lists: ["tabs"] },
      },
    }),
  );
  const declared = readModuleAccess({ modulePath, projectRoot });
  const subject = moduleAccessSubject({
    projectId: "project",
    projectRoot,
    modulePath,
    declaration: declared,
  });
  const initial = createCodeApprovals({
    profilesDir: paths.profilesDir,
    keyring,
  });
  await initial(profileId).approve(subject, declared.access);
  await initial(profileId).approve("trusted-hosts", { hosts: ["example.com"] });
  const keyFile = path.join(paths.profilesDir, profileId, "approvals.key");
  const recordsFile = path.join(paths.profilesDir, profileId, "approvals.json");
  const keyBefore = fs.readFileSync(keyFile);
  const recordsBefore = fs.readFileSync(recordsFile);
  const decrypt = vi
    .fn(keyring.decrypt)
    .mockRejectedValueOnce(new Error("User cancelled"));
  const approvalsFor = createCodeApprovals({
    profilesDir: paths.profilesDir,
    keyring: { ...keyring, decrypt },
  });
  vi.spyOn(SidebarSourceRuntime.prototype, "request").mockResolvedValue({
    items: [],
  });
  const sender = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    getType: (): ReturnType<Electron.WebContents["getType"]> => "window",
    send: vi.fn(),
  });
  let activeProcesses:
    | ReturnType<typeof desktopCustomizationProcesses>
    | undefined;
  const approvalsRecovered = (input: { profileId: string }) =>
    activeProcesses?.recoverProfile(input) ?? Promise.resolve();
  const apps = registerCodeApprovals({
    approvalsFor,
    profileFor: () => profileId,
    approvalsRecovered,
  });
  cleanups.push(apps.dispose);
  cleanups.push(
    registerTrustedHosts({
      approvalsFor,
      profileFor: () => profileId,
      approvalsRecovered,
      rootFor: async () => projectRoot,
      windowsFor: () => [],
    }),
  );
  const { dispose } = registerSidebarSources({
    windows: {
      profileFor: () => profileId,
      windowsFor: () => [],
      assign: () => {},
      attach: () => {},
      openWindow: () => {},
    },
    profiles,
    config,
    rootFor: async () => projectRoot,
    toolchain: async () => ({}),
    approvals: approvalsFor,
    approvalsRecovered,
    scratchRoot: path.join(root, "scratch"),
  });
  cleanups.push(dispose);
  const identity = { projectId: "project", sectionId: "probe" };
  const invokeChannel = async (channel: string, raw: unknown) => {
    const handler = host.handlers.get(channel);
    if (!handler) throw new Error(`Missing ${channel} handler`);
    return handler({ sender }, raw);
  };
  const invoke = (suffix: string, raw: unknown) =>
    invokeChannel(`catamorphic:sidebar-source-${suffix}`, raw);
  const load = () =>
    invoke("request", {
      ...identity,
      requestId: crypto.randomUUID(),
      method: "load",
    });
  type PersistedServices = Parameters<
    Parameters<typeof desktopCustomizationProcesses>[0]["writeState"]
  >[0]["value"];
  const state: { version: number; value: PersistedServices | null } = {
    version: 0,
    value: null,
  };
  const states = new Map([["project", state]]);
  const createProcesses = (stores = approvalsFor) => {
    const manager = desktopCustomizationProcesses({
      root: path.join(root, "processes"),
      approvalsFor: stores,
      profiles,
      config,
      rootFor: async () => projectRoot,
      toolchain: async () => ({}),
      workPorts: () => [],
      projects: async () => [...states.keys()],
      readState: async (projectId) => {
        const state = states.get(projectId);
        if (!state) throw new Error("Unknown project");
        return structuredClone(state);
      },
      writeState: async (input) => {
        const state = states.get(input.projectId);
        if (!state) throw new Error("Unknown project");
        if (input.ifVersion !== state.version)
          throw new Error("Version conflict");
        state.version++;
        state.value = structuredClone(input.value);
      },
    });
    activeProcesses = manager;
    cleanups.push(() => manager.close());
    return manager;
  };
  return {
    identity,
    subject,
    access: declared.access,
    profileId,
    load,
    invoke,
    invokeChannel,
    sender,
    approvalsFor,
    decrypt,
    keyFile,
    recordsFile,
    keyBefore,
    recordsBefore,
    createProcesses,
    initial,
    state,
    states,
    profiles,
    projectRoot,
    owner: { profileId, projectId: "project", modulePath },
  };
}

describe("approval recovery through Work's source IPC", () => {
  it.each([
    {
      action: "app approval",
      channel: "catamorphic:app-access-allow",
      input: { projectId: "project", app: "activity" },
      invalid: { projectId: "project", app: "" },
      preservesRecords: false,
    },
    {
      action: "trusted host addition",
      channel: "catamorphic:trusted-hosts-add",
      input: "new.example",
      invalid: {},
      preservesRecords: false,
    },
    {
      action: "trusted host removal",
      channel: "catamorphic:trusted-hosts-remove",
      input: "example.com",
      invalid: {},
      preservesRecords: false,
    },
    {
      action: "existing trusted host addition",
      channel: "catamorphic:trusted-hosts-add",
      input: "example.com",
      invalid: {},
      preservesRecords: true,
    },
    {
      action: "missing trusted host removal",
      channel: "catamorphic:trusted-hosts-remove",
      input: "absent.example",
      invalid: {},
      preservesRecords: true,
    },
  ])(
    "recovers skipped services after a valid $action, including unchanged approvals",
    async ({ channel, input, invalid, preservesRecords }) => {
      const f = await fixture();
      const seeded = f.createProcesses(f.initial);
      await seeded.start(f.owner, {
        key: "saved",
        command: "sleep 300",
        lifetime: "application",
      });
      await seeded.close();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(launchConfinedModule).mockClear();
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const processes = f.createProcesses();
      await processes.restore();
      expect(processes.inspect()).toEqual([]);
      await expect(
        f.invokeChannel("catamorphic:app-access-approved", {
          projectId: "project",
          app: "activity",
        }),
      ).rejects.toThrow("could not unlock");
      await expect(
        f.invokeChannel("catamorphic:trusted-hosts", "project"),
      ).rejects.toThrow("could not unlock");
      await expect(f.load()).rejects.toThrow("could not unlock");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.decrypt).toHaveBeenCalledOnce();
      expect(launchConfinedModule).not.toHaveBeenCalled();
      await expect(f.invokeChannel(channel, invalid)).rejects.toThrow();
      vi.spyOn(f.sender, "getType").mockReturnValueOnce("webview");
      await expect(f.invokeChannel(channel, input)).rejects.toThrow(
        "Only Work",
      );
      expect(processes.inspect()).toEqual([]);
      expect(f.decrypt).toHaveBeenCalledOnce();
      expect(fs.readFileSync(f.recordsFile)).toEqual(f.recordsBefore);
      await f.invokeChannel(channel, input);
      expect(processes.inspect()).toHaveLength(1);
      expect(processes.inspect()[0]).toMatchObject({
        key: "saved",
        status: "running",
        owner: { profileId: f.profileId },
      });
      expect(f.decrypt).toHaveBeenCalledTimes(2);
      if (preservesRecords)
        expect(fs.readFileSync(f.recordsFile)).toEqual(f.recordsBefore);
      await f.invokeChannel(channel, input);
      expect(processes.inspect()).toHaveLength(1);
      expect(launchConfinedModule).toHaveBeenCalledOnce();
      expect(f.decrypt).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(f.keyFile)).toEqual(f.keyBefore);
    },
  );

  it("recovers authenticated services skipped at boot only for the explicitly recovered profile", async () => {
    const f = await fixture();
    const seeded = f.createProcesses(f.initial);
    await seeded.start(f.owner, {
      key: "saved",
      command: "sleep 300",
      lifetime: "application",
    });
    await seeded.close();
    const saved = f.state.value?.[0];
    if (!saved) throw new Error("No signed service was saved");
    f.state.value?.push({
      ...saved,
      definition: {
        ...saved.definition,
        key: "tampered",
        command: "echo injected",
      },
    });
    const other = f.profiles.create("Other profile");
    f.profiles.claimProject(other.id, "other-project");
    const foreignDefinition = {
      ...saved.definition,
      owner: {
        ...saved.definition.owner,
        profileId: other.id,
        projectId: "other-project",
      },
    };
    const declaration = readModuleAccess({
      modulePath: f.owner.modulePath,
      projectRoot: f.projectRoot,
    });
    await f.initial(other.id).approve(
      moduleAccessSubject({
        projectId: "other-project",
        projectRoot: f.projectRoot,
        modulePath: f.owner.modulePath,
        declaration,
      }),
      declaration.access,
    );
    f.states.set("other-project", {
      version: 1,
      value: [
        {
          definition: foreignDefinition,
          signature: await f.initial(other.id).sealServiceDefinition({
            payload: JSON.stringify([1, foreignDefinition]),
          }),
        },
      ],
    });
    f.decrypt.mockRejectedValueOnce(new Error("Other profile cancelled"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(launchConfinedModule).mockClear();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const processes = f.createProcesses();
    await processes.restore();
    expect(processes.inspect()).toEqual([]);
    expect(f.decrypt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.decrypt).toHaveBeenCalledTimes(2);
    expect(launchConfinedModule).not.toHaveBeenCalled();
    await expect(
      f.invoke("allow", { ...f.identity, fingerprint: "stale" }),
    ).rejects.toThrow("access changed");
    expect(processes.inspect()).toEqual([]);
    expect(f.decrypt).toHaveBeenCalledTimes(2);
    await f.invoke("retry", f.identity);
    expect(processes.inspect()).toHaveLength(1);
    expect(processes.inspect()[0]).toMatchObject({
      key: "saved",
      status: "running",
      owner: { profileId: f.profileId },
    });
    expect(f.decrypt).toHaveBeenCalledTimes(3);
    await f.invoke("retry", f.identity);
    expect(processes.inspect()).toHaveLength(1);
    expect(launchConfinedModule).toHaveBeenCalledOnce();
    expect(fs.readFileSync(f.recordsFile)).toEqual(f.recordsBefore);
    expect(fs.readFileSync(f.keyFile)).toEqual(f.keyBefore);
  });

  it("keeps passive reads quiet and lets a validated Allow recover without replacing the signing key", async () => {
    const f = await fixture();
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(f.load()).rejects.toThrow("could not unlock");
    expect(f.decrypt).toHaveBeenCalledOnce();
    expect(fs.readFileSync(f.keyFile)).toEqual(f.keyBefore);
    expect(fs.readFileSync(f.recordsFile)).toEqual(f.recordsBefore);
    await expect(
      f.invoke("allow", { ...f.identity, fingerprint: "stale" }),
    ).rejects.toThrow("access changed");
    expect(f.decrypt).toHaveBeenCalledOnce();
    f.decrypt.mockRejectedValueOnce(new Error("User cancelled again"));
    await expect(
      f.invoke("allow", {
        ...f.identity,
        fingerprint: accessText(f.access),
      }),
    ).rejects.toThrow("could not unlock");
    await expect(f.load()).rejects.toThrow("could not unlock");
    expect(f.decrypt).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(f.recordsFile)).toEqual(f.recordsBefore);
    await f.invoke("allow", {
      ...f.identity,
      fingerprint: accessText(f.access),
    });
    await expect(f.load()).resolves.toMatchObject({ items: [] });
    expect(f.decrypt).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(f.keyFile)).toEqual(f.keyBefore);
    await expect(
      f.approvalsFor(f.profileId).approved("trusted-hosts"),
    ).resolves.toEqual({ hosts: ["example.com"] });
  });

  it("retries unlocking only for the explicit Retry handler and preserves every signed record", async () => {
    const f = await fixture();
    await expect(f.load()).rejects.toThrow("could not unlock");
    await expect(f.load()).rejects.toThrow("could not unlock");
    expect(f.decrypt).toHaveBeenCalledOnce();
    await f.invoke("retry", f.identity);
    await expect(f.load()).resolves.toMatchObject({ items: [] });
    expect(f.decrypt).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(f.keyFile)).toEqual(f.keyBefore);
    expect(fs.readFileSync(f.recordsFile)).toEqual(f.recordsBefore);
  });

  it("recovers the process host's authorization, signed persistence and restore through the same explicit Allow", async () => {
    const f = await fixture();
    const processes = f.createProcesses();
    const service = {
      key: "probe",
      command: "sleep 300",
      lifetime: "application",
    };
    await expect(processes.start(f.owner, service)).rejects.toThrow(
      "could not unlock",
    );
    await expect(processes.list(f.owner)).rejects.toThrow("could not unlock");
    await expect(f.load()).rejects.toThrow("could not unlock");
    expect(f.decrypt).toHaveBeenCalledOnce();
    expect(launchConfinedModule).not.toHaveBeenCalled();
    await f.invoke("allow", {
      ...f.identity,
      fingerprint: accessText(f.access),
    });
    await expect(processes.start(f.owner, service)).resolves.toMatchObject({
      status: "running",
      enabled: true,
    });
    expect(await processes.list(f.owner)).toHaveLength(1);
    await processes.close();
    const restored = f.createProcesses();
    await restored.restore();
    expect(restored.inspect()).toHaveLength(1);
    expect(restored.inspect()[0]).toMatchObject({
      status: "running",
      enabled: true,
    });
    expect(f.decrypt).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(f.keyFile)).toEqual(f.keyBefore);
  });
});
