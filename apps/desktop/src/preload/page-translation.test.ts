import { describe, expect, it, vi } from "vitest";
import { pageTranslationApis } from "./page-translation.js";

type Answer<T> =
  | { ok: true; value: T }
  | { ok: false; name: string; message: string };

class FakeProgressEvent extends Event {
  readonly loaded: number;
  readonly total: number;
  constructor(type: string, init: { loaded: number; total: number }) {
    super(type);
    this.loaded = init.loaded;
    this.total = init.total;
  }
}

function fakeBridge(overrides: Record<string, unknown> = {}) {
  return {
    availability: vi.fn(
      async (): Promise<Answer<string>> => ({ ok: true, value: "available" }),
    ),
    create: vi.fn(
      async (
        _id: string,
        _target: unknown,
        onProgress: (loaded: number) => void,
      ): Promise<Answer<null>> => {
        onProgress(0);
        onProgress(0.5);
        onProgress(1);
        return { ok: true, value: null };
      },
    ),
    translate: vi.fn(
      async (
        _from: string,
        _to: string,
        text: string,
      ): Promise<Answer<string>> => ({ ok: true, value: `[${text}]` }),
    ),
    detect: vi.fn(
      async (): Promise<
        Answer<{ detectedLanguage: string; confidence: number }[]>
      > => ({ ok: true, value: [{ detectedLanguage: "nl", confidence: 1 }] }),
    ),
    ...overrides,
  };
}

/**
 * Run the function the way `executeInMainWorld` does: from its source, as a
 * script of its own, so a reference outside its body fails here as it would
 * in a page. The page's window is a parameter.
 */
function installInPage(
  bridge: ReturnType<typeof fakeBridge>,
  { secure = true }: { secure?: boolean } = {},
) {
  const window: Record<string, unknown> = {
    isSecureContext: secure,
    __workTranslation: bridge,
    Translator: "Blink's",
    LanguageDetector: "Blink's",
  };
  new Function(
    "window",
    "ProgressEvent",
    `(${pageTranslationApis.toString()})(100)`,
  )(window, FakeProgressEvent);
  return window as {
    Translator: {
      availability(options?: unknown): Promise<string>;
      create(options?: unknown): Promise<{
        sourceLanguage: string;
        targetLanguage: string;
        inputQuota: number;
        translate(text: unknown, options?: unknown): Promise<string>;
        translateStreaming(text: unknown): ReadableStream<string>;
        measureInputUsage(text: unknown): Promise<number>;
        destroy(): void;
      }>;
      new (): unknown;
    };
    LanguageDetector: {
      availability(options?: unknown): Promise<string>;
      create(options?: unknown): Promise<{
        expectedInputLanguages: readonly string[] | null;
        detect(text: unknown): Promise<unknown>;
      }>;
    };
  };
}

describe("page Translator", () => {
  it("replaces Blink's classes and asks main with canonical tags", async () => {
    const bridge = fakeBridge();
    const { Translator } = installInPage(bridge);
    expect(typeof Translator).toBe("function");
    expect(
      await Translator.availability({
        sourceLanguage: "NL",
        targetLanguage: "en-us",
      }),
    ).toBe("available");
    expect(bridge.availability).toHaveBeenCalledWith({
      kind: "translator",
      sourceLanguage: "nl",
      targetLanguage: "en-US",
    });
    expect(() => new Translator()).toThrow("Illegal constructor");
  });

  it("throws Chrome's errors for missing and malformed languages", async () => {
    const { Translator } = installInPage(fakeBridge());
    await expect(
      Translator.availability({ targetLanguage: "en" }),
    ).rejects.toThrow(
      "Failed to read the 'sourceLanguage' property from 'TranslatorCreateCoreOptions': Required member is undefined.",
    );
    await expect(
      Translator.availability({
        sourceLanguage: "en_US!",
        targetLanguage: "fr",
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(Translator.availability()).rejects.toBeInstanceOf(TypeError);
  });

  it("reports download progress to the monitor and translates", async () => {
    const bridge = fakeBridge();
    const { Translator } = installInPage(bridge);
    const loaded: number[] = [];
    const translator = await Translator.create({
      sourceLanguage: "nl",
      targetLanguage: "en",
      monitor(monitor: EventTarget & { ondownloadprogress: unknown }) {
        monitor.ondownloadprogress = (event: FakeProgressEvent) =>
          loaded.push(event.loaded);
      },
    });
    expect(loaded).toEqual([0, 0.5, 1]);
    expect([translator.sourceLanguage, translator.targetLanguage]).toEqual([
      "nl",
      "en",
    ]);
    expect(await translator.translate("Hallo")).toBe("[Hallo]");
    expect(bridge.translate).toHaveBeenCalledWith("nl", "en", "Hallo");
    const chunks: string[] = [];
    const reader = translator.translateStreaming("Dag").getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read())
      chunks.push(read.value);
    expect(chunks).toEqual(["[Dag]"]);
    expect(await translator.measureInputUsage("Hallo")).toBe(5);
    expect(translator.inputQuota).toBe(100);
  });

  it("rejects as main answers, as the page's signal says, and once destroyed", async () => {
    const bridge = fakeBridge({
      create: vi.fn(async () => ({
        ok: false,
        name: "NotAllowedError",
        message: "Requires a user gesture",
      })),
    });
    const { Translator } = installInPage(bridge);
    const refused = await Translator.create({
      sourceLanguage: "nl",
      targetLanguage: "en",
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DOMException);
    expect((refused as DOMException).name).toBe("NotAllowedError");
    await expect(
      Translator.create({
        sourceLanguage: "nl",
        targetLanguage: "en",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const translator = await installInPage(fakeBridge()).Translator.create({
      sourceLanguage: "nl",
      targetLanguage: "en",
    });
    const controller = new AbortController();
    const pending = translator.translate("Hallo", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(translator.translate("x".repeat(101))).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
    translator.destroy();
    await expect(translator.translate("Hallo")).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("page LanguageDetector", () => {
  it("detects, and keeps the languages the page expects", async () => {
    const bridge = fakeBridge();
    const { LanguageDetector } = installInPage(bridge);
    const detector = await LanguageDetector.create({
      expectedInputLanguages: ["NL", "en"],
    });
    expect(detector.expectedInputLanguages).toEqual(["nl", "en"]);
    expect(Object.isFrozen(detector.expectedInputLanguages)).toBe(true);
    expect(bridge.create.mock.calls[0]?.[1]).toEqual({
      kind: "detector",
      expectedInputLanguages: ["nl", "en"],
    });
    expect(await detector.detect("Hallo")).toEqual([
      { detectedLanguage: "nl", confidence: 1 },
    ]);
    expect((await LanguageDetector.create()).expectedInputLanguages).toBeNull();
    await expect(
      LanguageDetector.availability({ expectedInputLanguages: "nl" }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("outside a secure context", () => {
  it("offers neither, as Chrome does", () => {
    const window = installInPage(fakeBridge(), { secure: false });
    expect("Translator" in window).toBe(false);
    expect("LanguageDetector" in window).toBe(false);
  });
});
