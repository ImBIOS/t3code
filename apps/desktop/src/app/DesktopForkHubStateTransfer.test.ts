import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePathNative from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  applyDbTransfer,
  applyForkHubStateTransfer,
  mergeRegistryFile,
  mergeSettingsFile,
  parseJsonObject,
  previewDbTransfer,
  previewForkHubStateTransfer,
} from "./DesktopForkHubStateTransfer.ts";

const FORKHUB_VERSION = "0.0.45-nightly.20260930.2468.fh.with-fh.1";

const environmentLayer = (
  baseDir: string,
  appVersion: string,
  env: Record<string, string | undefined>,
) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "linux",
    processArch: "x64",
    appVersion,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const withTempHome = <A, E>(
  effect: Effect.Effect<A, E, DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem>,
  options: {
    readonly appVersion?: string;
    readonly env?: Record<string, string | undefined> | ((baseDir: string) => Record<string, string | undefined>);
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-forkhub-transfer-test-",
    });
    const env = typeof options.env === "function" ? options.env(baseDir) : (options.env ?? {});
    return yield* effect.pipe(
      Effect.provide(environmentLayer(baseDir, options.appVersion ?? FORKHUB_VERSION, env)),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopForkHubStateTransfer", () => {
  it("parses JSON objects leniently", () => {
    assert.deepEqual(parseJsonObject(`{"a":1}`), { a: 1 });
    assert.isNull(parseJsonObject(`[1,2]`));
    assert.isNull(parseJsonObject(`not json`));
    assert.isNull(parseJsonObject(`"str"`));
  });

  it("merges settings with the source winning except update identity", () => {
    const { merged, changedKeys } = mergeSettingsFile(
      { theme: "dark", forkhubOwner: null, updateChannel: "latest", extra: 1 },
      { theme: "light", forkhubOwner: "with-fh", updateChannel: "nightly", keep: true },
    );
    assert.deepEqual(merged, {
      theme: "dark",
      forkhubOwner: "with-fh",
      updateChannel: "nightly",
      keep: true,
      extra: 1,
    });
    assert.deepEqual(changedKeys, ["theme", "extra"]);
  });

  it("drops update identity the source introduces", () => {
    const { merged } = mergeSettingsFile({ forkhubOwner: "evil" }, { theme: "light" });
    assert.notProperty(merged, "forkhubOwner");
  });

  it("unions registries by id, strips incoming tokens, keeps local ones", () => {
    const { merged, added, updated } = mergeRegistryFile(
      {
        version: 1,
        records: [
          {
            environmentId: "new",
            label: "New",
            httpBaseUrl: "http://a",
            encryptedBearerToken: "c2VjcmV0",
          },
          {
            environmentId: "shared",
            label: "Shared",
            httpBaseUrl: "http://b-new",
            lastConnectedAt: "source-time",
          },
          { environmentId: "same", label: "Same", httpBaseUrl: "http://c" },
        ],
      },
      {
        version: 1,
        records: [
          {
            environmentId: "shared",
            label: "Shared",
            httpBaseUrl: "http://b-old",
            encryptedBearerToken: "bG9jYWw=",
            lastConnectedAt: "local-time",
          },
          { environmentId: "same", label: "Same", httpBaseUrl: "http://c" },
          { environmentId: "local-only", label: "Local", httpBaseUrl: "http://d" },
        ],
      },
    );
    assert.deepEqual(added, ["New"]);
    assert.deepEqual(updated, ["Shared"]);
    const records = (merged.records ?? []) as ReadonlyArray<Record<string, unknown>>;
    assert.equal(records.length, 4);
    const byId = new Map(records.map((record) => [record.environmentId as string, record]));
    assert.notProperty(byId.get("new"), "encryptedBearerToken");
    assert.equal(byId.get("shared")?.httpBaseUrl, "http://b-new");
    assert.equal(byId.get("shared")?.encryptedBearerToken, "bG9jYWw=");
    assert.equal(byId.get("shared")?.lastConnectedAt, "local-time");
    assert.isTrue(byId.has("local-only"));
  });

  it.effect("previews an import without writing anything", () =>
    withTempHome(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const join = environment.path.join;
        const stockDir = join(environment.homeDirectory, ".t3", "userdata");
        yield* fileSystem.makeDirectory(stockDir, { recursive: true });
        yield* fileSystem.writeFileString(
          join(stockDir, "desktop-settings.json"),
          JSON.stringify({ theme: "dark" }),
        );
        yield* fileSystem.writeFileString(join(stockDir, "bogus.json"), `not json {{{`);

        const preview = yield* previewForkHubStateTransfer("import");

        assert.isTrue(preview.otherHomeFound);
        assert.equal(
          preview.files.find((file) => file.file === "desktop-settings.json")?.status,
          "new",
        );
        assert.equal(
          preview.files.find((file) => file.file === "client-settings.json")?.status,
          "missing-source",
        );
        // Fork home untouched by a preview.
        assert.isFalse(yield* fileSystem.exists(environment.desktopSettingsPath));
      }),
    ),
  );

  it.effect("reports a missing stock home on import", () =>
    withTempHome(
      Effect.gen(function* () {
        const preview = yield* previewForkHubStateTransfer("import");
        assert.isFalse(preview.otherHomeFound);
      }),
    ),
  );

  it.effect("imports prefs, preserves updater identity, and backs up", () =>
    withTempHome(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const join = environment.path.join;
        const stockDir = join(environment.homeDirectory, ".t3", "userdata");
        yield* fileSystem.makeDirectory(stockDir, { recursive: true });
        yield* fileSystem.writeFileString(
          join(stockDir, "desktop-settings.json"),
          JSON.stringify({ theme: "dark", forkhubOwner: null, updateChannel: "latest" }),
        );
        yield* fileSystem.writeFileString(
          join(stockDir, "saved-environments.json"),
          JSON.stringify({
            version: 1,
            records: [
              {
                environmentId: "prod",
                label: "Prod",
                httpBaseUrl: "http://127.0.0.1:3773",
                encryptedBearerToken: "c2VjcmV0",
              },
            ],
          }),
        );
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.desktopSettingsPath,
          JSON.stringify({ theme: "light", forkhubOwner: "with-fh", updateChannel: "nightly" }),
        );

        const result = yield* applyForkHubStateTransfer("import");

        assert.isTrue(result.applied);
        assert.equal(result.errors.length, 0);
        assert.equal(result.backups.length, 1);
        const settings = JSON.parse(
          yield* fileSystem.readFileString(environment.desktopSettingsPath),
        ) as Record<string, unknown>;
        assert.equal(settings.theme, "dark");
        assert.equal(settings.forkhubOwner, "with-fh");
        assert.equal(settings.updateChannel, "nightly");
        const registry = JSON.parse(
          yield* fileSystem.readFileString(join(environment.stateDir, "saved-environments.json")),
        ) as { records: ReadonlyArray<Record<string, unknown>> };
        assert.equal(registry.records.length, 1);
        assert.notProperty(registry.records[0], "encryptedBearerToken");
        assert.equal(result.addedEnvironmentsTotal, 1);

        // Second run is a no-op: everything already in sync.
        const again = yield* applyForkHubStateTransfer("import");
        assert.isFalse(again.applied);
        assert.equal(again.backups.length, 0);
      }),
    ),
  );

  it.effect("exports without leaking ForkHub identity into stock", () =>
    withTempHome(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const join = environment.path.join;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.desktopSettingsPath,
          JSON.stringify({ theme: "dark", forkhubOwner: "with-fh", updateChannel: "nightly" }),
        );

        const result = yield* applyForkHubStateTransfer("export");

        assert.isTrue(result.applied);
        const stockDir = join(environment.homeDirectory, ".t3", "userdata");
        const exported = JSON.parse(
          yield* fileSystem.readFileString(join(stockDir, "desktop-settings.json")),
        ) as Record<string, unknown>;
        assert.equal(exported.theme, "dark");
        assert.notProperty(exported, "forkhubOwner");
        assert.notProperty(exported, "updateChannel");
      }),
    ),
  );

  it.effect("refuses transfer on stock builds and explicit homes", () =>
    withTempHome(
      Effect.gen(function* () {
        const stockFailed = yield* previewForkHubStateTransfer("import").pipe(
          Effect.flip,
          Effect.map((error) => String(error)),
        );
        assert.include(stockFailed, "only available on ForkHub");
      }),
      { appVersion: "0.0.45-nightly.20260930.2468" },
    ),
  );

  it.effect("refuses transfer under an explicit T3CODE_HOME", () =>
    withTempHome(
      Effect.gen(function* () {
        assert.isFalse((yield* DesktopEnvironment.DesktopEnvironment).isImplicitHome);
        const failed = yield* previewForkHubStateTransfer("export").pipe(
          Effect.flip,
          Effect.map((error) => String(error)),
        );
        assert.include(failed, "default home");
      }),
      {
        env: (baseDir) => ({ T3CODE_HOME: `${baseDir}/custom-home` }),
      },
    ),
  );
});

