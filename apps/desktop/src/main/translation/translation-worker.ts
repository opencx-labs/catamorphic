import type {
  TranslationWorkerCommand,
  TranslationWorkerReply,
} from "../../shared/page-translation.js";
import { TranslationEngine } from "./engine.js";

/**
 * The translation worker (ADR 0320), an Electron utility process: a
 * translation takes a CPU core for as long as it runs, and a model tens of
 * megabytes, so neither stays in the main process. Commands run one at a
 * time, in order; main lets the worker go when pages stop asking.
 */
const engine = new TranslationEngine();
let queue = Promise.resolve();

const reply = (message: TranslationWorkerReply) =>
  process.parentPort.postMessage(message);

process.parentPort.on("message", ({ data }) => {
  const command = data as TranslationWorkerCommand;
  queue = queue.then(async () => {
    try {
      const value =
        command.type === "translate"
          ? await engine.translate(command.engine, command.steps, command.text)
          : await engine.detect(command.text);
      reply({ id: command.id, ok: true, value });
    } catch (error) {
      reply({
        id: command.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
});
