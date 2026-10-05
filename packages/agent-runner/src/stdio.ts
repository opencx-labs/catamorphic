import { readFileSync } from "node:fs";
import {
  encodeLine,
  framePayload,
  type HarnessAdapter,
  parseCommandFrame,
  parseEnvFile,
  splitLines,
} from "@catamorphic/agent-protocol/runner";
import {
  AttemptRunner,
  type AttemptRunnerOptions,
  errorMessage,
} from "./runner.js";

/**
 * The variables in an environment file on this machine (ADR 0205), or
 * undefined when there is none. Any other failure to read it fails the
 * attempt: running without the variables would hide the problem.
 */
export function readEnvFile(path: string): Record<string, string> | undefined {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return undefined;
    throw error;
  }
}

/**
 * The runner as a process (ADR 0198): commands arrive on standard input,
 * frames leave on standard output, each one marked so a sandbox's combined
 * output keeps them apart from anything a harness prints. Exits once its
 * attempt has exited and its frames are flushed.
 */
export async function runStdioRunner(input: {
  adapters: Readonly<Record<string, HarnessAdapter>>;
  version: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** Reads an attempt's environment file; {@link readEnvFile} by default. */
  envFile?: AttemptRunnerOptions["envFile"];
}): Promise<void> {
  const stdin: NodeJS.ReadableStream = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const runner = new AttemptRunner({
    adapters: input.adapters,
    version: input.version,
    envFile: input.envFile ?? readEnvFile,
    write: (frame) => {
      stdout.write(encodeLine(frame));
    },
  });
  // A long command (a large host result) arrives over many chunks: its
  // pieces are kept until its newline, not rescanned with every chunk.
  let pieces: string[] = [];
  stdin.setEncoding?.("utf8");
  stdin.on("data", (chunk: string | Buffer) => {
    const text = chunk.toString();
    if (!text.includes("\n")) {
      pieces.push(text);
      return;
    }
    const split = splitLines(pieces.join("") + text);
    pieces = split.rest ? [split.rest] : [];
    for (const line of split.lines) {
      const payload = framePayload(line);
      if (payload === undefined) continue;
      try {
        runner.handle(parseCommandFrame(payload));
      } catch (error) {
        process.stderr.write(`agent-runner: ${errorMessage(error)}\n`);
      }
    }
  });
  // A host that went away for good closes nothing: input stays open while
  // the sandbox lives, so a replica that takes over can keep writing.
  await runner.done;
  await new Promise<void>((resolve) => {
    if (stdout.write("")) resolve();
    else stdout.once("drain", () => resolve());
  });
}
