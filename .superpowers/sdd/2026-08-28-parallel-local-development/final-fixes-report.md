# Final Whole-Branch Review Fixes

## Scope

- Root orchestration coverage and root script typechecking
- Pinned-Node package-local Vitest commands
- Development lock, process-group, and port-allocation lifecycle
- Disposable Postgres labeling and dual-failure reporting
- Secure development state roots and external S3 test documentation
- Assistive-technology-safe deferred autofocus

## Baseline

- GREEN: `bun run test:file scripts/check-plan.test.ts scripts/tool-runtime.test.ts scripts/dev-plan.test.ts scripts/dev-runtime.test.ts scripts/test-postgres.test.ts scripts/test.test.ts --config vitest.config.ts`
  - 6 files passed, 50 tests passed.

## RED/GREEN Log

Entries are added after each observed failing test and its minimal passing implementation.

- RED: `bun run test:file scripts/check-plan.test.ts scripts/tool-runtime.test.ts scripts/test.test.ts --config vitest.config.ts`
  - 6 expected failures proved that the check plan omitted root typecheck/tests, the deterministic test runner had only the Turbo phase, root commands were absent, and workspace-local Vitest scripts still used ambient Node.
- GREEN: the same focused command passed 3 files and 24 tests after adding the explicit root phases, dry-graph guard, commands, and package-local launchers.
- RED: `bun run typecheck:scripts`
  - Failed with TS2688 because the new dedicated root project correctly exposed that the root package did not declare `@types/node`; the package already exists elsewhere in the workspace but is not root-resolvable under Bun's isolated install.
- GREEN: `bun run typecheck:scripts` passed after declaring the existing workspace Node types at the root and fixing the two latent strict-type errors the dedicated project exposed.
- GREEN: the parser's focused 14-test command passed with ambient Node `v20.12.2`; its package script selected repository Node through `scripts/tool-runtime.ts`.
- RED: `bun run test:file scripts/test-postgres.test.ts --config vitest.config.ts`
  - 2 expected failures proved Docker lacked the exact `catamorphic.test-run` label and a task failure suppressed a simultaneous cleanup failure.
- GREEN: the same Postgres command passed 16 tests after adding the exact label and preserving both errors in an `AggregateError` while stopping once.
- RED: `bun run test:file scripts/dev-runtime.test.ts --config vitest.config.ts`
  - 4 expected failures proved state roots were not private, locks lacked child process-group metadata/token-safe rebinding, live groups could be reclaimed after launcher death, and shutdown depended on an external SIGKILL fallback.
- GREEN: `bun run test:file scripts/dev-plan.test.ts scripts/dev-runtime.test.ts scripts/dev-ports.test.ts --config vitest.config.ts` passed 26 tests after the lifecycle and allocator implementation.
- RED: `bun run test:file scripts/dev-runtime.test.ts --config vitest.config.ts` exposed that an already-created development state root retained mode 0755.
- GREEN: the same 13-test lifecycle file passed after enforcing mode 0700 for both new and existing state roots; `bun run dev:server --print` also left the shared allocator root at 0700.
- RED: `bun run --cwd apps/desktop test:e2e`
  - The deterministic `Cmd+W closes the tab behind the floating chat when the tab has focus` flow failed because an assistive-technology-style external `focus()` was overwritten by the held autofocus frame. The run was stopped after the expected failure was captured.
- GREEN: `bun run --cwd apps/desktop typecheck` and `bun run --cwd apps/desktop test:e2e -- e2e/app.e2e.ts` passed; the full stateful app file completed 40 tests, including internal autofocus plus keyboard, pointer, and assistive-technology focus authority.

## Final Verification

- GREEN: `bun run test:scripts` passed 8 files and 80 tests. This covers the root orchestration plan/dry graph, package command literals, development lifecycle/allocator, and disposable Postgres cleanup behavior.
- GREEN: `bun run lint` checked 990 files with no fixes required.
- GREEN: `bun run typecheck:scripts` passed the dedicated root production/test project.
- GREEN: `bun run typecheck` passed 53 of 53 Turbo tasks.
- GREEN: `bun run build` passed 29 of 29 Turbo tasks.
- GREEN: `bun run --cwd apps/desktop test:e2e -- e2e/app.e2e.ts` rebuilt the desktop and passed all 40 focused E2E tests on the final tree.
- GREEN: with ambient Node `v20.12.2`, `bun run --cwd packages/parser test src/__tests__/parser.test.ts` routed through the repository runtime and passed 14 tests.
- GREEN: `git diff --check` reported no whitespace errors.

The intentionally reserved ADR 0074 and the primary checkout were not modified. The full 12-phase `bun run check` was intentionally left for the controller's exact-head final gate, as directed.
