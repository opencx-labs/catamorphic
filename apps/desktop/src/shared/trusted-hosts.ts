import { parseHost } from "./code-access.js";

/**
 * Hosts whose links open and whose images show in a chat without asking
 * (ADR 0277). An address an agent wrote can carry whatever it read, and
 * whoever receives the request can read the address; these are hosts where
 * only the host itself sees requests and that do not send a visitor on to
 * another address of the visitor's choosing. Anything else asks once,
 * and the person may trust it from then on.
 */
export const DEFAULT_TRUSTED_HOSTS: readonly string[] = [
  // Repositories, pull request screenshots, avatars, raw files. Not
  // github.io, where anyone's pages live.
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "*.wikipedia.org",
  "*.wikimedia.org",
  "developer.mozilla.org",
  // This machine: a local dev server receives nothing the machine lacks.
  "localhost",
  "127.0.0.1",
];

/** A list entry as stored: a host or `*.host`, lowercase, no port. */
export function trustedHostEntry(value: string): string | null {
  const parsed = parseHost(value.trim().toLowerCase());
  return parsed ? parsed.host : null;
}

/** The host of a web address, lowercase, or null for anything else. */
export function webLinkHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/** Whether the host is on the list: by name, or under a `*.` entry. */
export function hostTrusted(hosts: readonly string[], host: string): boolean {
  const name = host.toLowerCase();
  return hosts.some((entry) =>
    entry.startsWith("*.")
      ? name.endsWith(entry.slice(1)) && name.length > entry.length - 1
      : name === entry,
  );
}

/** The lists a chat in a project trusts, kept apart for Settings. */
export interface TrustedHosts {
  /** Work's own list. */
  defaults: readonly string[];
  /** The approved published list (`trustedHosts` in `.work/project.json`). */
  project: readonly string[];
  /** The person's own, kept in their approvals. */
  mine: readonly string[];
}

export function allTrustedHosts(trusted: TrustedHosts): string[] {
  return [...trusted.defaults, ...trusted.project, ...trusted.mine];
}
