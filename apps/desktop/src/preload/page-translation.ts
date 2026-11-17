import { contextBridge, ipcRenderer } from "electron";
import {
  TRANSLATION_CHANNELS,
  TRANSLATION_INPUT_QUOTA,
  type TranslationProgress,
  type TranslationTarget,
} from "../shared/page-translation.js";

/**
 * Chrome's Translator and Language Detector APIs (ADR 0320). Electron
 * exposes Blink's classes with no service behind them, so a page that
 * feature-detects them waits forever. Work installs its own in their
 * place, answered by main on the device; this isolated-world half carries
 * the calls, and reads the frame's user activation where the page cannot
 * redefine it.
 */
export function installPageTranslation(): void {
  contextBridge.exposeInMainWorld("__workTranslation", {
    availability: (target: TranslationTarget) =>
      ipcRenderer.invoke(TRANSLATION_CHANNELS.availability, target),
    create: (
      id: string,
      target: TranslationTarget,
      onProgress: (loaded: number) => void,
    ) => {
      const activated = navigator.userActivation?.isActive ?? false;
      const listener = (
        _event: Electron.IpcRendererEvent,
        progress: TranslationProgress,
      ) => {
        if (progress.id === id) onProgress(progress.loaded);
      };
      ipcRenderer.on(TRANSLATION_CHANNELS.progress, listener);
      return ipcRenderer
        .invoke(TRANSLATION_CHANNELS.create, { id, target, activated })
        .finally(() =>
          ipcRenderer.removeListener(TRANSLATION_CHANNELS.progress, listener),
        );
    },
    translate: (sourceLanguage: string, targetLanguage: string, text: string) =>
      ipcRenderer.invoke(TRANSLATION_CHANNELS.translate, {
        sourceLanguage,
        targetLanguage,
        text,
      }),
    detect: (text: string) =>
      ipcRenderer.invoke(TRANSLATION_CHANNELS.detect, { text }),
  });
  contextBridge.executeInMainWorld({
    func: pageTranslationApis,
    args: [TRANSLATION_INPUT_QUOTA],
  });
}

/**
 * The page's `Translator` and `LanguageDetector`, shaped as Chrome's. Runs
 * in the page's world, serialized: it closes over nothing.
 */
