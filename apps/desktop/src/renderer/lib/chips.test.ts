import type { SessionPullRequestState } from "@catamorphic/agent-protocol";
import { describe, expect, it } from "vitest";
import type { PullRequestStatus } from "../../shared/pr-details.js";
import { chipLines, shownChipCount } from "./chip-layout.js";
import {
  attachedChips,
  type Chip,
  groupChips,
  pullRequestChip,
  workChips,
} from "./chips.js";

const status = (over: Partial<PullRequestStatus> = {}): PullRequestStatus => ({
  number: 12,
  title: "Chips that say where work stands",
  url: "https://github.com/acme/web/pull/12",
  repository: "acme/web",
  author: "octo",
  head: "work/chips",
  base: "main",
  state: "open",
  additions: 14215,
  deletions: 0,
  changedFiles: 113,
  comments: 9,
  checks: { state: "failure", passed: 4, failed: 1, pending: 0 },
  updatedAt: "2026-10-16T09:00:00.000Z",
  ...over,
});

const tab = (id: string, kind: string): Chip => ({
  id,
  label: id,
  url: id,
  data: { kind },
});

describe("pull request chips", () => {
  it("draw what the chat recorded until the host says where it stands", () => {
    const chip = pullRequestChip({
      pr: {
        url: "https://github.com/acme/web/pull/12",
        number: 12,
        title: "Chips",
        state: "draft",
      },
    });
    expect(chip).toMatchObject({
      id: "https://github.com/acme/web/pull/12",
      label: "#12",
      description: "Chips",
      icon: "GitPullRequestDraft",
      wide: true,
      url: "https://github.com/acme/web/pull/12",
      actions: [{ action: "remove", icon: "X" }],
      data: { kind: "pull-request", state: "draft", number: 12 },
    });
    expect(chip.tone).toBeUndefined();
    expect(chip.badges).toBeUndefined();
  });

  it("read their number from their address when the chat recorded none", () => {
    expect(
      pullRequestChip({
        pr: { url: "https://github.com/acme/web/pull/31/files", title: "T" },
      }),
    ).toMatchObject({ label: "#31", description: "T" });
    expect(
      pullRequestChip({ pr: { url: "https://forge.invalid/a/b/merge/7" } })
        .label,
    ).toBe("forge.invalid/a/b/merge/7");
  });

  it("take the host's state, size, comments and checks", () => {
    const chip = pullRequestChip({
      pr: { url: "https://github.com/acme/web/pull/12", state: "open" },
      status: status({ state: "merged", checks: undefined }),
    });
    expect(chip).toMatchObject({
      label: "#12",
      description: "Chips that say where work stands",
      icon: "GitMerge",
      tone: "info",
      badges: [
        { label: "+14,215", tone: "success" },
        { label: "−0", tone: "danger" },
        { label: "9", icon: "MessageSquare" },
      ],
    });
    const failing = pullRequestChip({
      pr: { url: "https://github.com/acme/web/pull/12" },
      status: status(),
    });
    expect(failing.tone).toBe("success");
    expect(failing.badges?.at(-1)).toEqual({
      label: "Checks",
      icon: "CircleX",
      tone: "danger",
    });
    const preview = failing.preview === false ? undefined : failing.preview;
    expect(preview?.metadata).toContainEqual({
      label: "Checks",
      value: "1 failing, 4 passed",
    });
  });

  it("take the host's title over the one the chat recorded", () => {
    const chip = pullRequestChip({
      pr: { url: "https://github.com/acme/web/pull/12", title: "Old" },
      status: status({ title: "Renamed on GitHub" }),
    });
    expect(chip.description).toBe("Renamed on GitHub");
  });

  it("list open ones first, then drafts, merged and closed, each as recorded", () => {
    const pr = (number: number, state: SessionPullRequestState) => ({
      url: `https://github.com/acme/web/pull/${number}`,
      number,
      state,
    });
    const pullRequests = [
      pr(1, "merged"),
      pr(2, "open"),
      pr(3, "closed"),
      pr(4, "draft"),
      pr(5, "open"),
      pr(6, "merged"),
    ];
    const numbers = (statuses: ReadonlyMap<string, PullRequestStatus>) =>
      workChips({ pullRequests, statuses, metadata: {}, held: [] }).map(
        (chip) => chip.label,
      );
    expect(numbers(new Map())).toEqual(["#2", "#5", "#4", "#1", "#6", "#3"]);
    // One its host says merged moves down among the merged.
    expect(
      numbers(
        new Map([
          [
            pr(2, "open").url,
            status({ number: 2, url: pr(2, "open").url, state: "merged" }),
          ],
        ]),
      ),
    ).toEqual(["#5", "#4", "#1", "#2", "#6", "#3"]);
  });
});

