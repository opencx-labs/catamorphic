import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The benchmark's speech and rooms, fetched once: LibriSpeech's
 * dev-clean-2 (CC BY 4.0, read English from 26 speakers) and DEMAND's
 * 16 kHz recordings of real rooms (CC BY-SA 3.0). Decoded with ffmpeg to
 * raw 16 kHz float32, outside the repository.
 */
export const DATA_DIR =
  process.env.CATAMORPHIC_VOICE_BENCHMARK_DIR ??
  path.join(os.homedir(), ".catamorphic", "voice-benchmark");

const LIBRISPEECH = "https://www.openslr.org/resources/31/dev-clean-2.tar.gz";
const DEMAND = "https://zenodo.org/records/1227121/files";
export const ROOMS = ["DLIVING", "OOFFICE", "PCAFETER", "TBUS"] as const;
export type Room = (typeof ROOMS)[number];

export interface Utterance {
  speaker: string;
  text: string;
  file: string;
  seconds: number;
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed`);
}

function decode(input: string, output: string) {
  if (fs.existsSync(output)) return;
  run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      input,
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      "16000",
      output,
    ],
    DATA_DIR,
  );
}

/** Downloads and decodes what is missing. */
export function fetchData(): void {
  const raw = path.join(DATA_DIR, "raw");
  const decoded = path.join(DATA_DIR, "decoded");
  fs.mkdirSync(raw, { recursive: true });
  fs.mkdirSync(decoded, { recursive: true });
  const libri = path.join(raw, "LibriSpeech", "dev-clean-2");
  if (!fs.existsSync(libri)) {
    run("curl", ["-sSfL", "-o", "dev-clean-2.tar.gz", LIBRISPEECH], raw);
    run("tar", ["-xzf", "dev-clean-2.tar.gz"], raw);
  }
  for (const room of ROOMS) {
    if (!fs.existsSync(path.join(raw, room))) {
      run(
        "curl",
        ["-sSfL", "-o", `${room}.zip`, `${DEMAND}/${room}_16k.zip?download=1`],
        raw,
      );
      run("unzip", ["-oq", `${room}.zip`], raw);
    }
    decode(
      path.join(raw, room, "ch01.wav"),
      path.join(decoded, `room-${room}.f32`),
    );
  }
  const index: Utterance[] = [];
  for (const speaker of fs.readdirSync(libri).sort()) {
    for (const chapter of fs.readdirSync(path.join(libri, speaker)).sort()) {
      const dir = path.join(libri, speaker, chapter);
      const lines = fs
        .readFileSync(path.join(dir, `${speaker}-${chapter}.trans.txt`), "utf8")
        .trim()
        .split("\n");
      for (const line of lines) {
        const [id = "", ...words] = line.split(" ");
        const file = path.join(decoded, `${id}.f32`);
        decode(path.join(dir, `${id}.flac`), file);
        index.push({
          speaker,
          text: words.join(" "),
          file,
          seconds: fs.statSync(file).size / 4 / 16_000,
        });
      }
    }
  }
  fs.writeFileSync(
    path.join(DATA_DIR, "utterances.json"),
    JSON.stringify(index),
  );
}

export function utterances(): Utterance[] {
  const file = path.join(DATA_DIR, "utterances.json");
  if (!fs.existsSync(file))
    throw new Error(
      "No benchmark data: run `bun apps/desktop/scripts/voice-benchmark/index.ts fetch` first.",
    );
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function samples(file: string): Float32Array {
  const bytes = fs.readFileSync(file);
  return new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / 4,
  ).slice();
}

export function room(name: Room): Float32Array {
  return samples(path.join(DATA_DIR, "decoded", `room-${name}.f32`));
}
