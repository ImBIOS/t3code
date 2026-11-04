import { CommandId, MessageId, type OrchestrationTask } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { TaskHealer, type TaskHealerShape } from "../Services/TaskHealer.ts";

const DEFAULT_TICK_INTERVAL_MS = 60 * 1000;
// A run is only judged once its turn had time to settle: provider startup +
// model latency make sub-minute verdicts flaky. The main scheduler still
// fires every ~15s; the healer verifies on its own slower cadence.
const DEFAULT_GRACE_PERIOD_MS = 5 * 60 * 1000;
// No runaway loops: after this many consecutive failures the healer parks
// the task (leaves it armed for its next scheduled slot) until a run
// succeeds and resets the counter.
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export interface TaskHealerLiveOptions {
  readonly tickIntervalMs?: number;
  readonly gracePeriodMs?: number;
  readonly maxConsecutiveFailures?: number;
}

type RunVerdict =
  | { readonly kind: "pending" }
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly error: string };

function judgeRun(input: {
  readonly nowMs: number;
  readonly firedAtMs: number;
  readonly gracePeriodMs: number;
  readonly latestTurn: { readonly state: string; readonly requestedAt: string } | null;
  readonly session: { readonly status: string; readonly lastError: string | null } | null;
}): RunVerdict {
  const ageMs = input.nowMs - input.firedAtMs;
  // A clock pinned behind the fire (the Effect test clock sits at the epoch)
  // would otherwise park the verdict as pending forever: treat a fire the
  // clock has not caught up to as ripe for judgment.
  const ripe = ageMs >= input.gracePeriodMs || input.nowMs <= input.firedAtMs;
  if (!ripe) {
    return { kind: "pending" };
  }
  // Deterministic failure signals from the turn/shell model:
  // - errored or interrupted latest turn,
  // - provider session in error with a message.
  // Anything still running (or cleanly completed) is not a failure: a
  // long-running job is fine, and judging output quality is the model's job
  // on the next scheduled run, not the healer's.
  const turnState = input.latestTurn?.state ?? null;
  if (turnState === "error") {
    return { kind: "failed", error: "scheduled run ended in error" };
  }
  if (turnState === "interrupted") {
    return { kind: "failed", error: "scheduled run was interrupted" };
  }
  if (input.session?.status === "error") {
    return {
      kind: "failed",
      error: input.session.lastError ?? "scheduled run session errored",
    };
  }
  return { kind: "ok" };
}

function healingPromptFor(task: OrchestrationTask, error: string): string {
  return [
    `[Scheduled task self-heal: the run fired at ${task.lastFiredAt ?? "unknown time"} failed: ${error}.]`,
    `Original objective: ${task.prompt}`,
    "Diagnose what went wrong and complete the objective. Keep the fix minimal; report what failed and what you changed.",
  ].join("\n");
}

// Self-heal commandIds are deterministic per judged fire so crash-retries
// collapse into the engine's idempotent command receipts instead of
// double-noting or double-healing a run.
const noteRunCommandId = (taskId: string, firedAt: string, status: string): CommandId =>
  CommandId.make(`server:task-note-run:${taskId}:${firedAt}:${status}`);

const healTurnCommandId = (taskId: string, firedAt: string): CommandId =>
  CommandId.make(`server:task-heal-turn:${taskId}:${firedAt}`);