describe("attached chips", () => {
  it("are rows held to what a row may be, with Work's buttons by default", () => {
    const chips = attachedChips({
      chips: [
        {
          id: "preview",
          label: "Preview",
          url: "https://preview.example.com",
          icon: "Rocket",
          tone: "success",
          wide: true,
          badges: [{ label: "Live", tone: "success" }],
          data: { env: "staging" },
        },
        { id: "notes", label: "Notes", actions: [{ action: "open-side" }] },
        { id: "Not An Id", label: "Refused" },
        { id: "bad", label: "Bad", tone: "neon", url: "command:archive-chat" },
      ],
    });
    expect(chips.map((chip) => chip.id)).toEqual(["preview", "notes", "bad"]);
    expect(chips[0]).toMatchObject({
      wide: true,
      tone: "success",
      badges: [{ label: "Live", tone: "success" }],
      actions: [
        { action: "open-side", label: "Open to the side", icon: "Columns2" },
        { action: "remove", label: "Remove from chat" },
      ],
      data: { env: "staging", kind: "attached" },
    });
    // A verb of Work's needs no label of its own, and an agent's chip
    // keeps Work's X whatever buttons it names.
    expect(chips[1]?.actions).toEqual([
      { action: "open-side", label: "Open to the side", icon: "Columns2" },
      { action: "remove", label: "Remove from chat", icon: "X" },
    ]);
    // Unknown tones and commands that do more than open are left out.
    expect(chips[2]?.tone).toBeUndefined();
    expect(chips[2]?.url).toBeUndefined();
  });

  it("keep a kind their agent named", () => {
    expect(
      attachedChips({
        chips: [{ id: "deploy", label: "Deploy", data: { kind: "deploy" } }],
      })[0]?.data,
    ).toEqual({ kind: "deploy" });
  });
});

describe("grouping", () => {
  it("folds more than three of a kind into one group where the first stood", () => {
    const chips = groupChips([
      tab("browser:1", "browser"),
      tab("terminal:1", "terminal"),
      tab("terminal:2", "terminal"),
      tab("terminal:3", "terminal"),
      { ...tab("terminal:4", "terminal"), signal: "working" },
      tab("editor:1", "editor"),
    ]);
    expect(chips.map((chip) => [chip.id, chip.parentId ?? null])).toEqual([
      ["browser:1", null],
      ["group:terminal", null],
      ["terminal:1", "group:terminal"],
      ["terminal:2", "group:terminal"],
      ["terminal:3", "group:terminal"],
      ["terminal:4", "group:terminal"],
      ["editor:1", null],
    ]);
    expect(chips[1]).toMatchObject({
      label: "Terminals",
      hasChildren: true,
      badges: ["4"],
      signal: "working",
      data: { kind: "group", of: "terminal" },
    });
  });

  it("leaves three of a kind, pull requests and attached chips alone", () => {
    const chips = workChips({
      pullRequests: [1, 2, 3, 4].map((number) => ({
        url: `https://github.com/acme/web/pull/${number}`,
        number,
      })),
      statuses: new Map(),
      metadata: { chips: [{ id: "a", label: "A" }] },
      held: [
        tab("terminal:1", "terminal"),
        tab("terminal:2", "terminal"),
        tab("terminal:3", "terminal"),
      ],
    });
    expect(chips.every((chip) => !chip.parentId)).toBe(true);
    // Compact chips first, packed in lines; wide ones under them.
    expect(chips.map((chip) => chip.data?.kind)).toEqual([
      "terminal",
      "terminal",
      "terminal",
      "attached",
      "pull-request",
      "pull-request",
      "pull-request",
      "pull-request",
    ]);
  });
});

describe("chip lines", () => {
  const compact = (width: number) => ({ width, wide: false });
  const wide = { width: 0, wide: true };

  it("flow compact chips and give a wide one its own line", () => {
    const lines = (boxes: { width: number; wide: boolean }[]) =>
      chipLines({ boxes, width: 320, gap: 6 });
    expect(lines([compact(100), compact(100), compact(100)])).toBe(1);
    expect(lines([compact(100), compact(100), compact(120)])).toBe(2);
    expect(lines([wide, compact(50), wide, compact(50)])).toBe(4);
  });

  it("fold what passes three lines behind the more chip", () => {
    const boxes = Array.from({ length: 12 }, () => compact(100));
    // Three a line in 320: nine fit; the more chip takes the ninth's place.
    expect(
      shownChipCount({ boxes, width: 320, gap: 6, maxLines: 3, moreWidth: 60 }),
    ).toBe(8);
    expect(
      shownChipCount({
        boxes: boxes.slice(0, 9),
        width: 320,
        gap: 6,
        maxLines: 3,
        moreWidth: 60,
      }),
    ).toBe(9);
    // Wide chips past three lines fold too, never to nothing.
    expect(
      shownChipCount({
        boxes: [wide, wide, wide, wide, wide],
        width: 320,
        gap: 6,
        maxLines: 3,
        moreWidth: 60,
      }),
    ).toBe(2);
  });
});
