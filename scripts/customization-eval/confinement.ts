import { accessSync, constants, realpathSync } from "node:fs";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

function literal(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const systemReadPaths = [
  "/System/Library",
  "/System/Cryptexes/OS",
  "/usr/lib",
  "/usr/libexec",
  "/usr/bin",
  "/usr/sbin",
  "/usr/share",
  "/bin",
  "/sbin",
  "/Library/Apple",
  "/Library/Developer/CommandLineTools",
  "/private/var/db/dyld",
  "/private/var/db/timezone",
  "/private/etc",
];

const subpaths = (paths: readonly string[]) =>
  paths.map((file) => `(subpath ${literal(file)})`).join(" ");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function seatbeltProfile(input: {
  read: string;
  write: string;
  executables: readonly string[];
  denyNetwork?: boolean;
  extra?: readonly string[];
}): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-read-data file-map-executable)",
    `(allow file-read-data file-map-executable ${subpaths(systemReadPaths)} ${input.read} ${["/", "/dev/null", "/dev/random", "/dev/urandom", ...input.executables].map((file) => `(literal ${literal(file)})`).join(" ")})`,
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") ${input.write})`,
    "(deny appleevent-send)",
    ...(input.denyNetwork ? ["(deny network*)"] : []),
    ...(input.extra ?? []),
  ].join("\n");
}

/** Outer read boundary: Codex's workspace-write policy alone permits host reads. */
export function evalSeatbeltProfile(input: {
  project: string;
  profile: string;
  auth: string;
  executables: readonly string[];
}): string {
  const roots = subpaths([input.project, input.profile, input.auth]);
  return seatbeltProfile({
    read: roots,
    write: roots,
    executables: input.executables,
  });
}

