import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  allTrustedHosts,
  hostTrusted,
  webLinkHost,
} from "../../shared/trusted-hosts.js";
import { desktopApi } from "./desktop-api.js";

const KEY = "trusted-hosts";

/**
 * The hosts a chat in this project opens and shows without asking
 * (ADR 0277), current across windows; undefined until main answers.
 */
export function useTrustedHosts(
  projectId: string | undefined,
): readonly string[] | undefined {
  const client = useQueryClient();
  useEffect(
    () =>
      desktopApi.onTrustedHostsChanged(
        () => void client.invalidateQueries({ queryKey: [KEY] }),
      ),
    [client],
  );
  const { data } = useQuery({
    queryKey: [KEY, projectId ?? ""],
    queryFn: async () =>
      allTrustedHosts(await desktopApi.trustedHosts(projectId)),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data;
}

/**
 * The host a web address would reach when it is not one the chat trusts;
 * null for a trusted host, or for anything that is not a web address
 * (Work's own links open as they always do).
 */
export function untrustedHost(
  trusted: readonly string[] | undefined,
  url: string,
): string | null {
  const host = webLinkHost(url);
  if (!host) return null;
  return trusted && hostTrusted(trusted, host) ? null : host;
}
