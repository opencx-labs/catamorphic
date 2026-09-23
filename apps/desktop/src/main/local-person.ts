import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

/**
 * The person at this computer, for their agents' session context (ADR
 * 0152): the operating-system account's full name when it has one, else the
 * account name, and the system time zone. Read once; never leaves the host
 * except as model context for their own chats.
 */
export function localPerson(): { displayName?: string; timeZone?: string } {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    ...(accountFullName() ? { displayName: accountFullName() } : {}),
    ...(timeZone ? { timeZone } : {}),
  };
}

let cachedName: string | null | undefined;

function accountFullName(): string | undefined {
  if (cachedName === undefined) cachedName = readFullName();
  return cachedName ?? undefined;
}

function readFullName(): string | null {
  const account = os.userInfo().username;
  try {
    if (process.platform === "darwin") {
      const name = execFileSync("id", ["-F"], {
        encoding: "utf8",
        timeout: 1_000,
      }).trim();
      if (name) return name;
    } else if (process.platform === "linux") {
      const line = fs
        .readFileSync("/etc/passwd", "utf8")
        .split("\n")
        .find((entry) => entry.startsWith(`${account}:`));
      const gecos = line?.split(":")[4]?.split(",")[0]?.trim();
      if (gecos) return gecos;
    }
  } catch {
    // Fall back to the account name.
  }
  return account || null;
}
