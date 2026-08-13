#!/bin/sh
# (Re)start the local registry and publish the user-project-facing packages
# at their pinned versions. Run from the repo root.
set -e
cd "$(dirname "$0")"
curl -sf http://localhost:4873/-/ping >/dev/null 2>&1 || {
  (bunx verdaccio --config config.yaml --listen 4873 > verdaccio.log 2>&1 &)
  sleep 5
}
cd ../..
for p in app parser workflow; do
  (cd "packages/$p" && bun run build && bun publish --registry http://localhost:4873) || true
done
