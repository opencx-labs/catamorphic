import { describe, expect, it } from "vitest";
import { joinPieces, TranslationEngine, textPieces } from "./engine.js";

describe("textPieces", () => {
  it("translates each line and keeps the space and breaks around it", () => {
    const text = "  Goedemorgen!\n\nIk heb een vraag.  \r\nDank u.\n";
    const { kept, translated } = textPieces(text);
    expect(translated).toEqual([
      "Goedemorgen!",
      "Ik heb een vraag.",
      "Dank u.",
    ]);
    expect(kept).toEqual(["  ", "\n\n", "  \r\n", "\n"]);
    expect(joinPieces(kept, translated)).toBe(text);
  });

  it("has nothing to translate in blank text", () => {
    expect(textPieces(" \n\t ")).toEqual({ kept: [" \n\t "], translated: [] });
  });
});

describe("TranslationEngine.detect", () => {
  const engine = new TranslationEngine();

  it("names the language with Google's CLD3, and the rest as unknown", async () => {
    const [first, rest] = await engine.detect(
      "Goedemorgen, hoe gaat het met u vandaag?",
    );
    expect(first?.detectedLanguage).toBe("nl");
    expect(first?.confidence).toBeGreaterThan(0.9);
    expect(rest?.detectedLanguage ?? "und").toBe("und");
  });

  it("reports BCP 47's tag for Hebrew", async () => {
    const [first] = await engine.detect("שלום, מה שלומך היום?");
    expect(first?.detectedLanguage).toBe("he");
  });

  it("knows no language in blank text", async () => {
    expect(await engine.detect("  ")).toEqual([
      { detectedLanguage: "und", confidence: 1 },
    ]);
  });

  it("leaves blank text untranslated without loading the engine", async () => {
    expect(await engine.translate("/missing.wasm", [], " \n ")).toBe(" \n ");
  });
});
