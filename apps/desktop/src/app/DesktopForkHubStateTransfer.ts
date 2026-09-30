import {
  type ForkHubStateTransferDirection,
  type ForkHubStateTransferFilePreview,
  type ForkHubStateTransferPreview,
  type ForkHubStateTransferResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

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
    return { direction, otherHomeFound, files };
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
    const message =
      errors.length > 0
        ? `${which} finished with ${errors.length} problem${errors.length === 1 ? "" : "s"}: ${errors.join(" ")}`
        : written === 0
          ? "Everything is already in sync — nothing to move."
          : `${which} moved ${written} file${written === 1 ? "" : "s"}. Quit and reopen T3 Code to apply.`;
    return {
      direction,
      applied: written > 0,
      backups,
      addedEnvironmentsTotal,
      updatedEnvironmentsTotal,
      changedKeysTotal,
      errors,
      message,
    };
  });
