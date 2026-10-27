/** Deployment-owned application code. Copy with review-report.ts and the SQL. */
import { createHash } from "node:crypto";
import type {
  CapabilityProviderRuntime,
  Catamorphic,
} from "@catamorphic/server-sdk";
import type { Pool, QueryResultRow } from "pg";
import {
  diffLines,
  list,
  parseWorkReview,
  publicationText,
  record,
  renderedPath,
} from "./review-report.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Input = { sessionId: string; turnId: string };
type Plan = {
  id: string;
  action: string;
  input: { [key: string]: Json };
  stamp: string;
  turnId: string;
  runId: string;
};
type Effect = Plan & {
  commit_sha: string;
  input_digest: string;
  state: string;
};

/** A small structural subset of the public SDK, also usable with test doubles. */
export interface ReviewCore {
  runs: {
    get(
      input: Parameters<Catamorphic["core"]["runs"]["get"]>[0],
    ): Promise<unknown>;
  };
  agentSessions?: {
    get(
      ...input: Parameters<
        NonNullable<Catamorphic["core"]["agentSessions"]>["get"]
      >
    ): Promise<unknown>;
  };
  connectionBroker?: Pick<
    NonNullable<Catamorphic["core"]["connectionBroker"]>,
    "invoke"
  >;
}

/**
 * Both pools reach the SAME database. Separate pools reserve connections for
 * durable intent/receipt commits while publishers hold or wait on row locks.
 * A single shared pool can deadlock even with max > 1.
 */
