import type { DesktopForkHubRepo, DesktopUpdateChannel } from "@t3tools/contracts";
import { DEFAULT_FORKHUB_PUBLISHER } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;
// ForkHub builds carry the upstream version plus a provenance prerelease
// extension — `.fh.<owner>.<n>` after an existing prerelease part, or
// `-fh.<owner>.<n>` on a bare base (e.g. `0.0.43-nightly.20260924.2187`
// → `…2187.fh.imbios.1`, `0.0.42` → `0.0.42-fh.imbios.1`). The joiner
// keeps the version valid semver: electron-builder mangles invalid ones
// (`0.0.42.fh.imbios.1` once shipped as `0.0.4-2.fh.imbios.1`).
const FORKHUB_VERSION_SUFFIX_PATTERN = /[-.]fh\.[a-z0-9-]+\.\d+$/;
const NIGHTLY_OR_FORKHUB_VERSION_PATTERN =
  /^[^-+]+-nightly\.\d{8}\.\d+(?:[-.]fh\.[a-z0-9-]+\.\d+)?$/;

export function isForkHubDerivedVersion(version: string): boolean {
  return FORKHUB_VERSION_SUFFIX_PATTERN.test(version);
}
// Preview builds are the maintainers' test train, cut by hand from unreleased
// branches to exercise the release flow. They share nightly's branding but
// are packaged without an update feed (see
// isDesktopPreviewVersion in scripts/build-desktop-artifact.ts), so the
// channel a preview install reports is cosmetic: it never checks for updates
// and no updater feed ever lists a preview release.
const PRERELEASE_VERSION_PATTERN =
  /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+(?:\.fh\.[a-z0-9-]+\.\d+)?$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_OR_FORKHUB_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}

// ForkHub: the updater feed is a publisher's public `.forkhub` releases,
// selected by the version provenance (`.fh.<owner>.<n>`), not by channel.
// The track stays latest/nightly and picks which train of the publisher's
// catalog to follow; the owner input is validated against the GitHub
// Releases API before the feed is pointed at it; see
// apps/web/src/components/forkHub.logic.ts.
export const FORKHUB_UPDATE_REPOS: ReadonlyArray<DesktopForkHubRepo> = [".forkhub"];

// Publisher prefilled for fresh ForkHub homes. The catalog org publishes
// the builds; anyone can point at their own publisher instead.
export { DEFAULT_FORKHUB_PUBLISHER };

const FORKHUB_OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export function normalizeForkHubOwner(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const owner = raw.trim();
  if (owner.length < 1 || owner.length > 39) return null;
  return FORKHUB_OWNER_PATTERN.test(owner) ? owner : null;
}

export function resolveForkHubFeedConfig(input: {
  readonly owner: string;
  readonly repo?: DesktopForkHubRepo;
}): { provider: "github"; owner: string; repo: string } | null {
  const owner = normalizeForkHubOwner(input.owner);
  if (!owner) return null;
  const repo = input.repo ?? ".forkhub";
  if (repo !== ".forkhub") return null;
  return { provider: "github", owner, repo };
}

export interface ForkHubCatalogTrains {
  readonly hasStableTrain: boolean;
  readonly hasNightlyTrain: boolean;
}

interface CatalogReleaseRow {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
}

// Train detection runs on versioned updater tags only (`vX.Y.Z…`): bundle
// releases mirror the same trains and carry no version of their own.
// Preview/PR cuts serve no train. Mirrors the renderer's Check classifier
// (apps/web/src/components/forkHub.logic.ts) for boot-time use in main.
export function resolveCatalogTrains(rows: unknown): ForkHubCatalogTrains {
  const releases = Array.isArray(rows) ? rows.filter(isUsableCatalogRelease) : [];
  const versionTags = releases
    .map((row) => (row as CatalogReleaseRow).tag_name as string)
    .filter((tag) => /^v\d+\.\d+\.\d+/.test(tag));
  return {
    hasStableTrain: versionTags.some(
      (tag) =>
        !/-nightly\.\d{8}\./.test(tag) &&
        !/-preview\.\d{8}\./.test(tag) &&
        !/-pr\./.test(tag),
    ),
    hasNightlyTrain: versionTags.some((tag) => /-nightly\.\d{8}\./.test(tag)),
  };
}

function isUsableCatalogRelease(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as CatalogReleaseRow;
  return candidate.draft !== true && typeof candidate.tag_name === "string";
}

// Which tracks the Update track selector offers. Unknown trains (never
// Checked) leave both; a publisher serving one train narrows the list.
export function resolveVisibleUpdateTracks(input: {
  readonly hasStableTrain: boolean | null;
  readonly hasNightlyTrain: boolean | null;
}): ReadonlyArray<DesktopUpdateChannel> {
  const tracks: Array<DesktopUpdateChannel> = [];
  if (input.hasStableTrain !== false) tracks.push("latest");
  if (input.hasNightlyTrain !== false) tracks.push("nightly");
  return tracks;
}

// After a publisher (re-)check, the selected track may no longer exist
// (e.g. moving to a nightly-only catalog while on stable). Migrate to a
// supported track, preferring the current one and then nightly.
export function resolveMigratedUpdateTrack(
  current: DesktopUpdateChannel,
  trains: ForkHubCatalogTrains,
): DesktopUpdateChannel {
  if (current === "latest" && trains.hasStableTrain) return "latest";
  if (current === "nightly" && trains.hasNightlyTrain) return "nightly";
  return trains.hasNightlyTrain ? "nightly" : "latest";
}

/**
 * Whether an updater-advertised version may be installed on a channel.
 * Provenance must match the install: a `.fh` build installs on ForkHub
 * builds only (on either track — the publisher's catalog serves both
 * trains), and stock builds never flow into a ForkHub install. Stock
 * tracks keep stock train rules. Unknown future channels fail closed.
 */
export function isVersionAllowedOnUpdateChannel(
  version: string,
  channel: DesktopUpdateChannel,
  isForkHubBuild: boolean,
): boolean {
  if (isForkHubDerivedVersion(version)) return isForkHubBuild;
  if (isForkHubBuild) return false;
  if (channel === "nightly") return NIGHTLY_VERSION_PATTERN.test(version);
  if (channel === "latest") return resolveDefaultDesktopUpdateChannel(version) === "latest";
  return false;
}
