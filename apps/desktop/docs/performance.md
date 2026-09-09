# Desktop resource verification

Run `bun run build` before measuring. From the worktree root:

```sh
bun scripts/desktop-soak.ts --duration=300 --interval=5 --output=/tmp/catamorphic-soak.json
```

The runner launches the real Electron build with isolated data and the fake agent.
It exercises repeated tab creation/close, then samples foreground, simulated
background and resumed idle. No external model or user workspace is involved.
Use `--duration=28800 --interval=30` for an overnight sample. Ctrl+C preserves
samples and runs normal app teardown.

Reports contain process-tree CPU deltas, summed RSS, process counts, and renderer
DevTools performance metrics (heap, nodes, listeners, requests and task duration
where Chromium exposes them). Summed RSS can double-count shared pages; compare
like-for-like runs, not it against an OS process's private footprint. The sampler
currently supports macOS and Linux. Its background phase emulates focus loss;
it does not simulate real OS sleep or prove native minimized-window behavior.

For sleep/wake investigations, collect a separate real-device recording including
suspend/resume timestamps. Preserve workload, build SHA, OS, interval, warmup and
baseline. Compare growth over repeated cycles and sustained idle CPU; do not claim
an overnight leak is fixed from a brief flat trace. Keep long runs outside the
normal merge gate. `e2e/runtime-idle.e2e.ts` remains the fast lifecycle regression
suite for hidden loops, browser visibility and guest cleanup.

## Palette search

The palette prepares searchable labels and keywords when its source arrays change.
Settings metadata comes from `shared/settings-catalog.ts`; typing never reads
configuration files or calls a settings API. Normal search includes settings, and
`settings` + Space or Tab selects a settings-only index. Literal matches take
priority; the existing fuzzy scorer handles abbreviations and typos when no literal
match exists. Render at most 80 results. Queries longer than 256 characters or
containing a newline bypass fuzzy search and remain available to agent/web actions.

Search remains linear in catalog size, plus sorting matches. A local Bun probe on
2026-09-09 measured 75 settings at 0.05 ms p95, and a synthetic 10,000-resource
index at 15.4 ms p95 across literal, abbreviated and missing queries (30 samples).
These are search-function timings, not Electron keystroke-to-paint latency or a
portable performance guarantee. Native tests cover the actual typing/navigation
flow. If real workspaces grow beyond this budget, measure their query distribution
before adding a worker or a more complex index.

`renderer/lib/palette-search.test.ts` covers bounded large-index results and long
input. Preserve the prepared-index boundary and result cap when adding providers.
