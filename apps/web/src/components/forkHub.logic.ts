import type { DesktopForkHubRepo } from "@t3tools/contracts";

/**
 * ForkHub updater channel: instead of the upstream release train, a desktop
 * install polls the GitHub Releases of another profile/org's public
 * `.forkhub` catalog repo.
 */

export const FORKHUB_REPO: DesktopForkHubRepo = ".forkhub";

const FORKHUB_OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export function normalizeForkHubOwner(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const owner = raw.trim();
  if (owner.length < 1 || owner.length > 39) return null;
  return FORKHUB_OWNER_PATTERN.test(owner) ? owner : null;
}

export function forkHubReleasesApiUrl(owner: string, repo: DesktopForkHubRepo): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=20`;
}

// This app's entry in a publisher catalog, keyed by upstream coordinates.
// The manifest declares per-target trains (`trains: ["nightly"]`) —
// authoritative, so other targets' releases can never leak a phantom train
// into this app's track list. Publishers without it fall back to the tag
// scan below.
export const FORKHUB_T3CODE_UPSTREAM_MANIFEST_PATH =
  "repos/github.com/pingdotgg/t3code/upstream.json";

const FORKHUB_STABLE_TRAIN_NAMES = ["stable", "latest", "default"];

export interface ForkHubCatalogTrains {
  readonly hasStableTrain: boolean;
  readonly hasNightlyTrain: boolean;
}

export function resolveTrainsFromUpstreamManifest(document: unknown): ForkHubCatalogTrains | null {
  if (typeof document !== "object" || document === null) return null;
  const trains = (document as { trains?: unknown }).trains;
  if (!Array.isArray(trains)) return null;
  const names = new Set(
    trains
      .filter((train): train is string => typeof train === "string")
      .map((train) => train.toLowerCase()),
  );
  if (!names.has("nightly") && !FORKHUB_STABLE_TRAIN_NAMES.some((name) => names.has(name))) {
    return null;
  }
  return {
    hasStableTrain: FORKHUB_STABLE_TRAIN_NAMES.some((name) => names.has(name)),
    hasNightlyTrain: names.has("nightly"),
  };
}

export function forkHubUpstreamManifestApiUrl(owner: string, repo: DesktopForkHubRepo): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${FORKHUB_T3CODE_UPSTREAM_MANIFEST_PATH}`;
}

export function resolveCatalogTrains(rows: unknown): ForkHubCatalogTrains {
  const releases = Array.isArray(rows) ? rows.filter(isUsableRelease) : [];
  const versionTags = releases
    .map((row) => (row as GitHubReleaseRow).tag_name as string)
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

export function forkHubRepoWebUrl(owner: string, repo: DesktopForkHubRepo): string {
  return `https://github.com/${owner}/${repo}/releases`;
}

export interface ForkHubOwnerCheck {
  readonly owner: string;
  readonly repo: DesktopForkHubRepo;
  readonly releaseCount: number;
  readonly latestTag: string | null;
  // Which trains the publisher's catalog serves. A ForkHub build follows
  // the selected update track (stable = latest, nightly) inside this
  // publisher's catalog; a publisher with neither train is invalid.
  readonly hasStableTrain: boolean;
  readonly hasNightlyTrain: boolean;
}

interface GitHubReleaseRow {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
}

function isUsableRelease(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as GitHubReleaseRow;
  return candidate.draft !== true && typeof candidate.tag_name === "string";
}

async function readTrainsFromUpstreamManifest(
  owner: string,
  repo: DesktopForkHubRepo,
  fetchImpl: typeof fetch,
): Promise<ForkHubCatalogTrains | null> {
  try {
    const response = await fetchImpl(forkHubUpstreamManifestApiUrl(owner, repo), {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    if (
      typeof body !== "object" ||
      body === null ||
      (body as { encoding?: unknown }).encoding !== "base64" ||
      typeof (body as { content?: unknown }).content !== "string"
    ) {
      return null;
    }
    const document = JSON.parse(
      atob(((body as { content: string }).content).replace(/\s/g, "")),
    ) as unknown;
    return resolveTrainsFromUpstreamManifest(document);
  } catch {
    return null;
  }
}

/**
 * Validates a publisher as a T3 Code ForkHub source: the account must own
 * a public `.forkhub` repo with at least one published release on the
 * stable train, the nightly train, or both.
 */
export async function checkForkHubOwner(
  rawOwner: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ForkHubOwnerCheck> {
  const owner = normalizeForkHubOwner(rawOwner);
  if (!owner) {
    throw new Error(
      `"${rawOwner.trim()}" is not a valid GitHub profile or org name. Use 1–39 letters, numbers, or dashes.`,
    );
  }
  const repo = FORKHUB_REPO;
  const response = await fetchImpl(forkHubReleasesApiUrl(owner, repo), {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (response.status === 404) {
    throw new Error(
      `${owner} has no .forkhub releases yet. Ask them to publish a ForkHub build first.`,
    );
  }
  if (response.status === 403) {
    throw new Error(
      `GitHub rate-limited the check for ${owner}/${repo}. Wait a minute and try again.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Could not check ${owner}/${repo} (HTTP ${response.status}).`);
  }
  const rows = (await response.json()) as unknown;
  const releases = Array.isArray(rows) ? rows.filter(isUsableRelease) : [];
  if (releases.length === 0) {
    throw new Error(
      `${owner}/${repo} exists but has no published releases yet. Ask them to publish a ForkHub build first.`,
    );
  }
  // Authoritative trains first: the catalog manifest declares per-target
  // trains. Falls back to the tag scan when the publisher has no manifest
  // entry for this app.
  const manifestTrains = await readTrainsFromUpstreamManifest(owner, repo, fetchImpl);
  const { hasStableTrain, hasNightlyTrain } =
    manifestTrains ?? resolveCatalogTrains(releases);
  if (!hasStableTrain && !hasNightlyTrain) {
    throw new Error(
      `${owner}/${repo} has releases but serves neither the stable nor the nightly train. Ask them to publish a ForkHub build first.`,
    );
  }
  // Bundle releases (e.g. `pingdotgg-t3code-v…-fh1`) are newer than the
  // updater releases they describe; the "latest" label should name a real
  // version tag — which is also where the ForkHub provenance suffix shows.
  const versioned = releases.find(
    (row) =>
      typeof (row as GitHubReleaseRow).tag_name === "string" &&
      /^v\d+\.\d+\.\d+/.test((row as GitHubReleaseRow).tag_name as string),
  );
  const newest = versioned ?? releases[0];
  const latestTag =
    newest !== undefined && typeof (newest as GitHubReleaseRow).tag_name === "string"
      ? ((newest as GitHubReleaseRow).tag_name as string)
      : null;
  return { owner, repo, releaseCount: releases.length, latestTag, hasStableTrain, hasNightlyTrain };
}
