import path from "node:path";
import {
  checkCustomization,
  previewCustomization,
} from "./customization-check.js";

/** Installed authoring command. Preview never grants itself declared access. */
export async function customizationCommand(args: string[]) {
  const [operation, ...flags] = args;
  const option = (name: string) => {
    const index = flags.indexOf(`--${name}`);
    return index < 0 ? undefined : flags[index + 1];
  };
  const projectRoot = path.resolve(option("project") ?? process.cwd());
  const sourcePath = option("source");
  const workspacePath = option("workspace");
  const directory = path.dirname(process.argv[1] ?? import.meta.filename);
  if (operation === "check")
    return checkCustomization({
      projectRoot,
      sourcePath,
      workspacePath,
      sdkRoot: option("sdk") ?? directory,
      bunPath: process.execPath,
      kind: option("kind") === "workflow" ? "workflow" : "source",
    });
  if (operation === "preview" && sourcePath)
    return previewCustomization({
      projectRoot,
      sourcePath,
      workerPath: path.join(directory, "source-worker.mjs"),
      scratchRoot: path.join(directory, "scratch"),
      toolchain: {
        PATH: process.env.PATH ?? "",
        CATAMORPHIC_BUN: process.execPath,
      },
    });
  throw new Error(
    "Use check --source <file> [--workspace <workspace.js>] or preview --source <file>; --project selects the project.",
  );
}

if (import.meta.main) {
  try {
    const result = await customizationCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (cause) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) })}\n`,
    );
    process.exitCode = 1;
  }
}
