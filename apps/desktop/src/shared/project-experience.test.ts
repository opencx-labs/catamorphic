import { describe, expect, it } from "vitest";
import {
  matchesProjectExperience,
  sanitizeProjectExperienceWhen,
} from "./project-experience.js";

describe("project experience targeting", () => {
  const maintainer = {
    root: false,
    builder: false,
    permissions: ["brain:maintain", "memberships:manage"],
  };

  it("matches builder state and requires every named permission", () => {
    expect(
      matchesProjectExperience(
        { builder: false, permissions: ["brain:maintain"] },
        maintainer,
      ),
    ).toBe(true);
    expect(
      matchesProjectExperience(
        { permissions: ["brain:maintain", "roles:manage"] },
        maintainer,
      ),
    ).toBe(false);
    expect(matchesProjectExperience({ builder: true }, maintainer)).toBe(false);
  });

  it("lets root authority preview every project-authored experience", () => {
    expect(
      matchesProjectExperience(
        { permissions: ["company:anything"] },
        { root: true, builder: true, permissions: [] },
      ),
    ).toBe(true);
  });

  it("fails closed for malformed or unnamespaced permission predicates", () => {
    expect(sanitizeProjectExperienceWhen("builder")).toBeNull();
    expect(
      sanitizeProjectExperienceWhen({ permission: "brain:maintain" }),
    ).toBeNull();
    expect(
      sanitizeProjectExperienceWhen({ permissions: ["brain-maintainer"] }),
    ).toBeNull();
    expect(
      sanitizeProjectExperienceWhen({
        builder: false,
        permissions: ["brain:maintain", "brain:maintain"],
      }),
    ).toEqual({ builder: false, permissions: ["brain:maintain"] });
  });
});
