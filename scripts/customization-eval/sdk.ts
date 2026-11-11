import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A subprocess with a deadline; timeout terminates and joins the command. */
export async function command(input: {
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<CommandResult> {
  const child = Bun.spawn(input.args, {
    cwd: input.cwd,
    env: input.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: input.timeoutMs ?? 120_000,
    killSignal: "SIGKILL",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Pack the built public packages and install them just like a released SDK. */
export async function installSdk(input: {
  repository: string;
  project: string;
  directory: string;
}): Promise<Array<{ name: string; version: string; sha256: string }>> {
  const artifacts = path.join(input.directory, "sdk");
  await mkdir(artifacts, { recursive: true });
  await mkdir(input.project, { recursive: true });
  const installed = new Map<
    string,
    { version: string; file: string; sha256: string }
  >();
  const pending = ["@catamorphic/work-customization", "@catamorphic/workflow"];
  while (pending.length) {
    const name = pending.pop();
    if (!name || installed.has(name)) continue;
    const folder = path.join(
      input.repository,
      "packages",
      name.slice("@catamorphic/".length),
    );
    const manifest = JSON.parse(
      await readFile(path.join(folder, "package.json"), "utf8"),
    );
    await readFile(path.join(folder, "dist", "index.d.ts"));
    const result = await command({
      args: [process.execPath, "pm", "pack", "--destination", artifacts],
      cwd: folder,
    });
    if (result.code !== 0)
      throw new Error(`Packing ${name} failed: ${result.stderr}`);
    const file = path.join(
      artifacts,
      `${name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`,
    );
    const sha256 = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    installed.set(name, { version: String(manifest.version), file, sha256 });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      if (dependency.startsWith("@catamorphic/")) pending.push(dependency);
  }
  const dependencies = Object.fromEntries(
    [...installed].map(([name, item]) => [
      name,
      `file:${path.relative(input.project, item.file)}`,
    ]),
  );
  await writeFile(
    path.join(input.project, "package.json"),
    `${JSON.stringify(
      {
        name: "customization-eval-project",
        private: true,
        type: "module",
        scripts: { check: "bun check --noEmit" },
        dependencies,
        devDependencies: { "@types/bun": "1.4.4", typescript: "^7.0.2" },
        overrides: dependencies,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(input.project, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowJs: true,
          checkJs: true,
          types: ["bun"],
        },
        include: ["**/*.ts", ".work/**/*.ts"],
        exclude: ["node_modules"],
      },
      null,
      2,
    )}\n`,
  );
  const install = await command({
    args: [process.execPath, "install", "--ignore-scripts"],
    cwd: input.project,
  });
  await writeFile(
    path.join(input.directory, "install.log"),
    `${install.stdout}\n${install.stderr}`,
  );
  if (install.code !== 0)
    throw new Error(
      `Installing the SDK failed; see ${path.join(input.directory, "install.log")}`,
    );
  return [...installed].map(([name, item]) => ({
    name,
    version: item.version,
    sha256: item.sha256,
  }));
}

export async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => !["node_modules", ".git"].includes(entry.name))
      .map(async (entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory()
          ? sourceFiles(file)
          : entry.isFile()
            ? [file]
            : [];
      }),
  );
  return files.flat();
}

/** Self-contained worker, using the same source and bundling options as desktop releases. */
export async function stageSourceWorker(input: {
  repository: string;
  directory: string;
}): Promise<{ file: string; sha256: string }> {
  const built = await Bun.build({
    entrypoints: [
      path.join(
        input.repository,
        "apps/desktop/src/main/sidebar-source-worker.ts",
      ),
    ],
    target: "bun",
    packages: "bundle",
    external: ["electron"],
  });
  const artifact = built.outputs[0];
  if (!built.success || !artifact)
    throw new AggregateError(
      built.logs,
      "Could not bundle the installed source worker",
    );
  const source = await artifact.text();
  const folder = path.join(input.directory, "profile", "runtime");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, "sidebar-source-worker.mjs");
  await writeFile(file, source);
  return { file, sha256: createHash("sha256").update(source).digest("hex") };
}