export function reviewPublicationCapability({
  core,
  lockPool,
  ledgerPool,
  repository,
}: {
  core(): ReviewCore;
  lockPool: Pool;
  ledgerPool: Pool;
  repository: string;
}): CapabilityProviderRuntime {
  if (lockPool === ledgerPool)
    throw new Error("Use separate lock and ledger pools");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Invalid repository");
  return {
    name: "company.review-publication",
    calls: {
      async publish(context, raw) {
        const deadline = Date.parse(context.deadlineAt);
        if (!Number.isFinite(deadline))
          throw new Error("Invalid publication deadline");
        const signal = AbortSignal.any([
          context.signal,
          AbortSignal.timeout(Math.max(0, deadline - Date.now())),
        ]);
        const assertLive = () => {
          signal.throwIfAborted();
          if (deadline <= Date.now())
            throw new DOMException(
              "Publication deadline exceeded",
              "TimeoutError",
            );
        };
        const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
          assertLive();
          return new Promise<T>((resolve, reject) => {
            const abort = () => {
              signal.removeEventListener("abort", abort);
              reject(signal.reason);
            };
            signal.addEventListener("abort", abort, { once: true });
            void Promise.resolve()
              .then(() => {
                assertLive();
                return operation();
              })
              .then((value) => {
                assertLive();
                resolve(value);
              })
              .catch(reject)
              .finally(() => signal.removeEventListener("abort", abort));
          });
        };
        const acquire = async (pool: Pool) => {
          assertLive();
          const pending = pool.connect();
          try {
            return await wait(() => pending);
          } catch (error) {
            // A pool cannot cancel a queued acquisition. Release a client that
            // arrives after our budget expired instead of leaking it.
            void pending.then(
              (client) => client.release(true),
              () => {},
            );
            throw error;
          }
        };
        const ledgerQuery = async <Row extends QueryResultRow = QueryResultRow>(
          text: string,
          values: unknown[] = [],
        ) => {
          const client = await acquire(ledgerPool);
          let released = false;
          const destroy = () => {
            if (!released) {
              released = true;
              client.release(true);
            }
          };
          client.on("error", destroy);
          signal.addEventListener("abort", destroy, { once: true });
          try {
            return await wait(() => client.query<Row>(text, values));
          } finally {
            signal.removeEventListener("abort", destroy);
            client.off("error", destroy);
            if (!released) client.release(signal.aborted);
          }
        };
        const receive = async ({
          id,
          receipt,
        }: {
          id: string;
          receipt: unknown;
        }) => {
          await ledgerQuery(
            "UPDATE work_review_publication.effects SET state='received',receipt=$2::jsonb WHERE id=$1",
            [id, JSON.stringify(receipt)],
          );
        };
        const input = parseInput(raw);
        const sdk = core();
        const loadRun = async () => {
          const run = record(
            await wait(() =>
              sdk.runs.get({
                identity: context.caller,
                runId: context.runId,
              }),
            ),
          );
          const event = record(run.input);
          const payload = record(event.payload);
          if (
            context.workflowName !== "postReviews" ||
            run.workflowName !== "postReviews" ||
            run.projectId !== context.projectId ||
            run.environment !== "github-poster" ||
            run.status !== "running" ||
            typeof run.allocationId !== "string" ||
            event.kind !== "session.turn-changed" ||
            payload.sessionId !== input.sessionId ||
            record(payload.detail).turnId !== input.turnId
          )
            throw new Error(
              "This live poster run does not authorize that review turn",
            );
          return run.allocationId;
        };
        const call = async (action: string, args: { [key: string]: Json }) => {
          const allocationId = await loadRun();
          if (!sdk.connectionBroker)
            throw new Error("Connection broker unavailable");
          const broker = sdk.connectionBroker;
          return wait(() =>
            broker.invoke({
              signal,
              deadlineAt: context.deadlineAt,
              identity: context.caller,
              allocationId,
              alias: "github",
              action,
              input: args,
              caller: "workflow",
            }),
          );
        };
        const loadChat = async () => {
          await loadRun();
          if (!sdk.agentSessions)
            throw new Error("Session service unavailable");
          const sessions = sdk.agentSessions;
          const chat = record(
            await wait(() =>
              sessions.get(context.caller, context.projectId, input.sessionId),
            ),
          );
          const prefix = `pr-${repository}-`;
          const key = typeof chat.key === "string" ? chat.key : "";
          const number =
            key.startsWith(prefix) &&
            /^[1-9]\d*$/.test(key.slice(prefix.length))
              ? Number(key.slice(prefix.length))
              : 0;
          if (
            !Number.isSafeInteger(number) ||
            number < 1 ||
            chat.projectId !== context.projectId ||
            chat.owner !== "project" ||
            chat.agentId !== `project:${context.projectId}:reviewer` ||
            record(chat.placement).environment !== "review" ||
            !list(chat.keyWorkflows).includes("reviewPullRequests")
          )
            throw new Error("Not this project's review chat");
          return { chat, number };
        };
        const initial = await loadChat();
        const scope = JSON.stringify([
          context.caller.tenantId,
          context.projectId,
          repository,
          initial.number,
        ]);
        const lock = await acquire(lockPool);
        let released = false;
        const destroyLock = () => {
          if (!released) {
            released = true;
            lock.release(true);
          }
        };
        signal.addEventListener("abort", destroyLock, { once: true });
        let transaction = false;
        let lockError: Error | undefined;
        const failedLock = (error: Error) => {
          lockError = error;
        };
        lock.on("error", failedLock);
        try {
          await ledgerQuery(
            "INSERT INTO work_review_publication.pulls(scope) VALUES ($1) ON CONFLICT DO NOTHING",
            [scope],
          );
          await wait(() => lock.query("BEGIN"));
          transaction = true;
          const remaining = `${Math.max(1, deadline - Date.now())}ms`;
          await wait(() =>
            lock.query(
              "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true),set_config('idle_in_transaction_session_timeout',$1,true)",
              [remaining],
            ),
          );
          await wait(() =>
            lock.query(
              "SELECT scope FROM work_review_publication.pulls WHERE scope=$1 FOR UPDATE",
              [scope],
            ),
          );
          const liveLock = () => {
            if (lockError) throw lockError;
            return wait(() => lock.query("SELECT 1"));
          };
          // Every uncertain write, including an older head/turn, must resolve
          // before ANY new write. Missing from a list does not prove it failed.
          const uncertain = await ledgerQuery<Effect>(
            "SELECT * FROM work_review_publication.effects WHERE scope=$1 AND state='uncertain' ORDER BY id",
            [scope],
          );
          for (const effect of uncertain.rows) {
            const receipt = await findReceipt({
              effect,
              call,
              repository,
              number: initial.number,
            });
            if (!receipt)
              throw new Error(
                `Publication blocked: uncertain effect ${effect.id}; reconcile with the operator`,
              );
            await receive({ id: effect.id, receipt });
          }
          const current = await loadChat();
          if (current.number !== initial.number)
            throw new Error("Review destination changed");
          const snapshot = record(current.chat.snapshot);
          const turns = list(snapshot.turns)
            .map(record)
            .sort((a, b) => Number(b.ordinal) - Number(a.ordinal));
          const turn = turns[0];
          const attempt = latestAttempt(snapshot, input.turnId);
          const commit = record(current.chat.workspace).commit;
          if (
            !turn ||
            turn.id !== input.turnId ||
            !["completed", "failed"].includes(String(turn.status)) ||
            typeof commit !== "string" ||
            !/^[0-9a-f]{40}$/.test(commit)
          )
            return { skipped: "stale turn" };
          const fresh = async () => {
            await liveLock();
            const chat = (await loadChat()).chat;
            const latest = list(record(chat.snapshot).turns)
              .map(record)
              .sort((a, b) => Number(b.ordinal) - Number(a.ordinal))[0];
            if (
              latest?.id !== input.turnId ||
              latest.status !== turn.status ||
              latestAttempt(record(chat.snapshot), input.turnId)?.id !==
                attempt?.id ||
              record(chat.workspace).commit !== commit
            )
              throw new Error("Review generation changed before publication");
            const pull = record(
              await call("get", {
                path: `/repos/${repository}/pulls/${initial.number}`,
              }),
            );
            if (pull.status !== 200)
              throw new Error("Could not read current pull request");
            const body = record(pull.body);
            if (body.state !== "open" || record(body.head).sha !== commit)
              throw new Error("Pull request head changed before publication");
          };
          await fresh();
          // Read actual persisted assistant output from that turn, never caller
          // supplied report/status/resultMessageId. No final output means no pass.
          const items = list(snapshot.items)
            .map(record)
            .filter(
              (item) =>
                attempt?.status === "completed" &&
                (!turn.activeAttemptId ||
                  turn.activeAttemptId === attempt.id) &&
                item.attemptId === attempt.id &&
                item.parentItemId === null &&
                item.agentId === current.chat.agentId &&
                item.kind === "assistant_message" &&
                item.turnId === input.turnId &&
                item.status === "completed",
            );
          const reply = items
            .sort((a, b) => Number(a.position) - Number(b.position))
            .at(-1);
          const parsed =
            turn.status === "failed"
              ? "The review turn failed."
              : parseWorkReview(
                  typeof reply?.text === "string" ? reply.text : "",
                );
          const review = typeof parsed === "string" ? null : parsed;
          if (review && review.reviewedCommit !== commit)
            return { skipped: "stale report" };
          const generation = JSON.stringify([
            scope,
            input.sessionId,
            input.turnId,
            turn.ordinal,
            attempt?.id ?? null,
            commit,
          ]);
          const plan = (
            action: string,
            args: { [key: string]: Json },
          ): Plan => {
            const id = hash(`${generation}:${action}`);
            const stamp = `<!-- work-review effect=${id} -->`;
            return {
              id,
              action,
              stamp,
              turnId: input.turnId,
              runId: context.runId,
              input: {
                repository,
                ...args,
                stamp,
                ...(typeof args.body === "string"
                  ? { body: `${publicationText(args.body)}\n\n${stamp}` }
                  : {}),
              },
            };
          };
          const dispatch = async (effect: Plan) => {
            const digest = hash(JSON.stringify(effect.input));
            const earlier = await ledgerQuery<Effect>(
              "SELECT * FROM work_review_publication.effects WHERE id=$1",
              [effect.id],
            );
            if (earlier.rows[0]) {
              if (earlier.rows[0].input_digest !== digest)
                throw new Error("Effect identity reused with different input");
              if (earlier.rows[0].state !== "received")
                throw new Error("Uncertain effect must be reconciled");
              return;
            }
            await fresh();
            await ledgerQuery(
              "INSERT INTO work_review_publication.effects(id,scope,commit_sha,turn_id,run_id,action,input,input_digest,stamp,state) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'uncertain')",
              [
                effect.id,
                scope,
                commit,
                effect.turnId,
                effect.runId,
                effect.action,
                JSON.stringify(effect.input),
                digest,
                effect.stamp,
              ],
            );
            // If ownership is lost after intent commit, leave it uncertain.
            // A rollback or an abort cannot recall an accepted GitHub request.
            await liveLock();
            const receipt = await call(effect.action, effect.input);
            if (!validReceipt(receipt))
              throw new Error("GitHub create returned no destination id");
            await receive({ id: effect.id, receipt });
          };
          const checks = list(
            record(
              await call("check_runs", {
                repository,
                commit,
                name: "Work review",
              }),
            ).runs,
          )
            .map(record)
            .filter((run) => run.own === true);
          const imported = Math.max(
            0,
            ...checks.map((run) => strength(run.conclusion)),
          );
          const proposed = review
            ? review.verdict === "REQUEST_CHANGES"
              ? 3
              : 2
            : 1;
          const stored = await ledgerQuery<{
            strength: number;
            check_plan: Plan | null;
          }>(
            "SELECT strength,check_plan FROM work_review_publication.verdicts WHERE scope=$1 AND commit_sha=$2",
            [scope, commit],
          );
          const old = stored.rows[0];
          const strongest = Math.max(old?.strength ?? 0, imported, proposed);
          const conclusion =
            strongest === 3
              ? "failure"
              : strongest === 2
                ? "success"
                : "action_required";
          const check =
            proposed > Math.max(old?.strength ?? 0, imported)
              ? plan("create_check_run", {
                  name: "Work review",
                  headSha: commit,
                  status: "completed",
                  conclusion,
                  output: {
                    title: review
                      ? `${review.verdict === "REQUEST_CHANGES" ? "Changes requested" : "Nothing blocks"} (score ${review.score}/5)`
                      : "No review",
                    summary: review?.checkSummary ?? String(parsed),
                  },
                })
              : imported >= strongest
                ? null
                : (old?.check_plan ?? null);
          // Preserve the strongest check plan across a crash before dispatch.
          await ledgerQuery(
            "INSERT INTO work_review_publication.verdicts(scope,commit_sha,strength,check_plan) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(scope,commit_sha) DO UPDATE SET strength=EXCLUDED.strength,check_plan=EXCLUDED.check_plan",
            [scope, commit, strongest, JSON.stringify(check)],
          );
          if (check) await dispatch(check);
          if (!review) return { published: true, conclusion };
          const lines = diffLines(
            await call("pull_request_files", {
              repository,
              number: initial.number,
            }),
          );
          const fits = (comment: (typeof review.comments)[number]) =>
            lines.has(`${comment.path}:${comment.side}:${comment.line}`);
          const outside = review.comments
            .filter((comment) => !fits(comment))
            .map(
              (comment) =>
                `- ${renderedPath(comment.path)}:${comment.line}: ${comment.body}`,
            );
          const own = list(
            record(
              await call("list_reviews", {
                repository,
                number: initial.number,
              }),
            ).reviews,
          )
            .map(record)
            .filter((entry) => entry.own === true);
          const stands = own.some(
            (entry) =>
              entry.commitId === commit &&
              (entry.state === "CHANGES_REQUESTED" ||
                (review.verdict === "COMMENT" && entry.state === "COMMENTED")),
          );
          // A passing answer cannot emit a weaker review after a failure.
          if (
            !(strongest === 3 && review.verdict === "COMMENT") &&
            (!stands || review.comments.length > 0)
          )
            await dispatch(
              plan("create_review", {
                number: initial.number,
                event: review.verdict,
                commitId: commit,
                body: [
                  review.summary,
                  `Score: ${review.score}/5`,
                  ...(outside.length
                    ? [`On lines outside the diff:\n${outside.join("\n")}`]
                    : []),
                ]
                  .join("\n\n")
                  .slice(0, 60000),
                comments: review.comments.filter(fits),
              }),
            );
          if (review.reply) {
            const threads = list(
              record(
                await call("review_threads", {
                  repository,
                  number: initial.number,
                }),
              ).threads,
            ).map(record);
            const asked = threads
              .flatMap((thread) => list(thread.comments).map(record))
              .find((comment) => comment.id === review.reply?.inReplyTo);
            await dispatch(
              asked && typeof asked.id === "number"
                ? plan("reply_to_review_comment", {
                    number: initial.number,
                    commentId: asked.id,
                    body: review.reply.body,
                  })
                : plan("issue_comment", {
                    number: initial.number,
                    body: review.reply.body,
                  }),
            );
          }
          return { published: true, conclusion };
        } finally {
          if (transaction && !released) {
            try {
              await wait(() => lock.query("ROLLBACK"));
            } catch {
              destroyLock();
            }
          }
          signal.removeEventListener("abort", destroyLock);
          lock.off("error", failedLock);
          if (!released) {
            released = true;
            lock.release(lockError || signal.aborted);
          }
        }
      },
    },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function strength(value: unknown): number {
  return value === "failure"
    ? 3
    : value === "success"
      ? 2
      : value === "action_required"
        ? 1
        : 0;
}
function parseInput(value: unknown): Input {
  const input = record(value);
  if (
    Object.keys(input).length !== 2 ||
    typeof input.sessionId !== "string" ||
    !input.sessionId ||
    typeof input.turnId !== "string" ||
    !input.turnId
  )
    throw new Error("Expected only sessionId and turnId");
  return { sessionId: input.sessionId, turnId: input.turnId };
}
function validReceipt(value: unknown): boolean {
  const id = record(value).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}
async function findReceipt({
  effect,
  call,
  repository,
  number,
}: {
  effect: Effect;
  call(action: string, input: { [key: string]: Json }): Promise<unknown>;
  repository: string;
  number: number;
}): Promise<unknown | null> {
  const result =
    effect.action === "create_check_run"
      ? list(
          record(
            await call("check_runs", {
              repository,
              commit: effect.commit_sha,
              name: "Work review",
            }),
          ).runs,
        )
      : effect.action === "create_review"
        ? list(
            record(await call("list_reviews", { repository, number })).reviews,
          )
        : effect.action === "issue_comment"
          ? list(
              record(await call("issue_comments", { repository, number }))
                .comments,
            )
          : list(
              record(await call("review_threads", { repository, number }))
                .threads,
            ).flatMap((thread) => list(record(thread).comments));
  const receipt = result
    .map(record)
    .find(
      (entry) =>
        entry.own === true &&
        (effect.action === "create_check_run"
          ? entry.externalId === effect.stamp
          : typeof entry.body === "string" &&
            entry.body.includes(effect.stamp)),
    );
  return validReceipt(receipt) ? receipt : null;
}

function latestAttempt(snapshot: Record<string, unknown>, turnId: string) {
  return list(snapshot.attempts)
    .map(record)
    .filter((attempt) => attempt.turnId === turnId)
    .sort((left, right) => Number(right.ordinal) - Number(left.ordinal))[0];
}
