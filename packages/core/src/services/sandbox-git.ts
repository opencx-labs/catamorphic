import { formatEnvFile } from "@catamorphic/agent-protocol/runner";
import {
  buildSeedPack,
  seedPackInstallScript,
  shellQuote,
} from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";

/**
 * Git inside a session's sandbox (ADRs 0175, 0178). The project checkout
 * is a real repository: at a workspace base it holds that commit and the
 * session's history back to it; otherwise a local baseline. The ref
 * `refs/work/synced` marks what the control plane last copied back, so the
 * agent may commit, branch, and push freely without hiding its work from
 * the per-turn sync.
 */

/** Work's own files in a sandbox, beside (never inside) the project. */
export const SESSION_DIRECTORY = ".work-session";

const AGENT = `-c 'user.name=Work Agent' -c user.email=agent@work.software`;

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
    { cwd: input.cwd, timeout: 600 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Failed to ${input.what}: ${result.result.slice(-2000)}`);
  return result.result;
}

function originScript(originUrl: string | null): string {
  if (!originUrl) return "true";
  const url = shellQuote(originUrl);
  return `(git remote get-url origin >/dev/null 2>&1 && git remote set-url origin ${url} || git remote add origin ${url})`;
}

/**
 * A sandbox without a workspace base: a local repository whose baseline
 * commit is whatever the host uploaded. `origin` names the project's linked
 * remote so `git fetch origin` works through the gateway.
 */
export async function ensureSandboxBaseline(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  originUrl: string | null;
}): Promise<void> {
  await run({
    ...input,
    cwd: input.projectDir,
    what: "prepare sandbox git baseline",
    command: [
      "(git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main)",
      "git add -A",
      // An empty workspace still gets a baseline, so HEAD always exists.
      `(git ${AGENT} commit -m baseline --quiet || git rev-parse -q --verify HEAD >/dev/null || git ${AGENT} commit --allow-empty -m baseline --quiet)`,
      "git update-ref refs/work/synced HEAD",
      originScript(input.originUrl),
    ].join(" && "),
  });
}

/**
 * Seed (or re-seed after a base move) the sandbox repository from the
 * session's copy on the control plane: its head and history back to the
 * workspace base arrive as one shallow pack, uploaded rather than fetched,
 * so seeding costs no Git traffic and needs no credential. The checkout
 * stands on the base with the session's saved work uncommitted on top.
 * Does nothing when the sandbox already stands on this base.
 */
export async function seedSandboxRepository(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  sessionCopyPath: string;
  head: string;
  base: string;
  branch: string;
  originUrl: string | null;
}): Promise<{ seeded: boolean }> {
  const current = await input.provider.executeCommand(
    input.sandboxId,
    "git rev-parse -q --verify refs/work/base 2>/dev/null || true",
    { cwd: input.projectDir },
  );
  if (current.exitCode === 0 && current.result.trim() === input.base)
    return { seeded: false };
  const { pack, shallow } = await buildSeedPack({
    repoPath: input.sessionCopyPath,
    head: input.head,
    base: input.base,
  });
  const root = input.provider.workspaceRoot;
  await input.provider.uploadFiles(
    input.sandboxId,
    { "seed.pack.b64": Buffer.from(pack).toString("base64") },
    `${root}/${SESSION_DIRECTORY}`,
  );
  await run({
    ...input,
    cwd: input.projectDir,
    what: "seed the sandbox repository",
    command: [
      "(git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main)",
      seedPackInstallScript({
        packFile: `../${SESSION_DIRECTORY}/seed.pack.b64`,
        shallow,
      }),
      `git checkout -q -f -B ${shellQuote(input.branch)} ${input.head}`,
      "git clean -fdq",
      // The branch stands on the base; the session's saved work (its
      // checkpoints since the base) is in the working tree, uncommitted, so
      // Work's own checkpoint commits never reach anything the agent pushes.
      `git reset -q ${input.base}`,
      `git update-ref refs/work/base ${input.base}`,
      `git update-ref refs/work/synced ${input.head}`,
      originScript(input.originUrl),
    ].join(" && "),
  });
  return { seeded: true };
}

/** One Git-capable alias as the sandbox configures it. */
export interface SandboxGitAlias {
  alias: string;
  remoteBaseUrls: readonly string[];
}

/** Where the session's grant for `alias` lives in its sandbox. */
export function sandboxGrantFile(input: {
  provider: SandboxProvider;
  alias: string;
}): string {
  return `${input.provider.workspaceRoot}/${SESSION_DIRECTORY}/grants/${input.alias}`;
}

/**
 * The gateway's variables file (ADR 0212), relative to the session
 * directory: beside the secrets file, and not secret itself. It names
 * where code reaches each HTTP API alias and where the alias's grant is.
 */
export const GATEWAY_ENV_IN_SESSION_DIRECTORY = "env/gateway.sh";

/** One HTTP API alias as code in the sandbox reaches it (ADR 0212). */
export interface SandboxHttpAlias {
  alias: string;
  /** `<gateway>/http/<alias>`, as the sandbox reaches it. */
  url: string;
}

/**
 * The variable holding an HTTP API alias's gateway URL (ADR 0212):
 * `WORK_HTTP_` and the alias in SCREAMING_SNAKE_CASE (`logs-eu` is
 * `WORK_HTTP_LOGS_EU`). The same name with `_GRANT_FILE` after it holds
 * the path of the alias's grant file.
 */
export function httpAliasVariable(alias: string): string {
  return `WORK_HTTP_${alias.toUpperCase().replaceAll("-", "_")}`;
}

/** Where the sandbox's real session directory goes in a template. */
const ROOT = "@ROOT@";

/**
 * The gateway's variables file before the sandbox says where it really
 * is: each HTTP alias's URL and grant file. An alias whose names an
 * earlier one already took (`logs-eu` after `logs_eu`) gets none; it is
 * still reached at its URL.
 */
function gatewayEnvTemplate(aliases: readonly SandboxHttpAlias[]): string {
  const variables: Record<string, string> = {};
  for (const http of aliases) {
    const name = httpAliasVariable(http.alias);
    const grantFile = `${name}_GRANT_FILE`;
    if (name in variables || grantFile in variables) {
      console.warn(
        `[catamorphic] HTTP alias '${http.alias}' shares its variable names with another alias; it gets none`,
      );
      continue;
    }
    variables[name] = http.url;
    variables[grantFile] = `${ROOT}/grants/${http.alias}`;
  }
  return `# Work's gateway (ADR 0212): HTTP APIs this session may call. Read the grant file for each request: it changes as the session's grant renews.\n${formatEnvFile(variables)}`;
}

