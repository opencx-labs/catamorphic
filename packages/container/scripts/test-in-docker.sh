#!/usr/bin/env bash
# Run the container backend's real-sandbox tests (WORK_TEST_CONTAINER=1) on a
# Linux machine with Docker and gVisor, from any machine with Docker: the
# machine is a privileged container (test-machine.Dockerfile) running its
# own daemon with a `runsc` runtime. The checkout is copied in without
# node_modules and installed there, since Linux needs its own.
#
#   packages/container/scripts/test-in-docker.sh [--suite container|review]
#     [--runtime runsc|runc] [--keep | --machine NAME] [vitest args]
#
# --suite container (the default) runs this package's tests; --suite review
# runs the review recipe end to end (packages/work-server
# src/review.container.test.ts) on a Work server with a disposable Postgres
# in the machine, under gVisor. --keep leaves the machine running and prints
# how to reuse it; --machine NAME reuses one kept that way (its images and
# installed packages stay). Without either the machine and its volumes are
# removed when the run ends.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
runtime=runsc
keep=0
suite=container
name=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) runtime="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    --suite) suite="$2"; shift 2 ;;
    --machine) name="$2"; keep=1; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

# The postgres image `bun run test` pins (scripts/test-postgres.ts).
postgres_image="postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42"
case "$suite" in
  container)
    workspace=@catamorphic/container
    directory=packages/container
    test_env=()
    ;;
  review)
    workspace=@catamorphic/work-server
    directory=packages/work-server
    [ "$runtime" = runsc ] || { echo "The review suite runs under gVisor only" >&2; exit 2; }
    # The CA its review images trust stays in the machine, so a kept
    # machine reuses the images it built.
    test_env=(-e "DATABASE_URL=postgresql://catamorphic:catamorphic@127.0.0.1:5432/catamorphic" -e "WORK_TEST_REVIEW_CACHE=/root/.cache/work-review")
    [ ${#args[@]} -gt 0 ] || args=(--pool=forks src/review.container.test.ts)
    ;;
  *) echo "Unknown suite $suite: use container or review" >&2; exit 2 ;;
esac

image=work-container-test-machine
reused=0
if [ -n "$name" ]; then
  docker inspect "$name" >/dev/null 2>&1 || { echo "No machine named $name" >&2; exit 2; }
  reused=1
else
  name="work-container-test-$$"
  echo "Building the test machine image..."
  docker build -q -f "$here/test-machine.Dockerfile" -t "$image" "$here" >/dev/null
fi

cleanup() {
  if [ "$keep" = 1 ]; then
    echo "Kept the machine: docker exec -it $name bash; reuse it with --machine $name (remove it with: docker rm -f -v $name)"
  else
    docker rm -f -v "$name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# The machine's Docker data lives in an anonymous volume, removed with it:
# overlay storage cannot sit on the container's own overlay root.
[ "$reused" = 1 ] || docker run -d --privileged --name "$name" -v /var/lib/docker "$image" >/dev/null

echo "Copying the checkout..."
docker exec "$name" mkdir -p /work
(cd "$repo" && git ls-files -z --cached --others --exclude-standard) |
  (cd "$repo" && COPYFILE_DISABLE=1 tar --null -T - -cf -) |
  docker exec -i "$name" tar -x --warning=no-unknown-keyword -C /work

echo "Installing and building..."
# Only what the suite's package, the runner bundle its sandboxes start, and
# the root tools need.
docker exec -w /work -e WORKSPACE="$workspace" "$name" bash -c '
  set -euo pipefail
  bun install --frozen-lockfile --ignore-scripts --filter "$WORKSPACE" --filter @catamorphic/runner-bundle --filter catamorphic >/tmp/install.log 2>&1 || { tail -40 /tmp/install.log; exit 1; }
  bun scripts/tool-runtime.ts install
  bun scripts/tool-runtime.ts turbo run build "--filter=$WORKSPACE..." --filter=@catamorphic/runner-bundle... --output-logs=errors-only >/tmp/build.log 2>&1 || { tail -60 /tmp/build.log; exit 1; }
'

echo "Waiting for the machine's Docker daemon..."
docker exec "$name" bash -c '
  for i in $(seq 1 120); do docker info >/dev/null 2>&1 && exit 0; sleep 0.5; done
  tail -40 /var/log/dockerd.log; exit 1
'

if [ "$suite" = review ]; then
  echo "Starting a disposable Postgres in the machine..."
  docker exec -e IMAGE="$postgres_image" "$name" sh -c '
    docker rm -f work-test-postgres >/dev/null 2>&1 || true
    docker run -d --rm --name work-test-postgres -p 127.0.0.1:5432:5432 \
      -e POSTGRES_USER=catamorphic -e POSTGRES_PASSWORD=catamorphic -e POSTGRES_DB=catamorphic \
      --health-cmd "pg_isready -U catamorphic -d catamorphic" --health-interval 1s --health-retries 120 \
      "$IMAGE" -c max_connections=300 >/dev/null
    for i in $(seq 1 120); do
      [ "$(docker inspect -f "{{.State.Health.Status}}" work-test-postgres)" = healthy ] && exit 0
      sleep 1
    done
    docker logs work-test-postgres | tail -20; exit 1
  '
fi

echo "Running the tests under $runtime..."
docker exec -w "/work/$directory" \
  -e WORK_TEST_CONTAINER=1 -e WORK_TEST_CONTAINER_RUNTIME="$runtime" ${test_env[@]+"${test_env[@]}"} \
  "$name" bun ../../scripts/tool-runtime.ts vitest --tool-cwd "$directory" --config ../../vitest.config.ts ${args[@]+"${args[@]}"}
