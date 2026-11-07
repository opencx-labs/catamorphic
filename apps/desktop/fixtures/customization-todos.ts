/** A checked example, also exercised through the real desktop UI. */
import { readFile } from "node:fs/promises";
import type {
  SidebarActionInput,
  SidebarInputValues,
  SidebarPreviewMetadata,
  SidebarSourceItem,
  SidebarSourceModule,
  SidebarSourceWork,
} from "@catamorphic/work-customization";

export const addTodoInput = {
  title: "Add task",
  submit: "Add task",
  fields: [
    { name: "title", label: "Title", required: true, maxLength: 200 },
    { name: "notes", label: "Notes", type: "textarea" },
    {
      name: "reminders",
      label: "Reminders",
      type: "repeat",
      minItems: 1,
      maxItems: 5,
      addLabel: "Add reminder",
      fields: [
        {
          name: "preset",
          label: "Remind me",
          type: "select",
          value: "2d",
          options: [
            { label: "2 days", value: "2d" },
            { label: "One week", value: "1w" },
            { label: "Custom timeout", value: "custom" },
            { label: "At a date and time", value: "at" },
          ],
        },
        {
          name: "amount",
          label: "After",
          type: "number",
          value: 1,
          required: true,
          min: 1,
          when: { field: "preset", equals: "custom" },
        },
        {
          name: "unit",
          label: "Unit",
          type: "select",
          value: "hours",
          options: [
            { label: "Seconds", value: "seconds" },
            { label: "Minutes", value: "minutes" },
            { label: "Hours", value: "hours" },
            { label: "Days", value: "days" },
          ],
          when: { field: "preset", equals: "custom" },
        },
        {
          name: "at",
          label: "Reminder time",
          type: "datetime",
          required: true,
          when: { field: "preset", equals: "at" },
        },
      ],
    },
  ],
} satisfies SidebarActionInput;

type Todo = {
  id: string;
  title: string;
  notes: string;
  reminders: string[];
  done: boolean;
};
async function read(work: SidebarSourceWork) {
  const state = await work.state.read({ key: "todos" });
  const todos = state.value ?? [];
  if (!Array.isArray(todos) || !todos.every(isTodo))
    throw Error("Stored tasks have an invalid format.");
  return { state, todos };
}
function isTodo(value: unknown): value is Todo {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "title" in value &&
    typeof value.title === "string" &&
    "notes" in value &&
    typeof value.notes === "string" &&
    "done" in value &&
    typeof value.done === "boolean" &&
    "reminders" in value &&
    Array.isArray(value.reminders) &&
    value.reminders.every((v: unknown) => typeof v === "string")
  );
}
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const text = (value: unknown) => (typeof value === "string" ? value : "");
function instants(values: SidebarInputValues): string[] {
  if (!Array.isArray(values.reminders)) throw Error("Choose a reminder.");
  return values.reminders.map((v) => {
    if (v.preset === "at") {
      const at = new Date(text(v.at));
      if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now())
        throw Error("Choose a future reminder time.");
      return at.toISOString();
    }
    const units: Record<string, number> = {
      seconds: 1000,
      minutes: 60000,
      hours: 3600000,
      days: 86400000,
    };
    const ms =
      v.preset === "2d"
        ? 172800000
        : v.preset === "1w"
          ? 604800000
          : v.preset === "custom" && typeof v.amount === "number"
            ? v.amount * (units[text(v.unit)] ?? 0)
            : 0;
    if (!Number.isFinite(ms) || ms <= 0)
      throw Error("Choose a positive reminder timeout.");
    return new Date(Date.now() + ms).toISOString();
  });
}
export default {
  async load({ work, parentId }) {
    if (parentId) return { items: [] };
    const { todos } = await read(work);
    return {
      items: todos
        .filter((t) => !t.done)
        .map(
          (t): SidebarSourceItem => ({
            id: t.id,
            label: t.title,
            icon: "Circle",
            url: "file:tasks.md",
            menu: [
              { action: "open-tab", label: "Open in new tab" },
              {
                action: "rename",
                label: "Rename",
                input: {
                  fields: [
                    {
                      name: "title",
                      label: "Title",
                      value: t.title,
                      required: true,
                    },
                  ],
                },
              },
              { action: "done", label: "Done" },
            ],
            preview: {
              title: t.title,
              description: t.notes,
              metadata: [
                ...t.reminders.map(
                  (at, i): SidebarPreviewMetadata => ({
                    label: `Reminder ${i + 1}`,
                    value: `${new Intl.DateTimeFormat("en", {
                      dateStyle: "full",
                      timeStyle: "long",
                      timeZone: "Asia/Amman",
                    }).format(new Date(at))} (Asia/Amman)`,
                    copy: at,
                    tone: "info",
                  }),
                ),
                {
                  label: "Status",
                  value: "Scheduled",
                  display: "color",
                  color: "#35855f",
                  tone: "success",
                },
              ],
              content: {
                markdown:
                  "**Notes**\n\n- Reminders survive closing this view.\n- Use Done to finish the task.",
              },
              actions: [{ action: "copy-title", label: "Copy title" }],
            },
          }),
        ),
    };
  },
  subscribe({ invalidate }) {
    listeners.add(invalidate);
    return () => {
      listeners.delete(invalidate);
    };
  },
  async action({ work, action, itemId, values, projectRoot }) {
    if (action === "copy-title") {
      const { todos } = await read(work);
      return { copy: todos.find((t) => t.id === itemId)?.title ?? "" };
    }
    const { state, todos } = await read(work);
    if (action === "add") {
      const title = text(values?.title).trim();
      if (!title) throw Error("Write a title.");
      const todo = {
        id: crypto.randomUUID(),
        title,
        notes: text(values?.notes),
        reminders: instants(values ?? {}),
        done: false,
      };
      const workflow = text(
        JSON.parse(
          await readFile(`${projectRoot}/reminder-workflow.json`, "utf8"),
        ).workflow,
      );
      for (const [index, dueAt] of todo.reminders.entries())
        await work.start({
          workflow,
          input: { title, dueAt, key: `${todo.id}:${index}` },
        });
      todos.push(todo);
    } else {
      const todo = todos.find((t) => t.id === itemId);
      if (!todo) throw Error("This task is gone.");
      if (action === "rename") {
        const title = text(values?.title).trim();
        if (!title) throw Error("Write a title.");
        todo.title = title;
      } else if (action === "done") todo.done = true;
    }
    await work.state.write({
      key: "todos",
      ifVersion: state.version,
      value: JSON.parse(JSON.stringify(todos)),
    });
    notify();
  },
  async move({ work, itemId, beforeId }) {
    const { state, todos } = await read(work);
    const index = todos.findIndex((t) => t.id === itemId);
    if (index < 0) return;
    const todo = todos.splice(index, 1)[0];
    if (!todo) return;
    const before = todos.findIndex((t) => t.id === beforeId);
    todos.splice(before < 0 ? todos.length : before, 0, todo);
    await work.state.write({
      key: "todos",
      ifVersion: state.version,
      value: JSON.parse(JSON.stringify(todos)),
    });
    notify();
  },
} satisfies SidebarSourceModule;
