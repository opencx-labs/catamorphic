import { z } from "zod";

export const browserImportCategorySchema = z.enum([
  "bookmarks",
  "history",
  "passwords",
  "sessions",
]);
export type BrowserImportCategory = z.infer<typeof browserImportCategorySchema>;
export const browserImportRequestSchema = z.object({
  browserId: z.string().min(1),
  sourceProfileId: z.string().min(1),
  targetProfileId: z.string().min(1),
  categories: z.array(browserImportCategorySchema).min(1).max(4),
});
export type BrowserImportRequest = z.infer<typeof browserImportRequestSchema>;
export interface BrowserImportResult {
  cancelled: boolean;
  error?: string;
}
