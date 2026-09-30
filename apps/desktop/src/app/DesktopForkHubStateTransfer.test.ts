import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  applyForkHubStateTransfer,
  mergeRegistryFile,
  mergeSettingsFile,
  parseJsonObject,
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
