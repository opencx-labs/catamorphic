import { type Attributes, type Meter, metrics } from "@opentelemetry/api";
import { activeTelemetry } from "./scoped-telemetry.js";

/** Resolve at use time so importing libraries before SDK startup is safe. */
export function getMeter(instrumentationScope: string): Meter {
  return (
    activeTelemetry()?.meterProvider ?? metrics.getMeterProvider()
  ).getMeter(instrumentationScope);
}

function instruments(meter: Meter) {
  return {
    duration: meter.createHistogram("catamorphic.operation.duration", {
      description: "Duration of a Catamorphic service or sandbox operation",
      unit: "s",
      advice: {
        explicitBucketBoundaries: [
          0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
        ],
      },
    }),
    active: meter.createUpDownCounter("catamorphic.operation.active", {
      description: "Currently executing Catamorphic operations",
      unit: "{operation}",
    }),
  };
}
const meters = new WeakMap<Meter, ReturnType<typeof instruments>>();

/** IDs and user content must never become metric dimensions. */
export function measureOperation(name: string) {
  const meter = getMeter("@catamorphic/otel");
  const signals = meters.get(meter) ?? instruments(meter);
  meters.set(meter, signals);
  const attributes = { "catamorphic.operation.name": name };
  const start = performance.now();
  signals.active.add(1, attributes);
  let ended = false;
  return (errorType?: string) => {
    if (ended) return;
    ended = true;
    const outcome: Attributes = {
      ...attributes,
      "catamorphic.operation.outcome": errorType ? "error" : "success",
      ...(errorType ? { "error.type": errorType } : {}),
    };
    signals.duration.record((performance.now() - start) / 1000, outcome);
    signals.active.add(-1, attributes);
  };
}
