# Git Commit Command

Create a git commit following [Conventional Commits](https://www.conventionalcommits.org/) with an optional Linear ticket reference. This repo is the **Catamorphic** Turborepo (`packages/*`); scopes should reflect where the change lives.

## Usage

```
/commit [LINEAR_TICKET]
```

**Examples:**

- `/commit` — commit without a ticket line
- `/commit CM-42` — add `Linear: CM-42` to the commit body
- `/commit CM-42` fix parser crash on empty workflow

## Workflow

1. **Read project conventions** — `AGENTS.md` and `.cursor/rules/` (especially after substantive code changes, run the verification checklist there before considering work done).
2. **Review changes** — `git diff` (and `git status` for untracked files).
3. **Stage atomically** with `git add -p` (interactive patch mode):
   - Stage hunks that belong to one logical change; split with `s` when needed.
   - Prefer **separate commits** for unrelated changes.
   - **Do not** use `git add -A` or `git add .` for routine staging.
4. **Confirm staged diff** — `git diff --staged`.
5. **Pick `type` and `scope(s)`** from staged paths (see below).
6. **Write the message** — subject + optional body; add `Linear: TICKET` when the user supplied a ticket.
7. **Commit** — `git commit` (or `git commit -m` with `-m` for body if needed).

For **new untracked files**, use `git add -N <path>` then `git add -p <path>` so patch mode still applies.

## Commit format

**Shape:** `type(scope): subject` or `type(scope, scope): subject` when multiple areas are equally involved.

**Common scopes (from repo layout)**

| Scope | Paths / meaning |
| ----- | --------------- |
| `parser` | `packages/parser` |
| `ui` | `packages/ui` |
| `server` | `packages/server` |
| `db` | `packages/db` (migrations, Kysely) |
| `runtime` | `packages/runtime` |
| `sandbox` | `packages/sandbox` |
| `api-client` | `packages/api-client` |
| `repo` | Root config only (`package.json`, `turbo.json`, `biome.json`, CI, workspace tooling) |
| `docs` | `README.md`, `AGENTS.md`, `.cursor/` docs, other top-level docs |

If a change is clearly owned by one package, use that package’s scope. Use two scopes only when the commit genuinely crosses those areas (e.g. `feat(server, api-client): add projects list endpoint` after regenerating the client).

**Types**

- `feat` — new behavior
- `fix` — bug fix
- `refactor` — behavior-preserving restructure
- `perf` — performance
- `test` — tests only
- `ci` — CI/CD
- `docs` — documentation
- `chore` — maintenance, deps, tooling
- `style` — formatting / lint-only
- `security` — security-sensitive fix

**Subject**

- After `type(scope):`, keep the subject **≤ 50 characters**, imperative mood (*add*, *fix*, *wire*), no trailing period.

## Linear ticket

If the user passes a ticket id (e.g. `CM-42`):

- Add a line at the **end of the body**: `Linear: CM-42`
- If there is no other body, the commit body can be just that line.

## Examples

**Single package:**

```
fix(parser): handle empty step body in workflow graph
```

**Server + generated client:**

```
feat(server, api-client): expose workflow run status

Regenerated OpenAPI client after route change.

Linear: CM-42
```

**Repo / tooling:**

```
chore(repo): tighten biome ignore for generated files
```

## Atomic commits

- One logical change per commit; each commit should leave the repo in a sensible state.
- Use `git add -p` so unrelated hunks can land in separate commits.
- **Do not** commit secrets (`.env`, keys, tokens).
- **Do not** run `git commit` or `git push` unless the user asked (see `AGENTS.md`).

**`git add -p` prompts:** `y` stage hunk, `n` skip, `s` split, `e` edit, `q` quit (rest stays unstaged).
