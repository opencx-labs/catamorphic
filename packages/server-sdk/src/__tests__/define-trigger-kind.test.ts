import { renderTriggerTypesModule } from "@catamorphic/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTriggerKind } from "../define-trigger-kind.js";

const ticketCreated = defineTriggerKind({
  name: "ticket.created",
  description: "A ticket was created",
  display: { label: "Ticket Created", icon: "bell" },
  payload: z.object({
    ticketId: z.string(),
    priority: z.enum(["low", "high"]),
  }),
  config: z.object({
    onlyPriority: z.enum(["low", "high"]).optional(),
  }),
  correlationKey: (payload) => payload.ticketId,
});

describe("defineTriggerKind", () => {
  it("validates payloads and configs through the zod schemas", () => {
    expect(
      ticketCreated.validatePayload({ ticketId: "T-1", priority: "high" }),
    ).toEqual({ ok: true });
    const bad = ticketCreated.validatePayload({ ticketId: 5 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join(" ")).toContain("ticketId");
    }
    expect(ticketCreated.validateConfig({})).toEqual({ ok: true });
    expect(ticketCreated.validateConfig({ onlyPriority: "urgent" }).ok).toBe(
      false,
    );
  });

  it("derives correlation keys from validated payloads", () => {
    expect(
      ticketCreated.correlationKey?.({ ticketId: "T-9", priority: "low" }),
    ).toBe("T-9");
  });

  it("defaults the config schema to an empty object", () => {
    const bare = defineTriggerKind({
      name: "bare.kind",
      payload: z.object({ id: z.string() }),
    });
    expect(bare.validateConfig({})).toEqual({ ok: true });
    expect(bare.validateConfig({ extra: true }).ok).toBe(false);
  });

  it("produces JSON schemas that render usable generated types", () => {
    const content = renderTriggerTypesModule([ticketCreated]);
    expect(content).toContain('"ticket.created"');
    expect(content).toContain("ticketId: string;");
    expect(content).toContain('priority: "low" | "high";');
    expect(content).toContain('onlyPriority?: "low" | "high";');
  });
});
