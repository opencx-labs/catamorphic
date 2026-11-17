import fs from "node:fs";
import vm from "node:vm";
import type {
  DetectedLanguage,
  TranslationStep,
} from "../../shared/page-translation.js";
import { detectedTag } from "./languages.js";
import glue from "./vendor/bergamot-translator.js?raw";

/** The part of the Bergamot module (Emscripten embind) Work calls. */
interface Deletable {
  delete(): void;
}
interface AlignedMemory extends Deletable {
  getByteArrayView(): Uint8Array;
}
interface Vector<T> extends Deletable {
  push_back(value: T): void;
  size(): number;
  get(index: number): T;
}
interface Response {
  getTranslatedText(): string;
}
interface Bergamot {
  AlignedMemory: new (bytes: number, alignment: number) => AlignedMemory;
  AlignedMemoryList: new () => Vector<AlignedMemory>;
  TranslationModel: new (
    from: string,
    to: string,
    config: string,
    model: AlignedMemory,
    lex: AlignedMemory | null,
    vocabularies: Vector<AlignedMemory>,
    quality: null,
  ) => Deletable;
  BlockingService: new (options: { cacheSize: number }) => BlockingService;
  VectorString: new () => Vector<string>;
  VectorResponseOptions: new () => Vector<{
    qualityScores: boolean;
    alignment: boolean;
    html: boolean;
  }>;
}
interface BlockingService {
  translate(
    model: Deletable,
    messages: Vector<string>,
    options: Vector<unknown>,
  ): Vector<Response>;
  translateViaPivoting(
    first: Deletable,
    second: Deletable,
    messages: Vector<string>,
    options: Vector<unknown>,
  ): Vector<Response>;
}

/** How each file sits in the engine's memory (Firefox's engine worker). */
const ALIGNMENT = {
  model: 256,
  lex: 64,
  vocab: 64,
  srcvocab: 64,
  trgvocab: 64,
};
/** Models kept loaded: a page's pair, a pivot's two, and one more. */
const LOADED_MODELS = 4;

/** Marian's options, as Firefox's engine worker sets them. */
function modelConfig(gemm: string): string {
  const options: Record<string, string> = {
    "beam-size": "1",
    normalize: "1.0",
    "word-penalty": "0",
    "max-length-break": "128",
    "mini-batch-words": "1024",
    workspace: "128",
    "max-length-factor": "2.0",
    "skip-cost": "true",
    "cpu-threads": "0",
    quiet: "true",
    "quiet-translation": "true",
    "gemm-precision": gemm,
    alignment: "soft",
  };
  // Marian reads this YAML only with this indentation.
  const indent = "            ";
  return `\n${Object.entries(options)
    .map(([key, value]) => `${indent}${key}: ${value}\n`)
    .join("")}${indent}`;
}

/**
 * Text as the pieces a translation keeps and the pieces it translates.
 * Each line is translated on its own, so line breaks and the space around
 * a line stay as the page wrote them.
 */
export function textPieces(text: string): {
  kept: string[];
  translated: string[];
} {
  const kept: string[] = [];
  const translated: string[] = [];
  let pending = "";
  for (const [index, part] of text.split(/(\r?\n)/).entries()) {
    if (index % 2 === 1) {
      pending += part;
      continue;
    }
    const match = /^(\s*)(.*?)(\s*)$/s.exec(part);
    const [, before = "", core = "", after = ""] = match ?? [];
    if (!core) {
      pending += part;
      continue;
    }
    kept.push(pending + before);
    translated.push(core);
    pending = after;
  }
  kept.push(pending);
  return { kept, translated };
}

/** The translated pieces put back between the kept ones. */
export function joinPieces(kept: string[], translated: string[]): string {
  return kept.reduce(
    (text, piece, index) => text + piece + (translated[index] ?? ""),
    "",
  );
}

/**
 * The Bergamot engine (Firefox's on-device translator, WebAssembly) and
 * Google's CLD3 detector, run in the translation worker (ADR 0320).
 */
export class TranslationEngine {
  private bergamot: { engine: string; module: Promise<Bergamot> } | null = null;
  private service: BlockingService | null = null;
  /** Loaded models by the files they were loaded from, oldest first. */
  private readonly models = new Map<string, Deletable>();
  private detector: Promise<{
    findLanguage(text: string): { language: string; probability: number };
  }> | null = null;

