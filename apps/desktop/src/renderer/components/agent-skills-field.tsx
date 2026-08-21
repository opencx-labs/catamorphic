import type { AgentSkillsSetting } from "../lib/desktop-api.js";
import { type SkillInfo, useProjectSkills } from "../lib/skills.js";

const TIER_LABELS: Record<SkillInfo["source"], string> = {
  project: "Project",
  user: "Personal",
  host: "App",
};

/**
 * Per-agent skills assignment (ADR 0056): every current and future skill
 * (the default), or a pinned set of names across all tiers — project,
 * personal, app. A picked agent's prompt lists only the picked skills.
 * Names are stored, not paths, so a pick survives a skill moving tiers.
 */
export function AgentSkillsField({
  value,
  onChange,
  projectId,
}: {
  value: AgentSkillsSetting;
  onChange: (next: AgentSkillsSetting) => void;
  projectId?: string;
}) {
  // The live skill list is a project surface (project + personal + app
  // tiers merged by core); without a project only the pick is shown.
  const skills = useProjectSkills(projectId, value.mode === "picked");
  const picked = value.mode === "picked" ? value.names : [];
  // Picked names no longer in the list (deleted skill, other project) stay
  // visible and removable — a pick must never silently shrink.
  const known = new Set(skills.map((skill) => skill.name));
  const orphaned = picked.filter((name) => !known.has(name));

  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      Skills
      <select
        value={value.mode}
        onChange={(event) =>
          onChange(
            event.target.value === "all"
              ? { mode: "all" }
              : {
                  mode: "picked",
                  names: value.mode === "picked" ? value.names : [],
                },
          )
        }
        className="field h-8 px-2 text-[13px] text-fg"
        data-testid="agent-skills-mode"
      >
        <option value="all">All skills (including future ones)</option>
        <option value="picked">Choose specific skills</option>
      </select>
      {value.mode === "picked" && (
        <div className="mt-1 flex flex-col gap-1 rounded-md border border-border bg-bg-inset p-2">
          {skills.length === 0 && orphaned.length === 0 && (
            <p className="text-[11px] text-fg-faint">
              {projectId
                ? "No skills in this project yet — the agent gets none."
                : "Open this agent from inside a project to list its skills."}
            </p>
          )}
          {skills.map((skill) => (
            <label
              key={skill.name}
              className="flex cursor-pointer items-center gap-2 text-[12px] text-fg"
            >
              <input
                type="checkbox"
                checked={picked.includes(skill.name)}
                onChange={(event) =>
                  onChange({
                    mode: "picked",
                    names: event.target.checked
                      ? [...picked, skill.name]
                      : picked.filter((name) => name !== skill.name),
                  })
                }
              />
              <span className="truncate">{skill.title}</span>
              <span className="ml-auto shrink-0 text-[11px] text-fg-faint">
                {TIER_LABELS[skill.source]}
              </span>
            </label>
          ))}
          {orphaned.map((name) => (
            <label
              key={name}
              className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-muted"
            >
              <input
                type="checkbox"
                checked
                onChange={() =>
                  onChange({
                    mode: "picked",
                    names: picked.filter((other) => other !== name),
                  })
                }
              />
              <span className="truncate">{name}</span>
              <span className="ml-auto shrink-0 text-[11px] text-fg-faint">
                not found here
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
