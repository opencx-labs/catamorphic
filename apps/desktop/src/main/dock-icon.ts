import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  type NativeImage,
  nativeImage,
} from "electron";
import {
  type DockIconState,
  MAX_DOCK_ICON_BYTES,
} from "../shared/dock-icon.js";

const IMAGE_ERROR = "Choose a PNG or JPEG image up to 10 MB.";
const DIMENSION_ERROR =
  "Choose an image up to 16 megapixels and 8192 pixels per side.";

/** Read headers before native decoding can allocate the full pixel buffer. */
function validateDimensions(buffer: Buffer): void {
  const check = (width: number, height: number) => {
    if (!width || !height) throw new Error(IMAGE_ERROR);
    if (width > 8192 || height > 8192 || width * height > 16_000_000)
      throw new Error(DIMENSION_ERROR);
  };
  const png = buffer
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (png) {
    if (
      buffer.length < 33 ||
      buffer.readUInt32BE(8) !== 13 ||
      buffer.toString("ascii", 12, 16) !== "IHDR"
    )
      throw new Error(IMAGE_ERROR);
    check(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
    return;
  }
  if (buffer[0] !== 255 || buffer[1] !== 216) throw new Error(IMAGE_ERROR);
  let offset = 2;
  let found = false;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset++] !== 255) throw new Error(IMAGE_ERROR);
    while (buffer[offset] === 255) offset++;
    const marker = buffer[offset++];
    if (marker === undefined || marker === 0 || marker === 217) break;
    if (marker === 218) {
      if (!found) break;
      return;
    }
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    // JPEG Start Of Frame markers, excluding the table/extension markers.
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (length < 8) break;
      check(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
      found = true;
    }
    offset += length;
  }
  throw new Error(IMAGE_ERROR);
}

function fit(image: NativeImage, maximum: number): NativeImage {
  const { width, height } = image.getSize();
  const scale = Math.min(1, maximum / Math.max(width, height));
  return scale < 1
    ? image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: "best",
      })
    : image;
}

/** One managed image for the application, independent of profiles and projects. */
export class DockIconStore {
  private image: NativeImage | null = null;
  private custom = false;
  private error: string | undefined;
  private revision = 0;

  constructor(
    private readonly options: {
      file: string;
      apply: (image: NativeImage | null) => void;
    },
  ) {
    try {
      const stat = fs.statSync(options.file);
      this.custom = true;
      if (!stat.isFile() || stat.size > MAX_DOCK_ICON_BYTES)
        throw new Error(IMAGE_ERROR);
      this.image = this.decode(fs.readFileSync(options.file));
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        this.error =
          "Your saved Dock icon could not be loaded. Choose another image or reset it.";
      }
    }
    options.apply(this.image);
  }

  private decode(bytes: Uint8Array): NativeImage {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOCK_ICON_BYTES)
      throw new Error(IMAGE_ERROR);
    const buffer = Buffer.from(bytes);
    validateDimensions(buffer);
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error(IMAGE_ERROR);
    return fit(image, 1024);
  }

  state(): DockIconState {
    return {
      supported: true,
      custom: this.custom,
      preview: this.image ? fit(this.image, 128).toDataURL() : null,
      ...(this.error ? { error: this.error } : {}),
      revision: this.revision,
    };
  }

  set(bytes: unknown): DockIconState {
    if (!(bytes instanceof Uint8Array)) throw new Error(IMAGE_ERROR);
    const image = this.decode(bytes);
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
    try {
      fs.writeFileSync(temporary, image.toPNG(), { mode: 0o600 });
      fs.renameSync(temporary, this.options.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    this.options.apply(image);
    this.image = image;
    this.custom = true;
    this.error = undefined;
    this.revision++;
    return this.state();
  }

  reset(): DockIconState {
    fs.rmSync(this.options.file, { force: true });
    this.options.apply(null);
    this.image = null;
    this.custom = false;
    this.error = undefined;
    this.revision++;
    return this.state();
  }
}

export function registerDockIcon({
  defaultIcon,
}: {
  defaultIcon: NativeImage;
}) {
  const dock = app.dock;
  const store = dock
    ? new DockIconStore({
        file: path.join(app.getPath("userData"), "dock-icon.png"),
        apply: (image) => dock.setIcon(image ?? defaultIcon),
      })
    : null;
  const ownsWindow = (event: Electron.IpcMainInvokeEvent) => {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Open this setting in Work.");
  };
  const broadcast = (state: DockIconState) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send("catamorphic:dock-icon-changed", state);
    return state;
  };
  ipcMain.handle("catamorphic:dock-icon-state", (event) => {
    ownsWindow(event);
    return (
      store?.state() ??
      ({
        supported: false,
        custom: false,
        preview: null,
        revision: 0,
      } satisfies DockIconState)
    );
  });
  ipcMain.handle("catamorphic:dock-icon-set", (event, bytes: unknown) => {
    ownsWindow(event);
    if (!store)
      throw new Error("Dock icon customization is available on macOS.");
    return broadcast(store.set(bytes));
  });
  ipcMain.handle("catamorphic:dock-icon-reset", (event) => {
    ownsWindow(event);
    if (!store)
      throw new Error("Dock icon customization is available on macOS.");
    return broadcast(store.reset());
  });
}
