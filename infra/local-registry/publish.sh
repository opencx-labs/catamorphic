#!/bin/sh
# Start the local-only development registry and publish the pinned packages.
set -eu
registry_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$registry_dir/../.." && pwd)
registry_url=http://localhost:4873
publish_config="$registry_dir/bunfig.toml"

# Use the repository's pinned Node rather than a machine-dependent global Node.
if [ ! -x "$repo_dir/node_modules/node/bin/node" ]; then
  echo "Run bun install in $repo_dir before starting the package registry." >&2
  exit 1
fi
PATH="$repo_dir/node_modules/node/bin:$PATH"
export PATH

if ! curl --connect-timeout 1 --max-time 2 -fsS "$registry_url/-/ping" >/dev/null 2>&1; then
  (
    cd "$registry_dir"
    nohup bunx --package verdaccio@6.10.3 verdaccio --config "$registry_dir/config.yaml" --listen localhost:4873 > "$registry_dir/verdaccio.log" 2>&1 < /dev/null &
  )
  attempts=0
  until curl --connect-timeout 1 --max-time 2 -fsS "$registry_url/-/ping" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      echo "The local registry did not become ready. See $registry_dir/verdaccio.log" >&2
      exit 1
    fi
    sleep 1
  done
fi

for package in app parser workflow; do
  (
    cd "$repo_dir/packages/$package"
    bun run build
    # Absolute config path: publishing runs inside each package, not the root.
    # Keep versions immutable. A conflict must not silently retain stale code.
    if ! bun publish --config="$publish_config"; then
      echo "Could not publish @catamorphic/$package. If this version already exists, bump its package.json and package version constant together before retrying." >&2
      exit 1
    fi
  )
done
printf '\nPackages are available at %s. See infra/local-registry/README.md for project-scoped installation.\n' "$registry_url"
