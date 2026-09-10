import {
  type Attributes,
  type Context,
  context,
  createContextKey,
  propagation,
  ROOT_CONTEXT,
  type Span,
  trace,
} from "@opentelemetry/api";

/** Only these fields inherit. Operation attributes and content stay on their span. */
export const CORRELATION_KEYS = Object.freeze([
  "catamorphic.tenant.id",
  "user.id",
  "catamorphic.project.id",
  "catamorphic.agent.session.id",
  "gen_ai.conversation.id",
  "catamorphic.agent.turn.id",
  "catamorphic.run.id",
  "catamorphic.workflow.name",
  "catamorphic.commit.sha",
  "catamorphic.deployment_artifact.id",
  "catamorphic.queue.job.id",
  "catamorphic.queue.job.kind",
  "catamorphic.queue.job.attempt",
  "catamorphic.workflow.step.attempt.id",
] as const);
export type CorrelationKey = (typeof CORRELATION_KEYS)[number];
const correlationKey = createContextKey("catamorphic.correlation");
class CorrelationScope {
  constructor(
    readonly attributes: Readonly<Attributes>,
    readonly anchor?: Span,
  ) {}
}
const spans = new WeakMap<Span, Readonly<Attributes>>();

/** Local context only: arbitrary inbound baggage is deliberately ignored. */
export function correlationAttributes(parent = context.active()): Attributes {
  const span = trace.getSpan(parent);
  const scope = parent.getValue(correlationKey);
  if (scope instanceof CorrelationScope && scope.anchor === span)
    return { ...scope.attributes };
  return {
    ...((span ? spans.get(span) : undefined) ??
      (scope instanceof CorrelationScope ? scope.attributes : {})),
  };
}

function mergeCorrelation(
  base: Attributes,
  attributes: Attributes,
): Attributes {
  const result = { ...base };
  const changed = (key: CorrelationKey) =>
    base[key] !== undefined &&
    Object.hasOwn(attributes, key) &&
    attributes[key] !== base[key];
  const clear = (keys: readonly CorrelationKey[]) => {
    for (const key of keys) delete result[key];
  };
  if (changed("catamorphic.tenant.id")) clear(CORRELATION_KEYS);
  else if (changed("catamorphic.project.id"))
    clear(
      CORRELATION_KEYS.filter(
        (key) => key !== "catamorphic.tenant.id" && key !== "user.id",
      ),
    );
  else {
    if (
      changed("catamorphic.agent.session.id") ||
      changed("gen_ai.conversation.id")
    )
      clear([
        "catamorphic.agent.session.id",
        "gen_ai.conversation.id",
        "catamorphic.agent.turn.id",
      ]);
    if (changed("catamorphic.run.id"))
      clear([
        "catamorphic.run.id",
        "catamorphic.workflow.name",
        "catamorphic.commit.sha",
        "catamorphic.deployment_artifact.id",
        "catamorphic.queue.job.id",
        "catamorphic.queue.job.kind",
        "catamorphic.queue.job.attempt",
        "catamorphic.workflow.step.attempt.id",
      ]);
  }
  if (changed("catamorphic.queue.job.id"))
    clear([
      "catamorphic.queue.job.id",
      "catamorphic.queue.job.kind",
      "catamorphic.queue.job.attempt",
      "catamorphic.workflow.step.attempt.id",
    ]);
  for (const key of CORRELATION_KEYS) {
    if (!Object.hasOwn(attributes, key)) continue;
    const value = attributes[key];
    // Bound storage/transport size and reject invalid numbers. Omit, never truncate IDs.
    if (typeof value === "string" && value.length > 0 && value.length <= 1024)
      result[key] = value;
    else if (
      key === "catamorphic.queue.job.attempt" &&
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    )
      result[key] = value;
    else delete result[key];
  }
  return result;
}

/** Create an immutable scope. `reset` starts independent work without inherited IDs. */
export function telemetryContext(args: {
  attributes: Attributes;
  parent?: Context;
  reset?: boolean;
}): Context {
  const parent = args.parent ?? context.active();
  return parent.setValue(
    correlationKey,
    new CorrelationScope(
      mergeCorrelation(
        args.reset ? {} : correlationAttributes(parent),
        args.attributes,
      ),
      trace.getSpan(parent),
    ),
  );
}

export function withTelemetryContext<T>(
  args: {
    attributes: Attributes;
    parent?: Context;
    reset?: boolean;
  },
  fn: () => T,
): T {
  return context.with(telemetryContext(args), fn);
}

/**
 * Enrich the current operation with IDs discovered after creation (for example auth).
 * For a different operation or identity, create a new span or use telemetryContext;
 * the OTel API cannot remove attributes already recorded on an existing span.
 */
export function setSpanCorrelation(args: {
  span: Span;
  attributes: Attributes;
  parent?: Context;
}): void {
  const attributes = mergeCorrelation(
    spans.get(args.span) ?? correlationAttributes(args.parent),
    args.attributes,
  );
  spans.set(args.span, Object.freeze(attributes));
  args.span.setAttributes(attributes);
}

/** A carrier for an explicitly trusted peer. No keys cross the boundary implicitly. */
export function injectTelemetryContext(
  args: { baggageKeys?: readonly CorrelationKey[]; parent?: Context } = {},
): Record<string, string> {
  const parent = args.parent ?? context.active();
  const attributes = correlationAttributes(parent);
  const entries: Record<string, { value: string }> = {};
  for (const key of args.baggageKeys ?? []) {
    if (CORRELATION_KEYS.includes(key) && attributes[key] !== undefined)
      entries[key] = { value: String(attributes[key]) };
  }
  const carrier: Record<string, string> = {};
  propagation.inject(
    propagation.setBaggage(
      propagation.deleteBaggage(parent),
      propagation.createBaggage(entries),
    ),
    carrier,
  );
  return carrier;
}

/** Call only after authenticating the remote peer; never use baggage as authorization. */
export function extractTelemetryContext(args: {
  carrier: Record<string, string | string[] | undefined>;
  baggageKeys?: readonly CorrelationKey[];
}): Context {
  const extracted = propagation.extract(ROOT_CONTEXT, args.carrier);
  const baggage = propagation.getBaggage(extracted);
  const attributes: Attributes = {};
  for (const key of args.baggageKeys ?? []) {
    if (!CORRELATION_KEYS.includes(key)) continue;
    const value = baggage?.getEntry(key)?.value;
    if (value !== undefined)
      attributes[key] =
        key === "catamorphic.queue.job.attempt" ? Number(value) : value;
  }
  // Strip baggage after extraction so subsequent third-party requests cannot leak it.
  return telemetryContext({
    parent: propagation.deleteBaggage(extracted),
    attributes,
    reset: true,
  });
}
