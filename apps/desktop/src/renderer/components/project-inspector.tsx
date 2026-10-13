import { useCatamorphic } from "@catamorphic/react";
import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Box, CheckCircle2, MoreHorizontal } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { writesProgram } from "../../shared/project-experience.js";
import { desktopApi, type RemoteProjectStatus } from "../lib/desktop-api.js";
import { CopyButton } from "./copy-button.js";
import { LazyList } from "./lazy-list.js";
import { type MenuAt, MenuPortal, menuAtControl } from "./menu.js";
import { useHoldInspector, useInspectorPending } from "./resource-inspector.js";
import { ShortcutHint } from "./shortcut-hint.js";

export type ProjectInspectorSession = Pick<AgentSession, "id"> &
  Partial<
    Pick<
      AgentSession,
      "title" | "running" | "status" | "attentionRequired" | "resumable"
    >
  >;

/**
 * What the card shows beyond the project's summary. Each value is
 * `undefined` while it loads, so it holds its line, and "unavailable" when
 * reading it failed; `null` is a known absence (no folder, no server).
 */
export interface ProjectInspectorData {
  root: string | null | "unavailable" | undefined;
  server: RemoteProjectStatus | null | "unavailable" | undefined;
  /** Other projects only: the current one's chats are in the sidebar. */
  sessions: ProjectInspectorSession[] | "unavailable" | undefined;
}

/** A glance, not a live view: reads within this long are reused. */
const SESSIONS_FRESH_MS = 5_000;

/**
 * The card's reads, shared by the card and its warmup so a hover that
 * rests on a project loads them before the card opens. Pull requests and
 * worktrees belong to a chat ("This session"), not to this card.
 */
export function useProjectInspectorData(
  projectId: string,
  current: boolean,
): ProjectInspectorData {
  const root = useQuery({
    queryKey: ["desktop", "project-root", projectId],
    queryFn: () => desktopApi.projectRoot(projectId),
    staleTime: 60_000,
    retry: false,
  });
  // A connected project's status asks its server; a local one answers here.
  const server = useQuery({
    queryKey: ["desktop", "project-server-status", projectId],
    queryFn: () => desktopApi.remoteStatus(projectId),
    staleTime: 15_000,
    retry: false,
  });
  // Another project's chats, read again only once they are a few seconds
  // old, so the warmup's read serves the card that opens after it.
  const { apiClient } = useCatamorphic();
  const sessions = useQuery({
    queryKey: ["desktop", "project-card-sessions", projectId],
    queryFn: async () => {
      const result = await apiClient.GET(
        "/api/projects/{projectId}/agent/sessions",
        { params: { path: { projectId }, query: { limit: 100 } } },
      );
      if (!result.data) throw new Error("Sessions are unavailable");
      return result.data.items;
    },
    enabled: !current,
    staleTime: SESSIONS_FRESH_MS,
    refetchInterval: SESSIONS_FRESH_MS,
    retry: false,
  });
  return {
    root: root.isError ? "unavailable" : root.data,
    server: server.isError ? "unavailable" : server.data,
    sessions: current ? [] : sessions.isError ? "unavailable" : sessions.data,
  };
}

/** Starts the card's reads while the pointer rests on its trigger. */
export function ProjectInspectorWarmup({
  projectId,
  current,
}: {
  projectId: string;
  current: boolean;
}) {
  useProjectInspectorData(projectId, current);
  return null;
}

export function ProjectInspector({
  project,
  current,
  onDelete,
}: {
  project: ProjectSummary;
  current: boolean;
  onDelete: () => void;
}) {
  return (
    <ProjectInspectorView
      project={project}
      current={current}
      data={useProjectInspectorData(project.id, current)}
      onDelete={onDelete}
    />
  );
}

/**
 * A project's hover card: its name, where it lives (folder, Git remote,
 * Work server), another project's ongoing sessions, and its actions behind
 * ⋯. Every line keeps its height while its value loads, so the card opens
 * at its size and stays there.
 */
