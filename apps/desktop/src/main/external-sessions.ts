import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  ImportedHarness,
  ImportedTranscript,
  JsonValue,
} from "@catamorphic/agent-protocol";
import { readConfigObject, writeConfigObject } from "./config-file.js";
import { readGit } from "./git-view.js";

/**
 * Chats Claude Code and Codex ran outside Work, imported beside
 * Work's own (ADR 0233). The stores' directory watches are hints (ADR
 * 0229): a session file is read once it settles, from where the last read
 * stopped, and core gets the turns that changed. Only sessions that start
 * after one of a profile's agents turned importing on are imported. A
 * look over the stores reads only files changed since the last one began,
 * and a session that will never import keeps nothing but its verdict.
 */

/** A file is read once it has been quiet this long. */
const SETTLE_MS = 1_500;
const CHUNK_BYTES = 4 * 1024 * 1024;
/**
 * A last turn still open is read again once the readers' quiet rule (ten
 * minutes without a line) would end it: a CLI killed mid-step writes no
 * more lines to wake the import.
 */
const REREAD_OPEN_MS = 10 * 60_000 + SETTLE_MS;
/** Files changed this close before the last look began are read again. */
const SCAN_MARGIN_MS = 60_000;

const HARNESSES = ["claude-code", "codex"] as const;

/** What a transcript reader is: lines in, a transcript out. */
export interface TranscriptReader {
  push(line: string): void;
  read(input?: { now?: Date }): ImportedTranscript | undefined;
  /** The file is no session to import (a subagent's, Work's own): stop reading it. */
  skipped?(): boolean;
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

/** When each tool was turned on, and how far the stores were looked over. */
interface ImportState {
  /** Per profile: when each tool was turned on. */
  since: Record<string, Partial<Record<ImportedHarness, string>>>;
  /** Per tool: when the last complete look began. Older files were read then. */
  scanned: Partial<Record<ImportedHarness, string>>;
}

/** One session's files and how far they have been read. */
interface Source {
  harness: ImportedHarness;
  key: string;
  files: Map<string, number>;
  reader: TranscriptReader;
  hash: Hash;
  /** Keeps a character split across two reads whole. */
  decoder: StringDecoder;
  /** A partial last line, carried to the next read. */
  rest: string;
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
  /**
   * Sessions not to read: null for good (Work's own, continued here, older
   * than importing), or the projects as they were when no project held
   * it, to look again once they change.
   */
  private readonly skipped = new Map<string, string | null>();
  private readonly realRoots = new Map<string, string>();
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
      const since = state.since[profile.id] ?? {};
      for (const harness of HARNESSES) {
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
      state.since[profile.id] = since;
    }
    for (const id of Object.keys(state.since))
      if (!profiles.some((profile) => profile.id === id)) {
        delete state.since[id];
        changed = true;
      }
    for (const harness of HARNESSES)
      if (!enabled.has(harness) && state.scanned[harness]) {
        delete state.scanned[harness];
        changed = true;
      }
    if (changed) this.writeState(state);
    for (const harness of HARNESSES) {
      if (enabled.has(harness)) this.watch(harness);
      else this.unwatch(harness);
    }
    if (enabled.size > 0) this.enqueue(() => this.catchUp());
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