/**
 * A shell loop that copies `from` to `to`, replacing the first `@ROOT@` on
 * each line with `$root` literally, whatever the path holds (spaces, #, &).
 */
function withRoot(from: string, to: string): string {
  return `while IFS= read -r line; do case "$line" in *${ROOT}*) printf '%s%s%s\\n' "\${line%%${ROOT}*}" "$root" "\${line#*${ROOT}}";; *) printf '%s\\n' "$line";; esac; done < ${from} > ${to}`;
}

/**
 * Commands (run in the session directory) that put the gateway's
 * variables file in place from its uploaded template, or, without HTTP
 * aliases, take an earlier turn's away. Values are single-quoted, so a
 * session directory whose path holds a quote gets no file.
 */
function gatewayEnvScript(write: boolean): string {
  const file = GATEWAY_ENV_IN_SESSION_DIRECTORY;
  if (!write) return `rm -f ${file} ${file}.in`;
  return [
    "root=$(pwd -P)",
    `case "$root" in *\\'*) rm -f ${file} ${file}.in;; *) ${withRoot(`${file}.in`, `${file}.new`)} && chmod 644 ${file}.new && mv -f ${file}.new ${file} && rm -f ${file}.in;; esac`,
  ].join(" && ");
}

/**
 * Write the session's grants (ADRs 0175, 0180, 0212), one file per alias;
 * a Git configuration that sends every remote under a Git alias's base
 * URLs to the gateway, answering credential prompts with the current
 * grant; and the gateway's variables file naming each HTTP alias's URL and
 * grant file. Idempotent: renewing only rewrites the grant files. The Git
 * configuration lives in the sandbox's global Git config, so any clone
 * uses it. Model harnesses and code calling HTTP aliases read their
 * alias's grant file at each use.
 */