export function ProjectInspectorView({
  project,
  current,
  data,
  onDelete,
}: {
  project: ProjectSummary;
  current: boolean;
  data: ProjectInspectorData;
  onDelete: () => void;
}) {
  const actionsRef = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<MenuAt | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const picked = useRef(false);
  // The menu's shield covers the card; the card stays until it has gone.
  useHoldInspector(menuAt !== null);
  // The card appears once what it shows has landed (or soon after).
  useInspectorPending(
    data.root === undefined ||
      data.server === undefined ||
      (!current && data.sessions === undefined),
  );
  const server = data.server;
  // Only a project known to be this person's to delete says Delete; until
  // its server answers, the safe word is removing the copy here.
  const deletes =
    server === null ||
    (typeof server === "object" && writesProgram(server.capabilities));
  const remote = project.remoteUrl ? displayRemote(project.remoteUrl) : null;

  return (
    <div className="text-[12px] text-fg-muted" data-testid="project-inspector">
      <header className="flex items-center gap-2.5 border-b border-border pb-2.5">
        <Box aria-hidden="true" className="size-4 shrink-0 text-accent" />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <h2 className="truncate text-[13px] font-semibold text-fg">
            {project.name}
          </h2>
          {current && (
            <span className="shrink-0 rounded bg-bg-raised px-1.5 py-px text-[10px] font-medium text-fg-muted">
              Current
            </span>
          )}
        </div>
        <ShortcutHint label="Project actions">
          <button
            ref={actionsRef}
            type="button"
            aria-label={`Actions for ${project.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              if (!actionsRef.current) return;
              // A pick from a menu that has since been dismissed is gone.
              picked.current = false;
              setMenuAt(menuAtControl(actionsRef.current));
              setMenuOpen(true);
            }}
            className={`grid size-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors duration-150 hover:bg-bg-raised hover:text-fg ${
              menuOpen ? "bg-bg-raised text-fg" : "text-fg-muted"
            }`}
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </button>
        </ShortcutHint>
      </header>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 py-2.5 text-[11px]">
        <dt className="text-fg-faint">Folder</dt>
        <dd className="min-w-0" aria-busy={data.root === undefined}>
          {data.root === undefined ? (
            <Pending width="70%" />
          ) : data.root === "unavailable" ? (
            <Absent>Unavailable</Absent>
          ) : data.root === null ? (
            <Absent>None</Absent>
          ) : (
            <CopyableValue value={data.root} copyLabel="Copy folder path" />
          )}
        </dd>
        <dt className="text-fg-faint">Git remote</dt>
        <dd className="min-w-0">
          {remote ? (
            <CopyableValue value={remote} copyLabel="Copy Git remote" />
          ) : (
            <Absent>None</Absent>
          )}
        </dd>
        <dt className="text-fg-faint">Work server</dt>
        <dd className="min-w-0" aria-busy={server === undefined}>
          {server === undefined ? (
            <Pending width="55%" />
          ) : server === "unavailable" ? (
            <Absent>Unavailable</Absent>
          ) : server === null ? (
            <Absent>None</Absent>
          ) : (
            <ServerValue status={server} />
          )}
        </dd>
      </dl>

      {!current && <SessionsSection sessions={data.sessions} />}

      {menuAt && (
        <MenuPortal
          open={menuOpen}
          at={menuAt}
          anchor={actionsRef}
          label={`Actions for ${project.name}`}
          entries={[
            {
              action: "delete",
              label: deletes ? "Delete project…" : "Remove from this device…",
              danger: true,
            },
          ]}
          onPick={() => {
            picked.current = true;
            setMenuOpen(false);
          }}
          onDismiss={() => setMenuOpen(false)}
          onExited={() => {
            setMenuAt(null);
            if (!picked.current) return;
            picked.current = false;
            onDelete();
          }}
        />
      )}
    </div>
  );
}

function SessionsSection({
  sessions,
}: {
  sessions: ProjectInspectorData["sessions"];
}) {
  const ongoing = Array.isArray(sessions)
    ? sessions.filter(
        (session) => session.running || session.status !== "closed",
      )
    : [];
  return (
    <section className="border-t border-border pt-2">
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
        Sessions
      </h3>
      {sessions === undefined ? (
        <div aria-busy="true" className="flex h-7 items-center gap-2">
          <span className="size-1.5 shrink-0 rounded-full bg-fg/7" />
          <span className="sidebar-skeleton-bar w-3/5" />
          <span className="sr-only">Loading</span>
        </div>
      ) : sessions === "unavailable" ? (
        <p className="flex h-7 items-center text-[11px] text-fg-faint">
          Unavailable
        </p>
      ) : ongoing.length === 0 ? (
        <p className="flex h-7 items-center text-[11px] text-fg-faint">
          No ongoing sessions
        </p>
      ) : (
        <LazyList
          label="Ongoing sessions"
          items={ongoing}
          itemKey={(session) => session.id}
          maxHeight={168}
          renderItem={(session) => (
            <div
              key={session.id}
              className="flex h-7 min-w-0 items-center gap-2 text-[11px]"
            >
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${session.running ? "animate-pulse bg-accent" : "bg-fg-faint"}`}
              />
              <span className="min-w-0 flex-1 truncate text-fg">
                {session.title || "Untitled session"}
              </span>
              <span className="shrink-0 text-fg-faint">
                {sessionState(session)}
              </span>
            </div>
          )}
        />
      )}
    </section>
  );
}

