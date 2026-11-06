import { type CallExpression, Node } from "ts-morph";

export type TransitionCallName = "pause" | "callWorkflow";

/**
 * The transition a call names, whether the boundary destructured it
 * (`pause(...)`) or reads it from its context (`context.pause(...)`). Only a
 * bare identifier receiver counts, so an unrelated `player.pause()` on a
 * nested object is never mistaken for one.
 */
export function transitionCallName(
  call: CallExpression,
): TransitionCallName | undefined {
  const callee = call.getExpression();
  const name = Node.isIdentifier(callee)
    ? callee.getText()
    : Node.isPropertyAccessExpression(callee) &&
        Node.isIdentifier(callee.getExpression())
      ? callee.getName()
      : undefined;
  return name === "pause" || name === "callWorkflow" ? name : undefined;
}
