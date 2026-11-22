/*
 * Installing a Work worker on a machine (ADR 0350): host code from the
 * `machines-install` pack, yours to change. Work keeps the worker process,
 * its protocol and its start contract (`WORK_CONTROL_PLANE_URL` and
 * `WORK_WORKER_ENROLLMENT`); how a machine gets Docker, a sandbox backend
 * and the worker image is this file. A machines hook's `create` builds its
 * user data with `workerUserData`, and a host that wants `curl | sh` for
 * machines enrolled by hand mounts `registerInstallScriptRoute` through
 * `hooks.routes`.
 */

/** What a machine installs: where its worker dials, and which image it runs. */
export interface InstallTarget {
  /** The Work server's public origin the worker dials. */
  controlPlaneUrl: string;
  /** The deployment's pinned worker image. */
  image: string;
}

/** Why machines cannot install with this target, if they cannot. */
export function installTargetProblem(
  target: InstallTarget,
): string | undefined {
  if (!target.image)
    return "Name the worker image machines run: your deployment's pinned image.";
  const { hostname } = new URL(target.controlPlaneUrl);
  if (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]"
  )
    return "Machines cannot reach a loopback address. Use the HTTPS origin workers dial.";
  return undefined;
}

/**
 * The sandbox backend a machine the script installs runs (`--sandbox`):
 * `auto` picks microVMs where KVM is usable and gVisor elsewhere.
 */
export type WorkerSandbox = "auto" | "microsandbox" | "container";

/** The data directory the script uses unless told otherwise. */
export const DEFAULT_WORKER_DATA_DIR = "/var/lib/work";

/**
 * The worker install script: a POSIX sh script with the control plane and
 * image baked in, holding no secret. It installs Docker where it
 * is missing; with no usable `/dev/kvm`, or `--sandbox container`, it
 * installs gVisor and registers the `runsc` runtime with Work's arguments
 * (ADR 0204); then it runs the worker image with `WORK_SANDBOX` (`auto`
 * unless `--sandbox` names a backend), the Docker socket, `/dev/kvm` when
 * microVMs use it, and its data directory mounted at the same path. With
 * `--registry ecr` it installs the ECR credential helper first, so a
 * private image is pulled with the machine's own instance profile; with
 * `--no-pull` it runs an image that is already on the machine (a baked
 * machine image).
 *
 * microsandbox runs each microVM through libkrun, which only opens
 * `/dev/kvm` and keeps the guest's network in user space: the device and
 * its group are all the worker container needs, never `--privileged` or
 * added capabilities.
 *
 * Downloads land in files that are checked before use, never piped into a
 * shell. Package installation waits, within bounds, for another one to
 * finish, as on a cloud machine's first boot. The data directory, which is
 * made private to the worker, is never a system directory.
 */
