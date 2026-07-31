import {
  type GithubRepoSummary,
  useGithubRepos,
  useGithubStatus,
  useTemplates,
} from "@catamorphic/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  FolderOpen,
  FolderPlus,
  Import,
  Lock,
  Search,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

type Mode = "create" | "import" | "github";

/** GitHub mark (lucide dropped brand icons). */
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function ProjectModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: { id: string; name: string }) => void;
}) {
  const [mode, setMode] = useState<Mode>("create");
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string>();
  const [parentDir, setParentDir] = useState("");
  const [importDir, setImportDir] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<GithubRepoSummary | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templatesQuery = useTemplates();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    setMode("create");
    setName("");
    setTemplateId(undefined);
    setImportDir(null);
    setSelectedRepo(null);
    setPending(false);
    setError(null);
    void desktopApi.defaultProjectsDir().then(setParentDir);
  }, [open]);

  const slug = slugify(name);
  const targetPath =
    mode === "create" || mode === "github"
      ? parentDir && slug
        ? `${parentDir}/${slug}`
        : null
      : importDir;

  const canSubmit =
    !pending &&
    name.trim().length > 0 &&
    targetPath !== null &&
    (mode !== "github" || selectedRepo !== null);

  const browseParent = async () => {
    const picked = await desktopApi.pickFolder({
      title: "Choose where the project folder is created",
      defaultPath: parentDir || undefined,
    });
    if (picked) setParentDir(picked);
  };

  const browseImport = async () => {
    const picked = await desktopApi.pickFolder({
      title: "Choose the project folder to import",
    });
    if (picked) {
      setImportDir(picked);
      if (!name.trim()) {
        setName(picked.split("/").filter(Boolean).pop() ?? "");
      }
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !targetPath) return;
    setPending(true);
    setError(null);
    try {
      const project =
        mode === "github" && selectedRepo
          ? await desktopApi.githubImport({
              fullName: selectedRepo.fullName,
              name: name.trim(),
              rootPath: targetPath,
            })
          : await desktopApi.createProject({
              name: name.trim(),
              rootPath: targetPath,
              ...(mode === "create"
                ? { templateId }
                : { importExisting: true }),
            });
      await queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
      onCreated(project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="px-5 pt-5 pb-1">
          <div
            className="grid grid-cols-3 gap-1 rounded-lg bg-bg-inset p-1"
            role="tablist"
            aria-label="Project source"
          >
            <ModeTab
              active={mode === "create"}
              onSelect={() => setMode("create")}
              icon={<FolderPlus className="size-3.5" />}
              label="New project"
            />
            <ModeTab
              active={mode === "import"}
              onSelect={() => setMode("import")}
              icon={<Import className="size-3.5" />}
              label="Import folder"
            />
            <ModeTab
              active={mode === "github"}
              onSelect={() => setMode("github")}
              icon={<GithubIcon className="size-3.5" />}
              label="GitHub"
            />
          </div>
        </div>

        <AnimatedHeight>
          <div
            // Re-mounting on mode swap restarts the fade-in for the new set
            // of fields; height is animated by the wrapper.
            key={mode}
            className="animate-fade-in flex flex-col gap-4 px-5 py-4"
          >
            {mode === "import" && (
              <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
                Folder
                <button
                  type="button"
                  onClick={browseImport}
                  data-testid="import-folder-picker"
                  className="field flex h-8 cursor-pointer items-center gap-2 px-2.5 text-left text-[13px]"
                >
                  <FolderOpen className="size-3.5 shrink-0 text-fg-faint" />
                  {importDir ? (
                    <span className="truncate text-fg" dir="rtl">
                      {importDir}
                    </span>
                  ) : (
                    <span className="text-fg-faint">
                      Choose an existing folder…
                    </span>
                  )}
                </button>
              </label>
            )}

            {mode === "github" && (
              <GithubPanel
                selected={selectedRepo}
                onSelect={(repo) => {
                  setSelectedRepo(repo);
                  if (repo && !name.trim()) setName(repo.name);
                }}
              />
            )}

            {(mode !== "github" || selectedRepo !== null) && (
              <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
                Name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={
                    mode === "create" ? "My project" : "Project name"
                  }
                  // biome-ignore lint/a11y/noAutofocus: modal's primary field
                  autoFocus={mode !== "github"}
                  data-testid="project-name-input"
                  className="field h-8 px-2.5 text-[13px] text-fg placeholder:text-fg-faint"
                />
              </label>
            )}

            {mode === "create" && (
              <>
                <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
                  Location
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={browseParent}
                      data-testid="location-picker"
                      className="field flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 text-left text-[13px]"
                    >
                      <FolderOpen className="size-3.5 shrink-0 text-fg-faint" />
                      <span className="truncate text-fg" dir="rtl">
                        {parentDir || "…"}
                      </span>
                    </button>
                  </div>
                </label>

                {templatesQuery.data && templatesQuery.data.length > 0 && (
                  <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
                    Template
                    <select
                      value={templateId ?? ""}
                      onChange={(event) =>
                        setTemplateId(event.target.value || undefined)
                      }
                      className="field h-8 px-2 text-[13px] text-fg"
                    >
                      <option value="">Empty project</option>
                      {templatesQuery.data.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}

            {targetPath && (
              <p
                className="truncate text-xs text-fg-faint"
                data-testid="target-path"
              >
                {mode === "import" ? "Linked to " : "Will be created at "}
                <span className="font-mono text-fg-muted">{targetPath}</span>
              </p>
            )}

            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
        </AnimatedHeight>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            Cancel
          </button>
          <PendingButton
            type="submit"
            pending={pending}
            pendingLabel={
              mode === "create"
                ? "Creating…"
                : mode === "github"
                  ? "Cloning…"
                  : "Importing…"
            }
            disabled={!canSubmit}
            data-testid="project-submit"
            className="h-8 cursor-pointer rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mode === "create"
              ? "Create project"
              : mode === "github"
                ? "Import from GitHub"
                : "Import project"}
          </PendingButton>
        </footer>
      </form>
    </Modal>
  );
}

/**
 * GitHub source picker: connect (device flow) when no account is linked,
 * then a searchable repo list. Selection drives the shared name/location
 * fields in the parent form.
 */
function GithubPanel({
  selected,
  onSelect,
}: {
  selected: GithubRepoSummary | null;
  onSelect: (repo: GithubRepoSummary | null) => void;
}) {
  const statusQuery = useGithubStatus();
  const connected = statusQuery.data?.connected === true;
  const reposQuery = useGithubRepos({ enabled: connected });
  const queryClient = useQueryClient();
  const [userCode, setUserCode] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    return desktopApi.onGithubConnected((result) => {
      setUserCode(null);
      if (result && "error" in result) {
        setAuthError(result.error);
        return;
      }
      setAuthError(null);
      void queryClient.invalidateQueries({
        queryKey: ["cat", "github"],
      });
    });
  }, [queryClient]);

  const startConnect = async () => {
    setAuthError(null);
    try {
      const grant = await desktopApi.githubConnectStart();
      setUserCode(grant.userCode);
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (statusQuery.isLoading) {
    return <p className="text-xs text-fg-faint">Checking GitHub…</p>;
  }

  if (!connected) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        {userCode ? (
          <>
            <p className="text-xs text-fg-muted">
              Enter this code on GitHub to authorize:
            </p>
            <p
              className="select-all font-mono text-xl font-semibold tracking-[0.25em] text-fg"
              data-testid="github-user-code"
            >
              {userCode}
            </p>
            <p className="text-xs text-fg-faint">
              Waiting for authorization… the browser window opened
              automatically.
            </p>
          </>
        ) : (
          <>
            <GithubIcon className="size-6 text-fg-faint" />
            <p className="text-xs text-fg-muted">
              Connect your GitHub account to import a repository.
            </p>
            <button
              type="button"
              onClick={startConnect}
              data-testid="github-connect"
              className="h-8 cursor-pointer rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90"
            >
              Connect GitHub
            </button>
          </>
        )}
        {authError && <p className="text-xs text-danger">{authError}</p>}
      </div>
    );
  }

  const repos = reposQuery.data ?? [];
  const visible = filter
    ? repos.filter((repo) =>
        repo.fullName.toLowerCase().includes(filter.toLowerCase()),
      )
    : repos;

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
        Repository
        <span className="field flex h-8 items-center gap-2 px-2.5">
          <Search className="size-3.5 shrink-0 text-fg-faint" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={
              statusQuery.data?.login
                ? `Search ${statusQuery.data.login}'s repositories…`
                : "Search repositories…"
            }
            // biome-ignore lint/a11y/noAutofocus: primary field of this tab
            autoFocus
            data-testid="github-repo-search"
            className="w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
          />
        </span>
      </label>

      <div
        className="max-h-44 overflow-y-auto rounded-md border border-border"
        data-testid="github-repo-list"
      >
        {reposQuery.isLoading ? (
          <p className="px-3 py-4 text-center text-xs text-fg-faint">
            Loading repositories…
          </p>
        ) : reposQuery.isError ? (
          <p className="px-3 py-4 text-center text-xs text-danger">
            {reposQuery.error.message}
          </p>
        ) : visible.length === 0 ? (
          repos.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
              <p className="text-xs text-fg-faint">
                No repositories granted to Catamorphic yet.
              </p>
              <button
                type="button"
                onClick={() => void desktopApi.githubManageRepos()}
                data-testid="github-grant-access"
                className="cursor-pointer text-xs text-accent hover:underline"
              >
                Grant repository access on GitHub
              </button>
            </div>
          ) : (
            <p className="px-3 py-4 text-center text-xs text-fg-faint">
              No repositories match.
            </p>
          )
        ) : (
          visible.map((repo) => (
            <button
              key={repo.id}
              type="button"
              onClick={() => onSelect(selected?.id === repo.id ? null : repo)}
              data-testid={`github-repo-${repo.fullName}`}
              className={`flex w-full cursor-pointer items-center gap-2 border-b border-border px-2.5 py-1.5 text-left text-[13px] transition-colors duration-100 last:border-b-0 ${
                selected?.id === repo.id
                  ? "bg-bg-overlay text-fg"
                  : "text-fg-muted hover:bg-bg-inset hover:text-fg"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
              {repo.private && (
                <Lock className="size-3 shrink-0 text-fg-faint" />
              )}
              {selected?.id === repo.id && (
                <Check className="size-3.5 shrink-0 text-accent" />
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Animates its height to follow the content's measured size, so swapping the
 * mode fields glides instead of snapping the modal to a new height.
 */
function AnimatedHeight({ children }: { children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const observer = new ResizeObserver(() => setHeight(inner.offsetHeight));
    observer.observe(inner);
    setHeight(inner.offsetHeight);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      style={{ height }}
      className="overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.2,0,0,1)]"
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}

function ModeTab({
  active,
  onSelect,
  icon,
  label,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={`flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] transition-colors duration-150 ${
        active
          ? "bg-bg-overlay text-fg shadow-sm"
          : "text-fg-muted hover:text-fg"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
