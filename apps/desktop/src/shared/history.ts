import { z } from "zod";

export const historyTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("web"), url: z.string().url() }),
  z.object({
    kind: z.enum(["app", "workflow", "file", "chat", "run", "artifact"]),
    projectId: z.string().min(1),
    resource: z.string().min(1),
  }),
]);
export type HistoryTarget = z.infer<typeof historyTargetSchema>;
export const historyVisitSchema = z.object({
  target: historyTargetSchema,
  title: z.string().max(4096),
  projectName: z.string().optional(),
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
  offset?: number;
  limit?: number;
}
export interface HistoryPage {
  entries: HistoryEntry[];
  total: number;
}
export function historyIdentity(target: HistoryTarget): string {
  return target.kind === "web"
    ? JSON.stringify(["web", target.url])
    : JSON.stringify([target.kind, target.projectId, target.resource]);
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
