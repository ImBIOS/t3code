import {
  type ForkHubStateTransferDirection,
  type ForkHubStateTransferFilePreview,
  type ForkHubStateTransferPreview,
  type ForkHubStateTransferResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeSqlite from "node:sqlite";
import * as NodeFs from "node:fs";

import { isForkHubDerivedVersion } from "../updates/updateChannels.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// User-driven state moves between the stock home (`~/.t3/userdata`) and the
// ForkHub home (`~/.t3-forkhub/userdata`), surfaced in Settings > General >
// About on ForkHub builds. Same user-data-only file set as the first-boot
// import: UI prefs plus the saved-environment registry. Backend identity,
// credentials, and server settings never move — two backends must never
// share an identity, and bearer tokens are encrypted per install, so moved
// environments arrive logged-out and reconnect with one deliberate click.
// Update identity (track, publisher, trains) always stays put on the
// destination: a move must never repoint either install's updater.
const TRANSFERABLE_STATE_FILES = [
  "desktop-settings.json",
  "client-settings.json",
  "saved-environments.json",
] as const;

type TransferableStateFile = (typeof TRANSFERABLE_STATE_FILES)[number];

const REGISTRY_FILE: TransferableStateFile = "saved-environments.json";

// desktop-settings.json keys that belong to the updater, not the user. They
// are reported as untouched and forced back after every merge, in both
// directions — importing stock state must not blank the ForkHub publisher,
// exporting must not leak it into the stock install.
const PROTECTED_UPDATE_KEYS = [
  "updateChannel",
  "updateChannelConfiguredByUser",
  "forkhubOwner",
  "forkhubRepo",
  "forkhubHasStableTrain",
  "forkhubHasNightlyTrain",
] as const;

const PREVIEW_LIST_CAP = 10;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

export function mergeSettingsFile(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): { readonly merged: Record<string, unknown>; readonly changedKeys: ReadonlyArray<string> } {
  const merged: Record<string, unknown> = { ...target };
  const changedKeys: Array<string> = [];
  for (const [key, value] of Object.entries(source)) {
    if ((PROTECTED_UPDATE_KEYS as ReadonlyArray<string>).includes(key)) {
      continue;
    }
    if (stableStringify(target[key]) !== stableStringify(value)) {
      merged[key] = value;
      changedKeys.push(key);
    }
  }
  // The destination's updater identity survives even when the source file
  // predates those keys (then there is simply nothing to restore).
  for (const key of PROTECTED_UPDATE_KEYS) {
    if (key in target) {
      merged[key] = target[key];
    } else {
      delete merged[key];
    }
  }
  return { merged, changedKeys };
}

interface RegistryRecord {
  readonly environmentId: string;
  readonly label: string;
  readonly fields: Record<string, unknown>;
}

function toRegistryRecord(value: unknown): RegistryRecord | null {
  if (!isPlainObject(value) || typeof value.environmentId !== "string") {
    return null;
  }
  const { environmentId, label, ...fields } = value;
  return {
    environmentId,
    label: typeof label === "string" ? label : value.environmentId,
    fields,
  };
}

function recordContentEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  // Tokens and timestamps are per-install bookkeeping, never content:
  // encryptedBearerToken cannot cross installs (per-install safeStorage
  // key), lastConnectedAt/createdAt just describe local history.
  const ignored = new Set(["encryptedBearerToken", "lastConnectedAt", "createdAt"]);
  const strip = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !ignored.has(key)));
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

export function mergeRegistryFile(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): {
  readonly merged: Record<string, unknown>;
  readonly added: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
} {
  const sourceRecords = Array.isArray(source.records) ? source.records : [];
  const targetRecords = Array.isArray(target.records) ? target.records : [];
  const byId = new Map<string, RegistryRecord>();
  for (const record of targetRecords) {
    const parsed = toRegistryRecord(record);
    if (parsed) byId.set(parsed.environmentId, parsed);
  }
  const added: Array<string> = [];
  const updated: Array<string> = [];
  for (const record of sourceRecords) {
    const incoming = toRegistryRecord(record);
    if (!incoming) {
      continue;
    }
    const { encryptedBearerToken: _dropped, ...portableFields } = incoming.fields;
    const existing = byId.get(incoming.environmentId);
    if (!existing) {
      byId.set(incoming.environmentId, { ...incoming, fields: portableFields });
      added.push(incoming.label);
      continue;
    }
    if (!recordContentEquals(incoming.fields, existing.fields)) {
      // Incoming content wins, but the destination keeps its own token and
      // timestamps — the moved record reconnects with one click instead of
      // arriving with a dead credential.
      byId.set(incoming.environmentId, {
        ...incoming,
        fields: {
          ...portableFields,
          ...(typeof existing.fields.encryptedBearerToken === "string"
            ? { encryptedBearerToken: existing.fields.encryptedBearerToken }
            : {}),
          ...(existing.fields.lastConnectedAt !== undefined
            ? { lastConnectedAt: existing.fields.lastConnectedAt }
            : {}),
          ...(existing.fields.createdAt !== undefined
            ? { createdAt: existing.fields.createdAt }
            : {}),
        },
      });
      updated.push(incoming.label);
    }
  }
  return {
    merged: {
      ...target,
      ...(source.version !== undefined ? { version: source.version } : {}),
      records: [...byId.values()].map((record) => ({
        environmentId: record.environmentId,
        label: record.label,
        ...record.fields,
      })),
    },
    added,
    updated,
  };
}