  async translate(
    engine: string,
    steps: TranslationStep[],
    text: string,
  ): Promise<string> {
    const { kept, translated } = textPieces(text);
    if (translated.length === 0) return text;
    const bergamot = await this.load(engine);
    const models = steps.map((step) => this.model(bergamot, step));
    this.service ??= new bergamot.BlockingService({ cacheSize: 0 });
    const service = this.service;
    const messages = new bergamot.VectorString();
    const options = new bergamot.VectorResponseOptions();
    try {
      for (const piece of translated) {
        messages.push_back(piece);
        options.push_back({
          qualityScores: false,
          alignment: false,
          html: false,
        });
      }
      const [first, second] = models;
      if (!first) throw new Error("A translation needs a model");
      const responses = second
        ? service.translateViaPivoting(first, second, messages, options)
        : service.translate(first, messages, options);
      try {
        const results = translated.map((_, index) =>
          responses.get(index).getTranslatedText(),
        );
        return joinPieces(kept, results);
      } finally {
        responses.delete();
      }
    } finally {
      messages.delete();
      options.delete();
    }
  }

  async detect(text: string): Promise<DetectedLanguage[]> {
    const unknown = [{ detectedLanguage: "und", confidence: 1 }];
    if (!text.trim()) return unknown;
    this.detector ??= import("cld3-asm").then(async ({ loadModule }) =>
      (await loadModule()).create(0, 4096),
    );
    const { language, probability } = (await this.detector).findLanguage(text);
    if (language === "und") return unknown;
    const confidence = Math.min(1, Math.max(0, probability));
    return [
      { detectedLanguage: detectedTag(language), confidence },
      ...(confidence < 1
        ? [{ detectedLanguage: "und", confidence: 1 - confidence }]
        : []),
    ];
  }

  private load(engine: string): Promise<Bergamot> {
    if (this.bergamot?.engine === engine) return this.bergamot.module;
    for (const model of this.models.values()) model.delete();
    this.models.clear();
    this.service = null;
    const module = loadBergamot(fs.readFileSync(engine));
    this.bergamot = { engine, module };
    module.catch(() => {
      if (this.bergamot?.module === module) this.bergamot = null;
    });
    return module;
  }

  private model(bergamot: Bergamot, step: TranslationStep): Deletable {
    const key = JSON.stringify(step);
    const loaded = this.models.get(key);
    if (loaded) {
      this.models.delete(key);
      this.models.set(key, loaded);
      return loaded;
    }
    const memory = (type: keyof typeof ALIGNMENT) => {
      const file = step.files[type];
      if (!file) return null;
      const bytes = fs.readFileSync(file);
      const aligned = new bergamot.AlignedMemory(
        bytes.byteLength,
        ALIGNMENT[type],
      );
      aligned.getByteArrayView().set(bytes);
      return aligned;
    };
    const model = memory("model");
    if (!model) throw new Error("A translation model is missing its weights");
    const vocabularies = new bergamot.AlignedMemoryList();
    for (const type of step.files.vocab
      ? (["vocab"] as const)
      : (["srcvocab", "trgvocab"] as const)) {
      const vocabulary = memory(type);
      if (!vocabulary)
        throw new Error("A translation model is missing its vocabulary");
      vocabularies.push_back(vocabulary);
    }
    const created = new bergamot.TranslationModel(
      step.sourceLanguage,
      step.targetLanguage,
      modelConfig(step.gemm),
      model,
      memory("lex"),
      vocabularies,
      null,
    );
    this.models.set(key, created);
    while (this.models.size > LOADED_MODELS) {
      const [oldest] = this.models;
      if (!oldest) break;
      this.models.delete(oldest[0]);
      oldest[1].delete();
    }
    return created;
  }
}

/**
 * Runs Firefox's glue in a context of its own: without `window`,
 * `importScripts` or `process` it takes the engine's bytes as given and
 * reads nothing else.
 */
function loadBergamot(wasmBinary: Uint8Array): Promise<Bergamot> {
  const context = vm.createContext(
    Object.fromEntries(
      [
        "console",
        "performance",
        "WebAssembly",
        "TextDecoder",
        "TextEncoder",
        "setTimeout",
        "clearTimeout",
      ].map((name) => [name, Reflect.get(globalThis, name)]),
    ),
  );
  vm.runInContext(`${glue}\nthis.loadBergamot = loadBergamot;`, context);
  const load: (module: object) => Bergamot = Reflect.get(
    context,
    "loadBergamot",
  );
  return new Promise((resolve, reject) => {
    const module = load({
      // Firefox's starting size: growing from small uses less than guessing.
      INITIAL_MEMORY: 41_943_040,
      print: () => {},
      printErr: () => {},
      wasmBinary,
      onAbort: () => reject(new Error("The translation engine failed to load")),
      onRuntimeInitialized: () => {
        // The module is fully assigned once `load` returns.
        queueMicrotask(() => resolve(module));
      },
    });
  });
}
