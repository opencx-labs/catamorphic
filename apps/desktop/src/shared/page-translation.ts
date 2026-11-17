/**
 * Chrome's Translator and Language Detector APIs for web pages (ADR 0320):
 * what a page's frame asks main, and what main asks the translation worker.
 */

export const TRANSLATION_CHANNELS = {
  availability: "catamorphic:translation-availability",
  create: "catamorphic:translation-create",
  progress: "catamorphic:translation-progress",
  translate: "catamorphic:translation-translate",
  detect: "catamorphic:translation-detect",
} as const;

/** Chrome's `Availability` enum. */
export type TranslationAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export type TranslationTarget =
  | { kind: "translator"; sourceLanguage: string; targetLanguage: string }
  | { kind: "detector"; expectedInputLanguages: string[] };

/** Chrome's `LanguageDetectionResult`. */
export interface DetectedLanguage {
  detectedLanguage: string;
  confidence: number;
}

/**
 * How main answers a page: a value, or the DOMException the page throws
 * (its name and Chrome's message).
 */
export type TranslationAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; name: string; message: string };

export interface TranslationProgress {
  id: string;
  /** The share of the download received, from 0 to 1. */
  loaded: number;
}

/** The longest text one call takes, in UTF-16 code units. */
export const TRANSLATION_INPUT_QUOTA = 1_000_000;

/** One model a translation runs through, as files on disk. */
export interface TranslationStep {
  sourceLanguage: string;
  targetLanguage: string;
  gemm: string;
  files: Partial<
    Record<"model" | "lex" | "vocab" | "srcvocab" | "trgvocab", string>
  >;
}

export type TranslationWorkerCommand =
  | {
      id: number;
      type: "translate";
      engine: string;
      steps: TranslationStep[];
      text: string;
    }
  | { id: number; type: "detect"; text: string };

export type TranslationWorkerReply =
  | { id: number; ok: true; value: string | DetectedLanguage[] }
  | { id: number; ok: false; message: string };
