import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  currentSessionWork,
  FsBackend,
  FsRemoteBackend,
  nativeGit,
  OriginDraftRepo,
  ProjectManager,
} from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { TestSandboxes } from "@catamorphic/sandbox/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedSandboxRepository } from "../services/sandbox-git.js";
import {
  SandboxSyncError,
  saveSessionWorkspace,
  syncSandboxChanges,
} from "../services/sandbox-sync.js";

const TENANT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const MEMBER = "member-1";
const identity = { tenantId: TENANT, externalUserId: MEMBER };
const projectDir = "/workspace/project";
const ownedSandboxes = new TestSandboxes();

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Every byte value, twice over: nothing a text decoder leaves alone. */
const ALL_BYTES = Uint8Array.from({ length: 512 }, (_, index) => index % 256);
/** Mostly NUL, which JSON text and Postgres cannot carry. */
const NUL_HEAVY = (() => {
  const bytes = new Uint8Array(64 * 1024);
  bytes.set([0xff, 0xfe, 0x80, 0x81], 1000);
  return bytes;
})();
/** Incompressible, so its pack needs more than one chunk. */
const LARGE = new Uint8Array(randomBytes(5 * 1024 * 1024));
const SCRIPT = "#!/bin/sh\necho saved\n";
const SPACED = "my notes é.txt";
const QUOTED = 'say "hi"\ttab.txt';
const BROKEN = "line\nbreak.txt";

const FILES: Record<string, Uint8Array> = {
  "all-bytes.bin": ALL_BYTES,
  "nul-heavy.bin": NUL_HEAVY,
  "assets/large.bin": LARGE,
  [SPACED]: new TextEncoder().encode("spaces and an accent\n"),
  [QUOTED]: new TextEncoder().encode("a quote and a tab\n"),
  [BROKEN]: new TextEncoder().encode("a line break\n"),
};

/** What the agent does in its workspace between two saves. */
function changeWorkspace(root: string): void {
  for (const [name, bytes] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), bytes);
  }
  fs.writeFileSync(path.join(root, "run.sh"), SCRIPT, { mode: 0o755 });
  fs.chmodSync(path.join(root, "run.sh"), 0o755);
  fs.symlinkSync("README.md", path.join(root, "link-to-readme"));
  fs.rmSync(path.join(root, "old.txt"));
  // Never saved: ignored by the project, and a folder the sync always skips.
  fs.mkdirSync(path.join(root, "cache-dir"));
  fs.writeFileSync(path.join(root, "cache-dir", "big.bin"), ALL_BYTES);
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "x\n");
}

/** A checkout holds exactly what the agent's workspace held. */
function expectSavedIn(root: string): void {
  for (const [name, bytes] of Object.entries(FILES)) {
    const saved = fs.readFileSync(path.join(root, name));
    expect(saved.length, name).toBe(bytes.length);
    expect(sha256(saved), name).toBe(sha256(bytes));
    expect(fs.lstatSync(path.join(root, name)).mode & 0o111, name).toBe(0);
  }
  expect(fs.readFileSync(path.join(root, "run.sh"), "utf8")).toBe(SCRIPT);
  expect(fs.lstatSync(path.join(root, "run.sh")).mode & 0o100).toBe(0o100);
  expect(fs.lstatSync(path.join(root, "link-to-readme")).isSymbolicLink()).toBe(
    true,
  );
  expect(fs.readlinkSync(path.join(root, "link-to-readme"))).toBe("README.md");
  expect(fs.existsSync(path.join(root, "old.txt"))).toBe(false);
  expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("hello\n");
}

const ZERO = "0".repeat(40);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** What a sandbox claims changed: a write of `content`, or a deletion. */
interface Claim {
  path: string;
  mode: "100644" | "100755" | "120000" | "000000";
  content?: string;
}

/** A raw Git object a hostile sandbox writes: any type, any bytes. */
interface Forged {
  type: "blob" | "tree" | "commit";
  content: (ids: readonly string[]) => Uint8Array;
}

/** One raw tree entry: `<mode> <name>NUL<id>`. */
function treeEntry(mode: string, name: string, id: string): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(`${mode} ${name}`),
      Buffer.from([0]),
      Buffer.from(id, "hex"),
    ]),
  );
}

/** A raw commit of `tree` on `parents`. */
function rawCommit(tree: string, parents: readonly string[]): Uint8Array {
  const who = "Agent <agent@example.test> 1700000000 +0000";
  return new TextEncoder().encode(
    `tree ${tree}\n${parents.map((parent) => `parent ${parent}\n`).join("")}author ${who}\ncommitter ${who}\n\nforged\n`,
  );
}

