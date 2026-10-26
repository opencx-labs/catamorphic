/** Work server authentication contracts, independent of its private auth adapter. */
export interface WorkAuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  username: string | null;
}

export interface WorkAuthSession {
  token: string;
  user: WorkAuthUser;
}

/** One OAuth token pair the authorization server issued. */
export interface WorkAuthGrant {
  id: string;
  userId: string;
  clientId: string;
}

/** Decides whether an upstream account may sign in (ADR 0161). */
export type WorkSignInGate = (args: {
  providerId: string;
  accountId: string;
  email: string;
}) => Promise<void>;

export interface WorkAuth {
  migrate(): Promise<void>;
  createLocalUser(args: {
    username: string;
    name: string;
    password: string;
    email?: string;
  }): Promise<WorkAuthUser>;
  signInUsername(args: {
    username: string;
    password: string;
  }): Promise<WorkAuthSession>;
  resolveSession(args: { token: string }): Promise<WorkAuthUser | null>;
  /** The browser session a request's cookies carry (share viewing). */
  sessionFromCookies(args: { cookie: string }): Promise<WorkAuthUser | null>;
  findUserById(args: { userId: string }): Promise<WorkAuthUser | null>;
  findUserByEmail(args: { email: string }): Promise<WorkAuthUser | null>;
  resolveAccessToken(args: { authorization: string }): Promise<{
    userId: string;
    email: string;
    emailVerified: boolean;
    scopes: string[];
  } | null>;
  /** The upstream accounts a user has signed in with. */
  accountsFor(args: {
    userId: string;
  }): Promise<Array<{ providerId: string; accountId: string }>>;
  grantByAccessToken(args: {
    accessToken: string;
  }): Promise<WorkAuthGrant | null>;
  grantByRefreshToken(args: {
    refreshToken: string;
  }): Promise<WorkAuthGrant | null>;
  deleteGrants(args: { ids: readonly string[] }): Promise<void>;
  /** Delete every token pair and browser session of one user. */
  signOutEverywhere(args: { userId: string }): Promise<void>;
  /** Users holding at least one unexpired refresh token. */
  /** Users holding a live OAuth grant or browser session. */
  usersSignedIn(): Promise<string[]>;
  handler(request: Request): Promise<Response>;
  close(): Promise<void>;
}
