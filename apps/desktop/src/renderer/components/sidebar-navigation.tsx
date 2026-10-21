import { useItemActions } from "@catamorphic/app/ui";
import { ChevronRight, LoaderCircle } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeybindingAction } from "../../shared/actions.js";
import type { OpenMode } from "../../shared/open-mode.js";
import {
  matchesProjectExperience,
  type ProjectExperienceContext,
} from "../../shared/project-experience.js";
import {
  isHostAction,
  matchesSidebarSurface,
  type SidebarActionInput,
  type SidebarMenuEntry,
  type SidebarSectionConfig,
  type SidebarSurface,
  sectionKind,
  sectionModule,
  sessionSection,
  workSourceName,
} from "../../shared/sidebar.js";
import type { SidebarSourceSession } from "../../shared/sidebar-source.js";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";
import { sectionRows } from "../palette/modes/custom.js";
import type { PaletteItem, PaletteModeRequest } from "../palette/types.js";
import { AppScreen } from "../screens/app-screen.js";
import type { SectionSource } from "../sources/contract.js";
import { itemsSource } from "../sources/items.js";
import { moduleSource } from "../sources/module.js";
import { grantSources, useWorkSourcesContext } from "../sources/registry.js";
import { runRowAction } from "../sources/run.js";
import { ActionInputDialog } from "./action-input-dialog.js";
import { Collapsible } from "./collapsible.js";
import { ShortcutHint } from "./shortcut-hint.js";
import {
  type SidebarContentState,
  SidebarContribution,
  type SidebarStatus,
  useSidebarContribution,
} from "./sidebar-contribution.js";
import { useSidebarHost } from "./sidebar-host.js";
import { SidebarIcon } from "./sidebar-item-row.js";
import { SidebarNote } from "./sidebar-note.js";
import { SidebarStatusBody } from "./sidebar-status.js";
import { SourceSection } from "./source-section.js";

/** The command a `command:<id>` target runs. */
const commandOf = (url: string | undefined) =>
  url?.startsWith("command:") ? url.slice("command:".length) : undefined;

/**
 * One sidebar section, shaped by the layout (ADR 0234): rows from a source,
 * static items, an app, or a note. Every list goes through the same
 * `SourceSection`; header buttons are the layout's `headerActions`.
 */
