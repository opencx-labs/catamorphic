import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Bearer tokens on disk (`<data>/auth.json`): who the user is stays the
 * host's (ADR 0055), and for the stock server the host is this file. One
 * admin token is minted at first boot (root identity); member tokens are
 * minted per invite and carry an externalUserId whose access comes from
 * memberships, never from the token itself — revoking a membership
 * revokes access instantly even while the token lives on.
 */
export interface TokenRecord {
  token: string;
  externalUserId: string;
  kind: "admin" | "member";
  /** Member tokens are per project — the invite's project. */
  projectId?: string;
  label?: string;
  createdAt: string;
}

interface AuthFile {
  tokens: TokenRecord[];
}

export class AuthStore {
  private tokens: TokenRecord[] = [];

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as AuthFile;
      if (Array.isArray(parsed.tokens)) this.tokens = parsed.tokens;
    } catch {
      this.tokens = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const body = `${JSON.stringify({ tokens: this.tokens }, null, 2)}\n`;
    fs.writeFileSync(this.file, body, { mode: 0o600 });
  }

  /** The admin token, minting one on first boot. */
  ensureAdmin(): TokenRecord {
    const existing = this.tokens.find((record) => record.kind === "admin");
    if (existing) return existing;
    const record: TokenRecord = {
      token: newToken(),
      externalUserId: "admin",
      kind: "admin",
      createdAt: new Date().toISOString(),
    };
    this.tokens.push(record);
    this.save();
    return record;
  }

  /** A fresh member token; `externalUserId` may already hold other tokens
   * (re-invites replace nothing — revoke explicitly). */
  mintMember(
    externalUserId: string,
    projectId: string,
    label?: string,
  ): TokenRecord {
    const record: TokenRecord = {
      token: newToken(),
      externalUserId,
      kind: "member",
      projectId,
      ...(label ? { label } : {}),
      createdAt: new Date().toISOString(),
    };
    this.tokens.push(record);
    this.save();
    return record;
  }

  findByToken(token: string): TokenRecord | undefined {
    // Constant-time comparison; the token list is small.
    const candidate = Buffer.from(token);
    return this.tokens.find((record) => {
      const stored = Buffer.from(record.token);
      return (
        stored.length === candidate.length && timingSafeEqual(stored, candidate)
      );
    });
  }

  revoke(token: string): boolean {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((record) => record.token !== token);
    if (this.tokens.length === before) return false;
    this.save();
    return true;
  }

  list(): TokenRecord[] {
    return [...this.tokens];
  }
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}