function capList(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return values.slice(0, PREVIEW_LIST_CAP);
}

interface MergedFile {
  readonly doc: Record<string, unknown>;
  readonly addedEnvironments: ReadonlyArray<string>;
  readonly updatedEnvironments: ReadonlyArray<string>;
  readonly changedKeys: ReadonlyArray<string>;
}

function mergeTransferFile(
  file: TransferableStateFile,
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): MergedFile {
  if (file === REGISTRY_FILE) {
    const merged = mergeRegistryFile(source, target);
    return {
      doc: merged.merged,
      addedEnvironments: merged.added,
      updatedEnvironments: merged.updated,
      changedKeys: [],
    };
  }
  const merged = mergeSettingsFile(source, target);
  return { doc: merged.merged, addedEnvironments: [], updatedEnvironments: [], changedKeys: merged.changedKeys };
}

function resolveTransferDirs(
  environment: {
    readonly path: { readonly join: (...parts: ReadonlyArray<string>) => string };
    readonly homeDirectory: string;
    readonly stateDir: string;
  },
  direction: ForkHubStateTransferDirection,
): { readonly sourceDir: string; readonly targetDir: string } {
  const join = environment.path.join;
  const stockDir = join(environment.homeDirectory, ".t3", "userdata");
  // This install's live state dir is authoritative for whichever side we
  // currently are; the stock home is canonical on disk.
  if (direction === "import") {
    return { sourceDir: stockDir, targetDir: environment.stateDir };
  }
  return { sourceDir: environment.stateDir, targetDir: stockDir };
}

type SourceFileRead =
  | { readonly status: "missing" }
  | { readonly status: "unreadable" }
  | { readonly status: "ok"; readonly raw: string };

function emptyPreview(file: TransferableStateFile): ForkHubStateTransferFilePreview {
  return {
    file,
    status: "missing-source",
    addedEnvironments: [],
    addedEnvironmentsTotal: 0,
    updatedEnvironments: [],
    updatedEnvironmentsTotal: 0,
    changedKeys: [],
    changedKeysTotal: 0,
    note: null,
  };
}

function previewFile(
  file: TransferableStateFile,
  source: SourceFileRead,
  targetRaw: string | null,
): ForkHubStateTransferFilePreview {
  const empty = emptyPreview(file);
  if (source.status === "missing") {
    return empty;
  }
  if (source.status === "unreadable") {
    return { ...empty, status: "unreadable", note: "Could not parse this file — it will be skipped." };
  }
  const sourceDoc = parseJsonObject(source.raw);
  if (!sourceDoc) {
    return { ...empty, status: "unreadable", note: "Could not parse this file — it will be skipped." };
  }
  if (targetRaw === null) {
    if (file === REGISTRY_FILE) {
      const merged = mergeRegistryFile(sourceDoc, {});
      return {
        ...empty,
        status: "new",
        addedEnvironments: capList(merged.added),
        addedEnvironmentsTotal: merged.added.length,
        note: "Saved environments arrive logged-out and reconnect with one click.",
      };
    }
    const merged = mergeSettingsFile(sourceDoc, {});
    return {
      ...empty,
      status: "new",
      changedKeys: capList(merged.changedKeys),
      changedKeysTotal: merged.changedKeys.length,
    };
  }
  if (!parseJsonObject(targetRaw)) {
    return { ...empty, status: "unreadable", note: "Could not parse the destination file." };
  }
  const targetDoc = parseJsonObject(targetRaw) as Record<string, unknown>;
  if (file === REGISTRY_FILE) {
    const merged = mergeRegistryFile(sourceDoc, targetDoc);
    if (merged.added.length === 0 && merged.updated.length === 0) {
      return { ...empty, status: "identical" };
    }
    return {
      ...empty,
      status: "updated",
      addedEnvironments: capList(merged.added),
      addedEnvironmentsTotal: merged.added.length,
      updatedEnvironments: capList(merged.updated),
      updatedEnvironmentsTotal: merged.updated.length,
      note: "Moved environments arrive logged-out and reconnect with one click.",
    };
  }
  const merged = mergeSettingsFile(sourceDoc, targetDoc);
  if (merged.changedKeys.length === 0) {
    return { ...empty, status: "identical" };
  }
  return {
    ...empty,
    status: "updated",
    changedKeys: capList(merged.changedKeys),
    changedKeysTotal: merged.changedKeys.length,
  };
}

