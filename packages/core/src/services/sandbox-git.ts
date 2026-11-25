import { randomUUID } from "node:crypto";
import path from "node:path";
import { formatEnvFile } from "@catamorphic/agent-protocol/runner";
import {
  buildSeedPack,
  isSessionBranchName,
  nativeGit,
  seedPackInstallScript,
  seedPackParts,
  shellQuote,
} from "@catamorphic/git";
import {
  CONNECTION_GRANT_READER,
  type SandboxProvider,
  type SandboxSide,
} from "@catamorphic/sandbox";

/**
 * Git inside a session's sandbox (ADRs 0175, 0178, 0344). The project
 * checkout is a real repository standing on the workspace's base: it holds
 * that commit, the agent's branch with its commits back to it, and the
 * agent's uncommitted changes. The ref `refs/work/synced` marks the tree
 * the control plane last saved, so the agent may commit, branch, and push
 * freely without hiding its work from the per-turn save.
 */

/** Work's own files in a sandbox, beside (never inside) the project. */
export const SESSION_DIRECTORY = ".work-session";

/**
 * Stands in the session directory once the checkout was seeded: a checkout
 * with no repository is then one that lost it, not one that never had one.
 */
export const SEEDED_FILE = "seeded";

/**
 * The project checkout in a session's sandbox: the one directory both sides
 * of a sandbox that runs commands apart share (ADR 0332).
 */
export function sandboxProjectDirectory(input: {
  workspaceRoot: string;
}): string {
  return `${input.workspaceRoot}/project`;
}

const AGENT = `-c 'user.name=Work Agent' -c user.email=agent@work.software`;

async function run(input: {
  provider: SandboxProvider;
  sandboxId: string;
  cwd: string;
  command: string;
  what: string;
  /** Where in a sandbox that runs commands apart (ADR 0332). */
  side?: SandboxSide;
  /** Seconds; ten minutes when absent. */
  timeout?: number;
  env?: Record<string, string>;
  /** Values that must not appear in a failure's text. */
  mask?: readonly string[];
}): Promise<string> {
  const result = await input.provider.executeCommand(
    input.sandboxId,
    input.command,
    {
      cwd: input.cwd,
      timeout: input.timeout ?? 600,
      ...(input.side ? { side: input.side } : {}),
      ...(input.env ? { env: input.env } : {}),
    },
  );
  if (result.exitCode !== 0) {
    let text = result.result.slice(-2000);
    for (const value of input.mask ?? [])
      if (value) text = text.replaceAll(value, "***");
    throw new Error(`Failed to ${input.what}: ${text}`);
  }
  return result.result;
}

function originScript(originUrl: string | null): string {
  if (!originUrl) return "true";
  const url = shellQuote(originUrl);
  return `(git remote get-url origin >/dev/null 2>&1 && git remote set-url origin ${url} || git remote add origin ${url})`;
}

/** What every uploaded seed pack's parts are named after, beside the project. */
const SEED_PACKS = "seed-*.pack.b64";

/**
 * Upload a seed pack into the session directory, one part an operation,
 * so no operation grows with the pack (ADR 0353), and answer the name its
 * parts carry. Each upload has a name of its own: parts an interrupted
 * upload left behind are never read into a later pack.
 */
async function uploadSeedPack(input: {
  provider: SandboxProvider;
  sandboxId: string;
  pack: Uint8Array;
}): Promise<string> {
  const directory = `${input.provider.workspaceRoot}/${SESSION_DIRECTORY}`;
  const name = SEED_PACKS.replace("*", randomUUID());
  for (const part of seedPackParts({ pack: input.pack, name }))
    await input.provider.uploadFiles(
      input.sandboxId,
      { [part.name]: part.content },
      directory,
    );
  return name;
}

/**
 * Shell that installs an uploaded seed pack and removes every seed pack's
 * parts, those an earlier upload left behind included.
 */
function installSeedPack(input: { name: string; shallow: string[] }): string {
  return [
    seedPackInstallScript({
      packFile: `../${SESSION_DIRECTORY}/${input.name}`,
      shallow: input.shallow,
    }),
    `rm -f ../${SESSION_DIRECTORY}/${SEED_PACKS}.*`,
  ].join(" && ");
}

