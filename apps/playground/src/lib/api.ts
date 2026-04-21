const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface Template {
  id: string;
  name: string;
  description: string;
  defaultWorkflow: string;
  fileCount: number;
}

export interface Project {
  id: string;
  name: string;
  storageType: "managed" | "remote";
  remoteUrl: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSummary {
  name: string;
  displayName: string | null;
  description: string | null;
  filePath: string;
  parameterCount: number;
}

export interface ProjectDetail extends Project {
  workflows: WorkflowSummary[];
  files: string[];
}

export interface WorkflowGraph {
  name: string;
  displayName: string | null;
  description: string | null;
  filePath: string;
  projectFiles?: string[];
  allFiles?: Record<string, string>;
  trigger: {
    parameters: {
      name: string;
      type: string;
      displayName: string | null;
      description: string | null;
      required: boolean;
      defaultValue: string | null;
    }[];
  };
  nodes: {
    id: string;
    type: string;
    label: string;
    description?: string;
    functionName?: string;
    parentId?: string;
    metadata: Record<string, unknown>;
    sourceRange?: {
      start: number;
      end: number;
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
      file?: string;
    };
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    label?: string;
    type: string;
  }[];
  sourceCode: string;
}

export interface Run {
  id: string;
  projectId: string;
  workflowName: string;
  commitSha: string;
  isTest: boolean;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  triggerData: unknown | null;
  result: unknown | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface RepoStatus {
  branch: string;
  dirty: boolean;
  modifiedFiles: string[];
  ahead: number;
  behind: number;
  baseCommit: string | null;
  remoteHead: string | null;
  remoteHeadTimestamp: number | null;
}

export interface BranchInfo {
  name: string;
  commit: string;
  isCurrent: boolean;
  createdAt: number | null;
}

export interface DiffEntry {
  path: string;
  kind: "added" | "modified" | "deleted";
  before: string | null;
  after: string | null;
}

export interface ConflictEntry {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: { name: string; email: string };
  timestamp: number;
}

export interface DeployResult {
  status: "deployed" | "nothing-to-deploy" | "conflict";
  commitSha: string | null;
  remoteSha: string | null;
  conflicts: ConflictEntry[];
}

export interface PullResult {
  status: "clean" | "conflict" | "up-to-date";
  mergeCommit: string | null;
  conflicts: ConflictEntry[];
}

export class ApiError extends Error {
  readonly status: number;
  constructor({ status, message }: { status: number; message: string }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (typeof window !== "undefined") {
    const userId = window.localStorage.getItem("catamorphic.externalUserId");
    if (userId) headers["X-External-User-Id"] = userId;
  }
  const mergedHeaders = { ...headers, ...(options?.headers as object) };
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: mergedHeaders,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError({
      status: res.status,
      message: `API ${res.status}: ${text}`,
    });
  }
  return res.json() as Promise<T>;
}

function encodeProjectFilePath(filePath: string): string {
  return filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export const api = {
  getTemplates: () => apiFetch<Template[]>("/api/templates"),

  getProjects: () =>
    apiFetch<{ items: Project[]; total: number }>("/api/projects"),

  createProject: (body: { name: string; templateId?: string }) =>
    apiFetch<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getProject: (projectId: string) =>
    apiFetch<ProjectDetail>(`/api/projects/${projectId}`),

  getWorkflow: (projectId: string, name: string, opts?: { ref?: string }) => {
    const qs = opts?.ref ? `?ref=${encodeURIComponent(opts.ref)}` : "";
    return apiFetch<WorkflowGraph>(
      `/api/projects/${projectId}/workflows/${name}${qs}`,
    );
  },

  getRuns: (
    projectId: string,
    workflowName: string,
    opts?: { limit?: number; offset?: number },
  ) => {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined && Number.isFinite(opts.limit)) {
      params.set("limit", String(opts.limit));
    }
    if (opts?.offset !== undefined && Number.isFinite(opts.offset)) {
      params.set("offset", String(opts.offset));
    }
    const qs = params.size > 0 ? `?${params}` : "";
    return apiFetch<{ items: Run[]; total: number }>(
      `/api/projects/${projectId}/workflows/${workflowName}/runs${qs}`,
    );
  },

  writeProjectFile: (
    projectId: string,
    filePath: string,
    body: { content: string; commitMessage?: string },
  ) =>
    apiFetch<{ path: string; content: string }>(
      `/api/projects/${projectId}/files/${encodeProjectFilePath(filePath)}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    ),

  getStatus: (projectId: string) =>
    apiFetch<RepoStatus>(`/api/projects/${projectId}/status`),

  getBranches: (projectId: string) =>
    apiFetch<BranchInfo[]>(`/api/projects/${projectId}/branches`),

  createBranch: (
    projectId: string,
    body: { name?: string; fromRef?: string },
  ) =>
    apiFetch<{ branch: string; created: boolean }>(
      `/api/projects/${projectId}/branches`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  checkout: (projectId: string, ref: string) =>
    apiFetch<RepoStatus>(`/api/projects/${projectId}/checkout`, {
      method: "POST",
      body: JSON.stringify({ ref }),
    }),

  getCommits: (projectId: string, limit = 50) =>
    apiFetch<{ items: CommitInfo[]; total: number }>(
      `/api/projects/${projectId}/commits?limit=${limit}`,
    ),

  getWorkdirDiff: (projectId: string) =>
    apiFetch<DiffEntry[]>(`/api/projects/${projectId}/workdir`),

  deploy: (
    projectId: string,
    body?: {
      message?: string;
      files?: Record<string, string>;
    },
  ) =>
    apiFetch<DeployResult>(`/api/projects/${projectId}/deploy`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  pull: (projectId: string, body?: { files?: Record<string, string> }) =>
    apiFetch<PullResult>(`/api/projects/${projectId}/pull`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  aiResolveConflicts: (
    projectId: string,
    body: { conflicts: ConflictEntry[] },
  ) =>
    apiFetch<{ resolutions: Record<string, string>; notes?: string }>(
      `/api/projects/${projectId}/ai-resolve-conflicts`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  discard: (projectId: string) =>
    apiFetch<{ discarded: boolean; branch: string }>(
      `/api/projects/${projectId}/discard`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),

  resolveConflicts: (
    projectId: string,
    body: { resolutions: Record<string, string>; message?: string },
  ) =>
    apiFetch<{ commitSha: string }>(
      `/api/projects/${projectId}/resolve-conflicts`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  getFilesAtRef: (projectId: string, ref: string) =>
    apiFetch<Record<string, string>>(
      `/api/projects/${projectId}/files-at-ref?ref=${encodeURIComponent(ref)}`,
    ),

  getPluginCatalog: () => apiFetch<PluginInfo[]>("/api/plugins/catalog"),

  getAttachedPlugins: (projectId: string) =>
    apiFetch<AttachedPlugin[]>(`/api/projects/${projectId}/plugins`),

  attachPlugin: (projectId: string, packageName: string) =>
    apiFetch<AttachedPlugin>(`/api/projects/${projectId}/plugins`, {
      method: "POST",
      body: JSON.stringify({ packageName }),
    }),

  detachPlugin: (projectId: string, packageName: string) =>
    apiFetch<{ detached: boolean }>(
      `/api/projects/${projectId}/plugins/${encodeURIComponent(packageName)}`,
      { method: "DELETE" },
    ),

  getSecrets: (projectId: string) =>
    apiFetch<SecretStatus[]>(`/api/projects/${projectId}/secrets`),

  setSecret: (projectId: string, name: string, value: string) =>
    apiFetch<SecretStatus>(
      `/api/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        body: JSON.stringify({ value }),
      },
    ),

  deleteSecret: (projectId: string, name: string) =>
    apiFetch<{ deleted: boolean }>(
      `/api/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
};

export interface PluginSecretDescriptor {
  name: string;
  label: string;
  description: string;
  required: boolean;
  default: string | null;
}

export interface PluginInfo {
  packageName: string;
  version: string | null;
  source: "local" | "npm" | "git";
  displayName: string;
  description: string;
  secrets: PluginSecretDescriptor[];
}

export interface AttachedPlugin extends PluginInfo {
  attachedAt: string;
  secretStatus: Array<{ name: string; hasValue: boolean; required: boolean }>;
}

export interface SecretStatus {
  name: string;
  hasValue: boolean;
  updatedAt: string | null;
}
