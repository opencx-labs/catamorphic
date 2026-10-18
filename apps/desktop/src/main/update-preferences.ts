import fs from "node:fs";
import path from "node:path";
import type { DesktopUpdateChannel } from "../shared/update.js";

interface UpdatePreferencesFile {
  channel?: DesktopUpdateChannel;
  /** The release downloaded and not installed yet. */
  downloaded?: string;
}

function isDesktopUpdateChannel(value: unknown): value is DesktopUpdateChannel {
  return value === "stable" || value === "preview";
}

export function defaultDesktopUpdateChannel(
  version: string,
): DesktopUpdateChannel {
  return version.includes("-") ? "preview" : "stable";
}

/** Machine-wide update preference and state stored at `<userData>/updates.json`. */
export class UpdatePreferencesStore {
  constructor(private readonly file: string) {}

  load(defaultChannel: DesktopUpdateChannel): DesktopUpdateChannel {
    return this.read().channel ?? defaultChannel;
  }

  save(channel: DesktopUpdateChannel): void {
    this.write({ ...this.read(), channel });
  }

  /** The release downloaded and waiting for a restart, if any. */
  downloaded(): string | undefined {
    return this.read().downloaded;
  }

  saveDownloaded(version: string | undefined): void {
    const { downloaded: _previous, ...rest } = this.read();
    this.write(version ? { ...rest, downloaded: version } : rest);
  }

  private read(): UpdatePreferencesFile {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      const channel = Reflect.get(parsed, "channel");
      const downloaded = Reflect.get(parsed, "downloaded");
      return {
        ...(isDesktopUpdateChannel(channel) ? { channel } : {}),
        ...(typeof downloaded === "string" && downloaded ? { downloaded } : {}),
      };
    } catch {
      // Missing or malformed preferences fall back to the installed build.
      return {};
    }
  }

  private write(data: UpdatePreferencesFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.file);
  }
}
