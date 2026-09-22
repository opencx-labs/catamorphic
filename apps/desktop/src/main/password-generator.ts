import { randomInt } from "node:crypto";

/**
 * Chrome's generated-password shape: 15 characters with every class
 * present, drawn from sets that drop look-alikes (l/I/1, O/0) so a
 * password read off a screen can be typed back. Symbols are limited to
 * ones site rules almost always accept.
 */
const CLASSES = [
  "abcdefghijkmnpqrstuvwxyz",
  "ABCDEFGHJKLMNPQRSTUVWXYZ",
  "23456789",
  "-_.:!",
] as const;

export const GENERATED_PASSWORD_LENGTH = 15;

export function generateStrongPassword(
  length = GENERATED_PASSWORD_LENGTH,
): string {
  const all = CLASSES.join("");
  const pick = (set: string) => set[randomInt(set.length)] ?? "";
  // One from each class, the rest from the union, then shuffled so the
  // guaranteed characters land anywhere.
  const chars = [
    ...CLASSES.map(pick),
    ...Array.from({ length: Math.max(0, length - CLASSES.length) }, () =>
      pick(all),
    ),
  ];
  for (let index = chars.length - 1; index > 0; index--) {
    const swap = randomInt(index + 1);
    [chars[index], chars[swap]] = [chars[swap] ?? "", chars[index] ?? ""];
  }
  return chars.join("");
}