const DB_FIXTURE_SCHEMA = `
CREATE TABLE orchestration_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_kind TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  command_id TEXT,
  causation_event_id TEXT,
  correlation_id TEXT,
  actor_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL);
CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, text TEXT NOT NULL, attachments_json TEXT);
CREATE TABLE effect_sql_migrations (migration_id TEXT PRIMARY KEY);
`;

function makeFixtureDb(path: string, seed: (db: NodeSqlite.DatabaseSync) => void): void {
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(DB_FIXTURE_SCHEMA);
  db.exec(`INSERT INTO effect_sql_migrations (migration_id) VALUES ('001'), ('002')`);
  seed(db);
  db.close();
}

function seedSourceDb(db: NodeSqlite.DatabaseSync): void {
  db.exec(
    `INSERT INTO projection_projects (project_id, title) VALUES ('proj-1', 'Alpha'), ('proj-2', 'Beta')`,
  );
  db.exec(
    `INSERT INTO projection_threads (thread_id, project_id, title) VALUES ('thread-1', 'proj-1', 'T1'), ('thread-2', 'proj-1', 'T2'), ('thread-3', 'proj-2', 'T3')`,
  );
  db.exec(
    `INSERT INTO projection_thread_messages (message_id, thread_id, text, attachments_json) VALUES
     ('msg-1', 'thread-1', 'hello', '[{"id":"thread-1-uuid.png"}]'),
     ('msg-2', 'thread-1', 'world', NULL),
     ('msg-3', 'thread-3', 'hi', NULL)`,
  );
  const event = (id: string, kind: string, stream: string, version: number) =>
    db
      .prepare(
        `INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json) VALUES (?, ?, ?, ?, 'Test', '2026-09-30T00:00:00Z', 'client', '{}', '{}')`,
      )
      .run(id, kind, stream, version);
  event("evt-p1", "project", "proj-1", 1);
  event("evt-p2", "project", "proj-2", 1);
  event("evt-t1", "thread", "thread-1", 1);
  event("evt-t2", "thread", "thread-1", 2);
  event("evt-t3", "thread", "thread-2", 1);
  event("evt-t4", "thread", "thread-3", 1);
}

