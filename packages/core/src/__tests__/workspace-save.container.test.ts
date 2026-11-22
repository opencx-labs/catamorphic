import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ContainerSandboxProvider,
  DockerClient,
  dockerEndpoint,
  probeContainerSupport,
} from "@catamorphic/container";
import {
  currentSessionWork,
  FsBackend,
  FsRemoteBackend,
  ProjectManager,
} from "@catamorphic/git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSandboxRepository } from "../services/sandbox-git.js";
import { saveSessionWorkspace } from "../services/sandbox-sync.js";

// Real containers, as packages/container's own tests: WORK_TEST_CONTAINER=1
// with a Docker daemon (packages/container/scripts/test-in-docker.sh
// --suite save sets one up with gVisor).
const enabled = process.env.WORK_TEST_CONTAINER === "1";
const IMAGE =
  process.env.WORK_TEST_CONTAINER_IMAGE ??
  "oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a";
const MINUTES = 60_000;
const TENANT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PROJECT = "f1e2d3c4-b5a6-7890-dcba-fedcba987654";
const SESSION = "c0de0001-0000-4000-8000-00000000c0de";
const projectDir = "/workspace/project";
const SPACED = "my notes é.txt";
const FILES = ["all-bytes.bin", "nul-heavy.bin", "assets/large.bin", SPACED];

/** What the agent does between two saves, with the image's own tools. */
const CHANGE = [
  "set -e",
  // A branch of its own with one commit on it.
  "git checkout -q -b feature/x",
  "echo 'in a commit' > committed.txt",
  "git add committed.txt",
  "git -c user.name=Agent -c user.email=agent@example.test commit -q -m 'Agent commit'",
  // Every byte value, a file of NULs, and one whose pack needs two chunks.
  'i=0; : > all-bytes.bin; while [ "$i" -lt 256 ]; do printf "\\\\$(printf %03o "$i")" >> all-bytes.bin; i=$((i + 1)); done',
  "head -c 65536 /dev/zero > nul-heavy.bin",
  "mkdir -p assets cache-dir node_modules/pkg",
  "head -c 5242880 /dev/urandom > assets/large.bin",
  `printf 'spaces and an accent\\n' > '${SPACED}'`,
  "printf '#!/bin/sh\\necho saved\\n' > run.sh",
  "chmod 755 run.sh",
  "ln -s README.md link-to-readme",
  "rm old.txt",
  "echo x > cache-dir/big.bin",
  "echo x > node_modules/pkg/index.js",
  // Staged, never committed.
  "echo staged > staged.txt",
  "git add staged.txt",
].join("\n");

/** One line per fact a restored workspace must repeat exactly. */
const DESCRIBE = [
  `sha256sum ${FILES.map((file) => `'${file}'`).join(" ")} run.sh`,
  "wc -c < all-bytes.bin",
  "stat -c '%a %F' run.sh all-bytes.bin link-to-readme",
  "readlink link-to-readme",
  "ls -a",
  // The branch, its commits, and what is not committed.
  "git branch --show-current",
  "git log --format='%H %s'",
].join(" && ");

