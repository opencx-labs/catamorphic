/** A local-only workflow for editor tests. None of its steps perform IO. */
export const WORKFLOW_EDITOR_SOURCE = `import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

/**
 * @displayname Weekly report
 * @description Gather the week's notes, write a clear summary, and prepare it for your team.
 */
export const linkedWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      retry: { maxAttempts: 3 },
      run: async ({ input }: BoundaryContext<{ topic: string; includeDetails: boolean }>) => {
        const notes = await collectNotes({ topic: input.topic });
        const report = await writeReport({ notes, includeDetails: input.includeDetails });
        return { report };
      },
    }),
  ],
}));

/**
 * @displayname Gather notes
 * @description Collect the notes to include in this week's report.
 * @param topic - @displayname Topic | @description The subject of your report
 */
async function collectNotes({ topic }: { topic: string }) {
  "use step";
  return "Notes about " + topic;
}

/**
 * @displayname Write summary
 * @description Turn the collected notes into a summary your team can read.
 * @param notes - @displayname Notes | @description Information collected in the previous step
 * @param includeDetails - @displayname Include details | @description Include the supporting notes
 */
async function writeReport({ notes, includeDetails }: { notes: string; includeDetails: boolean }) {
  "use step";
  return includeDetails ? notes : "Weekly summary";
}
`;

export const WORKFLOW_EDITOR_EXPANDED_SOURCE =
  WORKFLOW_EDITOR_SOURCE.replace(
    "        const report = await writeReport",
    "        await checkNotes({ notes });\n        const report = await writeReport",
  ) +
  `
/**
 * @displayname Check notes
 * @description Confirm there is something to summarize before writing the report.
 * @param notes - @displayname Notes | @description Notes to check
 */
async function checkNotes({ notes }: { notes: string }) {
  "use step";
  return notes.length > 0;
}
`;
