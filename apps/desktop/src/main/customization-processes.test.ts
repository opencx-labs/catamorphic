import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CustomizationProcesses,
  type CustomizationProcessOwner,
} from "./customization-processes.js";
import { canonicalModuleAccess } from "./module-access.js";
import { launchConfinedModule } from "./module-sandbox.js";

const roots: string[] = [];
const managers: CustomizationProcesses[] = [];
function authentication() {
  const key = randomBytes(32);
  const seal = async (
    input: Parameters<
      ConstructorParameters<typeof CustomizationProcesses>[0]["seal"]
    >[0],
  ) =>
    createHmac("sha256", key)
      .update(JSON.stringify([input.stateVersion, input.definition]))
      .digest("hex");
  return {
    seal,
    verify: async (
      input: Parameters<
        ConstructorParameters<typeof CustomizationProcesses>[0]["verify"]
      >[0],
    ) => input.signature === (await seal(input)),
  };
}
function packageOwner(
  owner: CustomizationProcessOwner,
): CustomizationProcessOwner {
  return {
    profileId: owner.profileId,
    projectId: owner.projectId,
    modulePath: owner.modulePath,
  };
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-services-test-"));
  roots.push(root);
  const owner: CustomizationProcessOwner = {
    profileId: "profile",
    projectId: "project",
    modulePath: path.join(root, "index.ts"),
    viewId: "live-view",
    viewSignal: new AbortController().signal,
  };
  const state = { version: 0, value: null as unknown };
  let allowed = true;
  const signatures = authentication();
  const launch = vi.fn(
    async ({
      workerPath,
      owner,
    }: Parameters<
      ConstructorParameters<typeof CustomizationProcesses>[0]["launch"]
    >[0]) => ({
      command: "bun",
      args: [workerPath, owner.modulePath],
      env: { PATH: process.env.PATH ?? "/bin:/usr/bin" },
      close: async () => {},
    }),
  );
  const authorize = vi.fn(async (input: CustomizationProcessOwner) => {
    if (!allowed || input.profileId !== owner.profileId)
      throw new Error("Access revoked");
    return {
      subject: `package:${input.profileId}:${input.projectId}:${root}`,
      projectRoot: root,
      access: {},
    };
  });
  const create = () => {
    const manager = new CustomizationProcesses({
      ...signatures,
      root: path.join(root, "runtime"),
      authorize,
      launch,
      projects: async () => ["project"],
      readState: async () => structuredClone(state),
      writeState: async (input) => {
        if (input.ifVersion !== state.version)
          throw new Error("Version conflict");
        state.version++;
        state.value = structuredClone(input.value);
      },
    });
    managers.push(manager);
    return manager;
  };
  return {
    root,
    owner,
    create,
    state,
    authorize,
    launch,
    revoke: () => {
      allowed = false;
    },
  };
}

