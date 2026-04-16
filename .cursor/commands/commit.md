# Git Commit Command

Create a git commit following Conventional Commits format with optional Linear ticket reference.

## Usage

```
/commit [LINEAR_TICKET]
```

**Examples:**
- `/commit` - Create commit without ticket reference
- `/commit DX-523` - Create commit referencing Linear ticket DX-523
- `/commit` these changes to fix the bug
- `/commit DX-523` implement semantic search feature

## Workflow

1. **Check for project conventions** - Check `AGENTS.md` and `.cursor/rules/` for project-specific commit conventions
2. **Review all changes** - Show unstaged changes with `git diff`
3. **Stage changes atomically** using `git add -p` (interactive patch mode):
   - Review each hunk/chunk of changes
   - Only stage changes that belong together logically
   - Create separate commits for unrelated changes
   - **NEVER** use `git add -A` or `git add .` - always use `git add -p` for atomic commits
4. **Review staged changes** - Verify what will be committed with `git diff --staged`
5. **Determine commit type and scope** from staged files:
   - Files in `backend/` → scope: `backend`
   - Files in `dashboard/` → scope: `dashboard`
   - Files in `docs/` → scope: `docs`
   - If multiple scopes → use multi-scope format: `feat(backend, dashboard):`
5. **Identify sub-scope** (feature module) from file paths:
   - `ai-instructions`, `ai-training`, `agent-v2`, `airbyte`, `knowledge-base`, `inbox`, `workflow`, `integration`, etc.
6. **Generate commit message** following format:
   ```
   type(scope, sub-scope): subject
   
   Body explaining HOW and WHY (if complex change).
   
   Linear: DX-523
   ```
7. **Create the commit** using `git commit -m`

## Commit Format

**Format**: `type(scope, sub-scope): subject`

### Main Scopes (Required)
- `backend` - Backend/nestjs API changes
- `dashboard` - Dashboard/Next.js frontend changes  
- `docs` - Documentation changes

### Sub-Scopes (Optional, feature module)
Examples: `ai-instructions`, `ai-training`, `agent-v2`, `airbyte`, `SourceCard`, `voc`, `knowledge-base`, `inbox`, `workflow`, `integration`, etc.

### Commit Types
- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code refactoring
- `perf` - Performance improvement
- `test` - Test changes
- `ci` - CI/CD changes
- `docs` - Documentation
- `chore` - Maintenance
- `style` - Formatting
- `security` - Security fixes
- `hotfix` - Critical production fix

### Subject Rules
- Max 50 characters after colon
- Present tense imperative: add, implement, fix, improve, enhance, refactor, remove
- NO period at end
- Specific and descriptive

## Linear Ticket Integration

If Linear ticket number provided (e.g., `DX-523`):
- Add `Linear: DX-523` at end of commit body
- If no body, create minimal body with just the Linear reference

**Example:**
```
feat(dashboard, ai-instructions): enhance EditorSidebar with collapsible sections

Added collapsible sections with scroll indicators for better UX.

Linear: DX-523
```

## Examples

**Simple commit:**
```
fix(dashboard, ai-instructions): truncate long breadcrumb titles
```

**Commit with Linear ticket:**
```
feat(backend, dashboard): implement semantic search for AI Instructions

Added semantic search endpoint and dashboard integration.

Linear: DX-523
```

**Multi-scope commit:**
```
feat(backend, dashboard): implement semantic search for AI Instructions

Linear: DX-523
```

## Atomic Commit Principles

- **ONE logical change per commit** - Each commit should represent a single, complete change
- **Use `git add -p`** - Always use interactive patch mode to select specific changes
- **Review before staging** - Review each hunk and only stage related changes
- **Separate unrelated changes** - If you have multiple unrelated changes, create multiple commits
- **Testable commits** - Each commit should leave the codebase in a working state

**Using `git add -p` effectively:**
- `y` - Stage this hunk (if it belongs with current commit)
- `n` - Skip this hunk (commit separately later)
- `s` - Split large hunk into smaller pieces
- `e` - Manually edit hunk boundaries
- `q` - Quit (remaining hunks stay unstaged)

**Example:** If a file has both feature code and formatting fixes:
1. Use `git add -p` on the file
2. Stage feature hunks → commit as `feat(...)`
3. Stage formatting hunks → commit as `style(...)`

## Important Rules

- **ALWAYS** check project conventions (`AGENTS.md` and `.cursor/rules/`) first
- **ALWAYS** use `git add -p` for staging (interactive patch mode)
- **ALWAYS** review changes before staging
- **ALWAYS** include main scope: `backend`, `dashboard`, or `docs`
- **ALWAYS** include sub-scope when identifiable from file paths
- **NEVER** use `git add -A` or `git add .` - breaks atomic commit principle
- **NEVER** commit secrets (`.env`, credentials)
- **NEVER** use generic messages
- **NEVER** exceed 50 chars in subject line
- **NEVER** mix unrelated changes in one commit
- One logical change = one commit
