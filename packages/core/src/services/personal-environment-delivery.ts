import { shellQuote } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import type { UnsealedPersonalEnvironment } from "./personal-environment-service.js";
import { SESSION_DIRECTORY } from "./sandbox-git.js";

/*
 * A member's personal environment inside one of their own chats' sandboxes
 * (ADR 0184). Files land at
 * their repository paths after the sandbox's Git baseline and are listed
 * in the repository's `.git/info/exclude`, so sync-back, checkpoints,
 * proposals and pushes never carry them. A path the repository tracks is
 * refused rather than replaced, and so is one that would be written
 * through a symbolic link.
 */

/** From the project folder (a command's cwd), the session's own directory. */
const SESSION_FROM_PROJECT = `../${SESSION_DIRECTORY}`;

const PERSONAL = `${SESSION_FROM_PROJECT}/personal`;
const INCOMING = `${PERSONAL}/incoming`;

const EXCLUDE_BEGIN = "# BEGIN Work personal files (ADR 0184)";
const EXCLUDE_END = "# END Work personal files";

/**
 * Shell functions (POSIX sh) run from the project folder. `work_tracked`
 * says whether the repository tracks a path (the index, the synced
 * baseline, or HEAD). `work_unsafe` says whether writing or removing it
 * could reach anything but its own place in the project: a symbolic link
 * anywhere on the way (the path itself included), a folder that resolves
 * elsewhere, a file where a folder must be, or something other than a
 * plain file at the end.
 */
const PATH_CHECKS = [
  `work_tracked() { git ls-files --error-unmatch -- ":(literal)$1" >/dev/null 2>&1 || git cat-file -e "refs/work/synced:$1" 2>/dev/null || git cat-file -e "HEAD:$1" 2>/dev/null; }`,
  "work_root=$(pwd -P)",
  "work_unsafe() {",
  '  work_rest=$1; work_at=""',
  '  while [ -n "$work_rest" ]; do',
  "    case $work_rest in",
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: shell parameter expansions
  "      */*) work_part=${work_rest%%/*}; work_rest=${work_rest#*/} ;;",
  '      *) work_part=$work_rest; work_rest="" ;;',
  "    esac",
  "    work_at=${work_at:+$work_at/}$work_part",
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: shell parameter expansions
  '    if [ -L "$work_at" ]; then return 0; fi',
  '    if [ -d "$work_at" ]; then',
  '      [ "$(cd -P -- "$work_at" 2>/dev/null && pwd -P)" = "$work_root/$work_at" ] || return 0',
  '    elif [ -e "$work_at" ] && [ -n "$work_rest" ]; then',
  "      return 0",
  "    fi",
  "  done",
  '  if [ -e "$work_at" ] && [ ! -f "$work_at" ]; then return 0; fi',
  "  return 1",
  "}",
].join("\n");

/** One repository path as a gitignore pattern that matches only itself. */
export function gitignoreLiteral(path: string): string {
  const escaped = path.replace(/[*?[]/g, (character) => `\\${character}`);
  const trailing = escaped.replace(/ +$/, (spaces) =>
    spaces.replaceAll(" ", "\\ "),
  );
  return `/${trailing}`;
}

/** The block this module owns in `.git/info/exclude`. */
export function personalExcludeBlock(paths: readonly string[]): string {
  return [EXCLUDE_BEGIN, ...paths.map(gitignoreLiteral), EXCLUDE_END, ""].join(
    "\n",
  );
}

interface Manifest {
  files: Record<string, string>;
}

function parseManifest(text: string): Manifest {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) throw new Error();
    const files = "files" in value ? value.files : undefined;
    const strings = (entry: unknown): Record<string, string> =>
      typeof entry === "object" && entry !== null
        ? Object.fromEntries(
            Object.entries(entry).filter(
              (pair): pair is [string, string] => typeof pair[1] === "string",
            ),
          )
        : {};
    return { files: strings(files) };
  } catch {
    return { files: {} };
  }
}

