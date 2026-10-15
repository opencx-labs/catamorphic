import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ImportedHarness,
  ImportedTranscript,
  JsonValue,
} from "@catamorphic/agent-protocol";
import { readConfigObject, writeConfigObject } from "./config-file.js";
import { readGit } from "./git-view.js";

/**
 * Chats Claude Code and Codex ran outside Work, imported read-only beside
 * Work's own (ADR 0233). The stores' directory watches are hints (ADR
 * 0229): a session file is read once it settles, from where the last read
 * stopped, and core gets the turns that changed. Only sessions that start
 * after one of a profile's agents turned importing on are imported.
 */

/** A file is read once it has been quiet this long. */
const SETTLE_MS = 1_500;
const CHUNK_BYTES = 4 * 1024 * 1024;

/** What a transcript reader is: lines in, a transcript out. */
export interface TranscriptReader {
  push(line: string): void;
  read(input?: { now?: Date }): ImportedTranscript | undefined;
}

export interface ImportingProfile {
  id: string;
  /**
   * The agent that imports each tool's chats (its "Sync chats from"
   * switch is on): continuations run on it.
   */
  importers: Partial<Record<ImportedHarness, string>>;
  projectIds: string[];
}

export interface ExternalSessionImporterDeps {
  /** `~/.claude` (or `CLAUDE_CONFIG_DIR`) and `~/.codex` (or `CODEX_HOME`). */
  homes: { claude: string; codex: string };
  /** When each profile turned each tool on: `<userData>/external-session-imports.json`. */
  stateFile: string;
  profiles(): ImportingProfile[];
  projectRoot(projectId: string): string | undefined;
  readers: Record<ImportedHarness, () => TranscriptReader>;
  importTranscript(input: {
    projectId: string;
    transcript: ImportedTranscript;
    sourcePath: string;
    contentSha256: string;
    sourceModifiedAt: string;
    agentId: string | null;
    /** Claude Code's own records from `offset` on: its native state. */
    native?: { offset: number; entries: JsonValue[] };
  }): Promise<{
    outcome: "created" | "updated" | "unchanged" | "own" | "taken_over";
  }>;
  /** The main checkout a worktree belongs to, when it is one. */
  mainCheckout?(cwd: string): Promise<string | undefined>;
  /** A chat was imported or grew: chat lists look again. */
  changed?(): void;
  now?(): Date;
  log?(message: string, error?: unknown): void;
}

/** The default homes, honoring the CLIs' own variables. */
export function externalSessionHomes(
  env: NodeJS.ProcessEnv = process.env,
): ExternalSessionImporterDeps["homes"] {
  return {
    claude: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    codex: env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  };
}

