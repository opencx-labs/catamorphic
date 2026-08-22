import { describe, expect, it } from "vitest";
import { randomId } from "./random-id.js";

describe("randomId", () => {
  it("creates a UUID without the secure-context-only randomUUID API", () => {
    const fill = (values: Uint8Array) => {
      for (let index = 0; index < values.length; index += 1) {
        values[index] = index;
      }
    };

    expect(randomId(fill)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });
});