function readSourceFile(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<SourceFileRead, never, never> {
  return fileSystem.readFileString(path).pipe(
    Effect.map((raw): SourceFileRead => ({ status: "ok", raw })),
    Effect.catch((error) =>
      Effect.succeed<SourceFileRead>(
        error.reason._tag === "NotFound" ? { status: "missing" } : { status: "unreadable" },
      ),
    ),
  );
}

function readTargetFile(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<string | null, never, never> {
  return fileSystem.readFileString(path).pipe(Effect.catch(() => Effect.succeed(null as string | null)));
}

function requireTransferAccess(environment: {
  readonly appVersion: string;
  readonly isImplicitHome: boolean;
}): Effect.Effect<void, Error> {
  if (!isForkHubDerivedVersion(environment.appVersion) || !environment.isImplicitHome) {
    return Effect.fail(
      new Error("State transfer is only available on ForkHub installs with a default home."),
    );
  }
  return Effect.void;
}

export const previewForkHubStateTransfer = (direction: ForkHubStateTransferDirection) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* requireTransferAccess(environment);
    const { sourceDir, targetDir } = resolveTransferDirs(environment, direction);
    const join = environment.path.join;
    const otherHomeFound = yield* fileSystem
      .exists(sourceDir)
      .pipe(Effect.catch(() => Effect.succeed(false)));
    const files: Array<ForkHubStateTransferFilePreview> = [];
    for (const file of TRANSFERABLE_STATE_FILES) {
      const source = yield* readSourceFile(fileSystem, join(sourceDir, file));
      const targetRaw = yield* readTargetFile(fileSystem, join(targetDir, file));
      files.push(previewFile(file, source, targetRaw));
    }
    const db = previewDbTransfer(join(sourceDir, "state.sqlite"), join(targetDir, "state.sqlite"));
    return {
      direction,
      otherHomeFound,
      files,
      projectsToMove: db.projectTitles,
      projectsToMoveTotal: db.projects,
      threadsToMoveTotal: db.threads,
      messagesToMoveTotal: db.messages,
      eventsToMoveTotal: db.events,
      dbNote: db.note,
    };
  });

