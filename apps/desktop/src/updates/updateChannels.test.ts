import { describe, expect, it } from "vite-plus/test";

import {
  isForkHubDerivedVersion,
  isNightlyDesktopVersion,
  isVersionAllowedOnUpdateChannel,
  normalizeForkHubOwner,
  resolveDefaultDesktopUpdateChannel,
  resolveForkHubFeedConfig,
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
    expect(isVersionAllowedOnUpdateChannel("1.2.3", "latest")).toBe(true);
    expect(isVersionAllowedOnUpdateChannel("1.2.3", "forkhub")).toBe(true);
    expect(isVersionAllowedOnUpdateChannel("1.2.3-nightly.20260911.1", "latest")).toBe(false);
    // A ForkHub catalog may follow the nightly train: nightly-based builds
    // install on ForkHub, preview cuts never do (they ship without a feed).
    expect(isVersionAllowedOnUpdateChannel("1.2.3-nightly.20260911.1", "forkhub")).toBe(true);
    expect(isVersionAllowedOnUpdateChannel("0.0.41-preview.20260911.7", "forkhub")).toBe(false);
    expect(isVersionAllowedOnUpdateChannel("1.2.3-nightly.20260911.1", "nightly")).toBe(true);
    expect(isVersionAllowedOnUpdateChannel("1.2.3", "nightly")).toBe(false);
    expect(isVersionAllowedOnUpdateChannel("0.0.41-preview.20260911.7", "nightly")).toBe(false);
  });

  it("gives ForkHub builds a provenance suffix that only ForkHub installs", () => {
    expect(isForkHubDerivedVersion("0.0.43-nightly.20260924.2187.fh.imbios.1")).toBe(true);
    expect(isForkHubDerivedVersion("0.0.42.fh.imbios.2")).toBe(true);
    expect(isForkHubDerivedVersion("0.0.43-nightly.20260924.2187")).toBe(false);
    expect(isForkHubDerivedVersion("0.0.42")).toBe(false);
    expect(
      isVersionAllowedOnUpdateChannel("0.0.43-nightly.20260924.2187.fh.imbios.1", "forkhub"),
    ).toBe(true);
    expect(
      isVersionAllowedOnUpdateChannel("0.0.43-nightly.20260924.2187.fh.imbios.1", "nightly"),
    ).toBe(false);
    expect(isVersionAllowedOnUpdateChannel("0.0.42.fh.imbios.1", "latest")).toBe(false);
    expect(isVersionAllowedOnUpdateChannel("0.0.42.fh.imbios.1", "forkhub")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.43-nightly.20260924.2187.fh.imbios.1")).toBe(
      "nightly",
    );
  });
});