async function run(input: {
  provider: SandboxProvider;
  sandboxId: string;
  cwd: string;
  command: string;
  what: string;
}): Promise<string> {
  const result = await input.provider.executeCommand(
    input.sandboxId,
    input.command,
    { cwd: input.cwd, timeout: 120 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Failed to ${input.what}: ${result.result.slice(-2000)}`);
  return result.result;
}

/**
 * Deliver the member's files into the sandbox. Files already there with
 * the same content are left alone (the agent may have edited its copy);
 * files dropped from the member's set are removed.
 * Returns what changed (for the audit), the paths refused because the
 * repository tracks them, and those refused because writing them could
 * land anywhere but their own place in the project.
 */
export async function deliverPersonalEnvironment(input: {
  provider: SandboxProvider;
  sandboxId: string;
  /** The sandbox path of the project checkout. */
  projectDir: string;
  environment: UnsealedPersonalEnvironment;
}): Promise<{
  delivered: Array<{
    kind: "file";
    name: string;
    fingerprint: string;
  }>;
  refused: string[];
  unsafe: string[];
}> {
  const { provider, sandboxId, projectDir, environment } = input;
  const paths = environment.files.map((file) => file.path);
  const state = await run({
    provider,
    sandboxId,
    cwd: projectDir,
    what: "read the sandbox's personal files",
    command: [
      `cat ${PERSONAL}/manifest.json 2>/dev/null || true`,
      "printf '\\n'",
      PATH_CHECKS,
      ...paths.map(
        (path) =>
          `if work_tracked ${shellQuote(path)}; then printf 'tracked\\t%s\\n' ${shellQuote(path)}; elif work_unsafe ${shellQuote(path)}; then printf 'unsafe\\t%s\\n' ${shellQuote(path)}; fi`,
      ),
    ].join("\n"),
  });
  const lines = state.split("\n");
  const previous = parseManifest(lines[0] ?? "");
  const marked = (mark: string) =>
    new Set(
      lines
        .filter((line) => line.startsWith(`${mark}\t`))
        .map((line) => line.slice(mark.length + 1)),
    );
  const tracked = marked("tracked");
  const unsafe = marked("unsafe");
  const files = environment.files.filter(
    (file) => !tracked.has(file.path) && !unsafe.has(file.path),
  );
  const changed = files.filter(
    (file) => previous.files[file.path] !== file.fingerprint,
  );
  const placed = new Set(files.map((file) => file.path));
  // A path the repository now tracks (a teammate committed it) or that now
  // leads elsewhere is never removed; removal checks again below.
  const stale = Object.keys(previous.files).filter(
    (path) => !placed.has(path) && !tracked.has(path) && !unsafe.has(path),
  );
  const manifest: Manifest = {
    files: Object.fromEntries(
      files.map((file) => [file.path, file.fingerprint]),
    ),
  };
  await provider.uploadFiles(
    sandboxId,
    {
      "manifest.json": JSON.stringify(manifest),
      files: files.map((file) => `${file.path}\n`).join(""),
      exclude: personalExcludeBlock(files.map((file) => file.path)),
      ...Object.fromEntries(
        changed.map((file, index) => [
          `${index}.b64`,
          file.content.toString("base64"),
        ]),
      ),
    },
    `${provider.workspaceRoot}/${SESSION_DIRECTORY}/personal/incoming`,
  );
  await run({
    provider,
    sandboxId,
    cwd: projectDir,
    what: "place your personal files in the sandbox",
    command: [
      "set -e",
      PATH_CHECKS,
      ...stale.map(
        (path) =>
          `if ! work_tracked ${shellQuote(path)} && ! work_unsafe ${shellQuote(path)}; then rm -f -- ${shellQuote(path)}; fi`,
      ),
      // Checked again right before writing; a fresh file breaks any link
      // the old one had, and is the sandbox user's alone from the start.
      ...changed.map(
        (file, index) =>
          `if ! work_unsafe ${shellQuote(file.path)}; then mkdir -p -- "$(dirname -- ${shellQuote(file.path)})" && rm -f -- ${shellQuote(file.path)} && (umask 077 && base64 -d < ${INCOMING}/${index}.b64 > ${shellQuote(file.path)}); fi`,
      ),
      "ex=$(git rev-parse --git-path info/exclude)",
      'mkdir -p "$(dirname "$ex")"',
      'touch "$ex"',
      `awk -v begin=${shellQuote(EXCLUDE_BEGIN)} -v end=${shellQuote(EXCLUDE_END)} '$0 == begin { skip = 1; next } $0 == end { skip = 0; next } !skip' "$ex" > "$ex.work"`,
      `cat ${INCOMING}/exclude >> "$ex.work"`,
      'mv "$ex.work" "$ex"',
      `mv ${INCOMING}/manifest.json ${PERSONAL}/manifest.json`,
      `mv ${INCOMING}/files ${PERSONAL}/files`,
      `rm -rf ${INCOMING}`,
    ].join("\n"),
  });
  const delivered = changed.map((file) => ({
    kind: "file" as const,
    name: file.path,
    fingerprint: file.fingerprint,
  }));
  return { delivered, refused: [...tracked], unsafe: [...unsafe] };
}

/**
 * Take the member's files back out of the sandbox: on close,
 * idle release, and moves, and before a turn that may not have them (ADR
 * 0184). Safe to repeat, and a no-op where nothing was delivered.
 */
export async function removePersonalEnvironment(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
}): Promise<void> {
  await run({
    provider: input.provider,
    sandboxId: input.sandboxId,
    cwd: input.projectDir,
    what: "remove your personal files from the sandbox",
    command: [
      // Most sandboxes never received anything.
      `if [ ! -d ${PERSONAL} ]; then exit 0; fi`,
      PATH_CHECKS,
      // Never a path the repository tracks by now, or one leading elsewhere.
      `if [ -f ${PERSONAL}/files ]; then while IFS= read -r p; do if [ -n "$p" ] && ! work_tracked "$p" && ! work_unsafe "$p"; then rm -f -- "$p"; fi; done < ${PERSONAL}/files; fi`,
      // Git sees those paths again, should the agent make its own.
      `if ex=$(git rev-parse --git-path info/exclude 2>/dev/null) && [ -f "$ex" ]; then awk -v begin=${shellQuote(EXCLUDE_BEGIN)} -v end=${shellQuote(EXCLUDE_END)} '$0 == begin { skip = 1; next } $0 == end { skip = 0; next } !skip' "$ex" > "$ex.work" && mv "$ex.work" "$ex"; fi`,
      `rm -rf ${PERSONAL}`,
    ].join("\n"),
  });
}