function backupName(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${file}.bak-${stamp}`;
}

export const applyForkHubStateTransfer = (direction: ForkHubStateTransferDirection) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* requireTransferAccess(environment);
    const join = environment.path.join;
    const { sourceDir, targetDir } = resolveTransferDirs(environment, direction);
    const otherHomeFound = yield* fileSystem
      .exists(sourceDir)
      .pipe(Effect.catch(() => Effect.succeed(false)));
    if (!otherHomeFound) {
      return yield* Effect.fail(new Error("The other install's home was not found."));
    }
    const backups: Array<string> = [];
    const errors: Array<string> = [];
    let addedEnvironmentsTotal = 0;
    let updatedEnvironmentsTotal = 0;
    let changedKeysTotal = 0;
    let written = 0;
    for (const file of TRANSFERABLE_STATE_FILES) {
      const source = yield* readSourceFile(fileSystem, join(sourceDir, file));
      if (source.status === "missing") {
        continue;
      }
      if (source.status === "unreadable") {
        errors.push(`${file}: could not parse the source file, skipped.`);
        continue;
      }
      const sourceDoc = parseJsonObject(source.raw);
      if (!sourceDoc) {
        errors.push(`${file}: could not parse the source file, skipped.`);
        continue;
      }
      const targetRaw = yield* readTargetFile(fileSystem, join(targetDir, file));
      const targetDoc = targetRaw === null ? {} : parseJsonObject(targetRaw);
      if (targetDoc === null) {
        errors.push(`${file}: could not parse the destination file, skipped.`);
        continue;
      }
      const merged = mergeTransferFile(file, sourceDoc, targetDoc);
      const hasChanges =
        merged.addedEnvironments.length + merged.updatedEnvironments.length > 0 ||
        merged.changedKeys.length > 0 ||
        targetRaw === null;
      if (!hasChanges) {
        continue;
      }
      addedEnvironmentsTotal += merged.addedEnvironments.length;
      updatedEnvironmentsTotal += merged.updatedEnvironments.length;
      changedKeysTotal += merged.changedKeys.length;
      // Back up the destination before the first write to it.
      if (targetRaw !== null) {
        const backup = backupName(file);
        const backedUp = yield* fileSystem.writeFileString(join(targetDir, backup), targetRaw).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (backedUp) {
          backups.push(backup);
        }
      }
      const wrote = yield* fileSystem
        .makeDirectory(targetDir, { recursive: true })
        .pipe(
          Effect.andThen(
            fileSystem.writeFileString(join(targetDir, file), `${JSON.stringify(merged.doc, null, 2)}\n`),
          ),
          Effect.as(true),
          Effect.catch((cause) => {
            errors.push(`${file}: could not write (${String(cause)}).`);
            return Effect.succeed(false);
          }),
        );
      if (wrote) {
        written += 1;
      }
    }
    const which = direction === "import" ? "Import" : "Export";
    const restartWhere =
      direction === "import" ? "this ForkHub install" : "stock T3 Code";
    // Conversations travel inside state.sqlite (events + projections +
    // attachment files); identity tables are never on the allowlist.
    const dbResult = yield* Effect.sync(() =>
      applyDbTransfer({
        sourceDbPath: join(sourceDir, "state.sqlite"),
        destDbPath: join(targetDir, "state.sqlite"),
        backupDbPath: join(targetDir, `state.sqlite.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`),
        sourceAttachmentsDir: join(sourceDir, "attachments"),
        destAttachmentsDir: join(targetDir, "attachments"),
        copyFile: (from, to) => {
          NodeFs.copyFileSync(from, to);
        },
        makeDirectory: (dir) => {
          NodeFs.mkdirSync(dir, { recursive: true });
        },
      }),
    ).pipe(
      Effect.catch((cause) => {
        errors.push(`Conversations: move failed (${String(cause)}).`);
        return Effect.succeed({
          projects: 0,
          threads: 0,
          messages: 0,
          files: 0,
          backup: null as string | null,
          errors: [] as Array<string>,
        });
      }),
    );
    for (const dbError of dbResult.errors) {
      errors.push(dbError);
    }
    const dbBackup = dbResult.backup;
    const movedSummary: Array<string> = [];
    if (written > 0) {
      movedSummary.push(`${written} file${written === 1 ? "" : "s"}`);
    }
    if (dbResult.threads > 0 || dbResult.projects > 0) {
      movedSummary.push(
        `${dbResult.threads} thread${dbResult.threads === 1 ? "" : "s"} in ${dbResult.projects} project${dbResult.projects === 1 ? "" : "s"} (+${dbResult.messages} messages)`,
      );
    }
    const message =
      errors.length > 0
        ? `${which} finished with ${errors.length} problem${errors.length === 1 ? "" : "s"}: ${errors.join(" ")}`
        : movedSummary.length === 0
          ? "Everything is already in sync — nothing to move."
          : `${which} moved ${movedSummary.join(" and ")}. Quit and reopen ${restartWhere} to apply.`;
    return {
      direction,
      applied: movedSummary.length > 0,
      backups,
      addedEnvironmentsTotal,
      updatedEnvironmentsTotal,
      changedKeysTotal,
      projectsMovedTotal: dbResult.projects,
      threadsMovedTotal: dbResult.threads,
      messagesMovedTotal: dbResult.messages,
      dbBackup,
      errors,
      message,
    };
  });

// ---- Conversations: projects + threads travel inside state.sqlite ----
//
// Threads and projects are event-sourced: the durable truth is
// orchestration_events (two aggregate kinds, project and thread), with the
// projection_* tables as derived read models. A move copies both — the
// events so a moved thread keeps its full history and stays continuable,
// the projections so it renders immediately. Copied events land past the
// destination projector's cursor, so a running backend picks them up live;
// the required restart covers every in-memory cache regardless.
//
// Identity never moves: auth, pairing, receipts, runtime, migrations, and
// the projector cursor are not on the allowlist below. Streams already
// present on the destination are skipped wholesale (same id = already
// moved), which also makes reruns no-ops. Bearer-adjacent content needs no
// scrubbing here: provider credentials live outside the database.

interface DbStreamKey {
  readonly kind: "project" | "thread";
  readonly id: string;
}

const DB_EVENT_TABLE = "orchestration_events";

const DB_PROJECTION_MOVES: ReadonlyArray<{
  readonly table: string;
  readonly link: "project_id" | "thread_id";
  /** Tables without any unique index take a plain insert (reruns skip the whole stream anyway). */
  readonly ignoreConflicts: boolean;
}> = [
  { table: "projection_projects", link: "project_id", ignoreConflicts: true },
  { table: "projection_threads", link: "thread_id", ignoreConflicts: true },
  { table: "projection_thread_messages", link: "thread_id", ignoreConflicts: true },
  { table: "projection_thread_activities", link: "thread_id", ignoreConflicts: true },
  { table: "projection_thread_proposed_plans", link: "thread_id", ignoreConflicts: true },
  { table: "projection_thread_pull_requests", link: "thread_id", ignoreConflicts: true },
  { table: "projection_thread_sessions", link: "thread_id", ignoreConflicts: true },
  { table: "projection_pending_approvals", link: "thread_id", ignoreConflicts: true },
  { table: "projection_turns", link: "thread_id", ignoreConflicts: true },
  { table: "checkpoint_diff_blobs", link: "thread_id", ignoreConflicts: false },
];

const DB_CHUNK_SIZE = 400;

function quoteIdent(name: string): string {
  return `[${name.replace(/\]/g, "]]")}]`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function chunked<T>(values: ReadonlyArray<T>, size: number): Array<Array<T>> {
  const chunks: Array<Array<T>> = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function tableColumns(db: NodeSqlite.DatabaseSync, table: string): Array<string> | null {
  try {
    const rows = db
      .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
      .all() as unknown as ReadonlyArray<{ name: unknown }>;
    const names = rows.map((row) => (typeof row.name === "string" ? row.name : ""));
    return names.length > 0 ? names : null;
  } catch {
    return null;
  }
}

function tableExists(db: NodeSqlite.DatabaseSync, table: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as unknown as { ok: unknown } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

function distinctStreams(
  db: NodeSqlite.DatabaseSync,
): { readonly projects: Set<string>; readonly threads: Set<string> } | null {
  try {
    const projects = new Set<string>();
    const threads = new Set<string>();
    if (tableExists(db, DB_EVENT_TABLE)) {
      const rows = db
        .prepare(
          `SELECT DISTINCT aggregate_kind AS kind, stream_id AS id FROM ${quoteIdent(DB_EVENT_TABLE)} WHERE aggregate_kind IN ('project', 'thread')`,
        )
        .all() as unknown as ReadonlyArray<{ kind: unknown; id: unknown }>;
      for (const row of rows) {
        if (typeof row.id !== "string") continue;
        if (row.kind === "project") projects.add(row.id);
        else if (row.kind === "thread") threads.add(row.id);
      }
    }
    // Belt and braces: projections may hold streams whose events compacted away.
    if (tableExists(db, "projection_projects")) {
      const cols = tableColumns(db, "projection_projects") ?? [];
      if (cols.includes("project_id")) {
        for (const row of db
          .prepare("SELECT project_id AS id FROM projection_projects")
          .all() as unknown as ReadonlyArray<{ id: unknown }>) {
          if (typeof row.id === "string") projects.add(row.id);
        }
      }
    }
    if (tableExists(db, "projection_threads")) {
      const cols = tableColumns(db, "projection_threads") ?? [];
      if (cols.includes("thread_id")) {
        for (const row of db
          .prepare("SELECT thread_id AS id FROM projection_threads")
          .all() as unknown as ReadonlyArray<{ id: unknown }>) {
          if (typeof row.id === "string") threads.add(row.id);
        }
      }
    }
    return { projects, threads };
  } catch {
    return null;
  }
}

interface DbMovePlan {
  readonly projects: ReadonlyArray<string>;
  readonly threads: ReadonlyArray<string>;
}

function planDbMove(
  source: { readonly projects: Set<string>; readonly threads: Set<string> },
  dest: { readonly projects: Set<string>; readonly threads: Set<string> },
): DbMovePlan {
  return {
    projects: [...source.projects].filter((id) => !dest.projects.has(id)),
    threads: [...source.threads].filter((id) => !dest.threads.has(id)),
  };
}

export interface DbPreview {
  readonly available: boolean;
  readonly projects: number;
  readonly threads: number;
  readonly messages: number;
  readonly events: number;
  readonly projectTitles: ReadonlyArray<string>;
  readonly note: string | null;
}

function migrationSkewNote(
  source: NodeSqlite.DatabaseSync,
  dest: NodeSqlite.DatabaseSync,
): string | null {
  try {
    if (!tableExists(source, "effect_sql_migrations") || !tableExists(dest, "effect_sql_migrations")) {
      return null;
    }
    const ids = (db: NodeSqlite.DatabaseSync): Set<string> => {
      const cols = tableColumns(db, "effect_sql_migrations") ?? [];
      const idCol = cols.find((col) => col === "migration_id" || col === "name" || col === "id");
      if (!idCol) return new Set();
      return new Set(
        (db.prepare(`SELECT ${quoteIdent(idCol)} AS id FROM effect_sql_migrations`).all() as unknown as ReadonlyArray<{ id: unknown }>)
          .map((row) => row.id)
          .filter((id): id is string => typeof id === "string"),
      );
    };
    const unknown = [...ids(source)].filter((id) => !ids(dest).has(id));
    return unknown.length > 0
      ? "The other install's database is newer; some moved items may need that install to update first."
      : null;
  } catch {
    return null;
  }
}

export function previewDbTransfer(sourceDbPath: string, destDbPath: string): DbPreview {
  const empty: DbPreview = {
    available: false,
    projects: 0,
    threads: 0,
    messages: 0,
    events: 0,
    projectTitles: [],
    note: null,
  };
  let source: NodeSqlite.DatabaseSync | null = null;
  let dest: NodeSqlite.DatabaseSync | null = null;
  try {
    try {
      source = new NodeSqlite.DatabaseSync(sourceDbPath, { readOnly: true });
    } catch {
      return { ...empty, note: "No conversations database on the other install." };
    }
    try {
      dest = new NodeSqlite.DatabaseSync(destDbPath, { readOnly: true });
    } catch {
      return { ...empty, note: "Conversations move once this install has been opened at least once." };
    }
    const sourceStreams = distinctStreams(source);
    const destStreams = distinctStreams(dest);
    if (!sourceStreams || !destStreams) {
      return { ...empty, available: true, note: "Could not read the conversations database." };
    }
    const plan = planDbMove(sourceStreams, destStreams);
    if (plan.projects.length === 0 && plan.threads.length === 0) {
      return { ...empty, available: true };
    }
    let messages = 0;
    let events = 0;
    try {
      if (tableExists(source, "projection_thread_messages") && plan.threads.length > 0) {
        for (const chunk of chunked(plan.threads, DB_CHUNK_SIZE)) {
          const row = source
            .prepare(
              `SELECT COUNT(*) AS n FROM projection_thread_messages WHERE thread_id IN (${chunk.map(quoteLiteral).join(",")})`,
            )
            .get() as unknown as { n: unknown } | undefined;
          messages += typeof row?.n === "number" ? row.n : 0;
        }
      }
      if (tableExists(source, DB_EVENT_TABLE)) {
        const clauses: Array<string> = [];
        for (const chunk of chunked(plan.projects, DB_CHUNK_SIZE)) {
          if (chunk.length > 0) {
            clauses.push(`(aggregate_kind = 'project' AND stream_id IN (${chunk.map(quoteLiteral).join(",")}))`);
          }
        }
        for (const chunk of chunked(plan.threads, DB_CHUNK_SIZE)) {
          if (chunk.length > 0) {
            clauses.push(`(aggregate_kind = 'thread' AND stream_id IN (${chunk.map(quoteLiteral).join(",")}))`);
          }
        }
        if (clauses.length > 0) {
          const row = source
            .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(DB_EVENT_TABLE)} WHERE ${clauses.join(" OR ")}`)
            .get() as unknown as { n: unknown } | undefined;
          events = typeof row?.n === "number" ? row.n : 0;
        }
      }
    } catch {
      // Counts are informational; the move itself re-derives them.
    }
    let projectTitles: ReadonlyArray<string> = [];
    try {
      if (tableExists(source, "projection_projects") && plan.projects.length > 0) {
        const cols = tableColumns(source, "projection_projects") ?? [];
        const titleCol = cols.includes("title") ? "title" : null;
        if (titleCol) {
          const titles: Array<string> = [];
          for (const chunk of chunked(plan.projects, DB_CHUNK_SIZE)) {
            for (const row of source
              .prepare(
                `SELECT ${quoteIdent(titleCol)} AS title FROM projection_projects WHERE project_id IN (${chunk.map(quoteLiteral).join(",")})`,
              )
              .all() as unknown as ReadonlyArray<{ title: unknown }>) {
              if (typeof row.title === "string" && row.title.length > 0) {
                titles.push(row.title);
              }
            }
            if (titles.length >= PREVIEW_LIST_CAP) break;
          }
          projectTitles = titles.slice(0, PREVIEW_LIST_CAP);
        }
      }
    } catch {
      projectTitles = [];
    }
    return {
      available: true,
      projects: plan.projects.length,
      threads: plan.threads.length,
      messages,
      events,
      projectTitles,
      note: migrationSkewNote(source, dest),
    };
  } finally {
    try {
      source?.close();
    } catch {
      // ignore
    }
    try {
      dest?.close();
    } catch {
      // ignore
    }
  }
}

