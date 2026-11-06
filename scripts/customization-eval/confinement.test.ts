import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LocalProcessSandboxProvider } from "../../packages/local-process/src/index.js";
import { removeTestDirectory } from "../test-processes.js";
import {
  confinedAgentCommand,
  confinedWorkflowEnvironment,
  evalSeatbeltProfile,
} from "./confinement.js";

it("quotes paths in the read and write boundary without permitting the containing directory", () => {
  const profile = evalSeatbeltProfile({
    project: '/tmp/work "quoted"',
    profile: "/tmp/profile",
    auth: "/tmp/auth",
    executables: ["/tools/bun"],
  });
  expect(profile).toContain('(subpath "/tmp/work \\"quoted\\"")');
  expect(profile).not.toContain('(subpath "/tmp")');
  expect(profile).toContain("(deny file-read-data file-map-executable)");
});

it.skipIf(process.platform !== "darwin")(
  "the actual native boundary permits its project and blocks sibling files and writes",
  async () => {
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), "eval-boundary-")),
    );
    const project = path.join(directory, "project");
    const profile = path.join(directory, "profile");
    const auth = path.join(directory, "auth");
    await Promise.all([mkdir(project), mkdir(profile), mkdir(auth)]);
    const sibling = path.join(directory, "hidden-grader.txt");
    await writeFile(sibling, "hidden grade data");
    await writeFile(path.join(project, "input.txt"), "project data");
    try {
      const command = await confinedAgentCommand({
        command: process.execPath,
        bun: process.execPath,
        project,
        profile,
        auth,
      });
      const result = await promisify(execFile)(
        command,
        [
          "-e",
          `const fs=require('node:fs');let read=false,write=false;try{fs.readFileSync(${JSON.stringify(sibling)})}catch{read=true}try{fs.writeFileSync(${JSON.stringify(sibling)},'changed')}catch{write=true}console.log(JSON.stringify({project:fs.readFileSync('input.txt','utf8'),read,write}))`,
        ],
        { cwd: project },
      );
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        project: "project data",
        read: true,
        write: true,
      });
      expect(await readFile(sibling, "utf8")).toBe("hidden grade data");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it
  .skipIf(process.platform !== "darwin")
  .each(["unsafe-link", "validator-startup"])(
  "%s cannot redirect the provider's package restoration write",
  async (failure) => {
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), "eval-install-restore-")),
    );
    const sandboxRoot = path.join(directory, "sandboxes");
    const external = path.join(directory, "hidden-grader");
    await mkdir(external);
    const sentinel = path.join(external, "package.json");
    await writeFile(sentinel, '{"name":"untouched-grader"}');
    const bun = (
      await promisify(execFile)("bun", ["-p", "process.execPath"])
    ).stdout.trim();
    const provider = new LocalProcessSandboxProvider({
      root: sandboxRoot,
      env: await confinedWorkflowEnvironment({ directory, sandboxRoot, bun }),
    });
    const sandbox = await provider.createSandbox({});
    try {
      await provider.uploadFiles(
        sandbox.id,
        {
          ".work/package.json": JSON.stringify({
            name: "hostile-dependency",
            private: true,
            dependencies: { hostile: `link:${external}` },
          }),
          ".work/workflows/package.json": "{}",
        },
        "/workspace/project",
      );
      const manifest = path.join(
        sandboxRoot,
        sandbox.id,
        "workspace/project/.work/workflows/package.json",
      );
      // This is exactly the target the ordinary materializer restores before
      // checking install.exitCode. Treat it as an installer-left unsafe link.
      await unlink(manifest);
      await symlink(sentinel, manifest);
      if (failure === "validator-startup") {
        const validator = path.join(
          directory,
          "workflow-launcher/validate-install.mjs",
        );
        await chmod(validator, 0o600);
        await writeFile(validator, 'throw new Error("validator unavailable");');
        await chmod(validator, 0o400);
      }
      const install = await provider.executeCommand(
        sandbox.id,
        "bun install --no-save",
        { cwd: "/workspace/project/.work", timeout: 10 },
      );
      expect(install.exitCode).not.toBe(0);
      await provider.uploadFiles(
        sandbox.id,
        { ".work/workflows/package.json": '{"name":"restored"}' },
        "/workspace/project",
      );
      expect(await readFile(sentinel, "utf8")).toBe(
        '{"name":"untouched-grader"}',
      );
      expect(await readFile(manifest, "utf8")).toBe('{"name":"restored"}');
      expect(install.result).toMatch(
        /Unsafe install links|Invalid install|validator unavailable/,
      );
    } finally {
      await provider.destroySandbox(sandbox.id);
      await removeTestDirectory(directory);
    }
  },
);

import { execFile } from "node:child_process";

it.skipIf(process.platform !== "darwin")(
  "workflow launch rejects forged homes and outside canonical working directories",
  async () => {
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), "eval-workflow-boundary-")),
    );
    const sandboxRoot = path.join(directory, "sandboxes");
    const sandbox = path.join(sandboxRoot, "local-01234567-89a");
    const home = path.join(sandbox, "home");
    const workspace = path.join(sandbox, "workspace");
    const outside = path.join(directory, "outside");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(outside),
    ]);
    try {
      const bun = (
        await promisify(execFile)("bun", ["-p", "process.execPath"])
      ).stdout.trim();
      const env = await confinedWorkflowEnvironment({
        directory,
        sandboxRoot,
        bun,
      });
      const command = path.join(directory, "workflow-launcher", "bun");
      const launch = (cwd: string, selectedHome: string) =>
        promisify(execFile)(command, ["-e", 'console.log("confined")'], {
          cwd,
          env: { ...env, HOME: selectedHome },
          timeout: 5_000,
        });
      expect((await launch(workspace, home)).stdout.trim()).toBe("confined");
      await expect(launch(outside, home)).rejects.toThrow("Invalid workflow");
      await expect(launch(workspace, outside)).rejects.toThrow(
        "Invalid workflow",
      );
      const link = path.join(workspace, "escape");
      await symlink(outside, link, "dir");
      await expect(launch(link, home)).rejects.toThrow("Invalid workflow");
      for (const file of [
        path.dirname(command),
        command,
        path.join(path.dirname(command), "workflow.sb"),
      ])
        expect((await stat(file)).mode & 0o222).toBe(0);
    } finally {
      await removeTestDirectory(directory);
    }
  },
);
