#!/usr/bin/env bash
# Run the container backend's real-sandbox tests (WORK_TEST_CONTAINER=1) on a
# Linux machine with Docker and gVisor, from any machine with Docker: the
# machine is a privileged container (test-machine.Dockerfile) running its
# own daemon with a `runsc` runtime. The checkout is copied in without
# node_modules and installed there, since Linux needs its own.
#
#   packages/container/scripts/test-in-docker.sh [--runtime runsc|runc] [--keep] [vitest args]
#
# --keep leaves the machine running and prints how to reuse it. Without it
# the machine and its volumes are removed when the run ends.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
runtime=runsc
keep=0
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) runtime="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    *) args+=("$1"); shift ;;
  esac
done

image=work-container-test-machine
name="work-container-test-$$"
echo "Building the test machine image..."
docker build -q -f "$here/test-machine.Dockerfile" -t "$image" "$here" >/dev/null

cleanup() {
  if [ "$keep" = 1 ]; then
    echo "Kept the machine: docker exec -it $name bash (remove it with: docker rm -f -v $name)"
  else
    docker rm -f -v "$name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# The machine's Docker data lives in an anonymous volume, removed with it:
# overlay storage cannot sit on the container's own overlay root.
docker run -d --privileged --name "$name" -v /var/lib/docker "$image" >/dev/null

echo "Copying the checkout..."
docker exec "$name" mkdir -p /work
(cd "$repo" && git ls-files -z --cached --others --exclude-standard) |
  (cd "$repo" && COPYFILE_DISABLE=1 tar --null -T - -cf -) |
  docker exec -i "$name" tar -x --warning=no-unknown-keyword -C /work

echo "Installing and building..."
docker exec -w /work "$name" bash -c '
  set -euo pipefail
  bun install --frozen-lockfile --ignore-scripts >/tmp/install.log 2>&1 || { tail -40 /tmp/install.log; exit 1; }
  node_modules/.bin/turbo run build --filter=@catamorphic/container... --output-logs=errors-only >/tmp/build.log 2>&1 || { tail -60 /tmp/build.log; exit 1; }
'

echo "Waiting for the machine's Docker daemon..."
docker exec "$name" bash -c '
  for i in $(seq 1 120); do docker info >/dev/null 2>&1 && exit 0; sleep 0.5; done
  tail -40 /var/log/dockerd.log; exit 1
'

echo "Running the tests under $runtime..."
docker exec -w /work/packages/container \
  -e WORK_TEST_CONTAINER=1 -e WORK_TEST_CONTAINER_RUNTIME="$runtime" \
  "$name" node ../../node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts ${args[@]+"${args[@]}"}
