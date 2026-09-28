import { shellQuote } from "@catamorphic/git";
import type { PersonalLoginKind, SandboxProvider } from "@catamorphic/sandbox";
import type { UnsealedPersonalEnvironment } from "./personal-environment-service.js";
import { SESSION_DIRECTORY } from "./sandbox-git.js";

/*
 * A member's personal environment inside one of their own chats' sandboxes
 * (ADR 0184). Logins live beside the project, under the session's own
 * directory, where only the harness is pointed at them. Files land at
 * their repository paths after the sandbox's Git baseline and are listed
 * in the repository's `.git/info/exclude`, so sync-back, checkpoints,
 * proposals and pushes never carry them. A path the repository tracks is
 * refused rather than replaced.
 */

/** Where one harness's login lives in a sandbox. */
export function personalLoginHome(input: {
  provider: Pick<SandboxProvider, "workspaceRoot">;
  kind: PersonalLoginKind;
}): string {
  return `${input.provider.workspaceRoot}/${SESSION_DIRECTORY}/home/${input.kind === "codex" ? "codex" : "claude"}`;
}

/** The file each harness reads its login from, inside its home. */
const LOGIN_FILES: Record<PersonalLoginKind, string> = {
  "claude-code": ".credentials.json",
  codex: "auth.json",
};

/** From the project folder (a command's cwd), the session's own directory. */
const SESSION_FROM_PROJECT = `../${SESSION_DIRECTORY}`;
const PERSONAL = `${SESSION_FROM_PROJECT}/personal`;
const INCOMING = `${PERSONAL}/incoming`;

const EXCLUDE_BEGIN = "# BEGIN Work personal files (ADR 0184)";
const EXCLUDE_END = "# END Work personal files";

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
  logins: Record<string, string>;
}

