import { z } from "zod";

/**
 * What the window asks main for when it draws an icon from a row, a chip
 * or a connection (ADR 0277): a site's icon, served only if this profile
 * saw the site show it, or an address a catalog Work fetched names. Text
 * an agent wrote never makes the window reach an address for an icon.
 */
export const windowImageRequestSchema = z.union([
  z.object({
    site: z
      .object({
        /** The page whose site's icon to show. */
        page: z.string().max(8192).optional(),
        /** The icon a page reported, shown only if the profile saw it. */
        icon: z
          .string()
          .max(64 * 1024)
          .optional(),
      })
      .refine((site) => site.page !== undefined || site.icon !== undefined),
  }),
  z.object({ url: z.string().max(64 * 1024) }),
]);
export type WindowImageRequest = z.infer<typeof windowImageRequestSchema>;