export function pageTranslationApis(quota: number): void {
  type Availability =
    | "unavailable"
    | "downloadable"
    | "downloading"
    | "available";
  type Target =
    | { kind: "translator"; sourceLanguage: string; targetLanguage: string }
    | { kind: "detector"; expectedInputLanguages: string[] };
  type Answer<T> =
    | { ok: true; value: T }
    | { ok: false; name: string; message: string };
  interface Detected {
    detectedLanguage: string;
    confidence: number;
  }
  interface Bridge {
    availability(target: Target): Promise<Answer<Availability>>;
    create(
      id: string,
      target: Target,
      onProgress: (loaded: number) => void,
    ): Promise<Answer<null>>;
    translate(
      sourceLanguage: string,
      targetLanguage: string,
      text: string,
    ): Promise<Answer<string>>;
    detect(text: string): Promise<Answer<Detected[]>>;
  }

  const exposed: Bridge | undefined = Reflect.get(window, "__workTranslation");
  if (!exposed) return;
  const bridge: Bridge = exposed;
  // Chrome offers both only to secure contexts.
  if (!window.isSecureContext) {
    Reflect.deleteProperty(window, "Translator");
    Reflect.deleteProperty(window, "LanguageDetector");
    return;
  }

  const answer = async <T>(call: Promise<Answer<T>>): Promise<T> => {
    const result = await call;
    if (result.ok) return result.value;
    throw new DOMException(result.message, result.name);
  };
  const failure = (method: string, owner: string, message: string) =>
    `Failed to execute '${method}' on '${owner}': ${message}`;
  /** A dictionary argument's members, read as WebIDL reads them. */
  const options = (
    value: unknown,
    method: string,
    owner: string,
  ): ((key: string) => unknown) => {
    if (value === undefined || value === null) return () => undefined;
    if (typeof value !== "object" && typeof value !== "function")
      throw new TypeError(
        failure(method, owner, "The provided value is not of type 'object'."),
      );
    return (key) => Reflect.get(value, key);
  };
  const signalOf = (member: (key: string) => unknown) => {
    const signal = member("signal");
    return signal instanceof AbortSignal ? signal : undefined;
  };
  const language = (
    value: unknown,
    field: string,
    method: string,
    owner: string,
    dictionary: string,
  ): string => {
    if (value === undefined)
      throw new TypeError(
        failure(
          method,
          owner,
          `Failed to read the '${field}' property from '${dictionary}': Required member is undefined.`,
        ),
      );
    // Intl's RangeError is Chrome's for a tag that is not BCP 47.
    const [canonical] = Intl.getCanonicalLocales(String(value));
    return canonical ?? String(value);
  };
  /** Rejects with the signal's reason once it aborts. */
  const guarded = <T>(
    signal: AbortSignal | undefined,
    destroyed: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> => {
    for (const source of [signal, destroyed])
      if (source?.aborted) return Promise.reject(source.reason);
    return new Promise<T>((resolve, reject) => {
      const abort = (event: Event) => {
        const source = event.target;
        if (source instanceof AbortSignal) reject(source.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      destroyed.addEventListener("abort", abort, { once: true });
      work()
        .then(resolve, reject)
        .finally(() => {
          signal?.removeEventListener("abort", abort);
          destroyed.removeEventListener("abort", abort);
        });
    });
  };
  const usage = (
    input: unknown,
    callOptions: unknown,
    method: string,
    owner: string,
    destroyed: AbortSignal,
  ) => {
    const signal = signalOf(options(callOptions, method, owner));
    return guarded(signal, destroyed, async () => String(input).length);
  };
  const quotaCheck = (text: string) => {
    if (text.length > quota)
      throw new DOMException("The input is too large.", "QuotaExceededError");
  };

  class CreateMonitor extends EventTarget {
    #handler: ((event: Event) => void) | null = null;
    get ondownloadprogress() {
      return this.#handler;
    }
    set ondownloadprogress(handler: ((event: Event) => void) | null) {
      if (this.#handler)
        this.removeEventListener("downloadprogress", this.#handler);
      this.#handler = typeof handler === "function" ? handler : null;
      if (this.#handler)
        this.addEventListener("downloadprogress", this.#handler);
    }
  }
  Object.defineProperty(CreateMonitor.prototype, Symbol.toStringTag, {
    value: "CreateMonitor",
  });

  /** Asks main to make a session ready, downloading its models if needed. */
  const prepare = (
    target: Target,
    member: (key: string) => unknown,
  ): Promise<null> => {
    const watch = member("monitor");
    const monitor = typeof watch === "function" ? new CreateMonitor() : null;
    if (typeof watch === "function") Reflect.apply(watch, undefined, [monitor]);
    const id = crypto.randomUUID();
    const never = new AbortController().signal;
    return guarded(signalOf(member), never, () =>
      answer(
        bridge.create(id, target, (loaded) => {
          monitor?.dispatchEvent(
            new ProgressEvent("downloadprogress", {
              loaded,
              total: 1,
              lengthComputable: true,
            }),
          );
        }),
      ),
    );
  };

  const secret = Symbol("work.translation");

  class Translator {
    #source: string;
    #target: string;
    #destroyed = new AbortController();

    constructor(token?: symbol, source = "", target = "") {
      if (token !== secret) throw new TypeError("Illegal constructor");
      this.#source = source;
      this.#target = target;
    }

    static #targetOf(value: unknown, method: string): Target {
      const member = options(value, method, "Translator");
      if (value === undefined || value === null)
        throw new TypeError(
          failure(
            method,
            "Translator",
            "1 argument required, but only 0 present.",
          ),
        );
      const dictionary =
        method === "create"
          ? "TranslatorCreateOptions"
          : "TranslatorCreateCoreOptions";
      return {
        kind: "translator",
        sourceLanguage: language(
          member("sourceLanguage"),
          "sourceLanguage",
          method,
          "Translator",
          dictionary,
        ),
        targetLanguage: language(
          member("targetLanguage"),
          "targetLanguage",
          method,
          "Translator",
          dictionary,
        ),
      };
    }

    static async availability(value: unknown): Promise<Availability> {
      return answer(
        bridge.availability(Translator.#targetOf(value, "availability")),
      );
    }

    static async create(value: unknown): Promise<Translator> {
      const target = Translator.#targetOf(value, "create");
      if (target.kind !== "translator") throw new TypeError("Illegal target");
      await prepare(target, options(value, "create", "Translator"));
      return new Translator(
        secret,
        target.sourceLanguage,
        target.targetLanguage,
      );
    }

    get sourceLanguage(): string {
      return this.#source;
    }

    get targetLanguage(): string {
      return this.#target;
    }

    get inputQuota(): number {
      return quota;
    }

    translate(input: unknown, callOptions?: unknown): Promise<string> {
      const signal = signalOf(options(callOptions, "translate", "Translator"));
      const text = String(input);
      return guarded(signal, this.#destroyed.signal, async () => {
        quotaCheck(text);
        return answer(bridge.translate(this.#source, this.#target, text));
      });
    }

    translateStreaming(
      input: unknown,
      callOptions?: unknown,
    ): ReadableStream<string> {
      const result = this.translate(input, callOptions);
      return new ReadableStream<string>({
        async start(controller) {
          try {
            controller.enqueue(await result);
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
    }

    measureInputUsage(input: unknown, callOptions?: unknown): Promise<number> {
      return usage(
        input,
        callOptions,
        "measureInputUsage",
        "Translator",
        this.#destroyed.signal,
      );
    }

    destroy(): void {
      if (!this.#destroyed.signal.aborted)
        this.#destroyed.abort(
          new DOMException("The translator has been destroyed.", "AbortError"),
        );
    }
  }
  Object.defineProperty(Translator.prototype, Symbol.toStringTag, {
    value: "Translator",
  });

  class LanguageDetector {
    #expected: readonly string[] | null;
    #destroyed = new AbortController();

    constructor(token?: symbol, expected: readonly string[] | null = null) {
      if (token !== secret) throw new TypeError("Illegal constructor");
      this.#expected = expected;
    }

    static #targetOf(value: unknown, method: string): Target {
      const expected = options(
        value,
        method,
        "LanguageDetector",
      )("expectedInputLanguages");
      const dictionary =
        method === "create"
          ? "LanguageDetectorCreateOptions"
          : "LanguageDetectorCreateCoreOptions";
      if (
        expected !== undefined &&
        (typeof expected !== "object" ||
          expected === null ||
          typeof Reflect.get(expected, Symbol.iterator) !== "function")
      )
        throw new TypeError(
          failure(
            method,
            "LanguageDetector",
            `Failed to read the 'expectedInputLanguages' property from '${dictionary}': The provided value cannot be converted to a sequence.`,
          ),
        );
      const tags = expected
        ? Array.from<unknown>(Object(expected)).map((tag) =>
            language(
              tag,
              "expectedInputLanguages",
              method,
              "LanguageDetector",
              dictionary,
            ),
          )
        : [];
      return { kind: "detector", expectedInputLanguages: tags };
    }

    static async availability(value?: unknown): Promise<Availability> {
      return answer(
        bridge.availability(LanguageDetector.#targetOf(value, "availability")),
      );
    }

    static async create(value?: unknown): Promise<LanguageDetector> {
      const target = LanguageDetector.#targetOf(value, "create");
      if (target.kind !== "detector") throw new TypeError("Illegal target");
      const member = options(value, "create", "LanguageDetector");
      await prepare(target, member);
      return new LanguageDetector(
        secret,
        member("expectedInputLanguages") === undefined
          ? null
          : Object.freeze([...target.expectedInputLanguages]),
      );
    }

    get expectedInputLanguages(): readonly string[] | null {
      return this.#expected;
    }

    get inputQuota(): number {
      return quota;
    }

    detect(input: unknown, callOptions?: unknown): Promise<Detected[]> {
      const signal = signalOf(
        options(callOptions, "detect", "LanguageDetector"),
      );
      const text = String(input);
      return guarded(signal, this.#destroyed.signal, async () => {
        quotaCheck(text);
        return answer(bridge.detect(text));
      });
    }

    measureInputUsage(input: unknown, callOptions?: unknown): Promise<number> {
      return usage(
        input,
        callOptions,
        "measureInputUsage",
        "LanguageDetector",
        this.#destroyed.signal,
      );
    }

    destroy(): void {
      if (!this.#destroyed.signal.aborted)
        this.#destroyed.abort(
          new DOMException(
            "The language detector has been destroyed.",
            "AbortError",
          ),
        );
    }
  }
  Object.defineProperty(LanguageDetector.prototype, Symbol.toStringTag, {
    value: "LanguageDetector",
  });

  // Interface objects are writable, configurable and not enumerable.
  for (const [name, value] of [
    ["Translator", Translator],
    ["LanguageDetector", LanguageDetector],
  ] as const)
    Object.defineProperty(window, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
}
