import { randomUUID } from "node:crypto";
import path from "node:path";
import { formatEnvFile } from "@catamorphic/agent-protocol/runner";
import {
  buildSeedPack,
  seedPackInstallScript,
  shellQuote,
} from "@catamorphic/git";
import {
  CONNECTION_GRANT_READER,
  type SandboxProvider,
} from "@catamorphic/sandbox";

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
  /**
   * The checkout holds the base alone and what a setup made on it (ADR
   * 0257): seed whatever its refs say, and keep the files Git does not
   * track, which that setup made. Otherwise they go, as after a base move.
   */
  afterSetup?: boolean;
}): Promise<{ seeded: boolean }> {
  const current = input.afterSetup
    ? undefined
    : await input.provider.executeCommand(
        input.sandboxId,
        "git rev-parse -q --verify refs/work/base 2>/dev/null || true",
        { cwd: input.projectDir },
      );
  if (current?.exitCode === 0 && current.result.trim() === input.base)
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
      ...(input.afterSetup ? [] : ["git clean -fdq"]),
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

/**
 * Seed the sandbox repository with the workspace's base commit alone (ADR
 * 0257): all a setup on its own network may see. Uploaded as one shallow
 * pack, like {@link seedSandboxRepository}, so it needs no grant. It leaves
 * `refs/work/base` unset, so that seeding still brings the session's saved
 * work once the sandbox is narrow again.
 */
export async function seedSandboxBase(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  sessionCopyPath: string;
  base: string;
}): Promise<void> {
  const { pack, shallow } = await buildSeedPack({
    repoPath: input.sessionCopyPath,
    head: input.base,
    base: input.base,
  });
  const root = input.provider.workspaceRoot;
  await input.provider.uploadFiles(
    input.sandboxId,
    { "seed.pack.b64": Buffer.from(pack).toString("base64") },
    `${root}/${SESSION_DIRECTORY}`,
  );
  // Paths relative to the workspace root, the command's folder: only that
  // is resolved for commands on every provider.
  const project = path.posix.relative(root, input.projectDir);
  await run({
    ...input,
    cwd: root,
    what: "seed the sandbox with its base",
    command: [
      `mkdir -p ${shellQuote(project)}`,
      `cd ${shellQuote(project)}`,
      "(git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main)",
      seedPackInstallScript({
        packFile: `../${SESSION_DIRECTORY}/seed.pack.b64`,
        shallow,
      }),
      `git checkout -q -f --detach ${input.base}`,
      // Nothing but the base: ignored files too.
      "git clean -ffdqx",
    ].join(" && "),
  });
}

/**
 * Take every grant, secret and gateway variable out of a sandbox's session
 * directory (ADR 0257), before its setup's network is opened. A sandbox
 * this preparation made holds none; this makes sure.
 */
export async function removeSessionCredentials(input: {
  provider: SandboxProvider;
  sandboxId: string;
}): Promise<void> {
  await run({
    ...input,
    cwd: input.provider.workspaceRoot,
    what: "clear the sandbox's grants and variables",
    command: `rm -rf ${SESSION_DIRECTORY}/grants ${SESSION_DIRECTORY}/model-grants ${SESSION_DIRECTORY}/grant-staging ${SESSION_DIRECTORY}/env ${SESSION_DIRECTORY}/gitconfig`,
  });
}

/** One Git-capable alias as the sandbox configures it. */
export interface SandboxGitAlias {
  alias: string;
  remoteBaseUrls: readonly string[];
}

/** Where the session's grant for `alias` lives in its sandbox. */
export function sandboxGrantDirectory(input: {
  provider: SandboxProvider;
  alias: string;
  /** Model readers stay on their own attempt during overlapping renewal uploads. */
  modelAttemptId?: string;
}): string {
  const relative = input.modelAttemptId
    ? `model-grants/${input.modelAttemptId}/${input.alias}`
    : `grants/${input.alias}`;
  return `${input.provider.workspaceRoot}/${SESSION_DIRECTORY}/${relative}`;
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
 * `WORK_HTTP_LOGS_EU`). The same name with `_GRANT_DIRECTORY` after it holds
 * the path of the alias's append-only grant directory.
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
  const variables: Record<string, string> = {
    WORK_GATEWAY_READ_GRANT: `${ROOT}/read-grant`,
  };
  for (const http of aliases) {
    const name = httpAliasVariable(http.alias);
    const grantDirectory = `${name}_GRANT_DIRECTORY`;
    if (name in variables || grantDirectory in variables) {
      console.warn(
        `[catamorphic] HTTP alias '${http.alias}' shares its variable names with another alias; it gets none`,
      );
      continue;
    }
    variables[name] = http.url;
    variables[grantDirectory] = `${ROOT}/grants/${http.alias}`;
  }
  return `# Work's gateway (ADR 0212): HTTP APIs this session may call. Read the greatest grant revision for each request with WORK_GATEWAY_READ_GRANT.\n${formatEnvFile(variables)}`;
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
 * Publish immutable grant revisions (ADRs 0175, 0180, 0212, 0293);
 * a Git configuration that sends every remote under a Git alias's base
 * URLs to the gateway, answering credential prompts with the current
 * grant; and the gateway's variables file naming each HTTP alias's URL and
 * grant directory. Renewal appends immutable revisions. The Git
 * configuration lives in the sandbox's global Git config, so any clone
 * uses it. Model harnesses and code calling HTTP aliases read their
 * alias's greatest published grant revision at each use.
 */
