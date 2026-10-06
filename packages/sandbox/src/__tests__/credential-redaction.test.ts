import { describe, expect, it } from "vitest";
import {
  gitCloneFailure,
  gitCloneUrl,
  redactUrlCredentials,
} from "../credential-redaction.js";

describe("credentials never travel in messages (ADR 0206)", () => {
  it("removes the user information of every URL", () => {
    expect(
      redactUrlCredentials(
        "fatal: unable to access 'https://x-access-token:ghs_SECRET@github.com/acme/app.git/': 403\nalso http://bob@example.com:8080/x and ssh://git:pw@host/repo",
      ),
    ).toBe(
      "fatal: unable to access 'https://[redacted]@github.com/acme/app.git/': 403\nalso http://[redacted]@example.com:8080/x and ssh://[redacted]@host/repo",
    );
    // Plain URLs, emails, and scp-style remotes are left alone.
    const plain =
      "cloned https://github.com/acme/app.git for dana@example.com from git@github.com:acme/app.git";
    expect(redactUrlCredentials(plain)).toBe(plain);
  });

  it("builds the clone URL, and never says it when the clone fails", () => {
    const opts = { username: "x-access-token", password: "ghs_p@ss/word" };
    const url = gitCloneUrl("https://github.com/acme/app.git", opts);
    expect(url).toBe(
      "https://x-access-token:ghs_p%40ss%2Fword@github.com/acme/app.git",
    );
    expect(gitCloneUrl("https://github.com/acme/app.git")).toBe(
      "https://github.com/acme/app.git",
    );
    const failure = gitCloneFailure({
      output: `Cloning into 'app'...\nfatal: Authentication failed for '${url}'\nremote: token ghs_p@ss/word is invalid for x-access-token`,
      opts,
    });
    expect(failure.message).toContain("git clone failed:");
    expect(failure.message).toContain("Authentication failed");
    for (const secret of ["ghs_p@ss/word", "ghs_p%40ss%2Fword", url])
      expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain("x-access-token");
  });
});