export function ConfiguredSection({
  section,
  relevant,
  surface,
  report,
  visible,
  observeEmpty = false,
  onCustomize,
  onSearch,
  experienceContext,
  memberShell,
  projectId,
  profileId,
  onOpenUrl,
  onOpenSessionLink,
  onOpenFile,
  onError,
}: {
  section: SidebarSectionConfig;
  relevant: boolean;
  surface: SidebarSurface;
  report: (state: SidebarContentState) => void;
  visible: boolean;
  /** Hidden only for being empty: it keeps listening so it can come back. */
  observeEmpty?: boolean;
  onCustomize: () => void;
  onSearch: (
    request: Omit<Extract<PaletteModeRequest, { mode: "section" }>, "nonce">,
  ) => void;
  experienceContext: ProjectExperienceContext;
  memberShell: boolean;
  projectId: string;
  profileId?: string;
  /** Open a workspace target: a page, a chat, a file, a command. */
  onOpenUrl: (url: string, mode: OpenMode) => void;
  /**
   * Open a page for the chat whose session the sidebar shows, as a link
   * in that chat opens: in a tab the chat owns (ADR 0226).
   */
  onOpenSessionLink: (url: string, mode: OpenMode) => void;
  onOpenFile: (filePath: string, mode?: OpenMode) => void;
  /** A searched row's action failed after the palette closed. */
  onError: (message: string) => void;
}) {
  const kind = sectionKind(section);
  // Its rows belong to the chat beside it (ADR 0226): links open as the
  // chat's, and the palette, which has no chat, does not search it.
  const sessionScoped = sessionSection(section);
  const open = sessionScoped ? onOpenSessionLink : onOpenUrl;
  const sources = useWorkSourcesContext();
  const module = sectionModule(section);
  const listed = workSourceName(section.source);
  // Static items depend on what is in front (their own `when`); sources
  // never do, so switching tabs never rebuilds (and re-reads) one.
  const itemsKey =
    kind === "items"
      ? JSON.stringify([
          section.items ?? [],
          surface.kind,
          surface.sessionId,
          surface.path,
          surface.selection,
          surface.tabPlacement,
        ])
      : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemsKey is the value identity of the items and the surface they read; presentation edits keep the source.
  const source = useMemo((): SectionSource | null => {
    if (kind === "items")
      return itemsSource({
        items: section.items ?? [],
        ownerId: section.id,
        keep: (item) =>
          matchesProjectExperience(item.when, experienceContext) &&
          matchesSidebarSurface(item.when, surface),
      });
    if (listed) return sources.get(listed);
    // Local code never runs for a project on a server (ADR 0140).
    if (module && !memberShell)
      return moduleSource({ projectId, ownerId: section.id, work: sources });
    return null;
  }, [
    kind,
    listed,
    module,
    memberShell,
    projectId,
    section.id,
    itemsKey,
    sources,
    experienceContext,
  ]);
  const grantKey = JSON.stringify(section.collections ?? []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: grantKey is the value identity of the grant list
  const collections = useMemo(
    () => grantSources(sources, section.collections),
    [sources, grantKey],
  );
  const [status, setStatus] = useState<SidebarStatus>({ state: "loading" });
  useEffect(() => {
    report(status.state);
  }, [report, status.state]);
  const refreshers = useRef(new Set<() => unknown>());
  const registerRefresh = useCallback((refresh: () => unknown) => {
    refreshers.current.add(refresh);
    return () => {
      refreshers.current.delete(refresh);
    };
  }, []);
  const lists = kind === "source" || kind === "items";
  const commands = new Set([
    ...(lists || kind === "note" ? ["refresh"] : []),
    // Every list is searchable in the palette, but one chat's rows: the
    // palette has no chat beside it.
    ...(lists && source && !sessionScoped ? ["search"] : []),
  ]);
  /** What the section is called, shown or not (its accessible name). */
  const name =
    kind === "app"
      ? (section.app ?? "App")
      : kind === "note"
        ? "Project note"
        : (source?.title ?? "Items");
  const title = section.title ?? name;
  const search = () =>
    source &&
    onSearch({
      mode: "section",
      label: title || (source?.title ?? "Items"),
      load: (signal: AbortSignal): Promise<PaletteItem[]> =>
        sectionRows({ section, source, signal, open: onOpenUrl, onError }),
    });
  const [inputRequest, setInputRequest] = useState<{
    label: string;
    input: SidebarActionInput;
    run: (values: Record<string, string>) => Promise<unknown>;
  } | null>(null);
  const [message, setMessage] = useState<string>();
  // The chat a chat-scoped section shows, kept by its list.
  const chat = useRef<SidebarSourceSession | undefined>(undefined);
  /** A header button: a target, one of Work's verbs, or the source's action. */
  const runHeader = async (entry: SidebarMenuEntry): Promise<void> => {
    if (entry.url) {
      open(entry.url, "replace");
      return;
    }
    if (entry.action === "refresh") {
      await Promise.all([...refreshers.current].map((refresh) => refresh()));
      return;
    }
    if (entry.action === "search") {
      search();
      return;
    }
    if (!source || isHostAction(entry.action))
      throw new Error("This section does not support this action");
    const run = async (values?: Record<string, string>) => {
      const effect = await runRowAction({
        source,
        itemId: "",
        action: entry.action,
        values,
        ...(chat.current ? { session: chat.current } : {}),
        signal: new AbortController().signal,
        open,
      });
      if (effect?.message) setMessage(effect.message);
      await Promise.all([...refreshers.current].map((refresh) => refresh()));
    };
    const input = entry.input;
    if (input) setInputRequest({ label: entry.label, input, run });
    else await run();
  };
  const headerActions =
    section.headerActions ??
    (kind === "app" && section.app
      ? [
          {
            label: "Open app in tab",
            action: "open",
            icon: "PanelRight",
            url: `app:${section.app}`,
          },
        ]
      : []);
  const defaultOpen = !section.collapsed;
  const body =
    kind === "note" ? (
      <SidebarSection title={title} name={name} defaultOpen={defaultOpen}>
        {(expanded) => (
          <SidebarNote
            key={`${profileId}:${projectId}:${section.id}`}
            projectId={projectId}
            scope={`${profileId}:${projectId}:${section.id}`}
            path={typeof section.note === "string" ? section.note : undefined}
            visible={visible && expanded}
            onOpenFile={onOpenFile}
          />
        )}
      </SidebarSection>
    ) : kind === "app" ? (
      <SidebarSection title={title} name={name} defaultOpen={defaultOpen}>
        {(expanded) =>
          section.app ? (
            <AppScreen
              projectId={projectId}
              appName={section.app}
              compact
              surface={surface}
              collections={collections}
              onContentState={(state) => setStatus({ state })}
              height={section.height}
              visible={visible && expanded}
            />
          ) : (
            <button type="button" onClick={onCustomize}>
              Choose an app
            </button>
          )
        }
      </SidebarSection>
    ) : (
      <SidebarSection title={title} name={name} defaultOpen={defaultOpen}>
        {source ? (
          <SourceSection projectId={projectId} source={source} />
        ) : (
          <p className="sidebar-empty-state">
            Local sources are unavailable in this project.
          </p>
        )}
      </SidebarSection>
    );
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(undefined), 8000);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <SidebarContribution
      value={{
        section: { ...section, headerActions },
        surface,
        visible,
        relevant,
        observeEmpty,
        status,
        report: setStatus,
        open,
        commands,
        registerRefresh,
        runHeader,
        chat,
        command: async (action) => {
          if (!commands.has(action))
            throw new Error("This section does not support this action");
          if (action === "search") search();
          else if (action === "refresh")
            await Promise.all(
              [...refreshers.current].map((refresh) => refresh()),
            );
        },
      }}
    >
      {body}
      {message && (
        <p role="status" className="sidebar-empty-state">
          {message}
        </p>
      )}
      <ActionInputDialog
        request={inputRequest}
        onClose={() => setInputRequest(null)}
      />
    </SidebarContribution>
  );
}

