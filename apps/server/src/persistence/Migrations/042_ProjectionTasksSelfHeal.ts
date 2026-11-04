import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_tasks
    ADD COLUMN last_run_status TEXT
  `;

  yield* sql`
    ALTER TABLE projection_tasks
    ADD COLUMN last_run_at TEXT
  `;

  yield* sql`
    ALTER TABLE projection_tasks
    ADD COLUMN last_run_error TEXT
  `;

  yield* sql`
    ALTER TABLE projection_tasks
    ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0
  `;
});
