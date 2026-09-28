import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findImageBuilderCommand,
  imageBuilderEnvironment,
} from "./image-builder-command.js";

const roots: string[] = [];
function directoryWith(...commands: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-builder-"));
  roots.push(root);
  for (const command of commands)
    fs.writeFileSync(path.join(root, command), "#!/bin/sh\n", { mode: 0o755 });
  return root;
}

describe("findImageBuilderCommand", () => {
  afterEach(() => {
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  });

  it("prefers Docker, then Podman, from PATH and the user's Docker folder", () => {
    const podman = directoryWith("podman");
    const docker = directoryWith("docker");
    const find = (env: NodeJS.ProcessEnv) =>
      findImageBuilderCommand({ env, knownDirectories: [] });
    expect(find({ PATH: `${podman}${path.delimiter}${docker}` })).toBe(
      path.join(docker, "docker"),
    );
    expect(find({ PATH: podman })).toBe(path.join(podman, "podman"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "image-builder-home-"));
    roots.push(home);
    fs.mkdirSync(path.join(home, ".docker", "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".docker", "bin", "docker"), "", {
      mode: 0o755,
    });
    expect(find({ PATH: "", HOME: home })).toBe(
      path.join(home, ".docker", "bin", "docker"),
    );
  });

  it("puts the CLI's folder on PATH and drops relative entries", () => {
    const env = imageBuilderEnvironment({
      command: "/Applications/Docker.app/Contents/Resources/bin/docker",
      env: { PATH: `.${path.delimiter}/usr/bin`, HOME: "/Users/ada" },
      knownDirectories: ["/usr/local/bin"],
    });
    expect(env.PATH?.split(path.delimiter)).toEqual([
      "/Applications/Docker.app/Contents/Resources/bin",
      "/usr/local/bin",
      "/Users/ada/.docker/bin",
      "/usr/bin",
    ]);
  });
});
