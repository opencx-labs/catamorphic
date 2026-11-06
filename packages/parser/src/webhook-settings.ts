import { whereErrors } from "./trigger-where.js";

/**
 * The rules a `webhook` binding's settings obey beyond their JSON shape
 * (ADR 0171), shared by the host's config schema, its deploy-time scan and
 * each project's local check, so all three refuse the same settings.
 * Pure functions over JSON: tolerant of any shape, since the shape itself is
 * the schema's to check.
 */

/** One problem with a binding's webhook settings, at a config path. */
export interface WebhookSettingsIssue {
  path: (string | number)[];
  message: string;
}

const PLACEHOLDER = /\{[^}]*\}/g;
const HEADER_PLACEHOLDER = /^\{header:[A-Za-z0-9-]+\}$/;

/** Why these webhook settings could never verify or answer; empty if fine. */
export function webhookSettingsIssues(config: unknown): WebhookSettingsIssue[] {
  if (!isRecord(config)) return [];
  const issues: WebhookSettingsIssue[] = [];
  const verify = config.verify;
  if (isRecord(verify) && verify.scheme === "token")
    oneLocation(verify, ["verify"], issues);
  if (isRecord(verify) && verify.scheme === "hmac") {
    const content =
      typeof verify.content === "string" ? verify.content : "{body}";
    const placeholders: string[] = content.match(PLACEHOLDER) ?? [];
    for (const placeholder of placeholders) {
      if (
        placeholder !== "{body}" &&
        placeholder !== "{timestamp}" &&
        !HEADER_PLACEHOLDER.test(placeholder)
      )
        issues.push({
          path: ["verify", "content"],
          message: `Unknown placeholder ${placeholder}; use {body}, {timestamp} or {header:<name>}`,
        });
    }
    const signsTimestamp = placeholders.includes("{timestamp}");
    if (signsTimestamp && verify.timestamp === undefined)
      issues.push({
        path: ["verify", "content"],
        message: "{timestamp} needs a timestamp source",
      });
    // An unsigned timestamp can be replaced by an attacker replaying a
    // captured delivery, so a tolerance window protects nothing without it.
    if (!signsTimestamp && verify.timestamp !== undefined)
      issues.push({
        path: ["verify", "timestamp"],
        message:
          "A timestamp only rejects replays when the signed content includes {timestamp}",
      });
  }
  const respond = Array.isArray(config.respond) ? config.respond : [];
  for (const [index, rule] of respond.entries()) {
    if (!isRecord(rule)) continue;
    if (isRecord(rule.token))
      oneLocation(rule.token, ["respond", index, "token"], issues);
    for (const message of whereErrors(rule.when, "when"))
      issues.push({ path: ["respond", index, "when"], message });
  }
  return issues;
}

/**
 * One endpoint's settings in a stable form. One webhook name is one URL
 * that verifies and answers senders one way, so every binding of a name in
 * a commit must declare the same settings.
 */
export function webhookSettingsKey(config: unknown): string {
  return canonicalJson(config);
}

/**
 * Bindings in one commit that give a webhook name different settings,
 * however each got there (directly or through project kinds).
 */
export function webhookSettingsConflicts(
  bindings: readonly { workflowName: string; config: unknown }[],
): string[] {
  const errors: string[] = [];
  const first = new Map<string, { workflowName: string; key: string }>();
  for (const binding of bindings) {
    if (!isRecord(binding.config) || typeof binding.config.name !== "string")
      continue;
    const name = binding.config.name;
    const key = webhookSettingsKey(binding.config);
    const seen = first.get(name);
    if (!seen) first.set(name, { workflowName: binding.workflowName, key });
    else if (seen.key !== key)
      errors.push(
        `Workflows '${seen.workflowName}' and '${binding.workflowName}' bind webhook '${name}' with different settings (verify, respond, deliveryId, maxBodyBytes); declare the webhook once in a project trigger kind`,
      );
  }
  return errors;
}

function oneLocation(
  check: Record<string, unknown>,
  path: (string | number)[],
  issues: WebhookSettingsIssue[],
): void {
  if (Boolean(check.header) === Boolean(check.query))
    issues.push({ path, message: "Name exactly one of header or query" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
