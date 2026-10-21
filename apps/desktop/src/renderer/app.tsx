import {
  useAgentSessions,
  useAppPresentations,
  useArchiveAgentSession,
  useCatamorphic,
  useCreateAgentSession,
  useForkAgentSession,
  useProjects,
  useRenameAgentSession,
  useUnarchiveAgentSession,
  useUpdateAgentSession,
  useWorkflows,
  workflowKeys,
} from "@catamorphic/react";
import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import {
  PROJECT_APP_DATA_DIR,
  PROJECT_STORE_DIR,
} from "@catamorphic/workflow/project-layout";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Columns2,
  Download,
  FolderPlus,
  Link2,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Settings as SettingsIcon,
  Sparkles,
  Wand2,
} from "lucide-react";
import {
  lazy,
  type MouseEvent as ReactMouseEvent,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  type ActionId,
  BUILTIN_ACTIONS,
  KEYBINDING_ACTIONS,
  PAGE_FIRST_ACTIONS,
} from "../shared/actions.js";
import {
  type HarnessPermissions,
  hasPermissionMode,
} from "../shared/agent-permissions.js";
import {
  chatBookmarkUrl,
  parseChatBookmarkUrl,
} from "../shared/bookmark-target.js";
import type { PendingChatMessage } from "../shared/chat.js";
import type { WorkspaceNavigation } from "../shared/desktop-workspace.js";
import { type DownloadRecord, fileUrlFor } from "../shared/downloads.js";
import type { HistoryEntry } from "../shared/history.js";
import {
  type OpenMode as CommitMode,
  type OpenModifiers,
  openModeFromEvent,
} from "../shared/open-mode.js";
import { samePage } from "../shared/page-url.js";
import {
  type ProjectExperienceContext,
  writesProgram,
} from "../shared/project-experience.js";
import {
  type SidebarSide,
  type SidebarSurface,
  workSourceName,
} from "../shared/sidebar.js";
import { siteHost, siteOrigin } from "../shared/site-settings.js";
import {
  isBrowserFile,
  localFileUrl,
  parseSurfaceLink,
  resolveProjectFileLocation,
} from "../shared/surface-link.js";
import type { TerminalMacro } from "../shared/terminal-macros.js";
import { fieldKeepsKey } from "../shared/text-field.js";
import { isVoiceAction, rosterAgentId } from "../shared/voice.js";
import { parseWorkPage } from "../shared/work-pages.js";
import {
  chipsModule,
  sidebarSections,
  visibleWorkspaceConfig,
} from "../shared/workspace-config.js";
import {
  activateSearch,
  findSearchInput,
  findSearchTarget,
} from "./components/action-search-input.js";
import {
  type AgentPointer,
  AgentPointers,
  pointedElement,
} from "./components/agent-pointers.js";
import { AgentWizard } from "./components/agent-wizard.js";
import { appIconName } from "./components/app-icon.js";
import { BrowserImportDialog } from "./components/browser-import.js";
import type { ChatDockEntry } from "./components/chat-dock.js";
import { ChatRegistration } from "./components/chat-registration.js";
import { CommandPalette } from "./components/command-palette.js";
import { ConfigureAgentModal } from "./components/configure-agent-modal.js";
import { ConnectorsModal } from "./components/connectors-modal.js";
import { DefaultBrowserButton } from "./components/default-browser.js";
import { DeleteProjectModal } from "./components/delete-project-modal.js";
import {
  ElicitationModal,
  type PendingElicitation,
} from "./components/elicitation-modal.js";
import { ExtensionPromptHost } from "./components/extensions/extension-dialogs.js";
import { FloatingPanelBar } from "./components/floating-panel-bar.js";
import { MobilePairingModal } from "./components/mobile-pairing-modal.js";
import { Modal } from "./components/modal.js";
import { PasskeyHost } from "./components/passkey-sheet.js";
import { PendingButton } from "./components/pending-button.js";
import {
  PreviewPortDialog,
  type PreviewPortRequest,
} from "./components/preview-port-dialog.js";
import { ProfileBar } from "./components/profile-bar.js";
import { ProjectAgentConsentDialog } from "./components/project-agent-consent.js";
import { useRemoteProject } from "./components/project-authority-provider.js";
import { ProjectModal } from "./components/project-modal.js";
import { ProjectSwitcher } from "./components/project-switcher.js";
import {
  RemoteProposeModal,
  RemotePublishModal,
} from "./components/remote-actions-modals.js";
import { RemoteConnectModal } from "./components/remote-connect-modal.js";
import { RemoteConnectionIndicator } from "./components/remote-connection-indicator.js";
import { RemoteEnvironmentModal } from "./components/remote-environment-modal.js";
import { RemoteHistoryModal } from "./components/remote-history-modal.js";
import { RemoteMembersModal } from "./components/remote-members-modal.js";
import { RemoteSecretsModal } from "./components/remote-secrets-modal.js";
import { RemoteServiceConnectionsModal } from "./components/remote-service-connections-modal.js";
import { ScreenShareHost } from "./components/screen-share-picker.js";
import {
  ArchiveSessionDialog,
  CreateSubsessionDialog,
  RenameChatDialog,
} from "./components/session-lifecycle-dialogs.js";
import {
  DisabledControlHints,
  ShortcutHint,
} from "./components/shortcut-hint.js";
import type { SidebarContentState } from "./components/sidebar-contribution.js";
import { SidebarHostProvider } from "./components/sidebar-host.js";
import { ConfiguredSection } from "./components/sidebar-navigation.js";
import type { SessionCommand } from "./components/sidebar-session-inspector.js";
import { SiteSettingsHost } from "./components/site-settings-modal.js";
import { TabbedSidebar } from "./components/tabbed-sidebar.js";
import { UpdateBanner } from "./components/update-banner.js";
import {
  tabKey,
  type WorkspaceTab,
  WorkspaceTabBar,
} from "./components/workspace-tabs.js";
import { notePersonInput } from "./lib/app-focus.js";
import {
  type ChatSessionAction,
  type ChatSessionMenuEntry,
  chatSessionMenu,
} from "./lib/chat-session-actions.js";
import {
  type Chip,
  CLOSE_CHIP,
  OPEN_SIDE_CHIP,
  pageIcon,
} from "./lib/chips.js";
import {
  type AgentEffort,
  type AgentsData,
  type AppPrefs,
  type ConnectLink,
  desktopApi,
  type Profile,
  type ProfilesData,
  type ProjectAgentInfo,
  type RemoteFeatures,
  type RemoteProjectStatus,
  type SidebarSectionConfig,
  type WorkspaceConfig,
} from "./lib/desktop-api.js";
import { readEditorSelection } from "./lib/editor-selection.js";
import {
  OPEN_EXTENSION_POPUP_EVENT,
  type OpenExtensionPopupDetail,
} from "./lib/extensions.js";
import {
  useFloatingMotion,
  useRecedingSurface,
} from "./lib/floating-motion.js";
import { historyDestination } from "./lib/history.js";
import {
  formatBinding,
  matchesBinding,
  useKeybindings,
} from "./lib/keybindings.js";
import { prefersReducedMotion } from "./lib/motion.js";
import { notifyDesktop, playChime } from "./lib/notify.js";
import { isMoving, useUnsavedFilesForMove } from "./lib/project-move.js";
import {
  ipcErrorText,
  lastPreviewPort,
  rememberPreviewPort,
} from "./lib/remote-workspace.js";
import { LOCAL_CHATS_POLL_MS } from "./lib/session-change-hints.js";
import { sessionLabel } from "./lib/session-label.js";
import type { SidebarMotion } from "./lib/sidebar-motion.js";
import {
  EMPTY_SURFACE_HISTORY,
  restoreSurface,
  type SurfaceHistory,
  settleSurface,
  stepSurface,
  surfaceChanges,
  surfaceLocation,
  visitSurface,
} from "./lib/surface-history.js";
import { useTabSleep } from "./lib/tab-sleep.js";
import { useWorktreesAvailable } from "./lib/use-session-checkout.js";
import { useSidebarReveal } from "./lib/use-sidebar-reveal.js";
import {
  fileNameFromPath,
  useVisitRecording,
} from "./lib/use-visit-recording.js";
import { useWorkspaceConfig } from "./lib/use-workspace-config.js";
import { voiceTap } from "./lib/voice.js";
import { NEW_WORKFLOW_PROMPT } from "./lib/workflow-authoring.js";
import { useWorkspace } from "./lib/workspace-context.js";
import {
  chipsCustomizationMessage,
  workspaceCustomizationMessage,
} from "./lib/workspace-customization.js";
import {
  agentOpenInFront,
  attachedTabKeys,
  type BrowserEntry,
  browserTabKey,
  CLOSED_TABS_KEPT,
  chatTabKey,
  chatVisible,
  type EditorEntry,
  editorTabKey,
  emptyUtilityWorkspace,
  emptyWorkspace,
  hydrateWorkspace,
  newChatEntry,
  newTabInFront,
  nextActiveTabKey,
  openChatInNewTab,
  orderedTabKeys,
  reconcileWorkspace,
  serializeWorkspace,
  stripTravel,
  type TerminalEntry,
  type TerminalEvent,
  tabbedBrowsers,
  tabbedEditors,
  tabbedTerminals,
  terminalTabKey,
  transitionWorkspace,
  type Workspace,
  workspaceLayout,
} from "./lib/workspace-state.js";
import {
  type PaletteHost,
  PaletteHostProvider,
  type ProjectAgentTarget,
} from "./palette/host.js";
import { loadSourceRows } from "./palette/sources.js";
import type { PaletteChoiceMode, PaletteModeRequest } from "./palette/types.js";
import { AppScreen } from "./screens/app-screen.js";
import { ArtifactScreen } from "./screens/artifact-screen.js";
import {
  type BrowserCommands,
  type BrowserPageState,
  BrowserScreen,
} from "./screens/browser-screen.js";
import { DownloadsScreen } from "./screens/downloads-screen.js";
import { ExtensionsScreen } from "./screens/extensions-screen.js";
import { HistoryScreen } from "./screens/history-screen.js";
import { McpAppScreen } from "./screens/mcp-app-screen.js";
import { PasswordsScreen } from "./screens/passwords-screen.js";
import { ProfileSettingsScreen } from "./screens/profile-settings-screen.js";
import { RunScreen } from "./screens/run-screen.js";
import { SettingsScreen } from "./screens/settings-screen.js";
import { SitesScreen } from "./screens/sites-screen.js";
import {
  useAnswerSourceWork,
  useWorkSources,
  WorkSourcesProvider,
} from "./sources/registry.js";

// Heavy workspace surfaces stay out of the startup parse path. They remain
// mounted after first use so editor state and terminal sessions survive tab
// switches, but a session that never opens them never initializes their
// workers/WASM runtimes.
const TerminalScreen = lazy(() =>
  import("./screens/terminal-screen.js").then((module) => ({
    default: module.TerminalScreen,
  })),
);
const EditorScreen = lazy(() =>
  import("./screens/editor-screen.js").then((module) => ({
    default: module.EditorScreen,
  })),
);
const WorkflowScreen = lazy(() =>
  import("./screens/workflow-screen.js").then((module) => ({
    default: module.WorkflowScreen,
  })),
);
// The usage page (ADR 0057) is a rare destination; keep its chart code
// off the startup parse path.
const UsageScreen = lazy(() =>
  import("./screens/usage-screen.js").then((module) => ({
    default: module.UsageScreen,
  })),
);
// Diff tabs ride the same Monaco chunk; lazy for the same reason.
const DiffScreen = lazy(() =>
  import("./screens/diff-screen.js").then((module) => ({
    default: module.DiffScreen,
  })),
);

/** What a ChatDock reports live; `unread` is derived here in the host. */
interface ChatLiveSignals {
  working: boolean;
  draft: boolean;
  awaitingInput: boolean;
}

const NO_CHAT_SIGNALS: ChatLiveSignals = {
  working: false,
  draft: false,
  awaitingInput: false,
};

const truncateLabel = (value: string): string =>
  value.length <= 40 ? value : `${value.slice(0, 39)}…`;

/** How long the agent-control pill stays before it steps aside. */
const PILL_QUIET_MS = 4_000;

/** Keep `value` within `low` and `high`. */
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * Veil over a surface an agent is driving: interaction is blocked (the
 * surface stays fully visible — watch the agent work live) until the
 * user takes control. A hairline accent ring marks the surface as
 * agent-held; the pill names the owner and offers the two moves that
 * make sense — jump to the owning chat, or take the keys. It steps aside
 * after a few seconds and comes back while the pointer moves over the
 * surface or focus reaches it; dragged by its body, it stays where it is
 * put, inside the surface. A press on the
 * blocked surface (someone who missed the pill) shows the veil itself for
 * a moment, a tinted sheet that gives where it was touched.
 *
 * Stays mounted after `active` flips false to play fade-out (the mirror
 * of its fade-in enter) before disappearing, per the motion contract.
 */
function AgentControlOverlay({
  kind,
  active,
  onTakeOver,
  onGoToChat,
}: {
  kind: "terminal" | "page";
  active: boolean;
  onTakeOver: () => void;
  /** Reveal the chat driving this surface (absent when unattributed). */
  onGoToChat?: () => void;
}) {
  const [phase, setPhase] = useState<"in" | "out" | "gone">(
    active ? "in" : "gone",
  );
  // The latest press on the blocked surface, where it landed: the veil
  // shows for a moment from there (animate-veil-touch).
  const [touch, setTouch] = useState<{
    id: number;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    setPhase((prev) => (active ? "in" : prev === "in" ? "out" : prev));
    if (!active) setTouch(null);
  }, [active]);
  // The pill steps aside after a few seconds so the surface reads whole;
  // the pointer moving over the surface brings it back for a while.
  const [quiet, setQuiet] = useState(false);
  const quietTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setQuiet(false);
    window.clearTimeout(quietTimer.current);
    quietTimer.current = window.setTimeout(() => setQuiet(true), PILL_QUIET_MS);
  }, []);
  useEffect(() => {
    if (active) wake();
    return () => window.clearTimeout(quietTimer.current);
  }, [active, wake]);
  // Dragged by its body (not its buttons), the pill stays where it is put.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Where the drag began, and the offsets that keep the pill inside the
  // surface it marks.
  const drag = useRef<{
    x: number;
    y: number;
    from: typeof offset;
    bounds: { left: number; right: number; top: number; bottom: number };
  } | null>(null);
  const endDrag = () => {
    drag.current = null;
  };
  if (phase === "gone") return null;
  const exiting = phase === "out";
  const anim = exiting ? "animate-fade-out" : "animate-fade-in";
  return (
    // Pill at the top: the floating chat dock owns the bottom center.
    <div
      className={`absolute inset-0 z-20 flex items-start justify-center pt-4 ${exiting ? "pointer-events-none" : ""}`}
      onAnimationEnd={(event) => {
        if (event.animationName === "fade-out") setPhase("gone");
      }}
    >
      <div
        className={`pointer-events-none absolute inset-0 ${anim} ring-2 ring-inset ring-accent/40`}
      />
      {!exiting && (
        /* The blocking layer keeps keys, clicks, and paste away from an
           agent-driven surface — but view-only SCROLLBACK is harmless
           and genuinely useful while watching, so wheel events are
           re-dispatched onto the terminal canvas underneath (ghostty's
           own wheel handler scrolls the viewport; in alternate-screen
           mode its synthesized arrow keys die at the readOnly onData
           guard, so nothing reaches the agent's PTY). Browser panes have
           no canvas here and stay fully blocked. */
        <div
          className="pointer-events-auto absolute inset-0"
          aria-hidden
          onPointerMove={wake}
          onPointerDown={(event) => {
            wake();
            const box = event.currentTarget.getBoundingClientRect();
            setTouch((previous) => ({
              id: (previous?.id ?? 0) + 1,
              x: event.clientX - box.left,
              y: event.clientY - box.top,
            }));
          }}
          onWheel={(event) => {
            const canvas = event.currentTarget
              .closest("[data-surface-pane]")
              ?.querySelector("canvas");
            canvas?.dispatchEvent(new WheelEvent("wheel", event.nativeEvent));
          }}
        />
      )}
      {touch && !exiting && (
        // Keyed by the press, so every press plays it again.
        <div
          key={touch.id}
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-veil-touch bg-accent/10 ring-1 ring-inset ring-accent/30 backdrop-blur-[1.5px]"
          style={{
            transformOrigin: `${touch.x}px ${touch.y}px`,
            backgroundImage: `radial-gradient(circle at ${touch.x}px ${touch.y}px, color-mix(in srgb, var(--color-accent) 22%, transparent), transparent 70%)`,
          }}
          onAnimationEnd={() => setTouch(null)}
        />
      )}
      <div
        className={`${exiting || quiet ? "pointer-events-none" : "pointer-events-auto"} z-10 flex ${anim} cursor-grab touch-none select-none items-center gap-2.5 rounded-full border border-border bg-bg-raised py-1.5 pl-3 pr-1.5 text-xs text-fg shadow-2xl transition-opacity duration-300 ease-[cubic-bezier(0.2,0,0,1)] active:cursor-grabbing ${quiet ? "opacity-0" : "opacity-100"}`}
        style={{ translate: `${offset.x}px ${offset.y}px` }}
        data-agent-control-pill
        role="toolbar"
        aria-label={`Agent owns this ${kind}`}
        onPointerMove={wake}
        // Tabbing to its buttons brings it back too.
        onFocus={wake}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          const pill = event.currentTarget.getBoundingClientRect();
          const area =
            event.currentTarget.parentElement?.getBoundingClientRect() ?? pill;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            from: offset,
            bounds: {
              left: offset.x - (pill.left - area.left),
              right: offset.x + (area.right - pill.right),
              top: offset.y - (pill.top - area.top),
              bottom: offset.y + (area.bottom - pill.bottom),
            },
          };
        }}
        onPointerMoveCapture={(event) => {
          const start = drag.current;
          if (!start) return;
          const { bounds } = start;
          setOffset({
            x: clamp(
              start.from.x + event.clientX - start.x,
              bounds.left,
              bounds.right,
            ),
            y: clamp(
              start.from.y + event.clientY - start.y,
              bounds.top,
              bounds.bottom,
            ),
          });
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="relative flex size-2">
          <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-accent opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-accent" />
        </span>
        Agent owns this {kind}
        {onGoToChat && (
          <button
            type="button"
            onClick={onGoToChat}
            className="flex h-6 cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 text-fg-muted transition-colors duration-150 hover:border-border-strong hover:text-fg"
          >
            <MessageSquare className="size-3" />
            Go to chat
          </button>
        )}
        <button
          type="button"
          onClick={onTakeOver}
          className="h-6 cursor-pointer rounded-full bg-accent px-2.5 font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90"
        >
          Take control
        </button>
      </div>
    </div>
  );
}

/**
 * Floating "return to full width" control on non-browser split panes.
 * z-30 keeps it above the AgentControlOverlay (z-20, whose blocking
 * layer spans the whole pane): surface CONTROLS stay clickable on an
 * agent-held pane; only the surface's content is blocked.
 */
function PaneUnsplitButton({ onClick }: { onClick: () => void }) {
  return (
    <span className="absolute right-2 top-2 z-30">
      <ShortcutHint label="Full width">
        <button
          type="button"
          onClick={onClick}
          className="grid size-7 cursor-pointer place-items-center rounded-lg border border-border bg-bg-raised text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          aria-label="Full width"
        >
          <Columns2 className="size-3.5" />
        </button>
      </ShortcutHint>
    </span>
  );
}

/** The floating chat dock where the user's last pointer interaction landed. */
let lastPointerDownInFloatingChatId: string | undefined;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (event) => {
      const floating =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-floating-chat]")
          : null;
      lastPointerDownInFloatingChatId =
        floating?.dataset.chatLocalId || undefined;
    },
    { capture: true },
  );
}
function focusedChatSurfaceId(): string | undefined {
  const active = document.activeElement;
  if (active && active !== document.body) {
    return (
      active.closest<HTMLElement>("[data-chat-local-id]")?.dataset
        .chatLocalId || undefined
    );
  }
  return lastPointerDownInFloatingChatId;
}

/** An agent's open or close changing the tab in front, awaiting its commit. */
interface AgentArrival {
  /** The strip before the change. */
  strip: string[];
  from: string;
  to: string;
}

