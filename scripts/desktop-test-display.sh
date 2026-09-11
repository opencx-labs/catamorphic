#!/usr/bin/env bash
set -euo pipefail
openbox >"${CATAMORPHIC_E2E_ARTIFACTS_DIR}/openbox.log" 2>&1 &
window_manager=$!
trap 'kill "$window_manager" 2>/dev/null || true' EXIT
# Wait for the WM to claim the display before testing maximize/restore.
for attempt in {1..100}; do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; then
    export CATAMORPHIC_E2E_PRIVATE_DISPLAY=1
    "$@"
    exit $?
  fi
  sleep 0.05
done
echo 'Openbox did not become ready on the private display' >&2
exit 1
