import {
  encodeLine,
  framePayload,
  type HarnessAdapter,
  parseCommandFrame,
  splitLines,
} from "@catamorphic/agent-protocol/runner";
import { AttemptRunner, errorMessage } from "./runner.js";

/**
 * The runner as a process (ADR 0197): commands arrive on standard input,
 * frames leave on standard output, each one marked so a sandbox's combined
 * output keeps them apart from anything a harness prints. Exits once its
 * attempt has exited and its frames are flushed.
 */
export async function runStdioRunner(input: {
  adapters: Readonly<Record<string, HarnessAdapter>>;
  version: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}): Promise<void> {
  const stdin: NodeJS.ReadableStream = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const runner = new AttemptRunner({
    adapters: input.adapters,
    version: input.version,
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
