// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { importSummary } from "./password-file-import.js";

const result = (
  passwords: number,
  passkeys: number,
  existing: number,
  skipped: number,
) => ({ status: "imported" as const, passwords, passkeys, existing, skipped });

describe("importSummary", () => {
  it.each([
    [result(2, 1, 0, 0), "Imported 2 passwords and 1 passkey."],
    [result(0, 3, 2, 0), "Imported 3 passkeys. 2 already saved."],
    [result(0, 0, 4, 0), "Everything in this file is already saved."],
    [result(0, 0, 0, 0), "This file has no website logins or passkeys."],
    [
      result(0, 0, 3, 1),
      "Nothing new to import. 3 already saved, 1 item without a website or passkey left out.",
    ],
  ])("says what an import did", (imported, sentence) => {
    expect(importSummary(imported)).toBe(sentence);
  });
});