describe("approved customization processes", () => {
  it("does not replace newer desired service state during explicit profile recovery", async () => {
    const { create, owner, state } = fixture();
    const manager = create();
    await manager.start(owner, {
      key: "service",
      command: "sleep 300",
      lifetime: "application",
    });
    const older = structuredClone(state);
    await manager.start(owner, {
      key: "service",
      command: "sleep 301",
      lifetime: "application",
    });
    Object.assign(state, older);
    await manager.recoverProfile({ profileId: owner.profileId });
    expect(manager.inspect()).toHaveLength(1);
    expect(manager.inspect()[0]).toMatchObject({
      command: "sleep 301",
      status: "running",
    });
  });

  it("fences a fire-and-forget start that reaches the manager after preview cleanup", async () => {
    const { create, owner } = fixture();
    const manager = create();
    let allow: (() => void) | undefined;
    const approval = new Promise<void>((resolve) => {
      allow = resolve;
    });
    const late = approval.then(() =>
      manager.start(owner, {
        key: "late",
        command: "sleep 300",
        lifetime: "view",
      }),
    );
    await manager.release(owner);
    allow?.();
    await expect(late).rejects.toThrow("lease has ended");
    expect(manager.inspect()).toEqual([]);
    const renewed = { ...owner, viewSignal: new AbortController().signal };
    await manager.start(renewed, {
      key: "late",
      command: "sleep 300",
      lifetime: "view",
    });
    await manager.release(owner);
    expect((await manager.list(renewed))[0]?.status).toBe("running");
    await manager.release(renewed);
  });

  it("fences view starts already awaiting package authorization when cleanup begins", async () => {
    const { create, owner, authorize } = fixture();
    const normal = authorize.getMockImplementation();
    if (!normal) throw new Error("No package authorizer.");
    let allow: (() => void) | undefined;
    const approval = new Promise<void>((resolve) => {
      allow = resolve;
    });
    authorize.mockImplementationOnce(async (owner) => {
      await approval;
      return normal(owner);
    });
    const manager = create();
    const pending = manager.start(owner, {
      key: "late",
      command: "sleep 300",
      lifetime: "view",
    });
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    const cleaning = manager.release(owner);
    allow?.();
    await expect(pending).rejects.toThrow("lease has ended");
    await cleaning;
    expect(manager.inspect()).toEqual([]);
  });

  it("rechecks live workflow authority after launch setup and removes a denied pending service definition", async () => {
    const { create, owner, launch, state } = fixture();
    const normal = launch.getMockImplementation();
    if (!normal) throw new Error("No confined launcher.");
    let allow: (() => void) | undefined;
    const setup = new Promise<void>((resolve) => {
      allow = resolve;
    });
    launch.mockImplementationOnce(async (input) => {
      await setup;
      return normal(input);
    });
    let enabled = true;
    const beforeEffect = async () => {
      if (!enabled) throw new Error("Enablement disabled");
    };
    const manager = create();
    const pending = manager.start(
      packageOwner(owner),
      { key: "service", command: "sleep 300", lifetime: "application" },
      beforeEffect,
    );
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    enabled = false;
    allow?.();
    await expect(pending).rejects.toThrow("Enablement disabled");
    expect(state.value).toEqual([]);
    expect(manager.hasEnabled()).toBe(false);
    expect(manager.inspect()).toEqual([]);
  });
  it("refuses forged registry state even when it names a broader approved package", async () => {
    const { create, owner, root, state, authorize } = fixture();
    const definition = {
      key: "forged",
      command: `touch '${path.join(root, "stolen-authority")}'`,
      lifetime: "application",
      owner: {
        profileId: owner.profileId,
        projectId: owner.projectId,
        modulePath: path.join(root, "broader-approved-package.ts"),
      },
    };
    for (const value of [
      [definition],
      [{ definition, signature: "0".repeat(64) }],
    ]) {
      state.value = value;
      state.version++;
      authorize.mockClear();
      const manager = create();
      await manager.restore();
      expect(authorize).not.toHaveBeenCalled();
      expect(manager.inspect()).toEqual([]);
      expect(manager.hasEnabled()).toBe(false);
      expect(fs.existsSync(path.join(root, "stolen-authority"))).toBe(false);
      await manager.close();
    }
  });

  it("does not replay a previously signed service after an ordinary state write resurrects it", async () => {
    const { create, owner, state } = fixture();
    const manager = create();
    await manager.start(owner, {
      key: "service",
      command: "sleep 300",
      lifetime: "application",
    });
    const oldSigned = structuredClone(state.value);
    await manager.stop(owner, { key: "service" });
    await manager.close();
    // Generic private-state writes advance the authoritative document version.
    state.value = oldSigned;
    state.version++;
    const restored = create();
    await restored.restore();
    expect(restored.inspect()).toEqual([]);
    expect(restored.hasEnabled()).toBe(false);
  });

  it("keeps published worker bytes complete while another view starts", async () => {
    const { create, owner, launch } = fixture();
    const manager = create();
    await manager.start(owner, {
      key: "reader",
      command: "sleep 300",
      lifetime: "view",
    });
    const first = launch.mock.calls[0]?.[0];
    if (!first) throw new Error("Worker was not launched");
    const published = first.workerPath;
    const source = fs.readFileSync(published, "utf8");
    const inode = fs.statSync(published).ino;
    const observed: string[] = [];
    const write = fs.writeFileSync.bind(fs);
    // A child loader can read between a writer's syscalls. Inspect the
    // published path after only half of each new worker has been written.
    const writing = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation((file, data, options) => {
        if (data !== source) return write(file, data, options);
        const middle = Math.floor(source.length / 2);
        write(file, source.slice(0, middle), options);
        observed.push(fs.readFileSync(published, "utf8"));
        fs.appendFileSync(file, source.slice(middle));
      });
    try {
      await manager.start(owner, {
        key: "publisher",
        command: "sleep 300",
        lifetime: "view",
      });
      expect(observed).toEqual([source]);
      expect(fs.readFileSync(published, "utf8")).toBe(source);
      expect(fs.statSync(published).ino).not.toBe(inode);
      expect(fs.statSync(published).mode & 0o777).toBe(0o600);
    } finally {
      writing.mockRestore();
    }
  });

  it("keeps preview, live and sibling view leases separate while application services remain package-owned", async () => {
    const { create, owner, root } = fixture();
    const manager = create();
    const preview = {
      ...owner,
      viewId: "preview-view",
      viewSignal: new AbortController().signal,
    };
    const sibling = {
      ...owner,
      modulePath: path.join(root, "sibling.ts"),
      viewId: "sibling-view",
      viewSignal: new AbortController().signal,
    };
    const request = { key: "worker", command: "sleep 300", lifetime: "view" };
    const liveProcess = await manager.start(owner, request);
    const previewProcess = await manager.start(preview, request);
    const siblingProcess = await manager.start(sibling, request);
    expect(
      new Set([
        liveProcess.processId,
        previewProcess.processId,
        siblingProcess.processId,
      ]).size,
    ).toBe(3);
    expect(
      (await manager.list(preview)).map((entry) => entry.processId),
    ).toEqual([previewProcess.processId]);
    const application = await manager.start(owner, {
      ...request,
      lifetime: "application",
    });
    await manager.release(preview);
    await expect(manager.list(preview)).rejects.toThrow("lease has ended");
    expect(
      (await manager.list(packageOwner(preview))).map(
        (entry) => entry.processId,
      ),
    ).toEqual([application.processId]);
    expect(
      (await manager.list(owner)).find(
        (entry) => entry.processId === liveProcess.processId,
      )?.status,
    ).toBe("running");
    expect(
      (await manager.list(sibling)).find(
        (entry) => entry.processId === siblingProcess.processId,
      )?.status,
    ).toBe("running");
    await manager.release(owner);
    expect(
      (await manager.list(packageOwner(owner))).map((entry) => entry.processId),
    ).toEqual([application.processId]);
    expect(manager.hasEnabled()).toBe(true);
    await expect(
      manager.start(
        {
          profileId: owner.profileId,
          projectId: owner.projectId,
          modulePath: owner.modulePath,
        },
        request,
      ),
    ).rejects.toThrow("host-issued view lease");
  });
  it
    .runIf(
      process.platform === "darwin" ||
        process.env.CATAMORPHIC_TEST_MODULE_CONFINEMENT === "1",
    )
    .each(["view", "application"])(
    "executes, reads and ends a confined %s service, denying native macOS forks",
    async (lifetime) => {
      const { root, owner } = fixture();
      const projectRoot = path.join(root, "project");
      const data = path.join(projectRoot, "data");
      fs.mkdirSync(data, { recursive: true });
      const foreign = path.join(root, "private-secret");
      fs.writeFileSync(foreign, "must stay private");
      const access = canonicalModuleAccess({
        projectRoot,
        access: { writes: ["data"] },
      });
      const confinedOwner = {
        ...owner,
        modulePath: path.join(projectRoot, "index.ts"),
      };
      const bun = execFileSync(
        "bun",
        ["-e", "process.stdout.write(process.execPath)"],
        { encoding: "utf8" },
      );
      const manager = new CustomizationProcesses({
        ...authentication(),
        root: path.join(root, "runtime"),
        authorize: async () => ({
          subject: "confined-package",
          projectRoot,
          access,
        }),
        launch: async ({ workerPath, scope }) =>
          launchConfinedModule({
            executable: bun,
            workerPath,
            modulePath: confinedOwner.modulePath,
            projectRoot,
            access,
            scratchRoot: path.join(root, "scratch"),
            scope,
            toolchain: {
              PATH: "/bin:/usr/bin",
              CATAMORPHIC_BUN: bun,
              HOST_SECRET: "must not be inherited",
            },
          }),
        projects: async () => [],
        readState: async () => ({ version: 0, value: null }),
        writeState: async () => {},
      });
      managers.push(manager);
      const forks = process.platform === "darwin";
      const script = `const fs=require('node:fs');const{spawn}=require('node:child_process');void(async()=>{let denied=false;try{fs.readFileSync(${JSON.stringify(foreign)},'utf8')}catch{denied=true}const children=${forks}?await Promise.all([false,true].map(detached=>new Promise(resolve=>{try{const p=spawn(process.execPath,['-e',"require('node:fs').writeFileSync('data/escaped',String(process.pid));setInterval(()=>{},1000)"],{detached,stdio:'ignore'});p.once('error',e=>resolve(e.code));p.once('spawn',()=>{fs.writeFileSync('data/child-'+Number(detached),String(p.pid));p.unref();resolve('escaped')})}catch(e){resolve(e.code)}}))):[];fs.writeFileSync('data/result.json',JSON.stringify({denied,secret:process.env.HOST_SECRET??null,children,pid:process.pid}));console.log('ready');setInterval(()=>{},1000)})();`;
      await manager.start(confinedOwner, {
        key: "confined",
        lifetime,
        command: `exec "$CATAMORPHIC_BUN" -e '${script.replaceAll("'", "'\\''")}'`,
      });
      await vi.waitFor(() =>
        expect(fs.existsSync(path.join(data, "result.json"))).toBe(true),
      );
      const result = JSON.parse(
        fs.readFileSync(path.join(data, "result.json"), "utf8"),
      );
      const hostPid = manager.inspect()[0]?.pid;
      if (!hostPid) throw new Error("No service process.");
      try {
        expect(result).toEqual({
          denied: true,
          secret: null,
          children: forks ? ["EPERM", "EPERM"] : [],
          pid: forks ? hostPid : expect.any(Number),
        });
        expect(fs.existsSync(path.join(data, "escaped"))).toBe(false);
        await vi.waitFor(async () =>
          expect(
            (await manager.read(confinedOwner, { key: "confined" })).chunk,
          ).toContain("ready"),
        );
        if (lifetime === "view") await manager.release(confinedOwner);
        else await manager.stop(confinedOwner, { key: "confined" });
        await vi.waitFor(() =>
          expect(() => process.kill(hostPid, 0)).toThrow(),
        );
        expect(manager.hasEnabled()).toBe(false);
      } finally {
        for (const file of ["child-0", "child-1"])
          if (fs.existsSync(path.join(data, file))) {
            const pid = Number(fs.readFileSync(path.join(data, file), "utf8"));
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
      }
    },
  );
  it("reads real output by byte cursor and stops the whole command group", async () => {
    const { create, owner, root } = fixture();
    const manager = create();
    const started = await manager.start(owner, {
      key: "service",
      command: "printf 'hello 😀'; sleep 300 & echo $! > child.pid; wait",
      lifetime: "view",
    });
    await vi.waitFor(() =>
      expect(fs.existsSync(path.join(root, "child.pid"))).toBe(true),
    );
    const output = await manager.read(owner, {
      key: "service",
      cursor: 0,
      maxBytes: 7,
      waitMs: 1000,
    });
    expect(output.chunk).toBe("hello ");
    const rest = await manager.read(owner, {
      key: "service",
      cursor: output.nextCursor,
    });
    expect(rest.chunk).toBe("😀");
    expect(started.sandboxId).toContain("package:profile");
    await manager.stop(owner, { key: "service" });
    const [stopped] = await manager.list(owner);
    expect(stopped?.status).toBe("exited");
    expect(stopped?.enabled).toBe(false);
    const childPid = Number(
      fs.readFileSync(path.join(root, "child.pid"), "utf8"),
    );
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow());
  });

  it("persists services across engine replacement and removes them on explicit stop", async () => {
    const { create, owner, state } = fixture();
    const foreground = create();
    const original = await foreground.start(owner, {
      key: "service",
      command: "printf ready; sleep 300",
      lifetime: "application",
    });
    await foreground.release(owner);
    expect((await foreground.list(packageOwner(owner)))[0]?.status).toBe(
      "running",
    );
    await foreground.close();
    expect(state.value).toEqual([
      expect.objectContaining({
        definition: expect.objectContaining({
          key: "service",
          lifetime: "application",
          owner: {
            profileId: owner.profileId,
            projectId: owner.projectId,
            modulePath: owner.modulePath,
          },
        }),
        signature: expect.any(String),
      }),
    ]);
    const background = create();
    await background.restore();
    const [restarted] = await background.list(owner);
    expect(restarted?.status).toBe("running");
    expect(restarted?.processId).not.toBe(original.processId);
    await background.stop(owner, { key: "service" });
    expect(state.value).toEqual([]);
    expect(background.hasEnabled()).toBe(false);
  });

  it("deduplicates concurrent starts and shares package keys across entrypoints", async () => {
    const { create, owner } = fixture();
    const manager = create();
    const request = {
      key: "one",
      command: "sleep 300",
      lifetime: "application",
    };
    const [first, second] = await Promise.all([
      manager.start(owner, request),
      manager.start(owner, request),
    ]);
    expect(first.processId).toBe(second.processId);
    const sibling = {
      ...owner,
      modulePath: path.join(path.dirname(owner.modulePath), "other.ts"),
    };
    expect(await manager.list(sibling)).toHaveLength(1);
    await manager.stop(sibling, { key: "one" });
    expect(manager.hasEnabled()).toBe(false);
  });

  it("keeps views separate from persistent services and releases a disappearing source", async () => {
    const { create, owner, state } = fixture();
    const manager = create();
    await manager.start(owner, {
      key: "view",
      command: "sleep 300",
      lifetime: "view",
    });
    expect(state.value).toEqual([]);
    await manager.release(owner);
    expect(await manager.list(packageOwner(owner))).toEqual([]);
    expect(manager.hasEnabled()).toBe(false);
  });

  it("never restores definitions whose package authority is revoked", async () => {
    const { create, owner, revoke, authorize } = fixture();
    const manager = create();
    await manager.start(owner, {
      key: "service",
      command: "sleep 300",
      lifetime: "application",
    });
    await manager.close();
    revoke();
    const background = create();
    await background.restore();
    expect(background.hasEnabled()).toBe(false);
    await expect(background.list(owner)).rejects.toThrow("Access revoked");
    expect(authorize).toHaveBeenCalled();
  });

  it("supervises enabled services and a host stop disables further restarts", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { create, owner } = fixture();
    const manager = create();
    try {
      await manager.restore();
      const first = await manager.start(owner, {
        key: "short",
        command: "printf attempt; exit 7",
        lifetime: "application",
      });
      await vi.waitFor(async () =>
        expect((await manager.list(owner))[0]?.status).toBe("exited"),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const [second] = await manager.list(owner);
      expect(second?.processId).not.toBe(first.processId);
      expect(manager.hasEnabled()).toBe(true);
      if (!second) throw new Error("No restarted process.");
      await manager.stopByProcessId({ processId: second.processId });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await manager.list(owner))[0]?.processId).toBe(second.processId);
      expect(manager.hasEnabled()).toBe(false);
    } finally {
      await manager.close();
      vi.useRealTimers();
    }
  });

  it("stops an already running service when its package approval is revoked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { create, owner, revoke } = fixture();
    const manager = create();
    try {
      await manager.restore();
      const service = await manager.start(owner, {
        key: "service",
        command: "sleep 300",
        lifetime: "application",
      });
      revoke();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() =>
        expect(manager.inspect()[0]?.status).toBe("exited"),
      );
      expect(manager.hasEnabled()).toBe(false);
      expect(manager.inspect()[0]?.error).toBe("Access revoked");
      await manager.stopByProcessId({ processId: service.processId });
    } finally {
      await manager.close();
      vi.useRealTimers();
    }
  });

  it("fails a stale state write before running its command", async () => {
    const { owner, root, state } = fixture();
    const manager = new CustomizationProcesses({
      ...authentication(),
      root,
      authorize: async () => ({
        subject: "package",
        projectRoot: root,
        access: {},
      }),
      launch: vi.fn(async () => {
        throw new Error("Must not launch");
      }),
      projects: async () => [],
      readState: async () => ({ ...state }),
      writeState: async () => {
        throw new Error("Version conflict");
      },
    });
    managers.push(manager);
    await expect(
      manager.start(owner, {
        key: "service",
        command: "sleep 300",
        lifetime: "application",
      }),
    ).rejects.toThrow("Version conflict");
    expect(await manager.list(owner)).toEqual([]);
    expect(manager.hasEnabled()).toBe(false);
    // Closing still attempts every child cleanup even after persistence failed.
    await expect(manager.close()).resolves.toBeUndefined();
  });
});
