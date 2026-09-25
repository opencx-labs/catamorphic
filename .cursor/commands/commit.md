# Commit

Commit the current work. Only run this when the user asked for a commit (`AGENTS.md`: never commit or push unless asked).

## Steps

1. **Check the branch.** Engineering work happens on a feature branch in its own worktree. If you are on `main`, create a branch first unless the user said to commit to `main`.
2. **Verify.** Run `bun run check` (Docker must be running) unless it already passed on this exact diff. Do not commit failing work without saying so.
3. **Review.** Read `git status` and `git diff`. Look for stray files, generated output that should not land, and secrets (`.env`, keys, tokens).
4. **Stage by path.** `git add <paths>` for the files that belong to this change. Use `git add -A` only when every change belongs. Split unrelated changes into separate commits.
5. **Write the message** (below) and commit with a heredoc so the body keeps its line breaks.
6. **Push only if asked.** After pushing to `main`, watch the CI run to completion and treat a failure as unfinished work.

## Message

- **Subject:** one plain-language line saying what changed, in the imperative or as the outcome, no trailing period. Examples from history: `Observe scoped Git changes instead of frequent status polling`, `Open imported folders without initializing Git`. A short area prefix is fine when it helps (`e2e: let the recovery test wait for the spinner to fade`). Conventional-commit types are not required.
- **Body:** a short paragraph on why and what behavior changed, wrapped for reading. Name ADRs, regenerated artifacts (API client, DB types), and follow-ups.
- **Trailer:** add the attribution or co-author line your harness or the user specifies, and a ticket reference only if the user gave one.

```bash
git commit -F - <<'EOF'
Open imported folders without initializing Git

Adopting a folder no longer creates a repository, writes manifests, or
installs seeds. Git initializes only when an operation needs history
(ADR 0141).
EOF
```
