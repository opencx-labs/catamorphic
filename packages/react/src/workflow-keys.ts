export const workflowKeys = {
  all: ["cat", "workflow"] as const,
  project: ({ projectId }: { projectId: string | undefined }) =>
    [...workflowKeys.all, projectId] as const,
  lists: ({ projectId }: { projectId: string | undefined }) =>
    [...workflowKeys.project({ projectId }), "list"] as const,
  list: ({
    projectId,
    ref,
  }: {
    projectId: string | undefined;
    ref: string | undefined;
  }) => [...workflowKeys.lists({ projectId }), { ref }] as const,
  details: ({ projectId }: { projectId: string | undefined }) =>
    [...workflowKeys.project({ projectId }), "detail"] as const,
  detail: ({
    projectId,
    name,
    ref,
  }: {
    projectId: string | undefined;
    name: string | undefined;
    ref: string | undefined;
  }) => [...workflowKeys.details({ projectId }), name, { ref }] as const,
};
