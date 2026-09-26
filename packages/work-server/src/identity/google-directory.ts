import { createSign } from "node:crypto";
import fs from "node:fs";
import {
  type DirectoryAccountStatus,
  type DirectoryProvider,
  DirectoryUnavailableError,
  normalizeGroup,
  requireGroups,
} from "./directory.js";

const SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
];
const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1";
const METADATA_TOKEN =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/**
 * How the server authenticates to the Admin SDK: a service account key file
 * (the account holds a read-only admin role; no domain-wide delegation), or
 * the metadata server when the server runs as that account on Google Cloud.
 */
export type GoogleDirectoryCredentials =
  | { keyFile: string }
  | { metadataServer: true };

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Google Workspace through the Admin SDK Directory API (ADR 0161). The OIDC
 * `sub` of a Workspace account is its Directory user id, so lookups survive
 * email renames.
 */
export class GoogleWorkspaceDirectory implements DirectoryProvider {
  readonly requiredGroups: readonly string[];
  private token: { value: string; expiresAt: number } | undefined;
  private readonly fetch: Fetch;

  constructor(
    private readonly options: {
      providerId: string;
      credentials: GoogleDirectoryCredentials;
      requiredGroups?: readonly string[];
      fetch?: Fetch;
      now?: () => number;
    },
  ) {
    this.requiredGroups = (options.requiredGroups ?? []).map(normalizeGroup);
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get providerId(): string {
    return this.options.providerId;
  }

  async check(args: {
    accountId: string;
    email: string;
    groups: readonly string[];
  }): Promise<DirectoryAccountStatus> {
    const user = await this.get(
      `${DIRECTORY}/users/${encodeURIComponent(args.accountId)}?fields=id,suspended,archived`,
    );
    if (user.status === 404) return { active: false, reason: "deleted" };
    const record = await this.json(user, "user lookup");
    if (record.suspended === true)
      return { active: false, reason: "suspended" };
    if (record.archived === true) return { active: false, reason: "archived" };
    const wanted = [
      ...new Set([...this.requiredGroups, ...args.groups.map(normalizeGroup)]),
    ];
    const groups: string[] = [];
    for (const group of wanted) {
      const response = await this.get(
        `${DIRECTORY}/groups/${encodeURIComponent(group)}/hasMember/${encodeURIComponent(args.accountId)}`,
      );
      if (response.status === 404) {
        // A required group that does not exist is a configuration fault, not
        // a verdict on this person: never disable everyone over a typo.
        if (this.requiredGroups.includes(group))
          throw new DirectoryUnavailableError(
            `Required group ${group} does not exist in Google Workspace`,
          );
        continue;
      }
      const body = await this.json(response, "group membership");
      if (body.isMember === true) groups.push(group);
    }
    return requireGroups(this, { active: true, groups });
  }

  private async get(url: string): Promise<Response> {
    try {
      return await this.fetch(url, {
        headers: { authorization: `Bearer ${await this.accessToken()}` },
      });
    } catch (error) {
      if (error instanceof DirectoryUnavailableError) throw error;
      throw new DirectoryUnavailableError("Google Directory is unreachable", {
        cause: error,
      });
    }
  }

  private async json(
    response: Response,
    what: string,
  ): Promise<Record<string, unknown>> {
    if (!response.ok) {
      throw new DirectoryUnavailableError(
        `Google Directory ${what} failed with HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new DirectoryUnavailableError(
        `Google Directory ${what} returned an unexpected body`,
      );
    }
    return Object.fromEntries(Object.entries(body));
  }

  private async accessToken(): Promise<string> {
    const now = this.options.now?.() ?? Date.now();
    if (this.token && this.token.expiresAt - 60_000 > now) {
      return this.token.value;
    }
    const credentials = this.options.credentials;
    const response =
      "metadataServer" in credentials
        ? await this.fetch(`${METADATA_TOKEN}?scopes=${SCOPES.join(",")}`, {
            headers: { "metadata-flavor": "Google" },
          })
        : await this.exchangeServiceAccountKey(credentials.keyFile, now);
    const body = await this.json(response, "token request");
    if (
      typeof body.access_token !== "string" ||
      typeof body.expires_in !== "number"
    ) {
      throw new DirectoryUnavailableError(
        "Google token response is missing an access token",
      );
    }
    this.token = {
      value: body.access_token,
      expiresAt: now + body.expires_in * 1000,
    };
    return this.token.value;
  }

  private exchangeServiceAccountKey(
    keyFile: string,
    now: number,
  ): Promise<Response> {
    const key = readServiceAccountKey(keyFile);
    const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";
    const issuedAt = Math.floor(now / 1000);
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: key.client_email,
      scope: SCOPES.join(" "),
      aud: tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })}`;
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(key.private_key)
      .toString("base64url");
    return this.fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }).toString(),
    });
  }
}

function readServiceAccountKey(file: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new DirectoryUnavailableError(
      "The Google service account key could not be read",
      { cause: error },
    );
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "client_email" in parsed &&
    typeof parsed.client_email === "string" &&
    "private_key" in parsed &&
    typeof parsed.private_key === "string"
  ) {
    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      ...("token_uri" in parsed && typeof parsed.token_uri === "string"
        ? { token_uri: parsed.token_uri }
        : {}),
    };
  }
  throw new DirectoryUnavailableError(
    "The Google service account key is missing client_email or private_key",
  );
}
