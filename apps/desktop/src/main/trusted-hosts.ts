import { ipcMain, type WebContents } from "electron";
import { z } from "zod";
import {
  DEFAULT_TRUSTED_HOSTS,
  type TrustedHosts,
  trustedHostEntry,
} from "../shared/trusted-hosts.js";
import type { CodeApprovals } from "./code-approvals.js";
import { projectTrustedHosts } from "./project-manifest.js";

/** Where the person's own trusted hosts live in their approvals. */
const SUBJECT = "trusted-hosts";

/**
 * The hosts a chat opens and shows without asking (ADR 0277): Work's list,
 * the project's committed one, and the person's own. Theirs lives in the
 * signed approvals, so an agent that writes a file trusts nothing; only a
 * person's answer in Work's own window adds to it.
 */
export function registerTrustedHosts({
  approvalsFor,
  profileFor,
  rootFor,
  windowsFor,
}: {
  approvalsFor: (profileId: string) => CodeApprovals;
  profileFor: (sender: WebContents) => string;
  rootFor: (projectId: string) => Promise<string | null>;
  /** The profile's windows, told when its list changes. */
  windowsFor: (profileId: string) => readonly { webContents: WebContents }[];
}): () => void {
  const mine = async (profileId: string) =>
    (await approvalsFor(profileId).approved(SUBJECT))?.hosts ?? [];
  const save = async (profileId: string, hosts: readonly string[]) => {
    const approvals = approvalsFor(profileId);
    if (hosts.length) await approvals.approve(SUBJECT, { hosts: [...hosts] });
    else await approvals.revoke(SUBJECT);
    for (const window of windowsFor(profileId))
      if (!window.webContents.isDestroyed())
        window.webContents.send("catamorphic:trusted-hosts-changed");
  };
  const hostInput = z
    .string()
    .max(300)
    .transform((value, context) => {
      const host = trustedHostEntry(value);
      if (!host) {
        context.addIssue({
          code: "custom",
          message: `${value} is not a host.`,
        });
        return z.NEVER;
      }
      return host;
    });

  ipcMain.handle(
    "catamorphic:trusted-hosts",
    async (event, projectId?: unknown): Promise<TrustedHosts> => {
      const profileId = profileFor(event.sender);
      const root =
        typeof projectId === "string" && projectId
          ? await rootFor(projectId)
          : null;
      return {
        defaults: DEFAULT_TRUSTED_HOSTS,
        project: root ? projectTrustedHosts(root) : [],
        mine: await mine(profileId),
      };
    },
  );
  ipcMain.handle(
    "catamorphic:trusted-hosts-add",
    async (event, raw: unknown) => {
      // The person's answer, in Work's own window; never a page's.
      if (event.sender.getType() !== "window")
        throw new Error("Only Work can trust a host.");
      const host = hostInput.parse(raw);
      const profileId = profileFor(event.sender);
      const hosts = await mine(profileId);
      if (!hosts.includes(host)) await save(profileId, [...hosts, host]);
    },
  );
  ipcMain.handle(
    "catamorphic:trusted-hosts-remove",
    async (event, raw: unknown) => {
      if (event.sender.getType() !== "window")
        throw new Error("Only Work can change trusted hosts.");
      const host = hostInput.parse(raw);
      const profileId = profileFor(event.sender);
      const hosts = await mine(profileId);
      if (hosts.includes(host))
        await save(
          profileId,
          hosts.filter((entry) => entry !== host),
        );
    },
  );
  return () => {
    for (const suffix of ["", "-add", "-remove"])
      ipcMain.removeHandler(`catamorphic:trusted-hosts${suffix}`);
  };
}
