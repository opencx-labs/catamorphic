import fs from "node:fs";
import path from "node:path";

/**
 * Incognito sessions (ADR 0062) are a DESKTOP concept, not a core one:
 * the flag's only meaning is "the mirror pusher must skip this chat", and
 * mirroring is desktop machinery — so the list lives in desktop state
 * (`<userData>/incognito-sessions.json`), never in core's schema or on
 * any wire. The renderer marks a session right after its lazy creation;
 * the mirror consults the set before every push.
 */
export class IncognitoSessionsStore {
  private ids: Set<string>;

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        sessionIds?: string[];
      };
      this.ids = new Set(parsed.sessionIds ?? []);
    } catch {
      this.ids = new Set();
    }
  }

  has(sessionId: string): boolean {
    return this.ids.has(sessionId);
  }

  set(sessionId: string, incognito: boolean): void {
    if (incognito === this.ids.has(sessionId)) return;
    if (incognito) this.ids.add(sessionId);
    else this.ids.delete(sessionId);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      `${JSON.stringify({ sessionIds: [...this.ids] }, null, 2)}\n`,
    );
  }
}
