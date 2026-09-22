import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SITE_PERMISSIONS,
  type SitePermissionAnswer,
  type SitePermissionKind,
  type SitePermissionRequest,
  type SitePermissions,
  sanitizePermissions,
} from "../shared/site-settings.js";

/**
 * Per-profile site permissions (ADR 0149): `profiles/<id>/site-settings.json`
 * maps an origin to the choices the user made for it. Everything at its
 * default is absent, so the file lists exactly what the user decided.
 */
export class SiteSettingsStore {
  private cache = new Map<string, Record<string, SitePermissions>>();
  constructor(private readonly profilesDir: string) {}

  private file(profileId: string): string {
    return path.join(this.profilesDir, profileId, "site-settings.json");
  }

  private load(profileId: string): Record<string, SitePermissions> {
    const cached = this.cache.get(profileId);
    if (cached) return cached;
    const sites: Record<string, SitePermissions> = {};
    try {
      const raw: unknown = JSON.parse(
        fs.readFileSync(this.file(profileId), "utf-8"),
      );
      const stored =
        raw && typeof raw === "object" && "sites" in raw
          ? (raw as { sites: unknown }).sites
          : null;
      if (stored && typeof stored === "object")
        for (const [origin, value] of Object.entries(stored)) {
          const permissions = sanitizePermissions(value);
          if (Object.keys(permissions).length > 0) sites[origin] = permissions;
        }
    } catch {
      /* A new profile has decided nothing yet. */
    }
    this.cache.set(profileId, sites);
    return sites;
  }

  private save(profileId: string): void {
    const sites = this.cache.get(profileId) ?? {};
    const file = this.file(profileId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ sites }, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(`${file}.tmp`, file);
  }

  get(profileId: string, origin: string): SitePermissions {
    return { ...(this.load(profileId)[origin] ?? {}) };
  }

  /** Origins with at least one explicit choice. */
  origins(profileId: string): string[] {
    return Object.keys(this.load(profileId));
  }

  /** `null` state clears the choice so the kind returns to its default. */
  set(
    profileId: string,
    origin: string,
    kind: SitePermissionKind,
    state: SitePermissions[SitePermissionKind] | null,
  ): SitePermissions {
    const sites = this.load(profileId);
    const next: SitePermissions = { ...(sites[origin] ?? {}) };
    if (state === null || state === SITE_PERMISSIONS[kind].default)
      delete next[kind];
    else next[kind] = state;
    if (Object.keys(next).length === 0) delete sites[origin];
    else sites[origin] = next;
    this.save(profileId);
    return { ...next };
  }

  reset(profileId: string, origin: string): void {
    const sites = this.load(profileId);
    if (!(origin in sites)) return;
    delete sites[origin];
    this.save(profileId);
  }

  releaseProfile(profileId: string): void {
    this.cache.delete(profileId);
  }
}

/**
 * Does a cookie's domain cover a site's host? A host-only cookie for
 * `chatgpt.com` and a domain cookie for `.chatgpt.com` both belong to
 * `chatgpt.com`; a domain cookie for `.openai.com` also reaches
 * `chat.openai.com`, and Chrome's per-site view counts cookies of
 * subdomains (`api.chatgpt.com`) with the site too.
 */
export function cookieCoversHost(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.replace(/^\./, "").toLowerCase();
  const site = host.replace(/:\d+$/, "").toLowerCase();
  if (!domain || !site) return false;
  return (
    domain === site ||
    site.endsWith(`.${domain}`) ||
    domain.endsWith(`.${site}`)
  );
}

interface PendingRequest {
  request: SitePermissionRequest;
  profileId: string;
  resolve: (answer: SitePermissionAnswer | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A prompt nobody answers (tab left open, user away) denies itself. */
const REQUEST_LIFETIME_MS = 10 * 60 * 1000;

/**
 * Prompts in flight between a guest's permission request and the user's
 * answer in the site settings modal. One entry per request; a guest that
 * goes away withdraws its prompts.
 */
export class SitePermissionBroker {
  private pending = new Map<string, PendingRequest>();

  ask(
    input: {
      profileId: string;
      origin: string;
      guestId: number;
      kinds: SitePermissionKind[];
    },
    deliver: (request: SitePermissionRequest) => void,
  ): Promise<SitePermissionAnswer | null> {
    const request: SitePermissionRequest = {
      id: randomUUID(),
      guestId: input.guestId,
      origin: input.origin,
      kinds: input.kinds,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.settle(request.id, null),
        REQUEST_LIFETIME_MS,
      );
      timer.unref?.();
      this.pending.set(request.id, {
        request,
        profileId: input.profileId,
        resolve,
        timer,
      });
      deliver(request);
    });
  }

  /**
   * Settle a prompt with the user's answer. Only the profile the prompt was
   * sent to may answer it; anything else leaves it pending and returns null.
   */
  answer(
    answer: SitePermissionAnswer,
    profileId?: string,
  ): { profileId: string; request: SitePermissionRequest } | null {
    const entry = this.pending.get(answer.id);
    if (!entry || (profileId !== undefined && entry.profileId !== profileId))
      return null;
    this.settle(answer.id, answer);
    return { profileId: entry.profileId, request: entry.request };
  }

  /** Requests of a guest that closed: denied, and reported for withdrawal. */
  withdrawGuest(guestId: number): string[] {
    const ids = [...this.pending.values()]
      .filter((entry) => entry.request.guestId === guestId)
      .map((entry) => entry.request.id);
    for (const id of ids) this.settle(id, null);
    return ids;
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  private settle(id: string, answer: SitePermissionAnswer | null): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(answer);
  }
}