/** The main checkout of the worktree `cwd` is in, by git's common dir. */
export async function gitMainCheckout(
  cwd: string,
): Promise<string | undefined> {
  try {
    const common = (
      await readGit(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim();
    return path.basename(common) === ".git" ? path.dirname(common) : undefined;
  } catch {
    // Gone, or not a repository.
    return undefined;
  }
}

/** `rollout-<time>-<thread>[_<segment>].jsonl`: a Codex thread's file. */
const ROLLOUT =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_[0-9a-f-]{36})?\.jsonl$/;

/** One session's files and how far they have been read. */
interface Source {
  harness: ImportedHarness;
  key: string;
  files: Map<string, number>;
  reader: TranscriptReader;
  hash: Hash;
  /** A partial last line, carried to the next read. */
  rest: string;
  /** Never imported: Work's own, or older than importing. */
  ignored: boolean;
  /** Per project: the turns as last sent, to send only what changed. */
  sent: Map<string, Map<string, string>>;
  /**
   * Claude Code's records read since they were last delivered, and how many
   * were read before them: the session's native state, so a chat
   * continued here resumes Claude Code's own session.
   */
  native: { offset: number; entries: JsonValue[] };
  modifiedAt: Date;
}

export class ExternalSessionImporter {
  private readonly sources = new Map<string, Source>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watchers = new Map<ImportedHarness, fs.FSWatcher>();
  private queue = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: ExternalSessionImporterDeps) {}

  /** Apply the agents' switches: start or stop watching, and catch up. */
  refresh(): void {
    if (this.disposed) return;
    const state = this.readState();
    const now = this.now().toISOString();
    const enabled = new Set<ImportedHarness>();
    let changed = false;
    const profiles = this.deps.profiles();
    for (const profile of profiles) {
      const since = state[profile.id] ?? {};
      for (const harness of ["claude-code", "codex"] as const) {
        if (profile.importers[harness]) {
          enabled.add(harness);
          if (!since[harness]) {
            since[harness] = now;
            changed = true;
          }
        } else if (since[harness]) {
          delete since[harness];
          changed = true;
        }
      }
      state[profile.id] = since;
    }
    for (const id of Object.keys(state))
      if (!profiles.some((profile) => profile.id === id)) {
        delete state[id];
        changed = true;
      }
    if (changed) writeConfigObject(this.deps.stateFile, state);
    for (const harness of ["claude-code", "codex"] as const) {
      if (enabled.has(harness)) this.watch(harness);
      else this.unwatch(harness);
    }
    if (enabled.size > 0) this.enqueue(() => this.catchUp(state));
  }

  /** Every scheduled read done (tests and shutdown). */
  async idle(): Promise<void> {
    for (const [file, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(file);
      this.enqueue(() => this.process(file));
    }
    await this.queue;
  }

  dispose(): void {
    this.disposed = true;
    for (const harness of [...this.watchers.keys()]) this.unwatch(harness);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private root(harness: ImportedHarness): string {
    return harness === "claude-code"
      ? path.join(this.deps.homes.claude, "projects")
      : path.join(this.deps.homes.codex, "sessions");
  }

  private readState(): Record<
    string,
    Partial<Record<ImportedHarness, string>>
  > {
    let raw: Record<string, unknown>;
    try {
      raw = readConfigObject(this.deps.stateFile);
    } catch {
      raw = {};
    }
    return Object.fromEntries(
      Object.entries(raw).map(([profileId, value]) => [
        profileId,
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).filter(
                (entry): entry is [ImportedHarness, string] =>
                  (entry[0] === "claude-code" || entry[0] === "codex") &&
                  typeof entry[1] === "string",
              ),
            )
          : {},
      ]),
    );
  }

  private watch(harness: ImportedHarness): void {
    if (this.watchers.has(harness)) return;
    const root = this.root(harness);
    try {
      fs.mkdirSync(root, { recursive: true });
      const watcher = fs.watch(root, { recursive: true }, (_event, name) => {
        if (typeof name === "string") this.schedule(path.join(root, name));
      });
      watcher.on("error", (error) =>
        this.deps.log?.(`Stopped watching ${root}`, error),
      );
      this.watchers.set(harness, watcher);
    } catch (error) {
      this.deps.log?.(`Cannot watch ${root}`, error);
    }
  }

  private unwatch(harness: ImportedHarness): void {
    this.watchers.get(harness)?.close();
    this.watchers.delete(harness);
    for (const [key, source] of this.sources)
      if (source.harness === harness) this.sources.delete(key);
  }

  /** A file changed: read it once it has been quiet for a moment. */
  private schedule(file: string): void {
    if (!this.sourceOf(file)) return;
    clearTimeout(this.timers.get(file));
    this.timers.set(
      file,
      setTimeout(() => {
        this.timers.delete(file);
        this.enqueue(() => this.process(file));
      }, SETTLE_MS),
    );
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.deps.log?.("Could not import a session", error);
    });
  }

  /** The session a path is a transcript of, if it is one. */
  private sourceOf(
    file: string,
  ): { harness: ImportedHarness; key: string } | undefined {
    const claude = this.root("claude-code");
    const codex = this.root("codex");
    if (file.startsWith(`${claude}${path.sep}`)) {
      const parts = path.relative(claude, file).split(path.sep);
      // `<escaped cwd>/<session>.jsonl`; subagents' side chains sit deeper.
      if (parts.length !== 2 || !parts[1]?.endsWith(".jsonl")) return undefined;
      return { harness: "claude-code", key: `claude-code:${parts[1]}` };
    }
    if (file.startsWith(`${codex}${path.sep}`)) {
      const thread = ROLLOUT.exec(path.basename(file))?.[1];
      return thread ? { harness: "codex", key: `codex:${thread}` } : undefined;
    }
    return undefined;
  }

  /** Read every session file touched since its tool was turned on. */
  private async catchUp(
    state: Record<string, Partial<Record<ImportedHarness, string>>>,
  ): Promise<void> {
    for (const harness of ["claude-code", "codex"] as const) {
      if (!this.watchers.has(harness)) continue;
      const starts = Object.values(state)
        .map((since) => since[harness])
        .filter((since): since is string => Boolean(since))
        .map((since) => Date.parse(since));
      if (starts.length === 0) continue;
      const since = Math.min(...starts);
      for (const file of await listFiles(
        this.root(harness),
        harness === "claude-code" ? 2 : 4,
      )) {
        const stat = await fsp.stat(file).catch(() => undefined);
        if (stat && stat.mtimeMs >= since) await this.process(file);
      }
    }
  }

  private async process(file: string): Promise<void> {
    if (this.disposed) return;
    const id = this.sourceOf(file);
    if (!id || !this.watchers.has(id.harness)) return;
    let source = this.sources.get(id.key);
    if (
      !source ||
      // A file shrank or was replaced: read it all again.
      (
        await Promise.all(
          [...source.files].map(async ([name, offset]) => {
            const stat = await fsp.stat(name).catch(() => undefined);
            return !stat || stat.size < offset;
          }),
        )
      ).some(Boolean)
    ) {
      source = {
        ...id,
        files: new Map(),
        reader: this.deps.readers[id.harness](),
        hash: createHash("sha256"),
        rest: "",
        ignored: false,
        sent: new Map(),
        native: { offset: 0, entries: [] },
        modifiedAt: new Date(0),
      };
      this.sources.set(id.key, source);
    }
    if (source.ignored) return;
    // A Codex thread may span segment files: the first read finds them all.
    const files =
      id.harness === "codex" && source.files.size === 0
        ? await threadFiles(this.root("codex"), id.key.slice("codex:".length))
        : [...new Set([...source.files.keys(), file])].sort((a, b) =>
            path.basename(a).localeCompare(path.basename(b)),
          );
    for (const name of files) await this.readMore(source, name);
    await this.deliver(source);
  }

  /** Feed the reader what was appended to `file` since the last read. */
  private async readMore(source: Source, file: string): Promise<void> {
    const handle = await fsp.open(file, "r").catch(() => undefined);
    if (!handle) return;
    try {
      const stat = await handle.stat();
      if (stat.mtime > source.modifiedAt) source.modifiedAt = stat.mtime;
      // A later segment starts a new file: what came before was complete.
      if (!source.files.has(file) && source.rest) {
        source.reader.push(source.rest);
        if (source.harness === "claude-code") nativeRecord(source, source.rest);
        source.rest = "";
      }
      let offset = source.files.get(file) ?? 0;
      const buffer = Buffer.alloc(CHUNK_BYTES);
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(CHUNK_BYTES, stat.size - offset),
          offset,
        );
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        offset += bytesRead;
        source.hash.update(chunk);
        const text = source.rest + chunk.toString("utf8");
        const lines = text.split("\n");
        source.rest = lines.pop() ?? "";
        for (const line of lines) {
          source.reader.push(line);
          if (source.harness === "claude-code") nativeRecord(source, line);
        }
        // Let the window breathe between chunks of a long transcript.
        await new Promise((resolve) => setImmediate(resolve));
      }
      source.files.set(file, offset);
    } finally {
      await handle.close();
    }
  }

  private async deliver(source: Source): Promise<void> {
    const transcript = source.reader.read({ now: this.now() });
    if (!transcript) return;
    if (
      source.harness === "codex" &&
      (await this.codexImportedFromClaude()).has(transcript.nativeSessionId)
    ) {
      // Codex Desktop's copy of a Claude Code chat: the original comes itself.
      source.ignored = true;
      return;
    }
    const started = Date.parse(transcript.startedAt);
    const state = this.readState();
    const profiles = this.deps.profiles().filter((profile) => {
      const since = state[profile.id]?.[source.harness];
      return (
        profile.importers[source.harness] !== undefined &&
        since !== undefined &&
        started >= Date.parse(since)
      );
    });
    if (profiles.length === 0) {
      // It started before importing was on: no backfill.
      source.ignored = true;
      return;
    }
    const sourcePath = [...source.files.keys()].at(-1) ?? "";
    const contentSha256 = source.hash.copy().digest("hex");
    const native = source.native;
    let delivered = true;
    for (const profile of profiles) {
      const projectId = await this.projectFor(profile, transcript.cwd);
      if (!projectId) continue;
      const sent = source.sent.get(projectId) ?? new Map<string, string>();
      const turns = transcript.turns.filter(
        (turn) => sent.get(turn.key) !== JSON.stringify(turn),
      );
      if (turns.length === 0 && sent.size > 0) {
        // Nothing to show changed: its records go with the next change.
        delivered = false;
        continue;
      }
      const result = await this.deps.importTranscript({
        projectId,
        transcript: { ...transcript, turns },
        sourcePath,
        contentSha256,
        sourceModifiedAt: source.modifiedAt.toISOString(),
        agentId: profile.importers[source.harness] ?? null,
        ...(source.harness === "claude-code" ? { native } : {}),
      });
      // Work's own chat, or one continued here: the tool's file is no
      // longer read into it.
      if (result.outcome === "own" || result.outcome === "taken_over") {
        source.ignored = true;
        return;
      }
      for (const turn of turns) sent.set(turn.key, JSON.stringify(turn));
      source.sent.set(projectId, sent);
      if (result.outcome !== "unchanged") this.deps.changed?.();
    }
    if (delivered)
      source.native = {
        offset: native.offset + native.entries.length,
        entries: [],
      };
  }

  /** The profile's project whose folder holds `cwd`, or its main checkout. */
  private async projectFor(
    profile: ImportingProfile,
    cwd: string,
  ): Promise<string | undefined> {
    const within = (directory: string) => {
      let best: { id: string; depth: number } | undefined;
      for (const id of profile.projectIds) {
        const root = this.deps.projectRoot(id);
        if (!root) continue;
        const relative = path.relative(root, directory);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        if (!best || root.length > best.depth)
          best = { id, depth: root.length };
      }
      return best?.id;
    };
    const real = await fsp.realpath(cwd).catch(() => cwd);
    const direct = within(real) ?? within(cwd);
    if (direct) return direct;
    const main = await (this.deps.mainCheckout ?? gitMainCheckout)(cwd);
    return main ? within(main) : undefined;
  }

  /** Threads Codex Desktop made from Claude Code transcripts. */
  private async codexImportedFromClaude(): Promise<Set<string>> {
    const file = path.join(
      this.deps.homes.codex,
      "external_agent_session_imports.json",
    );
    try {
      const raw: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
      const records =
        raw && typeof raw === "object" && "records" in raw
          ? raw.records
          : undefined;
      if (!Array.isArray(records)) return new Set();
      return new Set(
        records.flatMap((record: unknown) =>
          record &&
          typeof record === "object" &&
          "imported_thread_id" in record &&
          typeof record.imported_thread_id === "string"
            ? [record.imported_thread_id]
            : [],
        ),
      );
    } catch {
      return new Set();
    }
  }
}

/** Every `.jsonl` file under `root`, at most `depth` directories down. */
async function listFiles(root: string, depth: number): Promise<string[]> {
  const entries = await fsp
    .readdir(root, { withFileTypes: true })
    .catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && depth > 1)
      files.push(...(await listFiles(full, depth - 1)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
  }
  return files;
}

/** A Codex thread's rollout segments, oldest first. */
async function threadFiles(root: string, thread: string): Promise<string[]> {
  const candidates = await listFiles(root, 4);
  return candidates
    .filter(
      (candidate) => ROLLOUT.exec(path.basename(candidate))?.[1] === thread,
    )
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

/** One of Claude Code's transcript records, kept as its native state. */
function nativeRecord(source: Source, line: string): void {
  if (!line.trim()) return;
  try {
    const value: JsonValue = JSON.parse(line);
    if (value && typeof value === "object" && !Array.isArray(value))
      source.native.entries.push(value);
  } catch {
    // The line the CLI is writing right now.
  }
}