export function App({
  runtimeProjectId,
  onProjectResolved,
}: {
  runtimeProjectId?: string;
  onProjectResolved?: (projectId: string) => void;
} = {}) {
  const runtime = useWorkspace();
  const visibleRef = useRef(runtime.visible);
  visibleRef.current = runtime.visible;
  const queryClient = useQueryClient();
  useEffect(
    () =>
      desktopApi.onGitChanged(({ projectId }) => {
        void queryClient.invalidateQueries({
          queryKey: workflowKeys.project({ projectId }),
        });
        void queryClient.invalidateQueries({
          queryKey: ["cat", "project", projectId, "apps"],
        });
      }),
    [queryClient],
  );
  const projectsQuery = useProjects();
  // Subscribe to loading/error changes even while the workspace branch is
  // rendered. Query observers track property reads; recovery cannot depend
  // on whether the empty-state branch happened to read them last render.
  const {
    // A background retry can pause fetching without settling the first load.
    isPending: projectsLoading,
    isError: projectsLoadError,
    isFetching: projectsFetching,
  } = projectsQuery;

  // Boot veil: the window shows nothing but the themed backdrop until the
  // workspace's first paint is complete — profiles, agents, sidebar, and
  // the project list all loaded. No piecemeal popping on launch.
  const [bootRevealed, setBootRevealed] = useState(false);
  const [bootVeilGone, setBootVeilGone] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(
    runtimeProjectId,
  );
  const [workspaces, setWorkspaces] = useState<Record<string, Workspace>>({});
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  // Remote projects (ADR 0055): connect from an invitation link; per-file
  // store history for the current project.
  const [remoteConnect, setRemoteConnect] = useState<{
    open: boolean;
    link: ConnectLink | null;
  }>({ open: false, link: null });
  const [remoteHistoryPath, setRemoteHistoryPath] = useState<string | null>(
    null,
  );
  // Continue on mobile: the QR pairing modal + the chat it should open.
  // Remote environment (ADR 0184): a command, which the Server list's row
  // also offers.
  const [remoteEnvironmentOpen, setRemoteEnvironmentOpen] = useState(false);
  // The server's other dialogs, commands too (ADR 0234).
  const [serverDialog, setServerDialog] = useState<
    "members" | "secrets" | "connections" | null
  >(null);
  const [mobilePairing, setMobilePairing] = useState<{
    open: boolean;
    context: { projectId?: string; sessionId?: string } | null;
  }>({ open: false, context: null });
  // Open preview (ADR 0209): the remote chat whose port is being asked for.
  const [previewRequest, setPreviewRequest] =
    useState<PreviewPortRequest | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Counts preview opens: an answer to one cancelled or replaced since is
  // ignored, so it never opens a tab or touches the next dialog.
  const previewAttemptRef = useRef(0);
  const [remotePublish, setRemotePublish] = useState<{
    path: string;
    features: RemoteFeatures | undefined;
  } | null>(null);
  const [remotePropose, setRemotePropose] = useState<{
    files: string[];
    features: RemoteFeatures | undefined;
  } | null>(null);
  const [remoteSurfaceState, setRemoteSurfaceState] = useState<{
    projectId: string;
    status: RemoteProjectStatus | null;
  } | null>(null);
  const syncingRemoteProjectsRef = useRef(new Set<string>());
  useEffect(() => {
    // Pull the pending link on mount (cold launch from an invite) and
    // whenever main nudges; main clears it once taken.
    const take = () => {
      if (!visibleRef.current) return;
      void desktopApi.remoteTakePendingLink().then((raw) => {
        if (!raw) return;
        void desktopApi.remoteParseLink(raw).then((link) => {
          if (link) setRemoteConnect({ open: true, link });
        });
      });
    };
    take();
    return desktopApi.onConnectLink(take);
  }, []);
  const [deletingProject, setDeletingProject] = useState<ProjectSummary | null>(
    null,
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Raised each time the person opens a sidebar: it focuses the row of
  // what is in front (TabbedSidebar).
  const [sidebarFocusRequest, setSidebarFocusRequest] = useState(0);
  const [rightSidebarFocusRequest, setRightSidebarFocusRequest] = useState(0);
  // A sidebar moves first and takes or gives back its space once still;
  // its toggles, and the room the chrome makes for it, follow the motion
  // rather than the setting.
  const [sidebarMotion, setSidebarMotion] = useState<SidebarMotion>({
    phase: "open",
    docked: true,
    push: false,
  });
  const [savedRightSidebarOpen, setSavedRightSidebarOpen] = useState(false);
  const [rightSidebarMotion, setRightSidebarMotion] = useState<SidebarMotion>({
    phase: "closed",
    docked: false,
    push: false,
  });
  // Opening an empty sidebar is a temporary customization affordance, scoped
  // to this profile/project. It must not replace the populated-sidebar choice.
  const [emptyRightSidebar, setEmptyRightSidebar] = useState<{
    scope: string;
    open: boolean;
  } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [closingWorkflow, setClosingWorkflow] = useState<string | null>(null);
  // Live per-chat signals reported by each ChatDock (working / draft /
  // awaiting-input); unread is host-derived (needs surface visibility).
  const [signalsByChat, setSignalsByChat] = useState<
    Record<string, ChatLiveSignals>
  >({});
  // Surfaces an agent opened in the BACKGROUND (open_surface while the
  // user was on another tab): chat localId → surface keys whose chip
  // carries the attention indicator. Cleared when the user opens that
  // surface (dismissal-by-interaction, like point_at's glow).
  const [chipAttention, setChipAttention] = useState<Record<string, string[]>>(
    {},
  );

  // Notification preferences (per profile): soft chime + desktop banner
  // when an agent finishes or asks a question. Also carries relaunch
  // state: sidebar visibility and the last active project.
  const [activeProfileId, setActiveProfileId] = useState<string>();
  const [profilePrefs, setPrefs] = useState<AppPrefs | null>(null);
  const [projectPrefs, setProjectPrefs] = useState<{
    key: string;
    values: AppPrefs;
  } | null>(null);
  const prefsScope = `${activeProfileId}:${activeProjectId}`;
  const prefs =
    projectPrefs?.key === prefsScope ? projectPrefs.values : profilePrefs;
  const [browserNavigationHost, setBrowserNavigationHost] =
    useState<HTMLDivElement | null>(null);
  const [browserToolbarHost, setBrowserToolbarHost] =
    useState<HTMLDivElement | null>(null);
  useEffect(() => {
    void desktopApi.getPrefs().then((loaded) => {
      setPrefs(loaded);
      setSidebarOpen(loaded.sidebarOpen);
      setSavedRightSidebarOpen(loaded.rightSidebarOpen);
    });
    return desktopApi.onPrefsChanged((next) => {
      setPrefs(next);
      setSidebarOpen(next.sidebarOpen);
      setSavedRightSidebarOpen(next.rightSidebarOpen);
    });
  }, []);
  useEffect(() => {
    let current = true;
    let request = 0;
    const refresh = () => {
      const generation = ++request;
      void desktopApi
        .getSettings({ projectId: activeProjectId })
        .then((result) => {
          if (current && generation === request)
            setProjectPrefs({ key: prefsScope, values: result.values });
        })
        .catch((error) =>
          console.error("Could not load workspace settings", error),
        );
    };
    refresh();
    const unsubscribe = desktopApi.onPrefsChanged(refresh);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [activeProjectId, prefsScope]);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const setSessionListPreference = useCallback(
    (
      key: "unreadSessionIds",
      sessionIds: readonly string[],
      included: boolean,
    ) => {
      const current = prefsRef.current;
      if (!current || sessionIds.length === 0) return;
      const changedIds = new Set(sessionIds);
      const currentIds = current[key];
      const nextIds = included
        ? [...new Set([...currentIds, ...sessionIds])]
        : currentIds.filter((id) => !changedIds.has(id));
      if (
        nextIds.length === currentIds.length &&
        nextIds.every((id, index) => id === currentIds[index])
      ) {
        return;
      }
      const patch: Partial<AppPrefs> = { unreadSessionIds: nextIds };
      const next = { ...current, ...patch };
      prefsRef.current = next;
      setPrefs(next);
      void desktopApi.setPrefs(patch);
    },
    [],
  );

  // Profiles own the whole environment: session partition, projects,
  // theme/keys/sidebar, and the AI agent roster. Each window is born on a
  // profile (main assigns it); the sidebar shows that profile's projects.
  const [profilesData, setProfilesData] = useState<ProfilesData | null>(null);

  useEffect(() => {
    void Promise.all([
      desktopApi.profilesList(),
      desktopApi.windowProfile(),
    ]).then(([data, windowProfileId]) => {
      setProfilesData(data);
      setActiveProfileId((current) => current ?? windowProfileId);
    });
    return desktopApi.onProfilesChanged(setProfilesData);
  }, []);

  const activeProfile: Profile | undefined =
    profilesData?.profiles.find((profile) => profile.id === activeProfileId) ??
    profilesData?.profiles[0];

  // Profile settings tabs are live views. Keep their strip labels in sync
  // with renames broadcast from this or another window.
  useEffect(() => {
    if (!profilesData) return;
    const names = new Map(
      profilesData.profiles.map((profile) => [profile.id, profile.name]),
    );
    setWorkspaces((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, workspace]) => [
          id,
          {
            ...workspace,
            tabs: workspace.tabs.map((tab) =>
              tab.kind === "profile-settings" && names.has(tab.name)
                ? { ...tab, label: names.get(tab.name) }
                : tab,
            ),
          },
        ]),
      ),
    );
  }, [profilesData]);

  // The active profile's AI agents (per-profile agents.json).
  const [agentsData, setAgentsData] = useState<AgentsData | null>(null);
  useEffect(() => {
    void desktopApi.agentsList().then(setAgentsData);
    return desktopApi.onAgentsChanged(setAgentsData);
  }, []);

  // The agent setup wizard: one experience behind every entry point — the
  // auto-opened tab on agent-less profiles, the modal that gates starting
  // a chat with no agents, Settings' "Add agent", and the palette command.
  const [wizardModalOpen, setWizardModalOpen] = useState(false);
  // The modal was opened to add the assistant (ADR 0216): the agent it
  // sets up becomes the assistant.
  const wizardForAssistantRef = useRef(false);
  const createAssistant = () => {
    wizardForAssistantRef.current = true;
    setWizardModalOpen(true);
  };
  // Either wizard surface (tab or modal) reports being mid-flow.
  const wizardEngagedRef = useRef(false);
  const setWizardEngaged = useCallback((engaged: boolean) => {
    wizardEngagedRef.current = engaged;
  }, []);
  const [connectorsModalOpen, setConnectorsModalOpen] = useState(false);
  // Ref'd for the agent-bridge handler (a mount-time effect closure).
  const setConnectorsModalOpenRef = useRef(setConnectorsModalOpen);
  setConnectorsModalOpenRef.current = setConnectorsModalOpen;
  // Profiles whose auto-opened setup tab the user closed this session —
  // closing it skips setup (the modal still gates chat attempts).
  const setupDismissedRef = useRef(new Set<string>());

  // In-place profile switch: a full-window veil fades up, the workspace
  // swaps beneath it, and the veil fades away (see switchProfile).
  const [profileVeil, setProfileVeil] = useState<{
    stage: "in" | "out";
    target?: Profile;
  } | null>(null);

  const allProjects = projectsQuery.data?.items ?? [];
  // Projects created before profiles existed have no owner; the default
  // profile shows them (matches main-process lazy adoption).
  const ownedElsewhere = new Set(
    profilesData?.profiles
      .filter((profile) => profile.id !== activeProfile?.id)
      .flatMap((profile) => profile.projectIds) ?? [],
  );
  const projects = activeProfile
    ? allProjects.filter(
        (project) =>
          activeProfile.projectIds.includes(project.id) ||
          (activeProfile.id === profilesData?.defaultProfileId &&
            !ownedElsewhere.has(project.id)),
      )
    : allProjects;
  const activeProject = runtimeProjectId
    ? projects.find((project) => project.id === runtimeProjectId)
    : (projects.find((project) => project.id === activeProjectId) ??
      // A relaunch lands in the profile's last active project, then the
      // profile default, then whatever exists.
      projects.find((project) => project.id === prefs?.lastProjectId) ??
      projects.find(
        (project) => project.id === activeProfile?.defaultProjectId,
      ) ??
      projects[0]);
  const projectId = activeProject?.id;
  const remoteSurfaceResolved = Boolean(
    projectId && remoteSurfaceState?.projectId === projectId,
  );
  const remoteSurfaceStatus = remoteSurfaceResolved
    ? (remoteSurfaceState?.status ?? null)
    : null;
  const hasAgents =
    Boolean(remoteSurfaceStatus) || (agentsData?.agents.length ?? 0) > 0;
  /** True = chat may start; false = the wizard modal took over. */
  const requireAgents = (): boolean => {
    if (
      (projectId && !remoteSurfaceResolved) ||
      agentsData === null ||
      hasAgents
    )
      return true;
    setWizardModalOpen(true);
    return false;
  };

  const memberShell = !remoteSurfaceResolved
    ? true
    : remoteSurfaceStatus !== null &&
      !writesProgram(remoteSurfaceStatus.capabilities);
  const memberShellRef = useRef(memberShell);
  memberShellRef.current = memberShell;
  const experienceRoot = remoteSurfaceResolved && remoteSurfaceStatus === null;
  const experiencePermissions = remoteSurfaceStatus?.capabilities?.permissions;
  // Stable between renders: the palette and sidebars derive indexes from it.
  const projectExperienceContext = useMemo<ProjectExperienceContext>(
    () => ({ root: experienceRoot, permissions: experiencePermissions ?? [] }),
    [experienceRoot, experiencePermissions],
  );
  const sidebarScope = `${activeProfile?.id}:${projectId}`;
  // The workspace file (sidebars and palette modes), resolved per project.
  const {
    config: workspaceConfig,
    scope: workspaceConfigScope,
    error: workspaceError,
  } = useWorkspaceConfig({ projectId, scope: sidebarScope });
  const visibleWorkspace = useMemo(
    () =>
      visibleWorkspaceConfig({
        config: workspaceConfig,
        context: projectExperienceContext,
      }),
    [workspaceConfig, projectExperienceContext],
  );

  useEffect(() => {
    setEmptyRightSidebar((current) =>
      current?.scope === sidebarScope ? current : null,
    );
  }, [sidebarScope]);
  const rightSidebarHasContent = Boolean(
    projectId &&
      workspaceConfigScope === sidebarScope &&
      remoteSurfaceResolved &&
      visibleWorkspace?.sidebars.right.length,
  );
  const emptyRightSidebarOpen =
    emptyRightSidebar?.scope === sidebarScope ? emptyRightSidebar.open : null;
  const rightSidebarOpen =
    emptyRightSidebarOpen ?? (rightSidebarHasContent && savedRightSidebarOpen);
  useEffect(() => {
    if (!rightSidebarHasContent || emptyRightSidebarOpen === null) return;
    // Content added during customization inherits the panel's current pose;
    // from this point onward the existing profile preference owns it again.
    setSavedRightSidebarOpen(emptyRightSidebarOpen);
    void desktopApi.setPrefs({ rightSidebarOpen: emptyRightSidebarOpen });
    setEmptyRightSidebar(null);
  }, [rightSidebarHasContent, emptyRightSidebarOpen]);

  useEffect(() => {
    if (!projectId) {
      setRemoteSurfaceState(null);
      return;
    }
    let cancelled = false;
    const refresh = (sync = false) => {
      void desktopApi
        .remoteStatus(projectId)
        .then((status) => {
          if (cancelled) return;
          setRemoteSurfaceState({ projectId, status });
          if (
            sync &&
            status?.connection.state === "connected" &&
            !syncingRemoteProjectsRef.current.has(projectId)
          ) {
            syncingRemoteProjectsRef.current.add(projectId);
            void (async () => {
              await desktopApi.remoteSync(projectId);
              const nextStatus = await desktopApi.remoteStatus(projectId);
              if (!cancelled) {
                setRemoteSurfaceState({ projectId, status: nextStatus });
              }
            })()
              .catch(() => undefined)
              .finally(() => {
                syncingRemoteProjectsRef.current.delete(projectId);
              });
          }
        })
        .catch(() => {
          if (!cancelled) setRemoteSurfaceState({ projectId, status: null });
        });
    };
    refresh(true);
    const unsubscribe = desktopApi.onGitChanged((event) => {
      if (event.projectId === projectId) refresh(true);
    });
    const syncOnFocus = () => refresh(true);
    window.addEventListener("focus", syncOnFocus);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("focus", syncOnFocus);
    };
  }, [projectId]);
  useEffect(() => {
    if (projectId) {
      setActiveProjectId(projectId);
      onProjectResolved?.(projectId);
    }
  }, [projectId, onProjectResolved]);

  const startWithAgent = async (): Promise<void> => {
    const project = await desktopApi.createDefaultProject();
    if (activeProfile) {
      // This entry point explicitly asks for the Cmd+N-style modal. Prevent
      // the agent-less-profile effect from opening its setup tab underneath.
      setupDismissedRef.current.add(activeProfile.id);
    }
    await projectsQuery.refetch();
    selectProject(project.id);
    setWizardModalOpen(true);
  };

  // Project policy (ADR 0062): the committed manifest may disable
  // incognito sessions for this project's members.
  const [incognitoAllowed, setIncognitoAllowed] = useState(false);
  // A Git project with a commit can give a chat its own worktree (ADR 0215).
  const worktreesAvailable = useWorktreesAvailable(projectId).data ?? false;
  const [startingActions, setStartingActions] = useState<
    Array<{ label: string; prompt: string; agentId?: string }>
  >([]);
  useEffect(() => {
    if (!projectId) {
      setStartingActions([]);
      return;
    }
    setStartingActions([]);
    setIncognitoAllowed(false);
    let cancelled = false;
    void Promise.allSettled([
      desktopApi.projectAllowIncognito(projectId),
      desktopApi.projectStartingActions(projectId),
    ]).then(([allowed, actions]) => {
      if (cancelled) return;
      setIncognitoAllowed(
        allowed.status === "fulfilled" ? allowed.value : false,
      );
      setStartingActions(actions.status === "fulfilled" ? actions.value : []);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  /**
   * Switching profile follows the workspace's occupancy: an empty
   * workspace (no tabs, no browsers, no chats) switches this window in
   * place under a full-window fade; anything open means real work — that
   * stays put and the profile opens in its own window instead.
   */
  const switchProfile = (profile: Profile) => {
    if (profile.id === activeProfileId) return;
    const ws = workspaceRef.current;
    // Palette "New Tab" pages don't count as open work — a fresh workspace
    // is seeded with one, and Chrome's New Tab page has the same non-claim
    // on the window.
    const emptyWorkspaceNow =
      ws.browsers.length === 0 &&
      ws.chats.length === 0 &&
      ws.terminals.length === 0 &&
      ws.editors.length === 0 &&
      ws.tabs.every(
        (tab) => tab.kind === "palette" || tab.kind === "agent-setup",
      );
    if (
      !emptyWorkspaceNow ||
      document.querySelectorAll("[data-project-runtime]").length > 1
    ) {
      void desktopApi.openProfileWindow(profile.id);
      return;
    }
    setProfileVeil({ stage: "in", target: profile });
  };

  /** Veil is fully opaque: swap everything beneath it, then fade it away. */
  const completingSwitchRef = useRef(false);
  const completeProfileSwitch = async (profile: Profile) => {
    if (completingSwitchRef.current) return;
    completingSwitchRef.current = true;
    try {
      await desktopApi.windowSetProfile(profile.id);
      // Unknown until the refetch lands — anything keyed on the agent
      // roster (the setup-tab auto-open, chat gating) must not act on the
      // OLD profile's roster while the NEW profile's project is active.
      setAgentsData(null);
      // The scoped sidebar effect owns configuration loading, including
      // project overrides. A second profile-only fetch could overwrite it.
      const [agents, nextPrefs] = await Promise.all([
        desktopApi.agentsList(),
        desktopApi.getPrefs(),
      ]);
      setAgentsData(agents);
      setPrefs(nextPrefs);
      setSidebarOpen(nextPrefs.sidebarOpen);
      setSavedRightSidebarOpen(nextPrefs.rightSidebarOpen);
      // Resolve the destination and its preferences together so the workspace
      // owner never claims a project using the previous profile's settings.
      setActiveProfileId(profile.id);
      setActiveProjectId(profile.defaultProjectId);
      window.dispatchEvent(new Event("catamorphic:profile-refetch"));
      setProfileVeil({ stage: "out" });
    } finally {
      completingSwitchRef.current = false;
    }
  };
  const completeProfileSwitchRef = useRef(completeProfileSwitch);
  completeProfileSwitchRef.current = completeProfileSwitch;

  // The veil sequence is driven by animationend AND a clock fallback: an
  // occluded window throttles animation events (Chromium background
  // throttling), and a stuck opaque veil would be the worst possible
  // failure mode. Whichever signal lands first wins; the completion guard
  // above keeps the switch single-flight.
  useEffect(() => {
    if (!profileVeil) return;
    const timer = window.setTimeout(() => {
      if (profileVeil.stage === "in" && profileVeil.target) {
        void completeProfileSwitchRef.current(profileVeil.target);
      } else if (profileVeil.stage === "out") {
        setProfileVeil(null);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [profileVeil]);

  // Titles feed tab labels and the palette.
  // This computer's chats follow its hints (ADR 0229); a remote server's
  // are polled.
  const { apiClient } = useCatamorphic();
  const remoteProject = useRemoteProject(projectId);
  const sessionsQuery = useAgentSessions(projectId, {
    limit: 100,
    refetchInterval: remoteProject ? 2_000 : LOCAL_CHATS_POLL_MS,
  });
  const projectAttention = runtime.attention;
  const sessionsById = new Map(
    [...(sessionsQuery.data?.items ?? []), ...(projectAttention ?? [])].map(
      (session) => [session.id, session],
    ),
  );
  const archiveSession = useArchiveAgentSession(projectId);
  const unarchiveSession = useUnarchiveAgentSession(projectId);
  const renameSession = useRenameAgentSession(projectId);
  /** The chat the rename dialog names, with the name it had (ADR 0247). */
  const [renameRequest, setRenameRequest] = useState<{
    sessionId: string;
    title: string;
  } | null>(null);
  /** The latest ask to rename: a slower read for an earlier one is dropped. */
  const renameAttemptRef = useRef(0);
  /**
   * Open the rename dialog for a chat, from any of its menus or the
   * palette, with the name it has (none for an untitled chat, which shows
   * only a date). A chat older than the loaded list is read for its name.
   */
  const openRename = async (sessionId: string) => {
    renameAttemptRef.current += 1;
    const attempt = renameAttemptRef.current;
    const session =
      sessionsById.get(sessionId) ??
      (projectId
        ? (
            await apiClient
              .GET("/api/projects/{projectId}/agent/sessions/{sessionId}", {
                params: { path: { projectId, sessionId } },
              })
              .catch(() => undefined)
          )?.data
        : undefined);
    if (attempt !== renameAttemptRef.current) return;
    setRenameRequest({ sessionId, title: session?.title ?? "" });
  };
  const createSubsession = useCreateAgentSession(projectId);
  const [subsessionParent, setSubsessionParent] = useState<AgentSession | null>(
    null,
  );
  const [subsessionError, setSubsessionError] = useState<string | null>(null);
  const [archiveRequest, setArchiveRequest] = useState<{
    session: AgentSession;
    sessionIds: string[];
    terminalSessionIds: string[];
    processCount: number;
    runningCount: number;
    watcherCount: number;
    watchers: Array<{
      id: string;
      name: string;
      environment: string | null;
      nextRunAt: string | null;
    }>;
  } | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const descendantIds = (rootId: string): string[] => {
    const found = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const session of sessionsById.values()) {
        if (
          session.parentSessionId &&
          found.has(session.parentSessionId) &&
          !found.has(session.id)
        ) {
          found.add(session.id);
          changed = true;
        }
      }
    }
    return [...found];
  };

  const terminalSessionsFor = (sessionIds: readonly string[]): string[] => {
    const ids = new Set(sessionIds);
    const chatIds = new Set(
      workspace.chats
        .filter((chat) => chat.sessionId && ids.has(chat.sessionId))
        .map((chat) => chat.localId),
    );
    return [
      ...new Set(
        workspace.terminals
          // A terminal whose command ended has no process left to stop.
          .filter(
            (terminal) =>
              terminal.running !== false &&
              (terminal.chatLocalId
                ? chatIds.has(terminal.chatLocalId)
                : false),
          )
          .flatMap((terminal) =>
            terminal.ptySessionId ? [terminal.ptySessionId] : [],
          ),
      ),
    ];
  };

  const removeArchivedWorkspace = (sessionIds: readonly string[]) => {
    const ids = new Set(sessionIds);
    updateWorkspace((current) => {
      const removedChats = new Set(
        current.chats
          .filter((chat) => chat.sessionId && ids.has(chat.sessionId))
          .map((chat) => chat.localId),
      );
      const chats = current.chats.filter(
        (chat) => !removedChats.has(chat.localId),
      );
      const browsers = current.browsers.filter(
        (browser) =>
          !browser.chatLocalId || !removedChats.has(browser.chatLocalId),
      );
      const terminals = current.terminals.filter(
        (terminal) =>
          !terminal.chatLocalId || !removedChats.has(terminal.chatLocalId),
      );
      const editors = current.editors.filter(
        (editor) =>
          !editor.chatLocalId || !removedChats.has(editor.chatLocalId),
      );
      const candidate = { ...current, chats, browsers, terminals, editors };
      return {
        ...candidate,
        activeChatId: chats.some(
          (chat) => chat.localId === current.activeChatId,
        )
          ? current.activeChatId
          : chats.at(-1)?.localId,
        activeTabKey: orderedTabKeys(candidate).includes(
          current.activeTabKey ?? "",
        )
          ? current.activeTabKey
          : orderedTabKeys(candidate).at(-1),
      };
    });
  };

  const finishArchive = async (request: NonNullable<typeof archiveRequest>) => {
    setArchiveError(null);
    try {
      await Promise.all(
        request.terminalSessionIds.map((sessionId) =>
          desktopApi.terminalKill(sessionId),
        ),
      );
      const result = await archiveSession.mutateAsync({
        sessionId: request.session.id,
        confirmStop: true,
      });
      removeArchivedWorkspace(result.impact.sessionIds);
      setArchiveRequest(null);
    } catch (cause) {
      setArchiveError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const beginArchive = async (session: AgentSession) => {
    const sessionIds = descendantIds(session.id);
    const terminalSessionIds = terminalSessionsFor(sessionIds);
    try {
      const preview = await apiClient.GET(
        "/api/projects/{projectId}/agent/sessions/{sessionId}/archive-impact",
        {
          params: {
            path: { projectId: projectId ?? "", sessionId: session.id },
          },
        },
      );
      if (preview.error || !preview.data)
        throw new Error(
          preview.error?.error ?? "Could not check archive impact",
        );
      const impact = preview.data;
      if (terminalSessionIds.length > 0 || impact.requiresConfirmation) {
        setArchiveError(null);
        setArchiveRequest({
          session,
          sessionIds: impact.sessionIds,
          terminalSessionIds,
          processCount: Math.max(
            terminalSessionIds.length,
            impact.activeProcessCount,
          ),
          runningCount: impact.runningSessionIds.length,
          watcherCount: impact.activeWatcherCount,
          watchers: impact.watchers,
        });
        return;
      }
      const result = await archiveSession.mutateAsync({
        sessionId: session.id,
      });
      removeArchivedWorkspace(result.impact.sessionIds);
    } catch (cause) {
      const details =
        cause && typeof cause === "object" && "details" in cause
          ? (cause.details as {
              impact?: {
                sessionIds?: string[];
                runningSessionIds?: string[];
                watchers?: Array<{
                  id: string;
                  name: string;
                  environment: string | null;
                  nextRunAt: string | null;
                }>;
                activeWatcherCount?: number;
                activeProcessCount?: number;
              };
            })
          : undefined;
      if (details?.impact) {
        setArchiveError(null);
        setArchiveRequest({
          session,
          sessionIds: details.impact.sessionIds ?? sessionIds,
          terminalSessionIds,
          processCount: details.impact.activeProcessCount ?? 0,
          runningCount: details.impact.runningSessionIds?.length ?? 0,
          watcherCount: details.impact.activeWatcherCount ?? 0,
          watchers: details.impact.watchers ?? [],
        });
        return;
      }
      setArchiveError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const applySessionAction = (sessionId: string, action: ChatSessionAction) => {
    const session = sessionsById.get(sessionId);
    switch (action) {
      case "rename":
        void openRename(sessionId);
        break;
      case "new-subsession":
        if (session) {
          setSubsessionError(null);
          setSubsessionParent(session);
        }
        break;
      case "mark-read":
        setSessionListPreference("unreadSessionIds", [sessionId], false);
        break;
      case "mark-unread":
        setSessionListPreference("unreadSessionIds", [sessionId], true);
        break;
      case "archive":
        if (session) void beginArchive(session);
        break;
      case "unarchive":
        void unarchiveSession.mutateAsync(sessionId);
        break;
      case "open-terminal":
        openChatTerminal(sessionId);
        break;
      case "open-preview":
        askChatPreview(sessionId);
        break;
    }
  };

  /**
   * A remote chat's workspace is open to the person beside its agent (ADR
   * 0209); an incognito chat stays on this computer.
   */
  const remoteChatSession = (sessionId: string | undefined): boolean =>
    remoteSurfaceStatus !== null &&
    sessionId !== undefined &&
    !workspace.chats.some(
      (chat) => chat.sessionId === sessionId && chat.incognito,
    );

  /** A terminal in a remote chat's workspace, named for the chat. */
  const openChatTerminal = (sessionId: string) => {
    if (!remoteChatSession(sessionId)) return;
    const session = sessionsById.get(sessionId);
    openTerminalTab({
      remoteSessionId: sessionId,
      title: `Terminal · ${session ? sessionLabel(session) : "Chat"}`,
    });
  };

  /** Ask for the port of a server in a remote chat's workspace. */
  const askChatPreview = (sessionId: string) => {
    if (!remoteChatSession(sessionId)) return;
    const session = sessionsById.get(sessionId);
    previewAttemptRef.current += 1;
    setPreviewPending(false);
    setPreviewError(null);
    setPreviewRequest({
      sessionId,
      chatTitle: session ? sessionLabel(session) : "this chat",
      lastPort: lastPreviewPort(sessionId),
    });
  };

  /** Cancelled: an open still travelling is ignored when it answers. */
  const closeChatPreview = () => {
    previewAttemptRef.current += 1;
    setPreviewRequest(null);
    setPreviewPending(false);
    setPreviewError(null);
  };

  const openChatPreview = async (sessionId: string, port: number) => {
    if (!projectId) return;
    previewAttemptRef.current += 1;
    const attempt = previewAttemptRef.current;
    const current = () => attempt === previewAttemptRef.current;
    setPreviewPending(true);
    setPreviewError(null);
    try {
      const { url } = await desktopApi.remotePreviewOpen({
        projectId,
        sessionId,
        port,
      });
      if (!current()) return;
      rememberPreviewPort(sessionId, port);
      setPreviewRequest(null);
      openBrowserTab(url, { title: `Preview · ${port}` });
    } catch (cause) {
      if (current()) setPreviewError(ipcErrorText(cause));
    } finally {
      if (current()) setPreviewPending(false);
    }
  };

  // Stable per-project default so pre-first-write renders and the first
  // state update agree on the initial chat's localId.
  const defaultWorkspacesRef = useRef(new Map<string, Workspace>());
  const defaultWorkspaceFor = useCallback((id: string): Workspace => {
    const cache = defaultWorkspacesRef.current;
    const cached = cache.get(id);
    if (cached) return cached;
    const created = emptyWorkspace();
    cache.set(id, created);
    return created;
  }, []);

  const utilityWorkspaceKey = activeProfile
    ? `profile:${activeProfile.id}:utility`
    : null;
  const workspaceKey = projectId ?? utilityWorkspaceKey;
  const workspace: Workspace = projectId
    ? (workspaces[projectId] ?? defaultWorkspaceFor(projectId))
    : utilityWorkspaceKey
      ? (workspaces[utilityWorkspaceKey] ?? emptyUtilityWorkspace())
      : emptyUtilityWorkspace();
  const archivedSessionIds = new Set(
    [...sessionsById.values()]
      .filter((session) => session.visibility === "archived")
      .map((session) => session.id),
  );
  const unreadSessionIds = new Set(prefs?.unreadSessionIds ?? []);
  const unreadByChat: Record<string, boolean> = Object.fromEntries(
    workspace.chats.map((chat) => [
      chat.localId,
      Boolean(chat.sessionId && unreadSessionIds.has(chat.sessionId)),
    ]),
  );
  const attentionByChat: Record<string, boolean> = Object.fromEntries(
    workspace.chats.map((chat) => [
      chat.localId,
      Boolean(
        chat.sessionId && sessionsById.get(chat.sessionId)?.attentionRequired,
      ),
    ]),
  );
  const chatMenus: Record<string, ChatSessionMenuEntry[]> = Object.fromEntries(
    workspace.chats.flatMap((chat) =>
      chat.sessionId
        ? [
            [
              chat.localId,
              chatSessionMenu({
                unread: unreadSessionIds.has(chat.sessionId),
                archived: archivedSessionIds.has(chat.sessionId),
                remote: remoteChatSession(chat.sessionId),
              }),
            ],
          ]
        : [],
    ),
  );

  const updateWorkspace = useCallback(
    (updater: (workspace: Workspace) => Workspace) => {
      if (!workspaceKey) return;
      setWorkspaces((current) => {
        const previous =
          current[workspaceKey] ??
          (projectId
            ? defaultWorkspaceFor(projectId)
            : emptyUtilityWorkspace());
        const updated = updater(previous);
        const next = reconcileWorkspace(previous, updated);
        // Background reconciliation must not materialize a default workspace
        // before the persisted snapshot has had a chance to restore.
        return next === previous
          ? current
          : { ...current, [workspaceKey]: next };
      });
    },
    [projectId, workspaceKey, defaultWorkspaceFor],
  );

  /**
   * A terminal's news (a command started or ended in it) reaches its tab
   * in whichever project's workspace holds it, open on screen or not.
   */
  const updateTerminals = useCallback(
    (event: TerminalEvent) =>
      setWorkspaces((current) => {
        const next = Object.entries(current).map(
          ([id, ws]) => [id, transitionWorkspace(ws, event)] as const,
        );
        return next.every(([id, ws]) => ws === current[id])
          ? current
          : Object.fromEntries(next);
      }),
    [],
  );

  const floatingMotion = useFloatingMotion(
    workspace.floatingKey ? `${projectId}:${workspace.floatingKey}` : undefined,
  );
  const recedingSurface = useRecedingSurface({
    identity: projectId,
    activeTabKey: workspace.activeTabKey,
    chats: workspace.chats,
  });
  // Ref'd for the agent-bridge handler (a mount-time effect closure).
  const floatingMotionRef = useRef(floatingMotion);
  floatingMotionRef.current = floatingMotion;
  const dismissFloating = () => {
    const key = workspace.floatingKey;
    floatingMotion.dismiss(() =>
      updateWorkspace((ws) =>
        transitionWorkspace(ws, { type: "dismiss-floating", key }),
      ),
    );
  };
  const floatingEscapeEnabledRef = useRef(false);
  floatingEscapeEnabledRef.current = Boolean(
    workspace.floatingKey &&
      !paletteOpen &&
      !wizardModalOpen &&
      !connectorsModalOpen,
  );
  const focusedTabKey = workspace.floatingKey ?? workspace.activeTabKey;

  // --- workspace persistence --------------------------------------------
  // Each project's open workspace survives a relaunch. Restore runs once
  // per project (only filling a slot the user hasn't touched yet); saves
  // are debounced and gated until that restore attempt settles, so the
  // boot-time empty workspace can never clobber the saved one.
  const workspaceRestoreRef = useRef(new Set<string>());
  const [workspaceReadyProjectIds, setWorkspaceReadyProjectIds] = useState(
    new Set<string>(),
  );
  const workspaceReady = Boolean(
    projectId && workspaceReadyProjectIds.has(projectId),
  );
  useEffect(() => {
    if (!projectId || workspaceRestoreRef.current.has(projectId)) return;
    workspaceRestoreRef.current.add(projectId);
    // A project that moved here from another window opens as it was left
    // there; otherwise as it was saved.
    void desktopApi
      .workspaceHandoffTake(projectId)
      .then(async (handed) =>
        handed
          ? hydrateWorkspace(handed, { moved: true })
          : hydrateWorkspace(await desktopApi.workspaceStateGet(projectId)),
      )
      .then((restored) => {
        if (restored) {
          setWorkspaces((current) =>
            current[projectId]
              ? current
              : { ...current, [projectId]: restored },
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        setWorkspaceReadyProjectIds(
          (current) => new Set([...current, projectId]),
        );
      });
  }, [projectId]);
  // Agent calls held while the project moved here go on from now.
  useEffect(() => {
    if (projectId && workspaceReady) void desktopApi.workspaceReady(projectId);
  }, [projectId, workspaceReady]);
  useEffect(() => {
    if (!projectId || !workspaceReady) return;
    const snapshot = workspaces[projectId];
    if (!snapshot) return;
    const timer = window.setTimeout(() => {
      void desktopApi
        .workspaceStateSet(projectId, serializeWorkspace(snapshot))
        .catch(() => {});
    }, 500);
    return () => window.clearTimeout(timer);
  }, [workspaces, projectId, workspaceReady]);
  // Moving to a window of its own (lib/project-move.ts), the project's
  // workspace goes to the main process as it is, its shells and unsent
  // chats with it, for the new window to open as it was left here; what a
  // restart opens is saved as ever.
  const movingWorkspace = useRef<{
    projectId: string | undefined;
    workspace: Workspace | undefined;
  }>({ projectId: undefined, workspace: undefined });
  movingWorkspace.current = {
    projectId,
    workspace: projectId && workspaceReady ? workspaces[projectId] : undefined,
  };
  useEffect(
    () => () => {
      const { projectId: leaving, workspace: left } = movingWorkspace.current;
      if (!leaving || !left || !isMoving(leaving)) return;
      void desktopApi.workspaceHandoffPut(
        leaving,
        serializeWorkspace(left, { moving: true }),
      );
      void desktopApi
        .workspaceStateSet(leaving, serializeWorkspace(left))
        .catch(() => {});
    },
    [],
  );
  useUnsavedFilesForMove(projectId, () =>
    (projectId ? (workspaces[projectId]?.editors ?? []) : [])
      .filter((editor) => editor.dirty && editor.filePath)
      .map((editor) => editor.filePath?.split("/").pop() ?? ""),
  );

  // A workflow-created session is a notification surface in its own right.
  // Once its turn settles, materialize it as a minimized dock bubble without
  // stealing focus. One bubble is created per attention revision; closing it
  // does not hide the matching pulsing row in the sidebar.
  const surfacedAttentionRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (!projectId || !workspaceReady) return;
    const attentionSessions = (projectAttention ?? []).filter(
      (session) => session.attentionRequired,
    );
    if (attentionSessions.length === 0) return;
    updateWorkspace((ws) => {
      const additions: ChatDockEntry[] = [];
      for (const session of attentionSessions) {
        const key = `${projectId}:${session.id}`;
        const surfaced = surfacedAttentionRef.current.get(key) ?? 0;
        if (ws.chats.some((chat) => chat.sessionId === session.id)) {
          surfacedAttentionRef.current.set(key, session.attentionRevision);
          continue;
        }
        if (surfaced >= session.attentionRevision) continue;
        surfacedAttentionRef.current.set(key, session.attentionRevision);
        additions.push({
          ...newChatEntry("min"),
          sessionId: session.id,
        });
      }
      return additions.length > 0
        ? { ...ws, chats: [...ws.chats, ...additions] }
        : ws;
    });
  }, [projectId, projectAttention, updateWorkspace, workspaceReady]);

  const openTab = (tab: WorkspaceTab, mode?: CommitMode) => {
    // Settings navigation must reveal its control, including keyboard commits
    // from a palette opened over a floating conversation.
    if (tab.kind === "settings") minimizeFloatingChats();
    return updateWorkspace((ws) => {
      const key = tabKey(tab);
      const exists = ws.tabs.some((existing) => tabKey(existing) === key);
      const split =
        mode === "side" && ws.activeTabKey && ws.activeTabKey !== key
          ? { leftKey: ws.activeTabKey, rightKey: key, ratio: 0.5 }
          : null;
      return {
        ...ws,
        tabs: exists
          ? ws.tabs.map((existing) =>
              (tab.kind === "diff" || tab.kind === "settings") &&
              tabKey(existing) === key
                ? { ...existing, ...tab }
                : existing,
            )
          : [...ws.tabs, tab],
        activeTabKey:
          mode === "floating"
            ? ws.activeTabKey === key
              ? orderedTabKeys(ws).find((candidate) => candidate !== key)
              : ws.activeTabKey
            : key,
        floatingKey: mode === "floating" ? key : undefined,
        split,
      };
    });
  };
  /** The Passwords page of a profile (the window's own by default). */
  const openPasswords = (profileId?: string) => {
    const target =
      profileId ?? activeProfile?.id ?? profilesData?.defaultProfileId;
    if (target)
      openTab({ kind: "passwords", name: target, label: "Passwords" });
  };

  // Chrome's New Tab analog: a fresh tab whose content is the palette.
  const openPaletteTab = () =>
    openTab({ kind: "palette", name: crypto.randomUUID(), label: "New Tab" });
  // Untyped, a New Tab closes once something else is shown in its place
  // (reconcileWorkspace); typing into it keeps it.
  const markNewTabTyped = (key: string, typed: boolean) =>
    updateWorkspace((ws) =>
      ws.tabs.some(
        (tab) =>
          tab.kind === "palette" &&
          tabKey(tab) === key &&
          Boolean(tab.typed) !== typed,
      )
        ? {
            ...ws,
            tabs: ws.tabs.map((tab) =>
              tab.kind === "palette" && tabKey(tab) === key
                ? { ...tab, typed }
                : tab,
            ),
          }
        : ws,
    );

  /** Tab bar entries: fixed tabs plus one derived tab per tab-mode chat. */
  const chatTabs = (
    ws: Workspace,
    chatLabels: Record<string, string>,
    icons: Record<string, string | null>,
    forks: Record<string, boolean>,
  ) =>
    ws.chats
      .filter((chat) => chat.mode === "tab")
      .map(
        (chat): WorkspaceTab => ({
          kind: "chat",
          name: chat.localId,
          label: chatLabels[chat.localId] ?? "Chat",
          bookmarkUrl:
            projectId && chat.sessionId
              ? chatBookmarkUrl({ projectId, sessionId: chat.sessionId })
              : undefined,
          chatIcon: icons[chat.localId] ?? null,
          fork: forks[chat.localId] ?? false,
          // Incognito chats stay out of what lists remember (ADR 0062).
          sessionId: chat.incognito ? undefined : chat.sessionId,
          // Hover card: which agent runs this conversation (+ lineage).
          detail:
            [
              agentsData?.agents.find(
                (agent) =>
                  agent.id ===
                  rosterAgentId(
                    sessionsById.get(chat.sessionId ?? "")?.agentId ??
                      chat.agentId ??
                      agentsData?.defaultAgentId ??
                      "",
                  ),
              )?.name,
              forks[chat.localId] ? "fork of another chat" : undefined,
            ]
              .filter(Boolean)
              .join(" · ") || undefined,
          // Same signals as the chat's bubble: spinner while the agent
          // works, dot for a reply that landed while the tab was hidden,
          // pencil for an unsent draft, "?" for a waiting question.
          working: signalsByChat[chat.localId]?.working ?? false,
          unread: unreadByChat[chat.localId] ?? false,
          attention: attentionByChat[chat.localId] ?? false,
          draft: signalsByChat[chat.localId]?.draft ?? false,
          awaitingInput: signalsByChat[chat.localId]?.awaitingInput ?? false,
        }),
      );

  const browserTabs = (ws: Workspace) =>
    tabbedBrowsers(ws).map(
      (browser): WorkspaceTab => ({
        kind: "browser",
        name: browser.localId,
        label: browser.title || "New Tab",
        faviconUrl: browser.faviconUrl,
        asleep: tabSleep.asleep(browser.localId),
        // Hover card: the page's address under its full title.
        detail: browser.url || browser.initialUrl || undefined,
        bookmarkUrl: browser.url || browser.initialUrl || undefined,
      }),
    );

  const terminalTabs = (ws: Workspace) =>
    tabbedTerminals(ws).map(
      (terminal): WorkspaceTab => ({
        kind: "terminal",
        name: terminal.localId,
        label: terminal.title || "Terminal",
      }),
    );

  const editorTabs = (ws: Workspace) =>
    tabbedEditors(ws).map(
      (editor): WorkspaceTab => ({
        kind: "editor",
        name: editor.localId,
        label: editor.filePath?.split("/").at(-1) || "Editor",
        // Unsaved changes are a draft — same pencil badge as chat drafts.
        draft: editor.dirty,
        // Hover card: the project-relative path.
        detail: editor.filePath ?? undefined,
      }),
    );

  const selectTab = (key: string) =>
    updateWorkspace((ws) => transitionWorkspace(ws, { type: "select", key }));

  /** Open a page in a new browser tab (profile session of the workspace). */
  const openBrowserTab = useCallback(
    (
      url: string,
      opts?: {
        background?: boolean;
        chatLocalId?: string;
        side?: boolean;
        title?: string;
        floating?: boolean;
      },
    ) => {
      if (!activeProfile) return null;
      const entry: BrowserEntry = {
        localId: crypto.randomUUID(),
        profileId: activeProfile.id,
        initialUrl: url,
        url,
        title: opts?.title ?? (url || "New Tab"),
        faviconUrl: null,
        chatLocalId: opts?.chatLocalId,
      };
      updateWorkspace((ws) => {
        const key = browserTabKey(entry.localId);
        // Side: tile the new page to the right of the current view.
        const split =
          opts?.side && ws.activeTabKey
            ? { leftKey: ws.activeTabKey, rightKey: key, ratio: 0.5 }
            : opts?.background
              ? ws.split
              : null;
        return {
          ...ws,
          browsers: [...ws.browsers, entry],
          chats: opts?.floating
            ? ws.chats.map((chat) =>
                chat.mode === "partial" ? { ...chat, mode: "min" } : chat,
              )
            : ws.chats,
          activeTabKey:
            opts?.background || opts?.floating ? ws.activeTabKey : key,
          floatingKey: opts?.floating
            ? key
            : opts?.background
              ? ws.floatingKey
              : undefined,
          split,
        };
      });
      return entry.localId;
    },
    [activeProfile, updateWorkspace],
  );

  /**
   * A page already open in a tab opens there (`switchToOpenTab`): a link,
   * a bookmark or a link from another app goes to that tab instead of
   * opening the page twice. Callers asked for a new tab on purpose never
   * ask. A page an agent is driving, and a chip kept off the strip, do
   * not count. Returns the tab's key, or null to open the page as usual.
   */
  const switchToOpenPage = (url: string): string | null => {
    if (prefsRef.current?.switchToOpenTab === false) return null;
    if (!/^https?:/i.test(url)) return null;
    const ws = workspaceRef.current;
    const focused = ws.floatingKey ?? ws.activeTabKey;
    const open = ws.browsers.filter(
      (browser) =>
        !browser.agentControlled &&
        !browser.background &&
        samePage(browser.url || browser.initialUrl, url),
    );
    const target =
      open.find((browser) => browserTabKey(browser.localId) === focused) ??
      open[0];
    if (!target) return null;
    const key = browserTabKey(target.localId);
    if (key !== ws.floatingKey)
      updateWorkspace((current) =>
        transitionWorkspace(current, { type: "select", key }),
      );
    return key;
  };
  const switchToOpenPageRef = useRef(switchToOpenPage);
  switchToOpenPageRef.current = switchToOpenPage;

  /** Open a terminal tab; the shell starts in the project folder. */
  const openTerminalTab = (opts?: {
    chatLocalId?: string;
    side?: boolean;
    floatingTool?: "terminal";
    macroId?: string;
    floating?: boolean;
    initialCommand?: string;
    title?: string;
    /** A shell in this remote chat's workspace (ADR 0209). */
    remoteSessionId?: string;
  }) => {
    const floating = opts?.floating ?? Boolean(opts?.floatingTool);
    const entry: TerminalEntry = {
      localId: crypto.randomUUID(),
      title: opts?.title ?? "",
      chatLocalId: opts?.chatLocalId,
      floatingTool: opts?.floatingTool,
      macroId: opts?.macroId,
      initialCommand: opts?.initialCommand,
      ...(opts?.remoteSessionId
        ? { remoteSessionId: opts.remoteSessionId }
        : {}),
    };
    updateWorkspace((ws) => {
      const key = terminalTabKey(entry.localId);
      return {
        ...ws,
        terminals: [...ws.terminals, entry],
        chats: floating
          ? ws.chats.map((chat) =>
              chat.mode === "partial" ? { ...chat, mode: "min" } : chat,
            )
          : ws.chats,
        activeTabKey: floating ? ws.activeTabKey : key,
        floatingKey: floating ? key : undefined,
        split:
          opts?.side && ws.activeTabKey
            ? { leftKey: ws.activeTabKey, rightKey: key, ratio: 0.5 }
            : null,
      };
    });
  };

  /** Open an editor tab; without a file it greets with the quick-open. */
  const openEditorTab = (opts?: {
    filePath?: string;
    chatLocalId?: string;
    side?: boolean;
    floating?: boolean;
  }) => {
    const entry: EditorEntry = {
      localId: crypto.randomUUID(),
      filePath: opts?.filePath ?? null,
      dirty: false,
      chatLocalId: opts?.chatLocalId,
    };
    updateWorkspace((ws) => {
      const key = editorTabKey(entry.localId);
      return {
        ...ws,
        editors: [...ws.editors, entry],
        activeTabKey: opts?.floating ? ws.activeTabKey : key,
        floatingKey: opts?.floating ? key : undefined,
        split:
          opts?.side && ws.activeTabKey
            ? { leftKey: ws.activeTabKey, rightKey: key, ratio: 0.5 }
            : null,
      };
    });
  };

  const [linkError, setLinkError] = useState<string | null>(null);
  /** One resolver for clicked links, file chips, sidebar files, and agent tools. */
  const openLinkedSurface = async (
    value: string,
    opts: {
      chatLocalId?: string;
      label?: string;
      side?: boolean;
      background?: boolean;
      newTab?: boolean;
      mode?: CommitMode;
      /** The person clicked it: a page already open goes to its tab. */
      clicked?: boolean;
    } = {},
  ): Promise<string> => {
    const intent =
      opts.mode ?? (opts.side ? "side" : opts.newTab ? "tab" : "replace");
    // A chat in any project, such as the assistant's (ADR 0216).
    if (parseChatBookmarkUrl(value)) {
      await openUrl(value, intent === "replace" ? "tab" : intent);
      return value;
    }
    if (value.startsWith("session:") && projectIdRef.current) {
      await openUrl(
        chatBookmarkUrl({
          projectId: projectIdRef.current,
          sessionId: decodeURIComponent(value.slice(8)),
        }),
        intent === "replace" ? "tab" : intent,
      );
      return value;
    }
    const target = parseSurfaceLink(value);
    if (!target)
      throw new Error("This link is not a supported workspace target");
    const originProject = projectIdRef.current;
    const root =
      target.kind === "file" && originProject
        ? await desktopApi.projectRoot(originProject)
        : null;
    if (projectIdRef.current !== originProject)
      throw new Error(
        "The project changed. Open this link from its original chat.",
      );
    if (target.kind === "workflow") {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.project({ projectId: originProject }),
      });
    }
    const localId = crypto.randomUUID();
    const location =
      target.kind === "file"
        ? resolveProjectFileLocation(root ?? "", target.path)
        : null;
    const browserUrl =
      target.kind === "browser"
        ? target.url
        : target.kind === "file" && location && isBrowserFile(target.path)
          ? localFileUrl(location.absolutePath)
          : null;
    if (browserUrl && !activeProfileRef.current)
      throw new Error("Choose a profile before opening this link");
    const focusedKey =
      workspaceRef.current.floatingKey ?? workspaceRef.current.activeTabKey;
    const openTab =
      browserUrl && opts.clicked && intent === "replace" && !opts.background
        ? switchToOpenPage(browserUrl)
        : null;
    if (openTab) return openTab;
    if (
      browserUrl &&
      intent === "replace" &&
      !opts.background &&
      focusedKey?.startsWith("browser:")
    ) {
      const navigate = browserNavigatorsRef.current.get(focusedKey.slice(8));
      if (navigate) {
        navigate(browserUrl);
        return focusedKey;
      }
    }
    const existingEditor =
      target.kind === "file" && !browserUrl && intent !== "tab"
        ? (workspaceRef.current.editors.find(
            (editor) => editor.filePath === location?.relativePath,
          ) ??
          (intent === "replace" && !opts.background
            ? workspaceRef.current.editors.find(
                (editor) =>
                  editorTabKey(editor.localId) === focusedKey && !editor.dirty,
              )
            : undefined))
        : undefined;
    const key = browserUrl
      ? browserTabKey(localId)
      : target.kind === "file"
        ? editorTabKey(existingEditor?.localId ?? localId)
        : target.kind === "tab"
          ? target.key
          : target.kind === "workflow" ||
              target.kind === "app" ||
              target.kind === "artifact" ||
              target.kind === "run"
            ? `${target.kind}:${target.name}`
            : browserTabKey(localId);
    if (
      target.kind === "tab" &&
      !orderedTabKeys(workspaceRef.current, {
        includeCollapsed: true,
      }).includes(key) &&
      !workspaceRef.current.chats.some(
        (chat) => chatTabKey(chat.localId) === key,
      )
    )
      throw new Error("This tab is no longer open");
    updateWorkspace((ws) => ({
      ...ws,
      ...(browserUrl
        ? {
            browsers: [
              ...ws.browsers,
              {
                localId,
                profileId: activeProfileRef.current?.id ?? "",
                initialUrl: browserUrl,
                url: browserUrl,
                title:
                  target.kind === "file"
                    ? fileNameFromPath(target.path)
                    : browserUrl,
                faviconUrl: null,
                chatLocalId: opts.chatLocalId,
              },
            ],
          }
        : target.kind === "file" && location
          ? {
              editors: existingEditor
                ? ws.editors.map((editor) =>
                    editor.localId === existingEditor.localId
                      ? {
                          ...editor,
                          filePath: location.relativePath,
                          background: false,
                          line: target.line,
                          column: target.column,
                          navigation: localId,
                        }
                      : editor,
                  )
                : [
                    ...ws.editors,
                    {
                      localId,
                      filePath: location.relativePath,
                      dirty: false,
                      chatLocalId: opts.chatLocalId,
                      line: target.line,
                      column: target.column,
                      navigation: localId,
                    },
                  ],
            }
          : target.kind === "workflow" ||
              target.kind === "app" ||
              target.kind === "artifact" ||
              target.kind === "run"
            ? {
                tabs: ws.tabs.some((tab) => tabKey(tab) === key)
                  ? ws.tabs
                  : [
                      ...ws.tabs,
                      {
                        kind: target.kind,
                        name: target.name,
                        label:
                          opts.label ??
                          (target.kind === "run"
                            ? "Workflow run"
                            : target.kind === "artifact"
                              ? "Session artifact"
                              : target.kind === "app" &&
                                  target.name.startsWith("session-")
                                ? "Session app"
                                : undefined),
                        chatLocalId: opts.chatLocalId,
                      },
                    ],
              }
            : {}),
    }));
    // Materialize first, then use the same placement rules as sidebar rows and
    // chips. Reusing the focused editor keeps its floating/split frame.
    if (!opts.background && !(intent === "replace" && key === focusedKey))
      openSurface(key, intent);
    return key;
  };
  const openHistory = async (entry: HistoryEntry, mode: CommitMode) => {
    const { target } = entry;
    if (target.kind === "web") {
      await openUrl(target.url, mode);
      return;
    }
    if (target.kind === "local") {
      // A file outside any project reopens as it opened: a browser tab
      // showing what Work can show (ADR 0153).
      openBrowserTab(localFileUrl(target.path), {
        title: entry.title,
        side: mode === "side",
        floating: mode === "floating",
      });
      return;
    }
    const ownerId = target.projectId;
    if (!projects.some((project) => project.id === ownerId))
      throw new Error("This project's history is no longer available.");
    if (ownerId === projectId) {
      await openLinkedSurface(historyDestination(target), {
        mode,
        label: entry.title,
      });
      return;
    }
    await desktopApi.workspaceNavigate({
      projectId: ownerId,
      surface: {
        url: historyDestination(target),
        title: entry.title,
        mode,
        nonce: crypto.randomUUID(),
      },
    });
  };
  const historySearch = () => {
    setModeRequest({ mode: "history", nonce: crypto.randomUUID() });
    setPaletteOpen(true);
  };
  const settingsSearch = () => {
    setModeRequest({ mode: "settings", nonce: crypto.randomUUID() });
    setPaletteOpen(true);
  };

  const openLinkedSurfaceRef = useRef(openLinkedSurface);
  openLinkedSurfaceRef.current = openLinkedSurface;
  /** A saved download opens as a browser tab; Work shows what it can. */
  const openDownload = (record: DownloadRecord, mode: CommitMode) => {
    openBrowserTab(fileUrlFor(record.savePath), {
      title: record.filename,
      side: mode === "side",
      floating: mode === "floating",
    });
  };
  const openDownloadRef = useRef(openDownload);
  openDownloadRef.current = openDownload;
  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;
  const consumeSurface = (
    navigation: NonNullable<WorkspaceNavigation["surface"]>,
  ) => {
    if (navigation.open === "page") {
      if (navigation.url === "downloads")
        openTabRef.current(
          { kind: "downloads", name: "downloads", label: "Downloads" },
          navigation.mode,
        );
      else if (navigation.url === "history")
        openTabRef.current(
          { kind: "history", name: "history", label: "History" },
          navigation.mode,
        );
      else if (navigation.url === "new-assistant") createAssistantRef.current();
      return;
    }
    if (navigation.open === "browser") {
      if (
        (navigation.mode ?? "replace") === "replace" &&
        switchToOpenPage(navigation.url)
      )
        return;
      openBrowserTab(navigation.url, {
        title: navigation.title,
        side: navigation.mode === "side",
        floating: navigation.mode === "floating",
      });
      return;
    }
    void openLinkedSurfaceRef
      .current(navigation.url, {
        mode: navigation.mode,
        label: navigation.title,
      })
      .catch((cause: unknown) =>
        setLinkError(
          cause instanceof Error
            ? cause.message
            : "Could not reopen this item.",
        ),
      );
  };
  const createAssistantRef = useRef(createAssistant);
  createAssistantRef.current = createAssistant;
  const consumeSurfaceRef = useRef(consumeSurface);
  consumeSurfaceRef.current = consumeSurface;
  const consumedNavigation = useRef<string | undefined>(undefined);
  useEffect(() => {
    const navigation = runtime.navigation;
    if (
      !navigation ||
      !workspaceReady ||
      !runtime.visible ||
      consumedNavigation.current === navigation.nonce
    )
      return;
    consumedNavigation.current = navigation.nonce;
    consumeSurfaceRef.current(navigation);
  }, [runtime.navigation, runtime.visible, workspaceReady]);
  // The dock in this window asks directly (no project needed).
  useEffect(() => {
    if (!runtime.visible) return;
    const onNavigate = (event: Event) => {
      const surface = (
        event as CustomEvent<NonNullable<WorkspaceNavigation["surface"]>>
      ).detail;
      if (surface) consumeSurfaceRef.current(surface);
    };
    window.addEventListener("catamorphic:dock-navigate", onNavigate);
    return () =>
      window.removeEventListener("catamorphic:dock-navigate", onNavigate);
  }, [runtime.visible]);

  const openMessageLink = (
    value: string,
    entry: ChatDockEntry,
    modifiers: OpenModifiers | CommitMode,
  ) => {
    void openLinkedSurface(value, {
      chatLocalId: entry.localId,
      clicked: true,
      mode:
        typeof modifiers === "string"
          ? modifiers
          : openModeFromEvent(modifiers),
    }).catch((cause: unknown) =>
      setLinkError(
        cause instanceof Error ? cause.message : "Could not open this link",
      ),
    );
  };

  const onTerminalTitle = useCallback(
    (localId: string, title: string) =>
      updateWorkspace((ws) => {
        const target = ws.terminals.find(
          (terminal) => terminal.localId === localId,
        );
        // Shells re-announce the same title on every prompt — skip those.
        // A remote chat's terminal keeps the chat's name.
        if (
          !target ||
          target.macroId ||
          target.remoteSessionId ||
          target.title === title
        )
          return ws;
        return {
          ...ws,
          terminals: ws.terminals.map((terminal) =>
            terminal.localId === localId ? { ...terminal, title } : terminal,
          ),
        };
      }),
    [updateWorkspace],
  );

  const onEditorState = useCallback(
    (localId: string, patch: Partial<Omit<EditorEntry, "localId">>) =>
      updateWorkspace((ws) => ({
        ...ws,
        editors: ws.editors.map((editor) =>
          editor.localId === localId ? { ...editor, ...patch } : editor,
        ),
      })),
    [updateWorkspace],
  );

  const onBrowserState = useCallback(
    (localId: string, state: BrowserPageState) =>
      updateWorkspace((ws) => ({
        ...ws,
        browsers: ws.browsers.map((browser) =>
          browser.localId === localId
            ? {
                ...browser,
                url: state.url || browser.url,
                title: state.title || browser.title,
                faviconUrl: state.faviconUrl ?? browser.faviconUrl,
                ...(state.history !== undefined
                  ? { history: state.history ?? undefined }
                  : {}),
              }
            : browser,
        ),
      })),
    [updateWorkspace],
  );

  // A clicked page notification brings its tab forward, as in Chrome.
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  useEffect(
    () =>
      desktopApi.onBrowserRevealGuest((guestId) => {
        const match = [...browserGuestIdsRef.current].find(
          ([, id]) => id === guestId,
        );
        if (match) selectTabRef.current(`browser:${match[0]}`);
      }),
    [],
  );

  // target=_blank / window.open from any page in this window → new tab.
  const openBrowserTabRef = useRef(openBrowserTab);
  openBrowserTabRef.current = openBrowserTab;
  // Links wait until where they land is settled: the profile's projects and
  // the last one it had open are known, and that project's workspace is
  // restored. Taken earlier (a cold launch from a link), a link opens in a
  // placeholder workspace that the restored one then replaces.
  const linksLandSettled =
    !projectsLoading && prefs !== null && (!projectId || workspaceReady);
  useEffect(() => {
    const take = () => {
      if (!runtime.visible || !activeProfile?.id || !linksLandSettled) return;
      void desktopApi
        .browserTakePendingUrls()
        .then((urls) => {
          for (const url of urls)
            if (!switchToOpenPageRef.current(url))
              openBrowserTabRef.current(url);
        })
        .catch(() => {});
    };
    take();
    return desktopApi.onPendingBrowserUrls(take);
  }, [runtime.visible, activeProfile?.id, linksLandSettled]);
  useEffect(() => {
    return desktopApi.onBrowserOpenUrl((url, mode) => {
      if (!visibleRef.current) return;
      // No mode: a page's link to a new window, or a link from another app.
      // A mode is a new tab (or side, floating) asked for on purpose.
      if (!mode && switchToOpenPageRef.current(url)) return;
      openBrowserTabRef.current(url, {
        floating: mode
          ? mode === "floating"
          : prefsRef.current?.linkOpenMode === "floating",
        side: mode === "side",
      });
    });
  }, []);

  // navigate(url) handles per live browser tab, for "open in current tab"
  // (bookmarks/links with open:"replace").
  const browserShortcutTargetRef = useRef<string | undefined>(undefined);
  const browserCommandsRef = useRef(new Map<string, BrowserCommands>());
  const browserNavigatorsRef = useRef(new Map<string, (url: string) => void>());
  const browserHistoryNavigatorsRef = useRef(
    new Map<string, (direction: "back" | "forward") => void>(),
  );

  // Animated close per chat dock — external closers (Cmd+W) must play the
  // same 250ms collapse Escape does, not unmount the dock mid-frame.
  const chatClosersRef = useRef(new Map<string, () => void>());

  // Staged tab-minimize per chat dock — Cmd+M on a fullscreen chat tab
  // must play the dock's collapse before the mode flips, exactly like
  // the dash control (the tween runs before the workspace re-render).
  const chatMinimizersRef = useRef(new Map<string, () => void>());
  /** Each chat's way to focus its first chip (the focus-chips shortcut). */
  const chipFocusersRef = useRef(new Map<string, () => boolean>());
  // Per-chat "re-pull the editor selection" counters (see addChat).
  const [selectionPulls, setSelectionPulls] = useState<Record<string, number>>(
    {},
  );

  // Live message senders per chat dock — how anything outside a dock
  // (post-auth continuations) speaks into an already open chat. Sends
  // queue behind an in-flight turn like composer sends.
  const chatSendersRef = useRef(new Map<string, (message: string) => void>());
  // The palette's skills (ADR 0270): each chat's skill sender, which takes
  // its composer's pills along, and the way back into its composer.
  const chatSkillsRef = useRef(new Map<string, (message: string) => void>());
  const composerReturnsRef = useRef(new Map<string, (text: string) => void>());

  // Webview guest WebContents ids per browser tab — the agent bridge
  // drives pages from the main process by guest id.
  const [busyBrowsers, setBusyBrowsers] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: guest activity belongs to the mounted project
  useEffect(() => {
    setBusyBrowsers(new Set());
  }, [projectId]);
  const browserGuestIdsRef = useRef(new Map<string, number>());

  // Browser tabs out of sight for a while sleep (ADR 0194); tabs the
  // workspace mounts with start asleep, so only the shown ones load.
  const sleepSlots = workspaceLayout(workspace).viewSlots;
  const tabSleep = useTabSleep({
    mountKey: projectId
      ? workspaceReady
        ? projectId
        : null
      : utilityWorkspaceKey,
    // Only a project's workspace is restored; the profile's own browser
    // holds just the pages opened this session.
    startAsleep: Boolean(projectId),
    candidates: workspace.browsers.map((browser) => ({
      localId: browser.localId,
      hasPage: Boolean(browser.url || browser.initialUrl),
      awake:
        (runtime.visible &&
          Boolean(sleepSlots[browserTabKey(browser.localId)])) ||
        busyBrowsers.has(browser.localId),
      agentControlled: Boolean(browser.agentControlled),
    })),
    setting: prefs?.browserTabSleep,
    // A page whose browser cannot answer stays awake.
    blockerFor: async (localId) => {
      const commands = browserCommandsRef.current.get(localId);
      return commands ? commands.sleepBlocker() : "shared";
    },
  });
  const wakeTab = tabSleep.wake;
  const tabAsleepRef = useRef(tabSleep.asleep);
  tabAsleepRef.current = tabSleep.asleep;

  /**
   * Bookmark/link click behavior: "replace" goes to the page's open tab
   * (`switchToOpenTab`) or reuses the focused browser tab; anything else
   * (or no focused browser tab) opens a new tab.
   */
  const openUrl = async (url: string, mode: CommitMode) => {
    if (url.startsWith("file:")) {
      await openLinkedSurface(url, { mode });
      return;
    }
    const target = parseChatBookmarkUrl(url);
    if (target) {
      if (!projects.some((project) => project.id === target.projectId)) {
        throw new Error(
          "This chat's project is not available in this profile.",
        );
      }
      const saved = await desktopApi.workspaceStateGet(target.projectId);
      setWorkspaces((current) => {
        const targetWorkspace =
          current[target.projectId] ??
          hydrateWorkspace(saved) ??
          defaultWorkspaceFor(target.projectId);
        const existing = targetWorkspace.chats.find(
          (chat) => chat.sessionId === target.sessionId,
        );
        const entry: ChatDockEntry = {
          ...(existing ?? newChatEntry("tab")),
          sessionId: target.sessionId,
          mode: mode === "floating" ? "partial" : "tab",
        };
        // Reconciled as any change is: a New Tab it leaves behind closes.
        return {
          ...current,
          [target.projectId]: reconcileWorkspace(targetWorkspace, {
            ...targetWorkspace,
            chats: [
              ...targetWorkspace.chats.filter(
                (chat) => chat.localId !== entry.localId,
              ),
              entry,
            ],
            activeChatId: entry.localId,
            activeTabKey:
              mode === "floating"
                ? targetWorkspace.activeTabKey === chatTabKey(entry.localId)
                  ? orderedTabKeys(targetWorkspace).find(
                      (key) => key !== targetWorkspace.activeTabKey,
                    )
                  : targetWorkspace.activeTabKey
                : chatTabKey(entry.localId),
            floatingKey: undefined,
            split:
              mode === "side" &&
              targetWorkspace.activeTabKey &&
              targetWorkspace.activeTabKey !== chatTabKey(entry.localId)
                ? {
                    leftKey: targetWorkspace.activeTabKey,
                    rightKey: chatTabKey(entry.localId),
                    ratio: 0.5,
                  }
                : null,
          }),
        };
      });
      selectProject(target.projectId);
      return;
    }
    if (mode === "replace" && switchToOpenPage(url)) return;
    const ws = workspaceRef.current;
    const focusedKey = ws.floatingKey ?? ws.activeTabKey;
    const focusedBrowserId = focusedKey?.startsWith("browser:")
      ? focusedKey.slice("browser:".length)
      : undefined;
    const navigate = focusedBrowserId
      ? browserNavigatorsRef.current.get(focusedBrowserId)
      : undefined;
    if (mode === "replace" && navigate) {
      navigate(url);
      return;
    }
    openBrowserTab(url, {
      side: mode === "side",
      floating: mode === "floating",
    });
  };

  const closeTabImmediately = (
    key: string,
    opts?: { force?: boolean; discardDraft?: boolean },
  ) => {
    if (
      !opts?.discardDraft &&
      workspace.tabs.some(
        (tab) => tab.kind === "workflow" && tabKey(tab) === key && tab.draft,
      )
    ) {
      setClosingWorkflow(key);
      return;
    }
    if (key.startsWith("agent-setup:") && activeProfileId)
      setupDismissedRef.current.add(activeProfileId);
    const browser = workspaceRef.current.browsers.find(
      (item) => browserTabKey(item.localId) === key,
    );
    if (browser && (!browser.chatLocalId || opts?.force)) {
      browserNavigatorsRef.current.delete(browser.localId);
      browserHistoryNavigatorsRef.current.delete(browser.localId);
      browserGuestIdsRef.current.delete(browser.localId);
    }
    updateWorkspace((ws) =>
      transitionWorkspace(ws, { type: "close", key, ...opts }),
    );
  };

  const closeTab = (
    key: string,
    opts?: {
      force?: boolean;
      discardDraft?: boolean;
      /** An agent's, an extension's, or a page closing itself: not asked. */
      final?: boolean;
    },
  ) => {
    const { final, ...close } = opts ?? {};
    // A close that disposes a page asks it first: a beforeunload may hold
    // it with "Leave site?" (ADR 0227). A chat's attached page only goes
    // back to its chip, still loaded, so nothing is asked then.
    const localId = key.startsWith("browser:")
      ? key.slice("browser:".length)
      : null;
    const browser = workspaceRef.current.browsers.find(
      (item) => item.localId === localId,
    );
    const page =
      localId && browser && (!browser.chatLocalId || close.force) && !final
        ? browserCommandsRef.current.get(localId)
        : undefined;
    if (page) {
      void page.mayClose().then((leave) => {
        if (leave) closeTab(key, { ...close, final: true });
      });
      return;
    }
    if (workspaceRef.current.floatingKey === key)
      floatingMotion.dismiss(() => closeTabImmediately(key, close));
    else closeTabImmediately(key, close);
  };

  /** Cmd+Shift+T: restore the most recently closed tab (re-tiled when
      its old split partner is still open). */
  const reopenTab = () => {
    const localId = crypto.randomUUID();
    updateWorkspace((ws) =>
      transitionWorkspace(ws, { type: "reopen", localId }),
    );
  };

  const toggleChat = (localId: string) =>
    updateWorkspace((ws) =>
      transitionWorkspace(ws, { type: "toggle-chat", localId }),
    );

  /** Bring a chat's surface on screen (desktop-notification clicks). */
  const revealChat = (localId: string) =>
    updateWorkspace((ws) =>
      transitionWorkspace(ws, { type: "reveal-chat", localId }),
    );

  /**
   * An agent-held surface's "Go to chat": the chat comes on screen and its
   * composer takes the keys (as a palette skill hands back), so the move
   * shows even when the chat is already beside the surface in a split.
   */
  const goToChat = (localId: string) => {
    revealChat(localId);
    composerReturnsRef.current.get(localId)?.("");
  };

  const revealChatRef = useRef(revealChat);
  revealChatRef.current = revealChat;

  const closingChatIds = useRef(new Set<string>());
  const closeChat = (localId: string) => {
    closingChatIds.current.delete(localId);
    chatClosersRef.current.delete(localId);
    chatMinimizersRef.current.delete(localId);
    chatSkillsRef.current.delete(localId);
    composerReturnsRef.current.delete(localId);
    updateWorkspace((ws) => {
      const closing = ws.chats.find((chat) => chat.localId === localId);
      const chats = ws.chats.filter((chat) => chat.localId !== localId);
      return {
        ...ws,
        chats,
        // Every close path feeds Cmd+Shift+T, not just the tab strip's —
        // the dock's own X, a bubble's X, and Cmd+W-on-floating all land
        // here. Sessionless chats are skipped: reopening one would just
        // make a new empty chat.
        closedTabs: closing?.sessionId
          ? [
              ...ws.closedTabs,
              {
                kind: "chat" as const,
                sessionId: closing.sessionId,
                incognito: closing.incognito,
              },
            ].slice(-CLOSED_TABS_KEPT)
          : ws.closedTabs,
        activeChatId: ws.activeChatId === localId ? undefined : ws.activeChatId,
        activeTabKey:
          ws.activeTabKey === chatTabKey(localId)
            ? nextActiveTabKey(ws, chatTabKey(localId), chats)
            : ws.activeTabKey,
      };
    });
  };

  // Cmd+N and the palette open the floating aside, or the New Tab in
  // front: a chat asked for from one opens in it. The dock's + keeps its
  // chats in the dock (`inNewTab: false`).
  const addChat = (
    forceMode?: "tab",
    opts?: {
      incognito?: boolean;
      worktree?: boolean;
      agentId?: string;
      inNewTab?: boolean;
    },
  ) => {
    if (!requireAgents()) return;
    updateWorkspace((ws) => {
      // Already looking at a fresh chat (no session yet)? Don't stack
      // another empty one on top — Cmd+N/+ is a no-op there, except that
      // it re-pulls the editor selection: "select, Cmd+N, ask" must work
      // whether or not an empty chat was already waiting.
      const active = ws.chats.find((chat) => chat.localId === ws.activeChatId);
      const activeIsVisible =
        active?.mode === "partial" ||
        (active?.mode === "tab" &&
          ws.activeTabKey === chatTabKey(active.localId));
      const activeSignals = active ? signalsByChat[active.localId] : undefined;
      const inNewTab = opts?.inNewTab !== false && Boolean(newTabInFront(ws));
      if (
        activeIsVisible &&
        !closingChatIds.current.has(active.localId) &&
        !active.sessionId &&
        !active.pendingMessage &&
        !active.draftMessage &&
        !activeSignals?.working &&
        !activeSignals?.draft &&
        !activeSignals?.awaitingInput &&
        // A fresh plain chat doesn't satisfy "new INCOGNITO chat".
        Boolean(active.incognito) === Boolean(opts?.incognito) &&
        // Nor does a fresh worktree chat a plain one; the reverse takes one.
        (!active.worktree || opts?.worktree)
      ) {
        // Floating over a New Tab, the fresh chat moves into that tab.
        const kept = (reused: Workspace) =>
          inNewTab && active.mode === "partial"
            ? openChatInNewTab(
                ws,
                {
                  ...reused,
                  chats: reused.chats.map((chat) =>
                    chat.localId === active.localId
                      ? { ...chat, mode: "tab" as const }
                      : chat,
                  ),
                  activeTabKey: chatTabKey(active.localId),
                },
                chatTabKey(active.localId),
              )
            : reused;
        // Asked for a worktree, the fresh chat takes one (ADR 0215).
        if (opts?.worktree && !active.worktree) {
          setSelectionPulls((current) => ({
            ...current,
            [active.localId]: (current[active.localId] ?? 0) + 1,
          }));
          return kept({
            ...ws,
            chats: ws.chats.map((chat) =>
              chat.localId === active.localId
                ? { ...chat, worktree: true }
                : chat,
            ),
          });
        }
        setSelectionPulls((current) => ({
          ...current,
          [active.localId]: (current[active.localId] ?? 0) + 1,
        }));
        // Asked for with an agent, the fresh chat takes it.
        const agentId = opts?.agentId;
        return kept(
          agentId && active.agentId !== agentId
            ? {
                ...ws,
                chats: ws.chats.map((chat) =>
                  chat.localId === active.localId
                    ? { ...chat, agentId, model: undefined }
                    : chat,
                ),
              }
            : ws,
        );
      }
      // Floating chats become a full tab anyway when the workspace is
      // empty — with nothing behind it, the chat IS the workspace.
      const noTabsOpen =
        ws.tabs.length === 0 &&
        ws.browsers.length === 0 &&
        ws.terminals.length === 0 &&
        ws.editors.length === 0 &&
        ws.chats.every((chat) => chat.mode !== "tab");
      const entry = newChatEntry(
        forceMode ?? (noTabsOpen || inNewTab ? "tab" : "partial"),
        opts,
      );
      const next = {
        ...ws,
        chats: [
          ...ws.chats.map((chat) =>
            chat.mode === "partial" ? { ...chat, mode: "min" as const } : chat,
          ),
          entry,
        ],
        activeChatId: entry.localId,
        activeTabKey:
          entry.mode === "tab" ? chatTabKey(entry.localId) : ws.activeTabKey,
      };
      return inNewTab && entry.mode === "tab"
        ? openChatInNewTab(ws, next, chatTabKey(entry.localId))
        : next;
    });
  };

  // Palette "Send to agent": a new chat born with its first message
  // attached; ChatDock auto-sends it on mount. Asked for from the palette
  // (`inNewTab`), a New Tab in front takes it, however it was committed.
  const sendToAgent = (
    message: string | PendingChatMessage,
    mode: "float" | "tab",
    agentId?: string,
    options: { watchBackdrop?: boolean; inNewTab?: boolean } = {},
  ) => {
    if (!requireAgents()) return;
    const entry: ChatDockEntry = {
      ...newChatEntry(mode === "tab" ? "tab" : "partial"),
      pendingMessage: typeof message === "string" ? { text: message } : message,
      ...(agentId ? { agentId } : {}),
      ...(options.watchBackdrop ? { watchBackdrop: true } : {}),
    };
    updateWorkspace((ws) => {
      const inNewTab = options.inNewTab === true && Boolean(newTabInFront(ws));
      const placed: ChatDockEntry = inNewTab
        ? { ...entry, mode: "tab" }
        : entry;
      const next = {
        ...ws,
        chats: [
          ...ws.chats.map((chat) =>
            chat.mode === "partial" ? { ...chat, mode: "min" as const } : chat,
          ),
          placed,
        ],
        activeChatId: placed.localId,
        activeTabKey:
          placed.mode === "tab" ? chatTabKey(placed.localId) : ws.activeTabKey,
      };
      return inNewTab
        ? openChatInNewTab(ws, next, chatTabKey(placed.localId))
        : next;
    });
    return entry.localId;
  };

  // Agent-less profiles greet the user with the setup wizard as a real,
  // closable tab: close it to skip; it returns as a modal on chat attempts.
  useEffect(() => {
    if (
      !projectId ||
      !remoteSurfaceResolved ||
      !workspaceReady ||
      agentsData === null ||
      hasAgents
    )
      return;
    if (!activeProfileId || setupDismissedRef.current.has(activeProfileId)) {
      return;
    }
    updateWorkspace((ws) => {
      const key = "agent-setup:setup";
      if (ws.tabs.some((tab) => tabKey(tab) === key)) return ws;
      const tab: WorkspaceTab = {
        kind: "agent-setup",
        name: "setup",
        label: "Set up agent",
      };
      return { ...ws, tabs: [...ws.tabs, tab], activeTabKey: key };
    });
  }, [
    projectId,
    workspaceReady,
    remoteSurfaceResolved,
    agentsData,
    hasAgents,
    activeProfileId,
    updateWorkspace,
  ]);

  // Agent discovery is asynchronous at launch. If a persisted setup tab is
  // restored, or the first empty response races the real agents payload,
  // reconcile it away as soon as an existing agent is known.
  // Not while the user is inside a wizard flow, though: a sign-in creates
  // its agent first, and closing here would strand them mid-sign-in with no
  // progress, command, or error in sight. The wizard's onDone closes it.
  useEffect(() => {
    if (!hasAgents || wizardEngagedRef.current) return;
    setWizardModalOpen(false);
    updateWorkspace((ws) => {
      const tabs = ws.tabs.filter((tab) => tab.kind !== "agent-setup");
      if (tabs.length === ws.tabs.length) return ws;
      const lastTab = tabs.at(-1);
      const activeTabKey = tabs.some((tab) => tabKey(tab) === ws.activeTabKey)
        ? ws.activeTabKey
        : lastTab
          ? tabKey(lastTab)
          : undefined;
      return { ...ws, tabs, activeTabKey };
    });
  }, [hasAgents, updateWorkspace]);

  const minimizeFloatingChats = () =>
    updateWorkspace((ws) => ({
      ...ws,
      chats: ws.chats.map((chat) =>
        chat.mode === "partial" ? { ...chat, mode: "min" as const } : chat,
      ),
    }));

  const openSession = (
    session: AgentSession,
    placement?: CommitMode | "split",
  ) =>
    updateWorkspace((ws) => {
      const existing = ws.chats.find((chat) => chat.sessionId === session.id);
      // Already-tabbed chats stay tabs; everything else opens as the
      // floating dock — unless no tabs are open, where a tab is the
      // natural landing (same rule as addChat).
      const noTabsOpen =
        ws.tabs.length === 0 &&
        ws.browsers.length === 0 &&
        ws.terminals.length === 0 &&
        ws.editors.length === 0 &&
        ws.chats.every((chat) => chat.mode !== "tab");
      const mode =
        placement === "floating"
          ? "partial"
          : placement === "replace" ||
              placement === "tab" ||
              placement === "side" ||
              placement === "split" ||
              existing?.mode === "tab" ||
              noTabsOpen
            ? ("tab" as const)
            : ("partial" as const);
      const parentLocalId = session.parentSessionId
        ? ws.chats.find((chat) => chat.sessionId === session.parentSessionId)
            ?.localId
        : undefined;
      const entry = existing ?? {
        ...newChatEntry(mode),
        sessionId: session.id,
        parentLocalId,
      };
      const key = chatTabKey(entry.localId);
      const split =
        (placement === "split" || placement === "side") &&
        ws.activeTabKey &&
        ws.activeTabKey !== key
          ? { leftKey: ws.activeTabKey, rightKey: key, ratio: 0.5 }
          : placement === "tab" ||
              (mode === "partial" &&
                (ws.split?.leftKey === key || ws.split?.rightKey === key))
            ? null
            : ws.split;
      return {
        ...ws,
        chats: [
          ...ws.chats
            .filter((chat) => chat.localId !== entry.localId)
            .map((chat) =>
              chat.mode === "partial"
                ? { ...chat, mode: "min" as const }
                : chat,
            ),
          { ...entry, mode },
        ],
        activeChatId: entry.localId,
        floatingKey: undefined,
        activeTabKey:
          mode === "tab"
            ? key
            : ws.activeTabKey === key
              ? nextActiveTabKey(ws, key, ws.chats)
              : ws.activeTabKey,
        split,
      };
    });

  const onSessionCreated = useCallback(
    (localId: string, sessionId: string) =>
      updateWorkspace((ws) => ({
        ...ws,
        chats: ws.chats.map((chat) =>
          chat.localId === localId ? { ...chat, sessionId } : chat,
        ),
      })),
    [updateWorkspace],
  );

  // Only the entry's agent and harness (bound once, never unbound): the
  // chat stays where and how it is shown.
  const onSessionAgent = useCallback(
    (localId: string, session: { agentId: string; harness?: string }) =>
      updateWorkspace((ws) =>
        ws.chats.some(
          (chat) =>
            chat.localId === localId &&
            (chat.agentId !== session.agentId ||
              (session.harness !== undefined &&
                chat.harness !== session.harness)),
        )
          ? {
              ...ws,
              chats: ws.chats.map((chat) =>
                chat.localId === localId
                  ? {
                      ...chat,
                      agentId: session.agentId,
                      ...(session.harness ? { harness: session.harness } : {}),
                    }
                  : chat,
              ),
            }
          : ws,
      ),
    [updateWorkspace],
  );

  // Latest workspace for callbacks that outlive a render.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const signalsRef = useRef<Record<string, ChatLiveSignals>>({});
  /**
   * A settled agent deserves a cue: soft chime when it finishes or asks
   * (only when the chat isn't front-and-center — watching it IS the cue),
   * plus an OS notification when the window itself is unfocused. Both are
   * per-profile preferences.
   */
  const notifySettled = useCallback(
    (localId: string, kind: "done" | "question") => {
      const ws = workspaceRef.current;
      const chat = ws.chats.find((candidate) => candidate.localId === localId);
      if (!chat) return;
      const visible = visibleRef.current && chatVisible(ws, chat);
      const focused = document.hasFocus();
      const current = prefsRef.current;
      const title = chatLabelsRef.current[localId] ?? "Chat";
      if ((current?.notificationSounds ?? true) && !(visible && focused)) {
        playChime(kind);
      }
      if (current?.desktopNotifications ?? true) {
        notifyDesktop(
          title,
          kind === "question"
            ? "The agent has a question for you."
            : "The agent finished working.",
          () => {
            void desktopApi.windowFocus();
            revealChatRef.current(localId);
          },
        );
      }
    },
    [],
  );

  const notifiedMessagesRef = useRef(new Set<string>());
  useEffect(() => {
    if (!projectId || !workspaceReady) return;
    for (const session of projectAttention ?? []) {
      const message = session.attentionMessage;
      if (
        !session.attentionRequired ||
        !message ||
        notifiedMessagesRef.current.has(message.id)
      )
        continue;
      notifiedMessagesRef.current.add(message.id);
      const chat = workspaceRef.current.chats.find(
        (candidate) => candidate.sessionId === session.id,
      );
      if (
        (prefsRef.current?.notificationSounds ?? true) &&
        !(
          visibleRef.current &&
          document.hasFocus() &&
          chat &&
          chatVisible(workspaceRef.current, chat)
        )
      )
        playChime("question");
      if (prefsRef.current?.desktopNotifications ?? true) {
        notifyDesktop(
          session.title ?? "A message needs your attention",
          message.content,
          () => {
            void desktopApi.windowFocus();
            void desktopApi.workspaceNavigate({ projectId });
            const existing = workspaceRef.current.chats.find(
              (candidate) => candidate.sessionId === session.id,
            );
            const entry = existing ?? {
              ...newChatEntry("min"),
              sessionId: session.id,
            };
            updateWorkspace((ws) => ({
              ...ws,
              chats: existing
                ? ws.chats.map((candidate) =>
                    candidate.localId === entry.localId
                      ? { ...candidate, focusMessageId: message.id }
                      : candidate,
                  )
                : [...ws.chats, { ...entry, focusMessageId: message.id }],
            }));
            revealChatRef.current(entry.localId);
          },
        );
      }
    }
  }, [projectId, workspaceReady, projectAttention, updateWorkspace]);

  const onSignalsChange = useCallback(
    (localId: string, next: ChatLiveSignals) => {
      const previous = signalsRef.current[localId];
      const had = previous !== undefined;
      const before = previous ?? NO_CHAT_SIGNALS;
      if (
        before.working === next.working &&
        before.draft === next.draft &&
        before.awaitingInput === next.awaitingInput
      ) {
        return;
      }
      signalsRef.current = { ...signalsRef.current, [localId]: next };
      setSignalsByChat(signalsRef.current);
      const ws = workspaceRef.current;
      const chat = ws.chats.find((candidate) => candidate.localId === localId);
      // Response landed while the chat was hidden (minimized bubble or a
      // background tab) → unread dot.
      if (
        before.working &&
        !next.working &&
        chat &&
        (!visibleRef.current || !chatVisible(ws, chat))
      ) {
        if (chat.sessionId) {
          setSessionListPreference("unreadSessionIds", [chat.sessionId], true);
        }
      }
      // Notify only on live transitions — the first report for a chat is
      // its mount snapshot (a reopened session with an old question must
      // not chime).
      if (had && before.working && !next.working) {
        notifySettled(localId, next.awaitingInput ? "question" : "done");
      } else if (had && !before.awaitingInput && next.awaitingInput) {
        notifySettled(localId, "question");
      }
    },
    [notifySettled, setSessionListPreference],
  );

  // A hidden -> visible transition marks a session read. A manual "Mark as
  // unread" while the chat is already visible therefore sticks until the
  // user leaves and opens it again.
  const visibleSessionIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const visibleIds = new Set(
      workspace.chats
        .filter((chat) => runtime.visible && chatVisible(workspace, chat))
        .flatMap((chat) => (chat.sessionId ? [chat.sessionId] : [])),
    );
    const newlyVisible = [...visibleIds].filter(
      (id) => !visibleSessionIdsRef.current.has(id),
    );
    visibleSessionIdsRef.current = visibleIds;
    setSessionListPreference("unreadSessionIds", newlyVisible, false);
  }, [workspace, runtime.visible, setSessionListPreference]);

  // Cmd+W (via the app menu) closes the most specific surface in focus:
  // the floating chat if one is open, else the active workspace tab.
  const closeChatRef = useRef(closeChat);
  closeChatRef.current = closeChat;
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;
  const closeDispatchPendingRef = useRef(false);
  const lastChatStepDownRef = useRef<
    | {
        localId: string;
        at: number;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    const cancelStepDownHandoff = (event: PointerEvent) => {
      const pending = lastChatStepDownRef.current;
      if (!pending) return;
      const targetChatId =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-chat-local-id]")?.dataset
              .chatLocalId
          : undefined;
      if (targetChatId !== pending.localId) {
        lastChatStepDownRef.current = undefined;
      }
    };
    window.addEventListener("pointerdown", cancelStepDownHandoff, {
      capture: true,
    });
    return () =>
      window.removeEventListener("pointerdown", cancelStepDownHandoff, {
        capture: true,
      });
  }, []);
  // An OAuth consent tab has done its job once the loopback callback was
  // served: close it (with the tab's exit motion) instead of leaving a
  // "you can close this tab" page behind. The tab may still be mid-redirect
  // to the callback, so match on the live URL a moment later too.
  useEffect(() => {
    return desktopApi.onBrowserCloseUrl((prefix) => {
      const closeMatching = () => {
        const ws = workspaceRef.current;
        let closed = false;
        for (const browser of ws.browsers) {
          // The callback path specifically: with a fixed port (Slack's
          // 3118) a bare origin match could close a dev-server tab.
          if (
            browser.initialUrl === prefix ||
            browser.url.startsWith(`${prefix}/callback`)
          ) {
            closeTabRef.current(browserTabKey(browser.localId), {
              force: true,
              final: true,
            });
            closed = true;
          }
        }
        return closed;
      };
      if (!closeMatching()) window.setTimeout(closeMatching, 800);
    });
  }, []);
  const closeActiveSurface = useCallback(() => {
    const chatProject = document.activeElement?.closest<HTMLElement>(
      "[data-chat-project]",
    )?.dataset.chatProject;
    if (chatProject && chatProject !== projectIdRef.current) return;
    // A guest-focused key can arrive through both Electron's menu and the
    // webview relay. Decide once after those deliveries and any preceding
    // surface transition (for example Escape: tab → floating) have settled.
    if (closeDispatchPendingRef.current) return;
    closeDispatchPendingRef.current = true;
    const steppedDown = lastChatStepDownRef.current;
    const requestedChatId =
      steppedDown && performance.now() - steppedDown.at < 500
        ? steppedDown.localId
        : focusedChatSurfaceId();
    lastChatStepDownRef.current = undefined;
    window.setTimeout(() => {
      closeDispatchPendingRef.current = false;
      const ws = workspaceRef.current;
      if (ws.floatingKey) {
        closeTabRef.current(ws.floatingKey);
        return;
      }
      const focusedChat = ws.chats.find(
        (chat) => chat.localId === requestedChatId,
      );
      const floating =
        (focusedChat?.mode === "partial" ? focusedChat : undefined) ??
        ws.chats.find((chat) => chat.mode === "partial");
      // The floating chat only owns Cmd+W while the user is IN it. Focus is
      // the tell (its composer takes focus on open); when nothing focusable
      // holds focus (a click on a pane's blank chrome, a webview whose guest
      // swallowed the click), the last pointer-down decides. Clicking into
      // the tab behind the dock and pressing Cmd+W closes the tab.
      if (
        floating &&
        (!ws.activeTabKey ||
          focusedChat?.mode === "partial" ||
          focusedChat?.mode === "min")
      ) {
        // Through the dock's animated close (same collapse as Escape);
        // straight removal only if the dock never registered one.
        const animated = chatClosersRef.current.get(floating.localId);
        if (animated) animated();
        else closeChatRef.current(floating.localId);
        return;
      }
      if (ws.activeTabKey) closeTabRef.current(ws.activeTabKey);
    }, 25);
  }, []);
  useEffect(() => {
    return desktopApi.onCloseSurface(() => {
      if (visibleRef.current) closeActiveSurface();
    });
  }, [closeActiveSurface]);

  // --- agent commands (palette pickers) ---

  // The chat the agent commands act on: the active chat while its surface
  // is on screen (floating dock or focused tab).
  const focusedChat = workspace.chats.find(
    (chat) =>
      chat.localId === workspace.activeChatId && chatVisible(workspace, chat),
  );
  const focusedSession = focusedChat?.sessionId
    ? sessionsById.get(focusedChat.sessionId)
    : undefined;

  // Palette skills (ADR 0052, 0270): applied here, the invocation lands in
  // the chat whose composer opened the palette, else the focused chat (the
  // border-accented target), and its composer has the keyboard back. A new
  // chat starts exactly like "Send to agent".
  const runSkill: PaletteHost["onRunSkill"] = ({
    message,
    target,
    composer,
    agentId,
  }) => {
    const chat = composer ?? focusedChat?.localId;
    const apply = chat ? chatSkillsRef.current.get(chat) : undefined;
    if (target === "chat" && chat && apply) {
      apply(message);
      revealChat(chat);
      composerReturnsRef.current.get(chat)?.("");
      return;
    }
    sendToAgent(message, target === "tab" ? "tab" : "float", agentId, {
      inNewTab: true,
    });
  };
  /**
   * "/" in a chat's composer: the palette's Skills mode, aimed there. A chat
   * of a project behind the one in front brings its project forward first;
   * the palette opens once this workspace shows.
   */
  const [skillsFor, setSkillsFor] = useState<string | null>(null);
  const openSkills = (localId: string) => {
    revealChat(localId);
    setSkillsFor(localId);
  };
  useEffect(() => {
    if (!skillsFor || !runtime.visible) return;
    setSkillsFor(null);
    setPaletteOpen(true);
    setModeRequest({
      mode: "skills",
      composer: skillsFor,
      nonce: crypto.randomUUID(),
    });
  }, [skillsFor, runtime.visible]);

  const updateSession = useUpdateAgentSession(projectId);
  const forkSession = useForkAgentSession(projectId);
  const [sessionInspectRequests, setSessionInspectRequests] = useState<
    Record<string, number>
  >({});

  /**
   * Fork a chat from one of its assistant messages: the server copies the
   * transcript into a new session (same agent, parent recorded); the fork
   * opens tiled beside the current view and chips onto the parent's rail.
   */
  const forkChat = (parent: ChatDockEntry, messageId?: string) => {
    if (!parent.sessionId || forkSession.isPending) return;
    forkSession.mutate(
      { sessionId: parent.sessionId, messageId },
      {
        onSuccess: (session) => {
          // A fork of an incognito chat holds the same transcript, so it
          // inherits the flag: marked before any turn can settle, which
          // is what keeps the mirror from ever seeing it (ADR 0062).
          if (parent.incognito) {
            void desktopApi.sessionSetIncognito(session.id, true);
          }
          updateWorkspace((ws) => {
            const entry: ChatDockEntry = {
              ...newChatEntry("tab", { incognito: parent.incognito }),
              sessionId: session.id,
              parentLocalId: parent.localId,
            };
            const key = chatTabKey(entry.localId);
            // Tile the fork beside whatever the user is looking at; with
            // nothing focused it simply becomes the active tab.
            const split =
              ws.activeTabKey && ws.activeTabKey !== key
                ? { leftKey: ws.activeTabKey, rightKey: key, ratio: 0.5 }
                : null;
            return {
              ...ws,
              chats: [...ws.chats, entry],
              activeChatId: entry.localId,
              activeTabKey: key,
              split,
            };
          });
        },
      },
    );
  };

  /** Reveal a fork's parent chat — reopening it if it was closed. */
  const openParentChat = (entry: ChatDockEntry) => {
    const parentSessionId = entry.sessionId
      ? sessionsById.get(entry.sessionId)?.parentSessionId
      : undefined;
    const ws = workspaceRef.current;
    const openParent =
      ws.chats.find(
        (candidate) =>
          candidate.localId === entry.parentLocalId ||
          (parentSessionId && candidate.sessionId === parentSessionId),
      ) ?? null;
    if (openParent) {
      revealChat(openParent.localId);
      return;
    }
    const parentSession = parentSessionId
      ? sessionsById.get(parentSessionId)
      : undefined;
    if (parentSession) openSession(parentSession);
  };

  // The surface a highlighted palette command would act on gets an accent
  // border while the row is selected — the command points at its target.
  const [paletteTarget, setPaletteTarget] = useState<"chat" | "close" | null>(
    null,
  );
  const floatingChat = workspace.chats.find((chat) => chat.mode === "partial");
  const targetedChat =
    paletteTarget === "chat"
      ? focusedChat
      : paletteTarget === "close"
        ? floatingChat
        : undefined;
  const targetedTabKey =
    paletteTarget === "close" && !floatingChat
      ? workspace.activeTabKey
      : paletteTarget === "chat" && focusedChat?.mode === "tab"
        ? chatTabKey(focusedChat.localId)
        : undefined;

  // Overlay palette opened straight into a mode (commands run from
  // anywhere, sidebar searches; palette tabs enter modes through rows).
  const [modeRequest, setModeRequest] = useState<PaletteModeRequest | null>(
    null,
  );
  const openPalettePicker = (mode: PaletteChoiceMode) => {
    setPaletteOpen(true);
    setModeRequest({ mode, nonce: crypto.randomUUID() });
  };
  const focusSearch = (action: string, mode?: "files" | "content") => {
    const input = findSearchInput(action);
    if (input) {
      input.focus();
      input.select();
    } else if (mode) {
      setPaletteOpen(true);
      setModeRequest({ mode, nonce: crypto.randomUUID() });
    }
  };

  // Layered default agent (ADR 0056): this user's per-project override,
  // then the project's committed default (.work/project.json), then
  // the profile default. `agentsData` is the refetch trigger — setting the
  // committed default broadcasts an agents-changed like any other layer.
  const [projectDefaultSlug, setProjectDefaultSlug] = useState<string | null>(
    null,
  );
  const [projectAgentNames, setProjectAgentNames] = useState<
    Record<string, string>
  >({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: agentsData is a deliberate refetch trigger — a defaults edit broadcasts agents-changed
  useEffect(() => {
    if (!projectId) {
      setProjectDefaultSlug(null);
      setProjectAgentNames({});
      return;
    }
    let cancelled = false;
    void desktopApi
      .projectAgentsList(projectId)
      .then((data) => {
        if (!cancelled) {
          setProjectDefaultSlug(data.projectDefaultSlug);
          setProjectAgentNames(
            Object.fromEntries(
              data.agents.map((agent) => [agent.id, agent.name]),
            ),
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, agentsData]);
  const projectOverrideAgentId = projectId
    ? (agentsData?.projectDefaults?.[projectId] ?? null)
    : null;
  const effectiveDefaultAgentId =
    projectOverrideAgentId ??
    (projectId && projectDefaultSlug
      ? `project:${projectId}:${projectDefaultSlug}`
      : null) ??
    agentsData?.defaultAgentId ??
    null;

  const pickDefaultAgent = (agentId: string) => {
    // Inside a project the palette pick is this user's per-project
    // override (ADR 0056); the global default changes in the agent modal
    // or Settings — or here, when no project is open.
    if (projectId) void desktopApi.agentsSetProjectDefault(projectId, agentId);
    else void desktopApi.agentsSetDefault(agentId);
  };

  // The configure-agent modal (ADR 0056): THE surface for one agent's
  // configuration, reached from the palette picker and Settings. The id
  // outlives `open` so the exit transition plays over the same content.
  const [configureAgentId, setConfigureAgentId] = useState<string | null>(null);
  const [configureAgentOpen, setConfigureAgentOpen] = useState(false);
  const openConfigureAgent = (agentId: string) => {
    setConfigureAgentId(agentId);
    setConfigureAgentOpen(true);
  };

  const pickSessionAgent = (agentId: string) => {
    const chat = workspaceRef.current.chats.find(
      (candidate) => candidate.localId === workspaceRef.current.activeChatId,
    );
    if (!chat) return;
    if (chat.sessionId) {
      updateSession.mutate(
        { sessionId: chat.sessionId, agentId },
        {
          // Its first turn bound another harness since the picker read the
          // chat (ADR 0214): the agent gets the new chat the picker offers
          // now, beside this one, and the refusal is no error to show.
          onError: (error) => {
            const details = error.details;
            if (
              typeof details === "object" &&
              details !== null &&
              "code" in details &&
              details.code === "harness_fixed"
            ) {
              updateSession.reset();
              startChatWithAgent(agentId, chat);
            }
          },
        },
      );
      return;
    }
    // No session yet: remember the choice; lazy creation sends it along.
    updateWorkspace((ws) => ({
      ...ws,
      chats: ws.chats.map((candidate) =>
        candidate.localId === chat.localId
          ? { ...candidate, agentId, model: undefined }
          : candidate,
      ),
    }));
  };

  /**
   * A new chat with this agent, where the chat it was picked for is (the
   * focused one unless named): the agent runs on another harness than that
   * chat, which keeps its own (ADR 0214, lib/agent-switch).
   */
  const startChatWithAgent = (
    agentId: string,
    from = workspaceRef.current.chats.find(
      (candidate) => candidate.localId === workspaceRef.current.activeChatId,
    ),
  ) => {
    addChat(from?.mode === "tab" ? "tab" : undefined, {
      agentId,
      incognito: from?.incognito,
      // Picked for a floating chat, it floats beside it.
      inNewTab: from?.mode !== "partial",
    });
  };

  /** Change the focused session's model override, or the default agent config. */
  const pickModel = (agentId: string, model: string) => {
    const chat = workspaceRef.current.chats.find(
      (candidate) => candidate.localId === workspaceRef.current.activeChatId,
    );
    if (chat?.sessionId) {
      updateSession.mutate({ sessionId: chat.sessionId, model: model || null });
      return;
    }
    if (chat) {
      updateWorkspace((ws) => ({
        ...ws,
        chats: ws.chats.map((candidate) =>
          candidate.localId === chat.localId
            ? { ...candidate, model: model || undefined }
            : candidate,
        ),
      }));
      return;
    }
    void desktopApi.agentsUpdate(agentId, { model });
  };

  // Project agents (ADR 0050): picking one that isn't approved (or whose
  // approval went stale after a definition change) routes through the
  // consent dialog first; secret-credentialed and already-approved ones
  // switch immediately, exactly like profile agents.
  const [consentRequest, setConsentRequest] = useState<{
    agent: ProjectAgentInfo;
    target: ProjectAgentTarget;
  } | null>(null);
  const applyProjectAgent = (
    agent: ProjectAgentInfo,
    target: ProjectAgentTarget,
  ) => {
    if (target === "default") pickDefaultAgent(agent.id);
    else if (target === "chat") startChatWithAgent(agent.id);
    else pickSessionAgent(agent.id);
  };
  const pickProjectAgent = (
    agent: ProjectAgentInfo,
    target: ProjectAgentTarget,
  ) => {
    if (agent.invalid) return;
    if (agent.consent === "ok" || agent.consent === "not-required") {
      applyProjectAgent(agent, target);
      return;
    }
    setConsentRequest({ agent, target });
  };

  const pickEffort = (effort: AgentEffort | null) => {
    const chat = workspaceRef.current.chats.find(
      (candidate) => candidate.localId === workspaceRef.current.activeChatId,
    );
    if (chat?.sessionId) {
      updateSession.mutate({ sessionId: chat.sessionId, effort });
      return;
    }
    if (chat) {
      updateWorkspace((ws) => ({
        ...ws,
        chats: ws.chats.map((candidate) =>
          candidate.localId === chat.localId
            ? { ...candidate, effort: effort ?? undefined }
            : candidate,
        ),
      }));
      return;
    }
    // No focused session: the effort applies to the effective default
    // agent (the one the picker showed as current). A committed project
    // agent's effort lives in its definition file — not editable here.
    const targetId = effectiveDefaultAgentId;
    if (
      effort &&
      targetId &&
      agentsData?.agents.some((agent) => agent.id === targetId)
    ) {
      void desktopApi.agentsUpdate(targetId, { effort });
    }
  };

  /**
   * Change a profile agent's harness permission mode (ADR 0182). It is the
   * agent's setting, so every chat with that agent runs its next turn so.
   */
  const pickHarnessPermissions = (
    agentId: string,
    patch: HarnessPermissions,
  ) => {
    const agent = agentsData?.agents.find(
      (candidate) => candidate.id === agentId,
    );
    if (!agent) return;
    void desktopApi.agentsUpdate(agentId, {
      harnessPermissions: { ...agent.harnessPermissions, ...patch },
    });
  };

  // One handler per registry action (shared/actions.ts). Consumed by the
  // shortcut dispatcher below AND the palette's action rows, so a key
  // press and a palette pick always do the same thing. Rebuilt per render
  // (closures over fresh state), read through a ref by the listeners.
  // Keyboard tab cycling, and an agent's open or close, nudge the content
  // pane in from the direction of travel (see styles.css pane-in-*).
  // Cleared on animationend; the null-then-rAF dance restarts the keyframe
  // on rapid consecutive cycles.
  const [paneMotion, setPaneMotion] = useState<{
    direction: "left" | "right";
    nonce: number;
  } | null>(null);
  const paneMotionNonce = useRef(0);
  const playPaneMotion = (direction: "left" | "right") => {
    paneMotionNonce.current += 1;
    const nonce = paneMotionNonce.current;
    setPaneMotion(null);
    requestAnimationFrame(() => {
      if (paneMotionNonce.current === nonce) {
        setPaneMotion({ direction, nonce });
      }
    });
  };
  // An agent's open or close waiting for its commit: the strip it left,
  // the tab that was in front and the one it brings. The side it arrives
  // from is read from the strip as committed, where a new tab landed in
  // its kind's place. Stale after a second, should its commit never come.
  const agentArrival = useRef<(AgentArrival & { until: number }) | null>(null);
  const playArrival = (arrival: AgentArrival, after: Workspace) => {
    const direction = stripTravel(
      arrival.strip,
      orderedTabKeys(after, { includeCollapsed: true }),
      arrival.from,
      arrival.to,
    );
    if (direction) playPaneMotion(direction);
  };
  const awaitArrival = (arrival: AgentArrival) => {
    agentArrival.current = null;
    // Committed already: read it now.
    if (workspaceRef.current.activeTabKey === arrival.to) {
      playArrival(arrival, workspaceRef.current);
      return;
    }
    agentArrival.current = { ...arrival, until: performance.now() + 1000 };
  };
  const awaitArrivalRef = useRef(awaitArrival);
  awaitArrivalRef.current = awaitArrival;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the commit that brings the awaited tab in front is the only trigger
  useLayoutEffect(() => {
    const arrival = agentArrival.current;
    if (!arrival || workspace.activeTabKey !== arrival.to) return;
    agentArrival.current = null;
    if (performance.now() <= arrival.until) playArrival(arrival, workspace);
  }, [workspace.activeTabKey]);

  const cycleTab = (direction: -1 | 1) => {
    const ws = workspaceRef.current;
    const keys = orderedTabKeys(ws);
    if (keys.length < 2) return;
    const index = keys.indexOf(ws.activeTabKey ?? "");
    const next =
      index === -1
        ? direction === 1
          ? keys[0]
          : keys.at(-1)
        : keys[(index + direction + keys.length) % keys.length];
    if (!next || next === ws.activeTabKey) return;
    playPaneMotion(direction === 1 ? "right" : "left");
    // Cycling walks single tabs — it exits a split rather than churning
    // one of its panes.
    updateWorkspace((current) =>
      transitionWorkspace(current, { type: "focus", key: next }),
    );
  };

  // Cmd+\ pairs the active tab with the previously focused one — track a
  // one-deep focus history for that.
  const previousActiveTabKeyRef = useRef<string | undefined>(undefined);
  const lastActiveTabKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const current = workspace.activeTabKey;
    if (current !== lastActiveTabKeyRef.current) {
      previousActiveTabKeyRef.current = lastActiveTabKeyRef.current;
      lastActiveTabKeyRef.current = current;
    }
  });

  /** Cmd+\: tile the active tab beside the previously focused one. */
  const toggleSplit = () => {
    const ws = workspaceRef.current;
    const keys = orderedTabKeys(ws);
    const active = ws.activeTabKey;
    if (!active || !keys.includes(active)) return;
    if (
      ws.split &&
      (active === ws.split.leftKey || active === ws.split.rightKey)
    ) {
      updateWorkspace((current) => ({ ...current, split: null }));
      return;
    }
    const previous = previousActiveTabKeyRef.current;
    const partner =
      previous && previous !== active && keys.includes(previous)
        ? previous
        : keys.find((key) => key !== active);
    if (!partner) return;
    updateWorkspace((current) => ({
      ...current,
      split: { leftKey: active, rightKey: partner, ratio: 0.5 },
    }));
  };

  /** User claims an agent-driven surface; the agent is told on its next
      action and may reclaim or move on. */
  const takeOverSurface = (key: string) => {
    desktopApi.bridgeTakeover(key);
    updateWorkspace((ws) => ({
      ...ws,
      browsers: ws.browsers.map((b) =>
        browserTabKey(b.localId) === key ? { ...b, agentControlled: false } : b,
      ),
      terminals: ws.terminals.map((t) =>
        terminalTabKey(t.localId) === key
          ? { ...t, agentControlled: false }
          : t,
      ),
    }));
  };

  /** Fold/unfold a chat's attached tabs under its tab in the strip. */
  const toggleChatGroup = (chatLocalId: string) =>
    updateWorkspace((ws) => {
      const chat = ws.chats.find(
        (candidate) => candidate.localId === chatLocalId,
      );
      if (!chat) return ws;
      const collapsing = !chat.surfacesCollapsed;
      // Folding away the active tab lands focus on the group's chat.
      const activeTabKey =
        collapsing &&
        ws.activeTabKey &&
        attachedTabKeys(ws, chatLocalId).includes(ws.activeTabKey)
          ? chatTabKey(chatLocalId)
          : ws.activeTabKey;
      return {
        ...ws,
        activeTabKey,
        chats: ws.chats.map((candidate) =>
          candidate.localId === chatLocalId
            ? { ...candidate, surfacesCollapsed: collapsing }
            : candidate,
        ),
      };
    });

  /** Drag-reorder: move a tab before another (null = to the end). */
  const reorderTab = (key: string, beforeKey: string | null) =>
    updateWorkspace((ws) =>
      transitionWorkspace(ws, { type: "reorder", key, beforeKey }),
    );

  /** Drop a dragged tab onto a side of the content area: tile it there. */
  const dropTabToSide = (key: string, side: "left" | "right") => {
    const ws = workspaceRef.current;
    const anchor =
      ws.activeTabKey && ws.activeTabKey !== key
        ? ws.activeTabKey
        : (previousActiveTabKeyRef.current ?? null);
    if (!anchor || anchor === key || !orderedTabKeys(ws).includes(anchor)) {
      return;
    }
    updateWorkspace((current) =>
      transitionWorkspace(current, {
        type: "side",
        key,
        previous: anchor,
        side,
      }),
    );
  };

  // Agent pointers: elements the agent is pointing the user at (subtle
  // glow + scroll). Each lasts until the user interacts with its element
  // or the agent replaces/clears it.
  const [agentPointers, setAgentPointers] = useState<AgentPointer[]>([]);
  const setAgentPointersRef = useRef(setAgentPointers);
  setAgentPointersRef.current = setAgentPointers;
  const dismissPointer = useCallback(
    (target: string) =>
      setAgentPointers((current) =>
        current.filter((pointer) => pointer.target !== target),
      ),
    [],
  );

  // Pending MCP elicitation (a connector asking the user a form or to open
  // a URL). Queue concurrent native tool requests so none is lost.
  const [elicitations, setElicitation] = useState<PendingElicitation[]>([]);
  const setElicitationRef = useRef(setElicitation);
  setElicitationRef.current = setElicitation;
  // The site whose settings modal is open by hand (gear, palette, Sites
  // row); page permission requests show the same modal on their own.
  const [siteSettingsOrigin, setSiteSettingsOrigin] = useState<string | null>(
    null,
  );

  // Pending request_connection from an agent: the connectors modal opens
  // seeded with the agent's query; closing it settles the tool call with
  // whatever got installed meanwhile (diffed by connection id), and a
  // fresh install queues a continuation message into the asking chat.
  const [connectorRequest, setConnectorRequest] = useState<{
    query: string;
    reason?: string;
    sessionId: string;
    before: Set<string>;
    resolve: (result: { installed: string[] }) => void;
  } | null>(null);
  const setConnectorRequestRef = useRef(setConnectorRequest);
  setConnectorRequestRef.current = setConnectorRequest;

  // Settle a pending request_connection when the connectors modal closes:
  // the diff of connection ids is what the user actually installed, and a
  // fresh install queues a continuation into the asking chat — the send
  // waits behind the in-flight turn, and by the time it dispatches the
  // provider has rebuilt with the new MCP surface (its cache key covers
  // connections), so the next turn runs with the connector mounted.
  const finalizeConnectorRequest = async () => {
    const request = connectorRequest;
    if (!request) return;
    const after = await desktopApi.connectionsList().catch(() => []);
    const installed = after
      .filter((connection) => !request.before.has(connection.id))
      .map((connection) => connection.name);
    request.resolve({ installed });
    if (installed.length === 0) return;
    const chat = workspaceRef.current.chats.find(
      (entry) => entry.sessionId === request.sessionId,
    );
    const send = chat ? chatSendersRef.current.get(chat.localId) : undefined;
    send?.(`The ${installed.join(", ")} connection is now set up — continue.`);
  };

  // The tab being dragged from the strip (drop targets render while set).
  const [tabDragKey, setTabDragKey] = useState<string | null>(null);
  const [dropSideHover, setDropSideHover] = useState<"left" | "right" | null>(
    null,
  );

  // Divider drag: ratio updates live; the overlay keeps webviews from
  // swallowing the mousemoves.
  const [dividerDragging, setDividerDragging] = useState(false);
  const startDividerDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const region = event.currentTarget.parentElement;
    if (!region) return;
    const rect = region.getBoundingClientRect();
    setDividerDragging(true);
    const onMove = (move: globalThis.MouseEvent) => {
      const ratio = Math.min(
        0.8,
        Math.max(0.2, (move.clientX - rect.left) / rect.width),
      );
      updateWorkspace((ws) =>
        ws.split ? { ...ws, split: { ...ws.split, ratio } } : ws,
      );
    };
    const onUp = () => {
      setDividerDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /**
   * Open an attached surface: "tab" focuses it full-width; "split" tiles
   * it to the right of whatever the view shows now, and focuses it.
   *
   * Un-siding from a split is two-phase: tween the ratio to the pane's
   * edge (the pane edges transition, so this reads as the pane growing
   * across while its neighbor squeezes away), then drop the split once
   * the tween lands.
   */
  const unsplitTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(unsplitTimerRef.current), []);
  const removeSurface = (key: string) => {
    if (key.startsWith("terminal:")) {
      const localId = key.slice("terminal:".length);
      const terminal = workspaceRef.current.terminals.find(
        (candidate) => candidate.localId === localId,
      );
      const sessionId = terminal?.attachSessionId ?? terminal?.ptySessionId;
      if (sessionId) void desktopApi.terminalKill(sessionId);
    }
    // The person's own removal from the chat: the page is asked first.
    closeTab(key, { force: true });
  };

  const openSurface = (key: string, requestedMode: CommitMode | "split") => {
    const mode =
      requestedMode === "side"
        ? "split"
        : requestedMode === "replace"
          ? "tab"
          : requestedMode;
    // Opening a surface answers any attention its chip was holding
    // (open_surface-in-background) — dismissal-by-interaction.
    setChipAttention((current) => {
      if (!Object.values(current).some((keys) => keys.includes(key))) {
        return current;
      }
      return Object.fromEntries(
        Object.entries(current).map(([chatId, keys]) => [
          chatId,
          keys.filter((candidate) => candidate !== key),
        ]),
      );
    });
    if (key.startsWith("session:")) {
      const session = sessionsById.get(key.slice("session:".length));
      if (session) openSession(session, requestedMode);
      return;
    }
    if (requestedMode === "floating") {
      if (workspaceRef.current.floatingKey !== key) floatSurface(key);
      return;
    }
    const current = workspaceRef.current;
    if (
      mode === "tab" &&
      current.split &&
      (key === current.split.leftKey || key === current.split.rightKey)
    ) {
      const expandingSplit = {
        ...current.split,
        ratio: key === current.split.leftKey ? 1 : 0,
      };
      updateWorkspace((ws) => ({
        ...ws,
        activeTabKey: key,
        split: expandingSplit,
      }));
      window.clearTimeout(unsplitTimerRef.current);
      unsplitTimerRef.current = window.setTimeout(() => {
        // A later navigation, close, resize, or project restoration owns its
        // layout. An old animation must never bring its former pane back.
        updateWorkspace((ws) =>
          transitionWorkspace(ws, {
            type: "finish-expansion",
            key,
            split: expandingSplit,
          }),
        );
      }, 220);
      return;
    }
    updateWorkspace((ws) =>
      transitionWorkspace(ws, {
        type: mode === "tab" ? "focus" : "side",
        key,
        previous: previousActiveTabKeyRef.current,
      }),
    );
  };
  // An agent showing a surface places it as a press on its chip would.
  const openSurfaceRef = useRef(openSurface);
  openSurfaceRef.current = openSurface;

  // Cmd+, / Cmd+. walk the non-tab chats in bubble-strip order, showing
  // each as the floating dock (the docks' own expand/collapse motion
  // narrates the swap).
  const cycleChat = (direction: -1 | 1) =>
    updateWorkspace((ws) =>
      transitionWorkspace(ws, { type: "cycle-chat", direction }),
    );

  // Cmd+M / Cmd+Shift+M act on the active chat, falling back to the most
  // recent one — so restoring works even when no chat surface is focused.
  const actionChat = (ws: Workspace) =>
    ws.chats.find((chat) => chat.localId === ws.activeChatId) ??
    ws.chats.at(-1);
  // Talk to this chat (voice): the chat in front, for its shortcut.
  const frontChatSession = actionChat(workspace)?.sessionId ?? null;
  useEffect(() => {
    desktopApi.voiceFrontChat(
      projectId && frontChatSession
        ? { projectId, sessionId: frontChatSession }
        : null,
    );
  }, [projectId, frontChatSession]);

  const toggleChatMinimized = () => {
    const ws = workspaceRef.current;
    const chat = actionChat(ws);
    if (!chat) return;
    // Minimizing the focused fullscreen chat tab goes through the dock's
    // staged minimize (collapse tween, THEN the mode flip) so Cmd+M reads
    // exactly like the dash control. Everything else keeps the toggle.
    const focusedTab =
      chat.mode === "tab" &&
      ws.activeChatId === chat.localId &&
      ws.activeTabKey === chatTabKey(chat.localId);
    const staged = chatMinimizersRef.current.get(chat.localId);
    if (focusedTab && staged) {
      staged();
      return;
    }
    toggleChat(chat.localId);
  };

  const expandChatToTab = () => {
    const chat = actionChat(workspaceRef.current);
    if (!chat) return;
    updateWorkspace((ws) => ({
      ...ws,
      activeChatId: chat.localId,
      activeTabKey: chatTabKey(chat.localId),
      chats: ws.chats.map((candidate) =>
        candidate.localId === chat.localId
          ? { ...candidate, mode: "tab" }
          : candidate,
      ),
    }));
  };

  const floatSurface = (key: string) => {
    if (workspaceRef.current.floatingKey === key) {
      dismissFloating();
      return;
    }
    updateWorkspace((ws) =>
      transitionWorkspace(ws, {
        type: "float",
        key,
        previous: previousActiveTabKeyRef.current,
      }),
    );
  };

  /** An open tab, from a list (the palette's tab rows): opened the way asked. */
  const focusTab = (key: string, mode?: CommitMode) => {
    // A page's tab asked to open in a new tab (a New Tab's palette, Cmd+Enter,
    // "Open in new tab") opens the page again there, as the person asked.
    const page =
      mode === "tab"
        ? workspaceRef.current.browsers.find(
            (browser) => browserTabKey(browser.localId) === key,
          )
        : undefined;
    const pageUrl = page ? page.url || page.initialUrl : "";
    if (/^https?:/i.test(pageUrl)) {
      openBrowserTab(pageUrl);
      return;
    }
    if (mode === "floating") {
      if (workspaceRef.current.floatingKey !== key) floatSurface(key);
      return;
    }
    if (mode === "side") {
      dropTabToSide(key, "right");
      return;
    }
    // As a click on the tab strip: a split keeps its panes.
    updateWorkspace((ws) => transitionWorkspace(ws, { type: "select", key }));
  };

  const toggleFloatingTerminal = () => {
    const existing = workspaceRef.current.terminals.find(
      (terminal) => terminal.floatingTool === "terminal",
    );
    if (existing) floatSurface(terminalTabKey(existing.localId));
    else openTerminalTab({ floatingTool: "terminal" });
  };

  const runTerminalMacro = (macro: TerminalMacro, mode?: CommitMode) => {
    const existing = workspaceRef.current.terminals.find(
      (terminal) => terminal.macroId === macro.id,
    );
    if (existing) {
      const key = terminalTabKey(existing.localId);
      if (mode === undefined) floatSurface(key);
      else if (mode === "floating") {
        if (workspaceRef.current.floatingKey !== key) floatSurface(key);
      } else openSurface(key, mode === "side" ? "split" : "tab");
    } else
      openTerminalTab({
        macroId: macro.id,
        title: macro.name,
        initialCommand: macro.command,
        floating: mode === undefined || mode === "floating",
        side: mode === "side",
      });
  };
  const runTerminalMacroRef = useRef(runTerminalMacro);
  runTerminalMacroRef.current = runTerminalMacro;

  /** The page a browser command acts on: the one a key came from, else the one in front. */
  const commandBrowserId = () => {
    const ws = workspaceRef.current;
    // The browser pane holding focus (its find bar, its page), else the one
    // in front: a split's other pane may be the active one.
    const focused = document.activeElement?.closest<HTMLElement>(
      '[data-surface-key^="browser:"]',
    )?.dataset.surfaceKey;
    const key = focused ?? ws.floatingKey ?? ws.activeTabKey;
    return (
      browserShortcutTargetRef.current ??
      (key?.startsWith("browser:") ? key.slice(8) : undefined)
    );
  };
  const runBrowserCommand = (command: keyof BrowserCommands) => {
    const browserId = commandBrowserId();
    if (browserId) browserCommandsRef.current.get(browserId)?.[command]();
  };
  const actionHandlers: Record<ActionId, (mode?: CommitMode) => void> = {
    "submit-pr-comment": () => {
      const form = document.activeElement?.closest("form[data-pr-comment]");
      if (form instanceof HTMLFormElement) form.requestSubmit();
    },
    "open-settings": () =>
      openTab({ kind: "settings", name: "settings", label: "Settings" }),
    "search-files": () => focusSearch("search-files", "files"),
    "search-content": () => focusSearch("search-content", "content"),
    // Find in what is in front: a page's find bar, else a diff's search.
    find: () => {
      if (commandBrowserId()) runBrowserCommand("find");
      else {
        const target = findSearchTarget(workspaceRef.current.activeTabKey);
        if (target) activateSearch(target);
      }
    },
    "find-next": () => runBrowserCommand("findNext"),
    "find-previous": () => runBrowserCommand("findPrevious"),
    // A diff's own search when one is in front, else the project's changes
    // in the palette, from work:git (ADR 0234).
    "search-changes": () => {
      const input = findSearchInput("search-changes");
      if (input) {
        input.focus();
        input.select();
        return;
      }
      if (!projectId || memberShell) return;
      setModeRequest({
        mode: "section",
        label: "Changes",
        load: (signal) =>
          loadSourceRows({
            sources: workSources,
            source: "git",
            projectId,
            signal,
            onError: setLinkError,
          }),
        nonce: crypto.randomUUID(),
      });
      setPaletteOpen(true);
    },
    "new-workflow": (mode) =>
      sendToAgent(NEW_WORKFLOW_PROMPT, mode === "tab" ? "tab" : "float"),
    "server-members": () => setServerDialog("members"),
    "server-secrets": () => setServerDialog("secrets"),
    "server-connections": () => setServerDialog("connections"),
    "search-settings": settingsSearch,
    "browser-focus-address": () => runBrowserCommand("focusAddress"),
    "browser-reload": () => runBrowserCommand("reload"),
    "browser-reload-hard": () => runBrowserCommand("reloadIgnoringCache"),
    "browser-back": () => runBrowserCommand("back"),
    "browser-forward": () => runBrowserCommand("forward"),
    "new-tab": openPaletteTab,
    "command-palette": () => setPaletteOpen((value) => !value),
    "check-for-updates": () => void desktopApi.updateCheck(),
    "new-floating-chat": () => addChat(),
    "toggle-floating-terminal": () => toggleFloatingTerminal(),
    "new-floating-browser": () => openBrowserTab("", { floating: true }),
    "open-floating-settings": () => {
      updateWorkspace((ws) =>
        ws.tabs.some((tab) => tab.kind === "settings")
          ? ws
          : {
              ...ws,
              tabs: [
                ...ws.tabs,
                { kind: "settings", name: "settings", label: "Settings" },
              ],
            },
      );
      floatSurface("settings:settings");
    },
    "dismiss-floating": dismissFloating,
    "floating-to-tab": () => {
      const key = workspaceRef.current.floatingKey;
      if (key) openSurface(key, "tab");
    },
    "floating-to-split": () => {
      const key = workspaceRef.current.floatingKey;
      if (key) openSurface(key, "split");
    },
    // Policy-gated (ADR 0062): hidden from the palette when the project
    // committed allowIncognito: false; the handler double-checks.
    "new-worktree-chat": () => {
      // Connected projects' chats run on their server (ADR 0098).
      if (worktreesAvailable && remoteSurfaceStatus === null)
        addChat(undefined, { worktree: true });
    },
    "new-incognito-chat": () => {
      if (incognitoAllowed) addChat(undefined, { incognito: true });
    },
    "toggle-chat-minimized": toggleChatMinimized,
    "focus-chips": () => {
      const ws = workspaceRef.current;
      const chat = actionChat(ws);
      if (!chat) return;
      // A chat out of view comes back; its dock focuses the first chip as
      // it opens.
      if (
        chat.mode === "min" ||
        (chat.mode === "tab" && ws.activeTabKey !== chatTabKey(chat.localId))
      )
        revealChat(chat.localId);
      chipFocusersRef.current.get(chat.localId)?.();
    },
    "chat-to-tab": expandChatToTab,
    "prev-chat": () => cycleChat(-1),
    "next-chat": () => cycleChat(1),
    "prev-tab": () => cycleTab(-1),
    "next-tab": () => cycleTab(1),
    "split-view": toggleSplit,
    "new-browser-tab": (mode) =>
      openBrowserTab("", {
        side: mode === "side",
        floating: mode === "floating",
      }),
    "reopen-tab": reopenTab,
    "new-terminal-tab": (mode) =>
      openTerminalTab({ side: mode === "side", floating: mode === "floating" }),
    "new-editor-tab": (mode) =>
      openEditorTab({ side: mode === "side", floating: mode === "floating" }),
    "toggle-right-sidebar": () => {
      const open = !rightSidebarOpen;
      if (open) setRightSidebarFocusRequest((count) => count + 1);
      if (rightSidebarHasContent) {
        setSavedRightSidebarOpen(open);
        void desktopApi.setPrefs({ rightSidebarOpen: open });
      } else {
        setEmptyRightSidebar({ scope: sidebarScope, open });
      }
    },
    "toggle-sidebar": () => {
      const open = !sidebarOpen;
      if (open) setSidebarFocusRequest((count) => count + 1);
      setSidebarOpen(open);
      void desktopApi.setPrefs({ sidebarOpen: open });
    },
    "close-tab": closeActiveSurface,
    "setup-agent": () => setWizardModalOpen(true),
    "default-agent": () => openPalettePicker("default-agent"),
    "change-assistant": () => openPalettePicker("assistant"),
    "session-status": () => {
      const chat = actionChat(workspaceRef.current);
      if (!chat) return;
      revealChat(chat.localId);
      setSessionInspectRequests((current) => ({
        ...current,
        [chat.localId]: (current[chat.localId] ?? 0) + 1,
      }));
    },
    "archive-chat": () => {
      // The chat the palette targets: the focused one, as Status does.
      const chat = actionChat(workspaceRef.current);
      if (chat?.sessionId) applySessionAction(chat.sessionId, "archive");
    },
    "rename-chat": () => {
      const chat = actionChat(workspaceRef.current);
      if (chat?.sessionId) applySessionAction(chat.sessionId, "rename");
    },
    "switch-agent": () => openPalettePicker("switch-agent"),
    "configure-agent": () => openPalettePicker("configure-agent"),
    "change-effort": () => openPalettePicker("effort"),
    "change-permission-mode": () => openPalettePicker("permission-mode"),
    "switch-model": () => openPalettePicker("model"),
    "manage-connectors": () => setConnectorsModalOpen(true),
    "connect-remote-project": () =>
      setRemoteConnect({ open: true, link: null }),
    // Capture the focused chat NOW: the QR should land the phone in the
    // exact conversation that was on screen when the action ran.
    "remote-environment": () => {
      if (remoteSurfaceStatus) setRemoteEnvironmentOpen(true);
    },
    "open-chat-terminal": () => {
      const chat = actionChat(workspaceRef.current);
      if (chat?.sessionId) openChatTerminal(chat.sessionId);
    },
    "open-chat-preview": () => {
      const chat = actionChat(workspaceRef.current);
      if (chat?.sessionId) askChatPreview(chat.sessionId);
    },
    // Voice's shortcuts from the palette are taps: on, or off. Their keys
    // never come here: the main process reads them, to hear them held.
    dictate: () => void voiceTap({ action: "dictate", projectId }),
    "talk-to-work": () => void voiceTap({ action: "talk-to-work", projectId }),
    // With no chat to talk to, voice says so, as for its keys.
    "talk-to-chat": () => {
      const sessionId = actionChat(workspaceRef.current)?.sessionId;
      void voiceTap({
        action: "talk-to-chat",
        projectId,
        ...(sessionId ? { sessionId } : {}),
      });
    },
    "continue-on-mobile": () =>
      setMobilePairing({
        open: true,
        context: {
          ...(projectId ? { projectId } : {}),
          ...(focusedChat?.sessionId
            ? { sessionId: focusedChat.sessionId }
            : {}),
        },
      }),
  };
  const commandBrowserIdRef = useRef(commandBrowserId);
  commandBrowserIdRef.current = commandBrowserId;
  const actionHandlersRef = useRef(actionHandlers);
  actionHandlersRef.current = actionHandlers;

  // User-configurable window-level shortcuts (close-tab also arrives from
  // the app menu as a close-surface event).
  const keybindings = useKeybindings();
  const keybindingsRef = useRef(keybindings);
  keybindingsRef.current = keybindings;
  useEffect(() => {
    // Returns true when the key matched an app shortcut. Also fed by
    // guest-key forwarding: shortcuts pressed inside webview page content
    // never reach this window, so main relays them (see main/browser.ts).
    const dispatchShortcut = (
      event: {
        key: string;
        code?: string;
        metaKey: boolean;
        ctrlKey: boolean;
        altKey: boolean;
        shiftKey: boolean;
      },
      guestId?: number,
    ): boolean => {
      const bindings = keybindingsRef.current;
      const action = KEYBINDING_ACTIONS.find(
        (candidate) =>
          (candidate !== "submit-pr-comment" ||
            (guestId === undefined &&
              Boolean(
                document.activeElement?.closest("form[data-pr-comment]"),
              ))) &&
          (candidate !== "search-changes" ||
            (guestId === undefined &&
              (Boolean(findSearchInput(candidate)) ||
                (Boolean(projectIdRef.current) && !memberShellRef.current)))) &&
          // Find belongs to a page (a key from it, or one in front) or a
          // diff's search; elsewhere the key stays with what is focused (an
          // editor's own find).
          (!PAGE_FIRST_ACTIONS.has(candidate) ||
            guestId !== undefined ||
            commandBrowserIdRef.current() !== undefined ||
            // Matched first: looking for a search on every key costs.
            (candidate === "find" &&
              matchesBinding(event, bindings[candidate]) &&
              Boolean(findSearchTarget(workspaceRef.current.activeTabKey)))) &&
          // A text field keeps its caret keys (Cmd+Left and Cmd+Right go to
          // the line's start and end), whatever they are bound to.
          !(
            guestId === undefined &&
            fieldKeepsKey({
              event,
              focused: document.activeElement,
              mac: /Mac/.test(navigator.platform),
            })
          ) &&
          (candidate !== "dismiss-floating" ||
            (floatingEscapeEnabledRef.current &&
              ![
                ...document.querySelectorAll(
                  '[role="dialog"], [role="alertdialog"], [role="menu"]',
                ),
              ].some(
                (element) =>
                  !element.closest("[inert]") &&
                  element.checkVisibility({
                    checkOpacity: true,
                    checkVisibilityCSS: true,
                  }),
              ))) &&
          matchesBinding(event, bindings[candidate]),
      );
      const macro = prefsRef.current?.terminalMacros.find((candidate) =>
        matchesBinding(event, candidate.shortcut),
      );
      if (!action && !macro) return false;
      browserShortcutTargetRef.current =
        guestId === undefined
          ? undefined
          : [...browserGuestIdsRef.current].find(
              ([, id]) => id === guestId,
            )?.[0];
      try {
        // Voice's keys are the main process's, held or tapped (ADR 0236).
        if (action && isVoiceAction(action)) return true;
        if (action) actionHandlersRef.current[action]();
        else if (macro) runTerminalMacroRef.current(macro);
      } finally {
        browserShortcutTargetRef.current = undefined;
      }
      return true;
    };

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // Ghostty marks intercepted app shortcuts handled to suppress PTY input,
      // then deliberately bubbles them to this dispatcher.
      if (
        event.defaultPrevented &&
        !(
          event.target instanceof Element &&
          event.target.closest("[data-terminal-appearance]")
        )
      )
        return;
      // Terminal editors may prevent the native key while deliberately
      // bubbling a bound application shortcut.
      if (!visibleRef.current) return;
      if (dispatchShortcut(event)) {
        event.preventDefault();
        return;
      }
      // Desktop feel: Cmd+A means "select all of what I'm editing", never
      // "select every label on screen". Outside editable fields (inputs,
      // the terminal's contenteditable, Monaco's textarea) it is a no-op.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "a"
      ) {
        const active = document.activeElement as HTMLElement | null;
        const editable =
          active &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.isContentEditable);
        if (!editable) event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const unsubscribeGuestKeys = desktopApi.onBrowserGuestKey((key) => {
      // A key pressed inside a page is the person's input too.
      notePersonInput();
      return (
        visibleRef.current &&
        dispatchShortcut(
          {
            key: key.key,
            code: key.code,
            metaKey: key.meta,
            ctrlKey: key.control,
            altKey: key.alt,
            shiftKey: key.shift,
          },
          key.webContentsId,
        )
      );
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unsubscribeGuestKeys();
    };
  }, []);

  const addChatRef = useRef(addChat);
  addChatRef.current = addChat;
  useEffect(
    () =>
      desktopApi.onWorkspaceEvent((event) => {
        if (
          event.kind === "newChat" &&
          event.projectId === projectIdRef.current
        )
          // The dock's own + (attached or detached) starts a chat in the
          // dock, never in the New Tab behind it; Cmd+N it caught for this
          // window is this window's Cmd+N.
          addChatRef.current(undefined, { inNewTab: event.shortcut === true });
      }),
    [],
  );

  const selectProject = (id: string) => {
    void desktopApi.workspaceNavigate({ projectId: id });
    // Remembered per profile: a relaunch lands in the last project.
    void desktopApi.setPrefs({ lastProjectId: id });
  };

  const onProjectDeleted = (deletedId: string) => {
    setDeletingProject(null);
    setWorkspaces(({ [deletedId]: _removed, ...rest }) => rest);
    defaultWorkspacesRef.current.delete(deletedId);
    void desktopApi.profilesReleaseProject(deletedId);
    if (activeProjectId === deletedId) setActiveProjectId(undefined);
  };

  const bootReady =
    profilesData !== null &&
    agentsData !== null &&
    workspaceConfig !== null &&
    !projectsLoading;
  useEffect(() => {
    if (bootRevealed) return;
    if (bootReady) {
      // One frame for the ready layout to commit, then fade the veil.
      const frame = requestAnimationFrame(() => setBootRevealed(true));
      return () => cancelAnimationFrame(frame);
    }
    // Failsafe: a wedged query must never leave the veil up forever.
    const timer = window.setTimeout(() => setBootRevealed(true), 8000);
    return () => window.clearTimeout(timer);
  }, [bootReady, bootRevealed]);

  // --- agent workspace bridge -------------------------------------------
  // Agents' workspace tools land here from main: discovery (overview /
  // readTab), agent-spawned surfaces (browser tabs, terminals), and the
  // control handoff. Every window answers; the ones without this project
  // reply null and main takes the first real answer.
  const chatLabelsRef = useRef<Record<string, string>>({});
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const workspaceConfigRef = useRef<WorkspaceConfig | null>(workspaceConfig);
  workspaceConfigRef.current = visibleWorkspace;
  const activeProfileRef = useRef(activeProfile);
  activeProfileRef.current = activeProfile;

  // Back and forward between surfaces (ADR 0188): each project remembers
  // the places its workspace was at, and the mouse's side buttons walk
  // them, except on a browser, which walks its own pages.
  const surfaceHistoriesRef = useRef(new Map<string, SurfaceHistory>());
  // Set while back or forward moves the workspace, so arriving there
  // settles the entry instead of counting as a new visit.
  const surfaceSteppingRef = useRef(false);
  useEffect(() => {
    if (!projectId) return;
    const histories = surfaceHistoriesRef.current;
    const history = histories.get(projectId) ?? EMPTY_SURFACE_HISTORY;
    const location = surfaceLocation(workspace);
    histories.set(
      projectId,
      surfaceSteppingRef.current
        ? settleSurface(history, location)
        : visitSurface(history, location),
    );
    surfaceSteppingRef.current = false;
  }, [projectId, workspace]);
  const navigateBackForwardRef = useRef(
    (_direction: "back" | "forward", _at: Element | null) => {},
  );
  navigateBackForwardRef.current = (direction, at) => {
    // A dialog takes the press; nothing behind it moves.
    if (at?.closest('[aria-modal="true"]')) return;
    // A press on a browser's page or toolbar walks that browser's pages;
    // anywhere else (a chat, the sidebar, the tab strip) walks surfaces.
    const surface = at?.closest("[data-chat-local-id]")
      ? undefined
      : at?.closest<HTMLElement>("[data-surface-key]")?.dataset.surfaceKey;
    if (surface?.startsWith("browser:")) {
      browserHistoryNavigatorsRef.current.get(
        surface.slice("browser:".length),
      )?.(direction);
      return;
    }
    const id = projectIdRef.current;
    if (!id) return;
    const ws = workspaceRef.current;
    const next = stepSurface(
      surfaceHistoriesRef.current.get(id) ?? EMPTY_SURFACE_HISTORY,
      direction === "back" ? -1 : 1,
      (location) => surfaceChanges(ws, location),
    );
    const target = next?.entries[next.index];
    if (!next || !target) return;
    surfaceHistoriesRef.current.set(id, next);
    surfaceSteppingRef.current = true;
    updateWorkspace((current) => {
      const restored = restoreSurface(current, target);
      // Nothing moved, so no visit follows for the flag to settle.
      if (restored === current) surfaceSteppingRef.current = false;
      return restored;
    });
  };
  useEffect(() => {
    // Windows and Linux report the buttons as app commands (main forwards
    // those); macOS delivers them to the page under the pointer. A web
    // page's own presses stay in its browser tab (the guest preload).
    const onMouseUp = (event: globalThis.MouseEvent) => {
      const direction =
        event.button === 3 ? "back" : event.button === 4 ? "forward" : null;
      if (!direction) return;
      event.preventDefault();
      navigateBackForwardRef.current(
        direction,
        event.target instanceof Element ? event.target : null,
      );
    };
    const mac = /Mac/.test(navigator.platform);
    if (mac) window.addEventListener("mouseup", onMouseUp, true);
    const stop = desktopApi.onBrowserNavigate((command) => {
      // A focused page's own tab takes it (browser-screen).
      if (command.webContentsId !== null) return;
      if (command.gesture === "swipe") {
        // Swiping turns the front browser's pages, as it always has.
        const ws = workspaceRef.current;
        const front = ws.floatingKey ?? ws.activeTabKey;
        if (front?.startsWith("browser:"))
          browserHistoryNavigatorsRef.current.get(
            front.slice("browser:".length),
          )?.(command.direction);
        return;
      }
      navigateBackForwardRef.current(command.direction, document.activeElement);
    });
    return () => {
      if (mac) window.removeEventListener("mouseup", onMouseUp, true);
      stop();
    };
  }, []);
  useEffect(() => {
    /** The chat an agent-spawned surface belongs to: exact session match
        first (the tools carry their chat's session id), then the mid-turn
        heuristic for anything that arrives unattributed. */
    const resolveWorkingChat = (sessionId?: string): string | undefined => {
      const ws = workspaceRef.current;
      if (sessionId) {
        const owner = ws.chats.find((chat) => chat.sessionId === sessionId);
        if (owner) return owner.localId;
      }
      const sending = ws.chats.filter(
        (chat) => signalsRef.current[chat.localId]?.working,
      );
      const preferred =
        sending.find((chat) => chat.localId === ws.activeChatId) ??
        sending.at(-1) ??
        ws.chats.find((chat) => chat.localId === ws.activeChatId);
      return preferred?.localId;
    };

    /** This project's workspace is the one on screen, in a window on screen. */
    const shownHere = () =>
      visibleRef.current && document.visibilityState === "visible";

    /**
     * A floating surface over the view leaves with its paired exit before an
     * agent shows something else, as its close button plays it, and the
     * dismissal commits before this resolves, so the open decides on the
     * view as it now is. It resolves however the surface left: a dismissal
     * already under way, or a newer floating surface, skips this one's
     * finish.
     */
    const leaveFloating = async (keep?: string) => {
      const key = workspaceRef.current.floatingKey;
      if (!key || key === keep) return;
      await floatingMotionRef.current.dismiss(() =>
        flushSync(() =>
          updateWorkspace((current) =>
            transitionWorkspace(current, { type: "dismiss-floating", key }),
          ),
        ),
      );
    };

    /**
     * An agent's open or close that changes the tab in front narrates the
     * swap: the content arrives from that side of the strip (pane-in), where
     * a person's click stays instant. `before` is the workspace before the
     * change; the side is read once the change commits (awaitArrival). A
     * surface already on screen (a split's other pane, the floating one)
     * has nowhere to arrive from. Nothing moves in a workspace or window
     * off screen, or under reduced motion.
     */
    const narrateSwap = (before: Workspace, to: string | undefined) => {
      const from = before.activeTabKey;
      if (!from || !to || from === to || !shownHere()) return;
      if (prefersReducedMotion() || workspaceLayout(before).viewSlots[to])
        return;
      awaitArrivalRef.current({
        strip: orderedTabKeys(before, { includeCollapsed: true }),
        from,
        to,
      });
    };

    /**
     * Why something can't be pointed at: it sits in a closed sidebar (a
     * row, or a tab while tabs live in the sidebar), so its glow would be
     * off screen. A sidebar row not found yet is refused when every
     * sidebar is closed.
     */
    const closedSidebarFor = (target: string): string | undefined => {
      const root =
        document.querySelector(
          `[data-project-runtime="${CSS.escape(projectIdRef.current ?? "")}"]`,
        ) ?? document;
      const element = pointedElement(target, root);
      const row = target.startsWith("sidebar:");
      const holder = element?.closest("aside[data-sidebar]");
      const sidebars = holder
        ? [holder]
        : !element && row
          ? [...root.querySelectorAll("aside[data-sidebar]")]
          : [];
      const onScreen = (sidebar: Element) =>
        ["open", "opening"].includes(sidebar.getAttribute("data-motion") ?? "");
      if (sidebars.length === 0 || sidebars.some(onScreen)) return undefined;
      const name = row ? target.slice("sidebar:".length) : target;
      return `"${name}" is in a closed sidebar, so the person can't see it. Tell them where it is, or ask them to open the sidebar.`;
    };

    const handle = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      if (params.projectId && params.projectId !== projectIdRef.current)
        return null;
      const ws = workspaceRef.current;
      switch (method) {
        case "overview": {
          const keys = orderedTabKeys(ws, { includeCollapsed: true });
          const tabs: Record<string, unknown>[] = keys.map((key) => {
            const base: Record<string, unknown> = {
              key,
              active: key === ws.activeTabKey,
            };
            if (key.startsWith("browser:")) {
              const id = key.slice("browser:".length);
              const entry = ws.browsers.find((b) => b.localId === id);
              return {
                ...base,
                kind: "browser",
                title: entry?.title,
                url: entry?.url,
                agentControlled: entry?.agentControlled ?? false,
              };
            }
            if (key.startsWith("terminal:")) {
              const id = key.slice("terminal:".length);
              const entry = ws.terminals.find((t) => t.localId === id);
              return {
                ...base,
                kind: "terminal",
                title: entry?.title || "Terminal",
                running: entry?.running ?? true,
                // What agents need to target this terminal (run_terminal
                // terminalId) and to know whether it's mid-command.
                terminalId: entry?.attachSessionId ?? entry?.ptySessionId,
                busy: entry?.busy ?? false,
                agentControlled: entry?.agentControlled ?? false,
              };
            }
            if (key.startsWith("editor:")) {
              const id = key.slice("editor:".length);
              const entry = ws.editors.find((e) => e.localId === id);
              // The focused editor's live selection rides along so the
              // agent knows what "this" means without a pill.
              const selection =
                ws.activeTabKey === key ? readEditorSelection() : null;
              return {
                ...base,
                kind: "editor",
                filePath: entry?.filePath,
                ...(selection && selection.filePath === entry?.filePath
                  ? {
                      selection: {
                        text: selection.text,
                        startLine: selection.startLine,
                        endLine: selection.endLine,
                      },
                    }
                  : {}),
              };
            }
            if (key.startsWith("chat:")) {
              const id = key.slice("chat:".length);
              return {
                ...base,
                kind: "chat",
                title: chatLabelsRef.current[id] ?? "Chat",
              };
            }
            if (key.startsWith("diff:")) {
              const entry = ws.tabs.find((t) => tabKey(t) === key);
              return {
                ...base,
                kind: "diff",
                filePath:
                  entry?.kind === "diff" && entry.source.type !== "review"
                    ? entry.source.filePath
                    : undefined,
              };
            }
            const [kind, name] = key.split(":", 2);
            return { ...base, kind, name };
          });
          // Chip-only surfaces own no tab, but the agent must still see
          // them in context. List them after the visible workspace tabs.
          for (const entry of ws.browsers) {
            if (!entry.background) continue;
            tabs.push({
              key: browserTabKey(entry.localId),
              active: false,
              kind: "browser",
              title: entry.title,
              url: entry.url,
              agentControlled: entry.agentControlled ?? false,
              background: true,
            });
          }
          for (const entry of ws.terminals) {
            if (!entry.background) continue;
            tabs.push({
              key: terminalTabKey(entry.localId),
              active: false,
              kind: "terminal",
              title: entry.title || "Terminal",
              running: entry.running ?? true,
              terminalId: entry.attachSessionId ?? entry.ptySessionId,
              busy: entry.busy ?? false,
              agentControlled: entry.agentControlled ?? false,
              background: true,
            });
          }
          for (const entry of ws.editors) {
            if (!entry.background) continue;
            tabs.push({
              key: editorTabKey(entry.localId),
              active: false,
              kind: "editor",
              filePath: entry.filePath,
              background: true,
            });
          }
          const chats = ws.chats.map((chat) => ({
            key: chatTabKey(chat.localId),
            title: chatLabelsRef.current[chat.localId] ?? "Chat",
            state: chat.mode,
            working: Boolean(signalsRef.current[chat.localId]?.working),
            // Lets the context snapshot mark the asking agent's own chat.
            sessionId: chat.sessionId ?? null,
          }));
          const sidebar = sidebarSections(workspaceConfigRef.current).map(
            (section) => ({
              source: section.source,
              title: section.title,
              items: (section.items ?? []).map((item) => ({
                label: item.label,
                url: item.url,
              })),
            }),
          );
          return {
            tabs,
            chats,
            sidebar,
            split: ws.split,
            // What the user looked at before the active tab: when they open
            // a chat as its own tab to ask about "this", it is usually here.
            previousTabKey: previousActiveTabKeyRef.current ?? null,
          };
        }
        case "browserActivity": {
          const key = String(params.key);
          if (!key.startsWith("browser:"))
            return { error: "Expected a browser tab" };
          const id = key.slice("browser:".length);
          if (
            params.active === true &&
            !ws.browsers.some((browser) => browser.localId === id)
          )
            return { error: "Browser tab closed" };
          flushSync(() =>
            setBusyBrowsers((current) => {
              const next = new Set(current);
              if (params.active === true) next.add(id);
              else next.delete(id);
              return next;
            }),
          );
          // Let Chromium attach and lay out the guest before native input/capture.
          if (params.active === true)
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            );
          return { ok: true };
        }
        case "browserGuest": {
          const key = String(params.key);
          const id = key.slice("browser:".length);
          let guestId = browserGuestIdsRef.current.get(id);
          // A sleeping tab wakes for the agent and loads before it acts.
          if (!guestId && tabAsleepRef.current(id)) {
            wakeTab(id);
            const deadline = Date.now() + 10_000;
            while (!guestId && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 150));
              guestId = browserGuestIdsRef.current.get(id);
            }
          }
          return guestId
            ? { guestId }
            : { error: `No live page for ${key} (tab closed or not loaded)` };
        }
        case "terminalId": {
          const key = String(params.key);
          const id = key.slice("terminal:".length);
          const entry = ws.terminals.find((t) => t.localId === id);
          const terminalId = entry?.attachSessionId ?? entry?.ptySessionId;
          return terminalId ? { terminalId } : null;
        }
        case "terminalKey": {
          // Reverse lookup: PTY session → workspace tab key (agent-targeted
          // runs in existing terminals, including the user's own tabs).
          const terminalId = String(params.terminalId);
          const entry = ws.terminals.find(
            (t) =>
              t.attachSessionId === terminalId || t.ptySessionId === terminalId,
          );
          return entry ? { key: terminalTabKey(entry.localId) } : null;
        }
        case "readTab": {
          const key = String(params.key);
          if (key.startsWith("editor:")) {
            const id = key.slice("editor:".length);
            const entry = ws.editors.find((e) => e.localId === id);
            if (!entry) return null;
            const selection =
              ws.activeTabKey === key ? readEditorSelection() : null;
            return {
              kind: "editor",
              filePath: entry.filePath,
              ...(selection && selection.filePath === entry.filePath
                ? {
                    selection: {
                      text: selection.text,
                      startLine: selection.startLine,
                      endLine: selection.endLine,
                    },
                  }
                : {}),
            };
          }
          if (key.startsWith("chat:")) {
            const id = key.slice("chat:".length);
            const chat = ws.chats.find((c) => c.localId === id);
            return chat
              ? {
                  kind: "chat",
                  sessionId: chat.sessionId ?? null,
                  title: chatLabelsRef.current[id] ?? "Chat",
                }
              : null;
          }
          const tab = ws.tabs.find((t) => tabKey(t) === key);
          if (!tab) return null;
          return tab.kind === "diff"
            ? {
                kind: "diff",
                name: tab.name,
                filePath:
                  tab.source.type !== "review"
                    ? tab.source.filePath
                    : undefined,
              }
            : { kind: tab.kind, name: tab.name };
        }
        case "openAgentBrowser": {
          if (!activeProfileRef.current) return { error: "No profile" };
          const localId = crypto.randomUUID();
          const entry: BrowserEntry = {
            localId,
            profileId: activeProfileRef.current.id,
            initialUrl: String(params.url),
            url: String(params.url),
            title: String(params.url),
            faviconUrl: null,
            chatLocalId: resolveWorkingChat(
              typeof params.sessionId === "string"
                ? params.sessionId
                : undefined,
            ),
            agentControlled: true,
          };
          updateWorkspace((current) => ({
            ...current,
            browsers: [...current.browsers, entry],
          }));
          // The guest attaches once the (hidden) webview mounts.
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const guestId = browserGuestIdsRef.current.get(localId);
            if (guestId) return { key: browserTabKey(localId) };
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          // Not the agent's to hold: the tab is the person's.
          updateWorkspace((current) => ({
            ...current,
            browsers: current.browsers.map((browser) =>
              browser.localId === localId
                ? { ...browser, agentControlled: false }
                : browser,
            ),
          }));
          return { error: "The page never finished mounting." };
        }
        case "attachAgentTerminal": {
          const localId = crypto.randomUUID();
          const chatLocalId = resolveWorkingChat(
            typeof params.sessionId === "string" ? params.sessionId : undefined,
          );
          const entry: TerminalEntry = {
            localId,
            title:
              typeof params.title === "string" && params.title
                ? params.title
                : "Agent terminal",
            chatLocalId,
            attachSessionId: String(params.terminalId),
            agentControlled: true,
            running: true,
            // Agent terminals start as chips, not tabs — the user's view
            // doesn't move because an agent ran a command. Without a chat
            // to carry the chip there'd be no way to see it at all, so
            // only then does it open as a (non-focused) tab.
            background: chatLocalId !== undefined,
          };
          updateWorkspace((current) => ({
            ...current,
            terminals: [...current.terminals, entry],
          }));
          return { key: terminalTabKey(localId) };
        }
        case "openTarget": {
          const target = String(params.target ?? "");
          const sessionId =
            typeof params.sessionId === "string" ? params.sessionId : undefined;
          // Who is asking, and is the user watching them? If the
          // requesting chat IS the user's active surface (its tab
          // focused, or its floating dock up), or they are talking with
          // it by voice (ADR 0216), the agent is showing them something:
          // open in front. Otherwise the user is busy elsewhere: never
          // steal their focus. Prepare the tab in the background and
          // light the attention dot on the surface's chip on the agent's
          // own chat; the result tells the agent which of the two
          // happened so it narrates honestly. A target the user is
          // ALREADY looking at counts as watched: nothing to steal.
          // A session named here with no chat in this workspace (a
          // subsession, an automation's chat, a closed chat) is nobody's
          // view: it opens in the background, as a visible tab, unless the
          // person talks with it by voice (the dock's assistant before its
          // chat is opened). The assistant's chat typed to in the dock is
          // one of this workspace's chats. Only the terminal `open` hook,
          // which names no session, borrows the working chat.
          const requesterId = sessionId
            ? ws.chats.find((chat) => chat.sessionId === sessionId)?.localId
            : resolveWorkingChat();
          const requester = ws.chats.find(
            (chat) => chat.localId === requesterId,
          );
          const requesterVisible = requester
            ? chatVisible(ws, requester)
            : false;
          // Only what Work shows opens in front: this project in its
          // window, the window on screen. Nothing here raises a window.
          const shown = shownHere();
          const openInBackground = (key: string) =>
            !agentOpenInFront({
              shown,
              voice: params.voice === true,
              chat: requester
                ? requesterVisible
                  ? "visible"
                  : "hidden"
                : sessionId
                  ? "absent"
                  : "unnamed",
              targetInFront: ws.activeTabKey === key,
            });
          const background = (key: string) => {
            if (requester) {
              setChipAttention((current) => {
                const keys = current[requester.localId] ?? [];
                return keys.includes(key)
                  ? current
                  : { ...current, [requester.localId]: [...keys, key] };
              });
            }
            const chip = requester
              ? " and its chip is highlighted on your chat"
              : "";
            return {
              key,
              opened: "background" as const,
              note: shown
                ? `The user is looking at something else, so the tab is ready in the background${chip}. Tell them it's ready instead of assuming they saw it.`
                : `Work isn't showing this project right now (another project is in front, or its window is hidden), so the tab is ready in the background${chip}. Tell them where it is instead of assuming they saw it.`,
            };
          };
          // A surface kept as a chip waits in the strip when no chat here
          // carries its chip.
          const asTab = (key: string) =>
            updateWorkspace((current) => ({
              ...current,
              browsers: current.browsers.map((browser) =>
                browserTabKey(browser.localId) === key
                  ? { ...browser, background: false }
                  : browser,
              ),
              editors: current.editors.map((editor) =>
                editorTabKey(editor.localId) === key
                  ? { ...editor, background: false }
                  : editor,
              ),
              terminals: current.terminals.map((terminal) =>
                terminalTabKey(terminal.localId) === key
                  ? { ...terminal, background: false }
                  : terminal,
              ),
            }));
          // Shown as a press on the surface's chip shows it: a floating
          // surface over the view leaves with its exit first, then the
          // same placement (openSurface), the content arriving from its
          // side of the strip.
          const show = async (
            keep: string | undefined,
            open: () => string | Promise<string>,
          ) => {
            await leaveFloating(keep);
            const before = workspaceRef.current;
            const key = await open();
            narrateSwap(before, key);
            return key;
          };
          const showTab = (key: string) =>
            show(key, () => {
              openSurfaceRef.current(key, "replace");
              return key;
            });
          // The chat steps down from full tab to its floating dock so the
          // opened tab is visible behind it — the agent is SHOWING the
          // user something, not replacing their view with itself. Only a
          // chat that was on screen: a voice open leaves a chat tab the
          // person wasn't looking at where it was.
          const stepChatAside = () => {
            if (!requesterId || !requesterVisible) return;
            updateWorkspace((current) => ({
              ...current,
              chats: current.chats.map((chat) =>
                chat.localId === requesterId && chat.mode === "tab"
                  ? { ...chat, mode: "partial" }
                  : chat,
              ),
            }));
          };
          const linked = parseSurfaceLink(target);
          if (linked && linked.kind !== "tab") {
            const named =
              linked.kind === "app" || linked.kind === "workflow"
                ? `${linked.kind}:${linked.name}`
                : undefined;
            const backgroundOpen = openInBackground(named ?? "");
            try {
              if (backgroundOpen)
                return background(
                  await openLinkedSurfaceRef.current(target, {
                    chatLocalId: requesterId,
                    background: true,
                  }),
                );
              // A page or file has no key before it opens. What stays on
              // screen follows openLinkedSurface's own reuse: a file already
              // open in an editor opens there; otherwise a floating page,
              // or clean editor, takes it in place, as "open here" does.
              // Anything else floating leaves for it.
              const floating = ws.floatingKey;
              const page =
                linked.kind === "browser" ||
                (linked.kind === "file" && isBrowserFile(linked.path));
              // "Open here" is the asking chat's here. With that chat off
              // screen (voice, the dock's assistant), a page gets a tab of
              // its own rather than replacing the one the person reads.
              const ownTab = page && !requesterVisible;
              const root =
                linked.kind === "file" && !page && projectIdRef.current
                  ? await desktopApi.projectRoot(projectIdRef.current)
                  : null;
              const fileEditor =
                linked.kind === "file" && root !== null
                  ? ws.editors.find(
                      (editor) =>
                        editor.filePath ===
                        resolveProjectFileLocation(root, linked.path)
                          .relativePath,
                    )
                  : undefined;
              const reused =
                floating &&
                (page
                  ? !ownTab && floating.startsWith("browser:")
                  : linked.kind === "file" &&
                    ws.editors.some(
                      (editor) =>
                        editorTabKey(editor.localId) === floating &&
                        !editor.dirty,
                    ));
              const key = await show(
                named ??
                  (fileEditor
                    ? editorTabKey(fileEditor.localId)
                    : reused
                      ? floating
                      : undefined),
                () =>
                  openLinkedSurfaceRef.current(target, {
                    chatLocalId: requesterId,
                    newTab: ownTab,
                  }),
              );
              stepChatAside();
              return { key, opened: "focused" };
            } catch (cause) {
              return {
                error:
                  cause instanceof Error
                    ? cause.message
                    : "Could not open the target",
              };
            }
          }
          // A background agent terminal: open_surface is the agent
          // explicitly SHOWING it — materialize the tab (focused only
          // if the user is watching the agent).
          if (target.startsWith("terminal:")) {
            const localId = target.slice("terminal:".length);
            if (ws.terminals.some((t) => t.localId === localId)) {
              if (openInBackground(target)) {
                asTab(target);
                return background(target);
              }
              await showTab(target);
              stepChatAside();
              return { key: target, opened: "focused" };
            }
          }
          const detachedBrowser = ws.browsers.some(
            (browser) =>
              browserTabKey(browser.localId) === target && browser.background,
          );
          const detachedEditor = ws.editors.some(
            (editor) =>
              editorTabKey(editor.localId) === target && editor.background,
          );
          if (detachedBrowser || detachedEditor) {
            if (openInBackground(target)) {
              if (!requester) asTab(target);
              return background(target);
            }
            await showTab(target);
            stepChatAside();
            return { key: target, opened: "focused" };
          }
          // An existing tab key from workspace_overview: focus it.
          if (
            !orderedTabKeys(ws, { includeCollapsed: true }).includes(target)
          ) {
            return {
              error: `No such target: ${target}. Use a tab key from workspace_overview, "app:<name>", "file:<path>", or a URL.`,
            };
          }
          // The tab already exists; "background" is just not focusing
          // it: the chip's attention dot does the pointing.
          if (openInBackground(target)) return background(target);
          await showTab(target);
          if (!target.startsWith("chat:")) stepChatAside();
          return { key: target, opened: "focused" };
        }
        case "pointAt": {
          const target = String(params.target ?? "").trim();
          if (!target) return { ok: false, error: "Empty target" };
          // A glow in a closed sidebar would point at nothing on screen.
          const closed = closedSidebarFor(target);
          if (closed) return { ok: false, error: closed };
          const note =
            typeof params.note === "string" && params.note.trim()
              ? params.note.trim().slice(0, 60)
              : undefined;
          const keep = params.keepPrevious === true;
          setAgentPointersRef.current((current) => {
            const rest = keep
              ? current.filter((pointer) => pointer.target !== target)
              : [];
            return [...rest, { target, note }];
          });
          return { ok: true };
        }
        case "clearPointers": {
          setAgentPointersRef.current([]);
          return { ok: true };
        }
        case "elicit": {
          // Main routes this to one window, including when the app is unfocused.
          if (!visibleRef.current) return null;
          const request = params.request as
            | PendingElicitation["request"]
            | undefined;
          if (!request || (request.mode !== "form" && request.mode !== "url")) {
            return { action: "decline" };
          }
          const label =
            typeof params.label === "string" ? params.label : undefined;
          // Resolve when the modal answers; the bridge awaits this promise.
          return new Promise<unknown>((resolve) => {
            const id = crypto.randomUUID();
            setElicitationRef.current((queue) => [
              ...queue,
              {
                id,
                askId:
                  typeof params.askId === "number" ? params.askId : undefined,
                label,
                request,
                resolve: (result) => {
                  setElicitationRef.current((current) =>
                    current.filter((entry) => entry.id !== id),
                  );
                  resolve(result);
                },
              },
            ]);
          });
        }
        case "elicitCancel": {
          setElicitationRef.current((current) =>
            current.filter((entry) => entry.askId !== params.askId),
          );
          return { ok: true };
        }
        case "requestConnection": {
          if (projectIdRef.current)
            void desktopApi.workspaceNavigate({
              projectId: projectIdRef.current,
            });
          // Main sends this to ONE window (focused, else first) — no
          // renderer-side focus guard, so an unfocused single window
          // still shows the modal instead of silently declining.
          const query = typeof params.query === "string" ? params.query : "";
          const reason =
            typeof params.reason === "string" ? params.reason : undefined;
          const sessionId =
            typeof params.sessionId === "string" ? params.sessionId : "";
          const before = await desktopApi.connectionsList().catch(() => []);
          return new Promise<unknown>((resolve) => {
            setConnectorRequestRef.current({
              query,
              reason,
              sessionId,
              before: new Set(before.map((connection) => connection.id)),
              resolve: (result) => {
                setConnectorRequestRef.current(null);
                resolve(result);
              },
            });
            setConnectorsModalOpenRef.current(true);
          });
        }
        case "surfaceControl": {
          const key = String(params.key);
          const controlled = Boolean(params.controlled);
          updateWorkspace((current) => ({
            ...current,
            browsers: current.browsers.map((b) =>
              browserTabKey(b.localId) === key
                ? { ...b, agentControlled: controlled }
                : b,
            ),
            terminals: current.terminals.map((t) =>
              terminalTabKey(t.localId) === key
                ? { ...t, agentControlled: controlled }
                : t,
            ),
          }));
          return { ok: true };
        }
        case "closeSurface": {
          const key = String(params.key);
          const before = workspaceRef.current;
          // The agent's close is final (main already killed an agent
          // terminal's PTY) — never soft-close back to a background chip.
          // A floating surface plays its own exit; closing the tab in
          // front brings its successor in from its side of the strip,
          // unless a workflow draft asks first.
          closeTabRef.current(key, { force: true, final: true });
          const asks = before.tabs.some(
            (tab) =>
              tab.kind === "workflow" && tabKey(tab) === key && tab.draft,
          );
          if (before.floatingKey !== key && !asks)
            narrateSwap(
              before,
              transitionWorkspace(before, { type: "close", key, force: true })
                .activeTabKey,
            );
          return { ok: true };
        }
        default:
          return null;
      }
    };

    return desktopApi.onBridgeRequest(({ id, method, params }) => {
      if (
        params.projectId
          ? params.projectId !== projectIdRef.current
          : !visibleRef.current
      )
        return;
      void handle(method, params)
        .catch((error: Error) => ({ error: error.message }))
        .then((result) => desktopApi.bridgeRespond({ id, result }));
    });
  }, [updateWorkspace, wakeTab]);

  // Foreground-command activity from main: chip spinners spin while a
  // command runs, not for the shell's whole lifetime.
  useEffect(
    () =>
      desktopApi.onTerminalBusy(({ sessionId, busy }) =>
        updateTerminals({ type: "terminal-busy", sessionId, busy }),
      ),
    [updateTerminals],
  );
  // A terminal's process ended, whether or not a view of it ever mounted
  // (ADR 0223): an agent terminal's chip leaves with its command.
  useEffect(
    () =>
      desktopApi.onTerminalExit(({ sessionId }) =>
        updateTerminals({ type: "terminal-ended", sessionId }),
      ),
    [updateTerminals],
  );

  const appPresentations = useAppPresentations(projectId, [
    ...workspace.tabs
      .filter((tab) => tab.kind === "app")
      .map((tab) => tab.name),
    ...Object.values(chipAttention)
      .flat()
      .filter((key) => key.startsWith("app:"))
      .map((key) => key.slice("app:".length)),
  ]);
  const appMetadata = new Map(
    appPresentations.flatMap((query) =>
      query.data ? [[query.data.name, query.data] as const] : [],
    ),
  );
  // Workflow tabs and chips read the workflow's display name, never the
  // export identifier, whichever way the tab was opened.
  const needsWorkflowTitles =
    workspace.tabs.some((tab) => tab.kind === "workflow") ||
    Object.values(chipAttention)
      .flat()
      .some((key) => key.startsWith("workflow:"));
  const workflowSummaries = useWorkflows(
    needsWorkflowTitles ? projectId : undefined,
  );
  const workflowTitles = new Map(
    (workflowSummaries.data ?? []).flatMap((workflow) =>
      workflow.displayName
        ? [[workflow.name, workflow.displayName] as const]
        : [],
    ),
  );
  const presentedTabs = workspace.tabs.map((tab) => {
    if (tab.kind === "workflow") {
      const title = workflowTitles.get(tab.name);
      return title ? { ...tab, label: title } : tab;
    }
    const metadata = tab.kind === "app" ? appMetadata.get(tab.name) : undefined;
    return tab.kind === "app" && metadata
      ? { ...tab, label: metadata.title, appIcon: metadata.icon }
      : tab;
  });
  const activeTab = presentedTabs.find(
    (tab) => tabKey(tab) === workspace.activeTabKey,
  );

  // The workspace's project root, so a file:// tab of one of its files
  // is recorded as that project's file rather than a loose one.
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setProjectRoot(null);
    if (!projectId) return;
    void desktopApi
      .projectRoot(projectId)
      .then((root) => {
        if (current) setProjectRoot(root);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [projectId]);
  // History and palette usage learn from what comes to the front.
  useVisitRecording({
    visible: runtime.visible,
    ready: workspaceReady,
    workspace,
    focusedChat,
    projectId,
    projects,
    projectRoot,
    sessionsById,
    appMetadata,
  });

  // A chat is named by its first message from the moment it is sent (or
  // by its harness). Until then it is a new chat: a session exists a moment
  // before its first message, and a stand-in name would flash in between.
  const chatLabels = Object.fromEntries(
    workspace.chats.map((chat) => {
      const title = sessionsById.get(chat.sessionId ?? "")?.title;
      return [chat.localId, title ? truncateLabel(title) : "New chat"];
    }),
  );
  // Conversation identity beyond the label: the agent-chosen icon, and
  // whether the chat is a fork (fork glyph, back-to-parent affordance).
  const chatIcons: Record<string, string | null> = Object.fromEntries(
    workspace.chats.map((chat) => [
      chat.localId,
      sessionsById.get(chat.sessionId ?? "")?.icon ?? null,
    ]),
  );
  const chatForks: Record<string, boolean> = Object.fromEntries(
    workspace.chats.map((chat) => [
      chat.localId,
      Boolean(
        chat.parentLocalId ??
          sessionsById.get(chat.sessionId ?? "")?.parentSessionId,
      ),
    ]),
  );
  // Strip entries in visual order (drag-arranged + group-clustered), with
  // group membership stamped for the grouped styling.
  const tabByKey = new Map<string, WorkspaceTab>(
    [
      ...presentedTabs,
      ...browserTabs(workspace),
      ...terminalTabs(workspace),
      ...editorTabs(workspace),
      ...chatTabs(workspace, chatLabels, chatIcons, chatForks),
    ].map((tab) => [tabKey(tab), tab]),
  );
  const groupOfKey = new Map<string, string>();
  const tabGroups = workspace.chats
    .filter((chat) => chat.mode === "tab")
    .map((chat) => {
      const memberKeys = attachedTabKeys(workspace, chat.localId);
      // A chat with nothing attached is a tab, not a group.
      if (memberKeys.length > 0) {
        for (const key of memberKeys) groupOfKey.set(key, chat.localId);
        groupOfKey.set(chatTabKey(chat.localId), chat.localId);
      }
      return {
        parentKey: chatTabKey(chat.localId),
        memberKeys,
        collapsed: Boolean(chat.surfacesCollapsed),
      };
    })
    .filter((group) => group.memberKeys.length > 0);
  const allTabs = orderedTabKeys(workspace)
    .map((key) => {
      const tab = tabByKey.get(key);
      if (!tab) return null;
      const groupId = groupOfKey.get(key);
      return groupId ? { ...tab, groupId } : tab;
    })
    .filter((tab): tab is WorkspaceTab => tab !== null);
  const _activeChatTabId = focusedTabKey?.startsWith("chat:")
    ? focusedTabKey.slice("chat:".length)
    : undefined;
  const activeBrowserTabId = focusedTabKey?.startsWith("browser:")
    ? focusedTabKey.slice("browser:".length)
    : undefined;
  const focusedSite = useMemo(() => {
    const browser = workspace.browsers.find(
      (entry) => entry.localId === activeBrowserTabId,
    );
    const origin = browser ? siteOrigin(browser.url) : null;
    return origin ? { origin, host: siteHost(origin) } : null;
  }, [workspace.browsers, activeBrowserTabId]);
  const activeTerminalTabId = focusedTabKey?.startsWith("terminal:")
    ? focusedTabKey.slice("terminal:".length)
    : undefined;
  // Chrome extensions (ADR 0203): this window's browser tabs as extensions
  // see them (their order and the window's active tab, which stays the last
  // browser tab used while another kind of tab is in front), and what
  // extensions ask the window to do.
  const lastBrowserTabRef = useRef<string | null>(null);
  if (activeBrowserTabId) lastBrowserTabRef.current = activeBrowserTabId;
  // A window keeps a project mounted for each one opened in it: each
  // reports its own tabs, and only the one in front names the active tab.
  const tabsReporter = useRef(crypto.randomUUID()).current;
  const tabsReportTimer = useRef<number | undefined>(undefined);
  const reportExtensionTabs = useCallback(() => {
    if (document.documentElement.dataset.surface === "dock") return;
    window.clearTimeout(tabsReportTimer.current);
    tabsReportTimer.current = window.setTimeout(() => {
      const guests = browserGuestIdsRef.current;
      const guestIds = workspaceRef.current.browsers
        .map((browser) => guests.get(browser.localId))
        .filter((id): id is number => id !== undefined);
      const last = lastBrowserTabRef.current;
      void desktopApi
        .extensionsTabsReport({
          reporter: tabsReporter,
          visible: visibleRef.current,
          guestIds,
          activeGuestId: (last ? guests.get(last) : undefined) ?? null,
        })
        .catch(() => {});
    }, 0);
  }, [tabsReporter]);
  const reportExtensionTabsRef = useRef(reportExtensionTabs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the report reads the latest tabs and active tab through refs
  useEffect(() => {
    reportExtensionTabs();
  }, [
    workspace.browsers,
    activeBrowserTabId,
    runtime.visible,
    reportExtensionTabs,
  ]);
  // A project that closes takes its tabs out of the window's.
  useEffect(
    () => () => {
      window.clearTimeout(tabsReportTimer.current);
      if (document.documentElement.dataset.surface === "dock") return;
      void desktopApi
        .extensionsTabsReport({
          reporter: tabsReporter,
          visible: false,
          guestIds: [],
          activeGuestId: null,
        })
        .catch(() => {});
    },
    [tabsReporter],
  );
  useEffect(() => {
    if (document.documentElement.dataset.surface === "dock") return;
    return desktopApi.onExtensionWindowRequest(({ id, request }) => {
      const respond = (result: { guestId?: number } | null) =>
        desktopApi.extensionsWindowRespond({ id, result });
      const localIdOf = (guestId: number) =>
        [...browserGuestIdsRef.current].find(
          ([, guest]) => guest === guestId,
        )?.[0];
      // Only the project in front opens things; the project that holds a
      // tab answers for it, and the others stay quiet.
      switch (request.kind) {
        case "create-tab": {
          if (!visibleRef.current) return;
          const localId = openBrowserTabRef.current(request.url, {
            background: !request.active,
          });
          if (!localId) {
            respond(null);
            return;
          }
          // Its page reports its guest once the webview attaches.
          const deadline = Date.now() + 10_000;
          const wait = () => {
            const guestId = browserGuestIdsRef.current.get(localId);
            if (guestId) respond({ guestId });
            else if (Date.now() > deadline) respond(null);
            else window.setTimeout(wait, 50);
          };
          wait();
          return;
        }
        case "select-tab": {
          const localId = localIdOf(request.guestId);
          if (!localId) return;
          selectTabRef.current(browserTabKey(localId));
          respond({});
          return;
        }
        case "close-tab": {
          const localId = localIdOf(request.guestId);
          if (!localId) return;
          closeTabRef.current(browserTabKey(localId), {
            force: true,
            final: true,
          });
          respond({});
          return;
        }
        case "open-popup":
          if (!visibleRef.current) return;
          window.dispatchEvent(
            new CustomEvent<OpenExtensionPopupDetail>(
              OPEN_EXTENSION_POPUP_EVENT,
              {
                detail: {
                  extensionId: request.extensionId,
                  guestId: request.guestId,
                  url: request.url,
                },
              },
            ),
          );
          respond({});
          return;
        case "open-extensions":
          if (!visibleRef.current) return;
          openTabRef.current({
            kind: "extensions",
            name: "extensions",
            label: "Extensions",
          });
          respond({});
          return;
      }
    });
  }, []);

  // The split renders only while valid: both panes still exist and one of
  // them is focused. Any mutation that breaks that (a close, a chat mode
  // change, a plain tab open) silently falls back to the single view —
  // no updater needs to know about splits.
  chatLabelsRef.current = chatLabels;
  const { split, viewSlots } = workspaceLayout(workspace);
  const splitRatio = split?.ratio ?? 0.5;
  const SLOT_CLASSES = {
    full: "absolute inset-0 flex flex-col",
    left: "absolute inset-y-0 left-0 flex flex-col border-r border-border",
    right: "absolute inset-y-0 right-0 flex flex-col",
    floating:
      "absolute z-30 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2xl",
  } as const;
  // Un-siding (and re-tiling) tweens the pane edges instead of snapping;
  // the transition pauses during a divider drag so resizing tracks the
  // pointer 1:1.
  const paneGeometryTransition = dividerDragging
    ? ""
    : " transition-[left,right] duration-200 ease-[cubic-bezier(0.2,0,0,1)]";
  const paneClass = (key: string) => {
    const slot = viewSlots[key];
    if (slot) return SLOT_CLASSES[slot] + paneGeometryTransition;
    // What a floating chat grows over as it becomes a tab stays in place
    // beneath it until the chat covers it (useRecedingSurface).
    if (key === recedingSurface)
      return `${SLOT_CLASSES.full} pointer-events-none`;
    // Browser panes keep their layout while hidden — a display:none
    // webview detaches its guest and background pages would stop
    // loading (worse for agent-driven tabs).
    return key.startsWith("browser:")
      ? `${busyBrowsers.has(key.slice("browser:".length)) ? "opacity-0" : "invisible"} pointer-events-none absolute inset-0 flex flex-col`
      : "hidden";
  };
  /** Ratio-driven pane geometry (50/50 until the divider is dragged). */
  const paneStyle = (key: string): React.CSSProperties | undefined => {
    const slot = viewSlots[key];
    if (slot === "left") return { right: `${(1 - splitRatio) * 100}%` };
    if (slot === "right") return { left: `${splitRatio * 100}%` };
    if (slot === "floating") return { inset: "max(12px, 8%) max(12px, 8%)" };
    return undefined;
  };
  /** Clicking anywhere in an unfocused pane focuses it. */
  const isSplitSlot = (key: string) =>
    viewSlots[key] === "left" || viewSlots[key] === "right";
  const paneFocusProps = (key: string) => ({
    "data-workspace-slot": viewSlots[key],
    "data-surface-key": key,
    "data-floating-surface": viewSlots[key] === "floating" ? key : undefined,
    "data-floating-state":
      viewSlots[key] === "floating"
        ? floatingMotion.closing
          ? "closing"
          : "open"
        : undefined,
    ...(split && workspace.activeTabKey !== key && isSplitSlot(key)
      ? { onMouseDownCapture: () => selectTab(key) }
      : {}),
  });
  const splitCompanionKey = split
    ? workspace.activeTabKey === split.leftKey
      ? split.rightKey
      : split.leftKey
    : undefined;
  const floatingBar = (key: string) =>
    workspace.floatingKey === key ? (
      <FloatingPanelBar
        title={tabByKey.get(key)?.label ?? "Preview"}
        canTile={Boolean(
          workspace.activeTabKey && workspace.activeTabKey !== key,
        )}
        onExpand={() => openSurface(key, "tab")}
        onTile={() => openSurface(key, "split")}
        onHide={dismissFloating}
        onClose={() => closeTab(key)}
      />
    ) : null;

  /**
   * A chip for an attention key with no tab of the chat's behind it (an
   * app tab open_surface prepared in the background, another chat's tab):
   * the attention dot needs a chip to live on, so one is made from what the
   * workspace knows about the key.
   */
  const synthesizedChip = (key: string): Chip => {
    const base = { id: key, url: key, signal: "attention" as const };
    if (key.startsWith("app:")) {
      const name = key.slice("app:".length);
      const metadata = appMetadata.get(name);
      return {
        ...base,
        label: metadata?.title ?? name,
        icon: appIconName(metadata?.icon),
        data: { kind: "app", name },
      };
    }
    if (key.startsWith("browser:")) {
      const entry = workspace.browsers.find(
        (browser) => browserTabKey(browser.localId) === key,
      );
      return {
        ...base,
        label: entry?.title || entry?.url || "Page",
        icon: pageIcon(entry?.faviconUrl),
        data: { kind: "browser", ...(entry?.url ? { url: entry.url } : {}) },
      };
    }
    if (key.startsWith("terminal:")) {
      const entry = workspace.terminals.find(
        (terminal) => terminalTabKey(terminal.localId) === key,
      );
      const terminalSessionId = entry?.ptySessionId ?? entry?.attachSessionId;
      return {
        ...base,
        label: entry?.title || "Terminal",
        icon: "SquareTerminal",
        data: {
          kind: "terminal",
          ...(terminalSessionId ? { terminalSessionId } : {}),
        },
      };
    }
    if (key.startsWith("editor:")) {
      const entry = workspace.editors.find(
        (editor) => editorTabKey(editor.localId) === key,
      );
      return {
        ...base,
        label: entry?.filePath?.split("/").at(-1) || "Editor",
        icon: "FileCode",
        data: {
          kind: "editor",
          ...(entry?.filePath ? { filePath: entry.filePath } : {}),
        },
      };
    }
    if (key.startsWith("chat:"))
      return {
        ...base,
        label: chatLabels[key.slice("chat:".length)] ?? "Chat",
        icon: "GitFork",
        data: { kind: "chat" },
      };
    if (key.startsWith("workflow:")) {
      const name = key.slice("workflow:".length);
      return {
        ...base,
        label: workflowTitles.get(name) ?? name,
        icon: "Workflow",
        data: { kind: "workflow", name },
      };
    }
    const tab = presentedTabs.find((candidate) => tabKey(candidate) === key);
    return {
      ...base,
      label: tab?.label ?? tab?.name ?? key,
      icon: appIconName(tab?.kind === "app" ? tab.appIcon : undefined),
      data: { kind: "app", ...(tab ? { name: tab.name } : {}) },
    };
  };

  /**
   * What a chat holds in this workspace, as chips (ADR 0239): its forks and
   * subagents, then the tabs it opened. Its dock adds what it knows itself.
   */
  const chipsFor = (chat: ChatDockEntry): Chip[] => {
    const attentionKeys = chipAttention[chat.localId] ?? [];
    const signalOf = (key: string, working: boolean) =>
      attentionKeys.includes(key)
        ? { signal: "attention" as const }
        : working
          ? { signal: "working" as const }
          : {};
    const chips: Chip[] = [
      // Every first-class child lives on the parent's chips. Latent children
      // stay here until the user messages them or they request attention.
      ...[...sessionsById.values()]
        .filter(
          (session) =>
            session.parentSessionId === chat.sessionId &&
            session.visibility !== "archived",
        )
        .map((session): Chip => {
          const open = workspace.chats.find(
            (candidate) => candidate.sessionId === session.id,
          );
          const key = open ? chatTabKey(open.localId) : `session:${session.id}`;
          const forked = Boolean(session.forkedFromSessionId);
          return {
            id: key,
            label: sessionLabel(session),
            icon: forked ? "GitFork" : "Bot",
            url: key,
            ...(session.attentionRequired
              ? { signal: "attention" as const }
              : signalOf(
                  key,
                  open
                    ? Boolean(signalsByChat[open.localId]?.working)
                    : session.running,
                )),
            actions: [OPEN_SIDE_CHIP],
            data: { kind: forked ? "chat" : "subagent", sessionId: session.id },
          };
        }),
      ...presentedTabs
        .filter((tab) => tab.chatLocalId === chat.localId)
        .map((tab): Chip => {
          const key = tabKey(tab);
          const workflow = tab.kind === "workflow";
          return {
            id: key,
            label: tab.label ?? tab.name,
            icon: workflow
              ? "Workflow"
              : appIconName(tab.kind === "app" ? tab.appIcon : undefined),
            url: key,
            ...signalOf(key, false),
            actions: [OPEN_SIDE_CHIP],
            data: { kind: workflow ? "workflow" : "app", name: tab.name },
          };
        }),
      ...workspace.browsers
        .filter((browser) => browser.chatLocalId === chat.localId)
        .map((browser): Chip => {
          const key = browserTabKey(browser.localId);
          return {
            id: key,
            label: browser.title || browser.url || "Page",
            icon: pageIcon(browser.faviconUrl),
            url: key,
            ...signalOf(key, Boolean(browser.agentControlled)),
            actions: [OPEN_SIDE_CHIP, CLOSE_CHIP],
            data: {
              kind: "browser",
              ...(browser.url ? { url: browser.url } : {}),
            },
          };
        }),
      ...workspace.terminals
        .filter((terminal) => terminal.chatLocalId === chat.localId)
        .map((terminal): Chip => {
          const key = terminalTabKey(terminal.localId);
          const terminalSessionId =
            terminal.ptySessionId ?? terminal.attachSessionId;
          return {
            id: key,
            label: terminal.title || "Terminal",
            ...(terminal.initialCommand
              ? { description: terminal.initialCommand }
              : {}),
            icon: "SquareTerminal",
            url: key,
            // The spinner tracks the COMMAND, not the shell: busy means a
            // foreground process is actually running in there right now.
            ...signalOf(key, terminal.busy === true),
            actions: [OPEN_SIDE_CHIP, CLOSE_CHIP],
            data: {
              kind: "terminal",
              ...(terminalSessionId ? { terminalSessionId } : {}),
            },
          };
        }),
      ...workspace.editors
        .filter((editor) => editor.chatLocalId === chat.localId)
        .map((editor): Chip => {
          const key = editorTabKey(editor.localId);
          return {
            id: key,
            label: editor.filePath?.split("/").at(-1) || "Editor",
            icon: "FileCode",
            url: key,
            ...signalOf(key, false),
            actions: [OPEN_SIDE_CHIP, CLOSE_CHIP],
            data: {
              kind: "editor",
              ...(editor.filePath ? { filePath: editor.filePath } : {}),
            },
          };
        }),
    ];
    // A resource that is gone (a terminal whose command ended, a removed
    // chip) leaves no chip behind its attention.
    const gone = (key: string) =>
      (key.startsWith("terminal:") &&
        !workspace.terminals.some(
          (terminal) => terminalTabKey(terminal.localId) === key,
        )) ||
      (key.startsWith("browser:") &&
        !workspace.browsers.some(
          (browser) => browserTabKey(browser.localId) === key,
        )) ||
      (key.startsWith("editor:") &&
        !workspace.editors.some(
          (editor) => editorTabKey(editor.localId) === key,
        ));
    for (const key of attentionKeys)
      if (!chips.some((chip) => chip.id === key) && !gone(key))
        chips.push(synthesizedChip(key));
    return chips;
  };

  // Everything the palette searches and acts on, shared by both hosts
  // (the Cmd+P overlay and palette "New Tab" tabs).
  const paletteTargetChat = actionChat(workspace);
  const paletteTabKeys = orderedTabKeys(workspace);
  const paletteFloatingChats = workspace.chats.filter(
    (chat) => chat.mode !== "tab",
  );
  const paletteTargetAgentId =
    focusedSession?.agentId ?? focusedChat?.agentId ?? effectiveDefaultAgentId;
  const paletteSwitchableAgentIds = new Set([
    ...(agentsData?.agents.map((agent) => agent.id) ?? []),
    ...Object.keys(projectAgentNames),
  ]);
  if (paletteTargetAgentId) {
    paletteSwitchableAgentIds.delete(paletteTargetAgentId);
  }
  const paletteActionAvailability: Partial<Record<ActionId, boolean>> = {
    "reopen-tab": workspace.closedTabs.length > 0,
    // A Git project on this computer (ADR 0215); connected projects' chats
    // run on their server.
    "new-worktree-chat": worktreesAvailable && remoteSurfaceStatus === null,
    "remote-environment": remoteSurfaceStatus !== null,
    // The server's dialogs, for the people it gives them to (ADR 0234).
    "server-secrets": remoteSurfaceStatus !== null,
    "server-members":
      remoteSurfaceStatus?.capabilities?.permissions.includes(
        "memberships:write",
      ) === true,
    "server-connections":
      remoteSurfaceStatus?.capabilities?.administrator === true,
    "new-workflow": !memberShell,
    "search-changes": !memberShell,
    "toggle-chat-minimized": paletteTargetChat !== undefined,
    "chat-to-tab":
      paletteTargetChat !== undefined &&
      (paletteTargetChat.mode !== "tab" ||
        workspace.activeTabKey !== chatTabKey(paletteTargetChat.localId)),
    "prev-chat":
      paletteFloatingChats.length > 1 ||
      (paletteFloatingChats.length === 1 &&
        paletteFloatingChats[0]?.mode !== "partial"),
    "next-chat":
      paletteFloatingChats.length > 1 ||
      (paletteFloatingChats.length === 1 &&
        paletteFloatingChats[0]?.mode !== "partial"),
    "prev-tab": paletteTabKeys.length > 1,
    "next-tab": paletteTabKeys.length > 1,
    "browser-back": workspace.activeTabKey?.startsWith("browser:") === true,
    "browser-forward": workspace.activeTabKey?.startsWith("browser:") === true,
    "split-view": workspace.split !== null || paletteTabKeys.length > 1,
    "close-tab":
      workspace.activeTabKey !== null ||
      workspace.chats.some((chat) => chat.mode === "partial"),
    "default-agent":
      (agentsData?.agents.length ?? 0) > 0 ||
      Object.keys(projectAgentNames).length > 0,
    "configure-agent":
      (agentsData?.agents.length ?? 0) > 0 ||
      Object.keys(projectAgentNames).length > 0,
    "switch-agent":
      focusedChat !== undefined && paletteSwitchableAgentIds.size > 0,
    "session-status": focusedChat !== undefined,
    "open-chat-terminal": remoteChatSession(paletteTargetChat?.sessionId),
    "open-chat-preview": remoteChatSession(paletteTargetChat?.sessionId),
    "archive-chat":
      focusedSession !== undefined && focusedSession.visibility !== "archived",
    // Any focused chat that has a session, loaded in the list or not.
    "rename-chat": focusedChat?.sessionId !== undefined,
    // Project-agent models are committed in their project definition, so
    // the mutable model picker only applies to configured profile agents.
    "switch-model":
      agentsData?.agents.some((agent) => agent.id === paletteTargetAgentId) ===
      true,
    "change-effort": paletteTargetAgentId != null,
    // Profile agents only: a definition's permission mode lives in its file.
    "change-permission-mode":
      agentsData?.agents.some(
        (agent) =>
          agent.id === paletteTargetAgentId && hasPermissionMode(agent.harness),
      ) === true,
  };
  /**
   * Every row, header button and action effect opens through here (ADR
   * 0234): one of Work's commands, a server dialog on a file, an open tab,
   * a chat, a page, or a workspace target.
   */
  const openTarget = async (url: string, mode: CommitMode) => {
    if (url.startsWith("command:")) {
      const command = BUILTIN_ACTIONS.find(
        (action) => action.id === url.slice("command:".length),
      )?.id;
      if (!command) throw new Error("This is not one of Work's commands.");
      if (paletteActionAvailability[command] === false)
        throw new Error("That command is not available here.");
      actionHandlersRef.current[command](mode);
      return;
    }
    const page = parseWorkPage(url);
    if (page) {
      const features = remoteSurfaceStatus?.capabilities?.features;
      if (page.page === "server-history") setRemoteHistoryPath(page.path);
      else if (page.page === "server-publish")
        setRemotePublish({ path: page.path, features });
      else setRemotePropose({ files: page.paths, features });
      return;
    }
    if (allTabs.some((tab) => tabKey(tab) === url)) {
      focusTab(url, mode);
      return;
    }
    if (
      parseChatBookmarkUrl(url) ||
      /^https?:/i.test(url) ||
      url.startsWith("file:")
    ) {
      await openUrl(url, mode);
      return;
    }
    await openLinkedSurface(url, { mode });
  };
  const openSidebarTarget = (url: string, mode: CommitMode) =>
    void openTarget(url, mode).catch((cause: unknown) =>
      setLinkError(
        cause instanceof Error ? cause.message : "Could not open this item.",
      ),
    );
  const paletteHost: PaletteHost = {
    projectId,
    profileId: activeProfile?.id,
    projects,
    activeProjectId: projectId,
    profiles: profilesData?.profiles ?? [],
    activeProfileId: activeProfile?.id,
    workspaceConfig: visibleWorkspace,
    onOpenUrl: openSidebarTarget,
    onOpenTab: openTab,
    onOpenSession: openSession,
    focusedSite,
    onOpenSiteSettings: setSiteSettingsOrigin,
    onOpenHistory: (entry: HistoryEntry, mode: CommitMode) => {
      void openHistory(entry, mode).catch((cause: unknown) =>
        setLinkError(
          cause instanceof Error
            ? cause.message
            : "Could not reopen this item.",
        ),
      );
    },
    onSelectProject: selectProject,
    onSwitchProfile: switchProfile,
    // What the palette starts is a chat asked for there: a New Tab in
    // front takes it.
    onSendToAgent: (message, mode, agentId) =>
      sendToAgent(message, mode, agentId, { inNewTab: true }),
    startingActions,
    onRunSkill: runSkill,
    onReturnToComposer: (chat, text) =>
      composerReturnsRef.current.get(chat)?.(text),
    actionHandlers,
    terminalMacros: prefs?.terminalMacros ?? [],
    onRunTerminalMacro: runTerminalMacro,
    actionAvailability: projectId
      ? paletteActionAvailability
      : Object.fromEntries(
          BUILTIN_ACTIONS.map((action) => [
            action.id,
            [
              "check-for-updates",
              "setup-agent",
              "manage-connectors",
              "connect-remote-project",
              "new-browser-tab",
              "toggle-sidebar",
            ].includes(action.id),
          ]),
        ),
    agents: agentsData?.agents ?? [],
    defaultAgentId: effectiveDefaultAgentId,
    focusedChat: focusedChat
      ? {
          sessionId: focusedChat.sessionId ?? null,
          harness: focusedSession?.harness ?? focusedChat.harness ?? null,
          agentId: focusedSession?.agentId ?? focusedChat.agentId ?? null,
          model:
            (focusedSession ? focusedSession.model : focusedChat.model) ?? null,
          effort:
            (focusedSession
              ? focusedSession.modelEffort
              : focusedChat.effort) ?? null,
        }
      : null,
    onPickDefaultAgent: pickDefaultAgent,
    onPickSessionAgent: pickSessionAgent,
    onStartChatWithAgent: startChatWithAgent,
    onPickProjectAgent: pickProjectAgent,
    onConfigureAgent: openConfigureAgent,
    voiceAssistant: prefs?.voiceAssistant ?? null,
    onCreateAssistant: createAssistant,
    defaultAgentOverridden: projectOverrideAgentId !== null,
    onClearDefaultOverride: () => {
      if (projectId) {
        void desktopApi.agentsSetProjectDefault(projectId, null);
      }
    },
    onPickEffort: pickEffort,
    onPickModel: pickModel,
    onPickHarnessPermissions: pickHarnessPermissions,
    onHighlightTarget: setPaletteTarget,
    memberShell,
    onError: setLinkError,
    incognitoAllowed,
  };

  const [sidebarCustomization, setSidebarCustomization] = useState<{
    projectId: string;
    side: "left" | "right";
  } | null>(null);
  const customizeSidebar = (side: "left" | "right") => {
    // This action owns the setup modal and resumes its request when setup ends.
    if (activeProfile) setupDismissedRef.current.add(activeProfile.id);
    void (async () => {
      const targetId =
        projectId ?? (await desktopApi.createDefaultProject()).id;
      setSidebarCustomization({ projectId: targetId, side });
      if (!projectId) {
        await projectsQuery.refetch();
        selectProject(targetId);
      }
      requireAgents();
    })().catch((cause: unknown) =>
      setLinkError(
        cause instanceof Error
          ? cause.message
          : "Could not open sidebar customization",
      ),
    );
  };
  const sidebarCustomizationChat = useRef<{
    projectId: string;
    localId: string;
  } | null>(null);
  const openSidebarCustomization = (side: "left" | "right") => {
    if (!projectId) return;
    const existing = sidebarCustomizationChat.current;
    if (
      existing?.projectId === projectId &&
      workspaceRef.current.chats.some(
        (chat) => chat.localId === existing.localId,
      )
    ) {
      revealChat(existing.localId);
      return;
    }
    void Promise.all([
      desktopApi.workspaceConfigGet(projectId),
      desktopApi.workspaceConfigFile(),
    ])
      .then(([resolved, profileFile]) => {
        // Edit the layer that is showing; the built-in default has no file,
        // so the profile file is created from it.
        const file = resolved.file ?? profileFile;
        const localId = sendToAgent(
          workspaceCustomizationMessage({
            side,
            file,
            layer: resolved.layer,
            config: resolved.config,
          }),
          "float",
        );
        if (localId) sidebarCustomizationChat.current = { projectId, localId };
      })
      .catch((cause: unknown) =>
        setLinkError(
          cause instanceof Error
            ? cause.message
            : "Could not open sidebar customization",
        ),
      );
  };

  const openSidebarCustomizationRef = useRef(openSidebarCustomization);
  openSidebarCustomizationRef.current = openSidebarCustomization;
  useEffect(() => {
    if (
      !sidebarCustomization ||
      sidebarCustomization.projectId !== projectId ||
      !workspaceReady ||
      !hasAgents
    )
      return;
    setSidebarCustomization(null);
    openSidebarCustomizationRef.current(sidebarCustomization.side);
  }, [sidebarCustomization, projectId, workspaceReady, hasAgents]);

  // "Customize chips" (ADR 0239): a new chat with the request waiting in
  // its composer, and the layout file and chips contract as its pills.
  const openChipsCustomization = () => {
    if (!projectId || !requireAgents()) return;
    void Promise.all([
      desktopApi.workspaceConfigGet(projectId),
      desktopApi.workspaceConfigFile(),
    ])
      .then(([resolved, profileFile]) => {
        const entry: ChatDockEntry = {
          ...newChatEntry("partial"),
          draftMessage: chipsCustomizationMessage({
            file: resolved.file ?? profileFile,
            layer: resolved.layer,
            config: resolved.config,
          }),
        };
        updateWorkspace((ws) => ({
          ...ws,
          chats: [
            ...ws.chats.map((chat) =>
              chat.mode === "partial"
                ? { ...chat, mode: "min" as const }
                : chat,
            ),
            entry,
          ],
          activeChatId: entry.localId,
        }));
      })
      .catch((cause: unknown) =>
        setLinkError(
          cause instanceof Error
            ? cause.message
            : "Could not open chips customization",
        ),
      );
  };

  const sidebarTabs = (side: "left" | "right") => {
    if (side === "right" && !projectId) return [];
    return visibleWorkspace?.sidebars[side] ?? [];
  };
  const [sidebarHasSelection, setSidebarHasSelection] = useState(false);
  useEffect(() => {
    const update = () =>
      setSidebarHasSelection(Boolean(readEditorSelection()?.text.trim()));
    window.addEventListener("catamorphic:editor-selection", update);
    document.addEventListener("selectionchange", update);
    return () => {
      window.removeEventListener("catamorphic:editor-selection", update);
      document.removeEventListener("selectionchange", update);
    };
  }, []);
  const sidebarSurfaceKey = workspace.floatingKey ?? workspace.activeTabKey;
  const sidebarChat = workspace.chats.find(
    (chat) =>
      chatVisible(workspace, chat) &&
      (chat.mode === "partial" ||
        chatTabKey(chat.localId) === sidebarSurfaceKey),
  );
  const sidebarEditor = workspace.editors.find(
    (editor) => editorTabKey(editor.localId) === sidebarSurfaceKey,
  );
  // A page, file or terminal a chat opened keeps that chat's session beside
  // it (ADR 0226): This session, the chat's checkout and its other
  // session-scoped sections stay while the person looks at what it opened.
  const sidebarSessionChat =
    sidebarChat ??
    (sidebarSurfaceKey
      ? workspace.chats.find(
          (chat) =>
            chat.sessionId &&
            attachedTabKeys(workspace, chat.localId).includes(
              sidebarSurfaceKey,
            ),
        )
      : undefined);
  const sidebarSurface: SidebarSurface = {
    tabPlacement: prefs?.tabPlacement === "sidebar" ? "sidebar" : "top",
    kind: sidebarChat
      ? "chat"
      : sidebarEditor
        ? "editor"
        : (presentedTabs.find((tab) => tabKey(tab) === sidebarSurfaceKey)
            ?.kind ?? "none"),
    key: sidebarChat ? chatTabKey(sidebarChat.localId) : sidebarSurfaceKey,
    projectId,
    sessionId: sidebarSessionChat?.sessionId ?? undefined,
    path: sidebarEditor?.filePath ?? undefined,
    selection: Boolean(sidebarEditor && sidebarHasSelection),
  };
  const openProjectFile = (filePath: string, mode?: CommitMode) => {
    void openLinkedSurface(`file:${filePath}`, { mode }).catch(
      (cause: unknown) =>
        setLinkError(
          cause instanceof Error ? cause.message : "Could not open this file",
        ),
    );
  };
  // Work's lists (ADR 0234): what sections, the palette, app widgets and
  // modules read, each a source on one contract.
  const workSources = useWorkSources({
    projectId: projectId ?? "",
    profileId: activeProfile?.id,
    writesProgram: !memberShell,
    remote: remoteSurfaceStatus !== null,
    host: {
      sessionId: sidebarSurface.sessionId,
      tabs: allTabs,
      tabGroups,
      activeTabKey: focusedTabKey,
      unreadSessionIds,
      agentName: (agentId) => {
        const id = agentId ?? effectiveDefaultAgentId;
        return (
          agentsData?.agents.find((agent) => agent.id === id)?.name ??
          (id ? projectAgentNames[id] : undefined)
        );
      },
      closeTab: (key) => closeTab(key),
      reorderTab,
      sessionAction: applySessionAction,
      openTab,
      resourceTab: (owner) => {
        if (owner.kind === "page") {
          const match = [...browserGuestIdsRef.current].find(
            ([, guestId]) => guestId === owner.webContentsId,
          );
          return match ? browserTabKey(match[0]) : undefined;
        }
        const terminal = workspaceRef.current.terminals.find(
          (entry) =>
            entry.ptySessionId === owner.terminalId ||
            entry.attachSessionId === owner.terminalId,
        );
        return terminal ? `terminal:${terminal.localId}` : undefined;
      },
    },
    open: (url, mode) => openTarget(url, mode),
  });
  useAnswerSourceWork({ sources: workSources, projectId });
  const sidebarHost = {
    projectId: projectId ?? "",
    agentsData,
    defaultAgentId: effectiveDefaultAgentId,
    projectAgentNames,
    onSessionCommand: (session: AgentSession, command: SessionCommand) => {
      const entry = workspace.chats.find(
        (chat) => chat.sessionId === session.id,
      ) ?? { ...newChatEntry("tab"), sessionId: session.id };
      if (command === "fork") {
        void desktopApi
          .sessionIsIncognito(session.id)
          .then((incognito) => forkChat({ ...entry, incognito }));
        return;
      }
      if (command === "parent") {
        openParentChat(entry);
        return;
      }
      openSession(session);
      openPalettePicker(command);
    },
    onSessionAction: applySessionAction,
    commandAvailable: (id: string) =>
      !BUILTIN_ACTIONS.some(
        (action) =>
          action.id === id && paletteActionAvailability[action.id] === false,
      ),
    // Dragged from a list, a tab tiles to either side as from the strip.
    onTabDrag: (key: string | null) => {
      setTabDragKey(key);
      if (!key) setDropSideHover(null);
    },
    openTab: (url: string) => {
      const tab = allTabs.find((entry) => tabKey(entry) === url);
      return tab
        ? {
            key: url,
            kind: tab.kind,
            title: tab.label ?? tab.name,
            detail: tab.detail,
            bookmarkUrl: tab.bookmarkUrl,
          }
        : undefined;
    },
  };
  const renderSidebarSection =
    (side: SidebarSide) =>
    (
      section: SidebarSectionConfig,
      visible: boolean,
      report: (state: SidebarContentState) => void,
      relevant: boolean,
      observeEmpty: boolean,
    ) =>
      projectId ? (
        <ConfiguredSection
          key={section.id}
          surface={sidebarSurface}
          relevant={relevant}
          report={report}
          visible={visible}
          observeEmpty={observeEmpty}
          onCustomize={() => customizeSidebar(side)}
          onSearch={(request) => {
            setModeRequest({ ...request, nonce: crypto.randomUUID() });
            setPaletteOpen(true);
          }}
          section={section}
          experienceContext={projectExperienceContext}
          memberShell={memberShell}
          projectId={projectId}
          profileId={activeProfile?.id}
          onOpenUrl={openSidebarTarget}
          onOpenSessionLink={(url, mode) => {
            // As a link in the chat opens: a tab the chat owns, so the
            // session's sections stay beside it (ADR 0226).
            if (sidebarSessionChat && /^https?:/i.test(url))
              openMessageLink(url, sidebarSessionChat, mode);
            else openSidebarTarget(url, mode);
          }}
          onOpenFile={openProjectFile}
          onError={setLinkError}
        />
      ) : null;

  const hasActiveWork =
    Object.values(signalsByChat).some((signals) => signals.working) ||
    Object.values(workspaces).some((candidate) =>
      candidate.terminals.some((terminal) => terminal.busy),
    );

  // Tabs leave the top bar only for a sidebar section that lists them (the
  // default Tabs section, or a module or app granted Work's tabs, ADR 0234);
  // a layout without one keeps them on top whatever the preference says. A
  // module runs only in a local project, so it lists nothing on a server's.
  const tabsInSidebar =
    prefs?.tabPlacement === "sidebar" &&
    sidebarSections(visibleWorkspace).some(
      (section) =>
        section.when?.tabPlacement !== "top" &&
        (workSourceName(section.source) === "tabs" ||
          (section.collections?.includes("tabs") === true &&
            (section.app !== undefined ||
              (remoteSurfaceResolved && remoteSurfaceStatus === null)))),
    );
  const headerInSidebar = tabsInSidebar && prefs?.headerPlacement === "sidebar";
  const compactWindow = headerInSidebar && !sidebarOpen;
  // The chrome keeps the window buttons' corner free while they show. Only
  // macOS draws them in the page; elsewhere the preference changes nothing.
  const windowButtons =
    prefs?.windowButtons !== false || !/Mac/.test(navigator.platform);
  // Without the buttons, the sidebar's top row would hold only its toggle,
  // so the project switcher moves up into it.
  const projectInSidebarHeader = !windowButtons && !headerInSidebar;
  const { sidebarRef, revealed, reveal, revealOnHover } =
    useSidebarReveal(compactWindow);
  const sidebarVisible = sidebarOpen || revealed;
  const chromeBrowserId = workspace.activeTabKey?.startsWith("browser:")
    ? workspace.activeTabKey.slice(8)
    : undefined;
  const activeHeaderTitle =
    activeTab?.kind === "palette"
      ? ""
      : (allTabs.find((tab) => tabKey(tab) === workspace.activeTabKey)?.label ??
        "");
  // One toggle per side, wherever it sits: in the sidebar's own header while
  // the panel is out, in the chrome until the content makes room for it.
  const sidebarToggle = (side: SidebarSide) => {
    const open = side === "left" ? sidebarOpen : rightSidebarOpen;
    const label = `${open ? "Collapse" : "Expand"} ${side === "left" ? "sidebar" : "right sidebar"}`;
    const action = side === "left" ? "toggle-sidebar" : "toggle-right-sidebar";
    const Icon = side === "left" ? PanelLeft : PanelRight;
    return (
      <ShortcutHint label={label} shortcut={formatBinding(keybindings[action])}>
        <button
          type="button"
          onClick={() => actionHandlers[action]()}
          className="app-no-drag grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay/60 hover:text-fg"
          aria-label={label}
          aria-expanded={open}
        >
          <Icon className="size-4" />
        </button>
      </ShortcutHint>
    );
  };
  const workspaceTitle = (
    <div
      className="flex h-full min-w-0 flex-1 items-center"
      data-workspace-title
    >
      {/* Keep the portal host empty of React-owned title children. Clearing
          a title must never remove the browser toolbar before its portal. */}
      <div
        ref={setBrowserToolbarHost}
        className={`h-full min-w-0 flex-1 ${chromeBrowserId ? "flex" : "hidden"}`}
      />
      {!chromeBrowserId && Boolean(activeHeaderTitle) && (
        <span className="truncate px-2 text-[13px] text-fg-muted">
          {activeHeaderTitle}
        </span>
      )}
    </div>
  );
  const workspaceTabBar = (
    <WorkspaceTabBar
      alignment={prefs?.tabAlignment ?? "start"}
      tabs={allTabs}
      activeKey={focusedTabKey}
      secondaryKey={splitCompanionKey}
      highlightKey={targetedTabKey}
      groups={tabGroups}
      onSelect={(key, mode) =>
        mode === "side" || mode === "floating"
          ? openSurface(key, mode)
          : selectTab(key)
      }
      onClose={closeTab}
      onNew={openPaletteTab}
      onToggleGroup={toggleChatGroup}
      onReorder={reorderTab}
      // An editor's tab acts on its file too (copy its path, show it, copy it).
      tabFile={(key) => {
        const filePath = workspace.editors.find(
          (candidate) => editorTabKey(candidate.localId) === key,
        )?.filePath;
        return filePath && projectId ? { projectId, filePath } : undefined;
      }}
      // A chat's tab has the chat's own verbs, as its row and bubble do.
      tabActions={(key) => {
        const chat = workspace.chats.find(
          (candidate) => chatTabKey(candidate.localId) === key,
        );
        const sessionId = chat?.sessionId;
        const entries = chat ? chatMenus[chat.localId] : undefined;
        return sessionId && entries
          ? {
              entries,
              onAction: (action) => {
                const entry = entries.find((item) => item.action === action);
                if (entry) applySessionAction(sessionId, entry.action);
              },
            }
          : undefined;
      }}
      onDragStateChange={(key) => {
        setTabDragKey(key);
        if (!key) setDropSideHover(null);
      }}
    />
  );
  const projectControls = (
    <>
      <ProjectSwitcher
        projects={projects}
        activeProjectId={projectId}
        onSelect={selectProject}
        onOpenWindow={(id) => {
          void desktopApi.workspaceNavigate({
            projectId: id,
            newWindow: true,
          });
        }}
        onNewProject={() => setProjectModalOpen(true)}
        onConnectRemote={() => setRemoteConnect({ open: true, link: null })}
        onDeleteProject={setDeletingProject}
      />
      <RemoteConnectionIndicator projectId={projectId} />
    </>
  );

  return (
    <WorkSourcesProvider value={workSources}>
      <SidebarHostProvider value={sidebarHost}>
        <PaletteHostProvider value={paletteHost}>
          <div
            data-sidebar-dividers={prefs?.sidebarDividers ? "on" : "off"}
            data-window-buttons={windowButtons ? "on" : "off"}
            // The project's workspace is restored, revealed, and taking
            // shortcuts: what automation waits for before pressing keys.
            // Taking them means knowing whether the project is on a server:
            // that decides the server's commands, and every list is read
            // again (its rows drawn anew) when it arrives.
            data-workspace-ready={
              workspaceReady &&
              remoteSurfaceResolved &&
              bootRevealed &&
              runtime.visible
                ? ""
                : undefined
            }
            // Clip, not hide: a closed right sidebar waits past the right edge,
            // and a scroll container here would let scrollIntoView shift the app.
            className="relative flex h-full overflow-clip bg-sidebar"
          >
            {/* Agent pointers: glow + scroll on data-point-key elements. The
          workspace object is the re-resolve trigger — a pointed tab may
          mount after the point_at call. */}
            <AgentPointers
              pointers={agentPointers}
              onDismiss={dismissPointer}
              revision={workspace}
            />
            {/* MCP elicitation: a connector asking the user a form or to open a
          sign-in URL. URL consent opens the page as a browser tab. */}
            <ElicitationModal
              pending={elicitations[0] ?? null}
              onOpenUrl={(url) => openBrowserTab(url)}
            />
            <SiteSettingsHost
              origin={siteSettingsOrigin}
              onClose={() => setSiteSettingsOrigin(null)}
            />
            <ScreenShareHost />
            <ExtensionPromptHost />
            <PasskeyHost onOpenPasswords={() => openPasswords()} />
            <UpdateBanner
              hasActiveWork={hasActiveWork}
              onOpenRelease={(url) => openBrowserTab(url)}
            />
            {linkError && (
              <div
                role="alert"
                className="fixed right-4 top-12 z-[250] flex max-w-sm items-center gap-3 rounded-lg border border-border bg-bg-overlay p-3 text-xs text-fg shadow-lg"
              >
                <span>{linkError}</span>
                <button
                  type="button"
                  onClick={() => setLinkError(null)}
                  className="text-accent"
                >
                  Dismiss
                </button>
              </div>
            )}
            <DisabledControlHints />
            <MobilePairingModal
              open={mobilePairing.open}
              context={mobilePairing.context}
              onClose={() => setMobilePairing({ open: false, context: null })}
            />
            <PreviewPortDialog
              request={previewRequest}
              pending={previewPending}
              error={previewError}
              onClose={closeChatPreview}
              onOpen={(port) => {
                if (previewRequest)
                  void openChatPreview(previewRequest.sessionId, port);
              }}
            />
            {projectId && (
              <RemoteEnvironmentModal
                open={remoteEnvironmentOpen && remoteSurfaceStatus !== null}
                projectId={projectId}
                onClose={() => setRemoteEnvironmentOpen(false)}
                onOpenFile={(filePath) => {
                  void openLinkedSurface(`file:${filePath}`).catch(
                    (cause: unknown) =>
                      setLinkError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not open this file",
                      ),
                  );
                }}
              />
            )}
            {/* Project-agent consent (ADR 0050): approve, then complete the
          original pick and refresh the roster's consent state. */}
            <ProjectAgentConsentDialog
              request={consentRequest}
              onClose={() => setConsentRequest(null)}
              onApproved={(agent) => {
                const target = consentRequest?.target ?? "session";
                setConsentRequest(null);
                applyProjectAgent(agent, target);
              }}
            />
            <RenameChatDialog
              chat={renameRequest}
              onClose={() => {
                renameAttemptRef.current += 1;
                setRenameRequest(null);
              }}
              onRename={(input) => renameSession.mutateAsync(input)}
            />
            <CreateSubsessionDialog
              parent={subsessionParent}
              agents={[
                ...(agentsData?.agents.map((agent) => ({
                  id: agent.id,
                  name: agent.name,
                })) ?? []),
                ...Object.entries(projectAgentNames).map(([id, name]) => ({
                  id,
                  name,
                })),
              ]}
              defaultAgentId={effectiveDefaultAgentId}
              pending={createSubsession.isPending}
              error={subsessionError}
              onClose={() => setSubsessionParent(null)}
              onCreate={(input) => {
                if (!subsessionParent) return;
                setSubsessionError(null);
                void createSubsession
                  .mutateAsync({
                    parentSessionId: subsessionParent.id,
                    ...input,
                  })
                  .then((session) => {
                    setSubsessionParent(null);
                    openSession(session);
                  })
                  .catch((cause) => {
                    setSubsessionError(
                      cause instanceof Error ? cause.message : String(cause),
                    );
                  });
              }}
            />
            <ArchiveSessionDialog
              session={archiveRequest?.session ?? null}
              sessionCount={archiveRequest?.sessionIds.length ?? 0}
              runningCount={archiveRequest?.runningCount ?? 0}
              watcherCount={archiveRequest?.watcherCount ?? 0}
              watchers={archiveRequest?.watchers ?? []}
              processCount={archiveRequest?.processCount ?? 0}
              pending={archiveSession.isPending}
              error={archiveError}
              onClose={() => setArchiveRequest(null)}
              onConfirm={() => {
                if (archiveRequest) void finishArchive(archiveRequest);
              }}
            />
            <TabbedSidebar
              key={`left:${activeProfile?.id}:${projectId}`}
              side="left"
              scope={`${activeProfile?.id}:${projectId}`}
              tabs={sidebarTabs("left")}
              surface={sidebarSurface}
              open={sidebarVisible}
              focusRequest={sidebarFocusRequest}
              sidebarRef={sidebarRef}
              overlay={compactWindow}
              revealed={revealed}
              error={workspaceError}
              onCustomize={() => customizeSidebar("left")}
              onMotionChange={setSidebarMotion}
              header={
                <>
                  <div
                    className={`app-drag flex h-10 shrink-0 items-center justify-end gap-1 pr-3 ${windowButtons ? "pl-[86px]" : "pl-3"} ${projectInSidebarHeader ? "mb-2" : ""}`}
                  >
                    {/* The project heads the sidebar across its width, as
                      it does below the buttons' row. This row keeps only
                      slivers to drag the window by; the chrome's empty
                      room does that (the tab strip's spare end, or the
                      title row), as Chrome's tab strip does. */}
                    {projectInSidebarHeader && (
                      <div
                        className="app-no-drag flex min-w-0 flex-1 items-center gap-1"
                        data-sidebar-project
                      >
                        {projectControls}
                      </div>
                    )}
                    {sidebarMotion.phase !== "closed" && sidebarToggle("left")}
                    {headerInSidebar && (
                      <div
                        ref={setBrowserNavigationHost}
                        className="app-no-drag flex items-center gap-1"
                        data-sidebar-navigation
                      />
                    )}
                  </div>
                  {headerInSidebar && (
                    <div
                      className={`relative z-30 mx-3 mb-2 h-8 ${activeHeaderTitle || chromeBrowserId ? "" : "hidden"}`}
                    >
                      {workspaceTitle}
                    </div>
                  )}

                  {!projectInSidebarHeader && (
                    <div
                      className="flex items-center gap-1 px-3 pb-3"
                      data-sidebar-project
                    >
                      {projectControls}
                    </div>
                  )}
                </>
              }
              footer={
                <footer className="flex h-12 shrink-0 items-center gap-1 px-3">
                  {profilesData && activeProfile && (
                    <ProfileBar
                      data={profilesData}
                      activeProfileId={activeProfile.id}
                      onSwitch={switchProfile}
                      onOpenSettings={(profileId) =>
                        openTab({
                          kind: "profile-settings",
                          name: profileId,
                          label:
                            profilesData.profiles.find(
                              (profile) => profile.id === profileId,
                            )?.name ?? "Profile",
                        })
                      }
                    />
                  )}
                  <ShortcutHint label="Customize sidebar" side="top">
                    <button
                      type="button"
                      onClick={() => customizeSidebar("left")}
                      className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay/60 hover:text-fg"
                      aria-label="Customize sidebar"
                    >
                      <Wand2 className="size-3.5" />
                    </button>
                  </ShortcutHint>
                  <ShortcutHint label="Settings" side="top">
                    <button
                      type="button"
                      onClick={() =>
                        openTab({
                          kind: "settings",
                          name: "settings",
                          label: "Settings",
                        })
                      }
                      className={`grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay/60 hover:text-fg ${activeTab?.kind === "settings" ? "bg-bg-overlay/60 text-fg" : ""}`}
                      aria-label="Settings"
                    >
                      <SettingsIcon className="size-4" />
                      <span className="sr-only">Settings</span>
                    </button>
                  </ShortcutHint>
                </footer>
              }
              renderSection={renderSidebarSection("left")}
            />

            {/* min-h-0/overflow-hidden: the content column must clip its panes
          (terminal canvases refit asynchronously and may overshoot for a
          frame) rather than push the document taller than the window. */}
            <main
              data-workspace-content
              data-tab-layout={tabsInSidebar ? "sidebar" : "top"}
              data-header-placement={headerInSidebar ? "sidebar" : "top"}
              data-content-frame={prefs?.contentFrame ? "on" : "off"}
              style={{
                margin: prefs?.contentFrame ? prefs.contentPadding : 0,
                borderRadius: prefs?.contentFrame ? prefs.contentRadius : 0,
              }}
              className={`workspace-surface relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${tabsInSidebar ? "bg-sidebar" : "bg-bg"}`}
            >
              {headerInSidebar &&
                (!rightSidebarMotion.docked || rightSidebarMotion.push) && (
                  <span
                    inert={rightSidebarMotion.phase !== "closed"}
                    data-chrome-toggle="right-float"
                    data-folded={rightSidebarMotion.docked || undefined}
                    className="chrome-toggle-float app-no-drag absolute right-2 top-2 z-20 flex rounded-md bg-sidebar"
                  >
                    {sidebarToggle("right")}
                  </span>
                )}
              {compactWindow && (
                <button
                  type="button"
                  data-sidebar-reveal-edge
                  aria-label="Show sidebar"
                  tabIndex={revealed ? -1 : 0}
                  className={`absolute inset-y-0 left-0 z-40 w-1.5 cursor-default ${revealed ? "pointer-events-none" : ""}`}
                  onPointerEnter={revealOnHover}
                  onFocus={reveal}
                  onClick={reveal}
                />
              )}
              {!headerInSidebar && (
                <div className="workspace-chrome app-drag relative z-20 flex h-10 shrink-0 items-center gap-1 pl-2 pr-3">
                  {(!sidebarMotion.docked || sidebarMotion.push) && (
                    <span
                      // Under the panel until the content makes room; the
                      // panel's own toggle is the live one. Moving with the
                      // panel (push), it folds and unfolds as the panel
                      // slides, so the tabs after it never jump.
                      inert={sidebarMotion.phase !== "closed"}
                      data-chrome-toggle="left"
                      data-folded={sidebarMotion.docked || undefined}
                      // Not app-no-drag: the corner kept for the window
                      // buttons still drags the window.
                      className="chrome-toggle-slot flex shrink-0 items-center"
                    >
                      <span
                        className={`app-no-drag flex shrink-0 items-center ${windowButtons ? "ml-[70px]" : ""}`}
                      >
                        {sidebarToggle("left")}
                      </span>
                    </span>
                  )}
                  {(projectId || allTabs.length > 0) &&
                    !tabsInSidebar &&
                    workspaceTabBar}
                  {projectId &&
                    tabsInSidebar &&
                    !headerInSidebar &&
                    workspaceTitle}
                  {(!rightSidebarMotion.docked || rightSidebarMotion.push) && (
                    <span
                      // Under the panel until the content makes room; the
                      // panel's own toggle is the live one.
                      inert={rightSidebarMotion.phase !== "closed"}
                      data-chrome-toggle="right"
                      data-folded={rightSidebarMotion.docked || undefined}
                      className="chrome-toggle-slot app-no-drag ml-auto flex shrink-0 items-center justify-end"
                    >
                      {sidebarToggle("right")}
                    </span>
                  )}
                </div>
              )}

              {projectId ? (
                <div
                  data-workspace-chat-region
                  className={`workspace-content relative flex min-h-0 flex-1 flex-col bg-bg ${tabsInSidebar ? "overflow-hidden" : ""}`}
                >
                  {/* Every tab pane lives in this wrapper so keyboard cycling
                  can nudge the visible content from the direction of
                  travel; chat docks and bubbles stay outside (they own
                  their own motion). */}
                  <div
                    className={`relative flex min-h-0 flex-1 flex-col ${
                      paneMotion
                        ? paneMotion.direction === "left"
                          ? "animate-pane-in-left"
                          : "animate-pane-in-right"
                        : ""
                    }`}
                    onAnimationEnd={(event) => {
                      if (event.animationName.startsWith("pane-in")) {
                        setPaneMotion(null);
                      }
                    }}
                  >
                    {workspace.floatingKey && (
                      <button
                        type="button"
                        aria-label="Dismiss floating panel"
                        className="absolute inset-0 z-20 cursor-default bg-black/15"
                        data-floating-backdrop={
                          floatingMotion.closing ? "closing" : "open"
                        }
                        onClick={dismissFloating}
                      />
                    )}
                    {/* Screen-style tabs render whenever they occupy a view
                    slot — in a split that can be two at once. */}
                    {workspace.tabs
                      .filter(
                        (tab) =>
                          tab.kind === "workflow" ||
                          viewSlots[tabKey(tab)] ||
                          tabKey(tab) === recedingSurface,
                      )
                      .map((tab) => (
                        <div
                          key={tabKey(tab)}
                          className={paneClass(tabKey(tab))}
                          style={paneStyle(tabKey(tab))}
                          {...paneFocusProps(tabKey(tab))}
                        >
                          {floatingBar(tabKey(tab))}
                          {isSplitSlot(tabKey(tab)) && (
                            <PaneUnsplitButton
                              onClick={() => openSurface(tabKey(tab), "tab")}
                            />
                          )}
                          {tab.kind === "workflow" ? (
                            <Suspense
                              fallback={<div className="flex-1 bg-bg" />}
                            >
                              <WorkflowScreen
                                projectId={projectId}
                                workflowName={tab.name}
                                canEdit={!memberShell}
                                active={
                                  runtime.visible &&
                                  Boolean(viewSlots[tabKey(tab)])
                                }
                                onAskAgent={(message) =>
                                  sendToAgent(message, "float", undefined, {
                                    watchBackdrop: true,
                                  })
                                }
                                onOpenSource={(path, line, column) => {
                                  void openLinkedSurface(
                                    `file:${path}${line ? `:${line}${column ? `:${column}` : ""}` : ""}`,
                                    { side: true, newTab: true },
                                  ).catch((cause: unknown) =>
                                    setLinkError(
                                      cause instanceof Error
                                        ? cause.message
                                        : "Could not open source",
                                    ),
                                  );
                                }}
                                initialDraft={tab.workflowDraft}
                                onDraftChange={(workflowDraft) =>
                                  updateWorkspace((ws) => ({
                                    ...ws,
                                    tabs: ws.tabs.map((item) =>
                                      tabKey(item) === tabKey(tab)
                                        ? {
                                            ...item,
                                            draft: Boolean(workflowDraft),
                                            workflowDraft,
                                          }
                                        : item,
                                    ),
                                  }))
                                }
                              />
                            </Suspense>
                          ) : tab.kind === "run" ? (
                            <RunScreen projectId={projectId} runId={tab.name} />
                          ) : tab.kind === "artifact" ? (
                            <ArtifactScreen
                              projectId={projectId}
                              artifactId={tab.name}
                              onAskAgent={(message) =>
                                sendToAgent(message, "float")
                              }
                            />
                          ) : tab.kind === "app" ? (
                            <AppScreen
                              projectId={projectId}
                              appName={tab.name}
                            />
                          ) : tab.kind === "mcpapp" ? (
                            <McpAppScreen
                              toolKey={tab.toolKey}
                              toolInput={tab.toolInput}
                              toolResult={tab.toolResult}
                              onOpenLink={(url) => openBrowserTab(url)}
                            />
                          ) : tab.kind === "settings" ? (
                            <SettingsScreen
                              destination={tab.destination}
                              projectId={projectId}
                              onSearch={settingsSearch}
                              onAddAgent={() => setWizardModalOpen(true)}
                              onCreateAssistant={createAssistant}
                              onConfigureAgent={openConfigureAgent}
                              onManageConnectors={() =>
                                setConnectorsModalOpen(true)
                              }
                            />
                          ) : tab.kind === "profile-settings" &&
                            profilesData ? (
                            <ProfileSettingsScreen
                              profileId={tab.name}
                              activeProfileId={
                                activeProfile?.id ??
                                profilesData.defaultProfileId
                              }
                              data={profilesData}
                              projects={allProjects}
                              onClose={() => closeTab(tabKey(tab))}
                              onOpenPasswords={() => openPasswords(tab.name)}
                            />
                          ) : tab.kind === "history" ? (
                            <HistoryScreen
                              active={Boolean(viewSlots[tabKey(tab)])}
                              profileId={activeProfile?.id}
                              onSearch={historySearch}
                              onOpen={openHistory}
                            />
                          ) : tab.kind === "passwords" ? (
                            <PasswordsScreen profileId={tab.name} />
                          ) : tab.kind === "sites" ? (
                            <SitesScreen
                              active={Boolean(viewSlots[tabKey(tab)])}
                              onOpenSite={setSiteSettingsOrigin}
                            />
                          ) : tab.kind === "downloads" ? (
                            <DownloadsScreen
                              active={Boolean(viewSlots[tabKey(tab)])}
                              onOpen={openDownload}
                            />
                          ) : tab.kind === "extensions" ? (
                            <ExtensionsScreen
                              active={Boolean(viewSlots[tabKey(tab)])}
                              onOpenUrl={(url) => openBrowserTab(url)}
                            />
                          ) : tab.kind === "usage" ? (
                            <Suspense
                              fallback={<div className="flex-1 bg-bg" />}
                            >
                              <UsageScreen />
                            </Suspense>
                          ) : tab.kind === "palette" ? (
                            <CommandPalette
                              key={tabKey(tab)}
                              variant="tab"
                              onClose={() => closeTab(tabKey(tab))}
                              onTypedChange={(typed) =>
                                markNewTabTyped(tabKey(tab), typed)
                              }
                            />
                          ) : tab.kind === "agent-setup" ? (
                            <AgentWizard
                              variant="tab"
                              onClose={() => closeTab(tabKey(tab))}
                              onDone={() => closeTab(tabKey(tab))}
                              onEngagedChange={setWizardEngaged}
                            />
                          ) : tab.kind === "diff" ? (
                            <Suspense
                              fallback={<div className="flex-1 bg-bg" />}
                            >
                              <DiffScreen
                                onOpenArtifact={(target, title) => {
                                  void openLinkedSurface(target, {
                                    label: title,
                                    newTab: true,
                                  }).catch((error: unknown) =>
                                    setLinkError(
                                      error instanceof Error
                                        ? error.message
                                        : "Could not open review",
                                    ),
                                  );
                                }}
                                projectId={tab.projectId}
                                source={tab.source}
                              />
                            </Suspense>
                          ) : null}
                        </div>
                      ))}

                    {/* Browser tabs stay mounted while hidden — unmounting a
                  webview would reload the page on every tab switch. */}
                    {workspace.browsers.map((browser) => (
                      <div
                        key={browser.localId}
                        className={paneClass(browserTabKey(browser.localId))}
                        style={paneStyle(browserTabKey(browser.localId))}
                        {...paneFocusProps(browserTabKey(browser.localId))}
                      >
                        {floatingBar(browserTabKey(browser.localId))}
                        <BrowserScreen
                          profileId={browser.profileId}
                          projectId={projectId}
                          projectName={
                            projects.find((item) => item.id === projectId)?.name
                          }
                          // Remounts (project/profile switches) resume at the
                          // last known URL, not the tab's original one.
                          initialUrl={browser.url || browser.initialUrl}
                          history={browser.history}
                          surfaceKey={browserTabKey(browser.localId)}
                          active={
                            runtime.visible &&
                            browser.localId === activeBrowserTabId
                          }
                          toolbarActive={
                            runtime.visible &&
                            browser.localId === chromeBrowserId
                          }
                          integratedToolbar={
                            tabsInSidebar &&
                            viewSlots[browserTabKey(browser.localId)] !==
                              "floating"
                          }
                          toolbarHost={browserToolbarHost}
                          sidebarToolbar={
                            headerInSidebar &&
                            viewSlots[browserTabKey(browser.localId)] !==
                              "floating"
                          }
                          navigationHost={browserNavigationHost}
                          onRevealToolbar={() => {
                            if (!sidebarOpen) {
                              setSidebarOpen(true);
                              void desktopApi.setPrefs({ sidebarOpen: true });
                            }
                          }}
                          visible={
                            runtime.visible &&
                            Boolean(viewSlots[browserTabKey(browser.localId)])
                          }
                          keepAwake={busyBrowsers.has(browser.localId)}
                          asleep={tabSleep.asleep(browser.localId)}
                          onStateChange={(state) =>
                            onBrowserState(browser.localId, state)
                          }
                          onPageClose={() =>
                            closeTab(browserTabKey(browser.localId), {
                              final: true,
                            })
                          }
                          onOpenSiteSettings={setSiteSettingsOrigin}
                          onOpenPasswords={() =>
                            openPasswords(browser.profileId)
                          }
                          onOpenExtensions={() =>
                            openTab({
                              kind: "extensions",
                              name: "extensions",
                              label: "Extensions",
                            })
                          }
                          onOpenUrl={(url) => openBrowserTab(url)}
                          previewLinksWithAlt={
                            prefs?.previewLinksWithAlt ?? true
                          }
                          floatingDismissShortcut={
                            keybindings["dismiss-floating"]
                          }
                          onDismissFloating={
                            workspace.floatingKey ===
                            browserTabKey(browser.localId)
                              ? dismissFloating
                              : undefined
                          }
                          onPreviewLink={(url, mode) =>
                            openBrowserTab(url, {
                              floating: mode === "floating",
                              side: mode === "side",
                            })
                          }
                          registerCommands={(commands) => {
                            if (commands)
                              browserCommandsRef.current.set(
                                browser.localId,
                                commands,
                              );
                            else
                              browserCommandsRef.current.delete(
                                browser.localId,
                              );
                          }}
                          registerNavigate={(navigate) =>
                            browserNavigatorsRef.current.set(
                              browser.localId,
                              navigate,
                            )
                          }
                          registerHistoryNavigate={(navigate) =>
                            browserHistoryNavigatorsRef.current.set(
                              browser.localId,
                              navigate,
                            )
                          }
                          registerGuest={(guestId) => {
                            if (guestId === null) {
                              browserGuestIdsRef.current.delete(
                                browser.localId,
                              );
                            } else {
                              browserGuestIdsRef.current.set(
                                browser.localId,
                                guestId,
                              );
                            }
                            reportExtensionTabsRef.current();
                          }}
                          onUnsplit={
                            isSplitSlot(browserTabKey(browser.localId))
                              ? () =>
                                  openSurface(
                                    browserTabKey(browser.localId),
                                    "tab",
                                  )
                              : undefined
                          }
                        />
                        <AgentControlOverlay
                          kind="page"
                          active={Boolean(browser.agentControlled)}
                          onTakeOver={() =>
                            takeOverSurface(browserTabKey(browser.localId))
                          }
                          onGoToChat={
                            browser.chatLocalId
                              ? () => goToChat(browser.chatLocalId as string)
                              : undefined
                          }
                        />
                      </div>
                    ))}

                    {/* Terminals stay mounted while hidden — unmounting kills
                  the shell. Editors likewise, preserving undo history,
                  scroll position, and unsaved drafts across switches. */}
                    {workspace.terminals.map((terminal) => (
                      <div
                        key={terminal.localId}
                        data-surface-pane
                        className={paneClass(terminalTabKey(terminal.localId))}
                        style={paneStyle(terminalTabKey(terminal.localId))}
                        {...paneFocusProps(terminalTabKey(terminal.localId))}
                      >
                        {floatingBar(terminalTabKey(terminal.localId))}
                        {isSplitSlot(terminalTabKey(terminal.localId)) && (
                          <PaneUnsplitButton
                            onClick={() =>
                              openSurface(
                                terminalTabKey(terminal.localId),
                                "tab",
                              )
                            }
                          />
                        )}
                        <Suspense fallback={<div className="flex-1 bg-bg" />}>
                          <TerminalScreen
                            projectId={projectId}
                            active={
                              runtime.visible &&
                              terminal.localId === activeTerminalTabId
                            }
                            initialCommand={terminal.initialCommand}
                            macroShortcuts={prefs?.terminalMacros.map(
                              (macro) => macro.shortcut,
                            )}
                            floating={
                              workspace.floatingKey ===
                              terminalTabKey(terminal.localId)
                            }
                            attachSessionId={terminal.attachSessionId}
                            restoreSessionId={terminal.restoreSessionId}
                            adoptSessionId={terminal.adoptSessionId}
                            {...(terminal.remoteSessionId
                              ? {
                                  remoteChat: {
                                    sessionId: terminal.remoteSessionId,
                                  },
                                }
                              : {})}
                            readOnly={Boolean(terminal.agentControlled)}
                            onTitle={(title) =>
                              onTerminalTitle(terminal.localId, title)
                            }
                            onSession={(ptySessionId) =>
                              updateWorkspace((ws) => ({
                                ...ws,
                                terminals: ws.terminals.map((t) =>
                                  t.localId === terminal.localId
                                    ? { ...t, ptySessionId }
                                    : t,
                                ),
                              }))
                            }
                            onExit={() => {
                              // An agent terminal ended with its command: its
                              // chip leaves, a tab stays to read. User
                              // terminals close as before.
                              if (terminal.attachSessionId) {
                                updateTerminals({
                                  type: "terminal-ended",
                                  sessionId: terminal.attachSessionId,
                                });
                              } else {
                                closeTab(terminalTabKey(terminal.localId));
                              }
                            }}
                          />
                        </Suspense>
                        <AgentControlOverlay
                          kind="terminal"
                          active={Boolean(terminal.agentControlled)}
                          onTakeOver={() =>
                            takeOverSurface(terminalTabKey(terminal.localId))
                          }
                          onGoToChat={
                            terminal.chatLocalId
                              ? () => goToChat(terminal.chatLocalId as string)
                              : undefined
                          }
                        />
                      </div>
                    ))}

                    {workspace.editors.map((editor) => (
                      <div
                        key={editor.localId}
                        className={paneClass(editorTabKey(editor.localId))}
                        style={paneStyle(editorTabKey(editor.localId))}
                        {...paneFocusProps(editorTabKey(editor.localId))}
                      >
                        {floatingBar(editorTabKey(editor.localId))}
                        {isSplitSlot(editorTabKey(editor.localId)) && (
                          <PaneUnsplitButton
                            onClick={() =>
                              openSurface(editorTabKey(editor.localId), "tab")
                            }
                          />
                        )}
                        <Suspense fallback={<div className="flex-1 bg-bg" />}>
                          <EditorScreen
                            line={editor.line}
                            column={editor.column}
                            navigation={editor.navigation}
                            projectId={projectId}
                            filePath={editor.filePath}
                            onFindFile={() =>
                              focusSearch("search-files", "files")
                            }
                            onSharePersonal={
                              remoteSurfaceStatus
                                ? (path, intent) => {
                                    sendToAgent(
                                      `${intent === "propose" ? "Prepare and submit a proposal to add" : "Prepare to publish"} my local file ${JSON.stringify(path)} to this company project. Read this file, choose a suitable shared location using the project conventions, and include only this file and any dependencies it needs. Keep my local original until sharing succeeds. ${intent === "publish" ? "Show me the audience before creating the publication." : "Submit through the company proposal service and show me the review link."}`,
                                      "float",
                                    );
                                  }
                                : undefined
                            }
                            onDirtyChange={(dirty) =>
                              onEditorState(editor.localId, { dirty })
                            }
                            onShare={
                              editor.filePath?.startsWith(
                                `${PROJECT_STORE_DIR}/`,
                              ) &&
                              remoteSurfaceStatus &&
                              remoteSurfaceStatus.capabilities?.features
                                .publications !== false
                                ? (path) =>
                                    setRemotePublish({
                                      path: path.startsWith(
                                        `${PROJECT_APP_DATA_DIR}/`,
                                      )
                                        ? path.slice(
                                            PROJECT_APP_DATA_DIR.length + 1,
                                          )
                                        : path,
                                      features:
                                        remoteSurfaceStatus.capabilities
                                          ?.features,
                                    })
                                : undefined
                            }
                            onPropose={
                              remoteSurfaceStatus &&
                              remoteSurfaceStatus.capabilities?.features
                                .proposals !== false &&
                              !editor.filePath?.startsWith(
                                `${PROJECT_STORE_DIR}/`,
                              )
                                ? (path) =>
                                    setRemotePropose({
                                      files: [path],
                                      features:
                                        remoteSurfaceStatus.capabilities
                                          ?.features,
                                    })
                                : undefined
                            }
                          />
                        </Suspense>
                      </div>
                    ))}
                  </div>

                  {/* Split divider: drag to resize. The full-region overlay
                  during a drag keeps webviews from swallowing the moves. */}
                  {split && (
                    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only resize handle; the split is keyboard-reachable via Cmd+\ and tab focus
                    <div
                      data-split-divider
                      onMouseDown={startDividerDrag}
                      className={`absolute inset-y-0 z-40 w-[7px] -translate-x-1/2 cursor-col-resize ${
                        dividerDragging
                          ? ""
                          : "transition-[left] duration-200 ease-[cubic-bezier(0.2,0,0,1)]"
                      }`}
                      style={{ left: `${splitRatio * 100}%` }}
                    >
                      <div className="mx-auto h-full w-px bg-transparent transition-colors duration-150 hover:bg-accent/60" />
                    </div>
                  )}
                  {dividerDragging && (
                    <div className="absolute inset-0 z-50 cursor-col-resize" />
                  )}

                  {/* Dragging a tab: side drop zones tile it left or right. While
                a chat is in front, the bottom band stays clear of the zones
                so the tab can be dropped on the chat's composer instead
                (it becomes a tab pill there). */}
                  {tabDragKey && (
                    <div
                      className={`absolute inset-x-0 top-0 z-50 flex ${
                        workspace.chats.some(
                          (entry) =>
                            entry.mode === "partial" ||
                            Boolean(viewSlots[chatTabKey(entry.localId)]),
                        )
                          ? "bottom-40"
                          : "bottom-0"
                      }`}
                    >
                      {(["left", "right"] as const).map((side) => (
                        // biome-ignore lint/a11y/noStaticElementInteractions: drop target for an in-progress HTML5 drag only
                        <div
                          key={side}
                          onDragOver={(event) => {
                            event.preventDefault();
                            setDropSideHover(side);
                          }}
                          onDragLeave={() =>
                            setDropSideHover((current) =>
                              current === side ? null : current,
                            )
                          }
                          onDrop={(event) => {
                            event.preventDefault();
                            dropTabToSide(tabDragKey, side);
                            setTabDragKey(null);
                            setDropSideHover(null);
                          }}
                          className={`flex-1 border-2 border-dashed transition-colors duration-150 ${
                            dropSideHover === side
                              ? "border-accent/60 bg-accent/10"
                              : "border-transparent"
                          }`}
                        />
                      ))}
                    </div>
                  )}

                  {workspace.chats.map((entry) => (
                    <ChatRegistration
                      onReveal={() => revealChat(entry.localId)}
                      selected={entry.localId === workspace.activeChatId}
                      projectName={activeProject?.name ?? "Project"}
                      icon={chatIcons[entry.localId] ?? null}
                      fork={chatForks[entry.localId] ?? false}
                      unread={unreadByChat[entry.localId] ?? false}
                      attention={attentionByChat[entry.localId] ?? false}
                      menu={chatMenus[entry.localId] ?? []}
                      onMenuAction={(action) => {
                        if (entry.sessionId)
                          applySessionAction(entry.sessionId, action.action);
                      }}
                      key={entry.localId}
                      projectId={projectId}
                      entry={entry}
                      title={chatLabels[entry.localId] ?? "AI assistant"}
                      tabActive={Boolean(viewSlots[chatTabKey(entry.localId)])}
                      refreshWhileIdle={
                        entry.localId === workspace.activeChatId &&
                        chatVisible(workspace, entry)
                      }
                      slot={
                        viewSlots[chatTabKey(entry.localId)] === "left"
                          ? "left"
                          : viewSlots[chatTabKey(entry.localId)] === "right"
                            ? "right"
                            : "full"
                      }
                      splitRatio={splitRatio}
                      splitResizing={dividerDragging}
                      bubbleClearance="strip"
                      backdropTab={
                        workspace.activeTabKey !== undefined &&
                        workspace.activeTabKey !== chatTabKey(entry.localId)
                      }
                      defaultAgentId={effectiveDefaultAgentId ?? undefined}
                      paletteTargeted={entry.localId === targetedChat?.localId}
                      chips={chipsFor(entry)}
                      chipsModule={
                        // A local project, once known to be one: a connected
                        // project's chats run no modules (ADR 0239).
                        experienceRoot
                          ? chipsModule(visibleWorkspace)
                          : undefined
                      }
                      onCustomizeChips={openChipsCustomization}
                      onOpenSurface={openSurface}
                      onRemoveSurface={removeSurface}
                      onOpenMcpApp={(view, mode) => {
                        const name = view.toolUseId;
                        openTab(
                          {
                            kind: "mcpapp",
                            name,
                            label: view.title,
                            toolKey: view.toolKey,
                            toolInput: view.toolInput,
                            toolResult: view.toolResult,
                          },
                          mode === "split" ? "side" : mode,
                        );
                      }}
                      onLinkClick={(url, modifiers) =>
                        openMessageLink(url, entry, modifiers)
                      }
                      onFileClick={(path, modifiers) =>
                        openMessageLink(
                          `file:${path}`,
                          entry,
                          modifiers ?? {
                            metaKey: false,
                            ctrlKey: false,
                            altKey: false,
                            shiftKey: false,
                          },
                        )
                      }
                      onFork={(messageId) => forkChat(entry, messageId)}
                      onForkCurrent={() => forkChat(entry)}
                      archived={Boolean(
                        entry.sessionId &&
                          archivedSessionIds.has(entry.sessionId),
                      )}
                      onArchive={
                        entry.sessionId
                          ? () =>
                              applySessionAction(
                                entry.sessionId!,
                                archivedSessionIds.has(entry.sessionId!)
                                  ? "unarchive"
                                  : "archive",
                              )
                          : undefined
                      }
                      inspectRequestNonce={
                        sessionInspectRequests[entry.localId]
                      }
                      onOpenParent={
                        chatForks[entry.localId]
                          ? () => openParentChat(entry)
                          : undefined
                      }
                      onEditAgent={() => {
                        revealChat(entry.localId);
                        openPalettePicker("switch-agent");
                      }}
                      onEditModel={() => {
                        revealChat(entry.localId);
                        openPalettePicker("model");
                      }}
                      runtimeSettingsError={
                        updateSession.variables?.sessionId === entry.sessionId
                          ? updateSession.error?.message
                          : null
                      }
                      onEditEffort={() => {
                        revealChat(entry.localId);
                        openPalettePicker("effort");
                      }}
                      onEditPermissionMode={() => {
                        revealChat(entry.localId);
                        openPalettePicker("permission-mode");
                      }}
                      pullSelectionNonce={selectionPulls[entry.localId] ?? 0}
                      onFocusRequest={
                        split &&
                        viewSlots[chatTabKey(entry.localId)] &&
                        workspace.activeTabKey !== chatTabKey(entry.localId)
                          ? () => selectTab(chatTabKey(entry.localId))
                          : undefined
                      }
                      onUnsplit={
                        viewSlots[chatTabKey(entry.localId)] &&
                        viewSlots[chatTabKey(entry.localId)] !== "full"
                          ? () => openSurface(chatTabKey(entry.localId), "tab")
                          : undefined
                      }
                      onEntryChange={(next) =>
                        updateWorkspace((ws) => ({
                          ...ws,
                          activeChatId: next.localId,
                          activeTabKey:
                            next.mode === "tab"
                              ? chatTabKey(next.localId)
                              : ws.activeTabKey === chatTabKey(next.localId)
                                ? nextActiveTabKey(
                                    ws,
                                    chatTabKey(next.localId),
                                    ws.chats.map((chat) =>
                                      chat.localId === next.localId
                                        ? next
                                        : chat,
                                    ),
                                  )
                                : ws.activeTabKey,
                          chats: ws.chats.map((chat) =>
                            chat.localId === next.localId ? next : chat,
                          ),
                        }))
                      }
                      onEscapeToFloating={(localId) => {
                        lastChatStepDownRef.current = {
                          localId,
                          at: performance.now(),
                        };
                      }}
                      onClose={closeChat}
                      onCloseStarted={() =>
                        closingChatIds.current.add(entry.localId)
                      }
                      registerClose={(close) =>
                        chatClosersRef.current.set(entry.localId, close)
                      }
                      registerFocusChips={(focus) =>
                        chipFocusersRef.current.set(entry.localId, focus)
                      }
                      registerMinimize={(minimize) =>
                        chatMinimizersRef.current.set(entry.localId, minimize)
                      }
                      registerSend={(send) =>
                        chatSendersRef.current.set(entry.localId, send)
                      }
                      registerSkill={(apply) =>
                        chatSkillsRef.current.set(entry.localId, apply)
                      }
                      registerComposerReturn={(resume) =>
                        composerReturnsRef.current.set(entry.localId, resume)
                      }
                      onOpenSkills={() => openSkills(entry.localId)}
                      onSessionCreated={onSessionCreated}
                      onSessionAgent={onSessionAgent}
                      onSignalsChange={onSignalsChange}
                    />
                  ))}
                </div>
              ) : activeTab?.kind === "settings" ? (
                <SettingsScreen
                  destination={activeTab.destination}
                  onSearch={settingsSearch}
                  onAddAgent={() => setWizardModalOpen(true)}
                  onCreateAssistant={createAssistant}
                  onConfigureAgent={openConfigureAgent}
                  onManageConnectors={() => setConnectorsModalOpen(true)}
                />
              ) : activeTab?.kind === "history" ? (
                <HistoryScreen
                  profileId={activeProfile?.id}
                  onSearch={historySearch}
                  onOpen={openHistory}
                />
              ) : activeTab?.kind === "passwords" ? (
                <PasswordsScreen profileId={activeTab.name} />
              ) : activeTab?.kind === "sites" ? (
                <SitesScreen onOpenSite={setSiteSettingsOrigin} />
              ) : activeTab?.kind === "downloads" ? (
                <DownloadsScreen onOpen={openDownload} />
              ) : activeTab?.kind === "extensions" ? (
                <ExtensionsScreen onOpenUrl={(url) => openBrowserTab(url)} />
              ) : activeTab?.kind === "profile-settings" && profilesData ? (
                <ProfileSettingsScreen
                  profileId={activeTab.name}
                  activeProfileId={
                    activeProfile?.id ?? profilesData.defaultProfileId
                  }
                  data={profilesData}
                  projects={allProjects}
                  onClose={() => closeTab(tabKey(activeTab))}
                  onOpenPasswords={() => openPasswords(activeTab.name)}
                />
              ) : workspace.browsers.length > 0 ? (
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {workspace.browsers.map((browser) => (
                    <div
                      key={browser.localId}
                      className={paneClass(browserTabKey(browser.localId))}
                      style={paneStyle(browserTabKey(browser.localId))}
                      {...paneFocusProps(browserTabKey(browser.localId))}
                    >
                      <BrowserScreen
                        profileId={browser.profileId}
                        projectId={null}
                        floatingDismissShortcut={
                          keybindings["dismiss-floating"]
                        }
                        initialUrl={browser.url || browser.initialUrl}
                        history={browser.history}
                        surfaceKey={browserTabKey(browser.localId)}
                        active={
                          runtime.visible &&
                          browser.localId === activeBrowserTabId
                        }
                        visible={
                          runtime.visible &&
                          Boolean(viewSlots[browserTabKey(browser.localId)])
                        }
                        asleep={tabSleep.asleep(browser.localId)}
                        onStateChange={(state) =>
                          onBrowserState(browser.localId, state)
                        }
                        onPageClose={() =>
                          closeTab(browserTabKey(browser.localId), {
                            final: true,
                          })
                        }
                        onOpenSiteSettings={setSiteSettingsOrigin}
                        onOpenPasswords={() => openPasswords(browser.profileId)}
                        onOpenExtensions={() =>
                          openTab({
                            kind: "extensions",
                            name: "extensions",
                            label: "Extensions",
                          })
                        }
                        onOpenUrl={(url) => openBrowserTab(url)}
                        registerCommands={(commands) => {
                          if (commands)
                            browserCommandsRef.current.set(
                              browser.localId,
                              commands,
                            );
                          else
                            browserCommandsRef.current.delete(browser.localId);
                        }}
                        registerNavigate={(navigate) =>
                          browserNavigatorsRef.current.set(
                            browser.localId,
                            navigate,
                          )
                        }
                        registerHistoryNavigate={(navigate) =>
                          browserHistoryNavigatorsRef.current.set(
                            browser.localId,
                            navigate,
                          )
                        }
                        registerGuest={(guestId) => {
                          if (guestId === null) {
                            browserGuestIdsRef.current.delete(browser.localId);
                          } else {
                            browserGuestIdsRef.current.set(
                              browser.localId,
                              guestId,
                            );
                          }
                          reportExtensionTabsRef.current();
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  key={activeProfile?.id}
                  loading={projectsLoading}
                  loadError={projectsLoadError}
                  retrying={projectsFetching}
                  onRetry={() => void projectsQuery.refetch()}
                  onNewProject={() => setProjectModalOpen(true)}
                  onConnectRemote={() =>
                    setRemoteConnect({ open: true, link: null })
                  }
                  onStartWithAgent={startWithAgent}
                  profileId={activeProfile?.id}
                  importCompleted={Boolean(
                    activeProfile?.browserImportCompletedAt,
                  )}
                />
              )}
            </main>
            <TabbedSidebar
              key={`right:${activeProfile?.id}:${projectId}`}
              side="right"
              headerActions={
                rightSidebarMotion.phase !== "closed" && sidebarToggle("right")
              }
              scope={`${activeProfile?.id}:${projectId}`}
              tabs={sidebarTabs("right")}
              surface={sidebarSurface}
              open={rightSidebarOpen}
              focusRequest={rightSidebarFocusRequest}
              error={workspaceError}
              onCustomize={() => customizeSidebar("right")}
              onMotionChange={setRightSidebarMotion}
              renderSection={renderSidebarSection("right")}
            />

            {/* Stays mounted so the close transition can play out. */}
            <CommandPalette
              variant="overlay"
              open={paletteOpen}
              onClose={() => setPaletteOpen(false)}
              modeRequest={modeRequest}
            />

            {/* The wizard modal: same experience as the setup tab, reachable from
          chat gating, Settings, and the palette command. */}
            <AgentWizard
              variant="modal"
              open={wizardModalOpen}
              onClose={() => {
                setWizardModalOpen(false);
                setSidebarCustomization(null);
                wizardForAssistantRef.current = false;
              }}
              onDone={(agentId) => {
                setWizardModalOpen(false);
                if (wizardForAssistantRef.current && agentId)
                  void desktopApi.setPrefs({ voiceAssistant: agentId });
                wizardForAssistantRef.current = false;
              }}
              onEngagedChange={setWizardEngaged}
            />

            {/* Configure-agent modal (ADR 0056): palette picker + Settings both
          land here; project agents get the read-only definition view. */}
            <ConfigureAgentModal
              open={configureAgentOpen}
              agentId={configureAgentId}
              projectId={projectId}
              onClose={() => setConfigureAgentOpen(false)}
            />

            {/* Connectors manager: reachable from the palette and Settings. */}
            <ConnectorsModal
              open={connectorsModalOpen}
              onClose={() => {
                setConnectorsModalOpen(false);
                void finalizeConnectorRequest();
              }}
              // OAuth: the modal steps aside so the consent tab is visible, then
              // comes back once the callback landed. Stepping aside is not the
              // user closing it — an agent's request stays pending until then.
              onStepAside={() => setConnectorsModalOpen(false)}
              onReturn={() => setConnectorsModalOpen(true)}
              onOpenUrl={(url) => openBrowserTab(url)}
              agentRequest={
                connectorRequest
                  ? {
                      query: connectorRequest.query,
                      ...(connectorRequest.reason
                        ? { reason: connectorRequest.reason }
                        : {}),
                    }
                  : null
              }
            />

            {/* Boot veil: covers the workspace until its first real paint is
          ready, then fades — launch shows one composed frame, not pieces
          popping in. */}
            {!bootVeilGone && (
              <div
                className={`fixed inset-0 z-[400] bg-bg transition-opacity duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
                  bootRevealed ? "pointer-events-none opacity-0" : "opacity-100"
                }`}
                onTransitionEnd={() => {
                  if (bootRevealed) setBootVeilGone(true);
                }}
              />
            )}

            {/* In-place profile switch veil: opaque at the midpoint, so the
          workspace swap beneath it is never visible. */}
            {profileVeil && (
              <div
                className={`fixed inset-0 z-[300] bg-bg ${
                  profileVeil.stage === "in"
                    ? "animate-profile-veil-in"
                    : "animate-profile-veil-out"
                }`}
                onAnimationEnd={() => {
                  if (profileVeil.stage === "in" && profileVeil.target) {
                    void completeProfileSwitch(profileVeil.target);
                  } else if (profileVeil.stage === "out") {
                    setProfileVeil(null);
                  }
                }}
              />
            )}

            <Modal
              open={closingWorkflow !== null}
              onClose={() => setClosingWorkflow(null)}
              labelledBy="workflow-close-title"
            >
              <div className="p-5">
                <h2
                  id="workflow-close-title"
                  className="text-base font-semibold"
                >
                  Discard workflow edits?
                </h2>
                <p className="mt-2 text-sm text-fg-muted">
                  This workflow has unsaved changes. Keep editing to save them,
                  or discard the draft and close the tab.
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    className="button-ghost"
                    onClick={() => setClosingWorkflow(null)}
                  >
                    Keep editing
                  </button>
                  <button
                    type="button"
                    className="button-danger"
                    onClick={() => {
                      if (closingWorkflow)
                        closeTab(closingWorkflow, { discardDraft: true });
                      setClosingWorkflow(null);
                    }}
                  >
                    Discard and close
                  </button>
                </div>
              </div>
            </Modal>
            <ProjectModal
              open={projectModalOpen}
              onClose={() => setProjectModalOpen(false)}
              onCreated={(project) => {
                setProjectModalOpen(false);
                selectProject(project.id);
              }}
            />
            <DeleteProjectModal
              project={deletingProject}
              onClose={() => setDeletingProject(null)}
              onDeleted={onProjectDeleted}
            />
            <RemoteConnectModal
              open={remoteConnect.open}
              link={remoteConnect.link}
              onClose={() => setRemoteConnect({ open: false, link: null })}
              onConnected={async (project) => {
                if (activeProfile) {
                  await desktopApi.profilesClaimProject(
                    activeProfile.id,
                    project.id,
                  );
                }
                setRemoteConnect({ open: false, link: null });
                selectProject(project.id);
              }}
            />
            {projectId && (
              <>
                <RemoteHistoryModal
                  projectId={projectId}
                  path={remoteHistoryPath}
                  onClose={() => setRemoteHistoryPath(null)}
                />
                <RemoteMembersModal
                  open={serverDialog === "members"}
                  projectId={projectId}
                  onClose={() => setServerDialog(null)}
                />
                <RemoteServiceConnectionsModal
                  open={serverDialog === "connections"}
                  projectId={projectId}
                  onClose={() => setServerDialog(null)}
                />
                <RemoteSecretsModal
                  open={serverDialog === "secrets"}
                  projectId={projectId}
                  canManage={
                    remoteSurfaceStatus?.capabilities?.permissions.includes(
                      "secrets:write",
                    ) ?? false
                  }
                  canListMembers={
                    remoteSurfaceStatus?.capabilities?.permissions.includes(
                      "memberships:read",
                    ) ?? false
                  }
                  onClose={() => setServerDialog(null)}
                />
                <RemotePublishModal
                  projectId={projectId}
                  path={remotePublish?.path ?? null}
                  features={remotePublish?.features}
                  onClose={() => setRemotePublish(null)}
                />
                <RemoteProposeModal
                  projectId={projectId}
                  open={remotePropose !== null}
                  files={remotePropose?.files ?? []}
                  onClose={() => setRemotePropose(null)}
                  onOpenProposal={({ number, title }) =>
                    openTab({
                      kind: "diff",
                      name: `review:${number}`,
                      label: `#${number} ${title}`,
                      projectId,
                      source: { type: "review", prNumber: number },
                    })
                  }
                />
              </>
            )}
          </div>
        </PaletteHostProvider>
      </SidebarHostProvider>
    </WorkSourcesProvider>
  );
}

function EmptyState({
  profileId,
  importCompleted,
  loading,
  loadError,
  retrying,
  onRetry,
  onNewProject,
  onConnectRemote,
  onStartWithAgent,
}: {
  profileId?: string;
  importCompleted: boolean;
  loading: boolean;
  loadError: boolean;
  retrying: boolean;
  onRetry: () => void;
  onNewProject: () => void;
  onConnectRemote: () => void;
  onStartWithAgent: () => Promise<void>;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [justImported, setJustImported] = useState(false);
  const imported = importCompleted || justImported;
  const [startingAgent, setStartingAgent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (startingAgent) return;
    setStartingAgent(true);
    setError(null);
    try {
      await onStartWithAgent();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStartingAgent(false);
    }
  };

  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-xs text-left">
        {loadError ? (
          <div role="alert" data-testid="project-load-error">
            <h1 className="text-sm font-medium text-fg">
              Could not load your projects
            </h1>
            <p className="mt-2 text-sm text-fg-muted">
              Try again. If the problem continues, quit and reopen Work.
            </p>
            <PendingButton
              type="button"
              pending={retrying}
              onClick={onRetry}
              className="mt-4 h-8 cursor-pointer rounded-md border border-border px-3 text-[13px] text-fg transition-colors duration-150 hover:bg-bg-overlay disabled:cursor-not-allowed disabled:opacity-60"
            >
              Retry loading projects
            </PendingButton>
          </div>
        ) : loading ? (
          <p className="animate-pulse text-sm text-fg-muted">Loading…</p>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-fg">
              Make yourself at home
            </h1>
            <p className="mt-2 text-[13px] leading-5 text-fg-muted">
              Bring your browser with you, then choose where to start.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <PendingButton
                pending={false}
                type="button"
                disabled={!profileId || startingAgent}
                data-disabled-reason={
                  !profileId ? "Loading this profile" : "Starting the agent"
                }
                done={imported}
                doneLabel={
                  <span className="inline-flex items-center gap-2">
                    <Check className="size-3.5 text-success" />
                    Browser import complete
                  </span>
                }
                onClick={() => setImportOpen(true)}
                data-testid="onboarding-browser-import"
                className="browser-setup-action"
              >
                <span className="inline-flex items-center gap-2">
                  <Download className="size-3.5" />
                  Import from a browser
                </span>
              </PendingButton>
              <DefaultBrowserButton />
              <div className="my-2 border-t border-border" />
              <PendingButton
                type="button"
                pending={startingAgent}
                pendingLabel="Starting…"
                onClick={() => void start()}
                data-testid="empty-start-agent"
                className="button-primary h-9 w-full"
              >
                <span className="inline-flex items-center gap-2">
                  <Sparkles className="size-3.5" />
                  Start with an agent
                </span>
              </PendingButton>
              <button
                type="button"
                onClick={onNewProject}
                disabled={startingAgent}
                data-disabled-reason="Starting the agent"
                className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-border px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
              >
                <FolderPlus className="size-3.5" />
                Create or import project
              </button>
              <button
                type="button"
                onClick={onConnectRemote}
                disabled={startingAgent}
                data-disabled-reason="Starting the agent"
                data-testid="empty-connect-remote"
                className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-border px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Link2 className="size-3.5" />
                Connect to a server
              </button>
            </div>
            {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}
            {profileId && (
              <BrowserImportDialog
                open={importOpen}
                profileId={profileId}
                onClose={() => setImportOpen(false)}
                onComplete={() => setJustImported(true)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
