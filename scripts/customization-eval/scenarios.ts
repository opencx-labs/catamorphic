import { writeFile } from "node:fs/promises";
import path from "node:path";

export interface EvalScenario {
  id: string;
  description: string;
  prompt: string;
}

export const TODO_SEED = [
  {
    label: "Prepare launch notes",
    notes: "Collect the final screenshots and release checklist.",
    url: "file:launch-notes.md",
    dueAt: "2026-11-07T09:00:00.000Z",
  },
  {
    label:
      "Review the customer feedback with the team before the next planning meeting",
    notes:
      "Focus on sidebar spacing, readable names, and useful details on hover.",
    url: "file:customer-feedback.md",
    dueAt: "2026-11-08T10:30:00.000Z",
  },
  {
    label: "Send the weekly update",
    notes: "Include the approved changes and the open questions.",
    url: "file:weekly-update.md",
    dueAt: "2026-11-09T12:00:00.000Z",
  },
];

export const SCENARIOS: readonly EvalScenario[] = [
  {
    id: "todo-sidebar",
    description:
      "An agent builds compact persistent todos; real confined runtime grades rows, hover, clicks, menus, reorder, and restart.",
    prompt:
      "Add a To-dos sidebar section to this project. Start with the three todos in todo-seed.json. Keep each todo to one compact row, including the long title. Show its full title, notes, and due date on hover. Clicking a todo opens its linked document, with Work's normal here/new-tab/side/floating choices. Give each todo a Rename action and a Done action that removes it from this active list. Support dragging to reorder. Preserve renames, completions, and order across the source process restarting. Choose the design and implementation using the installed customization types and the factual reference. Leave the result ready to use and run the checker and preview.",
  },
  {
    id: "private-reminder",
    description:
      "An agent saves member-private state and activates an ordinary reminder workflow; actual scheduler/run worker grades restart and once-only delivery.",
    prompt:
      "Keep a private todo titled as requested in reminder-request.json, due at that file's dueAt time, and arrange a Work notification with that title when it is due. Store the todo under the supplied stateKey. It must remain scheduled after this chat closes and Work restarts, deliver once, and stay private to me. Keep the workflow's source outside this project folder. Make it ready using Work's versioned private state and ordinary private workflows. Creating and activating this local reminder is authorized. PRIVATE-WORKFLOWS.md and the installed workflow package describe the available contract. Choose the implementation; no operating-system job is needed.",
  },
];

export function scenarioById(id: string): EvalScenario {
  const scenario = SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) throw new Error(`Unknown scenario ${id}. Use --list.`);
  return scenario;
}

export async function seedScenario(input: {
  project: string;
  scenario: string;
}): Promise<void> {
  if (input.scenario !== "todo-sidebar") {
    await writeFile(
      path.join(input.project, "AGENTS.md"),
      "# Project facts\n\nThis is an isolated Work project. Installed @catamorphic/workflow declarations\nand work-host.d.ts describe the exact workflow and host trigger contracts.\nPRIVATE-WORKFLOWS.md describes private source, state, and notification lifetimes.\nThe package check script checks TypeScript without running workflow code.\n",
    );
    return;
  }
  await writeFile(
    path.join(input.project, "todo-seed.json"),
    `${JSON.stringify(TODO_SEED, null, 2)}\n`,
  );
  for (const todo of TODO_SEED)
    await writeFile(
      path.join(input.project, todo.url.slice("file:".length)),
      `# ${todo.label}\n\n${todo.notes}\n`,
    );
  await writeFile(
    path.join(input.project, "AGENTS.md"),
    `# Project facts\n\nThis disposable project is a Work customization evaluation. The installed\n@catamorphic/work-customization package is the public contract.\nCUSTOMIZATION.md describes the running host. The package check script checks\nTypeScript against this installed SDK. No unrelated user settings are present.\n\nThe evaluator discovers your result from eval-entry.json:\n{ "source": "relative/path/to/source.ts", "layout": "relative/path/to/workspace.js" }.\nThese paths are result addresses only; the implementation is ordinary TypeScript.\n`,
  );
}