/**
 * Seed (or re-seed after a base move) the sandbox repository from the
 * session's copy on the control plane (ADR 0344): the agent's HEAD and its
 * history back to the workspace base, and the working tree as last saved.
 * The base itself is fetched (`fetchBase`, ADR 0353) when the checkout
 * does not hold it yet; what the session added to it arrives as a pack,
 * uploaded, so it needs no credential. Without `fetchBase` the pack holds
 * the base too. The checkout comes back on the agent's branch at its HEAD,
 * with what it had not committed uncommitted again (what was staged comes
 * back unstaged). Does nothing when the sandbox already stands on this
 * base, or was seeded and lost its repository since.
 */
export async function seedSandboxRepository(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  sessionCopyPath: string;
  /** The session's checkpoint: its tree is the working tree as saved. */
  checkpoint: string;
  /** The agent's HEAD as saved. */
  head: string;
  base: string;
  branch: string;
  originUrl: string | null;
  /**
   * The checkout holds the base alone and what a setup made on it (ADR
   * 0257): seed whatever its refs say, and keep the files Git does not
   * track, which that setup made, and its changes to tracked files where
   * the saved work leaves them alone. Otherwise they go, as after a base
   * move.
   */
  afterSetup?: boolean;
  /**
   * Bring the base commit into the checkout with the Environment's
   * checkout command (ADR 0353), and say whether it is there now. Called
   * only when the checkout lacks it.
   */
  fetchBase?: () => Promise<boolean>;
}): Promise<{ seeded: boolean }> {
  const base = shellQuote(`${input.base}^{commit}`);
  const current = await input.provider.executeCommand(
    input.sandboxId,
    // Whether the base commit is here already, then where the checkout
    // stands. One that was seeded and has no base now lost its repository
    // (the agent moved or broke it): it says `lost`.
    `git cat-file -e ${base} 2>/dev/null && echo holds-base; git rev-parse -q --verify refs/work/base 2>/dev/null || { [ -e ../${SESSION_DIRECTORY}/${SEEDED_FILE} ] && echo lost; } || true`,
    { cwd: input.projectDir },
  );
  const lines =
    current.exitCode === 0 ? current.result.trim().split(/\s+/) : [];
  // After a setup the refs are not asked: its checkout is seeded whatever
  // they say.
  const stands = input.afterSetup
    ? ""
    : (lines.filter((line) => line !== "holds-base").at(-1) ?? "");
  // Seeding replaces what the checkout holds. One that lost its repository
  // may hold work no save could read: it is left as it is, and its saves
  // say why they fail until the agent puts the repository back.
  if (stands === input.base || stands === "lost") return { seeded: false };
  if (!isSessionBranchName(input.branch))
    throw new Error("The session's branch cannot be checked out");
  const holdsBase =
    lines.includes("holds-base") || ((await input.fetchBase?.()) ?? false);
  const tree = (
    await nativeGit(input.sessionCopyPath, [
      "rev-parse",
      "--verify",
      `${input.checkpoint}^{tree}`,
    ])
  ).trim();
  const { pack, shallow, objects } = await buildSeedPack({
    repoPath: input.sessionCopyPath,
    head: input.head,
    base: input.base,
    tree,
    holdsBase,
  });
  // A session that added nothing to its base has nothing to send.
  const uploaded =
    objects > 0 ? await uploadSeedPack({ ...input, pack }) : undefined;
  const branch = shellQuote(input.branch);
  await run({
    ...input,
    cwd: input.projectDir,
    what: "seed the sandbox repository",
    command: [
      "(git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main)",
      ...(uploaded ? [installSeedPack({ name: uploaded, shallow })] : []),
      // The agent's branch at its HEAD. After a setup, what it changed in
      // tracked files stays (a trusted procedure copied over the change's
      // own, ADR 0324) unless the agent's commits changed the same files.
      input.afterSetup
        ? `(git checkout -q -B ${branch} ${input.head} 2>/dev/null || git checkout -q -f -B ${branch} ${input.head})`
        : `git checkout -q -f -B ${branch} ${input.head}`,
      ...(input.afterSetup ? [] : ["git clean -fdq"]),
      // Then what the agent had not committed, in the working tree alone:
      // every path whose saved content differs from its HEAD's, so the
      // index still says what is committed and the saved work wins over a
      // setup's change to the same file.
      `if [ "$(git rev-parse ${input.head}^{tree})" != ${tree} ]; then git diff-tree -r --no-renames --name-only -z ${input.head} ${tree} | GIT_LITERAL_PATHSPECS=1 git restore -q --source=${tree} --worktree --pathspec-from-file=- --pathspec-file-nul; fi`,
      `git update-ref refs/work/base ${input.base}`,
      `git update-ref refs/work/synced "$(git ${AGENT} commit-tree ${tree} -m synced)"`,
      // From here on a checkout without a repository is one that lost it.
      // Nothing was uploaded for a session that added nothing to its
      // base, so the session directory may not be there yet.
      `mkdir -p ../${SESSION_DIRECTORY}`,
      `: > ../${SESSION_DIRECTORY}/${SEEDED_FILE}`,
      originScript(input.originUrl),
    ].join(" && "),
  });
  return { seeded: true };
}

