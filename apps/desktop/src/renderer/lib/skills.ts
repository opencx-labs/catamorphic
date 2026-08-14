import { useCatamorphic } from "@catamorphic/react";
import { useEffect, useState } from "react";

/**
 * A skill as the palette and composer see it: the two tiers merged by core
 * (`GET /projects/:id/skills`) — project skills from `.agents/skills/`, host
 * skills shipped by the app (ADR 0049), project winning name collisions.
 */
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: "project" | "host";
}

/**
 * The skill list, fetched fresh whenever `active` flips true — skills are
 * files a collaborator (or an agent) may have just written, so a cached
 * snapshot would show the wrong rows (the ADR 0050 freshness rule).
 */
export function useProjectSkills(
  projectId: string | undefined,
  active: boolean,
  /** Bump to refetch while `active` stays true (e.g. per palette open). */
  refresh = 0,
): SkillInfo[] {
  const { apiClient } = useCatamorphic();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is a deliberate retrigger — bumping it refetches with nothing else changed
  useEffect(() => {
    if (!active || !projectId) return;
    let cancelled = false;
    void apiClient
      .GET("/api/projects/{projectId}/skills", {
        params: { path: { projectId } },
      })
      .then((result) => {
        if (!cancelled && result.data) setSkills(result.data);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, projectId, apiClient, refresh]);
  return skills;
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
