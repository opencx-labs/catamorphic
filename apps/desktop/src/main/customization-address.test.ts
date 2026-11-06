import { expect, it } from "vitest";
import {
  assertCustomizationRunAccess,
  customizationStateKey,
  privateWorkflowAddress,
} from "./customization-address.js";

it("keeps state keys within canonical package partitions", () => {
  expect(customizationStateKey({ subject: "one", key: "todos" })).not.toBe(
    customizationStateKey({ subject: "two", key: "todos" }),
  );
  expect(
    customizationStateKey({
      subject: "one",
      key: "_work/background-processes",
    }),
  ).toMatch(/^_work\/packages\/[a-f0-9]{64}\/_work\/background-processes$/);
  for (const key of ["../escape", "/root", "a/../root", "a\\root", "a//b", ""])
    expect(() => customizationStateKey({ subject: "one", key })).toThrow();
});
it("binds private workflow handles to exact declared revision rather than a shared name", () => {
  const artifactId = "106c7337-5a5b-49ba-b9b4-655ec4c32ac3";
  const address = `private:${artifactId}:2`;
  const retained = {
    artifactId,
    revision: 2,
    lifetime: "member",
  } satisfies NonNullable<
    Parameters<typeof assertCustomizationRunAccess>[0]["retained"]
  >;
  expect(privateWorkflowAddress(address)).toEqual({ artifactId, revision: 2 });
  expect(privateWorkflowAddress("todos")).toBeNull();
  expect(() =>
    privateWorkflowAddress(`private:${artifactId}:2:extra`),
  ).toThrow();
  expect(() =>
    assertCustomizationRunAccess({
      workflows: ["todos"],
      workflowName: "todos",
      retained,
    }),
  ).toThrow();
  expect(() =>
    assertCustomizationRunAccess({
      workflows: [address],
      workflowName: "todos",
      retained,
    }),
  ).not.toThrow();
  expect(() =>
    assertCustomizationRunAccess({
      workflows: [address],
      workflowName: "todos",
      retained: { ...retained, revision: 3 },
    }),
  ).toThrow();
  expect(() =>
    assertCustomizationRunAccess({
      workflows: ["todos"],
      workflowName: "todos",
      retained: { ...retained, lifetime: "session" },
    }),
  ).toThrow();
});
