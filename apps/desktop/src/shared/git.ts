/** JSON contracts shared by the main process, preload, and renderer. */
export type GitDiffMode =
  | "staged"
  | "unstaged"
  | "untracked"
  | "conflict"
  | "branch";

export interface GitChangedFile {
  path: string;
  kind: "added" | "modified" | "deleted" | "renamed" | "conflicted";
  mode: GitDiffMode;
  previousPath?: string;
}

export interface GitWorktree {
  /** False when only checkout metadata was requested. */
  loaded?: boolean;
  path: string;
  branch: string | null;
  isMain: boolean;
  isCurrent: boolean;
  changes: GitChangedFile[];
  branchChanges: GitChangedFile[];
  baseRef?: string;
  baseLabel?: string;
  error?: string;
  comparisonError?: string;
  locked?: string;
  prunable?: string;
}

export interface GitOverview {
  available: boolean;
  worktrees: GitWorktree[];
  error?: string;
}

export interface GitDiffInput {
  projectId: string;
  worktreePath: string;
  filePath: string;
  mode: GitDiffMode;
  previousPath?: string;
  baseRef?: string;
}

export interface GitFileDiff {
  path: string;
  before: string;
  after: string;
  binary: boolean;
  beforeLabel: string;
  afterLabel: string;
  notice?: string;
}

export interface GitRecordInput {
  projectId: string;
  paths: string[];
  message: string;
}