export function workerInstallScript(target: InstallTarget): string {
  return `#!/bin/sh
# Installs a Work worker on this machine, for the Work server at
# ${target.controlPlaneUrl}. It holds no secret; run it as root with the
# machine's one-time enrollment code:
#
#   sudo sh install.sh --code <enrollment code>
#
# Running it again is safe: it keeps what is installed and replaces the
# worker container, which keeps its enrollment in its data directory.
set -eu
# A failed download in a pipeline fails the script where the shell can say so.
# shellcheck disable=SC3040
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

CONTROL_PLANE_URL=${shellQuote(target.controlPlaneUrl)}
IMAGE=${shellQuote(target.image)}
DATA_DIR=${DEFAULT_WORKER_DATA_DIR}
NAME=work-worker
SANDBOX=auto
REGISTRY=
PULL=1
CODE=

say() { printf 'work: %s\\n' "$*"; }
fail() {
  printf 'work: %s\\n' "$*" >&2
  exit 1
}
usage() {
  cat <<'USAGE'
Usage: install.sh --code <code> [--image <image>] [--data-dir <dir>] [--name <name>] [--sandbox <backend>] [--registry ecr] [--no-pull]

  --code <code>      the one-time enrollment code from the Work server (required)
  --image <image>    the worker image (default: the deployment's configured worker image)
  --data-dir <dir>   where the worker keeps its credential, sandboxes and
                     members' sign-ins (default: ${DEFAULT_WORKER_DATA_DIR}): a new
                     directory, or one under /var/lib, /srv, /opt, /data or
                     /home/<user> that is empty or a worker's
  --name <name>      the worker container's name (default: work-worker)
  --sandbox <backend> auto (default: microVMs where KVM is usable, else
                     gVisor), microsandbox, or container (gVisor even where
                     KVM is usable)
  --registry ecr     the image is in a private Amazon ECR registry: pull it
                     with the machine's instance profile
  --no-pull          run the image already on this machine (a baked image)
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --code | --image | --data-dir | --name | --sandbox | --registry)
      [ "$#" -ge 2 ] || fail "$1 needs a value"
      case "$1" in
        --code) CODE=$2 ;;
        --image) IMAGE=$2 ;;
        --data-dir) DATA_DIR=$2 ;;
        --name) NAME=$2 ;;
        --sandbox) SANDBOX=$2 ;;
        --registry) REGISTRY=$2 ;;
      esac
      shift 2
      ;;
    --no-pull) PULL=0; shift ;;
    --registry=*) REGISTRY=\${1#--registry=}; shift ;;
    --code=*) CODE=\${1#--code=}; shift ;;
    --image=*) IMAGE=\${1#--image=}; shift ;;
    --data-dir=*) DATA_DIR=\${1#--data-dir=}; shift ;;
    --name=*) NAME=\${1#--name=}; shift ;;
    --sandbox=*) SANDBOX=\${1#--sandbox=}; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
done

# The data directory is handed to the worker's user and made private, so it
# is never a system directory: a new one, or an empty or worker's one under
# a place meant for data.
case "$DATA_DIR" in
  /) ;;
  */) DATA_DIR=\${DATA_DIR%/} ;;
esac
data_dir_allowed() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *//* | */./* | */../* | */. | */..) return 1 ;;
    / | /bin | /boot | /dev | /etc | /home | /lib | /lib32 | /lib64 | /libx32 | \\
      /media | /mnt | /opt | /proc | /root | /run | /sbin | /snap | /srv | \\
      /sys | /tmp | /usr | /var | /var/cache | /var/lib | /var/log | \\
      /var/mail | /var/run | /var/spool | /var/tmp)
      return 1 ;;
    /bin/* | /boot/* | /dev/* | /etc/* | /lib/* | /lib32/* | /lib64/* | \\
      /libx32/* | /proc/* | /root/* | /run/* | /sbin/* | /sys/* | /usr/*)
      return 1 ;;
  esac
  [ -e "$1" ] || return 0
  [ -d "$1" ] || return 1
  [ -f "$1/worker-credential" ] && return 0
  case "$1" in
    /var/lib/?* | /srv/?* | /opt/?* | /data | /data/?* | /home/?*/?*)
      [ -z "$(ls -A "$1")" ] ;;
    *) return 1 ;;
  esac
}

[ -n "$CODE" ] || fail "Pass the enrollment code: --code <code>"
[ "$(id -u)" -eq 0 ] || fail "Run this script as root, for example with sudo sh"
data_dir_allowed "$DATA_DIR" ||
  fail "--data-dir $DATA_DIR is not a place for the worker's data: use a new directory, or an empty one under /var/lib, /srv, /opt, /data or /home/<user>"
case "$NAME" in
  [a-zA-Z0-9]*) ;;
  *) fail "--name must start with a letter or digit" ;;
esac
case "$SANDBOX" in
  auto | microsandbox | container) ;;
  *) fail "--sandbox is auto, microsandbox or container" ;;
esac
case "$REGISTRY" in
  "" | ecr) ;;
  *) fail "--registry is ecr, or left out for a registry that needs no login" ;;
esac

WORK_TMP=$(mktemp -d)
trap 'rm -rf "$WORK_TMP"' EXIT

# Download a file, and check it is there before it is used.
download() {
  curl -fsSL --retry 3 --connect-timeout 20 "$1" -o "$2" ||
    fail "Could not download $1"
  [ -s "$2" ] || fail "$1 answered with nothing"
}

# On a first boot, cloud-init and unattended upgrades may be installing
# packages: wait for them, within bounds, before installing ours.
apt_busy() {
  command -v fuser >/dev/null 2>&1 || return 1
  fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock \\
    /var/lib/apt/lists/lock >/dev/null 2>&1
}
wait_for_apt() {
  waited=0
  while apt_busy; do
    if [ "$waited" -eq 0 ]; then
      say "Waiting for another package installation to finish"
    fi
    waited=$((waited + 1))
    [ "$waited" -le 60 ] ||
      fail "Another package installation held apt's lock for ten minutes; run this script again later"
    sleep 10
  done
}
apt_get() {
  tries=0
  wait_for_apt
  until DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 "$@"; do
    tries=$((tries + 1))
    [ "$tries" -lt 20 ] || fail "apt-get $1 kept failing"
    say "apt-get $1 failed, perhaps behind another installation; trying again"
    sleep 15
    wait_for_apt
  done
}

# Docker, with the official convenience script when it is missing.
if ! command -v docker >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || fail "Install curl, then run this script again"
  say "Installing Docker"
  download https://get.docker.com "$WORK_TMP/get-docker.sh"
  case "$(head -n 1 "$WORK_TMP/get-docker.sh")" in
    '#!'*sh*) ;;
    *) fail "https://get.docker.com did not answer with Docker's install script" ;;
  esac
  tries=0
  until wait_for_apt && sh "$WORK_TMP/get-docker.sh"; do
    tries=$((tries + 1))
    [ "$tries" -lt 3 ] || fail "Docker's install script failed"
    say "Docker's install script failed; trying again"
    sleep 15
  done
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker info >/dev/null 2>&1 || fail "Docker is installed but its daemon does not answer"

restart_docker() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart docker
  else
    service docker restart
  fi
}

# Isolation: microVMs where KVM is usable, gVisor everywhere else, unless
# --sandbox names one. gVisor runs what microVMs cannot: a sandbox whose
# setup has its own network (ADR 0257).
KVM=0
if [ "$SANDBOX" != container ] && [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  KVM=1
  say "KVM is available: agents run in microVMs"
elif [ "$SANDBOX" = microsandbox ]; then
  fail "--sandbox microsandbox needs a /dev/kvm this script can open read-write"
else
  if ! command -v runsc >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 ||
      fail "This machine has no KVM and no apt-get. Install gVisor (https://gvisor.dev/docs/user_guide/install/), then run this script again"
    say "No KVM: installing gVisor"
    apt_get update -qq
    apt_get install -y -qq ca-certificates curl gnupg >/dev/null
    download https://gvisor.dev/archive.key "$WORK_TMP/gvisor.key"
    grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$WORK_TMP/gvisor.key" ||
      fail "https://gvisor.dev/archive.key is not a signing key"
    gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg \\
      "$WORK_TMP/gvisor.key"
    ARCH=$(dpkg --print-architecture)
    echo "deb [arch=$ARCH signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \\
      >/etc/apt/sources.list.d/gvisor.list
    apt_get update -qq
    apt_get install -y -qq runsc >/dev/null
  fi
  # Sandboxes reach their egress proxy over a host socket and run nested
  # Docker with raw sockets (ADR 0204). runsc merges its runtime into the
  # daemon's configuration; Docker restarts only when that changed.
  BEFORE=$(cksum /etc/docker/daemon.json 2>/dev/null || true)
  runsc install -- --host-uds=open --net-raw
  AFTER=$(cksum /etc/docker/daemon.json 2>/dev/null || true)
  if [ "$BEFORE" != "$AFTER" ]; then
    say "Restarting Docker with the gVisor runtime"
    restart_docker
  fi
  RUNTIMES=$(docker info --format '{{json .Runtimes}}')
  case "$RUNTIMES" in
    *'"runsc"'*) ;;
    *) fail "Docker did not load the runsc runtime; see /etc/docker/daemon.json" ;;
  esac
  say "gVisor is ready: agents run in gVisor sandboxes"
fi

# The worker's data directory belongs to the image's user (uid 1000).
mkdir -p "$DATA_DIR"
chown 1000:1000 "$DATA_DIR"
chmod 0700 "$DATA_DIR"

# A private Amazon ECR registry: Docker asks the credential helper, which
# answers with the machine's instance profile, so no secret reaches this
# script. Installed without its recommended packages, which would bring a
# second Docker. Docker reads root's configuration, wherever HOME points on
# a first boot.
if [ "$REGISTRY" = ecr ] && [ "$PULL" = 1 ]; then
  if ! command -v docker-credential-ecr-login >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 ||
      fail "Install amazon-ecr-credential-helper, then run this script again"
    say "Installing the ECR credential helper"
    apt_get update -qq
    apt_get install -y -qq --no-install-recommends amazon-ecr-credential-helper >/dev/null
  fi
  DOCKER_CONFIG=\${DOCKER_CONFIG:-/root/.docker}
  export DOCKER_CONFIG
  mkdir -p "$DOCKER_CONFIG"
  if [ ! -e "$DOCKER_CONFIG/config.json" ]; then
    printf '{"credHelpers":{"%s":"ecr-login"}}\\n' "\${IMAGE%%/*}" \\
      >"$DOCKER_CONFIG/config.json"
  elif ! grep -q ecr-login "$DOCKER_CONFIG/config.json"; then
    fail "$DOCKER_CONFIG/config.json exists and names no ecr-login helper; add \\"credHelpers\\": {\\"\${IMAGE%%/*}\\": \\"ecr-login\\"} to it"
  fi
fi

if [ "$PULL" = 1 ]; then
  say "Pulling $IMAGE"
  docker pull "$IMAGE" >/dev/null
else
  docker image inspect "$IMAGE" >/dev/null 2>&1 ||
    fail "--no-pull was given, and $IMAGE is not on this machine"
fi
if docker container inspect "$NAME" >/dev/null 2>&1; then
  say "Replacing the existing $NAME container"
  docker rm -f "$NAME" >/dev/null
fi

# The data directory is mounted at the same path, so the Docker daemon
# mounts what the worker writes there into its sandboxes. The image's health
# check asks the server's HTTP port, which a worker does not open.
set -- --detach --name "$NAME" --restart unless-stopped --no-healthcheck \\
  --volume "$DATA_DIR:$DATA_DIR" --env "WORK_DATA_DIR=$DATA_DIR" \\
  --volume /var/run/docker.sock:/var/run/docker.sock \\
  --group-add "$(stat -c %g /var/run/docker.sock)" \\
  --env "WORK_CONTROL_PLANE_URL=$CONTROL_PLANE_URL" \\
  --env "WORK_WORKER_ENROLLMENT=$CODE" \\
  --env "WORK_SANDBOX=$SANDBOX"
if [ "$KVM" = 1 ]; then
  set -- "$@" --device /dev/kvm --group-add "$(stat -c %g /dev/kvm)"
fi
docker run "$@" "$IMAGE" bun apps/server/src/worker.ts >/dev/null

say "The worker is running as the container $NAME and connects to $CONTROL_PLANE_URL."
say "Follow it with: docker logs -f $NAME"
say "Its state: docker ps --filter name=$NAME"
`;
}

