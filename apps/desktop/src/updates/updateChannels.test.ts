import { describe, expect, it } from "vite-plus/test";

import {
  isForkHubDerivedVersion,
  isNightlyDesktopVersion,
  isVersionAllowedOnUpdateChannel,
  normalizeForkHubOwner,
  resolveCatalogTrains,
  resolveForkHubVersionOwner,
  resolveReleasedTrains,
  resolveSupportedTrains,
  resolveTrainsFromUpstreamManifest,
  resolveDefaultDesktopUpdateChannel,
  resolveForkHubFeedConfig,
  resolveMigratedUpdateTrack,
  resolveVisibleUpdateTracks,
} from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
    expect(isNightlyDesktopVersion("0.0.43-nightly.20260924.2187.fh.imbios.1")).toBe(true);
  });

  it("normalizes ForkHub owner names like GitHub does", () => {
    expect(normalizeForkHubOwner("  ImBIOS ")).toBe("ImBIOS");
    expect(normalizeForkHubOwner("my-org")).toBe("my-org");
    expect(normalizeForkHubOwner("")).toBeNull();
    expect(normalizeForkHubOwner("owner/repo")).toBeNull();
    expect(normalizeForkHubOwner("-nope")).toBeNull();
  });

  it("points the ForkHub feed at the owner's catalog repo", () => {
    expect(resolveForkHubFeedConfig({ owner: "ImBIOS" })).toEqual({
      provider: "github",
      owner: "ImBIOS",
      repo: ".forkhub",
    });
    expect(resolveForkHubFeedConfig({ owner: "not valid!" })).toBeNull();
  });

  it("keeps each track on its own train", () => {
    expect(isVersionAllowedOnUpdateChannel("1.2.3", "latest", false)).toBe(true);
    expect(isVersionAllowedOnUpdateChannel("1.2.3-nightly.20260911.1", "latest", false)).toBe(
      false,
    );
    expect(isVersionAllowedOnUpdateChannel("1.2.3-nightly.20260911.1", "nightly", false)).toBe(
      true,
    );
    expect(isVersionAllowedOnUpdateChannel("1.2.3", "nightly", false)).toBe(false);
    expect(isVersionAllowedOnUpdateChannel("0.0.41-preview.20260911.7", "nightly", false)).toBe(
      false,
    );
  });

  it("matches provenance to the install on ForkHub builds", () => {
    expect(isForkHubDerivedVersion("0.0.43-nightly.20260924.2187.fh.with-fh.1")).toBe(true);
    expect(isForkHubDerivedVersion("0.0.42-fh.with-fh.2")).toBe(true);
    expect(isForkHubDerivedVersion("0.0.43-nightly.20260924.2187")).toBe(false);
    expect(isForkHubDerivedVersion("0.0.42")).toBe(false);
  });

  it("resolves the publisher from a ForkHub version's provenance suffix", () => {
    expect(resolveForkHubVersionOwner("0.0.43-nightly.20260924.2187.fh.with-fh.1")).toBe("with-fh");
    expect(resolveForkHubVersionOwner("0.0.42-fh.with-fh.2")).toBe("with-fh");
    expect(resolveForkHubVersionOwner("0.0.43-nightly.20260924.2187")).toBe(null);
    expect(resolveForkHubVersionOwner("0.0.42")).toBe(null);
  });

  it("follows the publisher catalog on ForkHub builds", () => {
    // A ForkHub install follows its publisher's catalog on the selected
    // track: nightly- and stable-based builds on either.
    expect(
      isVersionAllowedOnUpdateChannel("0.0.43-nightly.20260924.2187.fh.with-fh.1", "nightly", true),
    ).toBe(true);
    expect(
      isVersionAllowedOnUpdateChannel("0.0.43-nightly.20260924.2187.fh.with-fh.1", "latest", true),
    ).toBe(true);
    expect(isVersionAllowedOnUpdateChannel("0.0.42-fh.with-fh.1", "latest", true)).toBe(true);
    expect(isVersionAllowedOnUpdateChannel("0.0.42-fh.with-fh.1", "nightly", true)).toBe(true);
    // Cross-provenance never installs: stock builds stay out of ForkHub
    // installs, ForkHub builds stay out of stock installs.
    expect(isVersionAllowedOnUpdateChannel("1.2.3", "latest", true)).toBe(false);
    expect(isVersionAllowedOnUpdateChannel("1.2.3-nightly.20260911.1", "nightly", true)).toBe(
      false,
    );
    expect(
      isVersionAllowedOnUpdateChannel(
        "0.0.43-nightly.20260924.2187.fh.with-fh.1",
        "nightly",
        false,
      ),
    ).toBe(false);
    expect(isVersionAllowedOnUpdateChannel("0.0.42-fh.with-fh.1", "latest", false)).toBe(false);
    expect(resolveDefaultDesktopUpdateChannel("0.0.43-nightly.20260924.2187.fh.with-fh.1")).toBe(
      "nightly",
    );
    expect(resolveDefaultDesktopUpdateChannel("0.0.42-fh.with-fh.1")).toBe("latest");
  });

  it("detects catalog trains from versioned updater tags only", () => {    expect(
      resolveCatalogTrains([
        { tag_name: "pingdotgg-t3code--v0.0.43-nightly.20260928.2375-fh1", draft: false },
        { tag_name: "v0.0.43-nightly.20260928.2375.fh.with-fh.1", draft: false },
        { tag_name: "v0.0.42-fh.with-fh.1", draft: false },
      ]),
    ).toEqual({ hasStableTrain: true, hasNightlyTrain: true });
    expect(resolveCatalogTrains([{ tag_name: "v0.0.43-nightly.20260928.2375.fh.with-fh.1" }])).toEqual(
      { hasStableTrain: false, hasNightlyTrain: true },
    );
    expect(
      resolveCatalogTrains([
        { tag_name: "v0.0.41-preview.20260914.1683" },
        { tag_name: "pingdotgg-t3code--v9.9.9-fh1" },
        { tag_name: "v1.0.0-pr.1", draft: false },
      ]),
    ).toEqual({ hasStableTrain: false, hasNightlyTrain: false });
    expect(resolveCatalogTrains([{ tag_name: "v1.0.0", draft: true }])).toEqual({
      hasStableTrain: false,
      hasNightlyTrain: false,
    });
    expect(resolveCatalogTrains("nope")).toEqual({ hasStableTrain: false, hasNightlyTrain: false });
  });

  it("only offers tracks the publisher serves", () => {
    expect(resolveVisibleUpdateTracks({ hasStableTrain: null, hasNightlyTrain: null })).toEqual([
      "latest",
      "nightly",
    ]);
    expect(resolveVisibleUpdateTracks({ hasStableTrain: false, hasNightlyTrain: true })).toEqual([
      "nightly",
    ]);
    expect(resolveVisibleUpdateTracks({ hasStableTrain: true, hasNightlyTrain: false })).toEqual([
      "latest",
    ]);
  });

  it("verifies declared trains against this target's bundle releases", () => {
    const slug = "pingdotgg-t3code";
    expect(
      resolveReleasedTrains(
        [
          { tag_name: "pingdotgg-t3code--v0.0.45-nightly.20260930.2468-fh1" },
          { tag_name: "pingdotgg-t3code--v0.0.44-fh2" },
          { tag_name: "natively-ai-assistant-natively-cluely-ai-assistant--V2.8.8-fh16" },
          { tag_name: "v2.8.8-fh.with-fh.3" },
          { tag_name: "v0.0.45-nightly.20260930.2468.fh.with-fh.1" },
        ],
        slug,
      ),
    ).toEqual({ hasStableTrain: true, hasNightlyTrain: true, hasBundleEvidence: true });
    expect(
      resolveReleasedTrains(
        [{ tag_name: "pingdotgg-t3code--v0.0.45-nightly.20260930.2468-fh1" }],
        slug,
      ),
    ).toEqual({ hasStableTrain: false, hasNightlyTrain: true, hasBundleEvidence: true });
    // Updater tags name no target; drafts do not count; nothing usable at all.
    expect(
      resolveReleasedTrains([{ tag_name: "v0.0.45-nightly.20260930.2468.fh.with-fh.1" }], slug),
    ).toEqual({ hasStableTrain: false, hasNightlyTrain: false, hasBundleEvidence: false });
    expect(resolveReleasedTrains("nope", slug).hasBundleEvidence).toBe(false);
  });

  it("offers only declared trains with shipped builds behind them", () => {
    const nightlyOnlyBundles = [{ tag_name: "pingdotgg-t3code--v0.0.45-nightly.20260930.2468-fh1" }];
    expect(
      resolveSupportedTrains({ hasStableTrain: true, hasNightlyTrain: true }, nightlyOnlyBundles),
    ).toEqual({ hasStableTrain: false, hasNightlyTrain: true });
    expect(
      resolveSupportedTrains({ hasStableTrain: false, hasNightlyTrain: true }, nightlyOnlyBundles),
    ).toEqual({ hasStableTrain: false, hasNightlyTrain: true });
    const declared = { hasStableTrain: true, hasNightlyTrain: true };
    expect(resolveSupportedTrains(declared, [{ tag_name: "v1.0.0" }])).toEqual(declared);
    expect(resolveSupportedTrains(declared, null)).toEqual(declared);
  });

  it("migrates the track when the publisher drops it", () => {    expect(
      resolveMigratedUpdateTrack("latest", { hasStableTrain: true, hasNightlyTrain: true }),
    ).toBe("latest");
    expect(
      resolveMigratedUpdateTrack("latest", { hasStableTrain: false, hasNightlyTrain: true }),
    ).toBe("nightly");
    expect(
      resolveMigratedUpdateTrack("nightly", { hasStableTrain: true, hasNightlyTrain: false }),
    ).toBe("latest");
    expect(
      resolveMigratedUpdateTrack("nightly", { hasStableTrain: false, hasNightlyTrain: true }),
    ).toBe("nightly");
  });
});