export async function configureSandboxGateway(input: {
  provider: SandboxProvider;
  sandboxId: string;
  /** `<gateway>/git`, as the sandbox reaches it. */
  gatewayGitUrl: string;
  grants: readonly {
    alias: string;
    grant: string;
    publicationRevision: string;
    modelAttemptId?: string;
  }[];
  gitAliases: readonly SandboxGitAlias[];
  httpAliases?: readonly SandboxHttpAlias[];
  renewOnly?: boolean;
}): Promise<void> {
  if (!input.grants.length) return;
  for (const grant of input.grants)
    if (!/^[1-9][0-9]*$/.test(grant.publicationRevision))
      throw new Error(
        "A sandbox grant needs its persisted publication revision",
      );
  const stage = `grant-staging/${randomUUID()}`;
  const directory = `${input.provider.workspaceRoot}/${SESSION_DIRECTORY}`;
  const gateway = input.gatewayGitUrl.replace(/\/+$/, "");
  const httpAliases = input.httpAliases ?? [];
  const gatewayEnv =
    !input.renewOnly && httpAliases.length > 0
      ? gatewayEnvTemplate(httpAliases)
      : undefined;
  const git = !input.renewOnly && input.gitAliases.length > 0;
  const helper = [
    "#!/bin/sh",
    '[ "$2" = get ] || exit 0',
    "cat >/dev/null",
    'dir=$(cd "$(dirname "$0")" && pwd)',
    'grant=$("$dir/read-grant" "$dir/grants/$1") || exit 1',
    `printf 'username=work\\npassword=%s\\n' "$grant"`,
    "",
  ].join("\n");
  const config = [
    `[credential "${originOf(gateway)}"]`,
    "\tuseHttpPath = true",
    ...input.gitAliases.flatMap((alias) => [
      `[credential "${gateway}/${alias.alias}/"]`,
      "\thelper =",
      `\thelper = "!'@ROOT@/git-credential-work' ${alias.alias}"`,
      `[url "${gateway}/${alias.alias}/"]`,
      ...alias.remoteBaseUrls.map(
        (base) => `\tinsteadOf = ${base.endsWith("/") ? base : `${base}/`}`,
      ),
    ]),
    "",
  ].join("\n");
  const files = input.grants.flatMap((grant) => {
    const revisions: [string, string][] = [
      [`grants/${grant.alias}/${grant.publicationRevision}`, grant.grant],
    ];
    if (grant.modelAttemptId)
      revisions.push([
        `model-grants/${grant.modelAttemptId}/${grant.alias}/${grant.publicationRevision}`,
        grant.grant,
      ]);
    return revisions;
  });
  // No current-token file or pointer exists. Only finished immutable revisions
  // become visible; old uploads can add an older revision, never replace one.
  await input.provider.uploadFiles(
    input.sandboxId,
    {
      ...Object.fromEntries(files),
      "read-grant": `#!/bin/sh\n${CONNECTION_GRANT_READER}\n`,
      ...(gatewayEnv
        ? { [`${GATEWAY_ENV_IN_SESSION_DIRECTORY}.in`]: gatewayEnv }
        : {}),
      ...(git ? { "git-credential-work": helper, "gitconfig.in": config } : {}),
    },
    `${directory}/${stage}`,
  );
  await run({
    ...input,
    cwd: directory,
    what: "publish the session's gateway grants",
    command: [
      "set -e",
      `trap ${shellQuote(`rm -rf ${shellQuote(stage)}`)} EXIT`,
      `chmod 700 ${shellQuote(`${stage}/read-grant`)}`,
      `mv -f ${shellQuote(`${stage}/read-grant`)} read-grant`,
      ...files.flatMap(([file]) => [
        `mkdir -p ${shellQuote(path.posix.dirname(file))}`,
        `chmod 600 ${shellQuote(`${stage}/${file}`)}`,
        // Same revision means the same persisted bearer. A retry never replaces it.
        `mv -n ${shellQuote(`${stage}/${file}`)} ${shellQuote(file)}`,
      ]),
      "chmod 700 grants",
      ...(input.grants.some((grant) => grant.modelAttemptId)
        ? ["chmod 700 model-grants"]
        : []),
      ...(input.renewOnly
        ? []
        : [
            ...(gatewayEnv
              ? [
                  `mkdir -p ${shellQuote(path.posix.dirname(GATEWAY_ENV_IN_SESSION_DIRECTORY))}`,
                  `mv -f ${shellQuote(`${stage}/${GATEWAY_ENV_IN_SESSION_DIRECTORY}.in`)} ${shellQuote(`${GATEWAY_ENV_IN_SESSION_DIRECTORY}.in`)}`,
                ]
              : []),
            ...(git
              ? [
                  `mv -f ${shellQuote(`${stage}/git-credential-work`)} git-credential-work`,
                  "chmod 700 git-credential-work",
                  `mv -f ${shellQuote(`${stage}/gitconfig.in`)} gitconfig.in`,
                  "root=$(pwd -P)",
                  `case "$root" in *[\\'\\"\\\\]*) echo "The sandbox path $root holds a quote or backslash" >&2; exit 1;; esac`,
                  withRoot("gitconfig.in", "gitconfig"),
                  "rm -f gitconfig.in",
                  `(git config --global --get-all include.path 2>/dev/null | grep -Fqx "$root/gitconfig" || git config --global --add include.path "$root/gitconfig")`,
                ]
              : ["{ [ ! -f gitconfig ] || : > gitconfig; }"]),
            gatewayEnvScript(gatewayEnv !== undefined),
          ]),
    ].join("\n"),
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
    command: `rm -rf ${session}/grants ${session}/model-grants ${session}/grant-staging ${file} ${file}.in ${file}.new`,
  });
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
