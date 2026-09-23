import { z } from "zod";

/**
 * History (ADR 0154) is the profile's log of what was opened: web pages,
 * files on this machine, and a project's own resources. Every entry may
 * name the project it was opened in; project resources always do, a page
 * or a loose file names the workspace it was opened from, if any.
 */
export const historyTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("web"), url: z.string().url() }),
  /** A file on this machine outside any project, by absolute path. */
  z.object({ kind: z.literal("local"), path: z.string().min(1) }),
  z.object({
    kind: z.enum(["app", "workflow", "file", "chat", "run", "artifact"]),
    projectId: z.string().min(1),
    /** A project file's path relative to the project root, else a name or id. */
    resource: z.string().min(1),
  }),
]);
export type HistoryTarget = z.infer<typeof historyTargetSchema>;
export const historyProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
});
export type HistoryProject = z.infer<typeof historyProjectSchema>;
export const historyVisitSchema = z.object({
  target: historyTargetSchema,
  title: z.string().max(4096),
  /** The project this was opened in. Kept by name so a deleted project still reads. */
  project: historyProjectSchema.optional(),
  faviconUrl: z.string().optional(),
});
export type HistoryVisit = z.infer<typeof historyVisitSchema>;
export const historyEntrySchema = historyVisitSchema.extend({
  id: z.string(),
  lastVisitAt: z.number().finite().positive(),
  visitCount: z.number().int().positive(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export interface HistoryQuery {
  query?: string;
  /** Only what was opened in this project. */
  projectId?: string;
  offset?: number;
  limit?: number;
}
export interface HistoryPage {
  entries: HistoryEntry[];
  total: number;
  /** Every project the profile's history names, latest visit first. */
  projects: HistoryProject[];
}
export function historyIdentity(target: HistoryTarget): string {
  switch (target.kind) {
    case "web":
      return JSON.stringify(["web", target.url]);
    case "local":
      return JSON.stringify(["local", target.path]);
    default:
      return JSON.stringify([target.kind, target.projectId, target.resource]);
  }
}

/** Authorization pages are temporary plumbing, never personal destinations. */
export function isHistoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !/(?:^|\/)(?:login|logout|signin|signout|oauth2?|authorize|callback)(?:\/|$)/i.test(
        url.pathname,
      ) &&
      !["code", "access_token", "id_token", "device_code"].some(
        (key) =>
          url.searchParams.has(key) ||
          new URLSearchParams(url.hash.slice(1)).has(key),
      )
    );
  } catch {
    return false;
  }
}