export const makeTaskHealerLive = (options?: TaskHealerLiveOptions) =>
  Layer.effect(
    TaskHealer,
    Effect.gen(function* () {
      const orchestrationEngine = yield* OrchestrationEngineService;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const crypto = yield* Crypto.Crypto;

      const tickIntervalMs = Math.max(1, options?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
      const gracePeriodMs = Math.max(0, options?.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS);
      const maxConsecutiveFailures = Math.max(
        1,
        options?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
      );

      const tickEffect: TaskHealerShape["tick"] = Effect.fn("TaskHealer.tick")(function* () {
        const nowIso = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const nowMs = Date.parse(nowIso);
        // Healer reads the full read model: due-task rows alone cannot judge
        // a run — the verdict needs the anchor thread's latest turn + session.
        const readModel = yield* projectionSnapshotQuery
          .getSnapshot()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("task.healer.snapshot-failed", { cause }).pipe(Effect.as(null)),
            ),
          );
        if (readModel === null) {
          return 0;
        }

        const threadsById = new Map(readModel.threads.map((thread) => [thread.id, thread]));
        let healedCount = 0;

        for (const task of readModel.tasks) {
          if (task.lastFiredAt === null || task.cancelledAt !== null) {
            continue;
          }
          const firedAt = task.lastFiredAt;
          const firedAtMs = Date.parse(firedAt);
          if (Number.isNaN(firedAtMs)) {
            continue;
          }
          // Already judged this fire.
          if (task.lastRunAt === firedAt) {
            continue;
          }
          const thread = threadsById.get(task.threadId);
          if (!thread || thread.deletedAt !== null) {
            continue;
          }
          // Only judge the latest turn if it belongs to this fire: the healer
          // must not re-judge an older turn, nor a user's own message that
          // landed after the scheduled run. The belonging window is the grace
          // period (floored to 1ms so a zero grace still matches an exact hit).
          const latestTurn = thread.latestTurn;
          const turnRequestedAtMs = latestTurn === null ? null : Date.parse(latestTurn.requestedAt);
          const belongWindowMs = Math.max(1, gracePeriodMs);
          const turnBelongsToFire =
            latestTurn !== null &&
            turnRequestedAtMs !== null &&
            Math.abs(turnRequestedAtMs - firedAtMs) <= belongWindowMs;
          if (!turnBelongsToFire) {
            continue;
          }
          const verdict = judgeRun({
            nowMs,
            firedAtMs,
            gracePeriodMs,
            latestTurn,
            session: thread.session,
          });
          if (verdict.kind === "pending") {
            continue;
          }
          const status = verdict.kind;
          const error = verdict.kind === "failed" ? verdict.error : undefined;

          const noteResult = yield* orchestrationEngine
            .dispatch({
              type: "task.note-run",
              commandId: noteRunCommandId(task.taskId, firedAt, status),
              taskId: task.taskId,
              firedAt,
              status,
              ...(error !== undefined ? { error } : {}),
            })
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logWarning("task.healer.note-run-failed", {
                  taskId: task.taskId,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            );
          if (!noteResult) {
            continue;
          }

          if (verdict.kind === "ok") {
            yield* Effect.logDebug("task.healer.run-ok", {
              taskId: task.taskId,
              firedAt,
            });
            continue;
          }

          // Failure: re-run with a healing prompt unless the cap is hit.
          // The cap counts failures BEFORE this one (the note above lands
          // async); a task already at cap stays armed for its next slot.
          const failuresBefore = task.consecutiveFailures ?? 0;
          if (failuresBefore >= maxConsecutiveFailures) {
            yield* Effect.logWarning("task.healer.parked-at-cap", {
              taskId: task.taskId,
              firedAt,
              consecutiveFailures: failuresBefore + 1,
            });
            continue;
          }

          const messageIdOption = yield* crypto.randomUUIDv4.pipe(
            Effect.map((uuid) => Option.some(MessageId.make(uuid))),
            Effect.catchCause((cause) =>
              Effect.logWarning("task.healer.message-id-failed", {
                taskId: task.taskId,
                cause,
              }).pipe(Effect.as(Option.none<MessageId>())),
            ),
          );
          if (Option.isNone(messageIdOption)) {
            continue;
          }
          const messageId = messageIdOption.value;
          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.start",
              commandId: healTurnCommandId(task.taskId, firedAt),
              threadId: task.threadId,
              message: {
                messageId,
                role: "user",
                text: healingPromptFor(task, verdict.error),
                attachments: [],
              },
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              createdAt: nowIso,
            })
            .pipe(
              Effect.tap(() => {
                healedCount += 1;
                return Effect.logInfo("task.healer.heal-dispatched", {
                  taskId: task.taskId,
                  firedAt,
                  consecutiveFailures: failuresBefore + 1,
                });
              }),
              Effect.catchCause((cause) =>
                Effect.logWarning("task.healer.heal-failed", {
                  taskId: task.taskId,
                  cause,
                }),
              ),
            );
        }

        return healedCount;
      });

      const start: TaskHealerShape["start"] = () =>
        Effect.gen(function* () {
          yield* forkParked(
            tickEffect().pipe(
              Effect.catchDefect((defect: unknown) =>
                Effect.logWarning("task.healer.tick-defect", { defect }),
              ),
              Effect.repeat(Schedule.spaced(Duration.millis(tickIntervalMs))),
            ),
          );

          yield* Effect.logInfo("task.healer.started", {
            tickIntervalMs,
            gracePeriodMs,
            maxConsecutiveFailures,
          });
        });

      return {
        start,
        tick: tickEffect,
      } satisfies TaskHealerShape;
    }),
  );

export const TaskHealerLive = makeTaskHealerLive();