/**
 * A sandbox that answers the save's commands with whatever it likes: a
 * well-formed pack whose manifest makes the given claims, unless `answer`
 * says otherwise. With `history` it also says its branch stands on a
 * commit it forged, the last of the objects named. Everything it sends is
 * the control plane's to refuse.
 */
function lyingSandbox(input: {
  forge: string;
  claims: readonly Claim[];
  history?: { objects: readonly Forged[]; branch?: string };
  answer?: (output: string) => string;
}): { provider: SandboxProvider; commands: string[]; head: string | null } {
  const git = (args: string[], stdin: string | Uint8Array) =>
    execFileSync("git", ["-C", input.forge, ...args], {
      input: stdin,
      maxBuffer: 64 * 1024 * 1024,
    });
  if (!fs.existsSync(path.join(input.forge, ".git"))) {
    fs.mkdirSync(input.forge, { recursive: true });
    git(["init", "-q", "-b", "main"], "");
  }
  const hash = (content: string | Uint8Array) =>
    git(["hash-object", "-w", "--no-filters", "--stdin"], content)
      .toString()
      .trim();
  const written = input.claims.map((claim) => ({
    ...claim,
    oid: claim.mode === "000000" ? ZERO : hash(claim.content ?? ""),
  }));
  const manifest = hash(
    Buffer.concat(
      written.map((claim) =>
        Buffer.from(
          claim.mode === "000000"
            ? `:100644 000000 ${EMPTY_TREE} ${ZERO} D\0${claim.path}\0`
            : `:000000 ${claim.mode} ${ZERO} ${claim.oid} A\0${claim.path}\0`,
        ),
      ),
    ),
  );
  const forged: string[] = [];
  for (const object of input.history?.objects ?? [])
    forged.push(
      git(
        ["hash-object", "-t", object.type, "-w", "--stdin", "--literally"],
        object.content(forged),
      )
        .toString()
        .trim(),
    );
  const head = forged.at(-1) ?? null;
  const pack = git(
    ["pack-objects", "--stdout", "-q"],
    `${[...written.flatMap((claim) => (claim.mode === "000000" ? [] : [claim.oid])), manifest, ...forged].join("\n")}\n`,
  ).toString("base64");
  const commands: string[] = [];
  const unused = () => {
    throw new Error("unused");
  };
  const provider: SandboxProvider = {
    workspaceRoot: "/workspace",
    createSandbox: unused,
    startSandbox: unused,
    stopSandbox: unused,
    destroySandbox: unused,
    getSandboxStatus: unused,
    gitClone: unused,
    gitCheckout: unused,
    uploadFiles: unused,
    downloadFile: unused,
    async executeCommand(_id, command) {
      commands.push(command);
      if (!command.includes("git write-tree"))
        return { exitCode: 0, result: "chunk\t\n" };
      const output = `work-sync\t${EMPTY_TREE}\t${manifest}\t${pack.length}\t${head ?? "-"}\t${input.history?.branch ?? "-"}\nchunk\t${pack}\n`;
      return { exitCode: 0, result: input.answer?.(output) ?? output };
    },
  };
  return { provider, commands, head };
}

