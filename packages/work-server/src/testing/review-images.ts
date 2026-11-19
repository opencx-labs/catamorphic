import { pinnedClaudeCodeVersion } from "@catamorphic/claude-code/testing";

/**
 * What the end-to-end review test changes in the pack's review image, kept
 * apart from the test: CI caches the images it builds by this file, the
 * pack's Dockerfile and the pinned Claude Code, so a change to the test
 * alone reuses them.
 */

/**
 * The review image trusting the test's own CA, as a production image
 * trusts the public chain.
 */
export function reviewImageTrusting(input: {
  dockerfile: string;
  ca: string;
}): string {
  return [
    input.dockerfile.trimEnd(),
    `RUN printf '%s\\n' ${input.ca
      .trim()
      .split("\n")
      .map((line) => `'${line}'`)
      .join(
        " ",
      )} > /usr/local/share/ca-certificates/work-test-ca.crt && update-ca-certificates`,
    "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/work-test-ca.crt",
    "",
  ].join("\n");
}

/**
 * The review image with the Claude Code CLI the pinned Agent SDK drives,
 * a layer of its own on the image before it, which the machine reuses.
 */
export function reviewImageWithClaudeCode(dockerfile: string): string {
  return `${dockerfile}RUN npm install --global @anthropic-ai/claude-code@${pinnedClaudeCodeVersion()}\n`;
}
