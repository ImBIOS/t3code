import type { DesktopForkHubRepo, DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;
// ForkHub builds carry the upstream version plus a `.fh.<owner>.<n>`
// prerelease extension (e.g. `0.0.43-nightly.20260924.2187.fh.imbios.1`),
// so the build advertises its provenance while keeping train ordering.
const FORKHUB_VERSION_SUFFIX_PATTERN = /\.fh\.[a-z0-9-]+\.\d+$/;
const NIGHTLY_OR_FORKHUB_VERSION_PATTERN =
  /^[^-+]+-nightly\.\d{8}\.\d+(?:\.fh\.[a-z0-9-]+\.\d+)?$/;
const PREVIEW_VERSION_PATTERN = /^[^-+]+-preview\.\d{8}\.\d+$/;

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

// ForkHub: the updater channel is another GitHub profile/org's public
// `.forkhub` releases. The owner input is validated against the GitHub
// Releases API before the feed is pointed at it; see
// apps/web/src/components/forkHub.logic.ts.
export const FORKHUB_UPDATE_REPOS: ReadonlyArray<DesktopForkHubRepo> = [".forkhub"];

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

/**
 * Whether an updater-advertised version may be installed on a channel.
 * Stock tracks take stock builds only: a `.fh` build must never flow into
 * `latest` or `nightly`. ForkHub follows whatever its publisher's catalog
 * serves (stable and/or nightly-based builds, suffixed or not) — everything
 * except preview/PR cuts, which ship without a feed. Unknown future
 * channels fail closed.
 */
export function isVersionAllowedOnUpdateChannel(
  version: string,
  channel: DesktopUpdateChannel,
): boolean {
  if (isForkHubDerivedVersion(version)) return channel === "forkhub";
  if (channel === "nightly") return NIGHTLY_VERSION_PATTERN.test(version);
  if (channel === "latest") return resolveDefaultDesktopUpdateChannel(version) === "latest";
  if (channel === "forkhub") return !PREVIEW_VERSION_PATTERN.test(version) && !/-pr\./.test(version);
  return false;
}
