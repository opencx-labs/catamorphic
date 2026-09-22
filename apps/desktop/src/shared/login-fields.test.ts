import { describe, expect, it } from "vitest";
import {
  classifyPasswordField,
  isStandaloneUsername,
  isUsernameCandidate,
} from "./login-fields.js";

const field = (
  type: string,
  autocomplete = "",
  hints = "",
): { type: string; autocomplete: string; hints: string } => ({
  type,
  autocomplete,
  hints,
});

describe("classifyPasswordField", () => {
  it("trusts autocomplete tokens first", () => {
    expect(
      classifyPasswordField({
        field: field("password", "new-password"),
        index: 0,
        count: 1,
        formHints: "Sign in",
      }),
    ).toBe("new-password");
    expect(
      classifyPasswordField({
        field: field("password", "section-a current-password", "new"),
        index: 0,
        count: 2,
        formHints: "",
      }),
    ).toBe("current-password");
  });

  it("reads the form's shape: sign-up pairs and change-password triples", () => {
    const shape = (index: number, count: number) =>
      classifyPasswordField({
        field: field("password"),
        index,
        count,
        formHints: "",
      });
    expect(shape(0, 1)).toBe("current-password");
    expect(shape(0, 2)).toBe("new-password");
    expect(shape(1, 2)).toBe("new-password");
    expect(shape(0, 3)).toBe("current-password");
    expect(shape(2, 3)).toBe("new-password");
  });

  it("falls back to names and the form's call to action", () => {
    expect(
      classifyPasswordField({
        field: field("password", "", "confirm_password"),
        index: 0,
        count: 1,
        formHints: "",
      }),
    ).toBe("new-password");
    expect(
      classifyPasswordField({
        field: field("password", "", "password"),
        index: 0,
        count: 1,
        formHints: "Create your account",
      }),
    ).toBe("new-password");
    expect(
      classifyPasswordField({
        field: field("password", "", "password"),
        index: 0,
        count: 1,
        formHints: "Sign in",
      }),
    ).toBe("current-password");
  });
});

describe("username fields", () => {
  it("accepts account fields beside a password and rejects search or codes", () => {
    expect(isUsernameCandidate(field("email"))).toBe(true);
    expect(isUsernameCandidate(field("text", "username"))).toBe(true);
    expect(isUsernameCandidate(field("text", "", "search"))).toBe(false);
    expect(isUsernameCandidate(field("text", "off", "promo code"))).toBe(false);
    expect(isUsernameCandidate(field("checkbox"))).toBe(false);
  });

  it("requires a standalone username step to identify itself", () => {
    expect(isStandaloneUsername(field("text", "username"))).toBe(true);
    expect(isStandaloneUsername(field("email", "", "Email address"))).toBe(
      true,
    );
    expect(isStandaloneUsername(field("text", "", "Email"))).toBe(false);
    expect(isStandaloneUsername(field("email", "", "Newsletter"))).toBe(false);
  });
});
