import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { CatamorphicCore } from "../core.js";
import { composeInitialFiles } from "../services/projects-service.js";
import { SEED_SKILLS, TEMPLATES } from "../templates.js";

/**
 * Doctrine hooks (ADR 0049): `projectSeeds` / `projectTemplates` /
 * `standingAgentPrompt` resolve ONCE at core construction, and every
 * consumer sees the host-final set. Construction is pure wiring, so a
 * dummy db/projectManager suffices here; the on-disk effects are covered
 * by `doctrine-hooks.integration.test.ts`.
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

describe("projectTemplates hook", () => {
  const acmeTemplate = {
    id: "acme-crm",
    name: "Acme CRM",
    description: "Acme's starter",
    defaultWorkflow: "syncContacts",
    files: { "workflows/src/crm.ts": "export {};" },
  };

  it("defaults to the framework templates", () => {
    const core = dummyCore();
    expect(core.projectTemplates).toEqual(TEMPLATES);
    expect(core.projects.listTemplates()).toEqual(TEMPLATES);
  });

  it("serves the host-final set through ProjectsService", () => {
    const projectTemplates = vi.fn(() => [acmeTemplate]);
    const core = dummyCore({ projectTemplates });

    expect(projectTemplates).toHaveBeenCalledTimes(1);
    expect(core.projects.listTemplates()).toEqual([acmeTemplate]);
    expect(core.projects.findTemplate("acme-crm")).toEqual(acmeTemplate);
    expect(core.projects.findTemplate("orders-dashboard")).toBeUndefined();
    // The framework default list is untouched.
    expect(TEMPLATES.some((t) => t.id === "orders-dashboard")).toBe(true);
  });
});

describe("composeInitialFiles", () => {
  const seeds = {
    [MECHANICS_SKILL_PATH]: "mechanics",
    ".agents/skills/acme-design/SKILL.md": "# Acme design",
  };

  it("blank creates get exactly the resolved seeds", () => {
    expect(composeInitialFiles(seeds)).toEqual(seeds);
  });

  it("template creates layer template files over the seeds, template winning collisions", () => {
    const composed = composeInitialFiles(seeds, {
      id: "t",
      name: "T",
      description: "",
      defaultWorkflow: "w",
      files: {
        "workflows/src/w.ts": "export {};",
        [MECHANICS_SKILL_PATH]: "template-specific mechanics",
      },
    });
    expect(composed).toEqual({
      ".agents/skills/acme-design/SKILL.md": "# Acme design",
      [MECHANICS_SKILL_PATH]: "template-specific mechanics",
      "workflows/src/w.ts": "export {};",
    });
  });
});
