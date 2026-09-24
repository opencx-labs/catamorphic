import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveCodexModel } from "../models.js";

it("reads the model a thread in this folder would run from the pinned CLI's config layers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-model-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "checkout");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(home, "config.toml"), 'model = "fixture-model"\n');
  const executable = path.join(
    path.dirname(
      createRequire(import.meta.resolve("@openai/codex-sdk")).resolve(
        "@openai/codex/package.json",
      ),
    ),
    "bin/codex.js",
  );
  try {
    const model = await resolveCodexModel({
      executable,
      workingDirectory: cwd,
      env: {
        CODEX_HOME: home,
        OPENAI_API_KEY: "",
        CODEX_API_KEY: "",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
      },
    });
    expect(model?.id).toBe("fixture-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