describe("DesktopForkHubStateTransfer conversations", () => {
  it("previews project, thread, message, and event counts", () => {
    const dir = NodeFs.mkdtempSync(NodePathNative.join(NodeOs.tmpdir(), "t3-xfer-preview-"));
    const source = NodePathNative.join(dir, "source.sqlite");
    const dest = NodePathNative.join(dir, "dest.sqlite");
    makeFixtureDb(source, seedSourceDb);
    makeFixtureDb(dest, () => {});

    const preview = previewDbTransfer(source, dest);

    assert.isTrue(preview.available);
    assert.equal(preview.projects, 2);
    assert.equal(preview.threads, 3);
    assert.equal(preview.messages, 3);
    assert.equal(preview.events, 6);
    assert.deepEqual([...preview.projectTitles].sort(), ["Alpha", "Beta"]);
    assert.isNull(preview.note);
    NodeFs.rmSync(dir, { recursive: true });
  });

  it("moves events, projections, and attachment files, then reruns as a no-op", () => {
    const dir = NodeFs.mkdtempSync(NodePathNative.join(NodeOs.tmpdir(), "t3-xfer-apply-"));
    const source = NodePathNative.join(dir, "source.sqlite");
    const dest = NodePathNative.join(dir, "dest.sqlite");
    makeFixtureDb(source, seedSourceDb);
    makeFixtureDb(dest, () => {});
    const sourceAttachments = NodePathNative.join(dir, "src-attachments");
    const destAttachments = NodePathNative.join(dir, "dest-attachments");
    NodeFs.mkdirSync(sourceAttachments, { recursive: true });
    NodeFs.writeFileSync(NodePathNative.join(sourceAttachments, "thread-1-uuid.png"), "png-bytes");

    const first = applyDbTransfer({
      sourceDbPath: source,
      destDbPath: dest,
      backupDbPath: NodePathNative.join(dir, "dest.bak.sqlite"),
      sourceAttachmentsDir: sourceAttachments,
      destAttachmentsDir: destAttachments,
      copyFile: (from, to) => NodeFs.copyFileSync(from, to),
      makeDirectory: (target) => NodeFs.mkdirSync(target, { recursive: true }),
    });

    assert.equal(first.errors.length, 0);
    assert.equal(first.projects, 2);
    assert.equal(first.threads, 3);
    assert.equal(first.messages, 3);
    assert.equal(first.files, 1);
    assert.isNotNull(first.backup);
    const destDb = new NodeSqlite.DatabaseSync(dest, { readOnly: true });
    try {
      const events = (destDb.prepare("SELECT COUNT(*) AS n FROM orchestration_events").get() as { n: number }).n;
      assert.equal(events, 6);
      const threads = (destDb.prepare("SELECT COUNT(*) AS n FROM projection_threads").get() as { n: number }).n;
      assert.equal(threads, 3);
      // Identity tables are never created or touched by the move.
      const tables = (
        destDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      assert.notInclude(tables, "auth_sessions");
    } finally {
      destDb.close();
    }
    assert.equal(NodeFs.readFileSync(NodePathNative.join(destAttachments, "thread-1-uuid.png"), "utf8"), "png-bytes");

    // Rerun: every stream already present, nothing moves, no new backup.
    const second = applyDbTransfer({
      sourceDbPath: source,
      destDbPath: dest,
      backupDbPath: NodePathNative.join(dir, "dest.bak2.sqlite"),
      sourceAttachmentsDir: sourceAttachments,
      destAttachmentsDir: destAttachments,
      copyFile: (from, to) => NodeFs.copyFileSync(from, to),
      makeDirectory: (target) => NodeFs.mkdirSync(target, { recursive: true }),
    });
    assert.equal(second.errors.length, 0);
    assert.equal(second.threads, 0);
    assert.isNull(second.backup);
    assert.isFalse(NodeFs.existsSync(NodePathNative.join(dir, "dest.bak2.sqlite")));
    NodeFs.rmSync(dir, { recursive: true });
  });

  it("skips streams already present and tolerates a missing attachment file", () => {
    const dir = NodeFs.mkdtempSync(NodePathNative.join(NodeOs.tmpdir(), "t3-xfer-skip-"));
    const source = NodePathNative.join(dir, "source.sqlite");
    const dest = NodePathNative.join(dir, "dest.sqlite");
    makeFixtureDb(source, seedSourceDb);
    makeFixtureDb(dest, (db) => {
      db.exec(
        `INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json) VALUES ('evt-t3-dest', 'thread', 'thread-3', 1, 'Test', '2026-09-30T00:00:00Z', 'client', '{}', '{}')`,
      );
    });

    const result = applyDbTransfer({
      sourceDbPath: source,
      destDbPath: dest,
      backupDbPath: NodePathNative.join(dir, "dest.bak.sqlite"),
      sourceAttachmentsDir: NodePathNative.join(dir, "missing-src"),
      destAttachmentsDir: NodePathNative.join(dir, "dest-attachments"),
      copyFile: (from, to) => NodeFs.copyFileSync(from, to),
      makeDirectory: (target) => NodeFs.mkdirSync(target, { recursive: true }),
    });

    // thread-3 already on dest: only proj-1/proj-2 streams and thread-1/thread-2 move.
    assert.equal(result.errors.length, 0);
    assert.equal(result.projects, 2);
    assert.equal(result.threads, 2);
    // The thread-1 attachment source file is absent: skipped, move still succeeds.
    assert.equal(result.files, 0);
    NodeFs.rmSync(dir, { recursive: true });
  });

  it("reports a missing source database without failing", () => {
    const preview = previewDbTransfer("/missing/source.sqlite", "/missing/dest.sqlite");
    assert.isFalse(preview.available);
    assert.isNotNull(preview.note);
  });

  it("warns when the source database runs newer migrations", () => {
    const dir = NodeFs.mkdtempSync(NodePathNative.join(NodeOs.tmpdir(), "t3-xfer-skew-"));
    const source = NodePathNative.join(dir, "source.sqlite");
    const dest = NodePathNative.join(dir, "dest.sqlite");
    makeFixtureDb(source, seedSourceDb);
    makeFixtureDb(dest, (db) => {
      db.exec(`DELETE FROM effect_sql_migrations WHERE migration_id = '002'`);
    });

    const preview = previewDbTransfer(source, dest);

    assert.isTrue(preview.available);
    assert.isNotNull(preview.note);
    assert.include(preview.note ?? "", "newer");
    NodeFs.rmSync(dir, { recursive: true });
  });
});
