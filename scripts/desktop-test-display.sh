#!/usr/bin/env bash
set -euo pipefail
log="${CATAMORPHIC_E2E_ARTIFACTS_DIR}/openbox.log"
window_manager=""
trap '[ -n "$window_manager" ] && kill "$window_manager" 2>/dev/null || true' EXIT

# xvfb-run can hand over before Xvfb accepts connections. Openbox started
# then exits at once ("Failed to open the display"), so wait for the server.
for attempt in {1..200}; do
  if xprop -root >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 200 ]; then
    echo 'The private display did not accept connections' >&2
    exit 1
  fi
  sleep 0.05
done

# Wait for the WM to claim the display before testing maximize/restore. A
# window manager that exits before claiming it is started again, bounded.
for start in 1 2 3; do
  echo "== start $start" >>"$log"
  openbox >>"$log" 2>&1 &
  window_manager=$!
  for attempt in {1..200}; do
    if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; then
      export CATAMORPHIC_E2E_PRIVATE_DISPLAY=1
      "$@"
      exit $?
    fi
    kill -0 "$window_manager" 2>/dev/null || break
    sleep 0.05
  done
  kill "$window_manager" 2>/dev/null || true
  wait "$window_manager" 2>/dev/null || true
  window_manager=""
done
echo 'Openbox did not become ready on the private display' >&2
exit 1