/** LocalProcess's existing PATH seam covers both dependency installs and stdio supervisors. */
export async function confinedWorkflowEnvironment(input: {
  directory: string;
  sandboxRoot: string;
  bun: string;
}): Promise<Record<string, string>> {
  await mkdir(input.sandboxRoot, { recursive: true });
  const root = await realpath(input.sandboxRoot);
  const directory = path.join(input.directory, "workflow-launcher");
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const launcher = await realpath(directory);
  if (launcher === root || launcher.startsWith(root + path.sep))
    throw new Error("Workflow launch policy must be outside guest sandboxes");
  const bun = await realpath(input.bun);
  const runtimePath = [
    path.dirname(bun),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(path.delimiter);
  const policy = path.join(launcher, "workflow.sb");
  const installPolicy = path.join(launcher, "install.sb");
  const config = path.join(launcher, "bunfig.toml");
  await writeFile(config, "# Evaluation launcher configuration.\n", {
    mode: 0o400,
  });
  const writable = ["HOME", "TMP", "CACHE", "RUNS"];
  const processRules = [
    "(deny mach-lookup)",
    "(deny process-info*)",
    "(allow process-info* (target same-sandbox))",
    "(deny mach-priv-task-port)",
    "(allow mach-priv-task-port (target same-sandbox))",
    "(deny signal)",
    "(allow signal (target same-sandbox))",
  ];
  await writeFile(
    policy,
    seatbeltProfile({
      read: `(subpath (param "SANDBOX_ROOT")) (literal ${literal(launcher)}) (literal ${literal(config)})`,
      write: writable.map((name) => `(subpath (param "${name}"))`).join(" "),
      executables: [bun],
      denyNetwork: true,
      extra: [
        ...processRules,
        "(deny file-link)",
        `(deny file-write-unlink file-write-create ${writable.map((name) => `(literal (param "${name}"))`).join(" ")})`,
      ],
    }),
    { mode: 0o400 },
  );
  await writeFile(
    installPolicy,
    seatbeltProfile({
      read: `(subpath (param "SANDBOX_ROOT")) (literal ${literal(launcher)}) (literal ${literal(config)})`,
      write: '(subpath (param "SANDBOX_ROOT"))',
      executables: [bun],
      denyNetwork: true,
      extra: [...processRules, "(deny file-link process-fork)"],
    }),
    { mode: 0o400 },
  );
  const validator = path.join(launcher, "validate-install.mjs");
  await writeFile(
    validator,
    `import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
if (path.dirname(root) !== ${JSON.stringify(root)} || !/^local-[a-f0-9]{8}-[a-f0-9]{3}$/.test(path.basename(root)) || fs.realpathSync(root) !== root) throw new Error('Invalid install sandbox');
let count = 0;
let unsafe = false;
function walk(file) {
  if (++count > 20000) throw new Error('Install tree exceeds the evaluation limit');
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    try {const target=fs.realpathSync(file);if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Escaping install link');}
    catch {fs.unlinkSync(file);unsafe=true;}
  } else if (stat.isDirectory()) {
    for (const name of fs.readdirSync(file)) walk(path.join(file,name));
  } else if (!stat.isFile() || stat.nlink > 1) throw new Error('Invalid install file');
}
try {
  walk(root);
  if (unsafe) throw new Error('Unsafe install links removed');
} catch (error) {
  // No guest code ran during install. Atomically detach every host upload target
  // before returning, including on bounded-scan or permission failure.
  const workspace=path.join(root,'workspace');
  if (fs.existsSync(workspace) || fs.lstatSync(workspace,{throwIfNoEntry:false})) fs.renameSync(workspace,path.join(root,'rejected-install-'+crypto.randomUUID()));
  fs.mkdirSync(workspace);
  console.error(error.message);
  process.exitCode=78;
}
`,
    { mode: 0o400 },
  );
  await writeFile(
    path.join(launcher, "bun"),
    process.platform === "darwin"
      ? `#!/bin/sh
set -eu
refuse() { echo 'Invalid workflow evaluation sandbox boundary' >&2; exit 78; }
[ -n "\${HOME:-}" ] || refuse
home=$(CDPATH= cd -P "$HOME" && /bin/pwd -P) || refuse
sandbox=$(CDPATH= cd -P "$home/.." && /bin/pwd -P) || refuse
[ "$home" = "$sandbox/home" ] || refuse
case "$sandbox" in ${quote(root)}/local-????????????) ;; *) refuse ;; esac
id=\${sandbox##*/}
case "$id" in local-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f]) ;; *) refuse ;; esac
cwd=$(/bin/pwd -P) || refuse
case "$cwd" in "$sandbox"|"$sandbox"/*) ;; *) refuse ;; esac
# Descendants use real Bun directly under the inherited boundary. There is no bypass marker.
export PATH=${quote(runtimePath)}
export BUN_INSTALL_CACHE_DIR="$sandbox/bun-cache"
for writable in "$sandbox/tmp" "$sandbox/bun-cache"; do
  /bin/mkdir -p "$writable"
  canonical=$(CDPATH= cd -P "$writable" && /bin/pwd -P) || refuse
  [ "$canonical" = "$writable" ] || refuse
done
if [ "\${1:-}" = install ]; then
  set +e
  /usr/bin/sandbox-exec -D "SANDBOX_ROOT=$sandbox" -f ${quote(installPolicy)} ${quote(bun)} --no-env-file ${quote(`--config=${config}`)} "$@" --ignore-scripts --backend=copyfile
  result=$?
  set -e
  # The host restores package.json even after install failure. Validate before
  # returning to that raw provider write; do not execute project configuration.
  if ! (cd ${quote(launcher)} && /usr/bin/env -i PATH=${quote(runtimePath)} HOME=${quote(launcher)} TMPDIR="$sandbox/tmp" ${quote(bun)} --no-env-file ${quote(`--config=${config}`)} ${quote(validator)} "$sandbox"); then
    # This also fences a validator startup failure before its own cleanup ran.
    rejected=$(/usr/bin/mktemp -d "$sandbox/rejected-install.XXXXXXXX") || refuse
    if [ -e "$sandbox/workspace" ] || [ -L "$sandbox/workspace" ]; then /bin/mv "$sandbox/workspace" "$rejected/workspace"; fi
    /bin/mkdir "$sandbox/workspace"
    result=78
  fi
  exit "$result"
fi
runs="$sandbox/tmp"
if [ -n "\${CATAMORPHIC_RUNTIME_WRITABLE_ROOT:-}" ]; then
  [ "\${cwd##*/}" = runtime ] || refuse
  expected=$(CDPATH= cd -P "$cwd/.." && /bin/pwd -P)/runs
  runs=$(CDPATH= cd -P "$expected" && /bin/pwd -P) || refuse
  [ "$runs" = "$expected" ] && [ "$runs" = "$CATAMORPHIC_RUNTIME_WRITABLE_ROOT" ] || refuse
fi
exec /usr/bin/sandbox-exec -D "SANDBOX_ROOT=$sandbox" -D "HOME=$home" -D "TMP=$sandbox/tmp" -D "CACHE=$sandbox/bun-cache" -D "RUNS=$runs" -f ${quote(policy)} ${quote(bun)} --no-env-file ${quote(`--config=${config}`)} "$@"
`
      : "#!/bin/sh\necho 'Workflow evaluation confinement requires macOS Seatbelt' >&2\nexit 78\n",
    { mode: 0o500 },
  );
  await chmod(launcher, 0o500);
  return { PATH: `${launcher}${path.delimiter}${runtimePath}` };
}

export async function confinedAgentCommand(input: {
  command: string;
  project: string;
  profile: string;
  auth: string;
  bun: string;
}): Promise<string> {
  if (process.platform !== "darwin")
    throw new Error(
      "Native harness eval read isolation currently requires macOS Seatbelt. Linux container execution is not implemented by this runner.",
    );
  const executable = input.command.includes("/")
    ? realpathSync(input.command)
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .map((folder) => path.join(folder, input.command))
        .find((candidate) => {
          try {
            accessSync(candidate, constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
  if (!executable)
    throw new Error(`Executable ${input.command} is not on PATH`);
  const tools = path.join(input.profile, "tools");
  await mkdir(tools, { recursive: true });
  const profile = path.join(tools, "agent.sb");
  await writeFile(
    profile,
    evalSeatbeltProfile({
      ...input,
      executables: [realpathSync(executable), realpathSync(input.bun)],
    }),
  );
  const command = path.join(tools, "agent");
  await writeFile(
    command,
    `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${quote(profile)} ${quote(executable)} "$@"\n`,
  );
  await chmod(command, 0o700);
  return command;
}