/**
 * Seed the sandbox repository with the workspace's base commit alone (ADR
 * 0257): all a setup on its own network may see. Uploaded as one shallow
 * pack, so it needs no grant and no gateway: how a host whose sandboxes
 * cannot fetch gets its base (ADR 0353). It leaves `refs/work/base` unset,
 * so that seeding still brings the session's saved work once the sandbox
 * is narrow again.
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
  const uploaded = await uploadSeedPack({ ...input, pack });
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
      installSeedPack({ name: uploaded, shallow }),
      `git checkout -q -f --detach ${input.base}`,
      // Nothing but the base: ignored files too.
      "git clean -ffdqx",
    ].join(" && "),
  });
}

/** The Git remote a checkout command fetches a workspace's base from. */
export const CHECKOUT_REMOTE = "work";

/** A workspace's base as its sandbox fetches it (ADR 0353). */
export interface SandboxCheckout {
  /** `<gateway>/checkout/<id>`, as the sandbox reaches it. */
  url: string;
  /** The checkout's token, held in the command's environment only. */
  token: string;
  /** The Environment's command, or Work's own. */
  command: string;
  /** Seconds the command may run. */
  timeoutSeconds: number;
}

/**
 * Bring the workspace's base commit into the sandbox by running a checkout
 * command there (ADR 0353). The project folder is made a Git repository
 * whose remote `work` serves that commit and its tree and nothing else;
 * the command runs in it with `WORK_BASE` naming the commit and the
 * checkout's token in its environment, written to no file. When the
 * command ends, HEAD must be that commit: the id is the content's own
 * hash, so a checkout that names it holds it. The remote goes with the
 * token, unless the command left objects out (`--filter`): a partial clone
 * reads those through its remote, so it stays, without a credential, and
 * whatever is asked of it later is refused, saying why.
 */
