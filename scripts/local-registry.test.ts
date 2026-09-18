import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "local registry "));
  for (const directory of [
    "infra/local-registry",
    "node_modules/node/bin",
    "bin",
    "packages/app",
    "packages/parser",
    "packages/workflow",
  ])
    await mkdir(path.join(root, directory), { recursive: true });
  await cp(
    new URL("../infra/local-registry/publish.sh", import.meta.url),
    path.join(root, "infra/local-registry/publish.sh"),
  );
  const executable = async (name: string, content: string) => {
    const file = path.join(root, name);
    await writeFile(file, `#!/bin/sh\n${content}\n`);
    await chmod(file, 0o755);
  };
  await executable("node_modules/node/bin/node", "exit 0");
  await executable("bin/curl", "exit 0");
  await executable(
    "bin/bun",
    'printf "%s|%s\\n" "$PWD" "$*" >> "$COMMAND_LOG"\nif [ "$1" = publish ] && [ "$FAIL_PUBLISH" = 1 ]; then exit 1; fi',
  );
  return {
    root,
    run: (extra: Record<string, string> = {}) =>
      execFileSync("sh", [path.join(root, "infra/local-registry/publish.sh")], {
        cwd: tmpdir(),
        env: {
          ...process.env,
          PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
          COMMAND_LOG: path.join(root, "commands.log"),
          ...extra,
        },
        encoding: "utf8",
      }),
    log: () => readFile(path.join(root, "commands.log"), "utf8"),
  };
}

it("publishes from any cwd using the absolute registry config, including paths with spaces", async () => {
  const test = await fixture();
  try {
    test.run();
    const commands = await test.log();
    for (const name of ["app", "parser", "workflow"]) {
      expect(commands).toContain(`${test.root}/packages/${name}|run build`);
      expect(commands).toContain(
        `${test.root}/packages/${name}|publish --config=${test.root}/infra/local-registry/bunfig.toml`,
      );
    }
    expect(commands).not.toContain("tolerate-republish");
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});
it("fails instead of silently testing stale package versions", async () => {
  const test = await fixture();
  try {
    expect(() => test.run({ FAIL_PUBLISH: "1" })).toThrow();
    expect(await test.log()).not.toContain("packages/parser");
  } finally {
    await rm(test.root, { recursive: true, force: true });
  }
});
