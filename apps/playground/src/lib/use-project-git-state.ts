"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type BranchInfo,
  type CommitInfo,
  type ConflictEntry,
  type RepoStatus,
} from "./api";

const STATUS_POLL_MS = 10_000;

type Drafts = Record<string, string>;

function draftKey({
  projectId,
  branch,
}: {
  projectId: string;
  branch: string;
}) {
  return `catamorphic.draft:${projectId}:${branch}`;
}

function normalizePath(p: string): string {
  return p.startsWith("/") ? p.slice(1) : p;
}

function readDrafts({
  projectId,
  branch,
}: {
  projectId: string;
  branch: string;
}): Drafts {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(draftKey({ projectId, branch }));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    // Legacy drafts may have been stored with a leading slash (from
    // ts-morph's in-memory filesystem paths). Normalize on load so the keys
    // match the server's repo-relative paths.
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => [normalizePath(k), v as string] as const);
    return Object.fromEntries(entries);
  } catch {
    // Ignore corrupted drafts
  }
  return {};
}

function writeDrafts({
  projectId,
  branch,
  drafts,
}: {
  projectId: string;
  branch: string;
  drafts: Drafts;
}) {
  if (typeof window === "undefined") return;
  const key = draftKey({ projectId, branch });
  if (Object.keys(drafts).length === 0) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(drafts));
}

export interface UseProjectGitStateOptions {
  projectId: string;
  /** Baseline files from server at the current HEAD of the dev branch. */
  baselineFiles: Record<string, string>;
}

export interface ProjectGitState {
  status: RepoStatus | null;
  branches: BranchInfo[];
  commits: CommitInfo[];
  /** Files reflected in the UI: baseline + drafts. */
  files: Record<string, string>;
  /** Set of paths whose content differs from baseline. */
  modifiedFiles: Set<string>;
  /** True when there are any local drafts. */
  isDirty: boolean;
  /** True when the remote has advanced past our base. */
  isBehind: boolean;
  /** Commit currently being viewed (null = working copy). */
  selectedSha: string | null;
  /** Files at the currently-viewed commit (null until loaded). */
  selectedFiles: Record<string, string> | null;
  /** Label for the version pill. */
  versionLabel: string;
  refreshStatus: () => Promise<void>;
  refreshCommits: () => Promise<void>;
  refreshBranches: () => Promise<void>;
  setFile: (path: string, content: string) => void;
  discardDrafts: () => void;
  selectVersion: (sha: string | null) => Promise<void>;
  deploy: (opts?: { message?: string }) => Promise<{
    status: "deployed" | "nothing-to-deploy" | "conflict";
    conflicts: ConflictEntry[];
  }>;
  pull: () => Promise<{
    status: "clean" | "conflict" | "up-to-date";
    conflicts: ConflictEntry[];
  }>;
  discard: () => Promise<void>;
  resolveConflicts: (resolutions: Record<string, string>) => Promise<void>;
}

function formatCommitLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function useProjectGitState({
  projectId,
  baselineFiles,
}: UseProjectGitStateOptions): ProjectGitState {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Record<
    string,
    string
  > | null>(null);
  const baselineRef = useRef(baselineFiles);
  baselineRef.current = baselineFiles;

  const currentBranch = status?.branch ?? "main";

  useEffect(() => {
    setDrafts(readDrafts({ projectId, branch: currentBranch }));
  }, [projectId, currentBranch]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api.getStatus(projectId);
      setStatus(next);
    } catch {
      // Ignore transient errors; banner hidden until next tick succeeds.
    }
  }, [projectId]);

  const refreshBranches = useCallback(async () => {
    try {
      const next = await api.getBranches(projectId);
      setBranches(next);
    } catch {
      // Ignore
    }
  }, [projectId]);

  const refreshCommits = useCallback(async () => {
    try {
      const next = await api.getCommits(projectId);
      setCommits(next.items);
    } catch {
      // Ignore
    }
  }, [projectId]);

  useEffect(() => {
    refreshStatus();
    refreshBranches();
    refreshCommits();
    const id = setInterval(() => {
      refreshStatus();
    }, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshStatus, refreshBranches, refreshCommits]);

  const files = useMemo(() => {
    return { ...baselineRef.current, ...drafts };
  }, [drafts]);

  const modifiedFiles = useMemo(() => {
    const set = new Set<string>();
    for (const [path, content] of Object.entries(drafts)) {
      if (baselineRef.current[path] !== content) {
        set.add(path);
      }
    }
    return set;
  }, [drafts]);

  const isDirty = modifiedFiles.size > 0;
  const isBehind = (status?.behind ?? 0) > 0;

  const setFile = useCallback(
    (path: string, content: string) => {
      const key = normalizePath(path);
      setDrafts((prev) => {
        const next = { ...prev };
        if (baselineRef.current[key] === content) {
          delete next[key];
        } else {
          next[key] = content;
        }
        writeDrafts({ projectId, branch: currentBranch, drafts: next });
        return next;
      });
    },
    [projectId, currentBranch],
  );

  const discardDrafts = useCallback(() => {
    setDrafts({});
    writeDrafts({ projectId, branch: currentBranch, drafts: {} });
  }, [projectId, currentBranch]);

  const selectVersion = useCallback(
    async (sha: string | null) => {
      setSelectedSha(sha);
      if (!sha) {
        setSelectedFiles(null);
        return;
      }
      try {
        const next = await api.getFilesAtRef(projectId, sha);
        setSelectedFiles(next);
      } catch {
        setSelectedFiles({});
      }
    },
    [projectId],
  );

  const deploy = useCallback(
    async (opts?: { message?: string }) => {
      const result = await api.deploy(projectId, {
        message: opts?.message,
        files: Object.keys(drafts).length > 0 ? drafts : undefined,
      });
      if (result.status === "deployed") {
        discardDrafts();
        await Promise.all([
          refreshStatus(),
          refreshBranches(),
          refreshCommits(),
        ]);
      }
      return { status: result.status, conflicts: result.conflicts };
    },
    [
      projectId,
      drafts,
      discardDrafts,
      refreshStatus,
      refreshBranches,
      refreshCommits,
    ],
  );

  const pull = useCallback(async () => {
    const result = await api.pull(projectId, {
      files: Object.keys(drafts).length > 0 ? drafts : undefined,
    });
    if (result.status === "clean" || result.status === "up-to-date") {
      discardDrafts();
      await Promise.all([refreshStatus(), refreshCommits()]);
    }
    return { status: result.status, conflicts: result.conflicts };
  }, [projectId, drafts, discardDrafts, refreshStatus, refreshCommits]);

  const discard = useCallback(async () => {
    discardDrafts();
    await api.discard(projectId).catch(() => undefined);
    await Promise.all([refreshStatus(), refreshBranches()]);
  }, [projectId, discardDrafts, refreshStatus, refreshBranches]);

  const resolveConflicts = useCallback(
    async (resolutions: Record<string, string>) => {
      await api.resolveConflicts(projectId, { resolutions });
      discardDrafts();
      await Promise.all([refreshStatus(), refreshCommits()]);
    },
    [projectId, discardDrafts, refreshStatus, refreshCommits],
  );

  const versionLabel = useMemo(() => {
    if (selectedSha) {
      const commit = commits.find((c) => c.sha === selectedSha);
      if (commit) return `v ${formatCommitLabel(commit.timestamp)}`;
      return `v ${selectedSha.slice(0, 7)}`;
    }
    if (isDirty) {
      const b = status?.branch ?? "main";
      return b === "main" ? "Draft" : `Draft — ${b}`;
    }
    if (status?.branch && status.branch !== "main") {
      return status.branch;
    }
    if (status?.remoteHeadTimestamp) {
      return `v ${formatCommitLabel(status.remoteHeadTimestamp)}`;
    }
    return "main";
  }, [
    selectedSha,
    commits,
    isDirty,
    status?.branch,
    status?.remoteHeadTimestamp,
  ]);

  return {
    status,
    branches,
    commits,
    files,
    modifiedFiles,
    isDirty,
    isBehind,
    selectedSha,
    selectedFiles,
    versionLabel,
    refreshStatus,
    refreshCommits,
    refreshBranches,
    setFile,
    discardDrafts,
    selectVersion,
    deploy,
    pull,
    discard,
    resolveConflicts,
  };
}
