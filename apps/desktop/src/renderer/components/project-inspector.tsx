import { useAgentSessions } from "@catamorphic/react";
import type { ProjectSummary } from "@catamorphic/react/types";
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  GitBranch,
  GitPullRequest,
  MoreHorizontal,
  Radio,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  desktopApi,
  type GitOverview,
  type PullRequestSummary,
  type RemoteProjectStatus,
  type SessionCheckoutInfo,
} from "../lib/desktop-api";

export interface ProjectInspectorSnapshot {
  root: string | null;
  git: GitOverview | null;
  prs: PullRequestSummary[] | null;
  remote: RemoteProjectStatus | null | undefined;
  checkouts: SessionCheckoutInfo[] | null;
  errors: string[];
}

const EMPTY_SNAPSHOT: ProjectInspectorSnapshot = {
  root: null,
  git: null,
  prs: null,
  remote: undefined,
  checkouts: null,
  errors: [],
};

export function ProjectInspector({
  project,
  current,
  onDelete,
}: {
  project: ProjectSummary;
  current: boolean;
  onDelete: () => void;
}) {
  const sessionsQuery = useAgentSessions(current ? undefined : project.id, {
    limit: 100,
  });
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSnapshot(EMPTY_SNAPSHOT);
    void Promise.allSettled([
      desktopApi.projectRoot(project.id),
      desktopApi.gitOverview(project.id),
      desktopApi.prList(project.id),
      desktopApi.remoteStatus(project.id),
      desktopApi.sessionCheckouts(project.id),
    ]).then(
      ([rootResult, gitResult, prsResult, remoteResult, checkoutResult]) => {
        if (!alive) return;
        const errors = [
          rootResult.status === "rejected" ? "Location" : undefined,
          gitResult.status === "rejected" ? "Worktrees" : undefined,
          prsResult.status === "rejected" ? "Pull requests" : undefined,
          remoteResult.status === "rejected" ? "Remote" : undefined,
          checkoutResult.status === "rejected" ? "Checkouts" : undefined,
        ].filter((label): label is string => label !== undefined);
        setSnapshot({
          root: rootResult.status === "fulfilled" ? rootResult.value : null,
          git: gitResult.status === "fulfilled" ? gitResult.value : null,
          prs: prsResult.status === "fulfilled" ? prsResult.value : null,
          remote:
            remoteResult.status === "fulfilled"
              ? remoteResult.value
              : undefined,
          checkouts:
            checkoutResult.status === "fulfilled" ? checkoutResult.value : null,
          errors,
        });
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [project.id]);

  return (
    <ProjectInspectorView
      project={project}
      current={current}
      snapshot={snapshot}
      sessions={current ? [] : (sessionsQuery.data?.items ?? [])}
      sessionsLoading={!current && sessionsQuery.isLoading}
      loading={loading}
      onDelete={onDelete}
    />
  );
}

export function ProjectInspectorView({
  project,
  current,
  snapshot,
  sessions,
  sessionsLoading,
  loading,
  onDelete,
}: {
  project: ProjectSummary;
  current: boolean;
  snapshot: ProjectInspectorSnapshot;
  sessions: Array<{
    id: string;
    title?: string | null;
    running?: boolean;
    status?: string;
    activity?: string | null;
  }>;
  sessionsLoading: boolean;
  loading: boolean;
  onDelete: () => void;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const worktrees = snapshot.git?.worktrees ?? [];
  const checkoutBySession = new Map(
    (snapshot.checkouts ?? []).map((checkout) => [
      checkout.sessionId,
      checkout,
    ]),
  );
  const changed = worktrees.reduce(
    (count, worktree) => count + worktree.changes.length,
    0,
  );
  const prs = snapshot.prs ?? [];
  const ongoingSessions = sessions.filter(
    (session) => session.running || session.status !== "closed",
  );

  return (
    <div className="text-[12px] text-fg-muted" data-testid="project-inspector">
      <header className="flex items-start gap-2 border-b border-border pb-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[13px] font-semibold text-fg">
              {project.name}
            </h2>
            {current && (
              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                Current
              </span>
            )}
          </div>
          <p
            className="mt-0.5 truncate font-mono text-[10px] text-fg-faint"
            title={snapshot.root ?? project.id}
          >
            {snapshot.root ?? project.id}
          </p>
        </div>
        <div className="relative">
          <button
            type="button"
            aria-label={`Project actions for ${project.name}`}
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen((value) => !value)}
            className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-raised hover:text-fg"
          >
            <MoreHorizontal className="size-4" />
          </button>
          {actionsOpen && (
            <div className="absolute right-0 top-8 z-10 w-40 rounded-md border border-border bg-bg-overlay p-1 shadow-xl">
              <button
                type="button"
                onClick={onDelete}
                className="flex h-7 w-full cursor-pointer items-center gap-2 rounded px-2 text-left text-danger hover:bg-danger/10"
              >
                <Trash2 className="size-3.5" /> Delete project
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="grid grid-cols-3 gap-1.5 py-2.5">
        <Metric
          label="Worktrees"
          value={loading ? "…" : String(worktrees.length)}
        />
        <Metric
          label="Changes"
          value={loading ? "…" : String(changed)}
          tone={changed ? "warning" : "normal"}
        />
        <Metric label="Open PRs" value={loading ? "…" : String(prs.length)} />
      </div>

      <Section icon={<GitBranch className="size-3.5" />} title="Worktrees">
        {worktrees.length === 0 ? (
          <EmptyLine loading={loading} empty="No worktrees reported" />
        ) : (
          worktrees.map((worktree) => (
            <div
              key={worktree.path}
              className="flex min-w-0 items-center gap-2 py-0.5"
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${worktree.changes.length ? "bg-warning" : "bg-success"}`}
              />
              <span className="min-w-0 flex-1 truncate text-fg">
                {worktree.branch ?? (worktree.isMain ? "main" : "Detached")}
              </span>
              <span className="shrink-0 text-[10px] text-fg-faint">
                {worktree.changes.length
                  ? `${worktree.changes.length} changed`
                  : "Clean"}
              </span>
            </div>
          ))
        )}
      </Section>

      <Section
        icon={<GitPullRequest className="size-3.5" />}
        title="Open pull requests"
      >
        {prs.length === 0 ? (
          <EmptyLine loading={loading} empty="No open pull requests" />
        ) : (
          prs.map((pr) => (
            <div
              key={pr.number}
              className="flex min-w-0 items-center gap-2 py-0.5"
            >
              <span className="shrink-0 font-mono text-[10px] text-fg-faint">
                #{pr.number}
              </span>
              <span className="min-w-0 flex-1 truncate text-fg">
                {pr.title}
              </span>
              {pr.draft && (
                <span className="text-[10px] text-fg-faint">Draft</span>
              )}
            </div>
          ))
        )}
      </Section>

      <Section icon={<Radio className="size-3.5" />} title="Remote">
        {loading ? (
          <EmptyLine loading empty="" />
        ) : snapshot.remote === null || snapshot.remote === undefined ? (
          <p className="text-fg-faint">Local only</p>
        ) : (
          <div className="flex items-center gap-2">
            {snapshot.remote.connection.state === "connected" ? (
              <CheckCircle2 className="size-3.5 text-success" />
            ) : (
              <AlertCircle className="size-3.5 text-warning" />
            )}
            <span className="min-w-0 flex-1 truncate text-fg">
              {snapshot.remote.remoteProjectName}
            </span>
            <span className="text-[10px] capitalize text-fg-faint">
              {snapshot.remote.connection.state.replaceAll("_", " ")}
            </span>
          </div>
        )}
      </Section>

      {!current && (
        <Section icon={<CircleDot className="size-3.5" />} title="Sessions">
          {ongoingSessions.length === 0 ? (
            <EmptyLine loading={sessionsLoading} empty="No ongoing sessions" />
          ) : (
            ongoingSessions.map((session) => {
              const checkout = checkoutBySession.get(session.id);
              return (
                <div
                  key={session.id}
                  className="flex min-w-0 items-center gap-2 py-0.5"
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${session.running ? "animate-pulse bg-accent" : "bg-fg-faint"}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-fg">
                    {session.title || "Untitled session"}
                  </span>
                  <span className="max-w-24 shrink-0 truncate text-[10px] text-fg-faint">
                    {session.running
                      ? "Working"
                      : session.status === "closed"
                        ? "Closed"
                        : "Ready"}
                    {checkout?.branch ? ` · ${checkout.branch}` : ""}
                  </span>
                </div>
              );
            })
          )}
        </Section>
      )}

      {snapshot.errors.length > 0 && (
        <p className="mt-2 flex items-center gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-[10px] text-warning">
          <AlertCircle className="size-3" /> Some details could not load:{" "}
          {snapshot.errors.join(", ")}
        </p>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: string;
  tone?: "normal" | "warning";
}) {
  return (
    <div className="rounded-md bg-bg-raised px-2 py-1.5">
      <p
        className={`text-[14px] font-semibold ${tone === "warning" ? "text-warning" : "text-fg"}`}
      >
        {value}
      </p>
      <p className="text-[9px] uppercase tracking-wide text-fg-faint">
        {label}
      </p>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border py-2">
      <h3 className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function EmptyLine({ loading, empty }: { loading: boolean; empty: string }) {
  return <p className="text-fg-faint">{loading ? "Loading…" : empty}</p>;
}
