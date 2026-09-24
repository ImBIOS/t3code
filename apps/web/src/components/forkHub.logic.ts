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
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=5`;
}

export function forkHubRepoWebUrl(owner: string, repo: DesktopForkHubRepo): string {
  return `https://github.com/${owner}/${repo}/releases`;
}

export interface ForkHubOwnerCheck {
  readonly owner: string;
  readonly repo: DesktopForkHubRepo;
  readonly releaseCount: number;
  readonly latestTag: string | null;
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

/**
 * Validates a profile/org name as a T3 Code ForkHub channel: the account must
 * own a public `.forkhub` repo with at least one published release.
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
  const latestTag =
    typeof (releases[0] as GitHubReleaseRow).tag_name === "string"
      ? ((releases[0] as GitHubReleaseRow).tag_name as string)
      : null;
  return { owner, repo, releaseCount: releases.length, latestTag };
}
