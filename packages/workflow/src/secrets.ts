/** Declaration for one secret a project needs at run time. */
export interface SecretDeclaration {
  /** Human-readable label shown where values are entered. */
  label?: string;
  description?: string;
  /** Defaults to true. A required secret with no value fails the run. */
  required?: boolean;
  /** Applied when no value is set for the run's environment. */
  default?: string;
}

export type SecretDeclarations = Record<string, SecretDeclaration>;

export type Secrets<T extends SecretDeclarations> = {
  readonly [K in keyof T & string]: string;
};

export class MissingSecretError extends Error {
  constructor(readonly secretName: string) {
    super(
      `Secret '${secretName}' has no value. Set it for this environment before running.`,
    );
    this.name = "MissingSecretError";
  }
}

/**
 * Declares the secrets a project needs and returns a typed accessor. Values are
 * injected into the process environment for the run's environment (test or
 * production); reading an unset secret throws rather than yielding `undefined`,
 * so a misconfiguration fails at the point of use with a clear message.
 *
 * Secrets are backend-only. They are never sent to a browser, never included in
 * an app bundle, and never readable through the app broker.
 *
 * ```typescript
 * export const secrets = defineSecrets({
 *   STRIPE_API_KEY: { description: "Stripe secret key" },
 * });
 *
 * async function charge({ amount }: { amount: number }) {
 *   "use step";
 *   await stripe(secrets.STRIPE_API_KEY).charge(amount);
 * }
 * ```
 */
export function defineSecrets<const T extends SecretDeclarations>(
  declarations: T,
): Secrets<T> {
  for (const name of Object.keys(declarations)) {
    assertValidSecretName(name);
  }

  return new Proxy({} as Secrets<T>, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      const value = process.env[property];
      if (value === undefined || value === "") {
        throw new MissingSecretError(property);
      }
      return value;
    },
    has(_target, property) {
      return typeof property === "string" && property in declarations;
    },
    ownKeys() {
      return Object.keys(declarations);
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true };
    },
  });
}

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_PREFIX = "CATAMORPHIC_";

function assertValidSecretName(name: string): void {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid secret name '${name}'. Secret names must be SCREAMING_SNAKE_CASE env-var style.`,
    );
  }
  if (name.startsWith(RESERVED_PREFIX)) {
    throw new Error(
      `Invalid secret name '${name}'. Secret names must not use the reserved ${RESERVED_PREFIX} prefix.`,
    );
  }
}