export async function checkoutSandboxBase(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  base: string;
  checkout: SandboxCheckout;
}): Promise<void> {
  const { checkout } = input;
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(input.base))
    throw new Error("A workspace's base is a full commit id");
  const root = input.provider.workspaceRoot;
  // Paths relative to the workspace root, the command's folder: only that
  // is resolved for commands on every provider.
  const project = path.posix.relative(root, input.projectDir);
  const url = shellQuote(checkout.url);
  await run({
    ...input,
    cwd: root,
    what: "check out the workspace's base",
    timeout: checkout.timeoutSeconds,
    mask: [checkout.token],
    env: {
      WORK_BASE: input.base,
      GIT_TERMINAL_PROMPT: "0",
      // Read by every Git the command runs, and by nothing after it.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${checkout.url}.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${checkout.token}`,
    },
    command: `${[
      `mkdir -p ${shellQuote(project)}`,
      `cd ${shellQuote(project)}`,
      "(git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main)",
      `(git remote get-url ${CHECKOUT_REMOTE} >/dev/null 2>&1 && git remote set-url ${CHECKOUT_REMOTE} ${url} || git remote add ${CHECKOUT_REMOTE} ${url})`,
      // In a shell of its own, as a setup's command runs (`bash -e`): its
      // first failing line fails it, and whatever it changes of its shell
      // (its folder, its options) ends with it.
      `bash -ec ${shellQuote(checkout.command)}`,
      `{ [ "$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null)" = "$WORK_BASE" ] || { echo "The checkout command ended without the workspace's base checked out: HEAD is $(git rev-parse -q --verify HEAD 2>/dev/null || echo unset), and the base is $WORK_BASE. It fetches $WORK_BASE from the remote ${CHECKOUT_REMOTE} and checks it out." >&2; false; }; }`,
      // A remote nothing can be fetched from any more goes, unless the
      // checkout left objects out: Git reads those through it.
      `{ [ "$(git config --get remote.${CHECKOUT_REMOTE}.promisor)" = true ] || git remote remove ${CHECKOUT_REMOTE}; }`,
      // A checkout that failed leaves no remote behind either.
    ].join(
      " && ",
    )} || { status=$?; git remote remove ${CHECKOUT_REMOTE} >/dev/null 2>&1; exit $status; }`,
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
  // Both sides of a sandbox that runs commands apart (ADR 0332); one
  // container twice otherwise.
  for (const side of SIDES)
    await run({
      ...input,
      side,
      cwd: input.provider.workspaceRoot,
      what: "clear the sandbox's grants and variables",
      command: `rm -rf ${SESSION_DIRECTORY}/grants ${SESSION_DIRECTORY}/model-grants ${SESSION_DIRECTORY}/grant-staging ${SESSION_DIRECTORY}/env ${SESSION_DIRECTORY}/gitconfig`,
    });
}

/** Every side of a sandbox, commands first (ADR 0332). */
const SIDES: readonly SandboxSide[] = ["commands", "agent"];

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
  return `while IFS= read -r line; do case "$line" in *${ROOT}*) printf '%s%s%s\\n' "\${line%%${ROOT}*}" "$root" "\${line#*${ROOT}}";; *) printf '%s\\n' "$line";; esac; done < ${shellQuote(from)} > ${shellQuote(to)}`;
}

/**
 * Commands (run in the session directory) that put the gateway's
 * variables file in place from its uploaded template, or, without HTTP
 * aliases, take an earlier turn's away. Values are single-quoted, so a
 * session directory whose path holds a quote gets no file.
 */
function gatewayEnvScript(input: { write: boolean; stage: string }): string {
  const file = GATEWAY_ENV_IN_SESSION_DIRECTORY;
  if (!input.write) return `rm -f ${shellQuote(file)}`;
  const template = `${input.stage}/${file}.in`;
  const rendered = `${input.stage}/${file}`;
  return [
    "root=$(pwd -P)",
    `case "$root" in *\\'*) rm -f ${shellQuote(file)};; *) ${withRoot(template, rendered)} && chmod 644 ${shellQuote(rendered)} && mkdir -p ${shellQuote(path.posix.dirname(file))} && mv -f ${shellQuote(rendered)} ${shellQuote(file)};; esac`,
  ].join(" && ");
}

/** Git already serializes config writes; retry that lock, never create another. */
function installGitInclude(): string {
  return [
    "git_include_tries=0",
    'until git config --global --get-all include.path 2>/dev/null | grep -Fqx "$root/gitconfig"; do',
    '  if git config --global --fixed-value --replace-all include.path "$root/gitconfig" "$root/gitconfig" 2>/dev/null; then break; fi',
    "  git_include_tries=$((git_include_tries + 1))",
    '  if [ "$git_include_tries" -ge 100 ]; then echo "Could not install the gateway Git include" >&2; exit 1; fi',
    "  sleep 0.05",
    "done",
  ].join("\n");
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
  grants: readonly SandboxGrant[];
  gitAliases: readonly SandboxGitAlias[];
  httpAliases?: readonly SandboxHttpAlias[];
  renewOnly?: boolean;
  /**
   * The sandbox runs commands apart from its agent (ADR 0332): the command
   * side gets the grants, Git configuration and variables of these
   * aliases, never a model's; the agent side gets only the others (its
   * model's), and no Git configuration or variables, since its harness
   * runs Git and code only where commands run. No grant is on both sides.
   * Without an agent side (its harness runs outside the sandbox) nothing
   * but the listed aliases' grants reaches the sandbox.
   */
  commands?: { aliases: readonly string[]; agentSide?: boolean };
}): Promise<void> {
  if (!input.grants.length) return;
  for (const grant of input.grants)
    if (!/^[1-9][0-9]*$/.test(grant.publicationRevision))
      throw new Error(
        "A sandbox grant needs its persisted publication revision",
      );
  if (!input.commands) return publishGateway(input);
  const listed = new Set(input.commands.aliases);
  // Beside the agent only its attempt's model grant, where its harness
  // reads it (ADR 0293): nothing a link in the checkout could lead to.
  if (input.commands.agentSide !== false)
    await publishGateway({
      ...input,
      side: "agent",
      grants: input.grants.flatMap((grant) =>
        grant.modelAttemptId && !listed.has(grant.alias)
          ? [{ ...grant, modelOnly: true }]
          : [],
      ),
      gitAliases: [],
      httpAliases: [],
      allowEmpty: true,
    });
  await publishGateway({
    ...input,
    side: "commands",
    grants: input.grants.flatMap((grant) =>
      listed.has(grant.alias) && !grant.modelOnly
        ? [
            {
              alias: grant.alias,
              grant: grant.grant,
              publicationRevision: grant.publicationRevision,
            },
          ]
        : [],
    ),
    gitAliases: input.gitAliases.filter((alias) => listed.has(alias.alias)),
    httpAliases: (input.httpAliases ?? []).filter((alias) =>
      listed.has(alias.alias),
    ),
    // A side with nothing listed still gets its Git configuration and
    // variables rewritten empty, so none outlives its listing.
    allowEmpty: true,
  });
}

