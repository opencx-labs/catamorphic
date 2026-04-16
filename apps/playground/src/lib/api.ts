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

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text}`);
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

  getWorkflow: (projectId: string, name: string) =>
    apiFetch<WorkflowGraph>(`/api/projects/${projectId}/workflows/${name}`),

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
};
