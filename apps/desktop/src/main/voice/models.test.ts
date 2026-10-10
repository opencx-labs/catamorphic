import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VoiceModelPaths } from "../../shared/voice.js";
import { type VoiceModelArtifact, VoiceModelStore } from "./models.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-models-"));
  roots.push(root);
  const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "model-dir"), { recursive: true });
  await fs.writeFile(path.join(source, "model-dir", "model.onnx"), "weights");
  const archive = path.join(root, "model-dir.tar.bz2");
  execFileSync("tar", ["-cjf", archive, "-C", source, "model-dir"]);
  const file = Buffer.from("vad-weights");
  const archiveBytes = await fs.readFile(archive);
  const sha256 = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  const artifacts: VoiceModelArtifact[] = [
    {
      id: "vad",
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/vad.onnx",
      sha256: sha256(file),
      bytes: file.byteLength,
    },
    {
      id: "model-dir",
      unpack: true,
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/model-dir.tar.bz2",
      sha256: sha256(archiveBytes),
      bytes: archiveBytes.byteLength,
    },
  ];
  const bodies = new Map(
    artifacts.map((artifact, index) => [
      artifact.url,
      index === 0 ? file : archiveBytes,
    ]),
  );
  return {
    installRoot: path.join(root, "installed"),
    artifacts,
    fetchImpl: async (url: string | URL | Request) =>
      new Response(bodies.get(String(url)) ?? null, {
        status: bodies.has(String(url)) ? 200 : 404,
      }),
  };
}

const PATHS = (root: string): VoiceModelPaths => ({
  vad: path.join(root, "vad", "vad.onnx"),
  denoiser: "",
  speaker: "",
  asr: { encoder: "", decoder: "", joiner: "", tokens: "" },
  tts: { model: "", voices: "", tokens: "", lexicon: "", dataDir: "" },
});

describe("VoiceModelStore", () => {
  it("downloads, verifies and unpacks every model once", async () => {
    const { installRoot, artifacts, fetchImpl } = await fixture();
    let downloads = 0;
    const progress: number[] = [];
    const store = new VoiceModelStore({
      rootDir: installRoot,
      artifacts,
      fetchImpl: async (url) => {
        downloads += 1;
        return fetchImpl(url);
      },
      paths: PATHS,
    });
    const paths = await store.ensure((tick) =>
      progress.push(tick.receivedBytes),
    );
    expect(await fs.readFile(paths.vad, "utf8")).toBe("vad-weights");
    expect(
      await fs.readFile(
        path.join(installRoot, "model-dir", "model.onnx"),
        "utf8",
      ),
    ).toBe("weights");
    expect(progress.at(-1)).toBe(
      artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    );
    await store.ensure();
    expect(downloads).toBe(2);
    // Nothing half-installed is left behind.
    expect(
      (await fs.readdir(installRoot)).filter((name) =>
        name.startsWith(".install-"),
      ),
    ).toEqual([]);
  });

  it("refuses a download that does not match its pin", async () => {
    const { installRoot, artifacts, fetchImpl } = await fixture();
    const tampered = artifacts.map((artifact) => ({
      ...artifact,
      sha256: "0".repeat(64),
    }));
    const store = new VoiceModelStore({
      rootDir: installRoot,
      artifacts: tampered,
      fetchImpl,
    });
    await expect(store.ensure()).rejects.toThrow(/integrity/);
    await expect(
      fs.access(path.join(installRoot, "vad", ".integrity")),
    ).rejects.toThrow();
  });

  it("refuses a model from anywhere but GitHub's releases", async () => {
    const { installRoot, artifacts, fetchImpl } = await fixture();
    const store = new VoiceModelStore({
      rootDir: installRoot,
      artifacts: artifacts.map((artifact) => ({
        ...artifact,
        url: artifact.url.replace("github.com", "example.com"),
      })),
      fetchImpl,
    });
    await expect(store.ensure()).rejects.toThrow(/untrusted/);
  });
});