export interface DbApplyResult {
  readonly projects: number;
  readonly threads: number;
  readonly messages: number;
  readonly files: number;
  readonly backup: string | null;
  readonly errors: Array<string>;
}

function copyTableChunk(
  dest: NodeSqlite.DatabaseSync,
  table: string,
  columns: ReadonlyArray<string>,
  link: "project_id" | "thread_id",
  ids: ReadonlyArray<string>,
  orIgnore: boolean,
): void {
  const selectCols = columns.map(quoteIdent).join(", ");
  for (const chunk of chunked(ids, DB_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    dest.exec(
      `INSERT ${orIgnore ? "OR IGNORE " : ""}INTO ${quoteIdent(table)} (${selectCols}) SELECT ${selectCols} FROM src.${quoteIdent(table)} WHERE ${quoteIdent(link)} IN (${chunk.map(quoteLiteral).join(",")})`,
    );
  }
}

function collectAttachmentIds(source: NodeSqlite.DatabaseSync, threadIds: ReadonlyArray<string>): Set<string> {
  const ids = new Set<string>();
  try {
    if (!tableExists(source, "projection_thread_messages")) return ids;
    const cols = tableColumns(source, "projection_thread_messages") ?? [];
    if (!cols.includes("attachments_json") || !cols.includes("thread_id")) return ids;
    for (const chunk of chunked(threadIds, DB_CHUNK_SIZE)) {
      if (chunk.length === 0) continue;
      const rows = source
        .prepare(
          `SELECT attachments_json AS attachments FROM projection_thread_messages WHERE thread_id IN (${chunk.map(quoteLiteral).join(",")}) AND attachments_json IS NOT NULL`,
        )
        .all() as unknown as ReadonlyArray<{ attachments: unknown }>;
      for (const row of rows) {
        if (typeof row.attachments !== "string") continue;
        try {
          const parsed: unknown = JSON.parse(row.attachments);
          const list = Array.isArray(parsed) ? parsed : [];
          for (const attachment of list) {
            if (typeof attachment === "object" && attachment !== null && "id" in attachment) {
              const id = (attachment as { id: unknown }).id;
              if (typeof id === "string" && id.length > 0 && !id.includes("..")) {
                ids.add(id);
              }
            }
          }
        } catch {
          // A corrupt attachments cell skips just itself.
        }
      }
    }
  } catch {
    // Attachments are best-effort cargo.
  }
  return ids;
}

export function applyDbTransfer(input: {
  readonly sourceDbPath: string;
  readonly destDbPath: string;
  readonly backupDbPath: string;
  readonly sourceAttachmentsDir: string;
  readonly destAttachmentsDir: string;
  readonly copyFile: (from: string, to: string) => void;
  readonly makeDirectory: (dir: string) => void;
}): DbApplyResult {
  const errors: Array<string> = [];
  const empty: DbApplyResult = {
    projects: 0,
    threads: 0,
    messages: 0,
    files: 0,
    backup: null,
    errors,
  };
  let source: NodeSqlite.DatabaseSync | null = null;
  let dest: NodeSqlite.DatabaseSync | null = null;
  try {
    try {
      source = new NodeSqlite.DatabaseSync(input.sourceDbPath, { readOnly: true });
    } catch {
      // No database on the other install (the preview already says so):
      // skip quietly, this is not a failure.
      return { ...empty };
    }
    try {
      dest = new NodeSqlite.DatabaseSync(input.destDbPath);
    } catch {
      errors.push("Conversations: the destination database is unavailable, skipped.");
      return { ...empty };
    }
    dest.exec("PRAGMA busy_timeout = 30000");
    const sourceStreams = distinctStreams(source);
    const destStreams = distinctStreams(dest);
    if (!sourceStreams || !destStreams) {
      errors.push("Conversations: could not read a conversations database, skipped.");
      return { ...empty };
    }
    const plan = planDbMove(sourceStreams, destStreams);
    if (plan.projects.length === 0 && plan.threads.length === 0) {
      return { ...empty };
    }
    // Message count for the report, taken before the move.
    let messages = 0;
    try {
      if (tableExists(source, "projection_thread_messages") && plan.threads.length > 0) {
        for (const chunk of chunked(plan.threads, DB_CHUNK_SIZE)) {
          const row = source
            .prepare(
              `SELECT COUNT(*) AS n FROM projection_thread_messages WHERE thread_id IN (${chunk.map(quoteLiteral).join(",")})`,
            )
            .get() as unknown as { n: unknown } | undefined;
          messages += typeof row?.n === "number" ? row.n : 0;
        }
      }
    } catch {
      messages = 0;
    }
    // Consistent snapshot of the destination before any write.
    try {
      dest.exec(`VACUUM INTO ${quoteLiteral(input.backupDbPath)}`);
    } catch {
      errors.push("Conversations: could not back up the destination database, skipped.");
      return { ...empty };
    }
    const backup = input.backupDbPath;
    // Attachment files first: the database transaction below must never
    // reference files that failed to land.
    let files = 0;
    try {
      const attachmentIds = collectAttachmentIds(source, plan.threads);
      // Thread-segment sweep: file names start with "<threadId>-", so files
      // the message cells never mention still travel with their thread.
      if (attachmentIds.size > 0 || plan.threads.length > 0) {
        input.makeDirectory(input.destAttachmentsDir);
      }
      for (const id of attachmentIds) {
        try {
          input.copyFile(
            `${input.sourceAttachmentsDir}/${id}`,
            `${input.destAttachmentsDir}/${id}`,
          );
          files += 1;
        } catch {
          // A missing source file skips just itself.
        }
      }
    } catch {
      // Attachments are best-effort cargo.
    }
    dest.exec(`ATTACH ${quoteLiteral(input.sourceDbPath)} AS src`);
    try {
      dest.exec("BEGIN IMMEDIATE");
      try {
        if (tableExists(source, DB_EVENT_TABLE) && tableExists(dest, DB_EVENT_TABLE)) {
          const destCols = new Set(tableColumns(dest, DB_EVENT_TABLE) ?? []);
          const srcCols = tableColumns(source, DB_EVENT_TABLE) ?? [];
          const columns = srcCols.filter((col) => col !== "sequence" && destCols.has(col));
          if (columns.length > 0) {
            const selectCols = columns.map(quoteIdent).join(", ");
            const clauses: Array<string> = [];
            for (const chunk of chunked(plan.projects, DB_CHUNK_SIZE)) {
              if (chunk.length > 0) {
                clauses.push(
                  `(src.aggregate_kind = 'project' AND src.stream_id IN (${chunk.map(quoteLiteral).join(",")}))`,
                );
              }
            }
            for (const chunk of chunked(plan.threads, DB_CHUNK_SIZE)) {
              if (chunk.length > 0) {
                clauses.push(
                  `(src.aggregate_kind = 'thread' AND src.stream_id IN (${chunk.map(quoteLiteral).join(",")}))`,
                );
              }
            }
            // One statement per clause keeps each query small.
            for (const clause of clauses) {
              dest.exec(
                `INSERT OR IGNORE INTO ${quoteIdent(DB_EVENT_TABLE)} (${selectCols}) SELECT ${selectCols} FROM src.${quoteIdent(DB_EVENT_TABLE)} AS src WHERE ${clause}`,
              );
            }
          }
        }
        for (const spec of DB_PROJECTION_MOVES) {
          if (!tableExists(source, spec.table) || !tableExists(dest, spec.table)) {
            continue;
          }
          const destCols = new Set(tableColumns(dest, spec.table) ?? []);
          const srcCols = tableColumns(source, spec.table) ?? [];
          if (!srcCols.includes(spec.link) || !destCols.has(spec.link)) {
            continue;
          }
          const columns = srcCols.filter((col) => destCols.has(col));
          if (columns.length === 0) {
            continue;
          }
          const ids = spec.link === "project_id" ? plan.projects : plan.threads;
          if (ids.length === 0) {
            continue;
          }
          copyTableChunk(dest, spec.table, columns, spec.link, ids, spec.ignoreConflicts);
        }
        dest.exec("COMMIT");
      } catch (cause) {
        try {
          dest.exec("ROLLBACK");
        } catch {
          // ignore
        }
        throw cause;
      }
    } finally {
      try {
        dest.exec("DETACH src");
      } catch {
        // ignore
      }
    }
    return { projects: plan.projects.length, threads: plan.threads.length, messages, files, backup, errors };
  } finally {
    try {
      source?.close();
    } catch {
      // ignore
    }
    try {
      dest?.close();
    } catch {
      // ignore
    }
  }
}
