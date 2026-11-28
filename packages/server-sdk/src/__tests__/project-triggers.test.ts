import {
  PROJECT_DEPLOY_EVENT,
  PROJECT_EVENT_SOURCE,
  triggerKindInfo,
} from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import { describe, expect, it } from "vitest";
import { PROJECT_TRIGGER_KINDS } from "../project-trigger-kinds.js";

const [deploy] = PROJECT_TRIGGER_KINDS;
if (!deploy) throw new Error("The deploy kind is not registered");

/** The deploy event as a run receives it. */
function delivered(detail: Json) {
  return {
    id: "event-1",
    sequence: 7,
    projectId: "project-1",
    source: PROJECT_EVENT_SOURCE,
    kind: PROJECT_DEPLOY_EVENT,
    externalId: "deploy:revision-1:0",
    occurredAt: "2026-11-28T09:00:00.000Z",
    receivedAt: "2026-11-28T09:00:00.000Z",
    payload: {
      actor: { kind: "system", code: PROJECT_DEPLOY_EVENT },
      causation: [],
      detail,
    },
  };
}

describe("project trigger kinds (ADR 0355)", () => {
  it("registers the deploy event under the name workflows bind", () => {
    expect(PROJECT_TRIGGER_KINDS.map((kind) => kind.name)).toEqual([
      "project.deploy",
    ]);
    expect(PROJECT_DEPLOY_EVENT).toBe("project.deploy");
    expect(PROJECT_EVENT_SOURCE).toBe("project");
    expect(triggerKindInfo(deploy)).toMatchObject({
      name: "project.deploy",
      modes: ["async"],
      display: { label: "deploy", icon: "rocket" },
    });
    // What an author reads says what the run is for and what it carries.
    expect(deploy.description).toContain("input.payload.detail");
    expect(deploy.description).toContain("previousCommit");
    expect(deploy.description).not.toMatch(/[\u2013\u2014]/);
  });

  it("types the revision and the one live before it, which a first deploy lacks", () => {
    const commit = "b".repeat(40);
    expect(
      deploy.validatePayload(
        delivered({ commit, previousCommit: "a".repeat(40) }),
      ),
    ).toEqual({ ok: true });
    expect(
      deploy.validatePayload(delivered({ commit, previousCommit: null })),
    ).toEqual({ ok: true });
    expect(deploy.validatePayload(delivered({ commit })).ok).toBe(false);
    expect(deploy.validatePayload(delivered({ previousCommit: null })).ok).toBe(
      false,
    );
  });

  it("is bound with no config: every binding hears every deploy", () => {
    expect(deploy.validateConfig({})).toEqual({ ok: true });
    expect(deploy.matches).toBeUndefined();
  });
});
