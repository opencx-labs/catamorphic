import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { z } from "zod";
import {
  accessText,
  type CodeAccess,
  parseCodeAccess,
} from "../shared/code-access.js";

/** Seals the approvals key with the OS keychain (Electron's safeStorage). */
export interface Keyring {
  /** Asked off the main thread: the keychain may wait on the person. */
  available: () => Promise<boolean>;
  encrypt: (text: string) => Promise<Buffer>;
  decrypt: (data: Buffer) => Promise<string>;
}

/** What a person approved some code to reach, and when. */
export interface CodeApproval {
  /** `module:<project>:<path>` or `app:<project>:<name>`. */
  subject: string;
  access: CodeAccess;
  at: number;
}

const recordSchema = z.object({
  subject: z.string().min(1).max(4096),
  access: z.unknown(),
  at: z.number(),
  mac: z.string(),
});

/**
 * The one record of what the person approved code to reach (ADR 0277):
 * modules, apps that read their chats. A file a local program could write,
 * so each entry is signed with a key only Work can unseal from the
 * keychain: writing an approval in grants nothing, and one that does not
 * verify is no approval. Losing the key asks again; it never allows.
 */
export class CodeApprovals {
  private key?: Promise<Buffer>;
  private records?: CodeApproval[];
  private writing = Promise.resolve();

  constructor(
    private readonly deps: {
      /** The profile's folder. */
      dir: string;
      keyring: Keyring;
    },
  ) {}

  private get file() {
    return path.join(this.deps.dir, "approvals.json");
  }
  private get keyFile() {
    return path.join(this.deps.dir, "approvals.key");
  }

  private secret(): Promise<Buffer> {
    this.key ??= (async () => {
      try {
        const sealed = fs.readFileSync(this.keyFile);
        return Buffer.from(await this.deps.keyring.decrypt(sealed), "hex");
      } catch (cause) {
        if (fs.existsSync(this.keyFile)) throw cause;
      }
      if (!(await this.deps.keyring.available()))
        throw new Error("The keychain is not available to keep approvals.");
      const key = randomBytes(32);
      fs.mkdirSync(this.deps.dir, { recursive: true });
      fs.writeFileSync(
        this.keyFile,
        await this.deps.keyring.encrypt(key.toString("hex")),
        { mode: 0o600 },
      );
      // Approvals signed with another key are no one's now.
      fs.rmSync(this.file, { force: true });
      return key;
    })().catch((cause: unknown) => {
      // A keychain that refused now may answer later.
      this.key = undefined;
      throw cause;
    });
    return this.key;
  }

  private mac(key: Buffer, record: CodeApproval): string {
    return createHmac("sha256", key)
      .update(`${record.subject}\n${accessText(record.access)}\n${record.at}`)
      .digest("hex");
  }

  private async load(): Promise<CodeApproval[]> {
    if (this.records) return this.records;
    const key = await this.secret();
    let raw: unknown = [];
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      // None yet.
    }
    const records: CodeApproval[] = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      const parsed = recordSchema.safeParse(entry);
      if (!parsed.success) continue;
      let access: CodeAccess;
      try {
        access = parseCodeAccess(parsed.data.access, "approval");
      } catch {
        continue;
      }
      const record = {
        subject: parsed.data.subject,
        access,
        at: parsed.data.at,
      };
      const expected = Buffer.from(this.mac(key, record), "hex");
      const given = Buffer.from(parsed.data.mac, "hex");
      if (given.length === expected.length && timingSafeEqual(given, expected))
        records.push(record);
    }
    this.records = records;
    return records;
  }

  private async save(records: CodeApproval[]): Promise<void> {
    const key = await this.secret();
    this.records = records;
    const signed = records.map((record) => ({
      ...record,
      mac: this.mac(key, record),
    }));
    this.writing = this.writing.then(() => {
      fs.mkdirSync(this.deps.dir, { recursive: true });
      const temporary = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(signed, null, 2), {
        mode: 0o600,
      });
      fs.renameSync(temporary, this.file);
    });
    await this.writing;
  }

  /** What the person approved this code to reach, or null for nothing yet. */
  async approved(subject: string): Promise<CodeAccess | null> {
    return (
      (await this.load()).find((record) => record.subject === subject)
        ?.access ?? null
    );
  }

  /** Approve exactly this reach; it replaces what was approved before. */
  async approve(subject: string, access: CodeAccess): Promise<void> {
    const records = (await this.load()).filter(
      (record) => record.subject !== subject,
    );
    await this.save([...records, { subject, access, at: Date.now() }]);
  }

  async revoke(subject: string): Promise<void> {
    const records = await this.load();
    if (!records.some((record) => record.subject === subject)) return;
    await this.save(records.filter((record) => record.subject !== subject));
  }

  async list(): Promise<readonly CodeApproval[]> {
    return [...(await this.load())];
  }
}

const appSchema = z.object({
  projectId: z.string().min(1).max(200),
  app: z.string().min(1).max(200),
});
/** An app that reads the viewer's chats (ADR 0148), as its approval records it. */
const APP_SESSIONS: CodeAccess = { lists: ["chats"] };

/**
 * Each profile's approvals, and the window's questions about apps: whether
 * one that reads the person's chats was allowed, and allowing it. Only
 * Work's own windows allow anything.
 */
export function registerCodeApprovals({
  profilesDir,
  keyring,
  profileFor,
}: {
  profilesDir: string;
  keyring: Keyring;
  profileFor: (sender: Electron.WebContents) => string;
}): {
  approvalsFor: (profileId: string) => CodeApprovals;
  dispose: () => void;
} {
  const stores = new Map<string, CodeApprovals>();
  const approvalsFor = (profileId: string) => {
    let store = stores.get(profileId);
    if (!store) {
      store = new CodeApprovals({
        dir: path.join(profilesDir, profileId),
        keyring,
      });
      stores.set(profileId, store);
    }
    return store;
  };
  ipcMain.handle(
    "catamorphic:app-access-approved",
    async (event, raw: unknown) => {
      const { projectId, app } = appSchema.parse(raw);
      const approved = await approvalsFor(profileFor(event.sender)).approved(
        `app:${projectId}:${app}`,
      );
      return approved?.lists?.includes("chats") === true;
    },
  );
  ipcMain.handle(
    "catamorphic:app-access-allow",
    async (event, raw: unknown) => {
      if (event.sender.getType() !== "window")
        throw new Error("Only Work can allow an app's access.");
      const { projectId, app } = appSchema.parse(raw);
      await approvalsFor(profileFor(event.sender)).approve(
        `app:${projectId}:${app}`,
        APP_SESSIONS,
      );
    },
  );
  return {
    approvalsFor,
    dispose: () => {
      ipcMain.removeHandler("catamorphic:app-access-approved");
      ipcMain.removeHandler("catamorphic:app-access-allow");
    },
  };
}
