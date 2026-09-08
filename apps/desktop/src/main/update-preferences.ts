import fs from "node:fs";
import path from "node:path";
import type { DesktopUpdateChannel } from "../shared/update.js";

interface UpdatePreferencesFile {
  channel: DesktopUpdateChannel;
}

function isDesktopUpdateChannel(value: unknown): value is DesktopUpdateChannel {
  return value === "stable" || value === "preview";
}

export function defaultDesktopUpdateChannel(
  version: string,
): DesktopUpdateChannel {
  return version.includes("-") ? "preview" : "stable";
}

/** Machine-wide update preference stored at `<userData>/updates.json`. */
export class UpdatePreferencesStore {
  constructor(private readonly file: string) {}

  load(defaultChannel: DesktopUpdateChannel): DesktopUpdateChannel {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "channel" in parsed &&
        isDesktopUpdateChannel(parsed.channel)
      ) {
        return parsed.channel;
      }
    } catch {
      // Missing or malformed preferences fall back to the installed build.
    }
    return defaultChannel;
  }

  save(channel: DesktopUpdateChannel): void {
    const data: UpdatePreferencesFile = { channel };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.file);
  }
}