describe("saving a workspace and restoring it (ADR 0341)", () => {
  let dir: string;
  let provider: LocalProcessSandboxProvider;
  let manager: ProjectManager;
  let operations: string[];
  let counted: SandboxProvider;

  /** The folder on this machine a local-process sandbox's checkout is. */
  const checkout = async (sandboxId: string) =>
    (
      await provider.executeCommand(sandboxId, "pwd -P", { cwd: projectDir })
    ).result.trim();

  const createProject = async (projectId: string) => {
    const repo = await manager.create(TENANT, projectId, {
      initialFiles: {
        "README.md": "hello\n",
        "old.txt": "gone soon\n",
        ".gitignore": "cache-dir/\n",
      },
    });
    await repo.dispose();
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "catamorphic-save-"));
    provider = ownedSandboxes.track(
      new LocalProcessSandboxProvider({ root: path.join(dir, "sandboxes") }),
    );
    manager = new ProjectManager(
      new FsBackend(path.join(dir, "copies")),
      new FsRemoteBackend(path.join(dir, "origins")),
    );
    operations = [];
    // Counts what crosses to the sandbox: each call is one remote operation.
    counted = new Proxy(provider, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          operations.push(String(property));
          return Reflect.apply(value, target, args);
        };
      },
    });
  });

  afterAll(async () => {
    await ownedSandboxes.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Seed a sandbox from the session's copy, as a turn's preparation does. */
  const seed = async (input: {
    session: { tenantId: string; projectId: string; sessionId: string };
    sandboxId: string;
    base: string;
  }) => {
    const copy = await manager.openSession(input.session);
    try {
      const work = await currentSessionWork({
        repoPath: copy.repoPath,
        sessionId: input.session.sessionId,
        base: input.base,
      });
      await seedSandboxRepository({
        provider,
        sandboxId: input.sandboxId,
        projectDir,
        sessionCopyPath: copy.repoPath,
        checkpoint: work.checkpoint,
        head: work.head,
        base: input.base,
        branch: work.branch,
        originUrl: null,
      });
      return work;
    } finally {
      await copy.dispose();
    }
  };
  const agentGit = (root: string, args: readonly string[]) =>
    nativeGit(root, [
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=agent@example.test",
      ...args,
    ]);
  const author = { name: "Work", email: "system@work.software" };
  const saveWorkspace = (
    input: Omit<
      Parameters<typeof saveSessionWorkspace>[0],
      "message" | "author"
    >,
  ) =>
    saveSessionWorkspace({ ...input, message: "Save the workspace", author });

  it("round-trips a branch, its commits and uncommitted work through a session's copy", async () => {
    const projectId = "f1e2d3c4-b5a6-7890-dcba-fedcba987654";
    const sessionId = "5e551011-0000-4000-8000-00000000000a";
    await createProject(projectId);
    const session = { tenantId: TENANT, projectId, sessionId };
    const base = await manager.mainCommit({ tenantId: TENANT, projectId });
    await manager.setSessionBase({ ...session, commit: base });
    const copy = await manager.openSession(session);
    const copyPath = copy.repoPath;
    await copy.dispose();

    const first = await provider.createSandbox({});
    expect(await seed({ session, sandboxId: first.id, base })).toMatchObject({
      head: base,
      branch: "work/5e551011",
    });
    const root = await checkout(first.id);
    expect((await nativeGit(root, ["branch", "--show-current"])).trim()).toBe(
      "work/5e551011",
    );

    // The agent's turn: a branch of its own with a commit on it, then one
    // file staged, others untracked, one deleted, a binary, an executable
    // and a link, none of them committed.
    await agentGit(root, ["checkout", "-q", "-b", "feature/x"]);
    fs.writeFileSync(path.join(root, "committed.txt"), "in a commit\n");
    await agentGit(root, ["add", "committed.txt"]);
    await agentGit(root, ["commit", "-q", "-m", "Agent commit"]);
    const agentHead = (await nativeGit(root, ["rev-parse", "HEAD"])).trim();
    changeWorkspace(root);
    // Personal environment delivery does this before the turn starts.
    fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "/.env\n");
    fs.writeFileSync(path.join(root, ".env"), "FIXTURE=local\n");
    fs.writeFileSync(path.join(root, ".editorconfig"), "root = true\n");
    fs.mkdirSync(path.join(root, ".github"));
    fs.writeFileSync(
      path.join(root, ".github", "CODEOWNERS"),
      "* @maintainers\n",
    );
    fs.writeFileSync(path.join(root, "staged.txt"), "staged, not committed\n");
    await agentGit(root, ["add", "staged.txt"]);

    operations.length = 0;
    const saved = await saveWorkspace({
      provider: counted,
      projectManager: manager,
      tenantId: TENANT,
      projectId,
      sessionId,
      base,
      sandboxProviderId: first.id,
      projectDir,
    });
    expect(saved.work).toEqual({ head: agentHead, branch: "feature/x" });
    expect(saved.changes.map((change) => change.path).sort()).toEqual(
      [
        ...Object.keys(FILES),
        ".editorconfig",
        ".github/CODEOWNERS",
        "committed.txt",
        "link-to-readme",
        "old.txt",
        "run.sh",
        "staged.txt",
      ].sort(),
    );
    expect(
      saved.changes.find((change) => change.path === "old.txt")?.kind,
    ).toBe("deleted");
    // A snapshot carrying the first chunk, the rest of the pack, the mark:
    // never one operation per file, and none more for the commits.
    expect(operations).toEqual([
      "executeCommand",
      "executeCommand",
      "executeCommand",
    ]);

    expectSavedIn(copyPath);
    expect(fs.existsSync(path.join(copyPath, "cache-dir"))).toBe(false);
    expect(fs.existsSync(path.join(copyPath, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(copyPath, ".env"))).toBe(false);
    // The agent's commit is in the copy as an object, never as a pack.
    expect(
      (
        await nativeGit(copyPath, ["log", "-1", "--format=%s", agentHead])
      ).trim(),
    ).toBe("Agent commit");

    // The checkpoint the next sandbox is seeded from.
    const { checkpoint } = saved;
    expect(checkpoint).not.toBe(base);
    // The session's ref is its own: never the agent's branch.
    expect(checkpoint).not.toBe(agentHead);
    await provider.destroySandbox(first.id);

    const second = await provider.createSandbox({});
    await seed({ session, sandboxId: second.id, base });
    const restored = await checkout(second.id);
    expect(
      (await nativeGit(restored, ["branch", "--show-current"])).trim(),
    ).toBe("feature/x");
    expect((await nativeGit(restored, ["rev-parse", "HEAD"])).trim()).toBe(
      agentHead,
    );
    expect(
      (await nativeGit(restored, ["log", "--format=%s"])).trim().split("\n"),
    ).toEqual(["Agent commit", "Initial commit"]);
    // Work's checkpoint never reaches the sandbox: only its tree does.
    await expect(
      nativeGit(restored, ["cat-file", "-e", checkpoint]),
    ).rejects.toThrow();
    expectSavedIn(restored);
    expect(fs.readFileSync(path.join(restored, ".editorconfig"), "utf8")).toBe(
      "root = true\n",
    );
    expect(
      fs.readFileSync(path.join(restored, ".github", "CODEOWNERS"), "utf8"),
    ).toBe("* @maintainers\n");
    expect(fs.readFileSync(path.join(restored, "committed.txt"), "utf8")).toBe(
      "in a commit\n",
    );
    expect(fs.existsSync(path.join(restored, "cache-dir"))).toBe(false);
    expect(fs.existsSync(path.join(restored, ".env"))).toBe(false);
    // What was not committed is uncommitted again; what was staged comes
    // back unstaged.
    const status = (
      await nativeGit(restored, ["status", "--porcelain", "-uall"])
    )
      .split("\n")
      .filter(Boolean);
    expect(status).toEqual(
      expect.arrayContaining([
        " D old.txt",
        "?? run.sh",
        "?? staged.txt",
        "?? link-to-readme",
        "?? all-bytes.bin",
        "?? assets/large.bin",
      ]),
    );
    expect(status.some((line) => line.endsWith("committed.txt"))).toBe(false);
    expect(status.every((line) => /^( D|\?\?) /.test(line))).toBe(true);

    // What was restored is what was saved: nothing is left to save.
    const again = await saveWorkspace({
      provider,
      projectManager: manager,
      tenantId: TENANT,
      projectId,
      sessionId,
      base,
      sandboxProviderId: second.id,
      projectDir,
    });
    expect(again).toEqual({
      changes: [],
      work: { head: agentHead, branch: "feature/x" },
      checkpoint,
    });

    // A commit alone, and a renamed branch, are saved without any file
    // having changed since the last save.
    await agentGit(restored, ["add", "staged.txt"]);
    await agentGit(restored, ["commit", "-q", "-m", "Second commit"]);
    await agentGit(restored, ["branch", "-m", "feature/y"]);
    const secondHead = (
      await nativeGit(restored, ["rev-parse", "HEAD"])
    ).trim();
    const committed = await saveWorkspace({
      provider,
      projectManager: manager,
      tenantId: TENANT,
      projectId,
      sessionId,
      base,
      sandboxProviderId: second.id,
      projectDir,
    });
    expect(committed).toMatchObject({
      changes: [],
      work: { head: secondHead, branch: "feature/y" },
    });
    expect(committed.checkpoint).not.toBe(checkpoint);
    await provider.destroySandbox(second.id);

    const third = await provider.createSandbox({});
    await seed({ session, sandboxId: third.id, base });
    const final = await checkout(third.id);
    expect((await nativeGit(final, ["branch", "--show-current"])).trim()).toBe(
      "feature/y",
    );
    expect(
      (await nativeGit(final, ["log", "--format=%s"])).trim().split("\n"),
    ).toEqual(["Second commit", "Agent commit", "Initial commit"]);
    expect(
      (
        await nativeGit(final, ["status", "--porcelain", "--", "staged.txt"])
      ).trim(),
    ).toBe("");
    expectSavedIn(final);
  }, 120_000);

  it("repeats the full save from another replica when the origin refuses publication", async () => {
    const projectId = "a2d7a492-7905-4d12-8815-ec4800081704";
    const sessionId = "5e551011-0000-4000-8000-00000000000c";
    const session = { tenantId: TENANT, projectId, sessionId };
    await createProject(projectId);
    const base = await manager.mainCommit(session);
    await manager.setSessionBase({ ...session, commit: base });
    const sandbox = await provider.createSandbox({});
    const initial = await seed({ session, sandboxId: sandbox.id, base });
    const root = await checkout(sandbox.id);
    const marker = () => agentGit(root, ["rev-parse", "refs/work/synced"]);
    const previousMarker = await marker();
    fs.writeFileSync(path.join(root, ".editorconfig"), "root = true\n");

    const origin = manager.remoteBackend;
    if (!origin) throw new Error("The fixture needs a shared origin");
    const withOrigin = origin.withOrigin.bind(origin);
    const publish = vi.spyOn(origin, "withOrigin");
    publish.mockImplementation((tenantId, project, use) =>
      withOrigin(tenantId, project, async (repo) => {
        const update = vi
          .spyOn(repo, "updateRef")
          .mockRejectedValue(new Error("origin is unavailable"));
        try {
          return await use(repo);
        } finally {
          update.mockRestore();
        }
      }),
    );
    const input = {
      ...session,
      base,
      provider,
      sandboxProviderId: sandbox.id,
      projectDir,
    };
    try {
      await expect(
        saveWorkspace({ ...input, projectManager: manager }),
      ).rejects.toThrow("origin is unavailable");
    } finally {
      publish.mockRestore();
    }
    expect(await marker()).toBe(previousMarker);
    expect(await manager.sessionWork({ ...session, base })).toEqual(initial);

    const replica = new ProjectManager(
      new FsBackend(path.join(dir, "replica")),
      origin,
    );
    const saved = await saveWorkspace({ ...input, projectManager: replica });
    expect(saved.changes).toEqual([
      { path: ".editorconfig", kind: "modified" },
    ]);
    expect(await marker()).not.toBe(previousMarker);
    const restored = await manager.openSession({ ...session, refresh: true });
    try {
      expect(await restored.readFile(".editorconfig")).toBe("root = true\n");
      expect(await restored.resolveRef()).toBe(saved.checkpoint);
    } finally {
      await restored.dispose();
    }
  });

  it("saves the files of a sandbox that was not seeded from the session's copy, and none of its history", async () => {
    const projectId = "7c6b5a49-3827-4615-9e0d-1c2b3a4f5e6d";
    const sessionId = "5e551011-0000-4000-8000-00000000000b";
    await createProject(projectId);
    const session = { tenantId: TENANT, projectId, sessionId };
    const base = await manager.mainCommit({ tenantId: TENANT, projectId });
    await manager.setSessionBase({ ...session, commit: base });
    // A sandbox from before chats stood on a branch: one commit of its own
    // making, related to nothing the copy holds.
    const sandbox = await provider.createSandbox({});
    const root = await checkout(sandbox.id);
    fs.writeFileSync(path.join(root, "README.md"), "hello\n");
    await agentGit(root, ["init", "-q", "-b", "main"]);
    await agentGit(root, ["add", "-A"]);
    await agentGit(root, ["commit", "-q", "-m", "baseline"]);
    await agentGit(root, ["update-ref", "refs/work/synced", "HEAD"]);
    fs.writeFileSync(path.join(root, "notes.md"), "kept\n");

    const saved = await saveWorkspace({
      provider,
      projectManager: manager,
      tenantId: TENANT,
      projectId,
      sessionId,
      base,
      sandboxProviderId: sandbox.id,
      projectDir,
    });
    expect(saved).toMatchObject({
      changes: [{ path: "notes.md", kind: "modified" }],
      work: { head: base, branch: "work/5e551011" },
    });
    const copy = await manager.openSession(session);
    expect(await copy.readFile("notes.md")).toBe("kept\n");
    await copy.dispose();

    // A sandbox made and never seeded holds no repository: nothing to save.
    const empty = await provider.createSandbox({});
    await checkout(empty.id);
    expect(
      await saveWorkspace({
        provider,
        projectManager: manager,
        tenantId: TENANT,
        projectId,
        sessionId,
        base,
        sandboxProviderId: empty.id,
        projectDir,
      }),
    ).toMatchObject({
      changes: [],
      work: { head: base, branch: "work/5e551011" },
    });
  }, 60_000);

  it("saves the same bytes, modes and links into a member's draft in the origin", async () => {
    const projectId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    await createProject(projectId);
    const sandbox = await provider.createSandbox({});
    const root = await checkout(sandbox.id);
    fs.writeFileSync(path.join(root, "README.md"), "hello\n");
    fs.writeFileSync(path.join(root, "old.txt"), "gone soon\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "cache-dir/\n");
    // A sandbox that is no chat's holds a repository of its own making.
    await agentGit(root, ["init", "-q", "-b", "main"]);
    await agentGit(root, ["add", "-A"]);
    await agentGit(root, ["commit", "-q", "-m", "baseline"]);
    await agentGit(root, ["update-ref", "refs/work/synced", "HEAD"]);
    changeWorkspace(root);

    await syncSandboxChanges({
      provider,
      projectManager: manager,
      identity,
      projectId,
      sandboxProviderId: sandbox.id,
      projectDir,
    });

    const draft = await manager.openDraft({
      tenantId: TENANT,
      projectId,
      externalUserId: MEMBER,
    });
    expect(draft).toBeInstanceOf(OriginDraftRepo);
    const tip = await draft.resolveRef("HEAD");
    await draft.dispose();
    // The origin is a bare repository on disk: Git itself reads the draft.
    const origin = path.join(dir, "origins", TENANT, `${projectId}.git`);
    const entries = new Map(
      (await nativeGit(origin, ["ls-tree", "-r", "-z", tip]))
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const tab = entry.indexOf("\t");
          const [mode = "", , oid = ""] = entry.slice(0, tab).split(" ");
          return [entry.slice(tab + 1), { mode, oid }] as const;
        }),
    );
    const blob = (file: string) =>
      new Promise<Buffer>((resolve, reject) => {
        const oid = entries.get(file)?.oid ?? "missing";
        execFile(
          "git",
          ["-C", origin, "cat-file", "blob", oid],
          { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
    for (const [name, bytes] of Object.entries(FILES)) {
      expect(entries.get(name)?.mode, name).toBe("100644");
      const saved = await blob(name);
      expect(saved.length, name).toBe(bytes.length);
      expect(sha256(saved), name).toBe(sha256(bytes));
    }
    expect(entries.get("run.sh")?.mode).toBe("100755");
    expect((await blob("run.sh")).toString("utf8")).toBe(SCRIPT);
    expect(entries.get("link-to-readme")?.mode).toBe("120000");
    expect((await blob("link-to-readme")).toString("utf8")).toBe("README.md");
    expect(entries.has("old.txt")).toBe(false);
    expect(entries.has("README.md")).toBe(true);
    expect(
      [...entries.keys()].filter(
        (file) =>
          file.startsWith("cache-dir/") || file.startsWith("node_modules/"),
      ),
    ).toEqual([]);

    // A link is replaced and deleted as an entry, and a file takes a
    // folder's place, as Git would.
    fs.rmSync(path.join(root, "link-to-readme"));
    fs.writeFileSync(path.join(root, "link-to-readme"), "now a file\n");
    fs.rmSync(path.join(root, "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "assets"), "now a file too\n");
    await syncSandboxChanges({
      provider,
      projectManager: manager,
      identity,
      projectId,
      sandboxProviderId: sandbox.id,
      projectDir,
    });
    const after = await manager.openDraft({
      tenantId: TENANT,
      projectId,
      externalUserId: MEMBER,
    });
    expect(await after.readFile("link-to-readme")).toBe("now a file\n");
    expect(await after.readFile("assets")).toBe("now a file too\n");
    expect(await after.readFile("README.md")).toBe("hello\n");
    await after.dispose();
  }, 120_000);

  describe("from a sandbox that lies", () => {
    const sessionId = "5e551011-0000-4000-8000-0000000000ff";
    let projectId: string;
    let copyPath: string;
    let base: string;
    let outside: string;
    let forges = 0;

    const save = (
      claims: readonly Claim[],
      answer?: (output: string) => string,
      history?: { objects: readonly Forged[]; branch?: string },
    ) => {
      forges += 1;
      const sandbox = lyingSandbox({
        forge: path.join(dir, `forge-${forges}`),
        claims,
        ...(answer ? { answer } : {}),
        ...(history ? { history } : {}),
      });
      return {
        commands: sandbox.commands,
        head: sandbox.head,
        done: saveWorkspace({
          provider: sandbox.provider,
          projectManager: manager,
          tenantId: TENANT,
          projectId,
          sessionId,
          base,
          sandboxProviderId: "s",
          projectDir,
        }).then((saved) => saved.changes),
      };
    };
    /** Refused: nothing is marked as saved, so the workspace is kept. */
    const refused = async (
      claims: readonly Claim[],
      answer?: (output: string) => string,
      history?: { objects: readonly Forged[]; branch?: string },
    ) => {
      const attempt = save(claims, answer, history);
      await expect(attempt.done).rejects.toBeInstanceOf(SandboxSyncError);
      expect(
        attempt.commands.filter((command) => command.includes("update-ref")),
      ).toEqual([]);
      return attempt.commands;
    };

    beforeAll(async () => {
      projectId = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
      await createProject(projectId);
      base = await manager.mainCommit({ tenantId: TENANT, projectId });
      await manager.setSessionBase({
        tenantId: TENANT,
        projectId,
        sessionId,
        commit: base,
      });
      const copy = await manager.openSession({
        tenantId: TENANT,
        projectId,
        sessionId,
      });
      copyPath = copy.repoPath;
      await copy.dispose();
      outside = path.join(dir, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "secret"), "untouched\n");
    });

    it("refuses paths that leave the checkout or enter its Git directory", async () => {
      const before = fs.readFileSync(path.join(copyPath, ".git", "config"));
      for (const hostile of [
        "../outside/planted",
        "a/../../../outside/planted",
        path.join(outside, "planted"),
        ".git/hooks/pre-commit",
        ".GIT/config",
        "sub/.git/config",
      ]) {
        await refused([
          { path: "fine.txt", mode: "100644", content: "fine\n" },
          { path: hostile, mode: "100755", content: "#!/bin/sh\n" },
        ]);
        await refused([{ path: hostile, mode: "000000" }]);
      }
      expect(fs.readdirSync(outside)).toEqual(["secret"]);
      expect(
        fs.existsSync(path.join(copyPath, ".git", "hooks", "pre-commit")),
      ).toBe(false);
      expect(fs.readFileSync(path.join(copyPath, ".git", "config"))).toEqual(
        before,
      );
      // A save is refused whole: the harmless file beside a hostile one
      // was not written either.
      expect(fs.existsSync(path.join(copyPath, "fine.txt"))).toBe(false);
      expect(fs.existsSync(path.join(copyPath, "sub"))).toBe(false);
    });

    it("keeps a link that points outside, and never writes through it", async () => {
      // Saving the link is honest work: it is kept as a link.
      const linked = save([
        { path: "evil", mode: "120000", content: outside },
        {
          path: "passwd",
          mode: "120000",
          content: path.join(outside, "secret"),
        },
      ]);
      expect(await linked.done).toEqual([
        { path: "evil", kind: "modified" },
        { path: "passwd", kind: "modified" },
      ]);
      expect(linked.commands.at(-1)).toContain("update-ref refs/work/synced");
      expect(fs.readlinkSync(path.join(copyPath, "evil"))).toBe(outside);

      // The next save tries to write through it, and to delete through it.
      await refused([{ path: "evil/planted", mode: "100644", content: "x" }]);
      await save([{ path: "evil/secret", mode: "000000" }]).done;
      expect(fs.readdirSync(outside)).toEqual(["secret"]);
      expect(fs.readFileSync(path.join(outside, "secret"), "utf8")).toBe(
        "untouched\n",
      );

      // A file saved over a link replaces the link, not what it points at.
      await save([{ path: "passwd", mode: "100644", content: "mine\n" }]).done;
      expect(fs.lstatSync(path.join(copyPath, "passwd")).isFile()).toBe(true);
      expect(fs.readFileSync(path.join(copyPath, "passwd"), "utf8")).toBe(
        "mine\n",
      );
      expect(fs.readFileSync(path.join(outside, "secret"), "utf8")).toBe(
        "untouched\n",
      );

      // Reading the whole copy never opens the link either.
      const copy = await manager.openSession({
        tenantId: TENANT,
        projectId,
        sessionId,
      });
      try {
        const files = await copy.readAllFiles();
        expect(files.passwd).toBe("mine\n");
        expect(files.evil).toBeUndefined();
        await expect(copy.readFile("evil/secret")).rejects.toThrow();
      } finally {
        await copy.dispose();
      }
    });

    it("refuses a pack that is cut short, damaged, oversized or not a pack", async () => {
      const claims: Claim[] = [
        { path: "never.txt", mode: "100644", content: "never saved\n" },
      ];
      const chunk = (output: string) => output.split("chunk\t")[1] ?? "";
      // Fewer characters than the snapshot said.
      await refused(claims, (output) => output.slice(0, -9));
      // The right length, but bytes decoded as text on the way (the bug).
      await refused(claims, (output) =>
        output.replace(
          chunk(output),
          `${Buffer.from(
            Buffer.from(chunk(output).trim(), "base64").toString("utf8"),
          )
            .toString("base64")
            .slice(0, chunk(output).trim().length)}\n`,
        ),
      );
      // Not base64 at all.
      await refused(claims, (output) =>
        output.replace(
          chunk(output),
          `${"!".repeat(chunk(output).length - 1)}\n`,
        ),
      );
      // A length no save may have: refused before another byte is read.
      const oversized = await refused(claims, (output) =>
        output.replace(/\t(\d+)\t-\t-\nchunk/, "\t99999999999\t-\t-\nchunk"),
      );
      expect(oversized).toHaveLength(1);
      // A manifest the pack does not hold, and an unreadable snapshot line.
      await refused(claims, (output) =>
        output.replace(/\t[0-9a-f]{40}\t(\d+)\t/, `\t${"c".repeat(40)}\t$1\t`),
      );
      await refused(claims, () => "work-sync\tnot-a-tree\t-\t0\t-\t-\n");
      await refused(claims, () => `work-sync\t${EMPTY_TREE}\t-\t0\n`);
      await refused(claims, () => "");
      expect(fs.existsSync(path.join(copyPath, "never.txt"))).toBe(false);
    });

    it("refuses commits whose trees leave the checkout, enter a Git directory or carry a bad mode", async () => {
      const blob: Forged = {
        type: "blob",
        content: () => new TextEncoder().encode("#!/bin/sh\n"),
      };
      const hostile: Array<readonly Forged[]> = [
        // A file named `..`.
        [
          blob,
          {
            type: "tree",
            content: ([file = ""]) => treeEntry("100644", "..", file),
          },
        ],
        // `.git/config`, by any spelling.
        ...[".git", ".GIT", "git~1"].map((name): Forged[] => [
          blob,
          {
            type: "tree",
            content: ([file = ""]) => treeEntry("100644", "config", file),
          },
          {
            type: "tree",
            content: ([, folder = ""]) => treeEntry("40000", name, folder),
          },
        ]),
        // A mode no checkout may hold.
        [
          blob,
          {
            type: "tree",
            content: ([file = ""]) => treeEntry("100666", "open.sh", file),
          },
        ],
        // A name that is a path.
        [
          blob,
          {
            type: "tree",
            content: ([file = ""]) => treeEntry("100644", "a/../../x", file),
          },
        ],
      ];
      for (const objects of hostile) {
        const commands = await refused([], undefined, {
          branch: "feature/x",
          objects: [
            ...objects,
            {
              type: "commit",
              content: (ids) => rawCommit(ids.at(-1) ?? "", [base]),
            },
          ],
        });
        expect(commands).toHaveLength(1);
      }
      // Nothing of any of them was kept: the copy holds what it held.
      expect(
        (await nativeGit(copyPath, ["count-objects", "-v"])).includes(
          "in-pack: 0",
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(copyPath, "open.sh"))).toBe(false);
      expect(
        fs
          .readdirSync(path.join(copyPath, ".git", "objects", "pack"))
          .filter((file) => file.endsWith(".pack")),
      ).toEqual([]);
    });

    it("refuses commits whose history does not reach what the copy holds", async () => {
      const tree: Forged = { type: "tree", content: () => new Uint8Array() };
      // A parent that never arrived.
      const truncated = save([], undefined, {
        branch: "feature/x",
        objects: [
          tree,
          {
            type: "commit",
            content: ([empty = ""]) => rawCommit(empty, ["d".repeat(40)]),
          },
        ],
      });
      await expect(truncated.done).rejects.toThrow(
        /history that did not arrive/,
      );
      // History that starts nowhere.
      const orphan = save([], undefined, {
        branch: "feature/x",
        objects: [
          tree,
          { type: "commit", content: ([empty = ""]) => rawCommit(empty, []) },
        ],
      });
      await expect(orphan.done).rejects.toThrow(/no parent/);
      // A commit whose tree never arrived.
      const hollow = save([], undefined, {
        branch: "feature/x",
        objects: [
          {
            type: "commit",
            content: () => rawCommit("e".repeat(40), [base]),
          },
        ],
      });
      await expect(hollow.done).rejects.toBeInstanceOf(SandboxSyncError);
      for (const attempt of [truncated, orphan, hollow]) {
        expect(
          attempt.commands.filter((command) => command.includes("update-ref")),
        ).toEqual([]);
        await expect(
          nativeGit(copyPath, ["cat-file", "-e", attempt.head ?? ""]),
        ).rejects.toThrow();
      }
    });

    it("refuses a branch name Git would not take, and a HEAD that is not a commit id", async () => {
      const honest: readonly Forged[] = [
        { type: "tree", content: () => new Uint8Array() },
        {
          type: "commit",
          content: ([empty = ""]) => rawCommit(empty, [base]),
        },
      ];
      for (const branch of ["a..b", "-x", "a b", "x.lock", "feature/@{now}"])
        await expect(
          save([], undefined, { branch, objects: honest }).done,
          branch,
        ).rejects.toThrow(/branch whose name cannot be saved|unreadable/);
      await refused(
        [],
        (output) =>
          output.replace(/\t[0-9a-f]{40}\tfeature\/x\n/, "\tHEAD\tfeature/x\n"),
        { branch: "feature/x", objects: honest },
      );
      // The same commit under a name Git takes is kept.
      const kept = save([], undefined, {
        branch: "feature/x",
        objects: honest,
      });
      expect(await kept.done).toEqual([]);
      await nativeGit(copyPath, ["cat-file", "-e", kept.head ?? ""]);
    });
  });
});
