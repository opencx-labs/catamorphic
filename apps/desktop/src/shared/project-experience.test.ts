import { describe, expect, it } from "vitest";
import {
  matchesProjectExperience,
  sanitizeProjectExperienceWhen,
  writesProgram,
} from "./project-experience.js";

describe("project experience targeting", () => {
  const maintainer = {
    root: false,
    permissions: ["brain:maintain", "memberships:write"],
  };

  it("requires every named permission", () => {
    expect(
      matchesProjectExperience({ permissions: ["brain:maintain"] }, maintainer),
    ).toBe(true);
    expect(
      matchesProjectExperience(
        { permissions: ["brain:maintain", "roles:write"] },
        maintainer,
      ),
    ).toBe(false);
    expect(
      matchesProjectExperience({ permissions: ["program:write"] }, maintainer),
    ).toBe(false);
  });

  it("lets root authority preview every project-authored experience", () => {
    expect(
      matchesProjectExperience(
        { permissions: ["company:anything"] },
        { root: true, permissions: [] },
      ),
    ).toBe(true);
  });

  it("fails closed for malformed predicates and the retired builder flag", () => {
    expect(sanitizeProjectExperienceWhen("builder")).toBeNull();
    expect(sanitizeProjectExperienceWhen({ builder: true })).toBeNull();
    expect(
      sanitizeProjectExperienceWhen({ permission: "brain:maintain" }),
    ).toBeNull();
    expect(
      sanitizeProjectExperienceWhen({ permissions: ["brain-maintainer"] }),
    ).toBeNull();
    expect(
      sanitizeProjectExperienceWhen({
        permissions: ["brain:maintain", "brain:maintain"],
      }),
    ).toEqual({ permissions: ["brain:maintain"] });
  });

  it("a member writes the program only with program:write", () => {
    expect(writesProgram({ permissions: ["program:write"] })).toBe(true);
    expect(writesProgram({ permissions: ["program:read"] })).toBe(false);
    expect(writesProgram(null)).toBe(false);
  });
});
