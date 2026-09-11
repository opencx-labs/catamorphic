// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { type SkillInfo, useProjectSkillCatalog } from "./skills";

const apiClient = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock("@catamorphic/react", () => ({
  useCatamorphic: () => ({ apiClient }),
}));
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.resetAllMocks();
});

const skill = (name: string): SkillInfo => ({
  name,
  title: name,
  description: name,
  source: "project",
  path: `${name}/SKILL.md`,
});
const pending = () => {
  const result = { resolve: (_value: { data: SkillInfo[] }) => {} };
  const promise = new Promise<{ data: SkillInfo[] }>((resolve) => {
    result.resolve = resolve;
  });
  return { ...result, promise };
};

it("never exposes the previous catalog during a reopen or explicit refresh", async () => {
  const first = pending(),
    reopened = pending(),
    retried = pending();
  apiClient.GET.mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(reopened.promise)
    .mockReturnValueOnce(retried.promise);
  const seen: string[][] = [];
  function Probe({ active, refresh }: { active: boolean; refresh: number }) {
    const catalog = useProjectSkillCatalog("project", active, refresh);
    if (active) seen.push(catalog.skills.map(({ name }) => name));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(async () => {
    root.render(<Probe active refresh={0} />);
  });
  await act(async () => {
    first.resolve({ data: [skill("old")] });
  });
  expect(seen.at(-1)).toEqual(["old"]);
  await act(async () => {
    root.render(<Probe active={false} refresh={0} />);
  });
  seen.length = 0;
  await act(async () => {
    root.render(<Probe active refresh={0} />);
  });
  expect(seen.every((names) => names.length === 0)).toBe(true);
  await act(async () => {
    reopened.resolve({ data: [skill("fresh")] });
  });
  expect(seen.at(-1)).toEqual(["fresh"]);
  seen.length = 0;
  await act(async () => {
    root.render(<Probe active refresh={1} />);
  });
  expect(seen.every((names) => names.length === 0)).toBe(true);
  await act(async () => {
    retried.resolve({ data: [skill("latest")] });
  });
  expect(seen.at(-1)).toEqual(["latest"]);
});

it("ignores a late catalog from another project", async () => {
  const first = pending(),
    second = pending();
  apiClient.GET.mockReturnValueOnce(first.promise).mockReturnValueOnce(
    second.promise,
  );
  const seen: string[][] = [];
  function Probe({ projectId }: { projectId: string }) {
    const catalog = useProjectSkillCatalog(projectId, true);
    seen.push(catalog.skills.map(({ name }) => name));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(async () => {
    root.render(<Probe projectId="first" />);
  });
  await act(async () => {
    root.render(<Probe projectId="second" />);
  });
  await act(async () => {
    second.resolve({ data: [skill("second")] });
  });
  await act(async () => {
    first.resolve({ data: [skill("first")] });
  });
  expect(seen.at(-1)).toEqual(["second"]);
  expect(seen.some((names) => names.includes("first"))).toBe(false);
});
