import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { voiceModelPaths } from "../src/main/voice/models.js";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Voice on the real speech models (ADR 0215): the app's own
 * voice records a spoken request, the synthetic microphone plays it, and the app must
 * hear it with Silero and Parakeet, send it to the assistant, and speak
 * the answer with Kokoro. Opt-in: set CATAMORPHIC_VOICE_MODELS_DIR to an
 * installed models directory (the desktop test runner mounts it).
 */
const MODELS = process.env.CATAMORPHIC_VOICE_MODELS_DIR;
const REQUEST = "Start a session that checks the build.";

let app: AppHandle;
let recording: string;

/** 16-bit mono PCM WAV, which Chromium's file-backed microphone reads. */
function writeWav(file: string, samples: Float32Array, sampleRate: number) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    data.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, sample)) * 32767),
      index * 2,
    );
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

async function recordRequest(modelsDir: string): Promise<string> {
  // Loaded only when the suite runs: a skipped suite never needs the addon.
  const { loadSherpaSpeech } = await import(
    "../src/main/voice/sherpa-speech.js"
  );
  const speech = await loadSherpaSpeech(
    voiceModelPaths(modelsDir),
    "am_michael",
  );
  const { samples, sampleRate } = await speech.synthesize(REQUEST);
  // A second of quiet before, three after, so speech has a clear end.
  const padded = new Float32Array(samples.length + sampleRate * 4);
  padded.set(samples, sampleRate);
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "voice-request-")),
    "request.wav",
  );
  writeWav(file, padded, sampleRate);
  return file;
}

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent?.includes(text));
  const mic = () => $('[data-testid="voice-button"]');
  const api = window.catamorphicDesktop;
  const session = async (ref) => {
    const { url } = await api.getServerState();
    const response = await fetch(url + '/api/projects/' + ref.projectId + '/agent/sessions/' + ref.sessionId);
    const body = await response.json();
    // A chat's transcript is its snapshot's message items (ADR 0197).
    if (body?.snapshot)
      body.messages = [...body.snapshot.items]
        .filter((item) => item.kind === 'user_message' || item.kind === 'assistant_message')
        .sort((a, b) => a.position - b.position)
        .map((item) => ({
          role: item.kind === 'user_message' ? 'user' : 'assistant',
          content: item.text,
        }));
    return body;
  };
  ${setReactValueJs}
`;

const run = <T = unknown>(body: string) =>
  app.eval<T>(`(async () => { ${helpers}\n${body} })()`);
const runWait = <T = unknown>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(async () => { ${helpers}\n${body} })()`, opts);

describe.skipIf(!MODELS)("voice agent on the real speech models", () => {
  beforeAll(async () => {
    recording = await recordRequest(MODELS ?? "");
    app = await launchApp({ fakeAudioCapture: recording });
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
    if (recording) fs.rmSync(path.dirname(recording), { recursive: true });
  });

  it("hears a spoken request and speaks the answer", async () => {
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false; setReactValue(input, 'voice-models-e2e'); return true;`,
      { label: "project name input" },
    );
    await runWait(
      `const create = $('[data-testid="project-submit"]');
       if (!create || create.disabled) return false; create.click(); return true;`,
      { label: "create project" },
    );
    await runWait(`return mic()?.dataset.phase === 'off';`, {
      timeoutMs: 60_000,
      label: "microphone in the dock",
    });
    await run(`
      window.__voicePhases = [];
      new MutationObserver(() => {
        const phase = mic()?.dataset.phase;
        if (phase && window.__voicePhases.at(-1) !== phase) window.__voicePhases.push(phase);
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-phase'] });
      mic().click();
      return true;
    `);
    const ref = await runWait<{ projectId: string; sessionId: string }>(
      `const status = await api.voiceStatus();
       if (status.phase === 'off' && status.error) throw new Error(status.error);
       const prefs = await api.getPrefs();
       return status.phase !== 'off' && status.phase !== 'preparing' && prefs.assistantSession;`,
      { timeoutMs: 60_000, label: "the models loaded and voice listening" },
    );
    const heard = await runWait<string>(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.messages?.find((m) => m.role === 'user')?.content;`,
      {
        timeoutMs: 60_000,
        label: "the spoken request in the assistant's chat",
      },
    );
    expect(heard.toLowerCase()).toContain(
      "start a session that checks the build",
    );
    await runWait(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.messages.some((m) => m.role === 'assistant' && m.content.startsWith('You said:'));`,
      { timeoutMs: 60_000, label: "the answer in the assistant's chat" },
    );
    await runWait(
      `const phases = window.__voicePhases;
       return phases.includes('speaking') && phases.at(-1) === 'listening';`,
      { timeoutMs: 60_000, label: "the answer spoken, then listening again" },
    );
    await run(`mic().click(); return true;`);
    await runWait(`return mic().dataset.phase === 'off';`, {
      label: "microphone off",
    });
  }, 300_000);
});
