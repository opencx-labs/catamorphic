import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RUNNER_PROTOCOL_VERSION } from "../packages/agent-protocol/src/runner.js";
import type { EvalFixture } from "./customization-eval/fixture.js";
import type { Grade } from "./customization-eval/grade.js";
import type { createEvalAgent as CreateEvalAgent } from "./customization-eval/harness.js";
import { parseOptions } from "./customization-eval/options.js";
import {
  SCENARIOS,
  scenarioById,
  seedScenario,
} from "./customization-eval/scenarios.js";
import {
  installSdk,
  sourceFiles,
  stageSourceWorker,
} from "./customization-eval/sdk.js";
import { removeTestDirectory, settleTestProcesses } from "./test-processes.js";

export async function main(args: readonly string[]): Promise<number> {
  const repository = path.resolve(import.meta.dirname, "..");
  const options = parseOptions({ args, cwd: process.cwd() });
  if (options.list) {
    console.log(
      SCENARIOS.map(
        (scenario) => `${scenario.id}: ${scenario.description}`,
      ).join("\n"),
    );
    return 0;
  }
  if (!options.live)
    throw new Error(
      "Real model evaluations require --live. Deterministic tests never contact providers.",
    );
  const scenario = scenarioById(options.scenario);
  const [
    { WORKSPACE_AUTHORING_GUIDE },
    { createEvalAgent },
    { gradeTodo },
    { runAttempt },
    { EVAL_CUSTOMIZATION_TOOLS, evalCustomizationTool },
  ] = await Promise.all([
    import("../apps/desktop/src/main/workspace-authoring.js"),
    import("./customization-eval/harness.js"),
    import("./customization-eval/grade.js"),
    import("./customization-eval/attempt.js"),
    import("./customization-eval/tools.js"),
  ]);
  await mkdir(options.output, { recursive: true });
  const outcomes: Array<{ run: number; passed: boolean; directory: string }> =
    [];
  for (let run = 1; run <= options.runs; run += 1) {
    const retained = path.join(
      options.output,
      `${options.harness}-${scenario.id}-${run}`,
    );
    await mkdir(retained, { recursive: false });
    // Outside the repository: a real user project cannot inherit our AGENTS.md,
    // harness settings, hidden evaluator implementation or development files.
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), "work-customization-eval-")),
    );
    const report: Record<string, unknown> = {
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      harness: options.harness,
      scenario: scenario.id,
      requestedModel: options.model ?? null,
      requestedEffort: options.effort ?? null,
      timeoutMs: options.timeoutMs,
      scope:
        "Headless source runtime with real OS confinement; this does not grade Electron pixels or native gestures.",
      passed: false,
    };
    let agent: Awaited<ReturnType<typeof CreateEvalAgent>> | undefined;
    let fixture: EvalFixture | undefined;
    try {
      agent = await createEvalAgent({ options, directory });
      report.project = path.join(
        retained,
        path.relative(directory, agent.project),
      );
      report.sdk = await installSdk({
        repository,
        project: agent.project,
        directory,
      });
      const worker = await stageSourceWorker({ repository, directory });
      report.worker = {
        file: path.relative(directory, worker.file),
        sha256: worker.sha256,
      };
      await seedScenario({ project: agent.project, scenario: scenario.id });
      {
        const { createPrivateCustomizationEvalHost } = await import(
          "../apps/desktop/evals/private-customization-host.js"
        );
        fixture = await createPrivateCustomizationEvalHost({
          project: agent.project,
          directory,
          adapter: agent.adapter,
          scenario:
            scenario.id === "todo-sidebar"
              ? "todo-sidebar"
              : "private-reminder",
        });
        await fixture.seed();
      }
      await writeFile(
        path.join(agent.project, "CUSTOMIZATION.md"),
        scenario.id === "todo-sidebar"
          ? `${WORKSPACE_AUTHORING_GUIDE}\n${await readFile(path.join(repository, "apps/desktop/docs/customization-reference.md"), "utf8")}\n`
          : "PRIVATE-WORKFLOWS.md describes this host's private state, workflow, and notification capabilities.\n",
      );
      const prompt = `${scenario.prompt}\n\nThis is an isolated local project with the installed SDK, native file/shell tools, and the host capabilities offered to this turn. ${scenario.id === "todo-sidebar" ? "AGENTS.md contains the result-address convention." : ""}`;
      await writeFile(path.join(directory, "prompt.md"), `${prompt}\n`);
      console.log(
        `[eval] ${run}/${options.runs} ${options.harness} ${scenario.id}: ${retained}`,
      );
      const evidence = await runAttempt({
        adapter: agent.adapter,
        local: agent.local,
        timeoutMs: options.timeoutMs,
        tool: (call) =>
          fixture?.tools.some((tool) => tool.name === call.name)
            ? fixture.invoke(call)
            : evalCustomizationTool({
                ...call,
                repository,
                project: agent?.project ?? "",
                directory,
                sourceWork: fixture?.sourceWork,
              }),
        frame: (frame) =>
          appendFileSync(
            path.join(directory, "transcript.jsonl"),
            `${JSON.stringify(frame)}\n`,
          ),
        attempt: {
          protocol: RUNNER_PROTOCOL_VERSION,
          sessionId: fixture?.context?.sessionId ?? randomUUID(),
          projectId: fixture?.context?.projectId ?? randomUUID(),
          turnId: randomUUID(),
          attemptId: randomUUID(),
          reason: "initial",
          harness: agent.adapter.id,
          workingDirectory:
            agent.local?.sandbox?.workingDirectory ?? agent.project,
          stateDirectory: path.join(directory, "profile", "state"),
          thread: { mode: "fresh", providerThreadId: randomUUID() },
          input: { itemId: randomUUID(), text: prompt, attachments: [] },
          systemPrompt:
            "You are Work's assistant working in an isolated user project. Use native file and shell tools, the project's facts and installed types. Complete the person's request. No commits or publishing are requested.",
          context:
            "The person requested a local sidebar customization. The current project is disposable and has no existing user settings.",
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          permissions: {
            // The outer Seatbelt profile is the boundary. macOS cannot nest
            // Codex's own sandbox-exec inside that enforced boundary.
            sandbox: "danger-full-access",
            approvals: "never",
            permissionMode: "acceptEdits",
          },
          modelAccess: agent.modelAccess,
          toolPolicies: {},
          toolAnnotations: {},
          mcpServers: {},
          hostTools: [...EVAL_CUSTOMIZATION_TOOLS, ...(fixture?.tools ?? [])],
          plugins: [],
          env: agent.env,
          options: agent.adapterOptions,
        },
      });
      const { events, ...summary } = evidence;
      report.agent = summary;
      report.usage = events
        .filter((event) => event.type === "usage")
        .map((event) => event.usage);
      const grades: Grade[] = [
        {
          id: "agent-completed",
          passed: evidence.status === "completed",
          detail: evidence.status,
        },
      ];
      try {
        grades.push(
          ...(scenario.id === "private-reminder" && fixture
            ? await fixture.grade()
            : await gradeTodo({
                repository,
                project: agent.project,
                directory,
                sourceWork: fixture?.sourceWork,
              })),
        );
      } catch (error) {
        grades.push({
          id: "runtime-grading",
          passed: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (scenario.id === "todo-sidebar" && fixture)
        grades.push(...(await fixture.grade()));
      report.grades = grades;
      report.files = (await sourceFiles(agent.project)).map((file) =>
        path.relative(agent?.project ?? "", file),
      );
      report.passed = grades.every((grade) => grade.passed);
      console.log(
        `[eval] ${grades.filter((grade) => grade.passed).length}/${grades.length} checks passed`,
      );
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      console.error(`[eval] ${report.error}`);
    } finally {
      const cleanup = await Promise.allSettled([
        fixture?.close(),
        agent?.close(),
      ]);
      for (const result of cleanup) {
        if (result.status !== "rejected") continue;
        report.cleanupError =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        report.passed = false;
      }
      try {
        await settleTestProcesses({
          temporaryRoot: directory,
          signal: "SIGTERM",
        });
      } catch (error) {
        report.cleanupError =
          error instanceof Error ? error.message : String(error);
        report.passed = false;
      }
      report.finishedAt = new Date().toISOString();
      await writeFile(
        path.join(directory, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      await cp(directory, retained, {
        recursive: true,
        filter: (file) => path.basename(file) !== "node_modules",
      });
      await removeTestDirectory(directory);
    }
    outcomes.push({ run, passed: report.passed === true, directory: retained });
  }
  await writeFile(
    path.join(options.output, "summary.json"),
    `${JSON.stringify({ harness: options.harness, scenario: scenario.id, outcomes }, null, 2)}\n`,
  );
  return outcomes.every((outcome) => outcome.passed) ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
