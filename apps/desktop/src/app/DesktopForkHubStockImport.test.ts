import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { importStockStateOnFirstForkHubBoot } from "./DesktopForkHubStockImport.ts";

const FORKHUB_VERSION = "0.0.43-nightly.20260924.2187.fh.imbios.1";

const IMPORTABLE = [
  "desktop-settings.json",
  "client-settings.json",
  "saved-environments.json",
] as const;

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
      prefix: "t3-forkhub-import-test-",
    });
    const env = typeof options.env === "function" ? options.env(baseDir) : (options.env ?? {});
    return yield* effect.pipe(
      Effect.provide(environmentLayer(baseDir, options.appVersion ?? FORKHUB_VERSION, env)),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const writeStockState = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const sourceDir = environment.path.join(environment.homeDirectory, ".t3", "userdata");
  yield* fileSystem.makeDirectory(sourceDir, { recursive: true });
  for (const file of IMPORTABLE) {
    yield* fileSystem.writeFileString(
      environment.path.join(sourceDir, file),
      JSON.stringify({ importedFrom: "stock", file }),
    );
  }
  return sourceDir;
});

const readTarget = (file: string) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(environment.path.join(environment.stateDir, file));
  });

describe("DesktopForkHubStockImport", () => {
  it.effect("adopts stock state into a fresh ForkHub home with a marker", () =>
    withTempHome(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const sourceDir = yield* writeStockState;

        yield* importStockStateOnFirstForkHubBoot;

        assert.equal(environment.baseDir, `${environment.homeDirectory}/.t3-forkhub`);
        for (const file of IMPORTABLE) {
          assert.equal(
            yield* readTarget(file),
            JSON.stringify({ importedFrom: "stock", file }),
          );
        }
        const marker = JSON.parse(yield* readTarget(".forkhub-stock-import.json")) as {
          sourceDir: string;
          files: Array<string>;
        };
        assert.equal(marker.sourceDir, sourceDir);
        assert.deepEqual(marker.files, [...IMPORTABLE]);
        assert.isTrue(yield* fileSystem.exists(environment.desktopSettingsPath));
      }),
    ),
  );

  it.effect("runs once: a later source change does not overwrite the ForkHub home", () =>
    withTempHome(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const sourceDir = yield* writeStockState;
        yield* importStockStateOnFirstForkHubBoot;

        yield* fileSystem.writeFileString(
          environment.path.join(sourceDir, "desktop-settings.json"),
          JSON.stringify({ importedFrom: "changed" }),
        );
        yield* importStockStateOnFirstForkHubBoot;

        assert.equal(
          yield* readTarget("desktop-settings.json"),
          JSON.stringify({ importedFrom: "stock", file: "desktop-settings.json" }),
        );
      }),
    ),
  );

  it.effect("never clobbers an existing ForkHub settings file", () =>
    withTempHome(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeStockState;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.desktopSettingsPath, `{"mine":true}`);

        yield* importStockStateOnFirstForkHubBoot;

        assert.equal(yield* readTarget("desktop-settings.json"), `{"mine":true}`);
        assert.isFalse(
          yield* fileSystem.exists(environment.path.join(environment.stateDir, ".forkhub-stock-import.json")),
        );
      }),
    ),
  );

  it.effect("respects a deliberate reset: marker without settings does not re-import", () =>
    withTempHome(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeStockState;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.path.join(environment.stateDir, ".forkhub-stock-import.json"),
          `{"files":[]}`,
        );

        yield* importStockStateOnFirstForkHubBoot;

        assert.isFalse(yield* fileSystem.exists(environment.desktopSettingsPath));
      }),
    ),
  );

  it.effect("leaves a marker and boots on when no stock home exists", () =>
    withTempHome(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;

        yield* importStockStateOnFirstForkHubBoot;

        const marker = JSON.parse(
          yield* readTarget(".forkhub-stock-import.json"),
        ) as { files: Array<string> };
        assert.deepEqual(marker.files, []);
      }),
    ),
  );

  it.effect("does nothing for stock builds", () =>
    withTempHome(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeStockState;

        yield* importStockStateOnFirstForkHubBoot;

        assert.isFalse(
          yield* fileSystem.exists(
            environment.path.join(environment.stateDir, ".forkhub-stock-import.json"),
          ),
        );
      }),
      { appVersion: "0.0.43-nightly.20260928.2375" },
    ),
  );

  it.effect("does nothing when T3CODE_HOME pins the backend home", () =>
    withTempHome(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        assert.isFalse(environment.isImplicitHome);
        yield* writeStockState;

        yield* importStockStateOnFirstForkHubBoot;

        assert.isFalse(yield* fileSystem.exists(environment.desktopSettingsPath));
      }),
      {
        env: (baseDir) => ({ T3CODE_HOME: `${baseDir}/custom-home` }),
      },
    ),
  );
});