/** Where cloud-init writes the script, and where a baked image keeps it. */
export const CLOUD_INIT_SCRIPT_PATH = "/usr/local/sbin/work-install-worker";

/**
 * Cloud-init user data for a cloud machine: the install script itself,
 * written to disk and run once with the machine's enrollment code. Nothing
 * is fetched over the network to start it. Without `script`, the machine's
 * image is baked and already holds the script at
 * {@link CLOUD_INIT_SCRIPT_PATH}: the user data only runs it.
 */
export function workerCloudInit(args: {
  /** The install script; left out for a baked image that holds it. */
  script?: string;
  code: string;
  /** The machine's sandbox backend; `auto` unless named. */
  sandbox?: WorkerSandbox;
  /** The image is in a private Amazon ECR registry. */
  registry?: "ecr";
  /** False for a baked image that already holds the worker image. */
  pull?: boolean;
}): string {
  const command = [
    "sh",
    CLOUD_INIT_SCRIPT_PATH,
    "--code",
    args.code,
    ...(args.sandbox && args.sandbox !== "auto"
      ? ["--sandbox", args.sandbox]
      : []),
    ...(args.registry ? ["--registry", args.registry] : []),
    ...(args.pull === false ? ["--no-pull"] : []),
  ]
    .map((part) => JSON.stringify(part))
    .join(", ");
  return [
    "#cloud-config",
    ...(args.script === undefined
      ? []
      : [
          "write_files:",
          `  - path: ${CLOUD_INIT_SCRIPT_PATH}`,
          "    owner: root:root",
          `    permissions: "0700"`,
          "    encoding: b64",
          `    content: ${Buffer.from(args.script).toString("base64")}`,
        ]),
    "runcmd:",
    `  - [${command}]`,
    "",
  ].join("\n");
}

