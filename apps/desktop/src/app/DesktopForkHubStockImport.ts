import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { isForkHubDerivedVersion } from "../updates/updateChannels.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// State files a ForkHub install adopts from a stock home on first boot.
// User data only: UI prefs, the update track + validated owner, and the
// saved-environment registry (ports, labels, machine-bound tokens).
// Backend identity (ids, runtime), credentials (secrets, Clerk tokens), and
// server settings stay fresh per install — two backends must never share an
// identity, and re-auth is one deliberate click.
const IMPORTABLE_STATE_FILES = [
  "desktop-settings.json",
  "client-settings.json",
  "saved-environments.json",
] as const;

const IMPORT_MARKER_FILE = ".forkhub-stock-import.json";

// One-time, best-effort adoption: a fresh ForkHub home starts as a copy of
// the user's stock state instead of a blank slate, so track, owner, prefs,
// and environments survive the switch. Runs before the first settings load;
// never fails startup. The marker makes it run once — deleting settings
// later resets to defaults without re-importing; deleting the whole
// ForkHub home re-arms it.
export const importStockStateOnFirstForkHubBoot = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  if (
    environment.isDevelopment ||
    !isForkHubDerivedVersion(environment.appVersion) ||
    !environment.isImplicitHome
  ) {
    return;
  }
  const join = environment.path.join;
  const markerPath = join(environment.stateDir, IMPORT_MARKER_FILE);
  if (yield* fileSystem.exists(markerPath)) {
    return;
  }
  if (yield* fileSystem.exists(environment.desktopSettingsPath)) {
    return;
  }
  const sourceDir = join(environment.homeDirectory, ".t3", "userdata");
  const imported: Array<string> = [];
  for (const file of IMPORTABLE_STATE_FILES) {
    const raw = yield* fileSystem.readFileString(join(sourceDir, file)).pipe(Effect.option);
    if (Option.isNone(raw)) {
      continue;
    }
    const copy = Effect.gen(function* () {
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(join(environment.stateDir, file), raw.value);
      imported.push(file);
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("ForkHub first-boot import skipped a stock state file", {
          file,
          cause: String(cause),
        }),
      ),
    );
    yield* copy;
  }
  yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true }).pipe(Effect.ignore);
  yield* fileSystem
    .writeFileString(
      markerPath,
      `${JSON.stringify({ sourceDir, importedAt: new Date().toISOString(), files: imported })}\n`,
    )
    .pipe(Effect.ignore);
  yield* Effect.logInfo("ForkHub first-boot stock state import finished", {
    sourceDir,
    files: imported,
  });
}).pipe(
  Effect.catch((cause) =>
    Effect.logWarning("ForkHub first-boot stock import skipped", { cause: String(cause) }),
  ),
  Effect.withSpan("desktop.forkhub.stockImport"),
);