function sessionState(session: ProjectInspectorSession): string {
  if (session.running) return "Working";
  if (session.attentionRequired) return "Needs attention";
  if (session.resumable) return "Paused";
  return "Ready";
}

const SERVER_STATE: Record<RemoteProjectStatus["connection"]["state"], string> =
  {
    connected: "Connected",
    sign_in_required: "Sign in required",
    access_removed: "Access removed",
    unreachable: "Unreachable",
  };

function ServerValue({ status }: { status: RemoteProjectStatus }) {
  const connected = status.connection.state === "connected";
  const Icon = connected ? CheckCircle2 : AlertCircle;
  return (
    <Line>
      <Icon
        aria-hidden="true"
        className={`size-3 shrink-0 ${connected ? "text-success" : "text-warning"}`}
      />
      <ShortcutHint label={serverHost(status.serverUrl)} className="min-w-0">
        <span className="min-w-0 truncate text-fg">
          {status.remoteProjectName}
        </span>
      </ShortcutHint>
      <span className="shrink-0 text-fg-faint">
        {SERVER_STATE[status.connection.state]}
      </span>
    </Line>
  );
}

/** One value line; every row of the card is this tall, loaded or not. */
function Line({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-5 min-w-0 items-center gap-1.5">{children}</span>
  );
}

/** A value still loading: a still bar where its text will be. */
function Pending({ width }: { width: string }) {
  return (
    <Line>
      <span className="sidebar-skeleton-bar" style={{ width }} />
      <span className="sr-only">Loading</span>
    </Line>
  );
}

function Absent({ children }: { children: ReactNode }) {
  return (
    <Line>
      <span className="truncate text-fg-faint">{children}</span>
    </Line>
  );
}

/**
 * A path or address on one line, its end kept when it is too long (the
 * folder's or repository's own name), all of it in a hint and a copy.
 */
function CopyableValue({
  value,
  copyLabel,
}: {
  value: string;
  copyLabel: string;
}) {
  return (
    <Line>
      <ShortcutHint label={value} className="min-w-0 flex-1">
        <span className="min-w-0 flex-1 truncate text-left font-mono text-fg [direction:rtl]">
          <bdi>{value}</bdi>
        </span>
      </ShortcutHint>
      <CopyButton value={value} label={copyLabel} />
    </Line>
  );
}

/**
 * A Git remote without the secrets a URL can carry. An http(s) remote's
 * user is a token as often as a name, so the whole userinfo goes; other
 * schemes (ssh) keep their user and lose only a password; scp-style
 * `git@host:path` has none. Userinfo is what comes before an `@` ahead of
 * the first slash; a URL that still does not parse loses everything up to
 * its last `@`, failing closed.
 */
export function displayRemote(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1];
  if (!scheme) return url;
  const http = /^(?:git\+)?https?$/i.test(scheme);
  const userinfo = http
    ? /^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i
    : /^([a-z][a-z0-9+.-]*:\/\/[^:@/]*):[^/]*@/i;
  if (userinfo.test(url)) return url.replace(userinfo, http ? "$1" : "$1@");
  try {
    new URL(url);
    return url;
  } catch {
    return http
      ? url.replace(/^([a-z][a-z0-9+.-]*:\/\/).*@/i, "$1")
      : url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:@/]*):.*@/i, "$1@");
  }
}

function serverHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}