function parseManifest(text: string): Manifest {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) throw new Error();
    const files = "files" in value ? value.files : undefined;
    const logins = "logins" in value ? value.logins : undefined;
    const strings = (entry: unknown): Record<string, string> =>
      typeof entry === "object" && entry !== null
        ? Object.fromEntries(
            Object.entries(entry).filter(
              (pair): pair is [string, string] => typeof pair[1] === "string",
            ),
          )
        : {};
    return { files: strings(files), logins: strings(logins) };
  } catch {
    return { files: {}, logins: {} };
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
 * A login as its harness reads it in the sandbox. Codex requires a
 * `tokens.refresh_token` field in `auth.json`; the member's copy never
 * holds one (only their computer renews it), so an empty one stands in and
 * the sandbox's Codex can never renew it.
 */
export function sandboxLoginDocument(input: {
  kind: PersonalLoginKind;
  content: string;
}): string {
  if (input.kind !== "codex") return input.content;
  try {
    const document: unknown = JSON.parse(input.content);
    if (typeof document !== "object" || document === null) return input.content;
    const tokens = "tokens" in document ? document.tokens : undefined;
    if (
      typeof tokens !== "object" ||
      tokens === null ||
      "refresh_token" in tokens
    )
      return input.content;
    return JSON.stringify({
      ...document,
      tokens: { ...tokens, refresh_token: "" },
    });
  } catch {
    return input.content;
  }
}

/** Write the logins into their homes, readable by the sandbox user only. */
export async function writePersonalLogins(input: {
  provider: SandboxProvider;
  sandboxId: string;
  logins: UnsealedPersonalEnvironment["logins"];
}): Promise<void> {
  if (input.logins.size === 0) return;
  for (const [kind, login] of input.logins)
    await input.provider.uploadFiles(
      input.sandboxId,
      {
        [LOGIN_FILES[kind]]: sandboxLoginDocument({
          kind,
          content: login.content,
        }),
      },
      personalLoginHome({ provider: input.provider, kind }),
    );
  const root = `${input.provider.workspaceRoot}/${SESSION_DIRECTORY}`;
  await run({
    provider: input.provider,
    sandboxId: input.sandboxId,
    cwd: root,
    what: "protect your login in the sandbox",
    command: [...input.logins.keys()]
      .map(
        (kind) =>
          `chmod 600 ${shellQuote(`home/${kind === "codex" ? "codex" : "claude"}/${LOGIN_FILES[kind]}`)}`,
      )
      .join(" && "),
  });
}

/**
 * Deliver the member's logins and files into the sandbox. Files already
 * there with the same content are left alone (the agent may have edited
 * its copy); files dropped from the member's set are removed. Returns what
 * changed (for the audit) and which paths were refused because the
 * repository tracks them.
 */
export async function deliverPersonalEnvironment(input: {
  provider: SandboxProvider;
  sandboxId: string;
  /** The sandbox path of the project checkout. */
  projectDir: string;
  environment: UnsealedPersonalEnvironment;
}): Promise<{
  delivered: Array<{
    kind: "login" | "file";
    name: string;
    fingerprint: string;
  }>;
  refused: string[];
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
      ...paths.map(
        (path) =>
          `if git ls-files --error-unmatch -- ${shellQuote(`:(literal)${path}`)} >/dev/null 2>&1 || git cat-file -e ${shellQuote(`refs/work/synced:${path}`)} 2>/dev/null || git cat-file -e ${shellQuote(`HEAD:${path}`)} 2>/dev/null; then printf 'tracked\\t%s\\n' ${shellQuote(path)}; fi`,
      ),
    ].join("\n"),
  });
  const lines = state.split("\n");
  const previous = parseManifest(lines[0] ?? "");
  const tracked = new Set(
    lines
      .filter((line) => line.startsWith("tracked\t"))
      .map((line) => line.slice("tracked\t".length)),
  );
  const files = environment.files.filter((file) => !tracked.has(file.path));
  const changed = files.filter(
    (file) => previous.files[file.path] !== file.fingerprint,
  );
  const stale = Object.keys(previous.files).filter(
    (path) => !files.some((file) => file.path === path),
  );
  const manifest: Manifest = {
    files: Object.fromEntries(
      files.map((file) => [file.path, file.fingerprint]),
    ),
    logins: Object.fromEntries(
      [...environment.logins].map(([kind, login]) => [kind, login.fingerprint]),
    ),
  };
  await writePersonalLogins({
    provider,
    sandboxId,
    logins: environment.logins,
  });
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
      ...stale.map((path) => `rm -f -- ${shellQuote(path)}`),
      ...changed.flatMap((file, index) => [
        `mkdir -p -- "$(dirname -- ${shellQuote(file.path)})"`,
        `base64 -d < ${INCOMING}/${index}.b64 > ${shellQuote(file.path)}`,
        `chmod 600 ${shellQuote(file.path)}`,
      ]),
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
  const delivered = [
    ...[...environment.logins]
      .filter(([kind, login]) => previous.logins[kind] !== login.fingerprint)
      .map(([kind, login]) => ({
        kind: "login" as const,
        name: kind,
        fingerprint: login.fingerprint,
      })),
    ...changed.map((file) => ({
      kind: "file" as const,
      name: file.path,
      fingerprint: file.fingerprint,
    })),
  ];
  return { delivered, refused: [...tracked] };
}

/**
 * Take the member's logins and files back out of the sandbox: on close and
 * idle release (ADR 0184). Safe to repeat, and a no-op where nothing was
 * delivered.
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
      `if [ -f ${PERSONAL}/files ]; then while IFS= read -r p; do [ -n "$p" ] && rm -f -- "$p"; done < ${PERSONAL}/files; fi`,
      `rm -rf ${PERSONAL}`,
      `rm -f ${SESSION_FROM_PROJECT}/home/claude/.credentials.json ${SESSION_FROM_PROJECT}/home/codex/auth.json`,
    ].join("\n"),
  });
}
