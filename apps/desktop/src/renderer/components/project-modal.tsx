import { useTemplates } from "@catamorphic/react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, FolderPlus, Import } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";

type Mode = "create" | "import";

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
    setPending(false);
    setError(null);
    void desktopApi.defaultProjectsDir().then(setParentDir);
  }, [open]);

  const slug = slugify(name);
  const targetPath =
    mode === "create"
      ? parentDir && slug
        ? `${parentDir}/${slug}`
        : null
      : importDir;

  const canSubmit = !pending && name.trim().length > 0 && targetPath !== null;

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
      const project = await desktopApi.createProject({
        name: name.trim(),
        rootPath: targetPath,
        ...(mode === "create" ? { templateId } : { importExisting: true }),
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
            className="grid grid-cols-2 gap-1 rounded-lg bg-bg-inset p-1"
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
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-bg-inset px-2.5 text-left text-[13px] transition-colors duration-150 hover:border-border-strong"
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

            <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
              Name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={mode === "create" ? "My project" : "Project name"}
                // biome-ignore lint/a11y/noAutofocus: modal's primary field
                autoFocus
                data-testid="project-name-input"
                className="h-8 rounded-md border border-border bg-bg-inset px-2.5 text-[13px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
              />
            </label>

            {mode === "create" && (
              <>
                <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
                  Location
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={browseParent}
                      data-testid="location-picker"
                      className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border border-border bg-bg-inset px-2.5 text-left text-[13px] transition-colors duration-150 hover:border-border-strong"
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
                      className="h-8 rounded-md border border-border bg-bg-inset px-2 text-[13px] text-fg"
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
                {mode === "create" ? "Will be created at " : "Linked to "}
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
          <button
            type="submit"
            disabled={!canSubmit}
            data-testid="project-submit"
            className="h-8 cursor-pointer rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending
              ? mode === "create"
                ? "Creating…"
                : "Importing…"
              : mode === "create"
                ? "Create project"
                : "Import project"}
          </button>
        </footer>
      </form>
    </Modal>
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