export async function configureSandboxGateway(input: {
  provider: SandboxProvider;
  sandboxId: string;
  /** `<gateway>/git`, as the sandbox reaches it. */
  gatewayGitUrl: string;
  grants: readonly { alias: string; grant: string }[];
  gitAliases: readonly SandboxGitAlias[];
  /** HTTP API aliases code in the sandbox may call (ADR 0212). */
  httpAliases?: readonly SandboxHttpAlias[];
  renewOnly?: boolean;
}): Promise<void> {
  const directory = `${input.provider.workspaceRoot}/${SESSION_DIRECTORY}`;
  const gateway = input.gatewayGitUrl.replace(/\/+$/, "");
  const httpAliases = input.httpAliases ?? [];
  const gatewayEnv =
    !input.renewOnly && httpAliases.length > 0
      ? gatewayEnvTemplate(httpAliases)
      : undefined;
  await input.provider.uploadFiles(
    input.sandboxId,
    {
      ...Object.fromEntries(
        input.grants.map((grant) => [`grants/${grant.alias}`, grant.grant]),
      ),
      ...(gatewayEnv
        ? { [`${GATEWAY_ENV_IN_SESSION_DIRECTORY}.in`]: gatewayEnv }
        : {}),
    },
    directory,
  );
  // A turn's aliases stand for its whole turn: renewing leaves them be.
  const env = input.renewOnly
    ? []
    : [gatewayEnvScript(gatewayEnv !== undefined)];
  if (input.renewOnly || input.gitAliases.length === 0) {
    await run({
      ...input,
      cwd: directory,
      what: "renew the session's gateway grants",
      // Without Git aliases, an earlier turn's rewrites must not send
      // remotes to aliases this session no longer holds.
      command: [
        "chmod 600 grants/*",
        ...(input.renewOnly
          ? []
          : ["{ [ ! -f gitconfig ] || : > gitconfig; }"]),
        ...env,
      ].join(" && "),
    });
    return;
  }
  const helper = [
    "#!/bin/sh",
    "# Work's Git gateway credential helper (ADR 0175). It answers with this",
    "# session's current grant for one connection alias; the control plane",
    "# renews the grant while the session runs. A grant works only against",
    "# the gateway, never against the remote itself.",
    '[ "$2" = get ] || exit 0',
    "cat >/dev/null",
    'dir=$(cd "$(dirname "$0")" && pwd)',
    `printf 'username=work\\npassword=%s\\n' "$(cat "$dir/grants/$1")"`,
    "",
  ].join("\n");
  const config = [
    `[credential "${originOf(gateway)}"]`,
    "\tuseHttpPath = true",
    ...input.gitAliases.flatMap((alias) => [
      `[credential "${gateway}/${alias.alias}/"]`,
      // An empty helper first drops system helpers (a keychain) for the
      // gateway, so a grant is never stored outside the sandbox's files.
      "\thelper =",
      // A shell command (`!`), so the path can be quoted.
      `\thelper = "!'@ROOT@/git-credential-work' ${alias.alias}"`,
      `[url "${gateway}/${alias.alias}/"]`,
      ...alias.remoteBaseUrls.map(
        (base) => `\tinsteadOf = ${base.endsWith("/") ? base : `${base}/`}`,
      ),
    ]),
    "",
  ].join("\n");
  await input.provider.uploadFiles(
    input.sandboxId,
    { "git-credential-work": helper, "gitconfig.in": config },
    directory,
  );
  await run({
    ...input,
    cwd: directory,
    what: "configure Git for the gateway",
    command: [
      "chmod 700 git-credential-work",
      "chmod 600 grants/*",
      "root=$(pwd -P)",
      // Quoted in the config and for the shell; these would need escaping.
      `case "$root" in *[\\'\\"\\\\]*) echo "The sandbox path $root holds a quote or backslash" >&2; exit 1;; esac`,
      withRoot("gitconfig.in", "gitconfig"),
      "rm -f gitconfig.in",
      `(git config --global --get-all include.path 2>/dev/null | grep -Fqx "$root/gitconfig" || git config --global --add include.path "$root/gitconfig")`,
      ...env,
    ].join(" && "),
  });
}

/**
 * Take the session's grant files and the gateway's variables file (ADRs
 * 0175, 0212) out of its sandbox when its grants are revoked with the
 * workspace: nothing there names a dead grant afterwards. Safe to repeat.
 */
export async function removeSandboxGateway(input: {
  provider: SandboxProvider;
  sandboxId: string;
  /** The sandbox path of the project checkout (the command's cwd). */
  projectDir: string;
}): Promise<void> {
  const session = `../${SESSION_DIRECTORY}`;
  const file = `${session}/${GATEWAY_ENV_IN_SESSION_DIRECTORY}`;
  await run({
    ...input,
    cwd: input.projectDir,
    what: "remove the session's gateway grants",
    command: `rm -rf ${session}/grants ${file} ${file}.in ${file}.new`,
  });
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
