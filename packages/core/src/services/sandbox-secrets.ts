import {
  formatEnvFile,
  shellSingleQuote as shellQuote,
} from "@catamorphic/agent-protocol/runner";
import type { SandboxProvider } from "@catamorphic/sandbox";
import {
  GATEWAY_ENV_IN_SESSION_DIRECTORY,
  SESSION_DIRECTORY,
} from "./sandbox-git.js";
import { type SandboxSecrets, secretFingerprint } from "./secrets-service.js";

/*
 * An Environment's secrets inside one sandbox (ADR 0205): one file of
 * `export NAME='value'` lines in the session's own directory, beside the
 * project folder and never inside the repository, readable only by the
 * sandbox user. Beside it, the gateway's variables file (ADR 0211) names
 * the session's HTTP API aliases; it holds no secret. The agent runner
 * reads both for every attempt (shells also load the secrets file through
 * `BASH_ENV`), and setup and terminals source both with
 * {@link sandboxSecretsPrelude}. The secrets file is removed whenever a
 * turn may not have it, and when the workspace is given back.
 */

/** The secrets file, relative to the session directory. */
export const SECRETS_IN_SESSION_DIRECTORY = "env/secrets.sh";

/** The secrets file, relative to the sandbox's workspace root. */
export const SANDBOX_SECRETS_PATH = `${SESSION_DIRECTORY}/${SECRETS_IN_SESSION_DIRECTORY}`;

/** The gateway's variables file, relative to the sandbox's workspace root. */
export const SANDBOX_GATEWAY_ENV_PATH = `${SESSION_DIRECTORY}/${GATEWAY_ENV_IN_SESSION_DIRECTORY}`;

const DIRECTORY = `../${SESSION_DIRECTORY}/env`;

/**
 * The secrets file's absolute path in the provider's own paths. Only a
 * process the provider started may resolve it (a runner maps it with
 * `CATAMORPHIC_SANDBOX_PATHS`): inside a command string use
 * {@link sandboxSecretsPrelude}, which needs no mapping.
 */
export function sandboxSecretsFile(input: { workspaceRoot: string }): string {
  return `${input.workspaceRoot}/${SANDBOX_SECRETS_PATH}`;
}

/**
 * The session's environment files in the provider's own paths, in the
 * order they load: the gateway's variables, then the secrets, which a
 * runner points `BASH_ENV` at (ADRs 0205, 0211).
 */
export function sandboxEnvFiles(input: { workspaceRoot: string }): string[] {
  return [
    `${input.workspaceRoot}/${SANDBOX_GATEWAY_ENV_PATH}`,
    sandboxSecretsFile(input),
  ];
}

/**
 * A shell line that loads the session's environment files (the gateway's
 * variables, then the secrets) into the current shell, each only when it
 * exists. It names them from the project folder, so it belongs at the
 * start of a command whose working directory is the project folder
 * (workspace setup, terminals).
 */
export function sandboxSecretsPrelude(): string {
  return [SANDBOX_GATEWAY_ENV_PATH, SANDBOX_SECRETS_PATH]
    .map((file) => {
      const quoted = shellQuote(`../${file}`);
      return `if [ -f ${quoted} ]; then . ${quoted}; fi`;
    })
    .join("; ");
}

