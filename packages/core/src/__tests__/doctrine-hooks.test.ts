import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { CatamorphicCore } from "../core.js";
import { SEED_SKILLS } from "../seeds.js";

/**
 * Doctrine hooks (ADR 0049): `projectSeeds` / `standingAgentPrompt`
 * resolve ONCE at core construction, and every consumer sees the
 * host-final set. Construction is pure wiring, so a dummy
 * db/projectManager suffices here; the on-disk effects are covered by
 * `doctrine-hooks.integration.test.ts`.
 */
const dummyCore = (
  config: Partial<ConstructorParameters<typeof CatamorphicCore>[0]> = {},
) =>
  new CatamorphicCore({
    db: {} as Kysely<DB>,
    projectManager: {} as ProjectManager,
    ...config,
  });

const DESIGN_SKILL_PATH = ".agents/skills/designing-apps/SKILL.md";
const MECHANICS_SKILL_PATH = ".agents/skills/building-apps/SKILL.md";

describe("projectSeeds hook", () => {
  it("defaults to the framework seed skills", () => {
    const core = dummyCore();
    expect(core.seedFiles).toEqual(SEED_SKILLS);
  });

  it("resolves once at construction and exposes the host-final map", () => {
    const projectSeeds = vi.fn((defaults: Record<string, string>) => {
      const seeds = { ...defaults };
      delete seeds[DESIGN_SKILL_PATH];
      seeds[".agents/skills/acme-design/SKILL.md"] = "# Acme design";
      return seeds;
    });
    const core = dummyCore({ projectSeeds });

    expect(projectSeeds).toHaveBeenCalledTimes(1);
    expect(core.seedFiles[DESIGN_SKILL_PATH]).toBeUndefined();
    expect(core.seedFiles[".agents/skills/acme-design/SKILL.md"]).toBe(
      "# Acme design",
    );
    // Mechanics survive untouched alongside the host's doctrine.
    expect(core.seedFiles[MECHANICS_SKILL_PATH]).toBe(
      SEED_SKILLS[MECHANICS_SKILL_PATH],
    );
  });

  it("hands the hook a copy — mutating it never corrupts the defaults", () => {
    dummyCore({
      projectSeeds: (defaults) => {
        for (const key of Object.keys(defaults)) delete defaults[key];
        return defaults;
      },
    });
    expect(SEED_SKILLS[DESIGN_SKILL_PATH]).toBeDefined();
    expect(dummyCore().seedFiles).toEqual(SEED_SKILLS);
  });
});
