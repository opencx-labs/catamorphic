import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DOCK_ICON_BYTES } from "../shared/dock-icon.js";

const { decode } = vi.hoisted(() => ({ decode: vi.fn() }));
vi.mock("electron", () => ({
  app: {},
  BrowserWindow: {},
  ipcMain: {},
  nativeImage: { createFromBuffer: decode },
}));

import { DockIconStore } from "./dock-icon.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQEREBAAB8AD2SgCfbAAAAAElFTkSuQmCC",
  "base64",
);
function image(width = 16, height = 16) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => png,
    toDataURL: () => `data:image/png;base64,${png.toString("base64")}`,
    resize: vi.fn((size: { width: number; height: number }) =>
      image(size.width, size.height),
    ),
  };
}

let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "dock-icon-"));
  file = path.join(directory, "dock-icon.png");
  decode.mockReset();
  decode.mockImplementation(() => image());
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("application Dock icon", () => {
  it("persists a managed PNG, reloads without the source file and resets", () => {
    const apply = vi.fn();
    const store = new DockIconStore({ file, apply });
    expect(store.state()).toMatchObject({
      custom: false,
      preview: null,
      revision: 0,
    });
    expect(store.set(png)).toMatchObject({ custom: true, revision: 1 });
    expect(fs.readFileSync(file)).toEqual(png);
    expect(new DockIconStore({ file, apply }).state()).toMatchObject({
      custom: true,
    });
    expect(store.reset()).toEqual({
      supported: true,
      custom: false,
      preview: null,
      revision: 2,
    });
    expect(fs.existsSync(file)).toBe(false);
    expect(apply).toHaveBeenLastCalledWith(null);
  });

  it("preserves the current image and file when a replacement is invalid", () => {
    const apply = vi.fn();
    const store = new DockIconStore({ file, apply });
    const selected = store.set(png);
    for (const invalid of [
      null,
      "image.png",
      {},
      new Uint8Array(),
      Buffer.from("bad image"),
      new Uint8Array(MAX_DOCK_ICON_BYTES + 1),
    ]) {
      expect(() => store.set(invalid)).toThrow("Choose a PNG or JPEG");
      expect(store.state()).toEqual(selected);
      expect(fs.readFileSync(file)).toEqual(png);
    }
    expect(apply).toHaveBeenCalledTimes(2);
    decode.mockReturnValue({ isEmpty: () => true });
    expect(() => store.set(png)).toThrow("Choose a PNG or JPEG");
    expect(store.state()).toEqual(selected);
  });

  it("leaves the previous choice active and removes staging on a write failure", () => {
    const apply = vi.fn();
    const store = new DockIconStore({ file, apply });
    const selected = store.set(png);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("Disk is full");
    });
    expect(() => store.set(png)).toThrow("Disk is full");
    expect(store.state()).toEqual(selected);
    expect(fs.readFileSync(file)).toEqual(png);
    expect(fs.readdirSync(directory)).toEqual(["dock-icon.png"]);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("rejects huge or malformed PNG and JPEG headers before native decoding", () => {
    const store = new DockIconStore({ file, apply: vi.fn() });
    const hugePng = Buffer.from(png);
    hugePng.writeUInt32BE(20000, 16);
    hugePng.writeUInt32BE(20000, 20);
    const hugeJpeg = Buffer.from(
      "ffd8ffc0000b082000200001011100ffda0002",
      "hex",
    );
    for (const bytes of [hugePng, hugeJpeg])
      expect(() => store.set(bytes)).toThrow("16 megapixels");
    for (const bytes of [
      png.subarray(0, 20),
      Buffer.from("ffd8ffe1ffff00", "hex"),
    ])
      expect(() => store.set(bytes)).toThrow("Choose a PNG or JPEG");
    expect(decode).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("finds JPEG dimensions beyond metadata and accepts progressive frames", () => {
    const jpeg = Buffer.from(
      "ffd8ffe100040000ffc2000b080064006401011100ffda0002",
      "hex",
    );
    const store = new DockIconStore({ file, apply: vi.fn() });
    expect(store.set(jpeg).custom).toBe(true);
    expect(decode).toHaveBeenCalledWith(jpeg);
    expect(fs.readFileSync(file)).toEqual(png);
  });

  it("starts with the default when the saved file is damaged and allows reset", () => {
    fs.writeFileSync(file, "damaged image");
    const apply = vi.fn();
    const store = new DockIconStore({ file, apply });
    expect(store.state()).toMatchObject({
      custom: true,
      preview: null,
      error: expect.stringContaining("could not be loaded"),
    });
    expect(apply).toHaveBeenCalledWith(null);
    expect(store.reset().error).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("bounds both image and preview dimensions while preserving the aspect ratio", () => {
    for (const [width, height, expected] of [
      [4096, 64, { width: 128, height: 2 }],
      [1, 8192, { width: 1, height: 128 }],
    ] as const) {
      const source = image(width, height);
      decode.mockReturnValue(source);
      const apply = vi.fn();
      new DockIconStore({ file, apply }).set(png);
      const normalized = source.resize.mock.results[0]?.value;
      expect(normalized?.getSize().width).toBeLessThanOrEqual(1024);
      expect(normalized?.getSize().height).toBeLessThanOrEqual(1024);
      expect(normalized?.resize).toHaveBeenCalledWith({
        ...expected,
        quality: "best",
      });
      fs.rmSync(file);
    }
  });
});
