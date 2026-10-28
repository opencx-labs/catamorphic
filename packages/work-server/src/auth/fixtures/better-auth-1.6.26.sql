-- Captured from better-auth 1.6.26 getMigrations().compileMigrations() with
-- Work's email/password, database rate limits, username, bearer, genericOAuth
-- and mcp plugins. Keep this static: importing the current schema would hide
-- legacy column changes and collisions with these original index names.
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null, "username" text unique, "displayUsername" text);

create table "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "oauthApplication" ("id" text not null primary key, "name" text not null, "icon" text, "metadata" text, "clientId" text not null unique, "clientSecret" text, "redirectUrls" text not null, "type" text not null, "disabled" boolean, "userId" text references "user" ("id") on delete cascade, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);

create table "oauthAccessToken" ("id" text not null primary key, "accessToken" text not null unique, "refreshToken" text not null unique, "accessTokenExpiresAt" timestamptz not null, "refreshTokenExpiresAt" timestamptz not null, "clientId" text not null references "oauthApplication" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "scopes" text not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);

create table "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthApplication" ("clientId") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "scopes" text not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null, "consentGiven" boolean not null);

create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");
create index "oauthApplication_userId_idx" on "oauthApplication" ("userId");
create index "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");
create index "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");
create index "oauthConsent_clientId_idx" on "oauthConsent" ("clientId");
create index "oauthConsent_userId_idx" on "oauthConsent" ("userId");