describe.skipIf(!enabled)(
  "saving a container's workspace (ADRs 0343, 0344)",
  () => {
    let root: string;
    let provider: ContainerSandboxProvider;
    let manager: ProjectManager;
    const sandboxes: string[] = [];

    const run = async (sandboxId: string, command: string) => {
      const output = await provider.executeCommand(sandboxId, command, {
        cwd: projectDir,
        timeout: 300,
      });
      if (output.exitCode !== 0) throw new Error(output.result.slice(-2000));
      return output.result;
    };

    beforeAll(async () => {
      const docker = new DockerClient(dockerEndpoint(process.env.DOCKER_HOST));
      const support = await probeContainerSupport(docker);
      if (!support.ok) throw new Error(support.reason);
      const wanted = process.env.WORK_TEST_CONTAINER_RUNTIME ?? "runsc";
      if (wanted === "runsc" && !support.runsc)
        throw new Error(
          "The daemon has no runsc runtime; run packages/container/scripts/test-in-docker.sh --suite save, or set WORK_TEST_CONTAINER_RUNTIME=runc",
        );
      root = fs.mkdtempSync(path.join(os.tmpdir(), "work-save-ctest-"));
      if (!(await docker.inspectImage(IMAGE))) await docker.pullImage(IMAGE);
      provider = new ContainerSandboxProvider({
        docker,
        runtime:
          wanted === "runsc" && support.runsc
            ? support.runsc
            : { kind: "runc", ...support.runc },
        stateDirectory: path.join(root, "state"),
        image: IMAGE,
        namePrefix: "work-save-test",
      });
      manager = new ProjectManager(
        new FsBackend(path.join(root, "copies")),
        new FsRemoteBackend(path.join(root, "origins")),
      );
    }, 10 * MINUTES);

    afterAll(async () => {
      for (const id of sandboxes)
        await provider.destroySandbox(id).catch(() => {});
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }, 5 * MINUTES);

    it(
      "round-trips a branch, its commits and uncommitted work through a session's copy",
      async () => {
        const created = await manager.create(TENANT, PROJECT, {
          initialFiles: {
            "README.md": "hello\n",
            "old.txt": "gone soon\n",
            ".gitignore": "cache-dir/\n",
          },
        });
        await created.dispose();
        const session = {
          tenantId: TENANT,
          projectId: PROJECT,
          sessionId: SESSION,
        };
        const base = await manager.mainCommit(session);
        await manager.setSessionBase({ ...session, commit: base });
        const copy = await manager.openSession(session);
        const copyPath = copy.repoPath;
        await copy.dispose();
        const seed = async (sandboxId: string) => {
          const work = await currentSessionWork({
            repoPath: copyPath,
            sessionId: SESSION,
            base,
          });
          await seedSandboxRepository({
            provider,
            sandboxId,
            projectDir,
            sessionCopyPath: copyPath,
            checkpoint: work.checkpoint,
            head: work.head,
            base,
            branch: work.branch,
            originUrl: null,
          });
        };
        const save = (sandboxProviderId: string) =>
          saveSessionWorkspace({
            provider,
            projectManager: manager,
            tenantId: TENANT,
            projectId: PROJECT,
            sessionId: SESSION,
            base,
            sandboxProviderId,
            projectDir,
            message: "Save the workspace",
            author: { name: "Work", email: "system@work.software" },
          });

        const first = (await provider.createSandbox({})).id;
        sandboxes.push(first);
        await seed(first);
        await run(first, CHANGE);
        const before = await run(first, DESCRIBE);
        expect(before).toContain("755 regular file");
        expect(before).toContain("symbolic link");
        expect(before).toContain("feature/x");
        expect(before).toContain("Agent commit");

        const saved = await save(first);
        expect(saved.work.branch).toBe("feature/x");
        expect(before).toContain(`${saved.work.head} Agent commit`);
        expect(saved.changes.map((change) => change.path).sort()).toEqual(
          [
            ...FILES,
            "committed.txt",
            "run.sh",
            "link-to-readme",
            "old.txt",
            "staged.txt",
          ].sort(),
        );

        // The control plane's copy holds the sandbox's bytes, bit for bit.
        for (const file of [...FILES, "run.sh"]) {
          const digest = createHash("sha256")
            .update(fs.readFileSync(path.join(copyPath, file)))
            .digest("hex");
          expect(before, file).toContain(`${digest}  ${file}`);
        }
        expect(fs.statSync(path.join(copyPath, "all-bytes.bin")).size).toBe(
          256,
        );
        expect(fs.lstatSync(path.join(copyPath, "run.sh")).mode & 0o100).toBe(
          0o100,
        );
        expect(fs.readlinkSync(path.join(copyPath, "link-to-readme"))).toBe(
          "README.md",
        );
        expect(fs.existsSync(path.join(copyPath, "old.txt"))).toBe(false);
        expect(fs.existsSync(path.join(copyPath, "cache-dir"))).toBe(false);
        expect(fs.existsSync(path.join(copyPath, "node_modules"))).toBe(false);

        await provider.destroySandbox(first);

        // A fresh sandbox, seeded from the copy, repeats every fact: the
        // files, the branch and its commits.
        const second = (await provider.createSandbox({})).id;
        sandboxes.push(second);
        await seed(second);
        const after = await run(second, DESCRIBE);
        const withoutUnsaved = (listing: string) =>
          listing
            .split("\n")
            .filter((line) => line !== "cache-dir" && line !== "node_modules")
            .join("\n");
        expect(after).toBe(withoutUnsaved(before));
        // What was not committed is uncommitted again, staged or not.
        const status = await run(second, "git status --porcelain -uall");
        expect(status).toContain(" D old.txt");
        expect(status).toContain("?? staged.txt");
        expect(status).toContain("?? run.sh");
        expect(status).not.toContain("committed.txt");
        expect(await save(second)).toMatchObject({
          changes: [],
          work: saved.work,
        });
      },
      20 * MINUTES,
    );
  },
);