async function run(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  command: string;
  what: string;
}): Promise<string> {
  const result = await input.provider.executeCommand(
    input.sandboxId,
    input.command,
    { cwd: input.projectDir, timeout: 60 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Failed to ${input.what}: ${result.result.slice(-2000)}`);
  return result.result;
}

/**
 * Write the secrets file (mode 0600, its folder 0700), replacing what was
 * there. Returns whether its content changed since the last delivery, by
 * a fingerprint kept beside it, so unchanged deliveries are not audited
 * again.
 */
export async function deliverSandboxSecrets(input: {
  provider: SandboxProvider;
  sandboxId: string;
  /** The sandbox path of the project checkout (the command's cwd). */
  projectDir: string;
  variables: Readonly<Record<string, string>>;
}): Promise<{ changed: boolean }> {
  const content = formatEnvFile(input.variables);
  const fingerprint = secretFingerprint(content);
  await input.provider.uploadFiles(
    input.sandboxId,
    { "secrets.b64": Buffer.from(content).toString("base64") },
    `${input.provider.workspaceRoot}/${SESSION_DIRECTORY}/env/incoming`,
  );
  const output = await run({
    provider: input.provider,
    sandboxId: input.sandboxId,
    projectDir: input.projectDir,
    what: "place this project's secrets in the sandbox",
    command: [
      "set -e",
      "umask 077",
      `chmod 700 ${DIRECTORY}`,
      `previous=$(cat ${DIRECTORY}/secrets.sha256 2>/dev/null || true)`,
      `rm -f ${DIRECTORY}/secrets.sh.new`,
      `base64 -d < ${DIRECTORY}/incoming/secrets.b64 > ${DIRECTORY}/secrets.sh.new`,
      `rm -rf ${DIRECTORY}/incoming`,
      `mv -f ${DIRECTORY}/secrets.sh.new ${DIRECTORY}/secrets.sh`,
      `printf '%s' ${shellQuote(fingerprint)} > ${DIRECTORY}/secrets.sha256`,
      `if [ "$previous" = ${shellQuote(fingerprint)} ]; then echo same; else echo changed; fi`,
    ].join("\n"),
  });
  return { changed: output.trim().split("\n").at(-1) !== "same" };
}

function listed(names: readonly string[]): string {
  return names.length === 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * What the agent is told about secrets its Environment lists but this
 * workspace did not get (ADR 0205), with who can set them; undefined when
 * every one was set.
 */
export function sandboxSecretsNote(input: {
  environment: string;
  /** The chat's owner, or null for a project chat. */
  owner: string | null;
  missing: SandboxSecrets["missing"];
}): string | undefined {
  const named = (reason: SandboxSecrets["missing"][number]["reason"]) =>
    input.missing.filter((gap) => gap.reason === reason).map((gap) => gap.name);
  const notes: string[] = [];
  const unset = named("unset");
  if (unset.length > 0) {
    const one = unset.length === 1;
    const subject = `${listed(unset)} ${one ? "is" : "are"} not set in this workspace`;
    notes.push(
      input.owner
        ? `${subject}: neither the user nor the project has a value for ${one ? "it" : "them"}. If the work needs ${one ? "it" : "them"}, tell the user they can set their own value under Secrets in Work, or ask someone who manages this project's secrets to set it for them.`
        : `${subject}: the project has no shared value for ${one ? "it" : "them"}. If the work needs ${one ? "it" : "them"}, tell the user that someone who manages this project's secrets can set a shared value under Secrets in Work.`,
    );
  }
  const undeclared = named("undeclared");
  if (undeclared.length > 0)
    notes.push(
      `Environment '${input.environment}' lists ${listed(undeclared)}, which nothing declares, so Work did not set ${undeclared.length === 1 ? "it" : "them"}. Declare secrets under "secrets" in .work/project.json.`,
    );
  const webhook = named("webhook");
  if (webhook.length > 0)
    notes.push(
      `${listed(webhook)} ${webhook.length === 1 ? "verifies" : "verify"} webhook deliveries and never ${webhook.length === 1 ? "reaches" : "reach"} a workspace.`,
    );
  const reserved = named("reserved");
  if (reserved.length > 0)
    notes.push(
      `${listed(reserved)} would replace ${reserved.length === 1 ? "a variable" : "variables"} the workspace's shells depend on, so Work did not set ${reserved.length === 1 ? "it" : "them"}. Rename the secret in .work/project.json.`,
    );
  return notes.length > 0 ? notes.join("\n\n") : undefined;
}

/**
 * Take the secrets file back out of the sandbox: before a turn that may
 * not have it, and when the workspace is given back. Safe to repeat.
 */
export async function removeSandboxSecrets(input: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
}): Promise<void> {
  await run({
    provider: input.provider,
    sandboxId: input.sandboxId,
    projectDir: input.projectDir,
    what: "remove this project's secrets from the sandbox",
    command: `rm -rf ${DIRECTORY}/secrets.sh ${DIRECTORY}/secrets.sh.new ${DIRECTORY}/secrets.sha256 ${DIRECTORY}/incoming`,
  });
}
