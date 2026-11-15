import path from "node:path";
import {
  type IpcMainInvokeEvent,
  ipcMain,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import { z } from "zod";
import {
  type DetectedLanguage,
  TRANSLATION_CHANNELS,
  TRANSLATION_INPUT_QUOTA,
  type TranslationAnswer,
  type TranslationAvailability,
  type TranslationProgress,
  type TranslationStep,
  type TranslationWorkerCommand,
  type TranslationWorkerReply,
} from "../../shared/page-translation.js";
import catalogJson from "./catalog.json";
import { detectorKnows, translationRoute } from "./languages.js";
import { type TranslationFile, TranslationFileStore } from "./models.js";

interface Catalog {
  engine: TranslationFile & { version: string };
  pairs: Record<
    string,
    {
      sourceLanguage: string;
      targetLanguage: string;
      version: string;
      gemm: string;
      files: Partial<Record<keyof TranslationStep["files"], TranslationFile>>;
    }
  >;
}

const catalog: Catalog = catalogJson;
const PAIRS: ReadonlySet<string> = new Set(Object.keys(catalog.pairs));
const FILE_TYPES = ["model", "lex", "vocab", "srcvocab", "trgvocab"] as const;
/** The worker is let go after this long without a request. */
const IDLE_MS = 5 * 60_000;

const tag = z.string().min(1).max(64);
const translatorInput = z.object({
  kind: z.literal("translator"),
  sourceLanguage: tag,
  targetLanguage: tag,
});
const detectorInput = z.object({
  kind: z.literal("detector"),
  expectedInputLanguages: z.array(tag).max(256),
});
const targetInput = z.discriminatedUnion("kind", [
  translatorInput,
  detectorInput,
]);
const createInput = z.object({
  id: z.string().min(1).max(128),
  target: targetInput,
  /** Whether the frame had transient user activation when it asked. */
  activated: z.boolean(),
});
const text = z.string().max(TRANSLATION_INPUT_QUOTA);
const translateInput = translatorInput.omit({ kind: true }).extend({ text });
const detectInput = z.object({ text });

const failure = (name: string, message: string) =>
  ({ ok: false, name, message }) as const;
const UNSUPPORTED = failure(
  "NotSupportedError",
  "Unable to create translator for the given source and target language.",
);

/**
 * Chrome's Translator and Language Detector APIs for web pages (ADR 0320).
 * Electron ships Blink's half of them with nothing behind it, so a page's
 * call never settles. The session preload installs Work's own in their
 * place; this answers them on the device: Firefox's Bergamot translator,
 * its models downloaded per language pair on first use from Mozilla,
 * pinned by SHA-256 in catalog.json, and Google's CLD3 detector, bundled.
 */
export function registerPageTranslation({
  userDataDir,
}: {
  userDataDir: string;
}): () => void {
  const store = new TranslationFileStore({
    rootDir: path.join(userDataDir, "translation-models"),
  });
  const worker = new TranslationWorker();

  const route = (sourceLanguage: string, targetLanguage: string) => {
    const pairs = translationRoute(sourceLanguage, targetLanguage, PAIRS);
    if (!pairs) return null;
    const steps: TranslationStep[] = [];
    const files: TranslationFile[] = [catalog.engine];
    for (const pair of pairs) {
      const entry = catalog.pairs[pair];
      if (!entry) return null;
      const located: TranslationStep["files"] = {};
      for (const type of FILE_TYPES) {
        const file = entry.files[type];
        if (!file) continue;
        located[type] = store.location(file);
        files.push(file);
      }
      steps.push({
        sourceLanguage: entry.sourceLanguage,
        targetLanguage: entry.targetLanguage,
        gemm: entry.gemm,
        files: located,
      });
    }
    return { steps, files };
  };

  const availability = (
    target: z.infer<typeof targetInput>,
  ): TranslationAvailability => {
    if (target.kind === "detector")
      return target.expectedInputLanguages.every(detectorKnows)
        ? "available"
        : "unavailable";
    const found = route(target.sourceLanguage, target.targetLanguage);
    if (!found) return "unavailable";
    if (found.files.every((file) => store.has(file))) return "available";
    return store.downloading(found.files) ? "downloading" : "downloadable";
  };

  ipcMain.handle(
    TRANSLATION_CHANNELS.availability,
    (_event, raw: unknown): TranslationAnswer<TranslationAvailability> => {
      const parsed = targetInput.safeParse(raw);
      return parsed.success
        ? { ok: true, value: availability(parsed.data) }
        : { ok: true, value: "unavailable" };
    },
  );

  ipcMain.handle(
    TRANSLATION_CHANNELS.create,
    async (
      event: IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<TranslationAnswer<null>> => {
      const parsed = createInput.safeParse(raw);
      if (!parsed.success) return UNSUPPORTED;
      const { id, target, activated } = parsed.data;
      const state = availability(target);
      if (state === "unavailable")
        return target.kind === "translator"
          ? UNSUPPORTED
          : failure(
              "NotSupportedError",
              "The language detector does not support the expected input languages.",
            );
      if (state === "available" || target.kind === "detector")
        return { ok: true, value: null };
      // Chrome downloads a model only for a page the person just used.
      if (!activated)
        return failure(
          "NotAllowedError",
          'Requires a user gesture when availability is "downloading" or "downloadable".',
        );
      const found = route(target.sourceLanguage, target.targetLanguage);
      if (!found) return UNSUPPORTED;
      const frame = event.senderFrame;
      try {
        await store.ensure(found.files, (loaded) => {
          if (frame && !frame.detached && !frame.isDestroyed())
            frame.send(TRANSLATION_CHANNELS.progress, {
              id,
              loaded,
            } satisfies TranslationProgress);
        });
      } catch (error) {
        console.warn("[translation] model download failed", error);
        return failure(
          "NetworkError",
          "Unable to download the translation model.",
        );
      }
      return { ok: true, value: null };
    },
  );

  ipcMain.handle(
    TRANSLATION_CHANNELS.translate,
    async (_event, raw: unknown): Promise<TranslationAnswer<string>> => {
      const parsed = translateInput.safeParse(raw);
      if (!parsed.success)
        return failure("NotSupportedError", "The input is not supported.");
      const found = route(
        parsed.data.sourceLanguage,
        parsed.data.targetLanguage,
      );
      if (!found) return UNSUPPORTED;
      // Only create() downloads, for a page the person just used.
      if (!found.files.every((file) => store.has(file)))
        return failure(
          "InvalidStateError",
          "The translation model is not available.",
        );
      try {
        const value = await worker.request({
          type: "translate",
          engine: store.location(catalog.engine),
          steps: found.steps,
          text: parsed.data.text,
        });
        return typeof value === "string"
          ? { ok: true, value }
          : failure("UnknownError", "Other generic failures occurred.");
      } catch (error) {
        console.warn("[translation] translate failed", error);
        return failure("UnknownError", "Other generic failures occurred.");
      }
    },
  );

  ipcMain.handle(
    TRANSLATION_CHANNELS.detect,
    async (
      _event,
      raw: unknown,
    ): Promise<TranslationAnswer<DetectedLanguage[]>> => {
      const parsed = detectInput.safeParse(raw);
      if (!parsed.success)
        return failure("NotSupportedError", "The input is not supported.");
      try {
        const value = await worker.request({
          type: "detect",
          text: parsed.data.text,
        });
        return Array.isArray(value)
          ? { ok: true, value }
          : failure("UnknownError", "Other generic failures occurred.");
      } catch (error) {
        console.warn("[translation] detect failed", error);
        return failure("UnknownError", "Other generic failures occurred.");
      }
    },
  );

  return () => {
    for (const channel of [
      TRANSLATION_CHANNELS.availability,
      TRANSLATION_CHANNELS.create,
      TRANSLATION_CHANNELS.translate,
      TRANSLATION_CHANNELS.detect,
    ])
      ipcMain.removeHandler(channel);
    worker.dispose();
  };
}

type WorkerRequest = TranslationWorkerCommand extends infer Command
  ? Command extends TranslationWorkerCommand
    ? Omit<Command, "id">
    : never
  : never;

/**
 * The translation worker, started on the first request and let go after a
 * quiet spell: a model's memory leaves with it, as WebAssembly memory
 * cannot shrink.
 */
class TranslationWorker {
  private process: UtilityProcess | null = null;
  private next = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: string | DetectedLanguage[]) => void;
      reject: (error: Error) => void;
    }
  >();
  private idle: NodeJS.Timeout | null = null;

  request(command: WorkerRequest): Promise<string | DetectedLanguage[]> {
    const id = this.next++;
    const worker = this.start();
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...command, id });
    });
  }

  dispose(): void {
    if (this.idle) clearTimeout(this.idle);
    this.process?.kill();
    this.process = null;
  }

  private start(): UtilityProcess {
    if (this.process) return this.process;
    const worker = utilityProcess.fork(
      path.join(import.meta.dirname, "translation-worker.js"),
      [],
      { serviceName: "Work Translation" },
    );
    worker.on("message", (reply: TranslationWorkerReply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(new Error(reply.message));
      if (this.pending.size === 0) this.rest();
    });
    worker.once("exit", () => {
      if (this.process === worker) this.process = null;
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        pending.reject(new Error("The translation worker stopped"));
      }
    });
    this.process = worker;
    return worker;
  }

  private rest(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.pending.size === 0) this.dispose();
    }, IDLE_MS);
    this.idle.unref();
  }
}