/**
 * User data for a machine a machines hook's `create` makes, from the
 * enrollment Work hands it. A stock image (Ubuntu) installs everything on
 * its first boot; a baked image (`baked: true`: Docker, the sandbox
 * backend, the worker image and this script at
 * {@link CLOUD_INIT_SCRIPT_PATH} already on it) only starts the worker,
 * which makes a machine serve in seconds instead of minutes.
 */
export function workerUserData(args: {
  enrollment: { controlPlaneUrl: string; code: string };
  /** The deployment's pinned worker image. */
  image: string;
  sandbox?: WorkerSandbox;
  /** The image is in a private Amazon ECR registry the instance profile reads. */
  registry?: "ecr";
  /** The machine image already holds everything the script installs. */
  baked?: boolean;
}): string {
  const shared = {
    code: args.enrollment.code,
    ...(args.sandbox ? { sandbox: args.sandbox } : {}),
  };
  if (args.baked) return workerCloudInit({ ...shared, pull: false });
  return workerCloudInit({
    ...shared,
    script: workerInstallScript({
      controlPlaneUrl: args.enrollment.controlPlaneUrl,
      image: args.image,
    }),
    ...(args.registry ? { registry: args.registry } : {}),
  });
}

/** The part of a Fastify app the install route needs. */
interface RouteHost {
  get(
    path: string,
    handler: (
      request: unknown,
      reply: {
        status(code: number): {
          type(value: string): { send(body: string): unknown };
        };
        type(value: string): {
          header(name: string, value: string): { send(body: string): unknown };
        };
      },
    ) => unknown,
  ): unknown;
}

/**
 * `GET /api/workers/install.sh`, public: what a machine enrolled by hand
 * runs to become a worker (`curl -fsSL <origin>/api/workers/install.sh |
 * sudo sh -s -- --code <code>`). Mount it from `hooks.routes`. Answers 503
 * naming what is missing when machines cannot install with this target.
 */
export function registerInstallScriptRoute(args: {
  app: RouteHost;
  target: InstallTarget;
}): void {
  args.app.get("/api/workers/install.sh", (_request, reply) => {
    const problem = installTargetProblem(args.target);
    if (problem)
      return reply
        .status(503)
        .type("text/plain; charset=utf-8")
        .send(`${problem}\n`);
    return reply
      .type("text/x-shellscript; charset=utf-8")
      .header("cache-control", "no-store")
      .send(workerInstallScript(args.target));
  });
}

/** Single-quoted for sh: safe whatever the value holds. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
