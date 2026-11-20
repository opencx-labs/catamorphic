import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FsBackend,
  FsRemoteBackend,
  nativeGit,
  OriginDraftRepo,
  ProjectManager,
} from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { TestSandboxes } from "@catamorphic/sandbox/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureSandboxBaseline,
  seedSandboxRepository,
} from "../services/sandbox-git.js";
import {
  SandboxSyncError,
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

/**
 * A sandbox that answers the save's commands with whatever it likes: a
 * well-formed pack whose manifest makes the given claims, unless `answer`
 * says otherwise. Everything it sends is the control plane's to refuse.
 */
function lyingSandbox(input: {
  forge: string;
  claims: readonly Claim[];
  answer?: (output: string) => string;
}): { provider: SandboxProvider; commands: string[] } {
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
  const pack = git(
    ["pack-objects", "--stdout", "-q"],
    `${[...written.flatMap((claim) => (claim.mode === "000000" ? [] : [claim.oid])), manifest].join("\n")}\n`,
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
      const output = `work-sync\t${EMPTY_TREE}\t${manifest}\t${pack.length}\nchunk\t${pack}\n`;
      return { exitCode: 0, result: input.answer?.(output) ?? output };
    },
  };
  return { provider, commands };
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

  it("round-trips bytes, executable bits, links and deletions through a session's copy", async () => {
    const projectId = "f1e2d3c4-b5a6-7890-dcba-fedcba987654";
    const sessionId = "session-a";
    await createProject(projectId);
    const session = { tenantId: TENANT, projectId, sessionId };
    const copy = await manager.openSession(session);
    const base = await copy.resolveRef("HEAD");
    const copyPath = copy.repoPath;
    await copy.dispose();

    const first = await provider.createSandbox({});
    await seedSandboxRepository({
      provider,
      sandboxId: first.id,
      projectDir,
      sessionCopyPath: copyPath,
      head: base,
      base,
      branch: "work/test",
      originUrl: null,
    });
    changeWorkspace(await checkout(first.id));

    operations.length = 0;
    const changes = await syncSandboxChanges({
      provider: counted,
      projectManager: manager,
      identity,
      projectId,
      sessionId,
      sandboxProviderId: first.id,
      projectDir,
    });
    expect(changes).toEqual(
      [
        ...Object.keys(FILES).map((file) => ({ path: file, kind: "modified" })),
        { path: "run.sh", kind: "modified" },
        { path: "link-to-readme", kind: "modified" },
        { path: "old.txt", kind: "deleted" },
      ].sort((a, b) => (a.path < b.path ? -1 : 1)),
    );
    // A snapshot carrying the first chunk, the rest of the pack, the mark:
    // never one operation per file.
    expect(operations).toEqual([
      "executeCommand",
      "executeCommand",
      "executeCommand",
    ]);

    expectSavedIn(copyPath);
    expect(fs.existsSync(path.join(copyPath, "cache-dir"))).toBe(false);
    expect(fs.existsSync(path.join(copyPath, "node_modules"))).toBe(false);

    // The checkpoint the next sandbox is seeded from.
    const head = await manager.checkpointSession({
      ...session,
      message: "Save the workspace",
      author: { name: "Work", email: "system@work.software" },
    });
    expect(head).not.toBe(base);
    await provider.destroySandbox(first.id);

    const second = await provider.createSandbox({});
    await seedSandboxRepository({
      provider,
      sandboxId: second.id,
      projectDir,
      sessionCopyPath: copyPath,
      head,
      base,
      branch: "work/test",
      originUrl: null,
    });
    const restored = await checkout(second.id);
    expectSavedIn(restored);
    expect(fs.existsSync(path.join(restored, "cache-dir"))).toBe(false);
    // The saved work stands uncommitted on the base, as a turn left it.
    expect(
      (
        await nativeGit(restored, ["status", "--porcelain", "--", "run.sh"])
      ).trim(),
    ).toBe("?? run.sh");

    // What was restored is what was saved: nothing is left to save.
    expect(
      await syncSandboxChanges({
        provider,
        projectManager: manager,
        identity,
        projectId,
        sessionId,
        sandboxProviderId: second.id,
        projectDir,
      }),
    ).toEqual([]);
  }, 120_000);

  it("saves the same bytes, modes and links into a member's draft in the origin", async () => {
    const projectId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    await createProject(projectId);
    const sandbox = await provider.createSandbox({});
    const root = await checkout(sandbox.id);
    fs.writeFileSync(path.join(root, "README.md"), "hello\n");
    fs.writeFileSync(path.join(root, "old.txt"), "gone soon\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "cache-dir/\n");
    await ensureSandboxBaseline({
      provider,
      sandboxId: sandbox.id,
      projectDir,
      originUrl: null,
    });
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
    let projectId: string;
    let copyPath: string;
    let outside: string;
    let forges = 0;

    const save = (
      claims: readonly Claim[],
      answer?: (output: string) => string,
    ) => {
      forges += 1;
      const sandbox = lyingSandbox({
        forge: path.join(dir, `forge-${forges}`),
        claims,
        ...(answer ? { answer } : {}),
      });
      return {
        commands: sandbox.commands,
        done: syncSandboxChanges({
          provider: sandbox.provider,
          projectManager: manager,
          identity,
          projectId,
          sessionId: "session-hostile",
          sandboxProviderId: "s",
          projectDir,
        }),
      };
    };
    /** Refused: nothing is marked as saved, so the workspace is kept. */
    const refused = async (
      claims: readonly Claim[],
      answer?: (output: string) => string,
    ) => {
      const attempt = save(claims, answer);
      await expect(attempt.done).rejects.toBeInstanceOf(SandboxSyncError);
      expect(
        attempt.commands.filter((command) => command.includes("update-ref")),
      ).toEqual([]);
      return attempt.commands;
    };

    beforeAll(async () => {
      projectId = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
      await createProject(projectId);
      const copy = await manager.openSession({
        tenantId: TENANT,
        projectId,
        sessionId: "session-hostile",
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
        sessionId: "session-hostile",
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
        output.replace(/\t(\d+)\nchunk/, "\t99999999999\nchunk"),
      );
      expect(oversized).toHaveLength(1);
      // A manifest the pack does not hold, and an unreadable snapshot line.
      await refused(claims, (output) =>
        output.replace(/\t[0-9a-f]{40}\t(\d+)\n/, `\t${"c".repeat(40)}\t$1\n`),
      );
      await refused(claims, () => "work-sync\tnot-a-tree\t-\t0\n");
      await refused(claims, () => "");
      expect(fs.existsSync(path.join(copyPath, "never.txt"))).toBe(false);
    });
  });
});
