import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { stripTerminalEscapes } from "@t3tools/shared/stripTerminalEscapes";

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return stripTerminalEscapes(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      next[key] = sanitizeValue(val);
    }
    return next;
  }
  return value;
}

function needsSanitizeJson(raw: string | null): raw is string {
  if (typeof raw !== "string" || raw.length === 0) return false;
  // Fast check for literal \u001b (6 chars) or raw ESC
  return (
    raw.includes("\\u001b") ||
    raw.includes("\u001b") ||
    raw.includes("\\u0007") ||
    raw.includes("\u0007")
  );
}

function sanitizeJsonString(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    const sanitized = sanitizeValue(parsed);
    // Only return new string if changed
    const nextRaw = JSON.stringify(sanitized);
    return nextRaw !== raw ? nextRaw : null;
  } catch {
    // Not JSON, treat as plain text
    const sanitized = stripTerminalEscapes(raw);
    // Also handle literal \u001b in raw JSON text that wasn't parsed (fallback)
    let next = sanitized;
    if (next.includes("\\u001b")) {
      next = next.replace(/\\u001b/g, "").replace(/\\u0007/g, "");
      next = next.replace(/\u001b\].*?(?:\u0007|\u001b\\)/g, "");
    }
    return next !== raw ? next : null;
  }
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // --- provider_session_runtime.runtime_payload_json ---
  const runtimeRows = yield* sql<{ thread_id: string; runtime_payload_json: string | null }>`
    SELECT thread_id, runtime_payload_json FROM provider_session_runtime
    WHERE runtime_payload_json IS NOT NULL
      AND (instr(runtime_payload_json, 'u001b') > 0 OR instr(runtime_payload_json, char(27)) > 0)
  `;
  for (const row of runtimeRows) {
    const raw = row.runtime_payload_json;
    if (!needsSanitizeJson(raw)) continue;
    const next = sanitizeJsonString(raw);
    if (next !== null) {
      yield* sql`UPDATE provider_session_runtime SET runtime_payload_json = ${next} WHERE thread_id = ${row.thread_id}`;
    }
  }

  // --- projection_threads.model_selection_json ---
  const threadRows = yield* sql<{ thread_id: string; model_selection_json: string | null }>`
    SELECT thread_id, model_selection_json FROM projection_threads
    WHERE model_selection_json IS NOT NULL
      AND (instr(model_selection_json, 'u001b') > 0 OR instr(model_selection_json, char(27)) > 0)
  `;
  for (const row of threadRows) {
    const raw = row.model_selection_json;
    if (!needsSanitizeJson(raw)) continue;
    const next = sanitizeJsonString(raw);
    if (next !== null) {
      yield* sql`UPDATE projection_threads SET model_selection_json = ${next} WHERE thread_id = ${row.thread_id}`;
    }
  }

  // --- projection_projects.default_model_selection_json ---
  const projectRows = yield* sql<{
    project_id: string;
    default_model_selection_json: string | null;
  }>`
    SELECT project_id, default_model_selection_json FROM projection_projects
    WHERE default_model_selection_json IS NOT NULL
      AND (instr(default_model_selection_json, 'u001b') > 0 OR instr(default_model_selection_json, char(27)) > 0)
  `;
  for (const row of projectRows) {
    const raw = row.default_model_selection_json;
    if (!needsSanitizeJson(raw)) continue;
    const next = sanitizeJsonString(raw);
    if (next !== null) {
      yield* sql`UPDATE projection_projects SET default_model_selection_json = ${next} WHERE project_id = ${row.project_id}`;
    }
  }

  // --- orchestration_events.payload_json (event-sourced, but clean for read model) ---
  const eventRows = yield* sql<{ sequence: number; payload_json: string }>`
    SELECT sequence, payload_json FROM orchestration_events
    WHERE instr(payload_json, 'u001b') > 0 OR instr(payload_json, char(27)) > 0
  `;
  for (const row of eventRows) {
    const raw = row.payload_json;
    if (!needsSanitizeJson(raw)) continue;
    const next = sanitizeJsonString(raw);
    if (next !== null) {
      yield* sql`UPDATE orchestration_events SET payload_json = ${next} WHERE sequence = ${row.sequence}`;
    }
  }

  // --- projection_thread_activities.payload_json ---
  const activityRows = yield* sql<{ activity_id: string; payload_json: string }>`
    SELECT activity_id, payload_json FROM projection_thread_activities
    WHERE instr(payload_json, 'u001b') > 0 OR instr(payload_json, char(27)) > 0
  `;
  for (const row of activityRows) {
    const raw = row.payload_json;
    if (!needsSanitizeJson(raw)) continue;
    const next = sanitizeJsonString(raw);
    if (next !== null) {
      yield* sql`UPDATE projection_thread_activities SET payload_json = ${next} WHERE activity_id = ${row.activity_id}`;
    }
  }

  // --- projection_thread_messages.text (plain text, not JSON) ---
  const messageRows = yield* sql<{ message_id: string; text: string }>`
    SELECT message_id, text FROM projection_thread_messages
    WHERE instr(text, 'u001b') > 0 OR instr(text, char(27)) > 0
  `;
  for (const row of messageRows) {
    const raw = row.text;
    let next = stripTerminalEscapes(raw);
    if (next.includes("\\u001b")) {
      next = next.replace(/\\u001b/g, "").replace(/\\u0007/g, "");
    }
    if (next !== raw) {
      yield* sql`UPDATE projection_thread_messages SET text = ${next} WHERE message_id = ${row.message_id}`;
    }
  }
});