/** One grant as a sandbox's session folder publishes it (ADRs 0175, 0293). */
export interface SandboxGrant {
  alias: string;
  grant: string;
  publicationRevision: string;
  modelAttemptId?: string;
  /**
   * Published only under its attempt: a shared subsession's model grant
   * (ADR 0322), never where the workspace's Git and HTTP read theirs.
   */
  modelOnly?: boolean;
}

/** Publish grants, Git configuration and variables on one side. */
async function publishGateway(input: {
  provider: SandboxProvider;
  sandboxId: string;
  gatewayGitUrl: string;
  grants: readonly SandboxGrant[];
  gitAliases: readonly SandboxGitAlias[];
  httpAliases?: readonly SandboxHttpAlias[];
  renewOnly?: boolean;
  side?: SandboxSide;
  allowEmpty?: boolean;
}): Promise<void> {
  if (!input.grants.length && !input.allowEmpty) return;
  if (!input.grants.length && input.renewOnly) return;
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
    const revisions: [string, string][] = grant.modelOnly
      ? []
      : [[`grants/${grant.alias}/${grant.publicationRevision}`, grant.grant]];
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
    input.side ? { side: input.side } : undefined,
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
        // Both paths share a filesystem. Link a finished revision atomically;
        // an existing, identical revision is an idempotent retry on every OS.
        // A conflict or any other publication failure must still fail preparation.
        `ln ${shellQuote(`${stage}/${file}`)} ${shellQuote(file)} 2>/dev/null || { [ -f ${shellQuote(file)} ] && cmp -s ${shellQuote(`${stage}/${file}`)} ${shellQuote(file)} || { echo ${shellQuote(`Could not publish immutable grant ${file}`)} >&2; exit 1; }; }`,
      ]),
      "mkdir -p grants",
      "chmod 700 grants",
      ...(input.grants.some((grant) => grant.modelAttemptId)
        ? ["chmod 700 model-grants"]
        : []),
      ...(input.renewOnly
        ? []
        : [
            ...(git
              ? [
                  `mv -f ${shellQuote(`${stage}/git-credential-work`)} git-credential-work`,
                  "chmod 700 git-credential-work",
                  "root=$(pwd -P)",
                  `case "$root" in *[\\'\\"\\\\]*) echo "The sandbox path $root holds a quote or backslash" >&2; exit 1;; esac`,
                  withRoot(`${stage}/gitconfig.in`, `${stage}/gitconfig`),
                  `chmod 600 ${shellQuote(`${stage}/gitconfig`)}`,
                  `mv -f ${shellQuote(`${stage}/gitconfig`)} gitconfig`,
                  installGitInclude(),
                ]
              : [
                  `: > ${shellQuote(`${stage}/gitconfig`)}`,
                  `mv -f ${shellQuote(`${stage}/gitconfig`)} gitconfig`,
                ]),
            gatewayEnvScript({ write: gatewayEnv !== undefined, stage }),
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
  // Both sides of a sandbox that runs commands apart (ADR 0332).
  for (const side of SIDES)
    await run({
      ...input,
      side,
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
