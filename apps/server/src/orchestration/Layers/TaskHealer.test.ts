import {
  CommandId,
  ProjectId,
  TaskId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationTask,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { TaskHealer } from "../Services/TaskHealer.ts";
import { makeTaskHealerLive } from "./TaskHealer.ts";

const NOW = "2026-01-01T01:00:00.000Z";
const FIRED = "2026-01-01T00:00:00.000Z";

function makeTask(overrides?: Partial<OrchestrationTask>): OrchestrationTask {
  return {
    taskId: TaskId.make("task-1"),
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    prompt: "Run the nightly checks",
    schedule: { kind: "interval", everyMs: 60 * 60 * 1000 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastFiredAt: FIRED,
    nextFireAt: "2026-01-01T01:00:00.000Z",
    cancelledAt: null,
    ...overrides,
  };
}

function makeThread(input: {
  readonly turnState?: "running" | "completed" | "error" | "interrupted" | null;
  readonly sessionStatus?: "running" | "ready" | "error" | null;
}): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: "codex" as never, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn:
      input.turnState === null || input.turnState === undefined
        ? null
        : {
            turnId: "turn-1" as never,
            state: input.turnState,
            requestedAt: FIRED,
            startedAt: FIRED,
            completedAt: input.turnState === "running" ? null : NOW,
            assistantMessageId: null,
          },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session:
      input.sessionStatus === null || input.sessionStatus === undefined
        ? null
        : {
            threadId: ThreadId.make("thread-1"),
            status: input.sessionStatus,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: input.sessionStatus === "error" ? "provider blew up" : null,
            updatedAt: NOW,
          },
  };
}

function makeReadModel(task: OrchestrationTask, thread: OrchestrationReadModel["threads"][number]) {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [thread],
    tasks: [task],
    updatedAt: NOW,
  } satisfies OrchestrationReadModel;
}

const state = {
  readModel: makeReadModel(makeTask(), makeThread({ turnState: "completed" })),
  dispatched: [] as Array<{ type: string; commandId: CommandId }>,
};

const healerLayer = makeTaskHealerLive({
  tickIntervalMs: 60_000,
  // Zero grace: the test's fixed clock (NOW) is way past FIRED.
  gracePeriodMs: 0,
  maxConsecutiveFailures: 3,
}).pipe(
  Layer.provideMerge(
    Layer.succeed(ProjectionSnapshotQuery, {
      getSnapshot: () => Effect.succeed(state.readModel),
    } as unknown as ProjectionSnapshotQueryShape),
  ),
  Layer.provideMerge(
    Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: { type: string; commandId: CommandId }) =>
        Effect.sync(() => {
          state.dispatched.push(command);
          return { sequence: 1 };
        }),
    } as unknown as OrchestrationEngineShape),
  ),
);

it.layer(healerLayer.pipe(Layer.provideMerge(NodeServices.layer)))("task healer", (it) => {
  it.effect("notes ok and dispatches nothing when the run succeeded", () =>
    Effect.gen(function* () {
      state.dispatched = [];
      state.readModel = makeReadModel(makeTask(), makeThread({ turnState: "completed" }));

      const healer = yield* TaskHealer;
      const healedCount = yield* healer.tick();

      expect(healedCount).toBe(0);
      // The ok verdict is still recorded so the next tick skips this fire.
      expect(state.dispatched.map((command) => command.type)).toEqual(["task.note-run"]);
    }),
  );

  it.effect("notes failure and dispatches a healing turn", () =>
    Effect.gen(function* () {
      state.dispatched = [];
      state.readModel = makeReadModel(makeTask(), makeThread({ turnState: "error" }));

      const healer = yield* TaskHealer;
      const healedCount = yield* healer.tick();

      expect(healedCount).toBe(1);
      expect(state.dispatched.map((command) => command.type)).toEqual([
        "task.note-run",
        "thread.turn.start",
      ]);
    }),
  );

  it.effect("parks at the failure cap: notes but does not heal", () =>
    Effect.gen(function* () {
      state.dispatched = [];
      state.readModel = makeReadModel(
        makeTask({ consecutiveFailures: 3 }),
        makeThread({ turnState: "error" }),
      );

      const healer = yield* TaskHealer;
      const healedCount = yield* healer.tick();

      expect(healedCount).toBe(0);
      expect(state.dispatched.map((command) => command.type)).toEqual(["task.note-run"]);
    }),
  );

  it.effect("skips runs already judged and runs with no settled turn", () =>
    Effect.gen(function* () {
      state.dispatched = [];
      // lastRunAt matches lastFiredAt: already judged.
      state.readModel = makeReadModel(
        makeTask({ lastRunAt: FIRED }),
        makeThread({ turnState: "error" }),
      );

      const healer = yield* TaskHealer;
      expect(yield* healer.tick()).toBe(0);
      expect(state.dispatched).toHaveLength(0);

      // No latest turn at all: nothing to judge yet.
      state.readModel = makeReadModel(makeTask(), makeThread({ turnState: null }));
      expect(yield* healer.tick()).toBe(0);
      expect(state.dispatched).toHaveLength(0);
    }),
  );
});