function SidebarSection({
  title,
  name,
  defaultOpen = false,
  children,
}: {
  /** Empty for a section without a heading (its rows stand alone). */
  title: string;
  /** Its name for assistive technology when it shows no heading. */
  name: string;
  defaultOpen?: boolean;
  children: ReactNode | ((expanded: boolean) => ReactNode);
}) {
  const contribution = useSidebarContribution();
  const host = useSidebarHost();
  const keybindings = useKeybindings();
  const headerActions = (contribution?.section.headerActions ?? []).filter(
    // A command not on offer here (a member creating workflows) is not shown.
    (entry) => {
      const command = commandOf(entry.url);
      return !command || (host?.commandAvailable(command) ?? true);
    },
  );
  const status = contribution?.status;
  // A first load shows the skeleton; the header spins only while rows on
  // screen are being refreshed, so nothing loops while a section waits.
  const refreshing = Boolean(status?.refreshing);
  const loading = status?.state === "loading" && !status.idle;
  const refresh = contribution?.commands?.has("refresh")
    ? () => contribution?.command?.("refresh")
    : undefined;
  const actionState = useItemActions();
  const headed = title !== "";
  const [open, setOpen] = useState(defaultOpen || !headed);
  const [visited, setVisited] = useState(defaultOpen || !headed);
  useEffect(() => {
    setOpen(defaultOpen || !headed);
    if (defaultOpen || !headed) setVisited(true);
  }, [defaultOpen, headed]);
  const content =
    typeof children === "function"
      ? (visited || open) && children(open)
      : children;
  const shortcutOf = (entry: SidebarMenuEntry) => {
    const command = commandOf(entry.url);
    const binding =
      command && command in keybindings
        ? keybindings[command as KeybindingAction]
        : undefined;
    return binding ? formatBinding(binding) : undefined;
  };
  return (
    <section
      className={`sidebar-section ${headed ? "pb-2" : "pb-1"}`}
      data-sidebar-section={contribution?.section.id}
      data-sidebar-scrollbar={contribution?.section.scrollbar ? "" : undefined}
      aria-busy={loading || refreshing || undefined}
      aria-label={headed ? undefined : name}
    >
      {/* Title, then the section's actions, then the disclosure chevron at
          the far right. Nothing in a header appears only on hover. */}
      {headed && (
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => {
              setVisited(true);
              setOpen((value) => !value);
            }}
            className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-xs font-medium text-fg-muted hover:text-fg"
            aria-expanded={open}
          >
            <span className="truncate">{title}</span>
          </button>
          {refreshing && (
            <span
              role="status"
              aria-label={`Refreshing ${title}`}
              className="grid size-7 shrink-0 place-items-center text-fg-muted"
            >
              <LoaderCircle
                aria-hidden="true"
                data-loading-for={contribution?.section.id}
                className="size-3 animate-spin motion-reduce:animate-none"
              />
            </span>
          )}
          {headerActions.map((entry) => (
            <ShortcutHint
              key={`${entry.action}:${entry.label}:${entry.url ?? ""}`}
              label={entry.disabledReason ?? entry.label}
              shortcut={shortcutOf(entry)}
            >
              <button
                type="button"
                aria-label={entry.label}
                data-header-action={entry.url ?? entry.action}
                disabled={
                  Boolean(entry.disabledReason) || Boolean(actionState.pending)
                }
                data-disabled-reason={entry.disabledReason}
                className="grid size-7 cursor-pointer place-items-center rounded text-fg-muted hover:bg-bg-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() =>
                  void actionState.run({
                    id: entry.action,
                    label: entry.label,
                    disabledReason: entry.disabledReason,
                    run: async () => {
                      await contribution?.runHeader?.(entry);
                    },
                  })
                }
              >
                <SidebarIcon name={entry.icon} />
              </button>
            </ShortcutHint>
          ))}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => {
              setVisited(true);
              setOpen((value) => !value);
            }}
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted hover:text-fg"
          >
            <ChevronRight
              className={`size-3 transition-transform duration-150 ease-standard ${
                open ? "rotate-90" : ""
              }`}
            />
          </button>
        </div>
      )}
      {actionState.error && (
        <p role="alert" className="sidebar-empty-state">
          {actionState.error}
        </p>
      )}
      <Collapsible open={open}>
        {contribution ? (
          <SidebarContribution
            value={{ ...contribution, visible: contribution.visible && open }}
          >
            <SidebarStatusBody
              status={contribution.status}
              empty={contribution.section.empty}
              retry={contribution.status.retry ?? refresh}
            />
            {content}
          </SidebarContribution>
        ) : (
          content
        )}
      </Collapsible>
    </section>
  );
}