describe("resolveTrainsFromUpstreamManifest", () => {
  it("reads the declared trains", () => {
    expect(resolveTrainsFromUpstreamManifest({ trains: ["nightly"] })).toEqual({
      hasStableTrain: false,
      hasNightlyTrain: true,
    });
    expect(resolveTrainsFromUpstreamManifest({ trains: ["stable", "nightly"] })).toEqual({
      hasStableTrain: true,
      hasNightlyTrain: true,
    });
  });

  it("returns null without a usable trains list", () => {
    expect(resolveTrainsFromUpstreamManifest({})).toBeNull();
    expect(resolveTrainsFromUpstreamManifest({ trains: ["canary"] })).toBeNull();
    expect(resolveTrainsFromUpstreamManifest(null)).toBeNull();
  });
});

describe("resolveTrainsFromUpstreamManifest", () => {
  it("reads the declared trains", () => {
    expect(resolveTrainsFromUpstreamManifest({ trains: ["nightly"] })).toEqual({
      hasStableTrain: false,
      hasNightlyTrain: true,
    });
    expect(resolveTrainsFromUpstreamManifest({ trains: ["stable", "nightly"] })).toEqual({
      hasStableTrain: true,
      hasNightlyTrain: true,
    });
    expect(resolveTrainsFromUpstreamManifest({ trains: ["Stable"] })).toEqual({
      hasStableTrain: true,
      hasNightlyTrain: false,
    });
  });

  it("returns null without a usable trains list", () => {
    expect(resolveTrainsFromUpstreamManifest({})).toBeNull();
    expect(resolveTrainsFromUpstreamManifest({ trains: ["canary"] })).toBeNull();
    expect(resolveTrainsFromUpstreamManifest(null)).toBeNull();
  });
});
