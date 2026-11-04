import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface TaskHealerShape {
  /**
   * Start the background self-heal loop within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Run one pass immediately: verify recently-fired tasks and re-run the
   * failures with a healing prompt. Returns the number of heal turns
   * dispatched. Exposed as a deterministic seam for tests — never wait on
   * the wall-clock loop.
   */
  readonly tick: () => Effect.Effect<number, never>;
}

export class TaskHealer extends Context.Service<TaskHealer, TaskHealerShape>()(
  "t3/orchestration/Services/TaskHealer",
) {}
