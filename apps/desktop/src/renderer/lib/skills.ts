import { useCatamorphic } from "@catamorphic/react";
import { useEffect, useMemo, useState } from "react";

/**
 * A skill as the palette and composer see it: the tiers merged by core
 * (`GET /projects/:id/skills`) — project skills from `.agents/skills/`, the
 * user's personal skills (ADR 0056), host skills shipped by the app
 * (ADR 0049); name collisions resolve project > user > host.
 */
export interface SkillInfo {
  name: string;
  /** Human-facing name (frontmatter `title`, else the humanized slug). */
  title: string;
  description: string;
  path: string;
  source: "project" | "user" | "host";
}

/**
 * The skill list, fetched fresh whenever `active` flips true — skills are
 * files a collaborator (or an agent) may have just written, so a cached
 * snapshot would show the wrong rows (the ADR 0050 freshness rule).
 */
export function useProjectSkills(
  projectId: string | undefined,
  active: boolean,
  refresh = 0,
): SkillInfo[] {
  return useProjectSkillCatalog(projectId, active, refresh).skills;
}

export function useProjectSkillCatalog(
  projectId: string | undefined,
  active: boolean,
  refresh = 0,
) {
  const { apiClient } = useCatamorphic();
  // A reopening is a new request even for the same project. Scope the result
  // during render so old rows cannot flash before the refresh effect runs.
  const request = useMemo(
    () => ({ projectId, active, refresh, apiClient }),
    [projectId, active, refresh, apiClient],
  );
  const [catalog, setCatalog] = useState<{
    request?: typeof request;
    skills: SkillInfo[];
    loading: boolean;
    error?: string;
  }>({ skills: [], loading: true });
  useEffect(() => {
    if (!request.active || !request.projectId) return;
    let cancelled = false;
    setCatalog({ request, skills: [], loading: true });
    void request.apiClient
      .GET("/api/projects/{projectId}/skills", {
        params: { path: { projectId: request.projectId } },
      })
      .then((result) => {
        if (!result.data) throw new Error("Could not load skills.");
        if (!cancelled)
          setCatalog({ request, skills: result.data, loading: false });
      })
      .catch(() => {
        if (!cancelled)
          setCatalog({
            request,
            skills: [],
            loading: false,
            error: "Could not load skills. Retry to refresh the list.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);
  return catalog.request === request
    ? catalog
    : { skills: [], loading: active };
}

/** Shared by both skill launchers; an empty picked set really offers no skills. */
export function skillsForAgent(
  skills: SkillInfo[],
  setting?: { mode: "all" } | { mode: "picked"; names: string[] },
): SkillInfo[] {
  return setting?.mode === "picked"
    ? skills.filter((skill) => setting.names.includes(skill.name))
    : skills;
}

/**
 * The message a skill invocation sends. Deliberately harness-neutral prose:
 * every harness knows the skill by name (Claude Code natively via the
 * host-skills plugin and its own discovery; the others through the
 * workspace system prompt's skill listing plus the read_skill tool).
 */
export function skillInvocation(name: string, args?: string): string {
  const trimmed = args?.trim();
  return trimmed
    ? `Use the "${name}" skill: ${trimmed}`
    : `Use the "${name}" skill.`;
}
