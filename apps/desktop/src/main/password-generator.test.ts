import { describe, expect, it } from "vitest";
import {
  GENERATED_PASSWORD_LENGTH,
  generateStrongPassword,
} from "./password-generator.js";

describe("generateStrongPassword", () => {
  it("always includes every character class and no look-alikes", () => {
    for (let run = 0; run < 500; run++) {
      const password = generateStrongPassword();
      expect(password).toHaveLength(GENERATED_PASSWORD_LENGTH);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[2-9]/);
      expect(password).toMatch(/[-_.:!]/);
      expect(password).not.toMatch(/[lIO01]/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => generateStrongPassword()),
    );
    expect(seen.size).toBe(200);
  });
});