  /** Stop watching; resolves once a read in flight has stopped. */
  dispose(): Promise<void> {
    this.disposed = true;
    for (const harness of [...this.watchers.keys()]) this.unwatch(harness);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    return this.queue;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private root(harness: ImportedHarness): string {
    return harness === "claude-code"
      ? path.join(this.deps.homes.claude, "projects")
      : path.join(this.deps.homes.codex, "sessions");
  }

  private readState(): ImportState {
    let raw: Record<string, unknown>;
    try {
      raw = readConfigObject(this.deps.stateFile);
    } catch {
      raw = {};
    }
    const profiles = raw.profiles;
    return {
      since:
        profiles && typeof profiles === "object" && !Array.isArray(profiles)
          ? Object.fromEntries(
              Object.entries(profiles).map(([profileId, value]) => [
                profileId,
                harnessTimes(value),
              ]),
            )
          : {},
      scanned: harnessTimes(raw.scanned),
    };
  }

  private writeState(state: ImportState): void {
    writeConfigObject(this.deps.stateFile, {
      profiles: state.since,
      scanned: state.scanned,
    });
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
    for (const key of [...this.sources.keys(), ...this.skipped.keys()])
      if (key.startsWith(`${harness}:`)) {
        this.sources.delete(key);
        this.skipped.delete(key);
      }
  }

  /** A file changed: read it once it has been quiet for a moment. */
  private schedule(file: string, delay = SETTLE_MS): void {
    if (this.disposed || !this.sourceOf(file)) return;
    clearTimeout(this.timers.get(file));
    this.timers.set(
      file,
      setTimeout(() => {
        this.timers.delete(file);
        this.enqueue(() => this.process(file));
      }, delay),
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

  /**
   * Read every session file touched since its tool was turned on and the
   * last complete look began: a file older than that was read then.
   */
  private async catchUp(): Promise<void> {
    const state = this.readState();
    for (const harness of HARNESSES) {
      if (!this.watchers.has(harness)) continue;
      const starts = Object.values(state.since)
        .map((since) => since[harness])
        .filter((since): since is string => Boolean(since))
        .map((since) => Date.parse(since));
      if (starts.length === 0) continue;
      const begun = this.now();
      const scanned = state.scanned[harness];
      const from = Math.max(
        Math.min(...starts),
        scanned ? Date.parse(scanned) - SCAN_MARGIN_MS : 0,
      );
      let complete = true;
      for (const file of await listFiles(
        this.root(harness),
        harness === "claude-code" ? 2 : 4,
      )) {
        if (this.disposed) return;
        const stat = await fsp.stat(file).catch(() => undefined);
        if (!stat || stat.mtimeMs < from) continue;
        try {
          await this.process(file);
        } catch (error) {
          // The others still come; this one is read again on the next look.
          complete = false;
          this.deps.log?.(`Could not import ${file}`, error);
        }
      }
      if (!complete || this.disposed || !this.watchers.has(harness)) continue;
      const latest = this.readState();
      latest.scanned[harness] = begun.toISOString();
      this.writeState(latest);
    }
  }

  private async process(file: string): Promise<void> {
    if (this.disposed) return;
    const id = this.sourceOf(file);
    if (!id || !this.watchers.has(id.harness)) return;
    const verdict = this.skipped.get(id.key);
    if (verdict === null) return;
    if (verdict !== undefined) {
      // No project held it: only new projects change that.
      if (verdict === this.projectsKey()) return;
      this.skipped.delete(id.key);
    }
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
        decoder: new StringDecoder("utf8"),
        rest: "",
        sent: new Map(),
        native: { offset: 0, entries: [] },
        modifiedAt: new Date(0),
      };
      this.sources.set(id.key, source);
    }
    // A Codex thread may span segment files: the first read finds them all.
    const files =
      id.harness === "codex" && source.files.size === 0
        ? await threadFiles(this.root("codex"), id.key.slice("codex:".length))
        : [...new Set([...source.files.keys(), file])].sort((a, b) =>
            path.basename(a).localeCompare(path.basename(b)),
          );
    for (const name of files) {
      await this.readMore(source, name);
      if (this.disposed) return;
      if (source.reader.skipped?.()) {
        this.skip(source, null);
        return;
      }
    }
    await this.deliver(source);
  }

  /** Never read this session again, or until projects change: keep only that. */
  private skip(source: Source, verdict: string | null): void {
    this.sources.delete(source.key);
    this.skipped.set(source.key, verdict);
  }

  /** Feed the reader what was appended to `file` since the last read. */
  private async readMore(source: Source, file: string): Promise<void> {
    const handle = await fsp.open(file, "r").catch(() => undefined);
    if (!handle) return;
    try {
      const stat = await handle.stat();
      if (stat.mtime > source.modifiedAt) source.modifiedAt = stat.mtime;
      // A later segment starts a new file: what came before was complete.
      if (!source.files.has(file)) {
        const last = source.rest + source.decoder.end();
        if (last) this.line(source, last);
        source.rest = "";
        source.decoder = new StringDecoder("utf8");
      }
      let offset = source.files.get(file) ?? 0;
      const buffer = Buffer.alloc(CHUNK_BYTES);
      while (offset < stat.size && !this.disposed) {
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
        const lines = (source.rest + source.decoder.write(chunk)).split("\n");
        source.rest = lines.pop() ?? "";
        for (const line of lines) this.line(source, line);
        // Let the window breathe between chunks of a long transcript.
        await new Promise((resolve) => setImmediate(resolve));
        // Nothing more to read from a session that will not import.
        if (source.reader.skipped?.()) break;
      }
      source.files.set(file, offset);
    } finally {
      await handle.close();
    }
  }

  private line(source: Source, line: string): void {
    source.reader.push(line);
    if (source.harness === "claude-code") nativeRecord(source, line);
  }

  private async deliver(source: Source): Promise<void> {
    const transcript = source.reader.read({ now: this.now() });
    if (!transcript) return;
    if (
      source.harness === "codex" &&
      (await this.codexImportedFromClaude()).has(transcript.nativeSessionId)
    ) {
      // Codex Desktop's copy of a Claude Code chat: the original comes itself.
      this.skip(source, null);
      return;
    }
    const started = Date.parse(transcript.startedAt);
    const state = this.readState();
    const profiles = this.deps.profiles().filter((profile) => {
      const since = state.since[profile.id]?.[source.harness];
      return (
        profile.importers[source.harness] !== undefined &&
        since !== undefined &&
        started >= Date.parse(since)
      );
    });
    if (profiles.length === 0) {
      // It started before importing was on: no backfill.
      this.skip(source, null);
      return;
    }
    const targets: { profile: ImportingProfile; projectId: string }[] = [];
    for (const profile of profiles) {
      const projectId = await this.projectFor(profile, transcript.cwd);
      if (projectId) targets.push({ profile, projectId });
    }
    if (targets.length === 0) {
      // No project of any profile's holds it, until projects change.
      this.skip(source, this.projectsKey());
      return;
    }
    const sourcePath = [...source.files.keys()].at(-1) ?? "";
    const contentSha256 = source.hash.copy().digest("hex");
    const native = source.native;
    // Its records are kept until every project that holds the chat has them.
    let delivered = true;
    for (const { profile, projectId } of targets) {
      if (this.disposed) return;
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
        this.skip(source, null);
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
    const last = transcript.turns.at(-1);
    if (
      last &&
      (last.completedAt === null ||
        last.items.some((item) => item.status === "in_progress"))
    )
      this.schedule(sourcePath, REREAD_OPEN_MS);
  }

  /** The profiles' projects and folders: a session no project held waits for a change. */
  private projectsKey(): string {
    return JSON.stringify(
      this.deps
        .profiles()
        .map((profile) =>
          profile.projectIds.map((id) => [id, this.deps.projectRoot(id)]),
        ),
    );
  }

  /** The profile's project whose folder holds `cwd`, or its main checkout. */
  private async projectFor(
    profile: ImportingProfile,
    cwd: string,
  ): Promise<string | undefined> {
    // A folder as picked and as the CLI saw it: `/tmp` is `/private/tmp`.
    const roots: { id: string; root: string }[] = [];
    for (const id of profile.projectIds) {
      const root = this.deps.projectRoot(id);
      if (!root) continue;
      roots.push({ id, root }, { id, root: await this.realRoot(root) });
    }
    const within = (directory: string) => {
      let best: { id: string; depth: number } | undefined;
      for (const { id, root } of roots) {
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

  private async realRoot(root: string): Promise<string> {
    const known = this.realRoots.get(root);
    if (known) return known;
    const real = await fsp.realpath(root).catch(() => root);
    this.realRoots.set(root, real);
    return real;
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

/** A state file's times per tool. */
function harnessTimes(
  value: unknown,
): Partial<Record<ImportedHarness, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [ImportedHarness, string] =>
        (entry[0] === "claude-code" || entry[0] === "codex") &&
        typeof entry[1] === "string",
    ),
  );
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
